# 平台文件归档

这是一个 **DSH（DeepSeek Harness）插件** —— [`dsh-kdczyz-mode`](../../dsh-kdczyz-mode/)，
把三个桌面 App 的模型接进 DSH。本目录按**平台**把插件的文件归档成三份清单。

「WOTR」= **W**orkBuddy + T**rae**。

| 平台 | 清单 | provider | 入口模块 | 路由前缀 |
|---|---|---|---|---|
| **WorkBuddy** | [workbuddy.md](workbuddy.md) | `workbuddy-xdpool`<br>`workbuddy-xdpool-global` | [`lib/index.js`](../../dsh-kdczyz-mode/lib/index.js) | `/plugins/dsh-workbuddy-xdpool/*` |
| **Trae** | [trae.md](trae.md) | `trae`<br>`trae-global` | [`lib/trae.js`](../../dsh-kdczyz-mode/lib/trae.js) | `/plugins/dsh-connect-trae/*` |
| **Qoder** | [qoder.md](qoder.md) | `qoder` | [`lib/qoder.js`](../../dsh-kdczyz-mode/lib/qoder.js) | `/plugins/dsh-kdczyz-mode/qoder/*` |

五个 provider 可以**同时使用**；某一侧的改动不影响另一侧。

---

## 一、为什么是「一个包、三个入口」

cordis 按 `apply` 函数的**引用同一性**登记 runtime，而 `Config` 挂在 runtime 上。
三边都声明了 `enabledModelIds` / `imageModelIds` / `contextBudgets` / `authFile`
但**语义不同**，若共用模块就会共享一个 `Config`、同名字段互相抢值。

所以 [`cordis.patch.yml`](../../dsh-kdczyz-mode/cordis.patch.yml) 里三个 entry
指向**三个不同的模块**，且**entry id 与模块说明符都不能改名**（vendored 卡片按
确切 id 查自己的 settings 作用域；改名会让对应卡片变只读、并丢掉已存配置）。

详见 [`dsh-kdczyz-mode/lib/README.md`](../../dsh-kdczyz-mode/lib/README.md)。

---

## 二、⚠️ 共用文件 —— 不属于任何单一平台

按平台归档时**必须注意**：下列文件是三平台共用的，改成某个平台的名字是错的。

| 文件 | 为什么共用 |
|---|---|
| [`lib/index.js`](../../dsh-kdczyz-mode/lib/index.js) | **名实不符**：看着像 WorkBuddy 入口，实际同时承担三平台管理页的**全部后端路由**（`Trae` 出现 20 次、`Qoder` 92 次），并 import 了 `trae-auth` / `qoder-auth` / `qoder-pool` / `qoder-campaign` |
| [`lib/console.mjs`](../../dsh-kdczyz-mode/lib/console.mjs) | **唯一事实来源**：三标签页管理页（workbuddy 83 / trae 299 / qoder 292 处）与 composer 胶囊卡片，三平台 UI 混在一起 |
| [`lib/client.js`](../../dsh-kdczyz-mode/lib/client.js) | 浏览器端**唯一** bundle（生成产物，勿手改） |
| [`lib/credit-store.mjs`](../../dsh-kdczyz-mode/lib/credit-store.mjs) | 积分与使用记录的落盘存储，服务三平台 |
| [`lib/volatile.mjs`](../../dsh-kdczyz-mode/lib/volatile.mjs) | 宿主 `volatile` 契约助手，被 `qoder.js` 使用；文档明确写了「与哪一半无关，所以共享」 |

**共用测试**（同样跨平台，不归任何一侧）：
[`client-apply`](../../dsh-kdczyz-mode/test/client-apply.test.mjs) ·
[`console-render`](../../dsh-kdczyz-mode/test/console-render.test.mjs) ·
[`credit-store`](../../dsh-kdczyz-mode/test/credit-store.test.mjs) ·
[`host-assembly`](../../dsh-kdczyz-mode/test/host-assembly.test.mjs)。

---

## 三、三平台能力对照

从 [`docs/upstream-model-audit-2026-10-11.md`](../upstream-model-audit-2026-10-11.md)
的结论速览提炼。**这一节是理解三边差异最快的一页。**

| | WorkBuddy | Trae | Qoder |
|---|---|---|---|
| 上游能力字段 | `supportsImages` ✅ | `multimodal` ✅ | `is_vl` 存在但**完全没解析** |
| 用户手动补勾 | `imageModelIds`（并集）✅ | `imageModelIds`（并集）✅ | **无此配置项** |
| 模型白名单 | `agents[cli].models` ✅ | wire `callableKeys` ✅ | `enabledModelIds` 声明了但**没用** |
| 上下文双窗口 | `contextBudgets`（只压低）✅ | `dev`/`Max` 双档 + `contextBudgets` ✅ | `context_config` 有 1M 档**未读**；`contextBudgets` 是**死配置** |
| 兜底表 | 10 行 | cn 4 / ai 7 行 | 9 行 vs 真机 **14 行** |
| 手动刷新入口 | ✅ 路由 + 按钮 | ✅ 路由 + 按钮 | 见 [qoder.md](qoder.md) |
| 刷新时机 | 启动种子 + 手动 | 启动 + DSH 触发 + 手动 | 仅启动一次 |
| inflight 去重 | ✅ | **❌ 无** | **❌ 无** |
| 目录持久化 | settings | `lastCatalog` | **不持久化** |
| 是否需要打补丁 | ✅ 需要（3 个真实 bug） | ❌ 不需要（上游做对了） | — |

