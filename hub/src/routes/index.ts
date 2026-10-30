import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Db } from '../db/index.js';
import { registerAgentRoutes } from './agent.js';
import { registerAuthRoutes } from './auth.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerFileRoutes } from './files.js';
import { registerRepairRoutes } from './repairs.js';
import { registerScanRoutes } from './scans.js';
import { registerTokenRoutes } from './tokens.js';
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
  registerFileRoutes(app, ctx);
  registerRepairRoutes(app, ctx);
  registerScanRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
}
