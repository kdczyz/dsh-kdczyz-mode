/**
 * wb-auth.mjs —— WorkBuddy 的「浏览器登录 + 回调令牌」。
 *
 * ## 协议（从官方 CLI 逆向得到，不是猜的）
 *
 * WorkBuddy **不是** OAuth 授权码流程。它是「服务端发 authUrl → 系统浏览器登录
 * → 客户端拿 state 轮询换 token」：
 *
 *   POST /v2/plugin/auth/state?platform=workbuddy    → { authUrl, state }
 *        ↓ 系统浏览器打开 authUrl，用户在页面里完成登录（邮箱/微信/Google…）
 *   GET  /v2/plugin/auth/token?state=<state>         → { accessToken, refreshToken, expiresIn… }
 *   GET  /v2/plugin/accounts                         → 账号信息（uin / uid / nickname）
 *
 * 没有 client_id、没有 redirect_uri、没有 PKCE、不需要本地 HTTP 回调服务，
 * 也不强制 deviceId。**所以不要把它改写成 OAuth 授权码流程**，那是错的。
 *
 * 出处：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/
 * codebuddy-headless.js` 的 `ExternalLinkAuthenticationProvider`
 * （fetchAuthState / loopGetToken / loopGetAccount）。
 *
 * ## 落盘凭据
 *
 * 凭据写成 `*.info` 文件，放进**池本来就在扫描的目录**，于是池无需任何改动就能
 * 把新账号认作独立账号（池按 `*.info` 逐个解析，账号 id 由 uin/uid 派生）。
 *
 * 关于加密：客户端 5.6+ 把 accessToken/refreshToken/nickname 存成 `$wbEncrypted`
 * 信封，但池的 `decryptableString()` **同时接受明文字符串**（明文直接返回，
 * 只有信封才去要 at-rest key）。插件拿不到那把 key，所以这里**写明文**——
 * 这是刻意选择，不是疏漏。文件以 0600 落盘。
 *
 * 风险如实记下：明文 token 落盘。池原本只读客户端自己加密过的文件，写明文会
 * 让本机多一份明文凭据。已用 0600 + 独立文件名降低暴露面。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

/** 登录服务前缀，与 CLI 的 prefixPath 一致 */
const API_PREFIX = '/v2/plugin';
/** 登录流程用的平台标识，取自 product.json 的 authentication.attributes */
const PLATFORM = 'workbuddy';

/** 总超时，与 CLI 的 3e5 一致 */
const LOGIN_TIMEOUT_MS = 300_000;
/** 轮询间隔，与 CLI 的 1e3 一致 */
const POLL_INTERVAL_MS = 1_000;

/**
 * 业务码：登录尚未完成。
 *
 * CLI 里 `RetryFetchToken = 11217`、`RetryFetchAccount = 12151`。
 * 但响应信封的形状我没能逐字节确认，所以**不把它当唯一判据**：拿不到
 * accessToken 就一律算「还没好」，业务码只用于写进日志。见 `isPending()`。
 */
const PENDING_CODES = new Set([11217, 12151]);

/** 一个进程内同时进行的登录会话上限，防止刷出一堆轮询 */
const MAX_SESSIONS = 8;
/** 会话空闲多久自动回收（防止用户点开就不理了，轮询白跑） */
const SESSION_TTL_MS = 10 * 60_000;

/**
 * 正在进行的登录会话。
 * sessionId（我们自己生成的 UUID，只在本机进程内有效）→ 会话状态。
 * 不给前端下发上游的 state，减少泄露面。
 */
const sessions = new Map();

function nowMs() {
  return Date.now();
}

/**
 * 从响应里抠出业务码。响应信封形状未确认，所以逐层宽容地找 code/errno。
 */
export function readEnvelopeCode(body) {
  if (body === null || typeof body !== 'object') return undefined;
  for (const key of ['code', 'errno', 'errCode', 'status']) {
    const v = body[key];
    if (typeof v === 'number') return v;
  }
  // 有些实现把业务码放在 data 里
  const data = body.data;
  if (data !== null && typeof data === 'object') return readEnvelopeCode(data);
  return undefined;
}

/**
 * 「还没登录好」的判定。
 *
 * 主判据是**没有可用的 accessToken**；业务码只作辅助。这样即使上游把 pending
 * 码换掉，或者根本不带码，轮询也不会误判成失败。
 */
export function isPending(body, data) {
  const token = pickAccessToken(data ?? body);
  if (typeof token === 'string' && token !== '') return false;
  const code = readEnvelopeCode(body);
  if (code !== undefined && !PENDING_CODES.has(code) && code !== 0) {
    // 有明确的非 pending 错误码，交给调用方当错误处理
    return false;
  }
  return true;
}

