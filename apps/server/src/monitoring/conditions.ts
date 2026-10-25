/**
 * Response assertions for monitors, e.g.
 *   [STATUS] == 200
 *   [RESPONSE_TIME] < 500ms
 *   [BODY].status == "ok"
 *   [BODY].checks[0].healthy == true
 *   len([BODY].items) > 0
 *   [BODY] contains "healthy"
 *   [HEADER].content-type matches "application/json*"
 *   [CERT_EXPIRY] > 7d
 *
 * Design informed by reading Gatus (Apache-2.0) and Uptime Kuma (MIT); no code was copied.
 * Safety: no eval, no user-supplied regex (globs only), prototype keys refused, bounded sizes,
 * and anything that cannot be compared FAILS with a reason instead of silently passing.
 */

export const CONDITION_LIMITS = { maxConditions: 10, maxLength: 300, maxPathDepth: 12 };

const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', 'contains', 'not-contains', 'matches'] as const;
type Operator = (typeof OPERATORS)[number];

export interface ConditionContext {
  status: number | null;
  responseTimeMs: number | null;
  body: string | null;
  headers: Record<string, string>;
  certExpiryMs: number | null;
}

export interface ConditionResult {
  condition: string;
  success: boolean;
  /** Human-readable form with the actual value filled in, e.g. `[STATUS] (503) == 200`. */
  display: string;
  error?: string;
}

interface Parsed {
  left: string;
  op: Operator;
  right: string;
}

// Operator surrounded by whitespace; longest symbolic operators first so `<=` is not read as `<`.
const SPLIT = /^(.+?)\s+(==|!=|<=|>=|<|>|contains|not-contains|matches)\s+(.+)$/;

export function parseCondition(text: string): Parsed {
  const t = text.trim();
  if (!t) throw new Error('Empty condition');
  if (t.length > CONDITION_LIMITS.maxLength) throw new Error(`Condition longer than ${CONDITION_LIMITS.maxLength} characters`);
  const m = t.match(SPLIT);
  if (!m) throw new Error(`Expected "<value> <operator> <value>" with one of: ${OPERATORS.join(', ')}`);
  return { left: m[1]!.trim(), op: m[2] as Operator, right: m[3]!.trim() };
}

/** Validates a list of conditions when a monitor is saved. Returns error messages (empty = valid). */
export function validateConditions(conditions: string[]): string[] {
  const errors: string[] = [];
  if (conditions.length > CONDITION_LIMITS.maxConditions) errors.push(`At most ${CONDITION_LIMITS.maxConditions} conditions`);
  for (const c of conditions) {
    try {
      const p = parseCondition(c);
      operandKind(p.left);
      operandKind(p.right);
    } catch (err) {
      errors.push(`"${c}": ${(err as Error).message}`);
    }
  }
  return errors;
}

export function needsBody(conditions: string[]): boolean {
  return conditions.some((c) => /\[BODY\]/i.test(c));
}

// ---------------------------------------------------------------------------

type Value = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;
const MISSING = Symbol('missing');

function operandKind(raw: string): 'placeholder' | 'function' | 'literal' {
  if (/^(len|has)\(/i.test(raw)) {
    if (!raw.endsWith(')')) throw new Error(`Unclosed function call: ${raw}`);
    operandKind(raw.slice(raw.indexOf('(') + 1, -1).trim());
    return 'function';
  }
  if (raw.startsWith('[')) {
    const m = raw.match(/^\[(STATUS|RESPONSE_TIME|BODY|HEADER|CERT_EXPIRY)\](.*)$/i);
    if (!m) throw new Error(`Unknown placeholder ${raw}. Use [STATUS], [RESPONSE_TIME], [BODY], [HEADER].name or [CERT_EXPIRY]`);
    const name = m[1]!.toUpperCase();
    const rest = m[2]!;
    if (rest && name !== 'BODY' && name !== 'HEADER') throw new Error(`${name} does not take a path`);
    if (name === 'HEADER' && !/^\.[A-Za-z0-9-]+$/.test(rest)) throw new Error('Use [HEADER].header-name');
    if (name === 'BODY' && rest) tokenizePath(rest);
    return 'placeholder';
  }
  return 'literal';
}

/** `.a.b[0]["x.y"]` → ['a', 'b', 0, 'x.y'] */
export function tokenizePath(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /\.([A-Za-z0-9_$-]+)|\[(\d+)\]|\["([^"\]]+)"\]/y;
  let i = 0;
  while (i < path.length) {
    re.lastIndex = i;
    const m = re.exec(path);
    if (!m) throw new Error(`Invalid path near "${path.slice(i, i + 20)}"`);
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else tokens.push(m[3]!);
    i = re.lastIndex;
  }
  if (tokens.length > CONDITION_LIMITS.maxPathDepth) throw new Error(`Path deeper than ${CONDITION_LIMITS.maxPathDepth}`);
  for (const t of tokens) if (t === '__proto__' || t === 'constructor' || t === 'prototype') throw new Error(`Key "${t}" is not allowed`);
  return tokens;
}

