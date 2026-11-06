import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
  loginCookie,
  scanOnce,
  sha256Of,
  type AgentSession,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface IssueRow {
  id: number;
  status: string;
  occurrences: number;
  ignored_hash: string | null;
  ignored_at: number | null;
  resolution: string | null;
  resolved_at: number | null;
}

interface SetupResult {
  context: TestContext;
  agent: AgentSession;
  cookie: string;
}

async function setup(): Promise<SetupResult> {
  const context = await createTestContext();
  const agent = await enrollAndGetAgent(context);
  const cookie = await loginCookie(context);
  return { context, agent, cookie };
}

function issueFor(context: TestContext, pathKey = 'a.txt', type = 'mismatch'): IssueRow {
  const row = context.db
    .prepare(
      `SELECT i.id, i.status, i.occurrences, i.ignored_hash, i.ignored_at, i.resolution, i.resolved_at
         FROM issues i
         JOIN paths p ON p.id = i.path_pk
        WHERE p.path_key = ? AND i.type = ?
        ORDER BY i.id DESC
        LIMIT 1`,
    )
    .get(pathKey, type) as IssueRow | undefined;
  if (!row) throw new Error(`issue not found: ${type} ${pathKey}`);
  return row;
}

function pathHash(context: TestContext, pathKey = 'a.txt'): string | null {
  const row = context.db
    .prepare('SELECT content_hash FROM paths WHERE path_key = ?')
    .get(pathKey) as { content_hash: string | null } | undefined;
  return row?.content_hash ?? null;
}

async function injectPost(
  context: TestContext,
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) {
  const options: {
    method: 'POST';
    url: string;
    headers: { cookie: string };
    payload?: Record<string, unknown>;
  } = { method: 'POST', url, headers: { cookie } };
  if (payload !== undefined) options.payload = payload;
  return context.app.inject(options);
}

describe('issue accept/ignore lifecycle', () => {
  it('rebaselines to the latest observed hash, then reopens on another hash', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    let issue = issueFor(context);
    expect(issue.status).toBe('open');
    const observed = sha256Of('corrupted');

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      status: 'open',
      observed_hash: observed,
      can_rebaseline: true,
      can_ignore: true,
    });

    const rebaseline = await injectPost(
      context,
      `/api/v1/issues/${issue.id}/rebaseline`,
      cookie,
      { observed_hash: observed },
    );
    expect(rebaseline.statusCode).toBe(200);
    expect(rebaseline.json()).toMatchObject({ baseline_hash: observed });

    issue = issueFor(context);
    expect(issue).toMatchObject({
      status: 'resolved',
      resolution: 'rebaselined',
      occurrences: 1,
    });
    expect(issue.resolved_at).toBeTypeOf('number');
    expect(pathHash(context)).toBe(observed);

    const observation = context.db
      .prepare('SELECT kind FROM observations ORDER BY id DESC LIMIT 1')
      .get() as { kind: string };
    expect(observation.kind).toBe('baseline');

    const rebaselineAudit = context.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'issue.rebaseline'")
      .get() as { n: number };
    expect(rebaselineAudit.n).toBe(1);

    // 新一轮同 hash：不再产生异常。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });
    expect(issueFor(context).status).toBe('resolved');

    // 第三种 hash：重新打开并累计 occurrences。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'third' })],
    });
    issue = issueFor(context);
    expect(issue).toMatchObject({ status: 'open', occurrences: 2, resolution: null });
    expect(issue.resolved_at).toBeNull();
  });

  it('ignores only the observed hash and resolves when the baseline hash returns', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    const issue = issueFor(context);
    const observed = sha256Of('corrupted');
    const ignore = await injectPost(context, `/api/v1/issues/${issue.id}/ignore`, cookie, {
      observed_hash: observed,
    });
    expect(ignore.statusCode).toBe(200);

    expect(issueFor(context)).toMatchObject({
      status: 'ignored',
      ignored_hash: observed,
      occurrences: 1,
    });

    // 同一 hash：保持 ignored，不重复报。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });
    expect(issueFor(context)).toMatchObject({ status: 'ignored', occurrences: 1 });

    // 恢复基线 hash：自动 resolved/recovered。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'trusted' })],
    });
    expect(issueFor(context)).toMatchObject({
      status: 'resolved',
      resolution: 'recovered',
    });

    const audit = context.db
      .prepare("SELECT action FROM audit_log WHERE action IN ('issue.ignore','issue.resolve')")
      .all() as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['issue.ignore', 'issue.resolve']),
    );
  });

  it('reopens when a third hash appears and does not re-suppress the old ignored hash', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    const issue = issueFor(context);
    const ignoredHash = sha256Of('corrupted');
    await injectPost(context, `/api/v1/issues/${issue.id}/ignore`, cookie, {
      observed_hash: ignoredHash,
    });

    // 第三种 hash -> open，occurrences +1。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'third' })],
    });
    let current = issueFor(context);
    expect(current).toMatchObject({ status: 'open', occurrences: 2 });
    expect(current.ignored_hash).toBe(ignoredHash);

    // 回到旧 ignored hash：仍然 open，不再自动静默。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });
    current = issueFor(context);
    expect(current).toMatchObject({ status: 'open', occurrences: 2 });
  });

  it('unignores to open without increasing occurrences', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    const issue = issueFor(context);
    const observed = sha256Of('corrupted');
    await injectPost(context, `/api/v1/issues/${issue.id}/ignore`, cookie, {
      observed_hash: observed,
    });
    const unignore = await injectPost(context, `/api/v1/issues/${issue.id}/unignore`, cookie);
    expect(unignore.statusCode).toBe(200);

    expect(issueFor(context)).toMatchObject({ status: 'open', occurrences: 1 });

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });
    expect(issueFor(context)).toMatchObject({ status: 'open', occurrences: 1 });
  });

  it('rejects stale observed hash and changed baseline', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    const issue = issueFor(context);
    const stale = await injectPost(context, `/api/v1/issues/${issue.id}/rebaseline`, cookie, {
      observed_hash: sha256Of('other'),
    });
    expect(stale.statusCode).toBe(409);

    context.db
      .prepare("UPDATE paths SET content_hash = ? WHERE path_key = 'a.txt'")
      .run(sha256Of('third'));
    const changed = await injectPost(context, `/api/v1/issues/${issue.id}/rebaseline`, cookie, {
      observed_hash: sha256Of('corrupted'),
    });
    expect(changed.statusCode).toBe(409);
  });

  it('rejects rebaseline while a repair is active', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    const issue = issueFor(context);
    const path = context.db
      .prepare("SELECT id FROM paths WHERE path_key = 'a.txt'")
      .get() as { id: number };
    const now = Date.now();
    context.db
      .prepare(
        `INSERT INTO repair_jobs
           (issue_pk, source_path_pk, target_path_pk, expected_hash, observed_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(issue.id, path.id, path.id, sha256Of('trusted'), sha256Of('corrupted'), now, now);

    const response = await injectPost(context, `/api/v1/issues/${issue.id}/rebaseline`, cookie, {
      observed_hash: sha256Of('corrupted'),
    });
    expect(response.statusCode).toBe(409);
    expect(issueFor(context).status).toBe('open');
  });

  it('does not auto-rebaseline existing paths in baseline mode', async () => {
    const { context, agent, cookie } = await setup();
    ctx = context;

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
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'corrupted' })],
    });

    expect(pathHash(context)).toBe(sha256Of('trusted'));
    expect(issueFor(context).status).toBe('open');
  });
});
