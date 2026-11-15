# 群晖 Container Manager 部署

> 完整说明见 [docs/DEPLOY-SYNOLOGY.md](../../docs/DEPLOY-SYNOLOGY.md)。本目录是一个可直接用于 Container Manager 项目的模板。

## 文件

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | hub + agent 全栈（推荐单台 NAS） |
| `docker-compose.agent.yml` | 仅 agent，hub 在另一台机器 |
| `agent.example.yaml` | agent 配置模板，复制为 `agent.yaml` 后修改 |

## 快速开始

1. **确认架构**：SSH 执行 `uname -m`。`x86_64` 用 `amd64` 资产，`aarch64` 用 `arm64` 资产。
2. **下载并导入镜像**：从 GitHub Release 下载 `observer-hub_<ver>_linux_<arch>.tar` 与 `observer-agent_<ver>_linux_<arch>.tar`，用同名 `.sha256` 校验后，在 Container Manager「映像 → 新增 → 从文件添加」导入；或 SSH `sudo docker load -i <file>.tar`。
3. **创建项目目录**：例如 `/volume1/docker/observer-agent/`，放入 `docker-compose.yml`，把 `agent.example.yaml` 复制为 `agent.yaml`。
4. **修改配置**：
   - `docker-compose.yml` 中 hub 的 `OBSERVER_ADMIN_PASSWORD`；
   - `agent.yaml` 的 `hub`、`machine_id`、`token`；
   - 按实际共享文件夹修改 compose 的 `volumes` 和 agent 的 `mounts`。
5. **创建 sentinel**：在每个共享文件夹根目录写 `.observer-mount`，内容包含 mount id：
   ```bash
   echo "mount_id=photos" | sudo tee /volume1/photo/.observer-mount
   sudo chmod 644 /volume1/photo/.observer-mount
   ```
6. **启动**：Container Manager → 项目 → 新增 → 选择该目录/上传 compose → 构建并启动。
7. **验证**：看容器日志。`doctor` 会独占状态缓存，需先停止 agent 再用同一镜像跑一次性容器（运行中 `docker exec ... doctor` 会报 `open state cache: timeout`）；也可以直接看日志与 Web 状态。打开 `http://<nas-ip>:8787`，用管理员口令登录，确认机器在线；在挂载点页手动触发一次全量巡检建立基线。

> **权限**：默认只有 `observer-agent-state` 卷需要可写（65532）；共享文件夹用 `:ro` 只读挂载即可，除非把 `repair_allowed` 设为 `true`。细节见 [DEPLOY-SYNOLOGY §8](../../docs/DEPLOY-SYNOLOGY.md#8-权限与属主)。

## 路径映射

- 每个共享文件夹 = compose 里一条 `volumes` + `agent.yaml` 里一个 `mounts`。
- 默认使用**同路径映射**（`/volume1/photo:/volume1/photo:ro`），Web 显示的物理路径与 NAS 一致。
- 新增映射后必须重启容器；agent 只在启动时把挂载点同步给 hub。
- 路径不能互相包含；不要在同一个 `mount id` 下直接换目录。
- sentinel 必须放在共享盘内，不能从项目目录 bind 进去，否则无法证明共享盘已挂载。

## 说明

- 镜像不发布到 Docker Hub；只从 GitHub Release 下载 tar 导入。
- 默认只读、非 root、无入站端口；agent 不需要端口映射。
- NAS 上不建议开启 `repair_allowed`，避免写共享文件夹。
- ARMv7 机型不支持（Container Manager 可用性和性能都不保证）。
- 当前镜像 tag 为 `1.2.0`；下载其他版本时同步替换 compose 中的 tag。
