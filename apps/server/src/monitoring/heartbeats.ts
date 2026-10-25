import { now, type DB } from '../db.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import type { EventBus } from '../lib/events.ts';
import type { IncidentService } from '../incidents.ts';

/**
 * Heartbeat (push) monitors for cron jobs, backups and workers: the job calls
 * `/ping/<token>` when it succeeds; if no ping arrives within timeout + grace, an incident opens.
 * Model learned from Healthchecks (BSD-3) and Uptime Kuma push monitors; no code copied.
 *
 * Status: new → up (first ping) → [grace, computed] → down. `/start` measures run duration
 * and, if the run never finishes, goes down after `grace` from the start.
 * The token is shown once; only its SHA-256 is stored.
 */

export type HeartbeatStatus = 'new' | 'up' | 'down' | 'paused';
export type PingKind = 'success' | 'start' | 'fail' | 'exit';

export interface HeartbeatRow {
  id: number;
  name: string;
  token_prefix: string;
  timeout_s: number;
  grace_s: number;
  status: HeartbeatStatus;
  last_ping_at: string | null;
  last_start_at: string | null;
  last_duration_ms: number | null;
  last_event: string | null;
  alert_after: string | null;
  n_pings: number;
  created_at: string;
}

export const HEARTBEAT_LIMITS = { minTimeoutS: 60, maxTimeoutS: 30 * 86_400, minGraceS: 60, maxGraceS: 7 * 86_400, maxHeartbeats: 100, bodyBytes: 10_000, pingRetention: 200 };

const iso = (ms: number) => new Date(ms).toISOString();

/** When the heartbeat becomes overdue (grace starts) and when it goes down. */
export function deadlines(h: Pick<HeartbeatRow, 'last_ping_at' | 'last_start_at' | 'timeout_s' | 'grace_s'>): { graceStart: number; downAt: number } | null {
  if (h.last_start_at && (!h.last_ping_at || h.last_start_at > h.last_ping_at)) {
    const start = Date.parse(h.last_start_at);
    return { graceStart: start, downAt: start + h.grace_s * 1000 };
  }
  if (!h.last_ping_at) return null;
  const graceStart = Date.parse(h.last_ping_at) + h.timeout_s * 1000;
  return { graceStart, downAt: graceStart + h.grace_s * 1000 };
}

/** Display status including the computed "grace" state. */
export function displayStatus(h: HeartbeatRow, nowMs = Date.now()): HeartbeatStatus | 'grace' {
  if (h.status !== 'up') return h.status;
  const d = deadlines(h);
  if (!d) return 'up';
  if (nowMs >= d.downAt) return 'down';
  if (nowMs >= d.graceStart) return 'grace';
  return 'up';
}

export class HeartbeatService {
  private db: DB;
  private bus: EventBus;
  private incidents: IncidentService;

  constructor(db: DB, bus: EventBus, incidents: IncidentService) {
    this.db = db;
    this.bus = bus;
    this.incidents = incidents;
  }

  create(input: { name: string; timeoutS: number; graceS: number }): { id: number; token: string } {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM heartbeats').get() as { n: number }).n;
    if (count >= HEARTBEAT_LIMITS.maxHeartbeats) throw new Error(`Heartbeat limit (${HEARTBEAT_LIMITS.maxHeartbeats}) reached.`);
    const token = randomToken(24);
    const info = this.db
      .prepare("INSERT INTO heartbeats (name, token_hash, token_prefix, timeout_s, grace_s, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)")
      .run(input.name, sha256(token), token.slice(0, 6), input.timeoutS, input.graceS, now());
    return { id: Number(info.lastInsertRowid), token };
  }

  rotateToken(id: number): string {
    const token = randomToken(24);
    this.db.prepare('UPDATE heartbeats SET token_hash = ?, token_prefix = ? WHERE id = ?').run(sha256(token), token.slice(0, 6), id);
    return token;
  }

  get(id: number): HeartbeatRow | null {
    return (this.db.prepare('SELECT id, name, token_prefix, timeout_s, grace_s, status, last_ping_at, last_start_at, last_duration_ms, last_event, alert_after, n_pings, created_at FROM heartbeats WHERE id = ?').get(id) as unknown as HeartbeatRow) ?? null;
  }

  list(): (HeartbeatRow & { display_status: string; down_at: string | null })[] {
    const rows = this.db.prepare('SELECT id, name, token_prefix, timeout_s, grace_s, status, last_ping_at, last_start_at, last_duration_ms, last_event, alert_after, n_pings, created_at FROM heartbeats ORDER BY name').all() as unknown as HeartbeatRow[];
    return rows.map((h) => {
      const d = deadlines(h);
      return { ...h, display_status: displayStatus(h), down_at: d ? iso(d.downAt) : null };
    });
  }

  update(id: number, input: { name: string; timeoutS: number; graceS: number; paused: boolean }): void {
    const h = this.get(id);
    if (!h) return;
    const status: HeartbeatStatus = input.paused ? 'paused' : h.status === 'paused' ? (h.last_ping_at ? 'up' : 'new') : h.status;
    this.db.prepare('UPDATE heartbeats SET name = ?, timeout_s = ?, grace_s = ?, status = ? WHERE id = ?').run(input.name, input.timeoutS, input.graceS, status, id);
    this.recomputeAlertAfter(id);
    if (input.paused) this.incidents.resolveByRef('monitor', `heartbeat:${id}`, 'Heartbeat paused');
  }

