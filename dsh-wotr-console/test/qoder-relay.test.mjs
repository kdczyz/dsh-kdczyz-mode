/**
 * qoder-relay.mjs 的测试。
 *
 * # 为什么签名必须能确定性测试
 *
 * COSY 签名错了，服务端只回一个 401 / `101 Signature invalid`。它**不会**告诉
 * 你「你的摘要串少了一个 `\n`」或「路径没去 `/algo` 前缀」—— 排查方向会完全
 * 跑偏（看起来像凭据失效，于是用户反复重登）。
 *
 * 所以这里把签名拆成可测的零件，逐条钉死：
 *   - 路径归一的三步顺序（取 pathname → 去查询串 → 去 `/algo`）；
 *   - 摘要串是**五段 `\n` 连接**，少一段就换一个结果；
 *   - `Cosy-Key` 是 RSA 包裹的会话密钥、能解回原文（证明不是凭据本身）；
 *   - `info` 是 AES-CBC 密文，里面含 `security_oauth_token` 明文。
 *
 * 会话密钥每次随机，所以**不比对完整 Authorization**，而是拆开验结构、并对
 * 固定输入验摘要可复现（固定 timestamp + 固定密钥时能重算）。
 *
 * 运行：node test/qoder-relay.test.mjs
 */

import crypto from 'node:crypto';

