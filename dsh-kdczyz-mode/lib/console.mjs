/**
 * console.mjs — WOTR 管理页（DSH 原生设置页，多标签页）。
 *
 * 这是一个**浏览器端**组件模块，由 client.js 引入后注册到 `settings.section`
 * 槽位。它不是独立 Web 页面：不开独立页面、不需要 web/ 目录，
 * 数据全部通过 fetch 向两个半边**已有的**路由取：
 *
 *   WorkBuddy 侧  /plugins/dsh-workbuddy-xdpool/*   （vendored 池路由）
 *   本插件侧      /plugins/dsh-kdczyz-mode/*       （lib/index.js 挂的只读接口）
 *   Trae 侧       /plugins/dsh-connect-trae/*       （lib/trae.js 挂的路由）
 *
 * 三个区域（都是**配置**页；原先还有一个只读的「账号」页，已删除）：
 *   1. workbuddy      —— WorkBuddy 池配置（模型勾选 / 完全手动取号 / 积分自动化）
 *   2. trae           —— 供应商开关、账号绑定、模型勾选与测试（本文件自写）
 *   3. qoder          —— Qoder 号池与模型勾选
 *
 * 三页的页头都是同一排：**「刷新账号」（重扫本机账号）+「添加账号」（浏览器登录）**，
 * 措辞、顺序与禁用规则逐字一致 —— 三个供应商的账号管理因此收在各自的配置页里，
 * 不再需要一个单独的「账号」查看页（那一页连同它的两列组件已删除）。
 *
 * workbuddy 标签页同样**本包自写**（PoolConfigTab）：不再嵌入 vendored 的
 * PoolCard，而是对齐 Trae 配置页这套模块样式直接实现区域切换 / 完全手动取号
 * （「切换到此账号」选中、未选/不可用即失败）/ 模型勾选 / 账号启停 / 移出池子 /
 * 签到 / 积分自动化（CN only）。读写走 vendored 已有的路由与设置字段
 * （`disabledAccountIds` / `selectedAccountIds` / `modelSelectionCn|Global` /
 * `automation` 等，读取/写入语义与上游 PoolCard 逐项一致）。它的 settings
 * 作用域由 client.js 解析后经 `embedded.wbSettings` 传入。
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
  /**
   * `react-dom` 的 `createPortal`（拿不到就是 null）。
   *
   * 输入框下面那张额度卡片要**贴到 body 上**才能不被裁掉：composer 那一行在
   * 嵌入形态下外面有 `overflow:hidden` 的容器，行内浮层会被切。内置的
   * ContextMeter 走的就是这条路（fixed + createPortal 到 body）。
   *
   * 由 client.js 从 `require('react-dom')` 取到后经 `embedded.createPortal`
   * 传进来 —— 本文件是纯 ES 模块（单测里只有一个迷你 react 桩），不在这里
   * import 任何宿主模块。拿不到就退回行内渲染（同样用 fixed 定位），
   * 功能不受影响，只是嵌入形态下可能被裁。
   */
  const createPortal = typeof embedded?.createPortal === 'function' ? embedded.createPortal : null;

  /** vendored 账号池的路由前缀（同 vendor/xdpool/lib/index.js 的常量，刻意不改名） */
  const POOL_API = '/plugins/dsh-workbuddy-xdpool';
  /** 本插件自己的路由前缀（由 lib/index.js 注册，提供历史记录） */
  const SELF_API = '/plugins/dsh-kdczyz-mode';
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
   * 为什么不能更快：`quota/usage` **每次都是一次真实的上游调用**，把它压到
   * 几秒会让请求量比号池任何既有行为高一个数量级，很可能把账号打成限流。
   *
   * 之所以要自动刷而不是手动：卡片上的余额是**手动切换账号时**用户判断
   * 「哪个还能用」的输入，过期余额会让人误切到已耗尽的账号 —— 这属于
   * 「规则应当同上游」，不该由用户记得点按钮。
   */
  const QODER_CREDITS_REFRESH_MS = 30000;
  /** 单次自动刷新的请求上限：账号再多也不并发，避免被当成异常流量。 */
  const QODER_CREDITS_MAX_ACCOUNTS = 50;

  const CSS_ID = 'dsh-kdczyz-mode/settings-page';
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
/* 卡片底部那一排主操作（WorkBuddy 账号卡：切换到此账号 + 签到领取）。
   与另两页单个 action 按钮占同一行：flex:1 1 auto 让这一排铺满卡片内宽，
   内容宽度不同时按内容分宽再等分剩余空间，不会挤成两个小方块。 */
