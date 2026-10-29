import { afterEach, describe, expect, it } from 'vitest';
import {
  isWithinWindow,
  jobMinutesToday,
  parseSchedule,
  runSchedulerTick,
} from '../src/services/scheduler.js';
import { createTestContext, enrollAndGetAgent, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

function localTime(hour: number, minute = 0): number {
  return new Date(2026, 0, 15, hour, minute, 0, 0).getTime();
}

interface JobLite {
  id: number;
  status: string;
  mode: string;
  attempt: number;
}

function jobs(context: TestContext): JobLite[] {
  return context.db
    .prepare('SELECT id, status, mode, attempt FROM scan_jobs ORDER BY id')
    .all() as JobLite[];
}

async function setup(schedule: Record<string, unknown>, options: { seedBaseline?: boolean } = {}) {
  const context = await createTestContext();
  ctx = context;
  const agent = await enrollAndGetAgent(context);
  context.db
    .prepare('UPDATE mounts SET schedule_json = ? WHERE id = ?')
    .run(JSON.stringify(schedule), agent.mountId);
  if (options.seedBaseline !== false) {
    seedPath(context, agent.mountId);
  }
  return { context, agent };
}

/** 插入一条路径记录，表示该 mount 已经建过基线。 */
function seedPath(context: TestContext, mountId: number): void {
  const now = Date.now();
  context.db
    .prepare(
      "INSERT INTO paths (mount_pk, path_key, path_display, size, mtime_ns, content_hash, last_seen_at, last_hashed_at, last_hash_kind, state, change_epoch, updated_at) VALUES (?, 'seed.txt', ?, 3, '1', 'seedhash', ?, ?, 'hash', 'active', 0, ?)",
    )
    .run(mountId, Buffer.from('seed.txt'), now, now, now);
}

describe('schedule parsing', () => {
  it('applies defaults for missing or invalid schedules', () => {
    expect(parseSchedule(null)).toEqual({
      window: '',
      budgetMinutesPerDay: 0,
      intervalMinutes: 1440,
    });
    expect(parseSchedule('not-json')).toMatchObject({ intervalMinutes: 1440 });
    expect(parseSchedule(JSON.stringify({ window: '01:00-06:00' }))).toEqual({
      window: '01:00-06:00',
      budgetMinutesPerDay: 0,
      intervalMinutes: 1440,
    });
  });

  it('parses window including midnight crossing', () => {
    expect(isWithinWindow('01:00-06:00', localTime(3))).toBe(true);
    expect(isWithinWindow('01:00-06:00', localTime(12))).toBe(false);
    expect(isWithinWindow('23:00-06:00', localTime(23, 30))).toBe(true);
    expect(isWithinWindow('23:00-06:00', localTime(5))).toBe(true);
    expect(isWithinWindow('23:00-06:00', localTime(12))).toBe(false);
    expect(isWithinWindow('', localTime(12))).toBe(true);
  });
});

describe('scheduler tick', () => {
  it('does not schedule before a baseline exists', async () => {
    const { context } = await setup({ window: '', interval_minutes: 1 }, { seedBaseline: false });
    expect(runSchedulerTick(context.db, localTime(12)).createdJobs).toHaveLength(0);
  });

  it('creates one pending incremental job and does not duplicate while active', async () => {
    const { context, agent } = await setup({
      window: '00:00-23:59',
      interval_minutes: 60,
    });
    const now = localTime(12);

    const result = runSchedulerTick(context.db, now);
    expect(result.createdJobs).toHaveLength(1);
    expect(result.createdJobs[0]?.mountId).toBe(agent.mountId);

    const rows = jobs(context);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', mode: 'incremental' });

    expect(runSchedulerTick(context.db, now).createdJobs).toHaveLength(0);

    const audit = context.db
      .prepare("SELECT actor FROM audit_log WHERE action = 'job.create'")
      .get() as { actor: string } | undefined;
    expect(audit?.actor).toBe('scheduler');
  });

  it('waits for the configured interval before creating the next job', async () => {
    const { context } = await setup({ window: '', interval_minutes: 60 });
    const now = localTime(12);

    runSchedulerTick(context.db, now);
    const first = jobs(context)[0]!;
    context.db
      .prepare("UPDATE scan_jobs SET status = 'completed', started_at = ?, finished_at = ? WHERE id = ?")
      .run(now, now + 1000, first.id);

    expect(runSchedulerTick(context.db, now + 30 * 60_000).createdJobs).toHaveLength(0);
    expect(runSchedulerTick(context.db, now + 61 * 60_000).createdJobs).toHaveLength(1);
  });

  it('respects the time window', async () => {
    const { context } = await setup({ window: '03:00-04:00', interval_minutes: 1 });

    expect(runSchedulerTick(context.db, localTime(12)).createdJobs).toHaveLength(0);
    expect(runSchedulerTick(context.db, localTime(3, 30)).createdJobs).toHaveLength(1);
  });

  it('handles midnight-crossing windows', async () => {
    const { context } = await setup({ window: '23:00-06:00', interval_minutes: 1 });

    expect(runSchedulerTick(context.db, localTime(12)).createdJobs).toHaveLength(0);
    expect(runSchedulerTick(context.db, localTime(23, 30)).createdJobs).toHaveLength(1);
  });

  it('stops when the daily budget is exhausted', async () => {
    const { context, agent } = await setup({
      window: '',
      interval_minutes: 1,
      budget_minutes_per_day: 1,
    });
    const now = localTime(12);

    context.db
      .prepare(
        "INSERT INTO scan_jobs (mount_pk, mode, status, rules_hash, attempt, started_at, finished_at, stats_json, created_at) VALUES (?, 'incremental', 'completed', 'r', 0, ?, ?, ?, ?)",
      )
      .run(
        agent.mountId,
        now - 600_000,
        now - 480_000,
        JSON.stringify({ duration_ms: 120_000 }),
        now - 600_000,
      );

    expect(jobMinutesToday(context.db, agent.mountId, now)).toBeGreaterThanOrEqual(2);
    expect(runSchedulerTick(context.db, now).createdJobs).toHaveLength(0);
  });

  it('skips mounts that are not active', async () => {
    const { context } = await setup({ window: '', interval_minutes: 1 });
    context.db.prepare("UPDATE mounts SET state = 'unavailable'").run();
    expect(runSchedulerTick(context.db, localTime(12)).createdJobs).toHaveLength(0);
  });

  it('marks machines offline after the heartbeat timeout', async () => {
    const { context } = await setup({ window: '', interval_minutes: 60 });
    const now = localTime(12);
    context.db.prepare('UPDATE machines SET last_seen_at = ?').run(now - 120_000);

    const result = runSchedulerTick(context.db, now);
    expect(result.offlinedMachines).toBe(1);
    const machine = context.db.prepare('SELECT status FROM machines').get() as { status: string };
    expect(machine.status).toBe('offline');
  });

  it('recovers expired leases before scheduling', async () => {
    const { context, agent } = await setup({ window: '', interval_minutes: 60 });
    const now = localTime(12);

    context.db
      .prepare(
        "INSERT INTO scan_jobs (mount_pk, mode, status, rules_hash, lease_until, attempt, created_at) VALUES (?, 'full', 'running', 'r', ?, 0, ?)",
      )
      .run(agent.mountId, now - 1000, now - 60_000);

    const result = runSchedulerTick(context.db, now);
    expect(result.createdJobs).toHaveLength(0);

    const job = context.db
      .prepare('SELECT status, attempt FROM scan_jobs')
      .get() as { status: string; attempt: number };
    expect(job.status).toBe('pending');
    expect(job.attempt).toBe(1);
  });
});
