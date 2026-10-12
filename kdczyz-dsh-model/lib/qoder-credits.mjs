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

/** 额度链的 `Cosy-Version`（官方 worker 硬编码 `s5="1.1.64"`）。 */
export const QODER_QUOTA_COSY_VERSION = '1.1.64';

/** 额度链的 `Cosy-ClientType`（官方 `sg()` 默认值 `LZe="5"`）。 */
export const QODER_QUOTA_CLIENT_TYPE = '5';

/**
 * 官方 `noe` —— `Cosy-MachineOS` 的值（worker @3060084 逐字）：
 * `` `${arch}_${platform}` ``，arm64→`aarch64`、x64→`x86_64`。
 *
 * 与 `lib/qoder-fingerprint.mjs` 的 `qoderMachineOs()` 同语义。这里内联一份是
 * 刻意的：本模块是纯控制面（额度/活动），不该因为要加载 33 MB 的 wasm 源码而
 * 被拖慢 —— 一次额度查询没有理由等 wasm 提取。
 */
export function qoderMachineOs(arch = process.arch, platform = process.platform) {
  const mapped = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `${mapped}_${platform}`;
}

/**
 * 出站 User-Agent。
 *
 * ⚠️ **官方额度链不设 UA**：worker 里 `fetchQuotaUsage()` 的 init 只有
 * `{ Accept, Authorization }`（`qoder-worker-runtime.obf.mjs` @19118094），
 * 之后经 `oo()` 包装时也**只补 `Cosy-*`，不补 UA**，最终发出去的是 Node fetch
 * 的默认头（`user-agent: node`）。
 *
 * 所以这个常量**不再用于额度请求**；保留它只为兼容既有导出与测试引用。
 * 想发官方同形的额度请求请用 {@link qoderQuotaHeaders}（它不设 UA）。
 */
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
 * # 官方形态（worker @19118094）
 *
 * ```js
 * fetchWithTrace({ operation:"getQuotaUsage", endpointType:"openapi", method:"GET",
 *   path:"/api/v2/quota/usage", url:`${lu("openapi")}${t}`,
 *   init:{ method:"GET", headers:{ Accept:"application/json",
 *                                  Authorization:`Bearer ${A}` } } })
 * ```
 *
 * `fetchWithTrace` 就是 `oo()`，而 `oo()` 对**所有**请求（只要
 * `injectClientIdentityHeaders !== false`）都补这三个头：
 *
 * ```js
 * pGA(Q,"Cosy-Version", roe);          // "1.1.64"
 * pGA(Q,"Cosy-ClientType", sg().client_type);  // "5"
 * pGA(Q,"Cosy-MachineOS", noe);        // "aarch64_darwin"
 * // Cosy-MachineHostname 只在 requestClass === "infer-sse" 时补 → 额度链不补
 * ```
 *
 * `pGA` 是 **set-if-absent**（大小写不敏感），所以显式传了就不覆盖。
 *
 * # 两处此前的误判（都已按官方改正）
 *
 * 1. **不发 `User-Agent`**：官方不设它，实际发的是 Node fetch 默认头。
 *    此前发 `qoder/1.1.16` 是一个官方客户端产生不出来的形态。
 * 2. **要发 `Cosy-*`**：此前注释判断「quota 线不带 Cosy-ClientType」——
 *    那只对 `init` 里显式写的头成立，`oo()` 包装层照样补。
 *
 * @param {string} bearer 设备令牌
 * @param {object} [machine] `{ machineToken, machineType }`（native 可用时）
 */
