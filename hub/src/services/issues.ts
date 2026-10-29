import type { Db } from '../db/index.js';

export type IssueType = 'mismatch' | 'missing' | 'unreadable';
export type IssueConfidence = 'high' | 'medium' | 'low';

interface ExistingIssue {
  id: number;
  status: 'open' | 'acked' | 'ignored' | 'resolved';
}

/**
 * 打开/更新一条异常。
 * - 已忽略（ignored）：只刷新 last_seen_at，保持静音。
 * - 已解决（resolved）：重新打开并累加 occurrences。
 */
export function openIssue(
  db: Db,
  pathPk: number,
  mountPk: number,
  type: IssueType,
  confidence: IssueConfidence,
  evidence: unknown,
  now: number,
): void {
  const existing = db
    .prepare('SELECT id, status FROM issues WHERE path_pk = ? AND type = ?')
    .get(pathPk, type) as ExistingIssue | undefined;
  const evidenceJson = evidence === undefined ? null : JSON.stringify(evidence);

  if (!existing) {
    db.prepare(
      'INSERT INTO issues (path_pk, mount_pk, type, status, confidence, evidence_json, occurrences, first_seen_at, last_seen_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)',
    ).run(pathPk, mountPk, type, 'open', confidence, evidenceJson, now, now);
    return;
  }

  if (existing.status === 'ignored') {
    db.prepare('UPDATE issues SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return;
  }

  if (existing.status === 'resolved') {
    db.prepare(
      "UPDATE issues SET status = 'open', confidence = ?, evidence_json = ?, occurrences = occurrences + 1, last_seen_at = ?, resolved_at = NULL WHERE id = ?",
    ).run(confidence, evidenceJson, now, existing.id);
    return;
  }

  db.prepare(
    'UPDATE issues SET confidence = ?, evidence_json = ?, last_seen_at = ? WHERE id = ?',
  ).run(confidence, evidenceJson, now, existing.id);
}

/** 关闭 open/acked 状态的异常；ignored 保持静音。 */
export function resolveIssue(db: Db, pathPk: number, type: IssueType, now: number): boolean {
  const info = db
    .prepare(
      "UPDATE issues SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE path_pk = ? AND type = ? AND status IN ('open','acked')",
    )
    .run(now, now, pathPk, type);
  return info.changes > 0;
}
