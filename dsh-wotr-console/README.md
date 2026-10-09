# dsh-wotr-console

把 **WorkBuddy** 与 **Trae** 两个桌面 App 的模型接进 DeepSeek Harness，
**合并为一个插件**。两个 App 各是一个独立的 provider 家族，
设置里共用一张五标签页管理页 —— 配置与查看都在这一页里，「账号」页左右两列分列 WorkBuddy 与 Trae。

> 「WOTR」= **W**orkBuddy + T**rae**（WorkBuddy-O-Tr-Ae 的缩写读法）。

## 提供的 provider

| provider | 来源 | 说明 |
|---|---|---|
| `workbuddy-xdpool` | WorkBuddy 国内版 | 本机已登录账号构成自动容错的模型池 |
| `workbuddy-xdpool-global` | WorkBuddy 国际版 | 同上，两边账号互相独立 |
| `trae` | Trae 国内版 | 跟随 Trae 桌面端 / CLI 的登录态 |
| `trae-global` | Trae 国际版（Trae / TRAE SOLO） | 同上，按凭据自带的 `userRegion` 判定区域 |

四个 provider 可以同时使用；某一侧的改动不影响另一侧。

## 设置里的一个入口

| 入口 | 管什么 |
|---|---|
| **WOTR 管理** 管理页 | 五标签页：两个**配置**（XD Pool / Trae 配置）+ 三个**查看**（账号 / 积分 / 使用记录） |

管理页的五个 tab：

| Tab | 内容 |
|---|---|
| XD Pool | WorkBuddy 池配置：模型勾选、账号分配策略、积分自动化 |
| Trae 配置 | Trae 配置：供应商开关、账号绑定、模型勾选与测试、**号池管理**（分配策略 / 冷却 / 停用 / 保留积分） |
| 账号 | **两列，同一套模块样式**：左 WorkBuddy、右 Trae。每列都是「列头（标题+区域切换+操作）」+「4 张统计小卡」+「账号卡（名称+状态标签+KV 明细+操作按钮）」 |
| 积分 | 当前总积分、每账号额度与积分包明细 |
| 使用记录 | 每日净变化 + 按账号的首次/最新对比（本地落盘数据） |

> XD Pool 的组件本体来自 vendored 代码（`PoolCard`），由 `lib/client.js` 在转发
> apply 时**截获**它原本作为独立入口的注册，改由管理页渲染 —— 上游源码一行未改。
>
> Trae 配置 tab 是**本包自写**的（`console.mjs` 的 `TraeConfigTab`）：不再嵌入上游
> dsh-connect-trae 的浏览器卡片（`vendor/trae` 已移除），而是按本页 WorkBuddy 的
> 模块样式直接实现，读写走 `lib/trae.js` 已有的路由与 `regions` / `accounts` 设置
> 字段。它的 settings 作用域由 `client.js` 的 `resolveTraeSettings()` 解析后传入。

打开本页默认停在 **XD Pool**。

## 目录结构

```
dsh-wotr-console/
├── package.json
├── cordis.patch.yml           两个 Loader entry（见文件内注释，勿改 id）
├── lib/
│   ├── index.js               WorkBuddy 半边（provider 注册 + 管理页接口）
│   ├── trae.js                Trae 半边（上游 lib/index.js 并入；号池为新增）
│   ├── client.js              浏览器端唯一 bundle（两块内联 + 卡片截获层）
│   ├── console.mjs            五标签页管理页源码（唯一事实来源）
│   └── credit-store.mjs       积分与历史记录落盘
├── vendor/
│   └── xdpool/                WorkBuddy 模型池（MIT, XDTrees）
├── scripts/
│   ├── gen-console-inline.mjs 把 console.mjs 内联进 client.js（支持 --check）
│   └── gen-xdpool-client.mjs  把 vendor/xdpool/lib/client.js 内联进 client.js
├── test/                      单测（见下）
└── icons/                     来自 dsh-connect-trae（MIT）
```

## 一个包、两个入口

