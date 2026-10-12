/**
 * qoder-auth.mjs —— Qoder 的「浏览器设备流登录 + 轮询取 token」。
 *
 * ## 为什么是设备流，而不是回调
 *
 * Trae 走的是**真** PKCE 授权码流程，必须在本机起一个回环 HTTP 服务等官方页
 * 回调（见 trae-auth.mjs）。Qoder 不同：它用的是**设备流**——
 *
 *   ① 本地生成 PKCE（verifier/challenge）+ nonce + machine_id
 *   ② 拼登录 URL（`{authBase}/device/selectAccounts?…`），交系统浏览器打开
 *   ③ 后台**轮询** `{openapiBase}/api/v1/deviceToken/poll?nonce&verifier&…`
 *   ④ 用户在浏览器完成授权后，某一次轮询直接拿回 `{token, refresh_token}`
 *
 * 因此本模块**不开任何监听端口**，也就不需要回调页、不需要 state 校验、
 * 不会被端口占用影响。代价是登录完成的时刻由轮询节奏决定（官方 1 秒一次）。
 *
 * 这条路是「号池」唯一可行的入池通道：Qoder 桌面端每个安装只保存一份登录
 * （在 App 里重新登录会覆盖前一个），扫本机登录态永远只能扫出一个账号；
 * 只有逐个账号显式走一次设备流，才能让多个账号并存。
 *
 * ## 与官方 CLI 的口径对齐
 *
 * - `client_id` 用 **CLI** 的那个（`QODER_CLI_CLIENT_ID`），不是桌面端的。
 * - `machine_id` 读写与官方 CLI **同一个文件**（`~/.qoder-cn/.auth/machine_id`），
 *   已存在则绝不覆盖：机器码漂移会让后续刷新链失效。
 * - 轮询里 **404 表示「用户尚未完成授权」，不是错误** —— 必须继续轮询。
 *   把它当失败会让「登录一直不完成」变成「登录直接报错」。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ *
 * 常量（都是实证口径，不是猜的）
 * ------------------------------------------------------------------ */

/** CLI 设备流共用的 client_id；桌面端另有一套，不要用。 */
export const QODER_CLI_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';

/** 登录页基址（浏览器打开的那个站）。 */
export const QODER_AUTH_BASE = 'https://qoder.cn';

/** 开放接口基址（轮询打在这里）。 */
export const QODER_CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn';

/** 登录页路径。 */
export const QODER_DEVICE_LOGIN_PATH = '/device/selectAccounts';

/** 轮询路径。 */
export const QODER_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';

/** 轮询节奏：官方 1 秒一次。 */
export const QODER_DEVICE_POLL_INTERVAL_MS = 1000;

/** 一次设备流登录的总超时（官方 5 分钟）。 */
export const QODER_DEVICE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 单个 HTTP 请求的超时。 */
export const QODER_DEVICE_REQUEST_TIMEOUT_MS = 30_000;

/** machine_id 的落盘位置（相对 home）。与官方 CLI 同路径同格式。 */
export const QODER_CN_MACHINE_ID_DIR = '.qoder-cn';
const QODER_MACHINE_ID_SUBDIR = '.auth';
const QODER_MACHINE_ID_FILE = 'machine_id';

