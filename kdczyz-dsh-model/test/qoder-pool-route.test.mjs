/**
 * `/qoder/pool` 快照路由 × provider 池：把「设置 → 池 → 界面」这条链钉死。
 *
 * # 为什么单开一条路由级测试
 *
 * 真机 bug 的形状是**写的地方与用的地方不是同一个池实例**：管理页把「当前账号」
 * 写进自己的池，请求路径用 provider 的池（`selectedId` 恒为 undefined，于是按
 * 池内顺序取第一个账号）——「固定了账号，请求还是打到别的号上」。
 *
 * 这类断裂有两个可能复发的位置，而它们都不在渲染测试的覆盖范围里：
 *
 *   1. **旧的四条写路由被加回来**（`/qoder/pool/config`、`/pool/account`、
 *      `/pool/select`、`/pool/credit-reserve`）。它们改的只能是管理页这个入口
 *      自己的池，加回来就等于把 bug 原样恢复。
 *   2. **快照字段退化**：界面标「当前使用」靠的是 `effectiveSelectedAccountId`
 *      与每个账号的 `selected`；少一个字段、或者把它算成「本次调用」那一个，
 *      界面就会说谎，而用夹具渲染的测试永远发现不了（夹具是我们自己写的）。
 *
 * 所以这里不用夹具：真的跑 `apply()` 起 provider、真的挂路由、真的发一次 GET，
 * 然后断言响应体，并且顺手断言**请求路径真的会用那个账号**（`pool.acquire()`）。
 *
 * 运行：node test/qoder-pool-route.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* —— 临时 DSH_HOME：绝不碰用户真实的 ~/.dsh ——
 *
 * `dshHomeDir()`（管理页）与 `qoderDshHome()`（provider）都是每次调用时读
 * `process.env.DSH_HOME`，两边同一个口径，所以这里设一次就够。
 */
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wotr-qoder-route-'));
process.env.DSH_HOME = DSH_HOME;

const { qoderAccountIdOf, saveQoderCredential } = await import('../lib/qoder-auth.mjs');
const { apply: applyQoder, currentQoderApi } = await import('../lib/qoder.js');
const { mountConsoleRoutes, qoderPool } = await import('../lib/index.js');

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

console.log('Qoder 号池快照路由（设置 → 池 → 界面）\n');

/* —— 造两个账号的凭据文件（池的内容**就是**这些文件）——
 *
 * 走**生产用的那个写入函数**而不是自己拼 JSON：文件格式一旦改了（版本号、
 * 字段名），这里会跟着一起变，不会出现「测试造的凭据 pool 读不出来」这种
 * 假绿。
 */
const accounts = [
  { userId: 'route-user-a', userName: 'route-a@example.com' },
  { userId: 'route-user-b', userName: 'route-b@example.com' },
];
const ids = [];
for (const who of accounts) {
  const saved = await saveQoderCredential({
    dshHome: DSH_HOME,
    accessToken: 'token-' + who.userId,
    refreshToken: 'refresh-' + who.userId,
    userId: who.userId,
    userName: who.userName,
    expiresAtMs: Date.now() + 3_600_000,
  });
  if (saved?.error !== undefined) {
    console.log(`  ✗ 写入测试凭据失败 — ${saved.error}`);
    process.exit(1);
  }
  ids.push(saved.accountId);
  if (saved.accountId !== qoderAccountIdOf(who)) {
    console.log('  ✗ 测试脚本自己算错了账号 id');
    process.exit(1);
  }
}
const FIRST = ids[0];
const SECOND = ids[1];

/* —— 起 provider（假的 ctx，只要 apply 用到的那几个面）—— */
const handlers = new Map();
const warns = [];
const qoderCtx = {
  fiber: { entry: { options: { id: 'dsh-connect-qoder' } } },
  logger: {
    error: () => {},
    warn: (...a) => warns.push(a.map((x) => (typeof x === 'string' ? x : String(x?.message ?? x))).join(' ')),
    info: () => {},
  },
  llm: {
    registerAdapter: () => () => {},
    registerConfigurableProviders: () => () => {},
    registerModelDiscovery: () => () => {},
  },
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : undefined;
  },
  on: (event, fn) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  },
};

