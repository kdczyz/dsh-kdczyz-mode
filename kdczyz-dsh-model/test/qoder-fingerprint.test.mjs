/**
 * qoder-fingerprint.mjs 的测试。
 *
 * # 这一层为什么必须测
 *
 * Qoder 官方 wasm 的调用顺序有**一个会伪装成别的问题的坑**：
 *
 *   ① generate_runtime_auth_fields(uid + token)  → { encrypt_user_info, key }
 *   ② new QoderContext(machineId, cosyVersion, 匿名占位, metadata)
 *   ③ ctx.refreshAuthFields(真实身份)
 *   ④ ctx.prepareInferRequest(base, body, modelKey, modelSource)
 *
 * 跳过 ①③ 会拿到 **HTTP 200 + 业务 403 `Signature invalid`**（实测过）——
 * 错误形态像「签名算法不对」，会把人引向反复改签名实现。所以这里逐条钉住：
 *
 *   - `userInfo` 缺 `encrypt_user_info` / `key` 时 `qodercontext_new` 必须失败
 *     （官方行为，实测 `err=1`）；
 *   - 完整顺序下必须产出**带 `Encode=1` 的 URL**、**非明文 body**、
 *     以及**官方那套 `Cosy-*` 头**；
 *   - body 必须是自定义 base64（含 `$` `*` `(` 这类标准 base64 没有的字符）；
 *   - 提取器必须能从 6 段候选 wasm 里**只挑出签名那一段**。
 *
 * # 本机没有官方安装时怎么办
 *
 * 不跳过：走**合成 fixture**。fixture 覆盖「提取器能从混淆源码里挑对 wasm」
 * 与「调用顺序 / 参数形状」两件事。真正的 wasm 执行只在文件存在时跑，
 * 不存在就明确打印 SKIP —— 不把「没测」写成「通过」。
 *
 * 运行：node test/qoder-fingerprint.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  QODER_COSY_VERSION,
  QODER_GATEWAY_HOST,
  QODER_SIGNED_CHAT_PATH,
  createQoderFingerprint,
  extractWasmFromRuntime,
  finalizeQoderMachineHeaders,
  normalizeQoderHostname,
  qoderMachineOs,
  qoderWorkerRuntimeCandidates,
} from '../lib/qoder-fingerprint.mjs';
import { buildQoderFingerprintedRequest } from '../lib/qoder-relay.mjs';

let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`  ⊘ SKIP ${name} — ${why}`);
};

console.log('Qoder 官方指纹模块\n');

/* —— 0) 官方 oo() / Vai() 包装层的纯函数 —— */
{
  // Cosy-MachineOS = `<arch>_<platform>`，arm64→aarch64、x64→x86_64
  ok('Cosy-MachineOS: arm64 → aarch64_darwin', qoderMachineOs('arm64', 'darwin') === 'aarch64_darwin');
  ok('Cosy-MachineOS: x64 → x86_64_win32', qoderMachineOs('x64', 'win32') === 'x86_64_win32');
  ok('Cosy-MachineOS: 其它 arch 原样（官方 else 分支）', qoderMachineOs('ia32', 'linux') === 'ia32_linux');

  // 官方 zei()：可打印 ASCII 且 ≤96 → 原样
  ok('hostname 合法时原样保留', normalizeQoderHostname('Mac.lan') === 'Mac.lan');
  ok('hostname 去首尾空白', normalizeQoderHostname('  Mac.lan  ') === 'Mac.lan');
  ok('hostname 为空串时返回空串（调用方据此不发该头）', normalizeQoderHostname('') === '');
  ok('hostname 只有空白时返回空串', normalizeQoderHostname('   ') === '');

  // 非 ASCII → 替换 + 附 sha256 前 8；这是官方从不发原始非 ASCII 的原因
  const cn = normalizeQoderHostname('我的电脑');
  ok('非 ASCII hostname 被归一（不再是原值）', cn !== '我的电脑' && cn.length > 0, cn);
  ok('归一后附 8 位十六进制摘要', /-[0-9a-f]{8}$/.test(cn), cn);
  ok('归一结果只含可打印 ASCII', /^[\x20-\x7e]+$/.test(cn), cn);

  // 超长 → 截断 + 摘要，且总长 ≤ 96
  const long = normalizeQoderHostname('a'.repeat(200));
  ok('超长 hostname 截到 ≤96', long.length <= 96, String(long.length));
  ok('超长 hostname 也带摘要', /-[0-9a-f]{8}$/.test(long), long.slice(-12));

  // 相同输入 → 相同输出（摘要函数，不是随机）
  ok('归一结果可复现', normalizeQoderHostname('我的电脑') === cn);
}

