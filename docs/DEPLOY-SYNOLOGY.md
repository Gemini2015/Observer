# 群晖 NAS 部署（Container Manager）

> 返回 [README](../README.md)。通用 Docker 部署见 [DEPLOY](DEPLOY.md)，agent 配置字段见 [CONFIG](CONFIG.md)。
>
> 适用：DSM 7.2+、Container Manager、**x86_64 或 arm64** 机型。ARMv7 机型不支持（Container Manager 可用性和性能都不保证）。

Observer 的 hub 与 agent 都可以在群晖 Container Manager 中运行。镜像**不发布到 Docker Hub/GHCR**，而是由 GitHub Actions 在 tag 发布时构建，并以 `docker save` 的 Docker archive tar 附在 GitHub Release 上；下载后导入即可。

## 1. 部署形态

| 形态 | 使用文件 | 适用 |
| --- | --- | --- |
| hub + agent 全栈 | `deploy/synology/docker-compose.yml` | 单台 NAS 同时跑 hub 和 agent（推荐） |
| 仅 agent | `deploy/synology/docker-compose.agent.yml` | hub 在另一台机器 |
| 仅 hub | 使用全栈 compose，删除 agent service 与 agent 卷 | 只需要中心服 |

agent 只用**出站** HTTP(S) 访问 hub，**不需要任何入站端口**，也不需要特权、Docker socket 或宿主机网络。

## 2. 确认架构并下载镜像

SSH 登录 NAS，确认架构：

```bash
uname -m
```

| `uname -m` | 下载资产 |
| --- | --- |
| `x86_64` | `observer-hub_<ver>_linux_amd64.tar`、`observer-agent_<ver>_linux_amd64.tar` |
| `aarch64` | `observer-hub_<ver>_linux_arm64.tar`、`observer-agent_<ver>_linux_arm64.tar` |

从 GitHub Release 下载对应架构的两个 tar 和它们同名的 `.sha256`，先校验（只下载当前架构时不要用合并的 `SHA256SUMS-docker`，否则会提示缺少另一架构文件）：

```bash
sha256sum -c observer-hub_<ver>_linux_<arch>.tar.sha256
sha256sum -c observer-agent_<ver>_linux_<arch>.tar.sha256
```

> 如果 4 个架构 tar 都下载了，也可以 `sha256sum -c SHA256SUMS-docker`。

> `<ver>` 是 tag 去掉 `v` 的版本，例如 `1.1.1`。当前 compose 模板使用 `1.1.1`；下载其他版本时同步替换 compose 中的镜像 tag。

## 3. 导入镜像

两种方式任选：

**方式 A：Container Manager 界面**

1. Container Manager → 映像 → 新增 → 从文件添加；
2. 选择 `observer-hub_<ver>_linux_<arch>.tar`，导入；
3. 对 agent tar 重复一次；
4. 确认映像列表出现 `observer-hub:<ver>`、`observer-agent:<ver>`。

**方式 B：SSH**

```bash
sudo docker load -i /volume1/docker/observer-hub_<ver>_linux_<arch>.tar
sudo docker load -i /volume1/docker/observer-agent_<ver>_linux_<arch>.tar
sudo docker image inspect observer-hub:<ver> --format '{{.Architecture}}'
sudo docker image inspect observer-agent:<ver> --format '{{.Architecture}}'
```

架构必须与 NAS 一致；不一致时容器会报 `exec format error`。

## 4. 创建项目目录

在 File Station 或 SSH 创建目录，例如：

```
/volume1/docker/observer-agent/
├── docker-compose.yml      # 从 deploy/synology/ 复制
├── agent.yaml              # cp agent.example.yaml agent.yaml
└── （可选）其他说明文件
```

`docker-compose.yml` 里的相对路径 `./agent.yaml` 以**项目目录**为基准，所以两个文件必须放在一起。

## 5. 配置 hub 与 agent

