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

## 4. Windows

- agent：`go build -o bin/observer-agent.exe ./cmd/observer-agent`（已验证）。
- 桌面端：`cd agent/desktop && wails3 build` → `bin/observer-agent-desktop.exe`（已验证启动/单实例/托盘）。
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
| Dockerfile.hub / compose（hub） | ✅ 2026-11-05 在 WSL2 Ubuntu + Docker 29 实测：镜像 build、healthcheck、卷保留升级、数据与在线 agent 均正常 |
| Dockerfile.agent / compose（agent） | ⚠️ 本次未实际 build/run（未指定巡检目录）；已知配置见 `deploy/agent.example.yaml` |
| systemd unit | ✅ 静态检查（本机无 systemd 环境，未实际启动） |
| Windows agent / 桌面 exe | ✅ 构建、启动、单实例 |
| Wails NSIS 打包 | ❌ 未验证（未安装 NSIS） |
| macOS 构建 / 签名 / 公证 | ❌ 未验证（需 Mac + Apple 证书） |
| 性能基准 | ✅ 见 [PLAN-M4](PLAN-M4.md) §4 |
| GitHub Actions Release（tag → 三平台产物 + SHA256SUMS） | ✅ 2026-11-11 试发布 `v0.0.0-rc.1` 通过：Actions run 成功、Release 为 pre-release、下载资产 sha256 一致、linux/amd64 静态链接且 `version` 输出正确；流程见 [RELEASE](RELEASE.md) |
