import { Browser, Dialogs, Events } from "@wailsio/runtime";
import { ConfigService, FileService } from "../bindings/observer/agent/desktop";

const $ = (id) => document.getElementById(id);

let hubUrl = "";
let latestStatus = null;
let setupMounts = [];
let settingsMounts = [];
let settingsLoaded = false;
let filesLoaded = false;
let filesOffset = 0;
const filesLimit = 50;
let filesTotal = 0;
let filesCurrent = [];
let filesQueryTimer = null;
let selectedFileId = null;

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

function decodePathB64(value) {
  try {
    const bytes = Uint8Array.from(atob(value ?? ""), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value ?? "";
  }
}

function formatBytes(value) {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let current = size;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileStateLabel(state) {
  switch (state) {
    case "active":
      return "正常";
    case "missing":
      return "缺失";
    case "out_of_scope":
      return "已移出规则";
    default:
      return state || "-";
  }
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
  $("setup-machine-id").readOnly = false;
  $("setup-probe-status").textContent = "已有节点：粘贴接入 token 后点识别，自动填充机器与挂载点。";
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
  const filesTab = tab === "files";
  const settingsTab = tab === "settings";
  $("status-view").classList.toggle("hidden", !statusTab);
  $("files-view").classList.toggle("hidden", !filesTab);
  $("settings-view").classList.toggle("hidden", !settingsTab);
  $("nav-status").classList.toggle("active", statusTab);
  $("nav-files").classList.toggle("active", filesTab);
  $("nav-settings").classList.toggle("active", settingsTab);
  if (filesTab && !filesLoaded) {
    filesLoaded = true;
    void loadFileMounts();
    void loadFiles(true);
  }
  if (settingsTab && !settingsLoaded) void loadSettings();
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

function fileQueryPayload() {
  return {
    q: $("files-q").value.trim(),
    mount_id: $("files-mount").value,
    state: $("files-state").value,
    issue: $("files-issue").value,
    hash: $("files-hash").value,
    sort: $("files-sort").value,
    order: $("files-order").value,
    limit: filesLimit,
    offset: filesOffset,
  };
}

async function loadFileMounts() {
  const select = $("files-mount");
  const current = select.value;
  try {
    const mounts = await FileService.Mounts();
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部";
    select.appendChild(all);
    for (const mount of mounts ?? []) {
      const option = document.createElement("option");
      option.value = mount.id;
      option.textContent = mount.label || mount.id;
      select.appendChild(option);
    }
    select.value = current;
  } catch {
    // 文件页加载时会再次报错，这里不打断
  }
}

async function loadFiles(reset = false) {
  if (reset) {
    filesOffset = 0;
    hideFileDetail();
  }
  const error = $("files-error");
  hide(error);
  try {
    const result = await FileService.ListFiles(fileQueryPayload());
    filesLoaded = true;
    filesCurrent = result.items ?? [];
    filesTotal = result.total ?? 0;
    renderFiles(result);
  } catch (err) {
    error.textContent = err?.message || String(err);
    show(error);
    $("files-empty").classList.add("hidden");
    $("files-table").classList.add("hidden");
    $("files-total").textContent = "";
  }
}

function renderFiles(result) {
  const summary = result.summary ?? {};
  $("files-summary").textContent =
    `共 ${summary.total ?? 0} · 正常 ${summary.active ?? 0} · 缺失 ${summary.missing ?? 0}` +
    ` · 有异常 ${summary.open_issue_paths ?? 0} · 已哈希 ${summary.hashed ?? 0}`;

  const tbody = $("files-rows");
  tbody.replaceChildren();
  const items = result.items ?? [];
  const empty = $("files-empty");
  const table = $("files-table");
  if (items.length === 0) {
    show(empty);
    hide(table);
  } else {
    hide(empty);
    show(table);
  }

  for (const item of items) {
    const row = document.createElement("tr");
    const path = decodePathB64(item.path_display_b64) || item.path_key;
    const cells = [
      path,
      item.mount_label || item.mount_id,
      fileStateLabel(item.state),
      formatBytes(item.size),
      formatTime(item.last_seen_at),
      item.content_hash ? `${item.content_hash.slice(0, 12)}…` : "-",
      item.open_issue_count > 0 ? String(item.open_issue_count) : "-",
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 0) cell.className = "file-path";
      if (index === 5 && item.content_hash) cell.title = item.content_hash;
      row.appendChild(cell);
    });
    row.addEventListener("click", () => {
      void toggleFileDetail(item.id);
    });
    tbody.appendChild(row);
  }

  const pages = Math.max(1, Math.ceil(filesTotal / filesLimit));
  const page = Math.floor(filesOffset / filesLimit) + 1;
  $("files-total").textContent = `共 ${filesTotal} 条 · 第 ${page}/${pages} 页`;
  $("files-prev").disabled = filesOffset <= 0;
  $("files-next").disabled = filesOffset + filesLimit >= filesTotal;
}

function hideFileDetail() {
  selectedFileId = null;
  hide($("file-detail"));
  $("file-detail").replaceChildren();
}

function detailCopyButton(text) {
  const button = document.createElement("button");
  button.className = "ghost";
  button.type = "button";
  button.textContent = "复制完整路径";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制完整路径";
      }, 1200);
    } catch {
      button.textContent = "复制失败";
    }
  });
  return button;
}

