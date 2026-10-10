/**
 * console.mjs — WOTR 管理页（DSH 原生设置页，多标签页）。
 *
 * 这是一个**浏览器端**组件模块，由 client.js 引入后注册到 `settings.section`
 * 槽位。它不是独立 Web 页面：不开独立页面、不需要 web/ 目录，
 * 数据全部通过 fetch 向两个半边**已有的**路由取：
 *
 *   WorkBuddy 侧  /plugins/dsh-workbuddy-xdpool/*   （vendored 池路由）
 *   本插件侧      /plugins/dsh-wotr-console/*       （lib/index.js 挂的只读接口）
 *   Trae 侧       /plugins/dsh-connect-trae/*       （lib/trae.js 挂的路由）
 *
 * 五个区域（第一个是**配置**，其余是**查看/配置**）：
 *   1. XD Pool        —— WorkBuddy 池配置（模型勾选 / 分配策略 / 积分自动化）
 *   2. Trae 配置      —— 供应商开关、账号绑定、模型勾选与测试（本文件自写）
 *   3. 账号           —— 左右两列同一套模块样式：WorkBuddy / Trae
 *   4. 积分           —— 每个账号的额度总额与积分包明细
 *   5. 使用记录       —— 按天聚合的积分变化 + 明细表（来自 credit-store 的落盘数据）
 *
 * XD Pool 标签页同样**本包自写**（PoolConfigTab）：不再嵌入 vendored 的
 * PoolCard，而是对齐 Trae 配置页这套模块样式直接实现区域切换 / 分配策略 /
 * 模型勾选 / 账号启停 / 保留积分 / 移出池子 / 签到 / 冷却重置 / 积分自动化
 * （CN only）。读写走 vendored 已有的路由与设置字段（`distribution` /
 * `disabledAccountIds` / `modelSelectionCn|Global` / `automation` 等，
 * 读取/写入语义与上游 PoolCard 逐项一致）。它的 settings 作用域由 client.js
 * 解析后经 `embedded.wbSettings` 传入。
 *
 * Trae 配置标签页同样**本包自写**（TraeConfigTab）：不再嵌入上游
 * dsh-connect-trae 的浏览器卡片，而是按本页 WorkBuddy 的模块样式直接实现
 * 供应商开关、账号绑定与模型勾选，读写走 lib/trae.js 已有的路由与
 * `regions` / `accounts` 两个设置字段（读取/写入语义与上游客户端逐项一致）。
 * 它的 settings 作用域由 client.js 解析后经 `embedded.traeSettings` 传入。
 *
 * 路由路径是**各半原本的硬编码常量**，与本包改名无关：webServer.register
 * 不把路由绑定到包名，所以合并后这些 URL 原样有效。
 */

