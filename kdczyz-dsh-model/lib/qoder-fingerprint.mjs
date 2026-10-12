/**
 * qoder-fingerprint.mjs —— Qoder CN 的**出站指纹对齐**层。
 *
 * # 为什么需要这一层
 *
 * CN 推理走签名路径，而官方客户端生成「签名 + 自定义编码 body + 整套
 * `Cosy-*` 头」的方式**不是一个可以用纯 JS 复刻的算法**：
 *
 * 1. **签名**（COSY）的摘要串拼接在官方 wasm 内部，静态读不到；
 * 2. **body 编码**是自定义 Base64，且**与总长度/跨块状态相关** ——
 *    用官方 wasm 当预言机逐字节探测即可证明：单字节输入就已经出现映射冲突
 *    （同一个 6-bit 值在不同位置映射到不同字符）。所以「还原置换表」这条路
 *    走不通，必须用官方实现。
 *
 * # 本模块的做法：运行时从本机安装提取官方 wasm
 *
 * 官方 wasm（298,606 字节，导出 `qodercontext_*` / `generate_runtime_auth_fields`）
 * 以 base64 内联在 Qoder 客户端的 worker runtime 里：
 *
 * ```
 * /Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/
 *   node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs
 * ```
 *
 * 我们**在运行时从本机读它、提取并驱动**，而不是把厂商二进制提交进仓库
 * ——后者是再分发闭源二进制，不该做。本机没有该文件时，
 * {@link createQoderFingerprint} 返回 `undefined`，由调用方退回手写 COSY。
 *
 * # 官方的正确调用顺序（照抄，不能省步骤）
 *
 * worker 的调用链（`qoder-worker-runtime.obf.mjs` @18762192 / @19042230）是：
 *
 * ```js
 * // ① 由 uid + token 生成运行时鉴权字段
 * const e = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
 *   uid, security_oauth_token, organization_id, organization_tags, data_policy_agreed,
 * })));  // → { encrypt_user_info, key }
 *
 * // ② 建 ctx 时用**匿名占位**，不是真实身份
 * const ctx = new QoderContext(machineId, COSY_VERSION,
 *   JSON.stringify({ uid: "", encrypt_user_info: "", key: "" }),
 *   JSON.stringify(getClientMetadata()));
 *
 * // ③ 再用 refreshAuthFields 把真实身份灌进去
 * ctx.refreshAuthFields(JSON.stringify({ uid, encrypt_user_info, key, ... }));
 *
 * // ④ 生成请求
 * ctx.prepareInferRequest(base, body, modelKey, modelSource);
 * ```
 *
 * ⚠️ **跳过 ①③ 会在 HTTP 200 下拿到业务 403 `Signature invalid`**：
 * 签名 payload 里的 `info` 会是空串（实测），错误形态伪装成「签名算法不对」，
 * 很容易让人去反复改签名实现。必须按 ①②③④ 的顺序来。
 *
 * # 两个易踩的坑
 *
 * - **`userInfo` 必须带 `encrypt_user_info` 与 `key` 两个键**（可为空串）。
 *   缺任一个 `qodercontext_new` 直接返回错误（实测 `err=1`）。
 * - **`COSY_VERSION` 用 `1.1.64`**（worker 里硬编码 `s5="1.1.64"`），
 *   不是桌面宿主的 `0.4.3`，也不是旧版插件写的 `1.1.58`。
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';

/** Qoder CLI/worker 的版本号，进 `Cosy-Version` 与签名 payload。 */
export const QODER_COSY_VERSION = '1.1.64';

/** 桌面客户端版本（宿主，仅用于路径发现与日志）。 */
export const QODER_DESKTOP_VERSION = '0.4.3';

/** CN gateway（签名路径的 host）。 */
export const QODER_GATEWAY_HOST = 'https://gateway.qoder.com.cn';

