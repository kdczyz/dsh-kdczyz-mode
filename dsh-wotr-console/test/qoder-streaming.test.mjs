/**
 * `streamQoderRequest` 的**流式行为**测试。
 *
 * # 这条测试防的是什么（真机故障，2026-10-11）
 *
 * 用户报告：「qoderToken 速率那么快，老是 502，限额上游拒绝请求」。
 * 实测推翻了这个判断 —— **上游从没限流**（18 次并发压测零失败）：
 *
 *   上游首帧:  503ms
 *   上游收完:  5752ms
 *
 * 而旧实现（`sendQoderRequest`）把响应体**整个缓冲完**才 resolve，于是
 * 客户端要等 5752ms 才看到第一个字。客户端据此判超时并**重发请求**，
 * 表现为「速率异常高 + 老 502」—— 上游调用量因此成倍上升。
 *
 * 修复后首字节 **367ms**（提升 15.7 倍），97 个块逐块到达。
 *
 * # 为什么不能只断言「结果正确」
 *
 * 缓冲实现与流式实现**最终产出的字节完全相同** —— 断言内容、断言帧数、
 * 断言 `[DONE]` 都区分不出两者。唯一能区分的是**时间**：
 * 第一帧必须在服务端发完之前就交出来。
 *
 * 所以这里的核心用例是「**慢速上游**」：服务端每帧之间 sleep，
 * 断言第一帧的到达时刻**远早于**服务端发完的时刻。
 * 缓冲实现必然失败（它会等到 end），流式实现必然通过。
 *
 * 运行：node test/qoder-streaming.test.mjs
 */

import http from 'node:http';

import { streamQoderRequest, unwrapQoderFrame } from '../lib/qoder-relay.mjs';

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

console.log('Qoder 流式转发（首字节不再等整段回复）\n');

