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
 * 安装器自己装配，跑完即可用。**装完再跑 `pnpm install` 也验过**（pnpm 11.7.0，
 * 把这个 profile 原样喂给它）：手工放的 9 个宿主内包软链原样保留，插件那条被
 * 规范成 `node_modules/dsh-wotr-console -> ../.dsh-wotr-src`，全程不碰 git。
 *
 * # 为什么要清「插件管理页留下的 git 依赖」
 *
 * 管理页那条路是 pnpm 解析 `github:<owner>/<repo>` 规格 —— 它**必须先调
 * `git ls-remote`**。Windows 默认没有 git，于是：
 *
 *     pnpm: Command failed with ENOENT: git ls-remote '…/dsh-workbuddy-mode.git' …
 *     spawn git ENOENT
 *
 * 而且**失败的痕迹留在 profile 里**：`package.json` 的依赖仍然是那个 git 规格，
 * 于是每次启动 DSH / 每次装插件都再报一次同样的错。安装器把三处一并清掉：
 *
 *   1. 各依赖段里任何指向本仓库的 git/URL 规格 → 换成 `link:.dsh-wotr-src`
 *   2. `dsh.profile.bundles` 里同样的规格 → 换成包名
 *   3. `pnpm-lock.yaml` 里同一条解析记录 → 与清单对齐（管理页回滚时会跑
 *      `pnpm install --frozen-lockfile`，清单与锁文件不一致那一步会直接失败）
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
/** 仓库名（出现它的 git/URL 规格就是「指向本仓库」）。 */
export const REPO_HINT = 'dsh-workbuddy-mode';

/** `github:` / `git+https:` / `git@` / 裸 URL —— 这些都要 git 或直接下载。 */
const GIT_OR_URL_SPEC = /^(?:git\+|github:|git:|git@|ssh:\/\/|https?:\/\/)/i;

/**
 * 这个依赖规格是不是「指向本仓库的 git/URL 规格」。
 *
 * 判据两条**都要满足**：长得像 git/URL 规格，且提到本仓库名。
 * 只看前半条会把用户别的 git 依赖也当成我们的（不能动别人的东西）。
 */
export function looksLikeRepoSpec(spec, opts = {}) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!GIT_OR_URL_SPEC.test(trimmed)) return false;
  return trimmed.includes(opts.repoHint ?? REPO_HINT);
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export function patchProfilePackageJson(pkg, opts = {}) {
  const pluginName = opts.pluginName ?? PLUGIN_NAME;
  const oldNames = opts.oldNames ?? OLD_PACKAGES;
  const linkTarget = opts.linkTarget ?? '.dsh-wotr-src';
  const linkSpec = `link:${linkTarget.replace(/\\/g, '/')}`;
  const next = JSON.parse(JSON.stringify(pkg ?? {}));

  // 先清 git 规格：插件名那一处留着重写成 link:，别名（管理页可能按仓库名写）
  // 直接删掉 —— 清单里不需要两条指向同一个包的依赖。
  const removedSpecs = [];
  for (const section of DEP_SECTIONS) {
    const deps = next[section];
    if (deps === undefined || deps === null) continue;
    for (const [key, value] of Object.entries(deps)) {
      if (!looksLikeRepoSpec(value)) continue;
      // 只有 `dependencies` 是插件的归属地；dev/optional/peer 段里出现它
      // 一律删掉 —— 留着会让 profile 在两种解析结果之间摇摆。
      if (section === 'dependencies' && key === pluginName) { deps[key] = linkSpec; continue; }
      delete deps[key];
      removedSpecs.push(`${section}.${key}`);
    }
  }

  next.dependencies = next.dependencies ?? {};
  for (const old of oldNames) delete next.dependencies[old];
  next.dependencies[pluginName] = linkSpec;

  const rawBundles = next.dsh?.profile?.bundles ?? [];
  const bundles = [];
  const fixedBundles = [];
  for (const entry of rawBundles) {
    if (looksLikeRepoSpec(entry)) {
      if (!bundles.includes(pluginName)) bundles.push(pluginName);
      fixedBundles.push(String(entry));
      continue;
    }
    if (!bundles.includes(entry)) bundles.push(entry);
  }
  const kept = bundles.filter((b) => !oldNames.includes(b));
  if (!kept.includes(pluginName)) kept.push(pluginName);
  next.dsh = next.dsh ?? {};
  next.dsh.profile = { ...(next.dsh.profile ?? {}), bundles: kept };

  return {
    pkg: next,
    removed: oldNames.filter((o) => bundles.includes(o) || pkg?.dependencies?.[o] !== undefined),
    bundles: kept,
    removedSpecs,
    fixedBundles,
  };
}

