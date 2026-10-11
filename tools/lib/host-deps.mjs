/**
 * 宿主依赖装配（跨平台）—— 插件能不能在 DSH 里被加载，全靠这一步。
 *
 * # 背景：为什么必须有这一步
 *
 * 三个 Loader 入口（`lib/index.js` / `lib/trae.js` / `lib/qoder.js`）在**模块顶层**
 * import 宿主自带的包：
 *
 *   @earendil-works/pi-ai、@earendil-works/pi-ai/api/openai-completions.lazy、
 *   @deepseek-ai/dsh-llm-pi-ai、@deepseek-ai/schemastery、@deepseek-ai/dsh-llm …
 *
 * 这些包只存在于 DSH 的 `app.asar` 里；**DSH 自己不会把它们放进 profile**
 * （本仓库在 121 MB 的 asar 里搜过 `.dsh-runtime-deps`，零命中 —— 那一层是
 * 本仓库发明的）。缺了它们，模块顶层求值就抛 `ERR_MODULE_NOT_FOUND`，
 * 而 `apply()` 里的 `.catch(logger.error)` 同样跑不到 ——
 * 现象是**全程零报错，只是模型选择器里少几个 provider**，极难定位。
 *
 * 所以安装必须做两件事：
 *   1. 把宿主那些包的**磁盘实体**取出来，放到 `<profile>/.dsh-runtime-deps/node_modules`；
 *   2. 在 `<profile>/node_modules` 里为**顶层包**建软链，让 Node 解析得到。
 *
 * # 为什么要跨平台重写
 *
 * 旧版（`tools/link-host-deps.mjs` 第一版）硬编码 macOS 的 `.app` 路径，并借
 * DSH 自带的 Electron 可执行文件当 Node 读 asar —— Windows 上两者都不成立。
 * 现在：asar 用纯 JS 读（`./asar.mjs`），安装位置按平台列候选目录自动探测，
 * 软链在 Windows 上走目录联接（junction，不需要管理员权限）。
 *
 * # 为什么排除 react
 *
 * `react` 也是本插件的 peer，但它只被**客户端** bundle（浏览器里跑的 `lib/client.js`）
 * 用到 —— 那一侧的 react 由 DSH 前端运行时提供，服务端三个入口一行都不 import 它。
 * 把 react 也链进来只会平白多出一份 300 KB 的副本。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { AsarArchive, looksLikeAsar } from './asar.mjs';

/** 宿主包在 asar 内的相对根（`app.asar/dsh/node_modules`）。 */
const HOST_ROOTS = ['dsh/node_modules', 'node_modules'];

/** DSH 宿主里必须存在的锚点包 —— 用它验证「找到的这一份」是不是真的宿主。 */
const ANCHOR = '@deepseek-ai/dsh-llm/package.json';

/**
 * 服务端三个入口顶层 import 的宿主包。
 *
 * 未从 `peerDependencies` 直接推导的原因：那里还含 `react`（客户端用，见文件头）
 * 与 `@deepseek-ai/dsh-host-webserver`（optional）。这份名单 = peers 去掉这两个。
 */
export const PLUGIN_TOP_LEVEL = [
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

/* ------------------------------------------------------------------ *
 * 1) 定位 DSH 安装（asar 或已解包目录）
 * ------------------------------------------------------------------ */

/** 平台相关的候选安装根目录（用于拼 `DeepSeek Harness(.app)/…/app.asar`）。 */
function installParents({ platform, env, home }) {
  if (platform === 'darwin') {
    return ['/Applications', path.join(home, 'Applications'), '/Applications/Utilities'];
  }
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA === undefined ? undefined : path.join(env.LOCALAPPDATA, 'Programs'),
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.APPDATA,
      env.ProgramData === undefined ? undefined : path.join(env.ProgramData, 'Programs'),
    ].filter((p) => typeof p === 'string' && p !== '');
  }
  return [
    '/opt',
    '/usr/lib',
    '/usr/share',
    '/usr/local/lib',
    path.join(home, '.local', 'share'),
    path.join(home, '.local', 'opt'),
  ];
}

