/**
 * 读时刷新（stale-while-revalidate）协调器 —— 三平台共用的「实时目录」骨架。
 *
 * # 为什么需要它
 *
 * 三家的模型目录（含**积分倍率**）都来自上游，插件在内存里缓存一份。DSH 的
 * 聊天选择器每次打开都走
 *
 *   `modelCatalog()` → `llm.listModels()` → `PiAiAdapter` → `pi-ai Models.getModels()`
 *                                                            → provider.getModels()
 *
 * 而 `provider.getModels()` 是**同步**的（pi-ai 的 `Models.getModels()` 直接调它，
 * 见 pi-ai `dist/models.js`）。所以「实时」不可能做成「读的时候同步等上游」——
 * 那会把一个同步接口变成网络阻塞点，而且 `getModels()` 会在一帧里被调用多次
 * （选择器渲染 + 每行 resolveModelInfo）。
 *
 * 本模块给出的语义是 **stale-while-revalidate**：
 *
 *   - 读路径照常立刻拿到当前缓存（永远不阻塞、永远不抛错）；
 *   - 若缓存已过期（距上次**成功**刷新超过 `ttlMs`），顺手在后台打一次上游；
 *   - 上游返回后，**只有内容真的变了**才回调 `onChange`，由调用方去广播
 *     `llm/adapters-updated`（这是 DSH 客户端选择器唯一的失效信号，见下）。
 *
 * # 为什么「变了才广播」很重要
 *
 * DSH 客户端的 `ModelCatalogDirectory` 有自己的快照缓存：`load()` 见到
 * `status === "ready"` 就直接返回旧值，只在收到 `llm/adapters-updated`、
 * `settings/document-updated`、`credentials/record-updated`、
 * `credentials/reference-updated` 这四个事件之一时才 `invalidate()` 重读。
 *
 * 插件这边能主动发的只有 `llm/adapters-updated`（`registerAdapter()` 返回的句柄
 * 上调 `.replace([...])` 会走到 `commitRoutes()` → `emitAdaptersUpdated()`）。
 *
 * 所以「目录变了」必须转成一次 `.replace()`。反过来，**无脑每次都 `.replace()`
 * 是错的**：那会让客户端在每个 TTL 周期都重拉一次 catalog，上游调价但目录没变
 * 的绝大多数轮次都在白抖 UI。签名比较就是为这个而存在。
 *
 * # 失败退避
 *
 * 拉取失败**不更新** `lastOkAtMs`（否则一次偶发 5xx 会把这份陈旧目录"续命"一整个
 * TTL）。但也不能失败后每个读路径都重试 —— 选择器一帧能读十几次。所以失败另记
 * `lastAttemptAtMs`，`retryMs` 内不再重试。
 */

/** 目录视为「新鲜」的默认时长（毫秒）。 */
export const DEFAULT_LIVE_TTL_MS = 60_000;

/** 拉取失败后，多久内不再重试（毫秒）。 */
export const DEFAULT_LIVE_RETRY_MS = 15_000;

/**
 * 算一份目录的**稳定**签名，用于「内容是否真的变了」的判定。
 *
 * 只取会出现在模型名/倍率里的字段，且用数组而非对象（对象键序不保证）；
 * 整条目录按 `id` 排序后再序列化，这样上游若只是调换了条目顺序，不会被误判成
 * 「变了」而触发一次无意义的广播。
 *
 * 倍率字段三家叫法不同（Qoder `priceFactor`、WorkBuddy `multiplier`、
 * Trae `creditMultiplier`），这里一并纳入 —— 只调价、不换模型同样要广播，
 * 否则"实时倍率"就漏了最常见的场景。
 *
 * @param {Array<object>} models 目录（或已过滤的可见模型）
 * @returns {string} 签名；非数组输入返回空串
 */
