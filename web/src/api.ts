export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { credentials: 'include', ...init, headers });

  if (response.status === 401) {
    window.dispatchEvent(new Event('observer:unauthorized'));
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { detail?: string; title?: string };
      detail = payload.detail ?? payload.title ?? detail;
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(detail);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface Coverage {
  total: number;
  hashed: number;
  ratio: number;
}

export interface MountRef {
  id: number;
  mount_id: string;
  label?: string | null;
  state: string;
  manifest_epoch: number;
  coverage?: Coverage;
}

export interface Machine {
  id: number;
  machine_id: string;
  label: string | null;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  status: string;
  last_seen_at: number | null;
  agent_version?: string | null;
  agent_protocol?: number | null;
  mounts: MountRef[];
}

export interface Job {
  id: number;
  mode: string;
  status: string;
  attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  stats: Record<string, unknown> | null;
  mount_id: string;
  machine_id: string;
}

export interface Issue {
  id: number;
  type: string;
  status: string;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  evidence: Record<string, unknown> | null;
  path_key: string;
  path_display_b64: string;
  mount_id: string;
  machine_id: string;
}

export interface EnrollTokenResult {
  token: string;
  expires_at: number;
  machine_hint: string | null;
}

export interface AgentAccessTokenResult {
  token: string;
  agent_id: number;
  machine_id: string;
  revoked_agents: number;
}

export type ScanMode = 'incremental' | 'full';

export interface BulkScanCreated {
  job_id: number;
  mount_pk: number;
  mount_id: string;
  machine_id: string;
}

export interface BulkScanSkipped {
  mount_pk: number;
  mount_id: string;
  machine_id: string;
  reason: string;
}

export interface BulkScanResult {
  mode: ScanMode;
  total_mounts: number;
  created: BulkScanCreated[];
  skipped: BulkScanSkipped[];
}

export interface Overview {
  machines: { total: number; online: number };
  mounts: { total: number };
  coverage: Coverage;
  issues: { open: number; acked: number };
  issues_by_type: { mismatch: number; missing: number; unreadable: number };
  issues_by_machine: Array<{ machine_id: string; open: number }>;
  jobs: { pending: number; running: number };
  recent_jobs: Job[];
}

export interface MountDetail extends MountRef {
  machine_id: string | null;
  physical_path: string;
  rules_hash: string;
  include: string[];
  exclude: string[];
  schedule?: {
    window: string;
    budgetMinutesPerDay: number;
    intervalMinutes: number;
  };
  repair_allowed?: boolean;
  coverage: Coverage;
  last_job: Job | null;
}

export interface IssueDetail {
  id: number;
  type: string;
  status: string;
  confidence: string;
  evidence: Record<string, unknown> | null;
  path_key: string;
  mount_id: string;
  machine_id: string;
  target_state: string;
  target_size: number;
  expected_hash: string | null;
  observed_hash: string | null;
  repair_allowed: boolean;
}

export interface Replica {
  path_id: number;
  machine_id: string;
  mount_id: string;
  path_key: string;
  size: number;
  last_hashed_at: number | null;
  confidence: string;
}

export interface FileSummary {
  total: number;
  active: number;
  missing: number;
  out_of_scope: number;
  hashed: number;
  unhashed: number;
  open_issue_paths: number;
}

export interface FileItem {
  id: number;
  machine_id: string;
  machine_label: string | null;
  mount_pk: number;
  mount_id: string;
  mount_label: string | null;
  path_key: string;
  path_display_b64: string;
  state: string;
  size: number;
  mtime_ns: string;
  content_hash: string | null;
  last_seen_at: number | null;
  last_hashed_at: number | null;
  last_hash_kind: string | null;
  open_issue_count: number;
}

export interface FileList {
  items: FileItem[];
  total: number;
  limit: number;
  offset: number;
  summary: FileSummary;
}

export interface FileIssueDetail {
  id: number;
  type: string;
  status: string;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  evidence: Record<string, unknown> | null;
}

export interface FileObservation {
  hash: string;
  kind: string;
  observed_at: number;
}

export interface FileDetail {
  file: FileItem;
  machine: {
    machine_id: string;
    label: string | null;
    status: string;
    platform: string | null;
  };
  mount: {
    id: number;
    mount_id: string;
    label: string | null;
    physical_path: string;
    state: string;
  };
  issues: FileIssueDetail[];
  observations: FileObservation[];
}

export interface ReplicaResponse {
  issue_id: number;
  expected_hash: string | null;
  repair_allowed: boolean;
  source_repairable: boolean;
  replicas: Replica[];
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

export function formatTime(value?: number | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

export function formatRelative(value?: number | null): string {
  if (!value) return '-';
  const diff = Date.now() - value;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(value).toLocaleString();
}

export function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatBytes(value?: number | null): string {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** mtime_ns 是十进制纳秒字符串，用 BigInt 转毫秒避免精度丢失。 */
export function formatNs(value?: string | null): string {
  if (!value) return '-';
  try {
    return new Date(Number(BigInt(value) / 1_000_000n)).toLocaleString();
  } catch {
    return value;
  }
}

export function fileStateLabel(state: string): string {
  switch (state) {
    case 'active':
      return '正常';
    case 'missing':
      return '缺失';
    case 'out_of_scope':
      return '已移出规则';
    default:
      return state;
  }
}

export function decodePath(base64: string): string {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return base64;
  }
}

export function statusClass(status: string): string {
  switch (status) {
    case 'completed':
    case 'active':
    case 'online':
      return 'badge ok';
    case 'running':
    case 'pending':
    case 'suspect':
      return 'badge warn';
    case 'failed':
    case 'unavailable':
    case 'open':
      return 'badge danger';
    default:
      return 'badge';
  }
}

export function issueClass(type: string): string {
  switch (type) {
    case 'mismatch':
      return 'badge danger';
    case 'missing':
      return 'badge warn';
    default:
      return 'badge';
  }
}

