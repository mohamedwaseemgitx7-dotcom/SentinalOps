import { useEffect, useState, type FormEvent } from 'react';
import { HBars, LineChart } from '../components/charts';
import { Icon } from '../components/icons';
import { Badge, Card, DataSourceNote, EmptyState, ErrorState, Field, LoadingBlock, Notice, type Tone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, ms, num, pct, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useRouter } from '../lib/router';
import { AddSourceWizard } from './Wizard';

interface Result {
  stoppedReason?: string | null;
  durationS?: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRatePct: number;
  rps: number;
  latencyMs: { min: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number };
  histogram?: { le: number | null; count: number }[];
  statusCodes?: Record<string, number>;
  errors?: Record<string, number>;
  timeline?: { second: number; requests: number; errors: number; p95: number }[];
  thresholds?: { p95: { threshold: number; actual: number; pass: boolean }; errorRate: { threshold: number; actual: number; pass: boolean } };
  passed?: boolean;
  serverProcess?: { cpuPct: number; peakRssMb: number; note: string };
  imported?: boolean;
  vusMax?: number | null;
}

interface LoadTest {
  id: number;
  source: 'builtin' | 'k6-import';
  target: string;
  config: { vus?: number; durationS?: number; rampUpS?: number; method?: string; thresholds?: { p95Ms: number; errorRatePct: number } };
  status: string;
  started_at: string;
  finished_at: string | null;
  result: Result | null;
  environment: { scope?: string; runner: string; host?: string; cpus?: string; memoryGb?: number; node?: string; note?: string } | null;
  notes: string | null;
}

const STATUS_TONE: Record<string, Tone> = { passed: 'good', failed: 'critical', stopped: 'warning', running: 'accent', error: 'critical', imported: 'info' };

