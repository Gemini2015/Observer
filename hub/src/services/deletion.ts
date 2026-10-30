import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { audit } from './audit.js';
import { partPath } from './repairs.js';

export interface DeleteMountResult {
  mount_id: number;
  mount_key: string;
  machine_id: string;
  deleted: {
    paths: number;
    issues: number;
    jobs: number;
    repairs: number;
    tickets: number;
  };
}

interface MountInfo {
  id: number;
  mount_id: string;
  machine_pk: number;
  machine_id: string;
}

interface DeletedCounts {
  paths: number;
  issues: number;
  jobs: number;
  repairs: number;
  tickets: number;
}

function loadMountInfo(db: Db, mountPk: number): MountInfo | undefined {
  return db
    .prepare(
      `SELECT m.id, m.mount_id, m.machine_pk, mc.machine_id
       FROM mounts m JOIN machines mc ON mc.id = m.machine_pk
       WHERE m.id = ?`,
    )
    .get(mountPk) as MountInfo | undefined;
}

function countOf(db: Db, table: string, mountPk: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE mount_pk = ?`).get(mountPk) as {
    n: number;
  };
  return row.n;
}

function removeTicketFiles(transfersDir: string, ticketIds: number[]): void {
  for (const ticketId of ticketIds) {
    fs.rmSync(partPath(transfersDir, ticketId), { force: true });
  }
}

/**
 * 删除一个挂载点及其巡检数据（硬删除，不可恢复）。
 * 显式按外键依赖顺序清理，避免 ON DELETE RESTRICT 阻塞。
 * 返回删除统计；调用方负责审计。
 */
export function deleteMount(db: Db, mountPk: number, transfersDir: string): DeleteMountResult | undefined {
  const mount = loadMountInfo(db, mountPk);
  if (!mount) return undefined;

  const pathRows = db.prepare('SELECT id FROM paths WHERE mount_pk = ?').all(mountPk) as Array<{
    id: number;
  }>;
  const pathIds = pathRows.map((row) => row.id);
  const placeholders = pathIds.length > 0 ? pathIds.map(() => '?').join(',') : 'NULL';

  const ticketRows = db
    .prepare(
      `SELECT t.id FROM transfer_tickets t
       JOIN repair_jobs r ON r.id = t.repair_pk
       WHERE r.issue_pk IN (SELECT id FROM issues WHERE mount_pk = ?)
          OR r.source_path_pk IN (${placeholders})
          OR r.target_path_pk IN (${placeholders})`,
    )
    .all(mountPk, ...pathIds, ...pathIds) as Array<{ id: number }>;
  const ticketIds = ticketRows.map((row) => row.id);

  const counts: DeletedCounts = {
    paths: countOf(db, 'paths', mountPk),
    issues: countOf(db, 'issues', mountPk),
    jobs: countOf(db, 'scan_jobs', mountPk),
    repairs: 0,
    tickets: ticketIds.length,
  };

  const tx = db.transaction(() => {
    const repairInfo = db
      .prepare(
        `DELETE FROM repair_jobs
         WHERE issue_pk IN (SELECT id FROM issues WHERE mount_pk = ?)
            OR source_path_pk IN (${placeholders})
            OR target_path_pk IN (${placeholders})`,
      )
      .run(mountPk, ...pathIds, ...pathIds);
    counts.repairs = repairInfo.changes;

    db.prepare('DELETE FROM issues WHERE mount_pk = ?').run(mountPk);
    db.prepare('DELETE FROM scan_jobs WHERE mount_pk = ?').run(mountPk);
    db.prepare('DELETE FROM paths WHERE mount_pk = ?').run(mountPk);
    db.prepare('DELETE FROM mounts WHERE id = ?').run(mountPk);
  });
  tx();
  removeTicketFiles(transfersDir, ticketIds);

  const result: DeleteMountResult = {
    mount_id: mount.id,
    mount_key: mount.mount_id,
    machine_id: mount.machine_id,
    deleted: counts,
  };
  audit(
    db,
    'user',
    'mount.delete',
    `mount:${mount.mount_id}`,
    { machine_id: mount.machine_id, deleted: counts },
    Date.now(),
  );
  return result;
}

export interface DeleteMachineResult {
  machine_id: string;
  mounts: DeleteMountResult[];
  deleted: { agents: number };
}

/** 删除一台机器及其全部挂载点/agent（硬删除，不可恢复）。 */
export function deleteMachine(
  db: Db,
  machinePk: number,
  transfersDir: string,
): DeleteMachineResult | undefined {
  const machine = db
    .prepare('SELECT id, machine_id FROM machines WHERE id = ?')
    .get(machinePk) as { id: number; machine_id: string } | undefined;
  if (!machine) return undefined;

  const mountRows = db.prepare('SELECT id FROM mounts WHERE machine_pk = ?').all(machinePk) as Array<{
    id: number;
  }>;

  const tx = db.transaction(() => {
    const mounts: DeleteMountResult[] = [];
    for (const row of mountRows) {
      const result = deleteMount(db, row.id, transfersDir);
      if (result) mounts.push(result);
    }
    const agents = db.prepare('DELETE FROM agents WHERE machine_pk = ?').run(machinePk);
    db.prepare('DELETE FROM machines WHERE id = ?').run(machinePk);
    return { mounts, agents: agents.changes };
  });
  const result = tx();

  audit(
    db,
    'user',
    'machine.delete',
    `machine:${machine.machine_id}`,
    {
      mounts: result.mounts.map((item) => item.mount_key),
      agents: result.agents,
    },
    Date.now(),
  );
  return { machine_id: machine.machine_id, mounts: result.mounts, deleted: { agents: result.agents } };
}