.wbc-card-foot{display:flex;gap:8px;flex-wrap:wrap}
.wbc-card-foot>.wbc-btn{flex:1 1 auto;white-space:nowrap}
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
/* —— Trae 配置标签页（TraeConfigTab，与 WorkBuddy 页同一套模块样式）—— */
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
/* 启停开关的禁用态 */
.wbc-check:disabled{opacity:.5}
/* 探测结果徽章：unknown 是「没测出来」而不是失败，用中性色不用红色 */
.wbc-probe{border-radius:4px;font-size:10px;padding:2px 6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.wbc-probe-available{color:var(--dsw-alias-label-success,#30a46c)}
.wbc-probe-auth,.wbc-probe-rate_limited{color:var(--dsw-alias-label-error,#e5484d)}
/* 列内账号卡片改为单列：三列布局下列宽约 300–500px，
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
.wotr-credit-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.wotr-credit-pill[data-busy="1"]{opacity:.6;cursor:progress}
/* 展开态 = 内置按钮同款的 hover 底色（interactive-bg-hover 在 asar 里真有定义；
   早先那句 bg-l2 全库检索不到，一直在吃兜底值） */
.wotr-credit-pill[data-open="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.wotr-credit-pill[data-state="warn"]{color:var(--dsw-alias-label-warning,#d97706)}
.wotr-credit-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.wotr-credit-pill-num{font-variant-numeric:tabular-nums}
/* —— 点击胶囊展开的「这个平台的全部账号」卡片 ——
   胶囊本身是 composer 那一行里的 inline-flex，卡片**不能**用行内绝对定位：
   composer 外面在嵌入形态下有「overflow:hidden」的容器（conversation 包的
   _embeddedBody），行内浮层会被裁掉。所以卡片走「position:fixed + 端口到
   body」，与内置的 ContextMeter 同一条路（它也是 fixed + createPortal(body)），
   z-index 取同档 1100。坐标由组件量出来（见 placeCreditCard），不用 CSS 定位。 */
.wotr-credit-anchor{position:relative;display:inline-flex;align-items:center}
.wotr-credit-card{position:fixed;z-index:1100;box-sizing:border-box;width:min(340px,calc(100vw - 24px));max-height:min(60vh,480px);overflow:auto;padding:10px 12px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));box-shadow:var(--dsw-elevation-prominent,0 10px 30px rgba(0,0,0,.3));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wotr-credit-card-head{display:flex;align-items:center;gap:8px}
.wotr-credit-card-title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wotr-credit-mini{flex:none;appearance:none;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:11px;line-height:1;padding:4px 8px;cursor:pointer;white-space:nowrap}
.wotr-credit-mini:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.wotr-credit-mini:disabled{opacity:.5;cursor:default}
.wotr-credit-region{margin-top:10px}
.wotr-credit-region-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px}
.wotr-credit-region-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wotr-credit-region-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wotr-credit-row{margin-top:6px;padding:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:6px}
.wotr-credit-row[data-off="1"]{opacity:.55}
.wotr-credit-row[data-serving="1"]{border-color:var(--dsw-alias-label-primary)}
.wotr-credit-row-top{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.wotr-credit-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.wotr-credit-row-credits{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.wotr-credit-row-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wotr-credit-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.wotr-credit-foot{margin-top:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px}
.wotr-credit-note{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary)}
.wotr-credit-err{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-error,#e5484d)}
.wotr-credit-empty{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
`;

  function ensureCss() {
    if (typeof document === 'undefined') return;
    if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-kdczyz-mode';
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
  //   - `disabledAccountIds` / `selectedAccountIds` / `automation` 是**顶层**设置键；
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
   *   - 完全手动取号（「切换到此账号」选中；未选 / 不可用即失败，无分配策略）
   *   - 模型勾选（`modelSelectionCn|Global` 整段覆盖 + Max 模式 + 上下文预算）
   *   - 账号启停（`disabledAccountIds`）/ 移出池子 / 恢复
   *   - 每日签到（POST /checkin）
   *   - 积分自动化（**仅 CN**）：开关写整个 `automation` 对象，可立即运行并轮询结算
   *
   * 状态由父级 WotrPage 进页即拉（`status` / `loading` / `error`），
   * 本组件只负责渲染与写入，写完一律 `onRefresh()` 读回确认。
   */
  function PoolConfigTab({
    wbSettings,
    region,
    onRegion,
    status,
    loading,
    error,
    onRefresh,
    onRescan,
    onAddAccount,
    login,
  }) {
    const scopeObj = poolScopeOf(wbSettings);
    const writable = poolWritable(scopeObj);

    // —— 本地状态（hook 顺序固定，勿插队）——
    const [writeError, setWriteError] = useState(null);
    const [savedNote, setSavedNote] = useState(null);
    /** 正在进行的写入标记：'models' | 'automation' | 'checkin-<id>' | ... */
    const [busy, setBusy] = useState(null);
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
    const automation = status?.automation;
    const usable = accounts.filter((a) => a.disabled !== true).length;
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

    // —— 账号启停 ——
    const onToggleDisabled = (accountId, disabled) => {
      if (!writable) return;
      return run(accountId, () =>
        fetchJson(`${POOL_API}/accounts/disabled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, disabled }),
        }), disabled ? '已停用该账号' : '已重新启用该账号');
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

    // —— 签到 ——
    const onCheckin = (accountId) => {
      return run(`checkin-${accountId}`, () =>
        fetchJson(`${POOL_API}/checkin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId }),
        }), '签到完成');
    };

    /**
     * 切换「当前账号」——请求从此固定用这一张；`null` = 取消固定。
     *
     * 完全手动语义：取消固定后 `selectedAccountId` 为 null，请求**直接失败**
     * 并提示手动切换 —— 不会回到任何自动轮换（分配策略已删除）。
     *
     * 路由与「账号」页左列**同一条**（`POST /accounts/select?region=…`），区域参数
     * 不能省：国内版与国际版是两个独立 provider，各自固定自己的账号，服务端按
     * `?region=` 写进 `selectedAccountIds` 的对应键。
     */
    const onSelectAccount = (accountId) =>
      run(
        `select-${accountId ?? 'none'}`,
        () =>
          fetchJson(`${POOL_API}/accounts/select?region=${region}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId }),
          }),
        accountId === null ? '已取消固定，请求将失败直到手动切换账号' : '已切换到此账号',
      );

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
     * 完全手动语义下池子只有一个「当前账号」：`selectedAccountId`。
     * null = 没选，请求会失败并提示手动切换。
     */
    const selectedId =
      typeof status?.selectedAccountId === 'string' ? status.selectedAccountId : '';
    const currentId = selectedId;
    const currentAccount = accounts.find((a) => a.id === currentId) ?? null;
    const currentName =
      currentAccount === null
        ? '未选择'
        : shortAccountName(currentAccount.nickname || currentAccount.label || currentAccount.id) ||
          '未选择';
    const currentSub = selectedId !== '' ? '已固定，仅用这个账号' : '请求会失败，请手动切换';

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
              label: '刷新账号',
              title: '重新扫描本机已登录的 WorkBuddy 账号，并重读账号池状态。',
              disabled: loading,
              onClick: typeof onRescan === 'function' ? onRescan : onRefresh,
            },
            // 「添加账号」与另两个配置页同款（与 Qoder 页逐字一致）：
            // WorkBuddy 的登录是在浏览器里完成的，服务端开系统浏览器、
            // 前端只负责在没打开成功时补开并轮询回调。
            ...(typeof onAddAccount === 'function'
              ? [
                  {
                    label: '添加账号',
                    title: '用浏览器登录一个新的 WorkBuddy 账号并入池。',
                    disabled: login?.pending === true,
                    onClick: onAddAccount,
                  },
                ]
              : []),
          ],
        }),
        // 登录进行中：告诉用户去浏览器完成，别以为卡住了。
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
        login?.error !== undefined && login?.error !== null
          ? jsx('div', { className: 'wbc-err', children: `添加账号失败：${login.error}` })
          : null,
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
                { label: '可用', value: fmtNum(usable), sub: '未被停用' },
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
                '请先在 WorkBuddy 桌面版里登录，再点上面的「刷新账号」；或用「添加账号」在浏览器里登录一个新账号。',
              ],
            })
          : null,

        /* —— 账号 ——
         *
         * 完全手动语义：请求只用「当前使用」那一张卡（底部「切换到此账号」）。
         * 分配策略 / 冷却 / 保留额度均已删除。
         */
        status !== null && accounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个账号`,
              hint: '请求只用你「切换到此账号」选中的那一张；它被停用或移出池子时请求直接失败，不会自动换号。停用与移出池子是手动管理，保留。',
              actions: [],
              children: jsx('div', {
                className: 'wbc-cards',
                children: accounts.map((a) => {
                  const isCurrent = currentId !== '' && a.id === currentId;
                  const isPinned = selectedId !== '' && a.id === selectedId;
                  const creditTotal = accountCreditsOf(a);
                  return jsx(
                      AccountCard,
                      {
                        name: a.nickname || a.label || a.id,
                        dim: a.disabled === true || (currentId !== '' && isCurrent !== true),
                        tags: [
                          isCurrent
                            ? { text: '当前使用', cls: 'wbc-tag wbc-tag-on' }
                            : { text: '备用', cls: 'wbc-tag' },
                          a.disabled === true ? { text: '已停用', cls: 'wbc-tag' } : null,
                        ],
                        rows: [
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
                        ],
                        /**
                         * 卡片底部一排主操作：**切换账号 + 签到领取**。
                         *
                         * 与另两页同一条规矩：**当前使用的那张卡不给「切换到此账号」**
                         * —— 它已经是当前了。已固定（`isPinned`）的那张给「取消固定」：
                         * 完全手动语义下取消固定 = 没选，请求会失败直到手动切换。
                         *
                         * 签到领取在每张卡上都在（WorkBuddy 的签到路由是**按账号**的，
                         * 见 `POST /checkin {accountId}`）。
                         */
                        extra: [
                          jsx(
                            CardActions,
                            {
                              locked: !writable,
                              disabled: a.disabled === true,
                              saving: busy === a.id,
                              onToggleDisabled: (next) => onToggleDisabled(a.id, next),
                              onRemove: () => onIgnore(a.id, true),
                              removeBusy: busy === `ignore-${a.id}`,
                            },
                            'actions',
                          ),
                          jsxs(
                            'div',
                            {
                              className: 'wbc-card-foot',
                              children: [
                                isPinned
                                  ? jsx('button', {
                                      type: 'button',
                                      className: 'wbc-btn',
                                      disabled: !writable || busy === 'select-none',
                                      onClick: () => onSelectAccount(null),
                                      children: busy === 'select-none' ? '取消中…' : '取消固定',
                                    })
                                  : isCurrent
                                    ? null
                                    : jsx('button', {
                                        type: 'button',
                                        className: 'wbc-btn',
                                        disabled: !writable || busy === `select-${a.id}`,
                                        onClick: () => onSelectAccount(a.id),
                                        children:
                                          busy === `select-${a.id}` ? '切换中…' : '切换到此账号',
                                      }),
                                jsx('button', {
                                  type: 'button',
                                  className: 'wbc-btn',
                                  title: checkinNoteOf(a),
                                  disabled: busy === `checkin-${a.id}`,
                                  onClick: () => onCheckin(a.id),
                                  children: busy === `checkin-${a.id}` ? '签到中…' : '签到领取',
                                }),
                              ],
                            },
                            'foot',
                          ),
                        ],
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
   * 与 WorkBuddy / Qoder 两页同一套模块（列头 / 统计行 / 账号卡 / 空态都走共用组件），
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
  function TraeConfigTab({ scopeSlot, onAddAccount, login, onRescan, reloadToken, rescanError }) {
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
    }, [loadUsage, settingsRev, reloadToken]);

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
     * 号池管理（完全手动语义）。
     *
     * 分配策略 / 冷却 / 保留额度已删除，号池只剩 `disabledAccountIds`（停用）
     * 一个设置项，写在 `regions.<region>` 槽里（与 WorkBuddy 池的配置同形），
     * 每次写入只动目标区域的槽，另一区域的号池设置不受影响。选中账号经
     * `accounts.<region>`（上方的 onSwitchAccount）写入。
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
     * 签到：**每张卡签自己那个账号**，不切换 Trae 正在服务的账号。
     *
     * 上游的 `checkin_credits/claim` 没有 accountId 参数 —— 它结算的是「这份凭证
     * 属于谁」。所以「给备用账号签到」不是「把 id 传给上游」，而是**拿那个账号的
     * 凭证造一个一次性 client** 走同一条流程（路由的 `accountId`，与
     * `creditsOfAccount` 同一条不重绑 store 的路子）。先前这一页只有当前绑定那张
     * 卡有按钮，理由是「签到按区域结算当前账号」—— 那只说对了一半：凭证是每账号
     * 一份的，所以真的可以只签某个账号而不动绑定。
     *
     * 上游另有一道**设备**门禁（`did_checked_in` / `code: 9095`，同一台机器一天
     * 只签一次），所以答复里「这个账号签过了」与「本机签过了」要分开说。
     */
    const [checkining, setCheckining] = useState(null);
    const [checkinResults, setCheckinResults] = useState({});
    const onCheckin = async (accountId) => {
      if (typeof accountId !== 'string' || accountId === '') return;
      setCheckining(accountId);
      setWriteError(null);
      setSavedNote(null);
      try {
        const result = await fetchJson(`${TRAE_API}/checkin?region=${region}`, {
          method: 'POST',
          body: JSON.stringify({ accountId }),
        });
        setCheckinResults((prev) => ({ ...prev, [accountId]: result ?? {} }));
        setSavedNote(checkinResultNote(result));
        await loadUsage(region);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setCheckining(null);
      }
    };
    const checkin = usage?.checkin ?? null;
    const checkinEnabled = checkin?.enabled !== false;
    /**
     * 卡片说明（原生 title）：优先用这一页刚签过的答复，其次用 /usage 里**当前
     * 绑定账号**的那份状态。其他账号的今日状态只有签一下才知道 —— 为它多发一次
     * 上游读请求，代价与签一次一样，不值当。
     */
    const checkinTitleOf = (id, isCurrent) => {
      const result = checkinResults[id];
      const doc = result?.checkin ?? (isCurrent === true ? checkin : null);
      // 没有状态可讲时：区域里根本没有签到活动就直说（备用那张也就不会假装能签），
      // 否则说明这颗按钮与「切换到此账号」的区别 —— 它不换 Trae 正在服务的账号。
      return checkinStateNote(
        doc,
        checkinEnabled
          ? '点一下给这个账号签到（不会切换 Trae 正在服务的账号）'
          : '这边没有签到活动',
      );
    };

    /**
     * 号池状态与余额合并成**一张**卡。
     *
     * /usage 一次给两张表：`accounts`（每个登录 + 各自的 credits）与
     * `pool.accounts`（号池状态：停用）。先前页面把
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
    const traeUsable =
      poolAccounts.length === 0
        ? accounts.length
        : poolAccounts.filter((a) => a.disabled !== true).length;
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
              // 「刷新账号」= 重新扫本机 Trae 凭据（POST accounts/refresh）后再读回。
              // 与 WorkBuddy / Qoder 两页同义：它们也都是「扫账号」而不只是刷读数
              // —— 三页同一排按钮做同一件事，措辞与位置都对齐。
              // 父级没给 `onRescan` 时退回只重读读数（本页独立渲染时的降级）。
              label: '刷新账号',
              title: '重新检测本机 Trae 账号，并重读余额与号池状态。',
              disabled: usageLoading,
              // 把自己的区域交给父级：重扫要落在**当前正在看的这一边**。
              onClick: typeof onRescan === 'function' ? () => onRescan(region) : () => loadUsage(),
            },
            // 「添加账号」与另两个配置页同款（与 Qoder 页逐字一致）。
            ...(typeof onAddAccount === 'function'
              ? [
                  {
                    label: '添加账号',
                    title: '用浏览器登录一个新的 Trae 账号并入池。',
                    disabled: login?.pending === true,
                    onClick: onAddAccount,
                  },
                ]
              : []),
          ],
        }),
        // 登录进行中：Trae 是官方授权页 + 自动回调，告诉用户去浏览器完成即可。
        login?.pending === true
          ? jsxs('div', {
              className: 'wbc-note',
              children: [
                jsx('div', { children: '已在浏览器打开官方授权页，登录后自动回到这里。' }),
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
        login?.error !== undefined && login?.error !== null
          ? jsx('div', { className: 'wbc-err', children: `添加账号失败：${login.error}` })
          : null,
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
        // 「刷新账号」这一步自己的失败（重扫凭据目录），与读数失败分开说。
        rescanError !== null && rescanError !== undefined
          ? jsx('div', { className: 'wbc-err', children: `刷新账号失败：${rescanError}` })
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
                { label: '可用', value: fmtNum(traeUsable), sub: '未被停用' },
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
                '请在 Trae 客户端里登录，或用本页页头的「添加账号」在浏览器里登录。',
              ],
            })
          : null,

        /* —— 账号 ——
         *
         * 完全手动语义：请求只用「当前使用」那一张（顶部的「切换到此账号」写入
         * `accounts.<region>`）。号池状态与余额合并到同一张卡，控件走共用的
         * CardActions（与 WorkBuddy、Qoder 两页逐字同款）。
         */
        signedIn && cardAccounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个登录 · ${checkinText}${checkinCreditText}`,
              hint: '请求只用你「切换到此账号」选中的那一张；它被停用或不在池里时请求直接失败，不会自动换号。停用是手动管理，保留。',
              actions: [],
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
                        pool?.disabled === true ? { text: '已停用', cls: 'wbc-tag' } : null,
                      ],
                      // 余额来自 /usage 的逐账号 credits，号池状态来自 pool 段，
                      // 两张表按 id 对齐后拼成同一张卡。
                      rows: [
                        account?.credits?.generalAvailable !== undefined
                          ? { k: '通用余额', v: fmtNum(account.credits.generalAvailable) }
                          : pool?.credits !== undefined
                            ? { k: '通用余额', v: fmtNum(pool.credits) }
                            : null,
                        account?.credits?.workAvailable !== undefined
                          ? { k: '工作余额', v: fmtNum(account.credits.workAvailable) }
                          : null,
                      ],
                      extra: [
                        jsx(
                          CardActions,
                          {
                            locked: !writable || pool === null || pool === undefined,
                            disabled: pool?.disabled === true,
                            saving: savingPool === id,
                            onToggleDisabled: (next) => onToggleDisabled(id, next),
                          },
                          'actions',
                        ),
                        /* 卡片最后一行：与 XD Pool 页同款的两按钮排 —— 左边「切换
                         * 到此账号」（**当前那张不给**：它已经是当前了），右边
                         * 「签到」。签到这个按钮是**每张卡都有**的：它签的是卡片
                         * 自己那个账号，Route 会拿该账号的凭证造一次性 client，
                         * 不重绑 store，所以按下去不会把 Trae 正在服务的账号换掉
                         * （这正是它与「先切换再签」的区别）。 */
                        jsxs(
                          'div',
                          {
                            className: 'wbc-card-foot',
                            children: [
                              account === null || account === undefined || isCurrent
                                ? null
                                : jsx('button', {
                                    type: 'button',
                                    className: 'wbc-btn',
                                    disabled: switching !== null || !writable,
                                    onClick: () => onSwitchAccount(id),
                                    children:
                                      switching === id ? '切换中…' : '切换到此账号',
                                  }),
                              account === null || account === undefined || !signedIn
                                ? null
                                : jsx('button', {
                                    type: 'button',
                                    className: 'wbc-btn',
                                    title: checkinTitleOf(id, isCurrent),
                                    // 没有签到活动 / 正在读 / 正在签 —— 三种都不该再点
                                    disabled:
                                      checkining !== null || usageLoading || !checkinEnabled,
                                    onClick: () => onCheckin(id),
                                    children: checkining === id ? '签到中…' : '签到',
                                  }),
                              account === null || account === undefined
                                ? jsx('div', {
                                    className: 'wbc-note',
                                    children: '这个账号只在号池快照里，没有可用于签到的登录。',
                                  })
                                : null,
                            ],
                          },
                          'foot',
                        ),
                      ],
                      // 底部两个按钮都在上面那一排里（与 XD Pool 页同款），
                      // `action` 空着 —— 一页里不要有两种「卡片主按钮」。
                      action: null,
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

  //#region 共用模块（账号页三列同一套样式）
  /**
   * 账号页三列共用的几种「模块」。
   *
   * 抽出来的目的就是让三列长得**完全一样**：同一套列头、同一套统计小卡、
   * 同一套账号卡、同一套空态。先前两列各写各的，于是 WorkBuddy 侧没有统计行、
   * 卡片字段与操作按钮的位置也和 Trae 侧对不齐，并排一眼就能看出是两套东西。
   *
   * 这些组件刻意做成「无状态、只吃 props」：状态仍归 WotrPage 里各自那一份，
   * 两列的独立性不受影响（它们是两个各自独立的账号池）。
   */

  /** 列头：标题 + 区域切换 + 右侧操作按钮。三列共用。 */
  /**
   * 列头：标题 + 区域切换 + 两侧可选插槽 + 右侧操作按钮。三列共用。
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

  /** 统计小卡一行（列内两两一行，见 CSS 的 .wbc-sums）。三列共用。 */
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

  /** 键值行：账号卡里的明细（额度 / 签到 / 令牌到期…）都用它。三列共用。 */
  function KV({ k, v }) {
    return jsxs('div', {
      className: 'wbc-kv',
      children: [
        jsx('span', { className: 'wbc-k', children: k }),
        jsx('span', { className: 'wbc-v', children: v }),
      ],
    });
  }

  /** 空态：虚线框 + 若干行说明。三列共用。 */
  function EmptyBox({ lines }) {
    return jsx('div', {
      className: 'wbc-empty',
      children: asArray(lines)
        .filter((x) => x !== null && x !== undefined)
        .map((line, i) => jsx('div', { children: line }, `empty-${i}`)),
    });
  }

  /**
   * 账号卡：三列同一套骨架。
   *
   *   head   名称 + 若干状态标签
   *   rows   KV 明细
   *   extra  卡片中部的自定义控件（号池账号的「保留积分 + 保存 + 停用」那行）
   *   action 卡片底部一个按钮（Trae / Qoder 是「切换到此账号」）
   *
   * WorkBuddy 的账号卡底部是**两个**按钮（切换到此账号 + 签到领取），走 `extra`
   * 里的 `.wbc-card-foot` 那一排 —— 位置与另两页的 `action` 相同（卡片最后一行），
   * 只是多一个逐账号的上游动作。单个按钮的页面继续用 `action`。
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
              // 可选的原生 tooltip：按钮上放不下的状态说明（例如「今日已签 · 连签 9 天」
              // —— 卡片高度有限，这类「解释」挂在悬停里，数字仍照常显示）。
              ...(typeof action.title === 'string' && action.title !== ''
                ? { title: action.title }
                : {}),
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
   * 完全手动语义（本 fork）：账号之间没有分配策略 / 轮换 / 冷却，卡上的操作
   * 只剩两件**手动管理**的事 ——
   *
   *   「停用 / 启用」：写 `disabledAccountIds`，停用的账号不会被取号；
   *   「移出池子」：只在传了 `onRemove` 时渲染（Trae 半边没有「移出」概念，
   *   不给它硬塞一个按不动的按钮）。
   *
   * 早先这里的「参与轮换」勾选与「保留额度」输入已随分配策略一并删除。
   */
  function CardActions({ locked, disabled, onToggleDisabled, saving, onRemove, removeBusy }) {
    return jsxs('div', {
      className: 'wbc-bar',
      children: [
        jsx('button', {
          type: 'button',
          className: 'wbc-btn',
          title: disabled === true ? '恢复这个账号参与取号' : '停用后取号不再选中它（请求失败时请手动切换）',
          disabled: locked === true || saving === true,
          onClick: () => onToggleDisabled(disabled !== true),
          children: disabled === true ? '启用' : '停用',
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
     * 为什么需要：本面板在「qoder」页是**整页内容**，必须与 WorkBuddy / Trae
     * 两个配置页同距（16px）—— 套一层 `wbc-col` 会让 Qoder 页的分区间距变成
     * 12px，三个页面对比着看就是「这一页挤一点」。
     * （面板原先还挂在「账号」页第三列，那时才需要非平铺的 `wbc-col` 形态；
     * 那一页已删除，`flat` 现在恒为真，保留这个开关是为了不改变组件的既有契约。）
     */
    flat,
    status,
    loading,
    error,
    writeError,
    busy,
    writable,
    login,
    creditsNote,
    creditsAtMs,
    onRefresh,
    onAddAccount,
    onToggle,
    onRemove,
    onSelect,
    /**
     * 每日签到（按账号）。
     *
     * `onCheckin(id)` 只签这一张卡上的账号；`checkining` 是正在签的 id；
     * `checkinResults` 是这一页已签过的答复（做卡片 title）；`checkinNote` 是
     * 顶部那一行结论。
     */
    onCheckin,
    checkining,
    checkinResults,
    checkinNote,
  }) {
    const accounts = asArray(status?.accounts);
    const usable = accounts.filter((a) => a.disabled !== true).length;
    /**
     * 「当前使用」的那一个 —— 请求就固定用它。
     *
     * 由池算好（`status.accounts[].selected`）。完全手动语义：**只有**用户显式
     * 选中且还在池里的账号才是「当前使用」，没选就是 null（界面显示「—」，
     * 请求会失败并提示先切换账号）。
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
     * **它的**余额：请求固定用选中的账号，池子合计回答不了
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
     * 签到按钮的说明（原生 title）。
     *
     * 优先用**这一页刚签过的答复**；没有答复就说清这颗按钮与「切换到此账号」的
     * 区别 —— 它不换 Qoder 正在使用的账号。**刻意不为每张卡预读一次活动状态**：
     * 那要给每个账号各打一次上游（与签一次的代价一样），而"今天签没签"点一下就
     * 知道了。
     */
    const checkinTitleOf = (id) =>
      qoderCheckinStateNote(
        checkinResults?.[id],
        '点一下给这个账号签到（不会切换 Qoder 正在使用的账号）',
      );

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
      if (serving !== null && servingId !== '') {
        parts.push(servingCredits === undefined ? '额度读取中…' : `额度 ${fmtNum(servingCredits)}`);
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
          ],
        }),

        !writable
          ? jsx('div', {
              className: 'wbc-note',
              'data-diagnostic': 'settings-scope',
              title:
                '宿主没有暴露 `dsh-connect-qoder` 的可写设置作用域，或它尚未就绪。「切换到此账号 / 停用」都会写不进去。',
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

        // 签到结论：人点的动作，**成功也要说**（它是这一刻唯一发生变化的事）。
        // 「已领 +100」与「今天已签过」的区分由 qoderCheckinResultNote 负责。
        checkinNote !== null && checkinNote !== undefined
          ? jsx('div', { className: 'wbc-note', children: checkinNote })
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
                '「添加账号」逐个用浏览器登录 —— 每个登录都会成为一个可手动切换的账号。',
              ],
            })
          : null,

        accounts.length > 0
          ? jsx(StatsRow, {
              items: [
                { label: '账号', value: fmtNum(accounts.length), sub: '个已入池' },
                { label: '可用', value: fmtNum(usable), sub: '未被停用' },
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
         * 与「本次调用」（这一轮真的扣了它的额度），不一致正是「先切了号、
         * 上一轮还没跑完」在界面上的样子，合并成一个就再也说不清。
         */
        accounts.length > 0
          ? jsx(Section, {
              title: '账号',
              sub: `${fmtNum(accounts.length)} 个账号 · 请求只用「当前使用」那张`,
              hint: '请求只用「当前使用」的账号（完全手动：它不可用时本次请求直接失败，不会自动换号）。想换账号请点那张卡上的「切换到此账号」；停用 / 移出池子保留为手动管理。',
              children: jsx('div', {
                className: 'wbc-cards',
                children: accounts.map((a) => {
                  const expired = a.expired === true;
                  const isSelected = a.selected === true;
                  const isServing = servingId !== '' && a.id === servingId;
                  const locked = busy === true || writable === false;
                  return jsx(
                    AccountCard,
                    {
                      name: a.label ?? a.id,
                      // 完全手动：只有「当前使用」那张是亮的，其余卡片压暗。
                      // 不可用（停用）也压暗 —— 具体原因由标签说明。
                      dim: a.disabled === true || isSelected !== true,
                      tags: [
                        isServing ? { text: '本次调用', cls: 'wbc-tag wbc-tag-on' } : null,
                        isSelected
                          ? { text: '当前使用', cls: isServing ? 'wbc-tag' : 'wbc-tag wbc-tag-on' }
                          : { text: '备用', cls: 'wbc-tag' },
                        a.disabled === true ? { text: '已停用', cls: 'wbc-tag' } : null,
                        expired ? { text: '令牌已过期', cls: 'wbc-tag wbc-tag-warn' } : null,
                      ],
                      rows: [
                        { k: '账号', v: a.userId || a.id },
                        { k: '令牌到期', v: a.expiresAtMs > 0 ? fmtTime(a.expiresAtMs) : '未知' },
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
                      ],
                      // 停用 / 移出池子：走共用的 CardActions，与另两个配置页逐字同款。
                      extra: [
                        jsx(
                          CardActions,
                          {
                            locked,
                            disabled: a.disabled === true,
                            onToggleDisabled: (next) => onToggle(a.id, next),
                            saving: busy === true,
                            onRemove: () => onRemove(a.id),
                            removeBusy: busy === true,
                          },
                          'actions',
                        ),
                        /* 卡片最后一行：与 XD Pool / Trae 两页同款的两按钮排 ——
                         * 左边「切换到此账号」（**当前那张不给**：它已经是当前了，
                         * 再摆一个等于让用户点一下没反应），右边「签到」。
                         *
                         * 签到**每张卡都有**：路由按 accountId 取那一份凭据单独
                         * 走活动链，不碰 selectedAccountId，所以按下去不会把 Qoder
                         * 正在使用的账号换掉 —— 这正是它与「先切换再签」的区别。
                         *
                         * 已停用的账号也能签：领的是活动 Credits，与请求额度是否
                         * 可用无关（上游也没有设备级门禁：一台机器可以给池里每个
                         * 账号各签一次）。所以这颗按钮只受 `locked`（池忙 / 只读）
                         * 与"正在签另一个"限制。 */
                        jsxs(
                          'div',
                          {
                            className: 'wbc-card-foot',
                            children: [
                              isSelected === true
                                ? null
                                : jsx('button', {
                                    type: 'button',
                                    className: 'wbc-btn',
                                    disabled: locked,
                                    onClick: () => onSelect(a.id),
                                    children: '切换到此账号',
                                  }),
                              jsx('button', {
                                type: 'button',
                                className: 'wbc-btn',
                                title: checkinTitleOf(a.id),
                                disabled: checkining !== null || locked,
                                onClick: () => onCheckin(a.id),
                                children: checkining === a.id ? '签到中…' : '签到',
                              }),
                            ],
                          },
                          'foot',
                        ),
                      ],
                      // 两个按钮都在上面那一排里（与另两页同款），`action` 空着
                      // —— 一页里不要有两种「卡片主按钮」。
                      action: null,
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
  // 账号，真实请求固定落在**选中**的账号上，所以
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
   * 「一个平台」= 哪些区域。
   *
   * 胶囊上那个数字（以及它的 title）永远只讲**当前 provider 的那一个区域**：
   * provider id 是五个、区域也是五个，两者一一对应。
   *
   * 但用户嘴里的「这个平台的账号」不是五个、是**三个** —— WorkBuddy 的国内版
   * 与国际版是两个独立的池（两套凭据、两份停用名单、两个 settings 槽），
   * 在设置页里也各占一个区域标签；用户看它们是「同一个平台的两种版本」。
   * 所以点开胶囊时，卡片列的是**这个平台的全部区域**，并在行上标出区域，
   * 而不是只列当前 provider 那一个池 —— 否则「WorkBuddy 的账号」在切到国际版
   * 模型时会突然少一半，看起来像账号丢了。
   *
   * ⚠️ 这里列的是**同一个平台的账号**，不是「所有平台的账号」：Trae 的账号不会
   * 出现在 WorkBuddy 的卡片里。跨平台汇总需要同时打三家的接口，成本与误操作
   * 风险都高得多，而且与「这次调用扣了谁」无关。
   */
  const CREDIT_FAMILIES = {
    wb: {
      label: 'WorkBuddy',
      regions: [
        { id: 'cn', label: '国内版' },
        { id: 'global', label: '国际版' },
      ],
    },
    trae: {
      label: 'Trae',
      regions: [
        { id: 'cn', label: '国内版' },
        { id: 'ai', label: '国际版' },
      ],
    },
    // Qoder 只有一个池，区域标签留空（卡片不画区域分组标题）
    qoder: { label: 'Qoder', regions: [{ id: '', label: '' }] },
  };

  /** 区域 → 该区域的 provider id（点「刷新」时要顺带刷胶囊那个数字） */
  function creditProviderOf(family, region) {
    for (const [provider, src] of Object.entries(CREDIT_SOURCES)) {
      if (src.kind === family && src.region === region) return provider;
    }
    return undefined;
  }

  /** 区域的中文标签（取不到时回落到区域 id） */
  function creditRegionLabel(family, region) {
    const found = asArray(CREDIT_FAMILIES[family]?.regions).find((r) => r.id === region);
    return found?.label ?? region;
  }

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
   * 只要时分秒的时钟串（卡片页脚「数据取自 …」用）。
   *
   * 不用 fmtTime：那个带年月日，在浮层里一行放不下，而卡片上的数据只可能是
   * 刚刚取的（最老也就几十秒），带上日期反而更难读。
   */
  function fmtClockTime(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
   * 账号卡上「签到领取」按钮的悬停说明：今天签没签、连签几天。
   *
   * 这条信息在「账号」页左列是**一行 KV**（签到 / 今日已签 · 连签 9 天），但配置页
   * 的账号卡只有余额行，再加一行只为一句状态不值当。
   * 挂在按钮的原生 tooltip 上，既看得见又不占高度。读不到时说明原因（`checkinError`），
   * 与「没签到」区分开 —— 这和余额那条是同一个原则。
   *
   * 返回 undefined 表示「没有可说的」，调用方据此**不写 title 属性**：空 title 会在
   * 悬停时弹一个空框，比没有还糟。
   */
  function checkinNoteOf(row) {
    const checkin = row?.checkin;
    if (checkin === undefined || checkin === null) {
      return typeof row?.checkinError === 'string' && row.checkinError !== ''
        ? `签到状态读不到：${row.checkinError}`
        : undefined;
    }
    const streak = fmtNum(checkin.streakDays ?? 0);
    return checkin.todayCheckedIn === true
      ? `今日已签 · 连签 ${streak} 天`
      : `未签 · 连签 ${streak} 天`;
  }

  /**
   * Trae 的签到状态 → 卡片上的那一句话（无状态可讲时给 `fallback`）。
   *
   * `didCheckedIn` 要单独说：账号没签、但**这台机器**今天已经在别的账号上用掉
   * 签到，是合法状态（上游按设备放行一次），此时说「可签到」只会让人白点一次。
   * 词与「账号」页中列（Trae）的列头副标题同一套。
   */
  function checkinStateNote(doc, fallback) {
    if (doc === undefined || doc === null) return fallback;
    if (doc.checkedIn === true) {
      return `今日已签到${
        doc.credits === undefined ? '' : ` · 已领 +${fmtNum(doc.credits)}`
      }`;
    }
    if (doc.enabled === false) return '这边没有签到活动';
    if (doc.didCheckedIn === true) return '本机今天已经签过了（一台机器一天只签一次）';
    return '可签到';
  }

  /**
   * 签到路由的答复 → 保存条上的一句话。
   *
   * 三件事必须分开说：`claimed`（这次真拿到了）、`alreadyCheckedIn`（**这个账号**
   * 今天已经领过）、`deviceCheckedIn` / `code: 9095`（**这台机器**今天已经用掉，
   * 可能是别的账号用掉的）。把后两者混成一句「已签到」，用户就会以为新账号拿到了
   * 钱，而它一分没拿 —— 这正是当初修过的那个 bug 的说法。
   *
   * `9095` 是 Trae 上游的「本机今天已经签过」业务码，写在这里而不是从
   * `trae.js` 引：控制台是独立打包的一份脚本，跨入口 import 会把宿主解析搅乱。
   */
  function checkinResultNote(result) {
    if (result === undefined || result === null) return '签到未完成';
    if (result.claimed === true) {
      const gained = result.checkin?.credits;
      return gained === undefined ? '签到完成' : `签到完成 · 已领 +${fmtNum(gained)}`;
    }
    if (result.alreadyCheckedIn === true) return '这个账号今天已经签过了';
    if (result.deviceCheckedIn === true || result.code === 9095) {
      return '本机今天已经签过了（一台机器一天只签一次）';
    }
    const message = typeof result.message === 'string' ? result.message.trim() : '';
    return message === '' ? '签到未完成' : `签到未完成：${message}`;
  }

  /**
   * Qoder 签到路由的答复 → 卡片按钮的原生 title。
   *
   * 与 Trae 那份（`checkinStateNote`）分开写，因为**答复形状不同**：Trae 把状态
   * 嵌在 `checkin` 里、还有「本机今天已签」（`code: 9095`）那一档；Qoder 的答复
   * 是平的（`claimed` / `alreadyCheckedIn` / `code` / `amount`），上游也没有设备
   * 级门禁 —— 一台机器可以给池里每个账号各签一次。
   *
   * 文案里带上真实节奏：服务端窗口**每天 10:00（UTC+8）刷新**、领到的 Credits
   * **30 天有效**（`placements[].content.zh.description` 逐字）。不写这两句，
   * 用户就会拿「昨天领的今天怎么不见了」来问。
   */
  function qoderCheckinStateNote(doc, fallback) {
    if (doc === undefined || doc === null) return fallback;
    const amount =
      typeof doc.amount === 'number' && Number.isFinite(doc.amount) ? doc.amount : undefined;
    const validDays =
      typeof doc.validDays === 'number' && Number.isFinite(doc.validDays) ? doc.validDays : undefined;
    const gain = amount === undefined ? '' : ` · +${fmtNum(amount)} Credits`;
    const valid = validDays === undefined ? '' : `（${fmtNum(validDays)} 天有效）`;
    if (doc.claimed === true) return `签到成功${gain}${valid}`;
    if (doc.alreadyCheckedIn === true) return `今日已签到${gain}${valid} · 每天 10:00（UTC+8）刷新`;
    const message = typeof doc.message === 'string' ? doc.message.trim() : '';
    return message === '' ? '签到未完成' : `签到未完成：${message}`;
  }

  /**
   * Qoder 签到路由的答复 → 面板顶部那一行提示。
   *
   * `claimed`（这一下真领到了）与 `alreadyCheckedIn`（今天早就领过）**必须分开
   * 说**：上游的领取是幂等的 —— 对已领活动再 POST 一次回 `replayed: true`、余额
   * 一分不变（实测 577 → 577）。混成一句「签到成功」，就会每天谎报一次 +100。
   */
  function qoderCheckinResultNote(result) {
    if (result === undefined || result === null) return '签到未完成';
    if (result.claimed === true) {
      const amount =
        typeof result.amount === 'number' && Number.isFinite(result.amount)
          ? result.amount
          : undefined;
      return amount === undefined ? '签到完成' : `签到完成 · 已领 +${fmtNum(amount)} Credits`;
    }
    if (result.alreadyCheckedIn === true) {
      return '这个账号今天已经签过了（每天 10:00（UTC+8）刷新）';
    }
    const message = typeof result.message === 'string' ? result.message.trim() : '';
    return message === '' ? '签到未完成' : `签到未完成：${message}`;
  }

  /**
   * 从一个账号行里取出「这个账号还剩多少」。
   *
   * 三种池的字段名不同，**而且同一个名字在三家不是一个意思**，所以顺序按平台定
   * （`family` 为 undefined 时按 WorkBuddy 那套老顺序，兼容既有调用点）：
   *   - WorkBuddy：`credits.total` 就是各家权益包剩余之和（上游 `fetchCredits`
   *     算好的），它的 credits 对象里根本没有 `available` 这个键；
   *   - Trae：`credits.total` 是**发放总量**，`available = total - consumed` 才是
   *     剩余；而对话请求真正扣的是**通用池** `generalAvailable` —— 与 Trae 配置页
   *     「通用余额」同一口径。早先按 `total` 显示，于是「剩余 3,050」的账号其实
   *     只剩 796（3050 是发放量），用户按这个数字去删账号是会被误导的；
   *   - Qoder：直接是数字，上面第一个分支就返回了。
   * **拿不到就返回 undefined**，不要回退成 0：把「读不到」显示成「没有余额」
   * 会让人去删一个本来健康的账号。
   */
  function accountCreditsOf(row, family) {
    const c = row?.credits;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    const keys =
      family === 'trae'
        ? ['generalAvailable', 'available', 'total']
        : ['total', 'available', 'generalAvailable'];
    for (const key of keys) {
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
  function summarizeServingCredits(accounts, hints = {}, family) {
    const rows = asArray(accounts).filter((a) => a !== null && typeof a === 'object');
    const account = pickServingAccount(rows, hints);
    let fullTotal;
    for (const row of rows) {
      const v = accountCreditsOf(row, family);
      if (typeof v === 'number') fullTotal = (fullTotal ?? 0) + v;
    }
    return {
      total: account === undefined ? undefined : accountCreditsOf(account, family),
      account:
        account === undefined
          ? undefined
          : {
              id: account.id,
              name: shortAccountName(account.nickname ?? account.label ?? account.name ?? ''),
              credits: accountCreditsOf(account, family),
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
      return summarizeServingCredits(
        data?.accounts,
        {
          accountId: undefined,
          lastServedId: data?.activeAccountId,
          selectedAccountId: data?.selectedAccountId,
        },
        'wb',
      );
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
    // 与卡片同一套「当前账号」判据（见 traeCreditRows），免得两处显示不一致。
    const summary = summarizeServingCredits(
      data?.accounts,
      {
        lastServedId: data?.pool?.lastServedId,
        selectedAccountId: firstIdOf(
          data?.pool?.selectedAccountId,
          data?.selectedAccountId,
          data?.accountId,
          asArray(data?.accounts).find((a) => a?.selected === true)?.id,
        ),
      },
      'trae',
    );
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

  //#region 卡片数据层：整个平台的账号行
  //
  // 胶囊上那颗数字只回答「这一轮扣了谁、还剩多少」。点开之后要回答的是另一个
  // 问题：「这个平台的账号各剩多少、谁被选中、我想换成谁」—— 所以要按
  // **平台**取数（WorkBuddy / Trae 各两个区域，Qoder 一个池），而不是按 provider。
  //
  // 成本：WorkBuddy 的 `/status` 与 Trae 的 `/usage` 都会对池里**每个账号**
  // 发起一次真实的上游计费查询，所以这份缓存比胶囊那份更保守：
  //   - 只在「打开卡片（且已过期）」「点刷新」「写完一处改动」时取；
  //   - **不挂任何定时器** —— 卡片开着也不会自己反复打上游；
  //   - 与胶囊共用 30 秒新鲜窗口与「在途即新鲜」判定（isCreditFresh）。

  /** 平台 → 账号行缓存（key 是平台，不是 provider） */
  const creditRowsCache = new Map();

  function readCreditRowsCache(family) {
    return creditRowsCache.get(family);
  }

  /** 取第一个非空字符串（各家的「当前账号」字段名与层级都不一样） */
  function firstIdOf(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value !== '') return value;
    }
    return '';
  }

  /**
   * 一行账号的统一形状。
   *
   * 三家的字段名差得很远（WorkBuddy 用 `nickname`、Trae 用 `accountName`、
   * Qoder 用 `label`），卡片只认这一份。
   *
   * `pinned` 与 `serving` 是**两个不同的问题**，绝不合成一个：
   *   - `pinned`  —— 用户显式固定的那一个（`selectedAccountIds` /
   *                  `accounts.<region>` / `selectedAccountId`）；
   *   - `serving` —— 这一轮**真的**扣了谁（`lastServedId` / `activeAccountId` /
   *                  `/qoder/pool` 的 `serving`）。
   * 完全手动语义下没有「自动让位」：`pinned`（我选的）就是 `serving`（实际用的），
   * 除非选中的账号不可用 —— 那种情况请求直接失败，不会换号。两个都显示出来，
   * 用户才知道自己选的是谁、上一轮真的扣了谁的额度。
   */
  function creditRowOf(family, region, raw) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    return {
      // key 带上区域：同一份凭据可能在国内/国际各登录一次，id 未必唯一
      key: `${family}:${region}:${id}`,
      family,
      region,
      regionLabel: creditRegionLabel(family, region),
      id,
      name: shortAccountName(name) || name || id,
      fullName: name || id,
      credits:
        typeof raw?.credits === 'number' && Number.isFinite(raw.credits) ? raw.credits : undefined,
      disabled: raw?.disabled === true,
      expired: raw?.expired === true,
      pinned: raw?.pinned === true,
      serving: raw?.serving === true,
      error: typeof raw?.error === 'string' ? raw.error : '',
    };
  }

  /** WorkBuddy 的 `/status`（一个区域一个池）→ 行 */
  function wbCreditRows(data, region) {
    const pinned = firstIdOf(data?.selectedAccountId);
    const serving = firstIdOf(data?.activeAccountId, data?.selectedAccountId);
    return asArray(data?.accounts)
      .filter((a) => a !== null && typeof a === 'object')
      .map((a) =>
        creditRowOf('wb', region, {
          id: a.id,
          name: a.nickname ?? a.label ?? '',
          credits: accountCreditsOf(a),
          disabled: a.disabled,
          pinned: pinned !== '' && a.id === pinned,
          serving: serving !== '' && a.id === serving,
          error: a.creditsError,
        }),
      );
  }

  /**
   * Trae 的 `/usage`（一个区域一个池）→ 行。
   *
   * 两份数组要**按 id 合并**：顶层 `accounts` 带的是刚逐账号读到的余额明细
   * （`creditsOfAccount`；国际版没有这套接口，读出来是 undefined），
   * `pool.accounts` 带的是池的运行态（停用 / 记账余额）。
   * 只读其中一份都会缺东西 —— 余额与停用状态恰好分在两边。
   */
  function traeCreditRows(data, region) {
    const poolRows = asArray(data?.pool?.accounts).filter((a) => a !== null && typeof a === 'object');
    const topRows = asArray(data?.accounts).filter((a) => a !== null && typeof a === 'object');
    const topById = new Map();
    for (const a of topRows) if (typeof a.id === 'string') topById.set(a.id, a);
    const poolById = new Map();
    for (const a of poolRows) if (typeof a.id === 'string') poolById.set(a.id, a);

    // 「当前账号」在 Trae 的 /usage 里有几个来源，按可信度回退：pool 段（有就用）、
    // 顶层 selectedAccountId（老形状）、顶层 accountId（当前绑定的那个 —— 真机上
    // 只有它和逐账号的 selected 标记存在），最后才是逐账号的 selected。
    const pinned = firstIdOf(
      data?.pool?.selectedAccountId,
      data?.account?.accountId,
      data?.selectedAccountId,
      data?.accountId,
      topRows.find((a) => a.selected === true)?.id,
    );
    const serving = firstIdOf(data?.pool?.lastServedId);

    const ids = [];
    for (const a of [...poolRows, ...topRows]) {
      if (typeof a.id === 'string' && a.id !== '' && !ids.includes(a.id)) ids.push(a.id);
    }
    return ids.map((id) => {
      const poolRow = poolById.get(id);
      const topRow = topById.get(id);
      // 顶层那份是刚读的，池里那份是记账值 —— 有新的就用新的，读不到才回退
      const fresh = accountCreditsOf(topRow, 'trae');
      return creditRowOf('trae', region, {
        id,
        name: topRow?.accountName ?? topRow?.label ?? poolRow?.label ?? '',
        credits: fresh === undefined ? accountCreditsOf(poolRow, 'trae') : fresh,
        disabled: poolRow?.disabled,
        pinned: id === pinned,
        serving: id === serving,
        error: '',
      });
    });
  }

  /** Qoder 的 `/qoder/pool`（只有一个池）→ 行 */
  function qoderCreditRows(data) {
    const serving = data?.serving;
    const servingId = firstIdOf(serving?.accountId);
    const pinned = firstIdOf(data?.selectedAccountId, data?.effectiveSelectedAccountId);
    return asArray(data?.accounts)
      .filter((a) => a !== null && typeof a === 'object')
      .map((a) => {
        const isServing = typeof a.id === 'string' && a.id !== '' && a.id === servingId;
        return creditRowOf('qoder', '', {
          id: a.id,
          name: a.label ?? '',
          // 被调用的那一个用 `serving.credits`：那是这一次真去读的结果；
          // `accounts[].credits` 是宿主缓存（3 分钟窗口），可能已经是旧值。
          credits: isServing
            ? (accountCreditsOf(serving, 'qoder') ?? accountCreditsOf(a, 'qoder'))
            : accountCreditsOf(a, 'qoder'),
          disabled: a.disabled,
          expired: a.expired,
          pinned: typeof a.id === 'string' && a.id !== '' && a.id === pinned,
          serving: isServing,
          error: isServing ? serving?.error : '',
        });
      });
  }

  /** 取一个区域的行（一个池一次状态读取；Qoder 忽略 region） */
  async function fetchRowsOfRegion(family, region) {
    if (family === 'wb') {
      return wbCreditRows(await fetchJson(`${POOL_API}/status?region=${region}`), region);
    }
    if (family === 'qoder') return qoderCreditRows(await fetchJson(`${SELF_API}/qoder/pool`));
    return traeCreditRows(await fetchJson(`${TRAE_API}/usage?region=${region}`), region);
  }

  /**
   * 取「这个平台的全部账号」。
   *
   * 两个区域并行取，各自失败互不连累：一边的登录过期不该让另一边的行凭空消失
   * （那看起来像账号丢了）。失败原因按区域收进 `regionErrors`，由卡片如实显示。
   */
  async function fetchRowsOfFamily(family) {
    const regions = asArray(CREDIT_FAMILIES[family]?.regions);
    const settled = await Promise.all(
      regions.map(async ({ id }) => {
        try {
          return { region: id, rows: await fetchRowsOfRegion(family, id) };
        } catch (e) {
          return { region: id, rows: [], error: e?.message ?? String(e) };
        }
      }),
    );
    const rows = [];
    const regionErrors = {};
    for (const entry of settled) {
      for (const row of asArray(entry.rows)) rows.push(row);
      if (typeof entry.error === 'string' && entry.error !== '') {
        regionErrors[entry.region] = entry.error;
      }
    }
    return { rows, regionErrors };
  }

  /**
   * 取（或复用）平台账号行。`force` 用于点「刷新」与写完之后的确认。
   *
   * 与 requestCredits 同一套规矩：在途复用、新鲜窗口内直接返回、失败保留上一次
   * 的行（并挂上错误），**绝不抛** —— 卡片是 composer 旁边的浮层，抛错会连累
   * 输入框那一行。
   */
  function requestCreditRows(family, force = false) {
    const existing = creditRowsCache.get(family);
    if (existing?.pending !== undefined) return existing;
    if (existing !== undefined && !force && isCreditFresh(existing)) return existing;
    const rec = {
      atMs: existing?.atMs ?? 0,
      pending: undefined,
      rows: existing?.rows ?? [],
      regionErrors: existing?.regionErrors ?? {},
      error: undefined,
    };
    rec.pending = fetchRowsOfFamily(family)
      .then((r) => {
        rec.rows = r.rows;
        rec.regionErrors = r.regionErrors;
        rec.error = undefined;
      })
      .catch((e) => {
        rec.error = e?.message ?? String(e);
      })
      .finally(() => {
        rec.pending = undefined;
        rec.atMs = Date.now();
      });
    creditRowsCache.set(family, rec);
    return rec;
  }

  /**
   * 就地改缓存里的行（写完之后的即时反馈）。
   *
   * 刻意**不**为了这一次改动再打一遍状态接口 —— 那个接口每个账号都会触发一次
   * 计费调用。写路径本身已经做过读回确认（见 selectAccountRemote），
   * 所以就地改动是有依据的；下一次打开卡片或点「刷新」
   * 会用真实快照把它对齐。
   */
  function patchCreditRows(family, match, patch) {
    const rec = creditRowsCache.get(family);
    if (rec === undefined) return;
    rec.rows = asArray(rec.rows).map((row) => {
      if (!match(row)) return row;
      const next = typeof patch === 'function' ? patch(row) : patch;
      return next === undefined || next === null ? row : { ...row, ...next };
    });
  }

  /** 该平台设置作用域（拿不到就是 null，调用方按只读处理） */
  function creditScopeOf(family) {
    return poolScopeOf(family === 'qoder' ? qoderSettings : traeSettings);
  }

  /**
   * 把某个账号设成「当前账号」。
   *
   * 与停用同一条原则：写各半**真正读**的那份存储。
   *   - WorkBuddy：`POST /accounts/select?region=`。`null` = 取消固定（未选，请求会失败）——
   *     这是它独有的能力（它的池把「没有当前账号」当正常状态）；
   *   - Trae：写 `accounts.<region>`（上游客户端 switchAccount 的同一字段）；
   *   - Qoder：写 `selectedAccountId`。
   *
   * Trae / Qoder 不允许清空：池里必须始终有一个当前账号，写空只会悄悄回到
   * 第一个账号，所以这里显式拒绝。
   */
  async function selectAccountRemote(family, region, accountId) {
    if (family === 'wb') {
      const wanted = typeof accountId === 'string' && accountId !== '' ? accountId : null;
      await fetchJson(`${POOL_API}/accounts/select?region=${region}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: wanted }),
      });
      return;
    }
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('这个池必须始终有一个当前账号，不能清空');
    }
    const scope = creditScopeOf(family);
    const who = family === 'qoder' ? 'qoder' : 'trae';
    if (scope === undefined || scope === null) {
      throw new Error(`${who}: 拿不到设置作用域，无法保存（配置页同一处也只读）`);
    }
    if (!poolWritable(scope)) throw new Error(`${who}: 设置当前不可写`);
    if (family === 'qoder') {
      await writeSettingsField(
        scope,
        'selectedAccountId',
        accountId,
        (doc) => doc?.selectedAccountId === accountId,
        'qoder',
      );
      return;
    }
    const accounts = unwrapVolatileDeep(scope.getSnapshot?.().value)?.accounts ?? {};
    const next = traeNextAccounts(accounts, region, accountId);
    await writeTraeField(
      scope,
      'accounts',
      next,
      (readBack) =>
        unwrapVolatileDeep(next)[region] === unwrapVolatileDeep(readBack)?.accounts?.[region],
    );
  }
  //#endregion

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
   * 量出浮层该摆在哪：贴着触发按钮的上沿、水平居中，四周留 12px 边距。
   *
   * 为什么自己量而不用 primitives 的 `useAnchoredPosition`：那个 hook 要从
   * client.js 里 require 进来、再穿过两层参数送进本文件；而本文件是纯 ES 模块，
   * 单测里只有一个迷你 react 桩，拿不到任何宿主模块。这里只需要
   * 「贴着按钮上沿」这一种摆法，二十行就够，还不欠测试债。
   *
   * 只读 DOM、不写 DOM：量不到（没有 window / 还没挂载）就返回 null，
   * 由调用方退回「先隐藏」的状态，下一拍再量。
   */
  function measureCreditCard(anchor, panel) {
    if (typeof window === 'undefined') return null;
    if (anchor === null || anchor === undefined || typeof anchor.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = anchor.getBoundingClientRect();
    if (rect === undefined || rect === null) return null;
    const margin = 12;
    const width = panel?.offsetWidth > 0 ? panel.offsetWidth : 320;
    const height = panel?.offsetHeight > 0 ? panel.offsetHeight : 0;
    const viewWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
    const viewHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, margin),
      Math.max(margin, viewWidth - width - margin),
    );
    // 默认往上弹：composer 就贴在窗口底部，往下没有地方；上方真放不下才翻到下面。
    const above = rect.top - height - 8;
    const top =
      above >= margin
        ? above
        : Math.min(rect.bottom + 8, Math.max(margin, viewHeight - height - margin));
    return { left, top };
  }

  /**
   * 输入框下方的额度胶囊（点一下展开这个平台的账号卡片）。
   *
   * props 由 slot 契约给出：`sessionId`（scope: session）+ 本包 inject 的
   * `resolveModelDirectory`。任何一环拿不到就返回 null —— 这是「只增不减」
   * 的边界：宁可不显示，也绝不能让 composer 这一行报错。
   *
   * 展开的卡片里是**当前这个平台的全部账号**（不是「所有平台的账号」）：
   * WorkBuddy 与 Trae 各自的国内版 + 国际版都列出来，Qoder 只有一个池。
   * 每行带一个控件 —— 「切换到此账号」，见 selectAccountRemote 的语义说明。
   *
   * 刷新策略分两档，因为两档的成本差一个量级：
   *   - 胶囊那颗数字：**每 30 秒自动刷一次**（见 CREDIT_REFRESH_MS 的成本说明），
   *     外加切换模型时立刻刷、点击时强制刷；
   *   - 卡片里的账号行：只在「打开卡片（缓存过期时）」「点刷新」「写完一处
   *     改动」时取，**没有任何定时器** —— 上游按账号计费，卡片开着不该反复烧。
   *
   * 四个必须守住的细节：
   *   1. 定时器只在 provider 属于本插件时才起，切走要清掉；
   *   2. 组件卸载后回调不能再 setState（React 会警告，且可能写到已卸载的树）；
   *   3. 页面隐藏（切到别的窗口/标签）时暂停 —— 没人看的时候不该继续烧上游调用；
   *   4. 浮层用 fixed + portal 贴到 body（composer 外面有 overflow:hidden 的
   *      容器，行内绝对定位会被裁掉），拿不到 portal 时退回行内。
   */
  function ComposerCreditsPill({ sessionId, resolveModelDirectory }) {
    const current = useCurrentModel(resolveModelDirectory, sessionId);
    const provider = current?.provider ?? '';
    const source = CREDIT_SOURCES[provider];
    const family = source?.kind;

    const [tick, setTick] = useState(0);
    /** 卡片开没开 */
    const [open, setOpen] = useState(false);
    /** 卡片坐标；null = 还没量到（首帧先隐藏，量到再显示） */
    const [pos, setPos] = useState(null);
    /** 正在写的那一行（key）；写的过程中把这一行的控件禁掉，防连点 */
    const [busyRow, setBusyRow] = useState('');
    const [writeError, setWriteError] = useState('');
    /** 上一次写操作的提示（「已停用 X」这类） */
    const [note, setNote] = useState('');
    const anchorRef = useRef(null);
    const panelRef = useRef(null);

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

    /**
     * 打开卡片时取这个平台的账号行。
     *
     * 只在「开」这一拍取一次，而且新鲜窗口内直接复用（见 requestCreditRows）。
     * 关掉卡片不取消在途请求 —— 让它跑完，下次打开就是现成的。
     */
    useEffect(() => {
      if (open !== true || family === undefined) return undefined;
      let alive = true;
      const pending = requestCreditRows(family, false).pending;
      pending?.then(() => {
        if (alive) setTick((n) => n + 1);
      });
      return () => {
        alive = false;
      };
      // tick 只用于强制重渲染，不进依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, family]);

    /**
     * 把卡片贴到按钮上沿。
     *
     * 依赖里带上 tick：卡片的高度会随数据到位而变（先「读取中…」再长出若干行），
     * 数据一到就重新量一次，否则浮层会朝着旧高度摆。
     */
    useEffect(() => {
      if (open !== true) {
        setPos(null);
        return undefined;
      }
      const place = () => setPos(measureCreditCard(anchorRef.current, panelRef.current));
      place();
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return undefined;
      }
      // capture: true —— 滚动可能发生在任意祖先容器上（composer 的滚动容器不是
      // window），冒泡阶段收不到，捕获阶段才能拦到。
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      // 面板内容长出来（数据到了）之后高度会变，再贴一次
      let observer = null;
      if (typeof ResizeObserver === 'function' && panelRef.current !== null) {
        try {
          observer = new ResizeObserver(place);
          observer.observe(panelRef.current);
        } catch {
          observer = null;
        }
      }
      return () => {
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
        try {
          observer?.disconnect?.();
        } catch {
          /* 断不掉也不影响 */
        }
      };
    }, [open, tick]);

    /**
     * 点外面 / 按 Esc 关掉。
     *
     * 用捕获阶段的 pointerdown 而不是 click：click 会被卡片内部的按钮吃掉，
     * 而且「按下就别等抬起」的手感更接近原生浮层。触发按钮自己不算外面 ——
     * 不然点它会先关再开，看起来像闪一下。
     */
    useEffect(() => {
      if (open !== true) return undefined;
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return undefined;
      }
      const hit = (node, target) => {
        if (node === null || node === undefined || target === null || target === undefined) {
          return false;
        }
        if (typeof Node !== 'undefined' && target instanceof Node && typeof node.contains === 'function') {
          return node.contains(target);
        }
        return false;
      };
      const onPointerDown = (event) => {
        if (hit(anchorRef.current, event?.target)) return;
        if (hit(panelRef.current, event?.target)) return;
        setOpen(false);
      };
      const onKeyDown = (event) => {
        if (event?.key === 'Escape') setOpen(false);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [open]);

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
          ` · 每 ${CREDIT_REFRESH_MS / 1000} 秒自动刷新（点击展开${source.label}的账号）`;

    //#region 卡片的数据与动作

    const rowsRec = family === undefined ? undefined : readCreditRowsCache(family);
    const rows = asArray(rowsRec?.rows);
    const familyLabel = family === undefined ? source.label : CREDIT_FAMILIES[family].label;
    const groups =
      family === undefined
        ? []
        : asArray(CREDIT_FAMILIES[family].regions).map(({ id, label }) => ({
            region: id,
            label,
            rows: rows.filter((row) => row.region === id),
            error: rowsRec?.regionErrors?.[id],
          }));

    /** 立即刷一次胶囊那颗数字（在途时复用，不叠请求） */
    const refreshHeadline = () => {
      const r = requestCredits(provider, source, true);
      r.pending?.then(() => setTick((n) => n + 1));
      setTick((n) => n + 1);
    };

    /**
     * 点开 / 收起。
     *
     * 点开时顺手把胶囊那颗数字刷一次：用户点它就是因为想看数，而且这一发在
     * 30 秒窗口内本来也要发（只是提前了），不额外增加上游调用。
     * 卡片自己的账号行则由上面那个 effect 决定要不要取。
     */
    const onTrigger = () => {
      if (open === true) {
        setOpen(false);
        setWriteError('');
        setNote('');
        return;
      }
      setOpen(true);
      setWriteError('');
      setNote('');
      refreshHeadline();
    };

    /** 「刷新」：卡片的行 + 胶囊的数字一起强刷（用户显式要求，绕过新鲜窗口） */
    const onRefreshAll = () => {
      setWriteError('');
      setNote('');
      const r = requestCreditRows(family, true);
      r.pending?.then(() => setTick((n) => n + 1));
      refreshHeadline();
    };

    /** 切换到此账号 / 取消固定 */
    const onSelectRow = async (row) => {
      // WorkBuddy 独有的「取消固定」：完全手动语义下它的池把「没有当前账号」
      // 当正常状态（取消固定 = 未选，请求会失败）。Trae / Qoder 选中即服务。
      const unpin = row.family === 'wb' && row.pinned === true;
      setBusyRow(row.key);
      setWriteError('');
      setNote('');
      try {
        await selectAccountRemote(row.family, row.region, unpin ? null : row.id);
        patchCreditRows(row.family, (r) => r.region === row.region, (r) => ({
          pinned: unpin !== true && r.key === row.key,
        }));
        // 「当前账号」换了，胶囊上那个数字的主语也就换了
        if (row.region === source.region) refreshHeadline();
        setNote(unpin ? '已取消固定，请求将失败直到手动切换账号' : `已把 ${row.name} 设为当前账号`);
      } catch (e) {
        setWriteError(e?.message ?? String(e));
      } finally {
        setBusyRow('');
        setTick((n) => n + 1);
      }
    };
    //#endregion

    //#region 卡片渲染

    /** 一行上的标签（当前使用 / 已固定 / 本次调用 / 已停用 / 凭据已过期） */
    const rowTags = (row) => {
      const tags = [];
      const push = (kind, text) => tags.push({ kind, text });
      // 「已固定」与「本次调用」是两件事，都要说：完全手动下一般同值，
      // 但选中账号不可用时上一轮可能根本没扣到它。
      if (row.pinned === true) push('on', row.family === 'wb' ? '已固定' : '当前使用');
      if (row.serving === true) push(row.pinned === true ? 'muted' : 'on', '本次调用');
      if (row.disabled === true) push('warn', '已停用');
      if (row.expired === true) push('warn', '凭据已过期');
      if (row.error !== '') push('warn', `额度读不到：${row.error}`);
      return tags.map((tag, i) =>
        jsx(
          'span',
          {
            className:
              'wbc-tag' +
              (tag.kind === 'on' ? ' wbc-tag-on' : tag.kind === 'warn' ? ' wbc-tag-warn' : ''),
            children: tag.text,
          },
          `t${i}`,
        ),
      );
    };

    /** 一行：名字 + 积分 + 标签 + 两个控件 */
    const rowNode = (row) => {
      const busy = busyRow === row.key;
      const unpin = row.family === 'wb' && row.pinned === true;
      const label = unpin ? '取消固定' : '切换到此账号';
      /**
       * 已经是「当前账号」的那一行还要不要给切换按钮？
       *
       *   - WorkBuddy：要，但文案换成「取消固定」—— 完全手动语义下它的池把
       *     「未固定」当正常状态（`selectedAccountId` 为 null = 未选，请求会失败），
       *     固定住之后必须留一条退出的路；
       *   - Trae / Qoder：不给。这两家的池选中即服务，没有自动让位，也没有
       *     「清空选择」这种状态（切换即换到另一张）。
       */
      const hideSelect = unpin === false && row.pinned === true;
      const selectTitle = unpin
        ? '取消固定后请求会失败，请手动切换'
        : row.disabled === true
          ? '这个账号已停用：选中它请求会失败，请先启用或换一个'
          : `让 ${row.fullName} 成为「当前账号」，请求只用它`;
      return jsxs(
        'div',
        {
          className: 'wotr-credit-row',
          'data-off': row.disabled === true ? '1' : '0',
          'data-serving': row.serving === true ? '1' : '0',
          children: [
            jsxs('div', {
              className: 'wotr-credit-row-top',
              children: [
                jsx('span', { className: 'wotr-credit-row-name', title: row.fullName, children: row.name }),
                jsx('span', {
                  className: 'wotr-credit-row-credits',
                  title: row.error !== '' ? row.error : `${row.fullName} 当前积分`,
                  children: `${fmtCreditOrDash(row.credits)} 积分`,
                }),
              ],
            }),
            jsxs('div', {
              className: 'wotr-credit-row-foot',
              children: [
                jsx('span', { className: 'wotr-credit-tags', children: rowTags(row) }),
                hideSelect
                  ? null
                  : jsx('button', {
                      type: 'button',
                      className: 'wotr-credit-mini',
                      disabled: busy,
                      title: selectTitle,
                      onClick: () => {
                        void onSelectRow(row);
                      },
                      children: label,
                    }),
              ],
            }),
          ],
        },
        row.key,
      );
    };

    const errorLines = [];
    if (typeof rowsRec?.error === 'string' && rowsRec.error !== '') errorLines.push(rowsRec.error);
    for (const group of groups) {
      if (typeof group.error === 'string' && group.error !== '') {
        errorLines.push(`${group.label || '这个区域'}读不到：${group.error}`);
      }
    }
    if (writeError !== '') errorLines.push(writeError);

    const atText = fmtClockTime(rowsRec?.atMs);

    const card =
      open !== true
        ? null
        : jsxs(
            'div',
            {
              ref: panelRef,
              className: 'wotr-credit-card',
              role: 'dialog',
              'aria-label': `${familyLabel}账号与积分`,
              // 还没量到就先隐藏：必须先渲染出来才量得到高度
              style:
                pos === null
                  ? { visibility: 'hidden', left: '0px', top: '0px' }
                  : { left: `${pos.left}px`, top: `${pos.top}px` },
              onClick: (event) => event?.stopPropagation?.(),
              children: [
                jsxs('div', {
                  className: 'wotr-credit-card-head',
                  children: [
                    jsx('span', {
                      className: 'wotr-credit-card-title',
                      children: `${familyLabel} · ${rows.length} 个账号`,
                    }),
                    jsx('button', {
                      type: 'button',
                      className: 'wotr-credit-mini',
                      disabled: rowsRec?.pending !== undefined,
                      title: '重新读一次这个平台的账号与积分（上游按账号计费）',
                      onClick: onRefreshAll,
                      children: rowsRec?.pending !== undefined ? '读取中…' : '刷新',
                    }),
                  ],
                }),
                ...groups.map((group) => {
                  const serving = group.rows.find((row) => row.serving === true);
                  return jsxs(
                    'div',
                    {
                      className: 'wotr-credit-region',
                      children: [
                        groups.length > 1
                          ? jsxs('div', {
                              className: 'wotr-credit-region-head',
                              children: [
                                jsx('span', {
                                  className: 'wotr-credit-region-title',
                                  children: group.label || '账号',
                                }),
                                jsx('span', {
                                  className: 'wotr-credit-region-sub',
                                  children:
                                    `${group.rows.length} 个` +
                                    (serving === undefined ? '' : ` · 本轮用 ${serving.name}`),
                                }),
                              ],
                            })
                          : null,
                        ...group.rows.map(rowNode),
                        group.rows.length === 0 && typeof group.error !== 'string'
                          ? jsx('div', { className: 'wotr-credit-empty', children: '这个区域没有账号' })
                          : null,
                      ],
                    },
                    `g:${group.region}`,
                  );
                }),
                rows.length === 0 && rowsRec?.pending === undefined && errorLines.length === 0
                  ? jsx('div', {
                      className: 'wotr-credit-empty',
                      children: `${familyLabel} 暂时没有可用账号`,
                    })
                  : null,
                errorLines.length > 0
                  ? jsx('div', { className: 'wotr-credit-err', children: errorLines.join('；') })
                  : null,
                note !== ''
                  ? jsx('div', { className: 'wotr-credit-note', children: note })
                  : null,
                jsx('div', {
                  className: 'wotr-credit-foot',
                  children:
                    (atText === '' ? '正在读取…' : `数据取自 ${atText}`) +
                    ' · 打开卡片时取一次，不轮询（上游按账号计费）',
                }),
              ],
            },
          );

    return jsx('span', {
      className: 'wotr-credit-anchor',
      children: [
        jsxs('button', {
          type: 'button',
          ref: anchorRef,
          className: 'wotr-credit-pill',
          'data-busy': stale ? '0' : rec?.pending !== undefined ? '1' : '0',
          'data-state': typeof total === 'number' && total <= 0 ? 'warn' : 'ok',
          'data-open': open === true ? '1' : '0',
          'aria-expanded': open === true ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          title,
          onClick: onTrigger,
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
        }),
        // 有 portal 就贴到 body（composer 外面有 overflow:hidden 的容器，行内会被裁）；
        // 拿不到就退回行内 —— 定位仍是 fixed，只是嵌入形态下可能被裁。
        createPortal !== null && card !== null && typeof document !== 'undefined'
          ? createPortal(card, document.body)
          : card,
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
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // —— Trae 半边的状态（与 WorkBuddy 完全独立）——
    // 区域（ai/cn）的 state 归 TraeConfigTab 自己所有 —— 它同时驱动读数、模型
    // 勾选与「向 DSH 提供该供应商」开关，放在父级只会多一份需要同步的副本。
    // 这里只剩登录会话（traeLogin）与「请面板重读」的信号。
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
     * Qoder 数据是否处于「可见」状态。
     *
     * 面板只挂在「qoder」这一个标签页下。懒加载与自动刷新都以它为判据 ——
     * 早先它还挂在「账号」页第三列，只写 `tab === 'qoder'` 会让从那一页进来时
     * 整列空白、余额永远停在「读取中…」；「账号」页已删除，现在只有一个出口。
     * 放在状态声明之后、所有 effect 之前：effect 依赖它，顺序反了就是
     * 「used before defined」。
     */
    const qoderVisible = tab === 'qoder';

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

    // 首次进页 + 切换区域时拉取
    useEffect(() => {
      loadStatus();
    }, [loadStatus]);

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

    /**
     * Trae 侧的「重读」信号。
     *
     * Trae 配置页（TraeConfigTab）**自己**拉 `/usage`（它只在这一页里渲染，
     * 没必要让父级再存一份 —— 早先父级那条 `traeStatus` 数据通路只服务于已删除的
     * 「账号」页中列）。但有两件事发生在父级、需要让那一页重读：
     *   1. 浏览器登录成功后（新账号的凭据刚落到磁盘）；
     *   2. 点「刷新账号」（POST accounts/refresh 重新扫凭据目录）。
     *
     * 用一个自增的 token 通知它，而不是把数据搬回父级：面板只多认这一个依赖，
     * 数据仍然只有一份、只有一处拉。
     */
    const [traeReloadToken, setTraeReloadToken] = useState(0);
    /** 「刷新账号」这一步自己的错误。与面板内部的 `usageError` 分开：那个是读数失败，这个是重扫失败。 */
    const [traeRescanError, setTraeRescanError] = useState(null);

    /**
     * 「刷新账号」：先让服务端重扫凭据目录，再请面板重读。
     *
     * 区域**由面板传进来**，不能用页面级的 `traeRegion` —— 区域切换的 state
     * 归 TraeConfigTab 自己所有（它同时驱动读数、模型勾选与「向 DSH 提供该
     * 供应商」开关）。父级那份 `traeRegion` 自从「账号」页删除后就再没人写过，
     * 照它重扫会在看国际版时去扫国内版。
     *
     * 两步缺一不可 —— 只重读 `/usage` 拿到的是同一份旧账号列表，
     * 而只扫不读则界面不会更新。
     */
    const onTraeRescan = useCallback(async (which) => {
      setTraeRescanError(null);
      try {
        await fetchJson(`${TRAE_API}/accounts/refresh?region=${which}`, { method: 'POST' });
      } catch (e) {
        setTraeRescanError(e?.message ?? String(e));
      }
      setTraeReloadToken((v) => v + 1);
    }, []);

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
            // 走与「刷新账号」同一个信号：面板自己拉 `/usage`，父级只负责戳一下
            // （它每次都重扫凭据目录，所以新账号会立刻出现在账号区）。
            setTraeReloadToken((v) => v + 1);
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
    }, []);

    // —— Qoder 号池：读取 / 登录 / 池操作 ——

    /** 读一次号池快照（账号 + 停用）。 */
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
     * 仍然用 HTTP 的操作（移出池子）是运行时状态而非配置：
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

    /** 池写操作（移出池子）统一包一层：转圈 + 重读。 */
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

    const onQoderRemove = useCallback(
      (accountId) => qoderAction(`${SELF_API}/qoder/pool/remove`, { accountId }),
      [qoderAction],
    );

    /**
     * 切换「当前账号」：请求从此只用它（Trae 侧「切换到此账号」同款）。
     *
     * 只写 `selectedAccountId` 一个键。完全手动语义：不选 = 请求失败并提示
     * 先切换，所以界面不给「取消固定」这个动作。想换别的就直接点那张卡的按钮。
     */
    const onQoderSelect = useCallback(
      (accountId) =>
        writeQoderPoolField('selectedAccountId', accountId, (doc) => doc?.selectedAccountId === accountId),
      [writeQoderPoolField],
    );

    /**
     * 每日签到：**签自己那张卡上的账号**，不切换 Qoder 正在使用的账号。
     *
     * 与 Trae 侧同一条约束，实现路子也一样：把 `accountId` 交给路由，路由按这个
     * id 取那份凭据、单独走一次活动链接与领取，**全程不碰 `selectedAccountId`**。
     * 所以「给备用账号签到」不等于「先切过去再签再切回来」——后者会在一段时间里
     * 把用户正在用的账号换掉（请求打到别的号上），而这本来只是领 100 Credits。
     *
     * 刻意**不复用** `qoderAction`：那条路会把整页置 `qoderBusy`，于是签到一次就
     * 把「停用 / 移出」全锁住；而且它按 `error` 判失败，而签到的失败
     * 是**业务性**的（今天没有下发活动 / 令牌过期 / 今天已签），应该在卡片上就地
     * 说清，不该把整页标红。
     *
     * 三个状态分开：
     *   `checkining` 正在签哪个 id（按钮文案 + 防重复点）
     *   `checkinResults` 每个账号**这一页**签过的答复（卡片 title 用）
     *   `checkinNote` 顶部那一行结论（`claimed` / `alreadyCheckedIn` 分开说）
     */
    const [qoderCheckining, setQoderCheckining] = useState(null);
    const [qoderCheckinResults, setQoderCheckinResults] = useState({});
    const [qoderCheckinNote, setQoderCheckinNote] = useState(null);
    const onQoderCheckin = useCallback(
      async (accountId) => {
        if (typeof accountId !== 'string' || accountId === '') return null;
        setQoderCheckining(accountId);
        setQoderCheckinNote(null);
        try {
          const r = await fetchJson(`${SELF_API}/qoder/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId }),
          });
          // 答复里 `ok:false` 是**结果**不是异常：照样记下来并在卡片上说明原因。
          setQoderCheckinResults((prev) => ({ ...prev, [accountId]: r ?? {} }));
          setQoderCheckinNote(qoderCheckinResultNote(r));
          // 签到成功的答复里带了刚读到的余额，但号池快照（卡片上的余额行 / 合计）
          // 还是上一拍的，重读一次让数字立刻对齐。
          await loadQoder();
          return r ?? null;
        } catch (e) {
          setQoderCheckinNote(`签到未完成：${e?.message ?? String(e)}`);
          return null;
        } finally {
          setQoderCheckining(null);
        }
      },
      [loadQoder],
    );

    /**
     * 刷新上游积分额度 —— **自动、静默**。
     *
     * 三条刻意的设计：
     *
     * 1. **不置 `qoderBusy`**。那个标志会禁用卡片上的所有按钮（停用 / 移出）。
     *    每 30 秒把整页按钮锁住一小会儿，用户会看到按钮
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
     * 自动刷新积分：进「qoder」页就开始，离开就停。
     *
     * 只在**这一页可见时**跑（依赖 `qoderVisible`），因为额度数据只在这里
     * 显示；切到别的 tab 还继续打上游调用是纯浪费。回到这页会立刻补一次，
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
     * 第一次切到「qoder」标签页时才拉号池。
     *
     * 与 Trae 侧同样的懒加载理由：`/qoder/pool` 每次都会重扫凭据目录，
     * 没必要在打开设置面板时就跑一遍。（面板原本还挂在「账号」页第三列，
     * 那一页已删除，现在只有这一个出口。）
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
     * 面板只在「qoder」标签页下渲染，但仍抽成一个对象集中收口：这些回调与数据
     * 来自 WotrPage 的多个 state，散在调用点上写容易漏 —— 加了新的回调只接到
     * 一处、表现为「面板上有按钮但点了没用」。
     */
    const qoderPanelProps = {
      status: qoderStatus,
      loading: qoderLoading,
      error: qoderError,
      writeError: qoderWriteError,
      writable: qoderWritable,
      busy: qoderBusy,
      login: qoderLogin,
      creditsNote: qoderCreditsNote,
      creditsAtMs: qoderCreditsAtMs,
      onRefresh: loadQoder,
      onAddAccount: onQoderAddAccount,
      onToggle: onQoderToggle,
      onRemove: onQoderRemove,
      onSelect: onQoderSelect,
      // 每日签到（按账号，不切号）：正在签的 id / 本页各账号的答复 / 顶部结论。
      onCheckin: onQoderCheckin,
      checkining: qoderCheckining,
      checkinResults: qoderCheckinResults,
      checkinNote: qoderCheckinNote,
    };

    const tabs = [
      { id: 'pool-config', label: 'workbuddy' },
      { id: 'trae-config', label: 'trae' },
      { id: 'qoder', label: 'qoder' },
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
                '配置并查看 WorkBuddy 账号池、Trae 接入与 Qoder 号池：模型勾选、账号与额度（完全手动切换账号，无轮询/冷却策略）。三页都带「刷新账号」与「添加账号」：WorkBuddy 与 Trae 可以直接在浏览器里登录添加；Qoder 桌面端每个安装只保存一份登录，扫不出多个账号，请在「qoder」页用「添加账号」逐个登录入池。',
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
              // 「添加账号」：与另两个配置页同款（登录入口原先只在「账号」页左列，
              // 那一页已删除，这里补上）。
              onAddAccount,
              login,
            })
          : null,
        tab === 'trae-config'
          ? jsx(TraeConfigTab, {
              scopeSlot: traeSettings,
              // Trae 侧同理：登录入口原先只在「账号」页中列。
              onAddAccount: onTraeAddAccount,
              login: traeLogin,
              // 重新扫本机凭据（不只是重读读数）——「刷新账号」的语义。
              onRescan: onTraeRescan,
              // 登录成功 / 重扫之后请面板重读一次，以及那一步自己的错误。
              reloadToken: traeReloadToken,
              rescanError: traeRescanError,
            })
          : null,
        tab === 'qoder'
          ? jsxs('div', {
              // 与「workbuddy」「trae」两页同一个布局：单列、自上而下
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
