import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fileEntry,
  heartbeat,
  loginCookie,
  makeEnrollToken,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface AgentHandle {
  agentToken: string;
  machineId: string;
  mountId: number;
}

async function enrollMachine(
  context: TestContext,
  machineId: string,
  mountId: string,
): Promise<AgentHandle> {
  const token = makeEnrollToken(context.db, machineId);
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload: validEnrollPayload(machineId, mountId),
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    token: string;
    machine_id: string;
    mounts: Array<{ id: number }>;
  };
  const mount = body.mounts[0];
  if (!mount) throw new Error('enroll response missing mount');
  return { agentToken: body.token, machineId: body.machine_id, mountId: mount.id };
}

async function triggerScan(
  context: TestContext,
  cookie: string,
  mountId: number,
  mode: 'baseline' | 'incremental' | 'full' = 'baseline',
): Promise<number> {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/mounts/${mountId}/scan`,
    headers: { cookie },
    payload: { mode },
  });
  expect(response.statusCode).toBe(202);
  return (response.json() as { job_id: number }).job_id;
}

async function submitOk(
  context: TestContext,
  agentToken: string,
  jobId: number,
  pathKey: string,
  content: string,
): Promise<void> {
  const results = await context.app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/results`,
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { seq: 0, entries: [fileEntry(pathKey, { content })] },
  });
  expect(results.statusCode).toBe(200);
}

describe('multi-machine', () => {
  it('runs two agents on different machines independently', async () => {
    const context = await createTestContext();
    ctx = context;

    const alpha = await enrollMachine(context, 'machine-alpha', 'drill');
    const beta = await enrollMachine(context, 'machine-beta', 'drill');

    const cookie = await loginCookie(context);
    const machinesResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/machines',
      headers: { cookie },
    });
    const machineList = machinesResponse.json() as Array<{
      machine_id: string;
      agent_version: string | null;
      mounts: Array<{ id: number; mount_id: string }>;
    }>;
    expect(machineList.map((machine) => machine.machine_id)).toEqual([
      'machine-alpha',
      'machine-beta',
    ]);
    expect(machineList.every((machine) => machine.agent_version === '0.1.0')).toBe(true);
    expect(machineList.every((machine) => machine.mounts[0]?.mount_id === 'drill')).toBe(true);

    const jobAlpha = await triggerScan(context, cookie, alpha.mountId);
    const beatAlpha = await heartbeat(context, alpha.agentToken);
    const alphaJob = (
      beatAlpha.json() as { job: { id: number; mount_id: string } | null }
    ).job;
    expect(alphaJob).toMatchObject({ id: jobAlpha, mount_id: 'drill' });

    // 机器隔离：beta 不应拿到 alpha 的任务
    const beatBeta = await heartbeat(context, beta.agentToken);
    expect((beatBeta.json() as { job: unknown }).job).toBeNull();

    const jobBeta = await triggerScan(context, cookie, beta.mountId);
    const beatBeta2 = await heartbeat(context, beta.agentToken);
    const betaJob = (beatBeta2.json() as { job: { id: number } | null }).job;
    expect(betaJob?.id).toBe(jobBeta);
    expect(betaJob?.id).not.toBe(jobAlpha);

    await submitOk(context, alpha.agentToken, jobAlpha, 'alpha.txt', 'alpha-content');
    const finishAlpha = await context.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobAlpha}/finish`,
      headers: { authorization: `Bearer ${alpha.agentToken}` },
      payload: { status: 'completed', stats: {} },
    });
    expect(finishAlpha.statusCode).toBe(200);

    await submitOk(context, beta.agentToken, jobBeta, 'beta.txt', 'beta-content');
    const finishBeta = await context.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobBeta}/finish`,
      headers: { authorization: `Bearer ${beta.agentToken}` },
      payload: { status: 'completed', stats: {} },
    });
    expect(finishBeta.statusCode).toBe(200);

    const detailAlpha = await context.app.inject({
      method: 'GET',
      url: `/api/v1/mounts/${alpha.mountId}`,
      headers: { cookie },
    });
    const detailBeta = await context.app.inject({
      method: 'GET',
      url: `/api/v1/mounts/${beta.mountId}`,
      headers: { cookie },
    });
    expect(detailAlpha.json()).toMatchObject({ coverage: { total: 1, hashed: 1, ratio: 1 } });
    expect(detailBeta.json()).toMatchObject({ coverage: { total: 1, hashed: 1, ratio: 1 } });

    const overview = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(overview.json()).toMatchObject({
      machines: { total: 2, online: 2 },
      mounts: { total: 2 },
      coverage: { total: 2, hashed: 2, ratio: 1 },
    });
  });
});
