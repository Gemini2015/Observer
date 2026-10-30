# 配置参考

> 返回 [README](../README.md)。开发运行见 [QUICKSTART](QUICKSTART.md)；部署产物见 [DEPLOY](DEPLOY.md)。

## 1. hub 环境变量

来源：`hub/src/env.ts`。变量从进程环境读取（不自动加载 `.env`）；可参考根目录 [`.env.example`](../.env.example)，由 shell 或容器注入。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OBSERVER_HOST` | `127.0.0.1` | 监听地址；容器内对外需 `0.0.0.0` |
| `OBSERVER_PORT` | `8787` | HTTP 端口 |
| `OBSERVER_DATA_DIR` | `./data` | SQLite 与修复中转目录；`pnpm --filter hub` 时即 `hub/data` |
| `OBSERVER_ADMIN_PASSWORD` | `observer` | 管理员口令；**生产（`NODE_ENV=production`）禁止默认值** |
| `OBSERVER_LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace/silent` |
| `OBSERVER_SCHEDULER_ENABLED` | `true` | 是否启用自动调度 |
| `OBSERVER_SCHEDULER_INTERVAL_MS` | `30000` | 调度 tick 间隔（最小 500） |
| `OBSERVER_OFFLINE_AFTER_SECONDS` | `90` | 心跳超过该秒数标记机器 offline |
| `NODE_ENV` | `development` | `production` 时启用口令强校验 |

数据目录内容：

| 路径 | 说明 |
| --- | --- |
| `<data>/observer.db`（+ `-wal`/`-shm`） | SQLite 主库（迁移在启动时自动执行） |
| `<data>/transfers/<ticket>.part` | 跨机修复中转临时文件，票据完成/失败/过期即删除 |

## 2. agent 配置

YAML，加载时使用 **KnownFields**（未知字段会报错）。默认路径 `observer-agent.yaml`（相对当前工作目录），可用 `-config` 指定。桌面客户端不传 `-config` 时读取 **exe 同级目录下的 `agent.yaml`**。

注册 token 在 hub Web 控制台的「机器与挂载点 → 注册新机器」生成（接口 `POST /api/v1/enroll-tokens`）；CLI `token:create` 保留给自动化/演练脚本。

```yaml
agent:
  machine_id: nas-01          # 必填：机器唯一 ID（字母/数字/中划线）
  label: NAS                  # 可选：展示名
  hub: http://127.0.0.1:8787  # 必填：hub 地址
  token: "paste-token-here"   # 推荐：直接填 hub Web 生成的一次性 token（免 token 文件）
  # token_file: .observer/token # 备选：从文件读取 token（与 token 二选一）
  state_dir: .observer/nas-01 # 可选：缓存/spool 目录（内联 token 时默认 .observer/<machine_id>）
  cache_full_resync_days: 7   # 可选，默认 7；清单全量对账兜底周期
defaults:
  limits:                     # 可选：所有 mount 的默认限速
    bytes_per_sec: 200MiB
    files_per_sec: 300
mounts:                       # 必填：至少一个
  - id: photos                # 必填：mount ID（机器内唯一）
    label: 照片
    path: /media/photos       # 必填：物理路径
    sentinel: .observer-mount # 挂载守卫文件（相对路径，内容需包含 mount id）
    fs_kind: local            # local | network | removable | fuse（默认 local）
    case_sensitive: auto      # auto | true | false（默认 auto）
    unicode: auto             # auto | nfc | nfd（默认 auto）
    include: []               # 白名单（doublestar），空 = 全部
    exclude:                  # 黑名单（doublestar），优先于 include
      - "**/.observer-mount"
      - "**/.observer-quarantine/**"
    limits:                   # 可选：覆盖 defaults.limits
      bytes_per_sec: 50MiB
      files_per_sec: 100
      burst_bytes: 3GiB       # 可选，默认 = bytes_per_sec × 60
      on_window_end: finish   # finish | abort（默认 finish）
    schedule:
      window: "01:00-06:00"   # HH:MM-HH:MM（hub 本地时间，支持跨午夜）
      budget_minutes_per_day: 240  # 0 = 不限
      interval_minutes: 1440  # 0/缺省 = 1440
    read_only: true           # 可选：标记只读挂载（修复作为目标时仍需 repair_allowed）
    repair_allowed: false     # 可选，默认 false：允许作为跨机修复的目标
