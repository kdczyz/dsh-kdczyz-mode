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
const PLUGIN = path.join(PROFILE_NM, 'dsh-wotr-console');

/** 三个入口在模块顶层直接 import 的宿主内包。 */
const REQUIRED = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
];

/* —— 1) profile 里到底装没装 —— */
console.log('profile:', PROFILE);
if (!fs.existsSync(PLUGIN)) {
  skipped('profile 里没有 dsh-wotr-console', '尚未部署到该 profile');
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
  const entries = [
    ['lib/index.js', 'llm-workbuddy-xdpool'],
    ['lib/trae.js', 'dsh-connect-trae'],
    ['lib/qoder.js', 'dsh-connect-qoder'],
  ];
  for (const [rel, entryId] of entries) {
    const file = path.join(PLUGIN, rel);
    if (!fs.existsSync(file)) { ok(`${rel} 存在`, false, file); continue; }
    try {
      const mod = await import(pathToFileURL(file).href);
      ok(`${rel} 可加载且导出 apply`, typeof mod.apply === 'function',
        `apply=${typeof mod.apply}`);
    } catch (error) {
      // 这里失败 = 宿主里也会失败，且**宿主不会报错**，只有 provider 静默消失
      ok(`${rel} 可加载且导出 apply`, false, `${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
    }
  }

  /* —— 4) package.json 的 exports 白名单（子路径入口的前提）—— */
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
    ok('exports 声明了 ./qoder', pkg.exports?.['./qoder'] === './lib/qoder.js', String(pkg.exports?.['./qoder']));
    ok('exports 声明了 ./trae', typeof pkg.exports?.['./trae'] === 'string');
  } catch (error) {
    ok('package.json 可读', false, error.message);
  }
}

console.log(`\nhost-assembly: ${pass} 通过, ${fail} 失败${skip > 0 ? `, ${skip} 跳过` : ''}`);

/**
 * 显式退出：上面 import 的入口模块（qoder.js 等）会起 loopback shim、
 * 持有 HTTP server 句柄，不显式退出会挂住整个测试进程。
 */
process.exit(fail > 0 ? 1 : 0);
