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

import { QODER_PROVIDER, apply, currentQoderApi, inject, name } from '../lib/qoder.js';

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

  /**
   * apply 是**异步**注册的：`pool.scan()` → `createQoderShim()` → 目录 refresh
   * 都跑完才 `.then()` 里注册。所以必须等，但**不能睡一个固定值** —— 这个时长
   * 取决于本机有多少 qoder 凭据、扫描要不要读文件、目录链要不要打网络。
   *
   * 早先写的是 `setTimeout(300)`，结果在「本机有真实凭据、目录 refresh 真的发了
   * 一次网络请求」的机器上必然超时：注册没发生，8 条断言一起变红，而报出来的
   * 是「调用了 registerAdapter 一次 — 0」，看起来像代码把注册删了。
   * （注册失败时 `apply` 只走 `.catch()` 记日志，不会中断，所以「没抛」也说明不了什么。）
   *
   * 改成轮询等待「注册真的发生了」，并给一个足够宽的上限：正常的失败仍然只是
   * 让下面的断言变红，而不是把等待时间本身变成断言。
   */
  const waitFor = async (cond, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  };
  await waitFor(() => calls.adapters.length > 0 && calls.discoveries.length > 0);

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

/**
 * —— 2b) 配置真的生效：白名单 / 图片补勾 / 上下文预算 ——
 *
 * 这一段的三个字段以前**根本无法写入**（Config 上一个 volatile 字段都没有 →
 * 宿主的 volatileForm() 返回 undefined → describe() 跳过该入口、写入闸门抛
 * `has no volatile fields`）。所以这里既测「读出来生效」，也顺带把**生产形态**
 * 传进去：宿主交回来的字段是活引用 `{get(): T}`，直接对它做 `Array.isArray`
 * 永远是 false，会静默退化成「不限制」—— 用普通数组测就测不出这个坑。
 *
 * 另外钉住 discovery 与 adapter 的**一致性**：两处各写一份 input 判据就会出现
 * 「能发图但界面说不能」或反之，这是本轮修复的核心风险点。
 */
{
  const calls = { adapters: [], discoveries: [] };
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (ids, adapter) => {
        calls.adapters.push({ ids, adapter });
        return () => {};
      },
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: (ns, fn) => {
        calls.discoveries.push({ ns, fn });
        return () => {};
      },
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : undefined;
    },
  };

  // 生产形态：volatile 活引用
  const volatile = (v) => ({ get: () => v });
  apply(ctx, {
    enabledModelIds: volatile(['dfmodel', 'mmodel']),
    imageModelIds: volatile(['mmodel']),
    contextBudgets: volatile({ dfmodel: 50_000, mmodel: 999_999 }),
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (calls.adapters.length === 0 || calls.discoveries.length === 0)) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const discovered = await calls.discoveries[0].fn();
  const ids = discovered.map((m) => m.id).sort();
  ok('白名单生效：只列出勾选的两个模型', ids.join(',') === 'dfmodel,mmodel', ids.join(','));
  ok(
    '白名单之外的上游模型不下发（DSH 选择器看不到）',
    !ids.includes('qmodel') && !ids.includes('gmodel'),
    ids.join(','),
  );

  const byId = new Map(discovered.map((m) => [m.id, m]));
  ok(
    '上游 is_vl:true 的模型直接带 image（不需要补勾）',
    byId.get('dfmodel')?.inputModalities?.includes('image') === true,
    JSON.stringify(byId.get('dfmodel')?.inputModalities),
  );
  // mmodel 在上游是 is_vl:false，只能靠 imageModelIds 补勾 —— 与另两家同款
  // 「只加不减」语义：补勾能开，但不能用它撤销上游已给的图片能力。
  ok(
    'imageModelIds 能把上游标为纯文本的模型补成图片模型',
    byId.get('mmodel')?.inputModalities?.includes('image') === true,
    JSON.stringify(byId.get('mmodel')?.inputModalities),
  );

  const api = currentQoderApi();
  ok('跨入口句柄 currentQoderApi() 可用（管理页靠它）', api !== undefined && typeof api.directory === 'function');
  const raw = new Map(api.directory().map((m) => [m.id, m]));
  ok(
    '卡片看的是全量目录：被白名单滤掉的模型仍在 directory() 里',
    api.directory().length > discovered.length,
    `directory ${api.directory().length} / 下发 ${discovered.length}`,
  );
  ok(
    'contextBudgets 只下调：50k < 上游窗口时生效',
    byId.get('dfmodel')?.contextWindow === 50_000,
    String(byId.get('dfmodel')?.contextWindow),
  );
  ok(
    'contextBudgets 不抬升：给一个大于上游窗口的值，窗口保持上游值',
    byId.get('mmodel')?.contextWindow === raw.get('mmodel')?.contextWindow &&
      byId.get('mmodel')?.contextWindow < 999_999,
    `${byId.get('mmodel')?.contextWindow} vs 上游 ${raw.get('mmodel')?.contextWindow}`,
  );

  // discovery ↔ toPiModel 必须同源。两处都走 qoderInputModalities，一处改了
  // 另一处没改就是「能发图但界面说不能」。
  const piModels = calls.adapters[0]?.adapter?.current()?.profiles?.get('qoder')?.piProvider?.getModels?.();
  ok('能读到 adapter 实际下发的 pi 模型列表', Array.isArray(piModels) && piModels.length === 2, String(piModels?.length));
  const piById = new Map((piModels ?? []).map((m) => [m.id, m]));
  const mismatch = discovered.filter((d) => {
    const pi = piById.get(d.id);
    if (pi === undefined) return true;
    return pi.input?.includes('image') !== d.inputModalities?.includes('image');
  });
  ok(
    'discovery 与 toPiModel 的图片判据完全一致（一处改另一处不改 = 能发图却提示不支持）',
    mismatch.length === 0,
    JSON.stringify(mismatch.map((m) => m.id)),
  );
}

