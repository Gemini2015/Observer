import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
  heartbeat,
  loginCookie,
  scanOnce,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface SystemBody {
  version: string;
  now: number;
  uptime_ms: number;
  scheduler: { enabled: boolean; interval_ms: number };
  offline_after_seconds: number;
  db: {
    ok: boolean;
    machines: number;
    mounts: number;
    paths: number;
    issues_open: number;
    jobs_running: number;
    repairs_active: number;
  };
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('system info', () => {
  it('requires a session', async () => {
    const context = await createTestContext();
    ctx = context;

    const anonymous = await context.app.inject({ method: 'GET', url: '/api/v1/system' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('reports version, scheduler config and db counts', async () => {
    const context = await createTestContext({
      OBSERVER_SCHEDULER_ENABLED: 'false',
      OBSERVER_SCHEDULER_INTERVAL_MS: '5000',
      OBSERVER_OFFLINE_AFTER_SECONDS: '45',
    });
    ctx = context;
    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);

    const empty = await context.app.inject({
      method: 'GET',
      url: '/api/v1/system',
      headers: { cookie },
    });
    expect(empty.statusCode).toBe(200);
    const body = empty.json() as SystemBody;
    expect(body.version).toBe(pkg.version);
    expect(body.now).toBeTypeOf('number');
    expect(Math.abs(body.now - Date.now())).toBeLessThan(10_000);
    expect(body.uptime_ms).toBeTypeOf('number');
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(body.scheduler).toEqual({ enabled: false, interval_ms: 5000 });
    expect(body.offline_after_seconds).toBe(45);
    expect(body.db).toEqual({
      ok: true,
      machines: 1,
      mounts: 1,
      paths: 0,
      issues_open: 0,
      jobs_running: 0,
      repairs_active: 0,
    });
    // 不暴露数据目录等部署信息。
    expect(body).not.toHaveProperty('data_dir');
    expect(body).not.toHaveProperty('dataDir');
    expect(JSON.stringify(body)).not.toContain(context.env.OBSERVER_DATA_DIR);

    // baseline + full 产生 1 条 open mismatch，共 2 条路径。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'trusted' }), fileEntry('b.txt', { content: 'bbbb' })],
    });
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'corrupted' }), fileEntry('b.txt', { content: 'bbbb' })],
    });

    // 建一个 pending 任务并心跳派发，让它进入 running。
    const pending = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'incremental' },
    });
    expect(pending.statusCode).toBe(202);
    const beat = await heartbeat(context, agent.agentToken);
    expect((beat.json() as { job: unknown }).job).not.toBeNull();

    // repair_jobs：进行中的状态计数，终态不计。
    const issue = context.db.prepare('SELECT id, mount_pk FROM issues LIMIT 1').get() as {
      id: number;
      mount_pk: number;
    };
    const paths = context.db
      .prepare('SELECT id FROM paths WHERE mount_pk = ? ORDER BY id')
      .all(issue.mount_pk) as Array<{ id: number }>;
    const source = paths[0];
    const target = paths[1];
    if (!source || !target) throw new Error('expected two scanned paths');
    const insertRepair = context.db.prepare(
      `INSERT INTO repair_jobs (issue_pk, source_path_pk, target_path_pk, expected_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insertRepair.run(issue.id, source.id, target.id, 'deadbeef', 'pending', now, now);
    insertRepair.run(issue.id, source.id, target.id, 'deadbeef', 'failed', now, now);

    const after = await context.app.inject({
      method: 'GET',
      url: '/api/v1/system',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as SystemBody;
    expect(afterBody.db).toEqual({
      ok: true,
      machines: 1,
      mounts: 1,
      paths: 2,
      issues_open: 1,
      jobs_running: 1,
      repairs_active: 1,
    });
  });
});
