import { useState } from 'react';
import { Badge, Card, DataSourceNote, EmptyState, ErrorState, LoadingBlock, Modal, Notice, Pager, SeverityBadge } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState } from '../lib/router';
import type { Repo } from './Repositories';

interface Finding {
  id: number;
  repo_id: number;
  repo_name: string;
  fingerprint: string;
  rule_id: string;
  source: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  file: string | null;
  line: number | null;
  package: string | null;
  evidence: string | null;
  explanation: string | null;
  remediation: string | null;
  reference: string | null;
  status: 'open' | 'resolved' | 'suppressed';
  suppression_reason: string | null;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
}

const LIMIT = 50;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function FindingsTable({ repoId, isAdmin }: { repoId?: number; isAdmin: boolean }) {
  const [q, setQ] = useQueryState();
  const repo = repoId ?? (q.get('repo') ? Number(q.get('repo')) : undefined);
  const severity = q.get('severity') ?? '';
  const status = q.get('status') ?? 'open';
  const source = q.get('source') ?? '';
  const search = q.get('q') ?? '';
  const offset = Number(q.get('offset') ?? 0);
  const repos = useResource<{ repositories: Repo[] }>(repoId ? null : '/api/repositories', ['repositories']);
  const { data, error, loading, reload } = useResource<{ findings: Finding[]; total: number; bySeverity: { severity: string; n: number }[]; sources: string[] }>(
    `/api/findings${qs({ repo, severity, status, source, search, limit: LIMIT, offset })}`,
    ['findings', 'repositories'],
  );
  const [selected, setSelected] = useState<Finding | null>(null);
  const counts = Object.fromEntries((data?.bySeverity ?? []).map((s) => [s.severity, s.n]));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
        {SEVERITIES.map((s) => (
          <button key={s} className="card kpi" style={{ cursor: 'pointer', textAlign: 'left', borderColor: severity === s ? 'var(--accent)' : undefined }} onClick={() => setQ({ severity: severity === s ? null : s, offset: null })} aria-pressed={severity === s}>
            <span className="label"><SeverityBadge severity={s} /></span>
            <span className="value">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="filters" role="group" aria-label="Filter findings">
        {!repoId && (
          <div className="field">
            <label htmlFor="s-repo">Repository</label>
            <select id="s-repo" className="input" value={repo ?? ''} onChange={(e) => setQ({ repo: e.target.value, offset: null })}>
              <option value="">All</option>
              {repos.data?.repositories.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="s-status">Status</label>
          <select id="s-status" className="input" value={status} onChange={(e) => setQ({ status: e.target.value, offset: null })}>
            <option value="open">Open</option><option value="resolved">Resolved</option><option value="suppressed">Suppressed</option><option value="all">All</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="s-source">Source</label>
          <select id="s-source" className="input" value={source} onChange={(e) => setQ({ source: e.target.value, offset: null })}>
            <option value="">All sources</option>
            {data?.sources.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="s-q">Search</label>
          <input id="s-q" className="input" value={search} onChange={(e) => setQ({ q: e.target.value, offset: null })} placeholder="Rule, title or file" />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? <LoadingBlock rows={8} /> : !data?.findings.length ? (
          <EmptyState icon="shield" title={status === 'open' && !severity && !search ? 'No open findings' : 'No findings match'}>
            {status === 'open' && !severity && !search ? 'Either nothing was found by the checks that ran, or no repository has been analysed yet. Check each repository’s “Checks that ran” list for coverage.' : 'Try different filters.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Severity</th><th>Finding</th>{!repoId && <th className="hide-sm">Repository</th>}<th className="hide-sm">Location</th><th className="hide-sm">Source</th><th>Status</th></tr></thead>
                <tbody>
                  {data.findings.map((f) => (
                    <tr key={f.id}>
                      <td><SeverityBadge severity={f.severity} /></td>
                      <td><button className="link-btn" style={{ fontSize: 13, textAlign: 'left' }} onClick={() => setSelected(f)}>{f.title}</button><div className="muted mono" style={{ fontSize: 11.5 }}>{f.rule_id}</div></td>
                      {!repoId && <td className="hide-sm"><Link to={`/repositories/${f.repo_id}?tab=security`}>{f.repo_name}</Link></td>}
                      <td className="hide-sm mono truncate" style={{ maxWidth: 220 }} title={f.file ?? ''}>{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—'}</td>
                      <td className="hide-sm">{f.source}</td>
                      <td><Badge tone={f.status === 'open' ? 'warning' : f.status === 'resolved' ? 'good' : 'unknown'}>{f.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={LIMIT} offset={offset} onChange={(o) => setQ({ offset: o ? String(o) : null })} />
          </>
        )}
        <DataSourceNote>Findings come only from the checks listed on each repository. Secret values are redacted and never stored. “Resolved” means the check ran again and no longer reports it.</DataSourceNote>
      </Card>
      {selected && <FindingModal finding={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} onChanged={() => (setSelected(null), reload())} />}
    </div>
  );
}

function FindingModal({ finding: f, isAdmin, onClose, onChanged }: { finding: Finding; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const act = async (url: string, body?: unknown) => {
    try {
      await api.post(url, body);
      onChanged();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  return (
    <Modal title={f.title} onClose={onClose} wide>
      <div className="row"><SeverityBadge severity={f.severity} /><Badge tone="unknown" icon={false}>{f.source}</Badge><span className="mono muted">{f.rule_id}</span></div>
      <dl className="dl">
        <dt>Repository</dt><dd>{f.repo_name}</dd>
        <dt>Location</dt><dd className="mono">{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—'}</dd>
        {f.package && <><dt>Package</dt><dd className="mono">{f.package}</dd></>}
        <dt>First seen</dt><dd>{dateTime(f.first_seen)}</dd>
        <dt>Last seen</dt><dd>{timeAgo(f.last_seen)}</dd>
        <dt>Status</dt><dd>{f.status}{f.resolved_at ? ` (verified resolved ${dateTime(f.resolved_at)})` : ''}</dd>
        {f.suppression_reason && <><dt>Suppression</dt><dd>{f.suppression_reason}</dd></>}
      </dl>
      {f.evidence && <div><div className="secondary" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Evidence (redacted)</div><pre className="log" style={{ padding: 12, whiteSpace: 'pre-wrap' }}>{f.evidence}</pre></div>}
      {f.explanation && <div><div className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Why it matters</div><p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{f.explanation}</p></div>}
      {f.remediation && <div><div className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Recommended remediation</div><p style={{ marginTop: 4 }}>{f.remediation}</p></div>}
      {f.reference && <a href={f.reference} target="_blank" rel="noreferrer noopener">Reference ↗</a>}
      {f.rule_id.startsWith('SEC-') && <Notice tone="warn">If this is a real credential, rotate it with the issuer first — removing it from the code does not revoke it.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {isAdmin && f.status === 'open' && (
        <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <label htmlFor="sup-reason" className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Suppress with justification</label>
          <textarea id="sup-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Test fixture only — not a real credential; covered by issue #123" />
          <div><button className="btn" disabled={reason.trim().length < 10} onClick={() => act(`/api/findings/${f.id}/suppress`, { reason })}>Suppress finding</button></div>
          <DataSourceNote>Suppressions are recorded in the audit log with your name and date.</DataSourceNote>
        </div>
      )}
      {isAdmin && f.status === 'suppressed' && <div><button className="btn" onClick={() => act(`/api/findings/${f.id}/unsuppress`)}>Re-open finding</button></div>}
    </Modal>
  );
}

export function SecurityPage({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Security Intelligence</h1>
          <p className="sub">Secrets, dependency advisories, CI/CD, container and IaC configuration findings.</p>
        </div>
      </div>
      <FindingsTable isAdmin={isAdmin} />
    </>
  );
}
