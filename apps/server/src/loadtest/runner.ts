import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { now, type DB } from '../db.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import type { EventBus } from '../lib/events.ts';
import type { LoadParams } from './worker.ts';

export const LOAD_LIMITS = {
  local: { maxVus: 200, maxDurationS: 300 },
  remote: { maxVus: 25, maxDurationS: 60 },
};

export interface LoadTestRequest extends LoadParams {
  thresholds: { p95Ms: number; errorRatePct: number };
  ownershipConfirmed: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Authorisation policy: local targets are always allowed; remote targets must already be a
 * configured monitor (i.e. an admin registered it) AND the admin must confirm ownership for
 * this specific run. Remote runs get much lower caps.
 */
export function authorizeTarget(db: DB, url: URL, ownershipConfirmed: boolean): 'local' | 'remote' {
  if (LOCAL_HOSTS.has(url.hostname)) return 'local';
  const monitored = (db.prepare('SELECT url FROM monitors').all() as { url: string }[]).some((m) => {
    try {
      return new URL(m.url).origin === url.origin;
    } catch {
      return false;
    }
  });
  if (!monitored) throw badRequest('Remote load tests are limited to origins you have added as monitors. Add the site under Monitoring first, or test a local environment.');
  if (!ownershipConfirmed) throw badRequest('Confirm that you own or are authorised to load-test this target.');
  return 'remote';
}

export class LoadTestRunner {
  private active: { id: number; worker: Worker; progress: unknown } | null = null;

  private db: DB;
  private bus: EventBus;

