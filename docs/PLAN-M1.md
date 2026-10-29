# Observer M1 实施计划

> 版本：v0.3　日期：2026-10-29　性质：可执行实施计划
>
> 上游：[需求整理](REQUIREMENTS.md)（v0.4）、[技术方案](DESIGN-TECH.md)（v0.3）、[路径与身份模型](DESIGN-PATH-MODEL.md)（v0.3）。
> 目标：**单机最小闭环**——一个 hub + 一个 agent（同一台 Windows 机器，localhost），跑通「登记 → 基线 → 巡检 → 发现异常 → 关闭异常」。

## 1. 范围

### 1.1 做（M1 In）

**Hub**
- 环境配置与 SQLite 迁移；`/healthz`。
- 一次性注册 token（CLI 生成）+ agent 长期 token。
- `enroll` / `heartbeat`（15s 短轮询）/ 任务租约 / 取消标记。
- 路径清单下发：`manifest_epoch` + 流式 NDJSON（gzip），供 agent 缓存重建与增量同步。
- 手动触发巡检（Web/API），任务状态机与幂等批次。
- 结果入库：`paths` 当前状态、`observations`（仅变化时）、覆盖率。
- 异常：`mismatch` / `missing` / `unreadable`，含置信度与依据；恢复后自动关闭。
- mountguard：sentinel 缺失、消失率熔断（不产成批 missing）。
- 审计日志、结构化日志、`/metrics`（可选）。

**Agent（无头 CLI）**
- YAML 配置 + 启动校验（machine_id 格式、mount_id 格式、路径重叠、规则合法性、限速单位）。
- 注册与 token 落盘；心跳取任务。
- 遍历（流式、目录剪枝、符号链接不跟随）、include/exclude 规则、sentinel 校验。
- SHA-256 流式哈希；文件级原子读取。
- 双闸限速（`bytes_per_sec` + `files_per_sec`，credit bucket + 欠账）。
- 跳过判定（bbolt 本地缓存：size + mtime_ns + 90 天兜底）。
- 清单同步：缓存缺失或 epoch 不一致时从 hub 流式拉取清单重建，**不触发全量重算**（仅 hub 换库 `db_instance_id` 变化时例外）。
- 清单全量对账兜底：默认每 7 天拉一次全量清单（`cache_full_resync_days`，0 关闭），防止 epoch 漏记。
- 批量上报（1000 条 / 2s）、`(job_id, seq)` 幂等、JSONL spool + 指数退避。
- 三种模式：`baseline` / `incremental` / `full`。
- CLI：`run` / `scan` / `doctor` / `version`。

**Web（最小控制台）**
- 登录、总览、机器与挂载点、挂载点详情（覆盖率 / 触发巡检）、任务列表与进度、异常列表与确认。

**脚本**
- `scripts/drill.ps1`：一键跑完 9 条验收。
- `scripts/dev-up.ps1`：本地起 hub + agent（开发用）。

### 1.2 不做（M1 Out，留给后续）

调度窗口与每日预算、通知渠道、桌面 GUI（Wails）、修复与传输、多机副本、TLS/Caddy、Docker 镜像、重命名识别、`out_of_scope` 状态、块级校验、事件驱动。

### 1.3 已知限制（M1 接受）

- 规则变更后的一轮不判 `missing`（避免误报），`out_of_scope` 模型 M2 实现。
- 文件重命名 = missing + 新文件（M2 做同内容匹配）。
- 心跳为 15s 短轮询，长轮询 M2。
- 每 mount 同时只跑一个任务；单用户。

### 1.4 验收（9 条，drill.ps1 逐条断言）

