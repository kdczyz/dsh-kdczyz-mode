#!/usr/bin/env node
/**
 * 把 DSH 宿主自带的包装配到 profile 的解析范围里。
 *
 * # 为什么需要这一步
 *
 * 本插件的三个 Loader 入口（lib/index.js、lib/trae.js、lib/qoder.js）在**模块顶层**
 * import 宿主内包：
 *
 *   import { createProvider } from '@earendil-works/pi-ai'
 *   import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
 *   import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
 *   import z from '@deepseek-ai/schemastery'
 *
 * 这些包**只存在于 DSH 宿主里**（打包在 `app.asar/dsh/node_modules`），profile 的
 * `node_modules` 里没有。Node 从插件目录向上找 `node_modules`，一路到磁盘根都找不到，
 * 于是模块顶层求值直接抛错：
 *
 *   ERR_MODULE_NOT_FOUND      @deepseek-ai/dsh-llm-pi-ai
 *   ERR_PACKAGE_PATH_NOT_EXPORTED  @earendil-works/pi-ai（asar 内的包解析不到）
 *
 * **后果的隐蔽之处**：顶层 import 失败时 `apply()` 根本不会执行，
 * 所以 `apply()` 里那层 `.catch(logger.error)` 也跑不到 —— 全程零报错。
 * 表面上只剩「管理页能看到已登录账号，但模型选择器里没有 qoder」。
 * 管理页来自 lib/index.js 的 HTTP 路由（走 webServer 注入），
 * 而 provider 注册在另一个入口，两者互不影响，于是现象更容易被误判成
 * 「登录没生效」。
 *
 * # 为什么必须「复制」而不是软链到 asar
 *
 * asar 是单文件归档，只有 Electron 的 fs 补丁能读。纯 Node（以及宿主加载插件时
 * 走的模块解析）对 `app.asar/...` 路径会得到 `ENOTDIR`。所以软链到 asar 内部无效，
 * 必须把包内容真正写到磁盘上。
 *
 * # 为什么不复制到 node_modules 里，而要单独一层 .dsh-runtime-deps
 *
 * `pnpm install` 管理 profile 的 `node_modules`，往里塞实体目录会被下一次安装清掉。
 * 所以实体放 `profile/.dsh-runtime-deps/node_modules/`，只在 profile 的
 * `node_modules/` 里放软链。**这一层目录名必须叫 node_modules** —— 包之间互相
 * import（如 dsh-llm-pi-ai → dsh-launch-environment、schemastery → cosmokit）
 * 靠向上查找 `node_modules` 解析，目录换个名字就会连锁失败。
 *
 * # 依赖闭包必须包含 peerDependencies
 *
 * 宿主内包大量用 peer 声明彼此（dsh-llm-pi-ai 的 11 个 peer 全是宿主内包）。
 * 只按 `dependencies` 收集会漏掉它们，而且**漏了不会在安装时报错**，
 * 要等真实加载时才以 `Cannot find package '@deepseek-ai/dsh-launch-environment'`
 * 的形式炸出来。所以这里也纳入 `peerDependencies`，只排除
 * `peerDependenciesMeta.*.optional === true` 的项。
 *
 * 用法：
 *   node tools/link-host-deps.mjs [profile目录] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** 插件的三个入口需要直接解析的包（顶层）。 */
const TOP_LEVEL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const profileArg = args.find((a) => !a.startsWith('--'));
const PROFILE = profileArg ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const ROOT = path.join(PROFILE, '.dsh-runtime-deps');
const VENDOR_NM = path.join(ROOT, 'node_modules');
const PROFILE_NM = path.join(PROFILE, 'node_modules');

const log = (msg) => console.log(msg);

/** DSH 桌面端的 Electron 可执行文件（asar 分支借它读包内容）。 */
const ELECTRON = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

/* ------------------------------------------------------------------ *
 * 1) 定位宿主自带的 node_modules
 * ------------------------------------------------------------------ */

/**
 * 宿主 dsh 的包目录。两种形态都要支持：
 *
 *   - 打包安装：`…/app.asar/dsh/node_modules`（asar 内，只有 Electron 能读）
 *   - 解包/开发：`…/app.asar.unpacked/dsh/node_modules` 或任意磁盘目录
 *
 * 返回值带 `needsElectron` 标记：asar 内必须借 Electron 读，
 * 磁盘目录用普通 fs 即可（避免无谓依赖 Electron）。
 */
function locateHostModules() {
  const candidates = [
    // 当前运行的 DSH 安装
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules',
    // 已解包到磁盘的运行时（本仓库单测用的就是这一份）
    '/private/tmp/dsh-extract/full/dsh/node_modules',
  ];
  for (const dir of candidates) {
    const asar = dir.includes('.asar/');
    if (asar) {
      // asar 内路径：普通 fs 读不到，交给 Electron 分支判定
      if (fs.existsSync('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')) {
        return { dir, asar: true };
      }
      continue;
    }
    try {
      if (fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'))) {
        return { dir, asar: false };
      }
    } catch { /* ENOTDIR 等一律跳过 */ }
  }
  return undefined;
}

