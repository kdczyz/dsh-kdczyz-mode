/**
 * Qoder 模型目录。
 *
 * # 为什么必须有静态兜底
 *
 * DSH 会因为 `INVALID_MODEL_CONTEXT` **拒掉整个 provider**，而且判据是
 * **per-provider 的** —— 一行模型没有可用的 `contextWindow`，整个 region 下线
 * （`lib/trae.js` 的注释原文：one bad row takes the whole region offline）。
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
  buildQoderModelsRequest,
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
 * 这张表在 2026-10-11 用真机目录**校准过**：此前填的是显示名（旧版按公开资料
 * 猜的），已全部改成真实的 `key`。上下文窗口也按真机的 `max_input_tokens` 填。
 * 只要上游目录能拉到，就**以拉取结果为准**，本表完全不参与；它只在拉取失败时
 * 让 provider **不至于下线**，而不是假装这些模型一定可用。
 */
export const QODER_FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 200000 },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 180000 },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 180000 },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 96000 },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 180000 },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1000000 },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 180000 },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 180000 },
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 180000 },
];

/** 给条目补上 DSH 要求的必填字段。 */
function withRequirements(entry) {
  return {
    ...entry,
    contextWindow: entry.contextWindow ?? QODER_FALLBACK_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? QODER_FALLBACK_MAX_TOKENS,
  };
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

  constructor(options = {}) {
    this.fetcher = options.fetcher;
    this.base = options.base ?? QODER_CN_CHAT_BASE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
   * 从上游拉一次目录。
   *
   * @param {object} credential 号池账号的凭据（需含 `userId` 与 `accessToken`）
   * @returns {Promise<{ok:boolean, models:Array, message?:string}>}
   */
  async refresh(credential) {
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
      const request = buildQoderModelsRequest({ identity: identity, base: this.base });
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
        // 拉到了但解析不出条目 —— 形状变了。**保留旧目录**而不是清空，
        // 同样是「不要让 provider 下线」。
        this.#lastError = '目录响应里没有可识别的模型条目（上游形状可能已变）';
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
