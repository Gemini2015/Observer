import type { Db } from '../db/index.js';
import { audit } from './audit.js';

export type IssueType = 'mismatch' | 'missing' | 'unreadable';
export type IssueConfidence = 'high' | 'medium' | 'low';
export type IssueStatus = 'open' | 'ignored' | 'resolved';
export type IssueResolution = 'recovered' | 'repaired' | 'rebaselined';

interface ExistingIssue {
  id: number;
  /** 数据库仍可能保留遗留 acked；服务层按 ignored 兼容处理。 */
  status: string;
  ignored_hash: string | null;
  occurrences: number;
}

export interface OpenIssueInput {
  pathPk: number;
  mountPk: number;
  type: IssueType;
  confidence: IssueConfidence;
  evidence: unknown;
  /** mismatch 必须传入本次观测 hash；missing/unreadable 传 null。 */
  observedHash?: string | null;
  actor?: string;
  now?: number;
}

export interface ResolveIssueOptions {
  resolution?: IssueResolution;
  actor?: string;
  now?: number;
}

function reopenIssue(
  db: Db,
  issue: ExistingIssue,
  input: OpenIssueInput,
  evidenceJson: string | null,
  now: number,
  actor: string,
): void {
  const updated = db
    .prepare(
      `UPDATE issues
          SET status = 'open',
              confidence = ?,
              evidence_json = ?,
              occurrences = occurrences + 1,
              last_seen_at = ?,
              resolved_at = NULL,
              resolution = NULL
        WHERE id = ?
          AND status IN ('ignored', 'acked', 'resolved')
      RETURNING id`,
    )
    .get(input.confidence, evidenceJson, now, issue.id) as { id: number } | undefined;
  if (!updated) return;

  audit(
    db,
    actor,
    'issue.reopen',
    `issue:${issue.id}`,
    {
      type: input.type,
      previous_status: issue.status,
      occurrences: issue.occurrences + 1,
      ignored_hash: issue.ignored_hash,
    },
    now,
  );
}

/**
 * 打开/更新一条异常。
 * - 尚无记录：创建 open。
 * - open：仅刷新置信度、证据与最近发现时间。
 * - ignored：mismatch 若观测 hash 仍是忽略的 hash 则保持静默；
 *   否则重新打开并累加 occurrences。missing/unreadable 保持 ignored。
 * - resolved：重新打开并累加 occurrences。
 * - 遗留 acked：按 ignored 处理。
 */
export function openIssue(db: Db, input: OpenIssueInput): void {
  const now = input.now ?? Date.now();
  const actor = input.actor ?? 'system';
  const evidenceJson = input.evidence === undefined ? null : JSON.stringify(input.evidence);
  const existing = db
    .prepare('SELECT id, status, ignored_hash, occurrences FROM issues WHERE path_pk = ? AND type = ?')
    .get(input.pathPk, input.type) as ExistingIssue | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO issues
         (path_pk, mount_pk, type, status, confidence, evidence_json, occurrences,
          first_seen_at, last_seen_at, resolved_at, ignored_hash, ignored_at, resolution)
       VALUES (?, ?, ?, 'open', ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(input.pathPk, input.mountPk, input.type, input.confidence, evidenceJson, now, now);
    return;
  }

  if (existing.status === 'ignored' || existing.status === 'acked') {
    if (input.type === 'mismatch') {
      const observedHash = input.observedHash ?? null;
      if (observedHash !== null && existing.ignored_hash === observedHash) {
        db.prepare(
          'UPDATE issues SET confidence = ?, evidence_json = ?, last_seen_at = ? WHERE id = ?',
        ).run(input.confidence, evidenceJson, now, existing.id);
        return;
      }
      reopenIssue(db, existing, input, evidenceJson, now, actor);
      return;
    }

    db.prepare(
      'UPDATE issues SET confidence = ?, evidence_json = ?, last_seen_at = ? WHERE id = ?',
    ).run(input.confidence, evidenceJson, now, existing.id);
    return;
  }

  if (existing.status === 'resolved') {
    reopenIssue(db, existing, input, evidenceJson, now, actor);
    return;
  }

  db.prepare('UPDATE issues SET confidence = ?, evidence_json = ?, last_seen_at = ? WHERE id = ?').run(
    input.confidence,
    evidenceJson,
    now,
    existing.id,
  );
}

/** 关闭 open/acked/ignored 状态的异常；返回是否发生了状态迁移。 */
export function resolveIssue(
  db: Db,
  pathPk: number,
  type: IssueType,
  options: ResolveIssueOptions = {},
): boolean {
  const now = options.now ?? Date.now();
  const resolution = options.resolution ?? 'recovered';
  const actor = options.actor ?? 'system';

  const updated = db
    .prepare(
      `UPDATE issues
          SET status = 'resolved',
              resolved_at = ?,
              last_seen_at = ?,
              resolution = ?
        WHERE path_pk = ?
          AND type = ?
          AND status IN ('open', 'acked', 'ignored')
      RETURNING id`,
    )
    .get(now, now, resolution, pathPk, type) as { id: number } | undefined;
  if (!updated) return false;

  audit(db, actor, 'issue.resolve', `issue:${updated.id}`, { type, resolution }, now);
  return true;
}
