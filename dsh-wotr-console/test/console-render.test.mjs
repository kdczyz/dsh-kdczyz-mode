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

/**
 * 在元素树里按 `className` 的**空格分隔 token** 精确匹配找节点。
 *
 * 为什么不能用 `text.includes(...)` 代替：很多断言问的是「这个标签贴在**哪张
 * 卡**上」（例如「本次调用」该贴在真正被调用的账号上，而不是固定使用的那个）。
 * 整页文本里那个词当然出现过，贴错卡片照样通过 —— 断言必须能区分是哪一张卡。
 *
 * 两个坑：
 *   1. 函数组件要展开（`jsx(AccountCard, …)` 本身没有 class）；
 *   2. 必须按 token 精确匹配，不能用子串 —— 卡片容器叫 `wbc-cards`，
 *      子串匹配会把容器也当卡片收进来，于是「第一张卡」的文本里含全部卡片。
 */
function collectByClass(node, needle, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, needle, out, depth);
    return out;
  }
  if (typeof node.type === 'function') {
    collectByClass(node.type(node.props ?? {}), needle, out, depth + 1);
    return out;
  }
  if (String(node.props?.className ?? '').split(/\s+/).includes(needle)) out.push(node);
  collectByClass(node.props?.children, needle, out, depth + 1);
  return out;
}

/** 一棵（子）树里的全部文本，便于按节点断言而不是按整页断言 */
function textOfNode(node) {
  const out = [];
  collectText(node, out);
  return out.join(' ');
}

/**
 * 按按钮文案收集 `onClick`（渲染顺序），并连带收集按钮本身的 props。
 *
 * 「按钮画出来了、点下去打到别处」这类退化不会让任何别的断言变红，只能真点一次，
 * 所以需要一个能从渲染树里把按钮掏出来的口子。返回的每一项形如
 * `{ label, onClick, disabled, title, node }`；文案相同的按钮可能不止一个（每张账号
 * 卡各一颗），顺序就是渲染顺序。
 */