/** 造一个「慢速 SSE 上游」：逐帧发送，帧间有延迟。 */
async function slowUpstream(frames, { gapMs = 60, status = 200, headers = {} } = {}) {
  const server = http.createServer(async (req, res) => {
    // 先把请求体读干，否则客户端会看到挂起
    req.resume();
    await new Promise((r) => req.on('end', r));
    res.writeHead(status, { 'Content-Type': 'text/event-stream', ...headers });
    for (const f of frames) {
      await new Promise((r) => setTimeout(r, gapMs));
      res.write(f);
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/chat`, close: () => new Promise((r) => server.close(r)) };
}

/** 真机实录的帧形状：信封套内层 JSON 字符串。 */
const envelope = (inner) => `data:${JSON.stringify({
  headers: { 'Content-Type': ['application/json'] },
  body: typeof inner === 'string' ? inner : JSON.stringify(inner),
  statusCodeValue: 200,
  statusCode: 'OK',
})}\n\n`;

const CHUNK = (t) => envelope({ choices: [{ delta: { content: t }, index: 0 }], object: 'chat.completion.chunk' });

/* —— 1) 核心：首帧必须早于服务端发完 —— */
{
  const frames = [CHUNK('一'), CHUNK('二'), CHUNK('三'), CHUNK('四'), envelope('[DONE]')];
  const up = await slowUpstream(frames, { gapMs: 80 });
  const t0 = Date.now();
  const arrivals = [];
  let firstFrameAt = 0;

  const result = await streamQoderRequest({
    url: up.url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [] }),
    onFrame: () => {
      arrivals.push(Date.now() - t0);
      if (firstFrameAt === 0) firstFrameAt = Date.now() - t0;
    },
  });
  const finishedAt = Date.now() - t0;
  await up.close();

  // 上游 5 帧 × 80ms ≈ 400ms。缓冲实现下 firstFrameAt ≈ finishedAt。
  ok('首帧在服务端发完之前就已交付', firstFrameAt < finishedAt * 0.6,
    `首帧 ${firstFrameAt}ms vs 发完 ${finishedAt}ms`);
  ok('帧是逐帧到达的（不是一次性）', arrivals.length >= 4 && arrivals[0] < arrivals[arrivals.length - 1] - 100,
    `${arrivals.length} 帧，时刻 ${arrivals.join(', ')}ms`);
  ok('全部帧都转发到位', result.frameCount === 5, String(result.frameCount));
  ok('记录了首帧耗时', result.firstFrameMs > 0 && result.firstFrameMs <= firstFrameAt + 50,
    `firstFrameMs=${result.firstFrameMs}`);
}

/* —— 2) 首帧判定：业务错误必须在响应头发出**之前**拦下 —— */
//
// 这是「等首帧再返回」的全部理由：一旦 shim 拿到 body 就 writeHead(200)，
// 再想改成 5xx 已经不可能。所以首个信封若表示业务失败，必须在这一刻拒绝。
{
  const bizError = envelope({ code: '400', message: '[FAIL]Execution failed: null' });
  const up = await slowUpstream([bizError, CHUNK('不该被转发')], { gapMs: 30 });
  const forwarded = [];
  const result = await streamQoderRequest({
    url: up.url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    onFirstFrame: (frame) => {
      // 与 qoder.js 相同的判据：外层 200 也要看内层 code
      const inner = JSON.parse(frame.inner);
      if (inner?.code !== undefined && String(inner.code) !== '0') {
        return { ok: false, reason: `${inner.code} ${inner.message}` };
      }
      return { ok: true };
    },
    onFrame: (inner) => forwarded.push(inner),
  });
  await up.close();

  ok('首帧为业务错误时判定失败', typeof result.failed === 'string' && result.failed.includes('FAIL'),
    String(result.failed));
  ok('判定失败后不再转发任何帧', forwarded.length === 0, JSON.stringify(forwarded.length));
  ok('判定失败时 frameCount 为 0', result.frameCount === 0, String(result.frameCount));
}

/* —— 3) 非 200：没有可解析的流，原样带回状态码与 body —— */
{
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: '429', message: 'rate limited' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const result = await streamQoderRequest({
    url: `http://127.0.0.1:${server.address().port}/chat`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await new Promise((r) => server.close(r));
  ok('非 200 时原样返回状态码', result.status === 429, String(result.status));
  ok('非 200 时带回 body 供分类', String(result.body).includes('rate limited'), String(result.body));
  ok('非 200 时不产生帧', result.frameCount === 0);
}

/* —— 4) 跨 chunk 断帧：一帧被切成两半也要能拼回来 —— */
//
// 上游按 TCP 分块到达，一帧 `data:{…}\n\n` 完全可能跨越两次 `data` 事件。
// 不做行缓冲拼接就会把半帧当"非 JSON"丢掉 —— 表现为「回复缺字」且不报错。
{
  const server = http.createServer(async (req, res) => {
    req.resume();
    await new Promise((r) => req.on('end', r));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = CHUNK('拼接成功');
    // 故意从中间切开，且中间隔着一次事件循环
    res.write(frame.slice(0, 20));
    await new Promise((r) => setTimeout(r, 40));
    res.write(frame.slice(20));
    await new Promise((r) => setTimeout(r, 20));
    res.write(envelope('[DONE]'));
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = [];
  const result = await streamQoderRequest({
    url: `http://127.0.0.1:${server.address().port}/chat`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    onFrame: (inner) => got.push(inner),
  });
  await new Promise((r) => server.close(r));

  ok('被切开的帧能拼回（不丢帧）', result.frameCount === 2, String(result.frameCount));
  ok('拼回的帧内容完整', got.some((g) => String(g).includes('拼接成功')), JSON.stringify(got).slice(0, 120));
}

/* —— 5) 取消：客户端断开时能立刻停 —— */
{
  const frames = Array.from({ length: 50 }, (_, i) => CHUNK(`块${i}`));
  const up = await slowUpstream(frames, { gapMs: 20 });
  const t0 = Date.now();
  const controller = new AbortController();
  let count = 0;
  const result = await streamQoderRequest({
    url: up.url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    onFirstFrame: () => {
      // 模拟「首帧后发现不该继续」：立刻取消
      controller.abort();
      return { ok: false, reason: 'client-aborted' };
    },
    onFrame: () => { count += 1; },
  }).catch(() => ({ failed: 'aborted' }));
  const ms = Date.now() - t0;
  await up.close();

  ok('首帧判定失败后立即结束（不等上游发完 50 帧）', ms < 300, `${ms}ms`);
  ok('没有继续转发后续帧', count === 0, String(count));
  ok('返回了失败标记', result.failed !== undefined, JSON.stringify(result.failed));
}

/* —— 6) 与既有转换规则一致：信封解包仍然只有 inner 被传出 —— */
{
  const up = await slowUpstream([CHUNK('x'), envelope('[DONE]')], { gapMs: 20 });
  const raws = [];
  await streamQoderRequest({
    url: up.url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    onFrame: (inner) => raws.push(inner),
  });
  await up.close();
  ok('回调拿到的是解包后的 inner（不含信封）',
    raws.length > 0 && raws.every((r) => !String(r).includes('statusCodeValue')),
    JSON.stringify(raws[0] ?? null).slice(0, 100));
  // inner 是**字符串**（信封里的 body 是被转义成字符串的 JSON）。
  // 除 `[DONE]` 哨兵外，内容都必须是可解析 JSON —— qoder.js 的 bridge 直接透传。
  // （`[DONE]` 的内层就是字面量 "[DONE]"，不是 JSON，这是上游的既定形状。）
  const nonSentinel = raws.filter((r) => String(r).trim() !== '[DONE]');
  ok('除 [DONE] 外，inner 的内容都是可解析 JSON',
    nonSentinel.length > 0 && nonSentinel.every((r) => { try { JSON.parse(r); return true; } catch { return false; } }),
    JSON.stringify(nonSentinel).slice(0, 100));
  ok('[DONE] 以内层字面量形式到达（由 bridge 还原成裸哨兵）',
    raws.some((r) => String(r).trim() === '[DONE]'), JSON.stringify(raws).slice(0, 120));
}

console.log(`\nqoder-streaming: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
