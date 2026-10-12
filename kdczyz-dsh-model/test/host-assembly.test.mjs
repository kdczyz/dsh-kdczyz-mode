/**
 * 装配层测试：**插件在宿主里到底能不能被加载**。
 *
 * # 为什么这条测试必须存在
 *
 * 2026-10-11 真机故障：管理页能看到已登录的 Qoder 账号、额度也刷得出来，
 * 但模型选择器里 `qoder` 永远不出现。源码没问题、单测全绿 —— 断在**宿主装配**：
 *
 *   lib/qoder.js 顶层 import '@earendil-works/pi-ai' 与
 *   '@deepseek-ai/dsh-llm-pi-ai'，这些包只存在于 DSH 宿主（app.asar 内），
 *   profile 的 node_modules 里一个都没有 → ERR_MODULE_NOT_FOUND →
 *   **模块顶层求值就抛，apply() 根本不会执行**。
 *
 * 最阴的一点：`apply()` 里那层 `.catch(logger.error)` 也跑不到，
 * 所以全程零报错，现象只剩「provider 不在」。而既有的
 * `qoder-provider.test.mjs` 用假 ctx 直接 `import '../lib/qoder.js'`，
 * 解析走的是插件目录自己的 node_modules —— **测试环境的解析结果与宿主不一致**，
 * 于是 23 项断言全绿而真机全废。
 *
 * 这条测试盯的就是那个不一致：它不复刻 apply 的内部逻辑，
 * 只回答一个宿主才会问的问题 ——
 * **「从这个 profile 出发，那三个 specifier 解析得到吗？」**
 *
 * # 断言什么
 *
 * 1. profile 的 node_modules 里，插件所需的宿主内包**存在且可解析**；
 * 2. 每个包都能被真实 `import()`（不只看目录在不在 —— 软链到 asar 内部时
 *    目录"看起来"存在，但纯 Node 读会 ENOTDIR）；
 * 3. 三个 Loader 入口都能加载到 `apply` 是个函数（模块顶层 import 全过）。
 *
 * 运行：node test/host-assembly.test.mjs
 * 可选：DSH_PROFILE=/path/to/profile node test/host-assembly.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`); }
};
const skipped = (name, why) => { skip += 1; console.log(`  - ${name}（跳过：${why}）`); };

console.log('宿主装配（插件能否在 DSH 里被加载）\n');

const PROFILE = process.env.DSH_PROFILE_DIR
  ?? process.env.DSH_PROFILE
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PROFILE_NM = path.join(PROFILE, 'node_modules');

/**
 * 这个包在 profile 里装成什么名字，取决于安装方式，**不能硬编码**：
 *
 *   - 直接 `pnpm add kdczyz-dsh-model`        -> node_modules/kdczyz-dsh-model
 *   - `pnpm add dsh-kdczyz-mode@npm:kdczyz-dsh-model`（别名，插件页安装后的形态）
 *                                             -> node_modules/dsh-kdczyz-mode
 *
 * 早期这里写死 `node_modules/dsh-kdczyz-mode`，于是别名安装时能跑、
 * 直接安装时永远走"跳过"分支 —— 2026-10-12 真机故障（三个子插件全部未运行）
 * 正是被这条跳过掩盖的。所以改成：**从 profile 的 package.json 读真实声明**，
 * 读不到再退化为按目录扫描候选名。
 */
