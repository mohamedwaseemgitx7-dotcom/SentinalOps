import { describe, expect, it } from 'vitest';
import { evaluateConditions, needsBody, tokenizePath, validateConditions, type ConditionContext } from './conditions.ts';

const ctx = (over: Partial<ConditionContext> = {}): ConditionContext => ({
  status: 200,
  responseTimeMs: 120,
  body: JSON.stringify({ status: 'ok', version: '1.4.2', checks: [{ name: 'db', healthy: true }, { name: 'cache', healthy: false }], 'a.b': 5, items: [1, 2, 3] }),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  certExpiryMs: 30 * 86_400_000,
  ...over,
});

const run = (conds: string[], c = ctx()) => evaluateConditions(conds, c);

describe('response assertions', () => {
  it.each([
    ['[STATUS] == 200', true],
    ['[STATUS] != 200', false],
    ['[RESPONSE_TIME] < 500ms', true],
    ['[RESPONSE_TIME] > 1s', false],
    ['[BODY].status == "ok"', true],
    ['[BODY].status == ok', true],
    ['[BODY].checks[0].healthy == true', true],
    ['[BODY].checks[1].healthy == true', false],
    ['[BODY]["a.b"] >= 5', true],
    ['len([BODY].items) == 3', true],
    ['has([BODY].missing) == false', true],
    ['[BODY] contains "healthy"', true],
    ['[BODY] not-contains "error"', true],
    ['[HEADER].content-type matches "application/json*"', true],
    ['[CERT_EXPIRY] > 7d', true],
  ])('%s → %s', (cond, expected) => {
    expect(run([cond]).success).toBe(expected);
  });

  it('fails (never silently passes) when a numeric comparison is impossible', () => {
    const r = run(['[BODY].version > 1']);
    expect(r.success).toBe(false);
    expect(r.results[0]!.error).toMatch(/numbers/);
  });

  it('fails with a clear reason for missing paths and non-JSON bodies', () => {
    expect(run(['[BODY].nope == 1']).results[0]!.error).toMatch(/missing/);
    expect(run(['[BODY].status == "ok"'], ctx({ body: '<html>' })).results[0]!.error).toMatch(/not valid JSON/);
  });

  it('shows actual values in the display string', () => {
    expect(run(['[STATUS] == 200'], ctx({ status: 503 })).results[0]!.display).toBe('[STATUS] (503) == 200');
  });

  it('evaluates every condition (no short-circuit)', () => {
    const r = run(['[STATUS] == 500', '[BODY].status == "ok"']);
    expect(r.results.map((x) => x.success)).toEqual([false, true]);
    expect(r.success).toBe(false);
  });

  it('refuses prototype keys and over-deep paths', () => {
    expect(() => tokenizePath('.__proto__.x')).toThrow(/not allowed/);
    expect(() => tokenizePath('.a'.repeat(13))).toThrow(/deeper/);
    expect(run(['[BODY].constructor == 1']).success).toBe(false);
  });

  it('treats glob patterns literally except *, so user input cannot inject regex', () => {
    expect(run(['[BODY].status matches "o.*"']).success).toBe(false);
    expect(run(['[BODY].status matches "o*"']).success).toBe(true);
  });

  it('validates syntax on save', () => {
    expect(validateConditions(['[STATUS] == 200', '[BODY].x == 1'])).toEqual([]);
    expect(validateConditions(['[STATUS]==200'])[0]).toMatch(/operator/);
    expect(validateConditions(['[NOPE] == 1'])[0]).toMatch(/Unknown placeholder/);
    expect(validateConditions(Array(11).fill('[STATUS] == 200'))[0]).toMatch(/At most 10/);
  });

  it('only fetches the body when an assertion needs it', () => {
    expect(needsBody(['[STATUS] == 200'])).toBe(false);
    expect(needsBody(['len([BODY].items) > 0'])).toBe(true);
  });
});
