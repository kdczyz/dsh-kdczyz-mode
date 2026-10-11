/**
 * Qoder 号池（lib/qoder-pool.mjs）的单测。
 *
 * 为什么要有这个文件：号池决定「请求用哪个账号、失败后换谁」。这部分错了
 * 不会抛异常 —— 表现为「明明池里有别的账号，请求却一直失败」或者「所有额度
 * 都从同一个账号扣光」。这里用一个假 store 直接驱动池，覆盖：
 *
 *   - scan 读盘发现账号、保留已有冷却状态
 *   - 三种分配策略（priority / round-robin / balanced）
 *   - 逐模型冷却：429 只冷却该模型，402 冷却整个账号
 *   - 冷却中的账号被跳过；全池冷却时重新扫描
 *   - 停用 / 保留额度让账号退出轮换
 *   - 显式偏好（prefer）优先
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
  classifyQoderFailure,
  normalizeQoderCredential,
  parseQoderOwn,
  qoderAccountId,
  qoderIdleWeight,
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
  ok('初始没有冷却', accounts.every((a) => a.cooldownUntilMs === 0));
  ok('记录了扫描时间', pool.status().lastScanAtMs > 0);
  ok('status 报告账号总数', pool.status().count === 2);
}

console.log('\n== scan 保留冷却状态 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list().find((a) => a.label === 'alice');
  pool.penalize(alice.id, Date.now() + 60_000);

  await pool.scan();
  const aliceAfter = pool.list().find((a) => a.label === 'alice');
  ok('重扫不重置正在冷却的账号', aliceAfter.cooldownUntilMs > Date.now(), aliceAfter.cooldownUntilMs);
  ok('重扫不丢账号', pool.list().length === 2);
  ok('status 报告冷却数', pool.status().cooling === 1, pool.status().cooling);
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

console.log('\n== priority（默认）策略 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  ok('默认是 priority', pool.currentDistribution() === 'priority');

  const first = await pool.acquire();
  const second = await pool.acquire();
  ok('priority 下一直取第一个', first.id === second.id, `${first.label} vs ${second.label}`);
  ok('取到的是列表第一个', first.id === pool.list()[0].id);

  // 第一个冷却后自动换第二个
  pool.penalize(first.id, Date.now() + 60_000);
  const third = await pool.acquire();
  ok('第一个冷却后换到第二个', third.id !== first.id, third.label);
}

console.log('\n== round-robin 策略 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob'), cred('u3', 'carol')]);
  const pool = new QoderAccountPool({ store, distribution: 'round-robin' });
  await pool.scan();
  const picks = [];
  for (let i = 0; i < 6; i += 1) picks.push((await pool.acquire()).id);
  ok('连续请求在池内轮流', picks[0] !== picks[1] && picks[1] !== picks[2], picks.join(','));
  ok('轮完一圈回到起点', picks[0] === picks[3] && picks[1] === picks[4], picks.join(','));
  ok('三个账号都被用到', new Set(picks).size === 3, new Set(picks).size);
}

console.log('\n== balanced 策略 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store, distribution: 'balanced' });
  await pool.scan();
  const counts = new Map();
  for (let i = 0; i < 200; i += 1) {
    const account = await pool.acquire();
    counts.set(account.id, (counts.get(account.id) ?? 0) + 1);
  }
  ok('balanced 会用到多个账号', counts.size === 2, counts.size);
  ok('两个账号都被抽到（不是恒定一个）', [...counts.values()].every((n) => n > 0), [...counts.values()].join(','));
}

console.log('\n== 空闲加权 ==');
{
  const now = Date.now();
  ok('从未用过给最高基础权重', qoderIdleWeight(undefined, now) > 1);
  ok('刚用过权重最低', qoderIdleWeight(now, now) === 1);
  ok('空闲越久权重越高', qoderIdleWeight(now - 4 * 36e5, now) > qoderIdleWeight(now - 36e5, now));
  ok('权重有上限', qoderIdleWeight(now - 1000 * 36e5, now) === 6);
}

console.log('\n== 逐模型冷却 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];

  // 429 只冷却该模型
  pool.penalize(alice.id, Date.now() + 60_000, 'qwen3.8-flash');
  ok('该模型不再可用', pool.available(Date.now(), 'qwen3.8-flash').length === 0);
  ok('同账号其它模型仍可用', pool.available(Date.now(), 'glm-5.2').length === 1);
  ok('不带 modelId 查询时账号仍可用', pool.available(Date.now()).length === 1);
  ok('rateLimitHits 被累加', alice.rateLimitHits === 1);

  // 402 冷却整个账号
  pool.penalizeExhausted(alice.id);
  ok('额度耗尽后整个账号不可用', pool.available(Date.now()).length === 0);
  ok('其它模型也不可用', pool.available(Date.now(), 'glm-5.2').length === 0);
}

console.log('\n== 冷却到期恢复 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store, cooldownMs: 1 });
  await pool.scan();
  const alice = pool.list()[0];
  pool.penalize(alice.id, Date.now() + 30);
  ok('冷却期内不可用', pool.available(Date.now()).length === 0);
  await new Promise((r) => setTimeout(r, 45));
  ok('冷却到期后恢复可用', pool.available(Date.now()).length === 1);
}

console.log('\n== 全池冷却时重新扫描 ==');
{
  const store = fakeStore([cred('u1', 'alice')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];
  pool.penalizeExhausted(alice.id);

  // 池耗尽时 acquire 会重扫；重扫发现了一个新登录的账号
  store.readAll = async () => [cred('u1', 'alice'), cred('u2', 'bob')];
  const picked = await pool.acquire();
  ok('池耗尽时重扫并取到新账号', picked !== undefined && picked.id !== alice.id, picked?.label);
}

console.log('\n== 池真的空时返回 undefined ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([]) });
  ok('没有账号时 acquire 返回 undefined', (await pool.acquire()) === undefined);
  const noStore = new QoderAccountPool({});
  ok('没有 store 时不抛', (await noStore.acquire()) === undefined);
}

console.log('\n== 停用（disabledIds） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];

  pool.applyConfig({ disabledAccountIds: [alice.id] });
  ok('停用后不在候选里', pool.available(Date.now()).every((a) => a.id !== alice.id));
  ok('isDisabled 报告正确', pool.isDisabled(alice.id) === true);
  ok('disabledIdsInOrder 列出被停用的', pool.disabledIdsInOrder().includes(alice.id));
  ok('priority 下跳过被停用的账号', (await pool.acquire()).id !== alice.id);

  pool.applyConfig({ disabledAccountIds: [] });
  ok('取消停用后恢复候选', pool.available(Date.now()).length === 2);
}

console.log('\n== 保留额度（creditReserves） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];

  pool.applyConfig({ creditReserves: { [alice.id]: 100 } });
  ok('reserve 被记录', pool.creditReserveOf(alice.id) === 100);
  ok('creditReservesInOrder 列出', pool.creditReservesInOrder()[alice.id] === 100);
  ok('余额未知时不因 reserve 排除', pool.available(Date.now()).length === 2);

  // 余额已知且低于下限 → 退出轮换
  pool.noteCredits(alice.id, 50);
  ok('余额低于下限时退出候选', pool.available(Date.now()).every((a) => a.id !== alice.id));
  ok('creditsOf 能读到余额', pool.creditsOf(alice.id) === 50);

  // 余额回到下限之上 → 重新可用
  pool.noteCredits(alice.id, 500);
  ok('余额回升后重新可用', pool.available(Date.now()).length === 2);

  pool.applyConfig({ creditReserves: {} });
  ok('清空 reserve 后不再限制', pool.creditReserveOf(alice.id) === 0);
}

console.log('\n== 显式偏好（prefer） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store, distribution: 'round-robin' });
  await pool.scan();
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.prefer(bob.id);
  ok('prefer 在 round-robin 下也优先', (await pool.acquire()).id === bob.id);
  ok('连续取号仍锁定偏好账号', (await pool.acquire()).id === bob.id);

  // 偏好账号冷却后回落到常规策略
  pool.penalizeExhausted(bob.id);
  ok('偏好账号冷却后回落', (await pool.acquire()).id !== bob.id);
}

console.log('\n== noteServed / lastServedId ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const alice = pool.list()[0];
  ok('初始没有 lastServed', pool.lastServedId() === undefined);
  pool.noteServed(alice.id);
  ok('noteServed 后能读到', pool.lastServedId() === alice.id);
  pool.noteServed('不存在');
  ok('未知账号不被记录', pool.lastServedId() === alice.id);
}

console.log('\n== resetCooldowns ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  for (const a of pool.list()) pool.penalizeExhausted(a.id);
  ok('全部冷却后无可选账号', pool.available(Date.now()).length === 0);
  pool.resetCooldowns();
  ok('重置后全部恢复', pool.available(Date.now()).length === 2);
  ok('rateLimitHits 被清零', pool.list().every((a) => a.rateLimitHits === 0));
  ok('modelCooldowns 被清空', pool.list().every((a) => Object.keys(a.modelCooldowns).length === 0));
}

console.log('\n== applyConfig ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([]) });
  pool.applyConfig({ cooldownMs: 5000, exhaustCooldownMs: 9000, distribution: 'balanced' });
  ok('cooldownMs 生效', pool.cooldownMs === 5000);
  ok('exhaustCooldownMs 生效', pool.exhaustCooldownMs === 9000);
  ok('distribution 生效', pool.currentDistribution() === 'balanced');
  pool.applyConfig({ cooldownMs: 10 });
  ok('过小的 cooldownMs 被拒（不会把冷却变成 10ms）', pool.cooldownMs === 5000);
}

console.log('\n== 失败分类 ==');
{
  ok('402 → 额度耗尽', classifyQoderFailure({ status: 402 }).kind === 'hard_credit');
  ok('429 → 限流', classifyQoderFailure({ status: 429 }).kind === 'soft_rate');
  ok('429 带 modelId 时按模型冷却', classifyQoderFailure({ status: 429, modelId: 'm1' }).modelId === 'm1');
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

    // 池取号 + 落盘账号闭环
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
  pool.applyConfig({ creditReserves: { [alice.id]: 50 }, disabledAccountIds: [alice.id] });
  ok('残留状态已写入', pool.lastServedId() === alice.id && pool.creditsOf(alice.id) === 100);

  store.readAll = async () => [cred('u2', 'bob')];
  await pool.scan();
  ok('lastUsedAt 被清理', pool.lastServedId() === undefined);
  ok('creditBalances 被清理', pool.creditsOf(alice.id) === undefined);
  ok('creditReserves 被清理', pool.creditReserveOf(alice.id) === 0);
  ok('disabledIds 被清理', pool.disabledIdsInOrder().length === 0);
}

console.log('\n== 单账号语义：selectedId 优先于分配策略 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store, distribution: 'round-robin' });
  await pool.scan();
  const [, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));

  // ① 没选定时仍是轮换行为（回归：不能因为加了 selectedId 就改掉默认）
  const first = await pool.acquire();
  ok('未选定时取到账号', first !== undefined);
  ok('未选定时走轮换', first.label === 'alice', first?.label);

  // ② 选定 bob 后，无论 round-robin 游标在哪都固定返回 bob
  pool.selectAccount(bob.id);
  for (let i = 0; i < 5; i += 1) {
    const got = await pool.acquire();
    ok(`选中后第 ${i + 1} 次仍是 bob`, got?.id === bob.id, got?.label);
  }

  ok('selectedAccountId 回读一致', pool.selectedAccountId() === bob.id);
  ok('resolveSelected 命中', pool.resolveSelected()?.id === bob.id);
}

console.log('\n== 选中账号不可用时回退，且给出原因 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [alice, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));
  pool.selectAccount(bob.id);

  // ① 选中账号被停用 → 回退到 alice
  pool.applyConfig({ disabledAccountIds: [bob.id] });
  ok('停用后 resolveSelected 落空', pool.resolveSelected() === undefined);
  ok('停用回退原因正确', pool.fallbackReason() === 'selected-disabled', pool.fallbackReason());
  const got = await pool.acquire();
  ok('停用后回退到另一个账号', got?.id === alice.id, got?.label);

  // ② 选中账号整体冷却 → 回退
  pool.applyConfig({ disabledAccountIds: [] });
  pool.penalize(bob.id);
  ok('冷却后 resolveSelected 落空', pool.resolveSelected() === undefined);
  ok('冷却回退原因正确', pool.fallbackReason() === 'selected-cooling', pool.fallbackReason());

  // ③ 选中账号不在池里（凭据被删）→ 回退且原因明确
  const fresh = new QoderAccountPool({ store });
  await fresh.scan();
  fresh.selectAccount('gone-account');
  ok('账号不在池里时落空', fresh.resolveSelected() === undefined);
  ok('缺失回退原因正确', fresh.fallbackReason() === 'selected-missing', fresh.fallbackReason());

  // ④ 没选定时不产生「回退」语义，避免日志噪音
  const none = new QoderAccountPool({ store });
  await none.scan();
  ok('未选定时 fallbackReason 为 no-selection', none.fallbackReason() === 'no-selection');
}

console.log('\n== 逐模型冷却：选中账号只在该模型上让位 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));
  pool.selectAccount(bob.id);

  pool.penalize(bob.id, undefined, 'model-x');
  ok('该模型上让位', pool.resolveSelected(undefined, 'model-x') === undefined);
  ok('该模型回退原因正确', pool.fallbackReason(undefined, 'model-x') === 'selected-model-cooling');
  ok('其它模型仍用选中账号', pool.resolveSelected(undefined, 'model-y')?.id === bob.id);
  const other = await pool.acquire('model-y');
  ok('其它模型取到 bob', other?.id === bob.id, other?.label);
}

console.log('\n== 保留额度：选中账号触底后让位 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [alice, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));
  pool.selectAccount(bob.id);
  pool.noteCredits(bob.id, 40);
  pool.applyConfig({ creditReserves: { [bob.id]: 50 } });

  ok('余额触底时让位', pool.resolveSelected() === undefined);
  ok('保留额度回退原因正确', pool.fallbackReason() === 'selected-reserved', pool.fallbackReason());
  const got = await pool.acquire();
  ok('触底后回退到 alice', got?.id === alice.id, got?.label);
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

console.log('\n== applyConfig 能持久化驱动 selectedId ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.applyConfig({ selectedAccountId: bob.id });
  ok('applyConfig 写入选中账号', pool.selectedAccountId() === bob.id);
  const got = await pool.acquire();
  ok('配置驱动后取到 bob', got?.id === bob.id, got?.label);
}

console.log(`\nqoder-pool: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);