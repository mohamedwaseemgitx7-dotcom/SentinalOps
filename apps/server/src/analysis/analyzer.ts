import path from 'node:path';
import { now, parseJson, tx, type DB } from '../db.ts';
import { sha256 } from '../lib/crypto.ts';
import type { EventBus } from '../lib/events.ts';
import type { GitHubClient } from '../github/client.ts';
import type { IncidentService } from '../incidents.ts';
import { detectArchitecture, languagesFromSizes, type Architecture } from './detect.ts';
import { extractDependencies, osvFindings } from './osv.ts';
import { checkDockerfile, checkHygiene, checkKubernetes, checkTerraform, checkWorkflow, scanSecrets, shouldScanForSecrets, type Finding } from './rules.ts';
import { detectScanners, runGitleaks, runTrivy } from './scanners.ts';
import { githubSource, localGitInfo, localSource, type RepoSource } from './source.ts';

export interface RepoRow {
  id: number;
  kind: 'github' | 'local';
  full_name: string;
  url: string | null;
  local_path: string | null;
  default_branch: string | null;
}

export interface CheckRecord {
  name: string;
  status: 'ran' | 'skipped' | 'failed';
  detail: string;
  findings?: number;
}

export interface AnalysisOptions {
  /** Query OSV.dev with package names/versions. */
  dependencyAdvisories: boolean;
}

/** Remote repos: scan at most this many files for secrets (each one is an API request). */
const REMOTE_SECRET_SCAN_LIMIT = 150;

export class Analyzer {
  private running = new Set<number>();

  private db: DB;
  private gh: GitHubClient;
  private bus: EventBus;
  private incidents: IncidentService;

  constructor(db: DB, gh: GitHubClient, bus: EventBus, incidents: IncidentService) {
    this.db = db;
    this.gh = gh;
    this.bus = bus;
    this.incidents = incidents;
  }

  isRunning(repoId: number): boolean {
    return this.running.has(repoId);
  }