`cordis.patch.yml` 用**两个 Loader entry 指向不同模块**：

```yaml
- insert:
    - id: llm-workbuddy-xdpool
      name: dsh-wotr-console        # -> lib/index.js
    - id: dsh-connect-trae
      name: dsh-wotr-console/trae   # -> lib/trae.js
```

原因：两半各自声明 `enabledModelIds` / `contextBudgets` 等**语义不同**的同名字段，
而 cordis 按 `apply` 的函数身份给运行时和 `Config` schema 建键 ——
同一个模块会被塌成一份 schema，两边互相覆盖。两个模块才是两份独立 schema。

两个 entry 的 id 也**不能改名**：`llm-workbuddy-xdpool` 是 vendored 池卡片
查自己设置作用域用的精确键；`dsh-connect-trae` 匹配 Trae 半边的 `/trae/i` 探测，
并保留 profile 里已保存的 Trae 设置。

客户端 bundle 仍然只有**一个**：entry B 用的是子路径 specifier（含 `/`），
client-modules 不会为它建客户端条目，所以五标签页只加载一次。

## 设置入口：一个页面、五个标签页

两个 vendored 客户端原本各自把设置卡片注册成**独立入口**：

| vendored | 原本的入口 | 现在 |
|---|---|---|
| `vendor/xdpool` | `settings.section` id=`workbuddy-xdpool`（设置面板一整个页面，order 440） | 截获为 WOTR 页的 **XD Pool** 标签页 |

做法在 `lib/client.js` 的 `captureCards()`：转发 vendored `apply` 时套一层
**替身 ctx**，只把目标槽位的 `register` 拦下来，记下组件本体与它原本会收到的
props（`opts.inject()` 求值一次，`settingsScope` 是同一对象引用），
然后照常执行它们的 apply。于是：

- 上游源码**一行未改**，日后仍可逐字节对照升级；
- 个别失效的 effect 按标签丢弃（见下）。

### Trae 配置 tab：本包自写

上游 `dsh-connect-trae` 的浏览器半边（`vendor/trae/client.js`）**已整体移除**，
Trae 配置页改为本包自写（`console.mjs` 的 `TraeConfigTab`），按本页 WorkBuddy 的
模块样式实现：供应商开关、账号绑定、模型勾选与测试、号池管理。

它不需要上游的卡片组件，只需要一份 **Trae settings 作用域**，由
`client.js` 的 `resolveTraeSettings()` 解析。解析规则与上游客户端一致，**尤其
不能把命名空间写死成 `trae`**：

- 命名空间从 `configForms.describe()` 镜像里**匹配 `/trae/i` 的那个**取；
  宿主实际提供的常常带包名前缀（`dsh-connect-trae`、`include:dsh-connect-trae`…）。
  写死是上游踩过的实打实的坑 —— 绑到不存在的 ns 时每次写入都被拒
  （`No configurable plugin entry "trae"`），而控件照常亮着，表现为
  「保存了又弹回去」。
- 镜像是异步的、且可能在 profile 重载后多出命名空间，所以要**订阅镜像变化
  重新绑定**。
- 没有 `configForms` 就退回 0.1.5 那条线的 `settingsScope.bind()`；都没有则
  作用域恒为只读，页面显示诊断行而不是给出按不动的假控件。

> 移除上游浏览器半边同时移除了它的**输入框积分读数**（`conversation.input.left`）。
> 那是该上游客户端自带的功能，随它一并去掉。

### 传出去的是「活句柄」，不是快照

`captureCards()` **不能**把捕获结果当快照读出来交给管理页 ——
`ctx.slots.inject(key, cb)` 不是同步调用 cb 的：真实实现（ui-renderer 的
`SlotRegistry.inject`）订阅槽位的 declaration epoch，**声明到了才在 effect 里跑 cb**。
所以 `apply` 刚返回时通常一张卡片都还没拿到。

早先按快照传值，后果是「WOTR 页正常、五个标签页都在，但两个配置标签页显示
**配置组件未能载入**」—— 注册项全部正确，不报任何错。

