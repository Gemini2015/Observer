import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
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

async function seedData(context: TestContext) {
  const agent = await enrollAndGetAgent(context);
  const cookie = await loginCookie(context);
  await scanOnce(context, {
    agentToken: agent.agentToken,
    mountId: agent.mountId,
    cookie,
    mode: 'baseline',
    entries: [fileEntry('a.txt', { content: 'trusted' })],
  });
  await scanOnce(context, {
    agentToken: agent.agentToken,
    mountId: agent.mountId,
    cookie,
    mode: 'full',
    entries: [fileEntry('a.txt', { content: 'broken' })],
  });
  const machine = context.db
    .prepare('SELECT id FROM machines WHERE machine_id = ?')
    .get(agent.machineId) as { id: number };
  return { agent, cookie, machinePk: machine.id };
}

function countFor(context: TestContext, table: string, column: string, value: number): number {
  const row = context.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .get(value) as { n: number };
  return row.n;
}

describe('node deletion', () => {
  it('deletes a mount with its data and allows re-enrollment', async () => {
    const context = await createTestContext();
    ctx = context;
    const { agent, cookie, machinePk } = await seedData(context);

    expect(countFor(context, 'paths', 'mount_pk', agent.mountId)).toBeGreaterThan(0);
    expect(countFor(context, 'issues', 'mount_pk', agent.mountId)).toBeGreaterThan(0);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/mounts/${agent.mountId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, mount_id: agent.mountId });

    expect(countFor(context, 'paths', 'mount_pk', agent.mountId)).toBe(0);
    expect(countFor(context, 'issues', 'mount_pk', agent.mountId)).toBe(0);
    expect(countFor(context, 'scan_jobs', 'mount_pk', agent.mountId)).toBe(0);
    const mount = context.db.prepare('SELECT id FROM mounts WHERE id = ?').get(agent.mountId);
    expect(mount).toBeUndefined();
    const machine = context.db.prepare('SELECT id FROM machines WHERE id = ?').get(machinePk);
    expect(machine).toBeDefined();

    const audit = context.db
      .prepare("SELECT actor FROM audit_log WHERE action = 'mount.delete'")
      .get() as { actor: string } | undefined;
    expect(audit?.actor).toBe('user');

    const token = makeEnrollToken(context.db, 'test-machine');
    const enroll = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: validEnrollPayload('test-machine', 'drill'),
    });
    expect(enroll.statusCode).toBe(201);
  });

  it('deletes a machine with its mounts and agents', async () => {
    const context = await createTestContext();
    ctx = context;
    const { cookie, machinePk } = await seedData(context);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/machines/${machinePk}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, machine_id: 'test-machine' });

    for (const table of ['agents', 'mounts']) {
      const row = context.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE machine_pk = ?`)
        .get(machinePk) as { n: number };
      expect(row.n).toBe(0);
    }
    expect(context.db.prepare('SELECT COUNT(*) AS n FROM machines').get()).toEqual({ n: 0 });
    expect(context.db.prepare('SELECT COUNT(*) AS n FROM paths').get()).toEqual({ n: 0 });

    const token = makeEnrollToken(context.db, 'test-machine');
    const enroll = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: validEnrollPayload('test-machine', 'drill'),
    });
    expect(enroll.statusCode).toBe(201);
  });

  it('rejects unauthenticated and missing targets', async () => {
    const context = await createTestContext();
    ctx = context;
    const { agent, cookie, machinePk } = await seedData(context);

    const unauthorized = await context.app.inject({
      method: 'DELETE',
      url: `/api/v1/mounts/${agent.mountId}`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const missingMount = await context.app.inject({
      method: 'DELETE',
      url: '/api/v1/mounts/99999',
      headers: { cookie },
    });
    expect(missingMount.statusCode).toBe(404);

    const missingMachine = await context.app.inject({
      method: 'DELETE',
      url: '/api/v1/machines/99999',
      headers: { cookie },
    });
    expect(missingMachine.statusCode).toBe(404);

    // 数据仍在
    expect(countFor(context, 'paths', 'mount_pk', agent.mountId)).toBeGreaterThan(0);
    expect(context.db.prepare('SELECT id FROM machines WHERE id = ?').get(machinePk)).toBeDefined();
  });
});
