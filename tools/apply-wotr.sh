#!/bin/bash
#
# 把合并版 dsh-wotr-console 部署到 DSH profile，并**移除**被它取代的两个旧插件。
#
#   ./tools/apply-wotr.sh              部署到 desktop profile
#   ./tools/apply-wotr.sh --dry-run    只显示计划，不改 profile
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
[ "$DRY" = 1 ] && echo "（--dry-run：不会改动 profile 与插件目录）"
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

# —— 1b) 宿主内包软链：让**裸 Node** 也能解析到宿主内包 ——
# 好几个套件直接 `import '../lib/trae.js'` / `'../lib/qoder.js'`，而这两个文件在模块
# 顶层就 import 宿主内包（@deepseek-ai/schemastery、@earendil-works/pi-ai …）。
# DSH 运行时会把这些包在内存里路由给 profile（见 README「零、安装」），裸 Node 不会 ——
# 所以这里在仓库内的插件目录挂一层软链，指向 profile 里已装配好的那份。
# `node_modules` 在 .gitignore 里；profile 里还没装配时先跑一次 link-host-deps.mjs。
VENDOR_NM="$PROFILE/.dsh-runtime-deps/node_modules"
if [ ! -d "$VENDOR_NM/@deepseek-ai/schemastery" ]; then
  echo "  宿主内包尚未装配，先跑 link-host-deps.mjs …"
  "$NODE" "$ROOT/tools/link-host-deps.mjs" "$PROFILE" >/dev/null
