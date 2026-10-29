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

export interface Overview {
  machines: { total: number; online: number };
  mounts: { total: number };
  coverage: Coverage;
  issues: { open: number; acked: number };
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