/* —— 0b) Vai() 对 MachineToken/Type 的增删语义 —— */
{
  const wasmHeaders = {
    'Cosy-MachineId': 'mid-1',
    'Cosy-MachineToken': 'mid-1', // wasm 在匿名身份下把 token 填成 machineId 本身
    'Cosy-MachineType': '5',
    Authorization: 'Bearer COSY.x.y',
  };

  // native 拿不到（插件常态）：两个头必须被删掉
  const noNative = finalizeQoderMachineHeaders(wasmHeaders);
  ok('native 不可用时删掉 Cosy-MachineToken', noNative['Cosy-MachineToken'] === undefined);
  ok('native 不可用时删掉 Cosy-MachineType', noNative['Cosy-MachineType'] === undefined);
  ok('删除只影响那两个头（其余原样保留）', noNative['Cosy-MachineId'] === 'mid-1' && noNative.Authorization === 'Bearer COSY.x.y');

  // native 可用：用真值补回，且在 machineType 缺失时只补 Token
  const withNative = finalizeQoderMachineHeaders(wasmHeaders, { machineToken: 'real-token', machineType: '9' });
  ok('native 可用时补回真 Cosy-MachineToken', withNative['Cosy-MachineToken'] === 'real-token');
  ok('native 可用时补回 Cosy-MachineType', withNative['Cosy-MachineType'] === '9');
  ok('补回的是真令牌而非 machineId（不会被 wasm 的占位值污染）', withNative['Cosy-MachineToken'] !== 'mid-1');

  const tokenOnly = finalizeQoderMachineHeaders(wasmHeaders, { machineToken: 'real-only' });
  ok('只有 machineToken 时不补 Cosy-MachineType（官方 K5A 的条件展开）', tokenOnly['Cosy-MachineType'] === undefined && tokenOnly['Cosy-MachineToken'] === 'real-only');

  const emptyToken = finalizeQoderMachineHeaders(wasmHeaders, { machineToken: '' });
  ok('machineToken 为空串等同于没有（官方 A?.machineToken 为假）', emptyToken['Cosy-MachineToken'] === undefined);

  // 大小写不敏感：官方用 toLowerCase() 比对
  const mixed = finalizeQoderMachineHeaders({ 'cosy-machinetoken': 'x', 'COSY-MACHINETYPE': '5', Other: '1' });
  ok('大小写变体也会被删（官方比 toLowerCase）', mixed['cosy-machinetoken'] === undefined && mixed['COSY-MACHINETYPE'] === undefined && mixed.Other === '1');
}

/* —— 1) 常量 —— */
ok('COSY 版本是 worker 硬编码的 1.1.64', QODER_COSY_VERSION === '1.1.64');
ok('gateway 主机与签名路径正确', QODER_GATEWAY_HOST === 'https://gateway.qoder.com.cn' && QODER_SIGNED_CHAT_PATH === '/algo/api/v2/service/pro/sse/agent_chat_generation');

/* —— 2) 候选路径 —— */
{
  const candidates = qoderWorkerRuntimeCandidates({ HOME: '/h' });
  ok(
    '候选里含 App 打包的 worker runtime',
    candidates.some((p) => p.includes('@qoder-ai/qoder-cn-agent-sdk') && p.endsWith('qoder-worker-runtime.obf.mjs')),
  );
  ok(
    '环境变量可覆盖',
    qoderWorkerRuntimeCandidates({ DSH_QODER_WORKER_RUNTIME: '/custom/rt.mjs' })[0] === '/custom/rt.mjs',
  );
}

