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
 * 从外部改不了，靠预置才能覆盖到「积分」「使用记录」两个 tab。
 * 组件里 useState 的调用顺序是固定的（前 13 个 useState，preset 下标即此顺序）：
 *   0 tab · 1 region · 2 status · 3 summary · 4 loading · 5 summaryLoading · 6 error · 7 busyId
 *   8 traeRegion · 9 traeStatus · 10 traeLoading · 11 traeError · 12 traeBusy
 *
 * `useRef` 是合并进 Trae 半边后新增的用法（console.mjs 的 traeLoaded），
 * 早先的桩没有它，于是 `useRef(false)` 抛 "useRef is not a function"、
 * 30 个渲染用例全灭。真 React 一定有 useRef，缺的是桩，不是组件。
 * 这里补上并让它同样占一个 hook 槽位（cursor++），
 * 与真 React 的「每次渲染都按同一顺序调用」保持一致，
 * 免得往后再加 hook 时下标悄悄错位。
 */
function makeReact(preset = {}) {
  const hooks = [];
  let cursor = 0;
  return {
    useState(init) {
      const i = cursor++;
      if (i in preset) return [preset[i], () => {}];
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [hooks[i], () => {}];
    },
    useEffect() { cursor++; },
    useLayoutEffect() { cursor++; },
    useCallback(fn) { cursor++; return fn; },
    useMemo(fn) { cursor++; return fn(); },
    useRef(init) { cursor++; return { current: init }; },
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
function renderPage(preset, props) {
  const react = makeReact(preset);
  const jsxRuntime = makeJsxRuntime();
  const Page = createConsoleSection({ react, jsxRuntime });
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

// —— 1) 默认渲染（账号 tab，加载中）——
{
  let err = null;
  let text = '';
  try {
    text = renderPage({});
  } catch (e) {
    err = e;
  }
  ok('WorkBuddyPage 默认渲染不抛异常', err === null, err?.message);
  ok('渲染出页面标题', text.includes('WOTR 管理'), `实际: ${text.slice(0, 120)}`);
  ok('渲染出三个 tab', ['账号', '积分', '使用记录'].every((t) => text.includes(t)));
  ok('账号 tab 显示空态提示', text.includes('还没有检测到已登录'));
  ok('账号 tab 有「重新检测本机账号」按钮', text.includes('重新检测本机账号'));
  ok('账号 tab 有区域切换', text.includes('国内版') && text.includes('国际版'));
}

// —— 2) 三个 tab 在有数据时都能渲染 ——
const statusFixture = {
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

const withData = { 2: statusFixture, 3: summaryFixture, 4: false, 5: false };

for (const [tabId, label, mustHave] of [
  ['wb-accounts', '账号', ['测试账号', '冷却账号', '正常', '冷却中', '今日已签', '连签 9 天', '3,080', '令牌到期']],
  ['wb-credits', '积分', ['当前总积分', '采样记录', '历史跨度', '月包', '80 / 100', '2 个账号']],
  ['wb-history', '使用记录', ['每日净变化', '账号明细', '2026-10-08', '2026-10-09', '+80', '-100', '测试账号']],
]) {
  let err = null;
  let text = '';
  try {
    text = renderPage({ ...withData, 0: tabId });
  } catch (e) {
    err = e;
  }
  ok(`${label} tab 渲染不抛异常`, err === null, err?.message);
  const missing = mustHave.filter((s) => !text.includes(s));
  ok(`${label} tab 渲染出关键内容`, missing.length === 0, missing.length > 0 ? `缺少: ${missing.join(', ')}` : '');
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
  for (const tabId of ['wb-accounts', 'wb-credits', 'wb-history']) {
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
    renderPage({ ...withData, 0: 'wb-accounts', 2: { accounts: [acct] } });
  } catch (e) {
    err = e;
  }
  ok(`账号边界（${name}）不崩`, err === null, err?.message);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);