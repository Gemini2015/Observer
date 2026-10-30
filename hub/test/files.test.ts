import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fileEntry,
  loginCookie,
  makeEnrollToken,
  scanOnce,
  sha256Of,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface AgentSeed {
  agentToken: string;
  machineId: string;
  mountPk: number;
}

async function enroll(
  context: TestContext,
  machineId: string,
  mountId: string,
): Promise<AgentSeed> {
  const token = makeEnrollToken(context.db, machineId);
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload: validEnrollPayload(machineId, mountId),
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    token: string;
    machine_id: string;
    mounts: Array<{ id: number }>;
  };
  return { agentToken: body.token, machineId: body.machine_id, mountPk: body.mounts[0]!.id };
}

interface SeedResult {
  context: TestContext;
  alpha: AgentSeed;
  beta: AgentSeed;
  pathIds: Record<string, number>;
  hashPathId: number;
  hash: string;
}

async function seed(): Promise<SeedResult> {
  const context = await createTestContext();
  const alpha = await enroll(context, 'machine-alpha', 'alpha-mount');
  const beta = await enroll(context, 'machine-beta', 'beta-mount');
  const cookie = await loginCookie(context);

  const hashContent = 'hash-target-content';
  const hash = sha256Of(hashContent);
  await scanOnce(context, {
    agentToken: alpha.agentToken,
    mountId: alpha.mountPk,
    cookie,
    mode: 'baseline',
    entries: [
      fileEntry('dir/a.txt', { content: 'a-content' }),
      fileEntry('b.txt', { content: 'b-content' }),
      fileEntry('docs/c.txt', { content: hashContent }),
    ],
  });
  await scanOnce(context, {
    agentToken: beta.agentToken,
    mountId: beta.mountPk,
    cookie,
    mode: 'baseline',
    entries: [fileEntry('other.txt', { content: 'other-content' })],
  });

  const pathRows = context.db
    .prepare('SELECT id, path_key FROM paths WHERE mount_pk = ?')
    .all(alpha.mountPk) as Array<{ id: number; path_key: string }>;
  const pathIds = Object.fromEntries(pathRows.map((row) => [row.path_key, row.id]));

  // missing + open issue
  context.db
    .prepare("UPDATE paths SET state = 'missing', last_hashed_at = NULL WHERE id = ?")
    .run(pathIds['b.txt']!);
  context.db
    .prepare(
      "INSERT INTO issues (path_pk, mount_pk, type, status, confidence, evidence_json, occurrences, first_seen_at, last_seen_at) VALUES (?, ?, 'missing', 'open', 'medium', ?, 2, ?, ?)",
    )
    .run(pathIds['b.txt']!, alpha.mountPk, JSON.stringify({ job_id: 1 }), Date.now() - 1000, Date.now());

  // out_of_scope
  context.db.prepare("UPDATE paths SET state = 'out_of_scope' WHERE id = ?").run(pathIds['dir/a.txt']!);

  // size filter target
  context.db.prepare('UPDATE paths SET size = 123456 WHERE id = ?').run(pathIds['docs/c.txt']!);

  return { context, alpha, beta, pathIds, hashPathId: pathIds['docs/c.txt']!, hash };
}

