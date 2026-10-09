# patches/ — WorkBuddy 修复补丁

这些补丁针对**官方 `dsh-workbuddy-console@2.0.48`**，被打进 `dsh-workbuddy-console/`。
改动后该插件已成为**纯 provider 插件**（无控制台），所以补丁集也随之精简。

---

## 仍在用的补丁（核心修复）

| 文件 | 目标 | 修的问题 |
|---|---|---|
| `03-vendor-pool.patch` | `vendor/xdpool/lib/index.js` | **工具定义丢失**（`legacyContext()`）+ 流式桥接接线 |
| `04-dsml-bridge.mjs` | 新增文件 → `vendor/xdpool/lib/dsml-bridge.mjs` | **文本每词重复两遍** + DSML 方言兜底 |

这两个是「用 WorkBuddy 模型时回复乱码、工具不执行、文本重复」的真正修复，必须保留。

### 应用方式

```sh
cd <官方 dsh-workbuddy-console@2.0.48 目录>
patch -p1 < .../patches/03-vendor-pool.patch
cp .../patches/04-dsml-bridge.mjs   vendor/xdpool/lib/dsml-bridge.mjs
```

打完补丁后，还要**把 `lib/index.js` 换成精简版**（见下节），否则它仍会尝试注册控制台路由。

---

## obsolete-console/ — 已失效（历史留存）

控制台被移除后，这些补丁与原文不再有对应文件。保留仅作追溯。

| 文件 | 原本修什么 | 为何失效 |
|---|---|---|
| `01-lib-account-check.patch` | **凭证 `$wbEncrypted` 未解密** → 误报「所有账号均已失效」 | `lib/account-check.mjs` 已删除；该修复现已由 vendored xdpool 承担（它本来就有解密能力） |
| `02-lib-index.patch` | 控制台的任务/技能市场改用解密凭证 | 控制台版 `lib/index.js` 已被重写为精简版 |
| `account-check.mjs` / `tasks.mjs` / `index.js` | 官方 2.0.48 原文 | 对应文件已从插件中删除 |

> **注意**：`01` 修的那个问题在新形态下**不会复现**，因为插件不再自己读凭证 —— 它完全委托给 vendored xdpool，而 xdpool 用 `currentApi().pool` 拿的是已解密的凭证。

---

## originals/

官方 2.0.48 的 `vendor/xdpool/lib/index.js` 原文，用于和 `03-vendor-pool.patch` 的结果对照，或回滚。

---

## 精简版的 lib/index.js 从哪来

`dsh-workbuddy-console/lib/index.js` 与 `lib/client.js` 已重写，形态对齐 `dsh-connect-trae`：

- `inject` 从 `['webServer', 'llm', 'settings']` 改为 `['llm', 'settings']`
- 删掉全部 31 处 `webServer.register(...)` 调用
- 删掉控制台前端（`web/`）与 7 个控制台后端模块
- 保留：provider 注册转发、`Config` 转发、`clearStaleLlmRoutes` 热重载兜底、`watchLlmRegistration` 诊断

这不是一个 patch 能表达的重写，所以以文件形式直接落在插件目录里。
