/**
 * Qoder 额度查询（lib/qoder-credits.mjs）的单测。
 *
 * 为什么要有这个文件：额度查询决定「账号还剩多少积分」。这部分错了不会抛异常
 * —— 表现为「明明还有加量包，账号却被当成空号踢掉」，或者更糟：「网络断了，
 * 卡片显示这个号 0 积分」，用户据此删掉一个好账号。
 *
 * 因此本文件用**真实的 T1 响应原文**做 fixture，而不是自己编一个「理想结构」
 * —— 编出来的结构永远恰好被自己的解析器接受，测不出形态漂移。覆盖：
 *
 *   - 三池结构、后两池可缺席、「一个池都没有 ⇒ 查不到」
 *   - 「查不到」与「余额为 0」严格区分（失败绝不伪造成 0）
 *   - 余额口径：三池求和、负数 clamp、主池空但加量包有余额
 *   - 网络失败 / 非 2xx / 非 JSON / 形态不认识
 *   - 批量刷新：逐账号记余额、单账号失败不牵连、串行
 *   - 与号池的联动（刷新积分的主要用途，完全手动切换语义下反映新余额）
 *
 * 运行：node test/qoder-credits.test.mjs
 */

import {
  QODER_CN_OPENAPI_BASE,
  QODER_QUOTA_POOL_KEYS,
  QODER_QUOTA_POOL_LABELS,
  QODER_QUOTA_USAGE_PATH,
  fetchQoderQuotaUsage,
  parseQoderQuotaPool,
  parseQoderQuotaUsage,
  qoderQuotaHasAddOnOnly,
  qoderQuotaHeaders,
  qoderQuotaRemainingTotal,
  refreshQoderPoolCredits,
  resolveQoderServingCredits,
  summarizeQoderErrorBody,
} from '../lib/qoder-credits.mjs';
import {
  QoderAccountPool,
  _resetQoderServedSlot,
  lastServedQoderAccountId,
  qoderAccountId,
} from '../lib/qoder-pool.mjs';

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
  /**
   * 这两条曾经断言「带官方 UA」+「不带 Cosy-ClientType」，与实现恰好相反
   * （实现早就改成官方额度链的形态了，断言没跟上，于是长期是红的）。
   *
   * 取证的结论是：官方额度链（`fetchQuotaUsage()` → `oo()` 包装）**不设 UA**，
   * 只补 `Cosy-*`；`Cosy-ClientType` 是额度链自己的头，与 `/sash/` 活动线**同名
   * 但不同值**。所以这里按取证结果断言，并顺手钉住「UA 不参与」这个事实 ——
   * 反过来的断言会逼着实现去发一个官方不发的头，反而被上游按指纹认出来。
   */
  ok('额度链不设 User-Agent（照官方：留给 Node fetch 的默认头）', !('User-Agent' in headers));
  ok('带上 Cosy-ClientType（额度链自己的值，不是 /sash/ 那个）', headers['Cosy-ClientType'] === '5');
  ok('带上 Cosy-Version', typeof headers['Cosy-Version'] === 'string' && headers['Cosy-Version'] !== '');
  ok('带上 Cosy-MachineOS（形如 aarch64_darwin）', /^[a-z0-9]+_[a-z0-9]+$/i.test(headers['Cosy-MachineOS'] ?? ''));
  ok(
    '没有设备指纹时**整个不发** Cosy-MachineToken / Cosy-MachineType',
    !('Cosy-MachineToken' in headers) && !('Cosy-MachineType' in headers),
  );
  const withMachine = qoderQuotaHeaders('dt-xyz', { machineToken: 'mt', machineType: 'mac' });
  ok(
    '有设备指纹时两个一起发（官方 K5A 的语义）',
    withMachine['Cosy-MachineToken'] === 'mt' && withMachine['Cosy-MachineType'] === 'mac',
  );
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

