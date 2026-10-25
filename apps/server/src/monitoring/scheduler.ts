import { now, type DB } from '../db.ts';
import type { EventBus } from '../lib/events.ts';
import type { IncidentService } from '../incidents.ts';
import type { Notifier } from '../notifications.ts';
import { evaluateConditions, needsBody, type ConditionResult } from './conditions.ts';
import type { HeartbeatService } from './heartbeats.ts';
import { probe, tlsInfo, type ProbeResult } from './probe.ts';

export interface MonitorRow {
  id: number;
  name: string;
  url: string;
  method: string;
  interval_s: number;
  timeout_ms: number;
  expected_status: string;
  retries: number;
  failure_threshold: number;
  latency_threshold_ms: number;
  enabled: number;
  created_at: string;
  last_checked_at: string | null;
  last_ok: number | null;
  consecutive_failures: number;
  tls_valid_to: string | null;
  /** JSON array of assertion strings, see conditions.ts. */
  conditions: string;
  success_threshold: number;
  consecutive_successes: number;
}

export const MONITOR_LIMITS = {
  minIntervalS: 60,
  maxIntervalS: 86_400,
  maxTimeoutMs: 30_000,
  maxRetries: 3,
  maxMonitors: 200,
  concurrency: 4,
  retentionDays: 90,
};

/**
 * Lightweight in-process scheduler: one timer, bounded concurrency, no overlapping checks
 * for the same monitor, and a 60s minimum interval to avoid operational impact on targets.
 */
export class MonitorScheduler {
  private timer: NodeJS.Timeout | null = null;
  // Keyed by id + created_at: SQLite can reuse the id of a deleted monitor.
  private inFlight = new Set<string>();
  private lastPurge = 0;
  private tlsCheckedAt = new Map<number, number>();

  private db: DB;
  private bus: EventBus;
  private incidents: IncidentService;
  private heartbeats: HeartbeatService | null = null;
  private notifier: Notifier | null = null;

  constructor(db: DB, bus: EventBus, incidents: IncidentService) {
    this.db = db;
    this.bus = bus;
    this.incidents = incidents;
  }

  /** Heartbeat sweeps and notification delivery share the scheduler's single timer. */
  attach(heartbeats: HeartbeatService, notifier: Notifier): void {
    this.heartbeats = heartbeats;
    this.notifier = notifier;
  }

