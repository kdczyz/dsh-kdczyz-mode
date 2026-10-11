/**
 * qoder-campaign.mjs —— Qoder CN **每日签到**（活动线）。
 *
 * ## 端点（实证口径）
 *
 * ```
 * GET  {openapiBase}/sash/api/v1/me/campaigns                     # 活动列表
 * POST {openapiBase}/sash/api/v1/me/campaigns/{campaignId}/claim  # 领取（空 body）
 *
 * Authorization: Bearer <dt-…>
 * Cosy-ClientType: 10        ← 签到链**专用**值；额度链是 5
 * User-Agent: Qoder
 * ```
 *
 * 基址与 `qoder-credits.mjs` 同 host（`https://openapi.qoder.com.cn`），凭据也是
 * 同一族 `dt-…` 设备令牌 —— 入池凭据直接当 Bearer，不需要换 job token。
 *
 * ## 为什么额度链那套头**不能**拿来打签到链
 *
 * 这是本模块唯一必须写清楚的坑，也是它此前"看起来不存在"的原因：
 *
 * | 链条 | 端点 | `Cosy-ClientType` | 拿 `Cosy-Version`/`Cosy-MachineOS` |
 * |---|---|---|---|
 * | 额度 | `/api/v2/quota/usage` | `5` | 发 |
 * | 签到 | `/sash/api/v1/me/campaigns` | **`10`** | **不发** |
 *
 * 用 `5` 打活动线，服务端**回 200 而不是报错**：
 *
 * ```json
 * {"uid":"…","showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}
 * ```
 *
 * 也就是说，客户端类型不对时的表现是「今天没有活动」，而不是「你调错了」——
 * 照着这个响应写代码，会得出「Qoder 没有签到」的错误结论。官方桌面端里这两组
 * 头是分开的两个常量：
 *
 * ```js
 * const Fh = Object.freeze({ clientType: 10, businessProduct: "app", sessionType: "app" });
 * function jYe(t) {                        // 活动/签到链的裸头
 *   return { Accept: "application/json", Authorization: `Bearer ${t}`,
 *            "Cosy-ClientType": String(Fh.clientType), "User-Agent": "Qoder" };
 * }
 * ```
 *
 * 所以本模块**自带** `qoderCampaignHeaders()`，绝不复用 `qoderQuotaHeaders()`。
 *
 * ## 活动形态（2026-10-11 实测原文，截取一条）
 *
 * ```json
 * {"campaignId":"01a12102-…","campaignKey":"act-20261009-747",
 *  "actionType":"CLAIM_BENEFIT","startAt":1791684000,"endAt":1791770340,
 *  "claimStatus":"CLAIMED",
 *  "benefit":{"kind":"CREDITS","amount":100,
 *             "modelScope":{"modelSeries":{"key":"ALL_MODELS"}},
 *             "validity":{"mode":"RELATIVE_DAYS","days":30}},
 *  "placements":[{"type":"POPUP","campaignUrl":"https://openapi.qoder.sh/growth-page/activity-iframe",
 *                 "content":{"zh":{"title":"每天领 100 Credits",
 *                                  "description":"每日 10:00（UTC+8）刷新，领取后 30 天有效",
 *                                  "detailUrl":"https://docs.qoder.cn/events/100credits"}}}]}
 * ```
 *
 * 三条硬约束：
 *
 * 1. **`startAt`/`endAt` 是秒**，不是毫秒。窗口是「每天 10:00（UTC+8）→ 次日
 *    09:59」，服务端每天换一条新的 `campaignKey`（`act-YYYYMMDD-NNN`）。
 *    当成毫秒会算出 1970 年。
 * 2. **签到活动靠 `actionType === "CLAIM_BENEFIT"` 认**，不是靠 `campaignKey`
 *    前缀，也不是靠 `placements[].type`。列表里同时躺着 `VIEW_DETAILS` 的营销
 *    活动（首月翻倍之类），把它当签到会每天去 POST 一个没有 benefit 的活动。
 * 3. **`claimStatus` 是唯一权威的"今天领没领"**：`CLAIMABLE`（可领）/
 *    `CLAIMED`（已领）。顶层那个 `claimable` 是**整个活动面板**的口径，两个
 *    账号实测都能出现「`claimable:false` 但活动列表里躺着 CLAIMED 的签到」。
 *
 * ## 领取是幂等的（实测）
 *
 * 对**已经领过**的当天活动再 POST 一次，回 200：
 *
 * ```json
 * {"grantId":"01a128b7-…","status":"CLAIMED","replayed":true,
 *  "benefit":{"kind":"CREDITS","amount":100,…},
 *  "campaignId":"01a12102-…","campaignKey":"act-20261009-747","campaignVersion":1,
 *  "claimedAt":"2026-10-11T02:08:15.243893Z","grantedAt":"2026-10-11T02:08:15.461578Z",
 *  "expiresAt":"2026-11-10T02:08:15.243893Z"}
 * ```
 *
 * 余额**没有变化**（577 → 577），所以 `replayed:true` 的语义是「今天已经领过了，
 * 服务端把当天那笔发放原样回给你」——**不是失败，也不是又发了一笔**。界面据此
 * 显示「今日已签到」，而不是「签到成功 +100」。
 *
 * 反面教训：按 `grantId` 的非空与否判断"这次领到了"会**每天都谎报一次成功**，
 * 因为重放响应里同样带 `grantId`。判据只能是 `replayed`。
 *
 * ## 未观测分支（如实标注）
 *
 * 「今天还没领、POST 之后真的发放」这条路上的响应**本机没能实测**：开发当天两个
 * 账号都已是 `CLAIMED`（官方客户端/用户脚本已领）。本模块按同一端点的同形响应
 * 处理（`replayed` 不为 `true` 即视为本次真发放），并有 fixture 钉死形状；
 * 真机首次领取会把它变成实证。这里刻意不写"实测"二字。
 *
 * ## 令牌过期
 *
 * 不做续期：Qoder 的 `deviceToken/refresh` 在号池里**尚未接线**（见
 * `qoder-pool.mjs` 的 `resolveFor()` 注释），这里如实把 401 报成
 * `unauthorized`，让界面提示「重新登录该账号」，而不是偷偷换一个账号去签。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** CN 开放接口基址（与额度链同 host）。 */