/** 签名路径的查询串。**官方就带 `Encode=1`** —— body 是自定义编码。 */
export const QODER_SIGNED_CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

/** 签名路径。 */
export const QODER_SIGNED_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';

/**
 * 模型目录的签名路径。
 *
 * ⚠️ 官方传的是 **`/api/v2/model/list?Encode=1`**（不带 `/algo` 前缀）——
 * wasm 的 `Zoe()` 会在拼接时自动插 `/algo`。所以这里存的是**未加前缀**的形态，
 * 与官方调用参数逐字一致。
 */
export const QODER_SIGNED_MODELS_PATH = '/api/v2/model/list?Encode=1';

/**
 * 官方 `noe` —— `Cosy-MachineOS` 的值（worker @3060084 逐字）：
 *
 * ```js
 * noe = `${"arm64"===process.arch?"aarch64":"x64"===process.arch?"x86_64":process.arch}_${process.platform}`
 * ```
 *
 * 即 `<arch>_<platform>`，arm64 映射成 `aarch64`、x64 映射成 `x86_64`
 * （**不是** Node 的 `arm64` / `x64` 原值）。
 */
export function qoderMachineOs(arch = process.arch, platform = process.platform) {
  const mapped = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `${mapped}_${platform}`;
}

/**
 * 官方 `zei()` —— hostname 归一（worker @3052399 逐字）。
 *
 * 原逻辑三步，缺一都会与官方不同形：
 *
 * 1. 本身已是「可打印 ASCII 且首尾非空格」且 ≤96 字符 → 原样用；
 * 2. 否则把不可打印段换成 `-`、折叠连续 `-`、去首尾 `-`；
 * 3. 若发生了替换（或超长），**附加原值的 sha256 前 8 位**；超长时先截到
 *    `96 - 8 - 1` 并去尾随 `-`/空白，再附摘要。
 *
 * 结论是官方从不发「含非 ASCII 的原始 hostname」。直接发 `os.hostname()`
 * 在中文主机名等场景会产出一个官方永远不会发的值。
 */
export function normalizeQoderHostname(raw, maxLength = 96, digestLength = 8) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return '';
  /** 官方 `s$a`：可打印 ASCII，且首尾都不是空格。 */
  const printable = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u.test(trimmed);
  const digest = () => crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, digestLength);
  const withDigest = (value) => (value ? `${value}-${digest()}` : `unknown-${digest()}`);
  if (printable && trimmed.length <= maxLength) return trimmed;
  const plain = trimmed
    .replace(/[^\x21-\x7e]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const combined = withDigest(plain);
  if (combined.length <= maxLength) return combined;
  const head = combined.slice(0, maxLength - digestLength - 1).replace(/[-\s]+$/u, '');
  return withDigest(head);
}

/**
 * 官方 `Vai()` 的头收尾处理（worker @19042144 逐字）。
 *
 * wasm 的 `prepareInferRequest` 会**无条件**产出 `Cosy-MachineToken` 与
 * `Cosy-MachineType`，而官方在 native bridge（UMID）拿得到真机器令牌时**先删掉
 * 它们**，再用 `K5A()` 填真值：
 *
 * ```js
 * let s = Fc(o.headers);
 * for (let k of Object.keys(s))
 *   ["cosy-machinetoken","cosy-machinetype"].includes(k.toLowerCase()) && delete s[k];
 * return Object.assign(s, K5A());
 * // K5A(): machineToken ? { Cosy-MachineToken: token, ...machineType ? {Cosy-MachineType} : {} } : {}
 * ```
 *
 * 我们**没有** native bridge（真正的机器令牌由官方二进制向服务端换取，插件复刻
 * 不了）。所以唯一忠实的做法是照官方「拿不到就为空」的分支办：删掉这两个头。
 *
 * 不这么做就是一个可识别的形态 —— wasm 在匿名占位身份下把 `Cosy-MachineToken`
 * 填成 **machineId 本身**（实测 `Cosy-MachineToken === Cosy-MachineId`），
 * 而官方客户端从不发这种「令牌等于机器 id」的组合。
 *
 * @param {Record<string,string>} headers wasm 产出的头
 * @param {object} [machine] `{ machineToken, machineType }`，native bridge 可用时传入
 */
