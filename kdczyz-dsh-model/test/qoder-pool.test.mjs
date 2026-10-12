/**
 * Qoder 号池（lib/qoder-pool.mjs）的单测。
 *
 * 为什么要有这个文件：号池决定「请求用哪个账号、失败后怎么办」。这部分错了
 * 不会抛异常 —— 表现为「明明池里有别的账号，请求却一直失败」或者「所有额度
 * 都从同一个账号扣光」。这里用一个假 store 直接驱动池，覆盖：
 *
 *   - scan 读盘发现账号、凭据文件没了账号就出池
 *   - **完全手动取号**（本 fork 语义）：只有「切换到此账号」选中的账号会服务
 *     请求；它不可用（未选 / 停用 / 不在池里）时请求直接失败，**无冷却、
 *     无保留额度、无自动让位、无分配策略**
 *   - 停用 / 移出池子等手动管理保留
 *   - 失败分类（classifyQoderFailure）
 *
 * 运行：node test/qoder-pool.test.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveQoderCredential, deleteQoderCredential } from '../lib/qoder-auth.mjs';
import {
  QoderAccountPool,
  QoderCredentialStore,
  _resetQoderServedSlot,
  classifyQoderFailure,
  lastServedQoderAccountId,
  noteQoderServed,
  normalizeQoderCredential,
  parseQoderOwn,
  qoderAccountId,
} from '../lib/qoder-pool.mjs';

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

/** 假凭据 store：只实现池用到的三个方法。 */
function fakeStore(credentials) {
  return {
    readAll: async () => credentials,
    credentialOf: async (id) => credentials.find((c) => qoderAccountId(c) === id),
    resolveFor: async () => undefined,
  };
}

const cred = (userId, name, expiresAtMs = 0) => ({
  accessToken: `dt-${userId}`,
  refreshToken: `rt-${userId}`,
  userId,
  userName: name,
  expiresAtMs,
});

console.log('\n== 凭据归一化 ==');
{
  const c = normalizeQoderCredential({
    access_token: 'dt-x',
    refresh_token: 'rt-x',
    user_id: 'u',
    user_name: 'n',
    machine_id: 'm',
    expires_at: 1_800_000_000_000,
  });
  ok('认 snake_case 字段', c?.accessToken === 'dt-x' && c?.userId === 'u' && c?.userName === 'n');
  ok('machineId 被带出', c?.machineId === 'm');
  ok('expires_at 数字毫秒被解析', c?.expiresAtMs === 1_800_000_000_000);
  ok('缺 accessToken 视为无效', normalizeQoderCredential({ userId: 'u' }) === undefined);
  ok('非对象视为无效', normalizeQoderCredential(null) === undefined);
  ok('数组视为无效', normalizeQoderCredential([]) === undefined);
  ok(
    'expires_at 秒级被换算成毫秒',
    normalizeQoderCredential({ accessToken: 'a', expires_at: 1_800_000_000 })?.expiresAtMs === 1_800_000_000_000,
  );
}

console.log('\n== parseQoderOwn ==');
{
  ok('版本不匹配返回 undefined', parseQoderOwn(JSON.stringify({ version: 99, credential: {} })) === undefined);
  ok('坏 JSON 返回 undefined', parseQoderOwn('{oops') === undefined);
  ok(
    '正常文档被解析',
    parseQoderOwn(JSON.stringify({ version: 1, credential: { accessToken: 'dt-a' } }))?.accessToken === 'dt-a',
  );
}

console.log('\n== scan 发现账号 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  const accounts = await pool.scan();
  ok('扫出两个账号', accounts.length === 2, accounts.length);
  ok('label 用 userName', accounts[0].label === 'alice', accounts[0].label);
  ok('账号条目只有身份与凭据（无冷却/限流字段）', accounts.every((a) => a.cooldownUntilMs === undefined && a.rateLimitHits === undefined));
  ok('记录了扫描时间', pool.status().lastScanAtMs > 0);
  ok('status 报告账号总数', pool.status().count === 2);
}

