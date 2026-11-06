# Agent 桌面端 UI/UX 评审与改造记录

> 返回 [README](../README.md)。评审与改造时间：2026-11-06。范围：`agent/desktop`（Wails v3 桌面客户端），对照 `web/` 控制台的设计系统与 `docs/PLAN-M2.md` §5。

## 1. 背景与结论

桌面端在 M2 完成「托盘 + 向导 + 设置 + 文件页 + 状态事件」的最小可用版本，随后只做过图标与窗口尺寸调整。本次评审发现它的问题不是「不好看」，而是**状态语义不可信、窗口里没有运行控制、文件/设置页信息不足**：

- 空闲轮询会清空「最近一轮统计」和「最近错误」，并把「最近同步」每 5 秒刷新一次；
- 「巡检中/空闲」每 5 秒闪烁；暂停或刚启动时连接状态永远显示不准确；
- 只能看不能操作：窗口内没有立即同步/暂停入口，托盘也没有文档承诺的「立即巡检」；
- 首次补配置会丢失自定义 `state_dir`；文件搜索有竞态；动画假进度、英文枚举、`window.alert`、无焦点/无响应式。

本次改造目标：**让状态可信、让窗口能操作、让错误可追踪、让 880×640 窗口仍可用**，同时保留深色托盘工具的产品语言。

## 2. 做得好的地方（保留）

- Wails 体积小；状态事件 2 秒推送；托盘/单实例/关闭隐藏/开机启动/单实例回调齐全。
- 首次向导「识别已有节点」自动填充、挂载点增删、浏览目录。
- 本机文件列表与详情（读 hub agent token 接口）、复制完整路径、hub 深链。
- Go 侧 setup/file 服务已有测试；品牌图标与 Web 控制台一致。

## 3. 评审发现与处理

### P0 正确性（已修复）