export function finalizeQoderMachineHeaders(headers, machine = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (lowered === 'cosy-machinetoken' || lowered === 'cosy-machinetype') continue;
    out[key] = value;
  }
  const token = typeof machine.machineToken === 'string' && machine.machineToken !== '' ? machine.machineToken : undefined;
  if (token !== undefined) {
    out['Cosy-MachineToken'] = token;
    if (typeof machine.machineType === 'string' && machine.machineType !== '') {
      out['Cosy-MachineType'] = machine.machineType;
    }
  }
  return out;
}

/**
 * 官方 worker runtime 在本机的候选位置。
 *
 * 按「随 App 打包」优先。刻意**不**下载、不缓存到插件目录：用本机既有安装，
 * 没有就退回手写实现，行为可解释。
 */
export function qoderWorkerRuntimeCandidates(env = process.env) {
  const out = [];
  const explicit = env.DSH_QODER_WORKER_RUNTIME;
  if (typeof explicit === 'string' && explicit !== '') out.push(explicit);
  const roots = [
    '/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked',
    '/Applications/Qoder.app/Contents/Resources/app.asar.unpacked',
    path.join(env.HOME ?? '', 'Applications', 'Qoder CN.app', 'Contents', 'Resources', 'app.asar.unpacked'),
  ];
  for (const root of roots) {
    if (root === '') continue;
    out.push(
      path.join(
        root,
        'node_modules',
        '@qoder-ai',
        'qoder-cn-agent-sdk',
        'dist',
        '_worker',
        'qoder-worker-runtime.obf.mjs',
      ),
    );
  }
  return out;
}

/**
 * 从 worker runtime 的源码里提取内联的 wasm 字节。
 *
 * 该文件是单行混淆产物，wasm 以 base64 字符串内联。扫描 `AGFzbQ`（`\0asm`
 * 的 base64 前缀）并按魔数校验 —— 文件里还有别的 base64（图片、sourcemap），
 * 只有校验魔数才筛得干净。
 *
 * 多个候选时取**导出符号含 `qodercontext_new`** 的那个：本机实测该文件里有
 * 6 段合法 wasm，只有一段是签名/编码用的（另外几段是别的 wasm 依赖）。
 *
 * @param {string} source 混淆源码
 * @param {object} [options]
 * @param {number} [options.minBase64Length] 最短候选长度，防「碰巧的短字面量」
 */
export function extractWasmFromRuntime(source, options = {}) {
  const minLength = options.minBase64Length ?? 1000;
  const isB64 = (ch) => /[A-Za-z0-9+/]/.test(ch);
  let best;
  let idx = -1;
  while ((idx = source.indexOf('AGFzbQ', idx + 1)) !== -1) {
    let end = idx;
    while (end < source.length && isB64(source[end])) end += 1;
    const run = source.slice(idx, end);
    // 太短的只是巧合字面量；真正的 wasm 是这个量的数量级。
    if (run.length < minLength) continue;
    const buf = Buffer.from(run, 'base64');
    if (buf.length < 8) continue;
    if (buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) continue;
    let exports = [];
    try {
      exports = WebAssembly.Module.exports(new WebAssembly.Module(buf)).map((e) => e.name);
    } catch {
      continue;
    }
    if (exports.includes('qodercontext_new')) return buf;
    if (best === undefined || buf.length > best.length) best = buf;
  }
  return best;
}
/**
 * 极简 wasm-bindgen 胶水：只实现本模块用到的那几个导出所需的导入。
 *
 * 不引入 `wasm-bindgen` 运行时 —— 官方那份胶水是内联在 33 MB 混淆产物里的，
 * 重新实现这一小撮导入比牵一整套依赖可控得多。
 */
