import { useState } from 'react';
import { Icon } from '../components/icons';
import { Badge, Card, DataSourceNote, EmptyState, ErrorState, LoadingBlock, Notice, Pager, RunBadge } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { dateTime, duration, shortSha, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState } from '../lib/router';
import type { Repo } from './Repositories';

interface Run {
  id: number;
  repo_id: number;
  repo_name: string;
  workflow_name: string;
  branch: string | null;
  head_sha: string;
  commit_message: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  html_url: string;
  actor: string | null;
  pr_numbers: number[];
  created_at: string;
  duration_s: number | null;
  diagnosis_category: string | null;
  diagnosis_summary: string | null;
  verified_by_run_id: number | null;
}

const LIMIT = 50;

export function RunsTable({ repoId }: { repoId?: number }) {
  const [q, setQ] = useQueryState();
  const repo = repoId ?? (q.get('repo') ? Number(q.get('repo')) : undefined);
  const branch = q.get('branch') ?? '';
  const workflow = q.get('workflow') ?? '';
  const conclusion = q.get('conclusion') ?? '';
  const from = q.get('from') ?? '';
  const offset = Number(q.get('offset') ?? 0);
  const repos = useResource<{ repositories: Repo[] }>(repoId ? null : '/api/repositories', ['repositories']);
  const url = `/api/pipelines/runs${qs({ repo, branch, workflow, conclusion, from: from ? new Date(from).toISOString() : undefined, limit: LIMIT, offset })}`;
  const { data, error, loading, reload } = useResource<{ runs: Run[]; total: number; facets: { branches: string[]; workflows: string[] } }>(url, ['pipelines']);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="filters" role="group" aria-label="Filter runs">
        {!repoId && (
          <div className="field">
            <label htmlFor="f-repo">Repository</label>
            <select id="f-repo" className="input" value={repo ?? ''} onChange={(e) => setQ({ repo: e.target.value, branch: null, workflow: null, offset: null })}>
              <option value="">All repositories</option>
              {repos.data?.repositories.filter((r) => r.kind === 'github').map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="f-branch">Branch</label>
          <select id="f-branch" className="input" value={branch} onChange={(e) => setQ({ branch: e.target.value, offset: null })}>
            <option value="">All branches</option>
            {data?.facets.branches.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-wf">Workflow</label>
          <select id="f-wf" className="input" value={workflow} onChange={(e) => setQ({ workflow: e.target.value, offset: null })}>
            <option value="">All workflows</option>
            {data?.facets.workflows.map((w) => <option key={w}>{w}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-concl">Result</label>
          <select id="f-concl" className="input" value={conclusion} onChange={(e) => setQ({ conclusion: e.target.value, offset: null })}>
            <option value="">Any</option>
            <option value="failed">Failed</option>
            <option value="success">Succeeded</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-from">Since</label>
          <input id="f-from" type="date" className="input" value={from} onChange={(e) => setQ({ from: e.target.value, offset: null })} />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? <LoadingBlock rows={8} /> : !data?.runs.length ? (
          <EmptyState icon="pipeline" title="No workflow runs">
            {branch || workflow || conclusion || from ? 'No runs match these filters.' : 'Connect a GitHub repository that uses GitHub Actions, then sync its pipelines.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Run</th>{!repoId && <th className="hide-sm">Repository</th>}<th>Branch / commit</th><th>Result</th><th className="hide-sm">Diagnosis</th><th className="num">Duration</th><th className="hide-sm">Started</th></tr></thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td><Link to={`/pipelines/${r.id}`} style={{ fontWeight: 600 }}>{r.workflow_name}</Link><div className="muted" style={{ fontSize: 12 }}>#{r.run_number} · {r.event}{r.pr_numbers.length ? ` · PR #${r.pr_numbers.join(', #')}` : ''}</div></td>
                      {!repoId && <td className="hide-sm">{r.repo_name}</td>}
                      <td><div>{r.branch ?? '—'}</div><div className="muted truncate" style={{ fontSize: 12, maxWidth: 260 }} title={r.commit_message ?? ''}><span className="mono">{shortSha(r.head_sha)}</span> {r.commit_message}</div></td>
                      <td><RunBadge conclusion={r.conclusion} status={r.status} /></td>
                      <td className="hide-sm">{r.diagnosis_category ? <div className="stack" style={{ gap: 3 }}><Badge tone="accent" icon={false}>{r.diagnosis_category}</Badge>{r.verified_by_run_id && <Badge tone="good">fix verified</Badge>}</div> : <span className="muted">—</span>}</td>
                      <td className="num">{duration(r.duration_s)}</td>
                      <td className="hide-sm muted">{timeAgo(r.created_at)}</td>
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

export function PipelinesPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>CI/CD Pipelines</h1>
          <p className="sub">GitHub Actions runs with deterministic failure diagnosis and fix verification.</p>
        </div>
      </div>
      <RunsTable />
    </>
  );
}

interface RunDetail {
  run: Run & { run_attempt: number; started_at: string; updated_at: string };
  diagnosis: {
    job_name: string | null;
    failed_step: string | null;
    category: string;
    confidence: 'high' | 'medium' | 'low';
    summary: string;
    recommendation: string;
    log_available: number;
    created_at: string;
    verified_by_run_id: number | null;
    verified_at: string | null;
    evidence: { lines?: { line: number; text: string; primary?: boolean }[]; primaryLine?: number | null; file?: string | null };
  } | null;
  verifiedBy: { id: number; run_number: number; html_url: string; created_at: string } | null;
}

export function RunDetailPage({ id, isAdmin }: { id: number; isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<RunDetail>(`/api/pipelines/runs/${id}`, ['pipelines']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingBlock rows={8} /></Card>;
  const { run, diagnosis: d, verifiedBy } = data;
  const failed = ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion ?? '');

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/pipelines">Pipelines</Link> / <Link to={`/repositories/${run.repo_id}?tab=pipelines`}>{run.repo_name}</Link> /</div>
          <div className="row"><h1>{run.workflow_name} #{run.run_number}</h1><RunBadge conclusion={run.conclusion} status={run.status} /></div>
          <p className="sub">{run.branch} · <span className="mono">{shortSha(run.head_sha)}</span> {run.commit_message}</p>
        </div>
        <div className="row">
          <a className="btn" href={run.html_url} target="_blank" rel="noreferrer noopener"><Icon name="external" size={15} /> Open on GitHub</a>
          {isAdmin && failed && (
            <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await api.post(`/api/pipelines/runs/${id}/diagnose`); reload(); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); } }}>
              <Icon name="refresh" size={15} /> {busy ? 'Diagnosing…' : d ? 'Re-diagnose' : 'Diagnose'}
            </button>
          )}
        </div>
      </div>
      {err && <Notice tone="error">{err}</Notice>}

      <div className="grid grid-main">
        <div className="stack" style={{ gap: 16 }}>
          {failed && !d && <Notice tone="info">This failure has not been diagnosed yet.{isAdmin ? ' Use “Diagnose” to fetch the job log and analyse it.' : ''}</Notice>}
          {d && (
            <Card title="Diagnosis" hint={`Deterministic rules · confidence ${d.confidence}`} actions={<Badge tone="accent" icon={false}>{d.category}</Badge>}>
              <div className="stack" style={{ gap: 14 }}>
                <div>
                  <div className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Probable root cause</div>
                  <p style={{ fontSize: 15, marginTop: 4 }}>{d.summary}</p>
                </div>
                <div className="dl" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                  <dt>Failed job</dt><dd>{d.job_name ?? '—'}</dd>
                  <dt>Failed step</dt><dd>{d.failed_step ?? '—'}</dd>
                  <dt>Location</dt><dd className="mono">{d.evidence.file ?? 'Not identifiable from the log'}</dd>
                </div>
                <div>
                  <div className="secondary" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Evidence {d.evidence.primaryLine ? `(first meaningful error at log line ${d.evidence.primaryLine})` : ''}</div>
                  {d.evidence.lines?.length ? (
                    <div className="log" role="region" aria-label="Log excerpt">
                      {d.evidence.lines.map((l) => <div key={l.line} className={`ln ${l.primary ? 'primary' : ''}`}><span className="no">{l.line}</span><span>{l.text}</span></div>)}
                    </div>
                  ) : <p className="muted">{d.log_available ? 'No excerpt' : 'Log not available from GitHub (expired or insufficient permission).'}</p>}
                  <DataSourceNote>Log excerpts are redacted for credential patterns before storage. Lines like “Process completed with exit code 1” are treated as consequences, not causes.</DataSourceNote>
                </div>
                <div>
                  <div className="secondary" style={{ fontSize: 12, fontWeight: 600 }}>Suggested minimal fix</div>
                  <p style={{ marginTop: 4 }}>{d.recommendation}</p>
                  <DataSourceNote>A suggestion, not a verified fix. SentinelOps marks it verified only after a later run of the same workflow on the same branch succeeds.</DataSourceNote>
                </div>
              </div>
            </Card>
          )}
          {!failed && <Card><EmptyState icon="ok" title={run.conclusion === 'success' ? 'This run succeeded' : `This run is ${run.conclusion ?? run.status}`}>Diagnosis applies to failed runs.</EmptyState></Card>}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <Card title="Verification">
            {!d ? <p className="muted">Nothing to verify.</p> : verifiedBy ? (
              <div className="stack">
                <Badge tone="good">Fix verified</Badge>
                <p className="secondary">Run <a href={verifiedBy.html_url} target="_blank" rel="noreferrer noopener">#{verifiedBy.run_number}</a> of this workflow on <strong>{run.branch}</strong> succeeded {timeAgo(verifiedBy.created_at)}.</p>
              </div>
            ) : (
              <div className="stack">
                <Badge tone="warning">Not yet verified</Badge>
                <p className="secondary">No later successful run of this workflow on {run.branch}. Push a fix and sync pipelines to verify.</p>
              </div>
            )}
          </Card>
          <Card title="Run details">
            <dl className="dl">
              <dt>Run ID</dt><dd className="mono">{run.id}</dd>
              <dt>Attempt</dt><dd>{run.run_attempt}</dd>
              <dt>Event</dt><dd>{run.event}</dd>
              <dt>Actor</dt><dd>{run.actor ?? '—'}</dd>
              <dt>Pull requests</dt><dd>{run.pr_numbers.length ? run.pr_numbers.map((n) => `#${n}`).join(', ') : '—'}</dd>
              <dt>Started</dt><dd>{dateTime(run.started_at)}</dd>
              <dt>Updated</dt><dd>{dateTime(run.updated_at)}</dd>
              <dt>Duration</dt><dd>{duration(run.duration_s)}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
