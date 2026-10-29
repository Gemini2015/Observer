import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { computeCoverage, RECHECK_DAYS } from '../services/jobs.js';

interface MachineRow {
  id: number;
  machine_id: string;
  label: string | null;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  status: string;
  last_seen_at: number | null;
  agent_version: string | null;
  agent_protocol: number | null;
}

interface MountRow {
  id: number;
  mount_id: string;
  label: string | null;
  state: string;
  manifest_epoch: number;
}

interface JobRow {
  id: number;
  mount_pk: number;
  mode: string;
  status: string;
  attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  stats_json: string | null;
  mount_id: string;
  machine_id: string;
}

function parseStats(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jobView(row: JobRow): Record<string, unknown> {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    attempt: row.attempt,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    stats: parseStats(row.stats_json),
    mount_id: row.mount_id,
    machine_id: row.machine_id,
  };
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/overview', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;
    const now = Date.now();
    const threshold = now - RECHECK_DAYS * 24 * 60 * 60 * 1000;

    const machines = db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END),0) AS online FROM machines",
      )
      .get() as { total: number; online: number };
    const mounts = db
      .prepare("SELECT COUNT(*) AS total FROM mounts WHERE state != 'removed'")
      .get() as { total: number };
    const pathCounts = db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN last_hashed_at IS NOT NULL AND last_hashed_at >= ? THEN 1 ELSE 0 END),0) AS hashed FROM paths WHERE state = 'active'",
      )
      .get(threshold) as { total: number; hashed: number };
    const issues = db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END),0) AS open, COALESCE(SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END),0) AS acked FROM issues",
      )
      .get() as { open: number; acked: number };
    const issuesByType = { mismatch: 0, missing: 0, unreadable: 0 };
    const issueTypeRows = db
      .prepare("SELECT type, COUNT(*) AS count FROM issues WHERE status = 'open' GROUP BY type")
      .all() as Array<{ type: string; count: number }>;
    for (const row of issueTypeRows) {
      if (row.type === 'mismatch' || row.type === 'missing' || row.type === 'unreadable') {
        issuesByType[row.type] = row.count;
      }
    }
    const issuesByMachine = db
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
    const jobs = db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),0) AS running FROM scan_jobs",
      )
      .get() as { pending: number; running: number };

    const recent = db
      .prepare(
        'SELECT j.id, j.mount_pk, j.mode, j.status, j.attempt, j.created_at, j.started_at, j.finished_at, j.stats_json, m.mount_id, mc.machine_id FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk JOIN machines mc ON mc.id = m.machine_pk ORDER BY j.id DESC LIMIT 10',
      )
      .all() as JobRow[];

    return {
      machines,
      mounts,
      coverage: {
        total: pathCounts.total,
        hashed: pathCounts.hashed,
        ratio: pathCounts.total === 0 ? 1 : pathCounts.hashed / pathCounts.total,
      },
      issues,
      issues_by_type: issuesByType,
      issues_by_machine: issuesByMachine,
      jobs,
      recent_jobs: recent.map(jobView),
    };
  });

  app.get('/api/v1/machines', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;
    const machines = db
      .prepare(
        `SELECT m.*, a.version AS agent_version, a.protocol AS agent_protocol
         FROM machines m
         LEFT JOIN agents a ON a.id = (SELECT id FROM agents WHERE machine_pk = m.id ORDER BY id DESC LIMIT 1)
         ORDER BY m.machine_id`,
      )
      .all() as MachineRow[];
    const mountStatement = db.prepare(
      "SELECT id, mount_id, label, state, manifest_epoch FROM mounts WHERE machine_pk = ? AND state != 'removed' ORDER BY mount_id",
    );
    const now = Date.now();

    return machines.map((machine) => {
      const mounts = mountStatement.all(machine.id) as MountRow[];
      return {
        ...machine,
        mounts: mounts.map((mount) => ({
          ...mount,
          coverage: computeCoverage(db, mount.id, now),
        })),
      };
    });
  });

  app.get('/api/v1/audit', async (request) => {
    requireSession(ctx.db, request);
    const query = request.query as { limit?: string; action?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100) || 100));
    const rows = (
      query.action
        ? ctx.db
            .prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ?')
            .all(`${query.action}%`, limit)
        : ctx.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
    ) as Array<{
      id: number;
      actor: string;
      action: string;
      target: string | null;
      detail_json: string | null;
      at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      target: row.target,
      detail: row.detail_json ? (JSON.parse(row.detail_json) as unknown) : null,
      at: row.at,
    }));
  });

  app.get('/api/v1/jobs', async (request) => {
    requireSession(ctx.db, request);
    const query = request.query as { limit?: string; status?: string; mount_id?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      conditions.push('j.status = ?');
      params.push(query.status);
    }
    if (query.mount_id) {
      conditions.push('m.mount_id = ?');
      params.push(query.mount_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const rows = ctx.db
      .prepare(
        `SELECT j.id, j.mount_pk, j.mode, j.status, j.attempt, j.created_at, j.started_at, j.finished_at, j.stats_json, m.mount_id, mc.machine_id
         FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk JOIN machines mc ON mc.id = m.machine_pk
         ${where} ORDER BY j.id DESC LIMIT ?`,
      )
      .all(...params) as JobRow[];

    return rows.map(jobView);
  });

  app.get('/api/v1/jobs/:id', async (request) => {
    requireSession(ctx.db, request);
    const jobId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new HttpError(422, 'validation failed', 'invalid job id');
    }
    const row = ctx.db
      .prepare(
        'SELECT j.id, j.mount_pk, j.mode, j.status, j.attempt, j.created_at, j.started_at, j.finished_at, j.stats_json, m.mount_id, mc.machine_id FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk JOIN machines mc ON mc.id = m.machine_pk WHERE j.id = ?',
      )
      .get(jobId) as JobRow | undefined;
    if (!row) throw new HttpError(404, 'job not found');
    return jobView(row);
  });
}
