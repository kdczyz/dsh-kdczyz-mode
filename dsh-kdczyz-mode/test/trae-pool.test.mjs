/**
 * Trae 号池（TraeAccountPool）的单测。
 *
 * 为什么要有这个文件：号池是 Trae 侧**新增**的能力，它决定「请求用哪个账号、
 * 失败后换谁」。这部分错了不会抛异常、也不会报错 —— 表现为「明明还有别的
 * 登录，请求却一直失败」或者「所有额度都从同一个账号扣光」。
 * 以前的测试只能覆盖到渲染层，完全碰不到这里。
 *
 * 这里用一个假 store（提供若干账号的凭据）直接驱动池，覆盖：
 *   - scan 发现账号、保留已有冷却状态
 *   - 三种分配策略的取号行为
 *   - 429 只冷却该模型、402 冷却整个账号
 *   - 冷却中的账号被跳过；全都冷却时重新扫描
 *   - 停用 / 保留额度让账号退出轮换
 *   - 显式偏好（prefer）优先
 *
 * 运行：node test/trae-pool.test.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FALLBACK_TRAE_MODELS,
  TraeAccountPool,
  TraeCatalog,
  TraeCredentialStore,
  applyImageSelection,
  deriveCatalog,
  traeAccountId,
  traeOwnAccountAuthPath,
} from '../lib/trae.js';
import { saveTraeCredential } from '../lib/trae-auth.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};

/**
 * 假凭据 store。
 *
 * 只需要池用到的三个方法：readAll（列出全部账号）、credentialOf（按 id 取）、
 * resolveFor（按 id 取并刷新）。刻意不实现真实文件读写 —— 池不该关心凭据
 * 是从哪来的，那是 TraeCredentialStore 的事。
 */
function makeStore(count, { region = 'cn' } = {}) {
  const creds = [];
  for (let i = 0; i < count; i += 1) {
    creds.push({
      accessToken: `token-${i}`,
      refreshToken: `refresh-${i}`,
      userId: `user-${i}`,
      accountName: `账号${i}`,
      userRegion: region === 'ai' ? 'SG' : 'CN',
      edition: 'solo',
      source: 'desktop',
      expiresAtMs: Date.now() + 36e5,
    });
  }
  return {
    readAll: async () => [...creds],
    credentialOf: async (id) => creds.find((c) => `user-${creds.indexOf(c)}` === id) ?? creds.find((c) => c.userId === id),
    resolveFor: async (id) => creds.find((c) => c.userId === id),
  };
}

/** 池里账号 id 是 edition\0userId 的 sha256 前 24 位；这里取实际生成的值 */
async function idsOf(pool) {
  return pool.list().map((a) => a.id);
}

console.log('Trae 号池测试\n');

// —— 1) scan 发现账号 ——
{
  const pool = new TraeAccountPool({ store: makeStore(3) });
  const found = await pool.scan();
  ok('scan 发现全部 3 个账号', found.length === 3, `实际 ${found.length}`);
  ok('每个账号都有 id 与 label', found.every((a) => typeof a.id === 'string' && a.id !== '' && typeof a.label === 'string'));
  ok('新账号默认不在冷却', found.every((a) => a.cooldownUntilMs === 0));
  ok('status() 报出账号数与冷却数', pool.status().count === 3 && pool.status().cooling === 0);
}

// —— 2) scan 保留已有冷却状态 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.penalize(ids[0], Date.now() + 60_000);
  // 再扫一次：冷却必须还在（扫描是每次取号失败时都会跑的，不能把冷却抹掉）
  await pool.scan();
  ok('重新 scan 不清掉已有冷却', pool.list().find((a) => a.id === ids[0]).cooldownUntilMs > Date.now());
}

// —— 3) 三种分配策略 ——
for (const [dist, expect] of [
  ['priority', 'priority'],
  ['round-robin', 'round-robin'],
  ['balanced', 'balanced'],
]) {
  const pool = new TraeAccountPool({ store: makeStore(3), distribution: dist });
  await pool.scan();
  ok(`分配策略 ${dist} 被记住`, pool.currentDistribution() === expect);
}

