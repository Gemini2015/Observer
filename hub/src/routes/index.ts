import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Db } from '../db/index.js';
import { registerAgentRoutes } from './agent.js';
import { registerAuthRoutes } from './auth.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerHealthRoutes } from './health.js';
import { registerIssueRoutes } from './issues.js';
import { registerMountRoutes } from './mounts.js';

export interface RouteContext {
  env: Env;
  db: Db;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerMountRoutes(app, ctx);
  registerIssueRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
}
