import { ConfigService, FileService } from "../../bindings/observer/agent/desktop";
import { el } from "../lib/dom.js";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelative,
  formatTime,
} from "../lib/format.js";
import { connectionState, jobMode, jobStatus, labelOf } from "../lib/labels.js";
import {
  badgeNode,
  copyValue,
  openExternal,
  progressNode,
  setBusy,
  statusBadge,
  toast,
} from "../lib/ui.js";

const FILE_QUERY = {
  q: "",
  mount_id: "",
  state: "",
  issue: "",
  hash: "",
  sort: "path",
  order: "asc",
  limit: 1,
  offset: 0,
};

function kpi(label, valueNode, hintNode) {
  return el("div", { class: "kpi" }, [
    el("span", { class: "kpi-label", text: label }),
    valueNode,
    hintNode,
  ]);
}

function metric(label, valueNode) {
  return el("div", { class: "metric" }, [
    el("div", { class: "metric-label", text: label }),
    valueNode,
  ]);
}

function jobStats(job) {
  const stats = job?.stats ?? {};
  return `发现 ${formatCount(stats.seen ?? 0)} · 校验 ${formatCount(stats.hashed ?? 0)} · 跳过 ${formatCount(stats.skipped ?? 0)}`;
}

function jobDuration(job) {
  if (!job?.started_at || !job?.finished_at) return "—";
  return formatDuration(job.finished_at - job.started_at);
}

