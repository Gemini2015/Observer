import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { bumpManifestEpoch } from './epoch.js';
import { openIssue, resolveIssue } from './issues.js';
import { requireJobForAgent, type JobRow, type MountRow } from './jobs.js';

export type EntryStatus = 'ok' | 'skipped' | 'unreadable' | 'unstable';

export interface ResultEntry {
  path_key: string;
  path_display_b64: string;
  size: number;
  mtime_ns: string;
  hash?: string | null;
  status: EntryStatus;
  skip_reason?: string;
}

export interface ProcessBatchResult {
  accepted: number;
  duplicate: boolean;
  manifest_epoch: number;
}

interface PathRow {
  id: number;
  mount_pk: number;
  path_key: string;
  size: number;
  mtime_ns: string;
  content_hash: string | null;
  last_seen_job_pk: number | null;
  last_seen_at: number | null;
  last_hashed_at: number | null;
  last_hash_kind: 'hash' | 'skip' | null;
  state: 'active' | 'missing' | 'out_of_scope';
  change_epoch: number;
}

export interface BatchContext {
  agent: { id: number; machine_pk: number };
  jobId: number;
  seq: number;
  entries: ResultEntry[];
  now?: number;
}

export function processBatch(db: Db, ctx: BatchContext): ProcessBatchResult {
  const now = ctx.now ?? Date.now();
  const { job, mount } = requireJobForAgent(db, ctx.agent, ctx.jobId);

  if (job.status === 'canceled') {
    throw new HttpError(409, 'job canceled');
  }
  if (job.status !== 'running') {
    throw new HttpError(409, 'job not running', `status=${job.status}`);
  }

  const inserted = db
    .prepare('INSERT OR IGNORE INTO scan_batches (job_pk, seq, received_at) VALUES (?, ?, ?)')
    .run(job.id, ctx.seq, now);

  if (inserted.changes === 0) {
    db.prepare('UPDATE scan_jobs SET lease_until = ? WHERE id = ?').run(now + 60_000, job.id);
    return { accepted: 0, duplicate: true, manifest_epoch: mount.manifest_epoch };
  }

  const apply = db.transaction((): number => {
    const planned = ctx.entries.map((entry) => ({
      entry,
      existing: findPath(db, mount.id, entry.path_key),
    }));

    const needsBump = planned.some(({ entry, existing }) =>
      isManifestAffecting(entry, existing),
    );
    const epoch = needsBump ? bumpManifestEpoch(db, mount.id, now) : mount.manifest_epoch;

    for (const { entry, existing } of planned) {
      applyEntry(db, mount, job, entry, existing, epoch, now);
    }

    return epoch;
  });

  const epoch = apply();
  db.prepare('UPDATE scan_jobs SET lease_until = ? WHERE id = ?').run(now + 60_000, job.id);

  return { accepted: ctx.entries.length, duplicate: false, manifest_epoch: epoch };
}

function findPath(db: Db, mountPk: number, pathKey: string): PathRow | undefined {
  return db
    .prepare('SELECT * FROM paths WHERE mount_pk = ? AND path_key = ?')
    .get(mountPk, pathKey) as PathRow | undefined;
}

/** 是否会产生清单变化（会让 agent 需要重新同步）。 */
function isManifestAffecting(entry: ResultEntry, existing: PathRow | undefined): boolean {
  if (!existing) return true;
  if (existing.state !== 'active') return true;
  if (entry.status === 'ok') return true; // last_hashed_at / content_hash 变化
  return existing.size !== entry.size || existing.mtime_ns !== entry.mtime_ns;
}

function lastObservationHash(db: Db, pathPk: number): string | null {
  const row = db
    .prepare('SELECT hash FROM observations WHERE path_pk = ? ORDER BY observed_at DESC, id DESC LIMIT 1')
    .get(pathPk) as { hash: string } | undefined;
  return row?.hash ?? null;
}

