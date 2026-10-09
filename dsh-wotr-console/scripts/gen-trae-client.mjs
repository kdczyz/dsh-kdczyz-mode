/**
 * 把 vendor/trae/client.js 的源码**直接内联**进 lib/client.js。
 *
 * 与 gen-xdpool-client.mjs 完全同一手法，只是对象换成 Trae 半边。
 *
 * 为什么内联而不是 import：
 *   本插件的客户端是 classic script（window.__ModuleLoader__.load 形态），
 *   宿主用 <script> 标签加载它。加顶层 import 会让它变成 ESM，
 *   宿主加载方式一变就可能整个 bundle 起不来 —— 这个坑踩过（空白页）。
 *   所以生成器直接把源码写成一个 const，走字符串注入执行。
 *
 * 为什么可以内联 Trae 客户端：
 *   vendor/trae/client.js 是 `window.__ModuleLoader__.load({id, factory})`
 *   形态的**自注册脚本**，不含任何顶层 import/export，也没有相对依赖
 *   （只 require react / react-dom / react/jsx-runtime，由宿主提供）。
 *   于是可以在同一 bundle 内执行一次，捕获它 factory 的产物再转发 apply。
 *
 * 用法：node scripts/gen-trae-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = ROOT + '/vendor/trae/client.js';
const TARGET = ROOT + '/lib/client.js';

const BEGIN = '//#region BEGIN GENERATED: trae client source';
const END = '//#endregion GENERATED: trae client source';

if (!fs.existsSync(SRC)) {
  console.error('✗ 找不到 ' + SRC);
  process.exit(1);
}

const src = fs.readFileSync(SRC, 'utf8');
if (/<\/script/i.test(src)) {
  console.error('✗ vendored 源码含 </script，内联会被 HTML 截断。');
  process.exit(1);
}

const lines = fs.readFileSync(TARGET, 'utf8').split('\n');
const b = lines.findIndex((l) => l.includes(BEGIN));
const e = lines.findIndex((l) => l.includes(END));

const block = [
  BEGIN,
  '// 本块由 scripts/gen-trae-client.mjs 生成，请勿手改。',
  '// 内容：vendor/trae/client.js（原样内联，MIT, (c) dingminhua — 上游 dsh-connect-trae）',
  '// 用途：在本 bundle 内执行一次，捕获它 factory 的产物并转发 apply，',
  '//       这样 Trae 的设置卡片与输入框积分读数就并入了本插件，无需改动上游代码。',
  'const TRAE_CLIENT_SRC = ' + JSON.stringify(src) + ';',
  END,
];

if (b >= 0 && e > b) {
  const out = [...lines.slice(0, b), ...block, ...lines.slice(e + 1)];
  fs.writeFileSync(TARGET, out.join('\n'));
  console.log(`✓ 已更新 lib/client.js 中的 Trae 内联块（源码 ${src.length} 字节）`);
} else {
  // 插入点优先级：管理页块之后 → xdpool 块之后。
  // 两个生成器的锚点这样排，先跑哪个都不会错位。
  const anchors = [
    '//#endregion GENERATED: console page source',
    '//#endregion GENERATED: xdpool client source',
  ];
  let at = -1;
  for (const anchor of anchors) {
    const found = lines.findIndex((l) => l.includes(anchor));
    if (found >= 0) {
      at = found;
      break;
    }
  }
  if (at < 0) {
    console.error('✗ 找不到插入点（先生成 xdpool 或管理页块）');
    process.exit(1);
  }
  const out = [...lines.slice(0, at + 1), '', ...block, ...lines.slice(at + 1)];
  fs.writeFileSync(TARGET, out.join('\n'));
  console.log(`✓ 已插入 Trae 内联块（源码 ${src.length} 字节）`);
}
