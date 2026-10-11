/**
 * Qoder 每日签到（lib/qoder-campaign.mjs）的单测。
 *
 * # 为什么单开一个文件
 *
 * 签到链有两个"错了也不会抛异常"的地方，正好都在本文件的射程里：
 *
 * 1. **`Cosy-ClientType` 用错值**（拿额度链的 `5` 打活动线）：服务端回 200 +
 *    `{"showCampaign":false,"campaigns":[]}` —— 表现成「今天没有活动」，
 *    于是功能静默失效，且日志里一行错都没有。本文件把「签到链必须是 10、
 *    额度链必须是 5」钉成断言，并顺手断言两组头**不互相污染**。
 * 2. **把人家的幂等当成功**：对已领活动再 POST，服务端回 200 + `replayed:true`
 *    + `grantId` + `benefit.amount`，余额一分不变（实测 577 → 577）。若按
 *    `grantId` 非空判定"这次领到了"，界面就会**每天谎报一次 +100**。判据只能
 *    是 `replayed`。
 *
 * fixture 全部取自 2026-10-11 的真机响应原文（活动列表 / 领取重放 / 额度），
 * 只有"今天还没领、真发放"那一条是**未观测分支**：真机当天两个账号都已是
 * `CLAIMED`，所以那一份是按同端点同形响应写的（`replayed` 缺席），此处如实标注。
 *
 * 运行：node test/qoder-campaign.test.mjs
 */

import {
  QODER_CAMPAIGN_CLIENT_TYPE,
  QODER_CAMPAIGN_STATUS_CLAIMED,
  QODER_CAMPAIGNS_PATH,
  checkinQoderAccount,
  claimQoderCampaign,
  fetchQoderCampaigns,
  parseQoderCampaign,
  parseQoderCampaignBenefit,
  parseQoderCampaigns,
  parseQoderClaimResult,
  pickQoderCheckinCampaign,
  qoderCampaignClaimPath,
  qoderCampaignHeaders,
} from '../lib/qoder-campaign.mjs';
import { QODER_QUOTA_CLIENT_TYPE, qoderQuotaHeaders } from '../lib/qoder-credits.mjs';

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

/** 假 fetcher：记下每次调用，按脚本回响应（`Error` 直接抛）。 */
function fakeFetcher(script) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const entry = typeof script === 'function' ? script(calls.length, url, init) : script;
    if (entry instanceof Error) throw entry;
    return entry;
  };
  fetcher.calls = calls;
  return fetcher;
}

const fakeResponse = (status, body, { text } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (text === undefined ? JSON.stringify(body) : text),
});

const CREDENTIAL = { accessToken: 'dt-abcdef123456', userId: 'u-1', userName: '号一' };

/* ------------------------------------------------------------------ *
 * 真机原文
 * ------------------------------------------------------------------ */

/** `GET /sash/api/v1/me/campaigns` —— 2026-10-11 实测（签到活动今天已领）。 */
const CAMPAIGNS_BODY = {
  uid: '01a0c90b-691c-7bf4-953a-835808c1b3d6',
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
            en: {
              buttonText: '',
              description: 'Daily reset: 10:00 (UTC+8). Valid for 30 days after claiming.',
              detailUrl: 'https://docs.qoder.cn/en/events/100credits',
              title: 'Claim 100 Credits Daily',
            },
            zh: {
              buttonText: '',
              description: '每日 10:00（UTC+8）刷新，领取后 30 天有效',
              detailUrl: 'https://docs.qoder.cn/events/100credits',
              title: '每天领 100 Credits',
            },
          },
        },
      ],
    },
    {
      campaignId: '01a05bbf-5668-7031-83d6-91545f97ec05',
      campaignKey: 'act-20260901-922',
      actionType: 'VIEW_DETAILS',
      startAt: 1788243600,
      endAt: 1793462340,
      claimStatus: 'CLAIMED',
      placements: [
        {
          type: 'POPUP',
          campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
          content: {
            zh: {
              buttonText: '',
              description: '首次订阅 Pro 得 4,000 Qwen Credits，Pro+ 得 12,000。续费与升级各得 1,000。',
              detailUrl: 'https://docs.qoder.cn/events/bogo',
              title: '限时：Pro/Pro+ 首月 Credits 翻倍',
            },
          },
        },
      ],
    },
  ],
};

