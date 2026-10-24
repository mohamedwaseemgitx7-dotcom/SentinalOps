import crypto from 'node:crypto';
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

// Generated per run so no credential-like literal lives in the repository.
const PASSWORD = `pw-${crypto.randomUUID()}`;

let app: FastifyInstance;
let ctx: AppContext;
let setupToken: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-test-'));
  const built = await buildApp(loadConfig({ dataDir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: null, githubToken: null, authRateLimitPerMin: 1000 }));
  app = built.app;
  ctx = built.ctx;
  setupToken = built.setup!.token;
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0]!;
}

async function login(username: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return { res, cookie: res.statusCode === 200 ? cookieFrom(res) : '', csrf: res.json().csrfToken as string };
}

describe('first-run setup', () => {
  it('requires setup and writes the token file', async () => {
    const res = await app.inject('/api/auth/status');
    expect(res.json().setupRequired).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'setup-token.txt'), 'utf8').trim()).toBe(setupToken);
  });

  it('rejects a wrong setup token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: 'x'.repeat(32), username: 'mohamedwaseem', password: PASSWORD } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects weak passwords', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: setupToken, username: 'mohamedwaseem', password: 'short' } });
    expect(res.statusCode).toBe(400);
  });

  it('creates the administrator once, then removes the token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: setupToken, username: 'mohamedwaseem', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'mohamedwaseem', role: 'admin' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(fs.existsSync(path.join(dataDir, 'setup-token.txt'))).toBe(false);
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: setupToken, username: 'other', password: PASSWORD } });
    expect(again.statusCode).toBe(409);
  });

  it('never stores the password in plain text', () => {
    const row = ctx.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);
  });
});

