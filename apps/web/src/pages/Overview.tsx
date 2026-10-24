import { useState } from 'react';
import { HealthRing, StackedBars } from '../components/charts';
import { Icon } from '../components/icons';
import { EventFeed } from '../components/Shell';
import { Badge, Card, ErrorState, LoadingBlock, Notice, Skeleton } from '../components/ui';
import { duration, pct, timeAgo } from '../lib/format';
import { useLive, useResource } from '../lib/live';
import { Link } from '../lib/router';
import { AddSourceWizard } from './Wizard';

export interface HealthComponent {
  key: string;
  label: string;
  weight: number;
  score: number | null;
  value: string;
  basis: string;
}

export interface Health {
  score: number | null;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  coverage: number;
  partial: boolean;
  components: HealthComponent[];
  calculatedAt: string;
  dataFreshness: { latestRun: string | null; latestCheck: string | null; latestAnalysis: string | null };
}

interface OverviewData {
  health: Health;
  kpis: {
    ciSuccessRate: { value: number | null; previous: number | null; runs: number; window: string };
    openIncidents: { value: number; bySeverity: Record<string, number> };
    localRisk: { level: string; critical: number; high: number; medium: number; low: number; analysedRepos: number };
    avgBuildTime: { valueS: number | null; previousS: number | null; p95S: number | null; runs: number; window: string };
  };
  pipelineDaily: { date: string; success: number; failed: number; other: number; successRate: number | null }[];
  counts: { repos: number; monitors: number; monitors_down: number; runs: number };
}

function Delta({ now, prev, unit, lowerIsBetter }: { now: number | null; prev: number | null; unit: string; lowerIsBetter?: boolean }) {
  if (now === null || prev === null) return <span>No previous period to compare</span>;
  const d = now - prev;
  if (Math.abs(d) < 0.05) return <span>No change vs previous 30 days</span>;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return (
    <span className={good ? 'delta-up' : 'delta-down'}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(unit === '%' ? 1 : 0)}{unit} vs previous 30 days
    </span>
  );
}

