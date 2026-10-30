import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fileEntry,
  loginCookie,
  makeEnrollToken,
  scanOnce,
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
  return { agentToken: body.token, machineId: body.machine_id, mountId: body.mounts[0]!.id };
}

async function scan(context: TestContext, agent: AgentHandle, cookie: string) {
  await scanOnce(context, {
    agentToken: agent.agentToken,
    mountId: agent.mountId,
    cookie,
    mode: 'baseline',
    entries: [fileEntry('a.txt', { content: `${agent.machineId}-content` })],
  });
}

describe('agent job history', () => {
  it('lists only jobs of the calling agent machine', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollMachine(context, 'machine-alpha', 'mount-a');
    const beta = await enrollMachine(context, 'machine-beta', 'mount-b');
    const cookie = await loginCookie(context);
    await scan(context, alpha, cookie);
    await scan(context, beta, cookie);

    const alphaResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { authorization: `Bearer ${alpha.agentToken}` },
    });
    expect(alphaResponse.statusCode).toBe(200);
    const alphaJobs = alphaResponse.json() as Array<{
      id: number;
      mount_id: string;
      machine_id: string;
      status: string;
      stats: unknown;
    }>;
    expect(alphaJobs).toHaveLength(1);
    expect(alphaJobs[0]).toMatchObject({
      mount_id: 'mount-a',
      machine_id: 'machine-alpha',
      status: 'completed',
    });
    expect(alphaJobs[0]?.stats).toBeTypeOf('object');

    const betaResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs?limit=1',
      headers: { authorization: `Bearer ${beta.agentToken}` },
    });
    expect(betaResponse.statusCode).toBe(200);
    const betaJobs = betaResponse.json() as Array<{ mount_id: string }>;
    expect(betaJobs).toHaveLength(1);
    expect(betaJobs[0]?.mount_id).toBe('mount-b');

    const unauthorized = await context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
    });
    expect(unauthorized.statusCode).toBe(401);
  });
});
