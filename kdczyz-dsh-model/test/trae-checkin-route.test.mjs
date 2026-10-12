/**
 * Trae 签到路由 × 账号维度：把「给某个账号签到」这条链钉死。
 *
 * # 为什么单开一条路由级测试
 *
 * 上游 `checkin_credits/claim` **没有 accountId 参数** —— 它结算的是「这份凭证属于
 * 谁」。所以「给备用账号签到」不是把 id 传给上游，而是**换一份凭证**走同一条流程：
 * 路由收 `accountId`，向 `deps.clientOfAccount` 要一个带那个账号凭证的一次性 client。
 * 这一步写错的两种形状，渲染测试都发现不了（它只看得见请求体）：
 *
 *   1. **拿绑定账号的 client 去签**（`deps.client(region)`）—— 界面显示「签到完成」，
 *      钱却进了当前账号的口袋：用户以为签的是备用号，实际动的是正在服务的那个；
 *   2. **顺手 `selectAccount` 重绑**（先用共享 client 换账号再签）—— 签到成功了，
 *      但 Trae 正在服务的账号被悄悄换掉，并发的聊天请求还会跟着串号。
 *
 * 另外两条语义必须分开回答，混起来就是当初修过的那个 bug：
 * `alreadyCheckedIn`（**这个账号**今天领过了）与 `deviceCheckedIn` / `code: 9095`
 * （**这台机器**今天已经用掉签到，可能是别的账号用掉的）。
 *
 * 最后，指定账号的签到**不**在 `didCheckedIn` 上提前返回：那个标志说的是机器，
 * 我们问的是一个具体账号今天有没有拿到钱 —— 上游到底会不会在同一台机器上放行第二个
 * 账号，是上游的性质，不该由我们假设。被拒也只有一次调用的代价（9095 带回来，
 * 界面照实说）。不指定账号时保持原样（提前返回），因为那条路径没有任何新信息可拿。
 *
 * 运行：node test/trae-checkin-route.test.mjs
 */

const {
  TRAE_CHECKIN_PATH,
  registerTraeUsageRoute,
} = await import('../lib/trae.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};

console.log('Trae 签到路由（按账号 / 设备语义）\n');

/** 一个假的上游签到 client：记下自己被调了几次、返回预设的回执。 */
const makeClient = (label, statuses, claimReply) => {
  const client = {
    label,
    statusCalls: 0,
    claimCalls: 0,
    async checkinStatus() {
      const at = Math.min(client.statusCalls, statuses.length - 1);
      client.statusCalls += 1;
      return statuses[at];
    },
    async claimCheckin() {
      client.claimCalls += 1;
      return claimReply;
    },
  };
  return client;
};

const paidStatus = (extra = {}) => ({
  checkedIn: true,
  didCheckedIn: true,
  credits: 50,
  enabled: true,
  ...extra,
});
const unpaidStatus = (extra = {}) => ({
  checkedIn: false,
  didCheckedIn: false,
  credits: 0,
  enabled: true,
  ...extra,
});

/** 挂一次路由，返回 { handler, clients } —— clients 记录每个 client 被谁调用过。 */
const mount = (deps) => {
  const routes = new Map();
  const ctx = {
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
  };
  registerTraeUsageRoute(ctx, deps);
  return routes.get(TRAE_CHECKIN_PATH);
};

/** 假 req/res：够 json()/loopbackOrigin()/readJsonBody() 用。 */
const callRoute = async (handler, { method = 'POST', url = `${TRAE_CHECKIN_PATH}?region=cn`, body = undefined, origin = undefined } = {}) => {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')];
  const req = {
    method,
    url,
    headers: origin === undefined ? {} : { origin },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code) => {
      status = code;
    },
    end: (value) => {
      payload = value ?? '';
    },
  };
  await handler(req, res);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = undefined;
  }
  return { status, body: parsed, raw: payload };
};

/** 默认那套 deps：绑定的 client 与「另一个账号」的 client 分得开，谁被调用一目了然。 */
const makeDeps = ({ bound, others = {}, store = undefined } = {}) => {
  const seen = { client: [], clientOfAccount: [] };
  return {
    seen,
    deps: {
      store: () => store ?? { selectedAccountId: 'bound-1' },
      pool: () => ({ accounts: [] }),
      client: (region) => {
        seen.client.push(region);
        return bound;
      },
      clientOfAccount: async (region, accountId) => {
        seen.clientOfAccount.push(`${region}:${accountId}`);
        return others[accountId];
      },
      creditsOfAccount: async () => undefined,
      displayModels: () => [],
      liveModels: () => [],
      enabledModelIds: () => [],
      regionEnabled: () => true,
      discoverModels: async () => [],
      probeModels: async () => [],
      rawDiagnostic: () => ({}),
    },
  };
};