// —— 4) priority：总是第一个，直到它被冷却 ——
{
  const pool = new TraeAccountPool({ store: makeStore(3), distribution: 'priority' });
  await pool.scan();
  const ids = await idsOf(pool);
  const first = await pool.acquire('m1');
  ok('priority 取第一个账号', first.id === ids[0]);
  // 冷却第一个 → 应换下一个
  pool.penalize(ids[0], Date.now() + 60_000);
  const second = await pool.acquire('m1');
  ok('priority 在被冷却后换下一个账号', second.id === ids[1], `实际 ${second?.id}`);
}

// —— 5) round-robin：依次轮换 ——
{
  const pool = new TraeAccountPool({ store: makeStore(3), distribution: 'round-robin' });
  await pool.scan();
  const ids = await idsOf(pool);
  const a = await pool.acquire('m1');
  const b = await pool.acquire('m1');
  const c = await pool.acquire('m1');
  ok('round-robin 连续三次取到三个不同账号', new Set([a.id, b.id, c.id]).size === 3, `${a.id},${b.id},${c.id}`);
  void ids;
}

// —— 6) 429 只冷却该模型，不影响同账号其它模型 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.penalize(ids[0], Date.now() + 60_000, 'model-A');
  const onOtherModel = await pool.acquire('model-B');
  const onCooledModel = await pool.acquire('model-A');
  ok('429 后同账号的其它模型仍可用', onOtherModel.id === ids[0], `实际 ${onOtherModel?.id}`);
  ok('429 后该模型换到别的账号', onCooledModel.id === ids[1], `实际 ${onCooledModel?.id}`);
}

// —— 7) 402 冷却整个账号 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.penalizeExhausted(ids[0]);
  const anyModel = await pool.acquire('m1');
  const otherModel = await pool.acquire('m2');
  ok('额度耗尽后该账号不再服务任何模型', anyModel.id === ids[1] && otherModel.id === ids[1]);
}

// —— 8) 全都冷却时返回 undefined（并已重新扫描过）——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  for (const a of pool.list()) pool.penalize(a.id, Date.now() + 60_000);
  const got = await pool.acquire('m1');
  ok('所有账号都冷却时取不到账号（返回 undefined）', got === undefined);
}

// —— 9) 停用账号退出轮换 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.applyConfig({ disabledAccountIds: [ids[0]] });
  const got = await pool.acquire('m1');
  ok('停用的账号不参与取号', got.id === ids[1]);
  ok('isDisabled 反映停用状态', pool.isDisabled(ids[0]) === true && pool.isDisabled(ids[1]) === false);
}

// —— 10) 保留额度：余额低于下限的账号退出轮换 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.noteCredits(ids[0], 50);
  pool.applyConfig({ creditReserves: { [ids[0]]: 100 } });
  const got = await pool.acquire('m1');
  ok('余额低于保留额度的账号退出轮换', got.id === ids[1], `实际 ${got?.id}`);
  // 余额充足 → 回到轮换
  pool.noteCredits(ids[0], 500);
  const back = await pool.acquire('m1');
  ok('余额充足后该账号重新可用', back.id === ids[0], `实际 ${back?.id}`);
}

// —— 11) 显式偏好优先 ——
{
  const pool = new TraeAccountPool({ store: makeStore(3) });
  await pool.scan();
  const ids = await idsOf(pool);
  pool.prefer(ids[2]);
  const got = await pool.acquire('m1');
  ok('prefer 指定的账号优先被取到', got.id === ids[2], `实际 ${got?.id}`);
}

// —— 12) noteServed / lastServedId ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  const ids = await idsOf(pool);
  ok('还没有请求时 lastServedId 为 undefined', pool.lastServedId() === undefined);
  pool.noteServed(ids[1]);
  ok('noteServed 后 lastServedId 记录下来', pool.lastServedId() === ids[1]);
}

// —— 13) 清除冷却 ——
{
  const pool = new TraeAccountPool({ store: makeStore(2) });
  await pool.scan();
  for (const a of pool.list()) pool.penalize(a.id, Date.now() + 60_000);
  pool.resetCooldowns();
  const got = await pool.acquire('m1');
  ok('清除冷却后账号重新可用', got !== undefined);
}

// —— 14) 无 store 时安全降级 ——
{
  const pool = new TraeAccountPool({});
  const got = await pool.acquire('m1');
  ok('没有 store 时取号返回 undefined（不抛）', got === undefined);
  ok('没有 store 时 scan 不抛', (await pool.scan()).length === 0);
}

