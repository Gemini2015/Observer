# Observer

> 观测者：多机文件完整性巡检与修复系统。

Observer 由**中心服（hub）**和部署在各台机器上的 **agent** 组成。agent 定期校验本地文件哈希，与 hub 保存的基线比对；发现内容不一致、文件缺失或不可读时生成异常，并可从另一台机器的健康副本跨机恢复。

**状态：M4 已完成（tag `m4`）**

| 里程碑 | 交付 | tag |
| --- | --- | --- |
| M1 | 单机闭环：扫描/基线/入库/异常/Web 控制台 | `m1` |
| M2 | 自动调度（窗口/预算）、多机、离线标记、Wails 桌面端 | `m2` |
| M3 | 副本关联 + 跨机修复（隔离/中转/校验/审计） | `m3` |
| M4 | NAS 部署产物、Linux 交叉编译、性能基准、告警聚合 | `m4` |

## 能力

- **身份与范围**：机器 / 挂载点 / 相对路径三段式；include/exclude 通配符规则、sentinel 挂载守卫。
- **巡检**：基线 / 增量 / 全量三种模式；SHA-256、mtime 保持的损坏也能发现；文件为原子单位。
- **限速**：字节速率 + 文件数双闸，credit bucket 允许突发，任务结束可配置 `finish` / `abort`。
- **可靠**：本地缓存 + hub 清单增量同步、离线 spool 补发、租约过期重派、批次幂等。
- **调度**：按窗口 + 每日预算 + 间隔自动派发，跨午夜窗口，心跳超时机器标记离线。
- **修复**：内容哈希全等的副本关联；hub 中转分块传输；目标端 quarantine + 原子替换 + 复核；全程审计。
- **界面**：React Web 控制台（总览/机器/任务/异常/修复）；Wails 桌面客户端（托盘/单实例/自启）。
- **部署**：systemd、Docker Compose、Linux amd64/arm64 交叉编译。

## 架构

```
  agent A ─┐
  agent B ─┼── HTTPS/JSON（注册/心跳/任务/结果/修复中转）──▶ hub（Fastify + SQLite）
  agent N ─┘                                                    │
                                                        Web 控制台（静态资源 + REST）
```

| 组件 | 技术 | 说明 |
| --- | --- | --- |
| `hub/` | Node 22 + TypeScript + Fastify 5 + better-sqlite3 | 中心服：状态、任务、异常、修复、审计 |
| `web/` | React 19 + Vite | 控制台，构建后由 hub 托管 |
| `agent/` | Go（纯 Go、CGO=0） | 巡检端；`agent/desktop/` 为 Wails 桌面客户端 |
| `deploy/` | Dockerfile / compose / systemd | 部署产物 |
| `scripts/` | PowerShell | M1–M4 验收与性能基准 |

## 目录

```
hub/         中心服（migrations/、src/、test/、public/ 构建产物）
web/         Web 控制台源码
agent/       Go agent（cmd/、internal/、desktop/）
deploy/      Dockerfile、docker-compose、systemd unit、示例配置
scripts/     drill*.ps1 验收脚本、bench.ps1 性能基准
docs/        需求、设计、实施计划、部署与测试文档
```

## 快速体验

前置：Node ≥ 22、pnpm ≥ 11、Go ≥ 1.24（桌面端另需 Wails CLI 与 WebView2）。

```powershell
pnpm install
pnpm --filter web build        # 构建控制台到 hub/public
pnpm --filter hub dev          # http://127.0.0.1:8787
pnpm --filter hub token:create -- --machine my-pc
cd agent; go build -o bin/observer-agent.exe ./cmd/observer-agent
$env:OBSERVER_ENROLL_TOKEN = '<token>'
.\bin\observer-agent.exe run -config observer-agent.yaml
```

完整步骤（含桌面端、doctor 自检、环境要求）见 [docs/QUICKSTART.md](docs/QUICKSTART.md)；配置项见 [docs/CONFIG.md](docs/CONFIG.md)。

## 文档

| 分类 | 文档 | 内容 |
| --- | --- | --- |
| 上手 | [快速开始](docs/QUICKSTART.md) | 环境、hub/agent/桌面端运行、常用命令、命名约定 |
| 上手 | [配置参考](docs/CONFIG.md) | hub 环境变量、agent YAML 字段、限速/调度/修复语义 |
| 设计 | [需求整理](docs/REQUIREMENTS.md) | 定位、需求、边界、概念模型、待讨论问题 |
| 设计 | [路径与身份模型](docs/DESIGN-PATH-MODEL.md) | 三元组身份、mount 映射、引用串、失败模式 |
| 设计 | [技术方案](docs/DESIGN-TECH.md) | 架构、技术选型（T1–T20）、协议、数据模型、Agent 专题 |
| 计划 | [M1](docs/PLAN-M1.md) / [M2](docs/PLAN-M2.md) / [M3](docs/PLAN-M3.md) / [M4](docs/PLAN-M4.md) | 各里程碑范围、设计、验收记录 |
| 测试 | [测试与验收](docs/TESTING.md) | 单测、drill M1–M4、性能基准、回归矩阵 |
| 部署 | [部署与打包](docs/DEPLOY.md) | NAS systemd/Docker、Windows、macOS 签名公证 |

## 验收与测试

```powershell
pnpm --filter hub test                 # hub 单测
cd agent; go test ./...                # agent 单测
pwsh ./scripts/drill.ps1               # M1：9 项
pwsh ./scripts/drill-m2.ps1            # M2：8 项（内含 M1）
pwsh ./scripts/drill-m3.ps1            # M3：10 项
pwsh ./scripts/drill-m4.ps1 -RunRegression   # M4：8 项（内含 M2+M3）
pwsh ./scripts/bench.ps1               # 性能基准
```

最近一次结果与阈值说明见 [docs/TESTING.md](docs/TESTING.md)。

## 下一步（M5 / 按需）

1. 块级/事件驱动扫描、通知（webhook / IM）、跨机修复自动化；
2. Windows NSIS 安装包与 macOS 签名公证（需对应平台/证书，见 [docs/DEPLOY.md](docs/DEPLOY.md)）；
3. 生产部署与 TLS（Caddy）、备份恢复演练。
