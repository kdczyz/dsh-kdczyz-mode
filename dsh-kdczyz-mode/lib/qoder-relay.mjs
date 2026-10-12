/**
 * Qoder CN 的**反向代理请求**模块：签名、发请求、解信封、分类失败。
 *
 * # 为什么 CN 必须签名
 *
 * Qoder 国内版的推理**没有** REST 的 `/model/v1/chat/completions`（那条路径只对
 * 国际版存在）。CN 走的是签名路径：
 *
 *   POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
 *        ?FetchKeys=llm_model_result&AgentId=agent_common
 *   Authorization: Bearer COSY.<payload>.<md5>
 *
 * 不签名会拿到 401/403，而**失败形态伪装成「凭据失效」** —— 用户会去反复重贴
 * PAT / 重登账号，越查越偏。所以本模块的存在意义就是把签名做对，而不是把它
 * 降级成一个可选项。
 *
 * # 签名算法的取证来源
 *
 * 全部取自**官方 CN 客户端本体**（`/Applications/Qoder CN.app` 的 `app.asar`
 * 内 `out/main/index.js`），不是猜的：
 *
 *   - RSA 公钥：`cXt`（1024 位，PEM 逐字节相同）
 *   - 构造：`lXt()` 出 `Cosy-Key` / `info`，`iqe()` 出 Authorization
 *   - 摘要串：`payload\ncosyKey\ntimestamp\nbody\npath`（注意是 `\n` 连接）
 *   - 路径归一 `dXt()`：取 pathname、去查询串、去 `/algo` 前缀
 *
 * 这与开源参考实现（Qoder2API-Hub）记载的「RSA 包裹 AES 会话密钥 + MD5 请求
 * 签名」完全吻合，两条独立来源互相印证。
 *
 * # 2026-10-11 真机修正（把这半边从「不能对话」变成「能对话」）
 *
 * 早期版本认为接通推理卡在「拿不到官方自定义 Base64 编码器（在 wasm 里）」。
 * 真机实测证明**这个判断是错的**，两处修正：
 *
 * 1. **`Encode` 是开关，不是必填**。带 `Encode=1` 时服务端才用
 *    `CustomBase64Util.decode` 解请求体（发明文会触发 Java 异常）；**不带**
 *    就按明文 JSON 处理，正常回话。所以查询串去掉 `Encode` 后，明文 body
 *    直接可用，官方编码器不再是前提。见 `QODER_SIGNED_CHAT_QUERY`。
 * 2. **目录链是 GET + 空 body**（官方同形：`…?Encode=1` + `Content-Length: 0`）。
 *    写成 POST 回 `400 Request method 'POST' not supported`；GET 带非空 body
 *    时服务端按 `Encode=1` 去解自定义 Base64，明文 `{}` 会触发 Java 异常；
 *    而**不带 `Content-Length`** 时服务端读到空 body，与签名用的 body 不一致，
 *    回 `101 Signature invalid`。见 `QODER_CN_SIGNED_MODELS_QUERY` 与
 *    `buildQoderModelsRequest`。
 *
 * # 令牌族：`dt-` 原样可用
 *
 * 签名路径的 `security_oauth_token` 用入池的 `dt-` 令牌**原样**填入即可，
 * 不需要先换 `jt-`（`jobToken/exchange` 是 PAT 专用端点，`dt-` 打过去回 400）。
 * 详见 `resolveSecurityToken`。
 *
 * @module
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/** CN 推理主机（与目录链共用同一个 gateway）。 */
export const QODER_CN_CHAT_BASE = 'https://gateway.qoder.com.cn';

/** CN 签名路径。**不是** `/model/v1/chat/completions`（那是国际版）。 */
export const QODER_SIGNED_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';

/**
 * 签名路径的查询串。
 *
 * ⚠️ **不带 `Encode`**（实测 2026-10-11，真机）：
 *
 * | 查询串 | 结果 |
 * |---|---|
 * | `…&Encode=1` | 服务端用 `CustomBase64Util.decode` 解 body → 明文 body 触发 Java 异常 |
 * | `…&Encode=0` | **明文 body 直接被接受，正常回话** |
 * | 不带 `Encode` | 同上，正常回话 |
 *
 * 也就是说 `Encode=1` 是「请用自定义 Base64 解码请求体」的**开关**，不是必填项。
 * 不声明它，服务端就按明文处理 —— 于是「实现官方自定义 Base64 编码器」这件事
 * **不再是接通推理的前提**（编码细节在官方 wasm 里，此前一直拿不到）。
 */
export const QODER_SIGNED_CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common';

/** CN 模型目录：**PAT 直连**的那条（不需要签名，但要 `pt-` 令牌）。 */
export const QODER_CN_MODELS_BASE = 'https://api.qoder.com.cn';
export const QODER_CN_MODELS_PATH = '/api/v1/cloud/models';

