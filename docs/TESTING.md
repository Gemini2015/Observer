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

未在本机验证：systemd 实际运行、NSIS 安装包、macOS 构建/签名/公证、群晖 Container Manager 真机导入（Docker 镜像的 arm64 构建/运行见 §8；CI 双架构与 Docker archive 见 [RELEASE](RELEASE.md)）。

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
| 6 | 异常页 | tab 计数与列表一致（待确认/已忽略/已解决）；勾选 2 条批量忽略后有 Toast、列表刷新 |
| 7 | 确认更新 | 在待确认 mismatch 上点「确认更新」→ 旧/新 hash 确认框 → 已解决显示「已更新基线」；下一轮同 hash 不再报，改其他内容会重新报 |
| 8 | 忽略生命周期 | 忽略后同 hash 不再报；恢复基线 hash 自动解决；出现第三种 hash 重新待确认；已忽略可「取消忽略」 |
| 9 | 修复流程 | 选副本 → 开始 → 进度条与状态推进 → 终态提示；失败原因可读；已忽略异常也能发起修复 |
| 10 | 删除机器 | 需输入机器 ID 才能确认；取消无副作用 |
| 11 | 术语 | 页面不出现 open/ignored/resolved/mismatch/seen/hashed 等裸枚举（技术信息折叠区除外） |
| 12 | 对比度 | 危险按钮与 muted 文本 ≥ 4.5:1 |
| 13 | 任务页 | 状态/机器/挂载点筛选生效；自动刷新可关；点行进 `/jobs/:id` |
| 14 | `/audit` | 有记录、可按动作前缀筛选（含 `issue.`）、详情可展开 |
| 15 | `/repairs` | 有记录时展示源→目标与进度，进行中可取消 |
| 16 | `/system` | 版本/运行时长/调度参数/数据库规模正确，注册 token 可生成 |
| 17 | 会话过期 | 任一请求 401 后回到登录页；重新登录回到原路由 |

## 8. Docker 镜像本地冒烟（Apple container）

macOS 26+ 可用 Apple `container` 在没有 Docker 的机器上验证镜像（arm64 原生；amd64 通过 builder/Rosetta）。它不能替代 CI 的 Docker archive 校验，也不能替代群晖 Container Manager 导入。

```bash
# 1. 启动服务（首次会下载内核/builder）
container system start --enable-kernel-install

# 2. agent（arm64）；国内网络加 GOPROXY 镜像
container build \
  --build-arg GOPROXY=https://goproxy.cn,direct \
  --build-arg VERSION=1.0.0-local \
  -f deploy/Dockerfile.agent -t observer-agent:local .
container run --rm observer-agent:local version       # 输出 1.0.0-local

# 3. hub（arm64）；国内网络用 npm/apt 镜像
container build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  --build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn \
  --build-arg INSTALL_BUILD_TOOLS=1 \
  --build-arg BUILD_FROM_SOURCE=1 \
  --build-arg VERSION=1.0.0-local \
  -f deploy/Dockerfile.hub -t observer-hub:local .

# 4. amd64（Rosetta）
container build --platform linux/amd64 \
  --build-arg GOPROXY=https://goproxy.cn,direct \
  -f deploy/Dockerfile.agent -t observer-agent:local-amd64 .
container run --rm --arch amd64 --rosetta observer-agent:local-amd64 version
```

端到端（hub + agent）用 Apple container network/volume 模拟群晖：创建 `observer-e2e` network，hub 和 agent 都加入该 network；从 `container ls` 取 hub 的 IP，agent 配置 `hub: http://<hub-ip>:8787`（Apple container 的 `alias` 要求 FQDN，本版本测试未解析，直接用 IP 最稳）。`state_dir: /var/lib/observer`，媒体目录用 `--mount type=bind,...,readonly`，根文件系统 `--read-only`，用户 `--uid 65532 --gid 65532`。

Apple container 1.7.1 本机测试中 `-p` 端口发布不可达，所以注册 token 直接在 hub 容器内用 Node fetch 调 API（Docker / 群晖的端口发布正常）：

```bash
container exec -i observer-hub-test node - <<'EOF'
const base = 'http://127.0.0.1:8787';
const login = await fetch(base + '/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'test-password' }),
});
const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')])[0].split(';')[0];
const r = await fetch(base + '/api/v1/enroll-tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ machine_hint: 'synology-test', ttl_hours: 1 }),
});
console.log((await r.json()).token);
EOF
```

触发扫描同理：在 hub 容器内 `POST /api/v1/mounts/<id>/scan`，body `{"mode":"full"}`；用 `GET /api/v1/jobs/<id>` 和 `/api/v1/files?machine_id=synology-test` 验证结果。

注意：

- `container image save` 输出 **OCI tar**；群晖导入物是 `docker save` 的 **Docker archive**，由 CI 生成并用 `docker load` 回归。
- Apple container 没有 Compose；`deploy/synology/*.yml` 只做 YAML 静态校验，最终在群晖 Container Manager 验证。
- Apple container 的 bind mount 走 VirtioFS，宿主权限与 DSM ACL 不同；非 root 读取失败时可临时用 root 完成端到端，但不要把该结论当作群晖权限结论。
- Apple container 当前 bind mount 的 source 必须是目录；本地测试把 `agent.yaml` 放在目录里挂载（Synology/Docker 可以直接挂单个文件）。
- 测试只创建 `observer-*-test` / `observer-e2e-*` 资源；不要执行全局 prune。

本次本地结果（2026-11-15，macOS 27.0.1 arm64，Apple container 1.7.1）：

| 项 | 结果 |
| --- | --- |
| agent arm64 构建 | ✅ `observer-agent:local`，`version` 输出 `1.0.0-local` |
| hub arm64 构建 | ✅ `observer-hub:local`（`better-sqlite3` 源码编译路径） |
| hub `/healthz` 与 Web 根路径 | ✅ 容器内 `fetch` 正常 |
| hub + agent 注册/心跳/挂载同步 | ✅ machine `synology-test` 在线，mount `photos` active |
| 全量扫描 | ✅ `seen=2 hashed=2`，文件入库 |
| sentinel 掉盘保护 | ✅ 移除 sentinel 后 `seen=0`，无 missing 误报；恢复后再次 `seen=2` |
| 非 root + 只读根文件系统 + 状态卷 | ✅ UID 65532 可写 `/var/lib/observer`，重启后 token 保留 |
| OCI save/load | ✅ `container image save/load` 自洽；**不是** Docker archive |
| amd64 | ✅ agent build + `version`；hub build + `/healthz`（`--arch amd64 --rosetta`）；CI 仍用 QEMU 并做 `docker save`/`docker load` 回归 |
| `doctor` | ⚠️ 运行中的 agent 占用状态缓存，直接 exec 会 `open state cache: timeout`；需停止 agent 后用一次性容器运行 |