export const QODER_CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn';

/** 活动列表路径。 */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';

/** 领取路径的前缀；完整路径见 {@link qoderCampaignClaimPath}。 */
export const QODER_CAMPAIGN_CLAIM_PATH_PREFIX = '/sash/api/v1/me/campaigns/';

/** 签到链的 `Cosy-ClientType`（官方 `Fh.clientType = 10`）。**不要用 5。** */
export const QODER_CAMPAIGN_CLIENT_TYPE = '10';

/** 签到链的 `User-Agent`（官方 `jYe()` 逐字：`"Qoder"`，不是 `qoder/1.x`）。 */
export const QODER_CAMPAIGN_USER_AGENT = 'Qoder';

/** 请求超时（毫秒）。签到是人点的动作，宁可慢一点也不要半途而废。 */
export const QODER_CAMPAIGN_TIMEOUT_MS = 20_000;

/** `actionType`：可领取权益 —— 签到活动的判据。 */
export const QODER_CAMPAIGN_ACTION_CLAIM = 'CLAIM_BENEFIT';

/** `claimStatus`：今天可领。 */
export const QODER_CAMPAIGN_STATUS_CLAIMABLE = 'CLAIMABLE';

/** `claimStatus`：今天已领。 */
export const QODER_CAMPAIGN_STATUS_CLAIMED = 'CLAIMED';

/** 活动面板里"没有签到活动"时给用户看的兜底文案（界面不再自己编一句）。 */
export const QODER_CHECKIN_NO_CAMPAIGN_MESSAGE =
  '上游此刻没有下发签到活动（可能还没到 10:00 刷新，或活动已下线）';

