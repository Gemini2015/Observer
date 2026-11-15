# 发布（agent、桌面端与 Docker 镜像）

> 关联：[部署与打包](DEPLOY.md)、[群晖 Container Manager](DEPLOY-SYNOLOGY.md)、[快速开始](QUICKSTART.md)。本页描述「手动打 tag → GitHub Actions 自动构建并发布 Release」的流程。

## 1. 触发方式

- **tag 由开发者手动创建并推送**；workflow 只在 tag push 时运行，不创建、不移动、不删除任何 tag。
- tag 命名：`vMAJOR.MINOR.PATCH[-prerelease]`，例如 `v1.0.0`、`v1.1.0-rc.1`；带 `-` 的 tag 会自动标记为 pre-release。
- 必须把 workflow 文件合入 `main` 后，再从包含它的提交打 tag（tag 若指向没有 workflow 的提交不会触发）。
- 里程碑 tag（`m1`–`m4`）不匹配 `v*.*.*`，不会触发。

```bash
# 正式发布（示例为下一个版本号；当前最新正式版为 v1.2.0）
git tag -a v1.3.0 -m "Observer v1.3.0"
git push origin v1.3.0
```

发布版本 = tag 去掉 `v` 前缀，通过 `-ldflags "-X observer/agent/internal/version.Version=<ver>"` 写入 CLI、桌面端二进制与 agent 镜像，
因此 `observer-agent version`（二进制或容器内）与桌面端状态页/设置页输出发布版本（仓库默认值 `1.2.0`，发布时仍按 tag 覆盖）。

同一次发布还会：
- 构建 Windows 桌面端（Wails v3）`observer-agent-desktop_<ver>_windows_amd64.zip`，解压后双击 `observer-agent-desktop.exe` 运行；
- 构建 hub/agent 的 **linux/amd64** 与 **linux/arm64** Docker 镜像，以 `docker save` 的 Docker archive tar 附到 Release，供群晖 Container Manager 等离线导入；**不推 Docker Hub/GHCR**。

## 2. workflow 流程

`.github/workflows/release.yml`（触发条件 `push` tags `v*.*.*`）：

1. **校验 tag**：严格匹配 `vX.Y.Z[-pre]`，不匹配直接失败（不会构建、不会发 Release）；
2. **安装 Go**：版本取自 `agent/go.mod`（`actions/setup-go`，缓存 `agent/go.sum`）；
3. **测试门禁**：`cd agent && go test ./...`；
4. **构建打包 CLI**：`bash scripts/build-release.sh "$VERSION" dist/release`；
5. **发布 Release**：`softprops/action-gh-release@v2` 创建/更新 Release，自动生成 release notes，上传 3 个 CLI 归档与 `SHA256SUMS`；
6. **构建 Windows 桌面端**：`desktop` job 在 `windows-latest` 上安装 Go（`agent/desktop/go.mod`）、Node 24 与 `wails3 v3.0.0`，执行 `pwsh scripts/build-desktop-release.ps1 -Version "$VERSION" -OutDir dist/desktop`；脚本会构建前端、生成 bindings/syso、以 `-H windowsgui` 和版本 ldflags 构建 exe，断言 PE `Subsystem=2`、版本字符串与 zip 内容；随后跑 `go test .`/`go vet .`/`npm test`，`gh release upload` 上传桌面端 zip；
7. **构建 Docker 镜像**：`docker` job matrix（hub/agent × amd64/arm64）用 Buildx 构建，arm64 在 QEMU 下执行；每个镜像做架构断言、agent `version` 冒烟或 hub `/healthz` 冒烟；
8. **导出并上传镜像**：`docker save` 成 `.tar`，`docker load` 回归确认是 Docker archive，校验大小 < 2 GiB，`gh release upload` 把 tar 和同名 `.sha256` 上传到同一 Release；
9. **汇总镜像校验和**：`docker-checksums` job 汇总 4 个 tar 的 SHA-256，上传 `SHA256SUMS-docker`；
10. **合并二进制校验和 + Release 说明**：`finalize-release` job 依赖 release 与 desktop，按版本号从 Release 下载 4 个二进制归档并重新计算 SHA-256 生成 `SHA256SUMS`（以实际发布文件为准；`desktop` 失败则不执行，避免说明里出现不存在的资产），再把「下载哪个包」指引 prepend 到 Release 正文（以该标题作为已存在标记，重跑幂等）。

权限：workflow 声明 `contents: write`；同一 tag 的发布串行（concurrency）。桌面端、镜像或 finalize job 失败时 workflow 为红；重跑会覆盖同名资产。`SHA256SUMS` 只在桌面端成功后才会包含 GUI 归档；桌面端失败时 Release 仍有 3 个 CLI 归档，重跑即可补齐。

