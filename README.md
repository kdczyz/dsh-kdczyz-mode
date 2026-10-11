# dsh-kdczyz-mode

把 **WorkBuddy** 与 **Trae** 两个桌面 App 的模型接进 DeepSeek Harness。
**两边已合并为一个插件**：`dsh-wotr-console`。

| 插件 | 状态 | 作用 |
|---|---|---|
| **`dsh-wotr-console@1.1.0`** | **合并版 · 已部署** | WorkBuddy 模型池 + Trae 接入 + Qoder 号池，三个独立 provider 家族，共用一张三标签页管理页（三个配置页，各带「刷新账号 / 添加账号」） |
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
> - DSH 原生管理页（设置面板内）**为三标签页**：workbuddy / trae / qoder —— 三边的**配置**并了进来；每页页头都带「刷新账号」与「添加账号」，账号管理就近落在各自的配置页里。设置里不再有独立的池页面、Trae 卡片或单独的账号页。
> - 仓库根新增 `package.json`（**安装壳**）：让 DSH 插件管理页能直接从这个 GitHub 地址安装。
>   详见下面「零、安装」。

---

## 零、安装

**前置：机器上要有 `git`。** 插件管理页装的是 `github:` 规格，pnpm 解析时会先跑
`git ls-remote` 问远端 ref —— 没有 git 就会得到这个错，而且**失败的痕迹会留在 profile 里**
（依赖已经写进去了、但没装成），于是每次启动 DSH 都再报一次：

```text
pnpm: Command failed with ENOENT: git ls-remote 'https://github.com/kdczyz/dsh-kdczyz-mode.git' HEAD 'HEAD^{}'
spawn git ENOENT
```

Windows 一条命令装上（macOS 用 `brew install git`，Linux 用发行版自带的包管理器）：

```powershell
winget install --id Git.Git -e --source winget
```

装完**完全退出 DSH 再重新打开** —— DSH 进程要能看到 git；从桌面/开始菜单启动的 DSH
继承的是登录时的 PATH，所以必要时重启一次系统。

### 方式一：DSH 插件管理页（推荐）

设置 → 插件 → 安装，填 `github:kdczyz/dsh-kdczyz-mode`（或
`https://github.com/kdczyz/dsh-kdczyz-mode`），装完**重启 DSH**。

装之前先看一眼旧包：合并前的 `dsh-workbuddy-console`、`dsh-connect-trae`
（以及单独的 Qoder 插件）如果还在，先在管理页卸掉 —— 同一批 Loader entry id
装两份会被加载两次。

**两个坑，以前各踩过一次：**

1. **`git` 必须能被 DSH 看到**（见上面的前置）。装完没重启 DSH，报的还是老错。
2. **peer 版本必须选得中宿主的版本。** pnpm 默认 `auto-install-peers=true`，会按
   `peerDependencies` 从公共 npm **另装一份**宿主内包。原先的范围是
   `>=0.1.7-rc.1 <0.3.0-0`，按 semver 规则**排除所有预发布版**，于是它装了
   `@deepseek-ai/dsh-llm@0.1.7-rc.2` / `@earendil-works/pi-ai@0.85.1`，
   而宿主自己用的是 `0.2.0-rc.2` / `0.87.1` —— 那份副本在解析链上**比宿主更近**，
   会直接遮住宿主那份，表现是「管理页能看到账号，但模型选择器里一个 provider 都没有」。
   现在范围写成两条版本线的并集（`^0.1.7-rc.1 || ^0.2.0-rc.1`，已用真 semver 核对）；
   而且 DSH 给 profile 写的 `pnpm-workspace.yaml` 里本来就带 `autoInstallPeers: false`，
   正常不会真去另装 peer。