  delete(id: number): void {
    this.incidents.resolveByRef('monitor', `heartbeat:${id}`, 'Heartbeat deleted');
    this.db.prepare('DELETE FROM heartbeats WHERE id = ?').run(id);
  }

  private recomputeAlertAfter(id: number): void {
    const h = this.get(id);
    if (!h) return;
    const d = h.status === 'up' ? deadlines(h) : null;
    this.db.prepare('UPDATE heartbeats SET alert_after = ? WHERE id = ?').run(d ? iso(d.downAt) : null, id);
  }

  /** Handles a public ping. Returns false for an unknown token (→ 404). */
  ping(token: string, kind: PingKind, meta: { exitCode?: number; body?: string; ip?: string }): boolean {
    const h = this.db.prepare('SELECT * FROM heartbeats WHERE token_hash = ?').get(sha256(token)) as unknown as (HeartbeatRow & { token_hash: string }) | undefined;
    if (!h) return false;
    const ts = now();
    const failed = kind === 'fail' || (kind === 'exit' && meta.exitCode !== 0);
    let durationMs: number | null = null;
    if (kind !== 'start' && h.last_start_at && (!h.last_ping_at || h.last_start_at > h.last_ping_at)) {
      durationMs = Date.parse(ts) - Date.parse(h.last_start_at);
    }
    this.db
      .prepare('INSERT INTO heartbeat_pings (heartbeat_id, ts, kind, exit_code, duration_ms, body, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(h.id, ts, kind, meta.exitCode ?? null, durationMs, meta.body ? meta.body.slice(0, HEARTBEAT_LIMITS.bodyBytes) : null, meta.ip ?? null);
    this.db.prepare('DELETE FROM heartbeat_pings WHERE heartbeat_id = ? AND id NOT IN (SELECT id FROM heartbeat_pings WHERE heartbeat_id = ? ORDER BY id DESC LIMIT ?)').run(h.id, h.id, HEARTBEAT_LIMITS.pingRetention);

    if (h.status === 'paused') {
      this.db.prepare('UPDATE heartbeats SET n_pings = n_pings + 1, last_event = ? WHERE id = ?').run(kind, h.id);
      return true;
    }
    if (kind === 'start') {
      this.db.prepare("UPDATE heartbeats SET last_start_at = ?, n_pings = n_pings + 1, last_event = 'start', status = CASE WHEN status = 'new' THEN 'up' ELSE status END WHERE id = ?").run(ts, h.id);
      this.recomputeAlertAfter(h.id);
      return true;
    }
    const ref = `heartbeat:${h.id}`;
    if (failed) {
      this.db.prepare("UPDATE heartbeats SET status = 'down', last_ping_at = ?, last_duration_ms = ?, n_pings = n_pings + 1, last_event = ?, alert_after = NULL WHERE id = ?").run(ts, durationMs, kind === 'exit' ? `exit ${meta.exitCode}` : 'fail', h.id);
      this.incidents.open({ source: 'monitor', ref, title: `Heartbeat "${h.name}" reported a failure${kind === 'exit' ? ` (exit code ${meta.exitCode})` : ''}`, severity: 'high' });
      this.bus.publish('heartbeat.failed', 'critical', `Heartbeat "${h.name}" reported a failure`, '/monitoring');
    } else {
      this.db.prepare("UPDATE heartbeats SET status = 'up', last_ping_at = ?, last_duration_ms = COALESCE(?, last_duration_ms), n_pings = n_pings + 1, last_event = 'success' WHERE id = ?").run(ts, durationMs, h.id);
      this.recomputeAlertAfter(h.id);
      if (h.status === 'down') {
        const resolved = this.incidents.resolveByRef('monitor', ref, 'Heartbeat received a success ping');
        if (!resolved) this.bus.publish('heartbeat.recovered', 'success', `Heartbeat "${h.name}" is up again`, '/monitoring');
      }
    }
    this.bus.invalidate('monitors');
    return true;
  }

  /** Called from the scheduler tick: marks overdue heartbeats down exactly once. */
  sweep(nowMs = Date.now()): number {
    const due = this.db.prepare("SELECT * FROM heartbeats WHERE status = 'up' AND alert_after IS NOT NULL AND alert_after <= ?").all(iso(nowMs)) as unknown as HeartbeatRow[];
    let downs = 0;
    for (const h of due) {
      const d = deadlines(h);
      if (!d || nowMs < d.downAt) {
        this.recomputeAlertAfter(h.id);
        continue;
      }
      // Conditional update: only the first sweep to see this transition opens the incident.
      const changed = this.db.prepare("UPDATE heartbeats SET status = 'down', alert_after = NULL WHERE id = ? AND status = 'up'").run(h.id).changes;
      if (!changed) continue;
      downs++;
      const overdue = h.last_start_at && (!h.last_ping_at || h.last_start_at > h.last_ping_at) ? 'a started run did not finish' : 'no ping received';
      this.incidents.open({ source: 'monitor', ref: `heartbeat:${h.id}`, title: `Heartbeat "${h.name}" is down — ${overdue}`, severity: 'high', startedAt: iso(d.downAt) });
      this.bus.publish('heartbeat.down', 'critical', `Heartbeat "${h.name}" is down — ${overdue}`, '/monitoring');
    }
    if (downs) this.bus.invalidate('monitors');
    return downs;
  }

  recentPings(id: number, limit = 50) {
    return this.db.prepare('SELECT ts, kind, exit_code, duration_ms, ip FROM heartbeat_pings WHERE heartbeat_id = ? ORDER BY id DESC LIMIT ?').all(id, limit);
  }
}
