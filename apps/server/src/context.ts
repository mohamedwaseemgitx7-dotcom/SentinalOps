import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Analyzer } from './analysis/analyzer.ts';
import type { PipelineService } from './analysis/pipelines.ts';
import type { AuthService, SessionInfo } from './auth/service.ts';
import type { AppConfig } from './config.ts';
import type { DB } from './db.ts';
import type { GitHubClient } from './github/client.ts';
import type { IncidentService } from './incidents.ts';
import { audit, type EventBus } from './lib/events.ts';
import type { LoadTestRunner } from './loadtest/runner.ts';
import type { HeartbeatService } from './monitoring/heartbeats.ts';
import type { MonitorScheduler } from './monitoring/scheduler.ts';
import type { Notifier } from './notifications.ts';

export interface AppContext {
  config: AppConfig;
  db: DB;
  bus: EventBus;
  auth: AuthService;
  gh: GitHubClient;
  incidents: IncidentService;
  analyzer: Analyzer;
  pipelines: PipelineService;
  scheduler: MonitorScheduler;
  heartbeats: HeartbeatService;
  notifier: Notifier;
  loadTests: LoadTestRunner;
  startedAt: string;
  version: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

export function requireSession(req: FastifyRequest): SessionInfo {
  // The global guard guarantees this for non-public routes.
  return req.session!;
}

export function logAudit(ctx: AppContext, req: FastifyRequest, action: string, target?: string | null, detail?: string | null): void {
  audit(ctx.db, { userId: req.session?.user.id, username: req.session?.user.username, action, target, detail, ip: req.ip });
}

export type Reply = FastifyReply;
