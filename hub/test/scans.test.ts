import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
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

interface MachineSeed {
  machineId: string;
  machinePk: number;
  mounts: Array<{ id: number; mount_id: string }>;
}

async function enrollMachine(
  context: TestContext,
  machineId: string,
  mountIds: string[],
): Promise<MachineSeed> {
  const token = makeEnrollToken(context.db, machineId);
  const baseMount = validEnrollPayload(machineId, mountIds[0]!).mounts[0]!;
  const payload = validEnrollPayload(machineId, mountIds[0]!);
  payload.mounts = mountIds.map((mountId) => ({
    ...baseMount,
    mount_id: mountId,
    physical_path: `E:\\${mountId}`,
  }));
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    machine_id: string;
    mounts: Array<{ id: number; mount_id: string }>;
  };
  const machine = context.db
    .prepare('SELECT id FROM machines WHERE machine_id = ?')
    .get(machineId) as { id: number };
  return { machineId, machinePk: machine.id, mounts: body.mounts };
}

function clearJobs(context: TestContext): void {
  context.db.prepare('DELETE FROM scan_jobs').run();
}

async function trigger(
  context: TestContext,
  cookie: string,
  body: Record<string, unknown>,
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/v1/scans',
    headers: { cookie },
    payload: body,
  });
}

async function jobs(context: TestContext) {
  return context.db
    .prepare('SELECT id, mount_pk, mode, status FROM scan_jobs ORDER BY id')
    .all() as Array<{ id: number; mount_pk: number; mode: string; status: string }>;
}

describe('POST /api/v1/scans', () => {
  it('supports global / machine / mount scopes with incremental and full modes', async () => {
    const context = await createTestContext();
    ctx = context;
    const cookie = await loginCookie(context);
    const alpha = await enrollMachine(context, 'machine-alpha', ['a1', 'a2']);
    const beta = await enrollMachine(context, 'machine-beta', ['b1']);

    // 全局 + 增量
    const globalIncremental = await trigger(context, cookie, { mode: 'incremental' });
    expect(globalIncremental.statusCode).toBe(202);
    expect(globalIncremental.json()).toMatchObject({
      mode: 'incremental',
      total_mounts: 3,
      skipped: [],
    });
    const globalCreated = (globalIncremental.json() as { created: unknown[] }).created;
    expect(globalCreated).toHaveLength(3);
    expect((await jobs(context)).map((job) => job.mode)).toEqual([
      'incremental',
      'incremental',
      'incremental',
    ]);

    // 已有任务时跳过而不是报错
    const again = await trigger(context, cookie, { mode: 'full' });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ created: [], total_mounts: 3 });
    expect((again.json() as { skipped: unknown[] }).skipped).toHaveLength(3);
    expect((again.json() as { skipped: Array<{ reason: string }> }).skipped[0]?.reason).toBe(
      'already active',
    );

    clearJobs(context);

    // 单机器 + 全量
    const machineFull = await trigger(context, cookie, {
      mode: 'full',
      machine_pk: alpha.machinePk,
    });
    expect(machineFull.statusCode).toBe(202);
    expect(machineFull.json()).toMatchObject({
      mode: 'full',
      total_mounts: 2,
    });
    const machineJobs = await jobs(context);
    expect(machineJobs).toHaveLength(2);
    expect(machineJobs.every((job) => job.mode === 'full')).toBe(true);
    expect(machineJobs.map((job) => job.mount_pk).sort()).toEqual(
      alpha.mounts.map((mount) => mount.id).sort(),
    );

    clearJobs(context);

    // 单挂载点 + 全量
    const mountFull = await trigger(context, cookie, {
      mode: 'full',
      mount_pk: beta.mounts[0]!.id,
    });
    expect(mountFull.statusCode).toBe(202);
    expect(mountFull.json()).toMatchObject({ total_mounts: 1, created: [{ mount_id: 'b1' }] });
    expect(await jobs(context)).toMatchObject([{ mode: 'full', mount_pk: beta.mounts[0]!.id }]);

    const audit = context.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'scan.bulk'")
      .get() as { n: number };
    expect(audit.n).toBe(4);
  });

  it('rejects invalid scope combinations and unauthenticated requests', async () => {
    const context = await createTestContext();
    ctx = context;
    const cookie = await loginCookie(context);
    const alpha = await enrollMachine(context, 'machine-alpha', ['a1']);
    const beta = await enrollMachine(context, 'machine-beta', ['b1']);

    const mismatch = await trigger(context, cookie, {
      mode: 'incremental',
      machine_pk: alpha.machinePk,
      mount_pk: beta.mounts[0]!.id,
    });
    expect(mismatch.statusCode).toBe(422);

    const missingMachine = await trigger(context, cookie, {
      mode: 'incremental',
      machine_pk: 99999,
    });
    expect(missingMachine.statusCode).toBe(404);

    context.db
      .prepare("UPDATE mounts SET state = 'removed' WHERE id = ?")
      .run(beta.mounts[0]!.id);
    const removedMount = await trigger(context, cookie, {
      mode: 'full',
      mount_pk: beta.mounts[0]!.id,
    });
    expect(removedMount.statusCode).toBe(404);

    const unauthenticated = await context.app.inject({
      method: 'POST',
      url: '/api/v1/scans',
      payload: { mode: 'incremental' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalidMode = await trigger(context, cookie, { mode: 'baseline' });
    expect(invalidMode.statusCode).toBe(422);
  });
});
