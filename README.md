# dsh-workbuddy-mode

把 **WorkBuddy** 与 **Trae** 两个桌面 App 的模型接进 DeepSeek Harness。
**两边已合并为一个插件**：`dsh-wotr-console`。

| 插件 | 状态 | 作用 |
|---|---|---|
| **`dsh-wotr-console@1.1.0`** | **合并版 · 已部署** | WorkBuddy 模型池 + Trae 接入，两个独立 provider 家族，共用一张五标签页管理页（配置 + 查看，账号页左右两列） |
| `dsh-workbuddy-console@2.0.48` | 归档（已被合并版取代） | 合并前的 WorkBuddy 单插件 |
| `dsh-connect-trae@3.0.0` | 归档（已被合并版取代） | 合并前的 Trae 单插件，原版未改动 |

「WOTR」= **W**orkBuddy + T**rae**。

合并版提供的四个 provider：`workbuddy-xdpool`、`workbuddy-xdpool-global`、
`trae`、`trae-global` —— 彼此独立，可同时使用。

> **2026-10-09 变更**
> - 两个插件**合并为 `dsh-wotr-console`**，用两个 Loader entry 指向不同模块
>   （原生两套 Config schema，字段不会互相覆盖）。详见 [dsh-wotr-console/README.md](dsh-wotr-console/README.md)。
> - profile 已切换：旧的两个包从 `dependencies` / `bundles` / `node_modules`
>   与 `pnpm-lock.yaml` 中**全部移除**，现在只挂 `dsh-wotr-console`（link: 到本仓库）。
> - 合并过程中修掉一个真实缺陷：`console.mjs` 的 `useEffect` 依赖数组在
>   `loadTrae` 的 `const` 定义之前引用它（TDZ），渲染期抛错 → 设置面板白屏。
> - WorkBuddy 的独立 Web 控制台（`/wb-console`）此前已移除，形态对齐 Trae —— 只注册 LLM provider。
> - DSH 原生管理页（设置面板内）**扩展为五标签页**：XD Pool / Trae 配置 / 账号 / 积分 / 使用记录 —— 两边的**配置**也并了进来；「账号」页**左右两列**分列 WorkBuddy 与 Trae，设置里不再有独立的池页面、Trae 卡片与单独的 Trae 账号页。
> - 仓库根新增 `package.json`（**安装壳**）：让 DSH 插件管理页能直接从这个 GitHub 地址安装。
>   详见下面「零、安装」。

---

## 零、安装

### 方式一：DSH 插件管理页直接装（推荐）

设置 → 插件 → 安装，填：

```text
github:kdczyz/dsh-workbuddy-mode
```

或完整地址 `https://github.com/kdczyz/dsh-workbuddy-mode`。

**为什么以前装不上**：插件管理页 `pnpm add <git 地址>` 装的是**仓库根**，
装完后它读包根的 `package.json` 找 `dsh.bundle.patch` —— 组合包的判定标准就是这一个字段
（DSH 文档原文：*A bundle is a package whose `package.json` declares `dsh.bundle.patch`*）。
而这个仓库以前根目录**没有 package.json**，真正的插件在子目录 `dsh-wotr-console/`，
于是 pnpm 生成占位包、DSH 找不到组合包声明，报「这个包没有声明组合包，不能作为插件管理」。

**现在为什么能装上**：仓库根的 `package.json` 是一个薄壳——

| 字段 | 值 | 作用 |
|---|---|---|
| `name` | `dsh-wotr-console` | 与已部署的包名保持一致，profile 里存的 entry id / 设置项全部沿用 |
| `main` / `exports["."]` | `./dsh-wotr-console/lib/index.js` | WorkBuddy 半边入口 |
| `exports["./trae"]` | `./dsh-wotr-console/lib/trae.js` | Trae 半边入口（第二个 Loader entry） |
| `exports["./client"]` | `./dsh-wotr-console/lib/client.js` | 浏览器端 bundle（五标签页） |
| `dsh.bundle.patch` | `./dsh-wotr-console/cordis.patch.yml` | **组合包声明**，管理页据此识别 |
| `dsh.client` | `platform: web` + inject 列表 | 客户端注入目标 |

壳只在包根做转发，插件代码仍在 `dsh-wotr-console/` 下，两个 Loader entry 的名字
（`dsh-wotr-console`、`dsh-wotr-console/trae`）与 profile 里已保存的配置**完全不变**。

### 方式二：本地开发部署（link:）

