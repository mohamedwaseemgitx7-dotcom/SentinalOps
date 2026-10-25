import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logAudit, type AppContext } from '../context.ts';
import { notFound } from '../lib/errors.ts';
import { HEARTBEAT_LIMITS, type PingKind } from '../monitoring/heartbeats.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const heartbeatBody = z.object({
  name: z.string().trim().min(1).max(80),
  timeoutS: z.number().int().min(HEARTBEAT_LIMITS.minTimeoutS).max(HEARTBEAT_LIMITS.maxTimeoutS),
  graceS: z.number().int().min(HEARTBEAT_LIMITS.minGraceS).max(HEARTBEAT_LIMITS.maxGraceS),
  paused: z.boolean().default(false),
});

export function heartbeatRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------------- Public ping endpoint (no session, no CSRF; the token is the credential) ----------------
  const pingConfig = {
    // Not under /api, so the global guard does not apply. Rate-limited per token+IP.
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        allowList: () => false,
        keyGenerator: (req: FastifyRequest) => `ping:${(req.params as { token?: string }).token?.slice(0, 12)}:${req.ip}`,
      },
    },
    bodyLimit: HEARTBEAT_LIMITS.bodyBytes,
  };
  const handlePing = (kind: PingKind | null) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { token, action } = req.params as { token: string; action?: string };
    let k: PingKind = kind ?? 'success';
    let exitCode: number | undefined;
    if (action !== undefined) {
      if (action === 'start' || action === 'fail') k = action;
      else if (/^\d{1,3}$/.test(action) && Number(action) <= 255) {
        k = 'exit';
        exitCode = Number(action);
      } else return reply.code(404).type('text/plain').send('not found');
    }
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return reply.code(404).type('text/plain').send('not found');
    const body = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : undefined;
    const ok = ctx.heartbeats.ping(token, k, { exitCode, body, ip: req.ip });
    reply.header('Cache-Control', 'no-store').header('Access-Control-Allow-Origin', '*').type('text/plain');
    return ok ? reply.send('OK') : reply.code(404).send('not found');
  };
  // Fastify adds HEAD automatically for GET routes.
  for (const method of ['GET', 'POST'] as const) {
    app.route({ method, url: '/ping/:token', ...pingConfig, handler: handlePing(null) });
    app.route({ method, url: '/ping/:token/:action', ...pingConfig, handler: handlePing(null) });
  }
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: HEARTBEAT_LIMITS.bodyBytes }, (_req, body, done) => done(null, body));

  // ---------------- Heartbeat management (authenticated) ----------------
  app.get('/api/heartbeats', async () => ({ heartbeats: ctx.heartbeats.list(), limits: HEARTBEAT_LIMITS }));

  app.get('/api/heartbeats/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const h = ctx.heartbeats.list().find((x) => x.id === id);
    if (!h) throw notFound('Heartbeat not found');
    return { heartbeat: h, pings: ctx.heartbeats.recentPings(id) };
  });

  app.post('/api/heartbeats', async (req) => {
    const body = heartbeatBody.parse(req.body);
    const { id, token } = ctx.heartbeats.create({ name: body.name, timeoutS: body.timeoutS, graceS: body.graceS });
    logAudit(ctx, req, 'heartbeats.created', body.name);
    ctx.bus.publish('heartbeat.created', 'info', `Heartbeat "${body.name}" created — waiting for the first ping`, '/monitoring');
    // The token is returned exactly once; only its hash is stored.
    return { id, token, pingPath: `/ping/${token}` };
  });

  app.put('/api/heartbeats/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!ctx.heartbeats.get(id)) throw notFound('Heartbeat not found');
    const body = heartbeatBody.parse(req.body);
    ctx.heartbeats.update(id, body);
    logAudit(ctx, req, 'heartbeats.updated', body.name);
    ctx.bus.invalidate('monitors');
    return { ok: true };
  });

  app.post('/api/heartbeats/:id/rotate', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!ctx.heartbeats.get(id)) throw notFound('Heartbeat not found');
    const token = ctx.heartbeats.rotateToken(id);
    logAudit(ctx, req, 'heartbeats.token_rotated', String(id));
    return { token, pingPath: `/ping/${token}` };
  });

  app.delete('/api/heartbeats/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const h = ctx.heartbeats.get(id);
    if (!h) throw notFound('Heartbeat not found');
    ctx.heartbeats.delete(id);
    logAudit(ctx, req, 'heartbeats.deleted', h.name);
    ctx.bus.invalidate('monitors');
    return { ok: true };
  });

  // ---------------- Notification channels (admin) ----------------
  app.get('/api/channels', { config: { adminOnly: true } }, async () => ({
    channels: ctx.notifier.listChannels(),
    recent: ctx.db.prepare('SELECT n.id, n.event, n.status, n.attempts, n.error, n.created_at, n.sent_at, c.name AS channel FROM notifications n JOIN channels c ON c.id = n.channel_id ORDER BY n.id DESC LIMIT 20').all(),
  }));

  app.post('/api/channels', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), url: z.string().trim().max(2000), allowPrivate: z.boolean().default(false) }).parse(req.body);
    const id = ctx.notifier.createChannel(body);
    logAudit(ctx, req, 'channels.created', body.name, `allowPrivate=${body.allowPrivate}`);
    return { id };
  });

  app.post('/api/channels/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const n = ctx.notifier.enqueue('test', { summary: '🧪 SentinelOps test notification — this channel works.' }, id);
    if (!n) throw notFound('Channel not found');
    await ctx.notifier.drain();
    const last = ctx.db.prepare('SELECT status, error FROM notifications WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(id) as { status: string; error: string | null };
    logAudit(ctx, req, 'channels.tested', String(id), last.status);
    return last;
  });

  app.put('/api/channels/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const res = ctx.db.prepare('UPDATE channels SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
    if (!res.changes) throw notFound('Channel not found');
    logAudit(ctx, req, 'channels.updated', String(id), `enabled=${body.enabled}`);
    return { ok: true };
  });

  app.delete('/api/channels/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    ctx.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    logAudit(ctx, req, 'channels.deleted', String(id));
    return { ok: true };
  });
}
