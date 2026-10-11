/**
 * Qoder 额度查询（lib/qoder-credits.mjs）的单测。
 *
 * 为什么要有这个文件：额度查询决定「账号还剩多少积分」以及「保留额度该不该
 * 把这个账号挡在轮转外」。这部分错了不会抛异常 —— 表现为「明明还有加量包，
 * 账号却被当成空号踢掉」，或者更糟：「网络断了，卡片显示这个号 0 积分」，
 * 用户据此删掉一个好账号。
 *
 * 因此本文件用**真实的 T1 响应原文**做 fixture，而不是自己编一个「理想结构」
 * —— 编出来的结构永远恰好被自己的解析器接受，测不出形态漂移。覆盖：
 *
 *   - 三池结构、后两池可缺席、「一个池都没有 ⇒ 查不到」
 *   - 「查不到」与「余额为 0」严格区分（失败绝不伪造成 0）
 *   - 余额口径：三池求和、负数 clamp、主池空但加量包有余额
 *   - 网络失败 / 非 2xx / 非 JSON / 形态不认识
 *   - 批量刷新：逐账号记余额、单账号失败不牵连、串行
 *   - 与号池保留额度的联动（刷新积分的主要用途）
 *
 * 运行：node test/qoder-credits.test.mjs
 */

import {
  QODER_CN_OPENAPI_BASE,
  QODER_QUOTA_POOL_KEYS,
  QODER_QUOTA_POOL_LABELS,
  QODER_QUOTA_USAGE_PATH,
  QODER_USER_AGENT,
  fetchQoderQuotaUsage,
  parseQoderQuotaPool,
  parseQoderQuotaUsage,
  qoderQuotaHasAddOnOnly,
  qoderQuotaHeaders,
  qoderQuotaRemainingTotal,
  refreshQoderPoolCredits,
  summarizeQoderErrorBody,
} from '../lib/qoder-credits.mjs';
import { QoderAccountPool, qoderAccountId } from '../lib/qoder-pool.mjs';

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

/** 假凭据 store：只实现池用到的三个方法。 */
function fakeStore(credentials) {
  return {
    readAll: async () => credentials,
    credentialOf: async (id) => credentials.find((c) => qoderAccountId(c) === id),
    resolveFor: async () => undefined,
  };
}

const cred = (userId, name) => ({ accessToken: `dt-${userId}`, userId, userName: name });

/** 造一个假的 fetch 响应。 */
const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** 造一个只记请求、按脚本回响应的 fetcher。`script` 收序号，便于逐次不同。 */
function fakeFetcher(script) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const entry = typeof script === 'function' ? script(calls.length, url, init) : script;
    if (entry instanceof Error) throw entry;
    return entry;
  };
  fetcher.calls = calls;
  return fetcher;
}

const CREDENTIAL = { accessToken: 'dt-abcdef123456', userId: 'u-1', userName: '号一' };

/* T1 实测原文：主池存在、后两池整个缺席、余额全 0、expiresAt 是 9999 年。 */
const T1_BODY = {
  userId: '9f8b7c6d-1234-4abc-9def-0123456789ab',
  userType: 'personal_standard',
  usageType: 'credits',
  totalUsagePercentage: 0,
  isQuotaExceeded: true,
  expiresAt: 253402214400000,
  upgradeUrl: 'https://qoder.com/pricing?client=qoder',
  outerProviders: [],
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
  isPlanQuotaProrated: false,
};

/* 实测另一形态：主池空、加量包还有 100 —— 「只读主池会误判空号」的那一种。 */
const ADDON_BODY = {
  userId: 'u-2',
  userType: 'personal_standard',
  usageType: 'credits',
  isQuotaExceeded: false,
  expiresAt: 253402214400000,
  userQuota: { total: 300, used: 300, remaining: 0, percentage: 100, unit: 'credits' },
  addOnQuota: { total: 100, used: 0, remaining: 100, percentage: 0, unit: 'credits' },
};

/* 三池齐全。 */
const THREE_POOL_BODY = {
  userId: 'u-3',
  userQuota: { total: 300, used: 100, remaining: 200, percentage: 33.33, unit: 'credits' },
  addOnQuota: { total: 100, used: 40, remaining: 60, percentage: 40, unit: 'credits' },
  orgResourcePackage: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits' },
};

