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

import {
  QoderCatalog,
  QODER_FALLBACK_CONTEXT_WINDOW,
  qoderInputModalities,
  qoderModelDisplayName,
} from './qoder-catalog.mjs';
import { readOrCreateQoderMachineId } from './qoder-auth.mjs';
import { createQoderFingerprint } from './qoder-fingerprint.mjs';
import { QoderAccountPool, QoderCredentialStore } from './qoder-pool.mjs';
import { createQoderShim } from './qoder-shim.mjs';
import { catalogSignature, createLiveRefresher } from './live-catalog.mjs';
import { asVolatile, unwrapVolatile } from './volatile.mjs';
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

/**
 * 含图请求的图片预算三件套。
 *
 * 与 Trae 入口（`lib/trae.js` 的同名常量）**逐字同值**：`maxRequestImageBytes`
 * 是一次请求里所有图片解码后的总量上限，`requestImagePixelBudget` /
 * `requestImageMaxBytes` 是单图缩放目标（超了才缩，不放大）。
 *
 * 前两者 pi-ai 侧有同值兜底、缺了不崩，但那是「碰巧一致」；第三个缺了就是
 * **完全没有总量闸门**。三家 provider 的图片行为必须一致，所以两边都显式写。
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/**
 * 当前活着的 provider 句柄，供**另一个 Loader 入口**使用。
 *
 * `lib/index.js`（管理页路由）与这里是两个独立的 Loader 入口，各自 `apply`、各自
 * 持有实例 —— 管理页想触发一次目录刷新，跨入口只有模块级句柄这一条路。与 vendor
 * 半边发布 `currentApi()` 是同一个套路。
 *
 * 注册成功后写入，dispose 时**校验身份再清空**：热重载时新实例可能已经写入，
 * 旧实例的清理不能把新句柄抹掉。
 */
let published;

/**
 * 取当前 provider 句柄；未注册（或已 dispose）时为 `undefined`。
 *
 * @returns {{adapter:object, catalog:object, models:()=>Array, pool:object, refreshCatalog:()=>Promise<object>, syncPoolConfig:()=>object}|undefined}
 */
export function currentQoderApi() {
  return published;
}

/**
 * provider 配置。
 *
 * ⚠️ **每个字段都必须包 `asVolatile`**：宿主 0.1.7 的 settings 写入闸门要求
 * schema 至少有一个 volatile 字段，否则 `set()` 抛
 * `Plugin entry "qoder" has no volatile fields`。没有它，这一整块配置**存不进去**
 * —— 卡片看着保存成功、实际被静默回滚，profile 里永远不会出现 `config:` 块。
 *
 * 模型三件套的语义与 WorkBuddy / Trae 对齐（见 `selectModels`）。
 *
 * 号池三件套**是本入口独有的**：Qoder 的池配置放在这里（而不是管理页那个
 * 入口的 settings 里），因为**读它的是 provider 自己** —— 设置写在谁身上，
 * 谁就能拿到最新值，不必跨入口传话。管理页只负责写，写入路径与 Trae 半边
 * 完全一样（客户端写 settings，provider 在 `loader/volatile-update` 时推给池）。
 */
const Config = z.object({
  enabledModelIds: asVolatile(
    z
      .array(z.string())
      .default([])
      .description('本 provider 提供给 DSH 的模型 id 白名单（留空 = 全部）'),
  ),
  imageModelIds: asVolatile(
    z
      .array(z.string())
      .default([])
      .description(
        '「可收图」的模型 id（设置页按上游目录的 is_vl 回写，没有手动开关）。只加不减：与上游目录取并集，写进来不会让某个上游支持图片的模型失去图片能力',
      ),
  ),
  contextBudgets: asVolatile(
    z
      .dict(z.number().step(1).min(1))
      .default({})
      .description(
        '按模型收紧上下文窗口（设置页按上游目录回写，没有手动开关）：留空 = 用满上游原生窗口；有值且小于上游窗口时才生效',
      ),
  ),
  selectedAccountId: asVolatile(
    z
      .string()
      .default('')
      .description(
        '号池里「当前使用」的账号 id：请求只用它，它不可用（停用 / 不在池里）时请求直接失败，由你手动切换。留空 = 无可用账号',
      ),
  ),
  disabledAccountIds: asVolatile(
    z
      .array(z.string())
      .default([])
      .description('不参与号池的 Qoder 账号 id（留空 = 池里每个已登录账号都参与）'),
  ),
});

