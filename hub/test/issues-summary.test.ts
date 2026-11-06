import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAgentFor,
  enrollAndGetAgent,
  fileEntry,
  loginCookie,
  scanOnce,
  sha256Of,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface IssueRow {
  id: number;
  type: string;
  status: string;
  path_key: string;
  machine_id: string;
}

interface SummaryBody {
  status: { open: number; ignored: number; resolved: number };
  type: { mismatch: number; missing: number; unreadable: number };
  machines: Array<{ machine_id: string; open: number }>;
}

/**
 * 造两类数据：
 * - test-machine：1 mismatch（ignored）、1 unreadable（ignored）、2 missing（1 open + 1 resolved）
 * - beta-machine：3 mismatch（open，路径含字面量 % / _ / \，用于 LIKE 转义）
 */
async function seedIssues(context: TestContext): Promise<string> {
  const alpha = await enrollAndGetAgent(context);
  const beta = await enrollAgentFor(context, 'beta-machine', 'beta-data');
  const cookie = await loginCookie(context);

  await scanOnce(context, {
    agentToken: alpha.agentToken,
    mountId: alpha.mountId,
    cookie,
    mode: 'baseline',
    entries: [
      fileEntry('a.txt', { content: 'trusted' }),
      fileEntry('b.txt', { content: 'b' }),
      fileEntry('c.txt', { content: 'c' }),
      fileEntry('d.txt', { content: 'd' }),
    ],
  });
  await scanOnce(context, {
    agentToken: alpha.agentToken,
    mountId: alpha.mountId,
    cookie,
    mode: 'full',
    entries: [
      fileEntry('a.txt', { content: 'corrupted' }),
      fileEntry('b.txt', { status: 'unreadable' }),
    ],
  });

  await scanOnce(context, {
    agentToken: beta.agentToken,
    mountId: beta.mountId,
    cookie,
    mode: 'baseline',
    entries: [
      fileEntry('100%.txt', { content: 'x' }),
      fileEntry('a_b.txt', { content: 'y' }),
      fileEntry('back\\slash.txt', { content: 'z' }),
    ],
  });
  await scanOnce(context, {
    agentToken: beta.agentToken,
    mountId: beta.mountId,
    cookie,
    mode: 'full',
    entries: [
      fileEntry('100%.txt', { content: 'xx' }),
      fileEntry('a_b.txt', { content: 'yy' }),
      fileEntry('back\\slash.txt', { content: 'zz' }),
    ],
  });

  const seeded = (await listIssues(context, cookie, '')).items;
  const issueFor = (pathKey: string, type: string): IssueRow => {
    const found = seeded.find((row) => row.path_key === pathKey && row.type === type);
    if (!found) throw new Error(`missing issue ${type} ${pathKey}`);
    return found;
  };

  // mismatch -> ignored（API）；unreadable -> ignored（API）；missing c.txt -> resolved（直接置状态）。
  const ignoreMismatch = await context.app.inject({
    method: 'POST',
    url: `/api/v1/issues/${issueFor('a.txt', 'mismatch').id}/ignore`,
    headers: { cookie },
    payload: { observed_hash: sha256Of('corrupted') },
  });
  expect(ignoreMismatch.statusCode).toBe(200);
  const ignore = await context.app.inject({
    method: 'POST',
    url: `/api/v1/issues/${issueFor('b.txt', 'unreadable').id}/ignore`,
    headers: { cookie },
  });
  expect(ignore.statusCode).toBe(200);
  const resolvedAt = Date.now();
  context.db
    .prepare("UPDATE issues SET status = 'resolved', resolved_at = ? WHERE id = ?")
    .run(resolvedAt, issueFor('c.txt', 'missing').id);

  return cookie;
}

