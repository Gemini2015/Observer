import { Browser, Events } from "@wailsio/runtime";

const $ = (id) => document.getElementById(id);

let hubUrl = "";

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function statsSummary(stats) {
  if (!stats) return "-";
  const seen = stats.seen ?? 0;
  const hashed = stats.hashed ?? 0;
  const skipped = stats.skipped ?? 0;
  const duration = stats.duration_ms ? `${(stats.duration_ms / 1000).toFixed(1)}s` : "-";
  return `seen ${seen} · hashed ${hashed} · skipped ${skipped} · ${duration}`;
}

function renderCurrent(current) {
  const card = $("current-card");
  if (!current) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const progress = current.progress ?? {};
  $("current-title").textContent = `#${current.job_id} · ${current.mount_id} · ${current.mode} · 执行中`;
  $("current-detail").textContent =
    `已处理 ${progress.seen ?? 0} · 已哈希 ${progress.hashed ?? 0} · 跳过 ${progress.skipped ?? 0}` +
    ` · 不可读 ${progress.unreadable ?? 0} · 读取 ${((progress.bytes_read ?? 0) / 1048576).toFixed(1)} MiB`;
}

function renderJobs(jobs) {
  const tbody = $("jobs");
  tbody.replaceChildren();
  if (!jobs || jobs.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "muted";
    cell.textContent = "暂无任务";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }
  for (const job of jobs) {
    const row = document.createElement("tr");
    const values = [
      `#${job.id}`,
      job.mount_id ?? "-",
      job.mode ?? "-",
      job.status ?? "-",
      formatTime(job.started_at ?? job.created_at),
      statsSummary(job.stats),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
}

function render(raw) {
  const status = typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  $("machine").textContent = status.machine_id || "-";
  $("hub").textContent = status.hub || "-";
  $("conn").textContent = status.connected ? "已连接" : status.last_error ? "未连接" : "连接中";
  $("conn").className = "badge " + (status.connected ? "ok" : "warn");
  $("state").textContent = status.paused ? "已暂停" : status.running ? "巡检中" : "空闲";
  $("last-run").textContent = status.last_run_at
    ? new Date(status.last_run_at).toLocaleString()
    : "尚未同步";

  const stats = status.last_stats;
  $("stats").textContent = stats
    ? `seen ${stats.seen} · hashed ${stats.hashed} · skipped ${stats.skipped} · 读取 ${stats.bytes_read} B · 耗时 ${stats.duration_ms} ms`
    : "暂无";

  $("error").textContent = status.last_error || "无";
  hubUrl = status.hub || "";

  renderCurrent(status.current);
  renderJobs(status.recent_jobs);
}

Events.On("status", (event) => render(event.data));

document.addEventListener("DOMContentLoaded", () => {
  $("open-hub").addEventListener("click", () => {
    if (!hubUrl) return;
    // 通过 Wails 运行时调用系统默认浏览器，避免在 WebView 内导航。
    Browser.OpenURL(hubUrl).catch(() => {
      window.open(hubUrl, "_blank");
    });
  });
});