/**
 * 从（可能是活引用的）配置里取出号池那份设置。
 *
 * volatile 字段在 0.1.7 上是 `{get(): T}` 活引用，所以**每次都要重新解引用**，
 * 不能把结果缓存下来 —— 设置页保存后，同一个 `config` 对象上读到的就是新值。
 */
function poolConfigOf(config) {
  return {
    selectedAccountId: unwrapVolatile(config?.selectedAccountId) ?? '',
    disabledAccountIds: unwrapVolatile(config?.disabledAccountIds) ?? [],
  };
}

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

/**
 * 把一个 id 列表读成集合。**空数组与缺省同义 = 不限制**。
 *
 * ⚠️ 这里刻意**不照抄** WorkBuddy `visible()` 对空数组的处理：那边
 * `enabledModelIds: []` 会把模型全部过滤掉（schemastery 的 `.default([])` 让它
 * 永远不是 `undefined`，于是「缺省 = 全部」的回退分支成了死代码），表现是
 * 「provider 已注册但一个模型都没有」。schema 的文档语义是「absent = all」，
 * 这里按文档实现：**空 = 全部**。
 *
 * 活引用（0.1.7 的 `{get(): T}`）先解引用再判 —— 直接对活引用做 `Array.isArray`
 * 永远是 `false`，那会静默退化成「不限制」。
 */
function idSetOf(value) {
  const list = unwrapVolatile(value);
  return Array.isArray(list) && list.length > 0 ? new Set(list) : undefined;
}

/**
 * 目录 + 配置 → 真正提供给 DSH 的模型行。
 *
 * 与 WorkBuddy 的 `visible()`、Trae 的 `derive()` 同款，三条规则：
 *
 * 1. `enabledModelIds` 非空时按它过滤；
 * 2. `imageModelIds`（图片）与 `contextBudgets`（上下文）**都不是手动开关**：
 *    设置页的模型列按上游目录回写它们 —— 图片取上游 `is_vl`、上下文留空表示用满
 *    上游原生窗口（见 lib/console.mjs 的 `upstreamFieldsOf`）。这里保留的语义是
 *    「与上游取并集 / 只下调」，所以即便设置里留着一份旧的手写值，也不会把一个
 *    上游标了 `is_vl: true` 的模型降回纯文本 —— 反向的诉求（上游撤销了图片能力
 *    但本地列表还留着旧 id）在这套语义下无法表达，属于已知限制，与另两家一致。
 * 3. `contextBudgets` 只在**小于**上游窗口时收紧。**不做抬升**：真机
 *    `context_config` 虽然有 1M/400K/200K 三档，但选用高档需要在请求里带对应的
 *    档位参数（未验证），只把窗口数字改大而请求仍走默认档，等于让 DSH 放心发出
 *    一段上游根本不接受的超长上下文 —— 宁可保守。
 */
function selectModels(models, config) {
  const allow = idSetOf(config?.enabledModelIds);
  const images = idSetOf(config?.imageModelIds);
  const budgets = unwrapVolatile(config?.contextBudgets);
  return models
    .filter((model) => allow === undefined || allow.has(model.id))
    .map((model) => {
      const next = { ...model };
      if (images !== undefined && images.has(model.id)) next.supportsImages = true;
      const budget = budgets?.[model.id];
      if (
        typeof budget === 'number' &&
        Number.isInteger(budget) &&
        budget > 0 &&
        budget < next.contextWindow
      ) {
        next.contextWindow = budget;
      }
      return next;
    });
}