**为什么以前连装都装不上**：插件管理页 `pnpm add <git 地址>` 装的是**仓库根**，
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
| `exports["./qoder"]` | `./dsh-wotr-console/lib/qoder.js` | Qoder 半边入口（第三个 Loader entry） |
| `exports["./client"]` | `./dsh-wotr-console/lib/client.js` | 浏览器端 bundle（三标签页） |
| `dsh.bundle.patch` | `./dsh-wotr-console/cordis.patch.yml` | **组合包声明**，管理页据此识别 |
| `dsh.client` | `platform: web` + inject 列表 | 客户端注入目标 |

壳只在包根做转发，插件代码仍在 `dsh-wotr-console/` 下，三个 Loader entry 的名字
（`dsh-wotr-console`、`dsh-wotr-console/trae`、`dsh-wotr-console/qoder`）与 profile
里已保存的配置**完全不变**。

### 方式二：本地开发部署（link:）

```bash
./tools/apply-wotr.sh            # 部署到 desktop profile
./tools/apply-wotr.sh --dry-run  # 只看计划
```

这条路径把 `dsh-wotr-console/` 直接同步进 `~/.dsh/profiles/desktop/node_modules/dsh-wotr-console`，
并在 profile 的 `dependencies`（`link:`）与 `dsh.profile.bundles` 里登记。
改代码即时生效（要重启 DSH）。它是 macOS 专用的（用了 `rsync` 与 `.app` 内的绝对路径），
新设备请用方式一。

> 两种方式的包名都是 `dsh-wotr-console`，但**同时只能走一条**：管理页装了 git 版本后，
> 本地 `link:` 会被替换掉，反之亦然。

**宿主内包不用你管。** 三个入口在模块顶层 import 的 `@earendil-works/pi-ai`、
`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/schemastery` 等包只存在于 DSH 安装目录里，
DSH 会在**内存里**把它们路由给每个 profile：`@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`
（*In-memory profile package routing for Node's default ESM and CommonJS loaders*）
把 installation scope 的包与 profile 自己装的包合成一张解析表，Node 自身解析不到时兜底。
所以管理页装完即可用，**不需要往 profile 里复制或软链任何宿主包**。
（本仓库 2026-10-11 之前为此写过一套「装配宿主包 + 免 git 安装」的工具，确认多余后已删除；
`tools/link-host-deps.mjs` 留着给上面这条本机开发部署用 —— 它让脱离 DSH 的裸 Node
也能解析到宿主内包，本仓库的自检与单测依赖这一点。）

**不装 git、只想把插件文件拿到手**：`backup/` 里有一份**整体快照**
（`dsh-wotr-console-1.1.0-20261011.tar.gz`，1.1 MB，插件本体 + 安装壳 + 全部说明），
raw 直链可直接下载，见 [backup/README.md](backup/README.md)。
它是应急/留档用的死文件，不是第二条维护中的安装路 —— 正常仍走方式一。

---

## 一、目录结构

