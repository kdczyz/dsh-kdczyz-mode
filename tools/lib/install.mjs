/**
 * 把 dsh-wotr-console 装进一个 DSH profile —— 跨平台、不依赖 git / bash / pnpm。
 *
 * 这是 `tools/install-wotr.mjs` 的核心，也是 `tools/apply-wotr.sh`（开发机的部署脚本）
 * 在新设备上的等价物。两者做同一件事，差别只在「源码从哪来」：
 * 开发机是仓库工作区，新设备是刚解压出来的 tar 包。
 *
 * # 装一个插件到底要动哪些地方
 *
 * 少任何一步，症状都是「装完了但什么都没发生」：
 *
 *   1. 包实体 → `<profile>/node_modules/dsh-wotr-console`（真实目录，不是软链）
 *   2. 源码副本 → `<profile>/.dsh-wotr-src`（profile 的 `link:` 指向它，
 *      `pnpm install` 之后仍然自洽）
 *   3. 宿主内包 → `<profile>/.dsh-runtime-deps/node_modules`（实体）
 *      + `<profile>/node_modules/{@deepseek-ai,@earendil-works}/…`（软链）
 *      —— 不做这一步，三个入口在宿主里顶层 import 就抛，**且不报错**
 *   4. `<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
 *   5. `<profile>/cordis.patch.yml` 的三个条目（**绝不删条目** ——
 *      条目下面的 `config:` 就是用户的设置本身）
 *   6. `<profile>/.npmrc` 写 `auto-install-peers=false`
 *      —— 否则 pnpm 会从公共 npm 另装一份**版本对不上**的宿主包（实测：
 *      host 是 dsh-llm 0.2.0-rc.2 / pi-ai 0.87.1，pnpm 自动装的是
 *      0.1.7-rc.2 / 0.85.1），而且它在解析链上**比宿主更近**，会直接遮住宿主那份
 *
 * # 为什么不跑 pnpm install
 *
 * profile 的 `node_modules` 由 pnpm 管理，但本插件不在 npm 上（`link:` 或本地目录）。
 * 实测该 profile 的锁文件比 package.json 旧、手工放的实体目录也活得好好的 ——
 * DSH 启动时不会重跑 `pnpm install`。所以安装器自己装配，跑完即可用。
 *
 * # 备份与幂等
 *
 * 每次安装前把 profile 的四个配置文件 + 被替换的旧插件目录备份到
 * `~/.dsh/wotr-install-backup/<时间戳>/`；重复安装只覆盖自己那几处，
 * 用户 config 一律原样保留。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  PLUGIN_TOP_LEVEL,
  collectClosure,
  discoverHost,
  isPlatformNoise,
  linkTopLevel,
  materializeClosure,
  selfCheckHostDeps,
} from './host-deps.mjs';

export const PLUGIN_NAME = 'dsh-wotr-console';

/** 被合并版取代的旧插件包 —— 与新包注册同一批 entry id，留着会被加载两次。 */
export const OLD_PACKAGES = ['dsh-workbuddy-console', 'dsh-connect-trae', 'dsh-workbuddy-xdpool'];

/** 装完必须存在的文件（少一个都说明安装不完整）。 */
export const REQUIRED_FILES = [
  'lib/index.js',
  'lib/trae.js',
  'lib/qoder.js',
  'lib/client.js',
  'lib/console.mjs',
];

/** 三个 Loader 条目的 id 与包名（顺序无关，全部幂等）。 */
export const ENTRY_SPECS = [
  { id: 'llm-workbuddy-xdpool', name: PLUGIN_NAME },
  { id: 'dsh-connect-trae', name: `${PLUGIN_NAME}/trae` },
  { id: 'dsh-connect-qoder', name: `${PLUGIN_NAME}/qoder` },
];

export const defaultProfilePath = (home = os.homedir()) => path.join(home, '.dsh', 'profiles', 'desktop');

