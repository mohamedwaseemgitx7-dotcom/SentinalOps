import { parentPort, workerData } from 'node:worker_threads';

export interface LoadParams {
  url: string;
  method: 'GET' | 'HEAD';
  vus: number;
  durationS: number;
  rampUpS: number;
  requestTimeoutMs: number;
  /** Abort early when the error rate exceeds this % after at least 100 requests. */
  abortErrorRatePct: number;
  /** Optional per-VU request cap per second (0 = unbounded / closed loop). */
  rpsPerVu: number;
  headers?: Record<string, string>;
}

interface Sample {
  t: number;
  ms: number;
  status: number;
}

const p = workerData as LoadParams;
const samples: Sample[] = [];
const errors = new Map<string, number>();
const t0 = performance.now();
const endAt = t0 + p.durationS * 1000;
let stopped: string | null = null;
let failed = 0;

parentPort!.on('message', (m: { type: string }) => {
  if (m.type === 'stop') stopped = 'Stopped by user';
});

async function vu(index: number): Promise<void> {
  const delay = p.vus > 1 ? (p.rampUpS * 1000 * index) / (p.vus - 1) : 0;
  await new Promise((r) => setTimeout(r, delay));
  const minGap = p.rpsPerVu > 0 ? 1000 / p.rpsPerVu : 0;
  while (!stopped && performance.now() < endAt) {
    const start = performance.now();
    let status = 0;
    try {
      const res = await fetch(p.url, { method: p.method, headers: { 'User-Agent': 'SentinelOps-LoadTest/0.1', ...p.headers }, signal: AbortSignal.timeout(p.requestTimeoutMs) });
      await res.arrayBuffer();
      status = res.status;
      if (status >= 400) {
        failed++;
        errors.set(`HTTP ${status}`, (errors.get(`HTTP ${status}`) ?? 0) + 1);
      }
    } catch (err) {
      failed++;
      const e = err as Error & { cause?: { code?: string } };
      const key = e.name === 'TimeoutError' ? 'Timeout' : e.cause?.code ?? e.name;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
    const ms = performance.now() - start;
    samples.push({ t: start - t0, ms, status });
    if (samples.length >= 100 && (failed / samples.length) * 100 > p.abortErrorRatePct) stopped = `Aborted: error rate exceeded ${p.abortErrorRatePct}%`;
    if (minGap > ms) await new Promise((r) => setTimeout(r, minGap - ms));
  }
}

const progress = setInterval(() => {
  const elapsed = (performance.now() - t0) / 1000;
  const recent = samples.filter((s) => s.t >= (elapsed - 1) * 1000);
  parentPort!.postMessage({ type: 'progress', elapsedS: Math.round(elapsed), requests: samples.length, failed, rps: recent.length });
}, 1000);

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)]!;
}

await Promise.all(Array.from({ length: p.vus }, (_, i) => vu(i)));
clearInterval(progress);

const durationS = (performance.now() - t0) / 1000;
const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
const okLat = samples.filter((s) => s.status > 0 && s.status < 400).map((s) => s.ms).sort((a, b) => a - b);
const buckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];
const histogram = buckets.map((le, i) => ({ le: le === Infinity ? null : le, count: lat.filter((v) => v <= le && (i === 0 || v > buckets[i - 1]!)).length }));
const statusCodes: Record<string, number> = {};
for (const s of samples) statusCodes[s.status ? String(s.status) : 'error'] = (statusCodes[String(s.status || 'error')] ?? 0) + 1;
const seconds = Math.ceil(durationS);
const timeline = Array.from({ length: seconds }, (_, sec) => {
  const inSec = samples.filter((s) => s.t >= sec * 1000 && s.t < (sec + 1) * 1000);
  const l = inSec.map((s) => s.ms).sort((a, b) => a - b);
  return { second: sec + 1, requests: inSec.length, errors: inSec.filter((s) => s.status === 0 || s.status >= 400).length, p95: Math.round(pct(l, 95)) };
});

parentPort!.postMessage({
  type: 'done',
  result: {
    stoppedReason: stopped,
    durationS: Math.round(durationS * 10) / 10,
    totalRequests: samples.length,
    successfulRequests: samples.length - failed,
    failedRequests: failed,
    errorRatePct: samples.length ? Math.round((failed / samples.length) * 10000) / 100 : 0,
    rps: Math.round((samples.length / durationS) * 10) / 10,
    latencyMs: {
      min: Math.round(lat[0] ?? 0), avg: Math.round(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)),
      p50: Math.round(pct(lat, 50)), p90: Math.round(pct(lat, 90)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(lat.at(-1) ?? 0),
    },
    successLatencyP95Ms: Math.round(pct(okLat, 95)),
    histogram,
    statusCodes,
    errors: Object.fromEntries(errors),
    timeline,
  },
});