/**
 * CN 模型目录的**签名链**（`dt-` 设备令牌走这条）。
 *
 * ⚠️ 目录有**两条**，按令牌族分派，**不要图省事只留一条**：
 *
 * | 令牌族 | 端点 | 是否要 COSY 签名 |
 * |---|---|---|
 * | `pt-`（PAT） | `api.qoder.com.cn/api/v1/cloud/models` | 否 |
 * | `dt-`（设备流，本插件用的） | `gateway.qoder.com.cn/algo/api/v2/model/list` | **是** |
 *
 * 参考实现原文：「设备流令牌（dt-）在 `fetchQoderDirectory` 内部按令牌族分派到
 * wasm 签名目录链」。本插件入池凭据**全是 `dt-`**，所以走下面这条签名链
 * —— 好消息是它用的正是我们已经能构造的 COSY 签名。
 *
 * ⚠️ **必须是 GET + 空 body**（实测 2026-10-11，真机；与官方 worker 同形）：
 *
 * | 方法 / body | 结果 |
 * |---|---|
 * | POST | `400 Request method 'POST' not supported` |
 * | GET，不带 `Content-Length` | `403 / 101 Signature invalid` |
 * | GET，空 body + `Content-Length: 0` | **200，正常返回目录** |
 * | GET，`{}` body + `Content-Length: 2` | 200（早期探测的形态，仍可用） |
 *
 * 第二行是最容易踩的坑：GET 发 body 时 Node 的 `http` 会走 chunked 而**不自动
 * 加** `Content-Length`，服务端于是读到空 body，与签名所用的 body 不一致，
 * 摘要对不上就回 101。Node 的 `fetch` 更直接 —— 它**禁止** GET 带 body，
 * 所以目录链只能用 `node:http` 发，不能用 `fetch`。
 */
export const QODER_CN_SIGNED_MODELS_PATH = '/algo/api/v2/model/list';
/**
 * 目录链查询串。
 *
 * ⚠️ 这是**签名层之外**的东西，官方用的是另一套，两者都能取到目录但不同形：
 *
 * | | 查询串 | 实测 |
 * |---|---|---|
 * | 官方 | `Encode=1` | 200，14 个模型 |
 * | 本插件早期探测 | `FetchKeys=llm_model_result&AgentId=agent_common` | 200，14 个模型（走 node:http） |
 *
 * 保留这个常量只为兼容既有调用方与测试；`buildQoderModelsRequest` 已改为
 * 默认发官方那套（见 {@link QODER_SIGNED_MODELS_QUERY} 的用法）。
 */
export const QODER_CN_LEGACY_MODELS_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common';

/** 官方目录链查询串（worker @19109661 逐字：`/api/v2/model/list?Encode=1`）。 */
export const QODER_CN_SIGNED_MODELS_QUERY = 'Encode=1';

/** 兼容别名：既有调用方按旧名引用。 */
export const QODER_CN_MODELS_QUERY = QODER_CN_SIGNED_MODELS_QUERY;

/**
 * `cosy-version`。取自官方 worker 的硬编码常量（`s5="1.1.64"`，
 * `qoder-worker-runtime.obf.mjs` @37753）。
 *
 * 它进签名 payload，所以**改它会改签名结果** —— 服务端校验不过就是 401，
 * 且看不出是版本号不对。
 */
export const QODER_COSY_VERSION = '1.1.64';

/**
 * 出站 UA。形态取自官方 CN CLI 的 `qoder/<版本>` 模板。
 *
 * 版本与 {@link QODER_COSY_VERSION} 同源 —— 官方只有一个版本常量，三处各写
 * 一个数就是三处会漂移（本仓库此前同时存在 1.1.16 / 1.1.58 / 1.1.64）。
 */
export const QODER_CN_USER_AGENT = `qoder/${QODER_COSY_VERSION}`;


/** 请求超时。推理比查额度慢得多，30s 不够。 */
export const QODER_CHAT_TIMEOUT_MS = 120_000;

/**
 * 官方 COSY RSA 公钥（1024 位）。
 *
 * 取自官方 CN 客户端 `app.asar` → `out/main/index.js` 的常量 `cXt`，PEM 逐字节。
 * 它是**公开**的公钥，只用于包裹会话密钥，不是凭据，不含任何私密信息。
 */
export const QODER_COSY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/* ---------------- 小工具 ---------------- */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 官方 `aqe()`：UUID 去掉连字符。 */
function qoderId() {
  return crypto.randomUUID().replaceAll('-', '');
}

/* ---------------- 路径归一 ---------------- */

/**
 * 官方 `dXt()`：签名用的路径形态。
 *
 * 三步：取 pathname → 去查询串 → 去 `/algo` 前缀。**顺序不能换**：先去查询串
 * 再去前缀，否则带 `?` 的 URL 会把 `?` 后面的东西算进摘要。
 *
 * 这一步错了签名必挂，而且服务端只回 401 —— 排查方向会完全跑偏，所以单独
 * 成一个可测的导出函数。
 */
export function qoderSigningPath(url) {
  let path = String(url ?? '');
  try {
    path = new URL(path).pathname;
  } catch {
    /* 不是完整 URL 就当它是路径，按原样继续 */
  }
  const q = path.indexOf('?');
  if (q > 0) path = path.slice(0, q);
  if (path.startsWith('/algo')) path = path.slice(5);
  return path;
}

/* ---------------- 签名 ---------------- */

/**
 * 构造一次请求的 COSY 签名头。
 *
 * 复刻官方 `lXt()` + `iqe()`。要点：
 *
 * - AES 会话密钥是**每次请求随机**的 16 字节（UUID 去连字符取前 16）；
 *   IV 就是密钥本身（官方 `r.subarray(0,16)`，即前 16 字节 = 整个密钥）。
 * - `info` 是 AES-128-CBC 加密的身份 JSON，含 `security_oauth_token` —— 这才是
 *   真正的凭据所在，Authorization 里不带任何明文令牌。
 * - `Cosy-Key` 是 RSA-PKCS1 包裹的**会话密钥**（不是凭据）。
 * - 摘要串是 `payload\nkey\ntimestamp\nbody\npath`，五段用 `\n` 连。
 *
 * @param {object} identity  `{ uid, name?, email?, securityToken }`
 * @param {object} options   `{ url, body?, timestamp?, cosyVersion?, ideVersion? }`
 */
