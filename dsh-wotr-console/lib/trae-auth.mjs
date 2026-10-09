/**
 * trae-auth.mjs —— Trae 的「浏览器登录 + 本机回环回调」。
 *
 * ## 协议（与 WorkBuddy 完全不同）
 *
 * Trae 是**真** PKCE 授权码流程，回调走**本机回环 HTTP**：
 *
 *   ① POST {apiOrigin}/cloudide/api/v3/trae/GetLoginGuidance   → 登录主机（别写死）
 *   ② 起本地回环服务 http://127.0.0.1:<port>/authorize
 *   ③ 浏览器打开 {loginHost}/authorization?…（参数缺一不可，见 buildAuthUrl）
 *   ④ 官方页回调回环地址（可能先空参探测 → 必须回 200 挂起，不能当失败）
 *   ⑤ 用回调里的 authCode 走 ExchangeToken 换 token
 *
 * ## 出处（都是实证，不是猜的）
 *
 *   - `/Applications/TRAE SOLO CN.app/Contents/Resources/app/out/main.js` 等
 *     （官方客户端 unpacked JS，clientId en1oxy7wnw8j9n 可直接看到）
 *   - github.com/bluechonk/trae-credential-reverse-engineering
 *     （ExchangeToken 的 PascalCase 字段名、三大失败码 20403/20405、设备绑定模型）
 *   - github.com/HUIdada1/AgentHub（electron/backend/proxy/discovery.cjs，可运行的参考实现：
 *     授权参数全集、空参探测挂起、GetLoginGuidance、ExchangeToken 请求体）
 *
 * ## 已知约束（如实记下）
 *
 *   - **设备绑定**：ExchangeToken 会登记设备指纹，服务器校验后续刷新与之一致
 *     （蓝球仓库坑③：官方客户端在 Windows 大版本更新后自己都刷不动，要重新登录）。
 *     我们用稳定的合成指纹，刷新一致性由 lib/trae.js 既有的 refresh 链路处理。
 *   - **按账号一份凭据文件**：登录写入 `.trae-auth.<region>.<accountId>.json`
 *     （见本文件末尾的「凭据落盘」）。同 region 可以并存多个账号 —— 它们构成
 *     lib/trae.js 的号池，由池按分配策略轮换。旧版每 region 单文件
 *     （`.trae-auth.<region>.json`）仍被 store 当作迁移源读取。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as osMod from 'node:os';
import { join } from 'node:path';

const OAUTH_PORT = 17388;
const OAUTH_TIMEOUT_MS = 180_000;

/** Trae 的默认登录配置（与官方客户端口径一致；都可在 cfg 里覆盖） */
export const TRAE_DEFAULTS = {
  clientId: 'en1oxy7wnw8j9n',
  userAgent: 'TraeClient/TTNet',
  // 官方 SOLO CN 1.107.1 的 appVersion（AgentHub 写的 3.5.66 是 Windows 旧版口径）
  authAppVersion: '1.107.1',
  pluginVersion: 'local',
  // 官方 product.json 的 nameAlias
  productName: 'TraeWork CN',
  loginHost: 'https://www.trae.cn',
  loginGuidanceUrls: [
    'https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance',
    'https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance',
    'https://www.trae.cn/cloudide/api/v3/trae/GetLoginGuidance',
  ],
  accountOrigins: ['https://api.trae.cn', 'https://api.trae.com.cn'],
};

/**
 * 采集真实系统信息（官方用 getSystemInformation() 的同名字段）。
 *
 * ⚠ 之前照 AgentHub 写死了 Windows 的值（x_device_type=windows /
 * x_os_version="Windows 11 Home China"），在 macOS 上跑就是「macOS 的浏览器
 * + Windows 设备指纹」，服务端风控判异常 → 授权页报 The user is not logged in。
 * 这里改成按真实平台取值，字段名与官方 DeviceInfo 一一对应。
 */