  start(tickMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    this.heartbeats?.sweep();
    void this.notifier?.drain();
    const due = (this.db.prepare('SELECT * FROM monitors WHERE enabled = 1').all() as unknown as MonitorRow[]).filter(
      (m) => !this.inFlight.has(identity(m)) && (!m.last_checked_at || Date.parse(m.last_checked_at) + m.interval_s * 1000 <= Date.now()),
    );
    const slots = Math.max(0, MONITOR_LIMITS.concurrency - this.inFlight.size);
    await Promise.all(due.slice(0, slots).map((m) => this.check(m, false).catch(() => {})));
    if (Date.now() - this.lastPurge > 6 * 3_600_000) {
      this.lastPurge = Date.now();
      const cutoff = new Date(Date.now() - MONITOR_LIMITS.retentionDays * 86_400_000).toISOString();
      this.db.prepare('DELETE FROM checks WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    }
  }

  async check(m: MonitorRow, manual: boolean): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null }> {
    const key = identity(m);
    if (this.inFlight.has(key)) throw new Error('A check for this monitor is already running.');
    this.inFlight.add(key);
    try {
      let conditions: string[] = [];
      try {
        conditions = JSON.parse(m.conditions ?? '[]') as string[];
      } catch {
        /* validated on save; treat corrupt data as no conditions */
      }
      let attempts = 0;
      let res = await this.probeOnce(m, conditions);
      attempts++;
      while (!res.ok && attempts <= m.retries) {
        await new Promise((r) => setTimeout(r, 2000 * attempts));
        res = await this.probeOnce(m, conditions);
        attempts++;
      }
      // The monitor may have been edited, deleted or replaced while the probe ran: re-read before writing.
      const current = this.db.prepare('SELECT created_at, consecutive_failures, consecutive_successes, last_ok FROM monitors WHERE id = ?').get(m.id) as
        | { created_at: string; consecutive_failures: number; consecutive_successes: number; last_ok: number | null }
        | undefined;
      if (!current || current.created_at !== m.created_at) return { ok: res.ok, statusCode: res.statusCode, latencyMs: res.latencyMs, error: res.error };
      const ts = now();
      this.db
        .prepare('INSERT INTO checks (monitor_id, ts, ok, status_code, latency_ms, dns_ms, error, attempts, manual, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, ts, res.ok ? 1 : 0, res.statusCode, res.latencyMs, res.dnsMs, res.error, attempts, manual ? 1 : 0, res.conditionResults.length ? JSON.stringify(res.conditionResults) : null);
      const failures = res.ok ? 0 : current.consecutive_failures + 1;
      const successes = res.ok ? current.consecutive_successes + 1 : 0;
      this.db.prepare('UPDATE monitors SET last_checked_at = ?, last_ok = ?, consecutive_failures = ?, consecutive_successes = ? WHERE id = ?').run(ts, res.ok ? 1 : 0, failures, successes, m.id);

      const ref = `monitor:${m.id}`;
      const openIncident = this.db.prepare("SELECT 1 FROM incidents WHERE source = 'monitor' AND ref = ? AND status != 'resolved'").get(ref);
      if (!res.ok && failures >= m.failure_threshold) {
        // Incident start = timestamp of the first failed check in this streak.
        const first = this.db.prepare('SELECT ts FROM checks WHERE monitor_id = ? AND ok = 0 ORDER BY id DESC LIMIT 1 OFFSET ?').get(m.id, failures - 1) as { ts: string } | undefined;
        const opened = this.incidents.open({ source: 'monitor', ref, title: `${m.name} is down — ${res.error ?? 'check failed'}`, severity: 'critical', monitorId: m.id, startedAt: first?.ts ?? ts });
        if (opened.created) this.incidents.addNote(opened.id, 'system', `Observed: ${res.error ?? `HTTP ${res.statusCode}`} after ${attempts} attempt(s). Root cause is not observable from outside the service.`);
      } else if (res.ok && openIncident) {
        // Hysteresis: resolve only after `success_threshold` consecutive successes, to avoid flapping.
        if (successes >= Math.max(1, m.success_threshold)) {
          this.incidents.resolveByRef('monitor', ref, `Recovered — ${successes} consecutive successful check(s), last HTTP ${res.statusCode} in ${res.latencyMs} ms`);
        }
      } else if (res.ok && current.last_ok === 0) {
        this.bus.publish('monitor.recovered', 'success', `${m.name} recovered (HTTP ${res.statusCode})`, `/monitoring/${m.id}`);
      } else if (!res.ok && failures === 1) {
        this.bus.publish('monitor.failed', 'warning', `${m.name} check failed: ${res.error}`, `/monitoring/${m.id}`);
      }
      if (manual) this.bus.publish('monitor.checked', res.ok ? 'success' : 'warning', `Manual check of ${m.name}: ${res.ok ? `HTTP ${res.statusCode} in ${res.latencyMs} ms` : res.error}`, `/monitoring/${m.id}`);

      // TLS expiry at most daily per monitor.
      if (m.url.startsWith('https:') && (!m.tls_valid_to || manual || Date.now() - (this.tlsCheckedAt.get(m.id) ?? 0) > 86_400_000)) {
        this.tlsCheckedAt.set(m.id, Date.now());
        try {
          const info = await tlsInfo(new URL(m.url).hostname, Number(new URL(m.url).port) || 443);
          this.db.prepare('UPDATE monitors SET tls_valid_to = ? WHERE id = ?').run(info.validTo, m.id);
          if (info.daysLeft < 14) this.bus.publish('monitor.tls_expiring', info.daysLeft < 0 ? 'critical' : 'warning', `TLS certificate for ${m.name} expires in ${info.daysLeft} day(s)`, `/monitoring/${m.id}`);
        } catch {
          /* recorded as part of normal check failures */
        }
      }
      this.bus.invalidate('monitors');
      return { ok: res.ok, statusCode: res.statusCode, latencyMs: res.latencyMs, error: res.error };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** One probe plus response assertions. A failing assertion fails the check with its reason. */
  private async probeOnce(m: MonitorRow, conditions: string[]): Promise<ProbeResult & { conditionResults: ConditionResult[] }> {
    const wantBody = needsBody(conditions);
    const res = await probe(m.url, { method: m.method, timeoutMs: m.timeout_ms, expected: m.expected_status, keepBody: wantBody, maxBody: wantBody ? 1024 * 1024 : undefined });
    if (!conditions.length || res.statusCode === null) return { ...res, conditionResults: [] };
    const { success, results } = evaluateConditions(conditions, {
      status: res.statusCode,
      responseTimeMs: res.latencyMs,
      body: res.body,
      headers: res.headers,
      certExpiryMs: m.tls_valid_to ? Date.parse(m.tls_valid_to) - Date.now() : null,
    });
    if (res.ok && !success) {
      const failed = results.find((r) => !r.success)!;
      return { ...res, ok: false, error: `Assertion failed: ${failed.display}${failed.error ? ` — ${failed.error}` : ''}`.slice(0, 300), conditionResults: results };
    }
    return { ...res, conditionResults: results };
  }
}

function identity(m: Pick<MonitorRow, 'id' | 'created_at'>): string {
  return `${m.id}:${m.created_at}`;
}