async function toggleFileDetail(pathId) {
  if (selectedFileId === pathId) {
    hideFileDetail();
    return;
  }
  selectedFileId = pathId;
  const panel = $("file-detail");
  show(panel);
  panel.replaceChildren(Object.assign(document.createElement("div"), {
    className: "muted",
    textContent: "加载文件详情…",
  }));
  try {
    const detail = await FileService.FileDetail(pathId);
    if (selectedFileId !== pathId) return;
    renderFileDetail(detail);
  } catch (error) {
    panel.replaceChildren(Object.assign(document.createElement("div"), {
      className: "error",
      textContent: error?.message || String(error),
    }));
  }
}

function renderFileDetail(detail) {
  const panel = $("file-detail");
  panel.replaceChildren();
  const file = detail.file ?? {};
  const mount = detail.mount ?? {};
  const machine = detail.machine ?? {};

  const header = document.createElement("div");
  header.className = "toolbar";
  header.style.justifyContent = "space-between";
  const title = document.createElement("h2");
  title.textContent = "文件详情";
  header.appendChild(title);
  const close = document.createElement("button");
  close.className = "ghost";
  close.type = "button";
  close.textContent = "关闭";
  close.addEventListener("click", hideFileDetail);
  header.appendChild(close);
  panel.appendChild(header);

  const relative = file.path_key ?? "";
  const base = String(mount.physical_path ?? "").replace(/[\\/]+$/, "");
  const fullPath = base ? `${base}\\${relative.replace(/\//g, "\\")}` : relative;

  const pathLine = document.createElement("p");
  pathLine.className = "file-path";
  pathLine.textContent = fullPath;
  panel.appendChild(pathLine);

  const info = document.createElement("p");
  info.className = "muted";
  info.textContent =
    `${machine.machine_id ?? "-"} / ${mount.mount_id ?? "-"} · ${fileStateLabel(file.state)}` +
    ` · ${formatBytes(file.size)} · 最后发现 ${formatTime(file.last_seen_at)}` +
    ` · 最后哈希 ${formatTime(file.last_hashed_at)}` +
    ` · 异常 ${file.open_issue_count ?? 0}`;
  panel.appendChild(info);

  if (file.content_hash) {
    const hashLine = document.createElement("p");
    hashLine.className = "muted file-path";
    hashLine.textContent = `SHA-256: ${file.content_hash}`;
    panel.appendChild(hashLine);
  }
  const actions = document.createElement("div");
  actions.className = "toolbar";
  actions.appendChild(detailCopyButton(fullPath));
  panel.appendChild(actions);

  const issues = detail.issues ?? [];
  const issuesHeading = document.createElement("h2");
  issuesHeading.textContent = `异常（${issues.length}）`;
  panel.appendChild(issuesHeading);
  if (issues.length === 0) {
    const none = document.createElement("div");
    none.className = "muted";
    none.textContent = "无异常记录";
    panel.appendChild(none);
  } else {
    const table = document.createElement("table");
    table.className = "jobs";
    table.innerHTML = "<thead><tr><th>类型</th><th>状态</th><th>次数</th><th>最近</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const issue of issues) {
      const row = document.createElement("tr");
      for (const value of [
        issue.type ?? "-",
        issue.status ?? "-",
        String(issue.occurrences ?? 0),
        formatTime(issue.last_seen_at),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  const observations = detail.observations ?? [];
  const historyHeading = document.createElement("h2");
  historyHeading.textContent = `最近观测（${observations.length}）`;
  panel.appendChild(historyHeading);
  if (observations.length === 0) {
    const none = document.createElement("div");
    none.className = "muted";
    none.textContent = "暂无观测记录";
    panel.appendChild(none);
  } else {
    const table = document.createElement("table");
    table.className = "jobs";
    table.innerHTML = "<thead><tr><th>哈希</th><th>类型</th><th>时间</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const observation of observations) {
      const row = document.createElement("tr");
      for (const value of [
        String(observation.hash ?? "").slice(0, 16),
        observation.kind ?? "-",
        formatTime(observation.observed_at),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("open-hub").addEventListener("click", () => openHub(hubUrl));
  $("setup-open-hub").addEventListener("click", () => {
    openHub($("setup-hub").value.trim() || "http://127.0.0.1:8787");
  });

  const unlockProbe = () => {
    $("setup-machine-id").readOnly = false;
    $("setup-probe-status").textContent =
      "已有节点：粘贴接入 token 后点识别，自动填充机器与挂载点。";
  };
  $("setup-hub").addEventListener("input", unlockProbe);
  $("setup-token").addEventListener("input", unlockProbe);

  $("setup-probe").addEventListener("click", async () => {
    const status = $("setup-probe-status");
    status.textContent = "识别中…";
    try {
      const result = await ConfigService.ProbeExistingNode({
        hub: $("setup-hub").value.trim(),
        token: $("setup-token").value.trim(),
      });
      $("setup-machine-id").value = result.machine_id || "";
      $("setup-machine-id").readOnly = true;
      if (result.label) {
        $("setup-label").value = result.label;
      }
      setupMounts = (result.mounts ?? []).map((mount) => mountToInput(mount));
      renderMounts($("setup-mounts"), setupMounts, { idEditable: true });
      status.textContent = `已识别节点 ${result.machine_id}（${setupMounts.length} 个挂载点），确认目录后保存`;
      hide($("setup-error"));
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
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
  $("nav-files").addEventListener("click", () => switchTab("files"));
  $("nav-settings").addEventListener("click", () => switchTab("settings"));
  $("files-refresh").addEventListener("click", () => void loadFiles(false));
  $("files-reset").addEventListener("click", () => {
    $("files-q").value = "";
    $("files-mount").value = "";
    $("files-state").value = "";
    $("files-issue").value = "";
    $("files-hash").value = "";
    $("files-sort").value = "path";
    $("files-order").value = "asc";
    void loadFiles(true);
  });
  for (const id of ["files-mount", "files-state", "files-issue", "files-hash", "files-sort", "files-order"]) {
    $(id).addEventListener("change", () => void loadFiles(true));
  }
  $("files-q").addEventListener("input", () => {
    if (filesQueryTimer) clearTimeout(filesQueryTimer);
    filesQueryTimer = setTimeout(() => {
      filesQueryTimer = null;
      void loadFiles(true);
    }, 300);
  });
  $("files-prev").addEventListener("click", () => {
    filesOffset = Math.max(0, filesOffset - filesLimit);
    void loadFiles(false);
  });
  $("files-next").addEventListener("click", () => {
    if (filesOffset + filesLimit < filesTotal) {
      filesOffset += filesLimit;
      void loadFiles(false);
    }
  });
  $("files-open-hub").addEventListener("click", () => {
    const machine = latestStatus?.machine_id || "";
    const suffix = machine ? `?machine_id=${encodeURIComponent(machine)}` : "";
    openHub(`${hubUrl || "http://127.0.0.1:8787"}/files${suffix}`);
  });
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
