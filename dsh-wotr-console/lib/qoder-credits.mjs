/**
 * qoder-credits.mjs —— Qoder 上游积分（Credits）额度查询。
 *
 * ## 端点与凭据（实证口径）
 *
 * ```
 * GET {openapiBase}/api/v2/quota/usage
 * Authorization: Bearer <令牌>
 * ```
 *
 * 基址取 `https://openapi.qoder.com.cn`（CN），与 `qoder-auth.mjs` 的
 * `QODER_CN_OPENAPI_BASE` 同一个 host —— 换令牌与查额度都挂在这个基址上。
 *
 * ## 为什么本模块**不需要**换 job token
 *
 * 这是本模块与多数参考实现最大的差别，也是唯一必须写清楚的一条。
 *
 * Qoder 有**两族令牌**，`access_token` 里存的可能是任一族：
 *
 * | `access_token` 形态 | 来源 | 打 quota 端点时怎么用 |
 * |---|---|---|
 * | `dt-…` 设备令牌 | 浏览器设备流 poll 返回 | **原样当 Bearer**（零网络） |
 * | `pt-…` PAT | 用户在 Integrations 页签发 | 需先打 `jobToken/exchange` 换 `jt-` |
 *
 * 本插件**只走设备流**（见 `qoder-auth.mjs` 的模块头），所以入池的凭据一律是
 * `dt-…`，**它本身就是 quota / chat 认的 Bearer**，直接发即可。
 *
 * 反面教训：把 `dt-` 提交给 `jobToken/exchange` 会回 HTTP 400 `BadRequest`
 * （那是 PAT 专用端点），表现为「登录明明成功、查额度却报凭据无效」的假象。
 * 故这里**刻意不做**令牌族分派 —— 不做才不会做错。将来若要支持粘贴 PAT，
 * 分派点应当加在本模块的 `resolveBearer` 一处，而不是散在调用方。
 *
 * ## 响应结构：三池，后两池可缺席
 *
 * 200 响应原文（实证样本，本模块全部 fixture 的来源）：
 *
 * ```json
 * {"userId":"…","userType":"personal_standard","usageType":"credits",
 *  "totalUsagePercentage":0.0,"isQuotaExceeded":true,"expiresAt":253402214400000,
 *  "upgradeUrl":"https://qoder.com/pricing?client=qoder","outerProviders":[],
 *  "userQuota":{"total":0.0,"used":0.0,"remaining":0.0,"percentage":0.0,"unit":"credits"},
 *  "isPlanQuotaProrated":false}
 * ```
 *
 * 三条硬约束：
 *
 * 1. **三池结构，后两池可缺席**。`userQuota` 是主额度；`addOnQuota`（加量包）
 *    / `orgResourcePackage`（资源包）可能整个字段不存在 —— 解析必须容缺，
 *    当作「该池不存在」，**不是**「该池余额为 0」。
 * 2. **主池耗尽 ≠ 额度耗尽**。实测有账号 `userQuota.remaining = 0` 而
 *    `addOnQuota.remaining = 100`。只看主池会把它误判成空号并踢出轮转。
 *    故余额口径是**三池 `remaining` 之和**。
 * 3. **`expiresAt` 是毫秒**（`253402214400000` = 9999 年 = 永不过期），
 *    不是秒。当成秒会算出公元 800 万年。它还是**账号级**字段，不是池级
 *    —— 池本身没有失效字段，故它只作诊断保留，不参与余额计算。
 *
 * ## 「查不到」与「余额为 0」严格区分
 *
 * 失败一律返回 `{ ok: false, ... }`，**绝不**伪造成 `total: 0`。把网络故障
 * 或凭据失效显示成「这个账号一分钱都没有了」，会直接导致用户误删好账号。
 * 下游据此填错误文案而不是 0 余额。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** CN 开放接口基址（与 qoder-auth.mjs 的轮询同 host）。 */
export const QODER_CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn';

/** 额度查询路径。注意是 `/api/v2/`，不是 `/sash/` 那条活动线。 */
export const QODER_QUOTA_USAGE_PATH = '/api/v2/quota/usage';

/** 控制面请求超时（毫秒）。 */
export const QODER_REQUEST_TIMEOUT_MS = 30_000;

/** 出站 User-Agent：官方 CLI 实测值，两区同值。 */
export const QODER_USER_AGENT = 'qoder/1.1.16';

/**
 * 三个额度池的键，**顺序即展示顺序**。
 *
 * `userQuota` 必在；后两个是可选池（实测可能整个缺席）。
 */
