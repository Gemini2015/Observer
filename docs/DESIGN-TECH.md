# Observer 技术方案（v0.1）

> 版本：v0.6　日期：2026-10-29　性质：技术方案草案
>
> 上游：[需求整理](REQUIREMENTS.md)（v0.3）、[路径与身份模型](DESIGN-PATH-MODEL.md)（v0.2）。
> 本文回答"怎么实现"，不改变需求边界。
> 标记说明：✅ 已定　🟡 建议（可改）　❓ 待定

## 1. 目标与约束

承接需求 §3 的 G1–G6。实现层面的硬约束：

- ✅ 中心服是 Node.js（需求 §6 已定）；
- ✅ Windows / macOS 提供**带 GUI 的 agent 客户端**，普通程序（后台/托盘/开机启动），**不做系统服务**；
- ✅ NAS 提供**无 GUI** 的 agent，可 systemd 或 Docker 运行；
- 🟡 数据规模：TB 级总量、百万文件、单文件可达 GB 级；
- 🟡 局域网为主，agent 主动连 hub；单用户、单 hub。

## 2. 总体架构

```
┌─────────────────────── Hub（Node 22 / Fastify / SQLite）───────────────────────┐
│  REST API │ 调度器(30s) │ 任务队列(租约) │ 结果入库 │ 异常判定 │ 传输中转 │ Web │
└────────────▲──────────────────────────▲────────────────────────────▲──────────┘
             │ HTTPS/JSON 轮询 + 上报      │ 分块上传/下载（修复）        │ 浏览器
   ┌─────────┴──────────┐      ┌────────┴─────────┐          ┌────────┴────────┐
   │ Agent 桌面 (Go+Wails)│      │ Agent 无头 (Go)   │          │ 用户浏览器       │
   │ Windows / macOS      │      │ Linux NAS / 容器  │          └─────────────────┘
   └──────────────────────┘      └──────────────────┘
```

| 组件 | 职责 |
| --- | --- |
| hub-core | 注册、心跳、任务队列与租约、结果入库、异常判定、调度、审计 |
| hub-web | 总览 / 机器 / 挂载点 / 任务 / 异常 / 设置（React 构建产物由 hub 托管） |
| hub-transfer | 修复文件的中转与分块续传 |
| agent-core | 配置校验、遍历、规则、哈希、限速、上报、spool、修复执行 |
| agent-gui | Wails 托盘与窗口（仅 Windows / macOS） |

## 3. 技术决策

### 3.1 核心决策（T1–T20）