export function buildQoderCosyHeaders(identity, options = {}) {
  const uid = typeof identity?.uid === 'string' ? identity.uid : '';
  const securityToken = typeof identity?.securityToken === 'string' ? identity.securityToken : '';

  // 1) 随机会话密钥 + AES 身份块
  //
  // `aesKey` / `requestId` 可注入，**只为测试**。每个请求都用新的随机会话密钥
  // 与 requestId，于是任意两次签名**本来就不相等** —— 不注入固定值的话，
  // 「改 body 会不会改签名」这类断言永远为真，是假绿（实测踩过：去掉摘要里的
  // path 后那三条断言仍然全绿）。
  const aesKey = Buffer.from(
    typeof options.aesKey === 'string' ? options.aesKey : qoderId().slice(0, 16),
    'utf8',
  );
  const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, aesKey.subarray(0, 16));
  const infoPlain = JSON.stringify({
    uid,
    aid: '',
    name: identity?.name ?? '',
    email: identity?.email ?? '',
    security_oauth_token: securityToken,
  });
  const info = Buffer.concat([cipher.update(Buffer.from(infoPlain, 'utf8')), cipher.final()]).toString(
    'base64',
  );

  // 2) RSA 包裹会话密钥 —— 公钥是公开的，只为让服务端解出上面的 AES 密钥
  const cosyKey = crypto
    .publicEncrypt(
      { key: QODER_COSY_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      aesKey,
    )
    .toString('base64');

  // 3) payload + MD5 摘要
  const timestamp = Number.isFinite(options.timestamp)
    ? options.timestamp
    : Math.floor(Date.now() / 1000);
  const body = typeof options.body === 'string' ? options.body : '';
  const payload = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId:
        typeof options.requestId === 'string' ? options.requestId : qoderId(),
      info,
      cosyVersion: options.cosyVersion ?? QODER_COSY_VERSION,
      ideVersion: options.ideVersion ?? '1.0.0',
    }),
    'utf8',
  ).toString('base64');

  const digest = crypto
    .createHash('md5')
    .update(`${payload}\n${cosyKey}\n${timestamp}\n${body}\n${qoderSigningPath(options.url)}`, 'utf8')
    .digest('hex');

  return {
    'Cosy-User': uid,
    'Cosy-Key': cosyKey,
    'Cosy-Date': String(timestamp),
    Authorization: `Bearer COSY.${payload}.${digest}`,
  };
}

/**
 * 取签名要用的 `security_oauth_token`。
 *
 * ## 结论：`dt-` **原样可用**，不需要换 `jt-`
 *
 * 这一点与「额度查询」同源，但对推理更重要，因为它错了就是 401：
 *
 * - 官方客户端把 `access_token` **直接**写进 `security_oauth_token`
 *   （`lXt()` 里的 `security_oauth_token: t.token`），不经过任何 exchange；
 * - 参考实现明确记载：设备流 poll 返回的 `dt-…` **就是可用的长期令牌本体**，
 *   官方 `Veo()` 直接把它写进 `security_oauth_token`；`getJobToken('dt-…')`
 *   是**恒等返回（零网络）**；
 * - 而 `/api/v1/jobToken/exchange` 是 **PAT 专用**端点，把 `dt-` 提交过去会回
 *   HTTP 400 `BadRequest`。
 *
 * 所以本函数**不发起任何网络请求**：有 `jt-` 就用 `jt-`，否则原样用 `dt-`。
 * 早期版本在这里强制要求 `jt-`，那会把一条本来能通的路直接堵死 —— 表现为
 * 「登录成功、额度查得到、但对话永远 401」，且看不出是令牌族判断错了。
 *
 * ⚠️ **唯一真正的硬约束是 `uid` 不能为空**：空 uid 必回 `101 Signature invalid`
 * （参考实现真机实录）。故 `uid` 缺失时返回 `undefined`，由调用方明确失败，
 * 而不是签一个注定失败的名。
 */
export function resolveSecurityToken(credential) {
  // 优先运行时换出来的 jt-（PAT 路径会有），其次是凭据里的 jobToken 字段
  for (const candidate of [
    credential?.jobToken,
    credential?.job_token,
    credential?.securityToken,
  ]) {
    if (typeof candidate === 'string' && candidate.startsWith('jt-')) return candidate;
  }
  // 本插件入池凭据是 dt-：恒等返回，原样作为 security_oauth_token
  const access = credential?.accessToken ?? credential?.access_token;
  if (typeof access === 'string' && access !== '') return access;
  return undefined;
}

/** 签名身份是否齐备。`uid` 为空会必回 `101 Signature invalid`。 */
export function isQoderSigningReady(credential) {
  return Boolean(credential?.userId ?? credential?.uid) && resolveSecurityToken(credential) !== undefined;
}

/**
 * 从**号池账号的凭据**构造签名身份。
 *
 * 号池里的 `account.credential` 就是落盘的凭据对象（`{ accessToken, userId,
 * userName, ... }`），这里把它映射成 `buildQoderCosyHeaders` 要的形状。
 *
 * 凭据不可用时返回 `undefined` —— **不猜、不填空串**：空 uid 签出来必回
 * `101 Signature invalid`，而那个错误的形态是「签名无效」，会把人引向反复
 * 检查签名算法，实际只是这个账号缺 uid。
 */