| # | 验收 | 判定 |
| --- | --- | --- |
| 1 | hub 单进程启动，Web 可登录 | 登录后 200 |
| 2 | CLI 生成注册 token → agent 注册 → 机器与 mount 出现在界面 | 接口可见 |
| 3 | 1000 个文件基线扫描完成 | 覆盖率 100% |
| 4 | 翻转 1 字节并保持 mtime → `full` 巡检 | 高置信 `mismatch` |
| 5 | 删除文件 → 巡检 `missing`；恢复文件 → 巡检后异常自动关闭 | 状态变化正确 |
| 6 | 扫描中途重启 hub | 任务租约回收、批次不重复入库 |
| 7 | hub 停机期间 agent 完成扫描 | 结果进 spool，恢复后补发成功 |
| 8 | sentinel 改名 → 巡检 | mount `unavailable`，不产生成批 missing |
| 9 | 清空 agent 本地缓存后巡检 | 从 hub 清单恢复，实际哈希文件数 < 5%（不是全量重算） |

## 2. 仓库骨架与工具链

```
observer/
├─ package.json               # 根脚本（dev/build/test/lint）
├─ pnpm-workspace.yaml
├─ api/openapi.yaml           # M1 协议契约（手写，测试校验）
├─ hub/
│  ├─ migrations/0001_init.sql
│  ├─ src/{main,app,env}.ts
│  ├─ src/db/{index,migrate}.ts
│  ├─ src/http/{auth,errors,routes/*}.ts
│  ├─ src/services/{registry,jobs,ingest,issues,coverage,audit}.ts
│  ├─ src/cli/token.ts
│  └─ test/{unit,integration}/
├─ web/
│  ├─ vite.config.ts
│  └─ src/{main.tsx,api.ts,pages/*,components/*}
├─ agent/
│  ├─ go.mod
│  ├─ cmd/observer-agent/main.go
│  └─ internal/{config,mountguard,rules,hash,ratelimit,state,hubclient,spool,scan,version}/
├─ scripts/{drill.ps1,dev-up.ps1}
└─ docs/
```

工具链：Node ≥ 22.23（已装 22.23.2）、pnpm 11.22（已装）、Go ≥ 1.24（**待装**：`winget install GoLang.Go`）、git 2.56（已装）。

常用命令：

```powershell
pnpm install
pnpm --filter hub dev                     # hub: http://localhost:8787
pnpm --filter web dev                     # 前端: http://localhost:5173（代理 /api）
cd agent; go run ./cmd/observer-agent -config ..\agent.dev.yaml
```

## 3. 阶段拆分

| 阶段 | 内容 | 主要产出 | 依赖 | 规模 |
| --- | --- | --- | --- | --- |
| P0 | 工程骨架 | workspace、hub 骨架、agent 骨架、脚本 | — | S |
| P1 | hub 数据层与鉴权 | 迁移、会话、enroll、token CLI | P0 | M |
| P2 | hub 任务与入库 | 手动任务、租约、批量入库、覆盖率、异常 | P1 | M |
| P3 | agent 核心 | 配置/规则/遍历/哈希/限速/缓存 | P0 | L |
| P4 | agent 全链路 | 注册、执行器、spool、CLI | P2、P3 | M |
| P5 | Web 控制台 | 登录/总览/机器/挂载点/任务/异常 | P2 | M |
| P6 | 演练与验收 | drill.ps1、性能基线、收尾、tag | P4、P5 | S |

> P3 与 P1/P2 写入范围互不重叠（`agent/` vs `hub/`），可并行推进。

### P0 工程骨架

- 根 `package.json` + `pnpm-workspace.yaml` + 共享 `tsconfig.base.json`。
- `hub`：Fastify + `/healthz` + vitest 跑通；`src/env.ts` 读取 `OBSERVER_PORT`、`OBSERVER_DATA_DIR`、`OBSERVER_ADMIN_PASSWORD`。
- `agent`：`go mod init`；`main.go` 支持 `version`；`go test ./...` 跑通。
- `api/openapi.yaml` 初稿（只列端点与 schema 名）。
- 验收：`pnpm -r test`、`go test ./...` 通过；`git status` 干净。

### P1 hub 数据层与鉴权

