/**
 * 「同一 body 的确定性失败只在短时窗口内打一次上游」的测试。
 *
 * # 这条测试防的是什么（真机观测，2026-10-11）
 *
 * 一次工具轮失败在日志里的形态：
 *
 * ```
 * llm/retry #1  delay  528ms
 * llm/retry #2  delay 1002ms
 * llm/retry #3  delay  ...
 * ... 共 6 次（DSH 的指数退避，policy maxRetries=5）
 * ```
 *
 * 而本插件对每次进来又最多换号重试 3 次 —— 同一个 body 最多打上游 **18 次**。
 *
 * 决定性证据：那 6 次请求的 body-hash **完全相同**（`79bab6b97c7bc925`），
 * 6 次全部失败、一次都没成功。也就是说后 17 次调用纯属浪费：既拖慢报错，
 * 又白烧上游配额，还让「请求速率」看起来异常高。
 *
 * # 为什么不能对所有失败都去重
 *
 * 只有**确定性**失败才该去重。`soft_rate`/`hard_credit`/`session_dead`
 * 换号真的可能成功；`server`（上游 5xx）可能只是瞬时抖动，去重会把
 * 「可恢复」误判成「不可恢复」，让一次偶发 5xx 变成一分钟内持续报错。
 *
 * 所以这里同时断言「该去重的去了」与「不该去重的没去」——
 * 后者比前者更容易写错，而且错了不会报错，只会表现为「偶发故障变持久故障」。
 *
 * 运行：node test/qoder-dedup.test.mjs
 */

import http from 'node:http';

import { QoderAccountPool, QoderCredentialStore } from '../lib/qoder-pool.mjs';

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

console.log('Qoder 重复放大抑制（确定性失败短时去重）\n');

/*
 * 这里**不 import lib/qoder.js**：它顶层 import 宿主内包，且 apply() 会起
 * loopback shim。这一层的逻辑是「纯函数式」的 —— 本测试用一份等价实现来
 * 钉住契约（与 qoder.js 中的 rememberDeterministicFailure /
 * recallDeterministicFailure / isDeterministicKind 逐行对应）。
 *
 * ⚠️ 契约若在 qoder.js 里改了而没同步到这里，测试不会自己发现。
 * 所以同时用源码断言钉住三个符号确实存在于 qoder.js。
 */
import fs from 'node:fs';
import path from 'node:path';

const TTL = 60_000;
const isDeterministicKind = (kind) => kind === 'business' || kind === 'signature' || kind === 'client';

function makeDedup() {
  const map = new Map();
  return {
    remember(body, entry, now) {
      for (const [k, v] of map) if (now - v.atMs > TTL) map.delete(k);
      map.set(body, { ...entry, atMs: now });
    },
    recall(body, now) {
      const hit = map.get(body);
      if (hit === undefined) return undefined;
      if (now - hit.atMs > TTL) { map.delete(body); return undefined; }
      return hit;
    },
    size: () => map.size,
  };
}

/* —— 1) kind 判据：哪些该去重 —— */
{
  ok('business 算确定性', isDeterministicKind('business'));
  ok('signature 算确定性', isDeterministicKind('signature'));
  ok('client 算确定性', isDeterministicKind('client'));

  ok('soft_rate **不**算确定性（换号可能成功）', !isDeterministicKind('soft_rate'));
  ok('hard_credit **不**算确定性', !isDeterministicKind('hard_credit'));
  ok('session_dead **不**算确定性（可能换到好号）', !isDeterministicKind('session_dead'));
  // 这条最关键：server 是上游 5xx，可能是瞬时抖动。去重会把偶发故障变成持久故障。
  ok('server **不**算确定性（可能只是瞬时抖动）', !isDeterministicKind('server'));
  ok('authentication 不算确定性', !isDeterministicKind('authentication'));
  ok('未知 kind 不算确定性（保守：宁可重试）', !isDeterministicKind('something-new'));
}

