import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
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
  mounts: Array<{ id: number; mount_id: string }>;
}

async function enrollMachine(
  context: TestContext,
  machineId: string,
  mountIds: string[],
): Promise<AgentHandle> {
  const token = makeEnrollToken(context.db, machineId);
  const payload = validEnrollPayload(machineId, mountIds[0]!);
  payload.mounts = mountIds.map((mountId) => ({
    ...validEnrollPayload(machineId, mountId).mounts[0]!,
  }));
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    token: string;
    machine_id: string;
    mounts: Array<{ id: number; mount_id: string }>;
  };
  return { agentToken: body.token, machineId: body.machine_id, mounts: body.mounts };
}

function mountInput(machineId: string, mountId: string, overrides: Record<string, unknown> = {}) {
  const base = validEnrollPayload(machineId, mountId).mounts[0]!;
  return {
    ...base,
    mount_id: mountId,
    label: `${mountId} label`,
    physical_path: `E:\\${mountId}`,
    rules_hash: 'rules-1',
    repair_allowed: true,
    ...overrides,
  };
}

async function syncMounts(
  context: TestContext,
  agentToken: string,
  mounts: unknown[],
) {
  return context.app.inject({
    method: 'PUT',
    url: '/api/v1/agent/mounts',
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { mounts },
  });
}

describe('agent mount sync', () => {
  it('adds, updates and soft-removes mounts', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollMachine(context, 'machine-alpha', ['mount-a']);
    const cookie = await loginCookie(context);

    const add = await syncMounts(context, alpha.agentToken, [
      mountInput('machine-alpha', 'mount-a'),
      mountInput('machine-alpha', 'mount-b'),
    ]);
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({
      mounts: [
        { mount_id: 'mount-a', state: 'active' },
        { mount_id: 'mount-b', state: 'active' },
      ],
      added: ['mount-b'],
    });

    const beat = await heartbeat(context, alpha.agentToken);
    expect((beat.json() as { mounts: Array<{ mount_id: string }> }).mounts).toHaveLength(2);

    const mountB = context.db
      .prepare("SELECT id, manifest_epoch FROM mounts WHERE mount_id = 'mount-b'")
      .get() as { id: number; manifest_epoch: number };
    const epochBefore = mountB.manifest_epoch;

    const update = await syncMounts(context, alpha.agentToken, [
      mountInput('machine-alpha', 'mount-a', { physical_path: 'E:\\new-a' }),
      mountInput('machine-alpha', 'mount-b', { rules_hash: 'rules-2', repair_allowed: false }),
    ]);
    expect(update.statusCode).toBe(200);
    const mountBAfter = context.db
      .prepare("SELECT rules_hash, manifest_epoch FROM mounts WHERE id = ?")
      .get(mountB.id) as { rules_hash: string; manifest_epoch: number };
    expect(mountBAfter.rules_hash).toBe('rules-2');
    expect(mountBAfter.manifest_epoch).toBe(epochBefore + 1);

    // 为 mount-b 创建一个 pending 任务，再移除它
    const scan = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${mountB.id}/scan`,
      headers: { cookie },
      payload: { mode: 'baseline' },
    });
    expect(scan.statusCode).toBe(202);

    const remove = await syncMounts(context, alpha.agentToken, [
      mountInput('machine-alpha', 'mount-a'),
    ]);
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toMatchObject({ removed: ['mount-b'] });

    const removed = context.db
      .prepare("SELECT state FROM mounts WHERE id = ?")
      .get(mountB.id) as { state: string };
    expect(removed.state).toBe('removed');
    const job = context.db
      .prepare('SELECT status FROM scan_jobs WHERE mount_pk = ?')
      .get(mountB.id) as { status: string };
    expect(job.status).toBe('canceled');

    const beatAfter = await heartbeat(context, alpha.agentToken);
    expect((beatAfter.json() as { mounts: Array<{ mount_id: string }> }).mounts).toHaveLength(1);

    // 重新加回：复用原 mount 记录
    const readd = await syncMounts(context, alpha.agentToken, [
      mountInput('machine-alpha', 'mount-a'),
      mountInput('machine-alpha', 'mount-b'),
    ]);
    expect(readd.statusCode).toBe(200);
    expect(readd.json()).toMatchObject({ added: ['mount-b'] });
    const revived = context.db
      .prepare("SELECT id, state FROM mounts WHERE mount_id = 'mount-b'")
      .get() as { id: number; state: string };
    expect(revived).toEqual({ id: mountB.id, state: 'active' });

    const audit = context.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mount.sync'")
      .get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(3);
  });

  it('requires agent auth and cannot modify another machine', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollMachine(context, 'machine-alpha', ['mount-a']);
    const beta = await enrollMachine(context, 'machine-beta', ['mount-b']);

    const unauthenticated = await context.app.inject({
      method: 'PUT',
      url: '/api/v1/agent/mounts',
      payload: { mounts: [mountInput('machine-alpha', 'mount-a')] },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const betaSync = await syncMounts(context, beta.agentToken, [
      mountInput('machine-beta', 'mount-b'),
      mountInput('machine-beta', 'mount-b2'),
    ]);
    expect(betaSync.statusCode).toBe(200);

    const alphaMounts = context.db
      .prepare(
        "SELECT m.mount_id FROM mounts m JOIN machines mc ON mc.id = m.machine_pk WHERE mc.machine_id = 'machine-alpha'",
      )
      .all() as Array<{ mount_id: string }>;
    expect(alphaMounts.map((row) => row.mount_id)).toEqual(['mount-a']);
    expect(alpha.machineId).toBe('machine-alpha');
  });
});
