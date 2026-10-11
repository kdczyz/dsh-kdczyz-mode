#!/usr/bin/env node
/**
 * dsh-wotr-console 的一键安装器 —— 给**新设备**用，不依赖 git / bash / pnpm / tar。
 *
 * # 为什么需要它
 *
 * 插件管理器里写 `github:kdczyz/dsh-workbuddy-mode` 会失败，原因不在包本身：
 * pnpm 解析 `github:` 这种写法时**先调 `git ls-remote` 问远端 ref**，
 * Windows 上没装 git 就得到：
 *
 *   [ERROR] Command failed with exit code 1:
 *     git ls-remote "https://github.com/kdczyz/dsh-workbuddy-mode.git" HEAD "HEAD^{}"
 *   'git' 不是内部或外部命令，也不是可运行的程序
 *
 * 就算装上 git 装成功了，还有第二个坑：pnpm 会按 `peerDependencies` 从公共 npm
 * **另装一份宿主内包**，而那份版本必然对不上（实测宿主是 `@deepseek-ai/dsh-llm`
 * 0.2.0-rc.2 / `@earendil-works/pi-ai` 0.87.1，pnpm 自动装的是 0.1.7-rc.2 / 0.85.1），
 * 而且它在解析链上更近，会直接遮住宿主那份 —— 结果是「装上了但 provider 不出现」。
 *
 * 所以这个安装器绕开 pnpm 与 git：匿名 HTTPS 拉 GitHub 的 tar.gz → 自己解压
 * → 自己装配（含从 `app.asar` 里纯 JS 取出宿主内包）→ 自检。
 *
 * # 用法
 *
 * 只装了 DSH、别的什么都没有的机器上（Windows PowerShell 示例）：
 *
 *   # 1) 找到 DSH 自带的 node（它一定有，不需要另装 Node）
 *   $node = (Get-ChildItem "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime" `
 *            -Recurse -Filter node.exe | Select-Object -First 1).FullName
 *   # 2) 下载并运行安装器
 *   irm https://raw.githubusercontent.com/kdczyz/dsh-workbuddy-mode/main/tools/install-wotr.mjs `
 *       -OutFile "$env:TEMP\install-wotr.mjs"
 *   & $node "$env:TEMP\install-wotr.mjs"
 *
 * macOS / Linux（用系统 node 或 DSH 自带的都行）：
 *
 *   node tools/install-wotr.mjs                     # 仓库里直接跑
 *   node install-wotr.mjs                           # 或从 raw 下载后单独跑
 *
 * 常用参数：
 *   --profile <目录>     指定 profile（默认 ~/.dsh/profiles/desktop）
 *   --ref <分支|标签|sha>  装哪一版（默认 main）
 *   --from <目录|tar.gz>  用本地源码装（离线 / 开发机自测）
 *   --dry-run            只打印计划，不改任何文件
 *   --keep-staging       保留解压出来的临时目录（排查用）
 *
 * # 它是怎么找到代码的
 *
 * 单独跑（从 raw 下载的那份）时，它只多下载一个文件：`tools/lib/tar-gz.mjs`
 * （解压需要），解压完再从**解压出来的那棵树**里 import 完整的安装逻辑
 * （`tools/lib/install.mjs`）。所以「引导」这段代码很小，
 * 而真正的安装逻辑永远只有一份 —— 就在仓库里，被单测覆盖的那一份。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DEFAULT = 'kdczyz/dsh-workbuddy-mode';

/** 解析命令行。 */
function parseArgs(argv) {
  const out = { repo: REPO_DEFAULT, ref: 'main', profile: undefined, from: undefined, dryRun: false, keepStaging: false, staging: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面缺一个值`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--keep-staging') out.keepStaging = true;
    else if (a === '--profile') out.profile = value();
    else if (a === '--ref' || a === '--branch') out.ref = value();
    else if (a === '--repo') out.repo = value();
    else if (a === '--from') out.from = value();
    else if (a === '--staging') out.staging = value();
    else throw new Error(`不认识的参数：${a}（--help 看用法）`);
  }
  return out;
}

const HELP = `
dsh-wotr-console 安装器

  node install-wotr.mjs [选项]

  --profile <目录>       profile 目录（默认 ~/.dsh/profiles/desktop）
  --ref <分支|标签|sha>  安装哪一版（默认 main）
  --repo <owner/name>    从哪个仓库取（默认 ${REPO_DEFAULT}）
  --from <目录|tar.gz>   用本地源码 / 本地 tar.gz 安装
  --dry-run              只打印计划，不改任何文件
  --keep-staging         保留解压出的临时目录
  --staging <目录>       指定临时目录

装完必须**重启 DSH**（ES module 有缓存，热重载不会重新加载代码）。
`;

const log = (msg) => console.log(msg);

/** 只有 Node ≥ 18 才有 fetch；DSH 自带 runtime 一定满足。 */
function requireFetch() {
  if (typeof fetch !== 'function') {
    throw new Error(`当前 Node（${process.version}）没有 fetch，装不了。\n`
      + '请用 DSH 自带的 node 运行，或升级到 Node ≥ 18。');
  }
}

/** 下载到内存（几百 KB ~ 几 MB，不值得落盘再读）。 */
async function download(url, label) {
  requireFetch();
  log(`下载 ${label}\n     ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}\n  ${url}\n`
      + (res.status === 404 ? '（仓库/分支名写错了？用 --repo 与 --ref 指定）' : ''));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log(`     完成：${(buf.length / 1048576).toFixed(2)} MB`);
  return buf;
}

/** GitHub 的 tar.gz 地址：分支/标签走 refs/heads 或 refs/tags，sha 直接拼。 */
function tarballUrl(repo, ref) {
  const base = `https://codeload.github.com/${repo}/tar.gz`;
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return `${base}/${ref}`;
  return `${base}/refs/heads/${ref}`;
}

