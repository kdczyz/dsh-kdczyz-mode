/**
 * Qoder 半边：cordis Loader 入口。
 *
 * # 为什么是**第三个独立入口**
 *
 * `cordis.patch.yml` 的注释说明了两半必须分开的原因，Qoder 同样适用：
 * cordis 按 `apply` 函数的**引用同一性**登记 runtime，`Config` 挂在 runtime 上。
 * 若 Qoder 复用 `lib/index.js` 或 `lib/trae.js`，就会与那一半共享一个 Config，
 * `enabledModelIds` 之类同名字段会互相抢值。所以本文件必须是一个**独立模块**。
 *
 * # 架构：本地 loopback shim + pi-ai
 *
 * 与 Trae 半边同构：
 *
 *   DSH → pi-ai 的 OpenAI 客户端 → http://127.0.0.1:<port>/v1/chat/completions
 *      → shim → 号池取号 → COSY 签名 → Qoder 上游 → 解信封 → 标准 OpenAI SSE
 *
 * 分层的意义：**pi-ai 负责 OpenAI 协议，shim 负责号池与 Qoder 私有协议**。
 *
 * # 状态：**已接通推理**（2026-10-11）
 *
 * shim、目录、注册、签名、解信封、失败回灌全部就绪，且走通了真机端到端：
 * 请求从 shim 进 → 取号 → COSY 签名 → 上游 → 解双层信封 → 标准 OpenAI SSE
 * 回给 pi-ai。
 *
 * 早期版本卡在「官方自定义 Base64 编码器（在 wasm 里，拿不到）」，并据此返
 * 501。真机实测推翻了那个前提：**查询串不带 `Encode` 时明文 body 直接被接受**，
 * 官方编码器不再是接通推理的必要条件。详见 `lib/qoder-relay.mjs` 的模块注释。
 */

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { QoderCatalog, QODER_FALLBACK_CONTEXT_WINDOW } from './qoder-catalog.mjs';
import { readOrCreateQoderMachineId } from './qoder-auth.mjs';
import { createQoderFingerprint } from './qoder-fingerprint.mjs';
import { QoderAccountPool, QoderCredentialStore } from './qoder-pool.mjs';
import { createQoderShim } from './qoder-shim.mjs';
import {
  applyQoderRelayFailure,
  buildQoderChatRequest,
  buildQoderFingerprintedRequest,
  classifyQoderRelayFailure,
  isQoderDoneFrame,
  qoderIdentityOf,
  streamQoderRequest,
  unwrapQoderFrame,
} from './qoder-relay.mjs';

const name = 'dsh-connect-qoder';
const inject = ['llm'];

/**
 * DSH 主目录（与 lib/index.js 的 `dshHomeDir` 同口径）。
 *
 * 设备流登录把凭据落在 `${dshHome}/.qoder-auth.cn.<id>.json`；provider 侧的号池
 * 必须用**同一个** dshHome 才扫得到。口径只有一条：`DSH_HOME` 环境变量，没有
 * 就 `~/.dsh`。这里不 import `@deepseek-ai/dsh-home-paths`（那是宿主内包，裸
 * import 在单测/独立脚本里解析不到），直接按同一约定实现。
 */
function qoderDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env;
  return join(homedir(), '.dsh');
}

/**
 * provider id。
 *
 * ⚠️ **一旦选定不可改名**：已保存的 settings 挂在 entry id 上，改名会让设置卡
 * 变成只读（同 Trae 的 `dsh-connect-trae`）。
 */
const QODER_PROVIDER = 'qoder';
const QODER_SETTINGS_NS = 'qoder';
const QODER_STREAM_IDLE_TIMEOUT_MS = 3e5;

const Config = z.object({
  enabledModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number()).default({}),
});

/**
 * 0.1.7 起宿主按 **Loader entry id** 作 settings 键。
 *
 * 若这里 advertise 裸 `qoder` 而宿主实际是 `include:dsh-...`，provider 会读成
 * "not configured" 且 **model discovery 静默失效**（Trae 侧的注释原文）。
 */
function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id;
  return typeof id === 'string' && id !== '' ? id : QODER_SETTINGS_NS;
}