现在对外暴露的是句柄：

```js
{ get(slotName) -> {Component, props, asList} | undefined,
  subscribe(fn)  -> () => void }
```

管理页在**渲染期**取值（`console.mjs` 的 `useSlot`），并在 `subscribe` 回调里
`setState`，这样卡片晚到也能补渲染出来。`useSlot` 刻意**不用**
`useSyncExternalStore`：它对 `getSnapshot` 做引用相等检查，而 `get()` 每次都会
新建对象（要合并 `extraProps`），会被判成「每次都在变」→ React 抛
"The result of getSnapshot should be cached" 或陷入无限重渲染。

> 这一层由 `console-render.test.mjs` 的「晚到」用例守住：
> 句柄先返回 `null`、随后才变成有卡片并触发 `subscribe`，
> 断言页面确实补渲染出了卡片本体。

> **必须丢弃的 effect**：`installNavIcon` 会给「XD Pool」那条设置导航行画图标，
> 方式是往 `document.body` 挂一个 `MutationObserver`（childList + subtree +
> characterData），每次 DOM 变动全页扫一遍找那条行。合并后那条行已不存在，
> 它匹配不到任何目标却仍常驻监听整个应用 DOM —— 纯粹的开销。
> 所以 `captureCards` 按标签（`settings nav icon`）把该 effect 丢掉了。

## 构建（改了源码必须跑）

`lib/client.js` 是两块生成内容的容器，改动对应源码后要重新生成：

```sh
node scripts/gen-console-inline.mjs   # 改 lib/console.mjs 后（支持 --check 校验）
node scripts/gen-xdpool-client.mjs    # 改 vendor/xdpool/lib/client.js 后
```

**忘了跑不会报错，界面上也不会有变化** —— 用 `node scripts/gen-console-inline.mjs --check` 拦。

## 测试

```sh
node test/credit-store.test.mjs     # 14 项：积分/历史记录读写、去重、坏行容错
node test/client-apply.test.mjs     # 32 项：仿浏览器执行 client.js 并真正调用 apply
node test/console-render.test.mjs   # 105 项：真正渲染五个 tab（含账号页两列、Trae 配置页与号池区），空/坏数据与边界值
node test/trae-pool.test.mjs        # 26 项：Trae 号池（scan/分配策略/冷却换号/停用/保留额度）
node test/wb-auth.test.mjs          # 64 项：WorkBuddy 浏览器登录（state 轮询）、凭据落盘
node test/trae-auth.test.mjs        # 65 项：Trae 浏览器登录（PKCE+回环回调，自动回调）、凭据落盘
```

后两层各对应一次真实事故，**不能省**：

- **`client-apply`** 防「应用无法启动」：`client.js` 的 wrapper 里曾引用未声明的
  `react`，`apply` 抛 `ReferenceError` → cordis fiber 变 `failed` →
  宿主弹「应用无法启动或已意外停止」。只测「内联工厂能求值」抓不到。
  卡片并入后它还守一条跨模块契约：截获到的组件必须真的**渲染进**管理页，
  且拿到 `settingsScope` 与 Trae 的 `view: 'page'` —— 否则两个配置标签页
  就是空白，而注册项全部正确、不报任何错。
