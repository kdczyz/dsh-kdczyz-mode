/**
 * WorkBuddy 出站指纹（身份头 + UA）的测试。
 *
 * # 为什么这些头值得单独钉
 *
 * 官方 `runIdentityHeaders()` 有一处**很容易做错的形状**：`X-Userinfo` 只在
 * 它真的携带信息时才发（守卫是 `uid && (enterpriseId || idSource || method)`）。
 * 个人账号只有 uid 时，官方**不发** `X-Userinfo` —— 如果插件无条件发一个
 * `{"uin":…}`，那本身就是一处官方客户端产生不出来的形态。
 *
 * 同理 `X-Auth-Method` / `X-Id-Source` 是**进程运行时值**，不在落盘凭据里；
 * 官方只在运行身份确实有它们时才发。凭据里没有就必须留空，不能编。
 *
 * UA 也钉住：官方推理路径的 UA 由 `buildUserAgent()` 拼，
 * `delete I["user-agent"]`（@3449514）专门为它清位。旧版写死的
 * `WorkBuddy/5.5.6 … CLI/2.137.1` 与官方当前值（5.7.7 / 2.156.0）不一致。
 *
 * 运行：node test/wb-fingerprint.test.mjs
 */

import { chatHeaders, conversationHeaders } from '../vendor/xdpool/lib/index.js';

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

console.log('WorkBuddy 出站指纹\n');

const base = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  uid: 'uid-1',
  uin: 'uin-1',
  domain: 'www.workbuddy.cn',
};

/* —— 1) UA —— */
{
  const headers = chatHeaders(base);
  const ua = headers['User-Agent'];
  ok('UA 含桌面版本 5.7.7', /WorkBuddy\/5\.7\.7/.test(ua), ua);
  ok('UA 含 CLI 版本 2.156.0', /CLI\/2\.156\.0/.test(ua), ua);
  ok('UA 不再是旧版写死的 5.5.6 / 2.137.1', !/5\.5\.6|2\.137\.1/.test(ua), ua);
  ok('UA 形态是 platform product extension 三段', ua === 'WorkBuddy/5.7.7 WorkBuddy/5.7.7 CLI/2.156.0', ua);
}

/* —— 2) 凭据里没有的运行时字段必须不发 —— */
{
  const headers = chatHeaders(base);
  ok('没有 authMethod 就不发 X-Auth-Method', headers['X-Auth-Method'] === undefined);
  ok('没有 idSource 就不发 X-Id-Source', headers['X-Id-Source'] === undefined);
}

/* —— 3) X-Userinfo 的守卫 —— */
{
  // 个人账号：只有 uid，没有 enterprise/idSource/method → 官方不发 X-Userinfo
  const personal = chatHeaders({ ...base, enterpriseId: '' });
  ok('只有 uid 时不发 X-Userinfo（官方守卫要求额外字段）', personal['X-Userinfo'] === undefined);
  ok('只有 uid 时也不发 X-Enterprise-Id', personal['X-Enterprise-Id'] === undefined);
  ok('uid 存在则发 X-User-Id', personal['X-User-Id'] === 'uid-1');
}

{
  // 企业账号：uid + enterpriseId → 发，且 uin 用 uid、owner_uin 用 enterprise
  const ent = chatHeaders({ ...base, enterpriseId: 'ent-9' });
  ok('有 enterpriseId 时发 X-Userinfo', typeof ent['X-Userinfo'] === 'string');
  const decoded = JSON.parse(Buffer.from(ent['X-Userinfo'], 'base64').toString('utf8'));
  ok('X-Userinfo.uin = uid', decoded.uin === 'uid-1');
  ok('X-Userinfo.owner_uin = enterpriseId', decoded.owner_uin === 'ent-9');
  ok('没给 idSource 时 X-Userinfo 里没有 id_source', decoded.id_source === undefined);
  ok('没给 authMethod 时 X-Userinfo 里没有 token_source', decoded.token_source === undefined);
  ok('X-Enterprise-Id 与 X-Tenant-Id 都跟 enterpriseId 一致', ent['X-Enterprise-Id'] === 'ent-9' && ent['X-Tenant-Id'] === 'ent-9');
}

