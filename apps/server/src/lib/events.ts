import { EventEmitter } from 'node:events';
import { now, type DB } from '../db.ts';

export type EventLevel = 'info' | 'success' | 'warning' | 'critical';

export interface ActivityEvent {
  id: number;
  ts: string;
  type: string;
  level: EventLevel;
  message: string;
  link: string | null;
}

/**
 * Persists activity events and fans them out to live SSE subscribers.
 * Only short, non-sensitive messages belong here — never log contents or secrets.
 */
export class EventBus {
  private emitter = new EventEmitter();

  private db: DB;

  constructor(db: DB) {
    this.db = db;
    this.emitter.setMaxListeners(0);
  }

  publish(type: string, level: EventLevel, message: string, link: string | null = null): ActivityEvent {
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO events (ts, type, level, message, link) VALUES (?, ?, ?, ?, ?)')
      .run(ts, type, level, message.slice(0, 500), link);
    const event: ActivityEvent = { id: Number(info.lastInsertRowid), ts, type, level, message, link };
    this.emitter.emit('event', event);
    return event;
  }

  /** Signals that cached aggregates (overview, health) changed; carries no data. */
  invalidate(topic: string): void {
    this.emitter.emit('invalidate', topic);
  }

  subscribe(onEvent: (e: ActivityEvent) => void, onInvalidate: (topic: string) => void): () => void {
    this.emitter.on('event', onEvent);
    this.emitter.on('invalidate', onInvalidate);
    return () => {
      this.emitter.off('event', onEvent);
      this.emitter.off('invalidate', onInvalidate);
    };
  }

  recent(limit = 30): ActivityEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as ActivityEvent[];
  }
}

export function audit(
  db: DB,
  entry: { userId?: number | null; username?: string | null; action: string; target?: string | null; detail?: string | null; ip?: string | null },
): void {
  db.prepare('INSERT INTO audit_log (ts, user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    now(),
    entry.userId ?? null,
    entry.username ?? null,
    entry.action,
    entry.target ?? null,
    entry.detail?.slice(0, 1000) ?? null,
    entry.ip ?? null,
  );
}