```bash
./tools/apply-wotr.sh            # 部署到 desktop profile
./tools/apply-wotr.sh --dry-run  # 只看计划
```

这条路径把 `dsh-wotr-console/` 直接同步进 `~/.dsh/profiles/desktop/node_modules/dsh-wotr-console`，
并在 profile 的 `dependencies`（`link:`）与 `dsh.profile.bundles` 里登记。
改代码即时生效（要重启 DSH）。

> 两种方式的包名都是 `dsh-wotr-console`，但**同时只能走一条**：
> 管理页装了 git 版本后，本地 `link:` 会被替换掉，反之亦然。

---

## 一、目录结构

```
dsh-workbuddy-mode/
├── README.md                      ← 本文件
├── dsh-wotr-console/              ← **合并版插件（当前部署的就是它）**
│   ├── lib/index.js                 WorkBuddy 半边：provider 注册 + 管理页接口 + 热重载兜底
│   ├── lib/trae.js                  Trae 半边（上游宿主 lib/index.js 并入；浏览器半边已移除）
│   ├── lib/wb-auth.mjs              WorkBuddy 登录协议（客户端 OAuth 轮询换 token）
│   ├── lib/trae-auth.mjs            Trae 登录协议（ExchangeToken + 设备绑定）
│   ├── lib/client.js                浏览器端唯一 bundle（两块内联 + settings 作用域解析）
│   ├── lib/console.mjs              五标签页管理页源码（唯一事实来源）
│   ├── lib/credit-store.mjs         积分与历史记录的落盘存储
│   ├── cordis.patch.yml             两个 Loader entry（勿改 id，见文件内注释）
│   ├── scripts/gen-console-inline.mjs 把 console.mjs 内联进 client.js（支持 --check）
│   ├── scripts/gen-xdpool-client.mjs  把 vendor/xdpool/lib/client.js 内联进 client.js
│   ├── test/credit-store.test.mjs   数据层单测（14 项）
│   ├── test/client-apply.test.mjs   仿浏览器调用 apply 的单测（34 项，防启动失败）
│   ├── test/console-render.test.mjs 真正渲染五个 tab（含账号页两列与活句柄）的单测（145 项，防白屏）
│   ├── test/wb-auth.test.mjs        WorkBuddy 登录协议单测（64 项）
│   ├── test/trae-auth.test.mjs      Trae 登录协议单测（71 项）
│   ├── test/trae-pool.test.mjs      Trae 账号池与凭据落盘单测（46 项）
│   └── vendor/xdpool/               WorkBuddy 模型池（含已修复的核心逻辑）
├── dsh-workbuddy-console/         ← 合并前的 WorkBuddy 单插件（归档）
├── dsh-connect-trae/              ← 合并前的 Trae 插件原版归档（v3.0.0，未改动）
├── patches/                       ← WorkBuddy 相对官方 2.0.48 的补丁
│   ├── 03-vendor-pool.patch         工具定义丢失修复 + 流式桥接接线
│   ├── 04-dsml-bridge.mjs           新增文件：DSML → tool_calls 桥接层
│   ├── README.md                    补丁说明（哪些还在用、哪些已失效）
│   ├── obsolete-console/            控制台时代的历史补丁与原文（已失效）
│   └── originals/                   官方 2.0.48 原文（回滚/对照用）
├── docs/
│   └── upstream-issue-workbuddy.md 给插件作者的问题报告草稿（复现步骤 + 根因 + 修复建议，可直接粘贴）
├── tools/                         ← 部署与验证工具
│   ├── apply-wotr.sh                 **合并版：一键部署（含门禁 + 备份 + 清旧包）**
│   ├── apply.sh                     合并前的 WorkBuddy 单插件部署脚本
│   ├── install-trae.sh              合并前的 Trae 安装/恢复脚本
│   ├── dsml-test.mjs                44 项单元测试
│   ├── raw-probe.mjs                直连上游抓原始 SSE（绕过 DSH 排查用）
│   ├── read-session.mjs             解压并检索会话日志
│   ├── stub/                        独立进程运行插件所需的依赖打桩
│   └── stub-probe/                  扩展打桩（含 home-paths / atomic-write，供合并版探针用）
└── .backup-before-lite/           ← 精简前的完整备份（含 web/ 与全部后端模块）
```

---

## 二、修了什么

### 1. 「乱码」的真正根因：工具定义根本没发到上游

**现象**：用 WorkBuddy 模型对话，回复里出现 `<｜DSML｜tool_calls>` 之类的标记文本；工具从不执行。

