/**
 * Qoder 设备流登录（lib/qoder-auth.mjs）的单测。
 *
 * 为什么要有这个文件：登录是「入池」的唯一通道，它错了不会抛异常 ——
 * 表现为「浏览器显示已授权，插件里却永远没有这个账号」。这里用假 fetch
 * 把三类关键语义钉死：
 *
 *   - 404 必须**继续轮询**（尚未授权 ≠ 失败）
 *   - 200 但没令牌也必须**继续轮询**（授权页还没点）
 *   - 非 404 的失败必须**直报**（不能空转到超时）
 *   - 成功判据是 `typeof token === 'string'`（不做数字强转）
 *   - 账号 id 与 lib/qoder-pool.mjs 必须算出同一个值
 *   - 按账号落盘：同一账号重复登录只覆盖自己那份
 *
 * 运行：node test/qoder-auth.test.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QODER_CLI_CLIENT_ID,
  beginLogin,
  buildQoderDeviceLoginUrl,
  cancelLogin,
  deleteQoderCredential,
  parseQoderDeviceTokenPayload,
  qoderAccountIdOf,
  qoderMachineIdPath,
  qoderOwnAccountAuthPath,
  qoderPkcePair,
  readOrCreateQoderMachineId,
  saveQoderCredential,
  sessionCount,
  stepLogin,
} from '../lib/qoder-auth.mjs';
import { parseQoderOwn, qoderAccountId } from '../lib/qoder-pool.mjs';

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

/** 构造一个只按脚本回答的假 fetch。 */
function scriptedFetch(script) {
  const calls = [];
  let index = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof step === 'function') return step(String(url));
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      text: async () => step.body ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

/** 收集日志行的假 logger。 */
function collectingLogger(lines) {
  return {
    warn: (m) => lines.push(String(m)),
    info: (m) => lines.push(String(m)),
  };
}

console.log('\n== PKCE 与登录 URL ==');
{
  const pair = qoderPkcePair();
  ok('verifier 是 base64url 且足够长', /^[A-Za-z0-9_-]{60,}$/.test(pair.codeVerifier), pair.codeVerifier.length);
  ok('challenge 是 base64url', /^[A-Za-z0-9_-]+$/.test(pair.codeChallenge));
  ok('method 是 S256', pair.codeChallengeMethod === 'S256');

  const url = new URL(
    buildQoderDeviceLoginUrl({ codeChallenge: 'CH', nonce: 'NO', machineId: 'MI' }),
  );
  ok('登录页走 qoder.cn', url.origin === 'https://qoder.cn');
  ok('路径是 /device/selectAccounts', url.pathname === '/device/selectAccounts');
  ok('带 challenge', url.searchParams.get('challenge') === 'CH');
  ok('带 challenge_method=S256', url.searchParams.get('challenge_method') === 'S256');
  ok('带 nonce', url.searchParams.get('nonce') === 'NO');
  ok('带 machine_id', url.searchParams.get('machine_id') === 'MI');
  ok('带 CLI client_id', url.searchParams.get('client_id') === QODER_CLI_CLIENT_ID);
  ok('刻意不带 redirect_uri', url.searchParams.get('redirect_uri') === null);
}

console.log('\n== 令牌载荷解析 ==');
{
  ok('token 是 string 即成功', parseQoderDeviceTokenPayload({ token: 'dt-abc' })?.token === 'dt-abc');
  ok('空串 token 也算成功（照抄官方 typeof 判据）', parseQoderDeviceTokenPayload({ token: '' })?.token === '');
  ok('数字 token 不算成功（不做强转）', parseQoderDeviceTokenPayload({ token: 123 }) === undefined);
  ok('device_token 是回退字段', parseQoderDeviceTokenPayload({ device_token: 'x' })?.token === 'x');
  ok('access_token 是回退字段', parseQoderDeviceTokenPayload({ access_token: 'y' })?.token === 'y');
  ok('没有令牌返回 undefined', parseQoderDeviceTokenPayload({ ok: true }) === undefined);
  ok('数组不算对象', parseQoderDeviceTokenPayload([{ token: 'a' }]) === undefined);

  const now = 1_700_000_000_000;
  ok(
    'expires_at 绝对时间被解析',
    parseQoderDeviceTokenPayload({ token: 't', expires_at: '2030-01-01T00:00:00Z' }, now)?.expiresAtMs ===
      Date.parse('2030-01-01T00:00:00Z'),
  );
  ok(
    'expires_in 按秒解释',
    parseQoderDeviceTokenPayload({ token: 't', expires_in: 3600 }, now)?.expiresAtMs === now + 3_600_000,
  );
  ok(
    'expires_in 超过一天按毫秒解释',
    parseQoderDeviceTokenPayload({ token: 't', expires_in: 7_200_000 }, now)?.expiresAtMs === now + 7_200_000,
  );
  const payload = parseQoderDeviceTokenPayload({
    token: 't',
    refresh_token: 'r',
    user_id: 'u1',
    user_name: 'n1',
  });
  ok('refresh_token 被带出', payload?.refreshToken === 'r');
  ok('user_id 被带出', payload?.userId === 'u1');
  ok('user_name 被带出', payload?.userName === 'n1');
}

