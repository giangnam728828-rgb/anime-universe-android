#!/bin/sh
# 测试运行脚本（本项目专用）
#
# 为什么需要这个脚本：
#   本仓库位于 /sdcard（FAT32），**不支持符号链接**。
#   `npm install` 必须为 `media3-player: file:./native-plugins/media3-player`
#   建立 symlink -> 在 FAT32 上必然 EACCES 失败。
#   因此仓库内无法生成 node_modules，`npm test` 会报 vitest: not found。
#
# 本脚本的做法：
#   优先用仓库内 node_modules（正常 Linux 开发机 / GitHub CI）；
#   找不到时回退到 /tmp/au-test/node_modules（本机影子副本）。
#
# 在正常的 Linux 开发机或 CI 上：
#   npm install && npm test      <- 直接可用，不需要本脚本
#
# 用法：sh scripts/run-tests.sh [额外的 vitest 参数]

REPO=$(cd "$(dirname "$0")/.." && pwd)

if [ -x "$REPO/node_modules/.bin/vitest" ]; then
  VITEST="$REPO/node_modules/.bin/vitest"
elif [ -x /tmp/au-test/node_modules/.bin/vitest ]; then
  VITEST=/tmp/au-test/node_modules/.bin/vitest
  echo "[run-tests] 仓库无 node_modules，回退到 /tmp/au-test（FAT32 不支持 symlink）" >&2
else
  echo "[run-tests] 未找到 vitest。请先运行: npm install" >&2
  exit 1
fi

cd "$REPO" && exec "$VITEST" run --config vitest.config.ts "$@"