/** 从安装根目录出发，列出所有可能的 asar / 已解包 node_modules 位置。 */
export function candidatePaths({ platform, env, home }) {
  const out = [];
  for (const parent of installParents({ platform, env, home })) {
    const apps = platform === 'darwin'
      ? [path.join(parent, 'DeepSeek Harness.app', 'Contents', 'Resources')]
      : [
        path.join(parent, 'DeepSeek Harness', 'resources'),
        path.join(parent, 'DeepSeek Harness', 'Resources'),
        path.join(parent, 'deepseek-harness', 'resources'),
      ];
    for (const res of apps) {
      out.push({ kind: 'asar', file: path.join(res, 'app.asar') });
      out.push({ kind: 'dir', root: path.join(res, 'dsh', 'node_modules') });
      out.push({ kind: 'asar', file: path.join(res, 'app', 'app.asar') });
      out.push({ kind: 'dir', root: path.join(res, 'app', 'dsh', 'node_modules') });
    }
  }
  return out;
}

/**
 * 一个宿主包来源（= 宿主的 node_modules 根）。两种后端（asar / 磁盘目录）
 * 对外接口一致，传入的路径一律是**相对该根**的 `/` 分隔路径（`@scope/name/lib/x.js`），
 * 根前缀由本类自己拼 —— 调用方不需要知道宿主是 asar 还是磁盘目录。
 */
class HostSource {
  constructor(init) {
    Object.assign(this, init);
    this.#archive = init.archive;
  }

  #archive;

  /** 该相对路径是否是文件。 */
  has(rel) {
    if (this.kind === 'asar') return this.#archive.hasFile(`${this.root}/${rel}`);
    return fs.existsSync(path.join(this.root, rel));
  }

  /** 读文件内容。 */
  read(rel) {
    if (this.kind === 'asar') return this.#archive.readFile(`${this.root}/${rel}`);
    return fs.readFileSync(path.join(this.root, rel));
  }

  /** 列出一个目录下的全部**文件**（相对该目录的路径）。 */
  list(rel) {
    if (this.kind === 'asar') {
      const prefix = `${this.root}/${rel}/`;
      return this.#archive.listFiles(`${this.root}/${rel}`)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    }
    const base = path.join(this.root, rel);
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(abs, next);
        else if (entry.isFile()) out.push(next);
      }
    };
    if (fs.existsSync(base)) walk(base, '');
    return out;
  }

  close() {
    if (this.kind === 'asar') this.#archive.close();
  }

  describe() {
    return this.kind === 'asar'
      ? `${this.file}（asar，纯 JS 读取）`
      : `${this.root}（磁盘目录）`;
  }
}

/**
 * 探测宿主包目录。
 *
 * 顺序：显式环境变量（`DSH_HOST_ASAR` / `DSH_HOST_MODULES`）→ 各平台默认安装位置。
 * 校验方式是「锚点包真的存在」而不是「目录存在」—— 装错的路径要在这里就死掉。
 *
 * @returns {HostSource|undefined}
 */
export function discoverHost(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();

  const explicit = [];
  if (typeof env.DSH_HOST_ASAR === 'string' && env.DSH_HOST_ASAR !== '') {
    explicit.push({ kind: 'asar', file: env.DSH_HOST_ASAR });
  }
  if (typeof env.DSH_HOST_MODULES === 'string' && env.DSH_HOST_MODULES !== '') {
    explicit.push({ kind: 'dir', root: env.DSH_HOST_MODULES });
  }

  for (const cand of [...explicit, ...candidatePaths({ platform, env, home })]) {
    const source = openCandidate(cand);
    if (source !== undefined) return source;
  }
  return undefined;
}

/** 尝试把一个候选位置变成可用的 HostSource（不抛异常）。 */
function openCandidate(cand) {
  if (cand.kind === 'asar') {
    if (!fs.existsSync(cand.file) || !looksLikeAsar(cand.file)) return undefined;
    let archive;
    try {
      archive = new AsarArchive(cand.file);
    } catch {
      return undefined;
    }
    for (const root of HOST_ROOTS) {
      const anchor = root === '' ? ANCHOR : `${root}/${ANCHOR}`;
      if (archive.hasFile(anchor)) {
        return new HostSource({ kind: 'asar', file: cand.file, root, archive });
      }
    }
    archive.close();
    return undefined;
  }
  for (const root of [cand.root, path.join(path.dirname(cand.root), 'node_modules')]) {
    try {
      if (fs.existsSync(path.join(root, ANCHOR))) {
        return new HostSource({ kind: 'dir', root });
      }
    } catch { /* ENOTDIR 之类一律跳过 */ }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 2) 依赖闭包
 * ------------------------------------------------------------------ */

const readPkgAt = (source, rel) => {
  try { return JSON.parse(source.read(rel).toString('utf8')); }
  catch { return undefined; }
};

/** 一个包声明的运行期依赖：dependencies + optionalDependencies + 非 optional 的 peer。 */
export function depsOf(pj) {
  const meta = pj.peerDependenciesMeta ?? {};
  const peers = Object.entries(pj.peerDependencies ?? {})
    .filter(([name]) => meta[name]?.optional !== true)
    .map(([name]) => name);
  return [...new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
    ...peers,
  ])];
}

