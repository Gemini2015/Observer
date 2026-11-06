# Web 控制台 UI 评审与改造记录

> 返回 [README](../README.md)。评审与改造时间：2026-11-05。范围：`web/`（hub 托管的 React 控制台），对照 `agent/desktop/frontend`（桌面端）与需求/计划文档。

## 1. 背景与结论

M1 的 Web 控制台是刻意做成的「最小控制台」：原生 `fetch` + 手写 CSS，约 2.2k 行、零运行时依赖。功能闭环完整，但 M2–M4 补齐的审计、修复历史、任务详情、机器维度等能力在 UI 上只暴露了一部分；同时存在若干会让运维人员不信任数据的缺陷（0 文件显示 100% 覆盖率、瞬时错误卡死整页、Linux 路径被拼成 Windows 风格），以及一套未成体系、不响应式、键盘不可用的视觉层。

本次改造的目标：**在不引入新运行时依赖的前提下**，把控制台从「能用的最小控制台」提升为「可日常运维的控制台」——补齐闭环页面、建立最小设计系统、修正确性缺陷、支持窄屏与键盘操作。

## 2. 做得好的地方（保留）

- 文件页筛选全部写进 URL，可分享、可刷新；修复创建后的状态轮询。
- 一次性 token 只显示一次 + 复制；覆盖率为 0 之外的比例条、相对心跳时间。
- 每个页面都有空态与错误提示（样式弱，但思路在）。
- 零运行时依赖，构建产物小（改造前 305 KB，改造后按路由分包）。

## 3. 评审发现与处理

### P0 正确性与信任（已修复）

| 问题 | 证据 | 处理 |
| --- | --- | --- |
| 瞬时网络错误让页面永久卡死（error 非空即 return，成功轮询不清错） | `Overview/Jobs/Machines/MountDetail` 旧实现 | 统一 `usePolling`：成功清错、失败保留旧数据并提示、页面不提前 return |
| 0 个文件显示 100% 覆盖率 | `computeCoverage` / overview 的 `ratio = total === 0 ? 1` | UI 无数据显示「—/无文件」，进度条置灰 |
| 跨平台路径拼接固定用 `\`，Linux/macOS 挂载点显示错误 | 旧 `Files.tsx` 的 `fullPath()` | `joinMountPath()` 按平台/路径形态选择分隔符 |
| 危险按钮文字对比度 2.77:1（AA 需 4.5:1） | 旧 `styles.css` 的 `button.danger` | 危险色 `#b91c1c`（6.47:1），danger 变体改为红字 + 浅红底 + 红边 |
| 英文枚举裸露、各页口径不一致 | 旧 `api.ts` 的 `statusClass`/`fileStateLabel` | 统一 `lib/labels.ts`（中文 + 色调 + 兜底），原始值只进「技术信息」折叠区 |
| 空态文案让用户去做 UI 里没有的 baseline 扫描 | 旧 `Files.tsx` 空态 | 改为「全量巡检」并提供跳转按钮 |
| 导出 CSV 绕过统一请求封装，401 不跳登录 | 旧 `Files.tsx` | 统一 `downloadFile()`，与 `api()` 共享错误与 401 处理 |
| 登录页品牌图标与侧栏不一致 | 旧 `Login.tsx` 用 `favicon.svg` | 统一 `logo.svg` |

### P1 需求缺口与工作流（已补齐）

| 问题 | 处理 |
| --- | --- |
| 审计日志无界面（FR-12），`GET /api/v1/audit` 已存在 | 新增 `/audit`：动作前缀筛选、条数、详情 JSON |
| 修复无中心页/历史，`GET /api/v1/repairs` 已存在 | 新增 `/repairs`：列表、进度、取消、详情抽屉 |
| 任务详情缺失，`GET /api/v1/jobs/:id` 已存在 | 新增 `/jobs/:id`，任务列表行可点 |
| 机器详情路由缺失（PLAN-M1 §7 规划 `/machines/:id`） | 新增 `/machines/:id`：基本信息、挂载点、最近任务、令牌/删除 |
| 总览缺「最近巡检时间/多久没巡检」（REQUIREMENTS S5） | 总览增加「最近巡检」KPI 与「巡检新鲜度」表（后端补 `last_scan_at`、`attention_mounts`） |
| 异常页无计数、无类型/机器/路径筛选、无批量操作 | 状态 tab 带计数、类型/机器/搜索筛选、多选批量忽略 |
| 无「设置」页（FR-11），后端无修改密码端点 | 新增 `/system`：只读系统信息 + 令牌生成 + 配置说明 |
| 详情在表格内展开/表格尾部追加，上下文易丢 | 文件/异常/修复详情统一右侧抽屉，选中项进 URL（可刷新、可分享、Back 关闭） |
| 危险操作全部 `window.confirm` | 自绘确认框，删除机器需输入机器 ID |
| 无 404、无错误边界、标题不随路由变化 | 404 页、ErrorBoundary、`useDocumentTitle`、面包屑 |
| 总览任务卡 `running/pending` 语义歧义 | 拆为独立 KPI：待确认异常、最近巡检；任务卡改为分布与列表 |

### P2 视觉系统、响应式与可访问性（已落地）

