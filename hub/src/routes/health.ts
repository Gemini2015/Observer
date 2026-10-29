import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/healthz', async () => {
    ctx.db.prepare('SELECT 1').get();
    return { status: 'ok', time: Date.now() };
  });
}
