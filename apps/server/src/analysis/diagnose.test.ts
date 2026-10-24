import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseLog } from './diagnose.ts';

const fixtures = path.resolve(import.meta.dirname, '../../../../fixtures/ci-logs');
const load = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');

describe('diagnoseLog', () => {
  const cases: [string, string, RegExp][] = [
    ['npm-ci-lock-mismatch.log', 'dependency-install', /out of sync/],
    ['typescript-error.log', 'type-error', /src\/routes\/users\.ts:42/],
    ['jest-test-failure.log', 'test-failure', /src\/cart\/total\.test\.ts/],
    ['docker-copy-missing.log', 'docker-build', /Docker image build failed/],
    ['missing-env.log', 'missing-env', /DATABASE_URL/],
    ['oom.log', 'out-of-memory', /memory/],
    ['permission-denied.log', 'auth-permission', /denied/],
    ['python-module-missing.log', 'dependency-install', /httpx/],
  ];

  it.each(cases)('%s → %s', (file, category, summary) => {
    const d = diagnoseLog(load(file));
    expect(d.category).toBe(category);
    expect(d.summary).toMatch(summary);
    expect(d.evidence.some((e) => e.primary)).toBe(true);
  });

  it('never picks the cascading "exit code" line as the primary cause', () => {
    for (const [file] of cases) {
      const d = diagnoseLog(load(file));
      const primary = d.evidence.find((e) => e.primary)!;
      expect(primary.text).not.toMatch(/Process completed with exit code/);
    }
  });

  it('picks the first error when several follow', () => {
    const d = diagnoseLog(load('typescript-error.log'));
    expect(d.primaryLine).toBe(5);
    expect(d.file).toBe('src/routes/users.ts:42');
  });

  it('reports low confidence instead of guessing when nothing matches', () => {
    const d = diagnoseLog(load('no-signature.log'));
    expect(d.category).toBe('unknown');
    expect(d.confidence).toBe('low');
  });

  it('strips timestamps and ANSI colour codes from evidence', () => {
    const d = diagnoseLog('2026-01-01T00:00:00.0000000Z \u001b[31mnpm error code ERESOLVE\u001b[0m\n');
    expect(d.category).toBe('dependency-install');
    expect(d.evidence[0]!.text).toBe('npm error code ERESOLVE');
  });
});
