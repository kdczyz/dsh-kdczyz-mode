#!/bin/bash
#
# 安装 / 恢复 Trae 反代插件（dsh-connect-trae）。
#
#   ./tools/install-trae.sh             安装到 desktop profile
#   ./tools/install-trae.sh <profile>   安装到指定 profile
#
# 优先用 DSH 插件命令从 npm 装最新版；找不到 CLI 时退回"拷贝归档副本 + 打印手动步骤"。
# 装完必须重启 DSH 才会加载（插件是 bundle，只在启动时装配）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PROFILE="${1:-desktop}"
PKG="dsh-connect-trae@3.0.0"
TARGET="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-connect-trae"

DSH_BIN="$(command -v dsh || true)"
if [ -z "$DSH_BIN" ] && [ -x "$HOME/.dsh/bin/dsh" ]; then DSH_BIN="$HOME/.dsh/bin/dsh"; fi

if [ -n "$DSH_BIN" ]; then
  echo "使用 DSH CLI: $DSH_BIN"
  "$DSH_BIN" plugin --profile "$PROFILE" add "$PKG"
  echo
  echo "装完请重启 DSH。"
  exit 0
fi

echo "没找到 dsh 命令，改为拷贝归档副本："
echo "  $ROOT/dsh-connect-trae  ->  $TARGET"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
cp -R "$ROOT/dsh-connect-trae" "$TARGET"
echo "已拷贝。"
cat <<'TIP'

但还要让 DSH 加载它 —— 二选一：

  A)（推荐）打开 DSH 的「插件」页，搜索 dsh-connect-trae 点安装，
     由 DSH 自己写 profile 的依赖与 bundles 列表。

  B) 手动改 ~/.dsh/profiles/<profile>/package.json：
     - dependencies 里加        "dsh-connect-trae": "^3.0.0"
     - dsh.profile.bundles 数组里加   "dsh-connect-trae"

无论哪种方式，最后都要重启 DSH。

装好后在 设置 → 插件 → Trae 卡片：
  国内版 tab → 点「刷新账号与 Token」→ 选账号 → 勾选要用的模型
（插件会自动发现本机的 Trae CN / TRAE SOLO CN / Trae / TRAE SOLO 登录凭据）
TIP