export const QODER_QUOTA_POOL_KEYS = ['userQuota', 'addOnQuota', 'orgResourcePackage'];

/** 池键 → 可读名（卡片上显示这个，而不是把 `userQuota` 原样透出）。 */
export const QODER_QUOTA_POOL_LABELS = {
  userQuota: '主额度',
  addOnQuota: '加量包',
  orgResourcePackage: '资源包',
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(source, key) {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(source, key) {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}

function readBool(source, key) {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readEither(source, a, b) {
  const first = readString(source, a);
  return first.length > 0 ? first : readString(source, b);
}

/** 两位小数规整：多池浮点相加会放大成 `655.67000031` 这种噪声。 */
function roundCredits(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * 纯函数：解析
 * ------------------------------------------------------------------ */

/**
 * 解析单个额度池。
 *
 * `total` / `used` / `remaining` **全部可缺席**，缺席按 0 计；但整个字段
 * 不是对象时返回 `undefined`（= 该池不存在），与「余额为 0 的池」区分开。
 */
export function parseQoderQuotaPool(key, raw) {
  if (!isRecord(raw)) return undefined;
  return {
    key,
    name: QODER_QUOTA_POOL_LABELS[key] ?? key,
    unit: readString(raw, 'unit'),
    total: readNumber(raw, 'total') ?? 0,
    used: readNumber(raw, 'used') ?? 0,
    remaining: readNumber(raw, 'remaining') ?? 0,
    percentage: readNumber(raw, 'percentage') ?? 0,
  };
}

/**
 * 解析 `expiresAt`（毫秒时间戳）。
 *
 * 只在明显可用时才返回值：`0` / 负数 / 非数字一律视为「没给」——
 * `0` 在哨兵语义里表示「不设过期」，当成时刻会算出 1970 年。
 */
export function parseQoderQuotaExpiresAtMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * 解析额度响应。
 *
 * @returns 解析结果；**一个认识的池都没有**时返回 `undefined`
 *          —— 那是「响应形态不是我们认识的那个」的信号，必须与
 *          「三池全为 0 的真余额 0」区分开。
 */
export function parseQoderQuotaUsage(body) {
  if (!isRecord(body)) return undefined;
  const pools = [];
  for (const key of QODER_QUOTA_POOL_KEYS) {
    const pool = parseQoderQuotaPool(key, body[key]);
    if (pool !== undefined) pools.push(pool);
  }
  if (pools.length === 0) return undefined;

  const userId = readEither(body, 'userId', 'user_id');
  const userType = readEither(body, 'userType', 'user_type');
  const expiresAtMs = parseQoderQuotaExpiresAtMs(body.expiresAt);

  return {
    ...(userId.length === 0 ? {} : { userId }),
    ...(userType.length === 0 ? {} : { userType }),
    usageType: readString(body, 'usageType'),
    totalUsagePercentage: readNumber(body, 'totalUsagePercentage') ?? 0,
    isQuotaExceeded: readBool(body, 'isQuotaExceeded') ?? false,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    upgradeUrl: readString(body, 'upgradeUrl'),
    pools,
    isPlanQuotaProrated: readBool(body, 'isPlanQuotaProrated') ?? false,
  };
}

/**
 * 三池 `remaining` 之和（负数按 0 计，两位小数规整）。
 *
 * 负数 clamp：服务端在超额扣费 / 计量回滚下可能下发负值，原样相加会让余额
 * 显示成负数。
 *
 * **这是余额的唯一权威口径**：保留额度（credit reserve）判据、卡片总数都
 * 用它，不要另算一份。
 */
export function qoderQuotaRemainingTotal(usage) {
  return roundCredits(usage.pools.reduce((sum, pool) => sum + Math.max(0, pool.remaining), 0));
}

/**
 * 主池是否已耗尽而**其它池还有余额**。
 *
 * 用于卡片提示「主额度已用完，加量包还有 N」——这类账号仍然可用，
 * 不该被当成空号。
 */
export function qoderQuotaHasAddOnOnly(usage) {
  const main = usage.pools.find((pool) => pool.key === 'userQuota');
  if (main === undefined || main.remaining > 0) return false;
  return usage.pools.some((pool) => pool.key !== 'userQuota' && pool.remaining > 0);
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

/**
 * 构造额度请求头。
 *
 * 只需 `Authorization` / `Accept` / `User-Agent` —— 实证「该端点只需 Bearer，
 * 不需要模型目录那样的 WASM 签名」。`/sash/` 活动线才需要 `Cosy-ClientType`，
 * quota 线**不带**（加了会怎样未验证，属出站协议值红线）。
 */
export function qoderQuotaHeaders(bearer) {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    'User-Agent': QODER_USER_AGENT,
  };
}

/**
 * 把错误响应压成一行可读摘要（截断，避免把整页 HTML 塞进日志）。
 */
export function summarizeQoderErrorBody(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (text === '') return '(空响应体)';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * 查询一个账号的额度。
 *
 * @param credential - 本插件自有凭据（`normalizeQoderCredential` 的产物）。
 * @param options.fetcher - 注入点（测试用）。
 * @param options.openapiBase - 注入点（默认 CN）。
 * @param options.signal - 外部取消信号。
 * @returns `{ ok: true, usage, total }` 或 `{ ok: false, message }`。
 *          **失败绝不返回 0 余额。**
 */
export async function fetchQoderQuotaUsage(credential, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const openapiBase = options.openapiBase ?? QODER_CN_OPENAPI_BASE;
  const bearer = credential?.accessToken;

  if (typeof bearer !== 'string' || bearer.length === 0) {
    // 本地就能判定的终态，不必浪费一次网络往返。
    return { ok: false, message: '凭据缺少令牌，请重新登录该账号' };
  }

  const url = `${openapiBase}${QODER_QUOTA_USAGE_PATH}`;
  const timeout = AbortSignal.timeout?.(QODER_REQUEST_TIMEOUT_MS);
  const signal =
    options.signal === undefined
      ? timeout
      : timeout === undefined
        ? options.signal
        : AbortSignal.any([timeout, options.signal]);

  let response;
  try {
    response = await fetcher(url, { method: 'GET', headers: qoderQuotaHeaders(bearer), signal });
  } catch (error) {
    // 传输层失败**不**归类成凭据失效：断网不等于号没了。
    return { ok: false, message: `额度查询网络失败：${error instanceof Error ? error.message : String(error)}` };
  }

  let rawText;
  try {
    rawText = await response.text();
  } catch (error) {
    return {
      ok: false,
      message: `额度查询响应读取失败（HTTP ${response.status}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `额度查询失败（HTTP ${response.status}）：${summarizeQoderErrorBody(rawText)}`,
      status: response.status,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, message: `额度查询响应不是 JSON（HTTP ${response.status}）：${summarizeQoderErrorBody(rawText)}` };
  }

  const usage = parseQoderQuotaUsage(parsed);
  if (usage === undefined) {
    // 形态不认识 ⇒ 查不到，**不是**余额 0。
    return { ok: false, message: 'Qoder 额度响应结构无法识别（三池缺失）' };
  }

  return { ok: true, usage, total: qoderQuotaRemainingTotal(usage) };
}

/* ------------------------------------------------------------------ *
 * 批量刷新
 * ------------------------------------------------------------------ */

/**
 * 刷新池里每个账号的额度，并把结果记回号池。
 *
 * 两个刻意的设计：
 *
 * 1. **逐账号串行**，不并发。账号数是个位数，省下的是「被上游当成异常流量」
 *    的风险 —— 并发打同一个 host 的同一端点没有收益。
 * 2. **单个账号失败不影响其它账号**，也**不写余额**。读失败就保持
 *    `credits` 为 `null`（卡片显示「—」而不是「0」），下次刷新再试。
 *
 * 余额写回走 `pool.noteCredits()`，于是「保留额度」判据（`creditReserves`）
 * 立刻拿到新值生效 —— 这正是刷新积分的主要用途。
 *
 * 账号 id 直接取池里的 `account.id`，不另算一份 —— 迭代池自己的账号列表，
 * 保证 `noteCredits` 必然命中（算错 id 会让它因「池里没这个账号」静默不记）。
 *
 * @returns `{ refreshed, failed, accounts: [{ id, ok, total?, message? }] }`
 */
export async function refreshQoderPoolCredits(pool, options = {}) {
  // 迭代**池自己的账号**（而不是重新读盘）：id 与凭据都来自同一份 `scan()`
  // 结果，`noteCredits` 必然命中，不存在「id 算错导致静默不记」的可能。
  const accounts = pool.list();
  const results = [];
  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    const result = await fetchQoderQuotaUsage(account.credential, options);
    if (result.ok) {
      refreshed += 1;
      pool.noteCredits(account.id, result.total);
      results.push({ id: account.id, ok: true, total: result.total, usage: result.usage });
    } else {
      failed += 1;
      results.push({ id: account.id, ok: false, message: result.message });
    }
  }

  return { refreshed, failed, accounts: results };
}