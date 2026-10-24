import path from 'node:path';
import YAML from 'yaml';
import { sha256 } from '../lib/crypto.ts';
import type { Architecture } from './detect.ts';
import type { RepoSource } from './source.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  ruleId: string;
  source: string;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  package?: string;
  evidence?: string;
  explanation: string;
  remediation: string;
  reference?: string;
  /** Stable key used to track a finding across analyses. */
  key: string;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

interface SecretPattern {
  id: string;
  name: string;
  re: RegExp;
  severity: Severity;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'SEC-AWS-KEY', name: 'AWS access key ID', re: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g, severity: 'critical' },
  { id: 'SEC-GH-TOKEN', name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, severity: 'critical' },
  { id: 'SEC-GH-PAT', name: 'GitHub fine-grained token', re: /\b(github_pat_[A-Za-z0-9_]{60,})\b/g, severity: 'critical' },
  { id: 'SEC-PRIVATE-KEY', name: 'Private key', re: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----)/g, severity: 'critical' },
  { id: 'SEC-SLACK', name: 'Slack token', re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, severity: 'high' },
  { id: 'SEC-STRIPE', name: 'Stripe live secret key', re: /\b(sk_live_[A-Za-z0-9]{20,})\b/g, severity: 'critical' },
  { id: 'SEC-GOOGLE-API', name: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, severity: 'high' },
  { id: 'SEC-OPENAI', name: 'OpenAI API key', re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/g, severity: 'high' },
  { id: 'SEC-ANTHROPIC', name: 'Anthropic API key', re: /\b(sk-ant-[A-Za-z0-9_-]{32,})\b/g, severity: 'high' },
  { id: 'SEC-NPM', name: 'npm access token', re: /\b(npm_[A-Za-z0-9]{36})\b/g, severity: 'high' },
  { id: 'SEC-DB-URL', name: 'Database URL with embedded password', re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/'"]+:[^@\s'"]{3,}@[^\s'"]+)/g, severity: 'high' },
  {
    id: 'SEC-GENERIC',
    name: 'Hard-coded credential',
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\s$<>{}]{8,})["']/gi,
    severity: 'medium',
  },
];

const PLACEHOLDER = /^(x+|\*+|changeme|change[-_]?me|example|placeholder|your[-_].*|<.*>|test|dummy|sample|null|undefined|redacted|\.\.\.)$/i;
const SECRET_SCAN_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|java|kt|cs|php|rs|sh|ps1|env|ya?ml|json|toml|ini|cfg|conf|properties|tf|tfvars|xml|txt|md|dockerfile)$/i;
const SECRET_SKIP = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.js|\.map|(^|\/)fixtures?\/|(^|\/)testdata\/)$/i;

const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__|e2e|fixtures?)\//i;

/** Generic assignments only count when the value mixes character classes like real credentials do. */
function looksLikeCredential(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2 && !/\s/.test(value);
}

function hasKeyBody(line: string, nextLine: string | undefined): boolean {
  // Prefix match: bodies inside YAML/JSON strings may end with a quote or comma.
  const BODY = /^[A-Za-z0-9+/=]{40,}/;
  const after = line.slice(line.indexOf('KEY-----') + 'KEY-----'.length);
  // Inline PEM in JSON/env values uses escaped newlines: "-----BEGIN ...-----\nMIIE..."
  return /^(\\n|\\r\\n)[A-Za-z0-9+/]{40}/.test(after) || BODY.test((nextLine ?? '').trim());
}

export function redactSecret(value: string): string {
  if (value.startsWith('-----BEGIN')) return '-----BEGIN … PRIVATE KEY----- [redacted]';
  const keep = Math.min(4, Math.floor(value.length / 4));
  return `${value.slice(0, keep)}${'•'.repeat(8)} (${value.length} chars, redacted)`;
}