- 设计令牌收口到 `web/src/styles/tokens.css`：语义色、间距、字号、圆角、阴影、焦点环、层级。
- 基础组件：按钮（primary/secondary/ghost/danger）、徽章、面板、KPI、表格、表单、标签页、分页、空态、Toast、确认框、模态框、抽屉、下拉菜单、进度条。
- 响应式四档：≥1180 / 900–1180 / 560–900 / <560；<900 侧栏转顶栏，抽屉全屏，筛选单列。
- 可访问性：全局 `:focus-visible` 焦点环、跳转主内容链接、`aria-current`、抽屉/模态焦点陷阱 + Esc + 焦点还原、Toast `aria-live`、表格 `scope`、行内真实按钮作为键盘入口、`prefers-reduced-motion`。
- 反馈统一：操作结果走 Toast（可关闭、悬停暂停、危险提示停留更久）；轮询统一 5 秒（任务/修复 3 秒），页面不可见时暂停，显示「更新于」。
- 表格：粘性表头、行 hover、选中态、数值右对齐、等宽路径/哈希、长文本换行。

### P3 工程与文档（已落地）

- 路由级分包（React.lazy + Suspense），首屏只加载外壳与登录/总览。
- Web 增加 vitest：`format.ts`（时间/字节/时长/路径/哈希/统计值）与 `labels.ts`（状态映射/审计标签）。
- 前后端错误文案对齐：前端按状态码映射中文，原始 `detail` 保留在技术信息里；后端消息未改。
- 设计文档偏差记录：DESIGN-TECH T9 从「TanStack Query + Tailwind」修正为「手写 CSS + fetch」，见 §5。

## 4. 设计决策

1. **不引入新运行时依赖**：不引入 Tailwind/TanStack Query。当前规模下手写 CSS + fetch 足够，引入两者需要重写全部样式并调整构建与文档，收益主要是开发速度而不是用户价值。只增加 dev 依赖 vitest。
2. **本期不做暗色主题**：颜色全部走令牌，后续暗色只改 `tokens.css`。桌面端保持深色，Web 保持浅色。
3. **详情交互**：实体（机器、任务）用独立路由页，因为它们需要可分享；瞬时详情（文件、异常、修复）用右侧抽屉。
4. **后端只做 additive 变更**：现有响应字段名与数组形状不变，新增字段/查询参数/端点；无数据库迁移。
5. **范围限定 Web 控制台**：桌面端只统一状态语义与令牌命名，不重排版面。

## 5. 落地对照

### 5.1 前端结构

```
web/src/
  styles/        tokens.css / base.css / layout.css / components.css / index.css
  lib/           format.ts / labels.ts / hooks.ts / clipboard.ts (+ *.test.ts)
  components/    StatusBadge KpiCard EmptyState Toast ConfirmDialog Modal Drawer
                 ProgressBar Tabs Pagination PageHeader KeyValue Menu PageLoading
                 ErrorBoundary dialogBehavior
  app/           AppShell.tsx / routes.tsx / navIcons.tsx
  pages/         Login Overview Machines MachineDetail MountDetail Files Issues
                 Jobs JobDetail Repairs Audit System NotFound
  api.ts         fetch 封装 + ApiError + 全部响应类型
```

### 5.2 后端增量（additive）

| 接口 | 变更 |
| --- | --- |
| `GET /api/v1/overview` | 新增 `last_scan_at`、`mounts.never_scanned/stale_24h`、`attention_mounts` |
| `GET /api/v1/machines` | 每台机器新增 `open_issues`、`last_job_at` |
| `GET /api/v1/machines/:id` | 新增单台机器详情（含挂载点与覆盖率） |
| `GET /api/v1/jobs` | 新增 `machine_id` 查询参数 |
| `GET /api/v1/issues` | 新增 `machine_id` / `type` / `q` 查询参数（响应仍为数组） |
| `GET /api/v1/issues/summary` | 新增：按状态/类型/机器的计数 |
| `GET /api/v1/system` | 新增：版本、运行时长、调度参数、数据库规模 |

### 5.3 路由与导航

侧栏三组八项：巡检（总览 `/`、机器 `/machines`、任务 `/jobs`）｜数据（文件 `/files`、异常 `/issues`、修复 `/repairs`）｜系统（审计 `/audit`、系统 `/system`）。机器详情 `/machines/:id`、挂载点详情 `/mounts/:id`、任务详情 `/jobs/:id` 走面包屑；侧栏底部显示中心服健康点与版本。

## 6. 未做与后续

- 暗色主题、骨架屏、文件表头点击排序、桌面端令牌完全对齐、命令面板/全局搜索（需要新增搜索 API）。
- 通知与告警渠道配置（M2 已暂缓）。
- 多用户/RBAC、文件内容预览/下载。
- 真实多机修复流程的 UI 自动化仍未覆盖（drill 脚本只覆盖 API/agent 链路）；本次以本地 hub + 现有数据做手动验收，见 TESTING §7。

## 7. 验收

```powershell
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter web build
pnpm --filter hub test
pnpm --filter hub typecheck
```

手动验收清单见 [TESTING §7](TESTING.md#7-ui-手动验收清单)。

## 8. 变更记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-05 | 初稿：评审结论、P0–P3 清单、设计决策、Phase 1–3 落地对照 |