console.log('\n== 常量口径 ==');
{
  ok('端点是 /api/v2/quota/usage', QODER_QUOTA_USAGE_PATH === '/api/v2/quota/usage');
  ok('不是 /sash/ 活动线', !QODER_QUOTA_USAGE_PATH.includes('/sash/'));
  ok('CN 基址与轮询同 host', QODER_CN_OPENAPI_BASE === 'https://openapi.qoder.com.cn');
  ok(
    '三池键顺序固定',
    JSON.stringify(QODER_QUOTA_POOL_KEYS) === JSON.stringify(['userQuota', 'addOnQuota', 'orgResourcePackage']),
  );
  ok(
    '三池各有可读名',
    QODER_QUOTA_POOL_KEYS.every((key) => (QODER_QUOTA_POOL_LABELS[key] ?? '').length > 0),
  );
}

console.log('\n== 请求头 ==');
{
  const headers = qoderQuotaHeaders('dt-xyz');
  ok('Authorization 是 Bearer 令牌', headers.Authorization === 'Bearer dt-xyz');
  ok('Accept 是 JSON', headers.Accept === 'application/json');
  ok('带官方 UA', headers['User-Agent'] === QODER_USER_AGENT);
  ok('不带 Cosy-ClientType（那是 /sash/ 活动线的头）', !('Cosy-ClientType' in headers));
  ok(
    '设备令牌原样当 Bearer，不做换取',
    qoderQuotaHeaders('dt-设备令牌').Authorization === 'Bearer dt-设备令牌',
  );
}

console.log('\n== 单池解析 ==');
{
  const pool = parseQoderQuotaPool('userQuota', THREE_POOL_BODY.userQuota);
  ok('字段齐全时逐项读出', pool?.total === 300 && pool?.used === 100 && pool?.remaining === 200);
  ok('可读名取中文标签', pool?.name === '主额度');
  ok('单位被带出', pool?.unit === 'credits');

  const sparse = parseQoderQuotaPool('userQuota', { unit: 'credits' });
  ok('字段缺席按 0，但池本身存在', sparse !== undefined && sparse.total === 0 && sparse.remaining === 0);

  ok(
    '非对象 ⇒ undefined（池不存在，不是余额 0）',
    [undefined, null, 0, 'x', [], true].every((bad) => parseQoderQuotaPool('userQuota', bad) === undefined),
  );
  ok('未知键也能解析，用键名兜底当可读名', parseQoderQuotaPool('futurePool', { remaining: 5 })?.name === 'futurePool');
}

console.log('\n== 整响应解析 ==');
{
  const usage = parseQoderQuotaUsage(T1_BODY);
  ok('T1 原文：只有一个池也算有效响应', usage !== undefined && usage.pools.length === 1);
  ok('userId / userType 被读出', usage?.userId === T1_BODY.userId && usage?.userType === 'personal_standard');
  ok('isQuotaExceeded 被读出', usage?.isQuotaExceeded === true);

  const year = new Date(usage.expiresAtMs).getUTCFullYear();
  ok('expiresAt 按毫秒读（9999 年，不是公元 800 万年）', year > 9000 && year < 10000, year);
  ok(
    'expiresAt 为 0/负数/非数字时视为「没给」',
    [0, -1, 'x', null, undefined].every(
      (bad) => !('expiresAtMs' in parseQoderQuotaUsage({ userQuota: { remaining: 1 }, expiresAt: bad })),
    ),
  );

  ok('后两池缺席时 pools 里就没有它们（不是补成 0）', parseQoderQuotaUsage(T1_BODY).pools.length === 1);
  ok(
    '三池齐全时顺序与展示顺序一致',
    JSON.stringify(parseQoderQuotaUsage(THREE_POOL_BODY).pools.map((p) => p.key)) === JSON.stringify(QODER_QUOTA_POOL_KEYS),
  );
  ok(
    '一个池都没有 ⇒ undefined（形态不认识，不是余额 0）',
    [{}, { userId: 'u' }, { foo: 1 }, null, [], 'x'].every((bad) => parseQoderQuotaUsage(bad) === undefined),
  );
  ok(
    'snake_case 的 user_id 也能读',
    parseQoderQuotaUsage({ user_id: 'u-snake', user_type: 't', userQuota: {} })?.userId === 'u-snake',
  );

  const bare = parseQoderQuotaUsage({ userQuota: {} });
  ok(
    '记录性字段缺失不报错，按默认值',
    bare.usageType === '' && bare.totalUsagePercentage === 0 && bare.isQuotaExceeded === false && bare.upgradeUrl === '',
  );
}

