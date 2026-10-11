/**
 * qoder.js 的**流转换**测试：Qoder 双层信封 SSE → 标准 OpenAI SSE。
 *
 * # 这一层为什么必须测
 *
 * 它是「能不能正常对话」的最后一环，而且踩过两个完全不显然的坑 ——
 * 两个坑的症状都是「请求成功但客户端收到的内容不对」，不会报任何上游错误：
 *
 * 1. **`[DONE]` 在信封里**，不是裸哨兵。真机是 `"body":"[DONE]"`。若不还原，
 *    客户端等不到结束标记，表现为「回复打完了但一直不结束」。
 * 2. **`[DONE]` 之后还有一帧 `event:finish`**，data 是 `{"firstTokenDuration":…}`。
 *    那不是 OpenAI 协议里的东西，透传过去 pi-ai 会拿它当 chat chunk 解析而报错。
 *
 * 另外信封的内层 `body` 是**被转义成字符串的 JSON**，要再 parse 一次；漏了这步
 * 客户端拿到的会是「一个字符串」而不是结构化 chunk。
 *
 * 测试用的是**真机实录**的帧形状（2026-10-11 抓的），不是编的。
 *
 * 运行：node test/qoder-chat.test.mjs
 */

import { detectBusinessError, extractInnerBody, sseStreamOf } from '../lib/qoder.js';

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

console.log('Qoder 流转换\n');

/** 把 Qoder 信封帧包成真机那样的 `data:` 行。 */
const frame = (inner) =>
  `data:${JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: typeof inner === 'string' ? inner : JSON.stringify(inner),
    statusCodeValue: 200,
    statusCode: 'OK',
  })}`;

/** 读干一个 Web ReadableStream，返回文本。 */
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** 从标准 SSE 文本里拼出正文，并返回结束标记是否出现。 */
function assemble(sse) {
  let text = '';
  let done = false;
  const bad = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const chunk = JSON.parse(payload);
      text += chunk.choices?.[0]?.delta?.content ?? '';
    } catch {
      bad.push(payload.slice(0, 60));
    }
  }
  return { text, done, bad };
}

/* —— 1) 真机形状：逐字 delta + 信封内的 [DONE] + 尾部 event:finish —— */
{
  const live = [
    frame({ choices: [{ delta: { content: '我是', role: 'assistant' }, index: 0 }], model: 'auto', object: 'chat.completion.chunk' }),
    '',
    frame({ choices: [{ delta: { content: ' Q' }, index: 0 }], model: 'auto', object: 'chat.completion.chunk' }),
    '',
    frame({ choices: [{ delta: { content: 'wen' }, index: 0 }], model: 'auto', object: 'chat.completion.chunk' }),
    '',
    frame({ choices: [], usage: { total_tokens: 61, credits: 0 }, model: 'auto', object: 'chat.completion.chunk' }),
    '',
    frame('[DONE]'),
    '',
    'event:finish',
    'data:{"firstTokenDuration":184,"totalDuration":800,"serverDuration":49}',
    '',
  ].join('\n');

  const sse = await drain(sseStreamOf(live));
  const { text, done, bad } = assemble(sse);

  ok('逐字正文完整拼接', text === '我是 Qwen', JSON.stringify(text));
  ok('没有不可解析的帧', bad.length === 0, JSON.stringify(bad));
  ok('信封里的 [DONE] 被还原成裸哨兵', done);
  ok('尾部 event:finish 被丢掉', !sse.includes('firstTokenDuration'));
  ok('输出里不含 event: 行（那是上游私有协议）', !/^event:/m.test(sse));
  ok('每帧都是 data: 前缀', sse.split('\n').filter((l) => l.trim() !== '').every((l) => l.startsWith('data:')));
}

/* —— 2) 内层 body 必须被二次 parse 成结构化 chunk —— */
{
  const inner = { choices: [{ delta: { content: 'x' }, index: 0 }], object: 'chat.completion.chunk' };
  const sse = await drain(sseStreamOf(frame(inner)));
  const payload = sse.split('\n').find((l) => l.startsWith('data:')).slice(5).trim();
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = undefined;
  }
  ok('内层 body 被解析成对象而不是字符串', typeof parsed === 'object' && parsed !== null);
  ok('解析后的结构与上游一致', parsed?.choices?.[0]?.delta?.content === 'x');
}

/* —— 3) 裸帧（不是信封）应当被丢掉，而不是透传 —— */
{
  // 国际版是裸 OpenAI 帧；这里走的是 CN 签名链，裸帧意味着形状变了。
  // 透传会让客户端把它当合法 chunk —— 形状不一致时宁可丢。
  const mixed = ['data:{"choices":[{"delta":{"content":"raw"}}]}', '', frame({ choices: [{ delta: { content: 'ok' }, index: 0 }] })].join('\n');
  const sse = await drain(sseStreamOf(mixed));
  const { text } = assemble(sse);
  ok('裸帧被丢掉，只有信封帧透传', text === 'ok', JSON.stringify(text));
}

