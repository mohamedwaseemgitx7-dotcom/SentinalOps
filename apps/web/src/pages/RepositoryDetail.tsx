import { useState } from 'react';
import { HBars } from '../components/charts';
import { Icon } from '../components/icons';
import { Badge, Card, DataSourceNote, EmptyState, ErrorState, LoadingBlock, Modal, Notice, RunBadge, Tabs, type Tone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, duration, pct, shortSha, timeAgo } from '../lib/format';
import { useResource } from '../lib/live';
import { Link, useQueryState, useRouter } from '../lib/router';
import { HealthPanel, type Health } from './Overview';
import { FindingsTable } from './Security';
import { RunsTable } from './Pipelines';
import { IncidentsTable } from './Incidents';
import type { Repo } from './Repositories';

interface Architecture {
  manifests: string[];
  workflows: string[];
  dockerfiles: string[];
  composeFiles: string[];
  terraform: string[];
  kubernetes: string[];
  testFiles: number;
  testDirs: string[];
  docs: Record<string, boolean>;
  packages: { file: string; name: string | null; scripts: string[]; dependencies: number; devDependencies: number }[];
  components: { name: string; kind: string; path: string }[];
  envFiles: string[];
  lockfiles: string[];
  ciProviders: string[];
  deploymentTargets: string[];
}

interface Detail {
  repository: Repo;
  analyses: { id: number; started_at: string; finished_at: string | null; status: string; error: string | null }[];
  summary: {
    architecture: Architecture;
    dependencies: { total: number; direct: number; byEcosystem: Record<string, number>; unresolved: string[]; sample: { ecosystem: string; name: string; version: string; manifest: string }[] };
    fileCount: number;
    truncated: boolean;
    secretScanCoverage: { scanned: number; candidates: number };
    counts: Record<string, number>;
  } | null;
  checks: { name: string; status: 'ran' | 'skipped' | 'failed'; detail: string; findings?: number }[];
}

type TabId = 'overview' | 'architecture' | 'dependencies' | 'pipelines' | 'security' | 'gatekeeper' | 'deployments' | 'incidents' | 'analytics' | 'documentation';