export function scanSecrets(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const pat of SECRET_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 4000) continue;
      pat.re.lastIndex = 0;
      for (const m of line.matchAll(pat.re)) {
        const secret = m[1]!;
        if (pat.id === 'SEC-GENERIC' && (PLACEHOLDER.test(secret) || !looksLikeCredential(secret) || /process\.env|os\.environ|\$\{|getenv/i.test(line))) continue;
        if (pat.id === 'SEC-DB-URL' && /(:\/\/[^:]+:(password|pass|\$\{|<))/i.test(secret)) continue;
        // A key header alone (docs, regexes, redaction code) is not a key: require a base64 body.
        if (pat.id === 'SEC-PRIVATE-KEY' && !hasKeyBody(line, lines[i + 1])) continue;
        const inTest = TEST_FILE.test(file);
        out.push({
          ruleId: pat.id,
          source: 'sentinelops-secrets',
          severity: inTest && pat.severity !== 'critical' ? 'low' : pat.severity,
          title: `${pat.name} committed to source${inTest ? ' (test file)' : ''}`,
          file,
          line: i + 1,
          evidence: line.replace(secret, redactSecret(secret)).trim().slice(0, 240),
          explanation: `A value matching the ${pat.name} format is present in ${file}. Anyone with read access to the repository (or its history) can use it.`,
          remediation: 'Revoke and rotate the credential with its issuer first, then remove it from the code and Git history (e.g. git filter-repo) and load it from a secret store or environment variable.',
          reference: 'https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning',
          key: `${pat.id}|${file}|${sha256(secret).slice(0, 16)}`,
        });
      }
    }
  }
  return out;
}

export function shouldScanForSecrets(file: string): boolean {
  const b = path.posix.basename(file).toLowerCase();
  return !SECRET_SKIP.test(file) && (SECRET_SCAN_EXT.test(file) || b === 'dockerfile' || b.startsWith('.env'));
}

// ---------------------------------------------------------------------------
// GitHub Actions workflows
// ---------------------------------------------------------------------------

const UNTRUSTED_CONTEXT = /\$\{\{\s*github\.(event\.(issue\.(title|body)|pull_request\.(title|body|head\.ref|head\.label)|comment\.body|review\.body|review_comment\.body|pages\.[^}]*\.page_name|commits\.[^}]*\.(message|author\.(email|name))|head_commit\.(message|author\.(email|name))|workflow_run\.head_branch)|head_ref)\s*\}\}/;

interface WorkflowDoc {
  on?: unknown;
  true?: unknown; // YAML 1.1 parses bare `on:` as boolean true in some parsers
  permissions?: unknown;
  jobs?: Record<string, { permissions?: unknown; steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[]; 'runs-on'?: unknown; 'timeout-minutes'?: number }>;
}

function lineOf(text: string, needle: string): number | undefined {
  const idx = text.indexOf(needle);
  return idx < 0 ? undefined : text.slice(0, idx).split('\n').length;
}