| # | 决策 | 理由 | 替代方案与否决原因 |
| --- | --- | --- | --- |
| T1 | Agent 用 **Go**，一套核心两种形态；GUI 用 **Wails v3**（系统 WebView） | 需求要求桌面 GUI + NAS 无头；Go 交叉编译与并发最省事；WebView 方案内存约为 Electron 的 1/3 | Node+Electron（200–400MB）；Rust+Tauri（GUI 略优但开发/维护成本高；扫描是 IO 瓶颈，语言收益为零） |
| T2 | Hub 用 **Node 22 + TS + Fastify 5 + Zod** | 需求已定 Node；Fastify 的 schema 校验与 OpenAPI 生成一体 | NestJS（过重）；Express（schema/性能弱） |
| T3 | 存储用 **SQLite（better-sqlite3，WAL）+ 手写 SQL 迁移** | 单用户单写者；百万行级足够；备份就是拷文件；SQL 可预测 | Postgres（多一套服务）；ORM（查询不可控） |
| T4 | 哈希用 **SHA-256 流式**，记录 `algo` 字段 | 磁盘是瓶颈，SHA-256 硬件加速已远超需求；系统工具可人工互验 | BLAKE3（NVMe/强 CPU 才有收益，互验工具少） |
| T5 | 协议 **HTTPS + REST + 轮询**：心跳 15s，服务端可挂 25s 返回任务 | agent 主动外连，穿 NAT/防火墙最稳 | WebSocket（重连/代理复杂）；gRPC（浏览器端还要再包一层） |
| T6 | 修复走 **Hub 中转**（store-and-forward + 分块续传） | agent 多在 NAT 后、Windows 防火墙默认拦入站 | agent↔agent 直连（端口/鉴权/穿透复杂） |
| T7 | 副本判定 = **内容哈希全等** | 哈希相等即同一内容；路径/文件名不参与 | 路径后缀 + 大小（易误判）；相似度（v1 不做） |
| T8 | 增量 = **size + mtime_ns 双等且 90 天内已哈希** → 跳过，否则重算 | 兼顾速度与 mtime 被工具重置的风险 | 只比 mtime；每轮全量 |
| T9 | 前端 **React 19 + Vite + TS + TanStack Query + Tailwind**；hub Web 与 agent GUI 同栈 | 大表格分页/筛选/进度轮询用 SPA 更省事 | Next/SSR（无 SEO 需求）；模板渲染（交互差） |
| T10 | 桌面端 = **普通程序 + 托盘 + 开机启动**，不做系统服务 | ✅ 你的要求；托盘常驻、窗口可隐藏 | 注册为服务（用户不可见、调试难） |
| T11 | 鉴权：一次性注册 token（24h）+ 长期 bearer（库内存哈希、可轮换/吊销）+ Web 单用户密码会话 | 家庭场景单用户，但 token 必须可吊销 | 多用户/RBAC（v1 不需要）；无鉴权 |
| T12 | 部署：hub 提供 docker compose（可选 Caddy 终结 TLS），也可直接 `node` 跑 | 需求已定 compose 一键起 | 内置自签证书（agent 校验麻烦） |
| T13 | 路径在 wire 上用 **`path_display_b64`** 保真 | JSON 会把非法 UTF-8 替换成 U+FFFD，Linux 怪文件名会失配 | 直接传字符串（丢字节） |
| T14 | 时钟以 **Hub 为准**，agent 上报偏移，租约/超时按 hub 时间 | 跨机漂移会误判任务超时 | 依赖 agent 本地时间 |
| T15 | 备份：每日 `VACUUM INTO` + `observer export`（JSON/CSV） | 哈希库本身是资产，且不能被软件锁死 | 直接拷贝（WAL 下不安全） |
| T16 | **单实例锁**（命名互斥 / 本地 socket） | 双开会导致同目录重复扫描与结果打架 | 无锁 |
| T17 | 自启：Windows `HKCU\...\Run`，macOS `~/Library/LaunchAgents` plist，应用内开关 | 普通程序最自然的自启方式 | 系统服务/登录项 API |
| T18 | GUI 与无头用 **build tag 分离**，`internal/core` 零 GUI 依赖 | NAS 二进制不带 WebView 依赖，体积与内存最小 | 同一二进制带 GUI（NAS 镜像变大） |
| T19 | 限速 = **双闸 + 文件原子单位 + credit bucket（有界等待 + 欠账）** | 见 §5.5；文件要么读完要么不读，状态最简单 | 分块限速（文件内断点，状态多） |
| T20 | 规则 = **include + exclude**，exclude 优先，doublestar 语法，规则版本上报 | 见 §5.6；支持"只扫指定类型" | 只有 exclude（无法白名单化） |

### 3.2 与需求 §10 的对照（A–I 全部 33 条）