  /** Starts an analysis in the background and returns its id immediately. */
  start(repo: RepoRow, opts: AnalysisOptions): number {
    if (this.running.has(repo.id)) {
      const row = this.db.prepare("SELECT id FROM analyses WHERE repo_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(repo.id) as { id: number } | undefined;
      if (row) return row.id;
    }
    const info = this.db.prepare("INSERT INTO analyses (repo_id, started_at, status) VALUES (?, ?, 'running')").run(repo.id, now());
    const analysisId = Number(info.lastInsertRowid);
    this.running.add(repo.id);
    this.bus.publish('analysis.started', 'info', `Analysis started for ${repo.full_name}`, `/repositories/${repo.id}`);
    void this.run(repo, analysisId, opts).finally(() => this.running.delete(repo.id));
    return analysisId;
  }

  async run(repo: RepoRow, analysisId: number, opts: AnalysisOptions): Promise<void> {
    const checks: CheckRecord[] = [];
    try {
      let src: RepoSource;
      let languages: Record<string, number>;
      let meta: Record<string, unknown> = {};
      if (repo.kind === 'github') {
        const [owner, name] = repo.full_name.split('/') as [string, string];
        const info = await this.gh.json<{ default_branch: string; description: string | null; private: boolean; html_url: string; license: { spdx_id: string } | null }>(`/repos/${owner}/${name}`);
        const branch = info.default_branch;
        const commit = await this.gh.json<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>(`/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`);
        languages = await this.gh.json<Record<string, number>>(`/repos/${owner}/${name}/languages`);
        src = await githubSource(this.gh, owner, name, commit.sha);
        meta = {
          description: info.description,
          is_private: info.private ? 1 : 0,
          default_branch: branch,
          url: info.html_url,
          license: info.license?.spdx_id ?? null,
          latest_commit: JSON.stringify({ sha: commit.sha, message: commit.commit.message.split('\n')[0], author: commit.commit.author.name, date: commit.commit.author.date, url: commit.html_url }),
        };
        checks.push({ name: 'GitHub metadata & tree', status: 'ran', detail: `${src.files.length} files listed at ${commit.sha.slice(0, 7)}${src.truncated ? ' (truncated by GitHub)' : ''}` });
      } else {
        src = await localSource(repo.local_path!);
        languages = languagesFromSizes(src.sizes);
        const git = await localGitInfo(repo.local_path!);
        meta = {
          default_branch: git?.branch ?? null,
          latest_commit: git ? JSON.stringify({ sha: git.sha, message: git.message, author: git.author, date: git.date, url: null }) : null,
        };
        checks.push({ name: 'Local file walk', status: 'ran', detail: `${src.files.length} files${src.truncated ? ' (capped at 20,000)' : ''}; symlinks not followed` });
      }

      const { arch, frameworks } = await detectArchitecture(src);
      checks.push({ name: 'Architecture detection', status: 'ran', detail: `${arch.manifests.length} manifests, ${arch.workflows.length} workflows, ${arch.dockerfiles.length} Dockerfiles, ${arch.terraform.length} Terraform files` });

      const findings: Finding[] = [];
      const ran = new Set<string>();
      const runRule = async (label: string, files: string[], fn: (f: string, t: string) => Finding[]) => {
        let count = 0;
        for (const file of files) {
          const text = await src.read(file);
          if (text === null) continue;
          const out = fn(file, text);
          count += out.length;
          findings.push(...out);
        }
        checks.push({ name: label, status: files.length ? 'ran' : 'skipped', detail: files.length ? `${files.length} file(s)` : 'No matching files', findings: count });
      };
      await runRule('GitHub Actions workflow rules', arch.workflows, checkWorkflow);
      await runRule('Dockerfile rules', arch.dockerfiles, checkDockerfile);
      await runRule('Terraform rules', arch.terraform.slice(0, 100), checkTerraform);
      await runRule('Kubernetes rules', arch.kubernetes, checkKubernetes);
      ran.add('sentinelops-config').add('sentinelops-container').add('sentinelops-iac').add('sentinelops-supply-chain');

      // Secret scan: complete for local repos; prioritised and bounded for remote repos.
      const candidates = src.files.filter(shouldScanForSecrets);
      const prioritised = src.kind === 'local'
        ? candidates
        : [...candidates].sort((a, b) => secretPriority(b) - secretPriority(a)).slice(0, REMOTE_SECRET_SCAN_LIMIT);
      let secretCount = 0;
      for (const file of prioritised) {
        const text = await src.read(file);
        if (text === null) continue;
        src.scannedForSecrets.add(file);
        const out = scanSecrets(file, text);
        secretCount += out.length;
        findings.push(...out);
      }
      checks.push({
        name: 'Secret pattern scan',
        status: 'ran',
        detail: src.kind === 'local' ? `${src.scannedForSecrets.size} files scanned` : `${src.scannedForSecrets.size} of ${candidates.length} candidate files scanned (config/env/CI files first). Enable GitHub secret scanning or analyse a local clone for full coverage.`,
        findings: secretCount,
      });
      ran.add('sentinelops-secrets');

      const hygiene = checkHygiene(arch, src);
      findings.push(...hygiene);
      ran.add('sentinelops-hygiene');
      checks.push({ name: 'Repository hygiene & documentation', status: 'ran', detail: 'README, SECURITY, lockfiles, CI, tests, .env files', findings: hygiene.length });

      const { deps, unresolved } = await extractDependencies(src);
      if (opts.dependencyAdvisories) {
        const osv = await osvFindings(deps);
        if (osv.error) checks.push({ name: 'Dependency advisories (OSV.dev)', status: 'failed', detail: osv.error });
        else {
          ran.add('osv.dev');
          findings.push(...osv.findings);
          checks.push({ name: 'Dependency advisories (OSV.dev)', status: 'ran', detail: `${osv.queried} package versions checked; ${osv.vulnerable} affected${unresolved.length ? `; ${unresolved.length} unpinned entries not checkable` : ''}`, findings: osv.findings.length });
        }
      } else {
        checks.push({ name: 'Dependency advisories (OSV.dev)', status: 'skipped', detail: 'Disabled for this analysis' });
      }

      if (repo.kind === 'github') {
        const [owner, name] = repo.full_name.split('/') as [string, string];
        const alerts = await this.gh.optional<{ number: number; state: string; security_advisory: { ghsa_id: string; summary: string; severity: string }; dependency: { package: { name: string; ecosystem: string }; manifest_path: string } }[]>(`/repos/${owner}/${name}/dependabot/alerts?state=open&per_page=100`);
        if (alerts.data) {
          ran.add('dependabot');
          for (const a of alerts.data) {
            const sev = a.security_advisory.severity.toLowerCase();
            findings.push({
              ruleId: a.security_advisory.ghsa_id, source: 'dependabot', severity: (['critical', 'high', 'medium', 'low'].includes(sev) ? sev : 'medium') as Finding['severity'],
              title: `${a.dependency.package.name}: ${a.security_advisory.summary}`, file: a.dependency.manifest_path, package: `${a.dependency.package.ecosystem}:${a.dependency.package.name}`,
              explanation: `Open Dependabot alert #${a.number}.`, remediation: 'Merge the Dependabot security update or upgrade the dependency manually.',
              reference: `https://github.com/${owner}/${name}/security/dependabot/${a.number}`, key: `dependabot|${a.number}`,
            });
          }
          checks.push({ name: 'Dependabot alerts', status: 'ran', detail: `${alerts.data.length} open alert(s)`, findings: alerts.data.length });
        } else {
          checks.push({ name: 'Dependabot alerts', status: 'skipped', detail: `Unavailable (HTTP ${alerts.status}): requires admin/security access or Dependabot alerts disabled` });
        }
      }

      if (src.kind === 'local') {
        const scanners = await detectScanners();
        for (const s of scanners) {
          if (!s.available) {
            checks.push({ name: s.name, status: 'skipped', detail: 'Not installed on this machine' });
            continue;
          }
          try {
            const out = s.name === 'gitleaks' ? await runGitleaks(repo.local_path!) : s.name === 'trivy' ? await runTrivy(repo.local_path!) : null;
            if (out) {
              findings.push(...out);
              ran.add(s.name);
              checks.push({ name: s.name, status: 'ran', detail: s.version ?? '', findings: out.length });
            } else checks.push({ name: s.name, status: 'skipped', detail: 'Installed but not wired into analysis yet' });
          } catch (err) {
            checks.push({ name: s.name, status: 'failed', detail: (err as Error).message.slice(0, 200) });
          }
        }
      }

      const summary = {
        architecture: arch,
        dependencies: { total: deps.length, direct: deps.filter((d) => d.direct).length, byEcosystem: countBy(deps, (d) => d.ecosystem), unresolved, sample: deps.filter((d) => d.direct).slice(0, 200) },
        fileCount: src.files.length,
        truncated: src.truncated,
        secretScanCoverage: { scanned: src.scannedForSecrets.size, candidates: candidates.length },
      };
      const counts = this.persist(repo, analysisId, findings, ran, summary, checks, languages, frameworks, meta);
      const level = counts.critical ? 'critical' : counts.high ? 'warning' : 'success';
      this.bus.publish('analysis.completed', level, `Analysis of ${repo.full_name} finished — ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium open findings`, `/repositories/${repo.id}`);
      if (counts.critical > 0) {
        this.incidents.open({ source: 'security', ref: `repo:${repo.id}:critical`, title: `${counts.critical} critical security finding(s) in ${repo.full_name}`, severity: 'critical', repoId: repo.id });
      } else {
        this.incidents.resolveByRef('security', `repo:${repo.id}:critical`, 'No critical findings remain open after re-analysis');
      }
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      this.db.prepare("UPDATE analyses SET status = 'failed', finished_at = ?, error = ?, checks_run = ? WHERE id = ?").run(now(), message, JSON.stringify(checks), analysisId);
      this.db.prepare("UPDATE repositories SET last_analysis_status = 'failed', last_error = ? WHERE id = ?").run(message, repo.id);
      this.bus.publish('analysis.failed', 'critical', `Analysis of ${repo.full_name} failed: ${message}`, `/repositories/${repo.id}`);
    } finally {
      this.bus.invalidate('repositories');
    }
  }

  private persist(
    repo: RepoRow,
    analysisId: number,
    findings: Finding[],
    ranSources: Set<string>,
    summary: unknown,
    checks: CheckRecord[],
    languages: Record<string, number>,
    frameworks: string[],
    meta: Record<string, unknown>,
  ): Record<'critical' | 'high' | 'medium' | 'low' | 'info', number> {
    const ts = now();
    return tx(this.db, () => {
      const upsert = this.db.prepare(`
        INSERT INTO findings (repo_id, fingerprint, rule_id, source, severity, title, file, line, package, evidence, explanation, remediation, reference, status, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(repo_id, fingerprint) DO UPDATE SET
          severity = excluded.severity, title = excluded.title, file = excluded.file, line = excluded.line, evidence = excluded.evidence,
          explanation = excluded.explanation, remediation = excluded.remediation, reference = excluded.reference, last_seen = excluded.last_seen,
          status = CASE WHEN findings.status = 'resolved' THEN 'open' ELSE findings.status END,
          resolved_at = CASE WHEN findings.status = 'resolved' THEN NULL ELSE findings.resolved_at END`);
      const seen = new Set<string>();
      for (const f of findings) {
        const fp = sha256(f.key);
        if (seen.has(fp)) continue;
        seen.add(fp);
        upsert.run(repo.id, fp, f.ruleId, f.source, f.severity, f.title.slice(0, 300), f.file ?? null, f.line ?? null, f.package ?? null, f.evidence ?? null, f.explanation, f.remediation, f.reference ?? null, ts, ts);
      }
      // A finding is "resolved" only if the check that produced it ran again and no longer reports it.
      const open = this.db.prepare("SELECT id, fingerprint, source FROM findings WHERE repo_id = ? AND status = 'open'").all(repo.id) as { id: number; fingerprint: string; source: string }[];
      const resolve = this.db.prepare("UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ?");
      for (const row of open) if (!seen.has(row.fingerprint) && ranSources.has(row.source)) resolve.run(ts, row.id);

      const counts = Object.fromEntries(
        (this.db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE repo_id = ? AND status = 'open' GROUP BY severity").all(repo.id) as { severity: string; n: number }[]).map((r) => [r.severity, r.n]),
      ) as Record<string, number>;
      for (const s of ['critical', 'high', 'medium', 'low', 'info']) counts[s] ??= 0;
      const typed = counts as Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;

      this.db.prepare("UPDATE analyses SET status = 'completed', finished_at = ?, summary = ?, checks_run = ? WHERE id = ?").run(ts, JSON.stringify({ ...(summary as object), counts }), JSON.stringify(checks), analysisId);
      const sets = ['languages = ?', 'frameworks = ?', 'last_analyzed_at = ?', "last_analysis_status = 'completed'", 'last_error = NULL'];
      const values: (string | number | null)[] = [JSON.stringify(languages), JSON.stringify(frameworks), ts];
      for (const [k, v] of Object.entries(meta)) {
        sets.push(`${k} = ?`);
        values.push(v as string | number | null);
      }
      this.db.prepare(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`).run(...values, repo.id);
      return typed;
    });
  }
}

function secretPriority(file: string): number {
  const b = path.posix.basename(file).toLowerCase();
  if (b.startsWith('.env')) return 10;
  if (/\.(ya?ml|json|toml|ini|cfg|conf|properties|tf|tfvars)$/.test(b)) return 6;
  if (/config|settings|secret|credential|auth/.test(file.toLowerCase())) return 5;
  if (file.startsWith('.github/')) return 4;
  return /\.(md|txt)$/.test(b) ? 0 : 2;
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

export function latestArchitecture(db: DB, repoId: number): Architecture | null {
  const row = db.prepare("SELECT summary FROM analyses WHERE repo_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1").get(repoId) as { summary: string } | undefined;
  return parseJson<{ architecture?: Architecture }>(row?.summary, {}).architecture ?? null;
}