fi
mkdir -p "$SRC/node_modules/@deepseek-ai" "$SRC/node_modules/@earendil-works"
LINKED=0
for scope in "@deepseek-ai" "@earendil-works"; do
  for pkg in "$VENDOR_NM/$scope"/*/; do
    [ -d "$pkg" ] || continue
    name="$(basename "$pkg")"
    if [ ! -e "$SRC/node_modules/$scope/$name" ]; then
      ln -sfn "${pkg%/}" "$SRC/node_modules/$scope/$name"
      LINKED=$((LINKED + 1))
    fi
  done
done
echo "  宿主内包软链已就绪（本次新增 $LINKED 个）"
# 门禁失败一律先**复跑一次**并把失败的那几条断言打出来：
# 这些用例里有几处要等异步注册（本机有真实凭据时 apply 还会真发一次网络请求），
# 满载时会偶发失败 —— 只报「某个套件未通过」既让人以为是代码坏了，也看不出是哪条。
run_suite() {
  local dir="$1" file="$2" name="$3" retry_msg="$4"
  local log
  log="$(mktemp)"
  if (cd "$dir" && "$NODE" "$file" >"$log" 2>&1); then
    rm -f "$log"
    echo "  ✓ $name"
    return 0
  fi
  echo "  ✗ $name 未通过 —— $retry_msg" >&2
  echo "    失败的断言：" >&2
  grep -E "✗|Error|错误" "$log" | head -8 | sed 's/^/      /' >&2
  echo "    手动查看：cd $dir && \"$NODE\" $file" >&2
  echo "    （完整输出：$log）" >&2
  return 1
}

for t in credit-store client-apply console-render trae-pool trae-checkin-route wb-pool-selected wb-auth wb-fingerprint trae-auth qoder-auth qoder-pool qoder-pool-route qoder-credits qoder-campaign qoder-checkin-route qoder-relay qoder-catalog qoder-shim qoder-chat qoder-streaming qoder-payload qoder-dedup qoder-fingerprint qoder-provider; do
  run_suite "$SRC" "test/$t.test.mjs" "$t" "先修好再部署" || exit 1
done
# host-assembly 单独跑在**装配之后**（第 8 步）：它断言的是 profile 的解析结果，
# 部署前跑没有意义（那时依赖还没装配）。
#
# 新设备安装不再有本仓库的安装器（2026-10-11 删除）：那条路是 DSH 插件管理页
# 装 `github:kdczyz/dsh-kdczyz-mode`，前置只有 git，见 README「零、安装」。

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
#
# **绝不删除条目。** profile 层的条目不只是「注册」，它下面的 `config:` 就是
# 用户的设置本身 —— Trae 那条保存着账号绑定（accounts.<region>）、区域开关、
# lastCatalog 与模型勾选，实测近 500 行。删掉它等于把用户配置清零。
#
# 早先这里写成「独立 trae 条目由插件自己的 cordis.patch.yml 插入，profile 层
# 不再需要」并整段删除 —— 那个判断是错的：插件的 `- insert:` 只负责让条目
# **存在**（不带 config），用户设置仍存在 profile 层这一份里。两者并存是正常的
# （profile 层同名条目按 id 覆盖/配置插件插入的条目）。删掉的后果是 Trae 半边
# 退回默认值、账号绑定丢失。
if [ "$DRY" = 0 ]; then
  "$NODE" - "$PROFILE" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.argv[2], 'cordis.patch.yml');
let raw = fs.readFileSync(file, 'utf8');
const before = raw;
// 旧包名 → 合并后的包名（两处：WorkBuddy 半边、Trae 半边）
raw = raw.replace(/^(\s*name:\s*)dsh-workbuddy-console\s*$/gm, '$1dsh-wotr-console');
// 独立的旧 trae 包名 → 合并包名的子路径。**只改 name，原文与 config 一律保留。**
raw = raw.replace(/^(\s*name:\s*)dsh-connect-trae\s*$/gm, '$1dsh-wotr-console/trae');

// —— 补 Qoder 条目 ——
//
// Qoder 半边必须有自己的 profile 条目，否则 Loader 不会加载 lib/qoder.js，
// provider 根本不会注册。表现是「模型选择器里没有 qoder」，而插件自己的
// `- insert:` 只保证条目**存在**（不带 config）——实测这份 profile 里其余两个
// 条目都是手写的，Qoder 那条从没被加进来，所以这里显式补齐。
//
// 幂等：已经有 `name: dsh-wotr-console/qoder` 就跳过，不重复插入、不覆盖
// 可能已存在的用户 config。
if (!/^\s*name:\s*dsh-wotr-console\/qoder\s*$/m.test(raw)) {
  const block = [
    '- id: dsh-connect-qoder',
    '  name: dsh-wotr-console/qoder',
    '',
  ].join('\n');
  raw = raw.replace(/\n*$/, '\n') + block;
  console.log('  cordis.patch.yml: 已补上 Qoder 条目（dsh-connect-qoder → dsh-wotr-console/qoder）');
}

raw = raw.replace(/\n{3,}/g, '\n\n');
if (raw !== before) {
  fs.writeFileSync(file, raw);
  console.log('  cordis.patch.yml: 已更新（条目与 config 一律保留）');
} else {
  console.log('  cordis.patch.yml: 无需改动');
}
EOF
else
  echo "[dry-run] 将把 cordis.patch.yml 里的 dsh-workbuddy-console 改为 dsh-wotr-console，dsh-connect-trae 改为 dsh-wotr-console/trae（条目与其 config 一律保留）"
  echo "[dry-run] 将在缺失时补上 Qoder 条目：dsh-connect-qoder → dsh-wotr-console/qoder"
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
  for f in lib/index.js lib/trae.js lib/qoder.js lib/client.js lib/console.mjs; do
    [ -f "$TARGET/$f" ] || { echo "错误：目标缺少 $f" >&2; exit 1; }
    "$NODE" --check "$TARGET/$f"
  done
  # Qoder 半边靠 package.json 的 exports 白名单解析子路径 `./qoder`，
  # 缺了这一条 Loader 报 ERR_PACKAGE_PATH_NOT_EXPORTED，provider 不会注册。
  "$NODE" -e "
    const pkg = require('$TARGET/package.json');
    if (pkg.exports?.['./qoder'] === undefined) {
      console.error('错误：package.json 缺少 exports[\"./qoder\"]，qoder 半边无法被解析');
      process.exit(1);
    }
  "
  echo "语法检查通过（含 exports[\"./qoder\"] 白名单）。"
fi

# —— 8) 把宿主内包装配进 profile（供**裸 Node** 解析）——
#
# 说明：DSH 运行时会在内存里把宿主内包路由给每个 profile（app-boot 的
# profile-resolution-bootstrap.js），所以插件在宿主里本来就能加载。这一步是给
# **脱离 DSH 的裸 Node** 用的 —— 第 7 步的解析校验、第 8 步末尾的 host-assembly
# 自检、以及 `node test/xxx.test.mjs` 手动复跑都走裸 Node 解析，需要 profile
# 自己能找到这些包。（这三个入口顶层就 import 宿主内包，解析失败时模块顶层求值
# 直接抛，apply() 根本不执行，连 .catch() 里的日志都打不出来。）
#
# 根因：这些包是 DSH 宿主自带的（在 app.asar 内），profile 的 node_modules
# 里一个都没有；而 asar 内部路径纯 Node 读不到（ENOTDIR），软链过去无效。
# 所以要从宿主运行时把依赖闭包**复制**成磁盘实体，再软链进 profile。
#
# 幂等：已存在且版本一致就跳过；--dry-run 只报告。
if [ "$DRY" = 0 ]; then
  "$NODE" "$ROOT/tools/link-host-deps.mjs" "$PROFILE" || {
    echo "错误：宿主内包未能装配，插件在宿主里仍会加载失败" >&2
    exit 1
  }
  # 装配后再跑一次 host-assembly —— 这一步才真正回答「宿主里能不能加载」。
  # 它是本项目唯一能抓到「源码全绿、真机全废」那类故障的测试。
  if "$NODE" "$TARGET/test/host-assembly.test.mjs" >/dev/null 2>&1; then
    echo "  ✓ host-assembly（三个入口在该 profile 下均可加载）"
  else
    echo "  ✗ host-assembly 未通过 —— 插件在宿主里加载不了，provider 不会出现" >&2
    echo "    手动查看：\"$NODE\" $TARGET/test/host-assembly.test.mjs" >&2
    exit 1
  fi
else
  echo "[dry-run] 将从 DSH 宿主装配依赖闭包到 $PROFILE/.dsh-runtime-deps/node_modules 并软链进 node_modules/"
  echo "[dry-run] 将运行 host-assembly 校验三个入口在该 profile 下可加载"
fi

echo
echo "完成。**下一步必须重启 DSH**（退出后重新打开），改动才会生效。"
echo "重启后应看到：设置 → WOTR 一个入口、三个标签页（workbuddy / trae / qoder[单列：先号池后模型，与另两个配置页同一套骨架]），以及 composer 输入框下面那颗可点击展开的积分胶囊；"
echo "模型选择器里 workbuddy-xdpool / workbuddy-xdpool-global / trae / trae-global / qoder 五个 provider 都在。"
echo "（Qoder 已接通推理：登录入口在「qoder」页页头的「添加账号」，"
echo "  对话走本机 loopback shim → COSY 签名 → 上游；积分余额进该页后每 30 秒自动刷新。"
echo "  模型区与 WorkBuddy / Trae 同款：每张卡只有「启用」一个勾选，图片能力（上游 is_vl）"
echo "  与上下文窗口（上游 max_input_tokens）**跟随上游目录**，卡片上只显示不选择；"
echo "  「从 Qoder 刷新」= 拉取即落盘（全部启用 + 图片/上下文按上游写回，无需再点保存），"
echo "  拉取失败时一个字段都不写（不把内置兜底表固化成白名单）。"
echo "  含图请求要两处接线都通（模型层声明 image + pi-ai 适配器的 resolveAttachments），"
echo "  重启后确认进程里真的是这一版代码："
echo "    curl -s http://127.0.0.1:19387/plugins/dsh-wotr-console/qoder/models/refresh"
echo "  回执里 capabilities.imageAttachments 必须为 true —— null/false 说明还是旧代码；"
echo "  同一份回执里每个模型都带正整数 contextWindow 与布尔 supportsImages。）"
[ "$DRY" = 0 ] && echo "回滚：把 $BACKUP 里的文件拷回 profile，并恢复两个旧包目录。"