/* ------------------------------------------------------------------ *
 * 小工具（与 qoder-credits.mjs 同款，刻意各留一份：两个模块互不依赖）
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source, key) {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source, key) {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBool(source, key) {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 秒级时间戳 → 毫秒。
 *
 * `startAt`/`endAt` 是**秒**（对齐 `expiresAt` 是毫秒那件事的反面）。`0`/
 * 负数/非数字一律当作"没给"：`0` 当时刻会算出 1970 年，那是噪声不是数据。
 */
function secondsToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 1000);
}

/** ISO 字符串 → 毫秒（`claimedAt`/`grantedAt`/`expiresAt` 是 ISO 串）。 */
function isoToMs(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 把错误响应压成一行可读摘要（与 qoder-credits 同语义，截断 200 字）。 */
export function summarizeQoderCampaignErrorBody(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (text === '') return '(空响应体)';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/* ------------------------------------------------------------------ *
 * 请求头 / 路径
 * ------------------------------------------------------------------ */

/**
 * 构造签到链请求头。
 *
 * 官方 `jYe()` 逐字四件套：`Accept` / `Authorization` / `Cosy-ClientType: 10` /
 * `User-Agent: "Qoder"`。**刻意不补** `Cosy-Version` 与 `Cosy-MachineOS`：
 * 那是额度链 `oo()` 包装层的行为，签到链的裸头里没有，多发头会让请求形态
 * 偏离官方客户端。
 *
 * @param {string} bearer 设备令牌（`dt-…`）
 */
export function qoderCampaignHeaders(bearer) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${bearer}`,
    'Cosy-ClientType': QODER_CAMPAIGN_CLIENT_TYPE,
    'User-Agent': QODER_CAMPAIGN_USER_AGENT,
  };
}

/**
 * 领取路径。
 *
 * `campaignId` 走 `encodeURIComponent` —— 实测值是 UUID（`01a12102-…`），本不需要
 * 转义，但它是**上游给的字符串**，直接拼进 URL 等于把上游数据当路径用。
 */
export function qoderCampaignClaimPath(campaignId) {
  return `${QODER_CAMPAIGN_CLAIM_PATH_PREFIX}${encodeURIComponent(String(campaignId))}/claim`;
}

/* ------------------------------------------------------------------ *
 * 纯函数：解析
 * ------------------------------------------------------------------ */

/**
 * 解析 `benefit`（签到给什么）。
 *
 * `amount` 缺席时**不补 0**、也不补 100：界面宁可显示「已签到（未给数量）」
 * 也不要编一个数字出来。`validDays` 取自 `validity`，只在 `RELATIVE_DAYS`
 * 语义下有意义。
 */
export function parseQoderCampaignBenefit(raw) {
  if (!isRecord(raw)) return undefined;
  const validity = isRecord(raw.validity) ? raw.validity : undefined;
  const mode = readString(validity, 'mode');
  return {
    kind: readString(raw, 'kind'),
    amount: readNumber(raw, 'amount'),
    unit: readString(raw, 'unit'),
    modelScopeKey: readString(isRecord(raw.modelScope?.modelSeries) ? raw.modelScope.modelSeries : {}, 'key'),
    validityMode: mode,
    validDays: mode === 'RELATIVE_DAYS' ? readNumber(validity, 'days') : undefined,
  };
}

/**
 * 从 `placements[]` 里挑一份文案。
 *
 * 优先中文（界面是中文的），没有中文再退英文；两份都没有就返回空串，
 * **不编标题** —— 界面据此显示「签到活动」这种中性词。
 */
export function parseQoderCampaignContent(placements) {
  const list = Array.isArray(placements) ? placements : [];
  const pick = (lang) => {
    for (const placement of list) {
      const content = isRecord(placement?.content) ? placement.content[lang] : undefined;
      if (isRecord(content)) return content;
    }
    return undefined;
  };
  const zh = pick('zh');
  const en = pick('en');
  const chosen = zh ?? en ?? {};
  const pickString = (key) => readString(chosen, key) || readString(en ?? {}, key) || readString(zh ?? {}, key);
  return {
    title: pickString('title'),
    description: pickString('description'),
    buttonText: pickString('buttonText'),
    detailUrl: pickString('detailUrl'),
    lang: zh !== undefined ? 'zh' : en !== undefined ? 'en' : '',
    /** 活动面板要给用户打开的落地页（与单条 placement 的 `campaignUrl` 同源）。 */
    campaignUrl: readString(list.find((p) => typeof p?.campaignUrl === 'string' && p.campaignUrl !== ''), 'campaignUrl'),
  };
}

/**
 * 解析单条活动。
 *
 * 认不出来（不是对象 / 没有 `campaignId`）时返回 `undefined`，由调用方决定
 * 怎么处理 —— 列表里混进未知形态时，一条坏的**不该**让整次签到失败。
 */
export function parseQoderCampaign(raw) {
  if (!isRecord(raw)) return undefined;
  const campaignId = readString(raw, 'campaignId');
  if (campaignId === '') return undefined;
  const status = readString(raw, 'claimStatus').toUpperCase();
  const actionType = readString(raw, 'actionType');
  const benefit = parseQoderCampaignBenefit(raw.benefit);
  const content = parseQoderCampaignContent(raw.placements);
  const startAtMs = secondsToMs(readNumber(raw, 'startAt'));
  const endAtMs = secondsToMs(readNumber(raw, 'endAt'));
  return {
    campaignId,
    campaignKey: readString(raw, 'campaignKey'),
    actionType,
    /** 原样保留大小写照（诊断用）；判定请用下面两个布尔。 */
    claimStatus: status,
    claimable: status === QODER_CAMPAIGN_STATUS_CLAIMABLE,
    claimed: status === QODER_CAMPAIGN_STATUS_CLAIMED,
    isCheckin: actionType === QODER_CAMPAIGN_ACTION_CLAIM,
    startAtMs,
    endAtMs,
    benefit,
    content,
    /** 顶层 `campaignUrl` 缺席时，用 placement 里那个顶上。 */
    campaignUrl: content.campaignUrl,
  };
}

/**
 * 解析活动列表响应。
 *
 * 顶层**没有** `campaigns` 数组时返回 `undefined`（=「形态不是我们认识的那个」），
 * 与「活动列表是空的」严格区分：前者是解析失败（不该显示成"没有活动"），
 * 后者是上游如实告诉你今天没活动。实测服务端在数据里还套过一层 `data`
 * （脚本里兼容了），这里一并兼容。
 */
export function parseQoderCampaigns(body) {
  if (!isRecord(body)) return undefined;
  let list = body.campaigns;
  if (!Array.isArray(list) && isRecord(body.data) && Array.isArray(body.data.campaigns)) {
    list = body.data.campaigns;
  }
  if (!Array.isArray(list)) return undefined;
  const campaigns = [];
  for (const raw of list) {
    const parsed = parseQoderCampaign(raw);
    if (parsed !== undefined) campaigns.push(parsed);
  }
  const showCampaign = readBool(body, 'showCampaign') ?? false;
  const claimable = readBool(body, 'claimable') ?? false;
  const topUrl = readString(body, 'campaignUrl');
  return {
    showCampaign,
    claimable,
    campaignUrl: topUrl !== '' ? topUrl : (campaigns.find((c) => c.campaignUrl !== '')?.campaignUrl ?? ''),
    campaigns,
  };
}

/**
 * 从活动列表里挑出「今天该签的那个」。
 *
 * 规则，按优先级：
 *
 * 1. 只看 `actionType === "CLAIM_BENEFIT"`（签到活动）。
 * 2. `CLAIMABLE` 优先于 `CLAIMED` —— 已领的拿来汇报，可领的拿来领。
 * 3. 同状态多条时取 `startAtMs` 最大的那条（最近的那个窗口；服务端每天换
 *    一条 `campaignKey`，列表里同时留着旧窗口也不奇怪）。
 *
 * @returns `{ campaign, claimable }`；没有签到活动时 `undefined`。
 */
export function pickQoderCheckinCampaign(campaigns) {
  const list = Array.isArray(campaigns) ? campaigns.filter((c) => c?.isCheckin === true) : [];
  if (list.length === 0) return undefined;
  const rank = (c) => (c.claimable ? 0 : c.claimed ? 1 : 2);
  const sorted = [...list].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (b.startAtMs ?? 0) - (a.startAtMs ?? 0);
  });
  const campaign = sorted[0];
  return { campaign, claimable: campaign.claimable };
}

/**
 * 解析领取响应。
 *
 * 判据只有 `replayed`：
 *
 * - `replayed === true` → 今天已经领过（服务端重放当天那笔发放），**不是本次发放**。
 * - 否则 → 本次发放，`granted: true`。
 *
 * **不要**用 `grantId` 是否存在来判断 —— 重放响应里同样带 `grantId`（实测），
 * 那样每天都会谎报一次「签到成功 +100」。
 */
export function parseQoderClaimResult(body) {
  if (!isRecord(body)) return undefined;
  const replayed = readBool(body, 'replayed') === true;
  const benefit = parseQoderCampaignBenefit(body.benefit);
  return {
    replayed,
    alreadyCheckedIn: replayed,
    granted: !replayed,
    grantId: readString(body, 'grantId'),
    status: readString(body, 'status').toUpperCase(),
    campaignId: readString(body, 'campaignId'),
    campaignKey: readString(body, 'campaignKey'),
    amount: benefit?.amount,
    unit: benefit?.unit ?? '',
    kind: benefit?.kind ?? '',
    validDays: benefit?.validDays,
    claimedAtMs: isoToMs(body.claimedAt),
    grantedAtMs: isoToMs(body.grantedAt),
    expiresAtMs: isoToMs(body.expiresAt),
    benefit,
  };
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

/** 组装超时信号（与 qoder-credits 同款：外部信号存在时用 `any` 合并）。 */
function timeoutSignal(external) {
  const timeout = AbortSignal.timeout?.(QODER_CAMPAIGN_TIMEOUT_MS);
  if (external === undefined) return timeout;
  if (timeout === undefined) return external;
  return AbortSignal.any([timeout, external]);
}

/** 读一个账号的签到活动列表。 */
export async function fetchQoderCampaigns(credential, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const openapiBase = options.openapiBase ?? QODER_CN_OPENAPI_BASE;
  const bearer = credential?.accessToken;
  if (typeof bearer !== 'string' || bearer.length === 0) {
    return { ok: false, code: 'no-credential', message: '凭据缺少令牌，请重新登录该账号' };
  }

  try {
    const response = await fetcher(`${openapiBase}${QODER_CAMPAIGNS_PATH}`, {
      method: 'GET',
      headers: qoderCampaignHeaders(bearer),
      signal: timeoutSignal(options.signal),
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'unauthorized',
        status: response.status,
        message: '令牌已失效，请重新登录该账号',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: 'campaigns-failed',
        status: response.status,
        message: `活动列表 HTTP ${response.status}：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: 'campaigns-failed',
        status: response.status,
        message: `活动列表不是 JSON：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    const parsed = parseQoderCampaigns(body);
    if (parsed === undefined) {
      return {
        ok: false,
        code: 'campaigns-failed',
        status: response.status,
        message: `活动列表形态不认识：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    return { ok: true, status: response.status, ...parsed };
  } catch (e) {
    return { ok: false, code: 'network', message: `活动列表请求失败：${e?.message ?? String(e)}` };
  }
}