export function qoderIdentityOf(credential) {
  if (credential === undefined || credential === null) return undefined;
  const securityToken = resolveSecurityToken(credential);
  const uid = credential.userId ?? credential.uid;
  if (securityToken === undefined || !uid) return undefined;
  return {
    uid,
    name: credential.userName ?? credential.name ?? '',
    email: credential.email ?? '',
    securityToken,
  };
}

/* ---------------- 发送 ---------------- */

/**
 * 发一次请求，返回 `{ status, text }`。
 *
 * # 为什么不用 `fetch`
 *
 * 目录链是 **GET + body**（见 `QODER_CN_SIGNED_MODELS_QUERY` 的实测表），而
 * Node 的 `fetch` 对 GET/HEAD **直接抛错**「Request with GET/HEAD method cannot
 * have body」。所以这条链只能用 `node:https` 发。
 *
 * 推理链是 POST，`fetch` 本来可用，但走同一个发送器能让两条链的超时、错误
 * 语义保持一致 —— 尤其是「超时必须是 abort 而不是挂住」这一条。
 *
 * # 为什么超时用 `setTimeout + destroy` 而不是 `AbortSignal.timeout`
 *
 * 流式响应一旦开始，`AbortSignal.timeout` 的计时是**从请求开始**算的，长对话
 * 会被中途掐断。这里改成：响应头到达就清掉连接超时，改由调用方按「流空闲」
 * 判断（shim 侧已有 `streamIdleTimeoutMs`）。
 */
export function sendQoderRequest({ url, method = 'POST', headers, body, timeoutMs }) {
  const timeout = timeoutMs ?? QODER_CHAT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Qoder 请求 URL 非法: ${String(url)}`));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers },
      (res) => {
        // 响应头已到 —— 连接阶段结束，后续耗时交给流空闲判断
        clearTimer();
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const timer =
      timeout > 0
        ? setTimeout(() => {
            req.destroy(new Error(`Qoder 请求超时（${timeout}ms）`));
          }, timeout)
        : undefined;
    function clearTimer() {
      if (timer !== undefined) clearTimeout(timer);
    }
    req.on('error', (e) => {
      clearTimer();
      reject(e);
    });
    if (body !== undefined && body !== '') req.write(body);
    req.end();
  });
}

/**
 * 流式发一次推理请求：**响应体边收边交**，不再等 `end`。
 *
 * # 为什么必须有这个函数（真机实测，2026-10-11）
 *
 * `sendQoderRequest` 把整个响应体缓冲完才 resolve。对推理链来说这是致命的：
 * 实测一次 600 字回复，上游**首字节只要 421ms**，但收完要 **5295ms** ——
 * 全量缓冲把「421ms 就能开始流式输出」的响应，人为变成 5.3 秒的静默等待。
 *
 * 长回复越长等待越久，客户端（pi-ai / 宿主）的首字节等待窗口一旦不够，
 * 就判超时并**重发整个请求** —— 表现为「请求速率异常高 + 频繁 502」，
 * 而实际上游从没限流过（18 次并发压测零失败）。
 *
 * # 为什么不能简单地「什么都流式」
 *
 * 上游会把**业务错误塞在信封里、外层 HTTP 仍是 200**（见 `detectBusinessError`）。
 * 不先看清首帧就转发，客户端会收到 `{code,message}` 而不是 `{choices:[…]}`，
 * 表现为「模型跑不通但不报错」。所以这里采用**首帧缓冲**：
 *
 *   1. 只累积到第一帧完整信封；
 *   2. 把首帧交给 `onFirstFrame` 判定（业务错误 / 形状异常）；
 *   3. 判定通过 → 立刻开始 `onFrame` 逐帧转发，之后**不再累积**。
 *
 * 这样首字节等待 ≈ 上游首帧时间，而不是整段回复时长。
 *
 * @param {object} options
 * @param {(frame:{inner:string}|{raw:string}) => {ok:true}|{ok:false,reason:string}} [options.onFirstFrame]
 *        首帧判定；返回 ok:false 时停止转发并以 `{ failed }` resolve。
 * @param {(inner:string) => void} [options.onFrame] 每帧内层 JSON 文本。
 * @returns {Promise<{status:number, failed?:string, frameCount:number, firstFrameMs:number}>}
 */
export function streamQoderRequest({ url, method = 'POST', headers, body, timeoutMs, onFirstFrame, onFrame }) {
  const timeout = timeoutMs ?? QODER_CHAT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Qoder 请求 URL 非法: ${String(url)}`));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    let firstFrameMs = 0;
    let buffer = '';
    let sawFirstFrame = false;
    let failed;
    let frameCount = 0;

    const req = mod.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers },
      (res) => {
        clearTimer();

        // 非 200：没有可解析的流，读干后交回（由调用方按状态码分类）。
        if ((res.statusCode ?? 0) !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            frameCount: 0,
            firstFrameMs: 0,
          }));
          res.on('error', reject);
          return;
        }

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;

          // 逐行切分；最后一段可能不完整，留在 buffer 里等下一块
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const raw = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);

            if (!raw.startsWith('data:')) continue;
            const payload = raw.slice('data:'.length).trim();
            if (payload === '') continue;

            let frame;
            try {
              frame = unwrapQoderFrame(JSON.parse(payload));
            } catch {
              continue; // 非信封/非 JSON：丢弃，透传只会让客户端解析失败
            }
            if (frame.kind !== 'inner') continue;

            if (!sawFirstFrame) {
              sawFirstFrame = true;
              firstFrameMs = Date.now() - startedAt;
              if (onFirstFrame !== undefined) {
                const verdict = onFirstFrame(frame) ?? { ok: true };
                if (verdict.ok !== true) {
                  // 首帧即失败 —— 立刻停，不必等服务端把剩下的发完
                  failed = verdict.reason ?? 'first-frame-rejected';
                  req.destroy();
                  resolve({ status: 200, failed, frameCount: 0, firstFrameMs });
                  return;
                }
              }
            }

            frameCount += 1;
            onFrame?.(frame.inner);
          }
        });
        res.on('end', () => resolve({ status: 200, failed, frameCount, firstFrameMs }));
        res.on('error', reject);
      },
    );

    const timer =
      timeout > 0
        ? setTimeout(() => {
            req.destroy(new Error(`Qoder 请求超时（${timeout}ms）`));
          }, timeout)
        : undefined;
    function clearTimer() {
      if (timer !== undefined) clearTimeout(timer);
    }
    req.on('error', (e) => {
      clearTimer();
      reject(e);
    });
    if (body !== undefined && body !== '') req.write(body);
    req.end();
  });
}