console.log('\n== 与号池的联动（完全手动切换） ==');
{
  // 保留额度 / 分配策略 / 轮换已在 beta 重构中删除。号池现在是**完全手动**
  // 切换：`available()` 只看「是否被停用」（余额不参与可用性），真正的取号只
  // 认 `selectAccount` 选中的那一个（`resolveSelected`）。这个用例验证的是
  // 刷新积分的真正用途：`refreshQoderPoolCredits` 把余额记回号池后，
  // `creditsOf` / `available` / `resolveSelected` 都反映新余额。
  const pool = new QoderAccountPool({ store: fakeStore([cred('low', '低额'), cred('high', '高额')]) });
  await pool.scan();
  const [lowId, highId] = pool.list().map((account) => account.id);

  pool.selectAccount(highId);
  ok('未选中/选中前都不借余额判断：两个都没被停用，都算可用', pool.available(Date.now()).length === 2);
  ok('刷新前选中的账号可直接取号（尚未刷新也能用）', pool.resolveSelected(Date.now())?.id === highId);

  const result = await refreshQoderPoolCredits(pool, {
    fetcher: fakeFetcher((n) => fakeResponse(200, { userQuota: { remaining: n === 1 ? 10 : 900 } })),
  });
  ok('两个账号都刷新成功', result.refreshed === 2);
  ok('余额被记住（低额 10 / 高额 900）', pool.creditsOf(lowId) === 10 && pool.creditsOf(highId) === 900);

  ok('刷新后：选中的账号仍然可取号', pool.resolveSelected(Date.now())?.id === highId);
  ok(
    '未选中的账号不参与取号（resolveSelected 不落到它）',
    pool.resolveSelected(Date.now())?.id !== lowId,
  );

  // 完全手动：停用是唯一把账号从 available 里剔出去的方式（不是余额）。
  pool.applyConfig({ disabledAccountIds: [highId] });
  ok(
    '刷新前后停用禁用照常生效：停用的账号被挡在 available 外',
    pool.available(Date.now()).map((a) => a.id).join(',') === lowId,
  );
  ok(
    '停用的选中账号 resolveSelected 落空（不自动让位、不自动换号）',
    pool.resolveSelected(Date.now()) === undefined,
  );
}

console.log('\n== 只为显示而读：节流判据 sinceMs ==');
{
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const [aliceId, bobId] = pool.list().map((account) => account.id);
  const fetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));

  const first = await refreshQoderPoolCredits(pool, { fetcher });
  ok('首轮两个账号都真读了', first.refreshed === 2 && fetcher.calls.length === 2);
  ok('读到余额会记录「读到的时刻」', pool.creditsAt(aliceId) > 0 && pool.creditsAt(bobId) > 0);

  // 界面上每 30 秒一拍。没有这个判据，一个开着设置面板的窗口就会稳定地
  // 每 30 秒打一次上游额度接口 —— 这是纯浪费，而且会被上游当成异常流量。
  // 调用方表达「3 分钟内读到过的别再读」的方式就是传 3 分钟这个**时长**。
  const throttled = await refreshQoderPoolCredits(pool, { fetcher, sinceMs: 180_000 });
  ok('sinceMs 过滤掉仍然新鲜的账号', throttled.refreshed === 0 && throttled.skipped === 2, JSON.stringify(throttled));
  ok('跳过的账号不再发请求', fetcher.calls.length === 2);
  ok('跳过条目带 skipped 标记', throttled.accounts.every((a) => a.skipped === true && a.ok === true));
  ok('跳过条目仍带上已知余额（界面要能继续显示）', throttled.accounts.every((a) => a.total === 300));

  // 余额本身不能被跳过动作改掉 —— 跳过只是「不重读」，不是「清空」。
  ok('跳过不动已有余额', pool.creditsOf(aliceId) === 300 && pool.creditsOf(bobId) === 300);

  // 窗口收得比「刚才那次读」更短 ⇒ 陈旧 ⇒ 必须重新读，否则界面会永远停在
  // 旧数字上。先睡一拍保证「读到的时刻」确实已经过去了。
  //
  // ⚠️ 至少要 10ms：判据是 `now - creditsAt <= sinceMs`，而 `Date.now()` 只有
  // 毫秒粒度 —— 睡 2ms 时定时器可能在 1.9ms 触发、`Date.now()` 只前进 1ms，
  // 于是 `1 <= 1` 命中「还算新鲜」，测试随机变红（本套件实测出现过）。
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stale = await refreshQoderPoolCredits(pool, { fetcher, sinceMs: 1 });
  ok('超过新鲜窗口后重新读', stale.refreshed === 2 && stale.skipped === 0 && fetcher.calls.length === 4, JSON.stringify(stale));

  // sinceMs 传成一个**时间戳**（`Date.now()`，很自然的手误）时不再恒真：
  // 把「窗口」当时间戳比会永远跳过，界面上的余额再也不会更新且不报错。
  const misused = await refreshQoderPoolCredits(pool, { fetcher, sinceMs: Date.now() });
  ok('sinceMs 被误传成时间戳也只是「窗口极大」，行为可预期', misused.skipped === 2, JSON.stringify(misused));
}

