# WorkBuddy 平台文件清单

> 本文件是 [`kdczyz-dsh-model`](../../kdczyz-dsh-model/) 插件中 **WorkBuddy 侧**
> 的文件归档。三个平台的总览见 [`README.md`](README.md)。

| 项 | 值 |
|---|---|
| Loader entry id | `llm-workbuddy-xdpool` |
| 入口模块 | [`lib/index.js`](../../kdczyz-dsh-model/lib/index.js) |
| 注册的 provider | `workbuddy-xdpool`（国内版）、`workbuddy-xdpool-global`（国际版） |
| 路由前缀 | `/plugins/dsh-workbuddy-xdpool/*` |
| 设置命名空间 | `workbuddy-xdpool` |
| 上游实现 | vendored [`vendor/xdpool/`](../../kdczyz-dsh-model/vendor/xdpool/)（MIT，上游 XDTrees/dsh-workbuddy-xdpool 1.7.1） |
| 补丁 | [`patches/03-vendor-pool.patch`](../../patches/03-vendor-pool.patch)、[`patches/04-dsml-bridge.mjs`](../../patches/04-dsml-bridge.mjs) |

---

## 一、入口模块

### `lib/index.js` —— ⚠️ 名实不符

文件名看着像 WorkBuddy 专属，**实际它同时是三平台共用的管理页后端**。
详见 [`lib/README.md`](../../kdczyz-dsh-model/lib/README.md) 第一节。

它承担的 WorkBuddy 侧职责：

- 通过 vendored xdpool 注册两个 LLM provider（国内 / 国际）
- 转发 vendored 的 Config schema，让 DSH 设置页能生成配置表单
- **热重载兜底**：`clearStaleLlmRoutes()` 按 provider id 清掉上一实例残留的 LLM
  注册。不这么做，热重载窗口内新实例注册同一批 provider 会抛 `DUPLICATE_ADAPTER`
- `watchLlmRegistration()` 诊断：等 12s 仍无 `workbuddy-xdpool` adapter 就报错，
  并在"provider 已注册但可见模型为 0"时提示检查 `modelSelectionCn.enabledModelIds`

> **为什么 `inject` 只有 `['llm', 'settings']`，不含 `webServer`**：
> vendored xdpool 自己声明的是 `inject = ['llm', 'settings']`，但本插件是
> **手动同步调用**它的 `apply()`，绕过了 cordis 的 inject 门控 —— 于是
> "settings 还没就绪"时它会在内部抛错被 try/catch 吞掉，结果是它那 9 条池路由
> **一条都没注册**。把依赖列在 `inject` 里，cordis 会等到它们全部可用才调用
> 本插件的 `apply`，那时转发给 vendored apply 才是安全的。
>
> 管理页需要读历史记录的两条只读路由通过 `ctx.inject(['webServer'], ...)`
> **按需自注入**挂载。这样宿主没提供 webServer 时插件照常工作，只是管理页
> 读不到历史；也不会因为声明 `webServer` 而拖慢插件启动。

### `lib/wb-auth.mjs` —— WorkBuddy 登录协议

**不是** OAuth 授权码流程（没有 client_id / redirect_uri / PKCE，不需要本地
回调服务）。实际是：**服务端发 authUrl → 浏览器登录 → 拿 state 轮询换 token**。

| 项 | 值 |
|---|---|
| 凭据落盘 | 由 vendored xdpool 管理，本模块供浏览器登录添加账号用 |
| 测试 | [`test/wb-auth.test.mjs`](../../kdczyz-dsh-model/test/wb-auth.test.mjs)（64 项） |
| 界面入口 | 管理页「账号」标签页左列「**添加账号**」 |

> 插件全程不接触密码：登录在官方页面里完成，插件只接收登录后的令牌。
> 凭据是**明文落盘**的，风险说明与「已验证 / 未验证」清单见
> [插件 README](../../kdczyz-dsh-model/README.md) 的「浏览器登录添加账号」一节。
> **国际版与 Trae 侧目前未做实测**。

