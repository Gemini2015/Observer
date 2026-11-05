import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam } from '../http/schemas.js';
import { deleteMachine } from '../services/deletion.js';
import { transfersPath } from '../services/repairs.js';
import {
  computeCoverage,
  jobView,
  RECHECK_DAYS,
  type Coverage,
  type JobViewRow,
} from '../services/jobs.js';

const STALE_MS = 24 * 60 * 60 * 1000;

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

interface AttentionRow {
  mount_pk: number;
  mount_id: string;
  machine_id: string;
  state: string;
  last_completed_at: number | null;
  last_job_status: string | null;
}

interface MachineView extends MachineRow {
  mounts: Array<MountRow & { coverage: Coverage }>;
  open_issues: number;
  last_job_at: number | null;
}

const MACHINE_SELECT = `SELECT m.*, a.version AS agent_version, a.protocol AS agent_protocol
  FROM machines m
  LEFT JOIN agents a ON a.id = (SELECT id FROM agents WHERE machine_pk = m.id ORDER BY id DESC LIMIT 1)`;

const MOUNT_SELECT =
  "SELECT id, mount_id, label, state, manifest_epoch FROM mounts WHERE machine_pk = ? AND state != 'removed' ORDER BY mount_id";

function mountViews(db: Db, machinePk: number, now: number): MachineView['mounts'] {
  const mounts = db.prepare(MOUNT_SELECT).all(machinePk) as MountRow[];
  return mounts.map((mount) => ({ ...mount, coverage: computeCoverage(db, mount.id, now) }));
}

function machineView(
  db: Db,
  machine: MachineRow,
  openIssues: number,
  lastJobAt: number | null,
  now: number,
): MachineView {
  return {
    ...machine,
    mounts: mountViews(db, machine.id, now),
    open_issues: openIssues,
    last_job_at: lastJobAt,
  };
}

