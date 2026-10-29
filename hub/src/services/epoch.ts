import type { Db } from '../db/index.js';

/**
 * 路径变化时自增 mount 的清单版本，返回新 epoch。
 * 调用方需在同一个事务内把新 epoch 写入受影响路径的 change_epoch。
 */
export function bumpManifestEpoch(db: Db, mountPk: number, now: number): number {
  const row = db
    .prepare('UPDATE mounts SET manifest_epoch = manifest_epoch + 1, updated_at = ? WHERE id = ? RETURNING manifest_epoch')
    .get(now, mountPk) as { manifest_epoch: number } | undefined;
  if (!row) {
    throw new Error(`mount not found: ${mountPk}`);
  }
  return row.manifest_epoch;
}