- `0001_init.sql` 全量建表（见 §4）；迁移 runner 记录 `schema_migrations`。
- 口令：`node:crypto` scrypt 哈希；会话表 + cookie（HttpOnly、SameSite=Lax、7 天）。
- 登录限速（内存计数：同一 IP 5 次/分钟）。
- 注册 token CLI：`pnpm --filter hub token:create -- --machine nas-01`，输出一次性 token（库内仅存哈希，24h TTL）。
- `POST /api/v1/enroll`、`POST /api/v1/agent/heartbeat`（心跳暂只更新 last_seen 并返回空任务）。
- 验收：curl 完成注册；重复 `mount_id` 返回 409；非法 token 返回 401。

### P2 hub 任务与入库

- 手动任务：`POST /api/v1/mounts/{id}/scan {mode}`。
- 心跳返回任务（`lease_until = now + 60s`），批次/心跳续租；租约过期回 `pending`，重试 > 3 判 `failed`。
- `results` / `finish`：`scan_batches` 幂等；`paths` upsert；哈希变化写 `observations`。
- 清单接口：`GET /api/v1/mounts/{id}/manifest` 流式 NDJSON（gzip）；`manifest_epoch` 在路径变化时递增；心跳与批次响应回传最新 epoch。
- 覆盖率、missing 判定、熔断、`issues` 生成与自动关闭、审计。
- 验收：集成测试用模拟 agent 上报 3 个文件（一致/变化/丢失）→ 断言 DB 与接口。

### P3 agent 核心

- `config`：YAML 解析 + 严格校验（错误信息含字段路径）；限速单位解析（`200MiB`）。
- `rules`：include/exclude 编译、静态前缀剪枝、`rules_hash`。
- `walker`：流式遍历（`ReadDir(n)`）、不跟随符号链接、读前后 stat。
- `hash`：SHA-256 + 1MiB 缓冲池。
- `ratelimit`：credit bucket（文件桶 + 字节桶，允许欠账）。
- `state`：bbolt 缓存（`files:<mount_id>` bucket）。
- `mountguard`：sentinel 校验、可达性预检、消失率计算。
- 验收：`go test ./internal/...` 覆盖配置校验、规则匹配、限速时序、缓存跳过。

### P4 agent 全链路

- `hubclient`：enroll（token 落盘 0600）、heartbeat、results、finish；重试与退避。
- `manifest` 同步：任务开始前比对 epoch，必要时流式拉取并写 bbolt（1 万条/事务）；有未补发结果时先补发再拉取。
- `spool`：JSONL append + fsync；按 `(job_id, seq)` 去重补发。
- `scan`：编排跑批（1000 条/2s）、`full`/`incremental`/`baseline`、取消检查、进度统计。
- CLI：`run`（常驻）、`scan --mount <id> --full`、`doctor`（配置/连通性/权限自检）、`version`。
- 验收：与本机 hub 联调完成一次 baseline 与一次 incremental。

### P5 Web 控制台

- 登录页 → 总览（机器数、挂载点数、覆盖率、异常数、最近任务）。
- 机器页 → 挂载点列表 → 挂载点详情（覆盖率、规则、最近任务、触发巡检按钮）。
- 任务页（状态、进度、统计）、异常页（类型、置信度、证据、确认/忽略）。
- 构建产物由 hub 静态托管；开发期 Vite 代理 `/api`。
- 验收：纯 UI 操作完成一次巡检并看到异常。

### P6 演练与验收

- `drill.ps1` 实现 9 条验收，输出 PASS/FAIL 摘要与退出码。
- 可选性能基线：生成 10 万小文件，记录扫描耗时、吞吐、hub RSS。
- 更新 README 快速开始；打 tag `m1`。

## 4. 数据模型（SQLite v1）

