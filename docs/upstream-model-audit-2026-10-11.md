# 三个反代「获取上游模型」链路审计 & Qoder 图片问题定位

- **日期**：2026-10-11
- **审计对象**：`dsh-wotr-console` 包内三个 provider
  - `llm-workbuddy-xdpool` → `vendor/xdpool/lib/index.js`（vendor 1.7.1 + 本 fork 1.1.0）
  - `dsh-connect-trae` → `lib/trae.js`
  - `dsh-connect-qoder` → `lib/qoder.js` + `lib/qoder-*.mjs`
- **宿主版本**：`@deepseek-ai/dsh-llm@0.2.0-c.2`、`@deepseek-ai/dsh-llm-pi-ai@0.2.0-c.2`、`@earendil-works/pi-ai@0.87.1`、`dsh-api-session-controller`（仅存在于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）
- **修订版本**：审计期间工作树**仍在被并发改写**（mtime 16:40–16:56），下文行号以 2026-10-11 16:56 的版本为准；关键处同时给出代码原文，便于比对。
- **副作用声明**：审计过程**未改动仓库任何文件**。唯一一次真实网络请求是**只读**的 Qoder 目录 GET（用盘上已有凭据，幂等、无计费）。审计中一次 `pnpm test` 意外触发 `pnpm install`，产生了 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/`（177 MB）；三者均已删除，工作树恢复为「14 个 M、0 个未跟踪文件」。
- **收尾**：**§九** 记录同日晚间的修复落地 —— 「结论速览」表里所有 ❌ 已逐格补齐（每格都配了会红的断言），并列出**刻意未改**的项。那份改动**尚未部署到 profile**：需要跑 `tools/apply-wotr.sh` 并重启 DSH（ES module 有缓存，热重载不会重新加载代码）。

---

## 结论速览

**问题一（三条链路是否正确）**：三条链路骨架完全一致（拉上游 → 信封解包 → 逐条解析 → 兜底表 → 声明给 DSH），但**能力字段的解析完整度差一个档次**：

| | WorkBuddy | Trae | Qoder |
|---|---|---|---|
| 上游能力字段 | `supportsImages` ✅ 解析 | `multimodal` ✅ 解析 | **`is_vl` 存在但完全没解析** ❌ |
| 用户手动补勾 | `imageModelIds`（并集） | `imageModelIds`（并集） | **无此配置项** ❌ |
| 模型白名单 | `agents[cli].models` ✅ | wire `callableKeys` ✅ | **`enabledModelIds` 声明了但完全没用** ❌ |
| 上下文双窗口 | `contextBudgets`（只压低） | `dev`/`Max` 双档 + `contextBudgets` | **`context_config` 有 1M 档未读；`contextBudgets` 是死配置** ❌ |
| 兜底表 | 10 行 | cn 4 / ai 7 行 | **9 行 vs 真机 14 行** |
| 手动刷新入口 | ✅ 路由 + 按钮 | ✅ 路由 + 按钮 | **❌ 无** |
| 刷新时机 | 启动种子 + 手动 | 启动 + DSH 触发 + 手动 | **仅启动一次** |
| inflight 去重 | ✅ | **❌ 无** | ❌ 无 |
| 目录持久化 | settings | `lastCatalog` | **不持久化** |

**问题二（Qoder 支持图片的模型传不了图片）**：缺陷**纯属解析与接线缺失，不是上游限制**。上游真机目录里 14 个对话模型有 **13 个 `is_vl: true`**（唯一 `false` 是 `mmodel`），而插件在 `lib/qoder.js:105` 与 `:778` 两处把输入模态**写死成 `['text']`**，解析层也没有读 `is_vl`。宿主因此在**提交 prompt 时硬拒绝**整条消息，前端弹出「当前模型不支持图片，请切换支持图片的模型」。当前 DSH 默认模型 `qoder/dfmodel`（DeepSeek-Flash）的 `is_vl` 正是 `true`。

---

## 一、WorkBuddy（`llm-workbuddy-xdpool`）

### 1.1 拉取入口：只有 2 个触发点，无定时器

| 触发点 | 位置 | 说明 |
|---|---|---|
| vendor 启动种子 | `vendor/xdpool/lib/index.js:8271-8288` | 插件加载时按区域各拉一次，失败只 `logger.warn` |
| 本 fork 管理页 | `POST /plugins/dsh-wotr-console/wb/models/refresh`，`lib/index.js:715-780`，前端 `lib/console.mjs:800` | 手动，带 per-region inflight 合流（`:714`、`726-727`） |

- vendor 侧**不存在** `/models/refresh`；`POOL_MODELS_SAVE_PATH`（`index.js:7377-7398`）只写勾选、不拉目录。
- 无任何定时器（全仓 `setInterval` 只有 `index.js:5252` 的签到调度，不碰目录）。
- 两处调用的是同一个 `client.fetchModels` + `catalog.updateFromUpstream`，但**各自独立、无共享去重**。

### 1.2 请求

- CN：`GET https://copilot.tencent.com/v2/enterprises/personal/models`
- 国际：`GET https://www.workbuddy.ai/v3/config`（`codebuddy.ai` 域 → `https://www.codebuddy.ai`）
- 认证：`Authorization: Bearer <本机桌面端登录态解密出的 accessToken>`
- **无超时、无重试、不做 token 保鲜**（`ensureFresh` 只在聊天取号路径调用，`index.js:3082/3090/3096`）。

### 1.3 解析

`fetchModels`（`index.js:1112-1152`）+ `parseUpstreamModel`（`index.js:629-660`）：

- 白名单：只有 `agents[name === "cli"].models` 内的 id 会被保留（`1137-1150`）。
- 丢弃 4 类行：非对象 / `id` 非非空字符串 / `disabled === true` / `maxInputTokens`、`maxOutputTokens` 非 number 或 ≤ 0（`634-636`）。
- 能力字段（严格布尔）：`supportsImages`（`643`）、`supportsToolCall`（`642`）；`credits` → `creditMultiplier`；`reasoning.supportedEfforts` → `supportedEfforts`。
- `toModelInfo`（`3512-3519`）之后丢弃 `descriptionZh/descriptionEn/supportsToolCall/defaultEffort/canDisableThinking`。

### 1.4 兜底

- `FALLBACK_WORKBUDDY_MODELS`（`index.js:3322-3411`，10 条）。
- 三道闸保证目录永不被清空：`fetchModels` 空结果直接抛（`1151`）→ `catalogFromUpstream` 空数组回落兜底表（`3522-3527`）→ `update()` 对空数组静默 `return`（`3477-3481`）。
- 失败只保留旧目录，**不会下线 provider**。

### 1.5 声明给 DSH

- `registerAdapter`（`8211-8212`）、`registerConfigurableProviders`（`8213-8225`，`settingsPath: []`、`declared: false`）、`registerModelDiscovery`（`8249-8259`）。
- `inputModalities` 全链路 **3 个站点**，全部由 `supportsImages` 单布尔决定：
  - `modelInput()`（`3595-3597`）→ `toPiModel.input`（`3681`）
  - discovery 三元（`8257`）`model.supportsImages ? ["text","image"] : ["text"]`
  - 宿主拷贝 `dsh-llm/lib/index.js:2010`

### 1.6 选择语义

