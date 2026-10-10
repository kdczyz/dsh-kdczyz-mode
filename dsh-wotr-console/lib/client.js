/**
 * dsh-wotr-console —— 浏览器端（合并后的单一 client bundle）。
 *
 * 一个包只能有一个 `./client`：client-modules 是**按包名**建表的
 * （reconcilePackage(packageName) → 一个 graph row），所以两个宿主入口
 * 共用这一个 bundle。它只注册**一个**设置入口：`settings.section` 的
 * 「WOTR 管理」页。
 *
 * 合并后的形态：一个入口、多标签页。
 *
 *   A. XD Pool 标签页   ← 本包自写的 PoolConfigTab（对齐 Trae 配置页样式）
 *   B. Trae 配置标签页  ← 本包自写的 TraeConfigTab（上游浏览器半边已移除）
 *   C. WorkBuddy 账号 / 积分 / 使用记录 / Trae 账号（本文件 + console.mjs）
 *
 * Trae 的输入框积分读数（conversation.input.left）照旧注册，不受影响。
 *
 * vendored 的 xdpool 客户端仍被**内联执行**，但只用于两件事：
 *   1. 注册它那份 locale 文案（`settings.workbuddy-xdpool`）；
 *   2. 解析它原本绑定的 settings 作用域（configForms → settingsScope），
 *      供本包自写的 PoolConfigTab 读写同一份设置文档。
 * 它注册的 `settings.section`（原独立设置页）被替身 ctx 拦掉 ——
 * vendored 源码一行都不用改，便于日后逐字节对照升级。
 *
 * 关键事实（都踩过坑）：
 *   1. 本文件是 classic script，**不能有顶层 import/export** ——
 *      宿主用 <script> 加载它。console.mjs 的源码以工厂函数形式内联，
 *      见下方 __WBC_CONSOLE_FACTORY__。
 *   2. jsx-runtime 的签名是 jsx(type, props, key)：children 必须放 props.children。
 *   3. settings.section 的组件 props 里只有 { close }，需要的东西要通过
 *      注册项的 inject 传进去。
 *   4. XD Pool / Trae 两个配置页的 settings 作用域由本文件解析成**活句柄**
 *      后经 `embedded.wbSettings` / `embedded.traeSettings` 传给管理页。
 *   5. vendored 客户端内部注册的 id 仍是各半原本的插件 id（它们自己的
 *      settings 作用域解析依赖这个 id）；本 bundle 用合并后的包名
 *      dsh-wotr-console 注册。
 */

