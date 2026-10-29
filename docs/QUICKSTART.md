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

## 4. 创建注册 token

```powershell
pnpm --filter hub token:create -- --machine nas-01
```

- `--machine` 是机器 ID 提示，agent 实际以配置里的 `agent.machine_id` 注册。
- `--ttl-hours <n>` 可改有效期（默认 24 小时）。
- 数据库默认在 `hub/data/observer.db`（`pnpm --filter hub` 的工作目录是 `hub/`；`OBSERVER_DATA_DIR` 可覆盖）。
- token 一次性使用，CLI 会打印有效期与数据库路径。

## 5. 启动 agent

最小配置（完整字段见 [CONFIG §2](CONFIG.md#2-agent-配置)）：

```yaml
agent:
  machine_id: nas-01
  hub: http://127.0.0.1:8787
  token_file: .observer/token

mounts:
  - id: photos
    label: 照片
    path: E:\photos
    sentinel: .observer-mount
    exclude:
      - "**/.observer-mount"
```

构建与运行：

```powershell
cd agent
go build -o bin/observer-agent.exe ./cmd/observer-agent

$env:OBSERVER_ENROLL_TOKEN = '<上一步的 token>'
.\bin\observer-agent.exe run -config observer-agent.yaml
# 也可以：.\bin\observer-agent.exe run -config ... -enroll-token <token>
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `observer-agent run -config <path> [-interval 15s]` | 常驻：注册/心跳/领取任务/巡检 |
| `observer-agent scan -config <path>` | 只跑一轮（补发 spool、心跳、有任务则巡检） |
| `observer-agent doctor -config <path>` | 自检：配置、目录、sentinel、hub 连通性 |
| `observer-agent version` | 版本 |

> `token_file` 所在目录同时保存 `state.db`（缓存）与 `spool.jsonl`（离线补发）。**同一台机器跑多个 agent 时必须使用不同目录**（不同 `token_file` 路径）。

## 6. 桌面客户端（Windows 先行）

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
cd agent/desktop
wails3 build
.\bin\observer-agent-desktop.exe -config ..\observer-agent.yaml
```

- 关闭窗口隐藏到托盘，巡检继续；单实例；托盘菜单可暂停/打开 hub/开机启动。
- macOS 构建、签名与公证见 [DEPLOY §5](DEPLOY.md#5-macos)。

## 7. 常用命令

```powershell
pnpm --filter hub test
pnpm --filter hub typecheck
pnpm --filter web typecheck
pnpm --filter web build
cd agent; go test ./...
cd agent/desktop; go vet ./...
```

验收脚本与性能基准见 [TESTING](TESTING.md)。

## 8. 命名与术语（暂定）

| 用途 | 名称 |
| --- | --- |
| 仓库 / 项目 | `observer` |
| 中心服 | `observer`（`observer serve`） |
| Agent | `observer-agent` |
| 环境变量前缀 | `OBSERVER_` |
| 核心术语 | 基线 baseline · 巡检 check · 异常 issue · 副本 replica · 修复 restore · 挂载点 mount |

> 以上均为暂定，需求讨论后统一调整。
