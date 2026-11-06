import { ConfigService } from "../../bindings/observer/agent/desktop";
import { el } from "../lib/dom.js";
import { openExternal, setBusy, toast } from "../lib/ui.js";
import {
  MOUNT_ID_PATTERN,
  createMount,
  mountFromHub,
  mountToPayload,
  renderMounts,
  validateMounts,
} from "./mountEditor.js";

const PLACEHOLDER_TOKENS = new Set(["", "paste-token-here", "placeholder-token", "change-me"]);

function isPlaceholderToken(value) {
  const token = String(value ?? "").trim();
  return PLACEHOLDER_TOKENS.has(token.toLowerCase()) || (token.startsWith("<") && token.endsWith(">"));
}

export function createSetupView(container, { onDone = () => {} } = {}) {
  let state = null;
  let mounts = [];

  const machineInput = el("input", { type: "text", placeholder: "例如 win-01", autocomplete: "off" });
  const labelInput = el("input", { type: "text", placeholder: "可选", autocomplete: "off" });
  const hubInput = el("input", { type: "text", placeholder: "http://127.0.0.1:8787", autocomplete: "off" });
  const tokenInput = el("input", {
    type: "password",
    placeholder: "注册 token 或接入 token",
    autocomplete: "off",
  });
  const stateDirInput = el("input", {
    type: "text",
    placeholder: "留空默认 .observer/<机器 ID>",
    autocomplete: "off",
  });
  const tokenToggle = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "显示",
    onClick: () => {
      const showing = tokenInput.type === "text";
      tokenInput.type = showing ? "password" : "text";
      tokenToggle.textContent = showing ? "显示" : "隐藏";
    },
  });

  const probeStatus = el("span", { class: "hint" });
  const probeButton = el("button", { class: "btn", type: "button", text: "识别已有节点" });
  const openHubButton = el("button", { class: "btn btn-ghost", type: "button", text: "打开 hub Web" });
  const configPathText = el("span", { class: "mono", text: "-" });
  const errorBox = el("div", { class: "alert alert--danger hidden", role: "alert" });
  const existingBox = el("div", { class: "alert alert--info hidden" });
  const mountList = el("div", { class: "mount-list" });
  const validationText = el("div", { class: "hint" });
  const saveButton = el("button", { class: "btn btn-primary", type: "button", text: "保存并启动" });

  const addMountButton = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "新增挂载点",
    onClick: () => {
      mounts.push(createMount());
      renderMountList();
      validate();
    },
  });

  container.append(
    el("header", { class: "topbar" }, [
      el("div", { class: "brand" }, [
        el("img", { class: "brand-icon", src: "/logo.svg", alt: "" }),
        el("div", {}, [
          el("div", { class: "brand-title", text: "Observer Agent" }),
          el("div", { class: "brand-sub", text: "首次配置" }),
        ]),
      ]),
      el("span", { class: "grow" }),
      el("span", { class: "badge badge--warn" }, [el("span", { class: "dot" }), "首次配置"]),
    ]),
    errorBox,
    existingBox,
    el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("div", {}, [
          el("div", { class: "panel-title" }, [el("span", { class: "step", text: "1" }), "连接中心服"]),
          el("div", { class: "panel-sub" }, ["配置文件：", configPathText]),
        ]),
      ]),
      el("div", { class: "form-grid" }, [
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "机器 ID" }),
          machineInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "显示名称" }),
          labelInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "hub 地址" }),
          hubInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label" }, [
            "注册 token / 接入 token",
            tokenToggle,
          ]),
          tokenInput,
        ]),
        el("label", { class: "field field-full" }, [
          el("span", { class: "field-label", text: "状态目录（可选）" }),
          stateDirInput,
        ]),
      ]),
      el("div", { class: "toolbar", style: { marginTop: "12px" } }, [
        openHubButton,
        probeButton,
        probeStatus,
      ]),
      el("p", {
        class: "hint",
        style: { marginTop: "8px" },
        text: "新节点用 hub「注册新机器」生成的一次性 token；已有节点用机器页的接入 token，点「识别已有节点」可自动带出机器与挂载点。",
      }),
    ]),
    el("section", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("div", {
          class: "panel-title",
        }, [el("span", { class: "step", text: "2" }), "挂载点"]),
        addMountButton,
      ]),
      mountList,
      el("p", {
        class: "hint",
        style: { marginTop: "8px" },
        text: "sentinel 可选：留空表示扫描整个目录；填写后目录里必须存在该文件且内容包含挂载点 ID，否则该挂载点会被跳过。删除挂载点需二次确认。",
      }),
    ]),
    el("div", { class: "save-bar" }, [
      validationText,
      el("div", { class: "toolbar" }, [saveButton]),
    ]),
  );

  function renderMountList() {
    renderMounts(
      mountList,
      mounts,
      { idEditable: true, onChange: validate },
      renderMountList,
    );
  }

  function collectProblems() {
    const problems = [];
    const machineID = machineInput.value.trim();
    const hub = hubInput.value.trim();
    if (!MOUNT_ID_PATTERN.test(machineID)) {
      problems.push(`机器 ID 需匹配 ${MOUNT_ID_PATTERN}`);
    }
    try {
      const parsed = new URL(hub);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push("hub 地址必须是 http(s) URL");
      }
    } catch {
      problems.push("hub 地址不是合法 URL");
    }
    if (isPlaceholderToken(tokenInput.value)) {
      problems.push("请填写注册 token 或接入 token");
    }
    problems.push(...validateMounts(mounts));
    return problems;
  }

  function validate() {
    const problems = collectProblems();
    validationText.textContent = problems.length === 0 ? "参数校验通过" : problems[0];
    validationText.title = problems.join("\n");
    saveButton.disabled = problems.length > 0;
    return problems;
  }

  function show(nextState) {
    state = nextState ?? {};
    container.classList.remove("hidden");
    const defaults = state.defaults ?? {};
    const prefill = state.prefill ?? {};
    configPathText.textContent = state.config_path || "-";
    machineInput.value = prefill.machine_id || defaults.machine_id || "";
    labelInput.value = prefill.label || defaults.label || "";
    hubInput.value = prefill.hub || defaults.hub || "http://127.0.0.1:8787";
    tokenInput.value = isPlaceholderToken(prefill.token) ? "" : prefill.token;
    stateDirInput.value = prefill.state_dir || "";
    mounts =
      Array.isArray(prefill.mounts) && prefill.mounts.length > 0
        ? prefill.mounts.map(mountFromHub)
        : [createMount()];
    renderMountList();
    probeStatus.textContent = "已有节点：粘贴接入 token 后点识别，自动填充机器与挂载点。";
    if (state.error) {
      errorBox.textContent = state.error;
      errorBox.classList.remove("hidden");
    } else {
      errorBox.classList.add("hidden");
    }
    existingBox.classList.toggle("hidden", !state.existing);
    existingBox.textContent = state.existing
      ? "检测到已有配置文件；补全缺失字段后保存，原文件会备份为 .bak。"
      : "";
    validate();
  }

  hubInput.addEventListener("input", () => {
    probeStatus.textContent = "已有节点：粘贴接入 token 后点识别，自动填充机器与挂载点。";
    validate();
  });
  tokenInput.addEventListener("input", validate);
  machineInput.addEventListener("input", validate);
  labelInput.addEventListener("input", validate);
  stateDirInput.addEventListener("input", validate);

  openHubButton.addEventListener("click", () => {
    const hub = hubInput.value.trim() || "http://127.0.0.1:8787";
    openExternal(hub);
  });

  probeButton.addEventListener("click", async () => {
    setBusy(probeButton, true, "识别中…");
    probeStatus.textContent = "正在连接 hub 校验 token…";
    try {
      const result = await ConfigService.ProbeExistingNode({
        hub: hubInput.value.trim(),
        token: tokenInput.value.trim(),
      });
      machineInput.value = result.machine_id || machineInput.value;
      if (result.label) labelInput.value = result.label;
      mounts = (result.mounts ?? []).map(mountFromHub);
      renderMountList();
      validate();
      probeStatus.textContent = `已识别节点 ${result.machine_id}（${mounts.length} 个挂载点）；来自 hub 的目录路径请按本机实际位置确认。`;
      errorBox.classList.add("hidden");
    } catch (error) {
      probeStatus.textContent = error?.message || String(error);
    } finally {
      setBusy(probeButton, false);
    }
  });

  saveButton.addEventListener("click", async () => {
    const problems = collectProblems();
    if (problems.length > 0) {
      validate();
      toast("请先修正配置问题", { tone: "warn", description: problems[0] });
      return;
    }
    setBusy(saveButton, true, "保存中…");
    try {
      const result = await ConfigService.SaveInitialConfig({
        machine_id: machineInput.value.trim(),
        label: labelInput.value.trim(),
        hub: hubInput.value.trim(),
        token: tokenInput.value.trim(),
        state_dir: stateDirInput.value.trim(),
        mounts: mounts.map(mountToPayload),
      });
      toast("配置已保存，正在启动巡检", { tone: "ok" });
      onDone(result);
    } catch (error) {
      toast("保存失败", { tone: "danger", description: error?.message || String(error) });
      errorBox.textContent = error?.message || String(error);
      errorBox.classList.remove("hidden");
    } finally {
      setBusy(saveButton, false);
      validate();
    }
  });

  return {
    show,
    setError: (message) => {
      errorBox.textContent = message;
      errorBox.classList.remove("hidden");
    },
  };
}
