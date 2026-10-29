import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { bumpManifestEpoch } from './epoch.js';
import { openIssue } from './issues.js';

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const RECHECK_DAYS = 90;
export const MISSING_RATIO_LIMIT = 0.05;
export const MISSING_RATIO_MIN_TOTAL = 100;
export const MISSING_ABS_LIMIT = 1000;

export type ScanMode = 'baseline' | 'incremental' | 'full';
export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';
export type GuardStatus = 'ok' | 'unavailable' | 'suspect';

export interface MountRow {
  id: number;
  machine_pk: number;
  mount_id: string;
  label: string | null;
  physical_path: string;
  sentinel: string | null;
  fs_kind: string;
  case_sensitive: string;
  unicode: string;
  include_json: string;
  exclude_json: string;
  rules_hash: string;
  limits_json: string;
  schedule_json: string;
  repair_allowed: number;
  state: string;
  manifest_epoch: number;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  mount_pk: number;
  mode: ScanMode;
  status: JobStatus;
  rules_hash: string;
  lease_until: number | null;
  attempt: number;
  cancel_requested: number;
  started_at: number | null;
  finished_at: number | null;
  stats_json: string | null;
  created_at: number;
}

export interface Coverage {
  total: number;
  hashed: number;
  ratio: number;
}

export function getMount(db: Db, mountPk: number): MountRow | undefined {
  return db.prepare('SELECT * FROM mounts WHERE id = ?').get(mountPk) as MountRow | undefined;
}

export function getJob(db: Db, jobId: number): JobRow | undefined {
  return db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
}

export function requireJobForAgent(
  db: Db,
  agent: { machine_pk: number },
  jobId: number,
): { job: JobRow; mount: MountRow } {
  const job = getJob(db, jobId);
  if (!job) throw new HttpError(404, 'job not found');
  const mount = getMount(db, job.mount_pk);
  if (!mount || mount.machine_pk !== agent.machine_pk) {
    throw new HttpError(404, 'job not found');
  }
  return { job, mount };
}

export function createScanJob(
  db: Db,
  mountPk: number,
  mode: ScanMode,
  actor: string,
  now: number = Date.now(),
): { jobId: number } {
  const mount = getMount(db, mountPk);
  if (!mount) throw new HttpError(404, 'mount not found');
  if (mount.state === 'removed') throw new HttpError(409, 'mount removed');

  try {
    const info = db
      .prepare(
        'INSERT INTO scan_jobs (mount_pk, mode, status, rules_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(mountPk, mode, 'pending', mount.rules_hash, now);
    const jobId = Number(info.lastInsertRowid);
    audit(db, actor, 'job.create', `mount:${mount.mount_id}`, { job_id: jobId, mode }, now);
    return { jobId };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') {
      throw new HttpError(409, 'job already active', `mount ${mount.mount_id} already has a job`);
    }
    throw error;
  }
}

/** 惰性清理过期租约：重试次数用尽则失败，否则回到 pending。 */
export function expireLeases(db: Db, now: number = Date.now()): void {
  const expired = db
    .prepare("SELECT id, attempt FROM scan_jobs WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?")
    .all(now) as Array<{ id: number; attempt: number }>;

  for (const job of expired) {
    const nextAttempt = job.attempt + 1;
    if (nextAttempt >= MAX_ATTEMPTS) {
      db.prepare("UPDATE scan_jobs SET status = 'failed', attempt = ?, finished_at = ?, lease_until = NULL WHERE id = ?").run(
        nextAttempt,
        now,
        job.id,
      );
      audit(db, 'system', 'job.expire', `job:${job.id}`, { attempt: nextAttempt, failed: true }, now);
    } else {
      db.prepare("UPDATE scan_jobs SET status = 'pending', attempt = ?, lease_until = NULL WHERE id = ?").run(
        nextAttempt,
        job.id,
      );
      audit(db, 'system', 'job.expire', `job:${job.id}`, { attempt: nextAttempt, failed: false }, now);
    }
  }
}

/** 给某个 agent 派一个任务：优先续租它正在跑的任务，否则取一个 pending。 */
export function dispatchJobForAgent(
  db: Db,
  agent: { id: number; machine_pk: number },
  now: number = Date.now(),
): JobRow | null {
  expireLeases(db, now);

  const running = db
    .prepare(
      "SELECT j.* FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk WHERE m.machine_pk = ? AND j.status = 'running' ORDER BY j.id LIMIT 1",
    )
    .get(agent.machine_pk) as JobRow | undefined;
  if (running) {
    db.prepare('UPDATE scan_jobs SET lease_until = ? WHERE id = ?').run(now + LEASE_MS, running.id);
    return { ...running, lease_until: now + LEASE_MS };
  }

  const pending = db
    .prepare(
      "SELECT j.* FROM scan_jobs j JOIN mounts m ON m.id = j.mount_pk WHERE m.machine_pk = ? AND j.status = 'pending' ORDER BY j.created_at, j.id LIMIT 1",
    )
    .get(agent.machine_pk) as JobRow | undefined;
  if (!pending) return null;

  const startedAt = pending.started_at ?? now;
  db.prepare(
    "UPDATE scan_jobs SET status = 'running', lease_until = ?, started_at = ?, attempt = attempt WHERE id = ?",
  ).run(now + LEASE_MS, startedAt, pending.id);
  audit(db, `agent:${agent.id}`, 'job.dispatch', `job:${pending.id}`, { mount_pk: pending.mount_pk }, now);

  return { ...pending, status: 'running', lease_until: now + LEASE_MS, started_at: startedAt };
}