/* 生产形态：volatile 活引用（用户每保存一次，`get()` 就返回新值）。 */
let selected = '';
let disabled = [];
let reserves = {};
const before = currentQoderApi();
applyQoder(qoderCtx, {
  selectedAccountId: { get: () => selected },
  disabledAccountIds: { get: () => disabled },
  creditReserves: { get: () => reserves },
});
{
  // 上限，不是断言：这一步包含异步注册（本机有真实凭据时还会真发一次目录请求），
  // 20s 在并发/满载时会偶发不够 —— 实测门禁里红过一次，单独复跑却全绿。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && currentQoderApi() === before) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
ok('provider 已发布句柄', currentQoderApi() !== before && currentQoderApi() !== undefined);

const pool = currentQoderApi().pool;
ok('管理页 qoderPool() 就是 provider 这个池（同一个对象）', qoderPool() === pool);

/* —— 挂管理页路由：只用假的 webServer，把注册表抓下来 —— */
const routes = new Map();
const webServer = {
  register(spec) {
    routes.set(spec.path, spec.handler);
    return () => routes.delete(spec.path);
  },
};
const consoleCtx = {
  logger: { error: () => {}, warn: () => {}, info: () => {} },
  inject: (names, callback) => {
    callback({ webServer });
  },
};
mountConsoleRoutes(consoleCtx, {});

const POOL_PATH = '/plugins/kdczyz-dsh-model/qoder/pool';
const handler = routes.get(POOL_PATH);
ok('挂上了 /qoder/pool', typeof handler === 'function', [...routes.keys()].slice(0, 3).join(', '));

/**
 * 发一次真 GET。
 *
 * `fetch` 在这里被换成「上游不可达」：额度查询失败**不该**让快照失败 ——
 * 页面上的号码、当前使用、停用标记都不依赖它（余额显示「—」而已）。
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('route-test: 上游不可达');
};

const snapshot = async (url = POOL_PATH, target = handler, method = 'GET') => {
  let status;
  let text = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      text += chunk ?? '';
    },
  };
  await target({ method, url, headers: { origin: 'http://127.0.0.1:19387' } }, res);
  return { status, body: JSON.parse(text) };
};

/* —— 1) 快照的形状 —— */
{
  const { status, body } = await snapshot();
  ok('GET /qoder/pool 返回 200 与 ok:true', status === 200 && body.ok === true, `${status} ${JSON.stringify(body).slice(0, 120)}`);
  ok('池扫到了临时目录里的两个账号', body.accounts?.length === 2, String(body.accounts?.length));

  /**
   * 轮换/均衡已删：快照里不该再有 `distribution`。留着它意味着界面还能显示
   * 一个「分配策略」选择器，而池那边已经不再按它分配 —— 又一个「界面在说谎」。
   */
  ok('快照里没有 distribution（分配策略已删，只留优先）', !('distribution' in body), Object.keys(body).join(','));

  /**
   * 「当前使用」的判据（完全手动语义）：没显式选过时**没有**当前账号 ——
   * 界面显示「—」，请求失败并提示先「切换到此账号」。刻意不默认第一个账号：
   * 那等于「没选也能自动用上第一个」，与手动切换语义冲突。
   */
  ok('没选过时没有「当前使用」', body.effectiveSelectedAccountId === null, `${body.effectiveSelectedAccountId} vs ${FIRST}`);
  ok('未显式选择时 selectedAccountId 为 null（不假装选过）', body.selectedAccountId === null, String(body.selectedAccountId));
  const flagged = (body.accounts ?? []).filter((a) => a.selected === true);
  ok('没选过时没有卡片被标成「当前使用」', flagged.length === 0, JSON.stringify((body.accounts ?? []).map((a) => [a.id, a.selected])));
  ok('「本次调用」与「当前使用」是两个独立字段', 'serving' in body && body.serving !== null);
}

/* —— 2) 旧的四条写路由不许回来（它们只能写到管理页自己的池）—— */
{
  const legacy = [
    '/plugins/kdczyz-dsh-model/qoder/pool/config',
    '/plugins/kdczyz-dsh-model/qoder/pool/account',
    '/plugins/kdczyz-dsh-model/qoder/pool/select',
    '/plugins/kdczyz-dsh-model/qoder/pool/credit-reserve',
  ];
  const present = legacy.filter((p) => routes.has(p));
  ok('旧的四条写路由都不存在（写了也到不了请求路径）', present.length === 0, present.join(', '));
}

/* —— 3) 点「切换到此账号」= 写 settings → loader/volatile-update → 请求路径换人 —— */
{
  selected = SECOND;
  handlers.get('loader/volatile-update')?.();

  ok('provider 把设置里的当前账号推给了池', pool.selectedAccountId() === SECOND, String(pool.selectedAccountId()));

  const acquired = await pool.acquire();
  ok('请求路径真的会用新选的账号（本 bug 的核心判据）', acquired?.id === SECOND, `${acquired?.id} vs ${SECOND}`);

  const { body } = await snapshot();
  ok('快照的 current 跟着换', body.effectiveSelectedAccountId === SECOND, String(body.effectiveSelectedAccountId));
  const flagged = (body.accounts ?? []).filter((a) => a.selected === true);
  ok('界面上「当前使用」只有新账号一个', flagged.length === 1 && flagged[0].id === SECOND, JSON.stringify(flagged.map((a) => a.id)));
  ok('另一张卡变成备用', (body.accounts ?? []).find((a) => a.id === FIRST)?.selected === false);
}

/* —— 4) 选中账号不可用 → 请求直接失败（完全手动，不让位）—— */
{
  warns.length = 0;
  // 把选中的 SECOND 停用：这正是「不可用」的一种
  disabled = [SECOND];
  handlers.get('loader/volatile-update')?.();

  const acquired = await pool.acquire();
  ok('选中账号停用时请求失败（不自动换号）', acquired === undefined, String(acquired?.id));

  ok(
    '失败原因写了一条 warn 日志（请求失败而不是换号）',
    warns.some((line) => line.includes('当前无可用账号') && line.includes('请手动切换账号')),
    JSON.stringify(warns),
  );

  const { body } = await snapshot();
  const second = (body.accounts ?? []).find((a) => a.id === SECOND);
  ok('停用不改变「当前使用」（那是用户选的那个）', body.effectiveSelectedAccountId === SECOND, String(body.effectiveSelectedAccountId));
  ok('停用账号被标成已停用', second?.disabled === true);
  ok('「本次调用」没有可服务的账号', body.serving?.accountId === undefined || body.serving?.accountId === null, JSON.stringify(body.serving));

  disabled = [];
  handlers.get('loader/volatile-update')?.();
  const recovered = await pool.acquire();
  ok('恢复停用后又能用回选中账号', recovered?.id === SECOND, String(recovered?.id));
}

/* —— 5) 停用走同一条线（保留额度已删除）—— */
{
  disabled = [FIRST];
  handlers.get('loader/volatile-update')?.();

  const { body } = await snapshot();
  ok('停用列表推到了快照（停用卡片置灰）', (body.accounts ?? []).find((a) => a.id === FIRST)?.disabled === true);
  ok('快照里没有保留额度字段', !('creditReserves' in body), Object.keys(body).join(','));
  ok('账号行里没有保留额度字段', (body.accounts ?? []).every((a) => a.creditReserve === undefined));
}

/* —— 6) 清空选择 = 无可用账号 —— */
{
  selected = '';
  handlers.get('loader/volatile-update')?.();
  const { body } = await snapshot();
  ok('清空选择后没有当前账号（请求将失败）', body.selectedAccountId === null && body.effectiveSelectedAccountId === null, `${body.selectedAccountId} / ${body.effectiveSelectedAccountId}`);
}

/**
 * —— 7) 模型目录路由：图片能力与上下文窗口必须**每条都在** ——
 *
 * 「Qoder 的模型要支持图片功能和上下文限制」这件事的最后一环在接口上：前端
 * 渲染「图片」标记与「上下文 180K」用的就是这两个字段，缺一个那张卡就开始说谎
 * （或者更糟：`contextWindow` 不是正整数时宿主 `normalizeModelInfo` 会直接抛
 * `INVALID_MODEL_CONTEXT`，整个模型从选择器里消失）。
 *
 * ⚠️ 这里的断言**必须对「上游可达」与「上游不可达」两种情况都成立**：目录可能
 * 是刚拉到的那份，也可能是内置兜底表。所以只钉**形状**（每条都有正整数窗口、
 * 布尔图片标记），不钉具体型号集合。
 */
{
  const MODELS_PATH = '/plugins/kdczyz-dsh-model/qoder/models/refresh';
  const modelsHandler = routes.get(MODELS_PATH);
  ok('挂上了 /qoder/models/refresh', typeof modelsHandler === 'function', [...routes.keys()].length);

  const { status, body } = await snapshot(MODELS_PATH, modelsHandler);
  ok('GET 回 200 且 ok:true（只读快照，不触发上游拉取）', status === 200 && body.ok === true, String(status));
  const models = Array.isArray(body.models) ? body.models : [];
  ok('目录永不为空（拉不到上游时用内置兜底表）', models.length >= 10, String(models.length));
  ok(
    '每条模型都带**正整数** contextWindow（缺了宿主会拒绝这个模型）',
    models.length > 0 && models.every((m) => Number.isInteger(m.contextWindow) && m.contextWindow > 0),
    JSON.stringify(models.filter((m) => !(Number.isInteger(m.contextWindow) && m.contextWindow > 0)).map((m) => m.id)),
  );
  ok(
    '每条模型都带**布尔** supportsImages（界面上的「图片」标记靠它）',
    models.length > 0 && models.every((m) => typeof m.supportsImages === 'boolean'),
    JSON.stringify(models.filter((m) => typeof m.supportsImages !== 'boolean').map((m) => m.id)),
  );
  ok(
    '目录里既有图片模型也有纯文本模型（不是一刀切）',
    models.some((m) => m.supportsImages === true) && models.some((m) => m.supportsImages === false),
  );
  ok(
    '回执里有 capabilities 接线自述（部署后判断跑的是哪一版代码）',
    typeof body.capabilities === 'object' && body.capabilities !== null && 'imageAttachments' in body.capabilities,
    JSON.stringify(body.capabilities),
  );

  /* POST = 拉上游。真拉会打网络、结果随环境变（这个测试不该依赖它），所以把
   * provider 的 `refreshCatalog` 换成桩 —— **失败**这一支恰好是面板必须正确
   * 处理的那支：回 502 + ok:false + 仍然带目录，而面板据此**一个字段都不写**
   * （见 console-render 的「从 Qoder 刷新」那组断言）。 */
  const api = currentQoderApi();
  const realRefresh = api.refreshCatalog;
  api.refreshCatalog = async () => ({
    ok: false,
    models: api.catalog.current(),
    message: '测试桩：上游不可达',
  });
  try {
    const post = await snapshot(MODELS_PATH, modelsHandler, 'POST');
    ok(
      'POST 拉取失败时回 502 + ok:false（不假装成功）',
      post.status === 502 && post.body.ok === false,
      `${post.status} ${JSON.stringify(post.body).slice(0, 120)}`,
    );
    ok('失败回执里带原因（面板直接显示它）', post.body.error === '测试桩：上游不可达', String(post.body.error));
    ok(
      '失败回执里仍然带目录（面板要能显示「现在能用哪些模型」）',
      Array.isArray(post.body.models) && post.body.models.length >= 10,
    );
  } finally {
    api.refreshCatalog = realRefresh;
  }
}

globalThis.fetch = realFetch;
console.log(`\nqoder-pool-route: ${pass} 通过, ${fail} 失败`);

/** `apply()` 起了 loopback shim（HTTP server 句柄），不显式退出进程会挂住。 */
fs.rmSync(DSH_HOME, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
