/**
 * Qoder 模型目录。
 *
 * # 为什么必须有静态兜底
 *
 * DSH 对每一行模型都要求一个正整数 `contextWindow`（判据在宿主的
 * `normalizeModelInfo`：`INVALID_MODEL_CONTEXT`），拿不到窗口的那一行**自己**
 * resolve 失败。它不会让整个 provider 下线（pi-ai 有
 * `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow`
 * 三级兜底，本 provider 也设了 `defaultContextWindow`），但一行坏掉就是一行
 * 用不了。
 *
 * 于是目录有两条硬规则：
 *
 * 1. **每一条都必须带正整数 `contextWindow`**，拿不到就用兜底值；
 * 2. **拉取失败时绝不返回空数组**。空数组 = provider 没有模型 = 直接下线，
 *    比「列少了几个模型」严重得多。所以拉不到就回落到静态兜底。
 *
 * # 目录的两条链（按令牌族分派）
 *
 * | 令牌族 | 端点 | 签名 |
 * |---|---|---|
 * | `pt-`（PAT） | `api.qoder.com.cn/api/v1/cloud/models` | 否 |
 * | `dt-`（本插件入池凭据） | `gateway.qoder.com.cn/algo/api/v2/model/list` | **是** |
 *
 * 本插件只有 `dt-`，所以走签名链（见 `buildQoderModelsRequest`）。
 *
 * @module
 */

import {
  QODER_CN_CHAT_BASE,
  buildQoderFingerprintedModelsRequest,
  buildQoderModelsRequest,
  classifyQoderRelayFailure,
  parseQoderModelList,
  qoderIdentityOf,
  sendQoderRequest,
} from './qoder-relay.mjs';

/**
 * 兜底上下文窗口。
 *
 * 与 Trae 侧同值（`FALLBACK_TRAE_MODELS` 每条都带）。它是**保底**而非真实值：
 * 真实窗口应从上游目录取。缺这个值 provider 会整个下线，所以宁可给一个保守的
 * 大值也不能不给。
 */
export const QODER_FALLBACK_CONTEXT_WINDOW = 2e5;

/** 兜底最大输出。同样是保底，真实值应来自目录。 */
export const QODER_FALLBACK_MAX_TOKENS = 32_000;

/**
 * 静态兜底目录（CN）。
 *
 * ⚠️ **id 必须是上游的 `key`**（如 `qmodel_38max`），不是显示名
 * （`Qwen3.8-Max`）—— 前者才是请求参数，拿显示名发请求是 404。
 *
 * 这张表在 2026-10-11 用真机目录**校准过**：`id`、`name`、`contextWindow`
 * （取 `max_input_tokens`）与 **`supportsImages`（取 `is_vl`）** 全部按真机
 * `chat` 组填写，14 行一个不少 —— 表比真机少行时，首拉失败的用户会看不到
 * 那些模型（此前只有 9 行，缺 `qmodel_latest` / `qmodel` / `q37fmodel` /
 * `gm51model` / `kmodel`）。
 *
 * 只要上游目录能拉到，就**以拉取结果为准**，本表完全不参与；它只在拉取失败时
 * 让 provider **不至于下线**，而不是假装这些模型一定可用。
 */
export const QODER_FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 200000, supportsImages: true },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 180000, supportsImages: true },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 180000, supportsImages: true },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 180000, supportsImages: true },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 180000, supportsImages: true },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 180000, supportsImages: true },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 96000, supportsImages: true },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 180000, supportsImages: true },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 180000, supportsImages: true },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1000000, supportsImages: true },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 180000, supportsImages: true },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 180000, supportsImages: true },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 180000, supportsImages: true },
  // 唯一的纯文本模型：真机 `is_vl: false`。**不要**顺手改成 true。
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 180000, supportsImages: false },
];