export function collectSystemInfo() {
  const os = osMod;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const osName = isMac ? 'macOS' : isWin ? 'windows' : 'linux';
  return {
    osName,
    // os.release(): macOS 是 Darwin 内核版本（如 24.x），官方发的是系统版本（如 15.x）。
    // 换算：Darwin 24 ≈ macOS 15，粗略对齐到官方口径。
    osVersion: isMac ? macosVersionFromDarwin(os.release?.()) : os.release?.() ?? '',
    // Node 拿不到硬件型号，如实给空串（官方取不到时也是 ?? ""）
    deviceModel: '',
    deviceManufacturer: isMac ? 'Apple Inc.' : '',
    cpuBrand: os.cpus?.()?.[0]?.model ?? '',
    hostname: os.hostname?.() ?? '',
  };
}

/** Darwin 内核版本 → macOS 产品版本（对齐官方 osVersion 口径）。 */
function macosVersionFromDarwin(release) {
  const n = Number(String(release ?? '').split('.')[0]);
  if (!Number.isFinite(n)) return '';
  // Darwin 20=Big Sur(11)，往后每 +1 对应 macOS 大版本 +1
  return n >= 20 ? String(n - 9) + '.0' : String(release ?? '');
}

/** PKCE：verifier 48B + S256 challenge（与官方/参考实现一致） */
export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 稳定设备指纹：15 位纯数字 deviceId + 64 hex machineId */
export function deviceFingerprint(seed) {
  const h = createHash('sha256').update(String(seed || '')).digest('hex');
  const digits = h.replace(/[^0-9]/g, '').padEnd(15, '0').slice(0, 15);
  return { deviceId: digits, machineId: h };
}

function trimSlash(u) {
  return String(u).replace(/\/+$/, '');
}

/** ① 官方登录主机下发：三个 CN 域依次试，拿不到用兜底。 */
export async function fetchLoginGuidance({ fetchImpl, cfg }) {
  const urls = Array.isArray(cfg.loginGuidanceUrls) && cfg.loginGuidanceUrls.length
    ? cfg.loginGuidanceUrls
    : TRAE_DEFAULTS.loginGuidanceUrls;
  const trace = randomUUID();
  const body = JSON.stringify({ loginTraceID: trace, login_trace_id: trace });
  for (const u of urls) {
    let res;
    try {
      res = await fetchImpl(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': cfg.userAgent },
        body,
      });
    } catch {
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      continue;
    }
    const host = extractLoginHost(data);
    if (host) return host;
  }
  return cfg.loginHost ?? TRAE_DEFAULTS.loginHost;
}

/** 登录主机字段名各版本不一，宽容地挖。 */
export function extractLoginHost(data) {
  const hit = dig(data, /^(loginhost|login_host|loginurl|login_url|host)$/i);
  if (hit === undefined || hit === null) return undefined;
  let s = String(hit).trim();
  if (s === '') return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  try {
    return new URL(s).origin;
  } catch {
    return undefined;
  }
}