console.log('\n== 新登录的账号被并入池 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  ok('池里只有一个账号', pool.list().length === 1);

  // 模拟「刚登录了一个新账号」
  store.readAll = async () => [cred('u1', 'alice'), cred('u2', 'bob')];
  await pool.scan();
  ok('重扫后发现新账号', pool.list().length === 2, pool.list().length);
}

console.log('\n== 完全手动取号：未选中 = 请求失败 ==');
{
  // 没有分配策略（priority / round-robin / balanced 均已删除）、没有冷却、
  // 没有保留额度：池上不再有这些概念，构造函数与配置里传进来的旧键被安全忽略。
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store, distribution: 'round-robin', cooldownMs: 5000, exhaustCooldownMs: 9000 });
  await pool.scan();
  ok('构造参数里的 distribution/cooldown 被忽略', pool.distribution === undefined && pool.cooldownMs === undefined);

  ok('未选定时 fallbackReason 为 no-selection', pool.fallbackReason() === 'no-selection');
  ok('未选定时 acquire 失败（undefined）', (await pool.acquire()) === undefined);
  ok('未选定时 resolveNext 为 undefined', pool.resolveNext() === undefined);
  ok('未选定时没有「当前使用」', pool.effectiveSelectedAccountId() === undefined);
}

console.log('\n== 完全手动取号：选中即固定，不换号 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [alice, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));

  pool.selectAccount(bob.id);
  ok('选中后 effectiveSelectedAccountId 就是它', pool.effectiveSelectedAccountId() === bob.id);
  for (let i = 0; i < 5; i += 1) {
    const got = await pool.acquire();
    ok(`选中后第 ${i + 1} 次仍是 bob`, got?.id === bob.id, got?.label);
  }
  ok('resolveNext 预告也是 bob', pool.resolveNext()?.id === bob.id);

  // 换一个：切换后固定用新的
  pool.selectAccount(alice.id);
  ok('切换后取到 alice', (await pool.acquire())?.id === alice.id);
  ok('selectedAccountId 回读一致', pool.selectedAccountId() === alice.id);
}

console.log('\n== 选中账号不可用 → 请求直接失败（不让位、不自动换号） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [alice, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));
  pool.selectAccount(bob.id);

  // ① 选中账号被停用 → 失败，绝不回退到 alice
  pool.applyConfig({ disabledAccountIds: [bob.id] });
  ok('停用后 resolveSelected 落空', pool.resolveSelected() === undefined);
  ok('停用失败原因正确', pool.fallbackReason() === 'selected-disabled', pool.fallbackReason());
  ok('停用后 acquire 失败而不是换号', (await pool.acquire()) === undefined);

  // ② 选中账号不在池里（凭据被删）→ 失败
  const fresh = new QoderAccountPool({ store });
  await fresh.scan();
  fresh.selectAccount('gone-account');
  ok('账号不在池里时落空', fresh.resolveSelected() === undefined);
  ok('缺失失败原因正确', fresh.fallbackReason() === 'selected-missing', fresh.fallbackReason());
  ok('缺失时 acquire 失败', (await fresh.acquire()) === undefined);

  // ③ 停用状态清除后恢复用回选中账号
  pool.applyConfig({ disabledAccountIds: [] });
  ok('恢复停用后又能取到 bob', (await pool.acquire())?.id === bob.id, pool.list().find((a) => a.id === bob.id)?.label);
}

