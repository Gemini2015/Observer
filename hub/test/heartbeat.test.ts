import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, enrollTestAgent, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('POST /api/v1/agent/heartbeat', () => {
  it('returns mounts and no job in P1', async () => {
    ctx = await createTestContext();
    const { response } = await enrollTestAgent(ctx);
    const token = (response.json() as { token: string }).token;

    const heartbeat = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_version: '0.1.0' },
    });

    expect(heartbeat.statusCode).toBe(200);
    const body = heartbeat.json() as {
      server_time: number;
      job: null;
      cancel: boolean;
      mounts: Array<{ mount_id: string; manifest_epoch: number }>;
    };
    expect(body.job).toBeNull();
    expect(body.cancel).toBe(false);
    expect(body.server_time).toBeGreaterThan(0);
    expect(body.mounts).toEqual([{ mount_id: 'drill', manifest_epoch: 0 }]);
  });

  it('rejects a missing or invalid agent token', async () => {
    ctx = await createTestContext();
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      payload: {},
    });
    expect(missing.statusCode).toBe(401);

    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { authorization: 'Bearer nope' },
      payload: {},
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('updates last_seen and agent version', async () => {
    ctx = await createTestContext();
    const { response } = await enrollTestAgent(ctx);
    const token = (response.json() as { token: string }).token;

    ctx.db.prepare('UPDATE agents SET last_seen_at = 0, version = NULL').run();
    ctx.db.prepare('UPDATE machines SET last_seen_at = 0').run();

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_version: '0.2.0' },
    });

    const agent = ctx.db.prepare('SELECT last_seen_at, version FROM agents').get() as {
      last_seen_at: number;
      version: string;
    };
    const machine = ctx.db.prepare('SELECT last_seen_at FROM machines').get() as {
      last_seen_at: number;
    };
    expect(agent.last_seen_at).toBeGreaterThan(0);
    expect(agent.version).toBe('0.2.0');
    expect(machine.last_seen_at).toBeGreaterThan(0);
  });
});
