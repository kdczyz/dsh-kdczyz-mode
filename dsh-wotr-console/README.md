# dsh-wotr-console

把 **WorkBuddy**、**Trae** 与 **Qoder** 三个桌面 App 的模型接进 DeepSeek Harness，
**合并为一个插件**。三个 App 各是一个独立的 provider 家族，
设置里共用一张管理页 —— 配置与查看都在这一页里。

> 「WOTR」= **W**orkBuddy + T**rae**（WorkBuddy-O-Tr-Ae 的缩写读法）。

## 提供的 provider

| provider | 来源 | 说明 |
|---|---|---|
| `workbuddy-xdpool` | WorkBuddy 国内版 | 本机已登录账号构成自动容错的模型池 |
| `workbuddy-xdpool-global` | WorkBuddy 国际版 | 同上，两边账号互相独立 |
| `trae` | Trae 国内版 | 跟随 Trae 桌面端 / CLI 的登录态 |
| `trae-global` | Trae 国际版（Trae / TRAE SOLO） | 同上，按凭据自带的 `userRegion` 判定区域 |
| `qoder` | Qoder 国内版 | 设备流登录的号池（可多账号并存与轮换） |

五个 provider 可以同时使用；某一侧的改动不影响另一侧。

> **Qoder 已接通推理**（2026-10-11，真机端到端验证通过）。
> 登录号池、积分额度、模型目录、**反代请求（签名 + 协议 + 解信封）**、
> 本地 loopback shim、cordis 注册全部就绪。重启后模型选择器里能看到 `qoder`，
> 且**可以正常对话**。
>
> 早期版本认为卡在「拿不到官方自定义 Base64 编码器（在 wasm 里）」并返 501；
> 真机实测推翻了这个前提 —— **查询串不带 `Encode` 时服务端按明文 JSON 处理**，
> 编码器不是必要条件。详见下文「Qoder 反代是怎么打通的」。

## 设置里的一个入口

| 入口 | 管什么 |
|---|---|
| **WOTR 管理** 管理页 | 六个标签页：两个**配置**（XD Pool / Trae 配置）+ 四个**查看/管理**（账号 / Qoder 号池 / 积分 / 使用记录） |

管理页的 tab：