/* —— 4) 坏 JSON / 空流 / 边界不抛 —— */
{
  const bad = await drain(sseStreamOf('data:{not json}\n\ndata:\n\n'));
  ok('坏 JSON 不抛且产出空流', bad.trim() === '', JSON.stringify(bad));
  const empty = await drain(sseStreamOf(''));
  ok('空输入产出空流', empty === '');
  const nil = await drain(sseStreamOf(undefined));
  ok('undefined 不抛', nil === '');
}

/* —— 5) extractInnerBody：给「200 但业务失败」的嗅探用 —— */
{
  ok('取得到第一段信封 body', extractInnerBody(frame({ choices: [] })) !== undefined);
  ok('无 data 行时返回 undefined', extractInnerBody('event:error\n') === undefined);
  ok('坏 JSON 返回 undefined', extractInnerBody('data:{oops}') === undefined);
  ok('裸帧（非信封）返回 undefined', extractInnerBody('data:{"choices":[]}') === undefined);
}


/* ────────────────────────────────────────────────────────────── *
 * 追加：业务错误嗅探（detectBusinessError）
 *
 * 上游用 **HTTP 200 + 信封内 `statusCodeValue:400`** 表示业务拒绝。
 * 漏判的表现是「模型跑不通但完全不报错」—— 真机实测（2026-10-11）：
 * `qfmodel` 回的就是这种帧，而当时生产代码只检查"有没有信封帧"，
 * 于是错误对象被当正常 chunk 透传，客户端收到 `{code,message}` 而非
 * `{choices:[…]}`，界面上就是"没反应"。
 * ────────────────────────────────────────────────────────────── */

console.log('\n业务错误嗅探\n');

const bizFrame = (inner, code) =>
  `data:${JSON.stringify({
    headers: { 'Content-Type': ['application/json'] },
    body: typeof inner === 'string' ? inner : JSON.stringify(inner),
    statusCodeValue: code,
    statusCode: code === 200 ? 'OK' : 'BAD_REQUEST',
  })}`;

// ① 真机实录的错误帧必须被识别
{
  const raw = bizFrame(
    { code: '400', message: '[FAIL]node:oa_qwen-plus-main msg:Execution failed: null' },
    400,
  );
  const hit = detectBusinessError(raw);
  ok('识别 statusCodeValue:400 的错误帧', hit !== undefined, JSON.stringify(hit));
  ok('透出上游业务码', hit?.code === '400', String(hit?.code));
  ok('透出上游错误信息', String(hit?.message).includes('Execution failed'), String(hit?.message));
  ok('status 取信封里的 400', hit?.status === 400, String(hit?.status));
}

// ② 正常流不能被误判（这是最关键的反向断言）
{
  const normal = [
    bizFrame({ choices: [{ delta: { content: 'OK' }, index: 0 }], id: 'x', object: 'chat.completion.chunk' }, 200),
    bizFrame({ choices: [{ delta: { reasoning_content: '想' }, index: 0 }], id: 'x' }, 200),
    bizFrame('[DONE]', 200),
    'event:finish\ndata:{"firstTokenDuration":996,"totalDuration":2221}',
  ].join('\n\n');
  ok('正常流（含 [DONE] 与 event:finish）不被误判', detectBusinessError(normal) === undefined, JSON.stringify(detectBusinessError(normal)));
}

// ③ 边界：空 / 无信封 / 坏 JSON 都不能抛，也不能误判
ok('空文本不误判', detectBusinessError('') === undefined);
ok('undefined 不误判', detectBusinessError(undefined) === undefined);
ok('无信封的裸帧不误判', detectBusinessError('data:{"foo":1}') === undefined);
ok('坏 JSON 不误判', detectBusinessError('data:{oops') === undefined);

// ④ 没有 statusCodeValue 但内层是 {code,message} 也要认（旧版形状兼容）
{
  const raw = `data:${JSON.stringify({ body: JSON.stringify({ code: '101', message: 'Signature invalid' }) })}`;
  const hit = detectBusinessError(raw);
  ok('无 statusCodeValue 时按内层 {code,message} 判定', hit !== undefined, JSON.stringify(hit));
  ok('内层业务码 101 被透出', hit?.code === '101', String(hit?.code));
}

// ⑤ 内层有 choices 时必须判成功（即使同时带了 code 字段）
{
  const raw = bizFrame({ code: '0', choices: [{ delta: { content: 'hi' }, index: 0 }] }, 200);
  ok('内层有 choices 且 code=0 → 判成功', detectBusinessError(raw) === undefined, JSON.stringify(detectBusinessError(raw)));
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
