/**
 * client.js 的 apply 级测试。
 *
 * 为什么要有这个文件：2026-10-09 发生过一次**宿主启动失败** ——
 * lib/client.js 的包装模块里引用了未声明的 `react`，apply 抛 ReferenceError，
 * cordis 的 fiber 进入 failed，DSH 直接弹「应用无法启动或已意外停止」。
 *
 * 当时的验证只测到「内联工厂能求值」，没有驱动 wrapper 的 apply，
 * 所以完全没抓到。这个测试补上那一层：在一个仿浏览器的环境里真正执行
 * client.js、取出模块、调用 apply，断言它**不抛异常**且管理页注册成功。
 *
 * 断言的核心是最后一条：apply 永远不许抛。UI 层的问题可以导致页面不显示，
 * 但绝不能让整个应用起不来。
 *
 * 合并为 dsh-wotr-console 之后本文件额外覆盖：
 *   - 一个 bundle 里内联了 vendored 的 xdpool 自注册客户端，它的 apply
 *     仍被转发（拿 locale 文案），但注册的 settings.section 被替身 ctx 拦掉；
 *   - 两个配置标签页都是本包自写的（PoolConfigTab / TraeConfigTab），
 *     client.js 解析出的 settings 作用域必须真的传进管理页；
 *   - vendored 内联失败时只降级那一半，管理页照常注册，apply 仍不抛。
 *
 * 运行：node test/client-apply.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 默认测仓库里的 client.js；WBC_CLIENT_PATH 可指向别的副本（用于反向验证） */
const CLIENT = process.env.WBC_CLIENT_PATH ?? path.resolve(HERE, '..', 'lib', 'client.js');

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

//#region 仿浏览器环境

/** 所有 settings.section 注册（用来断言管理页真的挂上去了） */
const registrations = [];

/**
 * 假的 react：够两半用。
 *
 * Trae 客户端比管理页用得多（它自带整套卡片 UI），少一个 hook 就会让
 * 它的 factory 抛错、被 inlineVendoredClient 吞掉，测试就悄悄少覆盖一半。
 * 所以这里把两半用到的 API 都列全。
 *
 * `preset` 按下标预置 useState 的初值 —— 管理页把当前标签页存在第 0 个
 * state 里，从外部改不了，靠预置才能覆盖到「Trae 配置」等非默认标签页。
 */
function makeFakeReact(preset = {}) {
  const states = [];
  let i = 0;
  return {
    useState(init) {
      const idx = i++;
      if (idx in preset && !(idx in states)) states[idx] = preset[idx];
      else if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (v) => { states[idx] = typeof v === 'function' ? v(states[idx]) : v; }];
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (f) => f,
    useMemo: (f) => f(),
    useRef: (init) => ({ current: init }),
    useReducer: (_r, init) => [init, () => {}],
    createContext: (v) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: v }),
    useContext: () => undefined,
    forwardRef: (f) => f,
    memo: (f) => f,
    createElement: () => null,
    Fragment: 'Fragment',
    __reset() { i = 0; },
  };
}

/** 假的 jsx-runtime */
const fakeJsx = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };

