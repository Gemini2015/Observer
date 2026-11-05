# 测试与验收

> 返回 [README](../README.md)。最近一次完整结果见文末。

## 1. 单元测试与静态检查

| 命令 | 范围 |
| --- | --- |
| `pnpm --filter hub test` | hub：认证、注册/心跳、任务、入库、调度、多机、修复、聚合（21 个文件/73 项） |
| `pnpm --filter hub typecheck` | hub 源码 + 测试类型检查 |
| `pnpm --filter web typecheck` / `test` / `build` | Web 控制台（含格式化/标签函数单测） |
| `cd agent; go test ./...` | agent 各包（配置、规则、哈希、限速、缓存、扫描、修复、client 等） |
| `cd agent; go vet ./...` | agent 静态检查 |
| `cd agent/desktop; go vet ./...` | 桌面模块静态检查 |

## 2. 验收脚本（drill）

| 脚本 | 检查数 | 覆盖内容 | 端口 |
| --- | --- | --- | --- |
| `scripts/drill.ps1` | 9 | M1 单机闭环：基线覆盖率、保持 mtime 的损坏检测、missing 生命周期、hub 重启恢复、spool 补发、sentinel 熔断、缓存恢复 | 8899 |
| `scripts/drill-m2.ps1` | 8 | M2：两台 agent 并行、自动调度派发、离线标记、桌面窗口/单实例；内部调用 `drill.ps1` | 8899 |
| `scripts/drill-m3.ps1` | 10 | M3：副本命中、源上传→目标替换、内容/哈希恢复、issue resolved、quarantine、审计 | 8899 |
| `scripts/drill-m4.ps1 -RunRegression` | 8 | M4：部署产物、Docker/systemd 静态检查、Linux 交叉编译、Windows exe、聚合接口、性能基准；回归 M2+M3 | 8893（内部 bench 8892） |

说明：

- 脚本会自动构建所需二进制（除非 `-SkipBuild`），启动真实 hub + agent，结束后清理（`-KeepData` 可保留现场）。
- 需要 PowerShell 7（`pwsh`）、Node、Go；桌面端检查需要 Wails CLI 与 WebView2。
- 各脚本默认端口不同，避免互相占用；结束异常时可用 `-Port` 指定。

## 3. 性能基准

```powershell
pwsh ./scripts/bench.ps1                      # 4KB × 2000
pwsh ./scripts/bench.ps1 -Files 200 -SizeBytes 1048576   # 1MB × 200
```

| 指标 | 阈值 | 说明 |
| --- | --- | --- |
| 基线/全量文件速率 | ≥ 100 files/s | 每文件固定开销场景 |
| 全量吞吐 | 4KB 场景 ≥ 0.5 MiB/s；≥64KB 场景 ≥ 20 MiB/s | 大小文件分别考核 |
| agent 内存峰值 | ≤ 256 MiB | 采样 WorkingSet |
| 增量扫描 | hashed=0 且 skipped ≥ 文件数 | 验证缓存跳过 |

## 4. 回归矩阵

| 改动范围 | 建议执行 |
| --- | --- |
| hub 数据层/API | `pnpm --filter hub test` + `drill-m3`（覆盖中转/修复） |
| agent 扫描/缓存/限速 | `cd agent && go test ./...` + `drill.ps1` + `drill-m3` |
| 调度/多机 | `drill-m2` |
| 部署/性能/聚合 | `drill-m4 -RunRegression` |
| 发布前 | 上述全部 + `bench.ps1` |

## 5. 最近一次完整结果（2026-10-29，Windows）

