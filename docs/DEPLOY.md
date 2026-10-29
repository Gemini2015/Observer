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

```bash
export OBSERVER_ADMIN_PASSWORD='change-me'
export OBSERVER_ENROLL_TOKEN='<token>'
cp deploy/agent.example.yaml deploy/agent.yaml   # 修改 hub 地址
mkdir -p deploy/mounts/photos
docker compose -f deploy/docker-compose.yml up -d
```

- agent 容器：`read_only: true`、distroless nonroot（UID 65532，可用 `AGENT_UID/AGENT_GID` 覆盖）、媒体只读 bind mount、状态卷可写。
- hub 容器：`/data` 卷保存 SQLite + 修复中转；升级时保留卷即可，迁移自动执行。
- TLS：建议在 compose 前加 Caddy 反向代理（示例）：

```caddyfile
observer.example.com {
  reverse_proxy hub:8787
}
```

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
| systemd unit / compose / Dockerfile 语法与关键指令 | ✅ 静态检查（无 Docker/systemd 环境，未实际启动） |
| Windows agent / 桌面 exe | ✅ 构建、启动、单实例 |
| Wails NSIS 打包 | ❌ 未验证（未安装 NSIS） |
| macOS 构建 / 签名 / 公证 | ❌ 未验证（需 Mac + Apple 证书） |
| 性能基准 | ✅ 见 [PLAN-M4](PLAN-M4.md) §4 |