console.log('\n== resolveQoderServingCredits：显示的就是被调用的那个账号 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await pool.scan();
  const alice = pool.list().find((a) => a.label === 'alice');
  const bob = pool.list().find((a) => a.label === 'bob');

  // 余额**按令牌**区分（100 是 bob 的、300 是 alice 的）：这样断言掉的不是
  // 「读到了数字」，而是「读到的是这个账号的数字」——把 A 的余额显示成 B 的
  // 是这类界面上最难发现的错误。
  const fetcher = fakeFetcher((_n, url, init) =>
    fakeResponse(200, String(init?.headers?.Authorization ?? '').includes('dt-u2') ? ADDON_BODY : THREE_POOL_BODY),
  );

  pool.noteServed(bob.id);
  const served = await resolveQoderServingCredits(pool, { fetcher, freshMs: 180_000 });
  ok('报告被调用的账号', served.accountId === bob.id, served.accountId);
  ok('source 标记为 served', served.source === 'served', served.source);
  ok('带上账号名（界面要显示是谁）', served.label === 'bob', served.label);
  ok('余额是被调用账号自己的余额', served.credits === 100, String(served.credits));
  ok('只读了被调用的那个账号（读的是它的令牌）', fetcher.calls.length === 1 && String(fetcher.calls[0].init.headers.Authorization).includes('dt-u2'));
  ok('顺带记下读到的时刻', typeof served.atMs === 'number' && served.atMs > 0);

  // 新鲜窗口内再问一次：不能再打上游（界面每 30 秒一拍）。
  const again = await resolveQoderServingCredits(pool, { fetcher, freshMs: 180_000 });
  ok('新鲜窗口内复用已知余额', again.credits === 100 && fetcher.calls.length === 1, String(fetcher.calls.length));
  ok('复用时不重复写时钟', again.atMs === served.atMs);

  // 窗口过期必须真的重读（否则用户永远看不到余额下降）。把「现在」往后推
  // 5 分钟，跨过 3 分钟的窗口；比改系统时间稳。
  const refreshed = await resolveQoderServingCredits(pool, {
    fetcher,
    freshMs: 180_000,
    now: Date.now() + 5 * 60 * 1000,
  });
  ok('窗口过期后重新读', fetcher.calls.length === 2 && refreshed.credits === 100);

  // 没有任何调用记录时如实说「这是下一个会用的」，而不是假装它已经服务过。
  // 完全手动语义下「下一个会用的」= 用户**选中**的那个账号（resolveNext 只认
  // selectedId，不自动换号），所以这里要先选中，预告才有意义。
  _resetQoderServedSlot();
  const virgin = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice'), cred('u2', 'bob')]) });
  await virgin.scan();
  // 完全手动语义下「下一个会用的」= 用户**选中**的那个账号（resolveNext 只认
  // selectedId，不自动换号），所以提前选中以表达「这是下一会取号的目标」。
  const aliceId = virgin.list().find((a) => a.label === 'alice').id;
  virgin.selectAccount(aliceId);
  const nextFetcher = fakeFetcher(fakeResponse(200, ADDON_BODY));
  const preview = await resolveQoderServingCredits(virgin, { fetcher: nextFetcher });
  ok('没有调用记录时给出预告', preview.source === 'next', preview.source);
  ok('预告也带账号与余额（用户至少知道下一个会花谁的钱）', preview.accountId !== undefined && preview.credits === 100);

  // 空池：不能编造账号，也不能抛。
  const emptyPool = new QoderAccountPool({ store: fakeStore([]) });
  await emptyPool.scan();
  const emptyFetcher = fakeFetcher(fakeResponse(200, THREE_POOL_BODY));
  const none = await resolveQoderServingCredits(emptyPool, { fetcher: emptyFetcher });
  // accountId 刻意是 null 而不是 undefined：这个值会被 JSON 序列化后发给界面，
  // undefined 会在 JSON 里整个消失，留下的键就查不到了。
  ok('空池给出 source=none', none.source === 'none' && none.accountId === null, JSON.stringify(none));
  ok('空池不发请求', emptyFetcher.calls.length === 0);
  ok('空池余额为 null 而不是 0', none.credits === null, String(none.credits));

  // 共享槽位会过期：否则一个长期闲置的池实例会一直指着一个早就换掉的账号说
  // 「就是它扣的费」。这里必须用**第二个实例**来复现 —— 第一个实例自己的
  // `lastUsedAt` 里有记录，只有「从没服务过、只能靠共享槽位」的那个才会踩到。
  _resetQoderServedSlot();
  const credentials = [cred('u1', 'alice'), cred('u2', 'bob')];
  const providerPool = new QoderAccountPool({ store: fakeStore(credentials) });
  const adminPool = new QoderAccountPool({ store: fakeStore(credentials) });
  await providerPool.scan();
  await adminPool.scan();
  providerPool.noteServed(adminPool.list().find((a) => a.label === 'bob').id, Date.now() - 60 * 60 * 1000);
  const staleServing = await resolveQoderServingCredits(adminPool, {
    fetcher: fakeFetcher(fakeResponse(200, ADDON_BODY)),
  });
  ok('过期的共享记录不再冒充「本次调用」', staleServing.source !== 'served', staleServing.source);

  // 反向：新鲜的共享记录必须能跨实例读到（这正是这次改动的核心目的）。
  _resetQoderServedSlot();
  const provider2 = new QoderAccountPool({ store: fakeStore(credentials) });
  const admin2 = new QoderAccountPool({ store: fakeStore(credentials) });
  await provider2.scan();
  await admin2.scan();
  const bobId = admin2.list().find((a) => a.label === 'bob').id;
  provider2.noteServed(bobId);
  const crossServing = await resolveQoderServingCredits(admin2, {
    fetcher: fakeFetcher(fakeResponse(200, ADDON_BODY)),
  });
  ok('新鲜的共享记录跨实例生效', crossServing.source === 'served' && crossServing.accountId === bobId, crossServing.source);

}

