import { useState } from 'react';
import { LineChart, StatusStrip } from '../components/charts';
import { Icon } from '../components/icons';
import { Badge, Card, DataSourceNote, EmptyState, ErrorState, Field, LoadingBlock, Modal, Notice, type Tone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, ms, pct, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useRouter } from '../lib/router';
import { AddSourceWizard } from './Wizard';

interface Monitor {
  id: number;
  name: string;
  url: string;
  method: string;
  interval_s: number;
  timeout_ms: number;
  expected_status: string;
  retries: number;
  failure_threshold: number;
  latency_threshold_ms: number;
  enabled: number;
  last_checked_at: string | null;
  last_ok: number | null;
  consecutive_failures: number;
  tls_valid_to: string | null;
  checks_24h?: number;
  ok_24h?: number | null;
  avg_latency_24h?: number | null;
  last_latency?: number | null;
  last_status_code?: number | null;
  last_error?: string | null;
  open_incident_id?: number | null;
  recent?: { ok: number; latency_ms: number; ts: string }[];
  conditions?: string;
  success_threshold?: number;
}

const parseConditions = (raw?: string): string[] => {
  try {
    return JSON.parse(raw ?? '[]') as string[];
  } catch {
    return [];
  }
};

function MonitorStatus({ m }: { m: Monitor }) {
  if (!m.enabled) return <Badge tone="unknown">Paused</Badge>;
  if (m.last_ok === null) return <Badge tone="unknown">Pending</Badge>;
  return m.last_ok ? <Badge tone="good">Up</Badge> : <Badge tone="critical">Down</Badge>;
}

