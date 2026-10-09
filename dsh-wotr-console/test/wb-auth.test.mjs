/**
 * WorkBuddy 登录（浏览器登录 + state 轮询换 token）的单测。
 *
 * 这一层要守住的**核心事实**：
 *   1. 协议是「state 轮询」，不是 OAuth 授权码 —— 不能要求 client_id/redirect_uri，
 *      也不能因为拿不到 code 就判失败。
 *   2. 落盘的凭据文件必须能被池**原本的解析器**读出来（明文分支）。
 *      登录成功但池认不出账号 = 白做。这是本次改动唯一没法直接 import vendored
 *      验证的一环（vendored 依赖宿主提供的 schemastery），所以用等价解析逻辑模拟。
 *
 * 运行：node test/wb-auth.test.mjs
 */

import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  fetchAuthState,
  pollForToken,
  fetchIdentity,
  isPending,
  readEnvelopeCode,
  pickAuthDir,
  saveCredential,
  beginLogin,
  stepLogin,
  cancelLogin,
  readDomainFromAuthFiles,
  resolveLoginBase,
} from '../lib/wb-auth.mjs';

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

/** 造一个返回固定 JSON 的 fetch 桩 */
const stubFetch = (responder) => async (url, init) => {
  const r = await responder(String(url), init ?? {});
  const status = r.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => r.body ?? null,
  };
};

const BASE = 'https://www.workbuddy.cn';

console.log('WorkBuddy 登录单测\n');

/* ------------------------------------------------------------------ */
// 1) 第 1 步：拿 authUrl / state
/* ------------------------------------------------------------------ */
{
  const f = stubFetch(() => ({
    body: { code: 0, data: { authUrl: 'https://www.workbuddy.cn/login?x=1', state: 'st-1' } },
  }));
  const got = await fetchAuthState(f, BASE);
  ok('拿到 authUrl 与 state', got.authUrl === 'https://www.workbuddy.cn/login?x=1' && got.state === 'st-1');

  // data 缺失时也应能从顶层取
  const f2 = stubFetch(() => ({ body: { authUrl: 'https://x/login', state: 's' } }));
  const got2 = await fetchAuthState(f2, BASE);
  ok('data 缺失时仍可从顶层取到', got2.state === 's' && got2.authUrl === 'https://x/login');

  const f3 = stubFetch(() => ({ body: {} }));
  ok('没有 authUrl 时报错', (await fetchAuthState(f3, BASE)).error !== undefined);

  const f4 = stubFetch(() => ({ body: { authUrl: 'javascript:alert(1)', state: 's' } }));
  ok('拒绝非 http(s) 的 authUrl', (await fetchAuthState(f4, BASE)).error !== undefined);

  const f5 = stubFetch(() => { throw new Error('boom'); });
  ok('网络异常时报错而非抛出', (await fetchAuthState(f5, BASE)).error !== undefined);
}

/* ------------------------------------------------------------------ */
// 2) 第 2 步：轮询换 token —— pending 判定
/* ------------------------------------------------------------------ */
{
  // 关键：没有 accessToken + pending 码 → 继续等
  const pendingBody = { code: 11217, data: {} };
  ok('pending 码且无 token → 继续等', isPending(pendingBody, pendingBody.data) === true);

  // 有 token 就算完成，不看码
  ok(
    '有 accessToken 即算完成',
    isPending({ code: 0 }, { accessToken: 'abc' }) === false,
  );

  // 明确非 pending 的错误码 → 不当 pending
  ok('非 pending 错误码不当 pending', isPending({ code: 40001 }, {}) === false);

  const code = readEnvelopeCode({ code: 0, data: { code: 11217 } });
  ok('能从顶层读出业务码', code === 0);

  const nested = readEnvelopeCode({ data: { code: 11217 } });
  ok('data 里没有顶层码时读 data 的码', nested === 11217);

  const fPending = stubFetch(() => ({ body: { code: 11217, data: {} } }));
  const r1 = await pollForToken(fPending, BASE, 'st');
  ok('pending 时不返回 done', r1.done === false && r1.error === undefined);

  const fDone = stubFetch(() => ({
    body: { code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 100, refreshExpiresIn: 200 } },
  }));
  const r2 = await pollForToken(fDone, BASE, 'st');
  ok('拿到 token 时 done', r2.done === true && r2.credential.accessToken === 'AT');
  ok('refreshToken 正确取出', r2.credential.refreshToken === 'RT');
  ok('expiresAt 由 expiresIn 推算', r2.credential.expiresAt > Date.now());
  ok('domain 从 base 推出', r2.credential.domain === 'www.workbuddy.cn');

  // refreshToken 用 refresh_token 别名
  const fAlias = stubFetch(() => ({ body: { data: { accessToken: 'A', refresh_token: 'R2' } } }));
  const r3 = await pollForToken(fAlias, BASE, 'st');
  ok('refresh_token 别名也能取', r3.credential.refreshToken === 'R2');

  // 有 token 但 HTTP 4xx → 不该静默
  const fBad = stubFetch(() => ({ status: 500, body: { code: 500 } }));
  const r4 = await pollForToken(fBad, BASE, 'st');
  ok('服务端报错且无 token 时不当成功', r4.done !== true);

  const fThrow = stubFetch(() => { throw new Error('net'); });
  const r5 = await pollForToken(fThrow, BASE, 'st');
  ok('轮询网络抖动不判失败', r5.done === false && r5.transient !== undefined);
}

