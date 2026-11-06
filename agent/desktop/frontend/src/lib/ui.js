import { Browser } from "@wailsio/runtime";
import { append, clear, el } from "./dom.js";
import { labelOf } from "./labels.js";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function root(id) {
  return document.getElementById(id);
}

/** 对话框/抽屉通用：焦点循环、Esc 关闭、锁滚动、关闭后还原焦点。 */
function trapFocus(panel, onClose) {
  const previous = document.activeElement;
  const focusables = () =>
    Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
  (focusables()[0] ?? panel).focus();

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeyDown, true);
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    document.body.style.overflow = previousOverflow;
    previous?.focus?.();
  };
}

export function toast(message, options = {}) {
  const container = root("toast-root");
  if (!container) return;
  const tone = options.tone ?? "info";
  let card;
  card = el(
    "div",
    { class: `toast toast--${tone}`, role: tone === "danger" ? "alert" : "status" },
    [
      el("div", { class: "toast-body" }, [
        el("div", { class: "toast-title", text: message }),
        options.description ? el("div", { class: "toast-desc", text: options.description }) : null,
      ]),
      el("button", {
        class: "toast-close",
        type: "button",
        "aria-label": "关闭提示",
        text: "×",
        onClick: () => card.remove(),
      }),
    ],
  );
  container.append(card);
  while (container.children.length > 3) container.firstElementChild.remove();
  window.setTimeout(() => card.remove(), tone === "danger" ? 8000 : 4500);
}

export function badgeNode(text, tone = "neutral", dot = true) {
  return el("span", { class: `badge badge--${tone}` }, [
    dot ? el("span", { class: "dot", "aria-hidden": "true" }) : null,
    el("span", { text: text }),
  ]);
}

export function statusBadge(map, value, dot = true) {
  const labeled = labelOf(map, value);
  return badgeNode(labeled.label, labeled.tone, dot);
}

export function progressNode({ value, indeterminate = false, label = "进度" } = {}) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const clamped = hasValue ? Math.min(1, Math.max(0, value)) : 0;
  const bar = el(
    "div",
    {
      class: `progress${indeterminate ? " progress--indeterminate" : ""}`,
      role: "progressbar",
      "aria-label": label,
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": hasValue && !indeterminate ? Math.round(clamped * 100) : undefined,
    },
    [el("span", { style: hasValue && !indeterminate ? { width: `${clamped * 100}%` } : null })],
  );
  return bar;
}

export function emptyNode({ title, description, actions = [] }) {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-title", text: title }),
    description ? el("div", { class: "empty-desc", text: description }) : null,
    actions.length > 0 ? el("div", { class: "empty-actions" }, actions) : null,
  ]);
}

export function openExternal(url) {
  if (!url) return;
  Browser.OpenURL(url).catch(() => window.open(url, "_blank"));
}

export async function copyValue(value, label = "内容") {
  try {
    await navigator.clipboard.writeText(String(value ?? ""));
    toast(`已复制${label}`, { tone: "ok" });
  } catch {
    toast("复制失败", { tone: "danger", description: "浏览器不允许访问剪贴板，请手动选中复制。" });
  }
}

export function setBusy(button, busy, busyText = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
    button.disabled = false;
  }
}

/** 确认对话框；返回 Promise<boolean>。requireText 需原样输入才能确认。 */
export function confirmDialog({
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  tone = "primary",
  requireText = "",
} = {}) {
  return new Promise((resolve) => {
    const host = root("modal-root");
    if (!host) {
      resolve(window.confirm(title));
      return;
    }
    let cleanup = () => {};
    const close = (result) => {
      cleanup();
      host.replaceChildren();
      resolve(result);
    };

    const input = requireText
      ? el("input", { class: "input", type: "text", autocomplete: "off", "aria-label": requireText })
      : null;
    const confirmButton = el("button", {
      class: tone === "danger" ? "btn btn-danger-solid" : "btn btn-primary",
      type: "button",
      text: confirmText,
      disabled: Boolean(requireText),
      onClick: () => close(true),
    });
    if (input) {
      input.addEventListener("input", () => {
        confirmButton.disabled = input.value !== requireText;
      });
    }
    const cancelButton = el("button", {
      class: "btn",
      type: "button",
      text: cancelText,
      onClick: () => close(false),
    });

    const panel = el("div", { class: "dialog", role: "dialog", "aria-modal": "true", tabindex: -1 }, [
      el("div", { class: "dialog-title", text: title }),
      description ? el("div", { class: "dialog-body", text: description }) : null,
      requireText
        ? el("div", { class: "field", style: { marginTop: "12px" } }, [
            el("span", { class: "field-label", text: `输入「${requireText}」以确认` }),
            input,
          ])
        : null,
      el("div", { class: "dialog-foot" }, [cancelButton, confirmButton]),
    ]);
    const overlay = el(
      "div",
      {
        class: "dialog-overlay",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close(false);
        },
      },
      [panel],
    );
    host.replaceChildren(overlay);
    cleanup = trapFocus(panel, () => close(false));
    panel.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !confirmButton.disabled &&
        event.target.tagName !== "BUTTON" &&
        !event.isComposing
      ) {
        event.preventDefault();
        close(true);
      }
    });
    (input ?? cancelButton).focus();
  });
}

/** 右侧抽屉；返回 { close, body, setTitle, setSubtitle, setFooter }。 */
export function openDrawer({ title, subtitle, content, footer, onClose } = {}) {
  const host = root("drawer-root");
  if (!host) return { close: () => {}, body: null };
  let cleanup = () => {};
  const body = el("div", { class: "drawer-body" }, content ?? null);
  const titleNode = el("div", { class: "drawer-title", id: "drawer-title", text: title });
  const subtitleNode = el("div", { class: "drawer-sub" });
  if (subtitle) subtitleNode.textContent = subtitle;
  else subtitleNode.classList.add("hidden");
  const footerNode = el("div", { class: "drawer-foot" }, footer ?? null);
  if (!footer) footerNode.classList.add("hidden");

  const close = () => {
    cleanup();
    host.replaceChildren();
    onClose?.();
  };
  const panel = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", tabindex: -1 }, [
    el("div", { class: "drawer-head" }, [
      el("div", {}, [titleNode, subtitleNode]),
      el("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        "aria-label": "关闭",
        text: "×",
        onClick: close,
      }),
    ]),
    body,
    footerNode,
  ]);
  const overlay = el(
    "div",
    {
      class: "drawer-overlay",
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) close();
      },
    },
    [panel],
  );
  host.replaceChildren(overlay);
  cleanup = trapFocus(panel, close);
  return {
    close,
    body,
    panel,
    setTitle: (text) => {
      titleNode.textContent = text;
    },
    setSubtitle: (text) => {
      subtitleNode.textContent = text ?? "";
      subtitleNode.classList.toggle("hidden", !text);
    },
    setFooter: (nodes) => {
      footerNode.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
      footerNode.classList.toggle("hidden", !nodes || (Array.isArray(nodes) && nodes.length === 0));
    },
  };
}

export { append, clear, el };
