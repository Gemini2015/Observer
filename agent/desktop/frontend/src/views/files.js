import { FileService } from "../../bindings/observer/agent/desktop";
import { el } from "../lib/dom.js";
import {
  decodePath,
  formatBytes,
  formatCount,
  formatNs,
  formatRelative,
  formatTime,
  joinPath,
  shortHash,
} from "../lib/format.js";
import {
  confidence,
  fileState,
  hashKind,
  issueStatus,
  issueType,
  labelOf,
  observationKind,
} from "../lib/labels.js";
import {
  copyValue,
  emptyNode,
  openDrawer,
  openExternal,
  statusBadge,
} from "../lib/ui.js";

const PAGE_SIZES = [50, 100];

const STATE_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "active", label: "正常" },
  { value: "missing", label: "缺失" },
  { value: "out_of_scope", label: "已移出规则" },
];

const ISSUE_OPTIONS = [
  { value: "", label: "全部" },
  { value: "open", label: "有未处理异常" },
  { value: "none", label: "无未处理异常" },
];

const HASH_OPTIONS = [
  { value: "", label: "全部" },
  { value: "hashed", label: "已哈希" },
  { value: "unhashed", label: "未哈希" },
];

const SORT_OPTIONS = [
  { value: "path", label: "路径" },
  { value: "size", label: "大小" },
  { value: "last_seen", label: "最后发现" },
  { value: "last_hashed", label: "最后哈希" },
  { value: "state", label: "状态" },
];

const ORDER_OPTIONS = [
  { value: "asc", label: "升序" },
  { value: "desc", label: "降序" },
];

function selectNode(options, value, onChange, label) {
  const node = el(
    "select",
    { class: "select", "aria-label": label, onChange: (event) => onChange(event.target.value) },
    options.map((option) => el("option", { value: option.value, text: option.label })),
  );
  node.value = value;
  return node;
}

function kv(items) {
  return el(
    "dl",
    { class: "kv" },
    items.flatMap(([label, value]) => [
      el("dt", { text: label }),
      el("dd", {}, value instanceof Node ? value : String(value ?? "—")),
    ]),
  );
}