| §10 编号 | 结论 | 备注 |
| --- | --- | --- |
| A1 | SHA-256 流式，记录 `algo` | 见 T4 |
| A2 | size + mtime_ns 未变且距今 < 90 天 → 跳过 | 可按 mount 覆盖 |
| A3 | 同一轮扫描内"消失 + 出现"且内容哈希相同 → 判为移动，不报异常 | 跨机不做身份继承 |
| A4 | include + exclude，exclude 优先；doublestar 语法；规则版本上报 | 见 §5.6 |
| A5 | 符号链接不跟随；硬链接按内容去重统计；稀疏文件按实际数据读；网络盘标 `fs_kind=network` | v1 只保证正确性 |
| A6 | 只校验内容；元数据仅作跳过依据 | 元数据无法区分"有意修改"与损坏 |
| B1 | 无单文件上限，流式 1MiB 缓冲；目标规模百万文件 / TB 级 | |
| B2 | 双闸 `bytes_per_sec` + `files_per_sec`，文件为原子单位，长期平均 | 见 §5.5 |
| B3 | 每 mount 夜间窗口 + 每日时间预算；窗口结束默认读完当前文件 | 可配 `abort` |
| C1 | 当前状态 + 变更事件 + 观测历史；历史默认保留 365 天 | 防"每轮每文件一条"爆炸 |
| C2 | SQLite（WAL），单文件 | 留 Postgres 迁移路径 |
| C3 | 每日快照 + JSON/CSV 导出 | |
| D1 | 内容哈希全等 | |
| D2 | hub 中转 + 分块续传 | |
| D3 | 默认隔离 30 天 / 容量上限 | 保留证据 |
| D4 | 源只读、目标写；修复独立开关 + 路径白名单 | |
| E1 | HTTPS REST + 轮询 | 无 WS/gRPC |
| E2 | 本地 spool + 指数退避；租约到期重派 | |
| E3 | hub 时间为准，agent 报偏移 | |
| E4 | 默认仅局域网；公网需反代 + TLS + token | 不做 P2P |
| F1 | 单用户，Web 必须登录 | |
| F2 | 一次性注册 token + 长期 bearer | 可轮换/吊销 |
| F3 | 推荐 Caddy 反代终止 TLS；hub 支持自签；默认要求 https | |
| F4 | 最小权限；只读挂载为默认，修复单独授权 | |
| G1 | Go（≥1.24），核心零 CGO | ✅ 已定 |
| G2 | Wails v3 + 系统 WebView，托盘 + 窗口 | ✅ 已定；先做 spike |
| G3 | 桌面不做服务；NAS 用 systemd 或 Docker | ✅ 已定 |
| H1 | M1 仅 Web；M2 加 webhook / IM / 邮件 | |
| H2 | 按 mount + 类型 + 时间窗聚合，支持静默期与日报 | |
| I1 | 不做块级/纠删码，保留扩展位 | |
| I2 | 不做云盘/对象存储（M4 再议） | |
| I3 | 不做文件版本，只保留观测历史 | |
| I4 | 提供 CLI（agent 必需；hub 提供 export / drill） | |

## 4. 中心服设计

### 4.1 模块

```
hub/src/
├─ http/       路由、鉴权中间件、错误处理（problem+json）
├─ registry/   机器、agent、token 的注册与吊销
├─ mounts/     挂载点登记、规则与配置版本
├─ jobs/       任务创建、租约、状态机、取消
├─ ingest/     批量结果入库、路径状态迁移、覆盖率
├─ issues/     异常判定、置信度、自动关闭
├─ transfer/   修复票据、分块中转、TTL 清理
├─ audit/      审计日志
├─ db/         连接、迁移、批量写入
└─ web/        静态资源（Vite 构建产物）
```

### 4.2 API（v1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/enroll` | 注册 token → 长期 agent token |
| POST | `/api/v1/agent/heartbeat` | 心跳 + 取任务/取消/配置版本/清单版本（可长轮询 25s） |
| GET | `/api/v1/mounts/{id}/manifest` | agent token：流式 NDJSON（gzip）下发路径清单，用于缓存重建 / 增量同步 |
| POST | `/api/v1/jobs/{id}/results` | 批量结果，`seq` 幂等，≤1000 条/批 |
| POST | `/api/v1/jobs/{id}/finish` | 完成 / 失败 + 统计 |
| GET | `/api/v1/jobs/{id}` | 状态与取消检查 |
| POST | `/api/v1/transfers` | 创建修复票据（源/目标/期望哈希/TTL） |
| PUT / GET | `/api/v1/transfers/{id}/data` | 源上传 / 目标按 offset 下载 |
| CRUD | `/api/v1/{machines,mounts,jobs,issues}` | Web 控制面 |
| GET | `/api/v1/audit` | 审计查询 |

### 4.3 任务与租约

状态机：`pending → dispatched → running → completed | failed | canceled | expired`。

- 派发时写 `lease_until = now + 60s`；每批结果或 30s keepalive 续租。
- 租约过期且无新批次 → 回到 `pending`，重试计数 +1，超过 3 次判 `failed`。
- 所有批次按 `(job_id, seq)` 幂等，重放不重复入库。
- 取消：心跳响应携带 `cancel`，agent 在当前文件完成后停止。

### 4.4 调度

- 每 30s tick；按 mount 计算是否到期（默认每日一次，可配间隔）。
- 只有落在 `window` 内、且当日预算未用完才派发。
- 同一 mount 同时只有一个活跃 job；同一 agent 全局并发 1。
- 手动触发（Web/CLI）不受窗口限制，但受 agent 在线状态限制。

### 4.5 存储

