import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { getIssueRepairContext } from './replicas.js';

export interface IssueActionOptions {
  now?: number;
  actor?: string;
}

export interface RebaselineResult {
  ok: true;
  baseline_hash: string;
}

function requireContext(db: Db, issueId: number) {
  const context = getIssueRepairContext(db, issueId);
  if (!context) throw new HttpError(404, 'issue not found');
  return context;
}

/**
 * 忽略当前异常。
 * mismatch：记录本次观测 hash（ignored_hash），后续只有同一 hash 会被静默。
 * missing/unreadable：不记录 hash，状态持续期间保持 ignored。
 */
export function ignoreIssue(
  db: Db,
  issueId: number,
  observedHash: string | null,
  options: IssueActionOptions = {},
): void {
  const now = options.now ?? Date.now();
  const actor = options.actor ?? 'user';
  const context = requireContext(db, issueId);

  if (context.issueStatus !== 'open') {
    throw new HttpError(409, 'issue is not open');
  }

  let ignoredHash: string | null = null;
  if (context.issueType === 'mismatch') {
    if (!observedHash) throw new HttpError(409, 'observed hash is required');
    if (!context.observedHash || context.observedHash !== observedHash) {
      throw new HttpError(409, 'observed hash changed');
    }
    ignoredHash = observedHash;
  }

  db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE issues
            SET status = 'ignored',
                ignored_hash = ?,
                ignored_at = ?,
                resolution = NULL,
                resolved_at = NULL
          WHERE id = ? AND status = 'open'
        RETURNING id`,
      )
      .get(ignoredHash, now, issueId) as { id: number } | undefined;
    if (!updated) throw new HttpError(409, 'issue is not open');

    audit(
      db,
      actor,
      'issue.ignore',
      `issue:${issueId}`,
      { type: context.issueType, ignored_hash: ignoredHash },
      now,
    );
  })();
}

/**
 * 接受最近一次观测到的 hash 为新基线，并关闭异常。
 * 只作用于当前 path；不自动同步其它机器。
 */
export function rebaselineIssue(
  db: Db,
  issueId: number,
  observedHash: string,
  options: IssueActionOptions = {},
): RebaselineResult {
  const now = options.now ?? Date.now();
  const actor = options.actor ?? 'user';
  const context = requireContext(db, issueId);

  if (context.issueType !== 'mismatch') {
    throw new HttpError(409, 'issue type is not rebaselinable');
  }
  if (context.issueStatus !== 'open' && context.issueStatus !== 'ignored') {
    throw new HttpError(409, 'issue is not open');
  }
  if (!context.observedHash || context.observedHash !== observedHash) {
    throw new HttpError(409, 'observed hash changed');
  }
  if (!context.trustedHash) {
    throw new HttpError(409, 'issue has no trusted hash');
  }
  if (context.trustedHash !== context.expectedHash) {
    throw new HttpError(409, 'baseline changed');
  }
  if (context.targetState !== 'active') {
    throw new HttpError(409, 'target path is not active');
  }
  if (context.repairActive) {
    throw new HttpError(409, 'repair already in progress');
  }

  return db.transaction((): RebaselineResult => {
    const pathUpdate = db
      .prepare(
        `UPDATE paths
            SET content_hash = ?, updated_at = ?
          WHERE id = ? AND content_hash = ? AND state = 'active'`,
      )
      .run(observedHash, now, context.targetPathPk, context.expectedHash);
    if (pathUpdate.changes === 0) {
      throw new HttpError(409, 'baseline changed');
    }

    db.prepare(
      "INSERT INTO observations (path_pk, hash, algo, kind, observed_at) VALUES (?, ?, 'sha256', 'baseline', ?)",
    ).run(context.targetPathPk, observedHash, now);

    const issueUpdate = db
      .prepare(
        `UPDATE issues
            SET status = 'resolved', resolved_at = ?, resolution = 'rebaselined'
          WHERE id = ? AND status IN ('open', 'ignored')
        RETURNING id`,
      )
      .get(now, issueId) as { id: number } | undefined;
    if (!issueUpdate) {
      throw new HttpError(409, 'issue is not open');
    }

    audit(
      db,
      actor,
      'issue.rebaseline',
      `issue:${issueId}`,
      {
        type: context.issueType,
        resolution: 'rebaselined',
        old_hash: context.trustedHash,
        new_hash: observedHash,
        path_pk: context.targetPathPk,
      },
      now,
    );

    return { ok: true, baseline_hash: observedHash };
  })();
}

/** 取消忽略：ignored -> open；保留 ignored_hash/ignored_at 作为“上次忽略”记录。 */
export function unignoreIssue(
  db: Db,
  issueId: number,
  options: IssueActionOptions = {},
): void {
  const now = options.now ?? Date.now();
  const actor = options.actor ?? 'user';
  const context = requireContext(db, issueId);

  if (context.issueStatus !== 'ignored') {
    throw new HttpError(409, 'issue is not ignored');
  }

  db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE issues
            SET status = 'open', resolution = NULL, resolved_at = NULL
          WHERE id = ? AND status = 'ignored'
        RETURNING id`,
      )
      .get(issueId) as { id: number } | undefined;
    if (!updated) throw new HttpError(409, 'issue is not ignored');

    audit(db, actor, 'issue.unignore', `issue:${issueId}`, {
      type: context.issueType,
      ignored_hash: context.ignoredHash,
    }, now);
  })();
}