`visible()`（`3423-3436`）：`enabledModelIds` 过滤 → `imageModelIds` **取并集（只加不减）** → `contextBudgets` 压低窗口（`maxMode` 时整表忽略）。

---

## 二、Trae（`dsh-connect-trae`）

### 2.1 两个来源

| | remote（骨架） | wire（真实可调用 id） |
|---|---|---|
| 端点 | `GET {solo.trae.cn\|coresg-normal.trae.ai}/api/remote/v1/models?functions=<7 个>` | `POST {trae-api-cn.mchost.guru\|coresg-normal.trae.ai}/api/ide/v1/get_detail_param` |
| 请求次数 | 1 | **按 function 逐次**，cn 5 次 / ai 4 次 |
| 身份头 | 仅 JWT + 门户着装头 | 完整浏览器身份（`x-app-id`/`x-ide-version-code`/`x-uid`/`x-plugin-channel`…） |
| 贡献 | id / name / 双窗口 / 倍率 / `multimodal` / 推理档 | `config_name` → `wireConfigName`、`function`、可覆盖的倍率 |

合并 `mergeTraeModelSources`（`trae.js:220-249`）：remote 是骨架，join 优先级「小写 id → 小写 display name」；**remote-only 行保留**（既定决定，靠运行时报错说话），**wire-only 行整条丢弃**。

### 2.2 触发点（3 个，无定时器）

| 触发点 | 位置 |
|---|---|
| 启动（每个启用 region 一次，不等待） | `trae.js:6005-6019` |
| DSH 驱动（选择器/探测） | `trae.js:5947-5978` |
| 管理页手动刷新 `POST /plugins/dsh-connect-trae/models/refresh` | 常量 `trae.js:4413`、路由 `5012-5027`、前端 `client.js:1497` |

三者最终都落到 `discoverModels`（`5787-5796`）。

### 2.3 区域分派

5 层：provider 名（`326-346`）→ `REGION_GATEWAYS`（`954-965`）→ `regionOfCredential`（`967-1003`）→ 函数表 + fallback 表（`2505-2519`、`117-118`）→ 配置槽 `regions.cn|ai`（`5463-5473`）。

两张 fallback 表几乎不重叠：cn 4 行（`41-62`）、ai 7 行（`75-111`），注释明确「不能交叉种子」（`113-116`）。

### 2.4 映射与配置

- `derive()`（`5586-5595`）= `sanitizeCatalog` → `dropDeadModels` → `applyImageSelection` → `deriveCatalog(enabledModelIds)` → `applyContextBudgets`。
- 图片能力：`traeModelAcceptsImage = imageModelIds.has(id) || model.multimodal === true`（`167-173`），由 `traeInputModalities`（`121-123`）在 `toPiModel`（`385`）与 discovery（`5976`）**两处共用**。
- `applyContextBudgets`（`255-259`）：只有 `budget === model.maxContextWindow` 时才抬到 Max 档，其他值一律忽略。
- `sanitizeCatalog`（`284-290`）：丢弃 `@1m` 变体与旧 `baseModelId`/`maxContext` 行。

**生效 profile 实测（`regions.cn.lastCatalog`，32 行）**：

| 字段 | 覆盖 |
|---|---|
| `contextWindow` | 32/32 |
| `maxContextWindow` | 28/32 |
| `creditMultiplier` | 32/32 |
| `multimodal` | 32/32（其中 `true` **21** 行） |
| `reasoningSupported` | 32/32 |
| `reasoning` + `reasoningEfforts` | 14/32 |
| `wireFunction` | 30/32 |
| **`wireConfigName`** | **0/32** |
| **`maxTokens`** | **0/32** |

同时 `imageModelIds: []` —— 即「用户一个都没勾，但 21 个模型被标成可收图」，正面印证图片能力实际来自上游 `multimodal`。

---

## 三、Qoder（`dsh-connect-qoder`）

### 3.1 目录链：两个构造器，一个分派点

| | 指纹链（优先） | 手写 COSY 链（兜底） |
|---|---|---|
| 位置 | `qoder-fingerprint.mjs:663-709` | `qoder-relay.mjs:575-592` |
| URL | `https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1` | 同 |
| 方法 / body | `GET`，`body: ""`，`Content-Length: 0` | 同 |
| 头族 | 官方 wasm 生成的完整 `Cosy-*` 家族（含 `Cosy-MachineId`/`Cosy-MachineOS`，**不含** `Cosy-MachineHostname`） | 仅 `Cosy-User`/`Cosy-Key`/`Cosy-Date`/`Authorization`/UA |

分派点 `qoder-catalog.mjs:191-200`：`buildQoderFingerprintedModelsRequest(...) ?? buildQoderModelsRequest(...)`。

**⚠️ 只有返回 `undefined` 才兜底；指纹链抛异常时不退回手写链**（`qoder-fingerprint.mjs:694` 会 `throw`）。

**签名算法**（`qoder-relay.mjs:219-281`）：`md5(payload \n cosyKey \n timestamp \n body \n signingPath)`，身份输入为 `uid` + `securityToken`，无独立 nonce；`qoderSigningPath` 归一化时会去掉查询串与 `/algo`。

### 3.2 真机验证（本次审计新增，决定性）

用盘上已有 `dt-` 凭据 + 插件自己的构造/发送函数，向真上游发了一次**只读**目录 GET：

```
GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1
指纹器: 有（走官方同形）  machineId: 4b4e594b…
=== HTTP 200  68539 bytes（第二次独立复现 68576 bytes）
```

分组：`chat(14) developer(14) assistant(14) inline(13) quest(13) qwork(13) experts(5) qwake(13) app(14) byok_teams(0) byok_enterprise(0)`

`chat` 组逐模型：

| key | display_name | is_vl | is_reasoning | max_input_tokens | context_config |
|---|---|---|---|---|---|
| `auto` | Auto | **true** | true | 200000 | 200K |
| `qmodel_38max` | Qwen3.8-Max | **true** | true | 180000 | **1M**/400K/200K |
| `qfmodel` | Qwen3.8-Flash | **true** | true | 180000 | **1M**/400K/200K |
| `qmodel_latest` | Qwen3.7-Max | **true** | true | 180000 | **1M**/400K/200K |
| `qmodel` | Qwen3.7-Plus | **true** | true | 180000 | **1M**/400K/200K |
| `q37fmodel` | Qwen3.7-Flash | **true** | true | 180000 | **1M**/400K/200K |
| `dmodel` | DeepSeek-V4-Pro | **true** | true | 96000 | **1M**/400K/200K |
| `dfmodel` | DeepSeek-Flash | **true** | false | 180000 | **1M**/400K/200K |
| `gmodel` | GLM-5.3 | **true** | true | 180000 | **1M**/400K/200K |
| `gfmodel` | GLM-5.3-Flash | **true** | true | **1000000** | **1M**/400K/200K |
| `gm51model` | GLM-5.2 | **true** | true | 180000 | **1M**/400K/200K |
| `kmodel_latest` | Kimi-K3 | **true** | false | 180000 | **1M**/400K/200K |
| `kmodel` | Kimi-K2.8-Preview | **true** | true | 180000 | **1M**/400K/200K |
| `mmodel` | MiniMax-M2.7 | **false** | false | 180000 | 200K |

字段并集（`chat[]`）：`context_config, display_name, enable, format, icon, is_default, is_editable, is_free, is_new, is_reasoning, is_sensitive, is_vl, key, max_input_tokens, minimal_version, original_price_factor, price_factor, promotion, source, thinking_config`