function collectButtons(node, label, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, label, out, depth);
    return out;
  }
  if (typeof node.type === 'function') {
    try {
      collectButtons(node.type(node.props ?? {}), label, out, depth + 1);
    } catch {
      /* 渲染失败的子树跳过：别为了找按钮把整个用例带崩 */
    }
    return out;
  }
  const children = node.props?.children;
  if (node.type === 'button' && (label === undefined || children === label)) {
    out.push({
      label: children,
      onClick: node.props?.onClick,
      disabled: node.props?.disabled === true,
      title: node.props?.title,
      node,
    });
  }
  collectButtons(children, label, out, depth + 1);
  return out;
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
  // 「最近真正服务过请求的账号」。与 selectedAccountId 刻意**同值**：这里要测
  // 的是「固定账号」那套 UI，两者不同值会另外把「本次调用」标签也带进来，
  // 让这一组断言变成混着两件事。两者不同值的覆盖在下面按卡片取文本那一组。
  activeAccountId: 'u1',
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
  //
  // `accounts` 按 `/trae/pool` 的真实形状给两条，与 store 里的登录按 id 对齐：
  // 一条正常（带保留额度 0 → 行里应写「不限」），一条冷却中且限流过 2 次
  // （覆盖「冷却中」标签、`限流 N 次` 标签与「冷却至」行）。
  // 早先这里没有 `accounts`，于是所有号池字段渲染出来都是空的 ——
  // 断言只能靠统计格的文字蒙混过关。
  pool: {
    distribution: 'balanced',
    accounts: [
      {
        id: 't1',
        accountName: 'trae-user@example.com',
        cooling: false,
        disabled: false,
        reserved: false,
        creditReserve: 0,
        rateLimitHits: 0,
        credits: 900,
      },
      {
        id: 't2',
        accountName: 'trae-backup@example.com',
        cooling: true,
        cooldownUntilMs: Date.now() + 60000,
        disabled: false,
        reserved: true,
        creditReserve: 200,
        rateLimitHits: 2,
        credits: 120,
      },
    ],
  },
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
  /**
   * 两个 id 都刻意指向 q2，而 `selectedAccountId` 是 q1：
   *
   *   - 固定用的账号（q1）≠ 最近真正服务过请求的账号（q2），这正是轮换模式下的
   *     常态，也是这次改动的核心口径；
   *   - 面板与积分页都必须以 `serving` 为准。若哪天有人把判据退回
   *     `selectedAccountId`，下面的「本次调用」断言会立刻变红 —— 这是刻意的：
   *     两者相同的话，读错来源在渲染断言里根本看不出来。
   *
   * `lastServedId` 与 `serving.accountId` 保持一致（都是 q2），免得 fixture 自己
   * 就自相矛盾、后续读者不知道该信哪个字段。
   */
  lastServedId: 'q2',
  serving: { accountId: 'q2', label: 'qoder-backup@example.com', source: 'served', credits: 420, error: null },
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
    {
      // 第三个账号既不是「固定当前」也不是「本次调用」——「备用」这个标签
      // 得有地方落。只有两个账号时，两个标签都会被占用，页面上再也看不到
      // 「备用」，于是这条渲染断言会莫名其妙地红掉（而功能其实是对的）。
      id: 'q3',
      label: 'qoder-spare@example.com',
      userId: 'qu3',
      expiresAtMs: 4102444800000,
      expired: false,
      disabled: false,
      selected: false,
      creditReserve: 0,
      credits: 1200,
      cooldownUntilMs: 0,
      cooling: false,
      modelCooldowns: {},
      rateLimitHits: 0,
    },
    {
      // 第四个账号余额**从未读到**（而它既不是固定账号、也不是被调用的那个，
      // 所以 `serving.credits` 不会替它兜底）。「读取中…」这条降级文案必须有
      // 地方落：现在唯一余额为 null 的 q2 恰好就是被调用的账号，宿主会拿
      // serving 的那一份替它显示，于是「读取中…」在整页上再也不出现。
      id: 'q4',
      label: 'qoder-unread@example.com',
      userId: 'qu4',
      expiresAtMs: 4102444800000,
      expired: false,
      disabled: false,
      selected: false,
      creditReserve: 0,
      credits: null,
      cooldownUntilMs: 0,
      cooling: false,
      modelCooldowns: {},
      rateLimitHits: 0,
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
      // 与 lib/index.js 的 `/status` 同形：上游把整份积分文档原样透传，
      // 于是这里是**对象**（`{total, packages…}`）而不是数字。
      // 早先 fixture 写的是数字，把「页面读不出 total、余额永远显示 –」
      // 这个真机上的 bug 一直挡在测试之外。
      credits: { total: 3080, packages: [{ packageName: '月包', remain: 80, size: 100 }] },
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
      credits: { total: 0, packages: [] },
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
  [
    'wb-credits',
    '积分',
    [
      // 胶囊/积分页的统一口径：先答「这次扣的是谁、还剩多少」，全池合计只作参考。
      '本次调用账号的额度',
      '3,080',
      '测试账号 · WorkBuddy 本区域',
      '当前总积分',
      '采样记录',
      '历史跨度',
      // WorkBuddy 的积分包明细仍要保留（挂在账号卡里）。
      '月包',
      '80 / 100',
      '2 个账号（本区域合计）',
      // 三家都在这张页面上：Trae 与 Qoder 的账号与余额都要能看到。
      'Trae 账号（当前区域）',
      'trae-user@example.com',
      'trae-backup@example.com',
      'Qoder 账号',
      'qoder-user@example.com',
      'qoder-backup@example.com',
      'qoder-spare@example.com',
      // 被调用的账号（Qoder 侧的 q2）被标出来，而固定账号（q1）不冒充它。
      '本次调用',
    ],
  ],
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
      // 单账号语义（Trae 同款）：**恰好一张**卡是「当前使用」，其余是「备用」，
      // 换账号靠备用卡上的「切换到此账号」。没有「设为当前 / 取消固定」这对
      // 旧按钮 —— 它们写的是管理页自己的池，provider 根本读不到。
      '当前使用',
      '备用',
      '切换到此账号',
      '冷却中',
      '限流 3 次',
      '保留额度',
      '移出池子',
      // 分配策略三按钮（优先/轮换/均衡）在 Qoder 侧已删除：轮换与均衡会在每次
      // 请求上换账号，正是「固定了账号请求还是打到别号上」的来源。剩下的是一句
      // 账号区副标题 —— 完整的「使用方式」说明收进了标题悬停（hint）。
      '请求固定用「当前使用」那张',
      // 积分额度：**自动刷新**，所以页面上不该再有「刷新积分」按钮，
      // 而应说明节奏；余额「未读到」显示为「读取中…」而非叫用户去点按钮。
      // 合计（原来单独占一格「积分合计」）现在拼在「当前使用」的副标题里。
      '全池',
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
 * —— 2a-quater) Qoder 模型列：图片/上下文跟随上游 + 「从 Qoder 刷新」拉取即落盘 ——
 *
 * 这一列是「Qoder 支持图片的模型不能发图」那个 bug 的收尾，后来又按用户要求
 * （「取消可选择模块，类似 workbuddy 和 trae 的模型获取」）与另两家**逐条对齐**：
 * 卡片上只剩「启用」一个勾选，图片与上下文没有任何手动开关。六件事必须钉住：
 *
 *   1. **打开面板打的是哪个方法**：GET（只读当前值，不触上游、不花额度），
 *      只有「从 Qoder 刷新」才 POST。写反了就变成「一进页面先替你打一次上游」。
 *   2. **图片与上下文「看得见、没开关」**：目录里 `supportsImages` 的模型名字后面
 *      带「图片」，每张卡 meta 里有「上下文 180K」；而「补勾图片」勾选框与
 *      「上下文上限」输入框**必须不存在** —— 前者对上游已声明的模型是撤销
 *      （`lib/qoder.js` 的 `selectModels` 取并集，做不到），对上游漏标的是猜；
 *      后者只会被下一次刷新覆盖。把假开关留在页面上就是承诺做不到的动作。
 *   3. **保存写哪三个键、值是什么**：`enabledModelIds` 来自勾选，
 *      `imageModelIds` / `contextBudgets` 由**目录推导**（图片取 `supportsImages`，
 *      上下文清空 = 用满原生窗口）。
 *   4. **「从 Qoder 刷新」= 拉取即落盘**：一次点击把目录里的模型全部启用并按上游
 *      写回图片/上下文，读完不出现保存栏（与「从 Trae 刷新」同款）。
 *   5. **拉取失败一个字段都不写**：接口失败时仍会回一份兜底目录，照它写等于把
 *      内置兜底表固化成用户的白名单，而他看到的只是「刷新失败」。
 *   6. **写不进去时要说出来**：宿主的写入闸门可以拒绝写入而 `set()` 仍然正常
 *      resolve（volatile 字段缺失时就是这样），不读回确认就会「保存成功然后值
 *      自己弹回去」——另两家都踩过这个坑。
 *
 * ⚠️ **每棵元素树只能扫一遍**。组件是纯函数，`collectText` 展开它们时会真的
 * 调用组件、真的走一遍 `useState`；而迷你 react 的 hook 槽位是**整棵树共用**
 * 的一维数组（按下标）。同一棵树扫两遍，第二遍的游标停在上一次的末尾，读到的
 * state 全是别人的 —— 表现为「明明没改过，却出现了保存栏、模型卡片一个都不剩」。
 * 所以下面把文字、控件、按钮合并成**一次**遍历（`scan`），并且每次渲染前都
 * `react.reset()`。
 */
{
  const MODELS = [
    { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 180_000, supportsImages: true },
    { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 180_000, supportsImages: false },
  ];
  const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
  const prevFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    fetchCalls.push(`${method} ${url}`);
    if (String(url).includes('/qoder/models/refresh')) {
      return jsonRes({
        ok: true,
        models: MODELS,
        usingFallback: false,
        lastFetchAtMs: Date.parse('2026-10-11T10:00:00'),
      });
    }
    return jsonRes({ accounts: [], distribution: 'priority' });
  };

  /**
   * 会真的写入的作用域桩。
   *
   * `apply: false` 模拟「set() 正常 resolve、但值没落地」—— 宿主写不进 volatile
   * 字段时就是这个行为，也是「保存了又弹回去」的成因。
   */
  const makeWritableScope = (apply = true) => {
    let doc = { enabledModelIds: [], imageModelIds: [], contextBudgets: {} };
    const writes = [];
    return {
      writes,
      scope: {
        getSnapshot: () => ({ status: 'ready', value: doc, writable: true }),
        subscribe: () => () => {},
        set: (field, value) => {
          writes.push([field, value]);
          if (apply) doc = { ...doc, [field]: value };
          return Promise.resolve(true);
        },
      },
    };
  };

  /**
   * 一次遍历同时收三样东西：文本、`wbc-check` 控件、按钮。
   *
   * 合并的原因见本段开头的 ⚠️：同一棵树扫两遍会让 hook 槽位错位。
   */
  const scan = (tree) => {
    const texts = [];
    const checks = [];
    const buttons = [];
    (function walk(n, d = 0) {
      if (d > 40 || n === null || n === undefined || typeof n === 'boolean') return;
      if (typeof n === 'string' || typeof n === 'number') {
        texts.push(String(n));
        return;
      }
      if (Array.isArray(n)) {
        for (const c of n) walk(c, d);
        return;
      }
      if (typeof n !== 'object') return;
      const { type, props } = n;
      if (typeof type === 'function') {
        try {
          walk(type(props ?? {}), d + 1);
        } catch {
          /* 渲染失败的子树跳过（与 collectText 的宽松程度保持一致） */
        }
        return;
      }
      if (typeof type !== 'string') return;
      const cls = String(props?.className ?? '').split(/\s+/);
      if (cls.includes('wbc-check')) {
        let input = null;
        (function inner(m, dd = 0) {
          if (dd > 6 || m === null || m === undefined || typeof m !== 'object') return;
          if (Array.isArray(m)) {
            for (const c of m) inner(c, dd);
            return;
          }
          if (m.type === 'input') input = m.props;
          inner(m.props?.children, dd + 1);
        })(props?.children);
        const out = [];
        collectText(n, out);
        checks.push({ text: out.join(' '), input });
      }
      if (type === 'button' && typeof props?.children === 'string') {
        buttons.push({ label: props.children, className: String(props.className ?? ''), props });
      }
      walk(props?.children, d + 1);
    })(tree);
    return {
      text: texts.join(' | '),
      checks,
      /**
       * 按文字找按钮。⚠️ 同一页会有重名按钮 —— 号池那边**每个账号**都有一个
       * 「保存」（写保留额度），所以保存栏必须用 saveButton() 认。
       */
      button: (label) => buttons.find((b) => b.label === label)?.props,
      /** 模型卡的保存按钮：页面上唯一一个文字以「保存」开头的主按钮 */
      saveButton: () =>
        buttons.find(
          (b) => b.label.startsWith('保存') && b.className.split(/\s+/).includes('wbc-btn-primary'),
        )?.props,
      /** 按标签文字前缀找那一行的勾选框 */
      check: (needle) => checks.find((c) => c.text.includes(needle)),
      /** 找某个模型那张卡的启用勾选框（卡片标题以模型名开头） */
      model: (name) => checks.find((c) => c.text.startsWith(name)),
    };
  };

  /** 挂载：第一遍渲染跑 effect（发 GET），等它落地后再渲染一遍 */
  const mount = async (scope) => {
    const react = makeReact({ ...withData, 15: qoderFixture, 0: 'qoder' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: makeEmbedded({ qoderSettings: makeHandle(scope) }),
    });
    const render = async (first) => {
      if (first === true) {
        collectText(Page({}), []); // 跑 effect
        await new Promise((r) => setTimeout(r, 0));
      }
      react.reset();
      return scan(Page({}));
    };
    return { render, view: await render(true) };
  };

  const { scope, writes } = makeWritableScope();
  const page = await mount(scope);
  const v1 = page.view;

  ok(
    '打开面板只打 GET（qoder 目录端点没有被 POST）',
    fetchCalls.some((c) => c === 'GET /plugins/dsh-wotr-console/qoder/models/refresh') &&
      !fetchCalls.some((c) => c.startsWith('POST ') && c.includes('/qoder/models/refresh')),
    fetchCalls.join(' , '),
  );
  ok('列出目录里的两个模型', v1.text.includes('DeepSeek-Flash') && v1.text.includes('MiniMax-M2.7'));
  ok('保存值为空 = 不限制：两个模型都画成已启用', v1.text.includes('已启用 2 / 2 个'), v1.text.slice(0, 240));
  ok('统计上游声明支持图片的条数（1 个）', v1.text.includes('上游声明支持图片 1 个'));
  ok('未改动时不出现保存栏', v1.saveButton() === undefined);

  const mmEnable = v1.model('MiniMax-M2.7');
  ok('上游 is_vl 的模型名字后面标「图片」', v1.text.includes('DeepSeek-Flash · 图片'), v1.text.slice(0, 400));
  ok('纯文本模型不带「图片」标记', !v1.text.includes('MiniMax-M2.7 · 图片'));
  ok('模型卡上仍有上下文窗口（上游 max_input_tokens）', v1.text.includes('上下文 180K'), v1.text.slice(0, 400));
  ok('找得到 MiniMax 的启用勾选框且默认勾上', mmEnable?.input?.checked === true, JSON.stringify(mmEnable));
  ok(
    '「补勾图片」控件已从卡片上删除（假开关不留在页面上）',
    v1.check('补勾图片') === undefined && v1.check('图片（上游已支持）') === undefined,
    JSON.stringify(v1.checks.map((c) => c.text)),
  );
  ok(
    '「上下文上限」输入框已从卡片上删除（它只会被下一次刷新覆盖）',
    v1.check('上下文上限') === undefined,
    JSON.stringify(v1.checks.map((c) => c.text)),
  );

  // —— 手动勾选：取消 MiniMax 的启用 → 保存 ——
  // 图片/上下文已没有手动值可改，保存写下去的就是「目录推导 + 勾选」：
  // enabled 来自勾选，imageModelIds 只留目录里标了图片的那个，contextBudgets 清空。
  mmEnable.input.onChange({ target: { checked: false } });

  const v2 = await page.render();
  ok('改动后出现保存栏（未改动时不出现）', v2.saveButton() !== undefined, v2.text.slice(-200));
  ok('保存按钮可点（还有一个模型启用着）', v2.saveButton()?.disabled === false);
  await v2.saveButton().onClick();

  const writeOf = (field) => writes.find(([f]) => f === field)?.[1];
  ok('保存写 enabledModelIds=[dfmodel]', JSON.stringify(writeOf('enabledModelIds')) === '["dfmodel"]', JSON.stringify(writes));
  ok(
    '保存写 imageModelIds=[dfmodel]（按目录推导，不是手工补勾）',
    JSON.stringify(writeOf('imageModelIds')) === '["dfmodel"]',
    JSON.stringify(writes),
  );
  ok('保存写 contextBudgets={}（用满上游原生窗口）', JSON.stringify(writeOf('contextBudgets')) === '{}', JSON.stringify(writes));
  ok('三个字段各写一次（不重复写）', writes.length === 3, JSON.stringify(writes));

  const v3 = await page.render();
  ok('保存成功后给出提示', v3.text.includes('已保存'), v3.text.slice(-300));
  ok('保存后目录还在（没有被清空）', v3.text.includes('MiniMax-M2.7'));

  // —— 「从 Qoder 刷新」：拉取即落盘（与「从 Trae 刷新」同款） ——
  // 一次点击 = 拉上游 + 全部启用 + 图片/上下文按上游写回 + 读回确认，
  // **不需要再点保存**。这里用一个「目录换了」的回执验证「拉到的就是写下的」。
  {
    const fresh = [
      { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 180_000, supportsImages: true },
      { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 180_000, supportsImages: false },
      { id: 'newmodel', name: 'Brand-New', contextWindow: 1_000_000, supportsImages: true },
    ];
    const prevFetch2 = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      fetchCalls.push(`${method} ${url}`);
      if (String(url).includes('/qoder/models/refresh')) {
        return jsonRes({
          ok: true,
          models: method === 'POST' ? fresh : MODELS,
          usingFallback: false,
          lastFetchAtMs: Date.parse('2026-10-11T11:00:00'),
        });
      }
      return jsonRes({ accounts: [] });
    };

    const { scope: rScope, writes: rWrites } = makeWritableScope();
    const p = await mount(rScope);
    const btn = p.view.button('从 Qoder 刷新');
    ok('找得到「从 Qoder 刷新」按钮（与另两家同款；旧名「刷新目录」已换掉）', typeof btn?.onClick === 'function');
    ok('刷新按钮可点（作用域可写）', btn?.disabled === false);
    await btn.onClick();
    const after = await p.render();

    const rWriteOf = (field) => rWrites.find(([f]) => f === field)?.[1];
    ok(
      '刷新把目录里的新模型一起启用（拉取即落盘，无需再点保存）',
      JSON.stringify(rWriteOf('enabledModelIds')) === '["dfmodel","mmodel","newmodel"]',
      JSON.stringify(rWrites),
    );
    ok(
      '刷新按上游 is_vl 写 imageModelIds（新旧两个图片模型都在）',
      JSON.stringify(rWriteOf('imageModelIds')) === '["dfmodel","newmodel"]',
      JSON.stringify(rWrites),
    );
    ok('刷新清空 contextBudgets（用满各自的上游窗口）', JSON.stringify(rWriteOf('contextBudgets')) === '{}');
    ok('一次刷新写三个字段、不重复写', rWrites.length === 3, JSON.stringify(rWrites));
    ok('刷新后给出提示，且说清是全部启用', after.text.includes('已刷新：3 个模型'), after.text.slice(-300));
    ok('刷新后不留保存栏（草稿已丢，页面上没有待保存的改动）', after.saveButton() === undefined);
    ok('刷新后新模型出现在列表里且带 1M 上下文', after.text.includes('Brand-New') && after.text.includes('上下文 1M'));

    // —— 拉取失败：一个字段都不写（兜底目录不能固化成白名单） ——
    const prevFetch3 = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      fetchCalls.push(`${method} ${url}`);
      if (String(url).includes('/qoder/models/refresh')) {
        return jsonRes({
          ok: false,
          error: '上游 502',
          models: MODELS,
          usingFallback: true,
          lastFetchAtMs: null,
        });
      }
      return jsonRes({ accounts: [] });
    };
    const { scope: fScope, writes: fWrites } = makeWritableScope();
    const fp = await mount(fScope);
    await fp.view.button('从 Qoder 刷新').onClick();
    const fAfter = await fp.render();
    ok('拉取失败时不做任何写入（宁可不写也不写兜底表）', fWrites.length === 0, JSON.stringify(fWrites));
    ok('拉取失败时把原因显示出来', fAfter.text.includes('上游 502'), fAfter.text.slice(-400));
    globalThis.fetch = prevFetch3;

    globalThis.fetch = prevFetch2;
  }

  // —— 写不进去：set() resolve 但值没落地 ——
  {
    const { scope: noop, writes: noopWrites } = makeWritableScope(false);
    const p = await mount(noop);
    p.view.model('MiniMax-M2.7').input.onChange({ target: { checked: false } });
    await (await p.render()).saveButton().onClick();
    const after = await p.render();
    // 三个字段是**顺序**写的、每个都读回确认：第一个没落地就抛错，后面两个
    // 根本不会写 —— 这正是「宁可少写也不要写一半」的取舍。
    ok('第一个字段确实尝试写了', noopWrites.length === 1, JSON.stringify(noopWrites));
    ok(
      '写不进去时明确报错（否则就是「保存成功但值自己弹回去」）',
      after.text.includes('未能写入'),
      after.text.slice(-400),
    );
  }

  // —— 全不勾：保存必须被挡住 ——
  {
    const { scope: emptyScope, writes: emptyWrites } = makeWritableScope();
    const p = await mount(emptyScope);
    p.view.model('DeepSeek-Flash').input.onChange({ target: { checked: false } });
    p.view.model('MiniMax-M2.7').input.onChange({ target: { checked: false } });
    const v = await p.render();
    ok('一个模型都不启用时保存按钮禁用（空列表 = provider 没有模型）', v.saveButton()?.disabled === true);
    if (typeof v.saveButton()?.onClick === 'function') await v.saveButton().onClick();
    ok('即使硬点也不会写空白名单', emptyWrites.length === 0, JSON.stringify(emptyWrites));
  }

  globalThis.fetch = prevFetch;
}