**根因**：pi-ai 处理请求时走 `resolveTranscript()` → `collapseSystemMessages()`，它**只用 `context.messages` 重建 transcript，会直接丢掉顶层的 `context.systemPrompt` 和 `context.tools`**。pi-ai 自带的 `normalizeContext()` 会把这两者折成「首条 `system` 消息 + `toolsAdded`」，但插件是**直接调用 `api.stream()`**，绕过了那层归一化。

结果：发往 WorkBuddy 上游的请求体里**没有 `tools`**。模型拿不到工具 schema，只能自己编一套调用格式（DeepSeek 的 DSML 标记），DSH 只认原生 `tool_calls`，于是把标记当普通文本渲染出来。

**修复**（`vendor/xdpool/lib/index.js` 的 `legacyContext()`）：把系统提示词与工具折成 pi-ai 真正读取的形状。

**验证依据**：
- 修复前请求日志：`keys=model|messages|stream|...`（无 `tools`）
- 修复后请求日志：`keys=model|messages|stream|...|tools` ✓
- 让模型用 `write` 工具写文件 → 去磁盘核对内容，4 个 WorkBuddy 模型全部写对

### 2. 文本每个 token 重复两遍

**根因**：WorkBuddy 网关在**每一帧**都带 `finish_reason: ""`，而桥接层只把 `null`/`undefined` 当作"未结束"。于是每个内容帧被"改写一遍 + 原帧又透传一遍"。

**修复**（`vendor/xdpool/lib/dsml-bridge.mjs`）：空字符串也按"未结束"处理；**凡是被改写过的帧绝不再原样转发**。

**验证依据**：抓一段真实上游 SSE，按 1/3/7/64/4096 五种切块方式过一遍桥接层，输出与上游文本**逐字节一致**。

### 3. 误报「所有账号均已失效，需要重新登录」

**根因**：原来是控制台自己读凭证只做 `JSON.parse`，而 WorkBuddy 5.6+ 把 `accessToken` 写成了 `$wbEncrypted` 信封。于是拿对象当 token 发出去 → `Bearer [object Object]` → 上游 401 → 被误判为账号失效。账号其实是好的。

**修复**：控制台读凭证那段代码已随控制台一并移除；现在凭证完全由 vendored xdpool 管理，它用 `currentApi().pool` 拿的是**已解密**的凭证，问题从根上不存在了。

### 4. 点「拉起 WorkBuddy 桌面版」导致 DSH 崩溃

**根因**：`spawn('/Applications/WorkBuddy.app')` 在 macOS 上触发 `EACCES`，而异步 `error` 事件无人监听 → 宿主 fatal 崩溃。

**修复**：该按钮属于控制台，已随控制台一并移除，**此功能不再存在，崩溃路径消失**。

### 5. 新增保险层：DSML 桥接

即使上游哪天又把工具调用漏成文本，`dsml-bridge.mjs` 也能在 SSE 流里实时识别并改写成标准 `tool_calls`。它认四种方言：DeepSeek DSML（全角竖线单/双写、ASCII 竖线）、Hunyuan 式 `tool_calls:ID`、Kimi 式 `<tool>名字</tool>`。**解析不出来就原样透传**，不会比不装更差。

---

## 三、部署

```sh
cd dsh-workbuddy-mode            # 改成你实际克隆下来的目录
./tools/apply-wotr.sh --dry-run    # 先看计划，不改任何文件
./tools/apply-wotr.sh              # 真正部署
```

合并版是一次**替换**（不是原地更新），脚本依次做：

1. **源码门禁** —— 校验 `client.js` 内联块与 `console.mjs` 同步，再跑三套单测（14+21+31）；任一失败即停，不把坏版本推上去。
2. **备份** profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 与两个旧包到 `~/.dsh/wotr-merge-backup/<时间戳>/`。
3. `rsync --delete` 同步 `dsh-wotr-console/`。
4. 改 profile `package.json`：依赖换成 `link:` 指向本仓库，`bundles` 里两个旧包换成新包。
5. 改 profile `cordis.patch.yml`：旧包名替换为 `dsh-wotr-console`，移除独立的 `dsh-connect-trae` 条目（entry id 保持不变）。
6. **移除三个旧包目录**（`dsh-workbuddy-console`、`dsh-connect-trae`、`dsh-workbuddy-xdpool`）—— 必须删，否则与新包争用同一批 entry id 会导致加载两次。
7. 语法校验。