/* ------------------------------------------------------------------ */
// 3) 第 3 步：取身份（uin/uid 必须有，否则多账号会撞号）
/* ------------------------------------------------------------------ */
{
  const f = stubFetch(() => ({ body: { data: { uin: 'UIN1', uid: 'UID1', nickname: '张三' } } }));
  const got = await fetchIdentity(f, BASE, 'AT', 'st');
  ok('取到 uin/uid/nickname', got.identity?.uin === 'UIN1' && got.identity?.uid === 'UID1');
  ok('取到昵称', got.identity?.nickname === '张三');

  const f2 = stubFetch(() => ({ body: { data: [{ uin: 'U2' }] } }));
  ok('数组形态也能取', (await fetchIdentity(f2, BASE, 'AT', 'st')).identity?.uin === 'U2');

  const f3 = stubFetch(() => ({ body: { data: {} } }));
  const g3 = await fetchIdentity(f3, BASE, 'AT', 'st');
  ok('没有 uin/uid 时判 pending（不写坏账号）', g3.pending === true && g3.identity === undefined);

  const f4 = stubFetch(() => { throw new Error('boom'); });
  ok('取身份网络异常报错', (await fetchIdentity(f4, BASE, 'AT', 'st')).error !== undefined);
}

/**
 * 从 vendored 源码里**原样扣出**池的解析函数，用真代码验证我们写的凭据。
 *
 * 为什么这么绕：vendored 模块顶层 import 了 `@deepseek-ai/schemastery`，
 * 而那个包只存在于宿主 asar 里，Node 直接 import 会失败。
 * 但 `parseWorkBuddyAuth` / `workbuddyAccountId` 本身是**纯函数**，不依赖它，
 * 所以这里按大括号配对把它们的源码原样抠出来执行 ——
 * 验证的是**真代码**，不是我们照着抄一份的模拟。
 */
async function loadRealParser() {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../vendor/xdpool/lib/index.js', import.meta.url),
    'utf8',
  );
  const grab = (pattern) => {
    const m = src.match(pattern);
    if (m === null) return null;
    const start = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) return src.slice(m.index, j + 1);
      }
    }
    return null;
  };
  const names = [
    'isEncryptedFieldWrapper',
    'expiryToMs',
    'optionalString',
    'isEncryptedCredentialError',
    'decryptableString',
    'parseWorkBuddyAuth',
    'workbuddyAccountId',
  ];
  const parts = [
    "import { createHash } from 'node:crypto';",
    // class 是 `var X = class extends Error {` 形式
    grab(/\nvar WorkBuddyEncryptedCredentialError = class extends Error/),
    ...names.map((n) => grab(new RegExp(`\\nfunction ${n}\\(`))),
    'export { parseWorkBuddyAuth, workbuddyAccountId };',
  ].filter((x) => typeof x === 'string' && x !== '');

  const { writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = join(tmpdir(), `wb-real-parser-${Date.now()}.mjs`);
  await writeFile(tmp, parts.join('\n\n'), 'utf8');
  return import(`file://${tmp}`);
}