function detailSection(title, children) {
  return el("section", { class: "stack" }, [
    el("div", { class: "section-title" }, [el("h3", { text: title })]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function fields(filters) {
  return {
    q: filters.q.trim(),
    mount_id: filters.mount,
    state: filters.state,
    issue: filters.issue,
    hash: filters.hash,
    sort: filters.sort,
    order: filters.order,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export function createFilesView(container, options = {}) {
  const { getMachineId = () => "", getHub = () => "" } = options;
  const filters = {
    mount: "",
    q: "",
    state: "",
    issue: "",
    hash: "",
    sort: "path",
    order: "asc",
    limit: PAGE_SIZES[0],
    offset: 0,
  };

  let rows = [];
  let total = 0;
  let summary = null;
  let loaded = false;
  let mountsLoaded = false;
  let lastError = null;
  let loading = false;
  let requestSeq = 0;
  let detailSeq = 0;
  let searchTimer = null;

  const refreshButton = el("button", { class: "btn", type: "button", text: "刷新" });
  const openHubButton = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "在 hub 中查看",
  });

  const mountSelect = selectNode([{ value: "", label: "全部挂载点" }], "", (value) => {
    filters.mount = value;
    applyFilters();
  }, "挂载点");
  const searchInput = el("input", {
    class: "input",
    type: "search",
    placeholder: "路径关键字或 64 位哈希",
    autocomplete: "off",
    "aria-label": "搜索路径",
  });
  const stateSelect = selectNode(STATE_OPTIONS, "", (value) => {
    filters.state = value;
    applyFilters();
  }, "文件状态");
  const issueSelect = selectNode(ISSUE_OPTIONS, "", (value) => {
    filters.issue = value;
    applyFilters();
  }, "异常筛选");
  const hashSelect = selectNode(HASH_OPTIONS, "", (value) => {
    filters.hash = value;
    applyFilters();
  }, "哈希筛选");
  const sortSelect = selectNode(SORT_OPTIONS, "path", (value) => {
    filters.sort = value;
    applyFilters();
  }, "排序");
  const orderSelect = selectNode(ORDER_OPTIONS, "asc", (value) => {
    filters.order = value;
    applyFilters();
  }, "顺序");
  const pageSizeSelect = selectNode(
    PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} / 页` })),
    String(filters.limit),
    (value) => {
      filters.limit = Number(value);
      filters.offset = 0;
      void load(true);
    },
    "每页条数",
  );

  const resetButton = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "重置筛选",
    onClick: () => resetFilters(),
  });

  const chips = el("div", { class: "chips" });
  const statusLine = el("div", { class: "status-line" });
  const errorBox = el("div", { class: "alert alert--danger hidden", role: "alert" });
  const tbody = el("tbody");
  const table = el("table", { class: "table table--files" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col", text: "路径" }),
        el("th", { scope: "col", text: "挂载点" }),
        el("th", { scope: "col", text: "状态" }),
        el("th", { scope: "col", class: "num", text: "大小" }),
        el("th", { scope: "col", text: "最后发现" }),
        el("th", { scope: "col", class: "num", text: "异常" }),
        el("th", { scope: "col", text: "操作" }),
      ]),
    ]),
    tbody,
  ]);
  const tableWrap = el("div", { class: "table-wrap" }, [table]);
  const emptyBox = el("div");
  const pageInfo = el("span", { class: "hint" });
  const prevButton = el("button", { class: "btn btn-sm", type: "button", text: "上一页" });
  const nextButton = el("button", { class: "btn btn-sm", type: "button", text: "下一页" });

  const filtersMore = el("details", { class: "filters-more" }, [
    el("summary", { text: "更多筛选" }),
    el("div", { class: "filter-grid", style: { marginTop: "8px" } }, [
      el("label", { class: "field" }, [
        el("span", { class: "field-label", text: "哈希" }),
        hashSelect,
      ]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "排序" }), sortSelect]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "顺序" }), orderSelect]),
      resetButton,
    ]),
  ]);

  container.append(
    el("div", { class: "toolbar" }, [
      el("div", { class: "panel-title", text: "本机文件" }),
      el("span", { class: "grow" }),
      refreshButton,
      openHubButton,
    ]),
    el("section", { class: "panel" }, [
      el("div", { class: "filter-grid" }, [
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "挂载点" }),
          mountSelect,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "搜索路径 / SHA-256" }),
          searchInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "状态" }),
          stateSelect,
        ]),
        el("label", { class: "field" }, [
          el("span", { class: "field-label", text: "异常" }),
          issueSelect,
        ]),
      ]),
      filtersMore,
      el("div", { class: "toolbar", style: { marginTop: "12px" } }, [chips, statusLine]),
      errorBox,
      tableWrap,
      emptyBox,
      el("div", { class: "toolbar", style: { justifyContent: "space-between", marginTop: "10px" } }, [
        el("div", { class: "toolbar" }, [pageInfo, pageSizeSelect]),
        el("div", { class: "toolbar" }, [prevButton, nextButton]),
      ]),
    ]),
  );

  function hasActiveFilters() {
    return Boolean(
      filters.q || filters.mount || filters.state || filters.issue || filters.hash,
    );
  }

  function resetFilters() {
    filters.q = "";
    filters.mount = "";
    filters.state = "";
    filters.issue = "";
    filters.hash = "";
    filters.sort = "path";
    filters.order = "asc";
    filters.offset = 0;
    searchInput.value = "";
    mountSelect.value = "";
    stateSelect.value = "";
    issueSelect.value = "";
    hashSelect.value = "";
    sortSelect.value = "path";
    orderSelect.value = "asc";
    void load(true);
  }

  function applyFilters() {
    filters.offset = 0;
    void load(true);
  }

  function renderChips() {
    chips.replaceChildren();
    const data = summary ?? {};
    const addChip = (label, active, onClick) => {
      chips.append(
        el("button", {
          class: `chip${active ? " active" : ""}`,
          type: "button",
          text: label,
          onClick,
        }),
      );
    };
    chips.append(el("span", { class: "chip chip-static", text: `共 ${formatCount(total)}` }));
    addChip(`正常 ${formatCount(data.active ?? 0)}`, filters.state === "active", () => {
      filters.state = filters.state === "active" ? "" : "active";
      stateSelect.value = filters.state;
      applyFilters();
    });
    addChip(`缺失 ${formatCount(data.missing ?? 0)}`, filters.state === "missing", () => {
      filters.state = filters.state === "missing" ? "" : "missing";
      stateSelect.value = filters.state;
      applyFilters();
    });
    addChip(`移出规则 ${formatCount(data.out_of_scope ?? 0)}`, filters.state === "out_of_scope", () => {
      filters.state = filters.state === "out_of_scope" ? "" : "out_of_scope";
      stateSelect.value = filters.state;
      applyFilters();
    });
    addChip(`有异常 ${formatCount(data.open_issue_paths ?? 0)}`, filters.issue === "open", () => {
      filters.issue = filters.issue === "open" ? "" : "open";
      issueSelect.value = filters.issue;
      applyFilters();
    });
    addChip(`已哈希 ${formatCount(data.hashed ?? 0)}`, filters.hash === "hashed", () => {
      filters.hash = filters.hash === "hashed" ? "" : "hashed";
      hashSelect.value = filters.hash;
      applyFilters();
    });
    addChip(`未哈希 ${formatCount(data.unhashed ?? 0)}`, filters.hash === "unhashed", () => {
      filters.hash = filters.hash === "unhashed" ? "" : "unhashed";
      hashSelect.value = filters.hash;
      applyFilters();
    });
    if (hasActiveFilters()) {
      chips.append(
        el("button", { class: "chip", type: "button", text: "清除筛选", onClick: resetFilters }),
      );
    }
  }

  function renderRows() {
    tbody.replaceChildren();
    for (const item of rows) {
      const path = decodePath(item.path_display_b64) || item.path_key;
      const row = el(
        "tr",
        {
          style: { cursor: "pointer" },
          onClick: (event) => {
            if (event.target.closest("button,a")) return;
            void openDetail(item.id);
          },
        },
        [
          el("td", {}, [
            el("div", { class: "file-path", text: path }),
            el("div", { class: "cell-sub", title: item.content_hash || "" }, [
              `SHA-256 ${shortHash(item.content_hash)}`,
            ]),
          ]),
          el("td", {}, [
            el("div", { text: item.mount_label || item.mount_id }),
            el("div", { class: "cell-sub", text: item.mount_id }),
          ]),
          el("td", {}, [statusBadge(fileState, item.state)]),
          el("td", { class: "num", text: formatBytes(item.size) }),
          el("td", {
            title: formatTime(item.last_seen_at),
            text: formatRelative(item.last_seen_at),
          }),
          el("td", { class: "num" }, [
            (item.open_issue_count ?? 0) > 0
              ? el("span", { class: "badge badge--warn", text: String(item.open_issue_count) })
              : el("span", { class: "muted", text: "—" }),
          ]),
          el("td", {}, [
            el("button", {
              class: "btn btn-ghost btn-sm",
              type: "button",
              text: "详情",
              "aria-label": `查看 ${path} 的详情`,
              onClick: () => void openDetail(item.id),
            }),
          ]),
        ],
      );
      tbody.append(row);
    }
  }

  function render() {
    renderChips();
    renderRows();
    tableWrap.classList.toggle("hidden", rows.length === 0);
    emptyBox.classList.toggle("hidden", rows.length > 0 || Boolean(lastError));
    if (rows.length === 0 && !lastError) {
      emptyBox.replaceChildren(
        emptyNode({
          title: hasActiveFilters() ? "当前筛选没有文件" : "还没有入库文件",
          description: hasActiveFilters()
            ? "换一组筛选条件，或清除筛选后重试。"
            : "先对挂载点执行一轮全量巡检，文件元数据入库后会出现在这里。",
          actions: [
            hasActiveFilters()
              ? el("button", { class: "btn", type: "button", text: "清除筛选", onClick: resetFilters })
              : getHub()
                ? el("button", {
                    class: "btn btn-primary",
                    type: "button",
                    text: "打开 hub 触发巡检",
                    onClick: () => openExternal(`${getHub()}/machines`),
                  })
                : null,
          ],
        }),
      );
    }
    const page = Math.floor(filters.offset / filters.limit) + 1;
    const pages = Math.max(1, Math.ceil(total / filters.limit));
    pageInfo.textContent = loading
      ? "加载中…"
      : `共 ${formatCount(total)} 条 · 第 ${page}/${pages} 页`;
    prevButton.disabled = loading || filters.offset <= 0;
    nextButton.disabled = loading || filters.offset + filters.limit >= total;
    errorBox.classList.toggle("hidden", !lastError);
    errorBox.replaceChildren(
      el("span", { text: lastError ?? "" }),
      el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "重试",
        onClick: () => void load(false),
      }),
    );
  }

  async function loadMounts() {
    try {
      const mounts = await FileService.Mounts();
      const current = filters.mount;
      mountSelect.replaceChildren(el("option", { value: "", text: "全部挂载点" }));
      for (const mount of mounts ?? []) {
        mountSelect.append(
          el("option", { value: mount.id, text: mount.label || mount.id }),
        );
      }
      if (Array.from(mountSelect.options).some((option) => option.value === current)) {
        mountSelect.value = current;
      } else {
        filters.mount = "";
      }
      mountsLoaded = true;
    } catch {
      // 文件列表请求会给出更具体的错误
    }
  }

  async function load(reset) {
    if (reset) {
      filters.offset = 0;
      closeDetail();
    }
    const seq = ++requestSeq;
    loading = true;
    lastError = null;
    render();
    try {
      const result = await FileService.ListFiles(fields(filters));
      if (seq !== requestSeq) return;
      rows = result.items ?? [];
      total = result.total ?? 0;
      summary = result.summary ?? null;
      loaded = true;
    } catch (error) {
      if (seq !== requestSeq) return;
      lastError = error?.message || String(error);
    } finally {
      if (seq === requestSeq) {
        loading = false;
        render();
      }
    }
  }

  let currentDrawer = null;

  function closeDetail() {
    if (currentDrawer) {
      currentDrawer.close();
      currentDrawer = null;
    }
  }

  async function openDetail(pathId) {
    const seq = ++detailSeq;
    if (currentDrawer) {
      currentDrawer.close();
      currentDrawer = null;
    }
    const drawer = openDrawer({
      title: "文件详情",
      subtitle: "正在读取…",
      content: el("div", { class: "hint", text: "加载文件详情…" }),
      onClose: () => {
        if (currentDrawer === drawer) currentDrawer = null;
      },
    });
    currentDrawer = drawer;
    try {
      const detail = await FileService.FileDetail(pathId);
      if (seq !== detailSeq) return;
      renderDetail(drawer, detail);
    } catch (error) {
      if (seq !== detailSeq) return;
      drawer.body.replaceChildren(
        el("div", { class: "alert alert--danger", text: error?.message || String(error) }),
      );
    }
  }

  function renderDetail(drawer, detail) {
    const file = detail.file ?? {};
    const machine = detail.machine ?? {};
    const mount = detail.mount ?? {};
    const fullPath = joinPath(machine.platform, mount.physical_path, file.path_key);
    const issues = detail.issues ?? [];
    const observations = detail.observations ?? [];

    const issuesTable =
      issues.length === 0
        ? el("div", { class: "hint", text: "没有异常记录。" })
        : el("div", { class: "table-wrap" }, [
            el("table", { class: "table" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", { scope: "col", text: "类型" }),
                  el("th", { scope: "col", text: "状态" }),
                  el("th", { scope: "col", text: "置信度" }),
                  el("th", { scope: "col", class: "num", text: "次数" }),
                  el("th", { scope: "col", text: "最近" }),
                ]),
              ]),
              el(
                "tbody",
                {},
                issues.map((issue) =>
                  el("tr", {}, [
                    el("td", {}, [statusBadge(issueType, issue.type)]),
                    el("td", {}, [statusBadge(issueStatus, issue.status)]),
                    el("td", {}, [statusBadge(confidence, issue.confidence, false)]),
                    el("td", { class: "num", text: formatCount(issue.occurrences) }),
                    el("td", {
                      title: formatTime(issue.last_seen_at),
                      text: formatRelative(issue.last_seen_at),
                    }),
                  ]),
                ),
              ),
            ]),
          ]);

    const sections = [
      detailSection("位置", [
        kv([
          [
            "完整路径",
            el("div", { class: "row" }, [
              el("span", { class: "mono", text: fullPath }),
              el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "复制",
                onClick: () => copyValue(fullPath, "完整路径"),
              }),
            ]),
          ],
          ["相对路径", el("span", { class: "mono", text: file.path_key ?? "" })],
          ["机器", machine.machine_id || "—"],
          ["挂载点", mount.mount_id || "—"],
        ]),
      ]),
      detailSection("状态", [
        kv([
          ["文件状态", statusBadge(fileState, file.state)],
          ["大小", formatBytes(file.size)],
          ["mtime", formatNs(file.mtime_ns)],
          ["最后发现", formatTime(file.last_seen_at)],
          ["最后哈希", formatTime(file.last_hashed_at)],
          [
            "哈希类型",
            file.last_hash_kind
              ? statusBadge(hashKind, file.last_hash_kind, false)
              : el("span", { class: "muted", text: "—" }),
          ],
        ]),
      ]),
      detailSection("SHA-256", [
        el("div", { class: "row" }, [
          el("span", { class: "mono", text: file.content_hash || "尚未计算哈希" }),
          file.content_hash
            ? el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "复制哈希",
                onClick: () => copyValue(file.content_hash, "SHA-256"),
              })
            : null,
        ]),
      ]),
      detailSection(`异常（${issues.length}）`, issuesTable),
      issues.some((issue) => issue.evidence)
        ? el("details", { class: "raw-json" }, [
            el("summary", { text: "查看异常证据（原始 JSON）" }),
            el("pre", {
              class: "code-block",
              text: JSON.stringify(
                issues.map((issue) => ({ id: issue.id, evidence: issue.evidence })),
                null,
                2,
              ),
            }),
          ])
        : null,
      detailSection(
        `最近观测（${observations.length}）`,
        observations.length === 0
          ? el("div", { class: "hint", text: "暂无观测记录。" })
          : el("div", { class: "table-wrap" }, [
              el("table", { class: "table" }, [
                el("thead", {}, [
                  el("tr", {}, [
                    el("th", { scope: "col", text: "哈希" }),
                    el("th", { scope: "col", text: "类型" }),
                    el("th", { scope: "col", text: "时间" }),
                  ]),
                ]),
                el(
                  "tbody",
                  {},
                  observations.map((observation) =>
                    el("tr", {}, [
                      el("td", {
                        class: "mono",
                        title: observation.hash,
                        text: shortHash(observation.hash, 16),
                      }),
                      el("td", { text: labelOf(observationKind, observation.kind).label }),
                      el("td", { text: formatTime(observation.observed_at) }),
                    ]),
                  ),
                ),
              ]),
            ]),
      ),
    ].filter(Boolean);

    drawer.body.replaceChildren(...sections);
    drawer.setTitle(decodePath(file.path_display_b64) || file.path_key || "文件详情");
    drawer.setSubtitle(`${machine.machine_id ?? "—"} / ${mount.mount_id ?? "—"}`);

    const hub = getHub();
    const actions = [
      el("button", { class: "btn", type: "button", text: "关闭", onClick: closeDetail }),
      el("button", {
        class: "btn",
        type: "button",
        text: "复制完整路径",
        onClick: () => copyValue(fullPath, "完整路径"),
      }),
      hub
        ? el("button", {
            class: "btn",
            type: "button",
            text: "在 hub 查看",
            onClick: () =>
              openExternal(
                `${hub}/files?machine_id=${encodeURIComponent(machine.machine_id ?? "")}&q=${encodeURIComponent(file.path_key ?? "")}`,
              ),
          })
        : null,
    ].filter(Boolean);
    drawer.setFooter(actions);
  }

  refreshButton.addEventListener("click", () => {
    void load(false);
  });
  openHubButton.addEventListener("click", () => {
    const hub = getHub();
    if (!hub) return;
    const machine = getMachineId();
    openExternal(machine ? `${hub}/files?machine_id=${encodeURIComponent(machine)}` : `${hub}/files`);
  });
  searchInput.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      filters.q = searchInput.value;
      applyFilters();
    }, 300);
  });
  prevButton.addEventListener("click", () => {
    filters.offset = Math.max(0, filters.offset - filters.limit);
    void load(false);
  });
  nextButton.addEventListener("click", () => {
    if (filters.offset + filters.limit < total) {
      filters.offset += filters.limit;
      void load(false);
    }
  });

  return {
    element: container,
    show: () => {
      if (!mountsLoaded) void loadMounts();
      void load(!loaded);
    },
    invalidate: () => {
      mountsLoaded = false;
      loaded = false;
      rows = [];
      total = 0;
      summary = null;
      closeDetail();
    },
    refresh: () => {
      void load(false);
    },
  };
}