脚本**不跑 `pnpm install`**：它会重算 lockfile 并清掉旧包，所以要手动补一步（否则下次 DSH 启动的 install 可能把旧包拉回来）：

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
cd ~/.dsh/profiles/desktop && "$NODE" "$PNPM" install     # 应显示 Packages: -3
```

**部署后必须重启 DSH**（退出后重新打开）：这些是 ES module，热重载不会重新加载代码。

**配置方式**：重启后 → **设置 → WOTR**（一个入口，五个标签页）：

- **`XD Pool`** 标签页 —— WorkBuddy 侧配置：管理账号池、勾选模型、设置分配策略
- **`Trae 配置`** 标签页 —— Trae 侧配置：区域开关、刷新账号与 Token、模型勾选与测试
- **`账号` / `积分` / `使用记录`** —— 查看页（`账号` 左右两列分列 WorkBuddy 与 Trae，见第六节）

> 合并前 `XD Pool` 是设置面板里的独立页、`Trae` 是「设置 → 插件」里的卡片；
> 现在两者都并进了 `WOTR 管理`，设置里不再有单独的池页面与 Trae 卡片。

**回滚**：把 `~/.dsh/wotr-merge-backup/<时间戳>/` 里的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 拷回 profile，恢复 `node_modules-*` 两个旧包目录，再 `pnpm install`。

> 只想要补丁、想自己打到新版插件上：见 `patches/README.md`。
> 注意：控制台移除与管理页新增都是**文件级改动**，不能用 patch 表达，需要直接替换/同步 `lib/` 下的文件。

> **改界面**：改 `dsh-wotr-console/lib/console.mjs`（唯一事实来源），然后运行
> `node dsh-wotr-console/scripts/gen-console-inline.mjs` 把源码内联进 `lib/client.js`。
> 忘了跑这步界面上不会有任何变化，也不报错 —— `apply-wotr.sh` 会拦下来。

---

## 四、验证方法（怎么确认真的好了）

```sh
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"

# 1) 桥接层单测（44 项，含文本重复 bug 的回归）
cd tools && "$NODE" dsml-test.mjs

# 2) 合并版三套单测（14 + 21 + 31 = 66 项，部署门禁）
cd ../dsh-wotr-console
"$NODE" test/credit-store.test.mjs    # 数据层
"$NODE" test/client-apply.test.mjs    # **防 DSH 启动失败**
"$NODE" test/console-render.test.mjs  # **防设置面板白屏**

# 3) 三块内联内容是否与源码同步
"$NODE" scripts/gen-console-inline.mjs --check

# 4) 请求是否带上了工具定义（关键判定）
tail -5 ~/.dsh/.workbuddy-xdpool/upstream-request-shape.log
#    键名里应出现 tools

# 5) 直连上游抓原始 SSE（绕过 DSH，用来区分"上游问题"还是"中间层问题"）
cd ../tools && "$NODE" --import ./stub/register.mjs raw-probe.mjs

# 6) 解压并检索会话日志
"$NODE" read-session.mjs ~/.dsh/sessions/<工作区>/session-*/session.v4.jsonl.zstd

# 7) 直接读落盘的使用记录
ls -la ~/.dsh/plugin-data/dsh-workbuddy-console/

# 8) 四个 provider 是否都活着（DSH 运行中才可查）
#    前缀必须与下面**逐字一致**（都带 dsh- 前缀）。写错前缀只会得到 404，
#    与「插件没加载」的表现一样，很容易误判 —— 踩过。
curl -s "http://127.0.0.1:19387/plugins/dsh-workbuddy-xdpool/status?region=cn"     | head -c 300
curl -s "http://127.0.0.1:19387/plugins/dsh-workbuddy-xdpool/status?region=global" | head -c 300
curl -s "http://127.0.0.1:19387/plugins/dsh-connect-trae/usage?region=cn"          | head -c 300
curl -s "http://127.0.0.1:19387/plugins/dsh-connect-trae/usage?region=ai"          | head -c 300
# 管理页自己的数据接口（前缀是**合并后的包名**；sample 只收 POST，GET 返回 405 正常）
curl -s "http://127.0.0.1:19387/plugins/dsh-wotr-console/history-summary"

