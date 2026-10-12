/**
 * lib/live-catalog.mjs 的测试。
 *
 * # 这里最重要的一条：读路径**永不阻塞、永不抛错**
 *
 * `getModels()` 是 pi-ai 的同步接口，选择器一帧能调十几次。刷新协调器是挂在它
 * 旁边的后台动作，任何「刷新失败把异常抛给选择器」的写法都会让整个 provider
 * 从选择器里消失 —— 这正是这个文件要防住的事。
 *
 * 第二条是**变更才广播**：广播会 `.replace()` 适配器路由，客户端收到
 * `llm/adapters-updated` 就重拉一次 catalog。无脑每轮都广播 = 每个 TTL 周期白抖
 * 一次 UI。
 *
 * 运行：node test/live-catalog.test.mjs
 */

import {
  DEFAULT_LIVE_RETRY_MS,
  DEFAULT_LIVE_TTL_MS,
  catalogSignature,
  createLiveRefresher,
} from '../lib/live-catalog.mjs';

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
const eq = (name, actual, expected) =>
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

console.log('实时目录协调器（读时刷新）\n');

/* —— 1) 签名：只认会显示出来的字段，且与顺序无关 —— */
{
  console.log('1) 目录签名');
  const a = [
    { id: 'm1', name: 'Alpha', priceFactor: 0.8 },
    { id: 'm2', name: 'Beta', multiplier: 1.62 },
  ];
  const b = [
    { id: 'm2', name: 'Beta', multiplier: 1.62 },
    { id: 'm1', name: 'Alpha', priceFactor: 0.8 },
  ];
  eq('条目顺序变化 → 签名不变（不触发无意义广播）', catalogSignature(a), catalogSignature(b));

  const c = [
    { id: 'm1', name: 'Alpha', priceFactor: 0.5 },
    { id: 'm2', name: 'Beta', multiplier: 1.62 },
  ];
  ok('只调价 → 签名改变（实时倍率的关键）', catalogSignature(a) !== catalogSignature(c));

  const d = [
    { id: 'm1', name: 'Alpha Renamed', priceFactor: 0.8 },
    { id: 'm2', name: 'Beta', multiplier: 1.62 },
  ];
  ok('改名 → 签名改变', catalogSignature(a) !== catalogSignature(d));

  ok('换模型 → 签名改变', catalogSignature(a) !== catalogSignature([a[0]]));
  eq('非数组 → 空串', catalogSignature(undefined), '');
  eq('空目录 → 稳定签名', catalogSignature([]), '[]');

  // 三家字段名都要纳入
  const wb = [{ id: 'x', name: 'X', multiplier: 0.79 }];
  const trae = [{ id: 'x', name: 'X', creditMultiplier: 0.79 }];
  const qoder = [{ id: 'x', name: 'X', priceFactor: 0.79 }];
  eq('三家倍率字段名归一到同一签名', catalogSignature(wb), catalogSignature(trae));
  eq('三家倍率字段名归一到同一签名（Qoder）', catalogSignature(qoder), catalogSignature(wb));
}

/* —— 2) 新鲜期：TTL 内不再打上游 —— */
{
  console.log('\n2) 新鲜期与触发时机');
  let clock = 1_000_000;
  let calls = 0;
  const r = createLiveRefresher({
    now: () => clock,
    ttlMs: 60_000,
    retryMs: 15_000,
    refresh: async () => {
      calls += 1;
      return { ok: true, signature: 'sig-1' };
    },
  });

  ok('从未成功过 → isFresh 为 false', r.isFresh() === false);
  ok('从未成功过 → 触发刷新', r.ensureFresh() !== undefined);
  await r.ensureFresh();
  await Promise.resolve();
  eq('刷新一次后 calls=1', calls, 1);
  ok('刷新成功后 isFresh 为 true', r.isFresh() === true);
  eq('lastOkAtMs 被记录', r.lastOkAtMs(), clock);

  r.ensureFresh();
  await Promise.resolve();
  eq('TTL 内不再打上游', calls, 1);

  clock += 60_001;
  ok('超过 TTL 后 isFresh 为 false', r.isFresh() === false);
  const pending = r.ensureFresh();
  ok('超过 TTL 后触发刷新', pending !== undefined);
  await pending;
  eq('刷新后 calls=2', calls, 2);
}

/* —— 3) 并发合并：同刻只打一次 —— */
{
  console.log('\n3) 并发合并');
  let resolveRefresh;
  let calls = 0;
  const r = createLiveRefresher({
    ttlMs: 0,
    refresh: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
  });
  const p1 = r.ensureFresh();
  const p2 = r.ensureFresh();
  const p3 = r.ensureFresh();
  // `inflight` 在同步期就已占位，所以重复调用不会再排队；真正打上游发生在
  // 微任务里（读路径不因此阻塞），这里先让微任务跑一轮再断言。
  ok('三次调用拿到同一个 promise', p1 === p2 && p2 === p3);
  await Promise.resolve();
  eq('三个并发调用只打一次上游', calls, 1);
  resolveRefresh({ ok: true, signature: 's' });
  await p1;
  eq('合并后仍只打了一次', calls, 1);
}