/** `POST …/claim` 对**已领**活动的重放响应 —— 2026-10-11 实测原文。 */
const CLAIM_REPLAYED_BODY = {
  grantId: '01a128b7-c7dc-761c-83ea-b5c0068a0de6',
  status: 'CLAIMED',
  replayed: true,
  benefit: {
    kind: 'CREDITS',
    amount: 100,
    modelScope: { modelSeries: { key: 'ALL_MODELS' } },
    validity: { mode: 'RELATIVE_DAYS', days: 30 },
  },
  campaignId: '01a12102-1a77-7699-860d-136e42ef52d1',
  campaignKey: 'act-20261009-747',
  campaignVersion: 1,
  claimedAt: '2026-10-11T02:08:15.243893Z',
  grantedAt: '2026-10-11T02:08:15.461578Z',
  expiresAt: '2026-11-10T02:08:15.243893Z',
};

/**
 * 「今天还没领、POST 之后真发放」——**未观测分支**（真机两个账号当天都已领）。
 * 按同端点同形响应写：同字段，`replayed` 缺席。
 */
const CLAIM_FRESH_BODY = {
  ...CLAIM_REPLAYED_BODY,
  grantId: '01a128b7-0000-0000-0000-000000000000',
  replayed: false,
  claimedAt: '2026-10-12T02:00:01.000000Z',
  grantedAt: '2026-10-12T02:00:01.200000Z',
};

/** 可领取版本的列表：把当天那条翻成 `CLAIMABLE`（服务端每天 10:00 就是这形态）。 */
const CAMPAIGNS_CLAIMABLE_BODY = {
  ...CAMPAIGNS_BODY,
  claimable: true,
  campaigns: [
    { ...CAMPAIGNS_BODY.campaigns[0], claimStatus: 'CLAIMABLE' },
    CAMPAIGNS_BODY.campaigns[1],
  ],
};

/* ------------------------------------------------------------------ *
 * 1. 请求头 / 路径：签到链与额度链必须是两组头
 * ------------------------------------------------------------------ */

console.log('Qoder 每日签到（活动线）\n');
console.log('请求头与路径');

{
  const headers = qoderCampaignHeaders('dt-abc');
  eq('签到链的 Cosy-ClientType 是 10', headers['Cosy-ClientType'], QODER_CAMPAIGN_CLIENT_TYPE);
  eq('签到链的 User-Agent 是 "Qoder"（官方 jYe 逐字）', headers['User-Agent'], 'Qoder');
  eq('Accept 是 application/json', headers.Accept, 'application/json');
  eq('带 Bearer 令牌', headers.Authorization, 'Bearer dt-abc');
  // 官方活动链的裸头里没有这两个；多发头会让请求形态偏离官方客户端。
  ok('签到链不发 Cosy-Version', headers['Cosy-Version'] === undefined);
  ok('签到链不发 Cosy-MachineOS', headers['Cosy-MachineOS'] === undefined);

  const quota = qoderQuotaHeaders('dt-abc');
  eq('额度链仍然是 5（两条链不许互相污染）', quota['Cosy-ClientType'], QODER_QUOTA_CLIENT_TYPE);
  ok(
    '两条链的 clientType 确实不同（写死这一条，防止有人"统一"它们）',
    quota['Cosy-ClientType'] !== headers['Cosy-ClientType'],
  );
  ok('额度链照旧发 Cosy-MachineOS', typeof quota['Cosy-MachineOS'] === 'string');

  eq(
    '领取路径',
    qoderCampaignClaimPath('01a12102-1a77-7699-860d-136e42ef52d1'),
    '/sash/api/v1/me/campaigns/01a12102-1a77-7699-860d-136e42ef52d1/claim',
  );
  eq(
    'campaignId 会被转义（上游给的字符串不当路径用）',
    qoderCampaignClaimPath('a/b?c'),
    '/sash/api/v1/me/campaigns/a%2Fb%3Fc/claim',
  );
  eq('活动列表路径', QODER_CAMPAIGNS_PATH, '/sash/api/v1/me/campaigns');
}