function createGlue(bytes) {
  const heap = new Array(128).fill(undefined);
  heap.push(undefined, null, true, false);
  let heapNext = heap.length;
  let wasm;
  let cachedU8;
  let cachedDV;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  let lastVecLen = 0;

  const getU8 = () => {
    if (!cachedU8 || cachedU8.byteLength === 0) cachedU8 = new Uint8Array(wasm.memory.buffer);
    return cachedU8;
  };
  const getDV = () => {
    if (!cachedDV || cachedDV.buffer !== wasm.memory.buffer) cachedDV = new DataView(wasm.memory.buffer);
    return cachedDV;
  };
  const addHeap = (o) => {
    if (heapNext === heap.length) heap.push(heap.length + 1);
    const i = heapNext;
    heapNext = heap[i];
    heap[i] = o;
    return i;
  };
  const getHeap = (i) => heap[i];
  const dropHeap = (i) => {
    if (i < 132) return;
    heap[i] = heapNext;
    heapNext = i;
  };
  const takeHeap = (i) => {
    const r = getHeap(i);
    dropHeap(i);
    return r;
  };
  const str = (ptr, len) => decoder.decode(getU8().subarray(ptr, ptr + len));
  const bytesOf = (ptr, len) => getU8().subarray(ptr, ptr + len);

  const imports = {
    './qoder_auth_wasm_bg.js': {
      __wbg_Error_2e59b1b37a9a34c3: (a, e) => addHeap(Error(str(a, e))),
      __wbg___wbindgen_is_function_49868bde5eb1e745: (a) => typeof getHeap(a) === 'function',
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (a) => {
        const e = getHeap(a);
        return typeof e === 'object' && e !== null;
      },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (a) => typeof getHeap(a) === 'string',
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (a) => getHeap(a) === undefined,
      __wbg___wbindgen_throw_81fc77679af83bc6: (a, e) => {
        throw new Error(str(a, e));
      },
      __wbg_call_d578befcc3145dee: (...args) => {
        try {
          return addHeap(getHeap(args[0]).call(getHeap(args[1]), getHeap(args[2])));
        } catch (e) {
          wasm.__wbindgen_export(addHeap(e));
        }
      },
      __wbg_crypto_38df2bab126b63dc: (a) => addHeap(getHeap(a).crypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => {
        try {
          getHeap(args[0]).getRandomValues(getHeap(args[1]));
        } catch (e) {
          wasm.__wbindgen_export(addHeap(e));
        }
      },
      __wbg_getRandomValues_d49329ff89a07af1: (...args) => {
        try {
          globalThis.crypto.getRandomValues(bytesOf(args[0], args[1]));
        } catch (e) {
          wasm.__wbindgen_export(addHeap(e));
        }
      },
      __wbg_length_0c32cb8543c8e4c8: (a) => getHeap(a).length,
      __wbg_msCrypto_bd5a034af96bcba6: (a) => addHeap(getHeap(a).msCrypto),
      __wbg_new_99cabae501c0a8a0: () => addHeap(new Map()),
      __wbg_new_with_length_9cedd08484b73942: (a) => addHeap(new Uint8Array(a >>> 0)),
      __wbg_node_84ea875411254db1: (a) => addHeap(getHeap(a).node),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_process_44c7a14e11e9f69e: (a) => addHeap(getHeap(a).process),
      __wbg_prototypesetcall_3e05eb9545565046: (a, e, t) => {
        Uint8Array.prototype.set.call(bytesOf(a, e), getHeap(t));
      },
      __wbg_randomFillSync_6c25eac9869eb53c: (...args) => {
        try {
          getHeap(args[0]).randomFillSync(takeHeap(args[1]));
        } catch (e) {
          wasm.__wbindgen_export(addHeap(e));
        }
      },
      __wbg_require_b4edbdcf3e2a1ef0: (...args) => {
        try {
          return addHeap(createRequire_());
        } catch (e) {
          wasm.__wbindgen_export(addHeap(e));
        }
      },
      __wbg_set_08463b1df38a7e29: (a, e, t) => addHeap(getHeap(a).set(getHeap(e), getHeap(t))),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () =>
        typeof globalThis > 'u' ? 0 : addHeap(globalThis),
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => (typeof global > 'u' ? 0 : addHeap(global)),
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => (typeof self > 'u' ? 0 : addHeap(self)),
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => (typeof window > 'u' ? 0 : addHeap(window)),
      __wbg_subarray_0f98d3fb634508ad: (a, e, t) => addHeap(getHeap(a).subarray(e >>> 0, t >>> 0)),
      __wbg_versions_276b2795b1c6a219: (a) => addHeap(getHeap(a).versions),
      __wbindgen_cast_0000000000000001: (a, e) => addHeap(bytesOf(a, e)),
      __wbindgen_cast_0000000000000002: (a, e) => addHeap(str(a, e)),
      __wbindgen_object_clone_ref: (a) => addHeap(getHeap(a)),
      __wbindgen_object_drop_ref: (a) => {
        takeHeap(a);
      },
    },
  };

  /**
   * `require` 惰性实现。
   *
   * wasm 只在极少数分支里 `require()`（旧的 node crypto 回退），正常路径走的是
   * `crypto.getRandomValues`，所以这里不预先 import `node:module`。
   */
  function createRequire_() {
    if (module_require === undefined) {
      module_require = lazyRequire();
    }
    return module_require;
  }
  let module_require;
  /** 顶层 await 拿 createRequire：只在这一条分支上付代价。 */
  function lazyRequire() {
    const requireModule = (specifier) => {
      throw new Error(`qoder wasm: cannot require(${String(specifier)})`);
    };
    return requireModule;
  }

  function passString(s) {
    const buf = encoder.encode(s);
    const ptr = wasm.__wbindgen_export2(buf.length, 1) >>> 0;
    getU8().subarray(ptr, ptr + buf.length).set(buf);
    lastVecLen = buf.length;
    return ptr;
  }

  /** 调用「返回 string / RequestResult」的导出，取回结果对象指针。 */
  function callReturning(slotCount, fn) {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      fn(sp);
      const dv = getDV();
      const errFlag = dv.getInt32(sp + 8, true);
      const ptr = dv.getInt32(sp + 0, true) >>> 0;
      if (errFlag) throw new Error('qoder wasm call failed');
      // 有的导出把错误放在 +4（refreshAuthFields）
      if (slotCount === 1 && dv.getInt32(sp + 4, true)) throw new Error('qoder wasm call failed');
      return ptr;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  return {
    async init() {
      const { instance } = await WebAssembly.instantiate(bytes, imports);
      wasm = instance.exports;
      return wasm;
    },
    get wasm() {
      return wasm;
    },
    vecLen: () => lastVecLen,
    passString,
    stringAt: (ptr, len) => str(ptr, len),
    bytesAt: bytesOf,
    toObject: takeHeap,
    callReturning,
  };
}

/**
 * 提取出的 wasm 字节缓存（进程级）。
 *
 * # 为什么必须有
 *
 * 提取要**完整读一遍 33 MB 的混淆产物**再从中切出 wasm（实测每次约 40ms）。
 * 调用方 `lib/qoder.js` 已用 promise 缓存保证一次进程只建一个**实例**，
 * 但测试、诊断脚本以及将来任何第二个调用点仍会各自触发一次完整提取。
 *
 * 缓存的是**字节**而不是实例：wasm 实例带可变堆状态（`qodercontext_new`
 * 出来的 ctx 是 per-use 的），共享实例会让两次请求互相污染。字节只读，共享无副作用。
 *
 * key 用候选路径，这样一个进程里换 `runtimePath`（测试用）不会串味。
 */
const wasmBytesCache = new Map();

/**
 * 建一个可用的 Qoder 指纹器。
 *
 * @param {object} [options]
 * @param {string} [options.runtimePath] 覆盖 worker runtime 路径（测试用）
 * @param {Buffer} [options.wasmBytes]   直接给 wasm 字节（跳过提取）
 * @returns {Promise<object|undefined>}  `undefined` 表示本机找不到官方实现
 */
export async function createQoderFingerprint(options = {}) {
  /**
   * hostname 取值器。可注入**只为测试**（本机 hostname 不可预期）。
   */
  const hostnameProvider = options.hostnameProvider ?? (() => os.hostname());
  let bytes = options.wasmBytes;
  if (bytes === undefined) {
    const candidates = options.runtimePath !== undefined ? [options.runtimePath] : qoderWorkerRuntimeCandidates();
    const cacheKey = candidates.join('\u0000');
    const cached = wasmBytesCache.get(cacheKey);
    if (cached !== undefined) {
      bytes = cached;
    } else {
      for (const candidate of candidates) {
        let source;
        try {
          source = fs.readFileSync(candidate, 'utf8');
        } catch {
          continue;
        }
        bytes = extractWasmFromRuntime(source);
        if (bytes !== undefined) break;
      }
      // 只缓存成功结果：提取失败可能只是「本机还没装官方客户端」，不该被永久记住。
      if (bytes !== undefined) wasmBytesCache.set(cacheKey, bytes);
    }
  }
  if (bytes === undefined) return undefined;

  const glue = createGlue(bytes);
  let wasm;
  try {
    wasm = await glue.init();
  } catch {
    return undefined;
  }
  if (typeof wasm.qodercontext_new !== 'function') return undefined;

  const rrString = (ptr, which) => {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      if (which === 'url') wasm.requestresult_url(sp, ptr);
      else wasm.requestresult_body(sp, ptr);
      const dv = new DataView(wasm.memory.buffer);
      const p = dv.getInt32(sp + 0, true) >>> 0;
      const n = dv.getInt32(sp + 4, true) >>> 0;
      if (p === 0) return '';
      return which === 'url'
        ? glue.stringAt(p, n)
        : Buffer.from(glue.bytesAt(p, n)).toString('utf8');
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };
  const rrHeaders = (ptr) => {
    const h = glue.toObject(wasm.requestresult_headers(ptr));
    if (h instanceof Map) return Object.fromEntries(h);
    return h ?? {};
  };
  const newCtx = (machineId, cosyVersion, userInfoJson, metaJson) => {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const p1 = glue.passString(machineId);
      const l1 = glue.vecLen();
      const p2 = glue.passString(cosyVersion);
      const l2 = glue.vecLen();
      const p3 = glue.passString(userInfoJson);
      const l3 = glue.vecLen();
      const p4 = metaJson === undefined ? 0 : glue.passString(metaJson);
      const l4 = metaJson === undefined ? 0 : glue.vecLen();
      wasm.qodercontext_new(sp, p1, l1, p2, l2, p3, l3, p4, l4);
      const dv = new DataView(wasm.memory.buffer);
      if (dv.getInt32(sp + 8, true)) throw new Error('qoder wasm: qodercontext_new failed');
      return dv.getInt32(sp + 0, true) >>> 0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };
  const refreshAuth = (ctx, json) => {
    const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const p = glue.passString(json);
      const l = glue.vecLen();
      wasm.qodercontext_refreshAuthFields(sp, ctx, p, l);
      const dv = new DataView(wasm.memory.buffer);
      if (dv.getInt32(sp + 4, true)) throw new Error('qoder wasm: refreshAuthFields failed');
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };

  return {
    version: QODER_COSY_VERSION,
    /** 驱动 `generate_runtime_auth_fields`。 */
    runtimeAuthFields({ uid, securityToken, organizationId = '', organizationTags = [], dataPolicyAgreed = false }) {
      const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
      try {
        const p = glue.passString(
          JSON.stringify({
            uid,
            security_oauth_token: securityToken,
            organization_id: organizationId,
            organization_tags: organizationTags,
            data_policy_agreed: dataPolicyAgreed,
          }),
        );
        const l = glue.vecLen();
        wasm.generate_runtime_auth_fields(sp, p, l);
        const dv = new DataView(wasm.memory.buffer);
        const ptr = dv.getInt32(sp + 0, true) >>> 0;
        const len = dv.getInt32(sp + 4, true) >>> 0;
        if (ptr === 0) return undefined;
        const parsed = JSON.parse(glue.stringAt(ptr, len));
        return {
          encryptUserInfo: typeof parsed.encrypt_user_info === 'string' ? parsed.encrypt_user_info : '',
          key: typeof parsed.key === 'string' ? parsed.key : '',
        };
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
    },
    /**
     * 生成一次推理请求。
     *
     * 顺序照抄官方：占位 ctx → refreshAuthFields → prepareInferRequest。
     *
     * @returns {{url:string, headers:Record<string,string>, body:string}|undefined}
     */
    prepareInferRequest({ machineId, uid, securityToken, organizationId = '', organizationTags = [], dataPolicyAgreed = false, base = QODER_GATEWAY_HOST, bodyJson, modelKey, modelSource = 'system', machine }) {
      const runtime = this.runtimeAuthFields({ uid, securityToken, organizationId, organizationTags, dataPolicyAgreed });
      if (runtime === undefined) return undefined;
      const ctx = newCtx(machineId, QODER_COSY_VERSION, JSON.stringify({ uid: '', encrypt_user_info: '', key: '' }), JSON.stringify({}));
      refreshAuth(
        ctx,
        JSON.stringify({
          uid,
          encrypt_user_info: runtime.encryptUserInfo,
          key: runtime.key,
          organization_id: organizationId,
          organization_tags: organizationTags,
          data_policy_agreed: dataPolicyAgreed,
        }),
      );
      const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
      let rr;
      try {
        const p1 = glue.passString(base);
        const l1 = glue.vecLen();
        const p2 = glue.passString(bodyJson);
        const l2 = glue.vecLen();
        const p3 = modelKey === undefined ? 0 : glue.passString(modelKey);
        const l3 = modelKey === undefined ? 0 : glue.vecLen();
        const p4 = modelSource === undefined ? 0 : glue.passString(modelSource);
        const l4 = modelSource === undefined ? 0 : glue.vecLen();
        wasm.qodercontext_prepareInferRequest(sp, ctx, p1, l1, p2, l2, p3, l3, p4, l4);
        const dv = new DataView(wasm.memory.buffer);
        if (dv.getInt32(sp + 8, true)) throw new Error('qoder wasm: prepareInferRequest failed');
        rr = dv.getInt32(sp + 0, true) >>> 0;
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
      // ⚠️ 读取顺序**必须**是 url → body → headers。
      //
      // `requestresult_headers` 会消费掉 RequestResult 上的头表，之后再读
      // `requestresult_body` 会拿到被污染的偏移（实测：body 变成 64 KB 的
      // 整段内存，而正确值是 100 字节）。参考实现里也是先读 body 的。
      const url = rrString(rr, 'url');
      const encodedBody = rrString(rr, 'body');
      const rawHeaders = rrHeaders(rr);
      // wasm 只产出「签名 + 业务」那一层头。官方还要经过 `oo()` 包装层与
      // `Vai()` 收尾，才得到真正上线的头集合 —— 这两步在 wasm **之外**，
      // 必须由调用方补，否则与官方客户端不同形。见两个函数的注释。
      const headers = finalizeQoderMachineHeaders(rawHeaders, machine);
      if (typeof headers['Cosy-MachineOS'] !== 'string') headers['Cosy-MachineOS'] = qoderMachineOs();
      if (typeof headers['Cosy-MachineHostname'] !== 'string') {
        const hostname = normalizeQoderHostname(hostnameProvider());
        if (hostname !== '') headers['Cosy-MachineHostname'] = hostname;
      }
      return { url, headers, body: encodedBody };
    },
    /**
     * 生成一次模型目录请求。
     *
     * 官方（worker @19108378）用的是**通用** `prepareRequest`，而不是推理专用的
     * `prepareInferRequest`：
     *
     * ```js
     * Z5A(host, path, authManager)
     *   → prepareRequest(host, path, "GET", "auth", undefined, undefined)
     * ```
     *
     * 三个与推理链的差别，都会改变输出，必须照抄：
     *
     * 1. **`auth` 模式**（不是 `sign`）—— 走已认证的签名；
     * 2. **body 不传**（`undefined`），由签名层自行决定；实测产出空串；
     * 3. `requestClass` 是 **`model-list`**，**不是** `infer-sse` —— 所以按官方
     *    `oo()` 的逻辑，这条**不加** `Cosy-MachineHostname`（那个只在 infer-sse 加）。
     *
     * @returns {{url:string, headers:Record<string,string>, body:string}|undefined}
     */
    prepareModelsRequest({ machineId, uid, securityToken, organizationId = '', organizationTags = [], dataPolicyAgreed = false, base = QODER_GATEWAY_HOST, path: requestPath, machine }) {
      const runtime = this.runtimeAuthFields({ uid, securityToken, organizationId, organizationTags, dataPolicyAgreed });
      if (runtime === undefined) return undefined;
      const ctx = newCtx(machineId, QODER_COSY_VERSION, JSON.stringify({ uid: '', encrypt_user_info: '', key: '' }), JSON.stringify({}));
      refreshAuth(
        ctx,
        JSON.stringify({
          uid,
          encrypt_user_info: runtime.encryptUserInfo,
          key: runtime.key,
          organization_id: organizationId,
          organization_tags: organizationTags,
          data_policy_agreed: dataPolicyAgreed,
        }),
      );
      const signedPath =
        typeof requestPath === 'string' && requestPath !== '' ? requestPath : QODER_SIGNED_MODELS_PATH;
      const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
      let rr;
      try {
        const p1 = glue.passString(base);
        const l1 = glue.vecLen();
        const p2 = glue.passString(signedPath);
        const l2 = glue.vecLen();
        const p3 = glue.passString('GET');
        const l3 = glue.vecLen();
        const p4 = glue.passString('auth');
        const l4 = glue.vecLen();
        // 后两个可选参数（body / headers）官方都传 undefined → 指针 0。
        wasm.qodercontext_prepareRequest(sp, ctx, p1, l1, p2, l2, p3, l3, p4, l4, 0, 0, 0, 0);
        const dv = new DataView(wasm.memory.buffer);
        if (dv.getInt32(sp + 8, true)) throw new Error('qoder wasm: prepareRequest failed');
        rr = dv.getInt32(sp + 0, true) >>> 0;
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
      // 读取顺序同推理链：url → body → headers（理由见上）。
      const url = rrString(rr, 'url');
      const encodedBody = rrString(rr, 'body');
      const rawHeaders = rrHeaders(rr);
      const headers = finalizeQoderMachineHeaders(rawHeaders, machine);
      // ⚠️ 这里**刻意不加** `Cosy-MachineHostname`：官方只在 `infer-sse`
      // 时注入它，目录链的 requestClass 是 `model-list`。加上去就是一处
      // 官方客户端不会产生的形态。
      if (typeof headers['Cosy-MachineOS'] !== 'string') headers['Cosy-MachineOS'] = qoderMachineOs();
      return { url, headers, body: encodedBody };
    },
  };
}
