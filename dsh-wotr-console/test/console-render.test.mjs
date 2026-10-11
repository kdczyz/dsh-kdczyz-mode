/**
 * 管理页的**渲染层**测试。
 *
 * 为什么要有这个文件：client-apply.test.mjs 只验证到「组件注册进 slots」，
 * 没有真正**调用**组件函数。而组件是在设置面板打开时才渲染的 ——
 * 如果它渲染时抛错，用户看到的是白屏或整个设置面板崩掉，
 * 而启动阶段一切正常，所以之前所有测试都拦不住。
 *
 * 这里用真实的 jsx 调用（不是 mock 组件）把组件跑一遍：
 *   - 调用 WorkBuddyPage() 拿到元素树
 *   - 递归展开树里的函数组件（AccountsTab / CreditsTab / HistoryTab）
 *   - 断言三种 tab 在「有数据」「无数据」「坏数据」下都不抛，且产出预期文本
 *
 * 运行：node test/console-render.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_MJS = path.resolve(HERE, '..', 'lib', 'console.mjs');

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

//#region 够用的 react / jsx-runtime

/**
 * 迷你 react：只实现组件用到的 hook。
 *
 * `preset` 用来预置 useState 的初值 —— 主组件把当前 tab 存在 state 里，
 * 从外部改不了，靠预置才能覆盖到「积分」「使用记录」等非默认标签页，
 * 以及账号页右列（Trae）的数据。
 * 组件里 useState 的调用顺序是固定的（前 21 个 useState，preset 下标即此顺序）：
 *   0 tab · 1 region · 2 status · 3 summary · 4 loading · 5 summaryLoading · 6 error · 7 busyId
 *   8 traeRegion · 9 traeStatus · 10 traeLoading · 11 traeError · 12 traeBusy
 *   13 login · 14 traeLogin
 *   15 qoderStatus · 16 qoderLoading · 17 qoderError · 18 qoderBusy · 19 qoderLogin
 *   20 qoderReserveDraft · 21 qoderCreditsNote
 *
 * `useRef` 是合并进 Trae 半边后新增的用法（console.mjs 的 traeLoaded），
 * 早先的桩没有它，于是 `useRef(false)` 抛 "useRef is not a function"、
 * 30 个渲染用例全灭。真 React 一定有 useRef，缺的是桩，不是组件。
 * 这里补上并让它同样占一个 hook 槽位（cursor++），
 * 与真 React 的「每次渲染都按同一顺序调用」保持一致，
 * 免得往后再加 hook 时下标悄悄错位。
 */
/**
 * `runEffects` 让 useEffect 真的执行一次（返回的清理函数被忽略）。
 *
 * 默认**不跑**：绝大多数用例只关心渲染输出，不跑副作用更快也更少噪音。
 * 但需要**真的拉数据**的用例必须跑 —— 配置页的 fetch 就在 useEffect 里，
 * 不跑的话「已加载」永远是假象（曾因此写出一条靠巧合通过的断言）。
 */
function makeReact(preset = {}, runEffects = false) {
  const hooks = [];
  /**
   * 每个跑过的 effect 返回的清理函数。
   *
   * 由调用方决定何时「卸载」（逐个跑一遍）。需要它的用例在
   * makeReact(...) 之后读 `react.cleanups`。
   */
  const cleanups = [];
  let cursor = 0;
  /**
   * setState 是真的（不再是 no-op）。
   *
   * 早期版本把 setter 做成空函数，于是「组件发请求 → 拿到数据 → setState」
   * 这条路径在测试里永远走不通：页面只能停在加载态，而断言的是加载后的
   * 内容。Trae 配置页的数据全部来自 fetch，所以这里必须让 setter 生效。
   * 预置值仍然优先（preset 覆盖初始渲染）。
   */
  return {
    useState(init) {
      const i = cursor++;
      if (i in preset) hooks[i] = preset[i];
      else if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [
        hooks[i],
        (v) => {
          hooks[i] = typeof v === 'function' ? v(hooks[i]) : v;
        },
      ];
    },
    useEffect(fn) {
      cursor++;
      if (runEffects) {
        try {
          // 清理函数统一收进 cleanups：要测「卸载」的用例自己跑一遍即可。
          // 早期版本把返回值直接丢掉，于是任何「卸载时有没有清定时器/退订」
          // 都无法验证 —— 而漏清定时器正是切会话越切越费的成因。
          const r = fn();
          if (typeof r === 'function') cleanups.push(r);
        } catch {
          /* 副作用里的错误不影响渲染层断言 */
        }
      }
    },
    useLayoutEffect() { cursor++; },
    useCallback(fn) { cursor++; return fn; },
    useMemo(fn) { cursor++; return fn(); },
    useRef(init) { cursor++; return { current: init }; },
    /**
     * 重置 hook 游标，模拟 React「每次渲染都从第一个 hook 开始」。
     *
     * 需要连续渲染同一个组件时（例如等 fetch 回来后再渲染一遍）必须调用它，
     * 否则第二遍渲染会从上一遍结束的下标继续取 state —— 拿到的全是别的字段，
     * 表现为页面莫名跳回另一个标签页。
     */
    reset() { cursor = 0; },
    /** 跑掉所有 effect 的清理函数，模拟组件卸载 */
    unmount() {
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* 清理里抛错不该让用例崩，交由断言判断 */
        }
      }
    },
    cleanups,
    createElement: () => null,
    Fragment: 'Fragment',
  };
}

/**
 * jsx/jsxs：直接返回元素对象。
 *
 * 刻意不复用真 react 的 jsx-runtime —— 我们要的就是元素树本身。
 * 关键是 children 的传递方式和 jsx-runtime 一致（放 props.children），
 * 这正是内联时踩过坑的地方。
 */
const makeJsxRuntime = () => ({
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  Fragment: 'Fragment',
});

//#endregion

//#region 把 console.mjs 变成可导入的模块

