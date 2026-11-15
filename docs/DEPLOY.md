# 部署与打包（M4）

> 关联：[deploy/](../deploy/) 产物、[PLAN-M4](PLAN-M4.md)。本机验证状态见文末。

## 1. 形态总览

| 组件 | 平台 | 产物 |
| --- | --- | --- |
| hub | Linux/Windows/macOS（Node ≥22） | `pnpm --filter hub build` → `node hub/dist/main.js`；Dockerfile.hub |
| agent（headless） | Windows / Linux(NAS) / macOS | 单文件 `observer-agent`；Linux 交叉编译脚本；Dockerfile.agent；systemd unit |
| 桌面端 | Windows / macOS | Wails v3 单文件 exe / `.app`，可打 NSIS 安装包 |

## 2. NAS（systemd）

```bash
sudo useradd --system --home /var/lib/observer --shell /usr/sbin/nologin observer
sudo install -m 0755 observer-agent /usr/local/bin/observer-agent
sudo install -m 0644 agent.example.yaml /etc/observer/agent.yaml   # 修改 hub 与 mount
sudo install -m 0644 observer-agent.service /etc/systemd/system/
sudo mkdir -p /var/lib/observer && sudo chown observer:observer /var/lib/observer
echo '<enroll-token>' | sudo tee /var/lib/observer/token >/dev/null
sudo chown observer:observer /var/lib/observer/token
sudo systemctl daemon-reload
sudo systemctl enable --now observer-agent
sudo journalctl -u observer-agent -f
```

- 媒体目录以只读方式暴露给 agent；状态目录仅 `/var/lib/observer` 可写（unit 已用 `ProtectSystem=strict` + `ReadWritePaths` 限制）。
- 资源目标：NAS 扫描内存 ≤80MB；可在 unit 中启用 `MemoryMax=128M` 硬限制。

## 3. NAS / 服务器（Docker Compose）

在仓库根目录执行：

```bash
cd deploy
cp .env.example .env                  # 填入 OBSERVER_ADMIN_PASSWORD / OBSERVER_ENROLL_TOKEN
cp agent.example.yaml agent.yaml
# 编辑 agent.yaml：hub 改为 http://hub:8787；path /media/photos 对应下面挂载目录
mkdir -p mounts/photos
echo 'mount_id=photos' > mounts/photos/.observer-mount   # sentinel，缺失会跳过该 mount
docker compose up -d --build
docker compose ps
```

- hub 容器：`OBSERVER_HOST=0.0.0.0` + `8787:8787`；`/data` 卷保存 SQLite + 修复中转，镜像已创建可写的 `/data` 属主，升级时保留卷即可、迁移自动执行。
- agent 容器：`read_only: true`、distroless nonroot（UID 65532，可用 `AGENT_UID/AGENT_GID` 覆盖）、媒体只读 bind mount、`/var/lib/observer` 状态卷可写（镜像已创建目录属主）。
- 旧版本创建过的 named volume 若报权限错误（Permission denied），需要重建卷或调整卷内属主；新部署会自动正确。
- hub 默认监听容器内 `0.0.0.0`；不要在 compose 里改回 `127.0.0.1`，否则宿主机端口映射无法访问。
- TLS：建议在 compose 前加 Caddy 反向代理（示例）：

```caddyfile
observer.example.com {
  reverse_proxy hub:8787
}
```

### WSL2 本机部署（已验证）

Windows + WSL2 Ubuntu 中跑 Docker 时，建议用本地 override 文件保留自己的端口与数据卷，不改主 compose：

```yaml
# deploy/docker-compose.local.yml（本地文件，已 gitignore）
services:
  hub:
    image: observer-hub:local
    ports: !override
      - "127.0.0.1:13000:8787"
    volumes: !override
      - "observer-hub-data:/data"
volumes:
  observer-hub-data:
    external: true
```

```bash
cd /mnt/e/workspace/node/Observer
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml \
  --env-file deploy/.env up -d --build hub
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml \
  --env-file deploy/.env ps
```