// —— 15) 无账号时不抛 ——
{
  const pool = new TraeAccountPool({ store: makeStore(0) });
  const got = await pool.acquire('m1');
  ok('没有账号时取号返回 undefined（不抛）', got === undefined);
}

/**
 * —— 16) 登录落盘与号池读取必须对得上 ——
 *
 * 这是**真出过**的缺陷：号池改成「按账号分文件」后，`lib/trae.js` 的刷新
 * 路径与 `ownCandidates` 都改了，但 `lib/trae-auth.mjs` 的登录保存仍在写旧的
 * region 单文件 —— 于是「登录成功了，号池里却看不到这个账号」。
 *
 * 两个模块对账号 id 各有一份实现（有意重复，避免把 200KB+ 的 provider 模块
 * 拉进登录模块的依赖图），所以必须有一条断言守住「两边算出的 id 相同」，
 * 否则文件名对不上，store 永远读不回来。
 */
{
  const home = await mkdtemp(join(tmpdir(), 'trae-auth-pool-'));
  /**
   * 必须把 DSH_HOME 指到临时目录。
   *
   * `traeOwnAccountAuthPath` / `traeOwnAccountAuthPath` 走 resolveDshHome()，
   * 默认落在真实的 ~/.dsh —— 不隔离的话这条用例会读到开发机上真实的账号，
   * 断言「读回刚登录的账号」就永远不可靠（实测：读到的是本机桌面端登录）。
   */
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const saved = await saveTraeCredential({
      dshHome: home,
      accessToken: 'tok-abc',
      refreshToken: 'ref-abc',
      userId: 'user-42',
      accountName: '账号甲',
      edition: 'solo',
      region: 'cn',
      expiresAtMs: Date.now() + 36e5,
    });
    ok('saveTraeCredential 成功', saved.error === undefined, saved.error);
    ok('写的是**按账号**分文件（不是 region 单文件）', /^\.trae-auth\.cn\.[0-9a-f]{24}\.json$/.test(String(saved.path).split('/').pop()), String(saved.path));

    // 两边算出的 id 必须一致
    const expected = traeAccountId({ edition: 'solo', userId: 'user-42', accountName: '账号甲' });
    ok('trae-auth 与 trae.js 算出的 accountId 一致', saved.accountId === expected, `auth=${saved.accountId} js=${expected}`);
    ok('路径用的就是那个 id', String(saved.path) === traeOwnAccountAuthPath('cn', expected));

    // store 必须能读回来（这是「号池里看得到」的充要条件）
    const store = new TraeCredentialStore({ region: 'cn', edition: 'auto' });
    const all = await store.readAll();
    const hit = all.find((c) => c.userId === 'user-42');
    ok('store.readAll 能读回刚登录的账号', hit !== undefined, `读到 ${all.length} 个`);
    ok('读回的账号 id 与写入一致', hit !== undefined && traeAccountId(hit) === expected);

    // 池也该发现它
    const pool = new TraeAccountPool({ store });
    const list = await pool.scan();
    ok('号池 scan 能发现刚登录的账号', list.some((a) => a.id === expected), `池里 ${list.length} 个`);

    // 同一账号重复登录只覆盖自己那份，不产生第二个文件
    await saveTraeCredential({
      dshHome: home,
      accessToken: 'tok-abc-2',
      refreshToken: 'ref-abc-2',
      userId: 'user-42',
      accountName: '账号甲',
      edition: 'solo',
      region: 'cn',
      expiresAtMs: Date.now() + 72e5,
    });
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(home).filter((n) => n.startsWith('.trae-auth'));
    ok('同一账号重复登录只产生一个文件', files.length === 1, files.join(', '));
    const doc = JSON.parse(await readFile(join(home, files[0]), 'utf8'));
    ok('文件内容已更新为新 token', doc.credential.accessToken === 'tok-abc-2');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * —— 17) 卡片显示的必须是**运行时目录**，不是保存快照 ——
 *
 * 这是「为什么不能像 WorkBuddy 一样同步模型」的答案所在：
 *
 *   WorkBuddy 卡片读 `catalogs[region].current()` —— 启动时从上游拉、之后由模型
 *   发现刷新的**实时目录**；
 *   Trae 原先读 `displayModels()` —— `lastCatalog` 这个**保存值**，没保存过就
 *   退回硬编码 fallback。
 *
 * 差别就是用户看到的「模型列表和上游对不上」：上游上新模型、或换了档位不同的
 * 账号，保存快照都不会变。TraeCatalog 就是运行时目录的载体，这里守住它的语义。
 */
{
  const cat = new TraeCatalog('cn');
  ok('运行时目录冷启动时用静态 fallback 垫底（不为空）', cat.current().length > 0);
  cat.set([{ id: 'upstream-only-model', name: '上游新模型', contextWindow: 123456 }]);
  ok('set 之后 current() 返回运行时目录', cat.current().some((m) => m.id === 'upstream-only-model'));
  ok('set 之后不再混入 fallback 条目', !cat.current().some((m) => m.id === FALLBACK_TRAE_MODELS[0].id));
  ok('目录为空时 set 抛错（而不是把 provider 打成空列表）', (() => {
    try {
      cat.set([]);
      return false;
    } catch {
      return true;
    }
  })());
}