## 3. 产物

| 资产 | 内容 |
| --- | --- |
| `observer-agent_<ver>_linux_amd64.tar.gz` | `observer-agent`、`agent.example.yaml`、`observer-agent.service` |
| `observer-agent_<ver>_linux_arm64.tar.gz` | 同上（arm64） |
| `observer-agent_<ver>_windows_amd64.zip` | **命令行版**：`observer-agent.exe`、`agent.example.yaml`、`README-WINDOWS.txt`；双击不会启动服务 |
| `observer-agent-desktop_<ver>_windows_amd64.zip` | **桌面 GUI**：`observer-agent-desktop.exe`、`README-WINDOWS.txt`；解压后双击运行，需要 WebView2 Runtime |
| `observer-hub_<ver>_linux_amd64.tar` | hub Docker 镜像（Docker archive，导入后 tag `observer-hub:<ver>`） |
| `observer-hub_<ver>_linux_arm64.tar` | hub Docker 镜像（arm64） |
| `observer-agent_<ver>_linux_amd64.tar` | agent Docker 镜像（Docker archive，导入后 tag `observer-agent:<ver>`） |
| `observer-agent_<ver>_linux_arm64.tar` | agent Docker 镜像（arm64） |
| `SHA256SUMS` | 上述 4 个二进制归档的 SHA-256（桌面端成功构建后由 finalize job 补齐） |
| `<镜像资产>.sha256` | 每个镜像 tar 对应的单独校验和 |
| `SHA256SUMS-docker` | 上述 4 个镜像 tar 的合并校验和 |

CLI 二进制为 `CGO_ENABLED=0` 纯静态；Linux 版 `ldd` 显示 not a dynamic executable。桌面端通过 `-H windowsgui` 生成 GUI 子系统 exe，未做代码签名。

Docker 镜像仅发布 amd64/arm64，不发布 ARMv7；镜像 tag 使用去掉 `v` 的版本号（如 `1.2.0`），不使用 `latest`。

## 4. 校验下载的产物

```bash
sha256sum -c SHA256SUMS
tar -tzf observer-agent_1.2.0_linux_amd64.tar.gz        # 查看内容
tar -xzf observer-agent_1.2.0_linux_amd64.tar.gz
./observer-agent version                                 # 输出 1.2.0
```

Windows（命令行版）：解压 `observer-agent_<ver>_windows_amd64.zip` 后，在 PowerShell 执行 `.\observer-agent.exe version`，应输出同一版本号；双击 exe 只会打印用法并退出，这是预期行为，不是崩溃。

Windows（桌面 GUI）：解压 `observer-agent-desktop_<ver>_windows_amd64.zip`，双击 `observer-agent-desktop.exe`：

- 有 WebView2 Runtime 的 Win10 1803+/Win11 应直接打开配置向导或主窗口；
- 没有 WebView2 时应弹出中文错误框，给出安装地址与日志路径，而不是闪退；
- 日志：`%LocalAppData%\Observer\observer-agent-desktop.log`；
- 可校验 PE 子系统为 GUI（PowerShell）：

```powershell
$b=[IO.File]::ReadAllBytes(".\observer-agent-desktop.exe"); $pe=[BitConverter]::ToInt32($b,0x3C)
[BitConverter]::ToUInt16($b,$pe+24+68)   # 2 = GUI, 3 = 控制台
```

`SHA256SUMS` 同时覆盖 CLI 与桌面端归档（桌面端成功构建后），下载后执行 `sha256sum -c SHA256SUMS`。

Docker 镜像：

```bash
# 只下载当前架构时，用同名 .sha256 校验（或给合并文件加 --ignore-missing）
sha256sum -c observer-hub_1.2.0_linux_amd64.tar.sha256
sha256sum -c observer-agent_1.2.0_linux_amd64.tar.sha256

docker load -i observer-hub_1.2.0_linux_amd64.tar
docker load -i observer-agent_1.2.0_linux_amd64.tar
docker image inspect observer-hub:1.2.0 --format '{{.Architecture}}'
docker image inspect observer-agent:1.2.0 --format '{{.Architecture}}'

docker run --rm observer-agent:1.2.0 version
```

如果下载了全部 4 个镜像，也可以 `sha256sum -c SHA256SUMS-docker`。

- 架构必须与目标机器一致；群晖导入步骤见 [DEPLOY-SYNOLOGY](DEPLOY-SYNOLOGY.md)。
- 镜像 tar 是未压缩的 Docker archive；`docker load` 也接受 gzip 压缩流，但群晖 UI 建议直接使用未压缩 `.tar`。
- 镜像只分发文件，不要求 Docker Hub 账号。

## 5. 本地预演（不推 tag）

