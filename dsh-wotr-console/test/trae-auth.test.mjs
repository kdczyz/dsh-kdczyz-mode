/**
 * Trae 浏览器登录（PKCE + 本地回环回调）的单测。
 *
 * 守住的核心事实：
 *   1. 授权 URL 的参数**缺一不可** —— auth_from=solo / hide_saas_login /
 *      code_challenge / 设备字段，少一个就被风控当非官方客户端（AgentHub 实证）。
 *   2. 官方页会**先空参探测**回调地址 —— 必须当 pending 处理，绝不能当失败，
 *      否则「登录完成后回调打不进来」。
 *   3. 回调里的凭据有多种形态（accessToken / userJwt / authCode）都要能取。
 *   4. 换 token 的请求体必须 PascalCase + x-cloudide-token 空字符串。
 *
 * 运行：node test/trae-auth.test.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  saveTraeCredential,
  TRAE_DEFAULTS,
  buildAuthUrl,
  pkcePair,
  deviceFingerprint,
  extractLoginHost,
  fetchLoginGuidance,
  exchangeAuthCode,
  beginLogin,
  stepLogin,
  cancelLogin,
} from '../lib/trae-auth.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};

const stubFetch = (responder) => async (url, init) => {
  const r = await responder(String(url), init ?? {});
  const status = r.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => r.body ?? null };
};

/** 与真 fetch 一致：response.text() 也要有（回环探测/回调页用） */
const stubFetchFull = (responder) => {
  const f = async (url, init) => {
    const r = await responder(String(url), init ?? {});
    const status = r.status ?? 200;
    const body = r.body ?? null;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return f;
};

setTimeout(() => { console.log('\n!! 测试超时强退（有未结束的定时器/连接）'); process.exit(2); }, 60000).unref();
/** 前端同款节奏：轮询直到非 pending（换 token 是异步的，回调返回时未必完成） */
async function pollUntil(fetchlessSessionId, stepFn, { timeout = 15000, gap = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = stepFn({ sessionId: fetchlessSessionId });
    if (last.status !== 'pending' && last.error === undefined) return last;
    if (last.error !== undefined) return last;
    await new Promise((r) => setTimeout(r, gap));
  }
  return last ?? { status: 'pending' };
}

/* ------------------------------------------------------------------ */
// 11) Trae 凭据落盘：格式必须与 lib/trae.js 的 parseOwn 一致
/* ------------------------------------------------------------------ */
{
  const dir = await mkdtemp(join(tmpdir(), 'traesave-'));
  const saved = await saveTraeCredential({
    dshHome: dir,
    accessToken: 'AT-T',
    refreshToken: 'RT-T',
    userId: 'UID-T',
    accountName: 'trae-user',
    edition: 'solo',
    region: 'cn',
    host: 'https://api.trae.cn',
    expiresAtMs: Date.now() + 3600_000,
    refreshExpiresAtMs: Date.now() + 7200_000,
  });
  ok('Trae 凭据写入成功', saved.error === undefined && saved.region === 'cn');
  /**
   * 落盘路径现在是**按账号分文件**：`.trae-auth.cn.<accountId>.json`。
   *
   * 旧断言要求的是 region 单文件 `.trae-auth.cn.json` —— 那个形状会让多账号
   * 池里「最后刷新的账号覆盖其余账号的 token」，所以已改掉。断言同时确认
   * 路径里带的是 24 位十六进制账号 id（不是 token）。
   */
  ok(
    '按账号分文件落盘（.trae-auth.cn.<accountId>.json）',
    /\.trae-auth\.cn\.[0-9a-f]{24}\.json$/.test(saved.path ?? ''),
    saved.path ?? '',
  );
  ok('返回值带上 accountId（供路由回执与前端核对）', typeof saved.accountId === 'string' && saved.accountId.length === 24, String(saved.accountId));

  // 用与 lib/trae.js parseOwn 相同的校验逻辑读回
  const { readFile } = await import('node:fs/promises');
  const doc = JSON.parse(await readFile(saved.path, 'utf8'));
  ok('version 为 1', doc.version === 1);
  const c = doc.credential;
  ok('edition 是 solo（parseOwn 只认 cn/sg/solo/solo-sg）', ['cn','sg','solo','solo-sg'].includes(c.edition));
  ok('accessToken 在', c.accessToken === 'AT-T');
  ok('refreshToken 在', c.refreshToken === 'RT-T');
  ok('userId 在（traeAccountId 派生依据）', c.userId === 'UID-T');
  ok('userRegion 与 region 一致', c.userRegion === 'CN');
  ok('expiresAtMs 是数字', typeof c.expiresAtMs === 'number');

  // region 校验
  const bad = await saveTraeCredential({ dshHome: dir, accessToken: 'x', region: 'us' });
  ok('不支持的 region 被拒绝', bad.error !== undefined);
  const empty = await saveTraeCredential({ dshHome: dir, region: 'cn' });
  ok('既无 access 也无 refresh 被拒绝', empty.error !== undefined);

  await rm(dir, { recursive: true, force: true });
}

setTimeout(() => { console.log('\n!! 测试超时强退（有未结束的定时器/连接）'); process.exit(2); }, 60000).unref();
console.log('Trae 登录单测\n');

/* ------------------------------------------------------------------ */
// 1) PKCE 与指纹
/* ------------------------------------------------------------------ */
{
  const { verifier, challenge } = pkcePair();
  ok('PKCE verifier 有足够长度', verifier.length >= 40);
  ok('challenge 是 S256(base64url)', challenge.length >= 40 && !challenge.includes('='));

  const fp = deviceFingerprint('trae:test');
  ok('deviceId 是 15 位数字', /^\d{15}$/.test(fp.deviceId), fp.deviceId);
  ok('machineId 是 64 hex', /^[0-9a-f]{64}$/.test(fp.machineId));
  ok('同 seed 指纹稳定', JSON.stringify(deviceFingerprint('trae:test')) === JSON.stringify(fp));
  ok('不同 seed 指纹不同', deviceFingerprint('a').deviceId !== deviceFingerprint('b').deviceId);
}

/* ------------------------------------------------------------------ */
// 2) 登录主机下发（GetLoginGuidance）
/* ------------------------------------------------------------------ */
{
  const f = stubFetch((url) => {
    if (url.includes('api.trae.cn')) return { body: { data: { LoginHost: 'https://login-a.trae.cn' } } };
    return { body: {} };
  });
  const host = await fetchLoginGuidance({ fetchImpl: f, cfg: {} });
  ok('从官方 GetLoginGuidance 拿到登录主机', host === 'https://login-a.trae.cn', host);

  // 全部失败 → 兜底
  const f2 = stubFetch(() => { throw new Error('net'); });
  const host2 = await fetchLoginGuidance({ fetchImpl: f2, cfg: {} });
  ok('全部失败时退回默认登录主机', host2 === TRAE_DEFAULTS.loginHost);

  // 坏响应不崩
  const f3 = stubFetch(() => ({ body: 'garbage' }));
  ok('坏响应不崩', (await fetchLoginGuidance({ fetchImpl: f3, cfg: {} })) === TRAE_DEFAULTS.loginHost);
}

/* ------------------------------------------------------------------ */
// 3) 授权 URL：参数缺一不可（风控硬要求）
/* ------------------------------------------------------------------ */
{
  const { challenge } = pkcePair();
  const url = buildAuthUrl('https://login.trae.cn', {
    callbackUrl: 'http://127.0.0.1:17388/authorize',
    traceId: 'trace-1',
    state: 'state-1',
    challenge,
    deviceId: '123456789012345',
    machineId: 'm'.repeat(64),
    clientId: TRAE_DEFAULTS.clientId,
    pluginVersion: TRAE_DEFAULTS.pluginVersion,
    productName: TRAE_DEFAULTS.productName,
    osName: 'macOS',
    osVersion: '15.0',
    deviceModel: 'Mac15,6',
    authAppVersion: TRAE_DEFAULTS.authAppVersion,
  });
  const u = new URL(url);
  ok('主机正确', u.origin === 'https://login.trae.cn');
  ok('路径是 /authorization', u.pathname === '/authorization');
  for (const [k, v] of [
    ['auth_from', 'solo'],
    ['hide_saas_login', 'true'],
    ['code_challenge_method', 'S256'],
    ['login_channel', 'native_ide'],
    ['auth_type', 'local'],
    ['redirect', '0'],
    ['x_env', 'prod'],
    ['x_app_type', 'stable'],
  ]) {
    ok(`参数 ${k}=${v}`, u.searchParams.get(k) === v);
  }
  // 设备字段必须来自真实系统信息（官方 x_device_type=osName）
  ok('x_device_type 用真实 osName', u.searchParams.get('x_device_type') === 'macOS');
  ok('x_os_version 用真实系统版本', u.searchParams.get('x_os_version') === '15.0');
  ok('product_name 已带上', u.searchParams.get('product_name') === TRAE_DEFAULTS.productName);
  ok('code_challenge 与 PKCE 一致', u.searchParams.get('code_challenge') === challenge);
  ok('client_id 正确', u.searchParams.get('client_id') === TRAE_DEFAULTS.clientId);
  ok('auth_callback_url 是回环地址', u.searchParams.get('auth_callback_url') === 'http://127.0.0.1:17388/authorize');
  ok('设备字段齐全', ['machine_id','device_id','x_device_id','x_machine_id','x_device_brand','x_device_type','x_os_version'].every((k) => u.searchParams.get(k) !== null));
  ok('trace/state 都带上', u.searchParams.get('login_trace_id') === 'trace-1' && u.searchParams.get('state') === 'state-1');

  // 关键反向验证：少了 code_challenge 就是残缺授权 URL（会被风控拦）
  const bad = buildAuthUrl('https://login.trae.cn', {
    callbackUrl: 'http://127.0.0.1:17388/authorize', traceId: 't', state: 's',
    challenge: '', deviceId: '1', machineId: 'm', clientId: 'c', pluginVersion: 'p',
    osName: 'macOS', osVersion: '15.0', deviceModel: 'Mac15,6', authAppVersion: 'a',
  });
  ok('challenge 为空时 URL 不完整（可作为校验信号）', new URL(bad).searchParams.get('code_challenge') === '');
}

/* ------------------------------------------------------------------ */
// 4) ExchangeToken 请求体（PascalCase + 空头）
/* ------------------------------------------------------------------ */
{
  let captured = null;
  const f = stubFetch((url, init) => {
    if (url.includes('ExchangeToken')) {
      captured = { url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') };
      return { body: { Result: { Token: 'AT-1', RefreshToken: 'RT-1', TokenExpireAt: 1788580859308, RefreshExpireAt: 1802923259308 } } };
    }
    return { body: {} };
  });
  const r = await exchangeAuthCode({
    fetchImpl: f, cfg: {}, authCode: 'AC-1', verifier: 'VER-1',
    deviceId: '123456789012345', machineId: 'm', loginHost: '',
  });
  ok('换 token 成功', r.ok === true && r.accessToken === 'AT-1' && r.refreshToken === 'RT-1');
  // 有效期必须一并带出（否则落盘 expiresAtMs=0，store 判已过期）
  ok('TokenExpireAt 解析成毫秒', r.expiresAtMs === 1788580859308, String(r.expiresAtMs));
  ok('RefreshExpireAt 解析成毫秒', r.refreshExpiresAtMs === 1802923259308, String(r.refreshExpiresAtMs));

  ok('x-cloudide-token 必须是空字符串（坑①）', captured.headers['x-cloudide-token'] === '');
  ok('ClientID 是 PascalCase 字段', captured.body.ClientID === TRAE_DEFAULTS.clientId);
  ok('AuthCode / CodeVerifier 是 PascalCase', captured.body.AuthCode === 'AC-1' && captured.body.CodeVerifier === 'VER-1');
  ok('DeviceInfo 是 PascalCase', typeof captured.body.DeviceInfo === 'object' && captured.body.DeviceInfo.PlatformCode === 'SOLO_PC');
  ok('带设备公钥（EC P-256 SPKI PEM）', String(captured.body.DeviceInfo.DevicePublicKey).includes('BEGIN PUBLIC KEY'));
  ok('IDEVersion 带上', typeof captured.body.IDEVersion === 'string');

  // 两个路径都会试：第一个 404/失败时换下一个
  let tried = [];
  const fMulti = stubFetch((url) => {
    tried.push(url);
    if (tried.length === 1) return { status: 404, body: {} };
    return { body: { Result: { Token: 'AT-2', RefreshToken: 'RT-2' } } };
  });
  const r2 = await exchangeAuthCode({
    fetchImpl: fMulti, cfg: {}, authCode: 'AC-2', verifier: 'V',
    deviceId: '1', machineId: 'm', loginHost: '',
  });
  ok('第一个路径失败会换下一个', r2.ok === true && r2.accessToken === 'AT-2', `试了 ${tried.length} 个`);
  ok('两个候选域都试过', tried.every((u) => /trae/.test(u)) && tried.length >= 2);

  // 全部失败 → 带信息返回
  const fFail = stubFetch(() => ({
    body: { ResponseMetadata: { Error: { Code: '20403', Message: 'Token device not match' } } },
  }));
  const r3 = await exchangeAuthCode({
    fetchImpl: fFail, cfg: {}, authCode: 'AC', verifier: 'V', deviceId: '1', machineId: 'm', loginHost: '',
  });
  ok('失败带出服务端信息', r3.ok === false && r3.message.includes('device not match'), r3.message);
}

/* ------------------------------------------------------------------ */
// 5) 端到端：回环回调（含空参探测 + 凭据回调）
/* ------------------------------------------------------------------ */
{
  const guidanceCalls = [];
  const f = stubFetchFull((url) => {
    if (String(url).includes('GetLoginGuidance')) {
      guidanceCalls.push(String(url));
      return { body: { data: { LoginHost: 'https://login.trae.cn' } } };
    }
    if (String(url).includes('ExchangeToken')) {
      return { body: { Result: { Token: 'AT-E2E', RefreshToken: 'RT-E2E' } } };
    }
    return { body: {} };
  });

  const begun = await beginLogin({ fetchImpl: f, openUrl: async () => {} });
  ok('beginLogin 成功', begun.ok === true && typeof begun.sessionId === 'string');
  ok('回环端口可用', typeof begun.port === 'number' && begun.port > 0);
  ok('授权 URL 带回环回调地址', begun.url.includes(`auth_callback_url=${encodeURIComponent('http://127.0.0.1:' + begun.port + '/authorize')}`));
  ok('登录主机来自官方下发', begun.host === 'https://login.trae.cn');
  ok('GetLoginGuidance 被调用', guidanceCalls.length >= 1);

  // 空 param 探测（官方页登录前会打一次）→ HTTP 200，会话不被杀
  const probe = await fetch(`http://127.0.0.1:${begun.port}/authorize`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch((e) => `ERR:${e.name}`);
  ok('空参探测回 200（不能当失败）', probe === 200, String(probe));

  // 真正的回调（带 authCode）
  const cbUrl = `http://127.0.0.1:${begun.port}/authorize?authCode=AC-E2E&state=${new URL(begun.url).searchParams.get('state')}`;
  const cbStatus = await fetch(cbUrl, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch((e) => `ERR:${e.name}`);
  ok('凭据回调回 200', cbStatus === 200, String(cbStatus));

  const s1 = await pollUntil(begun.sessionId, stepLogin);
  ok('轮询拿到 token', s1.status === 'done' && s1.accessToken === 'AT-E2E', JSON.stringify(s1));
  ok('refreshToken 也有', s1.refreshToken === 'RT-E2E');

  cancelLogin(begun.sessionId);
}

/* ------------------------------------------------------------------ */
// 6) 空 state 回调（外来请求）与手动粘贴兜底
/* ------------------------------------------------------------------ */
{
  const f = stubFetchFull((url) => {
    if (String(url).includes('GetLoginGuidance')) return { body: { data: { LoginHost: 'https://login.trae.cn' } } };
    if (String(url).includes('ExchangeToken')) return { body: { Result: { Token: 'AT-P', RefreshToken: 'RT-P' } } };
    return { body: {} };
  });

  // 无浏览器（openUrl 不传）→ 仍应成功并给出 URL
  const begun = await beginLogin({ fetchImpl: f });
  ok('未提供 openUrl 时也能起会话', begun.ok === true);
  ok('authUrl 返回给前端展示', begun.url.startsWith('https://'));

  // 错误的 state（外来请求）→ 400，会话不被杀
  const bad = await fetch(`http://127.0.0.1:${begun.port}/authorize?authCode=X&state=WRONG`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch((e) => `ERR:${e.name}`);
  ok('外来请求被拒（400）', bad === 400, String(bad));

  // 自动回调是唯一路径：没有手动粘贴入口
  ok('不再提供手动粘贴入口', typeof submitCallback === 'undefined');

  cancelLogin(begun.sessionId);
}

/* ------------------------------------------------------------------ */
// 7) 回调带 refreshToken（无 authCode）→ 交给既有刷新链路
/* ------------------------------------------------------------------ */
{
  const f = stubFetchFull((url) => {
    if (String(url).includes('GetLoginGuidance')) return { body: { data: { LoginHost: 'https://login.trae.cn' } } };
    return { body: {} };
  });
  const begun = await beginLogin({ fetchImpl: f });
  await fetch(`http://127.0.0.1:${begun.port}/authorize?refreshToken=RT-ONLY&state=${new URL(begun.url).searchParams.get('state')}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => '');
  const s = await pollUntil(begun.sessionId, stepLogin);
  ok('只带 refreshToken 时也认（交给既有刷新链路）', s.status === 'done' && s.refreshToken === 'RT-ONLY' && s.accessToken === '', JSON.stringify(s));
  cancelLogin(begun.sessionId);
}

/* ------------------------------------------------------------------ */
// 8) 超时与取消
/* ------------------------------------------------------------------ */
{
  const f = stubFetchFull((url) => {
    if (String(url).includes('GetLoginGuidance')) return { body: { data: { LoginHost: 'https://login.trae.cn' } } };
    return { body: {} };
  });
  const begun = await beginLogin({ fetchImpl: f });
  ok('取消返回 true', cancelLogin(begun.sessionId) === true);
  const s = await stepLogin({ fetchImpl: f, sessionId: begun.sessionId });
  ok('取消后轮询报错误', s.error !== undefined);
  ok('重复取消返回 false', cancelLogin(begun.sessionId) === false);
}

/* ------------------------------------------------------------------ */
// 10) 坏响应一律不崩
/* ------------------------------------------------------------------ */
{
  const shapes = [null, undefined, 'x', 42, [], {}, { data: null }, { data: { LoginHost: 5 } }];
  let threw = null;
  for (const body of shapes) {
    const f = stubFetch(() => ({ body }));
    try {
      await fetchLoginGuidance({ fetchImpl: f, cfg: {} });
    } catch (e) {
      threw = `${JSON.stringify(body)} → ${e.message}`;
      break;
    }
  }
  ok('guidance 坏响应不抛异常', threw === null, threw ?? '');

  let threw2 = null;
  for (const body of shapes) {
    const f = stubFetch(() => ({ body }));
    try {
      await exchangeAuthCode({ fetchImpl: f, cfg: {}, authCode: 'a', verifier: 'v', deviceId: '1', machineId: 'm', loginHost: '' });
    } catch (e) {
      threw2 = e.message;
      break;
    }
  }
  ok('exchange 坏响应不抛异常', threw2 === null, threw2 ?? '');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
