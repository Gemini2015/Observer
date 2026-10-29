import type { Db } from '../db/index.js';

export function audit(
  db: Db,
  actor: string,
  action: string,
  target?: string,
  detail?: unknown,
  now: number = Date.now(),
): void {
  db.prepare(
    'INSERT INTO audit_log (actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?)',
  ).run(actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail), now);
}
