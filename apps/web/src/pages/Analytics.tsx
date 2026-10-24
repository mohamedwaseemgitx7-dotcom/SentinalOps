import { HBars, LineChart, StackedBars } from '../components/charts';
import { Icon } from '../components/icons';
import { Card, DataSourceNote, ErrorState, LoadingBlock } from '../components/ui';
import { qs } from '../lib/api';
import { duration, minutes, ms, pct } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState } from '../lib/router';
import type { Repo } from './Repositories';

interface Analytics {
  range: { from: string; to: string };
  ci: { total: number; success: number; failed: number; successRate: number | null; avgDurationS: number | null; p95DurationS: number | null; daily: { date: string; success: number; failed: number; other: number; successRate: number | null; avgDurationS: number | null }[]; failureCategories: { category: string; n: number }[]; fixVerification: { diagnosed: number; verified: number; rate: number | null } };
  delivery: { definition: string; deployments: number; perWeek: number | null; changeFailureRatePct: number | null };
  incidents: { total: number; open: number; resolved: number; mttrMinutes: number | null; mttdMinutes: number | null; mttdNote: string; bySource: Record<string, number>; bySeverity: Record<string, number>; repeated: { title: string; count: number }[] };
  security: { openBySeverity: { severity: string; n: number }[]; opened: { date: string; severity: string; n: number }[]; resolved: { date: string; n: number }[] };
  availability: { id: number; name: string; checks: number; availabilityPct: number | null; avg_latency: number | null; p95LatencyMs: number | null }[];
  repositories: { id: number; full_name: string; ok: number; failed: number; successRate: number | null; critical_high: number; open_incidents: number }[];
  loadTests: { id: number; target: string; started_at: string; status: string; result: { rps: number; latencyMs: { p95: number }; errorRatePct: number } | null }[];
  healthTrend: { ts: string; score: number; coverage: number }[];
}

const RANGES = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
];

