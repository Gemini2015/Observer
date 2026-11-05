/** 展示格式化工具：时间、字节、比例、路径、哈希。全部为纯函数，便于单测。 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const countFormatter = new Intl.NumberFormat('zh-CN');

/** 绝对时间（本地时区，固定 zh-CN，避免不同浏览器格式漂移）。 */
export function formatTime(value?: number | null): string {
  if (!value) return '-';
  return dateTimeFormatter.format(new Date(value));
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天回退绝对时间。 */
export function formatRelative(value?: number | null): string {
  if (!value) return '-';
  const diff = Date.now() - value;
  if (diff < 0) return formatTime(value);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(value);
}

export function formatPercent(value?: number | null, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatCount(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return countFormatter.format(value);
}

export function formatBytes(value?: number | null): string {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms?: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds} 秒`;
}

/** mtime_ns 是十进制纳秒字符串，用 BigInt 转毫秒避免精度丢失。 */
export function formatNs(value?: string | null): string {
  if (!value) return '-';
  try {
    return formatTime(Number(BigInt(value) / 1_000_000n));
  } catch {
    return value;
  }
}

export function shortHash(hash?: string | null, length = 12): string {
  if (!hash) return '-';
  if (hash.length <= length) return hash;
  return `${hash.slice(0, length)}…`;
}

function looksLikeWindows(platform?: string | null, physicalPath?: string | null): boolean {
  const normalized = (platform ?? '').toLowerCase();
  if (normalized.includes('windows') || normalized === 'win32') return true;
  if (normalized.includes('linux') || normalized.includes('darwin') || normalized.includes('mac')) {
    return false;
  }
  const path = physicalPath ?? '';
  return /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\\');
}

/** 把挂载根路径与相对路径拼成完整路径，按目标平台选择分隔符。 */
export function joinMountPath(
  platform: string | null | undefined,
  physicalPath: string | null | undefined,
  pathKey: string,
): string {
  const base = (physicalPath ?? '').replace(/[\\/]+$/, '');
  if (!base) return pathKey;
  if (looksLikeWindows(platform, physicalPath)) {
    return `${base}\\${pathKey.replace(/\//g, '\\')}`;
  }
  return `${base}/${pathKey.replace(/^\/+/, '')}`;
}

export function decodePath(base64: string): string {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return base64;
  }
}

/** 把任意 stats 值转成可读文本（数字加千分位，字节类字段走 formatBytes）。 */
export function formatStatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (/bytes|size/i.test(key)) return formatBytes(value);
    if (/ms$|duration/i.test(key)) return formatDuration(value);
    return formatCount(value);
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