console.log('\n== 轮询语义（三类不成功的区分） ==');
{
  // 404 → 200(空) → 200(令牌)：必须一直轮询到拿到令牌
  const fetcher = scriptedFetch([
    { status: 404 },
    { status: 200, body: '{}' },
    { status: 200, body: JSON.stringify({ token: 'dt-final', refresh_token: 'rt' }) },
  ]);
  const begun = await beginLogin({ fetcher, machineId: 'M', homeDir: tmpdir(), intervalMs: 0 });
  ok('beginLogin 立刻返回 loginUrl', begun.ok === true && typeof begun.url === 'string');

  let state = stepLogin({ sessionId: begun.sessionId });
  ok('刚发起时是 pending', state.status === 'pending');

  // 让后台轮询跑完（假 sleep 是真实定时器，等一拍）
  await new Promise((r) => setTimeout(r, 50));
  state = stepLogin({ sessionId: begun.sessionId });
  ok('404 与空响应后最终拿到 done', state.status === 'done', JSON.stringify(state));
  ok('带回 accessToken', state.accessToken === 'dt-final');
  ok('带回 refreshToken', state.refreshToken === 'rt');
  ok('轮询打了 3 次（404 与空响应都没被当失败）', fetcher.calls.length === 3, fetcher.calls.length);

  const first = new URL(fetcher.calls[0].url);
  ok('轮询打在 openapi.qoder.com.cn', first.origin === 'https://openapi.qoder.com.cn');
  ok('轮询路径是 /api/v1/deviceToken/poll', first.pathname === '/api/v1/deviceToken/poll');
  ok('轮询带 nonce', first.searchParams.get('nonce') !== null);
  ok('轮询带 verifier', first.searchParams.get('verifier') !== null);
  ok('轮询带 machine_id', first.searchParams.get('machine_id') === 'M');
  ok('轮询带 challenge_method=S256', first.searchParams.get('challenge_method') === 'S256');
  cancelLogin(begun.sessionId);
}

{
  // 非 404 失败必须直报，不能空转
  const fetcher = scriptedFetch([{ status: 500, body: 'boom' }]);
  const begun = await beginLogin({ fetcher, machineId: 'M', homeDir: tmpdir() });
  await new Promise((r) => setTimeout(r, 30));
  const state = stepLogin({ sessionId: begun.sessionId });
  ok('500 直报 failed', state.status === 'failed', JSON.stringify(state));
  ok('失败信息里带 HTTP 状态', /HTTP 500/.test(state.error ?? ''), state.error);
  ok('500 只请求了一次（没空转）', fetcher.calls.length === 1, fetcher.calls.length);
  cancelLogin(begun.sessionId);
}

{
  // 响应不是 JSON 也要直报
  const fetcher = scriptedFetch([{ status: 200, body: '<html>not json</html>' }]);
  const begun = await beginLogin({ fetcher, machineId: 'M', homeDir: tmpdir() });
  await new Promise((r) => setTimeout(r, 30));
  const state = stepLogin({ sessionId: begun.sessionId });
  ok('非 JSON 响应直报 failed', state.status === 'failed' && /不是 JSON/.test(state.error ?? ''), state.error);
  cancelLogin(begun.sessionId);
}

{
  // 传输层失败直报
  const fetcher = async () => {
    throw new Error('ENOTFOUND');
  };
  const begun = await beginLogin({ fetcher, machineId: 'M', homeDir: tmpdir() });
  await new Promise((r) => setTimeout(r, 30));
  const state = stepLogin({ sessionId: begun.sessionId });
  ok('网络失败直报 failed', state.status === 'failed' && /网络失败/.test(state.error ?? ''), state.error);
  cancelLogin(begun.sessionId);
}

{
  const fetcher = scriptedFetch([{ status: 404 }]);
  const begun = await beginLogin({ fetcher, machineId: 'M', homeDir: tmpdir() });
  ok('取消一个进行中的会话返回 true', cancelLogin(begun.sessionId) === true);
  ok('取消后会话不存在', stepLogin({ sessionId: begun.sessionId }).error !== undefined);
  ok('取消不存在的会话返回 false', cancelLogin('nope') === false);
}