/**
 * —— 2a-ter) 「本次调用」这个标签必须贴在**真的被调用的那张卡**上 ——
 * 上面那组只断言「页面上出现过『本次调用』」。这条断言太弱：把标签贴到
 * 「固定使用的账号」上它照样通过，而那恰恰是要修掉的错 —— 固定账号只是
 * 「下一次用谁」，与刚刚真扣了谁的钱是两件事（轮换模式下更是完全无关）。
 *
 * 所以这里必须**按卡片分别取文本**：先找到某账号名所在的那张 `wbc-card`，
 * 再看这张卡里有没有「本次调用」。WorkBuddy 侧同理 —— fixture 里被固定的是
 * u1、最近服务的是 u2，于是首页统计格该显示 u2 的 0 而不是 u1 的 3,080。
 */
{
  // WorkBuddy：固定 u1，但最近服务的是 u2 ⇒ 统计格显示 u2 的余额。
  const divergentWb = {
    ...statusFixture,
    selectedAccountId: 'u1',
    activeAccountId: 'u2',
  };

  let qoderCards = [];
  let wbText = '';
  let err = null;
  try {
    // Qoder 面板：拿真实元素树（`renderPage` 只回文本，这里要按卡片分）。
    const react = makeReact({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' });
    const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
    qoderCards = collectByClass(Page({}), 'wbc-card');
    // 积分页：只取文本就够。
    // 注意展开顺序：`...withData` 自己带 hook 2（statusFixture），放在后面会把
    // `divergentWb` 覆盖掉 —— 那样这条用例就在测旧的 fixture，而且看不出来。
    wbText = renderPage(
      { ...withData, 2: divergentWb, 0: 'wb-credits' },
      {},
      makeEmbedded(),
    );
  } catch (e) {
    err = e;
  }
  ok('按卡片取文本的渲染不抛异常', err === null, err?.message);

  const cardOf = (name) => qoderCards.find((card) => textOfNode(card).includes(name));
  const q1Card = cardOf('qoder-user@example.com');
  const q2Card = cardOf('qoder-backup@example.com');
  ok('Qoder 两张账号卡都在（否则下面的断言等于没测）', q1Card !== undefined && q2Card !== undefined);

  const q1Text = q1Card === undefined ? '' : textOfNode(q1Card);
  const q2Text = q2Card === undefined ? '' : textOfNode(q2Card);
  ok('被调用的那张卡标了「本次调用」', q2Text.includes('本次调用'), q2Text);
  ok('固定但**没有**被调用的那张卡不标「本次调用」', !q1Text.includes('本次调用'), q1Text);
  ok('固定账号仍显示「当前使用」（两个概念都要在）', q1Text.includes('当前使用'), q1Text);
  ok('被调用的账号卡上显示它自己的余额', /420/.test(q2Text), q2Text);
  ok('固定账号的余额不会被别人的数字顶掉', q1Text.includes('300') && !/420/.test(q1Text), q1Text);

  // 积分页：WorkBuddy 的「本次调用账号的额度」读的是 activeAccountId（u2）。
  ok('积分页先答「本次调用账号的额度」', wbText.includes('本次调用账号的额度'), wbText.slice(0, 200));
  ok(
    '积分页显示的是被调用账号（u2）而不是固定账号（u1）的余额',
    wbText.includes('冷却账号 · WorkBuddy 本区域'),
    wbText.slice(0, 400),
  );
  ok('积分页仍给出全池合计作参考', wbText.includes('当前总积分'), '');
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
 * 而删掉好账号。fixture 里 q1 有 300、q3 有 1,200，q2/q4 未知，所以合计是
 * 1,500 且必须标明「2/4 个已知」，**绝不能**把未知那些当 0 之后仍谎称
 * 「全池 4 个都算进来了」。
 */
{
  const text = renderPage({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' });
  ok('合计只累加已知账号（300 + 1,200 = 1,500，非 0）', text.includes('1,500'), '');
  ok('合计标明已知比例（2/4）', text.includes('2/4 个已知'), '');
  // 比例必须就挂在合计数旁边（「全池 1,500（2/4 个已知）」），不能只在别处
  // 出现一个孤零零的 1,500 —— 那样读者无法判断它是几个账号的合计。
  ok(
    '合计与已知比例写在一起',
    /全池\s*1,500（2\/4 个已知）/.test(text),
    text.slice(0, 300),
  );
}

/**
 * —— 2a-quater) 余额只信「被调用的账号」那一份，别处读不到就退回它 ——
 *
 * 面板上每张卡的「余额」读的是账号行自己的 `credits`；但**被调用的那个账号**
 * 的余额是宿主单独为 `serving` 读的（见 lib/index.js），两者可能一方有一方无
 * （例如号池快照刚扫完、`serving` 那次读已经回来）。这时候必须用 `serving.credits`
 * 兜底 —— 否则页面上唯一真正在扣费的账号偏偏显示「读取中…」。
 *
 * 这里把 q2（被调用的那个）的账号行余额清空、只留 `serving.credits = 420`：
 * 显示的必须是 420，而不是「读取中…」也不是 0。
 */
{
  const bareQoder = {
    ...qoderFixture,
    accounts: qoderFixture.accounts.map((a) => (a.id === 'q2' ? { ...a, credits: null } : a)),
  };
  const react = makeReact({ ...withData, 9: traeFixture, 15: bareQoder, 0: 'qoder' });
  const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
  /**
   * **只渲染一次**，文本与卡片都从同一棵树上取。
   *
   * 连续调两次 `Page({})` 是踩过的坑：`makeReact` 的 hook 游标不会自己归零
   * （要显式 `react.reset()`），第二遍从上一遍结束的下标继续取 state，拿到的
   * 全是别的字段 —— 表现为「第二遍渲染出来的东西完全换了一页」，而且不报错。
   * （这个坑当时的具体症状就是「卡片节点一个都收不到」。）
   */
  const tree = Page({});
  const cards = collectByClass(tree, 'wbc-card');
  const text = textOfNode(tree);
  ok('取到了账号卡片（否则下面两条断言等于没测）', cards.length > 0, `cards=${cards.length}`);
  /**
   * 必须**按卡片**取文本，不能拿整页文本判 `!includes('读取中…')`：
   * q4 的余额本来就没读到，整页上「读取中…」是应该出现的（那条降级文案
   * 另有断言覆盖）。拿整页判会把「q4 正常降级」误报成「q2 兜底失败」。
   */
  const cardTextOf = (name) =>
    textOfNode(cards.find((c) => textOfNode(c).includes(name)) ?? null);
  const q2Text = cardTextOf('qu2');
  ok('被调用的账号卡用 serving 的那一份兜底（420）', q2Text.includes('420'), `q2 卡=${q2Text}`);
  ok('被调用的账号卡不再显示「读取中…」', q2Text !== '' && !q2Text.includes('读取中…'), q2Text);
  ok('没读到的账号仍然如实显示「读取中…」（降级没被兜底逻辑吃掉）', text.includes('读取中…'), '');
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
    // Qoder 列没有区域划分（只有 CN），主操作是「添加账号」而非「重新检测」；
    // 「清冷却」三个页面的账号区里都叫「清除冷却」（先前 Qoder 是「重置冷却」）
    [2, ['添加账号', '清除冷却']],
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
  /**
   * **只有两列**有「账号使用方式」：WorkBuddy 与 Trae。
   *
   * Qoder 列曾经也有第三个，但那些按钮（优先/轮换/均衡）会在每次请求上换
   * 账号 —— 用户固定了账号也照换不误，正是「固定了账号，请求还是打到别的号
   * 上」的来源。现在 Qoder 侧只剩「当前账号 + 备用 + 手动切换」，所以这里
   * 断言的是**它不再有**这一区。
   */
  const occurrences = text.split('账号使用方式').length - 1;
  ok('账号页只有 WB / Trae 两列有「账号使用方式」', occurrences === 2, `实际 ${occurrences} 处`);
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
    ok('Qoder 列没有分配策略按钮（该区已删除）', activeLabelOf(cols[2]) === null, `实际高亮: ${activeLabelOf(cols[2])}`);
    /**
     * Qoder 列改断言 Trae 同款的那套：夹具里 q1 是「当前使用」（池的
     * effectiveSelected 落在它身上）、q2 是备用，备用卡上必须有
     * 「切换到此账号」且点它写的是 **qoderSettings**（provider 唯一读的地方），
     * 不是管理页那座 HTTP 路由。
     */
    const qoderOut = [];
    collectText(cols[2], qoderOut);
    const qoderText = qoderOut.join(' ');
    ok('Qoder 列标出「当前使用」', qoderText.includes('当前使用'), '');
    ok('Qoder 列标出「备用」', qoderText.includes('备用'), '');
    ok('Qoder 列有「切换到此账号」', qoderText.includes('切换到此账号'), '');
    ok('Qoder 列不再有「设为当前 / 取消固定」旧按钮', !qoderText.includes('设为当前') && !qoderText.includes('取消固定'), '');
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

    // 「优先模式」只在 WB / Trae 两列里（Qoder 侧的策略按钮已删除），共 2 个，
    // 依次属于这两列（列顺序固定）。
    const priorityButtons = findButtons('优先模式');
    ok('账号页找得到两个「优先模式」按钮（WB / Trae 各一）', priorityButtons.length === 2, `实际 ${priorityButtons.length}`);

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
 * —— 2e-sexies) Qoder 号池的写入路径 = **settings**（本 bug 的修复判据）——
 *
 * 这一组测的是真机那个故障的修复：管理页曾经用 HTTP 路由
 * （`/qoder/pool/select` 等）写「自己的」池实例，而请求路径用的是 provider
 * 入口的另一个池 ——「固定了账号，请求还是打到别的号上」，重启还会丢。
 *
 * 现在与 Trae 半边同一条链：写 `dsh-connect-qoder` 的 settings 字段，provider
 * 在 `loader/volatile-update` 时推给真正服务请求的池。所以这里的断言是
 * **作用域收到了哪个键、什么值**，以及写入后界面是否刷新到新状态。
 *
 * 桩必须维护可变的文档：写入带读回确认（`set()` resolve 了不等于写进去了），
 * 一个只记录不改值的桩会被正确地判为失败 —— 那本身也是下一条用例要测的。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  /**
   * 取数桩**跟着文档走**：`accounts[].selected` 由 `selectedAccountId` 现算，
   * 于是「点切换 → 重读 → 当前使用换人」这条端到端链路真的被测到了，
   * 而不是只测到「函数被调用」。
   */
  const snapshotOf = (doc) => ({
    ...qoderFixture,
    selectedAccountId: doc.selectedAccountId ?? null,
    effectiveSelectedAccountId: doc.selectedAccountId ?? null,
    disabledIds: doc.disabledAccountIds ?? [],
    creditReserves: doc.creditReserves ?? {},
    accounts: qoderFixture.accounts.map((a) => ({
      ...a,
      selected: a.id === (doc.selectedAccountId ?? 'q1'),
      disabled: (doc.disabledAccountIds ?? []).includes(a.id),
      creditReserve: (doc.creditReserves ?? {})[a.id] ?? 0,
      // 停用与冷却都不影响「服务用谁」的判定，这里保持 fixture 原值
    })),
  });
  let doc = { selectedAccountId: 'q1', disabledAccountIds: [], creditReserves: {} };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/qoder/pool')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(snapshotOf(doc)) });
    }
    if (u.includes('/qoder/credits/refresh')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, refreshed: 2, failed: 0, accounts: [] }),
      });
    }
    return new Promise(() => {});
  };
  try {
    const writes = [];
    const scope = makeScope(doc);
    scope.getSnapshot = () => ({ status: 'ready', value: doc, writable: true });
    scope.set = (field, value) => {
      writes.push([field, value]);
      doc = { ...doc, [field]: value };
      return Promise.resolve(true);
    };

    /**
     * ⚠️ **不预置 hook 15（qoderStatus）**。
     *
     * preset 的优先级高于 setState 存下来的值，于是「写入 → 重读快照 → 重渲染」
     * 这条链会被打回静态夹具 —— 断言就永远看不到新状态（下面「写入后当前使用换
     * 人」那条会莫名其妙地失败）。让状态真的来自 fetch，链才跑得通。
     */
    const react = makeReact({ ...withData, 0: 'accounts' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: { wbSettings: makeHandle(makeWbScope({})), traeSettings: makeHandle(makeTraeScope({})), qoderSettings: makeHandle(scope) },
    });
    const textOf = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    textOf(Page({}));
    // 两拍：一拍给 fetch 的 promise 链，一拍给 setState 之后的重渲染
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    /** 取第 colIndex 列（WB / Trae / Qoder 顺序固定） */
    const columnAt = (colIndex, node) => {
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
      return cols[colIndex];
    };
    /**
     * 按标签抓按钮。
     *
     * ⚠️ 必须**限定在某一列/某张卡**里找：`切换到此账号` 是 Trae 与 Qoder
     * 共用的文案（Trae 侧的「切换到此账号」是这次对齐的样板），在全页范围里找
     * 会同时抓到 Trae 列那两个，断言就变成在测别人。
     */
    const buttonIn = (node, label) => {
      let hit = null;
      (function walk(n, d = 0) {
        if (hit !== null || d > 40 || n === null || typeof n !== 'object') return;
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
        if (type === 'button' && props?.children === label) {
          hit = { onClick: props.onClick, disabled: props.disabled === true };
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return hit;
    };
    /**
     * 按文案抓勾选框（CardActions 里的「参与轮换」、分区标题里的「Max 模式」…）。
     *
     * 与 buttonIn 同款限制：必须在某张卡 / 某一列里找，否则三个页面的同名
     * 勾选框会互相串台。控件从「停用 / 启用」按钮换成勾选后，语义没变
     * （都写 disabledAccountIds），变的是要触发的回调（onChange 而不是 onClick）。
     */
    const checkIn = (node, label) => {
      let hit = null;
      (function walk(n, d = 0) {
        if (hit !== null || d > 40 || n === null || typeof n !== 'object') return;
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
        if (type === 'label' && /(^|\s)wbc-check(\s|$)/.test(String(props?.className ?? ''))) {
          const texts = [];
          collectText(props?.children, texts);
          if (texts.join('').trim() === label) {
            // wbc-check 里唯一那个 input 就是勾选框本身
            (function findInput(n2, d2 = 0) {
              if (hit !== null || d2 > 10 || n2 === null || typeof n2 !== 'object') return;
              if (Array.isArray(n2)) {
                for (const c of n2) findInput(c, d2);
                return;
              }
              if (n2.type === 'input') {
                hit = {
                  checked: n2.props?.checked === true,
                  disabled: n2.props?.disabled === true,
                  onChange: n2.props?.onChange,
                };
                return;
              }
              findInput(n2.props?.children, d2 + 1);
            })(props?.children);
            if (hit !== null) return;
          }
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return hit;
    };
    const countButtons = (node, label) => {
      let count = 0;
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
        if (type === 'button' && props?.children === label) count += 1;
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return count;
    };
    /** 按账号名找那张卡（卡片节点是 `wbc-card`） */
    const cardWith = (node, nameSub) => {
      const cards = [];
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
        if (typeof props?.className === 'string' && /(^|\s)wbc-card(\s|$)/.test(props.className)) {
          cards.push(n);
          return;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return cards.find((c) => {
        const out = [];
        collectText(c, out);
        return out.join(' ').includes(nameSub);
      });
    };
    /** 卡片里那个「保留额度」输入框的 onChange */
    const reserveInputIn = (node) => {
      let hit = null;
      (function walk(n, d = 0) {
        if (hit !== null || d > 40 || n === null || typeof n !== 'object') return;
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
        if (type === 'input' && typeof props?.className === 'string' && /wbc-reserve-input/.test(props.className)) {
          hit = props.onChange;
        }
        if (typeof type === 'string') walk(props?.children, d + 1);
      })(node);
      return hit;
    };

    /**
     * Qoder 是第三列（WB / Trae / Qoder）。夹具里 q1 = 当前使用，
     * q2 / q3 = 备用 ——「切换到此账号」只出现在**非当前**的卡片上。
     */
    react.reset();
    let tree = Page({});
    const qoderCol = columnAt(2, tree);
    ok('第三列就是 Qoder 号池', textOf(qoderCol).includes('Qoder 号池'), textOf(qoderCol).slice(0, 120));
    // 夹具里 4 个账号，恰好 1 个是「当前使用」→ 备用卡上共 3 个「切换到此账号」。
    // （Trae 列的按钮文案与这里**同名**，所以必须限定在 Qoder 这一列里数。）
    const spareCount = qoderFixture.accounts.filter((a) => a.id !== 'q1').length;
    ok(
      '每张备用卡上都有一个「切换到此账号」',
      countButtons(qoderCol, '切换到此账号') === spareCount,
      `${countButtons(qoderCol, '切换到此账号')} vs ${spareCount}`,
    );
    ok(
      '当前使用的那张卡没有「切换到此账号」（它已经是当前）',
      cardWith(qoderCol, 'qoder-user@example.com') !== undefined
        && buttonIn(cardWith(qoderCol, 'qoder-user@example.com'), '切换到此账号') === null,
    );

    // ① 点备用卡（q2）上的「切换到此账号」→ 写 selectedAccountId
    const q2Card = cardWith(qoderCol, 'qoder-backup@example.com');
    ok('找得到 q2 那张卡', q2Card !== undefined);
    await buttonIn(q2Card, '切换到此账号').onClick();
    ok(
      '点「切换到此账号」把 selectedAccountId 写进 qoderSettings',
      writes.some(([f, v]) => f === 'selectedAccountId' && v === 'q2'),
      JSON.stringify(writes),
    );
    /**
     * 写完必须**重读快照**：桩的取数跟着文档走，所以这里能真的验证
     * 「当前使用」换到 q2 了 —— 只断言「函数被调用」会漏掉「写进去了但界面
     * 没刷新」这一类。
     */
    react.reset();
    tree = Page({});
    const afterCol = columnAt(2, tree);
    ok(
      '写入后界面刷新：q2 那张卡变成「当前使用」',
      buttonIn(cardWith(afterCol, 'qoder-backup@example.com'), '切换到此账号') === null
        && buttonIn(cardWith(afterCol, 'qoder-user@example.com'), '切换到此账号') !== null,
    );

    // ② 停用 / 启用：写 disabledAccountIds（合并式，不能整段覆盖别人的状态）。
    //    控件是卡里的「参与轮换」勾选框（三个配置页同款），取消勾选 = 停用，
    //    勾上 = 启用 —— 断言的事件因此从 onClick 变成 onChange。
    writes.length = 0;
    doc = { ...doc, disabledAccountIds: ['q3'] };
    react.reset();
    tree = Page({});
    const rotateBox = checkIn(cardWith(columnAt(2, tree), 'qoder-user@example.com'), '参与轮换');
    ok('账号卡里有「参与轮换」勾选框，且默认勾上', rotateBox?.checked === true, JSON.stringify(rotateBox));
    // ⚠️ 不 await onChange 的返回值：勾选框的回调会把写入承诺一路返回上来，而
    // 写入之后的「重读号池」打的是本块没桩的接口（永远 pending），await 它会
    // 把整个用例挂死。写入本身是同步发生的，等一个宏任务就够。
    rotateBox.onChange({ target: { checked: false } });
    await new Promise((r) => setTimeout(r, 0));
    const disabledWrite = writes.find(([f]) => f === 'disabledAccountIds');
    ok(
      '取消「参与轮换」写 disabledAccountIds 且保留已有条目',
      Array.isArray(disabledWrite?.[1]) && disabledWrite[1].includes('q1') && disabledWrite[1].includes('q3'),
      JSON.stringify(disabledWrite ?? null),
    );

    writes.length = 0;
    doc = { ...doc, disabledAccountIds: ['q1', 'q3'] };
    react.reset();
    tree = Page({});
    const rotateBox2 = checkIn(cardWith(columnAt(2, tree), 'qoder-user@example.com'), '参与轮换');
    ok('已停用的账号勾选框是未勾上的', rotateBox2?.checked === false, JSON.stringify(rotateBox2));
    rotateBox2.onChange({ target: { checked: true } });
    await new Promise((r) => setTimeout(r, 0));
    const enableWrite = writes.find(([f]) => f === 'disabledAccountIds');
    ok(
      '重新勾上「参与轮换」从 disabledAccountIds 里摘掉它',
      Array.isArray(enableWrite?.[1]) && !enableWrite[1].includes('q1') && enableWrite[1].includes('q3'),
      JSON.stringify(enableWrite ?? null),
    );

    // ③ 保留额度：草稿 → creditReserves
    writes.length = 0;
    doc = { ...doc, disabledAccountIds: [], creditReserves: {} };
    react.reset();
    tree = Page({});
    reserveInputIn(cardWith(columnAt(2, tree), 'qoder-backup@example.com'))({ target: { value: '120' } });
    react.reset();
    tree = Page({});
    await buttonIn(cardWith(columnAt(2, tree), 'qoder-backup@example.com'), '保存').onClick();
    const reserveWrite = writes.find(([f]) => f === 'creditReserves');
    ok(
      '点「保存」把保留额度写进 creditReserves',
      reserveWrite !== undefined && reserveWrite[1]?.q2 === 120,
      JSON.stringify(reserveWrite ?? null),
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2e-septies) 宿主「假装写入成功」时 Qoder 侧必须报错 ——
 *
 * 与 Trae 侧同一个坑：`set()` resolve 了 true，文档却没变。没有读回确认，
 * 用户看到的就是「点了切换但没反应」——而那正是这个 bug 当初难以定位的原因。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/qoder/pool')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(qoderFixture) });
    }
    return new Promise(() => {});
  };
  try {
    const stuckDoc = { selectedAccountId: 'q1' };
    const stuck = makeScope(stuckDoc);
    stuck.getSnapshot = () => ({ status: 'ready', value: stuckDoc, writable: true });
    stuck.set = () => Promise.resolve(true); // 假装成功，值不动

    const react = makeReact({ ...withData, 15: qoderFixture, 0: 'accounts' }, true);
    const Page = createConsoleSection({
      react,
      jsxRuntime: makeJsxRuntime(),
      embedded: { wbSettings: makeHandle(makeWbScope({})), traeSettings: makeHandle(makeTraeScope({})), qoderSettings: makeHandle(stuck) },
    });
    const textOf = (node) => {
      const out = [];
      collectText(node, out);
      return out.join(' | ');
    };
    textOf(Page({}));
    await new Promise((r) => setTimeout(r, 0));
    react.reset();
    const tree = Page({});
    /**
     * ⚠️ 必须**限定在 Qoder 那一列**里找：`切换到此账号` 是 Trae 与 Qoder
     * 共用的文案，Trae 列在前，全页搜索会抓到 Trae 的按钮 —— 那样测的是 Trae
     * 的读回确认，而 Qoder 侧报不报错完全没被覆盖。
     */
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
      if (type === 'button' && props?.children === '切换到此账号') handler = props.onClick;
      if (typeof type === 'string') walk(props?.children, d + 1);
    })(cols[2]);
    ok('在 Qoder 列里找到了「切换到此账号」', handler !== null);
    await handler();
    react.reset();
    const joined = textOf(Page({}));
    ok(
      '宿主假装写入成功时 Qoder 侧报错（读回确认生效）',
      joined.includes('保存失败') && joined.includes('未能写入'),
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
    '账号',                  // 号池区（三个配置页都叫「账号」）
    '优先模式',
    '轮换模式',
    '均衡模式',
    '清除冷却',
    'trae-backup@example.com', // 号池账号卡
    '冷却中',
    '冷却至',                // 冷却中的卡带「冷却至」行
    '限流 2 次',             // 限流次数 = 标签（与另两页同款），不是一行「触发限流 0 次」
    '当前使用',              // 首标签：固定的那张亮着
    '备用',
    '不限',                  // t1 没设保留额度 → 那一行写「不限」
  ]) {
    ok(`Trae 配置页渲染出「${must}」`, text.includes(must), text.slice(0, 200));
  }
  ok(
    'Trae 页不再出现「触发限流」行',
    text.includes('触发限流') === false,
    text.slice(0, 200),
  );
})();

/**
 * —— 2f-2) 三个配置页的骨架与页头按钮必须一致 ——
 *
 * 三页统一成同一套骨架（页头 → 四格统计 → 「账号」区 → 「模型」区收尾），
 * 这里守两条最容易悄悄走样的：
 *
 *   1. **页头按钮文案不随状态变**。早先三页分别会变成「刷新中…」「读取中…」
 *      「登录中…」，同一排按钮在三页里像三件事；状态交给禁用态与「正在读取…」
 *      说明行表达。
 *   2. **分配策略与「清除冷却」不因号池快照为空而消失**。Trae 侧曾经把整排
 *      按钮绑在「号池里有账号」上，于是快照没读回来时主要功能整排不见了。
 *
 * 反向验证过：把 Trae 的 actions 改回 `poolAccounts.length === 0 ? [] : [...]`
 * → 第 2 条断言失败；把 label 改回三元表达式 → 第 1 条断言失败。
 */
{
  // 1) 加载中（fetch 永挂）时三页的页头按钮都还是「刷新」
  for (const tab of ['pool-config', 'trae-config', 'qoder']) {
    const text = renderPage({ 0: tab });
    ok(`${tab} 加载中页头按钮仍是「刷新」`, text.includes('刷新'), text.slice(0, 160));
    ok(
      `${tab} 加载中不出现会变的按钮文案`,
      !text.includes('刷新中…') && !text.includes('读取中…'),
      text.slice(0, 160),
    );
  }
}

/**
 * —— 2f-3) 号池快照里没有账号时，分配策略与「清除冷却」仍然在 ——
 *
 * 与 2f 同样走 fetch 桩（不预置 hook 下标，理由见 2f 的注释）。这里刻意让
 * `pool` 里**没有 accounts**：早先 Trae 侧把整排按钮绑在「号池里有账号」上，
 * 于是快照还没读回来时主要功能整排消失，而 2f 的 fixture 恰好有账号、
 * 断言照样通过 —— 这一组才守得住那个分支。
 */
await (async () => {
  const traeUsage = {
    status: 'signed-in',
    accountName: 'trae-user@example.com',
    accounts: [{ id: 't1', accountName: 'trae-user@example.com', selected: true, edition: 'cn' }],
    models: [{ id: 'm1', name: 'DeepSeek-V4-Flash', contextWindow: 2e5 }],
    enabledModelIds: ['m1'],
    credits: { generalAvailable: 1200, workAvailable: 340 },
    // 只有分配策略，没有账号列表（号池快照未就绪时的形状）
    pool: { distribution: 'balanced' },
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (url) =>
    typeof url === 'string' && url.includes('/plugins/dsh-connect-trae/usage')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(traeUsage) })
      : new Promise(() => {});
  let text = '';
  let err = null;
  try {
    const react = makeReact({ 0: 'trae-config' }, true);
    const Page = createConsoleSection({ react, jsxRuntime: makeJsxRuntime(), embedded: makeEmbedded() });
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
  ok('号池快照为空时 Trae 页仍渲染', err === null && text.includes('trae-user@example.com'), err?.message);
  for (const must of ['优先模式', '轮换模式', '均衡模式', '清除冷却']) {
    ok(`号池快照为空时 Trae 账号区仍有「${must}」`, text.includes(must), text.slice(0, 240));
  }
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
    '账号',                  // 分配策略区（三个配置页都叫「账号」）
    '优先模式',
    '轮换模式',
    '均衡模式',
    '清除冷却',
    '池内主号',              // 账号卡
    '冷却备用号',
    '冷却中',
    '备用',                  // 首标签与另两页同款（fixture 没给 activeAccountId）
    '限流 3 次',             // 限流次数做成标签（与 Qoder 页同款）
    '参与轮换',              // 账号启停（与另两页同款勾选）
    '保留额度',              // 保留额度输入 + 行
    '不限',                  // 没设保留额度时那一行写「不限」，不是整行消失
    '移出池子',
    '已移出账号池',          // ignored 区
    '已移出号',
    '恢复',
    '积分自动化',            // CN only 自动化
    '立即运行',
    '每日签到',              // 任务表（五件事仍然逐条列出，一行一件）
    '活跃上报',
    '任务奖励',
    '连登奖励',
    '猫猫旅行',
    '09:00 / 21:00',         // 第二列：当天计划时间（旅行 9 点与 21 点各一次）
    '还没跑过',              // 第三列：fixture 里 travel 没有运行记录
    'DeepSeek-V4-Flash',     // 模型目录
    'GLM-5.2',
    'Max 模式',
    '一键启用所有模型',
    '保存',
    '已启用 1 / 2 个',       // 勾选计数（与 Trae / Qoder 页同款文案）
    '自动轮换',              // 第四格「当前使用」（fixture 没固定账号）
    '从 WorkBuddy 刷新',     // 目录刷新（拉取即落盘）
  ]) {
    ok(`XD Pool 配置页渲染出「${must}」`, text.includes(must), text.slice(0, 200));
  }
  ok('CN 区域渲染出积分自动化区块', text.includes('积分自动化'));
})();