- **`console-render`** 防「设置面板白屏」：组件曾用 `status?.accounts ?? []`
  取数组，接口返回非数组时 `.map` 在**渲染期**抛错 —— 启动阶段完全正常。
  合并后这一层还抓到过一次真实的 TDZ 缺陷：`useEffect` 的依赖数组
  在 `loadTrae` 的 `const` 定义之前就引用它，抛
  `Cannot access 'loadTrae' before initialization`，30 个渲染用例全灭。
  嵌入卡片后这一层覆盖嵌入组件的三种坏形状都不抛，并守住
  `settingsScope` / `t` 的原样透传（丢了卡片会静默退化成只读）。
  账号页合成两列后，它额外守三条：
  - **列的顺序与归属** —— 直接检查元素树里 `wbc-cols` 下有且仅有两个
    `wbc-col`、左列是 WorkBuddy、右列是 Trae，且各自的筛选按钮在自己的列里。
    只看文本断言不出布局：两列若塌成上下两块，文本一模一样
    （反向验证过：对调两列会失败）。
  - **两列互不连坐** —— 一侧数据坏掉时另一侧照常渲染。
    共用一个标签页最容易引入的回归就是一个共用的取值同时打穿两边。
  - **两列同一套模块样式** —— 把每列展开成「标签 + className」序列，
    断言两侧用到的模块 class 集合一致、且列头骨架逐项对应。
    这是「两列长得一样」唯一可靠的断言：各写各的也能让文案全部对上。
    反向验证过：删掉一侧统计行 → class 集合不等；
    删掉一侧列头按钮 → 列头骨架不等。

## Trae 号池（按 XD Pool 的做法）

WorkBuddy 侧一直是**多账号池**（`WorkBuddyAccountPool`）：本机所有登录构成池子，
被限流或额度耗尽就冷却换号。Trae 侧原本不是 —— 每区域只**绑定一个**账号
（`store.resolve()` 永远返回绑定的那个），于是「明明还登录着别的 Trae 账号，
请求却直接失败」。

现在 Trae 也有号池了（`lib/trae.js` 的 `TraeAccountPool`），行为与 WorkBuddy 对齐：

| 能力 | 说明 |
|---|---|
| 分配策略 | `priority`（先用完一个）/ `round-robin`（依次轮换）/ `balanced`（按闲置时长加权随机） |
| 自动换号 | 429 只冷却**该模型**（Trae 是按模型限流的，同账号其它模型照用）；402 冷却整个账号 |
| 账号停用 | 用户偏好，存在池上（重扫凭据不丢），与「永久移出」不同 |
| 保留积分 | 某账号余额低于下限就停止使用它，留个 cushion |
| 清除冷却 | 冷却是号池自己的记账，卡住时用户要能不重启就清掉 |

号池设置写在 `regions.<region>` 槽里（`distribution` / `disabledAccountIds` /
`creditReserves`），与 WorkBuddy 池的配置**同形**；每次写入只动目标区域的槽，
另一区域的号池设置不受影响。

### 为什么刷新 token 要按账号分文件

Trae 的凭据刷新原本写到 `.trae-auth.<region>.json`，**每区域一个文件**。多账号
轮流刷新会互相覆盖 —— 只有最后一个刷新的账号能留住新 token，其余账号继续用
（已过期的）桌面端凭据。

现在**登录与刷新都写** `.trae-auth.<region>.<accountId>.json`（账号 id 是
`edition + userId` 的哈希，文件名里不含任何 token），旧的单文件仍然读取，
作为迁移源。

> 账号 id 的算法在两个模块里各有一份（`lib/trae.js` 的 `traeAccountId` 与
> `lib/trae-auth.mjs` 的 `traeAccountIdOf`）—— 刻意重复，避免把 provider 模块
> 拉进登录模块的依赖图。代价是两处必须同步，所以 `test/trae-pool.test.mjs`
> 里有一条断言专门比对两者对同一份凭据算出的 id 是否一致。
> 这个坑真踩过：改完刷新侧却漏了保存侧，结果是「登录成功但号池里看不到账号」。

## 凭据

- **WorkBuddy**：由 vendored xdpool 读取（用 `currentApi().pool` 拿**已解密**的凭证）
- **Trae**：只读桌面端 `User/globalStorage/storage.json` 或 CLI 的
  `trae-jwt-token`，刷新后写到 `$DSH_HOME/.trae-auth.<region>.json`

两者都**不把 token 写进 DSH 设置**，本仓库**不含任何凭据文件**。

## 浏览器登录添加账号（WorkBuddy）

「账号」页左列有「**添加账号**」：点一下会在系统浏览器打开登录页，在里面完成
登录后回到管理页即可 —— 新账号会立刻出现在左列，并纳入池的轮换。