export function computeCoverage(db: Db, mountPk: number, now: number = Date.now()): Coverage {
  const threshold = now - RECHECK_DAYS * 24 * 60 * 60 * 1000;
  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM paths WHERE mount_pk = ? AND state = 'active'")
    .get(mountPk) as { n: number };
  const hashedRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM paths WHERE mount_pk = ? AND state = 'active' AND last_hashed_at IS NOT NULL AND last_hashed_at >= ?",
    )
    .get(mountPk, threshold) as { n: number };
  const total = totalRow.n;
  const hashed = hashedRow.n;
  return { total, hashed, ratio: total === 0 ? 1 : hashed / total };
}

export interface FinishInput {
  status: 'completed' | 'failed' | 'canceled';
  stats?: Record<string, unknown>;
  guard?: { status: GuardStatus; reason?: string };
}

export interface FinishResult {
  ok: true;
  job_status: FinishInput['status'];
  coverage: Coverage;
}

/** 完成/失败任务；completed 时做 missing 判定与熔断。 */
export function finishJob(
  db: Db,
  agent: { id: number; machine_pk: number },
  jobId: number,
  input: FinishInput,
  now: number = Date.now(),
): FinishResult {
  const { job, mount } = requireJobForAgent(db, agent, jobId);
  if (job.status !== 'running') {
    throw new HttpError(409, 'job not running', `status=${job.status}`);
  }

  const run = db.transaction((): FinishResult => {
    db.prepare(
      'UPDATE scan_jobs SET status = ?, finished_at = ?, stats_json = ?, lease_until = NULL WHERE id = ?',
    ).run(input.status, now, input.stats ? JSON.stringify(input.stats) : null, job.id);

    if (input.status === 'completed') {
      const guard = input.guard ?? { status: 'ok' as GuardStatus };
      if (guard.status !== 'ok') {
        db.prepare('UPDATE mounts SET state = ?, updated_at = ? WHERE id = ?').run(
          guard.status,
          now,
          mount.id,
        );
        audit(
          db,
          `agent:${agent.id}`,
          'mount.guard',
          `mount:${mount.mount_id}`,
          { status: guard.status, reason: guard.reason, job_id: job.id },
          now,
        );
      } else {
        const flagged = detectMissing(db, mount, job, now);
        db.prepare('UPDATE mounts SET state = ?, updated_at = ? WHERE id = ?').run(
          flagged ? 'suspect' : 'active',
          now,
          mount.id,
        );
        if (flagged) {
          audit(
            db,
            `agent:${agent.id}`,
            'mount.suspect',
            `mount:${mount.mount_id}`,
            { job_id: job.id },
            now,
          );
        }
      }
    }

    const coverage = computeCoverage(db, mount.id, now);
    audit(db, `agent:${agent.id}`, 'job.finish', `job:${job.id}`, { status: input.status }, now);
    return { ok: true, job_status: input.status, coverage };
  });

  return run();
}

/** 标记本任务未见到的路径为 missing；消失比例过高时只标 suspect，不逐文件报异常。 */
function detectMissing(db: Db, mount: MountRow, job: JobRow, now: number): boolean {
  // 规则在任务期间变化：本轮无法判断 missing，跳过。
  if (job.rules_hash !== mount.rules_hash) return false;

  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM paths WHERE mount_pk = ? AND state = 'active'")
    .get(mount.id) as { n: number };
  const total = totalRow.n;
  if (total === 0) return false;

  const unseen = db
    .prepare(
      "SELECT id, last_seen_at, last_seen_job_pk FROM paths WHERE mount_pk = ? AND state = 'active' AND (last_seen_job_pk IS NULL OR last_seen_job_pk <> ?)",
    )
    .all(mount.id, job.id) as Array<{
    id: number;
    last_seen_at: number | null;
    last_seen_job_pk: number | null;
  }>;

  if (unseen.length === 0) return false;
  // 小 mount（文件数不足 100）不按比例熔断，避免「2 个文件丢 1 个」被当成掉盘。
  const ratioTripped = total >= MISSING_RATIO_MIN_TOTAL && unseen.length / total > MISSING_RATIO_LIMIT;
  if (ratioTripped || unseen.length > MISSING_ABS_LIMIT) {
    return true;
  }

  const epoch = bumpManifestEpoch(db, mount.id, now);
  for (const path of unseen) {
    db.prepare("UPDATE paths SET state = 'missing', change_epoch = ?, updated_at = ? WHERE id = ?").run(
      epoch,
      now,
      path.id,
    );
    openIssue(
      db,
      path.id,
      mount.id,
      'missing',
      'medium',
      {
        job_id: job.id,
        last_seen_at: path.last_seen_at,
        last_seen_job_pk: path.last_seen_job_pk,
      },
      now,
    );
  }
  return false;
}