/**
 * —— 18) 模型选择必须真的作用到「DSH 看到的模型列表」 ——
 *
 * 这是用户报的「每次默认所有模型全部开启」。
 *
 * 根因：`registerModelDiscovery` 原先直接把 `discoverModels()` 的**原始上游目录**
 * 交出去，只叠了图片能力，完全没过 `enabledModelIds`。于是卡片上勾了多少都没用，
 * DSH 模型选择器里永远是全量。
 *
 * WorkBuddy 给的是 `catalogs[region].visible()`（会按选择过滤）；Trae 侧的等价物
 * 是 `derive()` = deriveCatalog(applyImageSelection(...), enabled, budgets)。
 * 这里守住这条链的语义，防止再次被绕开。
 */
{
  const upstream = [
    { id: 'm1', name: 'M1', contextWindow: 100000, multimodal: false },
    { id: 'm2', name: 'M2', contextWindow: 100000, multimodal: true },
    { id: 'm3', name: 'M3', contextWindow: 100000, multimodal: false },
  ];

  // 只勾了 m1、m3
  const filtered = deriveCatalog(applyImageSelection(upstream, new Set()), new Set(['m1', 'm3']));
  ok('只勾选部分模型时，发现结果里只剩勾选的', filtered.length === 2 && !filtered.some((m) => m.id === 'm2'), filtered.map((m) => m.id).join(','));

  // enabled 为空 = 全量（新装未选择时不至于给出空列表）
  const all = deriveCatalog(applyImageSelection(upstream, new Set()), new Set());
  ok('未保存选择时退回全量（不给空列表）', all.length === 3, all.map((m) => m.id).join(','));

  // 图片能力跟随 imageModelIds 与上游多模态标记
  const withImage = deriveCatalog(applyImageSelection(upstream, new Set(['m3'])), new Set(['m1', 'm3']));
  const m3 = withImage.find((m) => m.id === 'm3');
  const m1 = withImage.find((m) => m.id === 'm1');
  ok('手动勾选的图片模型获得 image 能力', m3 !== undefined && m3.input.includes('image'));
  ok('未勾选图片的模型保持纯文本', m1 !== undefined && !m1.input.includes('image'));
  const autoImage = deriveCatalog(applyImageSelection(upstream, new Set()), new Set(['m1', 'm2']));
  ok('上游标为多模态的模型自动获得 image 能力', autoImage.find((m) => m.id === 'm2').input.includes('image'));

  /**
   * 上下文预算：Trae 的模型是「DSH 预算 vs 原生上限」两档，不是任意数值。
   *
   * `applyContextBudgets` 只在保存值**恰好等于** `maxContextWindow` 时把
   * `contextWindow` 抬到原生上限；否则保持目录给的默认（也就是较小的那档）。
   * 与 WorkBuddy 的自由裁剪语义不同 —— 这是 Trae 侧两档单选的原样，
   * 别按 WorkBuddy 的直觉去断言。
   */
  const twoTier = [
    { id: 'x', name: 'X', contextWindow: 100000, maxContextWindow: 200000 },
  ];
  const capped = deriveCatalog(applyImageSelection(twoTier, new Set()), new Set(['x']), {});
  ok('默认用目录给的（较小）窗口', capped[0].contextWindow === 100000, String(capped[0].contextWindow));
  const lifted = deriveCatalog(applyImageSelection(twoTier, new Set()), new Set(['x']), { x: 200000 });
  ok('预算选到原生上限时抬到 maxContextWindow', lifted[0].contextWindow === 200000, String(lifted[0].contextWindow));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