/** 在任意嵌套对象里按 key 正则挖值。 */
function dig(value, re, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = dig(item, re, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(value)) {
    if (re.test(k)) return v;
    const nested = dig(v, re, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * ③ 构造授权地址。
 *
 * 参数**缺一不可**：auth_from=solo + hide_saas_login 决定落到 SOLO 登录页；
 * 缺 code_challenge 走不了 PKCE；少设备字段会被风控当成非官方客户端。
 * （AgentHub discovery.cjs buildTraeAuthUrl 同款）
 */
export function buildAuthUrl(host, opts) {
  const url = new URL('/authorization', trimSlash(host));
  const q = url.searchParams;
  q.set('login_version', '1');
  q.set('auth_from', 'solo');
  q.set('login_channel', 'native_ide');
  q.set('plugin_version', opts.pluginVersion);
  q.set('auth_type', 'local');
  q.set('client_id', opts.clientId);
  q.set('redirect', '0');
  q.set('login_trace_id', opts.traceId);
  q.set('state', opts.state);
  q.set('auth_callback_url', opts.callbackUrl);
  q.set('product_name', opts.productName ?? '');
  q.set('machine_id', opts.machineId);
  q.set('device_id', opts.deviceId);
  q.set('x_device_id', opts.deviceId);
  q.set('x_machine_id', opts.machineId);
  // 官方：x_device_brand=deviceModel、x_device_type=osName、x_os_version=osVersion
  // （真实系统信息，别写死平台 —— 写死 windows 会被风控判「浏览器与设备不符」）
  q.set('x_device_brand', opts.deviceModel ?? '');
  q.set('x_device_type', opts.osName ?? '');
  q.set('x_os_version', opts.osVersion ?? '');
  q.set('x_env', 'prod');
  q.set('x_app_version', opts.authAppVersion);
  q.set('x_app_type', 'stable');
  q.set('code_challenge', opts.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('hide_saas_login', 'true');
  return url.toString();
}

/** 从响应里挖有效期（毫秒）。官方可能给毫秒数字、秒数字或 ISO 字符串。 */
function pickExpiry(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      // 蓝球仓库实测 TokenExpireAt 是毫秒（1788580859308 这种 13 位）；
      // 小于 1e12 的当成秒，×1000。
      return v > 1e12 ? v : v * 1000;
    }
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

/**
 * ⑤ 授权码换令牌。
 *
 * CN 走 `/trae/api/v3/oauth/ExchangeToken` 或 `/cloudide/api/v3/trae/oauth/ExchangeToken`
 * 两个路径都试；`x-cloudide-token` 必须是**空字符串**（带旧 token 或省略头都会失败，
 * 蓝球仓库坑①）；字段名必须 PascalCase（坑②）。
 *
 * @returns {{ok:true, accessToken, refreshToken}|{ok:false, message}}
 */
export async function exchangeAuthCode({ fetchImpl, cfg, authCode, verifier, deviceId, machineId, loginHost }) {
  // 设备公钥：EC P-256 SPKI PEM（官方客户端同款）。私钥用完即弃，不入库。
  let devicePublicKey = '';
  try {
    const { generateKeyPairSync } = await import('node:crypto');
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // format:'pem' 时返回的就是 PEM 字符串，不是 KeyObject
    devicePublicKey = typeof pair.publicKey === 'string'
      ? pair.publicKey
      : pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    /* 容错：缺失时服务器可能要求重新登录 */
  }

  // 官方 exchangeTokenByAuthCode 的 DeviceInfo：全部来自 getSystemInformation()
  const sys = collectSystemInfo();
  const deviceInfo = {
    DeviceID: deviceId,
    MachineID: machineId,
    PlatformCode: 'SOLO_PC',
    DeviceType: 'PC',
    DeviceName: sys.hostname || 'PC',
    DeviceModel: sys.deviceModel,
    ClientVersion: cfg.authAppVersion ?? TRAE_DEFAULTS.authAppVersion,
    DevicePublicKey: devicePublicKey,
    DeviceBrand: sys.deviceManufacturer,
    DeviceCPU: sys.cpuBrand,
    OSInfo: sys.osName,
    OSVersion: sys.osVersion,
  };

  const body = JSON.stringify({
    ClientID: cfg.clientId ?? TRAE_DEFAULTS.clientId,
    AuthCode: authCode,
    CodeVerifier: verifier,
    DeviceInfo: deviceInfo,
    IDEVersion: cfg.authAppVersion ?? TRAE_DEFAULTS.authAppVersion,
  });

  const origins = Array.isArray(cfg.accountOrigins) && cfg.accountOrigins.length
    ? cfg.accountOrigins
    : TRAE_DEFAULTS.accountOrigins;
  const cbOrigin = originOf(loginHost);
  const candidates = [...(cbOrigin ? [cbOrigin] : []), ...origins.map(trimSlash).filter((x) => x !== cbOrigin)];

  let lastMessage = '';
  const paths = ['/trae/api/v3/oauth/ExchangeToken', '/cloudide/api/v3/trae/oauth/ExchangeToken'];
  for (const origin of candidates) {
    for (const path of paths) {
      let res;
      try {
        res = await fetchImpl(`${origin}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': cfg.userAgent, 'x-cloudide-token': '' },
          body,
        });
      } catch (e) {
        lastMessage = e?.message ?? String(e);
        continue;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const result = data && (data.Result || data.result || data.data);
      const token = result && (result.AccessToken || result.accessToken || result.Token || result.token);
      const refreshToken = result && (result.RefreshToken || result.refreshToken || result.refresh_token);
      if (res.ok && typeof token === 'string' && token !== '') {
        // 官方响应带 TokenExpireAt / RefreshExpireAt（蓝球仓库实测字段）。
        // 必须一并带出去 —— 落盘时 expiresAtMs=0 会被 store 当成已过期。
        return {
          ok: true,
          accessToken: token.replace(/^Cloud-IDE-JWT\s+/i, ''),
          refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
          expiresAtMs: pickExpiry(result, ['TokenExpireAt', 'tokenExpireAt', 'TokenExpire', 'expiresAt', 'ExpireAt']),
          refreshExpiresAtMs: pickExpiry(result, ['RefreshExpireAt', 'refreshExpireAt', 'RefreshExpire', 'refreshExpiresAt']),
        };
      }
      const err = data?.ResponseMetadata?.Error;
      const raw = err?.Message ?? err?.message ?? data?.message ?? data?.msg ?? res.message ?? `HTTP ${res.status}`;
      lastMessage = String(raw).includes('{__Message.field}')
        ? '授权码已失效或已被消费（一次性），请重新登录获取新码'
        : String(raw);
    }
  }
  return { ok: false, message: lastMessage || '授权码换取令牌失败' };
}

/**
 * 生成一次性 EC P-256 密钥对（只为拿公钥）。
 * 私钥用完即弃，不入库 —— 它只用于让服务器登记一台"新设备"。
 */

function originOf(host) {
  const s = String(host ?? '').trim();
  if (s === '') return '';
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * 会话与回环服务
 * ------------------------------------------------------------------ */

/** 回调里可算作凭据的字段（官方页在登录前会空参探测，必须区分开） */
const CRED_KEYS = [
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'userJwt', 'user_jwt', 'UserJwt', 'userInfo', 'user_info',
  'authCode', 'auth_code', 'authCodeInfo', 'auth_code_info', 'code', 'token',
];

const sessions = new Map();
const MAX_SESSIONS = 4;

function sweep() {
  const t = Date.now();
  for (const [id, s] of sessions) {
    if (s.finished || t - s.updatedAt > OAUTH_TIMEOUT_MS + 60_000) {
      try {
        s.server?.close();
      } catch {
        /* 已关 */
      }
      sessions.delete(id);
    }
  }
}

/**
 * 起一次 Trae 登录。
 *
 * 与 WorkBuddy 不同，这里必须**常驻**一个本地回环服务等官方回调，
 * 所以返回的是进行中的会话（含 close/submit），而不是一次性的轮询状态。
 *
 * @returns {{ok:true, sessionId, url, port, host}|{ok:false, message}}
 */
/**
 * 起一次 Trae 登录。
 *
 * 与 WorkBuddy 不同，这里必须**常驻**一个本地回环服务等官方回调，
 * 所以返回的是进行中的会话，而不是一次性的轮询状态。
 *
 * 回调到达时**在 handler 里同步完成换 token**（AgentHub 同款）：
 * 浏览器还在等响应，若先把 res 挂起、等前端轮询再回应，两边会互相等 —— 死锁。
 * `stepLogin` 只负责读结果，不参与完成动作。
 *
 * @returns {{ok:true, sessionId, url, port, host}|{ok:false, message}}
 */
export async function beginLogin({ fetchImpl, cfg = {}, openUrl }) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, message: '同时进行的登录太多，请先取消' };
  }
  const merged = { ...TRAE_DEFAULTS, ...cfg };

  const state = randomBytes(16).toString('hex');
  const traceId = randomUUID();
  const { verifier, challenge } = pkcePair();
  const fp = deviceFingerprint(`trae:${state}`);

  let callbackSeen = 0;   // 收到过几次带凭据的回调（探测请求不算）

  const respond = (res, tone, text) => {
    if (res === null) return;
    try {
      res.statusCode = tone === 'ok' ? 200 : 400;
      res.end(tone === 'ok' ? OK_PAGE(text) : ERR_PAGE(text));
    } catch {
      /* 客户端已断开 */
    }
  };

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/authorize') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const q = u.searchParams;
    // 官方页在用户登录前会**先空参探测**回调地址可达性（参考项目实证）：
    // 必须回 200 挂起页继续等，绝不能当失败 —— 否则登录完成后真正的回调
    // 打进来时服务器已经关了，「登录后无法回调」就是这么来的
    const hasCred = CRED_KEYS.some((k) => {
      const v = q.get(k);
      return typeof v === 'string' && v !== '';
    });
    if (!hasCred) {
      res.statusCode = 200;
      res.end(PENDING_PAGE);
      return;
    }
    const errParam = q.get('error') || q.get('error_code') || q.get('err');
    if (errParam) {
      const desc = q.get('error_description') || q.get('message') || '';
      const msg = `授权失败：${errParam}${desc ? `（${desc}）` : ''}`;
      result = { ok: false, message: msg };
      respond(res, 'err', msg);
      return;
    }
    // state 校验只挡明确的外来请求：官方页不回传我们自定义的 state，
    // 回传了却不一致 = 外来请求（只拒本次请求，不结束会话）
    const cbState = q.get('state');
    if (cbState != null && cbState !== '' && cbState !== state) {
      res.statusCode = 400;
      res.end(ERR_PAGE('state 校验不通过（非本次发起的授权会话）'));
      return;
    }
    callbackSeen++;
    // 在 handler 里同步完成：换 token → 记结果 → 回应浏览器
    // ⚠ 结果必须写进 session.result（stepLogin 读的是它），
    //   写进本函数的局部变量等于没写 —— 这里踩过：响应都回了「登录成功」，
    //   轮询却永远是 pending，因为两处存的是两个不同的 result。
    handleQuery(q, sessionRef.current)
      .then((r) => {
        session.result = r;
        session.finished = true;
        respond(res, r.ok === true ? 'ok' : 'err', r.ok === true ? '登录成功，可关闭本页' : `登录失败：${r.message ?? ''}`);
        try { server.close(); } catch { /* 已关 */ }
      })
      .catch((e) => {
        session.result = { ok: false, message: e?.message ?? String(e) };
        session.finished = true;
        respond(res, 'err', `登录失败：${session.result.message}`);
        try { server.close(); } catch { /* 已关 */ }
      });
  });

  // handleQuery 需要 session（含 verifier/设备指纹等），而 session 又要等 port/host
  // 才能建全 —— 用一个可变的引用解这个先后依赖
  const sessionRef = { current: null };

  const port = await listenLoopback(server).catch(() => null);
  if (port === null) return { ok: false, message: '回环端口监听失败' };

  const callbackUrl = `http://127.0.0.1:${port}/authorize`;
  const host = await fetchLoginGuidance({ fetchImpl, cfg: merged });
  const sys = collectSystemInfo();
  const url = buildAuthUrl(host, {
    callbackUrl,
    traceId,
    state,
    challenge,
    deviceId: fp.deviceId,
    machineId: fp.machineId,
    clientId: merged.clientId,
    pluginVersion: merged.pluginVersion,
    productName: merged.productName,
    osName: sys.osName,
    osVersion: sys.osVersion,
    deviceModel: sys.deviceModel,
    authAppVersion: merged.authAppVersion,
  });

  const sessionId = randomUUID();
  const session = {
    sessionId,
    state,
    traceId,
    verifier,
    deviceId: fp.deviceId,
    machineId: fp.machineId,
    cfg: merged,
    server,
    host,
    callbackUrl,
    fetchImpl,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finished: false,
    result: null,

  };
  sessionRef.current = session;
  sessions.set(sessionId, session);

  let opened = false;
  try {
    if (typeof openUrl === 'function') await openUrl(url);
    opened = true;
  } catch {
    /* 打不开就让前端展示链接 */
  }
  return { ok: true, sessionId, url, port, host, opened };
}

function handleQuery(q, session) {
  // 抽凭据：优先 accessToken，其次 userJwt / refreshToken 换 token，最后 authCode
  const extract = () => {
    let accessToken = String(q.get('accessToken') ?? '').replace(/^Cloud-IDE-JWT\s+/i, '');
    let refreshToken = q.get('refreshToken') ?? '';
    const userInfo = parseJsonParam(q.get('userInfo'));
    const userJwt = parseJsonParam(q.get('userJwt'));
    if (refreshToken === '' && userJwt) {
      refreshToken = String(userJwt.RefreshToken ?? userJwt.refreshToken ?? userJwt.refresh_token ?? '');
    }
    if (accessToken === '' && userJwt) {
      accessToken = String(userJwt.Token ?? userJwt.token ?? userJwt.access_token ?? '').replace(/^Cloud-IDE-JWT\s+/i, '');
    }
    const authCode = q.get('authCode') ?? q.get('code') ?? authCodeFromInfo(q.get('authCodeInfo') ?? q.get('auth_code_info'));
    const cbHost = q.get('loginHost') || q.get('login_host') || q.get('host') || '';
    const extra = {
      uid: userInfo ? String(userInfo.UserID ?? userInfo.user_id ?? userInfo.uid ?? '') : '',
      name: userInfo ? String(userInfo.ScreenName ?? userInfo.nickname ?? userInfo.name ?? '') : '',
    };
    return { accessToken, refreshToken, authCode, cbHost, extra };
  };

  const part = extract();
  return (async () => {
    if (part.accessToken !== '') {
      return { ok: true, accessToken: part.accessToken, refreshToken: part.refreshToken, extra: part.extra };
    }
    let lastMessage = '';
    if (part.refreshToken !== '') {
      // 只有 refreshToken：照常落库；access token 交给 lib/trae.js 既有的刷新链路
      // （它会在过期时用 ExchangeToken 换新）。这里不再重复实现一次换 token。
      return { ok: true, accessToken: '', refreshToken: part.refreshToken, extra: part.extra, refreshOnly: true };
    }
    if (part.authCode !== '') {
      const r = await exchangeAuthCode({
        fetchImpl: session.fetchImpl,
        cfg: session.cfg,
        authCode: part.authCode,
        verifier: session.verifier,
        deviceId: session.deviceId,
        machineId: session.machineId,
        loginHost: part.cbHost || session.host,
      });
      if (r.ok) {
        return {
          ok: true,
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          expiresAtMs: r.expiresAtMs,
          refreshExpiresAtMs: r.refreshExpiresAtMs,
          extra: part.extra,
        };
      }
      lastMessage = r.message;
    }
    return { ok: false, message: lastMessage || '回调未携带凭据（accessToken / refreshToken / authCode 都没有）' };
  })();
}

/**
 * 推进一次会话：检查回环服务有没有收到凭据，收到就换 token 并返回结果。
 * 没有则返回 pending。轮询由前端驱动（与 WorkBuddy 一致的节奏）。
 */
export function stepLogin({ sessionId }) {
  const s = sessions.get(sessionId);
  if (s === undefined) return { error: '登录会话不存在或已过期' };
  s.updatedAt = Date.now();

  // 换 token 已在回调 handler 里同步完成（AgentHub 同款）；
  // 这里只读结果 —— 早先把 res 挂起等轮询再回应，浏览器与轮询互相等，死锁。
  if (Date.now() - s.startedAt > OAUTH_TIMEOUT_MS && !s.finished) {
    return finishLogin(s, { ok: false, message: '登录超时（3 分钟），请重新发起' });
  }
  if (s.result === null) return { status: 'pending' };
  return finishPayload(s);
}

function finishLogin(session, result) {
  session.finished = true;
  session.result = result;
  // 浏览器的终态页由回调 handler 自己回应（handler 内同步完成），
  // 这里只收尾：关掉回环服务，别让端口一直占着
  try {
    session.server?.close();
  } catch {
    /* 已关 */
  }
  return finishPayload(session);
}

function finishPayload(session) {
  const r = session.result;
  if (r === null) return { status: 'pending' };
  if (r.ok !== true) return { status: 'failed', error: r.message ?? '登录失败' };
  return {
    status: 'done',
    accessToken: r.accessToken ?? '',
    refreshToken: r.refreshToken ?? '',
    expiresAtMs: r.expiresAtMs,
    refreshExpiresAtMs: r.refreshExpiresAtMs,
    identity: r.extra ?? {},
  };
}

export function cancelLogin(sessionId) {
  const s = sessions.get(sessionId);
  if (s === undefined) return false;
  try {
    s.server?.close();
  } catch {
    /* 已关 */
  }
  sessions.delete(sessionId);
  return true;
}

/* ------------------------------------------------------------------ *
 * 回调页（自包含，无外部资源）
 * ------------------------------------------------------------------ */

const PENDING_PAGE = shell('wait', '等待授权…', '请在官方登录页完成登录，完成后会自动回到这里。');
const OK_PAGE = (text) => shell('ok', '登录成功', text);
const ERR_PAGE = (text) => shell('err', '登录失败', text);

function shell(tone, title, detail) {
  const color = tone === 'ok' ? '#44e07f' : tone === 'err' ? '#f26d6d' : '#8ab4f8';
  const icon = tone === 'ok' ? '✓' : tone === 'err' ? '✕' : '…';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Trae 登录</title>
<style>body{font-family:system-ui,'PingFang SC',sans-serif;background:#0b0d0f;color:#dfe5ea;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:40px 52px;text-align:center;max-width:460px}
.mark{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 16px;font-size:28px;background:${color}1f;color:${color}}
h1{font-size:17px;margin:0 0 10px}p{font-size:13px;line-height:1.7;color:#9aa4ad;margin:0;word-break:break-all}</style></head>
<body><div class="card"><div class="mark">${icon}</div><h1>${title}</h1><p>${String(detail ?? '').replace(/[<>&]/g, '')}</p></div></body></html>`;
}

/** 回环监听：首选端口被占就退到系统随机端口。 */
function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    const onError = (e) => {
      server.removeListener('listening', onListening);
      if (e && e.code === 'EADDRINUSE') {
        // 首选端口被占：换随机端口再试。
        // 必须**重新注册 listening 监听器** —— 上面刚把它移除了，
        // 不补回来第二次 listen 成功时没人 resolve，Promise 永远挂起
        // （正是「登录启动就卡死」的根因）。
        server.once('error', reject);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(e);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(OAUTH_PORT, '127.0.0.1');
  });
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function parseJsonParam(raw) {
  if (raw === null || raw === undefined) return null;
  for (const val of [raw, decodeURIComponent(raw)]) {
    try {
      const obj = JSON.parse(val);
      if (obj !== null && typeof obj === 'object') return obj;
    } catch {
      /* 换个形态再试 */
    }
  }
  return null;
}

function authCodeFromInfo(raw) {
  const info = parseJsonParam(raw);
  if (info === null) return '';
  const v =
    info.AuthCode ?? info.authCode ?? info.auth_code ?? info.code ??
    info.Result?.AuthCode ?? info.Result?.authCode ??
    info.result?.authCode ?? info.result?.auth_code;
  return typeof v === 'string' ? v : '';
}

/* ------------------------------------------------------------------ *
 * 凭据落盘
 * ------------------------------------------------------------------ */

/**
 * 账号 id：与 lib/trae.js 的 `traeAccountId` **必须是同一个算法**。
 *
 * 为什么在这里重写一遍而不 import：`lib/trae.js` 是**另一个 Loader 入口**
 * （cordis.patch.yml 的 entry B），把它拉进本模块会连带 entry A 的依赖图里
 * 多出一个 200KB+ 的 provider 模块。公式只有两行，重复的代价比耦合小 ——
 * 代价是**两处必须同步改**，所以 test/trae-pool.test.mjs 里有一条断言
 * 专门比对两者对同一份凭据算出的 id 是否一致。
 *
 * 注意回退链与 lib/trae.js 一致：userId 为空时用 accountName，
 * 都为空才落到 "unknown"。
 */
function traeAccountIdOf({ edition, userId, accountName }) {
  const stable = `${edition}\0${userId || accountName || 'unknown'}`;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

/**
 * 插件自有凭据文件路径（与 lib/trae.js 的 traeOwnAccountAuthPath 同名同位）。
 *
 * **按账号一个文件**，不是一个 region 一个文件。原因：region 单文件会被
 * 「最后刷新的那个账号」覆盖，多账号池里其余账号的刷新结果落不下来，
 * 只能继续用（可能已过期的）桌面端凭据。
 *
 * region 单文件仍被 store 当作迁移源读取（见 lib/trae.js 的 ownCandidates），
 * 所以老配置不需要迁移动作；新登录一律写按账号的文件。
 */
function ownAccountAuthPath(dshHome, region, accountId) {
  return join(dshHome, `.trae-auth.${region}.${accountId}.json`);
}

/**
 * 把登录结果写进 Trae 的**插件自有**凭据文件。
 *
 * 格式必须与 lib/trae.js 的 parseOwn 完全一致（version:1 + credential），
 * 否则 store 读不到。region 决定文件名的区域段（cn / ai），
 * 账号段由凭据自身派生，保证同一账号重复登录只会覆盖自己那份。
 *
 * @returns {{path:string, region:string, accountId:string}|{error:string}}
 */
export async function saveTraeCredential({
  dshHome,
  accessToken,
  refreshToken,
  userId,
  accountName,
  edition = 'solo',
  region = 'cn',
  host = '',
  expiresAtMs,
  refreshExpiresAtMs,
}) {
  if (typeof dshHome !== 'string' || dshHome === '') return { error: '没有 DSH 主目录' };
  if (region !== 'cn' && region !== 'ai') return { error: `region 不支持：${region}` };
  if (typeof accessToken !== 'string' || accessToken === '') {
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      return { error: '凭据里既没有 accessToken 也没有 refreshToken' };
    }
  }
  const entry = {
    accessToken,
    refreshToken,
    userId: userId ?? '',
    host,
    userRegion: region === 'ai' ? 'SG' : 'CN',
    accountName: accountName ?? '',
    expiresAtMs: expiresAtMs ?? 0,
    refreshExpiresAtMs,
    edition,
  };
  const accountId = traeAccountIdOf(entry);
  const path = ownAccountAuthPath(dshHome, region, accountId);
  const doc = { version: 1, credential: entry };
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dshHome, { recursive: true });
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    return { error: `写入 Trae 凭据失败：${e?.message ?? String(e)}` };
  }
  return { path, region, accountId };
}