**解析器实际保留**：每条只剩 `{id, name, contextWindow}`（`is_vl` 被精确跳过）；`max_output_tokens` 上游根本不存在 → 全部落 `QODER_FALLBACK_MAX_TOKENS = 32000`。

> 附带结论：这条新的默认形态（`Encode=1` + 空 body + `Content-Length: 0`）此前在仓库里**只有源码依据、没有真机成功记录**（README 与模块注释记录的是旧形态 `{}` + `CL:2` + 不带 `Encode`）。本次两次独立真机请求均 **HTTP 200 + 14 个 chat 模型**，可以认为新形态**已被真机验证**。

### 3.3 触发点：全进程只有一次

唯一调用点 `lib/qoder.js:748-756`（在 `ready` 里，用号池第一个号）：

```js
const ready = (async () => {
  await pool.scan();
  shim = await createQoderShim({ routeChat, models: () => catalog.current() });
  const first = catalog.current()[0];          // 死变量：current() 永不为空
  const cred = first === undefined ? undefined : pool.list()[0]?.credential;
  if (cred !== undefined) await catalog.refresh(cred);
})();
```

- 无定时器、无懒刷新、**管理页没有刷新入口**（`lib/index.js` 里 Qoder 路由只有 pool/login/credits/cooldowns）。
- 无 TTL/节流：`#lastFetchAtMs`（`qoder-catalog.mjs:92` 声明、`222` 写入）**从未被读**。
- 无 inflight 去重（对比同仓库额度链有 `qoderCreditsInFlight`，`lib/index.js:364,1047-1053`）。
- **首拉失败 ⇒ 本进程生命周期内再也不会重试。**

### 3.4 兜底

- `QODER_FALLBACK_MODELS`（`qoder-catalog.mjs:60-70`，**9 行**）：`auto, qfmodel, qmodel_38max, dmodel, dfmodel, gfmodel, gmodel, kmodel_latest, mmodel`
- 相比真机 14 个 **少 5 个**：`qmodel_latest`、`qmodel`、`q37fmodel`、`gm51model`、`kmodel`
- 失败**绝不清空** `#models`（`167-231` 四个失败分支全部 `return { ok:false, models: this.current() }`）
- 三个兜底常量：`QODER_FALLBACK_CONTEXT_WINDOW = 2e5`、`QODER_FALLBACK_MAX_TOKENS = 32000`、`defaultContextWindow`（`lib/qoder.js:390`）

---

## 四、Qoder 图片问题：根因与机制

### 4.1 三处根因

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| 1 | `qoder-relay.mjs:712-727` `parseQoderModelList` | 只读 `id/name/max_input_tokens/max_output_tokens/enable`，**不读 `is_vl`** | 能力信息在解析层即丢失 |
| 2 | `qoder.js:105` `toPiModel` | `input: ['text'],` 写死 | **决定性**：`resolveModelInfo` 走这条路 → 准入闸门必然命中 |
| 3 | `qoder.js:778` discovery | `inputModalities: ['text'],` 写死 | DSH 选择器/设置页也认为纯文本 |

配置层同样缺位：`Config`（`qoder.js:81-84`）只有 `enabledModelIds` + `contextBudgets`，**没有 `imageModelIds`**，而且 `apply(ctx, config)` 结尾是 `void config;`（`qoder.js:793`）——**这两个配置项完全是死的**。

**无第三处决定点**：`qoder-shim.mjs` 是纯环回透传，其 `GET /v1/models`（`167-179`）只回 `{id, object, created, owned_by}`；`normalizeQoderPayload`（`qoder-relay.mjs:770-792`）只把 `content === null` 且有 `tool_calls` 的消息改成 `content: ''`，**不碰 content 数组、不碰图片块**。

### 4.2 用户实际撞到的是哪一层

三层机制，按发生顺序：

**第 1 层 —— 准入（这是用户实际撞到的）**
`dsh-api-session-controller/lib/index.js`（仅存在于 `app.asar`，已从运行中的宿主提取核实）：

```js
// :862
const hasImage = request.content.some((part) => part.type === "image");
// :871-875（admit 内）
if (hasImage) {
  const current = this.agents.selectionFor(agent).current;
  const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
    throw new RemoteError("session/attachment-invalid",
      `Model "${current.model}" does not support image input.`,
      { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}
```

→ **硬拒绝整条 prompt**。前端把 `details.reason` 翻成横幅「当前模型不支持图片，请切换支持图片的模型」（`dsh-client-ui-conversation` 的 `image.modelUnsupported`）。**这是用户看到的症状，也证明它不是静默降级。**

**第 2 层 —— 流式准备的静默投影**（准入放行后才可能发生）
`dsh-llm/lib/index.js:~2311`：

```js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes("image")
    && projectedMessages.some((message) => contentHasImage(message.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages);
```

图片块被替换成 `[image omitted because this model accepts text only; attachment sha256:…]`。

**第 3 层 —— pi-ai 的 `UNSUPPORTED_CONTENT`（本路径不可达）**
`dsh-llm-pi-ai/lib/index.js:1858-1859` 的抛点要求适配器还能看到图片；但投影（`~2311`）发生在 `dispatch(...)`（`2323`）**之前**，适配器拿到的是**投影后的 messages**，`containsImage` 恒为 `false`。**该抛点在此路径上永远走不到。**

### 4.3 为什么另两家没这个问题

- **WorkBuddy**：`supportsImages` 一路从 `parseUpstreamModel`（`bin.js:~429` / `index.js:643`）传到 discovery（`index.js:8257`），管理页刷新时还会把 `supportsImages === true` 的 id 写回 `imageModelIds`（`lib/console.mjs:748-761`）。
- **Trae**：`imageModelIds ∪ multimodal === true`（`trae.js:167`），`toPiModel` 与 discovery 共用 `traeInputModalities`。

**历史先例**：`dsh-connect-trae/CHANGELOG.md:811-816`（issue #16）记录的正是 Trae 曾经**完全相同**的 bug——「上游 `multimodal` 虽然在 `parseTraeRemoteModel` 里被解析出来，但从不进入 `TraeModelInfo`，等于被丢弃」。修复后的关键句是「一旦声明 `image`，DSH 会把图片原样发出而不是降级成文字」。**Qoder 现在处在 Trae 修复前的状态，而且更差一层——连解析都没有。**

修好之后图片能真发上去：`pi-ai/dist/api/openai-completions.js:940-946` 会把 user 消息的 image block 无条件转成 `{type:'image_url', image_url:{url:'data:…;base64,…'}}`，而 `normalizeQoderPayload` 与 shim 都是原样透传。

---

## 五、三处表述更正（相对审计过程中的中间结论）

1. **「即使绕过准入闸门，pi-ai 层也会抛 `UNSUPPORTED_CONTENT`」——不成立。**
   投影在 `dispatch` 之前把图片块换成文本，适配器看不到图片，该抛点不可达。正确的描述是：**准入层硬拒绝（用户实际遇到），若准入放行则是静默降级**。

