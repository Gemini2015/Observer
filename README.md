# Observer

> 观测者：多机文件完整性巡检与修复系统。

Observer 由一个中心服（Node.js Web Server）和若干部署在不同机器上的 agent 组成。agent 定期校验本地文件的哈希，与中心服记录的基线比对；一旦某个文件的哈希和之前不一致，就发出提醒，并可从另一台机器的健康副本恢复。

**状态：M1 实施中（P0 工程骨架、P1 hub 数据层与鉴权、P2 任务与入库已完成）**

## 文档

| 文档 | 内容 |
| --- | --- |
| [需求整理](docs/REQUIREMENTS.md) | 项目定位、已确认需求、边界、概念模型、待讨论问题、里程碑 |
| [路径与身份模型](docs/DESIGN-PATH-MODEL.md) | 三元组身份、mount 映射、引用串语法、失败模式、决策点 |
| [技术方案](docs/DESIGN-TECH.md) | 架构、技术选型（T1–T20）、协议、数据模型、Agent 专题、里程碑 |
| [M1 实施计划](docs/PLAN-M1.md) | 范围、阶段拆分、数据模型、API 契约、Git 提交计划、验收 |

## 快速开始（开发）

环境：Node ≥ 22、pnpm ≥ 11、Go ≥ 1.24。

```powershell
pnpm install
pnpm --filter hub test        # hub 单测
pnpm --filter hub typecheck   # 源码与测试类型检查
pnpm --filter hub dev         # 启动 hub：http://127.0.0.1:8787
cd agent; go test ./...       # agent 单测
```

生成一次性注册 token（数据默认写入 `hub/data/observer.db`）：

```powershell
pnpm --filter hub token:create -- --machine nas-01
```

可用环境变量：`OBSERVER_PORT`、`OBSERVER_DATA_DIR`、`OBSERVER_ADMIN_PASSWORD`、`OBSERVER_LOG_LEVEL`（生产环境必须显式设置管理员口令）。

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

1. 继续 P2：任务租约、批次入库、覆盖率、异常判定、清单接口；
2. P3/P4：agent 配置、遍历、哈希、限速与全链路；P5 最小 Web；P6 以 `scripts/drill.ps1` 的 9 条验收收尾并打 tag `m1`；
3. M2 交付桌面 GUI（Go + Wails）、调度与通知；M3 做跨机修复。