```
dsh-kdczyz-mode/
├── README.md                      ← 本文件
├── dsh-wotr-console/              ← **合并版插件（当前部署的就是它）**
│   ├── lib/index.js                 WorkBuddy 半边：provider 注册 + 管理页接口 + 热重载兜底
│   ├── lib/trae.js                  Trae 半边（上游宿主 lib/index.js 并入；浏览器半边已移除）
│   ├── lib/wb-auth.mjs              WorkBuddy 登录协议（客户端 OAuth 轮询换 token）
│   ├── lib/trae-auth.mjs            Trae 登录协议（ExchangeToken + 设备绑定）
│   ├── lib/client.js                浏览器端唯一 bundle（三块内联 + settings 作用域解析）
│   ├── lib/console.mjs              三标签页管理页源码（唯一事实来源）
│   ├── lib/credit-store.mjs         积分与历史记录的落盘存储
│   ├── cordis.patch.yml             三个 Loader entry（勿改 id，见文件内注释）
│   ├── scripts/gen-console-inline.mjs 把 console.mjs 内联进 client.js（支持 --check）
│   ├── scripts/gen-xdpool-client.mjs  把 vendor/xdpool/lib/client.js 内联进 client.js
│   ├── test/credit-store.test.mjs   数据层单测（14 项）
│   ├── test/client-apply.test.mjs   仿浏览器调用 apply 的单测（34 项，防启动失败）
│   ├── test/console-render.test.mjs 真正渲染三个 tab（三个配置页 + 活句柄 + 胶囊卡片）的单测（防白屏）
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
├── backup/                        ← **整体快照**：一个压缩包把插件全部文件整合在一起
│   ├── dsh-wotr-console-1.1.0-20261011.tar.gz  插件本体 + 安装壳 + README（解包即用，含 sha256）
│   └── README.md                    快照说明：raw 直链下载、怎么校验、里面没有什么
├── tools/                         ← 部署与验证工具
│   ├── apply-wotr.sh                 **合并版：一键部署（含门禁 + 备份 + 清旧包）**
│   ├── apply.sh                     合并前的 WorkBuddy 单插件部署脚本
│   ├── install-trae.sh              合并前的 Trae 安装/恢复脚本
│   ├── link-host-deps.mjs           把宿主内包挂进 profile（**只给本机开发部署用**；
│   │                                新设备安装不需要它 —— DSH 自己会路由，见「零、安装」）
│   ├── lib/                         host-deps.mjs（装配宿主包）+ asar.mjs（纯 JS 读 app.asar）
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
cd dsh-kdczyz-mode            # 改成你实际克隆下来的目录
./tools/apply-wotr.sh --dry-run    # 先看计划（不改 profile）
./tools/apply-wotr.sh              # 真正部署
```

合并版是一次**替换**（不是原地更新），脚本依次做：

1. **源码门禁** —— 校验 `client.js` 内联块与 `console.mjs` 同步；在仓库内的插件目录挂一层宿主内包软链（裸 Node 跑单测用，见「零、安装」）；再跑 **24 套单测 + host-assembly**（`npm test` 一条链跑完 25 套）；任一失败即停，不把坏版本推上去（失败会复跑一次并把失败的断言打出来）。
2. **备份** profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 与两个旧包到 `~/.dsh/wotr-merge-backup/<时间戳>/`。
3. `rsync --delete` 同步 `dsh-wotr-console/`。
4. 改 profile `package.json`：依赖换成 `link:` 指向本仓库，`bundles` 里两个旧包换成新包。
5. 改 profile `cordis.patch.yml`：旧包名替换为 `dsh-wotr-console`，移除独立的 `dsh-connect-trae` 条目（entry id 保持不变）。
6. **移除三个旧包目录**（`dsh-workbuddy-console`、`dsh-connect-trae`、`dsh-workbuddy-xdpool`）—— 必须删，否则与新包争用同一批 entry id 会导致加载两次。
7. 校验目标文件语法与 `exports["./qoder"]` 白名单。
8. 把宿主内包装配进 profile，再跑 `host-assembly` 自检（三个入口在该 profile 下**真的能加载**）。