console.log('\n== resolveQoderServingCredits：读失败绝不伪造成 0 ==');
{
  _resetQoderServedSlot();
  const pool = new QoderAccountPool({ store: fakeStore([cred('u1', 'alice')]) });
  await pool.scan();
  const [only] = pool.list();
  pool.noteServed(only.id);

  const failing = await resolveQoderServingCredits(pool, {
    fetcher: fakeFetcher(new Error('network down')),
  });
  // 显示 0 会让用户以为账号空了并把它删掉 —— 这是本文件开头就写明的红线。
  ok('读失败时 credits 为 null（不是 0）', failing.credits === null, String(failing.credits));
  ok('读失败时给出原因', typeof failing.error === 'string' && failing.error !== '', failing.error);
  ok('读失败时仍然知道是谁被调用了', failing.accountId === only.id && failing.source === 'served');
  ok('读失败不写余额（保持未知，界面显示 — 而非 0）', pool.creditsOf(only.id) === undefined);
  ok('读失败不推进「读到的时刻」（下次还会重试）', pool.creditsAt(only.id) === 0);

  // 上游返回 401：同样是失败，不能当成「余额 0」。
  const unauthorized = await resolveQoderServingCredits(pool, {
    fetcher: fakeFetcher(fakeResponse(401, { error: 'invalid token' })),
  });
  ok('HTTP 401 也算失败', unauthorized.credits === null && typeof unauthorized.error === 'string', unauthorized.error);
}

console.log(`\nqoder-credits: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);