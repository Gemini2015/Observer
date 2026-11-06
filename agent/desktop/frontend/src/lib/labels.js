/** 状态/枚举的中文标签与色调：页面不直接展示后端枚举。 */

export function labelOf(map, value) {
  if (!value) return { label: "—", tone: "neutral" };
  return map[value] ?? { label: String(value), tone: "neutral" };
}

export const machineStatus = {
  online: { label: "在线", tone: "ok" },
  offline: { label: "离线", tone: "neutral" },
};

export const mountState = {
  active: { label: "正常", tone: "ok" },
  suspect: { label: "疑似掉盘", tone: "warn" },
  unavailable: { label: "不可用", tone: "danger" },
  removed: { label: "已移除", tone: "neutral" },
};

export const jobStatus = {
  pending: { label: "排队中", tone: "info" },
  running: { label: "巡检中", tone: "info" },
  completed: { label: "已完成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
  canceled: { label: "已取消", tone: "neutral" },
  expired: { label: "租约过期", tone: "warn" },
};

export const jobMode = {
  baseline: { label: "基线", tone: "info" },
  incremental: { label: "增量", tone: "neutral" },
  full: { label: "全量", tone: "neutral" },
};

export const fileState = {
  active: { label: "正常", tone: "ok" },
  missing: { label: "缺失", tone: "danger" },
  out_of_scope: { label: "已移出规则", tone: "warn" },
};

export const issueType = {
  mismatch: { label: "内容不一致", tone: "danger" },
  missing: { label: "文件缺失", tone: "warn" },
  unreadable: { label: "不可读", tone: "info" },
};

export const issueStatus = {
  open: { label: "待确认", tone: "warn" },
  acked: { label: "已确认", tone: "info" },
  ignored: { label: "已忽略", tone: "neutral" },
  resolved: { label: "已解决", tone: "ok" },
};

export const confidence = {
  high: { label: "高", tone: "ok" },
  medium: { label: "中", tone: "warn" },
  low: { label: "低", tone: "neutral" },
};

export const observationKind = {
  scan: { label: "巡检", tone: "neutral" },
  repair: { label: "修复", tone: "info" },
};

export const hashKind = {
  hash: { label: "已计算哈希", tone: "neutral" },
  skip: { label: "本轮跳过", tone: "neutral" },
  sha256: { label: "SHA-256", tone: "neutral" },
};

export const connectionState = {
  connected: { label: "已连接", tone: "ok" },
  connecting: { label: "连接中…", tone: "warn" },
  disconnected: { label: "未连接", tone: "danger" },
  paused: { label: "已暂停", tone: "warn" },
};

const statKeys = {
  seen: "发现文件",
  hashed: "计算哈希",
  skipped: "跳过",
  unreadable: "不可读",
  unstable: "读取不稳定",
  batches: "批次数",
  bytes_read: "读取字节",
  duration_ms: "耗时",
  spooled: "补发条目",
  skip_reasons: "跳过原因",
};

export function statLabel(key) {
  return statKeys[key] ?? key;
}
