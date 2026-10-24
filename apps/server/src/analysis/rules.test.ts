import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectArchitecture } from './detect.ts';
import { checkDockerfile, checkHygiene, checkTerraform, checkWorkflow, scanSecrets } from './rules.ts';
import { localSource } from './source.ts';

// Secret-shaped strings are assembled at runtime so no credential-like literal is ever committed.
const fakeAws = 'AKIA' + 'Z'.repeat(4) + '7Q3X9P2M5K8R';
const fakeGh = 'ghp_' + 'a1B2c3D4'.repeat(4) + 'zz99';

describe('scanSecrets', () => {
  it('detects and redacts an AWS key', () => {
    const [f] = scanSecrets('src/config.js', `const key = "${fakeAws}";`);
    expect(f!.ruleId).toBe('SEC-AWS-KEY');
    expect(f!.severity).toBe('critical');
    expect(f!.line).toBe(1);
    expect(f!.evidence).not.toContain(fakeAws);
    expect(f!.evidence).toContain('redacted');
  });

  it('detects GitHub tokens', () => {
    expect(scanSecrets('a.env', `TOKEN=${fakeGh}`).map((f) => f.ruleId)).toContain('SEC-GH-TOKEN');
  });

  it('ignores placeholders and environment lookups', () => {
    expect(scanSecrets('a.ts', 'password: "changeme"')).toHaveLength(0);
    expect(scanSecrets('a.ts', 'const apiKey = process.env.API_KEY ?? "fallbackvalue1"')).toHaveLength(0);
  });

  it('produces a stable key that does not contain the secret', () => {
    const a = scanSecrets('x.js', `k="${fakeAws}"`)[0]!;
    const b = scanSecrets('x.js', `\n\nk="${fakeAws}"`)[0]!;
    expect(a.key).toBe(b.key); // line moves do not create a new finding
    expect(a.key).not.toContain(fakeAws);
  });
});

describe('checkWorkflow', () => {
  it('flags script injection, unpinned third-party actions and missing permissions', () => {
    const yml = [
      'on: [issues]',
      'jobs:',
      '  triage:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: some-org/some-action@v1',
      '      - run: echo "${{ github.event.issue.title }}"',
    ].join('\n');
    const ids = checkWorkflow('.github/workflows/triage.yml', yml).map((f) => `${f.ruleId}:${f.severity}`);
    expect(ids).toContain('GHA-SCRIPT-INJECTION:high');
    expect(ids).toContain('GHA-UNPINNED-ACTION:medium');
    expect(ids).toContain('GHA-UNPINNED-ACTION:info');
    expect(ids).toContain('GHA-NO-PERMISSIONS:low');
  });

  it('flags pull_request_target checking out the PR head', () => {
    const yml = 'on: pull_request_target\npermissions: { contents: read }\njobs:\n  b:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n';
    expect(checkWorkflow('w.yml', yml).map((f) => f.ruleId)).toContain('GHA-PRT-CHECKOUT');
  });

  it('accepts a hardened workflow', () => {
    const yml = `on: push\npermissions:\n  contents: read\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n      - run: npm test\n`;
    expect(checkWorkflow('w.yml', yml)).toHaveLength(0);
  });

  it('reports invalid YAML', () => {
    expect(checkWorkflow('w.yml', 'jobs: [unclosed')[0]!.ruleId).toBe('GHA-INVALID-YAML');
  });
});

describe('checkDockerfile / checkTerraform', () => {
  it('flags root user, unpinned base and baked secrets', () => {
    const ids = checkDockerfile('Dockerfile', 'FROM node:latest\nENV API_TOKEN=abc123456\nCMD ["node","a.js"]').map((f) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['DKR-UNPINNED-BASE', 'DKR-SECRET-IN-IMAGE', 'DKR-RUNS-AS-ROOT', 'DKR-NO-HEALTHCHECK']));
  });

  it('accepts a non-root pinned image', () => {
    const ids = checkDockerfile('Dockerfile', 'FROM node:24.11-alpine\nUSER node\nHEALTHCHECK CMD wget -q localhost:3000\nCMD ["node","a.js"]').map((f) => f.ruleId);
    expect(ids).toHaveLength(0);
  });

  it('flags open ingress but not open egress', () => {
    const tf = 'resource "aws_security_group" "a" {\n  ingress {\n    from_port = 22\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n  egress {\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}';
    const f = checkTerraform('main.tf', tf);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(4);
  });
});

describe('local repository analysis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-repo-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detects stack, missing lockfile, committed .env and missing docs', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { express: '^4.0.0', react: '19.0.0' }, scripts: { test: 'vitest' } }));
    fs.writeFileSync(path.join(dir, '.env'), `AWS_ACCESS_KEY_ID=${fakeAws}\n`);
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'leak.js'), `"${fakeAws}"`);
    const src = await localSource(dir);
    expect(src.files).not.toContain('node_modules/x/leak.js');
    const { arch, frameworks } = await detectArchitecture(src);
    expect(frameworks).toEqual(expect.arrayContaining(['Express', 'React', 'Node.js']));
    const ids = checkHygiene(arch, src).map((f) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['REPO-ENV-COMMITTED', 'REPO-NO-LOCKFILE', 'DOC-NO-README', 'CI-NONE', 'TEST-NONE']));
  });

  it('refuses to read outside the repository root', async () => {
    const src = await localSource(dir);
    expect(await src.read('../../etc/passwd')).toBeNull();
  });
});

describe('secret scanner precision (regressions found by self-analysis)', () => {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7' + 'x'.repeat(20);

  it('ignores a key header with no key material (docs, regexes, redaction code)', () => {
    expect(scanSecrets('errors.ts', `.replace(/x/g, '${header} [REDACTED]')`)).toHaveLength(0);
  });

  it('flags a PEM block with a base64 body, on its own lines or escaped inline', () => {
    expect(scanSecrets('key.pem', `${header}\n${body}\n`).map((f) => f.ruleId)).toContain('SEC-PRIVATE-KEY');
    expect(scanSecrets('sa.json', `"private_key": "${header}\n${body}"`).map((f) => f.ruleId)).toContain('SEC-PRIVATE-KEY');
  });

  it('ignores plain words assigned to password-like names', () => {
    expect(scanSecrets('Auth.tsx', `autoComplete={mode ? 'current-password' : 'new-password'}`)).toHaveLength(0);
  });

  it('downgrades credential-like strings in test files', () => {
    const [f] = scanSecrets('src/app.test.ts', "const password = 'Abc123longvalue'");
    expect(f!.severity).toBe('low');
    expect(f!.title).toMatch(/test file/);
  });
});

describe('dependency extraction', () => {
  it('skips workspace folders in package-lock.json', async () => {
    const { extractDependencies } = await import('./osv.ts');
    const lock = { lockfileVersion: 3, packages: { '': { dependencies: { a: '1.0.0' } }, 'apps/server': { name: '@x/server', version: '0.1.0' }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@x/server': { link: true, resolved: 'apps/server' } } };
    const src = { kind: 'local' as const, files: ['package-lock.json'], truncated: false, sizes: new Map(), scannedForSecrets: new Set<string>(), read: async () => JSON.stringify(lock) };
    const { deps } = await extractDependencies(src);
    expect(deps.map((d) => d.name)).toEqual(['a']);
  });
});