async function listIssues(
  context: TestContext,
  cookie: string,
  query: string,
): Promise<{ statusCode: number; items: IssueRow[] }> {
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/v1/issues${query}`,
    headers: { cookie },
  });
  return {
    statusCode: response.statusCode,
    items: Array.isArray(response.json()) ? (response.json() as IssueRow[]) : [],
  };
}

describe('issues summary and filters', () => {
  it('summarises counts by status, type and machine', async () => {
    const context = await createTestContext();
    ctx = context;
    const cookie = await seedIssues(context);

    const anonymous = await context.app.inject({ method: 'GET', url: '/api/v1/issues/summary' });
    expect(anonymous.statusCode).toBe(401);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/issues/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: { open: 4, ignored: 2, resolved: 1 },
      type: { mismatch: 3, missing: 1, unreadable: 0 },
      machines: [
        { machine_id: 'beta-machine', open: 3 },
        { machine_id: 'test-machine', open: 1 },
      ],
    } satisfies SummaryBody);
  });

  it('filters issues by machine_id, type and path query', async () => {
    const context = await createTestContext();
    ctx = context;
    const cookie = await seedIssues(context);

    const all = await listIssues(context, cookie, '');
    expect(all.statusCode).toBe(200);
    expect(all.items).toHaveLength(7);

    const byStatus = await listIssues(context, cookie, '?status=open');
    expect(byStatus.items).toHaveLength(4);
    const invalidStatus = await listIssues(context, cookie, '?status=bogus');
    expect(invalidStatus.items).toHaveLength(7);

    const byMachine = await listIssues(context, cookie, '?machine_id=beta-machine');
    expect(byMachine.items).toHaveLength(3);
    expect(byMachine.items.every((row) => row.machine_id === 'beta-machine')).toBe(true);
    const machineAndType = await listIssues(
      context,
      cookie,
      '?machine_id=beta-machine&type=mismatch',
    );
    expect(machineAndType.items).toHaveLength(3);
    const unknownMachine = await listIssues(context, cookie, '?machine_id=no-such-machine');
    expect(unknownMachine.items).toEqual([]);

    const missing = await listIssues(context, cookie, '?type=missing');
    expect(missing.items).toHaveLength(2);
    expect(missing.items.every((row) => row.type === 'missing')).toBe(true);
    const unreadable = await listIssues(context, cookie, '?type=unreadable');
    expect(unreadable.items).toHaveLength(1);
    const invalidType = await listIssues(context, cookie, '?type=bogus');
    expect(invalidType.items).toHaveLength(7);
    const openMismatch = await listIssues(context, cookie, '?status=open&type=mismatch');
    expect(openMismatch.items).toHaveLength(3);

    // q 对 path_key 做 LIKE，`%` `_` `\` 必须按字面量匹配。
    const percent = await listIssues(context, cookie, `?q=${encodeURIComponent('%')}`);
    expect(percent.items).toHaveLength(1);
    expect(percent.items[0]?.path_key).toBe('100%.txt');
    const underscore = await listIssues(context, cookie, `?q=${encodeURIComponent('_')}`);
    expect(underscore.items).toHaveLength(1);
    expect(underscore.items[0]?.path_key).toBe('a_b.txt');
    const backslash = await listIssues(context, cookie, `?q=${encodeURIComponent('\\')}`);
    expect(backslash.items).toHaveLength(1);
    expect(backslash.items[0]?.path_key).toBe('back\\slash.txt');
    const plain = await listIssues(context, cookie, `?q=${encodeURIComponent('a.txt')}`);
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0]).toMatchObject({ path_key: 'a.txt', machine_id: 'test-machine' });
    const combined = await listIssues(
      context,
      cookie,
      `?machine_id=beta-machine&q=${encodeURIComponent('%')}`,
    );
    expect(combined.items).toHaveLength(1);
    expect(combined.items[0]?.machine_id).toBe('beta-machine');

    // 返回形状保持数组（不是分页对象）。
    expect(Array.isArray(all.items)).toBe(true);
  });
});
