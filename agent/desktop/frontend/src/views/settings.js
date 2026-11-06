import { ConfigService } from "../../bindings/observer/agent/desktop";
import { el } from "../lib/dom.js";
import { copyValue, confirmDialog, setBusy, toast } from "../lib/ui.js";
import { formatTime } from "../lib/format.js";
import {
  createMount,
  mountFromHub,
  mountToPayload,
  renderMounts,
  validateMounts,
} from "./mountEditor.js";

function readOnlyField(label, valueNode) {
  return el("div", { class: "field" }, [
    el("span", { class: "field-label", text: label }),
    valueNode,
  ]);
}

export function createSettingsView(container, { onSaved = () => {} } = {}) {
  let settings = null;
  let status = null;
  let mounts = [];
  let loaded = false;
  let autostartBusy = false;
  let snapshot = "";

  const machineValue = el("input", { class: "input", disabled: true, value: "" });
  const hubValue = el("input", { class: "input", disabled: true, value: "" });
  const configPathValue = el("input", { class: "input", disabled: true, value: "" });
  const stateDirValue = el("input", { class: "input", disabled: true, value: "" });
  const versionValue = el("input", { class: "input", disabled: true, value: "—" });
  const autostartRow = el("label", { class: "field-checkbox" });
  const autostartInput = el("input", { type: "checkbox" });

  const labelInput = el("input", { type: "text", placeholder: "可选", autocomplete: "off" });
  const mountList = el("div", { class: "mount-list" });
  const dirtyHint = el("div", { class: "hint" });
  const saveButton = el("button", { class: "btn btn-primary", type: "button", text: "保存设置" });
  saveButton.disabled = true;
  const loadError = el("div", { class: "alert alert--danger hidden", role: "alert" });

  const addMountButton = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "新增挂载点",
    onClick: () => {
      mounts.push(createMount());
      renderMountList();
      markDirty();
    },
  });

  const copyMachine = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "复制",
    onClick: () => copyValue(settings?.machine_id ?? "", "机器 ID"),
  });
  const copyHub = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "复制",
    onClick: () => copyValue(settings?.hub ?? "", "hub 地址"),
  });
  const copyConfig = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "复制",
    onClick: () => copyValue(settings?.config_path ?? "", "配置路径"),
  });
  const copyStateDir = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "复制",
    onClick: () => copyValue(settings?.state_dir ?? "", "状态目录"),
  });

  const openConfigButton = el("button", {
    class: "btn",
    type: "button",
    text: "打开配置目录",
    onClick: async () => {
      try {
        await ConfigService.OpenConfigFolder();
      } catch (error) {
        toast("打开配置目录失败", { tone: "danger", description: error?.message || String(error) });
      }
    },
  });
  const copyDiagnosticsButton = el("button", {
    class: "btn",
    type: "button",
    text: "复制诊断信息",
    onClick: () => {
      const lines = [
        `机器: ${settings?.machine_id ?? "-"}`,
        `hub: ${settings?.hub ?? "-"}`,
        `配置: ${settings?.config_path ?? "-"}`,
        `状态目录: ${settings?.state_dir ?? "-"}`,
        `版本: ${status?.version ?? "-"}`,
        `连接: ${status?.connected ? "已连接" : "未连接"}`,
        `最近错误: ${status?.last_error ? `${status.last_error} @ ${formatTime(status.last_error_at)}` : "无"}`,
      ];
      void copyValue(lines.join("\n"), "诊断信息");
    },
  });
  const quitButton = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "退出应用",
    onClick: async () => {
      const confirmed = await confirmDialog({
        title: "退出 Observer Agent？",
        description: "退出后本机不再巡检；可从开始菜单或开机启动重新打开。",
        confirmText: "退出",
        tone: "danger",
      });
      if (confirmed) ConfigService.QuitApp();
    },
  });

  container.append(
    el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title", text: "连接信息" }),
          el("div", { class: "panel-sub", text: "机器、hub 地址与状态目录为只读；更换请重新走首次配置。" }),
        ]),
      ]),
      el("div", { class: "form-grid" }, [
        readOnlyField(
          "机器 ID",
          el("div", { class: "row" }, [machineValue, copyMachine]),
        ),
        readOnlyField("hub 地址", el("div", { class: "row" }, [hubValue, copyHub])),
        readOnlyField(
          "配置文件",
          el("div", { class: "row" }, [configPathValue, copyConfig]),
        ),
        readOnlyField(
          "状态目录",
          el("div", { class: "row" }, [stateDirValue, copyStateDir]),
        ),
        readOnlyField("Agent 版本", versionValue),
        autostartRow,
      ]),
      loadError,
    ]),
    el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title", text: "显示名称与挂载点" }),
          el("div", {
            class: "panel-sub",
            text: "保存会重启巡检进程；修改目录只影响本机扫描，hub 显示的是注册快照。",
          }),
        ]),
        addMountButton,
      ]),
      el("label", { class: "field", style: { maxWidth: "320px", marginBottom: "12px" } }, [
        el("span", { class: "field-label", text: "显示名称" }),
        labelInput,
      ]),
      mountList,
      el("p", {
        class: "hint",
        style: { marginTop: "8px" },
        text: "调度/限速/只读等高级配置请编辑 YAML；新增挂载点后建议在 hub Web 触发一次基线巡检。",
      }),
      el("div", { class: "save-bar" }, [dirtyHint, saveButton]),
    ]),
    el("section", { class: "panel" }, [
      el("div", { class: "panel-title", text: "维护" }),
      el("div", { class: "toolbar", style: { marginTop: "12px" } }, [
        openConfigButton,
        copyDiagnosticsButton,
        el("span", { class: "grow" }),
        quitButton,
      ]),
    ]),
  );

  autostartRow.append(autostartInput, el("span", { text: "开机启动（当前用户）" }));
  autostartInput.addEventListener("change", async () => {
    if (autostartBusy) return;
    autostartBusy = true;
    autostartInput.disabled = true;
    try {
      const next = await ConfigService.SetAutostart(autostartInput.checked);
      status = next ?? status;
      autostartInput.checked = Boolean(status?.autostart);
      toast(next?.autostart ? "已开启开机启动" : "已关闭开机启动", { tone: "ok" });
    } catch (error) {
      autostartInput.checked = Boolean(status?.autostart);
      toast("设置开机启动失败", { tone: "danger", description: error?.message || String(error) });
    } finally {
      autostartBusy = false;
      autostartInput.disabled = false;
    }
  });

  labelInput.addEventListener("input", markDirty);

  function renderMountList() {
    renderMounts(
      mountList,
      mounts,
      { idEditable: false, onChange: markDirty },
      renderMountList,
    );
  }

  function currentPayload() {
    return {
      label: labelInput.value.trim(),
      mounts: mounts.map(mountToPayload),
    };
  }

  function markDirty() {
    const dirty = JSON.stringify(currentPayload()) !== snapshot;
    dirtyHint.textContent = dirty ? "有未保存的修改" : "";
    saveButton.disabled = !dirty;
    return dirty;
  }

  function applySettings(next) {
    settings = next ?? {};
    machineValue.value = settings.machine_id ?? "-";
    machineValue.title = machineValue.value;
    hubValue.value = settings.hub ?? "-";
    hubValue.title = hubValue.value;
    configPathValue.value = settings.config_path ?? "-";
    configPathValue.title = configPathValue.value;
    stateDirValue.value = settings.state_dir ?? "-";
    stateDirValue.title = stateDirValue.value;
    labelInput.value = settings.label ?? "";
    mounts = (settings.mounts ?? []).map(mountFromHub);
    renderMountList();
    snapshot = JSON.stringify(currentPayload());
    markDirty();
  }

  function applyStatus(next) {
    status = next ?? null;
    versionValue.value = status?.version ?? "—";
    autostartRow.classList.toggle("hidden", !status?.autostart_supported);
    if (!autostartBusy) autostartInput.checked = Boolean(status?.autostart);
  }

  async function load() {
    loadError.classList.add("hidden");
    try {
      const [settingsState, statusState] = await Promise.all([
        ConfigService.GetSettings(),
        ConfigService.GetStatus(),
      ]);
      applySettings(settingsState);
      applyStatus(statusState);
      loaded = true;
    } catch (error) {
      loadError.textContent = error?.message || String(error);
      loadError.classList.remove("hidden");
    }
  }

  saveButton.addEventListener("click", async () => {
    const problems = validateMounts(mounts);
    if (problems.length > 0) {
      toast("挂载点配置有问题", { tone: "warn", description: problems[0] });
      return;
    }
    const confirmed = await confirmDialog({
      title: "保存设置并重启巡检？",
      description: "保存后当前巡检进程会重启以应用新配置；正在执行的任务会被中断。",
      confirmText: "保存并重启",
    });
    if (!confirmed) return;
    setBusy(saveButton, true, "保存中…");
    try {
      const result = await ConfigService.SaveSettings(currentPayload());
      applySettings(result);
      toast("设置已保存，巡检进程正在重启", { tone: "ok" });
      onSaved();
    } catch (error) {
      toast("保存设置失败", { tone: "danger", description: error?.message || String(error) });
    } finally {
      setBusy(saveButton, false);
      markDirty();
    }
  });

  return {
    show: async () => {
      if (!loaded) await load();
      else {
        try {
          applyStatus(await ConfigService.GetStatus());
        } catch {
          // 状态刷新失败不阻断设置页
        }
      }
    },
    updateStatus: applyStatus,
    hasUnsavedChanges: () => JSON.stringify(currentPayload()) !== snapshot,
    confirmLeave: async () => {
      if (!settings || JSON.stringify(currentPayload()) === snapshot) return true;
      return confirmDialog({
        title: "放弃未保存的修改？",
        description: "切换标签会丢失当前页尚未保存的修改。",
        confirmText: "放弃修改",
        tone: "danger",
      });
    },
    reload: load,
  };
}
