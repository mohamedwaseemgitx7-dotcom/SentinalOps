import { useState } from 'react';
import { Icon } from '../components/icons';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, RunBadge, SeverityBadge } from '../components/ui';
import { shortSha, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState } from '../lib/router';
import { AddSourceWizard } from './Wizard';

export interface Repo {
  id: number;
  kind: 'github' | 'local';
  full_name: string;
  url: string | null;
  local_path: string | null;
  description: string | null;
  is_private: boolean | null;
  default_branch: string | null;
  languages: Record<string, number>;
  frameworks: string[];
  latest_commit: { sha: string; message: string; author: string; date: string; url: string | null } | null;
  license: string | null;
  last_analyzed_at: string | null;
  last_analysis_status: string | null;
  last_error: string | null;
  analyzing: boolean;
  critical_findings?: number;
  high_findings?: number;
  open_findings?: number;
  open_incidents?: number;
  latest_run?: { id: number; conclusion: string | null; status: string; workflow: string; created_at: string; url: string } | null;
  latest_deploy?: { id: number; conclusion: string | null; workflow: string; created_at: string } | null;
}

export function SecurityStatus({ repo }: { repo: Repo }) {
  if (repo.analyzing) return <Badge tone="accent">Analyzing…</Badge>;
  if (repo.last_analysis_status === 'failed') return <Badge tone="critical">Analysis failed</Badge>;
  if (!repo.last_analyzed_at) return <Badge tone="unknown">Not analysed</Badge>;
  if (repo.critical_findings) return <SeverityBadge severity="critical" />;
  if (repo.high_findings) return <Badge tone="high">{repo.high_findings} high</Badge>;
  return <Badge tone="good">No critical/high</Badge>;
}

export function RepositoriesPage({ isAdmin }: { isAdmin: boolean }) {
  const [q, setQ] = useQueryState();
  const search = q.get('search') ?? '';
  const { data, error, loading, reload } = useResource<{ repositories: Repo[] }>(`/api/repositories${search ? `?search=${encodeURIComponent(search)}` : ''}`, ['repositories', 'pipelines', 'findings']);
  const [wizard, setWizard] = useState<'github' | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Repositories</h1>
          <p className="sub">Connected GitHub repositories and local working copies.</p>
        </div>
        {isAdmin && <button className="btn btn-primary" onClick={() => setWizard('github')}><Icon name="plus" size={16} /> Connect repository</button>}
      </div>
      <div className="filters">
        <div className="field" style={{ flex: '1 1 260px', maxWidth: 360 }}>
          <label htmlFor="repo-search">Filter</label>
          <input id="repo-search" className="input" value={search} onChange={(e) => setQ({ search: e.target.value })} placeholder="owner/name" />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card>
        {loading && !data ? <LoadingBlock rows={6} /> : !data?.repositories.length ? (
          <EmptyState icon="repo" title={search ? 'No repositories match' : 'No repositories connected'} action={isAdmin && !search ? <button className="btn btn-primary" onClick={() => setWizard('github')}>Connect your first repository</button> : undefined}>
            Connect a repository you own or are authorised to inspect. SentinelOps stores metadata and findings, not your source code.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th className="hide-sm">Stack</th>
                  <th>Latest build</th>
                  <th className="hide-sm">Latest deploy</th>
                  <th>Security</th>
                  <th className="num">Incidents</th>
                  <th className="hide-sm">Last analysis</th>
                </tr>
              </thead>
              <tbody>
                {data.repositories.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                        <Icon name={r.kind === 'github' ? 'github' : 'folder'} size={16} />
                        <div style={{ minWidth: 0 }}>
                          <Link to={`/repositories/${r.id}`} style={{ fontWeight: 600 }}>{r.full_name}</Link>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {r.default_branch ?? '—'} · {r.latest_commit ? <span className="mono">{shortSha(r.latest_commit.sha)}</span> : 'no commit info'}
                            {r.is_private !== null && <> · {r.is_private ? 'private' : 'public'}</>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hide-sm"><div className="truncate" style={{ maxWidth: 220 }} title={r.frameworks.join(', ')}>{r.frameworks.slice(0, 4).join(', ') || <span className="muted">—</span>}</div></td>
                    <td>{r.latest_run ? <div className="stack" style={{ gap: 2 }}><RunBadge conclusion={r.latest_run.conclusion} status={r.latest_run.status} /><span className="muted" style={{ fontSize: 11.5 }}>{timeAgo(r.latest_run.created_at)}</span></div> : <span className="muted">{r.kind === 'local' ? 'n/a (local)' : 'No runs'}</span>}</td>
                    <td className="hide-sm">{r.latest_deploy ? <RunBadge conclusion={r.latest_deploy.conclusion} /> : <span className="muted">Not detected</span>}</td>
                    <td><SecurityStatus repo={r} /></td>
                    <td className="num">{r.open_incidents ? <Link to={`/incidents?repo=${r.id}`}>{r.open_incidents}</Link> : 0}</td>
                    <td className="hide-sm muted">{timeAgo(r.last_analyzed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {wizard && <AddSourceWizard initial={wizard} onClose={() => setWizard(null)} />}
    </>
  );
}