```sql
CREATE TABLE machines (
  id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL UNIQUE,
  label TEXT, platform TEXT, arch TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'online'
);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY, machine_pk INTEGER NOT NULL REFERENCES machines(id),
  token_hash TEXT NOT NULL UNIQUE, version TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);

CREATE TABLE mounts (
  id INTEGER PRIMARY KEY, machine_pk INTEGER NOT NULL REFERENCES machines(id),
  mount_id TEXT NOT NULL, label TEXT, physical_path TEXT NOT NULL,
  sentinel TEXT, fs_kind TEXT NOT NULL DEFAULT 'local',
  case_sensitive TEXT NOT NULL DEFAULT 'auto', unicode TEXT NOT NULL DEFAULT 'auto',
  include_json TEXT NOT NULL DEFAULT '[]', exclude_json TEXT NOT NULL DEFAULT '[]',
  rules_hash TEXT NOT NULL, limits_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'active',
  manifest_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (machine_pk, mount_id)
);

CREATE TABLE paths (
  id INTEGER PRIMARY KEY, mount_pk INTEGER NOT NULL REFERENCES mounts(id),
  path_key TEXT NOT NULL, path_display_b64 TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, content_hash TEXT,
  last_seen_job_pk INTEGER, last_seen_at INTEGER,
  last_hashed_at INTEGER, last_hash_kind TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  updated_at INTEGER NOT NULL,
  UNIQUE (mount_pk, path_key)
);
CREATE INDEX idx_paths_hash ON paths(content_hash);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY, path_pk INTEGER NOT NULL REFERENCES paths(id),
  hash TEXT NOT NULL, algo TEXT NOT NULL, kind TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX idx_obs_path ON observations(path_pk, observed_at);

CREATE TABLE scan_jobs (
  id INTEGER PRIMARY KEY, mount_pk INTEGER NOT NULL REFERENCES mounts(id),
  mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, finished_at INTEGER, stats_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE scan_batches (
  job_pk INTEGER NOT NULL REFERENCES scan_jobs(id),
  seq INTEGER NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (job_pk, seq)
);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY, path_pk INTEGER NOT NULL REFERENCES paths(id),
  mount_pk INTEGER NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', confidence TEXT NOT NULL,
  evidence_json TEXT, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX idx_issues_status ON issues(status);

CREATE TABLE enroll_tokens (
  id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  machine_hint TEXT, expires_at INTEGER NOT NULL, used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL,
  target TEXT, detail_json TEXT, at INTEGER NOT NULL
);

-- key 含 db_instance_id：首次建库生成，用于判断 hub 是否换库/恢复
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## 5. API 契约（M1）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/enroll` | 注册 token | 返回 agent 长期 token；同机器 `mount_id` 冲突 409 |
| POST | `/api/v1/agent/heartbeat` | agent token | 返回任务 / 续租 / 取消标记 / 清单 epoch |
| GET | `/api/v1/mounts/{id}/manifest` | agent token | 流式 NDJSON（gzip）路径清单；`since` 预留增量 |
| POST | `/api/v1/jobs/{id}/results` | agent token | 批次幂等（`job_id` + `seq`） |
| POST | `/api/v1/jobs/{id}/finish` | agent token | 完成/失败 + 统计 |
| POST | `/api/v1/auth/login` | — | 建立会话 |
| GET | `/api/v1/overview` | 会话 | 总览数字 |
| GET | `/api/v1/machines`、`/machines/{id}` | 会话 | 机器与挂载点 |
| GET | `/api/v1/mounts/{id}` | 会话 | 覆盖率、规则、最近任务 |
| POST | `/api/v1/mounts/{id}/scan` | 会话 | `{mode: incremental 或 full}` |
| GET | `/api/v1/jobs`、`/jobs/{id}` | 会话 | 任务与进度 |
| GET | `/api/v1/issues` | 会话 | 异常列表 |
| POST | `/api/v1/issues/{id}/ack`、`/ignore` | 会话 | 确认 / 忽略 |

请求/响应要点：

