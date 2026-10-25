import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAudit, requireSession, type AppContext } from '../context.ts';
import { now, parseJson } from '../db.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { LOAD_LIMITS } from '../loadtest/runner.ts';
import { validateTargetUrl } from '../monitoring/probe.ts';
import { CONDITION_LIMITS, validateConditions } from '../monitoring/conditions.ts';
import { MONITOR_LIMITS, type MonitorRow } from '../monitoring/scheduler.ts';
import { analyzeSite } from '../monitoring/site.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const monitorBody = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2000),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  intervalS: z.number().int().min(MONITOR_LIMITS.minIntervalS).max(MONITOR_LIMITS.maxIntervalS).default(300),
  timeoutMs: z.number().int().min(1000).max(MONITOR_LIMITS.maxTimeoutMs).default(10_000),
  expectedStatus: z.string().regex(/^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/, 'Use e.g. 200 or 200-399 or 200,204').default('200-399'),
  retries: z.number().int().min(0).max(MONITOR_LIMITS.maxRetries).default(1),
  failureThreshold: z.number().int().min(1).max(10).default(2),
  latencyThresholdMs: z.number().int().min(50).max(30_000).default(1000),
  enabled: z.boolean().default(true),
  /** Response assertions, e.g. `[BODY].status == "ok"`. */
  conditions: z.array(z.string().trim().min(1).max(CONDITION_LIMITS.maxLength)).max(CONDITION_LIMITS.maxConditions).default([]),
  /** Consecutive successful checks required before an open incident auto-resolves. */
  successThreshold: z.number().int().min(1).max(10).default(1),
});

function checkedConditions(conditions: string[]): string {
  const errors = validateConditions(conditions);
  if (errors.length) throw badRequest(`Invalid assertion(s): ${errors.join('; ')}`);
  return JSON.stringify(conditions);
}

