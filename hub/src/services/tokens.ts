import type { Db } from '../db/index.js';
import { randomToken, sha256Hex } from '../util/crypto.js';

export interface IssuedEnrollToken {
  token: string;
  expiresAt: number;
  tokenPk: number;
}

export interface EnrollTokenRow {
  id: number;
  token_hash: string;
  machine_hint: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export function issueEnrollToken(
  db: Db,
  options: { machineHint?: string; ttlHours?: number; now?: number } = {},
): IssuedEnrollToken {
  const now = options.now ?? Date.now();
  const ttlMs = (options.ttlHours ?? 24) * 60 * 60 * 1000;
  const token = randomToken(32);
  const info = db
    .prepare(
      'INSERT INTO enroll_tokens (token_hash, machine_hint, expires_at, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(sha256Hex(token), options.machineHint ?? null, now + ttlMs, now);
  return { token, expiresAt: now + ttlMs, tokenPk: Number(info.lastInsertRowid) };
}

export function findUsableEnrollToken(
  db: Db,
  rawToken: string,
  now: number = Date.now(),
): EnrollTokenRow | undefined {
  return db
    .prepare(
      'SELECT * FROM enroll_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    )
    .get(sha256Hex(rawToken), now) as EnrollTokenRow | undefined;
}

export interface IssuedAgentToken {
  token: string;
  agentId: number;
  machineId: string;
  revokedAgents: number;
}

/**
 * 为已注册机器重新签发长期 agent token（“接入 token”）。
 * 旧的 agent token 立即失效；machine、mounts 和历史数据保持不变。
 * 明文 token 只返回这一次，数据库只保存 SHA-256。
 */
export function issueAgentTokenForMachine(
  db: Db,
  machinePk: number,
  now: number = Date.now(),
): IssuedAgentToken | undefined {
  const run = db.transaction((): IssuedAgentToken | undefined => {
    const machine = db
      .prepare('SELECT id, machine_id FROM machines WHERE id = ?')
      .get(machinePk) as { id: number; machine_id: string } | undefined;
    if (!machine) return undefined;

    const latest = db
      .prepare('SELECT version FROM agents WHERE machine_pk = ? ORDER BY id DESC LIMIT 1')
      .get(machinePk) as { version: string | null } | undefined;

    const revoked = db
      .prepare('UPDATE agents SET revoked_at = ? WHERE machine_pk = ? AND revoked_at IS NULL')
      .run(now, machinePk).changes;

    const token = randomToken(32);
    const info = db
      .prepare(
        'INSERT INTO agents (machine_pk, token_hash, version, protocol, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(machinePk, sha256Hex(token), latest?.version ?? null, 1, now, null);

    return {
      token,
      agentId: Number(info.lastInsertRowid),
      machineId: machine.machine_id,
      revokedAgents: Number(revoked),
    };
  });

  return run();
}