/**
 * 从 `topLevel` 出发算出需要落盘的包闭包。
 *
 * 规则与 Node 解析一致：包内嵌套的 `node_modules/<dep>` 优先；没有嵌套就找顶层。
 * 顶层找不到的记进 `missing`（平台专属可选包缺席是正常的，由调用方过滤）。
 *
 * @returns {{entries: Map<string, {name: string, dir: string, pkg: object, nested: boolean}>,
 *            missing: Set<string>, conflicts: string[]}}
 */
export function collectClosure(source, topLevel = PLUGIN_TOP_LEVEL) {
  const entries = new Map();
  const missing = new Set();
  const conflicts = [];

  const pkgOf = (dir) => readPkgAt(source, `${dir}/package.json`);

  /** 嵌套包：内容随父包一起复制（父包的 `node_modules/` 不跳过），只继续向下走依赖。 */
  const visitNested = (name, dir) => {
    const pj = pkgOf(dir);
    if (pj === undefined) return;
    for (const dep of depsOf(pj)) {
      const nestedDir = `${dir}/node_modules/${dep}`;
      if (source.has(`${nestedDir}/package.json`)) visitNested(dep, nestedDir);
      else visit(dep);
    }
  };

  const visit = (name) => {
    if (entries.has(name)) return;
    const dir = name;
    const pj = pkgOf(dir);
    if (pj === undefined) { missing.add(name); return; }
    entries.set(name, { name, dir, pkg: pj, nested: false });
    for (const dep of depsOf(pj)) {
      const nestedDir = `${dir}/node_modules/${dep}`;
      if (source.has(`${nestedDir}/package.json`)) {
        // 同名不同版本的嵌套副本：父包自身会带着它，这里只负责继续走它的依赖
        visitNested(dep, nestedDir);
      } else {
        visit(dep);
      }
    }
  };

  for (const name of topLevel) visit(name);
  return { entries, missing, conflicts };
}

/** 平台专属可选原生包缺席属正常（本机用不到别的平台）。 */
export function isPlatformNoise(name) {
  return /-(?:darwin|linux|win32)-(?:x64|arm64|arm|ia32)(?:-gnu|-msvc)?$/.test(name)
    || name.includes('linux')
    || name.includes('win32');
}

/* ------------------------------------------------------------------ *
 * 3) 落盘 + 软链
 * ------------------------------------------------------------------ */

const MANIFEST = '.dsh-host-deps.json';

/**
 * 把闭包里每个包的**实体文件**写进 `vendorNm`。
 *
 * 幂等：已存在且版本一致就跳过（DSH 正在运行时替换文件在 Windows 上会 EBUSY）。
 * 版本不一致则整包重写 —— 宿主升级后必须刷新，否则插件会对着旧 API 跑。
 *
 * @returns {{packages: number, files: number, bytes: number, refreshed: number, reused: number}}
 */