/* —— 1) 指定账号：用**那个账号**的 client，且绝不碰绑定的那个 —— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: true, code: 0, message: '' });
  const backup = makeClient(
    'backup',
    [unpaidStatus(), paidStatus({ didCheckedIn: true })],
    { claimed: true, code: 0, message: '' },
  );
  const { deps, seen } = makeDeps({ bound, others: { 'backup-9': backup } });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: { accountId: 'backup-9' } });

  ok('指定账号签到返回 200', res.status === 200, `${res.status} ${res.raw}`);
  ok(
    '用的是该账号的 client（clientOfAccount），不是绑定账号的 client',
    seen.clientOfAccount.join() === 'cn:backup-9' && seen.client.length === 0,
    `clientOfAccount=${seen.clientOfAccount} client=${seen.client}`,
  );
  ok('签的是那个账号：它的 client 真的发了 claim', backup.claimCalls === 1, `claimCalls=${backup.claimCalls}`);
  ok('绑定账号的 client 一次都没被调用（没有重绑 / 没有串号）', bound.claimCalls === 0 && bound.statusCalls === 0);
  ok('回执里 claimed=true', res.body?.claimed === true, JSON.stringify(res.body));
  ok(
    '回执里带上 accountId（界面据此把结果落到那张卡上）',
    res.body?.accountId === 'backup-9',
    JSON.stringify(res.body),
  );
  ok(
    '回执里的 checkin 是签完**重读**的状态（今日已签到 · 已领 +50）',
    res.body?.checkin?.checkedIn === true && res.body?.checkin?.credits === 50,
    JSON.stringify(res.body?.checkin),
  );
  ok('签完重读了一次状态（status → claim → status）', backup.statusCalls === 2, `statusCalls=${backup.statusCalls}`);
}

/* —— 2) 不指定账号：保持原样，用绑定账号的 client —— */
{
  const bound = makeClient('bound', [unpaidStatus(), paidStatus()], { claimed: true, code: 0, message: '' });
  const { deps, seen } = makeDeps({ bound, others: { 'backup-9': makeClient('backup', [unpaidStatus()], { claimed: true, code: 0, message: '' }) } });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: {} });

  ok('不带 accountId 时返回 200（账号页那条老路径不变）', res.status === 200, `${res.status} ${res.raw}`);
  ok(
    '不带 accountId 时用的是绑定账号的 client',
    seen.client.join() === 'cn' && seen.clientOfAccount.length === 0,
    `client=${seen.client} clientOfAccount=${seen.clientOfAccount}`,
  );
  ok('不带 accountId 时回执里没有 accountId 字段', res.body?.accountId === undefined, JSON.stringify(res.body));
  ok(
    '没有 body 也不报错（老调用方就是不带 body 的 POST）',
    (await callRoute(handler, { body: undefined })).status === 200,
  );
}

/* —— 3) 账号不存在：404，而不是悄悄签成绑定的那个 —— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: true, code: 0, message: '' });
  const { deps, seen } = makeDeps({ bound, others: {} });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: { accountId: 'nope' } });

  ok('账号查不到时返回 404', res.status === 404, `${res.status} ${res.raw}`);
  ok('404 的原因是 unknown account', res.body?.error === 'account not found', res.raw);
  ok(
    '查不到账号时连绑定账号的 client 都不去取，更不会退回它去签',
    bound.claimCalls === 0 && bound.statusCalls === 0 && seen.client.length === 0,
    `client=${seen.client} claim=${bound.claimCalls} status=${bound.statusCalls}`,
  );
}

/* —— 4) 指定账号时不被 didCheckedIn 提前拦住（本机签过 ≠ 这个账号签过）—— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: false, code: 9095, message: 'device used' });
  // 本机今天已经用掉签到（didCheckedIn），但这个账号自己没签过。
  const backup = makeClient(
    'backup',
    [unpaidStatus({ didCheckedIn: true }), paidStatus({ didCheckedIn: true })],
    { claimed: true, code: 0, message: '' },
  );
  const { deps } = makeDeps({ bound, others: { 'backup-9': backup } });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: { accountId: 'backup-9' } });

  ok('指定账号 + 本机签过：仍然去问一次上游（不假设机器级门禁就是账号级）', backup.claimCalls === 1, `claimCalls=${backup.claimCalls}`);
  ok('…上游放行时如实报 claimed=true', res.body?.claimed === true, JSON.stringify(res.body));
  ok('…并且不谎报 alreadyCheckedIn', res.body?.alreadyCheckedIn === false, JSON.stringify(res.body));
}

/* —— 5) 指定账号 + 上游按设备拒签：如实带回 9095，并标出是**设备**—— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: false, code: 0, message: '' });
  const backup = makeClient(
    'backup',
    [unpaidStatus({ didCheckedIn: true }), unpaidStatus({ didCheckedIn: true })],
    { claimed: false, code: 9095, message: "this device already used today's check-in" },
  );
  const { deps } = makeDeps({ bound, others: { 'backup-9': backup } });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: { accountId: 'backup-9' } });

  ok('被设备门禁拒签时返回 200（这是一条业务回执，不是错误）', res.status === 200, `${res.status} ${res.raw}`);
  ok('回执里 claimed=false 且 code=9095', res.body?.claimed === false && res.body?.code === 9095, JSON.stringify(res.body));
  ok('回执里标了 deviceCheckedIn=true（界面说「本机已签」而不是「这个账号已签」）', res.body?.deviceCheckedIn === true, JSON.stringify(res.body));
  ok('回执里不谎报 alreadyCheckedIn', res.body?.alreadyCheckedIn === false, JSON.stringify(res.body));
}

/* —— 6) 账号自己今天领过了：不签，也不说是设备问题 —— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: true, code: 0, message: '' });
  const backup = makeClient('backup', [paidStatus({ didCheckedIn: false })], { claimed: true, code: 0, message: '' });
  const { deps } = makeDeps({ bound, others: { 'backup-9': backup } });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: { accountId: 'backup-9' } });

  ok('账号已领过时 claimed=false + alreadyCheckedIn=true', res.body?.claimed === false && res.body?.alreadyCheckedIn === true, JSON.stringify(res.body));
  ok('账号已领过时不再发 claim（幂等也不能靠上游兜底）', backup.claimCalls === 0, `claimCalls=${backup.claimCalls}`);
  ok('账号已领过时 deviceCheckedIn 跟随该账号的状态（这里是 false）', res.body?.deviceCheckedIn === false, JSON.stringify(res.body));
}

/* —— 7) 不指定账号 + 本机签过：保持提前返回（老行为，一次 claim 都不发）—— */
{
  const bound = makeClient('bound', [unpaidStatus({ didCheckedIn: true })], { claimed: true, code: 0, message: '' });
  const { deps } = makeDeps({ bound });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: {} });

  ok('不带 accountId + 本机签过：提前返回 9095', res.body?.code === 9095 && res.body?.deviceCheckedIn === true, JSON.stringify(res.body));
  ok('…并且没有真的发 claim', bound.claimCalls === 0, `claimCalls=${bound.claimCalls}`);
}

