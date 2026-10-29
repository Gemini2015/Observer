import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
  loginCookie,
  scanOnce,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe('overview aggregation', () => {
  it('groups open issues by type and machine', async () => {
    const context = await createTestContext();
    ctx = context;
    const agent = await enrollAndGetAgent(context);
    const cookie = await loginCookie(context);

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('shared.txt', { content: 'trusted' })],
    });
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('shared.txt', { content: 'corrupted' })],
    });

    const overview = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    const data = overview.json() as {
      issues: { open: number; acked: number };
      issues_by_type: { mismatch: number; missing: number; unreadable: number };
      issues_by_machine: Array<{ machine_id: string; open: number }>;
    };
    expect(data.issues.open).toBe(1);
    expect(data.issues_by_type).toEqual({ mismatch: 1, missing: 0, unreadable: 0 });
    expect(data.issues_by_machine).toEqual([{ machine_id: 'test-machine', open: 1 }]);

    const issue = context.db.prepare('SELECT id FROM issues LIMIT 1').get() as { id: number };
    await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/ack`,
      headers: { cookie },
    });

    const afterAck = await context.app.inject({
      method: 'GET',
      url: '/api/v1/overview',
      headers: { cookie },
    });
    const acked = afterAck.json() as {
      issues_by_type: { mismatch: number };
      issues_by_machine: Array<{ machine_id: string; open: number }>;
    };
    expect(acked.issues_by_type.mismatch).toBe(0);
    expect(acked.issues_by_machine).toEqual([]);
  });
});
