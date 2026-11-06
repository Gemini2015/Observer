import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAgentFor,
  enrollAndGetAgent,
  fileEntry,
  loginCookie,
  scanOnce,
  sha256Of,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('overview aggregation', () => {
  it('groups open issues by type and machine', async () => {
    const context = await createTestContext();
    ctx = context;
    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('shared.txt', { content: 'trusted' })],
    });
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('shared.txt', { content: 'corrupted' })],
    });

    const overview = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    const data = overview.json() as {
      issues: { open: number; ignored: number };
      issues_by_type: { mismatch: number; missing: number; unreadable: number };
      issues_by_machine: Array<{ machine_id: string; open: number }>;
    };
    expect(data.issues.open).toBe(1);
    expect(data.issues_by_type).toEqual({ mismatch: 1, missing: 0, unreadable: 0 });
    expect(data.issues_by_machine).toEqual([{ machine_id: 'test-machine', open: 1 }]);

    // 增补字段：机器 open_issues / last_job_at。
    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    const machineList = machines.json() as Array<{
      machine_id: string;
      open_issues: number;
      last_job_at: number | null;
    }>;
    expect(machineList).toMatchObject([{ machine_id: 'test-machine', open_issues: 1 }]);
    expect(machineList[0]?.last_job_at).toBeTypeOf('number');

    const issue = context.db.prepare('SELECT id FROM issues LIMIT 1').get() as { id: number };
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/ignore`,
      headers: { cookie },
      payload: { observed_hash: sha256Of('corrupted') },
    });

    const afterIgnore = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    const ignored = afterIgnore.json() as {
      issues: { open: number; ignored: number };
      issues_by_type: { mismatch: number };
      issues_by_machine: Array<{ machine_id: string; open: number }>;
    };
    expect(ignored.issues).toEqual({ open: 0, ignored: 1 });
    expect(ignored.issues_by_type.mismatch).toBe(0);
    expect(ignored.issues_by_machine).toEqual([]);

    const ignoredMachines = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    expect(ignoredMachines.json()).toMatchObject([{ open_issues: 0 }]);
  });

  it('reports scan freshness and attention mounts', async () => {
    const context = await createTestContext();
    ctx = context;
    const scanned = await enrollAndGetAgent(context);
    const neverScanned = await enrollAgentFor(context, 'beta-machine', 'beta-data');
    const cookie = await loginCookie(context);

    const scan = await scanOnce(context, {
      agentToken: scanned.agentToken,
      mountId: scanned.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'aaaa' })],
    });

    // 把唯一一次 completed 任务的结束时间回拨 48h，构造 stale_24h。
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    context.db
      .prepare('UPDATE scan_jobs SET finished_at = ? WHERE id = ?')
      .run(twoDaysAgo, scan.jobId);

    const overview = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    const data = overview.json() as {
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
    };
    expect(data.mounts).toEqual({ total: 2, never_scanned: 1, stale_24h: 1 });
    expect(data.last_scan_at).toBe(twoDaysAgo);
    // 从未巡检的排最前，其次是最近 completed 任务更早的。
    expect(data.attention_mounts).toHaveLength(2);
    expect(data.attention_mounts[0]).toMatchObject({
      mount_pk: neverScanned.mountId,
      mount_id: 'beta-data',
      machine_id: 'beta-machine',
      state: 'active',
      coverage_ratio: 1,
      last_job_at: null,
      last_job_status: null,
    });
    expect(data.attention_mounts[1]).toMatchObject({
      mount_pk: scanned.mountId,
      mount_id: 'drill',
      machine_id: 'test-machine',
      state: 'active',
      coverage_ratio: 1,
      last_job_at: twoDaysAgo,
      last_job_status: 'completed',
    });

    // 机器列表同步暴露 last_job_at（该机器最近一条 scan_jobs.finished_at）。
    const machines = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    const machineList = machines.json() as Array<{
      machine_id: string;
      open_issues: number;
      last_job_at: number | null;
    }>;
    expect(machineList.find((machine) => machine.machine_id === 'test-machine')).toMatchObject({
      open_issues: 0,
      last_job_at: twoDaysAgo,
    });
    expect(machineList.find((machine) => machine.machine_id === 'beta-machine')).toMatchObject({
      open_issues: 0,
      last_job_at: null,
    });
  });
});