/**
 * 改 profile 的 `pnpm-lock.yaml`：把指向本仓库的 git/URL 解析记录对齐成 `link:`。
 *
 * **只在文件里出现本仓库名时才动它** —— 别的锁文件内容（用户其它插件的解析
 * 记录）逐字保留。要清的是三处：
 *
 *   1. `importers` → `.` → 依赖块：`specifier:`/`version:` 都换成 `link:<目标>`
 *   2. `importers` 下**别的** importer 里的同名依赖：整块删掉（相对 `link:`
 *      只对 profile 根成立，装到别处就是错的）
 *   3. `packages` / `snapshots` 里以 `<包名>@<codeload URL>` 为键的条目：整块删掉
 *      （那是 pnpm 从 tar.gz 装出来的记录，与 `link:` 不再对应）
 *
 * 文本级改写而不是引 YAML 依赖：安装器要保持零依赖，且这个文件是 pnpm 生成的
 * 固定形状，按缩进处理足够稳。
 */
export function patchProfileLockfile(raw, opts = {}) {
  const pluginName = opts.pluginName ?? PLUGIN_NAME;
  const linkTarget = opts.linkTarget ?? '.dsh-wotr-src';
  const linkSpec = `link:${linkTarget.replace(/\\/g, '/')}`;
  const hint = opts.repoHint ?? REPO_HINT;
  const before = raw ?? '';
  if (!before.includes(hint)) return { text: before, changed: false, rewrote: [], removed: [] };

  const lines = before.split('\n');
  const out = [];
  const rewrote = [];
  const removed = [];
  let section = '';
  let importer = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const sec = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line);
    if (sec !== null) { section = sec[1]; importer = ''; out.push(line); i += 1; continue; }

    if (section === 'importers' && /^ {2}\S.*:\s*$/.test(line)) { importer = line.trim().replace(/:$/, ''); out.push(line); i += 1; continue; }

    // importers → <importer> → dependencies → 依赖块（键缩进 6，子项缩进 8）
    if (section === 'importers' && /^ {6}[^\s:][^:]*:\s*$/.test(line)) {
      const name = line.trim().replace(/:$/, '');
      let j = i + 1;
      const block = [];
      while (j < lines.length && /^ {8}\S/.test(lines[j])) { block.push(lines[j]); j += 1; }
      const body = block.join('\n');
      const mentionsRepo = body.includes(hint);
      if (name === pluginName && (mentionsRepo || !body.includes(linkSpec))) {
        out.push(`      ${pluginName}:`);
        out.push(`        specifier: ${linkSpec}`);
        out.push(`        version: ${linkSpec}`);
        const where = importer === '' || importer === '.' ? '' : `${importer}.`;
        rewrote.push(`${where}${pluginName}`);
        i = j; continue;
      }
      if (name !== pluginName && mentionsRepo) {
        removed.push(`importers.${importer === '' ? '.' : importer}.${name}`);
        i = j; continue;
      }
      out.push(line, ...block); i = j; continue;
    }

    // packages / snapshots 里指向本仓库的条目（键缩进 2，内容缩进 4）
    if ((section === 'packages' || section === 'snapshots') && line.includes(hint)
        && /^ {2}\S.*:(?:[ \t].*)?$/.test(line)) {
      let j = i + 1;
      // 内容缩进可能是 4（`resolution:`）也可能是 6（`peerDependencies:` 的子项），
      // 所以按「>= 4 个空格」吃掉整块，遇到空行或回到缩进 2 的键为止。
      while (j < lines.length && /^ {4,}\S/.test(lines[j])) j += 1;
      removed.push(`${section}.${line.trim().replace(/(?::[ \t].*)?$/, '')}`);
      i = j; continue;
    }

    out.push(line); i += 1;
  }

  // 删空了的 packages / snapshots 节连节头一起去掉（`packages:` 后面什么都没有
  // 在 YAML 里是 null，pnpm 读它会当成空对象从而报解析错）。
  const final = [];
  const isHeader = (l) => /^([A-Za-z][A-Za-z0-9_-]*):\s*$/.test(l);
  for (let k = 0; k < out.length; k += 1) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*$/.exec(out[k]);
    if (m !== null && (m[1] === 'packages' || m[1] === 'snapshots')) {
      let j = k + 1;
      let hasEntry = false;
      while (j < out.length && !isHeader(out[j])) { if (/^ {2}\S/.test(out[j])) { hasEntry = true; break; } j += 1; }
      if (!hasEntry) {
        let j2 = k + 1;
        while (j2 < out.length && out[j2].trim() === '') j2 += 1;
        removed.push(`${m[1]}（整节已空）`);
        k = j2 - 1;
        continue;
      }
    }
    final.push(out[k]);
  }

  // 可选：补上 `settings:` 块。锁文件里那句 `autoInstallPeers: false` 是 pnpm
  // 写在文件里的约定 —— 之后每次 `--frozen-lockfile` 都会拿当前配置跟它比，
  // 不一致就以 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH 失败。补上它，再由
  // patchProfileWorkspace 把同样的值写进 pnpm-workspace.yaml，两边才自洽。
  if (opts.ensureSettings === true && !/^settings:/m.test(final.join('\n'))) {
    const at = final.findIndex((l) => /^lockfileVersion:/.test(l));
    final.splice(at < 0 ? 0 : at + 1, 0, '',
      'settings:', '  autoInstallPeers: false', '  excludeLinksFromLockfile: false');
    removed.push('settings（补上 autoInstallPeers: false）');
  }

  // 连续空行压成一个，去掉尾部空行
  const text = final.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
  return { text, changed: rewrote.length > 0 || removed.length > 0, rewrote, removed };
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

