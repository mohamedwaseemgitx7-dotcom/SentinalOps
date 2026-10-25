import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { redactSecret, type Finding, type Severity } from './rules.ts';

const execFileP = promisify(execFile);

// Project-local tool folder (checksum-verified binaries, see docs/INSTALLATION-LOG.md); falls back to PATH.
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const TOOLS_DIR = process.env.SENTINELOPS_TOOLS_DIR ?? path.join(repoRoot, '.tools');
const TRIVY_CACHE = process.env.TRIVY_CACHE_DIR ?? path.join(repoRoot, '.cache', 'trivy');

function bin(name: string): string {
  const local = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}

export interface ScannerStatus {
  name: string;
  available: boolean;
  version: string | null;
}

async function version(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(bin, args, { timeout: 10_000, windowsHide: true });
    return stdout.trim().split('\n')[0]!.slice(0, 80);
  } catch {
    return null;
  }
}

export async function detectScanners(): Promise<ScannerStatus[]> {
  const [gitleaks, trivy, semgrep] = await Promise.all([version(bin('gitleaks'), ['version']), version(bin('trivy'), ['--version']), version(bin('semgrep'), ['--version'])]);
  return [
    { name: 'gitleaks', available: !!gitleaks, version: gitleaks },
    { name: 'trivy', available: !!trivy, version: trivy },
    { name: 'semgrep', available: !!semgrep, version: semgrep },
  ];
}

/** Gitleaks on a local, authorised working copy. Output is redacted by gitleaks itself (--redact). */
export async function runGitleaks(root: string): Promise<Finding[]> {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'so-gl-')), 'report.json');
  try {
    // Git repositories: scan tracked history (skips untracked node_modules/build output). Otherwise scan the folder.
    const mode = fs.existsSync(path.join(root, '.git')) ? ['git', root] : ['dir', root];
    await execFileP(bin('gitleaks'), [...mode, '--redact', '--report-format', 'json', '--report-path', report, '--exit-code', '0', '--no-banner'], {
      timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const items = JSON.parse(fs.readFileSync(report, 'utf8')) as { RuleID: string; Description: string; File: string; StartLine: number; Fingerprint: string; Match: string }[];
    return items.map((i) => {
      const rel = (path.isAbsolute(i.File) ? path.relative(root, i.File) : i.File).split(path.sep).join('/');
      return {
        ruleId: `gitleaks:${i.RuleID}`, source: 'gitleaks', severity: 'high' as Severity, title: i.Description, file: rel, line: i.StartLine,
        evidence: i.Match.includes('REDACTED') ? i.Match.slice(0, 200) : redactSecret(i.Match),
        explanation: 'Gitleaks matched a credential pattern in this file.',
        remediation: 'Rotate the credential, remove it from the code and history, and load it from a secret store.',
        reference: 'https://github.com/gitleaks/gitleaks', key: `gitleaks|${rel}|${i.RuleID}|${i.StartLine}`,
      };
    });
  } finally {
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
  }
}

const TRIVY_SEV: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'info' };

export async function runTrivy(root: string): Promise<Finding[]> {
  fs.mkdirSync(path.join(TRIVY_CACHE, 'docker-config'), { recursive: true });
  const { stdout } = await execFileP(bin('trivy'), ['fs', '--quiet', '--format', 'json', '--scanners', 'vuln,misconfig', '--cache-dir', TRIVY_CACHE, '--skip-dirs', 'node_modules', '--skip-dirs', '.cache', '--skip-dirs', '.tools', root], {
    timeout: 600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    // Isolated Docker config: a stale credential helper in ~/.docker would break anonymous DB downloads.
    env: { ...process.env, DOCKER_CONFIG: path.join(TRIVY_CACHE, 'docker-config') },
  });
  const report = JSON.parse(stdout) as {
    Results?: {
      Target: string;
      Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string; Description?: string; PrimaryURL?: string }[];
      Misconfigurations?: { ID: string; Title: string; Severity: string; Message: string; Resolution: string; PrimaryURL?: string; CauseMetadata?: { StartLine?: number } }[];
    }[];
  };
  const out: Finding[] = [];
  for (const r of report.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      out.push({
        ruleId: v.VulnerabilityID, source: 'trivy', severity: TRIVY_SEV[v.Severity] ?? 'medium', title: `${v.PkgName}@${v.InstalledVersion}: ${v.Title ?? v.VulnerabilityID}`,
        file: r.Target, package: `${v.PkgName}@${v.InstalledVersion}`, explanation: (v.Description ?? '').slice(0, 1200),
        remediation: v.FixedVersion ? `Upgrade ${v.PkgName} to ${v.FixedVersion}.` : 'No fix available yet; assess exploitability.',
        reference: v.PrimaryURL, key: `trivy|${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`,
      });
    }
    for (const m of r.Misconfigurations ?? []) {
      out.push({
        ruleId: `trivy:${m.ID}`, source: 'trivy', severity: TRIVY_SEV[m.Severity] ?? 'medium', title: m.Title, file: r.Target, line: m.CauseMetadata?.StartLine,
        explanation: m.Message, remediation: m.Resolution, reference: m.PrimaryURL, key: `trivy|${m.ID}|${r.Target}|${m.CauseMetadata?.StartLine ?? ''}`,
      });
    }
  }
  return out;
}