2. **「一行模型缺 `contextWindow` 会让宿主以 `INVALID_MODEL_CONTEXT` 拒掉整个 provider」——不准确。**
   - 批量 `listModels` 的校验是 `INVALID_CATALOG`，条件只有 id/name 非空、id 不重复（`dsh-llm/lib/index.js:2073-2090`），且它**直接丢掉 `contextWindow`**。
   - `INVALID_MODEL_CONTEXT` 在 `normalizeModelInfo`（`:2105-2115`）里，是**per-(provider, model)** 的 resolve 失败，不是整表下线；且 pi-ai 总有 `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow`（`dsh-llm-pi-ai:675`），Trae（`trae.js:437`）与 Qoder（`qoder.js:390`）都设了 `defaultContextWindow`。
   - 因此 `lib/trae.js:17-40` 与 `lib/qoder.js:108`（「缺这一行 DSH 会以 `INVALID_MODEL_CONTEXT` 拒掉**整个 provider**」）属于**防御性说法，今天不成立**。
   - **真正会作废整个 provider 目录的是 `INVALID_CATALOG`（重复 id）**——而 WorkBuddy 恰好能踩到（见 §6 P0-3）。

3. **「WorkBuddy 完全跟随上游、不会错」——需要加一条保留。**
   `imageModelIds` 是 `||` 并集（`index.js:3431`），**只能加不能减**。若上游撤销某模型的图片能力而本地保存的 `imageModelIds` 仍含该 id，插件会继续宣告 `["text","image"]`，用户发图后由上游报错。本 fork 的 UI 已去掉该开关、写入集合恒等于上游 true 集合，所以现状无可见回归，但语义与注释「explicit image list overrides the upstream capability flag」（`3409-3412`）、schema 描述「absent = follow upstream」（`7810`）不符。

---

## 六、问题清单（合并四条链路，按严重度）

### P0

**P0-1｜Qoder 所有模型的图片能力对宿主不可见**（详见 §4）
修复点：`qoder-relay.mjs:712-727`、`qoder-catalog.mjs:60-70`、`qoder.js:105`、`qoder.js:778`。

**P0-2｜Qoder `enabledModelIds` / `contextBudgets` 是空声明**
`qoder.js:81-84` 声明、`:793` `void config;`，全文无其它 `config` 读取 → 模型表完全不过滤。运行 profile 的 `dsh-connect-qoder` 条目**连 `config:` 块都没有**。用户在设置页里改了也不会有任何效果。
建议：接上（WorkBuddy `visible()` / Trae `deriveCatalog()` 是现成范式），或从 schema 删掉。

**P0-3｜WorkBuddy：未保存过勾选的实例会「provider 已注册但可见模型为 0」**（已亲手复现）
`schemastery` 会把缺省的 `modelSelectionCn` 折叠成 `{enabledModelIds: [], imageModelIds: [], contextBudgets: {}}`（**不是 `undefined`**）。实测：

```
new Config({}) → modelSelectionCn = {"enabledModelIds":[],"imageModelIds":[],"contextBudgets":{}}
```

于是 `index.js:7979` 的 `modelSelectionCn ?? fallbackSelection("cn")` **永远取左侧**，`7977` 的「三项全 undefined 才回退 `currentSelection()`」成为死分支（旧顶层键也被 `.default([])`/`.default({})` 折叠）。结果 `visible()` 返回 `[]` → `buildModels()` → `[]` → picker 里该 provider 无任何模型。
这与 `3402-3404`、`3414-3415` 的注释（「Empty object = follow the catalog unfiltered」「a fresh install with no saved selection must not present an empty picker」）**完全相反**，而 `lib/index.js:207-209` 的告警日志正是在描述这个现象。
影响面：新装机器、清空过 section 的机器、区域键从未落盘的机器。**本机 profile 已存 `modelSelectionCn`（17 个 id），故当前不受影响。**
建议：`fallbackSelection` 改为「区域键缺失**或**其 `enabledModelIds` 为空数组且从未落盘」时回退；并补一条「全新配置 → `visible()` 非空」的单测。

**P0-4｜WorkBuddy：手动刷新可能被一次挂死的请求永久钉住**
`lib/index.js:726-771` 用 per-region `Map` 合流、只在 `.finally` 清理（`769`）；内部 `fetchModels`（`747`）**不带 signal**，而 `fetchModels` 的超时完全依赖调用方（`index.js:1133-1136`）。一旦上游 TCP 挂住，promise 既不 resolve 也不 reject，`modelRefreshInflight` 里那条永远不删 → 此后该区域所有「刷新」都 await 同一个僵死 promise，直到重启 DSH。
建议：两处调用加 `AbortSignal.timeout(30_000)`（复用 `JSON_TIMEOUT_MS`），并在路由加超时兜底确保 `finally` 一定执行。

### P1

**P1-1｜Trae 全链路没有 inflight 去重**
同文件的 `TraeRawCapabilityController`（`3766-3772`）与凭据刷新（`1269-1272`）都有现成范式，WorkBuddy 也有，唯独 Trae 目录拉取没有。选择器打开 + 启动 + 连点刷新并发时，一次用户动作放大成 N×(1 remote + 5 wire)，且并发写共享 `wireState[region]`（`5792-5799`）与 `catalog.set`（`6012`）→ **旧快照可能覆盖新快照**。

**P1-2｜Trae：wire 的字段被整片丢弃**
`mergeTraeModelSources` 只从 wire 取 `config_name`/`function`/倍率；wire 的 `contextWindow`、`maxTokens`、`reasoning` 全不参与。实证：profile 快照 32 行 `maxTokens` **0 行** → 卡片「输出 X」永不渲染，pi-ai 适配器也拿不到 `maxTokens`。

**P1-3｜Trae：发现通道无错误降级**
`discoverModels` 抛错会被宿主包成 `llm/model-discovery-rejected`，选择器**报错**而不是退回上次成功的目录（对比启动路径有 catch，`6013-6016`）。另外 `withDirectoryRetry` 只重试 remote，wire 一失败连 remote 的好结果也一起丢。

**P1-4｜Trae：两个来源客户端都从凭据重推 region、忽略所在 stack**（`2629`、`3435`）
只要区域 store 解析到的凭据自身 region 判定不同（`authFile` 指向对方文件 / `edition` 分歧），ai 的 `trae-global` 就会去拉 CN 网关 + CN 函数表，且无任何告警。

**P1-5｜Qoder：目录只有一次机会**
无重试、无换号、无手动刷新入口、无节流（`#lastFetchAtMs` 死字段）、无 inflight 去重；只用 `pool.list()[0]`。**首拉失败即整个进程定格在 9 行兜底表**（真机 14）。

**P1-6｜Qoder：指纹链抛异常时不退回手写链**
`??` 只兜 `undefined`（`qoder-catalog.mjs:191-200`），而指纹链会抛（`qoder-fingerprint.mjs:694`）→ 整轮不拉目录。另外 `lib/qoder.js:421-426` 把 `createQoderFingerprint().catch(() => undefined)` 的结果**永久缓存**，一旦首次提取失败，后续只会走手写链——与该处注释的意图相反。

**P1-7｜Qoder：失败诊断会被带偏**
目录链只判 HTTP（`qoder-catalog.mjs:208-211`），`200 + {"code":101}` 会被报成「目录响应里没有可识别的模型条目（上游形状可能已变）」。仓库里现成的 `classifyQoderRelayFailure`（`qoder-relay.mjs:947-959`）能识别 `101 Signature invalid` 却没被调用。

