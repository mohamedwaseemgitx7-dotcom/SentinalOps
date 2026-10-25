import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { now, type DB } from './db.ts';
import { HttpError } from './lib/errors.ts';
import type { EventBus } from './lib/events.ts';
import { maskUrl, type SecretBox } from './lib/secretbox.ts';

export type NotificationEvent = 'incident.opened' | 'incident.resolved' | 'test';

export interface NotificationPayload {
  event: NotificationEvent;
  incident?: { id: number; title: string; severity: string; source: string; status: string; startedAt: string; resolvedAt?: string | null; resolution?: string | null };
  sentAt: string;
  app: 'SentinelOps';
  /** Plain-text summary; also sent as `text` and `content` for Slack/Discord/ntfy compatibility. */
  summary: string;
}

interface WebhookConfig {
  url: string;
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

// Addresses a webhook must not reach unless the channel explicitly allows private targets.
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(addr, prefix, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
  return BLOCKED.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

export function validateWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Enter a full webhook URL including https://', 'bad_request');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Webhook URLs must use http or https.', 'bad_request');
  if (url.username || url.password) throw new HttpError(400, 'Put credentials in the URL path or query, not user:password@.', 'bad_request');
  return url;
}

/**
 * Resolves the host once, rejects private targets (unless allowed), then connects to exactly
 * that address — so DNS rebinding cannot swap in an internal IP. Redirects are not followed.
 */
export async function deliverWebhook(rawUrl: string, payload: NotificationPayload, allowPrivate: boolean): Promise<{ status: number }> {
  const url = validateWebhookUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const resolved = net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await dns.lookup(host, { all: true });
  if (!resolved.length) throw new Error(`Could not resolve ${host}`);
  if (!allowPrivate) {
    const bad = resolved.find((r) => isPrivateAddress(r.address));
    if (bad) throw new Error(`Blocked: ${host} resolves to a private/internal address. Enable "allow private network" for this channel if that is intended.`);
  }
  const target = resolved[0]!;
  const body = JSON.stringify({ ...payload, text: payload.summary, content: payload.summary });
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'SentinelOps-Webhook/0.2' },
        timeout: TIMEOUT_MS,
        // Pin the connection to the address that passed validation.
        lookup: (_hostname, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        res.resume(); // never read or echo response bodies
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve({ status });
        else reject(new Error(`Webhook returned HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}`));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Webhook timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export class Notifier {
  private db: DB;
  private box: SecretBox;
  private bus: EventBus;
  private current: Promise<void> | null = null;

  constructor(db: DB, box: SecretBox, bus: EventBus) {
    this.db = db;
    this.box = box;
    this.bus = bus;
  }

  createChannel(input: { name: string; url: string; allowPrivate: boolean }): number {
    validateWebhookUrl(input.url);
    const info = this.db
      .prepare("INSERT INTO channels (name, type, config_enc, target_hint, allow_private, created_at) VALUES (?, 'webhook', ?, ?, ?, ?)")
      .run(input.name, this.box.seal(JSON.stringify({ url: input.url } satisfies WebhookConfig)), maskUrl(input.url), input.allowPrivate ? 1 : 0, now());
    return Number(info.lastInsertRowid);
  }

  listChannels() {
    // config_enc is never returned to clients.
    return this.db.prepare('SELECT id, name, type, target_hint, allow_private, enabled, created_at, last_sent_at, last_error FROM channels ORDER BY id').all();
  }

  /** Outbox: one row per enabled channel, written synchronously with the incident change. */
  enqueue(event: NotificationEvent, payload: Omit<NotificationPayload, 'event' | 'sentAt' | 'app'>, channelId?: number): number {
    const full: NotificationPayload = { ...payload, event, sentAt: now(), app: 'SentinelOps' };
    const channels = channelId
      ? (this.db.prepare('SELECT id FROM channels WHERE id = ?').all(channelId) as { id: number }[])
      : (this.db.prepare('SELECT id FROM channels WHERE enabled = 1').all() as { id: number }[]);
    const insert = this.db.prepare("INSERT INTO notifications (channel_id, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)");
    for (const c of channels) insert.run(c.id, event, JSON.stringify(full), now(), now());
    if (channels.length) void this.drain();
    return channels.length;
  }

  /**
   * Sends due notifications; failures retry with backoff (30 s, 2 min) up to 3 attempts.
   * Concurrent callers share the in-flight run, so `await drain()` always means "delivered or failed".
   */
  drain(): Promise<void> {
    if (this.current) return this.current.then(() => this.drainOnce());
    return this.drainOnce();
  }

  private drainOnce(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.run().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** Waits for any in-flight delivery (used on shutdown). */
  async idle(): Promise<void> {
    await this.current;
  }

  private async run(): Promise<void> {
    const due = this.db
      .prepare(`SELECT n.id, n.channel_id, n.payload, n.attempts, c.config_enc, c.allow_private, c.name FROM notifications n JOIN channels c ON c.id = n.channel_id
                WHERE n.status = 'pending' AND n.next_attempt_at <= ? ORDER BY n.id LIMIT 20`)
      .all(now()) as { id: number; channel_id: number; payload: string; attempts: number; config_enc: string; allow_private: number; name: string }[];
    for (const n of due) {
      const attempts = n.attempts + 1;
      try {
        const cfg = JSON.parse(this.box.open(n.config_enc)) as WebhookConfig;
        await deliverWebhook(cfg.url, JSON.parse(n.payload) as NotificationPayload, !!n.allow_private);
        this.db.prepare("UPDATE notifications SET status = 'sent', attempts = ?, sent_at = ?, error = NULL WHERE id = ?").run(attempts, now(), n.id);
        this.db.prepare('UPDATE channels SET last_sent_at = ?, last_error = NULL WHERE id = ?').run(now(), n.channel_id);
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        const failed = attempts >= MAX_ATTEMPTS;
        const next = new Date(Date.now() + (attempts === 1 ? 30_000 : 120_000)).toISOString();
        this.db.prepare('UPDATE notifications SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?').run(failed ? 'failed' : 'pending', attempts, message, next, n.id);
        this.db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run(message, n.channel_id);
        if (failed) this.bus.publish('notification.failed', 'warning', `Notification to "${n.name}" failed after ${attempts} attempts: ${message}`, '/settings#channels');
      }
    }
  }
}
