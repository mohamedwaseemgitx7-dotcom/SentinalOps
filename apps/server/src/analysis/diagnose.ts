/**
 * Deterministic CI log diagnosis. Finds the first meaningful error, separates it from
 * cascading noise ("Process completed with exit code 1"), classifies it, and returns the
 * exact log lines used as evidence. No AI is involved; every conclusion cites lines.
 */

export type FailureCategory =
  | 'dependency-install'
  | 'dependency-vulnerability'
  | 'test-failure'
  | 'type-error'
  | 'lint'
  | 'build-error'
  | 'docker-build'
  | 'missing-env'
  | 'auth-permission'
  | 'network'
  | 'timeout'
  | 'out-of-memory'
  | 'deployment'
  | 'infrastructure'
  | 'unknown';

export interface EvidenceLine {
  line: number;
  text: string;
  primary?: boolean;
}

export interface Diagnosis {
  category: FailureCategory;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  recommendation: string;
  evidence: EvidenceLine[];
  primaryLine: number | null;
  file: string | null;
}

interface Rule {
  category: FailureCategory;
  re: RegExp;
  summary: (m: RegExpMatchArray) => string;
  recommendation: (m: RegExpMatchArray) => string;
  confidence: 'high' | 'medium';
}

const RULES: Rule[] = [
  {
    category: 'out-of-memory', confidence: 'high',
    re: /(JavaScript heap out of memory|FATAL ERROR: .*Allocation failed|Killed\s+signal 9|exit code 137|OOMKilled|MemoryError)/i,
    summary: () => 'The process ran out of memory and was killed.',
    recommendation: () => 'Reduce memory use (split the build, lower parallelism) or raise the limit, e.g. NODE_OPTIONS=--max-old-space-size=4096, or use a larger runner.',
  },
  {
    category: 'timeout', confidence: 'high',
    re: /(The job (?:running on runner .* )?has exceeded the maximum execution time|The operation was canceled|exceeded the timeout of \d+|Timeout of \d+ms exceeded|ETIMEDOUT)/i,
    summary: (m) => (m[1]!.includes('ETIMEDOUT') ? 'A network call timed out.' : 'The job or a test exceeded its time limit.'),
    recommendation: () => 'Find the hanging step (look at the last output before the cutoff), add timeouts to external calls, and set a realistic timeout-minutes.',
  },
  {
    category: 'dependency-install', confidence: 'high',
    re: /(npm (?:ERR!|error) (?:code )?(ERESOLVE|E404|ETARGET|ENOTFOUND|EINTEGRITY|ELIFECYCLE|ENOENT)|npm (?:ERR!|error) `npm ci` can only install packages when your package\.json and package-lock\.json|ERR_PNPM_\w+|error An unexpected error occurred: "https:\/\/registry|Could not find a version that satisfies the requirement ([^\s]+)|No matching distribution found for ([^\s]+)|ResolutionImpossible|go: [^\s]+: (?:reading|verifying) .*(?:404|not found)|Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)')/,
    summary: (m) => {
      if (/ERESOLVE/.test(m[0])) return 'npm could not resolve a consistent dependency tree (peer dependency conflict).';
      if (/can only install packages when/.test(m[0])) return 'package-lock.json is out of sync with package.json, so `npm ci` refused to install.';
      if (/E404|ETARGET/.test(m[0])) return 'A package or version requested by the manifest does not exist in the registry.';
      if (/EINTEGRITY/.test(m[0])) return 'A downloaded package failed its integrity checksum.';
      if (/Cannot find module|No module named/.test(m[0])) return `A required module is missing at runtime: ${m[5] ?? m[6] ?? 'see evidence'}.`;
      if (m[3] || m[4]) return `pip could not find a matching version of ${m[3] ?? m[4]}.`;
      return 'Dependency installation failed.';
    },
    recommendation: (m) => {
      if (/ERESOLVE/.test(m[0])) return 'Align the conflicting peer versions shown in the log; avoid --legacy-peer-deps as a permanent fix.';
      if (/can only install packages when/.test(m[0])) return 'Run `npm install` locally, commit the updated package-lock.json, and push.';
      if (/Cannot find module|No module named/.test(m[0])) return 'Add the module to dependencies (not devDependencies if needed at runtime), check import paths and case sensitivity (Linux runners are case-sensitive), and reinstall.';
      return 'Check the package name/version in the manifest, confirm registry access, and regenerate the lockfile.';
    },
  },
  {
    category: 'type-error', confidence: 'high',
    re: /((?:^|\s)([\w./\\-]+\.(?:ts|tsx|mts|cts))[(:](\d+)[,:](\d+)\)?:?\s+(?:-\s+)?error (TS\d+): (.+)|error (TS\d+): (.+))/,
    summary: (m) => `TypeScript compilation failed${m[2] ? ` in ${m[2]}:${m[3]}` : ''}: ${m[6] ?? m[8] ?? ''}`.trim(),
    recommendation: (m) => `Fix the type error (${m[5] ?? m[7]}) at the reported location and run \`tsc --noEmit\` locally before pushing.`,
  },
  {
    category: 'test-failure', confidence: 'high',
    re: /((?:^|\s)(FAIL)\s+([\w./\\-]+\.(?:test|spec)\.[jt]sx?)|Tests?:\s+\d+ failed|(\d+) (?:failing|failed)(?: tests?)?\b|FAILED ([\w./\\-]+\.py)::|AssertionError|Test Suites?: \d+ failed|--- FAIL: (\w+)|✗|× )/,
    summary: (m) => `Automated tests failed${m[3] ? ` in ${m[3]}` : m[5] ? ` in ${m[5]}` : m[6] ? ` (${m[6]})` : ''}.`,
    recommendation: () => 'Run the failing test locally with the same Node/Python version, read the first assertion diff, and fix the code or the outdated expectation. Do not skip the test to make CI green.',
  },
  {
    category: 'lint', confidence: 'medium',
    re: /(\d+ problems? \(\d+ errors?|✖ \d+ problems?|eslint.*error|ruff.*error|flake8|Prettier.*(?:Code style issues|check failed)|\[warn\] Code style issues)/i,
    summary: () => 'Linting or formatting checks failed.',
    recommendation: () => 'Run the linter locally (e.g. `npm run lint -- --fix` / `ruff check --fix`), commit the result, and consider a pre-commit hook.',
  },
  {
    category: 'docker-build', confidence: 'high',
    re: /(ERROR: failed to solve: (.+)|failed to compute cache key: (.+)|COPY failed: (.+)|manifest unknown|pull access denied for ([^\s,]+)|Error response from daemon: (.+)|executor failed running \[(.+)\])/,
    summary: (m) => `Docker image build failed: ${(m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[7] ?? m[0]).slice(0, 160)}`,
    recommendation: (m) => {
      if (/failed to compute cache key|COPY failed|not found/.test(m[0])) return 'A path referenced by COPY/ADD does not exist in the build context. Check .dockerignore and the relative path from the build context.';
      if (/pull access denied|manifest unknown/.test(m[0])) return 'The base image name or tag is wrong, or the registry needs authentication. Verify the image reference and login step.';
      return 'Reproduce with `docker build` locally using the same context, and fix the failing instruction shown in the evidence.';
    },
  },
  {
    category: 'missing-env', confidence: 'high',
    re: /((?:Missing|Required|Undefined) (?:required )?(?:environment variable|env(?:ironment)? var(?:iable)?|secret)[:\s]+["'`]?([A-Z][A-Z0-9_]+)|([A-Z][A-Z0-9_]{2,}) (?:is not set|is required|must be (?:set|defined))|Invalid environment variables?|KeyError: '([A-Z][A-Z0-9_]+)')/,
    summary: (m) => `A required environment variable or secret is not set${m[2] ?? m[3] ?? m[4] ? `: ${m[2] ?? m[3] ?? m[4]}` : ''}.`,
    recommendation: (m) => `Define ${m[2] ?? m[3] ?? m[4] ?? 'the variable'} as a repository/environment secret or variable and pass it to the step via \`env:\`. Secrets are not available to workflows triggered from forks.`,
  },
  {
    category: 'auth-permission', confidence: 'high',
    re: /(Resource not accessible by integration|Permission to [\w./-]+ denied|HTTP 40[13]|403 Forbidden|401 Unauthorized|Bad credentials|denied: (?:requested access|permission)|AccessDenied|not authorized to perform|Error: Credentials could not be loaded|could not read Username)/i,
    summary: () => 'A step was denied access: the token or credentials lack the required permission.',
    recommendation: () => 'Grant the minimum missing scope in the workflow `permissions:` block (or the cloud role policy) and confirm the secret exists for this event/branch.',
  },
  {
    // e.g. `curl --fail https://api.example.com/health` → "curl: (22) The requested URL returned error: 502"
    category: 'network', confidence: 'high',
    re: /(curl: \((\d+)\) (?:The requested URL returned error: (\d{3})|(.+))|wget: server returned error: HTTP\/\S+ (\d{3}))/,
    summary: (m) => {
      const status = m[3] ?? m[5];
      if (status && status.startsWith('5')) return `A service called by this job returned HTTP ${status} (server error). The failure is in that service, not in this repository's code.`;
      if (status) return `A service called by this job returned HTTP ${status}.`;
      return `A network request made with curl failed: ${(m[4] ?? '').trim().slice(0, 140)}`;
    },
    recommendation: (m) => {
      const status = m[3] ?? m[5];
      if (status && status.startsWith('5')) return 'Check the called service (its platform status page and logs) for the time of this run. If it is a health or keep-alive check against a free-tier host that sleeps, allow a longer warm-up or treat the check as non-blocking.';
      if (status === '401' || status === '403') return 'The request was rejected — verify the credential or secret passed to this step and that it has access to the endpoint.';
      if (status === '404') return 'The URL does not exist — check the endpoint path and deployment.';
      return 'Re-run once to rule out a transient network issue; if it repeats, verify the URL, DNS and that the target is reachable from GitHub-hosted runners.';
    },
  },
  {
    category: 'network', confidence: 'medium',
    re: /(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|Could not resolve host|Connection reset by peer|TLS handshake timeout|503 Service Unavailable|502 Bad Gateway)/,
    summary: () => 'A network request failed (connection refused/reset or DNS).',
    recommendation: () => 'Retry once to rule out a transient outage. If it persists, check the service the step depends on (registry, test DB, API) and add retries with backoff.',
  },
  {
    category: 'deployment', confidence: 'medium',
    re: /(Deployment failed|deploy(?:ment)? (?:error|failed)|Error: No such app|wrangler.*(?:error|✘)|vercel.*Error|Health check failed|Rollout .* failed|exceeded its progress deadline)/i,
    summary: () => 'The deployment step failed.',
    recommendation: () => 'Check the target platform logs for the deployment ID in the evidence, confirm credentials and project settings, and verify the build artifact exists.',
  },
  {
    category: 'infrastructure', confidence: 'medium',
    re: /(Error: (?:creating|updating|deleting) [\w ]+:|Error acquiring the state lock|terraform.*Error:|Error: Invalid (?:reference|value)|No valid credential sources found)/i,
    summary: () => 'An infrastructure-as-code step (e.g. Terraform) failed.',
    recommendation: () => 'Read the provider error in the evidence; run `terraform plan` locally against the same workspace. Never force-unlock state without confirming no other run is active.',
  },
  {
    category: 'dependency-vulnerability', confidence: 'medium',
    re: /(found \d+ (?:\w+ )?vulnerabilit(?:y|ies).*\((?:\d+ )?(?:high|critical)|Total: \d+ \(.*CRITICAL: [1-9]|npm audit.*(?:high|critical))/i,
    summary: () => 'A dependency audit gate failed because vulnerable packages were found.',
    recommendation: () => 'Upgrade the flagged packages (see Security tab), or add a time-boxed, justified suppression if the vulnerable path is unreachable.',
  },
  {
    category: 'build-error', confidence: 'medium',
    re: /((?:^|\s)error(?:\[E\d+\])?:\s+(.+)|SyntaxError: (.+)|Build failed|ERROR in (.+)|\[vite\]:? (?:Rollup|Rolldown) failed to resolve|Module not found: Error: (.+)|error: could not compile)/,
    summary: (m) => `Build failed: ${(m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[0]).trim().slice(0, 160)}`,
    recommendation: () => 'Reproduce the build locally with the same command and runtime version; fix the first compiler error shown — later errors are often consequences of it.',
  },
];

/** Lines that are consequences, not causes. */
const CASCADING = /(Process completed with exit code|npm (?:ERR!|error) (?:A complete log|code ELIFECYCLE|errno|Lifecycle script|path |command failed|command sh)|Error: Process completed|##\[error\]The process '.+' failed with exit code|Command failed with exit code|exited with code|make: \*\*\*|error Command failed)/i;

const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function cleanLog(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.replace(TIMESTAMP, '').replace(ANSI, ''));
}

/** Returns lines belonging to the failed step when GitHub group markers are present. */
export function stepSlice(lines: string[], stepName: string | null): { start: number; end: number } {
  if (!stepName) return { start: 0, end: lines.length };
  const needle = stepName.replace(/^Run\s+/, '').trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('##[group]') && l.toLowerCase().includes(needle.slice(0, 60))) start = i;
  }
  if (start < 0) return { start: 0, end: lines.length };
  // A step's output runs until the next step header (or job cleanup).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('##[group]Run ') || lines[i]!.startsWith('Post job cleanup')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function diagnoseLog(raw: string, failedStep: string | null = null): Diagnosis {
  const lines = cleanLog(raw);
  const { start, end } = stepSlice(lines, failedStep);
  const scopes: [number, number][] = [[start, end]];
  if (start !== 0 || end !== lines.length) scopes.push([0, lines.length]);

  for (const [s, e] of scopes) {
    // Earliest matching line wins across rules: the first meaningful error is usually the cause.
    let best: { idx: number; rule: Rule; m: RegExpMatchArray } | null = null;
    for (let i = s; i < e; i++) {
      const text = lines[i]!;
      if (!text.trim() || CASCADING.test(text) || text.startsWith('##[group]') || text.startsWith('##[endgroup]')) continue;
      for (const rule of RULES) {
        const m = text.match(rule.re);
        if (m) {
          if (!best || i < best.idx) best = { idx: i, rule, m };
          break;
        }
      }
      if (best && best.idx === i) break;
    }
    if (best) {
      const file = extractFile(lines.slice(best.idx, best.idx + 6).join('\n'));
      return {
        category: best.rule.category,
        confidence: best.rule.confidence,
        summary: best.rule.summary(best.m),
        recommendation: best.rule.recommendation(best.m),
        evidence: evidenceAround(lines, best.idx),
        primaryLine: best.idx + 1,
        file,
      };
    }
  }

  // Fall back to the first ##[error] annotation if no rule matched.
  const errIdx = lines.findIndex((l) => l.startsWith('##[error]') && !CASCADING.test(l));
  if (errIdx >= 0) {
    return {
      category: 'unknown', confidence: 'low',
      summary: `Step failed: ${lines[errIdx]!.replace('##[error]', '').slice(0, 200)}`,
      recommendation: 'No known failure signature matched. Read the evidence lines and the output just before them; reproduce the step locally.',
      evidence: evidenceAround(lines, errIdx), primaryLine: errIdx + 1, file: extractFile(lines[errIdx]!),
    };
  }
  const exitIdx = lines.findIndex((l) => CASCADING.test(l));
  return {
    category: 'unknown', confidence: 'low',
    summary: 'The step failed but the log contains no recognisable error message.',
    recommendation: 'Enable debug logging (ACTIONS_STEP_DEBUG secret = true), re-run the job, and inspect the full log.',
    evidence: exitIdx >= 0 ? evidenceAround(lines, exitIdx) : lines.slice(-8).map((t, i) => ({ line: lines.length - 8 + i + 1, text: t })),
    primaryLine: exitIdx >= 0 ? exitIdx + 1 : null, file: null,
  };
}

function evidenceAround(lines: string[], idx: number): EvidenceLine[] {
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length, idx + 7);
  const out: EvidenceLine[] = [];
  for (let i = from; i < to; i++) {
    const text = lines[i]!.slice(0, 400);
    if (!text.trim() && i !== idx) continue;
    out.push({ line: i + 1, text, ...(i === idx ? { primary: true } : {}) });
  }
  return out;
}

function extractFile(text: string): string | null {
  const m = text.match(/((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|vue|svelte|json|ya?ml|toml|tf|dockerfile)|Dockerfile)(?:[:(](\d+))?/i);
  return m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]!) : null;
}
