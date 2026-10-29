import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam, RepairRequestSchema } from '../http/schemas.js';
import { getIssueRepairContext, listReplicas } from '../services/replicas.js';
import { createRepair, transfersPath } from '../services/repairs.js';

interface IssueListRow {
  id: number;
  type: string;
  status: string;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  evidence_json: string | null;
  path_key: string;
  path_display: Buffer;
  mount_id: string;
  machine_id: string;
}

const ALLOWED_STATUS = new Set(['open', 'acked', 'ignored', 'resolved']);

export function registerIssueRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/issues', async (request) => {
    requireSession(ctx.db, request);
    const query = request.query as { status?: string };
    const status = query.status && ALLOWED_STATUS.has(query.status) ? query.status : undefined;

    const statement = ctx.db.prepare(`
      SELECT i.id, i.type, i.status, i.confidence, i.occurrences,
             i.first_seen_at, i.last_seen_at, i.resolved_at, i.evidence_json,
             p.path_key, p.path_display, m.mount_id, mc.machine_id
      FROM issues i
      JOIN paths p ON p.id = i.path_pk
      JOIN mounts m ON m.id = i.mount_pk
      JOIN machines mc ON mc.id = m.machine_pk
      ${status ? 'WHERE i.status = ?' : ''}
      ORDER BY i.last_seen_at DESC
      LIMIT 500
    `);
    const rows = (status ? statement.all(status) : statement.all()) as IssueListRow[];

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      confidence: row.confidence,
      occurrences: row.occurrences,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      resolved_at: row.resolved_at,
      evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as unknown) : null,
      path_key: row.path_key,
      path_display_b64: Buffer.from(row.path_display).toString('base64'),
      mount_id: row.mount_id,
      machine_id: row.machine_id,
    }));
  });

  app.get('/api/v1/issues/:id', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const context = getIssueRepairContext(ctx.db, issueId);
    if (!context) throw new HttpError(404, 'issue not found');
    return {
      id: context.issueId,
      type: context.issueType,
      status: context.issueStatus,
      confidence: context.confidence,
      evidence: context.evidence,
      path_key: context.targetPathKey,
      mount_id: context.targetMountId,
      machine_id: context.targetMachineId,
      target_state: context.targetState,
      target_size: context.targetSize,
      expected_hash: context.expectedHash,
      observed_hash: context.observedHash,
      repair_allowed: context.repairAllowed,
    };
  });

  app.get('/api/v1/issues/:id/replicas', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const context = getIssueRepairContext(ctx.db, issueId);
    if (!context) throw new HttpError(404, 'issue not found');
    return {
      issue_id: issueId,
      expected_hash: context.expectedHash,
      repair_allowed: context.repairAllowed,
      source_repairable: context.issueType === 'mismatch' || context.issueType === 'missing',
      replicas: listReplicas(ctx.db, issueId),
    };
  });

  app.post('/api/v1/issues/:id/repair', async (request, reply) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const body = RepairRequestSchema.parse(request.body);
    const result = createRepair(ctx.db, issueId, body.source_path_id, {
      transfersDir: transfersPath(ctx.env.OBSERVER_DATA_DIR),
    });
    return reply.code(202).send(result);
  });

  app.post('/api/v1/issues/:id/ack', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const info = ctx.db
      .prepare("UPDATE issues SET status = 'acked', last_seen_at = ? WHERE id = ? AND status = 'open'")
      .run(Date.now(), issueId);
    if (info.changes === 0) {
      throw new HttpError(404, 'issue not found or not open');
    }
    return { ok: true };
  });

  app.post('/api/v1/issues/:id/ignore', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const info = ctx.db
      .prepare(
        "UPDATE issues SET status = 'ignored', last_seen_at = ? WHERE id = ? AND status IN ('open','acked')",
      )
      .run(Date.now(), issueId);
    if (info.changes === 0) {
      throw new HttpError(404, 'issue not found or not ignorable');
    }
    return { ok: true };
  });
}
