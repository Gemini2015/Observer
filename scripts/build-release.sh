#!/usr/bin/env bash
# 构建 observer-agent 发布产物：linux/amd64、linux/arm64、windows/amd64 + SHA256SUMS。
#
# 用法:
#   scripts/build-release.sh <version> [outdir]
#
#   version  发布版本（v0.1.0 或 0.1.0，v 前缀会被去掉），写入二进制 version
#   outdir   输出目录，默认 dist/release（相对仓库根目录）
#
# 环境要求: go、tar、zip（zip 仅 windows 产物需要）
set -euo pipefail

LC_ALL=C
export LC_ALL

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <version> [outdir]" >&2
  exit 2
fi

raw_version="$1"
version="${raw_version#v}"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: invalid version '$raw_version' (want v0.1.0 or 0.1.0)" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/.." && pwd)"

outdir_arg="${2:-dist/release}"
case "$outdir_arg" in
  /*) outdir="$outdir_arg" ;;
  *) outdir="$root/$outdir_arg" ;;
esac

for tool in go tar zip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: missing required tool '$tool'" >&2
    exit 1
  fi
done

for f in agent/go.mod agent/cmd/observer-agent deploy/agent.example.yaml deploy/observer-agent.service; do
  if [[ ! -e "$root/$f" ]]; then
    echo "error: missing required path '$f'" >&2
    exit 1
  fi
done

rm -rf "$outdir"
mkdir -p "$outdir"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

ldflags="-s -w -X observer/agent/internal/version.Version=${version}"

build_target() {
  local goos="$1" goarch="$2"
  local bin="observer-agent"
  local pkgdir="$workdir/${goos}-${goarch}"
  [[ "$goos" == "windows" ]] && bin="observer-agent.exe"
  mkdir -p "$pkgdir"

  echo "==> build ${goos}/${goarch}"
  (
    cd "$root/agent"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -buildvcs=false -ldflags "$ldflags" \
      -o "$pkgdir/$bin" ./cmd/observer-agent
  )

  cp "$root/deploy/agent.example.yaml" "$pkgdir/agent.example.yaml"
  if [[ "$goos" == "linux" ]]; then
    cp "$root/deploy/observer-agent.service" "$pkgdir/observer-agent.service"
    archive="$outdir/observer-agent_${version}_${goos}_${goarch}.tar.gz"
    tar -czf "$archive" -C "$pkgdir" observer-agent agent.example.yaml observer-agent.service
  else
    archive="$outdir/observer-agent_${version}_${goos}_${goarch}.zip"
    ( cd "$pkgdir" && zip -q -9 "$archive" observer-agent.exe agent.example.yaml )
  fi
  echo "    -> $(basename "$archive")"
}

echo "==> observer-agent ${version}"
build_target linux amd64
build_target linux arm64
build_target windows amd64

echo "==> verify version injection"
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  got="$("$workdir/linux-amd64/observer-agent" version)"
  if [[ "$got" != "$version" ]]; then
    echo "error: built binary reports '$got', expected '$version'" >&2
    exit 1
  fi
  echo "    linux/amd64 reports: $got"
else
  echo "    skip (host $(uname -s)/$(uname -m) cannot execute linux/amd64 binary)"
fi

echo "==> checksums"
(
  cd "$outdir"
  sha256sum -- *.tar.gz *.zip >SHA256SUMS
  sha256sum -c SHA256SUMS
)

echo "==> artifacts"
if command -v file >/dev/null 2>&1; then
  file "$workdir/linux-amd64/observer-agent" \
    "$workdir/linux-arm64/observer-agent" \
    "$workdir/windows-amd64/observer-agent.exe"
fi
ls -l "$outdir"
