import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollTestAgent,
  makeEnrollToken,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

function dbRows<T>(ctx: TestContext, sql: string): T[] {
  return ctx.db.prepare(sql).all() as T[];
}

describe('POST /api/v1/enroll', () => {
  it('registers machine, agent and mounts', async () => {
    ctx = await createTestContext();
    const { response } = await enrollTestAgent(ctx);

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      agent_id: number;
      token: string;
      machine_id: string;
      mounts: Array<{ id: number; mount_id: string; manifest_epoch: number }>;
    };
    expect(body.token).toBeTruthy();
    expect(body.machine_id).toBe('test-machine');
    expect(body.mounts).toHaveLength(1);
    expect(body.mounts[0]).toMatchObject({ mount_id: 'drill', manifest_epoch: 0 });
    expect(body.mounts[0]?.id).toBeGreaterThan(0);

    const machines = dbRows<{ machine_id: string }>(ctx, 'SELECT machine_id FROM machines');
    expect(machines.map((row) => row.machine_id)).toEqual(['test-machine']);

    const mounts = dbRows<{ mount_id: string; state: string }>(
      ctx,
      'SELECT mount_id, state FROM mounts',
    );
    expect(mounts).toEqual([{ mount_id: 'drill', state: 'active' }]);

    const agents = dbRows<{ protocol: number }>(ctx, 'SELECT protocol FROM agents');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.protocol).toBe(1);
  });

  it('rejects a missing enroll token', async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      payload: validEnrollPayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown enroll token', async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': 'nope' },
      payload: validEnrollPayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired enroll token', async () => {
    ctx = await createTestContext();
    const { token } = await import('../src/services/tokens.js').then((mod) =>
      mod.issueEnrollToken(ctx!.db, { now: Date.now() - 48 * 60 * 60 * 1000, ttlHours: 24 }),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: validEnrollPayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('consumes the enroll token exactly once', async () => {
    ctx = await createTestContext();
    const { enrollToken } = await enrollTestAgent(ctx);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': enrollToken },
      payload: validEnrollPayload('another-machine'),
    });
    expect(second.statusCode).toBe(401);
  });

  it('rejects a duplicate mount_id on the same machine and keeps the token usable', async () => {
    ctx = await createTestContext();
    await enrollTestAgent(ctx);

    const token = makeEnrollToken(ctx.db);
    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: validEnrollPayload(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { title: string }).title).toBe('mount conflict');

    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: {
        ...validEnrollPayload('another-machine'),
        mounts: [{ ...validEnrollPayload().mounts[0]!, mount_id: 'other' }],
      },
    });
    expect(reused.statusCode).toBe(201);
  });

  it('validates identifiers', async () => {
    ctx = await createTestContext();
    const token = makeEnrollToken(ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': token },
      payload: {
        ...validEnrollPayload(),
        mounts: [{ ...validEnrollPayload().mounts[0]!, mount_id: 'Bad/ID' }],
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
