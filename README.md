# Observer

> 观测者：多机文件完整性巡检与修复系统。

Observer 由一个中心服（Node.js Web Server）和若干部署在不同机器上的 agent 组成。agent 定期校验本地文件的哈希，与中心服记录的基线比对；一旦某个文件的哈希和之前不一致，就发出提醒，并可从另一台机器的健康副本恢复。

**状态：M2 进行中（P0 计划、P1 自动调度已完成；通知暂缓；M1 交付见 tag `m1`）**

M1 已实现：hub（SQLite、注册/心跳、任务与租约、结果入库、异常判定、覆盖率、清单下发、Web 控制台）+ agent（配置与规则、遍历、SHA-256、双闸限速、本地缓存、清单同步、spool 补发）+ 验收脚本。

## 文档

| 文档 | 内容 |
| --- | --- |
| [需求整理](docs/REQUIREMENTS.md) | 项目定位、已确认需求、边界、概念模型、待讨论问题、里程碑 |
| [路径与身份模型](docs/DESIGN-PATH-MODEL.md) | 三元组身份、mount 映射、引用串语法、失败模式、决策点 |
| [技术方案](docs/DESIGN-TECH.md) | 架构、技术选型（T1–T20）、协议、数据模型、Agent 专题、里程碑 |
| [M1 实施计划](docs/PLAN-M1.md) | 范围、阶段拆分、数据模型、API 契约、验收与收尾记录 |
| [M2 实施计划](docs/PLAN-M2.md) | 调度/多机/桌面 GUI 的范围与进度（通知暂缓） |

## 快速开始（开发）

环境：Node ≥ 22、pnpm ≥ 11、Go ≥ 1.24。

```powershell
pnpm install

pnpm --filter hub test        # hub 单测
pnpm --filter hub typecheck   # hub 类型检查
pnpm --filter web typecheck   # Web 类型检查
pnpm --filter web build       # 构建 Web 到 hub/public
pnpm --filter hub dev         # 启动 hub：http://127.0.0.1:8787（含 Web 控制台）

cd agent; go test ./...       # agent 单测
```

生成一次性注册 token：

```powershell
pnpm --filter hub token:create -- --machine nas-01
```

构建并启动 agent：

```powershell
cd agent
go build -o bin/observer-agent.exe ./cmd/observer-agent
$env:OBSERVER_ENROLL_TOKEN = '<上一步的 token>'
.\bin\observer-agent.exe run -config observer-agent.yaml
```

可用环境变量：`OBSERVER_PORT`、`OBSERVER_DATA_DIR`、`OBSERVER_ADMIN_PASSWORD`、`OBSERVER_LOG_LEVEL`、`OBSERVER_SCHEDULER_ENABLED`（默认 true；设为 false 关闭自动调度）。生产环境必须显式设置管理员口令。

## 验收

```powershell
pwsh ./scripts/drill.ps1
```

脚本会自动构建并启动真实的 hub + agent，逐条断言 M1 的 9 项验收：基线覆盖率、保持 mtime 的字节翻转检测、missing 生命周期、hub 重启恢复、停机期间 spool 补发、sentinel 熔断、缓存丢失后清单恢复等。全部通过时退出码为 0。

## 暂定命名

| 用途 | 名称 |
| --- | --- |
| 仓库 / 项目 | `observer` |
| 中心服 | `observer`（`observer serve`） |
| Agent | `observer-agent` |
| 环境变量前缀 | `OBSERVER_` |
| 核心术语 | 基线 baseline · 巡检 check · 异常 issue · 副本 replica · 修复 restore · 挂载点 mount |

> 以上均为暂定，需求讨论后统一调整。

## 下一步

1. **M2（进行中）**：P1 自动调度已完成；通知（P2）暂缓；继续 P3 多机演练与 Web 展示、P4 Wails 桌面 GUI、P5 验收；
2. M3：副本关联、跨机修复与隔离区、审计完善；
3. M4：NAS 容器化、macOS 签名公证、性能与告警聚合打磨。