console.log('\n== 余额口径 ==');
{
  ok('余额 = 三池 remaining 之和', qoderQuotaRemainingTotal(parseQoderQuotaUsage(THREE_POOL_BODY)) === 300);
  ok(
    '负数 remaining 按 0 计（超额扣费/计量回滚会下发负值）',
    qoderQuotaRemainingTotal(parseQoderQuotaUsage({ userQuota: { remaining: -50 }, addOnQuota: { remaining: 30 } })) === 30,
  );
  ok(
    '浮点噪声被规整到两位小数',
    qoderQuotaRemainingTotal(
      parseQoderQuotaUsage({ userQuota: { remaining: 655.67000031 }, addOnQuota: { remaining: 0.00000001 } }),
    ) === 655.67,
  );
  ok('T1 全零账号的余额就是 0（真余额 0，不是查不到）', qoderQuotaRemainingTotal(parseQoderQuotaUsage(T1_BODY)) === 0);
  ok(
    '主池空但加量包有余额 ⇒ 不算空号',
    qoderQuotaRemainingTotal(parseQoderQuotaUsage(ADDON_BODY)) === 100 &&
      qoderQuotaHasAddOnOnly(parseQoderQuotaUsage(ADDON_BODY)) === true,
  );
  ok('主池还有余额时 hasAddOnOnly 为 false', qoderQuotaHasAddOnOnly(parseQoderQuotaUsage(THREE_POOL_BODY)) === false);
  ok(
    '主池空且加量包也空 ⇒ hasAddOnOnly 为 false',
    qoderQuotaHasAddOnOnly(parseQoderQuotaUsage({ userQuota: { remaining: 0 }, addOnQuota: { remaining: 0 } })) === false,
  );
}

console.log('\n== 网络与失败语义 ==');
{
  const fetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));
  const result = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher });
  ok('成功路径：ok 且 total 正确', result.ok === true && result.total === 300);
  ok('URL 拼装正确', fetcher.calls[0].url === `${QODER_CN_OPENAPI_BASE}${QODER_QUOTA_USAGE_PATH}`, fetcher.calls[0].url);
  ok('用 GET', fetcher.calls[0].init.method === 'GET');
  ok('Bearer 就是凭据里的令牌', fetcher.calls[0].init.headers.Authorization === `Bearer ${CREDENTIAL.accessToken}`);

  const noTokenFetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));
  const noToken = await Promise.all(
    [{}, { accessToken: '' }, { accessToken: 123 }, null].map((bad) => fetchQoderQuotaUsage(bad, { fetcher: noTokenFetcher })),
  );
  ok('缺少令牌：本地就判失败', noToken.every((r) => r.ok === false));
  ok('缺少令牌：文案提示重新登录', noToken.every((r) => r.message.includes('重新登录')));
  ok('缺少令牌：不发任何请求', noTokenFetcher.calls.length === 0);

  const netFail = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(new Error('ECONNREFUSED')) });
  ok('网络异常 ⇒ ok:false', netFail.ok === false && netFail.message.includes('网络失败'));
  ok('网络异常：绝不返回 0 余额', !('total' in netFail));

  const unauthorized = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(fakeResponse(401, { errorCode: 'TOKEN_EXPIRE' })) });
  ok('401 ⇒ ok:false 且带状态码', unauthorized.ok === false && unauthorized.status === 401);
  ok('401：凭据失效不当成余额 0', !('total' in unauthorized) && unauthorized.message.includes('401'));

  const serverErr = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(fakeResponse(500, { errorCode: 'InternalError' })) });
  ok('500 ⇒ ok:false，错误体摘要进文案', serverErr.ok === false && serverErr.message.includes('InternalError'));

  const notJson = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(fakeResponse(200, '<html>not json</html>')) });
  ok('非 JSON 响应 ⇒ ok:false', notJson.ok === false && notJson.message.includes('不是 JSON'));

  const unknownShape = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(fakeResponse(200, { hello: 'world' })) });
  ok('形态不认识的 200 ⇒ ok:false（三池缺失）', unknownShape.ok === false && unknownShape.message.includes('无法识别'));

  const zero = await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: fakeFetcher(fakeResponse(200, T1_BODY)) });
  ok(
    '「查不到」与「余额为 0」是两个结果',
    zero.ok === true && zero.total === 0 && netFail.ok === false && !('total' in netFail),
  );

  const brokeStream = await fetchQoderQuotaUsage(CREDENTIAL, {
    fetcher: fakeFetcher({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream broke');
      },
    }),
  });
  ok('响应体读取失败也归类为失败', brokeStream.ok === false && brokeStream.message.includes('读取失败'));

  ok('错误体摘要：空体有可读文案', summarizeQoderErrorBody('') === '(空响应体)' && summarizeQoderErrorBody('   ') === '(空响应体)');
  const summary = summarizeQoderErrorBody('x'.repeat(500));
  ok('错误体摘要被截断', summary.length < 250 && summary.endsWith('…'), summary.length);

  const altFetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));
  await fetchQoderQuotaUsage(CREDENTIAL, { fetcher: altFetcher, openapiBase: 'https://openapi.qoder.sh' });
  ok('openapiBase 可注入（为将来支持国际版留口）', altFetcher.calls[0].url === 'https://openapi.qoder.sh/api/v2/quota/usage');
}

