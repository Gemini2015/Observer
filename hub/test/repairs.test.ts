import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  fileEntry,
  heartbeat,
  loginCookie,
  makeEnrollToken,
  sha256Of,
  validEnrollPayload,
  type TestContext,
} from './helpers.js';
import { scanOnce } from './helpers.js';

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

interface AgentHandle {
  agentToken: string;
  machineId: string;
  mountId: number;
}

async function enrollMachine(
  context: TestContext,
  machineId: string,
  mountId: string,
  repairAllowed = true,
): Promise<AgentHandle> {
  const token = makeEnrollToken(context.db, machineId);
  const payload = validEnrollPayload(machineId, mountId);
  payload.mounts[0]!.repair_allowed = repairAllowed;
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload,
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    token: string;
    machine_id: string;
    mounts: Array<{ id: number }>;
  };
  return { agentToken: body.token, machineId: body.machine_id, mountId: body.mounts[0]!.id };
}

interface TransferBeat {
  transfers: Array<{ ticket_id: number; repair_id: number; offset: number; size: number }>;
  repairs: Array<{
    repair_id: number;
    ticket_id: number;
    expected_hash: string;
    observed_hash: string;
    target_state: string;
  }>;
}

async function beat(context: TestContext, token: string): Promise<TransferBeat> {
  const response = await heartbeat(context, token);
  expect(response.statusCode).toBe(200);
  return response.json() as TransferBeat;
}