/* —— 4) 失败：不续命、不抛错、有退避 —— */
{
  console.log('\n4) 失败处理');
  let clock = 5_000_000;
  let calls = 0;
  let errors = 0;
  const r = createLiveRefresher({
    now: () => clock,
    ttlMs: 60_000,
    retryMs: 15_000,
    onError: () => {
      errors += 1;
    },
    refresh: async () => {
      calls += 1;
      throw new Error('upstream 500');
    },
  });

  // 关键：读路径拿到的是 undefined/promise，而 refresh 的异常必须被吞掉
  const p = r.ensureFresh();
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  ok('刷新抛错不会传给读路径', threw === false);
  eq('失败被报给 onError', errors, 1);
  eq('失败后 lastOkAtMs 仍为 0（不续命）', r.lastOkAtMs(), 0);
  ok('失败后 isFresh 仍为 false', r.isFresh() === false);

  clock += 1_000;
  const again = r.ensureFresh();
  eq('退避窗口内不重试', calls, 1);
  eq('退避时不返回新任务', again, undefined);

  clock += 15_000;
  const retry = r.ensureFresh();
  ok('退避过后重试', retry !== undefined);
  await retry;
  eq('重试后 calls=2', calls, 2);

  // 成功后应恢复正常
  const r2 = createLiveRefresher({
    now: () => clock,
    ttlMs: 60_000,
    refresh: async () => ({ ok: true, signature: 'ok' }),
  });
  await r2.ensureFresh();
  ok('成功后 isFresh 为 true', r2.isFresh() === true);
}

/* —— 5) 变更才广播 —— */
{
  console.log('\n5) 变更才广播');
  let clock = 0;
  let sig = 'A';
  let broadcasts = 0;
  const r = createLiveRefresher({
    now: () => clock,
    ttlMs: 10,
    refresh: async () => ({ ok: true, signature: sig }),
  });
  // onChange 通过 options 传入（见下）；这里重造一个带 onChange 的
  const r2 = createLiveRefresher({
    now: () => clock,
    ttlMs: 10,
    refresh: async () => ({ ok: true, signature: sig }),
    onChange: () => {
      broadcasts += 1;
    },
  });
  await r2.ensureFresh();
  eq('首次刷新算「变了」并广播', broadcasts, 1);

  clock += 20;
  await r2.ensureFresh();
  eq('内容未变 → 不广播', broadcasts, 1);

  sig = 'B';
  clock += 20;
  await r2.ensureFresh();
  eq('内容变了 → 广播', broadcasts, 2);

  // 无签名（undefined）= 无法比较，保守按变了处理
  let b3 = 0;
  const r3 = createLiveRefresher({
    now: () => clock,
    ttlMs: 10,
    refresh: async () => ({ ok: true }),
    onChange: () => {
      b3 += 1;
    },
  });
  await r3.ensureFresh();
  clock += 20;
  await r3.ensureFresh();
  eq('无签名 → 每次都广播（保守）', b3, 2);

  // ok:false 不广播、不计新鲜
  let b4 = 0;
  const r4 = createLiveRefresher({
    now: () => clock,
    ttlMs: 10,
    refresh: async () => ({ ok: false }),
    onChange: () => {
      b4 += 1;
    },
  });
  await r4.ensureFresh();
  eq('ok:false → 不广播', b4, 0);
  eq('ok:false → 不算成功', r4.lastOkAtMs(), 0);
}

/* —— 6) markFresh / dispose —— */
{
  console.log('\n6) markFresh 与 dispose');
  let clock = 100;
  let calls = 0;
  const r = createLiveRefresher({
    now: () => clock,
    ttlMs: 60_000,
    refresh: async () => {
      calls += 1;
      return { ok: true, signature: 'seed' };
    },
  });
  r.markFresh('seed');
  ok('markFresh 后 isFresh 为 true', r.isFresh() === true);
  eq('markFresh 记下签名', r.signature(), 'seed');
  r.ensureFresh();
  await Promise.resolve();
  eq('标记新鲜后不再打上游', calls, 0);

  r.dispose();
  clock += 120_000;
  eq('dispose 后不再触发', r.ensureFresh(), undefined);
}

/* —— 7) 常量可被覆盖且有合理默认 —— */
{
  console.log('\n7) 默认值');
  ok('默认 TTL 是正数', DEFAULT_LIVE_TTL_MS > 0);
  ok('默认重试间隔是正数', DEFAULT_LIVE_RETRY_MS > 0);
  ok('重试间隔短于 TTL（失败后能较快恢复试探）', DEFAULT_LIVE_RETRY_MS < DEFAULT_LIVE_TTL_MS);
}

console.log(`\nlive-catalog: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