/**
 * 给条目补上 DSH 要求的必填字段，并把能力位归一成**严格布尔**。
 *
 * `supportsImages` 归一成布尔（缺失 = 纯文本）而不是保留 `undefined`：目录是
 * 「这张表能不能收图」的唯一事实来源，下游的 `toPiModel.input` 与 discovery 的
 * `inputModalities` 都直接读它，留 `undefined` 会让两处各自解释。
 */
function withRequirements(entry) {
  return {
    ...entry,
    contextWindow: entry.contextWindow ?? QODER_FALLBACK_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? QODER_FALLBACK_MAX_TOKENS,
    supportsImages: entry.supportsImages === true,
  };
}

/**
 * 分隔符 —— 与 WorkBuddy（`DISPLAY_SEPARATOR`）逐字同值，保证三家 provider
 * 的模型名后缀肉眼一致。用 ` · `（带空格的中点）而不是模型名自身可能带的中杠
 * 或点号，避免歧义。
 */
export const QODER_DISPLAY_SEPARATOR = ' · ';

/**
 * 把一个积分倍率格式成后缀碎片（不含分隔符）。
 *
 * 对齐官方 Qoder 客户端的 `formatFactor`（`index-nRmb_3VI.js` reverse 结果）：
 *
 *   - 整数直接转字符串（`1` → `"1"`，避免 `"1.00"` 的啰嗦）；
 *   - 非整数 `toFixed(2)` 再去尾 0 和尾点（`0.80` → `"0.8"`，`1.62` → `"1.62"`）。
 *
 * `priceFactor === 0` 是官方对「免费/限时免费」（`LIMITED_TIME_FREE_MODEL_TAG`）
 * 的拼写，后缀给「免费」而不是 `x0`，与模型名分开、可读性更好。
 *
 * @param {number} factor
 * @returns {string|undefined} 后缀碎片；非有限数返回 `undefined`
 */
export function qoderFactorSuffix(factor) {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return undefined;
  if (factor === 0) return '免费';
  const text = Number.isInteger(factor)
    ? String(factor)
    : factor.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `x${text}`;
}

/**
 * 模型的 DSH 显示名：名称后面接积分倍率后缀（如 `Qwen3.8-Max · x0.8`）。
 *
 * `priceFactor` 是**纯展示**字段：它不参与任何请求参数（wire 用 `id`），只决定
 * 用户在看到模型名时知道「每一积分的消耗倍率」。这与 WorkBuddy 的
 * `withCatalogDisplay`、Trae 的 `traeModelDisplayName` 同一套路。缺失（上游没给）
 * 时保持原名 —— 不虚构数值，与 Trae ai 版不显示倍率的语义一致。
 */
export function qoderModelDisplayName(model) {
  const base = model?.name ?? model?.id;
  if (typeof base !== 'string' || base === '') return base;
  const suffix = qoderFactorSuffix(model?.priceFactor);
  return suffix === undefined ? base : `${base}${QODER_DISPLAY_SEPARATOR}${suffix}`;
}

/**
 * 模型能否收图 —— **全链路唯一的判据**。
 *
 * ⚠️ `toPiModel`（推理链）与 `registerModelDiscovery`（DSH 目录）必须共用它。
 * Trae 半边就是靠这个函数收敛了同一个坑（`traeInputModalities`）；Qoder 此前
 * 在两处各写一个字面量 `['text']`，图片能力因此永远无法生效。
 */
export function qoderInputModalities(model) {
  return model?.supportsImages === true ? ['text', 'image'] : ['text'];
}

/**
 * 号池目录。
 *
 * `fetcher` 可注入（测试用）。拉取**永不抛错**：所有失败都回落到兜底并返回
 * `ok:false`，让调用方知道「这次用的是兜底」而不必 try/catch —— 目录失败不该
 * 影响 provider 注册。
 */