console.log('\n== 无冷却：限流/额度耗尽不惩罚账号，继续用选中账号 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  pool.selectAccount(pool.list()[0].id);

  // 池上没有 penalize/penalizeExhausted/resetCooldowns/status.cooling 等接口
  ok('池上不再有 penalize', typeof pool.penalize !== 'function');
  ok('池上不再有 penalizeExhausted', typeof pool.penalizeExhausted !== 'function');
  ok('池上不再有 resetCooldowns', typeof pool.resetCooldowns !== 'function');
  ok('status 不再有 cooling 字段', pool.status().cooling === undefined);

  // 即便「上游失败回灌」发生（applyQoderRelayFailure 已降级为纯日志），
  // 下一次 acquire 仍是同一个账号 —— 冷却机制已删除。
  const got1 = await pool.acquire();
  const got2 = await pool.acquire();
  ok('连续请求仍是同一个账号', got1?.id === got2?.id, `${got1?.label} vs ${got2?.label}`);
}

console.log('\n== 无保留额度：creditReserves 已删除 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];
  pool.selectAccount(alice.id);
  pool.applyConfig({ creditReserves: { [alice.id]: 100 } });
  ok('creditReserves 被忽略（池上没有这个字段）', pool.creditReserveOf === undefined && pool.creditReservesInOrder === undefined);
  ok('applyConfig 传保留额度不抛、不影响取号', (await pool.acquire())?.id === alice.id);
}

console.log('\n== 池真的空时返回 undefined ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([]) });
  ok('没有账号时 acquire 返回 undefined', (await pool.acquire()) === undefined);
  const noStore = new QoderAccountPool({});
  ok('没有 store 时不抛', (await noStore.acquire()) === undefined);
}

console.log('\n== 空池扫描一次：登录新账号后仍需手动切换 ==');
{
  // acquire 首次遇到空池会懒扫一次（走出「池子空」的常规手段是刚登录新账号）；
  // 但完全手动语义下，扫到了账号也不代表能自动用上 —— 没选中就是失败。
  const store = fakeStore([]);
  const pool = new QoderAccountPool({ store });
  ok('空池 acquire 失败', (await pool.acquire()) === undefined);

  store.readAll = async () => [cred('u1', 'alice')];
  const again = await pool.acquire();
  ok('空池懒扫后仍未选中 → 依然失败', again === undefined, String(again));
  pool.selectAccount(pool.list()[0].id);
  ok('手动切换后即可用', (await pool.acquire())?.label === 'alice');
}

console.log('\n== 停用（disabledIds，手动管理保留） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];

  pool.applyConfig({ disabledAccountIds: [alice.id] });
  ok('停用后不在候选里', pool.available(Date.now()).every((a) => a.id !== alice.id));
  ok('isDisabled 报告正确', pool.isDisabled(alice.id) === true);
  ok('disabledIdsInOrder 列出被停用的', pool.disabledIdsInOrder().includes(alice.id));

  pool.applyConfig({ disabledAccountIds: [] });
  ok('取消停用后恢复候选', pool.available(Date.now()).length === 2);
}

console.log('\n== applyConfig ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([]) });
  pool.applyConfig({ cooldownMs: 5000, exhaustCooldownMs: 9000, distribution: 'balanced', creditReserves: { x: 1 } });
  // 冷却 / 保留额度 / 分配策略已删除：传进来既不生效也不报错（老配置/老客户端
  // 写下的遗留键不能把池打挂）。
  ok('cooldownMs 不再生效', pool.cooldownMs === undefined);
  ok('exhaustCooldownMs 不再生效', pool.exhaustCooldownMs === undefined);
  ok('distribution 键被安全忽略', pool.distribution === undefined && pool.currentDistribution === undefined);
  ok('creditReserves 键被安全忽略', pool.creditReserves === undefined);
}

console.log('\n== 失败分类 ==');
{
  ok('402 → 额度耗尽', classifyQoderFailure({ status: 402 }).kind === 'hard_credit');
  ok('429 → 限流', classifyQoderFailure({ status: 429 }).kind === 'soft_rate');
  ok('429 带 modelId 时保留模型', classifyQoderFailure({ status: 429, modelId: 'm1' }).modelId === 'm1');
  ok('401 → 会话失效', classifyQoderFailure({ status: 401 }).kind === 'session_dead');
  ok('403 → 会话失效', classifyQoderFailure({ status: 403 }).kind === 'session_dead');
  ok(
    '正文提到 quota 也算额度耗尽',
    classifyQoderFailure({ status: 400, body: 'insufficient quota' }).kind === 'hard_credit',
  );
  ok(
    '正文提到 rate limit 也算限流',
    classifyQoderFailure({ status: 400, body: 'too many requests' }).kind === 'soft_rate',
  );
  ok('其它错误是 unknown', classifyQoderFailure({ status: 500 }).kind === 'unknown');
}

