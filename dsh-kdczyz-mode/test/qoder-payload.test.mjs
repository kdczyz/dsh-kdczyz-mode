/**
 * 请求体归一化测试：上游要求的「assistant + tool_calls 必须有字符串 content」。
 *
 * # 这条测试防的是什么（真机故障，2026-10-11）
 *
 * 用户报告：「用 qoder 做需要工具的任务必定 502」。此前日志里上游原文一直
 * 被截断成 `Messages with role 'tool' must b…`，让人误以为是 tool 消息格式问题。
 *
 * 落盘真实请求体后才拿到完整原文：
 *
 * ```
 * Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 * ```
 *
 * 二分定位到具体消息，对比两组：
 *
 * | 前置 assistant | 上游 |
 * |---|---|
 * | `content: "我来看看…"` + tool_calls | ✅ 认可 |
 * | `content: null` + tool_calls | ❌ **不认为它声明了 tool_calls** |
 *
 * 于是其后的 `tool` 消息失去前置 → 整条请求被拒。
 * pi-ai 在「只发工具调用、没有文本」时正是发 `content: null`，
 * 所以纯工具轮次必挂、带一句说明的轮次正常 —— 表现为「时好时坏」。
 *
 * # 为什么不能只断言「归一化后不为 null」
 *
 * 上游真正接受的是**字符串**。`content: ""` 通过，但**省略整个字段不通过**
 * （实测过），所以断言必须钉住「字段存在且是 string」，
 * 而不是「不是 null」——后者放过了「删掉字段」这种同样错误的做法。
 *
 * 运行：node test/qoder-payload.test.mjs
 */

import {
  normalizeQoderPayload,
  buildQoderChatRequest,
  buildQoderFingerprintedRequest,
} from '../lib/qoder-relay.mjs';

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

console.log('Qoder 请求体归一化（assistant + tool_calls 的 content）\n');

const CALLS = [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }];

/* —— 1) 核心：content:null + tool_calls → 空串 —— */
{
  const input = { messages: [{ role: 'assistant', content: null, tool_calls: CALLS }] };
  const out = normalizeQoderPayload(input);
  const msg = out.messages[0];
  ok('content:null 被改成空串', msg.content === '', JSON.stringify(msg.content));
  ok('改后是 string 类型（上游只认字符串）', typeof msg.content === 'string', typeof msg.content);
  ok('tool_calls 原样保留', msg.tool_calls === CALLS);
  ok('不改动入参对象（纯函数）', input.messages[0].content === null);
}

/* —— 2) 不该动的一律不动 —— */
{
  // 有文本的 assistant + tool_calls：上游本就认可，改它会注入模型没说过的话
  const withText = { messages: [{ role: 'assistant', content: '我来看看', tool_calls: CALLS }] };
  ok('有文本的 assistant 保持原样', normalizeQoderPayload(withText).messages[0].content === '我来看看');

  // 无 tool_calls 的 assistant + content:null：上游不要求它带 content
  const plainNull = { messages: [{ role: 'assistant', content: null }] };
  ok('无 tool_calls 的 assistant 不被改', normalizeQoderPayload(plainNull).messages[0].content === null);

  // tool_calls 为空数组：等同没有
  const emptyCalls = { messages: [{ role: 'assistant', content: null, tool_calls: [] }] };
  ok('tool_calls 为空数组时不改', normalizeQoderPayload(emptyCalls).messages[0].content === null);

  // 非 assistant 角色
  const userNull = { messages: [{ role: 'user', content: null }] };
  ok('user 消息不受影响', normalizeQoderPayload(userNull).messages[0].content === null);
}

/* —— 3) 混合序列：只改该改的那条 —— */
{
  const input = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '好', tool_calls: CALLS },
      { role: 'tool', tool_call_id: 'call_1', content: 'r' },
      { role: 'assistant', content: null, tool_calls: CALLS },
      { role: 'tool', tool_call_id: 'call_1', content: 'r2' },
    ],
  };
  const out = normalizeQoderPayload(input);
  ok('只改了 content:null 的那条', out.messages[4].content === '' && out.messages[2].content === '好');
  ok('其它消息逐条未变', out.messages[0].content === 'sys' && out.messages[3].content === 'r');
  ok('消息数量不变', out.messages.length === 6);
}

/* —— 4) 没有需要改的：返回**同一个对象引用**（避免无谓拷贝） —— */
{
  const clean = { messages: [{ role: 'user', content: 'x' }] };
  ok('无需改动时返回原引用', normalizeQoderPayload(clean) === clean);
  const changed = { messages: [{ role: 'assistant', content: null, tool_calls: CALLS }] };
  ok('需要改动时返回新对象', normalizeQoderPayload(changed) !== changed);
}