脚本**不跑 `pnpm install`**：它会重算 lockfile 并清掉旧包，所以要手动补一步（否则下次 DSH 启动的 install 可能把旧包拉回来）：

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
cd ~/.dsh/profiles/desktop && "$NODE" "$PNPM" install     # 应显示 Packages: -3
```

**部署后必须重启 DSH**（退出后重新打开）：这些是 ES module，热重载不会重新加载代码。

**配置方式**：重启后 → **设置 → WOTR**（一个入口，三个标签页）：

- **`workbuddy`** 标签页 —— WorkBuddy 侧配置：管理账号池、勾选模型、设置分配策略
- **`trae`** 标签页 —— Trae 侧配置：区域开关、刷新账号与 Token、模型勾选与测试
- **`qoder`** 标签页 —— Qoder 侧配置：设备码登录、号池与每日签到、模型勾选
- 每页页头都有「**刷新账号**」（重扫本机账号）与「**添加账号**」（浏览器登录入池）

> 合并前 `workbuddy` 是设置面板里的独立页、`Trae` 是「设置 → 插件」里的卡片；
> 现在三者都并进了 `WOTR 管理`，设置里不再有单独的池页面、Trae 卡片或 Qoder 页面。

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

# 2) 全部单测 = 部署门禁（24 套 + 装配后的 host-assembly = 25 套，见「三、部署」）
cd .. && ./tools/apply-wotr.sh --dry-run      # 一次跑完所有套件
cd dsh-wotr-console                            # 或单独复跑某几套：
"$NODE" test/credit-store.test.mjs    # 数据层
"$NODE" test/client-apply.test.mjs    # **防 DSH 启动失败**
"$NODE" test/console-render.test.mjs  # **防设置面板白屏**
# 注意：直接 import lib/trae.js、lib/qoder.js 的套件需要仓库内的宿主内包软链，
# 缺了就先跑一次 ./tools/apply-wotr.sh（它会自动补，见「零、安装」）

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

**验收管理页**：打开 设置 → WOTR，三个 tab（workbuddy / trae / qoder）应各有数据（默认停在 workbuddy）。每页页头都有「刷新账号」与「添加账号」两个按钮。

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

## 六、WOTR 管理页（三个标签页）

**设置 → WOTR** 是唯一入口：配置与查看都在这一页里，设置里不再有单独的池页面或 Trae 卡片。

| 入口 | 管什么 |
|---|---|
| `workbuddy` 标签页 | **配置**：WorkBuddy 的模型勾选、账号分配策略、积分自动化 |
| `trae` 标签页 | **配置**：Trae 的区域开关、账号与 Token、模型勾选与测试 |
| `qoder` 标签页 | **配置**：Qoder 的设备码登录、号池、每日签到与额度刷新、模型勾选 |

> 三个标签页的组件本体都是**本包自写**（`PoolConfigTab` / `TraeConfigTab` /
> `QoderPoolPanel`），对齐同一套模块样式；vendored 的 `PoolCard` 仍被内联执行，
> 但只用于提供类型与不参与渲染。每页页头都带「刷新账号」与「添加账号」。

### 三个 tab

| Tab | 内容 | 数据来源 |
|---|---|---|
| **workbuddy** | 账号池状态、账号启用/移出、模型勾选与上下文、分配策略、积分自动化 | vendored `/status` |
| **trae** | 区域开关、账号与 Token 刷新、模型勾选与测试、输入框读数开关 | Trae 半边 `/usage` 等 |
| **qoder** | 设备码登录、号池、每日签到与额度刷新、模型勾选 | Qoder 半边 `/qoder/pool` 等 |

> 「账号」（三列汇总）与「积分」（积分包明细）两个只读标签页已删除：它们的内容
> 与三个配置页重复，却各自维护一份取数与刷新节奏 —— 同一份 `/usage` 被拉两次、
> 两处显示的余额还可能不一致。现在每个平台的账号与余额只在**它自己的配置页**
> 和 composer 那颗胶囊的卡片里出现（见下一节）。

> 打开本页默认停在 **workbuddy** 标签页。
>
> 每页都是**单列自上而下**：页头 → 状态说明 → 统计小卡 → 「账号」区 → 「模型」区。
> 页头按钮固定为「刷新账号」（重扫本机账号）与「添加账号」（浏览器登录入池）。
>
> 三页共用同一套模块样式：列头、统计小卡、账号卡、KV 明细、空态都由
> `console.mjs` 里同一组共用组件（`ColumnHead` / `StatsRow` / `AccountCard` /
> `KV` / `EmptyBox`）渲染。单测里直接比对各页的**元素骨架与 class 集合**
> 来守住这一点（只看文本抓不到 —— 各写各的也能对上文案）。
>
> 签到的粒度是**按账号**（每张卡签自己那个账号、不切换正在服务的账号）：
> WorkBuddy 上游自己认 `accountId`；Trae 靠「拿那个账号的凭据走同一条流程」；
> Qoder 走活动线 `me/campaigns → claim`（见 `dsh-wotr-console/README.md`
> 的「每日签到（活动线）」一节，含 `Cosy-ClientType` 必须是 `10` 这个静默坑）。

### composer 的积分胶囊：点一下看**这个平台**的全部账号

输入框下面那颗「积分 1,104 · 1412」胶囊是**按钮**：点开是一张卡片，
列出**当前模型所属那一个反代平台**的账号 —— 不是「所有平台的账号」：

| 平台 | 卡片里列什么 | 胶囊数字是谁的 |
|---|---|---|
| WorkBuddy | **国内版 + 国际版**两个区域，各一行组标题（`国内版 2 个 · 本轮用 1412`） | 当前 provider 那个区域里**正在服务**的账号（`activeAccountId`） |
| Trae | **国内版（cn）+ 国际版（ai）**两个区域 | 当前区域里 `lastServedId` 那个账号，没有就退回「当前账号」 |
| Qoder | 单个号池（没有区域概念，所以不画组标题） | `serving.accountId`，没有就用当前账号 |

每一行有**两个控件**（用户明确要的两件不同的事）：

- **「参与轮换」开关** —— 把这个账号移出/放回轮换。WorkBuddy 走
  `POST /plugins/dsh-workbuddy-xdpool/accounts/disabled`（服务端对当前值做合并）；
  Trae / Qoder 是设置里那份 `disabledAccountIds`（**读-改-写合并**，不整段覆盖）。
- **「切换到此账号」按钮** —— 让**下一次请求**优先用它。WorkBuddy 走
  `POST …/accounts/select?region=cn|global`；Trae 打 `/pool/account?region=` 并且
  **必须同时写 `accounts` 设置**（那个路由只改内存里的活池，重启就回去了）。
- 已经是「当前账号」的那一行：WorkBuddy 把按钮换成「**取消固定**」（它的池把
  「没有当前账号」当正常状态，取消即交回轮换）；Trae / Qoder **不给按钮** ——
  这两家的池永远有一个当前账号，「切换到这个已经是当前的账号」是纯 no-op。

几个刻意的取舍（都写进了 `console.mjs` 的注释与单测）：

| 取舍 | 为什么 |
|---|---|
| **只在这几个时刻取数**：打开卡片、手动「刷新」、写完一次启停/切换之后 | 上游按账号计费的读（Trae 的 `/usage` 是一次实时计费调用）。**卡片开着也不轮询** —— 单测里钉着「展开卡片不新增任何定时器」 |
| 胶囊自己 30 秒一刷，卡片打开时顺手带一次新的 | 胶囊那颗数字是「我现在能用多少」，长期停在旧值会误导；但**只刷胶囊**，不刷整张卡片 |
| Trae 行显示 `available/generalAvailable`，**不是** `total` | Trae 的 `credits.total` 是**发放总量**（3,050），`available = total - consumed` 才是剩余（796.88）。真机上曾经把发放总量当余额显示 |
| 写失败只占一行红字，不清空已显示的行 | 上游 4xx/断网时把卡片清成空态，用户会以为"账号没了" |
| `disabledAccountIds` 在 WorkBuddy 是**两个区域共用的一份扁平数组** | 配置页只看得见本区域的账号，照本区域拼一份完整名单写回设置，会把**另一个区域**已停用的账号静默重新启用。所以这个开关只能走上面的路由，由服务端合并 |

卡片本体是 `createPortal(…, document.body)` + `position: fixed`（拿不到 `react-dom`
时退回行内渲染）：composer 外面在嵌入形态下有 `overflow: hidden` 的容器
（`.ST7X_W_embeddedBody`），行内浮层会被裁掉；内置的 `ContextMeter` 用的也是
「fixed + 端口到 body + `z-index: 1100`」这条路。


### 「登录账号」

**WorkBuddy 可以直接在浏览器里登录添加**（workbuddy 页页头「**添加账号**」），
也可以沿用原来的方式：在桌面版登录后在管理页点「**刷新账号**」。

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

### 测试（都是 `apply-wotr.sh` 的硬性门禁）

```sh
cd dsh-kdczyz-mode/dsh-wotr-console
node test/credit-store.test.mjs     # 14 项：积分/历史记录的读写、去重、坏行容错
node test/client-apply.test.mjs     # 仿浏览器执行 client.js，真正调用 apply
node test/console-render.test.mjs   # 444 项：真正渲染三个 tab 与 composer 胶囊卡片，空数据/坏数据/边界值
node test/wb-auth.test.mjs          # WorkBuddy 登录（state 轮询）、凭据落盘
node test/trae-auth.test.mjs        # Trae 登录（PKCE+回环回调，自动回调）、凭据落盘
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
「账号」页合成三列后又加了五条：**列的顺序与归属**（直接查元素树，
三列若塌成上下三块文本一模一样，只看文本抓不到）、**三列互不连坐**
（一侧数据坏掉时另外两侧照常渲染），以及**三列同一套模块样式** ——
把每列展开成「标签 + className」序列，断言三列用到的模块 class 集合一致、
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
| Loader entry | 3 个（指向不同模块，三套独立 Config） | 各 1 个 |
| 独立 Web 控制台 | ❌ 无 | ❌ 无 |
| 管理页 | ✅ `WOTR 管理`，三标签页（三边**配置**各自带「刷新账号 / 添加账号」） | WorkBuddy 三标签页；Trae 无 |
| 配置入口 | **并入** `WOTR 管理` 的 `workbuddy` / `trae` 标签页 | `XD Pool` 独立页 + `Trae` 卡片 |
| provider | `workbuddy-xdpool`、`workbuddy-xdpool-global`、`trae`、`trae-global` | 各占一半 |
| 注册的 HTTP 路由 | 前缀沿用 `/plugins/dsh-workbuddy-xdpool` 与 `/plugins/dsh-connect-trae` | 同名 |
| 是否被修改 | WorkBuddy 侧已打补丁；Trae 侧一字未改 | 同 |

