import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { requireSession } from '../http/auth.js';
import { BulkScanRequest } from '../http/schemas.js';
import { createBulkScanJobs } from '../services/scans.js';

export function registerScanRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/v1/scans', async (request, reply) => {
    requireSession(ctx.db, request);
    const body = BulkScanRequest.parse(request.body ?? {});
    const result = createBulkScanJobs(ctx.db, body, 'user');
    return reply.code(202).send(result);
  });
}