/** 目录 → pi-ai 的模型形状。`contextWindow` 是硬性必填。 */
function toPiModel(model, baseUrl, providerId) {
  return {
    id: model.id,
    name: qoderModelDisplayName(model),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    // ⚠️ 图片能力必须走共用谓词：写死 `['text']` 会让 `resolveModelInfo` 报
    // 「不支持图片」，宿主的准入闸门随即在**提交 prompt 时**硬拒整条消息
    // （前端横幅「当前模型不支持图片」）。上游 14 个 chat 模型里 13 个 `is_vl`
    // 为 true，包括 DSH 的默认模型 `dfmodel`。
    input: qoderInputModalities(model),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 真机的 `thinking_config` 有档位，但请求侧参数**未验证**：声明 reasoning
    // 会让 pi-ai 真的往请求里塞 `reasoning_effort`，写错就是把「能聊天」变成
    // 「一律 400」。所以这里保守留 false，直到真机确认过参数形状。
    reasoning: false,
    // ⚠️ `contextWindow` 必须是正整数：宿主 `normalizeModelInfo` 会对这一行抛
    // `INVALID_MODEL_CONTEXT`（**只作废这一个模型**，不是整个 provider ——
    // pi-ai 还有 `defaultContextWindow` 兜底）。
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
  // `options.models()` 已经过配置（白名单 / 图片并集 / 上下文预算），不是裸目录 ——
  // 与 discovery 读的是同一个函数，两处不可能再各说各话。
  const buildModels = () =>
    options.models().map((m) => toPiModel(m, `${options.shim.baseUrl()}/v1`, providerId));

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
    // 图片预算三件套 —— 与 Trae 入口逐字同一组值（见 lib/trae.js 的
    // `REQUEST_IMAGE_BUDGETS`）。pi-ai 对 `maxPixels`/`maxBytes` 有同值兜底，
    // 缺了不会崩，但两家的缩图行为会悄悄分叉；`maxRequestImageBytes` 缺了更是
    // 直接没有总量闸门。所以显式写出来。
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);

  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: { kind: 'none' },
      // shim 的随机 secret —— 每次启动都变，不落盘
      resolveApiKey: async () => options.shim.token(),
      /**
       * 图片消息必须能拿到**宿主的持久附件服务**。
       *
       * pi-ai 适配器在 `stream()` 里对含图消息依次做三个判定
       * （dsh-llm-pi-ai 的 `streamWithSnapshot`）：
       *
       *   1. `containsImage && !model.input.includes("image")` → 「模型不支持图片」
       *      —— 这一层是准入闸门，已由 `qoderInputModalities` 放行；
       *   2. `const attachments = containsImage ? this.config.resolveAttachments?.() : undefined`
       *      —— **没接线就是 undefined**；
       *   3. `containsImage && attachments === undefined` → 抛
       *      `pi-ai image input requires the durable attachment service`
       *      （`UNSUPPORTED_CONTENT`，用户看到的就是这句）。
       *
       * 也就是说：模型层声明了 image、但适配器没拿到附件服务时，报错**晚一层**
       * 才出现，看起来仍像「模型不支持图片」。Trae 入口一直有这一行
       * （`lib/trae.js`：`resolveAttachments: () => ctx.get("attachments")`），
       * Qoder 漏了。
       *
       * 值是箭头函数 —— 注册期服务可能还没就绪，`stream()` 时才取值；真没这个
       * 服务时那句报错仍照常抛出，不会静默降级成纯文本。
       */
      ...options.resolveAttachments === void 0
        ? {}
        : { resolveAttachments: options.resolveAttachments },
    }),
    invalidate() {
      profiles = new Map([[providerId, profile]]);
    },
  };
}