/**
 * —— 2g-2c) 三个配置页的账号卡：标签词汇、压暗规则、余额读法逐字同款 ——
 *
 * 「同一件事在三页里三种叫法」是本插件最容易复发的一类走样，而且**整页文本断言
 * 抓不到**（词当然出现过，贴错卡片照样通过）。这里按卡片取文本，逐条守住三件事：
 *
 *   1. **首标签**：只有「当前使用 / 备用」两种词。WorkBuddy 侧曾经用「正常」，
 *      于是同一个事实（这张卡在服务）在三页里有两个名字。
 *   2. **压暗规则**：当前使用的那张亮着，其余压暗；不知道是谁时不压暗任何卡
 *      （「不知道」≠「都不是它」）。
 *   3. **余额读法**：`/status` 里的 `credits` 是**对象**（`{total, packages…}`，
 *      上游原样透传），不是数字。曾经这里直接 `fmtNum(a.credits)`，于是真机上
 *      一直显示「通用余额 –」，而 1031 就在响应体里。夹具也用真实形状，否则
 *      这个 bug 会一直待在测试的盲区里。
 *
 * 另外守住「限流次数是标签」：曾经是常驻的「触发限流 0 次」行，三页两种写法。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  // 有「当前账号」的池快照：u1 在服务（亮着、标当前使用），u2 冷却 + 停用 + 限流过。
  // `ignored` 清空：这一块只数「账号」区的卡。
  const currentPool = { ...poolStatusFixture, activeAccountId: 'u1', ignored: [] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(currentPool) });
    }
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(traeFixture) });
    }
    return new Promise(() => {});
  };
  try {
    /** 取一页的元素树（数据靠预设 hook 或 fetch 注入，与各页自己的用例一致） */
    const treeOf = async (preset, runEffects) => {
      const react = makeReact(preset, runEffects);
      const Page = createConsoleSection({
        react,
        jsxRuntime: makeJsxRuntime(),
        embedded: makeEmbedded(),
      });
      if (runEffects === true) {
        // 要遍历一次才会执行子组件、发出请求；之后 reset 再渲染才是「拿到数据」的那一帧
        collectText(Page({}), []);
        await new Promise((r) => setTimeout(r, 0));
        react.reset();
      }
      return Page({});
    };

    const pages = [
      ['XD Pool', await treeOf({ 0: 'pool-config' }, true)],
      ['Trae', await treeOf({ 0: 'trae-config' }, true)],
      // Qoder 的数据直接由 hook 15 注入；**不跑副作用** —— 页内自带 30 秒自动
      // 刷新定时器，为了这一块断言留一个活 timer 会拖着测试进程不退。
      ['Qoder', await treeOf({ ...withData, 9: traeFixture, 15: qoderFixture, 0: 'qoder' }, false)],
    ];

    const byLabel = {};
    for (const [label, tree] of pages) {
      const cards = collectByClass(tree, 'wbc-card');
      const texts = cards.map((c) => textOfNode(c));
      const dimmed = cards.map((c) =>
        String(c.props?.className ?? '')
          .split(/\s+/)
          .includes('wbc-card-off'),
      );
      byLabel[label] = { texts, pageText: textOfNode(tree) };
      ok(`${label} 配置页渲染出至少两张账号卡`, cards.length >= 2, `cards=${cards.length}`);
      if (cards.length < 2) continue;
      ok(
        `${label} 首标签只用「当前使用 / 备用」`,
        texts.every((t) => t.includes('当前使用') || t.includes('备用')),
        texts.join(' || '),
      );
      ok(
        `${label} 恰好一张卡标「当前使用」`,
        texts.filter((t) => t.includes('当前使用')).length === 1,
        texts.join(' || '),
      );
      ok(
        `${label} 当前使用的那张亮着、其余压暗`,
        dimmed[0] === false && dimmed.slice(1).every((d) => d === true),
        `dimmed=${JSON.stringify(dimmed)}`,
      );
      ok(`${label} 不再出现「正常」这种标签`, texts.every((t) => t.includes('正常') === false), texts.join(' || '));
      ok(
        `${label} 限流次数是标签而不是常驻的「触发限流」行`,
        texts.every((t) => t.includes('触发限流') === false),
        texts.join(' || '),
      );
    }

    const pool = byLabel['XD Pool'];
    const u1Card = pool.texts[0];
    const u2Card = pool.texts[1];
    ok(
      'XD Pool 账号卡读得出 credits.total（对象形态）',
      u1Card.includes('通用余额') && u1Card.includes('3,080'),
      u1Card,
    );
    ok('XD Pool 账号卡不把对象渲染成「–」', u1Card.includes('通用余额 –') === false, u1Card);
    ok('XD Pool 冷却账号卡带「限流 3 次」标签', u2Card.includes('限流 3 次'), u2Card);
    ok('XD Pool 没设保留额度时写「不限」', u1Card.includes('不限'), u1Card);
    ok('XD Pool 整页不再渲染「触发限流」', pool.pageText.includes('触发限流') === false, pool.pageText.slice(0, 200));

    const trae = byLabel['Trae'];
    ok(
      'Trae 配置页的账号卡也读得出限流次数与「不限」',
      trae.texts[1].includes('限流 2 次') && trae.texts[0].includes('不限'),
      `${trae.texts[0]} || ${trae.texts[1]}`,
    );
    ok(
      'Trae 配置页整页不再渲染「触发限流」',
      trae.pageText.includes('触发限流') === false,
      trae.pageText.slice(0, 200),
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
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
    ok('国际版仍渲染账号区', text.includes('账号'));
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
 * —— 2g-3c) XD Pool「切换到此账号 / 取消固定」：真点一次，断言请求打对了地方 ——
 *
 * 这一页先前**没有**切换账号的入口：页面顶部写着「当前使用：xxx 已固定，优先用它」，
 * 但想换人只能绕到「账号」页左列去点 —— 同一个池子的两个界面，能力不一样。
 * 补齐之后盯三件事（都属于「按钮画出来了但点下去写错地方」这类不会让别的测试变红的退化）：
 *
 *   1. 每张**非当前**的卡都有「切换到此账号」，**当前使用的那张没有** —— 与另两页
 *      同一条规矩（Trae / Qoder 的当前卡下面什么都不摆）。先前这里也给当前卡，理由
 *      是「在服务 ≠ 已固定，想钉住它得有地方点」；但三页里两张样子就是不一致，而
 *      真要钉住正在服务的那个，「账号」页左列每张卡都有「设为当前」；
 *   2. 已固定的那张换成「取消固定」（与「账号」页同一个词），固定之后仍有一条
 *      退回号池轮换的路（Trae / Qoder 的池没有这条路，所以那两页不给这个按钮）；
 *   3. 点下去真的 `POST …/accounts/select?region=…`，body 是 `{accountId}`；
 *      取消固定发 `{accountId: null}`；写完重新拉一次状态（否则界面不会变）。
 *
 * 区域参数是这里最容易写错、又最难发现的一处：写错区域不报错，只会把「固定」落进
 * 另一个区域的池子，界面上看就是点了没反应。所以连国际版一起断言。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  const posts = [];
  let statusCalls = 0;
  let pool = poolStatusFixture;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-workbuddy-xdpool/status')) {
      statusCalls += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(pool) });
    }
    if (u.includes('/accounts/select')) {
      posts.push({ url: u, body: init?.body });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return new Promise(() => {});
  };
  try {
    /** 渲染一页；`preset` 用来把 region 预置成国际版（region 是 hook 1） */
    const render = async (fixture, preset) => {
      pool = fixture;
      const react = makeReact({ 0: 'pool-config', ...(preset ?? {}) }, true);
      const Page = createConsoleSection({
        react,
        jsxRuntime: makeJsxRuntime(),
        embedded: makeEmbedded(),
      });
      collectText(Page({}), []);
      await new Promise((r) => setTimeout(r, 0));
      react.reset();
      return Page({});
    };
    /** 按渲染顺序收集按钮文案匹配的 onClick（同一文案可能出现在多张卡上） */
    const buttonsOf = (tree, label) =>
      collectButtons(tree, label)
        .map((b) => b.onClick)
        .filter((f) => typeof f === 'function');

    // ① 没固定任何账号（真机默认状态：selectedAccountId 为 null，但 u1 正在服务）
    const unpinned = await render({
      ...poolStatusFixture,
      selectedAccountId: null,
      activeAccountId: 'u1',
      ignored: [],
    });
    const cardsA = collectByClass(unpinned, 'wbc-card').map((c) => textOfNode(c));
    ok(
      'XD Pool 没固定账号时只有非当前的那张给「切换到此账号」',
      cardsA.length === 2 && cardsA.filter((t) => t.includes('切换到此账号')).length === 1,
      cardsA.join(' || '),
    );
    ok('XD Pool 没固定账号时不出现「取消固定」', textOfNode(unpinned).includes('取消固定') === false);
    ok(
      '当前使用的那张卡不给「切换到此账号」（与另两页同一条规矩）',
      cardsA[0].includes('当前使用') === true && cardsA[0].includes('切换到此账号') === false,
      cardsA[0],
    );
    ok(
      '当前使用的那张仍留着「签到领取」（签到是按账号的，不该跟着切换按钮一起消失）',
      cardsA[0].includes('签到领取') === true,
      cardsA[0],
    );
    const switches = buttonsOf(unpinned, '切换到此账号');
    ok(
      '「切换到此账号」拿得到 onClick',
      switches.length === 1 && typeof switches[0] === 'function',
      `n=${switches.length}`,
    );
    const beforeCalls = statusCalls;
    await switches[0](); // 唯一那颗在备用号 u2 的卡上
    ok(
      '点「切换到此账号」POST 到 /accounts/select',
      posts.length === 1 && posts[0].url.includes('/plugins/dsh-workbuddy-xdpool/accounts/select'),
      JSON.stringify(posts),
    );
    ok('切换请求带上本区域 region=cn', posts[0]?.url.includes('region=cn') === true, posts[0]?.url);
    ok(
      '切换请求的 body 是 {"accountId":"u2"}',
      posts[0]?.body === JSON.stringify({ accountId: 'u2' }),
      String(posts[0]?.body),
    );
    ok('切换成功后重新拉了池状态', statusCalls > beforeCalls, `${beforeCalls} → ${statusCalls}`);

    // ② u1 已固定：那张换成「取消固定」，另一张照旧
    const pinned = await render({
      ...poolStatusFixture,
      selectedAccountId: 'u1',
      activeAccountId: 'u1',
      ignored: [],
    });
    const cardsB = collectByClass(pinned, 'wbc-card').map((c) => textOfNode(c));
    ok('已固定的那张卡给「取消固定」', cardsB[0].includes('取消固定') === true, cardsB[0]);
    ok('已固定的那张不再给「切换到此账号」', cardsB[0].includes('切换到此账号') === false, cardsB[0]);
    ok(
      '未固定的那张仍是「切换到此账号」',
      cardsB[1].includes('切换到此账号') === true && cardsB[1].includes('取消固定') === false,
      cardsB[1],
    );
    const unpin = buttonsOf(pinned, '取消固定');
    ok('「取消固定」拿得到 onClick', unpin.length === 1 && typeof unpin[0] === 'function');
    posts.length = 0;
    await unpin[0]();
    ok(
      '取消固定发 {"accountId":null}（服务端把 null 当清除）',
      posts.length === 1 && posts[0].body === JSON.stringify({ accountId: null }),
      String(posts[0]?.body),
    );

    // ③ 国际版：区域参数必须跟着走，否则「固定」会落进另一个池子
    const globalPage = await render(
      { ...poolStatusFixture, selectedAccountId: null, activeAccountId: 'u1', ignored: [] },
      { 1: 'global' },
    );
    const globalSwitches = buttonsOf(globalPage, '切换到此账号');
    ok('国际版也渲染出「切换到此账号」', globalSwitches.length === 1, `n=${globalSwitches.length}`);
    posts.length = 0;
    await globalSwitches[0]();
    ok(
      '国际版的切换请求带 region=global',
      posts[0]?.url.includes('region=global') === true && posts[0]?.url.includes('region=cn') === false,
      posts[0]?.url,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
})();

