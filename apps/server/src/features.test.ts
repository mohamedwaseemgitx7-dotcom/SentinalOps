import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { SecretBox } from './lib/secretbox.ts';
import { deliverWebhook, isPrivateAddress } from './notifications.ts';

const PASSWORD = `pw-${crypto.randomUUID()}`;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let headers: Record<string, string>;

// A local HTTP server standing in for a monitored API and a webhook receiver.
let target: http.Server;
let base: string;
let apiStatus = 'ok';
const received: { path: string; body: unknown }[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: apiStatus, db: { ok: apiStatus === 'ok' } }));
      } else if (req.url?.startsWith('/hook')) {
        received.push({ path: req.url, body: body ? JSON.parse(body) : null });
        res.statusCode = req.url === '/hook/fail' ? 500 : 204;
        res.end();
      } else if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
        res.end();
      } else res.end('ok');
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-feat-'));
  const built = await buildApp(loadConfig({ dataDir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: null, githubToken: null, authRateLimitPerMin: 100 }));
  app = built.app;
  ctx = built.ctx;
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: built.setup!.token, username: 'owner', password: PASSWORD } });
  headers = { cookie: String(setup.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': setup.json().csrfToken as string };
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => target.close(() => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('secret storage', () => {
  it('round-trips with AES-GCM and detects tampering', () => {
    const box = new SecretBox(dataDir);
    const sealed = box.seal('https://hooks.example.com/T0/secret-token');
    expect(sealed).not.toContain('secret-token');
    expect(box.open(sealed)).toBe('https://hooks.example.com/T0/secret-token');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
  });
});

describe('webhook SSRF protection', () => {
  it('classifies internal addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('refuses private targets by default and does not follow redirects', async () => {
    const payload = { event: 'test' as const, sentAt: new Date().toISOString(), app: 'SentinelOps' as const, summary: 'x' };
    await expect(deliverWebhook(`${base}/hook`, payload, false)).rejects.toThrow(/private/);
    await expect(deliverWebhook(`${base}/redirect`, payload, true)).rejects.toThrow(/redirects are not followed/);
    await expect(deliverWebhook('file:///etc/passwd', payload, true)).rejects.toThrow(/http or https/);
  });

  it('never returns the stored webhook URL to clients', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/channels', headers, payload: { name: 'Local hook', url: `${base}/hook/secret-abc123`, allowPrivate: true } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ url: '/api/channels', headers });
    expect(list.body).not.toContain('secret-abc123');
    expect(list.json().channels[0].target_hint).toBe(`${base}/…`);
    const row = ctx.db.prepare('SELECT config_enc FROM channels').get() as { config_enc: string };
    expect(row.config_enc).not.toContain('secret-abc123');
  });

  it('delivers a test notification', async () => {
    const id = (ctx.db.prepare('SELECT id FROM channels').get() as { id: number }).id;
    const res = await app.inject({ method: 'POST', url: `/api/channels/${id}/test`, headers });
    expect(res.json()).toMatchObject({ status: 'sent' });
    expect(received.at(-1)).toMatchObject({ path: '/hook/secret-abc123', body: { event: 'test', app: 'SentinelOps' } });
  });
});

describe('monitor assertions, hysteresis and incident notifications', () => {
  it('fails on a body assertion, notifies, and resolves only after N successes', async () => {
    received.length = 0;
    const created = await app.inject({
      method: 'POST', url: '/api/monitors', headers,
      payload: { name: 'API health', url: `${base}/health`, retries: 0, failureThreshold: 1, successThreshold: 2, conditions: ['[STATUS] == 200', '[BODY].status == "ok"', '[BODY].db.ok == true'] },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as number;
    for (let i = 0; i < 100 && !(ctx.db.prepare('SELECT last_checked_at FROM monitors WHERE id = ?').get(id) as { last_checked_at: string | null }).last_checked_at; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    const row = () => ctx.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as never;
    const openCount = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ? AND status != 'resolved'").get(id) as { n: number }).n;

    apiStatus = 'degraded'; // HTTP 200, but the body says otherwise
    const fail = await ctx.scheduler.check(row(), true);
    expect(fail.ok).toBe(false);
    expect(fail.error).toMatch(/Assertion failed: \[BODY\]\.status \("degraded"\) == "ok"/);
    expect(openCount()).toBe(1);

    apiStatus = 'ok';
    await ctx.scheduler.check(row(), true);
    expect(openCount()).toBe(1); // one success is not enough (successThreshold = 2)
    await ctx.scheduler.check(row(), true);
    expect(openCount()).toBe(0);

    for (let i = 0; i < 40 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(received.map((r) => (r.body as { event: string }).event)).toEqual(['incident.opened', 'incident.resolved']);

    const detail = await app.inject({ url: `/api/monitors/${id}?hours=1`, headers });
    const failedCheck = (detail.json().checks as { ok: number; details: { success: boolean }[] | null }[]).find((c) => !c.ok)!;
    expect(failedCheck.details!.map((d) => d.success)).toEqual([true, false, false]);
  });

  it('rejects invalid assertions when saving', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/monitors', headers, payload: { name: 'bad', url: `${base}/health`, conditions: ['[BODY].__proto__ == 1'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not allowed/);
  });
});

describe('heartbeat (push) monitors', () => {
  it('goes up on ping, down after timeout + grace, and recovers', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/heartbeats', headers, payload: { name: 'Nightly backup', timeoutS: 3600, graceS: 600 } });
    const { id, token } = created.json() as { id: number; token: string };
    expect(ctx.db.prepare('SELECT token_hash FROM heartbeats WHERE id = ?').get(id)).not.toMatchObject({ token_hash: token });

    expect((await app.inject(`/ping/${'x'.repeat(32)}`)).statusCode).toBe(404);
    const ping = await app.inject(`/ping/${token}`); // no cookie, no CSRF
    expect(ping.statusCode).toBe(200);
    expect(ping.body).toBe('OK');
    expect(ping.headers['cache-control']).toBe('no-store');
    expect(ctx.heartbeats.get(id)!.status).toBe('up');

    // Not yet overdue (within timeout + grace): nothing happens.
    expect(ctx.heartbeats.sweep(Date.now() + 3_500_000)).toBe(0);
    // Past timeout + grace: down, incident opened exactly once.
    expect(ctx.heartbeats.sweep(Date.now() + 4_300_000)).toBe(1);
    expect(ctx.heartbeats.sweep(Date.now() + 5_000_000)).toBe(0);
    expect(ctx.heartbeats.get(id)!.status).toBe('down');
    const open = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE ref = ? AND status != 'resolved'").get(`heartbeat:${id}`) as { n: number }).n;
    expect(open()).toBe(1);

    await app.inject({ method: 'POST', url: `/ping/${token}`, payload: 'backup finished: 12 GB', headers: { 'content-type': 'text/plain' } });
    expect(ctx.heartbeats.get(id)!.status).toBe('up');
    expect(open()).toBe(0);
  });

  it('reports failures via /fail and non-zero exit codes, and times runs with /start', async () => {
    const { id, token } = (await app.inject({ method: 'POST', url: '/api/heartbeats', headers, payload: { name: 'ETL job', timeoutS: 3600, graceS: 300 } })).json() as { id: number; token: string };
    await app.inject(`/ping/${token}/start`);
    await new Promise((r) => setTimeout(r, 30));
    await app.inject(`/ping/${token}/0`);
    expect(ctx.heartbeats.get(id)!.status).toBe('up');
    expect(ctx.heartbeats.get(id)!.last_duration_ms).toBeGreaterThanOrEqual(20);
    await app.inject(`/ping/${token}/2`);
    expect(ctx.heartbeats.get(id)!.status).toBe('down');
    expect(ctx.heartbeats.get(id)!.last_event).toBe('exit 2');
    expect((await app.inject(`/ping/${token}/999`)).statusCode).toBe(404);
  });

  it('rate-limits pings per token and IP', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/api/heartbeats', headers, payload: { name: 'Chatty', timeoutS: 60, graceS: 60 } })).json() as { token: string };
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await app.inject(`/ping/${token}`)).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
  });

  it('requires an admin session to manage heartbeats', async () => {
    expect((await app.inject('/api/heartbeats')).statusCode).toBe(401);
  });
});