/* —— 4) 运行时字段确实会进头与信封 —— */
{
  const full = chatHeaders(base, { authMethod: 'external-link', idSource: 'wechat' });
  ok('给了 authMethod 就发 X-Auth-Method', full['X-Auth-Method'] === 'external-link');
  ok('给了 idSource 就发 X-Id-Source', full['X-Id-Source'] === 'wechat');
  const decoded = JSON.parse(Buffer.from(full['X-Userinfo'], 'base64').toString('utf8'));
  ok('X-Userinfo 带上 id_source', decoded.id_source === 'wechat');
  ok('X-Userinfo 带上 token_source', decoded.token_source === 'external-link');
}

/* —— 5) chat 路径不得出现 X-No-* —— */
{
  // 那两个 negative 只用于登录态接口（@6447780），chat 上发它们是官方产不出的形态
  const headers = chatHeaders(base);
  const negatives = Object.keys(headers).filter((k) => k.startsWith('X-No-'));
  ok('chat 路径不发任何 X-No-* 头', negatives.length === 0, negatives.join(','));
}

/* —— 6) 其余固定头 —— */
{
  const headers = chatHeaders({ ...base, domain: '' });
  ok('domain 为空时不发 X-Domain', headers['X-Domain'] === undefined);
  ok('X-Product 恒为 SaaS', headers['X-Product'] === 'SaaS');
  ok('Authorization 是 Bearer', headers.Authorization === 'Bearer at-1');
  ok('Content-Type 是 JSON', headers['Content-Type'] === 'application/json');
  const withDomain = chatHeaders(base);
  ok('domain 非空时发 X-Domain', withDomain['X-Domain'] === 'www.workbuddy.cn');
}

/* —— 7) 官方那六个会话头（每次 chat 都发）—— */
{
  const ids = { conversationId: 'conv-1', messageId: 'msg-1', conversationRequestId: 'creq-1' };
  const h = conversationHeaders(ids);

  ok('发 X-Conversation-ID', h['X-Conversation-ID'] === 'conv-1');
  ok('X-Request-ID 与 X-Conversation-Message-ID 同值（官方就是同一个 messageId）', h['X-Request-ID'] === 'msg-1' && h['X-Conversation-Message-ID'] === 'msg-1');
  ok('X-Agent-Type 默认 main（官方 resolveAgentType 的 else 分支）', h['X-Agent-Type'] === 'main');
  ok('X-Conversation-Request-ID 即使是空串也发（官方是 F || ""）', conversationHeaders({}).hasOwnProperty('X-Conversation-Request-ID'));

  // 官方只在 meta 里有时才发 root / parent（`Q && ...`、`Z && ...`）
  const bare = conversationHeaders({ conversationId: 'c', messageId: 'm' });
  ok('没有 rootRequestId 时不发 X-Root-Request-ID', bare['X-Root-Request-ID'] === undefined);
  ok('没有 parentConversationId 时不发 X-Parent-Conversation-ID', bare['X-Parent-Conversation-ID'] === undefined);
  const nested = conversationHeaders({ conversationId: 'c', messageId: 'm', rootRequestId: 'root-1', parentConversationId: 'par-1', agentType: 'subagent' });
  ok('给了 rootRequestId 才发 X-Root-Request-ID', nested['X-Root-Request-ID'] === 'root-1');
  ok('给了 parentConversationId 才发 X-Parent-Conversation-ID', nested['X-Parent-Conversation-ID'] === 'par-1');
  ok('agentType 可覆盖（subagent / team）', nested['X-Agent-Type'] === 'subagent');

  // 不传任何 id 时必须自己生成，且 messageId 形态是「uuid 去横线」（官方 `(0,fD.nH)().replace(/-/g,"")`）
  const auto = conversationHeaders();
  ok('自动生成的 conversationId 是非空串', typeof auto['X-Conversation-ID'] === 'string' && auto['X-Conversation-ID'].length > 0);
  ok('自动生成的 messageId 是 32 位十六进制（uuid 去横线）', /^[0-9a-f]{32}$/.test(auto['X-Request-ID']), auto['X-Request-ID']);
  ok('自动生成时 X-Request-ID 仍与 Message-ID 同值', auto['X-Request-ID'] === auto['X-Conversation-Message-ID']);

  // 两次调用不应撞 id
  ok('两次自动生成不撞 messageId', conversationHeaders()['X-Request-ID'] !== conversationHeaders()['X-Request-ID']);
}

console.log(`\nwb-fingerprint: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