- 仅启动 hub 时，已有原生/桌面 agent 可继续连同一地址；要启用 compose 里的 Docker agent，需先把 `agent.yaml` 的 `hub` 改为 `http://hub:8787`、指定只读媒体目录并生成注册 token。
- 升级保留数据：沿用同一个 external volume 与 `OBSERVER_ADMIN_PASSWORD`；先 `docker stop` 旧容器再 `up`，**不要同时运行两个 hub 实例**（同一 SQLite 卷会被两个进程写入）。
- 回滚：升级前 `docker tag observer-hub:local observer-hub:local-backup-<日期>`；需要时停新容器，用备份镜像按原参数 `docker run`。
- WSL 关机后重新 `wsl -d Ubuntu` 即可恢复（Docker 服务已 enable，容器 `restart: unless-stopped`）；hub 仅绑定 `127.0.0.1`，不会暴露到局域网。

### 群晖 Container Manager（Release 镜像）

群晖不需要在 NAS 上 build：Release 附带 amd64/arm64 的 hub/agent `docker save` tar，导入 Container Manager 后用 [deploy/synology](../deploy/synology/) 模板启动。适合只读共享文件夹巡检、无入站端口、非 root 运行。

完整步骤（架构选择、镜像导入、项目创建、路径映射、sentinel、权限与排错）见 [DEPLOY-SYNOLOGY](DEPLOY-SYNOLOGY.md)。

## 4. Windows

**从 GitHub Release 安装（推荐，v1.2.0 起）**

- 桌面 GUI：下载 `observer-agent-desktop_<ver>_windows_amd64.zip`，解压到有写权限的目录（例如 `D:\Observer`，不要放 `C:\Program Files`），双击 `observer-agent-desktop.exe`。需要 Microsoft Edge WebView2 Runtime（Win11 / Win10 1803+ 通常已内置）；缺失时会弹框提示安装并给出日志路径，不会静默闪退。程序未做代码签名，SmartScreen 提示时选择「更多信息」→「仍要运行」，并用 Release 的 `SHA256SUMS` 核对文件。
- 命令行 agent：下载 `observer-agent_<ver>_windows_amd64.zip`，在 PowerShell 中按包内 `README-WINDOWS.txt` 运行；**不要双击**（双击只会打印用法后退出）。

**本地构建**

