import { ConfigService } from "../bindings/observer/agent/desktop";
import { Events } from "@wailsio/runtime";
import { byId, setHidden } from "./lib/dom.js";
import { openExternal, toast } from "./lib/ui.js";
import { createStatusView } from "./views/status.js";
import { createFilesView } from "./views/files.js";
import { createSettingsView } from "./views/settings.js";
import { createSetupView } from "./views/setup.js";

const TABS = [
  { key: "status", button: "nav-status", view: "status-view" },
  { key: "files", button: "nav-files", view: "files-view" },
  { key: "settings", button: "nav-settings", view: "settings-view" },
];

const setupRoot = byId("setup-root");
const mainView = byId("main-view");
const connectionBadge = byId("conn");
const connectionText = byId("conn-text");
const brandSub = byId("brand-sub");
const footerVersion = byId("footer-version");

let latestStatus = null;
let activeTab = "status";
let mainVisible = false;

const filesView = createFilesView(byId("files-view"), {
  getMachineId: () => latestStatus?.machine_id ?? "",
  getHub: () => latestStatus?.hub ?? "",
});

const statusView = createStatusView(byId("status-view"), {
  onShowFiles: () => void switchTab("files"),
});

const settingsView = createSettingsView(byId("settings-view"), {
  onSaved: () => {
    filesView.invalidate();
    statusView.onShow();
  },
});

const setupView = createSetupView(setupRoot, {
  onDone: () => void enterMain(),
});

function normalizeStatus(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function renderConnection(status) {
  let text = "连接中…";
  let tone = "warn";
  if (status?.paused) {
    text = "已暂停";
    tone = "warn";
  } else if (status?.connected) {
    text = "已连接";
    tone = "ok";
  } else if (status?.last_error) {
    text = "未连接";
    tone = "danger";
  }
  connectionBadge.className = `badge badge--${tone}`;
  connectionText.textContent = text;
  connectionBadge.title = status?.last_error || text;

  brandSub.textContent = status?.machine_id
    ? `本机文件完整性巡检 · ${status.machine_id}`
    : "本机文件完整性巡检";
  footerVersion.textContent = `版本 ${status?.version || "—"}`;
}

function applyStatus(raw) {
  latestStatus = normalizeStatus(raw);
  renderConnection(latestStatus);
  if (!mainVisible) return;
  if (activeTab === "status") statusView.apply(latestStatus);
  if (activeTab === "settings") settingsView.updateStatus(latestStatus);
}

async function switchTab(key, { force = false } = {}) {
  if (!force && key !== activeTab && activeTab === "settings") {
    const allowed = await settingsView.confirmLeave();
    if (!allowed) return;
  }
  activeTab = key;
  for (const tab of TABS) {
    const button = byId(tab.button);
    const view = byId(tab.view);
    const selected = tab.key === key;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    setHidden(view, !selected);
  }
  if (key === "status") statusView.onShow();
  if (key === "files") filesView.show();
  if (key === "settings") await settingsView.show();
}

async function enterMain() {
  setHidden(setupRoot, true);
  setHidden(mainView, false);
  mainVisible = true;
  await switchTab("status", { force: true });
  try {
    applyStatus(await ConfigService.GetStatus());
  } catch (error) {
    toast("读取状态失败", { tone: "danger", description: error?.message || String(error) });
  }
}

function bindTabs() {
  for (const tab of TABS) {
    byId(tab.button).addEventListener("click", () => void switchTab(tab.key));
  }
  byId("tabs").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.key === activeTab);
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    byId(TABS[next].button).focus();
    void switchTab(TABS[next].key);
  });
  byId("footer-open-hub").addEventListener("click", () => {
    if (!latestStatus?.hub) {
      toast("还没有配置 hub 地址", { tone: "warn" });
      return;
    }
    openExternal(latestStatus.hub);
  });
}

async function boot() {
  bindTabs();
  window.addEventListener("error", (event) => {
    toast("界面发生错误", { tone: "danger", description: event.message });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    toast("操作失败", {
      tone: "danger",
      description: String(reason?.message ?? reason ?? "未知错误"),
    });
  });
  Events.On("status", (event) => applyStatus(event?.data));
  window.addEventListener("focus", () => {
    if (latestStatus) applyStatus(latestStatus);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && latestStatus) applyStatus(latestStatus);
  });

  try {
    const state = await ConfigService.GetSetupState();
    if (state?.needs_setup) {
      setHidden(mainView, true);
      setHidden(setupRoot, false);
      setupView.show(state);
      return;
    }
  } catch (error) {
    setHidden(mainView, true);
    setHidden(setupRoot, false);
    setupView.show({
      needs_setup: true,
      config_path: "",
      error: error?.message || String(error),
    });
    return;
  }
  await enterMain();
}

void boot();
