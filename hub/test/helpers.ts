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

export function validEnrollPayload(machineId = 'test-machine') {
  return {
    machine_id: machineId,
    label: '测试机',
    hostname: 'TEST-PC',
    platform: 'windows',
    arch: 'amd64',
    agent_version: '0.1.0',
    mounts: [
      {
        mount_id: 'drill',
        label: '演练目录',
        physical_path: 'E:\\drill',
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