export function createStatusView(container, options = {}) {
  const { onShowFiles = () => {} } = options;
  let currentStatus = null;
  let summary = null;
  let summaryError = null;
  let summarySeq = 0;
  let lastSummaryAttemptKey = null;
  let lastSummaryAttemptAt = 0;

  const machineValue = el("span", { class: "kpi-value kpi-value--sm" });
  const copyMachineButton = el("button", {
    class: "btn btn-ghost btn-sm",
    type: "button",
    text: "复制",
    onClick: () => currentStatus?.machine_id && copyValue(currentStatus.machine_id, "机器 ID"),
  });
  const connectionBadge = el("span", { class: "kpi-value" });
  const stateBadge = el("span", { class: "kpi-value" });
  const lastRunValue = el("span", { class: "kpi-value kpi-value--sm" });
  const lastRunHint = el("span", { class: "kpi-hint" });
  const versionValue = el("span", { class: "kpi-value kpi-value--sm", text: "—" });
  const versionHint = el("span", { class: "kpi-hint", text: "本机 Agent 构建版本" });

  const scanButton = el("button", { class: "btn btn-primary", type: "button", text: "立即同步" });
  const pauseButton = el("button", { class: "btn", type: "button", text: "暂停巡检" });
  const refreshButton = el("button", { class: "btn btn-ghost", type: "button", text: "刷新" });
  const openHubButton = el("button", { class: "btn btn-ghost", type: "button", text: "打开 hub" });
  const openIssuesButton = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "查看异常",
  });

  const actions = el("div", { class: "toolbar" }, [
    scanButton,
    pauseButton,
    el("span", { class: "grow" }),
    openIssuesButton,
    openHubButton,
    copyMachineButton,
    refreshButton,
  ]);

  const currentPanel = el("section", { class: "panel hidden" });
  const fileSummaryPanel = el("section", { class: "panel" });
  const statsPanel = el("section", { class: "panel" });
  const jobsPanel = el("section", { class: "panel" });
  const errorPanel = el("section", { class: "panel" });
  const liveRegion = el("div", { class: "sr-only", "aria-live": "polite" });

  container.append(
    el("div", { class: "kpi-grid" }, [
      kpi("机器", el("span", { class: "kpi-value" }, [machineValue, copyMachineButton]), null),
      kpi("hub 连接", connectionBadge, el("span", { class: "kpi-hint", text: "最近一次通信结果" })),
      kpi("巡检状态", stateBadge, el("span", { class: "kpi-hint", text: "暂停在当前任务结束后生效" })),
      kpi("最近巡检", lastRunValue, lastRunHint),
      kpi("版本", versionValue, versionHint),
    ]),
    actions,
    currentPanel,
    fileSummaryPanel,
    statsPanel,
    jobsPanel,
    errorPanel,
    liveRegion,
  );

  function connectionInfo(status) {
    if (status?.connected) return connectionState.connected;
    if (status?.last_error) return connectionState.disconnected;
    return connectionState.connecting;
  }

  function stateInfo(status) {
    if (status?.paused) return { label: "已暂停", tone: "warn" };
    if (status?.current) return { label: "巡检中", tone: "info" };
    if (status?.connected) return { label: "空闲", tone: "neutral" };
    if (status?.last_error) return { label: "未连接", tone: "danger" };
    return { label: "连接中…", tone: "warn" };
  }

  function renderConnection(status) {
    const info = connectionInfo(status);
    const badge = badgeNode(info.label, info.tone);
    if (status?.last_error) {
      badge.title = status.last_error;
    }
    connectionBadge.replaceChildren(badge);
  }

  function renderCurrent(status) {
    const current = status?.current;
    if (!current) {
      currentPanel.classList.add("hidden");
      currentPanel.replaceChildren();
      return;
    }
    currentPanel.classList.remove("hidden");
    const elapsed = current.started_at ? formatDuration(Date.now() - current.started_at) : "—";
    const progress = current.progress ?? {};
    currentPanel.replaceChildren(
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title", text: "当前任务" }),
          el("div", {
            class: "panel-sub",
            text: `#${current.job_id} · ${current.mount_id} · ${labelOf(jobMode, current.mode).label}`,
          }),
        ]),
        badgeNode("进行中", "info"),
      ]),
      progressNode({ indeterminate: true, label: "当前任务进度" }),
      el("div", { class: "status-line", style: { marginTop: "8px" } }, [
        el("span", { text: `已运行 ${elapsed}` }),
        el("span", { text: `已处理 ${formatCount(progress.seen ?? 0)}` }),
        el("span", { text: `已哈希 ${formatCount(progress.hashed ?? 0)}` }),
        el("span", { text: `跳过 ${formatCount(progress.skipped ?? 0)}` }),
        el("span", { text: `不可读 ${formatCount(progress.unreadable ?? 0)}` }),
        el("span", { text: `已读 ${formatBytes(progress.bytes_read ?? 0)}` }),
      ]),
    );
  }

  function renderSummary() {
    if (summaryError) {
      fileSummaryPanel.replaceChildren(
        el("div", { class: "panel-head" }, [
          el("div", { class: "panel-title", text: "本机文件" }),
          el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "重试",
            onClick: () => void loadSummary(true),
          }),
        ]),
        el("div", {
          class: "hint",
          text: `文件摘要暂不可用：${summaryError}`,
        }),
      );
      return;
    }
    if (summary === null) {
      fileSummaryPanel.replaceChildren(
        el("div", { class: "panel-head" }, [
          el("div", { class: "panel-title", text: "本机文件" }),
          el("div", { class: "hint", text: "正在读取…" }),
        ]),
      );
      return;
    }
    const data = summary ?? {};
    fileSummaryPanel.replaceChildren(
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title", text: "本机文件" }),
          el("div", { class: "panel-sub", text: "来自 hub 已入库的元数据" }),
        ]),
        el("div", { class: "toolbar" }, [
          el("button", {
            class: "btn btn-sm",
            type: "button",
            text: "打开文件页",
            onClick: () => onShowFiles(),
          }),
        ]),
      ]),
      el("div", { class: "metric-grid" }, [
        metric("入库文件", el("div", { class: "metric-value", text: formatCount(data.total ?? 0) })),
        metric("缺失", el("div", { class: "metric-value", text: formatCount(data.missing ?? 0) })),
        metric(
          "有异常",
          el("div", { class: "metric-value", text: formatCount(data.open_issue_paths ?? 0) }),
        ),
        metric("已校验", el("div", { class: "metric-value", text: formatCount(data.hashed ?? 0) })),
      ]),
    );
  }

  function renderStats(status, fallbackJob) {
    const stats = status?.last_stats ?? fallbackJob?.stats;
    if (!stats) {
      statsPanel.replaceChildren(
        el("div", { class: "panel-title", text: "最近一轮统计" }),
        el("div", { class: "hint", style: { marginTop: "8px" }, text: "还没有执行过巡检任务。" }),
      );
      return;
    }
    const fromHub = !status?.last_stats;
    const at = status?.last_run_at || fallbackJob?.finished_at;
    statsPanel.replaceChildren(
      el("div", { class: "panel-head" }, [
        el("div", { class: "panel-title", text: fromHub ? "最近任务统计（来自 hub）" : "最近一轮统计" }),
        el("div", { class: "hint", text: at ? formatTime(at) : "" }),
      ]),
      el("div", { class: "metric-grid" }, [
        metric("发现文件", el("div", { class: "metric-value", text: formatCount(stats.seen) })),
        metric("计算哈希", el("div", { class: "metric-value", text: formatCount(stats.hashed) })),
        metric("跳过", el("div", { class: "metric-value", text: formatCount(stats.skipped) })),
        metric("不可读", el("div", { class: "metric-value", text: formatCount(stats.unreadable) })),
        metric("读取字节", el("div", { class: "metric-value", text: formatBytes(stats.bytes_read) })),
        metric("耗时", el("div", { class: "metric-value", text: formatDuration(stats.duration_ms) })),
      ]),
    );
  }

  function renderJobs(status) {
    const jobs = status?.recent_jobs ?? [];
    const hub = status?.hub ?? "";
    const tbody = el("tbody");
    if (jobs.length === 0) {
      tbody.append(
        el("tr", {}, [
          el("td", { class: "muted", colspan: 8, text: "还没有巡检任务" }),
        ]),
      );
    } else {
      for (const job of jobs) {
        tbody.append(
          el("tr", {}, [
            el("td", { text: `#${job.id}` }),
            el("td", { text: job.mount_id ?? "-" }),
            el("td", {}, [statusBadge(jobMode, job.mode, false)]),
            el("td", {}, [statusBadge(jobStatus, job.status)]),
            el("td", {
              title: formatTime(job.started_at ?? job.created_at),
              text: formatRelative(job.started_at ?? job.created_at),
            }),
            el("td", { text: jobDuration(job) }),
            el("td", { class: "muted", text: jobStats(job) }),
            el("td", {}, [
              hub
                ? el("button", {
                    class: "btn btn-ghost btn-sm",
                    type: "button",
                    text: "hub",
                    onClick: () => openExternal(`${hub}/jobs/${job.id}`),
                  })
                : el("span", { class: "muted", text: "—" }),
            ]),
          ]),
        );
      }
    }
    jobsPanel.replaceChildren(
      el("div", { class: "panel-head" }, [
        el("div", { class: "panel-title", text: "最近任务" }),
        el("div", { class: "hint", text: "来自 hub 的任务历史" }),
      ]),
      el("div", { class: "table-wrap" }, [
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { scope: "col", text: "#" }),
              el("th", { scope: "col", text: "挂载点" }),
              el("th", { scope: "col", text: "模式" }),
              el("th", { scope: "col", text: "状态" }),
              el("th", { scope: "col", text: "开始" }),
              el("th", { scope: "col", text: "耗时" }),
              el("th", { scope: "col", text: "统计" }),
              el("th", { scope: "col", text: "操作" }),
            ]),
          ]),
          tbody,
        ]),
      ]),
    );
  }

  function renderError(status) {
    if (!status?.last_error) {
      errorPanel.replaceChildren(
        el("div", { class: "panel-title", text: "运行与错误" }),
        el("div", { class: "hint", style: { marginTop: "6px" }, text: "运行正常，最近没有错误。" }),
      );
      return;
    }
    const copyButton = el("button", {
      class: "btn btn-sm",
      type: "button",
      text: "复制错误",
      onClick: () => copyValue(status.last_error, "错误信息"),
    });
    errorPanel.replaceChildren(
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title", text: "最近错误" }),
          el("div", {
            class: "panel-sub",
            text: status.last_error_at ? formatTime(status.last_error_at) : "",
          }),
        ]),
        copyButton,
      ]),
      el("div", { class: "alert alert--danger", text: status.last_error }),
    );
  }

  function apply(status) {
    currentStatus = status ?? null;
    const s = currentStatus ?? {};

    machineValue.textContent = s.machine_id || "—";
    copyMachineButton.disabled = !s.machine_id;
    renderConnection(s);
    const state = stateInfo(s);
    stateBadge.replaceChildren(badgeNode(state.label, state.tone));
    versionValue.textContent = s.version || "—";
    const recent = s.recent_jobs ?? [];
    const latestHubJob = recent.find((job) => job.status === "completed" && job.finished_at);
    const lastRunAt = s.last_run_at || latestHubJob?.finished_at || null;
    lastRunValue.textContent = lastRunAt ? formatRelative(lastRunAt) : "尚未巡检";
    lastRunHint.textContent = s.last_run_at
      ? formatTime(s.last_run_at)
      : latestHubJob
        ? "来自 hub 最近任务（本机启动后尚未巡检）"
        : s.last_ok_at
          ? `最近通信 ${formatRelative(s.last_ok_at)}`
          : "等待首次巡检";

    scanButton.disabled = !s.machine_id || Boolean(s.paused) || Boolean(s.current);
    scanButton.title = s.paused
      ? "巡检已暂停"
      : s.current
        ? "巡检正在进行中"
        : "立即向 hub 拉取任务；排队中的巡检会马上执行";
    pauseButton.textContent = s.paused ? "继续巡检" : "暂停巡检";
    pauseButton.disabled = !s.machine_id;
    openHubButton.disabled = !s.hub;
    openIssuesButton.disabled = !s.hub || !s.machine_id;

    renderCurrent(s);
    renderStats(s, latestHubJob);
    renderJobs(s);
    renderError(s);
    renderSummary();
    void loadSummary(false);
    liveRegion.textContent = `连接：${connectionInfo(s).label}，状态：${state.label}`;
  }

  async function loadSummary(force) {
    const s = currentStatus;
    if (!s?.machine_id) {
      summary = null;
      summaryError = "尚未配置机器";
      renderSummary();
      return;
    }
    const key = s.last_run_at ?? -1;
    const now = Date.now();
    // 首次尝试可能早于 runner 初始化；失败后允许 5 秒重试。
    if (!force && key === lastSummaryAttemptKey && now - lastSummaryAttemptAt < 5_000) return;
    lastSummaryAttemptKey = key;
    lastSummaryAttemptAt = now;
    const seq = ++summarySeq;
    try {
      const result = await FileService.ListFiles(FILE_QUERY);
      if (seq !== summarySeq) return;
      summary = result.summary ?? null;
      summaryError = null;
    } catch (error) {
      if (seq !== summarySeq) return;
      summary = null;
      summaryError = error?.message || String(error);
    }
    renderSummary();
  }

  scanButton.addEventListener("click", async () => {
    setBusy(scanButton, true, "同步中…");
    try {
      const next = await ConfigService.ScanNow();
      apply(next);
      toast("已请求立即同步", { tone: "ok" });
    } catch (error) {
      toast("立即同步失败", { tone: "danger", description: error?.message || String(error) });
    } finally {
      setBusy(scanButton, false);
      apply(currentStatus);
    }
  });

  pauseButton.addEventListener("click", async () => {
    if (!currentStatus) return;
    const nextPaused = !currentStatus.paused;
    setBusy(pauseButton, true, nextPaused ? "暂停中…" : "继续中…");
    try {
      const next = await ConfigService.SetPaused(nextPaused);
      apply(next);
      toast(nextPaused ? "已暂停巡检" : "已继续巡检", { tone: "ok" });
    } catch (error) {
      toast("切换暂停状态失败", { tone: "danger", description: error?.message || String(error) });
    } finally {
      setBusy(pauseButton, false);
      apply(currentStatus);
    }
  });

  openHubButton.addEventListener("click", () => {
    const hub = currentStatus?.hub;
    if (!hub) return;
    openExternal(`${hub}/machines`);
  });
  openIssuesButton.addEventListener("click", () => {
    const hub = currentStatus?.hub;
    const machine = currentStatus?.machine_id;
    if (!hub || !machine) return;
    openExternal(`${hub}/issues?status=open&machine_id=${encodeURIComponent(machine)}`);
  });
  refreshButton.addEventListener("click", async () => {
    setBusy(refreshButton, true, "刷新中…");
    try {
      apply(await ConfigService.GetStatus());
      await loadSummary(true);
    } catch (error) {
      toast("刷新状态失败", { tone: "danger", description: error?.message || String(error) });
    } finally {
      setBusy(refreshButton, false);
    }
  });

  return {
    element: container,
    apply,
    getStatus: () => currentStatus,
    onShow: () => {
      void loadSummary(true);
    },
  };
}