function resolvePluginRoot() {
  const candidates = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
    // dsh.profile.bundles 是宿主认的唯一真相：entry name 必须与它一致
    for (const name of manifest.dsh?.profile?.bundles ?? []) {
      if (typeof name === 'string' && name !== 'kdczyz-dsh-model' || name?.includes('kdczyz')) {
        candidates.push(name);
      }
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.includes('kdczyz')) candidates.push(name);
    }
  } catch {}
  candidates.push('dsh-kdczyz-mode', 'kdczyz-dsh-model');

  for (const name of [...new Set(candidates)]) {
    const dir = path.join(PROFILE_NM, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

const PLUGIN = resolvePluginRoot();
/** 实际安装名 —— entry name 必须与它一致，否则 loader 解析不到。 */
const PLUGIN_NAME = PLUGIN === undefined ? undefined : path.basename(PLUGIN);

/** 三个入口在模块顶层直接 import 的宿主内包。 */
const REQUIRED = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
];

/* —— 1) profile 里到底装没装 —— */
console.log('profile:', PROFILE);
console.log('插件安装名:', PLUGIN_NAME ?? '(未找到)');
if (PLUGIN === undefined) {
  skipped('profile 里没找到插件包', '尚未部署到该 profile');
} else {
  for (const spec of REQUIRED) {
    const pkgName = spec.split('/').slice(0, 2).join('/');
    const dir = path.join(PROFILE_NM, pkgName);
    ok(`profile 里存在 ${pkgName}`, fs.existsSync(dir), dir);
  }

  /* —— 2) 真实 import（软链到 asar 内部时这里会失败）—— */
  //
  // 只看目录存在是不够的：指向 `app.asar/...` 的软链 lstat 看起来正常，
  // 但纯 Node 打开会 ENOTDIR。唯一可靠的判据是真读一次包内容。
  const probeDir = path.join(PLUGIN, 'lib');
  const probe = path.join(probeDir, '__assembly-probe__.mjs');
  if (fs.existsSync(probeDir)) {
    fs.writeFileSync(probe, REQUIRED
      .map((s) => `await import(${JSON.stringify(s)});`)
      .join('\n'));
    let probeErr;
    try {
      // 必须用**子进程**跑：当前进程若已加载过这些包，模块缓存会掩盖失败
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.execPath, [probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      probeErr = String(error.stderr ?? error.message).split('\n')[0];
    } finally {
      fs.rmSync(probe, { force: true });
    }
    ok('插件能真实 import 全部宿主内包', probeErr === undefined, probeErr);
  }

  /* —— 3) 三个入口都能加载（顶层 import 全过 + 导出 apply）—— */
  //
  // 入口文件路径**跟随 manifest 的 exports**，不能写死 `lib/`：
  // wrapper 布局（node_modules/kdczyz-dsh-model，其内再套一层 kdczyz-dsh-model/）
  // 与裸包布局的相对深度不同，写死会在wrapper 布局下全部报「不存在」。
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  const resolveExport = (sub) => {
    const target = manifest.exports?.[sub];
    return typeof target === 'string' ? path.resolve(PLUGIN, target) : undefined;
  };
  const entries = [
    ['.', 'llm-workbuddy-xdpool'],
    ['./trae', 'dsh-connect-trae'],
    ['./qoder', 'dsh-connect-qoder'],
  ];
  for (const [sub, entryId] of entries) {
    const file = sub === '.' ? path.resolve(PLUGIN, manifest.main) : resolveExport(sub);
    if (file === undefined || !fs.existsSync(file)) {
      ok(`${sub} 解析到真实文件`, false, String(file));
      continue;
    }
    try {
      const mod = await import(pathToFileURL(file).href);
      ok(`${sub} 可加载且导出 apply`, typeof mod.apply === 'function',
        `apply=${typeof mod.apply}`);
    } catch (error) {
      // 这里失败 = 宿主里也会失败，且**宿主不会报错**，只有 provider 静默消失
      ok(`${sub} 可加载且导出 apply`, false, `${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
    }
  }

  /* —— 4) package.json 的 exports 白名单（子路径入口的前提）—— */
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
    ok('exports 声明了 ./qoder', typeof manifest.exports?.['./qoder'] === 'string', String(manifest.exports?.['./qoder']));
    ok('exports 声明了 ./trae', typeof manifest.exports?.['./trae'] === 'string');
  } catch (error) {
    ok('package.json 可读', false, error.message);
  }

  /* —— 5) Loader entry 名必须能从 profile 解析 —— */
  //
  // 2026-10-12 真机故障：包从 `dsh-kdczyz-mode` 改名为 `kdczyz-dsh-model` 后，
  // 包内 cordis.patch.yml 的三个 entry 名没跟着改，于是宿主报
  //
  //   1 entry did not activate llm-workbuddy-xdpool (dsh-kdczyz-mode): failed to import
  //
  // 而插件管理页只显示「未运行」，没有任何报错 —— 因为 Loader 按 entry 的
  // `name:` 去 import，而 `dsh-kdczyz-mode` 已经不是可解析的包名（它现在只是
  // kdczyz-dsh-model 内部的一个子目录）。
  //
  // 这条断言直接拿 patch 里声明的 name 去解析，是拦这个故障的第一道防线。
  const patchFile = path.join(PLUGIN, 'kdczyz-dsh-model', 'cordis.patch.yml');
  const patchCandidates = [patchFile, path.join(PLUGIN, 'cordis.patch.yml')]
    .filter((f) => fs.existsSync(f));
  if (patchCandidates.length === 0) {
    ok('找到 cordis.patch.yml', false, patchFile);
  } else {
    let patchText = fs.readFileSync(patchCandidates[0], 'utf8');
    // dsh.bundle.patch 可能指向别处，优先用 manifest 声明的那个
    const declaredPatch = manifest.dsh?.bundle?.patch;
    if (typeof declaredPatch === 'string') {
      const p = path.resolve(PLUGIN, declaredPatch);
      if (fs.existsSync(p)) patchText = fs.readFileSync(p, 'utf8');
    }
    const names = [...patchText.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    ok('patch 里声明了 Loader entry 名', names.length > 0, `找到 ${names.length} 个`);
    for (const name of names) {
      // 裸名 entry：必须能作为包名解析（这是 client 归属者）
      // 子路径 entry：所属包名必须能解析
      const pkgName = name.startsWith('@')
        ? name.split('/').slice(0, 2).join('/')
        : name.split('/')[0];
      let resolved;
      try {
        resolved = createRequire(path.join(PROFILE, 'package.json')).resolve(`${pkgName}/package.json`);
      } catch (error) {
        ok(`entry "${name}" 可解析`, false, `${pkgName} 解析失败: ${error.code ?? error.message}`);
        continue;
      }
      ok(`entry "${name}" 可解析`, fs.existsSync(resolved), resolved);
    }
  }

  /* —— 6) client bundle 唯一性（2026-10-12 启动崩溃的根因）—— */
  //
  // DSH 的 client-modules 对每个「声明了 dsh.client 的 package」emit 一份 client
  // bundle。wrapper 与内层 manifest 若都声明了，且归一化后指向**同一个物理
  // 文件**，这份代码会被打进同一个 module scope 两次：
  //
  //   Uncaught SyntaxError: Identifier 'XDPOOL_CLIENT_SRC' has already been declared
  //   -> entry 激活失败 -> web boot: 1 entry did not activate -> 应用起不来
  //
  // 归属规则（client-modules 的 locatePkgJson/resolveMeta，逐字核对过）：
  //   - 裸名 entry   expectedPackageName = 包名 -> 向上找 name 相等的 manifest；包装成
  //                  `kdczyz-dsh-model` 时归 **wrapper**
  //   - 子路径 entry `if (!pathLike && expectedPackageName === void 0) return void 0;`
  //                  -> **完全不贡献 client**，不会与裸名 entry 抢
  // 所以 client 必须且只能由 wrapper 声明 —— 这条断言就锁这个不变量。
  const claims = [];
  for (const dir of [PLUGIN, path.join(PLUGIN, 'kdczyz-dsh-model')]) {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
    const target = pkg.exports?.['./client'];
    if (typeof target !== 'string' && pkg.dsh?.client === undefined) continue;
    claims.push({
      name: pkg.name,
      manifest: path.relative(PROFILE_NM, manifestPath),
      file: typeof target === 'string' ? path.resolve(dir, target) : '(未声明 ./client)',
      declaresDshClient: pkg.dsh?.client !== undefined,
    });
  }
  const byFile = new Map();
  for (const c of claims) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c.name]);
  const collided = [...byFile.entries()].filter(([, names]) => names.length > 1);
  ok(
    '同一 client.js 只被一个 manifest 声明',
    collided.length === 0,
    collided.map(([f, names]) => `${path.relative(PROFILE_NM, f)} 被 ${names.join(' + ')} 同时声明`).join('; '),
  );
  // 声明了 dsh.client 的 manifest 必须同时给出 ./client，否则 resolveMeta 抛错
  for (const c of claims) {
    ok(
      `${c.name} 声明 dsh.client 时也提供 ./client`,
      !c.declaresDshClient || c.file !== '(未声明 ./client)',
      c.manifest,
    );
  }
}

console.log(`\nhost-assembly: ${pass} 通过, ${fail} 失败${skip > 0 ? `, ${skip} 跳过` : ''}`);

/**
 * 显式退出：上面 import 的入口模块（qoder.js 等）会起 loopback shim、
 * 持有 HTTP server 句柄，不显式退出会挂住整个测试进程。
 */
process.exit(fail > 0 ? 1 : 0);