export function AnalyticsPage() {
  const [q, setQ] = useQueryState();
  const days = q.get('days') ?? '30';
  const repo = q.get('repo') ?? '';
  const from = new Date(Date.now() - Number(days) * 86_400_000);
  from.setUTCHours(0, 0, 0, 0);
  const params = { from: from.toISOString(), repo: repo || undefined };
  const repos = useResource<{ repositories: Repo[] }>('/api/repositories', ['repositories']);
  const { data, error, loading, reload } = useResource<Analytics>(`/api/analytics${qs(params)}`, ['pipelines', 'incidents', 'findings', 'monitors', 'loadtests']);
  const exportUrl = (dataset: string) => `/api/analytics/export.csv${qs({ ...params, dataset })}`;
  const short = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <>
      <div className="page-head">
        <div><h1>Analytics</h1><p className="sub">Historical delivery, reliability and security measurements. Nothing here is estimated or back-filled.</p></div>
        <div className="row">
          {['runs', 'incidents', 'findings', 'checks'].map((d) => <a key={d} className="btn btn-sm" href={exportUrl(d)} download><Icon name="download" size={14} /> {d}.csv</a>)}
        </div>
      </div>
      <div className="filters" role="group" aria-label="Analytics filters">
        <div className="field">
          <span className="label">Time window</span>
          <div className="row" style={{ gap: 6 }}>{RANGES.map((r) => <button key={r.id} className={`btn btn-sm ${days === r.id ? 'btn-primary' : ''}`} aria-pressed={days === r.id} onClick={() => setQ({ days: r.id === '30' ? null : r.id })}>{r.label}</button>)}</div>
        </div>
        <div className="field">
          <label htmlFor="a-repo">Repository</label>
          <select id="a-repo" className="input" value={repo} onChange={(e) => setQ({ repo: e.target.value })}>
            <option value="">All repositories</option>
            {repos.data?.repositories.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
          </select>
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data ? <Card><LoadingBlock rows={10} /></Card> : data && (
        <>
          <div className="grid grid-4">
            <div className="card kpi"><div className="label">CI success rate</div><div className="value">{pct(data.ci.successRate)}</div><div className="meta">{data.ci.success} ok / {data.ci.failed} failed of {data.ci.total} completed</div></div>
            <div className="card kpi"><div className="label">Build duration (successful)</div><div className="value">{duration(data.ci.avgDurationS)}</div><div className="meta">p95 {duration(data.ci.p95DurationS)}</div></div>
            <div className="card kpi"><div className="label">MTTR / MTTD</div><div className="value" style={{ fontSize: 22 }}>{minutes(data.incidents.mttrMinutes)} / {minutes(data.incidents.mttdMinutes)}</div><div className="meta">{data.incidents.resolved} resolved incidents measured</div></div>
            <div className="card kpi"><div className="label">Fix verification rate</div><div className="value">{pct(data.ci.fixVerification.rate)}</div><div className="meta">{data.ci.fixVerification.verified} of {data.ci.fixVerification.diagnosed} diagnosed failures</div></div>
          </div>

          <Card title="CI runs per day" hint="Completed workflow runs by outcome (UTC days)">
            {data.ci.total ? (
              <StackedBars data={data.ci.daily} xKey="date" xFormat={short} ariaLabel="CI runs per day by outcome" series={[{ key: 'success', label: 'Succeeded', color: 'var(--series-1)' }, { key: 'failed', label: 'Failed', color: 'var(--series-2)' }, { key: 'other', label: 'Cancelled / skipped', color: 'var(--text-muted)' }]} />
            ) : <p className="muted">No completed runs in this window.</p>}
          </Card>

          <div className="grid grid-2">
            <Card title="Average build duration per day" hint="Successful runs only">
              {data.ci.daily.some((d) => d.avgDurationS !== null) ? <LineChart ariaLabel="Average build duration per day" points={data.ci.daily.map((d) => ({ x: d.date, y: d.avgDurationS }))} yFormat={(v) => duration(v)} xFormat={short} /> : <p className="muted">No data.</p>}
            </Card>
            <Card title="Most common failure categories" hint="From deterministic diagnosis of failed runs">
              {data.ci.failureCategories.length ? <HBars ariaLabel="Failure categories" rows={data.ci.failureCategories.map((c) => ({ label: c.category, value: c.n }))} /> : <p className="muted">No diagnosed failures.</p>}
            </Card>
            <Card title="Delivery (DORA-style)" hint="Heuristic — see definition">
              <dl className="dl">
                <dt>Deployments</dt><dd>{data.delivery.deployments}</dd>
                <dt>Deployment frequency</dt><dd>{data.delivery.perWeek === null ? 'No deployment runs detected' : `${data.delivery.perWeek} per week`}</dd>
                <dt>Change failure rate</dt><dd>{pct(data.delivery.changeFailureRatePct)}</dd>
              </dl>
              <DataSourceNote>{data.delivery.definition}</DataSourceNote>
            </Card>
            <Card title="Incidents" hint={`${data.incidents.total} detected in window, ${data.incidents.open} still open`}>
              <HBars ariaLabel="Incidents by source" rows={Object.entries(data.incidents.bySource).map(([k, v]) => ({ label: k, value: v }))} />
              {data.incidents.repeated.length > 0 && <><div className="divider" style={{ margin: '12px 0' }} /><div className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Repeated incidents</div><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{data.incidents.repeated.map((r) => <li key={r.title}>{r.title} — {r.count}×</li>)}</ul></>}
              <DataSourceNote>{data.incidents.mttdNote} MTTR is measured from problem start to resolution.</DataSourceNote>
            </Card>
            <Card title="Open security findings by severity">
              {data.security.openBySeverity.length ? <HBars ariaLabel="Open findings by severity" rows={['critical', 'high', 'medium', 'low', 'info'].map((s) => ({ label: s, value: data.security.openBySeverity.find((x) => x.severity === s)?.n ?? 0, tone: s === 'critical' ? 'var(--critical)' : s === 'high' ? 'var(--serious)' : s === 'medium' ? 'var(--warning)' : 'var(--text-muted)' }))} /> : <p className="muted">No analysed repositories.</p>}
              <DataSourceNote>{data.security.opened.reduce((a, b) => a + b.n, 0)} findings first seen and {data.security.resolved.reduce((a, b) => a + b.n, 0)} verified resolved in this window.</DataSourceNote>
            </Card>
            <Card title="API availability & latency">
              {data.availability.length ? (
                <div className="table-wrap"><table>
                  <thead><tr><th>Monitor</th><th className="num">Checks</th><th className="num">Availability</th><th className="num">Avg</th><th className="num">p95</th></tr></thead>
                  <tbody>{data.availability.map((m) => <tr key={m.id}><td><Link to={`/monitoring/${m.id}`}>{m.name}</Link></td><td className="num">{m.checks}</td><td className="num">{pct(m.availabilityPct, 2)}</td><td className="num">{ms(m.avg_latency)}</td><td className="num">{ms(m.p95LatencyMs)}</td></tr>)}</tbody>
                </table></div>
              ) : <p className="muted">{repo ? 'Monitors are not tied to repositories.' : 'No monitors.'}</p>}
            </Card>
          </div>

          <Card title="Repository comparison">
            {data.repositories.length ? (
              <div className="table-wrap"><table>
                <thead><tr><th>Repository</th><th className="num">CI success</th><th className="num">Runs</th><th className="num">Critical + high findings</th><th className="num">Open incidents</th></tr></thead>
                <tbody>{data.repositories.map((r) => <tr key={r.id}><td><Link to={`/repositories/${r.id}`}>{r.full_name}</Link></td><td className="num">{pct(r.successRate)}</td><td className="num">{r.ok + r.failed}</td><td className="num">{r.critical_high}</td><td className="num">{r.open_incidents}</td></tr>)}</tbody>
              </table></div>
            ) : <p className="muted">No repositories.</p>}
          </Card>

          <div className="grid grid-2">
            <Card title="Health score trend" id="health-trend" hint="Snapshots every 15 minutes while the server runs">
              {data.healthTrend.length > 1 ? <LineChart ariaLabel="Health score over time" points={data.healthTrend.map((h) => ({ x: h.ts, y: h.score }))} yFormat={(v) => `${Math.round(v)}`} xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} /> : <p className="muted">Not enough snapshots yet.</p>}
            </Card>
            <Card title="Recent performance tests">
              {data.loadTests.length ? <div className="table-wrap"><table><thead><tr><th>Test</th><th className="num">Req/s</th><th className="num">p95</th><th className="num">Errors</th></tr></thead><tbody>{data.loadTests.map((t) => <tr key={t.id}><td><Link to={`/load-tests/${t.id}`}>#{t.id}</Link> <span className="muted">{t.status}</span></td><td className="num">{t.result?.rps ?? '—'}</td><td className="num">{ms(t.result?.latencyMs.p95)}</td><td className="num">{pct(t.result?.errorRatePct, 2)}</td></tr>)}</tbody></table></div> : <p className="muted">No tests in this window.</p>}
            </Card>
          </div>

          <HealthFormula />
        </>
      )}
    </>
  );
}

function HealthFormula() {
  return (
    <Card title="How the System Health Pulse is calculated" id="health">
      <div className="table-wrap"><table>
        <thead><tr><th>Component</th><th className="num">Weight</th><th>Score (0–100)</th><th>Unknown when</th></tr></thead>
        <tbody>
          <tr><td>CI success rate</td><td className="num">25%</td><td>successful ÷ (successful + failed) completed runs, 30 days</td><td>fewer than 3 runs</td></tr>
          <tr><td>Security findings</td><td className="num">25%</td><td>100 − (25×critical + 10×high + 3×medium + 1×low) open findings</td><td>no completed analysis</td></tr>
          <tr><td>Open incidents</td><td className="num">20%</td><td>100 − (40×critical + 25×high + 10×medium + 5×low) unresolved</td><td>nothing connected</td></tr>
          <tr><td>Availability</td><td className="num">20%</td><td>24h check success mapped linearly: 90% → 0, 100% → 100</td><td>no checks in 24h</td></tr>
          <tr><td>Response time</td><td className="num">10%</td><td>share of successful checks within each monitor’s latency threshold</td><td>no successful checks</td></tr>
        </tbody>
      </table></div>
      <DataSourceNote>Unknown components are excluded and the remaining weights re-normalised; the score is labelled “partial” and shows its coverage. Below 50 % coverage no score is produced. Status: ≥ 85 healthy, ≥ 65 warning, otherwise critical. Full definition: docs/HEALTH-SCORE.md.</DataSourceNote>
    </Card>
  );
}
