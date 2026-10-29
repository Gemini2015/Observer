import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { Db } from '../db/index.js';
import { registerAgentRoutes } from './agent.js';
import { registerAuthRoutes } from './auth.js';
import { registerHealthRoutes } from './health.js';

export interface RouteContext {
  env: Env;
  db: Db;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
}
