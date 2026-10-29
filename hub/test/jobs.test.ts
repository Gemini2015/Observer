import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
  heartbeat,
  loginCookie,
  scanOnce,
  type AgentSession,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup(): Promise<{
  ctx: TestContext;
  agent: AgentSession;
  cookie: string;
}> {
  const context = await createTestContext();
  const agent = await enrollAndGetAgent(context);
  const cookie = await loginCookie(context);
  return { ctx: context, agent, cookie };
}

function countRows(context: TestContext, table: string): number {
  const row = context.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('scan jobs', () => {
  it('runs a baseline scan and records coverage', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const { results, finish } = await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'hello' }), fileEntry('b.txt', { content: 'world' })],
    });

    expect(results.statusCode).toBe(200);
    expect(results.json()).toMatchObject({ accepted: 2, duplicate: false });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({
      ok: true,
      job_status: 'completed',
      coverage: { total: 2, hashed: 2, ratio: 1 },
    });

    const paths = context.db
      .prepare('SELECT path_key, content_hash, state FROM paths ORDER BY path_key')
      .all() as Array<{ path_key: string; content_hash: string | null; state: string }>;
    expect(paths.map((row) => row.path_key)).toEqual(['a.txt', 'b.txt']);
    expect(paths.every((row) => row.content_hash !== null && row.state === 'active')).toBe(true);
    expect(countRows(context, 'observations')).toBe(2);

    const mount = context.db
      .prepare('SELECT state, manifest_epoch FROM mounts WHERE id = ?')
      .get(agent.mountId) as { state: string; manifest_epoch: number };
    expect(mount.state).toBe('active');
    expect(mount.manifest_epoch).toBeGreaterThan(0);

    const job = context.db
      .prepare('SELECT status, started_at, finished_at FROM scan_jobs ORDER BY id DESC LIMIT 1')
      .get() as { status: string; started_at: number; finished_at: number };
    expect(job.status).toBe('completed');
    expect(job.started_at).toBeGreaterThan(0);
    expect(job.finished_at).toBeGreaterThan(0);
  });

  it('treats a repeated batch seq as duplicate', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const start = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'baseline' },
    });
    const jobId = (start.json() as { job_id: number }).job_id;
    await heartbeat(context, agent.agentToken);

    const payload = { seq: 0, entries: [fileEntry('a.txt', { content: 'hello' })] };
    const first = await context.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/results`,
      headers: { authorization: `Bearer ${agent.agentToken}` },
      payload,
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/results`,
      headers: { authorization: `Bearer ${agent.agentToken}` },
      payload,
    });

    expect(first.json()).toMatchObject({ accepted: 1, duplicate: false });
    expect(second.json()).toMatchObject({ accepted: 0, duplicate: true });
    expect(countRows(context, 'paths')).toBe(1);
    expect(countRows(context, 'observations')).toBe(1);
  });

  it('detects a mismatch and resolves it when the trusted hash returns', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const mtime = '1761234567890123456';
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'hello', mtimeNs: mtime })],
    });

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'HELLO', mtimeNs: mtime })],
    });

    let issue = context.db
      .prepare("SELECT status, confidence, type FROM issues WHERE type = 'mismatch'")
      .get() as { status: string; confidence: string; type: string } | undefined;
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({ status: 'open', confidence: 'high', type: 'mismatch' });

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'hello', mtimeNs: mtime })],
    });

    const resolved = context.db
      .prepare("SELECT status FROM issues WHERE type = 'mismatch'")
      .get() as { status: string } | undefined;
    expect(resolved?.status).toBe('resolved');
  });

  it('marks unseen paths as missing and resolves them when they return', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'aaaa' }), fileEntry('b.txt', { content: 'bbbb' })],
    });

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: [fileEntry('a.txt', { content: 'aaaa' })],
    });

    const missingPath = context.db
      .prepare("SELECT state FROM paths WHERE path_key = 'b.txt'")
      .get() as { state: string };
    expect(missingPath.state).toBe('missing');
    expect(
      (
        context.db
          .prepare("SELECT COUNT(*) AS n FROM issues WHERE type = 'missing' AND status = 'open'")
          .get() as { n: number }
      ).n,
    ).toBe(1);

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: [fileEntry('a.txt', { content: 'aaaa' }), fileEntry('b.txt', { content: 'bbbb' })],
    });

    const restored = context.db
      .prepare("SELECT state FROM paths WHERE path_key = 'b.txt'")
      .get() as { state: string };
    expect(restored.state).toBe('active');
    expect(
      (
        context.db
          .prepare("SELECT COUNT(*) AS n FROM issues WHERE type = 'missing' AND status = 'resolved'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('flags the mount as suspect instead of mass-reporting missing files', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: Array.from({ length: 120 }, (_, index) =>
        fileEntry(`f${index}.txt`, { content: `content-${index}` }),
      ),
    });

    const { finish } = await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: [],
    });
    expect(finish.statusCode).toBe(200);

    const mount = context.db
      .prepare('SELECT state FROM mounts WHERE id = ?')
      .get(agent.mountId) as { state: string };
    expect(mount.state).toBe('suspect');
    expect(countRows(context, 'issues')).toBe(0);
    const active = context.db
      .prepare("SELECT COUNT(*) AS n FROM paths WHERE state = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(120);
  });

  it('honours the mount guard reported by the agent', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'hello' })],
    });

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: [],
      guard: { status: 'unavailable', reason: 'sentinel missing' },
    });

    const mount = context.db
      .prepare('SELECT state FROM mounts WHERE id = ?')
      .get(agent.mountId) as { state: string };
    expect(mount.state).toBe('unavailable');
    expect(countRows(context, 'issues')).toBe(0);
  });

  it('rejects a second concurrent job for the same mount', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const first = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'full' },
    });
    expect(first.statusCode).toBe(202);

    const second = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'full' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('expires a lease, retries, and fails after three attempts', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const start = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'full' },
    });
    const jobId = (start.json() as { job_id: number }).job_id;

    const firstBeat = await heartbeat(context, agent.agentToken);
    const firstJob = (firstBeat.json() as { job: { id: number } | null }).job;
    expect(firstJob?.id).toBe(jobId);

    let lastJob: { id: number } | null = firstJob;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      context.db.prepare('UPDATE scan_jobs SET lease_until = 1 WHERE id = ?').run(jobId);
      const beat = await heartbeat(context, agent.agentToken);
      lastJob = (beat.json() as { job: { id: number } | null }).job;
      if (attempt < 3) {
        expect(lastJob?.id).toBe(jobId);
      }
    }

    expect(lastJob).toBeNull();
    const job = context.db
      .prepare('SELECT status, attempt FROM scan_jobs WHERE id = ?')
      .get(jobId) as { status: string; attempt: number };
    expect(job.status).toBe('failed');
    expect(job.attempt).toBe(3);
  });

  it('lists issues and supports acknowledge', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const mtime = '1761234567890123456';
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'hello', mtimeNs: mtime })],
    });
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('a.txt', { content: 'HELLO', mtimeNs: mtime })],
    });

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/v1/issues?status=open',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const issues = list.json() as Array<{
      id: number;
      type: string;
      status: string;
      confidence: string;
      mount_id: string;
      machine_id: string;
      path_key: string;
      path_display_b64: string;
    }>;
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({
      type: 'mismatch',
      status: 'open',
      confidence: 'high',
      mount_id: 'drill',
      machine_id: 'test-machine',
      path_key: 'a.txt',
    });
    expect(Buffer.from(issue.path_display_b64, 'base64').toString('utf8')).toBe('a.txt');

    const ack = await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/ack`,
      headers: { cookie },
    });
    expect(ack.statusCode).toBe(200);

    const acked = await context.app.inject({
      method: 'GET',
      url: '/api/v1/issues?status=acked',
      headers: { cookie },
    });
    expect((acked.json() as unknown[]).length).toBe(1);
  });

  it('streams the manifest as gzipped NDJSON', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('a.txt', { content: 'hello' }), fileEntry('b.txt', { content: 'world' })],
    });

    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/mounts/${agent.mountId}/manifest`,
      headers: { authorization: `Bearer ${agent.agentToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');

    const text = gunzipSync(response.rawPayload).toString('utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.k)).toEqual(['a.txt', 'b.txt']);
    expect(lines[0]).toMatchObject({ s: 5, m: '1761234567890123456' });
    expect(typeof lines[0]?.h).toBe('number');
  });
});