**P1-8｜WorkBuddy：目录拉取不做 token 保鲜**
过期 token 会被 `readEnvelope` 翻译成「重新登录」，但种子只 `logger.warn` 一行，用户侧表现是「模型变少/名单对不上」。

**P1-9｜WorkBuddy：`cliIds` 未去重 → 可触发 `INVALID_CATALOG`**
`index.js:1145-1149` 用 Map 去重，`1150` 对 `cliIds` 直接 `.map()`。只要上游 `agents[cli].models` 出现重复 id，宿主 `dsh-llm:2077` 的 `seen.has(model.id)` 就会判定 `invalid or duplicate model metadata` → **整个 provider 目录不可用**。建议 `[...new Set(cliIds)]`，并补 `Number.isInteger` 校验（`634-636` 只查 `typeof number`）。

### P2

- **P2-1｜Trae `discoveredCatalog`（`262-279`）是死代码**，且输出不含 `wireConfigName`；若照 `5952-5968` 注释的思路改回使用它会整片丢 wire 映射。
- **P2-2｜Trae：卡片显示与实际下发不一致**：`client.js:2047` 显示 `maxContextWindow ?? contextWindow`，实际下发 dev 档；`contextBudgets` 在卡片上**没有任何写入 UI**（`client.js:1458`、`1514` 只做保留），生效 profile 恒为 `{}` → 单测假设的「两档单选」用户不可达。
- **P2-3｜Trae：刷新即全量启用**：`client.js:1487-1530` 的 `refreshModels` 无条件把 `enabledModelIds` 覆写成全部新 id，用户手工取消勾选会被下一次刷新吞掉。
- **P2-4｜Trae：「空选择 = 全量」+ 空结果回退静态表**：全部取消勾选 → 得到全量目录；只勾的模型被上游改名 → 突然冒出 4/7 个引导模型（且不受 `enabledModelIds` 约束）。
- **P2-5｜Qoder：`settingsPath: []` + 宿主 `layoutOf` 白名单**（`client.js:1492-1496` 只认 `llm-deepseek`/`llm-pi-ai`）→ 设置页对该 provider 显示未知命名空间、**保存被禁用**（`:1813-1828`）。三个插件 provider 同病，属宿主白名单限制。
- **P2-6｜Qoder 管理页是纯号池面板**：`QoderPoolPanel`（`console.mjs:3084-3103`）没有任何模型相关 prop，9 条路由全是号池/额度/登录。唯一提到「模型勾选」的 `console.mjs:4705` 是三家共用的副标题文案，**有误导性**。
- **P2-7｜Qoder：解析丢失 `is_reasoning`** → `toPiModel` 的 `reasoning: false` 是硬编码（`qoder.js:111`）；`format`、`price_factor` 也丢 → cost 全 0。
- **P2-8｜Qoder：`context_config` 的 1M 档被丢弃**，只报 `max_input_tokens`（180K/200K），而 `contextBudgets` 又是死配置。
- **P2-9｜WorkBuddy：`toModelInfo` 丢弃 `descriptionZh/En`、`supportsToolCall` 等已解析字段**；`WorkBuddyCatalog.onChange/notify`（`3496-3499`）是死机制。
- **P2-10｜WorkBuddy：`test/xdpool-bundle-test.mjs` 不存在**，而 `vendor/xdpool/README.md:24` 要求升级上游后跑它 → vendor 链**零回归测试**，升级时会静默重写上述语义。
- **P2-11｜Trae：`reasoningSupported` 是只写不读的死字段**（`toPiModel` 只看 `reasoningEfforts`）→ 会出现 `reasoningSupported: true` 但 DSH 侧 `reasoning: false` 的不一致。
- **P2-12｜Qoder schema 未声明却依赖的字段**：Trae 侧同类问题（`modelConfig` 没有 `maxContextWindow`/`reasoning`/`wireConfigName`，靠 schemastery 非严格对象合并保留未知键）——**今天能跑，但属隐性契约**，一旦 schema 变严格会静默失效。

### P3（文档/整洁）

- `README.md:21`（「Qoder 已接通推理」）与 `README.md:393-395`（「还没接成 provider」）**自相矛盾**，后者已过期。
  → ✅ **已改**：小标题改为「Qoder 号池与模型勾选」，并新增「Qoder 模型勾选」一节（三个字段语义、GET/POST 分工、写不进去时的诊断步骤、宿主设置页为什么没有这个勾选框）。顺带把 tab 表（「Qoder 号池」→「Qoder 配置」，两列）与测试清单（12 → 21 个文件、全部项数）补齐。
- `README.md:679-690`、`qoder-relay.mjs:39-42,98-108`、`qoder-catalog.mjs:173-174` 仍写着旧目录形态（`{}` + `CL:2` + 不带 `Encode`），与当前实现（`Encode=1` + 空 body）不符。
  → ✅ **已改**（`qoder-relay.mjs` 模块头 + 常量块、`README.md` 第 ②节），并补上「为什么从 `{}` 换成空 body」：`Encode=1` 会让服务端去解自定义 Base64，明文 `{}` 会触发 Java 异常 —— 旧形态能过只是因为它当时没带 `Encode`。`qoder-catalog.mjs:173-174` 复核为**签名/指纹解析**的注释，与目录请求形态无关，**不是问题**。
- `trae.js:5563-5572` 注释描述的「dead config_name 绝不服务」与实现相反（`callableKeys` 从 `merged` 填，remote-only 行必然在集合里）。
  → ❌ **复核为非问题**（本次逐行核对）：`callableKeys` 确实从 `merged` 填，而 `merged` 是 `mergeTraeModelSources(remote, solo)` 的**join 结果** —— remote-only 且 `get_detail_param` 无匹配的行在 merge 那一步就被丢掉了，所以它天然不在集合里。`dropDeadModels` 真正的作用是**丢弃上一次会话留在 `lastCatalog` / `models` 里的过时行**，与注释一致。
- `trae.js:138-148` 注释称 `imageModelIds`「stays authoritative」，但实现是只增不减。
  → ❌ **复核为非问题**：原文是「stays authoritative and can still switch an individual model on」（只承诺**开**），紧接着一段专门解释「the union never silently revokes a working setup」。措辞没有承诺可撤销。
- `trae.js:3293` 的 `TRAE_SOLO_REMOTE_BASE` 硬编码 CN，与 `REGION_GATEWAYS.cn.remote` 重复（实际请求走后者，目前无害但会误导）。
  → ❌ **复核为刻意**：该常量位于 `//#region src/solo-remote.ts`（原 TS 源码按模块分区的产物），是 **SOLO 通道**自己的 base；与 CN region 的 remote 今天同值属巧合。合并成一个常量反而会把「SOLO 版本 vs 区域」两个概念绑死。
- Qoder 指纹链把 `Cosy-ClientIp` 填成 machineId（本地实测与 `Cosy-MachineId` 同值），上游是否校验未知。

---

## 七、Qoder 图片问题修复方案

### 阶段 1（最小改动，即可解除图片封锁）

```js
// 1) lib/qoder-relay.mjs — parseQoderModelList 条目组装处（现 712-727）
//    严格布尔，与 Trae 的 raw.multimodal === true 同口径。
//    缺失/非布尔一律当「没说」→ 纯文本：少标可恢复（用户可补勾），错标不可恢复。
const vl = item.is_vl ?? item.metadata?.capabilities?.vision;
if (typeof vl === 'boolean') entry.supportsImages = vl;
```