console.log('\n== 批量刷新 ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const fetcher = fakeFetcher((n) => fakeResponse(200, n === 1 ? THREE_POOL_BODY : ADDON_BODY));
  const result = await refreshQoderPoolCredits(pool, { fetcher });
  ok('两个账号都刷新成功', result.refreshed === 2 && result.failed === 0);
  ok('账号 id 取池里的 id', result.accounts.map((a) => a.id).join(',') === pool.list().map((a) => a.id).join(','));
  ok('余额被记进池', pool.creditsOf(pool.list()[0].id) === 300 && pool.creditsOf(pool.list()[1].id) === 100);

  const mixedPool = new QoderAccountPool({ store: fakeStore([cred('u1', 'a'), cred('u2', 'b'), cred('u3', 'c')]) });
  await mixedPool.scan();
  const mixed = await refreshQoderPoolCredits(mixedPool, {
    fetcher: fakeFetcher((n) => (n === 2 ? new Error('boom') : fakeResponse(200, ADDON_BODY))),
  });
  ok('单账号失败不影响其它账号', mixed.refreshed === 2 && mixed.failed === 1);
  ok('失败账号不写余额（写 0 会被误判空号）', mixedPool.creditsOf(mixedPool.list()[1].id) === undefined);
  ok('失败条目不带 total', !('total' in mixed.accounts[1]) && mixed.accounts[1].ok === false);

  const emptyPool = new QoderAccountPool({ store: fakeStore([]) });
  await emptyPool.scan();
  const emptyFetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));
  const empty = await refreshQoderPoolCredits(emptyPool, { fetcher: emptyFetcher });
  ok('空池不报错', empty.refreshed === 0 && empty.failed === 0 && empty.accounts.length === 0);
  ok('空池不发请求', emptyFetcher.calls.length === 0);

  let inFlight = 0;
  let maxInFlight = 0;
  const serialPool = new QoderAccountPool({ store: fakeStore([cred('u1', 'a'), cred('u2', 'b'), cred('u3', 'c')]) });
  await serialPool.scan();
  await refreshQoderPoolCredits(serialPool, {
    fetcher: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return fakeResponse(200, ADDON_BODY);
    },
  });
  ok('串行发出（不并发打上游）', maxInFlight === 1, maxInFlight);
}

console.log('\n== 与号池保留额度的联动 ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([cred('low', '低额'), cred('high', '高额')]) });
  await pool.scan();
  const [lowId, highId] = pool.list().map((account) => account.id);
  pool.setCreditReserves({ [lowId]: 50, [highId]: 50 });

  ok('刷新前没有余额数据 ⇒ 保留额度判据无值可用，两个都算可用', pool.available(Date.now()).length === 2);

  const result = await refreshQoderPoolCredits(pool, {
    fetcher: fakeFetcher((n) => fakeResponse(200, { userQuota: { remaining: n === 1 ? 10 : 900 } })),
  });
  ok('两个账号都刷新成功', result.refreshed === 2);
  ok('余额被记住', pool.creditsOf(lowId) === 10 && pool.creditsOf(highId) === 900);
  ok(
    '刷新后：低于保留值的账号被挡在轮转外，另一个照常可用',
    pool.available(Date.now()).map((a) => a.id).join(',') === highId,
  );
}

console.log(`\nqoder-credits: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);