import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Directory with the built web UI; served when present. */
  webDir: string | null;
  /** Set when served over HTTPS (or behind a TLS-terminating proxy) so cookies get `Secure`. */
  secureCookies: boolean;
  trustProxy: boolean;
  sessionTtlHours: number;
  githubToken: string | null;
  /** Allow scheduled monitors to run. Tests disable this. */
  enableScheduler: boolean;
  logLevel: string;
  /** Use ':memory:' in tests. */
  dbFile: string;
  /** Login/setup attempts per IP per minute. */
  authRateLimitPerMin: number;
  /** API requests per session (or per IP when anonymous) per minute. */
  apiRateLimitPerMin: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  return {
    host: env.SENTINELOPS_HOST ?? '127.0.0.1',
    port: Number(env.SENTINELOPS_PORT ?? env.PORT ?? 4600),
    dataDir: path.resolve(env.SENTINELOPS_DATA_DIR ?? path.join(root, 'data')),
    webDir: env.SENTINELOPS_WEB_DIR ?? path.join(root, 'apps', 'web', 'dist'),
    secureCookies: bool(env.SENTINELOPS_SECURE_COOKIES, false),
    trustProxy: bool(env.SENTINELOPS_TRUST_PROXY, false),
    sessionTtlHours: Number(env.SENTINELOPS_SESSION_TTL_HOURS ?? 12),
    githubToken: env.GITHUB_TOKEN || null,
    enableScheduler: bool(env.SENTINELOPS_SCHEDULER, true),
    logLevel: env.LOG_LEVEL ?? 'info',
    dbFile: env.SENTINELOPS_DB_FILE ?? 'sentinelops.db',
    authRateLimitPerMin: Number(env.SENTINELOPS_AUTH_RATE_LIMIT ?? 10),
    apiRateLimitPerMin: Number(env.SENTINELOPS_API_RATE_LIMIT ?? 600),
    ...overrides,
  };
}
