import type { Db } from '../db/index.js';

export interface IssueRepairContext {
  issueId: number;
  issueType: 'mismatch' | 'missing' | 'unreadable';
  issueStatus: string;
  confidence: string;
  evidence: Record<string, unknown> | null;
  targetPathPk: number;
  targetMountPk: number;
  targetMountId: string;
  targetMachinePk: number;
  targetMachineId: string;
  targetPathKey: string;
  targetState: string;
  targetSize: number;
  expectedHash: string | null;
  observedHash: string | null;
  repairAllowed: boolean;
}

export interface ReplicaCandidate {
  path_id: number;
  machine_id: string;
  mount_id: string;
  mount_pk: number;
  path_key: string;
  size: number;
  last_hashed_at: number | null;
  confidence: 'high' | 'medium' | 'low';
}

interface IssueRow {
  issue_id: number;
  type: 'mismatch' | 'missing' | 'unreadable';
  status: string;
  confidence: string;
  evidence_json: string | null;
  target_path_pk: number;
  target_path_key: string;
  target_state: string;
  target_size: number;
  target_hash: string | null;
  mount_pk: number;
  mount_id: string;
  repair_allowed: number;
  machine_pk: number;
  machine_id: string;
}

export function getIssueRepairContext(db: Db, issueId: number): IssueRepairContext | undefined {
  const row = db
    .prepare(
      `SELECT i.id AS issue_id, i.type, i.status, i.confidence, i.evidence_json,
              p.id AS target_path_pk, p.path_key AS target_path_key, p.state AS target_state,
              p.size AS target_size, p.content_hash AS target_hash,
              m.id AS mount_pk, m.mount_id, m.repair_allowed,
              mc.id AS machine_pk, mc.machine_id
       FROM issues i
       JOIN paths p ON p.id = i.path_pk
       JOIN mounts m ON m.id = i.mount_pk
       JOIN machines mc ON mc.id = m.machine_pk
       WHERE i.id = ?`,
    )
    .get(issueId) as IssueRow | undefined;
  if (!row) return undefined;

  let evidence: Record<string, unknown> | null = null;
  if (row.evidence_json) {
    try {
      const parsed = JSON.parse(row.evidence_json) as unknown;
      if (parsed && typeof parsed === 'object') evidence = parsed as Record<string, unknown>;
    } catch {
      evidence = null;
    }
  }
  const observed = evidence && typeof evidence.observed_hash === 'string' ? evidence.observed_hash : null;

  return {
    issueId: row.issue_id,
    issueType: row.type,
    issueStatus: row.status,
    confidence: row.confidence,
    evidence,
    targetPathPk: row.target_path_pk,
    targetMountPk: row.mount_pk,
    targetMountId: row.mount_id,
    targetMachinePk: row.machine_pk,
    targetMachineId: row.machine_id,
    targetPathKey: row.target_path_key,
    targetState: row.target_state,
    targetSize: row.target_size,
    expectedHash: row.target_hash,
    observedHash: observed,
    repairAllowed: row.repair_allowed === 1,
  };
}

interface ReplicaRow {
  path_id: number;
  machine_id: string;
  mount_id: string;
  mount_pk: number;
  path_key: string;
  size: number;
  last_hashed_at: number | null;
}

const DAY = 86_400_000;

/** 副本判定：内容哈希全等（技术方案 T7），且必须来自其它机器。 */
export function listReplicas(db: Db, issueId: number, now: number = Date.now()): ReplicaCandidate[] {
  const context = getIssueRepairContext(db, issueId);
  if (!context || !context.expectedHash) return [];

  const rows = db
    .prepare(
      `SELECT p.id AS path_id, p.path_key, p.size, p.last_hashed_at,
              m.id AS mount_pk, m.mount_id, mc.machine_id
       FROM paths p
       JOIN mounts m ON m.id = p.mount_pk
       JOIN machines mc ON mc.id = m.machine_pk
       WHERE p.content_hash = ?
         AND p.state = 'active'
         AND p.last_hash_kind = 'hash'
         AND p.id != ?
         AND mc.id != ?
       ORDER BY p.last_hashed_at DESC
       LIMIT 50`,
    )
    .all(context.expectedHash, context.targetPathPk, context.targetMachinePk) as ReplicaRow[];

  return rows.map((row) => {
    let confidence: ReplicaCandidate['confidence'] = 'low';
    if (row.last_hashed_at !== null) {
      const age = now - row.last_hashed_at;
      confidence = age <= 7 * DAY ? 'high' : age <= 30 * DAY ? 'medium' : 'low';
    }
    return {
      path_id: row.path_id,
      machine_id: row.machine_id,
      mount_id: row.mount_id,
      mount_pk: row.mount_pk,
      path_key: row.path_key,
      size: row.size,
      last_hashed_at: row.last_hashed_at,
      confidence,
    };
  });
}