/** 每台机器 open 异常数（经 mounts 关联），避免列表 N+1。 */
function openIssueCounts(db: Db): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT m.machine_pk AS machine_pk, COUNT(*) AS open
       FROM issues i
       JOIN mounts m ON m.id = i.mount_pk
       WHERE i.status = 'open'
       GROUP BY m.machine_pk`,
    )
    .all() as Array<{ machine_pk: number; open: number }>;
  return new Map(rows.map((row) => [row.machine_pk, row.open]));
}

/** 每台机器最近一次任务结束时间；无 finished 任务为 null。 */
function lastJobTimes(db: Db): Map<number, number | null> {
  const rows = db
    .prepare(
      `SELECT m.machine_pk AS machine_pk, MAX(j.finished_at) AS last_job_at
       FROM scan_jobs j
       JOIN mounts m ON m.id = j.mount_pk
       GROUP BY m.machine_pk`,
    )
    .all() as Array<{ machine_pk: number; last_job_at: number | null }>;
  return new Map(rows.map((row) => [row.machine_pk, row.last_job_at]));
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/overview', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;
    const now = Date.now();
    const threshold = now - RECHECK_DAYS * 24 * 60 * 60 * 1000;
    const staleThreshold = now - STALE_MS;

    const machines = db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END),0) AS online FROM machines",
      )
      .get() as { total: number; online: number };
    // 巡检新鲜度：total 口径与旧字段一致（排除 removed）；never_scanned 无 completed 任务；
    // stale_24h 仅统计「最近一次 completed 任务 finished_at」早于 24h 的挂载点。
    const mounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN COALESCE(c.completed_count, 0) = 0 THEN 1 ELSE 0 END), 0) AS never_scanned,
                COALESCE(SUM(CASE WHEN COALESCE(c.completed_count, 0) > 0 AND c.last_completed_at IS NOT NULL AND c.last_completed_at < ? THEN 1 ELSE 0 END), 0) AS stale_24h
         FROM mounts m
         LEFT JOIN (
           SELECT mount_pk, COUNT(*) AS completed_count, MAX(finished_at) AS last_completed_at
           FROM scan_jobs WHERE status = 'completed' GROUP BY mount_pk
         ) c ON c.mount_pk = m.id
         WHERE m.state != 'removed'`,
      )
      .get(staleThreshold) as { total: number; never_scanned: number; stale_24h: number };
    const lastScan = db.prepare('SELECT MAX(finished_at) AS at FROM scan_jobs').get() as {
      at: number | null;
    };
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
      .all() as JobViewRow[];

    // 需关注挂载点：按最近一次 completed 任务时间升序，从未巡检的排最前；最多 10 条。
    // 先一次查询取出排序键与最近任务状态，再只对前 10 条计算覆盖率（避免 N+1 反模式）。
    const attentionRows = db
      .prepare(
        `SELECT m.id AS mount_pk, m.mount_id AS mount_id, mc.machine_id AS machine_id, m.state AS state,
                (SELECT MAX(j.finished_at) FROM scan_jobs j WHERE j.mount_pk = m.id AND j.status = 'completed') AS last_completed_at,
                (SELECT j.status FROM scan_jobs j WHERE j.mount_pk = m.id ORDER BY j.id DESC LIMIT 1) AS last_job_status
         FROM mounts m
         JOIN machines mc ON mc.id = m.machine_pk
         WHERE m.state != 'removed'
         ORDER BY (last_completed_at IS NULL) DESC, last_completed_at ASC, m.id ASC
         LIMIT 10`,
      )
      .all() as AttentionRow[];
    const attentionMounts = attentionRows.map((row) => ({
      mount_pk: row.mount_pk,
      mount_id: row.mount_id,
      machine_id: row.machine_id,
      state: row.state,
      coverage_ratio: computeCoverage(db, row.mount_pk, now).ratio,
      last_job_at: row.last_completed_at,
      last_job_status: row.last_job_status,
    }));

    return {
      machines,
      mounts,
      last_scan_at: lastScan.at,
      attention_mounts: attentionMounts,
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
    const now = Date.now();
    const machines = db.prepare(`${MACHINE_SELECT} ORDER BY m.machine_id`).all() as MachineRow[];
    const issueCounts = openIssueCounts(db);
    const jobTimes = lastJobTimes(db);

    return machines.map((machine) =>
      machineView(
        db,
        machine,
        issueCounts.get(machine.id) ?? 0,
        jobTimes.get(machine.id) ?? null,
        now,
      ),
    );
  });

  app.get('/api/v1/machines/:id', async (request) => {
    requireSession(ctx.db, request);
    const db = ctx.db;
    const machinePk = IdParam.parse((request.params as { id: string }).id);
    const machine = db.prepare(`${MACHINE_SELECT} WHERE m.id = ?`).get(machinePk) as
      | MachineRow
      | undefined;
    if (!machine) throw new HttpError(404, 'machine not found');

    const issueCount = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM issues i
         JOIN mounts m ON m.id = i.mount_pk
         WHERE i.status = 'open' AND m.machine_pk = ?`,
      )
      .get(machinePk) as { n: number };
    const lastJob = db
      .prepare(
        `SELECT MAX(j.finished_at) AS at
         FROM scan_jobs j
         JOIN mounts m ON m.id = j.mount_pk
         WHERE m.machine_pk = ?`,
      )
      .get(machinePk) as { at: number | null };

    return machineView(db, machine, issueCount.n, lastJob.at, Date.now());
  });

  app.delete('/api/v1/machines/:id', async (request) => {
    requireSession(ctx.db, request);
    const machinePk = IdParam.parse((request.params as { id: string }).id);
    const result = deleteMachine(
      ctx.db,
      machinePk,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
    if (!result) throw new HttpError(404, 'machine not found');
    return { ok: true, ...result };
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
    const query = request.query as {
      limit?: string;
      status?: string;
      mount_id?: string;
      machine_id?: string;
    };
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
    if (query.machine_id) {
      conditions.push('mc.machine_id = ?');
      params.push(query.machine_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const rows = ctx.db
      .prepare(
        `SELECT j.id, j.mount_pk, j.mode, j.status, j.attempt, j.created_at, j.started_at, j.finished_at, j.stats_json, m.mount_id, mc.machine_id
         FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk JOIN machines mc ON mc.id = m.machine_pk
         ${where} ORDER BY j.id DESC LIMIT ?`,
      )
      .all(...params) as JobViewRow[];

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
      .get(jobId) as JobViewRow | undefined;
    if (!row) throw new HttpError(404, 'job not found');
    return jobView(row);
  });
}