/** 剥掉 ESM 的 export 前缀，包成工厂，取出 createConsoleSection */
function loadFactory() {
  let src = fs.readFileSync(CONSOLE_MJS, 'utf8');
  src = src
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(function|const|let|var|class)\s+/gm, '$1 ');
  const leftover = src.match(/^\s*(import|export)\b.*$/m);
  if (leftover !== null) throw new Error(`无法内联的 ESM 语法：${leftover[0]}`);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn createConsoleSection;`)();
}

//#endregion

//#region 展开元素树

/**
 * 递归展开元素树，收集所有可见文本。
 *
 * 遇到 function 类型的 type 就调用它 —— 模拟 react 渲染函数组件。
 * depth 上限是防御：组件若互相引用，别把栈打爆。
 */
function collectText(node, out, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out, depth);
    return;
  }
  if (typeof node !== 'object') return;
  if (depth > 30) return;

  const { type, props } = node;
  if (typeof type === 'function') {
    let rendered;
    try {
      rendered = type(props ?? {});
    } catch (e) {
      throw new Error(`组件 ${type.name || '(匿名)'} 渲染抛错：${e.message}`);
    }
    collectText(rendered, out, depth + 1);
    return;
  }
  if (typeof type === 'string') collectText(props?.children, out, depth + 1);
}

/** 渲染一次，返回元素树里的全部文本 */
function renderPage(preset, props, embedded, runEffects = false) {
  const react = makeReact(preset, runEffects);
  const jsxRuntime = makeJsxRuntime();
  const Page = createConsoleSection({ react, jsxRuntime, embedded });
  const out = [];
  collectText(Page(props ?? {}), out);
  return out.join(' | ');
}

//#endregion

console.log('管理页渲染层测试\n');

const createConsoleSection = loadFactory();
ok('createConsoleSection 是函数', typeof createConsoleSection === 'function');

// fetch 永远 pending：模拟「加载中」，覆盖 loading 分支且不发真请求
globalThis.fetch = () => new Promise(() => {});

/**
 * 两侧的 settings 作用域桩。
 *
 * 合并后「XD Pool」「Trae 配置」两个标签页的组件本体都是**本包自写**的
 * （console.mjs 的 PoolConfigTab / TraeConfigTab），它们不再接收 vendored
 * 卡片，而是经 `embedded.wbSettings` / `embedded.traeSettings` 拿一个
 * **活句柄** `{ get(), subscribe(fn) }`，在渲染期取里面的 settings 作用域。
 *
 * 活句柄的理由：client.js 解析作用域可能晚于 apply 返回（configForms 的
 * describe 是异步的），页面必须在渲染期取值而不是拿快照。早先这里给的是
 * 快照，迁移后立刻失败 —— 这正是这一层该拦住的那类回归。
 *
 * 传 `null` 表示该侧缺失（用于覆盖只读降级分支）。
 */
function makeHandle(scope) {
  return {
    get: () => scope ?? null,
    subscribe: () => () => {},
  };
}

/**
 * settings 作用域桩（WorkBuddy 池与 Trae 同形）。
 *
 * 必须有：两个自写配置页都靠 `getSnapshot().writable` 判断「能不能写」，
 * 拿不到就整页退化成只读。这里默认给可写作用域，覆盖正常渲染路径；
 * `writable: false` 的变体用于覆盖诊断提示。
 */
function makeScope(value, writable = true) {
  return {
    getSnapshot: () => ({ status: 'ready', value: value ?? {}, writable }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
  };
}

/** WorkBuddy 池作用域桩（默认值给空文档，PoolConfigTab 只读快照本身） */
function makeWbScope(value) {
  return makeScope(value ?? {});
}

/** Trae 作用域桩 */
function makeTraeScope(value) {
  return makeScope(value ?? {});
}

function makeEmbedded(overrides) {
  return {
    wbSettings: makeHandle(makeWbScope({})),
    traeSettings: makeHandle(makeTraeScope({ regions: { cn: { enabled: true } } })),
    ...(overrides ?? {}),
  };
}

// —— 1) 默认渲染（XD Pool 标签页）——
{
  let err = null;
  let text = '';
  try {
    text = renderPage({}, {}, makeEmbedded());
  } catch (e) {
    err = e;
  }
  ok('WotrPage 默认渲染不抛异常', err === null, err?.message);
  ok('渲染出页面标题', text.includes('WOTR 管理'), `实际: ${text.slice(0, 120)}`);
  ok(
    '渲染出全部五个标签页',
    ['XD Pool', 'Trae 配置', '账号', '积分', '使用记录'].every((t) => text.includes(t)),
  );
  ok(
    '不再有独立的「Trae 账号」标签页（已并入「账号」两列）',
    !text.includes('Trae 账号'),
  );
  ok('默认标签页是 XD Pool（渲染出池配置页本体）', text.includes('WorkBuddy 池'));
  ok('XD Pool 页渲染出区域切换', text.includes('国内版') && text.includes('国际版'));
}

/**
 * —— 1b) 两侧作用域：存在、缺失、不可写都不许崩 ——
 *
 * 「不许崩」是硬要求：作用域可能解析失败（宿主版本差异 / 某一半加载失败），
 * 而渲染期抛错会让**整个设置面板白屏**，不只是这一个标签页。
 */
for (const [name, embedded] of [
  ['两侧都在', makeEmbedded()],
  ['embedded 整体为 undefined', undefined],
  ['wbSettings 为 null', makeEmbedded({ wbSettings: null })],
  ['traeSettings 为 null', makeEmbedded({ traeSettings: null })],
  ['wbSettings 句柄只返回 null', makeEmbedded({ wbSettings: makeHandle(null) })],
  ['wbSettings 句柄缺 get/subscribe', makeEmbedded({ wbSettings: {} })],
  ['wbSettings 作用域不可写', makeEmbedded({ wbSettings: makeHandle(makeScope({}, false)) })],
  ['Trae 作用域恒为 null', makeEmbedded({ traeSettings: makeHandle(null) })],
  ['Trae 作用域不可写', makeEmbedded({ traeSettings: makeHandle(makeScope({}, false)) })],
]) {
  for (const tabId of ['pool-config', 'trae-config']) {
    let err = null;
    try {
      renderPage({ 0: tabId }, {}, embedded);
    } catch (e) {
      err = e;
    }
    ok(`配置页（${name}）· ${tabId} 不崩`, err === null, err?.message);
  }
}

// —— 1c) 作用域不可写时必须给出诊断行，而不是假控件 ——
{
  const text = renderPage({ 0: 'pool-config' }, {}, makeEmbedded({ wbSettings: makeHandle(makeScope({}, false)) }));
  ok('XD Pool 作用域不可写时显示诊断行', text.includes('设置作用域不可写'));
}

/**
 * —— 1d) 缺失时给出可读提示，而不是空白 ——
 * 用户看到空白会以为插件坏了，看不到任何可报告的线索。
 * 自写配置页在拿不到作用域时仍渲染骨架 + 诊断行（而非降级占位）。
 */
{
  const text = renderPage({ 0: 'pool-config' }, {}, undefined);
  ok('wbSettings 缺失时仍渲染池配置页骨架', text.includes('WorkBuddy 池'));
  ok('wbSettings 缺失时显示只读诊断', text.includes('设置作用域不可写'));
}

// —— 2) 三个 tab 在有数据时都能渲染 ——
const statusFixture = {
  // 顶层 distribution：WorkBuddy 的分配策略是**池级单键**（一个池实例），
  // 账号页左列的「账号使用方式」直接读它。
  distribution: 'round-robin',
  // 「当前账号」：本区域请求固定用它。u1 被固定 —— 左列必须因此出现
  // 「当前使用 / 取消固定」，u2 显示「备用 / 设为当前」。
  selectedAccountId: 'u1',
  accounts: [
    {
      id: 'u1',
      nickname: '测试账号',
      credits: { total: 3080, packages: [{ packageName: '月包', remain: 80, size: 100 }] },
      checkin: { todayCheckedIn: true, streakDays: 9 },
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      cooling: false,
    },
    { id: 'u2', nickname: '冷却账号', credits: { total: 0, packages: [] }, cooling: true },
  ],
};

const summaryFixture = {
  totalSamples: 24,
  accounts: [
    { uid: 'u1', nickname: '测试账号', firstCredit: 3000, credit: 3080, delta: 80, lastTs: Date.now() - 3600000 },
    { uid: 'u2', nickname: '冷却账号', firstCredit: 100, credit: 0, delta: -100, lastTs: Date.now() - 86400000 },
  ],
  dailyTrend: [
    { day: '2026-10-08', delta: 80 },
    { day: '2026-10-09', delta: -100 },
  ],
};

const traeFixture = {
  status: 'signed-in',
  accountName: 'trae-user@example.com',
  accounts: [
    { id: 't1', accountName: 'trae-user@example.com', selected: true, edition: 'cn', source: 'desktop app' },
    { id: 't2', accountName: 'trae-backup@example.com', selected: false, edition: 'solo' },
  ],
  credits: { generalAvailable: 1200, workAvailable: 340 },
  checkin: { checkedIn: true, credits: 50 },
  // Trae 的分配策略在 `pool.distribution` 里（按区域那一份）。
  // 刻意给一个与 WorkBuddy 侧（round-robin）**不同**的值：两列读的是
  // 不同来源，若有一侧读错来源，两边就会显示成同一个值而看不出来。
  pool: { distribution: 'balanced' },
};

const withData = { 2: statusFixture, 3: summaryFixture, 4: false, 5: false };

/**
 * Qoder 号池页的 fixture。
 *
 * 形状对齐 lib/index.js 的 `/qoder/pool` 返回：accounts 里每项带
 * disabled / cooling / expired / creditReserve / rateLimitHits / credits，
 * 面板靠这些字段决定标签与按钮文案。两个账号刻意覆盖两种状态：
 *   - q1 可用（在轮换中），**有余额**（覆盖「余额」行的正常显示与合计）
 *   - q2 冷却中（带 cooldownUntilMs 与限流次数），**余额未知**（覆盖
 *     「未知（点上方刷新积分）」这条降级文案 —— 读不到不能显示成 0）
 *
 * hook 下标 15 是 qoderStatus（顺序见本文件开头的 useState 清单）。
 */
const qoderFixture = {
  ok: true,
  distribution: 'priority',
  disabledIds: [],
  creditReserves: {},
  // 「当前账号」：请求固定用它。q1 被固定，所以卡片上应出现「当前使用」，
  // 另一张显示「备用」—— 这是本插件新增的单账号语义，必须有渲染覆盖。
  selectedAccountId: 'q1',
  lastServedId: 'q1',
  status: { count: 2, cooling: 1 },
  accounts: [
    {
      id: 'q1',
      label: 'qoder-user@example.com',
      userId: 'qu1',
      expiresAtMs: 4102444800000,
      expired: false,
      disabled: false,
      selected: true,
      creditReserve: 0,
      credits: 300,
      cooldownUntilMs: 0,
      cooling: false,
      modelCooldowns: {},
      rateLimitHits: 0,
    },
    {
      id: 'q2',
      label: 'qoder-backup@example.com',
      userId: 'qu2',
      expiresAtMs: 4102444800000,
      expired: false,
      disabled: false,
      selected: false,
      creditReserve: 50,
      credits: null,
      cooldownUntilMs: 4102444800000,
      cooling: true,
      modelCooldowns: { 'qwen3.8-flash': 4102444800000 },
      rateLimitHits: 3,
    },
  ],
};

/**
 * XD Pool 页的完整状态 fixture。
 *
 * 形状对齐 vendor/xdpool/lib/index.js 的 poolWebStatus()：
 * accounts / models / selection / distribution / automation / ignored /
 * creditReserves 都是页面真的会读的字段。字段缺失的降级路径另有边界用例覆盖，
 * 这里给足数据，覆盖「有内容」的正常渲染。
 */
const poolStatusFixture = {
  ok: true,
  region: 'cn',
  distribution: 'round-robin',
  regions: ['cn', 'global'],
  accounts: [
    {
      id: 'u1',
      label: 'u1',
      nickname: '池内主号',
      cooling: false,
      disabled: false,
      creditReserve: 0,
      reserved: false,
      rateLimitHits: 0,
      credits: 3080,
      creditsError: null,
      checkin: { todayCheckedIn: true, streakDays: 9 },
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    {
      id: 'u2',
      label: 'u2',
      nickname: '冷却备用号',
      cooling: true,
      cooldownUntil: Date.now() + 60000,
      disabled: true,
      creditReserve: 100,
      reserved: true,
      rateLimitHits: 3,
      credits: 0,
      checkin: { todayCheckedIn: false, streakDays: 0 },
    },
  ],
  models: [
    {
      id: 'm1',
      name: 'DeepSeek-V4-Flash',
      nativeContextWindow: 2e5,
      maxTokens: 8192,
      supportsImages: false,
      supportedEfforts: ['off', 'low', 'medium', 'high'],
      enabled: true,
    },
    {
      id: 'm2',
      name: 'GLM-5.2',
      nativeContextWindow: 1e6,
      maxTokens: 16384,
      supportsImages: true,
      supportedEfforts: ['off', 'high'],
      enabled: false,
    },
  ],
  selection: {
    enabledModelIds: ['m1'],
    imageModelIds: [],
    contextBudgets: {},
    reasoningEfforts: {},
    maxMode: false,
  },
  automation: {
    enabled: true,
    checkinHours: [9],
    reportHours: [10],
    taskHours: [11],
    streakHours: [12],
    travelHours: [9, 21],
    jobs: {
      checkin: { ok: 1, failed: 0, credit: 20, energy: 5, claimed: 0, at: Date.now() - 3600000 },
      report: { ok: 1, failed: 0, credit: 0, energy: 0, claimed: 0 },
    },
    claimableSeen: 0,
    earningsToday: {
      u1: { credit: 20, energy: 5, claimed: 0, checkinCredit: 20, bonusCredit: 0, travelCredit: 0 },
    },
    runInProgress: false,
  },
  ignored: [{ id: 'u9', label: '已移出号' }],
  creditReserves: { u2: 100 },
};

for (const [tabId, label, mustHave] of [
  [
    'accounts',
    '账号',
    [
      // 左列 WorkBuddy
      'WorkBuddy',
      '测试账号',
      '冷却账号',
      '冷却中',
      '今日已签',
      '连签 9 天',
      '3,080',
      '令牌到期',
      // 左列的单账号切换控件（与右列 Trae / 第三列 Qoder 同款）
      '当前使用',
      '备用',
      '设为当前',
      '取消固定',
      // 右列 Trae
      'Trae',
      'trae-user@example.com',
      '当前使用',
      '备用',
      '通用余额',
      '工作余额',
      // 第三列 Qoder（并入账号页）
      'Qoder 号池',
      'qoder-user@example.com',
      'qoder-backup@example.com',
      '添加账号',
      '保留额度',
    ],
  ],
  ['wb-credits', '积分', ['当前总积分', '采样记录', '历史跨度', '月包', '80 / 100', '2 个账号']],
  ['wb-history', '使用记录', ['每日净变化', '账号明细', '2026-10-08', '2026-10-09', '+80', '-100', '测试账号']],
  [
    'qoder',
    'Qoder 号池',
    [
      'Qoder 号池',
      '添加账号',
      '刷新',
      'qoder-user@example.com',
      'qoder-backup@example.com',
      // 单账号语义：被固定的那张显示「当前使用 + 取消固定」，
      // 其余显示「备用 + 设为当前」。
      '当前使用',
      '备用',
      '取消固定',
      '设为当前',
      '冷却中',
      '限流 3 次',
      '保留额度',
      '移出池子',
      '优先模式',
      // 积分额度：**自动刷新**，所以页面上不该再有「刷新积分」按钮，
      // 而应说明节奏；余额「未读到」显示为「读取中…」而非叫用户去点按钮。
      '积分合计',
      '300',
      '每 30 秒自动刷新',
      '读取中…',
    ],
  ],
]) {
  let err = null;
  let text = '';
  try {
    // hook 9 是 traeStatus —— 账号页两列都要有数据才能覆盖到两边；
    // hook 15 是 qoderStatus —— Qoder 页的账号列表来自它
    // （0-7 WorkBuddy · 8-12 Trae · 13 login · 14 traeLogin · 15 qoderStatus）。
    text = renderPage({ ...withData, 9: traeFixture, 15: qoderFixture, 0: tabId });
  } catch (e) {
    err = e;
  }
  ok(`${label} tab 渲染不抛异常`, err === null, err?.message);
  const missing = mustHave.filter((s) => !text.includes(s));
  ok(`${label} tab 渲染出关键内容`, missing.length === 0, missing.length > 0 ? `缺少: ${missing.join(', ')}` : '');
}

/**
 * —— 2a-quater) 「账号」页也必须驱动 Qoder（懒加载 + 自动刷新）——
 *
 * Qoder 面板同时挂在两个 tab 下：「账号」页第三列与独立「Qoder 号池」页。
 * 懒加载与自动刷新原先只判 `tab === 'qoder'`，并入后**从「账号」页进来会
 * 整列空白、余额永远停在「读取中…」** —— 而渲染断言完全看不出来（面板照样
 * 渲染，只是没数据、没定时器）。所以这一组必须真的跑 effect 并驱动定时器。
 *
 * 这是「同一个面板挂两处」最典型的坑：**渲染对了不等于活着**。
 */
{
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const prevDocument = globalThis.document;

  const timers = [];
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => {
    const t = { fn, ms, id: nextId++, cleared: false };
    timers.push(t);
    return t.id;
  };
  globalThis.clearInterval = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t !== undefined) t.cleared = true;
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
  };

  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/qoder/credits/refresh')) {
      return {
        ok: true,
        json: async () => ({ ok: true, refreshed: 1, failed: 0, accounts: [{ id: 'q1', ok: true, total: 300 }] }),
      };
    }
    if (String(url).includes('/qoder/pool')) return { ok: true, json: async () => qoderFixture };
    return { ok: true, json: async () => statusFixture };
  };

  // hook 0 = tab，设为「账号」页
  const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' }, true);
  const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
  let err = null;
  try {
    Page({});
  } catch (e) {
    err = e;
  }
  await new Promise((r) => setTimeout(r, 0));

  ok('从「账号」页进入不抛异常', err === null, err?.message);
  ok(
    '从「账号」页进入会拉 Qoder 号池',
    urls.some((u) => u.includes('/qoder/pool')),
    `打过的 URL: ${urls.join(', ')}`,
  );
  ok(
    '从「账号」页进入会刷 Qoder 积分',
    urls.some((u) => u.includes('/qoder/credits/refresh')),
    `打过的 URL: ${urls.join(', ')}`,
  );
  const timer = timers.find((t) => t.ms === 30000);
  ok('从「账号」页进入会注册 30 秒自动刷新定时器', timer !== undefined, `timers=${timers.map((t) => t.ms).join(',')}`);

  let cleanupErr = null;
  try {
    react.unmount();
  } catch (e) {
    cleanupErr = e;
  }
  ok('离开「账号」页时不抛', cleanupErr === null, cleanupErr?.message);
  ok('离开「账号」页时清掉定时器', timer !== undefined && timer.cleared === true, `cleared=${timer?.cleared}`);

  globalThis.fetch = prevFetch;
  globalThis.setInterval = prevSetInterval;
  globalThis.clearInterval = prevClearInterval;
  globalThis.document = prevDocument;
}

/**
 * —— 2a-bis) Qoder 积分是「自动刷新」，不是手动按钮 ——
 *
 * 需求原话是「积分刷新规则同上游不需要手动刷新」。这条契约有两个方向，
 * 都必须钉住，因为**做反了是静默的**：
 *
 *   - 少了自动刷新 → 用户得记得点按钮，而余额是「保留额度」判据的输入，
 *     拿着过期余额做决策不会报任何错；
 *   - 多了手动按钮 → 等于把规则退回手动，且暗示「不点就不会更新」。
 *
 * 所以既断言节奏文案在，也断言按钮文案**不在**。
 */
{
  const text = renderPage({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' });
  ok('Qoder 页说明自动刷新节奏', text.includes('每 30 秒自动刷新'), '');
  ok(
    'Qoder 页不再有「刷新积分」手动按钮',
    !text.includes('刷新积分'),
    '手动按钮会把「规则同上游」退回手动',
  );
  // 「刷新」这个按钮是重读号池快照（本地），不是刷上游积分，必须保留。
  ok('重读号池快照的「刷新」按钮仍在', text.includes('刷新'), '');
  // 余额未读到时是「读取中…」——自动刷新会自己回来，不该叫用户操作。
  ok(
    '未读到的余额显示为「读取中…」',
    text.includes('读取中…'),
    '叫用户点按钮等于承认不会自动刷新',
  );
}

/**
 * —— 2a-ter) 积分合计不把「未知」当 0 ——
 *
 * 这是本项目反复出现的一类错误：把「查不到」显示成 0，用户会以为账号空了
 * 而删掉好账号。fixture 里 q1 有余额 300、q2 余额未知，所以合计必须是 300
 * 且标明「1/2 个已知」，**绝不能**显示 0 或 300 却谎称「2 个账号」。
 */
{
  const text = renderPage({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' });
  ok('合计只累加已知账号（300，非 0）', text.includes('300'), '');
  ok('合计标明已知比例（1/2）', text.includes('1/2 个已知'), '');
  ok('合计不谎称全部已知', !text.includes('2 个账号 ·'), '');
}

/**
 * —— 2b) 三列布局的结构契约 ——
 *
 * 「并排三列」靠的是外层 `wbc-cols` 网格 + 三个 `wbc-col` 子列。
 * 光看文本断言不出布局：三列若塌成上下三个独立块，文本一模一样。
 * 所以这里直接检查元素树的结构与 class。
 *
 * Qoder 并入「账号」页是第三列（此前只有 WorkBuddy / Trae 两列）。
 */
{
  const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' });
  const jsxRuntime = makeJsxRuntime();
  const Page = createConsoleSection({ react, jsxRuntime, embedded: makeEmbedded() });
  const tree = Page({});

  /** 在元素树里按 className 找节点 */
  function findByClass(node, needle, depth = 0, hits = []) {
    if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return hits;
    if (Array.isArray(node)) {
      for (const c of node) findByClass(c, needle, depth, hits);
      return hits;
    }
    const { type, props } = node;
    if (typeof props?.className === 'string' && props.className.includes(needle)) hits.push(node);
    if (typeof type === 'function') findByClass(type(props ?? {}), needle, depth + 1, hits);
    else if (typeof type === 'string') findByClass(props?.children, needle, depth + 1, hits);
    return hits;
  }

  const colsWrappers = findByClass(tree, 'wbc-cols');
  ok('账号页有 wbc-cols 多列容器', colsWrappers.length === 1, `找到 ${colsWrappers.length} 个`);
  const cols = findByClass(tree, 'wbc-col ');
  const colNodes = findByClass(tree, 'wbc-col');
  // 'wbc-col' 也会命中 'wbc-cols'，用边界匹配排除
  const realCols = colNodes.filter((n) => /(^|\s)wbc-col(\s|$)/.test(String(n.props.className)));
  ok('多列容器内恰好有三个 wbc-col 子列', realCols.length === 3, `找到 ${realCols.length} 个`);
  void cols;

  // 三列的标题分别是 WorkBuddy / Trae / Qoder，顺序不能反。
  // 注意：`wbc-col-title` 也被各列**内部的子区块**复用（如 Qoder 列的
  // 「账号使用方式」），所以不能遍历整棵树收集标题 —— 那样会把子区块标题
  // 也算进来。这里直接取三列各自的列头（`wbc-col-head` 下的第一个标题）。
  const titles = realCols.map((col) => {
    const head = findByClass(col, 'wbc-col-head')[0];
    const titleNode = head === undefined ? undefined : findByClass(head, 'wbc-col-title')[0];
    const out = [];
    collectText2(titleNode?.props?.children, out);
    return out.join('');
  });
  function collectText2(node, out) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { for (const c of node) collectText2(c, out); return; }
    if (typeof node === 'object') collectText2(node.props?.children, out);
  }
  ok(
    '三列依次是 WorkBuddy、Trae、Qoder（顺序正确）',
    titles.length === 3 &&
      titles[0] === 'WorkBuddy' &&
      titles[1] === 'Trae' &&
      titles[2] === 'Qoder 号池',
    `实际: [${titles.join(', ')}]`,
  );

  // 三侧的筛选按钮应各在自己的列头里，不会串到一起
  for (const [col, mustHave] of [
    [0, ['国内版', '国际版', '重新检测']],
    [1, ['Trae 国内版', 'Trae 国际版', '重新检测', '签到']],
    // Qoder 列没有区域划分（只有 CN），主操作是「添加账号」而非「重新检测」
    [2, ['添加账号', '重置冷却']],
  ]) {
    const colNode = realCols[col];
    const textsInCol = [];
    collectText(colNode, textsInCol);
    const joined = textsInCol.join(' | ');
    const missing = mustHave.filter((s) => !joined.includes(s));
    ok(
      `第 ${col + 1} 列包含自己的控件`,
      missing.length === 0,
      missing.length > 0 ? `缺少: ${missing.join(', ')}` : '',
    );
  }

  /**
   * —— 2c) 两列必须是**同一套模块样式** ——
   *
   * 这是「把两个模块做成一样的样式」这条需求的**唯一可靠断言**。
   *
   * 为什么不能只看文本：两列若各写各的（比如一侧没有统计行、另一侧卡片字段
   * 与按钮位置不同），文本照样能全部对上，肉眼并排一看却明显是两套东西。
   * 所以这里比对**元素骨架**：把每列展开成「标签 + className」序列，
   * 断言两侧用到的 class 集合一致、且统计行/账号卡的骨架逐项对应。
   */
  const skeletonOf = (node, out = [], depth = 0) => {
    if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const c of node) skeletonOf(c, out, depth);
      return out;
    }
    const { type, props } = node;
    if (typeof type === 'function') {
      skeletonOf(type(props ?? {}), out, depth + 1);
      return out;
    }
    if (typeof type === 'string') {
      const cls = typeof props?.className === 'string' ? props.className.trim() : '';
      out.push(cls === '' ? type : `${type}.${cls}`);
      skeletonOf(props?.children, out, depth + 1);
      return out;
    }
    skeletonOf(props?.children, out, depth + 1);
    return out;
  };

  /** 把骨架归一成「模块级 class 的集合」，忽略具体文本与条目数 */
  const MODULE_CLASSES = [
    'wbc-col-head',
    'wbc-col-title',
    'wbc-sums',
    'wbc-sum',
    'wbc-sum-label',
    'wbc-sum-value',
    'wbc-sum-sub',
    'wbc-cards',
    'wbc-card',
    'wbc-card-head',
    'wbc-name',
    'wbc-tag',
    'wbc-kv',
    'wbc-k',
    'wbc-v',
    'wbc-btn',
  ];
  const modulesOf = (colNode) => {
    const sk = skeletonOf(colNode);
    const present = new Set();
    for (const item of sk) {
      for (const cls of MODULE_CLASSES) {
        // 逐 token 匹配，避免 wbc-card 命中 wbc-cards
        const tokens = item.split('.').slice(1).join(' ').split(/\s+/);
        if (tokens.includes(cls)) present.add(cls);
      }
    }
    return { present, skeleton: sk };
  };

  const wbMods = modulesOf(realCols[0]);
  const traeMods = modulesOf(realCols[1]);

  const missingInTrae = [...wbMods.present].filter((c) => !traeMods.present.has(c));
  const missingInWb = [...traeMods.present].filter((c) => !wbMods.present.has(c));
  ok(
    '两列使用同一套模块 class（左列有的右列也有）',
    missingInTrae.length === 0,
    missingInTrae.length > 0 ? `右列缺少: ${missingInTrae.join(', ')}` : '',
  );
  ok(
    '两列使用同一套模块 class（右列有的左列也有）',
    missingInWb.length === 0,
    missingInWb.length > 0 ? `左列缺少: ${missingInWb.join(', ')}` : '',
  );

  /**
   * 两列的**列头骨架必须逐项一致**：标题 + 区域按钮 + spacer + 操作按钮。
   * 这是先前那版最明显的差异 —— 一侧列头只有一个按钮、另一侧有两个。
   */
  const headSkeleton = (colNode) => {
    const heads = [];
    (function walk(node, depth = 0) {
      if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const c of node) walk(c, depth); return; }
      const { type, props } = node;
      if (typeof props?.className === 'string' && /(^|\s)wbc-col-head(\s|$)/.test(props.className)) {
        heads.push(props.children);
        return;
      }
      if (typeof type === 'function') walk(type(props ?? {}), depth + 1);
      else if (typeof type === 'string') walk(props?.children, depth + 1);
    })(colNode);
    return heads[0];
  };

  const headShapeOf = (children) => {
    const flat = Array.isArray(children) ? children.flat(Infinity).filter(Boolean) : [children];
    return flat
      .filter((c) => c !== null && c !== undefined)
      .map((c) => {
        const cls = typeof c?.props?.className === 'string' ? c.props.className.trim() : '';
        const tag = typeof c?.type === 'string' ? c.type : String(c?.type?.name ?? '?');
        // 区域按钮与操作按钮都算 wbc-btn，归类即可
        if (cls.includes('wbc-btn')) return 'button.wbc-btn';
        if (cls.includes('wbc-spacer')) return 'spacer';
        if (cls.includes('wbc-col-title')) return 'title';
        return cls === '' ? tag : `${tag}.${cls}`;
      });
  };

  const wbHead = headShapeOf(headSkeleton(realCols[0]));
  const traeHead = headShapeOf(headSkeleton(realCols[1]));

  // 归一：把连续的多个区域按钮折叠成一个占位，只比较「结构槽位」
  const normalizeHead = (arr) => {
    const out = [];
    for (const item of arr) {
      if (item === 'button.wbc-btn' && out[out.length - 1] === 'button.wbc-btn') continue;
      out.push(item);
    }
    return out;
  };
  ok(
    '两列列头骨架一致（标题 + 区域切换 + spacer + 操作按钮）',
    JSON.stringify(normalizeHead(wbHead)) === JSON.stringify(normalizeHead(traeHead)),
    `左: [${normalizeHead(wbHead).join(', ')}] 右: [${normalizeHead(traeHead).join(', ')}]`,
  );
}

/**
 * —— 2d) WorkBuddy 侧要有「浏览器登录添加账号」入口 ——
 *
 * 这是新加的能力。要守住三件事：
 *   1. 入口存在（左列列头有「添加账号」按钮）
 *   2. 登录中要有提示（否则用户点了以为卡住）
 *   3. 失败要有提示（否则静默失败最难排查）
 *
 * 反向验证过：把 onAddAccount 的传参去掉 → 按钮消失，断言失败。
 */
{
  // 常态：应有「添加账号」按钮（hook 13 是 login 状态，留空即常态）
  const text = renderPage({ ...withData, 9: traeFixture, 0: 'accounts' });
  ok('WorkBuddy 列有「添加账号」入口', text.includes('添加账号'), text.slice(0, 160));
  ok('常态下没有登录进行中的提示', !text.includes('已在浏览器打开登录页'));

  // 登录中：按钮转「登录中…」并提示去浏览器
  const pending = renderPage({
    ...withData,
    9: traeFixture,
    0: 'accounts',
    13: { pending: true, authUrl: 'https://www.workbuddy.cn/login?x=1', opened: true },
  });
  ok('登录中提示去浏览器完成', pending.includes('已在浏览器打开登录页'));
  ok('登录中按钮显示「登录中…」', pending.includes('登录中…'));

  // 浏览器没自动打开时，要给出可手动打开的链接
  const notOpened = renderPage({
    ...withData,
    9: traeFixture,
    0: 'accounts',
    13: { pending: true, authUrl: 'https://www.workbuddy.cn/login?x=1', opened: false },
  });
  ok('浏览器没打开时给出手动链接', notOpened.includes('https://www.workbuddy.cn/login?x=1'));

  // 失败：要显示原因
  const failed = renderPage({
    ...withData,
    9: traeFixture,
    0: 'accounts',
    13: { error: '登录服务没有返回 authUrl' },
  });
  ok('登录失败时显示原因', failed.includes('添加账号失败') && failed.includes('authUrl'));
}

/**
 * —— 2e) Trae 侧的「浏览器登录」入口 ——
 *
 * 与 WorkBuddy 同款三件事：入口存在、登录中提示、失败提示。
 * 另外多一条 Trae 特有的：登录中要给出**手动粘贴兜底**
 * （官方授权页偶尔停在原地不跳回环地址，AgentHub/参考项目都记录过）。
 */
{
  const traeLogin = (extra) => ({
    ...withData,
    9: traeFixture,
    0: 'accounts',
    14: extra,
  });

  const text = renderPage(traeLogin(null));
  ok('Trae 列有「添加账号」入口', text.includes('添加账号'), text.slice(0, 160));

  const pending = renderPage(traeLogin({ pending: true, authUrl: 'https://login.trae.cn/authorization?x=1', opened: true }));
  ok('Trae 登录中提示去官方授权页', pending.includes('已在浏览器打开官方授权页'));
  ok('Trae 登录为自动回调，不再有手动粘贴兜底', !pending.includes('把地址栏整段复制到下面') && !pending.includes('提交回调'));

  const failed = renderPage(traeLogin({ error: '登录主机不可达' }));
  ok('Trae 登录失败时显示原因', failed.includes('登录主机不可达'), failed.slice(0, 160));
}

/**
 * —— 2e-bis) 账号页两列也要有「账号使用方式」——
 *
 * 需求原话是「workbuddy 和 trae 的账号页面也做」。做这件事有两个**静默**
 * 的失败方向，都必须钉住：
 *
 *   1. **读错来源**：WorkBuddy 的策略是顶层 `distribution`（池级单键），
 *      Trae 的是 `pool.distribution`（按区域）。两边若读同一处，界面照样
 *      渲染，只是显示的是别人的策略 —— 夹具刻意给了两个**不同**的值
 *      （round-robin / balanced），读错来源就会暴露。
 *   2. **控件画出来但写不进去**：所以下面既断言按钮存在、也抓 onClick
 *      真点一次，断言设置作用域收到了正确的键与值。
 *
 * 另外「作用范围」文案也要断言：左列列头有国内版/国际版切换，但策略是
 * 池级的；右列策略则确实按区域存。两者说反了用户会做出错误预期。
 */
{
  const accountsPage = (extra) =>
    renderPage({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts', ...(extra ?? {}) });

  const text = accountsPage();
  // 两列各一个，加上 Qoder 列那个 —— 共三个
  const occurrences = text.split('账号使用方式').length - 1;
  ok('账号页三列都有「账号使用方式」', occurrences === 3, `实际 ${occurrences} 处`);
  for (const label of ['优先模式', '轮换模式', '均衡模式']) {
    ok(`账号页两列都有「${label}」`, text.includes(label), '');
  }

  // WorkBuddy 读顶层 distribution=round-robin → 「轮换模式」应是高亮那个
  ok('左列作用范围说明：整个池共用（不随区域）', text.includes('整个池共用一套策略'), '');
  // Trae 读 pool.distribution=balanced → 「均衡模式」
  ok('右列作用范围说明：只作用于当前区域', text.includes('只作用于当前区域'), '');

  /**
   * 高亮项必须**按列**对上各自的来源。
   *
   * 这是「读错来源」的唯一可靠判据：两列读同一处时界面照样渲染、文案照样
   * 齐全，只有高亮的那个按钮会露馅。夹具刻意给了两个不同的值
   * （WorkBuddy round-robin / Trae balanced），所以这里能分辨。
   */
  {
    const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' });
    const tree = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: makeEmbedded(),
    })({});

    /** 取三列各自的元素节点 */
    const cols = [];
    (function walk(n, d = 0) {
      if (d > 40 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c, d);
        return;
      }
      const { type, props } = n;
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), d + 1);
        } catch {
          /* 忽略 */
        }
        return;
      }
      if (typeof props?.className === 'string' && /(^|\s)wbc-col(\s|$)/.test(props.className)) {
        cols.push(n);
        return;
      }
      if (typeof type === 'string') walk(props?.children, d + 1);
    })(tree);

    /**
     * 找该列里「账号使用方式」那一条 wbc-bar，再取其中高亮的按钮文字。
     *
     * 不能直接取列里第一个 `wbc-btn-primary`：列头的区域按钮（「国内版」
     * 之类）也是 primary，会先命中。必须定位到分配策略那一条 bar。
     */
    const activeLabelOf = (node) => {
      let label = null;
      (function walk(n, d = 0) {
        if (label !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略 */
          }
          return;
        }
        const cls = typeof props?.className === 'string' ? props.className : '';
        if (/(^|\s)wbc-bar(\s|$)/.test(cls)) {
          // 这条 bar 是不是「账号使用方式」那条？
          const texts = [];
          collectText(props?.children, texts);
          if (texts.join('').includes('账号使用方式')) {
            (function findPrimary(bar, bd = 0) {
              if (label !== null || bd > 20 || bar === null || typeof bar !== 'object') return;
              if (Array.isArray(bar)) {
                for (const c of bar) findPrimary(c, bd);
                return;
              }
              const bp = bar.props;
              const bcls = typeof bp?.className === 'string' ? bp.className : '';
              if (bar.type === 'button' && bcls.includes('wbc-btn-primary')) {
                label = bp.children;
                return;
              }
              findPrimary(bp?.children, bd + 1);
            })(props?.children);
          }
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return label;
    };

    ok('三列节点收集完整', cols.length === 3, `找到 ${cols.length}`);
    ok(
      '左列高亮的是它自己读到的策略（轮换模式）',
      activeLabelOf(cols[0]) === '轮换模式',
      `实际高亮: ${activeLabelOf(cols[0])}`,
    );
    ok(
      '右列高亮的是它自己读到的策略（均衡模式）',
      activeLabelOf(cols[1]) === '均衡模式',
      `实际高亮: ${activeLabelOf(cols[1])}`,
    );
    ok(
      'Qoder 列高亮的是自己的策略（优先模式）',
      activeLabelOf(cols[2]) === '优先模式',
      `实际高亮: ${activeLabelOf(cols[2])}`,
    );
  }
}

/**
 * —— 2e-ter) 账号页两列的分配策略**真的写得进去** ——
 *
 * 只断言渲染不够：控件画出来了但 onClick 写错键名/写错地方，测试照样全绿。
 * 这里抓出按钮的 onClick 真点一次：
 *
 *   - WorkBuddy：`wbSettings` 作用域收到 ('distribution','priority')
 *   - Trae：`traeSettings` 作用域收到 ('regions', …)，且目标区域槽里
 *     `distribution` 已改、**其它区域槽原样保留**
 *
 * 写完还要刷新（读回新值），否则界面会停在旧策略上。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  let statusCalls = 0;
  let traeCalls = 0;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      statusCalls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statusFixture) });
    }
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      traeCalls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(traeFixture) });
    }
    if (u.includes('/qoder/pool')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(qoderFixture) });
    }
    if (u.includes('/qoder/credits/refresh')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, refreshed: 1, failed: 0, accounts: [] }) });
    }
    return new Promise(() => {});
  };
  try {
    const wbWrites = [];
    const traeWrites = [];
    const wbScope = makeWbScope({});
    wbScope.set = (field, value) => {
      wbWrites.push([field, value]);
      return Promise.resolve(true);
    };
    /**
     * Trae 的写入必须**真的落到快照里**。
     *
     * `writeTraeField` 写完会读回确认落地（宿主 resolve 了不等于写进去了），
     * 一个只记录、不改快照的桩会被这条检查正确地判为失败 —— 先前这里正是
     * 这样，表现为「写入后没有刷新状态」。所以桩要维护一份可变的文档。
     */
    let traeDoc = {
      // 两个区域槽：断言写入**只动 cn**、ai 原样带过
      regions: { cn: { enabled: true, distribution: 'balanced' }, ai: { enabled: true, distribution: 'priority' } },
    };
    const traeScope = makeTraeScope(traeDoc);
    traeScope.getSnapshot = () => ({ status: 'ready', value: traeDoc, writable: true });
    traeScope.set = (field, value) => {
      traeWrites.push([field, value]);
      traeDoc = { ...traeDoc, [field]: value };
      return Promise.resolve(true);
    };

    const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: { wbSettings: makeHandle(wbScope), traeSettings: makeHandle(traeScope) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    /** 在元素树里按文字找按钮，取它所在**列**的 className（区分左右两列） */
    const findButtons = (label) => {
      const hits = [];
      (function walk(n, d = 0) {
        if (d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略渲染失败的子树 */
          }
          return;
        }
        if (type === 'button' && props?.children === label) hits.push(props.onClick);
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(tree);
      return hits;
    };

    // 「优先模式」在三列里都有（Qoder 列也有一个），账号页上共 3 个。
    // 前两个依次属于 WorkBuddy 列与 Trae 列（列顺序固定）。
    const priorityButtons = findButtons('优先模式');
    ok('账号页找得到多个「优先模式」按钮（三列各一）', priorityButtons.length === 3, `实际 ${priorityButtons.length}`);

    const beforeStatus = statusCalls;
    await priorityButtons[0]();
    ok(
      '左列点「优先模式」把 distribution 写进 wbSettings',
      wbWrites.some(([f, v]) => f === 'distribution' && v === 'priority'),
      JSON.stringify(wbWrites),
    );
    ok('左列写入后刷新了池状态', statusCalls > beforeStatus, `${beforeStatus} → ${statusCalls}`);

    const beforeTrae = traeCalls;
    await priorityButtons[1]();
    const regionWrite = traeWrites.find(([f]) => f === 'regions');
    ok('右列点「优先模式」把 regions 写进 traeSettings', regionWrite !== undefined, JSON.stringify(traeWrites));
    const nextRegions = regionWrite?.[1];
    ok(
      '右列写入落在当前区域槽（cn.distribution=priority）',
      nextRegions?.cn?.distribution === 'priority',
      JSON.stringify(nextRegions),
    );
    ok(
      '右列写入不动其它区域槽（ai 原样保留）',
      nextRegions?.ai?.distribution === 'priority' && nextRegions?.ai?.enabled === true,
      JSON.stringify(nextRegions),
    );
    ok('右列写入后刷新了 Trae 状态', traeCalls > beforeTrae, `${beforeTrae} → ${traeCalls}`);
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2e-quater) 作用域不可写时，两列给出诊断而不是假控件 ——
 *
 * 「保存了又弹回去」那个故障的可见面：不可写时必须说明原因，而不是画一个
 * 按下去什么都不发生的按钮。写入被宿主拒绝（`set()` 返回 false）也要报出来。
 */
await (async () => {
  const readOnly = {
    getSnapshot: () => ({ status: 'ready', value: { regions: { cn: { enabled: true } } }, writable: false }),
    subscribe: () => () => {},
    set: () => Promise.resolve(false),
  };
  const text = renderPage(
    { ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' },
    {},
    { wbSettings: makeHandle(readOnly), traeSettings: makeHandle(readOnly) },
  );
  ok('两列作用域不可写时给出诊断', text.includes('设置作用域不可写，无法保存'), text.slice(0, 200));

  // 可写但宿主拒绝：必须显示拒绝原因，不能假装成功
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statusFixture) });
    }
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(traeFixture) });
    }
    if (u.includes('/qoder/pool')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(qoderFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const rejecting = makeScope({}, true);
    rejecting.set = () => Promise.resolve(false);
    const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: { wbSettings: makeHandle(rejecting), traeSettings: makeHandle(rejecting) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    let tree = Page({});
    const findButton = (label, node) => {
      let handler = null;
      (function walk(n, d = 0) {
        if (handler !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略 */
          }
          return;
        }
        if (type === 'button' && props?.children === label) handler = props.onClick;
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return handler;
    };
    await findButton('轮换模式', tree)();
    react.reset();
    tree = Page({});
    const after = [];
    collectText(tree, after);
    ok(
      '宿主拒绝写入时显示失败原因（不假装成功）',
      after.join(' | ').includes('分配策略保存失败'),
      after.join(' | ').slice(0, 240),
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2e-quinquies) 宿主「假装写入成功」时右列必须报错 ——
 *
 * 这是本项目反复踩到的那个故障的精确形状：`set()` resolve 了 `true`，
 * 但文档**没变**（被拒的写入会重载宿主状态后正常返回）。上游客户端曾因此
 * 「看起来保存了，值又悄悄弹回去」。
 *
 * 所以 `writeTraeField` 写完必须**读回确认**。一个只 `return true`、
 * 不改快照的桩就是这种宿主的替身 —— 先前这条检查没有任何测试覆盖，
 * 把 `landed` 改成恒真整个套件照样全绿（变异测试实测如此）。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statusFixture) });
    }
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(traeFixture) });
    }
    if (u.includes('/qoder/pool')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(qoderFixture) });
    }
    return new Promise(() => {});
  };
  try {
    // 宿主：resolve true，但快照永远停在原值
    const stuckDoc = { regions: { cn: { enabled: true, distribution: 'priority' } } };
    const stuck = makeTraeScope(stuckDoc);
    stuck.getSnapshot = () => ({ status: 'ready', value: stuckDoc, writable: true });
    stuck.set = () => Promise.resolve(true);

    const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'accounts' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: { wbSettings: makeHandle(makeWbScope({})), traeSettings: makeHandle(stuck) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    let tree = Page({});

    /** 取右列（Trae 列）「均衡模式」按钮 —— 它当前是 priority，点了要变 balanced */
    const findInCol = (colIndex, label, node) => {
      const cols = [];
      (function walk(n, d = 0) {
        if (d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略 */
          }
          return;
        }
        if (typeof props?.className === 'string' && /(^|\s)wbc-col(\s|$)/.test(props.className)) {
          cols.push(n);
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      let handler = null;
      (function walk(n, d = 0) {
        if (handler !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略 */
          }
          return;
        }
        if (type === 'button' && props?.children === label) handler = props.onClick;
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(cols[colIndex]);
      return handler;
    };

    await findInCol(1, '均衡模式', tree)();
    react.reset();
    tree = Page({});
    const after = [];
    collectText(tree, after);
    const joined = after.join(' | ');
    ok(
      '宿主假装写入成功时右列报错（读回确认生效）',
      joined.includes('分配策略保存失败') && joined.includes('未能写入'),
      joined.slice(0, 260),
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2f) Trae 配置页（本包自写）必须真的渲染出内容 ——
 *
 * 「不崩」这类断言对空输出也成立，所以这里补真实内容断言：
 * 供应商开关、账号绑定、模型勾选，以及**号池管理**（分配策略 / 冷却 /
 * 停用 / 保留积分）。号池那一块是本次按 XD Pool 对齐新增的，必须有断言守住，
 * 否则它渲染不出来也不会有任何测试失败。
 */
await (async () => {
  const traeUsage = {
    status: 'signed-in',
    accountName: 'trae-user@example.com',
    accounts: [
      { id: 't1', accountName: 'trae-user@example.com', selected: true, edition: 'cn' },
      { id: 't2', accountName: 'trae-backup@example.com', selected: false, edition: 'solo' },
    ],
    models: [
      { id: 'm1', name: 'DeepSeek-V4-Flash', contextWindow: 2e5, creditMultiplier: 1 },
      { id: 'm2', name: 'GLM-5.2', contextWindow: 2e5 },
    ],
    enabledModelIds: ['m1'],
    credits: { generalAvailable: 1200, workAvailable: 340 },
    checkin: { checkedIn: false, credits: 50 },
    // 号池段：两账号，其中一个冷却中
    pool: {
      distribution: 'round-robin',
      cooling: 1,
      lastServedId: 't1',
      creditReserves: { t2: 100 },
      accounts: [
        { id: 't1', label: 'trae-user@example.com', cooling: false, rateLimitHits: 0, disabled: false, creditReserve: 0 },
        { id: 't2', label: 'trae-backup@example.com', cooling: true, rateLimitHits: 2, disabled: false, creditReserve: 100, cooldownUntilMs: Date.now() + 60000 },
      ],
    },
  };
  const scope = makeHandle(
    makeTraeScope({ regions: { cn: { enabled: true, enabledModelIds: ['m1'], disabledAccountIds: [], creditReserves: { t2: 100 } } } }),
  );
  const embedded = { wbSettings: makeHandle(null), traeSettings: scope };
  /**
   * 用 fetch 桩喂数据，而不是预置 useState 下标。
   *
   * 预置下标要数清 TraeConfigTab 内部每个 hook 的绝对位置，而它在主组件
   * 之后渲染、下标随主组件改动漂移 —— 早先按「usage 是第 1 个」写死，
   * 主组件多加一个 state 就整组失效。这里让 `/usage` 直接返回 fixture，
   * 页面自己 setState，与真实运行路径一致，也不依赖 hook 顺序。
   */
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(traeUsage) });
    }
    return new Promise(() => {});
  };
  /**
   * 渲染两遍：第一遍触发 useEffect 里的 fetch，等微任务跑完（Promise 落地、
   * setUsage 生效）后再渲染一次，此时才看得到加载完成的内容。
   *
   * 必须用**同一个 react 实例**，否则第二次渲染是一块全新的 state，
   * 拿不到第一遍 fetch 回来的数据。
   */
  let text = '';
  let err = null;
  try {
    const react = makeReact({ 0: 'trae-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({ react, jsxRuntime, embedded });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    text = collectAll(Page({}));
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = prevFetch;
  }
  ok('Trae 配置页渲染不抛异常', err === null, err?.message);
  for (const must of [
    'Trae 国内版',      // 区域切换
    'Trae 国际版',
    '向 DSH 提供该供应商', // 供应商开关
    'trae-user@example.com', // 当前账号
    'DeepSeek-V4-Flash',     // 模型列表
    'GLM-5.2',
    '从 Trae 刷新',          // 模型操作
    '一键启用所有模型',
    '一键测试启用模型',
    '账号使用方式',          // 号池区
    '优先模式',
    '轮换模式',
    '均衡模式',
    '清除所有冷却',
    'trae-backup@example.com', // 号池账号卡
    '冷却中',
    '触发限流',
  ]) {
    ok(`Trae 配置页渲染出「${must}」`, text.includes(must), text.slice(0, 200));
  }
  ok('号池显示冷却账号数', text.includes('触发限流'), text.slice(0, 300));
})();

/**
 * —— 2g) Trae 配置页：作用域不可写时给出诊断，而不是给出按不动的假控件 ——
 *
 * 这是「保存了又弹回去」那个故障的可见面：writable=false 时必须说明原因。
 */
{
  const embedded = {
    wbSettings: makeHandle(null),
    traeSettings: makeHandle({
      getSnapshot: () => ({ status: 'ready', value: {}, writable: false }),
      subscribe: () => () => {},
      set: () => Promise.resolve(false),
    }),
  };
  const text = renderPage({ 0: 'trae-config' }, {}, embedded);
  ok(
    '作用域不可写时显示诊断说明',
    text.includes('设置作用域不可写'),
    text.slice(0, 200),
  );
}

/**
 * —— 2g-2) XD Pool 配置页（本包自写）必须真的渲染出内容 ——
 *
 * 与 2f 同一套路：用 fetch 桩喂 `/status`，让 WotrPage 自己 setState，
 * 再渲染第二遍看内容。断言覆盖区域切换、分配策略、账号启停 / 保留积分 /
 * 移出池子、模型勾选与上下文预算、以及积分自动化（CN only）。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  let text = '';
  let err = null;
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({ react, jsxRuntime, embedded: makeEmbedded() });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    text = collectAll(Page({}));
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = prevFetch;
  }
  ok('XD Pool 配置页渲染不抛异常', err === null, err?.message);
  for (const must of [
    'WorkBuddy 池',          // 列头
    '国内版',                // 区域切换
    '国际版',
    '账号使用方式',          // 分配策略区
    '优先模式',
    '轮换模式',
    '均衡模式',
    '清除所有冷却',
    '池内主号',              // 账号卡
    '冷却备用号',
    '冷却中',
    '触发限流',
    '参与轮换',              // 账号启停
    '保存保留',              // 保留积分
    '移出池子',
    '已移出账号池',          // ignored 区
    '已移出号',
    '恢复',
    '积分自动化',            // CN only 自动化
    '立即运行',
    'DeepSeek-V4-Flash',     // 模型目录
    'GLM-5.2',
    'Max 模式（满上下文 + 最强思考）',
    '一键启用所有模型',
    '保存',
    '已启用 1 个 · 实时目录 2 个', // 勾选计数（与 Trae 页同款文案）
    '从 WorkBuddy 刷新',     // 目录刷新（拉取即落盘）
  ]) {
    ok(`XD Pool 配置页渲染出「${must}」`, text.includes(must), text.slice(0, 200));
  }
  ok('CN 区域渲染出积分自动化区块', text.includes('积分自动化'));
})();

/**
 * —— 2g-2b) 积分自动化**只在 CN 区域**出现 ——
 *
 * 国际版没有这套接口，渲染出来就是一组按不动的死控件（用户点了没反应）。
 * 上游也是按 activeRegion 判断的，这里对齐。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  try {
    // 直接切到国际版：region 是 PoolConfigTab 内部 hook 1（tab 是 0）
    const react = makeReact({ 0: 'pool-config', 1: 'global' }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: makeEmbedded(),
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const text = collectAll(Page({}));
    ok('国际版不渲染积分自动化区块', !text.includes('积分自动化'), text.slice(0, 200));
    ok('国际版仍渲染账号使用方式', text.includes('账号使用方式'));
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-3) XD Pool 写入：点「轮换模式」要把 distribution 写进 settings ——
 *
 * 只断言渲染不够 —— 控件画出来了但 onClick 写错键名/写错地方，测试照样全绿。
 * 这里抓出按钮的 onClick 真点一次，断言 settingsScope.set 收到
 * ('distribution','round-robin')，并且之后真的刷新了状态。
 */
await (async () => {
  const writes = [];
  let statusCalls = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      statusCalls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const wbScope = makeScope({});
    wbScope.set = (field, value) => {
      writes.push([field, value]);
      return Promise.resolve(true);
    };
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: { wbSettings: makeHandle(wbScope), traeSettings: makeHandle(makeTraeScope({})) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    /** 在元素树里找文字匹配的按钮并取 onClick */
    const findButton = (label) => {
      let handler = null;
      (function walk(n, d = 0) {
        if (handler !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'string' && type === 'button' && props?.children === label) {
          handler = props.onClick;
          return;
        }
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略渲染失败的子树 */
          }
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(tree);
      return handler;
    };

    const before = statusCalls;
    const onClick = findButton('轮换模式');
    ok('找得到「轮换模式」按钮', typeof onClick === 'function');
    await onClick();
    ok(
      '点击「轮换模式」写入 distribution=round-robin',
      writes.some(([f, v]) => f === 'distribution' && v === 'round-robin'),
      JSON.stringify(writes),
    );
    ok('写入后刷新了池状态', statusCalls > before, `${before} → ${statusCalls}`);
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-4) XD Pool 模型保存：整段覆盖 + 拒绝空启用列表 ——
 *
 * 这是最容易写坏、坏了最难发现的一条路径：
 *   - 设置键必须按区域分（cn → modelSelectionCn，global → modelSelectionGlobal），
 *     写错键就静默不生效；
 *   - 值必须是**整段**五键对象，漏一个键会清掉那边的既有值；
 *   - 一个模型都没勾时必须拒绝保存（否则选择器里空空如也，用户无从恢复）。
 */
await (async () => {
  const writes = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const wbScope = makeScope({});
    wbScope.set = (field, value) => {
      writes.push([field, value]);
      return Promise.resolve(true);
    };
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: { wbSettings: makeHandle(wbScope), traeSettings: makeHandle(makeTraeScope({})) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    /** 找到指定文字按钮的 props（要检查 disabled 与 onClick） */
    const findButtonProps = (label) => {
      let hit = null;
      (function walk(n, d = 0) {
        if (hit !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'string' && type === 'button' && props?.children === label) {
          hit = props;
          return;
        }
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略渲染失败的子树 */
          }
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(tree);
      return hit;
    };

    // ① 点「一键启用所有模型」再「保存」→ 整段覆盖 modelSelectionCn
    const enableAll = findButtonProps('一键启用所有模型');
    ok('找得到「一键启用所有模型」按钮', typeof enableAll?.onClick === 'function');
    await enableAll.onClick();
    react.reset();
    const afterEnable = Page({});
    let saveBtn = null;
    (function walk(n, d = 0) {
      if (saveBtn !== null || d > 40 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c, d);
        return;
      }
      const { type, props } = n;
      if (typeof type === 'string' && type === 'button' && props?.children === '保存') {
        saveBtn = props;
        return;
      }
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), d + 1);
        } catch {
          /* 忽略 */
        }
        return;
      }
      if (typeof type === 'string') walk(props?.children, d + 1);
    })(afterEnable);
    ok('找得到「保存」按钮', typeof saveBtn?.onClick === 'function');
    await saveBtn.onClick();

    const modelWrite = writes.find(([f]) => f === 'modelSelectionCn');
    ok('模型保存写入的是区域分键 modelSelectionCn', modelWrite !== undefined, JSON.stringify(writes.map(([f]) => f)));
    if (modelWrite !== undefined) {
      const payload = modelWrite[1];
      ok(
        '模型保存是整段五键覆盖（enabledModelIds/imageModelIds/contextBudgets/reasoningEfforts/maxMode）',
        ['enabledModelIds', 'imageModelIds', 'contextBudgets', 'reasoningEfforts', 'maxMode'].every(
          (k) => k in (payload ?? {}),
        ),
        JSON.stringify(Object.keys(payload ?? {})),
      );
      ok(
        '一键启用后两个模型都在 enabledModelIds 里',
        Array.isArray(payload.enabledModelIds) && payload.enabledModelIds.length === 2,
        JSON.stringify(payload.enabledModelIds),
      );
      ok(
        'imageModelIds 跟随上游 supportsImages（fixture 里只有 m2 支持）',
        payload.imageModelIds?.join(',') === 'm2',
        JSON.stringify(payload.imageModelIds),
      );
      ok(
        'contextBudgets 整段清空（用满上游原生窗口，不再限制到 200K）',
        typeof payload.contextBudgets === 'object' &&
          payload.contextBudgets !== null &&
          Object.keys(payload.contextBudgets).length === 0,
        JSON.stringify(payload.contextBudgets),
      );
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-4b) 模型卡上不再出现「支持图片」「限制到 200K」两个勾选 ——
 *
 * 这两个开关看着能勾，实际都改不动结果：
 *   - 支持图片：上游判定是 `supportsImages || imageSet.has(id)`（**或**），
 *     目录说不支持时勾上也不生效；
 *   - 限制到 200K：服务端每次拉目录都会重写 selection，手工写入的
 *     contextBudgets 会被下一次刷新覆盖。
 *
 * 所以页面改为隐藏它们、一律跟随上游。这条断言盯的是「别再长出来」：
 * 模型启用框本身仍是 checkbox，用「每张卡只剩一个输入控件」来区分。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: {
        wbSettings: makeHandle(makeScope({})),
        traeSettings: makeHandle(makeTraeScope({})),
      },
    });
    collectText(Page({}), []);
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    const texts = [];
    collectText(tree, texts);
    const joined = texts.join(' | ');
    ok('模型区不再出现「支持图片」文案', !joined.includes('支持图片'), joined.slice(0, 300));
    ok('模型区不再出现「限制到 200K」文案', !joined.includes('限制到 200K'), joined.slice(0, 300));

    /** 收集某棵子树里所有 input 的 props */
    const inputsOf = (node) => {
      const found = [];
      (function walk(n, d = 0) {
        if (d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'string' && type === 'input') {
          found.push(props ?? {});
          return;
        }
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略渲染失败的子树 */
          }
          return;
        }
        walk(props?.children, d + 1);
      })(node);
      return found;
    };

    /** 收集所有 wbc-col 卡片（展开函数组件后再匹配） */
    const cards = [];
    (function walk(n, d = 0) {
      if (d > 40 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c, d);
        return;
      }
      const { type, props } = n;
      if (typeof type === 'string' && type === 'div' && props?.className === 'wbc-col') {
        cards.push(n);
        return;
      }
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), d + 1);
        } catch {
          /* 忽略渲染失败的子树 */
        }
        return;
      }
      walk(props?.children, d + 1);
    })(tree);

    const modelCards = cards.filter((card) => inputsOf(card).length > 0);
    ok('渲染出了两个模型卡', modelCards.length === 2, String(modelCards.length));
    ok(
      '每张模型卡只剩一个输入控件（模型启用 checkbox）',
      modelCards.every((card) => inputsOf(card).length === 1),
      JSON.stringify(modelCards.map((card) => inputsOf(card).length)),
    );
    ok(
      '模型卡里不再有 radio（「限制到 200K」已移除）',
      modelCards.every((card) => !inputsOf(card).some((p) => p.type === 'radio')),
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-5) XD Pool 模型保存：一个都不勾时拒绝写入并给出提示 ——
 */
await (async () => {
  const writes = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      // 初始 selection 一个都没启用 → 计数 0 → 保存按钮禁用
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ...poolStatusFixture,
            selection: { ...poolStatusFixture.selection, enabledModelIds: [] },
          }),
      });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const wbScope = makeScope({});
    wbScope.set = (field, value) => {
      writes.push([field, value]);
      return Promise.resolve(true);
    };
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: { wbSettings: makeHandle(wbScope), traeSettings: makeHandle(makeTraeScope({})) },
    });
    const collectAll = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    collectAll(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const text = collectAll(Page({}));
    ok('一个模型都没启用时显示「已启用 0 个 · 实时目录 2 个」', text.includes('已启用 0 个 · 实时目录 2 个'), text.slice(0, 200));
    ok('没有发生任何模型写入（保存被拒）', !writes.some(([f]) => f === 'modelSelectionCn'));
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-6) XD Pool「从 WorkBuddy 刷新」：拉取即落盘，对齐 Trae 的「从 Trae 刷新」 ——
 *
 * 点一次刷新必须同时完成三件事，不需要用户再点「保存」：
 *   1. POST 本包的 /wb/models/refresh 拉实时目录（vendor 启动种子只在启动时拉一次）；
 *   2. 整段覆盖本区域选择键（cn → modelSelectionCn）：fresh 全部启用、
 *      图片能力跟随上游 supportsImages、既有上下文/推理强度沿用；
 *   3. 丢弃草稿并刷新池状态。
 */
await (async () => {
  const writes = [];
  const refreshCalls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.includes('/plugins/dsh-wotr-console/wb/models/refresh')) {
      refreshCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            region: 'cn',
            models: [
              { id: 'm1', name: 'DeepSeek-V4-Flash', contextWindow: 2e5, maxTokens: 8192, supportsImages: false },
              { id: 'm3', name: 'Kimi-K3', contextWindow: 256000, maxTokens: 8192, supportsImages: true },
            ],
          }),
      });
    }
    if (typeof url === 'string' && url.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(poolStatusFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: 'pool-config' }, true);
    const jsxRuntime = makeJsxRuntime();
    const wbScope = makeScope({});
    wbScope.set = (field, value) => {
      writes.push([field, value]);
      return Promise.resolve(true);
    };
    const Page = createConsoleSection({
      react,
      jsxRuntime,
      embedded: { wbSettings: makeHandle(wbScope), traeSettings: makeHandle(makeTraeScope({})) },
    });
    collectText(Page({}), []);
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    const findButtonProps = (label) => {
      let hit = null;
      (function walk(n, d = 0) {
        if (hit !== null || d > 40 || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) walk(c, d);
          return;
        }
        const { type, props } = n;
        if (typeof type === 'string' && type === 'button' && props?.children === label) {
          hit = props;
          return;
        }
        if (typeof type === 'function') {
          try {
            walk(type(props ?? {}), d + 1);
          } catch {
            /* 忽略渲染失败的子树 */
          }
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(tree);
      return hit;
    };

    const refreshBtn = findButtonProps('从 WorkBuddy 刷新');
    ok('找得到「从 WorkBuddy 刷新」按钮', typeof refreshBtn?.onClick === 'function');
    await refreshBtn.onClick();

    ok('刷新调用的是本包 /wb/models/refresh 路由', refreshCalls.length === 1, JSON.stringify(refreshCalls));
    ok('刷新路由带当前区域参数', refreshCalls[0]?.includes('region=cn') === true, refreshCalls[0]);
    const modelWrite = writes.find(([f]) => f === 'modelSelectionCn');
    ok('刷新直接落盘 modelSelectionCn（无需点保存）', modelWrite !== undefined, JSON.stringify(writes.map(([f]) => f)));
    if (modelWrite !== undefined) {
      const payload = modelWrite[1];
      ok(
        '刷新写入整段五键覆盖',
        ['enabledModelIds', 'imageModelIds', 'contextBudgets', 'reasoningEfforts', 'maxMode'].every(
          (k) => k in (payload ?? {}),
        ),
        JSON.stringify(Object.keys(payload ?? {})),
      );
      ok(
        '刷新后 fresh 全部启用（含新模型 m3）',
        Array.isArray(payload.enabledModelIds) && payload.enabledModelIds.join(',') === 'm1,m3',
        JSON.stringify(payload.enabledModelIds),
      );
      ok(
        '图片能力跟随上游 supportsImages（m3 → imageModelIds）',
        payload.imageModelIds?.join(',') === 'm3',
        JSON.stringify(payload.imageModelIds),
      );
      ok(
        'Max 模式沿用当前区域既有值',
        payload.maxMode === poolStatusFixture.selection.maxMode,
        String(payload.maxMode),
      );
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2h) 点一次「添加账号」只能打开**一个**登录页 ——
 *
 * 这是用户实际报的故障：「点击添加账号会连着出现好几个页面」。
 *
 * 成因是**双开**：服务端 `beginLogin` 已经用 `openInSystemBrowser` 开过系统
 * 浏览器（回执 `opened: true`），前端又无条件 `window.open(authUrl)` 再开一个。
 * Trae 侧还叠上官方授权页自己的「先空参探测回调 → 再跳转」，于是看起来是
 * 连着好几个页面。
 *
 * 这里用真实的 window/window.open 桩计数：服务端说 opened=true 时前端必须
 * **一次都不开**；服务端没打开成功时前端才补开一次。
 */
{
  const prevWindow = globalThis.window;
  const opens = [];
  globalThis.window = {
    open: (url) => {
      opens.push(url);
      return null;
    },
  };
  const authUrl = 'https://login.trae.cn/authorization?x=1';
  /**
   * 让 /login/start 返回指定 opened 回执，并让 /login/status 立刻结束轮询。
   *
   * status 必须真的返回 done —— 否则 onTraeAddAccount 会按 1.5s 一次轮询
   * 整整 3 分钟（它的 deadline），测试就卡在那里直到超时。
   */
  const withStart = (opened) => (url) => {
    if (typeof url === 'string' && url.includes('/trae/login/start')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessionId: 's1', authUrl, opened }) });
    }
    if (typeof url === 'string' && url.includes('/trae/login/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'done' }) });
    }
    if (typeof url === 'string' && url.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'signed-out', accounts: [] }) });
    }
    return new Promise(() => {});
  };

  /**
   * 直接抓出按钮的 onClick 来点，而不是靠渲染触发。
   *
   * 渲染只会画出按钮、不会替用户点击，所以要在元素树里找到「添加账号」
   * 那个按钮并调用它的 onClick —— 这才是用户实际走的路径。
   */
  const clickAddAccount = async (opened) => {
    opens.length = 0;
    globalThis.fetch = withStart(opened);
    const react = makeReact({ 0: 'accounts' }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({ react, jsxRuntime, embedded: makeEmbedded() });
    const tree = Page({});
    /**
     * 左右两列的按钮都叫「添加账号」（左 WorkBuddy、右 Trae），
     * 所以按**列序**取：先找到两个 wbc-col，取第二列（Trae）里的那个。
     * 只按文字找会拿到 WorkBuddy 的按钮 —— 那测的就不是 Trae 这条路径了
     * （实测如此：抓到的第一个按钮打的是 /wb/login/start）。
     */
    const cols = [];
    (function findCols(n, d = 0) {
      if (d > 40 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) findCols(c, d);
        return;
      }
      const { type, props } = n;
      if (typeof props?.className === 'string' && /(^|\s)wbc-col(\s|$)/.test(props.className)) {
        cols.push(n);
        return;
      }
      if (typeof type === 'function') {
        try {
          findCols(type(props ?? {}), d + 1);
        } catch {
          /* 忽略渲染失败的子树 */
        }
        return;
      }
      if (typeof type === 'string') findCols(props?.children, d + 1);
    })(tree);
    const traeCol = cols[1];
    let handler = null;
    (function walk(n, d = 0) {
      if (handler !== null || d > 40 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c, d);
        return;
      }
      const { type, props } = n;
      if (typeof type === 'string' && type === 'button' && props?.children === '添加账号') {
        handler = props.onClick;
        return;
      }
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), d + 1);
        } catch {
          /* 忽略渲染失败的子树 */
        }
        return;
      }
      if (typeof type === 'string') walk(props?.children, d + 1);
    })(traeCol);
    if (handler === null) return 'no-button';
    // 轮询第一次要等 1.5s，status 返回 done 之后才会退出循环
    await handler();
    return null;
  };

  const prevFetch = globalThis.fetch;
  // ① 服务端已打开（opened: true）→ 前端不得再开
  let err = await clickAddAccount(true);
  ok('能在账号页找到「添加账号」按钮', err !== 'no-button', err === 'no-button' ? '未找到按钮' : '');
  ok(
    '服务端 opened=true 时前端不再开第二个页面（一次点击 = 一个页面）',
    opens.length === 0,
    `实际开了 ${opens.length} 个: ${opens.join(', ')}`,
  );

  // ② 服务端没打开成功（opened: false）→ 前端补开一次
  err = await clickAddAccount(false);
  ok(
    '服务端未打开成功时前端补开一次（兜底）',
    opens.length === 1,
    `实际开了 ${opens.length} 个: ${opens.join(', ')}`,
  );
  ok('补开的正是授权页地址', opens[0] === authUrl, String(opens[0]));
  void err;

  globalThis.fetch = prevFetch;
  globalThis.window = prevWindow;
}

// —— 3) 无数据 / 坏数据下不崩 ——
for (const [name, preset] of [
  ['status/summary 均为 null', {}],
  ['accounts 不是数组', { 2: { accounts: 'oops' }, 3: { accounts: null, dailyTrend: null } }],
  [
    'credits 字段缺失',
    { 2: { accounts: [{ id: 'x' }] }, 3: { accounts: [{ uid: 'x' }], dailyTrend: [{ day: 'd', delta: 0 }] } },
  ],
  ['delta 为 NaN', { 2: statusFixture, 3: { accounts: [{ uid: 'x', delta: NaN }], dailyTrend: [{ day: 'd', delta: NaN }] } }],
]) {
  for (const tabId of ['accounts', 'wb-credits', 'wb-history']) {
    let err = null;
    try {
      renderPage({ ...preset, 0: tabId });
    } catch (e) {
      err = e;
    }
    ok(`坏数据（${name}）· ${tabId} tab 不崩`, err === null, err?.message);
  }
}

// —— 4) 账号 tab 的签到/额度边界值 ——
for (const [name, acct] of [
  ['checkin 缺失', { id: 'a', credits: { total: 1 } }],
  ['checkinError', { id: 'a', credits: { total: 1 }, checkinError: 'boom' }],
  ['未签到', { id: 'a', credits: { total: 1 }, checkin: { todayCheckedIn: false, streakDays: 0 } }],
  ['expiresAt 非法', { id: 'a', credits: { total: 1 }, expiresAt: 'not-a-date' }],
  ['creditsError', { id: 'a', creditsError: '读取失败' }],
  ['nickname 缺失', { id: 'a-id', credits: { total: 1 } }],
]) {
  let err = null;
  try {
    renderPage({ ...withData, 0: 'accounts', 2: { accounts: [acct] } });
  } catch (e) {
    err = e;
  }
  ok(`账号边界（${name}）不崩`, err === null, err?.message);
}

/**
 * —— 5) 账号页右列（Trae）的边界值 ——
 *
 * Trae 那半并入「账号」标签页后，它与 WorkBuddy 共用一个渲染树。
 * 它这边抛错同样会让整个设置面板白屏 —— 所以单列出来覆盖。
 * 尤其要覆盖「一侧坏、另一侧好」：两列必须互不连坐。
 */
for (const [name, traeStatus] of [
  ['traeStatus 为 null', null],
  ['未登录', { status: 'signed-out', accounts: [] }],
  ['error 状态', { status: 'error', accounts: [], message: 'boom' }],
  ['accounts 不是数组', { status: 'signed-in', accounts: 'oops' }],
  ['credits 缺失', { status: 'signed-in', accounts: [{ id: 't', selected: true }] }],
  ['credits 为坏值', { status: 'signed-in', accounts: [{ id: 't', selected: true }], credits: { generalAvailable: 'x' } }],
  ['checkin 缺失', { status: 'signed-in', accounts: [{ id: 't', selected: true }], credits: {} }],
  ['账号缺 accountName', { status: 'signed-in', accounts: [{ id: 't1' }], credits: {} }],
  ['无 selected 账号', { status: 'signed-in', accounts: [{ id: 't1' }, { id: 't2' }], credits: {} }],
]) {
  let err = null;
  try {
    // 0=tab(accounts) · 2=左侧 status · 9=右侧 traeStatus
    renderPage({ ...withData, 0: 'accounts', 9: traeStatus });
  } catch (e) {
    err = e;
  }
  ok(`Trae 列边界（${name}）不崩`, err === null, err?.message);
}

/**
 * 一侧数据坏掉时，另一列必须照常渲染出内容 —— 两列互不连坐。
 * 这是「合并到同一个 tab」最容易引入的回归：一个共用的取值就同时打穿两边。
 */
{
  let text = '';
  let err = null;
  try {
    text = renderPage({ ...withData, 0: 'accounts', 2: { accounts: 'oops' }, 9: traeFixture });
  } catch (e) {
    err = e;
  }
  ok('左列坏数据时右列仍渲染', err === null && text.includes('trae-user@example.com'), err?.message);

  let text2 = '';
  let err2 = null;
  try {
    text2 = renderPage({ ...withData, 0: 'accounts', 2: statusFixture, 9: { status: 'signed-in', accounts: 'oops' } });
  } catch (e) {
    err2 = e;
  }
  ok('右列坏数据时左列仍渲染', err2 === null && text2.includes('测试账号'), err2?.message);
}

//#region 输入框下方的「当前模型额度」胶囊
//
// 这个组件挂在 conversation.composer.dock（输入框正下方那一行），
// 与设置面板**完全无关** —— 它在对话页渲染。所以它必须满足两个更严的约束：
//   1. 任何一环拿不到（没有 modelDirectories / 没有 sessionId / provider 不是
//      本插件的）都要**返回 null**，不能在 composer 那一行渲染出东西；
//   2. 绝不能抛 —— 它旁边就是输入框，抛错会连累整个 compose 区域。
console.log('\n输入框额度胶囊\n');

{
  const Pill = createConsoleSection({ react: makeReact(), jsxRuntime: makeJsxRuntime(), embedded: {} })
    .ComposerCreditsPill;
  ok('工厂在页面组件上挂出了 ComposerCreditsPill', typeof Pill === 'function');
}

/** 造一个最小 model directory store */
function makeModelStore(provider, model = 'some-model') {
  let listener = null;
  return {
    store: {
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      getSnapshot: () => ({ groups: [], current: { provider, model } }),
    },
    fire: () => listener?.(),
  };
}

/** 渲染胶囊一次，返回 {node, text} */
function renderPill(provider, { modelDir, sessionId = 's1', preset = {}, runEffects = false } = {}) {
  const react = makeReact(preset, runEffects);
  const jsxRuntime = makeJsxRuntime();
  const Pill = createConsoleSection({ react, jsxRuntime, embedded: {} }).ComposerCreditsPill;
  const node = Pill({ sessionId, resolveModelDirectory: modelDir });
  const out = [];
  collectText(node, out);
  return { node, text: out.join('') };
}

// 非本插件的 provider：必须不渲染任何东西
for (const foreign of ['deepseek', 'deepseek-v4.1-flash', '', undefined]) {
  const { node } = renderPill(foreign, { modelDir: () => makeModelStore(foreign).store, preset: { 0: null } });
  ok(`provider=${JSON.stringify(foreign)} 时不渲染`, node === null);
}

// 没有 sessionId / 没有解析器：也不能崩、不能渲染
{
  const react = makeReact({}, false);
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let err = null;
  let node = 'unset';
  try {
    node = Pill({});
  } catch (e) {
    err = e;
  }
  ok('缺 props 时不抛且返回 null', err === null && node === null, err?.message);

  let err2 = null;
  try {
    Pill({ sessionId: 's1', resolveModelDirectory: () => undefined });
  } catch (e) {
    err2 = e;
  }
  ok('解析器返回 undefined 时不抛', err2 === null, err2?.message);
}

// 解析器自身抛错：必须被吞掉
{
  const react = makeReact({}, false);
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let err = null;
  try {
    Pill({
      sessionId: 's1',
      resolveModelDirectory: () => {
        throw new Error('boom');
      },
    });
  } catch (e) {
    err = e;
  }
  ok('解析器抛错时被吞掉（不连累输入框）', err === null, err?.message);
}

// 本插件的四个 provider 都要认出来，并渲染出胶囊节点
//
// 预置 state[0]（useCurrentModel 的 current）而不是靠 effect 跑出来：
// 本文件的 react 桩里 setState 只改 hook 槽位、不会触发重渲染，所以
// 「effect 里 setState」在同一次调用里看不出来。既有用例同样用 preset。
for (const provider of ['workbuddy-xdpool', 'workbuddy-xdpool-global', 'trae', 'trae-global']) {
  const { node } = renderPill(provider, {
    modelDir: () => makeModelStore(provider).store,
    preset: { 0: { provider, model: 'some-model' } },
  });
  const cls = String(node?.props?.className ?? '');
  ok(`provider=${provider} 渲染胶囊`, cls.includes('wotr-credit-pill'), cls);
  const out = [];
  collectText(node, out);
  ok(`provider=${provider} 胶囊含「积分」字样`, out.join('').includes('积分'), out.join(''));
}

// 真取到额度后要显示数字（走 fetch 桩 + 点击强制刷新绕开模块级缓存）
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, accounts: [{ credits: { total: 1234 } }, { credits: { total: 66 } }] }),
  });
  const store = makeModelStore('workbuddy-xdpool');
  const react = makeReact({ 0: { provider: 'workbuddy-xdpool', model: 'm' } }, false);
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let node = null;
  let err = null;
  try {
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
    // 点击 = 清缓存 + 重新取，是真实用户能走的路径
    node?.props?.onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
  } catch (e) {
    err = e;
  }
  const out = [];
  collectText(node, out);
  const text = out.join('');
  ok('取到额度后显示合计数字', err === null && text.includes('1,300'), text);
  globalThis.fetch = prevFetch;
}

// fetch 失败：显示占位而不是崩
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const store = makeModelStore('trae');
  const react = makeReact({ 0: { provider: 'trae', model: 'm' } }, false);
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let err = null;
  let node = null;
  try {
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
    node?.props?.onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
  } catch (e) {
    err = e;
  }
  const out = [];
  collectText(node, out);
  ok('取数失败时不抛且显示占位', err === null && out.join('').includes('积分'), err?.message);
  globalThis.fetch = prevFetch;
}

// Trae usage 的 general + work 要相加
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ credits: { generalAvailable: 500, workAvailable: 25 } }),
  });
  const store = makeModelStore('trae-global');
  const react = makeReact({ 0: { provider: 'trae-global', model: 'm' } }, false);
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let node = null;
  let err = null;
  try {
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
    node?.props?.onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    node = Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
  } catch (e) {
    err = e;
  }
  const out = [];
  collectText(node, out);
  ok('Trae 的通用+工作余额相加', err === null && out.join('').includes('525'), out.join(''));
  globalThis.fetch = prevFetch;
}

// 点击不抛（强制刷新路径）
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const store = makeModelStore('workbuddy-xdpool-global');
  const { node } = renderPill('workbuddy-xdpool-global', {
    modelDir: () => store.store,
    preset: { 0: { provider: 'workbuddy-xdpool-global', model: 'm' } },
  });
  let err = null;
  try {
    node?.props?.onClick?.();
  } catch (e) {
    err = e;
  }
  ok('点击胶囊强制刷新不抛', err === null, err?.message);
  globalThis.fetch = prevFetch;
}

/**
 * —— 定时刷新（30 秒）——
 *
 * 这一组必须**真的跑 effect**，否则等于没测：胶囊的刷新全在 useEffect 里，
 * 上面所有用例都用 runEffects=false，定时器那条分支根本没被执行过。
 *
 * 用假定时器（替换 globalThis.setInterval / clearInterval）来断言：
 *   - 挂载时注册了一个 30 秒的 interval；
 *   - 到点会真的再发一次请求；
 *   - 卸载时 interval 被清掉（否则切会话会累积定时器，越切越费）。
 * 同时给 document 一个最小桩，让 visibilityState 判定可走。
 */
{
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const prevDocument = globalThis.document;

  /** 记录注册的定时器：{fn, ms, id, cleared} */
  const timers = [];
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => {
    const t = { fn, ms, id: nextId++, cleared: false };
    timers.push(t);
    return t.id;
  };
  globalThis.clearInterval = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t !== undefined) t.cleared = true;
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
  };

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ ok: true, accounts: [{ credits: { total: 700 + calls } }] }) };
  };

  const store = makeModelStore('workbuddy-xdpool');
  const react = makeReact({ 0: { provider: 'workbuddy-xdpool', model: 'm' } }, true); // runEffects
  const Pill = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: {} }).ComposerCreditsPill;
  let err = null;
  try {
    Pill({ sessionId: 's1', resolveModelDirectory: () => store.store });
  } catch (e) {
    err = e;
  }
  await new Promise((r) => setTimeout(r, 0));

  ok('挂载后注册了定时器', err === null && timers.length === 1, err?.message ?? `timers=${timers.length}`);
  if (timers.length === 1) {
    ok('定时器间隔为 30 秒', timers[0].ms === 30000, String(timers[0].ms));
    const before = calls;
    // 触发到点回调
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    ok('到点会再次请求', calls > before, `before=${before} after=${calls}`);
  }

  // 卸载必须清掉定时器
  let cleanupErr = null;
  try {
    react.unmount();
  } catch (e) {
    cleanupErr = e;
  }
  ok('卸载时不抛', cleanupErr === null, cleanupErr?.message);
  ok('卸载时清掉了定时器', timers.length === 1 && timers[0].cleared === true, `cleared=${timers[0]?.cleared}`);

  // 页面隐藏时那一拍不发请求
  {
    const timers2 = [];
    let id2 = 1;
    globalThis.setInterval = (fn, ms) => {
      timers2.push({ fn, ms, id: id2++ });
      return id2 - 1;
    };
    globalThis.document.visibilityState = 'hidden';
    const store2 = makeModelStore('trae');
    const react2 = makeReact({ 0: { provider: 'trae', model: 'm' } }, true);
    const Pill2 = createConsoleSection({ react: react2, jsxRuntime: makeJsxRuntime(), embedded: {} })
      .ComposerCreditsPill;
    let node2 = null;
    try {
      const realUseEffect2 = react2.useEffect;
      react2.useEffect = (fn) => {
        fn();
      };
      node2 = Pill2({ sessionId: 's1', resolveModelDirectory: () => store2.store });
      react2.useEffect = realUseEffect2;
    } catch (e) {
      err = e;
    }
    await new Promise((r) => setTimeout(r, 0));
    const beforeHidden = calls;
    if (timers2.length > 0) timers2[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    ok('页面隐藏时到点不发请求', calls === beforeHidden, `before=${beforeHidden} after=${calls}`);
    void node2;
  }

  globalThis.fetch = prevFetch;
  globalThis.setInterval = prevSetInterval;
  globalThis.clearInterval = prevClearInterval;
  globalThis.document = prevDocument;
}

/**
 * —— Qoder 积分自动刷新：定时器真的跑起来 ——
 *
 * 上面那组断言只能证明**页面上写着**「每 30 秒自动刷新」。文案是文案：
 * 把 useEffect 里的 setInterval 整段删掉，文案一个字都不会变，测试全绿，
 * 而用户看到的是一个永远停在「读取中…」的页面。所以这一组必须真的驱动
 * 定时器与 fetch，断言：
 *
 *   - 进入 Qoder 标签页会**立刻**发一次（不等第一拍，否则进页面先空 30 秒）；
 *   - 注册的 interval 是 30 秒（与上游节奏一致）；
 *   - 到点会真的**再发一次**；
 *   - 切走（tab 变了）会把定时器清掉，不再打上游；
 *   - 页面隐藏时那一拍不发请求（没人看时不烧调用）。
 */
{
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const prevDocument = globalThis.document;

  const timers = [];
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => {
    const t = { fn, ms, id: nextId++, cleared: false };
    timers.push(t);
    return t.id;
  };
  globalThis.clearInterval = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t !== undefined) t.cleared = true;
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
  };

  /** 记录打过的 URL，用于区分「刷积分」与「重读号池」两种请求 */
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/qoder/credits/refresh')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          refreshed: 1,
          failed: 0,
          accounts: [{ id: 'q1', ok: true, total: 300 }],
        }),
      };
    }
    return { ok: true, json: async () => qoderFixture };
  };

  const creditsCalls = () => urls.filter((u) => u.includes('/qoder/credits/refresh')).length;

  // 进入 Qoder 标签页：hook 0 = tab
  const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' }, true);
  const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
  let err = null;
  try {
    Page({});
  } catch (e) {
    err = e;
  }
  await new Promise((r) => setTimeout(r, 0));

  ok('进 Qoder 页不抛异常', err === null, err?.message);
  ok('进页面立刻刷一次积分（不等第一拍）', creditsCalls() >= 1, `calls=${creditsCalls()}`);

  const qoderTimer = timers.find((t) => t.ms === 30000);
  ok('注册了 30 秒的自动刷新定时器', qoderTimer !== undefined, `timers=${timers.map((t) => t.ms).join(',')}`);

  if (qoderTimer !== undefined) {
    const before = creditsCalls();
    qoderTimer.fn();
    await new Promise((r) => setTimeout(r, 0));
    ok('到点会再刷一次积分', creditsCalls() > before, `before=${before} after=${creditsCalls()}`);
  }

  // 页面隐藏时那一拍不发
  {
    const before = creditsCalls();
    globalThis.document.visibilityState = 'hidden';
    if (qoderTimer !== undefined) qoderTimer.fn();
    await new Promise((r) => setTimeout(r, 0));
    ok('页面隐藏时那一拍不刷积分', creditsCalls() === before, `before=${before} after=${creditsCalls()}`);
    globalThis.document.visibilityState = 'visible';
  }

  // 卸载（切走标签页）必须清掉定时器
  let cleanupErr = null;
  try {
    react.unmount();
  } catch (e) {
    cleanupErr = e;
  }
  ok('切走 Qoder 页时不抛', cleanupErr === null, cleanupErr?.message);
  ok(
    '切走后清掉了自动刷新定时器',
    qoderTimer !== undefined && qoderTimer.cleared === true,
    `cleared=${qoderTimer?.cleared}`,
  );

  globalThis.fetch = prevFetch;
  globalThis.setInterval = prevSetInterval;
  globalThis.clearInterval = prevClearInterval;
  globalThis.document = prevDocument;
}

//#endregion

//#region 两个配置页的样式一致性
//
// 这一组守住「XD Pool 与 Trae 配置看起来是同一个东西」这件事。
//
// 先前两页各写各的：Trae 页的列头**没有标题**、号池账号卡是手写的（不走
// AccountCard）、模型列表是 wbc-model 行式而 XD Pool 是 wbc-cols 网格、
// 保存按钮一个在表头一个在底部。并排切换一眼就是两套设计。
//
// 这类问题**不会让任何测试失败**（页面照样渲染、功能照样能用），所以必须
// 显式断言结构，否则下次再分叉也没人发现。
console.log('\n两页样式一致性\n');

/**
 * 用 fetch 桩把两个页面都喂上完整数据，再抽「模块级 class 序列」。
 *
 * 与前面号池用例同一套路：喂数据而不是预置 hook 下标（下标会随组件改动漂移）。
 */
async function moduleSequenceOf(tabId, fixtures) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fixtures.trae) });
    }
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fixtures.pool) });
    }
    return new Promise(() => {});
  };
  try {
    const react = makeReact({ 0: tabId }, true);
    const jsxRuntime = makeJsxRuntime();
    const Page = createConsoleSection({ react, jsxRuntime, embedded: makeEmbedded() });
    /**
     * 必须**遍历**元素树，不能只调用 Page()。
     *
     * `Page({})` 只返回元素树；子组件（TraeConfigTab 之类）要等遍历器调用
     * `type(props)` 才会执行，它们的 useEffect 也才跑 —— 也就是数据请求
     * 是在遍历时发出的。早先这里只写 `Page({})` 就把返回值丢了，于是
     * Trae 页永远停在 loading 态，而 XD Pool 页因为数据来自主组件反而正常。
     */
    const drive = (node) => {
      const sink = [];
      collectText(node, sink);
    };
    drive(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    drive(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});

    /** 只保留这一层级的模块 class，忽略文本与数量 */
    const MODULE = /^(wbc-col-head|wbc-col-title|wbc-col-sub|wbc-sums|wbc-sum|wbc-sum-label|wbc-sum-value|wbc-sum-sub|wbc-models|wbc-bar|wbc-cards|wbc-card|wbc-card-head|wbc-name|wbc-tag|wbc-kv|wbc-k|wbc-v|wbc-btn|wbc-cols|wbc-col|wbc-check|wbc-model-name|wbc-model-meta|wbc-empty|wbc-note|wbc-probe|wbc-model-actions)$/;
    const seq = [];
    (function walk(node, depth = 0) {
      if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const c of node) walk(c, depth);
        return;
      }
      const { type, props } = node;
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), depth + 1);
        } catch {
          /* 子组件的降级分支，跳过 */
        }
        return;
      }
      const cls = props?.className;
      if (typeof cls === 'string') {
        const hit = cls.trim().split(/\s+/).find((c) => MODULE.test(c));
        if (hit !== undefined) seq.push(hit);
      }
      walk(props?.children, depth + 1);
    })(tree, 0);
    return seq;
  } finally {
    globalThis.fetch = prevFetch;
  }
}

const parityPool = {
  ...poolStatusFixture,
  models: [{ id: 'm1', name: 'M1', nativeContextWindow: 2e5, maxTokens: 8192, supportsImages: true, supportedEfforts: ['off', 'high'], enabled: true }],
};
const parityTrae = {
  status: 'signed-in',
  accountName: 'trae-user@example.com',
  // 两个账号：Trae 页的绑定卡只在 accounts.length > 1 时出现（单账号没什么可切），
  // 与 XD Pool 侧「账号卡无条件显示」不同 —— 这是**数据条件**的差异，
  // 不是样式差异，所以夹具给两个账号才能真正比到卡片骨架。
  accounts: [
    { id: 't1', accountName: 'trae-user@example.com', selected: true },
    { id: 't2', accountName: 'trae-backup@example.com', selected: false },
  ],
  models: [{ id: 'tm1', name: 'TM1', contextWindow: 2e5 }],
  enabledModelIds: ['tm1'],
  credits: { generalAvailable: 1200, workAvailable: 340 },
  checkin: { checkedIn: false, credits: 50 },
  pool: {
    distribution: 'priority',
    lastServedId: 't1',
    accounts: [{ id: 't1', label: 't1', cooling: false, rateLimitHits: 0, disabled: false, creditReserve: 0 }],
  },
};

{
  const fixtures = { pool: parityPool, trae: parityTrae };
  const poolSeq = await moduleSequenceOf('pool-config', fixtures);
  const traeSeq = await moduleSequenceOf('trae-config', fixtures);

  // ① 两页都要有列头标题 —— 先前 Trae 页没有，切换时视觉重心对不齐
  ok('XD Pool 列头有标题', poolSeq[0] === 'wbc-col-head' && poolSeq[1] === 'wbc-col-title', poolSeq.slice(0, 3).join(','));
  ok('Trae 列头有标题', traeSeq[0] === 'wbc-col-head' && traeSeq[1] === 'wbc-col-title', traeSeq.slice(0, 3).join(','));

  // ② 两页的列头骨架一致：标题 → 区域按钮 → (可选插件) → 操作按钮
  const headOf = (seq) => {
    const out = [];
    for (const c of seq) {
      out.push(c);
      if (c === 'wbc-btn' && out.filter((x) => x === 'wbc-btn').length >= 2) break;
    }
    return out.join('>');
  };
  ok(
    '两页列头骨架一致（标题 + 区域按钮）',
    headOf(poolSeq) === headOf(traeSeq),
    `pool=${headOf(poolSeq)} trae=${headOf(traeSeq)}`,
  );

  // ③ 统计行：两页都有
  ok('XD Pool 有统计行', poolSeq.includes('wbc-sums'));
  ok('Trae 有统计行', traeSeq.includes('wbc-sums'));

  // ④ 账号卡走同一套骨架（card → card-head → name → tag → kv）
  const cardShape = (seq) => {
    const i = seq.indexOf('wbc-card');
    return i === -1 ? '' : seq.slice(i, i + 5).join('>');
  };
  ok(
    '两页账号卡骨架一致',
    cardShape(poolSeq) === cardShape(traeSeq),
    `pool=${cardShape(poolSeq)} trae=${cardShape(traeSeq)}`,
  );

  // ⑤ 模型列表：两页都用 wbc-cols 网格 + wbc-col 单元（先前 Trae 是 wbc-model 行式）
  ok('XD Pool 模型列表用网格', poolSeq.includes('wbc-cols') && poolSeq.includes('wbc-col'));
  ok('Trae 模型列表用网格', traeSeq.includes('wbc-cols') && traeSeq.includes('wbc-col'));

  // ⑥ 两页都**不再**使用行式的 wbc-model 容器
  ok('两页都不再用行式 wbc-model 容器', !poolSeq.includes('wbc-model') && !traeSeq.includes('wbc-model'));
}

/**
 * 号池账号卡必须走共用的 AccountCard，而不是各页手写一份。
 *
 * 判据：卡内的「保留积分 + 保存 + 停用」控件要出现在 **wbc-card 内部**
 * （即 AccountCard 的 extra 插槽），而不是卡片外面另起一段。
 */
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(parityTrae) });
    }
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(parityPool) });
    }
    return new Promise(() => {});
  };
  try {
    for (const [tabId, label] of [['pool-config', 'XD Pool'], ['trae-config', 'Trae']]) {
      const react = makeReact({ 0: tabId }, true);
      const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
      // 同 moduleSequenceOf：要遍历才会执行子组件、发出请求
      collectText(Page({}), []);
      await new Promise((r) => setTimeout(r, 0));
      react.reset();
      collectText(Page({}), []);
      await new Promise((r) => setTimeout(r, 0));
      react.reset();
      const tree = Page({});

      /** 在元素树里找 wbc-card，看它子树里有没有「停用 / 重新启用」按钮 */
      const cardHasDisable = (node, depth = 0) => {
        if (depth > 40 || node === null || node === undefined || typeof node !== 'object') return false;
        if (Array.isArray(node)) return node.some((c) => cardHasDisable(c, depth));
        const { type, props } = node;
        if (typeof type === 'function') {
          try {
            return cardHasDisable(type(props ?? {}), depth + 1);
          } catch {
            return false;
          }
        }
        const cls = typeof props?.className === 'string' ? props.className : '';
        if (/(^|\s)wbc-card(\s|$)/.test(cls)) {
          // 卡内找「停用 / 重新启用」或「移出池子」（WorkBuddy 侧）
          const texts = [];
          collectText(props?.children, texts);
          const joined = texts.join('');
          return joined.includes('停用') || joined.includes('重新启用') || joined.includes('移出池子');
        }
        return cardHasDisable(props?.children, depth + 1);
      };
      ok(`${label} 的账号启停/保留控件在卡片内部（走共用 AccountCard.extra）`, cardHasDisable(tree));
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);