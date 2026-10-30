import { z } from 'zod';

export const idPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const sha256Pattern = /^[0-9a-f]{64}$/;

export const IdParam = z.coerce.number().int().positive();

export const MountInput = z.object({
  mount_id: z.string().regex(idPattern),
  label: z.string().max(200).optional(),
  physical_path: z.string().min(1).max(4096),
  sentinel: z.string().min(1).max(255).nullish(),
  fs_kind: z.enum(['local', 'network', 'removable', 'fuse']).default('local'),
  case_sensitive: z.enum(['auto', 'true', 'false']).default('auto'),
  unicode: z.enum(['auto', 'nfc', 'nfd']).default('auto'),
  include: z.array(z.string().max(1024)).default([]),
  exclude: z.array(z.string().max(1024)).default([]),
  rules_hash: z.string().min(1).max(128),
  limits: z.record(z.unknown()).default({}),
  schedule: z.record(z.unknown()).default({}),
  repair_allowed: z.boolean().default(false),
});

export const EnrollInputSchema = z.object({
  machine_id: z.string().regex(idPattern),
  label: z.string().max(200).optional(),
  hostname: z.string().max(255).optional(),
  platform: z.string().max(64).optional(),
  arch: z.string().max(64).optional(),
  agent_version: z.string().max(64).optional(),
  mounts: z.array(MountInput).min(1).max(256),
});

export const HeartbeatInput = z.object({
  agent_version: z.string().max(64).optional(),
  active_job_id: z.number().int().positive().optional(),
});

export const ScanRequest = z.object({
  mode: z.enum(['baseline', 'incremental', 'full']).default('incremental'),
});

export const ResultEntrySchema = z.object({
  path_key: z.string().min(1).max(4096),
  path_display_b64: z.string().min(1),
  size: z.number().int().min(0),
  mtime_ns: z.string().regex(/^\d{1,20}$/),
  hash: z.string().regex(sha256Pattern).nullish(),
  status: z.enum(['ok', 'skipped', 'unreadable', 'unstable']),
  skip_reason: z.string().max(64).optional(),
});

export const ResultBatchSchema = z.object({
  seq: z.number().int().min(0),
  entries: z.array(ResultEntrySchema).max(1000),
});

export const FinishSchema = z.object({
  status: z.enum(['completed', 'failed', 'canceled']),
  stats: z.record(z.unknown()).optional(),
  guard: z
    .object({
      status: z.enum(['ok', 'unavailable', 'suspect']),
      reason: z.string().max(200).optional(),
    })
    .optional(),
});

export const OffsetQuery = z.coerce.number().int().min(0).default(0);

export const RepairRequestSchema = z.object({
  source_path_id: z.number().int().positive(),
});

export const TransferFailSchema = z.object({
  reason: z.string().max(500).default('source upload failed'),
});

export const RepairResultSchema = z.object({
  success: z.boolean(),
  error: z.string().max(500).optional(),
  hash: z.string().regex(sha256Pattern).optional(),
  size: z.number().int().min(0).optional(),
  mtime_ns: z.string().regex(/^\d{1,20}$/).optional(),
});

export const CreateEnrollTokenSchema = z.object({
  machine_hint: z.string().min(1).max(128).optional(),
  ttl_hours: z.number().int().min(1).max(720).default(24),
});

export const AgentJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