/**
 * —— 2g-3d) Trae 配置页的「签到」：只长在当前绑定那张卡上，且真打签到路由 ——
 *
 * Trae 的签到是**按区域**结算当前绑定账号的（`POST /checkin?region=…` → 上游
 * `checkin_credits/claim`），没有「给任意账号签到」这个参数。所以这一页与「账号」页
 * 右列同款：只有当前那张卡给按钮 —— 备用卡上摆一颗点不动的签到按钮比不给更糟。
 *
 * 三条断言各守一处退化：
 *   1. 按钮长错卡（长到备用卡上）—— 点下去会悄悄给**另一个账号**签到；
 *   2. `region` 写错（最典型的是写死一个区域）—— 签到落到另一个区域，界面看就是
 *      点了没反应。这里不去点列头切区域（那要按游标手工展开，读到的还是上一拍），
 *      改为钉住「签到与取数同源」这条不变量；
 *   3. 签完不重新拉 usage —— 余额与「今日已签到」停在旧值，用户以为没生效。
 *
 * 另外钉住按钮上的说明文案：卡片只有三行，「今天签没签」放在原生 `title` 里，
 * 状态词与「账号」页右列的列头副标题同一套。
 *
 * 断言**只在 collectByClass 拿到的卡片子树里找按钮**，不要在整页树上再走一遍：
 * 配置页每次重新展开都会跑一次 `useEffect`，而那一次 `loadUsage` 会同步把
 * `usageLoading` 置回 true，于是「再展开一次整页」拿到的是加载态（内容成片为
 * null），按钮全都不见了 —— 卡片子树已经是展开好的实节点，不受这一拍影响。
 */
