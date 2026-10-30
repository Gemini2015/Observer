import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  loginCookie,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('web enroll tokens', () => {
  it('creates a token via session and enrolls an agent', async () => {
    const context = await createTestContext();
    ctx = context;

    const unauthenticated = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll-tokens',
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = await loginCookie(context);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll-tokens',
      headers: { cookie },
      payload: { machine_hint: 'web-01', ttl_hours: 24 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      token: string;
      expires_at: number;
      machine_hint: string | null;
    };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.machine_hint).toBe('web-01');
    expect(body.expires_at).toBeGreaterThan(Date.now());

    const enroll = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': body.token },
      payload: validEnrollPayload('web-01'),
    });
    expect(enroll.statusCode).toBe(201);

    const reuse = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll',
      headers: { 'x-observer-enroll-token': body.token },
      payload: validEnrollPayload('web-02'),
    });
    expect(reuse.statusCode).toBe(401);

    const audit = context.db
      .prepare("SELECT actor FROM audit_log WHERE action = 'enroll_token.create'")
      .get() as { actor: string } | undefined;
    expect(audit?.actor).toBe('user');
  });

  it('validates ttl hours', async () => {
    const context = await createTestContext();
    ctx = context;
    const cookie = await loginCookie(context);

    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/v1/enroll-tokens',
      headers: { cookie },
      payload: { ttl_hours: 0 },
    });
    expect(invalid.statusCode).toBe(422);
  });
});
