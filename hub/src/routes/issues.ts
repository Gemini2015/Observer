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

type IssueStatusKey = 'open' | 'acked' | 'ignored' | 'resolved';
type IssueTypeKey = 'mismatch' | 'missing' | 'unreadable';

const ALLOWED_STATUS: ReadonlySet<string> = new Set<IssueStatusKey>([
  'open',
  'acked',
  'ignored',
  'resolved',
]);
const ALLOWED_TYPES: ReadonlySet<string> = new Set<IssueTypeKey>([
  'mismatch',
  'missing',
  'unreadable',
]);

/** LIKE 模式转义：`\` `%` `_` 均按字面量匹配（配合 ESCAPE '\'）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function registerIssueRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/issues/summary', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;

    const status: Record<IssueStatusKey, number> = {
      open: 0,
      acked: 0,
      ignored: 0,
      resolved: 0,
    };
    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM issues GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    for (const row of statusRows) {
      if (
        row.status === 'open' ||
        row.status === 'acked' ||
        row.status === 'ignored' ||
        row.status === 'resolved'
      ) {
        status[row.status] = row.count;
      }
    }

    // 类型分布口径与总览一致：只看仍需处理的 open 异常。
    const type: Record<IssueTypeKey, number> = { mismatch: 0, missing: 0, unreadable: 0 };
    const typeRows = db
      .prepare("SELECT type, COUNT(*) AS count FROM issues WHERE status = 'open' GROUP BY type")
      .all() as Array<{ type: string; count: number }>;
    for (const row of typeRows) {
      if (row.type === 'mismatch' || row.type === 'missing' || row.type === 'unreadable') {
        type[row.type] = row.count;
      }
    }

    const machines = db
      .prepare(
        `SELECT mc.machine_id AS machine_id, COUNT(*) AS open
         FROM issues i
         JOIN mounts m ON m.id = i.mount_pk
         JOIN machines mc ON mc.id = m.machine_pk
         WHERE i.status = 'open'
         GROUP BY mc.machine_id
         ORDER BY open DESC, mc.machine_id`,
      )
      .all() as Array<{ machine_id: string; open: number }>;

    return { status, type, machines };
  });

  app.get('/api/v1/issues', async (request) => {
    requireSession(ctx.db, request);
    const query = request.query as {
      status?: string;
      machine_id?: string;
      type?: string;
      q?: string;
    };

    const conditions: string[] = [];
    const params: string[] = [];
    if (query.status && ALLOWED_STATUS.has(query.status)) {
      conditions.push('i.status = ?');
      params.push(query.status);
    }
    if (query.machine_id) {
      conditions.push('mc.machine_id = ?');
      params.push(query.machine_id);
    }
    if (query.type && ALLOWED_TYPES.has(query.type)) {
      conditions.push('i.type = ?');
      params.push(query.type);
    }
    if (query.q) {
      conditions.push("p.path_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.q)}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = ctx.db
      .prepare(
        `SELECT i.id, i.type, i.status, i.confidence, i.occurrences,
                i.first_seen_at, i.last_seen_at, i.resolved_at, i.evidence_json,
                p.path_key, p.path_display, m.mount_id, mc.machine_id
         FROM issues i
         JOIN paths p ON p.id = i.path_pk
         JOIN mounts m ON m.id = i.mount_pk
         JOIN machines mc ON mc.id = m.machine_pk
         ${where}
         ORDER BY i.last_seen_at DESC
         LIMIT 500`,
      )
      .all(...params) as IssueListRow[];

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
