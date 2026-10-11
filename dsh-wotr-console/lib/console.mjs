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
  /**
   * Qoder 半边的 settings 作用域（同一形状：{get,subscribe} 活句柄）。
   *
   * 命名空间是 `dsh-connect-qoder`（宿主按 Loader entry id 作键），由 client.js
   * 的 resolveEntrySettings 按与另两家**同一条**规则解析后传进来。
   *
   * ⚠️ 在 `lib/qoder.js` 的 Config 补上 volatile 标记之前，这个句柄永远是只读
   * 替身：没有 volatile 节点的 schema 会被宿主的 volatileForm() 判成 undefined，
   * describe() 直接跳过该入口 —— 入口不出现在 configForms 镜像里，作用域自然
   * 无从绑定。QoderModelsPanel 会把这种情况显示成诊断行。
   */
  const qoderSettings = embedded?.qoderSettings ?? null;


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
  /**
   * 上下文预算常量（vendored 的 DEFAULT_CONTEXT_BUDGET = 2e5）这里**刻意不定义**。
   *
   * 它原本只服务于页面上那个「限制到 200K」单选项；该选项已移除（理由见
   * PoolConfigTab 的模型卡注释），本页不再需要压低任何模型的上下文窗口 ——
   * 一律用上游原生窗口。留着常量只会让人以为这里还有一条可选路径。
   */
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
  /** 分配策略的展示顺序与中文文案（三个配置页共用同一份） */
  const POOL_DISTRIBUTIONS = [
    { id: 'priority', label: '优先模式', hint: '先用完一个账号，用完再换下一个' },
    { id: 'round-robin', label: '轮换模式', hint: '按顺序轮流使用，积分均匀分摊' },
    { id: 'balanced', label: '均衡模式', hint: '随机抽取，闲置越久的账号被选中概率越高' },
  ];

  /**
   * 设置作用域不可写时的那一句话（三个配置页逐字相同）。
   *
   * 先前三页各写各的：WorkBuddy / Trae 是「无法保存勾选」，Qoder 是一整段带
   * 反引号的诊断。同一个宿主问题在三个页面里长得不一样，用户会以为是三个不同的
   * 毛病。现在同一句短语 + 各页自己的悬停细节（`title`）。
   */
  const READONLY_NOTE = '设置作用域不可写 —— 当前为只读，改动无法保存。';

  /**
   * Qoder 积分额度的**自动刷新节奏**：30 秒，与上游一致。
   *
   * 这个值不是随手定的，取的是本仓库既有先例：`vendor/xdpool/lib/client.js`
   * 的 `POLL_INTERVAL_MS = 3e4`（上游自己刷状态接口的节奏），composer 的积分
   * 胶囊（下面的 `CREDIT_REFRESH_MS`）用的也是它。两处同源，避免出现
   * 「一处 30 秒、另一处 5 分钟」这种各刷各的。
   *
   * 为什么不能更快：`quota/usage` **每次都是一次真实的上游调用**，池里那套 429
   * 冷却正是为这类调用准备的。把它压到几秒会让请求量比号池任何既有行为高一个
   * 数量级，很可能把账号打成限流、连带影响正常对话。
   *
   * 之所以要自动刷而不是手动：额度是「保留额度」判据的输入
   * （`available()` 会把余额 ≤ 保留值的账号挡在轮转外），手动刷意味着判据长期
   * 拿着过期余额做决策 —— 这属于「规则应当同上游」，不该由用户记得点按钮。
   */
  const QODER_CREDITS_REFRESH_MS = 30000;
  /** 单次自动刷新的请求上限：账号再多也不并发，避免被当成异常流量。 */
  const QODER_CREDITS_MAX_ACCOUNTS = 50;

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
/* 分区内容：Section 的 body。竖排间距统一给在这里，页面自己不用再管 */
.wbc-sec-body{display:flex;flex-direction:column;gap:10px;min-width:0}
/* 平铺容器：自身不产生盒子，内容直接参与父级 flex 的间距（Qoder 页用） */
.wbc-flat{display:contents}
.wbc-model{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}
.wbc-model-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-model-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.wbc-model-actions{position:sticky;bottom:0;z-index:2;display:flex;gap:8px;justify-content:flex-end;padding:8px 0;background:var(--dsw-alias-bg-layer-1,#17181c);border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.wbc-model-input{appearance:none;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:11px;padding:3px 6px;width:92px}
.wbc-model-input:disabled{color:var(--dsw-alias-label-secondary)}
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
   *
   * `who` 只用于错误文案（trae / qoder）；两家的写入规则是同一条，差异只有
   * 命名空间，所以共用这一个实现。
   */
  async function writeSettingsField(scope, field, value, landed, who) {
    const label = `${who}: settings 字段 "${field}" 未能写入`;
    if ((await scope.set(field, value)) === false) throw new Error(`${label}（宿主拒绝）`);
    if (!landed(unwrapVolatileDeep(scope.getSnapshot().value))) throw new Error(label);
  }

  /** Trae 半边：沿用原名（调用点很多），实现见 writeSettingsField */
  function writeTraeField(scope, field, value, landed) {
    return writeSettingsField(scope, field, value, landed, 'trae');
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
    const efforts = selection.reasoningEfforts;
    const out = {};
    // `images` 一律跟随上游目录的 supportsImages：页面上没有这个开关（勾了也
    // 改变不了上游判定），保存时同样按目录原样回写 imageModelIds。
    for (const model of asArray(status?.models)) {
      const entry = {
        enabled: enabled === undefined || enabled.includes(model.id),
        images: model.supportsImages === true,
      };
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
    const efforts = selection.reasoningEfforts ?? {};
    // `images` / `budget` 都不再是页面上的开关，所以**不参与脏判定**：
    // 前者随上游目录走，后者恒为「用满原生窗口」。只有启用状态与推理强度
    // 是用户能改的，也只有它们能让「保存 / 放弃修改」浮出来。
    for (const model of models) {
      const entry = draft[model.id];
      if (entry === undefined) continue;
      if (entry.enabled !== enabled.has(model.id)) return true;
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
        const reasoningEfforts = {};
        for (const model of models) {
          const entry = modelBase[model.id];
          if (entry === undefined) continue;
          if (entry.enabled === true) enabledModelIds.push(model.id);
          // 图片能力**没有手动开关**：随上游目录的 supportsImages 走。
          // 页面上不再渲染勾选框（勾了也改不动上游判定），这里按目录原样回写，
          // 与「从 WorkBuddy 刷新」的语义一致。
          if (model.supportsImages === true) imageModelIds.push(model.id);
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
          // 上下文上限同样**没有手动开关**：整段清空 = 每个模型都用满上游原生窗口。
          // 之前页面上那个「限制到 200K」单选只是把 contextBudgets[id] 写成 200000，
          // 而上游判定是「有值且小于原生窗口才压低」，空字典即不压低。
          contextBudgets: {},
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
        const reasoningEfforts = {};
        const imageModelIds = [];
        for (const model of fresh) {
          const prev = prevBase[model.id] ?? {};
          const images = model.supportsImages === true;
          next[model.id] = {
            enabled: true,
            images,
            ...(prev.effort !== undefined ? { effort: prev.effort } : {}),
          };
          const offered = asArray(model.supportedEfforts);
          if (prev.effort !== undefined && (offered.length === 0 || offered.includes(prev.effort))) {
            reasoningEfforts[model.id] = prev.effort;
          }
          if (images) imageModelIds.push(model.id);
        }
        await writeField(poolSelectionKey(region), {
          enabledModelIds: freshIds,
          imageModelIds,
          // 同上：上下文上限没有手动开关，刷新同样不写 contextBudgets。
          contextBudgets: {},
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

    /**
     * 统计格第四项「当前使用」。
     *
     * 池子里「当前用哪个账号」其实有两层：`selectedAccountId` 是用户固定下来的
     * （有值时请求优先用它），`activeAccountId` 是池子按分配策略选出的下一个。
     * 分开写清楚比只显示一个策略名有用 —— 策略本身已经由账号区那排按钮的高亮
     * 表达了，不必再占一格。
     */
    const selectedId =
      typeof status?.selectedAccountId === 'string' ? status.selectedAccountId : '';
    const activeId = typeof status?.activeAccountId === 'string' ? status.activeAccountId : '';
    const currentId = selectedId !== '' ? selectedId : activeId;
    const currentAccount = accounts.find((a) => a.id === currentId) ?? null;
    const currentName =
      currentAccount === null
        ? '自动轮换'
        : shortAccountName(currentAccount.nickname || currentAccount.label || currentAccount.id) ||
          '自动轮换';
    const currentSub = selectedId !== '' ? '已固定，优先用它' : '按分配策略自动选';

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
              // 三个配置页的页头按钮**文案固定**：状态变化交给「正在读取…」
              // 那条说明与禁用态表达，按钮自己不改字 —— 否则同一排按钮在
              // 三页里会分别变成「刷新中…/读取中…/登录中…」，看着像三件事。
              label: '刷新',
              title: '重新扫描本机已登录的 WorkBuddy 账号，并重读账号池状态。',
              disabled: loading,
              onClick: typeof onRescan === 'function' ? onRescan : onRefresh,
            },
          ],
        }),
        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              title: '宿主的 configForms 里没有本插件条目的可写作用域，或它尚未就绪。',
              children: READONLY_NOTE,
            })
          : null,
        error !== null && error !== undefined
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        writeError !== null
          ? jsx('div', { className: 'wbc-err', children: `保存失败：${writeError}` })
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
                { label: '可用', value: fmtNum(usable), sub: '未被停用/冷却' },
                { label: '冷却中', value: fmtNum(cooling), sub: '被限流' },
                {
                  label: '当前使用',
                  value: currentName,
                  sub: currentSub,
                  small: true,
                  ...(currentId === '' ? {} : { title: `账号 id：${currentId}` }),
                },
              ],
            }),
        status !== null && accounts.length === 0
          ? jsx(EmptyBox, {
              lines: [
                '这边还没有检测到已登录的 WorkBuddy 账号。',
                '请先在 WorkBuddy 桌面版里登录，再点上面的「刷新」。',
              ],
            })
          : null,

        /* —— 账号 ——
         *
         * 分配策略（优先 / 轮换 / 均衡）从统计格里挪到这里：它就是这一节的设置，
         * 摆在账号卡旁边才看得出「它管的是下面这些卡」。统计格让给「当前使用」
         * —— 与另两个配置页一致。
         */
        status !== null && accounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个账号 · 冷却 ${fmtNum(cooling)} 个`,
              hint: '同区域的多个登录构成一个号池：被限流或额度耗尽的账号会自动冷却并让位给下一个；取消「参与轮换」即停用该账号。',
              actions: [
                ...POOL_DISTRIBUTIONS.map((d) => ({
                  label: d.label,
                  title: d.hint,
                  primary: distribution === d.id,
                  disabled: !writable || busy === 'distribution',
                  onClick: () => onDistribution(d.id),
                })),
                {
                  label: busy === 'cooldowns' ? '清除中…' : '清除冷却',
                  title: '清掉所有账号的限流冷却，让它们立刻回到轮换里。',
                  disabled: busy === 'cooldowns',
                  onClick: onResetCooldowns,
                },
              ],
              children: jsx('div', {
                className: 'wbc-cards',
                children: accounts.map((a) => {
                  /**
                   * 首标签与压暗规则**与另两页逐字同款**：`isCurrent` 亮着并标
                   * 「当前使用」，其余标「备用」并压暗。先前这里是「正常 / 冷却中」
                   * —— 同一件事（哪张卡在服务）在三页里三种叫法，而且 WorkBuddy
                   * 这边整页看不出是哪张卡在服务（只有顶部统计格里有）。
                   *
                   * `currentId` 为空（宿主没给 activeAccountId）时**不压暗任何卡**：
                   * 「不知道是谁」不等于「都不是它」。
                   */
                  const isCurrent = currentId !== '' && a.id === currentId;
                  const creditTotal = accountCreditsOf(a);
                  return jsx(
                      AccountCard,
                      {
                        name: a.nickname || a.label || a.id,
                        dim: a.cooling === true || a.disabled === true || (currentId !== '' && isCurrent !== true),
                        tags: [
                          isCurrent
                            ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                            : { text: '备用', cls: 'wbc-tag' },
                          a.disabled === true
                            ? { text: '已停用', cls: 'wbc-tag' }
                            : a.cooling === true
                              ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' }
                              : null,
                          a.reserved === true ? { text: '已保留·暂停', cls: 'wbc-tag' } : null,
                          // 限流次数与其他两页一样做成标签（只在真的发生过时出现）
                          // —— 一条永远写着「0 次」的行只是噪声。
                          (a.rateLimitHits ?? 0) > 0
                            ? { text: `限流 ${fmtNum(a.rateLimitHits)} 次`, cls: 'wbc-tag' }
                            : null,
                        ],
                        rows: [
                          a.cooldownUntil !== undefined
                            ? { k: '冷却至', v: fmtTime(a.cooldownUntil) }
                            : null,
                          /**
                           * 余额：`credits` 是**对象**（`{total, packages…}`，上游
                           * 原样透传的那份），早先这里直接 `fmtNum(a.credits)`，
                           * 于是页面上一直显示「通用余额 –」，而真实的 1031 就
                           * 在响应体里。判据统一走 `accountCreditsOf`（三种池的
                           * 字段名差异都在它里面）。
                           */
                          creditTotal !== undefined
                            ? { k: '通用余额', v: fmtNum(creditTotal) }
                            : null,
                          { k: '保留额度', v: (a.creditReserve ?? 0) > 0 ? fmtNum(a.creditReserve) : '不限' },
                        ],
                        // 启停 / 保留额度 / 移出：走共用的 CardActions，
                        // 三个配置页的账号卡逐字同款（先前 WorkBuddy 用勾选、
                        // Trae 与 Qoder 用按钮，同一件事三种手感）。
                        extra: [
                          jsx(
                            CardActions,
                            {
                              locked: !writable,
                              rotating: a.disabled !== true,
                              rotateBusy: busy === a.id,
                              onToggleRotate: (next) => onToggleDisabled(a.id, next !== true),
                              reserveValue: reserveDraft[a.id] ?? String(a.creditReserve ?? 0),
                              onReserveChange: (v) =>
                                setReserveDraft((prev) => ({ ...prev, [a.id]: v })),
                              onSaveReserve: () => onSaveReserve(a.id),
                              saving: busy === `reserve-${a.id}`,
                              onRemove: () => onIgnore(a.id, true),
                              removeBusy: busy === `ignore-${a.id}`,
                            },
                            'actions',
                          ),
                        ],
                        // 主操作：签到领取（唯一一个「对单个账号做一件上游动作」的按钮）
                        action:
                          a.cooling === true
                            ? null
                            : {
                                label: busy === `checkin-${a.id}` ? '签到中…' : '签到领取',
                                disabled: busy === `checkin-${a.id}`,
                                onClick: () => onCheckin(a.id),
                              },
                      },
                    String(a.id ?? a.label),
                  );
                }),
              }),
            })
          : null,

        // —— 已移出账号池（与模型区一样是「名单」，只不过方向相反）——
        ignored.length > 0
          ? jsx(Section, {
              title: '已移出账号池',
              sub: `${fmtNum(ignored.length)} 个`,
              hint: '这些账号不再参与取号，但凭据还在：点「恢复」即可放回池子。',
              children: jsx('div', {
                className: 'wbc-cards',
                children: ignored.map((a) =>
                  jsx(
                    AccountCard,
                    {
                      name: a.nickname || a.label || a.id,
                      dim: true,
                      tags: [{ text: '已移出', cls: 'wbc-tag' }],
                      rows: [
                        // 与账号卡同一条判据：`credits` 是对象（`{total…}`）
                        // 时也要读得出数字，否则这一行会永远显示「–」。
                        accountCreditsOf(a) !== undefined
                          ? { k: '通用余额', v: fmtNum(accountCreditsOf(a)) }
                          : null,
                      ],
                      action: {
                        label: busy === `ignore-${a.id}` ? '恢复中…' : '恢复',
                        disabled: !writable || busy === `ignore-${a.id}`,
                        onClick: () => onIgnore(a.id, false),
                      },
                    },
                    String(a.id ?? a.label),
                  ),
                ),
              }),
            })
          : null,

        /* —— 积分自动化（仅国内版）——
         *
         * 先前这里第二排统计格 + 每个任务一行说明，把一屏塞满了。现在：今日收益
         * 进副标题，五个任务压成一张表 —— 一屏看得完，每个任务的「运行」按钮
         * 与时间表都还在。
         */
        region === 'cn' && automation !== undefined && automation !== null
          ? jsx(Section, {
              title: '积分自动化',
              sub: `今日 +${fmtNum(totals.credit)}（签到 +${fmtNum(totals.checkinCredit)} · 连登 +${fmtNum(totals.bonusCredit)} · 旅行 +${fmtNum(totals.travelCredit)}）`,
              hint: automationOn
                ? '每天自动签到、上报活跃、领取任务奖励与连登奖励，并照看猫猫旅行。'
                : '已关闭：不会替你发起任何后台请求。',
              lead: [
                jsx(
                  'label',
                  {
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
                  },
                  'automation-toggle',
                ),
              ],
              actions: [
                {
                  label: automationRun !== null ? '运行中…' : '立即运行',
                  title: '立刻把所有该做的任务跑一遍（不必等到时间表上的整点）。',
                  disabled: automationRun !== null,
                  onClick: () => onRunAutomation('all'),
                },
              ],
              children: jsx('div', {
                className: 'wbc-table-wrap',
                children: jsxs('table', {
                  className: 'wbc-table',
                  children: [
                    jsx('thead', {
                      children: jsx('tr', {
                        children: ['任务', '时间', '上次结果', ''].map((h, i) =>
                          jsx('th', { children: h }, `auto-h-${i}`),
                        ),
                      }),
                    }),
                    jsx('tbody', {
                      children: POOL_AUTOMATION_JOBS.map((job) => {
                        const rec = poolAutomationJob(status, job.kind);
                        const hours = asArray(poolAutomationHours(status, job.kind));
                        return jsxs(
                          'tr',
                          {
                            children: [
                              jsx('td', { children: job.label }),
                              jsx('td', {
                                children:
                                  hours.length === 0
                                    ? '当天不跑'
                                    : hours
                                        .map((hour) => `${String(hour).padStart(2, '0')}:00`)
                                        .join(' / '),
                              }),
                              jsx('td', { children: poolAutomationNote(rec) }),
                              jsx('td', {
                                className: 'wbc-num',
                                children: jsx('button', {
                                  type: 'button',
                                  className: 'wbc-btn',
                                  disabled: automationRun !== null,
                                  onClick: () => onRunAutomation(job.kind),
                                  children: automationRun === job.kind ? '运行中…' : '运行',
                                }),
                              }),
                            ],
                          },
                          `job-${job.kind}`,
                        );
                      }),
                    }),
                  ],
                }),
              }),
            })
          : null,

        /* —— 模型 ——
         *
         * 放在最后：勾完正好落在 sticky 的保存条上（三页同款）。
         */
        models.length > 0
          ? jsx(Section, {
              title: '模型',
              sub: `已启用 ${fmtNum(enabledCount)} / ${fmtNum(models.length)} 个`,
              hint: '列表来自上游实时目录；「从 WorkBuddy 刷新」会拉一次上游并全部启用（立即生效，无需再点保存）。',
              lead: [
                jsx(
                  'label',
                  {
                    className: 'wbc-check',
                    title: 'Max 模式：满上下文 + 最强思考，按上游上限跑。',
                    children: [
                      jsx('input', {
                        type: 'checkbox',
                        checked: maxMode,
                        disabled: !writable,
                        onChange: (e) => setMaxMode(e.target.checked),
                      }),
                      jsx('span', { children: 'Max 模式' }),
                    ],
                  },
                  'max-mode',
                ),
              ],
              actions: [
                {
                  label: busy === 'refresh' ? '刷新中…' : '从 WorkBuddy 刷新',
                  title:
                    '拉一次上游实时目录：列表更新 + 所有模型自动全启用，立即生效（无需再点保存）。',
                  disabled: !writable || busy === 'refresh' || loading,
                  onClick: refreshCatalog,
                },
                {
                  label: '一键启用所有模型',
                  disabled: !writable,
                  onClick: enableAllModels,
                },
              ],
              children: [
                jsx('div', {
                  className: 'wbc-cols',
                  children: models.map((model) => {
                    const entry = modelBase[model.id] ?? { enabled: false };
                    const native = model.nativeContextWindow ?? model.contextWindow;
                    return jsx(
                      ModelCard,
                      {
                        id: model.id,
                        name: [
                          model.name ?? model.id,
                          model.supportsImages === true ? '图片' : null,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                        checked: entry.enabled === true,
                        disabled: !writable,
                        onToggle: (next) => editModel(model.id, { enabled: next }),
                        meta: [
                          `上下文 ${fmtCapacity(native)}`,
                          model.maxTokens !== undefined
                            ? `输出 ${fmtCapacity(model.maxTokens)}`
                            : null,
                          asArray(model.supportedEfforts).length > 0
                            ? `推理强度：${asArray(model.supportedEfforts).join(' / ')}`
                            : null,
                        ],
                        // 这里原本还挂着两个勾选：「支持图片」（checkbox）与
                        // 「限制到 200K」（radio）。两者都**已从页面移除**：
                        //
                        //   支持图片 —— 上游判定 `supportsImages || imageSet.has(id)`
                        //     是「或」，目录说不支持时勾上也不生效，勾了只是个假开关；
                        //   限制到 200K —— 服务端每次拉目录都会重写 selection，
                        //     手工写入的 contextBudgets 会被下一次刷新覆盖。
                        //
                        // 两处都改成跟着上游走：保存时 imageModelIds 按目录的
                        // supportsImages 生成，contextBudgets 整段清空（用满原生窗口）。
                        extras: [],
                      },
                      model.id,
                    );
                  }),
                }),
                // 保存条挪到列表**底部并 sticky**（与 Trae 页同款）：
                // 模型多时表头会滚出视野，用户勾完最后一项正好在底部，
                // 按钮就在手边 —— 不必再滚回顶部。
                dirty
                  ? jsxs('div', {
                      className: 'wbc-model-actions',
                      children: [
                        jsx('button', {
                          type: 'button',
                          className: 'wbc-btn',
                          disabled: busy === 'models',
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
                    })
                  : null,
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

    /**
     * 号池状态与余额合并成**一张**卡。
     *
     * /usage 一次给两张表：`accounts`（每个登录 + 各自的 credits）与
     * `pool.accounts`（号池状态：冷却 / 停用 / 保留 / 限流次数）。先前页面把
     * 它们渲染成**两排**卡，同一个账号出现两次、各显示一半字段，用户还得对着
     * id 认哪张是哪张。这里按 id 对齐后合成一排：以 accounts 为主（谁登录了），
     * 池里有同 id 的就带上池状态；池里有而 accounts 里没有的（极端情况：池扫到
     * 了但 store 还没认）也照样列出来，不因为对齐失败就凭空少一张卡。
     */
    const poolById = new Map(poolAccounts.map((a) => [String(a.id), a]));
    const cardAccounts = [
      ...accounts.map((account) => ({
        account,
        pool: poolById.get(String(account.id)) ?? null,
      })),
      ...poolAccounts
        .filter((pool) => !accounts.some((account) => String(account.id) === String(pool.id)))
        .map((pool) => ({ account: null, pool })),
    ];
    const traeCooling = poolAccounts.filter((a) => a.cooling === true).length;
    const traeUsable =
      poolAccounts.length === 0
        ? accounts.length
        : poolAccounts.filter((a) => a.cooling !== true && a.disabled !== true).length;
    // 池状态读不到时「冷却中」显示「–」而不是 0：0 会被读成「没有账号在冷却」，
    // 而事实是「这一拍读不到」，两者必须看起来不一样。
    const traeCoolingValue = poolAccounts.length === 0 ? '–' : fmtNum(traeCooling);
    const checkinText =
      usage?.checkin?.checkedIn === true
        ? '今日已签到'
        : usage?.checkin?.enabled === false
          ? '无签到活动'
          : '可签到';
    const checkinCreditText =
      usage?.checkin?.credits !== undefined ? ` +${fmtNum(usage.checkin.credits)}` : '';

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsx(ColumnHead, {
          title: 'Trae',
          tabs: TRAE_REGIONS,
          activeTab: region,
          onTab: (next) => {
            setRegion(next);
            setDraft(null);
            setWriteError(null);
            setSavedNote(null);
          },
          // 供应商开关挨着区域按钮：它是对**当前区域**生效的设置，
          // 与区域切换同属一组，不该被 spacer 推到右边去。
          leading: [
            jsx(
              'label',
              {
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
              },
              'region-toggle',
            ),
          ],
          actions: [
            {
              label: '刷新',
              title: '重读 Trae 账号、余额与号池状态。',
              disabled: usageLoading,
              onClick: () => loadUsage(),
            },
          ],
        }),
        regionOn === false
          ? jsx('div', {
              className: 'wbc-note',
              children: '该供应商已关闭：模型不会提供给 DSH。账号与模型设置都保留，勾回上方复选框即恢复。',
            })
          : null,
        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              title: '宿主的 configForms 里没有本插件条目的可写作用域，或它尚未就绪。',
              children: READONLY_NOTE,
            })
          : null,
        usageError !== null
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${usageError}` })
          : null,
        writeError !== null
          ? jsx('div', { className: 'wbc-err', children: `保存失败：${writeError}` })
          : null,
        savedNote !== null ? jsx('div', { className: 'wbc-note', children: savedNote }) : null,
        usage === null && usageLoading
          ? jsx('div', { className: 'wbc-note', children: '正在读取 Trae 账号…' })
          : null,
        signedIn
          ? jsx(StatsRow, {
              items: [
                { label: '账号', value: fmtNum(accounts.length), sub: '个已登录' },
                { label: '可用', value: fmtNum(traeUsable), sub: '未被停用/冷却' },
                { label: '冷却中', value: traeCoolingValue, sub: '被限流' },
                {
                  label: '当前使用',
                  value: usage.accountName ?? current?.accountName ?? '–',
                  sub: `通用 ${fmtNum(usage.credits?.generalAvailable)} · 工作 ${fmtNum(usage.credits?.workAvailable)}`,
                  small: true,
                },
              ],
            })
          : null,
        usage !== null && !signedIn
          ? jsx(EmptyBox, {
              lines: [
                `这边还没有检测到可用的 Trae ${region === 'ai' ? '国际版' : '国内版'}登录。`,
                '请在 Trae 客户端里登录，或用「账号」页右列的「添加账号」在浏览器里登录。',
              ],
            })
          : null,

        /* —— 账号 ——
         *
         * 先前这一页有**两排**账号卡：顶上一排（切换到此账号 + 余额）与号池区里
         * 那排（停用 / 保留积分），同一个账号出现两次、字段各显示一半，还得自己
         * 对着 id 认哪张是哪张。现在只有一排：号池状态与余额合并到同一张卡，
         * 控件走共用的 CardActions（与 WorkBuddy、Qoder 两页逐字同款）。
         */
        signedIn && cardAccounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个登录 · ${checkinText}${checkinCreditText}`,
              hint: '同区域的多个登录构成一个号池：被限流或额度耗尽的账号会自动冷却并让位给下一个；取消「参与轮换」即停用该账号。',
              // 分配策略与「清除冷却」**永远都在**：三个配置页的账号区右上角
              // 是同一组按钮。早先整排按钮绑在「号池里有账号」上，于是号池快照
              // 还没读回来时按钮会整排消失 —— 分配策略是主要功能，不该因为
              // 列表为空就消失。
              actions: [
                ...POOL_DISTRIBUTIONS.map((d) => ({
                  label: d.label,
                  title: d.hint,
                  primary: poolDoc?.distribution === d.id,
                  disabled: !writable || savingPool !== null,
                  onClick: () => onDistribution(d.id),
                })),
                {
                  label: savingPool === 'cooldowns' ? '清除中…' : '清除冷却',
                  title: '清掉所有账号的限流冷却，让它们立刻回到轮换里。',
                  disabled: savingPool !== null,
                  onClick: onResetCooldowns,
                },
              ],
              children: jsx('div', {
                className: 'wbc-cards',
                children: cardAccounts.map(({ account, pool }) => {
                  const id = String(account?.id ?? pool?.id ?? '');
                  const isCurrent = account?.selected === true || poolDoc?.lastServedId === id;
                  return jsx(
                    AccountCard,
                    {
                      name: account?.accountName ?? pool?.label ?? id ?? '(未命名)',
                      dim: isCurrent !== true,
                      tags: [
                        isCurrent
                          ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                          : { text: '备用', cls: 'wbc-tag' },
                        pool?.cooling === true
                          ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' }
                          : null,
                        pool?.disabled === true ? { text: '已停用', cls: 'wbc-tag' } : null,
                        pool?.reserved === true ? { text: '已保留·暂停', cls: 'wbc-tag' } : null,
                        // 限流次数做标签，只在真的发生过时出现 —— 与另两页同款
                        // （先前行里常驻一条「触发限流 0 次」）。
                        (pool?.rateLimitHits ?? 0) > 0
                          ? { text: `限流 ${fmtNum(pool.rateLimitHits)} 次`, cls: 'wbc-tag' }
                          : null,
                      ],
                      // 余额来自 /usage 的逐账号 credits，号池状态来自 pool 段，
                      // 两张表按 id 对齐后拼成同一张卡。
                      rows: [
                        pool?.cooldownUntilMs !== undefined
                          ? { k: '冷却至', v: fmtTime(pool.cooldownUntilMs) }
                          : null,
                        account?.credits?.generalAvailable !== undefined
                          ? { k: '通用余额', v: fmtNum(account.credits.generalAvailable) }
                          : pool?.credits !== undefined
                            ? { k: '通用余额', v: fmtNum(pool.credits) }
                            : null,
                        account?.credits?.workAvailable !== undefined
                          ? { k: '工作余额', v: fmtNum(account.credits.workAvailable) }
                          : null,
                        // 与 Qoder 页同款：没设保留额度就写「不限」，而不是整行消失
                        pool === null || pool === undefined
                          ? null
                          : {
                              k: '保留额度',
                              v: (pool.creditReserve ?? 0) > 0 ? fmtNum(pool.creditReserve) : '不限',
                            },
                      ],
                      extra: [
                        jsx(
                          CardActions,
                          {
                            locked: !writable || pool === null || pool === undefined,
                            rotating: pool?.disabled !== true,
                            rotateBusy: savingPool === id,
                            onToggleRotate: (next) => onToggleDisabled(id, next !== true),
                            reserveValue:
                              reserveDraft[id] ?? String(pool?.creditReserve ?? 0),
                            onReserveChange: (v) =>
                              setReserveDraft((prev) => ({ ...prev, [id]: v })),
                            onSaveReserve: () => onSaveReserve(id),
                            saving: savingPool === `reserve-${id}`,
                          },
                          'actions',
                        ),
                      ],
                      action:
                        account === null || account === undefined || isCurrent
                          ? null
                          : {
                              label: switching === id ? '切换中…' : '切换到此账号',
                              disabled: switching !== null || !writable,
                              onClick: () => onSwitchAccount(id),
                            },
                    },
                    id,
                  );
                }),
              }),
            })
          : null,

        /* —— 模型 ——
         *
         * 放在最后：勾完正好落在 sticky 的保存条上（三页同款）。
         */
        signedIn
          ? jsx(Section, {
              title: '模型',
              sub: `已启用 ${fmtNum(enabledSet.size)} / ${fmtNum(savedModels.length)} 个`,
              hint: '列表来自「从 Trae 刷新」那一刻落盘的目录快照；一键测试会给每个已启用模型发一条最小消息（消耗少量额度）。',
              actions: [
                {
                  label: saving ? '刷新中…' : '从 Trae 刷新',
                  title: '拉取 Trae 最新模型目录，立即更新列表并自动启用全部模型。',
                  disabled: usageLoading || saving || usage?.status !== 'signed-in',
                  onClick: refreshModels,
                },
                {
                  label: '一键启用所有模型',
                  title: '把目录里的所有模型一次性全部勾选（仍需点保存落盘）。',
                  disabled: savedModels.length === 0 || !writable || saving,
                  onClick: enableAllModels,
                },
                {
                  label:
                    testing !== null ? `正在测试 ${testing.done}/${testing.total}…` : '一键测试启用模型',
                  title: '给每个已启用模型发一条最小消息，看哪些真的能应答。会消耗少量额度。',
                  disabled: enabledSet.size === 0 || testing !== null,
                  onClick: testEnabledModels,
                },
              ],
              children: [
                testSummary !== null
                  ? jsx('div', { className: 'wbc-note', children: testSummary })
                  : null,
                testError !== null ? jsx('div', { className: 'wbc-err', children: testError }) : null,
                savedModels.length === 0
                  ? jsx('div', { className: 'wbc-note', children: '暂无模型目录，先点「从 Trae 刷新」。' })
                  : jsx('div', {
                      className: 'wbc-cols',
                      children: savedModels.map((model) => {
                        const probe = probes[model.id];
                        return jsx(
                          ModelCard,
                          {
                            id: model.id,
                            name: [
                              model.name,
                              typeof model.creditMultiplier === 'number'
                                ? ` · x${model.creditMultiplier.toFixed(2)}`
                                : null,
                            ].filter(Boolean),
                            checked: enabledSet.has(model.id),
                            disabled: !writable || saving,
                            onToggle: () => toggleModel(model.id),
                            meta: [
                              `上下文 ${fmtCapacity(model.maxContextWindow ?? model.contextWindow)}`,
                              model.maxTokens !== undefined
                                ? `输出 ${fmtCapacity(model.maxTokens)}`
                                : null,
                              model.reasoning?.supported?.length
                                ? `推理强度：${model.reasoning.supported.join(' / ')}`
                                : null,
                            ],
                            probe,
                            probeLabel:
                              probe === undefined
                                ? null
                                : TRAE_PROBE_LABELS[probe.verdict] ?? probe.verdict,
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
  /**
   * 列头：标题 + 区域切换 + 两侧可选插槽 + 右侧操作按钮。两列共用。
   *
   * `title` 两个配置页都要给 —— 先前 Trae 页手写了一份列头且**没有标题**，
   * 与 XD Pool 并排切换时视觉重心对不齐（一个从标题起、一个直接从按钮起）。
   *
   * `leading` 是标题之后、区域按钮之前的位置（Trae 的供应商开关用它）；
   * `trailing` 是操作按钮之前的位置（模型区的 Max 模式勾选用它）。
   * 两者都不传时骨架与旧版一致，向后兼容。
   */
  function ColumnHead({ title, tabs, activeTab, onTab, actions, leading, trailing }) {
    return jsxs('div', {
      className: 'wbc-col-head',
      children: [
        title === undefined || title === null
          ? null
          : jsx('span', { className: 'wbc-col-title', children: title }),
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
        ...asArray(leading).filter((x) => x !== null && x !== undefined),
        jsx('div', { className: 'wbc-spacer' }),
        ...asArray(trailing).filter((x) => x !== null && x !== undefined),
        ...asArray(actions).map((a, i) =>
          jsx(
            'button',
            {
              type: 'button',
              className: 'wbc-btn',
              disabled: a?.disabled === true,
              // 列头按钮的说明文字（可选）：拉取即落盘这类「点了会替你写设置」的
              // 动作必须能悬停看到它要做什么，否则用户不敢点。
              ...(typeof a?.title === 'string' ? { title: a.title } : {}),
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
            // 可选的原生 tooltip：统计格空间小，放不下的口径说明（例如
            // 「这个余额是谁的」「读取失败的原因」）挂在这里。
            // 不传 `title` 时不写这个属性 —— 空 title 会在悬停时弹一个空框，
            // 比没有还糟。
            ...(typeof it.title === 'string' && it.title !== '' ? { title: it.title } : {}),
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
   *   extra  卡片中部的自定义控件（号池账号的「保留积分 + 保存 + 停用」那行）
   *   action 卡片底部一个按钮（WorkBuddy 是「签到领取」、Trae 是「切换到此账号」）
   *
   * `dim` 为 true 时整卡降透明度（停用 / 备用账号）。
   *
   * `extra` 是后加的：先前 Trae 页的号池账号卡是**手写**的（因为需要一行
   * 多个控件），于是同一页里出现了两种账号卡 —— 卡片内边距、标签间距、
   * 按钮位置都对不齐。把它做成插槽后两处都能走这一个组件。
   */
  function AccountCard({ name, tags, rows, action, extra, dim }) {
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
        ...asArray(extra).filter((x) => x !== null && x !== undefined),
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

  /**
   * 模型勾选卡：两个配置页同一套网格单元。
   *
   * 先前的差异是这一处最显眼的不一致 —— XD Pool 用 `wbc-cols` 网格 +
   * 每模型一个 `wbc-col`，Trae 用 `wbc-model` 单行流式排布。同一套设置里
   * 两个页面切换时，模型列表的密度与列宽完全变样。
   *
   * 现在两页都用网格（`wbc-cols` + `wbc-col`），单元内容是并集：
   *
   *   check   勾选框 + 名称（Trae 侧名称后带 x 倍率）
   *   meta    上下文 / 输出 / 推理强度
   *   extras  页面自己的附加控件（XD Pool 侧现为空 —— 原先的「支持图片」
   *           「限制到 200K」两个勾选已移除；Trae 侧无附加控件）
   *   probe   可用性测试徽章（只有 Trae 有）
   */
  function ModelCard({ id, name, checked, disabled, onToggle, meta, extras, probe, probeLabel }) {
    return jsxs(
      'div',
      {
        className: 'wbc-col',
        children: [
          jsx('label', {
            className: 'wbc-check',
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: checked === true,
                disabled: disabled === true,
                onChange: (e) => onToggle(e.target.checked),
              }),
              jsx('span', { className: 'wbc-model-name', children: name }),
            ],
          }),
          jsx('div', {
            className: 'wbc-model-meta',
            children: asArray(meta).filter((x) => x !== null && x !== undefined),
          }),
          ...asArray(extras).filter((x) => x !== null && x !== undefined),
          probe === undefined || probe === null
            ? null
            : jsx('span', {
                className: `wbc-probe wbc-probe-${probe.verdict}`,
                title: probe.detail,
                children: probeLabel,
              }),
        ],
      },
      id,
    );
  }

  /**
   * 分区：三个配置页同一套「标题 + 右侧操作 + 内容」。
   *
   * 这是这次统一面板样式的骨架。先前三页各写各的：
   *
   *   XD Pool / Trae   用 `wbc-models` + `wbc-bar` 手搓，标题字号、按钮位置
   *                    各页微调过，于是同一个「模型」区在三个页面里长得不一样；
   *   Qoder            干脆把**列头**（ColumnHead）当成内容标题用，一页里出现
   *                    两个同级标题（号池 / 模型），而另两页的「模型」只是个分区。
   *
   * 收敛成一个组件后，三页的分区只能照这个形状填：
   *
   *   head   标题（`wbc-col-title`）+ 可选副标题 + `lead` 插槽 + 弹簧 + `actions`
   *   body   内容（`.wbc-sec-body` 给竖排间距）
   *
   * `lead` 与 `actions` 分开是为了让「开关在左、按钮在右」这条在所有页面成立：
   * 不再出现某个页面的开关混在按钮中间。`hint` 收那些**解释性**的长句子
   * （悬停在标题上才显示）—— 需要一眼看到的数字放 `sub`，解释放 `hint`，
   * 页面因此干净，信息也没丢。
   */
  function Section({ title, sub, hint, lead, actions, children }) {
    const leadItems = asArray(lead).filter((x) => x !== null && x !== undefined);
    const actionItems = asArray(actions).filter((x) => x !== null && x !== undefined);
    return jsxs('div', {
      className: 'wbc-models',
      children: [
        jsxs('div', {
          className: 'wbc-bar',
          children: [
            jsx('span', {
              className: 'wbc-col-title',
              ...(typeof hint === 'string' && hint !== '' ? { title: hint } : {}),
              children: title,
            }),
            sub === undefined || sub === null || sub === ''
              ? null
              : jsx('span', { className: 'wbc-col-sub', children: sub }),
            ...leadItems,
            jsx('div', { className: 'wbc-spacer' }),
            ...actionItems.map((action, index) =>
              jsx(
                'button',
                {
                  type: 'button',
                  className: action.primary === true ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                  disabled: action.disabled === true,
                  ...(typeof action.title === 'string' && action.title !== ''
                    ? { title: action.title }
                    : {}),
                  onClick: action.onClick,
                  children: action.label,
                },
                `sec-action-${index}`,
              ),
            ),
          ],
        }),
        jsx('div', { className: 'wbc-sec-body', children }),
      ],
    });
  }

  /**
   * 账号卡里的控件行：三个配置页同一套。
   *
   * 同一件事（参与轮换 / 保留额度 / 移出池子）在三个页面里长成了三种样子：
   * XD Pool 是「参与轮换」勾选 + 「保存保留」，Trae 与 Qoder 是「停用 / 启用」
   * 按钮 + 「保存」，而「移出池子」只有 XD Pool 与 Qoder 有。语义其实一样
   * （都写 disabledAccountIds + creditReserves），只是控件不同 —— 于是同一个
   * 动作在三个页面里手感全变。
   *
   * 统一成一条：`参与轮换 [✓]  [保留额度 ___] [保存]  ………  [移出池子]`
   *
   * 「移出池子」只在传了 `onRemove` 时渲染 —— Trae 半边没有「移出」这个概念，
   * 不给它硬塞一个按不动的按钮。
   */
  function CardActions({
    locked,
    rotating,
    rotateBusy,
    onToggleRotate,
    reserveValue,
    onReserveChange,
    onSaveReserve,
    saving,
    onRemove,
    removeBusy,
  }) {
    return jsxs('div', {
      className: 'wbc-bar',
      children: [
        jsx('label', {
          className: 'wbc-check',
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: rotating === true,
              disabled: locked === true || rotateBusy === true,
              onChange: (e) => onToggleRotate(e.target.checked === true),
            }),
            jsx('span', { children: '参与轮换' }),
          ],
        }),
        jsx('input', {
          type: 'number',
          min: 0,
          step: 1,
          className: 'wbc-reserve-input',
          placeholder: '保留额度',
          value: reserveValue,
          disabled: locked === true,
          onChange: (e) => onReserveChange(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') onSaveReserve();
          },
        }),
        jsx('button', {
          type: 'button',
          className: 'wbc-btn',
          disabled: locked === true || saving === true,
          onClick: () => onSaveReserve(),
          children: saving === true ? '保存中…' : '保存',
        }),
        jsx('div', { className: 'wbc-spacer' }),
        typeof onRemove !== 'function'
          ? null
          : jsx('button', {
              type: 'button',
              className: 'wbc-btn',
              title: '移出后不再参与取号，可在「已移出账号池」里恢复',
              disabled: locked === true || removeBusy === true,
              onClick: () => onRemove(),
              children: '移出池子',
            }),
      ],
    });
  }
  //#endregion

  //#region Qoder 模型页
  /**
   * 取 Qoder 目录：`GET` 只读当前值，`POST` 先刷上游再回读。
   *
   * 为什么不走 `fetchJson`：刷新失败时接口按 502 回，**响应体里仍带着可用的
   * 目录**（内置兜底表或上一次成功的那份）。`fetchJson` 遇非 2xx 直接抛，
   * 会把这份有用的数据丢掉，用户只看到一句「刷新失败」而列表空空。
   * 所以这里自己读 body，把「失败」和「没有数据」分开表达。
   */
  async function fetchQoderCatalog(method) {
    const res = await fetch(`${SELF_API}/qoder/models/refresh`, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (body === null || typeof body !== 'object') {
      throw new Error(`Qoder 目录接口返回了非 JSON 响应（HTTP ${res.status}）`);
    }
    return body;
  }

  /** 读一个 Qoder 设置字段（先拆 volatile 活引用） */
  function qoderFieldOf(value, key) {
    const doc = unwrapVolatileDeep(value);
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
    return doc[key];
  }

  /** 读一个 Qoder 的 id 列表字段；非数组/非字符串一律丢弃 */
  function qoderIdListOf(value, key) {
    const list = unwrapVolatile(qoderFieldOf(value, key));
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' && x !== '');
  }

  /** 读 `contextBudgets` 字典；形状不对读作空字典 */
  function qoderBudgetsOf(value) {
    const raw = unwrapVolatile(qoderFieldOf(value, 'contextBudgets'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, n] of Object.entries(raw)) {
      const num = Number(unwrapVolatile(n));
      if (id !== '' && Number.isFinite(num) && num > 0) out[id] = Math.floor(num);
    }
    return out;
  }

  /**
   * Qoder 模型列（与「Qoder 号池」并排的第二列）。
   *
   * 与另两家（WorkBuddy / Trae）的模型列**逐条同款**：每张卡上只留一个「启用」
   * 勾选，图片能力与上下文窗口全部跟随上游目录，没有手动开关。
   *
   *   - 目录来自 provider 自己（`POST /qoder/models/refresh`；`GET` 同路径只读
   *     当前值，不触上游、不花额度）；
   *   - 「从 Qoder 刷新」= **拉取即落盘**（与「从 Trae 刷新」「从 WorkBuddy
   *     刷新」同一语义）：拉一次上游 → 目录里每个模型都启用 → 图片/上下文按
   *     上游写回 → 读回确认，**不需要再点保存**；
   *   - 手动勾选仍然保留（这是与另两家一致的部分），改动走底部的保存栏。
   *
   * 写入的是 `dsh-connect-qoder` 入口的**三个顶层**字段 —— `enabledModelIds`、
   * `imageModelIds`、`contextBudgets`。不像 Trae 那样嵌在 `regions.<区域>.*`
   * 里：Qoder 没有区域概念。
   *
   * ⚠️ 这个作用域**曾经根本绑不上**：`lib/qoder.js` 的 Config 一个 volatile 字段
   * 都没有，宿主的 `volatileForm()` 对没有 volatile 节点的 schema 返回 undefined，
   * `describe()` 直接跳过该入口，写入闸门也抛 `has no volatile fields`。所以
   * 「Qoder 的设置存不进去」不是绑定规则写错了，而是 schema 缺标记（已补）。
   * 这里仍按 `writable` 显式降级成只读 + 诊断，而不是给一堆按不动却看似可用的
   * 控件 —— 后者正是上游「保存了又弹回去」的表现。
   *
   * ## 为什么没有「补勾图片」与「上下文上限」
   *
   * 这两个控件曾经在这里（另两家更早就删了，理由逐字相同）：
   *
   *   1. **补勾图片**：provider 把 `imageModelIds` 与上游 `is_vl` 取**并集**
   *      （`lib/qoder.js` 的 `selectModels`），所以对上游已声明图片的模型它是
   *      「撤销」——做不到，只能画成禁用；对上游标漏的模型它是猜：猜错了图片会在
   *      发送后被上游拒掉，照样扣一次额度。两种情况下都不是一个诚实的开关。
   *   2. **上下文上限**：`contextBudgets` 只能**压低**上游窗口（调大不生效，
   *      请求侧不切档位），而每次拉目录都会按上游重写一遍 —— 手填的数字下一次
   *      刷新就没了。留着它等于让用户维护一份随时被覆盖的副本。
   *
   * 现在两个字段仍会写，但值由目录推导：`imageModelIds` = 目录里
   * `supportsImages` 的 id，`contextBudgets` = `{}`（每个模型都用满上游原生
   * 窗口；provider 侧 `contextWindow` 直接取上游 `max_input_tokens`）。于是
   * 「支持图片」与「上下文限制」这两件事在模型卡上**照旧看得见**（名字后面的
   * 「图片」标记、meta 里的「上下文 180K」），只是不再需要用户做选择。
   *
   * ## 一条语义上的坑，界面上必须说清
   *
   * `enabledModelIds` **空 = 不限制**（跟随上游目录）。所以保存值缺省时这里把
   * 目录里所有模型都画成已勾选；用户一旦取消其中一个，保存下来的就是一份
   * **固定白名单** —— 以后上游新增的模型不会再自动出现。这是 schema 的既有
   * 语义，不能悄悄替他决定，故在标题下方常驻一句说明（点「从 Qoder 刷新」会
   * 重新写成"全部启用"）。
   */
  function QoderModelsPanel({ scopeSlot, flat }) {
    // scopeSlot 是 client.js 包好的 {get,subscribe} 活句柄；渲染期直接读
    const scope = typeof scopeSlot?.get === 'function' ? scopeSlot.get() : scopeSlot;
    const scopeObj = typeof scope?.get === 'function' ? scope.get() : scope;
    const writable = scopeObj?.getSnapshot?.().writable === true;

    const [catalog, setCatalog] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    // 草稿：null = 未改动（跟随已保存值），否则三个字段的完整草稿
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [writeError, setWriteError] = useState(null);
    const [savedNote, setSavedNote] = useState(null);

    // 设置文档变化（含本页自己的写入）→ 丢弃草稿，回到已保存状态
    const [settingsRev, setSettingsRev] = useState(0);
    useEffect(() => {
      if (scopeObj === null || scopeObj === undefined || typeof scopeObj.subscribe !== 'function') {
        return undefined;
      }
      return scopeObj.subscribe(() => setSettingsRev((v) => v + 1));
    }, [scopeObj]);

    /**
     * 打开面板时的**只读**加载：GET 只回当前目录快照，不触上游、不花额度。
     * 拉上游那条路是 `refreshFromUpstream`（POST），两条分开写而不是共用一个
     * `load(method)` —— 共用时「点刷新」与「进页面」会长得一样，写反一次就变成
     * 「一进设置页先替你打一次上游」。
     */
    const load = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const body = await fetchQoderCatalog('GET');
        setCatalog(body);
        // `ok: false` 时目录仍然有效（兜底/上次成功的那份），只把原因显示出来
        if (body.ok !== true && typeof body.error === 'string') setError(body.error);
      } catch (e) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      load();
    }, [load, settingsRev]);

    const models = asArray(catalog?.models);
    const savedValue = scopeObj?.getSnapshot?.().value;
    const savedEnabled = qoderIdListOf(savedValue, 'enabledModelIds');

    // 空列表 = 不限制 → 目录里的每个模型都算已启用
    const savedEnabledSet = new Set(savedEnabled.length === 0 ? models.map((m) => m.id) : savedEnabled);
    const enabledSet = draft === null ? savedEnabledSet : draft.enabledIds;
    const dirty = draft !== null;
    const imageCount = models.filter((m) => m.supportsImages === true).length;
    const followMode = savedEnabled.length === 0;

    /**
     * 目录 → 「跟随上游」的那两个字段。
     *
     * 图片取目录的 `supportsImages`（上游 `is_vl`）、上下文留给 provider 按上游
     * 原生窗口算（空字典 = 不压低）。两者都不再有任何手动开关，所以这里每次都
     * 从**当次目录**重新推导，而不是回写用户之前存下的副本 —— 存下来的副本正是
     * 「刷新一次就变样」的来源。
     */
    const upstreamFieldsOf = (list) => ({
      imageModelIds: list.filter((m) => m.supportsImages === true).map((m) => m.id),
      contextBudgets: {},
    });

    /** 基于「当前生效值」起一份草稿，再交给 fn 改 */
    const withDraft = (fn) => {
      setSavedNote(null);
      setWriteError(null);
      setDraft((prev) => fn(prev ?? { enabledIds: new Set(enabledSet) }));
    };

    const toggleEnabled = (id, on) =>
      withDraft((d) => {
        const enabledIds = new Set(d.enabledIds);
        if (on) enabledIds.add(id);
        else enabledIds.delete(id);
        return { ...d, enabledIds };
      });

    const enableAll = () =>
      withDraft((d) => ({ ...d, enabledIds: new Set(models.map((m) => m.id)) }));

    /**
     * 把三个顶层字段按给定值顺序写下去，每个都读回确认。
     *
     * 共用于「保存」（值来自勾选）与「从 Qoder 刷新」（值来自刚拉到的目录）——
     * 两条路径的写入方式必须**逐字相同**，否则「刷新过的东西」和「保存过的
     * 东西」会在设置里长得不一样。
     */
    const writeSelection = async (list, enabledIds) => {
      const nextEnabled = list.map((m) => m.id).filter((id) => enabledIds.has(id));
      if (nextEnabled.length === 0) {
        throw new Error('至少要启用一个模型：空列表在 DSH 里等于「这个 provider 没有模型」');
      }
      await writeSettingsField(
        scopeObj,
        'enabledModelIds',
        nextEnabled,
        (doc) => qoderIdListOf(doc, 'enabledModelIds').length === nextEnabled.length,
        'qoder',
      );
      const upstream = upstreamFieldsOf(list);
      await writeSettingsField(
        scopeObj,
        'imageModelIds',
        upstream.imageModelIds,
        (doc) => qoderIdListOf(doc, 'imageModelIds').length === upstream.imageModelIds.length,
        'qoder',
      );
      await writeSettingsField(
        scopeObj,
        'contextBudgets',
        upstream.contextBudgets,
        (doc) => Object.keys(qoderBudgetsOf(doc)).length === 0,
        'qoder',
      );
    };

    const save = async () => {
      if (draft === null || scopeObj === null || scopeObj === undefined) return;
      setSaving(true);
      setWriteError(null);
      setSavedNote(null);
      try {
        // 顺序写三个顶层字段，每个都读回确认落地。图片/上下文按**目录**推导
        // （没有手动开关），只有 enabled 来自勾选。
        await writeSelection(models, draft.enabledIds);
        setDraft(null);
        setSavedNote('已保存');
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setSaving(false);
      }
    };

    /**
     * 「从 Qoder 刷新」—— 拉取即落盘（与「从 Trae 刷新」同款）。
     *
     * 一次点击做完三件事：拉上游目录 → 目录里的模型**全部启用** → 图片/上下文按
     * 上游写回 → 读回确认。写完才丢草稿，所以不会出现「拉到了新目录、选择还是
     * 旧的」这种半截状态；用户也不需要再点一次保存。
     *
     * ⚠️ **只在真的拉到上游时才写**。`POST /qoder/models/refresh` 在拉取失败时
     * 仍会回一份兜底目录（`ok: false` + `usingFallback`），照它写下去等于把「内置
     * 兜底表」固化成用户的白名单：兜底表里的图片标记、模型集合都可能与他的账号
     * 实际可用的不一样，而他看到的提示只是「刷新失败」。宁可不写。
     */
    const refreshFromUpstream = async () => {
      if (scopeObj === null || scopeObj === undefined) return;
      setRefreshing(true);
      setError(null);
      setWriteError(null);
      setSavedNote(null);
      try {
        const body = await fetchQoderCatalog('POST');
        setCatalog(body);
        if (body.ok !== true) {
          setError(body.error ?? '刷新模型目录失败');
          return;
        }
        const fresh = asArray(body.models);
        if (fresh.length === 0) throw new Error('Qoder 没有返回任何模型');
        await writeSelection(fresh, new Set(fresh.map((m) => m.id)));
        setDraft(null);
        setSavedNote(`已刷新：${fresh.length} 个模型，已全部启用（图片与上下文跟随上游）`);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setRefreshing(false);
      }
    };

    const lastFetchText =
      typeof catalog?.lastFetchAtMs === 'number' && Number.isFinite(catalog.lastFetchAtMs)
        ? `目录更新于 ${new Date(catalog.lastFetchAtMs).toLocaleTimeString()}`
        : null;

    return jsx('div', {
      className: flat === true ? 'wbc-flat' : 'wbc-col',
      children: [
        /* —— 模型 ——
         *
         * 这一块先前挂的是**列头**（ColumnHead「Qoder 模型」），所以同一个 Qoder
         * 页上出现了两个同级标题（号池 / 模型），而另两个配置页里「模型」只是
         * 页面里的一个分区。现在统一成分区（Section）：标题、副标题、按钮位置
         * 与 WorkBuddy、Trae 两页逐字相同。
         */
        jsx(Section, {
          title: '模型',
          sub: `已启用 ${fmtNum(enabledSet.size)} / ${fmtNum(models.length)} 个 · 上游声明支持图片 ${fmtNum(imageCount)} 个`,
          hint:
            '列表与勾选来自 Qoder 上游目录；图片能力（上游 is_vl）与上下文窗口（上游 max_input_tokens）跟随上游，没有手动开关——它们每次拉目录都会被重写。一旦在这里保存过，勾选就成为固定白名单，不再自动跟随上游新增。',
          actions: [
            {
              label: refreshing ? '刷新中…' : '从 Qoder 刷新',
              title:
                '拉一次上游目录：列表更新 + 所有模型自动全启用 + 图片与上下文按上游写回，立即生效（无需再点保存）。',
              disabled: refreshing || loading || !writable,
              onClick: refreshFromUpstream,
            },
            {
              label: '一键启用所有模型',
              disabled: models.length === 0 || !writable || saving,
              onClick: enableAll,
            },
          ],
          children: [
            !writable
              ? jsx('div', {
                  className: 'wbc-note',
                  'data-diagnostic': 'settings-scope',
                  title:
                    '宿主的 configForms 里没有 `dsh-connect-qoder` 这个入口，或它尚未就绪。README「Qoder 模型勾选」一节有排查步骤。',
                  children: READONLY_NOTE,
                })
              : null,
            loading && models.length === 0
              ? jsx('div', { className: 'wbc-note', children: '读取模型目录…' })
              : null,
            catalog?.usingFallback === true
              ? jsx('div', {
                  className: 'wbc-note',
                  title:
                    '内置兜底表的图片能力按真机目录写死，可能与你的账号实际可用的模型有出入。',
                  children: '当前显示的是内置兜底目录（上游目录还没拉到）。',
                })
              : null,
            lastFetchText === null ? null : jsx('div', { className: 'wbc-note', children: lastFetchText }),
            error === null ? null : jsx('div', { className: 'wbc-err', children: error }),
            savedNote === null ? null : jsx('div', { className: 'wbc-note', children: savedNote }),
            writeError === null ? null : jsx('div', { className: 'wbc-err', children: writeError }),

            models.length === 0
              ? jsx('div', { className: 'wbc-note', children: '暂无模型目录，先点「从 Qoder 刷新」。' })
              : jsx('div', {
                  className: 'wbc-cols',
                  children: models.map((model) => {
                    const upstreamImages = model.supportsImages === true;
                    return jsx(
                      ModelCard,
                      {
                        id: model.id,
                        name: [model.name ?? model.id, upstreamImages ? '图片' : null]
                          .filter(Boolean)
                          .join(' · '),
                        checked: enabledSet.has(model.id),
                        disabled: !writable || saving,
                        onToggle: (on) => toggleEnabled(model.id, on),
                        meta: [
                          model.id === (model.name ?? model.id) ? null : model.id,
                          `上下文 ${fmtCapacity(model.contextWindow)}`,
                          model.maxTokens === undefined
                            ? null
                            : `输出 ${fmtCapacity(model.maxTokens)}`,
                        ],
                        // 这里原本还挂着两个控件：「补勾图片」（checkbox）与
                        // 「上下文上限」（number）。两者都**已从页面移除**，理由与
                        // WorkBuddy / Trae 两列逐字相同：
                        //
                        //   补勾图片 —— provider 侧与上游取并集，上游已支持的撤不
                        //     回来（只能画成禁用），上游标漏的则是猜（猜错就白扣
                        //     一次额度）。那不是一个诚实的开关。
                        //   上下文上限 —— 只能压低、且每次拉目录都被按上游重写，
                        //     手填的数字下一次刷新就没了。
                        //
                        // 图片与上下文仍然看得见：名字后面有「图片」标记，meta 里
                        // 有「上下文 180K」（上游 max_input_tokens，见 lib/qoder-catalog.mjs）。
                        extras: [],
                      },
                      model.id,
                    );
                  }),
                }),

            // 保存条与另两页逐字同款（放弃修改 + 保存）。「未保存」的状态由
            // 它自己出现这件事表达，不必再写一句；「保存后会变成固定白名单」
            // 归到分区标题的悬停说明里。
            dirty
              ? jsxs('div', {
                  className: 'wbc-model-actions',
                  children: [
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn',
                      disabled: saving,
                      onClick: () => {
                        setDraft(null);
                        setWriteError(null);
                        setSavedNote(null);
                      },
                      children: '放弃修改',
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wbc-btn wbc-btn-primary',
                      disabled: saving || enabledSet.size === 0,
                      onClick: save,
                      children: saving ? '保存中…' : '保存',
                    }),
                  ],
                })
              : null,
          ],
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
    onSelect,
    login,
    distribution,
    distributionBusy,
    distributionError,
    distributionWritable,
    onDistribution,
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
        // 分配策略切换（与配置页、Qoder 列同一套 wbc-bar 排布）。
        //
        // 只在池里有账号时显示：没有账号可分配时切换策略是个空操作，
        // 摆在那里只会让人以为它坏了。
        accounts.length > 0
          ? jsxs('div', {
              className: 'wbc-bar',
              children: [
                jsx('span', { className: 'wbc-col-title', children: '账号使用方式' }),
                jsx('div', { className: 'wbc-spacer' }),
                ...POOL_DISTRIBUTIONS.map((d) =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      className:
                        d.id === (distribution ?? 'priority') ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                      disabled: distributionBusy === true || distributionWritable === false,
                      title: d.hint,
                      onClick: () => onDistribution(d.id),
                      children: d.label,
                    },
                    d.id,
                  ),
                ),
              ],
            })
          : null,
        // 作用域不可写时**主动**说明，而不是等用户点了才报错：一个按下去
        // 什么都不发生的按钮，和「保存成功但值弹回去」一样难排查。
        accounts.length > 0 && distributionWritable === false
          ? jsx('div', { className: 'wbc-err', children: '设置作用域不可写，无法保存分配策略' })
          : null,
        // 必须说清作用范围：这一列的列头有「国内版 / 国际版」切换，而
        // WorkBuddy 的分配策略是**池级单键**（applyConfigFromSource 只写一次
        // 顶层 distribution，region 仅在取用时过滤账号）。不写这句，用户会
        // 合理地以为策略跟着上面的区域走 —— 那是个查不出来的错误预期。
        accounts.length > 0
          ? jsx('div', {
              className: 'wbc-col-sub',
              children: '整个池共用一套策略，不随上面的区域切换。',
            })
          : null,
        distributionError !== undefined && distributionError !== null
          ? jsx('div', { className: 'wbc-err', children: `分配策略保存失败：${distributionError}` })
          : null,
        accounts.length === 0
          ? jsx(EmptyBox, {
              lines: [
                '这边还没有检测到已登录的 WorkBuddy 账号。',
                '可以点上面的「添加账号」在浏览器里登录一个，也可以先在 WorkBuddy 桌面版里登录再点「重新检测」。',
              ],
            })
          : jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) => {
                // 「当前账号」= 本区域请求固定使用的那个（`selectedAccountId`
                // 由宿主的池状态返回）。它是**按区域**的：切到国际版 tab 时
                // 看到的是国际版自己的选中项。
                //
                // 没有固定项时退到 `activeAccountId`（上次真的服务过请求的那个）
                // —— 与「XD Pool」配置页同一条判据，两处的标签与压暗规则才会
                // 一致。两个都拿不到就**不压暗任何卡**：「不知道是谁」不等于
                // 「都不是它」。
                const selectedId =
                  typeof status?.selectedAccountId === 'string' ? status.selectedAccountId : '';
                const activeId =
                  typeof status?.activeAccountId === 'string' ? status.activeAccountId : '';
                /** 被用户**固定**的那个（按钮显示「取消固定」） */
                const isSelected = selectedId !== '' && a.id === selectedId;
                /** 实际在服务的那个：固定项优先，否则是上次真的服务过请求的 */
                const currentId = selectedId !== '' ? selectedId : activeId;
                const isCurrent = currentId !== '' && a.id === currentId;
                return jsx(
                  AccountCard,
                  {
                    name: a.nickname || a.label || a.id,
                    dim:
                      a.cooling === true ||
                      a.disabled === true ||
                      (currentId !== '' && isCurrent !== true),
                    tags: [
                      isCurrent
                        ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                        : { text: '备用', cls: 'wbc-tag' },
                      a.cooling ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' } : null,
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
                    // 切换「当前账号」：请求固定用它；再次点击 = 取消固定，
                    // 回到号池轮换。排布与 Qoder / Trae 三列保持一致。
                    extra: [
                      jsxs(
                        'div',
                        {
                          className: 'wbc-bar',
                          children: [
                            jsx('div', { className: 'wbc-spacer' }),
                            jsx('button', {
                              type: 'button',
                              className: isSelected ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                              disabled: typeof onSelect !== 'function' || busyId === a.id,
                              onClick: () => onSelect(isSelected ? null : a.id),
                              children: isSelected ? '取消固定' : '设为当前',
                            }),
                          ],
                        },
                        'select',
                      ),
                    ],
                  },
                  a.id,
                  );
              }),
            }),
      ],
    });
  }
  //#endregion

  //#region 积分页
  /**
   * 积分页：三家池各自的「账号 → 余额」快照。
   *
   * ## 为什么不能只显示一个「当前总积分」
   *
   * WorkBuddy 与 Trae 都是**多账号池**，而每一轮请求只落在其中一个账号上。
   * 于是「所有账号之和」是个谁也对不上的数字：池子里 3 个账号各 1000 分，
   * 合计 3000 看着很宽裕，但这一轮真正在扣的那个可能只剩 20。
   *
   * 所以每家都按「**被调用的账号**（高亮）+ 池里其它账号」两个层次显示：先答
   * 「这次扣的是谁、还剩多少」，再给全池合计当参考。判据由各自的池提供
   * （WorkBuddy `activeAccountId`、Trae `pool.lastServedId`、Qoder `serving`），
   * 与本插件额度胶囊用的是同一套口径。
   */
  function CreditsTab({ status, summary, loading, traeStatus, qoderStatus }) {
    const accounts = asArray(status?.accounts);
    const rows = asArray(summary?.accounts);
    // WorkBuddy：`activeAccountId` 就是「最近服务的账号」（vendored 池用
    // lastServedId 兜底），没有它时才退回「固定选中的那个」。
    const wbServing = pickServingAccount(accounts, {
      lastServedId: status?.activeAccountId,
      selectedAccountId: status?.selectedAccountId,
    });
    const wbServingCredits = accountCreditsOf(wbServing);
    const liveTotal = accounts.reduce(
      (sum, a) => sum + (typeof a.credits?.total === 'number' ? a.credits.total : 0),
      0,
    );

    /**
     * 一家的卡片组：被调用的账号排最前，并高亮。
     *
     * `extraOf` 用来给某个账号补一段专属内容（WorkBuddy 的积分包明细就走它）——
     * 三家的卡片结构因此只有一份实现，不会出现「WorkBuddy 加了字段、另外两家
     * 忘了加」这类不一致。
     */
    const renderGroup = (title, note, list, servingId, keyOf, extraOf) =>
      jsxs('div', {
        className: 'wbc-col',
        children: [
          jsx('div', { className: 'wbc-col-title', children: title }),
          note === null || note === undefined ? null : jsx('div', { className: 'wbc-note', children: note }),
          asArray(list).length === 0
            ? jsx('div', { className: 'wbc-note', children: '暂无账号数据。' })
            : jsx('div', {
                className: 'wbc-cards',
                children: asArray(list)
                  // 被调用的账号排最前：它是这张页面上唯一「正在花钱」的账号。
                  .slice()
                  .sort((a, b) => (keyOf(a) === servingId ? -1 : 0) - (keyOf(b) === servingId ? -1 : 0))
                  .map((a) =>
                    jsxs(
                      'div',
                      {
                        className: 'wbc-card',
                        children: [
                          jsxs('div', {
                            className: 'wbc-card-head',
                            children: [
                              jsx('span', {
                                className: 'wbc-name',
                                // Trae 的账号行只有 `accountName`（没有 nickname/label），
                                // 漏掉它整张卡的名字就变成一串裸 id。
                                children: a.nickname || a.label || a.name || a.accountName || a.id,
                              }),
                              keyOf(a) === servingId
                                ? jsx('span', { className: 'wbc-tag wbc-tag-on', children: '本次调用' })
                                : null,
                            ],
                          }),
                          jsxs('div', {
                            className: 'wbc-kv',
                            children: [
                              jsx('span', { className: 'wbc-k', children: '余额' }),
                              jsx('span', {
                                className: 'wbc-v',
                                // 读不到就给「–」：显示成 0 会让人以为账号空了。
                                children: fmtCreditOrDash(accountCreditsOf(a)),
                              }),
                            ],
                          }),
                          ...(typeof extraOf === 'function' ? asArray(extraOf(a)).filter((x) => x !== null) : []),
                          a.creditsError ? jsx('div', { className: 'wbc-err', children: a.creditsError }) : null,
                        ],
                      },
                      String(a.id),
                    ),
                  ),
              }),
        ],
      });

    /**
     * WorkBuddy 的积分包明细。
     *
     * 另外两家没有这个结构（Trae 只有总额、Qoder 只有三池合计），所以它挂在
     * WorkBuddy 这一组的 `extraOf` 上；**没有明细时不再补一句「无积分包明细」**——
     * 每个账号下面都挂一行「无…」只是噪声，卡片上「余额」那行已经说明了问题。
     */
    const wbPackagesOf = (a) => {
      const packs = asArray(a.credits?.packages).filter((p) => (p.size ?? 0) > 0);
      if (packs.length === 0) return [];
      return [
        jsx('div', {
          className: 'wbc-packs',
          children: packs.slice(0, 6).map((p, i) =>
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
        }),
      ];
    };

    const traeAccounts = asArray(traeStatus?.accounts);
    const qoderAccounts = asArray(qoderStatus?.accounts);
    const qoderServing = qoderStatus?.serving ?? null;

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-cards',
          children: [
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '本次调用账号的额度' }),
                jsx('div', {
                  className: 'wbc-sum-value',
                  children: fmtCreditOrDash(wbServingCredits),
                }),
                jsx('div', {
                  className: 'wbc-sum-sub',
                  children: `${wbServing?.nickname || wbServing?.label || '账号未知'} · WorkBuddy 本区域`,
                }),
              ],
            }),
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '当前总积分' }),
                jsx('div', { className: 'wbc-sum-value', children: fmtNum(liveTotal) }),
                jsx('div', { className: 'wbc-sum-sub', children: `${accounts.length} 个账号（本区域合计）` }),
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
        renderGroup(
          'WorkBuddy 账号',
          '「本次调用」是最近真正服务了请求的账号；每个账号下面是它的积分包明细。',
          accounts,
          wbServing?.id,
          (a) => a.id,
          wbPackagesOf,
        ),
        renderGroup(
          'Trae 账号（当前区域）',
          'Trae 的余额按区域分开统计，这里显示当前选中区域的账号；切区域请到「Trae 配置」页。',
          traeAccounts,
          pickServingAccount(traeAccounts, {
            lastServedId: traeStatus?.pool?.lastServedId,
            selectedAccountId: traeStatus?.pool?.selectedAccountId,
          })?.id,
          (a) => a.id,
        ),
        renderGroup(
          'Qoder 账号',
          '「本次调用」是最近真正服务了请求的 Qoder 账号；轮换模式下每轮可能不同。',
          qoderAccounts,
          typeof qoderServing?.accountId === 'string' ? qoderServing.accountId : undefined,
          (a) => a.id,
        ),
        rows.length === 0
          ? null
          : jsx('div', {
              className: 'wbc-note',
              children: `历史采样覆盖 ${rows.length} 个账号（含历史记录里的账号）。`,
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
    distribution,
    distributionBusy,
    distributionError,
    distributionWritable,
    onDistribution,
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
        // 分配策略切换（与配置页、Qoder 列同一套 wbc-bar 排布）。
        // Trae 的 distribution 存在 `regions.<region>.distribution` 里，
        // 所以这里显示/写入的都是**当前区域**那一份，切区域会跟着换。
        accounts.length > 0
          ? jsxs('div', {
              className: 'wbc-bar',
              children: [
                jsx('span', { className: 'wbc-col-title', children: '账号使用方式' }),
                jsx('div', { className: 'wbc-spacer' }),
                ...POOL_DISTRIBUTIONS.map((d) =>
                  jsx(
                    'button',
                    {
                      type: 'button',
                      className:
                        d.id === (distribution ?? 'priority') ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
                      disabled: distributionBusy === true || distributionWritable === false,
                      title: d.hint,
                      onClick: () => onDistribution(d.id),
                      children: d.label,
                    },
                    d.id,
                  ),
                ),
              ],
            })
          : null,
        // 同左列：不可写时主动说明，别给一个按不动的假控件。
        accounts.length > 0 && distributionWritable === false
          ? jsx('div', { className: 'wbc-err', children: '设置作用域不可写，无法保存分配策略' })
          : null,
        // 与左列相反：Trae 这份策略是**按区域**存的，说清楚免得用户以为
        // 改了国内版国际版也一起变。
        accounts.length > 0
          ? jsx('div', {
              className: 'wbc-col-sub',
              children: '只作用于当前区域，国内版与国际版各自保存。',
            })
          : null,
        distributionError !== undefined && distributionError !== null
          ? jsx('div', { className: 'wbc-err', children: `分配策略保存失败：${distributionError}` })
          : null,
        status !== null && status.creditsError !== void 0
          ? jsx('div', { className: 'wbc-err', children: `余额读取失败：${status.creditsError}` })
          : null,
        accounts.length > 0
          ? jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) => {
                /**
                 * 每张卡显示**它自己**的余额。
                 *
                 * `/usage` 现在逐账号附上 `credits`（见 lib/trae.js 的
                 * `traeWebUsage`：每个账号用一个一次性客户端读一次，不改选中账号），
                 * 所以备用账号也能显示额度，不必先切过去。当前绑定账号在没有
                 * 逐账号额度时（旧缓存文档 / 国际版没有这套接口）回退到顶层
                 * `credits`；都读不到就交给 `fmtNum` 显示 –，不编造数字。
                 */
                const own = a.credits ?? (a.selected === true ? credits : void 0);
                return jsx(
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
                    rows: [
                      { k: '额度', v: fmtNum(own?.total) },
                      { k: '可用', v: fmtNum(own?.available) },
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
                );
              }),
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
  /**
   * 「账号」页：三列，同一套模块样式。
   *
   * 三列而不是两列，是因为 Qoder 也是一个**账号池** —— 把它藏在独立标签页里
   * 会让「账号都在哪」这件事分成两处看。三列共用 `wbc-cols` 的
   * `auto-fit minmax(300px,1fr)` 网格，窄屏自动折行，不需要额外的响应式分支。
   *
   * Qoder 列直接复用 `QoderPoolPanel` 本体（它自己就是 `wbc-col`），
   * 而不是另写一个精简版：两处显示**必须**完全一致，否则「账号页看到的余额」
   * 与「独立页看到的余额」会出现两套口径。
   */
  function AccountsTab({ wb, trae, qoder }) {
    return jsx('div', {
      className: 'wbc-cols',
      children: [
        jsx(WorkBuddyAccountsPanel, wb),
        jsx(TraeAccountsPanel, trae),
        jsx(QoderPoolPanel, qoder),
      ],
    });
  }
  //#endregion

  //#region Qoder 号池页
  /**
   * Qoder CN 号池面板。
   *
   * 与 WorkBuddy / Trae 两个面板的关键差别：那两个的账号来自**扫本机客户端
   * 登录态**，所以面板只需要「重新检测」；Qoder 桌面端每个安装只保存一份登录，
   * 扫不出多个账号 —— 池里的每个账号都必须**逐个走一次浏览器设备流登录**。
   * 所以这里的主操作是「添加账号」，而不是「重新检测」。
   *
   * 设备流不开回环端口：点了「添加账号」后服务端直接打开系统浏览器，前端只
   * 负责轮询登录状态。用户不需要复制粘贴任何东西。
   */
  function QoderPoolPanel({
    /**
     * 平铺模式：根节点不再自带 `wbc-col`（12px 间距），而是 `display:contents`
     * 让各分区直接成为页面 `wbc-body` 的 flex 子项。
     *
     * 为什么需要：本面板在「Qoder 配置」页是**整页内容**，在「账号」页是其中
     * 一列。作为整页内容时它必须与 WorkBuddy / Trae 两个配置页同距（16px）——
     * 套一层 `wbc-col` 会让 Qoder 页的分区间距变成 12px，三个页面对比着看
     * 就是「这一页挤一点」。
     */
    flat,
    status,
    loading,
    error,
    writeError,
    busy,
    writable,
    login,
    reserveDraft,
    setReserveDraft,
    creditsNote,
    creditsAtMs,
    onRefresh,
    onAddAccount,
    onToggle,
    onReserve,
    onRemove,
    onSelect,
    onResetCooldowns,
  }) {
    const accounts = asArray(status?.accounts);
    const cooling = accounts.filter((a) => a.cooling === true).length;
    const usable = accounts.filter((a) => a.disabled !== true && a.cooling !== true).length;
    /**
     * 「当前使用」的那一个 —— 请求就固定用它。
     *
     * 由池算好（`status.accounts[].selected`），规则与 Trae 侧逐字一致：显式选中
     * 且还在池里就是它，否则是池里第一个账号。所以**有账号时永远恰好一个**卡片
     * 带这个标签 —— 早先这里用的是「用户显式选过谁」，没选过时一个都没有，
     * 用户看到的就是「没有当前账号」。
     */
    const current = accounts.find((a) => a.selected === true) ?? null;
    // 已知余额的合计：**只累加真的读到过的账号**，读不到的按「未知」跳过。
    // 把未知当 0 会让合计偏小，看起来像积分凭空少了。
    const knownCredits = accounts.filter((a) => a.credits !== null && a.credits !== undefined);
    const creditsTotal = knownCredits.reduce((sum, a) => sum + (Number(a.credits) || 0), 0);
    const creditsErrors = creditsNote?.errors ?? {};
    /**
     * 「现在是谁在被调用」—— 由宿主算好（`status.serving`，见 lib/index.js）。
     *
     * 卡片上的「余额」原本只说「这个账号还剩多少」，用户还得自己判断哪一个
     * 才是这次真正扣费的。所以这里显式标出被调用的那个，并在统计行里显示
     * **它的**余额：轮换模式下每次请求可能换账号，池子合计回答不了
     * 「我这一轮花了谁的钱」。
     */
    const serving = status?.serving ?? null;
    const servingId = typeof serving?.accountId === 'string' ? serving.accountId : '';
    const servingCredits =
      typeof serving?.credits === 'number' && Number.isFinite(serving.credits) ? serving.credits : undefined;
    const servingName =
      shortAccountName(serving?.label ?? '') ||
      shortAccountName(accounts.find((a) => a.id === servingId)?.label ?? '') ||
      (servingId === '' ? '' : `${servingId.slice(0, 8)}…`);

    /**
     * 「当前使用」那一格的副标题：把三件事按重要性拼起来 —— 让位（如果有）、
     * 真正在扣的那份余额、全池合计与刷新时间。
     *
     * 先前这是**三格**统计（当前账号 / 当前使用额度 / 积分合计），六个格子挤成
     * 两行；三个配置页里只有这一页六格，视觉上就与另两页对不上。信息没有丢：
     * 口径都写在副标题里（全池合计回答不了「我这一轮花了谁的钱」，所以它只能
     * 当参考值）。
     */
    const currentSub = (() => {
      const parts = [];
      if (current !== null && current.cooling === true) parts.push('冷却中，暂时让位');
      if (serving !== null && servingId !== '') {
        if (current !== null && servingId !== current.id) parts.push(`本次让位给 ${servingName}`);
        else parts.push(servingCredits === undefined ? '额度读取中…' : `额度 ${fmtNum(servingCredits)}`);
        if (serving.source !== 'served') parts.push('预告');
      }
      // 合计只算**真的读到过**的账号，并标明已知比例：把未知当 0 会让合计偏小，
      // 看起来像积分凭空少了；一个都没读到时不写 0，而是「未知」。
      if (knownCredits.length === 0) parts.push('全池未知');
      else if (knownCredits.length === accounts.length) parts.push(`全池 ${fmtNum(creditsTotal)}`);
      else parts.push(`全池 ${fmtNum(creditsTotal)}（${knownCredits.length}/${accounts.length} 个已知）`);
      // 自动刷新没有「刷新」按钮可点，所以必须让用户看得见数据是新的还是旧的
      // —— 否则一个卡住的刷新看起来和正常一样。
      parts.push(
        creditsAtMs > 0
          ? `${fmtRelative(creditsAtMs)}刷新`
          : `每 ${QODER_CREDITS_REFRESH_MS / 1000} 秒自动刷新`,
      );
      return parts.join(' · ');
    })();

    return jsxs('div', {
      className: flat === true ? 'wbc-flat' : 'wbc-col',
      children: [
        jsx(ColumnHead, {
          title: 'Qoder 号池',
          actions: [
            {
              label: '刷新',
              title: '重读号池快照与积分（本地，不花额度）。',
              disabled: loading,
              onClick: onRefresh,
            },
            {
              label: '添加账号',
              title: '用浏览器登录一个新的 Qoder 账号并入池。',
              disabled: login?.pending === true,
              onClick: onAddAccount,
            },
            // 「重置冷却」不在这里：它和另两个配置页一样归到「账号」区
            // —— 三个页面的「清冷却」都在账号区右上角，位置固定。
          ],
        }),

        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              title:
                '宿主没有暴露 `dsh-connect-qoder` 的可写设置作用域，或它尚未就绪。「切换到此账号 / 参与轮换 / 保留额度」都会写不进去。',
              children: READONLY_NOTE,
            })
          : null,

        // 登录进行中：设备流没有回调页，只需告诉用户去浏览器完成授权。
        login?.pending === true
          ? jsxs('div', {
              className: 'wbc-note',
              children: [
                jsx('div', { children: '已在浏览器打开 Qoder 授权页，完成授权后会自动加入号池。' }),
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

        error !== null && error !== undefined
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        login?.error !== undefined && login?.error !== null
          ? jsx('div', { className: 'wbc-err', children: `添加账号失败：${login.error}` })
          : null,
        // 写入失败必须显式说出来：settings 写入是「读回确认」的，静默失败会
        // 表现成「点了切换但没反应」，而用户只会以为按钮坏了。
        writeError !== null && writeError !== undefined
          ? jsx('div', { className: 'wbc-err', children: `保存失败：${writeError}` })
          : null,

        // 自动刷新的结果提示：**只有出问题才占一行**。
        // 成功是静默的 —— 一个每 30 秒冒出来的「已刷新 N 个账号」等同噪声。
        // 两种失败要分开说：整体打不通（message）与部分账号读失败（failed）。
        creditsNote !== null && creditsNote !== undefined
          ? creditsNote.message !== undefined
            ? jsx('div', {
                className: 'wbc-note',
                children: `积分自动刷新失败：${creditsNote.message}（每 ${QODER_CREDITS_REFRESH_MS / 1000} 秒重试）`,
              })
            : creditsNote.failed > 0
              ? jsx('div', {
                  className: 'wbc-note',
                  children: `已自动刷新 ${creditsNote.refreshed} 个账号的积分，${creditsNote.failed} 个读取失败（原因见对应卡片）。`,
                })
              : null
          : null,

        status === null && loading
          ? jsx('div', { className: 'wbc-note', children: '正在读取 Qoder 号池…' })
          : null,

        // 空池：解释清楚为什么这里没有「自动检测」这条路。
        status !== null && accounts.length === 0
          ? jsx(EmptyBox, {
              lines: [
                '号池里还没有账号。',
                'Qoder 桌面端每个安装只保存一份登录，扫不出多个账号，所以请点上面的',
                '「添加账号」逐个用浏览器登录 —— 每个登录都会成为一个可轮换的账号。',
              ],
            })
          : null,

        accounts.length > 0
          ? jsx(StatsRow, {
              items: [
                { label: '账号', value: fmtNum(accounts.length), sub: '个已入池' },
                { label: '可用', value: fmtNum(usable), sub: '未被停用/冷却' },
                { label: '冷却中', value: fmtNum(cooling), sub: '被限流' },
                {
                  // 「当前使用」是谁：这是本页最该一眼看到的一件事 —— 请求就打在
                  // 它身上。它这一轮的余额（真正在扣的那份）与全池合计退到 sub，
                  // 并标出口径 —— 「我这一轮花了谁的钱」全池合计回答不了。
                  label: '当前使用',
                  value: current === null ? '—' : shortAccountName(current.label ?? '') || '已选',
                  sub: currentSub,
                  small: true,
                  title: current === null ? '号池里还没有账号' : `账号 id：${current.id}`,
                },
              ],
            })
          : null,

        /* —— 账号 ——
         *
         * 使用方式那三行说明收进标题悬停（hint）：它是解释，不是每次都要读的
         * 状态。卡片仍保留两个**不同**的标签 ——「当前使用」（请求固定用它）
         * 与「本次调用」（这一轮真的扣了它的额度），不一致正是「当前账号让位给
         * 备用」在界面上的样子，合并成一个就再也说不清。
         */
        accounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个账号 · 请求固定用「当前使用」那张`,
              hint: '请求固定用「当前使用」的账号；它被停用、限流冷却或额度触底时，本次请求会自动改用下一个可用账号（卡片上「本次调用」标出的就是真正扣费的那个）。想换账号请点那张卡上的「切换到此账号」。',
              actions: [
                {
                  label: busy === true ? '清除中…' : '清除冷却',
                  title: '清掉所有账号的限流冷却，让它们立刻回到池子里。',
                  disabled: busy === true || accounts.length === 0,
                  onClick: onResetCooldowns,
                },
              ],
              children: jsx('div', {
                className: 'wbc-cards',
                children: accounts.map((a) => {
                  const isCooling = a.cooling === true;
                  const expired = a.expired === true;
                  const isSelected = a.selected === true;
                  const isServing = servingId !== '' && a.id === servingId;
                  const locked = busy === true || writable === false;
                  return jsx(
                    AccountCard,
                    {
                      name: a.label ?? a.id,
                      // 与 Trae 侧同款：只有「当前使用」那张是亮的，备用卡片压暗。
                      // 不可用（停用/冷却）也压暗 —— 两种「不是它」在视觉上一致，
                      // 具体原因由标签说明。
                      dim: a.disabled === true || isCooling || isSelected !== true,
                      tags: [
                        isServing ? { text: '本次调用', cls: 'wbc-tag wbc-tag-on' } : null,
                        isSelected
                          ? { text: '当前使用', cls: isServing ? 'wbc-tag' : 'wbc-tag wbc-tag-on' }
                          : { text: '备用', cls: 'wbc-tag' },
                        a.disabled === true
                          ? { text: '已停用', cls: 'wbc-tag' }
                          : isCooling
                            ? { text: '冷却中', cls: 'wbc-tag wbc-tag-warn' }
                            : null,
                        expired ? { text: '令牌已过期', cls: 'wbc-tag wbc-tag-warn' } : null,
                        a.rateLimitHits > 0
                          ? { text: `限流 ${a.rateLimitHits} 次`, cls: 'wbc-tag' }
                          : null,
                      ],
                      rows: [
                        { k: '账号', v: a.userId || a.id },
                        { k: '令牌到期', v: a.expiresAtMs > 0 ? fmtTime(a.expiresAtMs) : '未知' },
                        isCooling ? { k: '冷却至', v: fmtTime(a.cooldownUntilMs) } : null,
                        /**
                         * 余额三态：读到数字 / 本次读失败 / 尚未读到。**「读失败」
                         * 与「余额 0」必须看起来不一样** —— 显示成 0 会让用户
                         * 误以为账号空了而把它删掉。自动刷新是每 30 秒一次，
                         * 所以「尚未读到」只是这一拍还没回来，不必让用户操作。
                         *
                         * 被调用账号的余额优先用 `serving.credits` 兜底：那一份是
                         * 宿主专门为它读的（还带 3 分钟节流），而号池快照里的
                         * `a.credits` 只在「批量刷新积分」跑过之后才有值。少了这个
                         * 兜底，页面上唯一真正在扣费的账号反而显示「读取中…」。
                         */
                        a.credits !== null && a.credits !== undefined
                          ? { k: '余额', v: fmtNum(a.credits) }
                          : isServing && servingCredits !== undefined
                            ? { k: '余额', v: fmtNum(servingCredits) }
                            : creditsErrors[a.id] !== undefined
                              ? { k: '余额', v: `读取失败：${creditsErrors[a.id]}` }
                              : { k: '余额', v: '读取中…' },
                        // 行序与另两页对齐：余额之后才是保留额度
                        { k: '保留额度', v: a.creditReserve > 0 ? fmtNum(a.creditReserve) : '不限' },
                      ],
                      // 参与轮换 / 保留额度 / 移出池子：走共用的 CardActions，
                      // 与另两个配置页逐字同款。「切换到此账号」不在这条 bar 里
                      // —— 它是每张卡的**主操作**，放在卡片最底部独占一行。
                      extra: [
                        jsx(
                          CardActions,
                          {
                            locked,
                            rotating: a.disabled !== true,
                            rotateBusy: busy === true,
                            onToggleRotate: (next) => onToggle(a.id, next !== true),
                            reserveValue: reserveDraft[a.id] ?? String(a.creditReserve ?? 0),
                            onReserveChange: (v) =>
                              setReserveDraft((prev) => ({ ...prev, [a.id]: v })),
                            onSaveReserve: () => onReserve(a.id),
                            saving: busy === true,
                            onRemove: () => onRemove(a.id),
                            removeBusy: busy === true,
                          },
                          'actions',
                        ),
                      ],
                      // 主操作只有一条：把请求切到这张卡上。当前使用的那张没有按钮
                      // ——「取消固定」不存在，因为池里必须永远有一个当前账号（清空
                      // 选择只会回到池里第一个账号，那对用户是个隐形动作，不如不给）。
                      action:
                        isSelected === true
                          ? null
                          : {
                              label: '切换到此账号',
                              disabled: locked,
                              onClick: () => onSelect(a.id),
                            },
                    },
                    String(a.id),
                  );
                }),
              }),
            })
          : null,
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
  // 它回答一个问题：**当前选中的模型，此刻在扣哪个账号的积分、还剩多少。**
  //
  // 「哪个账号」这件事是这里最容易做错、也最容易被忽略的一环：池子里有多个
  // 账号，真实请求落在**某一个**账号上（轮换模式下每次可能不同），所以
  // 「池里所有账号的余额之和」根本不是用户想问的数字 —— 那是「全家当」，
  // 不是「这个模型还能用多少」。所以三条链路都改成显示**被调用的那个账号**
  // 的余额，账号名一起显示（否则用户不知道这个数字是谁的）。
  //
  // 所以先要拿到「当前模型」—— 那是 model-selection 包的服务
  // `modelDirectories`，按会话给一份目录 store：
  //
  //   models.directoryFor(sessionId).store.getSnapshot()
  //     → { groups: [{id, models}], current: { provider, model } }
  //
  // `current.provider` 就是 provider id。只有这五个属于本插件：
  //   workbuddy-xdpool / workbuddy-xdpool-global / trae / trae-global / qoder
  // 别的 provider（DeepSeek 官方等）一律**不渲染** —— 这行是内置胶囊的
  // 地盘，不该被一个显示无关信息的控件占位。
  //
  // 取数成本是这里最需要克制的地方：两个状态接口都会真的向上游发起
  // **计费调用**（WorkBuddy 每账号一次 credits 查询），所以：
  //   - 绝不定时轮询，只在挂载、切模型、点击时取；
  //   - 结果按 provider 缓存 30 秒，同一 provider 反复切换不重复打；
  //   - 失败静默降级为不显示数字，绝不因为拿不到额度影响输入框。

  /** provider id → 这个胶囊要查的池 */
  const CREDIT_SOURCES = {
    'workbuddy-xdpool': { kind: 'wb', region: 'cn', label: 'WorkBuddy' },
    'workbuddy-xdpool-global': { kind: 'wb', region: 'global', label: 'WorkBuddy 国际版' },
    trae: { kind: 'trae', region: 'cn', label: 'Trae' },
    'trae-global': { kind: 'trae', region: 'ai', label: 'Trae 国际版' },
    // Qoder CN：号池走宿主的 `/qoder/pool`，它已经算好 `serving`（谁在被调用 +
    // 它的余额），所以这里不需要自己拼「按 lastServedId 去 accounts 里找」。
    qoder: { kind: 'qoder', region: '', label: 'Qoder' },
  };

  /**
   * 自动刷新间隔：**30 秒**，与上游自己刷同一个接口的节奏一致。
   *
   * `vendor/xdpool/lib/client.js` 的 `POLL_INTERVAL_MS = 3e4` —— 那张卡片就是
   * 这么刷 `/status` 的。为什么不能更快：这两个接口**每次都会发起真实的上游
   * 计费调用**（WorkBuddy 侧对池里每个账号各查一次 credits），池子里那套 429
   * 冷却重试正是为这类调用准备的。把它压到「几秒」会让请求量比号池任何既有
   * 行为高一个数量级，很可能把账号打成限流、连带影响正常对话。
   *
   * 所以：跟随上游节奏，不更激进。
   *
   * 宿主侧的 Qoder 单账号额度读取另有 3 分钟的新鲜窗口（见 lib/index.js 的
   * `QODER_DISPLAY_CREDIT_FRESH_MS`），所以这个 30 秒不会变成每 30 秒一次
   * Qoder 额度调用 —— 这一点由宿主保证，前端不必也不能知道。
   */
  const CREDIT_REFRESH_MS = 30000;
  /**
   * 模块级缓存：key 是 provider id。
   *
   * 刻意放在组件外 —— 胶囊在每次会话切换时都会重新挂载，缓存放组件内
   * 就等于没有缓存。挂起中的 promise 也一起存，避免快速切换时并发打两发。
   */
  const creditCache = new Map();

  function readCreditCache(provider) {
    return creditCache.get(provider);
  }

  /**
   * 缓存是否仍然「新鲜」。
   *
   * pending 中的记录一律算新鲜：已经在路上了，没必要再发一次。
   * 判定用 `atMs`（上一次**完成**的时间），所以一次慢请求不会导致
   * 刚回来就立刻又发一发。
   */
  function isCreditFresh(rec) {
    if (rec === undefined) return false;
    if (rec.pending !== undefined) return true;
    return Date.now() - rec.atMs < CREDIT_REFRESH_MS;
  }

  /** 数字（可能为 undefined）→ 展示串；读不到时给「–」而不是 0。 */
  function fmtCreditOrDash(value) {
    return typeof value === 'number' && Number.isFinite(value) ? fmtNum(value) : '–';
  }

  /**
   * 给账号起个能看的名字。
   *
   * Qoder 的 `label` 在没拿到 userName 时是一整条 UUID（`01a0c90b-4f7c-…`），
   * 直接塞进胶囊会把那一行撑开、挤掉内置的 tok/s 胶囊。所以：取前 8 位 + 省略号；
   * 短名（WorkBuddy 的昵称「1412」、Trae 的「用户9773022806」）原样保留。
   */
  function shortAccountName(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    if (text === '') return '';
    return text.length <= 12 ? text : `${text.slice(0, 8)}…`;
  }

  /**
   * 从一个账号行里取出「这个账号还剩多少」。
   *
   * 三种池的字段名不同（WorkBuddy `credits.total`、Trae `credits.total` /
   * `credits.available`、Qoder 直接是数字），这里统一成一个数字或 undefined。
   * **拿不到就返回 undefined**，不要回退成 0：把「读不到」显示成「没有余额」
   * 会让人去删一个本来健康的账号。
   */
  function accountCreditsOf(row) {
    const c = row?.credits;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    for (const key of ['total', 'available', 'generalAvailable']) {
      const v = c?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  }

  /**
   * 从一堆账号行里挑出「正在被调用的那个」。
   *
   * 判据按可信度排序（各家池暴露的字段不一样，逐一回退）：
   *   1. 显式给的 id（调用方已经知道是谁，例如宿主算好的 `serving.accountId`）；
   *   2. `lastServedId` —— 「刚真的服务过请求的账号」，这是「所调用账号」的
   *      字面答案，也是本功能的核心；
   *   3. `selectedAccountId` / `activeAccountId` —— 固定选中的那个（WorkBuddy
   *      侧的 `activeAccountId` 在语义上就是「上次服务的账号」）；
   *   4. 行自身的 `selected` / `active` / `used` 标记。
   *
   * 一个都没有时返回 undefined —— **绝不退化成「所有账号之和」**：那个数字
   * 与「这次调用扣了谁」无关，把它显示出来正是本次要修的问题。
   */
  function pickServingAccount(accounts, hints = {}) {
    const rows = asArray(accounts).filter((a) => a !== null && typeof a === 'object');
    if (rows.length === 0) return undefined;
    const byId = (id) => (typeof id === 'string' && id !== '' ? rows.find((a) => a.id === id) : undefined);

    const explicit = byId(hints.accountId);
    if (explicit !== undefined) return explicit;
    const served = byId(hints.lastServedId);
    if (served !== undefined) return served;
    const selected = byId(hints.selectedAccountId) ?? byId(hints.activeAccountId);
    if (selected !== undefined) return selected;
    const flagged = rows.find((a) => a.selected === true || a.active === true || a.used === true);
    if (flagged !== undefined) return flagged;
    // 只有一个账号时不存在歧义 —— 这个回退让「单账号池」不必依赖任何标记，
    // 也顺带覆盖了各家池在冷启动时还没记下「谁被调用过」的情形。
    return rows.length === 1 ? rows[0] : undefined;
  }

  /**
   * 把「一个账号行的集合 + 谁在被调用的线索」整理成胶囊要的形状。
   *
   * 返回值形如 `{ total, account: { id, name, credits }, accounts, fullTotal }`：
   *   - `total` —— **被调用账号**的余额，胶囊上显示的就是它；
   *   - `account` —— 那个账号（`name` 已缩短、`credits` 可能为 undefined）；
   *   - `accounts` —— 池里账号数（进 title）；
   *   - `fullTotal` —— 全池合计，**只在 title 里**当参考值出现。它回答的是
   *     「这个池总共还有多少」，与「这一轮扣了谁」是两个问题，所以不能抢
   *     胶囊上那个数字的位置。
   */
  function summarizeServingCredits(accounts, hints = {}) {
    const rows = asArray(accounts).filter((a) => a !== null && typeof a === 'object');
    const account = pickServingAccount(rows, hints);
    let fullTotal;
    for (const row of rows) {
      const v = accountCreditsOf(row);
      if (typeof v === 'number') fullTotal = (fullTotal ?? 0) + v;
    }
    return {
      total: account === undefined ? undefined : accountCreditsOf(account),
      account:
        account === undefined
          ? undefined
          : {
              id: account.id,
              name: shortAccountName(account.nickname ?? account.label ?? account.name ?? ''),
              credits: accountCreditsOf(account),
            },
      accounts: rows.length,
      fullTotal,
    };
  }

  /**
   * 取某个 provider 「正在被调用的账号」的剩余积分。
   *
   * 取不到时 `total` 为 undefined —— 调用方一律按「不显示数字」处理，
   * 不区分失败原因（原因进 title）。
   */
  async function fetchCredits(source) {
    if (source.kind === 'wb') {
      const data = await fetchJson(`${POOL_API}/status?region=${source.region}`);
      // WorkBuddy 的 `/status` 已经明确给出「最近服务的账号」：`activeAccountId`
      // 由 vendored 池的 `lastServedId()` 兜底（`selectedAccountId` 为 null 时
      // 它就是上次真正跑过请求的那个），所以这里直接用，不再自己猜。
      return summarizeServingCredits(data?.accounts, {
        accountId: undefined,
        lastServedId: data?.activeAccountId,
        selectedAccountId: data?.selectedAccountId,
      });
    }
    if (source.kind === 'qoder') {
      const data = await fetchJson(`${SELF_API}/qoder/pool`);
      const serving = data?.serving;
      const rows = asArray(data?.accounts);
      const picked = pickServingAccount(rows, {
        accountId: serving?.accountId,
        lastServedId: data?.lastServedId,
        selectedAccountId: data?.selectedAccountId,
      });
      // 宿主已经为 `serving` 那一份读过余额（且带 3 分钟节流），优先用它；
      // 它读不到时才退回逐账号快照里的同一行。两者都拿不到 ⇒ undefined，
      // 胶囊显示「积分 –」，**不显示 0**。
      const servedCredits =
        typeof serving?.credits === 'number' && Number.isFinite(serving.credits) ? serving.credits : undefined;
      return {
        total: servedCredits ?? accountCreditsOf(picked),
        account:
          servedCredits !== undefined || (serving?.accountId ?? null) !== null
            ? {
                id: serving?.accountId ?? picked?.id,
                name: shortAccountName(serving?.label ?? picked?.label ?? ''),
                credits: servedCredits ?? accountCreditsOf(picked),
              }
            : picked === undefined
              ? undefined
              : {
                  id: picked.id,
                  name: shortAccountName(picked.label ?? ''),
                  credits: accountCreditsOf(picked),
                },
        accounts: rows.length,
        // 读失败的原因要能透出来（否则用户只看到「–」，「为什么」全靠猜）。
        // 绝不把它变成 0。
        error: typeof serving?.error === 'string' && serving.error !== '' ? serving.error : undefined,
        source: typeof serving?.source === 'string' ? serving.source : undefined,
      };
    }
    const data = await fetchJson(`${TRAE_API}/usage?region=${source.region}`);
    // Trae 同口径：`pool.lastServedId` 是「刚服务过请求的账号」，`credits` 是
    // 逐账号的余额快照。区域级的 `data.credits`（generalAvailable + workAvailable）
    // 是**整片区域**的合计，与被调用的账号不是一回事 —— 只留作 title 里的参考。
    const summary = summarizeServingCredits(data?.accounts, {
      lastServedId: data?.pool?.lastServedId,
      selectedAccountId: data?.pool?.selectedAccountId ?? data?.selectedAccountId,
    });
    summary.fullTotal =
      typeof data?.credits?.generalAvailable === 'number'
        ? data.credits.generalAvailable +
          (typeof data?.credits?.workAvailable === 'number' ? data.credits.workAvailable : 0)
        : summary.fullTotal;
    return summary;
  }

  /**
   * 发起一次取数（若已有在途请求则复用它），返回缓存记录。
   *
   * `force` 为真时绕开新鲜度判定（点击刷新、定时到点）。
   */
  function requestCredits(provider, source, force = false) {
    const existing = creditCache.get(provider);
    // 在途的一律复用：force 也不重复发，避免连点叠出多份计费调用
    if (existing !== undefined && existing.pending !== undefined) return existing;
    if (!force && isCreditFresh(existing)) return existing;
    const rec = {
      atMs: existing?.atMs ?? 0,
      pending: undefined,
      total: existing?.total,
      accounts: existing?.accounts,
      // 账号信息一并跨代保留：一次刷新失败时，上次读到的「是谁 + 它剩多少」
      // 仍然比空白有用，只是会把 `error` 挂上去。
      account: existing?.account,
      fullTotal: existing?.fullTotal,
      source: existing?.source,
      error: undefined,
    };
    rec.pending = fetchCredits(source)
      .then((r) => {
        rec.total = r.total;
        rec.accounts = r.accounts;
        rec.account = r.account;
        rec.fullTotal = r.fullTotal;
        rec.source = r.source;
        rec.error = r.error;
      })
      .catch((e) => {
        // 失败保留上一次的数字，只更新错误 —— 抖一下不该让余额消失
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
   *
   * 刷新策略：**每 30 秒自动刷一次**（见 CREDIT_REFRESH_MS 的成本说明），
   * 外加切换模型时立刻刷、点击时强制刷。不再需要手动点。
   * 三个必须守住的细节：
   *   1. 定时器只在 provider 属于本插件时才起，切走要清掉；
   *   2. 组件卸载后回调不能再 setState（React 会警告，且可能写到已卸载的树）；
   *   3. 页面隐藏（切到别的窗口/标签）时暂停 —— 没人看的时候不该继续烧上游调用。
   */
  function ComposerCreditsPill({ sessionId, resolveModelDirectory }) {
    const current = useCurrentModel(resolveModelDirectory, sessionId);
    const provider = current?.provider ?? '';
    const source = CREDIT_SOURCES[provider];

    const [tick, setTick] = useState(0);

    useEffect(() => {
      if (source === undefined) return undefined;
      ensureCss();

      let alive = true;
      let timer = null;

      /** 发一次取数；完成后触发重渲染。force 用于到点与点击。 */
      const run = (force) => {
        const rec = requestCredits(provider, source, force);
        rec.pending?.then(() => {
          if (alive) setTick((n) => n + 1);
        });
      };

      // 挂载 / 切模型：缓存还新鲜就只订阅它的完成，不重复发请求
      const cached = readCreditCache(provider);
      if (isCreditFresh(cached)) {
        cached.pending?.then(() => {
          if (alive) setTick((n) => n + 1);
        });
      } else {
        run(true);
      }

      const startTimer = () => {
        if (timer !== null) return;
        timer = setInterval(() => {
          // 页面隐藏时跳过这一拍：没人看的时候不烧上游调用
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          run(true);
        }, CREDIT_REFRESH_MS);
      };
      const stopTimer = () => {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      };

      startTimer();

      /**
       * 回到前台立刻补一次。
       *
       * 隐藏期间定时器是空转的，回来时数字可能已经旧了几分钟；
       * 而用户刚切回来正是最可能看它一眼的时刻。若缓存仍新鲜（比如只切走
       * 两秒）就不重复打，交给原本那一拍。
       */
      const onVisible = () => {
        if (typeof document === 'undefined') return;
        if (document.visibilityState !== 'visible') return;
        if (!isCreditFresh(readCreditCache(provider))) run(true);
      };
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisible);
      }

      return () => {
        alive = false;
        stopTimer();
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisible);
        }
      };
      // provider 变了要重建定时器与缓存判定；tick 只用于强制重渲染，不进依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider]);

    if (source === undefined) return null;
    const rec = readCreditCache(provider);
    const total = rec?.total;
    const account = rec?.account;
    const stale = rec !== undefined && rec.pending === undefined && !isCreditFresh(rec);
    const who = account?.name ? `${account.name}` : '账号未知';
    /**
     * title 要把「这个数字是谁的」说清楚。
     *
     * 曾经这里只有一句「剩余 N 积分」，而 N 是全池之和 —— 于是池子里有 3 个
     * 账号时，用户看到的是一个任何人都对不上的数字。现在主语是**被调用的
     * 那个账号**，全池合计只作为参考值出现（`fullTotal`），且明确标注口径。
     */
    const title =
      total === undefined
        ? `${source.label}：${who} 的额度读取中…${rec?.error ? `（${rec.error}）` : ''}`
        : `${source.label} · ${who} 剩余 ${fmtNum(total)} 积分（本次调用扣的就是它）` +
          (typeof rec?.fullTotal === 'number' && rec.accounts > 1
            ? ` · 全池 ${fmtNum(rec.fullTotal)}`
            : '') +
          (typeof rec?.accounts === 'number' && rec.accounts > 0 ? ` · ${rec.accounts} 个账号` : '') +
          (rec?.source === 'next' ? ' · 本进程还没发过请求，这是下一个会用的账号' : '') +
          (rec?.error ? ` · 上次刷新失败：${rec.error}` : '') +
          ` · 每 ${CREDIT_REFRESH_MS / 1000} 秒自动刷新（点击立即刷新）`;

    return jsx('button', {
      type: 'button',
      className: 'wotr-credit-pill',
      'data-busy': stale ? '0' : rec?.pending !== undefined ? '1' : '0',
      'data-state': typeof total === 'number' && total <= 0 ? 'warn' : 'ok',
      title,
      onClick: () => {
        // 点击 = 立即刷新，绕开新鲜度判定（在途时仍复用，不叠请求）
        const r = requestCredits(provider, source, true);
        r.pending?.then(() => setTick((n) => n + 1));
        setTick((n) => n + 1);
      },
      children: [
        jsx('span', { className: 'wotr-credit-pill-dot' }),
        jsx('span', {
          className: 'wotr-credit-pill-num',
          // 账号名放在数字前面：用户第一眼要能回答「这个余额是谁的」。
          // 名字拿不到时给个占位，而不是把数字孤零零放出来。
          children:
            total === undefined
              ? `积分 –${account?.name ? ` · ${account.name}` : ''}`
              : `积分 ${fmtNum(total)}${account?.name ? ` · ${account.name}` : ''}`,
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

    // —— Qoder 号池自己的状态（与上面两家完全独立）——
    // Qoder 用设备流登录（无回调端口），池里的账号只能靠逐个浏览器登录累积，
    // 所以它既不像 WorkBuddy 那样扫本机登录态，也没有 Trae 的区域划分。
    const [qoderStatus, setQoderStatus] = useState(null);
    const [qoderLoading, setQoderLoading] = useState(false);
    const [qoderError, setQoderError] = useState(null);
    const [qoderBusy, setQoderBusy] = useState(false);
    const [qoderLogin, setQoderLogin] = useState(null);
    // 保留额度的输入草稿（与 Trae 侧同款：输入时只改本地，点保存才写回池）
    const [qoderReserveDraft, setQoderReserveDraft] = useState({});
    // 刷新积分的结果提示：`{ refreshed, failed, errors: { id: message } }`。
    // 之所以要单独存而不是复用 qoderError：**部分失败**不是页面级错误 ——
    // 3 个账号里 1 个读失败时，另外 2 个的余额已经刷新成功了，把整页标红
    // 会让用户以为全都没刷到。
    const [qoderCreditsNote, setQoderCreditsNote] = useState(null);
    /** 上次自动刷新成功的时刻，用于在卡片上标注「多久没刷到了」。 */
    const [qoderCreditsAtMs, setQoderCreditsAtMs] = useState(0);
    /** 自动刷新在途标记。用 ref 而非 state：它只用于去重，不该触发重渲染。 */
    const qoderCreditsInFlight = useRef(false);
    /**
     * 账号页两列的分配策略：写入中的标记与错误。
     *
     * 策略值本身**不存 state** —— 它就在 `status.distribution`（WorkBuddy，
     * 顶层键）与 `traeStatus.pool.distribution`（Trae，按区域）里，写完刷新
     * 状态自然就读回新值。再存一份本地副本就会出现「本地已改、上游没落地」
     * 的假象，正是本项目反复避免的那类 bug。
     *
     * 声明位置：这几个 hook 必须排在第 15 个 hook（qoderStatus）**之后** ——
     * test/console-render.test.mjs 的 mini-react 用一个共享游标按源码顺序发
     * hook 槽位，用例只按下标预设了 0/1/9/15，插在它们前面会把预设值喂错槽位。
     */
    const [wbDistributionBusy, setWbDistributionBusy] = useState(false);
    const [wbDistributionError, setWbDistributionError] = useState(null);
    const [traeDistributionBusy, setTraeDistributionBusy] = useState(false);
    const [traeDistributionError, setTraeDistributionError] = useState(null);
    /**
     * Qoder 数据是否处于「可见」状态。
     *
     * 面板同时挂在**两个 tab** 下：「账号」页的第三列与独立的「Qoder 号池」
     * 标签页。懒加载与自动刷新都以它为判据 —— 只写 `tab === 'qoder'` 会让
     * 从「账号」页进来时那一列永远是空的、余额永远停在「读取中…」。
     * 放在状态声明之后、所有 effect 之前：effect 依赖它，顺序反了就是
     * 「used before defined」。
     */
    // 「积分」页也要它：那一页会显示 Qoder 账号的余额与被调用的那个账号，
    // 漏掉这一项的表现是「积分页里 Qoder 那一段永远是空的」。
    const qoderVisible = tab === 'qoder' || tab === 'accounts' || tab === 'wb-credits';

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
     * 切换 WorkBuddy 的「当前账号」。
     *
     * 区域是必须的：国内版与国际版是两个独立 provider，各自固定自己的账号
     * （服务端按 `?region=` 写进 `selectedAccountIds` 的对应键）。
     *
     * `accountId: null` = 取消固定，回到号池轮换。
     */
    const onSelectAccount = useCallback(
      async (accountId) => {
        setBusyId('select');
        setError(null);
        try {
          await fetchJson(`${POOL_API}/accounts/select?region=${region}`, {
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
      [loadStatus, region],
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
     * 账号页两列的分配策略写入。
     *
     * 与配置页**复用同一条写入路径**，不另起一套：
     *
     *   - WorkBuddy：`distribution` 是**顶层**设置键，直接 `set` 一次即可。
     *     宿主在 `loader/volatile-update` → `applyConfigFromSource` 里把它推进
     *     活着的池（`core.pool.applyConfig({ distribution })`），所以写完刷新
     *     `/status` 就能读回新值。
     *   - Trae：策略存在 `regions.<region>.distribution` 槽里，只改目标区域的
     *     槽、其余槽原样带过（`nextRegionSlots`），写完读回确认落地。
     *
     * 两个写入都必须检查 `set()` 的返回值并读回：`set()` resolve 了不等于
     * 写进去了 —— 这是本项目踩过的坑（上游报「保存成功」而值悄悄弹回）。
     *
     * 另外，两列的 settings 作用域是否可写要**在渲染期**读出来（与
     * PoolConfigTab 同款）：不可写时按钮直接置灰并给出说明，而不是等用户
     * 点了才报错。这两个都是普通 const，不是 hook，不影响 hook 槽位。
     */
    const wbDistributionWritable = poolWritable(poolScopeOf(wbSettings));
    const traeDistributionWritable = poolWritable(poolScopeOf(traeSettings));

    const onWbDistribution = useCallback(
      async (next) => {
        const scopeObj = poolScopeOf(wbSettings);
        if (scopeObj === null || scopeObj === undefined) {
          setWbDistributionError('设置作用域不可用，无法保存');
          return;
        }
        if (!poolWritable(scopeObj)) {
          setWbDistributionError('设置作用域不可写，无法保存');
          return;
        }
        setWbDistributionBusy(true);
        setWbDistributionError(null);
        try {
          if ((await scopeObj.set('distribution', next)) === false) {
            throw new Error(`设置字段 "distribution" 被宿主拒绝`);
          }
          await loadStatus();
        } catch (e) {
          setWbDistributionError(e?.message ?? String(e));
        } finally {
          setWbDistributionBusy(false);
        }
      },
      [wbSettings, loadStatus],
    );

    const onTraeDistribution = useCallback(
      async (next) => {
        const scopeObj = poolScopeOf(traeSettings);
        if (scopeObj === null || scopeObj === undefined) {
          setTraeDistributionError('设置作用域不可用，无法保存');
          return;
        }
        if (!poolWritable(scopeObj)) {
          setTraeDistributionError('设置作用域不可写，无法保存');
          return;
        }
        setTraeDistributionBusy(true);
        setTraeDistributionError(null);
        try {
          const value = scopeObj.getSnapshot().value;
          const slot = { ...traeRegionSlotOf(value, traeRegion), distribution: next };
          await writeTraeField(
            scopeObj,
            'regions',
            nextRegionSlots(regionsMapOf(value), traeRegion, slot),
            (readBack) => traeRegionSlotOf(readBack, traeRegion).distribution === next,
          );
          await loadTrae();
        } catch (e) {
          setTraeDistributionError(e?.message ?? String(e));
        } finally {
          setTraeDistributionBusy(false);
        }
      },
      [traeSettings, traeRegion, loadTrae],
    );

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


    // —— Qoder 号池：读取 / 登录 / 池操作 ——

    /** 读一次号池快照（账号 + 冷却 + 停用 + 保留额度）。 */
    const loadQoder = useCallback(async () => {
      setQoderLoading(true);
      setQoderError(null);
      try {
        const data = await fetchJson(`${SELF_API}/qoder/pool`);
        if (data?.error !== undefined) {
          setQoderError(data.error);
          setQoderStatus(null);
          return null;
        }
        setQoderStatus(data);
        return data;
      } catch (e) {
        setQoderError(e?.message ?? String(e));
        setQoderStatus(null);
        return null;
      } finally {
        setQoderLoading(false);
      }
    }, []);

    /**
     * Qoder 号池的**写入路径 = settings**（`dsh-connect-qoder` 入口），
     * 与 Trae 半边逐字同一条规则。
     *
     * 为什么不是 HTTP 路由：那几条 POST 路由（`/qoder/pool/select` 等）改的是
     * 管理页那个池实例，而请求走的是 provider 入口的另一个池 —— 写完「当前
     * 账号」，provider 读不到，用户看到的就是**「固定了账号，请求还是打到别的
     * 号上」**。设置写在 `dsh-connect-qoder` 这个入口身上，provider 会在
     * `loader/volatile-update` 时把它推给池（见 lib/qoder.js 的 syncPoolConfig），
     * 于是写入与生效是同一份数据，而且**重启后还在**。
     *
     * 两条仍然用 HTTP 的操作（移出池子 / 重置冷却）是运行时状态而非配置：
     * 前者删除凭据文件，后者清冷却，它们本来就不该落进设置。
     */
    const [qoderWriteError, setQoderWriteError] = useState(null);
    const [qoderSettingsRev, setQoderSettingsRev] = useState(0);

    /**
     * 设置文档变化 → 重算作用域（可写性与「当前账号」都跟着刷新）。
     *
     * 需要它的具体场景：句柄在页面挂载**之后**才解析出作用域，此时这一帧算出的
     * `qoderWritable` 还是 false，卡片上的按钮会全部呈禁用态；不订阅就永远停在
     * 只读样子。另一个窗口改了设置也能顺带同步过来。
     *
     * ⚠️ 计数器必须是**真的会变**的值：用 `setX((v) => v)` 那种恒等更新，
     * React 会按 `Object.is` 判定「状态没变」而不重渲染。
     */
    useEffect(() => {
      if (qoderSettings === null || qoderSettings === undefined) return undefined;
      if (typeof qoderSettings.subscribe !== 'function') return undefined;
      return qoderSettings.subscribe(() => setQoderSettingsRev((v) => v + 1));
    }, [qoderSettings]);

    const qoderSettingsScope = useMemo(
      () => poolScopeOf(qoderSettings),
      [qoderSettings, qoderSettingsRev],
    );
    const qoderWritable = useMemo(() => poolWritable(qoderSettingsScope), [qoderSettingsScope]);

    /**
     * 写一个号池 settings 字段：读回确认 → 重读快照。
     *
     * 读回确认不是洁癖：volatile 字段之外的写入会被宿主**静默回滚**，
     * `set()` 照样 resolve。没有这一步，「切换到此账号」会表现成点了没反应。
     */
    const writeQoderPoolField = useCallback(
      async (field, value, landed) => {
        const scope = poolScopeOf(qoderSettings);
        setQoderBusy(true);
        setQoderWriteError(null);
        try {
          if (scope === null || scope === undefined) {
            setQoderWriteError(
              '宿主的 configForms 里没有 `dsh-connect-qoder` 这个入口，无法保存号池设置（只读诊断）。',
            );
            return null;
          }
          await writeSettingsField(scope, field, value, landed, 'qoder');
          await loadQoder();
          return true;
        } catch (e) {
          setQoderWriteError(e?.message ?? String(e));
          return null;
        } finally {
          setQoderBusy(false);
        }
      },
      [loadQoder, qoderSettings],
    );

    /** 读一份配置快照（每次现场读，不缓存：保存后同一个作用域上就是新值）。 */
    const qoderConfigSnapshot = useCallback(() => {
      const scope = poolScopeOf(qoderSettings);
      try {
        return unwrapVolatileDeep(scope?.getSnapshot?.().value) ?? {};
      } catch {
        return {};
      }
    }, [qoderSettings]);

    /** 池写操作（移出池子 / 重置冷却）统一包一层：转圈 + 重读。 */
    const qoderAction = useCallback(
      async (url, body) => {
        setQoderBusy(true);
        setQoderError(null);
        try {
          const r = await fetchJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          });
          if (r?.error !== undefined) {
            setQoderError(r.error);
            return null;
          }
          await loadQoder();
          return r;
        } catch (e) {
          setQoderError(e?.message ?? String(e));
          return null;
        } finally {
          setQoderBusy(false);
        }
      },
      [loadQoder],
    );

    /**
     * 停用 / 启用：往 `disabledAccountIds` 里加减这个账号。
     *
     * 必须**读出当前列表再合并** —— 整段覆盖写会把别的账号的停用状态清掉，
     * 表现为「停用了 A，B 自己被启用了」。
     */
    const onQoderToggle = useCallback(
      (accountId, disabled) => {
        const current = asArray(qoderConfigSnapshot().disabledAccountIds).filter(
          (id) => typeof id === 'string',
        );
        const next = disabled === true
          ? [...new Set([...current, accountId])]
          : current.filter((id) => id !== accountId);
        const want = disabled === true;
        return writeQoderPoolField(
          'disabledAccountIds',
          next,
          (doc) => asArray(doc?.disabledAccountIds).includes(accountId) === want,
        );
      },
      [qoderConfigSnapshot, writeQoderPoolField],
    );

    /** 保存保留额度：草稿为空 / 0 时**删掉**这个键（= 取消保留）。 */
    const onQoderReserve = useCallback(
      (accountId) => {
        const raw = qoderReserveDraft[accountId];
        const credits = raw === undefined || raw === '' ? 0 : Number(raw);
        if (!Number.isFinite(credits) || credits < 0) {
          setQoderWriteError('保留额度必须是非负数字');
          return null;
        }
        const value = Math.floor(credits);
        const current = qoderConfigSnapshot().creditReserves ?? {};
        const next = { ...current };
        if (value <= 0) delete next[accountId];
        else next[accountId] = value;
        return writeQoderPoolField(
          'creditReserves',
          next,
          (doc) => (Number(doc?.creditReserves?.[accountId]) || 0) === value,
        );
      },
      [qoderConfigSnapshot, qoderReserveDraft, writeQoderPoolField],
    );

    const onQoderRemove = useCallback(
      (accountId) => qoderAction(`${SELF_API}/qoder/pool/remove`, { accountId }),
      [qoderAction],
    );

    /**
     * 切换「当前账号」：请求从此固定用它（Trae 侧「切换到此账号」同款）。
     *
     * 只写 `selectedAccountId` 一个键。**没有「取消固定」**：池里必须永远有一个
     * 当前账号，清空选择只会悄悄回到「池里第一个账号」——用户看不出发生了什么，
     * 不如不给这个动作。想换别的就直接点那张卡的按钮。
     */
    const onQoderSelect = useCallback(
      (accountId) =>
        writeQoderPoolField('selectedAccountId', accountId, (doc) => doc?.selectedAccountId === accountId),
      [writeQoderPoolField],
    );

    const onQoderResetCooldowns = useCallback(
      () => qoderAction(`${SELF_API}/qoder/cooldowns/reset`, {}),
      [qoderAction],
    );

    /**
     * 刷新上游积分额度 —— **自动、静默**。
     *
     * 三条刻意的设计：
     *
     * 1. **不置 `qoderBusy`**。那个标志会禁用卡片上的所有按钮（停用 / 移出 /
     *    保存保留额度）。每 30 秒把整页按钮锁住一小会儿，用户会看到按钮
     *    周期性地「闪一下变灰」——自动刷新不该有这种存在感。
     * 2. **成功不提示**。只有失败才占一行字。一个每 30 秒就冒出来的
     *    「已刷新 3 个账号」提示，等同于噪声。
     * 3. **不走 `qoderAction`**：那条路把任何 `error` 当页面级错误，而
     *    「部分账号读失败」是正常结果（整体仍是 200），逐账号原因要就地显示
     *    在各自卡片上，不能把整页标红 —— 否则 3 个号里 1 个失败，另外 2 个
     *    已刷新的余额会被一个红条盖住，看起来像全都没刷到。
     *
     * 返回是否发生了刷新（页面隐藏 / 在途时跳过并返回 false）。
     */
    const refreshQoderCredits = useCallback(async () => {
      // 在途时不叠请求：30 秒一拍，但上游慢时可能超过一拍。
      if (qoderCreditsInFlight.current) return false;
      // 页面隐藏时跳过：没人看的时候不烧上游调用（与 composer 胶囊同款）。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      qoderCreditsInFlight.current = true;
      try {
        const r = await fetchJson(`${SELF_API}/qoder/credits/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (r?.error !== undefined) {
          setQoderCreditsNote({ refreshed: 0, failed: 0, errors: {}, message: r.error });
          return false;
        }
        const failed = asArray(r?.accounts).filter((entry) => entry?.ok !== true);
        setQoderCreditsNote({
          refreshed: Number(r?.refreshed) || 0,
          failed: Number(r?.failed) || 0,
          errors: Object.fromEntries(failed.map((entry) => [entry.id, entry.message ?? '读取失败'])),
        });
        setQoderCreditsAtMs(Date.now());
        // 余额变了，卡片上的「余额」行与合计都要跟着变 —— 重读一次快照。
        await loadQoder();
        return true;
      } catch (e) {
        // 网络层失败也只记提示，不把整页标红：下一拍会自动重试。
        setQoderCreditsNote({ refreshed: 0, failed: 0, errors: {}, message: e?.message ?? String(e) });
        return false;
      } finally {
        qoderCreditsInFlight.current = false;
      }
    }, [loadQoder]);

    /**
     * 自动刷新积分：进「Qoder 号池」或「账号」页就开始，离开就停。
     *
     * 只在**这两个 tab 可见时**跑（依赖 `qoderVisible`），因为额度数据只在这
     * 两处显示；切到别的 tab 还继续打上游调用是纯浪费。回到这页会立刻补一次，
     * 不必等下一拍（`refreshQoderCredits` 自身会跳过隐藏状态）。
     */
    useEffect(() => {
      if (!qoderVisible) return undefined;
      refreshQoderCredits();
      const timer = setInterval(() => {
        refreshQoderCredits();
      }, QODER_CREDITS_REFRESH_MS);
      return () => clearInterval(timer);
    }, [qoderVisible, refreshQoderCredits]);

    /**
     * 回到前台立刻补一次。
     *
     * 隐藏期间定时器是空转的，回来时余额可能已经旧了几分钟；而用户刚切回来
     * 正是最可能看它一眼的时刻。
     */
    useEffect(() => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return undefined;
      }
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        if (qoderVisible) refreshQoderCredits();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }, [qoderVisible, refreshQoderCredits]);

    /**
     * Qoder 的「添加账号」：设备流登录。
     *
     * 与 Trae 的回环回调流程不同，这里**没有回调页** —— 服务端一边轮询
     * `/api/v1/deviceToken/poll`，前端只需轮询 `/qoder/login/status`。
     * 授权页未点确认时轮询返回 404，服务端会继续轮询（不是错误），
     * 所以前端这条循环只需处理 pending / done / failed 三种终态。
     */
    const onQoderAddAccount = useCallback(async () => {
      setQoderLogin({ pending: true });
      try {
        const started = await fetchJson(`${SELF_API}/qoder/login/start`, { method: 'POST' });
        if (started?.error !== undefined) {
          setQoderLogin({ error: started.error });
          return;
        }
        // 与 WorkBuddy / Trae 同一条规则：服务端已用系统浏览器打开过就不再开一个。
        if (started.opened !== true) {
          try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(started.authUrl, '_blank', 'noopener');
            }
          } catch {
            /* 弹窗被拦下时走手动打开 */
          }
        }
        setQoderLogin({ pending: true, authUrl: started.authUrl, opened: started.opened === true });

        // 设备流最长 5 分钟，这里给 5 分钟多一点余量。
        const deadline = Date.now() + 5 * 60 * 1000 + 15000;
        while (loginAlive.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const st = await fetchJson(
            `${SELF_API}/qoder/login/status?session=${encodeURIComponent(started.sessionId)}`,
          );
          if (!loginAlive.current) return;
          if (st?.error !== undefined) {
            setQoderLogin({ error: st.error });
            return;
          }
          if (st?.status === 'done') {
            setQoderLogin(null);
            // 服务端落盘时已让池重扫过，这里再读一次把新账号显示出来。
            await loadQoder();
            return;
          }
          if (st?.status === 'failed') {
            setQoderLogin({ error: st.error ?? '登录失败' });
            return;
          }
        }
        if (!loginAlive.current) return;
        setQoderLogin({ error: '登录超时：请重试' });
        try {
          await fetchJson(
            `${SELF_API}/qoder/login/cancel?session=${encodeURIComponent(started.sessionId)}`,
            { method: 'POST' },
          );
        } catch {
          /* 服务端会话有自己的超时 */
        }
      } catch (e) {
        setQoderLogin({ error: e?.message ?? String(e) });
      }
    }, [loadQoder]);

    /**
     * 第一次切到「Qoder」标签页或「账号」页时才拉号池。
     *
     * 与 Trae 侧同样的懒加载理由：`/qoder/pool` 每次都会重扫凭据目录，
     * 没必要在打开设置面板时就跑一遍。
     */
    const qoderLoaded = useRef(false);
    useEffect(() => {
      if (!qoderVisible) return undefined;
      if (qoderLoaded.current) return undefined;
      qoderLoaded.current = true;
      loadQoder();
      return undefined;
    }, [qoderVisible, loadQoder]);

    /**
     * Qoder 面板的 props。
     *
     * 抽成一个对象是因为面板要在**两个 tab 下渲染**（账号页第三列 + 独立
     * 标签页）。复制两份 props 迟早会漏改一处 —— 比如加了新的回调只接到
     * 其中一边，表现为「同一个面板在两个地方行为不一样」。
     */
    const qoderPanelProps = {
      status: qoderStatus,
      loading: qoderLoading,
      error: qoderError,
      writeError: qoderWriteError,
      writable: qoderWritable,
      busy: qoderBusy,
      login: qoderLogin,
      reserveDraft: qoderReserveDraft,
      setReserveDraft: setQoderReserveDraft,
      creditsNote: qoderCreditsNote,
      creditsAtMs: qoderCreditsAtMs,
      onRefresh: loadQoder,
      onAddAccount: onQoderAddAccount,
      onToggle: onQoderToggle,
      onReserve: onQoderReserve,
      onRemove: onQoderRemove,
      onSelect: onQoderSelect,
      onResetCooldowns: onQoderResetCooldowns,
    };

    const tabs = [
      { id: 'pool-config', label: 'XD Pool' },
      { id: 'trae-config', label: 'Trae 配置' },
      { id: 'accounts', label: '账号' },
      { id: 'qoder', label: 'Qoder 配置' },
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
                '配置并查看 WorkBuddy 账号池、Trae 接入与 Qoder 号池：模型勾选、分配策略、账号与额度、积分与使用记录。WorkBuddy 与 Trae 可以直接在浏览器里登录添加（「账号」页左右两列的「添加账号」）；Qoder 桌面端每个安装只保存一份登录，扫不出多个账号，请在「Qoder 配置」页用「添加账号」逐个登录入池。',
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
                onSelect: onSelectAccount,
                login,
                // 分配策略：读 `status.distribution`（顶层键），写入走 wbSettings
                distribution: status?.distribution,
                distributionBusy: wbDistributionBusy,
                distributionError: wbDistributionError,
                distributionWritable: wbDistributionWritable,
                onDistribution: onWbDistribution,
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
                // 分配策略：读 `pool.distribution`（按区域），写入走 traeSettings
                distribution: traeStatus?.pool?.distribution,
                distributionBusy: traeDistributionBusy,
                distributionError: traeDistributionError,
                distributionWritable: traeDistributionWritable,
                onDistribution: onTraeDistribution,
              },
              qoder: qoderPanelProps,
            })
          : null,
        tab === 'qoder'
          ? jsxs('div', {
              // 与「XD Pool」「Trae 配置」两页同一个布局：单列、自上而下
              // 「页头 → 状态 → 统计 → 账号 → 模型」。先前这里是并排两列
              // （号池 | 模型），一页里出现两个同级标题，且同一件事在左列、
              // 右列的间距与位置与另两页都对不上。
              className: 'wbc-body',
              children: [
                jsx(QoderPoolPanel, { ...qoderPanelProps, flat: true }),
                jsx(QoderModelsPanel, { scopeSlot: qoderSettings, flat: true }),
              ],
            })
          : null,
        tab === 'wb-credits'
          ? jsx(CreditsTab, { status, summary, loading, traeStatus, qoderStatus })
          : null,
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
