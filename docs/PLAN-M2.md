# Observer M2 实施计划

> 版本：v0.2　日期：2026-10-29　性质：可执行实施计划
>
> 上游：[需求整理](REQUIREMENTS.md)（v0.4）、[技术方案](DESIGN-TECH.md)（v0.6）、[M1 实施计划](PLAN-M1.md)。
> M1 已完成（tag `m1`）。M2 的目标是让系统从「手动巡检」变成「日常自动运行 + 桌面可见」。

## 1. 目标与范围

### 1.1 M2 定义

采用 [技术方案 §13](DESIGN-TECH.md) 的 M2 定义：

- **调度**：按窗口 + 每日预算 + 间隔自动派发巡检任务；
- **通知**（暂缓）：原计划异常产生/变化时推送 webhook / IM；2026-10-29 决定暂不实施。
- **多机**：多 agent 同时巡检、离线状态可见；
- **桌面 GUI**：Go + Wails 的 agent 客户端（托盘、后台、开机启动、单实例）。

验收（技术方案 M2 行）：**两台机器同时巡检；桌面可看进度**。

### 1.2 做（M2 In）

- hub 调度器：`schedule = {window, budget_minutes_per_day, interval_minutes}`，自动创建 incremental 任务；窗口支持跨午夜；预算按本地自然日累计；每 mount 单活跃任务；离线/可疑 mount 跳过；租约过期回收。
- agent 上报 `interval_minutes`（缺省 1440）。
- 机器离线标记：心跳超过 90 秒置 `offline`（不影响 mount 状态）。
- Web：挂载点详情展示调度策略、机器页展示在线状态；两 agent 场景可见。
- 桌面 GUI（Wails）：托盘 + 窗口显示本机连接状态、巡检进度、最近结果；关闭隐藏到托盘、开机启动、单实例。
- 验收脚本 `scripts/drill-m2.ps1`。

### 1.3 不做（M2 Out，留给 M3/M4）

副本关联与跨机修复、macOS 签名公证、NAS 容器打磨、block-level、事件驱动；**hub 内部通知（webhook / IM / 邮件）暂缓**（2026-10-29 决定，按需再排期）。

## 2. 阶段拆分

| 阶段 | 内容 | 产出 | 依赖 | 规模 |
| --- | --- | --- | --- | --- |
| P0 | 计划与设计 | 本文档 | M1 | S |
| P1 | hub 调度 | `services/scheduler.ts`、tick 接入、离线标记、单测 | P0 | M |
| P2 | 通知 | **暂缓（2026-10-29 决定）** | — | — |
| P3 | 多机与 Web | 调度展示、离线状态、两 agent 演练 | P1 | S |
| P4 | 桌面 GUI | Wails 应用（托盘/窗口/自启/单实例） | P1 | L |
| P5 | 验收 | `drill-m2.ps1`、README、tag `m2` | P1–P4 | M |

## 3. 调度设计（P1）

配置来源：agent 的 mount 配置 → enroll 时存进 `mounts.schedule_json`：

```json
{ "window": "01:00-06:00", "budget_minutes_per_day": 120, "interval_minutes": 1440 }
```

- `window`：hub 本地时间；支持跨午夜（`23:00-06:00`）；为空表示全天。
- `budget_minutes_per_day`：0 表示不限；按 hub 本地自然日累计已完成任务的 `duration_ms`。
- `interval_minutes`：0/缺省 = 1440（每天一次）。
- 自动任务：`mode=incremental`；手动触发不受窗口/预算限制（保持 M1 行为）。
- 跳过条件：mount 为 `unavailable/suspect/removed`、已有 pending/running 任务、未到间隔、不在窗口内、预算耗尽。
- tick：hub 每 30 秒执行一次（`runSchedulerTick` 纯函数便于测试），同时回收过期租约、标记离线机器。
- 环境变量：`OBSERVER_SCHEDULER_ENABLED`（默认 true）。

