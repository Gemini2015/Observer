import { Dialogs } from "@wailsio/runtime";
import { el } from "../lib/dom.js";
import { toast, confirmDialog } from "../lib/ui.js";

export const MOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createMount() {
  return {
    id: "",
    label: "",
    path: "",
    sentinel: "",
    exclude: [],
    repair_allowed: false,
    isNew: true,
  };
}

export function mountFromHub(mount) {
  return {
    id: mount?.id ?? "",
    label: mount?.label ?? "",
    path: mount?.path ?? "",
    sentinel: mount?.sentinel ?? "",
    exclude: Array.isArray(mount?.exclude) ? [...mount.exclude] : [],
    repair_allowed: Boolean(mount?.repair_allowed),
    isNew: false,
  };
}

export function mountToPayload(mount) {
  return {
    id: String(mount.id ?? "").trim(),
    label: String(mount.label ?? "").trim(),
    path: String(mount.path ?? "").trim(),
    sentinel: String(mount.sentinel ?? "").trim(),
    exclude: [...(mount.exclude ?? [])],
    repair_allowed: Boolean(mount.repair_allowed),
  };
}

export function validateMounts(mounts) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(mounts) || mounts.length === 0) {
    return ["至少需要一个挂载点"];
  }
  mounts.forEach((mount, index) => {
    const id = String(mount.id ?? "").trim();
    const path = String(mount.path ?? "").trim();
    const sentinel = String(mount.sentinel ?? "").trim();
    const prefix = `挂载点 ${index + 1}`;
    if (!MOUNT_ID_PATTERN.test(id)) {
      problems.push(`${prefix}：ID 需匹配 ${MOUNT_ID_PATTERN}（小写字母/数字/-/_，最长 32）`);
    } else if (seen.has(id)) {
      problems.push(`${prefix}：ID「${id}」重复`);
    } else {
      seen.add(id);
    }
    if (!path) problems.push(`${prefix}：目录不能为空`);
    if (sentinel.startsWith("/") || sentinel.includes("..")) {
      problems.push(`${prefix}：sentinel 必须是挂载目录内的相对路径`);
    }
  });
  return problems;
}

function makeInput(placeholder, value) {
  return el("input", {
    type: "text",
    placeholder,
    value: value ?? "",
    autocomplete: "off",
  });
}

/**
 * 渲染挂载点编辑器。
 * options: { idEditable, onChange, confirmDelete }
 */
export function renderMounts(container, mounts, options = {}, rerender) {
  const { idEditable = false, onChange = () => {} } = options;
  const notify = () => onChange();
  container.replaceChildren();

  mounts.forEach((mount) => {
    const idInput = makeInput("挂载点 ID（如 data）", mount.id);
    idInput.disabled = !(idEditable || mount.isNew);
    idInput.addEventListener("input", () => {
      mount.id = idInput.value;
      notify();
    });

    const removeButton = el("button", {
      class: "btn btn-ghost btn-sm",
      type: "button",
      text: "删除",
      onClick: async () => {
        if (mounts.length <= 1) {
          toast("至少保留一个挂载点", { tone: "warn" });
          return;
        }
        const confirmed = await confirmDialog({
          title: `删除挂载点「${mount.id || "未命名"}」？`,
          description: "保存后该挂载点会从配置中移除；hub 上对应的历史数据会保留，重新添加需重新注册该挂载点。",
          confirmText: "删除",
          tone: "danger",
        });
        if (!confirmed) return;
        const index = mounts.indexOf(mount);
        if (index >= 0) mounts.splice(index, 1);
        notify();
        rerender?.();
      },
    });

    const head = el("div", { class: "mount-row-head" }, [
      el("label", { class: "field" }, [
        el("span", { class: "field-label", text: "挂载点 ID" }),
        idInput,
      ]),
      removeButton,
    ]);

    const labelInput = makeInput("可选", mount.label);
    labelInput.addEventListener("input", () => {
      mount.label = labelInput.value;
      notify();
    });

    const sentinelInput = makeInput(".observer-mount", mount.sentinel);
    sentinelInput.addEventListener("input", () => {
      mount.sentinel = sentinelInput.value;
      notify();
    });

    const pathInput = makeInput("例如 D:\\ObserverData", mount.path);
    pathInput.addEventListener("input", () => {
      mount.path = pathInput.value;
      notify();
    });
    const browseButton = el("button", {
      class: "btn",
      type: "button",
      text: "浏览…",
      onClick: async () => {
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
            notify();
          }
        } catch {
          // 用户取消或对话框不可用
        }
      },
    });

    const excludeInput = el("textarea", {
      rows: 2,
      placeholder: "每行一个 exclude 规则（留空使用默认）",
      value: (mount.exclude ?? []).join("\n"),
    });
    excludeInput.addEventListener("input", () => {
      mount.exclude = excludeInput.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      notify();
    });

    const repairInput = el("input", { type: "checkbox", checked: Boolean(mount.repair_allowed) });
    repairInput.addEventListener("change", () => {
      mount.repair_allowed = repairInput.checked;
      notify();
    });

    const grid = el("div", { class: "form-grid" }, [
      el("label", { class: "field" }, [
        el("span", { class: "field-label", text: "显示名称" }),
        labelInput,
      ]),
      el("label", { class: "field" }, [
        el("span", { class: "field-label", text: "sentinel（可选）" }),
        sentinelInput,
      ]),
      el("label", { class: "field field-full" }, [
        el("span", { class: "field-label", text: "目录" }),
        el("div", { class: "path-field" }, [pathInput, browseButton]),
      ]),
      el("label", { class: "field field-full" }, [
        el("span", { class: "field-label", text: "排除规则（可选）" }),
        excludeInput,
      ]),
      el("label", { class: "field-checkbox" }, [repairInput, "允许作为跨机修复目标"]),
    ]);

    container.append(el("div", { class: "mount-row" }, [head, grid]));
  });
}