> 上表的 ❌ 项是**审计时的状态**。审计收尾记录同日晚间的修复落地 ——
> 详见该文档 §九，其中列出**刻意未改**的项。

---

## 四、三平台的登录方式各不相同

这是三边最本质的架构差异，直接决定了各自的模块划分。

| | WorkBuddy | Trae | Qoder |
|---|---|---|---|
| 协议 | 服务端发 authUrl → 浏览器登录 → **state 轮询**换 token | **真** PKCE 授权码流程 | **设备流**（PKCE + 轮询） |
| 本地端口 | 不开 | **开**回环 HTTP 等回调 | **不开** |
| 多账号来源 | 扫本机已登录账号 | 桌面端登录态 **+** 插件自有凭据 | **只能**逐个显式登录 |
| 号池 `scan()` | — | 只合并不删除 | **磁盘是唯一真相** |
| 凭据文件 | 由 vendored xdpool 自管 | `.trae-auth.<region>.<accountId>.json` | `.qoder-auth.cn.<accountId>.json` |
| 模块 | [`wb-auth.mjs`](../../dsh-kdczyz-mode/lib/wb-auth.mjs) | [`trae-auth.mjs`](../../dsh-kdczyz-mode/lib/trae-auth.mjs) | [`qoder-auth.mjs`](../../dsh-kdczyz-mode/lib/qoder-auth.mjs) |

> **为什么 Qoder 不能像另两家那样扫本机登录态**：Qoder 桌面端每个安装只保存
> **一份**登录，再登一个账号会覆盖上一个 —— 无论怎么扫，永远只能扫出一个账号。
> 这是 `qoder-auth.mjs` 存在的唯一理由。

---

## 五、目录全景

```
dsh-workbuddy-console/
├── dsh-kdczyz-mode/               ← 当前部署的合并版插件
│   ├── lib/
│   │   ├── index.js                  [WorkBuddy 入口 + 三平台共用后端]
│   │   ├── trae.js                   [Trae 入口]
│   │   ├── qoder.js                  [Qoder 入口]
│   │   ├── console.mjs / client.js   [共用：三标签页管理页 + 胶囊卡片]
│   │   ├── credit-store.mjs          [共用：落盘存储]
│   │   ├── volatile.mjs              [共用：宿主 volatile 契约]
│   │   ├── wb-auth.mjs               [WorkBuddy]
│   │   ├── trae-auth.mjs             [Trae]
│   │   ├── qoder-*.mjs（9 个）        [Qoder]
│   │   └── README.md                 ← 入口分工说明
│   ├── test/                         25 套单测 = 部署硬门禁
│   ├── vendor/xdpool/                WorkBuddy 模型池（MIT，未改动）
│   └── cordis.patch.yml              三个 Loader entry
├── docs/
│   ├── platforms/                    ← 本目录：三份平台清单
│   ├── upstream-fingerprint.md        三链路上游指纹取证
│   ├── upstream-model-audit-*.md      三链路模型能力审计
│   ├── upstream-issue-workbuddy.md    给上游作者的问题报告
│   └── qoder-*.md                     Qoder 三篇诊断
├── tools/                            部署与验证
├── patches/                          相对官方 2.0.48 的补丁
└── backup/                           整体快照 tar.gz
```

---

## 六、测试即门禁

来自 [`tools/apply-wotr.sh`](../../tools/apply-wotr.sh) 的**硬性门禁**，
任一失败即停 —— 不把坏版本推上去。

```sh
cd dsh-kdczyz-mode
node test/console-render.test.mjs   # 真正渲染三个 tab 与胶囊卡片，防设置面板白屏
node test/client-apply.test.mjs     # 仿浏览器执行 client.js，防「应用无法启动」
```

各平台专属测试见对应清单文档的「测试」一节。

> 后两层（`client-apply` / `console-render`）是**必须有**的，各对应一次真实事故：
> 一次是 `lib/client.js` 里用了未声明的 `react` → `apply` 抛 `ReferenceError`
> → cordis fiber 变 `failed` → **DSH 拒绝启动**；一次是 `console.mjs` 里
> `useEffect` 依赖数组写在 `const` 定义之前触发 TDZ → **渲染期抛错、白屏**。

---

## 七、相关文档

| 文档 | 内容 |
|---|---|
| [仓库根 README](../../README.md) | 安装、部署、验证方法、已知局限 |
| [插件 README](../../dsh-kdczyz-mode/README.md) | 插件级详细说明（69KB） |
| [lib/README.md](../../dsh-kdczyz-mode/lib/README.md) | 三个入口分工与共用模块 |
| [upstream-fingerprint.md](../upstream-fingerprint.md) | 官方头装配取证（三家） |
| [upstream-model-audit-2026-10-11.md](../upstream-model-audit-2026-10-11.md) | 三链路完整审计 |
| [backup/README.md](../../backup/README.md) | 免 git 安装的快照包 |