function applyEntry(
  db: Db,
  mount: MountRow,
  job: JobRow,
  entry: ResultEntry,
  existing: PathRow | undefined,
  epoch: number,
  now: number,
): void {
  const display = Buffer.from(entry.path_display_b64, 'base64');
  const wasMissing = existing?.state === 'missing';

  let contentHash = existing?.content_hash ?? null;
  let lastHashedAt = existing?.last_hashed_at ?? null;
  let lastHashKind: 'hash' | 'skip' | null = existing?.last_hash_kind ?? null;

  if (entry.status === 'ok') {
    if (!entry.hash) {
      throw new HttpError(422, 'validation failed', `entry ${entry.path_key}: hash required for ok`);
    }
    const trusted = existing?.content_hash ?? null;
    const observed = entry.hash;
    const rebaseline = job.mode === 'baseline' && trusted !== null && trusted !== observed;

    if (rebaseline) {
      contentHash = observed;
      if (existing) resolveIssue(db, existing.id, 'mismatch', now);
    } else if (trusted === null) {
      contentHash = observed;
    } else if (trusted !== observed) {
      if (!existing) {
        throw new Error(`inconsistent state: trusted hash without path row (${entry.path_key})`);
      }
      const unchangedStat =
        existing.size === entry.size && existing.mtime_ns === entry.mtime_ns;
      openIssue(
        db,
        existing.id,
        mount.id,
        'mismatch',
        unchangedStat ? 'high' : 'medium',
        {
          job_id: job.id,
          trusted_hash: trusted,
          observed_hash: observed,
          size: entry.size,
          mtime_ns: entry.mtime_ns,
          previous_size: existing.size,
          previous_mtime_ns: existing.mtime_ns,
        },
        now,
      );
    } else if (existing) {
      resolveIssue(db, existing.id, 'mismatch', now);
    }

    if (existing) resolveIssue(db, existing.id, 'unreadable', now);
    lastHashedAt = now;
    lastHashKind = 'hash';
  } else if (entry.status === 'unreadable') {
    if (existing) {
      openIssue(db, existing.id, mount.id, 'unreadable', 'medium', { job_id: job.id }, now);
    }
  }

  if (wasMissing && existing) {
    resolveIssue(db, existing.id, 'missing', now);
  }

  if (existing) {
    db.prepare(
      'UPDATE paths SET size = ?, mtime_ns = ?, content_hash = ?, last_seen_job_pk = ?, last_seen_at = ?, last_hashed_at = ?, last_hash_kind = ?, state = ?, change_epoch = ?, updated_at = ? WHERE id = ?',
    ).run(
      entry.size,
      entry.mtime_ns,
      contentHash,
      job.id,
      now,
      lastHashedAt,
      lastHashKind,
      'active',
      isManifestAffecting(entry, existing) ? epoch : existing.change_epoch,
      now,
      existing.id,
    );

    if (entry.status === 'ok' && entry.hash && lastObservationHash(db, existing.id) !== entry.hash) {
      db.prepare(
        'INSERT INTO observations (path_pk, hash, algo, kind, observed_at) VALUES (?, ?, ?, ?, ?)',
      ).run(existing.id, entry.hash, 'sha256', job.mode === 'baseline' ? 'baseline' : 'scan', now);
    }
    return;
  }

  const info = db
    .prepare(
      'INSERT INTO paths (mount_pk, path_key, path_display, size, mtime_ns, content_hash, last_seen_job_pk, last_seen_at, last_hashed_at, last_hash_kind, state, change_epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      mount.id,
      entry.path_key,
      display,
      entry.size,
      entry.mtime_ns,
      contentHash,
      job.id,
      now,
      lastHashedAt,
      lastHashKind,
      'active',
      epoch,
      now,
    );
  const pathPk = Number(info.lastInsertRowid);

  if (entry.status === 'ok' && entry.hash) {
    db.prepare(
      'INSERT INTO observations (path_pk, hash, algo, kind, observed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(pathPk, entry.hash, 'sha256', job.mode === 'baseline' ? 'baseline' : 'scan', now);
  }
}
