#!/bin/bash
#
# 把合并版 dsh-wotr-console 部署到 DSH profile，并**移除**被它取代的两个旧插件。
#
#   ./tools/apply-wotr.sh              部署到 desktop profile
#   ./tools/apply-wotr.sh --dry-run    只显示计划，不改任何文件
#   ./tools/apply-wotr.sh <profile目录> 指定 profile
#
# 与 apply.sh（单插件版）的区别：这是一次**替换**，不是原地更新。
# 合并版注册的 entry id 沿用旧的两个（llm-workbuddy-xdpool、dsh-connect-trae），
# 所以旧包必须卸载干净 —— 否则同一个 id 被两个包争用，DSH 会加载两次、
# apply 跑两遍、注册重复 provider，两个条目一起失败。
#
# 做完必须重启 DSH（ES module 有缓存，热重载不会重新加载代码）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC="$ROOT/dsh-wotr-console"
NEW_PKG="dsh-wotr-console"
OLD_PKGS=("dsh-workbuddy-console" "dsh-connect-trae")
# 旧包遗留的独立 vendor 依赖（合并版已把 xdpool 内联进 vendor/）
OLD_EXTRA=("dsh-workbuddy-xdpool")

NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"

DRY=0
ARG=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) ARG="$a" ;;
  esac
done

PROFILE="${ARG:-$HOME/.dsh/profiles/desktop}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/.dsh/wotr-merge-backup/$STAMP"
TARGET="$PROFILE/node_modules/$NEW_PKG"

if [ ! -d "$SRC" ]; then echo "找不到源目录: $SRC" >&2; exit 1; fi
if [ ! -d "$PROFILE" ]; then echo "找不到 profile: $PROFILE" >&2; exit 1; fi

echo "源:      $SRC"
echo "profile: $PROFILE"
echo "备份到:  $BACKUP"
[ "$DRY" = 1 ] && echo "（--dry-run：不会真的改动）"
echo

# —— 1) 前置门禁：源码自身必须先过 ——
# 部署一个坏版本会把「设置面板白屏 / 应用无法启动」直接推给用户，
# 所以三道测试在这里跑，失败即停。
echo "== 源码门禁 =="
"$NODE" "$SRC/scripts/gen-console-inline.mjs" --check || {
  echo "错误：lib/client.js 内联的管理页与 lib/console.mjs 不同步" >&2
  echo "      先跑：node $SRC/scripts/gen-console-inline.mjs" >&2
  exit 1
}
for t in credit-store client-apply console-render trae-pool wb-auth trae-auth; do
  if (cd "$SRC" && "$NODE" "test/$t.test.mjs" >/dev/null 2>&1); then
    echo "  ✓ $t"
  else
    echo "  ✗ $t 未通过 —— 先修好再部署" >&2
    echo "    手动查看：cd $SRC && \"$NODE\" test/$t.test.mjs" >&2
    exit 1
  fi
done

# —— 2) 备份 profile 的三个关键文件 + 两个旧包 ——
if [ "$DRY" = 0 ]; then
  mkdir -p "$BACKUP"
  cp -p "$PROFILE/package.json" "$BACKUP/package.json" 2>/dev/null || true
  cp -p "$PROFILE/cordis.patch.yml" "$BACKUP/cordis.patch.yml" 2>/dev/null || true
  cp -p "$PROFILE/pnpm-lock.yaml" "$BACKUP/pnpm-lock.yaml" 2>/dev/null || true
  for p in "${OLD_PKGS[@]}"; do
    [ -d "$PROFILE/node_modules/$p" ] && rsync -a --exclude node_modules \
      "$PROFILE/node_modules/$p/" "$BACKUP/node_modules-$p/"
  done
  echo "已备份 profile 配置与旧包到: $BACKUP"
else
  echo "[dry-run] 将备份 package.json / cordis.patch.yml / pnpm-lock.yaml 与两个旧包"
fi

# —— 3) 同步新包 ——
if [ "$DRY" = 0 ]; then
  mkdir -p "$TARGET"
  rsync -a --delete --exclude node_modules "$SRC/" "$TARGET/"
  echo "已同步: $SRC -> $TARGET"
else
  echo "[dry-run] rsync -a --delete $SRC/ -> $TARGET/"
fi

