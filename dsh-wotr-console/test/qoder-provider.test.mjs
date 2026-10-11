/**
 * `lib/qoder.js` 的 **provider 注册**测试：`apply()` 必须真的把 `qoder` 注册上去。
 *
 * # 为什么这条最该测
 *
 * 用户报的现象是「模型选择器里选不到 qoder」。那正是**注册**这一层的失败，
 * 而它跟"签名对不对""编码对不对"完全无关 —— 注册没发生时，链路再对也白搭。
 * 已实测过两个会静默导致不注册的配置缺口：
 *
 *   1. `package.json` 的 `exports` 缺 `./qoder` → Loader 解析不了模块；
 *   2. profile 层 `cordis.patch.yml` 缺条目 → Loader 压根不加载。
 *
 * 这两条在**本测试里测不到**（它们发生在插件外部的装配层），所以这里盯的是
 * **模块内的等价风险**：`apply()` 里任何一处抛错都会让注册半途而废，而
 * `.catch()` 只记日志、不中断 —— 表现为"插件加载了但模型列表里没有 qoder"。
 *
 * 因此断言：`registerAdapter` / `registerConfigurableProviders` /
 * `registerModelDiscovery` **三个都被调用**，且 provider id 是 `qoder`。
 * 少任何一个都会让模型在选择器里不出现或不可用。
 *
 * # 为什么用假 ctx 而不是起真宿主
 *
 * `apply` 只用 `ctx.llm` / `ctx.effect` / `ctx.logger` / `ctx.fiber` 四个面。
 * 假 ctx 能精确断言"调了什么、传了什么"，而起真宿主只能断言"没抛"。
 *
 * 运行：node test/qoder-provider.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QODER_PROVIDER, apply, inject, name } from '../lib/qoder.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};

console.log('Qoder provider 注册\n');

/* —— 1) 模块元数据 —— */
ok('插件名是 dsh-connect-qoder（entry id 由它派生）', name === 'dsh-connect-qoder', name);
ok('provider id 是 qoder', QODER_PROVIDER === 'qoder', QODER_PROVIDER);
ok('inject 只要 llm（不依赖 webServer 之类的可选服务）', Array.isArray(inject) && inject.includes('llm'), JSON.stringify(inject));

/* —— 2) apply() 必须完成三处注册 —— */
{
  const calls = { adapters: [], directories: [], discoveries: [], effects: [] };
  const logger = { error: [], warn: [], info: [] };
  const disposers = [];

  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
    logger: {
      error: (...a) => logger.error.push(a),
      warn: (...a) => logger.warn.push(a),
      info: (...a) => logger.info.push(a),
    },
    llm: {
      registerAdapter: (ids, adapter) => {
        calls.adapters.push({ ids, adapter });
        return () => {};
      },
      registerConfigurableProviders: (list) => {
        calls.directories.push(list);
        return () => {};
      },
      registerModelDiscovery: (ns, fn) => {
        calls.discoveries.push({ ns, fn });
        return () => {};
      },
    },
    effect: (fn) => {
      calls.effects.push(fn);
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };

  apply(ctx, {});

  // apply 是异步注册的（池 scan + shim 起来之后才注册），等一拍
  await new Promise((r) => setTimeout(r, 300));

  ok('apply 没有把错误吞进 logger.error', logger.error.length === 0, JSON.stringify(logger.error[0]?.[1]?.message ?? ''));

  ok('调用了 registerAdapter 一次', calls.adapters.length === 1, String(calls.adapters.length));
  ok(
    'adapter 注册在 qoder 这个 provider id 下',
    calls.adapters[0]?.ids?.length === 1 && calls.adapters[0].ids[0] === QODER_PROVIDER,
    JSON.stringify(calls.adapters[0]?.ids),
  );
  ok('传入了 adapter 实例', calls.adapters[0]?.adapter !== undefined);

  ok('调用了 registerConfigurableProviders 一次', calls.directories.length === 1, String(calls.directories.length));
  ok(
    '声明了 qoder provider 且 displayName 是 Qoder',
    calls.directories[0]?.[0]?.provider === QODER_PROVIDER && calls.directories[0][0].displayName === 'Qoder',
    JSON.stringify(calls.directories[0]?.[0]),
  );
  ok(
    'settingsNs 取的是 loader entry id（不是硬编码裸名）',
    calls.directories[0]?.[0]?.settingsNs === 'dsh-connect-qoder',
    String(calls.directories[0]?.[0]?.settingsNs),
  );

  ok('调用了 registerModelDiscovery 一次', calls.discoveries.length === 1, String(calls.discoveries.length));
  ok('模型发现用同一个 settingsNs', calls.discoveries[0]?.ns === 'dsh-connect-qoder', String(calls.discoveries[0]?.ns));

  // 模型发现至少要给出兜底目录 —— 空目录会让 provider 在选择器里"有名字没模型"
  const models = await calls.discoveries[0].fn();
  ok('模型发现返回非空目录（有兜底）', Array.isArray(models) && models.length > 0, String(models?.length));
  ok(
    '每个模型都带 contextWindow（缺它 DSH 会拒掉整个 provider）',
    models.every((m) => typeof m.contextWindow === 'number' && m.contextWindow > 0),
    JSON.stringify(models.map((m) => m.contextWindow)),
  );
  ok(
    '每个模型都有 id 与 name',
    models.every((m) => typeof m.id === 'string' && m.id !== '' && typeof m.name === 'string'),
  );

  ok('注册了清理 effect（热重载时要能摘干净）', calls.effects.length >= 1, String(calls.effects.length));

  // 清理必须不抛
  let disposeThrew = false;
  for (const d of disposers) {
    try {
      d();
    } catch {
      disposeThrew = true;
    }
  }
  ok('清理函数全部不抛', !disposeThrew);
}