# 9) profile 里应只剩合并版一个包
ls ~/.dsh/profiles/desktop/node_modules/
```

**最硬的验收方式**：让模型用 `write` 工具写一个文件，然后去磁盘核对内容是否正确——不看模型自己说"已完成"。

**验收管理页**：打开 设置 → WOTR，五个 tab 应各有数据（默认停在 XD Pool；「账号」页右列首次进入才拉取）；切到「使用记录」后再看 `daily.jsonl` 是否多了一行今天的记录。

> **路由前缀有两套，别搞混**：
> - `/plugins/dsh-workbuddy-xdpool/*`、`/plugins/dsh-connect-trae/*` —— **有意沿用旧名**（都带 `dsh-` 前缀），
>   因为 vendored 的池卡片与 Trae 卡片按各自原本的 id 注册、并按该 id 解析设置作用域，改名会让卡片变只读。
> - `/plugins/dsh-wotr-console/*` —— 管理页自己的两条接口（`history-summary`、`sample`），用合并后的包名。
>
> **来源校验**：这些接口只信任回环来源 —— 不带 `Origin` 或带 `127.0.0.1`/`localhost` 都放行，
> 外域来源返回 `403 {"error":"origin-not-trusted"}`。用 curl 排查时不必特意加 `Origin` 头。


---

## 五、Trae 半边（原 dsh-connect-trae）

上游宿主代码**未做改动**——它本身就把工具循环做对了，不需要打补丁。合并时以
`lib/trae.js` **逐字节并入**，已核对零差异；上游的浏览器半边
（`vendor/trae/client.js`）**已整体移除**，Trae 配置页改由本包自写（见下）。

**它做什么**：把本机已登录的 Trae 账号接进 DSH。国内版注册为 `trae` provider，国际版注册为 `trae-global`，两边可同时使用。会自动发现本机的 `Trae CN` / `TRAE SOLO CN` / `Trae` / `TRAE SOLO` 四种安装的登录凭据，也会读 CLI 的 `~/.trae-cn/trae-jwt-token`，并按凭证自带的 `userRegion` 自动判定区域。

**为什么它不需要像 WorkBuddy 那样修**：它的实现是把上游返回的结构化 `tool_calls` 解析出来再交给 DSH 本地执行（README 里明确写了这条工具循环），而 WorkBuddy 那个插件的路径是把上游字节原样转发、且工具定义在中间层被丢掉。

**本机状态（2026-10-09 实测）**：

| 检查项 | 结果 |
|---|---|
| 上游版本 | `dsh-connect-trae@3.0.0`（MIT，作者 dingminhua） |
| 合并后位置 | `dsh-wotr-console/lib/trae.js`（与原文件 diff 为空）✓ |
| provider 注册 | `trae`、`trae-global` 都在 DSH 里 ✓ |
| 登录态 | `signed-in`，账号 `1412`，来源 `TRAE SOLO CN`（edition `solo`），区域 `cn` ✓ |
| 令牌到期 | 2026-10-17（未过期，自动续期）✓ |
| 可用额度 | 总 2900，可用 2383.77 ✓ |

**配账号**（重启后）：设置 → 插件 → **Trae 卡片** → 国内版 tab → 点「**刷新账号与 Token**」→ 选账号 → 勾选要用的模型。之后在输入框模型选择器里就能看到 `trae` 分组。

**凭据位置**：只读桌面端 `User/globalStorage/storage.json` 或 CLI 的 `trae-jwt-token`；刷新后写到 `$DSH_HOME/.trae-auth.cn.json` 与 `$DSH_HOME/.trae-auth.ai.json`，**不写进 DSH 设置**。本仓库**不含任何凭据文件**（只含插件代码）。

> 合并前的单插件归档在 `dsh-connect-trae/`，仅供回滚与版本留存；
> 恢复单插件形态用 `./tools/install-trae.sh`。

---

## 六、WOTR 管理页（五个标签页）

**设置 → WOTR** 是唯一入口：配置与查看都在这一页里，设置里不再有单独的池页面或 Trae 卡片。

| 入口 | 管什么 |
|---|---|
| `XD Pool` 标签页 | **配置**：WorkBuddy 的模型勾选、账号分配策略、积分自动化 |
| `Trae 配置` 标签页 | **配置**：Trae 的区域开关、账号与 Token、模型勾选与测试 |
| `账号` 标签页 | **查看**：左右两列 —— 左 WorkBuddy、右 Trae |
| `积分` / `使用记录` 标签页 | **查看**：额度明细与历史变化 |

> 这两个配置标签页的组件本体**没有重写**，仍是 vendored 的 `PoolCard` 与
> `TraeUsageCard`：`lib/client.js` 在转发它们的 apply 时套了一层替身 ctx，
> 把原本注册成独立入口的卡片截获下来，改由管理页作为标签页渲染。
> 上游源码一行未改，日后可继续逐字节对照升级。

### 五个 tab

| Tab | 内容 | 数据来源 |
|---|---|---|
| **XD Pool** | 账号池状态、账号启用/移出、模型勾选与上下文、分配策略、积分自动化 | vendored `/status` |
| **Trae 配置** | 区域开关、账号与 Token 刷新、模型勾选与测试、输入框读数开关 | Trae 半边 `/usage` 等 |
| **账号** | **左列 WorkBuddy**：已登录账号、正常/冷却、额度、签到与连签、令牌到期<br>**右列 Trae**：各区域账号、选中状态、可用余额、签到 | vendored `/status`（左）<br>Trae 半边 `/usage`（右） |
| **积分** | 当前总积分、每账号额度与积分包明细 | vendored `/status` |
| **使用记录** | 每日净变化 + 按账号的首次/最新对比 | 本地 `daily.jsonl` + `credit-samples.jsonl` |

> 打开本页默认停在 **XD Pool** 标签页。
>
> 「账号」页是**响应式两列**：`repeat(auto-fit, minmax(300px, 1fr))`。
> 面板够宽时左右并排，窄时自动塌成一列上下排列 —— 不会把卡片挤到没法看。
> 两列各有自己的区域切换、重新检测与签到，**互不影响**；
> 一侧接口坏掉另一侧照常显示（单测里专门覆盖了这一点）。
>
> **两列是同一套模块样式**：列头、统计小卡、账号卡、KV 明细、空态都由
> `console.mjs` 里同一组共用组件（`ColumnHead` / `StatsRow` / `AccountCard` /
> `KV` / `EmptyBox`）渲染，所以并排看不出是两套东西。先前两列各写各的，
> 结果是左列没有统计行、列头按钮个数也不同。单测里直接比对两列的
> **元素骨架与 class 集合**来守住这一点（只看文本抓不到 —— 各写各的也能对上文案）。
>
> 右列（Trae）**首次切入「账号」页时才拉取**（用 `useRef` 记住"已拉过"），
> 因为 `/usage` 的 credits 是一次实时计费读，进页就无脑拉会白花配额。
> 左列（WorkBuddy）进页即拉，它便宜。


### 「登录账号」

**WorkBuddy 可以直接在浏览器里登录添加**（「账号」页左列「**添加账号**」），
也可以沿用原来的方式：在桌面版登录后在管理页点「**重新检测**」。

浏览器登录**不是** OAuth 授权码流程（没有 client_id / redirect_uri / PKCE，
不需要本地回调服务），而是「服务端发 authUrl → 浏览器登录 → 拿 state 轮询换 token」。
详见 `dsh-wotr-console/README.md` 的「浏览器登录添加账号」一节，含凭据明文落盘的
风险说明与「已验证 / 未验证」清单 —— **国际版与 Trae 侧目前未做实测**。

> 插件全程不接触你的密码：登录在官方页面里完成，插件只接收登录后的令牌。

### 采集链路（2026-10-09 恢复）

控制台移除时，写 `credit-samples.jsonl` / `history.jsonl` 的模块一并删掉了，数据停在 16:47。现已由 `lib/credit-store.mjs` 恢复，并**沿用原文件格式**，所以旧数据直接续上。

采集时机：**打开管理页时**（不做后台轮询）。这样既不产生无谓的网络请求，也避免后台常驻任务。

新增 `daily.jsonl` 记录每个账号每天的首末值 —— 因为 `credit-samples.jsonl` 按 `(day, uid)` 去重后只剩最后一条，当天最初值丢失，净变化会恒算成 0。两个文件分工：samples 看「最新快照」，daily 看「趋势」。

### 数据结构

```
~/.dsh/plugin-data/dsh-workbuddy-console/
├── credit-samples.jsonl   { ts, day, uid, nickname, credit }         （最近 120 天）
├── history.jsonl          { ts, day, uid, nickname, credit,
│                            checkedIn, streakDays, source }          （最近 400 天）
└── daily.jsonl            { day, uid, nickname,
                             first, firstTs, last, lastTs, n }        （最近 400 天）
```

> 目录名**有意保留旧插件的名字**（`dsh-workbuddy-console`，不是合并后的包名）：
> 合并前采集的历史就在这个路径下，改名会让过去的记录凭空消失。

### 实现要点

- **DSH 原生组件**，不是独立页面：没有 `web/` 目录、不开 `/wb-console`
- 组件源码是 `lib/console.mjs`（普通 ES 模块，便于阅读测试），由
  `scripts/gen-console-inline.mjs` 内联进 `lib/client.js`（后者是 classic script，不能有顶层 `import`）
  → **改界面请改 `console.mjs`，然后重跑生成脚本**；`apply-wotr.sh` 会校验两者是否同步
- `lib/client.js` 是**两块生成内容的容器**：管理页（`console.mjs`）与
  账号池客户端（`vendor/xdpool/lib/client.js`）。后者以
  `window.__ModuleLoader__.load({id, factory})` 原样内联，用一次性替身加载器
  捕获其 factory 产物 —— 上游代码一行都不用改（Trae 浏览器半边已移除，
  不再有第三块内联）
- 内联产物是**真函数**（`const __WBC_CONSOLE_FACTORY__ = (react, jsxRuntime) => {...}`），
  不是 `new Function(源码字符串)` —— 后者可能被渲染进程的 CSP 拒掉，且语法错误只在运行期暴露
- 两条接口按需自注入 `webServer`（与 vendored 账号池路由同样做法），
  宿主没提供时管理页降级为「暂无记录」，provider 功能不受影响：
  - `GET  /plugins/dsh-workbuddy-console/history-summary`
  - `POST /plugins/dsh-workbuddy-console/sample`
- 两条接口都做**回环来源校验**（拒绝非 `127.0.0.1`/`localhost` 的 Origin）
- **`apply` 整体被 try/catch 兜住**：一个纯 UI 页面的问题绝不能让整个应用起不来
  （cordis 的 fiber 一旦 apply 抛出就变 `failed`，宿主会弹「应用无法启动」）

### 测试（五层，都是 `apply-wotr.sh` 的硬性门禁，共 257 项）

```sh
cd dsh-workbuddy-mode/dsh-wotr-console
node test/credit-store.test.mjs     # 14 项：积分/历史记录的读写、去重、坏行容错
node test/client-apply.test.mjs     # 31 项：仿浏览器执行 client.js，真正调用 apply
node test/console-render.test.mjs   # 83 项：真正渲染五个 tab（含账号页两列与活句柄），空数据/坏数据/边界值
node test/wb-auth.test.mjs          # 64 项：WorkBuddy 登录（state 轮询）、凭据落盘
node test/trae-auth.test.mjs        # 65 项：Trae 登录（PKCE+回环回调，自动回调）、凭据落盘
```

后两层是**必须有**的，各对应一次真实事故，合并后又各抓到一次新问题：

**① `client-apply` —— 防「应用无法启动」**
2026-10-09 出过一次 **DSH 启动失败**（弹窗「应用无法启动或已意外停止 /
web boot: 1 entry did not activate」）。根因是 `lib/client.js` 的包装模块里
用了未声明的 `react`（它只在 vendored 内部存在），`apply` 抛 `ReferenceError`
→ cordis fiber 变 `failed` → 宿主拒绝启动。
当时只测了「内联工厂能求值」，没有驱动 `apply`，所以完全没抓到。

卡片并入管理页后，这一层还负责守一条**跨模块**契约：截获到的 vendored 组件
必须真的**渲染进**管理页，且拿到 `settingsScope` 与 `view: 'page'`。
否则两个配置标签页就是空白 —— 注册项全部正确、不报任何错。
用「把 `pickCard` 改成恒返回 null」反向验证过：5 条断言会失败。

**② `console-render` —— 防设置面板白屏**
更早一批改动里组件用 `status?.accounts ?? []` 取数组。`??` 只挡 null/undefined，
接口若返回字符串或对象就漏过去，随后 `.map`/`.reduce` 在**渲染期**抛错 ——
启动阶段一切正常，只有真的调用组件才暴露。现已统一用 `asArray()` 收口。

合并过程中这一层抓到一个**新的真实缺陷**：`console.mjs` 里
`useEffect` 的依赖数组 `[tab, loadTrae]` 写在 `const loadTrae = useCallback(...)`
**之前**，同一函数作用域内触发 TDZ，抛
`Cannot access 'loadTrae' before initialization` —— 渲染期抛错，正是白屏。
把该 effect 移到 `loadTrae` 定义之后即修复。当时 30 个渲染用例全灭。

卡片并入时这一层扩到 73 项，覆盖嵌入组件的多种坏形状（`embedded` 整体缺失、
单项为 `null`、`Component` 不是函数）都**不许抛** —— 上游改坏或某一半加载失败时，
后果只应是这一个标签页显示降级说明，而不是整个设置面板白屏。
另有一条断言守住 `settingsScope` / `t` 的**原样透传**：
丢掉它两张卡片会静默退化成只读（改完点保存、值弹回原样）。
「账号」页合成两列后又加了三条：**列的顺序与归属**（直接查元素树，
两列若塌成上下两块文本一模一样，只看文本抓不到）、**两列互不连坐**
（一侧数据坏掉时另一侧照常渲染），以及**两列同一套模块样式** ——
把每列展开成「标签 + className」序列，断言两侧用到的模块 class 集合一致、
列头骨架逐项对应。三条都用反向验证确认过会失败
（删掉一侧统计行 → class 集合不等；删掉一侧列头按钮 → 列头骨架不等）。

这一层还抓到过一个**关于同步性的真实缺陷**：`ctx.slots.inject(key, cb)`
**不是同步调用 cb 的** —— 它订阅槽位的 declaration epoch，声明到了才跑。
而 `captureCards()` 原先在 `apply` 返回时就把捕获结果当**快照**读出并交给管理页，
那通常一张卡片都还没有，于是两个配置标签页永远显示「配置组件未能载入」
（WOTR 页本身、标签栏、其余三页全部正常，也不报错）。
改成**活句柄**（`get()` + `subscribe()`，管理页在渲染期取值）后修复；
`console-render` 的「晚到」用例守住它 —— 把 `useSlot` 退回快照式实现，
该用例会以「订阅者 0 个」失败。

> 两层都可以反向验证：
> `WBC_CLIENT_PATH=/tmp/x.js node test/client-apply.test.mjs` 可测任意 client.js 副本；
> 故意注回 bug 时，前者以「管理页已注册 settings.section — got 0」失败，
> 后者以「组件渲染抛错」失败。

---

## 七、合并前后的形态对比

| | `dsh-wotr-console`（合并版） | 合并前的两个插件 |
|---|---|---|
| 包数量 | **1 个** | 2 个 |
| Loader entry | 2 个（指向不同模块，两套独立 Config） | 各 1 个 |
| 独立 Web 控制台 | ❌ 无 | ❌ 无 |
| 管理页 | ✅ `WOTR 管理`，五标签页（含两边**配置**，「账号」页左右两列） | WorkBuddy 三标签页；Trae 无 |
| 配置入口 | **并入** `WOTR 管理` 的 `XD Pool` / `Trae 配置` 标签页 | `XD Pool` 独立页 + `Trae` 卡片 |
| provider | `workbuddy-xdpool`、`workbuddy-xdpool-global`、`trae`、`trae-global` | 各占一半 |
| 注册的 HTTP 路由 | 前缀沿用 `/plugins/dsh-workbuddy-xdpool` 与 `/plugins/dsh-connect-trae` | 同名 |
| 是否被修改 | WorkBuddy 侧已打补丁；Trae 侧一字未改 | 同 |

---

## 八、已知局限

- 改动落在 `node_modules` 里（当前是 `link:` 指向本仓库），**插件升级会被覆盖**。
- 依赖各客户端的**私有接口**（WorkBuddy 走 `v2/chat/completions`，Trae 走 `llm_utils_chat`）。官方改协议都可能失效；WorkBuddy 的桥接层失效时会退化成"原样透传"，不会比不装更糟。
- 建议把「工具定义被 pi-ai 归一化丢弃」和「5.6+ 凭证未解密」这两个问题反馈给 WorkBuddy 插件作者，这是长期修法。
- **使用记录只在打开管理页时采集**（不打开就不会有点）。这是刻意不做后台轮询：避免常驻任务。查看类 tab 里只有它依赖落盘数据，其余都是实时读取。
- 每日净变化的语义是「当天最后观测 − 当天最初观测」。若当天只在**消耗之后**才打开过页面，最初值就是消耗后的值，那天的净变化会显示为 0 而不是负数。想更准就要提高采集频率。
- 合并版**未发布到 npm**，profile 里用 `link:` 指向本仓库；换机器要带上这个目录，或先发布再改用版本号。
- 两个 entry 的 id（`llm-workbuddy-xdpool`、`dsh-connect-trae`）**不能改名**：前者是 vendored 池卡片精确匹配设置命名空间的键，后者匹配 Trae 半边的 `/trae/i` 探测并保留已存设置。改名会让对应卡片变只读。