console.log('\n== 真实 store：从磁盘读账号 ==');
{
  const home = await mkdtemp(join(tmpdir(), 'qoder-pool-'));
  try {
    const store = new QoderCredentialStore({ dshHome: home });
    ok('空目录读出 0 个账号', (await store.readAll()).length === 0);

    await saveQoderCredential({ dshHome: home, accessToken: 'dt-a', userId: 'u1', userName: 'alice' });
    await saveQoderCredential({ dshHome: home, accessToken: 'dt-b', userId: 'u2', userName: 'bob' });
    const all = await store.readAll();
    ok('从磁盘读出两个账号', all.length === 2, all.length);

    const pool = new QoderAccountPool({ store });
    await pool.scan();
    ok('池从真实文件扫出两个账号', pool.list().length === 2);
    ok('账号 label 来自 userName', pool.list().some((a) => a.label === 'alice'));
    ok('credentialOf 能按 id 取到', (await store.credentialOf(pool.list()[0].id)) !== undefined);

    // 池取号 + 落盘账号闭环：先手动切换再取号
    pool.selectAccount(pool.list()[0].id);
    const picked = await pool.acquire();
    ok('从真实池取到账号', picked !== undefined && typeof picked.credential.accessToken === 'string');

    // 删除一个账号后池能感知
    await deleteQoderCredential({ dshHome: home, accountId: qoderAccountId(all[0]) });
    const pool2 = new QoderAccountPool({ store: new QoderCredentialStore({ dshHome: home }) });
    await pool2.scan();
    ok('删除后池里只剩一个账号', pool2.list().length === 1, pool2.list().length);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

console.log('\n== 磁盘是唯一真相：文件删了账号就出池 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  ok('初始两个账号', pool.list().length === 2);

  // 删掉一个账号的凭据文件（= 移出池子）
  store.readAll = async () => [cred('u2', 'bob')];
  await pool.scan();
  ok('凭据文件没了，账号就出池', pool.list().length === 1, pool.list().length);
  ok('留下的是 bob', pool.list()[0].label === 'bob', pool.list()[0].label);
}

console.log('\n== 出池账号的残留状态被清理 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list().find((a) => a.label === 'alice');
  pool.noteServed(alice.id);
  pool.noteCredits(alice.id, 100);
  pool.applyConfig({ disabledAccountIds: [alice.id] });
  ok('残留状态已写入', pool.lastServedId() === alice.id && pool.creditsOf(alice.id) === 100);

  store.readAll = async () => [cred('u2', 'bob')];
  await pool.scan();
  ok('lastUsedAt 被清理', pool.lastServedId() === undefined);
  ok('creditBalances 被清理', pool.creditsOf(alice.id) === undefined);
  ok('disabledIds 被清理', pool.disabledIdsInOrder().length === 0);
}

console.log('\n== selectAccount 的空值语义 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  pool.selectAccount('');
  ok('空字符串 = 清除选择', pool.selectedAccountId() === undefined);
  pool.selectAccount('x');
  pool.selectAccount(undefined);
  ok('undefined = 清除选择', pool.selectedAccountId() === undefined);
}

console.log('\n== applyConfig 由设置驱动 selectedId ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.applyConfig({ selectedAccountId: bob.id });
  ok('applyConfig 写入选中账号', pool.selectedAccountId() === bob.id);
  ok('空字符串 = 清除选择（此后无可用账号）', (() => {
    pool.applyConfig({ selectedAccountId: '' });
    return pool.selectedAccountId() === undefined && pool.effectiveSelectedAccountId() === undefined;
  })());
  pool.applyConfig({ selectedAccountId: bob.id });
  const got = await pool.acquire();
  ok('配置驱动后取到 bob', got?.id === bob.id, got?.label);
}

console.log('\n== 「谁在被调用」：跨实例共享 + 无副作用预告 ==');
{
  // 两个池实例模拟真实拓扑：provider 池（lib/qoder.js）服务请求，
  // 管理页池（lib/index.js 的 qoderPool() 单例）只读状态。它们扫的是同一批
  // 凭据文件，但**不是同一个对象** —— 管理页若只看自己的 lastUsedAt，就永远
  // 读不到「刚才是谁服务的」，界面上任何账号都不会被标成正在使用。
  _resetQoderServedSlot();
  const credentials = [cred('u1', 'alice'), cred('u2', 'bob')];
  const providerPool = new QoderAccountPool({ store: fakeStore(credentials) });
  const adminPool = new QoderAccountPool({ store: fakeStore(credentials) });
  await providerPool.scan();
  await adminPool.scan();
  providerPool.selectAccount(qoderAccountId(credentials[0]));

  ok('服务之前：provider 池 lastServedId 为空', providerPool.lastServedId() === undefined);
  ok('服务之前：管理页池也读不到', adminPool.lastServedId() === undefined);

  const served = await providerPool.acquire();
  providerPool.noteServed(served.id);

  ok('provider 池记下了刚服务的账号', providerPool.lastServedId() === served.id);
  ok('管理页池**跨实例**也读到了同一个账号', adminPool.lastServedId() === served.id, adminPool.lastServedId());
  ok('共享槽位里就是它', lastServedQoderAccountId() === served.id);

  // noteServed 对池里不存在的账号必须静默忽略，否则共享槽位会被写进垃圾值，
  // 管理页就会显示一个「已不在池里」的账号。
  providerPool.noteServed('not-in-pool');
  ok('池外账号不写共享槽位', lastServedQoderAccountId() === served.id);

  // 账号被移出池子后，管理页不能再把它当成「正在使用」：分享的是 id，
  // 但读出来时必须拿当前池过滤一遍。
  const rest = credentials.filter((c) => qoderAccountId(c) !== served.id);
  const shrunk = new QoderAccountPool({ store: fakeStore(rest) });
  await shrunk.scan();
  ok('账号移出池子后不再被认作在服务', shrunk.lastServedId() === undefined, shrunk.lastServedId());

  _resetQoderServedSlot();
  const fresh = new QoderAccountPool({ store: fakeStore(credentials) });
  await fresh.scan();
  ok('槽位清空后回到「没有服务过」', fresh.lastServedId() === undefined);
  // provider 侧仍然靠自己实例内的记录回答（共享槽位只是给别的实例看）
  ok('provider 池自己的记录不受槽位清空影响', providerPool.lastServedId() === served.id);
}

console.log('\n== 显示侧：余额与「读到的时刻」 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const [a, b] = pool.list();

  ok('从没读到过余额时 creditsOf 为 undefined', pool.creditsOf(a.id) === undefined);
  ok('从没读到过时 creditsAt 为 0', pool.creditsAt(a.id) === 0);

  pool.noteCredits(a.id, 500);
  ok('noteCredits 记下余额', pool.creditsOf(a.id) === 500);
  // noteCredits 是内部记账（批量刷新顺手带过）；只有「为了显示而读」的
  // rememberCredits 才更新时间戳，否则节流判据会被内部记账污染。
  ok('noteCredits 不更新「读到的时刻」', pool.creditsAt(a.id) === 0);

  pool.rememberCredits(a.id, 480, 1700000000000);
  ok('rememberCredits 同时记下时刻', pool.creditsAt(a.id) === 1700000000000);
  ok('rememberCredits 记下余额', pool.creditsOf(a.id) === 480);
  pool.rememberCredits(a.id, Number.NaN, 1700000009000);
  ok('非法余额被忽略（不写 0）', pool.creditsOf(a.id) === 480);
  ok('非法余额也不推进时间戳', pool.creditsAt(a.id) === 1700000000000);

  // 余额必须能按账号分别读：把 A 的余额显示成 B 的是最难发现的错误。
  pool.rememberCredits(b.id, 7, 1700000001000);
  ok('两个账号的余额互不串台', pool.creditsOf(a.id) === 480 && pool.creditsOf(b.id) === 7);
}

console.log('\n== resolveNext：预览不改状态、只认选中账号 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob'), cred('u3', 'cara')]) });
  await pool.scan();
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.selectAccount(bob.id);

  // 关键性质：预览「下一个是谁」不能改变真实结果 —— 界面每 30 秒读一次，
  // 若它把「谁服务」这件事搅动了，用户光看着设置页就会换号。
  const previews = [pool.resolveNext()?.id, pool.resolveNext()?.id, pool.resolveNext()?.id];
  ok('反复预览得到同一个账号', previews[0] === previews[1] && previews[1] === previews[2]);
  const acquired = [];
  for (let i = 0; i < 3; i += 1) {
    const got = await pool.acquire();
    acquired.push(got?.id);
  }
  ok('预览不改变真实取号结果', new Set(acquired).size === 1, acquired.join(','));
  ok('预览到的就是真的会被取到的账号', previews[0] === acquired[0]);
  ok('预览到的就是选中的账号', previews[0] === bob.id);
  // 遗留的 distribution 键不再有分支效果
  pool.applyConfig({ distribution: 'balanced' });
  ok('遗留 distribution 键不影响预告', pool.resolveNext()?.id === bob.id);

  // 选中账号被停用 → 预告为 undefined（不自动换到别的账号）
  pool.applyConfig({ disabledAccountIds: [bob.id] });
  ok('选中账号停用后预告为 undefined（不让位）', pool.resolveNext() === undefined);

  const empty = new QoderAccountPool({ store: fakeStore([]) });
  await empty.scan();
  ok('空池预告为 undefined（不编造账号）', empty.resolveNext() === undefined);
}

