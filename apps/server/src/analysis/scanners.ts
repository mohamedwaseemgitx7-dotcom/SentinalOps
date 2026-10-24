import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { redactSecret, type Finding, type Severity } from './rules.ts';

const execFileP = promisify(execFile);

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
  const [gitleaks, trivy, semgrep] = await Promise.all([version('gitleaks', ['version']), version('trivy', ['--version']), version('semgrep', ['--version'])]);
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
    await execFileP('gitleaks', ['detect', '--no-git', '--redact', '--source', root, '--report-format', 'json', '--report-path', report, '--exit-code', '0'], {
      timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const items = JSON.parse(fs.readFileSync(report, 'utf8')) as { RuleID: string; Description: string; File: string; StartLine: number; Fingerprint: string; Match: string }[];
    return items.map((i) => {
      const rel = path.relative(root, i.File).split(path.sep).join('/');
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
  const { stdout } = await execFileP('trivy', ['fs', '--quiet', '--format', 'json', '--scanners', 'vuln,misconfig', root], {
    timeout: 300_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
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