/* ---------------- 模型目录 ---------------- */

/**
 * 构造「拉模型目录」的请求（`dt-` 走的**签名链**）。
 *
 * # 两条形态，都能用，但只有一条与官方同形
 *
 * | | URL | body | 头 |
 * |---|---|---|---|
 * | **官方** | `/algo/api/v2/model/list?Encode=1` | 空（签名层自产） | `auth` 签名 + `oo()` 补的 `Cosy-*` |
 * | 早期探测 | `/algo/api/v2/model/list?FetchKeys=…&AgentId=…` | 字符串 `{}` | 手写 COSY 三件套 |
 *
 * 官方（worker @19109661 / @19108378）是：
 *
 * ```js
 * let o = "/api/v2/model/list?Encode=1";
 * let A = Z5A(host, o, authManager);   // → prepareRequest(host, path, "GET", "auth", undefined, undefined)
 * fetchWithTrace({ operation:"listModels", endpointType:"infer", method:"GET",
 *                  requestClass:"model-list", path:o, url:A.url,
 *                  injectClientIdentityHeaders:!isServiceAccount,
 *                  init:{ method:"GET", headers:A.headers } })
 * ```
 *
 * 两点与推理链的关键差别：
 *
 * - **`auth` 签名模式**、body 由签名层自己决定（不再传 `'{}'`）；
 * - `requestClass` 是 **`model-list`**，**不是** `infer-sse`，所以 `oo()` 会补
 *   `Cosy-Version`/`Cosy-ClientType`/`Cosy-MachineOS`，但**不会**补
 *   `Cosy-MachineHostname`（那个只在 `infer-sse` 时加）。
 *
 * ⚠️ 用 `node:http` 发时 **`Content-Length` 仍须显式给出**：GET 带 body 时 Node
 * 走 chunked 而不会自动加长度，服务端读到空 body 与签名不一致会回 101。
 * 官方空 body 的情形同理需要 `Content-Length: 0`。
 */
export function buildQoderModelsRequest({ identity, base, timestamp, query }) {
  const search = typeof query === 'string' && query !== '' ? query : QODER_CN_SIGNED_MODELS_QUERY;
  const url = `${String(base ?? QODER_CN_CHAT_BASE).replace(/\/$/, '')}${QODER_CN_SIGNED_MODELS_PATH}?${search}`;
  // 官方空 body：签名层按空串摘要。这里显式给 `''`，长度 0。
  const body = '';
  return {
    url,
    body,
    method: 'GET',
    headers: {
      ...buildQoderCosyHeaders(identity, { url, body, timestamp }),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': QODER_CN_USER_AGENT,
      'Content-Length': Buffer.byteLength(body),
    },
  };
}

/**
 * 用**官方 wasm 指纹器**构造目录请求。
 *
 * 与 {@link buildQoderModelsRequest} 的关系同推理链：wasm 那条产出官方同形的
 * 头与签名，手写那条是兜底。差别见 {@link buildQoderModelsRequest} 的注释。
 *
 * 注意 `requestClass` 是 `model-list` 而非 `infer-sse` —— 所以这里**不补**
 * `Cosy-MachineHostname`（官方只在 `infer-sse` 时加它）。
 *
 * @param {object} options
 * @param {object} options.fingerprint 指纹器
 * @param {string} options.machineId
 * @param {string} options.uid
 * @param {string} options.securityToken
 */
export function buildQoderFingerprintedModelsRequest({
  fingerprint,
  machineId,
  uid,
  securityToken,
  organizationId = '',
  organizationTags = [],
  dataPolicyAgreed = false,
  base,
  machine,
}) {
  if (fingerprint === undefined) return undefined;
  if (typeof machineId !== 'string' || machineId === '') return undefined;
  const built = fingerprint.prepareModelsRequest({
    machineId,
    uid,
    securityToken,
    organizationId,
    organizationTags,
    dataPolicyAgreed,
    base: base ?? QODER_CN_CHAT_BASE,
    machine,
  });
  if (built === undefined) return undefined;
  return {
    url: built.url,
    body: built.body,
    method: 'GET',
    headers: { ...built.headers, 'Content-Length': Buffer.byteLength(built.body) },
  };
}