console.log('\n== servingAccount：served 优先于 next（next 只认选中账号） ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  pool.selectAccount(pool.list().find((a) => a.label === 'alice').id);

  const preview = pool.servingAccount();
  ok('没有任何服务记录时回退为「预告」', preview.source === 'next', preview.source);
  ok('预告给出的是选中的账号', preview.account?.label === 'alice', preview.account?.label);

  // 固定选中的是 alice，但刚刚真正服务的是 bob —— 界面必须显示 bob：
  // 「被调用的账号」与「固定用哪个」是两个问题。
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.noteServed(bob.id);
  const served = pool.servingAccount();
  ok('有服务记录时报告 served', served.source === 'served', served.source);
  ok('报告的是**刚服务的**账号而不是固定选中的', served.account?.id === bob.id, served.account?.label);
  ok('servingAccount 带上模型 id 也不抛', pool.servingAccount(Date.now(), 'qwen3-coder').account?.id === bob.id);

  const empty = new QoderAccountPool({ store: fakeStore([]) });
  await empty.scan();
  const none = empty.servingAccount();
  ok('空池给出 source=none 且账号为 undefined', none.source === 'none' && none.account === undefined);
}

console.log('\n== 停用的账号不会被预告成「下一个」 ==');
{
  _resetQoderServedSlot();
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list().find((a) => a.label === 'alice');
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.selectAccount(alice.id);
  pool.applyConfig({ disabledAccountIds: [alice.id] });
  ok('选中且停用的账号不会被预告（undefined）', pool.resolveNext() === undefined);
  // 手动切到未停用的 bob 后即可用
  pool.selectAccount(bob.id);
  ok('手动切换后预告就是 bob', pool.resolveNext()?.id === bob.id, pool.resolveNext()?.label);
}

console.log(`\nqoder-pool: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