export function opsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const getMonitor = (id: number) => {
    const m = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as unknown as MonitorRow | undefined;
    if (!m) throw notFound('Monitor not found');
    return m;
  };

  // ---------------- Monitors ----------------
  app.get('/api/monitors', async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const monitors = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM checks c WHERE c.monitor_id = m.id AND c.ts >= ?) AS checks_24h,
        (SELECT SUM(ok) FROM checks c WHERE c.monitor_id = m.id AND c.ts >= ?) AS ok_24h,
        (SELECT ROUND(AVG(latency_ms)) FROM checks c WHERE c.monitor_id = m.id AND c.ts >= ? AND c.ok = 1) AS avg_latency_24h,
        (SELECT latency_ms FROM checks c WHERE c.monitor_id = m.id ORDER BY c.id DESC LIMIT 1) AS last_latency,
        (SELECT status_code FROM checks c WHERE c.monitor_id = m.id ORDER BY c.id DESC LIMIT 1) AS last_status_code,
        (SELECT error FROM checks c WHERE c.monitor_id = m.id ORDER BY c.id DESC LIMIT 1) AS last_error,
        (SELECT id FROM incidents i WHERE i.monitor_id = m.id AND i.status != 'resolved' LIMIT 1) AS open_incident_id
      FROM monitors m ORDER BY m.name`).all(since, since, since);
    const sparks = db.prepare('SELECT monitor_id, ok, latency_ms, ts FROM checks WHERE ts >= ? ORDER BY id').all(since) as { monitor_id: number; ok: number; latency_ms: number; ts: string }[];
    const byMonitor = new Map<number, { ok: number; latency_ms: number; ts: string }[]>();
    for (const s of sparks) {
      const arr = byMonitor.get(s.monitor_id) ?? [];
      arr.push({ ok: s.ok, latency_ms: s.latency_ms, ts: s.ts });
      byMonitor.set(s.monitor_id, arr);
    }
    return { monitors: (monitors as { id: number }[]).map((m) => ({ ...m, recent: (byMonitor.get(m.id) ?? []).slice(-60) })), limits: MONITOR_LIMITS };
  });

  app.post('/api/monitors', async (req) => {
    const body = monitorBody.parse(req.body);
    const url = validateTargetUrl(body.url).toString();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM monitors').get() as { n: number }).n;
    if (count >= MONITOR_LIMITS.maxMonitors) throw badRequest(`Monitor limit (${MONITOR_LIMITS.maxMonitors}) reached.`);
    const conditions = checkedConditions(body.conditions);
    const info = db.prepare(`INSERT INTO monitors (name, url, method, interval_s, timeout_ms, expected_status, retries, failure_threshold, latency_threshold_ms, enabled, created_at, conditions, success_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(body.name, url, body.method, body.intervalS, body.timeoutMs, body.expectedStatus, body.retries, body.failureThreshold, body.latencyThresholdMs, body.enabled ? 1 : 0, now(), conditions, body.successThreshold);
    const id = Number(info.lastInsertRowid);
    logAudit(ctx, req, 'monitors.created', url);
    ctx.bus.publish('monitor.created', 'info', `Monitoring started for ${body.name} every ${body.intervalS}s`, `/monitoring/${id}`);
    void ctx.scheduler.check(getMonitor(id), true).catch(() => {});
    return { id };
  });

  app.put('/api/monitors/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    getMonitor(id);
    const body = monitorBody.parse(req.body);
    const url = validateTargetUrl(body.url).toString();
    const conditions = checkedConditions(body.conditions);
    db.prepare(`UPDATE monitors SET name = ?, url = ?, method = ?, interval_s = ?, timeout_ms = ?, expected_status = ?, retries = ?, failure_threshold = ?, latency_threshold_ms = ?, enabled = ?, conditions = ?, success_threshold = ? WHERE id = ?`)
      .run(body.name, url, body.method, body.intervalS, body.timeoutMs, body.expectedStatus, body.retries, body.failureThreshold, body.latencyThresholdMs, body.enabled ? 1 : 0, conditions, body.successThreshold, id);
    logAudit(ctx, req, 'monitors.updated', url);
    ctx.bus.invalidate('monitors');
    return { ok: true };
  });

  app.delete('/api/monitors/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const m = getMonitor(id);
    // Close its incident first so a monitor that later reuses this id cannot inherit it.
    ctx.incidents.resolveByRef('monitor', `monitor:${id}`, 'Monitor deleted');
    db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    logAudit(ctx, req, 'monitors.deleted', m.url);
    ctx.bus.invalidate('monitors');
    return { ok: true };
  });

  app.post('/api/monitors/:id/check', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    try {
      return await ctx.scheduler.check(getMonitor(id), true);
    } catch (err) {
      throw conflict((err as Error).message);
    }
  });

  app.get('/api/monitors/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }).parse(req.query);
    const m = getMonitor(id);
    const since = new Date(Date.now() - q.hours * 3_600_000).toISOString();
    const checks = (db.prepare('SELECT ts, ok, status_code, latency_ms, dns_ms, error, attempts, manual, details FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY id DESC LIMIT 5000').all(id, since) as { details: string | null }[])
      .map((c) => ({ ...c, details: parseJson(c.details, null) }));
    const incidents = db.prepare('SELECT id, title, status, severity, started_at, detected_at, resolved_at FROM incidents WHERE monitor_id = ? ORDER BY id DESC LIMIT 50').all(id);
    return { monitor: m, checks, incidents };
  });

  // ---------------- Public site analysis ----------------
  app.post('/api/sites/scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = z.object({ url: z.string().trim().max(2000) }).parse(req.body);
    const report = await analyzeSite(url);
    const info = db.prepare('INSERT INTO site_scans (url, ts, result) VALUES (?, ?, ?)').run(report.url, report.scannedAt, JSON.stringify(report));
    logAudit(ctx, req, 'sites.scanned', report.url);
    ctx.bus.publish('site.scanned', report.reachable ? 'info' : 'warning', `Scanned ${new URL(report.url).host}: ${report.reachable ? `HTTP ${report.statusCode} in ${report.timing.totalMs} ms` : report.error}`);
    return { id: Number(info.lastInsertRowid), report };
  });

  app.get('/api/sites/scans', async () => ({
    scans: (db.prepare('SELECT id, url, ts, result FROM site_scans ORDER BY id DESC LIMIT 50').all() as { id: number; url: string; ts: string; result: string }[]).map((s) => {
      const r = parseJson<{ statusCode: number | null; reachable: boolean; timing: { totalMs: number } }>(s.result, { statusCode: null, reachable: false, timing: { totalMs: 0 } });
      return { id: s.id, url: s.url, ts: s.ts, statusCode: r.statusCode, reachable: r.reachable, totalMs: r.timing.totalMs };
    }),
  }));

  app.get('/api/sites/scans/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = db.prepare('SELECT result FROM site_scans WHERE id = ?').get(id) as { result: string } | undefined;
    if (!row) throw notFound();
    return { report: JSON.parse(row.result) };
  });

  // ---------------- Incidents ----------------
  app.get('/api/incidents', async (req) => {
    const q = z
      .object({
        status: z.enum(['open', 'acknowledged', 'resolved', 'active', 'all']).default('active'),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        source: z.enum(['monitor', 'pipeline', 'security', 'manual']).optional(),
        repo: z.coerce.number().int().optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where = ['1=1'];
    const args: (string | number)[] = [];
    if (q.status === 'active') where.push("i.status != 'resolved'");
    else if (q.status !== 'all') (where.push('i.status = ?'), args.push(q.status));
    if (q.severity) (where.push('i.severity = ?'), args.push(q.severity));
    if (q.source) (where.push('i.source = ?'), args.push(q.source));
    if (q.repo) (where.push('i.repo_id = ?'), args.push(q.repo));
    if (q.search) (where.push("i.title LIKE '%' || ? || '%'"), args.push(q.search));
    const incidents = db.prepare(`SELECT i.*, r.full_name AS repo_name, m.name AS monitor_name FROM incidents i
      LEFT JOIN repositories r ON r.id = i.repo_id LEFT JOIN monitors m ON m.id = i.monitor_id
      WHERE ${where.join(' AND ')} ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, i.detected_at DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM incidents i WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
    return { incidents: (incidents as { notes: string }[]).map((i) => ({ ...i, notes: parseJson(i.notes, []) })), total };
  });

  app.get('/api/incidents/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const i = db.prepare(`SELECT i.*, r.full_name AS repo_name, m.name AS monitor_name, m.url AS monitor_url FROM incidents i
      LEFT JOIN repositories r ON r.id = i.repo_id LEFT JOIN monitors m ON m.id = i.monitor_id WHERE i.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!i) throw notFound('Incident not found');
    let timeline: unknown[] = [];
    if (i.monitor_id) {
      timeline = db.prepare('SELECT ts, ok, status_code, latency_ms, error FROM checks WHERE monitor_id = ? AND ts >= ? AND ts <= ? ORDER BY id LIMIT 500').all(
        i.monitor_id as number, new Date(Date.parse(i.started_at as string) - 3_600_000).toISOString(), (i.resolved_at as string) ?? now(),
      );
    }
    return { incident: { ...i, notes: parseJson(i.notes as string, []) }, timeline };
  });

  app.post('/api/incidents', async (req) => {
    const s = requireSession(req);
    const body = z.object({ title: z.string().trim().min(3).max(200), severity: z.enum(['critical', 'high', 'medium', 'low']), repoId: z.number().int().optional(), note: z.string().max(2000).optional() }).parse(req.body);
    const { id } = ctx.incidents.open({ source: 'manual', ref: `manual:${Date.now()}`, title: body.title, severity: body.severity, repoId: body.repoId ?? null });
    if (body.note) ctx.incidents.addNote(id, s.user.username, body.note);
    logAudit(ctx, req, 'incidents.created', String(id));
    return { id };
  });

  app.post('/api/incidents/:id/acknowledge', async (req) => {
    const { id } = idParam.parse(req.params);
    ctx.incidents.acknowledge(id, requireSession(req).user.username);
    logAudit(ctx, req, 'incidents.acknowledged', String(id));
    return { ok: true };
  });

  app.post('/api/incidents/:id/resolve', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ resolution: z.string().trim().min(3).max(1000) }).parse(req.body);
    const inc = db.prepare('SELECT source, monitor_id FROM incidents WHERE id = ?').get(id) as { source: string; monitor_id: number | null } | undefined;
    if (!inc) throw notFound();
    // Recovery verification: a monitor incident can only be closed manually once the latest check passes.
    if (inc.source === 'monitor' && inc.monitor_id) {
      const last = db.prepare('SELECT ok FROM checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 1').get(inc.monitor_id) as { ok: number } | undefined;
      if (!last?.ok) throw conflict('The latest health check is still failing. Run a manual check after fixing the service, then resolve.');
    }
    ctx.incidents.resolve(id, body.resolution, requireSession(req).user.username);
    logAudit(ctx, req, 'incidents.resolved', String(id));
    return { ok: true };
  });

  app.post('/api/incidents/:id/notes', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    ctx.incidents.addNote(id, requireSession(req).user.username, body.text);
    return { ok: true };
  });

  // ---------------- Load tests ----------------
  app.get('/api/load-tests', async () => ({
    tests: (db.prepare('SELECT * FROM load_tests ORDER BY id DESC LIMIT 100').all() as Record<string, string>[]).map((t) => ({ ...t, config: parseJson(t.config, {}), result: parseJson(t.result, null), environment: parseJson(t.environment, null) })),
    active: ctx.loadTests.status(),
    limits: LOAD_LIMITS,
  }));

  app.get('/api/load-tests/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const t = db.prepare('SELECT * FROM load_tests WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!t) throw notFound();
    return { test: { ...t, config: parseJson(t.config, {}), result: parseJson(t.result, null), environment: parseJson(t.environment, null) }, active: ctx.loadTests.status() };
  });

  app.post('/api/load-tests', async (req) => {
    const body = z
      .object({
        url: z.string().trim().max(2000),
        method: z.enum(['GET', 'HEAD']).default('GET'),
        vus: z.number().int().min(1).max(LOAD_LIMITS.local.maxVus),
        durationS: z.number().int().min(5).max(LOAD_LIMITS.local.maxDurationS),
        rampUpS: z.number().int().min(0).default(0),
        requestTimeoutMs: z.number().int().min(500).max(30_000).default(10_000),
        abortErrorRatePct: z.number().min(1).max(100).default(50),
        rpsPerVu: z.number().min(0).max(100).default(0),
        thresholds: z.object({ p95Ms: z.number().int().min(1).max(60_000).default(500), errorRatePct: z.number().min(0).max(100).default(1) }).default({ p95Ms: 500, errorRatePct: 1 }),
        ownershipConfirmed: z.boolean().default(false),
      })
      .parse(req.body);
    validateTargetUrl(body.url);
    const id = ctx.loadTests.start(body, requireSession(req).user.username);
    logAudit(ctx, req, 'loadtests.started', body.url, `vus=${body.vus} duration=${body.durationS}s ownershipConfirmed=${body.ownershipConfirmed}`);
    return { id };
  });

  app.post('/api/load-tests/stop', async (req) => {
    ctx.loadTests.stop();
    logAudit(ctx, req, 'loadtests.stopped');
    return { ok: true };
  });

  app.post('/api/load-tests/import-k6', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const body = z.object({ target: z.string().trim().min(1).max(500), notes: z.string().max(500).default(''), summary: z.record(z.string(), z.unknown()) }).parse(req.body);
    const id = ctx.loadTests.importK6(body.summary, body.target, body.notes);
    logAudit(ctx, req, 'loadtests.imported', body.target);
    return { id };
  });
}