/**
 * 从目录响应里抽出模型条目。
 *
 * # 真机形状（2026-10-11 实测，14 个 chat 模型）
 *
 * ```json
 * { "chat": [ { "key": "qmodel_38max", "display_name": "Qwen3.8-Max",
 *               "max_input_tokens": 180000, "is_vl": true,
 *               "is_reasoning": true, "format": "openai",
 *               "enable": true, "price_factor": 0.2 } ],
 *   "developer": [...], "assistant": [...], "inline": [...], ... }
 * ```
 *
 * 三个要点：
 *
 * 1. **模型 id 是 `key`**（`qmodel_38max`），不是 `display_name`
 *    （`Qwen3.8-Max`）。拿显示名当 id 会造出上游不认的模型，选它发请求就是
 *    404 且看不出是解析拿错了字段。
 * 2. **顶层是一个按用途分组的对象**，有 `chat` / `developer` / `assistant` /
 *    `inline` / `quest` / `qwork` / `experts` / `qwake` / `app` 等多组。
 *    本 provider 只接**对话**，所以只取 `chat` —— 取其它组会列出一堆对话用不了
 *    的模型。若 `chat` 缺失再退到别的组，总比目录为空强。
 * 3. **`enable: false` 的条目要跳过**：上游明确标了不可用。
 * 4. **`is_vl` 是图片能力**，必须解析出来并且只认严格布尔：漏掉它，13 个
 *    `is_vl: true` 的模型在 DSH 里全都变成「不支持图片」，用户一发图就被
 *    准入闸门拒掉（DSH 默认模型 `dfmodel` 正是其中之一）。
 *
 * 同时保留对旧/变体形状（`models` / `config_info_list` …）的兼容，全部走
 * 「取不到就跳过」，绝不因为一个字段缺失让整个目录变成空 —— 空目录会让
 * provider 直接下线，比少几个模型严重得多。
 *
 * @returns {Array<{id:string,name?:string,contextWindow?:number,maxTokens?:number,supportsImages?:boolean}>}
 */
export function parseQoderModelList(body) {
  let doc = body;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  if (!isRecord(doc) && !Array.isArray(doc)) return [];

  // 候选容器：真机是 `chat`，其余是旧版/变体形状的兼容。
  const candidates = [
    doc.chat,
    doc.models,
    doc.model_list,
    doc.modelList,
    doc.config_info_list,
    doc.developer,
    doc.assistant,
    doc.data?.models,
    doc.data?.model_list,
    doc.result?.models,
  ];
  let raw = candidates.find((list) => Array.isArray(list) && list.length > 0);
  if (raw === undefined) raw = candidates.find((list) => Array.isArray(list));
  if (raw === undefined && Array.isArray(doc)) raw = doc;
  if (raw === undefined) return [];

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    // 上游明确禁用（`enable: false`）的不列 —— 选了也用不了。
    if (item.enable === false) continue;
    // ⚠️ **不要用 `name` / `display_name` 兜底当 id**：那是显示名（如
    // 「Qwen3.8-Max」），与作为请求参数的 id 不是一回事。认不出的条目**跳过**，
    // 宁可少列一个也不要列一个假的。
    const id =
      item.key ?? item.id ?? item.model ?? item.model_id ?? item.config_name ?? item.modelId;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const entry = { id };
    const name = item.display_name ?? item.name ?? item.displayName;
    if (typeof name === 'string' && name !== '') entry.name = name;
    // 上下文窗口：真机给的是 `max_input_tokens`。给了就带上，让目录里的真实值
    // 覆盖兜底值 —— 上游各模型窗口差别很大（96K ~ 1M），用统一兜底会误导。
    const window = item.max_input_tokens ?? item.maxInputTokens ?? item.context_window;
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      entry.contextWindow = Math.floor(window);
    }
    const output = item.max_output_tokens ?? item.maxOutputTokens;
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
      entry.maxTokens = Math.floor(output);
    }
    // 图片能力：真机字段是 `is_vl`（vision-language）。**必须是严格布尔** ——
    // 缺失、`null`、"true" 之类一律当「上游没说」→ 纯文本。
    //
    // ⚠️ 这条判据的方向不能反：漏标（少发图片）顶多少发一张图，改上游标记或
    // `imageModelIds` 就能补回来；错标（对纯文本模型声明 image）会让 DSH 把图片
    // 原样发出去，由上游在准入之后拒绝 —— 那时错误发生在提示词已经被接受之后，
    // 用户看到的是「模型不收图片」而不是「插件标错了」，一次额度也已经扣掉。
    // 上游 14 个 chat 模型里只有 `mmodel`（MiniMax-M2.7）是 `false`，其余 13 个
    // 都是 `true`。
    const vl = item.is_vl ?? item.isVL;
    if (typeof vl === 'boolean') entry.supportsImages = vl;
    out.push(entry);
  }
  return out;
}

/* ---------------- 请求构造 ---------------- */

