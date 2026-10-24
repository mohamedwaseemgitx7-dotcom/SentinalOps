import fs from 'node:fs';
import path from 'node:path';
import { getSetting, now, setSetting, tx, type DB } from '../db.ts';
import { getDummyHash, hashPassword, passwordProblems, randomToken, safeEqual, sha256, verifyPassword } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, HttpError, unauthorized } from '../lib/errors.ts';

export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionInfo {
  user: User;
  csrfToken: string;
  tokenHash: string;
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/i;
const LOCKOUT_THRESHOLD = 5;
const SETUP_TOKEN_KEY = 'auth.setup_token_hash';

export class AuthService {
  private db: DB;
  private dataDir: string;
  private sessionTtlHours: number;

  constructor(db: DB, dataDir: string, sessionTtlHours: number) {
    this.db = db;
    this.dataDir = dataDir;
    this.sessionTtlHours = sessionTtlHours;
  }

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  setupRequired(): boolean {
    return this.userCount() === 0;
  }

  /**
   * First-run bootstrap: a random one-time token is written to the data directory
   * (readable only by whoever controls this machine) and must be presented to create
   * the first administrator. No default credentials exist anywhere.
   */
  ensureSetupToken(): { token: string; file: string } | null {
    if (!this.setupRequired()) {
      setSetting(this.db, SETUP_TOKEN_KEY, null);
      this.removeSetupFile();
      return null;
    }
    const token = randomToken(24);
    setSetting(this.db, SETUP_TOKEN_KEY, sha256(token));
    const file = this.setupFile();
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return { token, file };
  }

  setupFile(): string {
    return path.join(this.dataDir, 'setup-token.txt');
  }

  private removeSetupFile(): void {
    fs.rmSync(this.setupFile(), { force: true });
  }

  async completeSetup(token: string, username: string, password: string): Promise<User> {
    const expected = getSetting(this.db, SETUP_TOKEN_KEY);
    if (!this.setupRequired() || !expected) throw conflict('Setup has already been completed.');
    if (!safeEqual(sha256(token.trim()), expected)) throw forbidden('Invalid setup token.');
    const user = await this.createUser(username, password, 'admin');
    setSetting(this.db, SETUP_TOKEN_KEY, null);
    this.removeSetupFile();
    return user;
  }

  async createUser(username: string, password: string, role: Role): Promise<User> {
    if (!USERNAME_RE.test(username)) throw badRequest('Username must be 3–32 characters: letters, digits, dot, dash or underscore.');
    const problems = passwordProblems(password, username);
    if (problems.length) throw badRequest(problems.join(' '));
    const exists = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) throw conflict('That username is taken.');
    const hash = await hashPassword(password);
    const info = this.db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, role, now());
    return this.getUser(Number(info.lastInsertRowid))!;
  }

  getUser(id: number): User | null {
    return (this.db.prepare('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?').get(id) as unknown as User) ?? null;
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY id').all() as unknown as User[];
  }

  /**
   * Verifies credentials with constant-ish timing and a per-account lockout
   * (in addition to the per-IP rate limit applied at the route).
   */
  async login(username: string, password: string, meta: { ip: string; userAgent: string }): Promise<{ token: string; session: SessionInfo }> {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | (User & { password_hash: string; failed_logins: number; locked_until: string | null })
      | undefined;
    if (!row) {
      await verifyPassword(password, await getDummyHash());
      throw unauthorized('Invalid username or password.');
    }
    if (row.locked_until && row.locked_until > now()) {
      throw new HttpError(429, 'Too many failed attempts. Try again later.', 'locked');
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      const failed = row.failed_logins + 1;
      const lockMinutes = failed >= LOCKOUT_THRESHOLD ? Math.min(60, 2 ** (failed - LOCKOUT_THRESHOLD)) : 0;
      const lockedUntil = lockMinutes ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
      this.db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil, row.id);
      throw unauthorized('Invalid username or password.');
    }
    this.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now(), row.id);
    return this.createSession(row.id, meta);
  }

  createSession(userId: number, meta: { ip: string; userAgent: string }): { token: string; session: SessionInfo } {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const tokenHash = sha256(token);
    const ts = now();
    const expires = new Date(Date.now() + this.sessionTtlHours * 3_600_000).toISOString();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash, userId, csrfToken, ts, ts, expires, meta.ip, meta.userAgent.slice(0, 200));
    return { token, session: { user: this.getUser(userId)!, csrfToken, tokenHash } };
  }

  resolveSession(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = this.db.prepare('SELECT user_id, csrf_token, expires_at, last_seen_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { user_id: number; csrf_token: string; expires_at: string; last_seen_at: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    const user = this.getUser(row.user_id);
    if (!user) return null;
    // Sliding expiry, but only write at most once a minute.
    if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
      const expires = new Date(Date.now() + this.sessionTtlHours * 3_600_000).toISOString();
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now(), expires, tokenHash);
    }
    return { user, csrfToken: row.csrf_token, tokenHash };
  }

  logout(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async changePassword(userId: number, current: string, next: string, keepTokenHash: string): Promise<void> {
    const row = this.db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(userId) as { username: string; password_hash: string };
    if (!(await verifyPassword(current, row.password_hash))) throw unauthorized('Current password is incorrect.');
    const problems = passwordProblems(next, row.username);
    if (problems.length) throw badRequest(problems.join(' '));
    const hash = await hashPassword(next);
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      // Revoke every other session after a password change.
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash);
    });
  }

  createInvite(createdBy: number, role: Role, ttlHours = 24): string {
    const token = randomToken(24);
    this.db
      .prepare('INSERT INTO invites (token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), role, createdBy, now(), new Date(Date.now() + ttlHours * 3_600_000).toISOString());
    return token;
  }

  async acceptInvite(token: string, username: string, password: string): Promise<User> {
    const tokenHash = sha256(token);
    const invite = this.db.prepare('SELECT role, expires_at, used_at FROM invites WHERE token_hash = ?').get(tokenHash) as
      | { role: Role; expires_at: string; used_at: string | null }
      | undefined;
    if (!invite || invite.used_at || invite.expires_at <= now()) throw forbidden('This invitation is invalid or has expired.');
    const user = await this.createUser(username, password, invite.role);
    this.db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(now(), tokenHash);
    return user;
  }

  deleteUser(id: number, actingUserId: number): void {
    if (id === actingUserId) throw badRequest('You cannot delete your own account.');
    const target = this.getUser(id);
    if (!target) return;
    if (target.role === 'admin') {
      const admins = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
      if (admins <= 1) throw badRequest('At least one administrator must remain.');
    }
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    this.db.prepare('DELETE FROM invites WHERE expires_at <= ? OR used_at IS NOT NULL').run(now());
  }
}