/* ------------------------------------------------------------------ *
 * 2. 纯解析
 * ------------------------------------------------------------------ */

console.log('\n活动列表解析');

{
  const parsed = parseQoderCampaigns(CAMPAIGNS_BODY);
  ok('认识活动列表响应', parsed !== undefined);
  eq('showCampaign 透出', parsed.showCampaign, true);
  eq('顶层 claimable 透出（注意它可能与单条活动不一致）', parsed.claimable, false);
  eq('顶层 campaignUrl 透出', parsed.campaignUrl, 'https://openapi.qoder.com.cn/growth-page/activity-iframe');
  eq('两条活动都解析出来', parsed.campaigns.length, 2);

  const [today, promo] = parsed.campaigns;
  eq('签到活动靠 actionType 认出来', today.isCheckin, true);
  eq('营销活动不是签到活动', promo.isCheckin, false);
  eq('claimStatus 原样保留', today.claimStatus, QODER_CAMPAIGN_STATUS_CLAIMED);
  eq('已领 → claimed 为真', today.claimed, true);
  eq('已领 → claimable 为假', today.claimable, false);
  // startAt/endAt 是**秒**：当毫秒会算出 1970 年。
  eq('startAt 按秒换算成毫秒', today.startAtMs, 1791684000000);
  eq('endAt 按秒换算成毫秒', today.endAtMs, 1791770340000);
  eq('窗口约等于一天（10:00 → 次日 09:59）', Math.round((today.endAtMs - today.startAtMs) / 1000), 86340);
  eq('benefit.kind', today.benefit.kind, 'CREDITS');
  eq('benefit.amount', today.benefit.amount, 100);
  eq('validity 天数', today.benefit.validDays, 30);
  eq('适用模型范围', today.benefit.modelScopeKey, 'ALL_MODELS');
  // 文案优先中文：界面是中文的，英文只作兜底。
  eq('取中文标题', today.content.title, '每天领 100 Credits');
  eq('取中文说明（真实刷新节奏写在这里）', today.content.description, '每日 10:00（UTC+8）刷新，领取后 30 天有效');
  eq('详情页', today.content.detailUrl, 'https://docs.qoder.cn/events/100credits');
  eq('placement 里的 campaignUrl 收进活动对象', today.campaignUrl, 'https://openapi.qoder.sh/growth-page/activity-iframe');

  // 形态不认识 ≠ 活动列表是空的：前者必须返回 undefined，否则界面会把
  // 「解析失败」显示成「今天没有活动」。
  ok('没有 campaigns 数组 → undefined', parseQoderCampaigns({ uid: 'x' }) === undefined);
  ok('不是对象 → undefined', parseQoderCampaigns('nope') === undefined);
  const nested = parseQoderCampaigns({ data: { campaigns: CAMPAIGNS_BODY.campaigns } });
  ok('兼容 data.campaigns 多套一层', nested !== undefined && nested.campaigns.length === 2);
  ok('空数组是「活动列表为空」而不是解析失败', parseQoderCampaigns({ campaigns: [] }).campaigns.length === 0);
  ok('单条坏数据不牵连整份列表', parseQoderCampaigns({ campaigns: [null, CAMPAIGNS_BODY.campaigns[0]] }).campaigns.length === 1);
  ok('没有 campaignId 的单条被丢掉', parseQoderCampaign({ campaignKey: 'act-x' }) === undefined);
  ok('benefit 缺席 → undefined（不编 0）', parseQoderCampaignBenefit(undefined) === undefined);
  const noDays = parseQoderCampaignBenefit({ kind: 'CREDITS', amount: 5, validity: { mode: 'ABSOLUTE' } });
  ok('validity 不是 RELATIVE_DAYS 时不报天数', noDays.validDays === undefined && noDays.amount === 5);
}

console.log('\n挑选「今天该签的那个」');