console.log('\n== machine_id ==');
{
  const home = await mkdtemp(join(tmpdir(), 'qoder-mid-'));
  try {
    const first = await readOrCreateQoderMachineId({ homeDir: home });
    ok('生成的是 UUID 文本', /^[0-9a-f-]{36}$/.test(first), first);
    const second = await readOrCreateQoderMachineId({ homeDir: home });
    ok('已存在则读用，不覆盖', second === first);

    const path = qoderMachineIdPath(home);
    ok('路径是 <home>/.qoder-cn/.auth/machine_id', path.endsWith(join('.qoder-cn', '.auth', 'machine_id')), path);

    // 官方 CLI 可能写成「一行 + \n」—— trim 掉，别把换行带进 URL
    await writeFile(path, `${first}\n`);
    ok('读取时 trim 换行', (await readOrCreateQoderMachineId({ homeDir: home })) === first);

    // 磁盘不可写不该挡登录
    const broken = {
      readFile: async () => {
        throw new Error('EACCES');
      },
      mkdir: async () => {
        throw new Error('EACCES');
      },
      writeFile: async () => {
        throw new Error('EACCES');
      },
    };
    const fallback = await readOrCreateQoderMachineId({ homeDir: home, io: broken });
    ok('落盘失败退回内存态 UUID，不抛', /^[0-9a-f-]{36}$/.test(fallback), fallback);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

console.log('\n== 账号 id 与凭据落盘 ==');
{
  const credential = { userId: 'u-1', userName: 'alice' };
  ok(
    'qoder-auth 与 qoder-pool 算出同一个 accountId',
    qoderAccountIdOf(credential) === qoderAccountId(credential),
    `${qoderAccountIdOf(credential)} vs ${qoderAccountId(credential)}`,
  );
  ok(
    'userId 为空时回退 userName',
    qoderAccountIdOf({ userId: '', userName: 'alice' }) === qoderAccountId({ userId: '', userName: 'alice' }),
  );
  ok('都为空落到 unknown', qoderAccountIdOf({ userId: '', userName: '' }) === qoderAccountIdOf({}));
  ok('不同账号 id 不同', qoderAccountIdOf({ userId: 'a' }) !== qoderAccountIdOf({ userId: 'b' }));

  const home = await mkdtemp(join(tmpdir(), 'qoder-cred-'));
  try {
    const saved = await saveQoderCredential({
      dshHome: home,
      accessToken: 'dt-a',
      refreshToken: 'rt-a',
      userId: 'u-1',
      userName: 'alice',
      expiresAtMs: 1_800_000_000_000,
      machineId: 'M-1',
    });
    ok('落盘成功', saved.error === undefined && typeof saved.accountId === 'string', JSON.stringify(saved));
    ok(
      '文件名按账号派生',
      saved.path === qoderOwnAccountAuthPath(home, saved.accountId),
      saved.path,
    );

    const text = await readFile(saved.path, 'utf8');
    const parsed = parseQoderOwn(text);
    ok('写出的文档能被池解析', parsed !== undefined);
    ok('accessToken 往返一致', parsed?.accessToken === 'dt-a');
    ok('refreshToken 往返一致', parsed?.refreshToken === 'rt-a');
    ok('userName 往返一致', parsed?.userName === 'alice');
    ok('machineId 往返一致', parsed?.machineId === 'M-1');
    ok('expiresAtMs 往返一致', parsed?.expiresAtMs === 1_800_000_000_000);

    // 同一账号重复登录只覆盖自己那份
    const again = await saveQoderCredential({
      dshHome: home,
      accessToken: 'dt-a2',
      refreshToken: 'rt-a2',
      userId: 'u-1',
      userName: 'alice',
      expiresAtMs: 1_900_000_000_000,
    });
    ok('同账号重复登录落在同一个文件', again.path === saved.path);
    const reread = parseQoderOwn(await readFile(again.path, 'utf8'));
    ok('令牌被更新', reread?.accessToken === 'dt-a2');

    // 另一个账号落另一个文件
    const other = await saveQoderCredential({
      dshHome: home,
      accessToken: 'dt-b',
      userId: 'u-2',
      userName: 'bob',
    });
    ok('不同账号落不同文件', other.path !== saved.path);
    ok('不同账号 accountId 不同', other.accountId !== saved.accountId);

    // 缺令牌要被拒
    const bad = await saveQoderCredential({ dshHome: home, accessToken: '', refreshToken: '' });
    ok('既无 accessToken 也无 refreshToken 时报错', typeof bad.error === 'string', JSON.stringify(bad));
    const noHome = await saveQoderCredential({ dshHome: '', accessToken: 'x' });
    ok('没有 DSH 主目录时报错', typeof noHome.error === 'string');

    // 删除
    const removed = await deleteQoderCredential({ dshHome: home, accountId: saved.accountId });
    ok('删除成功', removed.ok === true);
    const gone = parseQoderOwn(await readFile(saved.path, 'utf8').catch(() => ''));
    ok('删除后文件读不到了', gone === undefined);
    ok('删除另一个账号的文件仍在', parseQoderOwn(await readFile(other.path, 'utf8')) !== undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

console.log(`\nqoder-auth: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);