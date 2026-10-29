import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { loadEnv, type Env } from '../src/env.js';
import { ensureAdminPassword } from '../src/services/admin.js';
import { issueEnrollToken } from '../src/services/tokens.js';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  env: Env;
  close: () => Promise<void>;
}

export async function createTestContext(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const env = loadEnv({
    OBSERVER_ADMIN_PASSWORD: 'test-password',
    NODE_ENV: 'test',
    ...overrides,
  });
  const db = openDb(':memory:');
  migrate(db);
  ensureAdminPassword(db, env.OBSERVER_ADMIN_PASSWORD);

  const app = buildApp({ env, db, logger: false });
  await app.ready();

  return {
    app,
    db,
    env,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

export function makeEnrollToken(db: Db, machineHint = 'test-machine'): string {
  return issueEnrollToken(db, { machineHint }).token;
}

export function validEnrollPayload(machineId = 'test-machine', mountId = 'drill') {
  return {
    machine_id: machineId,
    label: '测试机',
    hostname: 'TEST-PC',
    platform: 'windows',
    arch: 'amd64',
    agent_version: '0.1.0',
    mounts: [
      {
        mount_id: mountId,
        label: `${mountId} 目录`,
        physical_path: `E:\\${mountId}`,
        sentinel: '.observer-mount',
        fs_kind: 'local',
        case_sensitive: 'auto',
        unicode: 'auto',
        include: [],
        exclude: ['**/.observer-mount'],
        rules_hash: 'rules-1',
        limits: { bytes_per_sec: 1024, files_per_sec: 10 },
        schedule: {},
      },
    ],
  };
}

export async function enrollTestAgent(ctx: TestContext) {
  const token = makeEnrollToken(ctx.db);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/enroll',
    headers: { 'x-observer-enroll-token': token },
    payload: validEnrollPayload(),
  });
  return { response, enrollToken: token };
}

export interface AgentSession {
  agentId: number;
  agentToken: string;
  mountId: number;
  machineId: string;
}

export async function enrollAndGetAgent(ctx: TestContext): Promise<AgentSession> {
  const { response } = await enrollTestAgent(ctx);
  const body = response.json() as {
    agent_id: number;
    token: string;
    machine_id: string;
    mounts: Array<{ id: number; mount_id: string }>;
  };
  const mount = body.mounts[0];
  if (!mount) throw new Error('enroll response missing mount');
  return {
    agentId: body.agent_id,
    agentToken: body.token,
    mountId: mount.id,
    machineId: body.machine_id,
  };
}

export async function loginCookie(ctx: TestContext): Promise<string> {
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'test-password' },
  });
  const cookie = login.cookies.find((item) => item.name === 'observer_session');
  if (!cookie) throw new Error('session cookie missing');
  return `${cookie.name}=${cookie.value}`;
}

export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export type EntryStatus = 'ok' | 'skipped' | 'unreadable' | 'unstable';

export interface FileEntryOptions {
  content?: string;
  mtimeNs?: string;
  hash?: string | null;
  status?: EntryStatus;
  size?: number;
}

export function fileEntry(pathKey: string, options: FileEntryOptions = {}) {
  const content = options.content ?? pathKey;
  const buffer = Buffer.from(content, 'utf8');
  const entry: {
    path_key: string;
    path_display_b64: string;
    size: number;
    mtime_ns: string;
    hash?: string | null;
    status: EntryStatus;
  } = {
    path_key: pathKey,
    path_display_b64: Buffer.from(pathKey, 'utf8').toString('base64'),
    size: options.size ?? buffer.length,
    mtime_ns: options.mtimeNs ?? '1761234567890123456',
    status: options.status ?? 'ok',
  };
  if (options.hash !== null) {
    entry.hash = options.hash ?? sha256Of(content);
  }
  return entry;
}

export async function heartbeat(ctx: TestContext, agentToken: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/agent/heartbeat',
    headers: { authorization: `Bearer ${agentToken}` },
    payload: {},
  });
}

export interface ScanOnceOptions {
  agentToken: string;
  mountId: number;
  cookie: string;
  mode?: 'baseline' | 'incremental' | 'full';
  entries: unknown[];
  guard?: { status: 'ok' | 'unavailable' | 'suspect'; reason?: string };
}

export async function scanOnce(ctx: TestContext, options: ScanOnceOptions) {
  const start = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/mounts/${options.mountId}/scan`,
    headers: { cookie: options.cookie },
    payload: { mode: options.mode ?? 'incremental' },
  });
  if (start.statusCode !== 202) {
    throw new Error(`scan start failed: ${start.statusCode} ${start.body}`);
  }
  const jobId = (start.json() as { job_id: number }).job_id;

  const beat = await heartbeat(ctx, options.agentToken);
  const job = (beat.json() as { job: { id: number } | null }).job;
  if (!job) throw new Error('heartbeat did not return a job');
  if (job.id !== jobId) throw new Error(`unexpected job id ${job.id} != ${jobId}`);

  const results = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/results`,
    headers: { authorization: `Bearer ${options.agentToken}` },
    payload: { seq: 0, entries: options.entries },
  });

  const finish = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/finish`,
    headers: { authorization: `Bearer ${options.agentToken}` },
    payload: { status: 'completed', stats: {}, guard: options.guard },
  });

  return { jobId, start, results, finish };
}