- agent：`go build -o bin/observer-agent.exe ./cmd/observer-agent`（已验证）。
- 桌面端：`cd agent/desktop && wails3 build` → `bin/observer-agent-desktop.exe`（已验证启动/单实例/托盘）。
- 发布用桌面 zip：Windows 上执行 `pwsh scripts/build-desktop-release.ps1 -Version 1.2.0`；脚本会构建前端/bindings/syso、以 `-H windowsgui` 构建 exe，并校验 PE 子系统、版本字符串与 zip 内容（见 [RELEASE §5](RELEASE.md#5-本地预演不推-tag)）。
- 桌面端日志：`%LocalAppData%\Observer\observer-agent-desktop.log`（启动失败时错误框会显示该路径）。
- NSIS 安装包：安装 NSIS 后执行 `wails3 package`（本机未安装 NSIS，未验证）；安装包需提示 WebView2 Runtime（Win10 1803+ 通常已内置）。
- 代码签名（可选）：`signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a observer-agent-desktop.exe`。

## 5. macOS

在 Mac 上构建：

```bash
cd agent/desktop
wails3 package        # 生成 .app
```

**Ad-hoc 签名（本机测试）**：

```bash
codesign --deep --force --sign - "bin/Observer Agent.app"
```

**Developer ID 签名 + 公证（分发）**：

```bash
IDENTITY="Developer ID Application: Your Name (TEAMID)"
codesign --deep --force --options runtime --timestamp --sign "$IDENTITY" "bin/Observer Agent.app"
ditto -c -k --keepParent "bin/Observer Agent.app" "ObserverAgent.zip"
xcrun notarytool submit "ObserverAgent.zip" --apple-id "$APPLE_ID" \
  --team-id "$TEAMID" --password "$APP_PASSWORD" --wait
xcrun stapler staple "bin/Observer Agent.app"
spctl -a -vv "bin/Observer Agent.app"
```

- 需要 Apple Developer Program、`Developer ID Application` 证书、app-specific password（或 API Key）。
- 公证后 Gatekeeper 检查通过；未公证的 ad-hoc 包在其它机器会被拦截。

## 6. 升级与备份

- hub：备份 `data/observer.db`（WAL 模式，建议 `sqlite3 .backup` 或停机拷贝）、`data/transfers/` 可丢弃。
- agent：升级替换二进制后重启；token/cache/spool 保留在状态目录。
- 修复中转票据 24h 过期，过期后自动清理临时文件。

## 7. 本机验证状态

| 项 | 状态 |
| --- | --- |
| Linux amd64 / arm64 交叉编译、ELF、大小 | ✅ 已验证（7.3 / 6.8 MiB） |
| Dockerfile.hub / compose（hub） | ✅ 2026-11-05 在 WSL2 Ubuntu + Docker 29 实测：镜像 build、healthcheck、卷保留升级、数据与在线 agent 均正常；2026-11-15 Apple container 1.7.1 arm64 build + `/healthz` 通过，amd64（Rosetta）build + `/healthz` 通过 |
| Dockerfile.agent / compose（agent） | ⚠️ 2026-11-15 在 Apple container 1.7.1 本地 arm64 build + hub/agent 端到端（注册/心跳/全量扫描/sentinel/状态卷）通过；compose 与群晖真机待验 |
| Docker 镜像 CI（hub/agent × amd64/arm64 → Release tar） | ✅ 2026-11-15 run `43698923356`：4 个镜像 build/smoke/`docker save`/`docker load` 通过，资产已上传 Release |
| Docker 镜像 CI（v1.2.0） | ✅ 2026-11-15 run `43714299026`：hub/agent × amd64/arm64 build/smoke/`docker save`/`docker load` 通过，4 个 tar + `SHA256SUMS-docker` 已发布 |
| hub 容器数据目录诊断与属主自动修正（v1.1.1） | ✅ 2026-11-15 Apple container 验证：只读 `/data` 输出明确诊断；root + `OBSERVER_FIX_DATA_PERMISSIONS=1` 修正属主后降权运行，`/healthz` 正常 |
| 群晖 Container Manager（镜像导入/项目/路径映射） | ❌ 未在真实 DSM 验证；模板与文档静态校验通过 |
| systemd unit | ✅ 静态检查（本机无 systemd 环境，未实际启动） |
| Windows agent / 桌面 exe | ✅ 构建、启动、单实例 |
| Windows 桌面端启动诊断（文件日志 / 错误框 / WebView2 提示） | ⚠️ 2026-11-15 CI 构建通过；文件日志/错误框/无 WebView2 提示待 Windows 真机验证 |
| GitHub Actions Release（桌面端 zip + 合并 SHA256SUMS） | ✅ 2026-11-15 run `43714299026`：desktop/finalize 成功；4 个二进制归档的 `SHA256SUMS` 下载校验通过，Release 正文含下载指引 |
| Wails NSIS 打包 | ❌ 未验证（未安装 NSIS） |
| macOS 构建 / 签名 / 公证 | ❌ 未验证（需 Mac + Apple 证书） |
| 性能基准 | ✅ 见 [PLAN-M4](PLAN-M4.md) §4 |
| GitHub Actions Release（tag → 三平台产物 + SHA256SUMS） | ✅ 2026-11-11 试发布 `v0.0.0-rc.1` 通过：Actions run 成功、Release 为 pre-release、下载资产 sha256 一致、linux/amd64 静态链接且 `version` 输出正确；流程见 [RELEASE](RELEASE.md) |
| GitHub Actions Release（v1.1.0：二进制 + 4 个镜像 tar） | ✅ 2026-11-15 run `43698923356`：hub/agent × amd64/arm64 镜像、各自 `.sha256`、`SHA256SUMS-docker` 与二进制同时发布；下载 agent tar 校验通过且 `manifest.json` 标签/架构正确 |