export function checkWorkflow(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  let doc: WorkflowDoc;
  try {
    doc = YAML.parse(text) as WorkflowDoc;
  } catch (err) {
    return [{
      ruleId: 'GHA-INVALID-YAML', source: 'sentinelops-config', severity: 'high', title: 'Workflow file is not valid YAML', file,
      evidence: String((err as Error).message).slice(0, 200),
      explanation: 'GitHub will refuse to run this workflow, so its checks silently stop protecting the branch.',
      remediation: 'Fix the YAML syntax (actionlint can validate workflows locally).', key: `GHA-INVALID-YAML|${file}`,
    }];
  }
  if (!doc || typeof doc !== 'object') return out;
  const triggers = JSON.stringify(doc.on ?? doc.true ?? '');
  const jobs = doc.jobs ?? {};

  if (doc.permissions === undefined && Object.values(jobs).some((j) => j?.permissions === undefined)) {
    out.push({
      ruleId: 'GHA-NO-PERMISSIONS', source: 'sentinelops-config', severity: 'low', title: 'Workflow does not restrict GITHUB_TOKEN permissions', file,
      explanation: 'Without a `permissions:` block the token gets the repository default, which may include write access to contents, packages and more.',
      remediation: 'Add `permissions: { contents: read }` at the top level and grant extra scopes per job only where needed.',
      reference: 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication',
      key: `GHA-NO-PERMISSIONS|${file}`,
    });
  }
  if (JSON.stringify(doc.permissions ?? '') === '"write-all"' || Object.values(jobs).some((j) => j?.permissions === 'write-all')) {
    out.push({
      ruleId: 'GHA-WRITE-ALL', source: 'sentinelops-config', severity: 'medium', title: 'Workflow grants write-all token permissions', file, line: lineOf(text, 'write-all'),
      explanation: 'A compromised step or dependency in this workflow could push code, publish packages or alter releases.',
      remediation: 'Replace write-all with the specific scopes each job needs.', key: `GHA-WRITE-ALL|${file}`,
    });
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    if (job['timeout-minutes'] === undefined && Array.isArray(job.steps)) {
      out.push({
        ruleId: 'GHA-NO-TIMEOUT', source: 'sentinelops-config', severity: 'info', title: `Job "${jobName}" has no timeout`, file,
        explanation: 'Hung jobs run for the default 6 hours and consume runner minutes.',
        remediation: 'Set `timeout-minutes` to a realistic upper bound for the job.', key: `GHA-NO-TIMEOUT|${file}|${jobName}`,
      });
    }
    for (const step of job.steps ?? []) {
      if (step?.uses && !step.uses.startsWith('./') && !step.uses.startsWith('docker://')) {
        const [action, ref = ''] = step.uses.split('@');
        const pinned = /^[0-9a-f]{40}$/.test(ref);
        if (!pinned) {
          const firstParty = /^(actions|github)\//.test(action!);
          out.push({
            ruleId: 'GHA-UNPINNED-ACTION', source: 'sentinelops-supply-chain', severity: firstParty ? 'info' : 'medium',
            title: `Action ${action} is referenced by tag, not commit SHA`, file, line: lineOf(text, step.uses), package: action,
            evidence: `uses: ${step.uses}`,
            explanation: firstParty
              ? 'First-party actions are lower risk, but tags are mutable and can be moved.'
              : 'Third-party action tags are mutable; if the action repository is compromised, the tag can be repointed to malicious code that runs with your secrets.',
            remediation: `Pin to a full commit SHA, e.g. \`${action}@<40-char-sha> # ${ref || 'vX'}\`, and let Dependabot update it.`,
            reference: 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions',
            key: `GHA-UNPINNED-ACTION|${file}|${step.uses}`,
          });
        }
      }
      if (step?.run && UNTRUSTED_CONTEXT.test(step.run)) {
        const expr = step.run.match(UNTRUSTED_CONTEXT)![0];
        out.push({
          ruleId: 'GHA-SCRIPT-INJECTION', source: 'sentinelops-config', severity: 'high', title: 'Untrusted input interpolated into a shell command', file,
          line: lineOf(text, expr), evidence: expr,
          explanation: 'Attacker-controlled text (titles, branch names, commit messages) is expanded before the shell runs, allowing command injection with the job\'s token and secrets.',
          remediation: 'Pass the value through an environment variable (`env: TITLE: ${{ ... }}`) and reference it as "$TITLE" in the script.',
          reference: 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#understanding-the-risk-of-script-injections',
          key: `GHA-SCRIPT-INJECTION|${file}|${jobName}|${expr}`,
        });
      }
      if (triggers.includes('pull_request_target') && step?.uses?.startsWith('actions/checkout') && /head\.(sha|ref)|github\.head_ref/.test(JSON.stringify(step.with ?? {}))) {
        out.push({
          ruleId: 'GHA-PRT-CHECKOUT', source: 'sentinelops-config', severity: 'critical', title: 'pull_request_target workflow checks out untrusted PR code', file,
          line: lineOf(text, 'pull_request_target'),
          explanation: 'pull_request_target runs with write tokens and secrets; checking out and building the PR head lets any fork author execute code with those privileges ("pwn request").',
          remediation: 'Use the `pull_request` trigger for building untrusted code, or split into an unprivileged build job and a privileged job that only consumes artifacts.',
          reference: 'https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/',
          key: `GHA-PRT-CHECKOUT|${file}|${jobName}`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dockerfiles
// ---------------------------------------------------------------------------

export function checkDockerfile(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let hasUser = false;
  let lastUserRoot = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const from = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
    if (from) {
      const image = from[1]!;
      if (image.toLowerCase() !== 'scratch' && !image.startsWith('$') && (!image.includes(':') || image.endsWith(':latest')) && !image.includes('@sha256:')) {
        out.push({
          ruleId: 'DKR-UNPINNED-BASE', source: 'sentinelops-container', severity: 'low', title: `Base image "${image}" is not pinned`, file, line: i + 1, evidence: line,
          explanation: 'Unpinned or :latest base images make builds non-reproducible and can silently pull in breaking or vulnerable changes.',
          remediation: 'Pin a specific version tag (and ideally a digest), e.g. node:24.11-alpine@sha256:…', key: `DKR-UNPINNED-BASE|${file}|${image}`,
        });
      }
    }
    const user = line.match(/^USER\s+(\S+)/i);
    if (user) {
      hasUser = true;
      lastUserRoot = ['root', '0', '0:0'].includes(user[1]!.toLowerCase());
    }
    if (/^ADD\s+https?:\/\//i.test(line)) {
      out.push({
        ruleId: 'DKR-ADD-URL', source: 'sentinelops-container', severity: 'low', title: 'ADD downloads a remote URL', file, line: i + 1, evidence: line,
        explanation: 'ADD from a URL skips checksum verification and caches unpredictably.',
        remediation: 'Use RUN curl/wget with a pinned checksum, or ADD --checksum=sha256:…', key: `DKR-ADD-URL|${file}|${line}`,
      });
    }
    const env = line.match(/^(?:ENV|ARG)\s+([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)[=\s]+(\S+)/i);
    if (env && !env[2]!.startsWith('$')) {
      out.push({
        ruleId: 'DKR-SECRET-IN-IMAGE', source: 'sentinelops-container', severity: 'high', title: `Secret-like value baked into image layer (${env[1]})`, file, line: i + 1,
        evidence: line.replace(env[2]!, redactSecret(env[2]!)),
        explanation: 'ENV and ARG values are stored in image metadata and layers and can be read by anyone who pulls the image.',
        remediation: 'Use BuildKit secrets (RUN --mount=type=secret) or inject at runtime.', key: `DKR-SECRET-IN-IMAGE|${file}|${env[1]}`,
      });
    }
  });
  if (!hasUser || lastUserRoot) {
    out.push({
      ruleId: 'DKR-RUNS-AS-ROOT', source: 'sentinelops-container', severity: 'medium', title: 'Container runs as root', file,
      explanation: 'A process escape or RCE inside a root container has far more impact on the host and other containers.',
      remediation: 'Create an unprivileged user and add `USER <name>` before the final CMD/ENTRYPOINT.', key: `DKR-RUNS-AS-ROOT|${file}`,
    });
  }
  if (!/^HEALTHCHECK/im.test(text)) {
    out.push({
      ruleId: 'DKR-NO-HEALTHCHECK', source: 'sentinelops-container', severity: 'info', title: 'No HEALTHCHECK instruction', file,
      explanation: 'Orchestrators cannot detect a hung process without a health check.',
      remediation: 'Add a HEALTHCHECK (or rely on platform health probes and document them).', key: `DKR-NO-HEALTHCHECK|${file}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terraform & Kubernetes (lightweight pattern checks; use Trivy/Checkov for depth)
// ---------------------------------------------------------------------------

export function checkTerraform(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/cidr_blocks\s*=\s*\[[^\]]*"0\.0\.0\.0\/0"/.test(line) || /cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"/.test(line)) {
      const ctx = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      if (!/egress/.test(ctx)) {
        out.push({
          ruleId: 'TF-OPEN-INGRESS', source: 'sentinelops-iac', severity: 'high', title: 'Security group allows ingress from 0.0.0.0/0', file, line: i + 1, evidence: line.trim(),
          explanation: 'The rule exposes the port to the entire internet. This is only appropriate for public load balancers on 80/443.',
          remediation: 'Restrict cidr_blocks to known ranges or place the service behind a load balancer.', key: `TF-OPEN-INGRESS|${file}|${i + 1}`,
        });
      }
    }
    if (/acl\s*=\s*"public-read(-write)?"/.test(line)) {
      out.push({
        ruleId: 'TF-PUBLIC-BUCKET', source: 'sentinelops-iac', severity: 'high', title: 'Storage bucket ACL is public', file, line: i + 1, evidence: line.trim(),
        explanation: 'Objects in the bucket are readable by anyone on the internet.',
        remediation: 'Remove the public ACL, enable S3 Block Public Access, and serve public assets through a CDN with origin access control.', key: `TF-PUBLIC-BUCKET|${file}|${i + 1}`,
      });
    }
    if (/^\s*(access_key|secret_key|password|client_secret)\s*=\s*"[^"$]{6,}"/.test(line)) {
      out.push({
        ruleId: 'TF-HARDCODED-CRED', source: 'sentinelops-iac', severity: 'critical', title: 'Hard-coded credential in Terraform', file, line: i + 1,
        evidence: line.replace(/"[^"]+"/, '"[redacted]"').trim(),
        explanation: 'Credentials in .tf files end up in Git history and in plan output.',
        remediation: 'Use environment variables, a secrets manager data source, or workload identity; rotate the exposed value.', key: `TF-HARDCODED-CRED|${file}|${i + 1}`,
      });
    }
    if (/storage_encrypted\s*=\s*false|encrypted\s*=\s*false/.test(line)) {
      out.push({
        ruleId: 'TF-UNENCRYPTED', source: 'sentinelops-iac', severity: 'medium', title: 'Encryption at rest explicitly disabled', file, line: i + 1, evidence: line.trim(),
        explanation: 'Data at rest is stored unencrypted.', remediation: 'Enable encryption (it is free on most managed services).', key: `TF-UNENCRYPTED|${file}|${i + 1}`,
      });
    }
  });
  return out;
}

export function checkKubernetes(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  if (/privileged:\s*true/.test(text)) {
    out.push({
      ruleId: 'K8S-PRIVILEGED', source: 'sentinelops-iac', severity: 'high', title: 'Privileged container', file, line: lineOf(text, 'privileged: true'),
      explanation: 'Privileged containers have full access to the node.', remediation: 'Remove privileged: true and grant only required capabilities.', key: `K8S-PRIVILEGED|${file}`,
    });
  }
  if (/kind:\s*(Deployment|StatefulSet|DaemonSet|Pod|Job|CronJob)\b/.test(text) && !/resources:\s*\n\s+limits:/.test(text)) {
    out.push({
      ruleId: 'K8S-NO-LIMITS', source: 'sentinelops-iac', severity: 'low', title: 'Workload without resource limits', file,
      explanation: 'A single misbehaving pod can starve the node.', remediation: 'Set resources.requests and resources.limits for CPU and memory.', key: `K8S-NO-LIMITS|${file}`,
    });
  }
  if (/hostNetwork:\s*true|hostPID:\s*true/.test(text)) {
    out.push({
      ruleId: 'K8S-HOST-NAMESPACE', source: 'sentinelops-iac', severity: 'medium', title: 'Pod shares host network or PID namespace', file,
      explanation: 'Sharing host namespaces breaks isolation between the pod and the node.', remediation: 'Remove hostNetwork/hostPID unless strictly required.', key: `K8S-HOST-NAMESPACE|${file}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repository hygiene
// ---------------------------------------------------------------------------

export function checkHygiene(arch: Architecture, src: RepoSource): Finding[] {
  const out: Finding[] = [];
  for (const env of arch.envFiles) {
    out.push({
      ruleId: 'REPO-ENV-COMMITTED', source: 'sentinelops-config', severity: 'high', title: 'Environment file committed', file: env,
      explanation: '.env files usually hold credentials and environment-specific secrets; committing them exposes those values to everyone with repository access.',
      remediation: 'Remove the file from Git (and history if it held secrets), add it to .gitignore, rotate any values, and commit a .env.example instead.',
      key: `REPO-ENV-COMMITTED|${env}`,
    });
  }
  for (const pkg of arch.packages) {
    const dir = path.posix.dirname(pkg.file);
    const hasLock = arch.lockfiles.some((l) => path.posix.dirname(l) === dir) || arch.lockfiles.some((l) => path.posix.dirname(l) === '.');
    if (!hasLock && pkg.dependencies + pkg.devDependencies > 0) {
      out.push({
        ruleId: 'REPO-NO-LOCKFILE', source: 'sentinelops-supply-chain', severity: 'medium', title: `No lockfile for ${pkg.file}`, file: pkg.file,
        explanation: 'Without a lockfile each install can resolve different transitive versions, making builds non-reproducible and widening supply-chain exposure.',
        remediation: 'Commit package-lock.json (or the lockfile of your package manager) and use `npm ci` in CI.', key: `REPO-NO-LOCKFILE|${pkg.file}`,
      });
    }
  }
  if (!arch.docs.README) out.push(doc('DOC-NO-README', 'low', 'No README', 'New contributors and operators have no entry point.', 'Add a README covering purpose, setup, run, test and deploy.'));
  if (!arch.docs.SECURITY) out.push(doc('DOC-NO-SECURITY', 'low', 'No SECURITY.md', 'Researchers have no documented way to report vulnerabilities privately.', 'Add SECURITY.md with a private reporting channel and supported versions.'));
  if (!arch.docs.LICENSE) out.push(doc('DOC-NO-LICENSE', 'info', 'No license file', 'Without a license others have no legal right to use the code.', 'Choose a license (or state "All rights reserved").'));
  if (!arch.docs['Dependabot config'] && arch.manifests.length) out.push(doc('REPO-NO-DEPENDABOT', 'low', 'Dependency updates are not automated', 'Vulnerable dependencies stay in place until someone notices.', 'Add .github/dependabot.yml for each package ecosystem and for github-actions.'));
  if (arch.ciProviders.length === 0 && arch.manifests.length) out.push(doc('CI-NONE', 'medium', 'No CI pipeline detected', 'Changes reach the default branch without automated build or test verification.', 'Add a CI workflow that installs, builds and tests on every pull request.'));
  if (arch.testFiles === 0 && arch.manifests.length) out.push(doc('TEST-NONE', 'medium', 'No automated tests detected', 'Regressions can only be caught manually.', 'Add unit tests for core logic and run them in CI.'));
  if (src.truncated) out.push(doc('SCAN-TRUNCATED', 'info', 'Repository listing was truncated', 'Some files were not analysed because the tree exceeded listing limits.', 'Analyse a local clone for complete coverage.'));
  return out;
}

function doc(ruleId: string, severity: Severity, title: string, explanation: string, remediation: string): Finding {
  return { ruleId, source: 'sentinelops-hygiene', severity, title, explanation, remediation, key: ruleId };
}
