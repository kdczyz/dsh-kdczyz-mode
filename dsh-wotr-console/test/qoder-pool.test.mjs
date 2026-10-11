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

console.log('\n== 单一「当前账号」：没有分配策略 ==');
{
  // 池里**只剩**「优先」这一条语义：一个账号一直用到它不可用，再换下一个。
  // 轮换 / 均衡已删除（它们与「哪个账号在服务必须由用户手动切换决定」冲突），
  // 所以这里第一条断言就是「池上不再有 distribution 这个概念」。
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store, distribution: 'round-robin' });
  ok('构造参数里的 distribution 被忽略', pool.distribution === undefined && pool.currentDistribution === undefined);

  const first = await pool.acquire();
  const second = await pool.acquire();
  ok('连续两次请求都是同一个账号', first.id === second.id, `${first.label} vs ${second.label}`);
  ok('取到的是列表第一个', first.id === pool.list()[0].id);

  // 第一个冷却后自动让位给第二个（备用账号的意义就在这里）
  pool.penalize(first.id, Date.now() + 60_000);
  const third = await pool.acquire();
  ok('第一个冷却后让位给第二个', third.id !== first.id, third.label);
  ok('让位只影响不可用的那个，恢复后仍回到它', (() => {
    pool.applyConfig({}); // 不动冷却
    return pool.resolveNext(Date.now(), undefined).id === third.id;
  })());
}

console.log('\n== 当前使用 vs 备用：effectiveSelectedAccountId（Trae 同款） ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [alice, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));

  // 没选过：确定性默认值是池里第一个账号（界面上标「当前使用」的那个）
  ok('未选定时默认第一个账号', pool.effectiveSelectedAccountId() === alice.id, pool.effectiveSelectedAccountId());
  ok('未选定时 selectedAccountId 仍为空', pool.selectedAccountId() === undefined);

  pool.selectAccount(bob.id);
  ok('选中后就是它', pool.effectiveSelectedAccountId() === bob.id);

  // 冷却**不**改变「当前使用」的归属：那是可用性的问题，卡片上有冷却标签，
  // 让「当前使用」跟着冷却跳会让用户每 60 秒找不到自己在用谁。
  pool.penalize(bob.id);
  ok('当前账号冷却中仍标它', pool.effectiveSelectedAccountId() === bob.id);

  // 选中的账号从池里消失（凭据被删）→ 回到第一个账号
  pool.selectAccount('gone-account');
  ok('选中账号不在池里时回落到第一个', pool.effectiveSelectedAccountId() === alice.id);
  ok('显式选择本身仍然记着', pool.selectedAccountId() === 'gone-account');

  // 空池：没有「当前使用」，返回 undefined 而不是编造一个
  const empty = new QoderAccountPool({ store: fakeStore([]) });
  await empty.scan();
  ok('空池没有当前账号', empty.effectiveSelectedAccountId() === undefined);
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
  // 分配策略已经不存在了：传进来既不生效也不报错（老配置/老客户端写下的
  // 遗留键不能把池打挂）。
  ok('distribution 键被安全忽略', pool.distribution === undefined && pool.currentDistribution === undefined);
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

console.log('\n== 单账号语义：selectedId 就是服务请求的那一个 ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const [, bob] = ['alice', 'bob'].map((n) => pool.list().find((a) => a.label === n));

  // ① 没选定时取池里第一个（确定性默认值，与界面上「当前使用」一致）
  const first = await pool.acquire();
  ok('未选定时取到账号', first !== undefined);
  ok('未选定时取第一个', first.label === 'alice', first?.label);

  // ② 选定 bob 后固定返回 bob
  pool.selectAccount(bob.id);
  for (let i = 0; i < 5; i += 1) {
    const got = await pool.acquire();
    ok(`选中后第 ${i + 1} 次仍是 bob`, got?.id === bob.id, got?.label);
  }

  ok('selectedAccountId 回读一致', pool.selectedAccountId() === bob.id);
  ok('resolveSelected 命中', pool.resolveSelected()?.id === bob.id);
}

console.log('\n== 当前账号不可用时让位给备用，且给出原因 ==');
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

console.log('\n== applyConfig 由设置驱动 selectedId ==');
{
  const store = fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]);
  const pool = new QoderAccountPool({ store });
  await pool.scan();
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.applyConfig({ selectedAccountId: bob.id });
  ok('applyConfig 写入选中账号', pool.selectedAccountId() === bob.id);
  ok('空字符串 = 清除选择（回到第一个账号）', (() => {
    pool.applyConfig({ selectedAccountId: '' });
    return pool.selectedAccountId() === undefined && pool.effectiveSelectedAccountId() === pool.list()[0].id;
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

console.log('\n== resolveNext：预览不改状态 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob'), cred('u3', 'cara')]) });
  await pool.scan();

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
  ok('当前账号冷却后预览跟着让位', (() => {
    pool.penalize(acquired[0], Date.now() + 60_000);
    return pool.resolveNext()?.id !== acquired[0];
  })());
}

console.log('\n== resolveNext：只有优先语义，且不越界 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const next = pool.resolveNext();
  ok('能预告下一个账号', next !== undefined, String(next));
  ok('预告的账号确实在池里', pool.list().some((x) => x.id === next.id));
  ok('预告的就是池里第一个（未选定时的确定性默认）', next.id === pool.list()[0].id);
  // 遗留的 distribution 键不再有分支效果
  pool.applyConfig({ distribution: 'balanced' });
  ok('遗留 distribution 键不影响预告', pool.resolveNext()?.id === next.id);
  const empty = new QoderAccountPool({ store: fakeStore([]) });
  await empty.scan();
  ok('空池预告为 undefined（不编造账号）', empty.resolveNext() === undefined);
}

console.log('\n== servingAccount：served 优先于 next ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  pool.applyConfig({ distribution: 'round-robin' });

  const preview = pool.servingAccount();
  ok('没有任何服务记录时回退为「预告」', preview.source === 'next', preview.source);
  ok('预告给出的是池里的账号', preview.account !== undefined);

  // 固定选中的是 alice，但刚刚真正服务的是 bob —— 界面必须显示 bob：
  // 「被调用的账号」与「固定用哪个」是两个问题，轮换模式下更是完全无关。
  const alice = pool.list().find((a) => a.label === 'alice');
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.applyConfig({ selectedAccountId: alice.id });
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
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const alice = pool.list().find((a) => a.label === 'alice');
  const bob = pool.list().find((a) => a.label === 'bob');
  pool.applyConfig({ disabledAccountIds: [alice.id], distribution: 'priority' });
  const next = pool.resolveNext();
  ok('预告跳过已停用账号', next?.id === bob.id, next?.label);
}

console.log(`\nqoder-pool: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);