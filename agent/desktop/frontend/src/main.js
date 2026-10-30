import { Browser, Dialogs, Events } from "@wailsio/runtime";
import { ConfigService } from "../bindings/observer/agent/desktop";

const $ = (id) => document.getElementById(id);

let hubUrl = "";
let latestStatus = null;
let setupMounts = [];
let settingsMounts = [];
let settingsLoaded = false;

function show(element) {
  element.classList.remove("hidden");
}

function hide(element) {
  element.classList.add("hidden");
}

function makeButton(text, className = "ghost") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}

function makeField(labelText, control, full = false) {
  const label = document.createElement("label");
  label.className = full ? "field field-full" : "field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, control);
  return label;
}

function makeInput(placeholder = "") {
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.autocomplete = "off";
  return input;
}

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
    hide(card);
    return;
  }
  show(card);
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

function renderStatus(raw) {
  const status = typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  latestStatus = status;
  $("machine").textContent = status.machine_id || "-";
  $("hub").textContent = status.hub || "-";
  $("conn").textContent = status.connected ? "已连接" : status.last_error ? "未连接" : "连接中";
  $("conn").className = "badge " + (status.connected ? "ok" : "warn");
  $("state").textContent = status.paused ? "已暂停" : status.running ? "巡检中" : "空闲";
  $("last-run").textContent = status.last_run_at
    ? new Date(status.last_run_at).toLocaleString()
    : "尚未同步";
  $("stats").textContent = status.last_stats
    ? `seen ${status.last_stats.seen} · hashed ${status.last_stats.hashed} · skipped ${status.last_stats.skipped}` +
      ` · 读取 ${status.last_stats.bytes_read} B · 耗时 ${status.last_stats.duration_ms} ms`
    : "暂无";
  $("error").textContent = status.last_error || "无";
  hubUrl = status.hub || hubUrl;
  renderCurrent(status.current);
  renderJobs(status.recent_jobs);
}

function openHub(url) {
  if (!url) return;
  Browser.OpenURL(url).catch(() => window.open(url, "_blank"));
}

function mountToInput(mount) {
  return {
    id: mount.id ?? "",
    label: mount.label ?? "",
    path: mount.path ?? "",
    sentinel: mount.sentinel ?? "",
    exclude: mount.exclude ?? [],
    repair_allowed: Boolean(mount.repair_allowed),
  };
}

function buildMountRow(mount, options, rerender) {
  const row = document.createElement("div");
  row.className = "mount-row";

  const head = document.createElement("div");
  head.className = "mount-row-head";
  const idInput = makeInput("挂载点 ID（如 data）");
  idInput.value = mount.id ?? "";
  idInput.disabled = !(options.idEditable || mount.isNew);
  idInput.addEventListener("input", () => {
    mount.id = idInput.value;
  });
  head.append(makeField("挂载点 ID", idInput));

  const remove = makeButton("删除", "ghost danger");
  remove.addEventListener("click", () => {
    if (options.mounts.length <= 1) {
      window.alert("至少保留一个挂载点");
      return;
    }
    const index = options.mounts.indexOf(mount);
    if (index >= 0) options.mounts.splice(index, 1);
    rerender();
  });
  head.append(remove);
  row.append(head);

  const grid = document.createElement("div");
  grid.className = "form-grid";

  const label = makeInput("可选");
  label.value = mount.label ?? "";
  label.addEventListener("input", () => {
    mount.label = label.value;
  });
  grid.append(makeField("显示名称", label));

  const sentinel = makeInput(".observer-mount");
  sentinel.value = mount.sentinel ?? "";
  sentinel.addEventListener("input", () => {
    mount.sentinel = sentinel.value;
  });
  grid.append(makeField("sentinel（可选）", sentinel));

  const pathInput = makeInput("例如 D:\\ObserverData");
  pathInput.value = mount.path ?? "";
  pathInput.addEventListener("input", () => {
    mount.path = pathInput.value;
  });
  const pathWrap = document.createElement("div");
  pathWrap.className = "path-field";
  pathWrap.append(pathInput);
  const browse = makeButton("浏览…");
  browse.addEventListener("click", async () => {
    try {
      const selected = await Dialogs.OpenFile({
        CanChooseDirectories: true,
        CanChooseFiles: false,
        Title: "选择巡检目录",
      });
      const value = Array.isArray(selected) ? selected[0] : selected;
      if (value) {
        pathInput.value = value;
        mount.path = value;
      }
    } catch {
      // 用户取消或对话框不可用
    }
  });
  pathWrap.append(browse);
  grid.append(makeField("目录", pathWrap, true));

  const exclude = document.createElement("textarea");
  exclude.rows = 2;
  exclude.placeholder = "每行一个 exclude 规则（留空使用默认）";
  exclude.value = (mount.exclude ?? []).join("\n");
  exclude.addEventListener("input", () => {
    mount.exclude = exclude.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  });
  grid.append(makeField("排除规则（可选）", exclude, true));

  const repairLabel = document.createElement("label");
  repairLabel.className = "field checkbox";
  const repair = document.createElement("input");
  repair.type = "checkbox";
  repair.checked = Boolean(mount.repair_allowed);
  repair.addEventListener("change", () => {
    mount.repair_allowed = repair.checked;
  });
  repairLabel.append(repair, document.createTextNode("允许作为跨机修复目标"));
  grid.append(repairLabel);

  row.append(grid);
  return row;
}

