#!/bin/sh
# Observer hub 容器入口。
#
# 默认以非 root（node，uid 1000）运行。群晖等 NAS 上如果把共享文件夹 bind mount 到
# /data，目录属主常常是 root 或 DSM 用户，容器内 node 无法写入，报
# `SQLITE_CANTOPEN: unable to open database file`。
#
# 需要自动修正时，在 compose 里以 root 启动并设置 OBSERVER_FIX_DATA_PERMISSIONS=1：
#   user: "0:0"
#   environment:
#     OBSERVER_FIX_DATA_PERMISSIONS: "1"
# 入口会 chown 数据目录后降权到 node 启动，进程本身仍是非 root。
set -eu

DATA_DIR="${OBSERVER_DATA_DIR:-/data}"
FIX_PERMISSIONS="${OBSERVER_FIX_DATA_PERMISSIONS:-0}"

if [ "$(id -u)" = "0" ]; then
  if [ "$FIX_PERMISSIONS" = "1" ]; then
    mkdir -p "$DATA_DIR"
    if chown -R node:node "$DATA_DIR" 2>/dev/null; then
      echo "observer-hub: fixed ownership of $DATA_DIR to node:node" >&2
    else
      echo "observer-hub: warning: could not chown $DATA_DIR to node:node" >&2
    fi
  fi
  # 以 node 身份运行主进程（setpriv 在 Debian/Node bookworm-slim 中可用）。
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "observer-hub: setpriv not found; refusing to run the server as root" >&2
  exit 1
fi

exec "$@"