```bash
# 方案 A：开发机已装 Go（tar/zip 可用）
bash scripts/build-release.sh v1.2.0 dist/release

# 方案 B：没有 Go 时用容器（产物写入仓库 dist/release，gitignore 范围）
docker run --rm -v "${PWD}:/src" -w /src golang:1.27-bookworm \
  bash -lc 'apt-get update -qq && apt-get install -y -qq zip >/dev/null && \
            bash scripts/build-release.sh v1.2.0 /src/dist/release'
```

脚本会自检：linux/amd64 产物 `version` 输出必须等于传入版本，并生成、校验 `SHA256SUMS`。

Windows 桌面端本地预演（需要 Windows x64、Go、Node.js、wails3 v3.0.0）：

```powershell
pwsh scripts/build-desktop-release.ps1 -Version 1.2.0 -OutDir dist/release
```

脚本会构建前端与 bindings、生成 Windows 资源（syso）、以 `-H windowsgui` 和版本 ldflags 构建 exe，并校验 PE 子系统、版本字符串与 zip 内容；产物为 `observer-agent-desktop_1.2.0_windows_amd64.zip` 和同名 `.sha256`。CI 中由 `desktop` job 做同样的事。

本地构建/导出 Docker 镜像（需要 Docker + buildx）：

```bash
VERSION=1.2.0
docker buildx build --platform linux/amd64 \
  --build-arg VERSION="$VERSION" --build-arg REVISION="local" \
  -f deploy/Dockerfile.hub -t "observer-hub:$VERSION" --load .
docker buildx build --platform linux/amd64 \
  --build-arg VERSION="$VERSION" --build-arg REVISION="local" \
  -f deploy/Dockerfile.agent -t "observer-agent:$VERSION" --load .

docker save -o "observer-hub_${VERSION}_linux_amd64.tar" "observer-hub:$VERSION"
docker save -o "observer-agent_${VERSION}_linux_amd64.tar" "observer-agent:$VERSION"
docker load -i "observer-hub_${VERSION}_linux_amd64.tar"   # 回归确认是 Docker archive
```