/* —— 8) 没有签到活动：409，不发 claim —— */
{
  const bound = makeClient('bound', [unpaidStatus({ enabled: false })], { claimed: true, code: 0, message: '' });
  const { deps } = makeDeps({ bound });
  const handler = mount(deps);
  const res = await callRoute(handler, { body: {} });

  ok('账号没有签到活动时返回 409', res.status === 409, `${res.status} ${res.raw}`);
  ok('…并且没有发 claim', bound.claimCalls === 0, `claimCalls=${bound.claimCalls}`);
}

/* —— 9) 边界：方法 / 区域 / 来源 / 坏 JSON —— */
{
  const bound = makeClient('bound', [unpaidStatus()], { claimed: true, code: 0, message: '' });
  const { deps, seen } = makeDeps({ bound });
  const handler = mount(deps);

  const get = await callRoute(handler, { method: 'GET' });
  ok('GET 返回 405（签到会改上游状态，只认 POST）', get.status === 405, `${get.status} ${get.raw}`);

  const ai = await callRoute(handler, { url: `${TRAE_CHECKIN_PATH}?region=ai` });
  ok('国际版区域返回 404（那边没有签到活动）', ai.status === 404, `${ai.status} ${ai.raw}`);

  const bad = await callRoute(handler, { url: `${TRAE_CHECKIN_PATH}?region=xx` });
  ok('未知区域返回 400', bad.status === 400, `${bad.status} ${bad.raw}`);

  const foreign = await callRoute(handler, { origin: 'https://evil.example.com' });
  ok('非本机来源返回 403（签到不能被外站页面触发）', foreign.status === 403, `${foreign.status} ${foreign.raw}`);

  const loopback = await callRoute(handler, { origin: 'http://127.0.0.1:19387' });
  ok('本机来源照常放行', loopback.status === 200, `${loopback.status} ${loopback.raw}`);

  // 上面几条（含本机来源那次成功的调用）已经把 client 取用记录写满了，这里清零，
  // 只看坏 JSON 这一拍有没有去碰 client。
  seen.client.length = 0;
  seen.clientOfAccount.length = 0;
  const beforeBroken = { status: bound.statusCalls, claim: bound.claimCalls };
  const broken = await callRoute(handler, { body: '{ not json' });
  ok('坏 JSON 返回 400 而不是 500', broken.status === 400, `${broken.status} ${broken.raw}`);
  ok(
    '坏 JSON 时不签任何账号（这一拍连 client 都没取）',
    bound.statusCalls === beforeBroken.status &&
      bound.claimCalls === beforeBroken.claim &&
      seen.client.length === 0 &&
      seen.clientOfAccount.length === 0,
    `client=${seen.client} clientOfAccount=${seen.clientOfAccount} status=${bound.statusCalls}`,
  );
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