/**
 * 归一化请求体，使上游接受（真机定位，2026-10-11）。
 *
 * # 修的是什么
 *
 * 用户现象：用 qoder 模型做**需要工具的任务**时必定 502。落盘真实请求后
 * 拿到上游原文（此前一直只显示被截断的 `Messages with role 'tool' must b…`）：
 *
 * ```
 * Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 * ```
 *
 * 二分定位到具体消息后，对比两组：
 *
 * | 前置 assistant | 结果 |
 * |---|---|
 * | `content: "我来看看…"` + tool_calls | ✅ 上游认可 |
 * | `content: null` + tool_calls | ❌ **上游不认为它声明了 tool_calls** |
 * | `content: ""` + tool_calls | ✅ 认可 |
 * | **省略 `content` 字段** + tool_calls | ❌ 不认可 |
 *
 * 即：上游要求「声明 tool_calls 的 assistant 消息」其 `content` **必须是字符串**，
 * `null` 与缺省都不算。这让后续 `tool` 消息失去前置，于是被整条拒绝。
 *
 * pi-ai 在「模型只发工具调用、没输出文本」时正是发 `content: null`
 * （见 `openai-completions.js` 的 assistant 分支），所以纯工具轮次必挂，
 * 而带一句说明文字的轮次正常 —— 这也解释了为什么它是「时好时坏」。
 *
 * # 为什么改成空串是安全的
 *
 * 空串对上游是「有 content 但为空」，既满足格式要求，又不给模型注入任何
 * 它没说过的话。**不要**用占位文案（如 "I have processed…"）：那会把不存在
 * 的助手发言写进对话历史，模型下一轮可能被它误导。
 *
 * 只动 `content === null` 且 `tool_calls` 非空的那一种形状，其余消息原样透传。
 */
export function normalizeQoderPayload(payload) {
  if (payload === null || typeof payload !== 'object') return payload;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;
  let touched = false;
  const normalized = messages.map((message) => {
    if (
      message !== null
      && typeof message === 'object'
      && message.role === 'assistant'
      && message.content === null
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0
    ) {
      touched = true;
      return { ...message, content: '' };
    }
    return message;
  });
  return touched ? { ...payload, messages: normalized } : payload;
}

/**
 * 拼出完整的签名路径 URL。
 *
 * 查询串是官方固定参数。**不要**往里加 `model` 之类的东西 —— 模型在 body 里，
 * 拼错位置会拿到 404 且看不出原因。
 */
export function qoderChatUrl(base = QODER_CN_CHAT_BASE) {
  return `${String(base).replace(/\/$/, '')}${QODER_SIGNED_CHAT_PATH}?${QODER_SIGNED_CHAT_QUERY}`;
}

/**
 * 构造一次推理请求（不含发送）。
 *
 * # body 就是明文 JSON
 *
 * 早期版本把这里留成 `encodeBody` 注入点，因为官方客户端会把 body 用自定义
 * Base64 编码后再发（`Encode=1`）。**真机实测推翻了「这是前提」的判断**：
 * 只要查询串里**不带 `Encode`**，服务端就按明文 JSON 处理，正常回话。
 * 于是官方那个编码器（细节在 wasm 里、一直拿不到）**不再是接通推理的前提**。
 *
 * 保留 `encodeBody` 参数只为兼容既有调用方与测试：传了就用，不传就明文。
 */
export function buildQoderChatRequest({ identity, payload, base, encodeBody, timestamp }) {
  // 归一化必须在序列化**之前**（签名对 body 敏感，两边必须用同一份文本）。
  const normalized = normalizeQoderPayload(payload);
  const body =
    typeof encodeBody === 'function' ? encodeBody(normalized) : JSON.stringify(normalized ?? {});
  const url = qoderChatUrl(base);
  const headers = {
    ...buildQoderCosyHeaders(identity, { url, body, timestamp }),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': QODER_CN_USER_AGENT,
    'Content-Length': Buffer.byteLength(body),
  };
  return { url, headers, body };
}

/**
 * 用**官方 wasm 指纹器**构造一次推理请求。
 *
 * 与 {@link buildQoderChatRequest} 的差别不是「实现不同」，而是**协议不同**：
 *
 * | 项 | 手写 COSY | 官方 wasm |
 * |---|---|---|
 * | 查询串 | 不带 `Encode` | **带 `Encode=1`** |
 * | body | 明文 JSON | **自定义 Base64** |
 * | `cosyVersion` / `ideVersion` | 硬编码旧值 | 官方真实值 |
 * | 头集合 | `Cosy-User/Key/Date` | 完整 `Cosy-*` + `X-Model-*` / `Login-Version` |
 *
 * 上游两条路都收（明文那条是实测过的），但**只有这条与官方客户端同形**，
 * 所以它优先；指纹器不可用（本机没有官方安装）时才退回手写 COSY。
 *
 * ⚠️ **`Content-Length` 必须显式补**：wasm 返回的头里没有它，而我们的发送器用
 * `node:http`，POST 带 body 且无 `Content-Length` 时会走 `Transfer-Encoding:
 * chunked`。官方客户端（fetch + 显式长度）不会这样，少一个头就是一处可识别的
 * 差异。签名对 body 敏感，长度写错同样会挂。
 *
 * @param {object} options
 * @param {object} options.fingerprint   {@link createQoderFingerprint} 的返回值
 * @param {string} options.machineId     与登录同一个 machine_id
 * @param {string} options.uid
 * @param {string} options.securityToken
 * @param {object} options.payload       明文请求体（OpenAI 形状）
 */