export class QoderCatalog {
  #models = QODER_FALLBACK_MODELS.map(withRequirements);
  #usingFallback = true;
  #lastError = undefined;
  #lastFetchAtMs = 0;
  /** 同刻只跑一次上游请求（见 `refresh`）。 */
  #inflight = undefined;

  constructor(options = {}) {
    this.fetcher = options.fetcher;
    this.base = options.base ?? QODER_CN_CHAT_BASE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    /**
     * 官方指纹器（可选注入）。
     *
     * 可以是**指纹对象**，也可以是返回它的**函数**（`qoder.js` 传的是懒加载
     * 函数：本机没装 Qoder 时首次解析得到 `undefined`，不该把这件事永久钉死）。
     *
     * 有它就走官方同形的目录请求（`Encode=1` + `auth` 签名 + `oo()` 的
     * `Cosy-*` 头），没有就用早期探测出来的那条（也能取到目录，只是不同形）。
     */
    this.fingerprint = options.fingerprint;
    /** 机器 id 取值器（与登录同一个）。指纹路径需要，手写路径不需要。 */
    this.machineId = options.machineId;
  }

  /** 当前目录。**永不为空** —— 空目录会让 provider 下线。 */
  current() {
    return this.#models.length > 0 ? this.#models : QODER_FALLBACK_MODELS.map(withRequirements);
  }

  usingFallback() {
    return this.#usingFallback;
  }

  lastError() {
    return this.#lastError;
  }

  /**
   * 上次**成功**拉取的时间戳（毫秒），从未成功过则为 `0`。
   *
   * 管理页用它显示「目录是刚拉的还是兜底的」。
   */
  lastFetchAtMs() {
    return this.#lastFetchAtMs;
  }