表：`machines` / `agents` / `mounts` / `paths` / `observations` / `issues` / `scan_jobs` / `scan_batches`（幂等去重）/ `transfer_tickets` / `repair_jobs` / `audit_log` / `settings`。

关键索引：`paths(mount_pk, path_key)` 唯一、`paths(content_hash)`、`issues(status)`、`observations(path_pk, observed_at)`、`scan_batches(job_pk, seq)` 唯一。

批量写入：1000 行/事务，`INSERT ... ON CONFLICT` 更新当前状态；只有哈希值变化才追加 `observations`。

### 4.6 规模与目标

- 100 万文件 × 约 200B ≈ 200–300MB；百万行入库 1–2 分钟。
- hub 目标：RSS < 512MB，API p95 < 100ms，批量入库 ≥ 5k 条/s。

## 5. Agent 设计

### 5.1 双形态与目录

```
agent/
├─ internal/core/            # 零 GUI 依赖，桌面与无头共用
│  ├─ config/                # YAML 解析、校验（mount_id、重叠、规则、限速）
│  ├─ mountguard/            # sentinel、可达性预检、消失率熔断
│  ├─ walker/                # 流式遍历、目录剪枝、稳定读取
│  ├─ rules/                 # include/exclude 匹配、静态前缀、规则版本
│  ├─ hash/                  # SHA-256 流式（1MiB buffer pool）
│  ├─ ratelimit/             # credit bucket（双闸，文件原子）
│  ├─ hubclient/             # HTTP、重试、退避、keepalive
│  ├─ state/                 # 本地状态缓存（bbolt，跳过判定用）
│  ├─ spool/                 # JSONL 离线队列
│  ├─ scan/                  # 任务执行器（流水线编排）
│  └─ repair/                # 接收流、校验、quarantine、原子替换
├─ cmd/observer-agent/       # 无头二进制（CGO_ENABLED=0）
└─ cmd/observer-agent-desktop/  # Wails（build tag: gui）
   └─ frontend/              # React + Tailwind
```

构建：`go build ./cmd/observer-agent`（NAS/CLI）；`wails build`（桌面）。交叉编译 `GOOS=linux GOARCH=amd64|arm64`。

### 5.2 桌面进程模型

- 单进程：Go 运行时 + 系统 WebView；扫描在 goroutine 中运行，UI 通过 Wails binding 直接读状态，**不起本地 HTTP 服务**。
- 托盘菜单：打开界面 / 暂停 / 立即巡检 / 退出；关闭窗口 = 隐藏到托盘，扫描继续。
- 开机启动：按 T17 写入系统自启项，应用内可关。
- 单实例：命名互斥（Windows）/ 本地 socket 锁（macOS），重复启动只唤起已有窗口。
- 退出：先取消当前任务、flush spool，再退出。

### 5.3 配置

与 [路径与身份模型 §4](DESIGN-PATH-MODEL.md) 的 mount 配置一致，另加 `limits` 与 `include`：

```yaml
agent:
  machine_id: nas-01            # 本机声明；hub 注册时校验唯一性
  hub: https://hub.lan:8787
  cache_full_resync_days: 7     # 全量清单对账周期（天），0 = 关闭
defaults:
  limits: { bytes_per_sec: 200MiB, files_per_sec: 300 }
mounts:
  - id: photo
    label: 照片
    path: /volume1/photos
    sentinel: .observer-mount
    fs_kind: local
    include: ["**/*.{jpg,jpeg,png,heic,heif}"]
    exclude: ["**/@eaDir/**", "**/.thumbnails/**"]
    limits: { bytes_per_sec: 150MiB, files_per_sec: 200, burst_bytes: 9GiB, on_window_end: finish }
    schedule: { budget_minutes_per_day: 120, window: "01:00-06:00" }
```

`machine_id` 是身份：由 **agent 配置声明**，hub 校验 `^[a-z0-9][a-z0-9_-]{0,31}$` 并按它把多个 agent **归并到同一台机器**（同机多 agent = 同 `machine_id`、不同 `agent_id`）。同一机器下 `mount_id` 冲突（两个 agent 声明同一挂载点）→ 注册被拒（409）。改名只走迁移操作；重装时保留同一配置即保留身份。

### 5.4 扫描流水线

