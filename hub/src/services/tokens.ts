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