export function RepositoryDetailPage({ id, isAdmin }: { id: number; isAdmin: boolean }) {
  const { data, error, loading, reload } = useResource<Detail>(`/api/repositories/${id}`, ['repositories', 'findings']);
  const [q, setQ] = useQueryState();
  const tab = (q.get('tab') as TabId) ?? 'overview';
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { navigate } = useRouter();

  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Card><LoadingBlock rows={8} /></Card>;
  const repo = data.repository;
  const arch = data.summary?.architecture;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'architecture', label: 'Architecture' }, { id: 'dependencies', label: 'Dependencies' },
    { id: 'pipelines', label: 'Pipelines' }, { id: 'security', label: 'Security' }, { id: 'gatekeeper', label: 'PR Gatekeeper' },
    { id: 'deployments', label: 'Deployments' }, { id: 'incidents', label: 'Incidents' }, { id: 'analytics', label: 'Analytics' }, { id: 'documentation', label: 'Documentation' },
  ];

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12 }}><Link to="/repositories">Repositories</Link> /</div>
          <div className="row">
            <Icon name={repo.kind === 'github' ? 'github' : 'folder'} />
            <h1 style={{ overflowWrap: 'anywhere' }}>{repo.full_name}</h1>
            {repo.analyzing && <Badge tone="accent">Analyzing…</Badge>}
          </div>
          <p className="sub">{repo.description ?? repo.local_path ?? ''}</p>
        </div>
        <div className="row">
          {repo.url && <a className="btn" href={repo.url} target="_blank" rel="noreferrer noopener"><Icon name="external" size={15} /> GitHub</a>}
          {isAdmin && repo.kind === 'github' && <button className="btn" disabled={!!busy} onClick={() => run('sync', () => api.post(`/api/repositories/${id}/pipelines/sync`))}><Icon name="refresh" size={15} />{busy === 'sync' ? 'Syncing…' : 'Sync pipelines'}</button>}
          {isAdmin && <button className="btn btn-primary" disabled={!!busy || repo.analyzing} onClick={() => run('analyze', () => api.post(`/api/repositories/${id}/analyze`, { dependencyAdvisories: true }))}><Icon name="play" size={15} />{repo.analyzing ? 'Analyzing…' : 'Re-analyze'}</button>}
          {isAdmin && <button className="btn btn-danger" onClick={() => setConfirmDelete(true)} aria-label="Disconnect repository"><Icon name="trash" size={15} /></button>}
        </div>
      </div>
      {actionError && <Notice tone="error">{actionError}</Notice>}
      {repo.last_analysis_status === 'failed' && <Notice tone="error">Last analysis failed: {repo.last_error}</Notice>}
      {!data.summary && !repo.analyzing && repo.last_analysis_status !== 'failed' && <Notice tone="info">No completed analysis yet.</Notice>}

      <Tabs label="Repository sections" tabs={tabs} value={tab} onChange={(t) => setQ({ tab: t === 'overview' ? null : t })} />

      {tab === 'overview' && <OverviewTab repoId={id} detail={data} />}
      {tab === 'architecture' && (arch ? <ArchitectureTab arch={arch} /> : <Card><EmptyState title="No architecture data yet">Run an analysis to map components.</EmptyState></Card>)}
      {tab === 'dependencies' && <DependenciesTab detail={data} repoId={id} />}
      {tab === 'pipelines' && (repo.kind === 'github' ? <RunsTable repoId={id} /> : <Card><EmptyState title="Pipelines are read from GitHub Actions">Connect the GitHub repository for this working copy to see workflow runs.</EmptyState></Card>)}
      {tab === 'security' && <FindingsTable repoId={id} isAdmin={isAdmin} />}
      {tab === 'gatekeeper' && <GatekeeperTab repo={repo} isAdmin={isAdmin} />}
      {tab === 'deployments' && <DeploymentsTab repoId={id} />}
      {tab === 'incidents' && <IncidentsTable repoId={id} />}
      {tab === 'analytics' && <RepoAnalytics repoId={id} />}
      {tab === 'documentation' && (arch ? <DocsTab arch={arch} /> : <Card><EmptyState title="Run an analysis first" /></Card>)}

      {confirmDelete && (
        <Modal title="Disconnect repository?" onClose={() => setConfirmDelete(false)} footer={<><button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="btn btn-danger" onClick={() => run('delete', async () => { await api.del(`/api/repositories/${id}`); navigate('/repositories'); })}>Disconnect</button></>}>
          <p>This deletes the stored metadata, findings, workflow runs and diagnoses for <strong>{repo.full_name}</strong> from SentinelOps. The repository itself is not touched.</p>
        </Modal>
      )}
    </>
  );
}

