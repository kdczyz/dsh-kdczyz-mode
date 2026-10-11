/**
 * `/qoder/checkin` 路由级测试：把「按账号签到、不切号」这条约束钉死。
 *
 * # 为什么值得单开一条路由级测试
 *
 * 这个功能的**全部价值**就在一句话里：给某个账号签到，但**不切换** Qoder 正在
 * 使用的账号。这句话有两个可能悄悄失效的位置，而它们都不是解析层能测出来的：
 *
 *   1. **路由顺手切了号**（比如为了拿凭据而 `pool.selectAccount(id)`）：签到按钮
 *      于是变成"先切过去再签"，用户正在用的账号被打到别处 —— 而这只是领 100
 *      Credits。用夹具渲染的测试永远发现不了：那需要真的池、真的请求路径。
 *   2. **两条链的头互相污染**：签到链要 `Cosy-ClientType: 10`、额度链要 `5`。
 *      用错了服务端**不报错**，只是回一份"今天没有活动"的空列表（实测），
 *      于是功能静默失效、日志里一行错都没有。
 *
 * 所以这里不用夹具渲染：真的写两个凭据文件、真的起 provider、真的挂路由、
 * 真的发一次 POST，然后同时断言**答复**与**池的当前账号没动**。
 *
 * 运行：node test/qoder-checkin-route.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wotr-qoder-checkin-'));
process.env.DSH_HOME = DSH_HOME;

const { saveQoderCredential } = await import('../lib/qoder-auth.mjs');
const { apply: applyQoder, currentQoderApi } = await import('../lib/qoder.js');
const { mountConsoleRoutes, qoderPool } = await import('../lib/index.js');

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
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);

console.log('Qoder 签到路由（按账号、不切号）\n');

/* —— 造两个账号：池的「当前账号」会是第一个，签到要签第二个 —— */
const ids = [];
for (const who of [
  { userId: 'checkin-user-a', userName: 'checkin-a@example.com' },
  { userId: 'checkin-user-b', userName: 'checkin-b@example.com' },
]) {
  const saved = await saveQoderCredential({
    dshHome: DSH_HOME,
    accessToken: `token-${who.userId}`,
    refreshToken: `refresh-${who.userId}`,
    userId: who.userId,
    userName: who.userName,
    expiresAtMs: Date.now() + 3_600_000,
  });
  if (saved?.error !== undefined) {
    console.log(`  ✗ 写入测试凭据失败 — ${saved.error}`);
    process.exit(1);
  }
  ids.push(saved.accountId);
}
const FIRST = ids[0];
const SECOND = ids[1];

/* —— 起 provider（假 ctx：只要 apply 用到的那几个面）—— */
const handlers = new Map();
const qoderCtx = {
  fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
  logger: { error: () => {}, warn: () => {}, info: () => {} },
  llm: {
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
  },
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : undefined;
  },
  on: (event, fn) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  },
};
const before = currentQoderApi();
applyQoder(qoderCtx, {
  selectedAccountId: { get: () => '' },
  disabledAccountIds: { get: () => [] },
  creditReserves: { get: () => ({}) },
});
{
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && currentQoderApi() === before) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
ok('provider 已发布句柄', currentQoderApi() !== before && currentQoderApi() !== undefined);
const pool = currentQoderApi().pool;
ok('管理页 qoderPool() 就是 provider 这个池（同一个对象）', qoderPool() === pool);
ok('池的「当前账号」是第一个（签到要签的却是第二个）', pool.effectiveSelectedAccountId() === FIRST);

/* —— 挂管理页路由 —— */
const routes = new Map();
const webServer = {
  register(spec) {
    routes.set(spec.path, spec.handler);
    return () => routes.delete(spec.path);
  },
};
const consoleCtx = {
  logger: { error: () => {}, warn: () => {}, info: () => {} },
  inject: (names, callback) => {
    callback({ webServer });
  },
};
mountConsoleRoutes(consoleCtx, {});

const CHECKIN_PATH = '/plugins/dsh-wotr-console/qoder/checkin';
const handler = routes.get(CHECKIN_PATH);
ok('挂上了 /qoder/checkin', typeof handler === 'function', [...routes.keys()].join(', '));

/* —— 上游桩：按 URL 分派，并记下每次请求的头 —— */
const realFetch = globalThis.fetch;

