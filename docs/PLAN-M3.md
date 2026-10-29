# Observer M3 实施计划

> 版本：v0.2　日期：2026-10-29　性质：可执行实施计划
>
> 上游：[技术方案](DESIGN-TECH.md)（v0.7）、[M2 实施计划](PLAN-M2.md)。M2 已完成（tag `m2`）。
> M3 目标：**从健康副本跨机恢复损坏文件，恢复后哈希与基线一致**。

## 1. 范围

### 1.1 做（M3 In）

- **副本关联**：对一条异常，按「内容哈希全等」（技术方案 T7）找到其它机器上的健康副本，供用户选择。
- **修复执行**：源 agent 只读上传 → hub 临时存储 → 目标 agent 下载校验 → 坏文件移入 quarantine → 原子替换 → 目标端复核上报 → hub 关闭异常。
- **安全**：mount 级 `repair_allowed`（默认 false）；仅跨机；票据 TTL；期望哈希全链路校验；目标替换前校验当前哈希/缺失状态；只允许源/目标机器 agent 访问票据数据。
- **审计**：创建/上传完成/开始应用/成功/失败/取消/过期全部落 `audit_log`。
- **验收**：`scripts/drill-m3.ps1` 真机双 agent 演练恢复。

### 1.2 不做（M3 Out）

通知、自动修复（M3 仅人工确认触发）、多源并行、断点续传跨进程恢复（票据支持 offset，但 agent 重启从 0 重试）、非 UTF-8 路径名（沿用 M1 限制）。

## 2. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 数据模型（migration 0002）+ `repair_allowed` 全链路 + 副本查询 | ✅ |
| P2 | hub 修复/票据服务 + agent 任务下发（heartbeat） | ✅ |
| P3 | agent 修复执行器（上传/下载/隔离/替换/上报） | ✅ |
| P4 | Web 异常详情 + 副本选择 + 修复状态 | ✅ |
| P5 | `drill-m3.ps1` + 文档 + tag `m3` | ✅ |

## 3. 数据模型（migration 0002）

```sql
ALTER TABLE mounts ADD COLUMN repair_allowed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE repair_jobs (
  id INTEGER PRIMARY KEY,
  issue_pk INTEGER NOT NULL REFERENCES issues(id) ON DELETE RESTRICT,
  source_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  target_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  expected_hash TEXT NOT NULL,
  observed_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','transferring','ready','applying','completed','failed','canceled')),
  error TEXT, quarantine_path TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);

CREATE TABLE transfer_tickets (
  id INTEGER PRIMARY KEY,
  repair_pk INTEGER NOT NULL REFERENCES repair_jobs(id) ON DELETE CASCADE,
  source_path_pk INTEGER NOT NULL REFERENCES paths(id) ON DELETE RESTRICT,
  expected_hash TEXT NOT NULL, size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','failed','expired')),
  bytes_received INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

## 4. 流程

1. `POST /api/v1/issues/{id}/repair {source_path_id}`：校验异常 open/acked、目标 mount `repair_allowed`、源哈希 = 期望哈希、源/目标不同机器且 agent 在线、大小 ≤ `OBSERVER_REPAIR_MAX_BYTES`（默认 1GiB）；创建 repair + ticket（TTL 24h）。
2. 源 agent 心跳拿到 `transfers` → 只读打开、边读边算 SHA-256，与期望一致后按 1MiB 分块 `PUT /api/v1/transfers/{id}/data?offset=`；hub 落盘 `data/transfers/{id}.part`，收满后整文件校验，成功 → ticket `ready`、repair `ready`。
3. 目标 agent 心跳拿到 `repairs`（ticket ready）→ `GET .../data?offset=` 下载、边写临时文件边算哈希；校验通过后：坏文件移入 `<mount>/.observer-quarantine/`，临时文件 fsync 后 rename 到目标路径，复核哈希，`POST /api/v1/repairs/{id}/result`。
4. hub 校验上报哈希 = 期望哈希 → 更新路径（hash/size/mtime/state/change_epoch/last_hashed_at）、写 `observations(kind=repair)`、关闭 issue；repair `completed`、删除临时文件；失败则 repair `failed`、issue 保持。
5. 定时清理：scheduler tick 将过期票据置 `expired`、修复置 `failed` 并删除临时文件。

## 5. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/issues/{id}` | 异常详情（证据/路径/mount/机器） |
| GET | `/api/v1/issues/{id}/replicas` | 健康副本候选 |
| POST | `/api/v1/issues/{id}/repair` | 创建修复 |
| GET | `/api/v1/repairs` / `/{id}` | 修复列表/详情 |
| POST | `/api/v1/repairs/{id}/cancel` | 取消 |
| PUT | `/api/v1/transfers/{id}/data?offset=` | 源 agent 上传分块 |
| GET | `/api/v1/transfers/{id}/data?offset=` | 目标 agent 下载分块 |
| POST | `/api/v1/transfers/{id}/fail` | 源 agent 报告失败 |
| POST | `/api/v1/repairs/{id}/result` | 目标 agent 上报结果 |