### `lib/wb-fingerprint` 相关

WorkBuddy 侧还有一处指纹对齐逻辑，测试在
[`test/wb-fingerprint.test.mjs`](../../kdczyz-dsh-model/test/wb-fingerprint.test.mjs)。
上游头的装配细节（`X-User-Id` / `X-Enterprise-Id` / `X-Userinfo` 等 11 个
`runIdentityHeaders()` 常量）取证见
[`docs/upstream-fingerprint.md`](../upstream-fingerprint.md) 第一节。

---

## 二、vendored 模型池

[`vendor/xdpool/`](../../kdczyz-dsh-model/vendor/xdpool/) 是**整个 WorkBuddy 池
实现**，自上游 `XDTrees/dsh-workbuddy-xdpool` 1.7.1 并入，**代码未做修改**
（便于随时与上游对照升级），仅 `lib/index.js` 打过下列补丁。

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主侧：账号发现、模型池、shim 服务、签到 / 任务 |
| `lib/client.js` | 浏览器侧：设置页的「XD Pool」卡片（被内联进 `lib/client.js`） |
| `lib/bin.js` | 命令行：`dsh-workbuddy-xdpool doctor` 等 |
| `lib/dsml-bridge.mjs` | **本 fork 新增**的 DSML → tool_calls 桥接层 |
| `lib/index.d.ts` | 类型定义 |

### 打过的两个补丁（核心修复，必须保留）

| 补丁 | 目标 | 修的问题 |
|---|---|---|
| [`03-vendor-pool.patch`](../../patches/03-vendor-pool.patch) | `vendor/xdpool/lib/index.js` | **工具定义丢失**（`legacyContext()`）+ 流式桥接接线 |
| [`04-dsml-bridge.mjs`](../../patches/04-dsml-bridge.mjs) | 新增 → `vendor/xdpool/lib/dsml-bridge.mjs` | **文本每 token 重复两遍** + DSML 方言兜底 |

### Bug 1：工具定义根本没发到上游（最严重）

**现象**：用 WorkBuddy 模型对话，回复里出现 `<｜DSML｜tool_calls>` 之类的标记
文本；工具从不执行。

**根因**：pi-ai 处理请求时走 `resolveTranscript()` → `collapseSystemMessages()`，
它**只用 `context.messages` 重建 transcript，会直接丢掉顶层的
`context.systemPrompt` 和 `context.tools`**。pi-ai 自带的 `normalizeContext()`
会把这两者折成「首条 `system` 消息 + `toolsAdded`」，但插件是**直接调用
`api.stream()`**，绕过了那层归一化。

结果：发往上游的请求体里**没有 `tools`**。模型拿不到工具 schema，只能自己编
一套调用格式（DeepSeek 的 DSML 标记），DSH 只认原生 `tool_calls`，于是把标记
当普通文本渲染出来。

**修复**：`vendor/xdpool/lib/index.js` 的 `legacyContext()` —— 把系统提示词与
工具折成 pi-ai 真正读取的形状。

**验证依据**：
- 修复前请求日志：`keys=model|messages|stream|...`（无 `tools`）
- 修复后请求日志：`keys=model|messages|stream|...|tools` ✓
- 让模型用 `write` 工具写文件 → 去磁盘核对内容，4 个 WorkBuddy 模型全部写对

### Bug 2：文本每个 token 重复两遍

**根因**：WorkBuddy 网关在**每一帧**都带 `finish_reason: ""`，而桥接层只把
`null`/`undefined` 当作"未结束"。于是每个内容帧被"改写一遍 + 原帧又透传一遍"。

**修复**（`dsml-bridge.mjs`）：空字符串也按"未结束"处理；**凡是被改写过的帧
绝不再原样转发**。

**验证依据**：抓一段真实上游 SSE，按 1/3/7/64/4096 五种切块方式过一遍桥接层，
输出与上游文本**逐字节一致**。

### Bug 3：误报「所有账号均已失效」