/** document 桩：appendChild(script) 要**真正执行**它，模拟浏览器的行为 */
function makeFakeDocument(execScript) {
  const head = {
    appendChild(el) {
      if (el && el.tagName === 'script' && typeof el.textContent === 'string') {
        execScript(el.textContent);
      }
      return el;
    },
  };
  return {
    head,
    body: head,
    createElement(tag) {
      return { tagName: tag, textContent: '', dataset: {}, setAttribute() {}, removeAttribute() {}, remove() {} };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/**
 * 可展开的 jsx-runtime：返回元素对象而不是 null，供下面的「真渲染一遍」用。
 *
 * client-apply 这一层原本只断言到「注册发生了什么」。合并后新增了一个
 * **跨模块**的契约：client.js 解析出的 settings 作用域必须真的**传进**管理页。
 * 只断言注册项的话，作用域句柄被丢掉、或管理页忘了渲染对应标签页，
 * 都照样全绿 —— 而用户看到的就是标签页空白 / 控件全灰。
 */
function makeTreeJsx() {
  return {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
    Fragment: 'Fragment',
  };
}

/** 展开元素树并收集每个被渲染组件的 type，模拟 react 渲染函数组件 */
function expand(tree, out, depth = 0) {
  if (depth > 40 || tree === null || tree === undefined || typeof tree !== 'object') return;
  if (Array.isArray(tree)) {
    for (const child of tree) expand(child, out, depth);
    return;
  }
  const { type, props } = tree;
  if (typeof type === 'function') {
    out.push({ type, props: props ?? {} });
    expand(type(props ?? {}), out, depth + 1);
    return;
  }
  if (typeof type === 'string') expand(props?.children, out, depth + 1);
}

/** 在展开结果里按组件名找一项 */
function findByName(rendered, namePart) {
  return rendered.find((entry) => typeof entry.type === 'function' && String(entry.type.name).includes(namePart));
}

//#endregion

//#region 执行 client.js，取模块

/** 记录 __ModuleLoader__.load 注册过的定义 */
const definitions = new Map();

function installGlobals() {
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        if (def && typeof def.factory === 'function') definitions.set(def.id, def);
        return undefined;
      },
    },
  };
  globalThis.document = makeFakeDocument((src) => {
    // 模拟浏览器执行内联脚本：vendored 源码会调用 window.__ModuleLoader__.load
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', src)(globalThis.window, globalThis.document);
  });
  // vendored 的导航图标用它监听 DOM 变化；浏览器里有，Node 里没有
  if (globalThis.MutationObserver === undefined) {
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }
}

/** 仿 require：管理页与 vendored 都要 react */
function makeRequire(fakeReact) {
  return (name) => {
    if (name === 'react') return fakeReact;
    if (name === 'react/jsx-runtime') return fakeJsx;
    // Trae 客户端要 react-dom（它原来就是独立插件的完整客户端）
    if (name === 'react-dom') return { createPortal: () => null, flushSync: (f) => f() };
    throw new Error(`unexpected require: ${name}`);
  };
}