```js
// 2) lib/qoder-catalog.mjs — QODER_FALLBACK_MODELS（现 60-70）补上能力
//    按 2026-10-11 真机：13/14 为 true，唯一 false 是 mmodel。
{ id: 'auto', name: 'Auto', contextWindow: 200000, supportsImages: true },
…
{ id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 180000, supportsImages: false },
// withRequirements 用 ...entry 展开，无需改动
```

```js
// 3) lib/qoder.js — 抽一个规范谓词，两处共用（Trae/WorkBuddy 的既有范式）
function qoderInputModalities(model) {
  return model.supportsImages === true ? ['text', 'image'] : ['text'];
}
// :105   input: qoderInputModalities(model),
// :778   inputModalities: qoderInputModalities(m),
```

**两处都必须改**：`toPiModel` 决定准入闸门（`resolveModelInfo` 走它），discovery 决定选择器/设置页的呈现。只改一处会出现「能发图但 UI 说不能」或反之。

### 阶段 2（与另两家对齐）

- `Config` 加 `imageModelIds: z.array(z.string()).default([])`，按 WorkBuddy `visible()` 语义**只加不减**，作为「上游标错/标漏」的手动补救通道。
- 把 `void config;`（`qoder.js:793`）换成真正读取 `config`：接上 `enabledModelIds` 过滤与 `contextBudgets`；或从 schema 删掉这两项，别让它继续假装可用。
- 顺带接上 `is_reasoning`（`reasoning: false` 是硬编码）与 `context_config` 最大档（对 Trae `maxContextWindow` + `applyContextBudgets` 的做法）。

### 阶段 3（可观测性，可选）

- 管理页加 `POST /qoder/models/refresh` + 一个「从 Qoder 刷新」按钮（对齐另两家），并在启动时无凭据、之后才登录的情况下重拉一次目录。
- 目录链复用 `classifyQoderRelayFailure`，把 `101 Signature invalid` 与「上游形状变了」区分开。
- 兜底表补齐到真机 14 个 id，并在 `QoderCatalog` 暴露 `usingFallback` 供页面提示。
- 指纹链抛异常时也退回手写链（把 `??` 改成 try/catch 兜底）。

### 测试

现有 **21/21 全绿也发现不了这个 bug**——没有任何一条断言碰过 `input` 或 `inputModalities`。建议补：

- `test/qoder-relay.test.mjs`：真机 fixture（`329-350`）里**已经有 `is_vl: true`**，加一条断言 `supportsImages === true`；再加一条 `is_vl` 缺失/非布尔 → 不带该字段。
- `test/qoder-catalog.test.mjs`：兜底表每行都带 `supportsImages`，且 `current()` 不丢该字段。
- `test/qoder-provider.test.mjs:139-145`：discovery 断言补 `inputModalities`。
- 新增：`is_vl` 缺失 ⇒ 断言输出 `['text']`（防未来改成默认开图）。

---

## 八、环境提示

1. **工作树在审计期间被并发改写**：`git status` 的 14 个文件 mtime 呈 16:40:46 → 16:56:14 的连续序列（含 `lib/qoder-relay.mjs` 16:40、`lib/qoder.js` 16:42、`lib/qoder-catalog.mjs` 16:43、`test/qoder-relay.test.mjs` 16:55、`test/qoder-provider.test.mjs` 16:55、`lib/client.js` 16:56）。其中 `test/qoder-provider.test.mjs` 相对更早的基线是**新增**的改动文件。若这不是你预期的编辑，建议查一下是否有另一个会话在同一个 checkout 上工作；**在动手改 Qoder 之前请先确认没有并发写入者**，否则会互相覆盖。
2. 本次审计对仓库的副作用（`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/`）**已全部清理**，`git status` 恢复为「14 个 M、0 个未跟踪文件」。
3. 测试基线（当前脏树）：**21/21 通过**。注意该状态是「测试与实现对齐」，不等于「形态已被真机验证」——`test/qoder-relay.test.mjs` 曾在审计期间由「107 通过 / 4 失败」变为「112 通过 / 0 失败」。
4. 未验证项：Qoder 上游 `agent_chat_generation` 是否真的接受 OpenAI 形状的 image block。`is_vl` + 每个模型 `format: "openai"` 强烈指向「接受」，透传链（shim → `normalizeQoderPayload` → 上游）也不会剥掉图片块，但要 100% 确认需发一次带图请求（会消耗额度），**未执行**。

---

## 附录：证据与复现

| 项目 | 命令/位置 |
|---|---|
| Qoder 真机目录 | `GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`（指纹链，只读，HTTP 200，68.5 KB） |
| 宿主准入闸门 | `app.asar` → `node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:862-875` |
| 投影与派发顺序 | `dsh-llm/lib/index.js:~2311`（投影）→ `:2323`（`dispatch`） |
| schemastery 折叠 | `new Config({})` → `modelSelectionCn = {enabledModelIds: [], …}` |
| Trae profile 快照 | `~/.dsh/profiles/desktop/cordis.patch.yml` → `dsh-connect-trae.config.regions.cn.lastCatalog`（32 行） |
| WorkBuddy profile | 同文件 → `llm-workbuddy-xdpool.config.modelSelectionCn`（17 个 id） |
| Qoder profile | 同文件 `:605-606` → **无 `config:` 块** |
| 测试基线 | 21 个测试文件全通过 |

审计过程全部为只读检查；除上述一次 Qoder 只读目录 GET 外未发出任何网络请求（特别地，**未发出任何 chat / 推理请求**）。

---

## 九、修复落地情况（同日晚间收尾：把「结论速览」里所有 ❌ 逐格补齐）

> 本节是**代码侧**的结果记录，逐格对应上表。每条都落到「改了哪一行 + 哪条断言
> 会红」，不是「看代码像是对的」。工作树里的改动**尚未部署到 profile**
> （`tools/apply-wotr.sh`），部署需要重启 DSH。

| | WorkBuddy | Trae | Qoder（修复后） |
|---|---|---|---|
| 上游能力字段 | `supportsImages` ✅ | `multimodal` ✅ | **`is_vl` 严格布尔解析** ✅（`qoder-relay.mjs:741`） |
| 用户手动补勾 | `imageModelIds`（并集） | `imageModelIds`（并集） | **`imageModelIds`（并集，只加不减）** ✅ |
| 模型白名单 | `agents[cli].models` ✅ | wire `callableKeys` ✅ | **`enabledModelIds` 真正生效** ✅（空 = 不限制） |
| 上下文预算 | `contextBudgets`（只压低） | `dev`/`Max` 双档 + `contextBudgets` | **`contextBudgets` 真正生效（只下调）** ✅ |
| 兜底表 | 10 行 | cn 4 / ai 7 行 | **14 行（真机 14 个对话模型全覆盖）** ✅ |
| 手动刷新入口 | ✅ 路由 + 按钮 | ✅ 路由 + 按钮 | **`GET`（只读快照）+ `POST`（拉上游）+ 卡片按钮** ✅ |
| 刷新时机 | 启动种子 + 手动 | 启动 + DSH 触发 + 手动 | **启动 + 登录成功 + 手动** ✅ |
| inflight 去重 | ✅ | **✅（本次补）** | **✅（本次补）** |
| **图片附件服务接线** | ✅ `resolveAttachments`（`:4452`） | ✅ 同款（`:5963`） | **✅ 本次补**（原先漏 → 报 `pi-ai image input requires the durable attachment service`，见 9.1 第 4 层） |
| **图片请求预算** | ✅ 三件套（`:3560-3562`） | ✅ 同款（`REQUEST_IMAGE_BUDGETS`） | **✅ 本次补，与 Trae 逐字同值**（见 9.1 第 4 层） |
| 目录持久化 | settings | `lastCatalog` | 不持久化（**刻意**：目录每次启动重拉，兜底表已与真机对齐，见下） |

