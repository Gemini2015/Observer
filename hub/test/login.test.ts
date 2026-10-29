import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = response.cookies.find((item) => item.name === 'observer_session');
  if (!cookie) throw new Error('session cookie not set');
  return `${cookie.name}=${cookie.value}`;
}

describe('auth', () => {
  it('logs in with the admin password and exposes /me', async () => {
    ctx = await createTestContext();
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.some((item) => item.name === 'observer_session')).toBe(true);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessionCookie(login) },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { authenticated: boolean }).authenticated).toBe(true);
  });

  it('rejects a wrong password', async () => {
    ctx = await createTestContext();
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('rate-limits repeated failures', async () => {
    ctx = await createTestContext();
    for (let i = 0; i < 5; i += 1) {
      const attempt = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'wrong' },
      });
      expect(attempt.statusCode).toBe(401);
    }
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'test-password' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('requires a session for /me and supports logout', async () => {
    ctx = await createTestContext();
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'test-password' },
    });
    const cookie = sessionCookie(login);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