export function materializeClosure({ source, closure, vendorNm, dryRun = false, log = () => {} }) {
  const manifestPath = path.join(vendorNm, MANIFEST);
  let manifest = { packages: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 首次安装 */ }
  const next = { generatedAtMs: Date.now(), source: source.describe(), packages: {} };

  let packages = 0;
  let files = 0;
  let bytes = 0;
  let refreshed = 0;
  let reused = 0;

  for (const [name, entry] of closure.entries) {
    const version = String(entry.pkg.version ?? '0.0.0');
    next.packages[name] = version;
    const dst = path.join(vendorNm, name);
    const installed = manifest.packages?.[name];
    const upToDate = installed === version && fs.existsSync(path.join(dst, 'package.json'));
    if (upToDate) { reused += 1; continue; }

    // 整个包目录都复制，**包括**包内嵌套的 `node_modules`：
    // 嵌套副本是父包解析依赖时真正会命中的那一份，漏掉它 = 装出一个跑不起来的包。
    const payload = source.list(entry.dir);
    if (dryRun) {
      log(`  [dry-run] ${name}@${version}（${payload.length} 个文件）`);
      packages += 1;
      continue;
    }

    // 先写临时目录再整体替换：中途失败不会留下半个包
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      for (const rel of payload) {
        const target = path.join(tmp, rel);
        const content = source.read(`${entry.dir}/${rel}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        bytes += content.length;
      }
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(tmp, dst);
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      // Windows 上 DSH 正在运行时会锁住文件（EBUSY/EPERM）：保留旧版本继续跑，
      // 而不是让整个安装崩掉 —— 旧版本至少是「之前能用的那一套」。
      log(`  ! ${name} 更新失败（保留旧版本）：${error.code ?? ''} ${error.message}`);
      continue;
    }
    packages += 1;
    files += payload.length;
    if (installed !== undefined) refreshed += 1;
  }

  if (!dryRun) {
    fs.mkdirSync(vendorNm, { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`);
  }
  return { packages, files, bytes, refreshed, reused };
}

/** 软链类型：Windows 上目录联接（junction）不需要管理员权限，普通软链需要。 */
const linkType = (platform) => (platform === 'win32' ? 'junction' : 'dir');

/**
 * 在 `profileNm` 里为每个顶层包建软链（指向 `vendorNm` 里的实体）。
 *
 * 顺带清理失效软链：指向 asar 内部或临时目录的、以及目标已消失的。
 *
 * @returns {{linked: number, cleaned: number, skipped: string[]}}
 */
export function linkTopLevel({ profileNm, names, vendorNm, dryRun = false, log = () => {}, platform = process.platform }) {
  let linked = 0;
  let cleaned = 0;
  const skipped = [];

  for (const name of names) {
    const linkPath = path.join(profileNm, name);
    const target = path.join(vendorNm, name);

    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const dest = fs.readlinkSync(linkPath);
      const stale = dest.includes('app.asar') || dest.includes('dsh-extract')
        || dest.startsWith(os.tmpdir());
      const dangling = !fs.existsSync(path.join(dest, 'package.json'));
      if (stale || dangling) {
        if (!dryRun) fs.rmSync(linkPath, { force: true });
        cleaned += 1;
      }
    }

    if (!fs.existsSync(path.join(target, 'package.json'))) {
      skipped.push(name);
      continue;
    }
    if (dryRun) { linked += 1; continue; }

    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (existing !== undefined) {
      // Windows 上 junction 用 rmSync 删不掉（需要 rmdir 语义），unlink 更稳
      try { fs.unlinkSync(linkPath); } catch { fs.rmSync(linkPath, { recursive: true, force: true }); }
    }
    fs.symlinkSync(target, linkPath, linkType(platform));
    linked += 1;
  }

  if (cleaned > 0) log(`  清理失效软链: ${cleaned}`);
  return { linked, cleaned, skipped };
}

/* ------------------------------------------------------------------ *
 * 4) 自检：以插件身份真实 import 一次
 * ------------------------------------------------------------------ */

/** 三个入口顶层 import 的 specifier（含一个子路径入口）。 */
export const SELF_CHECK_SPECS = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
];

/**
 * 从插件目录出发，真实 import 一次宿主内包。
 *
 * 必须用**子进程**：当前进程若已加载过同名包，模块缓存会掩盖解析失败。
 *
 * @returns {{ok: boolean, error?: string}}
 */
export function selfCheckHostDeps({ pluginDir, nodePath = process.execPath }) {
  const libDir = path.join(pluginDir, 'lib');
  if (!fs.existsSync(libDir)) return { ok: false, error: `插件目录里没有 lib/：${pluginDir}` };
  const probe = path.join(libDir, '__deps-probe__.mjs');
  fs.writeFileSync(probe, SELF_CHECK_SPECS
    .map((s) => `await import(${JSON.stringify(s)});`)
    .join('\n'));
  try {
    execFileSync(nodePath, [probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    const line = stderr.split('\n').find((l) => l.trim() !== '') ?? error.message;
    return { ok: false, error: line };
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
