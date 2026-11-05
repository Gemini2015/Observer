# 快速开始（开发与本地运行）

> 返回 [README](../README.md)。配置项细节见 [CONFIG](CONFIG.md)，生产部署见 [DEPLOY](DEPLOY.md)。

## 1. 环境

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 22 | hub / Web |
| pnpm | ≥ 11 | 包管理 |
| Go | ≥ 1.24（本机验证 1.27） | agent / 桌面端 |
| Wails CLI | v3.0.0 | 仅桌面客户端构建 |
| WebView2 Runtime | Windows 10 1803+ 通常已内置 | 仅桌面客户端运行 |

Windows 下 Go 与 Wails CLI 的 PATH 提示：

```powershell
# Go 安装后可能需要新开终端
$env:PATH = "C:\Program Files\Go\bin;$env:PATH"
# Wails CLI 安装到 %USERPROFILE%\go\bin
$env:PATH = "$env:USERPROFILE\go\bin;$env:PATH"
```

## 2. 安装依赖

```powershell
pnpm install
```

## 3. 启动 hub

开发模式（tsx watch，改代码自动重启）：

```powershell
pnpm --filter hub dev        # http://127.0.0.1:8787
```

生产构建 / 启动：

```powershell
pnpm --filter hub build      # tsc → hub/dist
pnpm --filter hub start      # node hub/dist/main.js
```

Web 控制台构建后由 hub 托管：

```powershell
pnpm --filter web build      # 输出到 hub/public
```

Web 开发模式（Vite，`/api` 代理到 8787，需要 hub 同时运行）：

```powershell
pnpm --filter web dev
```

