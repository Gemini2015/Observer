import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { createScanJob } from './jobs.js';

export type BulkScanMode = 'incremental' | 'full';

export interface BulkScanInput {
  mode: BulkScanMode;
  machine_pk?: number;
  mount_pk?: number;
}

export interface BulkScanResult {
  mode: BulkScanMode;
  total_mounts: number;
  created: Array<{ job_id: number; mount_pk: number; mount_id: string; machine_id: string }>;
  skipped: Array<{ mount_pk: number; mount_id: string; machine_id: string; reason: string }>;
}

interface MountTarget {
  id: number;
  mount_id: string;
  machine_id: string;
}

function requireMachine(db: Db, machinePk: number): void {
  const machine = db.prepare('SELECT id FROM machines WHERE id = ?').get(machinePk);
  if (!machine) throw new HttpError(404, 'machine not found');
}

function requireMount(db: Db, mountPk: number): MountTarget {
  const mount = db
    .prepare(
      `SELECT m.id, m.mount_id, mc.machine_id
       FROM mounts m JOIN machines mc ON mc.id = m.machine_pk
       WHERE m.id = ? AND m.state != 'removed'`,
    )
    .get(mountPk) as MountTarget | undefined;
  if (!mount) throw new HttpError(404, 'mount not found');
  return mount;
}

/**
 * 按全局 / 单机器 / 单挂载点创建扫描任务。
 * 增量与全量都支持；已有 pending/running 任务的 mount 跳过而不是整体失败。
 */
export function createBulkScanJobs(
  db: Db,
  input: BulkScanInput,
  actor = 'user',
  now: number = Date.now(),
): BulkScanResult {
  if (input.machine_pk !== undefined) {
    requireMachine(db, input.machine_pk);
  }
  if (input.mount_pk !== undefined) {
    const mount = requireMount(db, input.mount_pk);
    if (input.machine_pk !== undefined) {
      const machine = db
        .prepare('SELECT id FROM machines WHERE id = ?')
        .get(input.machine_pk) as { id: number } | undefined;
      const mountMachine = db
        .prepare('SELECT machine_pk FROM mounts WHERE id = ?')
        .get(input.mount_pk) as { machine_pk: number } | undefined;
      if (!machine || !mountMachine || mountMachine.machine_pk !== input.machine_pk) {
        throw new HttpError(422, 'mount does not belong to machine', mount.mount_id);
      }
    }
  }

  const conditions: string[] = ["m.state != 'removed'"];
  const params: unknown[] = [];
  if (input.machine_pk !== undefined) {
    conditions.push('m.machine_pk = ?');
    params.push(input.machine_pk);
  }
  if (input.mount_pk !== undefined) {
    conditions.push('m.id = ?');
    params.push(input.mount_pk);
  }

  const mounts = db
    .prepare(
      `SELECT m.id, m.mount_id, mc.machine_id
       FROM mounts m
       JOIN machines mc ON mc.id = m.machine_pk
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.id`,
    )
    .all(...params) as MountTarget[];

  const result: BulkScanResult = {
    mode: input.mode,
    total_mounts: mounts.length,
    created: [],
    skipped: [],
  };

  const run = db.transaction((): BulkScanResult => {
    for (const mount of mounts) {
      try {
        const { jobId } = createScanJob(db, mount.id, input.mode, actor, now);
        result.created.push({
          job_id: jobId,
          mount_pk: mount.id,
          mount_id: mount.mount_id,
          machine_id: mount.machine_id,
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          result.skipped.push({
            mount_pk: mount.id,
            mount_id: mount.mount_id,
            machine_id: mount.machine_id,
            reason: 'already active',
          });
          continue;
        }
        throw error;
      }
    }

    audit(db, actor, 'scan.bulk', undefined, {
      mode: input.mode,
      machine_pk: input.machine_pk ?? null,
      mount_pk: input.mount_pk ?? null,
      created: result.created.length,
      skipped: result.skipped.length,
    }, now);
    return result;
  });

  return run();
}