/** 目录 → pi-ai 的模型形状。`contextWindow` 是硬性必填。 */
function toPiModel(model, baseUrl, providerId) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    // ⚠️ 缺这一行 DSH 会以 INVALID_MODEL_CONTEXT 拒掉**整个 provider**
    contextWindow: model.contextWindow ?? QODER_FALLBACK_CONTEXT_WINDOW,
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  };
}

/**
 * 取出信封里的第一段 `body`（用于「200 但业务失败」的嗅探）。
 *
 * 只做一次轻量扫描，不建流 —— 真转换在 `sseStreamOf`。
 */
function extractInnerBody(text) {
  const match = /^data:(.+)$/m.exec(text ?? '');
  if (match === null) return undefined;
  try {
    const frame = unwrapQoderFrame(JSON.parse(match[1]));
    return frame.kind === 'inner' ? frame.inner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 嗅探「HTTP 200 但业务失败」。
 *
 * # 为什么必须有这一步（真机实测，2026-10-11）
 *
 * 上游把业务错误塞在**信封内部**，外层 HTTP 状态码仍是 **200**：
 *
 * ```
 * HTTP/1.1 200 OK
 * content-type: text/event-stream
 *
 * data:{"headers":{…},"body":"{\"code\":\"400\",
 *       \"message\":\"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null\"}",
 *       "statusCodeValue":400,"statusCode":"BAD_REQUEST"}
 * ```
 *
 * 只看 HTTP 状态会把它当成功；而把这段透传给 pi-ai，客户端收到的是
 * `{code,message}` 而不是 `{choices:[…]}`，于是**表现为「模型没有回复」且不报错**
 * —— 排查时完全看不出是上游拒绝。
 *
 * # 判据
 *
 * 认两个信号，任一命中即算业务失败：
 *
 *   1. 外层信封的 `statusCodeValue >= 400`（最可靠，上游自己标的）；
 *   2. 内层是 `{code, message}` 形状且 `code` 非 0（兼容没标 statusCodeValue 的帧）。
 *
 * ⚠️ **不要**把「内层没有 `choices`」当失败判据：正常流的收尾帧、以及
 * `event:finish` 的统计帧都没有 `choices`，那样判会把成功也判成失败。
 *
 * @returns {{status:number, code:string, message:string}|undefined}
 */
function detectBusinessError(text) {
  const raw = text ?? '';
  // 逐帧扫（真机错误流通常只有 1 帧，但不要假设）
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let outer;
    try {
      outer = JSON.parse(payload);
    } catch {
      continue;
    }
    const frame = unwrapQoderFrame(outer);
    if (frame.kind !== 'inner') {
      // 没有完整信封（缺 statusCodeValue 的旧版/变体形状）：仍要能认出内层
      // `{code,message}` —— 上游的「签名无效 / 额度不足」就长这样，漏判会把它
      // 当正常帧透传，客户端收到一个没有 choices 的对象。
      const maybeInner = typeof outer?.body === 'string' ? outer.body : undefined;
      if (maybeInner !== undefined) {
        let obj;
        try {
          obj = JSON.parse(maybeInner);
        } catch {
          continue;
        }
        if (obj !== null && typeof obj === 'object' && !Array.isArray(obj.choices)) {
          const c = obj.code;
          if (c !== undefined && c !== null && String(c) !== '0') {
            return {
              status: 400,
              code: String(c),
              message: typeof obj.message === 'string' ? obj.message : JSON.stringify(obj).slice(0, 300),
            };
          }
        }
      }
      continue;
    }

    const status = typeof frame.status === 'number' ? frame.status : 0;
    let inner;
    try {
      inner = JSON.parse(frame.inner);
    } catch {
      // 内层不是 JSON：只有外层状态码能判
      if (status >= 400) {
        return { status, code: String(status), message: frame.inner.slice(0, 300) };
      }
      continue;
    }
    if (inner === null || typeof inner !== 'object') continue;

    const hasChoices = Array.isArray(inner.choices);
    const code = inner.code;
    const codeBad = code !== undefined && code !== null && String(code) !== '0';
    if (status >= 400 || (codeBad && !hasChoices)) {
      return {
        status: status >= 400 ? status : 400,
        code: code === undefined ? String(status) : String(code),
        message: typeof inner.message === 'string' ? inner.message : JSON.stringify(inner).slice(0, 300),
      };
    }
    // 首帧是正常 choices —— 有正文可发，直接判成功
    if (hasChoices) return undefined;
  }
  return undefined;
}

/**
 * 把 Qoder 的**双层信封 SSE** 转成标准 OpenAI SSE。
 *
 * 上游每一帧是：
 *
 *   data:{"headers":{…},"body":"{\"choices\":[…]}","statusCodeValue":200,…}
 *
 * 内层 `body` 是**被转义成字符串的 JSON**，要再 parse 一次取出后原样吐出；
 * `[DONE]` 也在信封里（`"body":"[DONE]"`），要还原成裸哨兵。
 *
 * ⚠️ 还要**丢掉 `event:finish` 那一帧**：上游在 `[DONE]` 之后又发
 * `event:finish` + 一段 `{"firstTokenDuration":…}` 的 data，那不是 OpenAI 协议
 * 里的东西，透传过去 pi-ai 会拿它当 chat chunk 解析而报错。
 *
 * 返回 Web `ReadableStream`（shim 侧按 `body.pipeTo` / `getReader` 消费）。
 */
function sseStreamOf(upstreamText) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const lines = String(upstreamText ?? '').split('\n');
      let inFinish = false;
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        // `event:` 行只在 finish 时出现；进入 finish 段后不再输出任何 data
        if (line.startsWith('event:')) {
          inFinish = line.slice('event:'.length).trim() === 'finish';
          continue;
        }
        if (inFinish) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '') continue;
        let inner;
        try {
          const frame = unwrapQoderFrame(JSON.parse(payload));
          if (frame.kind !== 'inner') continue;
          inner = frame.inner;
        } catch {
          // 不是信封（或不是 JSON）—— 丢掉而不是原样透传：上游的裸帧形状与
          // OpenAI 不一致，透传只会让客户端解析失败。
          continue;
        }
        if (isQoderDoneFrame(inner)) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          continue;
        }
        controller.enqueue(encoder.encode(`data: ${inner}\n\n`));
      }
      controller.close();
    },
  });
}