```
walker(流式, 有界 channel 4096)
  → 每条目：文件数限速 → stat → 稳定性检查 → 规则匹配
      → 跳过（记录 skipped 原因）或 进入哈希队列
  → 哈希 worker：字节限速（文件级等待）→ 流式 SHA-256 → 结果
  → 批打包（1000 条 / 2s）→ 上传（失败进 spool，指数退避）
```

- 哈希并发默认 `min(4, NumCPU/2)`，机械盘 mount 默认 1。
- 读取前后各 stat 一次；size/mtime 变化 → 标 `unstable` 跳过，下轮重验。
- 大目录用 `ReadDir(n)` 流式读取，避免一次载入几十万条目。

### 5.5 限速（文件为原子单位）

- 一个文件要么完整算完，要么完全不算；**不做文件内断点**。
- 限速只在文件开始前生效：等待额度 → 全速读完 → 中途不 sleep。
- `bytes_per_sec` 是**长期平均**；瞬时峰值 = 单文件读取速度。
- 自研 credit bucket：credit 按速率补充、上限 `burst_bytes`（默认 60 秒额度）、可为负（欠账）。
  - `need = min(fileSize, burst)`；等到 `credit ≥ need` 后 `credit -= fileSize`，允许变负。
  - 单文件开始前最多等 `burst / rate`（默认 60s）；超出部分在后续文件等待中偿还。
- `files_per_sec` 是第二个桶；两个桶在文件入口处取较长等待。
- 等待期间每 30s 发 keepalive，防止租约过期。
- 上报 `io_budget_wait_ms`、`effective_files_per_sec`、`effective_bytes_per_sec`；UI 显示"等待 IO 额度"。
- 边界：窗口结束默认读完当前文件（`abort` 可改）；用户暂停/取消立即中止并丢弃该文件结果；读失败退还未读字节额度；大文件后的长时间空闲是"还账"，属预期。

### 5.6 include / exclude 规则

- 优先级：必须命中 ≥1 条 include（为空视为全命中）且不命中任何 exclude；**exclude 优先**。
- 匹配相对路径（`/` 分隔、NFC 归一），大小写按 mount 的 `case_sensitive`。
- 语法：`*`、`**`、`?`、`[...]`、`{a,b}`（doublestar v4 语义）。
- 校验：相对路径、不以 `/` 开头、无 `..`/NUL；非法规则配置加载期报错。
- 目录剪枝：按 include 的静态前缀剪掉不可能命中的目录；以 `**` 开头的规则退化为全遍历。
- 规则版本：`rules_hash = sha256(include + exclude + case_sensitive)`，随批次上报；变化时 hub 提示"历史不可直接比较"，建议全量重扫。
- **规则收紧后**，不再命中的旧路径迁移为 `out_of_scope`，不判 missing、不产异常；放宽后重新纳入待验证队列。
- `sentinel` 校验不受规则影响。
- `--dry-run`：只遍历不读内容，输出纳入文件数/字节数、排除原因分布、按当前限速的预计耗时。

### 5.7 稳定性与离线

- 本地状态缓存（bbolt）：每个 mount 下 `path_key → {size, mtime_ns, hashed_at}`，仅用于跳过判定。
- **清单同步（hub 是唯一真相源）**：`mounts.manifest_epoch` 随路径变化递增；心跳返回各 mount 的 epoch，agent 发现本地 epoch 不同时，通过 `GET /api/v1/mounts/{id}/manifest?since=` 流式拉取并更新缓存。批次/完成响应也回传最新 epoch，agent 落库后记录，避免"自己写的变更又触发自己拉取"。
- **缓存丢失不再等于全量重算**：缓存缺失（换机、重装、文件损坏）→ 先拉清单重建；只有 `db_instance_id` 变化（hub 换库或从备份恢复）或清单不可用时，才退化为全量重算。
- **规则变更不清缓存**：include/exclude 只影响范围匹配；已有条目的 `size/mtime/hashed_at` 仍然有效。
- 清单字段：`path_key`、`size`、`mtime_ns`、`hashed_at`；默认不带内容哈希（跳过判定不需要，可省约 40% 体积），诊断可用 `include_hash=1`。
- **清单不做"到期过滤"**：是否跳过必须由 agent 用本地当前 stat 与清单条目比对（`size` + `mtime_ns` 相同且 90 天内才跳过）。若 hub 提前按 90 天过滤，agent 就无法区分"已验过且未变"与"从未见过"，只能全量重算或冒险跳过。hub 侧只过滤 `state=active` 且落在当前 include/exclude 范围内的路径。
- 清单传输：NDJSON + gzip 流式，agent 按 1 万条/事务写入 bbolt，内存有界；百万文件约 30–60MB 压缩后数据。
- **全量对账兜底**：无论 epoch 是否变化，agent 每 `cache_full_resync_days`（默认 7 天，0 关闭）主动拉一次全量清单，防止 epoch 漏记（响应丢失、手工改库、实现 bug）。成本与一次缓存重建相同。
- spool：JSONL append + fsync；按 `(job_id, seq)` 去重，重启后重放。有未补发结果时先补发，再拉清单（避免旧清单覆盖新状态）。
- hub 不可达：指数退避（1s 起、上限 5min），期间继续本地扫描但只写 spool。
- 崩溃重启：进行中的 job 因租约过期由 hub 重派；已完成批次幂等吸收。