/** 从 payload 里取 accessToken（宽容：data 套一层或直接在顶层）。 */
function pickAccessToken(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const direct = payload.accessToken ?? payload.access_token;
  if (typeof direct === 'string') return direct;
  const data = payload.data;
  if (data !== null && typeof data === 'object') return pickAccessToken(data);
  return undefined;
}

/** 取嵌套对象里的字符串字段，找不到返回 undefined。 */
function pickString(payload, key) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const v = payload[key];
  if (typeof v === 'string' && v !== '') return v;
  const data = payload.data;
  if (data !== null && typeof data === 'object') return pickString(data, key);
  return undefined;
}

function pickNumber(payload, key) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const v = payload[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const data = payload.data;
  if (data !== null && typeof data === 'object') return pickNumber(data, key);
  return undefined;
}

/**
 * 统一的请求封装。
 *
 * `fetchImpl` 由调用方注入（宿主侧传 node 的 fetch，测试里传桩）。
 * 登录接口是**不带 Authorization** 的，靠 `X-No-*` 头声明这一点。
 */
async function requestJson(fetchImpl, url, init, extraHeaders) {
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
      ...(extraHeaders ?? {}),
      ...(init?.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/** 取 data 段（宽容：可能没有）。 */
function dataOf(body) {
  if (body === null || typeof body !== 'object') return null;
  const d = body.data;
  if (d !== null && typeof d === 'object') return d;
  return body;
}

/**
 * 第 1 步：向服务端要一个 authUrl 和 state。
 *
 * @returns {{authUrl: string, state: string}|{error: string}}
 */
export async function fetchAuthState(fetchImpl, baseUrl) {
  const url = `${trimSlash(baseUrl)}${API_PREFIX}/auth/state?platform=${encodeURIComponent(PLATFORM)}`;
  let out;
  try {
    out = await requestJson(fetchImpl, url, { method: 'POST' });
  } catch (e) {
    return { error: `无法连接登录服务：${e?.message ?? String(e)}` };
  }
  const data = dataOf(out.body);
  const authUrl = pickString(out.body, 'authUrl');
  const state = pickString(out.body, 'state');
  if (typeof authUrl !== 'string' || authUrl === '') {
    return { error: `登录服务没有返回 authUrl（HTTP ${out.status}）` };
  }
  if (typeof state !== 'string' || state === '') {
    return { error: '登录服务没有返回 state' };
  }
  // authUrl 必须是 http(s)，不能直接拿去 shell/浏览器打开任意协议
  let parsed;
  try {
    parsed = new URL(authUrl);
  } catch {
    return { error: 'authUrl 不是合法 URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `authUrl 协议不受支持：${parsed.protocol}` };
  }
  return { authUrl, state };
}

/**
 * 第 2 步（轮询）：用 state 换 token。
 *
 * @returns {{done: true, credential: object}|{done: false}|{error: string}}
 */
export async function pollForToken(fetchImpl, baseUrl, state) {
  const url = `${trimSlash(baseUrl)}${API_PREFIX}/auth/token?state=${encodeURIComponent(state)}`;
  let out;
  try {
    out = await requestJson(fetchImpl, url, { method: 'GET' });
  } catch (e) {
    // 网络抖动不该直接判失败，交给调用方重试
    return { done: false, transient: e?.message ?? String(e) };
  }
  const data = dataOf(out.body);
  if (isPending(out.body, data)) {
    if (!out.ok) return { done: false, transient: `HTTP ${out.status}` };
    return { done: false };
  }
  const accessToken = pickAccessToken(data ?? out.body);
  if (typeof accessToken !== 'string' || accessToken === '') {
    const msg = pickString(out.body, 'message') ?? pickString(out.body, 'error') ?? `HTTP ${out.status}`;
    return { error: `登录未返回 accessToken：${msg}` };
  }
  const payload = data ?? out.body;
  const refreshToken = pickString(payload, 'refreshToken') ?? pickString(payload, 'refresh_token');
  const expiresIn = pickNumber(payload, 'expiresIn');
  const refreshExpiresIn = pickNumber(payload, 'refreshExpiresIn');
  const t = nowMs();
  return {
    done: true,
    credential: {
      accessToken,
      refreshToken,
      tokenType: pickString(payload, 'tokenType') ?? 'Bearer',
      scope: pickString(payload, 'scope'),
      sessionState: pickString(payload, 'sessionState'),
      domain: hostOf(baseUrl),
      expiresIn,
      refreshExpiresIn,
      expiresAt: typeof expiresIn === 'number' ? t + expiresIn * 1000 : undefined,
      refreshExpiresAt: typeof refreshExpiresIn === 'number' ? t + refreshExpiresIn * 1000 : undefined,
    },
  };
}

/**
 * 第 3 步：用 accessToken 取账号身份（uin / uid / nickname）。
 *
 * 这一步**必须成功**：账号 id 由 uin/uid 派生，缺了它们多账号会撞成同一个。
 */
export async function fetchIdentity(fetchImpl, baseUrl, accessToken, state) {
  const url = `${trimSlash(baseUrl)}${API_PREFIX}/accounts`;
  let out;
  try {
    out = await requestJson(
      fetchImpl,
      url,
      { method: 'GET' },
      { Authorization: `Bearer ${accessToken}` },
    );
  } catch (e) {
    return { error: `读取账号信息失败：${e?.message ?? String(e)}` };
  }
  const data = dataOf(out.body);
  // 登录态可能还没同步完，账号接口也会 pending
  if (isPending(out.body, data) && !out.ok) {
    return { pending: true };
  }

  let list = data;
  if (Array.isArray(data?.accounts)) list = data.accounts;
  else if (Array.isArray(data?.data)) list = data.data;
  const first = Array.isArray(list) ? list[0] : list;
  const uin = pickString(out.body, 'uin');
  const uid = pickString(out.body, 'uid');
  const nickname = pickString(out.body, 'nickname');

  // 兜底：任何一层拿到就算数
  const merged = {
    uin: uin ?? pickString(first, 'uin'),
    uid: uid ?? pickString(first, 'uid'),
    nickname: nickname ?? pickString(first, 'nickname'),
  };
  if (merged.uin === undefined && merged.uid === undefined) {
    return { pending: true, reason: '账号接口还没返回 uin/uid' };
  }
  void state;
  return { identity: merged };
}

function trimSlash(u) {
  return String(u).replace(/\/+$/, '');
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * 会话管理
 * ------------------------------------------------------------------ */

function sweepSessions() {
  const t = nowMs();
  for (const [id, s] of sessions) {
    if (s.finished || t - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * 起一次登录。
 *
 * @returns {{sessionId:string, authUrl:string}|{error:string}}
 */
export async function beginLogin({ fetchImpl, baseUrl, openUrl }) {
  sweepSessions();
  if (sessions.size >= MAX_SESSIONS) {
    return { error: '同时进行的登录太多，请先取消或等待之前的完成' };
  }
  const got = await fetchAuthState(fetchImpl, baseUrl);
  if (got.error !== undefined) return { error: got.error };

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    state: got.state,
    baseUrl,
    startedAt: nowMs(),
    updatedAt: nowMs(),
    finished: false,
    credential: null,
    error: null,
  });

  // 打开浏览器。失败不算致命：用户还能从返回的 authUrl 手动打开。
  let opened = false;
  let openError = null;
  try {
    if (typeof openUrl === 'function') {
      await openUrl(got.authUrl);
      opened = true;
    }
  } catch (e) {
    openError = e?.message ?? String(e);
  }
  return { sessionId, authUrl: got.authUrl, opened, openError };
}

/**
 * 轮询一次登录状态。
 *
 * 只在**真的拿到 token** 时才继续取身份；身份还没同步好就保持 pending。
 */
export async function stepLogin({ fetchImpl, sessionId }) {
  const s = sessions.get(sessionId);
  if (s === undefined) return { error: '登录会话不存在或已过期' };
  if (s.finished) return finishPayload(s);
  s.updatedAt = nowMs();

  if (s.credential === null) {
    const r = await pollForToken(fetchImpl, s.baseUrl, s.state);
    if (r.error !== undefined) {
      s.finished = true;
      s.error = r.error;
      return finishPayload(s);
    }
    if (!r.done) {
      if (nowMs() - s.startedAt > LOGIN_TIMEOUT_MS) {
        s.finished = true;
        s.error = '登录超时：请在浏览器里完成登录后重试';
        return finishPayload(s);
      }
      return { status: 'pending' };
    }
    s.credential = r.credential;
  }

  const ident = await fetchIdentity(fetchImpl, s.baseUrl, s.credential.accessToken, s.state);
  if (ident.error !== undefined) {
    s.finished = true;
    s.error = ident.error;
    return finishPayload(s);
  }
  if (ident.pending === true) {
    // token 有了但身份还没同步，继续等（也受总超时约束）
    if (nowMs() - s.startedAt > LOGIN_TIMEOUT_MS) {
      s.finished = true;
      s.error = '登录超时：账号信息未同步';
      return finishPayload(s);
    }
    return { status: 'pending' };
  }
  s.identity = ident.identity;
  s.finished = true;
  return finishPayload(s);
}

function finishPayload(s) {
  if (s.error !== null) return { status: 'failed', error: s.error };
  if (s.finished && s.credential !== null && s.identity !== undefined) {
    return { status: 'done', credential: s.credential, identity: s.identity };
  }
  return { status: 'pending' };
}

export function cancelLogin(sessionId) {
  const s = sessions.get(sessionId);
  if (s === undefined) return false;
  s.finished = true;
  s.error = '已取消';
  sessions.delete(sessionId);
  return true;
}

/* ------------------------------------------------------------------ *
 * 凭据落盘
 * ------------------------------------------------------------------ */

/**
 * 从本机已有凭据里读出上游域名，用来决定登录打哪个站。
 *
 * 为什么不能写死：跨品牌域的 token **不通用**（`codebuddy.ai` 签发的会被
 * `workbuddy.ai` 网关拒），池也是按凭据自带的 `domain` 选上游的。登录必须打到
 * 与现有凭据同一个站，否则新账号的 token 池用不了。
 *
 * 读不到就返回 undefined，由调用方用默认值兜底。
 */
export async function readDomainFromAuthFiles(dirs) {
  for (const dir of dirs ?? []) {
    if (typeof dir !== 'string' || dir === '') continue;
    let names;
    try {
      const { readdir, readFile: rf } = await import('node:fs/promises');
      names = await readdir(dir);
      for (const name of names) {
        if (!name.endsWith('.info')) continue;
        try {
          const text = await rf(join(dir, name), 'utf8');
          const doc = JSON.parse(text);
          const domain = doc?.auth?.domain;
          if (typeof domain === 'string' && domain !== '') return domain;
        } catch {
          /* 单个文件坏了不影响其它 */
        }
      }
    } catch {
      /* 目录读不到就换下一个 */
    }
  }
  return undefined;
}

/**
 * 取登录用的上游地址。
 *
 * 优先跟本机现有凭据的 domain 一致；读不到就退回 `fallback`。
 */
export async function resolveLoginBase(dirs, fallback) {
  const domain = await readDomainFromAuthFiles(dirs);
  if (typeof domain === 'string' && domain !== '') {
    // domain 形如 www.workbuddy.cn（不带协议）
    const host = domain.includes('://') ? new URL(domain).host : domain;
    return `https://${host}`;
  }
  return fallback;
}

/**
 * 挑一个可写的凭据目录。
 *
 * 优先用池本来就在扫描的桌面目录（新账号零配置即可被发现）；
 * 它不可写时退回插件数据目录。
 *
 * @param {string[]} candidates 由调用方给出候选（来自 vendored 的 defaultDesktopAuthDirs）
 */
export async function pickAuthDir(candidates, fallbackDir) {
  for (const dir of candidates) {
    if (typeof dir !== 'string' || dir === '') continue;
    try {
      await access(dir, constants.W_OK);
      return dir;
    } catch {
      /* 换下一个 */
    }
  }
  return fallbackDir;
}

/**
 * WorkBuddy 插件自有凭据目录：DSH 主目录下的 `.wb-auth`。
 *
 * 与 Trae 的 `.trae-auth.<region>.<accountId>.json` 同思路：插件「添加账号」
 * 写在这里，不放进桌面端 app 的目录 —— 删掉桌面 app、卸载清掉它的数据目录
 * 都不影响插件账号；vendored 池的 `candidateAuthDirs()` 同时扫描桌面目录与
 * 本目录，两边账号并存、同账号按 id 合并取较新的那份。
 */
export function dshAuthDir(dshHomeDir) {
  return join(dshHomeDir, '.wb-auth');
}

/**
 * 把一个登录结果写成一个 `*.info` 凭据文件。
 *
 * 文件名字带账号 id，重复登录同一账号会**覆盖**自己那一份（幂等），
 * 不同账号各自一份 —— 这就是「多账号」的落盘形态。
 *
 * @returns {{path:string, accountId:string}|{error:string}}
 */
export async function saveCredential({ dir, credential, identity, accountIdOf, fileNameFor }) {
  if (typeof dir !== 'string' || dir === '') return { error: '没有可用的凭据目录' };
  const accountId = typeof accountIdOf === 'function' ? accountIdOf(identity) : undefined;
  if (typeof accountId !== 'string' || accountId === '') {
    return { error: '无法确定账号 id（缺少 uin/uid）' };
  }
  const file =
    typeof fileNameFor === 'function'
      ? fileNameFor(accountId)
      : `dsh-wotr-${accountId}.info`;

  const path = join(dir, file);
  const doc = {
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      tokenType: credential.tokenType ?? 'Bearer',
      domain: credential.domain ?? '',
      expiresAt: credential.expiresAt,
      refreshExpiresAt: credential.refreshExpiresAt,
      lastRefreshTime: nowMs(),
      scope: credential.scope ?? 'openid profile offline_access email',
    },
    account: {
      uin: identity.uin,
      uid: identity.uid,
      nickname: identity.nickname,
    },
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    return { error: `写入凭据失败：${e?.message ?? String(e)}` };
  }
  return { path, accountId };
}
