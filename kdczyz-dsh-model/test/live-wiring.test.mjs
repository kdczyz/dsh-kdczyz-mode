/**
 * 「实时目录」在三家平台的**接线**测试。
 *
 * live-catalog.test.mjs 钉的是协调器本身；这里钉的是**接线是否真的存在**——
 * 这类改动的失败方式很隐蔽：协调器写得再对，只要没人调用 `ensureFresh()`，
 * 行为就与改造前完全一样（倍率永远是启动快照），而所有既有测试仍然全绿。
 *
 * 所以本文件用**源码结构断言 + 真实导入调用**两层来钉：
 *
 *   1. 结构层：三家的读路径上都挂了 `ensureFresh()`、都在内容变化时广播；
 *   2. 行为层：直接构造一个假 catalog 走一遍 `createXxxAdapter().getModels()`，
 *      证明读路径真的调用了钩子、且钩子抛错不会把模型表带崩。
 *
 * 运行：node test/live-wiring.test.mjs
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');
const vendor = join(here, '..', 'vendor', 'xdpool', 'lib');

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

const read = (file) => fs.readFileSync(file, 'utf8');

console.log('三家「实时目录」接线\n');

/* —— 1) Qoder —— */
{
  console.log('1) Qoder');
  const src = read(join(lib, 'qoder.js'));

  ok('导入了 live-catalog', /from '\.\/live-catalog\.mjs'/.test(src));
  ok('导入 catalogSignature', /catalogSignature/.test(src));
  ok('建了 liveFeed', /createLiveRefresher\(\{/.test(src));
  ok('读路径（visibleModels）触发 ensureFresh', /const visibleModels = \(\) => \{\s*\n\s*liveFeed\.ensureFresh\(\)/.test(src));
  ok('内容变化时广播（adapter.replace）', /registration\.adapter\?\.replace\?\.\(\[QODER_PROVIDER\]\)/.test(src));
  ok('启动种子后 markFresh', /liveFeed\.markFresh\(liveFeedSignature\(\)\)/.test(src));
  ok('discovery 等待刷新（Models 页点一次就是新的）', /const pending = liveFeed\.ensureFresh\(\)/.test(src));
  ok('dispose 时释放', /liveFeed\.dispose\(\)/.test(src));
}

/* —— 2) WorkBuddy（vendored） —— */
{
  console.log('\n2) WorkBuddy（vendored）');
  const src = read(join(vendor, 'index.js'));

  ok('adapter 读路径有 beforeModels 钩子', /options\.beforeModels\?\.\(\)/.test(src));
  ok('钩子被 try/catch 包住（读路径不会被打崩）', /try \{\s*\n\s*options\.beforeModels\?\.\(\);\s*\n\s*\} catch \{/.test(src));
  ok('两个 region 都注入 ensureLiveCatalog', (src.match(/beforeModels: ensureLiveCatalog/g) ?? []).length === 2);
  ok('有 TTL 节流', /liveLastOkAtMs > 0 && Date\.now\(\) - liveLastOkAtMs < liveTtlMs/.test(src));
  ok('有并发合并', /if \(liveInflight !== undefined\) return;/.test(src));
  ok('有失败退避', /liveLastAttemptAtMs > liveLastOkAtMs && Date\.now\(\) - liveLastAttemptAtMs < 15_000/.test(src));
  ok('失败不续命（只有成功才写 lastOkAtMs）', /liveLastOkAtMs = Date\.now\(\);/.test(src));
  ok('内容变化时 publishCatalog 广播', /publishCatalog\(\);\s*\n\s*\}\s*\n\s*\}\)/.test(src));
  ok('publishCatalog 通过 directory.replace 发事件', /releaseDirectory\?\.replace\?\.\(\[/.test(src));
  ok('api 暴露 publishCatalog 给管理页', /publishCatalog\(\) \{\s*\n\s*publishCatalog\(\);/.test(src));
  ok('启动种子后记录新鲜与签名', /liveLastOkAtMs = Date\.now\(\);\s*\n\s*liveSignature = liveSignatureOf\(\);/.test(src));
  ok('discovery 也吃实时目录', /ensureLiveCatalog\(\);\s*\n\s*await liveInflight/.test(src));
}

/* —— 3) Trae —— */
{
  console.log('\n3) Trae');
  const src = read(join(lib, 'trae.js'));

  ok('导入了 live-catalog', /from "\.\/live-catalog\.mjs"/.test(src));
  ok('adapter 读路径有 beforeModels 钩子', /options\.beforeModels\?\.\(\)/.test(src));
  ok('钩子被 try/catch 包住', /try \{\s*\n\s*options\.beforeModels\?\.\(\);\s*\n\s*\} catch \{/.test(src));
  ok('按 region 注入 liveFeeds', /beforeModels: \(\) => liveFeeds\[region\]\?\.ensureFresh\(\)/.test(src));
  ok('建了 liveFeeds', /const liveFeeds = \{\};/.test(src));
  ok('刷新走 discoverModels + derive 后写入 catalog', /stack\.catalog\.set\(derive\(current\(\), discovered, region\)\)/.test(src));
  ok('内容变化时广播（adapter.replace）', /registration\[region\]\.adapter\?\.replace\?\.\(/.test(src));
  ok('广播后重建适配器内部快照', /stacks\[region\]\?\.invalidateAdapter\?\.\(\)/.test(src));
  ok('liveFeeds 声明早于 dispose effect', src.indexOf('const liveFeeds = {};') < src.indexOf('liveFeeds?.[region]?.dispose?.()'));
  ok('启动种子后 markFresh', /liveFeeds\[region\]\?\.markFresh\(/.test(src));
  ok('dispose 时释放', /liveFeeds\?\.\[region\]\?\.dispose\?\.\(\)/.test(src));
  ok('注释保留了「卡片仍只读保存值」的产品语义', /仅手动获取上游模型在启用后才会更新模型列表/.test(src));
}

/* —— 4) 行为：读路径真的调用钩子，且钩子抛错不带崩 —— */
{
  console.log('\n4) 行为：读路径调用钩子');
  const { createTraeAdapter } = await import(join(lib, 'trae.js'));

  let hookCalls = 0;
  const fakeCatalog = {
    current: () => [
      { id: 'm1', name: 'Alpha', contextWindow: 128000, creditMultiplier: 0.79 },
    ],
  };
  const adapter = createTraeAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1' },
    catalog: fakeCatalog,
    provider: 'trae-test',
    displayName: 'Trae Test',
    beforeModels: () => {
      hookCalls += 1;
    },
  });
  const models = adapter.adapter.listModels
    ? await adapter.adapter.listModels('trae-test')
    : adapter.adapter.getModels('trae-test');
  ok('listModels 触发了 beforeModels 钩子', hookCalls > 0, `calls=${hookCalls}`);
  ok('模型表仍正常返回', Array.isArray(models) && models.length === 1);
  ok('倍率进了展示名', models[0]?.name?.includes('0.79'), models[0]?.name);

  // 钩子抛错 → 不能把整个模型表带崩（否则 provider 会在选择器里整个消失）
  const adapter2 = createTraeAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1' },
    catalog: fakeCatalog,
    provider: 'trae-test2',
    displayName: 'Trae Test 2',
    beforeModels: () => {
      throw new Error('hook blew up');
    },
  });
  let threw = false;
  let models2;
  try {
    models2 = await adapter2.adapter.listModels('trae-test2');
  } catch {
    threw = true;
  }
  ok('钩子抛错不会让读路径抛错', threw === false);
  ok('钩子抛错时模型表仍完整', Array.isArray(models2) && models2.length === 1);
}

console.log(`\nlive-wiring: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