await (async () => {
  const prevFetch = globalThis.fetch;
  const posts = [];
  const usageUrls = [];
  let fixture = traeFixture;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.includes('/plugins/dsh-connect-trae/usage')) {
      usageUrls.push(u);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fixture) });
    }
    if (u.includes('/plugins/dsh-connect-trae/checkin')) {
      posts.push({ url: u, method: init?.method });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    return new Promise(() => {});
  };
  try {
    /**
     * 挂载一页，并给出「再渲染一遍」的口子（同一棵 hook store）。
     *
     * 换上游回执要**重新挂载**而不是原地改状态再展开：这一层的手工展开会把 hook
     * 游标错位，第二次展开读到的还是上一拍的 usage。
     */
    const mount = async () => {
      const react = makeReact({ 0: 'trae-config' }, true);
      const Page = createConsoleSection({
        react,
        jsxRuntime: makeJsxRuntime(),
        embedded: makeEmbedded(),
      });
      collectText(Page({}), []);
      await new Promise((r) => setTimeout(r, 0));
      return () => {
        react.reset();
        return Page({});
      };
    };
    /** 卡片子树里的按钮文案 + 第 i 张卡上的「签到」按钮 */
    const cardsOf = (tree) => {
      const nodes = collectByClass(tree, 'wbc-card');
      return {
        nodes,
        texts: nodes.map((c) => textOfNode(c)),
        labels: nodes.map((c) => collectButtons(c).map((b) => b.label)),
        checkin: (i) => collectButtons(nodes[i], '签到')[0],
      };
    };

    const rerender = await mount();
    const page = rerender();
    const cards = cardsOf(page);
    ok(
      'Trae 配置页两张卡都渲染出来了',
      cards.nodes.length === 2,
      `n=${cards.nodes.length} ${cards.texts.join(' || ')}`,
    );
    ok(
      '「签到」只长在当前绑定那张卡上（cards[0]），备用卡上没有',
      cards.labels[0]?.includes('签到') === true &&
        cards.labels[1]?.includes('签到') === false &&
        cards.labels[1]?.includes('切换到此账号') === true,
      JSON.stringify(cards.labels),
    );
    const checkin = cards.checkin(0);
    ok('「签到」按钮拿得到 onClick', typeof checkin?.onClick === 'function');
    ok(
      '「签到」按钮的说明是「今日已签到 · 已领 +50」（与账号页同款词）',
      checkin?.title === '今日已签到 · 已领 +50',
      String(checkin?.title),
    );
    ok('「签到」可点（有签到活动且没在忙）', checkin?.disabled === false);

    const beforeUsage = usageUrls.length;
    posts.length = 0;
    await checkin.onClick();
    ok(
      '点「签到」POST 到 /plugins/dsh-connect-trae/checkin',
      posts.length === 1 && posts[0].url.includes('/plugins/dsh-connect-trae/checkin'),
      JSON.stringify(posts),
    );
    ok('签到请求用的是 POST', posts[0]?.method === 'POST', String(posts[0]?.method));
    ok('签到请求带上本区域 region=cn', posts[0]?.url.includes('region=cn') === true, posts[0]?.url);
    ok(
      '签到成功后重新拉了 usage',
      usageUrls.length > beforeUsage && usageUrls.at(-1).includes('region=cn'),
      `${beforeUsage} → ${usageUrls.length} ${usageUrls.at(-1)}`,
    );

    // 没有签到活动时：换一份上游回执**重新挂载**再取卡。
    //
    // 不在这棵树上改状态再展开：这一层的手工展开会把 hook 游标错位，第二次展开
    // 拿到的还是上一拍的 usage（先前这里就是这么写的，断言读到的是旧回执而变红）。
    fixture = { ...traeFixture, checkin: { checkedIn: false, enabled: false } };
    const off = cardsOf((await mount())()).checkin(0);
    ok('没有签到活动时按钮仍在（而不是凭空消失）', off !== undefined);
    ok('没有签到活动时按钮按不动', off?.disabled === true);
    ok(
      '没有签到活动时说明写的是「这边没有签到活动」',
      off?.title === '这边没有签到活动',
      String(off?.title),
    );

    // 区域参数：签到用的必须是**同一拍取数用的那个区域**。
    //
    // 这里刻意不去点列头切国际版：Trae 配置页自己持有一份 region 状态（不像
    // XD Pool 页的 region 来自父组件），而这一层的手工展开会按游标错位读 hook 槽 ——
    // 点完再展开拿到的其实还是上一拍的区域，断言就成了自我安慰（先前那版就是这么
    // 写的，绿着但什么也没verify）。改成钉住「两边同源」这条不变量：签到打错区域
    // 最典型的原因就是 URL 里写死了区域，那样取数走 ai、签到走 cn，这条会红。
    const regionOf = (u) => String(u).match(/region=([a-z]+)/)?.[1];
    const lastUsage = usageUrls.at(-1);
    ok(
      '签到与取数用的是同一个 region（写死区域的退化会在这里红）',
      regionOf(posts[0]?.url) !== undefined && regionOf(posts[0]?.url) === regionOf(lastUsage),
      `checkin=${posts[0]?.url} usage=${lastUsage}`,
    );
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
      // ⚠️ 认主按钮（wbc-btn-primary），不是认文字：账号卡里每个账号都有一个
      // 「保存」（写保留额度），按文字抓会抓到卡里那个，点下去写的是别的字段
      // 而且那条写入之后的刷新在本块没有桩，await 会把用例挂死。
      if (
        typeof type === 'string' &&
        type === 'button' &&
        props?.children === '保存' &&
        String(props?.className ?? '').split(/\s+/).includes('wbc-btn-primary')
      ) {
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
    ok('一个模型都没启用时显示「已启用 0 / 2 个」', text.includes('已启用 0 / 2 个'), text.slice(0, 200));
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

// 本插件的五个 provider 都要认出来，并渲染出胶囊节点
//
// 预置 state[0]（useCurrentModel 的 current）而不是靠 effect 跑出来：
// 本文件的 react 桩里 setState 只改 hook 槽位、不会触发重渲染，所以
// 「effect 里 setState」在同一次调用里看不出来。既有用例同样用 preset。
for (const provider of ['workbuddy-xdpool', 'workbuddy-xdpool-global', 'trae', 'trae-global', 'qoder']) {
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

// 真取到额度后要显示**被调用账号**的数字（走 fetch 桩 + 点击强制刷新绕开模块级缓存）
//
// 这一条是本文件里最要紧的断言之一：曾经这里断言的是「所有账号之和」
// （1234 + 66 = 1300），而那正是要修掉的 bug —— 池子里有 3 个账号时，
// 「合计」是一个谁也对不上的数字，用户想知道的是「这一轮扣了谁、它还剩多少」。
// 所以现在断言：账号名出现、**被调用账号**的数字出现、别人的数字**不**出现。
{
  const prevFetch = globalThis.fetch;
  // 形态照抄真实的 `/plugins/dsh-workbuddy-xdpool/status`：`activeAccountId`
  // 是 vendored 池用 lastServedId 兜底后的「最近服务的账号」。
  const statusBody = {
    ok: true,
    selectedAccountId: null,
    activeAccountId: 'b',
    accounts: [
      { id: 'a', nickname: '1412', credits: { total: 1234 } },
      { id: 'b', nickname: '111', credits: { total: 66 } },
    ],
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => statusBody });
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
  ok('取到额度后显示被调用账号的数字', err === null && text.includes('66'), text);
  ok('胶囊上带出被调用账号的名字', text.includes('111'), text);
  ok('不再显示全池合计（那与被调用账号无关）', !text.includes('1,300') && !text.includes('1,234'), text);
  const title = String(node?.props?.title ?? '');
  ok('title 说明这个数字是谁的', title.includes('111') && title.includes('66'), title);
  ok('title 里全池合计只作参考值', title.includes('1,300'), title);
  globalThis.fetch = prevFetch;
}

// 池里只有一个账号：没有任何 serving 标记也必须显示它的余额（唯一解，无歧义）
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, accounts: [{ id: 'solo', nickname: '唯一号', credits: { total: 88 } }] }),
  });
  const store = makeModelStore('workbuddy-xdpool');
  const react = makeReact({ 0: { provider: 'workbuddy-xdpool', model: 'm' } }, false);
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
  const text = out.join('');
  ok('单账号池显示该账号余额', err === null && text.includes('88') && text.includes('唯一号'), text);
  globalThis.fetch = prevFetch;
}