/* —— 5) 畸形输入不抛 —— */
{
  for (const [label, val] of [
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'x'],
    ['数字', 1],
    ['无 messages', {}],
    ['messages 非数组', { messages: 'x' }],
    ['消息是 null', { messages: [null] }],
    ['消息是字符串', { messages: ['x'] }],
  ]) {
    let threw = false;
    try { normalizeQoderPayload(val); } catch { threw = true; }
    ok(`畸形输入不抛：${label}`, !threw);
  }
}

/* —— 6) 两条构造路径都必须带上归一化 —— */
//
// 这是本轮故障最容易复发的地方：曾经「指纹路径能用、手写路径报错」
// 就是因为两条路各写各的。断言两条路的 body 里都没有 content:null。
{
  const identity = { uid: 'u1', securityToken: 'dt-x' };
  const payload = {
    model: 'auto',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: CALLS },
      { role: 'tool', tool_call_id: 'call_1', content: 'r' },
    ],
  };
  const manual = buildQoderChatRequest({ identity, payload });
  ok('手写路径：body 不含 content:null',
    !/"content":null/.test(manual.body), manual.body.slice(0, 200));
  ok('手写路径：content 已是空串', /"content":""/.test(manual.body));

  // 签名必须是对**归一化后**的 body 算的，否则上游会回签名错
  ok('手写路径：Content-Length 与 body 一致',
    Number(manual.headers['Content-Length']) === Buffer.byteLength(manual.body),
    `${manual.headers['Content-Length']} vs ${Buffer.byteLength(manual.body)}`);
}

/* —— 7) 图片块必须原样到达上游 body —— */
//
// 用户报的「当前模型不支持图片」修掉之后，下一条风险就是**图片在插件里被丢掉**：
// 那种失败很难看出来 —— 请求成功、模型正常回话，只是完全没看见图。所以这里直接把
// 两条构造路径的发包内容钉住：pi-ai 把图片转成 OpenAI 形状的
// `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`，插件这一层
// 只允许**逐字透传**。
//
// `normalizeQoderPayload` 是唯一的改写点，它只碰 `content:null + tool_calls` 的
// assistant 消息；这里用「同一条 payload 里既有该改的消息、又有图片消息」来证明
// 改写不会顺手把图片抹掉（早先正是这类整体重建消息的写法最容易踩）。
{
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const imageMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '图里是什么' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ],
  };
  const payload = {
    model: 'dfmodel',
    messages: [
      { role: 'system', content: 's' },
      { role: 'assistant', content: null, tool_calls: CALLS },
      { role: 'tool', tool_call_id: 'call_1', content: 'r' },
      imageMessage,
    ],
  };

  const normalized = normalizeQoderPayload(payload);
  ok(
    '归一化时图片消息一字不动（含 base64 本体）',
    JSON.stringify(normalized.messages.at(-1)) === JSON.stringify(imageMessage),
    JSON.stringify(normalized.messages.at(-1)).slice(0, 120),
  );
  ok('  同一条 payload 里该改的那条仍然改了', normalized.messages[1].content === '');

  const identity = { uid: 'u1', securityToken: 'dt-x' };
  const manual = buildQoderChatRequest({ identity, payload });
  ok(
    '手写路径：body 里带着完整 data URL',
    manual.body.includes(DATA_URL) && /"type"\s*:\s*"image_url"/.test(manual.body),
    manual.body.slice(0, 200),
  );
  ok(
    '手写路径：Content-Length 按带图 body 算（少算会被上游截断）',
    Number(manual.headers['Content-Length']) === Buffer.byteLength(manual.body),
  );

  // 指纹路径：body 由 wasm 编码（不可读），所以钉「交给编码器的那份 JSON」。
  // 这里用替身捕获入参 —— 真 wasm 拿到的就是同一个字符串。
  const captured = {};
  const fakeFingerprint = {
    prepareInferRequest(args) {
      captured.bodyJson = args.bodyJson;
      captured.modelKey = args.modelKey;
      return { url: 'https://example.invalid/x', headers: {}, body: 'ENCODED' };
    },
  };
  const wired = buildQoderFingerprintedRequest({
    fingerprint: fakeFingerprint,
    machineId: 'machine-1',
    uid: 'u1',
    securityToken: 'jt-x',
    payload,
  });
  ok('指纹路径：产出请求', wired !== undefined && wired.body === 'ENCODED');
  ok(
    '指纹路径：交给编码器的 bodyJson 里带着完整 data URL',
    typeof captured.bodyJson === 'string' && captured.bodyJson.includes(DATA_URL),
    String(captured.bodyJson).slice(0, 200),
  );
  ok('指纹路径：modelKey 仍是模型 id', captured.modelKey === 'dfmodel', String(captured.modelKey));
  ok(
    '指纹路径：编码器收到的是**归一化后**的 body（与手写路径同一份）',
    typeof captured.bodyJson === 'string' && !captured.bodyJson.includes('"content":null'),
  );
}

console.log(`\nqoder-payload: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
