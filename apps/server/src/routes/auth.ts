import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logAudit, requireSession, type AppContext } from '../context.ts';
import { audit } from '../lib/events.ts';

export const SESSION_COOKIE = 'so_session';

const credentials = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.secureCookies,
      path: '/',
      maxAge: ctx.config.sessionTtlHours * 3600,
    });

  app.get('/api/auth/status', { config: { public: true } }, async (req) => ({
    setupRequired: ctx.auth.setupRequired(),
    authenticated: !!req.session,
    user: req.session?.user ?? null,
    csrfToken: req.session?.csrfToken ?? null,
  }));

  const rateLimit = { max: ctx.config.authRateLimitPerMin, timeWindow: '1 minute' };
  const publicLimited = { config: { public: true, rateLimit } };
  const anyRoleLimited = { config: { anyRole: true, rateLimit } };

  app.post('/api/auth/setup', publicLimited, async (req, reply) => {
    const body = credentials.extend({ token: z.string().min(10).max(200) }).parse(req.body);
    const user = await ctx.auth.completeSetup(body.token, body.username, body.password);
    audit(ctx.db, { userId: user.id, username: user.username, action: 'auth.setup', detail: 'Initial administrator created', ip: req.ip });
    ctx.bus.publish('auth.setup', 'success', `Administrator account "${user.username}" created`);
    const { token, session } = ctx.auth.createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
    setCookie(reply, token);
    return { user: session.user, csrfToken: session.csrfToken };
  });

  app.post('/api/auth/login', publicLimited, async (req, reply) => {
    const body = credentials.parse(req.body);
    try {
      const { token, session } = await ctx.auth.login(body.username, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
      audit(ctx.db, { userId: session.user.id, username: session.user.username, action: 'auth.login', ip: req.ip });
      setCookie(reply, token);
      return { user: session.user, csrfToken: session.csrfToken };
    } catch (err) {
      audit(ctx.db, { username: body.username.slice(0, 64), action: 'auth.login_failed', detail: (err as Error).message, ip: req.ip });
      throw err;
    }
  });

  app.post('/api/auth/accept-invite', publicLimited, async (req, reply) => {
    const body = credentials.extend({ token: z.string().min(10).max(200) }).parse(req.body);
    const user = await ctx.auth.acceptInvite(body.token, body.username, body.password);
    audit(ctx.db, { userId: user.id, username: user.username, action: 'auth.invite_accepted', detail: `role=${user.role}`, ip: req.ip });
    const { token, session } = ctx.auth.createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
    setCookie(reply, token);
    return { user: session.user, csrfToken: session.csrfToken };
  });

  app.post('/api/auth/logout', { config: { anyRole: true } }, async (req, reply) => {
    const s = requireSession(req);
    ctx.auth.logout(s.tokenHash);
    logAudit(ctx, req, 'auth.logout');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', anyRoleLimited, async (req) => {
    const s = requireSession(req);
    const body = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).parse(req.body);
    await ctx.auth.changePassword(s.user.id, body.currentPassword, body.newPassword, s.tokenHash);
    logAudit(ctx, req, 'auth.password_changed');
    return { ok: true };
  });

  // --- User administration (admin only) ---
  app.get('/api/users', { config: { adminOnly: true } }, async () => ({ users: ctx.auth.listUsers(), maxUsers: ctx.auth.maxUsers, seats: ctx.auth.seatsUsed() }));

  app.post('/api/users/invites', async (req) => {
    const s = requireSession(req);
    const body = z.object({ role: z.enum(['admin', 'viewer']).default('viewer') }).parse(req.body ?? {});
    const token = ctx.auth.createInvite(s.user.id, body.role);
    logAudit(ctx, req, 'users.invite_created', null, `role=${body.role}`);
    return { token, expiresInHours: 24 };
  });

  app.delete('/api/users/:id', async (req) => {
    const s = requireSession(req);
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    ctx.auth.deleteUser(id, s.user.id);
    logAudit(ctx, req, 'users.deleted', String(id));
    return { ok: true };
  });

  app.get('/api/audit', { config: { adminOnly: true } }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { entries: ctx.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(q.limit) };
  });
}