function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx);
  const registration = { adapter: undefined, directory: undefined };

  /**
   * 官方指纹器（懒加载，全局一份）。
   *
   * 首次用到时从本机 Qoder 安装里提取官方 wasm 并实例化。提取一次就够，之后复用
   * —— 33 MB 的源码只读一次，wasm 也只实例化一次。
   *
   * `undefined` 表示本机没有官方安装（或提取失败），此时**推理与目录两条链都**
   * 退回手写 COSY。不因此失败：手写那条是实测可用的，只是与官方客户端不同形。
   *
   * ⚠️ **失败不缓存**：提取失败通常只是「本机还没装官方客户端」，把 `undefined`
   * 钉死会让用户装好 Qoder 之后**整个进程**仍走手写链 —— 与
   * `qoder-fingerprint.mjs` 里「wasm 提取结果只缓存成功」的设计正好相反。
   * 重试本身很便宜（昂贵的提取结果已按候选路径缓存），且并发调用共享同一个
   * 进行中的 promise。
   */
  let fingerprintPromise;
  /** 已成功解析出的指纹器实例。**只有成功才常驻**。 */
  let fingerprintValue;
  const fingerprint = () => {
    if (fingerprintValue !== undefined) return Promise.resolve(fingerprintValue);
    if (fingerprintPromise === undefined) {
      fingerprintPromise = createQoderFingerprint()
        .then((value) => {
          if (value !== undefined && value !== null) fingerprintValue = value;
          return value;
        })
        .catch(() => undefined)
        .finally(() => {
          fingerprintPromise = undefined;
        });
    }
    return fingerprintPromise;
  };

  /**
   * 取本机 machine_id。
   *
   * 与登录共用同一个值（`~/.qoder-cn/.auth/machine_id`）：指纹里的
   * `Cosy-MachineId` / `Cosy-MachineToken` 必须与官方登录身份一致，
   * 否则就是「同一个账号在不同机器上」的可疑形态。
   *
   * 刻意**不缓存 promise 的失败**：拿不到就每次都重试（读文件很便宜），
   * 免得一次瞬时失败把指纹路径永久钉死在手写兜底上。
   */
  const machineId = async () => {
    try {
      const value = await readOrCreateQoderMachineId();
      return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
      return undefined;
    }
  };

  // 目录也走指纹路径：给它指纹器与 machineId 取值器。
  const catalog = new QoderCatalog({
    fingerprint: async () => fingerprint(),
    machineId,
  });

  /**
   * 「实时目录」：读路径按 TTL 触发上游刷新，内容有变就广播适配器更新。
   *
   * # 为什么挂在读路径上（而不是定时器）
   *
   * DSH 的聊天选择器每次打开都会走
   * `modelCatalog()` → `llm.listModels()` → `PiAiAdapter` → `pi-ai Models.getModels()`
   * → 本插件的 `getModels()`（同步）。这条链上没有 discovery，所以**只要目录缓存
   * 不刷新，选择器里的 `Qwen3.8-Max · x0.8` 就永远是启动那一刻的快照**。
   *
   * 挂在读路径上能保证「用户伸手去看的那一刻」触发刷新，且不空转请求。
   * 刷新本身在后台跑（`ensureFresh()` 不阻塞、不抛错），选择器先看到旧值，
   * 下一帧就是新值。
   *
   * # 为什么刷新成功还要广播
   *
   * 刷新只改插件内存；客户端的 `ModelCatalogDirectory` 有自己的快照缓存，只认
   * `llm/adapters-updated` 等四个事件。而 `registerAdapter()` 返回的句柄上
   * `.replace([...])` 会走到 `commitRoutes()` → `emitAdaptersUpdated()`，这是本
   * 插件唯一能主动发的那个事件。所以 `onChange` 里做一次 `.replace()`。
   */
  const liveFeed = createLiveRefresher({
    refresh: async () => {
      // 没有账号时**不算失败也不重试**：这是「还没登录」，不是上游抖了。
      // 记成成功（签名不变）可以避免每 15 秒空转一次「号池里还没有账号」。
      let cred = pool.list()[0]?.credential;
      if (cred === undefined) {
        try {
          await pool.scan();
        } catch {
          /* 扫不动就按没账号处理 */
        }
        cred = pool.list()[0]?.credential;
      }
      if (cred === undefined) return { ok: true, signature: liveFeedSignature() };
      const result = await catalog.refresh(cred);
      if (result?.ok !== true) return { ok: false };
      return { ok: true, signature: catalogSignature(catalog.current()) };
    },
    onChange: () => {
      // 目录变了 → 让 DSH 重新读一次模型表（也顺带刷新客户端选择器的缓存）。
      try {
        registration.adapter?.replace?.([QODER_PROVIDER]);
      } catch (error) {
        ctx.logger?.warn?.('dsh-connect-qoder: 目录刷新后广播适配器失败', error);
      }
    },
    onError: (error) => {
      ctx.logger?.warn?.('dsh-connect-qoder: 实时目录刷新失败，继续用当前缓存', error);
    },
  });

  /** 当前可见模型（目录 + 配置过滤）的签名 —— 与广播判据同口径。 */
  function liveFeedSignature() {
    return catalogSignature(catalog.current());
  }

  // 池与 shim 都是本入口自己的实例：不跨入口共享，避免生命周期耦合。
  //
  // ⚠️ `dshHome` **必须显式传**（与 lib/index.js 管理页同一个口径 `DSH_HOME ?? ~/.dsh`）。
  // 漏传时 `QoderCredentialStore.readAll()` 会因为 dshHome 为空串而直接返回 `[]`，
  // 表现为「管理页能看到已登录账号、但 provider 每次取号都空、模型永远跑不通」。
  // 这是真机踩过的：登录落盘在 `~/.dsh/.qoder-auth.cn.*.json`，只有给了正确
  // dshHome，provider 侧的池才扫得到它们。
  //
  // ⚠️ `logger` 同样**必须显式传**。池里所有「自动换号」的可观测痕迹都是
  // `this.logger?.warn?.()`（限流冷却、当前账号不可用而让位给备用）—— 不传时
  // 这些日志全部落进 `undefined?.`，一声不响地消失。用户看到的现象就退化成
  // 「请求打到别的号上了，但没有任何地方说过为什么」，与改造前那个 bug 的
  // 观感一模一样。这里传的是宿主 logger（`ctx.logger`）。
  const pool = new QoderAccountPool({
    store: new QoderCredentialStore({ dshHome: qoderDshHome() }),
    logger: ctx.logger,
  });

  /**
   * 把设置里的号池三件套推给池 —— **本入口是唯一做这件事的地方**。
   *
   * 为什么必须在这里而不是管理页那个入口：管理页（lib/index.js）是另一个
   * Loader 入口，它改自己的池实例改不到请求路径上。这条链是：
   *
   *   设置页写 `dsh-connect-qoder` 的 `selectedAccountId`
   *     → 宿主发 `loader/volatile-update`
   *     → 这里重新解引用 `config` 并 `pool.applyConfig(...)`
   *     → 下一次 `pool.acquire()` 就用新的「当前账号」
   *
   * 启动时也要跑一次：`selectedAccountId` 存在 profile 里，重启后得恢复。
   * 管理页那条快照路由还会主动调用发布出去的 `syncPoolConfig()`，这样
   * 「刚保存完就刷新页面」看到的也是新值，不必等一条请求先把事件带过来。
   */
  const syncPoolConfig = () => {
    const next = poolConfigOf(config);
    pool.applyConfig(next);
    return next;
  };
  syncPoolConfig();

  /**
   * 设置页保存后立刻生效 —— 与 Trae 入口同一根线（见 lib/trae.js 的
   * `applySelection` + `loader/volatile-update`）。
   *
   * 少了这一句，「切换到此账号」要等**下一次 DSH 重启**才生效：写入的是设置，
   * 而池只在自己构造时读过一次配置。`ctx.on` 用可选调用是因为单测里的假 ctx
   * 没有事件系统，真宿主一定有。
   */
  ctx.on?.('loader/volatile-update', () => {
    syncPoolConfig();
  });

  let shim;
  let disposed = false;

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

    /**
     * 取号前先把设置里的号池配置同步一次。
     *
     * `loader/volatile-update` 理论上已经覆盖了每一次保存，但「当前账号」是
     * 用户点了按钮就立刻期待生效的东西 —— 这里多读一次活引用（两个 `get()`）
     * 的代价可以忽略，换来的是「无论事件有没有到，下一次请求一定用新选择」。
     */
    syncPoolConfig();

    // 同一个 body 刚因确定性原因失败 → 直接回放结论，不再打上游。
    // 这不改变对用户可见的结果（同样的错误码与消息），只是不再重复十八遍。
    const recalled = recallDeterministicFailure(bodyJson);
    if (recalled !== undefined) {
      return recalled.result;
    }

    // 完全手动语义：单次尝试，只用「当前使用」账号；失败不换号重试。
    let last;

    {
      if (signal?.aborted === true) {
        return { ok: false, status: 400, kind: 'client', message: '客户端已断开' };
      }
      const account = await pool.acquire(modelId);
      if (account === undefined) {
        return {
          ok: false,
          status: 503,
          kind: 'unconfigured',
          message: 'Qoder 号池里没有可用账号：请先到管理页「切换到此账号」选中一个账号（或先登录一个账号）',
        };
      }

      const identity = qoderIdentityOf(account.credential);
      if (identity === undefined) {
        // 凭据缺 uid —— 账号本身的问题，请手动切换到别的账号。
        last = {
          ok: false,
          status: 401,
          kind: 'authentication',
          message: `账号 ${account.label} 的凭据不完整（缺 userId 或 accessToken）`,
        };
        return last;
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
          // 连接层失败：不换号，直接失败（完全手动语义）。
          // origin 标明「这不是上游回的状态码，是连接层异常」。
          last = {
            ok: false,
            status: 502,
            kind: 'server',
            origin: 'transport',
            message: `Qoder 上游连接失败：${e?.message ?? String(e)}`,
          };
          return last;
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
        return last;
      }
    }

    const failure = last ?? {
      ok: false,
      status: 502,
      kind: 'server',
      origin: 'internal',
      message: 'Qoder 请求未取得结果',
    };
    // 确定性失败 → 记下来，挡住 DSH 那串指数退避重发。
    if (isDeterministicKind(failure.kind)) {
      rememberDeterministicFailure(bodyJson, { result: failure });
    }
    return failure;
  };

  /**
   * 真正提供给 DSH 的模型行 = 目录 + 配置。
   *
   * **推理链（`toPiModel`）与 DSH 目录（discovery）都只读它**，这样两边不可能
   * 出现「选择器说能收图、实际发不出去」这类不一致。
   *
   * 这里也是「实时目录」的触发点：DSH 每次打开模型选择器都会经
   * `listModels → getModels → buildModels` 走到本函数（见 `lib/live-catalog.mjs`
   * 的模块注释）。`ensureFresh()` 不阻塞、不抛错、且带 TTL 与并发合并，
   * 所以放在这里不会让选择器变慢或变脆。
   */
  const visibleModels = () => {
    liveFeed.ensureFresh();
    return selectModels(catalog.current(), config);
  };

  const ready = (async () => {
    await pool.scan();
    shim = await createQoderShim({ routeChat, models: () => catalog.current() });

    // 目录：拉不到就用兜底，**绝不因为拉不到就不注册 provider**
    const cred = pool.list()[0]?.credential;
    if (cred !== undefined) {
      const seeded = await catalog.refresh(cred);
      // 种子刚拉完 → 标成新鲜，避免注册后的第一次读路径立刻又打一次上游。
      if (seeded?.ok === true) liveFeed.markFresh(liveFeedSignature());
    }
  })();

  /**
   * 从号池里挑一个账号拉目录。
   *
   * 与启动时同一口径（第一个账号），并按 `pool.acquire()` 的惯例**空池先懒扫一次**
   * —— provider 只在启动时扫过一次盘，用户中途登录的账号要等下一次扫描才可见。
   * 没有账号时**不报错**，如实返回「还没登录」：手动刷新最常见的失败原因就是这个，
   * 报成「上游形状变了」会把人带偏。
   */
  const refreshCatalog = async () => {
    let cred = pool.list()[0]?.credential;
    if (cred === undefined) {
      try {
        await pool.scan();
      } catch {
        /* 扫不动就按「没账号」处理，下面统一返回 */
      }
      cred = pool.list()[0]?.credential;
    }
    if (cred === undefined) {
      return { ok: false, models: catalog.current(), message: '号池里还没有账号，请先登录 Qoder' };
    }
    const result = await catalog.refresh(cred);
    // 手动刷新成功 → 同样标新鲜：用户刚点过，没必要在读路径上再打一次。
    // 内容变了要广播（卡片上的倍率变了，选择器也得跟着变）。
    if (result?.ok === true) {
      const next = liveFeedSignature();
      const changed = next !== liveFeed.signature();
      liveFeed.markFresh(next);
      if (changed) {
        try {
          registration.adapter?.replace?.([QODER_PROVIDER]);
        } catch (error) {
          ctx.logger?.warn?.('dsh-connect-qoder: 手动刷新后广播适配器失败', error);
        }
      }
    }
    return result;
  };

  ready
    .then(() => {
      if (disposed) return;
      const qoder = createQoderAdapter({
        shim,
        models: visibleModels,
        provider: QODER_PROVIDER,
        // 宿主的持久附件服务：图片消息靠它把 `{attachmentId}` 读成真实字节。
        // 与 Trae 入口同款接线；缺了它含图消息会在 pi-ai 适配器里抛
        // `pi-ai image input requires the durable attachment service`。
        resolveAttachments: () => ctx.get('attachments'),
      });
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
      ctx.llm.registerModelDiscovery(settingsNs, async () => {
        // Models 页的「拉取模型」也走实时目录：否则用户主动点一次，拿到的还是
        // 启动时的快照，与「实时」的承诺自相矛盾。这里**等**刷新完成（用户在
        // 等这个动作），失败则退回缓存 —— discovery 绝不因此抛错。
        const pending = liveFeed.ensureFresh();
        if (pending !== undefined) {
          try {
            await pending;
          } catch {
            /* ensureFresh 本身不抛；这里只防御 refresh 里漏出的异常 */
          }
        }
        return visibleModels().map((m) => ({
          id: m.id,
          name: qoderModelDisplayName(m),
          contextWindow: m.contextWindow ?? QODER_FALLBACK_CONTEXT_WINDOW,
          ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
          inputModalities: qoderInputModalities(m),
        }));
      });
      // 管理页要能碰到 provider 内部（目录、刷新）—— `lib/index.js` 是另一个
      // Loader 入口，与这里各自持有实例，只有模块级句柄能跨过去。
      //
      // `directory` 与 `models` 的区别是**过滤前/后**，两者都要给：
      //   - `models()`  = `selectModels` 之后，DSH 选择器看到的那份；
      //   - `directory()` = 上游目录原样，勾选卡必须用这一份。
      // 卡片若读过滤后的列表，用户一取消勾选那个模型就从列表里消失、再也勾不
      // 回来（Trae 半边的 `liveDirectory` 是同一条教训，见 lib/trae.js 注释）。
      published = {
        adapter: qoder,
        catalog,
        models: visibleModels,
        directory: () => catalog.current(),
        pool,
        refreshCatalog,
        /**
         * 把设置里的号池配置重新推给池，并返回推下去的那份值。
         *
         * 管理页的路由在出快照前调用它：设置写入与 `loader/volatile-update`
         * 事件之间有一个极短的窗口，而用户点完「切换到此账号」就立刻刷新列表
         * —— 那个窗口里读到的还是旧的「当前使用」，看起来像没切换成功。
         */
        syncPoolConfig,
        /**
         * 这一版代码的**接线自述**，给管理页与诊断用。
         *
         * `imageAttachments` 就是图片链路第二层（pi-ai 适配器的
         * `resolveAttachments`）的标志。加它的理由很实际：部署后**必须重启
         * DSH** 才生效，而没接线时的报错（`pi-ai image input requires the
         * durable attachment service`）与「模型不支持图片」长得几乎一样，
         * 光看现象分不清「代码没加载」还是「代码不对」。有了它，
         * `GET …/qoder/models/refresh` 一眼就能回答「跑的是哪一版」。
         */
        capabilities: () => ({
          imageAttachments: typeof qoder.adapter?.config?.resolveAttachments === 'function',
        }),
      };
    })
    .catch((error) => {
      ctx.logger?.error?.('[wotr-console] Qoder provider 注册失败', error);
    });

  ctx.effect(() => () => {
    disposed = true;
    liveFeed.dispose();
    if (published?.catalog === catalog) published = undefined;
    registration.adapter?.();
    registration.directory?.();
    shim?.close?.();
  });
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