### 9.1 图片链路（问题二的根因，四层全修）

> ⚠️ **模型层只是第一层。** 2026-10-11 晚实机复现出第二处独立缺口（第 4 层），
> 报错长得和第一层几乎一样 —— 说明「图片不能发」这类问题**必须逐层验证到
> `stream()`**，只看 `inputModalities` 会得出「已经修好了」的错误结论。

1. **解析**（`lib/qoder-relay.mjs:733-745`）：`const vl = item.is_vl ?? item.isVL;`
   只在 `typeof vl === 'boolean'` 时写 `entry.supportsImages = vl`。
   缺失 / `null` / `"true"` 一律当「上游没说」→ **纯文本**。
   方向的取舍与 `dsh-llm-pi-ai/README.zh.md:226` 一致：漏标可人工补勾救回，
   错标会让图片在**准入之后**被上游拒绝（用户看到「模型不收图片」而账单已产生）。
2. **目录行**（`lib/qoder-catalog.mjs:68-107`）：兜底表补到真机 14 行，
   13 行 `supportsImages: true`（唯一 `false` 是 `mmodel`）；`withRequirements`
   用 `entry.supportsImages === true` 归一化，**不给缺失值兜 true**。
3. **谓词单点**（`lib/qoder-catalog.mjs:109-111`）`qoderInputModalities(model)`，
   两处引用同一个函数：
   - `lib/qoder.js:216` `toPiModel` → 决定准入闸门（`resolveModelInfo` 走它）；
   - `lib/qoder.js:944` discovery → 决定选择器/设置页呈现。

   这是本 bug 的核心：两处若各写一份，就会出现「能发图但界面说不能」或反之。
   `test/qoder-provider.test.mjs` 的 2b 节**直接断言两处判据一致**。
4. **适配器接线**（`lib/qoder.js` 的 `createQoderAdapter` + `apply`，本次新增）：
   `new PiAiAdapter({ ..., resolveAttachments: () => ctx.get('attachments') })`，
   并把 `REQUEST_IMAGE_BUDGETS`（三件套）铺进 profile。

   判定点在 `dsh-llm-pi-ai` 的 `streamWithSnapshot`（0.2.0-rc.2，asar 内
   `lib/index.js`）依次三句：

   ```js
   if (containsImage && !model.input.includes("image")) throw ...   // 第 1 层，已放行
   const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
   if (containsImage && attachments === void 0)
     throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
   ```

   即：**模型层声明了 image、适配器却没拿到附件服务时，报错晚一层才出现**，
   用户看到的仍然是「图片用不了」。Trae 与 WorkBuddy(vendor) 一直有这一行，
   Qoder 漏了 —— 三家不齐的最后一格。
   断言：`test/qoder-provider.test.mjs` 2c 节（替身附件服务抛哨兵 + **摘掉接线
   的负向对照必须复现该报错**；另有「注册期不取值」的懒加载断言）。
   **接线标志**：`currentQoderApi().capabilities().imageAttachments` 一路透出到
   `GET …/qoder/models/refresh` 的回执里。加它的原因是这次两轮返工都是
   「部署了但没重启」——两层的报错长得几乎一样，没有这个字段就只能靠试发一张图
   来判断当前进程跑的是哪一版代码。
   非对称缺口的另一半 —— 预算三件套 —— 同节逐字断言与 Trae 同值。
5. **透传到上游**（本次新增断言，代码本来就是直通）：pi-ai 把用户图片块转成
   OpenAI 形状 `{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}`，
   `normalizeQoderPayload` 只改 `content:null + tool_calls` 的 assistant 消息，
   两条发包路径都带完整 data URL。
   断言：`test/qoder-payload.test.mjs` 第 7 段（手写路径逐字含 data URL 且
   `Content-Length` 按带图 body 计；指纹路径用替身捕获交给 wasm 编码器的
   `bodyJson`，同样含 data URL）。这一段防的是**图片被静默丢掉** —— 请求成功、
   模型正常回话、只是没看见图，比报错更难发现。

### 9.2 配置三字段（把死配置接活）

`lib/qoder.js:117-140`：`enabledModelIds` / `imageModelIds` / `contextBudgets`
三项都改成 `asVolatile(...)` 并各带 `.description()`。

> ⚠️ **为什么必须 volatile**：`dsh-settings/lib/index.js:505-507` 的
> `volatileForm(schema)` 返回 `undefined` 时，`describe()` 会**整个跳过**该入口，
> 而写入闸门抛 `Plugin entry "<ns>" has no volatile fields`。这就是 profile 里
> `dsh-connect-qoder` **从来没有 `config:` 块**的原因，也解释了为什么旧版本
> 无论怎么写都「保存成功、值自己弹回去」。

生效语义（`lib/qoder.js:182-214` 的 `selectModels`）：

- `enabledModelIds`：**空数组/缺省 = 不限制**（目录全可用）。这是与 WorkBuddy
  侧唯一**刻意不同**的语义 —— 那边把空列表当「一个都不用」，于是新装机器上
  「模型选择器里一个模型都没有」（P0-3，见 §9.5，仍**未改**）。
- `imageModelIds`：**只加不减**的并集，无法撤销上游已给的图片能力（三家的共同
  限制，UI 上把这种行画成「选中且禁用」而不是假装可撤销）。
- `contextBudgets`：**只下调**，填大于上游窗口的值不生效（不改请求档位是刻意的：
  `context_config` 的档位选择请求形态未验证）。

### 9.3 可观测性（原来只有「启动一次、看不见、拉不到就静默用兜底」）

- `lib/qoder-catalog.mjs:126,219-223`：`#inflight` 并发合并 + `refresh()` 包装，
  **同一时刻只打一次上游**，且结束后能再打（`test/qoder-catalog.test.mjs` 断言：
  两次并发 `refresh()` → 1 次上游调用；随后再 `refresh()` → 真的再打一次）。
- `lib/qoder-catalog.mjs:164` `lastFetchAtMs()` + `usingFallback` 暴露给页面。
- `lib/qoder-catalog.mjs:293`：目录拉取失败走 `classifyQoderRelayFailure`，
  把 `101 Signature invalid`（签名问题，方向完全不同）与「上游形状变了」分开。
- `lib/index.js:1151` 路由 `${BASE}/qoder/models/refresh`：
  **GET = 只读快照**（不触上游、不花额度，面板打开时用）、
  **POST = 先拉上游再返回快照**（卡片「刷新目录」按钮用）；
  拉取失败返 **502 但 body 里仍带快照**，页面因此能同时显示「刷新失败」与
  「当前可用的有哪些」。登录成功（`lib/index.js:1274`）后补拉一次目录。
