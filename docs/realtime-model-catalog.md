# 上游模型目录与「倍率」的实时获取（三家统一）

> 结论一句话：三家的**倍率都随模型目录一起来**，所以"实时倍率" = "实时目录"。
> 而 DSH 的模型选择器**不走 discovery**——它走一条同步的适配器读取链。所以
> 「实时」必须挂在**读路径**上，而不是 discovery 或定时器上。

---

## 一、倍率字段从哪来（三家各不相同）

| 平台 | 上游端点 | 倍率字段 | 解析位置 |
|---|---|---|---|
| **WorkBuddy** | CN：`/v2/enterprises/personal/models`；Global：`/v3/config` | 条目的 `credits` 字符串，形如 `"x0.79 credits"` | `parseCreditMultiplier`（vendor） |
| **Trae** | 远程目录 + Solo 目录，多函数结果并集 | `display_contact_config`（**内嵌 JSON 字符串**）→ `consumption_rate.data.rate`；远程目录另有 `features.consumption_rate.data.rate` | `wireCreditMultiplier` / `parseTraeRemoteModel` |
| **Qoder** | `GET /algo/api/v2/model/list?Encode=1`（走签名链） | 条目的 `price_factor` | `parseQoderModelList` |

**Trae 的 wire 值优先**：`display_contact_config` 里那份是**折后价**，远程目录给的是原价
（实测同一模型：远程 `0.8` vs wire `0.08`，限时 1 折，差 10 倍）。所以合并时 wire 赢。

**`0` 是合法倍率**，语义是"免费/限时免费"（Qoder 官方的 `formatFactor` 也这么处理）。
三家展示统一为 `名称 · x0.79`，`0` 显示 `免费`。

---

## 二、DSH 宿主侧的数据通路（关键约束）

```
聊天选择器（dsh-client-ui-model-selection）
  └─ ModelCatalogDirectory.load()   ← 有快照缓存！只在 4 个事件后失效
       └─ remote.session.modelCatalog()
            └─ buildModelCatalog(ctx)            dsh-api-session-controller
                 └─ ctx.llm.listModels(provider) dsh-llm
                      └─ adapter.listModels()    PiAiAdapter (dsh-llm-pi-ai)
                           └─ pi-ai Models.getModels()   ← 同步，一帧可能调十几次
                                └─ provider.getModels()
                                     └─ 插件的 buildModels()  ← 读内存里的 catalog
```

三条硬事实：

1. **`getModels()` 是同步的**，且每次调用都实时重算（pi-ai `dist/models.js` 的
   `entry.getModels()`）。所以插件只要刷新内存目录，读路径立刻拿到新值——
   **但读路径不能阻塞**，它一帧会被调十几次。
2. **discovery 不是选择器的数据源**。`llm.discoverModels()` 只被 Models 设置页
   （"拉取模型"按钮）与 `dsh-llm-pi-ai` 内部用到，且它**只透传 5 个字段**
   （`id/name/contextWindow/maxTokens/inputModalities`）。
   → **倍率只能拼进 `name`**，这是插件现在唯一可行的做法。
3. **客户端有快照缓存**：`load()` 见到 `status === "ready"` 就直接返回旧值，
   只在收到这四个事件之一时才 `invalidate()` 重读：
   `llm/adapters-updated`、`settings/document-updated`、
   `credentials/record-updated`、`credentials/reference-updated`。
   插件能主动发的只有第一个——`registerAdapter()` / `registerConfigurableProviders()`
   返回的句柄上 `.replace([...])` 会走到 `commitRoutes()` → `emitAdaptersUpdated()`。

---

## 三、改造前的问题（"不是实时"的两个根因）

1. **目录缓存不主动刷新**：Qoder / WorkBuddy 只在「启动种子 + 手动按钮」拉上游；
   Trae 只在启动种子写 `catalog`（它的 discovery 刷新**不写** `catalog`）。
