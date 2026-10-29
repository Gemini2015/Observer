import { Events, WML } from "@wailsio/runtime";

const $ = (id) => document.getElementById(id);

let wired = false;

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
  $("hub-link").href = status.hub || "#";

  if (!wired) {
    WML.Enable();
    wired = true;
  }
}

Events.On("status", (event) => render(event.data));

document.addEventListener("DOMContentLoaded", () => {
  if (!wired) {
    WML.Enable();
    wired = true;
  }
});