- Trae 的 inflight 去重（`lib/trae.js:4413` 的 `directoryInflight` + `:5806-5826`
  的 `discoverModels` 包装）：按 region 复用同一发在途请求。
  ⚠️ **这一条没有行为测试** —— 它挂在 `apply()` 覆盖的 region stacks 里，
  不在导出面上；同款机制在 WorkBuddy 侧已有覆盖。

### 9.4 管理页（唯一能改这三个字段的地方）

宿主自己的「模型」设置页只认 `llm-deepseek` / `llm-pi-ai` 两个 layout
（`dsh-client-ui-settings-models/lib/client.js:1492-1496`），其它 namespace 判成
`unknown`，于是**逐模型的「图片」勾选框与提交按钮都不会出现** —— 三个插件
provider 都只能靠本插件自己的页面。

`lib/console.mjs:2276-2680`（`QoderModelsPanel`）+ `:5216` 挂到「Qoder 配置」页
右列（tab 名从「Qoder 号池」改为「Qoder 配置」，两列布局）：

- 打开只打 GET；「刷新目录」才打 POST；
- 「上游声明支持图片 N 个」与「已启用 X / Y 个」两行读数；
- 上游给了图片能力的行 → 勾选且**禁用**；上游没给的 → 「补勾图片」可点；
- 上下文上限输入框（`wbc-model-input`）；
- **逐字段写 + 读回确认**，值没落地就报「`qoder`: settings 字段 "xxx" 未能写入」——
  这条护栏专治 §9.2 那个「保存成功但值弹回去」的假象；
- 一个模型都不勾时保存按钮禁用（空列表 = provider 没有模型）。

`test/console-render.test.mjs` 的 `2a-quater` 节（本次新增 24 条断言）真跑渲染 +
真驱动 `onChange`/`onClick`：GET/POST 归属、两类勾选状态、三个字段的写入值与
顺序、写入不落地时的报错、全不勾时拒绝写。

> 该测试节踩到并记录了一个**测试基建陷阱**：组件是纯函数，`collectText` 展开
> 它们时会真的调用组件、真的走 `useState`，而迷你 react 的 hook 槽位是**整棵树
> 共用的一维数组**。同一棵元素树扫两遍 → 第二遍游标停在上一次末尾 → 读到的
> state 全是别人的，表现为「没改过却出现保存栏、模型卡片一个不剩」。
> 因此该节把文字/控件/按钮合并成**一次**遍历，且每次渲染前 `react.reset()`。

### 9.5 本次**未改**的项（刻意/待定，别当成漏掉）

| 项 | 为什么不动 |
|---|---|
| WorkBuddy P0-3「新装机器零模型」 | 属 vendor 侧语义（`vendor/xdpool/lib/index.js:7979` 的 `modelSelectionCn ?? fallbackSelection("cn")` 因 schemastery 折叠恒取左支），改成「空 = 不限制」会**改变已装用户的可见模型集**，需要单独决策 |
| WorkBuddy P0-4「刷新被挂死请求永久钉住」 | 同样在 vendor 侧（`lib/index.js:769` 的 per-region `Map` 只在 `.finally` 清理，而 `fetchModels` 无 signal/timeout）；另 `:1150` 的 `cliIds` 未去重，重复 id 会触发宿主 `INVALID_CATALOG` 杀掉**整份**目录 |
| Qoder `is_reasoning` → `reasoning` | 语义未验证：接上会让 pi-ai 发 `reasoning_effort`，请求侧形态没实机测过。目录解析里**刻意不解析**它 |
| Qoder `context_config` 的 1M 档 | 选档的请求形态未验证，只做「下调」是安全方向 |
| Qoder 目录持久化 | 不持久化是刻意的：兜底表已与真机 14 行对齐，持久化反而会把过时目录留在盘上 |
| Qoder 指纹链 `Cosy-ClientIp` = machineId | 本地实测与 `Cosy-MachineId` 同值；上游是否校验未知，属**未验证项** |
| 「Qoder 是否接受 OpenAI 形状的 `image_url`」 | 需要真发一次带图推理（**花钱**），未测。代码路径已确认：pi-ai `dist/api/openai-completions.js:940-946` 把用户图片块转成 `{type:'image_url',image_url:{url:'data:<mime>;base64,…'}}`；`normalizeQoderPayload` 直通，两条发包路径的 body 已由测试逐字钉住（9.1 第 5 层）。**仍未验的是上游收到后的行为**（真机目录里 14 个模型全部 `format: "openai"`，这是它收 OpenAI 形状的旁证） |
| WorkBuddy vendor 的 `policyToHostTarget`（`:4215`） | 它修的是**旧部署形态**下的版本错配（插件解析到全局 npm 的 `dsh-llm-pi-ai@0.1.5`，宿主是 0.2.0 → `readImageRequest(ref, policy)` 被当成 target 校验，抛 `Image request width must be a positive integer`）。现行部署把插件的 9 个宿主包软链到宿主同一份 0.2.0-rc.2，**错配已不复存在**；而这个包装对 0.2.0 形状是**幂等**的（`arg.width/height` 为正安全整数时原样放行），所以留着无害、**本次不动** |

### 9.6 收尾基线（2026-10-11 晚，含第二轮图片修复）

```
21 / 21 个测试文件全通过（改动前也是 21/21 —— 所以本次为每一格都补了会红的断言）
  test/console-render.test.mjs   294 项（+60，含 2a-quater 24 条）
  test/qoder-catalog.test.mjs     86 项（+20：兜底表逐行、is_vl 解析、并发去重）
  test/qoder-provider.test.mjs    42 项（+42：白名单/补勾/预算真生效、两处判据一致、
                                        2c 图片附件服务接线 + 负向对照 + capabilities 自述）
  test/qoder-payload.test.mjs     32 项（+8：图片块在两条发包路径上逐字透传）
scripts/gen-console-inline.mjs --check → ✓ 生成块已同步
```

**部署 ≠ 生效**：`apply-wotr.sh` 只把代码放进 profile，ES module 有缓存，
**必须整个 App 退出重开**。2026-10-11 17:21 那次重启就吃到了这个坑 ——
磁盘上还是 16:4x 的旧代码，现象与「没修」完全一致，而当时的判断依据
（新路由 `GET …/qoder/models/refresh` 仍在回 404）能一眼看出来：

```sh
# 一次问清两件事：路由在不在（404 = 旧代码）、图片第二层接没接上
# （capabilities.imageAttachments 必须为 true，null/false = 进程里还是旧代码）
curl -s http://127.0.0.1:19387/plugins/dsh-wotr-console/qoder/models/refresh \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('capabilities =', d.get('capabilities'), '| 支持图片', sum(1 for m in d['models'] if m['supportsImages']), '个')"
```

`capabilities` 是这一版新加的**接线自述**（`lib/qoder.js` 的 `published.capabilities`
→ `lib/index.js` 路由回执）。两轮返工都栽在「部署了但没重启」上，而两层的报错长得
几乎一样 —— 有它就不必靠试发一张图来判断当前进程跑的是哪一版。

部署到 profile 并生效（**需要重启 DSH**，ES module 有缓存，热重载不会重新加载代码）：

```sh
./tools/apply-wotr.sh --dry-run   # 先看计划
./tools/apply-wotr.sh             # 部署到 desktop profile（自动备份到 ~/.dsh/wotr-merge-backup/）
```
