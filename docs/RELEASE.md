# 发布（agent）

> 关联：[部署与打包](DEPLOY.md)、[快速开始](QUICKSTART.md)。本页描述「手动打 tag → GitHub Actions 自动构建并发布 Release」的流程。

## 1. 触发方式

- **tag 由开发者手动创建并推送**；workflow 只在 tag push 时运行，不创建、不移动、不删除任何 tag。
- tag 命名：`vMAJOR.MINOR.PATCH[-prerelease]`，例如 `v1.0.0`、`v1.1.0-rc.1`；带 `-` 的 tag 会自动标记为 pre-release。
- 必须把 workflow 文件合入 `main` 后，再从包含它的提交打 tag（tag 若指向没有 workflow 的提交不会触发）。
- 里程碑 tag（`m1`–`m4`）不匹配 `v*.*.*`，不会触发。

```bash
# 正式发布（示例为下一个版本号；当前最新正式版为 v1.0.0）
git tag -a v1.1.0 -m "observer-agent v1.1.0"
git push origin v1.1.0
```

发布版本 = tag 去掉 `v` 前缀，通过 `-ldflags "-X observer/agent/internal/version.Version=<ver>"` 写入二进制，
因此 `observer-agent version` 输出发布版本（仓库默认值 `1.0.0`，发布时仍按 tag 覆盖）。

## 2. workflow 流程

`.github/workflows/release.yml`（触发条件 `push` tags `v*.*.*`）：

1. **校验 tag**：严格匹配 `vX.Y.Z[-pre]`，不匹配直接失败（不会构建、不会发 Release）；
2. **安装 Go**：版本取自 `agent/go.mod`（`actions/setup-go`，缓存 `agent/go.sum`）；
3. **测试门禁**：`cd agent && go test ./...`；
4. **构建打包**：`bash scripts/build-release.sh "$VERSION" dist/release`；
5. **发布**：`softprops/action-gh-release@v2` 创建/更新 Release，自动生成 release notes，上传产物。

权限：workflow 声明 `contents: write`；同一 tag 的发布串行（concurrency），失败即停、不产生半成品 Release。

## 3. 产物

| 资产 | 内容 |
| --- | --- |
| `observer-agent_<ver>_linux_amd64.tar.gz` | `observer-agent`、`agent.example.yaml`、`observer-agent.service` |
| `observer-agent_<ver>_linux_arm64.tar.gz` | 同上（arm64） |
| `observer-agent_<ver>_windows_amd64.zip` | `observer-agent.exe`、`agent.example.yaml` |
| `SHA256SUMS` | 上述 3 个归档的 SHA-256 |

所有二进制均为 `CGO_ENABLED=0` 纯静态；Linux 版 `ldd` 显示 not a dynamic executable。

## 4. 校验下载的产物

```bash
sha256sum -c SHA256SUMS
tar -tzf observer-agent_1.0.0_linux_amd64.tar.gz        # 查看内容
tar -xzf observer-agent_1.0.0_linux_amd64.tar.gz
./observer-agent version                                 # 输出 1.0.0
```

Windows：解压 zip 后执行 `observer-agent.exe version`，应输出同一版本号。

## 5. 本地预演（不推 tag）

```bash
# 方案 A：开发机已装 Go（tar/zip 可用）
bash scripts/build-release.sh v1.1.0 dist/release

# 方案 B：没有 Go 时用容器（产物写入仓库 dist/release，gitignore 范围）
docker run --rm -v "${PWD}:/src" -w /src golang:1.27-bookworm \
  bash -lc 'apt-get update -qq && apt-get install -y -qq zip >/dev/null && \
            bash scripts/build-release.sh v1.1.0 /src/dist/release'
```

脚本会自检：linux/amd64 产物 `version` 输出必须等于传入版本，并生成、校验 `SHA256SUMS`。

首次启用本流程时，建议先推一个临时预发布 tag（如 `v0.0.0-rc.1`）验证 Actions 与 Release 资产，再删除该 tag/Release，避免占用正式版本号。

## 6. 重跑与回滚

- **重跑**：Actions → 选中 run →「Re-run all jobs」。同名 tag 重跑会更新同一个 Release，资产同名覆盖。
- **删除发布**：先删除 GitHub Release（页面），再删除远端 tag：
  ```bash
  git push origin :refs/tags/v1.1.0
  ```
- 已经分发的版本号不要复用；修正问题请发新的 patch 版本。

## 7. 权限与前提

- 仓库 Settings → Actions → General：Actions 需启用；Workflow permissions 允许 `contents: write`（workflow 已显式声明该权限；若组织策略锁定为只读，需管理员放开）。
- 私有仓库会消耗 Actions 分钟数，本流程单次约 1–2 分钟。
- 发布者需具备 tag push 权限。

## 8. 平台范围与扩展

- 当前覆盖：`linux/amd64`、`linux/arm64`、`windows/amd64`（见 [DEPLOY §7](DEPLOY.md#7-本机验证状态) 已本机验证的范围）。
- 扩展新平台：在 `scripts/build-release.sh` 里增加一行 `build_target <os> <arch>` 并验证产物；需要签名/打包安装器的产物（桌面端 GUI、NSIS、macOS 公证）不在此流程，见 DEPLOY。
- **不在本流程范围**：hub/web 构建与测试、hub Docker 镜像发布、桌面端 GUI/安装包、macOS 签名公证、armv7 产物、自动打 tag、版本号自动 bump。

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
