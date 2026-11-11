import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  enrollAndGetAgent,
  fileEntry,
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

/** 基线文件数：>= MISSING_RATIO_MIN_TOTAL，保证按比例熔断生效。 */
const BASELINE_COUNT = 120;
/** 增量上报文件数：未出现 20 个，比例 16.7% > 5% → suspect。 */
const INCREMENTAL_COUNT = 100;

interface UnseenJobBody {
  id: number;
  mode: string;
  finished_at: number | null;
  seen: number;
  rules_hash: string;
}

interface UnseenItemBody {
  id: number;
  path_key: string;
  size: number;
  last_seen_at: number | null;
  last_seen_job_pk: number | null;
}

interface UnseenBody {
  mount_id: string;
  state: string;
  job: UnseenJobBody | null;
  rules_changed: boolean;
  total_active: number;
  unseen_count: number;
  items: UnseenItemBody[];
  limit: number;
  offset: number;
  truncated: boolean;
}

interface RebaselineBody {
  ok: boolean;
  mount_id: string;
  updated: number;
  state: string;
  manifest_epoch: number;
  job_id: number;
}

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

function fileEntries(start: number, count: number) {
  return Array.from({ length: count }, (_, index) =>
    fileEntry(`f${start + index}.txt`, { content: `content-${start + index}` }),
  );
}

function expectedUnseenKeys(): string[] {
  return Array.from(
    { length: BASELINE_COUNT - INCREMENTAL_COUNT },
    (_, index) => `f${INCREMENTAL_COUNT + index}.txt`,
  );
}

function mountRow(
  context: TestContext,
  mountPk: number,
): { state: string; manifest_epoch: number } {
  return context.db
    .prepare('SELECT state, manifest_epoch FROM mounts WHERE id = ?')
    .get(mountPk) as { state: string; manifest_epoch: number };
}

/** 构造「疑似掉盘」现场：基线 120 个文件，增量只上报 100 个（熔断为 suspect）。 */
async function seedSuspectMount(
  context: TestContext,
  agent: AgentSession,
  cookie: string,
): Promise<{ baselineJobId: number; incrementalJobId: number }> {
  const baseline = await scanOnce(context, {
    agentToken: agent.agentToken,
    mountId: agent.mountId,
    cookie,
    mode: 'baseline',
    entries: fileEntries(0, BASELINE_COUNT),
    stats: { seen: BASELINE_COUNT, skipped: 0 },
  });
  const incremental = await scanOnce(context, {
    agentToken: agent.agentToken,
    mountId: agent.mountId,
    cookie,
    mode: 'incremental',
    entries: fileEntries(0, INCREMENTAL_COUNT),
    stats: { seen: INCREMENTAL_COUNT, skipped: 0 },
  });
  return { baselineJobId: baseline.jobId, incrementalJobId: incremental.jobId };
}

async function getUnseen(
  context: TestContext,
  cookie: string,
  mountPk: number,
  search = '',
) {
  return context.app.inject({
    method: 'GET',
    url: `/api/v1/mounts/${mountPk}/unseen${search}`,
    headers: { cookie },
  });
}

async function postRebaseline(
  context: TestContext,
  cookie: string,
  mountPk: number,
  payload: Record<string, unknown> = {},
) {
  return context.app.inject({
    method: 'POST',
    url: `/api/v1/mounts/${mountPk}/rebaseline`,
    headers: { cookie },
    payload,
  });
}