# —— 4) 改 profile/package.json ——
# 依赖改成 link: 指向本仓库（合并版未发布到 npm，用版本号会解析失败）。
# bundles 里把两个旧包换成新包。
"$NODE" - "$PROFILE" "$ROOT" "$DRY" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [profile, root, dryStr] = process.argv.slice(2);
const dry = dryStr === '1';
const file = path.join(profile, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const NEW = 'dsh-wotr-console';
const OLD = ['dsh-workbuddy-console', 'dsh-connect-trae'];

pkg.dependencies = pkg.dependencies || {};
for (const o of OLD) delete pkg.dependencies[o];
pkg.dependencies[NEW] = 'link:' + path.join(root, 'dsh-wotr-console').replace(/\\/g, '/');

const bundles = (pkg.dsh?.profile?.bundles) ?? [];
const kept = bundles.filter((b) => !OLD.includes(b));
if (!kept.includes(NEW)) kept.push(NEW);
if (pkg.dsh?.profile) pkg.dsh.profile.bundles = kept;

if (!dry) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  dependencies: -${OLD.join(', -')}  +${NEW}`);
console.log(`  bundles:      ${kept.join(', ')}`);
EOF

# —— 5) 改 profile/cordis.patch.yml ——
# 把指向旧包名的条目改成新包名；entry id 保持不变
# （llm-workbuddy-xdpool 是 vendored 池卡片精确匹配设置作用域用的键）。
if [ "$DRY" = 0 ]; then
  "$NODE" - "$PROFILE" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.argv[2], 'cordis.patch.yml');
let raw = fs.readFileSync(file, 'utf8');
const before = raw;
raw = raw.replace(/^(\s*name:\s*)dsh-workbuddy-console\s*$/gm, '$1dsh-wotr-console');
// 独立的 dsh-connect-trae 条目：合并后由 dsh-wotr-console 自己的
// cordis.patch.yml 插入，profile 层不再需要
raw = raw.replace(/^- id: dsh-connect-trae\n(?:[ \t].*\n)*/gm, '');
raw = raw.replace(/\n{3,}/g, '\n\n');
if (raw !== before) {
  fs.writeFileSync(file, raw);
  console.log('  cordis.patch.yml: 旧包名已替换为 dsh-wotr-console，独立 trae 条目已移除');
} else {
  console.log('  cordis.patch.yml: 无需改动');
}
EOF
else
  echo "[dry-run] 将把 cordis.patch.yml 里的 dsh-workbuddy-console 改为 dsh-wotr-console，并移除独立 dsh-connect-trae 条目"
fi

# —— 6) 卸掉旧包目录 ——
# 必须删：旧包与新包注册同样的 entry id，留着会被加载两次。
if [ "$DRY" = 0 ]; then
  for p in "${OLD_PKGS[@]}" "${OLD_EXTRA[@]}"; do
    d="$PROFILE/node_modules/$p"
    if [ -d "$d" ]; then
      # 二次确认绝对路径落在 profile 的 node_modules 下，避免误删
      case "$d" in
        "$PROFILE"/node_modules/*) rm -rf "$d"; echo "  已移除 node_modules/$p" ;;
        *) echo "跳过（路径不在 profile 内）: $d" >&2 ;;
      esac
    fi
  done
else
  echo "[dry-run] 将移除 node_modules/{${OLD_PKGS[*]},${OLD_EXTRA[*]}}"
fi

# —— 7) 校验新包在该 profile 下能被解析 ——
if [ "$DRY" = 0 ]; then
  for f in lib/index.js lib/trae.js lib/client.js lib/console.mjs; do
    [ -f "$TARGET/$f" ] || { echo "错误：目标缺少 $f" >&2; exit 1; }
    "$NODE" --check "$TARGET/$f"
  done
  echo "语法检查通过。"
fi

echo
echo "完成。**下一步必须重启 DSH**（退出后重新打开），改动才会生效。"
echo "重启后应看到：设置 → WOTR 一个入口、五个标签页（XD Pool / Trae 配置 / 账号[左右两列] / 积分 / 使用记录）；"
echo "模型选择器里 workbuddy-xdpool / workbuddy-xdpool-global / trae / trae-global 四个 provider 都在。"
[ "$DRY" = 0 ] && echo "回滚：把 $BACKUP 里的文件拷回 profile，并恢复两个旧包目录。"
