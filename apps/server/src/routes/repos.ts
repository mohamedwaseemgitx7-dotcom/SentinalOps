import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { latestArchitecture, type RepoRow } from '../analysis/analyzer.ts';
import { evaluatePullRequest, gateMarkdown } from '../analysis/gatekeeper.ts';
import { logAudit, type AppContext } from '../context.ts';
import { getSetting, now, parseJson } from '../db.ts';
import { parseRepoRef } from '../github/client.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

function serializeRepo(r: Record<string, unknown>) {
  return { ...r, languages: parseJson(r.languages as string, {}), frameworks: parseJson(r.frameworks as string, []), latest_commit: parseJson(r.latest_commit as string, null), is_private: r.is_private === null ? null : !!r.is_private };
}

export function repoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const getRepo = (id: number): RepoRow & Record<string, unknown> => {
    const r = db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as (RepoRow & Record<string, unknown>) | undefined;
    if (!r) throw notFound('Repository not found');
    return r;
  };

  app.get('/api/repositories', async (req) => {
    const q = z.object({ search: z.string().max(100).optional() }).parse(req.query);
    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM findings f WHERE f.repo_id = r.id AND f.status = 'open' AND f.severity = 'critical') AS critical_findings,
        (SELECT COUNT(*) FROM findings f WHERE f.repo_id = r.id AND f.status = 'open' AND f.severity = 'high') AS high_findings,
        (SELECT COUNT(*) FROM findings f WHERE f.repo_id = r.id AND f.status = 'open') AS open_findings,
        (SELECT COUNT(*) FROM incidents i WHERE i.repo_id = r.id AND i.status != 'resolved') AS open_incidents,
        (SELECT json_object('id', w.id, 'conclusion', w.conclusion, 'status', w.status, 'workflow', w.workflow_name, 'created_at', w.created_at, 'url', w.html_url)
           FROM workflow_runs w WHERE w.repo_id = r.id ORDER BY w.created_at DESC LIMIT 1) AS latest_run,
        (SELECT json_object('id', w.id, 'conclusion', w.conclusion, 'workflow', w.workflow_name, 'created_at', w.created_at)
           FROM workflow_runs w WHERE w.repo_id = r.id AND (w.workflow_name LIKE '%deploy%' OR w.workflow_name LIKE '%release%' OR w.event = 'deployment')
           ORDER BY w.created_at DESC LIMIT 1) AS latest_deploy
      FROM repositories r
      WHERE (? IS NULL OR r.full_name LIKE '%' || ? || '%')
      ORDER BY r.full_name LIMIT 200`).all(q.search ?? null, q.search ?? null) as Record<string, unknown>[];
    return {
      repositories: rows.map((r) => ({ ...serializeRepo(r), latest_run: parseJson(r.latest_run as string, null), latest_deploy: parseJson(r.latest_deploy as string, null), analyzing: ctx.analyzer.isRunning(r.id as number) })),
    };
  });

  app.post('/api/repositories', async (req) => {
    const body = z
      .object({
        kind: z.enum(['github', 'local']),
        ref: z.string().trim().min(1).max(500),
        analyze: z.boolean().default(true),
        dependencyAdvisories: z.boolean().default(true),
      })
      .parse(req.body);
    let fullName: string;
    let localPath: string | null = null;
    let url: string | null = null;
    if (body.kind === 'github') {
      const ref = parseRepoRef(body.ref);
      if (!ref) throw badRequest('Use owner/name or https://github.com/owner/name');
      // Confirms the repository exists and that our credentials can read it.
      const info = await ctx.gh.json<{ full_name: string; html_url: string; default_branch: string; private: boolean; description: string | null }>(`/repos/${ref.owner}/${ref.repo}`);
      fullName = info.full_name;
      url = info.html_url;
    } else {
      localPath = path.resolve(body.ref);
      const st = fs.statSync(localPath, { throwIfNoEntry: false });
      if (!st?.isDirectory()) throw badRequest('That path is not a directory on this machine.');
      fullName = `local:${path.basename(localPath)}`;
      const clash = db.prepare("SELECT local_path FROM repositories WHERE kind = 'local' AND full_name = ?").get(fullName) as { local_path: string } | undefined;
      if (clash && clash.local_path !== localPath) fullName = `local:${path.basename(path.dirname(localPath))}/${path.basename(localPath)}`;
    }
    const exists = db.prepare('SELECT id FROM repositories WHERE kind = ? AND full_name = ?').get(body.kind, fullName) as { id: number } | undefined;
    if (exists) throw conflict(`${fullName} is already connected.`);
    const info = db.prepare('INSERT INTO repositories (kind, full_name, url, local_path, created_at) VALUES (?, ?, ?, ?, ?)').run(body.kind, fullName, url, localPath, now());
    const id = Number(info.lastInsertRowid);
    logAudit(ctx, req, 'repositories.connected', fullName);
    ctx.bus.publish('repository.connected', 'info', `Connected ${fullName}`, `/repositories/${id}`);
    let analysisId: number | null = null;
    if (body.analyze) analysisId = ctx.analyzer.start(getRepo(id), { dependencyAdvisories: body.dependencyAdvisories });
    if (body.kind === 'github') void ctx.pipelines.sync({ id, full_name: fullName }).catch((err: Error) => ctx.bus.publish('pipeline.sync_failed', 'warning', `Workflow sync for ${fullName} failed: ${err.message.slice(0, 160)}`));
    return { id, analysisId };
  });

  app.get('/api/repositories/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const repo = getRepo(id);
    const analyses = db.prepare('SELECT id, started_at, finished_at, status, error FROM analyses WHERE repo_id = ? ORDER BY id DESC LIMIT 20').all(id);
    const latest = db.prepare("SELECT summary, checks_run FROM analyses WHERE repo_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1").get(id) as { summary: string; checks_run: string } | undefined;
    const findingCounts = db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE repo_id = ? AND status = 'open' GROUP BY severity").all(id);
    return {
      repository: { ...serializeRepo(repo), analyzing: ctx.analyzer.isRunning(id) },
      analyses,
      summary: parseJson(latest?.summary, null),
      checks: parseJson(latest?.checks_run, []),
      findingCounts,
    };
  });

  app.post('/api/repositories/:id/analyze', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ dependencyAdvisories: z.boolean().default(true) }).parse(req.body ?? {});
    const repo = getRepo(id);
    logAudit(ctx, req, 'repositories.analyze', repo.full_name);
    return { analysisId: ctx.analyzer.start(repo, body) };
  });

  app.delete('/api/repositories/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const repo = getRepo(id);
    if (ctx.analyzer.isRunning(id)) throw conflict('Wait for the running analysis to finish.');
    db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
    logAudit(ctx, req, 'repositories.removed', repo.full_name);
    ctx.bus.publish('repository.removed', 'info', `Disconnected ${repo.full_name} (stored metadata deleted)`);
    return { ok: true };
  });

  app.get('/api/repositories/:id/architecture', async (req) => {
    const { id } = idParam.parse(req.params);
    getRepo(id);
    return { architecture: latestArchitecture(db, id) };
  });

  // ---------------- Pipelines ----------------
  app.post('/api/repositories/:id/pipelines/sync', async (req) => {
    const { id } = idParam.parse(req.params);
    const repo = getRepo(id);
    if (repo.kind !== 'github') throw badRequest('Pipeline sync is available for GitHub repositories.');
    return ctx.pipelines.sync(repo);
  });

  app.get('/api/pipelines/runs', async (req) => {
    const q = z
      .object({
        repo: z.coerce.number().int().optional(),
        branch: z.string().max(200).optional(),
        workflow: z.string().max(200).optional(),
        conclusion: z.string().max(30).optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where = ['1=1'];
    const args: (string | number)[] = [];
    if (q.repo) (where.push('r.repo_id = ?'), args.push(q.repo));
    if (q.branch) (where.push('r.branch = ?'), args.push(q.branch));
    if (q.workflow) (where.push('r.workflow_name = ?'), args.push(q.workflow));
    if (q.conclusion === 'failed') where.push("r.conclusion IN ('failure','timed_out','startup_failure')");
    else if (q.conclusion) (where.push('r.conclusion = ?'), args.push(q.conclusion));
    if (q.from) (where.push('r.created_at >= ?'), args.push(q.from));
    if (q.to) (where.push('r.created_at <= ?'), args.push(q.to));
    const rows = db.prepare(`
      SELECT r.*, p.full_name AS repo_name, d.category AS diagnosis_category, d.summary AS diagnosis_summary, d.verified_by_run_id
      FROM workflow_runs r JOIN repositories p ON p.id = r.repo_id LEFT JOIN run_diagnoses d ON d.run_id = r.id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs r WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
    const facets = {
      branches: (db.prepare(`SELECT DISTINCT branch FROM workflow_runs ${q.repo ? 'WHERE repo_id = ?' : ''} ORDER BY branch LIMIT 100`).all(...(q.repo ? [q.repo] : [])) as { branch: string }[]).map((r) => r.branch).filter(Boolean),
      workflows: (db.prepare(`SELECT DISTINCT workflow_name FROM workflow_runs ${q.repo ? 'WHERE repo_id = ?' : ''} ORDER BY workflow_name LIMIT 100`).all(...(q.repo ? [q.repo] : [])) as { workflow_name: string }[]).map((r) => r.workflow_name),
    };
    return { runs: rows.map((r) => ({ ...(r as object), pr_numbers: parseJson((r as { pr_numbers: string }).pr_numbers, []) })), total, facets };
  });

  app.get('/api/pipelines/runs/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const run = db.prepare('SELECT r.*, p.full_name AS repo_name FROM workflow_runs r JOIN repositories p ON p.id = r.repo_id WHERE r.id = ?').get(id) as Record<string, unknown> | undefined;
    if (!run) throw notFound('Run not found');
    const d = db.prepare('SELECT * FROM run_diagnoses WHERE run_id = ?').get(id) as Record<string, unknown> | undefined;
    const verifiedBy = d?.verified_by_run_id ? db.prepare('SELECT id, run_number, html_url, created_at FROM workflow_runs WHERE id = ?').get(d.verified_by_run_id as number) : null;
    return { run: { ...run, pr_numbers: parseJson(run.pr_numbers as string, []) }, diagnosis: d ? { ...d, evidence: parseJson(d.evidence as string, {}) } : null, verifiedBy };
  });

  app.post('/api/pipelines/runs/:id/diagnose', async (req) => {
    const { id } = idParam.parse(req.params);
    const run = db.prepare('SELECT repo_id FROM workflow_runs WHERE id = ?').get(id) as { repo_id: number } | undefined;
    if (!run) throw notFound('Run not found');
    const repo = getRepo(run.repo_id);
    const result = await ctx.pipelines.diagnoseRun(repo, id);
    ctx.pipelines.verifyFixes(repo.id);
    return result;
  });

  // ---------------- Security findings ----------------
  app.get('/api/findings', async (req) => {
    const q = z
      .object({
        repo: z.coerce.number().int().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        status: z.enum(['open', 'resolved', 'suppressed', 'all']).default('open'),
        source: z.string().max(50).optional(),
        search: z.string().max(100).optional(),
        dependency: z.enum(['1']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    // Severity facet counts ignore the severity filter itself, so build the clause twice.
    const build = (withSeverity: boolean) => {
      const where = ['1=1'];
      const args: (string | number)[] = [];
      if (q.repo) (where.push('f.repo_id = ?'), args.push(q.repo));
      if (withSeverity && q.severity) (where.push('f.severity = ?'), args.push(q.severity));
      if (q.status !== 'all') (where.push('f.status = ?'), args.push(q.status));
      if (q.source) (where.push('f.source = ?'), args.push(q.source));
      if (q.dependency) where.push("f.package IS NOT NULL AND f.source IN ('osv.dev', 'dependabot', 'trivy')");
      if (q.search) (where.push("(f.title LIKE '%' || ? || '%' OR f.file LIKE '%' || ? || '%' OR f.rule_id LIKE '%' || ? || '%')"), args.push(q.search, q.search, q.search));
      return { sql: where.join(' AND '), args };
    };
    const filtered = build(true);
    const facet = build(false);
    const order = "CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.last_seen DESC";
    const findings = db.prepare(`SELECT f.*, r.full_name AS repo_name FROM findings f JOIN repositories r ON r.id = f.repo_id WHERE ${filtered.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...filtered.args, q.limit, q.offset);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM findings f WHERE ${filtered.sql}`).get(...filtered.args) as { n: number }).n;
    const bySeverity = db.prepare(`SELECT severity, COUNT(*) AS n FROM findings f WHERE ${facet.sql} GROUP BY severity`).all(...facet.args);
    const sources = (db.prepare('SELECT DISTINCT source FROM findings ORDER BY source').all() as { source: string }[]).map((s) => s.source);
    return { findings, total, bySeverity, sources };
  });

  app.post('/api/findings/:id/suppress', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ reason: z.string().trim().min(10, 'Give a justification of at least 10 characters.').max(500) }).parse(req.body);
    const res = db.prepare("UPDATE findings SET status = 'suppressed', suppression_reason = ? WHERE id = ? AND status = 'open'").run(`${body.reason} — ${req.session!.user.username}, ${now().slice(0, 10)}`, id);
    if (!res.changes) throw notFound('Open finding not found');
    logAudit(ctx, req, 'findings.suppressed', String(id), body.reason);
    ctx.bus.invalidate('findings');
    return { ok: true };
  });

  app.post('/api/findings/:id/unsuppress', async (req) => {
    const { id } = idParam.parse(req.params);
    db.prepare("UPDATE findings SET status = 'open', suppression_reason = NULL WHERE id = ? AND status = 'suppressed'").run(id);
    logAudit(ctx, req, 'findings.unsuppressed', String(id));
    ctx.bus.invalidate('findings');
    return { ok: true };
  });

  // ---------------- PR Gatekeeper ----------------
  app.get('/api/repositories/:id/pulls', async (req) => {
    const { id } = idParam.parse(req.params);
    const repo = getRepo(id);
    if (repo.kind !== 'github') throw badRequest('PR analysis requires a GitHub repository.');
    const pulls = await ctx.gh.json<{ number: number; title: string; user: { login: string } | null; head: { ref: string }; updated_at: string; draft: boolean; html_url: string }[]>(`/repos/${repo.full_name}/pulls?state=open&per_page=30`);
    return { pulls: pulls.map((p) => ({ number: p.number, title: p.title, author: p.user?.login, branch: p.head.ref, updatedAt: p.updated_at, draft: p.draft, url: p.html_url })) };
  });

  app.post('/api/repositories/:id/pulls/:number/evaluate', async (req) => {
    const { id, number } = z.object({ id: z.coerce.number().int(), number: z.coerce.number().int().positive() }).parse(req.params);
    const repo = getRepo(id);
    if (repo.kind !== 'github') throw badRequest('PR analysis requires a GitHub repository.');
    const report = await evaluatePullRequest(ctx.gh, repo.full_name, number);
    logAudit(ctx, req, 'gatekeeper.evaluated', `${repo.full_name}#${number}`, report.overall);
    return { report, markdown: gateMarkdown(report), commentingEnabled: getSetting(db, 'gatekeeper.allow_comments') === 'true' };
  });

  app.post('/api/repositories/:id/pulls/:number/comment', async (req) => {
    const { id, number } = z.object({ id: z.coerce.number().int(), number: z.coerce.number().int().positive() }).parse(req.params);
    if (getSetting(db, 'gatekeeper.allow_comments') !== 'true') throw badRequest('Posting PR comments is disabled. Enable it in Settings → Integrations first.');
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const repo = getRepo(id);
    const report = await evaluatePullRequest(ctx.gh, repo.full_name, number);
    const comment = await ctx.gh.post<{ html_url: string }>(`/repos/${repo.full_name}/issues/${number}/comments`, { body: gateMarkdown(report) });
    logAudit(ctx, req, 'gatekeeper.comment_posted', `${repo.full_name}#${number}`, comment.html_url);
    ctx.bus.publish('gatekeeper.comment', 'info', `Posted PR Gatekeeper report to ${repo.full_name}#${number}`);
    return { url: comment.html_url };
  });

  // ---------------- Deployments (GitHub Deployments API, read-only) ----------------
  app.get('/api/repositories/:id/deployments', async (req) => {
    const { id } = idParam.parse(req.params);
    const repo = getRepo(id);
    const workflowDeploys = db.prepare(`SELECT id, workflow_name, branch, conclusion, status, created_at, duration_s, html_url FROM workflow_runs
      WHERE repo_id = ? AND (workflow_name LIKE '%deploy%' OR workflow_name LIKE '%release%' OR workflow_name LIKE '%publish%' OR event = 'deployment') ORDER BY created_at DESC LIMIT 50`).all(id);
    if (repo.kind !== 'github') return { deployments: [], workflowDeploys, source: 'unavailable' };
    const res = await ctx.gh.optional<{ id: number; environment: string; ref: string; sha: string; created_at: string; creator: { login: string } | null; statuses_url: string }[]>(`/repos/${repo.full_name}/deployments?per_page=20`);
    const deployments = await Promise.all(
      (res.data ?? []).slice(0, 20).map(async (d) => {
        const st = await ctx.gh.optional<{ state: string; created_at: string; environment_url?: string }[]>(`/repos/${repo.full_name}/deployments/${d.id}/statuses?per_page=1`);
        return { id: d.id, environment: d.environment, ref: d.ref, sha: d.sha, createdAt: d.created_at, creator: d.creator?.login, state: st.data?.[0]?.state ?? 'unknown', url: st.data?.[0]?.environment_url ?? null };
      }),
    );
    return { deployments, workflowDeploys, source: res.data ? 'github' : `unavailable (HTTP ${res.status})` };
  });
}