  /**
   * 解析指纹器实例。
   *
   * 注入的可能是对象，也可能是返回它的函数（懒加载）。解析失败一律当
   * 「没有指纹器」处理 —— 调用方据此退回手写路径。
   */
  async #resolveFingerprint() {
    const raw = this.fingerprint;
    if (raw === undefined || raw === null) return undefined;
    try {
      const value = typeof raw === 'function' ? await raw() : raw;
      return value !== undefined && value !== null ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 解析指纹路径要用的 machine id。
   *
   * 与登录共用同一个值（`~/.qoder-cn/.auth/machine_id`）。拿不到就返回
   * `undefined`，此时 `buildQoderFingerprintedModelsRequest` 会返回
   * `undefined`，调用方自动退回手写路径 —— **不让目录拉取因为机器 id 缺失而失败**。
   */
  async #resolveMachineId() {
    if (typeof this.machineId !== 'function') return undefined;
    try {
      const value = await this.machineId();
      return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从上游拉一次目录（同刻只打一次上游）。
   *
   * # 为什么要合并并发
   *
   * 现在有**三个**触发点会拉目录：启动种子、登录成功后的补拉、管理页的手动
   * 刷新。它们完全可能撞在同一刻（用户登录完顺手点刷新、或页面加载即触发）。
   * 不合并的后果不只是浪费一次请求 —— 两个请求返回顺序无法保证，
   * **先发的慢响应会把后发的快响应用旧数据覆盖掉**。
   *
   * 与 WorkBuddy 半边的 `modelRefreshInflight`（`lib/index.js`）同款：后来的
   * 调用直接复用进行中的 promise。它不抛错（见 `#refreshOnce`），所以复用是安全的。
   *
   * @param {object} credential 号池账号的凭据（需含 `userId` 与 `accessToken`）
   * @returns {Promise<{ok:boolean, models:Array, message?:string}>}
   */
  async refresh(credential) {
    if (this.#inflight !== undefined) return this.#inflight;
    const task = this.#refreshOnce(credential).finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = task;
    return task;
  }

  /**
   * 真正打上游的那一次。**永不抛错** —— 所有失败都回落成 `ok:false`。
   */
  async #refreshOnce(credential) {
    const identity = qoderIdentityOf(credential);
    if (identity === undefined) {
      // uid / 令牌拿不到就没法签名。这**不是**目录的问题，回落兜底但不覆盖
      // 已有目录 —— 一次登录态抖动不该让目录倒退。
      this.#lastError = '凭据不完整（缺 userId 或 accessToken），无法签名拉取目录';
      return { ok: false, models: this.current(), message: this.#lastError };
    }
    // 目录链是 **GET + `{}` body**，Node 的 `fetch` 禁止 GET 带 body，所以走
    // 本模块自己的 http 发送器（`fetcher` 只保留给测试注入）。
    const send =
      typeof this.fetcher === 'function'
        ? async ({ url, method, headers, body, timeoutMs }) => {
            const response = await this.fetcher(url, {
              method,
              headers,
              body,
              signal: AbortSignal.timeout(timeoutMs),
            });
            return { status: response.status, text: await response.text() };
          }
        : sendQoderRequest;

    try {
      // 指纹优先：与官方客户端同形（`Encode=1` + `auth` 签名 + `oo()` 的
      // `Cosy-*` 头）。指纹器不可用（没装 Qoder）时才退回早期探测那条。
      //
      // ⚠️ 指纹链**会抛错**（wasm 提取/实例化失败、版本不匹配等，
      // `qoder-fingerprint.mjs` 的 `prepareRequest failed`），而 `??` 只兜
      // `undefined`。不套 try 的话一次指纹故障就把整轮目录拉取带走 —— 而手写
      // 链是实测可用的（真机 HTTP 200），没有任何理由不用它。
      const resolvedFingerprint = await this.#resolveFingerprint();
      const machineId = await this.#resolveMachineId();
      let request;
      try {
        request = buildQoderFingerprintedModelsRequest({
          fingerprint: resolvedFingerprint,
          machineId,
          uid: credential?.userId ?? credential?.uid,
          securityToken: identity.securityToken,
          base: this.base,
        });
      } catch {
        request = undefined;
      }
      request ??= buildQoderModelsRequest({ identity: identity, base: this.base });
      const { status, text } = await send({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs: this.timeoutMs,
      });
      if (status !== 200) {
        this.#lastError = `目录端点返回 HTTP ${status}`;
        return { ok: false, models: this.current(), message: this.#lastError };
      }
      const models = parseQoderModelList(text);
      if (models.length === 0) {
        // 拉到了但解析不出条目。先分清是**谁的**问题：签名/登录态失效（用户能
        // 自己修：重新登录）与上游形状变了（只能等插件适配）在排查上完全是两个
        // 方向，混成一句话会把人带偏。上游的业务错误是「HTTP 200 + 信封里
        // code:101」，只判状态码看不出任何东西。
        const { kind } = classifyQoderRelayFailure({ status, body: text });
        this.#lastError =
          kind === 'signature' || kind === 'session_dead'
            ? `目录端点拒绝了本次请求（${kind}）：登录态可能已过期，请重新登录 —— ${text.slice(0, 200)}`
            : kind === 'hard_credit'
              ? `目录端点报告额度/配额问题（${kind}）—— ${text.slice(0, 200)}`
              : '目录响应里没有可识别的模型条目（上游形状可能已变）';
        return { ok: false, models: this.current(), message: this.#lastError };
      }
      this.#models = models.map(withRequirements);
      this.#usingFallback = false;
      this.#lastError = undefined;
      this.#lastFetchAtMs = Date.now();
      return { ok: true, models: this.#models };
    } catch (e) {
      this.#lastError = e?.message ?? String(e);
      // ⚠️ **失败时绝不清空 `#models`**：空目录 = provider 没有模型 = 直接下线。
      // 网络抖一下就把整个 Qoder provider 干掉是不可接受的。保留旧目录（首次
      // 则保留兜底），并把「这次失败了」如实告诉调用方。
      return { ok: false, models: this.current(), message: this.#lastError };
    }
  }
}