**协议不是 OAuth 授权码流程**（这点容易搞错，写死过一次）：

```
POST /v2/plugin/auth/state?platform=workbuddy   → { authUrl, state }
        ↓ 系统浏览器打开 authUrl（邮箱/微信/Google 等都在那个页面里）
GET  /v2/plugin/auth/token?state=<state>        → { accessToken, refreshToken… }
GET  /v2/plugin/accounts                        → 账号身份（uin/uid/nickname）
```

没有 `client_id`、没有 `redirect_uri`、没有 PKCE、不需要本地回调服务。
实现见 `lib/wb-auth.mjs`，路由挂在 `lib/index.js`。

**凭据落盘**：写成 `dsh-wotr-<账号id>.info`，放进**池本来就在扫描的目录**
（`defaultDesktopAuthDirs()`，不可写时退回插件数据目录），权限 `0600`。
池按 `*.info` 逐个解析，账号 id 由 `uin/uid` 派生，所以**多账号天然成立**：
登录几个账号就有几个文件，互不覆盖；重复登录同一账号只会覆盖自己那份。

> ⚠ **明文 token**：客户端 5.6+ 把自己的 token 存成 `$wbEncrypted` 信封，
> 但池的 `decryptableString()` **也接受明文**，而插件拿不到那把 at-rest key，
> 所以这里写的是**明文**。这是刻意选择（已用 0600 + 独立文件名降低暴露面），
> 代价是本机会多一份明文凭据。

**已验证 / 未验证**（别把未验证当能用）：

- ✅ 已验证：用池**真正的** `parseWorkBuddyAuth` 读插件写出的凭据文件，
  能完整读出 accessToken / refreshToken / 有效期 / uin / uid，且多账号 id 不撞号
  （`test/wb-auth.test.mjs` 从 vendored 源码扣出真函数来验证，不是模拟）。
- ⚠️ 未做真实网络请求验证：`authUrl` 的实际内容、`User-Agent`/`Origin` 要求、
  以及**国际版**（`workbuddy.ai`）是否同一路径，都没有实测过。
  当前 `loginBaseUrl()` 会跟随本机现有凭据的 `domain`，但国际端点仍未验证。

## 浏览器登录添加账号（Trae）

「账号」页右列也有「**添加账号**」，协议与 WorkBuddy **完全不同** —— 真 PKCE
授权码流程，回调走**本机回环 HTTP**（`http://127.0.0.1:<port>/authorize`），
**全程自动回调**，用户不需要复制粘贴任何东西。实现见 `lib/trae-auth.mjs`。

要点（都来自 GitHub 两个实证项目：`HUIdada1/AgentHub` 与
`bluechonk/trae-credential-reverse-engineering`，不是猜的）：

- 登录主机由官方 `GetLoginGuidance` 下发（三个 CN 域依次试），**别写死**
- 授权 URL 参数**缺一不可**：`auth_from=solo` / `hide_saas_login` /
  `code_challenge` / `login_channel` / 设备字段，少一个就被风控当非官方客户端
- 官方页会**先空参探测**回调地址 → 必须回 200 挂起，不能当失败
- 换 token：`ExchangeToken` + `CodeVerifier` + `DeviceInfo`（含一次性 EC P-256
  公钥），`x-cloudide-token` 必须是**空字符串**
- 回环端口被占时**自动换随机端口**（`listenLoopback` 会重新注册监听器，修过
  「端口被占就卡死」的 bug）

⚠️ **每 region 只有一份自有凭据文件**（`.trae-auth.<region>.json`），store 刷新
时会覆盖 —— 所以同 region 重复登录是**替换当前绑定账号**（与官方客户端一致），
不是并存多账号。

## 已知局限

- 改动落在 `node_modules` 里，**插件升级会被覆盖**。
- 依赖各客户端的**私有接口**，官方改协议可能失效。
- 管理页的使用记录**只在打开页面时采集**（刻意不做后台轮询），
  所以每日净变化在「当天只在消耗后才打开过」时会显示为 0 而非负数。