```

### 字段语义

- **路径与规则**：`include` 为空表示全量；`exclude` 永远优先；`rules_hash` 由 agent 计算并上报，规则变化会影响 hub 侧缓存/清单判定。
- **sentinel（挂载守卫）**：mount 根目录下的一个普通文件（相对路径），文件内容必须包含 mount ID，例如：
  ```
  mount_id=photos
  ```
  agent 每轮巡检前检查该文件：**不存在或内容不含 mount ID** 时，认为挂载点不可用，跳过整轮巡检并**不产生 missing 误报**。
  用途：防止磁盘/网络盘未挂载、挂错盘或目录被清空时，把「文件消失」误判成大量文件丢失。
- **read_only**：声明用途，配合 `repair_allowed: false` 使用；修复源端读取不受影响。
- **token 与状态目录**：`agent.token`（内联）优先于 `token_file`，内联时不需要 token 文件。
  - `agent.token` 填 hub Web 生成的**一次性注册 token**；首次启动会向 hub 换取长期 agent token，并缓存到 `<state_dir>/agent.token`，之后启动直接使用缓存。
  - 如需重新注册（例如 token 泄漏或换机器），删除 `state_dir` 目录（或其中的 `agent.token`）后重启。
  - `state_dir` 默认：有 `token_file` 时为 token 文件所在目录；否则为 `.observer/<machine_id>`，其中保存 `state.db`（bbolt 缓存）、`spool.jsonl`（离线补发）与 `agent.token`。
  - 同一台机器跑多个 agent 时，用不同的 `machine_id` 即自动隔离；也可显式配置 `state_dir`。

## 3. 限速语义

- 双闸：`bytes_per_sec`（字节信用卡）与 `files_per_sec`（文件数）。
- **文件是原子单位**：已开始的哈希不会因为窗口结束/超出预算在中途暂停。
- `burst_bytes`：信用卡上限，默认 `bytes_per_sec × 60`；允许短时突发。
- `on_window_end`：`finish`（默认，完成当前文件后停止）/ `abort`（尽快中止本轮）。
- mount 级 `limits` 覆盖 `defaults.limits`；未配置时默认 200 MiB/s、300 files/s。

## 4. 调度语义（hub 侧）

配置来自 `agent` 上报的 `schedule`，hub 每 `OBSERVER_SCHEDULER_INTERVAL_MS` tick 一次：

- 条件：mount `active`、**已建基线**（至少一条路径）、在 `window` 内、无活跃任务、距上次任务 ≥ `interval_minutes`、当日预算未耗尽。
- `window` 支持跨午夜（如 `23:00-06:00`）；预算按 hub 本地自然日累计（`stats.duration_ms`）。
- 跳过 `unavailable` / `suspect` / `removed`、机器离线、已有 pending/running 任务。
- 手动触发（Web / CLI）**不受窗口与预算限制**。
- 心跳超过 `OBSERVER_OFFLINE_AFTER_SECONDS` 未达 → 机器标记 `offline`。

## 5. 跨机修复语义

- `repair_allowed: true` 的 mount 才可作为修复**目标**（默认关闭）。
- 仅处理 `mismatch` / `missing` 异常；源必须是**另一台机器**上哈希完全相等、状态 active、最近以 hash 校验过的路径。
- 源/目标机器需在线；单个文件上限 1 GiB；票据 TTL 24h。
- 目标端：下载到同目录临时文件 → 校验 SHA-256 → 旧文件移入 `<mount>/.observer-quarantine/` → 原子替换 → 复核后上报。
- **quarantine 目录必须从扫描规则排除**（`"**/.observer-quarantine/**"`），否则隔离文件会被当作新文件收录。
- 非 UTF-8 路径名暂不支持（沿用 M1 限制）。

## 6. 示例

- NAS 部署示例：[deploy/agent.example.yaml](../deploy/agent.example.yaml)
- 开发最小示例：[QUICKSTART §5](QUICKSTART.md#5-启动-agent)