```jsonc
// POST /api/v1/enroll
// header: X-Observer-Enroll-Token: <一次性 token>
{ "machine_id": "dev-win-01", "label": "开发机", "hostname": "DESKTOP",
  "platform": "windows", "arch": "amd64", "agent_version": "0.1.0",
  "mounts": [{ "mount_id": "drill", "physical_path": "E:\\drill",
    "sentinel": ".observer-mount", "include": [], "exclude": ["**/.observer-mount"],
    "limits": {"bytes_per_sec": 209715200, "files_per_sec": 300},
    "rules_hash": "…" }] }
// → 201 { "agent_id": 1, "token": "…", "machine_id": "dev-win-01" }

// POST /api/v1/agent/heartbeat
// → 200 { "server_time": 1761…, "job": { "id": 7, "mode": "full",
//         "mount_id": "drill", "lease_until": 1761… },
//         "cancel": false }

// POST /api/v1/jobs/7/results
{ "seq": 3, "entries": [
  { "path_key": "2024/a.jpg", "path_display_b64": "MjAyNC9hLmpwZw==",
    "size": 1024, "mtime_ns": 1761…, "hash": "ab…", "status": "ok" },
  { "path_key": "2024/b.jpg", "size": 2048, "mtime_ns": 1761…, "status": "skipped",
    "skip_reason": "unchanged" } ] }
```

错误统一 `application/problem+json`：`{type,title,status,detail,retryable}`；401/403/404/409/422/429。

## 6. Agent 设计要点

```yaml
agent:
  machine_id: dev-win-01
  label: 开发机
  hub: http://localhost:8787          # M1 仅允许 localhost 明文
  token_file: ./.observer/token
  cache_full_resync_days: 7           # 全量清单对账周期（天），0 = 关闭
defaults:
  limits: { bytes_per_sec: 200MiB, files_per_sec: 300, burst_bytes: 12GiB, on_window_end: finish }
mounts:
  - id: drill
    label: 演练目录
    path: D:\drill
    sentinel: .observer-mount
    fs_kind: local
    include: []
    exclude: ["**/.observer-mount"]
```

扫描流水线：

```
walker(流式, 有界 channel 4096)
  → 文件数限速 → stat(size,mtime_ns) → 规则匹配 → sentinel/可达性已预检
      → 缓存命中且 90 天内 → skipped
      → 否则进入哈希队列
  → 哈希 worker：字节限速（min(size, burst) 等待；credit -= size）→ SHA-256 流式
  → 读后 stat 复查（变化 → unstable 跳过）
  → 批打包（1000 条 / 2s）→ 上传（失败进 spool，退避重试）
```

关键实现约定：

- **限速**：credit bucket，`credit` 按速率补充、上限 `burst_bytes`、可为负；文件开始前 `wait(credit ≥ min(size, burst))`，读完后 `credit -= size`。文件数桶在入口处等待；两桶取较长等待。
- **跳过**：bbolt 中 `(size, mtime_ns)` 相同且 `hashed_at` 在 90 天内 → `skipped`；否则重算并更新缓存。规则变更只影响范围匹配、**不清缓存**；缓存与 hub 的 `manifest_epoch` 对账，缺失时先拉清单再扫。
- **清单不过滤到期文件**：90 天规则需要 agent 用本地当前 stat 与清单条目比对；hub 只按 `state=active` 与当前规则范围过滤，否则 agent 无法区分"已验过且未变"与"从未见过"。
- **对账兜底**：无论 epoch 是否变化，每 `cache_full_resync_days`（默认 7 天）强制拉一次全量清单；成本约 30–60MB/百万文件。
- **路径保真**：上报 `path_display_b64`（原始字节 base64），`path_key` 为 NFC + 折叠大小写后的匹配键。
- **租约**：每批结果或 30s keepalive 续租；cancel 在当前文件完成后生效。
- **spool 格式**：每行 `{"job_id":7,"seq":3,"entries":[...],"closing":false}`，重放按 `(job_id,seq)` 去重。
- **单实例**：`state.db` 的 bbolt 文件锁 + 进程锁，双开直接报错退出。
- **mountguard**：开始前校验 sentinel 内容含 `mount_id`；单轮缺失比例 > 5% 或 > 1000 时，不发逐文件 missing，改为 mount `suspect` 事件。

## 7. Web 最小界面

| 路由 | 内容 |
| --- | --- |
| `/login` | 单用户密码登录 |
| `/` | 总览：机器/挂载点/覆盖率/异常/最近任务 |
| `/machines`、`/machines/:id` | 机器列表与挂载点 |
| `/mounts/:id` | 覆盖率、规则、最近任务、触发巡检 |
| `/jobs`、`/jobs/:id` | 任务列表与进度 |
| `/issues` | 异常列表、确认/忽略 |