//#region BEGIN GENERATED: xdpool client source
// 本块由 scripts/gen-xdpool-client.mjs 生成，请勿手改。
// 内容：vendor/xdpool/lib/client.js（原样内联，MIT, (c) XDTrees — 上游 XDTrees/dsh-workbuddy-xdpool）
// 用途：在本 bundle 内执行一次，捕获它 factory 的产物并转发 apply，
//       这样账号池那张设置卡片就并入了本插件，无需改动上游代码。
const XDPOOL_CLIENT_SRC = "window.__ModuleLoader__.load({\n\tid: \"dsh-workbuddy-xdpool\",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });\n\t\tlet react = require(\"react\");\n\t\tlet react_jsx_runtime = require(\"react/jsx-runtime\");\n\t\t//#region src/status-paths.ts\n\t\t/**\n\t\t* Node-free constants and types shared by the Host and browser halves of the\n\t\t* WorkBuddy XD Pool settings card.\n\t\t*\n\t\t* Pool's runtime state already lives in `src/status.ts` (`buildStatus` /\n\t\t* `WorkBuddyStatus`); this module only carves the cross-domain (Host→browser)\n\t\t* JSON document into a shape that stays token-free and matches what the\n\t\t* browser card renders. Route paths are plugin-owned and mounted on the Host's\n\t\t* same-origin web server (see `src/web-status.ts`).\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/status-paths\n\t\t*/\n\t\t/** Plugin-owned read-only pool status endpoint (account rows + models + shim). */\n\t\tconst POOL_STATUS_PATH = \"/plugins/dsh-workbuddy-xdpool/status\";\n\t\t/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */\n\t\tconst POOL_RESCAN_PATH = \"/plugins/dsh-workbuddy-xdpool/accounts/rescan\";\n\t\t/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */\n\t\tconst POOL_RESET_COOLDOWN_PATH = \"/plugins/dsh-workbuddy-xdpool/cooldowns/reset\";\n\t\t/** Plugin-owned daily check-in action endpoint (claim today's reward). */\n\t\tconst POOL_CHECKIN_PATH = \"/plugins/dsh-workbuddy-xdpool/checkin\";\n\t\t/**\n\t\t* Throw one account out of the pool for good, or take it back.\n\t\t*\n\t\t* Separate from the disable route because the semantics differ: disabling is a\n\t\t* rotation preference the account survives, ignoring survives the account.\n\t\t*/\n\t\tconst POOL_ACCOUNT_IGNORE_PATH = \"/plugins/dsh-workbuddy-xdpool/accounts/ignored\";\n\t\t/** Run one automation job immediately, so the card can verify it on demand. */\n\t\tconst POOL_AUTOMATION_RUN_PATH = \"/plugins/dsh-workbuddy-xdpool/automation/run\";\n\t\t/** Set or clear one account's reserved-credit floor. */\n\t\tconst POOL_CREDIT_RESERVE_PATH = \"/plugins/dsh-workbuddy-xdpool/accounts/credit-reserve\";\n\t\t/**\n\t\t* The schedule every automation job falls back to.\n\t\t*\n\t\t* Shared by both halves on purpose. The host uses it when a configured hour\n\t\t* list arrives empty (the settings schema materializes \"never configured\" into\n\t\t* `[]`), and the card uses it when it writes the `automation` block back, so a\n\t\t* document that already holds an empty list is healed instead of being saved\n\t\t* back as an unrunnable schedule.\n\t\t*\n\t\t* This lives here rather than in `scheduler.ts` because the browser half cannot\n\t\t* import the host module: `scheduler.ts` pulls in `node:crypto` and the whole\n\t\t* upstream client, none of which exists in the browser bundle. Two hand-written\n\t\t* copies would drift, and the drift is invisible — the card would write a\n\t\t* schedule the scheduler does not run.\n\t\t*/\n\t\tconst DEFAULT_AUTOMATION_HOURS = {\n\t\t\tcheckin: [9],\n\t\t\treport: [10],\n\t\t\ttasks: [11],\n\t\t\tstreak: [12],\n\t\t\ttravel: [9, 21]\n\t\t};\n\t\t//#endregion\n\t\t//#region src/client/icon.ts\n\t\t/**\n\t\t* Plugin card icon (data URI) for the WorkBuddy XD Pool card.\n\t\t*\n\t\t* A neutral, dependency-free 24px “pool / droplet stack” glyph kept as an SVG\n\t\t* data URI so the browser half never needs an external asset. Three stacked\n\t\t* droplet outlines + an encompassing orbit mark read as “rotating accounts\";\n\t\t* the line and fill colors stay inside the host’s accent family so the icon\n\t\t* sits naturally on the dark Plugin configuration surface.\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/client/icon\n\t\t*/\n\t\tconst POOL_PLUGIN_ICON = \"data:image/svg+xml;utf8,\" + encodeURIComponent([\n\t\t\t\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 24 24\\\" width=\\\"24\\\" height=\\\"24\\\">\",\n\t\t\t\"<g fill=\\\"none\\\" stroke=\\\"#5686fe\\\" stroke-width=\\\"1.6\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\">\",\n\t\t\t\"<path d=\\\"M7 5.5C7 3.6 8.4 2.5 8.4 2.5S9.8 3.6 9.8 5.5A1.4 1.4 0 0 1 7 5.5Z\\\" fill=\\\"#5686fe\\\" fill-opacity=\\\".28\\\"/>\",\n\t\t\t\"<path d=\\\"M15 10.5C15 8.6 16.4 7.5 16.4 7.5S17.8 8.6 17.8 10.5a1.4 1.4 0 0 1-2.8 0Z\\\" fill=\\\"#5686fe\\\" fill-opacity=\\\".28\\\"/>\",\n\t\t\t\"<ellipse cx=\\\"12\\\" cy=\\\"14.5\\\" rx=\\\"5.6\\\" ry=\\\"4.4\\\" stroke-dasharray=\\\"2 2\\\" stroke-opacity=\\\".55\\\"/>\",\n\t\t\t\"</g>\",\n\t\t\t\"</svg>\"\n\t\t].join(\"\"));\n\t\t//#endregion\n\t\t//#region src/client/styles.ts\n\t\t/**\n\t\t* Client styles for the WorkBuddy XD Pool card.\n\t\t*\n\t\t* The card uses the same dark-theme token vocabulary as the built-in plugin\n\t\t* cards (`--dsw-alias-*`), so the pooled account and model directory sit\n\t\t* naturally next to the other configuration rows instead of looking like a\n\t\t* bright Google-Material block on top of DSH's dark surface.\n\t\t*\n\t\t* The page renders at full height with no collapse affordance, and its content is\n\t\t* split into cards: a header row with the primary actions, a status card (region\n\t\t* switch + distribution), then one card per feature area. The inner\n\t\t* workbuddy-specific classes are namespaced `dsm-workbuddy-xdpool-*`.\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/client/styles\n\t\t*/\n\t\tconst POOL_CARD_CSS = `\n/*\n * Page shell. The settings shell renders this inside its own scrollable content\n * column, so the page supplies only the rhythm and the cards — no outer border\n * and no extra margin (the column pads its own edges).\n */\n.dsm-workbuddy-xdpool-page{max-width:860px;flex-direction:column;gap:16px;display:flex}\n/*\n * Header row: identity on the left, primary actions on the right. Wraps so a\n * narrow panel drops the buttons below the title instead of squeezing it.\n */\n.dsm-workbuddy-xdpool-page-head{align-items:center;gap:12px;flex-wrap:wrap;display:flex}\n.dsm-workbuddy-xdpool-page-icon{width:32px;height:32px;flex:none;border-radius:7px}\n.dsm-workbuddy-xdpool-page-copy{flex-direction:column;gap:4px;min-width:0;flex:1 1 220px;display:flex}\n.dsm-workbuddy-xdpool-page-title{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:16px;font-weight:600;line-height:1.4}\n.dsm-workbuddy-xdpool-page-desc{color:var(--dsw-alias-label-tertiary,#999);margin:0;font-size:13px;line-height:1.5}\n.dsm-workbuddy-xdpool-page-actions{align-items:center;gap:8px;flex-wrap:wrap;flex:none;display:flex}\n/*\n * One feature area per card. The surface separates the sections the way the\n * built-in settings pages do; without it every panel ran together into a single\n * column of text with no visible boundary.\n */\n.dsm-workbuddy-xdpool-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);border-radius:14px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}\n/* Status card: the region switch sits above the state line, then the switch. */\n.dsm-workbuddy-xdpool-status{gap:14px}\n/* Reusable button primitives shared with the rest of the card body. */\n.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}\n.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-btn:disabled{opacity:.4;cursor:default}\n.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}\n.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}\n.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}\n.dsm-btn-primary:hover:not(:disabled){opacity:.9}\n\n/* Region tabs: two independent suppliers, one shown at a time. */\n.dsm-workbuddy-xdpool-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}\n/* Empty-region guide: steps for signing in on the other gateway. */\n.dsm-workbuddy-xdpool-empty{gap:10px}\n.dsm-workbuddy-xdpool-empty-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}\n.dsm-workbuddy-xdpool-empty-steps{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}\n.dsm-workbuddy-xdpool-empty-steps-title{margin:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;font-weight:600;line-height:18px}\n.dsm-workbuddy-xdpool-empty-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}\n.dsm-workbuddy-xdpool-empty-list li{min-width:0}\n.dsm-workbuddy-xdpool-empty-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px}\n.dsm-workbuddy-xdpool-tab{appearance:none;font:inherit;cursor:pointer;flex:1;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .16s,background .16s,box-shadow .16s}\n.dsm-workbuddy-xdpool-tab:hover:not(.dsm-workbuddy-xdpool-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}\n.dsm-workbuddy-xdpool-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}\n.dsm-workbuddy-xdpool-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline;background:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-tab-dot[data-state=\"error\"]{background:var(--dsw-alias-state-error-primary,#ef4444)}\n.dsm-workbuddy-xdpool-tab-dot[data-state=\"idle\"]{background:var(--dsw-alias-label-dimmed,#9aa0a6)}\n.dsm-workbuddy-xdpool-usage-head{display:flex;flex-direction:column;gap:12px;min-width:0}\n.dsm-workbuddy-xdpool-usage-copy{display:flex;flex-direction:column;gap:3px;min-width:0}\n.dsm-workbuddy-xdpool-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}\n.dsm-workbuddy-xdpool-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}\n.dsm-workbuddy-xdpool-usage-hint{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}\n/* Distribution switch: priority (drain one) vs round-robin (spread). */\n.dsm-workbuddy-xdpool-dist{display:flex;flex-direction:column;gap:7px}\n.dsm-workbuddy-xdpool-dist-title{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;font-weight:600}\n.dsm-workbuddy-xdpool-dist-option{appearance:none;font:inherit;cursor:pointer;text-align:left;display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:44px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;padding:6px 10px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-dist-option:hover:not(:disabled):not(.dsm-workbuddy-xdpool-dist-option-active){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}\n.dsm-workbuddy-xdpool-dist-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-dist-option-active{background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.14));border-color:var(--dsw-alias-state-success-primary,#22a06b);color:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-dist-option:disabled{cursor:default;opacity:.6}\n.dsm-workbuddy-xdpool-dist-option-name{font-size:11px;line-height:16px;font-weight:600}\n.dsm-workbuddy-xdpool-dist-option-hint{font-size:10px;line-height:14px;opacity:.8}\n.dsm-workbuddy-xdpool-dist-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}\n.dsm-workbuddy-xdpool-usage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n\n/* Account list (each account = a labeled subpanel, same as dingminhua). */\n.dsm-workbuddy-xdpool-accounts{gap:14px}\n.dsm-workbuddy-xdpool-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:12px}\n/* \"In use now\": answers which account is serving without scanning every row. */\n/* A hairline + tint reads as status; a filled bar would read as a call to action. */\n.dsm-workbuddy-xdpool-current{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:10px 0 0;padding:9px 13px;border:1px solid color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 32%, transparent);border-radius:12px;background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 9%, transparent)}\n.dsm-workbuddy-xdpool-current-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#22a06b);box-shadow:0 0 0 3px color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 18%, transparent)}\n.dsm-workbuddy-xdpool-current-label{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11.5px;line-height:18px;font-weight:600;letter-spacing:.02em;flex:none}\n.dsm-workbuddy-xdpool-current-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:18px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-current-note{color:var(--dsw-alias-state-warning-primary,#d97706);font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-accounts-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}\n.dsm-workbuddy-xdpool-accounts-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}\n.dsm-workbuddy-xdpool-account{display:flex;flex-direction:column;gap:0;padding:0;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 55%, transparent);border-radius:16px;background:var(--dsw-alias-bg-layer-2,#24262c);box-shadow:0 1px 3px rgba(0,0,0,.04);overflow:hidden}\n/* Body row inside a card: identity on the left, credit panels on the right. */\n/* flex-wrap lets the panels drop below on a narrow card instead of squeezing both. */\n.dsm-workbuddy-xdpool-account-body{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}\n.dsm-workbuddy-xdpool-account-copy{display:flex;flex-direction:column;align-items:flex-start;gap:6px;flex:1 1 200px;min-width:0;padding:14px 16px;justify-content:center}\n.dsm-workbuddy-xdpool-account-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-account-head .dsm-workbuddy-xdpool-account-toggle{margin-left:auto}\n.dsm-workbuddy-xdpool-account-head{display:flex;align-items:center;gap:10px;min-width:0;padding:12px 16px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}\n/* Account switched off on the card: still listed (so it can be turned back on) but visually muted. */\n.dsm-workbuddy-xdpool-account-off{opacity:.55}\n/* Small pill switch: \"in rotation\" vs \"off\". Native checkbox styled by the label. */\n.dsm-workbuddy-xdpool-account-toggle{appearance:none;font:inherit;display:inline-flex;align-items:center;gap:5px;cursor:pointer;flex:none;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 70%, transparent);border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-account-toggle:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}\n.dsm-workbuddy-xdpool-account-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-account-toggle:disabled{cursor:default;opacity:.6}\n.dsm-workbuddy-xdpool-account-toggle-on{background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 14%, transparent);border-color:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 55%, transparent);color:var(--dsw-alias-state-success-primary,#22a06b);font-weight:600}\n.dsm-workbuddy-xdpool-account-toggle-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;opacity:.9}\n/* \"Remove\" button: destructive and reversible, so it is quiet until hovered. */\n.dsm-workbuddy-xdpool-account-ignore{appearance:none;font:inherit;flex:none;cursor:pointer;border:1px solid transparent;border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);transition:color .16s,border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-account-ignore:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 45%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-error-primary,#ef4444) 10%, transparent)}\n.dsm-workbuddy-xdpool-account-ignore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-account-ignore:disabled{cursor:default;opacity:.6}\n/* Ignored-account list: visible proof that \"remove\" can be undone. */\n.dsm-workbuddy-xdpool-ignored-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}\n.dsm-workbuddy-xdpool-ignored-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:19px}\n.dsm-workbuddy-xdpool-ignored-summary{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px}\n.dsm-workbuddy-xdpool-ignored-list{display:flex;flex-direction:column}\n.dsm-workbuddy-xdpool-ignored-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px}\n.dsm-workbuddy-xdpool-ignored-row+.dsm-workbuddy-xdpool-ignored-row{border-top:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 30%, transparent)}\n.dsm-workbuddy-xdpool-ignored-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-ignored-restore{appearance:none;font:inherit;flex:none;cursor:pointer;border:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 70%, transparent);border-radius:999px;padding:3px 10px;font-size:11px;line-height:17px;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);transition:color .16s,border-color .16s}\n.dsm-workbuddy-xdpool-ignored-restore:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}\n.dsm-workbuddy-xdpool-ignored-restore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-ignored-restore:disabled{cursor:default;opacity:.6}\n.dsm-workbuddy-xdpool-account-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n.dsm-workbuddy-xdpool-account-tag{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-success-subtle,rgba(34,160,107,.12));color:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-account-tag-cooling{background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.15));color:var(--dsw-alias-state-warning-primary,#d97706)}\n.dsm-workbuddy-xdpool-account-tag-error{background:var(--dsw-alias-state-error-subtle,rgba(239,68,68,.12));color:var(--dsw-alias-state-error-primary,#ef4444)}\n.dsm-workbuddy-xdpool-account-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px;display:flex;flex-wrap:wrap;gap:10px}\n.dsm-workbuddy-xdpool-account-modelcool{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}\n.dsm-workbuddy-xdpool-account-modelcool-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-state-warning-subtle,rgba(217,119,6,.12));color:var(--dsw-alias-state-warning-primary,#d97706)}\n.dsm-workbuddy-xdpool-account-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}\n\n/* Two-column stats: packages on the left, total + check-in on the right. */\n.dsm-workbuddy-xdpool-stats{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(168px,.85fr);gap:0;flex:1 1 420px;min-width:0;max-width:660px;border-left:1px solid color-mix(in oklab, var(--dsw-alias-border-l2,#3a3d45) 45%, transparent)}\n.dsm-workbuddy-xdpool-panel{display:flex;flex-direction:column;min-width:0;gap:7px;padding:14px 16px}\n.dsm-workbuddy-xdpool-panel-title{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;font-weight:600}\n.dsm-workbuddy-xdpool-panel-empty{color:var(--dsw-alias-label-tertiary,#999);font-size:14px;line-height:20px}\n.dsm-workbuddy-xdpool-panel-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;word-break:break-word}\n.dsm-workbuddy-xdpool-panel-foot{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}\n.dsm-workbuddy-xdpool-panel-foot strong{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-packages{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}\n/* One credit package: name + amount on the first line, its deadline beneath.\n   A two-row grid keeps the columns aligned across rows; a wrapping flex row\n   dropped the deadline onto a second line that started at the container edge,\n   so the list read as ragged text rather than a table. */\n.dsm-workbuddy-xdpool-packages li{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;row-gap:1px;align-items:baseline;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px}\n.dsm-workbuddy-xdpool-packages-name{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-packages-value{grid-column:2;justify-self:end;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-variant-numeric:tabular-nums}\n/* Per-package deadline: the upstream grants one-off packs at arbitrary clock\n   times, so each row carries its own timestamp; the soon ones are tinted and\n   fold onto their own line so a long package name cannot squeeze them out. */\n.dsm-workbuddy-xdpool-packages-when{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-packages-when-soon{color:var(--dsw-alias-state-warning-primary,#d97706)}\n.dsm-workbuddy-xdpool-panel-total{position:relative;align-items:center;text-align:center;justify-content:center;overflow:hidden;background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 5%, transparent)}\n.dsm-workbuddy-xdpool-panel-total::before{content:\"\";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9;background:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-total-value{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:28px;line-height:32px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;font-variant-numeric:tabular-nums}\n\n/* Model directory list. */\n.dsm-workbuddy-xdpool-models{gap:10px}\n.dsm-workbuddy-xdpool-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}\n.dsm-workbuddy-xdpool-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}\n.dsm-workbuddy-xdpool-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}\n.dsm-workbuddy-xdpool-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}\n.dsm-workbuddy-xdpool-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}\n.dsm-workbuddy-xdpool-model+.dsm-workbuddy-xdpool-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}\n.dsm-workbuddy-xdpool-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}\n.dsm-workbuddy-xdpool-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}\n.dsm-workbuddy-xdpool-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}\n.dsm-workbuddy-xdpool-model-id{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dsm-workbuddy-xdpool-model-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-model-meta-tag{padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}\n.dsm-workbuddy-xdpool-model-cap{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}\n/* Model row: checkbox + image toggle + context-budget radios. */\n.dsm-workbuddy-xdpool-model-off{opacity:.55}\n.dsm-workbuddy-xdpool-model-check{display:flex;align-items:center;gap:8px;min-width:0;flex:1;cursor:pointer}\n.dsm-workbuddy-xdpool-model-check input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}\n.dsm-workbuddy-xdpool-model-controls{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;justify-content:flex-end}\n.dsm-workbuddy-xdpool-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}\n.dsm-workbuddy-xdpool-model-budget{display:flex;align-items:center;gap:9px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-model-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}\n.dsm-workbuddy-xdpool-model-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}\n/* The region-wide Max 模式 switch, shown once above the model list. */\n.dsm-workbuddy-xdpool-maxmode{display:flex;align-items:center;gap:9px;flex:none;padding:7px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-secondary,rgba(174,179,187,.16));background:var(--dsw-alias-fill-quinary,rgba(174,179,187,.05))}\n.dsm-workbuddy-xdpool-maxmode input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}\n.dsm-workbuddy-xdpool-maxmode-text{display:flex;flex-direction:column;gap:1px;min-width:0}\n.dsm-workbuddy-xdpool-maxmode-label{color:var(--dsw-alias-label-primary,#e6e8eb);font-size:12px;line-height:16px}\n.dsm-workbuddy-xdpool-maxmode-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-models-heading{display:flex;flex-direction:column;gap:2px;min-width:0}\n.dsm-workbuddy-xdpool-models-actions{display:flex;align-items:center;gap:8px;flex:none}\n\n\n/* Automation: run-now button and the per-job progress line. */\n.dsm-workbuddy-xdpool-auto-run{flex:none}\n.dsm-workbuddy-xdpool-auto-job-detail{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}\n/* Credit packages panel heading inside the right-hand column. */\n.dsm-workbuddy-xdpool-panel-packages{display:flex;flex-direction:column;gap:7px;min-width:0}\n\n/* Check-in docked under the total, inside the right-hand panel. */\n.dsm-workbuddy-xdpool-checkin{display:flex;flex-direction:column;align-items:center;gap:7px;width:100%;margin-top:10px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}\n.dsm-workbuddy-xdpool-checkin-meta{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%}\n.dsm-workbuddy-xdpool-checkin-streak{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:17px;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-checkin-daily{color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-checkin-bonus{padding:1px 8px;border-radius:999px;font-size:11px;line-height:16px;background:var(--dsw-alias-state-success-subtle,rgba(51,160,107,.14));color:var(--dsw-alias-state-success-primary,#22a06b);text-align:center}\n.dsm-workbuddy-xdpool-checkin-btn{width:100%;padding:5px 10px;border-radius:8px;border:1px solid transparent;font-size:12px;font-weight:600;line-height:18px;cursor:pointer;background:var(--dsw-alias-state-success-primary,#22a06b);color:#fff;transition:opacity .16s,border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-checkin-btn:hover:not(:disabled){opacity:.88}\n.dsm-workbuddy-xdpool-checkin-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-checkin-btn:disabled{cursor:default;background:transparent;border-color:var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-tertiary,#9aa0a8);opacity:1}\n.dsm-workbuddy-xdpool-checkin-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:16px;text-align:center;word-break:break-word}\n\n/* Inline notes + error messages. */\n.dsm-workbuddy-xdpool-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:13px;line-height:20px}\n.dsm-workbuddy-xdpool-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px}\n\n/* Responsive: stack the stats columns on narrow screens. */\n@media (max-width:760px){\n  .dsm-workbuddy-xdpool-stats{grid-template-columns:1fr}\n  .dsm-workbuddy-xdpool-panel-total{align-items:stretch;text-align:left}\n  .dsm-workbuddy-xdpool-total-value{text-align:left}\n  .dsm-workbuddy-xdpool-checkin{align-items:stretch}\n  .dsm-workbuddy-xdpool-checkin-meta{align-items:flex-start}\n  .dsm-workbuddy-xdpool-checkin-bonus{text-align:left}\n}\n\n/* Automation panel: schedule and last-run summary, collapsed behind a switch. */\n.dsm-workbuddy-xdpool-auto{margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-module-platform,#202126)}\n.dsm-workbuddy-xdpool-auto-head{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.dsm-workbuddy-xdpool-auto-title{color:var(--dsw-alias-label-primary,#e8e8ea);font-size:12px;font-weight:600}\n.dsm-workbuddy-xdpool-auto-switch{padding:3px 12px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;cursor:pointer;transition:color .16s,border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-auto-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777);color:var(--dsw-alias-label-primary,#e8e8ea)}\n.dsm-workbuddy-xdpool-auto-switch:disabled{opacity:.5;cursor:not-allowed}\n.dsm-workbuddy-xdpool-auto-switch-on{border-color:#28c8b4;color:#28c8b4;background:rgba(40,200,180,.12)}\n.dsm-workbuddy-xdpool-auto-hint{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:1.6}\n.dsm-workbuddy-xdpool-auto-total{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(40,200,180,.08);font-size:11px}\n.dsm-workbuddy-xdpool-auto-total-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px}\n.dsm-workbuddy-xdpool-auto-total{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(40,200,180,.08);font-size:11px}\n.dsm-workbuddy-xdpool-auto-total-list{display:flex;flex-direction:column;gap:2px}\n.dsm-workbuddy-xdpool-auto-total-row{color:#28c8b4;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-earned{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);font-size:11px}\n.dsm-workbuddy-xdpool-earned-label{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px}\n.dsm-workbuddy-xdpool-earned-list{display:flex;flex-direction:column;gap:2px}\n.dsm-workbuddy-xdpool-earned-row{color:#28c8b4;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-earned-value{color:#28c8b4;font-weight:600;font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-auto-jobs{margin-top:8px;display:flex;flex-direction:column;gap:4px}\n.dsm-workbuddy-xdpool-auto-job{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}\n.dsm-workbuddy-xdpool-auto-job-name{flex:0 0 auto;min-width:72px;color:var(--dsw-alias-label-primary,#e8e8ea);font-weight:500}\n.dsm-workbuddy-xdpool-auto-job-when{flex:1 1 auto;color:var(--dsw-alias-label-secondary,#c6c9d0);font-variant-numeric:tabular-nums}\n.dsm-workbuddy-xdpool-auto-job-last{flex:0 0 auto;text-align:right;color:var(--dsw-alias-label-secondary,#c6c9d0);font-variant-numeric:tabular-nums;white-space:nowrap}\n.dsm-workbuddy-xdpool-auto-job-note{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#c6c9d0)}\n/* Reserved credits: one inline number field per account. */\n.dsm-workbuddy-xdpool-reserve{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,#36373b);font-size:11px;color:var(--dsw-alias-label-dimmed,#8a97b5)}\n.dsm-workbuddy-xdpool-reserve-label{flex:0 0 auto}\n.dsm-workbuddy-xdpool-reserve-input{width:84px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ea);font:inherit;font-variant-numeric:tabular-nums;transition:border-color .16s,background .16s}\n.dsm-workbuddy-xdpool-reserve-input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#22a06b);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 7%, transparent)}\n.dsm-workbuddy-xdpool-reserve-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}\n.dsm-workbuddy-xdpool-reserve-input:disabled{opacity:.6}\n.dsm-workbuddy-xdpool-reserve-unit{flex:0 0 auto}\n.dsm-workbuddy-xdpool-reserve-badge{flex:0 0 auto;padding:1px 7px;border-radius:999px;background:rgba(232,90,90,.14);color:#e85a5a;font-size:10px}\n/* Explicit Save: the field is a draft, so the button (not a blur) is what\n   commits it — and the outcome is reported right here, next to the control. */\n.dsm-workbuddy-xdpool-reserve-save{flex:0 0 auto;appearance:none;font:inherit;font-size:11px;font-weight:600;line-height:16px;padding:3px 12px;border-radius:6px;border:1px solid color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 55%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 14%, transparent);color:var(--dsw-alias-state-success-primary,#22a06b);cursor:pointer;transition:opacity .16s,background .16s,border-color .16s,color .16s}\n.dsm-workbuddy-xdpool-reserve-save:hover:not(:disabled){background:color-mix(in oklab, var(--dsw-alias-state-success-primary,#22a06b) 24%, transparent);border-color:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-reserve-save:disabled{cursor:default;border-color:var(--dsw-alias-border-l2,#3a3d45);background:transparent;color:var(--dsw-alias-label-tertiary,#8a90a0);opacity:.75}\n.dsm-workbuddy-xdpool-reserve-note{flex:0 0 auto;font-size:11px;line-height:16px}\n.dsm-workbuddy-xdpool-reserve-note-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}\n.dsm-workbuddy-xdpool-reserve-note-bad{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:600}\n`.trim();\n\t\t//#endregion\n\t\t//#region src/client/PoolCard.tsx\n\t\t/**\n\t\t* WorkBuddy XD Pool card contributed to DSH Plugin configuration.\n\t\t*\n\t\t* The card body mirrors the LaoDing plugin family used by dingminhua's\n\t\t* `dsh-connect-workbuddy`: a small status row (dot + count + Rescan / Clear\n\t\t* cooldowns buttons), then a per-account panel showing label / status tag /\n\t\t* token expiry / cooldown info / credit packages, then the model directory\n\t\t* with per-model free/limited/night/image badges and context size.\n\t\t*\n\t\t* Rendered as a full settings page (see `client/index.tsx`): the shell gives it\n\t\t* a left-nav row and a scrollable content column, so everything is visible at\n\t\t* once — a fold inside the page only hid the pool behind a click.\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/client/PoolCard\n\t\t*/\n\t\t/**\n\t\t* Default context window the card offers as the \"capped\" choice, in tokens.\n\t\t* Mirrors the host-side DEFAULT_CONTEXT_BUDGET; declared here rather than\n\t\t* imported, because the browser bundle must not pull in the host entry.\n\t\t*/\n\t\tconst DEFAULT_CONTEXT_BUDGET = 2e5;\n\t\tconst POLL_INTERVAL_MS = 3e4;\n\t\t/** Inject or refresh the shared card CSS for the current client bundle. */\n\t\tif (typeof document !== \"undefined\") {\n\t\t\tconst cssId = \"dsh-workbuddy-xdpool/client.css\";\n\t\t\tconst existing = document.querySelector(`style[data-plugin-css=\"${cssId}\"]`);\n\t\t\tif (existing !== null) existing.textContent = POOL_CARD_CSS;\n\t\t\telse {\n\t\t\t\tconst styleTag = document.createElement(\"style\");\n\t\t\t\tstyleTag.dataset.plugin = \"dsh-workbuddy-xdpool\";\n\t\t\t\tstyleTag.dataset.pluginCss = cssId;\n\t\t\t\tstyleTag.textContent = POOL_CARD_CSS;\n\t\t\t\tdocument.head.appendChild(styleTag);\n\t\t\t}\n\t\t}\n\t\tfunction formatNumber(value) {\n\t\t\tif (value === void 0) return \"–\";\n\t\t\treturn new Intl.NumberFormat(void 0, { maximumFractionDigits: 0 }).format(value);\n\t\t}\n\t\tfunction formatTime(value) {\n\t\t\treturn new Intl.DateTimeFormat(void 0, {\n\t\t\t\tmonth: \"2-digit\",\n\t\t\t\tday: \"2-digit\",\n\t\t\t\thour: \"2-digit\",\n\t\t\t\tminute: \"2-digit\"\n\t\t\t}).format(new Date(value));\n\t\t}\n\t\tfunction formatDateTime(value) {\n\t\t\tif (value === void 0) return \"\";\n\t\t\tconst ms = Date.parse(value);\n\t\t\tif (Number.isNaN(ms)) return value;\n\t\t\treturn new Intl.DateTimeFormat(void 0, {\n\t\t\t\tmonth: \"2-digit\",\n\t\t\t\tday: \"2-digit\",\n\t\t\t\thour: \"2-digit\",\n\t\t\t\tminute: \"2-digit\"\n\t\t\t}).format(new Date(ms));\n\t\t}\n\t\t/**\n\t\t* The automation jobs, in the order they run.\n\t\t*\n\t\t* The order is the contract: the report has to land before the task pass, or\n\t\t* the task pass reads progress the report would have lit. `hoursOf` reads the\n\t\t* matching hour list off the status document so the panel stays in step with\n\t\t* whatever schedule the scheduler is actually running on.\n\t\t*/\n\t\t/**\n\t\t* How long to watch a manual run before giving up on it.\n\t\t*\n\t\t* A pass runs one upstream call per account per job, so ~30s for a handful of\n\t\t* accounts. The bound exists so a wedged run cannot spin the button forever;\n\t\t* the run itself keeps going in the background either way.\n\t\t*/\n\t\tconst AUTOMATION_POLL_MS = 2e3;\n\t\tconst AUTOMATION_POLL_ATTEMPTS = 90;\n\t\tconst AUTOMATION_JOBS = [\n\t\t\t\"checkin\",\n\t\t\t\"report\",\n\t\t\t\"tasks\",\n\t\t\t\"streak\",\n\t\t\t\"travel\"\n\t\t];\n\t\t/**\n\t\t* The hour list to save for one job: what the card holds, or the default.\n\t\t*\n\t\t* Mirrors the host's own fallback (`hoursOrDefault` in `scheduler.ts`). An\n\t\t* empty list must resolve to the default on BOTH sides, or the card would save\n\t\t* a schedule the scheduler then refuses to run — the exact silent standstill\n\t\t* this pair of fixes exists to remove.\n\t\t*/\n\t\tfunction hoursOrDefault(configured, fallback) {\n\t\t\treturn configured !== void 0 && configured.length > 0 ? [...configured] : [...fallback];\n\t\t}\n\t\t/** Read one job's configured hours off the status document. */\n\t\tfunction automationHours(status, kind) {\n\t\t\tconst automation = status.automation;\n\t\t\tif (automation === void 0) return [];\n\t\t\tswitch (kind) {\n\t\t\t\tcase \"report\": return automation.reportHours;\n\t\t\t\tcase \"tasks\": return automation.taskHours;\n\t\t\t\tcase \"checkin\": return automation.checkinHours;\n\t\t\t\tcase \"streak\": return automation.streakHours;\n\t\t\t\tcase \"travel\": return automation.travelHours;\n\t\t\t}\n\t\t}\n\t\t/** Read one job's last-run record off the status document. */\n\t\tfunction automationJob(status, kind) {\n\t\t\treturn status.automation?.jobs[kind];\n\t\t}\n\t\tfunction dotColor(status) {\n\t\t\treturn status === \"ok\" ? \"var(--dsw-alias-state-success-primary, #22a06b)\" : status === \"error\" ? \"var(--dsw-alias-state-error-primary, #ef4444)\" : \"var(--dsw-alias-label-dimmed, #9aa0a6)\";\n\t\t}\n\t\tfunction formatCapacity(value) {\n\t\t\tif (value === void 0) return \"\";\n\t\t\tif (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6}M`;\n\t\t\tif (value >= 1e3 && value % 1e3 === 0) return `${value / 1e3}K`;\n\t\t\treturn String(value);\n\t\t}\n\t\t/** Build the draft from the server's selection + catalog flags. */\n\t\tfunction draftFromStatus(status) {\n\t\t\tconst selection = status.selection;\n\t\t\tconst enabled = selection.enabledModelIds;\n\t\t\tconst images = selection.imageModelIds;\n\t\t\tconst budgets = selection.contextBudgets;\n\t\t\tconst efforts = selection.reasoningEfforts;\n\t\t\tconst out = {};\n\t\t\tfor (const model of status.models) {\n\t\t\t\tconst entry = {\n\t\t\t\t\tenabled: enabled === void 0 || enabled.includes(model.id),\n\t\t\t\t\timages: images === void 0 ? model.supportsImages : images.includes(model.id)\n\t\t\t\t};\n\t\t\t\tconst budget = budgets?.[model.id];\n\t\t\t\tif (budget !== void 0) entry.budget = budget;\n\t\t\t\tconst effort = efforts?.[model.id];\n\t\t\t\tif (effort !== void 0) entry.effort = effort;\n\t\t\t\tout[model.id] = entry;\n\t\t\t}\n\t\t\treturn out;\n\t\t}\n\t\t/** True when the draft differs from what the server last reported. */\n\t\tfunction draftIsDirty(status, draft) {\n\t\t\tconst selection = status.selection;\n\t\t\tconst enabled = new Set(selection.enabledModelIds ?? status.models.filter((m) => m.enabled).map((m) => m.id));\n\t\t\tconst images = new Set(selection.imageModelIds ?? status.models.filter((m) => m.supportsImages).map((m) => m.id));\n\t\t\tconst budgets = selection.contextBudgets ?? {};\n\t\t\tconst efforts = selection.reasoningEfforts ?? {};\n\t\t\tfor (const model of status.models) {\n\t\t\t\tconst entry = draft[model.id];\n\t\t\t\tif (entry === void 0) continue;\n\t\t\t\tif (entry.enabled !== enabled.has(model.id)) return true;\n\t\t\t\tif (entry.images !== images.has(model.id)) return true;\n\t\t\t\tif ((budgets[model.id] ?? model.nativeContextWindow) !== (entry.budget ?? model.nativeContextWindow)) return true;\n\t\t\t\tif ((efforts[model.id] ?? \"\") !== (entry.effort ?? \"\")) return true;\n\t\t\t}\n\t\t\treturn false;\n\t\t}\n\t\t/** Absolute expiry with the time of day: the upstream grants one-off packages at\n\t\t*  arbitrary clock times, so \"expires 09/19 15:36\" is what the user needs — a\n\t\t*  date alone would read as if it lapsed at midnight. */\n\t\tfunction formatExpiry(ms) {\n\t\t\tif (ms === void 0 || !Number.isFinite(ms)) return \"\";\n\t\t\treturn new Intl.DateTimeFormat(void 0, {\n\t\t\t\tmonth: \"2-digit\",\n\t\t\t\tday: \"2-digit\",\n\t\t\t\thour: \"2-digit\",\n\t\t\t\tminute: \"2-digit\",\n\t\t\t\thour12: false\n\t\t\t}).format(new Date(ms));\n\t\t}\n\t\t/** Whole days until `ms`, floored at 0; undefined when there is no deadline. */\n\t\tfunction daysUntil(ms) {\n\t\t\tif (ms === void 0 || !Number.isFinite(ms)) return void 0;\n\t\t\treturn Math.max(0, Math.floor((ms - Date.now()) / 864e5));\n\t\t}\n\t\t/** True when a one-off package lapses inside the \"expiring soon\" window. */\n\t\tfunction isExpiringSoon(pack) {\n\t\t\tif (pack.monthly === true) return false;\n\t\t\tconst days = daysUntil(pack.expiresAtMs);\n\t\t\treturn days !== void 0 && days <= 3;\n\t\t}\n\t\t/**\n\t\t* The promo badge for one model, or undefined when it has none.\n\t\t*\n\t\t* `free` is read off the CREDIT MULTIPLIER, not off a tag. Neither gateway ever\n\t\t* sends a literal `free` tag: the global roster marks its zero-cost models\n\t\t* (`hy3`, `hy4-preview-f`, `deepseek-v4.1-flash`) as `credits: \"x0.00\"`, so\n\t\t* waiting for a tag meant the badge NEVER appeared — including on models that\n\t\t* genuinely cost nothing.\n\t\t*\n\t\t* An explicit free-ish tag still wins when present, so a gateway that starts\n\t\t* tagging them keeps working without another change.\n\t\t*/\n\t\tfunction tagFor(model) {\n\t\t\tconst tags = model.tags ?? [];\n\t\t\tif (tags.includes(\"free\") || model.multiplier === 0) return \"free\";\n\t\t\tif (tags.includes(\"limited-free\")) return \"limited\";\n\t\t\tif (tags.includes(\"night-discount\")) return \"night\";\n\t\t}\n\t\t/** Render pool health, per-account credits/cooldown, and the model directory. */\n\t\tfunction PoolCard({ t, settingsScope }) {\n\t\t\tconst settingsWritable = settingsScope?.getSnapshot().writable === true;\n\t\t\t/** Which region tab is showing. A CN-only install never leaves this. */\n\t\t\tconst [activeRegion, setActiveRegion] = (0, react.useState)(\"cn\");\n\t\t\t/**\n\t\t\t* Last-known status per region. Kept per region (not a single slot) so\n\t\t\t* switching tabs shows the other side's last answer immediately instead of\n\t\t\t* a blank frame, and the tab dots stay meaningful while a tab is hidden.\n\t\t\t*/\n\t\t\tconst [statusByRegion, setStatusByRegion] = (0, react.useState)({});\n\t\t\t/** The document for the tab on screen; undefined until its first answer. */\n\t\t\tconst status = statusByRegion[activeRegion];\n\t\t\t/**\n\t\t\t* Today's automation take, summed across accounts.\n\t\t\t*\n\t\t\t* Summed from the per-account counters rather than kept separately, so the\n\t\t\t* panel total and the per-account lines can never disagree.\n\t\t\t*/\n\t\t\tconst automationTotals = Object.values(status?.automation?.earningsToday ?? {}).reduce((sum, entry) => ({\n\t\t\t\tcredit: sum.credit + entry.credit,\n\t\t\t\tenergy: sum.energy + entry.energy,\n\t\t\t\tclaimed: sum.claimed + entry.claimed,\n\t\t\t\tcheckinCredit: sum.checkinCredit + entry.checkinCredit,\n\t\t\t\tbonusCredit: sum.bonusCredit + entry.bonusCredit,\n\t\t\t\ttravelCredit: sum.travelCredit + entry.travelCredit\n\t\t\t}), {\n\t\t\t\tcredit: 0,\n\t\t\t\tenergy: 0,\n\t\t\t\tclaimed: 0,\n\t\t\t\tcheckinCredit: 0,\n\t\t\t\tbonusCredit: 0,\n\t\t\t\ttravelCredit: 0\n\t\t\t});\n\t\t\tconst [error, setError] = (0, react.useState)(void 0);\n\t\t\tconst [busy, setBusy] = (0, react.useState)(false);\n\t\t\tconst [cooldownBusy, setCooldownBusy] = (0, react.useState)(false);\n\t\t\tconst [automationBusy, setAutomationBusy] = (0, react.useState)(false);\n\t\t\t/** The automation job currently running from the card, if any. */\n\t\t\tconst [automationRun, setAutomationRun] = (0, react.useState)(void 0);\n\t\t\t/** Account id whose reserved-credit floor is being saved, if any. */\n\t\t\tconst [reserveBusy, setReserveBusy] = (0, react.useState)(void 0);\n\t\t\tconst [flash, setFlash] = (0, react.useState)(void 0);\n\t\t\t/** Account id whose daily claim is currently in flight. */\n\t\t\tconst [checkinBusyId, setCheckinBusyId] = (0, react.useState)(void 0);\n\t\t\t/** Account id whose enable/disable switch is in flight, if any. */\n\t\t\tconst [accountBusyId, setAccountBusyId] = (0, react.useState)(void 0);\n\t\t\t/**\n\t\t\t* Draft model selection. `undefined` means \"no local edits\"; once a checkbox\n\t\t\t* is touched the draft takes over and is what the Save button posts. Discard\n\t\t\t* drops it back to the copy the server last reported.\n\t\t\t*/\n\t\t\tconst [draftByRegion, setDraftByRegion] = (0, react.useState)({});\n\t\t\t/**\n\t\t\t* The draft for the tab on screen. Keyed by region: the two gateways have\n\t\t\t* different rosters, so edits made on one tab must not leak into the other\n\t\t\t* when the user switches tabs (or saves).\n\t\t\t*/\n\t\t\tconst draft = draftByRegion[activeRegion];\n\t\t\tconst setDraft = (next) => {\n\t\t\t\tsetDraftByRegion((prev) => ({\n\t\t\t\t\t...prev,\n\t\t\t\t\t[activeRegion]: next\n\t\t\t\t}));\n\t\t\t};\n\t\t\tconst [savingModels, setSavingModels] = (0, react.useState)(false);\n\t\t\t/**\n\t\t\t* Draft for the region-wide Max 模式 switch, keyed by region for the same\n\t\t\t* reason the model draft is.\n\t\t\t*\n\t\t\t* `undefined` means \"not touched\" — the saved value applies. It is tracked\n\t\t\t* apart from the model draft because it is one switch for the whole region\n\t\t\t* rather than a per-model row, but it still only reaches disk on Save so\n\t\t\t* an accidental click is not written immediately.\n\t\t\t*/\n\t\t\tconst [maxModeByRegion, setMaxModeByRegion] = (0, react.useState)({});\n\t\t\tconst maxModeDraft = maxModeByRegion[activeRegion];\n\t\t\tconst savedMaxMode = status?.selection?.maxMode === true;\n\t\t\tconst maxMode = maxModeDraft ?? savedMaxMode;\n\t\t\tconst setMaxMode = (next) => {\n\t\t\t\tsetMaxModeByRegion((prev) => ({\n\t\t\t\t\t...prev,\n\t\t\t\t\t[activeRegion]: next\n\t\t\t\t}));\n\t\t\t};\n\t\t\tconst mounted = (0, react.useRef)(true);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tmounted.current = true;\n\t\t\t\treturn () => {\n\t\t\t\t\tmounted.current = false;\n\t\t\t\t};\n\t\t\t}, []);\n\t\t\t/**\n\t\t\t* Fetch one region's status. `region` is a parameter rather than a closure\n\t\t\t* read so the callback identity does not change with the tab: the polling\n\t\t\t* effect can key off it without restarting on every switch, and each region's\n\t\t\t* last answer stays in its own slot (see `statusByRegion`).\n\t\t\t*/\n\t\t\tconst refresh = (0, react.useCallback)(async (region, signal) => {\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(`${POOL_STATUS_PATH}?region=${region}`, {\n\t\t\t\t\t\theaders: { accept: \"application/json\" },\n\t\t\t\t\t\tcredentials: \"same-origin\",\n\t\t\t\t\t\t...signal === void 0 ? {} : { signal }\n\t\t\t\t\t});\n\t\t\t\t\tconst value = await response.json().catch(() => void 0);\n\t\t\t\t\tif (!response.ok) throw new Error(`HTTP ${response.status}`);\n\t\t\t\t\tif (mounted.current && signal?.aborted !== true) {\n\t\t\t\t\t\tsetStatusByRegion((prev) => ({\n\t\t\t\t\t\t\t...prev,\n\t\t\t\t\t\t\t[region]: value\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tsetError(void 0);\n\t\t\t\t\t}\n\t\t\t\t\treturn value;\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current && signal?.aborted !== true) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}, []);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst controller = new AbortController();\n\t\t\t\trefresh(activeRegion, controller.signal);\n\t\t\t\tconst timer = window.setInterval(() => {\n\t\t\t\t\trefresh(activeRegion, controller.signal);\n\t\t\t\t}, POLL_INTERVAL_MS);\n\t\t\t\treturn () => {\n\t\t\t\t\twindow.clearInterval(timer);\n\t\t\t\t\tcontroller.abort();\n\t\t\t\t};\n\t\t\t}, [refresh, activeRegion]);\n\t\t\tconst rescan = async () => {\n\t\t\t\tsetBusy(true);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_RESCAN_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: { accept: \"application/json\" },\n\t\t\t\t\t\tcredentials: \"same-origin\"\n\t\t\t\t\t});\n\t\t\t\t\tconst body = await response.json();\n\t\t\t\t\tif (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tif (mounted.current) setFlash(t?.(\"row.accountsRescanned\", { count: body.accounts ?? 0 }) ?? \"\");\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setBusy(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst resetCooldowns = async () => {\n\t\t\t\tsetCooldownBusy(true);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_RESET_COOLDOWN_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: { accept: \"application/json\" },\n\t\t\t\t\t\tcredentials: \"same-origin\"\n\t\t\t\t\t});\n\t\t\t\t\tif (!response.ok) throw new Error(`HTTP ${response.status}`);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tif (mounted.current) setFlash(t?.(\"row.resetCooldownsDone\") ?? \"\");\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setCooldownBusy(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t* Claim one account's daily check-in. The account id travels in the body so\n\t\t\t* the Host can never guess: a click on account B's button can only ever\n\t\t\t* collect account B's reward. The status is re-read afterwards so the card\n\t\t\t* reflects the new streak / total without waiting for the next poll.\n\t\t\t*/\n\t\t\tconst claimCheckin = async (accountId) => {\n\t\t\t\tsetCheckinBusyId(accountId);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_CHECKIN_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: {\n\t\t\t\t\t\t\taccept: \"application/json\",\n\t\t\t\t\t\t\t\"content-type\": \"application/json\"\n\t\t\t\t\t\t},\n\t\t\t\t\t\tcredentials: \"same-origin\",\n\t\t\t\t\t\tbody: JSON.stringify({ accountId })\n\t\t\t\t\t});\n\t\t\t\t\tconst body = await response.json().catch(() => void 0);\n\t\t\t\t\tif (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tconst credit = body?.claim?.credit ?? 0;\n\t\t\t\t\tif (mounted.current) setFlash(t?.(\"row.checkinClaimedReward\", { credit: formatNumber(credit) }) ?? `Claimed +${formatNumber(credit)} credits`);\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setCheckinBusyId(void 0);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t* Switch one account in or out of the pool.\n\t\t\t*\n\t\t\t* The id travels in the body and the host validates it against the accounts it\n\t\t\t* really knows, so a stale tab cannot write an orphan id. Disabling only stops\n\t\t\t* the account from being picked — it stays listed so it can be turned back on —\n\t\t\t* and the change is saved through the settings section, so it survives a\n\t\t\t* restart and is re-applied after every re-scan.\n\t\t\t*/\n\t\t\tconst toggleAccountDisabled = async (accountId, disabled) => {\n\t\t\t\tconst write = settingsScope?.set;\n\t\t\t\tif (write === void 0) {\n\t\t\t\t\tsetError(t?.(\"row.modelsSaveError\", { message: \"settings scope is read-only\" }) ?? \"settings scope is read-only\");\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tsetAccountBusyId(accountId);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst current = (status?.accounts ?? []).filter((account) => account.disabled === true).map((account) => account.id);\n\t\t\t\t\tconst next = disabled ? current.includes(accountId) ? current : [...current, accountId] : current.filter((id) => id !== accountId);\n\t\t\t\t\tawait write.call(settingsScope, \"disabledAccountIds\", next);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tconst message = cause instanceof Error ? cause.message : String(cause);\n\t\t\t\t\tif (mounted.current) setError(t?.(\"row.accountToggleError\", { message }) ?? \"Could not switch the account: \" + message);\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setAccountBusyId(void 0);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t* Throw one account out of the pool for good, or take it back.\n\t\t\t*\n\t\t\t* The host owns the ignore file, so this is a plain route call: no settings\n\t\t\t* scope is involved, which is also why it keeps working on a profile whose\n\t\t\t* settings section is read-only.\n\t\t\t*/\n\t\t\tconst setAccountIgnored = async (accountId, ignored) => {\n\t\t\t\tsetAccountBusyId(accountId);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_ACCOUNT_IGNORE_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: { \"Content-Type\": \"application/json\" },\n\t\t\t\t\t\tbody: JSON.stringify({\n\t\t\t\t\t\t\taccountId,\n\t\t\t\t\t\t\tignored\n\t\t\t\t\t\t})\n\t\t\t\t\t});\n\t\t\t\t\tif (!response.ok) {\n\t\t\t\t\t\tconst detail = await response.json().catch(() => ({}));\n\t\t\t\t\t\tthrow new Error(detail.error ?? `HTTP ${response.status}`);\n\t\t\t\t\t}\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tconst message = cause instanceof Error ? cause.message : String(cause);\n\t\t\t\t\tif (mounted.current) setError(t?.(\"row.accountIgnoreError\", { message }) ?? \"Could not change the ignore list: \" + message);\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setAccountBusyId(void 0);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/** Keep the draft in step with the server copy while nothing is dirty. */\n\t\t\tconst modelDraft = draft ?? (status === void 0 ? {} : draftFromStatus(status));\n\t\t\t/** Model edits need a writable settings scope; otherwise the rows are read-only. */\n\t\t\tconst modelsEditable = settingsWritable;\n\t\t\tconst modelsDirty = (draft !== void 0 && status !== void 0 && draftIsDirty(status, draft)) || maxMode !== savedMaxMode;\n\t\t\tconst enabledCount = Object.values(modelDraft).filter((entry) => entry.enabled).length;\n\t\t\tconst toggleModel = (id) => {\n\t\t\t\tif (status === void 0) return;\n\t\t\t\tconst base = draft ?? draftFromStatus(status);\n\t\t\t\tconst entry = base[id];\n\t\t\t\tif (entry === void 0) return;\n\t\t\t\tsetDraft({\n\t\t\t\t\t...base,\n\t\t\t\t\t[id]: {\n\t\t\t\t\t\t...entry,\n\t\t\t\t\t\tenabled: !entry.enabled\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t};\n\t\t\tconst toggleModelImage = (id) => {\n\t\t\t\tif (status === void 0) return;\n\t\t\t\tconst base = draft ?? draftFromStatus(status);\n\t\t\t\tconst entry = base[id];\n\t\t\t\tif (entry === void 0) return;\n\t\t\t\tsetDraft({\n\t\t\t\t\t...base,\n\t\t\t\t\t[id]: {\n\t\t\t\t\t\t...entry,\n\t\t\t\t\t\timages: !entry.images\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t};\nconst setModelBudget = (id, budget) => {\n\t\t\tif (status === void 0) return;\n\t\t\tconst base = draft ?? draftFromStatus(status);\n\t\t\tconst entry = base[id];\n\t\t\tif (entry === void 0) return;\n\t\t\tsetDraft({\n\t\t\t\t...base,\n\t\t\t\t[id]: {\n\t\t\t\t\t...entry,\n\t\t\t\t\tbudget\n\t\t\t\t}\n\t\t\t});\n\t\t};\n\t\t/*\n\t\t* 注意：`reasoningEfforts` 仍然会被 draftFromStatus 读、并在保存时原样写回，\n\t\t* 只是**不再由这张卡片编辑**。档位选择搬去了 DSH 自带的推理等级列表\n\t\t* （它按 thinkingLevelMap 给出每个模型精确的档位，比这里更准）。\n\t\t* 保留读写是为了不弄丢早期版本已经存进去的值 —— 整段 selection 是\n\t\t* 整体覆盖的，这里若不读回来，保存一次就会把旧值抹成空。\n\t\t*/\n\t\tconst discardModels = () => {\n\t\t\tsetDraft(void 0);\n\t\t\t// Drop the Max 模式 draft too: Discard means \"back to what the server\n\t\t\t// last reported\", and leaving the switch flipped would make the Save\n\t\t\t// button light up again on the next render.\n\t\t\tsetMaxModeByRegion((prev) => {\n\t\t\t\tif (prev[activeRegion] === void 0) return prev;\n\t\t\t\tconst next = { ...prev };\n\t\t\t\tdelete next[activeRegion];\n\t\t\t\treturn next;\n\t\t\t});\n\t\t\tsetFlash(void 0);\n\t\t};\n\t\t\t/**\n\t\t\t* Persist the draft. The route validates the payload again on the host side,\n\t\t\t* so a malformed draft is rejected there rather than silently stored. The\n\t\t\t* card refuses to save an empty enable-list: that would leave the picker\n\t\t\t* with nothing to offer and no obvious way back.\n\t\t\t*/\n\t\t\t/**\n\t\t\t* Persist the draft into the plugin settings section.\n\t\t\t*\n\t\t\t* The write goes through `settingsScope` rather than a bespoke route: that is\n\t\t\t* the same document the model picker reads, so one save covers every account\n\t\t\t* and survives account rotation — the selection is a property of the pool,\n\t\t\t* not of whichever account happens to be serving right now.\n\t\t\t*\n\t\t\t* The card refuses an empty enable-list: saving one would leave the picker\n\t\t\t* with nothing to offer and no obvious way back.\n\t\t\t*/\n\t\t\t/**\n\t\t\t* Switch how the pool spreads requests. Written straight through the\n\t\t\t* settings scope (that is where the host keeps the pool options), so the\n\t\t\t* change lands without a restart and survives the next card refresh.\n\t\t\t*/\n\t\t\tconst setDistribution = async (next) => {\n\t\t\t\tconst write = settingsScope?.set;\n\t\t\t\tif (write === void 0) {\n\t\t\t\t\tsetError(t?.(\"row.modelsSaveError\", { message: \"settings scope is read-only\" }) ?? \"settings scope is read-only\");\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tawait write.call(settingsScope, \"distribution\", next);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(String(cause));\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t* Switch the daily-points automation on or off.\n\t\t\t*\n\t\t\t* The whole `automation` object is written as one key, because that is how the\n\t\t\t* settings document stores it: the schedule fields must be carried along, or a\n\t\t\t* save would drop the hour lists the scheduler is running on.\n\t\t\t*/\n\t\t\tconst setAutomationEnabled = async (enabled) => {\n\t\t\t\tconst write = settingsScope?.set;\n\t\t\t\tif (write === void 0) {\n\t\t\t\t\tsetError(t?.(\"row.modelsSaveError\", { message: \"settings scope is read-only\" }) ?? \"settings scope is read-only\");\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tconst existing = status?.automation;\n\t\t\t\tsetAutomationBusy(true);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tawait write.call(settingsScope, \"automation\", {\n\t\t\t\t\t\tcheckinHours: hoursOrDefault(existing?.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin),\n\t\t\t\t\t\treportHours: hoursOrDefault(existing?.reportHours, DEFAULT_AUTOMATION_HOURS.report),\n\t\t\t\t\t\ttaskHours: hoursOrDefault(existing?.taskHours, DEFAULT_AUTOMATION_HOURS.tasks),\n\t\t\t\t\t\tstreakHours: hoursOrDefault(existing?.streakHours, DEFAULT_AUTOMATION_HOURS.streak),\n\t\t\t\t\t\ttravelHours: hoursOrDefault(existing?.travelHours, DEFAULT_AUTOMATION_HOURS.travel),\n\t\t\t\t\t\tenabled\n\t\t\t\t\t});\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setAutomationBusy(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t/**\n\t\t\t* Run the whole automation pass now.\n\t\t\t*\n\t\t\t* The route only STARTS the pass: a full run takes tens of seconds, which is\n\t\t\t* far too long to hold a request open. This watches the scheduler status until\n\t\t\t* the run settles, so the panel can show \"running\" honestly and report the\n\t\t\t* result when it lands.\n\t\t\t*/\n\t\t\tconst runAutomationJob = async () => {\n\t\t\t\tsetAutomationRun(\"all\");\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_AUTOMATION_RUN_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: {\n\t\t\t\t\t\t\t\"accept\": \"application/json\",\n\t\t\t\t\t\t\t\"content-type\": \"application/json\"\n\t\t\t\t\t\t},\n\t\t\t\t\t\tcredentials: \"same-origin\",\n\t\t\t\t\t\tbody: JSON.stringify({ job: \"all\" })\n\t\t\t\t\t});\n\t\t\t\t\tconst body = await response.json();\n\t\t\t\t\tif (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);\n\t\t\t\t\tif (body.started === false) {\n\t\t\t\t\t\tif (mounted.current) setFlash(t?.(\"row.autoAlreadyRunning\") ?? \"A run is already in progress\");\n\t\t\t\t\t}\n\t\t\t\t\tlet settled = false;\n\t\t\t\t\tfor (let attempt = 0; attempt < AUTOMATION_POLL_ATTEMPTS; attempt += 1) {\n\t\t\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, AUTOMATION_POLL_MS));\n\t\t\t\t\t\tif (!mounted.current) return;\n\t\t\t\t\t\tif ((await refresh(activeRegion))?.automation?.runInProgress === false) {\n\t\t\t\t\t\t\tsettled = true;\n\t\t\t\t\t\t\tbreak;\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tif (mounted.current) setFlash(settled ? t?.(\"row.autoRunDone\") ?? \"Automation pass finished\" : t?.(\"row.autoRunTimeout\") ?? \"Still running; check back in a moment\");\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setAutomationRun(void 0);\n\t\t\t\t}\n\t\t\t};\n\t\t\t/**\n\t\t\t* Save one account reserved-credit floor.\n\t\t\t*\n\t\t\t* A reserve only protects credits if the pool knows the balance, so this\n\t\t\t* also refreshes the account list afterwards: the reserve badge appears\n\t\t\t* as soon as the reading crosses the floor.\n\t\t\t*/\n\t\t\t/**\n\t\t\t* Save one account reserved-credit floor.\n\t\t\t*\n\t\t\t* A reserve only protects credits if the pool knows the balance, so this also\n\t\t\t* refreshes the account list afterwards: the reserve badge appears as soon as\n\t\t\t* the reading crosses the floor.\n\t\t\t*\n\t\t\t* Returns whether the host CONFIRMED the write. The card keys its inline\n\t\t\t* \"saved / not saved\" note off this, so a failure is shown where the user is\n\t\t\t* looking instead of only in the card-level notice line.\n\t\t\t*/\n\t\t\tconst saveCreditReserve = async (accountId, reserve) => {\n\t\t\t\tsetReserveBusy(accountId);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst response = await fetch(POOL_CREDIT_RESERVE_PATH, {\n\t\t\t\t\t\tmethod: \"POST\",\n\t\t\t\t\t\theaders: {\n\t\t\t\t\t\t\t\"accept\": \"application/json\",\n\t\t\t\t\t\t\t\"content-type\": \"application/json\"\n\t\t\t\t\t\t},\n\t\t\t\t\t\tcredentials: \"same-origin\",\n\t\t\t\t\t\tbody: JSON.stringify({\n\t\t\t\t\t\t\taccountId,\n\t\t\t\t\t\t\treserve\n\t\t\t\t\t\t})\n\t\t\t\t\t});\n\t\t\t\t\tconst body = await response.json();\n\t\t\t\t\tif (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tif (mounted.current) setFlash(reserve > 0 ? t?.(\"row.reserveSaved\", { credits: reserve }) ?? `Keeping ${reserve} credits` : t?.(\"row.reserveCleared\") ?? \"Reserve cleared\");\n\t\t\t\t\treturn true;\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));\n\t\t\t\t\treturn false;\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setReserveBusy(void 0);\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst saveModels = async () => {\n\t\t\t\t// 只要求 status 就绪，**不要求 draft 存在**。\n\t\t\t\t// draft 的语义是「本次动过模型行」，但 Max 模式是区域级开关，\n\t\t\t\t// 单独翻它不会创建 draft —— 原先的 `draft === void 0` 直接 return，\n\t\t\t\t// 于是「只开 Max 模式 → 点保存」静默什么也不发生：按钮是亮的\n\t\t\t\t// （modelsDirty 算上了 maxMode 的改动），点了却没反应，也不报错。\n\t\t\t\t//\n\t\t\t\t// 下面的 modelDraft 本来就会在 draft 缺失时回落到\n\t\t\t\t// draftFromStatus(status)，也就是服务端当前值，语义上正好是对的。\n\t\t\t\tif (status === void 0) return;\n\t\t\t\tif (enabledCount === 0) {\n\t\t\t\t\tsetError(t?.(\"row.modelsEmpty\") ?? \"No model enabled\");\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tconst write = settingsScope?.set;\n\t\t\t\tif (write === void 0) {\n\t\t\t\t\tsetError(t?.(\"row.modelsSaveError\", { message: \"settings scope is read-only\" }) ?? \"settings scope is read-only\");\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tsetSavingModels(true);\n\t\t\t\tsetFlash(void 0);\n\t\t\t\ttry {\n\t\t\t\t\tconst enabledModelIds = Object.entries(modelDraft).filter(([, e]) => e.enabled).map(([id]) => id);\n\t\t\t\t\tconst imageModelIds = Object.entries(modelDraft).filter(([, e]) => e.images).map(([id]) => id);\n\t\t\t\t\tconst contextBudgets = {};\n\t\t\t\t\tfor (const [id, entry] of Object.entries(modelDraft)) if (entry.budget !== void 0) contextBudgets[id] = entry.budget;\n\t\t\t\t\t// 原样带回早期版本存下的每模型默认档位。这张卡片不再编辑它\n\t\t\t\t\t// （档位选择搬去了 DSH 自带的推理等级列表），但**不能因为不编辑\n\t\t\t\t\t// 就丢掉**：整段 selection 是整体覆盖的，不写回来等于抹成空。\n\t\t\t\t\t// 顺手过滤掉模型已不存在 / 不再支持该档位的陈旧值。\n\t\t\t\t\tconst reasoningEfforts = {};\n\t\t\t\t\tfor (const [id, entry] of Object.entries(modelDraft)) {\n\t\t\t\t\t\tif (entry.effort === void 0) continue;\n\t\t\t\t\t\tconst info = status.models.find((m) => m.id === id);\n\t\t\t\t\t\tconst offered = info !== void 0 && Array.isArray(info.supportedEfforts) ? info.supportedEfforts : [];\n\t\t\t\t\t\tconst okLevel = entry.effort === \"off\" || offered.includes(entry.effort);\n\t\t\t\t\t\tif (okLevel) reasoningEfforts[id] = entry.effort;\n\t\t\t\t\t}\n\t\t\t\t\tconst key = activeRegion === \"cn\" ? \"modelSelectionCn\" : \"modelSelectionGlobal\";\n\t\t\t\t\tawait write.call(settingsScope, key, {\n\t\t\t\t\t\tenabledModelIds,\n\t\t\t\t\t\timageModelIds,\n\t\t\t\t\t\tcontextBudgets,\n\t\t\t\t\t\treasoningEfforts,\n\t\t\t\t\t\t// 用合并后的 maxMode，不是 maxModeDraft。\n\t\t\t\t\t\t// draft 的语义是「undefined = 本次没碰过这个开关」，而宿主那边\n\t\t\t\t\t\t// 收到 undefined 会**跳过该字段不写** —— 由于整段 selection 是整体\n\t\t\t\t\t\t// 覆盖的，结果是已存的 maxMode 被悄悄抹掉：用户只是勾了个模型，\n\t\t\t\t\t\t// Max 模式却自己关掉了。其它字段不受影响是因为它们在卡片里是\n\t\t\t\t\t\t// 「从 status 整体重建」，而不是「草稿叠加已存值」。\n\t\t\t\t\t\tmaxMode\n\t\t\t\t\t});\n\t\t\t\t\t/**\n\t\t\t\t\t* 写完**立即拉一次新状态，然后再丢掉草稿**。\n\t\t\t\t\t*\n\t\t\t\t\t* 顺序是关键。`setDraft(void 0)` 会让界面回落到 `draftFromStatus(status)`，\n\t\t\t\t\t* 而这里的 status 最多落后一轮轮询（30 秒）—— 先丢草稿的话，界面会先\n\t\t\t\t\t* 弹回旧选择，等下一次轮询才变过来，看起来就是「点了保存，好几秒才有\n\t\t\t\t\t* 反应」。这张卡里其它写操作（setDistribution / rescan / 冷却重置…）\n\t\t\t\t\t* 都是写完马上 `await refresh()`，saveModels 是唯一漏掉的，补齐。\n\t\t\t\t\t*\n\t\t\t\t\t* refresh 内部自己接错（失败只 setError 不抛），所以这里不会把\n\t\t\t\t\t* 已经成功的保存误报成失败。\n\t\t\t\t\t*/\n\t\t\t\t\tawait refresh(activeRegion);\n\t\t\t\t\tsetDraft(void 0);\n\t\t\t\t\t// Same after a successful save: the saved state is now the truth.\n\t\t\t\t\tsetMaxModeByRegion((prev) => {\n\t\t\t\t\t\tif (prev[activeRegion] === void 0) return prev;\n\t\t\t\t\t\tconst next = { ...prev };\n\t\t\t\t\t\tdelete next[activeRegion];\n\t\t\t\t\t\treturn next;\n\t\t\t\t\t});\n\t\t\t\t\tif (mounted.current) setFlash(t?.(\"row.modelsSaved\") ?? \"Saved\");\n\t\t\t\t} catch (cause) {\n\t\t\t\t\tif (mounted.current) setError(t?.(\"row.modelsSaveError\", { message: cause instanceof Error ? cause.message : String(cause) }) ?? String(cause));\n\t\t\t\t} finally {\n\t\t\t\t\tif (mounted.current) setSavingModels(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst title = t?.(\"row.title\") ?? \"WorkBuddy XD Pool\";\n\t\t\tconst description = t?.(\"row.desc\") ?? \"\";\n\t\t\tconst accountCount = status?.accounts.length ?? 0;\n\t\t\tconst cooling = status?.cooling ?? 0;\n\t\t\tconst state = error !== void 0 ? \"error\" : status === void 0 && error === void 0 ? \"idle\" : accountCount > 0 && cooling < accountCount ? \"ok\" : \"idle\";\n\t\t\t/** Human label for the active tab, used inside the empty-state copy. */\n\t\t\tconst regionLabel = activeRegion === \"cn\" ? t?.(\"row.tabCn\") ?? \"CN\" : t?.(\"row.tabGlobal\") ?? \"Global\";\n\t\t\tconst stateLabel = error !== void 0 ? t?.(\"row.requestFailed\") ?? \"Request failed\" : accountCount === 0 ? t?.(\"row.regionEmpty\") ?? t?.(\"row.poolEmpty\") ?? \"No account yet\" : state === \"ok\" ? t?.(\"row.ok\") ?? \"Healthy\" : t?.(\"row.allCooling\") ?? \"All cooling\";\n\t\t\tconst shimRunning = status?.shim.running === true;\n\t\t\tconst shimHint = status === void 0 ? null : shimRunning ? `${t?.(\"row.shimRunning\") ?? \"Provider listening\"}${status.shim.baseUrl === void 0 ? \"\" : ` · ${status.shim.baseUrl}`}` : t?.(\"row.shimStopped\") ?? \"Provider loopback not running\";\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page\",\n\t\t\t\tchildren: [\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"header\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-head\",\n\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"img\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-icon\",\n\t\t\t\t\t\t\t\tsrc: POOL_PLUGIN_ICON,\n\t\t\t\t\t\t\t\talt: \"\"\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-copy\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"h2\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-title\",\n\t\t\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-desc\",\n\t\t\t\t\t\t\t\t\tchildren: description\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-page-actions\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline\",\n\t\t\t\t\t\t\t\t\tdisabled: busy,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\trescan();\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: busy ? t?.(\"row.accountsScanning\") ?? \"Detecting…\" : t?.(\"row.accountsRescan\") ?? \"Detect accounts again\"\n\t\t\t\t\t\t\t\t}), cooling > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline\",\n\t\t\t\t\t\t\t\t\tdisabled: cooldownBusy,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tresetCooldowns();\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: cooldownBusy ? t?.(\"row.resetCooldownsBusy\") ?? \"Clearing…\" : t?.(\"row.resetCooldowns\") ?? \"Clear all cooldowns\"\n\t\t\t\t\t\t\t\t}) : null]\n\t\t\t\t\t\t\t})\n\t\t\t\t\t\t]\n\t\t\t\t\t}),\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-status\",\n\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-tabs\",\n\t\t\t\t\t\t\trole: \"tablist\",\n\t\t\t\t\t\t\tchildren: status?.regions.map((region) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\trole: \"tab\",\n\t\t\t\t\t\t\t\t\"aria-selected\": region === activeRegion,\n\t\t\t\t\t\t\t\tclassName: `dsm-workbuddy-xdpool-tab${region === activeRegion ? \" dsm-workbuddy-xdpool-tab-active\" : \"\"}`,\n\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\tsetActiveRegion(region);\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-tab-dot\",\n\t\t\t\t\t\t\t\t\t\"data-state\": state\n\t\t\t\t\t\t\t\t}), region === \"cn\" ? t?.(\"row.tabCn\") ?? \"CN\" : t?.(\"row.tabGlobal\") ?? \"Global\"]\n\t\t\t\t\t\t\t}, region))\n\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-head\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-copy\",\n\t\t\t\t\t\t\t\trole: \"status\",\n\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-status\",\n\t\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\"aria-hidden\": \"true\",\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-dot\",\n\t\t\t\t\t\t\t\t\t\t\tstyle: { background: dotColor(state) }\n\t\t\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: stateLabel })]\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\taccountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-hint\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.accountsSummary\", {\n\t\t\t\t\t\t\t\t\t\t\tcount: accountCount,\n\t\t\t\t\t\t\t\t\t\t\tcooling\n\t\t\t\t\t\t\t\t\t\t}) ?? `${accountCount} account(s) · ${cooling} cooling`\n\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\tshimHint === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-hint\",\n\t\t\t\t\t\t\t\t\t\tchildren: shimHint\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\tstatus === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist\",\n\t\t\t\t\t\t\t\t\t\trole: \"radiogroup\",\n\t\t\t\t\t\t\t\t\t\t\"aria-label\": t?.(\"row.distTitle\") ?? \"Account usage\",\n\t\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist-title\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.distTitle\") ?? \"Account usage\"\n\t\t\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist-options\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\t\t\t\"priority\",\n\t\t\t\t\t\t\t\t\t\t\t\t\"balanced\",\n\t\t\t\t\t\t\t\t\t\t\t\t\"round-robin\"\n\t\t\t\t\t\t\t\t\t\t\t].map((option) => {\n\t\t\t\t\t\t\t\t\t\t\t\tconst active = (status.distribution ?? \"priority\") === option;\n\t\t\t\t\t\t\t\t\t\t\t\tconst label = option === \"priority\" ? t?.(\"row.distPriority\") ?? \"Priority\" : option === \"balanced\" ? t?.(\"row.distBalanced\") ?? \"Balanced\" : t?.(\"row.distRoundRobin\") ?? \"Round-robin\";\n\t\t\t\t\t\t\t\t\t\t\t\tconst hint = option === \"priority\" ? t?.(\"row.distPriorityHint\") ?? \"\" : option === \"balanced\" ? t?.(\"row.distBalancedHint\") ?? \"\" : t?.(\"row.distRoundRobinHint\") ?? \"\";\n\t\t\t\t\t\t\t\t\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\t\t\t\t\trole: \"radio\",\n\t\t\t\t\t\t\t\t\t\t\t\t\t\"aria-checked\": active,\n\t\t\t\t\t\t\t\t\t\t\t\t\ttitle: hint,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: !modelsEditable,\n\t\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist-option\" + (active ? \" dsm-workbuddy-xdpool-dist-option-active\" : \"\"),\n\t\t\t\t\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tsetDistribution(option);\n\t\t\t\t\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist-option-name\",\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tchildren: label\n\t\t\t\t\t\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-dist-option-hint\",\n\t\t\t\t\t\t\t\t\t\t\t\t\t\tchildren: hint\n\t\t\t\t\t\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t\t\t\t\t\t}, option);\n\t\t\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-usage-actions\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline\",\n\t\t\t\t\t\t\t\t\tdisabled: busy,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\trescan();\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: busy ? t?.(\"row.accountsScanning\") ?? \"Detecting…\" : t?.(\"row.accountsRescan\") ?? \"Detect accounts again\"\n\t\t\t\t\t\t\t\t}), cooling > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline\",\n\t\t\t\t\t\t\t\t\tdisabled: cooldownBusy,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tresetCooldowns();\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: cooldownBusy ? t?.(\"row.resetCooldownsBusy\") ?? \"Clearing…\" : t?.(\"row.resetCooldowns\") ?? \"Clear all cooldowns\"\n\t\t\t\t\t\t\t\t}) : null]\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t})]\n\t\t\t\t\t}),\n\t\t\t\t\tactiveRegion !== \"cn\" || status?.automation === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-auto\",\n\t\t\t\t\t\t\"aria-label\": t?.(\"row.autoTitle\") ?? \"Automation\",\n\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-head\",\n\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-title\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoTitle\") ?? \"Automation\"\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t!status.automation.enabled ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline dsm-workbuddy-xdpool-auto-run\",\n\t\t\t\t\t\t\t\t\t\tdisabled: automationRun !== void 0,\n\t\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\t\trunAutomationJob();\n\t\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\t\tchildren: automationRun !== void 0 ? t?.(\"row.autoRunning\") ?? \"Running…\" : t?.(\"row.autoRunAll\") ?? \"Run all now\"\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\t\trole: \"switch\",\n\t\t\t\t\t\t\t\t\t\t\"aria-checked\": status.automation.enabled,\n\t\t\t\t\t\t\t\t\t\tdisabled: !settingsWritable || automationBusy,\n\t\t\t\t\t\t\t\t\t\tclassName: `dsm-workbuddy-xdpool-auto-switch${status.automation.enabled ? \" dsm-workbuddy-xdpool-auto-switch-on\" : \"\"}`,\n\t\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\t\tsetAutomationEnabled(!status.automation.enabled);\n\t\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\t\tchildren: automationBusy ? t?.(\"row.autoBusy\") ?? \"Saving…\" : status.automation.enabled ? t?.(\"row.autoOn\") ?? \"On\" : t?.(\"row.autoOff\") ?? \"Off\"\n\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-hint\",\n\t\t\t\t\t\t\t\tchildren: status.automation.enabled ? t?.(\"row.autoHintOn\") ?? \"Reports activity, claims task rewards and checks in once a day.\" : t?.(\"row.autoHintOff\") ?? \"Off: no background requests are made for you.\"\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\tautomationTotals.credit === 0 && automationTotals.checkinCredit === 0 && automationTotals.bonusCredit === 0 && automationTotals.travelCredit === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-label\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoToday\") ?? \"Today\"\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-list\",\n\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\tautomationTotals.credit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-row\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromTasks\", {\n\t\t\t\t\t\t\t\t\t\t\t\tcredit: automationTotals.credit,\n\t\t\t\t\t\t\t\t\t\t\t\tenergy: automationTotals.energy,\n\t\t\t\t\t\t\t\t\t\t\t\tcount: automationTotals.claimed\n\t\t\t\t\t\t\t\t\t\t\t}) ?? `Tasks +${automationTotals.credit}`\n\t\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\t\tautomationTotals.checkinCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-row\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromCheckin\", { credit: automationTotals.checkinCredit }) ?? `Check-in +${automationTotals.checkinCredit}`\n\t\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\t\tautomationTotals.bonusCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-row\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromBonus\", { credit: automationTotals.bonusCredit }) ?? `Streak +${automationTotals.bonusCredit}`\n\t\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\t\tautomationTotals.travelCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-total-row\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromTravel\", { credit: automationTotals.travelCredit }) ?? `Buddy +${automationTotals.travelCredit}`\n\t\t\t\t\t\t\t\t\t\t}) : null\n\t\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\tstatus.automation.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-jobs\",\n\t\t\t\t\t\t\t\tchildren: AUTOMATION_JOBS.map((kind) => {\n\t\t\t\t\t\t\t\t\tconst job = automationJob(status, kind);\n\t\t\t\t\t\t\t\t\tconst hours = automationHours(status, kind);\n\t\t\t\t\t\t\t\t\tconst label = t?.(`row.autoJob_${kind}`) ?? kind;\n\t\t\t\t\t\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job\",\n\t\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job-name\",\n\t\t\t\t\t\t\t\t\t\t\t\tchildren: label\n\t\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job-when\",\n\t\t\t\t\t\t\t\t\t\t\t\tchildren: hours.length === 0 ? t?.(\"row.autoHourNone\") ?? \"not scheduled\" : hours.map((hour) => `${String(hour).padStart(2, \"0\")}:00`).join(\" · \")\n\t\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job-last\",\n\t\t\t\t\t\t\t\t\t\t\t\tchildren: job?.lastRunDate === void 0 ? t?.(\"row.autoNever\") ?? \"not run yet\" : `${job.lastRunDate} · ${job.ok}${job.failed > 0 ? `/${job.failed}` : \"\"}`\n\t\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\t\tjob?.progress === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job-note\",\n\t\t\t\t\t\t\t\t\t\t\t\tchildren: job.progress\n\t\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\t\tjob?.detail === void 0 || job.detail.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-auto-job-detail\",\n\t\t\t\t\t\t\t\t\t\t\t\tchildren: job.detail.join(\" · \")\n\t\t\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t\t\t}, kind);\n\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t}) : null\n\t\t\t\t\t\t]\n\t\t\t\t\t}),\n\t\t\t\t\tflash === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-note\",\n\t\t\t\t\t\tchildren: flash\n\t\t\t\t\t}),\n\t\t\t\t\terror === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-error\",\n\t\t\t\t\t\tchildren: t?.(\"row.error\", { message: error }) ?? `Pool status unavailable: ${error}`\n\t\t\t\t\t}),\n\t\t\t\t\taccountCount === 0 && error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-empty\",\n\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-empty-title\",\n\t\t\t\t\t\t\t\tchildren: t?.(\"row.regionEmptyTitle\", { region: regionLabel }) ?? t?.(\"row.regionEmpty\") ?? \"No account yet\"\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-empty-steps\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-empty-steps-title\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.regionHowToTitle\", { region: regionLabel }) ?? `How to sign in to the ${regionLabel} version`\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"ol\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-empty-list\",\n\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"li\", { children: t?.(\"row.regionHowTo1\") ?? \"\" }),\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"li\", { children: t?.(\"row.regionHowTo2\") ?? \"\" }),\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"li\", { children: t?.(\"row.regionHowTo3\") ?? \"\" }),\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"li\", { children: t?.(\"row.regionHowTo4\") ?? \"\" })\n\t\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-empty-note\",\n\t\t\t\t\t\t\t\tchildren: t?.(\"row.regionHowToNote\") ?? \"\"\n\t\t\t\t\t\t\t})\n\t\t\t\t\t\t]\n\t\t\t\t\t}) : null,\n\t\t\t\t\taccountCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-accounts\",\n\t\t\t\t\t\t\"aria-label\": t?.(\"row.accountsTitle\") ?? \"Accounts\",\n\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-accounts-head\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"h3\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-accounts-title\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.accountsTitle\") ?? \"Accounts in the pool\"\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-accounts-summary\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.accountsSummary\", {\n\t\t\t\t\t\t\t\t\t\tcount: accountCount,\n\t\t\t\t\t\t\t\t\t\tcooling\n\t\t\t\t\t\t\t\t\t}) ?? `${accountCount} account(s) · ${cooling} cooling`\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t(() => {\n\t\t\t\t\t\t\t\tconst active = status?.activeAccountId === void 0 ? void 0 : status.accounts.find((account) => account.id === status.activeAccountId);\n\t\t\t\t\t\t\t\tif (active === void 0) return null;\n\t\t\t\t\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-current\",\n\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { className: \"dsm-workbuddy-xdpool-current-dot\" }),\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-current-label\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.currentAccount\") ?? \"In use now\"\n\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-current-name\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: active.label\n\t\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t\tactive.disabled === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-current-note\",\n\t\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.currentAccountDisabled\") ?? \"disabled — will switch on the next request\"\n\t\t\t\t\t\t\t\t\t\t}) : null\n\t\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t})(),\n\t\t\t\t\t\t\tstatus?.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountBlock, {\n\t\t\t\t\t\t\t\taccount,\n\t\t\t\t\t\t\t\t...checkinBusyId === void 0 ? {} : { checkinBusyId },\n\t\t\t\t\t\t\t\tonClaimCheckin: (accountId) => {\n\t\t\t\t\t\t\t\t\tclaimCheckin(accountId);\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\tonSaveCreditReserve: (accountId, reserve) => saveCreditReserve(accountId, reserve),\n\t\t\t\t\t\t\t\tonToggleDisabled: (accountId, disabled) => {\n\t\t\t\t\t\t\t\t\ttoggleAccountDisabled(accountId, disabled);\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\tonIgnoreAccount: (accountId) => {\n\t\t\t\t\t\t\t\t\tsetAccountIgnored(accountId, true);\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t...accountBusyId === void 0 ? {} : { accountBusyId },\n\t\t\t\t\t\t\t\tt\n\t\t\t\t\t\t\t}, account.id))\n\t\t\t\t\t\t]\n\t\t\t\t\t}) : null,\n\t\t\t\t\t(status?.ignored.length ?? 0) > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-ignored\",\n\t\t\t\t\t\t\"aria-label\": t?.(\"row.ignoredTitle\") ?? \"Removed accounts\",\n\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-head\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"h3\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-title\",\n\t\t\t\t\t\t\t\tchildren: t?.(\"row.ignoredTitle\") ?? \"Removed accounts\"\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-summary\",\n\t\t\t\t\t\t\t\tchildren: t?.(\"row.ignoredSummary\", { count: status?.ignored.length ?? 0 }) ?? `${status?.ignored.length ?? 0} account(s) no longer in the pool`\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-list\",\n\t\t\t\t\t\t\tchildren: (status?.ignored ?? []).map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-row\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-label\",\n\t\t\t\t\t\t\t\t\tchildren: entry.label\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-ignored-restore\",\n\t\t\t\t\t\t\t\t\ttitle: t?.(\"row.ignoredRestoreHint\") ?? \"Put this account back into the pool\",\n\t\t\t\t\t\t\t\t\tdisabled: accountBusyId === entry.id,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tsetAccountIgnored(entry.id, false);\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.ignoredRestore\") ?? \"Restore\"\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}, entry.id))\n\t\t\t\t\t\t})]\n\t\t\t\t\t}) : null,\n\t\t\t\t\t(status?.models.length ?? 0) > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-models\",\n\t\t\t\t\t\t\"aria-label\": t?.(\"row.modelsTitle\") ?? \"Models\",\n\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-models-head\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-models-heading\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"h3\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-models-title\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelsTitle\") ?? \"Models\"\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"p\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-models-summary\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelsEnabledCount\", {\n\t\t\t\t\t\t\t\t\t\tenabled: enabledCount,\n\t\t\t\t\t\t\t\t\t\ttotal: status?.models.length ?? 0\n\t\t\t\t\t\t\t\t\t}) ?? `${enabledCount} / ${status?.models.length ?? 0} enabled`\n\t\t\t\t\t\t\t\t})]\n}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"label\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-maxmode\",\n\t\t\t\t\t\t\ttitle: t?.(\"row.modelMaxModeHint\") ?? \"Give every model its full context window and strongest thinking level\",\n\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\t\t\ttype: \"checkbox\",\n\t\t\t\t\t\t\t\tchecked: maxMode,\n\t\t\t\t\t\t\t\tdisabled: !modelsEditable,\n\t\t\t\t\t\t\t\tonChange: (event) => {\n\t\t\t\t\t\t\t\t\tsetMaxMode(event.target.checked);\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-maxmode-text\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-maxmode-label\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelMaxMode\") ?? \"Max mode\"\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-maxmode-hint\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelMaxModeHint\") ?? \"Full context window and strongest thinking for every model\"\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-models-actions\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-outline\",\n\t\t\t\t\t\t\t\t\tdisabled: !modelsDirty || savingModels,\n\t\t\t\t\t\t\t\t\tonClick: discardModels,\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelsDiscard\") ?? \"Discard\"\n\t\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-btn dsm-btn-primary\",\n\t\t\t\t\t\t\t\t\tdisabled: !modelsDirty || savingModels || enabledCount === 0,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tsaveModels();\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: savingModels ? t?.(\"row.modelsSaving\") ?? \"Saving…\" : t?.(\"row.modelsSave\") ?? \"Save\"\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-list\",\n\t\t\t\t\t\t\tchildren: status?.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {\n\t\t\t\t\t\t\t\tmodel,\n\t\t\t\t\t\t\t\tt,\n\t\t\t\t\t\t\t\tdraft: modelDraft[model.id] ?? {\n\t\t\t\t\t\t\t\t\tenabled: model.enabled,\n\t\t\t\t\t\t\t\t\timages: model.supportsImages\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\teditable: modelsEditable,\n\t\t\t\t\t\t\t\tmaxMode,\n\t\t\t\t\t\t\t\tonToggle: toggleModel,\n\t\t\t\t\t\t\t\tonToggleImage: toggleModelImage,\n\t\t\t\t\t\t\t\tonBudget: setModelBudget\n\t\t\t\t\t\t\t}, model.id))\n\t\t\t\t\t\t})]\n\t\t\t\t\t}) : null\n\t\t\t\t]\n\t\t\t});\n\t\t}\n\t\t/** One account block: label + status tag + meta + optional credit panels. */\n\t\tfunction AccountBlock({ account, t, checkinBusyId, onClaimCheckin, accountBusyId, onToggleDisabled, onIgnoreAccount, onSaveCreditReserve, reserveBusyId }) {\n\t\t\tconst isDisabled = account.disabled === true;\n\t\t\tconst isCooling = account.cooling === true;\n\t\t\tconst cooldownUntil = account.cooldownUntil !== void 0 ? Date.parse(account.cooldownUntil) : void 0;\n\t\t\tconst modelCooldowns = account.modelCooldowns ?? [];\n\t\t\tconst tag = isCooling ? {\n\t\t\t\ttext: t?.(\"row.cooling\") ?? \"Cooling\",\n\t\t\t\tcls: \"dsm-workbuddy-xdpool-account-tag dsm-workbuddy-xdpool-account-tag-cooling\"\n\t\t\t} : null;\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\tclassName: isDisabled ? \"dsm-workbuddy-xdpool-account dsm-workbuddy-xdpool-account-off\" : \"dsm-workbuddy-xdpool-account\",\n\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-head\",\n\t\t\t\t\tchildren: [\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-label\",\n\t\t\t\t\t\t\tchildren: account.label\n\t\t\t\t\t\t}),\n\t\t\t\t\t\ttag === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: tag.cls,\n\t\t\t\t\t\t\tchildren: tag.text\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\trole: \"switch\",\n\t\t\t\t\t\t\t\"aria-checked\": !isDisabled,\n\t\t\t\t\t\t\tclassName: isDisabled ? \"dsm-workbuddy-xdpool-account-toggle\" : \"dsm-workbuddy-xdpool-account-toggle dsm-workbuddy-xdpool-account-toggle-on\",\n\t\t\t\t\t\t\ttitle: t?.(\"row.accountToggleHint\") ?? \"Enable this account (uncheck to keep it out of the pool)\",\n\t\t\t\t\t\t\tdisabled: accountBusyId === account.id,\n\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\tonToggleDisabled(account.id, !isDisabled);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { className: \"dsm-workbuddy-xdpool-account-toggle-dot\" }), isDisabled ? t?.(\"row.accountOff\") ?? \"Disabled\" : t?.(\"row.accountInRotation\") ?? \"Enabled\"]\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-ignore\",\n\t\t\t\t\t\t\ttitle: t?.(\"row.accountIgnoreHint\") ?? \"Remove this account from the pool for good\",\n\t\t\t\t\t\t\tdisabled: accountBusyId === account.id,\n\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\tonIgnoreAccount(account.id);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: t?.(\"row.accountIgnore\") ?? \"Remove\"\n\t\t\t\t\t\t})\n\t\t\t\t\t]\n\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-body\",\n\t\t\t\t\tchildren: [\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-copy\",\n\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\taccount.expiresAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-meta\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.tokenExpiry\", { time: formatDateTime(account.expiresAt) }) ?? `token ${formatDateTime(account.expiresAt)}`\n\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\tisCooling && cooldownUntil !== void 0 && !Number.isNaN(cooldownUntil) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-meta\",\n\t\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\t\tt?.(\"row.cooldownUntil\", { time: formatTime(cooldownUntil) }) ?? `until ${formatTime(cooldownUntil)}`,\n\t\t\t\t\t\t\t\t\t\t\" · \",\n\t\t\t\t\t\t\t\t\t\tt?.(\"row.cooldownHits\", { hits: account.rateLimitHits ?? 0 }) ?? `${account.rateLimitHits ?? 0} hit(s)`\n\t\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\tmodelCooldowns.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-modelcool\",\n\t\t\t\t\t\t\t\t\tchildren: modelCooldowns.map((mc) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-account-modelcool-chip\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.modelCooling\", {\n\t\t\t\t\t\t\t\t\t\t\tmodel: mc.modelId,\n\t\t\t\t\t\t\t\t\t\t\ttime: formatDateTime(mc.until)\n\t\t\t\t\t\t\t\t\t\t}) ?? `${mc.modelId} cooling to ${formatDateTime(mc.until)}`\n\t\t\t\t\t\t\t\t\t}, mc.modelId))\n\t\t\t\t\t\t\t\t}) : null\n\t\t\t\t\t\t\t]\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountStats, {\n\t\t\t\t\t\t\taccount,\n\t\t\t\t\t\t\tt,\n\t\t\t\t\t\t\tcheckinBusy: checkinBusyId === account.id,\n\t\t\t\t\t\t\tonClaim: onClaimCheckin\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditReserveRow, {\n\t\t\t\t\t\t\taccount,\n\t\t\t\t\t\t\tt,\n\t\t\t\t\t\t\tbusy: reserveBusyId === account.id,\n\t\t\t\t\t\t\tonSave: onSaveCreditReserve\n\t\t\t\t\t\t}),\n\t\t\t\t\t\taccount.automationToday === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-label\",\n\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoEarned\") ?? \"Automation today\"\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-list\",\n\t\t\t\t\t\t\t\tchildren: [\n\t\t\t\t\t\t\t\t\taccount.automationToday.credit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-row\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromTasks\", {\n\t\t\t\t\t\t\t\t\t\t\tcredit: account.automationToday.credit,\n\t\t\t\t\t\t\t\t\t\t\tenergy: account.automationToday.energy,\n\t\t\t\t\t\t\t\t\t\t\tcount: account.automationToday.claimed\n\t\t\t\t\t\t\t\t\t\t}) ?? `Tasks +${account.automationToday.credit}`\n\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\taccount.automationToday.checkinCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-row\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromCheckin\", { credit: account.automationToday.checkinCredit }) ?? `Check-in +${account.automationToday.checkinCredit}`\n\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\taccount.automationToday.bonusCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-row\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromBonus\", { credit: account.automationToday.bonusCredit }) ?? `Streak +${account.automationToday.bonusCredit}`\n\t\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t\taccount.automationToday.travelCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-earned-row\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.autoFromTravel\", { credit: account.automationToday.travelCredit }) ?? `Buddy +${account.automationToday.travelCredit}`\n\t\t\t\t\t\t\t\t\t}) : null\n\t\t\t\t\t\t\t\t]\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t})\n\t\t\t\t\t]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t/**\n\t\t* Daily check-in block: streak summary plus one claim button for this account.\n\t\t* Every account in the pool gets its own button, so a multi-account user can\n\t\t* collect each reward without switching the pool's preferred account first.\n\t\t*/\n\t\t/**\n\t\t* Credit panels: package breakdown on the left, the big total on the right with\n\t\t* the daily check-in action docked beneath it. Mirrors the two-column credit\n\t\t* layout the LaoDing plugin family uses, so the numbers stay scannable and the\n\t\t* claim button sits where the eye already is.\n\t\t*/\n\t\t/**\n\t\t* Reserved-credit control for one account.\n\t\t*\n\t\t* The value is committed on blur or Enter rather than on every keystroke:\n\t\t* each save is a settings write plus a status refresh, and a per-character\n\t\t* save would hammer both.\n\t\t*/\n\t\t/**\n\t\t* The reserved-credit floor for one account.\n\t\t*\n\t\t* Saving is an EXPLICIT action, not a blur side effect. The old version\n\t\t* committed `onBlur`, which meant a value could be written without the user\n\t\t* asking for it — and when the write silently failed, the only trace was a\n\t\t* notice line at the top of the card that is easy to miss. That is how\n\t\t* \"I typed a number, reopened, and it says 0 again\" happened with no visible\n\t\t* error to explain it.\n\t\t*\n\t\t* Now: the field is a draft, Save is enabled only when the draft differs from\n\t\t* what the host last reported, and the outcome (saving / saved / failed) is\n\t\t* shown inline next to the button. Enter also saves, so keyboard flow is not\n\t\t* lost.\n\t\t*/\n\t\tfunction CreditReserveRow({ account, t, busy, onSave }) {\n\t\t\tconst saved = account.creditReserve ?? 0;\n\t\t\tconst [draft, setDraft] = (0, react.useState)(String(saved));\n\t\t\tconst [settled, setSettled] = (0, react.useState)(saved);\n\t\t\tconst [note, setNote] = (0, react.useState)(void 0);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tsetSettled(saved);\n\t\t\t\tsetDraft((current) => current === String(saved) ? current : String(saved));\n\t\t\t}, [saved]);\n\t\t\tconst parsed = Number.parseInt(draft, 10);\n\t\t\tconst next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;\n\t\t\tconst dirty = next !== settled;\n\t\t\tconst commit = async () => {\n\t\t\t\tif (busy || !dirty) return;\n\t\t\t\tsetNote(void 0);\n\t\t\t\tif (await onSave(account.id, next)) {\n\t\t\t\t\tsetSettled(next);\n\t\t\t\t\tsetDraft(String(next));\n\t\t\t\t\tsetNote(\"saved\");\n\t\t\t\t} else setNote(\"failed\");\n\t\t\t};\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve\",\n\t\t\t\tchildren: [\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-label\",\n\t\t\t\t\t\tchildren: t?.(\"row.reserveTitle\") ?? \"Keep at least\"\n\t\t\t\t\t}),\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\ttype: \"number\",\n\t\t\t\t\t\tmin: 0,\n\t\t\t\t\t\tstep: 1,\n\t\t\t\t\t\tvalue: draft,\n\t\t\t\t\t\tdisabled: busy,\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-input\",\n\t\t\t\t\t\t\"aria-label\": t?.(\"row.reserveTitle\") ?? \"Keep at least\",\n\t\t\t\t\t\tonChange: (event) => {\n\t\t\t\t\t\t\tsetDraft(event.target.value);\n\t\t\t\t\t\t\tsetNote(void 0);\n\t\t\t\t\t\t},\n\t\t\t\t\t\tonKeyDown: (event) => {\n\t\t\t\t\t\t\tif (event.key === \"Enter\") commit();\n\t\t\t\t\t\t}\n\t\t\t\t\t}),\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-unit\",\n\t\t\t\t\t\tchildren: t?.(\"row.reserveUnit\") ?? \"credits\"\n\t\t\t\t\t}),\n\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-save\",\n\t\t\t\t\t\tdisabled: busy || !dirty,\n\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\tcommit();\n\t\t\t\t\t\t},\n\t\t\t\t\t\tchildren: busy ? t?.(\"row.reserveSaving\") ?? \"Saving…\" : t?.(\"row.reserveSave\") ?? \"Save\"\n\t\t\t\t\t}),\n\t\t\t\t\tnote === \"saved\" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-note dsm-workbuddy-xdpool-reserve-note-ok\",\n\t\t\t\t\t\tchildren: next > 0 ? t?.(\"row.reserveSaved\", { credits: next }) ?? `Keeping ${next} credits` : t?.(\"row.reserveCleared\") ?? \"Reserve cleared\"\n\t\t\t\t\t}) : null,\n\t\t\t\t\tnote === \"failed\" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-note dsm-workbuddy-xdpool-reserve-note-bad\",\n\t\t\t\t\t\tchildren: t?.(\"row.reserveFailed\") ?? \"Not saved — try again\"\n\t\t\t\t\t}) : null,\n\t\t\t\t\taccount.reserved === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-reserve-badge\",\n\t\t\t\t\t\tchildren: t?.(\"row.reserveHolding\") ?? \"Reserved: skipped\"\n\t\t\t\t\t}) : null\n\t\t\t\t]\n\t\t\t});\n\t\t}\n\t\tfunction AccountStats({ account, t, checkinBusy, onClaim }) {\n\t\t\tconst credits = account.credits;\n\t\t\tconst checkin = account.checkin;\n\t\t\tconst hasCredits = credits !== void 0 || account.creditsError !== void 0;\n\t\t\tconst hasCheckin = checkin !== void 0 || account.checkinError !== void 0;\n\t\t\tif (!hasCredits && !hasCheckin) return null;\n\t\t\tconst packages = (credits?.packages ?? []).filter((p) => (p.size ?? 0) > 0).slice(0, 6);\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\tclassName: \"dsm-workbuddy-xdpool-stats\",\n\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-packages\",\n\t\t\t\t\tchildren: [\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel-title\",\n\t\t\t\t\t\t\tchildren: t?.(\"row.creditsPackages\") ?? \"Credit packages\"\n\t\t\t\t\t\t}),\n\t\t\t\t\t\taccount.creditsError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel-error\",\n\t\t\t\t\t\t\tchildren: account.creditsError\n\t\t\t\t\t\t}) : packages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel-empty\",\n\t\t\t\t\t\t\tchildren: \"–\"\n\t\t\t\t\t\t}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"ul\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-packages\",\n\t\t\t\t\t\t\tchildren: packages.map((pack, index) => {\n\t\t\t\t\t\t\t\tconst expiry = formatExpiry(pack.expiresAtMs);\n\t\t\t\t\t\t\t\tconst refresh = formatExpiry(pack.cycleRefreshMs);\n\t\t\t\t\t\t\t\tconst soon = isExpiringSoon(pack);\n\t\t\t\t\t\t\t\tconst when = pack.monthly === true ? refresh === \"\" ? null : t?.(\"row.creditsRefreshAt\", { time: refresh }) ?? `Refreshes ${refresh}` : expiry === \"\" ? null : t?.(\"row.creditsExpiresAt\", { time: expiry }) ?? `Expires ${expiry}`;\n\t\t\t\t\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"li\", { children: [\n\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-packages-name\",\n\t\t\t\t\t\t\t\t\t\tchildren: pack.packageName\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-packages-value\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.creditsPackage\", {\n\t\t\t\t\t\t\t\t\t\t\tremain: formatNumber(pack.remain),\n\t\t\t\t\t\t\t\t\t\t\tsize: formatNumber(pack.size)\n\t\t\t\t\t\t\t\t\t\t}) ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`\n\t\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t\twhen === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: `dsm-workbuddy-xdpool-packages-when${soon ? \" dsm-workbuddy-xdpool-packages-when-soon\" : \"\"}`,\n\t\t\t\t\t\t\t\t\t\ttitle: t?.(\"row.creditsExpiresSoonTitle\") ?? \"Expiring within 3 days\",\n\t\t\t\t\t\t\t\t\t\tchildren: when\n\t\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t\t] }, `${pack.packageName}-${String(index)}`);\n\t\t\t\t\t\t\t})\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tcredits?.expiringSoon !== void 0 && credits.expiringSoon > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel-foot\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: t?.(\"row.creditsSoon\") ?? \"Expiring in 3 days\" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"strong\", { children: formatNumber(credits.expiringSoon) })]\n\t\t\t\t\t\t}) : null\n\t\t\t\t\t]\n\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-total\",\n\t\t\t\t\tchildren: [\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-panel-title\",\n\t\t\t\t\t\t\tchildren: t?.(\"row.creditsTotal\") ?? \"Total\"\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-total-value\",\n\t\t\t\t\t\t\tchildren: formatNumber(credits?.total)\n\t\t\t\t\t\t}),\n\t\t\t\t\t\thasCheckin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin\",\n\t\t\t\t\t\t\tchildren: account.checkinError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-error\",\n\t\t\t\t\t\t\t\tchildren: account.checkinError\n\t\t\t\t\t\t\t}) : checkin === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-meta\",\n\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-streak\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.checkinStreak\", { days: checkin.streakDays }) ?? `${checkin.streakDays}-day streak`\n\t\t\t\t\t\t\t\t\t}), checkin.dailyCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-daily\",\n\t\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.checkinDaily\", { credit: formatNumber(checkin.dailyCredit) }) ?? `+${formatNumber(checkin.dailyCredit)}/day`\n\t\t\t\t\t\t\t\t\t}) : null]\n\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\tcheckin.isStreakDay && checkin.streakBonusCredit > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-bonus\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.checkinStreakBonus\", {\n\t\t\t\t\t\t\t\t\t\tdays: formatNumber(checkin.nextStreakDay),\n\t\t\t\t\t\t\t\t\t\tcredit: formatNumber(checkin.streakBonusCredit)\n\t\t\t\t\t\t\t\t\t}) ?? `bonus +${formatNumber(checkin.streakBonusCredit)}`\n\t\t\t\t\t\t\t\t}) : null,\n\t\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-checkin-btn\",\n\t\t\t\t\t\t\t\t\tdisabled: !checkin.active || checkin.todayCheckedIn || checkinBusy,\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tonClaim(account.id);\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: !checkin.active ? t?.(\"row.checkinInactive\") ?? \"Unavailable\" : checkin.todayCheckedIn ? t?.(\"row.checkinClaimed\") ?? \"Checked in\" : checkinBusy ? t?.(\"row.checkinClaiming\") ?? \"Checking in…\" : t?.(\"row.checkinClaim\") ?? \"Check in\"\n\t\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\t] })\n\t\t\t\t\t\t}) : null\n\t\t\t\t\t]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t/**\n\t\t* The thinking levels this model off}\n/**\n\t\t* One model row.\n\t\t*\n\t\t* 思考强度**不在这里选**：DSH 自带的推理等级列表已经按模型给出\n\t\t* 精确档位（上游给low/high 就只显示低/高，和 WorkBuddy 客户端一致），\n\t\t* 这里再放一个下拉就是重复实现，而且两套容易各说各话。\n\t\t* 模型行只展示该模型支持哪些档位，供对照。\n\t\t*\n\t\t* Read-only when the card has no writable settings scope: the checkbox and the\n\t\t* context radios stay disabled rather than pretending an edit took hold. The\n\t\t* draft lives in the parent, so this component only ever reports intent.\n\t\t*/\n\t\tfunction ModelRow({ model, t, draft, editable, maxMode, onToggle, onToggleImage, onBudget }) {\n\t\t\tconst tag = tagFor(model);\n\t\t\tconst tagText = tag === \"free\" ? t?.(\"row.free\") ?? \"free\" : tag === \"limited\" ? t?.(\"row.limitedFree\") ?? \"limited free\" : tag === \"night\" ? t?.(\"row.nightDiscount\") ?? \"night\" : null;\n\t\t\tconst native = model.nativeContextWindow;\n\t\t\tconst capped = native > DEFAULT_CONTEXT_BUDGET;\n\t\t\tconst currentBudget = draft.budget ?? native;\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\tclassName: `dsm-workbuddy-xdpool-model${draft.enabled ? \"\" : \" dsm-workbuddy-xdpool-model-off\"}`,\n\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-head\",\n\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"label\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-check\",\n\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\t\ttype: \"checkbox\",\n\t\t\t\t\t\t\tchecked: draft.enabled,\n\t\t\t\t\t\t\tdisabled: !editable,\n\t\t\t\t\t\t\tonChange: () => {\n\t\t\t\t\t\t\t\tonToggle(model.id);\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-copy\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-name\",\n\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: model.name }), model.multiplier === void 0 || model.multiplier === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-name-rate\",\n\t\t\t\t\t\t\t\t\tchildren: t?.(\"row.rate\", { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`\n\t\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-id\",\n\t\t\t\t\t\t\t\tchildren: model.id\n\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t})]\n\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-controls\",\n\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"label\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-image\",\n\t\t\t\t\t\t\ttitle: t?.(\"row.modelImage\") ?? \"Image input\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\t\t\ttype: \"checkbox\",\n\t\t\t\t\t\t\t\tchecked: draft.images,\n\t\t\t\t\t\t\t\tdisabled: !editable,\n\t\t\t\t\t\t\t\tonChange: () => {\n\t\t\t\t\t\t\t\t\tonToggleImage(model.id);\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: t?.(\"row.modelImage\") ?? \"Image\" })]\n\t\t\t\t\t\t}), capped ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"fieldset\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-budget\",\n\t\t\t\t\t\t\t\"aria-label\": t?.(\"row.modelContextBudget\") ?? \"Context\",\n\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"label\", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\t\t\ttype: \"radio\",\n\t\t\t\t\t\t\t\tname: `budget-${model.id}`,\n\t\t\t\t\t\t\t\tchecked: currentBudget === DEFAULT_CONTEXT_BUDGET,\n\t\t\t\t\t\t\t\tdisabled: !editable,\n\t\t\t\t\t\t\t\tonChange: () => {\n\t\t\t\t\t\t\t\t\tonBudget(model.id, DEFAULT_CONTEXT_BUDGET);\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: formatCapacity(DEFAULT_CONTEXT_BUDGET) })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"label\", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"input\", {\n\t\t\t\t\t\t\t\ttype: \"radio\",\n\t\t\t\t\t\t\t\tname: `budget-${model.id}`,\n\t\t\t\t\t\t\t\tchecked: currentBudget === native,\n\t\t\t\t\t\t\t\tdisabled: !editable,\n\t\t\t\t\t\t\t\tonChange: () => {\n\t\t\t\t\t\t\t\t\tonBudget(model.id, native);\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", { children: formatCapacity(native) })] })]\n\t\t\t\t\t\t}) : null]\n\t\t\t\t\t})]\n\t\t\t\t}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-meta\",\n\t\t\t\t\tchildren: [\n\t\t\t\t\t\ttagText === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-meta-tag\",\n\t\t\t\t\t\t\tchildren: tagText\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-cap\",\n\t\t\t\t\t\t\tchildren: t?.(\"row.modelOutput\", { size: formatCapacity(model.maxOutputTokens) }) ?? `out ${formatCapacity(model.maxOutputTokens)}`\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tmodel.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-cap\",\n\t\t\t\t\t\t\ttitle: t?.(\"row.modelReasoningHint\") ?? \"Pick the thinking level in the host's own model picker\",\n\t\t\t\t\t\t\tchildren: t?.(\"row.modelReasoning\", { efforts: model.supportedEfforts.join(\" / \") }) ?? model.supportedEfforts.join(\" / \")\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t// Under Max 模式 the ladder text is misleading (the strongest\n\t\t\t\t\t\t// level is what will actually be used), so name that instead.\n\t\t\t\t\t\tmaxMode === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tclassName: \"dsm-workbuddy-xdpool-model-meta-tag\",\n\t\t\t\t\t\t\tchildren: t?.(\"row.modelMaxMode\") ?? \"Max mode\"\n\t\t\t\t\t\t}) : null\n\t\t\t\t\t]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n\t\t//#region src/client/nav-icon.ts\n\t\t/**\n\t\t* Nav glyph for the WorkBuddy XD Pool settings page.\n\t\t*\n\t\t* The host's settings shell draws its own 16px `svg` in every nav row and the\n\t\t* `settings.section` registration contract projects only `id` / `order` /\n\t\t* `label` — there is no `icon` field to pass. A third-party page therefore has\n\t\t* to mark its row in the DOM and mask this artwork over the shell's glyph, the\n\t\t* same technique `dshmarket` uses (`installSettingsNavIcon`).\n\t\t*\n\t\t* Kept as a single monochrome path so `mask-image` + `currentColor` can tint it\n\t\t* with whatever the active theme uses for nav text: a filled mask cannot carry\n\t\t* its own palette, and a two-tone icon would render as a flat silhouette.\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/client/nav-icon\n\t\t*/\n\t\t/**\n\t\t* The nav mark: a stack of three rounded \"accounts\" under a rotation arc.\n\t\t*\n\t\t* Reads as \"a pool of accounts being cycled\" at 16px, and — unlike a literal\n\t\t* droplet or cloud — stays legible when reduced to a single-color silhouette.\n\t\t* `fill-rule=\"evenodd\"` cuts the interior notches out of the silhouette so the\n\t\t* three layers stay distinguishable at that size.\n\t\t*/\n\t\tconst POOL_NAV_ICON_SVG = [\n\t\t\t\"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 24 24\\\" width=\\\"16\\\" height=\\\"16\\\">\",\n\t\t\t\"<path fill=\\\"currentColor\\\" fill-rule=\\\"evenodd\\\" d=\\\"\",\n\t\t\t\"M12 2.6a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 1.7a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z\",\n\t\t\t\"M6.6 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z\",\n\t\t\t\"M17.4 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z\",\n\t\t\t\"\\\"/>\",\n\t\t\t\"<path fill=\\\"none\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"1.7\\\" stroke-linecap=\\\"round\\\"\",\n\t\t\t\" d=\\\"M4.4 17.2a8.6 8.6 0 0 0 15.2 0\\\" stroke-dasharray=\\\"2.6 2.2\\\"/>\",\n\t\t\t\"</svg>\"\n\t\t].join(\"\");\n\t\t/**\n\t\t* The same artwork as a `mask-image` URL.\n\t\t*\n\t\t* `encodeURIComponent` keeps the `#`-free markup safe inside a `url(\"…\")` in a\n\t\t* stylesheet, and `currentColor` is resolved by the mask's own element rather\n\t\t* than by the SVG, so the glyph follows the theme.\n\t\t*/\n\t\tconst POOL_NAV_ICON_MASK_URL = `data:image/svg+xml;utf8,${encodeURIComponent(POOL_NAV_ICON_SVG)}`;\n\t\t//#endregion\n\t\t//#region src/client/locales.ts\n\t\t/**\n\t\t* Plugin-card copy registered under the `settings.workbuddy-xdpool` locale\n\t\t* namespace. Key lists in `en` and `zh` are kept 1:1 by typing `zh` against\n\t\t* the key set of `en`.\n\t\t*\n\t\t* @module dsh-workbuddy-xdpool/client/locales\n\t\t*/\n\t\tconst en = {\n\t\t\t\"row.navLabel\": \"XD Pool\",\n\t\t\t\"row.title\": \"WorkBuddy XD Pool (dsh-workbuddy-xdpool)\",\n\t\t\t\"row.desc\": \"Route every WorkBuddy sign-in on this machine into DSH as one auto-failing-over model pool.\",\n\t\t\t\"row.expand\": \"Expand\",\n\t\t\t\"row.collapse\": \"Collapse\",\n\t\t\t\"row.requestFailed\": \"Request failed\",\n\t\t\t\"row.poolEmpty\": \"No WorkBuddy account discovered yet.\",\n\t\t\t\"row.poolEmptyHint\": \"Sign in to one or more WorkBuddy accounts in the WorkBuddy desktop app, then click “Detect accounts again”. Each sign-in is picked up automatically as a pool member.\",\n\t\t\t\"row.regionEmpty\": \"No account signed in for this region yet.\",\n\t\t\t\"row.regionEmptyHint\": \"Sign in to a WorkBuddy account for this region in the desktop app, then choose “Detect accounts again”. Domestic and international accounts can be signed in side by side.\",\n\t\t\t\"row.regionEmptyTitle\": \"No {region} account is signed in yet.\",\n\t\t\t\"row.regionHowToTitle\": \"How to sign in to the {region} version\",\n\t\t\t\"row.regionHowTo1\": \"Download and install the {region} client: the international build is named WorkBuddy AI while the domestic one is WorkBuddy, and they are different apps. The web version at https://www.workbuddy.ai/ also works.\",\n\t\t\t\"row.regionHowTo2\": \"Pick a sign-in method: email sign-up / sign-in (most common), OAuth with Google, GitHub or X, or WeChat QR scan on some builds.\",\n\t\t\t\"row.regionHowTo3\": \"Make sure this machine can reach overseas sites when signing in: the international version targets users outside mainland China and may fail to load behind a restricted network.\",\n\t\t\t\"row.regionHowTo4\": \"Back here, press the re-detect button. Every sign-in the client has left on this machine is absorbed into its own region - the two sides stay separate and can run at the same time.\",\n\t\t\t\"row.regionHowToNote\": \"The two versions keep separate accounts, credits and data: a domestic account cannot sign in to the international one, and vice versa, so each needs its own registration. This plugin only reads the sign-ins the client has already performed.\",\n\t\t\t\"row.shimStopped\": \"Provider loopback is not running.\",\n\t\t\t\"row.shimRunning\": \"Provider listening on loopback\",\n\t\t\t\"row.accountsTitle\": \"Accounts in the pool\",\n\t\t\t\"row.tabCn\": \"国内版\",\n\t\t\t\"row.tabGlobal\": \"国际版\",\n\t\t\t\"row.tabHint\": \"每个 tab 是一个独立供应商，各有自己的账号、积分与模型；两边同时生效，一侧的改动不影响另一侧。\",\n\t\t\t\"row.accountsSummary\": \"{count} account(s) · {cooling} cooling\",\n\t\t\t\"row.ok\": \"Healthy — requests auto-rotate across accounts\",\n\t\t\t\"row.allCooling\": \"Every account is rate-limited right now; requests pause until a cooldown lifts.\",\n\t\t\t\"row.accountInRotation\": \"Enabled\",\n\t\t\t\"row.accountOff\": \"Disabled\",\n\t\t\t\"row.accountToggleHint\": \"Enable this account (uncheck to keep it out of the pool)\",\n\t\t\t\"row.accountToggleError\": \"Could not switch the account: {message}\",\n\t\t\t\"row.accountIgnore\": \"Remove\",\n\t\t\t\"row.accountIgnoreHint\": \"Remove this account from the pool for good — its credential stops being read and it will not come back\",\n\t\t\t\"row.accountIgnoreError\": \"Could not change the ignore list: {message}\",\n\t\t\t\"row.ignoredTitle\": \"Removed accounts\",\n\t\t\t\"row.ignoredSummary\": \"{count} account(s) no longer in the pool\",\n\t\t\t\"row.ignoredRestore\": \"Restore\",\n\t\t\t\"row.ignoredRestoreHint\": \"Put this account back into the pool\",\n\t\t\t\"row.currentAccount\": \"In use now\",\n\t\t\t\"row.currentAccountDisabled\": \"switched off — the next request moves on\",\n\t\t\t\"row.cooling\": \"Cooling (rate-limited)\",\n\t\t\t\"row.cooldownHits\": \"{hits} hit(s)\",\n\t\t\t\"row.cooldownUntil\": \"until {time}\",\n\t\t\t\"row.modelCooling\": \"{model} cooling until {time}\",\n\t\t\t\"row.tokenExpiry\": \"token {time}\",\n\t\t\t\"row.creditsTotal\": \"Total\",\n\t\t\t\"row.creditsPackages\": \"Credit packages\",\n\t\t\t\"row.creditsPackage\": \"{remain} / {size}\",\n\t\t\t\"row.creditsError\": \"credits unavailable\",\n\t\t\t\"row.creditsSoon\": \"Expiring in 3 days\",\n\t\t\t\"row.creditsExpiresAt\": \"Expires {time}\",\n\t\t\t\"row.creditsExpiresSoonTitle\": \"Expiring within 3 days\",\n\t\t\t\"row.creditsRefreshAt\": \"Refreshes {time}\",\n\t\t\t\"row.checkinTitle\": \"Daily check-in\",\n\t\t\t\"row.checkinClaim\": \"Check in\",\n\t\t\t\"row.checkinClaiming\": \"Checking in…\",\n\t\t\t\"row.checkinClaimed\": \"Checked in today\",\n\t\t\t\"row.checkinInactive\": \"Check-in not available for this account\",\n\t\t\t\"row.checkinStreak\": \"{days}-day streak\",\n\t\t\t\"row.checkinDaily\": \"+{credit} credits/day\",\n\t\t\t\"row.checkinStreakBonus\": \"day {days} bonus +{credit}\",\n\t\t\t\"row.checkinClaimedReward\": \"Claimed +{credit} credits\",\n\t\t\t\"row.checkinError\": \"Check-in failed: {message}\",\n\t\t\t\"row.checkinAllHint\": \"Collect every account’s daily reward here — no need to switch accounts first.\",\n\t\t\t\"row.modelsTitle\": \"Models\",\n\t\t\t\"row.modelsSummary\": \"{count} model(s) in the live catalog\",\n\t\t\t\"row.modelsHint\": \"Read from the live WorkBuddy catalog. Free tiers are marked.\",\n\t\t\t\"row.modelEnabled\": \"Enabled\",\n\t\t\t\"row.modelImage\": \"Image input\",\n\t\t\t\"row.modelContextBudget\": \"Context window\",\n\t\t\t\"row.modelContextNative\": \"{size} (max)\",\n\t\t\t\"row.modelContextCapped\": \"{size}\",\n\t\t\t\"row.modelOutput\": \"Output {size}\",\n\t\t\t\"row.modelReasoning\": \"Thinking: {efforts}\",\n\t\t\t\"row.modelReasoningHint\": \"The thinking level is chosen in the host’s own model picker\",\n\t\t\t\"row.modelMaxMode\": \"Max mode\",\n\t\t\t\"row.modelMaxModeHint\": \"Give every model its full context window and strongest thinking level\",\n\t\t\t\"row.modelsEnabledCount\": \"{enabled} / {total} enabled\",\n\t\t\t\"row.modelsSave\": \"Save\",\n\t\t\t\"row.modelsSaving\": \"Saving…\",\n\t\t\t\"row.modelsDiscard\": \"Discard\",\n\t\t\t\"row.modelsSaved\": \"Model selection saved\",\n\t\t\t\"row.modelsSaveError\": \"Could not save: {message}\",\n\t\t\t\"row.modelsEmpty\": \"No model enabled — enable at least one before saving.\",\n\t\t\t\"row.free\": \"free\",\n\t\t\t\"row.limitedFree\": \"limited free\",\n\t\t\t\"row.nightDiscount\": \"night\",\n\t\t\t\"row.imageCapable\": \"image input\",\n\t\t\t\"row.rate\": \"{rate}x credits\",\n\t\t\t\"row.accountsRescan\": \"Detect accounts again\",\n\t\t\t\"row.accountsScanning\": \"Detecting…\",\n\t\t\t\"row.distTitle\": \"Account usage\",\n\t\t\t\"row.distPriority\": \"Priority\",\n\t\t\t\"row.distPriorityHint\": \"Use one account until it runs out, then move to the next\",\n\t\t\t\"row.distRoundRobin\": \"Round-robin\",\n\t\t\t\"row.distRoundRobinHint\": \"Take turns in order, spreading the spend evenly\",\n\t\t\t\"row.distBalanced\": \"Balanced\",\n\t\t\t\"row.distBalancedHint\": \"Draw at random, favouring the account idle longest\",\n\t\t\t\"row.resetCooldowns\": \"Clear all cooldowns\",\n\t\t\t\"row.resetCooldownsBusy\": \"Clearing…\",\n\t\t\t\"row.resetCooldownsDone\": \"Cooldowns cleared\",\n\t\t\t\"row.accountsRescanned\": \"Detected {count} account(s)\",\n\t\t\t\"row.error\": \"Pool status unavailable: {message}\",\n\t\t\t\"row.autoTitle\": \"Automation\",\n\t\t\t\"row.autoOn\": \"On\",\n\t\t\t\"row.autoOff\": \"Off\",\n\t\t\t\"row.autoBusy\": \"Saving…\",\n\t\t\t\"row.autoHintOn\": \"Checks in, reports activity, claims task and streak rewards, and runs the buddy trip — every day.\",\n\t\t\t\"row.autoHintOff\": \"Off: no background requests are made for you.\",\n\t\t\t\"row.autoJob_report\": \"Activity report\",\n\t\t\t\"row.autoJob_tasks\": \"Task rewards\",\n\t\t\t\"row.autoJob_checkin\": \"Daily check-in\",\n\t\t\t\"row.autoJob_streak\": \"Streak bonus\",\n\t\t\t\"row.autoJob_travel\": \"Buddy trip\",\n\t\t\t\"row.autoHourNone\": \"skipped today\",\n\t\t\t\"row.autoNever\": \"not run yet\",\n\t\t\t\"row.autoRun\": \"Run now\",\n\t\t\t\"row.autoRunning\": \"Running…\",\n\t\t\t\"row.autoRan\": \"Done: {count} account(s) ok, {failed} failed\",\n\t\t\t\"row.autoRanTasks\": \"Done: {claimed} task(s) claimed, +{credit} credits, +{energy} energy\",\n\t\t\t\"row.reserveTitle\": \"Keep at least\",\n\t\t\t\"row.reserveUnit\": \"credits\",\n\t\t\t\"row.reserveSaving\": \"Saving…\",\n\t\t\t\"row.reserveSave\": \"Save\",\n\t\t\t\"row.reserveHolding\": \"Reserved: skipped\",\n\t\t\t\"row.reserveSaved\": \"Keeping {credits} credits\",\n\t\t\t\"row.reserveCleared\": \"Reserve cleared\",\n\t\t\t\"row.reserveFailed\": \"Not saved — try again\",\n\t\t\t\"row.autoToday\": \"Today\",\n\t\t\t\"row.autoEarned\": \"Automation today\",\n\t\t\t\"row.autoEnergy\": \"energy\",\n\t\t\t\"row.autoTasksClaimed\": \"{count} task(s)\",\n\t\t\t\"row.autoRunAll\": \"Run now\",\n\t\t\t\"row.autoRunDone\": \"Automation pass finished\",\n\t\t\t\"row.autoRunTimeout\": \"Still running; check back in a moment\",\n\t\t\t\"row.autoAlreadyRunning\": \"A run is already in progress\",\n\t\t\t\"row.autoRanAll\": \"Ran {jobs} job(s), {ok} ok, {failed} failed\",\n\t\t\t\"row.autoFromTasks\": \"Tasks +{credit} credits · +{energy} energy · {count} task(s)\",\n\t\t\t\"row.autoFromCheckin\": \"Check-in +{credit} credits\",\n\t\t\t\"row.autoFromBonus\": \"Streak bonus +{credit} credits\",\n\t\t\t\"row.autoFromTravel\": \"Buddy travel +{credit} credits\"\n\t\t};\n\t\tconst zh = {\n\t\t\t\"row.navLabel\": \"XD Pool\",\n\t\t\t\"row.title\": \"WorkBuddy 池（dsh-workbuddy-xdpool）\",\n\t\t\t\"row.desc\": \"把本机所有已登录的 WorkBuddy 账号并入 DSH，作为一个自动容错的模型池使用。\",\n\t\t\t\"row.expand\": \"展开\",\n\t\t\t\"row.collapse\": \"收起\",\n\t\t\t\"row.requestFailed\": \"请求失败\",\n\t\t\t\"row.poolEmpty\": \"还没有发现任何 WorkBuddy 账号。\",\n\t\t\t\"row.poolEmptyHint\": \"先在 WorkBuddy 桌面 App 里登录一个或多个 WorkBuddy 账号，再点“重新检测账号”。每次登录都会被自动纳入池中。\",\n\t\t\t\"row.regionEmpty\": \"这边还没有登录账号。\",\n\t\t\t\"row.regionEmptyHint\": \"在 WorkBuddy 桌面 App 里登录一个该区域的账号，再点「重新检测账号」。国内版与国际版可以同时登录，两边各自独立。\",\n\t\t\t\"row.regionEmptyTitle\": \"这边还没有登录{region}账号。\",\n\t\t\t\"row.regionHowToTitle\": \"{region}怎么登录\",\n\t\t\t\"row.regionHowTo1\": \"下载并安装{region}客户端：国际版安装包名称是「WorkBuddy AI」，国内版是「WorkBuddy」，两者是不同的应用。也可以直接用网页版 https://www.workbuddy.ai/ 登录。\",\n\t\t\t\"row.regionHowTo2\": \"登录方式（任选其一）：① 邮箱注册/登录（最常用）；② 用 Google、GitHub、X 等海外账号授权登录；③ 部分版本支持微信扫码。\",\n\t\t\t\"row.regionHowTo3\": \"登录时请确保能正常访问海外站点（国际版面向海外用户，网络受限时可能打不开或登录失败）。\",\n\t\t\t\"row.regionHowTo4\": \"回到这里点「重新检测账号」。App 在本机留下的每次登录都会被自动吸收到各自区域 —— 两边互相独立，可以同时使用。\",\n\t\t\t\"row.regionHowToNote\": \"国内版与国际版的账号、积分、数据体系完全隔离，互不相通：国内版账号无法登录国际版，反之亦然，需要各自单独注册。本插件只读取客户端已完成的登录，不会代替你登录。\",\n\t\t\t\"row.shimStopped\": \"回环提供端未运行。\",\n\t\t\t\"row.shimRunning\": \"提供端正在回环地址监听\",\n\t\t\t\"row.accountsTitle\": \"池中账号\",\n\t\t\t\"row.tabCn\": \"国内版\",\n\t\t\t\"row.tabGlobal\": \"国际版\",\n\t\t\t\"row.tabHint\": \"每个 tab 是一个独立供应商，各有自己的账号、积分与模型；两边同时生效，一侧的改动不影响另一侧。\",\n\t\t\t\"row.accountsSummary\": \"{count} 个账号 · {cooling} 个冷却中\",\n\t\t\t\"row.ok\": \"运行健康 —— 请求会在各账号间自动轮换\",\n\t\t\t\"row.allCooling\": \"当前所有账号都处于限流冷却，请求会暂停直到某个冷却结束。\",\n\t\t\t\"row.accountInRotation\": \"已启用\",\n\t\t\t\"row.accountOff\": \"已停用\",\n\t\t\t\"row.accountToggleHint\": \"启用该账号（取消勾选则不参与池子）\",\n\t\t\t\"row.accountToggleError\": \"切换账号失败：{message}\",\n\t\t\t\"row.accountIgnore\": \"移出池子\",\n\t\t\t\"row.accountIgnoreHint\": \"把这个账号永久移出池子 —— 不再读取它的凭据，即使重新登录也不会回来\",\n\t\t\t\"row.accountIgnoreError\": \"修改忽略列表失败：{message}\",\n\t\t\t\"row.ignoredTitle\": \"已移出的账号\",\n\t\t\t\"row.ignoredSummary\": \"{count} 个账号已不在池中\",\n\t\t\t\"row.ignoredRestore\": \"恢复\",\n\t\t\t\"row.ignoredRestoreHint\": \"把这个账号放回池子\",\n\t\t\t\"row.currentAccount\": \"当前使用\",\n\t\t\t\"row.currentAccountDisabled\": \"已停用 —— 下次请求会换号\",\n\t\t\t\"row.cooling\": \"冷却中（被限流）\",\n\t\t\t\"row.cooldownHits\": \"触发 {hits} 次\",\n\t\t\t\"row.cooldownUntil\": \"至 {time}\",\n\t\t\t\"row.modelCooling\": \"{model} 冷却至 {time}\",\n\t\t\t\"row.tokenExpiry\": \"令牌 {time}\",\n\t\t\t\"row.creditsTotal\": \"合计\",\n\t\t\t\"row.creditsPackages\": \"积分包\",\n\t\t\t\"row.creditsPackage\": \"{remain} / {size}\",\n\t\t\t\"row.creditsError\": \"积分不可用\",\n\t\t\t\"row.creditsSoon\": \"3 天内到期\",\n\t\t\t\"row.creditsExpiresAt\": \"到期 {time}\",\n\t\t\t\"row.creditsExpiresSoonTitle\": \"3 天内到期\",\n\t\t\t\"row.creditsRefreshAt\": \"刷新 {time}\",\n\t\t\t\"row.checkinTitle\": \"每日签到\",\n\t\t\t\"row.checkinClaim\": \"签到\",\n\t\t\t\"row.checkinClaiming\": \"签到中…\",\n\t\t\t\"row.checkinClaimed\": \"今日已签到\",\n\t\t\t\"row.checkinInactive\": \"该账号当前无签到活动\",\n\t\t\t\"row.checkinStreak\": \"连签 {days} 天\",\n\t\t\t\"row.checkinDaily\": \"每日 +{credit} 积分\",\n\t\t\t\"row.checkinStreakBonus\": \"第 {days} 天额外 +{credit}\",\n\t\t\t\"row.checkinClaimedReward\": \"已领取 +{credit} 积分\",\n\t\t\t\"row.checkinError\": \"签到失败：{message}\",\n\t\t\t\"row.checkinAllHint\": \"这里可以为每个账号分别领取每日签到奖励，无需先切换账号。\",\n\t\t\t\"row.modelsTitle\": \"模型\",\n\t\t\t\"row.modelsSummary\": \"实时目录中 {count} 个模型\",\n\t\t\t\"row.modelsHint\": \"读取自 WorkBuddy 实时目录；免费档位已标注。\",\n\t\t\t\"row.modelEnabled\": \"启用\",\n\t\t\t\"row.modelImage\": \"图片输入\",\n\t\t\t\"row.modelContextBudget\": \"上下文窗口\",\n\t\t\t\"row.modelContextNative\": \"{size}（最大）\",\n\t\t\t\"row.modelContextCapped\": \"{size}\",\n\t\t\t\"row.modelOutput\": \"输出 {size}\",\n\t\t\t\"row.modelReasoning\": \"思考档位：{efforts}\",\n\t\t\t\"row.modelReasoningHint\": \"思考强度在宿主自带的模型选择器里调整\",\n\t\t\t\"row.modelMaxMode\": \"Max 模式\",\n\t\t\t\"row.modelMaxModeHint\": \"让每个模型都用满上下文窗口与最强思考档位\",\n\t\t\t\"row.modelsEnabledCount\": \"已启用 {enabled} / {total}\",\n\t\t\t\"row.modelsSave\": \"保存\",\n\t\t\t\"row.modelsSaving\": \"保存中…\",\n\t\t\t\"row.modelsDiscard\": \"放弃修改\",\n\t\t\t\"row.modelsSaved\": \"模型选择已保存\",\n\t\t\t\"row.modelsSaveError\": \"保存失败：{message}\",\n\t\t\t\"row.modelsEmpty\": \"至少要启用一个模型才能保存。\",\n\t\t\t\"row.free\": \"免费\",\n\t\t\t\"row.limitedFree\": \"限量免费\",\n\t\t\t\"row.nightDiscount\": \"夜间\",\n\t\t\t\"row.imageCapable\": \"图片输入\",\n\t\t\t\"row.rate\": \"{rate}x 积分\",\n\t\t\t\"row.accountsRescan\": \"重新检测账号\",\n\t\t\t\"row.accountsScanning\": \"正在检测…\",\n\t\t\t\"row.distTitle\": \"账号使用方式\",\n\t\t\t\"row.distPriority\": \"优先模式\",\n\t\t\t\"row.distPriorityHint\": \"先用完一个账号，用完再换下一个\",\n\t\t\t\"row.distRoundRobin\": \"轮换模式\",\n\t\t\t\"row.distRoundRobinHint\": \"按顺序轮流使用，积分均匀分摊\",\n\t\t\t\"row.distBalanced\": \"均衡模式\",\n\t\t\t\"row.distBalancedHint\": \"随机抽取，闲置越久的账号被选中概率越高\",\n\t\t\t\"row.resetCooldowns\": \"清除所有冷却\",\n\t\t\t\"row.resetCooldownsBusy\": \"正在清除…\",\n\t\t\t\"row.resetCooldownsDone\": \"冷却已清除\",\n\t\t\t\"row.accountsRescanned\": \"检测到 {count} 个账号\",\n\t\t\t\"row.error\": \"池状态不可用：{message}\",\n\t\t\t\"row.autoTitle\": \"积分自动化\",\n\t\t\t\"row.autoOn\": \"已开启\",\n\t\t\t\"row.autoOff\": \"已关闭\",\n\t\t\t\"row.autoBusy\": \"保存中…\",\n\t\t\t\"row.autoHintOn\": \"每天自动签到、上报活跃、领取任务奖励与连登奖励，并照看猫猫旅行。\",\n\t\t\t\"row.autoHintOff\": \"已关闭：不会替你发起任何后台请求。\",\n\t\t\t\"row.autoJob_report\": \"活跃上报\",\n\t\t\t\"row.autoJob_tasks\": \"任务奖励\",\n\t\t\t\"row.autoJob_checkin\": \"每日签到\",\n\t\t\t\"row.autoJob_streak\": \"连登奖励\",\n\t\t\t\"row.autoJob_travel\": \"猫猫旅行\",\n\t\t\t\"row.autoHourNone\": \"当天不跑\",\n\t\t\t\"row.autoNever\": \"还没跑过\",\n\t\t\t\"row.autoRun\": \"立即运行\",\n\t\t\t\"row.autoRunning\": \"运行中…\",\n\t\t\t\"row.autoRan\": \"完成：{count} 个账号正常，{failed} 个失败\",\n\t\t\t\"row.autoRanTasks\": \"完成：领取 {claimed} 个任务，+{credit} 积分，+{energy} 能量\",\n\t\t\t\"row.reserveTitle\": \"保留积分\",\n\t\t\t\"row.reserveUnit\": \"积分\",\n\t\t\t\"row.reserveSaving\": \"保存中…\",\n\t\t\t\"row.reserveSave\": \"保存\",\n\t\t\t\"row.reserveHolding\": \"已保留·暂停使用\",\n\t\t\t\"row.reserveSaved\": \"已保留 {credits} 积分\",\n\t\t\t\"row.reserveCleared\": \"已取消保留\",\n\t\t\t\"row.reserveFailed\": \"保存失败，请重试\",\n\t\t\t\"row.autoToday\": \"今日自动化\",\n\t\t\t\"row.autoEarned\": \"今日自动化获得\",\n\t\t\t\"row.autoEnergy\": \"能量\",\n\t\t\t\"row.autoTasksClaimed\": \"{count} 个任务\",\n\t\t\t\"row.autoRunAll\": \"立即运行\",\n\t\t\t\"row.autoRunDone\": \"自动化已执行完成\",\n\t\t\t\"row.autoRunTimeout\": \"仍在执行中，稍后查看结果\",\n\t\t\t\"row.autoAlreadyRunning\": \"已有一次执行正在进行\",\n\t\t\t\"row.autoRanAll\": \"已运行 {jobs} 项，{ok} 个正常，{failed} 个失败\",\n\t\t\t\"row.autoFromTasks\": \"任务 +{credit} 积分 · +{energy} 能量 · {count} 个\",\n\t\t\t\"row.autoFromCheckin\": \"签到 +{credit} 积分\",\n\t\t\t\"row.autoFromBonus\": \"连登奖励 +{credit} 积分\",\n\t\t\t\"row.autoFromTravel\": \"猫猫旅行 +{credit} 积分\"\n\t\t};\n\t\t//#endregion\n\t\t//#region src/client/index.tsx\n\t\t/** Stable browser-plugin name. */\n\t\tconst name = \"dsh-workbuddy-xdpool-client\";\n\t\t/**\n\t\t* Client services required by the settings page.\n\t\t*\n\t\t* Deliberately only the two services present on BOTH host lines. The settings\n\t\t* surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7 replaces it\n\t\t* with `configForms` — and cordis' dependency gate is hard: any inject entry the\n\t\t* running line does not provide keeps `apply` from ever running. Probing the one\n\t\t* that exists through `ctx.get()` (which returns undefined, never throws, for an\n\t\t* absent service) is what lets one build serve both lines.\n\t\t*/\n\t\tconst inject = [\"slots\", \"locale\"];\n\t\t/** Settings namespace the host-side section registers (shared with the entry). */\n\t\tconst WORKBUDDY_POOL_SETTINGS_NS = \"workbuddy-xdpool\";\n\t\t/**\n\t\t* Host plugin entry id this bundle is mounted under in `cordis.patch.yml`.\n\t\t*\n\t\t* `configForms` is addressed by this id on the 0.1.7 line.\n\t\t*/\n\t\tconst WORKBUDDY_POOL_ENTRY_ID = \"llm-workbuddy-xdpool\";\n\t\t/** Register card copy and the pool page under Settings. */\n\t\tfunction apply(ctx) {\n\t\t\ttry {\n\t\t\t\tconst namespace = \"settings.workbuddy-xdpool\";\n\t\t\t\tctx.effect(() => ctx.locale.register(namespace, {\n\t\t\t\t\tzh,\n\t\t\t\t\ten\n\t\t\t\t}), \"dsh-workbuddy-xdpool: settings copy\");\n\t\t\t\tconst t = ctx.locale.bind(namespace);\n\t\t\t\tconst softGet = (serviceName) => ctx.get(serviceName);\n\t\t\t\tconst settingsScope = resolveSettingsScope(softGet);\n\t\t\t\tctx.slots.inject(\"settings.section\", () => ctx.slots.register({\n\t\t\t\t\tname: \"settings.section\",\n\t\t\t\t\tid: \"workbuddy-xdpool\",\n\t\t\t\t\torder: 440,\n\t\t\t\t\tlabel: () => t(\"row.navLabel\"),\n\t\t\t\t\tinject: () => settingsScope === void 0 ? { t } : {\n\t\t\t\t\t\tt,\n\t\t\t\t\t\tsettingsScope\n\t\t\t\t\t}\n\t\t\t\t}, PoolCard));\n\t\t\t\tinstallNavIcon(ctx, () => t(\"row.navLabel\"));\n\t\t\t} catch (error) {\n\t\t\t\tconsole.error(\"[dsh-workbuddy-xdpool] client page failed to load (host provider unaffected):\", error);\n\t\t\t}\n\t\t}\n\t\t/** Attribute carrying the nav-row marker this module installs. */\n\t\tconst NAV_ICON_MARKER = \"data-dsh-xdpool-nav-icon\";\n\t\t/**\n\t\t* The settings nav rows, as the shell renders them. Scoped to the settings\n\t\t* dialog on purpose: the main sidebar has its own nav, and matching rows there\n\t\t* would stamp this glyph onto an unrelated control.\n\t\t*/\n\t\tconst NAV_ROW_SELECTOR = \"[role=\\\"dialog\\\"] nav button\";\n\t\t/**\n\t\t* Draw this page's own glyph in its Settings nav row.\n\t\t*\n\t\t* The `settings.section` contract carries no icon: the shell decides the glyph\n\t\t* from the section id and falls back to a gear for anything it does not know.\n\t\t* So the row is matched by its LABEL (the same thunk passed to the\n\t\t* registration, re-read on every pass so a locale switch is followed) and\n\t\t* marked; CSS then hides the shell svg and masks this artwork into the row.\n\t\t*\n\t\t* Re-scanned on DOM mutations because the shell re-renders the nav on locale\n\t\t* and theme changes, which replaces the row elements and drops the marker.\n\t\t*\n\t\t* No-op off the browser (the node-side probe imports this module for types).\n\t\t*/\n\t\tfunction installNavIcon(ctx, resolveLabel) {\n\t\t\tif (typeof document === \"undefined\") return;\n\t\t\tctx.effect(() => {\n\t\t\t\tconst tag = document.createElement(\"style\");\n\t\t\t\ttag.dataset.plugin = \"dsh-workbuddy-xdpool\";\n\t\t\t\ttag.dataset.pluginCss = \"dsh-workbuddy-xdpool/settings-nav-icon\";\n\t\t\t\ttag.textContent = [\n\t\t\t\t\t`[${NAV_ICON_MARKER}] > svg { display: none; }`,\n\t\t\t\t\t`[${NAV_ICON_MARKER}]::before {`,\n\t\t\t\t\t\"  content: '';\",\n\t\t\t\t\t\"  flex: none;\",\n\t\t\t\t\t\"  width: 16px;\",\n\t\t\t\t\t\"  height: 16px;\",\n\t\t\t\t\t\"  background-color: currentColor;\",\n\t\t\t\t\t`  -webkit-mask-image: url(\"${POOL_NAV_ICON_MASK_URL}\");`,\n\t\t\t\t\t`  mask-image: url(\"${POOL_NAV_ICON_MASK_URL}\");`,\n\t\t\t\t\t\"  -webkit-mask-repeat: no-repeat;\",\n\t\t\t\t\t\"  mask-repeat: no-repeat;\",\n\t\t\t\t\t\"  -webkit-mask-position: center;\",\n\t\t\t\t\t\"  mask-position: center;\",\n\t\t\t\t\t\"  -webkit-mask-size: 16px 16px;\",\n\t\t\t\t\t\"  mask-size: 16px 16px;\",\n\t\t\t\t\t\"}\"\n\t\t\t\t].join(\"\\n\");\n\t\t\t\tdocument.head.appendChild(tag);\n\t\t\t\tlet disposed = false;\n\t\t\t\tlet scheduled = false;\n\t\t\t\tconst sync = () => {\n\t\t\t\t\tscheduled = false;\n\t\t\t\t\tif (disposed) return;\n\t\t\t\t\tconst wanted = String(resolveLabel() ?? \"\").trim();\n\t\t\t\t\tif (wanted === \"\") return;\n\t\t\t\t\tfor (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) if (String(row.textContent ?? \"\").trim() === wanted) row.setAttribute(NAV_ICON_MARKER, \"\");\n\t\t\t\t\telse row.removeAttribute(NAV_ICON_MARKER);\n\t\t\t\t};\n\t\t\t\tconst schedule = () => {\n\t\t\t\t\tif (scheduled || disposed) return;\n\t\t\t\t\tscheduled = true;\n\t\t\t\t\tqueueMicrotask(sync);\n\t\t\t\t};\n\t\t\t\tsync();\n\t\t\t\tconst observer = new MutationObserver(schedule);\n\t\t\t\tobserver.observe(document.body, {\n\t\t\t\t\tchildList: true,\n\t\t\t\t\tsubtree: true,\n\t\t\t\t\tcharacterData: true\n\t\t\t\t});\n\t\t\t\treturn () => {\n\t\t\t\t\tdisposed = true;\n\t\t\t\t\tobserver.disconnect();\n\t\t\t\t\tfor (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER);\n\t\t\t\t\ttag.remove();\n\t\t\t\t};\n\t\t\t}, \"dsh-workbuddy-xdpool: settings nav icon\");\n\t\t}\n\t\t/**\n\t\t* Bind the settings form the card reads and writes, on whichever line is\n\t\t* running.\n\t\t*\n\t\t* 0.1.7 exposes `configForms.get(entryId)`, keyed by the HOST plugin entry id —\n\t\t* the id this bundle registers under in `cordis.patch.yml`, not the settings\n\t\t* namespace. 0.1.5 exposes `settingsScope.bind({ namespace })`, keyed by the\n\t\t* namespace the host-side `installSection` registered. Both controllers answer\n\t\t* the same two methods the card uses (`getSnapshot()`, `set(field, value)`), so\n\t\t* the card needs no per-line branch of its own.\n\t\t*\n\t\t* Returns undefined when neither service is present (a locked-down host): the\n\t\t* card then renders read-only, which is the documented degradation.\n\t\t*/\n\t\tfunction resolveSettingsScope(softGet) {\n\t\t\tconst forms = softGet(\"configForms\");\n\t\t\tif (forms !== void 0) {\n\t\t\t\tlet entryId = WORKBUDDY_POOL_ENTRY_ID;\n\t\t\t\ttry {\n\t\t\t\t\tconst namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];\n\t\t\t\t\tconst served = namespaces.find((entry) => entry.ns === WORKBUDDY_POOL_ENTRY_ID) ?? namespaces.find((entry) => /workbuddy-xdpool/.test(entry.ns));\n\t\t\t\t\tif (served !== void 0) entryId = served.ns;\n\t\t\t\t} catch {}\n\t\t\t\treturn forms.get(entryId);\n\t\t\t}\n\t\t\tconst scope = softGet(\"settingsScope\");\n\t\t\tif (scope !== void 0) return scope.bind({ namespace: WORKBUDDY_POOL_SETTINGS_NS });\n\t\t}\n\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\texports.name = name;\n\t\treturn module.exports;\n\t}\n});\n";
//#endregion GENERATED: xdpool client source

