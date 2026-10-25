import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

/**
 * Ordered, append-only migrations. Never edit a shipped migration — add a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);

  CREATE TABLE repositories (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('github','local')),
    full_name TEXT NOT NULL,
    url TEXT,
    local_path TEXT,
    description TEXT,
    is_private INTEGER,
    default_branch TEXT,
    languages TEXT NOT NULL DEFAULT '{}',
    frameworks TEXT NOT NULL DEFAULT '[]',
    latest_commit TEXT,
    license TEXT,
    created_at TEXT NOT NULL,
    last_analyzed_at TEXT,
    last_analysis_status TEXT,
    last_error TEXT,
    UNIQUE (kind, full_name)
  );
  CREATE TABLE analyses (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    summary TEXT,
    checks_run TEXT,
    error TEXT
  );
  CREATE INDEX idx_analyses_repo ON analyses(repo_id, started_at);
  CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
    title TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    package TEXT,
    evidence TEXT,
    explanation TEXT,
    remediation TEXT,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','suppressed')),
    suppression_reason TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (repo_id, fingerprint)
  );
  CREATE INDEX idx_findings_status ON findings(status, severity);

  CREATE TABLE workflow_runs (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    workflow_name TEXT NOT NULL,
    workflow_id INTEGER,
    branch TEXT,
    head_sha TEXT,
    commit_message TEXT,
    event TEXT,
    status TEXT,
    conclusion TEXT,
    run_number INTEGER,
    run_attempt INTEGER,
    html_url TEXT,
    actor TEXT,
    pr_numbers TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT,
    duration_s INTEGER
  );
  CREATE INDEX idx_runs_repo_created ON workflow_runs(repo_id, created_at);
  CREATE TABLE run_diagnoses (
    run_id INTEGER PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    job_id INTEGER,
    job_name TEXT,
    failed_step TEXT,
    category TEXT NOT NULL,
    confidence TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    log_available INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    verified_by_run_id INTEGER,
    verified_at TEXT
  );

  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    interval_s INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL,
    expected_status TEXT NOT NULL DEFAULT '200-399',
    retries INTEGER NOT NULL DEFAULT 1,
    failure_threshold INTEGER NOT NULL DEFAULT 2,
    latency_threshold_ms INTEGER NOT NULL DEFAULT 1000,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_ok INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    tls_valid_to TEXT
  );
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER,
    dns_ms INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    manual INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_checks_monitor_ts ON checks(monitor_id, ts);

  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('monitor','pipeline','security','manual')),
    ref TEXT,
    repo_id INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
    monitor_id INTEGER REFERENCES monitors(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
    status TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
    started_at TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT,
    resolution TEXT,
    notes TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_incidents_status ON incidents(status, detected_at);
  CREATE UNIQUE INDEX idx_incidents_open_ref ON incidents(source, ref) WHERE status != 'resolved';

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT
  );
  CREATE INDEX idx_events_ts ON events(ts);

  CREATE TABLE site_scans (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    ts TEXT NOT NULL,
    result TEXT NOT NULL
  );

  CREATE TABLE load_tests (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('builtin','k6-import')),
    target TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    result TEXT,
    environment TEXT,
    notes TEXT
  );

  CREATE TABLE health_snapshots (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    score REAL,
    coverage REAL NOT NULL,
    components TEXT NOT NULL
  );
  CREATE INDEX idx_health_ts ON health_snapshots(ts);
  `,
  // v2 — response assertions, recovery hysteresis, heartbeat monitors, notification channels.
  `
  ALTER TABLE monitors ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE monitors ADD COLUMN success_threshold INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE monitors ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE checks ADD COLUMN details TEXT;

  CREATE TABLE heartbeats (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    timeout_s INTEGER NOT NULL,
    grace_s INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new','up','down','paused')),
    last_ping_at TEXT,
    last_start_at TEXT,
    last_duration_ms INTEGER,
    last_event TEXT,
    alert_after TEXT,
    n_pings INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_heartbeats_alert_after ON heartbeats(alert_after) WHERE status = 'up';
  CREATE TABLE heartbeat_pings (
    id INTEGER PRIMARY KEY,
    heartbeat_id INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    body TEXT,
    ip TEXT
  );
  CREATE INDEX idx_heartbeat_pings ON heartbeat_pings(heartbeat_id, ts);

  CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('webhook')),
    config_enc TEXT NOT NULL,
    target_hint TEXT NOT NULL,
    allow_private INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_sent_at TEXT,
    last_error TEXT
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX idx_notifications_pending ON notifications(status, next_attempt_at);
  `,
];

export function openDb(dataDir: string, filename = 'sentinelops.db'): DB {
  let file = ':memory:';
  if (filename !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, filename);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, now());
    });
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