// 多账号池但没有任何 serving 线索：显示「–」而不是把别人的数字当成自己的
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      accounts: [
        { id: 'a', nickname: '甲', credits: { total: 100 } },
        { id: 'b', nickname: '乙', credits: { total: 200 } },
      ],
    }),
  });
  const store = makeModelStore('workbuddy-xdpool-global');
  const react = makeReact({ 0: { provider: 'workbuddy-xdpool-global', model: 'm' } }, false);
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
  const text = out.join('');
  ok(
    '分辨不出被调用账号时给占位而不是猜一个',
    err === null && text.includes('积分 –') && !text.includes('300') && !text.includes('100') && !text.includes('200'),
    text,
  );
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

// Trae：显示的是 `pool.lastServedId` 那个账号的余额，**不是**区域合计
//
// 区域合计（`credits.generalAvailable + workAvailable` = 525）曾经就是这个胶囊上
// 的数字，而它与「这一轮扣了谁」完全无关。现在它只能出现在 title 里当参考值。
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      credits: { generalAvailable: 500, workAvailable: 25 },
      pool: { lastServedId: 'acct-2' },
      accounts: [
        { id: 'acct-1', label: '用户9773022806', credits: { total: 4500 } },
        { id: 'acct-2', label: '1412', credits: { total: 2950 } },
      ],
    }),
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
  const text = out.join('');
  ok('Trae 显示被调用账号的余额', err === null && text.includes('2,950') && text.includes('1412'), text);
  ok('Trae 不再显示区域合计', !text.includes('525'), text);
  ok('Trae 的 title 仍带上区域合计作参考', String(node?.props?.title ?? '').includes('525'), String(node?.props?.title ?? ''));
  globalThis.fetch = prevFetch;
}