技术：React 19 + Vite + TypeScript + TanStack Query + Tailwind；构建产物输出到 `hub/public`（gitignore）。

## 8. 测试与演练

- **Hub 单测/集成（vitest + Fastify inject + 内存 SQLite）**：迁移、登录、enroll 冲突、心跳派发、批次幂等、覆盖率、missing 与熔断、自动关闭。
- **Agent 单测（go test）**：配置校验、规则匹配与剪枝、walker（临时目录/符号链接）、哈希已知向量、限速时序、缓存跳过、spool 重放。
- **联调**：本机 hub + agent 完成 baseline/incremental。
- **演练**：`drill.ps1` 按 §1.4 顺序执行；翻转字节后需恢复 mtime（`[IO.File]::SetLastWriteTimeUtc`），因此用 `full` 模式验证「mtime 不变也能发现」。
- **性能（可选）**：10 万小文件记录耗时/吞吐/RSS，写入 README。

## 9. Git 提交计划

主分支 `main` 直接开发（单人项目）；每个阶段 1–3 个原子提交，提交信息用 Conventional Commits：

| 顺序 | 提交信息 |
| --- | --- |
| 1 | `chore: 初始化仓库与文档基线`（已完成） |
| 2 | `docs: 增加 M1 实施计划` |
| 3 | `chore(hub): 搭建 Fastify 骨架与测试` |
| 4 | `chore(agent): 初始化 Go 模块与 CLI 骨架` |
| 5 | `feat(hub): 增加 SQLite 迁移、会话与注册接口` |
| 6 | `feat(hub): 增加任务租约、批次入库、清单接口与异常判定` |
| 7 | `feat(agent): 实现配置校验、规则、遍历与哈希` |
| 8 | `feat(agent): 实现限速、缓存同步、spool 与巡检执行` |
| 9 | `feat(web): 增加最小控制台` |
| 10 | `test: 增加演练脚本与验收` |
| 11 | `docs: M1 收尾与快速开始`，打 tag `m1` |

## 10. 风险与回退

| 风险 | 影响 | 回退 |
| --- | --- | --- |
| `better-sqlite3` 在 Node 22 上无预编译包 | 安装失败 | 换 `node:sqlite`（实验）或 sql.js；接口层已隔离 |
| 未安装 Go | P3 无法开工 | `winget install GoLang.Go`（一次性） |
| Windows 文件锁导致哈希失败 | 单文件 unreadable | 记 `unreadable`，重试一次，不中断整轮 |
| bbolt 锁导致双开失败 | 启动报错 | 明确提示已有实例；退出码非 0 |
| 端口 8787 被占用 | hub 起不来 | `OBSERVER_PORT` 覆盖 |
| 大目录内存尖峰 | OOM | `ReadDir(n)` 流式 + 有界 channel |
| 清单体积过大（百万文件） | agent 拉取慢、内存高 | NDJSON + gzip 流式，1 万条/事务写 bbolt，端到端内存有界 |
| 演练脚本 mtime 伪造失败 | 验收 #4 不成立 | 使用 .NET 静态方法（FullLanguage 可用）并断言写入成功 |

## 11. 完成定义（DoD）

- `pnpm -r test`、`go test ./...` 全绿。
- `scripts/drill.ps1` 退出码 0，9 条验收全 PASS。
- Web 可完成「登录 → 触发巡检 → 看到异常」全流程。
- README 增加「快速开始（M1）」，`docs/DESIGN-TECH.md` 与实际实现无冲突。
- `git status` 干净，`git tag m1` 打在收尾提交上。

## 12. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿：范围、P0–P6、数据模型、API、Agent 设计、验收、Git 计划 |
| v0.2 | 2026-10-29 | 增加路径清单同步（manifest epoch、流式下发）与验收 #9 |
| v0.3 | 2026-10-29 | 增加清单全量对账兜底周期（默认 7 天） |
