export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  /** 服务端原始 detail（可能为英文），用于「技术信息」折叠展示。 */
  readonly detail?: string;

  constructor(status: number, kind: string, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

function friendlyMessage(status: number, detail: string | undefined): string {
  switch (status) {
    case 400:
      return '请求参数不合法';
    case 401:
      return '登录已过期，请重新登录';
    case 403:
      return '没有权限执行该操作';
    case 404:
      return '目标不存在或已被删除';
    case 409:
      return detail ? `操作冲突：${detail}` : '操作冲突，目标状态已变化';
    case 410:
      return '该操作已过期，请刷新后重试';
    case 422:
      return detail ? `参数校验失败：${detail}` : '参数校验失败';
    case 429:
      return '操作过于频繁，请稍后再试';
    default:
      return status >= 500 ? '服务端错误，请稍后重试' : `请求失败（HTTP ${status}）`;
  }
}

function networkError(): ApiError {
  return new ApiError(0, 'network', '无法连接中心服，请检查网络或 hub 是否在运行', 'network error');
}

async function toApiError(response: Response): Promise<ApiError> {
  let detail: string | undefined;
  let title: string | undefined;
  try {
    const payload = (await response.json()) as { detail?: string; title?: string };
    detail = payload.detail;
    title = payload.title;
  } catch {
    // 非 JSON 错误体
  }
  const raw = detail ?? title ?? response.statusText;
  return new ApiError(response.status, title ?? 'request', friendlyMessage(response.status, detail), raw);
}

function handleUnauthorized(): void {
  window.dispatchEvent(new Event('observer:unauthorized'));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, { credentials: 'include', ...init, headers });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw networkError();
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'auth', '登录已过期，请重新登录', 'unauthorized');
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** 下载文件（CSV 导出）：与 api 共享错误处理，返回是否被截断。 */
export async function downloadFile(path: string, filename: string): Promise<{ truncated: boolean }> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'include' });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw networkError();
  }
  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'auth', '登录已过期，请重新登录', 'unauthorized');
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return { truncated: response.headers.get('x-observer-truncated') === 'true' };
}

// ---------------------------------------------------------------- 类型定义

export type IssueStatus = 'open' | 'ignored' | 'resolved';
export type IssueResolution = 'recovered' | 'repaired' | 'rebaselined';

export interface IssueActionResponse {
  ok: true;
  baseline_hash?: string;
}

/** 接受最近一次巡检观测到的 hash 为新基线。 */
export function rebaselineIssue(id: number, observedHash: string): Promise<IssueActionResponse> {
  return api<IssueActionResponse>(`/api/v1/issues/${id}/rebaseline`, {
    method: 'POST',
    body: JSON.stringify({ observed_hash: observedHash }),
  });
}

/** 忽略当前异常；mismatch 需要传本次观测 hash。 */
export function ignoreIssue(id: number, observedHash?: string | null): Promise<IssueActionResponse> {
  return api<IssueActionResponse>(`/api/v1/issues/${id}/ignore`, {
    method: 'POST',
    body: JSON.stringify(observedHash ? { observed_hash: observedHash } : {}),
  });
}

/** 取消忽略，把异常放回待确认。 */
export function unignoreIssue(id: number): Promise<IssueActionResponse> {
  return api<IssueActionResponse>(`/api/v1/issues/${id}/unignore`, { method: 'POST' });
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
  /** 新增（后端增量）：未关闭异常数与最近任务时间。 */
  open_issues?: number;
  last_job_at?: number | null;
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
  status: IssueStatus;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  ignored_hash: string | null;
  ignored_at: number | null;
  resolution: IssueResolution | null;
  expected_hash: string | null;
  observed_hash: string | null;
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

export interface AttentionMount {
  mount_pk: number;
  mount_id: string;
  machine_id: string;
  state: string;
  coverage_ratio: number;
  last_job_at: number | null;
  last_job_status: string | null;
}

export interface Overview {
  machines: { total: number; online: number };
  mounts: { total: number; never_scanned?: number; stale_24h?: number };
  coverage: Coverage;
  issues: { open: number; ignored: number };
  issues_by_type: { mismatch: number; missing: number; unreadable: number };
  issues_by_machine: Array<{ machine_id: string; open: number }>;
  jobs: { pending: number; running: number };
  recent_jobs: Job[];
  /** 后端增量字段；未就绪时前端按缺省处理。 */
  last_scan_at?: number | null;
  attention_mounts?: AttentionMount[];
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
  status: IssueStatus;
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
  ignored_hash: string | null;
  ignored_at: number | null;
  resolution: IssueResolution | null;
  resolved_at: number | null;
  repair_active: boolean;
  can_rebaseline: boolean;
  can_ignore: boolean;
  can_unignore: boolean;
  can_repair: boolean;
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

export interface IssueSummary {
  status: { open: number; ignored: number; resolved: number };
  type: { mismatch: number; missing: number; unreadable: number };
  machines: Array<{ machine_id: string; open: number }>;
}

export interface SystemInfo {
  version: string;
  now: number;
  uptime_ms: number;
  scheduler: { enabled: boolean; interval_ms: number };
  offline_after_seconds: number;
  db: {
    ok: boolean;
    machines: number;
    mounts: number;
    paths: number;
    issues_open: number;
    jobs_running: number;
    repairs_active: number;
  };
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  at: number;
}
