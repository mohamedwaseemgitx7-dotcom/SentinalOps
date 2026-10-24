import type { GitHubClient } from '../github/client.ts';
import { checkDockerfile, checkTerraform, checkWorkflow, scanSecrets, type Finding } from './rules.ts';

export type GateStatus = 'pass' | 'warn' | 'block' | 'unavailable';

export interface GateRule {
  id: string;
  name: string;
  status: GateStatus;
  detail: string;
  items?: string[];
}

export interface GateReport {
  repo: string;
  number: number;
  title: string;
  author: string | null;
  headSha: string;
  baseRef: string;
  url: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  overall: GateStatus;
  rules: GateRule[];
  generatedAt: string;
}

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/**
 * Evaluates a pull request using only metadata and diffs from the GitHub API.
 * PR code is never checked out or executed.
 */
export async function evaluatePullRequest(gh: GitHubClient, fullName: string, number: number): Promise<GateReport> {
  const pr = await gh.json<{ title: string; user: { login: string } | null; head: { sha: string }; base: { ref: string }; html_url: string; changed_files: number; additions: number; deletions: number }>(`/repos/${fullName}/pulls/${number}`);
  const files: PrFile[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh.json<PrFile[]>(`/repos/${fullName}/pulls/${number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const rules: GateRule[] = [];

  // 1. CI checks reported on the head commit.
  const checks = await gh.optional<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(`/repos/${fullName}/commits/${pr.head.sha}/check-runs?per_page=100`);
  if (checks.data) {
    const runs = checks.data.check_runs;
    const failed = runs.filter((c) => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(c.conclusion ?? ''));
    const pending = runs.filter((c) => c.status !== 'completed');
    rules.push({
      id: 'ci-checks', name: 'CI checks',
      status: failed.length ? 'block' : pending.length ? 'warn' : runs.length ? 'pass' : 'warn',
      detail: runs.length ? `${runs.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} pending` : 'No check runs reported for the head commit',
      items: failed.map((c) => `${c.name}: ${c.conclusion}`),
    });
  } else rules.push({ id: 'ci-checks', name: 'CI checks', status: 'unavailable', detail: `Check runs not accessible (HTTP ${checks.status})` });

  // 2. Secrets in added lines.
  const secretHits: Finding[] = [];
  for (const f of files) for (const added of addedLines(f)) secretHits.push(...scanSecrets(f.filename, added.text).map((h) => ({ ...h, line: added.line })));
  rules.push({
    id: 'secrets', name: 'Secret exposure', status: secretHits.some((h) => h.severity === 'critical' || h.severity === 'high') ? 'block' : secretHits.length ? 'warn' : 'pass',
    detail: secretHits.length ? `${secretHits.length} possible credential(s) in added lines (values redacted)` : 'No credential patterns in added lines',
    items: secretHits.map((h) => `${h.file}:${h.line} — ${h.title}`),
  });

  // 3. Config rules over the added content of workflow, Docker and Terraform files.
  const cfg: Finding[] = [];
  for (const f of files) {
    if (f.status === 'removed') continue;
    const added = addedLines(f).map((l) => l.text).join('\n');
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(f.filename)) {
      const content = await gh.text(`/repos/${fullName}/contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=${pr.head.sha}`, 512 * 1024);
      // The whole file is checked, but unpinned-action findings only count when this PR added that line.
      if (content) cfg.push(...checkWorkflow(f.filename, content).filter((x) => x.severity !== 'info' && (x.ruleId !== 'GHA-UNPINNED-ACTION' || added.includes(x.evidence?.replace('uses: ', '') ?? '\0'))));
    } else if (/(^|\/)dockerfile/i.test(f.filename)) {
      cfg.push(...checkDockerfile(f.filename, added).filter((x) => !['DKR-RUNS-AS-ROOT', 'DKR-NO-HEALTHCHECK'].includes(x.ruleId)));
    } else if (f.filename.endsWith('.tf')) {
      cfg.push(...checkTerraform(f.filename, added));
    }
  }
  rules.push({
    id: 'config', name: 'CI / container / IaC configuration', status: cfg.some((c) => c.severity === 'critical' || c.severity === 'high') ? 'block' : cfg.length ? 'warn' : 'pass',
    detail: cfg.length ? `${cfg.length} configuration finding(s) introduced` : 'No risky configuration introduced',
    items: cfg.map((c) => `[${c.severity}] ${c.file}: ${c.title}`),
  });

  // 4. Dependency changes.
  const depChanges: string[] = [];
  let majorBumps = 0;
  for (const f of files.filter((x) => /(^|\/)(package\.json|requirements[-\w]*\.txt|go\.mod|pyproject\.toml|Cargo\.toml)$/.test(x.filename))) {
    const removed = new Map<string, string>();
    for (const l of (f.patch ?? '').split('\n')) {
      const m = l.match(/^-\s*"([^"]+)":\s*"([^"]+)"/);
      if (m) removed.set(m[1]!, m[2]!);
    }
    for (const l of (f.patch ?? '').split('\n')) {
      const m = l.match(/^\+\s*"([^"]+)":\s*"([^"]+)"/) ?? l.match(/^\+\s*([A-Za-z0-9._-]+)\s*==\s*([\w.]+)/);
      if (!m || ['version', 'name', 'main', 'type', 'description'].includes(m[1]!)) continue;
      const before = removed.get(m[1]!);
      const major = (v: string) => Number(v.replace(/^[^\d]*/, '').split('.')[0]);
      if (before && major(before) < major(m[2]!)) majorBumps++;
      depChanges.push(before ? `${m[1]}: ${before} → ${m[2]}` : `+ ${m[1]}@${m[2]}`);
    }
  }
  const lockChanged = files.some((f) => /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum)$/.test(f.filename));
  rules.push({
    id: 'dependencies', name: 'Dependency changes',
    status: majorBumps ? 'warn' : depChanges.length && !lockChanged ? 'warn' : 'pass',
    detail: depChanges.length ? `${depChanges.length} change(s)${majorBumps ? `, ${majorBumps} major version bump(s)` : ''}${!lockChanged ? '; lockfile not updated' : ''}` : 'No manifest dependency changes',
    items: depChanges.slice(0, 50),
  });

  // 5. Tests accompany source changes.
  const isTest = (p: string) => /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__|e2e)\/|(^|\/)test_[^/]+\.py$/i.test(p);
  const isSource = (p: string) => /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|cs|rb|php)$/.test(p) && !isTest(p);
  const srcChanged = files.filter((f) => isSource(f.filename) && f.status !== 'removed');
  const testsChanged = files.filter((f) => isTest(f.filename));
  const srcLines = srcChanged.reduce((n, f) => n + f.additions, 0);
  rules.push({
    id: 'tests', name: 'Tests for changed code',
    status: srcLines > 30 && testsChanged.length === 0 ? 'warn' : 'pass',
    detail: srcChanged.length ? `${srcChanged.length} source file(s) (+${srcLines} lines), ${testsChanged.length} test file(s) changed` : 'No source changes',
  });

  // 6. Potentially breaking changes (heuristic).
  const breaking: string[] = [];
  for (const f of files) {
    if (f.status === 'removed' && isSource(f.filename)) breaking.push(`Removed ${f.filename}`);
    if (f.status === 'renamed' && f.previous_filename && isSource(f.filename)) breaking.push(`Renamed ${f.previous_filename} → ${f.filename}`);
    for (const l of (f.patch ?? '').split('\n')) {
      if (/^-\s*export\s+(?:async\s+)?(?:function|const|class|interface|type|default)\s+(\w+)/.test(l)) {
        const name = l.match(/(?:function|const|class|interface|type)\s+(\w+)/)?.[1];
        const readded = (f.patch ?? '').split('\n').some((x) => x.startsWith('+') && /\bexport\b/.test(x) && new RegExp(`\\b${name}\\b`).test(x));
        if (name && !readded) breaking.push(`${f.filename}: export ${name} removed`);
      }
      if (/^-\s*(ALTER|DROP)\s+TABLE|^\+\s*DROP\s+(TABLE|COLUMN)/i.test(l)) breaking.push(`${f.filename}: destructive SQL`);
    }
    if (/migrations?\//i.test(f.filename) && f.status !== 'removed') breaking.push(`Migration: ${f.filename}`);
  }
  rules.push({
    id: 'breaking', name: 'Potentially breaking changes', status: breaking.length ? 'warn' : 'pass',
    detail: breaking.length ? `${breaking.length} change(s) worth reviewing (heuristic)` : 'None detected (heuristic)', items: breaking.slice(0, 30),
  });

  // 7. Size.
  const size = pr.additions + pr.deletions;
  rules.push({ id: 'size', name: 'Change size', status: size > 1000 ? 'warn' : 'pass', detail: `${pr.changed_files} files, +${pr.additions} / −${pr.deletions}${size > 1000 ? ' — consider splitting for reviewability' : ''}` });

  const overall = rules.some((r) => r.status === 'block') ? 'block' : rules.some((r) => r.status === 'warn') ? 'warn' : 'pass';
  return {
    repo: fullName, number, title: pr.title, author: pr.user?.login ?? null, headSha: pr.head.sha, baseRef: pr.base.ref, url: pr.html_url,
    changedFiles: pr.changed_files, additions: pr.additions, deletions: pr.deletions, overall, rules, generatedAt: new Date().toISOString(),
  };
}

function addedLines(f: PrFile): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = 0;
  for (const l of (f.patch ?? '').split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (l.startsWith('-')) continue;
    line++;
    if (l.startsWith('+')) out.push({ line, text: l.slice(1) });
  }
  return out;
}

export function gateMarkdown(r: GateReport): string {
  const icon: Record<GateStatus, string> = { pass: '✅', warn: '⚠️', block: '⛔', unavailable: '❔' };
  const rows = r.rules.map((x) => `| ${icon[x.status]} ${x.status} | ${x.name} | ${x.detail.replace(/\|/g, '\\|')} |`).join('\n');
  const details = r.rules
    .filter((x) => x.items?.length)
    .map((x) => `<details><summary>${x.name}</summary>\n\n${x.items!.map((i) => `- ${i.replace(/[<>]/g, '')}`).join('\n')}\n</details>`)
    .join('\n');
  return `### SentinelOps PR Gatekeeper: ${icon[r.overall]} ${r.overall.toUpperCase()}\n\n| Status | Rule | Detail |\n|---|---|---|\n${rows}\n\n${details}\n\n<sub>Evaluated ${r.headSha.slice(0, 7)} from metadata and diffs only — PR code was not executed. Heuristic rules are advisory.</sub>`;
}

export const _test = { addedLines };
