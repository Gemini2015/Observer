import { describe, expect, it, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('GET /healthz', () => {
  it('reports ok', async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('ok');
  });

  it('returns problem+json for unknown routes', async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});
