/**
 * WorkBuddy 池「当前账号」语义的单测（vendor/xdpool/lib/index.js 的本 fork 改动）。
 *
 * 为什么单独一个文件：WorkBuddy 池是 vendored 上游代码，改动必须能被独立验证，
 * 否则上游升级时无从判断这份 fork 改动还在不在、还灵不灵。
 *
 * 覆盖：
 *   - selectedId 按区域（cn / global）独立，且优先于分配策略
 *   - 选中账号不可用时的回退与原因（停用 / 冷却 / 逐模型冷却 / 保留额度 / 不在池 / 跨区）
 *   - applyConfig 的整批替换语义（省略某区域 = 清除该区域选择）
 *   - 未选定时保持原有轮换行为（回归保护）
 *
 * 池的 `scan()` 依赖真实文件系统，所以这里**直接注入 accounts** 并 stub 掉
 * scan —— 选号逻辑本身不碰磁盘，这样测的是决策而不是 I/O。
 *
 * 运行：node test/wb-pool-selected.test.mjs
 */

import { WorkBuddyAccountPool } from '../vendor/xdpool/lib/index.js';

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
 * 造一个不碰磁盘的池：注入账号、废掉 scan / ensureFresh / refresh。
 *
 * `domain` 决定 region（`regionOf()`）：非白名单域名一律算 `cn`，
 * `codebuddy.ai` 系算 `global`。
 */
function poolOf(specs) {
  const pool = new WorkBuddyAccountPool({});
  pool.accounts = specs.map((spec) => ({
    id: spec.id,
    label: spec.label ?? spec.id,
    credential: { domain: spec.domain ?? 'copilot.tencent.com', uin: spec.id },
    cooldownUntilMs: 0,
    modelCooldowns: {},
    rateLimitHits: 0,
  }));
  // scan 是 async 且依赖 authDirs；置为 no-op 后 acquire 走注入的 accounts。
  pool.scan = async () => pool.accounts;
  pool.ensureFresh = async () => undefined;
  return pool;
}

console.log('== 当前账号优先于分配策略 ==');
{
  const pool = poolOf([
    { id: 'a1', label: 'alice' },
    { id: 'b1', label: 'bob' },
  ]);
  pool.distribution = 'round-robin';

  const first = await pool.acquire(undefined, 'cn');
  ok('未选定时仍能取到账号', first !== undefined);
  ok('未选定时走轮换', first.id === 'a1', first?.id);

  pool.selectAccount('cn', 'b1');
  for (let i = 0; i < 4; i += 1) {
    const got = await pool.acquire(undefined, 'cn');
    ok(`选中后第 ${i + 1} 次固定 bob`, got?.id === 'b1', got?.id);
  }
  ok('selectedAccountId 回读', pool.selectedAccountId('cn') === 'b1');
}

console.log('\n== 按区域独立：cn 的选择不影响 global ==');
{
  const pool = poolOf([
    { id: 'a1', label: 'alice' },
    { id: 'g1', label: 'global-user', domain: 'codebuddy.ai' },
  ]);
  pool.selectAccount('cn', 'a1');
  pool.selectAccount('global', 'g1');

  ok('cn 选中回读', pool.selectedAccountId('cn') === 'a1');
  ok('global 选中回读', pool.selectedAccountId('global') === 'g1');
  ok('cn 请求用 a1', (await pool.acquire(undefined, 'cn'))?.id === 'a1');
  ok('global 请求用 g1', (await pool.acquire(undefined, 'global'))?.id === 'g1');

  // 跨区误选：把 global 账号设成 cn 的当前账号 → 应判为不可用并回退
  const wrong = poolOf([{ id: 'g1', domain: 'codebuddy.ai' }]);
  wrong.selectAccount('cn', 'g1');
  ok('跨区选择 resolveSelected 落空', wrong.resolveSelected('cn') === undefined);
  ok('跨区回退原因正确', wrong.fallbackReason('cn') === 'selected-wrong-region', wrong.fallbackReason('cn'));
}

