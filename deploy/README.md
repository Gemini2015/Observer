# Observer 部署产物

| 文件 | 用途 |
| --- | --- |
| `Dockerfile.hub` | hub 镜像（Node + SQLite + Web 控制台） |
| `Dockerfile.agent` | agent 镜像（multi-stage → distroless，CGO=0） |
| `docker-compose.yml` | hub + 单 agent 示例（只读媒体、只读 rootfs、状态卷） |
| `.env.example` | compose 环境变量示例（管理员密码、注册 token、agent UID/GID） |
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
cd deploy
cp .env.example .env                 # 填管理员密码和注册 token
cp agent.example.yaml agent.yaml
# 编辑 agent.yaml：hub 必须改成 http://hub:8787
mkdir -p mounts/photos
echo 'mount_id=photos' > mounts/photos/.observer-mount
docker compose up -d --build
```

- compose 会自动读取 `deploy/.env`；不需要手动 export。
- hub 容器使用 `OBSERVER_HOST=0.0.0.0`，否则端口映射访问不到。
- 镜像已为 hub `/data` 和 agent `/var/lib/observer` 创建正确属主；旧 named volume 若权限报错需重建/调整属主。

## 说明

- `Dockerfile.*` 与 `docker-compose.yml` 已做静态检查并修复已知问题，但当前开发机没有 Docker，未实际 build/run；请在部署机执行一次 `docker compose up -d --build` 验证。
- macOS 打包/签名/公证见 [docs/DEPLOY.md](../docs/DEPLOY.md)。
