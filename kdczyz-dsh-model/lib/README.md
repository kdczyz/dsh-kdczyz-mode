# lib/ —— 三个 Loader 入口与共用模块

本目录是插件**全部宿主侧与浏览器侧代码**。文件名按平台分成三组前缀
（`wb-` / `trae-` / `qoder-`），但**有三个入口文件与四个共用模块不属于任何
单一平台** —— 这份说明就是为了说清它们的分工，避免按文件名误判。

> 按平台归档的详细清单见仓库 [`docs/platforms/`](../../docs/platforms/)：
> [workbuddy.md](../../docs/platforms/workbuddy.md) ·
> [trae.md](../../docs/platforms/trae.md) ·
> [qoder.md](../../docs/platforms/qoder.md)。

---

## 一、三个入口（`cordis.patch.yml` 各指向一个）

| 文件 | Loader entry id | 注册的 provider | 实际职责 |
|---|---|---|---|
| `index.js` | `llm-workbuddy-xdpool` | `workbuddy-xdpool`<br>`workbuddy-xdpool-global` | **WorkBuddy 入口 + 三平台共用后端** |
| `trae.js` | `dsh-connect-trae` | `trae`<br>`trae-global` | Trae 半边（上游逐字节并入） |
| `qoder.js` | `dsh-connect-qoder` | `qoder` | Qoder 半边（设备流号池 + 反代） |

**为什么必须是三个不同的模块**：cordis 按 `apply` 函数的**引用同一性**登记
runtime，而 `Config` 挂在 runtime 上。三边都声明了 `enabledModelIds` /
`imageModelIds` / `contextBudgets` / `authFile` 但语义不同，若共用模块就会
共享一个 `Config`、同名字段互相抢值。详见 [`cordis.patch.yml`](../cordis.patch.yml)
顶部注释。**entry id 与模块说明符都不能改名**（vendored 卡片按确切 id 查自己的
settings 作用域；改名会让对应卡片变只读、并丢掉已存配置）。

### ⚠️ `index.js` 名实不符 —— 它不只是 WorkBuddy 入口

文件名看着像 WorkBuddy 专属，实际它**同时承担三标签页管理页的全部后端路由**，
三个平台的配置与查看都挂在它上面。文件内 `Trae` 出现 20 次、`Qoder` 出现 92 次。

它额外 import 了另两半的模块：

```js
import * as traeAuth from './trae-auth.mjs';
import * as qoderAuth from './qoder-auth.mjs';
import { QoderAccountPool, QoderCredentialStore } from './qoder-pool.mjs';
import { checkinQoderAccount } from './qoder-campaign.mjs';
import { currentQoderApi } from './qoder.js';
```

**为什么不改名**：`package.json` 的 `exports["."]` / `main`、`cordis.patch.yml`
的 entry、profile 里已存的配置、以及多个测试都按 `index.js` 解析。改名收益
仅是一个更好看的文件名，代价是打断四处引用链，不划算。故保留文件名，在此说明。

> `import { currentQoderApi } from './qoder.js'` 是**跨入口读模块级状态**
> （拿 Qoder provider 的就绪句柄）。它只**读**，不改 `qoder.js` 的 `apply`
> 引用同一性，所以不影响"三个独立 runtime"这条约束。

---

## 二、四个共用模块（不属于任何单一平台）

| 文件 | 作用 | 被谁用 |
|---|---|---|
| `console.mjs` | **唯一事实来源**：三标签页管理页 + composer 那颗可点击的积分胶囊（含展开卡片） | 生成进 `client.js` |
| `client.js` | 浏览器端**唯一** bundle（生成产物，勿手改） | DSH 客户端 |
| `credit-store.mjs` | 积分与使用记录的落盘存储（`*.jsonl`） | `index.js` 的管理页路由 |
| `volatile.mjs` | 宿主 `volatile` 契约助手（`asVolatile` / `unwrapVolatile`） | `qoder.js` |

### `console.mjs` 与 `client.js` 的关系（改界面必读）

`console.mjs` 是普通 ES 模块（便于阅读与测试），由
[`scripts/gen-console-inline.mjs`](../scripts/gen-console-inline.mjs) **内联**进
`client.js`（后者是 classic script，不能有顶层 `import`）。

`client.js` 是**两块生成内容的容器**：

1. 管理页 —— 来自 `console.mjs`
2. 账号池客户端 —— 来自 [`vendor/xdpool/lib/client.js`](../vendor/xdpool/lib/client.js)，
   由 [`scripts/gen-xdpool-client.mjs`](../scripts/gen-xdpool-client.mjs) 生成

> **改界面请改 `console.mjs`，然后重跑生成脚本**：
> ```sh
> node scripts/gen-console-inline.mjs
> ```
> 忘了跑这步界面上不会有任何变化，**也不报错** —— 部署门禁
> （`apply-wotr.sh` 与 `check:console`）会拦下来。

> ⚠️ 样式块 `const CSS = \`…\`` 是一整个**模板字符串**：往里写注释时**不要用反引号**
> 括标识符（例如反引号包住的 `--dsw-…`），那会直接把模板串截断，`node --check`
> 报出来的是一串与 CSS 毫无关系的语法错（Invalid left-hand side expression
> in postfix operation，指向 `const CSS` 那一行）。标识符裸写即可。

### `volatile.mjs` 为什么共享

DSH 0.1.7 起，设置写入闸门要求 schema 里至少有一个 volatile 字段，否则 `set()`
直接抛 `Plugin entry "qoder" has no volatile fields`。没有标记的后果**不是**
保存时报错那么明显：`set()` 仍会 resolve，卡片看着保存成功，实际每次都被**静默
丢弃并回滚**。这条契约是**宿主的**，与哪一半无关，所以在每个入口里各抄一份不如
放一个共享模块。详见文件顶部注释。

---

## 三、平台专属模块索引

前缀即归属，不再重复列举。完整清单（含每个模块的一句话职责、对应测试、
provider id、路由前缀、凭据路径）见 [`docs/platforms/`](../../docs/platforms/)。

| 前缀 | 模块数 | 入口 |
|---|---|---|
| `wb-*` | 1（`wb-auth.mjs`） | `index.js` |
| `trae-*` | 1（`trae-auth.mjs`） | `trae.js` |
| `qoder-*` | 10 | `qoder.js` |
| `vendor/xdpool/` | 5（WorkBuddy 池实现，MIT，上游 XDTrees） | `index.js` |

---

## 四、相关目录

| 路径 | 内容 |
|---|---|
| [`../test/`](../test/) | 25 套单测 = 部署硬门禁（`npm test` 一条链跑完） |
| [`../scripts/`](../scripts/) | 两个内联生成脚本 |
| [`../vendor/xdpool/`](../vendor/xdpool/) | WorkBuddy 模型池（并入，未改动） |
| [`../cordis.patch.yml`](../cordis.patch.yml) | 三个 Loader entry |