const host = locateHostModules();
if (host === undefined) {
  console.error('找不到 DSH 宿主自带的包目录。请确认 DSH 已安装，或先解包运行时。');
  process.exit(1);
}
log(`宿主包目录: ${host.dir}${host.asar ? '（asar 内，借 Electron 读取）' : ''}`);

/* ------------------------------------------------------------------ *
 * 2) 计算依赖闭包
 * ------------------------------------------------------------------ */

const readPkg = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return undefined; }
};

/**
 * asar 分支：普通 fs 读不到包内容（ENOTDIR），闭包计算也必须借 Electron。
 *
 * 用一个 helper 进程同时完成「读清单算闭包」与「复制实体」，避免两次往返。
 * 闭包的边（依赖名单）由 helper 里的 Electron fs 读出来，结构原样返回。
 */
function collectViaElectron() {
  const helper = path.join(os.tmpdir(), `dsh-deps-${process.pid}.mjs`);
  fs.writeFileSync(helper, `
import fs from 'node:fs';
import path from 'node:path';

const HOST = ${JSON.stringify(host.dir)};
const TOP = ${JSON.stringify(TOP_LEVEL)};
const readPkg = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return undefined; }
};
const depsOf = (pj) => {
  const meta = pj.peerDependenciesMeta ?? {};
  const peers = Object.fromEntries(
    Object.entries(pj.peerDependencies ?? {}).filter(([n]) => meta[n]?.optional !== true),
  );
  return [...new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
    ...Object.keys(peers),
  ])];
};
const has = (dir) => fs.existsSync(path.join(dir, 'package.json'));

const closure = {};   // name -> { dir, pj }
const missing = [];
const visit = (name) => {
  if (closure[name]) return;
  const dir = path.join(HOST, name);
  const pj = readPkg(dir);
  if (pj === undefined) { if (!missing.includes(name)) missing.push(name); return; }
  closure[name] = { dir, pj };
  for (const dep of depsOf(pj)) {
    const nested = path.join(dir, 'node_modules', dep);
    if (has(nested)) visitNested(dep, nested); else visit(dep);
  }
};
const visitNested = (name, dir) => {
  const pj = readPkg(dir);
  if (pj === undefined) return;
  for (const dep of depsOf(pj)) {
    const nested = path.join(dir, 'node_modules', dep);
    if (has(nested)) visitNested(dep, nested); else visit(dep);
  }
};
for (const t of TOP) visit(t);
console.log(JSON.stringify({ closure, missing }));
`);
  try {
    const out = execFileSync(ELECTRON, [helper], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    fs.rmSync(helper, { force: true });
  }
}

/** 收集一个包声明的全部运行期依赖（含非 optional 的 peer）。 */
function depsOf(pj) {
  const meta = pj.peerDependenciesMeta ?? {};
  const peers = Object.fromEntries(
    Object.entries(pj.peerDependencies ?? {}).filter(([n]) => meta[n]?.optional !== true),
  );
  return [...new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
    ...Object.keys(peers),
  ])];
}

const closure = new Map();
const missing = new Set();

function visit(name) {
  if (closure.has(name)) return;
  const dir = path.join(host.dir, name);
  const pj = readPkg(dir);
  if (pj === undefined) { missing.add(name); return; }
  closure.set(name, { dir, pj });
  for (const dep of depsOf(pj)) {
    // 包内嵌套优先（同名不同版本靠它区分）
    const nested = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(nested, 'package.json'))) visitNested(dep, nested);
    else visit(dep);
  }
}

function visitNested(name, dir) {
  // 嵌套副本随父包一起被复制，这里只需继续向下走它的依赖
  const pj = readPkg(dir);
  if (pj === undefined) return;
  for (const dep of depsOf(pj)) {
    const nested = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(nested, 'package.json'))) visitNested(dep, nested);
    else visit(dep);
  }
}

if (host.asar) {
  const r = collectViaElectron();
  for (const [name, v] of Object.entries(r.closure)) closure.set(name, v);
  for (const n of r.missing) missing.add(n);
} else {
  for (const name of TOP_LEVEL) visit(name);
}

// 平台专属的可选原生包缺席是正常的（本机用不到别的平台）
const platformNoise = /-(?:darwin|linux|win32)-(?:x64|arm64|arm|ia32)(?:-gnu|-msvc)?$/;
const realMissing = [...missing].filter((n) => !platformNoise.test(n) && !n.includes('linux') && !n.includes('win32'));
log(`依赖闭包: ${closure.size} 个包${realMissing.length > 0 ? `，缺失 ${realMissing.length}` : ''}`);
if (realMissing.length > 0) log(`  （${realMissing.slice(0, 6).join(', ')}${realMissing.length > 6 ? ' …' : ''}）`);

/* ------------------------------------------------------------------ *
 * 3) 读出实体内容（asar 分支走 Electron，磁盘分支直接拷）
 * ------------------------------------------------------------------ */