/* ------------------------------------------------------------------ *
 * 纯函数：profile 配置修补（单独导出，便于单测）
 * ------------------------------------------------------------------ */

/**
 * 改 profile 的 `package.json`。
 *
 * `dependencies` 里删旧包名、加新包名；`dsh.profile.bundles` 同样替换。
 * 包名指向 `link:<相对路径>` —— 未发布到 npm，写版本号会解析失败。
 */
export function patchProfilePackageJson(pkg, opts = {}) {
  const pluginName = opts.pluginName ?? PLUGIN_NAME;
  const oldNames = opts.oldNames ?? OLD_PACKAGES;
  const linkTarget = opts.linkTarget ?? '.dsh-wotr-src';
  const next = JSON.parse(JSON.stringify(pkg ?? {}));

  next.dependencies = next.dependencies ?? {};
  for (const old of oldNames) delete next.dependencies[old];
  next.dependencies[pluginName] = `link:${linkTarget.replace(/\\/g, '/')}`;

  const bundles = next.dsh?.profile?.bundles ?? [];
  const kept = bundles.filter((b) => !oldNames.includes(b));
  if (!kept.includes(pluginName)) kept.push(pluginName);
  next.dsh = next.dsh ?? {};
  next.dsh.profile = { ...(next.dsh.profile ?? {}), bundles: kept };

  return { pkg: next, removed: oldNames.filter((o) => bundles.includes(o) || pkg?.dependencies?.[o] !== undefined), bundles: kept };
}

/**
 * 改 profile 的 `cordis.patch.yml`。
 *
 * **只改名、只补条目，绝不删除任何条目** —— profile 层条目下面的 `config:`
 * 就是用户的设置（Trae 那条实测近 500 行：账号绑定、区域开关、模型勾选）。
 * 删掉等于把用户配置清零。
 *
 * 两个动作：
 *   1. 旧包名 → 合并后的包名（`dsh-workbuddy-console` → 本包；
 *      `dsh-connect-trae` → `dsh-wotr-console/trae`）
 *   2. 三个 entry 缺哪个补哪个。
 *
 * 第 2 步**三个都要补**，不是只补 Qoder：插件自带的 `cordis.patch.yml`
 * 里那三条 `- insert:` 确实能让条目**存在**，但实测本机 profile 是三个条目
 * 都写在 profile 层（profile 层同名条目按 id 覆盖插件插入的那条，用户设置
 * 也就落在这里）。新设备照本机验证过的形态装配，不靠「一半在插件、一半在
 * profile」这种巧合。
 */
