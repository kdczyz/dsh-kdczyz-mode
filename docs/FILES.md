# 文件作用总览 —— dsh-kdczyz-mode 全仓库

> 全仓库 **284 个文件**（不含 `.git` 与 `node_modules`）。本文件逐个说明作用。
>
> **关键区分**：真正在运行的是 [`dsh-wotr-console/`](#二核心dsh-wotr-console64-文件)
> 一个包（64 文件）。其余 200+ 文件是**归档、快照与备份** —— 它们不是第二份代码，
> 而是历史留存，改它们不影响任何行为。

---

## 零、快速地图

| 目录 | 文件数 | 性质 | 一句话 |
|---|---:|---|---|
| [`dsh-wotr-console/`](dsh-wotr-console/) | **64** | **活跃** | **当前部署的合并版插件（唯一改这里）** |
| [`docs/`](docs/) | 11 | 活跃 | 诊断、取证、审计、平台清单与本文件 |
| [`tools/`](tools/) | 17 | 活跃 | 部署、验证、打桩 |
| [`patches/`](patches/) | 9 | 活跃 | 相对官方 2.0.48 的补丁 |
| [`dsh-workbuddy-console/`](dsh-workbuddy-console/) | 41 | 归档 | 合并前的 WorkBuddy 单插件 |
| [`dsh-connect-trae/`](dsh-connect-trae/) | 15 | 归档 | 合并前的 Trae 插件原版 |
| [`.backup-before-lite/`](.backup-before-lite/) | 54 | 备份 | 精简前的完整备份（含已删的 web 控制台） |
| [`backup/`](backup/) | 70 | 快照 | 免 git 安装用的整体 tar.gz + 展开副本 |
| 根文件 | 3 | 活跃 | `package.json`（安装壳）、`README.md`、`.gitignore` |

**要改代码，只动 `dsh-wotr-console/`。** 其余目录改了不起作用。

---

## 一、根目录（3 文件）

| 文件 | 作用 |
|---|---|
| [`package.json`](package.json) | **安装壳**。DSH 判定「组合包」只看 `dsh.bundle.patch` 字段；此壳声明它指向 `./dsh-wotr-console/cordis.patch.yml`，让插件管理页能 `pnpm add github:kdczyz/dsh-kdczyz-mode` 直装。同时转发 4 个 `exports` 子路径（`.` / `./trae` / `./qoder` / `./client`）。 |
| [`README.md`](README.md) | 主说明（38KB）：安装（含两个踩过的坑）、修了什么、部署、验证方法、管理页、形态对比、已知局限。 |
| [`.gitignore`](.gitignore) | 忽略 `node_modules`、`backup/` 展开目录等。 |

---

## 二、核心：`dsh-wotr-console/`（64 文件）

### 2.1 `lib/` —— 插件全部代码（18 文件）

**三个 Loader 入口**（`cordis.patch.yml` 各指向一个，必须是三个不同模块）：

| 文件 | entry id | 注册 provider | 作用 |
|---|---|---|---|
| [`index.js`](dsh-wotr-console/lib/index.js) | `llm-workbuddy-xdpool` | `workbuddy-xdpool`、`workbuddy-xdpool-global` | **WorkBuddy 入口 + 三平台共用后端**（管理页全部路由）。⚠️ 名实不符，见 [lib/README.md](dsh-wotr-console/lib/README.md) |
| [`trae.js`](dsh-wotr-console/lib/trae.js) | `dsh-connect-trae` | `trae`、`trae-global` | Trae 半边（上游 3.0.0 逐字节并入，零改动） |
| [`qoder.js`](dsh-wotr-console/lib/qoder.js) | `dsh-connect-qoder` | `qoder` | Qoder 半边（设备流号池 + 反代） |

**共用模块**（不属于任何单一平台）：

| 文件 | 作用 |
|---|---|
| [`console.mjs`](dsh-wotr-console/lib/console.mjs) | **唯一事实来源**（5965 行）：三标签页管理页 + composer 那颗可点击展开的积分胶囊。**改界面改这个**。 |
| [`client.js`](dsh-wotr-console/lib/client.js) | 浏览器端**唯一** bundle。**生成产物，勿手改** —— 由两个脚本内联而成。 |
| [`credit-store.mjs`](dsh-wotr-console/lib/credit-store.mjs) | 积分与使用记录落盘（`credit-samples` / `history` / `daily` 三个 `.jsonl`）。 |
| [`volatile.mjs`](dsh-wotr-console/lib/volatile.mjs) | 宿主 `volatile` 契约助手（`asVolatile` / `unwrapVolatile`）。不这么做设置会**静默丢弃**。 |
| [`README.md`](dsh-wotr-console/lib/README.md) | 入口分工与共用模块说明（新增）。 |

**WorkBuddy 侧**： [`wb-auth.mjs`](dsh-wotr-console/lib/wb-auth.mjs) —— 登录协议（authUrl + state 轮询，**不开本地端口**）。

**Trae 侧**： [`trae-auth.mjs`](dsh-wotr-console/lib/trae-auth.mjs) —— 真 PKCE 授权码流程，回调走**本机回环 HTTP**。

**Qoder 侧（9 个）**：

| 文件 | 作用 |
|---|---|
| [`qoder-auth.mjs`](dsh-wotr-console/lib/qoder-auth.mjs) | **设备流**登录（PKCE + 轮询，不开端口）。404 = 还没授权，必须继续轮询 |
| [`qoder-pool.mjs`](dsh-wotr-console/lib/qoder-pool.mjs) | 多账号号池。`scan()` **以磁盘为唯一真相** |
| [`qoder-relay.mjs`](dsh-wotr-console/lib/qoder-relay.mjs) | 反代请求：COSY 签名、发请求、**解双层信封**、失败分类 |
| [`qoder-fingerprint.mjs`](dsh-wotr-console/lib/qoder-fingerprint.mjs) | **出站指纹对齐**：运行时从本机安装提取并驱动官方 wasm |
| [`qoder-shim.mjs`](dsh-wotr-console/lib/qoder-shim.mjs) | 本地 loopback shim（OpenAI 协议 ↔ Qoder 私有协议） |
| [`qoder-catalog.mjs`](dsh-wotr-console/lib/qoder-catalog.mjs) | 模型目录 + 静态兜底（DSH 要求每行有正整数 `contextWindow`） |
| [`qoder-credits.mjs`](dsh-wotr-console/lib/qoder-credits.mjs) | 积分额度查询（上游 `quota/usage`） |
| [`qoder-campaign.mjs`](dsh-wotr-console/lib/qoder-campaign.mjs) | 每日签到（活动线 `me/campaigns → claim`）。`Cosy-ClientType` 必须是 `10` |

### 2.2 `test/` —— 25 套单测（25 文件）

**全部是 `tools/apply-wotr.sh` 的硬性门禁**，任一失败即停。

共用 4 套：

| 文件 | 作用 |
|---|---|
| [`client-apply.test.mjs`](dsh-wotr-console/test/client-apply.test.mjs) | 仿浏览器执行 `client.js` 并真调 `apply`。**防「DSH 无法启动」**（曾因未声明的 `react` 导致启动失败） |
| [`console-render.test.mjs`](dsh-wotr-console/test/console-render.test.mjs) | 真正渲染三个 tab 与 composer 胶囊卡片（5337 行，444 项）。**防设置面板白屏**（曾抓到 TDZ 缺陷） |
| [`credit-store.test.mjs`](dsh-wotr-console/test/credit-store.test.mjs) | 数据层读写、去重、坏行容错 |
| [`host-assembly.test.mjs`](dsh-wotr-console/test/host-assembly.test.mjs) | 三个入口在目标 profile 下**真的能加载** |

WorkBuddy 3 套：`wb-auth`（64 项）、`wb-fingerprint`、`wb-pool-selected`

Trae 3 套：`trae-auth`（71 项）、`trae-pool`（46 项）、`trae-checkin-route`

Qoder 15 套：`qoder-auth`、`qoder-pool`、`qoder-pool-route`、`qoder-dedup`、`qoder-relay`、`qoder-payload`、`qoder-fingerprint`、`qoder-shim`、`qoder-catalog`、`qoder-credits`、`qoder-campaign`、`qoder-checkin-route`、`qoder-provider`、`qoder-chat`、`qoder-streaming`

### 2.3 其余（23 文件）

| 路径 | 作用 |
|---|---|
| [`cordis.patch.yml`](dsh-wotr-console/cordis.patch.yml) | **三个 Loader entry**。注释详述「为什么必须三个不同模块」（cordis 按 `apply` 引用同一性登记 runtime）。**entry id 不能改名** |
| [`package.json`](dsh-wotr-console/package.json) | 插件清单：`exports` 4 子路径、peer 范围（两条版本线并集，避免 pnpm 另装遮住宿主）、25 套测试脚本 |
| [`scripts/gen-console-inline.mjs`](dsh-wotr-console/scripts/gen-console-inline.mjs) | 把 `console.mjs` 内联进 `client.js`。**支持 `--check`**（门禁用它校验同步） |
| [`scripts/gen-xdpool-client.mjs`](dsh-wotr-console/scripts/gen-xdpool-client.mjs) | 把 `vendor/xdpool/lib/client.js` 内联进 `client.js` |
| [`README.md`](dsh-wotr-console/README.md) | 插件级详述：provider 清单、三个 tab、composer 胶囊卡片、Qoder 全链路、反代原理 |
| [`LICENSE`](dsh-wotr-console/LICENSE) / [`THIRD-PARTY.md`](dsh-wotr-console/THIRD-PARTY.md) | MIT + 第三方声明 |
| `icons/`（2 文件） | Trae 图标 64/128 px（继承自上游） |
| `vendor/xdpool/`（12 文件） | **WorkBuddy 模型池实现**，自上游 1.7.1 并入、**未改动**。见下 |

**`vendor/xdpool/` 明细**：

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主侧：账号发现、模型池、shim、签到/任务（8294 行，上游代码） |
| `lib/client.js` | 浏览器侧「XD Pool」卡片，被内联进 `client.js` |
| `lib/dsml-bridge.mjs` | **本 fork 新增**：DSML → tool_calls 桥接（四种方言） |
| `lib/bin.js` | 命令行 `dsh-workbuddy-xdpool doctor` 等 |
| `lib/index.d.ts` | 类型定义（10 万行） |
| `README.md` / `LICENSE-ORIGINAL` | 上游说明与 MIT 声明（**不能删**） |
| `screenshots.json` + `assets/`（4 png） | 上游截图元数据与配图 |

---

## 三、`docs/`（11 文件）

### 本文件

| 文件 | 作用 |
|---|---|
| [`FILES.md`](docs/FILES.md) | **本文件**：全仓库 284 个文件的作用速查 |

### 平台清单

| 文件 | 作用 |
|---|---|
| [`platforms/README.md`](docs/platforms/README.md) | 三平台总览：能力对照表、登录方式差异表、共用文件警告、目录全景 |
| [`platforms/workbuddy.md`](docs/platforms/workbuddy.md) | WorkBuddy 侧：入口、vendored 池、3 个真实 bug 的根因与验证 |
| [`platforms/trae.md`](docs/platforms/trae.md) | Trae 侧：入口、4 种安装发现、区域网关、号池语义 |
| [`platforms/qoder.md`](docs/platforms/qoder.md) | Qoder 侧：10 模块、设备流五坑、wasm 指纹四步顺序、9 条路由 |

### 原有诊断与取证

| 文件 | 作用 |
|---|---|
| [`upstream-model-audit-2026-10-11.md`](docs/upstream-model-audit-2026-10-11.md) | **三链路模型能力审计**（52KB）：三条链路骨架对比、逐项 ❌、§九 修复落地清单 |
| [`upstream-fingerprint.md`](docs/upstream-fingerprint.md) | **三家官方客户端的出站指纹取证**（WorkBuddy 头装配、Trae、Qoder 的 `Cosy-*`） |
| [`upstream-issue-workbuddy.md`](docs/upstream-issue-workbuddy.md) | 给 WorkBuddy 插件作者的**问题报告草稿**（可直接粘贴） |
| [`qoder-502-rate-diagnosis.md`](docs/qoder-502-rate-diagnosis.md) | 「老 502」根因：**不是限流**，是可流式响应被完整缓冲（首字节 421ms → 5.3s） |
| [`qoder-registration-diagnosis.md`](docs/qoder-registration-diagnosis.md) | 设备流注册诊断 |
| [`qoder-tool-message-502.md`](docs/qoder-tool-message-502.md) | 工具消息导致 502 的定位 |

---

## 四、`tools/`（17 文件）

### 部署脚本

| 文件 | 作用 |
|---|---|
| [`apply-wotr.sh`](tools/apply-wotr.sh) | **一键部署合并版**。8 步：源码门禁（25 套测试）→ 备份 profile → rsync → 改 package.json → 改 cordis.patch.yml → 删 3 个旧包 → 校验语法 → host-assembly 自检。macOS 专用 |
| [`apply.sh`](tools/apply.sh) | 合并**前**的 WorkBuddy 单插件部署（历史） |
| [`install-trae.sh`](tools/install-trae.sh) | 安装/恢复 Trae 单插件（回滚用） |

### 验证与排查

| 文件 | 作用 |
|---|---|
| [`dsml-test.mjs`](tools/dsml-test.mjs) | DSML 桥接层 44 项单测（含文本重复 bug 回归） |
| [`raw-probe.mjs`](tools/raw-probe.mjs) | **直连上游抓原始 SSE**，绕过 DSH 以区分"上游问题"还是"中间层问题" |
| [`read-session.mjs`](tools/read-session.mjs) | 解压并检索会话日志（`session.v4.jsonl.zstd`） |
| [`link-host-deps.mjs`](tools/link-host-deps.mjs) | 把宿主内包挂进 profile。**只给本机开发部署用** —— 新设备安装不需要（DSH 自己会路由） |

### 库与打桩

| 文件 | 作用 |
|---|---|
| [`lib/asar.mjs`](tools/lib/asar.mjs) | **纯 JS 的 asar 读取器**，让取宿主内包不依赖 Electron |
| [`lib/host-deps.mjs`](tools/lib/host-deps.mjs) | 宿主依赖装配（跨平台）。**已确认多余**（DSH 会内存路由），保留给裸 Node 跑测试用 |
| [`stub/`](tools/stub/)（3 文件） | `stub.mjs` / `hooks.mjs` / `register.mjs`：独立进程运行插件所需的依赖打桩 |
| [`stub-probe/`](tools/stub-probe/)（5 文件） | 扩展打桩，多出 `stub-home.mjs` / `stub-atomic.mjs`（home-paths、atomic-write），供合并版探针用 |

---

## 五、`patches/`（9 文件）

| 文件 | 作用 |
|---|---|
| [`03-vendor-pool.patch`](patches/03-vendor-pool.patch) | **仍在用**：修「工具定义丢失」（`legacyContext()`）+ 流式桥接接线 |
| [`04-dsml-bridge.mjs`](patches/04-dsml-bridge.mjs) | **仍在用**：修「文本每 token 重复两遍」+ DSML 方言兜底 |
| [`README.md`](patches/README.md) | 补丁说明：哪些还在用、哪些已失效、精简版 `index.js` 的来历 |
| `obsolete-console/`（5 文件） | **已失效**的历史补丁与原文（控制台移除后无对应文件）。`account-check.mjs` 修的「凭证未解密」现已由 vendored xdpool 承担 |
| `originals/vendor-xdpool-index.js` | 官方 2.0.48 的原文，用于对照与回滚 |

---

## 六、归档与备份（180 文件，**改了不起作用**）

### `dsh-workbuddy-console/`（41）—— 合并前的 WorkBuddy 单插件

含已移除的控制台时代残留：`lib/console.mjs`、`credit-store.mjs`，以及
`scripts/` 下 13 个历史脚本（`prepublish-check`、`prove-*-guard`、
`publish-via-proxy`、`git-tunnel`、`install` 等 —— 发布与防回归探针）。

> 它的 `lib/account-check.mjs` 等 7 个后端模块**已在此目录中被删除**，
> 完整版见 `.backup-before-lite/`。

### `dsh-connect-trae/`（15）—— 合并前的 Trae 插件原版

上游 `dsh-connect-trae@3.0.0`，**未改动**。含 `lib/index.js`（Trae 宿主侧）、
`lib/client.js`（已被合并版移除的浏览器半边）、`docs/assets/` 截图、
`scripts/verify-windows.mjs`。

### `.backup-before-lite/`（54）—— 精简前的完整备份

**唯一保留控制台全貌的地方**。相比归档包多出：

- `lib/account-check.mjs`、`billing-proxy.mjs`、`credit-meter.mjs`、
  `credit-samples.mjs`、`history.mjs`、`skill-market.mjs`、`tasks.mjs`（7 个已删模块）
- `web/`（6 文件）：`index.html` + `app.js` + `style.css` + 3 个 i18n —— **已移除的独立控制台前端**
- `scripts/`（20 个历史脚本，比归档版更全）

### `backup/`（70）—— 免 git 安装的快照包

| 路径 | 作用 |
|---|---|
| `dsh-wotr-console-1.1.0-20261011.tar.gz` | **整体快照**（1.1 MB）：插件本体 + 安装壳 + 全部说明，解包即用 |
| `*.tar.gz.sha256` | 校验和 |
| `README.md` | 快照说明：raw 直链、怎么校验、里面没有什么 |
| `dsh-wotr-console-1.1.0-20261011/`（67 文件） | **展开副本**（在 `.gitignore` 里，只留本机）。含 `MANIFEST.txt`（66 个文件的 sha256） |

> 展开副本是 tar.gz 的解包结果，**内容重复**。仓库里只提交压缩包。

---

## 七、三个「看起来重复」的目录怎么区分

新手最容易困惑的点，一次说清：

| 疑问 | 答案 |
|---|---|
| 为什么 `vendor/xdpool/` 出现在 4 个地方？ | `dsh-wotr-console/` 里是**活跃的**；`dsh-workbuddy-console/` 是旧插件的；`.backup-before-lite/` 是备份的；`backup/*/` 是快照的。**只有第一个在跑** |
| `dsh-workbuddy-console/` 和 `.backup-before-lite/dsh-workbuddy-console/` 有何不同？ | 后者是**精简前**的版本，多 7 个后端模块 + `web/` 控制台 |
| `backup/` 里的展开目录要提交吗？ | **不要**，已在 `.gitignore` 里。它只是 tar.gz 的解包结果 |
| 改 `dsh-workbuddy-console/` 里的代码有用吗？ | **没有**。它已被合并版取代，且部署脚本会**主动删除**它 |

---

## 八、改文件前先看这张表

| 想做什么 | 改哪里 |
|---|---|
| 改设置面板界面 | [`dsh-wotr-console/lib/console.mjs`](dsh-wotr-console/lib/console.mjs) → 跑 `scripts/gen-console-inline.mjs` |
| 改某个 provider 的行为 | 对应入口：`lib/index.js`（WB）/ `lib/trae.js` / `lib/qoder.js` |
| 改账号池策略 | `vendor/xdpool/lib/index.js`（WB）或 `lib/qoder-pool.mjs`（Qoder） |
| 加一个管理页接口 | [`dsh-wotr-console/lib/index.js`](dsh-wotr-console/lib/index.js)（共用后端） |
| 部署 | [`tools/apply-wotr.sh`](tools/apply-wotr.sh)（先 `--dry-run`） |
| 打补丁给上游 | [`patches/README.md`](patches/README.md) |
| 其它任何目录 | **不用改** |

---

## 九、相关

- 主说明：[`README.md`](README.md)
- 平台清单：[`docs/platforms/`](docs/platforms/)
- 入口分工：[`dsh-wotr-console/lib/README.md`](dsh-wotr-console/lib/README.md)
- 快照说明：[`backup/README.md`](backup/README.md)