// Qoder：胶囊必须认这个 provider，并显示宿主算好的 `serving` 账号余额
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      selectedAccountId: null,
      lastServedId: 'q2',
      serving: { accountId: 'q2', label: '01a0aab2-5f31-4c8d-9e2a-7f0b1c2d3e4f', source: 'served', credits: 420 },
      accounts: [
        { id: 'q1', label: '01a0c90b-1111-2222-3333-444455556666', credits: 9000 },
        { id: 'q2', label: '01a0aab2-5f31-4c8d-9e2a-7f0b1c2d3e4f', credits: 420 },
      ],
    }),
  });
  const store = makeModelStore('qoder');
  const react = makeReact({ 0: { provider: 'qoder', model: 'm' } }, false);
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
  const text = out.join('');
  ok('provider=qoder 渲染胶囊', err === null && String(node?.props?.className ?? '').includes('wotr-credit-pill'), err?.message);
  ok('Qoder 显示被调用账号的余额', text.includes('420'), text);
  ok('Qoder 不显示全池合计', !text.includes('9,000') && !text.includes('9,420'), text);
  // 账号名是整条 UUID —— 必须缩短，否则会把 composer 那一行撑开。
  ok('Qoder 的 UUID 账号名被缩短', text.includes('01a0aab2…') && !text.includes('01a0aab2-5f31'), text);
  globalThis.fetch = prevFetch;
}

// Qoder：宿主读不到余额（`credits: null`）时显示占位 + 原因，绝不显示 0
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      serving: { accountId: 'q1', label: '01a0c90b-1111', source: 'served', credits: null, error: '额度查询失败（HTTP 401）' },
      accounts: [{ id: 'q1', label: '01a0c90b-1111', credits: null }],
    }),
  });
  const store = makeModelStore('qoder');
  const react = makeReact({ 0: { provider: 'qoder', model: 'm' } }, false);
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
  const text = out.join('');
  const title = String(node?.props?.title ?? '');
  ok('Qoder 读不到余额时显示占位而不是 0', err === null && text.includes('积分 –') && !text.includes('积分 0'), text);
  ok('Qoder 把读失败原因写进 title', title.includes('401'), title);
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

      /** 在元素树里找 wbc-card，看它子树里有没有「参与轮换 / 保留额度」控件 */
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
          // 卡内找「参与轮换」（启停勾选框，三个页面同款）或「移出池子」
          // （WorkBuddy / Qoder 侧有、Trae 侧没有）。控件进卡 = 走了
          // AccountCard 的 extra 插槽，而不是卡片外面另起一段。
          const texts = [];
          collectText(props?.children, texts);
          const joined = texts.join('');
          return joined.includes('参与轮换') || joined.includes('移出池子');
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