function OverviewTab({ repoId, detail }: { repoId: number; detail: Detail }) {
  const health = useResource<{ health: Health }>(`/api/health-score?repo=${repoId}`, ['repositories', 'pipelines', 'findings', 'incidents']);
  const repo = detail.repository;
  const langTotal = Object.values(repo.languages).reduce((a, b) => a + b, 0);
  return (
    <div className="grid grid-hero">
      <Card title="Repository health" hint="CI, security and incidents for this repository">
        {health.data ? <HealthPanel health={health.data.health} /> : <LoadingBlock />}
      </Card>
      <div className="stack" style={{ gap: 16 }}>
        <Card title="Summary">
          <dl className="dl">
            <dt>Kind</dt><dd>{repo.kind === 'github' ? 'GitHub repository' : `Local folder ${repo.local_path}`}</dd>
            <dt>Default branch</dt><dd>{repo.default_branch ?? '—'}</dd>
            <dt>Latest commit</dt>
            <dd>{repo.latest_commit ? <><span className="mono">{shortSha(repo.latest_commit.sha)}</span> {repo.latest_commit.message} — {repo.latest_commit.author}, {timeAgo(repo.latest_commit.date)}</> : '—'}</dd>
            <dt>Frameworks</dt><dd>{repo.frameworks.length ? repo.frameworks.join(', ') : '—'}</dd>
            <dt>License</dt><dd>{repo.license ?? 'Not detected'}</dd>
            <dt>Last analysis</dt><dd>{dateTime(repo.last_analyzed_at)}</dd>
            <dt>Files analysed</dt><dd>{detail.summary ? `${detail.summary.fileCount.toLocaleString()}${detail.summary.truncated ? ' (listing truncated)' : ''}` : '—'}</dd>
          </dl>
        </Card>
        <Card title="Languages" hint={repo.kind === 'github' ? 'Bytes per language, from GitHub' : 'Bytes per file extension'}>
          {langTotal ? <HBars ariaLabel="Languages by size" rows={Object.entries(repo.languages).slice(0, 8).map(([label, v]) => ({ label, value: Math.round((v / langTotal) * 1000) / 10 }))} valueFormat={(v) => `${v}%`} /> : <p className="muted">No language data.</p>}
        </Card>
        <Card title="Checks that ran" hint="Exactly what the last analysis did — nothing more is implied">
          {detail.checks.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Check</th><th>Status</th><th>Detail</th><th className="num">Findings</th></tr></thead>
              <tbody>{detail.checks.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td><Badge tone={c.status === 'ran' ? 'good' : c.status === 'failed' ? 'critical' : 'unknown'}>{c.status}</Badge></td>
                  <td className="secondary">{c.detail}</td>
                  <td className="num">{c.findings ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="muted">No analysis has completed yet.</p>}
          <DataSourceNote>No scanner can prove the absence of vulnerabilities. Skipped checks are listed so gaps are visible.</DataSourceNote>
        </Card>
      </div>
    </div>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return <ul style={{ margin: 0, paddingLeft: 18 }} className="mono">{items.slice(0, 50).map((i) => <li key={i}>{i}</li>)}{items.length > 50 && <li className="muted">…and {items.length - 50} more</li>}</ul>;
}

function ArchitectureTab({ arch }: { arch: Architecture }) {
  // Simple layered diagram: source units → build/CI → packaging → deploy targets.
  const layers: { title: string; items: string[] }[] = [
    { title: 'Components', items: arch.components.filter((c) => c.kind !== 'container image' && c.kind !== 'compose stack').map((c) => `${c.name} (${c.kind})`) },
    { title: 'CI / CD', items: [...arch.ciProviders, ...arch.workflows.map((w) => w.replace('.github/workflows/', ''))] },
    { title: 'Packaging', items: [...arch.dockerfiles.map((d) => `Docker: ${d}`), ...arch.composeFiles.map((c) => `Compose: ${c}`)] },
    { title: 'Deploy targets', items: arch.deploymentTargets },
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Architecture map" hint="Derived from manifests and config files — verify against your own docs">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'stretch' }}>
          {layers.map((l, i) => (
            <div key={l.title} style={{ position: 'relative', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 12, background: 'var(--bg-elevated)' }}>
              <div className="secondary" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{i + 1}. {l.title}</div>
              {l.items.length ? l.items.slice(0, 10).map((it) => <div key={it} className="mono truncate" style={{ fontSize: 12, padding: '3px 0' }} title={it}>{it}</div>) : <div className="muted" style={{ fontSize: 12 }}>None detected</div>}
              {l.items.length > 10 && <div className="muted" style={{ fontSize: 12 }}>+{l.items.length - 10} more</div>}
            </div>
          ))}
        </div>
      </Card>
      <div className="grid grid-2">
        <Card title="Manifests"><List items={arch.manifests} empty="None found" /></Card>
        <Card title="Lockfiles"><List items={arch.lockfiles} empty="No lockfiles — builds may not be reproducible" /></Card>
        <Card title="Infrastructure as code"><List items={[...arch.terraform, ...arch.kubernetes]} empty="No Terraform or Kubernetes manifests" /></Card>
        <Card title="Tests" hint={`${arch.testFiles} test file(s) detected`}><List items={arch.testDirs} empty="No test directories found" /></Card>
        <Card title="Packages & scripts">
          {arch.packages.length ? arch.packages.map((p) => (
            <div key={p.file} style={{ marginBottom: 10 }}>
              <div className="mono">{p.file}</div>
              <div className="muted" style={{ fontSize: 12 }}>{p.dependencies} deps · {p.devDependencies} dev deps · scripts: {p.scripts.join(', ') || 'none'}</div>
            </div>
          )) : <p className="muted">No package.json files.</p>}
        </Card>
        <Card title="Environment files"><List items={arch.envFiles} empty="No committed .env files" /></Card>
      </div>
    </div>
  );
}

function DependenciesTab({ detail, repoId }: { detail: Detail; repoId: number }) {
  const deps = detail.summary?.dependencies;
  const vulns = useResource<{ findings: { id: number; title: string; severity: string; package: string; remediation: string; reference: string }[] }>(`/api/findings?repo=${repoId}&status=open&dependency=1&limit=200`, ['findings']);
  if (!deps) return <Card><EmptyState title="Run an analysis to list dependencies" /></Card>;
  const advisories = vulns.data?.findings ?? [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid grid-3">
        <div className="card kpi"><div className="label">Resolved package versions</div><div className="value">{deps.total.toLocaleString()}</div><div className="meta">{deps.direct} direct</div></div>
        <div className="card kpi"><div className="label">Ecosystems</div><div className="value" style={{ fontSize: 18 }}>{Object.entries(deps.byEcosystem).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</div></div>
        <div className="card kpi"><div className="label">Known advisories</div><div className="value">{advisories.length}</div><div className="meta">from OSV.dev / Dependabot</div></div>
      </div>
      <Card title="Vulnerable dependencies">
        {advisories.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Severity</th><th>Package</th><th>Advisory</th><th>Fix</th></tr></thead>
            <tbody>{advisories.map((f) => (
              <tr key={f.id}><td><Badge tone={f.severity as Tone}>{f.severity}</Badge></td><td className="mono">{f.package}</td><td><a href={f.reference} target="_blank" rel="noreferrer noopener">{f.title}</a></td><td className="secondary">{f.remediation}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">No known advisories for the checked versions.</p>}
      </Card>
      <Card title="Direct dependencies" hint="First 200">
        {deps.sample.length ? <div className="table-wrap" style={{ maxHeight: 420 }}><table><thead><tr><th>Package</th><th>Version</th><th>Ecosystem</th><th>Manifest</th></tr></thead><tbody>{deps.sample.map((d) => <tr key={`${d.manifest}${d.name}`}><td className="mono">{d.name}</td><td className="mono">{d.version}</td><td>{d.ecosystem}</td><td className="muted mono">{d.manifest}</td></tr>)}</tbody></table></div> : <p className="muted">No resolvable dependencies (lockfiles are needed for exact versions).</p>}
        {deps.unresolved.length > 0 && <DataSourceNote>Not checkable without exact versions: {deps.unresolved.slice(0, 8).join('; ')}{deps.unresolved.length > 8 ? '…' : ''}</DataSourceNote>}
      </Card>
    </div>
  );
}

interface GateReport {
  repo: string; number: number; title: string; author: string | null; headSha: string; baseRef: string; url: string;
  changedFiles: number; additions: number; deletions: number; overall: 'pass' | 'warn' | 'block';
  rules: { id: string; name: string; status: 'pass' | 'warn' | 'block' | 'unavailable'; detail: string; items?: string[] }[];
}

const GATE_TONE: Record<string, Tone> = { pass: 'good', warn: 'warning', block: 'critical', unavailable: 'unknown' };

function GatekeeperTab({ repo, isAdmin }: { repo: Repo; isAdmin: boolean }) {
  const pulls = useResource<{ pulls: { number: number; title: string; author: string; branch: string; updatedAt: string; draft: boolean; url: string }[] }>(repo.kind === 'github' ? `/api/repositories/${repo.id}/pulls` : null);
  const [report, setReport] = useState<{ report: GateReport; markdown: string; commentingEnabled: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (repo.kind !== 'github') return <Card><EmptyState title="PR Gatekeeper needs a GitHub repository" /></Card>;
  const evaluate = async (n: number) => {
    setBusy(n); setErr(null); setPosted(null);
    try { setReport(await api.post(`/api/repositories/${repo.id}/pulls/${n}/evaluate`)); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(null); }
  };
  return (
    <div className="grid grid-main" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)' }}>
      <Card title="Open pull requests" hint="Evaluated from metadata and diffs only — PR code is never executed">
        {pulls.error && <ErrorState error={pulls.error} onRetry={pulls.reload} />}
        {!pulls.data ? <LoadingBlock /> : !pulls.data.pulls.length ? <EmptyState icon="pr" title="No open pull requests" /> : (
          <div className="stack" style={{ gap: 8 }}>
            {pulls.data.pulls.map((p) => (
              <div key={p.number} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ minWidth: 0 }}>
                  <a href={p.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600 }}>#{p.number} {p.title}</a>
                  <div className="muted" style={{ fontSize: 12 }}>{p.author} · {p.branch} · updated {timeAgo(p.updatedAt)}{p.draft ? ' · draft' : ''}</div>
                </div>
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => evaluate(p.number)}>{busy === p.number ? 'Evaluating…' : 'Evaluate'}</button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={report ? `PR #${report.report.number}` : 'Gate result'} actions={report && <Badge tone={GATE_TONE[report.report.overall]!}>{report.report.overall.toUpperCase()}</Badge>}>
        {err && <Notice tone="error">{err}</Notice>}
        {!report ? <p className="muted">Choose a pull request to evaluate it against the configured rules.</p> : (
          <div className="stack">
            <p className="secondary">{report.report.title} · {report.report.changedFiles} files, +{report.report.additions}/−{report.report.deletions} · head <span className="mono">{shortSha(report.report.headSha)}</span></p>
            <div className="table-wrap"><table>
              <thead><tr><th>Rule</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>{report.report.rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td><Badge tone={GATE_TONE[r.status]!}>{r.status}</Badge></td>
                  <td className="secondary">{r.detail}{r.items?.length ? <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>{r.items.slice(0, 8).map((i) => <li key={i}>{i}</li>)}</ul> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <DataSourceNote>Advisory only. SentinelOps never changes branch protection or blocks merges on its own.</DataSourceNote>
            {isAdmin && (report.commentingEnabled ? (
              <div className="row">
                <button className="btn" onClick={() => setConfirm(true)}><Icon name="pr" size={15} /> Post as PR comment</button>
                {posted && <a href={posted} target="_blank" rel="noreferrer noopener">Comment posted ↗</a>}
              </div>
            ) : <p className="muted" style={{ fontSize: 12 }}>Posting PR comments is off. Enable it in Settings → Integrations.</p>)}
          </div>
        )}
      </Card>
      {confirm && report && (
        <Modal title="Post this report to GitHub?" onClose={() => setConfirm(false)} footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn btn-primary" onClick={async () => { setConfirm(false); try { setPosted((await api.post<{ url: string }>(`/api/repositories/${repo.id}/pulls/${report.report.number}/comment`, { confirm: true })).url); } catch (e) { setErr((e as ApiError).message); } }}>Post comment</button></>}>
          <p>A public comment will be created on <strong>{report.report.repo}#{report.report.number}</strong> using your GitHub credentials. Everyone who can see the PR will see it.</p>
          <pre className="log" style={{ padding: 12, whiteSpace: 'pre-wrap', maxHeight: 240 }}>{report.markdown}</pre>
        </Modal>
      )}
    </div>
  );
}

function DeploymentsTab({ repoId }: { repoId: number }) {
  const { data, error, reload } = useResource<{ deployments: { id: number; environment: string; ref: string; sha: string; createdAt: string; creator: string; state: string; url: string | null }[]; workflowDeploys: { id: number; workflow_name: string; branch: string; conclusion: string | null; status: string; created_at: string; duration_s: number | null; html_url: string }[]; source: string }>(`/api/repositories/${repoId}/deployments`, ['pipelines']);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Card><LoadingBlock /></Card>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="GitHub Deployments" hint={`Source: ${data.source}`}>
        {data.deployments.length ? <div className="table-wrap"><table><thead><tr><th>Environment</th><th>State</th><th>Ref</th><th>Created</th><th>By</th></tr></thead><tbody>{data.deployments.map((d) => <tr key={d.id}><td>{d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener">{d.environment}</a> : d.environment}</td><td><Badge tone={d.state === 'success' ? 'good' : d.state === 'failure' || d.state === 'error' ? 'critical' : 'unknown'}>{d.state}</Badge></td><td className="mono">{d.ref} · {shortSha(d.sha)}</td><td>{timeAgo(d.createdAt)}</td><td>{d.creator}</td></tr>)}</tbody></table></div> : <p className="muted">No deployments recorded through the GitHub Deployments API.</p>}
      </Card>
      <Card title="Deployment workflows" hint="Runs whose workflow name contains deploy / release / publish">
        {data.workflowDeploys.length ? <div className="table-wrap"><table><thead><tr><th>Workflow</th><th>Result</th><th>Branch</th><th>When</th><th className="num">Duration</th></tr></thead><tbody>{data.workflowDeploys.map((r) => <tr key={r.id}><td><Link to={`/pipelines/${r.id}`}>{r.workflow_name}</Link></td><td><RunBadge conclusion={r.conclusion} status={r.status} /></td><td>{r.branch}</td><td>{timeAgo(r.created_at)}</td><td className="num">{duration(r.duration_s)}</td></tr>)}</tbody></table></div> : <p className="muted">No deployment-like workflow runs found.</p>}
      </Card>
    </div>
  );
}

function RepoAnalytics({ repoId }: { repoId: number }) {
  const { data } = useResource<{ ci: { total: number; successRate: number | null; avgDurationS: number | null; p95DurationS: number | null; failureCategories: { category: string; n: number }[]; fixVerification: { diagnosed: number; verified: number; rate: number | null } }; delivery: { deployments: number; perWeek: number | null; changeFailureRatePct: number | null } }>(`/api/analytics?repo=${repoId}`, ['pipelines']);
  if (!data) return <Card><LoadingBlock /></Card>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <div className="card kpi"><div className="label">CI success (30d)</div><div className="value">{pct(data.ci.successRate)}</div><div className="meta">{data.ci.total} completed runs</div></div>
        <div className="card kpi"><div className="label">Build duration</div><div className="value">{duration(data.ci.avgDurationS)}</div><div className="meta">p95 {duration(data.ci.p95DurationS)}</div></div>
        <div className="card kpi"><div className="label">Deployments / week</div><div className="value">{data.delivery.perWeek ?? '—'}</div><div className="meta">Change failure {pct(data.delivery.changeFailureRatePct)}</div></div>
        <div className="card kpi"><div className="label">Fix verification</div><div className="value">{pct(data.ci.fixVerification.rate)}</div><div className="meta">{data.ci.fixVerification.verified} of {data.ci.fixVerification.diagnosed} diagnosed failures</div></div>
      </div>
      <Card title="Failure categories" hint="From deterministic log diagnosis">
        {data.ci.failureCategories.length ? <HBars ariaLabel="Failure categories" rows={data.ci.failureCategories.map((c) => ({ label: c.category, value: c.n }))} /> : <p className="muted">No diagnosed failures in this period.</p>}
      </Card>
      <p className="muted"><Link to={`/analytics?repo=${repoId}`}>Open full analytics for this repository →</Link></p>
    </div>
  );
}

const DOC_ADVICE: Record<string, string> = {
  README: 'Purpose, setup, run, test and deploy instructions.',
  LICENSE: 'Legal terms for use and contribution.',
  SECURITY: 'How to report vulnerabilities privately.',
  CONTRIBUTING: 'How to propose changes and run checks.',
  CHANGELOG: 'What changed between releases.',
  CODEOWNERS: 'Who reviews which paths.',
  'Issue templates': 'Structured bug and feature reports.',
  'PR template': 'Checklist for reviewers and authors.',
  'Dependabot config': 'Automated dependency and action updates.',
  'Architecture docs': 'How components fit together (ADRs, diagrams).',
  Runbook: 'Operational procedures and troubleshooting.',
};

function DocsTab({ arch }: { arch: Architecture }) {
  const missing = Object.entries(arch.docs).filter(([, v]) => !v).length;
  return (
    <Card title="Operational documentation" hint={`${missing} of ${Object.keys(arch.docs).length} recommended documents missing`}>
      <div className="table-wrap"><table>
        <thead><tr><th>Document</th><th>Status</th><th>Why it matters</th></tr></thead>
        <tbody>{Object.entries(arch.docs).map(([k, v]) => <tr key={k}><td>{k}</td><td><Badge tone={v ? 'good' : 'warning'}>{v ? 'present' : 'missing'}</Badge></td><td className="secondary">{DOC_ADVICE[k] ?? ''}</td></tr>)}</tbody>
      </table></div>
    </Card>
  );
}