**根因**：旧控制台自己读凭证只做 `JSON.parse`，而 WorkBuddy 5.6+ 把
`accessToken` 写成了 `$wbEncrypted` 信封。于是拿对象当 token 发出去 →
`Bearer [object Object]` → 上游 401 → 被误判为账号失效。账号其实是好的。

**修复**：控制台读凭证那段代码已随控制台一并移除；现在凭证完全由 vendored
xdpool 管理，它用 `currentApi().pool` 拿的是**已解密**的凭证，问题从根上不存在。

### DSML 桥接（保险层）

即使上游哪天又把工具调用漏成文本，`dsml-bridge.mjs` 也能在 SSE 流里实时识别
并改写成标准 `tool_calls`。它认**四种方言**：

| 方言 | 形态 |
|---|---|
| DeepSeek DSML | 全角竖线单/双写、ASCII 竖线 |
| Hunyuan 式 | `tool_calls:ID` |
| Kimi 式 | `<tool>名字</tool>` |

**解析不出来就原样透传**，不会比不装更差。

---

## 三、测试

| 文件 | 项数 | 守什么 |
|---|---|---|
| [`test/wb-auth.test.mjs`](../../kdczyz-dsh-model/test/wb-auth.test.mjs) | 64 | 登录 state 轮询、凭据落盘 |
| [`test/wb-fingerprint.test.mjs`](../../kdczyz-dsh-model/test/wb-fingerprint.test.mjs) | — | 出站指纹头装配 |
| [`test/wb-pool-selected.test.mjs`](../../kdczyz-dsh-model/test/wb-pool-selected.test.mjs) | — | 「当前账号」的池选中语义（选中才放行、未选即失败） |

WorkBuddy 侧的**数据层与桥接层**另有测试在仓库 `tools/` 下：
[`tools/dsml-test.mjs`](../../tools/dsml-test.mjs)（44 项，含文本重复 bug 的回归）。

---

## 四、凭据与数据

| 项 | 路径 |
|---|---|
| 账号来源 | 读 WorkBuddy 桌面端**已完成的登录**（本插件不代替登录） |
| 凭据管理 | vendored xdpool 自管，`lib/index.js` **不读不写任何凭据文件** |
| 使用记录 | `~/.dsh/plugin-data/dsh-workbuddy-console/`（目录名**有意保留旧插件名**，改名会让历史记录凭空消失） |

数据结构（由 [`lib/credit-store.mjs`](../../kdczyz-dsh-model/lib/credit-store.mjs)
写入，格式沿用控制台时代，旧数据直接续上）：

```
~/.dsh/plugin-data/dsh-workbuddy-console/
├── credit-samples.jsonl   { ts, day, uid, nickname, credit }         （最近 120 天）
├── history.jsonl          { ts, day, uid, nickname, credit,
│                            checkedIn, streakDays, source }          （最近 400 天）
└── daily.jsonl            { day, uid, nickname,
                             first, firstTs, last, lastTs, n }        （最近 400 天）
```

> **采集时机：只在打开管理页时**（不做后台轮询）—— 既不产生无谓网络请求，
> 也避免后台常驻任务。

---

## 五、上游问题报告

给插件作者的问题报告草稿（含复现步骤、根因、修复建议，可直接粘贴）：
[`docs/upstream-issue-workbuddy.md`](../upstream-issue-workbuddy.md)。

长期修法建议把这两个问题反馈给上游：**工具定义被 pi-ai 归一化丢弃**、
**5.6+ 凭证未解密**。

---

## 六、相关

- 三平台总览：[`docs/platforms/README.md`](README.md)
- Trae 侧：[`docs/platforms/trae.md`](trae.md)
- Qoder 侧：[`docs/platforms/qoder.md`](qoder.md)
- 入口分工与共用模块：[`kdczyz-dsh-model/lib/README.md`](../../kdczyz-dsh-model/lib/README.md)
- 三链路模型能力审计：[`docs/upstream-model-audit-2026-10-11.md`](../upstream-model-audit-2026-10-11.md)