/**
 * 把一个**逐帧推送**的上游流，转成 Web `ReadableStream` 交给 shim。
 *
 * 与 `sseStreamOf` 的转换规则**完全一致**（信封解包、`[DONE]` 还原、
 * 丢弃 `event:finish`），区别只在于帧是**边到边转** —— 首字节不再等整段回复。
 *
 * 这是流式能真正生效的关键一环：`streamQoderRequest` 逐帧回调进来，
 * 这里立刻 `enqueue`，shim 侧 `getReader()` 随即 `res.write()` 出去。
 */
function bridgeStream() {
  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    /** 推一帧内层 JSON 文本（规则与 sseStreamOf 相同）。 */
    push(inner) {
      if (closed || controller === undefined) return;
      if (isQoderDoneFrame(inner)) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        return;
      }
      controller.enqueue(encoder.encode(`data: ${inner}\n\n`));
    },
    /**
     * 中途出错：让**已经开始**的流以 `error` 结束，而不是静默 close。
     *
     * 响应头此时已经发出去了（200），改不了状态码；但让流 error 能让
     * pi-ai 明确知道自己收到的是一次失败，而不是「上游回了个空回答」。
     */
    fail(reason) {
      if (closed || controller === undefined) return;
      closed = true;
      controller.error(new Error(reason));
    },
    close() {
      if (closed || controller === undefined) return;
      closed = true;
      controller.close();
    },
  };
}

/**
 * 一个可外部 resolve 的 promise —— 用于「等首帧判定」这种
 * 「promise 由回调触发、而不是由 await 的调用点触发」的场景。
 *
 * `resolve` 必须容错重复调用：`onFirstFrame`（正常路径）与
 * `streaming.then/catch`（收尾路径）都可能先到，先到的生效。
 */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  let settled = false;
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
  };
}

