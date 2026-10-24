import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Analyzer } from './analysis/analyzer.ts';
import { PipelineService } from './analysis/pipelines.ts';
import { AuthService } from './auth/service.ts';
import type { AppConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { now, openDb } from './db.ts';
import { GitHubClient } from './github/client.ts';
import { snapshotHealth } from './health.ts';
import { IncidentService } from './incidents.ts';
import { safeEqual, sha256 } from './lib/crypto.ts';
import { HttpError } from './lib/errors.ts';
import { EventBus } from './lib/events.ts';
import { LoadTestRunner } from './loadtest/runner.ts';
import { MonitorScheduler } from './monitoring/scheduler.ts';
import { authRoutes, SESSION_COOKIE } from './routes/auth.ts';
import { opsRoutes } from './routes/ops.ts';
import { repoRoutes } from './routes/repos.ts';
import { systemRoutes } from './routes/system.ts';

export const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** No session required. */
    public?: boolean;
    /** Admin required even for GET. */
    adminOnly?: boolean;
    /** Mutation allowed for any signed-in role (e.g. logout, own password). */
    anyRole?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(config: AppConfig): Promise<{ app: FastifyInstance; ctx: AppContext; setup: { token: string; file: string } | null }> {
  const db = openDb(config.dataDir, config.dbFile);
  const bus = new EventBus(db);
  const auth = new AuthService(db, config.dataDir, config.sessionTtlHours);
  const gh = new GitHubClient(db, config.githubToken);
  const incidents = new IncidentService(db, bus);
  const ctx: AppContext = {
    config, db, bus, auth, gh, incidents,
    analyzer: new Analyzer(db, gh, bus, incidents),
    pipelines: new PipelineService(db, gh, bus, incidents),
    scheduler: new MonitorScheduler(db, bus, incidents),
    loadTests: new LoadTestRunner(db, bus),
    startedAt: now(),
    version: VERSION,
  };

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      // Never log cookies, auth headers or bodies.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    requestTimeout: 120_000,
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
    strictTransportSecurity: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.apiRateLimitPerMin,
    timeWindow: '1 minute',
    // Static assets and the trivial liveness probe are not limited; the rest of the API is.
    allowList: (req) => !req.url.startsWith('/api/') || req.url === '/api/health',
    // Signed-in users are limited per session, so users behind one NAT/proxy do not starve each other.
    keyGenerator: (req) => {
      const token = req.cookies?.[SESSION_COOKIE];
      return token ? `s:${sha256(token)}` : `ip:${req.ip}`;
    },
  });

  app.decorateRequest('session', null);

  // Global guard: authentication, role checks and CSRF for every API route.
  app.addHook('onRequest', async (req) => {
    req.session = ctx.auth.resolveSession(req.cookies[SESSION_COOKIE]);
    if (!req.url.startsWith('/api/')) return;
    const cfg = req.routeOptions.config;
    if (cfg?.public) return;
    if (!req.routeOptions.url) return; // unknown route → 404 handler
    if (!req.session) throw new HttpError(401, 'Authentication required', 'unauthorized');
    const mutation = !SAFE_METHODS.has(req.method);
    if (mutation) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, req.session.csrfToken)) throw new HttpError(403, 'Missing or invalid CSRF token', 'csrf');
    }
    if ((cfg?.adminOnly || (mutation && !cfg?.anyRole)) && req.session.user.role !== 'admin') {
      throw new HttpError(403, 'This action requires the administrator role.', 'forbidden');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'error', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: `Something went wrong on the server (request ${req.id}).` });
  });

  authRoutes(app, ctx);
  repoRoutes(app, ctx);
  opsRoutes(app, ctx);
  systemRoutes(app, ctx);

  const webDir = config.webDir && fs.existsSync(path.join(config.webDir, 'index.html')) ? config.webDir : null;
  const indexHtml = webDir ? fs.readFileSync(path.join(webDir, 'index.html')) : null;
  if (webDir) {
    // Vite emits content-hashed files under /assets, so they can be cached forever.
    await app.register(fastifyStatic, {
      root: webDir,
      index: false,
      setHeaders: (res, filePath) => res.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
    });
    // `/` is a directory to the static plugin (which would answer 403), so serve the app shell explicitly.
    app.get('/', { config: { public: true } }, (_req, reply) => reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml));
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !indexHtml || req.method !== 'GET') return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    // SPA fallback for client-side routes.
    return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);
  });

  const setup = ctx.auth.ensureSetupToken();
  const housekeeping = setInterval(() => {
    ctx.auth.purgeExpired();
    snapshotHealth(db);
  }, 5 * 60_000);
  housekeeping.unref();
  if (config.enableScheduler) ctx.scheduler.start();
  app.addHook('onClose', async () => {
    clearInterval(housekeeping);
    ctx.scheduler.stop();
    ctx.loadTests.stop();
    db.close();
  });
  return { app, ctx, setup };
}
