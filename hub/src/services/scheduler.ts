import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { createScanJob, expireLeases, type MountRow } from './jobs.js';

export const DEFAULT_INTERVAL_MINUTES = 1440;
export const OFFLINE_AFTER_MS = 90_000;

export interface ScheduleConfig {
  window: string;
  budgetMinutesPerDay: number;
  intervalMinutes: number;
}

export interface SchedulerTickResult {
  createdJobs: Array<{ jobId: number; mountId: number }>;
  offlinedMachines: number;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  window: '',
  budgetMinutesPerDay: 0,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
};

/** 解析 mounts.schedule_json，缺省值保守：每天一次、全天窗口、不限预算。 */
export function parseSchedule(raw: string | null | undefined): ScheduleConfig {
  if (!raw) return { ...DEFAULT_SCHEDULE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_SCHEDULE };
  }
  const record = parsed as Record<string, unknown>;
  const window = typeof record.window === 'string' ? record.window.trim() : '';
  const budgetRaw = record.budget_minutes_per_day;
  const budgetMinutesPerDay =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? Math.max(0, Math.floor(budgetRaw)) : 0;
  const intervalRaw = record.interval_minutes;
  const intervalCandidate =
    typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) ? Math.floor(intervalRaw) : 0;
  const intervalMinutes = intervalCandidate > 0 ? intervalCandidate : DEFAULT_INTERVAL_MINUTES;
  return { window, budgetMinutesPerDay, intervalMinutes };
}

interface WindowRange {
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
}

/** 解析 "HH:MM-HH:MM"；为空或格式非法时返回 null（视为全天）。 */
export function parseWindow(window: string): WindowRange | null {
  if (!window) return null;
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window);
  if (!match) return null;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return null;
  }
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return { startMinute: start, endMinute: end, crossesMidnight: end <= start };
}

/** 判断时间点是否落在窗口内（hub 本地时间，支持跨午夜）。 */
export function isWithinWindow(window: string, now: number): boolean {
  const range = parseWindow(window);
  if (!range) return true;
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  if (!range.crossesMidnight) {
    return minute >= range.startMinute && minute < range.endMinute;
  }
  return minute >= range.startMinute || minute < range.endMinute;
}

function localDayStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface DurationRow {
  started_at: number | null;
  finished_at: number | null;
  stats_json: string | null;
}

/** 统计某个 mount 今天已完成任务消耗的分钟数（优先 stats.duration_ms）。 */
export function jobMinutesToday(db: Db, mountPk: number, now: number): number {
  const rows = db
    .prepare(
      "SELECT started_at, finished_at, stats_json FROM scan_jobs WHERE mount_pk = ? AND created_at >= ? AND status IN ('completed','failed','canceled')",
    )
    .all(mountPk, localDayStart(now)) as DurationRow[];

  let totalMinutes = 0;
  for (const row of rows) {
    let minutes = 0;
    if (row.stats_json) {
      try {
        const stats = JSON.parse(row.stats_json) as { duration_ms?: unknown };
        if (typeof stats.duration_ms === 'number' && stats.duration_ms > 0) {
          minutes = stats.duration_ms / 60_000;
        }
      } catch {
        // 忽略损坏的 stats
      }
    }
    if (minutes === 0 && row.started_at !== null && row.finished_at !== null) {
      minutes = Math.max(0, (row.finished_at - row.started_at) / 60_000);
    }
    totalMinutes += minutes;
  }
  return totalMinutes;
}

export function lastJobAt(db: Db, mountPk: number): number | null {
  const row = db
    .prepare('SELECT MAX(created_at) AS at FROM scan_jobs WHERE mount_pk = ?')
    .get(mountPk) as { at: number | null };
  return row.at ?? null;
}

function hasActiveJob(db: Db, mountPk: number): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM scan_jobs WHERE mount_pk = ? AND status IN ('pending','running') LIMIT 1",
      )
      .get(mountPk) !== undefined
  );
}

/** 建过基线（至少有一条路径记录）后才允许自动调度，避免与手动 baseline 抢跑。 */
export function hasBaseline(db: Db, mountPk: number): boolean {
  return db.prepare('SELECT 1 FROM paths WHERE mount_pk = ? LIMIT 1').get(mountPk) !== undefined;
}

export interface SchedulerTickOptions {
  actor?: string;
  offlineAfterMs?: number;
}

/**
 * 一次调度 tick：回收过期租约、标记离线机器、为到期的 mount 创建自动任务。
 * 纯函数（无定时器），便于测试；由 main.ts 按配置间隔调用。
 */
export function runSchedulerTick(
  db: Db,
  now: number = Date.now(),
  options: SchedulerTickOptions = {},
): SchedulerTickResult {
  const offlineAfterMs = options.offlineAfterMs ?? OFFLINE_AFTER_MS;
  expireLeases(db, now);

  const offlinedMachines = db
    .prepare(
      "UPDATE machines SET status = 'offline' WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)",
    )
    .run(now - offlineAfterMs).changes;

  const mounts = db
    .prepare("SELECT * FROM mounts WHERE state = 'active' ORDER BY id")
    .all() as MountRow[];

  const createdJobs: Array<{ jobId: number; mountId: number }> = [];
  for (const mount of mounts) {
    const schedule = parseSchedule(mount.schedule_json);
    if (!isWithinWindow(schedule.window, now)) continue;
    if (hasActiveJob(db, mount.id)) continue;
    if (!hasBaseline(db, mount.id)) continue;

    const last = lastJobAt(db, mount.id);
    if (last !== null && now - last < schedule.intervalMinutes * 60_000) continue;

    if (
      schedule.budgetMinutesPerDay > 0 &&
      jobMinutesToday(db, mount.id, now) >= schedule.budgetMinutesPerDay
    ) {
      continue;
    }

    try {
      const { jobId } = createScanJob(db, mount.id, 'incremental', options.actor ?? 'scheduler', now);
      createdJobs.push({ jobId, mountId: mount.id });
    } catch (error) {
      // 唯一索引冲突 = 已有活跃任务，下一 tick 再试。
      if (error instanceof HttpError && error.status === 409) continue;
      throw error;
    }
  }

  if (createdJobs.length > 0) {
    audit(db, 'system', 'scheduler.tick', undefined, {
      created: createdJobs.map((job) => job.jobId),
    }, now);
  }

  return { createdJobs, offlinedMachines };
}