{
  const parsed = parseQoderCampaigns(CAMPAIGNS_BODY);
  const picked = pickQoderCheckinCampaign(parsed.campaigns);
  ok('挑到签到活动（忽略 VIEW_DETAILS 营销活动）', picked?.campaign.campaignKey === 'act-20261009-747');
  eq('已领时 claimable 为假', picked.claimable, false);

  const claimable = pickQoderCheckinCampaign(parseQoderCampaigns(CAMPAIGNS_CLAIMABLE_BODY).campaigns);
  ok('可领时挑到可领的那条', claimable.campaign.campaignId === CAMPAIGNS_BODY.campaigns[0].campaignId);
  eq('可领时 claimable 为真', claimable.claimable, true);

  // 同状态多条时取最近的那个窗口（服务端每天换一条 campaignKey，列表里留着
  // 旧窗口也不奇怪）。
  const older = { ...CAMPAIGNS_BODY.campaigns[0], campaignId: 'old', campaignKey: 'act-old', startAt: 1791000000 };
  const newest = pickQoderCheckinCampaign(
    parseQoderCampaigns({ campaigns: [older, CAMPAIGNS_BODY.campaigns[0]] }).campaigns,
  );
  eq('同状态取窗口更近的那条', newest.campaign.campaignKey, 'act-20261009-747');

  const bothClaimable = pickQoderCheckinCampaign(
    parseQoderCampaigns({
      campaigns: [
        { ...older, claimStatus: 'CLAIMABLE' },
        { ...CAMPAIGNS_BODY.campaigns[0], claimStatus: 'CLAIMABLE' },
      ],
    }).campaigns,
  );
  eq('可领优先于已领时仍按窗口取新', bothClaimable.campaign.startAtMs, 1791684000000);

  ok(
    '只有营销活动 → 挑不出来（不是"签了营销活动"）',
    pickQoderCheckinCampaign(parseQoderCampaigns({ campaigns: [CAMPAIGNS_BODY.campaigns[1]] }).campaigns) ===
      undefined,
  );
  ok('空列表 → 挑不出来', pickQoderCheckinCampaign([]) === undefined);
}

console.log('\n领取响应解析');

{
  const replayed = parseQoderClaimResult(CLAIM_REPLAYED_BODY);
  eq('replayed 透出', replayed.replayed, true);
  eq('重放 = 今天已领过（不是本次发放）', replayed.alreadyCheckedIn, true);
  eq('重放不记为"本次领到"', replayed.granted, false);
  eq('重放也带 grantId（所以不能用它判成败）', replayed.grantId.length > 0, true);
  eq('重放带数量（用来显示"已领 +100"）', replayed.amount, 100);
  eq('重放带有效期', replayed.validDays, 30);
  eq('claimedAt 解析成毫秒', replayed.claimedAtMs, Date.parse('2026-10-11T02:08:15.243893Z'));
  eq('expiresAt 解析成毫秒', replayed.expiresAtMs, Date.parse('2026-11-10T02:08:15.243893Z'));

  const fresh = parseQoderClaimResult(CLAIM_FRESH_BODY);
  eq('未观测分支：replayed=false → 本次发放', fresh.granted, true);
  eq('未观测分支：不是"已领"', fresh.alreadyCheckedIn, false);
  eq('未观测分支：数量仍是 100', fresh.amount, 100);
  const missing = parseQoderClaimResult({ grantId: 'g', benefit: { kind: 'CREDITS', amount: 7 } });
  eq('replayed 缺席时按"本次发放"处理', missing.granted, true);
  ok('不是对象 → undefined', parseQoderClaimResult('nope') === undefined);
  eq('ISO 串坏了就当作"没给"', parseQoderClaimResult({ grantId: 'g', claimedAt: '昨天' }).claimedAtMs, undefined);
}

/* ------------------------------------------------------------------ *
 * 3. 网络层
 * ------------------------------------------------------------------ */

console.log('\n网络层');

