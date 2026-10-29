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
      mounts: { total: number };
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

    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    const machineList = machines.json() as Array<{
      machine_id: string;
      mounts: Array<{ mount_id: string; coverage: { total: number } }>;
    }>;
    expect(machineList).toHaveLength(1);
    const machine = machineList[0]!;
    expect(machine.machine_id).toBe('test-machine');
    expect(machine.mounts[0]).toMatchObject({ mount_id: 'drill' });
    expect(machine.mounts[0]?.coverage.total).toBe(2);

    const jobs = await context.app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { cookie },
    });
    const jobList = jobs.json() as Array<{ id: number; status: string }>;
    expect(jobList).toHaveLength(1);
    const jobId = jobList[0]!.id;

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