function walk(root: unknown, tokens: (string | number)[]): Value | typeof MISSING {
  let cur: unknown = root;
  for (const t of tokens) {
    if (typeof t === 'number') {
      if (!Array.isArray(cur) || t >= cur.length) return MISSING;
      cur = cur[t];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, t)) return MISSING;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur as Value;
}

function parseDuration(raw: string): number | null {
  const m = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) return null;
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms'];
  return Number(m[1]) * mult;
}

function literal(raw: string): Value {
  if (/^"(.*)"$/s.test(raw) || /^'(.*)'$/s.test(raw)) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const d = parseDuration(raw);
  if (d !== null) return d;
  return raw; // bare word, compared as a string
}

class Resolver {
  private ctx: ConditionContext;
  private json: unknown = MISSING;
  private jsonError: string | null = null;

  constructor(ctx: ConditionContext) {
    this.ctx = ctx;
  }

  private parsedBody(): unknown {
    if (this.json === MISSING && this.jsonError === null) {
      try {
        this.json = JSON.parse(this.ctx.body ?? '');
      } catch {
        this.jsonError = 'response body is not valid JSON';
      }
    }
    if (this.jsonError) throw new Error(this.jsonError);
    return this.json;
  }

  resolve(raw: string): Value | typeof MISSING {
    const fn = raw.match(/^(len|has)\((.*)\)$/i);
    if (fn) {
      const name = fn[1]!.toLowerCase();
      let inner: Value | typeof MISSING;
      try {
        inner = this.resolve(fn[2]!.trim());
      } catch (err) {
        if (name === 'has') return false;
        throw err;
      }
      if (name === 'has') return inner !== MISSING;
      if (inner === MISSING) return MISSING;
      if (Array.isArray(inner) || typeof inner === 'string') return inner.length;
      if (inner && typeof inner === 'object') return Object.keys(inner).length;
      throw new Error('len() needs an array, object or string');
    }
    const ph = raw.match(/^\[(STATUS|RESPONSE_TIME|BODY|HEADER|CERT_EXPIRY)\](.*)$/i);
    if (!ph) return literal(raw);
    const name = ph[1]!.toUpperCase();
    const rest = ph[2]!;
    switch (name) {
      case 'STATUS':
        return this.ctx.status ?? MISSING;
      case 'RESPONSE_TIME':
        return this.ctx.responseTimeMs ?? MISSING;
      case 'CERT_EXPIRY':
        return this.ctx.certExpiryMs ?? MISSING;
      case 'HEADER':
        return this.ctx.headers[rest.slice(1).toLowerCase()] ?? MISSING;
      default:
        if (!rest) return this.ctx.body ?? MISSING;
        return walk(this.parsedBody(), tokenizePath(rest));
    }
  }
}

function show(v: Value | typeof MISSING): string {
  if (v === MISSING) return 'missing';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

function compare(op: Operator, a: Value, b: Value): boolean {
  switch (op) {
    case '==':
    case '!=': {
      const eq = typeof a === 'object' && a !== null ? JSON.stringify(a) === JSON.stringify(b) : a === b || (typeof a !== typeof b && String(a) === String(b));
      return op === '==' ? eq : !eq;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error('both sides must be numbers');
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    }
    case 'contains':
    case 'not-contains': {
      const hay = typeof a === 'string' ? a : JSON.stringify(a);
      const has = hay.includes(String(b));
      return op === 'contains' ? has : !has;
    }
    case 'matches':
      return globToRegex(String(b)).test(typeof a === 'string' ? a : JSON.stringify(a));
  }
}

/** Evaluates every condition (no short-circuit) so the UI can show each result. */
export function evaluateConditions(conditions: string[], ctx: ConditionContext): { success: boolean; results: ConditionResult[] } {
  const resolver = new Resolver(ctx);
  const results = conditions.map((condition): ConditionResult => {
    try {
      const p = parseCondition(condition);
      const left = resolver.resolve(p.left);
      const right = resolver.resolve(p.right);
      const display = `${p.left} (${show(left)}) ${p.op} ${p.right}`;
      if (left === MISSING) return { condition, success: p.op === '!=' || p.op === 'not-contains', display, error: `${p.left} is missing` };
      if (right === MISSING) return { condition, success: false, display, error: `${p.right} is missing` };
      return { condition, success: compare(p.op, left, right), display };
    } catch (err) {
      return { condition, success: false, display: condition, error: (err as Error).message };
    }
  });
  return { success: results.every((r) => r.success), results };
}