export function buildQoderFingerprintedRequest({
  fingerprint,
  machineId,
  uid,
  securityToken,
  organizationId = '',
  organizationTags = [],
  dataPolicyAgreed = false,
  base,
  payload,
  modelSource = 'system',
  /**
   * native 机器令牌（`{ machineToken, machineType }`）。
   *
   * 官方 `Vai()` 会删掉 wasm 占位产出的 `Cosy-MachineToken/Type`，只在
   * native bridge（UMID）给出真令牌时才补回。插件通常拿不到（真令牌由官方
   * 二进制向服务端换取），此时**必须保持删除** —— 见
   * `finalizeQoderMachineHeaders` 的注释。
   */
  machine,
}) {
  if (fingerprint === undefined) return undefined;
  if (typeof machineId !== 'string' || machineId === '') return undefined;
  // 与 buildQoderChatRequest 同一套归一化 —— 两条路径发出去的 body 必须一致，
  // 否则「指纹路径能用、手写路径报错」这类差异会再次出现。
  const normalized = normalizeQoderPayload(payload);
  const modelKey =
    typeof normalized?.model === 'string' && normalized.model !== '' ? normalized.model : undefined;
  const built = fingerprint.prepareInferRequest({
    machineId,
    uid,
    securityToken,
    organizationId,
    organizationTags,
    dataPolicyAgreed,
    base: base ?? QODER_CN_CHAT_BASE,
    bodyJson: JSON.stringify(normalized ?? {}),
    modelKey,
    modelSource,
    machine,
  });
  if (built === undefined) return undefined;
  return {
    url: built.url,
    body: built.body,
    headers: { ...built.headers, 'Content-Length': Buffer.byteLength(built.body) },
  };
}

/* ---------------- SSE 信封解包 ---------------- */

/**
 * 剥掉签名路径的外层信封，取出内层。
 *
 * 真机帧形态（参考实现 2026-09-21 逐字节实录）：
 *
 * ```
 * data:{"headers":{...},"body":"{\"choices\":[...]}","statusCodeValue":200,"statusCode":"OK"}
 * ```
 *
 * 内层是**被转义成字符串的 JSON**，要再 parse 一次；收尾帧是 `"body":"[DONE]"`，
 * 即 `[DONE]` 也在信封里、**不是**裸哨兵。
 *
 * 判据要求 `statusCodeValue`（数字）与 `body`（字符串）**同时在**：只认 `body`
 * 会误伤国际版的裸帧（国际版是标准 OpenAI 帧，且业务上可以有名为 `body` 的
 * 字段），轻则丢字段重则整条流解析失败。
 *
 * @returns {{kind:'inner', inner:string}|{kind:'raw'}}
 */
export function unwrapQoderFrame(parsed) {
  if (!isRecord(parsed)) return { kind: 'raw', raw: parsed };
  if (typeof parsed.statusCodeValue !== 'number' || typeof parsed.body !== 'string') {
    return { kind: 'raw', raw: parsed };
  }
  return { kind: 'inner', inner: parsed.body };
}

/** `[DONE]` 哨兵是否在信封里（真机就是 `body:"[DONE]"`）。 */
export function isQoderDoneFrame(inner) {
  return typeof inner === 'string' && inner.trim() === '[DONE]';
}

/* ---------------- 失败分类 ---------------- */

/**
 * 把上游失败映射到「号池该做什么」。
 *
 * 与 `qoder-pool.mjs` 的 `classifyQoderFailure` 同一套 kind，但这里额外处理
 * **签名路径特有的两种情况**：
 *
 * - `Signature invalid`（业务码 101）：几乎总是 `uid` 为空或 `securityToken`
 *   不是 `jt-`。它**不是**限流，重试换号没用，且会白白再签一次。
 * - 401 在签名路径下**不应该发生**（鉴权头是 `Bearer COSY.…` 而非令牌），
 *   真出现了说明签名本身有问题，同样不该换号重试。
 */
export function classifyQoderRelayFailure({ status, body } = {}) {
  if (status === 402) return { kind: 'hard_credit' };
  if (status === 429) return { kind: 'soft_rate' };
  if (status === 404) return { kind: 'not_found' };
  if (status >= 500) return { kind: 'server' };

  const text = typeof body === 'string' ? body : '';
  if (/Signature invalid|"code"\s*:\s*"?(101|1001)/i.test(text)) return { kind: 'signature' };
  if (/insufficient|quota|balance|exhausted/i.test(text)) return { kind: 'hard_credit' };
  if (/rate.?limit|too many requests/i.test(text)) return { kind: 'soft_rate' };
  if (/TOKEN_INVALID|token.*(invalid|expired)/i.test(text)) return { kind: 'session_dead' };

  if (status === 401 || status === 403) return { kind: 'signature' };
  return { kind: 'client' };
}

/** 哪些 kind 值得「换一个账号重试」。协议类与签名类刻意不重试。 */
export function qoderRelayRetryable(kind) {
  return kind === 'hard_credit' || kind === 'soft_rate' || kind === 'session_dead';
}

/* ---------------- 号池回灌 ---------------- */

/**
 * 把一次上游失败**回灌给号池**。
 *
 * 本 fork 已删除冷却机制（完全手动语义：失败不惩罚账号、不自动换号），
 * 这里只保留一条诊断日志，**不触碰池状态** —— 429/402 之后仍会继续用
 * 当前选中账号，由用户手动切换。
 */
export function applyQoderRelayFailure(pool, accountId, { kind, resetAtMs, modelId } = {}) {
  pool?.logger?.warn?.(
    `qoder-relay: 账号 ${accountId} 上游失败 kind=${kind}（冷却已删除，不做惩罚，请手动切换账号）`,
  );
  return 'noop';
}
