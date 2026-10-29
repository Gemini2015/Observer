import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam } from '../http/schemas.js';
import { cancelRepair, getRepair, listRepairs, transfersPath } from '../services/repairs.js';

export function registerRepairRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/repairs', async (request) => {
    requireSession(ctx.db, request);
    return listRepairs(ctx.db);
  });

  app.get('/api/v1/repairs/:id', async (request) => {
    requireSession(ctx.db, request);
    const repairId = IdParam.parse((request.params as { id: string }).id);
    const repair = getRepair(ctx.db, repairId);
    if (!repair) throw new HttpError(404, 'repair not found');
    return repair;
  });

  app.post('/api/v1/repairs/:id/cancel', async (request) => {
    requireSession(ctx.db, request);
    const repairId = IdParam.parse((request.params as { id: string }).id);
    return cancelRepair(
      ctx.db,
      repairId,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
  });
}
