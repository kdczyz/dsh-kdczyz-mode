# Qoder 平台文件清单

> 本文件是 [`kdczyz-dsh-model`](../../kdczyz-dsh-model/) 插件中 **Qoder 侧**的
> 文件归档。三个平台的总览见 [`README.md`](README.md)。

| 项 | 值 |
|---|---|
| Loader entry id | `dsh-connect-qoder` |
| 入口模块 | [`lib/qoder.js`](../../kdczyz-dsh-model/lib/qoder.js) |
| 注册的 provider | `qoder` |
| 路由前缀 | `/plugins/kdczyz-dsh-model/qoder/*` |
| 设置命名空间 | `qoder` |
| 官方客户端版本 | CLI/worker `1.1.64`、桌面宿主 `0.4.3` |
| 状态 | **已接通推理**（2026-10-11 真机端到端验证通过） |

Qoder 是三边中**模块最多、最复杂**的一侧（10 个模块 + 15 套测试）。

---

## 一、架构：本地 loopback shim + pi-ai

与 Trae 半边**同构**：

```
DSH → pi-ai 的 OpenAI 客户端 → http://127.0.0.1:<port>/v1/chat/completions
   → shim → 号池取号 → COSY 签名 → Qoder 上游 → 解信封 → 标准 OpenAI SSE
```

**分层的意义**：pi-ai 负责 OpenAI 协议，shim 负责号池与 Qoder 私有协议。

---

## 二、十个模块

| 文件 | 职责 | 测试 |
|---|---|---|
| [`qoder.js`](../../kdczyz-dsh-model/lib/qoder.js) | cordis Loader 入口：注册 provider、Config schema、目录刷新 | `qoder-provider`、`qoder-chat`、`qoder-streaming` |
| [`qoder-auth.mjs`](../../kdczyz-dsh-model/lib/qoder-auth.mjs) | **设备流**登录（PKCE + 轮询） | `qoder-auth` |
| [`qoder-pool.mjs`](../../kdczyz-dsh-model/lib/qoder-pool.mjs) | 多账号号池：`scan`/`acquire`/`penalize`/`prefer` | `qoder-pool`、`qoder-pool-route`、`qoder-dedup` |
| [`qoder-relay.mjs`](../../kdczyz-dsh-model/lib/qoder-relay.mjs) | **反代请求**：签名、发请求、解信封、分类失败 | `qoder-relay`、`qoder-payload` |
| [`qoder-fingerprint.mjs`](../../kdczyz-dsh-model/lib/qoder-fingerprint.mjs) | **出站指纹对齐**：运行时提取并驱动官方 wasm | `qoder-fingerprint` |
| [`qoder-shim.mjs`](../../kdczyz-dsh-model/lib/qoder-shim.mjs) | 本地 loopback shim（OpenAI 协议 ↔ Qoder 私有协议） | `qoder-shim` |
| [`qoder-catalog.mjs`](../../kdczyz-dsh-model/lib/qoder-catalog.mjs) | 模型目录 + 静态兜底 | `qoder-catalog` |
| [`qoder-credits.mjs`](../../kdczyz-dsh-model/lib/qoder-credits.mjs) | 积分额度查询（上游 `quota/usage`） | `qoder-credits` |
| [`qoder-campaign.mjs`](../../kdczyz-dsh-model/lib/qoder-campaign.mjs) | **每日签到**（活动线 `me/campaigns → claim`） | `qoder-campaign`、`qoder-checkin-route` |
| （共用）[`volatile.mjs`](../../kdczyz-dsh-model/lib/volatile.mjs) | 宿主 volatile 契约助手，被 `qoder.js` 使用 | — |

> **入口 id 与模块说明符都不能改**：`qoder.js` 必须是**独立模块**，理由与另两半
> 相同（cordis 按 `apply` 引用同一性登记 runtime，共用模块会共享一个 `Config`）。

---

## 三、为什么不能像另两家那样「扫本机登录态」

