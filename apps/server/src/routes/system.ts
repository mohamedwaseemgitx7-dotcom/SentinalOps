import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { detectScanners } from '../analysis/scanners.ts';
import { logAudit, type AppContext } from '../context.ts';
import { getSetting, parseJson, setSetting, type DB } from '../db.ts';
import { computeHealth } from '../health.ts';
import { badRequest } from '../lib/errors.ts';

const MAX_SSE_PER_USER = 5;
const MAX_SSE_TOTAL = 1000;

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)]!;
}

const FAILED_SQL = "conclusion IN ('failure','timed_out','startup_failure')";

const rangeQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  repo: z.coerce.number().int().optional(),
});

export function analytics(db: DB, q: z.infer<typeof rangeQuery>) {
  const to = q.to ?? new Date().toISOString();
  const from = q.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw badRequest('Choose a range of at most one year.');
  const repoSql = q.repo ? ` AND repo_id = ${Number(q.repo)}` : '';

  const runs = db.prepare(`SELECT created_at, conclusion, duration_s, workflow_name, event, repo_id FROM workflow_runs WHERE status = 'completed' AND created_at >= ? AND created_at <= ?${repoSql}`).all(from, to) as {
    created_at: string; conclusion: string; duration_s: number | null; workflow_name: string; event: string; repo_id: number;
  }[];
  const ok = runs.filter((r) => r.conclusion === 'success');
  const failed = new Set(runs.filter((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)));
  const days = new Map<string, { date: string; success: number; failed: number; other: number; durations: number[] }>();
  for (let t = Date.parse(from.slice(0, 10)); t <= Date.parse(to); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.set(d, { date: d, success: 0, failed: 0, other: 0, durations: [] });
  }
  for (const r of runs) {
    const d = days.get(r.created_at.slice(0, 10));
    if (!d) continue;
    if (r.conclusion === 'success') d.success++;
    else if (failed.has(r)) d.failed++;
    else d.other++;
    if (r.duration_s !== null && r.conclusion === 'success') d.durations.push(r.duration_s);
  }
  const ciDaily = [...days.values()].map((d) => ({
    date: d.date, success: d.success, failed: d.failed, other: d.other,
    successRate: d.success + d.failed ? Math.round((d.success / (d.success + d.failed)) * 1000) / 10 : null,
    avgDurationS: d.durations.length ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length) : null,
  }));
  const durations = ok.map((r) => r.duration_s).filter((x): x is number => x !== null);

  const categories = db.prepare(`SELECT d.category, COUNT(*) AS n FROM run_diagnoses d JOIN workflow_runs r ON r.id = d.run_id WHERE r.created_at >= ? AND r.created_at <= ?${repoSql.replace('repo_id', 'r.repo_id')} GROUP BY d.category ORDER BY n DESC`).all(from, to);
  const diag = db.prepare(`SELECT COUNT(*) AS total, SUM(d.verified_by_run_id IS NOT NULL) AS verified FROM run_diagnoses d JOIN workflow_runs r ON r.id = d.run_id WHERE r.created_at >= ? AND r.created_at <= ?${repoSql.replace('repo_id', 'r.repo_id')}`).get(from, to) as { total: number; verified: number | null };

  const deploys = runs.filter((r) => /deploy|release|publish/i.test(r.workflow_name) || r.event === 'deployment');
  const deployFailed = deploys.filter((r) => failed.has(r));
  const spanDays = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86_400_000);

  const incidents = db.prepare(`SELECT source, severity, status, started_at, detected_at, resolved_at, title FROM incidents WHERE detected_at >= ? AND detected_at <= ?${repoSql}`).all(from, to) as {
    source: string; severity: string; status: string; started_at: string; detected_at: string; resolved_at: string | null; title: string;
  }[];
  const resolved = incidents.filter((i) => i.resolved_at);
  const mttrMin = resolved.length ? Math.round(resolved.reduce((a, i) => a + (Date.parse(i.resolved_at!) - Date.parse(i.started_at)), 0) / resolved.length / 60_000) : null;
  const detectable = incidents.filter((i) => i.source === 'monitor' || i.source === 'pipeline');
  const mttdMin = detectable.length ? Math.round((detectable.reduce((a, i) => a + Math.max(0, Date.parse(i.detected_at) - Date.parse(i.started_at)), 0) / detectable.length / 60_000) * 10) / 10 : null;
  const repeated = Object.entries(
    incidents.reduce<Record<string, number>>((acc, i) => {
      const key = i.title.replace(/#\d+|\d+ (critical|high)/g, '').trim();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  ).filter(([, n]) => n > 1).map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  const findingsOpened = db.prepare(`SELECT substr(first_seen, 1, 10) AS date, severity, COUNT(*) AS n FROM findings WHERE first_seen >= ? AND first_seen <= ?${repoSql} GROUP BY date, severity ORDER BY date`).all(from, to);
  const findingsResolved = db.prepare(`SELECT substr(resolved_at, 1, 10) AS date, COUNT(*) AS n FROM findings WHERE resolved_at >= ? AND resolved_at <= ?${repoSql} GROUP BY date ORDER BY date`).all(from, to);
  const openBySeverity = db.prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open'${repoSql} GROUP BY severity`).all();

  const availability = q.repo ? [] : (db.prepare(`SELECT m.id, m.name, COUNT(c.id) AS checks, SUM(c.ok) AS ok, ROUND(AVG(CASE WHEN c.ok = 1 THEN c.latency_ms END)) AS avg_latency
      FROM monitors m LEFT JOIN checks c ON c.monitor_id = m.id AND c.ts >= ? AND c.ts <= ? GROUP BY m.id ORDER BY m.name`).all(from, to) as { id: number; name: string; checks: number; ok: number | null; avg_latency: number | null }[]).map((m) => {
    const lat = (db.prepare('SELECT latency_ms FROM checks WHERE monitor_id = ? AND ts >= ? AND ts <= ? AND ok = 1 LIMIT 20000').all(m.id, from, to) as { latency_ms: number }[]).map((r) => r.latency_ms);
    return { ...m, availabilityPct: m.checks ? Math.round(((m.ok ?? 0) / m.checks) * 10000) / 100 : null, p95LatencyMs: percentile(lat, 95) };
  });

  const repoComparison = db.prepare(`SELECT r.id, r.full_name,
      (SELECT COUNT(*) FROM workflow_runs w WHERE w.repo_id = r.id AND w.status = 'completed' AND w.created_at >= ? AND w.conclusion = 'success') AS ok,
      (SELECT COUNT(*) FROM workflow_runs w WHERE w.repo_id = r.id AND w.status = 'completed' AND w.created_at >= ? AND w.${FAILED_SQL}) AS failed,
      (SELECT COUNT(*) FROM findings f WHERE f.repo_id = r.id AND f.status = 'open' AND f.severity IN ('critical','high')) AS critical_high,
      (SELECT COUNT(*) FROM incidents i WHERE i.repo_id = r.id AND i.status != 'resolved') AS open_incidents
    FROM repositories r ${q.repo ? `WHERE r.id = ${Number(q.repo)}` : ''} ORDER BY r.full_name`).all(from, from) as { id: number; full_name: string; ok: number; failed: number; critical_high: number; open_incidents: number }[];

  const loadTests = db.prepare("SELECT id, target, started_at, status, source, result FROM load_tests WHERE started_at >= ? AND started_at <= ? AND result IS NOT NULL ORDER BY id DESC LIMIT 20").all(from, to) as { result: string }[];

  return {
    range: { from, to },
    ci: {
      total: runs.length, success: ok.length, failed: failed.size,
      successRate: ok.length + failed.size ? Math.round((ok.length / (ok.length + failed.size)) * 1000) / 10 : null,
      avgDurationS: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p95DurationS: percentile(durations, 95),
      daily: ciDaily,
      failureCategories: categories,
      fixVerification: { diagnosed: diag.total, verified: diag.verified ?? 0, rate: diag.total ? Math.round(((diag.verified ?? 0) / diag.total) * 1000) / 10 : null },
    },
    delivery: {
      definition: 'Deployments are completed workflow runs whose name contains deploy/release/publish or that were triggered by a deployment event. Heuristic — rename workflows or tag them to improve accuracy.',
      deployments: deploys.length,
      perWeek: deploys.length ? Math.round((deploys.length / spanDays) * 7 * 10) / 10 : null,
      changeFailureRatePct: deploys.length ? Math.round((deployFailed.length / deploys.length) * 1000) / 10 : null,
    },
    incidents: {
      total: incidents.length, open: incidents.filter((i) => i.status !== 'resolved').length, resolved: resolved.length,
      mttrMinutes: mttrMin, mttdMinutes: mttdMin,
      mttdNote: 'Time from the first failing signal (failed check or failing run) to incident creation. Only monitor and pipeline incidents have a measurable start.',
      bySource: countBy(incidents, (i) => i.source), bySeverity: countBy(incidents, (i) => i.severity), repeated,
    },
    security: { openBySeverity, opened: findingsOpened, resolved: findingsResolved },
    availability,
    repositories: repoComparison.map((r) => ({ ...r, successRate: r.ok + r.failed ? Math.round((r.ok / (r.ok + r.failed)) * 1000) / 10 : null })),
    loadTests: loadTests.map((t) => ({ ...t, result: parseJson(t.result, null) })),
    healthTrend: db.prepare('SELECT ts, score, coverage FROM health_snapshots WHERE ts >= ? AND ts <= ? ORDER BY id').all(from, to),
  };
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

export function systemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const sseClients = new Map<number, number>();
  let sseTotal = 0;

  /** Liveness/readiness for load balancers and the desktop shell. No data, no auth. */
  app.get('/api/health', { config: { public: true } }, async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', version: ctx.version, uptimeS: Math.round(process.uptime()) };
  });

  app.get('/api/overview', async () => {
    const health = computeHealth(db);
    const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const d60 = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const rate = (fromTs: string, toTs: string) => {
      const r = db.prepare(`SELECT SUM(conclusion = 'success') AS ok, SUM(${FAILED_SQL}) AS bad FROM workflow_runs WHERE status = 'completed' AND created_at >= ? AND created_at < ?`).get(fromTs, toTs) as { ok: number | null; bad: number | null };
      const total = (r.ok ?? 0) + (r.bad ?? 0);
      return { rate: total ? Math.round(((r.ok ?? 0) / total) * 1000) / 10 : null, total };
    };
    const nowIso = new Date().toISOString();
    const current = rate(d30, nowIso);
    const previous = rate(d60, d30);
    const durations = (db.prepare("SELECT duration_s FROM workflow_runs WHERE status = 'completed' AND conclusion = 'success' AND created_at >= ? AND duration_s IS NOT NULL").all(d30) as { duration_s: number }[]).map((r) => r.duration_s);
    const prevDurations = (db.prepare("SELECT duration_s FROM workflow_runs WHERE status = 'completed' AND conclusion = 'success' AND created_at >= ? AND created_at < ? AND duration_s IS NOT NULL").all(d60, d30) as { duration_s: number }[]).map((r) => r.duration_s);
    const avg = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);
    const incidentCounts = Object.fromEntries((db.prepare("SELECT severity, COUNT(*) AS n FROM incidents WHERE status != 'resolved' GROUP BY severity").all() as { severity: string; n: number }[]).map((r) => [r.severity, r.n]));
    const findingCounts = Object.fromEntries((db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY severity").all() as { severity: string; n: number }[]).map((r) => [r.severity, r.n]));
    const crit = (findingCounts.critical as number) ?? 0;
    const high = (findingCounts.high as number) ?? 0;
    const analysed = (db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE last_analysis_status = 'completed'").get() as { n: number }).n;
    const pipelineDaily = analytics(db, { from: new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z' }).ci.daily;
    const counts = db.prepare("SELECT (SELECT COUNT(*) FROM repositories) AS repos, (SELECT COUNT(*) FROM monitors) AS monitors, (SELECT COUNT(*) FROM monitors WHERE enabled = 1 AND last_ok = 0) AS monitors_down, (SELECT COUNT(*) FROM workflow_runs) AS runs").get();
    return {
      health,
      kpis: {
        ciSuccessRate: { value: current.rate, previous: previous.rate, runs: current.total, window: '30 days' },
        openIncidents: { value: Object.values(incidentCounts).reduce((a: number, b) => a + (b as number), 0), bySeverity: incidentCounts },
        localRisk: {
          level: !analysed ? 'unknown' : crit ? 'critical' : high ? 'high' : (findingCounts.medium as number) ? 'medium' : 'low',
          critical: crit, high, medium: (findingCounts.medium as number) ?? 0, low: (findingCounts.low as number) ?? 0, analysedRepos: analysed,
        },
        avgBuildTime: { valueS: avg(durations), previousS: avg(prevDurations), p95S: percentile(durations, 95), runs: durations.length, window: '30 days, successful runs' },
      },
      pipelineDaily,
      counts,
      events: ctx.bus.recent(25),
    };
  });

  app.get('/api/health-score', async (req) => {
    const q = z.object({ repo: z.coerce.number().int().optional() }).parse(req.query);
    return { health: computeHealth(db, { repoId: q.repo }), trend: db.prepare('SELECT ts, score, coverage FROM health_snapshots ORDER BY id DESC LIMIT 200').all().reverse() };
  });

  app.get('/api/analytics', async (req) => analytics(db, rangeQuery.parse(req.query)));

  app.get('/api/analytics/export.csv', async (req, reply) => {
    const q = rangeQuery.extend({ dataset: z.enum(['runs', 'incidents', 'findings', 'checks']) }).parse(req.query);
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
    const repoSql = q.repo ? ` AND repo_id = ${Number(q.repo)}` : '';
    const sql: Record<typeof q.dataset, string> = {
      runs: `SELECT id, repo_id, workflow_name, branch, head_sha, event, status, conclusion, created_at, duration_s, html_url FROM workflow_runs WHERE created_at >= ? AND created_at <= ?${repoSql} ORDER BY created_at LIMIT 50000`,
      incidents: `SELECT id, source, severity, status, title, started_at, detected_at, acknowledged_at, resolved_at FROM incidents WHERE detected_at >= ? AND detected_at <= ?${repoSql} ORDER BY detected_at LIMIT 50000`,
      findings: `SELECT id, repo_id, rule_id, source, severity, status, title, file, line, package, first_seen, last_seen, resolved_at FROM findings WHERE last_seen >= ? AND first_seen <= ?${repoSql} ORDER BY first_seen LIMIT 50000`,
      checks: 'SELECT c.ts, m.name AS monitor, c.ok, c.status_code, c.latency_ms, c.error FROM checks c JOIN monitors m ON m.id = c.monitor_id WHERE c.ts >= ? AND c.ts <= ? ORDER BY c.id LIMIT 100000',
    };
    const rows = db.prepare(sql[q.dataset]).all(from, to) as Record<string, unknown>[];
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    // Prefix cells that spreadsheets would evaluate as formulas (CSV injection).
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    logAudit(ctx, req, 'analytics.exported', q.dataset, `${rows.length} rows`);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="sentinelops-${q.dataset}-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"`).send(csv);
  });

  app.get('/api/events', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), type: z.string().max(50).optional() }).parse(req.query);
    return { events: q.type ? db.prepare("SELECT * FROM events WHERE type LIKE ? || '%' ORDER BY id DESC LIMIT ?").all(q.type, q.limit) : ctx.bus.recent(q.limit) };
  });

  /** Server-Sent Events: one long-lived connection per tab replaces polling. */
  app.get('/api/events/stream', async (req, reply) => {
    const userId = req.session!.user.id;
    const mine = sseClients.get(userId) ?? 0;
    if (mine >= MAX_SSE_PER_USER || sseTotal >= MAX_SSE_TOTAL) return reply.code(429).send({ error: 'too_many_streams', message: 'Too many live connections.' });
    sseClients.set(userId, mine + 1);
    sseTotal++;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsubscribe = ctx.bus.subscribe((e) => send('activity', e), (topic) => send('invalidate', { topic }));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    const tokenHash = req.session!.tokenHash;
    // Close the stream if the session is revoked (logout, password change).
    const sessionCheck = setInterval(() => {
      if (!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(tokenHash)) res.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      unsubscribe();
      sseClients.set(userId, (sseClients.get(userId) ?? 1) - 1);
      sseTotal--;
    });
  });

  app.get('/api/settings', async () => ({
    github: {
      tokenSource: await ctx.gh.tokenSource(),
      useGhCli: getSetting(db, 'github.use_gh_cli') === 'true',
      envTokenConfigured: !!ctx.config.githubToken,
      rateLimit: ctx.gh.rateLimit,
    },
    gatekeeper: { allowComments: getSetting(db, 'gatekeeper.allow_comments') === 'true' },
    ai: { provider: null, status: 'not_configured', note: 'Deterministic diagnostics are active. No repository data is sent to any AI provider.' },
    dataDir: ctx.config.dataDir,
    secureCookies: ctx.config.secureCookies,
  }));

  app.put('/api/settings', async (req) => {
    const body = z.object({ useGhCli: z.boolean().optional(), allowPrComments: z.boolean().optional() }).parse(req.body);
    if (body.useGhCli !== undefined) setSetting(db, 'github.use_gh_cli', String(body.useGhCli));
    if (body.allowPrComments !== undefined) setSetting(db, 'gatekeeper.allow_comments', String(body.allowPrComments));
    logAudit(ctx, req, 'settings.updated', null, JSON.stringify(body));
    return { ok: true };
  });

  app.get('/api/system', async () => ({
    version: ctx.version,
    startedAt: ctx.startedAt,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    scanners: await detectScanners(),
    db: db.prepare("SELECT (SELECT COUNT(*) FROM checks) AS checks, (SELECT COUNT(*) FROM workflow_runs) AS runs, (SELECT COUNT(*) FROM findings) AS findings, (SELECT COUNT(*) FROM events) AS events").get(),
  }));

  app.get('/api/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const like = `%${q}%`;
    return {
      repositories: db.prepare('SELECT id, full_name AS title FROM repositories WHERE full_name LIKE ? LIMIT 8').all(like),
      incidents: db.prepare('SELECT id, title, status, severity FROM incidents WHERE title LIKE ? ORDER BY id DESC LIMIT 8').all(like),
      findings: db.prepare("SELECT id, title, severity, repo_id FROM findings WHERE status = 'open' AND (title LIKE ? OR rule_id LIKE ? OR file LIKE ?) LIMIT 8").all(like, like, like),
      runs: db.prepare('SELECT id, workflow_name AS title, conclusion, branch FROM workflow_runs WHERE workflow_name LIKE ? OR commit_message LIKE ? OR head_sha LIKE ? ORDER BY created_at DESC LIMIT 8').all(like, like, `${q}%`),
      monitors: db.prepare('SELECT id, name AS title, url FROM monitors WHERE name LIKE ? OR url LIKE ? LIMIT 8').all(like, like),
    };
  });

}
