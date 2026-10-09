#!/usr/bin/env node
/**
 * 把 lib/console.mjs 内联进 lib/client.js。
 *
 * 为什么需要：client.js 是 classic script（宿主用 <script> 加载），
 * 不能用顶层 import。而 console.mjs 是普通 ES 模块，便于阅读与单测。
 * 于是用「源文件 + 生成块」的方式保持单一事实来源：
 *
 *   lib/console.mjs          ← 手写，唯一事实来源
 *   lib/client.js 的
 *   __WBC_CONSOLE_FACTORY__  ← 由本脚本生成的**真函数**（不是字符串 + eval）
 *
 * 用法：
 *   node scripts/gen-console-inline.mjs          # 写入
 *   node scripts/gen-console-inline.mjs --check  # 只校验是否已同步
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONSOLE_SRC = path.join(ROOT, 'lib', 'console.mjs');
const CLIENT = path.join(ROOT, 'lib', 'client.js');

const BEGIN = '//#region BEGIN GENERATED: console page source';
const END = '//#endregion GENERATED: console page source';

const CHECK = process.argv.includes('--check');

/**
 * 把 console.mjs 的 ESM 语法转成可放进 `new Function` 的普通函数体。
 *
 * 只做最小变换 —— 这个文件的 export 面很窄（就一个 createConsoleSection）：
 *   - `export function createConsoleSection` → `function createConsoleSection`
 *   - 行首 `export ` / `export default ` 一律剥掉前缀
 *
 * **不做通用 ESM 转译**：一旦源文件用上别的 ESM 语法（顶层 import、
 * import.meta 等），这里会看不出来。所以生成前先断言没有残留的
 * import/export，宁可构建失败也不要生成一个静默坏掉的 bundle。
 */
function stripEsmSyntax(source) {
  const out = source
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(function|const|let|var|class)\s+/gm, '$1 ');

  // 断言：不该再有顶层 import/export 残留
  const leftover = out.match(/^\s*(import|export)\b.*$/m);
  if (leftover !== null) {
    throw new Error(
      `console.mjs 里仍有无法内联的 ESM 语法：${leftover[0].trim()}\n` +
        '内联只支持 export function/const/let/var/class；其余请改写或扩展本脚本。',
    );
  }

  // 断言：唯一的对外出口存在，否则求值方拿不到东西
  if (!/^function createConsoleSection\b/m.test(out)) {
    throw new Error('console.mjs 必须定义 `export function createConsoleSection`（内联依赖这个名字）');
  }
  return out;
}

/**
 * 生成要插进 client.js 的块。
 *
 * 形状是一个箭头函数，调用方传 (react, jsxRuntime)，返回页面组件：
 *
 *   const __WBC_CONSOLE_FACTORY__ = (react, jsxRuntime) => {
 *     <console.mjs 的函数体，export 已剥掉>
 *     return createConsoleSection({ react, jsxRuntime });
 *   };
 *
 * 为什么不用 `new Function(源码字符串)`：
 *   1. Electron 渲染进程的 CSP 可能不含 'unsafe-eval'，那样会抛 EvalError，
 *      而且只在运行期发现（页面静默消失）。
 *   2. 拼出来的字符串语法错误也只在运行期暴露。
 * 生成真函数则让语法错误在**解析 client.js 时**就报，且没有 CSP 风险。
 */
function buildBlock(rawSource) {
  const body = stripEsmSyntax(rawSource);
  // 缩进一层，让生成块在 client.js 里可读
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');

  return [
    BEGIN,
    '// 本块由 scripts/gen-console-inline.mjs 生成，请勿手改。',
    '// 内容：lib/console.mjs —— 管理页组件（账号 / 积分 / 使用记录）。',
    '// 它是 ES 模块，但此处以**真函数**内联（不是字符串 + eval）：',
    '// client.js 是 classic script 不能顶层 import，而 eval 可能被 CSP 拒绝。',
    '// 改界面请改 lib/console.mjs 后重跑生成脚本；apply.sh 会校验是否同步。',
    'const __WBC_CONSOLE_FACTORY__ = (react, jsxRuntime) => {',
    indented,
    '',
    '  return createConsoleSection({ react, jsxRuntime });',
    '};',
    END,
  ].join('\n');
}

function main() {
  const source = fs.readFileSync(CONSOLE_SRC, 'utf8');
  const client = fs.readFileSync(CLIENT, 'utf8');

  const start = client.indexOf(BEGIN);
  const end = client.indexOf(END);

  const block = buildBlock(source);

  if (CHECK) {
    if (start === -1 || end === -1) {
      console.error('✗ client.js 里没有生成块 —— 请先运行不带 --check 的生成命令');
      process.exit(1);
    }
    const current = client.slice(start, end + END.length);
    if (current !== block) {
      console.error('✗ 生成块与 lib/console.mjs 不同步，请重跑生成脚本');
      process.exit(1);
    }
    console.log('✓ 生成块已同步');
    return;
  }

  let next;
  if (start !== -1 && end !== -1) {
    next = client.slice(0, start) + block + client.slice(end + END.length);
  } else {
    const anchor = '//#endregion GENERATED: xdpool client source';
    const at = client.indexOf(anchor);
    if (at === -1) {
      console.error('✗ 找不到 xdpool 生成块结束标记，无法定位插入点');
      process.exit(1);
    }
    const insertAt = at + anchor.length;
    next = `${client.slice(0, insertAt)}\n\n${block}${client.slice(insertAt)}`;
  }

  fs.writeFileSync(CLIENT, next, 'utf8');
  console.log(`✓ 已写入生成块（${source.length} → ${block.length} 字符）`);
}

main();