Qoder 桌面端**每个安装只保存一份登录**：再登一个账号会覆盖上一个。所以
「扫描本机已登录账号构成池」这条路在 Qoder 上**根本不成立** —— 无论怎么扫，
永远只能扫出一个账号。要凑出多账号池，只能**逐个显式登录**。

这是 [`qoder-auth.mjs`](../../kdczyz-dsh-model/lib/qoder-auth.mjs) 存在的唯一理由。

---

## 四、设备流：不开端口、无回调页

与 Trae 的回环回调不同，Qoder CN 用**设备流**（PKCE + 轮询），
**全程不监听任何本地端口**。

| 步骤 | 端点 |
|---|---|
| 打开授权页 | `https://qoder.cn/device/selectAccounts?challenge=…&challenge_method=S256&nonce=…&machine_id=…&client_id=…` |
| 轮询取 token | `https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256&machine_id=…` |

### 五个「踩过就会静默失败」的点

1. **`404` 表示「用户还没授权」，必须继续轮询**，不能当失败终止。这是最容易
   写错的一处：当成错误的话，用户去浏览器点确认之前轮询就结束了。
2. `200` 但载荷里没有令牌（授权页还没点）同样继续轮询；**非 404 的其它失败**
   才直报（不空转到超时）。
3. 成功判据照抄官方：`typeof token === 'string'` —— **不做数字强转**。
4. 授权 URL **刻意不带 `redirect_uri`**（设备流没有回调地址，带上会被拒）。
5. `client_id` 必须用 **CLI 的** `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`，
   桌面端那个是另一个（用错会被风控当非官方客户端）。

`machine_id` 存 `~/.qoder-cn/.auth/machine_id`，**读后 trim、绝不覆盖**；缺失才
生成并落盘；**磁盘不可写不能挡住登录**（退回内存态 UUID）。

轮询节奏照官方：间隔 1000ms，整体超时 5 分钟，单请求超时 30s。

---

## 五、号池：磁盘是唯一真相

三种分配策略（`priority` / `round-robin` / `balanced`）与逐模型冷却，
接口与 Trae 侧同款。

**唯一的关键差异在 `scan()`**：

| | Trae | Qoder |
|---|---|---|
| 账号来源 | 桌面端登录态 **+** 插件自有凭据 | **只有**插件自有凭据文件 |
| 扫描语义 | 只合并不删除 | **以磁盘为准，文件没了就出池** |

Qoder 的入池通道**只有**设备流登录，池的内容**就是**这些文件，所以 `scan()`
必须以磁盘为准。这正是「**移出池子**」的实现方式：删掉
`.qoder-auth.cn.<accountId>.json`，下次扫描它就不在候选里了。

> 这条差异是被一次**真实 bug** 逼出来的：最初照抄 Trae 的「只合并」，结果
> 「移出池子」删了文件、账号却仍留在池里继续被选中。

**冷却与用量状态跨 `scan()` 保留**（`scan()` 在全池冷却时也会被调用，正在冷却
的账号不该因为这次重扫被重置）；但账号一旦出池，它的 `lastUsedAt` / 余额 /
保留额度 / 停用标记会被一并清理，不让状态无限增长。

### 凭据落盘

```
$DSH_HOME/.qoder-auth.cn.<accountId>.json
```

`accountId = sha256(edition + \0 + (userId || userName || 'unknown')).slice(0,24)`

> 同一算法在 `qoder-auth.mjs` 与 `qoder-pool.mjs` 里**各存一份**（**刻意不互相
> import**，免得登录模块被拖进池/provider 的依赖图），靠 `qoder-auth.test.mjs`
> 里一条「两边算出同一个 id」的断言守住一致。

---

## 六、反代请求（`qoder-relay.mjs`）

### CN 的推理**必须签名**，且没有 REST 路径

国内版的推理**没有** REST 的 `/model/v1/chat/completions`（那条路径只对国际版
开放），必须走签名路径：

| 项 | 值 |
|---|---|
| gateway | `https://gateway.qoder.com.cn` |
| 路径 | `/algo/api/v2/service/pro/sse/agent_chat_generation` |
| 查询串 | `FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` |