export function LoadTestsPage({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<{ tests: LoadTest[]; active: { id: number; progress: { elapsedS: number; requests: number; failed: number; rps: number } | null } | null; limits: { local: { maxVus: number; maxDurationS: number }; remote: { maxVus: number; maxDurationS: number } } }>('/api/load-tests', ['loadtests']);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <div><h1>Performance & Capacity</h1><p className="sub">Controlled, bounded load tests against targets you own — with measured results only.</p></div>
        {isAdmin && <button className="btn" onClick={() => setImportOpen(true)}><Icon name="upload" size={16} /> Import k6 results</button>}
      </div>
      <Notice tone="warn">
        Virtual users, requests per second and unique visitors are different measurements. A test with N virtual users does not prove a site supports N real users. Never load-test systems you do not own or have written permission to test.
      </Notice>
      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="grid grid-main">
        {isAdmin ? <NewTest limits={data?.limits} active={!!data?.active} onStarted={reload} /> : <Card title="New test"><p className="muted">Only administrators can start load tests.</p></Card>}
        <Card title="Running now">
          {data?.active ? (
            <div className="stack">
              <Badge tone="accent">Test #{data.active.id} running</Badge>
              {data.active.progress && <dl className="dl"><dt>Elapsed</dt><dd>{data.active.progress.elapsedS}s</dd><dt>Requests</dt><dd>{num(data.active.progress.requests)}</dd><dt>Failed</dt><dd>{num(data.active.progress.failed)}</dd><dt>Current rate</dt><dd>{data.active.progress.rps} req/s</dd></dl>}
              {isAdmin && <button className="btn btn-danger" onClick={() => api.post('/api/load-tests/stop').then(reload)}><Icon name="stop" size={14} /> Stop test</button>}
              <ProgressPoller onTick={reload} />
            </div>
          ) : <p className="muted">No test running.</p>}
        </Card>
      </div>
      <Card title="Test history">
        {loading && !data ? <LoadingBlock /> : !data?.tests.length ? <EmptyState icon="gauge" title="No load tests yet">Start small (e.g. 5 virtual users for 20 s against a local environment) and increase only after earlier runs pass.</EmptyState> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Test</th><th>Result</th><th className="num">VUs</th><th className="num">Req/s</th><th className="num">p95</th><th className="num">Errors</th><th className="hide-sm">When</th></tr></thead>
            <tbody>{data.tests.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/load-tests/${t.id}`} style={{ fontWeight: 600 }}>#{t.id} {safeHost(t.target)}</Link><div className="muted" style={{ fontSize: 12 }}>{t.source === 'k6-import' ? 'k6 import' : `${t.config.durationS}s, ramp ${t.config.rampUpS}s`}</div></td>
                <td><Badge tone={STATUS_TONE[t.status] ?? 'unknown'}>{t.status}</Badge></td>
                <td className="num">{t.config.vus ?? t.result?.vusMax ?? '—'}</td>
                <td className="num">{t.result ? t.result.rps : '—'}</td>
                <td className="num">{t.result ? ms(t.result.latencyMs.p95) : '—'}</td>
                <td className="num">{t.result ? pct(t.result.errorRatePct, 2) : '—'}</td>
                <td className="hide-sm muted">{timeAgo(t.started_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {importOpen && <AddSourceWizard initial="report" onClose={() => (setImportOpen(false), reload())} />}
    </>
  );
}

/** While a test runs, refresh progress every 2 s (bounded to the test's lifetime). */
function ProgressPoller({ onTick }: { onTick: () => void }) {
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => (Date.now() - started > 6 * 60_000 ? clearInterval(t) : onTick()), 2000);
    return () => clearInterval(t);
  }, [onTick]);
  return null;
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function NewTest({ limits, active, onStarted }: { limits?: { local: { maxVus: number; maxDurationS: number }; remote: { maxVus: number; maxDurationS: number } }; active: boolean; onStarted: () => void }) {
  const [form, setForm] = useState({ url: `${window.location.origin}/api/health`, vus: 5, durationS: 20, rampUpS: 5, p95Ms: 300, errorRatePct: 1, ownershipConfirmed: false, method: 'GET' as 'GET' | 'HEAD', abortErrorRatePct: 50 });
  const [err, setErr] = useState<string | null>(null);
  const { navigate } = useRouter();
  const local = (() => {
    try {
      return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(form.url).hostname);
    } catch {
      return true;
    }
  })();
  const cap = local ? limits?.local : limits?.remote;
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api.post<{ id: number }>('/api/load-tests', { url: form.url, method: form.method, vus: form.vus, durationS: form.durationS, rampUpS: form.rampUpS, abortErrorRatePct: form.abortErrorRatePct, thresholds: { p95Ms: form.p95Ms, errorRatePct: form.errorRatePct }, ownershipConfirmed: form.ownershipConfirmed });
      onStarted();
      navigate(`/load-tests/${r.id}`);
    } catch (er) {
      setErr((er as ApiError).message);
    }
  }
  return (
    <Card title="New controlled test" hint={cap ? `${local ? 'Local' : 'Remote'} target caps: ${cap.maxVus} VUs, ${cap.maxDurationS}s` : undefined}>
      <form className="stack" onSubmit={submit}>
        <Field label="Target URL" htmlFor="lt-url" help={local ? 'Local target — allowed.' : 'Remote targets must already be added as a monitor and you must confirm ownership.'}>
          <input id="lt-url" className="input" value={form.url} onChange={(e) => set('url', e.target.value)} required />
        </Field>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
          <Field label="Virtual users" htmlFor="lt-vus"><input id="lt-vus" type="number" min={1} max={cap?.maxVus} className="input" value={form.vus} onChange={(e) => set('vus', Number(e.target.value))} /></Field>
          <Field label="Duration (s)" htmlFor="lt-dur"><input id="lt-dur" type="number" min={5} max={cap?.maxDurationS} className="input" value={form.durationS} onChange={(e) => set('durationS', Number(e.target.value))} /></Field>
          <Field label="Ramp-up (s)" htmlFor="lt-ramp"><input id="lt-ramp" type="number" min={0} className="input" value={form.rampUpS} onChange={(e) => set('rampUpS', Number(e.target.value))} /></Field>
          <Field label="Pass if p95 ≤ (ms)" htmlFor="lt-p95"><input id="lt-p95" type="number" min={1} className="input" value={form.p95Ms} onChange={(e) => set('p95Ms', Number(e.target.value))} /></Field>
          <Field label="Pass if errors ≤ (%)" htmlFor="lt-err"><input id="lt-err" type="number" min={0} max={100} step="0.1" className="input" value={form.errorRatePct} onChange={(e) => set('errorRatePct', Number(e.target.value))} /></Field>
          <Field label="Abort if errors > (%)" htmlFor="lt-abort"><input id="lt-abort" type="number" min={1} max={100} className="input" value={form.abortErrorRatePct} onChange={(e) => set('abortErrorRatePct', Number(e.target.value))} /></Field>
        </div>
        {!local && <label className="check"><input type="checkbox" checked={form.ownershipConfirmed} onChange={(e) => set('ownershipConfirmed', e.target.checked)} /> I own this system or have written authorisation to load-test it. This confirmation is recorded in the audit log.</label>}
        {err && <Notice tone="error">{err}</Notice>}
        <div><button className="btn btn-primary" disabled={active}><Icon name="play" size={14} /> {active ? 'A test is running' : 'Start test'}</button></div>
      </form>
    </Card>
  );
}

export function LoadTestDetailPage({ id }: { id: number }) {
  const { data, error, reload } = useResource<{ test: LoadTest; active: { id: number } | null }>(`/api/load-tests/${id}`, ['loadtests']);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Card><LoadingBlock rows={8} /></Card>;
  const t = data.test;
  const r = t.result;
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/load-tests">Load tests</Link> /</div>
          <div className="row"><h1>Test #{t.id}</h1><Badge tone={STATUS_TONE[t.status] ?? 'unknown'}>{t.status}</Badge></div>
          <p className="sub mono" style={{ overflowWrap: 'anywhere' }}>{t.config.method ?? 'GET'} {t.target}</p>
        </div>
      </div>
      {t.status === 'running' && <><Notice tone="info">Test in progress — results appear when it finishes.</Notice><ProgressPoller onTick={reload} /></>}
      {r?.stoppedReason && <Notice tone="warn">{r.stoppedReason}</Notice>}
      {r && (
        <>
          <div className="grid grid-4">
            <div className="card kpi"><div className="label">Throughput</div><div className="value">{r.rps} <span style={{ fontSize: 14 }}>req/s</span></div><div className="meta">{num(r.totalRequests)} requests in {r.durationS ?? '—'}s</div></div>
            <div className="card kpi"><div className="label">Latency p50 / p95 / p99</div><div className="value" style={{ fontSize: 20 }}>{ms(r.latencyMs.p50)} / {ms(r.latencyMs.p95)} / {ms(r.latencyMs.p99)}</div><div className="meta">min {ms(r.latencyMs.min)} · max {ms(r.latencyMs.max)}</div></div>
            <div className="card kpi"><div className="label">Error rate</div><div className="value">{pct(r.errorRatePct, 2)}</div><div className="meta">{num(r.failedRequests)} failed · {num(r.successfulRequests)} succeeded</div></div>
            <div className="card kpi"><div className="label">Thresholds</div><div className="value">{r.passed === undefined ? '—' : r.passed ? <Badge tone="good">Passed</Badge> : <Badge tone="critical">Not met</Badge>}</div><div className="meta">{r.thresholds ? `p95 ≤ ${r.thresholds.p95.threshold} ms, errors ≤ ${r.thresholds.errorRate.threshold}%` : 'Imported result'}</div></div>
          </div>
          {r.timeline && r.timeline.length > 0 && (
            <div className="grid grid-2">
              <Card title="Requests per second"><LineChart ariaLabel="Requests per second over the test" points={r.timeline.map((p) => ({ x: `${p.second}s`, y: p.requests }))} yFormat={(v) => `${Math.round(v)}`} /></Card>
              <Card title="p95 latency per second"><LineChart ariaLabel="p95 latency per second" color="var(--series-2)" points={r.timeline.map((p) => ({ x: `${p.second}s`, y: p.requests ? p.p95 : null }))} threshold={r.thresholds ? { value: r.thresholds.p95.threshold, label: `threshold ${r.thresholds.p95.threshold} ms` } : undefined} yFormat={(v) => `${Math.round(v)} ms`} /></Card>
            </div>
          )}
          <div className="grid grid-2">
            {r.histogram && (
              <Card title="Response-time distribution">
                <HBars ariaLabel="Response time histogram" rows={r.histogram.map((h, i, arr) => ({ label: h.le === null ? `> ${arr[i - 1]?.le} ms` : `≤ ${h.le} ms`, value: h.count }))} valueFormat={(v) => v.toLocaleString()} />
              </Card>
            )}
            <Card title="Status codes & errors">
              {r.statusCodes ? <HBars ariaLabel="Status codes" rows={Object.entries(r.statusCodes).map(([k, v]) => ({ label: k, value: v, tone: k === 'error' || Number(k) >= 400 ? 'var(--critical)' : undefined }))} /> : <p className="muted">Not in imported summary.</p>}
              {r.errors && Object.keys(r.errors).length > 0 && <p className="secondary" style={{ marginTop: 10 }}>Errors: {Object.entries(r.errors).map(([k, v]) => `${k} × ${v}`).join(', ')}</p>}
            </Card>
          </div>
          <Card title="Environment & limitations">
            <dl className="dl">
              <dt>Runner</dt><dd>{t.environment?.runner}</dd>
              {t.environment?.host && <><dt>Load generator host</dt><dd>{t.environment.host} · {t.environment.cpus} · {t.environment.memoryGb} GB RAM · Node {t.environment.node}</dd></>}
              <dt>Configuration</dt><dd>{t.config.vus ? `${t.config.vus} closed-loop VUs, ${t.config.durationS}s, ramp-up ${t.config.rampUpS}s` : 'See imported summary'}</dd>
              <dt>Started</dt><dd>{dateTime(t.started_at)}</dd>
              {r.serverProcess && <><dt>SentinelOps process</dt><dd>CPU {r.serverProcess.cpuPct}% of one core · peak RSS {r.serverProcess.peakRssMb} MB <span className="muted">({r.serverProcess.note})</span></dd></>}
            </dl>
            <DataSourceNote>{t.environment?.note} Capacity estimate: this target sustained <strong>{r.rps} req/s</strong> at p95 {ms(r.latencyMs.p95)} with {pct(r.errorRatePct, 2)} errors under these conditions. It is not a statement about concurrent real users, other endpoints, or production hardware.</DataSourceNote>
          </Card>
        </>
      )}
    </>
  );
}
