#!/bin/bash
#
# 把本目录里已修复、已精简的 workbuddy 插件部署到 DSH profile。
#
#   ./tools/apply.sh            部署到默认 profile（desktop）
#   ./tools/apply.sh <目录>     部署到指定插件目录
#
# 会先整目录备份，再同步，最后用 DSH 自带的 node 做语法检查。
# 部署后必须重启 DSH 才会生效（ES module 有缓存，热重载不会重新加载）。
#
# 注意：2026-10-09 起插件已改为「纯 provider」形态，控制台相关文件
# （web/ 与 lib/account-check.mjs 等 7 个模块）已从源目录删除。
# 因此本脚本用 rsync --delete 做**整目录同步**，把目标里遗留的旧文件一并清掉；
# 只拷固定几个文件的做法会留下已删除模块，导致加载报错。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC="$ROOT/archive-workbuddy"
TARGET="${1:-$HOME/.dsh/profiles/desktop/node_modules/dsh-workbuddy-console}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/.dsh/wb-console-patch-backup/$STAMP"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"

if [ ! -d "$SRC" ]; then
  echo "找不到源目录: $SRC" >&2
  exit 1
fi
if [ ! -d "$TARGET" ]; then
  echo "找不到目标插件目录: $TARGET" >&2
  echo "（插件没装？先执行 dsh plugin --profile desktop add dsh-workbuddy-console）" >&2
  exit 1
fi

# —— 整目录备份（排除 node_modules，那是 pnpm 链接不需要备份）——
mkdir -p "$BACKUP"
rsync -a --exclude 'node_modules' "$TARGET/" "$BACKUP/"
echo "已备份目标插件到: $BACKUP"

# —— 整目录同步：--delete 清掉目标里已从源删除的文件（如 web/）——
rsync -a --delete --exclude 'node_modules' "$SRC/" "$TARGET/"
echo "已同步: $SRC -> $TARGET"

# —— 语法检查（client.js 是浏览器 bundle，--check 也能解析）——
for f in lib/index.js lib/client.js lib/console.mjs lib/credit-store.mjs \
         vendor/xdpool/lib/index.js vendor/xdpool/lib/dsml-bridge.mjs; do
  if [ -f "$TARGET/$f" ]; then
    "$NODE" --check "$TARGET/$f"
  else
    echo "警告：目标缺少 $f" >&2
  fi
done
echo "语法检查通过。"

# —— 确认内联的管理页与源文件同步 ——
# client.js 里的管理页是 console.mjs 的生成副本；改了源却忘记重跑生成脚本，
# 界面上会看不到任何变化，且没有任何报错 —— 这里主动拦一下。
if ! "$NODE" "$SRC/scripts/gen-console-inline.mjs" --check; then
  echo "错误：lib/client.js 里的管理页与 lib/console.mjs 不同步" >&2
  echo "      请先运行：node $SRC/scripts/gen-console-inline.mjs" >&2
  exit 1
fi

# —— 跑单测 ——
# 三层都跑，都是硬性门禁：
#   credit-store   : 数据层（积分/历史记录的读写与去重）
#   client-apply   : **在仿浏览器环境里真正调用 client.js 的 apply**
#   console-render : **真正调用管理页组件**，覆盖三个 tab 与坏数据
#
# 后两个不能降级为警告：
#   - 2026-10-09 只测了内联工厂、没测 apply，漏掉一个未声明标识符，
#     导致 cordis fiber 变 failed、宿主弹「应用无法启动」。
#   - 同一批改动里 `?? []` 挡不住非数组返回值，渲染期抛错会让设置面板白屏，
#     而启动阶段完全正常 —— 只有真的调用组件才能发现。
run_test() {
  local file="$1" label="$2"
  if [ ! -f "$SRC/test/$file" ]; then
    echo "警告：缺少测试 $file" >&2
    return 0
  fi
  if (cd "$SRC/test" && "$NODE" "$file" >/dev/null 2>&1); then
    echo "$label 通过。"
  else
    echo "错误：$label 未通过" >&2
    echo "      请手动查看：cd $SRC/test && \"$NODE\" $file" >&2
    return 1
  fi
}

run_test credit-store.test.mjs "数据层单测" || exit 1
run_test client-apply.test.mjs "client apply 单测" || exit 1
run_test console-render.test.mjs "管理页渲染单测" || exit 1

# —— 确认控制台残留已清干净 ——
if [ -d "$TARGET/web" ]; then
  echo "警告：目标仍存在 web/ 目录，旧的独立控制台文件未清干净" >&2
  exit 1
fi
echo "控制台残留检查通过（无 web/ 独立页面）。"
echo "下一步：重启 DSH（退出后重新打开），改动才会生效。"
