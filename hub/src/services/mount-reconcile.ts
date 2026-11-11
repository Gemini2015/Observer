import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { bumpManifestEpoch } from './epoch.js';
import { getMount, parseStatsJson } from './jobs.js';

/** 最近一轮 completed 任务的摘要（GET /api/v1/mounts/:id/unseen）。 */
export interface MountUnseenJobView {
  id: number;
  mode: string;
  finished_at: number | null;
  seen: number;
  rules_hash: string;
}

export interface MountUnseenItem {
  id: number;
  path_key: string;
  size: number;
  last_seen_at: number | null;
  last_seen_job_pk: number | null;
}

export interface MountUnseenResult {
  mount_id: string;
  state: string;
  job: MountUnseenJobView | null;
  rules_changed: boolean;
  total_active: number;
  unseen_count: number;
  items: MountUnseenItem[];
  limit: number;
  offset: number;
  truncated: boolean;
}

export interface MountUnseenQuery {
  limit?: number;
  offset?: number;
}

export interface RebaselineOptions {
  now?: number;
  actor?: string;
}

export interface MountRebaselineResult {
  ok: true;
  mount_id: string;
  updated: number;
  state: 'active';
  manifest_epoch: number;
  job_id: number;
}

interface CompletedJobRow {
  id: number;
  mode: string;
  finished_at: number | null;
  rules_hash: string;
  stats_json: string | null;
}

const DEFAULT_UNSEEN_LIMIT = 200;

/** 该 mount 最近一条 completed 任务；没有则返回 undefined。 */
function latestCompletedJob(db: Db, mountPk: number): CompletedJobRow | undefined {
  return db
    .prepare(
      `SELECT id, mode, finished_at, rules_hash, stats_json
         FROM scan_jobs
        WHERE mount_pk = ? AND status = 'completed'
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(mountPk) as CompletedJobRow | undefined;
}

/** 从 stats_json 读 seen（缺失/非法按 0）。 */
function scanSeen(job: CompletedJobRow): number {
  const seen = parseStatsJson(job.stats_json)?.seen;
  return typeof seen === 'number' && Number.isFinite(seen) ? seen : 0;
}

/**
 * 最近一轮 completed 任务没看到的 active 路径数。
 * missing 判定熔断时这些路径保持 active，只把 mount 标为 suspect，靠这个计数暴露给用户。
 */
function countUnseen(db: Db, mountPk: number, jobId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM paths
        WHERE mount_pk = ? AND state = 'active'
          AND (last_seen_job_pk IS NULL OR last_seen_job_pk <> ?)`,
    )
    .get(mountPk, jobId) as { n: number };
  return row.n;
}

/**
 * 查询 mount 的「疑似掉盘」路径：最近一轮 completed 任务未出现、但仍处于 active 的路径。
 * 只做只读查询，按 path_key 不区分大小写排序分页。
 */
export function listMountUnseen(
  db: Db,
  mountPk: number,
  query: MountUnseenQuery = {},
): MountUnseenResult {
  const mount = getMount(db, mountPk);
  if (!mount) throw new HttpError(404, 'mount not found');

  const limit = query.limit ?? DEFAULT_UNSEEN_LIMIT;
  const offset = query.offset ?? 0;
  const totalActiveRow = db
    .prepare("SELECT COUNT(*) AS n FROM paths WHERE mount_pk = ? AND state = 'active'")
    .get(mountPk) as { n: number };

  const job = latestCompletedJob(db, mountPk);
  if (!job) {
    return {
      mount_id: mount.mount_id,
      state: mount.state,
      job: null,
      rules_changed: false,
      total_active: totalActiveRow.n,
      unseen_count: 0,
      items: [],
      limit,
      offset,
      truncated: false,
    };
  }

  const unseenCount = countUnseen(db, mountPk, job.id);
  const items = db
    .prepare(
      `SELECT id, path_key, size, last_seen_at, last_seen_job_pk
         FROM paths
        WHERE mount_pk = ? AND state = 'active'
          AND (last_seen_job_pk IS NULL OR last_seen_job_pk <> ?)
        ORDER BY path_key COLLATE NOCASE ASC, id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(mountPk, job.id, limit, offset) as MountUnseenItem[];

  return {
    mount_id: mount.mount_id,
    state: mount.state,
    job: {
      id: job.id,
      mode: job.mode,
      finished_at: job.finished_at,
      seen: scanSeen(job),
      rules_hash: job.rules_hash,
    },
    rules_changed: job.rules_hash !== mount.rules_hash,
    total_active: totalActiveRow.n,
    unseen_count: unseenCount,
    items,
    limit,
    offset,
    truncated: offset + items.length < unseenCount,
  };
}

/**
 * 人工「确认已删除/重建基线」：把最近一轮未出现的 active 路径置 out_of_scope。
 * 同一事务内 bump manifest_epoch 并把 mount 置回 active，从而解开 suspect 自锁。
 * 校验全部在事务前完成，失败抛 HttpError（409），detail 为英文短句。
 */
export function rebaselineMount(
  db: Db,
  mountPk: number,
  expectedJobId?: number,
  options: RebaselineOptions = {},
): MountRebaselineResult {
  const now = options.now ?? Date.now();
  const actor = options.actor ?? 'user';

  const mount = getMount(db, mountPk);
  if (!mount) throw new HttpError(404, 'mount not found');
  if (mount.state === 'removed') throw new HttpError(409, 'mount removed');

  const activeJobRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM scan_jobs WHERE mount_pk = ? AND status IN ('pending','running')",
    )
    .get(mountPk) as { n: number };
  if (activeJobRow.n > 0) throw new HttpError(409, 'scan in progress');

  const job = latestCompletedJob(db, mountPk);
  if (!job) throw new HttpError(409, 'no completed scan');
  if (expectedJobId !== undefined && expectedJobId !== job.id) {
    throw new HttpError(409, 'scan result changed');
  }
  if (job.rules_hash !== mount.rules_hash) throw new HttpError(409, 'scan rules changed');

  const unseenCount = countUnseen(db, mountPk, job.id);
  // 守卫失败/空目录时最近一轮可能一个文件都没看到：此时不能把整盘路径当「已删除」。
  if (scanSeen(job) === 0 && unseenCount > 0) {
    throw new HttpError(409, 'latest scan saw no files');
  }
  if (unseenCount === 0) throw new HttpError(409, 'no unseen files');

  const run = db.transaction((): MountRebaselineResult => {
    const epoch = bumpManifestEpoch(db, mountPk, now);
    const updated = db
      .prepare(
        `UPDATE paths
            SET state = 'out_of_scope', change_epoch = ?, updated_at = ?
          WHERE mount_pk = ? AND state = 'active'
            AND (last_seen_job_pk IS NULL OR last_seen_job_pk <> ?)`,
      )
      .run(epoch, now, mountPk, job.id).changes;

    db.prepare("UPDATE mounts SET state = 'active', updated_at = ? WHERE id = ?").run(now, mountPk);
    audit(
      db,
      actor,
      'mount.rebaseline',
      `mount:${mount.mount_id}`,
      { job_id: job.id, unseen: updated, target: 'out_of_scope', manifest_epoch: epoch },
      now,
    );

    return {
      ok: true,
      mount_id: mount.mount_id,
      updated,
      state: 'active',
      manifest_epoch: epoch,
      job_id: job.id,
    };
  });

  return run();
}
