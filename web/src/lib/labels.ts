/** 中文标签与状态色调的唯一来源：页面不直接展示后端枚举。 */

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

export interface Labeled {
  label: string;
  tone: Tone;
}

export type LabelMap = Record<string, Labeled>;

export function labelOf(map: LabelMap, value: string | null | undefined): Labeled {
  if (!value) return { label: '—', tone: 'neutral' };
  return map[value] ?? { label: value, tone: 'neutral' };
}

export const machineStatus: LabelMap = {
  online: { label: '在线', tone: 'ok' },
  offline: { label: '离线', tone: 'neutral' },
};

export const mountState: LabelMap = {
  active: { label: '正常', tone: 'ok' },
  suspect: { label: '疑似掉盘', tone: 'warn' },
  unavailable: { label: '不可用', tone: 'danger' },
  removed: { label: '已移除', tone: 'neutral' },
};

export const jobStatus: LabelMap = {
  pending: { label: '排队中', tone: 'info' },
  running: { label: '巡检中', tone: 'info' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
  expired: { label: '租约过期', tone: 'warn' },
};

export const jobMode: LabelMap = {
  baseline: { label: '基线', tone: 'info' },
  incremental: { label: '增量', tone: 'neutral' },
  full: { label: '全量', tone: 'neutral' },
};

export const issueType: LabelMap = {
  mismatch: { label: '内容不一致', tone: 'danger' },
  missing: { label: '文件缺失', tone: 'warn' },
  unreadable: { label: '不可读', tone: 'info' },
};

export const issueStatus: LabelMap = {
  open: { label: '待确认', tone: 'warn' },
  acked: { label: '已确认', tone: 'info' },
  ignored: { label: '已忽略', tone: 'neutral' },
  resolved: { label: '已解决', tone: 'ok' },
};

export const confidence: LabelMap = {
  high: { label: '高', tone: 'ok' },
  medium: { label: '中', tone: 'warn' },
  low: { label: '低', tone: 'neutral' },
};

export const fileState: LabelMap = {
  active: { label: '正常', tone: 'ok' },
  missing: { label: '缺失', tone: 'danger' },
  out_of_scope: { label: '已移出规则', tone: 'warn' },
};

export const repairStatus: LabelMap = {
  pending: { label: '等待源上传', tone: 'info' },
  transferring: { label: '源上传中', tone: 'info' },
  ready: { label: '等待目标应用', tone: 'info' },
  applying: { label: '目标替换中', tone: 'info' },
  completed: { label: '修复完成', tone: 'ok' },
  failed: { label: '修复失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export const transferStatus: LabelMap = {
  pending: { label: '等待上传', tone: 'info' },
  ready: { label: '已就绪', tone: 'ok' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  expired: { label: '已过期', tone: 'warn' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export const hashKind: LabelMap = {
  hash: { label: '已计算哈希', tone: 'neutral' },
  skip: { label: '本轮跳过', tone: 'neutral' },
  sha256: { label: 'SHA-256', tone: 'neutral' },
  unreadable: { label: '不可读', tone: 'warn' },
  unstable: { label: '读取不稳定', tone: 'warn' },
};

export const observationKind: LabelMap = {
  scan: { label: '巡检', tone: 'neutral' },
  repair: { label: '修复', tone: 'info' },
};

const statKeys: Record<string, string> = {
  seen: '发现文件',
  hashed: '计算哈希',
  skipped: '跳过',
  unreadable: '不可读',
  unstable: '读取不稳定',
  batches: '批次数',
  bytes_read: '读取字节',
  duration_ms: '耗时',
  spooled: '补发条目',
  skip_reasons: '跳过原因',
  missing: '判定缺失',
  guard_status: '守卫状态',
  guard_reason: '守卫原因',
};

export function statLabel(key: string): string {
  return statKeys[key] ?? key;
}

export const REPAIR_TERMINAL = new Set(['completed', 'failed', 'canceled']);

export function isRepairTerminal(status: string): boolean {
  return REPAIR_TERMINAL.has(status);
}

const auditActions: Record<string, string> = {
  enroll: '节点注册',
  'enroll_token.create': '生成注册令牌',
  'agent.token.rotate': '轮换接入令牌',
  'job.create': '创建巡检任务',
  'job.dispatch': '派发巡检任务',
  'job.finish': '巡检任务结束',
  'job.expire': '任务租约过期',
  'mount.guard': '挂载守卫判定',
  'mount.suspect': '标记疑似掉盘',
  'mount.sync': '同步挂载点',
  'mount.delete': '删除挂载点',
  'machine.delete': '删除机器',
  'repair.create': '发起修复',
  'repair.cancel': '取消修复',
  'repair.complete': '修复完成',
  'repair.failed': '修复失败',
  'repair.expired': '修复过期',
  'transfer.ready': '传输就绪',
  'transfer.failed': '传输失败',
  'scan.bulk': '批量扫描',
  'scheduler.tick': '调度轮询',
};

export function auditActionLabel(action: string | null | undefined): string {
  if (!action) return '—';
  return auditActions[action] ?? action;
}

export function actorLabel(actor: string | null | undefined): string {
  if (!actor) return '—';
  if (actor === 'user') return '用户';
  if (actor === 'system') return '系统';
  if (actor.startsWith('agent:')) return `agent #${actor.slice('agent:'.length)}`;
  return actor;
}

/** 用于「已解决」等系统行为的解释文案。 */
export const RESOLVE_HINT = '异常在后续巡检复核一致后会自动变为已解决。';