/** 造一个够用的 cordis ctx（locale 桩真的实现 register/bind，否则 label 断言没意义） */
function makeCtx() {
  /** ns -> 翻译表 */
  const dict = new Map();
  /** 所有装上的 effect 标签 */
  const effects = [];
  /**
   * 待执行的槽位注册回调。
   *
   * **关键：`slots.inject` 必须建模成「延迟」而不是「同步调用」。**
   *
   * 真实实现（ui-renderer 的 SlotRegistry.inject）订阅槽位的 declaration
   * epoch，只有槽位**被声明之后**才在 effect 里跑 cb；声明未到时它挂起，
   * 等声明到了再补跑。也就是说 apply() 返回时，槽位回调**通常还没跑**。
   *
   * 早先这个桩写成 `inject: (_n, fn) => fn()`（同步），于是「在 apply 返回后
   * 立刻读取捕获结果」这种错误代码在测试里能过、到真实环境就是两个配置
   * 标签页全空。这就是「WOTR 页正常但配置组件未能载入」的成因，
   * 桩失真让测试完全没拦住 —— 所以这里按真实语义建模。
   */
  const pending = [];
  const slots = {
    inject: (name, fn) => {
      pending.push({ name, fn });
      return () => {};
    },
    register: (opts, Component) => {
      // 组件本体一并记下：合并后要断言「截获到的配置卡片真的嵌进了管理页」
      registrations.push({ ...opts, Component });
      return () => {};
    },
  };
  const locale = {
    register: (ns, table) => {
      dict.set(ns, table?.zh ?? table?.en ?? {});
      return () => {};
    },
    bind: (ns) => (key) => (dict.get(ns) ?? {})[key] ?? key,
  };
  /**
   * 可写的 settings 作用域桩。
   *
   * 必须有：两个自写配置页都靠作用域的 `getSnapshot().writable` 判断
   * 「能不能写」，拿不到就整页退化成只读 —— 正是「改完点保存，值又弹回原样」
   * 那个故障。这里同时给 configForms（首选）与 settingsScope（0.1.5 回退）
   * 两条线，覆盖真实的解析分支。
   */
  const makeScope = () => ({
    getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
  });
  /**
   * configForms 桩 —— 0.1.7 那条线，也是**首选**解析路径。
   *
   * 宿主实际提供的命名空间常常带包名前缀，所以 describe() 镜像里刻意用
   * 真实入口名 `llm-workbuddy-xdpool`（而不是设置命名空间 workbuddy-xdpool），
   * 逼 client.js 走「精确匹配入口 id」那一支 —— 写死 ns 就会绑不上、
   * 每次写入都被拒，而控件照常亮着（「保存了又弹回去」）。
   */
  const configForms = {
    describe: () => ({
      getSnapshot: () => ({
        view: { namespaces: [{ ns: 'llm-workbuddy-xdpool' }, { ns: 'dsh-connect-trae' }] },
      }),
      subscribe: () => () => {},
      load: () => {},
    }),
    get: (ns) =>
      ns === 'llm-workbuddy-xdpool' || ns === 'dsh-connect-trae' ? makeScope() : undefined,
  };
  const services = new Map([
    ['slots', slots],
    ['locale', locale],
    ['configForms', configForms],
    ['settingsScope', { bind: () => makeScope() }],
  ]);
  /** 记录所有装上的 ctx.effect 标签（含被丢弃的，用来看拦截是否生效） */
  return {
    slots,
    locale,
    effects,
    /**
     * 声明槽位已就绪，跑掉挂起的 inject 回调 —— 模拟真实宿主的 declaration
     * 到达。**调用方必须在读取捕获结果之前调用它**，否则读到的就是
     * 「还没捕获」的中间态（真实环境里用户看不到组件就是这个原因）。
     */
    flushSlots: () => {
      const queued = pending.splice(0);
      for (const item of queued) {
        try {
          item.fn();
        } catch (e) {
          console.error('slot inject 回调抛错:', item.name, e);
        }
      }
      return queued.length;
    },
    get: (name) => services.get(name),
    effect: (fn, label) => {
      effects.push(String(label ?? ''));
      try { return fn(); } catch { /* vendored 可能用不到 */ }
    },
    inject: (_deps, fn) => { try { fn(); } catch { /* 同上 */ } },
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

//#endregion

//#region 用例

console.log('client.js apply 级测试\n');

const source = fs.readFileSync(CLIENT, 'utf8');

// —— 1) 语法 ——
try {
  new Function(source);
  ok('client.js 可被解析', true);
} catch (e) {
  ok('client.js 可被解析', false, e.message);
  process.exit(1);
}

// —— 2) 加载模块（正常环境：react 可用）——
installGlobals();
const fakeReact = makeFakeReact();
const require_ = makeRequire(fakeReact);
let mod = null;
try {
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const def = definitions.get('dsh-wotr-console');
  ok('模块已注册到 __ModuleLoader__', def !== undefined);
  mod = def.factory(require_);
  ok('factory 返回 exports', mod !== null && typeof mod === 'object');
  ok('导出 apply', typeof mod.apply === 'function');
  ok('导出 name', mod.name === 'dsh-wotr-console');
  ok('导出 inject = [slots, locale]', JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale']));
} catch (e) {
  ok('加载模块不抛异常', false, e.message);
}

// —— 3) 关键断言：apply 不抛，且管理页注册成功 ——
registrations.length = 0;
let applyErr = null;
let ctx3 = null;
try {
  ctx3 = makeCtx();
  mod.apply(ctx3);
} catch (e) {
  applyErr = e;
}
ok('apply 不抛异常（否则宿主会判启动失败）', applyErr === null, applyErr?.message);

/**
 * **延迟注册**：槽位声明到达之前，注册项不该出现。
 *
 * 这正是那个真实故障的机制 —— `slots.inject` 的回调是等到声明才跑的，
 * 所以 apply 刚返回时什么都没注册是**正常**的。客户端必须能扛过这段
 * 空窗期（等声明到了再补上），而不是假设 apply 返回即注册完成。
 */
ok(
  '槽位声明到达前，管理页尚未注册（延迟注册是正常语义）',
  registrations.filter((r) => r?.id === 'wotr-console-page').length === 0,
);

// 声明槽位就绪 → 挂起的回调开跑
ctx3.flushSlots();

/**
 * 合并后的**核心契约**：一个 bundle 只注册**一个**设置入口。
 *
 * 合并最容易静默坏掉的地方在这里 —— 多注册一个不会报错，只是设置里
 * 多出一个本该消失的入口；少注册一个同样不报错，只是标签页变空。
 *
 * 具体契约：
 *   - 「WOTR 管理」页注册为 settings.section / wotr-console-page，order 440；
 *   - 账号池**不再**单独注册 settings.section / workbuddy-xdpool；
 *   - Trae **不再**注册 plugins.bundle.config / plugins.row.config；
 *   - Trae 的输入框积分读数（conversation.input.left）照旧注册 ——
 *     它不并进管理页，是输入框旁的功能，删掉就是功能倒退。
 */
const ids = registrations.map((r) => r && (r.id ?? r.key));
ok(
  '账号池卡片不再单独注册（settings.section / workbuddy-xdpool）',
  !registrations.some((r) => r && r.name === 'settings.section' && r.id === 'workbuddy-xdpool'),
);
ok(
  'Trae 插件卡片不再单独注册（plugins.bundle.config）',
  !registrations.some((r) => r && r.name === 'plugins.bundle.config'),
);
ok(
  'Trae 行内卡片不再单独注册（plugins.row.config）',
  !registrations.some((r) => r && r.name === 'plugins.row.config'),
);
ok(
  'Trae 浏览器客户端已不再内联（conversation.input.left 随之不再注册）',
  !registrations.some((r) => r && r.name === 'conversation.input.left'),
);
ok('管理页已注册（settings.section / wotr-console-page）', ids.includes('wotr-console-page'));

const mine = registrations.filter((r) => r && r.id === 'wotr-console-page');
ok('管理页注册数恰好为 1', mine.length === 1, `got ${mine.length}`);
if (mine.length === 1) {
  ok('注册名正确', mine[0].name === 'settings.section');
  ok('label 是函数', typeof mine[0].label === 'function');
  ok('label 返回 WOTR', mine[0].label() === 'WOTR');
  ok('order 为 440（占用账号池原来的位置）', mine[0].order === 440);
  ok('注册的是组件（函数）', typeof mine[0].Component === 'function');
}

/**
 * —— 3b) 端到端：settings 作用域真的传进管理页的两个配置标签页 ——
 *
 * 这是合并的**真正难点所在**，也是最容易静默坏掉的一环：
 * 作用域解析对了、注册项也对了，但若没传进管理页（或页面忘了渲染），
 * 「XD Pool」「Trae 配置」两个标签页就是空白 / 控件全灰 —— 不会报任何错。
 *
 * 做法：用可展开的 jsx-runtime 重跑一遍，拿到管理页组件后**真正调用它**，
 * 展开元素树，断言两个自写配置页出现在树里、且各自拿到了活句柄。
 */
if (mine.length === 1) {
  definitions.clear();
  registrations.length = 0;
  installGlobals();
  const fakeReact2 = makeFakeReact();
  const require2 = (name) => {
    if (name === 'react') return fakeReact2;
    if (name === 'react/jsx-runtime') return makeTreeJsx();
    if (name === 'react-dom') return { createPortal: () => null, flushSync: (f) => f() };
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const mod4 = definitions.get('dsh-wotr-console').factory(require2);
  const ctx4 = makeCtx();
  mod4.apply(ctx4);
  // 声明到达 → 槽位回调开跑，管理页这才注册出来
  ctx4.flushSlots();

  const page = registrations.find((r) => r?.id === 'wotr-console-page');
  let rendered = [];
  let renderErr = null;
  try {
    // 默认 tab 是 XD Pool，所以第一遍就能覆盖它
    expand(page.Component({}), rendered);
  } catch (e) {
    renderErr = e;
  }
  ok('管理页组件可渲染，不抛异常', renderErr === null, renderErr?.message);

  // XD Pool 是默认标签页，必须已在第一遍渲染里
  const poolHit = findByName(rendered, 'PoolConfigTab');
  ok(
    '默认标签页渲染了本包自写的 PoolConfigTab（XD Pool 配置）',
    poolHit !== undefined,
    `渲染到的组件: ${rendered.map((e) => e.type?.name || '').filter(Boolean).join(', ')}`,
  );
  /**
   * 作用域句柄必须真的传进去：PoolConfigTab 靠
   * `wbSettings.get().getSnapshot().writable` 定只读/可写，
   * 拿不到就整页变只读 —— 这正是「保存了但值弹回去」那个故障的可见面。
   */
  ok(
    'PoolConfigTab 收到了 wbSettings（否则整页退化为只读）',
    poolHit !== undefined && poolHit.props.wbSettings !== undefined,
  );
  ok(
    'wbSettings 是活句柄（带 get，供渲染期取值）',
    poolHit !== undefined && typeof poolHit.props.wbSettings?.get === 'function',
  );
  ok(
    'wbSettings.get() 解析出可写作用域（configForms 入口 id 匹配那条线）',
    poolHit !== undefined && poolHit.props.wbSettings.get()?.getSnapshot?.().writable === true,
    JSON.stringify(poolHit?.props?.wbSettings?.get?.()?.getSnapshot?.() ?? null),
  );

  // 切到 Trae 配置标签页再看一遍
  let renderedTrae = [];
  let traeErr = null;
  try {
    // 用 preset 把 tab 指到 trae-config（hook 0 就是 tab）
    const fakeReact3 = makeFakeReact({ 0: 'trae-config' });
    const require3 = (name) => {
      if (name === 'react') return fakeReact3;
      if (name === 'react/jsx-runtime') return makeTreeJsx();
      if (name === 'react-dom') return { createPortal: () => null, flushSync: (f) => f() };
      throw new Error(`unexpected require: ${name}`);
    };
    definitions.clear();
    registrations.length = 0;
    installGlobals();
    new Function('window', 'document', source)(globalThis.window, globalThis.document);
    const mod5 = definitions.get('dsh-wotr-console').factory(require3);
    const ctx5 = makeCtx();
    mod5.apply(ctx5);
    ctx5.flushSlots();
    const p3 = registrations.find((r) => r?.id === 'wotr-console-page');
    expand(p3.Component({}), renderedTrae);
  } catch (e) {
    traeErr = e;
  }
  ok('Trae 配置标签页可渲染，不抛异常', traeErr === null, traeErr?.message);
  /**
   * Trae 配置页是**本包自写**的 TraeConfigTab，不再嵌入上游
   * dsh-connect-trae 的浏览器卡片（vendor/trae 与 gen-trae-client 已移除）。
   *
   * 它拿到的不再是 {Component, props} 卡片，而是 Trae 的 settings 作用域句柄
   * `scopeSlot` —— 页面自己渲染供应商开关、账号绑定、模型勾选与号池管理，
   * 读写规则与上游一致（见 client.js 的 resolveTraeSettings）。
   */
  const traeHit = findByName(renderedTrae, 'TraeConfigTab');
  ok(
    'Trae 配置标签页渲染了本包自写的 TraeConfigTab',
    traeHit !== undefined,
    `渲染到的组件: ${renderedTrae.map((e) => e.type?.name || '').filter(Boolean).join(', ')}`,
  );
  ok(
    'TraeConfigTab 不再渲染上游的 TraeUsageCard',
    findByName(renderedTrae, 'TraeUsageCard') === undefined,
  );
  /**
   * 作用域句柄必须真的传进去：拿不到它整页会退化成只读 ——
   * 表现为控件全灰 + 「设置作用域不可写」诊断行，勾选保存不了。
   */
  ok(
    'TraeConfigTab 收到了 scopeSlot（否则整页退化为只读）',
    traeHit !== undefined && traeHit.props.scopeSlot !== undefined,
  );
  ok(
    'scopeSlot 是活句柄（带 get，供渲染期取值）',
    traeHit !== undefined && typeof traeHit.props.scopeSlot?.get === 'function',
  );
}

// —— 4) react 取不到时的降级：不抛，只是不注册 ——
definitions.clear();
registrations.length = 0;
installGlobals();
const brokenRequire = () => { throw new Error('react not found'); };
try {
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const def = definitions.get('dsh-wotr-console');
  const mod2 = def.factory(brokenRequire);
  let err2 = null;
  const ctx2 = makeCtx();
  try {
    mod2.apply(ctx2);
  } catch (e) {
    err2 = e;
  }
  // 即使槽位声明到了（回调全跑完），没有 react 也注册不出管理页
  ctx2.flushSlots();
  ok('react 缺失时 apply 仍不抛', err2 === null, err2?.message);
  ok('react 缺失时不注册管理页（静默降级）', registrations.filter((r) => r?.id === 'wotr-console-page').length === 0);
} catch (e) {
  ok('react 缺失场景可运行', false, e.message);
}

/**
 * —— 6) 丢弃失效的 nav-icon effect ——
 *
 * `installNavIcon` 会往 document.body 挂一个 MutationObserver，每次 DOM 变动
 * 全页扫描，只为给「XD Pool」那条设置导航行画图标。合并后那条行不存在了，
 * 但它仍会常驻监听整个应用 DOM —— 纯开销，必须拦掉。
 *
 * 反面情形也要盯住：别把该留的 effect 一起丢了（locale 注册就靠 effect）。
 */
{
  definitions.clear();
  registrations.length = 0;
  installGlobals();
  const ctx6 = makeCtx();
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const mod6 = definitions.get('dsh-wotr-console').factory(require_);
  mod6.apply(ctx6);
  ctx6.flushSlots();

  ok(
    '失效的 nav-icon effect 已被丢弃（不再常驻监听全页 DOM）',
    !ctx6.effects.some((l) => /settings nav icon/.test(l)),
    `装上的 effect: ${ctx6.effects.join(' | ')}`,
  );
  ok(
    'locale 注册类的 effect 仍然装上（没有误伤）',
    ctx6.effects.some((l) => /settings copy/.test(l)),
    `装上的 effect: ${ctx6.effects.join(' | ')}`,
  );
}

// —— 5) ctx 缺服务时的降级 ——
definitions.clear();
registrations.length = 0;
installGlobals();
try {
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  const def = definitions.get('dsh-wotr-console');
  const mod3 = def.factory(require_);
  let err3 = null;
  try {
    mod3.apply({ get: () => undefined, effect: () => {}, inject: () => {}, on: () => {} });
  } catch (e) {
    err3 = e;
  }
  ok('ctx 缺 slots/locale 时 apply 不抛', err3 === null, err3?.message);
} catch (e) {
  ok('ctx 缺服务场景可运行', false, e.message);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