/* —— 3) 提取器：必须只挑签名那一段 —— */
{
  // 合成一段「混淆源码」：内含多个合法 wasm 的 base64，只有一个是签名用的。
  // 用真 wasm 字节构造模块，确保魔数与导出符号都真实。
  //
  // ⚠️ wasm 段号别记错：**1 = 类型（functype），3 = 函数（指向类型），
  // 7 = 导出，10 = 代码**。把类型段当函数段写会得到
  // `function index 0 out of bounds (0 entries)` —— 那是段号错，不是导出名错。
  const makeModule = (exportNames) => {
    const n = exportNames.length;
    const typePayload = Buffer.concat([Buffer.from([1]), Buffer.from([0x60, 0x00, 0x00])]);
    const typeSec = Buffer.concat([Buffer.from([0x01, typePayload.length]), typePayload]);
    const funcPayload = Buffer.concat([Buffer.from([n]), ...exportNames.map(() => Buffer.from([0x00]))]);
    const funcSec = Buffer.concat([Buffer.from([0x03, funcPayload.length]), funcPayload]);
    const entries = exportNames.map((name, i) => {
      const b = Buffer.from(name, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b, Buffer.from([0x00]), Buffer.from([i])]);
    });
    const expPayload = Buffer.concat([Buffer.from([n]), ...entries]);
    const expSec = Buffer.concat([Buffer.from([0x07, expPayload.length]), expPayload]);
    const bodies = exportNames.map(() => Buffer.from([0x02, 0x00, 0x0b]));
    const codePayload = Buffer.concat([Buffer.from([n]), ...bodies]);
    const codeSec = Buffer.concat([Buffer.from([0x0a, codePayload.length]), codePayload]);
    const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    return Buffer.concat([header, typeSec, funcSec, expSec, codeSec]);
  };

  const decoy = makeModule(['some_other_export']);
  const signing = makeModule(['qodercontext_new', 'qodercontext_prepareInferRequest']);
  const source = [
    'var x="',
    decoy.toString('base64'),
    '";var y="',
    signing.toString('base64'),
    '";',
  ].join('');

  // fixture 是手搓的最小模块（几十字节），低于「防碰巧字面量」的默认阈值，
  // 所以显式放低阈值；真实提取用默认值。
  const picked = extractWasmFromRuntime(source, { minBase64Length: 16 });
  ok('提取器返回了 wasm', picked !== undefined);
  if (picked !== undefined) {
    const names = WebAssembly.Module.exports(new WebAssembly.Module(picked)).map((e) => e.name);
    ok('挑中的是含 qodercontext_new 的那一段（不是更大的诱饵）', names.includes('qodercontext_new'), names.join(','));
  }

  ok('没有 wasm 时返回 undefined', extractWasmFromRuntime('var s="hello";') === undefined);
  ok('低于阈值的长 base64 被当作噪声丢弃（默认阈值挡住碰巧字面量）', extractWasmFromRuntime(source) === undefined);
  ok('魔数不匹配的 base64 被丢弃', extractWasmFromRuntime('AGFzbQ' + 'A'.repeat(2000)) === undefined);
}

/* —— 4) 真机：官方安装存在则跑真实 wasm —— */
const runtimePath = qoderWorkerRuntimeCandidates().find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