### 5.8 修复执行

- 目标端：接收流 → 临时文件（同目录）→ 边写边算 SHA-256 → 校验期望哈希 → fsync → 坏文件移入 quarantine → 原子 rename。
- 源端：只读打开，边读边算，与期望哈希比对，不匹配立即中止并告警。
- 任一步失败：删除临时文件，不动原文件，回报失败原因。

### 5.9 NAS 形态

- systemd：`deploy/observer-agent.service`，`Restart=on-failure`，`User=`/`Group=` 可配。
- Docker：multi-stage → scratch/distroless（约 15MB），mount 只读挂载，`--read-only` rootfs，UID/GID 参数化。
- 无 GUI 依赖：`CGO_ENABLED=0`，二进制不含 WebView 代码。

### 5.10 资源目标

| 场景 | 内存目标 | CPU |
| --- | --- | --- |
| 桌面闲置（含 WebView） | ≤ 120MB | ≈ 0 |
| 桌面扫描中 | ≤ 200MB | 受限速约束 |
| NAS 闲置 | ≤ 30MB | ≈ 0 |
| NAS 扫描中 | ≤ 80MB | 受限速约束 |

## 6. 协议

### 6.1 约定

- JSON over HTTPS；`Content-Type: application/json`；时间字段用 epoch 毫秒（UTC，整数）。
- 请求头 `Observer-Protocol: 1`、`Observer-Agent-Version: x.y.z`。
- 路径字段同时给 `path_key` 与 `path_display_b64`（保真）；`mtime_ns` 用**十进制字符串**传输（避免 JS 53 位精度丢失）。

### 6.2 幂等与重试

- 结果批次以 `(job_id, seq)` 唯一；重复提交返回 200 且不重复入库。
- 所有写接口可安全重试；`409` 表示状态冲突（如任务已被取消），agent 停止。
- 退避：1s、2s、4s… 上限 5min；`Retry-After` 优先。

### 6.3 错误

`application/problem+json`：`type`、`title`、`status`、`detail`、`retryable`。

### 6.4 版本协商

hub 记录 `min_agent_version`；低于则返回 `426`，agent 提示升级但继续心跳。协议主版本不匹配则拒绝派发任务。

## 7. 数据模型

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| machines | machine_id, label, hostname, platform, arch, last_seen_at, status | 一台物理机 |
| agents | machine_pk, token_hash, version, protocol, capabilities, revoked_at | 可多个（同机多命名空间） |
| mounts | machine_pk, mount_id, label, physical_path, sentinel, fs_kind, flags, include, exclude, rules_hash, limits, schedule, state, manifest_epoch, updated_at | 逻辑挂载点 |
| paths | mount_pk, path_key, path_display(BLOB), size, mtime_ns(字符串), content_hash, volume_id, last_seen_job_pk, last_seen_at, last_hashed_at, last_hash_kind, state, change_epoch, updated_at | 当前状态，`(mount_pk, path_key)` 唯一 |
| observations | path_pk, hash, algo, kind(baseline/scan/repair), observed_at | 仅哈希事件 |
| issues | path_pk, mount_pk, type(mismatch/missing/unreadable), status, confidence, evidence, occurrences, first_seen_at, last_seen_at, resolved_at | 异常；`(path_pk, type)` 唯一，恢复后重置不新开行 |
| scan_jobs | mount_pk, mode, status, rules_hash, lease_until, attempt, cancel_requested, stats, timestamps | 任务；每 mount 仅一个活跃任务 |
| scan_batches | job_pk, seq, received_at | 幂等去重 |
| transfer_tickets | repair_pk, expected_hash, size, expires_at | 中转 |
| repair_jobs | issue_pk, source_path_pk, target_path_pk, status, bytes_done, verify_result | 修复 |
| audit_log | actor, action, target, detail, at | 审计 |
| settings | key, value（含 `db_instance_id`，首次建库生成） | 全局配置 |