2. **刷新后不通知客户端**：插件刷完目录没有触发任何失效事件，客户端选择器
   继续用它自己的快照。

结果：上游调价后，选择器里的 `x0.79` 会一直是启动那一刻的数字，直到重启 DSH。

---

## 四、改造方案：读时刷新（stale-while-revalidate）

新增 `lib/live-catalog.mjs`，三平台共用同一套语义：

- **读路径不阻塞**：`ensureFresh()` 立即返回，刷新在后台跑。选择器先看到旧值，
  下一帧就是新值。
- **TTL 节流**：距上次**成功**刷新超过 TTL（默认 60s）才打上游。
- **并发合并**：同刻只打一次上游（选择器一帧读十几次）。
- **失败退避**：失败**不更新**"上次成功时间"（否则一次 5xx 会给陈旧目录续命一整个
  TTL），另记"上次尝试时间"，15s 内不重试。
- **变更才广播**：用 `catalogSignature()`（只取 `id/name/倍率`，按 `id` 排序）
  比较，**只有真的变了**才 `.replace()` 广播。无脑每轮广播 = 每个 TTL 周期白抖一次 UI。

### 各家的落点

| 平台 | 读路径钩子 | 刷新动作 | 广播方式 |
|---|---|---|---|
| **Qoder** | `visibleModels()` 里 `liveFeed.ensureFresh()` | `catalog.refresh(cred)` | `registration.adapter.replace([QODER_PROVIDER])` |
| **WorkBuddy** | `createWorkBuddyAdapter({ beforeModels })` | `client.fetchModels()` × 两个 region | `api.publishCatalog()` → `directory.replace([...])` |
| **Trae** | `createTraeAdapter({ beforeModels })` | `stack.discoverModels()` → `derive()` → `catalog.set()` | `registration[region].adapter.replace([...])` |

### 刻意没做的事

- **没动 Trae 的卡片列表**。卡片（`displayModels`）只读**保存值**，这是产品要求：
  「仅手动获取上游模型在启用后才会更新模型列表」。实时刷新只作用于**选择器路径**
  上的 `stack.catalog`，不写回设置。用户没点「从 Trae 刷新」时，卡片仍是手动快照，
  而选择器拿到的是当前上游的真实目录与真实倍率。
- **没给 Qoder / WorkBuddy 的卡片快照加实时**。同理：卡片是"我上次拉到了什么"的
  记录，选择器才是"现在有什么"。
- **没做定时轮询**：打开选择器的那一刻才是真正需要新数据的那一刻，定时器只是空转。

---

## 五、管理页手动刷新也跟着广播

手动刷新（`POST /wb/models/refresh`、`/qoder/models/refresh`、Trae 的
`/models/refresh`）成功后会**同时**标新鲜 + 广播。少了广播这一步，用户点完刷新
卡片更新了、选择器里还是旧名字与旧倍率，看起来像"刷新没生效"。

---

## 六、可配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_LIVE_CATALOG_TTL_MS` | `60000` | WorkBuddy 侧 TTL（vendored 侧读这个环境变量） |

`lib/live-catalog.mjs` 的 `DEFAULT_LIVE_TTL_MS` / `DEFAULT_LIVE_RETRY_MS` 是
Qoder / Trae 的默认值，也接受 `createLiveRefresher({ ttlMs, retryMs })` 覆盖。

---

## 七、怎么验证它真的生效

1. 跑 `npm test`：`live-catalog`（协调器语义）与 `live-wiring`（三家接线）两套
   必须全绿。后者是**关键**——协调器写得再对，没人调用 `ensureFresh()` 的话，
   行为与改造前完全一样，而所有既有测试仍会全绿。
2. 部署后打开聊天模型选择器，看模型名后的 `x倍率`；上游调价后**不重启** DSH，
   等过一个 TTL 再打开一次，数字应当跟着变。
3. 管理页的「目录更新于 …」（Qoder 卡片）会随实刷新生效而前进。