| 项 | 结果 |
| --- | --- |
| `drill.ps1` | 9/9 PASS |
| `drill-m2.ps1` | 8/8 PASS（内含 M1） |
| `drill-m3.ps1` | 10/10 PASS |
| `drill-m4.ps1 -RunRegression` | 8/8 PASS（内含 M2+M3） |
| `pnpm --filter hub test` | 12 文件 / 50 项通过 |
| `go test ./...`（agent） | 全部包通过 |
| `bench.ps1`（4KB×2000） | 245 files/s，1.0 MiB/s，RSS 18.4 MiB |
| `bench.ps1`（1MB×200） | 240 files/s，240.7 MiB/s，RSS 16.8 MiB |
| Linux 交叉编译 | amd64 7.3 MiB / arm64 6.8 MiB（ELF） |

未在本机验证：Docker 镜像构建、systemd 实际运行、NSIS 安装包、macOS 构建/签名/公证（见 [DEPLOY §7](DEPLOY.md#7-本机验证状态)）。

> 2026-11-05 Web 控制台改造：`pnpm --filter web typecheck` / `test`（23 项）/ `build` 与 `pnpm --filter hub test`（21 文件/73 项）通过；UI 手动验收见 §7。本次未重跑 drill（未改 agent 与协议）。

## 6. 本地提示

- 验收脚本会产生 `data/` 下的临时目录（已 gitignore）；可用 `scripts` 的 `-KeepData` 保留日志排查。
- Windows 下 Go 不在 PATH 时：`$env:PATH = "C:\Program Files\Go\bin;$env:PATH"`；Wails CLI 在 `%USERPROFILE%\go\bin`。
- 同机跑多个 agent（drill 场景）时，`token_file` 必须分别放在不同目录（缓存/spool 派生自该目录）。

## 7. UI 手动验收清单

改造 Web 控制台后，用「复制一份 `hub/data` + 本地 hub」的方式做手动验收（不要直接改原始数据）：

```powershell
Copy-Item -Recurse hub\data data\ui-check
$env:OBSERVER_DATA_DIR=(Resolve-Path data\ui-check).Path
$env:OBSERVER_ADMIN_PASSWORD='observer'
$env:OBSERVER_PORT='8787'
$env:OBSERVER_SCHEDULER_ENABLED='false'
pnpm --filter hub dev        # 终端 A：hub 8787

pnpm --filter web dev        # 终端 B：打开 http://127.0.0.1:5173（/api 代理到 8787）
```

| # | 检查项 | 期望 |
| --- | --- | --- |
| 1 | 空库启动 | 总览覆盖率为「—/无文件」，不是 100% |
| 2 | 停 hub 10 秒再恢复 | 页面保留旧数据并提示刷新失败；恢复后自动刷新，无需 F5 |
| 3 | 390px / 768px / 1024px / 1440px | 页面本身不横向滚动；宽表格在容器内横向滚动 |
| 4 | 键盘 Tab | 可达侧栏、筛选、表格行内「详情」；抽屉 Esc 关闭后焦点回到触发按钮 |
| 5 | 文件页打开详情 | URL 带 `?file=`，刷新仍打开，浏览器 Back 关闭 |
| 6 | 异常页 | tab 计数与列表一致；勾选 2 条批量确认后有 Toast、列表刷新 |
| 7 | 修复流程 | 选副本 → 开始 → 进度条与状态推进 → 终态提示；失败原因可读 |
| 8 | 删除机器 | 需输入机器 ID 才能确认；取消无副作用 |
| 9 | 术语 | 页面不出现 open/acked/mismatch/seen/hashed 等裸枚举（技术信息折叠区除外） |
| 10 | 对比度 | 危险按钮与 muted 文本 ≥ 4.5:1 |
| 11 | 任务页 | 状态/机器/挂载点筛选生效；自动刷新可关；点行进 `/jobs/:id` |
| 12 | `/audit` | 有记录、可按动作前缀筛选、详情可展开 |
| 13 | `/repairs` | 有记录时展示源→目标与进度，进行中可取消 |
| 14 | `/system` | 版本/运行时长/调度参数/数据库规模正确，注册 token 可生成 |
| 15 | 会话过期 | 任一请求 401 后回到登录页；重新登录回到原路由 |