/** 与 client.js 共享的 React 运行时 */
export function createConsoleSection({ react, jsxRuntime, embedded }) {
  const { useState, useEffect, useCallback, useMemo, useRef, createElement: h } = react;
  const { jsx, jsxs } = jsxRuntime;

  /**
   * WorkBuddy 池的 settings 作用域 —— **活句柄，不是快照**。
   *
   * 句柄形如 `{ get(): scope | null, subscribe(fn): () => void }`；`get()` 返回的
   * scope 自身带 `getSnapshot()` / `set(field, value)`（与 Trae 半边同形）。
   * client.js 按 vendored 的解析规则（configForms → settingsScope，
   * `llm-workbuddy-xdpool` 命名空间探测）拿到作用域后包成句柄传进来，
   * PoolConfigTab 在**渲染期**读取，写入的读写语义集中在下面那组 pool* 辅助
   * 函数里 —— 拿不到时标签页整体只读并给出诊断行，绝不静默回弹。
   */
  const wbSettings = embedded?.wbSettings ?? null;
  /**
   * Trae 半边的 settings 作用域（同一形状：{get,subscribe} 活句柄）。
   * client.js 按上游 dsh-connect-trae 的解析规则（configForms → settingsScope，
   * /trae/i 命名空间探测）拿到作用域后包成句柄传进来，TraeConfigTab 在
   * 渲染期读取并订阅 —— 写入的读写语义集中在下面那组 trae* 辅助函数里。
   */
  const traeSettings = embedded?.traeSettings ?? null;


  /** vendored 账号池的路由前缀（同 vendor/xdpool/lib/index.js 的常量，刻意不改名） */
  const POOL_API = '/plugins/dsh-workbuddy-xdpool';
  /** 本插件自己的路由前缀（由 lib/index.js 注册，提供历史记录） */
  const SELF_API = '/plugins/dsh-wotr-console';
  /** Trae 半边的路由前缀（同 lib/trae.js 的常量，刻意不改名） */
  const TRAE_API = '/plugins/dsh-connect-trae';
  /** Trae 的两个区域，卡片 tab 顺序 */
  const TRAE_REGIONS = [
    { id: 'cn', label: 'Trae 国内版' },
    { id: 'ai', label: 'Trae 国际版' },
  ];
  /** WorkBuddy 账号池的两个区域（同 vendored status.regions，固定顺序） */
  const POOL_REGIONS = [
    { id: 'cn', label: '国内版' },
    { id: 'global', label: '国际版' },
  ];
  /** WorkBuddy 账号池的默认上下文预算（同 vendored DEFAULT_CONTEXT_BUDGET） */
  const POOL_DEFAULT_CONTEXT_BUDGET = 2e5;
  /** 积分自动化各任务的默认小时表（同 vendored DEFAULT_AUTOMATION_HOURS） */
  const POOL_DEFAULT_AUTOMATION_HOURS = {
    checkin: [9],
    report: [10],
    tasks: [11],
    streak: [12],
    travel: [9, 21],
  };
  /** 积分自动化任务顺序与中文标签（同 vendored AUTOMATION_JOBS / zh 文案） */
  const POOL_AUTOMATION_JOBS = [
    { kind: 'checkin', label: '每日签到' },
    { kind: 'report', label: '活跃上报' },
    { kind: 'tasks', label: '任务奖励' },
    { kind: 'streak', label: '连登奖励' },
    { kind: 'travel', label: '猫猫旅行' },
  ];
  /** 「立即运行」轮询结算的节奏（同 vendored AUTOMATION_POLL_*） */
  const POOL_AUTOMATION_POLL_MS = 2e3;
  const POOL_AUTOMATION_POLL_ATTEMPTS = 90;
  /** 分配策略的展示顺序与中文文案（与 TraeConfigTab 的号池区保持一致） */
  const POOL_DISTRIBUTIONS = [
    { id: 'priority', label: '优先模式', hint: '先用完一个账号，用完再换下一个' },
    { id: 'round-robin', label: '轮换模式', hint: '按顺序轮流使用，积分均匀分摊' },
    { id: 'balanced', label: '均衡模式', hint: '随机抽取，闲置越久的账号被选中概率越高' },
  ];

  const CSS_ID = 'dsh-wotr-console/settings-page';
  const CSS = `
.wbc-page{align-self:stretch;display:flex;flex-direction:column;gap:20px;padding:4px 0 24px}
.wbc-head{display:flex;flex-direction:column;gap:4px}
.wbc-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wbc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.wbc-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbc-tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:8px 12px}
.wbc-tab:hover{color:var(--dsw-alias-label-primary)}
.wbc-tab-on{border-bottom-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.wbc-body{display:flex;flex-direction:column;gap:16px}
.wbc-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbc-spacer{flex:1}
.wbc-btn{appearance:none;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:6px 12px}
.wbc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}
.wbc-btn:disabled{opacity:.5;cursor:default}
.wbc-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.wbc-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wbc-err{color:var(--dsw-alias-label-error,#e5484d);font-size:12px}
.wbc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.wbc-sum{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px}
.wbc-sum-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}
.wbc-sum-value{font-size:22px;font-weight:600;color:var(--dsw-alias-label-primary);margin-top:6px;font-variant-numeric:tabular-nums}
.wbc-sum-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.wbc-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px}
.wbc-card-off{opacity:.55}
.wbc-card-head{display:flex;align-items:center;gap:8px}
.wbc-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-tag{border-radius:4px;font-size:10px;padding:2px 6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);flex:none}
.wbc-tag-on{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.wbc-tag-warn{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-error,#e5484d)}
.wbc-kv{display:flex;justify-content:space-between;gap:12px;font-size:12px}
.wbc-k{color:var(--dsw-alias-label-secondary)}
.wbc-v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wbc-packs{display:flex;flex-direction:column;gap:4px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.wbc-pack{display:flex;justify-content:space-between;gap:8px;font-size:11px}
.wbc-pack-name{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-pack-val{color:var(--dsw-alias-label-primary);flex:none;font-variant-numeric:tabular-nums}
.wbc-empty{border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.wbc-table-wrap{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.wbc-table{width:100%;border-collapse:collapse;font-size:12px}
.wbc-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbc-table td{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wbc-table tr:last-child td{border-bottom:0}
.wbc-num{text-align:right}
.wbc-pos{color:var(--dsw-alias-label-success,#30a46c)}
.wbc-neg{color:var(--dsw-alias-label-error,#e5484d)}
.wbc-spark{display:flex;align-items:flex-end;gap:2px;height:40px}
.wbc-spark-bar{flex:1;min-width:2px;background:var(--dsw-alias-label-primary);opacity:.35;border-radius:1px 1px 0 0}
.wbc-spark-bar-on{opacity:.9}
.wbc-embed{display:flex;flex-direction:column;gap:16px;min-width:0}
.wbc-note[data-diagnostic="settings-scope"]{color:var(--dsw-alias-label-error,#e5484d)}
/* —— Trae 配置标签页（TraeConfigTab，与账号页同一套模块样式）—— */
/* 模型行的勾选框等控件，宽度跟着内容走 */
.wbc-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary)}
.wbc-check input{accent-color:var(--dsw-alias-label-primary)}
.wbc-check-disabled{color:var(--dsw-alias-label-secondary)}
.wbc-models{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.wbc-model{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}
.wbc-model-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-model-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.wbc-model-actions{position:sticky;bottom:0;z-index:2;display:flex;gap:8px;justify-content:flex-end;padding:8px 0;background:var(--dsw-alias-bg-layer-1,#17181c);border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
/* 号池区：保留积分输入框 */
.wbc-reserve-input{width:88px;appearance:none;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;font-variant-numeric:tabular-nums}
.wbc-reserve-input:disabled{opacity:.5}
/* 探测结果徽章：unknown 是「没测出来」而不是失败，用中性色不用红色 */
.wbc-probe{border-radius:4px;font-size:10px;padding:2px 6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.wbc-probe-available{color:var(--dsw-alias-label-success,#30a46c)}
.wbc-probe-auth,.wbc-probe-rate_limited{color:var(--dsw-alias-label-error,#e5484d)}
/* 列内账号卡片改为单列：两列布局下列宽约 300–500px，
   沿用 auto-fill/minmax(240px) 会挤成两小张，卡片里的签到文案会折行 */
.wbc-cols .wbc-cards{grid-template-columns:1fr}
/* 统计小卡（余额/签到这类）在列内可以两两一行，比叠成四层高好得多 */
.wbc-sums{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.wbc-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:28px;align-items:start}
.wbc-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.wbc-col-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:28px}
.wbc-col-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wbc-col-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 输入框下方「当前模型额度」小胶囊：与内置 stats 胶囊同高同色，融进那一行 */
.wotr-credit-pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}
.wotr-credit-pill:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12))}
.wotr-credit-pill[data-busy="1"]{opacity:.6;cursor:progress}
.wotr-credit-pill[data-state="warn"]{color:var(--dsw-alias-label-warning,#d97706)}
.wotr-credit-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.wotr-credit-pill-num{font-variant-numeric:tabular-nums}
`;

  function ensureCss() {
    if (typeof document === 'undefined') return;
    if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-wotr-console';
    tag.dataset.pluginCss = CSS_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const msg = body?.error ?? body?.message ?? `HTTP ${res.status}`;
      throw new Error(String(msg));
    }
    return body;
  }

  /**
   * 取数组字段。
   *
   * 不能写 `x ?? []`：`??` 只挡 null/undefined，接口若返回字符串或对象
   * 就会漏过去，随后 `.map` / `.reduce` 抛错 —— 而渲染期抛错会让整个
   * 设置面板白屏。接口返回值不可信，统一用这个收口。
   */
  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function fmtNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
    return n.toLocaleString('en-US');
  }

  function fmtTime(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '–';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtRelative(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '–';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function fmtCapacity(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
    if (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6}M`;
    if (value >= 1e3 && value % 1e3 === 0) return `${value / 1e3}K`;
    return String(value);
  }
  //#endregion

  //#region Trae 设置读写（TraeConfigTab 用）
  //
  // 读取/写入语义逐项对齐上游 dsh-connect-trae 的浏览器卡片
  // （vendor/trae/client.js 的 regionSlotOf / nextRegionEnabled / writeSettingsField
  // 等 —— 现上游源码已移出仓库，本段注释保留出处记录）：
  //
  //   - `regions` 字段是 { cn: slot, ai: slot } 两槽，slot = {
  //       enabled, lastCatalog, enabledModelIds, imageModelIds, contextBudgets }；
  //   - 供应商开关是**opt-out**：只有显式 `false` 才算关（旧配置没有 enabled，
  //     读出来就是开）；
  //   - 写入只动目标区域的槽，另一区域的槽原样带过，否则会清掉那边的模型勾选；
  //   - configForms.set() **resolve 了不等于写进去了**：被拒的写入会重载宿主
  //     状态后正常返回，必须读回快照确认落地，否则控件会「闪一下又弹回去」。
  //
  // 上游客户端在这些地方踩过实打实的坑（见各函数注释），这里照单全收。

  /** 拆掉 volatile 引用（{get(): T} 形态）—— 快照值可能是活引用 */
  function unwrapVolatile(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
    return value;
  }

  function unwrapVolatileDeep(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.get === 'function') return unwrapVolatileDeep(value.get());
    if (Array.isArray(value)) return value.map((entry) => unwrapVolatileDeep(entry));
    const out = {};
    for (const key of Object.keys(value)) out[key] = unwrapVolatileDeep(value[key]);
    return out;
  }

  /** 从设置值里取 `regions` 两槽（容忍传入整份设置或 regions 本身） */
  function regionsMapOf(value) {
    const doc = unwrapVolatileDeep(value);
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {};
    const nested = doc.regions;
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) return nested;
    return doc;
  }

  /** 一个区域槽的普通对象形态；任何其它形状读作空槽 */
  function traeRegionSlotOf(value, region) {
    const slot = unwrapVolatile(regionsMapOf(value)[region]);
    return typeof slot === 'object' && slot !== null && !Array.isArray(slot) ? slot : {};
  }

  /** 供应商开关（opt-out：只有显式 false 才算关） */
  function traeRegionEnabledOf(value, region) {
    return traeRegionSlotOf(value, region).enabled !== false;
  }

  /** 生成下一个 `regions` 值：只动目标区域的槽，其余槽原样保留 */
  function nextRegionSlots(regions, region, slot) {
    const doc = unwrapVolatileDeep(regions);
    return {
      ...(typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? doc : {}),
      [region]: slot,
    };
  }

  /** 生成下一个 `accounts` 值：只改目标区域的绑定 */
  function traeNextAccounts(accounts, region, accountId) {
    const doc = unwrapVolatileDeep(accounts);
    return {
      ...(typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? doc : {}),
      [region]: accountId,
    };
  }

  /**
   * 写一个设置字段并**读回确认落地**。
   *
   * `configForms.set()` resolve 了不等于写进去了：被拒的写入会重载宿主状态后
   * 正常返回，await 成功而文档没变 —— 上游客户端曾因此「看起来保存了，
   * 值又悄悄弹回去」。读回不匹配就抛错，让调用方把失败显示出来。
   */
  async function writeTraeField(scope, field, value, landed) {
    const label = `trae: settings 字段 "${field}" 未能写入`;
    if ((await scope.set(field, value)) === false) throw new Error(`${label}（宿主拒绝）`);
    if (!landed(unwrapVolatileDeep(scope.getSnapshot().value))) throw new Error(label);
  }

  /** 一键测试的探测结论标签 */
  const TRAE_PROBE_LABELS = {
    available: '可用',
    gated: '需要更高档位',
    unsupported: '上游不提供',
    rate_limited: '被限流',
    auth: '登录凭据被拒',
    unknown: '本次未测出',
  };
  //#endregion

  //#region WorkBuddy 池设置读写（PoolConfigTab 用）
  //
  // 读取/写入语义逐项对齐 vendored 客户端 vendor/xdpool/lib/client.js 的
  // PoolCard（现仅作逐字节对照，不再嵌入渲染）：
  //
  //   - `distribution` / `disabledAccountIds` / `automation` 是**顶层**设置键；
  //     模型勾选按区域分键：`modelSelectionCn` / `modelSelectionGlobal`；
  //   - 模型保存是**整段覆盖**：{ enabledModelIds, imageModelIds, contextBudgets,
  //     reasoningEfforts, maxMode }，漏一个键就会清掉那边的既有值；
  //   - 保存前拒绝空启用列表（否则选择器里一个模型都没有，用户无从恢复）；
  //   - `configForms.set()` resolve 了不等于写进去了，所以写完必须刷新状态
  //     读回，确认落地后才丢弃草稿；
  //   - 自动化只在 CN 生效（国际版没有这套接口），未配置时按默认小时表补齐。

  /** 取池作用域对象：句柄 → scope（兼容直接传 scope 的旧形状） */
  function poolScopeOf(handle) {
    const scope = typeof handle?.get === 'function' ? handle.get() : handle;
    return typeof scope?.get === 'function' ? scope.get() : scope;
  }

  /** 该作用域当前是否可写（拿不到快照按只读处理） */
  function poolWritable(scopeObj) {
    try {
      return scopeObj?.getSnapshot?.().writable === true;
    } catch {
      return false;
    }
  }

  /** 已提交的模型勾选按区域分键（同 vendored modelSelectionKeyFor） */
  function poolSelectionKey(region) {
    return region === 'global' ? 'modelSelectionGlobal' : 'modelSelectionCn';
  }

  /** 从 status 构造模型草稿（同 vendored draftFromStatus） */
  function poolDraftFromStatus(status) {
    const selection = status?.selection ?? {};
    const enabled = selection.enabledModelIds;
    const images = selection.imageModelIds;
    const budgets = selection.contextBudgets;
    const efforts = selection.reasoningEfforts;
    const out = {};
    for (const model of asArray(status?.models)) {
      const entry = {
        enabled: enabled === undefined || enabled.includes(model.id),
        images: images === undefined ? model.supportsImages === true : images.includes(model.id),
      };
      const budget = budgets?.[model.id];
      if (budget !== undefined) entry.budget = budget;
      const effort = efforts?.[model.id];
      if (effort !== undefined) entry.effort = effort;
      out[model.id] = entry;
    }
    return out;
  }

  /** 草稿与已提交值是否有差异（同 vendored draftIsDirty） */
  function poolDraftIsDirty(status, draft) {
    const selection = status?.selection ?? {};
    const models = asArray(status?.models);
    const enabled = new Set(
      selection.enabledModelIds ?? models.filter((m) => m.enabled).map((m) => m.id),
    );
    const images = new Set(
      selection.imageModelIds ?? models.filter((m) => m.supportsImages).map((m) => m.id),
    );
    const budgets = selection.contextBudgets ?? {};
    const efforts = selection.reasoningEfforts ?? {};
    for (const model of models) {
      const entry = draft[model.id];
      if (entry === undefined) continue;
      if (entry.enabled !== enabled.has(model.id)) return true;
      if (entry.images !== images.has(model.id)) return true;
      if ((budgets[model.id] ?? model.nativeContextWindow) !== (entry.budget ?? model.nativeContextWindow)) {
        return true;
      }
      if ((efforts[model.id] ?? '') !== (entry.effort ?? '')) return true;
    }
    return false;
  }

  /** 某任务已配置的小时表（同 vendored automationHours） */
  function poolAutomationHours(status, kind) {
    const automation = status?.automation;
    if (automation === undefined || automation === null) return [];
    switch (kind) {
      case 'report':
        return automation.reportHours;
      case 'tasks':
        return automation.taskHours;
      case 'checkin':
        return automation.checkinHours;
      case 'streak':
        return automation.streakHours;
      case 'travel':
        return automation.travelHours;
      default:
        return [];
    }
  }

  /** 某任务上次运行记录（同 vendored automationJob） */
  function poolAutomationJob(status, kind) {
    return status?.automation?.jobs?.[kind];
  }

  /** 小时表：已配置且非空则原样使用，否则回落默认（同 vendored hoursOrDefault） */
  function poolHoursOrDefault(configured, fallback) {
    return Array.isArray(configured) && configured.length > 0 ? [...configured] : [...fallback];
  }

  /** 今日自动化合计（同 vendored automationTotals） */
  function poolAutomationTotals(status) {
    return Object.values(status?.automation?.earningsToday ?? {}).reduce(
      (sum, entry) => ({
        credit: sum.credit + (entry?.credit ?? 0),
        energy: sum.energy + (entry?.energy ?? 0),
        claimed: sum.claimed + (entry?.claimed ?? 0),
        checkinCredit: sum.checkinCredit + (entry?.checkinCredit ?? 0),
        bonusCredit: sum.bonusCredit + (entry?.bonusCredit ?? 0),
        travelCredit: sum.travelCredit + (entry?.travelCredit ?? 0),
      }),
      { credit: 0, energy: 0, claimed: 0, checkinCredit: 0, bonusCredit: 0, travelCredit: 0 },
    );
  }

  /** 任务运行结论 → 中文摘要 */
  function poolAutomationNote(job) {
    if (job === undefined || job === null) return '还没跑过';
    const parts = [];
    if (typeof job.credit === 'number') parts.push(`+${fmtNum(job.credit)} 积分`);
    if (typeof job.energy === 'number' && job.energy > 0) parts.push(`+${fmtNum(job.energy)} 能量`);
    if (typeof job.claimed === 'number' && job.claimed > 0) parts.push(`${fmtNum(job.claimed)} 个奖励`);
    const when = typeof job.at === 'number' ? fmtRelative(job.at) : null;
    const body = parts.length > 0 ? parts.join(' · ') : '已完成';
    return when === null ? body : `${body}（${when}）`;
  }
  //#endregion

  //#region XD Pool 配置页（自写，对齐 Trae 配置页）
  /**
   * XD Pool 标签页 —— **本包自写**，替代 vendored 的 PoolCard。
   *
   * 与 Trae 配置页同一套模块样式（列头 / 统计行 / 账号卡 / 空态都走共用组件），
   * 功能与上游 PoolCard 逐项对齐：
   *
   *   - 区域切换（cn / global），账号与模型目录都随区域走
   *   - 分配策略（`distribution`，顶层设置键，写后刷新）
   *   - 模型勾选（`modelSelectionCn|Global` 整段覆盖 + Max 模式 + 上下文预算）
   *   - 账号启停（`disabledAccountIds`）/ 保留积分 / 移出池子 / 恢复
   *   - 每日签到（POST /checkin）与冷却重置（POST /cooldowns/reset）
   *   - 积分自动化（**仅 CN**）：开关写整个 `automation` 对象，可立即运行并轮询结算
   *
   * 状态由父级 WotrPage 进页即拉（`status` / `loading` / `error`），
   * 本组件只负责渲染与写入，写完一律 `onRefresh()` 读回确认。
   */
  function PoolConfigTab({ wbSettings, region, onRegion, status, loading, error, onRefresh, onRescan }) {
    const scopeObj = poolScopeOf(wbSettings);
    const writable = poolWritable(scopeObj);

    // —— 本地状态（hook 顺序固定，勿插队）——
    const [writeError, setWriteError] = useState(null);
    const [savedNote, setSavedNote] = useState(null);
    /** 正在进行的写入标记：'distribution' | 'models' | 'automation' | 'cooldowns' | 'checkin-<id>' | ... */
    const [busy, setBusy] = useState(null);
    /** 保留积分输入草稿，按账号 id 分键 */
    const [reserveDraft, setReserveDraft] = useState({});
    /** 模型草稿，按区域分键（切换区域互不串味） */
    const [draftByRegion, setDraftByRegion] = useState({});
    /** Max 模式草稿，同样按区域分键 */
    const [maxModeByRegion, setMaxModeByRegion] = useState({});
    /** 「立即运行」正在跑的任务（'all' 或某 kind） */
    const [automationRun, setAutomationRun] = useState(null);

    const accounts = asArray(status?.accounts);
    const models = asArray(status?.models);
    const ignored = asArray(status?.ignored);
    const selection = status?.selection ?? {};
    const distribution = status?.distribution ?? 'priority';
    const automation = status?.automation;
    const cooling = accounts.filter((a) => a.cooling === true).length;
    const usable = accounts.filter((a) => a.cooling !== true && a.disabled !== true).length;
    const automationOn = automation?.enabled === true;

    const draft = draftByRegion[region];
    const modelBase = draft ?? poolDraftFromStatus(status);
    const enabledCount = Object.values(modelBase).filter((e) => e.enabled === true).length;
    const savedMaxMode = selection.maxMode === true;
    const maxMode = maxModeByRegion[region] ?? savedMaxMode;
    const modelsDirty =
      draft !== undefined && (poolDraftIsDirty(status, draft) || maxMode !== savedMaxMode);

    const setDraft = (next) =>
      setDraftByRegion((prev) => ({ ...prev, [region]: next }));
    const dropDraft = () =>
      setDraftByRegion((prev) => {
        if (prev[region] === undefined) return prev;
        const copy = { ...prev };
        delete copy[region];
        return copy;
      });
    const setMaxMode = (next) =>
      setMaxModeByRegion((prev) => ({ ...prev, [region]: next }));

    /**
     * 写一个设置字段。
     *
     * `configForms.set()` resolve 了不等于写进去了：被拒的写入会正常返回
     * （`false` 表示宿主明确拒绝），所以返回值必须检查 —— 否则用户看到
     * 「保存成功」而值悄悄弹回去，正是上游踩过的那个坑。
     */
    const writeField = async (field, value) => {
      const accepted = await scopeObj.set(field, value);
      if (accepted === false) throw new Error(`设置字段 "${field}" 被宿主拒绝`);
    };

    /** 统一收口：写入前清提示，写入后刷新，异常转成可见文案 */
    const run = async (marker, fn, note) => {
      setBusy(marker);
      setWriteError(null);
      setSavedNote(null);
      try {
        await fn();
        if (note !== undefined && note !== null) setSavedNote(note);
        await onRefresh();
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    };

    // —— 分配策略 ——
    const onDistribution = (next) => {
      if (!writable) return;
      return run('distribution', () => writeField('distribution', next), '分配策略已保存');
    };

    // —— 账号启停 ——
    const onToggleDisabled = (accountId, disabled) => {
      if (!writable) return;
      const current = accounts.filter((a) => a.disabled === true).map((a) => a.id);
      const next = disabled
        ? [...new Set([...current, accountId])]
        : current.filter((id) => id !== accountId);
      return run(accountId, () => writeField('disabledAccountIds', next), disabled ? '已停用该账号' : '已重新启用该账号');
    };

    // —— 移出池子 / 恢复 ——
    const onIgnore = (accountId, ignoredNext) => {
      return run(`ignore-${accountId}`, () =>
        fetchJson(`${POOL_API}/accounts/ignored`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, ignored: ignoredNext }),
        }), ignoredNext ? '已移出账号池' : '已恢复到账号池');
    };

    // —— 保留积分 ——
    const onSaveReserve = (accountId) => {
      const parsed = Number.parseInt(reserveDraft[accountId] ?? '', 10);
      const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      return run(`reserve-${accountId}`, () =>
        fetchJson(`${POOL_API}/accounts/credit-reserve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, reserve: value }),
        }), value > 0 ? `已保留 ${value} 积分` : '已取消保留');
    };

    // —— 冷却重置 ——
    const onResetCooldowns = () => {
      return run('cooldowns', () => fetchJson(`${POOL_API}/cooldowns/reset`, { method: 'POST' }), '冷却已清除');
    };

    // —— 签到 ——
    const onCheckin = (accountId) => {
      return run(`checkin-${accountId}`, () =>
        fetchJson(`${POOL_API}/checkin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId }),
        }), '签到完成');
    };

    // —— 自动化开关：整段写 automation（小时表原样带过，缺省补默认）——
    const onToggleAutomation = (enabled) => {
      if (!writable) return;
      return run('automation', () =>
        writeField('automation', {
          checkinHours: poolHoursOrDefault(automation?.checkinHours, POOL_DEFAULT_AUTOMATION_HOURS.checkin),
          reportHours: poolHoursOrDefault(automation?.reportHours, POOL_DEFAULT_AUTOMATION_HOURS.report),
          taskHours: poolHoursOrDefault(automation?.taskHours, POOL_DEFAULT_AUTOMATION_HOURS.tasks),
          streakHours: poolHoursOrDefault(automation?.streakHours, POOL_DEFAULT_AUTOMATION_HOURS.streak),
          travelHours: poolHoursOrDefault(automation?.travelHours, POOL_DEFAULT_AUTOMATION_HOURS.travel),
          enabled,
        }), enabled ? '已开启积分自动化' : '已关闭积分自动化');
    };

    // —— 立即运行：POST 后轮询 runInProgress 直到结算（同 vendored）——
    const onRunAutomation = async (job) => {
      setAutomationRun(job);
      setWriteError(null);
      setSavedNote(null);
      try {
        const body = await fetchJson(`${POOL_API}/automation/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job }),
        });
        if (body?.started === false) setSavedNote('已有一轮在运行，稍后查看结果');
        let settled = false;
        for (let attempt = 0; attempt < POOL_AUTOMATION_POLL_ATTEMPTS; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, POOL_AUTOMATION_POLL_MS));
          const next = await onRefresh();
          if (next?.automation?.runInProgress === false) {
            settled = true;
            break;
          }
        }
        await onRefresh();
        setSavedNote(settled ? '自动化已跑完' : '运行时间较长，可稍后刷新查看');
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setAutomationRun(null);
      }
    };

    // —— 模型勾选 ——
    const editModel = (id, patch) => {
      const base = draft ?? poolDraftFromStatus(status);
      const entry = base[id];
      if (entry === undefined) return;
      setWriteError(null);
      setSavedNote(null);
      setDraft({ ...base, [id]: { ...entry, ...patch } });
    };
    const discardModels = () => {
      dropDraft();
      setMaxModeByRegion((prev) => {
        if (prev[region] === undefined) return prev;
        const copy = { ...prev };
        delete copy[region];
        return copy;
      });
      setWriteError(null);
      setSavedNote(null);
    };
    const enableAllModels = () => {
      const next = {};
      for (const model of models) {
        const prev = (draft ?? poolDraftFromStatus(status))[model.id] ?? {};
        next[model.id] = { ...prev, enabled: true };
      }
      setDraft(next);
    };
    const saveModels = async () => {
      if (!writable) return;
      if (enabledCount === 0) {
        setWriteError('至少要启用一个模型。');
        return;
      }
      setBusy('models');
      setWriteError(null);
      setSavedNote(null);
      try {
        const enabledModelIds = [];
        const imageModelIds = [];
        const contextBudgets = {};
        const reasoningEfforts = {};
        for (const model of models) {
          const entry = modelBase[model.id];
          if (entry === undefined) continue;
          if (entry.enabled === true) enabledModelIds.push(model.id);
          if (entry.images === true) imageModelIds.push(model.id);
          if (entry.budget !== undefined) contextBudgets[model.id] = entry.budget;
          if (entry.effort !== undefined) {
            const offered = asArray(model.supportedEfforts);
            if (entry.effort === 'off' || offered.includes(entry.effort)) {
              reasoningEfforts[model.id] = entry.effort;
            }
          }
        }
        await writeField(poolSelectionKey(region), {
          enabledModelIds,
          imageModelIds,
          contextBudgets,
          reasoningEfforts,
          maxMode,
        });
        // 先读回确认，再丢弃草稿（顺序反了会「闪一下又弹回去」）
        await onRefresh();
        dropDraft();
        setMaxModeByRegion((prev) => {
          if (prev[region] === undefined) return prev;
          const copy = { ...prev };
          delete copy[region];
          return copy;
        });
        setSavedNote('模型选择已保存');
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    };

    /**
     * 从 WorkBuddy 刷新实时目录 —— 对齐 Trae 页的「从 Trae 刷新」：拉取即落盘。
     *
     * 服务端（lib/index.js 的 POST /wb/models/refresh）负责拉一次上游目录并更新
     * 内存 catalog；这里把返回的 fresh 目录整表写入本区域选择：全部启用
     * （Trae 同款），图片能力跟随上游 supportsImages，上下文/推理强度沿用既有
     * 选择（新模型跟目录默认）。写完读回确认才丢草稿，用户不需要再点「保存」。
     */
    const refreshCatalog = async () => {
      if (!writable) return;
      setBusy('refresh');
      setWriteError(null);
      setSavedNote(null);
      try {
        const body = await fetchJson(`${SELF_API}/wb/models/refresh?region=${region}`, {
          method: 'POST',
        });
        const fresh = asArray(body?.models).filter(
          (model) => typeof model?.id === 'string' && model.id !== '',
        );
        if (fresh.length === 0) throw new Error('WorkBuddy 未返回任何模型');
        const freshIds = fresh.map((model) => model.id);
        const prevBase = poolDraftFromStatus(status);
        const next = {};
        const contextBudgets = {};
        const reasoningEfforts = {};
        const imageModelIds = [];
        for (const model of fresh) {
          const prev = prevBase[model.id] ?? {};
          const images = model.supportsImages === true;
          next[model.id] = {
            enabled: true,
            images,
            ...(prev.budget !== undefined ? { budget: prev.budget } : {}),
            ...(prev.effort !== undefined ? { effort: prev.effort } : {}),
          };
          if (prev.budget !== undefined) contextBudgets[model.id] = prev.budget;
          const offered = asArray(model.supportedEfforts);
          if (prev.effort !== undefined && (offered.length === 0 || offered.includes(prev.effort))) {
            reasoningEfforts[model.id] = prev.effort;
          }
          if (images) imageModelIds.push(model.id);
        }
        await writeField(poolSelectionKey(region), {
          enabledModelIds: freshIds,
          imageModelIds,
          contextBudgets,
          reasoningEfforts,
          maxMode,
        });
        // 先读回确认，再丢弃草稿（顺序反了会「闪一下又弹回去」）
        await onRefresh();
        dropDraft();
        setMaxModeByRegion((prev) => {
          if (prev[region] === undefined) return prev;
          const copy = { ...prev };
          delete copy[region];
          return copy;
        });
        setSavedNote(`已刷新：${freshIds.length} 个模型，已全部启用`);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    };

    const totals = poolAutomationTotals(status);
    const dirty = modelsDirty;

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsx(ColumnHead, {
          title: 'WorkBuddy 池',
          tabs: POOL_REGIONS,
          activeTab: region,
          onTab: onRegion,
          actions: [
            {
              label: loading ? '检测中…' : '重新检测',
              disabled: loading,
              onClick: typeof onRescan === 'function' ? onRescan : onRefresh,
            },
          ],
        }),
        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              children: '设置作用域不可写 —— 配置为只读，无法保存勾选。',
            })
          : null,
        error !== null && error !== undefined
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        writeError !== null
          ? jsx('div', { className: 'wbc-err', children: `设置未能保存：${writeError}` })
          : null,
        savedNote !== null ? jsx('div', { className: 'wbc-note', children: savedNote }) : null,
        status === null && loading
          ? jsx('div', { className: 'wbc-note', children: '正在读取账号池状态…' })
          : null,
        status === null
          ? null
          : jsx(StatsRow, {
              items: [
                { label: '账号', value: fmtNum(accounts.length), sub: '个已登录' },
                { label: '正常', value: fmtNum(usable), sub: '可轮换' },
                { label: '冷却中', value: fmtNum(cooling), sub: '被限流' },
                {
                  label: '分配策略',
                  value:
                    POOL_DISTRIBUTIONS.find((d) => d.id === distribution)?.label ?? distribution,
                  sub: '当前',
                  small: true,
                },
              ],
            }),
        status !== null && accounts.length === 0
          ? jsx(EmptyBox, {
              lines: [
                '这边还没有检测到已登录的 WorkBuddy 账号。',
                '请先在 WorkBuddy 桌面版里登录，再点上面的「重新检测」。',
              ],
            })
          : null,
        // —— 分配策略 ——
        status !== null && accounts.length > 0
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '账号使用方式' }),
                    jsx('div', { className: 'wbc-spacer' }),
                    ...POOL_DISTRIBUTIONS.map((d) =>
                      jsx(
                        'button',
                        {
                          type: 'button',
                          className: distribution === d.id ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                          disabled: !writable || busy === 'distribution',
                          title: d.hint,
                          onClick: () => onDistribution(d.id),
                          children: d.label,
                        },
                        d.id,
                      ),
                    ),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: busy === 'cooldowns',
                      onClick: onResetCooldowns,
                      children: busy === 'cooldowns' ? '正在清除…' : '清除所有冷却',
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'wbc-note',
                  children:
                    '同区域的多个 WorkBuddy 登录构成一个号池；被限流或额度耗尽的账号会自动冷却并换下一个。',
                }),
                jsx('div', {
                  className: 'wbc-cards',
                  children: accounts.map((a) =>
                    jsx(
                      AccountCard,
                      {
                        name: a.nickname || a.label || a.id,
                        dim: a.cooling === true || a.disabled === true,
                        tags: [
                          a.cooling === true
                            ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' }
                            : { text: '正常', cls: 'wbc-tag wbc-tag-on' },
                          a.disabled === true ? { text: '已停用', cls: 'wbc-tag' } : null,
                          a.reserved === true ? { text: '已保留·暂停', cls: 'wbc-tag' } : null,
                        ],
                        rows: [
                          { k: '触发限流', v: `${fmtNum(a.rateLimitHits ?? 0)} 次` },
                          a.cooldownUntil !== undefined
                            ? { k: '冷却至', v: fmtTime(a.cooldownUntil) }
                            : null,
                        a.credits !== undefined ? { k: '通用余额', v: fmtNum(a.credits) } : null,
                        a.creditReserve !== undefined && a.creditReserve > 0
                          ? { k: '保留积分', v: fmtNum(a.creditReserve) }
                          : null,
                      ],
                      action:
                        a.cooling !== true
                          ? {
                              label: busy === `checkin-${a.id}` ? '签到中…' : '签到领取',
                              disabled: busy === `checkin-${a.id}`,
                              onClick: () => onCheckin(a.id),
                            }
                          : null,
                    },
                    String(a.id ?? a.label),
                  ),
                ),
              }),
              // 每账号的启停 / 保留 / 移出（一行一个账号，紧凑条形控件）
              jsx('div', {
                className: 'wbc-bar',
                children: jsx('span', { className: 'wbc-col-sub', children: '账号设置' }),
              }),
              ...accounts.map((a) =>
                  jsxs(
                    'div',
                    {
                      className: 'wbc-bar',
                      children: [
                        jsx('span', { className: 'wbc-k', children: a.nickname || a.label || a.id }),
                        jsx('label', {
                          className: 'wbc-check',
                          children: [
                            jsx('input', {
                              type: 'checkbox',
                              checked: a.disabled !== true,
                              disabled: !writable || busy === a.id,
                              onChange: (e) => onToggleDisabled(a.id, e.target.checked !== true),
                            }),
                            jsx('span', { children: '参与轮换' }),
                          ],
                        }),
                        jsx('input', {
                          type: 'number',
                          min: 0,
                          step: 1,
                          className: 'wbc-reserve-input',
                          placeholder: '保留积分',
                          value: reserveDraft[a.id] ?? String(a.creditReserve ?? 0),
                          disabled: !writable || busy === `reserve-${a.id}`,
                          onChange: (e) =>
                            setReserveDraft((prev) => ({ ...prev, [a.id]: e.target.value })),
                        }),
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: !writable || busy === `reserve-${a.id}`,
                          onClick: () => onSaveReserve(a.id),
                          children: busy === `reserve-${a.id}` ? '保存中…' : '保存保留',
                        }),
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: busy === `ignore-${a.id}`,
                          onClick: () => onIgnore(a.id, true),
                          children: '移出池子',
                        }),
                      ],
                    },
                    `ctl-${a.id}`,
                  ),
              ),
              ],
            })
          : null,
        // —— 已移出池子的账号 ——
        ignored.length > 0
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '已移出账号池' }),
                    jsx('span', {
                      className: 'wbc-col-sub',
                      children: `${ignored.length} 个账号不再参与轮换`,
                    }),
                  ],
                }),
                ...ignored.map((entry) =>
                  jsxs(
                    'div',
                    {
                      className: 'wbc-bar',
                      children: [
                        jsx('span', { className: 'wbc-k', children: entry.label ?? entry.id }),
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: busy === `ignore-${entry.id}`,
                          onClick: () => onIgnore(entry.id, false),
                          children: '恢复',
                        }),
                      ],
                    },
                    `ignored-${entry.id}`,
                  ),
                ),
              ],
            })
          : null,
        // —— 积分自动化（仅 CN：国际版没有这套接口，同 vendored 的 activeRegion 判断）——
        region === 'cn' && automation !== undefined && automation !== null
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '积分自动化' }),
                    jsx('div', { className: 'wbc-spacer' }),
                    jsx('label', {
                      className: 'wbc-check',
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: automationOn,
                          disabled: !writable || busy === 'automation',
                          onChange: (e) => onToggleAutomation(e.target.checked),
                        }),
                        jsx('span', { children: automationOn ? '已开启' : '已关闭' }),
                      ],
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn wbc-btn-primary',
                      disabled: automationRun !== null,
                      onClick: () => onRunAutomation('all'),
                      children: automationRun !== null ? '运行中…' : '立即运行',
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'wbc-note',
                  children: automationOn
                    ? '每天自动签到、上报活跃、领取任务奖励与连登奖励，并照看猫猫旅行。'
                    : '已关闭：不会替你发起任何后台请求。',
                }),
                jsx(StatsRow, {
                  items: [
                    { label: '今日自动化', value: `+${fmtNum(totals.credit)}`, sub: '积分合计' },
                    { label: '任务奖励', value: `+${fmtNum(totals.checkinCredit)}`, sub: '签到' },
                    { label: '连登奖励', value: `+${fmtNum(totals.bonusCredit)}`, sub: '连登' },
                    { label: '猫猫旅行', value: `+${fmtNum(totals.travelCredit)}`, sub: '旅行' },
                  ],
                }),
                ...POOL_AUTOMATION_JOBS.map((job) => {
                  const rec = poolAutomationJob(status, job.kind);
                  const hours = asArray(poolAutomationHours(status, job.kind));
                  return jsxs(
                    'div',
                    {
                      className: 'wbc-bar',
                      children: [
                        jsx('span', { className: 'wbc-k', children: job.label }),
                        jsx('span', {
                          className: 'wbc-col-sub',
                          children:
                            hours.length === 0
                              ? '当天不跑'
                              : hours.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(' / '),
                        }),
                        jsx('div', { className: 'wbc-spacer' }),
                        jsx('span', { className: 'wbc-col-sub', children: poolAutomationNote(rec) }),
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: automationRun !== null,
                          onClick: () => onRunAutomation(job.kind),
                          children: automationRun === job.kind ? '运行中…' : '运行',
                        }),
                      ],
                    },
                    `job-${job.kind}`,
                  );
                }),
              ],
            })
          : null,
        // —— 模型目录 ——
        models.length > 0
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '模型' }),
                    jsx('span', {
                      className: 'wbc-col-sub',
                      children: `已启用 ${enabledCount} 个 · 实时目录 ${models.length} 个`,
                    }),
                    jsx('div', { className: 'wbc-spacer' }),
                    jsx('label', {
                      className: 'wbc-check',
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: maxMode,
                          disabled: !writable,
                          onChange: (e) => setMaxMode(e.target.checked),
                        }),
                        jsx('span', { children: 'Max 模式（满上下文 + 最强思考）' }),
                      ],
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      title: '拉一次上游实时目录：列表更新 + 所有模型自动全启用，立即生效（无需再点保存）。',
                      disabled: !writable || busy === 'refresh' || loading,
                      onClick: refreshCatalog,
                      children: busy === 'refresh' ? '刷新中…' : '从 WorkBuddy 刷新',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: !writable,
                      onClick: enableAllModels,
                      children: '一键启用所有模型',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: !dirty || busy === 'models',
                      onClick: discardModels,
                      children: '放弃修改',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn wbc-btn-primary',
                      disabled: !writable || busy !== null || enabledCount === 0,
                      onClick: saveModels,
                      children: busy === 'models' ? '保存中…' : '保存',
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'wbc-cols',
                  children: models.map((model) => {
                    const entry = modelBase[model.id] ?? { enabled: false, images: false };
                    const native = model.nativeContextWindow ?? model.contextWindow;
                    const capped = typeof native === 'number' && native > POOL_DEFAULT_CONTEXT_BUDGET;
                    return jsxs(
                      'div',
                      {
                        className: 'wbc-col',
                        children: [
                          jsxs('label', {
                            className: 'wbc-check',
                            children: [
                              jsx('input', {
                                type: 'checkbox',
                                checked: entry.enabled === true,
                                disabled: !writable,
                                onChange: (e) => editModel(model.id, { enabled: e.target.checked }),
                              }),
                              jsx('span', { children: model.name ?? model.id }),
                            ],
                          }),
                          jsx('div', {
                            className: 'wbc-model-meta',
                            children: [
                              `上下文 ${fmtCapacity(native)}`,
                              model.maxTokens !== undefined ? `输出 ${fmtCapacity(model.maxTokens)}` : null,
                              asArray(model.supportedEfforts).length > 0
                                ? `推理强度：${asArray(model.supportedEfforts).join(' / ')}`
                                : null,
                            ].filter(Boolean),
                          }),
                          model.supportsImages === true
                            ? jsx('label', {
                                className: 'wbc-check',
                                children: [
                                  jsx('input', {
                                    type: 'checkbox',
                                    checked: entry.images === true,
                                    disabled: !writable || entry.enabled !== true,
                                    onChange: (e) => editModel(model.id, { images: e.target.checked }),
                                  }),
                                  jsx('span', { children: '支持图片' }),
                                ],
                              })
                            : null,
                          capped
                            ? jsx('label', {
                                className: 'wbc-check',
                                children: [
                                  jsx('input', {
                                    type: 'radio',
                                    name: `budget-${region}-${model.id}`,
                                    checked: entry.budget === POOL_DEFAULT_CONTEXT_BUDGET,
                                    disabled: !writable,
                                    onChange: () => editModel(model.id, { budget: POOL_DEFAULT_CONTEXT_BUDGET }),
                                  }),
                                  jsx('span', { children: `限制到 ${fmtCapacity(POOL_DEFAULT_CONTEXT_BUDGET)}` }),
                                ],
                              })
                            : null,
                        ],
                      },
                      model.id,
                    );
                  }),
                }),
              ],
            })
          : null,
      ],
    });
  }
  //#endregion

  //#region Trae 配置页（自写，按 WorkBuddy 模块样式）

  /**
   * Trae 配置标签页 —— **本包自写**，替代上游 dsh-connect-trae 的浏览器卡片。
   *
   * 结构与账号页右列同一套模块（列头 / 统计行 / 账号卡 / 空态都走共用组件），
   * 外加一块模型勾选区。功能与上游卡片逐项对齐：
   *
   *   - 供应商开关（`regions.<region>.enabled`，opt-out，关掉后该区域的模型
   *     从 DSH 选择器里消失，账号与勾选保留，重新打开即恢复）
   *   - 账号绑定（`accounts.<region>`，只在当前区域生效，不动另一区域）
   *   - 模型勾选（`regions.<region>.enabledModelIds`）与一键可用性测试
   *     （走 /models/test，**会消耗少量配额**）
   *   - 「从 Trae 刷新」拉取最新目录，立即落盘 lastCatalog 并自动全量启用
   *
   * 所有设置写入都经 writeTraeField 读回确认；作用域缺失/只读时控件禁用并
   * 给出诊断行（与 PoolConfigTab 同款提示），**绝不静默回弹**。
   */
  function TraeConfigTab({ scopeSlot }) {
    // scopeSlot 是 client.js 包好的 {get,subscribe} 活句柄；这里在渲染期直接
    // 读句柄当前值，设置写入后 loadUsage / 后续渲染自然取到新快照。
    const scope = typeof scopeSlot?.get === 'function' ? scopeSlot.get() : scopeSlot;
    const scopeObj = typeof scope?.get === 'function' ? scope.get() : scope;
    const writable = scopeObj?.getSnapshot?.().writable === true;

    const [region, setRegion] = useState('cn');
    const [usage, setUsage] = useState(null);
    const [usageLoading, setUsageLoading] = useState(true);
    const [usageError, setUsageError] = useState(null);

    // 模型勾选草稿：null = 未改动（跟随已保存值），否则 { enabledIds: Set }。
    // 与上游一致只草稿化勾选本身；目录/预算等高级字段本页不暴露。
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [writeError, setWriteError] = useState(null);
    const [savedNote, setSavedNote] = useState(null);

    // 设置文档变化（含本页自己的写入）→ 丢弃草稿回到已保存状态
    const [settingsRev, setSettingsRev] = useState(0);
    useEffect(() => {
      if (scopeObj === null || scopeObj === undefined || typeof scopeObj.subscribe !== 'function') {
        return undefined;
      }
      return scopeObj.subscribe(() => setSettingsRev((v) => v + 1));
    }, [scopeObj]);

    /** 该区域供应商是否开启（opt-out，读已提交的设置文档） */
    const regionOn = traeRegionEnabledOf(
      scopeObj === null || scopeObj === undefined ? undefined : scopeObj.getSnapshot().value,
      region,
    );

    const loadUsage = useCallback(
      async (which) => {
        const target = which ?? region;
        setUsageLoading(true);
        setUsageError(null);
        try {
          const data = await fetchJson(`${TRAE_API}/usage?region=${target}`);
          setUsage(data);
        } catch (e) {
          setUsageError(e?.message ?? String(e));
          setUsage(null);
        } finally {
          setUsageLoading(false);
        }
      },
      [region],
    );

    useEffect(() => {
      loadUsage(region);
    }, [loadUsage, settingsRev]);

    const savedModels = asArray(usage?.models);
    const savedEnabledIds = asArray(usage?.enabledModelIds);
    const enabledSet = draft?.enabledIds ?? new Set(savedEnabledIds);
    const dirty = draft !== null;

    const toggleModel = (id) => {
      setWriteError(null);
      setSavedNote(null);
      setDraft((prev) => {
        const base = prev?.enabledIds ?? new Set(savedEnabledIds);
        const next = new Set(base);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { enabledIds: next };
      });
    };

    const discardModels = () => {
      setDraft(null);
      setWriteError(null);
      setSavedNote(null);
    };

    /** 一键启用所有模型：把目录里的模型全部勾进草稿（仍需「保存」落盘） */
    const enableAllModels = () => {
      setWriteError(null);
      setSavedNote(null);
      setDraft({ enabledIds: new Set(savedModels.map((model) => model.id)) });
    };

    /** 保存模型勾选：只写本区域的槽，带上「从 Trae 刷新」得来的目录快照 */
    const saveModels = async () => {
      if (scopeObj === undefined || scopeObj === null || !writable) return;
      if (usage?.status !== 'signed-in') return;
      setSaving(true);
      setWriteError(null);
      setSavedNote(null);
      try {
        const snapValue = scopeObj.getSnapshot().value;
        const catalog = savedModels.map((model) => ({
          ...model,
          input: ['text'],
          ...(model.multimodal === undefined ? {} : { multimodal: model.multimodal === true }),
        }));
        const slot = {
          enabled: traeRegionEnabledOf(snapValue, region),
          lastCatalog: catalog,
          enabledModelIds: [...enabledSet],
          imageModelIds: asArray(traeRegionSlotOf(snapValue, region).imageModelIds).filter(
            (id) => enabledSet.has(id),
          ),
          contextBudgets: traeRegionSlotOf(snapValue, region).contextBudgets ?? {},
        };
        await writeTraeField(
          scopeObj,
          'regions',
          nextRegionSlots(regionsMapOf(snapValue), region, slot),
          (readBack) => {
            const ids = traeRegionSlotOf(readBack, region).enabledModelIds;
            return Array.isArray(ids) && ids.length === slot.enabledModelIds.length
              && slot.enabledModelIds.every((id) => ids.includes(id));
          },
        );
        setDraft(null);
        setSavedNote('模型选择已保存');
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setSaving(false);
      }
    };

    /**
     * 从 Trae 刷新实时目录：拉取即落盘 —— 列表更新 + 所有模型自动全启用。
     *
     * 不再「并入草稿等保存」：上游一旦到手，就同时把 `lastCatalog`（新列表）
     * 和 `enabledModelIds`（fresh 全部 id）写进本区域槽并读回确认，无需用户
     * 再点一次「保存」。图片能力仍沿用用户既有的 imageModelIds 勾选。
     */
    const refreshModels = async () => {
      setWriteError(null);
      setSavedNote(null);
      if (scopeObj === undefined || scopeObj === null || !writable) return;
      if (usage?.status !== 'signed-in') {
        setWriteError('尚未登录 Trae，无法刷新目录');
        return;
      }
      setSaving(true);
      try {
        const body = await fetchJson(`${TRAE_API}/models/refresh?region=${region}`, { method: 'POST' });
        const fresh = asArray(body?.models);
        if (fresh.length === 0) throw new Error('Trae 未返回任何模型');
        const freshIds = new Set(fresh.map((m) => m.id));
        const snapValue = scopeObj.getSnapshot().value;
        const catalog = fresh.map((model) => ({
          ...model,
          input: ['text'],
          ...(model.multimodal === undefined ? {} : { multimodal: model.multimodal === true }),
        }));
        const slot = {
          enabled: traeRegionEnabledOf(snapValue, region),
          lastCatalog: catalog,
          enabledModelIds: [...freshIds],
          imageModelIds: asArray(traeRegionSlotOf(snapValue, region).imageModelIds).filter(
            (id) => freshIds.has(id),
          ),
          contextBudgets: traeRegionSlotOf(snapValue, region).contextBudgets ?? {},
        };
        await writeTraeField(
          scopeObj,
          'regions',
          nextRegionSlots(regionsMapOf(snapValue), region, slot),
          (readBack) => {
            const ids = traeRegionSlotOf(readBack, region).enabledModelIds;
            return Array.isArray(ids) && ids.length === slot.enabledModelIds.length
              && slot.enabledModelIds.every((id) => ids.includes(id));
          },
        );
        setDraft(null);
        setSavedNote(`已刷新：${fresh.length} 个模型，已全部启用`);
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setSaving(false);
      }
    };

    /** 一键测试已启用模型：每个模型一条最小消息，逐条更新徽章（会耗少量配额） */
    const [probes, setProbes] = useState({});
    const [testing, setTesting] = useState(null); // {done,total}
    const [testError, setTestError] = useState(null);
    const [testSummary, setTestSummary] = useState(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const testEnabledModels = async () => {
      const ids = [...enabledSet];
      setTestError(null);
      setTestSummary(null);
      if (ids.length === 0) {
        setTestError('请先启用至少一个模型。');
        return;
      }
      setTesting({ done: 0, total: ids.length });
      let available = 0;
      try {
        for (const id of ids) {
          if (!alive.current) return;
          const body = await fetchJson(`${TRAE_API}/models/test?region=${region}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [id] }),
          });
          if (!alive.current) return;
          const verdict = asArray(body?.results)[0];
          if (verdict !== undefined) {
            setProbes((prev) => ({ ...prev, [id]: verdict }));
            if (verdict.verdict === 'available') available += 1;
            if (verdict.verdict === 'auth') {
              setTesting(null);
              setTestError(`登录凭据被拒，已停止测试：${verdict.detail ?? ''}`);
              return;
            }
          }
          setTesting((prev) => (prev === null ? null : { ...prev, done: prev.done + 1 }));
        }
        setTesting(null);
        setTestSummary(`${ids.length} 个里有 ${available} 个正常应答。`);
      } catch (e) {
        setTesting(null);
        setTestError(`测试失败：${e?.message ?? String(e)}`);
      }
    };

    /** 账号绑定：写 accounts.<region>，语义与上游 switchAccount 一致 */
    const [switching, setSwitching] = useState(null);
    const onSwitchAccount = async (accountId) => {
      if (scopeObj === undefined || scopeObj === null || !writable) return;
      setSwitching(accountId);
      setWriteError(null);
      try {
        const value = scopeObj.getSnapshot().value;
        const accounts = traeRegionSlotOf(value, 'accounts');
        await writeTraeField(
          scopeObj,
          'accounts',
          traeNextAccounts(accounts, region, accountId),
          (readBack) => unwrapVolatileDeep(traeNextAccounts(accounts, region, accountId)[region])
            === unwrapVolatileDeep(readBack)?.accounts?.[region],
        );
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setSwitching(null);
      }
    };

    /**
     * 号池管理（对齐 XD Pool 的三件套）。
     *
     * 分配策略与停用/保留额度都写在 `regions.<region>` 槽里（与 WorkBuddy 池的
     * 配置同形），所以每次写入都只动目标区域的槽，另一区域的号池设置不受影响。
     * 清除冷却是**运行时状态**（不落盘），走专门的路由 —— 和 WorkBuddy 一致，
     * 冷却是号池自己的记账，卡住时用户需要一个不用重启 DSH 的出路。
     */
    const poolDoc = usage?.pool ?? null;
    const poolAccounts = asArray(poolDoc?.accounts);

    /** 写号池字段：只改目标区域槽的对应键，槽内其余字段原样带过 */
    const writePoolField = async (patch, landed, note) => {
      if (scopeObj === null || scopeObj === undefined || !writable) return;
      setWriteError(null);
      setSavedNote(null);
      try {
        const value = scopeObj.getSnapshot().value;
        const slot = { ...traeRegionSlotOf(value, region), ...patch };
        await writeTraeField(scopeObj, 'regions', nextRegionSlots(regionsMapOf(value), region, slot), landed);
        setSavedNote(note);
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      }
    };

    const [savingPool, setSavingPool] = useState(null);

    const onDistribution = (next) => {
      setSavingPool('distribution');
      writePoolField({ distribution: next }, (readBack) =>
        traeRegionSlotOf(readBack, region).distribution === next, '已保存分配策略')
        .finally(() => setSavingPool(null));
    };

    const onToggleDisabled = (accountId, disabled) => {
      setSavingPool(accountId);
      const currentIds = asArray(traeRegionSlotOf(scopeObj?.getSnapshot?.().value, region).disabledAccountIds);
      const next = disabled
        ? [...new Set([...currentIds, accountId])]
        : currentIds.filter((id) => id !== accountId);
      writePoolField({ disabledAccountIds: next }, (readBack) =>
        JSON.stringify(traeRegionSlotOf(readBack, region).disabledAccountIds ?? []) === JSON.stringify(next),
        disabled ? '已停用该账号' : '已重新启用该账号')
        .finally(() => setSavingPool(null));
    };

    const [reserveDraft, setReserveDraft] = useState({});
    const onSaveReserve = (accountId) => {
      const parsed = Number.parseInt(reserveDraft[accountId] ?? '', 10);
      const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      setSavingPool(`reserve-${accountId}`);
      const current = traeRegionSlotOf(scopeObj?.getSnapshot?.().value, region).creditReserves ?? {};
      const next = { ...current };
      if (value <= 0) delete next[accountId];
      else next[accountId] = value;
      writePoolField({ creditReserves: next }, (readBack) => {
        const saved = traeRegionSlotOf(readBack, region).creditReserves ?? {};
        return (saved[accountId] ?? 0) === value;
      }, value > 0 ? `已保留 ${value} 积分` : '已取消保留')
        .finally(() => setSavingPool(null));
    };

    const onResetCooldowns = async () => {
      setSavingPool('cooldowns');
      setWriteError(null);
      try {
        await fetchJson(`${TRAE_API}/cooldowns/reset?region=${region}`, { method: 'POST' });
        setSavedNote('冷却已清除');
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setSavingPool(null);
      }
    };

    /** 供应商开关：只改 enabled，其余字段原样保留（关掉不丢勾选） */
    const [togglingRegion, setTogglingRegion] = useState(null);
    const onToggleRegion = async (next) => {
      if (scopeObj === undefined || scopeObj === null || !writable) return;
      setTogglingRegion(region);
      setWriteError(null);
      try {
        const value = scopeObj.getSnapshot().value;
        await writeTraeField(
          scopeObj,
          'regions',
          nextRegionSlots(regionsMapOf(value), region, {
            ...traeRegionSlotOf(value, region),
            enabled: next,
          }),
          (readBack) => traeRegionSlotOf(readBack, region).enabled === next,
        );
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setTogglingRegion(null);
      }
    };

    const accounts = asArray(usage?.accounts);
    const signedIn = usage?.status === 'signed-in';
    const current = accounts.find((a) => a.selected === true) ?? null;

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-col-head',
          children: [
            ...TRAE_REGIONS.map((r) =>
              jsx(
                'button',
                {
                  type: 'button',
                  className: region === r.id ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                  onClick: () => {
                    setRegion(r.id);
                    setDraft(null);
                    setWriteError(null);
                    setSavedNote(null);
                  },
                  children: r.label,
                },
                r.id,
              ),
            ),
            jsx('label', {
              className: 'wbc-check',
              children: [
                jsx('input', {
                  type: 'checkbox',
                  checked: regionOn,
                  disabled: !writable || togglingRegion !== null,
                  onChange: (e) => onToggleRegion(e.target.checked),
                }),
                jsx('span', { children: '向 DSH 提供该供应商' }),
              ],
            }),
            jsx('div', { className: 'wbc-spacer' }),
            jsx('button', {
              type: 'button',
              className: 'wbc-btn',
              disabled: usageLoading,
              onClick: () => loadUsage(),
              children: usageLoading ? '刷新中…' : '刷新用量',
            }),
          ],
        }),
        regionOn === false
          ? jsx('div', {
              className: 'wbc-note',
              children: '该供应商已关闭：它的模型不会提供给 DSH。账号与模型设置都会保留，勾选上方复选框即可恢复。',
            })
          : null,
        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              children: '设置作用域不可写 —— 配置为只读，无法保存勾选。',
            })
          : null,
        usageError !== null
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${usageError}` })
          : null,
        writeError !== null
          ? jsx('div', { className: 'wbc-err', children: `设置未能保存：${writeError}` })
          : null,
        savedNote !== null ? jsx('div', { className: 'wbc-note', children: savedNote }) : null,
        usage === null && usageLoading
          ? jsx('div', { className: 'wbc-note', children: '正在读取 Trae 账号…' })
          : null,
        usage !== null && !signedIn
          ? jsx(EmptyBox, {
              lines: [
                `这边还没有检测到可用的 Trae ${region === 'ai' ? '国际版' : '国内版'}登录。`,
                '请在 Trae 客户端里登录，或用「账号」页右列的「添加账号」在浏览器里登录。',
              ],
            })
          : null,
        signedIn
          ? jsx(StatsRow, {
              items: [
                { label: '当前账号', value: usage.accountName ?? current?.accountName ?? '–', sub: `已检测到 ${accounts.length} 个登录`, small: true },
                { label: '通用余额', value: fmtNum(usage.credits?.generalAvailable), sub: 'general' },
                { label: '工作余额', value: fmtNum(usage.credits?.workAvailable), sub: 'work' },
                {
                  label: '签到',
                  value:
                    usage.checkin?.checkedIn === true
                      ? '今日已签到'
                      : usage.checkin?.enabled === false
                        ? '无签到活动'
                        : '可签到',
                  sub: usage.checkin?.credits !== undefined ? `+${fmtNum(usage.checkin.credits)} 积分` : null,
                  small: true,
                },
              ],
            })
          : null,
        signedIn && accounts.length > 1
          ? jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsx(
                  AccountCard,
                  {
                    name: a.accountName ?? a.id ?? '(未命名)',
                    dim: a.selected !== true,
                    tags: [
                      a.selected === true
                        ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                        : { text: '备用', cls: 'wbc-tag' },
                    ],
                    rows: [{ k: '账号 id', v: String(a.id ?? '–') }],
                    action:
                      a.selected === true
                        ? null
                        : {
                            label: switching === a.id ? '切换中…' : '切换到此账号',
                            disabled: switching !== null || !writable,
                            onClick: () => onSwitchAccount(a.id),
                          },
                  },
                  String(a.id ?? a.accountName),
                ),
              ),
            })
          : null,
        /**
         * 号池区：与 XD Pool 同一套控件（分配策略 / 账号启停 / 保留积分 / 清除冷却）。
         *
         * 数据来自 /usage 文档里新增的 pool 段（服务端直接读号池状态，不额外发
         * 上游请求），勾选后的写入走 regions.<region> 槽。
         */
        poolAccounts.length > 0
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '账号使用方式' }),
                    jsx('div', { className: 'wbc-spacer' }),
                    ...[
                      { id: 'priority', label: '优先模式', hint: '先用完一个账号，用完再换下一个' },
                      { id: 'round-robin', label: '轮换模式', hint: '按顺序轮流使用，积分均匀分摊' },
                      { id: 'balanced', label: '均衡模式', hint: '随机抽取，闲置越久的账号被选中概率越高' },
                    ].map((d) =>
                      jsx(
                        'button',
                        {
                          type: 'button',
                          className: poolDoc?.distribution === d.id ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                          disabled: !writable || savingPool !== null,
                          title: d.hint,
                          onClick: () => onDistribution(d.id),
                          children: d.label,
                        },
                        d.id,
                      ),
                    ),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: savingPool !== null,
                      onClick: onResetCooldowns,
                      children: savingPool === 'cooldowns' ? '正在清除…' : '清除所有冷却',
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'wbc-note',
                  children:
                    '同区域的多个 Trae 登录构成一个号池；被限流或额度耗尽的账号会自动冷却并换下一个。',
                }),
                jsx('div', {
                  className: 'wbc-cards',
                  children: poolAccounts.map((a) =>
                    jsxs(
                      'div',
                      {
                        className: a.disabled === true || a.reserved === true ? 'wbc-card wbc-card-off' : 'wbc-card',
                        children: [
                          jsxs('div', {
                            className: 'wbc-card-head',
                            children: [
                              jsx('span', { className: 'wbc-name', children: a.label ?? a.id }),
                              a.cooling === true
                                ? jsx('span', { className: 'wbc-tag wbc-tag-warn', children: '冷却中' })
                                : null,
                              a.disabled === true
                                ? jsx('span', { className: 'wbc-tag', children: '已停用' })
                                : jsx('span', { className: 'wbc-tag wbc-tag-on', children: '在轮换中' }),
                              poolDoc?.lastServedId === a.id
                                ? jsx('span', { className: 'wbc-tag wbc-tag-on', children: '当前使用' })
                                : null,
                              a.reserved === true
                                ? jsx('span', { className: 'wbc-tag', children: '已保留·暂停' })
                                : null,
                            ],
                          }),
                          jsx(KV, {
                            k: '触发限流',
                            v: `${fmtNum(a.rateLimitHits ?? 0)} 次`,
                          }),
                          a.cooldownUntilMs !== undefined
                            ? jsx(KV, { k: '冷却至', v: fmtTime(a.cooldownUntilMs) })
                            : null,
                          a.credits !== undefined
                            ? jsx(KV, { k: '通用余额', v: fmtNum(a.credits) })
                            : null,
                          // 保留积分：失焦提交太激进，改成显式保存（WorkBuddy 卡片
                          // 也是这么改的 —— 一次写入就是一次 settings 写 + 一次刷新）
                          jsxs('div', {
                            className: 'wbc-bar',
                            children: [
                              jsx('input', {
                                type: 'number',
                                min: 0,
                                step: 1,
                                className: 'wbc-reserve-input',
                                placeholder: '保留积分',
                                value: reserveDraft[a.id] ?? String(a.creditReserve ?? 0),
                                disabled: !writable || savingPool === `reserve-${a.id}`,
                                onChange: (e) =>
                                  setReserveDraft((prev) => ({ ...prev, [a.id]: e.target.value })),
                                onKeyDown: (e) => {
                                  if (e.key === 'Enter') onSaveReserve(a.id);
                                },
                              }),
                              jsx('button', {
                                type: 'button',
                                className: 'wbc-btn',
                                disabled: !writable || savingPool === `reserve-${a.id}`,
                                onClick: () => onSaveReserve(a.id),
                                children: savingPool === `reserve-${a.id}` ? '保存中…' : '保存',
                              }),
                              jsx('div', { className: 'wbc-spacer' }),
                              jsx('button', {
                                type: 'button',
                                className: 'wbc-btn',
                                disabled: !writable || savingPool === a.id,
                                onClick: () => onToggleDisabled(a.id, a.disabled !== true),
                                children:
                                  savingPool === a.id
                                    ? '保存中…'
                                    : a.disabled === true
                                      ? '重新启用'
                                      : '停用',
                              }),
                            ],
                          }),
                        ],
                      },
                      a.id,
                    ),
                  ),
                }),
              ],
            })
          : null,
        signedIn
          ? jsxs('div', {
              className: 'wbc-models',
              children: [
                jsxs('div', {
                  className: 'wbc-bar',
                  children: [
                    jsx('span', { className: 'wbc-col-title', children: '模型' }),
                    jsx('span', {
                      className: 'wbc-col-sub',
                      children: `已启用 ${enabledSet.size} 个 · 实时目录 ${savedModels.length} 个`,
                    }),
                    jsx('div', { className: 'wbc-spacer' }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: savedModels.length === 0 || !writable || saving,
                      title: '把目录里的所有模型一次性全部勾选（仍需点保存落盘）。',
                      onClick: enableAllModels,
                      children: '一键启用所有模型',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: usageLoading || saving || usage?.status !== 'signed-in',
                      title: '拉取 Trae 最新模型目录，立即更新列表并自动启用全部模型。',
                      onClick: refreshModels,
                      children: saving ? '刷新中…' : '从 Trae 刷新',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: enabledSet.size === 0 || testing !== null,
                      title: '给每个已启用模型发一条最小消息，看哪些真的能应答。会消耗少量额度。',
                      onClick: testEnabledModels,
                      children:
                        testing !== null ? `正在测试 ${testing.done}/${testing.total}…` : '一键测试启用模型',
                    }),
                  ],
                }),
                jsx('div', {
                  className: 'wbc-note',
                  children: '一键测试会给每个已启用模型发一条最小消息（消耗少量额度）。',
                }),
                testSummary !== null ? jsx('div', { className: 'wbc-note', children: testSummary }) : null,
                testError !== null ? jsx('div', { className: 'wbc-err', children: testError }) : null,
                savedModels.length === 0
                  ? jsx('div', { className: 'wbc-note', children: '暂无模型目录，先点「从 Trae 刷新」。' })
                  : jsx('div', {
                      children: savedModels.map((model) => {
                        const probe = probes[model.id];
                        return jsxs(
                          'div',
                          {
                            className: 'wbc-model',
                            children: [
                              jsx('label', {
                                className: 'wbc-check',
                                children: [
                                  jsx('input', {
                                    type: 'checkbox',
                                    checked: enabledSet.has(model.id),
                                    disabled: !writable || saving,
                                    onChange: () => toggleModel(model.id),
                                  }),
                                  jsx('span', {
                                    className: 'wbc-model-name',
                                    children: [
                                      model.name,
                                      typeof model.creditMultiplier === 'number'
                                        ? ` · x${model.creditMultiplier.toFixed(2)}`
                                        : null,
                                    ],
                                  }),
                                ],
                              }),
                              jsx('span', {
                                className: 'wbc-model-meta',
                                children: [
                                  `最大上下文 ${fmtCapacity(model.maxContextWindow ?? model.contextWindow)}`,
                                  model.maxTokens !== undefined ? `输出 ${fmtCapacity(model.maxTokens)}` : null,
                                  model.reasoning?.supported?.length
                                    ? `推理强度：${model.reasoning.supported.join(' / ')}`
                                    : null,
                                ].filter(Boolean),
                              }),
                              probe === undefined
                                ? null
                                : jsx('span', {
                                    className: `wbc-probe wbc-probe-${probe.verdict}`,
                                    title: probe.detail,
                                    children: TRAE_PROBE_LABELS[probe.verdict] ?? probe.verdict,
                                  }),
                            ],
                          },
                          model.id,
                        );
                      }),
                    }),
                dirty
                  ? jsxs('div', {
                      className: 'wbc-model-actions',
                      children: [
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: saving,
                          onClick: discardModels,
                          children: '放弃修改',
                        }),
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn wbc-btn-primary',
                          disabled: saving || enabledSet.size === 0,
                          onClick: saveModels,
                          children: saving ? '保存中…' : '保存',
                        }),
                      ],
                    })
                  : null,
              ],
            })
          : null,
      ],
    });
  }
  //#endregion

  //#region 共用模块（账号页两列同一套样式）
  /**
   * 账号页两列共用的几种「模块」。
   *
   * 抽出来的目的就是让左右两列长得**完全一样**：同一套列头、同一套统计小卡、
   * 同一套账号卡、同一套空态。先前两列各写各的，于是 WorkBuddy 侧没有统计行、
   * 卡片字段与操作按钮的位置也和 Trae 侧对不齐，并排一眼就能看出是两套东西。
   *
   * 这些组件刻意做成「无状态、只吃 props」：状态仍归 WotrPage 里各自那一份，
   * 两列的独立性（见 AccountsTab 注释）不受影响。
   */

  /** 列头：标题 + 区域切换 + 右侧操作按钮。两列共用。 */
  function ColumnHead({ title, tabs, activeTab, onTab, actions }) {
    return jsxs('div', {
      className: 'wbc-col-head',
      children: [
        jsx('span', { className: 'wbc-col-title', children: title }),
        ...asArray(tabs).map((r) =>
          jsx(
            'button',
            {
              type: 'button',
              className: activeTab === r.id ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
              onClick: () => onTab(r.id),
              children: r.label,
            },
            r.id,
          ),
        ),
        jsx('div', { className: 'wbc-spacer' }),
        ...asArray(actions).map((a, i) =>
          jsx(
            'button',
            {
              type: 'button',
              className: 'wbc-btn',
              disabled: a?.disabled === true,
              onClick: a?.onClick,
              children: a?.label,
            },
            `col-action-${i}`,
          ),
        ),
      ],
    });
  }

  /** 统计小卡一行（列内两两一行，见 CSS 的 .wbc-sums）。两列共用。 */
  function StatsRow({ items }) {
    return jsx('div', {
      className: 'wbc-sums',
      children: asArray(items).map((it, i) =>
        jsxs(
          'div',
          {
            className: 'wbc-sum',
            children: [
              jsx('div', { className: 'wbc-sum-label', children: it.label }),
              jsx('div', {
                className: 'wbc-sum-value',
                style: it.small === true ? { fontSize: '15px' } : undefined,
                children: it.value,
              }),
              it.sub === undefined || it.sub === null
                ? null
                : jsx('div', { className: 'wbc-sum-sub', children: it.sub }),
            ],
          },
          `stat-${i}`,
        ),
      ),
    });
  }

  /** 键值行：账号卡里的明细（额度 / 签到 / 令牌到期…）都用它。两列共用。 */
  function KV({ k, v }) {
    return jsxs('div', {
      className: 'wbc-kv',
      children: [
        jsx('span', { className: 'wbc-k', children: k }),
        jsx('span', { className: 'wbc-v', children: v }),
      ],
    });
  }

  /** 空态：虚线框 + 若干行说明。两列共用。 */
  function EmptyBox({ lines }) {
    return jsx('div', {
      className: 'wbc-empty',
      children: asArray(lines)
        .filter((x) => x !== null && x !== undefined)
        .map((line, i) => jsx('div', { children: line }, `empty-${i}`)),
    });
  }

  /**
   * 账号卡：两列同一套骨架。
   *
   *   head   名称 + 若干状态标签
   *   rows   KV 明细
   *   action 卡片底部一个按钮（WorkBuddy 是「签到领取」、Trae 是「签到」）
   *
   * `dim` 为 true 时整卡降透明度（停用 / 备用账号）。
   */
  function AccountCard({ name, tags, rows, action, dim }) {
    return jsxs('div', {
      className: dim === true ? 'wbc-card wbc-card-off' : 'wbc-card',
      children: [
        jsxs('div', {
          className: 'wbc-card-head',
          children: [
            jsx('span', { className: 'wbc-name', children: name }),
            ...asArray(tags)
              .filter((tag) => tag !== null && tag !== undefined)
              .map((tag, i) =>
                jsx('span', { className: tag.cls ?? 'wbc-tag', children: tag.text }, `tag-${i}`),
              ),
          ],
        }),
        ...asArray(rows)
          .filter((r) => r !== null && r !== undefined)
          .map((r, i) => jsx(KV, { k: r.k, v: r.v }, `row-${i}`)),
        action === null || action === undefined
          ? null
          : jsx('button', {
              type: 'button',
              className: 'wbc-btn',
              disabled: action.disabled === true,
              onClick: action.onClick,
              children: action.label,
            }),
      ],
    });
  }
  //#endregion

  //#region 账号页（左列：WorkBuddy）
  /**
   * 左列：WorkBuddy 账号。
   *
   * 只返回**列**（`wbc-col`），不套 `wbc-body` —— 外层由 AccountsTab 排成两列。
   * 骨架与右列 Trae **完全一致**（列头 / 统计行 / 账号卡 / 空态都走共用模块），
   * 只是数据字段与操作按钮的实际内容不同。
   */
  function WorkBuddyAccountsPanel({
    region,
    onRegion,
    status,
    loading,
    error,
    onRescan,
    onCheckin,
    busyId,
    onAddAccount,
    login,
  }) {
    const accounts = asArray(status?.accounts);
    const cooling = accounts.filter((a) => a.cooling === true).length;
    const usable = accounts.filter((a) => a.cooling !== true && a.disabled !== true).length;
    const totalCredits = accounts.reduce(
      (sum, a) => sum + (typeof a.credits?.total === 'number' ? a.credits.total : 0),
      0,
    );

    return jsxs('div', {
      className: 'wbc-col',
      children: [
        jsx(ColumnHead, {
          title: 'WorkBuddy',
          tabs: [
            { id: 'cn', label: '国内版' },
            { id: 'global', label: '国际版' },
          ],
          activeTab: region,
          onTab: onRegion,
          actions: [
            { label: loading ? '检测中…' : '重新检测', disabled: loading, onClick: onRescan },
            ...(typeof onAddAccount === 'function'
              ? [
                  {
                    label: login?.pending === true ? '登录中…' : '添加账号',
                    disabled: login?.pending === true,
                    onClick: onAddAccount,
                  },
                ]
              : []),
          ],
        }),
        // 登录进行中的提示：告诉用户去浏览器完成，别以为卡住了
        login?.pending === true
          ? jsxs('div', {
              className: 'wbc-note',
              children: [
                jsx('div', { children: '已在浏览器打开登录页，请在里面完成登录后回到这里。' }),
                login.opened === false
                  ? jsxs('div', {
                      children: [
                        '浏览器没能自动打开，请手动访问：',
                        jsx('a', {
                          href: login.authUrl,
                          target: '_blank',
                          rel: 'noreferrer',
                          children: login.authUrl,
                        }),
                      ],
                    })
                  : null,
              ],
            })
          : null,
        error !== null
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        login?.error !== undefined && login?.error !== null
          ? jsx('div', { className: 'wbc-err', children: `添加账号失败：${login.error}` })
          : null,
        status === null && loading
          ? jsx('div', { className: 'wbc-note', children: '正在读取 WorkBuddy 账号…' })
          : null,
        status === null
          ? null
          : jsx(StatsRow, {
              items: [
                { label: '账号', value: fmtNum(accounts.length), sub: '个已登录' },
                { label: '正常', value: fmtNum(usable), sub: '可轮换' },
                { label: '冷却中', value: fmtNum(cooling), sub: '被限流' },
                { label: '总积分', value: fmtNum(totalCredits), sub: '合计' },
              ],
            }),
        accounts.length === 0
          ? jsx(EmptyBox, {
              lines: [
                '这边还没有检测到已登录的 WorkBuddy 账号。',
                '可以点上面的「添加账号」在浏览器里登录一个，也可以先在 WorkBuddy 桌面版里登录再点「重新检测」。',
              ],
            })
          : jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsx(
                  AccountCard,
                  {
                    name: a.nickname || a.label || a.id,
                    dim: a.cooling === true || a.disabled === true,
                    tags: [
                      a.cooling
                        ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' }
                        : { text: '正常', cls: 'wbc-tag wbc-tag-on' },
                      a.disabled ? { text: '已停用', cls: 'wbc-tag' } : null,
                    ],
                    rows: [
                      { k: '额度', v: fmtNum(a.credits?.total) },
                      {
                        k: '签到',
                        v:
                          a.checkin === undefined
                            ? a.checkinError
                              ? '不可用'
                              : '–'
                            : a.checkin.todayCheckedIn
                              ? `今日已签 · 连签 ${a.checkin.streakDays ?? 0} 天`
                              : `未签到 · 连签 ${a.checkin.streakDays ?? 0} 天`,
                      },
                      a.expiresAt
                        ? { k: '令牌到期', v: fmtTime(Date.parse(a.expiresAt)) }
                        : null,
                    ],
                    action: {
                      label: busyId === a.id ? '签到中…' : '签到领取',
                      disabled: busyId === a.id || a.cooling === true,
                      onClick: () => onCheckin(a.id),
                    },
                  },
                  a.id,
                ),
              ),
            }),
      ],
    });
  }
  //#endregion

  //#region 积分页
  function CreditsTab({ status, summary, loading }) {
    const accounts = asArray(status?.accounts);
    const rows = asArray(summary?.accounts);
    const liveTotal = accounts.reduce(
      (sum, a) => sum + (typeof a.credits?.total === 'number' ? a.credits.total : 0),
      0,
    );
    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-cards',
          children: [
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '当前总积分' }),
                jsx('div', { className: 'wbc-sum-value', children: fmtNum(liveTotal) }),
                jsx('div', {
                  className: 'wbc-sum-sub',
                  children: `${accounts.length} 个账号`,
                }),
              ],
            }),
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '采样记录' }),
                jsx('div', { className: 'wbc-sum-value', children: fmtNum(summary?.totalSamples ?? 0) }),
                jsx('div', { className: 'wbc-sum-sub', children: '条积分快照' }),
              ],
            }),
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '历史跨度' }),
                jsx('div', {
                  className: 'wbc-sum-value',
                  children: loading ? '…' : `${summary?.dailyTrend?.length ?? 0} 天`,
                }),
                jsx('div', { className: 'wbc-sum-sub', children: '按天统计' }),
              ],
            }),
          ],
        }),
        accounts.length === 0
          ? jsx('div', { className: 'wbc-empty', children: '暂无账号数据。' })
          : jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsxs(
                  'div',
                  {
                    className: 'wbc-card',
                    children: [
                      jsxs('div', {
                        className: 'wbc-card-head',
                        children: [
                          jsx('span', { className: 'wbc-name', children: a.nickname || a.label || a.id }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'wbc-kv',
                        children: [
                          jsx('span', { className: 'wbc-k', children: '总额' }),
                          jsx('span', { className: 'wbc-v', children: fmtNum(a.credits?.total) }),
                        ],
                      }),
                      asArray(a.credits?.packages).length > 0
                        ? jsx('div', {
                            className: 'wbc-packs',
                            children: asArray(a.credits?.packages)
                              .filter((p) => (p.size ?? 0) > 0)
                              .slice(0, 6)
                              .map((p, i) =>
                                jsxs(
                                  'div',
                                  {
                                    className: 'wbc-pack',
                                    children: [
                                      jsx('span', { className: 'wbc-pack-name', children: p.packageName ?? '–' }),
                                      jsx('span', {
                                        className: 'wbc-pack-val',
                                        children: `${fmtNum(p.remain)} / ${fmtNum(p.size)}`,
                                      }),
                                    ],
                                  },
                                  `${p.packageName ?? 'p'}-${i}`,
                                ),
                              ),
                          })
                        : jsx('div', { className: 'wbc-note', children: '无积分包明细' }),
                      a.creditsError ? jsx('div', { className: 'wbc-err', children: a.creditsError }) : null,
                    ],
                  },
                  a.id,
                ),
              ),
            }),
      ],
    });
  }
  //#endregion

  //#region 使用记录页
  function HistoryTab({ summary, loading }) {
    const trend = asArray(summary?.dailyTrend);
    const rows = asArray(summary?.accounts);
    const maxAbs = trend.reduce((m, d) => Math.max(m, Math.abs(d.delta)), 0) || 1;

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: '每日净变化' }),
            jsx('div', {
              className: 'wbc-desc',
              children: '同一天内最后观测值减去最初观测值；正数是当天入账，负数是当天消耗。',
            }),
          ],
        }),
        trend.length === 0
          ? jsx('div', {
              className: 'wbc-empty',
              children: loading ? '正在读取…' : '还没有采样记录。打开本页时会自动采集一次当前额度。',
            })
          : jsxs('div', {
              className: 'wbc-table-wrap',
              children: [
                jsxs('div', { className: 'wbc-spark', style: { padding: '12px' } ,
                  children: trend.slice(-40).map((d, i) =>
                    jsx('div', {
                      className: 'wbc-spark-bar wbc-spark-bar-on',
                      style: { height: `${Math.max(2, (Math.abs(d.delta) / maxAbs) * 36)}px` },
                      title: `${d.day}: ${d.delta >= 0 ? '+' : ''}${d.delta}`,
                    }, `${d.day}-${i}`),
                  ),
                }),
                jsxs('table', {
                  className: 'wbc-table',
                  children: [
                    jsx('thead', {
                      children: jsxs('tr', {
                        children: [
                          jsx('th', { children: '日期' }),
                          jsx('th', { className: 'wbc-num', children: '净变化' }),
                        ],
                      }),
                    }),
                    jsx('tbody', {
                      children: trend
                        .slice()
                        .reverse()
                        .map((d) =>
                          jsxs(
                            'tr',
                            {
                              children: [
                                jsx('td', { children: d.day }),
                                jsx('td', {
                                  className: d.delta > 0 ? 'wbc-num wbc-pos' : d.delta < 0 ? 'wbc-num wbc-neg' : 'wbc-num',
                                  children: `${d.delta >= 0 ? '+' : ''}${fmtNum(d.delta)}`,
                                }),
                              ],
                            },
                            d.day,
                          ),
                        ),
                    }),
                  ],
                }),
              ],
            }),
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: '账号明细' }),
            jsx('div', {
              className: 'wbc-desc',
              children: '首次观测与最新观测的对比。',
            }),
          ],
        }),
        rows.length === 0
          ? jsx('div', { className: 'wbc-empty', children: '暂无记录。' })
          : jsx('div', {
              className: 'wbc-table-wrap',
              children: jsxs('table', {
                className: 'wbc-table',
                children: [
                  jsx('thead', {
                    children: jsxs('tr', {
                      children: [
                        jsx('th', { children: '账号' }),
                        jsx('th', { className: 'wbc-num', children: '首次' }),
                        jsx('th', { className: 'wbc-num', children: '最新' }),
                        jsx('th', { className: 'wbc-num', children: '变化' }),
                        jsx('th', { children: '最近观测' }),
                      ],
                    }),
                  }),
                  jsx('tbody', {
                    children: rows.map((r) =>
                      jsxs(
                        'tr',
                        {
                          children: [
                            jsx('td', { children: r.nickname || r.uid }),
                            jsx('td', { className: 'wbc-num', children: fmtNum(r.firstCredit) }),
                            jsx('td', { className: 'wbc-num', children: fmtNum(r.credit) }),
                            jsx('td', {
                              className: r.delta > 0 ? 'wbc-num wbc-pos' : r.delta < 0 ? 'wbc-num wbc-neg' : 'wbc-num',
                              children: `${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)}`,
                            }),
                            jsx('td', { title: fmtTime(r.lastTs), children: fmtRelative(r.lastTs) }),
                          ],
                        },
                        r.uid,
                      ),
                    ),
                  }),
                ],
              }),
            }),
      ],
    });
  }
  //#endregion

  //#region 账号页（右列：Trae）
  /**
   * 右列：Trae 账号。
   *
   * 骨架与左列 WorkBuddy **完全一致**（列头 / 统计行 / 账号卡 / 空态都走共用模块）；
   * 卡片底部的按钮只出现在**当前绑定**的那张卡上 —— 签到路由是按区域结算当前账号的
   * （`POST /checkin?region=…`），没有「给任意账号签到」的接口，所以不给备用账号
   * 摆一个按不动的按钮。
   *
   * 数据来自 lib/trae.js 已有的三条路由（合并前就存在，路径未改）：
   *   GET  /plugins/dsh-connect-trae/usage?region=cn|ai
   *        区域文档：status(signed-in/signed-out)、accounts[]、credits、checkin
   *   POST /plugins/dsh-connect-trae/accounts/refresh?region=…
   *        重新扫描本机 Trae 登录
   *   POST /plugins/dsh-connect-trae/checkin?region=…
   *        对当前绑定账号领取每日签到
   *
   * 只读为主：账号绑定与模型勾选在 Trae 配置标签页里改，本列不重复那套控件。
   * 切换区域时**两个区域各拉一次**也很贵（credits 是实时计费调用），
   * 所以只在真正切到某个区域时才拉它。
   */
  function TraeAccountsPanel({
    region,
    onRegion,
    status,
    credits,
    loading,
    error,
    onRescan,
    onCheckin,
    busy,
    onAddAccount,
    login,
  }) {
    const accounts = asArray(status?.accounts);
    const selected = accounts.find((a) => a.selected === true) ?? null;
    const current = status?.accountName ?? selected?.accountName ?? null;
    const signedIn = status?.status === 'signed-in';

    return jsxs('div', {
      className: 'wbc-col',
      children: [
        jsx(ColumnHead, {
          title: 'Trae',
          tabs: TRAE_REGIONS,
          activeTab: region,
          onTab: onRegion,
          actions: [
            { label: loading ? '检测中…' : '重新检测', disabled: loading, onClick: onRescan },
            ...(typeof onAddAccount === 'function'
              ? [
                  {
                    label: login?.pending === true ? '登录中…' : '添加账号',
                    disabled: login?.pending === true,
                    onClick: onAddAccount,
                  },
                ]
              : []),
          ],
        }),
        login?.pending === true
          ? jsxs('div', {
              className: 'wbc-note',
              children: [
                jsx('div', { children: '已在浏览器打开官方授权页，登录后自动回到这里。' }),
                login.opened === false
                  ? jsxs('div', {
                      children: [
                        '浏览器没能自动打开，请手动访问：',
                        jsx('a', { href: login.authUrl, target: '_blank', rel: 'noreferrer', children: login.authUrl }),
                      ],
                    })
                  : null,
              ],
            })
          : null,
        error !== null
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        login?.error !== undefined && login?.error !== null
          ? jsx('div', { className: 'wbc-err', children: `添加账号失败：${login.error}` })
          : null,
        status === null && loading
          ? jsx('div', { className: 'wbc-note', children: '正在读取 Trae 账号…' })
          : null,
        status !== null && !signedIn
          ? jsx(EmptyBox, {
              lines: [
                `这边还没有检测到可用的 Trae ${region === 'ai' ? '国际版' : '国内版'}登录。`,
                '请在 Trae 客户端里登录，然后点上面的「重新检测」。',
                status?.message !== void 0 ? `（${String(status.message)}）` : null,
              ],
            })
          : null,
        signedIn
          ? jsx(StatsRow, {
              items: [
                { label: '当前账号', value: current ?? '–', sub: `已检测到 ${accounts.length} 个登录`, small: true },
                { label: '通用余额', value: fmtNum(credits?.generalAvailable), sub: 'general' },
                { label: '工作余额', value: fmtNum(credits?.workAvailable), sub: 'work' },
                {
                  label: '签到',
                  value:
                    status.checkin?.checkedIn === true
                      ? '今日已签到'
                      : status.checkin?.enabled === false
                        ? '无签到活动'
                        : '可签到',
                  sub: status.checkin?.credits !== void 0 ? `+${fmtNum(status.checkin.credits)} 积分` : null,
                  small: true,
                },
              ],
            })
          : null,
        status !== null && status.creditsError !== void 0
          ? jsx('div', { className: 'wbc-err', children: `余额读取失败：${status.creditsError}` })
          : null,
        accounts.length > 0
          ? jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsx(
                  AccountCard,
                  {
                    name: a.accountName ?? a.id ?? '(未命名)',
                    dim: a.selected !== true,
                    tags: [
                      a.selected === true
                        ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                        : { text: '备用', cls: 'wbc-tag' },
                      a.edition !== void 0 ? { text: String(a.edition), cls: 'wbc-tag' } : null,
                    ],
                    // 与左列 WorkBuddy 同款字段：额度 / 可用 / 令牌到期 / 区域。
                    // Trae 的余额是**整体**的（只结算当前绑定账号），所以只有
                    // selected 那个有数，其余显示 –（不编造数字）。
                    rows: [
                      {
                        k: '额度',
                        v: a.selected === true && credits ? fmtNum(credits.total) : '–',
                      },
                      {
                        k: '可用',
                        v: a.selected === true && credits ? fmtNum(credits.available) : '–',
                      },
                      a.tokenExpiresAtMs !== void 0
                        ? { k: '令牌到期', v: fmtTime(a.tokenExpiresAtMs) }
                        : null,
                      { k: '区域', v: a.region === 'ai' ? '国际版' : '国内版' },
                    ],
                    // 只有当前绑定账号能签到（路由按区域结算当前账号）
                    action:
                      a.selected === true && signedIn
                        ? {
                            label: busy ? '签到中…' : '签到',
                            disabled: loading || busy,
                            onClick: onCheckin,
                          }
                        : null,
                  },
                  String(a.id ?? a.accountName),
                ),
              ),
            })
          : null,
      ],
    });
  }
  //#endregion

  //#region 账号页（两列合并）
  /**
   * 账号页：WorkBuddy 与 Trae 并排两列。
   *
   * 两侧各自管自己的区域、加载、错误与签到，互不影响 —— 两列的状态在
   * WotrPage 里就是分开的，这里只是把它们放进同一个网格。
   *
   * 布局：`repeat(auto-fit, minmax(300px, 1fr))`。
   * 面板窄（设置对话框默认宽度）时自动**塌成一列**上下排列，
   * 不会把两张卡片挤到没法看。两列合计可用宽度够时才是真正的左右两列。
   */
  function AccountsTab({ wb, trae }) {
    return jsx('div', {
      className: 'wbc-cols',
      children: [
        jsx(WorkBuddyAccountsPanel, wb),
        jsx(TraeAccountsPanel, trae),
      ],
    });
  }
  //#endregion

  //#region 输入框下方的「当前模型额度」胶囊
  //
  // 挂在 `conversation.composer.dock`（conversation 包声明为
  // `{ kind: "list", scope: "session" }`，输入框正下方那一行，内置的
  // 「tok/s · 缓存命中」胶囊就在同一行）。
  //
  // 它回答一个问题：**当前选中的模型，这个池还剩多少积分。**
  // 所以先要拿到「当前模型」—— 那是 model-selection 包的服务
  // `modelDirectories`，按会话给一份目录 store：
  //
  //   models.directoryFor(sessionId).store.getSnapshot()
  //     → { groups: [{id, models}], current: { provider, model } }
  //
  // `current.provider` 就是 provider id。只有四种属于本插件：
  //   workbuddy-xdpool / workbuddy-xdpool-global / trae / trae-global
  // 别的 provider（DeepSeek 官方等）一律**不渲染** —— 这行是内置胶囊的
  // 地盘，不该被一个显示无关信息的控件占位。
  //
  // 取数成本是这里最需要克制的地方：两个状态接口都会真的向上游发起
  // **计费调用**（WorkBuddy 每账号一次 credits 查询），所以：
  //   - 绝不定时轮询，只在挂载、切模型、点击时取；
  //   - 结果按 provider 缓存 90 秒，同一 provider 反复切换不重复打；
  //   - 失败静默降级为不显示，绝不因为拿不到额度影响输入框。

  /** provider id → 这个胶囊要查的池 */
  const CREDIT_SOURCES = {
    'workbuddy-xdpool': { kind: 'wb', region: 'cn', label: 'WorkBuddy' },
    'workbuddy-xdpool-global': { kind: 'wb', region: 'global', label: 'WorkBuddy 国际版' },
    trae: { kind: 'trae', region: 'cn', label: 'Trae' },
    'trae-global': { kind: 'trae', region: 'ai', label: 'Trae 国际版' },
  };

  /** 缓存 TTL：90 秒内同一 provider 不重复请求（每次请求都是真实计费调用） */
  const CREDIT_TTL_MS = 90000;
  /**
   * 模块级缓存：key 是 provider id。
   *
   * 刻意放在组件外 —— 胶囊在每次会话切换时都会重新挂载，缓存放组件内
   * 就等于没有缓存。挂起中的 promise 也一起存，避免快速切换时并发打两发。
   */
  const creditCache = new Map();

  function readCreditCache(provider) {
    const hit = creditCache.get(provider);
    if (hit === undefined) return undefined;
    if (hit.pending !== undefined) return hit;
    if (Date.now() - hit.atMs > CREDIT_TTL_MS) {
      creditCache.delete(provider);
      return undefined;
    }
    return hit;
  }

  /**
   * 取某个 provider 的剩余积分。
   *
   * 返回值形如 `{ total, accounts }`，取不到时 `total` 为 undefined ——
   * 调用方一律按「不显示数字」处理，不区分失败原因（原因进 title）。
   */
  async function fetchCredits(source) {
    if (source.kind === 'wb') {
      const data = await fetchJson(`${POOL_API}/status?region=${source.region}`);
      const accounts = asArray(data?.accounts);
      let total = 0;
      let seen = false;
      for (const a of accounts) {
        const v = a?.credits?.total;
        if (typeof v === 'number' && Number.isFinite(v)) {
          total += v;
          seen = true;
        }
      }
      return { total: seen ? total : undefined, accounts: accounts.length };
    }
    const data = await fetchJson(`${TRAE_API}/usage?region=${source.region}`);
    const general = data?.credits?.generalAvailable;
    const work = data?.credits?.workAvailable;
    let total;
    if (typeof general === 'number' && Number.isFinite(general)) {
      total = general + (typeof work === 'number' && Number.isFinite(work) ? work : 0);
    }
    return { total, accounts: asArray(data?.accounts).length };
  }

  /** 发起（或复用）一次取数，返回缓存记录 */
  function requestCredits(provider, source) {
    const existing = readCreditCache(provider);
    if (existing !== undefined) return existing;
    const rec = { atMs: Date.now(), pending: undefined, total: undefined, error: undefined };
    rec.pending = fetchCredits(source)
      .then((r) => {
        rec.total = r.total;
        rec.accounts = r.accounts;
      })
      .catch((e) => {
        rec.error = e?.message ?? String(e);
      })
      .finally(() => {
        rec.pending = undefined;
        rec.atMs = Date.now();
      });
    creditCache.set(provider, rec);
    return rec;
  }

  /**
   * 订阅一个 model directory store 的当前选中项。
   *
   * 刻意不用 `useSyncExternalStore`：它对 getSnapshot 的返回做引用相等检查，
   * 而这个 store 每次可能给出新对象，容易被判定为「每次都在变」并触发
   * React 警告或无限重渲染。用订阅 + setState 的朴素写法最稳。
   */
  function useCurrentModel(resolveModelDirectory, sessionId) {
    const [current, setCurrent] = useState(null);
    useEffect(() => {
      if (typeof resolveModelDirectory !== 'function' || sessionId === undefined) return undefined;
      let store;
      try {
        store = resolveModelDirectory(sessionId);
      } catch {
        return undefined;
      }
      if (store === undefined || typeof store.subscribe !== 'function') return undefined;
      const sync = () => {
        try {
          const snap = store.getSnapshot?.();
          const cur = snap?.current;
          setCurrent(
            cur === undefined || cur === null
              ? null
              : { provider: cur.provider ?? '', model: cur.model ?? '' },
          );
        } catch {
          setCurrent(null);
        }
      };
      sync();
      try {
        return store.subscribe(sync);
      } catch {
        return undefined;
      }
    }, [resolveModelDirectory, sessionId]);
    return current;
  }

  /**
   * 输入框下方的额度胶囊。
   *
   * props 由 slot 契约给出：`sessionId`（scope: session）+ 本包 inject 的
   * `resolveModelDirectory`。任何一环拿不到就返回 null —— 这是「只增不减」
   * 的边界：宁可不显示，也绝不能让 composer 这一行报错。
   */
  function ComposerCreditsPill({ sessionId, resolveModelDirectory }) {
    const current = useCurrentModel(resolveModelDirectory, sessionId);
    const provider = current?.provider ?? '';
    const source = CREDIT_SOURCES[provider];

    const [tick, setTick] = useState(0);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      if (source === undefined) return undefined;
      ensureCss();
      let alive = true;
      const rec = readCreditCache(provider);
      if (rec !== undefined) {
        if (rec.pending !== undefined) {
          rec.pending.then(() => {
            if (alive) setTick((n) => n + 1);
          });
        }
        return () => {
          alive = false;
        };
      }
      // 冷缓存：挂载时取一次。失败在下面按「无数字」渲染。
      setBusy(true);
      const fresh = requestCredits(provider, source);
      fresh.pending?.then(() => {
        if (alive) {
          setBusy(false);
          setTick((n) => n + 1);
        }
      });
      return () => {
        alive = false;
      };
      // provider 变了要重新取；tick 只用于强制重渲染，不进依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider]);

    if (source === undefined) return null;
    const rec = readCreditCache(provider);
    const total = rec?.total;
    const title =
      total === undefined
        ? `${source.label}：额度读取中…（点击重试）`
        : `${source.label} · 剩余 ${fmtNum(total)} 积分` +
          (typeof rec?.accounts === 'number' && rec.accounts > 0 ? ` · ${rec.accounts} 个账号` : '') +
          (rec?.error ? ` · ${rec.error}` : '');

    return jsx('button', {
      type: 'button',
      className: 'wotr-credit-pill',
      'data-busy': busy ? '1' : '0',
      'data-state': typeof total === 'number' && total <= 0 ? 'warn' : 'ok',
      title,
      onClick: () => {
        // 点击强制刷新：先清缓存再取，绕开 TTL
        creditCache.delete(provider);
        setBusy(true);
        const fresh = requestCredits(provider, source);
        fresh.pending?.then(() => {
          setBusy(false);
          setTick((n) => n + 1);
        });
      },
      children: [
        jsx('span', { className: 'wotr-credit-pill-dot' }),
        jsx('span', {
          className: 'wotr-credit-pill-num',
          children: total === undefined ? '积分 –' : `积分 ${fmtNum(total)}`,
        }),
      ],
    });
  }
  //#endregion

  /** 设置页主组件。props 来自 slots 契约：{ close, ...inject 的返回值 } */
  function WotrPage(props) {
    ensureCss();

    const [tab, setTab] = useState('pool-config');
    const [region, setRegion] = useState('cn');
    const [status, setStatus] = useState(null);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);

    // —— Trae 半边自己的状态（与 WorkBuddy 完全独立）——
    // 区域用 ai/cn，与 WorkBuddy 的 cn/global 是两套命名，刻意分开两个 state，
    // 免得切 WorkBuddy 的区域时把 Trae 的也带偏。
    const [traeRegion, setTraeRegion] = useState('cn');
    const [traeStatus, setTraeStatus] = useState(null);
    const [traeLoading, setTraeLoading] = useState(false);
    const [traeError, setTraeError] = useState(null);
    const [traeBusy, setTraeBusy] = useState(false);

    /**
     * 「浏览器登录添加账号」的进行状态。
     *
     * 只有 WorkBuddy 侧有（Trae 的登录协议还没查清，见 lib/wb-auth.mjs 注释）。
     * pending 期间列头按钮转「登录中…」并提示用户去浏览器完成，
     * 避免用户以为点了没反应。
     */
    const [login, setLogin] = useState(null);
    // Trae 侧自己的登录状态（与 WorkBuddy 分开：两家的登录流程完全不同）
    const [traeLogin, setTraeLogin] = useState(null);

    const loadStatus = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson(`${POOL_API}/status?region=${region}`);
        setStatus(data);
        return data;
      } catch (e) {
        setError(e?.message ?? String(e));
        return null;
      } finally {
        setLoading(false);
      }
    }, [region]);

    const loadSummary = useCallback(async () => {
      setSummaryLoading(true);
      try {
        const data = await fetchJson(`${SELF_API}/history-summary`);
        setSummary(data);
      } catch {
        /* 历史记录读不到不影响其它 tab */
      } finally {
        setSummaryLoading(false);
      }
    }, []);

    // 首次进页 + 切换区域时拉取；同时把当前状态回写一份采样
    useEffect(() => {
      loadStatus();
    }, [loadStatus]);

    useEffect(() => {
      loadSummary();
    }, [loadSummary]);

    // 拿到最新 status 后落一次采样，让「使用记录」持续增长。
    // 放在这里而不是定时器：只在用户真的打开本页时采集，不做后台轮询。
    useEffect(() => {
      if (status === null || !Array.isArray(status.accounts)) return;
      fetch(`${SELF_API}/sample`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region }),
      })
        .then(() => loadSummary())
        .catch(() => {});
    }, [status, region, loadSummary]);

    const onRescan = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        await fetchJson(`${POOL_API}/accounts/rescan`, { method: 'POST' });
        await loadStatus();
      } catch (e) {
        setError(e?.message ?? String(e));
        setLoading(false);
      }
    }, [loadStatus]);

    const onCheckin = useCallback(
      async (accountId) => {
        setBusyId(accountId);
        try {
          await fetchJson(`${POOL_API}/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId }),
          });
          await loadStatus();
        } catch (e) {
          setError(e?.message ?? String(e));
        } finally {
          setBusyId(null);
        }
      },
      [loadStatus],
    );

    /**
     * 拉取 Trae 一个区域的账号文档。
     *
     * 只在真正切到 Trae 标签页、或切换区域时调用：`/usage` 里的 credits 是
     * 一次实时计费读，进页就无脑拉两边会白花两次配额。
     */
    const loadTrae = useCallback(async (which) => {
      const target = which ?? traeRegion;
      setTraeLoading(true);
      setTraeError(null);
      try {
        const data = await fetchJson(`${TRAE_API}/usage?region=${target}`);
        setTraeStatus(data);
      } catch (e) {
        setTraeError(e?.message ?? String(e));
        setTraeStatus(null);
      } finally {
        setTraeLoading(false);
      }
    }, [traeRegion]);

    /**
     * 第一次切到「账号」标签页时才拉 Trae。
     *
     * 用 ref 记住「已经拉过」，这样在标签页之间来回切
     * 不会反复触发实时计费读；切 Trae 自己的区域走 onTraeRegion。
     *
     * 为什么仍然懒加载：WorkBuddy 那半的状态进页就拉（便宜），
     * 而 Trae 的 `/usage` 里的 credits 是一次**实时计费调用**。
     * 账号页现在是两列并排，但没打开它之前不该花这笔钱。
     *
     * 位置要求：本 effect 必须排在 `loadTrae` 的 `const` 定义**之后**。
     * 早先它写在前面的 useRef/useEffect 区块里，依赖数组 `[tab, loadTrae]`
     * 会在 `loadTrae` 初始化前就读它，抛
     * "Cannot access 'loadTrae' before initialization" —— 这是渲染期抛错，
     * 表现为设置面板白屏（渲染测试正是因此 30 项全灭）。
     */
    const traeLoaded = useRef(false);
    useEffect(() => {
      if (tab !== 'accounts' || traeLoaded.current) return;
      traeLoaded.current = true;
      loadTrae();
    }, [tab, loadTrae]);

    const onTraeRegion = useCallback(
      (next) => {
        setTraeRegion(next);
        loadTrae(next);
      },
      [loadTrae],
    );

    const onTraeRescan = useCallback(async () => {
      setTraeLoading(true);
      setTraeError(null);
      try {
        await fetchJson(`${TRAE_API}/accounts/refresh?region=${traeRegion}`, { method: 'POST' });
        await loadTrae();
      } catch (e) {
        setTraeError(e?.message ?? String(e));
        setTraeLoading(false);
      }
    }, [traeRegion, loadTrae]);

    const onTraeCheckin = useCallback(async () => {
      setTraeBusy(true);
      setTraeError(null);
      try {
        await fetchJson(`${TRAE_API}/checkin?region=${traeRegion}`, { method: 'POST' });
        await loadTrae();
      } catch (e) {
        setTraeError(e?.message ?? String(e));
      } finally {
        setTraeBusy(false);
      }
    }, [traeRegion, loadTrae]);

    /**
     * 打开一次「浏览器登录」来添加一个 WorkBuddy 账号。
     *
     * 协议要点（详见 lib/wb-auth.mjs）：**不是** OAuth 授权码流程，
     * 是「服务端发 authUrl → 浏览器登录 → 拿 state 轮询换 token」。
     * 所以这里没有本地回调服务，也不需要 redirect_uri；轮询由服务端推进，
     * 前端只负责「打开页面 + 问进度 + 显示结果」。
     *
     * 只有 WorkBuddy 侧有这个入口：Trae 的登录协议我没查到可信端点，
     * 宁可不给按钮，也不放一个按下去必失败的假功能。
     */
    const loginAlive = useRef(true);
    // 进行中的登录会话 id（WorkBuddy / Trae 各自一份）
    const loginSessionRef = useRef(null);
    useEffect(() => () => { loginAlive.current = false; }, []);

    const onAddAccount = useCallback(async () => {
      setLogin({ pending: true });
      try {
        const started = await fetchJson(`${SELF_API}/wb/login/start`, { method: 'POST' });
        if (started?.error !== undefined) {
          setLogin({ error: started.error });
          return;
        }
        loginSessionRef.current = started.sessionId;
        const authUrl = started.authUrl;
        /**
         * **不要**无条件再开一个标签页。
         *
         * 服务端 `beginLogin` 已经用 `openInSystemBrowser` 打开过系统浏览器了
         * （`opened === true` 就是它成功的回执）。这里再 `window.open` 一次，
         * 用户点一下「添加账号」会看到**两个**登录页 —— 其中一个的回调还不
         * 一定被这次会话接住，正是「连着弹出好几个页面」的直接原因。
         *
         * 只有服务端**没打开成功**时才由前端补开（例如宿主禁了子进程），
         * 下面照常给出可手动打开的链接作为兜底。
         */
        if (started.opened !== true) {
          try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(authUrl, '_blank', 'noopener');
            }
          } catch {
            /* 弹窗被拦下时走手动打开 */
          }
        }
        setLogin({ pending: true, authUrl, opened: started.opened === true });

        const deadline = Date.now() + 5 * 60 * 1000;
        while (loginAlive.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const st = await fetchJson(
            `${SELF_API}/wb/login/status?session=${encodeURIComponent(started.sessionId)}`,
          );
          if (!loginAlive.current) return;
          if (st?.error !== undefined) {
            setLogin({ error: st.error });
            return;
          }
          if (st?.status === 'done') {
            loginSessionRef.current = null;
            setLogin(null);
            // 凭据已落盘，让池重新扫描，新账号立刻出现在左列
            await loadStatus();
            return;
          }
          if (st?.status === 'failed') {
            setLogin({ error: st.error ?? '登录失败' });
            return;
          }
        }
        if (!loginAlive.current) return;
        setLogin({ error: '登录超时：请重试' });
        try {
          await fetchJson(
            `${SELF_API}/wb/login/cancel?session=${encodeURIComponent(started.sessionId)}`,
            { method: 'POST' },
          );
        } catch {
          /* 取消失败无所谓，服务端会话有自己的超时 */
        }
      } catch (e) {
        setLogin({ error: e?.message ?? String(e) });
      }
    }, [loadStatus]);


    /**
     * Trae 的「浏览器登录」。
     *
     * 与 WorkBuddy 不同：Trae 是**真** PKCE 授权码流程，回调走本机回环 HTTP
     * （lib/trae-auth.mjs 起的服务），所以这里同样只负责「打开页面 + 轮询 + 展示」。
     *
     * 回调完全自动：授权页登录完成后浏览器自己跳回环地址，插件收到即换 token 入池，
     * 用户不需要复制粘贴任何东西（与 WorkBuddy 的 state 轮询一样都是自动回调）。
     */
    const onTraeAddAccount = useCallback(async () => {
      setTraeLogin({ pending: true });
      try {
        const started = await fetchJson(`${SELF_API}/trae/login/start`, { method: 'POST' });
        if (started?.error !== undefined) {
          setTraeLogin({ error: started.error });
          return;
        }
        /**
         * 与 WorkBuddy 侧同一条规则：服务端已经用系统浏览器打开过了
         * （`opened === true`），前端**不要**再开一个标签页。
         *
         * Trae 这一侧尤其明显：官方授权页自己还会先空参探测回调地址再跳转，
         * 于是「服务端开的 1 个 + 前端开的 1 个 + 官方页的多跳」叠在一起，
         * 用户看到的就是连着好几个页面。
         */
        if (started.opened !== true) {
          try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(started.authUrl, '_blank', 'noopener');
            }
          } catch {
            /* 弹窗被拦下时走手动打开 */
          }
        }
        setTraeLogin({ pending: true, authUrl: started.authUrl, opened: started.opened === true });

        const deadline = Date.now() + 3 * 60 * 1000;
        while (loginAlive.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const st = await fetchJson(
            `${SELF_API}/trae/login/status?session=${encodeURIComponent(started.sessionId)}`,
          );
          if (!loginAlive.current) return;
          if (st?.error !== undefined) {
            setTraeLogin({ error: st.error });
            return;
          }
          if (st?.status === 'done') {
            setTraeLogin(null);
            // 凭据已写入 .trae-auth.<region>.<accountId>.json，让 Trae 侧重读。
            // 号池每次读状态都会重扫凭据目录，所以新账号会立刻出现在号池区。
            await loadTrae();
            return;
          }
          if (st?.status === 'failed') {
            setTraeLogin({ error: st.error ?? '登录失败' });
            return;
          }
        }
        if (!loginAlive.current) return;
        setTraeLogin({ error: '登录超时：请重试' });
        try {
          await fetchJson(
            `${SELF_API}/trae/login/cancel?session=${encodeURIComponent(started.sessionId)}`,
            { method: 'POST' },
          );
        } catch {
          /* 服务端会话有自己的超时 */
        }
      } catch (e) {
        setTraeLogin({ error: e?.message ?? String(e) });
      }
    }, [loadTrae]);


    const tabs = [
      { id: 'pool-config', label: 'XD Pool' },
      { id: 'trae-config', label: 'Trae 配置' },
      { id: 'accounts', label: '账号' },
      { id: 'wb-credits', label: '积分' },
      { id: 'wb-history', label: '使用记录' },
    ];

    return jsxs('div', {
      className: 'wbc-page',
      children: [
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: 'WOTR 管理' }),
            jsx('div', {
              className: 'wbc-desc',
              children:
                '配置并查看 WorkBuddy 账号池与 Trae 接入：模型勾选、分配策略、账号与额度、积分与使用记录。WorkBuddy 与 Trae 都可以直接在浏览器里登录添加（「账号」页左右两列的「添加账号」）；其余仍读取本机客户端已有的登录。',
            }),
          ],
        }),
        jsx('div', {
          className: 'wbc-tabs',
          children: tabs.map((x) =>
            jsx(
              'button',
              {
                type: 'button',
                className: tab === x.id ? 'wbc-tab wbc-tab-on' : 'wbc-tab',
                onClick: () => setTab(x.id),
                children: x.label,
              },
              x.id,
            ),
          ),
        }),
        tab === 'pool-config'
          ? jsx(PoolConfigTab, {
              wbSettings,
              region,
              onRegion: setRegion,
              status,
              loading,
              error,
              onRefresh: loadStatus,
              onRescan,
            })
          : null,
        tab === 'trae-config'
          ? jsx(TraeConfigTab, { scopeSlot: traeSettings })
          : null,
        tab === 'accounts'
          ? jsx(AccountsTab, {
              wb: {
                region,
                onRegion: setRegion,
                status,
                loading,
                error,
                onRescan,
                onCheckin,
                busyId,
                onAddAccount,
                login,
              },
              trae: {
                region: traeRegion,
                onRegion: onTraeRegion,
                status: traeStatus,
                credits: traeStatus?.credits,
                loading: traeLoading,
                error: traeError,
                onRescan: onTraeRescan,
                onCheckin: onTraeCheckin,
                busy: traeBusy,
                onAddAccount: onTraeAddAccount,
                login: traeLogin,
              },
            })
          : null,
        tab === 'wb-credits' ? jsx(CreditsTab, { status, summary, loading }) : null,
        tab === 'wb-history'
          ? jsx(HistoryTab, { summary, loading: summaryLoading })
          : null,
      ],
    });
  }

  /**
   * 把「输入框下方的额度胶囊」挂到页面组件上一起交出去。
   *
   * 为什么挂在函数属性上而不是改返回值形状：生成脚本约定
   * `createConsoleSection(...)` 返回的就是页面组件本身（client.js 会判
   * `typeof Pkg !== 'function'`），改成一个对象会破坏那个既有契约。
   * 挂个静态属性则两边都不用动。
   */
  WotrPage.ComposerCreditsPill = ComposerCreditsPill;

  return WotrPage;
}