/**
 * —— 2c) 含图消息必须能拿到宿主的持久附件服务 ——
 *
 * 这一段钉的是用户实机报的那条错：
 *
 *     pi-ai image input requires the durable attachment service
 *
 * 它出现在 `dsh-llm-pi-ai` 的 `streamWithSnapshot` 里，是**准入闸门之后的
 * 第二道**判定：
 *
 *   1. `containsImage && !model.input.includes("image")` → 「模型不支持图片」
 *      （模型层，已由 qoderInputModalities 放行）；
 *   2. `const attachments = containsImage ? this.config.resolveAttachments?.() : undefined`
 *      —— 适配器没接线时这里就是 undefined；
 *   3. 于是抛「requires the durable attachment service」。
 *
 * 症状与第 1 层一模一样（用户看到的都是「图片用不了」），所以**只测模型层的
 * input 是测不出来的** —— 必须真的让适配器走一次含图 `stream()`。
 *
 * # 为什么这样测不花钱
 *
 * 附件服务用替身，`readImageRequest` 直接抛一个哨兵错误。图片物化发生在任何
 * 网络 I/O **之前**，所以：
 *   - 哨兵被抛出来 = 已经越过第 3 层、且宿主的附件服务真的被调用了；
 *   - 全程没有上行请求，不消耗额度（本机有真实凭据，这条很重要）。
 *
 * # 负向对照
 *
 * 同一个适配器配置**摘掉** `resolveAttachments` 再跑一遍，必须复现用户那条
 * 报错。没有这条对照，上面「哨兵被抛出」可能只是因为别的原因提前失败了。
 */
{
  const calls = { adapters: [], gets: 0 };
  const SENTINEL = new Error('哨兵：附件服务被调用了');
  const fakeAttachments = {
    async readImageRequest() {
      throw SENTINEL;
    },
  };

  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    get: (name) => {
      calls.gets += 1;
      return name === 'attachments' ? fakeAttachments : undefined;
    },
    llm: {
      registerAdapter: (ids, adapter) => {
        calls.adapters.push({ ids, adapter });
        return () => {};
      },
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : undefined;
    },
  };

  apply(ctx, {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && calls.adapters.length === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const adapter = calls.adapters[0]?.adapter;
  ok('拿到注册的 Qoder 适配器', adapter !== undefined);

  // 生产形态：一条带图用户消息（attachment 只有 id/尺寸，字节由宿主服务读）
  const imageMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image', attachment: { attachmentId: 'att-1', width: 64, height: 64 } },
    ],
  };
  const streamOnce = async (target) => {
    try {
      // eslint-disable-next-line no-unused-vars
      for await (const _chunk of target.stream({
        provider: 'qoder',
        model: 'dfmodel',
        messages: [imageMessage],
      })) {
        // 不该有帧：图片物化阶段就抛了
      }
      return undefined;
    } catch (e) {
      return e;
    }
  };

  ok(
    '适配器配置里带了 resolveAttachments（Trae 一直有，Qoder 原先漏了）',
    typeof adapter.config.resolveAttachments === 'function',
    typeof adapter.config.resolveAttachments,
  );
  ok(
    '注册期不取附件服务（懒取值：服务可能比插件晚就绪）',
    calls.gets === 0,
    String(calls.gets),
  );
  ok(
    '取值拿到的就是宿主那个附件服务（ctx.get("attachments")）',
    adapter.config.resolveAttachments() === fakeAttachments,
  );

  const profile = adapter.current().profiles.get('qoder');
  ok(
    '图片预算三件套与 Trae 逐字同值',
    profile.maxRequestImageBytes === 20971520
      && profile.requestImagePixelBudget === 4194304
      && profile.requestImageMaxBytes === 1048576,
    JSON.stringify({
      maxRequestImageBytes: profile.maxRequestImageBytes,
      requestImagePixelBudget: profile.requestImagePixelBudget,
      requestImageMaxBytes: profile.requestImageMaxBytes,
    }),
  );

  // 诊断自述：管理页路由靠它回答「跑的是哪一版代码」（部署后必须重启才生效，
  // 而两层的报错长得几乎一样，没有这个标志就只能靠试发图判断）。
  const api = currentQoderApi();
  ok('currentQoderApi().capabilities().imageAttachments 为 true',
    api?.capabilities?.().imageAttachments === true,
    JSON.stringify(api?.capabilities?.()));

  const sentinel = await streamOnce(adapter);
  ok(
    '**含图消息不再抛「requires the durable attachment service」**',
    sentinel === SENTINEL,
    sentinel === undefined ? '没有抛错（图片可能被静默丢掉了）' : sentinel.message,
  );
  ok('  图片字节确实去宿主附件服务读了', calls.gets >= 1, String(calls.gets));

  // 负向对照：摘掉这一行，必须复现用户实机那条报错。
  const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai');
  const withoutService = new PiAiAdapter({
    ...adapter.config,
    resolveAttachments: undefined,
  });
  const broken = await streamOnce(withoutService);
  ok(
    '负向对照：摘掉 resolveAttachments 就复现那条报错（证明上面的哨兵不是别的原因）',
    typeof broken?.message === 'string'
      && broken.message.includes('requires the durable attachment service'),
    broken?.message,
  );
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
  // 这里**不能**睡固定值：`apply` 是异步注册的，本机有真实凭据时它还会真发一次
  // 目录网络请求，满载的机器上 300ms 不够 —— 于是断言红的是「等待时间」而不是
  // 被验的兜底逻辑（实测在门禁里偶发过一次）。改成轮询「注册真的发生了」。
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && seen.length === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  ok('没有 loader entry 时回落到 qoder（而不是 undefined）', seen[0] === 'qoder', String(seen[0]));
}