### 算法取证：取自官方客户端本体，不是猜的

官方产物：

```
/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/
  node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs
```

版本 `1.1.64`。

### `dt-` 原样可用，不需要换 `jt-`

### Qoder 反代是怎么打通的（2026-10-11 真机修正）

早期版本卡在「官方自定义 Base64 编码器（在 wasm 里，拿不到）」并据此返 501。

真机实测**推翻了那个前提**：**查询串不带 `Encode` 时明文 body 直接被接受** ——
官方编码器不再是接通推理的必要条件。

### SSE 是套了两层的信封

`unwrapQoderFrame()` 负责解包。`isQoderDoneFrame()` 判结束帧。

### 失败回灌号池

`applyQoderRelayFailure()` / `classifyQoderRelayFailure()` 把上游失败分类后
回灌给号池（触发冷却或标记耗尽）。

---

## 七、出站指纹对齐（`qoder-fingerprint.mjs`）

这是全项目**技术上最硬**的一块。

### 为什么需要这一层

官方客户端生成「签名 + 自定义编码 body + 整套 `Cosy-*` 头」的方式
**不是一个可以用纯 JS 复刻的算法**：

1. **签名**（COSY）的摘要串拼接在官方 wasm 内部，静态读不到；
2. **body 编码**是自定义 Base64，且**与总长度/跨块状态相关** —— 用官方 wasm
   当预言机逐字节探测即可证明：单字节输入就已经出现映射冲突（同一个 6-bit 值
   在不同位置映射到不同字符）。所以「还原置换表」这条路走不通，**必须用官方实现**。

### 做法：运行时从本机安装提取官方 wasm

官方 wasm（298,606 字节，导出 `qodercontext_*` /
`generate_runtime_auth_fields`）以 base64 内联在 Qoder 客户端的 worker runtime 里。

插件**在运行时从本机读它、提取并驱动**，而**不是**把厂商二进制提交进仓库
—— 后者是再分发闭源二进制，不该做。本机没有该文件时，
`createQoderFingerprint()` 返回 `undefined`，由调用方退回手写 COSY。

### 官方的正确调用顺序（照抄，不能省步骤）

```js
// ① 由 uid + token 生成运行时鉴权字段
const e = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid, security_oauth_token, organization_id, organization_tags, data_policy_agreed,
})));  // → { encrypt_user_info, key }

// ② 建 ctx 时用**匿名占位**，不是真实身份
const ctx = new QoderContext(machineId, COSY_VERSION,
  JSON.stringify({ uid: "", encrypt_user_info: "", key: "" }),
  JSON.stringify(getClientMetadata()));

// ③ 再用 refreshAuthFields 把真实身份灌进去
ctx.refreshAuthFields(JSON.stringify({ uid, encrypt_user_info, key, ... }));

// ④ 生成请求
ctx.prepareInferRequest(base, body, modelKey, modelSource);
```

> ⚠️ **跳过 ①③ 会在 HTTP 200 下拿到业务 403 `Signature invalid`**：
> 签名 payload 里的 `info` 会是空串（实测），错误形态伪装成「签名算法不对」，
> 很容易让人去反复改签名实现。必须按 ①②③④ 的顺序来。

### 两个易踩的坑

- **`userInfo` 必须带 `encrypt_user_info` 与 `key` 两个键**（可为空串）。
  缺任一个 `qodercontext_new` 直接返回错误（实测 `err=1`）。
- **`COSY_VERSION` 用 `1.1.64`**（worker 里硬编码 `s5="1.1.64"`），
  不是桌面宿主的 `0.4.3`，也不是旧版插件写的 `1.1.58`。
- wasm 的 `prepareInferRequest` 会**无条件**产出 `Cosy-MachineToken` 与
  `Cosy-MachineType`，而官方在 native bridge（UMID）拿得到真机器令牌时**先删掉**
  这两个头。不这么做就是一个可识别的形态 —— wasm 在匿名占位身份下把
  `Cosy-MachineToken` 填成 **machineId 本身**（实测
  `Cosy-MachineToken === Cosy-MachineId`）。

