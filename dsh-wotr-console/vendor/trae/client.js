window.__ModuleLoader__.load({
	id: "dsh-connect-trae",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region src/status-paths.ts
		/** Plugin-owned usage endpoint consumed by its browser half. */
		const TRAE_USAGE_PATH = "/plugins/dsh-connect-trae/usage";
		/** Plugin-owned live model refresh endpoint. */
		const TRAE_MODELS_REFRESH_PATH = "/plugins/dsh-connect-trae/models/refresh";
		/**
		* Plugin-owned availability probe: POST the model ids to test, get one verdict
		* per model. Unlike every read-only sibling this route SPENDS quota — a real
		* (minimal) chat call per model — so it is user-initiated only, and the card
		* labels the button as consuming a small amount.
		*/
		const TRAE_MODELS_TEST_PATH = "/plugins/dsh-connect-trae/models/test";
		/** Plugin-owned local account rescan endpoint. */
		const TRAE_ACCOUNTS_REFRESH_PATH = "/plugins/dsh-connect-trae/accounts/refresh";
		/**
		* General balance of EVERY account in a region, for the composer panel's table.
		*
		* Separate from the usage route on purpose: the usage document backs the
		* 5-minute readout, and multiplying its upstream reads by the account count
		* would charge a healthy account for something it never looks at — the same
		* principle that keeps `creditAlternatives` firing only when a balance hits
		* zero. This one is paid when the panel is actually opened, which is the only
		* place the table is shown.
		*/
		const TRAE_ACCOUNT_CREDITS_PATH = "/plugins/dsh-connect-trae/account-credits";
		/**
		* Plugin-owned daily check-in claim endpoint. POST, loopback-only, and the only
		* route in this plugin that changes upstream account state.
		*/
		const TRAE_CHECKIN_PATH = "/plugins/dsh-connect-trae/checkin";
		/** Query parameter naming the region a card request addresses. */
		const TRAE_REGION_PARAM = "region";
		/** Every region, in card tab order. */
		const TRAE_REGIONS = ["cn", "ai"];
		/**
		* Address one region's status route. The two regions are separate provider
		* stacks; every card request carries the region whose tab the user is on.
		*/
		function withTraeRegion(path, region) {
			return `${path}?${TRAE_REGION_PARAM}=${region}`;
		}
		/**
		* Peel ONE `{get(): T}` live reference, the shape DSH 0.1.7 delivers a
		* volatile-marked settings field as (see {@link unwrapVolatileDeep}).
		*/
		function unwrapVolatile(value) {
			if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
			return value;
		}
		/**
		* Deep copy of a value with every `{get(): T}` live reference replaced by the
		* value it resolves to.
		*
		* DSH 0.1.7 hands volatile-marked fields back as live references, and a live
		* reference is still `typeof === 'object'` — so it passes a naive object check
		* and every lookup on it is `undefined`. Worse, spreading one (`{ ...ref }`)
		* does NOT read the field: it produces `{ get: <function> }`. Any merge that
		* spreads a resolved field to preserve its siblings — the card's "write one
		* region, keep the other" write, or the account map's spread — would otherwise
		* DROP every sibling and leak a function into the document.
		*
		* Both halves therefore unwrap before touching a resolved field. This lives in
		* the node-free host↔client bridge because the browser half needs it too.
		*
		* Non-reference values are recursed into so a nested volatile field is caught
		* as well; arrays and objects are rebuilt rather than mutated, so the caller's
		* value is never touched.
		*/
		function unwrapVolatileDeep(value) {
			if (value === null || typeof value !== "object") return value;
			if (typeof value.get === "function") return unwrapVolatileDeep(value.get());
			if (Array.isArray(value)) return value.map((entry) => unwrapVolatileDeep(entry));
			const source = value;
			const out = {};
			for (const key of Object.keys(source)) out[key] = unwrapVolatileDeep(source[key]);
			return out;
		}
		/**
		* Read the per-region account selections out of a settings value.
		*
		* SHARED because `accounts` now has TWO writers: the card, and the composer
		* panel's account table (2.14.0). Two writers of one field must use one merge
		* rule, or they drift — and the rule is not obvious.
		*
		* Deep-unwraps first: on DSH 0.1.7 a volatile field arrives as a `{get(): T}`
		* live reference, which passes the `typeof === 'object'` check and would be
		* returned as if it were the map. Every lookup on it is then `undefined`, and
		* the merge (`{ ...configured, [region]: id }`) would spread a reference into
		* `{get: <function>}` — dropping the other region's selection and leaking a
		* function into the settings document.
		*/
		function configuredAccountsOf(configured) {
			const accounts = unwrapVolatileDeep(configured)?.accounts;
			return typeof accounts === "object" && accounts !== null ? accounts : {};
		}
		/**
		* Build the next `regions` settings value for the card's save. The write
		* targets ONLY the signed-in account's region slot; every other region's slot
		* is carried over untouched, so switching accounts never clobbers the other
		* region's picks. Tolerates any stored shape (absent, non-object) by starting
		* from an empty document.
		*/
		function nextRegionSlots(regions, region, slot) {
			const unwrapped = unwrapVolatileDeep(regions);
			return {
				...typeof unwrapped === "object" && unwrapped !== null && !Array.isArray(unwrapped) ? unwrapped : {},
				[region]: slot
			};
		}
		/**
		* Narrow a settings value to the `regions` map. Accepts EITHER the whole
		* settings section (`{ regions: {...}, ... }`) or the `regions` map itself, and
		* unwraps the former. This tolerance is deliberate: passing the whole section
		* where the map was expected was a real shipped bug — the lookup then read
		* `section['cn']` (absent), so the card's checkbox reported `true` forever and
		* clicking it appeared to do nothing even though the write succeeded.
		*
		* Unwraps live references first: on DSH 0.1.7 the `regions` field arrives as a
		* `{get(): T}` reference, which passes the `typeof === 'object'` check below
		* and would otherwise be returned as if it were the map — making every region
		* read back as absent (and the enabled flag read as "on" forever).
		*/
		function regionsMapOf(value) {
			const unwrapped = unwrapVolatileDeep(value);
			if (typeof unwrapped !== "object" || unwrapped === null || Array.isArray(unwrapped)) return {};
			const record = unwrapped;
			const nested = record["regions"];
			if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) return nested;
			return record;
		}
		/** One region's stored slot as a plain object; any other shape reads as empty. */
		function regionSlotOf(value, region) {
			const slot = unwrapVolatile(regionsMapOf(value)[region]);
			return typeof slot === "object" && slot !== null && !Array.isArray(slot) ? slot : {};
		}
		/**
		* Whether one region's provider is switched on. Opt-out semantics: only an
		* explicit `false` disables it, so a config written before this switch existed
		* (and the pre-region-split flat fields, which never carry `enabled`) keep both
		* providers running exactly as before. The Host reads the same rule through
		* `regionStateOf`, so card and Host can never disagree about a region's state.
		*
		* `value` may be the whole settings section or the `regions` map (see
		* {@link regionsMapOf}).
		*/
		function regionEnabledOf(value, region) {
			return regionSlotOf(value, region)["enabled"] !== false;
		}
		/**
		* Build the next `regions` settings value for a provider on/off toggle. ONLY
		* the target region's `enabled` flag changes: every other field of that slot
		* (its directory, selection, image opt-ins, context budgets) and every other
		* region's slot are carried over verbatim, so switching a provider off never
		* discards the user's model picks and switching it back on restores them.
		*
		* This is deliberately separate from {@link nextRegionSlots}: that helper
		* writes a whole slot from a signed-in tab's draft, while this one must work
		* for a region that is signed OUT — which is precisely the region a user wants
		* to switch off (no international install, no international account).
		*
		* `value` may be the whole settings section or the `regions` map; the RETURN
		* value is always the `regions` map, i.e. exactly what `settingsScope.set(
		* 'regions', ...)` needs.
		*/
		function nextRegionEnabled(value, region, enabled) {
			return nextRegionSlots(regionsMapOf(value), region, {
				...regionSlotOf(value, region),
				enabled
			});
		}
		/**
		* Whether Trae's plan identity says this account is on a paying plan.
		*
		* `has_package` alone is NOT that question — it reports whether a package
		* entitlement row exists, and a member can be on a plan without one (issue
		* #19: a Pro account rendered as "No active package"). Trae spells the plan in
		* `user_pay_identity_str`, so this reads that field, and only the exact word
		* `Free` counts as free: an unknown or future tier name is treated as paid,
		* because claiming "Free" for a tier we simply do not recognise is the more
		* damaging of the two errors.
		*/
		function traePlanIsPaid(payIdentityStr) {
			const tier = payIdentityStr?.trim();
			return tier !== void 0 && tier !== "" && !/^free$/i.test(tier);
		}
		//#endregion
		//#region src/client/icon.ts
		/**
		* Plugin icon (LD brand logo, 64px) shared across the LaoDing plugin family.
		* Same data URI used by `dsh-subagent-default-model` so the external image
		* stays consistent.
		*/
		const TRAE_PLUGIN_ICON = "data:image/png;base64,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";
		//#endregion
		//#region src/client/styles.ts
		/**
		* Client styles for the Trae plugin card.
		* Copied verbatim from `dsh-subagent-default-model`'s SETTINGS_CSS so the two
		* plugins share one external-presentation language (same card shell, same
		* button primitives, same `--dsw-alias-*` token palette).
		*/
		const TRAE_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
/* Pure-CSS caret: the host primitives' chevron icon names are not part of any
   stable contract across DSH releases, so no static import is used — a border
   caret in the plugin's own CSS is version-proof. */
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-plugin-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-plugin-card-body .dsm-model-settings{margin:0;padding:12px 0 0;background:transparent;border:0;border-radius:0}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-trae-mainui-switch{display:flex;justify-content:flex-end;padding:0 2px 8px}
.dsm-trae-mainui-switch-label{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0);white-space:nowrap;cursor:pointer}
.dsm-trae-mainui-switch-label input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-trae-mainui-switch-label:has(input:disabled){opacity:.6;cursor:default}
.dsm-trae-usage{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px}
.dsm-trae-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-trae-tab-cell{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.dsm-trae-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .15s,background .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-trae-tab:hover:not(:disabled):not(.dsm-trae-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-trae-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-trae-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-trae-tab-off{opacity:.55}
.dsm-trae-tab-switch{display:inline-flex;align-items:center;flex:none;padding:0 8px 0 2px;cursor:pointer}
.dsm-trae-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-trae-tab-switch input:disabled{cursor:not-allowed}
.dsm-trae-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.dsm-trae-tab-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-trae-tab-off-notice{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-trae-usage-account{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-trae-usage-account-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-trae-usage-expiry{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-trae-account-picker{display:block}
.dsm-trae-usage-select-wrap{position:relative}
.dsm-trae-usage-select{appearance:none;width:100%;font:inherit;padding:10px 34px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dsm-trae-usage-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-trae-usage-select:disabled{opacity:.6;cursor:default}
.dsm-trae-usage-select-wrap::after{content:"";position:absolute;top:50%;right:12px;width:7px;height:7px;transform:translateY(-65%) rotate(45deg);border-right:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);border-bottom:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);pointer-events:none}
.dsm-trae-mark{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:11px;font-weight:700;color:#111;background:linear-gradient(135deg,#ffd36e,#ffb84d);margin-right:6px}
.dsm-trae-usage-list{display:flex;flex-direction:column;gap:10px}
.dsm-trae-usage-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-trae-usage-error{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-trae-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-trae-usage-status{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-trae-usage-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:2px}
.dsm-trae-usage-stats-two{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.dsm-trae-usage-stat{position:relative;display:flex;flex-direction:column;gap:9px;padding:16px 16px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c);overflow:hidden;min-width:0}
.dsm-trae-usage-stat::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;opacity:.9}
.dsm-trae-usage-stat-work::before{background:#9ca2aa}
.dsm-trae-usage-stat-general::before{background:#4d9b6d}
.dsm-trae-usage-stat-head{display:flex;align-items:center;gap:7px;min-width:0}
.dsm-trae-usage-stat-label{font-size:13px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-trae-usage-stat-badge{margin-left:auto;flex:0 0 auto;padding:2px 8px;border-radius:999px;font-size:11px;line-height:15px;font-weight:600;letter-spacing:.2px}
.dsm-trae-usage-stat-badge-off{color:#aeb3bb;background:rgba(174,179,187,.11)}
.dsm-trae-usage-stat-badge-on{color:#3f8d60;background:rgba(63,141,96,.13)}
.dsm-trae-usage-stat-value{font-size:32px;line-height:36px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsm-trae-usage-stat-value-general{color:#3f8d60}
.dsm-trae-usage-stat-value-work{color:#9298a0}
.dsm-trae-usage-stat-hint{margin:2px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-trae-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-trae-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-trae-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-trae-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-trae-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-trae-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-trae-model-disabled{opacity:.55}
.dsm-trae-model+.dsm-trae-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-trae-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-trae-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.dsm-trae-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-trae-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-trae-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-trae-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
/* The two head actions sit together; the probe one SPENDS quota, so it carries
   the hint tooltip rather than looking like its read-only sibling. */
/* The sidebar-credit switch. Two instances share this style: the card's own
   row at the top and the copy beside the model actions (2.9.3). Without it the
   checkbox rendered unstyled and read as absent — the whole reason the switch
   looked missing. */
.dsm-trae-models-actions{display:flex;align-items:center;gap:8px;flex:none}
}
.dsm-trae-usage-alternative{display:flex;align-items:flex-start;gap:10px;margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warning-border,#7a5b12);border-radius:10px;background:var(--dsw-alias-state-warning-bg,#2a2313)}
.dsm-trae-usage-alternative-text{margin:0;flex:1 1 auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-trae-usage-switch-button{flex:0 0 auto;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2c2f36);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:16px;cursor:pointer}
.dsm-trae-usage-switch-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4,#333740)}
.dsm-trae-usage-switch-button:disabled{opacity:.5;cursor:not-allowed}
.dsm-trae-usage-note{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-trae-models-hint{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
/* Verdict badge. Only a real refusal is coloured as a warning; an unknown
   verdict stays neutral because an inconclusive probe is not evidence against
   the model. */
.dsm-trae-model-probe{flex:none;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:500;line-height:15px;white-space:nowrap}
.dsm-trae-model-probe-available{color:var(--dsw-alias-state-success-primary,#22a06b);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#22a06b) 40%,transparent)}
.dsm-trae-model-probe-gated,.dsm-trae-model-probe-unsupported{color:var(--dsw-alias-state-warning-primary,#d98f20);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d98f20) 40%,transparent)}
.dsm-trae-model-probe-auth{color:var(--dsw-alias-state-error-primary,#d92d20);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 40%,transparent)}
.dsm-trae-model-probe-rate-limited,.dsm-trae-model-probe-unknown{color:var(--dsw-alias-label-tertiary,#999);border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#999) 35%,transparent)}
.dsm-trae-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-trae-model-options{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none}
.dsm-trae-model-image{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px;cursor:pointer}
.dsm-trae-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-trae-context-budget{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-trae-context-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-trae-context-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-trae-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-trae-model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-trae-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsm-trae-usage-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}
.dsm-trae-usage-cheer-star{font-size:12px;line-height:1;display:inline-flex}
.dsm-trae-usage-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-trae-searched{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-trae-searched>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#b8b8b8);user-select:none}
.dsm-trae-searched-hint{margin:6px 0 4px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-trae-searched-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-trae-searched-list li{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-trae-searched-list code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-all}
.dsm-trae-searched-reason{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsm-trae-usage-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
.dsm-trae-checkin{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-trae-checkin-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsm-trae-checkin-label{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:18px;font-weight:600}
.dsm-trae-checkin-hint{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:17px}
.dsm-trae-checkin-button{flex:none}
/* The "this machine already used today's check-in" note is INFORMATIONAL, not
   an error: it is Trae's one-per-device-per-day rule, and the day is simply
   spent. Rendering it in the error colour would read as a plugin fault. */
.dsm-trae-checkin-note{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
`;
		/**
		* Composer-row readout styles, injected by the readout itself.
		*
		* SEPARATE from `TRAE_CARD_CSS`, and that is not tidiness: the card's CSS is
		* only injected when the settings card module loads, so putting the composer's
		* rules in it means the readout renders UNSTYLED in the composer toolbar —
		* which is exactly what shipped in 2.13.0–2.13.4. The trigger fell back to the
		* browser's default button box, and the panel, without `position: fixed`, had
		* its inline left/top ignored and rendered nowhere useful.
		*
		* `tests/composer-styles.spec.tsx` now asserts that every class this component
		* renders has a rule here, so a rule cannot go missing without a test failing.
		*/
		const COMPOSER_POINTS_CSS = `
/* The readout is plain composer text — no border, no fill at rest. The padding
   is only the click target, invisible until the pointer arrives. */
.dsm-trae-composer-points{display:inline-flex;align-items:center;min-width:0}
.dsm-trae-composer-points-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  /* EXPLICIT, not inherit. The composer row's own font and body colour are
     noticeably larger and darker than the neighbouring controls — a credit
     readout is secondary information and must not shout. 12px matches this
     plugin's original line; label-tertiary matches the shell's own composer-row
     control (ContextMeter), which is the sibling this reads alongside. */
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;cursor:pointer;
  font-variant-numeric:tabular-nums;
}
.dsm-trae-composer-points-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-trae-composer-points-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* The panel is portaled to document.body and positioned from the trigger, so it
   MUST be fixed — otherwise the left/top it measures are ignored and it lands in
   document flow. All material comes from shell tokens so it follows the theme. */
.dsm-trae-composer-panel{
  position:fixed;z-index:1100;box-sizing:border-box;
  width:min(248px,calc(100vw - 24px));padding:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));
  border-radius:var(--dsw-radius-lg,14px);
  background:var(--dsw-specific-menu,Canvas);
  box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.22));
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);
}
.dsm-trae-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsm-trae-composer-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
/* Self-contained: the dsm-btn primitive lives in TRAE_CARD_CSS, which the
   composer never loads, so the refresh button must style itself. */
.dsm-trae-composer-panel-refresh{
  appearance:none;flex:none;margin-left:auto;padding:3px 10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));
  border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#444);
  font:inherit;font-size:11px;line-height:16px;cursor:pointer;
}
.dsm-trae-composer-panel-refresh:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-trae-composer-panel-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-trae-composer-panel-refresh:disabled{opacity:.5;cursor:default}
/* The panel is a TABLE: one row per account in the region, one figure (the
   general balance) per row, and a row click switches accounts.

   Rhythm is deliberate: the header sits on a hairline, the switch button owns
   ALL horizontal padding (and pulls back by the same amount so its label lines
   up with the header), and every row is the same height. A misaligned first
   column is what makes a two-column popover read as broken. */
.dsm-trae-composer-panel-table{
  width:100%;border-collapse:collapse;
  font-size:12px;line-height:18px;
}
.dsm-trae-composer-panel-table thead th{
  padding:0 0 7px;font-weight:500;text-align:left;font-size:11px;
  color:var(--dsw-alias-label-tertiary,GrayText);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-trae-composer-panel-num{
  text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.dsm-trae-composer-panel-table thead th.dsm-trae-composer-panel-num{padding-right:0}
.dsm-trae-composer-panel-table tbody th{
  padding:0;font-weight:400;text-align:left;vertical-align:middle;
}
.dsm-trae-composer-panel-table tbody td{
  padding:4px 0;vertical-align:middle;
  color:var(--dsw-alias-label-primary,CanvasText);
}
/* The current account reads as current without shouting: a filled dot and a
   slightly heavier weight. Disabled — pressing it would write a selection that
   has not changed. */
.dsm-trae-composer-panel-table tbody tr.dsm-trae-composer-panel-row-current td{font-weight:600}
.dsm-trae-composer-panel-switch{
  appearance:none;display:flex;align-items:center;gap:7px;
  width:100%;padding:4px 6px;margin-left:-6px;
  border:0;border-radius:6px;background:transparent;
  color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;
  white-space:nowrap;overflow:hidden;
}
.dsm-trae-composer-panel-switch>span:last-child{overflow:hidden;text-overflow:ellipsis}
/* Hover belongs to the switch, not the row: the number cell is not clickable,
   so lighting it up would promise an action it cannot perform. */
.dsm-trae-composer-panel-switch:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dsm-trae-composer-panel-switch:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px;
}
.dsm-trae-composer-panel-switch:disabled{cursor:default}
.dsm-trae-composer-panel-dot{
  flex:none;width:7px;height:7px;border-radius:50%;
  background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5));
}
.dsm-trae-composer-panel-table tr.dsm-trae-composer-panel-row-current .dsm-trae-composer-panel-dot{
  background:var(--dsw-state-success,#22a06b);
}
.dsm-trae-composer-panel-foot{
  display:flex;justify-content:space-between;gap:8px;
  margin-top:9px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,GrayText);
}
.dsm-trae-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsm-trae-composer-panel-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:11px;line-height:16px}
`;
		//#endregion
		//#region src/client/TraeUsageCard.tsx
		/**
		* Trae usage card contributed to Harness Plugin configuration.
		*
		* Structure, CSS classes, and button primitives mirror `dsh-subagent-default-model`'s
		* `SubagentModelCard` so the two plugins share one external-presentation language.
		*/
		const POLL_INTERVAL_MS = 6e4;
		const TRAE_GITHUB_URL = "https://github.com/dingminhua/dsh-connect-trae";
		/**
		* Write one settings field and confirm the value actually landed.
		*
		* `configForms.set()` resolving is NOT proof that anything was stored: a write
		* can be accepted by the transport and still not materialize — a rejected
		* write reloads Host state and merely RETURNS, so the caller's `await`
		* succeeds while the document is unchanged. The form answers with an explicit
		* boolean for exactly this reason.
		*
		* Either way the caller must not report success on an unpersisted write: the
		* user would see the control flip and then silently revert.
		*
		* @throws {TraeSettingsWriteError} when the write was refused or did not land.
		*/
		var TraeSettingsWriteError = class extends Error {
			constructor(field, detail) {
				super(detail === void 0 || detail === "" ? `trae: settings field "${field}" was not persisted by the settings write` : `trae: settings field "${field}" was not persisted by the settings write (${detail})`);
				this.name = "TraeSettingsWriteError";
			}
		};
		async function writeSettingsField(scope, field, value, landed) {
			if (await scope.set(field, value) === false) throw new TraeSettingsWriteError(field, "the Host refused the write");
			if (!landed(unwrapVolatileDeep(scope.getSnapshot().value))) throw new TraeSettingsWriteError(field);
		}
		/** Read one region's stored `regions` slot out of an unwrapped settings value. */
		function regionSlotsOf(value) {
			const regions = value?.regions;
			return typeof regions === "object" && regions !== null ? regions : {};
		}
		/** Inject the shared card CSS once. */
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-trae/client.css";
			if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-connect-trae";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = TRAE_CARD_CSS;
				document.head.appendChild(styleTag);
			}
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0, {
				minimumFractionDigits: 0,
				maximumFractionDigits: 0
			}).format(value);
		}
		function formatDateTime(value) {
			return new Intl.DateTimeFormat(void 0, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			}).format(new Date(value));
		}
		function formatCapacity(value, unknown) {
			if (value === void 0) return unknown;
			if (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6}M`;
			if (value >= 1e3 && value % 1e3 === 0) return `${value / 1e3}K`;
			return formatNumber(value);
		}
		/**
		* The subscription row's verdict.
		*
		* Two independent things can entitle an international account: a package row
		* (`has_package`) and a plan identity (`user_pay_identity_str`). Reading only
		* the first is what rendered a Pro member as "No active package" in issue #19,
		* so either one counts. The tier string is carried separately so the row can
		* name the plan instead of just asserting a boolean.
		*/
		function payVerdict(payStatus) {
			const tier = payStatus.payIdentityStr?.trim();
			const paid = payStatus.hasPackage || traePlanIsPaid(payStatus.payIdentityStr);
			return {
				paid,
				...tier === void 0 || tier === "" ? {} : { tier },
				label: paid ? "row.subscribed" : "row.noPackage"
			};
		}
		/**
		* The verdict badge for one model, or null when it has not been tested.
		*
		* `unknown` renders as inconclusive, never as a failure: a throttle or a dropped
		* connection says nothing about the model, and painting it the same red as a
		* real refusal is what makes users delete working models.
		*/
		const PROBE_LABELS = {
			available: "row.probeAvailable",
			gated: "row.probeGated",
			unsupported: "row.probeUnsupported",
			rate_limited: "row.probeRateLimited",
			auth: "row.probeAuth",
			unknown: "row.probeUnknown"
		};
		function probeBadge(probe, t) {
			if (probe === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: `dsm-trae-model-probe dsm-trae-model-probe-${probe.verdict}`,
				title: probe.detail,
				children: t(PROBE_LABELS[probe.verdict])
			});
		}
		function dotStyle(status) {
			return { background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)" };
		}
		/** Render Trae sign-in state and the total usage summary as one expandable card. */
		function TraeUsageCard({ t, settingsScope, view }) {
			if (t === void 0) throw new Error("Trae usage card requires its translation function");
			const [open, setOpen] = (0, react.useState)(view === "page");
			/** The region whose tab is on screen; each tab is its own provider stack. */
			const [activeRegion, setActiveRegion] = (0, react.useState)("cn");
			/** Last-known usage per region, so tab dots survive tab switches. */
			const [statusByRegion, setStatusByRegion] = (0, react.useState)({
				cn: {
					status: "signed-out",
					accounts: []
				},
				ai: {
					status: "signed-out",
					accounts: []
				}
			});
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* Availability verdicts from the one-click test, per region, keyed by model
			* id. Session-only on purpose: a verdict is one moment on one account, and a
			* persisted "not served" would keep claiming that long after upstream changed
			* its mind.
			*/
			const [probeByRegion, setProbeByRegion] = (0, react.useState)({
				cn: {},
				ai: {}
			});
			const [testing, setTesting] = (0, react.useState)(void 0);
			const [testError, setTestError] = (0, react.useState)(void 0);
			const [testSummary, setTestSummary] = (0, react.useState)(void 0);
			const [settingsRevision, setSettingsRevision] = (0, react.useState)(0);
			/** Per-region unsaved model edits; a draft on one tab is never dropped by
			* switching to the other tab, only by that tab's discard/save. */
			const [drafts, setDrafts] = (0, react.useState)({});
			const [saving, setSaving] = (0, react.useState)(false);
			const [switchingAccount, setSwitchingAccount] = (0, react.useState)(false);
			/** Region whose on/off checkbox write is in flight, so its box can't race. */
			const [togglingRegion, setTogglingRegion] = (0, react.useState)(void 0);
			/**
			* Whether a check-in claim is in flight. A single flag rather than a
			* per-region map: the claim exists only on the CN tab, and one shared flag
			* keeps a tab switch from stranding a second concurrent claim.
			*/
			const [claiming, setClaiming] = (0, react.useState)(false);
			/** Last claim refusal, shown until the next successful refresh. */
			const [claimError, setClaimError] = (0, react.useState)(void 0);
			/**
			* Outcome of the last "refresh accounts" press (issue #25).
			*
			* The rescan answers 200 with a fresh account list whether or not anything
			* changed, and the selection is PERSISTED, so a rescan of a machine whose
			* bound account is still the one it was yesterday looks identical to a
			* failure. Reporting the outcome is the difference between "it did nothing"
			* and "it found the same 2 accounts, still on X".
			*/
			const [rescanNote, setRescanNote] = (0, react.useState)(void 0);
			/**
			* Whether this MACHINE has spent today's check-in while the selected account
			* has not been paid — the "switched account" state. Kept separate from
			* `claimError` because it is not a failure: it is the upstream's one-per-
			* device-per-day rule, and rendering it through the "签到失败：…" line would
			* present a normal rule as a plugin fault.
			*/
			const [deviceSpentNotice, setDeviceSpentNotice] = (0, react.useState)(false);
			/**
			* A refused or unpersisted settings write, surfaced instead of silently
			* reverting. On 0.1.7 a rejected write resolves normally, so without this
			* the control would flip and then quietly snap back on the next snapshot.
			*/
			const [writeError, setWriteError] = (0, react.useState)(void 0);
			/** True while the composer-credit switch write is in flight. */
			const [togglingCredits, setTogglingCredits] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			/**
			* Toggle the composer credit readout (`showPointsInMainUi`). The card's
			* checkbox is the ONLY writer of this field — the readout itself carries no
			* control — so there is exactly one path that can change it, and the write is
			* read-back-checked like every other settings write in this card.
			*/
			const toggleShowPointsInMainUi = async (enabled) => {
				if (settingsScope === void 0 || settingsScope.getSnapshot().writable !== true) return;
				setTogglingCredits(true);
				setWriteError(void 0);
				try {
					await writeSettingsField(settingsScope, "showPointsInMainUi", enabled, (readBack) => unwrapVolatileDeep(readBack)?.showPointsInMainUi === enabled);
				} catch (error) {
					if (mounted.current) setWriteError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setTogglingCredits(false);
				}
			};
			(0, react.useEffect)(() => settingsScope?.subscribe(() => {
				setSettingsRevision((value) => value + 1);
			}), [settingsScope]);
			/**
			* Whether one region's provider is switched on, read off the SAME committed
			* settings document the Host reads (`regionEnabledOf` mirrors the Host's
			* `regionStateOf` opt-out rule: only an explicit `false` disables). Reading
			* the stored value rather than echoing local state means a rejected write,
			* another window's change, or a restart all converge on the truth.
			*
			* The whole settings section is passed deliberately: `regionEnabledOf`
			* accepts either it or the bare `regions` map, because passing the section
			* where the map was expected was a shipped bug (the lookup read
			* `section['cn']`, found nothing, and reported `true` forever — the checkbox
			* stayed checked and clicking it appeared dead while the write succeeded).
			*/
			const regionOn = (item) => regionEnabledOf(settingsScope?.getSnapshot().value, item);
			const activeRegionOn = regionOn(activeRegion);
			const refreshUsage = (0, react.useCallback)(async (region, signal) => {
				try {
					const response = await fetch(withTraeRegion(TRAE_USAGE_PATH, region), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const usage = value;
					if (mounted.current && signal?.aborted !== true) setStatusByRegion((prev) => ({
						...prev,
						[region]: usage
					}));
					return usage;
				} catch (error) {
					if (mounted.current && signal?.aborted !== true) setStatusByRegion((prev) => ({
						...prev,
						[region]: {
							status: "error",
							message: error instanceof Error ? error.message : t("row.requestFailed")
						}
					}));
					return;
				}
			}, [t]);
			(0, react.useEffect)(() => {
				if (!open || !activeRegionOn) return;
				const controller = new AbortController();
				refreshUsage(activeRegion, controller.signal);
				return () => {
					controller.abort();
				};
			}, [
				open,
				activeRegion,
				activeRegionOn,
				refreshUsage
			]);
			const status = statusByRegion[activeRegion] ?? {
				status: "signed-out",
				accounts: []
			};
			/**
			* Drop a claim refusal when the tab changes. The error belongs to the region
			* it came from — carrying it onto the other tab would attribute an
			* international account's problem to the CN one (or the reverse).
			*/
			(0, react.useEffect)(() => {
				setClaimError(void 0);
				setDeviceSpentNotice(false);
			}, [activeRegion]);
			(0, react.useEffect)(() => {
				if (!open || !activeRegionOn || status.status !== "signed-in") return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refreshUsage(activeRegion, controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				activeRegion,
				activeRegionOn,
				refreshUsage,
				status.status
			]);
			const rescanAccounts = async () => {
				setBusy(true);
				setWriteError(void 0);
				try {
					const response = await fetch(withTraeRegion(TRAE_ACCOUNTS_REFRESH_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json();
					if (!response.ok || !Array.isArray(body.accounts)) throw new Error(`HTTP ${response.status}`);
					const selected = body.accounts.find((account) => account.selected);
					const configured = configuredAccountsOf(settingsScope?.getSnapshot().value);
					const followed = selected !== void 0 && selected.id !== configured[activeRegion] && settingsScope !== void 0 && settingsScope.getSnapshot().writable === true;
					if (followed && settingsScope !== void 0) await writeSettingsField(settingsScope, "accounts", {
						...configured,
						[activeRegion]: selected.id
					}, (readBack) => configuredAccountsOf(readBack)[activeRegion] === selected.id);
					await refreshUsage(activeRegion);
					if (mounted.current) setRescanNote(body.accounts.length === 0 ? t("row.accountsRefreshedNone") : t("row.accountsRefreshed", {
						count: String(body.accounts.length),
						selected: followed ? "" : ` · ${t("row.accountsKept")} ${selected?.accountName ?? selected?.id ?? "—"}`
					}));
				} catch (error) {
					if (mounted.current) {
						const message = error instanceof Error ? error.message : t("row.requestFailed");
						setRescanNote(t("row.accountsRescanFailed", { message }));
						setWriteError(message);
					}
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const switchAccount = async (accountId) => {
				if (settingsScope === void 0) return;
				setSwitchingAccount(true);
				setWriteError(void 0);
				try {
					await writeSettingsField(settingsScope, "accounts", {
						...configuredAccountsOf(settingsScope.getSnapshot().value),
						[activeRegion]: accountId
					}, (readBack) => configuredAccountsOf(readBack)[activeRegion] === accountId);
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setWriteError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setSwitchingAccount(false);
				}
			};
			/**
			* Claim today's check-in reward for the active tab's region.
			*
			* The Host route owns every guard that matters — POST only, loopback origin
			* only, CN only, and a status read before the claim — because a browser-side
			* check is not a guard. The button's own `disabled` is therefore a courtesy
			* (it stops an obviously pointless click), not the protection.
			*
			* A refusal is not thrown away: the route answers `claimed: false` with the
			* upstream's business code and message, and the card shows it. Three answers
			* are distinguished rather than collapsed into "failed":
			*
			*  - `alreadyCheckedIn` — this ACCOUNT was already paid today; show it as
			*    claimed and refresh, never as an error.
			*  - `deviceCheckedIn` (code 9095) — this MACHINE already spent today's
			*    check-in, so this account cannot claim here today. That is the normal
			*    outcome after switching accounts, and saying "check-in failed" would
			*    blame the plugin for an upstream rule.
			*  - anything else — a real refusal, reported verbatim.
			*/
			const claimCheckin = async () => {
				setClaiming(true);
				setClaimError(void 0);
				setDeviceSpentNotice(false);
				try {
					const response = await fetch(withTraeRegion(TRAE_CHECKIN_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
					if (body?.claimed === false && body.deviceCheckedIn === true) {
						await refreshUsage(activeRegion);
						if (mounted.current) setDeviceSpentNotice(true);
						return;
					}
					if (body?.claimed === false && body.alreadyCheckedIn !== true) throw new Error(body.message === void 0 || body.message === "" ? t("row.checkinRefused", { code: String(body.code ?? "") }) : `${t("row.checkinRefused", { code: String(body.code ?? "") })}: ${body.message}`);
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setClaimError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setClaiming(false);
				}
			};
			/**
			* Switch one region's provider off or on (issue #11). The write carries the
			* region's whole slot through untouched — only `enabled` changes — so the
			* user's directory, model picks, image opt-ins and budgets survive a
			* round trip. The Host withdraws or restores the provider route on the next
			* `onChange`, which is what actually removes it from DSH's model picker.
			*/
			const toggleRegion = async (item, enabled) => {
				if (settingsScope === void 0 || settingsScope.getSnapshot().writable !== true) return;
				setTogglingRegion(item);
				setWriteError(void 0);
				try {
					await writeSettingsField(settingsScope, "regions", nextRegionEnabled(settingsScope.getSnapshot().value, item, enabled), (readBack) => regionSlotsOf(readBack)[item] !== void 0 && regionSlotsOf(readBack)[item].enabled === enabled);
				} catch (error) {
					if (mounted.current) setWriteError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setTogglingRegion(void 0);
				}
			};
			/**
			* One-click availability test for the ENABLED models of the active region.
			*
			* One model per request, deliberately: the host probe is sequential anyway
			* (Trae throttles bursts), and a per-model round trip lets each row show its
			* verdict as soon as it is known instead of the card sitting blank for a
			* minute. User-started, and it stops on the first authentication failure —
			* every later probe would only repeat that answer.
			*/
			const testEnabledModels = async () => {
				const ids = [...activeEnabledIds];
				setTestError(void 0);
				setTestSummary(void 0);
				if (ids.length === 0) {
					setTestError(t("row.modelsTestEmpty"));
					return;
				}
				setTesting({
					done: 0,
					total: ids.length
				});
				const collected = {};
				let available = 0;
				let denied = false;
				try {
					for (const [index, id] of ids.entries()) {
						if (!mounted.current) return;
						const response = await fetch(withTraeRegion(TRAE_MODELS_TEST_PATH, activeRegion), {
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/json"
							},
							credentials: "same-origin",
							body: JSON.stringify({ ids: [id] })
						});
						const body = await response.json().catch(() => ({}));
						if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
						const verdict = body.results?.[0];
						if (verdict !== void 0) {
							collected[id] = {
								verdict: verdict.verdict,
								detail: verdict.detail
							};
							if (verdict.verdict === "available") available += 1;
							setProbeByRegion((prev) => ({
								...prev,
								[activeRegion]: {
									...prev[activeRegion],
									[id]: {
										verdict: verdict.verdict,
										detail: verdict.detail
									}
								}
							}));
							if (verdict.verdict === "auth") {
								denied = true;
								break;
							}
						}
						setTesting({
							done: index + 1,
							total: ids.length
						});
					}
					if (mounted.current) {
						setTestSummary(t("row.modelsTestDone", {
							available,
							total: Object.keys(collected).length
						}));
						if (denied) setTestError(t("row.probeAuth"));
					}
				} catch (error) {
					if (mounted.current) setTestError(t("row.modelsTestError", { message: error instanceof Error ? error.message : t("row.requestFailed") }));
				} finally {
					if (mounted.current) setTesting(void 0);
				}
			};
			const refreshModels = async () => {
				setBusy(true);
				try {
					const response = await fetch(withTraeRegion(TRAE_MODELS_REFRESH_PATH, activeRegion), {
						method: "POST",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json();
					if (!response.ok || !Array.isArray(body.models)) throw new Error(`HTTP ${response.status}`);
					const fresh = body.models;
					const freshIds = new Set(fresh.map((model) => model.id));
					const stillEnabled = [...activeEnabledIds].filter((id) => freshIds.has(id));
					const stillImages = [...activeImageIds].filter((id) => freshIds.has(id));
					const stillBudgets = {};
					for (const id of freshIds) {
						const budget = activeContextBudgets[id];
						if (typeof budget === "number") stillBudgets[id] = budget;
					}
					setDrafts((prev) => ({
						...prev,
						[activeRegion]: {
							models: fresh.map((model) => ({
								...model,
								input: ["text"]
							})),
							enabledIds: new Set(stillEnabled),
							imageIds: new Set(stillImages),
							contextBudgets: stillBudgets
						}
					}));
				} catch (error) {
					if (mounted.current) setStatusByRegion((prev) => ({
						...prev,
						[activeRegion]: {
							status: "error",
							message: error instanceof Error ? error.message : t("row.requestFailed")
						}
					}));
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const settingsValue = unwrapVolatileDeep(settingsScope?.getSnapshot().value);
			const region = activeRegion;
			const configuredRegions = typeof settingsValue === "object" && settingsValue !== null && typeof settingsValue.regions === "object" && settingsValue.regions !== null ? settingsValue.regions : {};
			const regionSlot = configuredRegions[region];
			const legacySlot = region === "cn" && regionSlot === void 0;
			const slotContextBudgets = typeof regionSlot?.contextBudgets === "object" && regionSlot.contextBudgets !== null ? regionSlot.contextBudgets : void 0;
			const legacyContextBudgets = legacySlot && typeof settingsValue === "object" && settingsValue !== null && typeof settingsValue.contextBudgets === "object" && settingsValue.contextBudgets !== null ? settingsValue.contextBudgets : void 0;
			const savedContextBudgets = slotContextBudgets ?? legacyContextBudgets ?? {};
			const slotImageIds = Array.isArray(regionSlot?.imageModelIds) ? regionSlot.imageModelIds.filter((id) => typeof id === "string") : void 0;
			const legacyImageIds = legacySlot && typeof settingsValue === "object" && settingsValue !== null && Array.isArray(settingsValue.imageModelIds) ? settingsValue.imageModelIds.filter((id) => typeof id === "string") : [];
			const savedImageIds = new Set(slotImageIds ?? legacyImageIds);
			const draft = drafts[activeRegion];
			const visibleModels = draft?.models ?? (status.status === "signed-in" ? status.models : []);
			const savedEnabledIds = status.status === "signed-in" ? new Set(status.enabledModelIds) : /* @__PURE__ */ new Set();
			const activeEnabledIds = draft?.enabledIds ?? savedEnabledIds;
			const activeImageIds = draft?.imageIds ?? savedImageIds;
			/**
			* Effective image capability of one row, mirroring what the Host reports to
			* DSH: the user's opt-in unioned with Trae's own `multimodal` flag (issue
			* #16). Rendering the union is what keeps this checkbox truthful — showing the
			* raw `imageModelIds` would draw an unticked box next to a model the plugin
			* is in fact advertising as image-capable.
			*/
			const rowAcceptsImage = (model) => activeImageIds.has(model.id) || model.multimodal === true;
			/**
			* A row Trae itself declares multimodal needs no manual opt-in, so its box is
			* shown ticked and read-only rather than offering a toggle that the union
			* would immediately undo. Turning image input off for such a model is
			* deliberately not supported: the flag is the vendor's own capability answer,
			* and enabling it only lets DSH attach an image the user still has to pick per
			* message — it never sends one by itself.
			*/
			const rowImageIsAutomatic = (model) => model.multimodal === true;
			/** The subscription row's verdict for the current account, when it has one. */
			const payPlan = status.status === "signed-in" && status.payStatus !== void 0 ? payVerdict(status.payStatus) : void 0;
			const activeContextBudgets = draft?.contextBudgets ?? savedContextBudgets;
			const dirty = draft !== void 0;
			/** Apply an edit to the ACTIVE tab's draft, seeding it from the current view. */
			const editDraft = (edit) => {
				setDrafts((prev) => ({
					...prev,
					[activeRegion]: edit(prev[activeRegion] ?? {
						models: [...visibleModels],
						enabledIds: new Set(activeEnabledIds),
						imageIds: new Set(activeImageIds),
						contextBudgets: { ...activeContextBudgets }
					})
				}));
			};
			const toggleModel = (modelId) => {
				editDraft((current) => {
					const next = new Set(current.enabledIds);
					if (!next.delete(modelId)) next.add(modelId);
					return {
						...current,
						enabledIds: next
					};
				});
			};
			const toggleImage = (modelId) => {
				editDraft((current) => {
					const next = new Set(current.imageIds);
					if (!next.delete(modelId)) next.add(modelId);
					return {
						...current,
						imageIds: next
					};
				});
			};
			const setContextBudget = (modelId, budget) => {
				editDraft((current) => {
					const next = { ...current.contextBudgets };
					if (budget === void 0) delete next[modelId];
					else next[modelId] = budget;
					return {
						...current,
						contextBudgets: next
					};
				});
			};
			const discardModels = () => {
				setDrafts((prev) => {
					const next = { ...prev };
					delete next[activeRegion];
					return next;
				});
			};
			const saveModels = async () => {
				if (settingsScope === void 0) return;
				setSaving(true);
				setWriteError(void 0);
				try {
					if (status.status !== "signed-in") return;
					const nextSlot = {
						enabled: regionOn(activeRegion),
						lastCatalog: visibleModels.map((model) => ({
							...model,
							input: ["text"],
							...model.multimodal === void 0 ? {} : { multimodal: model.multimodal }
						})),
						enabledModelIds: [...activeEnabledIds],
						imageModelIds: [...activeImageIds].filter((id) => activeEnabledIds.has(id)),
						contextBudgets: activeContextBudgets
					};
					await writeSettingsField(settingsScope, "regions", nextRegionSlots(configuredRegions, activeRegion, nextSlot), (readBack) => {
						const ids = regionSlotsOf(readBack)[activeRegion]?.enabledModelIds;
						return Array.isArray(ids) && ids.length === nextSlot.enabledModelIds.length && nextSlot.enabledModelIds.every((id) => ids.includes(id));
					});
					discardModels();
					await refreshUsage(activeRegion);
				} catch (error) {
					if (mounted.current) setWriteError(error instanceof Error ? error.message : t("row.requestFailed"));
				} finally {
					if (mounted.current) setSaving(false);
				}
			};
			const title = t("row.title");
			const label = status.status === "signed-in" ? t("row.signedIn", { accountName: status.accountName }) : status.status === "error" ? t("row.requestFailed") : t("row.signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-plugin-card-header",
					"aria-expanded": open,
					"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: "dsm-plugin-card-icon",
							src: TRAE_PLUGIN_ICON,
							alt: ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-plugin-card-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-title",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-description",
								children: t("row.desc")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					hidden: !open,
					children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-trae-usage",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-trae-tabs",
								role: "tablist",
								"aria-label": title,
								children: TRAE_REGIONS.map((item) => {
									const regionStatus = statusByRegion[item];
									const on = regionOn(item);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-trae-tab-cell",
										role: "presentation",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											role: "tab",
											"aria-selected": item === activeRegion,
											className: `dsm-trae-tab${item === activeRegion ? " dsm-trae-tab-active" : ""}${on ? "" : " dsm-trae-tab-off"}`,
											onClick: () => {
												setActiveRegion(item);
											},
											children: [regionStatus === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												className: "dsm-trae-tab-dot",
												style: dotStyle(regionStatus.status)
											}), item === "cn" ? t("row.tabCn") : t("row.tabAi")]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											className: "dsm-trae-tab-switch",
											title: t("row.tabSwitchHint"),
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: on,
												disabled: settingsScope?.getSnapshot().writable !== true || togglingRegion !== void 0,
												"aria-label": t("row.tabSwitchAria", { region: item === "cn" ? t("row.tabCn") : t("row.tabAi") }),
												onChange: (event) => {
													toggleRegion(item, event.currentTarget.checked);
												}
											})
										})]
									}, item);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-trae-tab-hint",
								children: t("row.tabHint")
							}),
							writeError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-trae-usage-error",
								role: "alert",
								children: t("row.settingsWriteFailed", { message: writeError })
							}),
							regionOn(activeRegion) ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-trae-tab-off-notice",
								role: "status",
								children: t("row.tabOffNotice")
							}),
							activeRegion !== "cn" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-trae-mainui-switch",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dsm-trae-mainui-switch-label",
									title: t("row.showPointsInMainUiHint"),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: settingsValue?.showPointsInMainUi === true,
										disabled: settingsScope?.getSnapshot().writable !== true || togglingCredits,
										onChange: (event) => {
											toggleShowPointsInMainUi(event.currentTarget.checked);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.showPointsInMainUi") })]
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-trae-usage-account",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsm-trae-usage-account-copy",
									role: "status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-trae-usage-status",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-hidden": "true",
											className: "dsm-trae-usage-dot",
											style: dotStyle(status.status)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
									}), status.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-trae-usage-expiry",
										children: t("row.tokenExpiry", { expiresAt: formatDateTime(status.tokenExpiresAtMs) })
									}) : null]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									disabled: busy,
									onClick: () => {
										rescanAccounts();
									},
									children: busy ? t("row.accountsScanning") : t("row.refreshTokens")
								})]
							}),
							status.status !== "error" && status.accounts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-trae-account-picker",
								"aria-label": t("row.accountsTitle"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-trae-usage-select-wrap",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
											className: "dsm-trae-usage-select",
											value: status.status === "signed-in" ? status.accountId : "",
											disabled: switchingAccount || settingsScope?.getSnapshot().writable !== true,
											onChange: (event) => {
												switchAccount(event.currentTarget.value);
											},
											children: status.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: account.id,
												children: [
													account.accountName,
													" · ",
													account.region === "ai" ? t("row.regionAi") : t("row.regionCn"),
													" · ",
													t(`row.edition${account.edition === "cn" ? "Cn" : account.edition === "sg" ? "Sg" : account.edition === "solo" ? "Solo" : "SoloSg"}`)
												]
											}, account.id))
										})
									}),
									status.status === "signed-in" && status.alternatives !== void 0 && status.alternatives.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-trae-usage-alternative",
										role: "status",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "dsm-trae-usage-alternative-text",
											children: [
												t("row.creditsExhausted", { account: status.accountName }),
												" ",
												t("row.creditsAlternative", { accounts: status.alternatives.map((alt) => `${alt.accountName}（${t(`row.edition${alt.edition === "cn" ? "Cn" : alt.edition === "sg" ? "Sg" : alt.edition === "solo" ? "Solo" : "SoloSg"}`)}：${formatNumber(alt.workAvailable + alt.generalAvailable)}）`).join("、") })
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-trae-usage-switch-button",
											disabled: switchingAccount || settingsScope?.getSnapshot()?.writable !== true,
											onClick: () => {
												const target = status.alternatives?.[0];
												if (target !== void 0) switchAccount(target.id);
											},
											children: t("row.creditsAlternativeSwitch")
										})]
									}) : null,
									rescanNote === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-trae-usage-note",
										role: "status",
										children: rescanNote
									})
								]
							}) : null,
							status.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								status.payStatus === void 0 || payPlan === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-trae-usage-list",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-trae-usage-stats dsm-trae-usage-stats-two",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-trae-usage-stat dsm-trae-usage-stat-general",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-trae-usage-stat-head",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsm-trae-usage-stat-label",
														children: t("row.subscriptionLabel")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: `dsm-trae-usage-stat-badge ${payPlan.paid ? "dsm-trae-usage-stat-badge-on" : "dsm-trae-usage-stat-badge-off"}`,
														children: t(payPlan.label)
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-value dsm-trae-usage-stat-value-general",
													children: status.payStatus.inTrial && status.payStatus.trialEndTimeMs > 0 ? t("row.trialUntil", { date: formatDateTime(status.payStatus.trialEndTimeMs) }) : [t(payPlan.label), payPlan.tier].filter(Boolean).join(" · ")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-hint",
													children: status.payStatus.enableSoloLite || status.payStatus.enableSoloCoder || status.payStatus.enableSoloBuilder || status.payStatus.enableSoloWeb ? [
														status.payStatus.enableSoloLite ? "SOLO Lite" : "",
														status.payStatus.enableSoloCoder ? "SOLO Coder" : "",
														status.payStatus.enableSoloBuilder ? "SOLO Builder" : "",
														status.payStatus.enableSoloWeb ? "SOLO Web" : ""
													].filter(Boolean).join(" · ") : status.payStatus.isDollarUsageBilling ? "dollar usage billing" : ""
												})
											]
										})
									})
								}),
								status.payStatusError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-trae-usage-error",
									children: t("row.payStatusError", { message: status.payStatusError })
								}),
								status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsm-trae-usage-list",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-trae-usage-stats dsm-trae-usage-stats-two",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-trae-usage-stat dsm-trae-usage-stat-work",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-trae-usage-stat-head",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsm-trae-usage-stat-label",
														children: t("row.workCreditsLabel")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsm-trae-usage-stat-badge dsm-trae-usage-stat-badge-off",
														children: t("row.workNotUsable")
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-value dsm-trae-usage-stat-value-work",
													children: formatNumber(status.credits.workAvailable)
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-hint",
													children: t("row.workUsableHint")
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-trae-usage-stat dsm-trae-usage-stat-general",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-trae-usage-stat-head",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsm-trae-usage-stat-label",
														children: t("row.generalCreditsLabel")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dsm-trae-usage-stat-badge dsm-trae-usage-stat-badge-on",
														children: t("row.generalUsable")
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-value dsm-trae-usage-stat-value-general",
													children: formatNumber(status.credits.generalAvailable)
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-stat-hint",
													children: t("row.generalUsableHint")
												})
											]
										})]
									})
								}),
								status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-trae-usage-error",
									children: t("row.creditsError", { message: status.creditsError })
								}),
								status.checkin === void 0 ? null : (() => {
									const accountClaimed = status.checkin.checkedIn;
									const deviceSpent = !accountClaimed && (status.checkin.didCheckedIn || deviceSpentNotice);
									const reward = formatNumber(status.checkin.credits);
									const bonus = status.checkin.extraCredits === void 0 ? "" : ` + ${formatNumber(status.checkin.extraCredits)}`;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-trae-checkin",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsm-trae-checkin-copy",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-trae-checkin-label",
												children: t("row.checkinLabel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsm-trae-checkin-hint",
												children: [t("row.checkinReward", { reward: `${reward}${bonus}` }), accountClaimed ? ` · ${t("row.checkinDoneHint")}` : ""]
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-primary dsm-trae-checkin-button",
											disabled: !status.checkin.enabled || accountClaimed || deviceSpent || claiming,
											onClick: () => {
												claimCheckin();
											},
											children: claiming ? t("row.checkinClaiming") : accountClaimed ? t("row.checkinClaimed") : t("row.checkinClaim")
										})]
									}), deviceSpent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-trae-checkin-note",
										role: "status",
										children: t("row.checkinDeviceSpent")
									}) : null] });
								})(),
								status.checkin !== void 0 && !status.checkin.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-trae-usage-error",
									children: t("row.checkinDisabled")
								}) : null,
								status.checkinError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-trae-usage-error",
									children: t("row.checkinError", { message: status.checkinError })
								}),
								claimError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-trae-usage-error",
									role: "alert",
									children: t("row.checkinError", { message: claimError })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "dsm-trae-models",
									"aria-label": t("row.modelsTitle"),
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-trae-models-head",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
												className: "dsm-trae-models-title",
												children: t("row.modelsTitle")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "dsm-trae-models-summary",
												children: t("row.modelsSummary", { count: activeEnabledIds.size })
											})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsm-trae-models-actions",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: busy,
													onClick: () => {
														refreshModels();
													},
													children: busy ? t("row.modelsRefreshing") : t("row.modelsRefresh")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: busy || testing !== void 0 || activeEnabledIds.size === 0,
													title: t("row.modelsTestHint"),
													onClick: () => {
														testEnabledModels();
													},
													children: testing === void 0 ? t("row.modelsTestEnabled") : t("row.modelsTesting", {
														done: testing.done,
														total: testing.total
													})
												})]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-trae-models-hint",
											children: t("row.modelsTestHint")
										}),
										testSummary === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-trae-models-summary",
											children: testSummary
										}),
										testError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-trae-usage-error",
											role: "alert",
											children: testError
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsm-trae-model-list",
											children: visibleModels.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: `dsm-trae-model${activeEnabledIds.has(model.id) ? "" : " dsm-trae-model-disabled"}`,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-trae-model-head",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
														className: "dsm-trae-model-enabled",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: activeEnabledIds.has(model.id),
															disabled: settingsScope?.getSnapshot().writable !== true || saving,
															onChange: () => {
																toggleModel(model.id);
															}
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "dsm-trae-model-copy",
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																className: "dsm-trae-model-name",
																children: [
																	model.name,
																	model.creditMultiplier === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																		className: "dsm-trae-model-name-rate",
																		children: ["· x", model.creditMultiplier.toFixed(2)]
																	}),
																	probeBadge(probeByRegion[activeRegion][model.id], t)
																]
															})
														})]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: "dsm-trae-model-options",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															className: "dsm-trae-model-image",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "checkbox",
																checked: rowAcceptsImage(model),
																disabled: rowImageIsAutomatic(model) || settingsScope?.getSnapshot().writable !== true || saving,
																title: rowImageIsAutomatic(model) ? t("row.modelImageAuto") : void 0,
																onChange: () => {
																	toggleImage(model.id);
																}
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelImage") })]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
															className: "dsm-trae-context-budget",
															"aria-label": t("row.contextBudget"),
															children: [model.maxContextWindow !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "radio",
																name: `context-${model.id}`,
																checked: activeContextBudgets[model.id] !== model.maxContextWindow,
																disabled: settingsScope?.getSnapshot().writable !== true || saving,
																onChange: () => {
																	setContextBudget(model.id, model.contextWindow);
																}
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatCapacity(model.contextWindow, t("row.modelUnknown")) })] }) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																type: "radio",
																name: `context-${model.id}`,
																checked: model.maxContextWindow === void 0 || activeContextBudgets[model.id] === model.maxContextWindow,
																disabled: model.maxContextWindow === void 0 || settingsScope?.getSnapshot().writable !== true || saving,
																onChange: () => {
																	setContextBudget(model.id, model.maxContextWindow);
																}
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatCapacity(model.maxContextWindow ?? model.contextWindow, t("row.modelUnknown")) })] })]
														})]
													})]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-trae-model-meta",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelContext", { context: formatCapacity(model.maxContextWindow ?? model.contextWindow, t("row.modelUnknown")) }) }),
														model.maxTokens === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelOutput", { output: formatCapacity(model.maxTokens, t("row.modelUnknown")) }) }),
														model.reasoning === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelReasoning", { efforts: model.reasoning.supported.join(" / ") }) })
													]
												})]
											}, model.id))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "dsm-trae-model-capability-note",
											children: t("row.modelCapabilityPending")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-trae-model-actions",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
												className: "dsm-trae-usage-cheer",
												href: TRAE_GITHUB_URL,
												target: "_blank",
												rel: "noopener noreferrer",
												children: [t("row.cheer"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsm-trae-usage-cheer-star",
													"aria-hidden": "true",
													children: "★"
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsm-trae-model-actions-buttons",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: !dirty || saving,
													onClick: discardModels,
													children: t("row.discard")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-primary",
													disabled: !dirty || saving || activeEnabledIds.size === 0,
													onClick: () => {
														saveModels();
													},
													children: saving ? t("row.saving") : t("row.save")
												})]
											})]
										})
									]
								})
							] }) : null,
							status.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-trae-usage-text",
								children: status.message ?? t("row.signedOutHint")
							}), status.searched && status.searched.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								className: "dsm-trae-searched",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
										t("row.searchedTitle"),
										" (",
										status.searched.length,
										")"
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-trae-searched-hint",
										children: t("row.searchedHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										className: "dsm-trae-searched-list",
										children: status.searched.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: item.path }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsm-trae-searched-reason",
											children: [
												t(item.source === "cli" ? "row.sourceCli" : "row.sourceDesktop"),
												" · ",
												t(item.reason === "missing" ? "row.reasonMissing" : item.reason === "unreadable" ? "row.reasonUnreadable" : "row.reasonInvalid")
											]
										})] }, `${item.source}:${item.path}`))
									})
								]
							}) : null] }) : null,
							status.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-trae-usage-error",
								children: status.message
							}) : null
						]
					}) : null
				})]
			});
		}
		//#endregion
		//#region src/client/popover.ts
		/**
		* The two shell behaviours the composer credit panel needs: hanging the panel
		* off its trigger, and dismissing it on an outside press.
		*
		* Implemented locally rather than imported from
		* `@deepseek-ai/dsh-client-ui-primitives`. The shell DOES register that package
		* for plugin bundles, so importing it is legal — this is a deliberate choice,
		* not a workaround: the two behaviours are ~40 lines of DOM geometry, and owning
		* them keeps this component renderable in the Node test suite without mocking a
		* package that itself reaches `*.module.css` and further DSH dependencies.
		*
		* NOTE ON A MISDIAGNOSIS, kept because it is the kind of thing that gets
		* re-litigated: the 2.12.0/2.13.0 client load failure was first attributed to
		* importing the primitives package. It was not that. The real cause was
		* `import { createPortal } from 'react-dom'` being BUNDLED rather than
		* externalized — the inlined development build opens with
		* `process.env.NODE_ENV` and threw `ReferenceError: process is not defined` in
		* the browser. See `tsdown.config.ts` for the fix and
		* `tests/client-runtime-imports.spec.ts` for the rule that now prevents it.
		*
		* Behaviour is intentionally identical to the shell's implementations: the same
		* top/bottom placement, the same viewport clamping, the same re-measure on
		* scroll (capture, so nested scrollers count), resize and the panel's own size
		* changes, and the same "a pointerdown outside both the trigger and the panel
		* closes it" rule.
		*/
		/**
		* Clearance to keep from the top of the viewport.
		*
		* The shell reserves a strip at the top of the frame (`--dsh-frame-top-clearance`)
		* for the window chrome, so a panel clamped to `margin` alone can still land
		* under it. Absent variable or no `data-fullscreen` distinction is handled the
		* same way the shell does: fall back to `min`.
		*/
		function overlayTopMargin(min) {
			if (typeof document === "undefined") return min;
			const root = document.documentElement;
			const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue("--dsh-frame-top-clearance"));
			if (Number.isNaN(clearance)) return min;
			return Math.max(min, (root.hasAttribute("data-fullscreen") ? 0 : clearance) + 20);
		}
		/** Keep a `position: fixed` floating element anchored to a trigger. */
		function useAnchoredPosition(options) {
			const { open, anchorRef, panelRef, side = "bottom", align = "start", gap, margin } = options;
			const [position, setPosition] = (0, react.useState)(null);
			(0, react.useLayoutEffect)(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const rect = anchorRef.current?.getBoundingClientRect();
					if (rect === void 0) return;
					const panel = panelRef.current;
					const width = panel?.offsetWidth ?? 0;
					const height = panel?.offsetHeight ?? 0;
					let left = align === "end" ? rect.right - width : rect.left;
					let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
					if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
					if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin);
					setPosition({
						left,
						top
					});
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				const panel = panelRef.current;
				let observer = null;
				if (typeof ResizeObserver !== "undefined" && panel !== null) {
					observer = new ResizeObserver(place);
					observer.observe(panel);
				}
				return () => {
					observer?.disconnect();
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [
				open,
				anchorRef,
				panelRef,
				side,
				align,
				gap,
				margin
			]);
			return position;
		}
		/**
		* Close an open popover when a pointerdown lands outside it.
		*
		* `portal` counts as inside: the panel is portaled to `document.body`, so it is
		* not a descendant of `root` and a click on the panel itself would otherwise
		* read as "outside" and dismiss the popover the user is trying to use.
		*/
		function useDismissOnOutsidePointer(root, open, setOpen, portal) {
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const closeOutside = (event) => {
					if (event.target instanceof Node && root.current?.contains(event.target) !== true && portal?.current?.contains(event.target) !== true) setOpen(false);
				};
				document.addEventListener("pointerdown", closeOutside);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
				};
			}, [
				root,
				open,
				setOpen,
				portal
			]);
		}
		//#endregion
		//#region src/client/ComposerPoints.tsx
		/**
		* Credit readout for the composer tool row (`conversation.input.left`).
		*
		* Shows the bound CN account's general credit balance, but ONLY while the
		* session's selected model belongs to this plugin. That condition is the whole
		* point: the sidebar foot is a single shared row, so two connector plugins each
		* parking a line there end up fighting for the same space. The composer row is
		* per-session and provider-scoped, so exactly one plugin's credits are relevant
		* at a time and nothing overlaps.
		*
		* The row itself is a bare clickable readout — `Trae CN · 657` — with NO
		* refresh control. Clicking it opens an anchored panel: a TABLE with one row
		* per account in the region and that account's general balance, where a row
		* click switches to it. The manual refresh button lives in the panel too.
		*
		* Two deliberate choices in that panel:
		*
		*  - GENERAL balance only, not Work credits. The table's one figure is the
		*    bucket the SOLO chat actually spends; two columns of numbers in a
		*    five-slot popover is noise, and the card is where the breakdown belongs.
		*  - Per-account figures are fetched ONLY while the panel is open. The
		*    5-minute readout must not multiply its upstream reads by the account
		*    count — a healthy balance should not pay for a table nobody is looking at.
		*    This is the same principle that keeps `creditAlternatives` firing only
		*    when a balance hits zero.
		*
		* The provider comes from the Host's own `modelSelection` projection rather
		* than from anything this plugin tracks: the projection is what the model
		* picker writes and what the next request will use, so the readout cannot
		* disagree with the model actually in effect.
		*/
		/**
		* Inject the readout's styles into the document head, once, on module load.
		*
		* Same idempotent pattern as the card's injection, and for the same reason: the
		* classes are attached to DOM this component owns, and `.dsm-card-*` lives in
		* `TRAE_CARD_CSS` — which only loads when the settings card does. Before this
		* existed (2.13.0–2.13.4) the trigger rendered as the browser's default button
		* box and the panel, with no `position: fixed`, had its measured left/top
		* ignored and appeared nowhere.
		*/
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-trae/composer-points.css";
			if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-connect-trae";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = COMPOSER_POINTS_CSS;
				document.head.appendChild(styleTag);
			}
		}
		/**
		* Automatic refresh period. Five minutes, matching the sidebar line: a credit
		* balance moves on the scale of model calls, not seconds, and each read is two
		* read-only upstream calls.
		*/
		const COMPOSER_POINTS_REFRESH_INTERVAL_MS = 3e5;
		/**
		* Provider routes whose credit balance this readout can show, mapped to the
		* region to read it from.
		*
		* CN ONLY, and the restriction is the data's, not a preference: the Host builds
		* the international region's usage document from `payStatus` and never sets
		* `credits` on it (`webStatusFor` returns early for `region === 'ai'`), because
		* that side is subscription-based and has no comparable balance. Mapping
		* `trae-global` here would render the hardcoded "Trae CN" label next to a dash
		* — a number-slot with no number — while an international model is selected.
		*
		* Mirrors the CN half of `TRAE_PROVIDERS` on the host side; duplicated here
		* because the client bundle must not import the host entry.
		*/
		const TRAE_COMPOSER_PROVIDERS = { "trae": "cn" };
		/** The general credit balance out of one usage document, or undefined. */
		function generalCreditsOf(usage) {
			if (usage.status !== "signed-in") return void 0;
			return usage.credits?.generalAvailable;
		}
		/** Group the digits so a four-figure balance stays readable in a narrow row. */
		function formatCredits(value) {
			return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
		}
		function formatClock(value) {
			return new Date(value).toLocaleTimeString("zh-CN", {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		function ComposerPoints(props) {
			const { t, provider, region, settingsScope } = props;
			if (t === void 0) throw new Error("Composer points readout requires its translation function");
			const owned = provider === void 0 ? void 0 : TRAE_COMPOSER_PROVIDERS[provider];
			const activeRegion = region ?? owned;
			const [usage, setUsage] = (0, react.useState)(void 0);
			const [accountCredits, setAccountCredits] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [switchingId, setSwitchingId] = (0, react.useState)(void 0);
			const [failed, setFailed] = (0, react.useState)(false);
			const [lastRefresh, setLastRefresh] = (0, react.useState)(void 0);
			const [open, setOpen] = (0, react.useState)(false);
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(true);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const position = useAnchoredPosition({
				open: open && activeRegion !== void 0,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: 8,
				margin: 12
			});
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			const fetchUsage = (0, react.useCallback)(async (signal) => {
				if (inFlight.current || activeRegion === void 0) return;
				inFlight.current = true;
				if (mounted.current) setBusy(true);
				try {
					const response = await fetch(withTraeRegion(TRAE_USAGE_PATH, activeRegion), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const value = await response.json();
					if (!mounted.current || signal?.aborted === true) return;
					setUsage(value);
					setLastRefresh(Date.now());
					setFailed(false);
				} catch {
					if (mounted.current && signal?.aborted !== true) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			}, [activeRegion]);
			/**
			* Every account's general balance — one upstream read per account.
			*
			* Paid only while the panel is open (see the note at the top of this file).
			* A failure keeps whatever we already have rather than clearing it: a number
			* that went stale is better than a switch that vanished.
			*/
			const fetchAccountCredits = (0, react.useCallback)(async (signal) => {
				if (activeRegion === void 0) return;
				try {
					const response = await fetch(withTraeRegion(TRAE_ACCOUNT_CREDITS_PATH, activeRegion), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					if (!mounted.current || signal?.aborted === true) return;
					if (Array.isArray(data.accounts)) setAccountCredits(data.accounts);
				} catch {}
			}, [activeRegion]);
			(0, react.useEffect)(() => {
				if (owned === void 0) return void 0;
				let cancelled = false;
				let timer;
				const controller = new AbortController();
				fetchUsage(controller.signal).finally(() => {
					if (cancelled) return;
					timer = window.setInterval(() => {
						fetchUsage(controller.signal);
					}, COMPOSER_POINTS_REFRESH_INTERVAL_MS);
				});
				return () => {
					cancelled = true;
					if (timer !== void 0) window.clearInterval(timer);
					controller.abort();
				};
			}, [owned, fetchUsage]);
			(0, react.useEffect)(() => {
				if (!open || activeRegion === void 0) return void 0;
				const controller = new AbortController();
				fetchAccountCredits(controller.signal);
				return () => {
					controller.abort();
				};
			}, [
				open,
				activeRegion,
				fetchAccountCredits
			]);
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			/**
			* Switch to another account, then re-read both the usage document and the
			* table so the marker, the readout, and the panel all move together.
			*
			* The merge goes through the shared `configuredAccountsOf` helper (the card
			* uses the same one): writing only `[region]: id` would drop the other
			* region's selection. The write is read-back checked — `set()` resolving is
			* not proof it landed — so a refused write reports failure instead of
			* showing a marker on an account that was never selected.
			*/
			const switchTo = async (accountId) => {
				if (settingsScope === void 0 || settingsScope.getSnapshot().writable !== true) return;
				if (activeRegion === void 0 || switchingId !== void 0) return;
				if (accountId === (accountCredits?.find((account) => account.selected)?.id ?? (usage?.status === "signed-in" ? usage.accountId : void 0))) return;
				setSwitchingId(accountId);
				setFailed(false);
				try {
					const configured = configuredAccountsOf(settingsScope.getSnapshot().value);
					const accepted = await settingsScope.set("accounts", {
						...configured,
						[activeRegion]: accountId
					});
					const readBack = configuredAccountsOf(settingsScope.getSnapshot().value);
					if (accepted === false || readBack[activeRegion] !== accountId) throw new Error("the Host did not persist the switch");
					await fetchUsage();
					await fetchAccountCredits();
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					if (mounted.current) setSwitchingId(void 0);
				}
			};
			if (owned === void 0) return null;
			const signedIn = usage?.status === "signed-in" ? usage : void 0;
			const general = signedIn === void 0 ? void 0 : generalCreditsOf(signedIn);
			const signedOut = usage !== void 0 && usage.status === "signed-out";
			const valueText = general === void 0 ? "—" : formatCredits(general);
			const label = t("composer.points");
			/**
			* The table's rows: every account in this region, with its general balance.
			*
			* The endpoint's answer is authoritative (it carries the figures). Before it
			* lands — or if it fails — fall back to the usage document's account list so
			* the switches are reachable immediately, showing `—` for the figure rather
			* than a spinner the user has to wait on.
			*/
			const selectedId = accountCredits?.find((account) => account.selected)?.id ?? (signedIn === void 0 ? void 0 : signedIn.accountId);
			const rows = (accountCredits ?? (signedIn === void 0 ? [] : signedIn.accounts.filter((account) => account.region === activeRegion).map((account) => ({
				id: account.id,
				accountName: account.accountName,
				selected: account.selected
			})))).map((row) => {
				if (row.id !== selectedId || row.generalAvailable !== void 0 || general === void 0) return row;
				return {
					...row,
					generalAvailable: general
				};
			});
			const canSwitch = settingsScope !== void 0 && settingsScope.getSnapshot().writable === true;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: "dsm-trae-composer-points",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-trae-composer-points-trigger",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						label,
						" · ",
						valueText
					]
				}), open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: "dsm-trae-composer-panel",
					style: position ?? {
						visibility: "hidden",
						left: 0,
						top: 0
					},
					role: "dialog",
					"aria-label": t("composer.panelTitle"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-trae-composer-panel-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-trae-composer-panel-title",
								children: t("composer.panelTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-trae-composer-panel-refresh",
								disabled: busy || switchingId !== void 0,
								onClick: () => {
									fetchUsage();
								},
								children: busy ? t("composer.refreshing") : t("composer.refresh")
							})]
						}),
						signedOut ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-trae-composer-panel-empty",
							children: t("composer.signedOut")
						}) : rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-trae-composer-panel-empty",
							children: t("composer.noAccounts")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: "dsm-trae-composer-panel-table",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								children: t("composer.account")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								className: "dsm-trae-composer-panel-num",
								children: t("composer.generalCredits")
							})] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row) => {
								const current = row.id === selectedId;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									className: current ? "dsm-trae-composer-panel-row-current" : void 0,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "row",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsm-trae-composer-panel-switch",
											disabled: !canSwitch || switchingId !== void 0 || current,
											"aria-label": t("composer.switchTo", { account: row.accountName }),
											onClick: () => {
												switchTo(row.id);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsm-trae-composer-panel-dot",
												"aria-hidden": "true"
											}), row.accountName]
										})
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "dsm-trae-composer-panel-num",
										children: row.generalAvailable === void 0 ? "—" : formatCredits(row.generalAvailable)
									})]
								}, row.id);
							}) })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-trae-composer-panel-foot",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("composer.lastRefresh"),
								" ",
								lastRefresh === void 0 ? "—" : formatClock(lastRefresh)
							] })
						}),
						failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-trae-composer-panel-error",
							role: "status",
							children: t("composer.refreshFailed")
						}) : null
					]
				}), document.body)]
			});
		}
		//#endregion
		//#region src/client/ComposerPointsGate.tsx
		/**
		* Decides whether the composer credit readout belongs in this session, by
		* reading the Host's own `modelSelection` projection and the plugin's
		* `showPointsInMainUi` switch.
		*
		* Kept separate from {@link ComposerPoints} (and from the browser-plugin entry)
		* so the decision can be unit-tested without a Host: the entry imports
		* browser-only DSH packages the test environment cannot load, while this module
		* depends only on React and a narrow projection shape.
		*
		* WHY the projection rather than this plugin's own state: the projection is
		* what the model picker writes and what the next request will use, so the
		* readout cannot disagree with the model actually in effect. `next` outranks
		* `lastUsed` because a selection that has been made but not yet sent is still
		* what the composer shows the user.
		*
		* The switch is read the same way the retired sidebar gate read it: absent or
		* false means OFF, and only an explicit `true` shows the readout. The composer
		* row is shared with the shell's own permission/agent/model controls, so the
		* readout must be asked for, not imposed — 2.13.0 rendered it unconditionally
		* and 2.13.3 restored the opt-in after the user went looking for the switch.
		*/
		/**
		* The provider route the session is currently pointed at.
		*
		* `next` wins over `lastUsed`: a switch that has landed but not yet been sent
		* is still the selection the composer displays.
		*/
		function selectedProviderOf(projection) {
			const provider = (projection?.next ?? projection?.lastUsed)?.provider;
			return typeof provider === "string" && provider !== "" ? provider : void 0;
		}
		/**
		* Read the composer-readout switch out of a committed settings snapshot.
		*
		* Absent means OFF, matching the host default (`false`): a scope that has not
		* populated yet, or a host too old to serve the field, must not put a row in
		* the composer toolbar that the user never asked for.
		*/
		function composerPointsEnabledOf(scope) {
			if (scope === void 0) return false;
			return unwrapVolatileDeep(scope.getSnapshot().value)?.showPointsInMainUi === true;
		}
		function ComposerPointsGate(props) {
			const { t, settingsScope, useProjection } = props;
			const [enabled, setEnabled] = (0, react.useState)(() => composerPointsEnabledOf(settingsScope));
			(0, react.useEffect)(() => settingsScope?.subscribe(() => {
				setEnabled(composerPointsEnabledOf(settingsScope));
			}), [settingsScope]);
			const projection = useProjection === void 0 ? void 0 : useProjection("modelSelection");
			if (!enabled) return null;
			const provider = selectedProviderOf(projection);
			const region = provider === void 0 ? void 0 : TRAE_COMPOSER_PROVIDERS[provider];
			if (region === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerPoints, {
				t,
				provider,
				region,
				...settingsScope === void 0 ? {} : { settingsScope }
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the settings.trae locale namespace.
		* Key shape follows `dsh-subagent-default-model`'s `row.*` convention so the
		* two plugins share one external-presentation language.
		*/
		const en = {
			"row.title": "Trae credits & models (dsh-connect-trae)",
			"row.desc": "Use Trae models in DSH and see your remaining credits; the domestic and international sides are two independent providers, each with its own account — use both at the same time.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.tabCn": "Domestic",
			"row.tabAi": "Global",
			"row.tabHint": "Each tab is a separate provider (trae / trae-global) with its own account, usage, and models. Both sides are live at once: different sessions can pick from either side, and changes on one tab never touch the other.",
			"row.tabSwitchHint": "Uncheck to switch this provider off. Its models disappear from the DSH model picker; its account, usage, and model settings are kept and return when you check it again.",
			"row.tabSwitchAria": "Offer the {region} provider to DSH",
			"row.tabOffNotice": "This provider is switched off: none of its models are offered to DSH. Your account, usage, and model settings are kept — check the box above the tab to bring it back.",
			"row.settingsWriteFailed": "The setting was not saved: {message}",
			"row.signedOut": "Not signed in",
			"row.signedOutHint": "Sign in once in the Trae desktop app; this plugin follows that sign-in automatically.",
			"row.searchedTitle": "Paths checked",
			"row.searchedHint": "No sign-in was found. These locations were probed; if your Trae stores its login elsewhere, please report the path.",
			"row.searchedMore": "Show {count} more",
			"row.reasonMissing": "not found",
			"row.reasonUnreadable": "unreadable",
			"row.reasonInvalid": "unreadable format",
			"row.sourceDesktop": "desktop app",
			"row.sourceCli": "Trae CLI",
			"row.signedIn": "Signed in: {accountName}",
			"row.tokenExpiry": "Access token expires {expiresAt} (auto-renewal)",
			"row.requestFailed": "Request failed",
			"row.creditsAvailableLabel": "Available",
			"row.workCreditsLabel": "Work credits",
			"row.generalCreditsLabel": "General credits",
			"row.workNotUsable": "Not usable in DSH",
			"row.generalUsable": "Usable",
			"row.workUsableHint": "Only inside the Trae app",
			"row.generalUsableHint": "Powers DSH chat & tools",
			"row.creditsConsumedLabel": "Consumed",
			"row.creditsTotalLabel": "Total",
			"row.creditsError": "Usage unavailable: {message}",
			"row.checkinLabel": "Daily check-in",
			"row.checkinReward": "{reward} credits per day",
			"row.checkinClaim": "Claim today",
			"row.checkinClaiming": "Claiming…",
			"row.checkinClaimed": "Claimed today",
			"row.checkinDoneHint": "come back tomorrow",
			"row.checkinRefused": "Trae refused the check-in (code {code})",
			"row.checkinError": "Check-in failed: {message}",
			"row.checkinDeviceSpent": "This machine already used today's check-in — Trae allows one per device per day, so this account cannot claim here today. Claim it on another device or from the account that checked in, or come back tomorrow.",
			"row.checkinDisabled": "This account has no check-in activity available.",
			"row.regionCn": "CN",
			"row.regionAi": "International",
			"row.subscriptionLabel": "Subscription",
			"row.subscribed": "Active package",
			"row.noPackage": "No active package",
			"row.trialUntil": "Trial until {date}",
			"row.payStatusError": "Subscription status unavailable: {message}",
			"row.refresh": "Refresh",
			"row.refreshTokens": "Refresh accounts & tokens",
			"row.refreshCredits": "Refresh usage",
			"row.refreshing": "Refreshing…",
			"row.accountsTitle": "Trae account",
			"row.accountsHint": "Choose from locally detected sign-ins. Tokens are never shown or saved in DSH settings.",
			"row.accountsRescan": "Detect accounts again",
			"row.accountsScanning": "Detecting…",
			"row.modelsTitle": "Models",
			"row.modelsSummary": "{count} enabled",
			"row.modelsRefresh": "Refresh from Trae",
			"row.modelsRefreshing": "Refreshing models…",
			"row.modelsTestEnabled": "Test enabled models",
			"row.modelsTesting": "Testing {done}/{total}…",
			"row.modelsTestHint": "Sends one minimal message per enabled model to see which ones actually answer. Costs a small amount of quota.",
			"row.showPointsInMainUi": "Show credits in the composer row",
			"row.showPointsInMainUiHint": "Show a clickable Trae CN · <balance> readout in the composer tool row, only while the selected model belongs to this plugin. Click it for the account and balance panel.",
			"composer.switchTo": "Switch to {account}",
			"composer.noAccounts": "No account in this region",
			"composer.panelTitle": "Trae credits",
			"composer.account": "Account",
			"composer.generalCredits": "General credits",
			"composer.lastRefresh": "Last refreshed",
			"composer.signedOut": "Not signed in",
			"composer.points": "Trae CN",
			"composer.refresh": "Refresh credits",
			"composer.refreshing": "Refreshing credits…",
			"composer.refreshFailed": "Could not refresh credits",
			"row.accountsRefreshed": "Accounts refreshed: {count} found{selected}",
			"row.accountsKept": "still bound to",
			"row.accountsRefreshedNone": "Accounts refreshed: no usable Trae account found",
			"row.accountsRescanFailed": "Could not refresh accounts: {message}",
			"row.editionCn": "Trae",
			"row.editionSg": "Trae (international)",
			"row.editionSolo": "TRAE SOLO",
			"row.editionSoloSg": "TRAE SOLO (international)",
			"row.creditsExhausted": "The bound account ({account}) has run out of credit",
			"row.creditsAlternative": "Another account on this machine still has credit: {accounts}",
			"row.creditsAlternativeSwitch": "Switch to it",
			"row.modelsTestEmpty": "Enable at least one model first.",
			"row.modelsTestError": "Test failed: {message}",
			"row.modelsTestDone": "{available} of {total} answered.",
			"row.probeAvailable": "works",
			"row.probeGated": "needs a higher plan",
			"row.probeUnsupported": "not served",
			"row.probeRateLimited": "throttled",
			"row.probeAuth": "sign-in rejected",
			"row.probeUnknown": "not determined",
			"row.modelEnabled": "Enabled",
			"row.discard": "Discard changes",
			"row.save": "Save",
			"row.saving": "Saving…",
			"row.modelContext": "Max context {context}",
			"row.contextBudget": "DSH context budget",
			"row.modelOutput": "Output {output}",
			"row.modelImage": "Image",
			"row.modelImageAuto": "Enabled automatically: Trae marks this model multimodal.",
			"row.modelRate": "{rate}x credits",
			"row.modelReasoning": "Reasoning: {efforts}",
			"row.modelReasoningSupported": "Reasoning: supported",
			"row.modelUnknown": "Unknown",
			"row.modelCapabilityPending": "Image input follows Trae's own multimodal flag, plus anything you tick yourself.",
			"row.cheer": "Star on GitHub"
		};
		const zh = {
			"row.title": "接入使用Trae积分与模型（dsh-connect-trae）",
			"row.desc": "在 DSH 中使用 Trae 模型并随时查看剩余积分；国内版与国际版是两个独立供应商，各有自己的账号，可同时使用。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.tabCn": "国内版",
			"row.tabAi": "国际版",
			"row.tabHint": "每个 tab 是一个独立供应商（trae / trae-global），各有自己的账号、用量与模型。两边同时生效：不同会话可各选一边，一侧的改动不影响另一侧。",
			"row.tabSwitchHint": "取消勾选即关闭该供应商：它的模型不再出现在 DSH 模型选择器里；账号、用量与模型设置都会保留，重新勾选即恢复。",
			"row.tabSwitchAria": "是否向 DSH 提供{region}供应商",
			"row.tabOffNotice": "该供应商已关闭：它的模型不会提供给 DSH。账号、用量与模型设置均已保留——勾选上方复选框即可恢复。",
			"row.settingsWriteFailed": "设置未能保存：{message}",
			"row.signedOut": "未登录",
			"row.signedOutHint": "在 Trae 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			"row.searchedTitle": "已检查的路径",
			"row.searchedHint": "未找到登录信息。以下是插件探测过的位置；如果你的 Trae 把登录信息存在别处，请把该路径反馈给我们。",
			"row.searchedMore": "展开其余 {count} 条",
			"row.reasonMissing": "文件不存在",
			"row.reasonUnreadable": "无法读取",
			"row.reasonInvalid": "格式无法识别",
			"row.sourceDesktop": "桌面版",
			"row.sourceCli": "Trae CLI",
			"row.signedIn": "已登录：{accountName}",
			"row.tokenExpiry": "访问令牌 {expiresAt} 过期（自动续期）",
			"row.requestFailed": "请求失败",
			"row.creditsAvailableLabel": "可用",
			"row.workCreditsLabel": "Work 积分",
			"row.generalCreditsLabel": "通用积分",
			"row.workNotUsable": "DSH 不可用",
			"row.generalUsable": "可用",
			"row.workUsableHint": "仅限 Trae 客户端内使用",
			"row.generalUsableHint": "供 DSH 聊天与工具使用",
			"row.creditsConsumedLabel": "消耗",
			"row.creditsTotalLabel": "合计",
			"row.creditsError": "用量查询失败：{message}",
			"row.checkinLabel": "每日签到",
			"row.checkinReward": "每日 {reward} 积分",
			"row.checkinClaim": "立即领取",
			"row.checkinClaiming": "领取中…",
			"row.checkinClaimed": "今日已领取",
			"row.checkinDoneHint": "明天再来",
			"row.checkinRefused": "Trae 拒绝了本次签到（业务码 {code}）",
			"row.checkinError": "签到失败：{message}",
			"row.checkinDeviceSpent": "本机今日的签到已用掉——Trae 按「每台设备每天一次」限制，所以当前账号在本机今天无法再签。可换一台设备领取，或用今天已签到的那台设备/账号，或明天再来。",
			"row.checkinDisabled": "该账号当前没有可用的签到活动。",
			"row.regionCn": "国内版",
			"row.regionAi": "国际版",
			"row.subscriptionLabel": "订阅状态",
			"row.subscribed": "已有有效套餐",
			"row.noPackage": "暂无有效套餐",
			"row.trialUntil": "试用至 {date}",
			"row.payStatusError": "订阅状态查询失败：{message}",
			"row.refresh": "刷新",
			"row.refreshTokens": "刷新账号与 Token",
			"row.refreshCredits": "刷新用量",
			"row.refreshing": "正在刷新…",
			"row.accountsTitle": "Trae 账号",
			"row.accountsHint": "选择本机检测到的登录账号；Token 不会显示，也不会保存到 DSH 设置。",
			"row.accountsRescan": "重新检测账号",
			"row.accountsScanning": "正在检测…",
			"row.modelsTitle": "模型",
			"row.modelsSummary": "已启用 {count} 个",
			"row.modelsRefresh": "从 Trae 刷新",
			"row.modelsRefreshing": "正在刷新模型…",
			"row.modelsTestEnabled": "一键测试启用模型",
			"row.modelsTesting": "正在测试 {done}/{total}…",
			"row.modelsTestHint": "给每个已启用模型发一条最小消息，看哪些真的能应答。会消耗少量额度。",
			"row.showPointsInMainUi": "在输入框工具栏显示积分读数",
			"row.showPointsInMainUiHint": "在输入框工具栏显示可点击的「Trae CN · 余额」读数，仅当选中的模型属于本插件时出现；点击可查看账号与积分明细。",
			"composer.switchTo": "切换到 {account}",
			"composer.noAccounts": "该区域暂无账号",
			"composer.panelTitle": "Trae 积分",
			"composer.account": "账号",
			"composer.generalCredits": "通用积分",
			"composer.lastRefresh": "最近刷新",
			"composer.signedOut": "未登录",
			"composer.points": "Trae CN",
			"composer.refresh": "刷新积分",
			"composer.refreshing": "正在刷新积分…",
			"composer.refreshFailed": "积分刷新失败",
			"row.accountsRefreshed": "已刷新账号：找到 {count} 个账号{selected}",
			"row.accountsKept": "仍绑定",
			"row.accountsRefreshedNone": "已刷新账号：未找到可用的 Trae 账号",
			"row.accountsRescanFailed": "刷新账号失败：{message}",
			"row.editionCn": "Trae",
			"row.editionSg": "Trae 国际版",
			"row.editionSolo": "TRAE SOLO",
			"row.editionSoloSg": "TRAE SOLO 国际版",
			"row.creditsExhausted": "当前绑定账号（{account}）额度已用尽",
			"row.creditsAlternative": "本机还有可用账号：{accounts}",
			"row.creditsAlternativeSwitch": "切换到它",
			"row.modelsTestEmpty": "请先启用至少一个模型。",
			"row.modelsTestError": "测试失败：{message}",
			"row.modelsTestDone": "{total} 个里有 {available} 个正常应答。",
			"row.probeAvailable": "可用",
			"row.probeGated": "需要更高档位",
			"row.probeUnsupported": "上游不提供",
			"row.probeRateLimited": "被限流",
			"row.probeAuth": "登录凭据被拒",
			"row.probeUnknown": "本次未测出",
			"row.modelEnabled": "启用模型",
			"row.discard": "放弃修改",
			"row.save": "保存",
			"row.saving": "保存中…",
			"row.modelContext": "最大上下文 {context}",
			"row.contextBudget": "DSH 上下文预算",
			"row.modelOutput": "最大输出 {output}",
			"row.modelImage": "图片",
			"row.modelImageAuto": "已自动开启：Trae 把该模型标为多模态。",
			"row.modelRate": "积分 {rate}x",
			"row.modelReasoning": "推理强度：{efforts}",
			"row.modelReasoningSupported": "推理：支持",
			"row.modelUnknown": "未知",
			"row.modelCapabilityPending": "图片输入跟随 Trae 自身的多模态标注，并叠加你手动勾选的模型。",
			"row.cheer": "鼓励一下"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-connect-trae-client";
		/**
		* Client services required by the Plugin configuration contribution.
		*
		* Deliberately only the two services the 0.1.7 line provides unconditionally:
		* `slots` (card injection) and `locale` (copy). The settings surface is probed
		* through `ctx.get()` (which returns undefined, never throws, for an absent
		* service), so the card degrades to read-only rather than failing to load if
		* configForms is not served yet.
		*/
		const inject = ["slots", "locale"];
		/**
		* Register card copy and the Trae card under Plugin configuration.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change (for
		* example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
		* to a `console.error` instead of throwing into the DSH loader and raising
		* the red "Failed to load plugins" banner. The host provider keeps working:
		* the `trae` model channel is unaffected.
		*
		* NOTE: the try/catch boundary of this function is mirrored (duplicated) in
		* `tests/client-fallback.spec.ts`, because the real client entry imports
		* browser-only DSH packages that cannot load in the Node test environment.
		* If you change the guarded body, the soft probe, or the per-slot
		* registration here, update that mirror too.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.trae";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-connect-trae: settings copy");
				const t = ctx.locale.bind(namespace);
				const softGet = (name) => ctx.get(name);
				const forms = softGet("configForms");
				/**
				* The card's settings scope, bound to whichever namespace the Host actually
				* serves — resolved from the describe mirror, and RE-BOUND whenever the
				* mirror changes.
				*
				* The mirror answers asynchronously relative to this plugin's `apply()`
				* (and, on a profile reload, may gain namespaces that did not exist at
				* boot — this plugin's entry is exactly such a case). Resolving the
				* namespace ONCE at apply time and falling back to the declared constant
				* is a real failure: the form controller is bound to its namespace forever,
				* so a card whose entry appeared after the mirror's first load writes to
				* `trae` — a namespace the host does not serve — and every write is
				* refused (`No configurable plugin entry "trae"`), while the controls stay
				* enabled (the mirror reports global `writable` even when the namespace is
				* missing).
				*
				* The scope therefore forwards every read/write to the CURRENT controller:
				* once the mirror lists the trae namespace (any name matching `/trae/i`,
				* e.g. `dsh-connect-trae` or `include:dsh-connect-trae`), the card lands on
				* the right namespace and re-renders through its own subscription. Before
				* the mirror answers, the scope reports `writable: false` so the card is
				* read-only rather than offering controls that cannot save.
				*/
				const settingsScope = (() => {
					let current;
					let currentOff;
					let refreshedOnce = false;
					const listeners = /* @__PURE__ */ new Set();
					const notify = () => {
						for (const listener of [...listeners]) listener();
					};
					const scope = {
						getSnapshot: () => current?.getSnapshot() ?? {
							status: "unavailable",
							value: void 0,
							writable: false
						},
						subscribe: (listener) => {
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						},
						set: (field, value) => current !== void 0 ? current.set(field, value) : Promise.resolve(false)
					};
					const rebind = () => {
						let served;
						try {
							served = (forms?.describe().getSnapshot().view?.namespaces ?? []).find((entry) => entry.ns === "trae" || /trae/i.test(entry.ns));
						} catch {}
						const next = served === void 0 || forms === void 0 ? void 0 : forms.get(served.ns);
						if (next !== current) {
							currentOff?.();
							current = next;
							currentOff = current?.subscribe(notify);
							notify();
						}
						if (next === void 0 && !refreshedOnce) {
							refreshedOnce = true;
							try {
								(forms?.describe()).load?.();
							} catch {}
						}
					};
					rebind();
					forms?.describe().subscribe?.(rebind);
					return scope;
				})();
				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => ({
								t,
								settingsScope
							})
						}, TraeUsageCard));
					} catch (error) {
						console.error(`[dsh-connect-trae] card slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard("plugins.bundle.config", "dsh-connect-trae");
				registerCard("plugins.row.config", "dsh-connect-trae#dsh-connect-trae");
				/**
				* Credit readout in the composer tool row (`conversation.input.left`, a
				* session-scope list slot).
				*
				* Provider-scoped on purpose: it renders only while the session's selected
				* model belongs to this plugin. That is what keeps two connector plugins
				* from competing for one shared row — the sidebar foot, where this line used
				* to live, is a single root row, and the observed result beside
				* dsh-connect-workbuddy's two rows was this plugin's line squeezed down to a
				* clipped "Tr".
				*
				* Registration is unconditional; the gate reads the Host's modelSelection
				* projection and returns null for every other provider, so nothing is drawn
				* and no fetch loop starts while another provider is selected.
				*/
				const registerComposerPoints = () => {
					try {
						ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
							name: "conversation.input.left",
							id: "dsh-connect-trae-composer-points",
							order: 4,
							locale: namespace,
							inject: () => ({
								t,
								settingsScope
							})
						}, ComposerPointsGate));
					} catch (error) {
						console.error("[dsh-connect-trae] composer points slot failed to register (host provider unaffected):", error);
					}
				};
				registerComposerPoints();
			} catch (error) {
				console.error("[dsh-connect-trae] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