describe('authentication and authorisation', () => {
  it('blocks every private endpoint without a session', async () => {
    for (const url of ['/api/overview', '/api/repositories', '/api/findings', '/api/monitors', '/api/incidents', '/api/analytics', '/api/settings', '/api/audit', '/api/events/stream']) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('rejects a forged session cookie', async () => {
    expect((await app.inject({ url: '/api/overview', headers: { cookie: 'so_session=forged' } })).statusCode).toBe(401);
  });

  it('logs in and reads private data', async () => {
    const { res, cookie } = await login('mohamedwaseem');
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/overview', headers: { cookie } })).statusCode).toBe(200);
  });

  it('requires a CSRF token for mutations', async () => {
    const { cookie, csrf } = await login('mohamedwaseem');
    const body = { name: 'x', url: 'http://127.0.0.1:9/', intervalS: 300 };
    expect((await app.inject({ method: 'POST', url: '/api/monitors', headers: { cookie }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/monitors', headers: { cookie, 'x-csrf-token': 'wrong' }, payload: body })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/monitors', headers: { cookie, 'x-csrf-token': csrf }, payload: body });
    expect(ok.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/api/monitors/${ok.json().id}`, headers: { cookie, 'x-csrf-token': csrf } });
  });

  it('gives invited viewers read-only access', async () => {
    const admin = await login('mohamedwaseem');
    const invite = await app.inject({ method: 'POST', url: '/api/users/invites', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf }, payload: { role: 'viewer' } });
    const accepted = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token: invite.json().token, username: 'reviewer', password: PASSWORD } });
    expect(accepted.statusCode).toBe(200);
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token: invite.json().token, username: 'reviewer2', password: PASSWORD } });
    expect(reuse.statusCode).toBe(403);

    const viewer = await login('reviewer');
    expect((await app.inject({ url: '/api/overview', headers: { cookie: viewer.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/audit', headers: { cookie: viewer.cookie } })).statusCode).toBe(403);
    const write = await app.inject({ method: 'POST', url: '/api/monitors', headers: { cookie: viewer.cookie, 'x-csrf-token': viewer.csrf }, payload: { name: 'x', url: 'http://127.0.0.1:9/' } });
    expect(write.statusCode).toBe(403);
    // Any role may log out.
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: viewer.cookie, 'x-csrf-token': viewer.csrf } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/overview', headers: { cookie: viewer.cookie } })).statusCode).toBe(401);
  });

  it('locks an account after repeated failures, with a generic message', async () => {
    const unknown = await login('nobody', 'wrong-password-123');
    expect(unknown.res.statusCode).toBe(401);
    for (let i = 0; i < 5; i++) {
      const r = await login('reviewer', 'wrong-password-123');
      expect(r.res.json().message).toBe('Invalid username or password.');
    }
    const locked = await login('reviewer');
    expect(locked.res.statusCode).toBe(429);
  });

  it('revokes other sessions when the password changes', async () => {
    const a = await login('mohamedwaseem');
    const b = await login('mohamedwaseem');
    const newPassword = `pw-${crypto.randomUUID()}`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf }, payload: { currentPassword: PASSWORD, newPassword } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/overview', headers: { cookie: b.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/overview', headers: { cookie: a.cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf }, payload: { currentPassword: newPassword, newPassword: PASSWORD } });
  });

  it('records security events in the audit log without secrets', () => {
    const rows = ctx.db.prepare('SELECT action, detail FROM audit_log').all() as { action: string; detail: string | null }[];
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.setup', 'auth.login', 'auth.login_failed', 'auth.password_changed', 'users.invite_created']));
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});

describe('monitoring, incidents and recovery verification', () => {
  let target: http.Server;
  let healthy = true;
  let url: string;

  beforeAll(async () => {
    target = http.createServer((_req, res) => {
      res.statusCode = healthy ? 200 : 503;
      res.end(healthy ? 'ok' : 'down');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/health`;
  });
  afterAll(() => new Promise<void>((r) => target.close(() => r())));

  it('opens an incident after the failure threshold and resolves it on recovery', async () => {
    const { cookie, csrf } = await login('mohamedwaseem');
    const headers = { cookie, 'x-csrf-token': csrf };
    const created = await app.inject({ method: 'POST', url: '/api/monitors', headers, payload: { name: 'Test API', url, intervalS: 60, retries: 0, failureThreshold: 2 } });
    const id = created.json().id as number;
    // Creation fires an initial check in the background; wait for it rather than a fixed delay (CI is slower).
    for (let i = 0; i < 100; i++) {
      const row = ctx.db.prepare('SELECT last_checked_at FROM monitors WHERE id = ?').get(id) as { last_checked_at: string | null };
      if (row.last_checked_at) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100)); // let the check release its in-flight slot

    healthy = false;
    const m = () => ctx.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as never;
    expect((await ctx.scheduler.check(m(), true)).ok).toBe(false);
    let open = ctx.db.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND status != 'resolved'").all(id);
    expect(open).toHaveLength(0); // below threshold
    await ctx.scheduler.check(m(), true);
    open = ctx.db.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND status != 'resolved'").all(id);
    expect(open).toHaveLength(1);
    const incidentId = (open[0] as { id: number }).id;

    // Manual resolve is refused while the service is still failing.
    const refused = await app.inject({ method: 'POST', url: `/api/incidents/${incidentId}/resolve`, headers, payload: { resolution: 'restarted' } });
    expect(refused.statusCode).toBe(409);

    healthy = true;
    expect((await ctx.scheduler.check(m(), true)).ok).toBe(true);
    const inc = ctx.db.prepare('SELECT status, started_at, detected_at, resolved_at FROM incidents WHERE id = ?').get(incidentId) as { status: string; started_at: string; detected_at: string; resolved_at: string };
    expect(inc.status).toBe('resolved');
    expect(inc.started_at <= inc.detected_at).toBe(true);
    expect(inc.resolved_at).toBeTruthy();
  });

  it('discards a check whose monitor was deleted and its id reused while it ran', async () => {
    const { cookie, csrf } = await login('mohamedwaseem');
    const headers = { cookie, 'x-csrf-token': csrf };
    const deadUrl = 'http://127.0.0.1:9/'; // closed port: fails, then retries after 2 s
    const first = (await app.inject({ method: 'POST', url: '/api/monitors', headers, payload: { name: 'stale', url: deadUrl, retries: 1, failureThreshold: 1 } })).json().id as number;
    const row = ctx.db.prepare('SELECT * FROM monitors WHERE id = ?').get(first) as never;
    // Wait for the creation-time check to finish so we control the in-flight one.
    for (let i = 0; i < 100 && (ctx.db.prepare('SELECT last_checked_at FROM monitors WHERE id = ?').get(first) as { last_checked_at: string | null }).last_checked_at === null; i++) await new Promise((r) => setTimeout(r, 50));
    ctx.incidents.resolveByRef('monitor', `monitor:${first}`, 'test setup');
    const pending = ctx.scheduler.check(row, true); // in flight for ~2 s
    await app.inject({ method: 'DELETE', url: `/api/monitors/${first}`, headers });
    ctx.db.prepare("INSERT INTO monitors (id, name, url, interval_s, timeout_ms, created_at) VALUES (?, 'replacement', ?, 300, 5000, ?)").run(first, url, new Date(Date.now() + 1).toISOString());
    await pending;
    const replacement = ctx.db.prepare('SELECT consecutive_failures, last_checked_at FROM monitors WHERE id = ?').get(first) as { consecutive_failures: number; last_checked_at: string | null };
    expect(replacement).toEqual({ consecutive_failures: 0, last_checked_at: null });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM checks WHERE monitor_id = ?').get(first)).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ? AND status != 'resolved'").get(first)).toEqual({ n: 0 });
    ctx.db.prepare('DELETE FROM monitors WHERE id = ?').run(first);
  }, 15_000);

  it('computes a health score only from inputs that have data', async () => {
    const { cookie } = await login('mohamedwaseem');
    const res = await app.inject({ url: '/api/health-score', headers: { cookie } });
    const h = res.json().health;
    const ci = h.components.find((c: { key: string }) => c.key === 'ci');
    expect(ci.score).toBeNull(); // no workflow runs → unknown, not "healthy"
    expect(h.partial).toBe(true);
    expect(h.coverage).toBeLessThan(1);
    // With under half the inputs measured, no headline score is produced at all.
    if (h.coverage < 0.5) expect(h.score).toBeNull();
    else expect(h.score).not.toBeNull();
  });

  it('enforces load-test target authorisation and caps', async () => {
    const { cookie, csrf } = await login('mohamedwaseem');
    const headers = { cookie, 'x-csrf-token': csrf };
    const remote = await app.inject({ method: 'POST', url: '/api/load-tests', headers, payload: { url: 'https://example.com/', vus: 5, durationS: 10 } });
    expect(remote.statusCode).toBe(400);
    expect(remote.json().message).toMatch(/monitors/);
    const tooMany = await app.inject({ method: 'POST', url: '/api/load-tests', headers, payload: { url, vus: 500, durationS: 10 } });
    expect(tooMany.statusCode).toBe(400);
  });

  it('escapes formula-like cells in CSV exports', async () => {
    ctx.incidents.open({ source: 'manual', ref: 'csv-test', title: '=HYPERLINK("http://evil")', severity: 'low' });
    const { cookie } = await login('mohamedwaseem');
    const res = await app.inject({ url: '/api/analytics/export.csv?dataset=incidents', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('login rate limiting', () => {
  it('throttles repeated login attempts per IP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-rl-'));
    const built = await buildApp(loadConfig({ dataDir: dir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: null, githubToken: null, authRateLimitPerMin: 10 }));
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y' } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    await built.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('serving the web UI', () => {
  it('serves the SPA shell at / and for client routes, but 404s unknown API paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-web-'));
    const web = path.join(dir, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc.js'), 'console.log(1)');
    const built = await buildApp(loadConfig({ dataDir: dir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: web, githubToken: null }));
    const root = await built.app.inject('/');
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('id="root"');
    expect((await built.app.inject('/repositories/5')).body).toContain('id="root"');
    const asset = await built.app.inject('/assets/app-abc.js');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await built.app.inject('/api/nope')).statusCode).toBeGreaterThanOrEqual(400);
    await built.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('API rate limiting', () => {
  it('limits per session, never limits the liveness probe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-api-rl-'));
    const built = await buildApp(loadConfig({ dataDir: dir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: null, githubToken: null, apiRateLimitPerMin: 20, authRateLimitPerMin: 100 }));
    const { app: a, setup } = built;
    await a.inject({ method: 'POST', url: '/api/auth/setup', payload: { token: setup!.token, username: 'admin1', password: PASSWORD } });
    const login = async () => cookieFrom(await a.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin1', password: PASSWORD } }));
    const s1 = await login();
    const s2 = await login();
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await a.inject({ url: '/api/overview', headers: { cookie: s1 } })).statusCode);
    expect(codes).toContain(429);
    // A different session from the same IP is unaffected.
    expect((await a.inject({ url: '/api/overview', headers: { cookie: s2 } })).statusCode).toBe(200);
    for (let i = 0; i < 30; i++) expect((await a.inject('/api/health')).statusCode).toBe(200);
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('load test runner', () => {
  it('runs a bounded local test to completion and allows the next one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-lt-'));
    const built = await buildApp(loadConfig({ dataDir: dir, dbFile: ':memory:', enableScheduler: false, logLevel: 'silent', webDir: null, githubToken: null }));
    const target = http.createServer((_q, s) => s.end('ok'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    const req = { url, method: 'GET' as const, vus: 2, durationS: 5, rampUpS: 0, requestTimeoutMs: 2000, abortErrorRatePct: 50, rpsPerVu: 20, thresholds: { p95Ms: 1000, errorRatePct: 1 }, ownershipConfirmed: false };
    const first = built.ctx.loadTests.start(req, 'test');
    await expect(async () => built.ctx.loadTests.start(req, 'test')).rejects.toThrow(/already running/);
    for (let i = 0; i < 40 && built.ctx.loadTests.status(); i++) await new Promise((r) => setTimeout(r, 250));
    expect(built.ctx.loadTests.status()).toBeNull();
    const row = built.ctx.db.prepare('SELECT status, result FROM load_tests WHERE id = ?').get(first) as { status: string; result: string };
    expect(row.status).toBe('passed');
    const result = JSON.parse(row.result);
    expect(result.totalRequests).toBeGreaterThan(50);
    expect(result.errorRatePct).toBe(0);
    // A second test can start once the first has finished.
    const second = built.ctx.loadTests.start(req, 'test');
    expect(second).toBeGreaterThan(first);
    built.ctx.loadTests.stop();
    for (let i = 0; i < 40 && built.ctx.loadTests.status(); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise<void>((r) => target.close(() => r()));
    await built.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