/**
 * 用 Electron-as-node 把每个包从 asar 里读出来写到磁盘。
 *
 * 单个 helper 进程完成全部复制（比每包起一次进程快得多），
 * 通过 stdin 传清单、stdout 回收结果。
 *
 * 只复制包目录下的**实际文件**，跳过 node_modules 子目录的重复遍历成本 ——
 * 嵌套依赖由闭包里的其它条目各自负责（install closure 会把它们放到
 * 顶层 node_modules，Node 解析一样能找到）。
 */
function extractViaElectron(list) {
  const helper = path.join(os.tmpdir(), `dsh-extract-${process.pid}.mjs`);
  fs.writeFileSync(helper, `
import fs from 'node:fs';
import path from 'node:path';
const list = JSON.parse(fs.readFileSync(0, 'utf8'));
let files = 0, bytes = 0;
for (const { src, dst } of list) {
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) {
        // 嵌套 node_modules 交给闭包里的独立条目，避免重复复制
        if (entry.name === 'node_modules') continue;
        walk(s, d);
      } else if (entry.isFile()) {
        fs.copyFileSync(s, d);
        files += 1;
        bytes += fs.statSync(s).size;
      }
    }
  };
  if (fs.existsSync(src)) walk(src, dst);
}
console.log(JSON.stringify({ files, bytes }));
`);
  try {
    const out = execFileSync(ELECTRON, [helper], {
      input: JSON.stringify(list),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    fs.rmSync(helper, { force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 4) 装配
 * ------------------------------------------------------------------ */

if (DRY) {
  log('[dry-run] 将写入:');
  log(`  ${VENDOR_NM}/  （${closure.size} 个包的实体）`);
  log(`  ${PROFILE_NM}/{${TOP_LEVEL.map((n) => n.split('/').pop()).join(', ')}}  （软链）`);
  process.exit(0);
}

// 需要复制哪些包的实体
const toCopy = [];
for (const [name, { dir }] of closure) {
  const dst = path.join(VENDOR_NM, name);
  if (fs.existsSync(path.join(dst, 'package.json'))) continue; // 幂等
  toCopy.push({ src: dir, dst });
}

// 本轮之前先清掉指向 asar / 临时目录的失效软链（历史遗留）
let cleaned = 0;
for (const name of TOP_LEVEL) {
  const lk = path.join(PROFILE_NM, name);
  if (!fs.lstatSync(lk, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
  const target = fs.readlinkSync(lk);
  const stale = target.includes('app.asar') || target.startsWith('/private/tmp') || target.startsWith('/var/folders');
  const dangling = !fs.existsSync(path.join(target, 'package.json'));
  if (stale || dangling) { fs.rmSync(lk, { force: true }); cleaned += 1; }
}
if (cleaned > 0) log(`清理失效软链: ${cleaned}`);

if (toCopy.length > 0) {
  fs.mkdirSync(VENDOR_NM, { recursive: true });
  if (host.asar) {
    const r = extractViaElectron(toCopy);
    log(`从 asar 复制: ${toCopy.length} 个包（${r.files} 个文件，${(r.bytes / 1048576).toFixed(1)} MB）`);
  } else {
    for (const { src, dst } of toCopy) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      execFileSync('cp', ['-R', src, dst]);
    }
    log(`复制: ${toCopy.length} 个包`);
  }
} else {
  log('包实体已是当前版本，无需复制');
}

// 软链顶层包进 profile 的 node_modules
fs.mkdirSync(PROFILE_NM, { recursive: true });
let linked = 0;
for (const name of TOP_LEVEL) {
  const lk = path.join(PROFILE_NM, name);
  const target = path.join(VENDOR_NM, name);
  if (!fs.existsSync(path.join(target, 'package.json'))) {
    console.error(`错误：${name} 未能装配（缺少 ${target}）`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(lk), { recursive: true });
  if (fs.lstatSync(lk, { throwIfNoEntry: false })) fs.rmSync(lk, { recursive: true, force: true });
  fs.symlinkSync(target, lk, 'dir');
  linked += 1;
}

/* ------------------------------------------------------------------ *
 * 5) 自检：以插件身份真实 import 一次
 * ------------------------------------------------------------------ */

const pluginLib = path.join(PROFILE_NM, 'dsh-wotr-console', 'lib');
const probe = path.join(pluginLib, '__deps-probe__.mjs');
if (fs.existsSync(pluginLib)) {
  const specs = [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-ai/api/openai-completions.lazy',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/schemastery',
  ];
  fs.writeFileSync(probe, specs
    .map((s) => `try { await import(${JSON.stringify(s)}); } catch (e) { console.error('FAIL ${s}', e.code); process.exitCode = 1; }`)
    .join('\n'));
  let ok = true;
  try {
    execFileSync(process.execPath, [probe], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch { ok = false; } finally { fs.rmSync(probe, { force: true }); }
  if (!ok) {
    console.error('错误：装配后插件仍无法解析宿主内包，三个 provider 都不会注册。');
    process.exit(1);
  }
  log(`自检通过：插件已可解析宿主内包（软链 ${linked} 个）`);
} else {
  log(`软链 ${linked} 个（插件目录尚未同步，跳过自检）`);
}