- 保留策略：`observations` 默认 365 天（可按 mount 覆盖）；`audit_log` 永久（体积小）；`scan_batches` 任务完成后 7 天清理。
- 规模：百万文件 → `paths` 约 200–300MB；每次全量扫描只追加变化的观测。
- 时间约定：epoch 毫秒；`mtime_ns` 用十进制字符串（防 JS 精度丢失）；`path_display` 存 BLOB，wire 上再 base64。
- 关键约束：每 mount 仅一个活跃任务（partial unique index）、每路径每类异常一条生命周期记录（`UNIQUE(path_pk,type)`）、路径增量靠 `change_epoch`（与 `mounts.manifest_epoch` 同事务自增）。
- 索引：`paths(content_hash)`、`paths(mount_pk,state,last_hashed_at)`、`paths(mount_pk,last_seen_job_pk)`、`paths(mount_pk,change_epoch)`、`scan_jobs(status,lease_until)`、`audit_log(at)`。

## 8. 关键流程

### 8.1 建基线

1. 管理员创建注册 token → agent 安装并注册（配置声明 `machine_id`，上报 mount 声明）；
2. hub 登记 mount（mount_id 冲突或路径重叠则拒绝）；
3. agent 做 mountguard 预检（sentinel、可达性）；
4. 派发 `baseline` job → 全量哈希 → 批次入库 → 完成；
5. 覆盖率 = 已哈希路径 / 纳入路径。

### 8.2 周期巡检

1. 调度器按窗口与预算创建 `incremental` job；
2. agent 取任务 → 遍历 → 规则过滤 → 跳过判定 → 哈希 → 批次上报；
3. hub 更新 `paths` 当前状态；哈希变化 → 写 `observations` 并触发异常判定；
4. 任务完成 → 计算覆盖率、更新 mount 状态。

### 8.3 异常判定与置信度

- `mismatch`（哈希与上一次可信观测不同）：默认高置信；若该轮同时出现大量变化（群组异常），降级为"疑似批量变更"，不自动关闭。
- `missing`：扫描完整完成后仍未见，且 mount 状态正常、非规则变更导致 → 中置信。
- `unreadable`：权限/IO 错误 → 单独类型。
- 置信度与依据（上次哈希时间、其他机器副本、是否 mtime 同时变化）写入 `evidence`，供 UI 解释。
- 文件恢复且哈希与可信观测一致 → 自动关闭异常。

### 8.4 修复

1. 用户在 Web 选源/目标 → hub 校验（同内容、源可信、目标 mount 允许写）；
2. 创建票据 → 源 agent 上传（分块续传）→ 目标 agent 下载并校验 → quarantine → 原子替换；
3. 替换成功后目标端重新哈希并上报 → 与期望一致则关闭异常，否则报修复失败；
4. 全程审计。

### 8.5 规则变更

- hub 收到 `rules_hash` 变化 → 标记 mount "规则已变更"，覆盖率时间线断开；
- 不在范围内的旧路径置 `out_of_scope`（不产异常，历史保留）；
- 建议用户运行一次全量重扫，重建可比基线。

## 9. 失败模式与降级

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| 磁盘/容器卷未挂载 | 目录存在但空 | sentinel 校验 + 消失率熔断 + 不产 issue（见路径模型 §6.1） |
| hub 不可达 | 任务无法领取/结果无法上报 | 指数退避 + spool 补发 |
| agent 崩溃/断电 | 任务中断 | 租约过期重派；批次幂等 |
| 读取中文件被改 | 哈希不稳定 | 读前后 stat 对比 → `unstable` 跳过重试 |
| 单文件读失败 | 权限/IO 错误 | 记 `unreadable`，不中断整轮 |
| 窗口结束 | 扫描被截断 | 读完当前文件后暂停，下窗口续跑 |
| 配额耗尽后大文件 | 长时间空闲等待 | 属"还账"预期；UI 显示等待原因 |
| hub 磁盘满 | 入库/中转失败 | 拒收并告警；任务保留可重试 |
| 规则收紧 | 旧路径失联 | `out_of_scope`，不误报 |
| 时钟漂移 | 租约误判 | 以 hub 时间为准，记录偏移 |