const CAMPAIGNS_BODY = {
  uid: 'checkin-user-b',
  showCampaign: true,
  claimable: false,
  campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a12102-1a77-7699-860d-136e42ef52d1',
      campaignKey: 'act-20261009-747',
      actionType: 'CLAIM_BENEFIT',
      startAt: 1791684000,
      endAt: 1791770340,
      claimStatus: 'CLAIMED',
      benefit: {
        kind: 'CREDITS',
        amount: 100,
        modelScope: { modelSeries: { key: 'ALL_MODELS' } },
        validity: { mode: 'RELATIVE_DAYS', days: 30 },
      },
      placements: [
        {
          type: 'POPUP',
          campaignUrl: 'https://openapi.qoder.sh/growth-page/activity-iframe',
          content: {
            zh: {
              title: '每天领 100 Credits',
              description: '每日 10:00（UTC+8）刷新，领取后 30 天有效',
              detailUrl: 'https://docs.qoder.cn/events/100credits',
            },
          },
        },
      ],
    },
  ],
};
const CLAIM_REPLAYED_BODY = {
  grantId: '01a128b7-c7dc-761c-83ea-b5c0068a0de6',
  status: 'CLAIMED',
  replayed: true,
  benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
  campaignId: '01a12102-1a77-7699-860d-136e42ef52d1',
  campaignKey: 'act-20261009-747',
  claimedAt: '2026-10-11T02:08:15.243893Z',
  expiresAt: '2026-11-10T02:08:15.243893Z',
};
/** 额度链的响应（真机三个池：主池 0、加量包 577）。 */
const QUOTA_BODY = {
  userId: 'checkin-user-b',
  usageType: 'credits',
  isQuotaExceeded: false,
  expiresAt: 253402214400000,
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
  addOnQuota: { total: 1100, used: 523, remaining: 577, percentage: 47.5, unit: 'credits' },
};

let script = () => ({ status: 200, body: CAMPAIGNS_BODY });
let calls = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  calls.push({ url: target, init: init ?? {} });
  const { status, body, text } = script(target, init ?? {});
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (text === undefined ? JSON.stringify(body) : text),
  };
};

/** 发一次真 POST（handler 用 `for await` 读 body，所以 req 得是异步可迭代）。 */
const post = async (body, { method = 'POST', origin = 'http://127.0.0.1:19387', raw } = {}) => {
  let status;
  let text = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      text += chunk ?? '';
    },
  };
  const req = {
    method,
    url: CHECKIN_PATH,
    headers: origin === null ? {} : { origin },
    async *[Symbol.asyncIterator]() {
      const payload = raw !== undefined ? raw : JSON.stringify(body ?? {});
      if (payload !== '') yield Buffer.from(payload);
    },
  };
  await handler(req, res);
  return { status, body: text === '' ? null : JSON.parse(text) };
};

/* —— 1) 给第二个账号签到：答复正确，且**池的当前账号没动** —— */
{
  calls = [];
  script = (target) =>
    target.includes('/api/v2/quota/usage')
      ? { status: 200, body: QUOTA_BODY }
      : { status: 200, body: CAMPAIGNS_BODY };

  const { status, body } = await post({ accountId: SECOND });
  eq('HTTP 200', status, 200);
  eq('ok 为真（"今天已领过"不是失败）', body.ok, true);
  eq('答复指向的是被点的那个账号', body.accountId, SECOND);
  eq('今天已领过 → alreadyCheckedIn', body.alreadyCheckedIn, true);
  eq('今天已领过 → claimed 为假（不许谎报 +100）', body.claimed, false);
  eq('带出数量（界面显示"已领 +100"）', body.amount, 100);
  eq('带出有效期', body.validDays, 30);
  eq('带出中文标题（来自活动 placement）', body.title, '每天领 100 Credits');
  eq('带出真实刷新节奏', body.description, '每日 10:00（UTC+8）刷新，领取后 30 天有效');
  eq('带出活动 key', body.campaignKey, 'act-20261009-747');
  eq('带出 token 类型说明不需要的字段为空串', body.code, '');
  eq('顺带读到余额（三池合计）', body.credits?.total, 577);

  /* 核心断言：签到没有把「当前使用」换掉 */
  eq('池的当前账号没动', pool.effectiveSelectedAccountId(), FIRST);
  eq('也没有写「显式选中」（签到不该改设置）', pool.selectedAccountId() ?? null, null);
  const acquired = await pool.acquire();
  eq('请求路径仍然用原来那个账号', acquired?.id, FIRST);

  /* 缺口令用的是**第二个账号**的令牌 */
  const campaignCall = calls.find((c) => c.url.includes('/sash/api/v1/me/campaigns') && !c.url.endsWith('/claim'));
  eq('活动列表用的第二个账号的令牌', campaignCall?.init.headers?.Authorization, 'Bearer token-checkin-user-b');
  eq('签到链带 Cosy-ClientType: 10', campaignCall?.init.headers?.['Cosy-ClientType'], '10');
  eq('签到链的 UA 是 "Qoder"', campaignCall?.init.headers?.['User-Agent'], 'Qoder');
  ok('签到链不发 Cosy-Version（官方活动链裸头里没有）', campaignCall?.init.headers?.['Cosy-Version'] === undefined);

  /* 已领 → 不该再打一次领取 */
  ok('已领时没有发领取请求', !calls.some((c) => c.url.endsWith('/claim')), calls.map((c) => c.url).join(' | '));

  /* 额度链必须是 5，不能被签到链的 10 污染 */
  const quotaCall = calls.find((c) => c.url.includes('/api/v2/quota/usage'));
  eq('额度链仍然是 Cosy-ClientType: 5', quotaCall?.init.headers?.['Cosy-ClientType'], '5');

  /* 余额写回了池（卡片上的余额行会立刻是新的） */
  eq('余额记回了号池', pool.creditsOf(SECOND), 577);
  ok('同时推进了「读到的时刻」', pool.creditsAt(SECOND) > 0);
}