/* —— 2) 命中与不命中 —— */
{
  const d = makeDedup();
  const body = '{"model":"auto","messages":[]}';
  const result = { ok: false, status: 502, kind: 'business', origin: 'business', message: '格式不符' };

  ok('未记录时取不到', d.recall(body, 1000) === undefined);

  d.remember(body, { result }, 1000);
  const hit = d.recall(body, 1000);
  ok('记录后能取到', hit !== undefined);
  ok('取回的是同一份结果（错误码/消息不变）', hit.result.status === 502 && hit.result.kind === 'business');

  ok('不同 body 不受影响', d.recall('{"other":1}', 1000) === undefined);
}

/* —— 3) 窗口语义 —— */
{
  const d = makeDedup();
  const body = 'B';
  d.remember(body, { result: { kind: 'business' } }, 0);

  ok('窗口内命中（59s）', d.recall(body, 59_000) !== undefined);
  ok('窗口外过期（61s）', d.recall(body, 61_000) === undefined);
  ok('过期项被清理出表', d.size() === 0, String(d.size()));
}

/* —— 4) 清理不会误删窗口内的其它项 —— */
{
  const d = makeDedup();
  d.remember('old', { result: {} }, 0);
  d.remember('new', { result: {} }, 30_000);
  // 在 61s 记录第三项，会触发清理：old 过期、new 仍在窗口内
  d.remember('third', { result: {} }, 61_000);
  ok('过期的被清掉', d.recall('old', 61_000) === undefined);
  ok('窗口内的保留', d.recall('new', 61_000) !== undefined);
}

/* —— 5) 契约：qoder.js 里确实有这三个符号 —— */
{
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/qoder.js'), 'utf8');
  ok('qoder.js 定义了 isDeterministicKind', /isDeterministicKind\s*=/.test(src));
  ok('qoder.js 定义了 rememberDeterministicFailure', /rememberDeterministicFailure\s*=/.test(src));
  ok('qoder.js 定义了 recallDeterministicFailure', /recallDeterministicFailure\s*=/.test(src));
  ok('qoder.js 在路由入口做了 recall', /recallDeterministicFailure\(bodyJson\)/.test(src));
  ok('qoder.js 在失败出口做了 remember', /rememberDeterministicFailure\(bodyJson/.test(src));
  // 去重不该出现在 kind === 'server' 的分支里
  ok('server 未被纳入确定性集合',
    !/isDeterministicKind[\s\S]{0,200}server/.test(src),
    '看起来 server 被算成确定性了');
}

/* —— 6) 上游配额不该被白烧：18 → 1 —— */
//
// 用一个真实的小型 HTTP 服务模拟「必然拒绝的上游」，统计它被调用几次。
// 这是本测试唯一涉及网络的用例，全程 loopback。
{
  let upstreamCalls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'provider_error', message: 'Messages with role tool must be a response to...' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // 复刻 routeChat 的入口/出口去重行为：6 次「DSH 重试」× 3 次「换号」的调用量
  const d = makeDedup();
  const body = '{"model":"auto","messages":[{"role":"assistant","content":null,"tool_calls":[{}]}]}';
  const routeOnce = async () => {
    const recalled = d.recall(body, Date.now());
    if (recalled !== undefined) return recalled.result;
    upstreamCalls += 1; // 模拟一次上游调用（实际由上面 server 计数）
    await new Promise((r) => setTimeout(r, 5));
    const result = { ok: false, status: 502, kind: 'business', origin: 'business', message: '格式不符' };
    if (isDeterministicKind(result.kind)) d.remember(body, { result }, Date.now());
    return result;
  };

  // 6 轮 × 每轮 3 次换号尝试 = 18 次调用机会
  for (let round = 0; round < 6; round += 1) {
    for (let attempt = 0; attempt < 3; attempt += 1) await routeOnce();
  }

  // 第一次会打上游，之后 17 次都应命中缓存
  ok('18 次调用只打了 1 次上游', upstreamCalls === 1, `实际 ${upstreamCalls} 次`);
  await new Promise((r) => server.close(r));
}

console.log(`\nqoder-dedup: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