import {
  QODER_CN_CHAT_BASE,
  QODER_COSY_PUBLIC_KEY,
  QODER_SIGNED_CHAT_PATH,
  buildQoderChatRequest,
  buildQoderCosyHeaders,
  classifyQoderRelayFailure,
  isQoderDoneFrame,
  buildQoderModelsRequest,
  isQoderSigningReady,
  parseQoderModelList,
  qoderChatUrl,
  qoderIdentityOf,
  qoderRelayRetryable,
  applyQoderRelayFailure,
  qoderSigningPath,
  resolveSecurityToken,
  unwrapQoderFrame,
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

const identity = { uid: 'u-1', name: 'n', email: 'e@x.com', securityToken: 'dt-abc' };
const CHAT_URL = `${QODER_CN_CHAT_BASE}${QODER_SIGNED_CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

console.log('Qoder 反代请求模块\n');

/* —— 1) 常量 —— */
ok('推理主机是 gateway.qoder.com.cn', QODER_CN_CHAT_BASE === 'https://gateway.qoder.com.cn');
ok(
  '签名路径是 agent_chat_generation（不是国际版的 chat/completions）',
  QODER_SIGNED_CHAT_PATH === '/algo/api/v2/service/pro/sse/agent_chat_generation',
);
ok('公钥能被 Node 解析为 1024 位 RSA', (() => {
  const k = crypto.createPublicKey(QODER_COSY_PUBLIC_KEY);
  return k.asymmetricKeyType === 'rsa' && k.asymmetricKeyDetails.modulusLength === 1024;
})());

/* —— 2) 路径归一（错一步签名就挂）—— */
ok('去 /algo 前缀', qoderSigningPath('/algo/api/v2/service/pro/sse/agent_chat_generation') === '/api/v2/service/pro/sse/agent_chat_generation');
ok('先去查询串再去前缀', qoderSigningPath(CHAT_URL) === '/api/v2/service/pro/sse/agent_chat_generation');
ok('非 /algo 路径原样保留', qoderSigningPath('/api/v1/userinfo') === '/api/v1/userinfo');
ok('裸路径（非 URL）也能处理', qoderSigningPath('/algo/x?y=1') === '/x');
ok('空值不抛', qoderSigningPath(undefined) === '');

/* —— 3) 签名头结构 —— */
{
  const h = buildQoderCosyHeaders(identity, { url: CHAT_URL, body: '{"a":1}', timestamp: 1700000000 });
  ok('Authorization 是 Bearer COSY.<payload>.<md5>', /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/.test(h.Authorization));
  ok('Cosy-User 是 uid', h['Cosy-User'] === 'u-1');
  ok('Cosy-Date 是秒级时间戳字符串', h['Cosy-Date'] === '1700000000');
  ok('Cosy-Key 是 RSA-1024 密文（172 字符 base64 / 128 字节）', Buffer.from(h['Cosy-Key'], 'base64').length === 128);

  // payload 可解出版本与 cosyVersion
  const payload = JSON.parse(Buffer.from(h.Authorization.split('.')[1], 'base64').toString('utf8'));
  ok('payload 带 version v1', payload.version === 'v1');
  ok('payload 带 requestId', typeof payload.requestId === 'string' && payload.requestId.length === 32);
  ok('payload 带 info 与 cosyVersion', typeof payload.info === 'string' && typeof payload.cosyVersion === 'string');

  // Cosy-Key 解不开（私钥不在），但 info 能用「会话密钥」解 —— 这里反向验证：
  // 用同一个公钥重新加密一份，确认解密链路自洽
  const sess = Buffer.from(crypto.randomUUID().replaceAll('-', '').slice(0, 16), 'utf8');
  const c = crypto.createCipheriv('aes-128-cbc', sess, sess.subarray(0, 16));
  const enc = Buffer.concat([c.update(Buffer.from('{"uid":"x"}', 'utf8')), c.final()]);
  const d = crypto.createDecipheriv('aes-128-cbc', sess, sess.subarray(0, 16));
  const dec = Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  ok('AES-128-CBC（密钥=IV）可自洽加解密', dec === '{"uid":"x"}');
}

/* —— 4) 摘要串是五段 \n 连接（少一段结果就变）——
 *
 * ⚠️ **必须固定随机源**：payload 里有随机 `requestId`、`Cosy-Key` 是随机会话
 * 密钥，所以任意两次签名**本来就不相等**。不注入固定值的话，下面「改 X 会不会
 * 改签名」的断言永远为真 —— 实测踩过：把摘要里的 path 整段去掉，这三条断言
 * 依然全绿（假绿）。现在显式钉住 `aesKey` 与 `requestId`，断言才有意义。
 */
{
  const fixed = {
    url: CHAT_URL,
    body: 'B',
    timestamp: 1700000000,
    cosyVersion: '1.1.58',
    ideVersion: '1.0.0',
    aesKey: '0123456789abcdef',
    requestId: 'f'.repeat(32),
  };
  const sig = (o) => buildQoderCosyHeaders(identity, o).Authorization.split('.')[2];
  const base = sig(fixed);

  // ⚠️ **不做「固定输入 ⇒ 相同签名」的断言**：`Cosy-Key` 是 RSA-PKCS1 加密，
  // 而 PKCS1 填充**自带随机数**，故即使所有输入固定，Cosy-Key 也每次不同。
  // 这不是缺陷（会话密钥本就该随机），但意味着「两次签名不相等」永远成立 ——
  // 所以下面**不用差异断言**，改为用函数返回的真实组件**重算 md5** 验公式。
  // 这样即使 cosyKey 随机，公式错一处（少一段 / 分隔符不对）就会立刻暴露。
  const h = buildQoderCosyHeaders(identity, fixed);
  const [scheme, payloadB64, actualSig] = h.Authorization.split('.');
  const recomputed = crypto
    .createHash('md5')
    .update(
      `${payloadB64}\n${h['Cosy-Key']}\n${fixed.timestamp}\n${fixed.body}\n${qoderSigningPath(fixed.url)}`,
      'utf8',
    )
    .digest('hex');
  ok('Authorization 前缀是 COSY', scheme === 'Bearer COSY');
  ok(
    '摘要 = md5(payload\\nkey\\nts\\nbody\\npath) —— 与实际签名逐字符相同',
    recomputed === actualSig,
    `期望 ${recomputed} 实际 ${actualSig}`,
  );
  // 反证：去掉 path 后重算必须对不上（证明 path 真的在摘要里）
  const withoutPath = crypto
    .createHash('md5')
    .update(`${payloadB64}\n${h['Cosy-Key']}\n${fixed.timestamp}\n${fixed.body}`, 'utf8')
    .digest('hex');
  ok('去掉 path 后摘要对不上（证明 path 真在摘要里）', withoutPath !== actualSig);
  // uid / securityToken 在 identity 里（被 AES 加密进 info），同样受随机填充
  // 影响，故改为**直接验 info 明文**：用注入的 aesKey 解开 info，确认内容。
  const infoOf = (id, o = fixed) => {
    const p = JSON.parse(
      Buffer.from(buildQoderCosyHeaders(id, o).Authorization.split('.')[1], 'base64').toString('utf8'),
    );
    const key = Buffer.from(o.aesKey, 'utf8');
    const d = crypto.createDecipheriv('aes-128-cbc', key, key.subarray(0, 16));
    return JSON.parse(
      Buffer.concat([d.update(Buffer.from(p.info, 'base64')), d.final()]).toString('utf8'),
    );
  };
  const info = infoOf(identity);
  ok('info.uid 真的进了密文', info.uid === 'u-1');
  ok('info.security_oauth_token 真的进了密文（dt- 原样）', info.security_oauth_token === 'dt-abc');
  ok('换 uid 时 info 内容随之改变', infoOf({ ...identity, uid: 'u-2' }).uid === 'u-2');
  ok('换 securityToken 时 info 内容随之改变', infoOf({ ...identity, securityToken: 'dt-other' }).security_oauth_token === 'dt-other');
  ok('info.aid 是空串（官方固定）', info.aid === '');
  ok('cosyVersion 进 payload', JSON.parse(Buffer.from(buildQoderCosyHeaders(identity, { ...fixed, cosyVersion: '9.9.9' }).Authorization.split('.')[1], 'base64').toString('utf8')).cosyVersion === '9.9.9');
}

/* —— 5) 每次请求的会话密钥必须不同 —— */
{
  const a = buildQoderCosyHeaders(identity, { url: CHAT_URL, timestamp: 1700000000 });
  const b = buildQoderCosyHeaders(identity, { url: CHAT_URL, timestamp: 1700000000 });
  ok('会话密钥每次随机（Cosy-Key 不同）', a['Cosy-Key'] !== b['Cosy-Key']);
  ok('即使输入相同，Authorization 也不同', a.Authorization !== b.Authorization);
}

/* —— 6) 令牌族：dt- 原样可用（这条错了就是 401）—— */
ok('dt- 原样作为 security_oauth_token', resolveSecurityToken({ accessToken: 'dt-xyz' }) === 'dt-xyz');
ok('access_token（下划线）也认', resolveSecurityToken({ access_token: 'dt-xyz' }) === 'dt-xyz');
ok('有 jt- 时优先用 jt-', resolveSecurityToken({ accessToken: 'dt-xyz', jobToken: 'jt-real' }) === 'jt-real');
ok('空 accessToken 返回 undefined', resolveSecurityToken({ accessToken: '' }) === undefined);
ok('无凭据不抛', resolveSecurityToken(undefined) === undefined);
ok('uid 缺失则签名未就绪', isQoderSigningReady({ accessToken: 'dt-x' }) === false);
ok('uid + dt- 则签名就绪', isQoderSigningReady({ accessToken: 'dt-x', userId: 'u1' }) === true);
ok('uid 用 uid 字段也算', isQoderSigningReady({ accessToken: 'dt-x', uid: 'u1' }) === true);

/* —— 7) 请求构造 —— */
{
  const url = qoderChatUrl();
  ok('URL 带官方查询参数', url.includes('FetchKeys=llm_model_result') && url.includes('AgentId=agent_common'));
  // 2026-10-11 真机：带 Encode=1 时服务端会去解自定义 Base64（明文 body 触发
  // Java 异常）；不带就按明文处理。所以**必须不带**，这是能对话的前提。
  ok('URL 不带 Encode（带则服务端按自定义 Base64 解 body）', !url.includes('Encode'));
  ok('URL 用签名路径', url.includes(QODER_SIGNED_CHAT_PATH));

  const req = buildQoderChatRequest({ identity, payload: { model: 'm' } });
  ok('请求带 Authorization', typeof req.headers.Authorization === 'string');
  ok('请求带 UA', typeof req.headers['User-Agent'] === 'string');
  ok('默认 body 是 JSON.stringify', req.body === '{"model":"m"}');
  ok('请求带 Content-Length（缺了签名对不上）', req.headers['Content-Length'] === Buffer.byteLength(req.body));
  ok('encodeBody 可注入', buildQoderChatRequest({ identity, payload: { m: 1 }, encodeBody: (p) => `ENC(${JSON.stringify(p)})` }).body === 'ENC({"m":1})');
}

/* —— 8) SSE 信封解包 —— */
{
  const env = { headers: { 'Content-Type': ['application/json'] }, body: '{"choices":[]}', statusCodeValue: 200, statusCode: 'OK' };
  const r1 = unwrapQoderFrame(env);
  ok('信封帧被识别为 inner', r1.kind === 'inner' && r1.inner === '{"choices":[]}');

  const done = { body: '[DONE]', statusCodeValue: 200 };
  ok('[DONE] 在信封里', isQoderDoneFrame(unwrapQoderFrame(done).inner));

  // 国际版裸帧：有 body 但 statusCodeValue 不是数字 → 不能误判
  const bare = { choices: [{ delta: { content: 'hi' } }], body: 'some-business-field' };
  ok('只有 body 不算信封（防误伤国际版裸帧）', unwrapQoderFrame(bare).kind === 'raw');
  ok('标准 OpenAI 帧不被误判', unwrapQoderFrame({ choices: [] }).kind === 'raw');
  ok('非对象不抛', unwrapQoderFrame(null).kind === 'raw');
  ok('数组不抛', unwrapQoderFrame([1, 2]).kind === 'raw');
  ok('statusCodeValue 非数字不算信封', unwrapQoderFrame({ body: 'x', statusCodeValue: '200' }).kind === 'raw');
}

/* —— 9) 失败分类 —— */
ok('402 → hard_credit', classifyQoderRelayFailure({ status: 402 }).kind === 'hard_credit');
ok('429 → soft_rate', classifyQoderRelayFailure({ status: 429 }).kind === 'soft_rate');
ok('404 → not_found', classifyQoderRelayFailure({ status: 404 }).kind === 'not_found');
ok('500 → server', classifyQoderRelayFailure({ status: 500 }).kind === 'server');
ok('Signature invalid → signature', classifyQoderRelayFailure({ status: 400, body: '{"code":"101","message":"Signature invalid"}' }).kind === 'signature');
ok('401 → signature（签名路径下 401 说明签名本身有问题）', classifyQoderRelayFailure({ status: 401 }).kind === 'signature');
ok('TOKEN_INVALID → session_dead', classifyQoderRelayFailure({ body: '{"code":"TOKEN_INVALID"}' }).kind === 'session_dead');
ok('余额耗尽文案 → hard_credit', classifyQoderRelayFailure({ body: 'insufficient quota' }).kind === 'hard_credit');
ok('限流文案 → soft_rate', classifyQoderRelayFailure({ body: 'rate limit exceeded' }).kind === 'soft_rate');
ok('400 普通 → client', classifyQoderRelayFailure({ status: 400, body: 'bad' }).kind === 'client');
ok('无输入不抛', classifyQoderRelayFailure().kind === 'client');

/* —— 10) 哪些值得换号重试 —— */
ok('hard_credit 可重试', qoderRelayRetryable('hard_credit') === true);
ok('soft_rate 可重试', qoderRelayRetryable('soft_rate') === true);
ok('session_dead 可重试', qoderRelayRetryable('session_dead') === true);
ok('signature 不重试（换号也签不过）', qoderRelayRetryable('signature') === false);
ok('client 不重试（协议错误）', qoderRelayRetryable('client') === false);
ok('not_found 不重试', qoderRelayRetryable('not_found') === false);

/* —— 11) 失败回灌号池 —— */
{
  /** 记录调用的假号池 */
  const fakePool = () => {
    const calls = [];
    return {
      calls,
      penalizeExhausted(id) { calls.push(['penalizeExhausted', id]); },
      penalize(id, resetAtMs, modelId) { calls.push(['penalize', id, resetAtMs, modelId]); },
    };
  };

  let p = fakePool();
  ok('hard_credit → penalizeExhausted（整账号）', applyQoderRelayFailure(p, 'a1', { kind: 'hard_credit' }) === 'penalizeExhausted');
  ok('  → 真的调了 penalizeExhausted', p.calls[0][0] === 'penalizeExhausted' && p.calls[0][1] === 'a1');

  p = fakePool();
  applyQoderRelayFailure(p, 'a1', { kind: 'soft_rate', modelId: 'm1', resetAtMs: 123 });
  ok('soft_rate → penalize 且带上 modelId（按模型冷却）', p.calls[0][0] === 'penalize' && p.calls[0][3] === 'm1');
  ok('  → resetAtMs 透传（上游给的比本地估算准）', p.calls[0][2] === 123);

  p = fakePool();
  ok('signature 不惩罚账号', applyQoderRelayFailure(p, 'a1', { kind: 'signature' }) === 'noop');
  ok('  → 池没被调用', p.calls.length === 0);
  applyQoderRelayFailure(p, 'a1', { kind: 'client' });
  applyQoderRelayFailure(p, 'a1', { kind: 'session_dead' });
  applyQoderRelayFailure(p, 'a1', { kind: 'not_found' });
  ok('client / session_dead / not_found 都不惩罚', p.calls.length === 0);

  ok('无池不抛（返回 noop）', applyQoderRelayFailure(undefined, 'a1', { kind: 'hard_credit' }) === 'noop');
  ok('池缺方法不抛', applyQoderRelayFailure({}, 'a1', { kind: 'hard_credit' }) === 'noop');
}

/* —— 12) 签名身份（从号池凭据构造）—— */
{
  const cred = { accessToken: 'dt-xyz', userId: 'u-1', userName: 'alice' };
  const id = qoderIdentityOf(cred);
  ok('从凭据构造出签名身份', id !== undefined && id.uid === 'u-1');
  ok('身份带 securityToken（dt- 原样）', id.securityToken === 'dt-xyz');
  ok('身份带 name', id.name === 'alice');
  ok('缺 uid 的凭据不给身份（空 uid 必回 101）', qoderIdentityOf({ accessToken: 'dt-x' }) === undefined);
  ok('无凭据不抛', qoderIdentityOf(undefined) === undefined);
}

/* —— 13) 模型目录（dt- 走签名链）—— */
{
  const id = qoderIdentityOf({ accessToken: 'dt-xyz', userId: 'u-1' });
  const req = buildQoderModelsRequest({ identity: id });
  ok('目录 URL 是签名的 /algo/api/v2/model/list', req.url.includes('/algo/api/v2/model/list'));
  ok('目录 URL 不带 Encode', !req.url.includes('Encode'));
  ok('目录走 GET（POST 回 400 method not supported）', req.method === 'GET');
  // 2026-10-11 真机：GET 发 body 时 Node 默认走 chunked 不加 Content-Length，
  // 服务端读到空 body → 签名对不上 → 403 / 101 Signature invalid。必须显式带。
  ok('目录请求带 Content-Length（缺了服务端读不到 {} body）', req.headers['Content-Length'] === 2);
  ok('目录 GET 也带 body（否则官方回 403）', req.body === '{}');
  ok('目录请求带 Authorization', typeof req.headers.Authorization === 'string');
  // 关键：签名必须是用同一个 '{}' body 算的（漏了就是 403 且看不出原因）
  const payloadB64 = req.headers.Authorization.split('.')[1];
  const expected = crypto
    .createHash('md5')
    .update(
      `${payloadB64}\n${req.headers['Cosy-Key']}\n${req.headers['Cosy-Date']}\n{}\n${qoderSigningPath(req.url)}`,
      'utf8',
    )
    .digest('hex');
  ok('签名是用同一个 {} body 算的（防 403）', req.headers.Authorization.split('.')[2] === expected);
}

/* —— 14) 目录解析（上游形状不保证，多处兼容）—— */
{
  ok('models 数组', parseQoderModelList({ models: [{ id: 'a' }, { id: 'b' }] }).length === 2);
  ok('model_list 也认', parseQoderModelList({ model_list: [{ id: 'a' }] }).length === 1);
  ok('config_info_list 用 config_name 作 id', parseQoderModelList({ config_info_list: [{ config_name: 'a' }] })[0].id === 'a');
  ok('data.models 嵌套也认', parseQoderModelList({ data: { models: [{ id: 'a' }] } }).length === 1);
  ok('裸数组也认', parseQoderModelList([{ id: 'a' }]).length === 1);
  ok('JSON 字符串也认', parseQoderModelList('{"models":[{"id":"a"}]}').length === 1);
  ok('去重（同 id 只留一个）', parseQoderModelList({ models: [{ id: 'a' }, { id: 'a' }] }).length === 1);
  ok('缺 id 的条目跳过', parseQoderModelList({ models: [{ name: 'x' }, { id: 'a' }] }).length === 1);
  ok('带 name 时保留', parseQoderModelList({ models: [{ id: 'a', name: 'Qwen' }] })[0].name === 'Qwen');
  ok('非对象条目跳过', parseQoderModelList({ models: ['a', 1, null] }).length === 0);
  ok('坏 JSON 不抛且返回空', parseQoderModelList('not json').length === 0);
  ok('无候选容器返回空', parseQoderModelList({ foo: 1 }).length === 0);
  ok('null 不抛', parseQoderModelList(null).length === 0);
  ok('空对象不抛', parseQoderModelList({}).length === 0);

  /* —— 真机形状（2026-10-11 实测）—— */
  // 顶层是按用途分组的对象，对话模型在 `chat` 里；模型 id 是 `key` 而**不是**
  // `display_name`。这两条错了就表现为「列出一堆选不了/发出去 404 的模型」。
  const live = {
    chat: [
      { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_vl: true, is_reasoning: true, max_input_tokens: 180000, enable: true, format: 'openai' },
      { key: 'gfmodel', display_name: 'GLM-5.3-Flash', max_input_tokens: 1000000, enable: true },
      { key: 'disabled_one', display_name: 'Disabled', enable: false },
    ],
    developer: [{ key: 'dev_only', display_name: 'Dev' }],
  };
  const liveModels = parseQoderModelList(live);
  ok('真机形状：取 chat 组的模型', liveModels.length === 2, JSON.stringify(liveModels.map((m) => m.id)));
  ok('真机形状：id 用 key 而不是 display_name', liveModels[0].id === 'qmodel_38max', liveModels[0].id);
  ok('真机形状：display_name 存成 name', liveModels[0].name === 'Qwen3.8-Max', liveModels[0].name);
  ok('真机形状：max_input_tokens 落到 contextWindow', liveModels[0].contextWindow === 180000, String(liveModels[0].contextWindow));
  ok('真机形状：各模型窗口不拉平（1M 那个保留 1M）', liveModels[1].contextWindow === 1000000, String(liveModels[1].contextWindow));
  ok('真机形状：enable:false 的条目跳过', !liveModels.some((m) => m.id === 'disabled_one'));
  ok('真机形状：不混入 developer 组', !liveModels.some((m) => m.id === 'dev_only'));
  ok('真机形状：chat 缺失时才退到别的组', parseQoderModelList({ developer: [{ key: 'd1' }] })[0].id === 'd1');
  // 空数组的组不应被当成「有效容器」而盖过后面有内容的组
  ok('真机形状：空 chat 组不遮蔽后面的组', parseQoderModelList({ chat: [], models: [{ id: 'm1' }] })[0].id === 'm1');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
