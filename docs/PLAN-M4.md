# Observer M4 实施计划

> 版本：v0.2　日期：2026-10-29　性质：可执行实施计划
>
> 上游：[技术方案](DESIGN-TECH.md)（v0.8）、[M3 实施计划](PLAN-M3.md)。M3 已完成（tag `m3`）。
> M4 目标：**三平台可用**——Windows/macOS 单文件可用，NAS 容器/systemd 可部署；性能与告警聚合打磨。

## 1. 范围

### 1.1 做（M4 In）

- **NAS 部署**：`deploy/Dockerfile.agent`、`deploy/Dockerfile.hub`、`deploy/docker-compose.yml`、`deploy/observer-agent.service`、示例配置；Linux amd64/arm64 交叉编译验证。
- **Windows/macOS 交付**：桌面端打包说明（Wails NSIS / `.app`）、macOS 签名与公证步骤（本机无法执行，文档化并标注未验证项）。
- **性能**：`scripts/bench.ps1` 实测扫描吞吐、文件速率、agent 内存峰值；资源目标核对（NAS 闲置 ≤30MB、扫描 ≤80MB；桌面扫描 ≤200MB）。
- **告警聚合**：总览接口与 Web 增加按类型/机器的 open issue 聚合。
- **验收**：`scripts/drill-m4.ps1` 检查部署产物、Linux 二进制、性能阈值、聚合接口，并回归 M2/M3。

### 1.2 暂不做（记录取舍）

- **块级扫描 / 事件驱动**：技术方案 M4 提及，但实现与验证成本高，推迟到 M5/按需；M4 以部署与性能为主。
- **macOS 实际签名/公证**：需要 Apple Developer ID 与 macOS 环境，本机仅能提供脚本与文档，无法验证。
- **通知/告警推送**：已暂缓（M2 决定），告警聚合只做控制台展示。

## 2. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 部署产物（Dockerfile / compose / systemd / 示例配置）+ Linux 交叉编译 | ✅ |
| P2 | 性能基准脚本与实测 | ✅ |
| P3 | 告警聚合（API + Web + 单测） | ✅ |
| P4 | 打包/签名文档（Windows NSIS、macOS codesign/notarize） | ✅（文档，未在本机执行） |
| P5 | `drill-m4.ps1` + 文档 + tag `m4` | ✅ |

## 3. 部署设计

### 3.1 NAS（Linux）

- 产物：`/usr/local/bin/observer-agent`、`/etc/observer/agent.yaml`、状态目录 `/var/lib/observer`（token/cache/spool）。
- systemd：`observer-agent.service`，`Restart=on-failure`、`User/Group` 可配、`ProtectSystem=strict`、`NoNewPrivileges`、媒体目录只读挂载。
- 容器：multi-stage（golang → distroless static:nonroot），`CGO_ENABLED=0`，二进制 ~15MB；运行时 `--read-only`，媒体只读 bind mount，状态卷可写。
- 交叉编译：`GOOS=linux GOARCH=amd64|arm64`，Windows 上可验证（纯 Go、无 CGO）。

### 3.2 hub

- `docker compose up -d`：hub 容器 + `/data` 卷（SQLite + transfers），可选 Caddy 终结 TLS（示例注释）。
- 环境变量沿用 `OBSERVER_*`；生产必须显式 `OBSERVER_ADMIN_PASSWORD`。

### 3.3 桌面端

- Windows：`wails3 package`（NSIS）生成安装包；单文件 `observer-agent-desktop.exe` 已可运行。
- macOS：`wails3 package` 生成 `.app`，再 `codesign --deep --options runtime` + `xcrun notarytool submit`；文档给出完整命令与所需变量。

## 4. 性能指标（实测，2026-10-29，本机 Windows）

| 场景 | 结果 | 目标 | 结论 |
| --- | --- | --- | --- |
| 4KB × 2000（基线/全量） | 245 files/s，1.0 MiB/s，RSS 18.4 MiB | files/s ≥ 100 | ✅ |
| 4KB × 2000（增量，未变化） | 4963 files/s，skipped 2000，hashed 0 | 跳过未变化文件 | ✅ |
| 1MB × 200（基线/全量） | 240 files/s，240.7 MiB/s，RSS 16.8 MiB | MiB/s ≥ 20 | ✅ |
| Linux 二进制 | amd64 7.3 MiB / arm64 6.8 MiB，ELF，CGO=0 | ≤ 30MB | ✅ |

> 结论：agent 内存峰值远低于 256MB 桌面目标（≈18MB），小文件场景主要受每文件固定开销限制（≈245 files/s）；大文件吞吐 ≈240 MiB/s。

## 5. 告警聚合

`GET /api/v1/overview` 增加：

```json
{
  "issues_by_type": { "mismatch": 0, "missing": 0, "unreadable": 0 },
  "issues_by_machine": [{ "machine_id": "nas-01", "open": 2 }]
}
```

Web 总览展示按类型/机器的 open 数。

## 6. 验收（drill-m4）

| # | 验收 |
| --- | --- |
| 1 | Linux amd64/arm64 agent 交叉编译成功且为静态（无 CGO） |
| 2 | Dockerfile/compose/systemd 产物存在且关键指令正确 |
| 3 | 性能基准达到阈值（files/s、MiB/s、内存） |
| 4 | 总览接口返回 issues_by_type / issues_by_machine |
| 5 | Windows 桌面 exe 与 agent exe 可构建 |
| 6 | M2 drill 回归通过（含 M1） |
| 7 | M3 drill 回归通过 |

## 7. 提交计划

1. `feat(deploy): 增加 Docker/systemd/示例配置与 Linux 交叉编译脚本`
2. `perf: 增加扫描性能基准脚本`
3. `feat(hub): 总览增加告警聚合` + `feat(web): 展示告警聚合`
4. `docs: 打包与 macOS 签名公证说明`
5. `test: 增加 M4 验收脚本`
6. `docs: M4 收尾与验收记录`，tag `m4`

## 8. 进度

| 日期 | 进展 |
| --- | --- |
| 2026-10-29 | 计划创建；P1 部署产物实现中 |
| 2026-10-29 | P1/P2 完成：deploy 产物、Linux 交叉编译（7.3/6.8 MiB ELF）、bench.ps1 实测 |
| 2026-10-29 | P3/P4/P5 完成：总览聚合 + Web、DEPLOY.md（含 macOS 签名/公证步骤）、drill-m4 8/8 通过，tag `m4` |

## 9. 验收结果（2026-10-29）

- `pwsh ./scripts/drill-m4.ps1 -RunRegression`：**8/8 通过**
  1. 部署产物齐全；2. Dockerfile/compose/systemd 关键配置；3. Linux amd64/arm64 ELF 交叉编译；4. Windows agent/桌面 exe；5. 总览告警聚合；6. 性能基准达标；7. M2 回归（内含 M1）；8. M3 回归。
- `pnpm --filter hub test`：**12 个测试文件、50 项通过**（新增 aggregation.test.ts）。
- `deploy/build-linux.ps1`：amd64 7.3 MiB / arm64 6.8 MiB，ELF，CGO=0。
- `scripts/bench.ps1`：4KB×2000 → 245 files/s、RSS 18.4 MiB；1MB×200 → 240.7 MiB/s、RSS 16.8 MiB。
- `scripts/drill-m2.ps1`、`scripts/drill-m3.ps1` 均通过。
- `pnpm --filter web typecheck/build` 通过。

## 10. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿：M4 范围、部署/性能/聚合设计、验收 |
| v0.2 | 2026-10-29 | P1–P5 完成，记录性能实测与验收结果，tag `m4` |