console.log('\n== 选中账号不可用时回退，并给出原因 ==');
{
  const pool = poolOf([
    { id: 'a1', label: 'alice' },
    { id: 'b1', label: 'bob' },
  ]);
  pool.selectAccount('cn', 'b1');

  // ① 停用
  pool.applyConfig({ disabledAccountIds: ['b1'], selectedAccountIds: { cn: 'b1' } });
  ok('停用后落空', pool.resolveSelected('cn') === undefined);
  ok('停用原因', pool.fallbackReason('cn') === 'selected-disabled', pool.fallbackReason('cn'));
  ok('停用后回退到 alice', (await pool.acquire(undefined, 'cn'))?.id === 'a1');

  // ② 整体冷却
  pool.applyConfig({ disabledAccountIds: [], selectedAccountIds: { cn: 'b1' } });
  pool.penalize('b1');
  ok('冷却后落空', pool.resolveSelected('cn') === undefined);
  ok('冷却原因', pool.fallbackReason('cn') === 'selected-cooling', pool.fallbackReason('cn'));

  // ③ 不在池里
  const gone = poolOf([{ id: 'a1' }]);
  gone.selectAccount('cn', 'nope');
  ok('账号缺失时落空', gone.resolveSelected('cn') === undefined);
  ok('缺失原因', gone.fallbackReason('cn') === 'selected-missing', gone.fallbackReason('cn'));

  // ④ 未选定
  const none = poolOf([{ id: 'a1' }]);
  ok('未选定时原因', none.fallbackReason('cn') === 'no-selection');
}

console.log('\n== 逐模型冷却：只在该模型上让位 ==');
{
  const pool = poolOf([
    { id: 'a1', label: 'alice' },
    { id: 'b1', label: 'bob' },
  ]);
  pool.selectAccount('cn', 'b1');
  pool.penalize('b1', undefined, 'model-x');

  ok('该模型上让位', pool.resolveSelected('cn', undefined, 'model-x') === undefined);
  ok('该模型原因', pool.fallbackReason('cn', undefined, 'model-x') === 'selected-model-cooling');
  ok('其它模型仍用 bob', pool.resolveSelected('cn', undefined, 'model-y')?.id === 'b1');
  ok('其它模型取到 bob', (await pool.acquire('model-y', 'cn'))?.id === 'b1');
}

console.log('\n== 保留额度：触底后让位 ==');
{
  const pool = poolOf([
    { id: 'a1', label: 'alice' },
    { id: 'b1', label: 'bob' },
  ]);
  pool.selectAccount('cn', 'b1');
  pool.noteCredits('b1', 40);
  pool.applyConfig({ creditReserves: { b1: 50 }, selectedAccountIds: { cn: 'b1' } });

  ok('触底时落空', pool.resolveSelected('cn') === undefined);
  ok('保留额度原因', pool.fallbackReason('cn') === 'selected-reserved', pool.fallbackReason('cn'));
  ok('触底后回退到 alice', (await pool.acquire(undefined, 'cn'))?.id === 'a1');
}

console.log('\n== applyConfig 整批替换：省略即清除 ==');
{
  const pool = poolOf([{ id: 'a1' }, { id: 'b1' }]);
  pool.applyConfig({ selectedAccountIds: { cn: 'b1', global: 'a1' } });
  ok('写入两个区域', pool.selectedAccountId('cn') === 'b1' && pool.selectedAccountId('global') === 'a1');

  // 只给 cn：global 的选择必须被清掉，否则「取消选择」永远做不到
  pool.applyConfig({ selectedAccountIds: { cn: 'b1' } });
  ok('省略 global = 清除 global', pool.selectedAccountId('global') === undefined);
  ok('cn 保持', pool.selectedAccountId('cn') === 'b1');

  pool.applyConfig({ selectedAccountIds: {} });
  ok('空对象清空全部', pool.selectedAccountId('cn') === undefined);
  ok('selectedAccountsInOrder 为空', Object.keys(pool.selectedAccountsInOrder()).length === 0);
}

console.log('\n== selectAccount 的空值语义 ==');
{
  const pool = poolOf([{ id: 'a1' }]);
  pool.selectAccount('cn', 'a1');
  pool.selectAccount('cn', '');
  ok('空字符串清除选择', pool.selectedAccountId('cn') === undefined);
  pool.selectAccount('cn', 'a1');
  pool.selectAccount('cn', undefined);
  ok('undefined 清除选择', pool.selectedAccountId('cn') === undefined);
}

console.log(`\nwb-pool-selected: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