export function qoderQuotaHeaders(bearer, machine) {
  const headers = {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    'Cosy-Version': QODER_QUOTA_COSY_VERSION,
    'Cosy-ClientType': QODER_QUOTA_CLIENT_TYPE,
    'Cosy-MachineOS': qoderMachineOs(),
  };
  // 官方 K5A() 的语义：native 拿得到才发这两个（否则整个不发）。
  if (typeof machine?.machineToken === 'string' && machine.machineToken !== '') {
    headers['Cosy-MachineToken'] = machine.machineToken;
    if (typeof machine.machineType === 'string' && machine.machineType !== '') {
      headers['Cosy-MachineType'] = machine.machineType;
    }
  }
  return headers;
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
 * 余额写回走 `pool.noteCredits()`，卡片据此显示每个账号还剩多少 ——
 * 这正是刷新积分的主要用途。（保留额度判据已随「完全手动」删除。）
 *
 * 账号 id 直接取池里的 `account.id`，不另算一份 —— 迭代池自己的账号列表，
 * 保证 `noteCredits` 必然命中（算错 id 会让它因「池里没这个账号」静默不记）。
 *
 * @param options.sinceMs - **新鲜窗口的时长（毫秒）**，可选：「余额是在这个时长
 *        之内读到的就别再读」。号池会连同「读到的时刻」一起记（`pool.creditsAt()`），
 *        本函数据此判断。不传 = 每个账号都真读一次（管理页的「刷新」按钮就该是
 *        这个语义：人点了就该看到新数字）。
 *
 *        刻意收「时长」而不是「时间戳」：时间戳要求调用方自己算 `Date.now() - 窗口`，
 *        看起来一样，但一旦有人传了 `Date.now()`（很自然的手误）就会恒真、
 *        永远跳过 —— 界面上的余额再也不会更新，而且不报任何错。
 * @returns `{ refreshed, failed, skipped, accounts: [{ id, ok, total?, message?, skipped? }] }`
 */
export async function refreshQoderPoolCredits(pool, options = {}) {
  // 迭代**池自己的账号**（而不是重新读盘）：id 与凭据都来自同一份 `scan()`
  // 结果，`noteCredits` 必然命中，不存在「id 算错导致静默不记」的可能。
  const accounts = pool.list();
  const results = [];
  let refreshed = 0;
  let failed = 0;
  /** 已知余额仍然新鲜而**跳过**的账号数（既不是成功也不是失败）。 */
  let skipped = 0;
  const now = Date.now();
  const sinceMs =
    typeof options.sinceMs === 'number' && Number.isFinite(options.sinceMs) && options.sinceMs >= 0
      ? options.sinceMs
      : undefined;
  // 只把**网络层**选项透传给单账号读取：`sinceMs` 是本函数的节流参数，
  // 透传下去会变成无人读取的噪声。
  const fetchOptions = {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.openapiBase === undefined ? {} : { openapiBase: options.openapiBase }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  for (const account of accounts) {
    // 余额够新就跳过：省一次上游调用，且**不覆盖**已显示的数字。
    // `now - creditsAt <= sinceMs`：`creditsAt` 为 0（从没读过）时左边是个
    // 巨大的正数，必然大于窗口 ⇒ 照常真读一次，不会把「从没读过」当成新鲜。
    if (sinceMs !== undefined && now - pool.creditsAt(account.id) <= sinceMs) {
      skipped += 1;
      results.push({ id: account.id, ok: true, skipped: true, total: pool.creditsOf(account.id) });
      continue;
    }
    const result = await fetchQoderQuotaUsage(account.credential, fetchOptions);
    if (result.ok) {
      refreshed += 1;
      // 走 rememberCredits（而不是 noteCredits）才能同时更新「读到的时刻」，
      // 否则下一次显示侧又会因为「从没读过」而重读一遍。
      pool.rememberCredits(account.id, result.total);
      results.push({ id: account.id, ok: true, total: result.total, usage: result.usage });
    } else {
      failed += 1;
      results.push({ id: account.id, ok: false, message: result.message });
    }
  }

  return { refreshed, failed, skipped, accounts: results };
}

/* ------------------------------------------------------------------ *
 * 单账号读取（界面用）
 * ------------------------------------------------------------------ */

/**
 * 「现在是哪个账号在服务请求、它还剩多少」——**界面唯一该读的那个**。
 *
 * ## 三层语义，缺一层就会显示错
 *
 * 1. **谁**：`pool.servingAccount()`。优先取「刚刚真的服务过请求的账号」
 *    （`lastServedId`，含跨实例槽位，所以 provider 池服务过的也算），本进程
 *    还没服务过任何请求时才回退成 `resolveNext()` 的预告。
 *    **刻意不用「固定选中的当前账号」**：那只是「下一次用谁」，与刚刚扣了谁
 *    的额度是两件事（轮换模式下更是完全无关）。
 * 2. **多少**：已知余额够新（`freshMs`）就直接用，**不打上游**；否则读一次并
 *    记回号池。界面上是 30 秒一拍，真读一次的开销必须落在这个窗口上。
 * 3. **读不到**：`credits` 保持 `null`，原因放 `error`。绝不退化成 0 ——
 *    把「读不到」显示成「没有余额」，用户会去删一个本来健康的账号。
 *
 * @param pool - `QoderAccountPool`
 * @param options.now / options.modelId / options.freshMs / options.fetcher
 * @returns `{ accountId, label, source, credits, error, atMs }`
 *   `source`: `'served'`（真被调用过）/ `'next'`（预告下一个）/ `'none'`（池空）
 */
export async function resolveQoderServingCredits(pool, options = {}) {
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const freshMs = Number.isFinite(options.freshMs) ? Math.max(0, options.freshMs) : 0;
  const { account, source } = pool.servingAccount(now, options.modelId);
  if (account === undefined) {
    return { accountId: null, label: '', source: 'none', credits: null, error: null, atMs: 0 };
  }

  let credits = pool.creditsOf(account.id);
  let error = null;
  const stale = credits === undefined || now - pool.creditsAt(account.id) > freshMs;
  if (stale) {
    try {
      const result = await fetchQoderQuotaUsage(account.credential, options);
      if (result.ok) credits = pool.rememberCredits(account.id, result.total, Date.now());
      else error = result.message ?? '额度查询失败';
    } catch (e) {
      error = e?.message ?? String(e);
    }
  }

  return {
    accountId: account.id,
    label: account.label ?? '',
    source,
    credits: typeof credits === 'number' ? credits : null,
    error,
    atMs: pool.creditsAt(account.id) || now,
  };
}