---

## 八、管理页接口

前缀 `/plugins/kdczyz-dsh-model/qoder/*`：

| 路由 | 作用 |
|---|---|
| `POST …/qoder/login/start` | 发起设备流登录，返回 `sessionId` + `authUrl` |
| `GET  …/qoder/login/status?session=` | 轮询登录状态；`done` 时落盘并让池重扫 |
| `POST …/qoder/login/cancel?session=` | 取消登录 |
| `GET  …/qoder/pool` | 号池快照（账号 + 冷却 + 停用 + 保留额度） |
| `POST …/qoder/pool/remove` | 移出池子 |
| `POST …/qoder/credits/refresh` | 刷新额度 |
| `POST …/qoder/checkin` | 每日签到 |
| `POST …/qoder/cooldowns/reset` | 清除冷却 |
| `POST …/qoder/models/refresh` | 刷新模型目录 |

> 「这四件事以前各有 POST 路由（`/qoder/pool/config`、`/pool/account`…），
> 管理页这边只读不写」—— 见 `lib/index.js:908` 附近注释。

`GET …/qoder/pool` **可能在 provider 就绪前就被调到**（极早的路由调用），
所以 `lib/index.js:1388` 先给回退单例备好 logger。

---

## 九、面板挂在两个地方

Qoder 面板（`QoderPoolPanel`）同时渲染在**两个 tab** 下：「账号」页的第三列，
与独立的「Qoder 配置」页。两处**共用同一个 props 对象**（`qoderPanelProps`），
不复制两份 —— 复制迟早漏改一处，表现为「同一个面板在两个地方行为不一样」。

> **代价**：所有「可见性」判定都必须以
> `qoderVisible = tab === 'qoder' || tab === 'accounts'` 为准（懒加载与自动刷新
> 都依赖它）。只写 `tab === 'qoder'` 会让从「账号」页进来的那一列**空白且余额
> 永远停在「读取中…」**，而面板照样渲染、**不报任何错**。
> `console-render.test.mjs` 里有一组真跑 effect + 驱动定时器的用例钉着这条，
> 反向验证过（改回 `tab === 'qoder'` → 4 条全红）。

---

## 十、积分与签到

### 积分额度（上游 `quota/usage`）

`fetchQoderQuotaUsage()` / `refreshQoderPoolCredits()` /
`resolveQoderServingCredits()`。

### 每日签到（活动线）

端点：`sash/api/v1/me/campaigns → claim`。

按账号领取活动 Credits，**不切换正在使用的账号**。

> ⚠️ **静默坑**：`Cosy-ClientType` 必须是 `10`。写错不会报错，只会拿不到活动。

### 自动刷新（每 30 秒，无手动按钮）

Qoder 配置页的积分余额每 30 秒自动刷新。

---

## 十一、模型

「Qoder 配置」页的「模型」区（`QoderModelsPanel`）：逐模型启用勾选 +
「**从 Qoder 刷新**」。图片与上下文**跟随上游**。

### 为什么必须有静态兜底

DSH 对每一行模型都要求一个正整数 `contextWindow`（判据在宿主的
adapter 校验里），所以 `qoder-catalog.mjs` 必须提供静态兜底表 —— 启动时若池里
还没账号，provider 会一直停在"目录空"的状态。

`QODER_FALLBACK_CONTEXT_WINDOW` 即该兜底值。

---

## 十二、测试（15 套）

