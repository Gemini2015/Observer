import type { Db } from '../db/index.js';
import { audit } from './audit.js';
import type { AgentRow, MountEnrollInput } from './registry.js';

export interface MountSyncResult {
  mounts: Array<{ id: number; mount_id: string; manifest_epoch: number; state: string }>;
  added: string[];
  updated: string[];
  removed: string[];
}

interface ExistingMount {
  id: number;
  mount_id: string;
  rules_hash: string;
  state: string;
}

/**
 * 用 agent 当前配置同步其挂载点：
 * - 新增 mount → 插入；已有 mount → 更新配置并恢复 active；
 * - 配置中已删除的 mount → 软删除（state=removed，保留历史数据），并取消其未完成任务；
 * - 规则（rules_hash）变化时自增 manifest_epoch，让 agent 重新拉取清单。
 */
export function syncAgentMounts(
  db: Db,
  agent: Pick<AgentRow, 'id' | 'machine_pk'>,
  mounts: MountEnrollInput[],
  now: number = Date.now(),
): MountSyncResult {
  const result: MountSyncResult = { mounts: [], added: [], updated: [], removed: [] };

  const run = db.transaction((): void => {
    const existing = db
      .prepare('SELECT id, mount_id, rules_hash, state FROM mounts WHERE machine_pk = ?')
      .all(agent.machine_pk) as ExistingMount[];
    const byMountId = new Map(existing.map((row) => [row.mount_id, row]));

    const insert = db.prepare(
      'INSERT INTO mounts (machine_pk, mount_id, label, physical_path, sentinel, fs_kind, case_sensitive, unicode, include_json, exclude_json, rules_hash, limits_json, schedule_json, repair_allowed, state, manifest_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const update = db.prepare(
      `UPDATE mounts SET label = ?, physical_path = ?, sentinel = ?, fs_kind = ?, case_sensitive = ?,
              unicode = ?, include_json = ?, exclude_json = ?, rules_hash = ?, limits_json = ?,
              schedule_json = ?, repair_allowed = ?, state = 'active',
              manifest_epoch = manifest_epoch + ?, updated_at = ?
       WHERE id = ?`,
    );

    const configuredMountIds = new Set<string>();

    for (const mount of mounts) {
      configuredMountIds.add(mount.mount_id);
      const current = byMountId.get(mount.mount_id);
      if (!current) {
        const info = insert.run(
          agent.machine_pk,
          mount.mount_id,
          mount.label ?? null,
          mount.physical_path,
          mount.sentinel ?? null,
          mount.fs_kind,
          mount.case_sensitive,
          mount.unicode,
          JSON.stringify(mount.include),
          JSON.stringify(mount.exclude),
          mount.rules_hash,
          JSON.stringify(mount.limits),
          JSON.stringify(mount.schedule),
          mount.repair_allowed ? 1 : 0,
          'active',
          0,
          now,
          now,
        );
        result.added.push(mount.mount_id);
        byMountId.set(mount.mount_id, {
          id: Number(info.lastInsertRowid),
          mount_id: mount.mount_id,
          rules_hash: mount.rules_hash,
          state: 'active',
        });
        continue;
      }

      const rulesChanged = current.rules_hash !== mount.rules_hash;
      update.run(
        mount.label ?? null,
        mount.physical_path,
        mount.sentinel ?? null,
        mount.fs_kind,
        mount.case_sensitive,
        mount.unicode,
        JSON.stringify(mount.include),
        JSON.stringify(mount.exclude),
        mount.rules_hash,
        JSON.stringify(mount.limits),
        JSON.stringify(mount.schedule),
        mount.repair_allowed ? 1 : 0,
        rulesChanged ? 1 : 0,
        now,
        current.id,
      );
      if (current.state === 'removed') {
        result.added.push(mount.mount_id); // 重新启用
      } else {
        result.updated.push(mount.mount_id);
      }
    }

    for (const current of existing) {
      if (configuredMountIds.has(current.mount_id) || current.state === 'removed') continue;
      db.prepare("UPDATE mounts SET state = 'removed', updated_at = ? WHERE id = ?").run(now, current.id);
      db.prepare(
        "UPDATE scan_jobs SET status = 'canceled', finished_at = ?, lease_until = NULL WHERE mount_pk = ? AND status IN ('pending','running')",
      ).run(now, current.id);
      result.removed.push(current.mount_id);
    }

    result.mounts = db
      .prepare(
        "SELECT id, mount_id, manifest_epoch, state FROM mounts WHERE machine_pk = ? AND state != 'removed' ORDER BY mount_id",
      )
      .all(agent.machine_pk) as Array<{
      id: number;
      mount_id: string;
      manifest_epoch: number;
      state: string;
    }>;
  });
  run();

  audit(db, `agent:${agent.id}`, 'mount.sync', `machine:${agent.machine_pk}`, {
    added: result.added,
    updated: result.updated,
    removed: result.removed,
  }, now);

  return result;
}