  constructor(db: DB, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  status(): { id: number; progress: unknown } | null {
    return this.active ? { id: this.active.id, progress: this.active.progress } : null;
  }

  start(req: LoadTestRequest, startedBy: string): number {
    if (this.active) throw conflict('A load test is already running. Stop it or wait for it to finish.');
    const url = new URL(req.url);
    const scope = authorizeTarget(this.db, url, req.ownershipConfirmed);
    const limits = LOAD_LIMITS[scope];
    if (req.vus < 1 || req.vus > limits.maxVus) throw badRequest(`Virtual users must be between 1 and ${limits.maxVus} for ${scope} targets.`);
    if (req.durationS < 5 || req.durationS > limits.maxDurationS) throw badRequest(`Duration must be between 5 and ${limits.maxDurationS} seconds for ${scope} targets.`);
    if (req.rampUpS < 0 || req.rampUpS >= req.durationS) throw badRequest('Ramp-up must be shorter than the test duration.');

    const environment = {
      scope,
      runner: 'SentinelOps built-in (Node.js worker thread, closed-loop VUs)',
      host: `${os.type()} ${os.release()}`,
      cpus: `${os.cpus().length} × ${os.cpus()[0]?.model ?? 'unknown'}`,
      memoryGb: Math.round(os.totalmem() / 1e9),
      node: process.version,
      note: scope === 'local' ? 'Load generator and target share this machine; results understate the capacity of dedicated hardware.' : 'Measured from this machine over the public internet; network latency is included.',
    };
    const config = { url: req.url, method: req.method, vus: req.vus, durationS: req.durationS, rampUpS: req.rampUpS, requestTimeoutMs: req.requestTimeoutMs, abortErrorRatePct: req.abortErrorRatePct, rpsPerVu: req.rpsPerVu, thresholds: req.thresholds };
    const info = this.db.prepare("INSERT INTO load_tests (source, target, config, status, started_at, environment, notes) VALUES ('builtin', ?, ?, 'running', ?, ?, ?)").run(
      req.url, JSON.stringify(config), now(), JSON.stringify(environment), `Started by ${startedBy}`,
    );
    const id = Number(info.lastInsertRowid);

    const ext = path.extname(import.meta.filename);
    const params: LoadParams = { url: req.url, method: req.method, vus: req.vus, durationS: req.durationS, rampUpS: req.rampUpS, requestTimeoutMs: req.requestTimeoutMs, abortErrorRatePct: req.abortErrorRatePct, rpsPerVu: req.rpsPerVu };
    const worker = new Worker(new URL(`./worker${ext}`, import.meta.url), { workerData: params, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    this.active = { id, worker, progress: null };

    // Process resource usage for the SentinelOps server itself (meaningful when it is the target).
    const cpu0 = process.cpuUsage();
    const wall0 = performance.now();
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);

    this.bus.publish('loadtest.started', 'info', `Load test #${id} started: ${req.vus} VUs for ${req.durationS}s against ${url.host}`, `/load-tests/${id}`);
    worker.on('message', (m: { type: string; result?: Record<string, unknown> }) => {
      if (m.type === 'progress' && this.active) this.active.progress = m;
      if (m.type === 'done' && m.result) {
        clearInterval(sampler);
        const cpu = process.cpuUsage(cpu0);
        const wallMs = performance.now() - wall0;
        const r = m.result as { latencyMs: { p95: number }; errorRatePct: number; stoppedReason: string | null };
        const verdict = {
          p95: { threshold: req.thresholds.p95Ms, actual: r.latencyMs.p95, pass: r.latencyMs.p95 <= req.thresholds.p95Ms },
          errorRate: { threshold: req.thresholds.errorRatePct, actual: r.errorRatePct, pass: r.errorRatePct <= req.thresholds.errorRatePct },
        };
        const passed = verdict.p95.pass && verdict.errorRate.pass && !r.stoppedReason;
        const result = {
          ...m.result,
          thresholds: verdict,
          passed,
          serverProcess: { cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10, peakRssMb: Math.round(peakRss / 1e6), note: 'SentinelOps server process (main thread) — relevant only when SentinelOps itself is the target.' },
        };
        this.db.prepare('UPDATE load_tests SET status = ?, finished_at = ?, result = ? WHERE id = ?').run(r.stoppedReason ? 'stopped' : passed ? 'passed' : 'failed', now(), JSON.stringify(result), id);
        this.bus.publish('loadtest.finished', passed ? 'success' : 'warning', `Load test #${id} ${passed ? 'passed' : 'did not meet thresholds'}: p95 ${r.latencyMs.p95} ms, errors ${r.errorRatePct}%`, `/load-tests/${id}`);
        this.bus.invalidate('loadtests');
      }
    });
    worker.on('error', (err) => {
      clearInterval(sampler);
      this.db.prepare("UPDATE load_tests SET status = 'error', finished_at = ?, notes = ? WHERE id = ?").run(now(), err.message.slice(0, 300), id);
      this.bus.publish('loadtest.error', 'critical', `Load test #${id} crashed: ${err.message.slice(0, 160)}`, `/load-tests/${id}`);
    });
    worker.on('exit', () => {
      clearInterval(sampler);
      this.active = null;
    });
    return id;
  }

  stop(): void {
    this.active?.worker.postMessage({ type: 'stop' });
  }

  /** Imports a k6 `--summary-export` JSON file as an externally measured result. */
  importK6(summary: unknown, target: string, notes: string): number {
    const s = summary as { metrics?: Record<string, Record<string, number> & { values?: Record<string, number> }> };
    const metric = (name: string) => {
      const m = s.metrics?.[name];
      return (m?.values ?? m) as Record<string, number> | undefined;
    };
    const dur = metric('http_req_duration');
    const reqs = metric('http_reqs');
    const failedRate = metric('http_req_failed');
    if (!dur || !reqs) throw badRequest('This does not look like a k6 summary export (missing http_req_duration / http_reqs).');
    const total = reqs.count ?? 0;
    const errorRatePct = Math.round(((failedRate?.rate ?? failedRate?.value ?? 0) as number) * 10000) / 100;
    const result = {
      totalRequests: total,
      failedRequests: Math.round((total * errorRatePct) / 100),
      successfulRequests: total - Math.round((total * errorRatePct) / 100),
      errorRatePct,
      rps: Math.round((reqs.rate ?? 0) * 10) / 10,
      latencyMs: { min: Math.round(dur.min ?? 0), avg: Math.round(dur.avg ?? 0), p50: Math.round(dur.med ?? 0), p90: Math.round(dur['p(90)'] ?? 0), p95: Math.round(dur['p(95)'] ?? 0), p99: Math.round(dur['p(99)'] ?? 0), max: Math.round(dur.max ?? 0) },
      vusMax: metric('vus_max')?.max ?? metric('vus_max')?.value ?? null,
      imported: true,
    };
    const info = this.db.prepare("INSERT INTO load_tests (source, target, config, status, started_at, finished_at, result, environment, notes) VALUES ('k6-import', ?, '{}', 'imported', ?, ?, ?, ?, ?)").run(
      target, now(), now(), JSON.stringify(result), JSON.stringify({ runner: 'k6 (imported summary)' }), notes.slice(0, 500),
    );
    this.bus.publish('loadtest.imported', 'info', `Imported k6 results for ${target}`, `/load-tests/${Number(info.lastInsertRowid)}`);
    return Number(info.lastInsertRowid);
  }
}