async function uploadChunk(
  context: TestContext,
  token: string,
  ticketId: number,
  offset: number,
  data: Buffer,
) {
  return context.app.inject({
    method: 'PUT',
    url: `/api/v1/transfers/${ticketId}/data?offset=${offset}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: data,
  });
}

async function downloadChunk(context: TestContext, token: string, ticketId: number, offset = 0) {
  return context.app.inject({
    method: 'GET',
    url: `/api/v1/transfers/${ticketId}/data?offset=${offset}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function pathIdOf(context: TestContext, mountPk: number, pathKey: string): Promise<number> {
  const row = context.db
    .prepare('SELECT id FROM paths WHERE mount_pk = ? AND path_key = ?')
    .get(mountPk, pathKey) as { id: number } | undefined;
  if (!row) throw new Error(`path not found: ${pathKey}`);
  return row.id;
}

function openIssueFor(context: TestContext, machineId: string): { id: number; status: string } {
  const row = context.db
    .prepare(
      `SELECT i.id, i.status FROM issues i
       JOIN mounts m ON m.id = i.mount_pk
       JOIN machines mc ON mc.id = m.machine_pk
       WHERE mc.machine_id = ? ORDER BY i.id DESC LIMIT 1`,
    )
    .get(machineId) as { id: number; status: string } | undefined;
  if (!row) throw new Error(`issue not found for ${machineId}`);
  return row;
}

describe('cross-machine repair', () => {
  it('restores a corrupted file from a healthy replica via hub relay', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollMachine(context, 'machine-alpha', 'mount-a');
    const beta = await enrollMachine(context, 'machine-beta', 'mount-b');
    const cookie = await loginCookie(context);

    const trusted = 'hello-replica';
    const trustedHash = sha256Of(trusted);
    await scanOnce(context, {
      agentToken: alpha.agentToken,
      mountId: alpha.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('shared.txt', { content: trusted })],
    });
    await scanOnce(context, {
      agentToken: beta.agentToken,
      mountId: beta.mountId,
      cookie,
      mode: 'baseline',
      entries: [fileEntry('shared.txt', { content: trusted })],
    });

    const broken = 'corrupted!';
    await scanOnce(context, {
      agentToken: beta.agentToken,
      mountId: beta.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('shared.txt', { content: broken })],
    });

    const issue = openIssueFor(context, 'machine-beta');
    expect(issue.status).toBe('open');

    const replicasResponse = await context.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}/replicas`,
      headers: { cookie },
    });
    expect(replicasResponse.statusCode).toBe(200);
    const replicas = replicasResponse.json() as {
      expected_hash: string;
      repair_allowed: boolean;
      replicas: Array<{ path_id: number; machine_id: string; path_key: string }>;
    };
    expect(replicas.expected_hash).toBe(trustedHash);
    expect(replicas.repair_allowed).toBe(true);
    expect(replicas.replicas).toHaveLength(1);
    expect(replicas.replicas[0]).toMatchObject({
      machine_id: 'machine-alpha',
      path_key: 'shared.txt',
    });

    const createResponse = await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/repair`,
      headers: { cookie },
      payload: { source_path_id: replicas.replicas[0]!.path_id },
    });
    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json() as { repair_id: number; transfer_id: number };

    const alphaTransfer = await beat(context, alpha.agentToken);
    expect(alphaTransfer.transfers).toHaveLength(1);
    expect(alphaTransfer.transfers[0]).toMatchObject({
      ticket_id: created.transfer_id,
      offset: 0,
      size: Buffer.byteLength(trusted),
    });
    const upload = await uploadChunk(
      context,
      alpha.agentToken,
      created.transfer_id,
      0,
      Buffer.from(trusted),
    );
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ status: 'ready', bytes_received: Buffer.byteLength(trusted) });

    const betaRepair = await beat(context, beta.agentToken);
    expect(betaRepair.repairs).toHaveLength(1);
    expect(betaRepair.repairs[0]).toMatchObject({
      repair_id: created.repair_id,
      expected_hash: trustedHash,
      observed_hash: sha256Of(broken),
      target_state: 'active',
    });

    const download = await downloadChunk(context, beta.agentToken, created.transfer_id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString('utf8')).toBe(trusted);

    const result = await context.app.inject({
      method: 'POST',
      url: `/api/v1/repairs/${created.repair_id}/result`,
      headers: { authorization: `Bearer ${beta.agentToken}` },
      payload: {
        success: true,
        hash: trustedHash,
        size: Buffer.byteLength(trusted),
        mtime_ns: '1761234567890123457',
      },
    });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { status: string }).status).toBe('completed');

    const issueAfter = await context.app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}`,
      headers: { cookie },
    });
    expect((issueAfter.json() as { status: string }).status).toBe('resolved');

    const repairAfter = await context.app.inject({
      method: 'GET',
      url: `/api/v1/repairs/${created.repair_id}`,
      headers: { cookie },
    });
    expect(repairAfter.json()).toMatchObject({
      status: 'completed',
      expected_hash: trustedHash,
      transfer: { status: 'completed' },
    });

    const targetPath = context.db
      .prepare('SELECT content_hash, size, state, last_hashed_at FROM paths WHERE mount_pk = ? AND path_key = ?')
      .get(beta.mountId, 'shared.txt') as {
      content_hash: string;
      size: number;
      state: string;
      last_hashed_at: number;
    };
    expect(targetPath.content_hash).toBe(trustedHash);
    expect(targetPath.size).toBe(Buffer.byteLength(trusted));
    expect(targetPath.state).toBe('active');
    expect(targetPath.last_hashed_at).toBeGreaterThan(0);

    const actions = context.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE '%repair%' OR action LIKE '%transfer%'")
      .all() as Array<{ action: string }>;
    const names = actions.map((row) => row.action);
    expect(names).toContain('repair.create');
    expect(names).toContain('transfer.ready');
    expect(names).toContain('repair.complete');

    const afterComplete = await beat(context, beta.agentToken);
    expect(afterComplete.repairs).toHaveLength(0);
  });

  it('rejects invalid repair attempts', async () => {
    const context = await createTestContext();
    ctx = context;
    const alpha = await enrollMachine(context, 'machine-alpha', 'mount-a');
    const beta = await enrollMachine(context, 'machine-beta', 'mount-b');
    const cookie = await loginCookie(context);

    const trusted = 'hello-replica';
    const trustedHash = sha256Of(trusted);
    for (const agent of [alpha, beta]) {
      await scanOnce(context, {
        agentToken: agent.agentToken,
        mountId: agent.mountId,
        cookie,
        mode: 'baseline',
        entries: [fileEntry('shared.txt', { content: trusted })],
      });
    }
    await scanOnce(context, {
      agentToken: beta.agentToken,
      mountId: beta.mountId,
      cookie,
      mode: 'full',
      entries: [fileEntry('shared.txt', { content: 'corrupted!' })],
    });
    const issue = openIssueFor(context, 'machine-beta');
    const sourcePathId = await pathIdOf(context, alpha.mountId, 'shared.txt');
    const targetPathId = await pathIdOf(context, beta.mountId, 'shared.txt');

    const sameMachine = await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/repair`,
      headers: { cookie },
      payload: { source_path_id: targetPathId },
    });
    expect(sameMachine.statusCode).toBe(409);

    context.db.prepare('UPDATE mounts SET repair_allowed = 0 WHERE id = ?').run(beta.mountId);
    const notAllowed = await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/repair`,
      headers: { cookie },
      payload: { source_path_id: sourcePathId },
    });
    expect(notAllowed.statusCode).toBe(403);
    context.db.prepare('UPDATE mounts SET repair_allowed = 1 WHERE id = ?').run(beta.mountId);

    const created = await context.app.inject({
      method: 'POST',
      url: `/api/v1/issues/${issue.id}/repair`,
      headers: { cookie },
      payload: { source_path_id: sourcePathId },
    });
    expect(created.statusCode).toBe(202);
    const { repair_id: repairId, transfer_id: transferId } = created.json() as {
      repair_id: number;
      transfer_id: number;
    };

    // 源端上传错误内容 → 票据失败，issue 保持 open
    const badContent = 'x'.repeat(Buffer.byteLength(trusted));
    const upload = await uploadChunk(
      context,
      alpha.agentToken,
      transferId,
      0,
      Buffer.from(badContent),
    );
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ status: 'failed' });

    const repair = context.db
      .prepare('SELECT status, error FROM repair_jobs WHERE id = ?')
      .get(repairId) as { status: string; error: string };
    expect(repair.status).toBe('failed');
    expect(repair.error).toContain('hash mismatch');
    expect(openIssueFor(context, 'machine-beta').status).toBe('open');

    // 不能上传到已失败的票据
    const again = await uploadChunk(context, alpha.agentToken, transferId, 0, Buffer.from('x'));
    expect(again.statusCode).toBe(410);

    // 下载权限：源机器不能下载中转数据
    const forbidden = await downloadChunk(context, alpha.agentToken, transferId);
    expect(forbidden.statusCode).toBe(403);

    expect(trustedHash).toBeTruthy();
  });
});