| 文件 | 守什么 |
|---|---|
| [`qoder-auth.test.mjs`](../../kdczyz-dsh-model/test/qoder-auth.test.mjs) | 设备流登录五坑 + 两边算法一致 |
| [`qoder-pool.test.mjs`](../../kdczyz-dsh-model/test/qoder-pool.test.mjs) | 「磁盘是唯一真相」+ 出池状态清理 |
| [`qoder-pool-route.test.mjs`](../../kdczyz-dsh-model/test/qoder-pool-route.test.mjs) | `/qoder/pool` 路由与快照字段 |
| [`qoder-dedup.test.mjs`](../../kdczyz-dsh-model/test/qoder-dedup.test.mjs) | 请求去重 |
| [`qoder-relay.test.mjs`](../../kdczyz-dsh-model/test/qoder-relay.test.mjs) | 签名、发请求、解信封、失败分类 |
| [`qoder-payload.test.mjs`](../../kdczyz-dsh-model/test/qoder-payload.test.mjs) | 请求体构造 |
| [`qoder-fingerprint.test.mjs`](../../kdczyz-dsh-model/test/qoder-fingerprint.test.mjs) | 指纹头装配（含 `Cosy-MachineToken` 删除） |
| [`qoder-shim.test.mjs`](../../kdczyz-dsh-model/test/qoder-shim.test.mjs) | loopback shim 协议转换 |
| [`qoder-catalog.test.mjs`](../../kdczyz-dsh-model/test/qoder-catalog.test.mjs) | 目录与静态兜底 |
| [`qoder-credits.test.mjs`](../../kdczyz-dsh-model/test/qoder-credits.test.mjs) | 额度查询与 serving 判定 |
| [`qoder-campaign.test.mjs`](../../kdczyz-dsh-model/test/qoder-campaign.test.mjs) | 活动线签到（含 `Cosy-ClientType=10`） |
| [`qoder-checkin-route.test.mjs`](../../kdczyz-dsh-model/test/qoder-checkin-route.test.mjs) | 签到路由 |
| [`qoder-provider.test.mjs`](../../kdczyz-dsh-model/test/qoder-provider.test.mjs) | provider 注册与模型表（**不打真网**） |
| [`qoder-chat.test.mjs`](../../kdczyz-dsh-model/test/qoder-chat.test.mjs) | 对话链路 |
| [`qoder-streaming.test.mjs`](../../kdczyz-dsh-model/test/qoder-streaming.test.mjs) | 流式输出 |

---

## 十三、诊断文档

| 文档 | 内容 |
|---|---|
| [`docs/qoder-502-rate-diagnosis.md`](../qoder-502-rate-diagnosis.md) | 「速率快、老 502」的根因：**不是上游限流**，是插件把可流式响应完整缓冲后才回给客户端（首字节 421ms → 人为变成 5.3 秒） |
| [`docs/qoder-registration-diagnosis.md`](../qoder-registration-diagnosis.md) | 设备流注册诊断 |
| [`docs/qoder-tool-message-502.md`](../qoder-tool-message-502.md) | 工具消息导致 502 的定位 |
| [`docs/upstream-fingerprint.md`](../upstream-fingerprint.md) | Qoder 指纹取证（含 `COSY_VERSION` / 头常量） |
| [`docs/upstream-model-audit-2026-10-11.md`](../upstream-model-audit-2026-10-11.md) | 三链路审计，Qoder 部分占比最大（**结论速览**表里 Qoder 的 ❌ 项最多） |

---

## 十四、已知局限

见 [插件 README](../../kdczyz-dsh-model/README.md) 的「已知局限」一节与
[`docs/qoder-502-rate-diagnosis.md`](../qoder-502-rate-diagnosis.md) 的收尾部分。

要点：
- 依赖 Qoder **私有接口**，官方改协议可能失效
- 指纹层依赖**本机装了 Qoder 客户端**（读不到 wasm 时退回手写 COSY，能力降级）
- 早期版本对「官方编码器」的假设已被真机推翻，相关 501 逻辑不再是必要条件

---

## 十五、相关

- 三平台总览：[`docs/platforms/README.md`](README.md)
- WorkBuddy 侧：[`docs/platforms/workbuddy.md`](workbuddy.md)
- Trae 侧：[`docs/platforms/trae.md`](trae.md)
- 入口分工与共用模块：[`kdczyz-dsh-model/lib/README.md`](../../kdczyz-dsh-model/lib/README.md)
