import { now, type DB } from './db.ts';

/**
 * System Health Pulse. Formula and weights are documented in docs/HEALTH-SCORE.md —
 * keep both in sync. Components without data are excluded (not assumed healthy) and the
 * remaining weights are re-normalised; `coverage` reports how much weight had data.
 */
export const WEIGHTS = { ci: 25, security: 25, incidents: 20, availability: 20, latency: 10 } as const;
export type ComponentKey = keyof typeof WEIGHTS;

export interface HealthComponent {
  key: ComponentKey;
  label: string;
  weight: number;
  score: number | null;
  value: string;
  basis: string;
}

export interface HealthResult {
  score: number | null;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  coverage: number;
  partial: boolean;
  components: HealthComponent[];
  calculatedAt: string;
  dataFreshness: { latestRun: string | null; latestCheck: string | null; latestAnalysis: string | null };
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function computeHealth(db: DB, opts: { repoId?: number } = {}): HealthResult {
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const repoFilter = opts.repoId ? ' AND repo_id = ' + Number(opts.repoId) : '';
  const components: HealthComponent[] = [];

  // CI success rate (30d)
  const ci = db.prepare(`SELECT SUM(conclusion = 'success') AS ok, SUM(conclusion IN ('failure','timed_out','startup_failure')) AS bad
    FROM workflow_runs WHERE status = 'completed' AND created_at >= ?${repoFilter}`).get(since30d) as { ok: number | null; bad: number | null };
  const ciTotal = (ci.ok ?? 0) + (ci.bad ?? 0);
  components.push({
    key: 'ci', label: 'CI success rate', weight: WEIGHTS.ci,
    score: ciTotal >= 3 ? clamp(((ci.ok ?? 0) / ciTotal) * 100) : null,
    value: ciTotal ? `${(((ci.ok ?? 0) / ciTotal) * 100).toFixed(1)}% of ${ciTotal} runs` : 'No runs',
    basis: 'Successful ÷ (successful + failed) completed workflow runs, last 30 days. Cancelled/skipped excluded. Needs ≥3 runs.',
  });

  // Security posture
  const analysed = (db.prepare(`SELECT COUNT(*) AS n FROM repositories WHERE last_analysis_status = 'completed'${opts.repoId ? ' AND id = ' + Number(opts.repoId) : ''}`).get() as { n: number }).n;
  const sev = Object.fromEntries((db.prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open'${repoFilter} GROUP BY severity`).all() as { severity: string; n: number }[]).map((r) => [r.severity, r.n])) as Record<string, number>;
  const secPenalty = (sev.critical ?? 0) * 25 + (sev.high ?? 0) * 10 + (sev.medium ?? 0) * 3 + (sev.low ?? 0) * 1;
  components.push({
    key: 'security', label: 'Security findings', weight: WEIGHTS.security,
    score: analysed ? clamp(100 - secPenalty) : null,
    value: analysed ? `${sev.critical ?? 0} critical · ${sev.high ?? 0} high · ${sev.medium ?? 0} medium · ${sev.low ?? 0} low` : 'No completed analysis',
    basis: '100 − (25×critical + 10×high + 3×medium + 1×low) open findings; info excluded. Floor 0.',
  });

  // Open incidents
  const hasSources = (db.prepare('SELECT (SELECT COUNT(*) FROM repositories) + (SELECT COUNT(*) FROM monitors) AS n').get() as { n: number }).n > 0;
  const inc = Object.fromEntries((db.prepare(`SELECT severity, COUNT(*) AS n FROM incidents WHERE status != 'resolved'${repoFilter} GROUP BY severity`).all() as { severity: string; n: number }[]).map((r) => [r.severity, r.n])) as Record<string, number>;
  const incOpen = Object.values(inc).reduce((a, b) => a + b, 0);
  components.push({
    key: 'incidents', label: 'Open incidents', weight: WEIGHTS.incidents,
    score: hasSources ? clamp(100 - ((inc.critical ?? 0) * 40 + (inc.high ?? 0) * 25 + (inc.medium ?? 0) * 10 + (inc.low ?? 0) * 5)) : null,
    value: hasSources ? `${incOpen} open` : 'Nothing connected',
    basis: '100 − (40×critical + 25×high + 10×medium + 5×low) unresolved incidents. Floor 0.',
  });

  // Availability & latency (24h) — monitors are global, so they are excluded from per-repo scores.
  if (!opts.repoId) {
    const av = db.prepare(`SELECT COUNT(*) AS n, SUM(c.ok) AS ok, SUM(c.ok = 1 AND c.latency_ms <= m.latency_threshold_ms) AS fast
      FROM checks c JOIN monitors m ON m.id = c.monitor_id WHERE c.ts >= ?`).get(since24h) as { n: number; ok: number | null; fast: number | null };
    const uptime = av.n ? ((av.ok ?? 0) / av.n) * 100 : null;
    components.push({
      key: 'availability', label: 'Availability (24h)', weight: WEIGHTS.availability,
      score: uptime === null ? null : clamp(((uptime - 90) / 10) * 100),
      value: uptime === null ? 'No checks' : `${uptime.toFixed(2)}% of ${av.n} checks`,
      basis: 'Successful ÷ total health checks over 24h, mapped linearly: 90% → 0, 100% → 100.',
    });
    components.push({
      key: 'latency', label: 'Response time (24h)', weight: WEIGHTS.latency,
      score: av.ok ? clamp(((av.fast ?? 0) / av.ok) * 100) : null,
      value: av.ok ? `${(((av.fast ?? 0) / av.ok) * 100).toFixed(1)}% within threshold` : 'No successful checks',
      basis: 'Share of successful checks at or below each monitor\'s latency threshold (default 1000 ms).',
    });
  }

  const known = components.filter((c) => c.score !== null);
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const knownWeight = known.reduce((a, c) => a + c.weight, 0);
  const score = knownWeight ? Math.round(known.reduce((a, c) => a + c.score! * c.weight, 0) / knownWeight) : null;
  const coverage = totalWeight ? knownWeight / totalWeight : 0;
  const status = score === null ? 'unknown' : score >= 85 ? 'healthy' : score >= 65 ? 'warning' : 'critical';

  const fresh = (sql: string) => (db.prepare(sql).get() as { t: string | null }).t;
  return {
    score, status, coverage: Math.round(coverage * 100) / 100, partial: coverage < 1, components, calculatedAt: now(),
    dataFreshness: {
      latestRun: fresh('SELECT MAX(updated_at) AS t FROM workflow_runs'),
      latestCheck: fresh('SELECT MAX(ts) AS t FROM checks'),
      latestAnalysis: fresh("SELECT MAX(finished_at) AS t FROM analyses WHERE status = 'completed'"),
    },
  };
}

/** Records at most one snapshot per 15 minutes for trend charts. */
export function snapshotHealth(db: DB): void {
  const last = db.prepare('SELECT ts FROM health_snapshots ORDER BY id DESC LIMIT 1').get() as { ts: string } | undefined;
  if (last && Date.now() - Date.parse(last.ts) < 15 * 60_000) return;
  const h = computeHealth(db);
  if (h.score === null) return;
  db.prepare('INSERT INTO health_snapshots (ts, score, coverage, components) VALUES (?, ?, ?, ?)').run(h.calculatedAt, h.score, h.coverage, JSON.stringify(h.components.map((c) => ({ key: c.key, score: c.score }))));
}