/** 领取一个活动的权益（幂等：重复调用回 `replayed: true`）。 */
export async function claimQoderCampaign(credential, campaignId, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const openapiBase = options.openapiBase ?? QODER_CN_OPENAPI_BASE;
  const bearer = credential?.accessToken;
  if (typeof bearer !== 'string' || bearer.length === 0) {
    return { ok: false, code: 'no-credential', message: '凭据缺少令牌，请重新登录该账号' };
  }
  if (typeof campaignId !== 'string' || campaignId === '') {
    return { ok: false, code: 'claim-failed', message: '缺少 campaignId，无法领取' };
  }

  try {
    const response = await fetcher(`${openapiBase}${qoderCampaignClaimPath(campaignId)}`, {
      method: 'POST',
      headers: { ...qoderCampaignHeaders(bearer), 'Content-Length': '0' },
      body: '',
      signal: timeoutSignal(options.signal),
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'unauthorized',
        status: response.status,
        message: '令牌已失效，请重新登录该账号',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: 'claim-failed',
        status: response.status,
        message: `领取 HTTP ${response.status}：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: 'claim-failed',
        status: response.status,
        message: `领取响应不是 JSON：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    const claim = parseQoderClaimResult(body);
    if (claim === undefined) {
      return {
        ok: false,
        code: 'claim-failed',
        status: response.status,
        message: `领取响应形态不认识：${summarizeQoderCampaignErrorBody(text)}`,
      };
    }
    return { ok: true, status: response.status, claim };
  } catch (e) {
    return { ok: false, code: 'network', message: `领取请求失败：${e?.message ?? String(e)}` };
  }
}

/* ------------------------------------------------------------------ *
 * 编排：一个账号的签到
 * ------------------------------------------------------------------ */

/**
 * 给**一个**账号签到。
 *
 * 这条链刻意只吃"一个凭据"，不吃号池：调用方（路由）自己按 accountId 取凭据，
 * 于是签到永远不会触发选号/换号 —— 与 Trae 侧同一条设计约束（「签自己那个账号，
 * 不切换正在服务的账号」）。
 *
 * 返回形状：
 *
 * ```js
 * { ok: true,  claimed: true,  alreadyCheckedIn: false, campaign, claim: { amount, … } }
 * { ok: true,  claimed: false, alreadyCheckedIn: true,  campaign, claim: { replayed: true, … } }
 * { ok: false, code: 'no-campaign' | 'unauthorized' | 'campaigns-failed' | 'claim-failed' | …, message, campaign? }
 * ```
 *
 * `ok: true` 的两种情形**必须分开**：`claimed` 是"这一下真的领到了"，
 * `alreadyCheckedIn` 是"今天早就领过了"。混成一个布尔会让界面每天都喊一次
 * 「签到成功 +100」，而余额其实没动。
 */
export async function checkinQoderAccount(credential, options = {}) {
  const list = await fetchQoderCampaigns(credential, options);
  if (!list.ok) return list;

  const picked = pickQoderCheckinCampaign(list.campaigns);
  if (picked === undefined) {
    const others = list.campaigns.map((c) => c.campaignKey || c.campaignId).filter((x) => x !== '');
    return {
      ok: false,
      code: 'no-campaign',
      message: QODER_CHECKIN_NO_CAMPAIGN_MESSAGE,
      campaigns: list.campaigns,
      // 只有营销活动时把它们的 key 带出来，便于回答"为什么没有签到活动"。
      otherCampaignKeys: others,
      showCampaign: list.showCampaign,
      panelUrl: list.campaignUrl,
    };
  }

  const { campaign, claimable } = picked;
  if (!claimable) {
    // `CLAIMED`（或未知状态但今天不可能再领）：如实汇报，**不打** claim。
    return {
      ok: true,
      claimed: false,
      alreadyCheckedIn: campaign.claimed,
      claimStatus: campaign.claimStatus,
      campaign,
      claim: undefined,
      campaigns: list.campaigns,
    };
  }

  const claim = await claimQoderCampaign(credential, campaign.campaignId, options);
  if (!claim.ok) return { ...claim, campaign, campaigns: list.campaigns };
  return {
    ok: true,
    claimed: claim.claim.granted,
    alreadyCheckedIn: claim.claim.alreadyCheckedIn,
    claimStatus: QODER_CAMPAIGN_STATUS_CLAIMED,
    campaign,
    claim: claim.claim,
    campaigns: list.campaigns,
  };
}
