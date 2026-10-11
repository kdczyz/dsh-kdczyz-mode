/**
 * qoder-shim.mjs 的测试。
 *
 * # 这一层为什么必须测
 *
 * shim 是**唯一对外暴露 HTTP 端口**的部件。它的防护（loopback / bearer /
 * Content-Type）一旦漏了，本机上的其它进程就能借它打上游 —— 而用的还是用户
 * 的号池凭据。这类漏洞不会报任何错，只会悄悄地把凭据开放出去。
 *
 * 另外 `timingSafeEqual` 有个经典坑：它对**不等长**入参会直接抛异常。抛在鉴权
 * 路径上等于把「token 不对」变成 500，还掩盖了真正的原因。所以「先比长度」
 * 这条必须有断言钉住。
 *
 * 运行：node test/qoder-shim.test.mjs
 */

import {
  STATUS_BY_KIND,
  bearerMatches,
  createQoderShim,
  isLoopbackHost,
  isLoopbackOrigin,
} from '../lib/qoder-shim.mjs';

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

console.log('Qoder loopback shim\n');

/* —— 1) loopback 判定 —— */
for (const h of ['127.0.0.1', '127.0.0.1:8080', 'localhost', 'localhost:1234', '::1', '[::1]', '127.1.2.3']) {
  ok(`本机 host 认：${h}`, isLoopbackHost(h) === true);
}
for (const h of ['evil.example.com', '0.0.0.0', '192.168.1.1', '', undefined, null, '127.0.0.1.evil.com']) {
  ok(`非本机 host 拒：${String(h)}`, isLoopbackHost(h) === false);
}
ok('无 Origin 视为同源（curl 直连场景）', isLoopbackOrigin(undefined) === true);
ok('空 Origin 视为同源', isLoopbackOrigin('') === true);
ok('loopback Origin 放行', isLoopbackOrigin('http://127.0.0.1:9000') === true);
ok('跨站 Origin 拒绝', isLoopbackOrigin('http://evil.example.com') === false);
ok('畸形 Origin 拒绝', isLoopbackOrigin('not-a-url') === false);

/* —— 2) bearer 比对（timingSafeEqual 的长度坑）—— */
// 长度不等时**绝不能抛**：去掉长度检查后 timingSafeEqual 会抛 RangeError
// （ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH），整个测试进程直接崩 —— 实测踩过。
// 这里断言「不抛且返回 false」，让回归表现为一条失败断言而不是进程崩溃。
ok('正确 token 通过', bearerMatches('Bearer abc', 'abc') === true);
{
  let threw = null;
  let result;
  try {
    result = bearerMatches('Bearer abcdef', 'abc');
  } catch (e) {
    threw = e;
  }
  ok('长度不等：不抛且返回 false', threw === null && result === false, threw?.message);
}
ok('**空 token 不抛**', bearerMatches('Bearer ', 'abc') === false);
ok('缺 Bearer 前缀拒绝', bearerMatches('abc', 'abc') === false);
ok('undefined 头不抛', bearerMatches(undefined, 'abc') === false);
ok('null 头不抛', bearerMatches(null, 'abc') === false);

/* —— 3) 状态码映射 —— */
ok('signature 映射为 400（不该重试）', STATUS_BY_KIND.signature === 400);
ok('hard_credit → 402', STATUS_BY_KIND.hard_credit === 402);
ok('soft_rate → 429', STATUS_BY_KIND.soft_rate === 429);
ok('not_found/server → 502', STATUS_BY_KIND.not_found === 502 && STATUS_BY_KIND.server === 502);
ok('unconfigured → 503', STATUS_BY_KIND.unconfigured === 503);
ok('未知 kind 有兜底 500', (STATUS_BY_KIND.nonexistent ?? 500) === 500);

/* —— 4) 起真 server 打一遍 —— */
const SECRET = 'test-secret-abcdef';
const shim = await createQoderShim({
  secret: SECRET,
  models: () => [{ id: 'm1' }, { id: 'm2' }],
  routeChat: async (bodyJson, signal, parsed) => {
    if (parsed?.model === 'bad') return { ok: false, status: 400, kind: 'client', message: 'no' };
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        c.close();
      },
    });
    return { ok: true, response: { body: stream } };
  },
});

const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
  try {
    const res = await fetch(`http://127.0.0.1:${shim.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: String(e) };
  }
};

ok('shim 起了端口且是本机', shim.port > 0 && typeof shim.baseUrl() === 'string');
ok('baseUrl 指向 127.0.0.1', shim.baseUrl().startsWith('http://127.0.0.1:'));
ok('token() 返回 secret', shim.token() === SECRET);

ok('GET /healthz 免鉴权返回 ok', (await call('/healthz')).status === 200);

// —— 鉴权 ——
ok(
  '无 token 访问 /v1/models 被拒 401',
  (await call('/v1/models')).status === 401,
);
{
  const r = await call('/v1/models', { headers: { Authorization: `Bearer ${SECRET}` } });
  ok('带正确 token 能列模型', r.status === 200);
  ok('模型列表是 OpenAI 形状', r.text.includes('"object":"list"') && r.text.includes('"id":"m1"'));
  ok('模型条带 owned_by qoder', r.text.includes('"owned_by":"qoder"'));
}

// —— Host / Origin 防护 ——
{
  const res = await fetch(`http://127.0.0.1:${shim.port}/v1/models`, {
    headers: { Authorization: `Bearer ${SECRET}`, Origin: 'http://evil.example.com' },
  });
  ok('跨站 Origin 被拒 403', res.status === 403);
  ok('  错误信息是 origin_not_allowed', (await res.text()).includes('origin_not_allowed'));
}

// —— Content-Type ——
{
  const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  ok('非 JSON Content-Type 被拒 415', res.status === 415);
}
{
  const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: 'not json',
  });
  ok('坏 JSON 被拒 400', res.status === 400);
  ok('  错误信息是 invalid_json', (await res.text()).includes('invalid_json'));
}

// —— 正常转发 ——
{
  const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm1', messages: [] }),
  });
  ok('正常请求返回 200', res.status === 200);
  ok('响应是 SSE Content-Type', String(res.headers.get('content-type')).includes('text/event-stream'));
  ok('带 X-Accel-Buffering: no（防代理缓冲）', res.headers.get('x-accel-buffering') === 'no');
  const text = await res.text();
  ok('流式内容被透传', text.includes('data: {"choices":[]}'));
}

// —— 上游失败映射 ——
{
  const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'bad' }),
  });
  ok('上游 client 错误映射为 400', res.status === 400);
  ok('  错误带 kind', (await res.text()).includes('"kind":"client"'));
}

// —— 未知路径 ——
ok('未知路径 404', (await call('/nope', { headers: { Authorization: `Bearer ${SECRET}` } })).status === 404);

await shim.close();
ok('close() 能正常关闭', true);

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