export function patchCordisYaml(raw, opts = {}) {
  const pluginName = opts.pluginName ?? PLUGIN_NAME;
  const before = raw ?? '';
  let out = before;
  const renamed = [];

  // 旧包名 → 合并后的名字。**只改 name 这一行**，该条目下其余内容（含 config）逐字保留。
  const renameMap = [
    ['dsh-workbuddy-console', pluginName],          // WorkBuddy 半边
    ['dsh-workbuddy-xdpool', pluginName],           // 更早的独立 vendor 包
    ['dsh-connect-trae', `${pluginName}/trae`],     // Trae 半边
  ];
  for (const [old, next] of renameMap) {
    if (!out.includes(old)) continue;
    const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(\\s*name:\\s*)${escaped}\\s*$`, 'gm');
    if (re.test(out)) {
      out = out.replace(re, `$1${next}`);
      renamed.push(`${old} → ${next}`);
    }
  }

  const added = [];
  for (const entry of ENTRY_SPECS) {
    const re = new RegExp(`^\\s*name:\\s*${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    if (re.test(out)) continue;
    // 补一条最小条目（不带 config）—— config 是用户设置，只有用户/界面写得出来
    out = `${out.replace(/\n*$/, '\n')}${[`- id: ${entry.id}`, `  name: ${entry.name}`, ''].join('\n')}`;
    added.push(entry.id);
  }

  out = out.replace(/\n{3,}/g, '\n\n');
  return { yaml: out, changed: out !== before, renamed, added, addedQoder: added.includes('dsh-connect-qoder') };
}

/**
 * 改 profile 的 `.npmrc`：写 `auto-install-peers=false`。
 *
 * pnpm 默认 `auto-install-peers=true`，会把本插件的 peer（全是宿主内包）
 * 从公共 npm 装一份到自己的解析范围里；那份比宿主更近，会直接遮住宿主那份，
 * 而且版本必然对不上（peer 范围按 semver 规则选不到宿主当前用的预发布版）。
 *
 * 合并式写入：已有别的配置行一律保留，只补/改这一条。
 */
export function mergeNpmrc(raw) {
  const lines = (raw ?? '').split('\n');
  const kept = lines.filter((line) => !/^\s*auto-install-peers\s*=/.test(line));
  // 去掉尾部空行再补，避免越写越多空行
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push('auto-install-peers=false');
  return `${kept.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 文件操作
 * ------------------------------------------------------------------ */

/** 递归复制目录（跳过 `node_modules` / `.git` —— 那两个不是插件内容）。 */
export function copyTree(from, to, { skipDirs = ['node_modules', '.git'] } = {}) {
  let files = 0;
  let bytes = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDirs.includes(entry.name)) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) walk(s, d);
      else if (entry.isFile()) {
        fs.copyFileSync(s, d);
        files += 1;
        bytes += fs.statSync(s).size;
      }
    }
  };
  walk(from, to);
  return { files, bytes };
}

/** 删除一个路径之前，确认它确实在允许的根目录内（防止误删）。 */
function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作 profile 之外的路径：${target}`);
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 安装（或原地更新）插件。
 *
 * @param {{sourceDir: string, profile: string, dryRun?: boolean, log?: Function,
 *          platform?: string, env?: object, home?: string, skipSelfTests?: boolean}} options
 * @returns {object} 安装摘要
 */
export function install(options) {
  const log = options.log ?? console.log;
  const dryRun = options.dryRun === true;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const profile = path.resolve(options.profile ?? defaultProfilePath(home));
  const sourceDir = path.resolve(options.sourceDir);

  const pluginSrc = path.join(sourceDir, PLUGIN_NAME);
  const profileNm = path.join(profile, 'node_modules');
  const pluginDir = path.join(profileNm, PLUGIN_NAME);
  const srcCopy = path.join(profile, '.dsh-wotr-src');
  const vendorNm = path.join(profile, '.dsh-runtime-deps', 'node_modules');

  /* —— 0) 前置校验 —— */
  const srcPkgPath = path.join(pluginSrc, 'package.json');
  if (!fs.existsSync(srcPkgPath)) {
    throw new Error(`源码目录里找不到插件：${srcPkgPath}`);
  }
  const srcPkg = JSON.parse(fs.readFileSync(srcPkgPath, 'utf8'));
  if (srcPkg.name !== PLUGIN_NAME) {
    throw new Error(`源码里这个包叫 ${srcPkg.name}，不是 ${PLUGIN_NAME}`);
  }
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(pluginSrc, rel))) throw new Error(`源码缺少 ${rel}`);
  }
  if (!fs.existsSync(profile)) {
    throw new Error(`找不到 profile：${profile}\n`
      + '先启动一次 DSH（它会创建 profile），或用 --profile 指定。');
  }
  const profilePkgPath = path.join(profile, 'package.json');
  if (!fs.existsSync(profilePkgPath)) {
    throw new Error(`profile 里没有 package.json：${profilePkgPath}\n`
      + '这不像一个已初始化的 profile —— 先启动一次 DSH，或用 --profile 指定正确的目录。');
  }

  log(`源码:    ${pluginSrc}（v${srcPkg.version}）`);
  log(`profile: ${profile}`);
  log(dryRun ? '模式:    --dry-run（不会改动任何文件）' : '模式:    实际安装');
  log('');

  const summary = { version: srcPkg.version, profile, backup: undefined, steps: [] };

  /* —— 1) 备份 —— */
  const backupRoot = path.join(home, '.dsh', 'wotr-install-backup', stamp());
  if (dryRun) {
    log(`[dry-run] 将备份 profile 配置到 ${backupRoot}`);
  } else {
    fs.mkdirSync(backupRoot, { recursive: true });
    for (const f of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', '.npmrc']) {
      const from = path.join(profile, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(backupRoot, f));
    }
    for (const p of OLD_PACKAGES) {
      const dir = path.join(profileNm, p);
      if (fs.existsSync(dir)) copyTree(dir, path.join(backupRoot, `node_modules-${p}`));
    }
    summary.backup = backupRoot;
    log(`已备份 profile 配置到 ${backupRoot}`);
  }

  /* —— 2) 清掉会遮住宿主包的 pnpm 副本 —— */
  //
  // 新设备上很可能是「先用插件管理器装过一次（失败或装上了但跑不起来）」
  // 才来找这个安装器的。pnpm 装出来的那份在 `.pnpm/…` 里，它的解析路径
  // **比 profile 的 node_modules 更近**：只要它还在，宿主那份永远轮不到。
  const neutralized = neutralizePnpmCopies({ profileNm, pluginName: PLUGIN_NAME, dryRun, log });
  if (neutralized.length > 0) summary.steps.push(`清理 pnpm 副本 ${neutralized.length} 处`);
  if (dryRun) log('[dry-run] 将清理 node_modules/dsh-wotr-console 与 .pnpm 下同名副本');

  /* —— 3) 旧包实体 —— */
  for (const old of OLD_PACKAGES) {
    const dir = assertInside(profileNm, path.join(profileNm, old));
    if (!fs.existsSync(dir)) continue;
    if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
    log(`  已移除旧包 node_modules/${old}`);
  }

  /* —— 4) 源码副本 + 包实体 —— */
  //
  // 两份真目录（不是软链）：
  //   .dsh-wotr-src               ← profile 的 `link:` 指向它，pnpm 重装后仍自洽
  //   node_modules/dsh-wotr-console ← 宿主真正加载的那一份（与开发机的部署形态一致）
  if (dryRun) {
    log(`[dry-run] 将同步 ${srcCopy} 与 ${pluginDir}`);
  } else {
    fs.rmSync(srcCopy, { recursive: true, force: true });
    const copied = copyTree(pluginSrc, srcCopy);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    copyTree(srcCopy, pluginDir);
    log(`已同步插件: ${copied.files} 个文件，${(copied.bytes / 1024).toFixed(0)} KB`);
  }

  /* —— 5) 语法与 exports 门禁 —— */
  //
  // exports["./qoder"] 缺了这一条，Loader 报 ERR_PACKAGE_PATH_NOT_EXPORTED，
  // Qoder 半边静默消失。
  if (!dryRun) {
    const exportsCheck = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).exports ?? {};
    if (exportsCheck['./qoder'] === undefined) {
      throw new Error('package.json 缺少 exports["./qoder"]，Qoder 半边无法被解析');
    }
    for (const rel of REQUIRED_FILES) {
      syntaxCheck(path.join(pluginDir, rel), log);
    }
    log(`语法检查通过（含 exports["./qoder"] 白名单）`);
  }

  /* —— 6) profile/package.json —— */
  const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
  const patched = patchProfilePackageJson(profilePkg, { linkTarget: '.dsh-wotr-src' });
  if (!dryRun) fs.writeFileSync(profilePkgPath, `${JSON.stringify(patched.pkg, undefined, 2)}\n`);
  log(`  dependencies: ${PLUGIN_NAME} → link:.dsh-wotr-src`);
  log(`  bundles:      ${patched.bundles.join(', ')}`);

  /* —— 7) profile/cordis.patch.yml —— */
  const patchPath = path.join(profile, 'cordis.patch.yml');
  if (fs.existsSync(patchPath)) {
    const r = patchCordisYaml(fs.readFileSync(patchPath, 'utf8'));
    if (r.changed) {
      if (!dryRun) fs.writeFileSync(patchPath, r.yaml);
      log(`  cordis.patch.yml: 已更新${r.renamed.length > 0 ? `（${r.renamed.join('；')}）` : ''}`
        + `${r.added.length > 0 ? `（补上条目 ${r.added.join(', ')}）` : ''} —— 条目与 config 一律保留`);
    } else {
      log('  cordis.patch.yml: 无需改动');
    }
  } else {
    log('  cordis.patch.yml: 不存在（DSH 首次启动会创建；插件自带的 insert 会注册三个条目）');
  }

  /* —— 8) profile/.npmrc —— */
  const npmrcPath = path.join(profile, '.npmrc');
  const npmrcBefore = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : '';
  const npmrcAfter = mergeNpmrc(npmrcBefore);
  if (!dryRun && npmrcAfter !== npmrcBefore) fs.writeFileSync(npmrcPath, npmrcAfter);
  if (!/auto-install-peers\s*=\s*false/.test(npmrcBefore)) {
    log('  .npmrc: 已写 auto-install-peers=false（别让 pnpm 另装一份版本对不上的宿主包）');
  }

  /* —— 9) 宿主内包 —— */
  const host = discoverHost({ platform, env, home });
  if (host === undefined) {
    throw new Error('找不到 DSH 宿主自带的包目录（app.asar）。\n'
      + '装在非默认位置时用环境变量指明：\n'
      + '  DSH_HOST_ASAR="/path/to/resources/app.asar"\n'
      + '  DSH_HOST_MODULES="/path/to/dsh/node_modules"');
  }
  log(`宿主包目录: ${host.describe()}`);
  const closure = collectClosure(host, PLUGIN_TOP_LEVEL);
  const realMissing = [...closure.missing].filter((n) => !isPlatformNoise(n));
  log(`依赖闭包: ${closure.entries.size} 个包${realMissing.length > 0 ? `（缺失 ${realMissing.length}：${realMissing.slice(0, 4).join(', ')}）` : ''}`);

  const m = materializeClosure({ source: host, closure, vendorNm, dryRun, log });
  if (!dryRun) {
    log(`包实体: 新增/更新 ${m.packages} 个（${m.files} 个文件，${(m.bytes / 1048576).toFixed(1)} MB）`
      + `${m.reused > 0 ? `，沿用 ${m.reused} 个` : ''}`);
  }
  const l = linkTopLevel({ profileNm, names: PLUGIN_TOP_LEVEL, vendorNm, dryRun, log, platform });
  if (l.skipped.length > 0) {
    host.close();
    throw new Error(`${l.skipped.join(', ')} 未能装配到 ${vendorNm} —— 三个 provider 都不会注册`);
  }
  log(`软链: ${l.linked} 个宿主内包 → ${vendorNm}`);
  host.close();

  /* —— 10) 自检 —— */
  if (!dryRun && options.skipSelfTests !== true) {
    if (!fs.existsSync(path.join(pluginDir, 'lib'))) {
      // 没同步过的老 profile：跳过（apply-wotr.sh 在同样情况下也跳过）
      log('（插件目录未同步，跳过自检）');
    } else {
      const check = selfCheckHostDeps({ pluginDir, nodePath: process.execPath });
      if (!check.ok) {
        throw new Error(`装配后插件仍无法解析宿主内包：${check.error}\n三个 provider 都不会注册。`);
      }
      log('自检通过：插件已可解析宿主内包');
      const assembly = path.join(pluginDir, 'test', 'host-assembly.test.mjs');
      if (fs.existsSync(assembly)) {
        try {
          execFileSync(process.execPath, [assembly], {
            env: { ...env, DSH_PROFILE_DIR: profile },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          log('自检通过：host-assembly（三个入口在该 profile 下均可加载）');
        } catch (error) {
          const detail = String(error.stdout ?? error.stderr ?? error.message).split('\n').filter((x) => x.includes('✗'));
          throw new Error(`host-assembly 未通过 —— 插件在宿主里加载不了，provider 不会出现\n${detail.join('\n')}`);
        }
      }
    }
  }

  summary.steps.push(`插件 v${srcPkg.version} 已装入 ${pluginDir}`);
  summary.steps.push(`宿主内包 ${closure.entries.size} 个已装配`);
  return summary;
}

/** 时间戳（备份目录名）。 */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * 清掉 pnpm 装出来、会遮住宿主包的副本。
 *
 * 两类：
 *   1. `node_modules/<插件名>` —— 可能是软链进 `.pnpm` 的，解析 realpath 后会
 *      落在 `.pnpm/…` 里，那一层的 `node_modules` 装着 pnpm 从 npm 装的 peer 副本；
 *   2. `node_modules/.pnpm/*<插件名>*` —— 上面那个软链的真身，连同它的 peer 副本。
 *
 * 只删这两类（都在 profile 的 `node_modules` 下，且名字里带本插件名），
 * profile 里其他依赖一律不碰。
 */
export function neutralizePnpmCopies({ profileNm, pluginName = PLUGIN_NAME, dryRun = false, log = () => {} }) {
  const removed = [];
  const tag = dryRun ? '[dry-run] ' : '';
  const direct = path.join(profileNm, pluginName);
  const stat = fs.lstatSync(direct, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (!dryRun) {
      try { fs.unlinkSync(direct); } catch { fs.rmSync(direct, { recursive: true, force: true }); }
    }
    removed.push(direct);
    log(`  ${tag}清理 ${path.relative(profileNm, direct)}（${stat.isSymbolicLink() ? '软链' : '目录'}）`);
  }
  const pnpmDir = path.join(profileNm, '.pnpm');
  let entries = [];
  try { entries = fs.readdirSync(pnpmDir); } catch { entries = []; }
  for (const name of entries) {
    if (!name.includes(pluginName)) continue;
    const dir = assertInside(profileNm, path.join(pnpmDir, name));
    if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
    log(`  ${tag}清理 .pnpm/${name}`);
  }
  // 空掉的 .pnpm 一并收走：留着它没有任何用，还会让人以为「pnpm 装过一份」
  if (removed.length > 0 && !dryRun) {
    try {
      if (fs.readdirSync(pnpmDir).length === 0) fs.rmdirSync(pnpmDir);
    } catch { /* 还有别的包在用，留着 */ }
  }
  return removed;
}

/**
 * 语法检查一个文件。
 *
 * `node --check` 对 `.js` 在部分版本里按 CommonJS 解析（这些文件是 ESM），
 * 会误报 `Cannot use import statement outside a module`。所以失败时再用
 * 子进程 `import()` 复核一次 —— 真能 import 就是好文件。
 */
function syntaxCheck(file, log) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return;
  } catch (error) {
    try {
      const probe = `${file}.__syntax-probe__.mjs`;
      fs.writeFileSync(probe, `await import(${JSON.stringify(new URL(`file://${file}`).href)});`);
      try {
        execFileSync(process.execPath, [probe], { stdio: ['ignore', 'ignore', 'pipe'] });
        return;
      } finally {
        fs.rmSync(probe, { force: true });
      }
    } catch (error2) {
      log(`  ✗ ${path.basename(file)} 语法/加载检查未通过`);
      throw new Error(`${file} 未通过语法检查：${String(error.message).split('\n')[0]}`);
    }
  }
}
