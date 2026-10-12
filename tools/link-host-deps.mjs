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
 * `node_modules` 里没有（DSH 自己也不会放 —— 这一点在本仓库里实测确认过）。
 * Node 从插件目录向上找 `node_modules`，一路到磁盘根都找不到，
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
 * asar 是单文件归档，纯 Node（以及宿主加载插件时走的模块解析）对
 * `app.asar/...` 路径会得到 `ENOTDIR`。所以软链到 asar 内部无效，
 * 必须把包内容真正写到磁盘上 —— 现在用纯 JS 读 asar（`tools/lib/asar.mjs`），
 * 不再依赖 Electron，也不再硬编码 macOS 路径。
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
 * 实现都在 `tools/lib/host-deps.mjs`。
 *
 * 用途只有两个：本机开发部署（`tools/apply-wotr.sh` 第 8 步调用本脚本）、
 * 以及让脱离 DSH 的裸 Node（本仓库的自检与单测）也能解析到宿主内包。
 * **新设备安装不需要这一步**：DSH 会在内存里把宿主内包路由给每个 profile
 * （见 README「零、安装」末尾「宿主内包不用你管」）。
 *
 * 用法：
 *   node tools/link-host-deps.mjs [profile目录] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  PLUGIN_TOP_LEVEL,
  collectClosure,
  discoverHost,
  isPlatformNoise,
  linkTopLevel,
  materializeClosure,
  selfCheckHostDeps,
} from './lib/host-deps.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const profileArg = args.find((a) => !a.startsWith('--'));
const PLUGIN_DIR_ARG = args.find((a) => a.startsWith('--plugin='))?.slice('--plugin='.length);
const PROFILE = profileArg ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const VENDOR_NM = path.join(PROFILE, '.dsh-runtime-deps', 'node_modules');
const PROFILE_NM = path.join(PROFILE, 'node_modules');
// 安装形态是「wrapper 根 + 内层包」：profile/node_modules/kdczyz-dsh-model/ 下只有
// package.json / README / LICENSE，真正的入口（lib/index.js 等）在内层同名目录里。
// 指向错一层会让自检报「插件目录里没有 lib/」，看起来像依赖没装配好。
const PLUGIN_DIR =
  PLUGIN_DIR_ARG ?? path.join(PROFILE_NM, 'kdczyz-dsh-model', 'kdczyz-dsh-model');

const log = (msg) => console.log(msg);

if (!fs.existsSync(PROFILE)) {
  console.error(`找不到 profile: ${PROFILE}`);
  process.exit(1);
}

/* —— 1) 定位宿主 —— */
const host = discoverHost();
if (host === undefined) {
  console.error('找不到 DSH 宿主自带的包目录。');
  console.error('请确认 DSH 已安装；装在非默认位置时用环境变量指明，例如：');
  console.error('  DSH_HOST_ASAR="/path/to/resources/app.asar" node tools/link-host-deps.mjs');
  console.error('  DSH_HOST_MODULES="/path/to/dsh/node_modules" node tools/link-host-deps.mjs');
  process.exit(1);
}
log(`宿主包目录: ${host.describe()}`);

/* —— 2) 依赖闭包 —— */
const closure = collectClosure(host, PLUGIN_TOP_LEVEL);
const realMissing = [...closure.missing].filter((n) => !isPlatformNoise(n));
log(`依赖闭包: ${closure.entries.size} 个包${realMissing.length > 0 ? `，缺失 ${realMissing.length}` : ''}`);
if (realMissing.length > 0) {
  log(`  （${realMissing.slice(0, 6).join(', ')}${realMissing.length > 6 ? ' …' : ''}）`);
}

/* —— 3) 装配 —— */
if (DRY) {
  log('[dry-run] 将写入:');
  log(`  ${VENDOR_NM}/  （${closure.entries.size} 个包的实体）`);
  log(`  ${PROFILE_NM}/{${PLUGIN_TOP_LEVEL.map((n) => n.split('/').pop()).join(', ')}}  （软链）`);
  host.close();
  process.exit(0);
}

const m = materializeClosure({ source: host, closure, vendorNm: VENDOR_NM, log });
log(`包实体: 新增/更新 ${m.packages} 个（${m.files} 个文件，${(m.bytes / 1048576).toFixed(1)} MB）`
  + `${m.reused > 0 ? `，沿用 ${m.reused} 个` : ''}`);

const l = linkTopLevel({ profileNm: PROFILE_NM, names: PLUGIN_TOP_LEVEL, vendorNm: VENDOR_NM, log });
if (l.skipped.length > 0) {
  console.error(`错误：${l.skipped.join(', ')} 未能装配到 ${VENDOR_NM}`);
  console.error('这三个 provider 都不会注册 —— 请把上面的报错发出来。');
  host.close();
  process.exit(1);
}
log(`软链: ${l.linked} 个`);
host.close();

/* —— 4) 自检 —— */
if (!fs.existsSync(PLUGIN_DIR)) {
  log(`（插件目录尚未同步：${PLUGIN_DIR}，跳过自检）`);
  process.exit(0);
}
const check = selfCheckHostDeps({ pluginDir: PLUGIN_DIR });
if (!check.ok) {
  console.error(`错误：装配后插件仍无法解析宿主内包 —— ${check.error}`);
  console.error('三个 provider 都不会注册。');
  process.exit(1);
}
log('自检通过：插件已可解析宿主内包');
