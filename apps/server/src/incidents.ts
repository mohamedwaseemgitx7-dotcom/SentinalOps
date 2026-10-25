import { now, parseJson, type DB } from './db.ts';
import type { EventBus } from './lib/events.ts';
import type { Notifier } from './notifications.ts';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentSource = 'monitor' | 'pipeline' | 'security' | 'manual';

export interface IncidentNote {
  ts: string;
  author: string;
  text: string;
}

export class IncidentService {
  private db: DB;
  private bus: EventBus;
  private notifier: Notifier | null = null;

  constructor(db: DB, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  /** Incident changes are fanned out to notification channels (set once at startup). */
  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  private notify(id: number, event: 'incident.opened' | 'incident.resolved'): void {
    if (!this.notifier) return;
    const i = this.db.prepare('SELECT id, title, severity, source, status, started_at, resolved_at, resolution FROM incidents WHERE id = ?').get(id) as
      | { id: number; title: string; severity: string; source: string; status: string; started_at: string; resolved_at: string | null; resolution: string | null }
      | undefined;
    if (!i) return;
    const verb = event === 'incident.opened' ? `🔴 [${i.severity.toUpperCase()}] Incident #${i.id} opened` : `✅ Incident #${i.id} resolved`;
    this.notifier.enqueue(event, {
      incident: { id: i.id, title: i.title, severity: i.severity, source: i.source, status: i.status, startedAt: i.started_at, resolvedAt: i.resolved_at, resolution: i.resolution },
      summary: `${verb}: ${i.title}${event === 'incident.resolved' && i.resolution ? ` — ${i.resolution}` : ''}`,
    });
  }

  /** Opens an incident unless one with the same (source, ref) is already active. Returns its id. */
  open(input: {
    source: IncidentSource;
    ref: string;
    title: string;
    severity: IncidentSeverity;
    startedAt?: string;
    repoId?: number | null;
    monitorId?: number | null;
  }): { id: number; created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM incidents WHERE source = ? AND ref = ? AND status != 'resolved'")
      .get(input.source, input.ref) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO incidents (source, ref, repo_id, monitor_id, title, severity, status, started_at, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(input.source, input.ref, input.repoId ?? null, input.monitorId ?? null, input.title, input.severity, input.startedAt ?? ts, ts);
    const id = Number(info.lastInsertRowid);
    this.bus.publish('incident.opened', input.severity === 'critical' || input.severity === 'high' ? 'critical' : 'warning', `Incident #${id} opened: ${input.title}`, `/incidents/${id}`);
    this.bus.invalidate('incidents');
    this.notify(id, 'incident.opened');
    return { id, created: true };
  }

  /** Resolves the active incident for (source, ref), if any. */
  resolveByRef(source: IncidentSource, ref: string, resolution: string): number | null {
    const row = this.db.prepare("SELECT id, title FROM incidents WHERE source = ? AND ref = ? AND status != 'resolved'").get(source, ref) as
      | { id: number; title: string }
      | undefined;
    if (!row) return null;
    this.resolve(row.id, resolution, 'system');
    return row.id;
  }

  resolve(id: number, resolution: string, author: string): void {
    const ts = now();
    const changed = this.db.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ? AND status != 'resolved'").run(ts, resolution, id).changes;
    this.addNote(id, author, `Resolved: ${resolution}`);
    if (changed) this.notify(id, 'incident.resolved');
    this.bus.publish('incident.resolved', 'success', `Incident #${id} resolved — ${resolution}`, `/incidents/${id}`);
    this.bus.invalidate('incidents');
  }

  acknowledge(id: number, author: string): void {
    const res = this.db.prepare("UPDATE incidents SET status = 'acknowledged', acknowledged_at = ? WHERE id = ? AND status = 'open'").run(now(), id);
    if (res.changes) {
      this.addNote(id, author, 'Acknowledged');
      this.bus.publish('incident.acknowledged', 'info', `Incident #${id} acknowledged by ${author}`, `/incidents/${id}`);
      this.bus.invalidate('incidents');
    }
  }

  addNote(id: number, author: string, text: string): void {
    const row = this.db.prepare('SELECT notes FROM incidents WHERE id = ?').get(id) as { notes: string } | undefined;
    if (!row) return;
    const notes = parseJson<IncidentNote[]>(row.notes, []);
    notes.push({ ts: now(), author, text: text.slice(0, 2000) });
    this.db.prepare('UPDATE incidents SET notes = ? WHERE id = ?').run(JSON.stringify(notes.slice(-200)), id);
  }
}