function renderMounts(container, mounts, options) {
  const rerender = () => renderMounts(container, mounts, options);
  container.replaceChildren();
  for (const mount of mounts) {
    container.append(buildMountRow(mount, { ...options, mounts }, rerender));
  }
}

function showSetup(state) {
  hide($("main-view"));
  show($("setup-view"));
  $("setup-path").textContent = state.config_path || "-";
  const defaults = state.defaults ?? {};
  const prefill = state.prefill ?? {};
  $("setup-machine-id").value = prefill.machine_id || defaults.machine_id || "";
  $("setup-label").value = prefill.label || defaults.label || "";
  $("setup-hub").value = prefill.hub || defaults.hub || "http://127.0.0.1:8787";
  const token = prefill.token ?? "";
  $("setup-token").value = String(token).startsWith("<") ? "" : token;
  const error = $("setup-error");
  if (state.error) {
    error.textContent = state.error;
    show(error);
  } else {
    hide(error);
  }

  setupMounts =
    prefill.mounts && prefill.mounts.length > 0
      ? prefill.mounts.map((mount) => {
          const value = mountToInput(mount);
          return value;
        })
      : [{ id: "data", label: "", path: "", sentinel: "", exclude: [], repair_allowed: false }];
  renderMounts($("setup-mounts"), setupMounts, { idEditable: true });
}

function showMain() {
  hide($("setup-view"));
  show($("main-view"));
  if (latestStatus) renderStatus(latestStatus);
  switchTab("status");
}

function switchTab(tab) {
  const statusTab = tab === "status";
  $("status-view").classList.toggle("hidden", !statusTab);
  $("settings-view").classList.toggle("hidden", statusTab);
  $("nav-status").classList.toggle("active", statusTab);
  $("nav-settings").classList.toggle("active", !statusTab);
  if (!statusTab && !settingsLoaded) void loadSettings();
}

async function loadSettings() {
  const status = $("settings-status");
  status.textContent = "加载中…";
  try {
    const state = await ConfigService.GetSettings();
    settingsLoaded = true;
    $("settings-path").textContent = state.config_path || "-";
    $("settings-machine-id").value = state.machine_id || "";
    $("settings-hub").value = state.hub || "";
    $("settings-state-dir").value = state.state_dir || "";
    $("settings-label").value = state.label || "";
    settingsMounts = (state.mounts ?? []).map((mount) => mountToInput(mount));
    renderMounts($("settings-mounts"), settingsMounts, { idEditable: false });
    status.textContent = "";
  } catch (error) {
    status.textContent = error?.message || String(error);
  }
}

function setupPayload() {
  return {
    machine_id: $("setup-machine-id").value.trim(),
    label: $("setup-label").value.trim(),
    hub: $("setup-hub").value.trim(),
    token: $("setup-token").value.trim(),
    state_dir: "",
    mounts: setupMounts.map(mountToInput),
  };
}

function settingsPayload() {
  return {
    label: $("settings-label").value.trim(),
    mounts: settingsMounts.map(mountToInput),
  };
}

document.addEventListener("DOMContentLoaded", () => {
  $("open-hub").addEventListener("click", () => openHub(hubUrl));
  $("setup-open-hub").addEventListener("click", () => {
    openHub($("setup-hub").value.trim() || "http://127.0.0.1:8787");
  });
  $("setup-add-mount").addEventListener("click", () => {
    setupMounts.push({ id: "", label: "", path: "", sentinel: "", exclude: [], repair_allowed: false });
    renderMounts($("setup-mounts"), setupMounts, { idEditable: true });
  });
  $("setup-save").addEventListener("click", async () => {
    const status = $("setup-status");
    status.textContent = "保存中…";
    try {
      await ConfigService.SaveInitialConfig(setupPayload());
      status.textContent = "";
      settingsLoaded = false;
      showMain();
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  });

  $("nav-status").addEventListener("click", () => switchTab("status"));
  $("nav-settings").addEventListener("click", () => switchTab("settings"));
  $("settings-add-mount").addEventListener("click", () => {
    settingsMounts.push({ id: "", label: "", path: "", sentinel: "", exclude: [], repair_allowed: false, isNew: true });
    renderMounts($("settings-mounts"), settingsMounts, { idEditable: false });
  });
  $("settings-save").addEventListener("click", async () => {
    const status = $("settings-status");
    status.textContent = "保存中…";
    try {
      const result = await ConfigService.SaveSettings(settingsPayload());
      settingsLoaded = true;
      settingsMounts = (result.mounts ?? []).map((mount) => mountToInput(mount));
      renderMounts($("settings-mounts"), settingsMounts, { idEditable: false });
      status.textContent = "已保存，正在重启巡检进程…";
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  });

  ConfigService.GetSetupState()
    .then((state) => {
      if (state.needs_setup) {
        showSetup(state);
        return;
      }
      showMain();
    })
    .catch((error) => {
      showSetup({
        needs_setup: true,
        config_path: "",
        error: error?.message || String(error),
        defaults: { machine_id: "win-01", label: "Windows PC", hub: "http://127.0.0.1:8787" },
      });
    });
});

Events.On("status", (event) => {
  if ($("main-view").classList.contains("hidden")) return;
  renderStatus(event.data);
});