| 问题 | 证据 | 处理 |
| --- | --- | --- |
| 空闲轮询把「最近一轮统计」清零 | `main.go` 旧 `runLoop` 每次成功都写 `LastStats`；`Runner.RunOnce` 无任务返回零值 | `RunOnce` 返回 `(stats, ran, err)`；仅 `ran=true` 时写统计与 `LastRunAt` |
| 「最近同步」每 5 秒刷新，看起来一直在巡检 | 同上，`LastRunAt` 每次轮询都写 | 拆成 `LastRunAt`（真实巡检）与 `LastOkAt`（hub 通信）；UI 的「最近巡检」失败时回退 hub 最近任务 |
| 最近错误 5 秒后自动消失 | 下一次空闲成功把 `LastError` 清空 | 只在成功执行完巡检后清错；新增 `LastErrorAt`，错误卡显示时间并可复制 |
| 暂停/启动早期连接状态永远不准 | `Connected` 只在 `RunOnce` 成功时置 true；暂停不跑 `RunOnce` | `RecentJobs` 成功即 `Connected=true/LastOkAt`，失败置 false；暂停时仍能反映 hub 可达性 |
| 「巡检中/空闲」每 5 秒闪烁 | `Running` 包住整个 `RunOnce`（含空转） | `snapshot()` 用 `runner.CurrentJob() != nil` 计算 `Running` |
| 首次补配置丢失自定义 `state_dir` | `SetupState.Prefill` 带 state_dir，前端 `setupPayload` 写死空串 | 向导保留并使用 `prefill.state_dir`，新增可编辑「状态目录」 |
| macOS 文件完整路径拼错 | 前端固定 `\` 拼接 | `joinPath(platform, mount, pathKey)` 按平台/路径形态选择分隔符（单测覆盖） |
| 文件搜索竞态 | 300ms 防抖并发请求，无序号 | 请求序号 + 只渲染最新结果 |
| 阻断式 `window.alert`、保存无确认 | 删除挂载点、保存设置 | 自绘确认框；保存二次确认「会重启巡检进程」；按钮 busy |

### P1 信息架构与操作（已补齐）

- **运行控制**：状态页增加「立即同步（向 hub 拉取任务）/ 暂停·继续 / 查看异常 / 打开 hub / 复制机器 ID / 刷新」；托盘增加「立即同步」并与窗口状态双向同步。
- **状态语义**：连接徽章区分已连接/连接中/未连接/已暂停；「最近巡检」在有 hub 历史但本机启动后未巡检时显示来源；最近任务统计在缺少本机统计时回退 hub 最近任务。
- **本机文件摘要**：状态页展示入库/缺失/有异常/已校验，进入页面与巡检完成后刷新（`FileService.ListFiles(limit=1)`），失败可重试。
- **文件页**：筛选（挂载点/搜索/状态/异常 + 更多筛选）、快捷统计 chips、分页（50/100）、错误重试、空态 CTA；详情改为右侧抽屉（位置/状态/SHA-256/异常/观测），可复制路径与哈希、跳 hub。
- **设置页**：只读连接信息 + 复制、版本、开机启动开关、显示名/挂载点编辑、未保存修改守卫、保存确认、打开配置目录、复制诊断信息、退出应用。
- **首次向导**：编号分区、token 掩码/显示、识别的 busy 态、客户端校验与保存禁用、路径来自 hub 的警告、配置路径与备份提示；不再使用 `window.alert`。

### P2 视觉/可访问性/响应式（已落地）

- 设计令牌与 hub 同名（dark 值）：颜色、间距、字号、圆角、阴影、焦点环。
- 基础组件类：按钮/徽章/面板/KPI/指标/表格/表单/chips/空态/Toast/对话框/抽屉/进度条/挂载点卡片。
- 深色标题栏（Wails `WindowsWindow.Theme=Dark`）；主区域 flex + 内部滚动，footer 固定；880×640 最小窗口可用。
- 键盘：tabs 使用 `role=tablist/tab` + 方向键（UIA 已识别为 TabItem）、详情用按钮、Esc 关闭抽屉/对话框并还原焦点、`:focus-visible` 焦点环、`prefers-reduced-motion`。
- 反馈：Toast（`aria-live`）、按钮 busy、复制/保存/暂停/同步结果均有提示；错误全局兜底（`error`/`unhandledrejection` → Toast）。
- 真实状态：不确定进度条 + 真实计数，而不是固定 35% 的假进度。

### P3 工程与资产（已落地）

- 拆分 `src/lib`（dom/format/labels/ui）与 `src/views`（setup/status/files/settings/mountEditor），`main.js` 只做启动/事件/标签路由。
- 删除未引用模板资源（`bg-desktop.jpg`、`bg-mobile.jpg`、`Inter-Medium.ttf`、`wails.png`、`javascript.svg`、`public/style.css`、字体许可），exe 约减小 660 KB。
- 前端加 vitest（17 项）：平台路径、格式化、标签映射。
- `RunOnce` 签名变更同步 CLI 与内部循环；Go 侧新增 controller 单测（空闲不清统计、错误保留、连接状态、暂停、立即同步）。

## 4. 设计决策

1. **保留深色主题**：桌面端是托盘常驻工具；不引入明暗切换，颜色/间距令牌与 hub 同命名。
2. **不迁移 React**：前端规模小，与 hub 的 React 组件无法直接复用；沿用 vanilla JS + Vite，按模块拆分，符合「零额外运行时依赖」。
3. **「立即同步」而非「立即巡检」**：agent 只能从 hub 领任务，不能自行创建 hub 扫描任务；按钮/托盘的语义是「立即唤醒轮询，执行已排队的任务」，文案避免误导。真正发起新扫描仍在 hub Web。
4. **本机异常通过 hub 深链查看**：agent token 没有异常列表接口，不为此扩 hub API；状态页提供「查看异常」直达 hub 机器过滤页。
5. **部署**：构建后替换 `dist/observer-agent-windows-gui-amd64/observer-agent-desktop.exe`，保留 `agent.yaml` 与 `.observer` 状态；需短暂停止当前桌面 Agent。

## 5. 落地对照

```
agent/desktop/
  main.go             Status 新字段、wake/暂停/同步、连接语义、托盘同步、深色标题栏、最小窗口
  status_service.go   GetStatus/SetPaused/ScanNow/SetAutostart/OpenConfigFolder/QuitApp
  controller_test.go  状态语义单测
  frontend/
    index.html        壳：tabs/视图/Toast/Modal/Drawer
    src/main.js       启动、状态事件、标签路由、全局错误
    src/lib/          dom / format / labels / ui
    src/views/        setup / status / files / settings / mountEditor
    src/styles/       tokens / base / layout / components
    src/lib/*.test.js 17 项单测
agent/internal/agent/runner.go   RunOnce 返回 ran
agent/cmd/observer-agent/main.go scan 命令使用 ran
```

Wails Service 变更（bindings 自动生成，产物 gitignore）：

```go
func (s *ConfigService) GetStatus() Status
func (s *ConfigService) SetPaused(paused bool) Status
func (s *ConfigService) ScanNow() (Status, error)
func (s *ConfigService) SetAutostart(enabled bool) (Status, error)
func (s *ConfigService) OpenConfigFolder() error
func (s *ConfigService) QuitApp()
```

Status JSON 新增：`version`、`last_error_at`、`last_ok_at`、`autostart`、`autostart_supported`；`running` 改为仅真实扫描时为 true。

## 6. 验证

```powershell
cd agent/desktop/frontend; npm test; npm run build
cd agent/desktop; go test ./...; go vet ./...; wails3 build
cd agent; go test ./...
```

手动验证（2026-11-06，Windows + WebView2 + 本地 WSL hub `127.0.0.1:13000`）：

- 构建 `wails3 build` 通过；新 exe 13.1 MB（旧 13.8 MB），替换后读取原 `agent.yaml`/`.observer`，hub 机器心跳恢复、连接显示「已连接」。
- 触发 hub 增量任务（job #9）后状态页更新出「最近一轮统计」（发现 549/哈希 35/跳过 514/5.3 MiB/1.8 秒）；空闲 15 秒后统计保持不变（P0 回归通过）。
- 暂停/继续：窗口徽章与状态卡切换为「已暂停」，托盘项同步，恢复后正常；暂停时「立即同步」禁用。
- 文件页：搜索 `DT_Cart` 命中 1 条，chips/分页同步；详情抽屉展示完整路径、状态、mtime、SHA-256、异常与观测，Esc/关闭可退。
- 设置页：修改显示名触发「有未保存的修改」，切换标签弹出「放弃未保存的修改？」；取消后保持编辑态，未写入配置。
- 首次向导（临时 `-config`）：编号分区、token 掩码、保存按钮在缺少 token 时为 disabled、`识别已有节点` 可用；未提交任何配置。
- 880×640 最小窗口：header 换行、KPI 折行、表格容器内滚动、footer 正常。

## 7. 未做/后续

- 不提供明暗切换与 macOS 开机启动（保持现有平台行为）。
- 不新增 hub 异常列表 API；不在桌面端创建扫描任务（由 hub 触发）。
- 版本显示来自 `version.Version`（当前 `0.1.0-dev`），尚未与 `build/config.yml` 的 0.2.0 对齐；打包流程后续统一注入。
- 托盘通知（ROADMAP 第 6 项）仍未做。
- 本次未修改 `docs/QUICKSTART.md` / `docs/TESTING.md` / `docs/DESIGN-TECH.md`：这些文件在评审时含有并行未提交修改，避免混入；待其提交后再补桌面端章节。