describe('mount unseen / rebaseline', () => {
  it('lists paths the latest completed round did not see', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;
    const { baselineJobId, incrementalJobId } = await seedSuspectMount(context, agent, cookie);

    expect(mountRow(context, agent.mountId).state).toBe('suspect');
    expect(
      (context.db.prepare('SELECT COUNT(*) AS n FROM issues').get() as { n: number }).n,
    ).toBe(0);

    const response = await getUnseen(context, cookie, agent.mountId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as UnseenBody;
    expect(body).toMatchObject({
      mount_id: 'drill',
      state: 'suspect',
      rules_changed: false,
      total_active: BASELINE_COUNT,
      unseen_count: BASELINE_COUNT - INCREMENTAL_COUNT,
      limit: 200,
      offset: 0,
      truncated: false,
    });
    expect(body.job).toMatchObject({
      id: incrementalJobId,
      mode: 'incremental',
      seen: INCREMENTAL_COUNT,
      rules_hash: 'rules-1',
    });
    expect(typeof body.job?.finished_at).toBe('number');
    expect(body.items.map((item) => item.path_key)).toEqual(expectedUnseenKeys());
    expect(body.items).toHaveLength(BASELINE_COUNT - INCREMENTAL_COUNT);
    for (const item of body.items) {
      expect(item.id).toBeGreaterThan(0);
      expect(item.size).toBeGreaterThan(0);
      expect(item.last_seen_job_pk).toBe(baselineJobId);
      expect(typeof item.last_seen_at).toBe('number');
    }

    const paged = await getUnseen(context, cookie, agent.mountId, '?limit=10');
    expect(paged.statusCode).toBe(200);
    const pagedBody = paged.json() as UnseenBody;
    expect(pagedBody.unseen_count).toBe(BASELINE_COUNT - INCREMENTAL_COUNT);
    expect(pagedBody.limit).toBe(10);
    expect(pagedBody.offset).toBe(0);
    expect(pagedBody.truncated).toBe(true);
    expect(pagedBody.items.map((item) => item.path_key)).toEqual(
      expectedUnseenKeys().slice(0, 10),
    );

    const tail = await getUnseen(context, cookie, agent.mountId, '?limit=10&offset=18');
    expect(tail.statusCode).toBe(200);
    const tailBody = tail.json() as UnseenBody;
    expect(tailBody.offset).toBe(18);
    expect(tailBody.truncated).toBe(false);
    expect(tailBody.items.map((item) => item.path_key)).toEqual(
      expectedUnseenKeys().slice(18),
    );
  });

  it('rebaselines unseen paths, resets the mount and clears the self-lock', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;
    const { incrementalJobId } = await seedSuspectMount(context, agent, cookie);
    const before = mountRow(context, agent.mountId);
    expect(before.state).toBe('suspect');

    const response = await postRebaseline(context, cookie, agent.mountId, {
      expected_job_id: incrementalJobId,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as RebaselineBody;
    const nextEpoch = before.manifest_epoch + 1;
    expect(body).toEqual({
      ok: true,
      mount_id: 'drill',
      updated: BASELINE_COUNT - INCREMENTAL_COUNT,
      state: 'active',
      manifest_epoch: nextEpoch,
      job_id: incrementalJobId,
    });

    const after = mountRow(context, agent.mountId);
    expect(after.state).toBe('active');
    expect(after.manifest_epoch).toBe(nextEpoch);

    const outOfScope = context.db
      .prepare(
        "SELECT path_key, change_epoch FROM paths WHERE mount_pk = ? AND state = 'out_of_scope' ORDER BY path_key COLLATE NOCASE",
      )
      .all(agent.mountId) as Array<{ path_key: string; change_epoch: number }>;
    expect(outOfScope.map((row) => row.path_key)).toEqual(expectedUnseenKeys());
    expect(outOfScope.every((row) => row.change_epoch === nextEpoch)).toBe(true);
    expect(
      (
        context.db
          .prepare(
            "SELECT COUNT(*) AS n FROM paths WHERE mount_pk = ? AND state = 'active'",
          )
          .get(agent.mountId) as { n: number }
      ).n,
    ).toBe(INCREMENTAL_COUNT);

    const auditRow = context.db
      .prepare(
        "SELECT actor, action, target, detail_json FROM audit_log WHERE action = 'mount.rebaseline'",
      )
      .get() as
      | { actor: string; action: string; target: string; detail_json: string }
      | undefined;
    expect(auditRow).toMatchObject({
      actor: 'user',
      action: 'mount.rebaseline',
      target: 'mount:drill',
    });
    expect(JSON.parse(auditRow?.detail_json ?? '{}')).toMatchObject({
      job_id: incrementalJobId,
      unseen: BASELINE_COUNT - INCREMENTAL_COUNT,
      target: 'out_of_scope',
      manifest_epoch: nextEpoch,
    });

    const cleared = await getUnseen(context, cookie, agent.mountId);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      unseen_count: 0,
      total_active: INCREMENTAL_COUNT,
      items: [],
      truncated: false,
      job: { id: incrementalJobId },
    });

    // 重建基线后再跑一轮只看到这 100 个文件：不再熔断，mount 保持 active。
    const nextRound = await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: fileEntries(0, INCREMENTAL_COUNT),
      stats: { seen: INCREMENTAL_COUNT, skipped: 0 },
    });
    expect(nextRound.finish.statusCode).toBe(200);
    expect(mountRow(context, agent.mountId).state).toBe('active');
  });

  it('rejects rebaseline when nothing is unseen', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: fileEntries(0, 2),
      stats: { seen: 2 },
    });

    const response = await postRebaseline(context, cookie, agent.mountId);
    expect(response.statusCode).toBe(409);
    expect((response.json() as { title: string }).title).toBe('no unseen files');
  });

  it('rejects rebaseline when the expected job is stale', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;
    const { baselineJobId } = await seedSuspectMount(context, agent, cookie);

    const response = await postRebaseline(context, cookie, agent.mountId, {
      expected_job_id: baselineJobId,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { title: string }).title).toBe('scan result changed');
  });

  it('rejects rebaseline when the latest scan saw no files', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'baseline',
      entries: fileEntries(0, BASELINE_COUNT),
      stats: { seen: BASELINE_COUNT },
    });
    // 守卫失败/空目录：上报 0 个文件且 stats.seen = 0。
    await scanOnce(context, {
      agentToken: agent.agentToken,
      mountId: agent.mountId,
      cookie,
      mode: 'incremental',
      entries: [],
      stats: { seen: 0 },
    });

    const response = await postRebaseline(context, cookie, agent.mountId);
    expect(response.statusCode).toBe(409);
    expect((response.json() as { title: string }).title).toBe('latest scan saw no files');
  });

  it('rejects rebaseline when scan rules changed', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;
    const { incrementalJobId } = await seedSuspectMount(context, agent, cookie);

    // 模拟 mount 规则在任务之后被修改：任务记录的 rules_hash 已过期。
    context.db
      .prepare('UPDATE mounts SET rules_hash = ?, updated_at = ? WHERE id = ?')
      .run('rules-2', Date.now(), agent.mountId);

    const response = await postRebaseline(context, cookie, agent.mountId, {
      expected_job_id: incrementalJobId,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { title: string }).title).toBe('scan rules changed');
  });

  it('rejects rebaseline while a scan is pending or running', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;
    const { incrementalJobId } = await seedSuspectMount(context, agent, cookie);

    const start = await context.app.inject({
      method: 'POST',
      url: `/api/v1/mounts/${agent.mountId}/scan`,
      headers: { cookie },
      payload: { mode: 'full' },
    });
    expect(start.statusCode).toBe(202);

    const response = await postRebaseline(context, cookie, agent.mountId, {
      expected_job_id: incrementalJobId,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { title: string }).title).toBe('scan in progress');
  });

  it('returns 404 for an unknown mount', async () => {
    const { ctx: context, cookie } = await setup();
    ctx = context;

    const unseen = await getUnseen(context, cookie, 999_999);
    expect(unseen.statusCode).toBe(404);
    expect((unseen.json() as { title: string }).title).toBe('mount not found');

    const rebaseline = await postRebaseline(context, cookie, 999_999);
    expect(rebaseline.statusCode).toBe(404);
    expect((rebaseline.json() as { title: string }).title).toBe('mount not found');
  });

  it('returns an empty result when the mount has no completed scan', async () => {
    const { ctx: context, agent, cookie } = await setup();
    ctx = context;

    const unseen = await getUnseen(context, cookie, agent.mountId);
    expect(unseen.statusCode).toBe(200);
    expect(unseen.json()).toMatchObject({
      mount_id: 'drill',
      state: 'active',
      job: null,
      rules_changed: false,
      total_active: 0,
      unseen_count: 0,
      items: [],
      truncated: false,
    });

    const rebaseline = await postRebaseline(context, cookie, agent.mountId);
    expect(rebaseline.statusCode).toBe(409);
    expect((rebaseline.json() as { title: string }).title).toBe('no completed scan');
  });
});