国内网络可在 agent 构建时加 `--build-arg GOPROXY=https://goproxy.cn,direct`，hub 构建时加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com/`。如果构建环境无法访问 Debian 镜像，hub 再加 `--build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn`；若 `better-sqlite3` prebuild 下载失败，加 `--build-arg BUILD_FROM_SOURCE=1` 强制源码编译（会自动安装 python3/make/g++ 兜底）。

首次启用本流程时，建议先推一个临时预发布 tag（如 `v0.0.0-rc.2`）验证 Actions 与 Release 资产（含 4 个镜像 tar），再删除该 tag/Release，避免占用正式版本号。

## 6. 重跑与回滚

- **重跑**：Actions → 选中 run →「Re-run all jobs」。同名 tag 重跑会更新同一个 Release，资产同名覆盖。
- **删除发布**：先删除 GitHub Release（页面），再删除远端 tag：
  ```bash
  git push origin :refs/tags/v1.3.0
  ```
- 已经分发的版本号不要复用；修正问题请发新的 patch 版本。

## 7. 权限与前提

- 仓库 Settings → Actions → General：Actions 需启用；Workflow permissions 允许 `contents: write`（workflow 已显式声明该权限；若组织策略锁定为只读，需管理员放开）。
- 私有仓库会消耗 Actions 分钟数：CLI 二进制 job 约 1–2 分钟；Windows 桌面端 job（含 npm/Go 依赖与 Wails 构建）约 5–10 分钟，Windows runner 按 2 倍分钟计费；4 个 Docker 镜像 job 首次约 20–40 分钟（arm64 在 QEMU 下更慢，缓存命中后明显缩短）。
- 发布者需具备 tag push 权限。
- Docker Hub 基础镜像拉取可能触发匿名限流；失败可重跑，后续可配置 registry 登录 secret。

## 8. 平台范围与扩展

- 当前覆盖：`linux/amd64`、`linux/arm64`、`windows/amd64` 命令行二进制，Windows/amd64 桌面 GUI（zip），以及 `linux/amd64`、`linux/arm64` 的 hub/agent Docker 镜像（见 [DEPLOY §7](DEPLOY.md#7-本机验证状态)）。
- 扩展 CLI 平台：在 `scripts/build-release.sh` 里增加一行 `build_target <os> <arch>` 并验证产物；桌面端扩展平台需同步修改 `scripts/build-desktop-release.ps1` 和 `desktop` job。
- **不在本流程范围**：hub/web 单元测试、推送 Docker Hub/GHCR、多架构 manifest 合并、代码签名/Authenticode、NSIS/MSIX 安装包、WebView2 bootstrapper 自动安装、macOS 签名公证、armv7 产物、自动打 tag、版本号自动 bump。
- 桌面端以未签名 zip 分发，首次运行可能出现 SmartScreen「未知发布者」；从 Release 下载并核对 `SHA256SUMS`。

## 9. 发布记录

- 2026-11-11：推送临时预发布 tag `v0.0.0-rc.1` 试发布通过（流水线验证用）。
  - Actions run `Release agent`（run 42970564475）成功；
  - GitHub Release 为 **pre-release**，标题 `observer-agent v0.0.0-rc.1`，含 3 个归档 + `SHA256SUMS`；
  - 下载资产 `sha256sum -c` 全部通过（与 GitHub 页面 digest 一致）；
  - linux/amd64 二进制为静态 ELF，`observer-agent version` 输出 `0.0.0-rc.1`；windows zip 内容为 `observer-agent.exe` + `agent.example.yaml`。
- 2026-11-11：正式发布 `v1.0.0`（tag 指向 `05d393e`）。
  - Actions run `Release agent`（run 42971796798）成功；
  - GitHub Release 标题 `observer-agent v1.0.0`，标记 **Latest**（非 pre-release），含 3 个归档 + `SHA256SUMS`；
  - 下载资产 `sha256sum -c` 全部通过，linux/amd64 `observer-agent version` 输出 `1.0.0`，静态链接检查通过。
- `v0.0.0-rc.1` 仅用于流水线验证，可在 Release 页面删除；正式版本始终由开发者按 §1 手动打 `vX.Y.Z` tag。
- 2026-11-15：发布 `v1.1.0`（tag 指向 `3ca4a59`；同一天因 hub 冒烟测试绑定地址问题修复后重新指向修复提交）。
  - Actions run `43698923356` 成功；首次 run `43698024317` 的 hub 镜像冒烟因容器内监听 `127.0.0.1` 无法通过端口映射访问而失败，改为 `0.0.0.0` 后重跑通过。
  - GitHub Release 标题 `Observer v1.1.0`，非 pre-release；包含 3 个二进制归档 + `SHA256SUMS`，以及 4 个镜像 tar + 各自 `.sha256` + `SHA256SUMS-docker`。
  - 下载 agent amd64 tar 校验通过：`manifest.json` 的 RepoTags 为 `observer-agent:1.1.0`，配置架构 amd64，labels version `1.1.0`。
  - hub 镜像 tar 大小 360/377 MB（amd64/arm64），均低于 GitHub 2 GiB 限制；CI 已用 `docker load` 回归 Docker archive。
- 2026-11-15：发布 `v1.1.1`（tag `d316f86`），修复群晖 hub 容器数据目录不可写时只抛 `SQLITE_CANTOPEN` 的问题。
  - Actions run `43704101911` 全部 job 成功；资产与 v1.1.0 结构相同（3 个二进制归档 + `SHA256SUMS`、4 个镜像 tar + 各自 `.sha256` + `SHA256SUMS-docker`）。
  - 下载 `observer-hub_1.1.1_linux_amd64.tar` 校验通过：config `User=node`、`Entrypoint=/usr/local/bin/docker-entrypoint.sh`、labels version `1.1.1`；顶层 layer 为新增入口脚本，`hub/dist/db/index.js` 含数据目录诊断。
  - 本地（Apple container）验证：只读挂载 `/data` 时报 `data directory is not writable: /data (running as uid=1000, gid=1000)` 并给出修复提示；`user: "0:0"` + `OBSERVER_FIX_DATA_PERMISSIONS=1` 时先 chown 再降权，`/healthz` 正常、进程 uid 为 1000。
- 2026-11-15：发布 `v1.2.0`（最终 tag `26ccda5`），首次包含 Windows 桌面端。
  - Actions run `43714299026` 全部 job 成功；前两次 run（`43713254279`、`43713966772`）的 finalize 因 job 未 checkout、`gh` 无法推断仓库而失败，补 `actions/checkout` + `GH_REPO` 后重跑通过，版本号未变。
  - 资产：3 个 CLI 归档 + `observer-agent-desktop_1.2.0_windows_amd64.zip` + `SHA256SUMS`（4 个二进制归档）；4 个镜像 tar + 各自 `.sha256` + `SHA256SUMS-docker`。
  - 下载 4 个二进制资产 `sha256sum -c SHA256SUMS` 全部通过；桌面 zip 内 exe PE 子系统为 2（GUI）、版本字符串 `1.2.0`；CLI Windows exe 为 3（控制台），zip 含 `README-WINDOWS.txt`；linux/amd64 为静态 ELF 且 `version` 为 `1.2.0`。
  - Release 正文包含「下载哪个包」指引；桌面 zip 与 CLI zip 的区别已在 README/QUICKSTART/DEPLOY 说明。
