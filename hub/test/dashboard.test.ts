import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
  loginCookie,
  scanOnce,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('dashboard', () => {
  it('exposes overview, machines, jobs and job detail', async () => {
    const context = await createTestContext();
    ctx = context;

    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'aaaa' }), fileEntry('b.txt', { content: 'bbbb' })],
    });

    const overview = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json() as {
      machines: { total: number; online: number };
      mounts: { total: number; never_scanned: number; stale_24h: number };
      last_scan_at: number | null;
      attention_mounts: Array<{
        mount_pk: number;
        mount_id: string;
        machine_id: string;
        state: string;
        coverage_ratio: number;
        last_job_at: number | null;
        last_job_status: string | null;
      }>;
      coverage: { total: number; hashed: number; ratio: number };
      issues: { open: number; acked: number };
      jobs: { pending: number; running: number };
      recent_jobs: Array<Record<string, unknown>>;
    };
    expect(overviewBody.machines).toEqual({ total: 1, online: 1 });
    expect(overviewBody.mounts.total).toBe(1);
    expect(overviewBody.coverage).toMatchObject({ total: 2, hashed: 2, ratio: 1 });
    expect(overviewBody.recent_jobs).toHaveLength(1);
    expect(overviewBody.recent_jobs[0]).toMatchObject({
      status: 'completed',
      mount_id: 'drill',
      machine_id: 'test-machine',
    });
    expect(overviewBody.recent_jobs[0]?.stats).toBeTypeOf('object');

    // 增补字段：巡检新鲜度 + 需关注挂载点。
    expect(overviewBody.mounts).toEqual({ total: 1, never_scanned: 0, stale_24h: 0 });
    expect(overviewBody.last_scan_at).toBeTypeOf('number');
    expect(overviewBody.last_scan_at).not.toBeNull();
    expect(overviewBody.attention_mounts).toHaveLength(1);
    const attention = overviewBody.attention_mounts[0]!;
    expect(attention).toMatchObject({
      mount_pk: agent.mountId,
      mount_id: 'drill',
      machine_id: 'test-machine',
      state: 'active',
      last_job_status: 'completed',
    });
    expect(attention.coverage_ratio).toBe(1);
    expect(attention.last_job_at).toBe(overviewBody.last_scan_at);

    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    const machineList = machines.json() as Array<{
      id: number;
      machine_id: string;
      mounts: Array<{ mount_id: string; coverage: { total: number } }>;
      open_issues: number;
      last_job_at: number | null;
    }>;
    expect(machineList).toHaveLength(1);
    const machine = machineList[0]!;
    expect(machine.machine_id).toBe('test-machine');
    expect(machine.mounts[0]).toMatchObject({ mount_id: 'drill' });
    expect(machine.mounts[0]?.coverage.total).toBe(2);
    // 增补字段：open_issues 与最近任务结束时间。
    expect(machine.open_issues).toBe(0);
    expect(machine.last_job_at).toBe(overviewBody.last_scan_at);

    const machineDetail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/machines/${machine.id}`,
      headers: { cookie },
    });
    expect(machineDetail.statusCode).toBe(200);
    const machineDetailBody = machineDetail.json() as {
      id: number;
      machine_id: string;
      mounts: Array<{ mount_id: string; coverage: { total: number } }>;
      open_issues: number;
      last_job_at: number | null;
    };
    expect(machineDetailBody).toMatchObject({
      id: machine.id,
      machine_id: 'test-machine',
      open_issues: 0,
      last_job_at: overviewBody.last_scan_at,
    });
    for (const key of [
      'id',
      'machine_id',
      'label',
      'hostname',
      'platform',
      'arch',
      'status',
      'last_seen_at',
      'agent_version',
      'agent_protocol',
      'mounts',
      'open_issues',
      'last_job_at',
    ]) {
      expect(machineDetailBody).toHaveProperty(key);
    }
    expect(machineDetailBody.mounts[0]).toMatchObject({
      mount_id: 'drill',
      coverage: { total: 2 },
    });

    // 详情不存在 404 / 未登录 401；与 DELETE /machines/:id 共存。
    const missingMachine = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines/99999',
      headers: { cookie },
    });
    expect(missingMachine.statusCode).toBe(404);
    expect(missingMachine.json()).toMatchObject({ title: 'machine not found' });

    const anonymousMachine = await context.app.inject({
      method: 'GET',
      url: `/api/v1/machines/${machine.id}`,
    });
    expect(anonymousMachine.statusCode).toBe(401);

    const jobs = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { cookie },
    });
    const jobList = jobs.json() as Array<{ id: number; status: string; machine_id: string }>;
    expect(jobList).toHaveLength(1);
    const jobId = jobList[0]!.id;

    // 增补 machine_id 过滤：单机命中、未知机器为空、与 status/mount_id 组合可用。
    const byMachine = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs?machine_id=test-machine',
      headers: { cookie },
    });
    expect(byMachine.json()).toMatchObject([{ id: jobId, machine_id: 'test-machine' }]);

    const combined = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs?machine_id=test-machine&status=completed&mount_id=drill',
      headers: { cookie },
    });
    expect(combined.json()).toMatchObject([{ id: jobId, status: 'completed', mount_id: 'drill' }]);

    const unknownMachine = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs?machine_id=no-such-machine',
      headers: { cookie },
    });
    expect(unknownMachine.json()).toEqual([]);

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: jobId, status: 'completed' });

    const unauthorized = await context.app.inject({ method: 'GET', url: '/api/v1/overview' });
    expect(unauthorized.statusCode).toBe(401);
  });
});