describe('file list API', () => {
  it('lists files globally and by machine/mount with filters and summary', async () => {
    const seeded = await seed();
    ctx = seeded.context;
    const cookie = await loginCookie(seeded.context);

    const all = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as {
      items: Array<{ path_key: string; machine_id: string }>;
      total: number;
      limit: number;
      summary: Record<string, number>;
    };
    expect(allBody.total).toBe(4);
    expect(allBody.items).toHaveLength(4);
    expect(allBody.summary).toMatchObject({
      total: 4,
      active: 2,
      missing: 1,
      out_of_scope: 1,
      hashed: 3,
      unhashed: 1,
      open_issue_paths: 1,
    });

    const byMachine = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?machine_id=machine-alpha',
      headers: { cookie },
    });
    expect(byMachine.json()).toMatchObject({ total: 3 });
    expect(
      (byMachine.json() as { items: Array<{ machine_id: string }> }).items.every(
        (item) => item.machine_id === 'machine-alpha',
      ),
    ).toBe(true);

    const byMount = await seeded.context.app.inject({
      method: 'GET',
      url: `/api/v1/files?mount_pk=${seeded.alpha.mountPk}`,
      headers: { cookie },
    });
    expect(byMount.json()).toMatchObject({ total: 3 });

    const byPath = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?q=dir/a',
      headers: { cookie },
    });
    const byPathBody = byPath.json() as { items: Array<{ path_key: string }>; total: number };
    expect(byPathBody.total).toBe(1);
    expect(byPathBody.items[0]?.path_key).toBe('dir/a.txt');

    const missing = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?state=missing',
      headers: { cookie },
    });
    expect(missing.json()).toMatchObject({
      total: 1,
      items: [{ path_key: 'b.txt', open_issue_count: 1 }],
    });

    const openIssues = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?issue=open',
      headers: { cookie },
    });
    expect(openIssues.json()).toMatchObject({ total: 1 });

    const unhashed = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?hash=unhashed',
      headers: { cookie },
    });
    expect(unhashed.json()).toMatchObject({ total: 1 });

    const scopedState = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?state=out_of_scope&machine_id=machine-alpha',
      headers: { cookie },
    });
    expect(scopedState.json()).toMatchObject({ total: 1 });

    const bySize = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?size_min=100000&size_max=200000',
      headers: { cookie },
    });
    expect(bySize.json()).toMatchObject({
      total: 1,
      items: [{ path_key: 'docs/c.txt' }],
    });

    const byHash = await seeded.context.app.inject({
      method: 'GET',
      url: `/api/v1/files?q=${seeded.hash}`,
      headers: { cookie },
    });
    expect(byHash.json()).toMatchObject({ total: 1, items: [{ id: seeded.hashPathId }] });

    const paged = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?limit=2&offset=2&sort=size&order=asc',
      headers: { cookie },
    });
    const pagedBody = paged.json() as { total: number; limit: number; offset: number; items: unknown[] };
    expect(pagedBody).toMatchObject({ total: 4, limit: 2, offset: 2 });
    expect(pagedBody.items).toHaveLength(2);

    const invalid = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?state=bogus',
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(422);

    const badRange = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files?size_min=100&size_max=1',
      headers: { cookie },
    });
    expect(badRange.statusCode).toBe(422);
  });

  it('returns file detail with observations and issues', async () => {
    const seeded = await seed();
    ctx = seeded.context;
    const cookie = await loginCookie(seeded.context);

    const detail = await seeded.context.app.inject({
      method: 'GET',
      url: `/api/v1/files/${seeded.pathIds['b.txt']}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      file: { path_key: 'b.txt', state: 'missing', open_issue_count: 1 },
      machine: { machine_id: 'machine-alpha' },
      mount: { mount_id: 'alpha-mount', physical_path: 'E:\\alpha-mount' },
      issues: [{ type: 'missing', status: 'open' }],
    });
    const body = detail.json() as { observations: Array<{ hash: string; kind: string }> };
    expect(body.observations.length).toBeGreaterThanOrEqual(1);
    expect(body.observations[0]?.kind).toBe('baseline');

    const missing = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files/999999',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('scopes agent file endpoints to the token machine', async () => {
    const seeded = await seed();
    ctx = seeded.context;
    const betaPath = seeded.context.db
      .prepare('SELECT id FROM paths WHERE mount_pk = ?')
      .get(seeded.beta.mountPk) as { id: number };

    const alphaList = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/files?limit=50',
      headers: { authorization: `Bearer ${seeded.alpha.agentToken}` },
    });
    expect(alphaList.statusCode).toBe(200);
    const alphaBody = alphaList.json() as { items: Array<{ machine_id: string }>; total: number };
    expect(alphaBody.total).toBe(3);
    expect(alphaBody.items.every((item) => item.machine_id === 'machine-alpha')).toBe(true);

    const betaList = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/files',
      headers: { authorization: `Bearer ${seeded.beta.agentToken}` },
    });
    expect((betaList.json() as { total: number }).total).toBe(1);

    const crossMachine = await seeded.context.app.inject({
      method: 'GET',
      url: `/api/v1/agent/files/${betaPath.id}`,
      headers: { authorization: `Bearer ${seeded.alpha.agentToken}` },
    });
    expect(crossMachine.statusCode).toBe(404);

    const unauthenticated = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/agent/files',
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('exports filtered files as CSV', async () => {
    const seeded = await seed();
    ctx = seeded.context;
    const cookie = await loginCookie(seeded.context);

    const exported = await seeded.context.app.inject({
      method: 'GET',
      url: '/api/v1/files/export?machine_id=machine-alpha',
      headers: { cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['x-observer-truncated']).toBeUndefined();
    expect(exported.body.charCodeAt(0)).toBe(0xfeff);
    expect(exported.body).toContain('id,machine,mount,path,state,size,hash,last_seen,last_hashed,open_issues');
    expect(exported.body).toContain('machine-alpha');
    expect(exported.body).not.toContain('machine-beta');
  });
});