function createQoderAdapter(options) {
  const providerId = options.provider ?? QODER_PROVIDER;
  const providerName = options.displayName ?? 'Qoder';
  const buildModels = () =>
    options.catalog.current().map((m) => toPiModel(m, `${options.shim.baseUrl()}/v1`, providerId));

  const provider = {
    ...createProvider({
      id: providerId,
      name: providerName,
      auth: {
        apiKey: {
          name: 'Qoder loopback secret',
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'Qoder loopback' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    defaultContextWindow: QODER_FALLBACK_CONTEXT_WINDOW,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);

  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: { kind: 'none' },
      // shim 的随机 secret —— 每次启动都变，不落盘
      resolveApiKey: async () => options.shim.token(),
    }),
    invalidate() {
      profiles = new Map([[providerId, profile]]);
    },
  };
}

function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx);
  const catalog = new QoderCatalog({});
  const registration = { adapter: undefined, directory: undefined };

  // 池与 shim 都是本入口自己的实例：不跨入口共享，避免生命周期耦合。
  //
  // ⚠️ `dshHome` **必须显式传**（与 lib/index.js 管理页同一个口径 `DSH_HOME ?? ~/.dsh`）。
  // 漏传时 `QoderCredentialStore.readAll()` 会因为 dshHome 为空串而直接返回 `[]`，
  // 表现为「管理页能看到已登录账号、但 provider 每次取号都空、模型永远跑不通」。
  // 这是真机踩过的：登录落盘在 `~/.dsh/.qoder-auth.cn.*.json`，只有给了正确
  // dshHome，provider 侧的池才扫得到它们。
  const pool = new QoderAccountPool({
    store: new QoderCredentialStore({ dshHome: qoderDshHome() }),
  });

  let shim;
  let disposed = false;

  /**
   * 官方指纹器（懒加载，全局一份）。
   *
   * 首次转发时从本机 Qoder 安装里提取官方 wasm 并实例化。提取一次就够，
   * 之后复用 —— 33 MB 的源码只读一次，wasm 也只实例化一次。
   *
   * `undefined` 表示本机没有官方安装（或提取失败），此时退回手写 COSY。
   * **不因此失败**：明文那条路是实测可用的，只是与官方客户端不同形。
   */
  let fingerprintPromise;
  const fingerprint = () => {
    if (fingerprintPromise === undefined) {
      fingerprintPromise = createQoderFingerprint().catch(() => undefined);
    }
    return fingerprintPromise;
  };

  /**
   * 取本机 machine_id。
   *
   * 与登录共用同一个值（`~/.qoder-cn/.auth/machine_id`）：指纹里的
   * `Cosy-MachineId` / `Cosy-MachineToken` 必须与官方登录身份一致，
   * 否则就是「同一个账号在不同机器上」的可疑形态。
   */
  let machineIdPromise;
  const machineId = () => {
    if (machineIdPromise === undefined) {
      machineIdPromise = readOrCreateQoderMachineId().catch(() => undefined);
    }
    return machineIdPromise;
  };

  /**
   * 转发一次对话：取号 → 签名 → 打上游 → 解信封 → 转标准 OpenAI SSE。
   *
   * 失败按 `applyQoderRelayFailure` 回灌号池（限流冷那个模型、额度耗尽停那个
   * 账号），并对**值得换号**的 kind 重试一次别的账号 —— 与 Trae 侧同款。
   * 签名类失败刻意不换号：同一个签名 bug 换谁都一样，惩罚只会把整个池冷掉。
   */
  /**
   * 「同一个请求刚刚因**确定性原因**失败过」的短时记忆。
   *
   * # 为什么要这个（真机观测，2026-10-11）
   *
   * 一次工具轮的失败在日志里是这样：DSH 侧 `llm/retry` **6 次**，间隔按
   * 指数退避递增（1s → 1.4s → 2.5s → 4.7s → 9s），而本插件对每次进来又
   * 最多换号重试 **3 次** —— 同一个 body 最多打上游 **18 次**。
   *
   * 关键事实：**请求体完全相同时，业务类失败是确定性的**。
   * 实测那次 `Messages with role 'tool' must be a response to…` 的 6 次请求
   * body-hash 完全相同（`79bab6b97c7bc925`），6 次全部失败，一次都没成功。
   * 也就是说后续 17 次调用是纯粹的浪费 —— 既拖慢报错，又白烧上游配额。
   *
   * # 只对确定性 kind 生效
   *
   * | kind | 去重? | 原因 |
   * |---|---|---|
   * | `business`（上游业务拒绝，如格式不符） | ✅ | 同一 body 必然同样被拒 |
   * | `signature` / `client` | ✅ | 本端 bug，重试同样错 |
   * | `soft_rate` / `hard_credit` / `session_dead` | ❌ | **换号真的可能成功** |
   * | `transport` | ❌ | 网络抖动，重试有意义 |
   *
   * 冷却窗口取 60s：DSH 那串退避总跨度约 19s，够覆盖；而 60s 之后用户
   * 手动重发（比如改了 prompt）又是新请求，不受影响。
   */
  const recentDeterministicFailures = new Map();
  const DETERMINISTIC_FAILURE_TTL_MS = 60_000;

  /** 同一 body 的短时去重键：用 body 原文本身（精确，不引入哈希碰撞）。 */
  const failureKeyOf = (bodyJson) => (typeof bodyJson === 'string' ? bodyJson : '');

  /**
   * kind 是否属于「同一 body 必然同样失败」。
   *
   * ⚠️ **刻意不含 `server`**：`kind: 'server'` 是「上游 5xx / 无法识别的流」，
   * 它**可能**只是瞬时抖动，重试有价值。把它也去重会让一次偶发 5xx
   * 变成一分钟内持续报同一个错 —— 那是把「可恢复」判成「不可恢复」。
   *
   * 真正确定性的是这两类：本端算错了（signature/client）、
   * 或上游明确说这个请求本身不合法（business）。
   */
  const isDeterministicKind = (kind) => kind === 'business' || kind === 'signature' || kind === 'client';

  const rememberDeterministicFailure = (bodyJson, entry) => {
    const key = failureKeyOf(bodyJson);
    if (key === '') return;
    const now = Date.now();
    // 顺手清理过期项，避免长期运行后 Map 无限增长。
    for (const [k, v] of recentDeterministicFailures) {
      if (now - v.atMs > DETERMINISTIC_FAILURE_TTL_MS) recentDeterministicFailures.delete(k);
    }
    recentDeterministicFailures.set(key, { ...entry, atMs: now });
  };

  const recallDeterministicFailure = (bodyJson) => {
    const key = failureKeyOf(bodyJson);
    if (key === '') return undefined;
    const hit = recentDeterministicFailures.get(key);
    if (hit === undefined) return undefined;
    if (Date.now() - hit.atMs > DETERMINISTIC_FAILURE_TTL_MS) {
      recentDeterministicFailures.delete(key);
      return undefined;
    }
    return hit;
  };

  const routeChat = async (bodyJson, signal, parsed) => {
    const modelId = typeof parsed?.model === 'string' ? parsed.model : undefined;

    // 同一个 body 刚因确定性原因失败 → 直接回放结论，不再打上游。
    // 这不改变对用户可见的结果（同样的错误码与消息），只是不再重复十八遍。
    const recalled = recallDeterministicFailure(bodyJson);
    if (recalled !== undefined) {
      return recalled.result;
    }

    const attempts = Math.max(1, Math.min(3, pool.list().length || 1));
    let last;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted === true) {
        return { ok: false, status: 400, kind: 'client', message: '客户端已断开' };
      }
      const account = await pool.acquire(modelId);
      if (account === undefined) {
        if (last !== undefined) break;
        return {
          ok: false,
          status: 503,
          kind: 'unconfigured',
          message: 'Qoder 号池里没有可用账号：请先到「账号」页第三列或「Qoder 号池」页登录一个账号',
        };
      }

      const identity = qoderIdentityOf(account.credential);
      if (identity === undefined) {
        // 凭据缺 uid —— 这是账号本身的问题，换号才有意义。
        last = {
          ok: false,
          status: 401,
          kind: 'authentication',
          message: `账号 ${account.label} 的凭据不完整（缺 userId 或 accessToken）`,
        };
        continue;
      }

      try {
        // 指纹优先：与官方客户端同形（`Encode=1` + 自定义编码 body + 完整
        // `Cosy-*` 头）。指纹器不可用（本机没装 Qoder）时才退回手写 COSY，
        // 那条路用明文 body、不带 `Encode`，上游同样接受。
        const resolvedMachineId = await machineId();
        const request =
          buildQoderFingerprintedRequest({
            fingerprint: await fingerprint(),
            machineId: resolvedMachineId,
            uid: identity.uid,
            securityToken: identity.securityToken,
            payload: parsed,
          }) ?? buildQoderChatRequest({ identity, payload: parsed });

        // —— 流式转发（2026-10-11 修复）——
        //
        // 原先用 `sendQoderRequest` 把整个响应缓冲完再交给 shim，导致首字节
        // 要等**整段回复生成完**（实测：上游首帧 503ms，缓冲后客户端等到 5752ms），
        // 客户端据此判超时并重发 → 表现为「速率异常高 + 老 502」，而上游从没限流。
        //
        // ⚠️ **必须等首帧再返回**，不能直接返回一个空 stream 就 `void` 转发：
        //   - shim 拿到 body 就 `writeHead(200)` 并开始 `res.write()`；
        //   - 若首帧其实是业务错误，那时响应头**已经发出去了**，
        //     无法再改成 4xx/5xx —— 只能把错误混在 200 的流里，客户端看不出。
        // 所以这里等**首帧判定**（约 500ms，即上游首帧时间），通过后立即返回
        // stream，剩余帧由后台继续推进。首字节从「整段时长」降到「首帧时间」。
        const bridge = bridgeStream();
        const firstFrame = deferred();

        let relay;
        try {
          // 不 await 整个流：拿到首帧判定就走。
          const streaming = streamQoderRequest({
            url: request.url,
            method: 'POST',
            headers: request.headers,
            body: request.body,
            // 首帧判定：把「200 但业务失败」在这一刻拦下。
            // 只对首帧判定是安全的 —— 正常流的收尾/统计帧本来就没有 choices，
            // 逐帧判会把成功也判成失败（detectBusinessError 的注释详述过）。
            onFirstFrame: (frame) => {
              const verdict = detectBusinessError(
                `data:${JSON.stringify({ body: frame.inner, statusCodeValue: 200 })}`,
              );
              if (verdict === undefined) {
                firstFrame.resolve({ ok: true });
                return { ok: true };
              }
              const reason = `${verdict.code} ${verdict.message}`;
              firstFrame.resolve({ ok: false, reason });
              return { ok: false, reason };
            },
            onFrame: (inner) => bridge.push(inner),
          });

          // 流结束/失败时收尾：close 让客户端读到 EOF；失败则记回号池。
          streaming
            .then((r) => {
              if (r.status !== 200) {
                const { kind } = classifyQoderRelayFailure({ status: r.status, body: r.body });
                applyQoderRelayFailure(pool, account.id, { kind, modelId });
                firstFrame.resolve({ ok: false, reason: `HTTP ${r.status}` });
                bridge.fail(`Qoder 上游 HTTP ${r.status}`);
                return;
              }
              if (r.failed !== undefined) {
                applyQoderRelayFailure(pool, account.id, {
                  kind: classifyQoderRelayFailure({ status: 200, body: r.failed }).kind,
                  modelId,
                });
                // 首帧前后都可能走到这里：首帧前 firstFrame 尚未 resolve，
                // 由它把错误如实报给 shim；首帧后响应头已发出，只能让流出错。
                firstFrame.resolve({ ok: false, reason: r.failed });
                bridge.fail(`Qoder 上游拒绝请求：${r.failed.slice(0, 300)}`);
                return;
              }
              // 一帧都没有 = 形状变了。此前这条只在「缓冲整段再判断」时能测到，
              // 改成流式后必须在这里单独处理，否则会静默 close 成一个空回答。
              if (r.frameCount === 0) {
                firstFrame.resolve({ ok: false, reason: 'Qoder 上游返回了无法识别的流（无信封帧）' });
                bridge.fail('Qoder 上游返回了无法识别的流（无信封帧）');
                return;
              }
              pool.noteServed(account.id);
              bridge.close();
            })
            .catch((e) => {
              // 传输层中途断开：同样要能定性，不能只留一句 message。
              last = {
                ok: false,
                status: 502,
                kind: 'server',
                origin: 'transport',
                message: `Qoder 上游流中断：${e?.message ?? String(e)}`,
              };
              firstFrame.resolve({ ok: false, reason: e?.message ?? String(e) });
              bridge.fail(e?.message ?? String(e));
            });

          relay = await firstFrame.promise;
        } catch (e) {
          // 连接层失败：走换号重试（与原来的 catch 语义一致）。
          // origin 标明「这不是上游回的状态码，是连接层异常」。
          last = {
            ok: false,
            status: 502,
            kind: 'server',
            origin: 'transport',
            message: `Qoder 上游连接失败：${e?.message ?? String(e)}`,
          };
          continue;
        }

        // 首帧即失败 —— 此时**响应头还没发**，可以如实给出错误码。
        if (relay.ok !== true) {
          const { kind } = classifyQoderRelayFailure({ status: 200, body: relay.reason });
          last = {
            ok: false,
            status: 502,
            kind: kind === 'client' ? 'server' : kind,
            // 上游在 HTTP 200 的信封里报的业务错误：**不是** HTTP 错误码。
            // 带上 origin 以区别于「上游真的回了 5xx」。
            origin: 'business',
            upstream: relay.status,
            message: `Qoder 上游拒绝请求：${String(relay.reason).slice(0, 300)}`,
          };
          if (kind === 'soft_rate' || kind === 'hard_credit' || kind === 'session_dead') continue;
          // 业务拒绝是确定性的：同一 body 再来必然同样被拒，记下来。
          rememberDeterministicFailure(bodyJson, { result: last });
          return last;
        }

        // 首帧已通过：立刻把 stream 交给 shim，剩余帧由后台继续推进。
        return {
          ok: true,
          response: {
            status: 200,
            body: bridge.stream,
          },
        };
      } catch (e) {
        last = {
          ok: false,
          status: 502,
          kind: 'server',
          origin: 'internal',
          message: e?.message ?? String(e),
        };
        continue;
      }
    }

    const failure = last ?? {
      ok: false,
      status: 502,
      kind: 'server',
      origin: 'internal',
      message: 'Qoder 请求未取得结果',
    };
    // 换号重试全部用尽仍是确定性失败 → 记下来，挡住 DSH 那串指数退避重发。
    if (isDeterministicKind(failure.kind)) {
      rememberDeterministicFailure(bodyJson, { result: failure });
    }
    return failure;
  };

  const ready = (async () => {
    await pool.scan();
    shim = await createQoderShim({ routeChat, models: () => catalog.current() });

    // 目录：拉不到就用兜底，**绝不因为拉不到就不注册 provider**
    const first = catalog.current()[0];
    const cred = first === undefined ? undefined : pool.list()[0]?.credential;
    if (cred !== undefined) await catalog.refresh(cred);
  })();

  ready
    .then(() => {
      if (disposed) return;
      const qoder = createQoderAdapter({ shim, catalog, provider: QODER_PROVIDER });
      registration.adapter = ctx.llm.registerAdapter([QODER_PROVIDER], qoder.adapter);
      registration.directory = ctx.llm.registerConfigurableProviders([
        {
          provider: QODER_PROVIDER,
          displayName: 'Qoder',
          settingsNs,
          settingsPath: [],
          declared: false,
        },
      ]);
      ctx.llm.registerModelDiscovery(settingsNs, async () =>
        catalog.current().map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? QODER_FALLBACK_CONTEXT_WINDOW,
          ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
          inputModalities: ['text'],
        })),
      );
    })
    .catch((error) => {
      ctx.logger?.error?.('[wotr-console] Qoder provider 注册失败', error);
    });

  ctx.effect(() => () => {
    disposed = true;
    registration.adapter?.();
    registration.directory?.();
    shim?.close?.();
  });

  void config;
}

export {
  Config,
  QODER_PROVIDER,
  apply,
  inject,
  name,
  // 导出给单测：转换规则是「能不能正常对话」的最后一环，且它踩过两个非显然
  // 的坑（[DONE] 在信封里、尾部多一帧 event:finish），必须有断言钉住。
  sseStreamOf,
  extractInnerBody,
  // 业务错误嗅探：上游用「HTTP 200 + 信封内 statusCodeValue:400」表示拒绝，
  // 漏判的表现是「模型跑不通但不报错」，必须有断言钉住。
  detectBusinessError,
};