## 4. 通知设计（P2，暂缓，保留备查）

- 配置存 `settings.notify_channels`（JSON 数组），先支持：
  - `{"type":"webhook","url":"...","headers":{}}`
  - `{"type":"ntfy","url":"https://ntfy.sh","topic":"..."}`
- 触发：issue 从无到 open 或 resolved→open；payload 包含类型、路径、机器/mount、置信度、时间。
- 去重：同一 issue + 同一状态在一次 job 内只发一次；发送失败重试 1 次后记日志。
- 超时 5 秒，串行发送，不阻塞 job 完成。
- 配置接口：`GET/PUT /api/v1/settings/notify`（会话鉴权），Web 设置页 P3 再做。

## 5. 桌面 GUI 设计（P4）

- 技术：Go + Wails v3（系统 WebView），与 agent 共用 `internal/agent` 运行器；不引入本地 HTTP 服务。
- 形态：普通程序；关闭窗口 = 隐藏到托盘；托盘菜单：打开界面 / 暂停 / 立即巡检 / 退出；开机启动（HKCU Run / LaunchAgent）；单实例（命名互斥 + 焦点切换）。
- 界面最小集：连接状态、当前任务与进度、最近一轮统计、本机异常列表、「打开 hub Web」。
- 构建：Windows 先行验证；macOS 需在 Mac 上构建（M4 再处理签名/公证）。
- 风险：Wails v3 刚发布（2026-10-25），先做 1 天 spike；阻塞则回退 Wails v2（绑定层改，core 不动）。

## 6. 验收（P5）

| # | 验收 | 判定 |
| --- | --- | --- |
| 1 | 窗口内自动派发增量任务 | 任务由 scheduler 创建（actor=scheduler） |
| 2 | 窗口外 / 预算耗尽不派发 | 无新任务 |
| 3 | 跨午夜窗口正确 | 23:30 派发、12:00 不派发 |
| 4 | 两台 agent 同时巡检 | 两 mount 各有任务并行完成 |
| 5 | 离线机器标记 | 心跳超时后机器状态 offline |
| 6 | GUI 可用（手动） | 托盘/窗口/单实例/自启检查清单 |
| 7 | M1 回归 | `drill.ps1` 仍全部通过 |

## 7. 风险

| 风险 | 回退 |
| --- | --- |
| Wails v3 在 Windows 构建/运行问题 | 回退 Wails v2 或先交付托盘 + 浏览器 UI |
| 通知渠道网络不可达（已暂缓，不适用） | — |
| 调度与手动任务竞争 | 依赖 `uq_jobs_active` 唯一索引，冲突即跳过 |
| 预算统计口径与 agent 上报不一致 | 优先用 stats.duration_ms，缺失时用 finished-started |

## 8. Git 提交计划

1. `docs: 增加 M2 实施计划`
2. `feat(hub): 增加自动调度与离线标记`
3. `feat(agent): 上报调度间隔配置`
4. `feat(web): 展示调度策略与机器状态`
5. `feat(agent): 增加 Wails 桌面 GUI（托盘/单实例/自启）`
6. `test: 增加 M2 验收脚本`
7. `docs: M2 收尾与验收记录`，tag `m2`

> 原先计划的「通知渠道」提交已随 P2 暂缓取消。

## 9. 进度记录

| 日期 | 进展 |
| --- | --- |
| 2026-10-29 | 计划创建；P1 完成：`hub/src/services/scheduler.ts`（窗口/预算/间隔/基线保护/离线标记/租约回收）+ 10 项单测；M1 drill 回归通过 |
| 2026-10-29 | 按需求方决定，hub 内部通知（webhook / IM）移出 M2、暂缓（设计保留在 §4 备查） |

## 10. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿：M2 范围、P0–P5、调度/通知/GUI 设计、验收 |
| v0.2 | 2026-10-29 | 通知（webhook/IM）移出 M2 暂缓；验收项与提交计划同步调整 |