{
  const fetcher = fakeFetcher(fakeResponse(200, CAMPAIGNS_BODY));
  const result = await fetchQoderCampaigns(CREDENTIAL, { fetcher });
  eq('成功时 ok 为真', result.ok, true);
  eq('打了活动列表端点', fetcher.calls[0].url, 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns');
  eq('用 GET', fetcher.calls[0].init.method, 'GET');
  eq('带 clientType 10（真机就靠它）', fetcher.calls[0].init.headers['Cosy-ClientType'], '10');
  eq('没有额外请求', fetcher.calls.length, 1);

  const noToken = await fetchQoderCampaigns({}, { fetcher: fakeFetcher(fakeResponse(200, CAMPAIGNS_BODY)) });
  eq('没有令牌 → no-credential（本地判定，不打网络）', noToken.code, 'no-credential');

  const unauthorized = await fetchQoderCampaigns(CREDENTIAL, {
    fetcher: fakeFetcher(fakeResponse(401, { errorCode: 'Unauthorized' })),
  });
  eq('HTTP 401 → unauthorized', unauthorized.code, 'unauthorized');
  eq('401 的提示让人重新登录', unauthorized.message.includes('重新登录'), true);

  const broken = await fetchQoderCampaigns(CREDENTIAL, {
    fetcher: fakeFetcher(fakeResponse(500, {}, { text: '<html>boom</html>' })),
  });
  eq('HTTP 500 → campaigns-failed', broken.code, 'campaigns-failed');
  ok('失败信息里带状态码与响应摘要', broken.message.includes('500') && broken.message.includes('boom'), broken.message);

  const html = await fetchQoderCampaigns(CREDENTIAL, {
    fetcher: fakeFetcher(fakeResponse(200, {}, { text: '<html>not json</html>' })),
  });
  eq('非 JSON → campaigns-failed', html.code, 'campaigns-failed');
  ok('非 JSON 的提示说得直白', html.message.includes('不是 JSON'), html.message);

  const weird = await fetchQoderCampaigns(CREDENTIAL, {
    fetcher: fakeFetcher(fakeResponse(200, { uid: 'x' })),
  });
  ok('形态不认识 → 失败（不是"今天没有活动"）', weird.ok === false && weird.code === 'campaigns-failed');

  const down = await fetchQoderCampaigns(CREDENTIAL, { fetcher: fakeFetcher(new Error('network down')) });
  eq('网络异常 → network', down.code, 'network');

  /* 领取 */
  const claimFetcher = fakeFetcher(fakeResponse(200, CLAIM_REPLAYED_BODY));
  const claim = await claimQoderCampaign(CREDENTIAL, 'cid-1', { fetcher: claimFetcher });
  eq('领取 ok', claim.ok, true);
  eq(
    '领取端点',
    claimFetcher.calls[0].url,
    'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/cid-1/claim',
  );
  eq('领取用 POST', claimFetcher.calls[0].init.method, 'POST');
  eq('领取体是空串（官方就是空 body）', claimFetcher.calls[0].init.body, '');
  eq('领取也带 clientType 10', claimFetcher.calls[0].init.headers['Cosy-ClientType'], '10');
  eq('重放被解析成"今天已领过"', claim.claim.alreadyCheckedIn, true);

  const claim401 = await claimQoderCampaign(CREDENTIAL, 'cid-1', {
    fetcher: fakeFetcher(fakeResponse(401, {})),
  });
  eq('领取 401 → unauthorized', claim401.code, 'unauthorized');
  const noId = await claimQoderCampaign(CREDENTIAL, '', { fetcher: fakeFetcher(fakeResponse(200, {})) });
  eq('没有 campaignId → claim-failed（本地判定）', noId.code, 'claim-failed');
}

/* ------------------------------------------------------------------ *
 * 4. 编排：一个账号的签到
 * ------------------------------------------------------------------ */

console.log('\n单账号签到编排');

{
  // ① 今天可领 → 读列表 + 领取，两次请求。
  const fetcher = fakeFetcher((n) =>
    n === 1 ? fakeResponse(200, CAMPAIGNS_CLAIMABLE_BODY) : fakeResponse(200, CLAIM_FRESH_BODY),
  );
  const result = await checkinQoderAccount(CREDENTIAL, { fetcher });
  eq('可领时 ok', result.ok, true);
  eq('可领时 claimed 为真', result.claimed, true);
  eq('可领时不算"今天已签过"', result.alreadyCheckedIn, false);
  eq('可领时领到 100', result.claim.amount, 100);
  eq('可领时窗口结束时间带出来（界面提示用）', result.campaign.endAtMs, 1791770340000);
  eq('恰好两次请求（列表 + 领取）', fetcher.calls.length, 2);
  ok('第二次真的是领取', fetcher.calls[1].url.endsWith('/claim'));

  // ② 今天已领 → **只读列表，不发领取**（幂等保护：不白打一次上游）。
  const alreadyFetcher = fakeFetcher(fakeResponse(200, CAMPAIGNS_BODY));
  const already = await checkinQoderAccount(CREDENTIAL, { fetcher: alreadyFetcher });
  eq('已领时 ok（这不是失败）', already.ok, true);
  eq('已领时 claimed 为假', already.claimed, false);
  eq('已领时 alreadyCheckedIn 为真', already.alreadyCheckedIn, true);
  eq('已领时只打一次上游（不重复领取）', alreadyFetcher.calls.length, 1);
  eq('已领时也带出数量（显示"已领 +100"）', already.campaign.benefit.amount, 100);

  // ③ 列表说可领、但服务端回重放（并发/竞态：另一个客户端刚领过）→ 按"今天已领"。
  const raceFetcher = fakeFetcher((n) =>
    n === 1 ? fakeResponse(200, CAMPAIGNS_CLAIMABLE_BODY) : fakeResponse(200, CLAIM_REPLAYED_BODY),
  );
  const race = await checkinQoderAccount(CREDENTIAL, { fetcher: raceFetcher });
  eq('竞态下 ok', race.ok, true);
  eq('竞态下不谎报"本次领到"', race.claimed, false);
  eq('竞态下如实说"今天已领过"', race.alreadyCheckedIn, true);

  // ④ 上游今天没下发活动 → no-campaign，且**不发领取**。
  const noneFetcher = fakeFetcher(fakeResponse(200, { showCampaign: false, campaigns: [] }));
  const none = await checkinQoderAccount(CREDENTIAL, { fetcher: noneFetcher });
  eq('没有活动 → ok:false', none.ok, false);
  eq('没有活动 → code=no-campaign', none.code, 'no-campaign');
  ok('没有活动时提示说得清（10:00 刷新/已下线）', none.message.includes('10:00'), none.message);
  eq('没有活动时不发领取', noneFetcher.calls.length, 1);

  // ⑤ 只有营销活动 → 也是 no-campaign，但把营销活动的 key 带出来（可诊断）。
  const promoOnly = await checkinQoderAccount(CREDENTIAL, {
    fetcher: fakeFetcher(fakeResponse(200, { campaigns: [CAMPAIGNS_BODY.campaigns[1]] })),
  });
  eq('只有营销活动 → no-campaign', promoOnly.code, 'no-campaign');
  ok(
    '把营销活动的 key 带出来（回答"为什么没有签到活动"）',
    promoOnly.otherCampaignKeys.includes('act-20260901-922'),
    JSON.stringify(promoOnly.otherCampaignKeys),
  );

  // ⑥ 令牌过期 → unauthorized，且**不发领取**。
  const expiredFetcher = fakeFetcher(fakeResponse(401, { errorCode: 'Unauthorized' }));
  const expired = await checkinQoderAccount(CREDENTIAL, { fetcher: expiredFetcher });
  eq('令牌过期 → unauthorized', expired.code, 'unauthorized');
  eq('令牌过期时不发领取', expiredFetcher.calls.length, 1);

  // ⑦ 领取失败 → claim-failed，但活动信息仍然带出来（界面能说清是哪个活动）。
  const claimFail = await checkinQoderAccount(CREDENTIAL, {
    fetcher: fakeFetcher((n) => (n === 1 ? fakeResponse(200, CAMPAIGNS_CLAIMABLE_BODY) : fakeResponse(500, {}, { text: 'boom' }))),
  });
  eq('领取失败 → claim-failed', claimFail.code, 'claim-failed');
  eq('领取失败时仍带出活动（可诊断）', claimFail.campaign.campaignKey, 'act-20261009-747');

  // ⑧ 没有令牌：一次网络请求都不该发。
  const noTokenFetcher = fakeFetcher(fakeResponse(200, CAMPAIGNS_BODY));
  const noToken = await checkinQoderAccount({}, { fetcher: noTokenFetcher });
  eq('没有令牌 → no-credential', noToken.code, 'no-credential');
  eq('没有令牌时零请求', noTokenFetcher.calls.length, 0);
}

console.log(`\nqoder-campaign: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
