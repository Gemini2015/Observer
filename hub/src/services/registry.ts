import type { Db } from '../db/index.js';
import { audit } from './audit.js';
import { HttpError } from '../http/errors.js';
import { randomToken, sha256Hex } from '../util/crypto.js';

export interface MountEnrollInput {
  mount_id: string;
  label?: string;
  physical_path: string;
  sentinel?: string | null;
  fs_kind: 'local' | 'network' | 'removable' | 'fuse';
  case_sensitive: 'auto' | 'true' | 'false';
  unicode: 'auto' | 'nfc' | 'nfd';
  include: string[];
  exclude: string[];
  rules_hash: string;
  limits: Record<string, unknown>;
  schedule: Record<string, unknown>;
  repair_allowed: boolean;
}

export interface EnrollInput {
  machine_id: string;
  label?: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  agent_version?: string;
  mounts: MountEnrollInput[];
}

export interface AgentRow {
  id: number;
  machine_pk: number;
  token_hash: string;
  version: string | null;
  protocol: number;
  capabilities_json: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface MachineRow {
  id: number;
  machine_id: string;
  label: string | null;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  created_at: number;
  last_seen_at: number | null;
  status: string;
}

export interface MountRow {
  id: number;
  mount_id: string;
  manifest_epoch: number;
}

export interface EnrollResult {
  agentId: number;
  token: string;
  machinePk: number;
  mounts: Array<{ id: number; mount_id: string; manifest_epoch: number }>;
}

function upsertMachine(db: Db, input: EnrollInput, now: number): number {
  const existing = db
    .prepare('SELECT * FROM machines WHERE machine_id = ?')
    .get(input.machine_id) as MachineRow | undefined;

  if (existing) {
    db.prepare(
      'UPDATE machines SET label = COALESCE(?, label), hostname = COALESCE(?, hostname), platform = COALESCE(?, platform), arch = COALESCE(?, arch), last_seen_at = ?, status = ? WHERE id = ?',
    ).run(
      input.label ?? null,
      input.hostname ?? null,
      input.platform ?? null,
      input.arch ?? null,
      now,
      'online',
      existing.id,
    );
    return existing.id;
  }

  const info = db
    .prepare(
      'INSERT INTO machines (machine_id, label, hostname, platform, arch, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.machine_id,
      input.label ?? null,
      input.hostname ?? null,
      input.platform ?? null,
      input.arch ?? null,
      now,
      now,
      'online',
    );
  return Number(info.lastInsertRowid);
}

export function enrollAgent(
  db: Db,
  input: EnrollInput,
  enrollTokenPk: number,
  now: number = Date.now(),
): EnrollResult {
  const run = db.transaction((): EnrollResult => {
    const machinePk = upsertMachine(db, input, now);

    const ids = input.mounts.map((mount) => mount.mount_id);
    const placeholders = ids.map(() => '?').join(',');
    const conflicts = db
      .prepare(
        `SELECT mount_id FROM mounts WHERE machine_pk = ? AND mount_id IN (${placeholders})`,
      )
      .all(machinePk, ...ids) as Array<{ mount_id: string }>;
    if (conflicts.length > 0) {
      throw new HttpError(
        409,
        'mount conflict',
        `mount already registered: ${conflicts.map((row) => row.mount_id).join(', ')}`,
      );
    }

    const token = randomToken(32);
    const agentInfo = db
      .prepare(
        'INSERT INTO agents (machine_pk, token_hash, version, protocol, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(machinePk, sha256Hex(token), input.agent_version ?? null, 1, now, now);
    const agentId = Number(agentInfo.lastInsertRowid);

    const insertMount = db.prepare(
      'INSERT INTO mounts (machine_pk, mount_id, label, physical_path, sentinel, fs_kind, case_sensitive, unicode, include_json, exclude_json, rules_hash, limits_json, schedule_json, repair_allowed, state, manifest_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const mounts: Array<{ id: number; mount_id: string; manifest_epoch: number }> = [];
    for (const mount of input.mounts) {
      const mountInfo = insertMount.run(
        machinePk,
        mount.mount_id,
        mount.label ?? null,
        mount.physical_path,
        mount.sentinel ?? null,
        mount.fs_kind,
        mount.case_sensitive,
        mount.unicode,
        JSON.stringify(mount.include),
        JSON.stringify(mount.exclude),
        mount.rules_hash,
        JSON.stringify(mount.limits),
        JSON.stringify(mount.schedule),
        mount.repair_allowed ? 1 : 0,
        'active',
        0,
        now,
        now,
      );
      mounts.push({
        id: Number(mountInfo.lastInsertRowid),
        mount_id: mount.mount_id,
        manifest_epoch: 0,
      });
    }

    db.prepare('UPDATE enroll_tokens SET used_at = ? WHERE id = ?').run(now, enrollTokenPk);
    audit(db, `agent:${agentId}`, 'enroll', `machine:${input.machine_id}`, { mounts: ids }, now);

    return { agentId, token, machinePk, mounts };
  });

  return run();
}

export function heartbeatAgent(
  db: Db,
  agent: AgentRow,
  input: { agent_version?: string },
  now: number = Date.now(),
): {
  server_time: number;
  db_instance: string;
  job: null;
  cancel: boolean;
  mounts: Array<{ id: number; mount_id: string; manifest_epoch: number }>;
} {
  db.prepare('UPDATE agents SET last_seen_at = ?, version = COALESCE(?, version) WHERE id = ?').run(
    now,
    input.agent_version ?? null,
    agent.id,
  );
  db.prepare("UPDATE machines SET last_seen_at = ?, status = 'online' WHERE id = ?").run(
    now,
    agent.machine_pk,
  );

  const dbInstanceRow = db
    .prepare("SELECT value FROM settings WHERE key = 'db_instance_id'")
    .get() as { value: string } | undefined;

  const mounts = db
    .prepare(
      "SELECT id, mount_id, manifest_epoch FROM mounts WHERE machine_pk = ? AND state != 'removed' ORDER BY mount_id",
    )
    .all(agent.machine_pk) as Array<{ id: number; mount_id: string; manifest_epoch: number }>;

  return {
    server_time: now,
    db_instance: dbInstanceRow?.value ?? '',
    job: null,
    cancel: false,
    mounts,
  };
}

export function getAgentByToken(db: Db, rawToken: string): AgentRow | undefined {
  return db
    .prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL')
    .get(sha256Hex(rawToken)) as AgentRow | undefined;
}

export function getMachine(db: Db, machinePk: number): MachineRow | undefined {
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(machinePk) as MachineRow | undefined;
}