---

## 八、已知局限

- 改动落在 `node_modules` 里（当前是 `link:` 指向本仓库），**插件升级会被覆盖**。
- 依赖各客户端的**私有接口**（WorkBuddy 走 `v2/chat/completions`，Trae 走 `llm_utils_chat`）。官方改协议都可能失效；WorkBuddy 的桥接层失效时会退化成"原样透传"，不会比不装更糟。
- 建议把「工具定义被 pi-ai 归一化丢弃」和「5.6+ 凭证未解密」这两个问题反馈给 WorkBuddy 插件作者，这是长期修法。
- **「积分」与「使用记录」两个 tab 已移除**（2026-10-12）：采集接口 `/sample` 与 `/history-summary` 仍在服务端保留，但管理页不再读取，`daily.jsonl` 因此不再增长。
- 每日净变化的语义是「当天最后观测 − 当天最初观测」。若当天只在**消耗之后**才打开过页面，最初值就是消耗后的值，那天的净变化会显示为 0 而不是负数。想更准就要提高采集频率。
- 合并版**未发布到 npm**，profile 里用 `link:` 指向本仓库；换机器要带上这个目录，或先发布再改用版本号。
- 两个 entry 的 id（`llm-workbuddy-xdpool`、`dsh-connect-trae`）**不能改名**：前者是 vendored 池卡片精确匹配设置命名空间的键，后者匹配 Trae 半边的 `/trae/i` 探测并保留已存设置。改名会让对应卡片变只读。



