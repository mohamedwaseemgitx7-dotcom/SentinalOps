import { useState } from 'react';
import { LineChart } from '../components/charts';
import { Icon } from '../components/icons';
import { Badge, Card, EmptyState, ErrorState, Field, LoadingBlock, Modal, Notice, Pager, SeverityBadge } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { dateTime, minutes, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState, useRouter } from '../lib/router';

interface Incident {
  id: number;
  source: 'monitor' | 'pipeline' | 'security' | 'manual';
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'acknowledged' | 'resolved';
  started_at: string;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  repo_id: number | null;
  repo_name: string | null;
  monitor_id: number | null;
  monitor_name: string | null;
  monitor_url?: string | null;
  notes: { ts: string; author: string; text: string }[];
}

const STATUS_TONE = { open: 'critical', acknowledged: 'warning', resolved: 'good' } as const;
const LIMIT = 50;

export function IncidentsTable({ repoId }: { repoId?: number }) {
  const [q, setQ] = useQueryState();
  const status = q.get('status') ?? 'active';
  const severity = q.get('severity') ?? '';
  const source = q.get('source') ?? '';
  const search = q.get('q') ?? '';
  const offset = Number(q.get('offset') ?? 0);
  const repo = repoId ?? (q.get('repo') ? Number(q.get('repo')) : undefined);
  const { data, error, loading, reload } = useResource<{ incidents: Incident[]; total: number }>(`/api/incidents${qs({ status, severity, source, search, repo, limit: LIMIT, offset })}`, ['incidents']);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="filters" role="group" aria-label="Filter incidents">
        <div className="field">
          <label htmlFor="i-status">Status</label>
          <select id="i-status" className="input" value={status} onChange={(e) => setQ({ status: e.target.value, offset: null })}>
            <option value="active">Active (open + acknowledged)</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="i-sev">Severity</label>
          <select id="i-sev" className="input" value={severity} onChange={(e) => setQ({ severity: e.target.value, offset: null })}>
            <option value="">All</option>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="i-src">Source</label>
          <select id="i-src" className="input" value={source} onChange={(e) => setQ({ source: e.target.value, offset: null })}>
            <option value="">All</option><option value="monitor">Monitoring</option><option value="pipeline">Pipelines</option><option value="security">Security</option><option value="manual">Manual</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="i-q">Search</label>
          <input id="i-q" className="input" value={search} onChange={(e) => setQ({ q: e.target.value, offset: null })} placeholder="Incident title" />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? <LoadingBlock rows={6} /> : !data?.incidents.length ? (
          <EmptyState icon="ok" title={status === 'active' ? 'No active incidents' : 'No incidents match'}>Incidents open automatically when monitors fail repeatedly, a default-branch workflow starts failing, or critical security findings appear.</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th className="hide-sm">Source</th><th className="hide-sm">Started</th><th className="num">Duration</th></tr></thead>
                <tbody>
                  {data.incidents.map((i) => (
                    <tr key={i.id}>
                      <td><Link to={`/incidents/${i.id}`} style={{ fontWeight: 600 }}>#{i.id} {i.title}</Link><div className="muted" style={{ fontSize: 12 }}>{i.repo_name ?? i.monitor_name ?? ''}</div></td>
                      <td><SeverityBadge severity={i.severity} /></td>
                      <td><Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge></td>
                      <td className="hide-sm">{i.source}</td>
                      <td className="hide-sm muted">{timeAgo(i.started_at)}</td>
                      <td className="num">{minutes((Date.parse(i.resolved_at ?? new Date().toISOString()) - Date.parse(i.started_at)) / 60000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={LIMIT} offset={offset} onChange={(o) => setQ({ offset: o ? String(o) : null })} />
          </>
        )}
      </Card>
    </div>
  );
}

export function IncidentsPage({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <div><h1>Incidents</h1><p className="sub">Detected problems, acknowledgement and verified recovery.</p></div>
        {isAdmin && <button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} /> Declare incident</button>}
      </div>
      <IncidentsTable />
      {open && <DeclareIncident onClose={() => setOpen(false)} />}
    </>
  );
}

function DeclareIncident({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('high');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { navigate } = useRouter();
  return (
    <Modal title="Declare an incident" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="decl" disabled={title.trim().length < 3}>Declare</button></>}>
      <form id="decl" className="stack" onSubmit={async (e) => { e.preventDefault(); try { const r = await api.post<{ id: number }>('/api/incidents', { title, severity, note: note || undefined }); onClose(); navigate(`/incidents/${r.id}`); } catch (er) { setErr((er as ApiError).message); } }}>
        <Field label="Title" htmlFor="d-title"><input id="d-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="Severity" htmlFor="d-sev"><select id="d-sev" className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Initial note" htmlFor="d-note"><textarea id="d-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
      </form>
    </Modal>
  );
}

export function IncidentDetailPage({ id, isAdmin }: { id: number; isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<{ incident: Incident; timeline: { ts: string; ok: number; status_code: number | null; latency_ms: number | null; error: string | null }[] }>(`/api/incidents/${id}`, ['incidents', 'monitors']);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingBlock rows={8} /></Card>;
  const i = data.incident;
  const act = async (url: string, body?: unknown) => {
    setErr(null);
    try { await api.post(url, body); reload(); } catch (e) { setErr((e as ApiError).message); }
  };
  const ttd = (Date.parse(i.detected_at) - Date.parse(i.started_at)) / 60000;
  const ttr = i.resolved_at ? (Date.parse(i.resolved_at) - Date.parse(i.started_at)) / 60000 : null;
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/incidents">Incidents</Link> /</div>
          <div className="row"><h1>#{i.id} {i.title}</h1></div>
          <div className="row" style={{ marginTop: 6 }}><SeverityBadge severity={i.severity} /><Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge><span className="muted">{i.source}</span></div>
        </div>
        {isAdmin && i.status === 'open' && <button className="btn" onClick={() => act(`/api/incidents/${id}/acknowledge`)}>Acknowledge</button>}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="grid grid-main">
        <div className="stack" style={{ gap: 16 }}>
          {data.timeline.length > 0 && (
            <Card title="Health checks around this incident" hint={i.monitor_url ?? ''}>
              <LineChart
                ariaLabel="Response time of checks during the incident"
                points={data.timeline.map((t) => ({ x: t.ts, y: t.ok ? t.latency_ms : null }))}
                gaps={data.timeline.map((t) => !t.ok)}
                yFormat={(v) => `${Math.round(v)} ms`}
                xFormat={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              />
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Red ticks mark failed checks. Errors observed: {[...new Set(data.timeline.filter((t) => !t.ok).map((t) => t.error ?? `HTTP ${t.status_code}`))].join('; ') || 'none'}</p>
            </Card>
          )}
          <Card title="Timeline & notes">
            <ul className="feed" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <li className="feed-item"><span><Icon name="warn" size={16} /></span><div><div className="msg">Problem started (first failing signal)</div><div className="time">{dateTime(i.started_at)}</div></div></li>
              <li className="feed-item"><span><Icon name="bell" size={16} /></span><div><div className="msg">Incident detected and opened</div><div className="time">{dateTime(i.detected_at)}</div></div></li>
              {i.notes.map((n, idx) => <li className="feed-item" key={idx}><span><Icon name="info" size={16} /></span><div><div className="msg">{n.text}</div><div className="time">{n.author} · {dateTime(n.ts)}</div></div></li>)}
            </ul>
            {isAdmin && (
              <form className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }} onSubmit={async (e) => { e.preventDefault(); await act(`/api/incidents/${id}/notes`, { text: note }); setNote(''); }}>
                <label htmlFor="note" className="sr-only">Add a note</label>
                <input id="note" className="input" style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (what you checked, what changed)" />
                <button className="btn" disabled={!note.trim()}>Add</button>
              </form>
            )}
          </Card>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <Card title="Measurements">
            <dl className="dl">
              <dt>Time to detect</dt><dd>{minutes(Math.round(ttd * 10) / 10)}</dd>
              <dt>Time to acknowledge</dt><dd>{i.acknowledged_at ? minutes((Date.parse(i.acknowledged_at) - Date.parse(i.detected_at)) / 60000) : '—'}</dd>
              <dt>Time to recover</dt><dd>{ttr === null ? 'Ongoing' : minutes(ttr)}</dd>
              {i.repo_name && <><dt>Repository</dt><dd><Link to={`/repositories/${i.repo_id}`}>{i.repo_name}</Link></dd></>}
              {i.monitor_name && <><dt>Monitor</dt><dd><Link to={`/monitoring/${i.monitor_id}`}>{i.monitor_name}</Link></dd></>}
            </dl>
          </Card>
          {i.status !== 'resolved' && isAdmin && (
            <Card title="Resolve">
              <form className="stack" onSubmit={(e) => (e.preventDefault(), act(`/api/incidents/${id}/resolve`, { resolution }))}>
                <label htmlFor="res" className="secondary" style={{ fontSize: 12 }}>What fixed it?</label>
                <textarea id="res" className="input" value={resolution} onChange={(e) => setResolution(e.target.value)} />
                <button className="btn btn-primary" disabled={resolution.trim().length < 3}>Mark resolved</button>
                {i.source === 'monitor' && <p className="muted" style={{ fontSize: 12 }}>Monitor incidents can only be resolved once the latest health check passes, and resolve automatically on recovery.</p>}
              </form>
            </Card>
          )}
          {i.resolution && <Card title="Resolution"><p>{i.resolution}</p></Card>}
        </div>
      </div>
    </>
  );
}