/**
 * 让 `pnpm-workspace.yaml` 与锁文件里记的设置一致。
 *
 * 实测（pnpm 11.7.0）：profile 里光有 `.npmrc` 的 `auto-install-peers=false` 不够 ——
 * `pnpm install --frozen-lockfile` 仍会以
 *
 *     ERR_PNPM_LOCKFILE_CONFIG_MISMATCH: The current "settings.autoInstallPeers"
 *     configuration doesn't match the value found in the lockfile
 *
 * 失败，而这一步**什么都不装**（插件就没了）。把同一个值写进
 * `pnpm-workspace.yaml` 才作数 —— DSH 自己建的 profile 本来就是这么写的
 * （`packages: ['.']` / `nodeLinker: hoisted` / `autoInstallPeers: false`），
 * 所以这里通常是「一字不改」，只在新设备上 profile 被人动过时才补。
 */
export function patchProfileWorkspace(raw, opts = {}) {
  const want = opts.autoInstallPeersOff !== false;
  const before = raw ?? '';
  if (!want) return { text: before, changed: false };
  if (before.trim() === '') {
    return { text: 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', changed: true, created: true };
  }
  const lines = before.split('\n');
  const at = lines.findIndex((l) => /^autoInstallPeers\s*:/.test(l));
  if (at >= 0) {
    if (/^autoInstallPeers\s*:\s*false\s*$/.test(lines[at])) return { text: before, changed: false };
    lines[at] = 'autoInstallPeers: false';
    return { text: lines.join('\n'), changed: true };
  }
  return { text: `${before.replace(/\s*$/, '')}\n\nautoInstallPeers: false\n`, changed: true };
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
    for (const f of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
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
  if (patched.removedSpecs.length > 0) {
    log(`  已清掉指向本仓库的 git 依赖：${patched.removedSpecs.join(', ')}（没装 git 的机器上它们必报 git ls-remote）`);
  }
  if (patched.fixedBundles.length > 0) {
    log(`  已把 bundles 里的 git 规格换成包名：${patched.fixedBundles.join(', ')}`);
  }

  // 同一个失败还会在 pnpm-lock.yaml 里留下一条解析记录（`github:…` → codeload
  // tar.gz）。清单已经改成 link:，锁文件不同步的话，管理页回滚时的
  // `pnpm install --frozen-lockfile` 会直接失败。
  const lockPath = path.join(profile, 'pnpm-lock.yaml');
  if (fs.existsSync(lockPath)) {
    const lockBefore = fs.readFileSync(lockPath, 'utf8');
    const lock = patchProfileLockfile(lockBefore, { linkTarget: '.dsh-wotr-src', ensureSettings: true });
    if (lock.changed) {
      if (!dryRun) fs.writeFileSync(lockPath, lock.text);
      log(`  pnpm-lock.yaml: 与清单对齐`
        + `${lock.rewrote.length > 0 ? `（改为 link: ${lock.rewrote.join(', ')}）` : ''}`
        + `${lock.removed.length > 0 ? `（处理 ${lock.removed.length} 处残留记录）` : ''}`);
      summary.steps.push('清理 pnpm-lock.yaml 里的 git 残留');

      // 锁文件里的 `settings.autoInstallPeers` 要能在 pnpm-workspace.yaml 里找到
      // 同一个值，否则 `--frozen-lockfile`（插件管理页的修复路径）会以
      // ERR_PNPM_LOCKFILE_CONFIG_MISMATCH 失败并且什么都不装。
      const wsPath = path.join(profile, 'pnpm-workspace.yaml');
      const ws = patchProfileWorkspace(fs.existsSync(wsPath) ? fs.readFileSync(wsPath, 'utf8') : '');
      if (ws.changed) {
        if (!dryRun) fs.writeFileSync(wsPath, ws.text);
        const where = ws.created === true ? '写出' : '补上';
        log(`  pnpm-workspace.yaml: ${where} autoInstallPeers: false（与锁文件一致）`);
        summary.steps.push('对齐 pnpm-workspace.yaml 的 autoInstallPeers');
      }
    }
  }

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