export function MonitoringPage({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<{ monitors: Monitor[]; limits: { minIntervalS: number } }>('/api/monitors', ['monitors']);
  const scans = useResource<{ scans: { id: number; url: string; ts: string; statusCode: number | null; reachable: boolean; totalMs: number }[] }>('/api/sites/scans', []);
  const [wizard, setWizard] = useState<'monitor' | 'website' | null>(null);
  const [checking, setChecking] = useState<number | null>(null);
  return (
    <>
      <div className="page-head">
        <div><h1>Live Monitoring</h1><p className="sub">Scheduled health checks for websites and APIs you own or are authorised to check.</p></div>
        {isAdmin && (
          <div className="row">
            <button className="btn" onClick={() => setWizard('website')}><Icon name="globe" size={16} /> Scan a website</button>
            <button className="btn btn-primary" onClick={() => setWizard('monitor')}><Icon name="plus" size={16} /> Add monitor</button>
          </div>
        )}
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card title="Monitors" hint={`Minimum interval ${data?.limits.minIntervalS ?? 60}s · bounded concurrency · results kept 90 days`}>
        {loading && !data ? <LoadingBlock rows={5} /> : !data?.monitors.length ? (
          <EmptyState icon="pulse" title="No monitors yet" action={isAdmin ? <button className="btn btn-primary" onClick={() => setWizard('monitor')}>Add your first monitor</button> : undefined}>Availability and response-time history starts from the moment you add a monitor — nothing is back-filled.</EmptyState>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Monitor</th><th>Status</th><th className="hide-sm">Last 60 checks</th><th className="num">Uptime 24h</th><th className="num hide-sm">Avg latency</th><th className="hide-sm">Last check</th>{isAdmin && <th />}</tr></thead>
            <tbody>
              {data.monitors.map((m) => (
                <tr key={m.id}>
                  <td><Link to={`/monitoring/${m.id}`} style={{ fontWeight: 600 }}>{m.name}</Link><div className="muted truncate" style={{ fontSize: 12, maxWidth: 280 }}>{m.url}</div></td>
                  <td><div className="stack" style={{ gap: 3 }}><MonitorStatus m={m} />{m.open_incident_id && <Link to={`/incidents/${m.open_incident_id}`} style={{ fontSize: 12 }}>Incident #{m.open_incident_id}</Link>}</div></td>
                  <td className="hide-sm" style={{ minWidth: 180 }}><StatusStrip items={m.recent ?? []} ariaLabel={`${m.name} recent checks`} /></td>
                  <td className="num">{m.checks_24h ? pct(((m.ok_24h ?? 0) / m.checks_24h) * 100, 2) : '—'}</td>
                  <td className="num hide-sm">{ms(m.avg_latency_24h)}</td>
                  <td className="hide-sm muted">{timeAgo(m.last_checked_at)}{m.last_error ? <div style={{ color: 'var(--critical-text)', fontSize: 12 }}>{m.last_error}</div> : null}</td>
                  {isAdmin && <td><button className="btn btn-sm" disabled={checking === m.id} onClick={async () => { setChecking(m.id); try { await api.post(`/api/monitors/${m.id}/check`); } finally { setChecking(null); reload(); } }}>{checking === m.id ? 'Checking…' : 'Check now'}</button></td>}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <HeartbeatsCard isAdmin={isAdmin} />
      <Card title="Website scans" hint="One-off public checks">
        {!scans.data?.scans.length ? <p className="muted">No scans yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>URL</th><th>Result</th><th className="num">Time</th><th>When</th></tr></thead>
            <tbody>{scans.data.scans.map((s) => <tr key={s.id}><td><Link to={`/monitoring/scan/${s.id}`}>{s.url}</Link></td><td>{s.reachable ? <Badge tone={s.statusCode && s.statusCode < 400 ? 'good' : 'warning'}>HTTP {s.statusCode}</Badge> : <Badge tone="critical">Unreachable</Badge>}</td><td className="num">{ms(s.totalMs)}</td><td className="muted">{timeAgo(s.ts)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      {wizard && <AddSourceWizard initial={wizard} onClose={() => (setWizard(null), reload(), scans.reload())} />}
    </>
  );
}

export function MonitorDetailPage({ id, isAdmin }: { id: number; isAdmin: boolean }) {
  const [hours, setHours] = useState(24);
  const { data, error, loading, reload } = useResource<{ monitor: Monitor; checks: { ts: string; ok: number; status_code: number | null; latency_ms: number | null; dns_ms: number | null; error: string | null; attempts: number; manual: number; details: { display: string; success: boolean; error?: string }[] | null }[]; incidents: { id: number; title: string; status: string; started_at: string; resolved_at: string | null }[] }>(`/api/monitors/${id}?hours=${hours}`, ['monitors', 'incidents']);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const { navigate } = useRouter();
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingBlock rows={8} /></Card>;
  const m = data.monitor;
  const checks = [...data.checks].reverse();
  const ok = checks.filter((c) => c.ok);
  const lat = ok.map((c) => c.latency_ms ?? 0).sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)] : null;
  const tlsDays = m.tls_valid_to ? Math.floor((Date.parse(m.tls_valid_to) - Date.now()) / 86_400_000) : null;
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/monitoring">Monitoring</Link> /</div>
          <div className="row"><h1>{m.name}</h1><MonitorStatus m={m} /></div>
          <p className="sub mono" style={{ overflowWrap: 'anywhere' }}>{m.method} {m.url}</p>
        </div>
        {isAdmin && (
          <div className="row">
            <button className="btn" onClick={async () => { setMsg(null); try { const r = await api.post<{ ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null }>(`/api/monitors/${id}/check`); setMsg(r.ok ? `Up — HTTP ${r.statusCode} in ${r.latencyMs} ms` : `Down — ${r.error}`); reload(); } catch (e) { setMsg((e as ApiError).message); } }}><Icon name="refresh" size={15} /> Check now</button>
            <button className="btn" onClick={() => setEdit(true)}>Edit</button>
            <button className="btn btn-danger" aria-label="Delete monitor" onClick={() => setConfirmDel(true)}><Icon name="trash" size={15} /></button>
          </div>
        )}
      </div>
      {msg && <Notice tone="info">{msg}</Notice>}
      <div className="grid grid-4">
        <div className="card kpi"><div className="label">Availability</div><div className="value">{checks.length ? pct((ok.length / checks.length) * 100, 2) : '—'}</div><div className="meta">{checks.length} checks in {hours}h</div></div>
        <div className="card kpi"><div className="label">p95 response time</div><div className="value">{ms(p95)}</div><div className="meta">threshold {ms(m.latency_threshold_ms)}</div></div>
        <div className="card kpi"><div className="label">Failures in window</div><div className="value">{checks.length - ok.length}</div><div className="meta">{m.consecutive_failures} consecutive now</div></div>
        <div className="card kpi"><div className="label">TLS certificate</div><div className="value">{tlsDays === null ? '—' : `${tlsDays} d`}</div><div className="meta">{m.tls_valid_to ? `expires ${dateTime(m.tls_valid_to)}` : m.url.startsWith('https') ? 'Not checked yet' : 'Plain HTTP'}</div></div>
      </div>
      <Card title="Response time" actions={
        <div className="row" role="group" aria-label="Time window">
          {[1, 24, 168, 720].map((h) => <button key={h} className={`btn btn-sm ${hours === h ? 'btn-primary' : ''}`} onClick={() => setHours(h)} aria-pressed={hours === h}>{h === 1 ? '1h' : h === 24 ? '24h' : h === 168 ? '7d' : '30d'}</button>)}
        </div>
      }>
        {checks.length ? (
          <LineChart
            ariaLabel={`Response time for ${m.name}`}
            points={checks.map((c) => ({ x: c.ts, y: c.ok ? c.latency_ms : null }))}
            gaps={checks.map((c) => !c.ok)}
            threshold={{ value: m.latency_threshold_ms, label: `threshold ${m.latency_threshold_ms} ms` }}
            yFormat={(v) => `${Math.round(v)} ms`}
            xFormat={(v) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          />
        ) : <p className="muted">No checks in this window yet.</p>}
        <DataSourceNote>Measured from this machine: includes DNS, connection, TLS and transfer of up to 512 KB of the response. Red ticks are failed checks.</DataSourceNote>
      </Card>
      <div className="grid grid-2">
        <Card title="Recent checks">
          <div className="table-wrap" style={{ maxHeight: 360 }}><table>
            <thead><tr><th>Time</th><th>Result</th><th className="num">Latency</th><th className="num">DNS</th></tr></thead>
            <tbody>{data.checks.slice(0, 100).map((c, i) => <tr key={i}><td className="muted">{dateTime(c.ts)}{c.manual ? ' · manual' : ''}</td><td>{c.ok ? <Badge tone="good">HTTP {c.status_code}</Badge> : <Badge tone="critical">{c.error ?? `HTTP ${c.status_code}`}</Badge>}{c.attempts > 1 && <span className="muted" style={{ fontSize: 12 }}> · {c.attempts} attempts</span>}{c.details && <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11.5 }}>{c.details.map((d, j) => <li key={j} style={{ color: d.success ? 'var(--text-secondary)' : 'var(--critical-text)' }}>{d.success ? '✓' : '✗'} <span className="mono">{d.display}</span>{d.error ? ` — ${d.error}` : ''}</li>)}</ul>}</td><td className="num">{ms(c.latency_ms)}</td><td className="num">{ms(c.dns_ms)}</td></tr>)}</tbody>
          </table></div>
        </Card>
        <Card title="Configuration & incidents">
          <dl className="dl">
            <dt>Interval</dt><dd>{m.interval_s}s</dd><dt>Timeout</dt><dd>{m.timeout_ms} ms</dd><dt>Expected status</dt><dd>{m.expected_status}</dd>
            <dt>Retries</dt><dd>{m.retries}</dd><dt>Incident after</dt><dd>{m.failure_threshold} consecutive failures</dd>
            <dt>Resolve after</dt><dd>{m.success_threshold ?? 1} consecutive success(es)</dd>
            <dt>Assertions</dt><dd>{parseConditions(m.conditions).length ? <ul style={{ margin: 0, paddingLeft: 16 }} className="mono">{parseConditions(m.conditions).map((c) => <li key={c}>{c}</li>)}</ul> : 'Status code only'}</dd>
          </dl>
          <div className="divider" style={{ margin: '14px 0' }} />
          {data.incidents.length ? data.incidents.map((i) => <div key={i.id} className="spread" style={{ padding: '4px 0' }}><Link to={`/incidents/${i.id}`}>#{i.id} {i.title}</Link><Badge tone={i.status === 'resolved' ? 'good' : 'critical'}>{i.status}</Badge></div>) : <p className="muted">No incidents for this monitor.</p>}
        </Card>
      </div>
      {edit && <EditMonitor monitor={m} onClose={() => (setEdit(false), reload())} />}
      {confirmDel && (
        <Modal title="Delete monitor?" onClose={() => setConfirmDel(false)} footer={<><button className="btn" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn btn-danger" onClick={async () => { await api.del(`/api/monitors/${id}`); navigate('/monitoring'); }}>Delete</button></>}>
          <p>This stops checks for <strong>{m.name}</strong> and deletes its check history. Past incidents are kept.</p>
        </Modal>
      )}
    </>
  );
}

function EditMonitor({ monitor: m, onClose }: { monitor: Monitor; onClose: () => void }) {
  const [form, setForm] = useState({ name: m.name, url: m.url, method: m.method, intervalS: m.interval_s, timeoutMs: m.timeout_ms, expectedStatus: m.expected_status, retries: m.retries, failureThreshold: m.failure_threshold, latencyThresholdMs: m.latency_threshold_ms, enabled: !!m.enabled, successThreshold: m.success_threshold ?? 1 });
  const [conditionsText, setConditionsText] = useState(parseConditions(m.conditions).join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal title="Edit monitor" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="edit-mon">Save</button></>}>
      <form id="edit-mon" className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api.put(`/api/monitors/${m.id}`, { ...form, conditions: conditionsText.split('\n').map((l) => l.trim()).filter(Boolean) }); onClose(); } catch (er) { setErr((er as ApiError).message); } }}>
        <div className="grid grid-2">
          <Field label="Name" htmlFor="e-name"><input id="e-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="URL" htmlFor="e-url"><input id="e-url" className="input" value={form.url} onChange={(e) => set('url', e.target.value)} /></Field>
          <Field label="Interval (seconds, ≥ 60)" htmlFor="e-int"><input id="e-int" type="number" min={60} className="input" value={form.intervalS} onChange={(e) => set('intervalS', Number(e.target.value))} /></Field>
          <Field label="Timeout (ms)" htmlFor="e-to"><input id="e-to" type="number" min={1000} max={30000} className="input" value={form.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} /></Field>
          <Field label="Expected status" htmlFor="e-exp" help="e.g. 200 or 200-399"><input id="e-exp" className="input" value={form.expectedStatus} onChange={(e) => set('expectedStatus', e.target.value)} /></Field>
          <Field label="Retries before failing" htmlFor="e-ret"><input id="e-ret" type="number" min={0} max={3} className="input" value={form.retries} onChange={(e) => set('retries', Number(e.target.value))} /></Field>
          <Field label="Open incident after N failures" htmlFor="e-thr"><input id="e-thr" type="number" min={1} max={10} className="input" value={form.failureThreshold} onChange={(e) => set('failureThreshold', Number(e.target.value))} /></Field>
          <Field label="Latency threshold (ms)" htmlFor="e-lat"><input id="e-lat" type="number" min={50} className="input" value={form.latencyThresholdMs} onChange={(e) => set('latencyThresholdMs', Number(e.target.value))} /></Field>
        </div>
        <Field label="Resolve after N successful checks" htmlFor="e-succ" help="Avoids flapping incidents"><input id="e-succ" type="number" min={1} max={10} className="input" value={form.successThreshold} onChange={(e) => set('successThreshold', Number(e.target.value))} /></Field>
        <Field label="Response assertions (one per line, all must pass)" htmlFor="e-cond" help={<>Examples: <code>[BODY].status == "ok"</code> · <code>[RESPONSE_TIME] &lt; 500ms</code> · <code>len([BODY].items) &gt; 0</code> · <code>[BODY] contains "healthy"</code> · <code>[CERT_EXPIRY] &gt; 14d</code></>}>
          <textarea id="e-cond" className="input mono" rows={4} value={conditionsText} onChange={(e) => setConditionsText(e.target.value)} placeholder={'[STATUS] == 200\n[BODY].status == "ok"'} />
        </Field>
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled</label>
        {err && <Notice tone="error">{err}</Notice>}
      </form>
    </Modal>
  );
}

interface SiteCheck { id: string; label: string; level: 'pass' | 'warn' | 'fail' | 'info'; detail: string }
interface SiteReport {
  url: string; finalUrl: string; scannedAt: string; reachable: boolean; statusCode: number | null; error: string | null;
  timing: { dnsMs: number | null; ttfbMs: number | null; totalMs: number | null; bodyBytes: number };
  redirects: { status: number; location: string }[];
  dns: { a: string[]; aaaa: string[]; error: string | null };
  tls: { validTo: string; daysLeft: number; issuer: string; subject: string; protocol: string | null; authorized: boolean; altNames: string[] } | null;
  tlsError: string | null;
  headers: SiteCheck[]; cookies: SiteCheck[]; technology: { name: string; evidence: string }[]; extras: SiteCheck[]; unavailable: string[];
}

const LEVEL_TONE: Record<SiteCheck['level'], Tone> = { pass: 'good', warn: 'warning', fail: 'critical', info: 'info' };

function CheckTable({ rows }: { rows: SiteCheck[] }) {
  if (!rows.length) return <p className="muted">None</p>;
  return <div className="table-wrap"><table><tbody>{rows.map((r) => <tr key={r.id}><td style={{ width: 200 }}>{r.label}</td><td style={{ width: 90 }}><Badge tone={LEVEL_TONE[r.level]}>{r.level}</Badge></td><td className="secondary" style={{ overflowWrap: 'anywhere' }}>{r.detail}</td></tr>)}</tbody></table></div>;
}

export function SiteScanPage({ id }: { id: number }) {
  const { data, error, reload } = useResource<{ report: SiteReport }>(`/api/sites/scans/${id}`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Card><LoadingBlock rows={8} /></Card>;
  const r = data.report;
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/monitoring">Monitoring</Link> / website scan</div>
          <div className="row"><h1 style={{ overflowWrap: 'anywhere' }}>{new URL(r.url).host}</h1>{r.reachable ? <Badge tone={r.statusCode! < 400 ? 'good' : 'warning'}>HTTP {r.statusCode}</Badge> : <Badge tone="critical">Unreachable</Badge>}</div>
          <p className="sub">Scanned {dateTime(r.scannedAt)} · {r.finalUrl !== r.url ? `redirected to ${r.finalUrl}` : r.url}</p>
        </div>
      </div>
      {r.error && <Notice tone="error">Observed failure: {r.error}. The internal cause is not observable from outside the service.</Notice>}
      <div className="grid grid-4">
        <div className="card kpi"><div className="label">Total time</div><div className="value">{ms(r.timing.totalMs)}</div><div className="meta">single request from this machine</div></div>
        <div className="card kpi"><div className="label">Time to first byte</div><div className="value">{ms(r.timing.ttfbMs)}</div></div>
        <div className="card kpi"><div className="label">DNS lookup</div><div className="value">{ms(r.timing.dnsMs)}</div><div className="meta">{r.dns.a.length + r.dns.aaaa.length} address(es)</div></div>
        <div className="card kpi"><div className="label">TLS certificate</div><div className="value">{r.tls ? `${r.tls.daysLeft} d` : '—'}</div><div className="meta">{r.tls ? r.tls.issuer : r.tlsError ?? 'Not HTTPS'}</div></div>
      </div>
      <div className="grid grid-2">
        <Card title="Security headers"><CheckTable rows={r.headers} /></Card>
        <Card title="TLS, redirects & disclosure"><CheckTable rows={r.extras} /></Card>
        <Card title="Cookies set on first response"><CheckTable rows={r.cookies} /></Card>
        <Card title="Technology indicators" hint="Only what headers and markup reveal">
          {r.technology.length ? <div className="table-wrap"><table><tbody>{r.technology.map((t) => <tr key={t.name}><td>{t.name}</td><td className="muted">{t.evidence}</td></tr>)}</tbody></table></div> : <p className="muted">Nothing reliably identifiable.</p>}
        </Card>
        <Card title="Redirects & DNS">
          {r.redirects.length ? <ol style={{ margin: 0, paddingLeft: 18 }} className="mono">{r.redirects.map((x, i) => <li key={i}>{x.status} → {x.location}</li>)}</ol> : <p className="muted">No redirects.</p>}
          <div className="divider" style={{ margin: '12px 0' }} />
          <dl className="dl"><dt>A</dt><dd className="mono">{r.dns.a.join(', ') || '—'}</dd><dt>AAAA</dt><dd className="mono">{r.dns.aaaa.join(', ') || '—'}</dd>{r.tls && <><dt>Cert names</dt><dd className="mono">{r.tls.altNames.join(', ')}</dd></>}</dl>
        </Card>
        <Card title="Not available from a public URL">
          <ul style={{ margin: 0, paddingLeft: 18 }} className="secondary">{r.unavailable.map((u) => <li key={u}>{u}</li>)}</ul>
        </Card>
      </div>
    </>
  );
}

interface Heartbeat {
  id: number;
  name: string;
  token_prefix: string;
  timeout_s: number;
  grace_s: number;
  status: string;
  display_status: 'new' | 'up' | 'grace' | 'down' | 'paused';
  last_ping_at: string | null;
  last_duration_ms: number | null;
  last_event: string | null;
  down_at: string | null;
  n_pings: number;
}

const HB_TONE: Record<Heartbeat['display_status'], Tone> = { new: 'unknown', up: 'good', grace: 'warning', down: 'critical', paused: 'unknown' };

function every(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  return `${Math.round(seconds / 60)} min`;
}

/** Push monitors for cron jobs, backups and workers (they call us; we do not call them). */
function HeartbeatsCard({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useResource<{ heartbeats: Heartbeat[] }>('/api/heartbeats', ['monitors']);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ name: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const examples = shown
    ? [
        '# Linux / macOS cron: ping after a successful run',
        `0 2 * * * /usr/local/bin/backup.sh && curl -fsS -m 10 --retry 3 ${shown.url}`,
        '',
        '# Windows PowerShell (Task Scheduler)',
        `Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 ${shown.url}`,
        '',
        '# Optional: measure duration and report the exit code',
        `curl -fsS ${shown.url}/start ; ./job.sh ; curl -fsS ${shown.url}/$?`,
      ].join('\n')
    : '';
  return (
    <Card
      title="Heartbeats (cron jobs, backups, workers)"
      hint="Your job calls a secret URL when it succeeds; if no ping arrives in time, an incident opens"
      actions={isAdmin && <button className="btn btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Add heartbeat</button>}
    >
      {err && <Notice tone="error">{err}</Notice>}
      {!data ? <LoadingBlock /> : !data.heartbeats.length ? (
        <p className="muted">No heartbeats yet. Use one for anything that runs on a schedule — a nightly backup, a cron job, a queue worker.</p>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Status</th><th className="hide-sm">Expected every</th><th>Last ping</th><th className="hide-sm">Last run</th>{isAdmin && <th />}</tr></thead>
          <tbody>{data.heartbeats.map((h) => (
            <tr key={h.id}>
              <td><strong>{h.name}</strong><div className="muted mono" style={{ fontSize: 11.5 }}>/ping/{h.token_prefix}…</div></td>
              <td><Badge tone={HB_TONE[h.display_status]}>{h.display_status}</Badge>{h.display_status === 'grace' && h.down_at && <div className="muted" style={{ fontSize: 11.5 }}>down {timeAgo(h.down_at)}</div>}</td>
              <td className="hide-sm">{every(h.timeout_s)} + {every(h.grace_s)} grace</td>
              <td>{h.last_ping_at ? timeAgo(h.last_ping_at) : 'never'}{h.last_event && h.last_event !== 'success' && <div className="muted" style={{ fontSize: 11.5 }}>{h.last_event}</div>}</td>
              <td className="hide-sm">{h.last_duration_ms !== null ? ms(h.last_duration_ms) : '—'}</td>
              {isAdmin && (
                <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => act(() => api.put(`/api/heartbeats/${h.id}`, { name: h.name, timeoutS: h.timeout_s, graceS: h.grace_s, paused: h.status !== 'paused' }))}>{h.status === 'paused' ? 'Resume' : 'Pause'}</button>
                  <button className="btn btn-sm" title="Create a new secret URL (the old one stops working)" onClick={() => act(async () => { const r = await api.post<{ pingPath: string }>(`/api/heartbeats/${h.id}/rotate`); setShown({ name: h.name, url: `${window.location.origin}${r.pingPath}` }); })}>New URL</button>
                  <button className="btn btn-sm btn-danger" aria-label={`Delete ${h.name}`} onClick={() => act(() => api.del(`/api/heartbeats/${h.id}`))}><Icon name="trash" size={13} /></button>
                </div></td>
              )}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {creating && <CreateHeartbeat onClose={() => setCreating(false)} onCreated={(name, url) => (setCreating(false), setShown({ name, url }), reload())} />}
      {shown && (
        <Modal title={`Ping URL for "${shown.name}"`} onClose={() => setShown(null)} wide footer={<button className="btn btn-primary" onClick={() => setShown(null)}>Done</button>}>
          <Notice tone="warn">Copy it now — it is shown only once and stored only as a hash. Anyone with this URL can report this job as healthy.</Notice>
          <pre className="log" style={{ padding: 12, whiteSpace: 'pre-wrap', userSelect: 'all' }}>{shown.url}</pre>
          <div className="secondary" style={{ fontSize: 13 }}>Call it at the end of a successful run:</div>
          <pre className="log" style={{ padding: 12, whiteSpace: 'pre-wrap' }}>{examples}</pre>
        </Modal>
      )}
    </Card>
  );
}

function CreateHeartbeat({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, url: string) => void }) {
  const [name, setName] = useState('');
  const [timeoutS, setTimeoutS] = useState(86_400);
  const [graceS, setGraceS] = useState(3600);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Add heartbeat" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="hb-form" disabled={!name.trim()}>Create</button></>}>
      <form id="hb-form" className="stack" onSubmit={async (e) => { e.preventDefault(); try { const r = await api.post<{ pingPath: string }>('/api/heartbeats', { name, timeoutS, graceS }); onCreated(name, `${window.location.origin}${r.pingPath}`); } catch (er) { setErr((er as ApiError).message); } }}>
        <Field label="Name" htmlFor="hb-name"><input id="hb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly database backup" autoFocus /></Field>
        <div className="grid grid-2">
          <Field label="Expected every" htmlFor="hb-timeout">
            <select id="hb-timeout" className="input" value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))}>
              {[300, 900, 3600, 6 * 3600, 12 * 3600, 86_400, 7 * 86_400].map((s) => <option key={s} value={s}>{every(s)}</option>)}
            </select>
          </Field>
          <Field label="Grace period" htmlFor="hb-grace" help="Extra time before it counts as down">
            <select id="hb-grace" className="input" value={graceS} onChange={(e) => setGraceS(Number(e.target.value))}>
              {[60, 300, 900, 3600, 6 * 3600].map((s) => <option key={s} value={s}>{every(s)}</option>)}
            </select>
          </Field>
        </div>
        {err && <Notice tone="error">{err}</Notice>}
      </form>
    </Modal>
  );
}