## 10. 安全

- 注册 token 一次性、24h 过期；长期 token 32B 随机，库内只存 SHA-256。
- 路径穿越：mount 白名单 + `filepath.Clean` + 落点必须在 mount 内 + 拒绝符号链接越界。
- 修复：默认关闭；需 `repair_allowed`、目标在 mount 内、源端独立重算哈希、quarantine、审计。
- Web：单用户密码（`node:crypto` scrypt，零原生依赖）+ HttpOnly 会话 cookie + CSRF 防护 + 登录限速。
- 传输：默认 HTTPS；TLS 由 Caddy/反代或 hub 自签提供。
- 审计：所有写操作与修复动作落 `audit_log`，含操作者、目标、结果。

## 11. 测试与演练

- 单元：Go（walker/rules/hash/ratelimit/scan 状态机）、TS（入库、判定、租约）。
- 契约：`api/openapi.yaml` 校验与示例请求。
- 集成：docker compose 起 hub + 2 个 agent 容器，跑完整扫描与修复。
- 演练脚本 `scripts/drill.ps1`：建基线 → 翻转字节 → 断言异常 → 恢复 → 断言关闭。
- 性能基线：10 万文件 / 1TB 生成器，记录吞吐、内存、入库速率。
- 故障注入：hub 重启、agent 断网、DB 锁、磁盘满。

## 12. 部署与运维

- hub：`docker compose up -d`（hub + 可选 caddy），数据卷 `/data`（SQLite + 备份）。
- 桌面 agent：Windows 安装包（Inno Setup/NSIS）、macOS `.app`（ad-hoc 签名；公证 M4）；首启引导填 hub 地址与注册 token。
- NAS：systemd unit 或容器；只读挂载；UID/GID 参数化。
- 升级：hub 向前兼容一个协议版本；agent 通过 hub 提示升级（v1 手动下载）。
- 备份：每日快照保留 7 份；提供 `observer export`。

## 13. 里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 | hub（SQLite + 注册/心跳/任务/结果/异常/覆盖率）+ 无头 agent core + 最小 Web + 演练脚本 | 单机发现手工损坏，覆盖率可见 |
| M2 | 桌面 GUI（Wails + 托盘 + 自启 + 单实例）、调度窗口/预算、通知（webhook/IM）、多机 | 两台机器同时巡检；桌面可看进度 |
| M3 | 副本关联、修复（隔离 + 中转 + 校验）、审计 | 从健康副本恢复后哈希一致 |
| M4 | NAS 容器打磨、macOS 签名公证、块级/事件优化、告警聚合 | 三平台可用 |

## 14. 未决问题

- ❓ Wails v3 需先做 1 天 spike（窗口/托盘/自启/IPC）；若阻塞，回退 Wails v2（绑定层改，core 不动）。
- ❓ 桌面安装包形式（Inno Setup vs NSIS vs WiX）与 macOS 分发方式。
- ❓ NAS 具体架构（amd64 / arm64）需在部署时确认，两者都交叉编译。

## 15. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿：Go+Wails 双形态、双限速（文件原子）、include/exclude、hub 协议与数据模型、里程碑 |
| v0.2 | 2026-10-29 | 同步需求 v0.4：`machine_id` 改为 agent 配置声明、hub 校验唯一性；J 组全部定稿 |
| v0.3 | 2026-10-29 | 补充 agent 本地状态缓存（bbolt，用于跳过判定）；口令哈希改用 `node:crypto` scrypt（零原生依赖） |
| v0.4 | 2026-10-29 | 增加清单同步：`manifest_epoch` + 流式 NDJSON 下发；缓存丢失不再触发全量重算；清单不做到期过滤（由 agent 本地比对）；规则变更不清缓存 |
| v0.5 | 2026-10-29 | 增加清单全量对账兜底周期 `cache_full_resync_days`（默认 7 天，0 关闭） |
| v0.6 | 2026-10-29 | 数据库结构评审：`mtime_ns` 改字符串防精度丢失、增量改用 `change_epoch`、补唯一索引 / CHECK 约束 / 索引与保留策略 |