/** 同时进行的登录会话上限。 */
const MAX_SESSIONS = 8;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 从对象里读一个字符串字段（空串视为缺失）。 */
function readString(source, key) {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(source, key) {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 令牌过期时刻。
 *
 * 两种口径都要认：`expires_at`（绝对时间，字符串）与 `expires_in`
 * （相对秒数）。`expires_in` 超过一天时按**毫秒**解释 —— 这是上游两种
 * 单位混用时的兜底，与 gurio 侧实现同一判据。
 */
function resolveExpiresAtMs(record, nowMs) {
  const absolute = readString(record, 'expires_at');
  if (absolute !== undefined) {
    const parsed = Date.parse(absolute);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const expiresIn = readNumber(record, 'expires_in');
  if (expiresIn !== undefined && expiresIn > 0) {
    const seconds = expiresIn > 86_400 ? Math.floor(expiresIn / 1000) : expiresIn;
    return nowMs + seconds * 1000;
  }
  return undefined;
}

/**
 * 解析设备令牌响应。
 *
 * 成功判据照抄官方：`typeof token === 'string'`。**不做数字强转** —— 官方用
 * `typeof`，把 `123` 转成 `'123'` 会让我们接受一个官方拒绝的响应，然后在
 * 下一跳以更难查的形态失败。
 */
export function parseQoderDeviceTokenPayload(body, nowMs = Date.now()) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body;
  const token =
    (typeof record.token === 'string' ? record.token : undefined) ??
    (typeof record.device_token === 'string' ? record.device_token : undefined) ??
    (typeof record.access_token === 'string' ? record.access_token : undefined);
  if (token === undefined) return undefined;
  const userId = readString(record, 'user_id') ?? readString(record, 'userId');
  const userName = readString(record, 'user_name') ?? readString(record, 'userName');
  const expiresAtMs = resolveExpiresAtMs(record, nowMs);
  return {
    token,
    refreshToken: readString(record, 'refresh_token'),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(userId === undefined ? {} : { userId }),
    ...(userName === undefined ? {} : { userName }),
  };
}

/* ------------------------------------------------------------------ *
 * PKCE / nonce / machine_id
 * ------------------------------------------------------------------ */

/** 生成 PKCE 对（verifier + S256 challenge）。 */
export function qoderPkcePair() {
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** 生成 nonce：把「浏览器里那次授权」与「本进程这次轮询」对上的一次性标识。 */
export function qoderNonce() {
  return randomUUID();
}

/** machine_id 的落盘绝对路径。 */
export function qoderMachineIdPath(homeDir = homedir()) {
  return join(homeDir, QODER_CN_MACHINE_ID_DIR, QODER_MACHINE_ID_SUBDIR, QODER_MACHINE_ID_FILE);
}

/**
 * 读取或生成 machine_id（36 字符 UUID 文本）。
 *
 * 三条契约：
 *   1. **已存在则读用** —— 绝不覆盖（与官方 CLI 共用同一身份）；
 *   2. 不存在则生成并落盘（目录递归创建）；
 *   3. **落盘 / 读取失败不挡登录** —— 退回内存态 UUID 继续用。
 *      磁盘不可写是环境问题，不是「用户没资格登录」。
 *
 * 读取时 `trim()`：官方可能写成「一行 + \n」，把换行当正文会让 URL 多一个 %0A。
 */
export async function readOrCreateQoderMachineId(options = {}) {
  const home = options.homeDir ?? homedir();
  const path = qoderMachineIdPath(home);
  const io = options.io ?? (await import('node:fs/promises'));

  try {
    const existing = (await io.readFile(path, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    /* 不存在 / 不可读：落到生成路径，不区分错误码 */
  }

  const generated = randomUUID();
  try {
    await io.mkdir(join(home, QODER_CN_MACHINE_ID_DIR, QODER_MACHINE_ID_SUBDIR), { recursive: true });
    await io.writeFile(path, generated);
  } catch {
    /* 落盘失败：内存态照用，不抛 */
  }
  return generated;
}

/* ------------------------------------------------------------------ *
 * 登录 URL
 * ------------------------------------------------------------------ */

/**
 * 构造设备流登录 URL。
 *
 * 字段名逐字符照抄官方：`challenge` / `challenge_method` / `nonce` /
 * `machine_id` / `client_id`。参数顺序不做要求，但**不得增删字段**。
 *
 * ⚠️ **不带 `redirect_uri`**：官方 CN 的该值是 `null`，带上会让授权页走
 * 「回调」分支而不是「设备码」分支。
 */
export function buildQoderDeviceLoginUrl({ codeChallenge, nonce, machineId, clientId = QODER_CLI_CLIENT_ID }) {
  const url = new URL(QODER_DEVICE_LOGIN_PATH, QODER_AUTH_BASE);
  url.searchParams.set('challenge', codeChallenge);
  url.searchParams.set('challenge_method', 'S256');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('machine_id', machineId);
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * 轮询
 * ------------------------------------------------------------------ */

/**
 * 轮询直到拿到令牌 / 超时 / 被取消 / 出错。
 *
 * 三类「不成功」必须区分（这是本函数的核心语义）：
 *
 * | 情况 | 动作 |
 * |---|---|
 * | **404** | 尚未授权 ⇒ 等 `intervalMs` 重试（官方节奏） |
 * | **200 但判据不满足** | 同上（授权页尚未点击时上游回 200 + 空对象） |
 * | **其它非 2xx** | **直报**，不当作「还在等授权」空转 |
 * | **传输层失败** | **直报**（断网不是「继续等」） |
 *
 * 把非 404 的失败也当成「重试」会让一个必然失败的请求空转到 5 分钟，
 * 而用户看到的只是「登录一直不完成」。
 */
export async function pollQoderDeviceToken(options) {
  const fetcher = options.fetcher ?? fetch;
  const doSleep = options.sleep ?? sleep;
  const intervalMs = options.intervalMs ?? QODER_DEVICE_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? QODER_DEVICE_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const url = new URL(QODER_DEVICE_POLL_PATH, QODER_CN_OPENAPI_BASE);
  url.searchParams.set('nonce', options.nonce);
  url.searchParams.set('verifier', options.codeVerifier);
  url.searchParams.set('challenge_method', 'S256');
  // machine_id 与登录请求**必须同一个**：两处漂移会让轮询永远拿不到令牌
  //（而授权页显示「已授权」）。
  url.searchParams.set('machine_id', options.machineId);

  for (;;) {
    if (options.signal?.aborted) throw new Error('Qoder 设备流登录已取消');
    if (Date.now() >= deadline) {
      throw new Error(
        `Qoder 设备流登录超时（${Math.round(timeoutMs / 1000)} 秒内未在浏览器完成授权）`,
      );
    }

    let response;
    try {
      response = await fetcher(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: options.signal ?? AbortSignal.timeout?.(QODER_DEVICE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // 被 abort 触发的 fetch 拒绝也走这里：先判取消，再报网络失败。
      if (options.signal?.aborted) throw new Error('Qoder 设备流登录已取消');
      throw new Error(`Qoder 设备流轮询网络失败：${error?.message ?? String(error)}`);
    }

    if (response.status === 404) {
      // 官方语义：404 = 用户还没在授权页完成选择，等一拍再问。
      await doSleep(intervalMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Qoder 设备流轮询失败：HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Qoder 设备流轮询响应不是 JSON：${raw.slice(0, 200)}`);
    }
    const payload = parseQoderDeviceTokenPayload(parsed);
    if (payload !== undefined) return payload;

    // 200 但还没令牌 = 仍在等授权，按同一节奏继续问。
    await doSleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * 登录会话
 * ------------------------------------------------------------------ */

/**
 * 进行中的设备流登录会话。
 *
 * 与 Trae 的会话同构，但**没有 server**：设备流不开监听端口，所以
 * `stepLogin` 只读 `result`，`cancelLogin` 只需 abort 掉轮询。
 *
 * 轮询在后台跑（`beginLogin` 立刻返回 loginUrl），前端按 sessionId 轮询
 * `stepLogin` 读结果 —— 这样浏览器打开与等待授权不会阻塞 HTTP 请求。
 */
const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startedAt > QODER_DEVICE_LOGIN_TIMEOUT_MS + 60_000) {
      try {
        s.controller?.abort();
      } catch {
        /* 已结束 */
      }
      sessions.delete(id);
    }
  }
}

/**
 * 第一段：建立一次设备流会话，返回 `loginUrl`（**不等待用户操作**）。
 *
 * 后台立刻开始轮询，结果写进 session.result。前端拿到 sessionId 后轮询
 * `stepLogin` 读状态即可。
 *
 * @returns {Promise<{ok:true, sessionId:string, url:string, machineId:string}|{ok:false, message:string}>}
 */
export async function beginLogin({ fetcher, machineId, homeDir, clientId, intervalMs, sleep: doSleep } = {}) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, message: '同时进行的登录太多，请先取消' };
  }

  const resolvedMachineId = machineId ?? (await readOrCreateQoderMachineId({ homeDir }));
  const { codeVerifier, codeChallenge } = qoderPkcePair();
  const nonce = qoderNonce();
  const url = buildQoderDeviceLoginUrl({ codeChallenge, nonce, machineId: resolvedMachineId, clientId });

  const sessionId = randomUUID();
  const controller = new AbortController();
  const session = {
    sessionId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finished: false,
    result: null,
    controller,
  };
  sessions.set(sessionId, session);

  // 后台轮询：不 await，登录结果由 stepLogin 读。
  pollQoderDeviceToken({
    fetcher,
    codeVerifier,
    nonce,
    machineId: resolvedMachineId,
    signal: controller.signal,
    // 间隔与 sleep 可注入：单测要它立刻跑完，生产用官方 1 秒节奏。
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(doSleep === undefined ? {} : { sleep: doSleep }),
  })
    .then((payload) => {
      session.result = { ok: true, ...payload };
      session.finished = true;
    })
    .catch((error) => {
      session.result = { ok: false, message: error?.message ?? String(error) };
      session.finished = true;
    })
    .finally(() => {
      session.updatedAt = Date.now();
    });

  return { ok: true, sessionId, url, machineId: resolvedMachineId };
}

/**
 * 第二段：读一次会话状态。
 *
 * `{status:'pending'}` / `{status:'done', …}` / `{status:'failed', error}`，
 * 会话不存在则回 `{error}`（前端据此提示重新发起）。
 */
export function stepLogin({ sessionId }) {
  const s = sessions.get(sessionId);
  if (s === undefined) return { error: '登录会话不存在或已过期' };
  s.updatedAt = Date.now();

  if (s.result === null) {
    if (Date.now() - s.startedAt > QODER_DEVICE_LOGIN_TIMEOUT_MS && !s.finished) {
      return finishLogin(s, { ok: false, message: '登录超时（5 分钟），请重新发起' });
    }
    return { status: 'pending' };
  }
  return finishPayload(s);
}

function finishLogin(session, result) {
  session.finished = true;
  session.result = result;
  try {
    session.controller?.abort();
  } catch {
    /* 已结束 */
  }
  return finishPayload(session);
}

function finishPayload(session) {
  const r = session.result;
  if (r === null) return { status: 'pending' };
  if (r.ok !== true) return { status: 'failed', error: r.message ?? '登录失败' };
  return {
    status: 'done',
    accessToken: r.token ?? '',
    refreshToken: r.refreshToken ?? '',
    expiresAtMs: r.expiresAtMs,
    userId: r.userId ?? '',
    userName: r.userName ?? '',
  };
}

/** 取消一次登录：abort 掉后台轮询并删掉会话。 */
export function cancelLogin(sessionId) {
  const s = sessions.get(sessionId);
  if (s === undefined) return false;
  try {
    s.controller?.abort();
  } catch {
    /* 已结束 */
  }
  sessions.delete(sessionId);
  return true;
}

/** 测试/诊断用：当前会话数。 */
export function sessionCount() {
  return sessions.size;
}

/* ------------------------------------------------------------------ *
 * 凭据落盘
 * ------------------------------------------------------------------ */

/**
 * 账号 id：与 lib/qoder-pool.mjs 的 `qoderAccountId` **必须是同一个算法**。
 *
 * 为什么在这里重写一遍而不 import：lib/qoder-pool.mjs 会连带拉起池与 provider
 * 侧的依赖图，而登录模块只该依赖 node 内置。公式只有两行，重复的代价比耦合
 * 小 —— 代价是**两处必须同步改**，所以 test/qoder-pool.test.mjs 里有一条断言
 * 专门比对两者对同一份凭据算出的 id 是否一致。
 *
 * 回退链：userId 为空用 userName，都为空才落到 "unknown"。
 */
export function qoderAccountIdOf({ userId, userName }) {
  const stable = `qoder-cn\0${userId || userName || 'unknown'}`;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

/** 插件自有凭据文件路径（按账号一个文件，见下）。 */
export function qoderOwnAccountAuthPath(dshHome, accountId) {
  return join(dshHome, `.qoder-auth.cn.${accountId}.json`);
}

/** 凭据文档版本号（与 lib/qoder-pool.mjs 的 parseOwn 一致）。 */
export const QODER_AUTH_VERSION = 1;

/**
 * 把登录结果写进 Qoder 的**插件自有**凭据文件。
 *
 * **按账号一个文件**，不是一个 region 一个文件：单文件会被「最后登录的那个
 * 账号」覆盖，号池里其余账号的刷新结果落不下来，只能继续用（可能已过期的）
 * 桌面端凭据 —— 这正是 Trae 侧踩过的坑（见 lib/trae.js 的注释）。
 *
 * 格式必须与 lib/qoder-pool.mjs 的 parseOwn 完全一致，否则 store 读不到。
 *
 * @returns {Promise<{path:string, accountId:string}|{error:string}>}
 */
export async function saveQoderCredential({
  dshHome,
  accessToken,
  refreshToken,
  userId,
  userName,
  expiresAtMs,
  machineId,
}) {
  if (typeof dshHome !== 'string' || dshHome === '') return { error: '没有 DSH 主目录' };
  if (typeof accessToken !== 'string' || accessToken === '') {
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      return { error: '凭据里既没有 accessToken 也没有 refreshToken' };
    }
  }

  const entry = {
    accessToken,
    refreshToken: refreshToken ?? '',
    userId: userId ?? '',
    userName: userName ?? '',
    expiresAtMs: expiresAtMs ?? 0,
    machineId: machineId ?? '',
  };
  const accountId = qoderAccountIdOf(entry);
  const path = qoderOwnAccountAuthPath(dshHome, accountId);
  const doc = { version: QODER_AUTH_VERSION, credential: entry };

  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dshHome, { recursive: true });
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    return { error: `写入 Qoder 凭据失败：${e?.message ?? String(e)}` };
  }
  return { path, accountId };
}

/** 删除一个账号的插件自有凭据（号池「移出池子」用；不碰桌面端登录态）。 */
export async function deleteQoderCredential({ dshHome, accountId }) {
  if (typeof dshHome !== 'string' || dshHome === '') return { error: '没有 DSH 主目录' };
  if (typeof accountId !== 'string' || accountId === '') return { error: '缺少 accountId' };
  try {
    const { rm } = await import('node:fs/promises');
    await rm(qoderOwnAccountAuthPath(dshHome, accountId), { force: true });
  } catch (e) {
    return { error: `删除 Qoder 凭据失败：${e?.message ?? String(e)}` };
  }
  return { ok: true };
}