/* ------------------------------------------------------------------ */
// 4) 落盘：必须能被池**真正的**解析器读出来（核心）
/* ------------------------------------------------------------------ */
{
  const dir = await mkdtemp(join(tmpdir(), 'wbauth-'));

  const real = await loadRealParser();
  const parse = real.parseWorkBuddyAuth;
  const accountIdOf = real.workbuddyAccountId;
  ok('已从 vendored 扣出真解析器', typeof parse === 'function' && typeof accountIdOf === 'function');

  const expAt = Date.now() + 3600_000;
  const expRefresh = Date.now() + 7200_000;
  const saved = await saveCredential({
    dir,
    credential: {
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      tokenType: 'Bearer',
      domain: 'www.workbuddy.cn',
      expiresAt: expAt,
      refreshExpiresAt: expRefresh,
      scope: 'openid profile offline_access email',
    },
    identity: { uin: 'UIN1', uid: 'UID1', nickname: '张三' },
    accountIdOf,
  });
  ok('写入成功并返回路径', saved.error === undefined && typeof saved.path === 'string');

  // 用池真正的解析器读（不传 decrypt —— 明文不该需要 at-rest key）
  const cred = parse(await readFile(saved.path, 'utf8'), saved.path, undefined);
  ok('池真解析器能读出这条凭据', cred !== undefined);
  ok('池读出 accessToken', cred?.accessToken === 'AT-1');
  ok('池读出 refreshToken', cred?.refreshToken === 'RT-1');
  ok('池读出 domain', cred?.domain === 'www.workbuddy.cn');
  // 注意：真解析返回的字段叫 expiresAtMs（不是 expiresAt）
  ok('池读出 expiresAtMs 且与写入一致', cred?.expiresAtMs === expAt, String(cred?.expiresAtMs));
  ok('池读出 refreshExpiresAtMs', cred?.refreshExpiresAtMs === expRefresh);
  ok('凭据未过期（池会认为可用）', cred?.expiresAtMs > Date.now());
  ok('池读出 uin/uid（账号 id 的派生依据）', cred?.uin === 'UIN1' && cred?.uid === 'UID1');
  ok('池读出 nickname 可显示', cred?.nickname === '张三');
  ok('池算出的账号 id 与我们一致', accountIdOf(cred) === saved.accountId, String(saved.accountId));

  // 文件权限应为 600（不把明文 token 暴露给同组/其他用户）
  const { statSync } = await import('node:fs');
  const mode = statSync(saved.path).mode & 0o777;
  ok('凭据文件权限为 600', mode === 0o600, `实际 ${mode.toString(8)}`);

  // 多账号：不同 uin 写不同文件，池算出的 id 必须不同（否则会撞号成一个账号）
  const saved2 = await saveCredential({
    dir,
    credential: { accessToken: 'AT-2', refreshToken: 'RT-2' },
    identity: { uin: 'UIN2', uid: 'UID2', nickname: '李四' },
    accountIdOf,
  });
  ok('第二个账号写入不同文件', saved2.path !== saved.path);
  const cred2 = parse(await readFile(saved2.path, 'utf8'), saved2.path, undefined);
  ok('池也能读出第二个账号', cred2?.accessToken === 'AT-2');
  ok('两个账号 id 不同（不撞号）', accountIdOf(cred2) !== saved.accountId);
  ok('第一个账号未被覆盖', parse(await readFile(saved.path, 'utf8'), saved.path, undefined)?.accessToken === 'AT-1');

  // 重复登录同一账号 → 覆盖自己那份（幂等）
  const again = await saveCredential({
    dir,
    credential: { accessToken: 'AT-1-new', refreshToken: 'RT-1-new' },
    identity: { uin: 'UIN1', uid: 'UID1', nickname: '张三' },
    accountIdOf,
  });
  ok('同一账号重复登录会覆盖自己（幂等）', again.path === saved.path);
  ok('覆盖后是新 token', parse(await readFile(again.path, 'utf8'), again.path, undefined)?.accessToken === 'AT-1-new');

  // 缺 uin/uid → 拒绝写入（否则账号 id 退化成 unknown，多账号撞号）
  const bad = await saveCredential({
    dir,
    credential: { accessToken: 'x' },
    identity: {},
    accountIdOf: (i) => i.uin ?? i.uid ?? i.nickname,
  });
  ok('缺 uin/uid 时拒绝写入', bad.error !== undefined);

  // 目录为空 → 报错
  const noDir = await saveCredential({
    dir: '',
    credential: { accessToken: 'x' },
    identity: { uin: 'u' },
    accountIdOf,
  });
  ok('没有目录时报错', noDir.error !== undefined);

  await rm(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
// 5) 凭据目录选择
/* ------------------------------------------------------------------ */
{
  const dir = await mkdtemp(join(tmpdir(), 'wbdir-'));
  const chosen = await pickAuthDir(['/nonexistent/xyz', dir], '/fallback');
  ok('跳过不可写目录，选第一个可写的', chosen === dir);

  const fallback = await pickAuthDir(['/nonexistent/a', ''], '/fallback');
  ok('全都不可写时退回 fallback', fallback === '/fallback');

  // 可写性用 W_OK 判断，而不是「存在」
  const roDir = join(dir, 'ro');
  await mkdir(roDir, { mode: 0o500 });
  const after = await pickAuthDir([roDir], '/fb');
  ok('不可写目录被跳过', after === '/fb');

  await rm(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
// 6) 会话：begin / step / cancel
/* ------------------------------------------------------------------ */
{
  let calls = 0;
  const f = stubFetch((url) => {
    if (url.includes('/auth/state')) {
      return { body: { data: { authUrl: 'https://x/login', state: 'S1' } } };
    }
    if (url.includes('/auth/token')) {
      calls++;
      if (calls < 2) return { body: { code: 11217, data: {} } };
      return { body: { data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 60 } } };
    }
    if (url.includes('/accounts')) {
      return { body: { data: { uin: 'U1', uid: 'D1', nickname: 'n' } } };
    }
    return { body: {} };
  });

  let openedUrl = null;
  const begun = await beginLogin({
    fetchImpl: f,
    baseUrl: BASE,
    openUrl: async (u) => { openedUrl = u; },
  });
  ok('beginLogin 返回 sessionId', typeof begun.sessionId === 'string');
  ok('beginLogin 打开浏览器', openedUrl === 'https://x/login');

  const s1 = await stepLogin({ fetchImpl: f, sessionId: begun.sessionId });
  ok('第一次轮询仍是 pending', s1.status === 'pending');

  const s2 = await stepLogin({ fetchImpl: f, sessionId: begun.sessionId });
  ok('第二次轮询完成', s2.status === 'done' && s2.credential.accessToken === 'AT');
  ok('完成时有身份', s2.identity?.uin === 'U1');

  // 会话不存在
  const s3 = await stepLogin({ fetchImpl: f, sessionId: 'not-exist' });
  ok('未知会话返回错误', s3.error !== undefined);

  // 取消
  const begun2 = await beginLogin({ fetchImpl: f, baseUrl: BASE, openUrl: async () => {} });
  ok('取消返回 true', cancelLogin(begun2.sessionId) === true);
  ok('重复取消返回 false', cancelLogin(begun2.sessionId) === false);

  // 拿不到 authUrl 时 beginLogin 报错
  const fBad = stubFetch(() => ({ body: {} }));
  ok('beginLogin 失败时报错', (await beginLogin({ fetchImpl: fBad, baseUrl: BASE })).error !== undefined);

  // 浏览器打开失败不致命，仍返回 authUrl 供手动打开
  const begun3 = await beginLogin({
    fetchImpl: f,
    baseUrl: BASE,
    openUrl: async () => { throw new Error('no browser'); },
  });
  ok('浏览器打不开时不算致命', begun3.authUrl === 'https://x/login' && begun3.opened === false);
  if (begun3.sessionId) cancelLogin(begun3.sessionId);
}

/* ------------------------------------------------------------------ */
// 7) 上游站点选择：必须跟着本机现有凭据的 domain 走
/* ------------------------------------------------------------------ */
{
  const dir = await mkdtemp(join(tmpdir(), 'wbdomain-'));

  // 空目录 → 用 fallback
  ok('读不到凭据时退回默认站', (await resolveLoginBase([dir], 'https://fb')) === 'https://fb');

  // 有凭据 → 跟它的 domain
  await writeFile(
    join(dir, 'workbuddy-desktop.info'),
    JSON.stringify({ auth: { domain: 'www.workbuddy.cn', accessToken: 'x' } }),
  );
  const got = await resolveLoginBase([dir], 'https://fb');
  ok('跟随现有凭据的 domain', got === 'https://www.workbuddy.cn', got);

  // domain 带协议也要能处理
  await writeFile(
    join(dir, 'a.info'),
    JSON.stringify({ auth: { domain: 'https://copilot.tencent.com' } }),
  );
  const got2 = await resolveLoginBase([dir], 'https://fb');
  ok('domain 带协议时也能归一', got2 === 'https://copilot.tencent.com', got2);

  // 坏文件不能让整个解析失败（跳过继续找）
  await writeFile(join(dir, 'broken.info'), 'not json at all');
  const got3 = await resolveLoginBase([dir], 'https://fb');
  ok('坏文件被跳过，不导致失败', got3 === 'https://www.workbuddy.cn' || got3 === 'https://copilot.tencent.com', got3);

  // 目录不存在 → 不崩
  const got4 = await resolveLoginBase(['/nonexistent/abc'], 'https://fb');
  ok('目录不存在时安全退回', got4 === 'https://fb');

  ok('readDomainFromAuthFiles 无凭据时返回 undefined', (await readDomainFromAuthFiles(['/nonexistent'])) === undefined);

  await rm(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
// 8) 坏响应一律不崩（渲染期抛错会白屏）
/* ------------------------------------------------------------------ */
{
  const shapes = [
    null,
    undefined,
    'not json',
    42,
    [],
    { data: null },
    { data: 'x' },
    { data: { accessToken: 123 } },
    { data: { uin: 5 } },
    { code: 'x' },
  ];
  let threw = null;
  for (const body of shapes) {
    const f = stubFetch(() => ({ body }));
    try {
      await fetchAuthState(f, BASE);
      await pollForToken(f, BASE, 's');
      await fetchIdentity(f, BASE, 'AT', 's');
    } catch (e) {
      threw = `${String(body)} → ${e.message}`;
      break;
    }
  }
  ok('任意坏响应都不抛异常', threw === null, threw ?? '');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
