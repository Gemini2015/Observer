import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { audit } from './audit.js';
import { bumpManifestEpoch } from './epoch.js';
import { resolveIssue } from './issues.js';
import { getIssueRepairContext } from './replicas.js';

export const REPAIR_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_REPAIR_BYTES = 1024 * 1024 * 1024;
export const TRANSFER_CHUNK = 1024 * 1024;

export interface AgentRef {
  id: number;
  machine_pk: number;
}

interface RepairLoadRow {
  id: number;
  issue_pk: number;
  source_path_pk: number;
  target_path_pk: number;
  expected_hash: string;
  observed_hash: string | null;
  status: string;
  error: string | null;
  quarantine_path: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  target_mount_pk: number;
  target_mount_id: string;
  target_machine_pk: number;
  target_machine_id: string;
  target_path_key: string;
  target_state: string;
  target_size: number;
}

interface RepairViewRow extends RepairLoadRow {
  source_mount_id: string;
  source_machine_id: string;
  source_path_key: string;
  source_size: number;
  ticket_id: number;
  ticket_status: string;
  ticket_size: number;
  bytes_received: number;
  expires_at: number;
}

export interface RepairView {
  id: number;
  issue_id: number;
  status: string;
  expected_hash: string;
  observed_hash: string | null;
  error: string | null;
  quarantine_path: string | null;
  source: {
    path_id: number;
    machine_id: string;
    mount_id: string;
    path_key: string;
    size: number;
  };
  target: {
    path_id: number;
    machine_id: string;
    mount_id: string;
    path_key: string;
    state: string;
    size: number;
  };
  transfer: {
    id: number;
    status: string;
    size: number;
    bytes_received: number;
    expires_at: number;
  };
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const REPAIR_VIEW_SELECT = `
  SELECT r.*,
         tm.id AS target_mount_pk, tm.mount_id AS target_mount_id,
         tmc.id AS target_machine_pk, tmc.machine_id AS target_machine_id,
         tp.path_key AS target_path_key, tp.state AS target_state, tp.size AS target_size,
         sm.mount_id AS source_mount_id, smc.machine_id AS source_machine_id,
         sp.path_key AS source_path_key, sp.size AS source_size,
         t.id AS ticket_id, t.status AS ticket_status, t.size AS ticket_size,
         t.bytes_received, t.expires_at
  FROM repair_jobs r
  JOIN paths tp ON tp.id = r.target_path_pk
  JOIN mounts tm ON tm.id = tp.mount_pk
  JOIN machines tmc ON tmc.id = tm.machine_pk
  JOIN paths sp ON sp.id = r.source_path_pk
  JOIN mounts sm ON sm.id = sp.mount_pk
  JOIN machines smc ON smc.id = sm.machine_pk
  JOIN transfer_tickets t ON t.repair_pk = r.id
`;

function toView(row: RepairViewRow): RepairView {
  return {
    id: row.id,
    issue_id: row.issue_pk,
    status: row.status,
    expected_hash: row.expected_hash,
    observed_hash: row.observed_hash,
    error: row.error,
    quarantine_path: row.quarantine_path,
    source: {
      path_id: row.source_path_pk,
      machine_id: row.source_machine_id,
      mount_id: row.source_mount_id,
      path_key: row.source_path_key,
      size: row.source_size,
    },
    target: {
      path_id: row.target_path_pk,
      machine_id: row.target_machine_id,
      mount_id: row.target_mount_id,
      path_key: row.target_path_key,
      state: row.target_state,
      size: row.target_size,
    },
    transfer: {
      id: row.ticket_id,
      status: row.ticket_status,
      size: row.ticket_size,
      bytes_received: row.bytes_received,
      expires_at: row.expires_at,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

export function getRepair(db: Db, repairId: number): RepairView | undefined {
  const row = db.prepare(`${REPAIR_VIEW_SELECT} WHERE r.id = ?`).get(repairId) as
    | RepairViewRow
    | undefined;
  return row ? toView(row) : undefined;
}

export function listRepairs(db: Db, limit = 100): RepairView[] {
  const rows = db
    .prepare(`${REPAIR_VIEW_SELECT} ORDER BY r.id DESC LIMIT ?`)
    .all(limit) as RepairViewRow[];
  return rows.map(toView);
}

function activeRepairExists(db: Db, issuePk: number): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM repair_jobs WHERE issue_pk = ? AND status IN ('pending','transferring','ready','applying') LIMIT 1",
      )
      .get(issuePk) !== undefined
  );
}

interface SourcePathRow {
  id: number;
  mount_pk: number;
  path_key: string;
  size: number;
  content_hash: string | null;
  state: string;
  last_hash_kind: string | null;
  machine_pk: number;
  mount_id: string;
  mount_state: string;
  machine_status: string;
}

function loadSourcePath(db: Db, pathId: number): SourcePathRow | undefined {
  return db
    .prepare(
      `SELECT p.id, p.mount_pk, p.path_key, p.size, p.content_hash, p.state, p.last_hash_kind,
              m.machine_pk, m.mount_id, m.state AS mount_state, mc.status AS machine_status
       FROM paths p
       JOIN mounts m ON m.id = p.mount_pk
       JOIN machines mc ON mc.id = m.machine_pk
       WHERE p.id = ?`,
    )
    .get(pathId) as SourcePathRow | undefined;
}

export interface CreateRepairOptions {
  transfersDir: string;
  maxBytes?: number;
  ttlMs?: number;
  now?: number;
}

export interface CreateRepairResult {
  repair_id: number;
  transfer_id: number;
}

export function createRepair(
  db: Db,
  issueId: number,
  sourcePathId: number,
  options: CreateRepairOptions,
): CreateRepairResult {
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REPAIR_BYTES;
  const ttlMs = options.ttlMs ?? REPAIR_TTL_MS;

  const context = getIssueRepairContext(db, issueId);
  if (!context) throw new HttpError(404, 'issue not found');
  if (context.issueStatus !== 'open' && context.issueStatus !== 'acked') {
    throw new HttpError(409, 'issue is not open');
  }
  if (context.issueType !== 'mismatch' && context.issueType !== 'missing') {
    throw new HttpError(409, 'issue type is not repairable');
  }
  if (!context.repairAllowed) {
    throw new HttpError(403, 'repair is not allowed on target mount');
  }
  if (!context.expectedHash) {
    throw new HttpError(409, 'issue has no trusted hash');
  }
  if (activeRepairExists(db, issueId)) {
    throw new HttpError(409, 'repair already in progress');
  }

  const source = loadSourcePath(db, sourcePathId);
  if (!source) throw new HttpError(404, 'source path not found');
  if (source.machine_pk === context.targetMachinePk) {
    throw new HttpError(409, 'source and target must be different machines');
  }
  if (source.state !== 'active' || source.mount_state !== 'active' || source.machine_status !== 'online') {
    throw new HttpError(409, 'source replica is not available');
  }
  if (source.last_hash_kind !== 'hash' || source.content_hash !== context.expectedHash) {
    throw new HttpError(409, 'source replica hash does not match trusted hash');
  }
  if (source.size <= 0 || source.size > maxBytes) {
    throw new HttpError(422, 'source file size is not repairable');
  }

  const targetMount = db
    .prepare('SELECT state FROM mounts WHERE id = ?')
    .get(context.targetMountPk) as { state: string } | undefined;
  if (!targetMount || targetMount.state !== 'active') {
    throw new HttpError(409, 'target mount is not active');
  }
  const targetMachine = db
    .prepare('SELECT status FROM machines WHERE id = ?')
    .get(context.targetMachinePk) as { status: string } | undefined;
  if (!targetMachine || targetMachine.status !== 'online') {
    throw new HttpError(409, 'target machine is offline');
  }

  const tx = db.transaction(() => {
    const repairInfo = db
      .prepare(
        `INSERT INTO repair_jobs (issue_pk, source_path_pk, target_path_pk, expected_hash, observed_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        context.issueId,
        source.id,
        context.targetPathPk,
        context.expectedHash,
        context.observedHash,
        now,
        now,
      );
    const repairId = Number(repairInfo.lastInsertRowid);
    const ticketInfo = db
      .prepare(
        `INSERT INTO transfer_tickets (repair_pk, source_path_pk, expected_hash, size, status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(repairId, source.id, context.expectedHash, source.size, now, now + ttlMs, now);
    return { repairId, transferId: Number(ticketInfo.lastInsertRowid) };
  });
  const created = tx();

  audit(db, 'user', 'repair.create', `issue:${issueId}`, {
    repair_id: created.repairId,
    transfer_id: created.transferId,
    source_path_id: source.id,
    target_path_id: context.targetPathPk,
    expected_hash: context.expectedHash,
  }, now);

  return { repair_id: created.repairId, transfer_id: created.transferId };
}

export function cancelRepair(db: Db, repairId: number, transfersDir: string, now: number = Date.now()): RepairView {
  const row = db.prepare('SELECT * FROM repair_jobs WHERE id = ?').get(repairId) as
    | { id: number; status: string }
    | undefined;
  if (!row) throw new HttpError(404, 'repair not found');
  if (!['pending', 'transferring', 'ready'].includes(row.status)) {
    throw new HttpError(409, 'repair cannot be canceled in current status');
  }
  db.prepare(
    "UPDATE repair_jobs SET status = 'canceled', error = 'canceled by user', updated_at = ?, finished_at = ? WHERE id = ?",
  ).run(now, now, repairId);
  const ticket = db
    .prepare('SELECT id FROM transfer_tickets WHERE repair_pk = ?')
    .get(repairId) as { id: number } | undefined;
  if (ticket) {
    db.prepare("UPDATE transfer_tickets SET status = 'expired', error = 'canceled', updated_at = ? WHERE id = ?").run(
      now,
      ticket.id,
    );
    removePart(transfersDir, ticket.id);
  }
  audit(db, 'user', 'repair.cancel', `repair:${repairId}`, { status: row.status }, now);
  return getRepair(db, repairId) as RepairView;
}

function transfersRoot(transfersDir: string): string {
  fs.mkdirSync(transfersDir, { recursive: true });
  return transfersDir;
}

export function partPath(transfersDir: string, ticketId: number): string {
  return path.join(transfersRoot(transfersDir), `${ticketId}.part`);
}

/** 修复中转目录：<dataDir>/transfers */
export function transfersPath(dataDir: string): string {
  return path.join(dataDir, 'transfers');
}

function removePart(transfersDir: string, ticketId: number): void {
  fs.rmSync(partPath(transfersDir, ticketId), { force: true });
}

export interface TransferTask {
  ticket_id: number;
  repair_id: number;
  mount_id: string;
  path_key: string;
  size: number;
  expected_hash: string;
  offset: number;
  status: string;
}

export function agentTransferTasks(db: Db, machinePk: number): TransferTask[] {
  return db
    .prepare(
      `SELECT t.id AS ticket_id, t.repair_pk AS repair_id, t.size, t.expected_hash,
              t.bytes_received AS offset, t.status, m.mount_id, p.path_key
       FROM transfer_tickets t
       JOIN repair_jobs r ON r.id = t.repair_pk
       JOIN paths p ON p.id = t.source_path_pk
       JOIN mounts m ON m.id = p.mount_pk
       WHERE m.machine_pk = ? AND t.status = 'pending' AND r.status IN ('pending','transferring')
       ORDER BY t.id
       LIMIT 1`,
    )
    .all(machinePk) as TransferTask[];
}

export interface RepairTask {
  repair_id: number;
  ticket_id: number;
  mount_id: string;
  path_key: string;
  size: number;
  expected_hash: string;
  observed_hash: string | null;
  target_state: string;
}

export function agentRepairTasks(db: Db, machinePk: number): RepairTask[] {
  return db
    .prepare(
      `SELECT r.id AS repair_id, t.id AS ticket_id, m.mount_id, p.path_key, t.size,
              r.expected_hash, r.observed_hash, p.state AS target_state
       FROM repair_jobs r
       JOIN transfer_tickets t ON t.repair_pk = r.id
       JOIN paths p ON p.id = r.target_path_pk
       JOIN mounts m ON m.id = p.mount_pk
       WHERE m.machine_pk = ? AND t.status = 'ready' AND r.status IN ('ready','applying')
       ORDER BY r.id
       LIMIT 1`,
    )
    .all(machinePk) as RepairTask[];
}

function loadTransferForSource(
  db: Db,
  transferId: number,
): (TransferTicketRow & { source_machine_pk: number; repair_status: string }) | undefined {
  return db
    .prepare(
      `SELECT t.*, m.machine_pk AS source_machine_pk, r.status AS repair_status
       FROM transfer_tickets t
       JOIN repair_jobs r ON r.id = t.repair_pk
       JOIN paths p ON p.id = t.source_path_pk
       JOIN mounts m ON m.id = p.mount_pk
       WHERE t.id = ?`,
    )
    .get(transferId) as
    | (TransferTicketRow & { source_machine_pk: number; repair_status: string })
    | undefined;
}

interface TransferTicketRow {
  id: number;
  repair_pk: number;
  source_path_pk: number;
  expected_hash: string;
  size: number;
  status: string;
  bytes_received: number;
  error: string | null;
  expires_at: number;
}

export interface AppendResult {
  bytes_received: number;
  size: number;
  status: string;
  error: string | null;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function appendTransferChunk(
  db: Db,
  agent: AgentRef,
  transferId: number,
  offset: number,
  data: Buffer,
  transfersDir: string,
  now: number = Date.now(),
): AppendResult {
  const ticket = loadTransferForSource(db, transferId);
  if (!ticket) throw new HttpError(404, 'transfer not found');
  if (ticket.source_machine_pk !== agent.machine_pk) {
    throw new HttpError(403, 'transfer belongs to another machine');
  }
  if (ticket.status === 'ready') {
    return { bytes_received: ticket.bytes_received, size: ticket.size, status: ticket.status, error: null };
  }
  if (ticket.status !== 'pending') throw new HttpError(410, 'transfer is not uploadable');
  if (ticket.expires_at < now) {
    expireTransfer(db, ticket, transfersDir, now);
    throw new HttpError(410, 'transfer expired');
  }
  if (offset !== ticket.bytes_received) {
    throw new HttpError(409, 'offset mismatch', `expected ${ticket.bytes_received}`);
  }
  if (data.length === 0 || data.length > TRANSFER_CHUNK) {
    throw new HttpError(422, 'invalid chunk size');
  }
  if (ticket.bytes_received + data.length > ticket.size) {
    throw new HttpError(422, 'chunk exceeds expected size');
  }

  const filePath = partPath(transfersDir, ticket.id);
  const fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'r+' : 'w+');
  try {
    fs.writeSync(fd, data, 0, data.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const received = offset + data.length;
  let status = ticket.status;
  let error: string | null = null;

  if (received === ticket.size) {
    let actualHash = '';
    try {
      actualHash = hashFile(filePath);
    } catch {
      actualHash = '';
    }
    if (actualHash === ticket.expected_hash) {
      status = 'ready';
    } else {
      status = 'failed';
      error = 'source file hash mismatch';
      removePart(transfersDir, ticket.id);
    }
  }

  db.transaction(() => {
    db.prepare(
      'UPDATE transfer_tickets SET bytes_received = ?, status = ?, error = ?, updated_at = ? WHERE id = ?',
    ).run(received, status, error, now, ticket.id);
    if (status === 'ready') {
      db.prepare(
        "UPDATE repair_jobs SET status = 'ready', updated_at = ? WHERE id = ? AND status IN ('pending','transferring')",
      ).run(now, ticket.repair_pk);
      audit(db, 'system', 'transfer.ready', `transfer:${ticket.id}`, {
        repair_id: ticket.repair_pk,
        size: ticket.size,
      }, now);
    } else if (status === 'failed') {
      db.prepare(
        "UPDATE repair_jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      ).run(error, now, now, ticket.repair_pk);
      audit(db, 'system', 'transfer.failed', `transfer:${ticket.id}`, {
        repair_id: ticket.repair_pk,
        error,
      }, now);
    } else if (ticket.repair_status === 'pending') {
      db.prepare("UPDATE repair_jobs SET status = 'transferring', updated_at = ? WHERE id = ?").run(
        now,
        ticket.repair_pk,
      );
    }
  })();

  return { bytes_received: received, size: ticket.size, status, error };
}

interface TargetTicketRow extends TransferTicketRow {
  repair_id: number;
  repair_status: string;
  target_machine_pk: number;
}

function loadTransferForTarget(db: Db, transferId: number): TargetTicketRow | undefined {
  return db
    .prepare(
      `SELECT t.*, r.id AS repair_id, r.status AS repair_status, m.machine_pk AS target_machine_pk
       FROM transfer_tickets t
       JOIN repair_jobs r ON r.id = t.repair_pk
       JOIN paths p ON p.id = r.target_path_pk
       JOIN mounts m ON m.id = p.mount_pk
       WHERE t.id = ?`,
    )
    .get(transferId) as TargetTicketRow | undefined;
}

export interface TransferChunk {
  data: Buffer;
  total: number;
  status: string;
}

export function readTransferChunk(
  db: Db,
  agent: AgentRef,
  transferId: number,
  offset: number,
  transfersDir: string,
): TransferChunk {
  const ticket = loadTransferForTarget(db, transferId);
  if (!ticket) throw new HttpError(404, 'transfer not found');
  if (ticket.target_machine_pk !== agent.machine_pk) {
    throw new HttpError(403, 'transfer belongs to another machine');
  }
  if (ticket.status !== 'ready') throw new HttpError(410, 'transfer is not downloadable');
  if (ticket.repair_status === 'ready') {
    db.prepare("UPDATE repair_jobs SET status = 'applying', updated_at = ? WHERE id = ?").run(
      Date.now(),
      ticket.repair_id,
    );
  } else if (ticket.repair_status !== 'applying') {
    throw new HttpError(409, 'repair is not applicable');
  }
  if (offset >= ticket.size) {
    throw new HttpError(416, 'offset out of range');
  }
  const filePath = partPath(transfersDir, ticket.id);
  const length = Math.min(TRANSFER_CHUNK, ticket.size - offset);
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, buffer, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  if (read <= 0) throw new HttpError(416, 'offset out of range');
  return { data: buffer.subarray(0, read), total: ticket.size, status: ticket.status };
}

export function failTransfer(
  db: Db,
  agent: AgentRef,
  transferId: number,
  reason: string,
  transfersDir: string,
  now: number = Date.now(),
): void {
  const ticket = loadTransferForSource(db, transferId);
  if (!ticket) throw new HttpError(404, 'transfer not found');
  if (ticket.source_machine_pk !== agent.machine_pk) {
    throw new HttpError(403, 'transfer belongs to another machine');
  }
  if (ticket.status === 'failed' || ticket.status === 'expired') return;
  db.transaction(() => {
    db.prepare("UPDATE transfer_tickets SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
      reason.slice(0, 500),
      now,
      ticket.id,
    );
    db.prepare(
      "UPDATE repair_jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('pending','transferring','ready')",
    ).run(reason.slice(0, 500), now, now, ticket.repair_pk);
    audit(db, 'system', 'transfer.failed', `transfer:${ticket.id}`, {
      repair_id: ticket.repair_pk,
      error: reason.slice(0, 500),
    }, now);
  })();
  removePart(transfersDir, ticket.id);
}

export interface RepairResultInput {
  success: boolean;
  error?: string;
  hash?: string;
  size?: number;
  mtime_ns?: string;
}

export function reportRepairResult(
  db: Db,
  agent: AgentRef,
  repairId: number,
  input: RepairResultInput,
  transfersDir: string,
  now: number = Date.now(),
): RepairView {
  const row = db
    .prepare(
      `SELECT r.*, m.id AS target_mount_pk, m.machine_pk AS target_machine_pk,
              p.state AS target_state, p.size AS target_size
       FROM repair_jobs r
       JOIN paths p ON p.id = r.target_path_pk
       JOIN mounts m ON m.id = p.mount_pk
       WHERE r.id = ?`,
    )
    .get(repairId) as
    | (RepairLoadRow & { target_machine_pk: number; target_state: string; target_size: number })
    | undefined;
  if (!row) throw new HttpError(404, 'repair not found');
  if (row.target_machine_pk !== agent.machine_pk) {
    throw new HttpError(403, 'repair belongs to another machine');
  }
  if (row.status !== 'ready' && row.status !== 'applying') {
    throw new HttpError(409, 'repair is not applicable');
  }
  const ticket = db
    .prepare('SELECT id FROM transfer_tickets WHERE repair_pk = ?')
    .get(repairId) as { id: number } | undefined;

  if (!input.success) {
    db.transaction(() => {
      db.prepare(
        "UPDATE repair_jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      ).run((input.error ?? 'repair failed').slice(0, 500), now, now, repairId);
      if (ticket) {
        db.prepare("UPDATE transfer_tickets SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          (input.error ?? 'repair failed').slice(0, 500),
          now,
          ticket.id,
        );
      }
      audit(db, 'system', 'repair.failed', `repair:${repairId}`, {
        error: (input.error ?? 'repair failed').slice(0, 500),
      }, now);
    })();
    if (ticket) removePart(transfersDir, ticket.id);
    return getRepair(db, repairId) as RepairView;
  }

  if (input.hash !== row.expected_hash) {
    throw new HttpError(409, 'reported hash does not match expected hash');
  }

  db.transaction(() => {
    const epoch = bumpManifestEpoch(db, row.target_mount_pk, now);
    db.prepare(
      `UPDATE paths SET content_hash = ?, size = ?, mtime_ns = COALESCE(?, mtime_ns), state = 'active',
              last_hashed_at = ?, last_hash_kind = 'hash', change_epoch = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      row.expected_hash,
      input.size ?? row.target_size,
      input.mtime_ns ?? null,
      now,
      epoch,
      now,
      row.target_path_pk,
    );
    db.prepare(
      "INSERT INTO observations (path_pk, hash, algo, kind, observed_at) VALUES (?, ?, 'sha256', 'repair', ?)",
    ).run(row.target_path_pk, row.expected_hash, now);
    resolveIssue(db, row.target_path_pk, 'mismatch', now);
    resolveIssue(db, row.target_path_pk, 'missing', now);
    db.prepare(
      "UPDATE repair_jobs SET status = 'completed', error = NULL, quarantine_path = NULL, updated_at = ?, finished_at = ? WHERE id = ?",
    ).run(now, now, repairId);
    if (ticket) {
      db.prepare("UPDATE transfer_tickets SET status = 'completed', updated_at = ? WHERE id = ?").run(now, ticket.id);
    }
    audit(db, 'system', 'repair.complete', `repair:${repairId}`, {
      target_path_id: row.target_path_pk,
      hash: row.expected_hash,
      size: input.size ?? null,
    }, now);
  })();
  if (ticket) removePart(transfersDir, ticket.id);
  return getRepair(db, repairId) as RepairView;
}

function expireTransfer(db: Db, ticket: TransferTicketRow, transfersDir: string, now: number): void {
  db.prepare("UPDATE transfer_tickets SET status = 'expired', error = 'expired', updated_at = ? WHERE id = ?").run(
    now,
    ticket.id,
  );
  db.prepare(
    "UPDATE repair_jobs SET status = 'failed', error = 'transfer expired', updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('pending','transferring','ready')",
  ).run(now, now, ticket.repair_pk);
  audit(db, 'system', 'repair.expired', `repair:${ticket.repair_pk}`, { transfer_id: ticket.id }, now);
  removePart(transfersDir, ticket.id);
}

/** 由 scheduler tick 调用：过期票据/修复标记失败并清理临时文件。 */
export function expireRepairs(db: Db, transfersDir: string, now: number = Date.now()): number {
  const rows = db
    .prepare(
      "SELECT * FROM transfer_tickets WHERE status IN ('pending','ready') AND expires_at < ?",
    )
    .all(now) as TransferTicketRow[];
  for (const ticket of rows) {
    expireTransfer(db, ticket, transfersDir, now);
  }
  return rows.length;
}