/* —— 4) 号池三件套：设置 → 池的那条线（本包「切换到此账号」的全部机制） —— */
{
  /**
   * 这一段的背景是真机 bug：管理页把「当前账号」写进**自己的**池实例，而请求
   * 路径用的是 provider 入口的**另一个**池，于是「固定了账号，请求还是打到别的
   * 号上」。修法是让 `dsh-connect-qoder` 的 settings 当唯一真相来源，provider
   * 在启动与 `loader/volatile-update` 时把它推给池。
   *
   * 所以这里必须钉住三件事：
   *   1. 启动时读得到（重启后「当前账号」还在）；
   *   2. `loader/volatile-update` 之后立刻换过来（点完按钮下一次请求就生效）；
   *   3. 活引用每次重新解引用 —— 缓存住第一次的值就永远换不过来了。
   */
  const handlers = new Map();
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : undefined;
    },
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
  };

  // 生产形态：volatile 活引用，且值可以变（= 用户在设置页保存）
  let selected = '';
  let disabled = [];
  let reserves = {};
  const before = currentQoderApi();
  apply(ctx, {
    selectedAccountId: { get: () => selected },
    disabledAccountIds: { get: () => disabled },
    creditReserves: { get: () => reserves },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && currentQoderApi() === before) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const api = currentQoderApi();
  ok('provider 发布了 syncPoolConfig（管理页出快照前调它）', typeof api?.syncPoolConfig === 'function');
  ok('这一次 apply 发布了新的句柄', api !== before && api !== undefined);
  /**
   * **本 bug 的根因断言**：管理页那条 `qoderPool()` 必须就是 provider 这个池。
   * 以前它无条件 `new QoderAccountPool(...)`，于是设置页写的是 A、请求路径用
   * 的是 B ——「固定了账号，请求还是打到别的号上」。
   */
  const { qoderPool } = await import('../lib/index.js');
  ok('管理页 qoderPool() 复用 provider 的池（同一个对象）', qoderPool() === api.pool);

  // ① 启动时把设置读进池
  selected = 'account-from-settings';
  disabled = ['account-off'];
  reserves = { 'account-off': 30 };
  const applied = api.syncPoolConfig();
  ok('syncPoolConfig 读到了 settings 里的当前账号', api.pool.selectedAccountId() === 'account-from-settings', String(api.pool.selectedAccountId()));
  ok('syncPoolConfig 把停用列表推给了池', api.pool.disabledIdsInOrder().length === 0 && api.pool.isDisabled('account-off') === true);
  ok('syncPoolConfig 把保留额度推给了池', api.pool.creditReserveOf('account-off') === 30, String(api.pool.creditReserveOf('account-off')));
  ok('返回值就是推下去的那份配置', applied.selectedAccountId === 'account-from-settings' && applied.creditReserves['account-off'] === 30);

  // ② 宿主发 volatile-update → 池跟着换（不必重启、不必等下一次请求）
  ok('注册了 loader/volatile-update 监听', handlers.has('loader/volatile-update'));
  selected = 'another-account';
  handlers.get('loader/volatile-update')?.();
  ok('保存后池里的当前账号跟着变', api.pool.selectedAccountId() === 'another-account', String(api.pool.selectedAccountId()));

  // ③ 清空选择 = 回到「池里第一个账号」这个确定性默认值
  selected = '';
  api.syncPoolConfig();
  ok('清空 selectedAccountId 后回到未选定', api.pool.selectedAccountId() === undefined);
}

/* —— 5) 装配层缺口：exports 白名单必须有 ./qoder —— */
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