heartbeat 响应新增 `transfers`（源上传任务）与 `repairs`（目标应用任务）。

## 6. 安全与失败处理

- 数据端点：agent token 必须属于票据源/目标机器，否则 403；票据过期 410。
- 源上传前先整文件哈希；hub 收满后再次校验；目标下载后再次校验；目标替换前校验当前文件哈希 = 异常时的 observed hash（缺失则要求不存在）。
- `quarantine` 目录：`<mount>/.observer-quarantine/`，演练配置需将其排除出扫描规则。
- 失败：删临时文件、不动原文件、repair failed、审计；用户可重新发起。
- 修复默认关闭：agent 配置 `repair_allowed: true` 才允许作为目标。

## 7. 验收（drill-m3）

| # | 验收 |
| --- | --- |
| 1 | 两台 agent 基线一致（同内容） |
| 2 | 目标文件被篡改后 full 巡检产生 mismatch（high） |
| 3 | 副本查询命中源机器健康副本 |
| 4 | 创建修复 → 源上传 → 目标替换，repair completed |
| 5 | 目标文件内容/哈希恢复为基线值，issue resolved |
| 6 | quarantine 中保留被篡改的旧文件 |
| 7 | 审计包含 repair.create/upload/complete |
| 8 | 非 repair_allowed / 无健康副本时拒绝修复 |
| 9 | M2 drill 回归通过 |

## 8. 提交计划

1. `feat(hub): M3 数据模型与副本查询`
2. `feat(hub): 修复票据与跨机中转`
3. `feat(agent): 执行跨机修复（隔离/替换/复核）`
4. `feat(web): 异常详情与修复操作`
5. `test: 增加 M3 验收脚本`
6. `docs: M3 收尾与验收记录`，tag `m3`

## 9. 进度

| 日期 | 进展 |
| --- | --- |
| 2026-10-29 | 计划创建；P1 数据模型与副本查询 |
| 2026-10-29 | P2/P3 完成：修复票据、hub 中转、heartbeat 任务、agent 上传/下载/隔离/替换/复核 |
| 2026-10-29 | P4 完成：Web 异常详情、副本选择、修复状态轮询；P5：`drill-m3.ps1` 10/10 通过，tag `m3` |

## 10. 验收结果（2026-10-29）

- `pwsh ./scripts/drill-m3.ps1`：**10/10 通过**——两台 agent 基线一致、篡改触发 mismatch、副本命中、源上传→目标替换、内容与哈希恢复、issue resolved、quarantine 保留坏文件、审计含 create/upload/complete。
- `pnpm --filter hub test`：**11 个文件、49 项通过**（新增 `repairs.test.ts` 覆盖完整中转/替换链路与拒绝场景）。
- `go test ./...`（agent）通过。
- `pwsh ./scripts/drill-m2.ps1`：**8/8 通过**（内部完成 M1 回归）。
- `pnpm --filter web build`、`typecheck` 通过。

## 11. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿 |
| v0.2 | 2026-10-29 | P1–P5 完成，记录验收结果，tag `m3` |