/** raw 上的单文件地址（引导阶段取 tar-gz.mjs 用）。 */
function rawUrl(repo, ref, relPath) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${relPath}`;
}

/** 建临时目录。 */
function makeStaging(explicit) {
  if (explicit !== undefined) {
    fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wotr-install-'));
}

/** 解压 tar.gz 到 staging，返回解压出来的仓库根目录。 */
function extractTo(tarball, staging, extractTarGz, label) {
  const r = extractTarGz(tarball, staging, { strip: 1 });
  log(`解压完成（${label}）：${r.files} 个文件，${(r.bytes / 1048576).toFixed(2)} MB`);
  return findRepoRoot(staging);
}

/**
 * 在解压结果里找出仓库根（含 `dsh-wotr-console/` 的那一层）。
 *
 * `strip: 1` 已经把 GitHub 的顶层 `仓库名-sha/` 去掉，正常就是 staging 本身；
 * 多探一层是为了容忍别的打包方式（比如手工打的 tar）。
 */
function findRepoRoot(dir) {
  const hasPlugin = (d) => fs.existsSync(path.join(d, 'dsh-wotr-console', 'package.json'));
  if (hasPlugin(dir)) return dir;
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    if (fs.statSync(sub).isDirectory() && hasPlugin(sub)) return sub;
  }
  throw new Error(`解压出来的东西里找不到 dsh-wotr-console/：${dir}`);
}

/**
 * 载入解压模块：优先用**源码树里**的那份（与待解压内容同一版本），
 * 其次用安装器自己旁边的那份（在仓库里直接跑时就是这个）。
 */
async function loadTarGz(candidates) {
  for (const file of candidates) {
    if (file !== undefined && fs.existsSync(file)) {
      const mod = await import(pathToFileURL(file).href);
      return mod.extractTarGz;
    }
  }
  throw new Error(`找不到解压模块 tar-gz.mjs（找过：${candidates.filter(Boolean).join(', ')}）`);
}

/**
 * 取到一份「含 dsh-wotr-console/ 的源码树」。
 */
async function acquireSource(opts) {
  const ownDir = path.dirname(fileURLToPath(import.meta.url));
  const ownLib = path.join(ownDir, 'lib', 'tar-gz.mjs');

  if (opts.from !== undefined) {
    const from = path.resolve(opts.from);
    if (!fs.existsSync(from)) throw new Error(`--from 指向的路径不存在：${from}`);
    if (fs.statSync(from).isDirectory()) {
      log(`用本地源码：${from}`);
      return { sourceDir: from, staging: undefined };
    }
    // 本地 tar.gz
    const staging = makeStaging(opts.staging);
    const tarGz = await loadTarGz([ownLib, path.join(staging, 'lib', 'tar-gz.mjs')]);
    const sourceDir = extractTo(fs.readFileSync(from), staging, tarGz, '本地 tar.gz');
    return { sourceDir, staging };
  }

  // 默认：从 GitHub 拉。引导阶段只需要 tar-gz.mjs 一个文件 ——
  // 从**同一个 ref** 取，保证「解压代码」与「被解压的代码」是同一版。
  const staging = makeStaging(opts.staging);
  let tarGz;
  if (fs.existsSync(ownLib)) {
    tarGz = await loadTarGz([ownLib]);
  } else {
    const url = rawUrl(opts.repo, opts.ref, 'tools/lib/tar-gz.mjs');
    const buf = await download(url, '解压模块 tools/lib/tar-gz.mjs');
    const local = path.join(staging, 'tar-gz.mjs');
    fs.writeFileSync(local, buf);
    tarGz = await loadTarGz([local]);
  }
  const tarball = await download(tarballUrl(opts.repo, opts.ref), `仓库 ${opts.repo}@${opts.ref}`);
  const sourceDir = extractTo(tarball, staging, tarGz, `${opts.repo}@${opts.ref}`);
  return { sourceDir, staging };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help === true) { log(HELP); return 0; }

  const { sourceDir, staging } = await acquireSource(opts);
  const installEntry = path.join(sourceDir, 'tools', 'lib', 'install.mjs');
  if (!fs.existsSync(installEntry)) {
    throw new Error(`这份源码里没有 ${installEntry} —— 不是本仓库的完整源码树？`);
  }
  const { install } = await import(pathToFileURL(installEntry).href);

  log('');
  const summary = install({
    sourceDir,
    profile: opts.profile,
    dryRun: opts.dryRun,
    log,
  });

  log('');
  log(opts.dryRun === true ? '—— dry-run 结束（什么都没改）——' : '—— 装好了 ——');
  for (const step of summary.steps) log(`  · ${step}`);
  log('');
  if (opts.dryRun) {
    log('这是 --dry-run：什么都没改。去掉它再跑一次即可真正安装。');
  } else {
    log('现在请**完全退出并重新启动 DSH**（ES module 有缓存，热重载不会重载代码）。');
    log('重启后验证插件在不在：');
    log('  curl -s http://127.0.0.1:19387/plugins/dsh-wotr-console/qoder/models/refresh');
    log('回执里 capabilities.imageAttachments 应为 true；管理页在「设置 → 插件 → dsh-wotr-console」。');
    if (summary.backup !== undefined) log(`回滚：把 ${summary.backup} 里的文件拷回 profile 即可。`);
  }
  if (staging !== undefined && opts.keepStaging !== true) {
    fs.rmSync(staging, { recursive: true, force: true });
  } else if (staging !== undefined) {
    log(`临时目录保留在：${staging}`);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`\n安装失败：${error.message}`);
  process.exit(1);
});
