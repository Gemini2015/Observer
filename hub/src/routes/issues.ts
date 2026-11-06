import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam, IgnoreRequest, RebaselineRequest, RepairRequestSchema } from '../http/schemas.js';
import { ignoreIssue, rebaselineIssue, unignoreIssue } from '../services/issue-actions.js';
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
  ignored_hash: string | null;
  ignored_at: number | null;
  resolution: string | null;
  evidence_json: string | null;
  path_key: string;
  path_display: Buffer;
  expected_hash: string | null;
  mount_id: string;
  machine_id: string;
}

type IssueStatusKey = 'open' | 'ignored' | 'resolved';
type IssueTypeKey = 'mismatch' | 'missing' | 'unreadable';

const ALLOWED_STATUS: ReadonlySet<string> = new Set<IssueStatusKey>([
  'open',
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

function parseEvidence(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function observedHashOf(evidence: Record<string, unknown> | null): string | null {
  return evidence && typeof evidence.observed_hash === 'string' ? evidence.observed_hash : null;
}

export function registerIssueRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/issues/summary', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;

    const status: Record<IssueStatusKey, number> = {
      open: 0,
      ignored: 0,
      resolved: 0,
    };
    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM issues GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    for (const row of statusRows) {
      if (row.status === 'open' || row.status === 'ignored' || row.status === 'resolved') {
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
    // 旧链接/旧客户端仍可能传 acked；映射到 ignored。
    const requestedStatus = query.status === 'acked' ? 'ignored' : query.status;
    if (requestedStatus && ALLOWED_STATUS.has(requestedStatus)) {
      conditions.push('i.status = ?');
      params.push(requestedStatus);
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
                i.first_seen_at, i.last_seen_at, i.resolved_at,
                i.ignored_hash, i.ignored_at, i.resolution, i.evidence_json,
                p.path_key, p.path_display, p.content_hash AS expected_hash,
                m.mount_id, mc.machine_id
         FROM issues i
         JOIN paths p ON p.id = i.path_pk
         JOIN mounts m ON m.id = i.mount_pk
         JOIN machines mc ON mc.id = m.machine_pk
         ${where}
         ORDER BY i.last_seen_at DESC
         LIMIT 500`,
      )
      .all(...params) as IssueListRow[];

    return rows.map((row) => {
      const evidence = parseEvidence(row.evidence_json);
      return {
        id: row.id,
        type: row.type,
        status: row.status,
        confidence: row.confidence,
        occurrences: row.occurrences,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        resolved_at: row.resolved_at,
        ignored_hash: row.ignored_hash,
        ignored_at: row.ignored_at,
        resolution: row.resolution,
        expected_hash: row.expected_hash,
        observed_hash: observedHashOf(evidence),
        evidence,
        path_key: row.path_key,
        path_display_b64: Buffer.from(row.path_display).toString('base64'),
        mount_id: row.mount_id,
        machine_id: row.machine_id,
      };
    });
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
      ignored_hash: context.ignoredHash,
      ignored_at: context.ignoredAt,
      resolution: context.resolution,
      resolved_at: context.resolvedAt,
      repair_active: context.repairActive,
      can_rebaseline: context.canRebaseline,
      can_ignore: context.canIgnore,
      can_unignore: context.canUnignore,
      can_repair: context.canRepair,
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

  app.post('/api/v1/issues/:id/rebaseline', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const body = RebaselineRequest.parse(request.body);
    return rebaselineIssue(ctx.db, issueId, body.observed_hash);
  });

  app.post('/api/v1/issues/:id/ignore', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    const body = IgnoreRequest.parse(request.body ?? {});
    ignoreIssue(ctx.db, issueId, body.observed_hash ?? null);
    return { ok: true };
  });

  app.post('/api/v1/issues/:id/unignore', async (request) => {
    requireSession(ctx.db, request);
    const issueId = IdParam.parse((request.params as { id: string }).id);
    unignoreIssue(ctx.db, issueId);
    return { ok: true };
  });
}