//#region BEGIN GENERATED: console page source
// 本块由 scripts/gen-console-inline.mjs 生成，请勿手改。
// 内容：lib/console.mjs —— 管理页组件（XD Pool / Trae 配置 / 账号 / 积分 / 使用记录）。
// 它是 ES 模块，但此处以**真函数**内联（不是字符串 + eval）：
// client.js 是 classic script 不能顶层 import，而 eval 可能被 CSP 拒绝。
// 改界面请改 lib/console.mjs 后重跑生成脚本；apply.sh 会校验是否同步。
const __WBC_CONSOLE_FACTORY__ = (react, jsxRuntime, embedded) => {
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
  function createConsoleSection({ react, jsxRuntime, embedded }) {
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
                        children: `已启用 ${enabledCount} / ${models.length}`,
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
                        disabled: !writable || busy === 'models' || enabledCount === 0,
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


  return createConsoleSection({ react, jsxRuntime, embedded });
};
//#endregion GENERATED: console page source


// —— 本包装模块 ——
//
// 把上面两段 vendored 的客户端（WorkBuddy 账号池卡片 + Trae 卡片）与
// 本插件自己的六标签页并进同一个 bundle。
//
// 保留内联注入的原因：两个 vendored 客户端都是
// `window.__ModuleLoader__.load({id, factory})` 形态的自注册脚本，
// 内联执行可以只注册一次、顺序可控，且 vendored 代码一行都不用改
// （便于日后对照上游升级）。
//
// 注意注册 id：本 bundle 用**合并后的包名** dsh-wotr-console 注册，
// 因为 client-modules 是按包名建表、按包名 require 的；两个 vendored 脚本
// 各自声明的 id 由下面的替身加载器捕获，不会真的注册进模块表。
window.__ModuleLoader__.load({
  id: 'dsh-wotr-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 与 package.json 的 name 一致；cordis 用它定位模块 */
    const pkgName = 'dsh-wotr-console';

    // React 运行时：管理页组件要用。
    //
    // **必须在这里显式取**：wrapper 的 factory 只拿到 `require`，
    // 没有现成的 react 变量。早先版本直接引用未声明的 `react`，
    // 结果在 apply 里抛 ReferenceError —— 而求值实参发生在进入函数体之前，
    // 内层 try/catch 根本拦不住，于是 apply 抛出、fiber 变 failed，
    // 宿主直接判「应用无法启动」。取不到就置 null，管理页静默降级，
    // 绝不影响账号池卡片与整个启动流程。
    let react = null;
    let jsxRuntime = null;
    try {
      react = require('react');
      jsxRuntime = require('react/jsx-runtime');
    } catch (e) {
      console.error('[dsh-wotr-console] react runtime unavailable; management page disabled:', e);
    }

    /**
     * 内联执行一段 vendored 的自注册客户端源码，返回它 factory 的产物。
     *
     * 手法：临时把 window.__ModuleLoader__ 换成替身，替身的 load() 不注册
     * 模块表，而是直接调用被注册的 factory 并把 exports 捕获下来。
     * 于是 vendored 脚本「以为」自己正常注册了，实际产物落回我们手里。
     *
     * 替身只在同步执行期间挂着，finally 一定还原 —— 这是必须的：
     * vendored 脚本用 <script> 注入而非直接调用，异常路径必须也能还原，
     * 否则真正的模块加载器会被永久顶掉，整个 DSH 前端都起不来。
     *
     * 单个 vendored 脚本失败只让那一半降级（返回 null），绝不影响另一半
     * 与整个启动流程 —— 它们各自都是独立插件，没道理连坐。
     */
    function inlineVendoredClient(src, label) {
      const prev = window.__ModuleLoader__;
      let captured = null;
      try {
        window.__ModuleLoader__ = {
          load(def) {
            if (def && typeof def.factory === 'function') {
              try {
                const mod = def.factory(require);
                if (mod) captured = mod;
              } catch (e) {
                console.error('[dsh-wotr-console] ' + label + ' factory threw:', e);
              }
              return captured;
            }
            if (prev && typeof prev.load === 'function') return prev.load(def);
            return undefined;
          },
        };
        const el = document.createElement('script');
        el.textContent = src;
        document.head.appendChild(el);
      } catch (e) {
        console.error('[dsh-wotr-console] ' + label + ' inline failed:', e);
      } finally {
        window.__ModuleLoader__ = prev;
      }
      return captured;
    }

    const xdpoolClient = inlineVendoredClient(XDPOOL_CLIENT_SRC, 'xdpool client');

    /**
     * 合并后不再需要、且**必须**拦掉的 ctx.effect 标签。
     *
     * `installNavIcon` 给「XD Pool」那条**设置导航行**画自定义图标：它往
     * `document.body` 挂一个 `MutationObserver`（childList + subtree +
     * characterData），每次 DOM 变动都全页扫一遍 `[role="dialog"] nav button`
     * 找那条行。
     *
     * 合并后那条导航行**不存在了**（入口改叫 WOTR），于是它：
     *   - 永远匹配不到目标，纯做无用功；
     *   - 却仍然常驻监听整个应用 DOM，每次渲染/输入都触发一次全页扫描。
     *
     * 所以这个 effect 直接不装。它只影响那个已经不存在的图标，
     * 池卡片本体、文案、settings 作用域全都不经过它。
     */
    const DROPPED_EFFECT_LABELS = [/settings nav icon/];

    /**
     * WorkBuddy 池的设置命名空间与宿主入口 id。
     *
     * 与 vendored 客户端里的同名常量保持一致（刻意不改名）：
     *   - `WORKBUDDY_POOL_SETTINGS_NS` 是 0.1.5 那条线 `settingsScope.bind()`
     *     用的命名空间；
     *   - `WORKBUDDY_POOL_ENTRY_ID` 是 0.1.7 那条线 `configForms.get()` 的默认
     *     入口 id —— 也是本插件在 cordis.patch.yml 里的宿主入口名。
     */
    const WORKBUDDY_POOL_SETTINGS_NS = 'workbuddy-xdpool';
    const WORKBUDDY_POOL_ENTRY_ID = 'llm-workbuddy-xdpool';

    /**
     * 转发一段 vendored 客户端的 apply，但**拦掉它的设置卡片注册**。
     *
     * vendored 的 xdpool 客户端原本把 PoolCard 注册成独立设置入口
     * （`settings.section` id=workbuddy-xdpool）。合并后这个入口不该再单独出现
     * —— 配置收进「WOTR 管理」页的 XD Pool 标签页（本包自写的 PoolConfigTab）。
     * 但 vendored 源码一行都不能改（要能逐字节对照上游升级），所以这里给它一层
     * **替身 ctx**：把 `settings.section` 的 `register` 拦成空注册，其余槽位与
     * 服务原样转发；等价于「它以为自己注册成功了」，但我们不留下那个入口。
     *
     * 保留转发 apply 的理由：它顺带注册了 locale 文案
     * （`settings.workbuddy-xdpool`）并解析了自己的 settings 作用域。
     *
     * `ctx.effect` 中命中 DROPPED_EFFECT_LABELS 的按标签丢弃：`installNavIcon`
     * 给「XD Pool」那条**已不存在**的设置导航行画图标，却会常驻一个
     * MutationObserver 全页扫描，纯做无用功。
     *
     * 未被拦截的槽位原样转发给真正的 ctx，功能不受影响。
     */
    function forwardVendoredApply(ctx, vendoredClient, label) {
      if (vendoredClient === null || vendoredClient === undefined) return;

      const slots = ctx?.slots;
      const hasSlots = slots !== undefined && slots !== null && typeof slots.register === 'function';

      /**
       * 拦下 `settings.section` 注册（返回空 disposer，调用方照常 dispose）；
       * 其余槽位原样注册。
       */
      const swallowSectionRegister = (opts, Component) => {
        if (opts?.name === 'settings.section') return () => {};
        return slots.register(opts, Component);
      };

      const proxySlots = hasSlots
        ? new Proxy(slots, {
            get(target, prop) {
              if (prop === 'register') return swallowSectionRegister;
              const value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          })
        : undefined;

      /** 只放行需要的 effect；被丢弃的返回空 disposer，调用方照常 dispose */
      const proxyEffect = (fn, effectLabel) => {
        const name = String(effectLabel ?? '');
        if (DROPPED_EFFECT_LABELS.some((re) => re.test(name))) return () => {};
        return ctx.effect(fn, effectLabel);
      };

      const proxyCtx = new Proxy(ctx, {
        get(target, prop) {
          if (prop === 'slots' && proxySlots !== undefined) return proxySlots;
          if (prop === 'effect') return proxyEffect;
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      try {
        vendoredClient.apply?.(proxyCtx);
      } catch (e) {
        console.error('[dsh-wotr-console] ' + label + ' apply 失败（provider 不受影响）:', e);
      }
    }

    /**
     * 解析 WorkBuddy 池的 settings 作用域，包成给管理页的**活句柄**。
     *
     * XD Pool 的配置页是本包自写的（console.mjs 的 PoolConfigTab），不再嵌入
     * vendored 卡片，但它读写设置的**规则**必须与上游一致 —— 也就是
     * vendor/xdpool/lib/client.js 的 resolveSettingsScope：
     *
     *   1. 优先 `configForms`：命名空间从 describe() 镜像里找，先精确匹配宿主
     *      入口 id `llm-workbuddy-xdpool`，再退回 /workbuddy-xdpool/ 正则。
     *      不能写死 `workbuddy-xdpool`：宿主实际提供的命名空间常带包名前缀，
     *      绑到不存在的 ns 时每次写入都被拒，而控件照常亮着 —— 就是
     *      「保存了又弹回去」。
     *   2. 没有 configForms 就退回 0.1.5 那条线的
     *      `settingsScope.bind({ namespace: 'workbuddy-xdpool' })`。
     *   3. 都没有 → 作用域恒为只读（writable: false），页面显示诊断提示，
     *      而不是给出按不动却看似可用的控件。
     *
     * 包成活句柄的原因与 Trae 半边一致：解析可能在 apply 返回后才就绪，
     * 管理页必须在**渲染期**取值。
     */
    function resolveWorkbuddySettings(ctx) {
      const listeners = new Set();
      let currentScope = null;
      const notify = () => {
        for (const fn of [...listeners]) {
          try {
            fn();
          } catch (e) {
            console.error('[dsh-wotr-console] WorkBuddy settings 订阅者抛错:', e);
          }
        }
      };
      const handle = {
        get: () => currentScope,
        subscribe: (fn) => {
          if (typeof fn !== 'function') return () => {};
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      /** 找不到可写作用域时的只读替身：让页面显示诊断而不是假控件 */
      const readOnly = {
        getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false }),
        subscribe: () => () => {},
        set: () => Promise.resolve(false),
      };
      try {
        const softGet = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined);
        const forms = softGet('configForms');
        if (forms !== undefined) {
          let entryId = WORKBUDDY_POOL_ENTRY_ID;
          try {
            const namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
            const served =
              namespaces.find((entry) => entry.ns === WORKBUDDY_POOL_ENTRY_ID) ??
              namespaces.find((entry) => /workbuddy-xdpool/.test(entry.ns));
            if (served !== undefined) entryId = served.ns;
          } catch {
            /* 镜像还没就绪，用默认入口 id */
          }
          currentScope = forms.get(entryId) ?? readOnly;
          return handle;
        }
        const legacy = softGet('settingsScope');
        if (legacy !== undefined) {
          currentScope = legacy.bind({ namespace: WORKBUDDY_POOL_SETTINGS_NS }) ?? readOnly;
          return handle;
        }
        currentScope = readOnly;
        return handle;
      } catch (e) {
        console.error('[dsh-wotr-console] WorkBuddy settings 作用域解析失败（配置页将只读）:', e);
        currentScope = readOnly;
        return handle;
      }
    }

    /**
     * 解析 Trae 半边的 settings 作用域，包成给管理页的**活句柄**。
     *
     * Trae 的配置页是本包自写的（console.mjs 的 TraeConfigTab），不再走
     * vendored 卡片那一套，但它读写设置的**规则**必须与上游一致
     * （上游 dsh-connect-trae 的浏览器卡片就是这么解析的，见其 client 的
     * settingsScope 构造）：
     *
     *   1. 优先 `configForms.get(ns)`，ns 由 describe() 镜像里**匹配 /trae/i
     *      的那个**决定 —— 不能写死 `trae`。写死是上游踩过的实打实的坑：
     *      宿主实际提供的命名空间常常带包名前缀（`dsh-connect-trae`、
     *      `include:dsh-connect-trae`…），绑到不存在的 ns 时每次写入都被拒
     *      （`No configurable plugin entry "trae"`），而控件照常亮着，
     *      表现为「保存了又弹回去」。
     *   2. 镜像未就绪时**重新绑定**：describe 是异步的，且 profile 重载后可能
     *      多出启动时还不存在的命名空间，所以要订阅镜像变化。
     *   3. 没有 configForms 就退回 0.1.5 那条线的 `settingsScope.bind()`。
     *   4. 都没有 → 作用域恒为只读（writable: false），页面显示诊断提示，
     *      而不是给出按不动却看似可用的控件。
     *
     * 包成活句柄的原因与 XD Pool 卡片一致：解析是异步的，apply 返回时通常
     * 还没绑上，管理页必须在**渲染期**取值。
     */
    function resolveTraeSettings(ctx) {
      const listeners = new Set();
      let currentScope = null;
      const notify = () => {
        for (const fn of [...listeners]) {
          try {
            fn();
          } catch (e) {
            console.error('[dsh-wotr-console] Trae settings 订阅者抛错:', e);
          }
        }
      };
      const handle = {
        get: () => currentScope,
        subscribe: (fn) => {
          if (typeof fn !== 'function') return () => {};
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      try {
        const softGet = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined);
        const forms = softGet('configForms');
        /** 找不到可写作用域时的只读替身：让页面显示诊断而不是假控件 */
        const readOnly = {
          getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false }),
          subscribe: () => () => {},
          set: () => Promise.resolve(false),
        };
        if (forms !== undefined) {
          /** 转发到当前控制器，绑定关系变了也能跟上 */
          const forward = {
            getSnapshot: () => currentScope?.getSnapshot() ?? readOnly.getSnapshot(),
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            set: (field, value) =>
              currentScope === null ? Promise.resolve(false) : currentScope.set(field, value),
          };
          let bound = null;
          let boundOff = null;
          let refreshedOnce = false;
          const rebind = () => {
            let served;
            try {
              served = (forms.describe().getSnapshot().view?.namespaces ?? []).find(
                (entry) => entry.ns === 'trae' || /trae/i.test(entry.ns),
              );
            } catch {
              /* 镜像还没就绪 */
            }
            const next = served === undefined ? undefined : forms.get(served.ns);
            if (next !== bound) {
              boundOff?.();
              bound = next ?? null;
              boundOff = bound?.subscribe(notify);
            }
            currentScope = bound ?? readOnly;
            notify();
            if (bound === null && !refreshedOnce) {
              refreshedOnce = true;
              try {
                forms.describe().load?.();
              } catch {
                /* 触发一次加载是尽力而为 */
              }
            }
          };
          rebind();
          try {
            forms.describe().subscribe?.(rebind);
          } catch {
            /* 老宿主没有订阅接口 */
          }
          return { get: () => forward, subscribe: handle.subscribe };
        }
        const legacy = softGet('settingsScope');
        if (legacy !== undefined) {
          currentScope = legacy.bind({ namespace: 'trae' });
          return handle;
        }
        currentScope = readOnly;
        return handle;
      } catch (e) {
        console.error('[dsh-wotr-console] Trae settings 作用域解析失败（配置页将只读）:', e);
        currentScope = {
          getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false }),
          subscribe: () => () => {},
          set: () => Promise.resolve(false),
        };
        return handle;
      }
    }

    /**
     * 解析「某个会话当前的模型目录 store」，供输入框下方的额度胶囊使用。
     *
     * 数据来自 model-selection 包的 `modelDirectories` 服务：
     *
     *   models.directoryFor(sessionId).store.getSnapshot()
     *     → { groups: [{id, models}], current: { provider, model } }
     *
     * `current.provider` 就是 provider id，胶囊据此判断该显示哪个池的额度。
     *
     * **为什么用 ctx.get() 软取而不是写进 exports.inject：**
     * cordis 的依赖门禁是硬性的 —— inject 里声明了运行时不提供的服务，
     * 本插件的 apply 会**整个不执行**，WOTR 设置页会跟着一起消失。
     * 而额度胶囊只是个锦上添花的小控件，不值得拿整个插件去赌。
     * 软取拿不到时它自己返回 undefined，胶囊静默不渲染，其余一切照常。
     *
     * 每次调用都重新 ctx.get()：服务可能晚于本插件注册，缓存住
     * 一次失败会永久失灵。
     */
    function resolveModelDirectory(ctx, sessionId) {
      try {
        if (typeof ctx?.get !== 'function') return undefined;
        const models = ctx.get('modelDirectories');
        if (models === undefined || models === null) return undefined;
        if (typeof models.directoryFor !== 'function') return undefined;
        const directory = models.directoryFor(sessionId);
        return directory?.store ?? undefined;
      } catch (e) {
        console.error('[dsh-wotr-console] 模型目录解析失败（额度胶囊将不显示）:', e);
        return undefined;
      }
    }

    /**
     * 管理页组件：配置 + 查看。
     *
     * 组件本体在 console.mjs（普通 ES 模块，便于阅读与测试），
     * 由 scripts/gen-console-inline.mjs 生成为上面的 __WBC_CONSOLE_FACTORY__
     * （一个真函数，不是字符串 + eval —— 后者可能被 CSP 拒绝）。
     * 不开独立页面、不引 web/ 目录：只是设置面板里多注册一个 tab。
     */
    function registerConsolePage(ctx, react_, jsxRuntime_, embedded) {
      try {
        // 运行时缺失就跳过：宁可不显示管理页，也不能让 apply 抛错。
        if (react_ === null || jsxRuntime_ === null) return;
        if (ctx?.slots === undefined || ctx?.locale === undefined) return;

        const Pkg = __WBC_CONSOLE_FACTORY__(react_, jsxRuntime_, embedded);
        if (typeof Pkg !== 'function') return;

        // 传给额度胶囊的解析器：只依赖 ctx，绑定好会话后每次现取
        const resolveModelDirectoryFn = (sessionId) => resolveModelDirectory(ctx, sessionId);

        const NS = 'wotr-console-page';
        ctx.effect(
          () => ctx.locale.register(NS, { zh: { 'nav.label': 'WOTR' }, en: { 'nav.label': 'WOTR' } }),
          'dsh-wotr-console: page copy',
        );
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'wotr-console-page',
              // 账号池原来的独立页（order 440）已并入本页，本页成为唯一入口
              order: 440,
              label: () => t('nav.label'),
            },
            Pkg,
          ),
        );

        // 输入框下方的「当前模型额度」胶囊。
        //
        // 挂 conversation.composer.dock：conversation 包把它声明成
        // `{ kind: "list", scope: "session" }`，就是输入框正下方那一行
        // （内置的 tok/s · 缓存命中 胶囊也在那）。list 槽要求唯一的 id，
        // order 取 10 让本胶囊排在内置 stats（order 0）之后。
        //
        // **inject 的第一个实参就是本会话的 sessionId**：renderer 的
        // runInject 把 scope binding 的 key 当首参传给 inject。额度胶囊要靠
        // 它去 modelDirectories 取当前模型，所以必须原样往下传 —— 漏传的话
        // 组件里 sessionId 恒为 undefined，胶囊永远不渲染。
        //
        // 整段包 try：composer.dock 未必在每条宿主线上都被声明，
        // 缺失时 register 会抛 "slot is not declared"，那不该连累设置页。
        const Pill = Pkg?.ComposerCreditsPill;
        if (typeof Pill === 'function' && typeof resolveModelDirectoryFn === 'function') {
          try {
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'wotr-credits',
                  order: 10,
                  inject: (sessionId) => ({ sessionId, resolveModelDirectory: resolveModelDirectoryFn }),
                },
                Pill,
              ),
            );
          } catch (e) {
            console.error('[dsh-wotr-console] 额度胶囊注册失败（不影响输入框）:', e);
          }
        }
      } catch (e) {
        console.error('[dsh-wotr-console] console page failed to register:', e);
      }
    }

    /**
     * 入口。**整个函数体都必须被兜住。**
     *
     * cordis 的插件 fiber 一旦 apply 抛出就进入 failed 状态，宿主会判定
     * 「应用无法启动」并弹崩溃框 —— 一个纯 UI 页面的问题绝不该有这个后果。
     * 所以这里除了内层的细粒度 try/catch，外面再套一层总兜底。
     */
    function apply(ctx) {
      try {
        // 1) vendored xdpool 客户端：转发 apply 拿到它的 locale 文案，但拦掉
        //    它的 settings.section 注册（不再单独成页）。它解析出的作用域由
        //    下面 resolveWorkbuddySettings 按同一规则再取一份给自写配置页用。
        forwardVendoredApply(ctx, xdpoolClient, 'xdpool client');

        // 2) WorkBuddy 池的 settings 作用域（活句柄，渲染期取值）
        const wbSettings = resolveWorkbuddySettings(ctx);

        // 3) Trae 侧：不再嵌入上游的浏览器卡片，改成**本包自写**的配置页
        //    （console.mjs 的 TraeConfigTab），它只需要一份 Trae settings 作用域。
        const traeSettings = resolveTraeSettings(ctx);

        // 4) 管理页：XD Pool 配置 / Trae 配置 / 账号 / 积分 / 使用记录
        registerConsolePage(ctx, react, jsxRuntime, { wbSettings, traeSettings });
      } catch (e) {
        console.error('[dsh-wotr-console] apply failed (UI only; provider unaffected):', e);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.name = pkgName;
    return module.exports;
  },
});