| Tab | 内容 |
|---|---|
| XD Pool | WorkBuddy 池配置：模型勾选 + **「从 WorkBuddy 刷新」**（拉实时目录并自动全启用，无需再点保存）、账号分配策略、积分自动化 |
| Trae 配置 | Trae 配置：供应商开关、账号绑定、模型勾选与测试（含「从 Trae 刷新」）、**号池管理**（分配策略 / 冷却 / 停用 / 保留积分） |
| 账号 | **三列，同一套模块样式**：WorkBuddy、Trae、Qoder。每列都是「列头（标题+区域切换+操作）」+「4 张统计小卡」+**「账号使用方式」分配策略**+「账号卡（名称+状态标签+KV 明细+操作按钮）」。窄屏按 `auto-fit minmax(300px,1fr)` 自动折行 |
| Qoder 号池 | 与「账号」页第三列**是同一个面板**（`QoderPoolPanel`）：**浏览器设备流登录逐个入池**、账号列表（状态/令牌到期/冷却/限流次数/**积分余额，每 30 秒自动刷新**）、分配策略、停用、保留额度、移出池子 |
| 积分 | 当前总积分、每账号额度与积分包明细 |
| 使用记录 | 每日净变化 + 按账号的首次/最新对比（本地落盘数据） |

> **「从 WorkBuddy 刷新」（XD Pool 模型区）**：与 Trae 页的「从 Trae 刷新」同款
> 「拉取即落盘」。服务端 `POST /plugins/dsh-wotr-console/wb/models/refresh?region=`
> （`lib/index.js`）经 `currentApi()` 拉一次上游实时目录并更新内存 catalog ——
> vendor 的启动种子只在插件加载时拉一次，WorkBuddy 之后新上的模型要靠它才能
> 免重启看见；前端随回执把整段五键选择覆盖写入（fresh 全部启用、图片能力跟随
> 上游、既有推理强度沿用），写完读回确认。勾选落盘仍走管理页的
> settingsScope 写入路径，路由只负责「取目录」。

> **模型卡上只有「启用」一个勾选。** 原先挂在卡上的「支持图片」（checkbox）与
> 「限制到 200K」（radio）**已移除** —— 两者看着能勾，其实都改不动结果：
> 图片能力在上游是 `supportsImages || imageSet.has(id)`（**或**），目录说不支持
> 时勾上也不生效；上下文上限则是服务端每次拉目录都会重写 selection，手工写入的
> `contextBudgets` 会被下一次刷新覆盖。现在两项一律跟随上游：保存时
> `imageModelIds` 按目录的 `supportsImages` 生成，`contextBudgets` 整段清空
> （每个模型都用满原生窗口）。

> **两个配置页（XD Pool / Trae 配置）共用同一套前端样式。** 它们由 `console.mjs`
> 的 `PoolConfigTab` 与 `TraeConfigTab` 各自实现，但页内骨架全部走共用模块
> （`ColumnHead` / `StatsRow` / `AccountCard` / `ModelCard` / `EmptyBox`）：
>
> | 位置 | 两页统一的形态 |
> |---|---|
> | 列头 | `ColumnHead`：标题 + 区域切换 + 可选插件 + 右侧操作按钮 |
> | 统计 | `StatsRow`：自适应网格的统计小卡 |
> | 账号卡 | `AccountCard`：名称 + 状态标签 + KV 明细 + `extra` 内嵌控件 + 底部操作按钮 |
> | 模型列表 | `ModelCard`：`wbc-cols` 网格，每模型一个单元（勾选 / 元信息 / 附加控件 / 测试徽章） |
> | 保存条 | `wbc-model-actions`：列表底部 sticky，勾完最后一项就够得着 |
>
> 两页**功能集**不同（Trae 有供应商开关；XD Pool 有「已移出账号池」与「积分自动化」），
> 这些差异保留 —— 统一的是骨架与控件排布，不是内容。`test/console-render.test.mjs`
> 结尾有一组「两页样式一致性」断言守着这件事（列头骨架、账号卡骨架、模型网格），
> 因为它不会让任何功能测试失败，只能显式断言。
>
> XD Pool 的 vendored 客户端（`vendor/xdpool/lib/client.js`）仍被内联执行，但只用于
> 两件事：注册它那份 locale 文案，以及解析它原本绑定的 settings 作用域 ——
> 配置界面本身已由本包自写，不再嵌入上游的 `PoolCard`。
>
> Trae 配置 tab 同样是**本包自写**：不嵌入上游 dsh-connect-trae 的浏览器卡片
> （`vendor/trae` 已移除），读写走 `lib/trae.js` 已有的路由与 `regions` / `accounts`
> 设置字段。它的 settings 作用域由 `client.js` 的 `resolveTraeSettings()` 解析后传入。

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
│   ├── console.mjs            六标签页管理页源码（唯一事实来源）
│   ├── qoder-auth.mjs         Qoder CN 设备流登录（PKCE + 轮询取 token + 逐账号落盘）
│   ├── qoder-pool.mjs         Qoder CN 号池（凭据扫描 / 取号 / 冷却 / 停用 / 保留额度）
│   ├── qoder-credits.mjs      Qoder CN 积分额度（quota/usage 三池解析 + 逐账号刷新）
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
client-modules 不会为它建客户端条目，所以六个标签页只加载一次。

## 设置入口：一个页面、六个标签页

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
Trae 配置页改为本包自写（`console.mjs` 的 `TraeConfigTab`），与 XD Pool 页共用同一套
模块样式（`ColumnHead` / `StatsRow` / `AccountCard` / `ModelCard`）实现：供应商开关、
账号绑定、模型勾选与测试、号池管理。

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
node test/client-apply.test.mjs     # 43 项：仿浏览器执行 client.js 并真正调用 apply
node test/console-render.test.mjs   # 234 项：真正渲染六个 tab（含账号页三列、Trae 配置页与号池区、Qoder 号池页），空/坏数据与边界值、自动刷新定时器、分配策略读写
node test/trae-pool.test.mjs        # 46 项：Trae 号池（scan/分配策略/冷却换号/停用/保留额度）
node test/wb-auth.test.mjs          # 64 项：WorkBuddy 浏览器登录（state 轮询）、凭据落盘
node test/trae-auth.test.mjs        # 71 项：Trae 浏览器登录（PKCE+回环回调，自动回调）、凭据落盘
node test/qoder-auth.test.mjs       # 70 项：Qoder 设备流登录（PKCE、404 继续轮询、machine_id、逐账号落盘）
node test/qoder-pool.test.mjs       # 93 项：Qoder 号池（磁盘为唯一真相、分配策略、逐模型冷却、停用、保留额度）
node test/qoder-credits.test.mjs    # 65 项：Qoder 积分额度（三池解析、查不到≠余额0、负数 clamp、逐账号刷新、保留额度联动）
node test/qoder-relay.test.mjs      # 98 项：Qoder 反代请求（COSY 签名公式、路径归一、dt- 原样可用、SSE 信封判据、失败回灌号池）
node test/qoder-catalog.test.mjs    # 66 项：Qoder 模型目录（**失败时目录永不为空**、每条必带 contextWindow、解析不出不倒退）
node test/qoder-shim.test.mjs       # 52 项：loopback shim（loopback/bearer/Content-Type 防护、timingSafeEqual 长度坑、SSE 头）
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
  账号页合成三列后，它额外守五条：
  - **列的顺序与归属** —— 直接检查元素树里 `wbc-cols` 下有且仅有三个
    `wbc-col`，依次是 WorkBuddy、Trae、Qoder，且各自的控件在自己的列里。
    只看文本断言不出布局：三列若塌成上下三块，文本一模一样
    （反向验证过：对调列会失败）。
  - **三列互不连坐** —— 一侧数据坏掉时另外两侧照常渲染。
    共用一个标签页最容易引入的回归就是一个共用的取值同时打穿三边。
  - **三列同一套模块样式** —— 把每列展开成「标签 + className」序列，
    断言各列用到的模块 class 集合一致、且列头骨架逐项对应。
    这是「三列长得一样」唯一可靠的断言：各写各的也能让文案全部对上。
    反向验证过：删掉一侧统计行 → class 集合不等；
    删掉一侧列头按钮 → 列头骨架不等。
  - **从「账号」页进入时 Qoder 是活的** —— 见下条，这是「同一面板挂两处」
    最容易静默失效的地方。
  - **两列的分配策略读的是各自的来源** —— WorkBuddy 读顶层
    `status.distribution`（池级单键），Trae 读 `traeStatus.pool.distribution`
    （按区域）。夹具刻意给两个**不同**的值，再断言每列高亮的按钮对得上自己
    那份；两列读同一处时界面照样渲染、文案照样齐全，只有高亮项会露馅。
    写入也真点一次：左列要往 `wbSettings` 写 `distribution`，右列要往
    `traeSettings` 写 `regions` 且**不动其它区域槽**，两边写完都要刷新。

> **两列的分配策略作用范围不一样，界面必须说清楚。**
> WorkBuddy 的 `distribution` 是**顶层设置键**（一个池实例，`applyConfigFromSource`
> 只写一次；`region` 仅在取用时过滤账号），所以左列虽然也有「国内版 / 国际版」
> 切换，策略却是**整个池共用**的；Trae 的存在 `regions.<region>.distribution`
> 槽里，**按区域各自保存**。两列因此各带一句相反的作用范围说明 —— 说反了用户
> 会做出错误预期，而这种错误在界面上看不出来。

> **同一个面板挂在两个 tab 下时，渲染对了不等于活着。**
> Qoder 面板同时在「账号」页第三列与独立「Qoder 号池」页，而懒加载与自动
> 刷新原先只判 `tab === 'qoder'`。并入后从「账号」页进来会**整列空白、余额
> 永远停在「读取中…」** —— 面板照样渲染、不报任何错，纯文本断言完全看不出来。
> 所以测试里有一组**真的跑 effect 并驱动定时器**，断言从「账号」页进入会拉
> `/qoder/pool`、会打 `/qoder/credits/refresh`、会注册 30 秒定时器、离开时清掉。
> 反向验证过：把条件改回 `tab === 'qoder'` → 4 条全红，且打过的 URL 列表里
> 一条 Qoder 请求都没有。

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

## Qoder 号池（当前只到「登录入池」）

Qoder 半边目前**只实现了 token 获取 + 登录号池**，还没接成 provider（见文首说明）。

### 为什么不能像 WorkBuddy / Trae 那样「扫本机登录态」

Qoder 桌面端**每个安装只保存一份登录**：再登一个账号会覆盖上一个。所以
「扫描本机已登录账号构成池」这条路在 Qoder 上**根本不成立** —— 无论怎么扫，
永远只能扫出一个账号。要凑出多账号池，只能**逐个显式登录**：

```
「Qoder 号池」页 → 添加账号 → 浏览器完成授权 → 自动入池（可重复 N 次，每个登录 = 一个账号）
```

这是 `lib/qoder-auth.mjs` 存在的唯一理由。

### 设备流：不开端口、无回调页

与 Trae 的回环回调不同，Qoder CN 用**设备流**（PKCE + 轮询），全程不监听
任何本地端口：

| 步骤 | 端点 |
|---|---|
| 打开授权页 | `https://qoder.cn/device/selectAccounts?challenge=…&challenge_method=S256&nonce=…&machine_id=…&client_id=…` |
| 轮询取 token | `https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce=…&verifier=…&challenge_method=S256&machine_id=…` |

几个**踩过就会静默失败**的点（都写进了 `test/qoder-auth.test.mjs`）：

- **`404` 表示「用户还没授权」，必须继续轮询**，不能当失败终止。这是最容易
  写错的一处：当成错误的话，用户去浏览器点确认之前轮询就结束了。
- `200` 但载荷里没有令牌（授权页还没点）同样继续轮询；**非 404 的其它失败**
  才直报（不空转到超时）。
- 成功判据照抄官方：`typeof token === 'string'` —— **不做数字强转**。
- 授权 URL **刻意不带 `redirect_uri`**（设备流没有回调地址，带上会被拒）。
- `client_id` 必须用 **CLI 的** `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`，
  桌面端那个是另一个（用错会被风控当非官方客户端）。
- `machine_id` 存 `~/.qoder-cn/.auth/machine_id`，**读后 trim、绝不覆盖**；
  缺失才生成并落盘；**磁盘不可写不能挡住登录**（退回内存态 UUID）。

轮询节奏照官方：间隔 1000ms，整体超时 5 分钟，单请求超时 30s。

### 号池：磁盘是唯一真相

`lib/qoder-pool.mjs` 的 `QoderAccountPool` 与 Trae 侧同款（`scan` / `acquire` /
`penalize` / `penalizeExhausted` / `resetCooldowns` / `prefer` / `applyConfig`），
三种分配策略（`priority` / `round-robin` / `balanced`）与逐模型冷却都一样。

**唯一的关键差异在 `scan()`**：

| | Trae | Qoder |
|---|---|---|
| 账号来源 | 桌面端登录态 **+** 插件自有凭据 | **只有**插件自有凭据文件 |
| 扫描语义 | 只合并不删除 | **以磁盘为准，文件没了就出池** |

Trae 用「只合并不删除」是因为它的账号有一部分来自桌面端登录态 —— 那些账号
不会因为插件侧删了个文件就消失。Qoder 的入池通道**只有**设备流登录，池的内容
**就是**这些文件，所以 `scan()` 必须以磁盘为准。这正是「移出池子」的实现方式：
删掉 `.qoder-auth.cn.<accountId>.json`，下次扫描它就不在候选里了。

> 这条差异是被一次**真实 bug** 逼出来的：最初照抄 Trae 的「只合并」，结果
> 「移出池子」删了文件、账号却仍留在池里继续被选中。`test/qoder-pool.test.mjs`
> 的「磁盘是唯一真相」与「出池账号的残留状态被清理」两组用例守着它。

冷却与用量状态**跨 `scan()` 保留**（`scan()` 在全池冷却时也会被调用，正在冷却的
账号不该因为这次重扫被重置）；但账号一旦出池，它的 `lastUsedAt` / 余额 /
保留额度 / 停用标记会被一并清理，不让状态无限增长。

凭据落盘为 `.qoder-auth.cn.<accountId>.json`，`accountId` =
`sha256(edition + \0 + (userId || userName || 'unknown')).slice(0,24)` —— 同一算法
在 `qoder-auth.mjs` 与 `qoder-pool.mjs` 里各存一份（**刻意不互相 import**，
免得登录模块被拖进池/provider 的依赖图），靠 `qoder-auth.test.mjs` 里一条
「两边算出同一个 id」的断言守住一致。

### 面板挂在两个地方

Qoder 面板（`QoderPoolPanel`）同时渲染在**两个 tab** 下：「账号」页的第三列，
与独立的「Qoder 号池」页。两处**共用同一个 props 对象**（`qoderPanelProps`），
不复制两份 —— 复制迟早漏改一处，表现为「同一个面板在两个地方行为不一样」。

代价是所有「可见性」判定都必须以 `qoderVisible = tab === 'qoder' || tab === 'accounts'`
为准（懒加载与自动刷新都依赖它）。只写 `tab === 'qoder'` 会让从「账号」页进来的
那一列**空白且余额永远停在「读取中…」**，而面板照样渲染、不报任何错。
`console-render.test.mjs` 里有一组真跑 effect + 驱动定时器的用例钉着这条，
反向验证过（改回 `tab === 'qoder'` → 4 条全红，URL 列表里一条 Qoder 请求都没有）。

### 管理页接口

| 路由 | 作用 |
|---|---|
| `POST /plugins/dsh-wotr-console/qoder/login/start` | 发起设备流登录，返回 `sessionId` + `authUrl` |
| `GET  …/qoder/login/status?session=` | 轮询登录状态；`done` 时落盘并让池重扫 |
| `POST …/qoder/login/cancel?session=` | 取消登录 |
| `GET  …/qoder/pool` | 号池快照（账号 + 冷却 + 停用 + 保留额度） |
| `POST …/qoder/pool/config` | 分配策略 / 冷却时长 / 停用列表 / 保留额度 |
| `POST …/qoder/pool/account` | 启停单个账号 |
| `POST …/qoder/pool/credit-reserve` | 设置单个账号的保留额度 |
| `POST …/qoder/pool/remove` | 移出池子（删除插件凭据，**不碰桌面端登录态**） |
| `POST …/qoder/credits/refresh` | **刷新上游积分额度**（逐账号查 `quota/usage` 并记回池）；前端每 30 秒自动调用，多窗口共享同一发在途请求 |
| `POST …/qoder/cooldowns/reset` | 重置全部冷却 |

全部带本机 Origin 校验（非 loopback 返回 `403 origin-not-trusted`）。

### 积分额度（上游 `quota/usage`）

```
GET {openapiBase}/api/v2/quota/usage
Authorization: Bearer <令牌>
```

CN 的 `openapiBase` 是 `https://openapi.qoder.com.cn`，与设备流轮询同一个 host。

**本插件不需要换 job token**，这是与多数参考实现最大的差别。Qoder 有两族令牌，
`access_token` 里存的可能是任一族：

| `access_token` 形态 | 来源 | 打 `quota/usage` 时 |
|---|---|---|
| `dt-…` 设备令牌 | 浏览器设备流 poll 返回 | **原样当 Bearer**（零网络） |
| `pt-…` PAT | 用户在 Integrations 页签发 | 需先打 `jobToken/exchange` 换 `jt-` |

本插件**只走设备流**，所以入池凭据一律是 `dt-…`，直接发即可。反面教训：把 `dt-`
提交给 `jobToken/exchange` 会回 HTTP 400 `BadRequest`（那是 PAT 专用端点），
表现为「登录明明成功、查额度却报凭据无效」的假象。故 `qoder-credits.mjs`
**刻意不做**令牌族分派 —— 不做才不会做错。

响应是**三池结构，后两池可缺席**：

| 池键 | 含义 |
|---|---|
| `userQuota` | 主额度（实测必在） |
| `addOnQuota` | 加量包（签到积分落这里） |
| `orgResourcePackage` | 资源包 |

三条硬约束，每条都有对应用例钉死：

1. **主池耗尽 ≠ 额度耗尽**。实测有账号 `userQuota.remaining = 0` 而
   `addOnQuota.remaining = 100`。余额口径是**三池 `remaining` 之和**，
   只看主池会把这种账号误判成空号并踢出轮转。
2. **后两池缺席是「池不存在」，不是「余额 0」**。解析容缺，不补成 0。
3. **`expiresAt` 是毫秒**（实测 `253402214400000` = 9999 年 = 永不过期），
   不是秒；且它是**账号级**字段，池本身没有失效字段，故只作诊断保留。

**「查不到」与「余额为 0」严格区分** —— 这是本模块最重要的一条。失败一律
`{ ok: false }`，绝不伪造成 `total: 0`；卡片对「读失败」与「未读到」分别显示
原因与「读取中…」，而不是显示 0。把网络故障显示成「这个账号一分钱都没有了」，
会直接导致用户误删好账号。

**逐账号串行刷新**，单个账号失败不影响其它账号、也**不写余额**（保持未知）。
因此整体仍返回 200，前端把逐账号原因显示在各自的卡片上，而不是把整页标红 ——
否则 3 个号里 1 个失败，另外 2 个已刷新的余额会被一个红条盖住。

刷新后余额经 `pool.noteCredits()` 记回号池，于是**「保留额度」判据立刻有值可用**
（`available()` 会把余额 ≤ 保留值的账号挡在轮转外）。

### 自动刷新（每 30 秒，无手动按钮）

额度**不需要手动刷新**，规则同上游：进入「Qoder 号池」标签页即开始，
每 30 秒一次，切走或页面隐藏即停。

节奏常量 `QODER_CREDITS_REFRESH_MS = 30000` 取的是本仓库既有先例 ——
`vendor/xdpool/lib/client.js` 的 `POLL_INTERVAL_MS = 3e4`（上游自己刷状态接口的
节奏），composer 的积分胶囊用的也是它。两处同源，避免「一处 30 秒、另一处
5 分钟」各刷各的。**为什么不做更快**：`quota/usage` 每次都是一次真实的上游
调用，池里那套 429 冷却正是为这类调用准备的，压到几秒会让请求量比号池任何既有
行为高一个数量级，很可能把账号打成限流、连带影响正常对话。

**为什么必须是自动**：额度是「保留额度」判据的输入，手动刷意味着判据长期拿着
过期余额做决策 —— 这不会报任何错，只会静默地选错账号。

三条配套设计，每条都对应一个「做反了也不会报错」的坑：

| 设计 | 做反了的后果 |
|---|---|
| **不置 `busy`** | 每 30 秒把卡片按钮锁一小会儿，用户看到按钮周期性闪灰 |
| **成功不提示，只有失败占一行** | 每 30 秒冒一次「已刷新 N 个账号」，等同噪声 |
| **进程级在途去重**（`qoderCreditsInFlight`） | 开两个窗口 = 两条 30 秒定时器，上游调用翻倍 |

最后一条是改成自动后**新增**的必要保护：手动按钮时代人只点一次，不存在这个
问题。用共享在途 promise 而不是「上次刷新时间」节流 —— 后者会让第二个窗口拿到
**上一次**的旧结果却以为是自己刚刷的，两个窗口数字会不一致。
`/tmp` 的路由冒烟里有一组「三个并发请求只打一轮上游、且去重不粘住后续刷新」的
断言钉着它。

### 已完成：池已接成 `qoder` provider（2026-10-11）

- ✅ **provider 注册**：模型目录（带兜底）+ 本地 loopback shim + 注册到 `ctx.llm`，
  作为**独立 cordis 入口**（`lib/qoder.js`，entry id `dsh-connect-qoder`）。
  端到端真机验证过：shim → 取号 → COSY 签名 → 上游 → 解双层信封 → OpenAI SSE。
- ✅ **body 编码器不再是前提**：早期版本以为必须拿到官方自定义 Base64 编码器
  （在 wasm 里）才能发请求。真机实测推翻了它 —— **查询串不带 `Encode` 时，
  明文 JSON body 被直接接受**，OpenAI 原始请求体可以原样发。

  | 查询串 | 结果 |
  |---|---|
  | `…&AgentId=agent_common&Encode=1` | 服务端走 `CustomBase64Util.decode`，明文 body 触发 Java 异常 |
  | `…&AgentId=agent_common`（**不带 Encode**） | **明文 JSON 直接可用，正常回话** |

  所以 `lib/qoder.js` 的 `routeChat` 可以把 pi-ai 传来的 OpenAI 请求体**原样**
  交给 `buildQoderChatRequest`，不需要 OpenAI → Qoder 的 payload 映射
  （已实测 8 种形状：基础 user / system / 多轮 / content parts 数组 /
  temperature / max_tokens / 换模型 / `stream:false`，全部 HTTP 200 正常回话）。

  > **实际走哪条**：优先走官方 wasm 路径（与官方客户端同形：`Encode=1` +
  > 自定义编码 body + 完整 `Cosy-*` 头），wasm 不可用时退回上面那条明文路径。
  > 两条都由 `lib/qoder.js` 的 `routeChat` 直接接 pi-ai 传来的 OpenAI 请求体，
  > **不需要** OpenAI → Qoder 的 payload 映射。
  >
  > 官方 wasm **不随仓库分发**：`lib/qoder-fingerprint.mjs` 在运行时从本机
  > Qoder 安装里提取官方 worker runtime 内联的 base64 并驱动它，签名与编码
  > 逐字节一致 —— 既不提交厂商二进制，又能在官方强制 `Encode=1` 时同样可用。

- `deviceToken/refresh` 刷新链路：`QoderCredentialStore.resolveFor()` 目前返回
  `undefined`（= 暂不刷新）。原因是 Qoder 的 refresh 要求 body 里带 `machine_id`
  且有设备绑定语义，需要单独验证；池侧的 `ensureFresh` 早已留好降级路径，
  后续接上不用改池。
- 自动刷新目前是**每 30 秒无条件查一遍**，没有利用凭据自带的额度有效期做
  「还新鲜就跳过」。上游若给出明确的缓存窗口，可以据此省掉大部分调用。
- 只支持 CN（`openapi.qoder.com.cn`）。国际版是**另一套 host 与另一套账号**，
  `fetchQoderQuotaUsage` 的 `openapiBase` 已留注入点，接的时候不用改解析层。

## 反代请求模块（`lib/qoder-relay.mjs`）

### CN 的推理**必须签名**，且没有 REST 路径

国际版有 `/model/v1/chat/completions`，**CN 没有**。CN 走签名路径：

```
POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
Authorization: Bearer COSY.<payload>.<md5>
```

不签名会拿 401/403，而失败形态**伪装成「凭据失效」** —— 用户会去反复重贴凭据、
重登账号，越查越偏。所以签名不是可选项。

### 算法取证：取自官方客户端本体，不是猜的

全部来自 `/Applications/Qoder CN.app` 的 `app.asar` → `out/main/index.js`：

| 官方符号 | 作用 |
|---|---|
| `cXt` | RSA-1024 公钥（PEM 逐字节；只用于包裹会话密钥，**不是凭据**） |
| `lXt()` | 生成 `Cosy-Key`（RSA 包裹会话密钥）与 `info`（AES 加密身份） |
| `iqe()` | 拼 payload 并算出 `Authorization` |
| `dXt()` | 路径归一：取 pathname → 去查询串 → 去 `/algo` 前缀 |

摘要串是**五段 `\n` 连接**：`payload\ncosyKey\ntimestamp\nbody\npath`。
开源参考实现（Qoder2API-Hub）记载的「RSA 包裹 AES 会话密钥 + MD5 请求签名」
与之完全吻合 —— 两条独立来源互相印证。

### `dt-` 原样可用，不需要换 `jt-`

这条**容易做错且错了就是 401**，值得单独说：

- 官方 `lXt()` 里是 `security_oauth_token: t.token`，`t.token` 就是凭据里的
  `access_token` —— **直接写进去**，不经过任何 exchange；
- 参考实现明确记载：设备流 poll 返回的 `dt-…` **就是可用的长期令牌本体**，
  `getJobToken('dt-…')` 是**恒等返回（零网络）**；
- `/api/v1/jobToken/exchange` 是 **PAT 专用**端点，把 `dt-` 提交过去回 400。

早期版本曾强制要求 `jt-`，那会把一条本来能通的路堵死，表现为「登录成功、额度
查得到、但对话永远 401」。现在 `resolveSecurityToken` 不发任何网络请求。

**唯一硬约束是 `uid` 不能为空**：空 uid 必回 `101 Signature invalid`。

### Qoder 反代是怎么打通的（2026-10-11 真机修正）

早期版本认定卡在「官方自定义 Base64 编码器拿不到」，并据此返 501。**这个前提
是错的**，真机实测拿到三条决定性结论：

**① `Encode` 是开关，不是必填 —— 编码器不再是前提。**

| 查询串 | 结果 |
|---|---|
| `…&AgentId=agent_common&Encode=1` | 服务端走 `CustomBase64Util.decode`，明文 body 触发 Java 异常 |
| `…&AgentId=agent_common`（**不带 Encode**） | **明文 JSON 直接可用，正常回话** |

失败时的错误体把实现暴露得很清楚：

```
CustomBase64Util$CustomBase64.decode0(:202) → decode(:92) → decodeV1(:24)
→ EncryptUtil.decode(:20) → AlgoServiceApiController.internalSseInvoke(:667)
```

所以只要**不声明 `Encode`**，服务端就按明文处理。官方那个编码器（细节在 wasm 里、
一直拿不到）**不是接通推理的必要条件**。

**② 目录链是 GET + `{}` body，且必须显式带 `Content-Length`。**

| 方法 | 结果 |
|---|---|
| POST | `400 Request method 'POST' not supported` |
| GET，不带 `Content-Length` | `403 / 101 Signature invalid` |
| GET，带 `Content-Length: 2` | **200，正常返回 14 个模型** |

第二行是最阴的坑：GET 发 body 时 Node 的 `http` 走 chunked 而**不自动加**
`Content-Length`，服务端读到空 body，与签名用的 `{}` 不一致 → 摘要对不上 → 101。
更麻烦的是 Node 的 `fetch` **禁止** GET 带 body（直接抛错），所以这条链只能用
`node:http` 发（`sendQoderRequest`）。

**③ 真机目录形状与兜底表完全不同。**

真实响应顶层是**按用途分组的对象**（`chat` / `developer` / `assistant` /
`inline` / `quest` / `qwork` / `experts` / `qwake` / `app`），对话模型在 `chat`
里，**模型 id 是 `key`**（`qmodel_38max`）而不是 `display_name`
（`Qwen3.8-Max`）。旧兜底表填的是显示名 —— 拿它当 id 发请求就是 404。现已按真机
校准为 `key`，并解析 `max_input_tokens` 作为各模型的真实上下文窗口
（实测跨度 96K ~ 1M，用统一兜底会误导）。

**④ SSE 是多一层信封，且尾部多一帧 `event:finish`。**

```
data:{"headers":{…},"body":"{\"choices\":[…]}","statusCodeValue":200,"statusCode":"OK"}
```

内层 `body` 是**被转义成字符串的 JSON**，要再 parse 一次；`[DONE]` 也在信封里
（`"body":"[DONE]"`），要还原成裸哨兵。另外 `[DONE]` 之后上游还发一帧
`event:finish` + `{"firstTokenDuration":…}` —— **那不是 OpenAI 协议里的东西**，
透传过去 pi-ai 会当 chat chunk 解析而报错，必须丢掉。转换逻辑见 `qoder.js` 的
`sseStreamOf`。

端到端结果：shim 收 `POST /v1/chat/completions` → 200 + 纯标准 OpenAI SSE
（逐字 delta + `[DONE]`，无 `finish` 残留）。

### provider 注册的两个前提

除模块本身外，还有两处接线缺一不可，否则表现都是「模型选择器里没有 qoder」：

1. **`package.json` 的 `exports` 要有 `./qoder`**。Node 的 `exports` 是白名单，
   未声明的子路径解析不了，Loader 加载 `dsh-wotr-console/qoder` 会失败。
2. **profile 的 `cordis.patch.yml` 要有 `dsh-connect-qoder` 条目**。插件自己的
   `- insert:` 只保证条目存在（不带 config）；这份 profile 里其余条目都是手写的，
   Qoder 那条漏了就一直没被加载。`tools/apply-wotr.sh` 现在会自动补齐（幂等）。

### SSE 是套了两层的信封

签名路径每帧都是「信封套内层」：

```
data:{"headers":{...},"body":"{\"choices\":[...]}","statusCodeValue":200,"statusCode":"OK"}
```

内层是**被转义成字符串的 JSON**，要再 parse 一次；收尾帧是 `"body":"[DONE]"` ——
`[DONE]` 也在信封里，**不是**裸哨兵。

判据要求 `statusCodeValue`（数字）**与** `body`（字符串）**同时在**：只认 `body`
会误伤国际版的裸帧（国际版是标准 OpenAI 帧，且业务上可以有名为 `body` 的字段），
轻则丢字段、重则整条流解析失败。

### 失败回灌号池

| kind | 池动作 | 理由 |
|---|---|---|
| `hard_credit` | `penalizeExhausted` | 额度耗尽是**整个账号**的事 |
| `soft_rate` | `penalize(id, resetAtMs, modelId)` | Qoder **按模型**限流，只冷却那个模型 |
| `session_dead` | 不惩罚 | 凭据失效 ≠ 账号有问题，冷却会误伤 |
| `signature` / `client` | 不惩罚 | 换号也一样（同一个签名 bug），惩罚会把**整个池**冷却掉 |

### 已知局限

- 改动落在 `node_modules` 里，**插件升级会被覆盖**。
- 依赖各客户端的**私有接口**，官方改协议可能失效。
- 管理页的使用记录**只在打开页面时采集**（刻意不做后台轮询），
  所以每日净变化在「当天只在消耗后才打开过」时会显示为 0 而非负数。
