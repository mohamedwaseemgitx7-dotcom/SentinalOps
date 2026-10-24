import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting, type DB } from '../db.ts';
import { HttpError } from '../lib/errors.ts';

const execFileP = promisify(execFile);
const API = 'https://api.github.com';

export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export class GitHubError extends HttpError {
  status: number;

  constructor(status: number, message: string) {
    // Upstream failures surface as 502 so they are not confused with SentinelOps' own auth errors.
    super(status === 404 ? 404 : 502, message, `github_${status}`);
    this.status = status;
  }
}

/**
 * Minimal GitHub REST client. Tokens are resolved per call and never written to the
 * database or logs: either `GITHUB_TOKEN` from the environment, or — only when the
 * administrator explicitly enables it — the local GitHub CLI's credential.
 */
export class GitHubClient {
  rateLimit: RateLimit = { limit: null, remaining: null, resetAt: null };
  private cliToken: { value: string | null; at: number } | null = null;

  private db: DB;
  private envToken: string | null;

  constructor(db: DB, envToken: string | null) {
    this.db = db;
    this.envToken = envToken;
  }

  async tokenSource(): Promise<'env' | 'gh-cli' | 'none'> {
    if (this.envToken) return 'env';
    return (await this.cliTokenValue()) ? 'gh-cli' : 'none';
  }

  private async cliTokenValue(): Promise<string | null> {
    if (getSetting(this.db, 'github.use_gh_cli') !== 'true') return null;
    if (this.cliToken && Date.now() - this.cliToken.at < 10 * 60_000) return this.cliToken.value;
    try {
      const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true });
      const value = stdout.trim() || null;
      this.cliToken = { value, at: Date.now() };
      return value;
    } catch {
      this.cliToken = { value: null, at: Date.now() };
      return null;
    }
  }

  private async token(): Promise<string | null> {
    return this.envToken ?? (await this.cliTokenValue());
  }

  async request(pathOrUrl: string, init: { accept?: string; method?: string; body?: unknown; raw?: boolean } = {}): Promise<Response> {
    const token = await this.token();
    const headers: Record<string, string> = {
      Accept: init.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'SentinelOps/0.1',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    const limit = res.headers.get('x-ratelimit-limit');
    if (limit) {
      const reset = res.headers.get('x-ratelimit-reset');
      this.rateLimit = {
        limit: Number(limit),
        remaining: Number(res.headers.get('x-ratelimit-remaining')),
        resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
      };
    }
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw await toError(res, path);
    return (await res.json()) as T;
  }

  /** Like json() but returns null for 404/403/410 so optional data shows as "unavailable". */
  async optional<T>(path: string): Promise<{ data: T | null; status: number }> {
    const res = await this.request(path);
    if (res.ok) return { data: (await res.json()) as T, status: res.status };
    if ([403, 404, 409, 410, 451].includes(res.status)) {
      await res.body?.cancel();
      return { data: null, status: res.status };
    }
    throw await toError(res, path);
  }

  async text(path: string, maxBytes = 4 * 1024 * 1024): Promise<string | null> {
    const res = await this.request(path, { accept: 'application/vnd.github.raw+json' });
    if (res.status === 404 || res.status === 410 || res.status === 403) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await toError(res, path);
    return readCapped(res, maxBytes);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(path, { method: 'POST', body });
    if (!res.ok) throw await toError(res, path);
    return (await res.json()) as T;
  }
}

/** Reads at most `maxBytes`, keeping the tail (logs put the failure at the end). */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return slice.toString('utf8');
}

async function toError(res: Response, path: string): Promise<GitHubError> {
  let message = `GitHub API ${res.status} for ${path.split('?')[0]}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message += `: ${body.message}`;
  } catch {
    /* non-JSON body */
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    message = 'GitHub API rate limit reached. Configure a token (see Settings) or wait for the reset.';
  }
  return new GitHubError(res.status, message);
}

export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m =
    trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/) ??
    trimmed.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}