export function catalogSignature(models) {
  if (!Array.isArray(models)) return '';
  const rows = models.map((model) => {
    if (model === null || typeof model !== 'object') return [];
    const factor =
      model.priceFactor ?? model.multiplier ?? model.creditMultiplier ?? model.consumptionRate;
    return [
      String(model.id ?? ''),
      String(model.name ?? ''),
      factor === undefined || factor === null ? '' : String(factor),
    ];
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(rows);
}

/**
 * 建一个读时刷新协调器。
 *
 * @param {object} options
 * @param {() => Promise<{ok:boolean, signature?:string}|undefined>} options.refresh
 *   打一次上游并**把结果写回调用方自己的目录**，然后返回
 *   `{ ok, signature }`。`ok:false`（含抛错）走失败退避；`signature` 省略表示
 *   "不参与变更比较"（此时视为每次都变）。
 * @param {() => void} [options.onChange] 内容变化时的回调（广播适配器更新）。
 * @param {(error:unknown) => void} [options.onError] 刷新失败回调（日志）。
 * @param {number} [options.ttlMs] 新鲜期，默认 {@link DEFAULT_LIVE_TTL_MS}。
 * @param {number} [options.retryMs] 失败退避，默认 {@link DEFAULT_LIVE_RETRY_MS}。
 * @param {() => number} [options.now] 时钟注入（测试用）。
 * @returns {{ensureFresh:()=>Promise<any>, markFresh:(s?:string)=>void, isFresh:()=>boolean, lastOkAtMs:()=>number, signature:()=>string|undefined, dispose:()=>void}}
 */
export function createLiveRefresher(options) {
  const ttlMs =
    typeof options.ttlMs === 'number' && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_LIVE_TTL_MS;
  const retryMs =
    typeof options.retryMs === 'number' && options.retryMs >= 0
      ? options.retryMs
      : DEFAULT_LIVE_RETRY_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const refresh = options.refresh;
  const onChange = options.onChange;
  const onError = options.onError;

  /** 上次**成功**刷新的时刻；0 = 从未成功过（此时目录是种子或兜底）。 */
  let lastOkAtMs = 0;
  /** 上次**尝试**刷新的时刻（无论成败），用于失败退避。 */
  let lastAttemptAtMs = 0;
  /** 上次成功刷新的内容签名。 */
  let currentSignature;
  /** 进行中的刷新；同刻只打一次上游。 */
  let inflight;
  let disposed = false;

  const isFresh = () => lastOkAtMs > 0 && now() - lastOkAtMs < ttlMs;

  /** 失败退避窗口内（上次尝试发生在上次成功之后，且还没过 retryMs）。 */
  const isBackingOff = () =>
    lastAttemptAtMs > lastOkAtMs && now() - lastAttemptAtMs < retryMs;

  /**
   * 若目录已过期（且不在失败退避里），在后台打一次上游。
   *
   * **不阻塞、不抛错**：调用方（`getModels()` 这类同步读路径）直接忽略返回值。
   * 返回 promise 只是为了让测试能 await 到刷新完成。
   *
   * @returns {Promise<any>|undefined} 本次触发的刷新；未触发时为 `undefined`
   */
  const ensureFresh = () => {
    if (disposed || inflight !== undefined) return inflight;
    if (isFresh() || isBackingOff()) return undefined;
    lastAttemptAtMs = now();
    let task;
    task = Promise.resolve()
      .then(() => refresh())
      .then(
        (result) => {
          if (disposed) return result;
          if (result === undefined || result.ok !== true) return result;
          lastOkAtMs = now();
          const next = result.signature;
          // 签名缺失 = 调用方不参与比较，按"每次都可能变"处理（保守但正确）。
          if (next === undefined || next !== currentSignature) {
            currentSignature = next;
            try {
              onChange?.(result);
            } catch (error) {
              onError?.(error);
            }
          }
          return result;
        },
        (error) => {
          // 失败已记入 lastAttemptAtMs，这里只报出去 —— 绝不向读路径抛。
          try {
            onError?.(error);
          } catch {
            /* 日志失败不该反过来影响目录 */
          }
          return undefined;
        },
      )
      .finally(() => {
        if (inflight === task) inflight = undefined;
      });
    inflight = task;
    return task;
  };

  /**
   * 外部已知目录是最新的（例如启动种子刚拉完、手动刷新刚成功），
   * 直接把它标成新鲜并记下签名，避免立刻又打一次上游。
   *
   * @param {string} [signature] 目录签名；省略表示只更新时间戳
   */
  const markFresh = (signature) => {
    lastOkAtMs = now();
    if (signature !== undefined) currentSignature = signature;
  };

  return {
    ensureFresh,
    markFresh,
    isFresh,
    lastOkAtMs: () => lastOkAtMs,
    signature: () => currentSignature,
    dispose: () => {
      disposed = true;
    },
  };
}
