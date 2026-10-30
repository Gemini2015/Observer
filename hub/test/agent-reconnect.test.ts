import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  heartbeat,
  loginCookie,
  sha256Of,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function machinePk(context: TestContext, machineId: string): Promise<number> {
  const row = context.db
    .prepare('SELECT id FROM machines WHERE machine_id = ?')
    .get(machineId) as { id: number } | undefined;
  if (!row) throw new Error(`machine ${machineId} not found`);
  return row.id;
}

async function identity(context: TestContext, token: string) {
  return context.app.inject({
    method: 'GET',
    url: '/api/v1/agent/identity',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('agent token reconnect', () => {
  it('reissues a long-lived token for an existing machine and invalidates the old one', async () => {
    const context = await createTestContext();
    ctx = context;
    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);
    const pk = await machinePk(context, agent.machineId);

    const rotate = await context.app.inject({
      method: 'POST',
      url: `/api/v1/machines/${pk}/token`,
      headers: { cookie },
    });
    expect(rotate.statusCode).toBe(201);
    const body = rotate.json() as {
      token: string;
      agent_id: number;
      machine_id: string;
      revoked_agents: number;
    };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.machine_id).toBe(agent.machineId);
    expect(body.revoked_agents).toBe(1);

    const oldBeat = await heartbeat(context, agent.agentToken);
    expect(oldBeat.statusCode).toBe(401);
    const oldIdentity = await identity(context, agent.agentToken);
    expect(oldIdentity.statusCode).toBe(401);

    const newBeat = await heartbeat(context, body.token);
    expect(newBeat.statusCode).toBe(200);
    const newIdentity = await identity(context, body.token);
    expect(newIdentity.statusCode).toBe(200);
    expect(newIdentity.json()).toMatchObject({
      machine_id: agent.machineId,
      mounts: [{ mount_id: 'drill', physical_path: 'E:\\drill', sentinel: '.observer-mount' }],
    });

    const machineCount = context.db.prepare('SELECT COUNT(*) AS n FROM machines').get() as { n: number };
    expect(machineCount.n).toBe(1);
    const mounts = context.db
      .prepare('SELECT mount_id FROM mounts WHERE machine_pk = ?')
      .all(pk) as Array<{ mount_id: string }>;
    expect(mounts.map((mount) => mount.mount_id)).toEqual(['drill']);

    const active = context.db
      .prepare('SELECT id, token_hash FROM agents WHERE machine_pk = ? AND revoked_at IS NULL')
      .all(pk) as Array<{ id: number; token_hash: string }>;
    expect(active).toHaveLength(1);
    expect(active[0]!.token_hash).toBe(sha256Of(body.token));
    expect(active[0]!.token_hash).not.toBe(body.token);

    const audit = context.db
      .prepare('SELECT actor, target, detail_json FROM audit_log WHERE action = ?')
      .get('agent.token.rotate') as
      | { actor: string; target: string; detail_json: string }
      | undefined;
    expect(audit?.actor).toBe('user');
    expect(audit?.target).toBe(`machine:${agent.machineId}`);
    expect(audit?.detail_json).not.toContain(body.token);
  });

  it('rotation can be repeated and old tokens stay invalid', async () => {
    const context = await createTestContext();
    ctx = context;
    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);
    const pk = await machinePk(context, agent.machineId);

    const first = await context.app.inject({
      method: 'POST',
      url: `/api/v1/machines/${pk}/token`,
      headers: { cookie },
    });
    const firstToken = (first.json() as { token: string }).token;
    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/machines/${pk}/token`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(201);
    const secondToken = (second.json() as { token: string }).token;
    expect(secondToken).not.toBe(firstToken);

    expect((await heartbeat(context, firstToken)).statusCode).toBe(401);
    expect((await heartbeat(context, secondToken)).statusCode).toBe(200);

    const revoked = context.db
      .prepare('SELECT COUNT(*) AS n FROM agents WHERE machine_pk = ? AND revoked_at IS NOT NULL')
      .get(pk) as { n: number };
    expect(revoked.n).toBeGreaterThanOrEqual(2);
  });

  it('requires session and rejects unknown machines', async () => {
    const context = await createTestContext();
    ctx = context;
    await enrollAndGetAgent(context);

    const unauthenticated = await context.app.inject({
      method: 'POST',
      url: '/api/v1/machines/1/token',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = await loginCookie(context);
    const missing = await context.app.inject({
      method: 'POST',
      url: '/api/v1/machines/99999/token',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('identity only exposes the token owner machine and requires auth', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollAndGetAgent(context);

    const token = (await import('../src/services/tokens.js')).issueEnrollToken(context.db).token;
    const betaEnroll = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: {
        ...validEnrollPayload('machine-beta', 'beta-data'),
        mounts: [
          {
            ...validEnrollPayload('machine-beta', 'beta-data').mounts[0]!,
            physical_path: 'F:\\beta',
          },
        ],
      },
    });
    const betaToken = (betaEnroll.json() as { token: string }).token;

    const unauthenticated = await context.app.inject({ method: 'GET', url: '/api/v1/agent/identity' });
    expect(unauthenticated.statusCode).toBe(401);

    const alphaIdentity = await identity(context, alpha.agentToken);
    expect(alphaIdentity.statusCode).toBe(200);
    expect(alphaIdentity.json()).toMatchObject({
      machine_id: 'test-machine',
      mounts: [{ mount_id: 'drill' }],
    });

    const betaIdentity = await identity(context, betaToken);
    expect(betaIdentity.statusCode).toBe(200);
    const betaBody = betaIdentity.json() as { machine_id: string; mounts: Array<{ mount_id: string }> };
    expect(betaBody.machine_id).toBe('machine-beta');
    expect(betaBody.mounts.map((mount) => mount.mount_id)).toEqual(['beta-data']);
  });
});
