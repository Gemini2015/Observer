/** 展示格式化：与 hub Web 控制台保持相同的口径。 */

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const countFormatter = new Intl.NumberFormat("zh-CN");

export function formatTime(value) {
  if (!value) return "-";
  return dateTimeFormatter.format(new Date(value));
}

export function formatRelative(value) {
  if (!value) return "-";
  const diff = Date.now() - value;
  if (diff < 0) return formatTime(value);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(value);
}

export function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "0";
  return countFormatter.format(Number(value));
}

export function formatBytes(value) {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 纳秒时间戳字符串 -> 本地时间（BigInt 避免精度丢失）。 */
export function formatNs(value) {
  if (!value) return "-";
  try {
    return formatTime(Number(BigInt(value) / 1_000_000n));
  } catch {
    return String(value);
  }
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds} 秒`;
}

export function shortHash(hash, length = 12) {
  if (!hash) return "-";
  if (hash.length <= length) return hash;
  return `${hash.slice(0, length)}…`;
}

export function decodePath(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64 ?? ""), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return base64 ?? "";
  }
}

function looksWindows(platform, physicalPath) {
  const normalized = String(platform ?? "").toLowerCase();
  if (normalized.includes("windows") || normalized === "win32") return true;
  if (normalized.includes("linux") || normalized.includes("darwin") || normalized.includes("mac")) {
    return false;
  }
  const path = String(physicalPath ?? "");
  return /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
}

/** 把挂载根路径与相对路径拼成完整路径，按目标平台选择分隔符。 */
export function joinPath(platform, physicalPath, pathKey) {
  const base = String(physicalPath ?? "").replace(/[\\/]+$/, "");
  const relative = String(pathKey ?? "");
  if (!base) return relative;
  if (looksWindows(platform, physicalPath)) {
    return `${base}\\${relative.replace(/\//g, "\\")}`;
  }
  return `${base}/${relative.replace(/^\/+/, "")}`;
}

export function formatStatValue(key, value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (/bytes|size/i.test(key)) return formatBytes(value);
    if (/ms$|duration/i.test(key)) return formatDuration(value);
    return formatCount(value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