环境变量见 [CONFIG §1](CONFIG.md#1-hub-环境变量)；生产环境必须显式设置 `OBSERVER_ADMIN_PASSWORD`。

## 4. 创建 token（Web 控制台）

### 4.1 新节点：注册 token（一次性）

1. 打开 hub 控制台 <http://127.0.0.1:8787> 并登录；
2. 进入「机器与挂载点」→ 点击「注册新机器」；
3. 可选填机器 ID 提示与有效期，点击「生成 token」；
4. **复制 token（只显示一次）**，填入 agent 配置的 `agent.token`。

> 自动化/脚本仍可用 CLI：`pnpm --filter hub token:create -- --machine nas-01`（`--ttl-hours` 可改有效期）。

### 4.2 已有节点：接入 token（长期、可重新生成）

本地 yaml/token 丢失、或想把新装的 agent 接到已有节点时，不需要删除节点重新注册：

1. 「机器与挂载点」→ 找到已注册机器 → 点「获取接入 token」；
2. 确认轮换（**旧 token 立即失效**，旧 agent 会掉线）→ 复制新 token（只显示一次）；
3. agent 配置的 `agent.token` 填这个接入 token（或 GUI 首次向导里粘贴）；
4. GUI 首次向导可点「识别已有节点」，自动填充该节点的 machine_id 与已有挂载点配置，确认目录后保存即可回到原节点，历史任务/覆盖率保留。

> 接入 token 是长期凭据，可反复使用；每次「获取接入 token」都会轮换，不能查看旧明文。

## 5. 启动 agent

最小配置（完整字段见 [CONFIG §2](CONFIG.md#2-agent-配置)）：

```yaml
agent:
  machine_id: nas-01
  hub: http://127.0.0.1:8787
  # 新节点：注册 token（一次性）；已有节点：接入 token（长期）
  token: "<粘贴上一步生成的 token>"
  # 缓存/spool 目录；不填时默认 .observer/<machine_id>
  state_dir: .observer/nas-01

mounts:
  - id: photos
    label: 照片
    path: E:\photos
    # 挂载守卫：文件内容需包含 mount id（如 mount_id=photos）；
    # 缺失时跳过巡检且不产生 missing 误报，防止磁盘未挂载/挂错盘。
    sentinel: .observer-mount
    exclude:
      - "**/.observer-mount"
```

构建与运行（内联 token 时不再需要 `OBSERVER_ENROLL_TOKEN`；首次启动自动注册）：

```powershell
cd agent
go build -o bin/observer-agent.exe ./cmd/observer-agent
.\bin\observer-agent.exe run -config observer-agent.yaml
```

> 首次启动后，长期 agent token 会缓存到 `state_dir/agent.token`（默认 `.observer/<machine_id>/agent.token`），后续启动会先校验缓存；如果 token 已在 hub 重新生成，旧缓存会失效并自动改用配置里的新 token。`agent.machine_id` 必须与 token 所属节点一致。

> 也可以使用 token 文件（NAS/服务常用）：配置 `token_file: /var/lib/observer/token`，首次运行设置 `OBSERVER_ENROLL_TOKEN` 完成注册，之后自动从文件读取。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `observer-agent run -config <path> [-interval 15s]` | 常驻：注册/心跳/领取任务/巡检 |
| `observer-agent scan -config <path>` | 只跑一轮（补发 spool、心跳、有任务则巡检） |
| `observer-agent doctor -config <path>` | 自检：配置、目录、sentinel、hub 连通性 |
| `observer-agent version` | 版本 |

> `token` 可以填两种值：**新节点**用 Web「注册新机器」生成的一次性注册 token（首次启动自动换取长期 token 并缓存）；**已有节点**用机器行「获取接入 token」生成的长期 token（直接校验使用，可反复使用，重新生成后旧 token 失效）。同一台机器跑多个 agent 时，不同 `machine_id` 会自动隔离状态目录。

## 6. 桌面客户端（Windows 先行）

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
cd agent/desktop
wails3 build
.\bin\observer-agent-desktop.exe
```

- **首次启动**：没有 `agent.yaml` / 配置未完成时会直接进入 GUI 配置向导（机器 ID、hub、注册 token/接入 token、挂载点）。新节点用一次性注册 token；已有节点用机器行「获取接入 token」，粘贴后点「识别已有节点」自动填充 machine_id 与挂载点，保存后回到原节点。
- 主界面「设置」页可修改显示名称与挂载点的显示名/目录/sentinel/排除规则/修复开关，可新增/删除挂载点；新增挂载点后需在 hub Web 触发一次基线巡检。删除为软删除（hub 保留历史数据）。
- 机器 ID/hub/token/状态目录为只读；调度、限速、只读等高级配置仍编辑 YAML（设置保存不会丢失这些字段）。
- 不传 `-config` 时默认读取 exe 同级 `agent.yaml`；也可显式指定：`-config D:\Observer\agent.yaml`。
- 启动时会把工作目录切到配置文件所在目录，配置里的相对路径（`state_dir`、`mounts[].path`）都相对该目录解析。
- 关闭窗口隐藏到托盘，巡检继续；单实例；托盘菜单可暂停/打开 hub/开机启动（自启会携带当前配置的绝对路径）。
- 主界面顶部「文件」页可查看本机已入库文件（按挂载点/路径/状态/异常/哈希筛选，分页、详情、复制完整路径），也可用「在 hub 中查看」跳转 hub 文件页。
- macOS 构建、签名与公证见 [DEPLOY §5](DEPLOY.md#5-macos)。

## 7. Web 控制台使用

侧栏分三组：巡检（总览、机器、任务）、数据（文件、异常、修复）、系统（审计、系统）。底部显示中心服健康状态与版本；窄屏（<900px）侧栏收成顶部一行，可横向滚动。

**总览**：在线机器、待确认异常、校验覆盖率、最近巡检时间四个指标可点进对应页面；「需要关注」聚合未关闭异常的类型与机器分布；「巡检新鲜度」按最近一次完成的巡检从旧到新列出挂载点；「最近任务」可点进任务详情。

**机器与挂载点**：

- 列表展示每台机器的在线状态、最后心跳、挂载点数、整体覆盖率、未关闭异常数；行内「操作」菜单提供整机增量/全量巡检、获取接入 token、删除；
- 顶部有「全部机器增量巡检」「全部机器全量巡检」与「注册新机器」（一次性注册 token，只显示一次）；
- 点机器名进入 `/machines/:id`：基本信息、挂载点表（扫描/文件/删除）、最近任务；
- 删除机器需输入机器 ID 二次确认；已有 pending/running 任务的挂载点会被跳过并提示数量。

**文件**：

- 常用筛选（机器、挂载点、路径/SHA-256、状态、异常）直接显示，「更多筛选」里是哈希、大小范围、排序、顺序；筛选条件写入 URL，可分享、可前进/后退；
- 摘要 chips 可一键切换状态/哈希/异常筛选；「导出 CSV」导出当前筛选（最多 5000 行，超过会提示截断）；
- 点行或「详情」打开右侧抽屉：位置、状态、完整 SHA-256、异常证据、最近观测，可复制完整路径与哈希。

**异常**：

- 状态标签页带计数（待确认/已确认/已忽略/已解决），支持按类型、机器、路径筛选；
- 可多选批量确认/忽略，或单条操作；「详情 / 修复」打开抽屉：期望/观测哈希、证据、健康副本选择、修复进度（可取消）；
- 「已解决」是复检一致后由系统自动关闭，不需要手工操作。

**修复**：列出跨机修复记录，展示源→目标、状态与传输进度，进行中可取消。

**任务**：按状态/机器/挂载点筛选，可开关 5 秒自动刷新；点行进入任务详情（基本信息、统计字段、耗时）。

**审计**：按动作前缀与条数查看操作记录，详情可展开原始 JSON。

**系统**：hub 版本、运行时长、调度器、数据库规模与配置说明，并可生成一次性注册 token。

agent GUI 顶部「文件」页：

- 仅显示当前 agent token 所属机器的文件；
- 支持挂载点、路径、状态、异常、哈希筛选和分页；
- 行点击展开详情，可复制完整路径；「在 hub 中查看」用系统浏览器打开按 machine 过滤的 hub 文件页。

> 文件页只展示 hub 已入库的元数据（路径/大小/状态/哈希/时间/异常），不读取或下载文件内容；刚装好或还没巡检时列表为空，先跑一次全量巡检。

## 8. 常用命令

```powershell
pnpm --filter hub test
pnpm --filter hub typecheck
pnpm --filter web typecheck
pnpm --filter web build
cd agent; go test ./...
cd agent/desktop; go vet ./...
```

验收脚本与性能基准见 [TESTING](TESTING.md)。

## 9. 命名与术语（暂定）

| 用途 | 名称 |
| --- | --- |
| 仓库 / 项目 | `observer` |
| 中心服 | `observer`（`observer serve`） |
| Agent | `observer-agent` |
| 环境变量前缀 | `OBSERVER_` |
| 核心术语 | 基线 baseline · 巡检 check · 异常 issue · 副本 replica · 修复 restore · 挂载点 mount |

> 以上均为暂定，需求讨论后统一调整。
