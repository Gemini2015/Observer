import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam } from '../http/schemas.js';

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