/* —— 2) 今天可领：走完整的「列表 → 领取 → 额度」三步 —— */
{
  calls = [];
  script = (target) =>
    target.includes('/api/v2/quota/usage')
      ? { status: 200, body: QUOTA_BODY }
      : target.endsWith('/claim')
        ? {
            status: 200,
            body: {
              ...CLAIM_REPLAYED_BODY,
              replayed: false,
              claimedAt: '2026-10-12T02:00:01.000000Z',
            },
          }
        : {
            status: 200,
            body: {
              ...CAMPAIGNS_BODY,
              claimable: true,
              campaigns: [{ ...CAMPAIGNS_BODY.campaigns[0], claimStatus: 'CLAIMABLE' }],
            },
          };

  const { status, body } = await post({ accountId: SECOND });
  eq('HTTP 200', status, 200);
  eq('claimed 为真（这一下真领到了）', body.claimed, true);
  eq('claimed 时不再说自己"已领过"', body.alreadyCheckedIn, false);
  eq('带出领到的数量', body.amount, 100);
  eq('签完状态是 CLAIMED', body.claimStatus, 'CLAIMED');
  const claimCall = calls.find((c) => c.url.endsWith('/claim'));
  ok('发了领取请求', claimCall !== undefined);
  eq('领取用 POST', claimCall?.init.method, 'POST');
  eq('领取体是空串', claimCall?.init.body, '');
  eq(
    '领取端点带 campaignId',
    claimCall?.url,
    'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/01a12102-1a77-7699-860d-136e42ef52d1/claim',
  );
  eq('领取也带 Cosy-ClientType: 10', claimCall?.init.headers?.['Cosy-ClientType'], '10');
  eq('领取完仍然没换当前账号', pool.effectiveSelectedAccountId(), FIRST);
}

/* —— 3) 不给 accountId = 签「当前使用」那一个 —— */
{
  calls = [];
  script = (target) =>
    target.includes('/api/v2/quota/usage')
      ? { status: 200, body: QUOTA_BODY }
      : { status: 200, body: CAMPAIGNS_BODY };
  const { body } = await post({});
  eq('默认签的是当前账号', body.accountId, FIRST);
  const campaignCall = calls.find((c) => c.url.includes('/sash/api/v1/me/campaigns'));
  eq('用的是当前账号的令牌', campaignCall?.init.headers?.Authorization, 'Bearer token-checkin-user-a');
}

/* —— 4) 失败路径与门禁 —— */
{
  calls = [];
  script = () => ({ status: 401, body: { errorCode: 'Unauthorized' } });
  const expired = await post({ accountId: SECOND });
  eq('上游 401 时 HTTP 仍是 200（业务性失败，页面上就地说明）', expired.status, 200);
  eq('401 → ok:false', expired.body.ok, false);
  eq('401 → code=unauthorized', expired.body.code, 'unauthorized');
  ok('401 的提示让人重新登录该账号', String(expired.body.message).includes('重新登录'), expired.body.message);
  eq('401 时不读余额（失败就没有余额可谈）', expired.body.credits, null);

  calls = [];
  script = () => ({ status: 200, body: { showCampaign: false, claimable: false, campaignUrl: '', campaigns: [] } });
  const none = await post({ accountId: SECOND });
  eq('上游没下发活动 → code=no-campaign', none.body.code, 'no-campaign');
  ok('提示里说清刷新节奏', String(none.body.message).includes('10:00'), none.body.message);

  const unknown = await post({ accountId: 'no-such-account' });
  eq('未知账号 → 404', unknown.status, 404);

  const wrongMethod = await post({ accountId: SECOND }, { method: 'GET' });
  eq('GET → 405', wrongMethod.status, 405);

  const foreign = await post({ accountId: SECOND }, { origin: 'https://evil.example.com' });
  eq('非本机 Origin → 403', foreign.status, 403);

  const badJson = await post(null, { raw: '{not json' });
  eq('坏 JSON body → 400', badJson.status, 400);
}

globalThis.fetch = realFetch;
console.log(`\nqoder-checkin-route: ${pass} 通过, ${fail} 失败`);

/** `apply()` 起了 loopback shim（HTTP server 句柄），不显式退出进程会挂住。 */
fs.rmSync(DSH_HOME, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