export function HealthPanel({ health }: { health: Health }) {
  return (
    <div className="ring-wrap">
      <HealthRing score={health.score} status={health.status} partial={health.partial} coverage={health.coverage} />
      {health.partial && health.score !== null && (
        <Badge tone="warning">Partial — {Math.round(health.coverage * 100)}% of inputs have data</Badge>
      )}
      <div className="components">
        {health.components.map((c) => (
          <div className="comp" key={c.key} title={c.basis}>
            <span className="secondary">{c.label} <span className="muted">· {c.weight}%</span></span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{c.score === null ? <span className="muted">unknown</span> : Math.round(c.score)}</span>
            <div className="bar" aria-hidden="true"><span style={{ width: `${c.score ?? 0}%`, background: c.score === null ? 'transparent' : c.score >= 85 ? 'var(--good)' : c.score >= 65 ? 'var(--warning)' : 'var(--critical)' }} /></div>
            <span className="muted" style={{ gridColumn: '1 / -1', fontSize: 11.5 }}>{c.value}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 11.5, textAlign: 'center' }}>
        Calculated {timeAgo(health.calculatedAt)} from measured inputs only. <Link to="/analytics#health">Formula</Link>
      </p>
    </div>
  );
}

export function OverviewPage({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<OverviewData>('/api/overview', ['overview']);
  const { events, connected } = useLive();
  const [wizard, setWizard] = useState(false);

  const risk = data?.kpis.localRisk;
  const riskTone = risk?.level === 'critical' ? 'critical' : risk?.level === 'high' ? 'high' : risk?.level === 'medium' ? 'medium' : risk?.level === 'low' ? 'good' : 'unknown';
  const empty = data && data.counts.repos === 0 && data.counts.monitors === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row">
            <h1>Engineering Overview</h1>
            <span className={`live ${connected ? '' : 'off'}`} aria-live="polite"><span className="pulse" />{connected ? 'Live' : 'Offline'}</span>
          </div>
          <p className="sub">Health, delivery and risk across your connected repositories and services.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setWizard(true)}>
            <Icon name="plus" size={16} /> Analyze something
          </button>
        )}
      </div>

      {error && <ErrorState error={error} onRetry={reload} />}
      {empty && (
        <Notice tone="info">
          Nothing is connected yet, so every metric below shows as unknown rather than a made-up value. {isAdmin ? 'Use “Analyze something” to connect a GitHub repository, a local folder or a website.' : 'Ask an administrator to connect a data source.'}
        </Notice>
      )}

      <div className="grid grid-hero">
        <Card title="System Health Pulse" hint="Weighted score of measured inputs" id="health">
          {loading && !data ? <Skeleton height={320} /> : data && <HealthPanel health={data.health} />}
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            {!data ? (
              Array.from({ length: 4 }, (_, i) => <div key={i} className="card"><LoadingBlock rows={3} /></div>)
            ) : (
              <>
                <div className="card kpi">
                  <div className="label"><Icon name="pipeline" size={15} />CI Success Rate</div>
                  <div className="value">{pct(data.kpis.ciSuccessRate.value)}</div>
                  <div className="meta">{data.kpis.ciSuccessRate.runs ? <Delta now={data.kpis.ciSuccessRate.value} prev={data.kpis.ciSuccessRate.previous} unit="%" /> : 'No completed workflow runs in 30 days'}</div>
                  <Link to="/pipelines" className="drill" style={{ fontSize: 12 }}>{data.kpis.ciSuccessRate.runs} runs · view pipelines →</Link>
                </div>
                <div className="card kpi">
                  <div className="label"><Icon name="alert" size={15} />Open Incidents</div>
                  <div className="value">{data.kpis.openIncidents.value}</div>
                  <div className="meta row" style={{ gap: 6 }}>
                    {(['critical', 'high', 'medium', 'low'] as const).filter((s) => data.kpis.openIncidents.bySeverity[s]).map((s) => <Badge key={s} tone={s}>{data.kpis.openIncidents.bySeverity[s]} {s}</Badge>)}
                    {data.kpis.openIncidents.value === 0 && 'None active'}
                  </div>
                  <Link to="/incidents" style={{ fontSize: 12 }}>View incidents →</Link>
                </div>
                <div className="card kpi">
                  <div className="label"><Icon name="shield" size={15} />Local Risk</div>
                  <div className="value" style={{ textTransform: 'capitalize' }}><Badge tone={riskTone}>{risk!.level}</Badge></div>
                  <div className="meta">{risk!.analysedRepos ? `${risk!.critical} critical · ${risk!.high} high · ${risk!.medium} medium open findings` : 'No repository analysed yet'}</div>
                  <Link to="/security" style={{ fontSize: 12 }}>View findings →</Link>
                </div>
                <div className="card kpi">
                  <div className="label"><Icon name="bolt" size={15} />Avg Build Time</div>
                  <div className="value">{duration(data.kpis.avgBuildTime.valueS)}</div>
                  <div className="meta">{data.kpis.avgBuildTime.runs ? <>p95 {duration(data.kpis.avgBuildTime.p95S)} · <Delta now={data.kpis.avgBuildTime.valueS} prev={data.kpis.avgBuildTime.previousS} unit="s" lowerIsBetter /></> : 'No successful runs in 30 days'}</div>
                  <Link to="/analytics" style={{ fontSize: 12 }}>Build analytics →</Link>
                </div>
              </>
            )}
          </div>

          <Card title="CI Pipeline Health" hint="Completed workflow runs per day, last 14 days" actions={<Link to="/pipelines?conclusion=failed" className="btn btn-sm">Failed runs</Link>}>
            {!data ? (
              <Skeleton height={220} />
            ) : data.pipelineDaily.some((d) => d.success + d.failed + d.other > 0) ? (
              <StackedBars
                data={data.pipelineDaily}
                xKey="date"
                xFormat={(v) => new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                series={[
                  { key: 'success', label: 'Succeeded', color: 'var(--series-1)' },
                  { key: 'failed', label: 'Failed', color: 'var(--series-2)' },
                  { key: 'other', label: 'Cancelled / skipped', color: 'var(--text-muted)' },
                ]}
                ariaLabel="Workflow runs per day by outcome"
              />
            ) : (
              <p className="muted" style={{ padding: '40px 0', textAlign: 'center' }}>No workflow runs recorded in the last 14 days. Connect a GitHub repository with Actions to populate this chart.</p>
            )}
          </Card>
        </div>
      </div>

      <div className="grid grid-main">
        <Card title="Data sources" hint="What the numbers above are built from">
          {!data ? <LoadingBlock /> : (
            <div className="grid grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <div className="stack" style={{ gap: 4 }}>
                <span className="secondary">Repositories</span>
                <strong style={{ fontSize: 20 }}>{data.counts.repos}</strong>
                <span className="muted" style={{ fontSize: 12 }}>Last analysis {timeAgo(data.health.dataFreshness.latestAnalysis)}</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <span className="secondary">Workflow runs stored</span>
                <strong style={{ fontSize: 20 }}>{data.counts.runs.toLocaleString()}</strong>
                <span className="muted" style={{ fontSize: 12 }}>Latest update {timeAgo(data.health.dataFreshness.latestRun)}</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <span className="secondary">Monitors</span>
                <strong style={{ fontSize: 20 }}>{data.counts.monitors} {data.counts.monitors_down > 0 && <Badge tone="critical">{data.counts.monitors_down} down</Badge>}</strong>
                <span className="muted" style={{ fontSize: 12 }}>Last check {timeAgo(data.health.dataFreshness.latestCheck)}</span>
              </div>
            </div>
          )}
        </Card>
        <Card title="Live Activity" hint="Streamed from the server — no polling" actions={<Link to="/settings#audit" style={{ fontSize: 12 }}>Audit log</Link>}>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <EventFeed events={events} limit={20} />
          </div>
        </Card>
      </div>
      {wizard && <AddSourceWizard onClose={() => setWizard(false)} />}
    </>
  );
}
