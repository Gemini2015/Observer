import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { FileExportQuerySchema, FileListQuerySchema, IdParam } from '../http/schemas.js';
import { getFileDetail, listFiles, listFilesCsv } from '../services/files.js';

export function registerFileRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/files', async (request) => {
    requireSession(ctx.db, request);
    const query = FileListQuerySchema.parse(request.query ?? {});
    if (
      query.size_min !== undefined &&
      query.size_max !== undefined &&
      query.size_min > query.size_max
    ) {
      throw new HttpError(422, 'validation failed', 'size_min must be <= size_max');
    }
    return listFiles(ctx.db, query);
  });

  app.get('/api/v1/files/export', async (request, reply) => {
    requireSession(ctx.db, request);
    const query = FileExportQuerySchema.parse(request.query ?? {});
    if (
      query.size_min !== undefined &&
      query.size_max !== undefined &&
      query.size_min > query.size_max
    ) {
      throw new HttpError(422, 'validation failed', 'size_min must be <= size_max');
    }
    const { csv, truncated, total } = listFilesCsv(ctx.db, query);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="observer-files.csv"');
    reply.header('X-Observer-Total', String(total));
    if (truncated) {
      reply.header('X-Observer-Truncated', 'true');
    }
    return `\uFEFF${csv}`;
  });

  app.get('/api/v1/files/:id', async (request) => {
    requireSession(ctx.db, request);
    const pathId = IdParam.parse((request.params as { id: string }).id);
    const detail = getFileDetail(ctx.db, pathId);
    if (!detail) throw new HttpError(404, 'file not found');
    return detail;
  });
}
