# Observer

> 观测者：多机文件完整性巡检与修复系统。

Observer 由一个中心服（Node.js Web Server）和若干部署在不同机器上的 agent 组成。agent 定期校验本地文件的哈希，与中心服记录的基线比对；一旦某个文件的哈希和之前不一致，就发出提醒，并可从另一台机器的健康副本恢复。

**状态：技术方案已定（尚未开始编码）**

## 文档

| 文档 | 内容 |
| --- | --- |
| [需求整理](docs/REQUIREMENTS.md) | 项目定位、已确认需求、边界、概念模型、待讨论问题、里程碑 |
| [路径与身份模型](docs/DESIGN-PATH-MODEL.md) | 三元组身份、mount 映射、引用串语法、失败模式、决策点 |
| [技术方案](docs/DESIGN-TECH.md) | 架构、技术选型（T1–T20）、协议、数据模型、Agent 专题、里程碑 |
| [M1 实施计划](docs/PLAN-M1.md) | 范围、阶段拆分、数据模型、API 契约、Git 提交计划、验收 |

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

1. 按 [M1 实施计划](docs/PLAN-M1.md) 依次推进 P0–P6；
2. 以 `scripts/drill.ps1` 的 8 条验收作为 M1 完成标准，完成后打 tag `m1`；
3. M2 交付桌面 GUI（Go + Wails）、调度与通知；M3 做跨机修复。
