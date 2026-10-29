# Observer 部署产物

| 文件 | 用途 |
| --- | --- |
| `Dockerfile.hub` | hub 镜像（Node + SQLite + Web 控制台） |
| `Dockerfile.agent` | agent 镜像（multi-stage → distroless，CGO=0） |
| `docker-compose.yml` | hub + 单 agent 示例（只读媒体、只读 rootfs、状态卷） |
| `observer-agent.service` | systemd unit（`Restart=on-failure`、ProtectSystem、只读媒体） |
| `agent.example.yaml` | NAS agent 配置示例（只读挂载、调度窗口、限速） |
| `build-linux.ps1` | Windows 上交叉编译 Linux amd64/arm64 agent 并校验 ELF/大小 |

## 快速开始（NAS）

```bash
# 1. 在 hub 上创建注册 token（或从 Web/CLI）
pnpm --filter hub token:create -- --machine nas-01

# 2. 安装 systemd 方式
sudo useradd --system --home /var/lib/observer --shell /usr/sbin/nologin observer
sudo install -m 0755 observer-agent /usr/local/bin/observer-agent
sudo install -m 0644 agent.example.yaml /etc/observer/agent.yaml   # 修改 hub 地址/mount
sudo install -m 0644 observer-agent.service /etc/systemd/system/
sudo mkdir -p /var/lib/observer && sudo chown observer:observer /var/lib/observer
echo '<token>' | sudo tee /var/lib/observer/token >/dev/null && sudo chown observer:observer /var/lib/observer/token
sudo systemctl daemon-reload && sudo systemctl enable --now observer-agent
sudo journalctl -u observer-agent -f

# 3. 或 Docker Compose（在仓库根目录）
export OBSERVER_ADMIN_PASSWORD='change-me'
export OBSERVER_ENROLL_TOKEN='<token>'
cp deploy/agent.example.yaml deploy/agent.yaml
mkdir -p deploy/mounts/photos
docker compose -f deploy/docker-compose.yml up -d
```

## 说明

- `Dockerfile.*` 与 `docker-compose.yml` 未在本机验证（当前环境无 Docker）；`build-linux.ps1` 已在本机验证交叉编译与 ELF。
- macOS 打包/签名/公证见 [docs/DEPLOY.md](../docs/DEPLOY.md)。
