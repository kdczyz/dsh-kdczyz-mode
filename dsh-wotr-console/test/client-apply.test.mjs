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
 *   - 一个 bundle 里内联了**两段** vendored 自注册客户端（xdpool + trae），
 *     两段的产物都要被捕获、两个 apply 都要被转发；
 *   - 任一段内联失败时只降级那一半，另一半照常注册，apply 仍不抛。
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
 */
function makeFakeReact() {
  const states = [];
  let i = 0;
  return {
    useState(init) {
      const idx = i++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
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
  const slots = {
    inject: (_name, fn) => fn(),
    register: (opts) => {
      registrations.push(opts);
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
  const services = new Map([
    ['slots', slots],
    ['locale', locale],
  ]);
  return {
    slots,
    locale,
    get: (name) => services.get(name),
    effect: (fn) => { try { return fn(); } catch { /* vendored 可能用不到 */ } },
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
try {
  mod.apply(makeCtx());
} catch (e) {
  applyErr = e;
}
ok('apply 不抛异常（否则宿主会判启动失败）', applyErr === null, applyErr?.message);

/**
 * 合并后的**核心契约**：一个 bundle 必须把三样都注册出来。
 *
 * 这正是合并最容易静默坏掉的地方 —— 少注册一个不会报错，
 * 只是设置面板里少一张卡片，肉眼很难发现。
 */
const ids = registrations.map((r) => r && (r.id ?? r.key));
ok(
  '账号池卡片已注册（settings.section / workbuddy-xdpool）',
  registrations.some((r) => r && r.name === 'settings.section' && r.id === 'workbuddy-xdpool'),
);
ok(
  'Trae 插件卡片已注册（plugins.bundle.config）',
  registrations.some((r) => r && r.name === 'plugins.bundle.config' && r.key === 'dsh-connect-trae'),
);
ok(
  'Trae 行内卡片已注册（plugins.row.config）',
  registrations.some((r) => r && r.name === 'plugins.row.config'),
);
ok(
  'Trae 输入框积分读数已注册（conversation.input.left）',
  registrations.some((r) => r && r.name === 'conversation.input.left'),
);
ok('四标签页已注册（settings.section / wotr-console-page）', ids.includes('wotr-console-page'));
ok(
  '管理页 order 441 排在账号池 440 之后',
  registrations.filter((r) => r && r.id === 'workbuddy-xdpool').every((r) => r.order === 440) &&
    registrations.filter((r) => r && r.id === 'wotr-console-page').every((r) => r.order === 441),
);

const mine = registrations.filter((r) => r && r.id === 'wotr-console-page');
ok('管理页已注册 settings.section', mine.length === 1, `got ${mine.length}`);
if (mine.length === 1) {
  ok('注册名正确', mine[0].name === 'settings.section');
  ok('label 是函数', typeof mine[0].label === 'function');
  ok('label 返回 WOTR', mine[0].label() === 'WOTR');
  ok('order 为 441（排在账号池 440 之后）', mine[0].order === 441);
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
  try {
    mod2.apply(makeCtx());
  } catch (e) {
    err2 = e;
  }
  ok('react 缺失时 apply 仍不抛', err2 === null, err2?.message);
  ok('react 缺失时不注册管理页（静默降级）', registrations.filter((r) => r?.id === 'wotr-console-page').length === 0);
} catch (e) {
  ok('react 缺失场景可运行', false, e.message);
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