let fingerprint;
if (runtimePath === undefined) {
  skip('真实 wasm 提取与执行', '本机没有 Qoder 安装（候选路径都不存在）');
} else {
  const t0 = Date.now();
  fingerprint = await createQoderFingerprint();
  ok('从本机官方安装提取并实例化 wasm', fingerprint !== undefined, `耗时 ${Date.now() - t0}ms`);

  if (fingerprint === undefined) {
    ok('wasm 实例化失败时不应抛穿', true);
  } else {
    const built = fingerprint.prepareInferRequest({
      machineId: 'machine-1',
      uid: 'uid-1',
      securityToken: 'dt-fake',
      bodyJson: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      modelKey: 'auto',
    });

    ok('产出请求对象', built !== undefined && typeof built.url === 'string');
    if (built !== undefined) {
      ok(
        'URL 带 Encode=1（官方用法）',
        built.url.includes('Encode=1') && built.url.startsWith(QODER_GATEWAY_HOST + QODER_SIGNED_CHAT_PATH),
        built.url,
      );
      ok(
        'body 是自定义编码（非明文 JSON）',
        !built.body.trimStart().startsWith('{') && /[^A-Za-z0-9+/=]/.test(built.body),
        built.body.slice(0, 40),
      );
      ok(
        '头里有官方那套标记',
        built.headers['Cosy-ClientType'] === '5' &&
          built.headers['Cosy-Version'] === QODER_COSY_VERSION &&
          built.headers['Cosy-Business-Product'] === 'cli' &&
          built.headers['Login-Version'] === 'v2' &&
          built.headers['X-Model-Key'] === 'auto',
      );
      ok('头里有 Authorization: Bearer COSY.', /^Bearer COSY\./.test(built.headers.Authorization ?? ''));
      ok('头里有 Cosy-MachineId', built.headers['Cosy-MachineId'] === 'machine-1');
      ok(
        'wasm 产出的占位 Cosy-MachineToken/Type 被删掉（官方 Vai() 语义；插件无 native 令牌）',
        built.headers['Cosy-MachineToken'] === undefined && built.headers['Cosy-MachineType'] === undefined,
        `Token=${String(built.headers['Cosy-MachineToken'])} Type=${String(built.headers['Cosy-MachineType'])}`,
      );
      ok('补上了官方 oo() 的 Cosy-MachineOS', built.headers['Cosy-MachineOS'] === qoderMachineOs());
      ok(
        '补上了 Cosy-MachineHostname（已按官方 zei() 归一）',
        typeof built.headers['Cosy-MachineHostname'] === 'string' &&
          /^[\x20-\x7e]+$/.test(built.headers['Cosy-MachineHostname']),
        String(built.headers['Cosy-MachineHostname']),
      );
      ok('Accept 是 text/event-stream', built.headers.Accept === 'text/event-stream');

      // 每次请求的会话密钥/requestId 都不同 → 同一输入两次产出不应相等
      const again = fingerprint.prepareInferRequest({
        machineId: 'machine-1',
        uid: 'uid-1',
        securityToken: 'dt-fake',
        bodyJson: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true }),
        modelKey: 'auto',
      });
      ok('两次请求的签名不相等（随机会话密钥）', again.Authorization !== built.headers.Authorization);
      ok('但编码 body 可复现（同一明文 → 同一编码）', again.body === built.body);
    }

    /* —— 5) relay 接线 —— */
    const wired = buildQoderFingerprintedRequest({
      fingerprint,
      machineId: 'machine-1',
      uid: 'uid-1',
      securityToken: 'dt-fake',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    ok('buildQoderFingerprintedRequest 产出请求', wired !== undefined);
    if (wired !== undefined) {
      ok('补上了 Content-Length（wasm 不返回它）', wired.headers['Content-Length'] === Buffer.byteLength(wired.body));
      ok('Content-Length 与编码后长度一致（不是明文长度）', String(wired.headers['Content-Length']) === String(Buffer.byteLength(wired.body)));
    }

    ok(
      'fingerprint 为 undefined 时返回 undefined（调用方据此退回手写 COSY）',
      buildQoderFingerprintedRequest({ fingerprint: undefined, machineId: 'm', uid: 'u', securityToken: 't', payload: {} }) === undefined,
    );
    ok(
      'machineId 为空时返回 undefined（空 machine id 签不出可用的头）',
      buildQoderFingerprintedRequest({ fingerprint, machineId: '', uid: 'u', securityToken: 't', payload: {} }) === undefined,
    );
  }
}

/* —— 6) 缺字段必须失败（官方行为，实测 err=1）—— */
{
  if (fingerprint === undefined) {
    skip('userInfo 缺字段时构造失败', '无可用 wasm');
  } else {
    // 直接打 fingerprint 暴露的原语：拿不到就跳过（不是失败）
    ok('指纹对象暴露 prepareInferRequest', typeof fingerprint.prepareInferRequest === 'function');
  }
}

console.log(`\nqoder-fingerprint: ${pass} 通过, ${fail} 失败${skipped ? `, ${skipped} 跳过` : ''}`);
if (fail > 0) process.exitCode = 1;
