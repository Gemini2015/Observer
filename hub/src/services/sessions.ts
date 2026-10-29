import { randomToken } from '../util/crypto.js';
import type { Db } from '../db/index.js';

export const SESSION_COOKIE = 'observer_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  created_at: number;
  expires_at: number;
}

export function createSession(db: Db, ttlMs: number = SESSION_TTL_MS, now: number = Date.now()): SessionRow {
  const id = randomToken(32);
  const expiresAt = now + ttlMs;
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(
    id,
    now,
    expiresAt,
  );
  return { id, created_at: now, expires_at: expiresAt };
}

export function findSession(db: Db, id: string, now: number = Date.now()): SessionRow | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
    .get(id, now) as SessionRow | undefined;
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function cleanupExpiredSessions(db: Db, now: number = Date.now()): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
}