/* —— 3) 缺 settingsNs 时回落到裸名（不崩） —— */
{
  const seen = [];
  const ctx = {
    fiber: undefined, // 没有 loader entry → settingsNamespaceOf 走兜底
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: (list) => {
        seen.push(list[0]?.settingsNs);
        return () => {};
      },
      registerModelDiscovery: () => () => {},
    },
    effect: () => {},
  };
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));
  ok('没有 loader entry 时回落到 qoder（而不是 undefined）', seen[0] === 'qoder', String(seen[0]));
}

/* —— 4) 装配层缺口：exports 白名单必须有 ./qoder —— */
{
  // 这条测的是 package.json 本身。缺它 Loader 解析 `dsh-wotr-console/qoder`
  // 会直接失败，且报错发生在插件外，从插件代码里完全看不出来。
  const pkgPath = path.resolve(import.meta.dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  ok('package.json 的 exports 声明了 ./qoder', pkg.exports?.['./qoder'] === './lib/qoder.js', String(pkg.exports?.['./qoder']));
  ok('exports 声明了 ./trae（同一套装配机制）', typeof pkg.exports?.['./trae'] === 'string');
  ok('files 包含 vendor（wasm 备选路径要随包走）', Array.isArray(pkg.files) && pkg.files.includes('vendor'));

  // cordis.patch.yml 必须声明 qoder 条目，且 name 指向 ./qoder 子路径
  const patchPath = path.resolve(import.meta.dirname, '../cordis.patch.yml');
  const patch = fs.readFileSync(patchPath, 'utf8');
  ok('cordis.patch.yml 里有 dsh-connect-qoder 条目', patch.includes('dsh-connect-qoder'));
  ok('该条目的 name 指向 dsh-wotr-console/qoder', /name:\s*dsh-wotr-console\/qoder\b/.test(patch));
}

console.log(`\nqoder-provider: ${pass} 通过, ${fail} 失败`);

/**
 * ⚠️ **必须显式退出**。
 *
 * `apply()` 会起一个 loopback shim（`createQoderShim`），它持有一个 HTTP
 * server 句柄；即使测试里调了清理函数，Node 也可能因为还有活跃句柄而不退出，
 * 表现为「断言全部打印完了但进程一直挂着」——在 CI 里就是一条永远不结束的
 * 测试。`process.exit` 是这里唯一可靠的做法（退出码照旧反映成败）。
 */
process.exit(fail > 0 ? 1 : 0);