### 5.1 hub

编辑 `docker-compose.yml`：

- `OBSERVER_ADMIN_PASSWORD`：改成自己的管理员口令（不要保留 `change-me-please`）；
- `8787:8787`：如果端口被占用，改成如 `18787:8787`；
- `observer-hub-data:/data`：保留命名卷，升级/重启不丢 SQLite 和修复中转数据；
- `/data` 必须能被容器用户（默认 uid 1000 / `node`）写入。如果改成共享文件夹 bind mount，请先看 [§10.1 hub 数据目录权限](#101-hub-数据目录权限sqlite_cantopen)。

### 5.2 生成 agent token

启动 hub 后，浏览器打开 `http://<nas-ip>:8787`，登录：

1. 进入「机器与挂载点」；
2. 点击「注册新机器」；
3. 可选填机器 ID 提示（与 `agent.yaml` 的 `machine_id` 一致更清晰）；
4. 复制一次性 token（只显示一次）。

> 已有节点可不重新注册：在机器行点「获取接入 token」，把长期 token 填到 `agent.yaml` 的 `token`。
>
> 全栈 compose 首次启动时，可先只启动 hub（或暂时停用 agent service），拿到 token 填进 `agent.yaml` 后再启动 agent；否则 agent 会因 token 占位符反复重启。

### 5.3 agent.yaml

```bash
cd /volume1/docker/observer-agent
cp agent.example.yaml agent.yaml
```

至少修改：

```yaml
agent:
  machine_id: synology-nas       # 唯一 ID，字母/数字/中划线/下划线
  label: Synology NAS
  hub: http://hub:8787           # 全栈 compose；仅 agent 时改为 http://<hub-ip>:8787
  token: "<粘贴上一步的 token>"
  state_dir: /var/lib/observer   # 只读根文件系统下必须显式指定
```

要点：

- `hub` **不能写 `127.0.0.1`**：容器里的 localhost 是它自己。全栈项目用服务名 `hub`；hub 在别处用局域网 IP/域名。
- `state_dir` 必须是可写卷；模板已挂 `observer-agent-state:/var/lib/observer`。
- 推荐内联 `token`；如果改用 `OBSERVER_ENROLL_TOKEN` 环境变量，**必须同时显式配置 `token_file: /var/lib/observer/token`**，否则默认的 `.observer/token` 会写到只读根目录导致注册成功后保存失败。
- `agent.yaml` 含 token，权限建议 0644（容器内 UID 65532 要能读）；不要设成 `0600 root`。文件已被仓库 `.gitignore` 忽略，不要提交。

## 6. 路径映射（重点）

### 6.1 默认：同路径映射

模板默认：

```yaml
volumes:
  - /volume1/photo:/volume1/photo:ro
```

对应 `agent.yaml`：

```yaml
mounts:
  - id: photos
    path: /volume1/photo
    sentinel: .observer-mount
```

优点：Web 控制台显示的物理路径就是 NAS 真实路径，复制路径去 File Station/SSH 排障不会错。

### 6.2 备选：翻译映射

```yaml
volumes:
  - /volume1/photo:/media/photos:ro
```

对应 agent：

```yaml
mounts:
  - id: photos
    path: /media/photos
```

适合希望容器内路径与 NAS 布局解耦的场景；注意 Web 显示的是 `/media/photos` 而不是 `/volume1/photo`。

### 6.3 新增/删除共享文件夹

新增一个 `/volume1/video`：

1. compose 加一条：
   ```yaml
   - /volume1/video:/volume1/video:ro
   ```
2. `agent.yaml` 加一个 mount 块：
   ```yaml
   - id: video
     label: 视频
     path: /volume1/video
     sentinel: .observer-mount
     read_only: true
     repair_allowed: false
     exclude: ["**/.observer-mount", "**/@eaDir/**", "**/#recycle/**"]
   ```
3. 在共享文件夹根目录创建 sentinel（见下一节）；
4. **重启 agent 容器**（Container Manager 项目停止/启动，或 `docker compose up -d`）；
5. agent 启动时才会把挂载点同步给 hub；之后在 Web 里手动触发一次全量巡检建立基线。

删除时反向操作：从 compose/agent.yaml 删除，重启；hub 会把挂载点软删除并保留历史数据。

规则与坑：

- 路径不能互相包含（如 `/volume1/photo` 和 `/volume1/photo/2024` 同时配置会启动失败）；用 include/exclude 解决。
- **不要在同一个 `id` 下直接换物理目录**：基线与新目录会错配；请用新 id，或先在 Web 处理旧挂载点。
- 每个共享文件夹一条 volume + 一个 mount，一一对应。

### 6.4 sentinel 必须放在共享盘内

```bash
echo "mount_id=photos" | sudo tee /volume1/photo/.observer-mount
sudo chmod 644 /volume1/photo/.observer-mount
```

- sentinel 是挂载守卫：共享盘未挂载、加密共享文件夹未解锁、盘符错误或目录被清空时，agent 跳过巡检，**不产生 missing 误报**。
- 必须放在**共享文件夹根目录**。不要从项目目录把一个 sentinel 文件 bind 到 `/volume1/photo/.observer-mount`——那样即使共享盘没挂载，sentinel 仍然存在，守卫就失效了。
- sentinel 本身要排除出扫描规则（模板已包含 `**/.observer-mount`）。

### 6.5 群晖特殊目录

模板默认排除：

- `@eaDir`：缩略图/索引目录；
- `#recycle`：回收站；
- `@Recently-Snapshot`、`#snapshot`：快照相关；
- `.observer-quarantine`：修复隔离目录（本部署不建议开启修复）。

如果你的共享文件夹还有其它系统目录，按需加到 `exclude`。

### 6.6 USB / 外接盘

外接盘通常在 `/volumeUSB1/usbshare` 之类路径：

```yaml
volumes:
  - /volumeUSB1/usbshare:/volumeUSB1/usbshare:ro
```

```yaml
mounts:
  - id: usb
    path: /volumeUSB1/usbshare
    fs_kind: removable
    sentinel: .observer-mount
```

## 7. 启动与首次基线

- Container Manager → 项目 → 新增 → 选择 `/volume1/docker/observer-agent` 或上传 `docker-compose.yml`；
- 启动后看 hub 与 agent 日志；
- 可选自检：`doctor` 会打开并独占状态缓存，**必须在 agent 停止时运行**；在运行中的容器里 `docker exec ... doctor` 会报 `open state cache: timeout`。可先停止项目，再用同一镜像跑一次性容器（挂载相同 `agent.yaml`、媒体和状态卷）执行：
  ```bash
  sudo docker run --rm --network <项目网络> \
    -v /volume1/docker/observer-agent/agent.yaml:/etc/observer/agent.yaml:ro \
    -v /volume1/photo:/volume1/photo:ro \
    -v <项目名>_observer-agent-state:/var/lib/observer \
    observer-agent:<ver> doctor -config /etc/observer/agent.yaml
  ```
  期望输出 `doctor ok: machine=... hub=... mounts=N`。也可以跳过 doctor，直接看启动日志与 Web 在线状态；
- 浏览器登录 hub，确认机器在线、挂载点物理路径正确；
- 在挂载点页手动触发一次**全量巡检**建立基线；
- 之后 hub 的自动调度才会生效（调度窗口按 **hub 本地时间**计算）。

## 8. 权限与属主

- agent 以 distroless `nonroot`（UID/GID 65532）运行，容器根文件系统只读，只有 `/var/lib/observer` 卷可写。
- 共享文件夹默认权限通常允许读取；若报 `permission denied` / `root not listable`：
  - 优先给扫描目录补读权限：`sudo chmod -R o+rX /volume1/photo`；
  - 若启用了 DSM「高级权限 / Windows ACL」，POSIX 位可能不够；可把 compose 的 `user:` 改成某个 DSM 用户（`id <user>` 查看 UID/GID）；
  - **改 `user:` 后状态卷属主也要同步**，否则 `/var/lib/observer` 写不进去。最简单是保持默认 65532。
- `agent.yaml` 和 sentinel 需 65532 可读（一般 0644）。
- 不建议在 NAS 上设 `repair_allowed: true`：修复会写共享文件夹并创建 quarantine，且需要可写挂载。

## 9. 运维

### 升级

1. 下载/导入新版本 hub/agent tar；
2. 修改 compose 中两个 `image:` tag；
3. Container Manager 项目「停止 → 构建/启动」（或 `docker compose up -d`）；
4. 状态卷保留，token/cache/spool 不丢；hub 的 SQLite 迁移在启动时自动执行。

### 备份

- hub：备份 `observer-hub-data` 卷（`/data/observer.db`，WAL 模式建议停机或 `sqlite3 .backup`）；`transfers/` 可丢弃。
- agent：`observer-agent-state` 卷保存 token/cache/spool；丢失后需要重新生成 token（Web「获取接入 token」），缓存会重建。

### 日志

- Container Manager 容器日志页，或 SSH `sudo docker logs <container>`；
- compose 已配置 json-file 轮转（10 MiB × 3）；若你的 Container Manager 版本不接受 `logging.options`，删掉该段即可。

### 开机自启

- `restart: unless-stopped` + Container Manager 套件自启即可；重启 NAS 后确认项目自动启动。

## 10. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `exec format error` | 镜像架构与 NAS 不一致 | 按 `uname -m` 重新下载/导入 |
| `permission denied` / `root not listable` | 65532 无读权限或 ACL | 补 `o+rX`，或改 `user:` 并同步状态卷属主 |
| `sentinel missing` / `does not contain mount id` | 文件未建/内容不对/共享盘未解锁 | 在共享根目录创建并检查内容 |
| `/etc/observer/agent.yaml` 是目录 | 项目目录缺 `agent.yaml`，Docker 自动建了目录 | 放入真实文件后重建容器 |
| `read-only file system` / `mkdir /var/lib/observer` | 没挂状态卷，或 `state_dir` 用了默认相对路径 | 挂命名卷并显式 `state_dir: /var/lib/observer` |
| `agent not enrolled` / 401 | token 过期/已用/机器不匹配/状态卷丢失 | 重新生成注册 token 或「获取接入 token」 |
| 连不上 hub | 写了 `127.0.0.1`；hub 未监听 0.0.0.0；防火墙 | 用服务名或 LAN IP；hub 设 `OBSERVER_HOST=0.0.0.0` |
| x509 证书错误 | hub 使用自签名证书 | 换受信任证书，或挂载自定义 CA 并设置 `SSL_CERT_FILE` |
| Web 看不到新挂载点 | 改配置后没重启；id 写错；路径重叠 | 重启 agent，看启动日志 |
| `doctor` 报 `open state cache: timeout` | agent 正在运行并占用 bbolt 缓存 | 停止 agent 后用一次性容器运行 doctor |
| 调度不跑 | 没有基线/不在窗口/mount 非 active | 手动全量巡检建基线；窗口按 hub 时区 |
| `@eaDir`/回收站大量文件 | 未排除 | 使用模板 exclude |
| `SQLITE_CANTOPEN` / `unable to open database file` | `/data` 对容器用户不可写 | 见 [§10.1](#101-hub-数据目录权限sqlite_cantopen) |

### 10.1 hub 数据目录权限（SQLITE_CANTOPEN）

hub 启动时报：

```text
SqliteError: unable to open database file
code: 'SQLITE_CANTOPEN'
at openDb (file:///app/hub/dist/db/index.js:...)
```

含义：**容器内 `/data` 目录不允许 hub 进程（默认 uid 1000 / `node`）创建 SQLite 文件**。常见原因：

- 把共享文件夹 bind mount 到 `/data`，目录属主是 `root` 或你的 DSM 用户（如 1026），权限 755；
- 挂载是只读（`:ro`）；
- `OBSERVER_DATA_DIR` 指向不存在的子目录，且父目录不可写；
- 之前手工 `docker volume create` 过同名卷，里面已有 root 属主内容，Docker 不会重新继承镜像属主。

先确认现状（`observer-hub:1.1.1` 起报错信息会直接给出 uid 和路径）：

```bash
# 看容器真实挂载
sudo docker inspect <hub-container> --format '{{json .Mounts}}'

# 用同一镜像探测目录是否可写（换成你的卷/目录）
sudo docker run --rm -v observer-hub-data:/data --entrypoint sh \
  observer-hub:1.1.1 -c 'id; ls -ld /data; touch /data/.probe && echo writable'
```

修复方式任选其一：

**A. 改目录属主（推荐，共享文件夹场景）**

```bash
sudo chown -R 1000:1000 /volume1/docker/observer/data
```

若启用了 DSM「高级权限 / Windows ACL」，还要在 File Station → 属性 → 权限里确认对应 UID 有读写，可用 `sudo synoacltool -get /volume1/docker/observer/data` 查看。

**B. 让 hub 用你的 DSM 用户运行**

```yaml
services:
  hub:
    user: "1026:100"   # 用 SSH 的 id -u / id -g 替换
```

该 UID 必须能写该目录（同 A 的权限要求）。

**C. 自动修正（`v1.1.1` 起）**

```yaml
services:
  hub:
    user: "0:0"
    environment:
      OBSERVER_FIX_DATA_PERMISSIONS: "1"
```

入口脚本会先 `chown /data`，再降权到 `node` 启动；hub 主进程仍是非 root。前提：`/data` 里没有需要保留的其他属主。

**D. 回到命名卷（模板默认）**

```yaml
volumes:
  - observer-hub-data:/data
```

Docker 首次创建空卷时会继承镜像内 `/data` 的 `1000:1000`。如果这个卷是之前用别的配置创建、里面已有 root 文件，需要先备份数据再重建卷：

```bash
sudo docker run --rm -v observer-hub-data:/from -v /volume1/docker/observer-backup:/to \
  alpine sh -c 'cp -a /from/. /to/'
sudo docker volume rm observer-hub-data   # 确认备份后再执行
```

> `v1.1.0` 及更早版本只会抛原始 SQLite 错误；`v1.1.1` 起会在错误里给出数据目录、运行 UID，以及上述修复提示。

## 11. 从源码构建（可选，不推荐在 NAS 上做）

如果不想用 Release 镜像，也可以在有 Docker 的机器上构建并导出：

```bash
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.hub -t observer-hub:1.1.1 --load .
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.agent -t observer-agent:1.1.1 --load .
docker save -o observer-hub_1.1.1_linux_amd64.tar observer-hub:1.1.1
docker save -o observer-agent_1.1.1_linux_amd64.tar observer-agent:1.1.1
```

arm64 把 `linux/amd64` 改为 `linux/arm64`。构建 hub/agent 需要访问 Docker Hub 与 gcr.io；国内网络可能失败，因此优先使用 Release 资产。

## 12. 限制与验证状态

- 仅支持 x86_64 / arm64；不提供 ARMv7 镜像。
- NAS 上默认只读、非 root、修复禁用；跨机修复建议只在普通服务器上启用。
- 本文与 compose 模板已做静态校验；镜像由 CI 构建；**尚未在真实群晖 Container Manager 上完成导入/运行验收**。首次发布后请按 [RELEASE](RELEASE.md) 与本文步骤做一次真机验证。
