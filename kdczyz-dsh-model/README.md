# kdczyz-dsh-model

把 **WorkBuddy**、**Trae** 与 **Qoder** 三个桌面 App 的模型接进 DeepSeek Harness，
**合并为一个插件**。三个 App 各是一个独立的 provider 家族，
设置里共用一张管理页 —— 配置与查看都在这一页里。

> 「WOTR」= **W**orkBuddy + T**rae**（WorkBuddy-O-Tr-Ae 的缩写读法）。

## 安装

走 DSH 插件管理页，从 GitHub 直接装（前置只有 `git`）：

```text
设置 → 插件 → 安装 → 填 github:kdczyz/kdczyz-dsh-model
```

Windows 上没装 git 的话先 `winget install --id Git.Git -e --source winget`，
装完**完全退出 DSH 再重新打开**，然后再装插件；装完**必须重启 DSH**。

> pnpm 解析 `github:` 时会先调 `git ls-remote`，没装 git（或 DSH 看不到它）
> 就会失败，而失败的痕迹会留在 profile 里；另外默认的 `auto-install-peers=true`
> 会按 peer 范围从公共 npm **另装一份**宿主内包，那份在解析链上比宿主更近，
> 会静默遮住宿主那份（表现：模型选择器里一个 provider 都没有）——
> 这两条现在都已处理：peer 范围选得中宿主版本，DSH 自己写的 profile
> `pnpm-workspace.yaml` 里带 `autoInstallPeers: false`。
> 宿主内包不需要往 profile 里复制或软链，DSH 会在内存里路由给每个 profile。
> 详见根 `README.md` 的「零、安装」（含本机开发部署那条路）。

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
| **WOTR 管理** 管理页 | 三个标签页，都是**配置**页：workbuddy / trae / qoder，各自带「刷新账号」与「添加账号」 |

管理页的 tab：

| Tab | 内容 |
|---|---|
| workbuddy | WorkBuddy 池配置：**「账号」区**（分配策略、清除冷却、每账号「参与轮换 / 保留额度 / 移出池子」）+ **「模型」区**（「从 WorkBuddy 刷新」拉实时目录并自动全启用、Max 模式、逐模型启用勾选、底部保存条）+ 该页独有的「已移出账号池」「积分自动化」两个分区 |
| trae | Trae 配置：供应商开关（页头）、区域切换、「账号」区（分配策略 / 清除冷却 / 参与轮换 / 保留额度）、「模型」区（勾选与「一键测试启用模型」、**「从 Trae 刷新」**） |
| qoder | **单列**（与另两个配置页同一条骨架）：页头（刷新 / 添加账号）→ 四格统计 → **「账号」区**（浏览器设备流登录逐个入池、状态/令牌到期/冷却/限流次数/**积分余额，每 30 秒自动刷新**、清除冷却、参与轮换、保留额度、移出池子）→ **「模型」区**（`QoderModelsPanel`：逐模型启用勾选 + **「从 Qoder 刷新」**，图片与上下文跟随上游，见下文「Qoder 模型」）。账号区就是 `QoderPoolPanel` 本体 |

> **「从 WorkBuddy 刷新」（workbuddy 模型区）**：与 Trae 页的「从 Trae 刷新」同款
> 「拉取即落盘」。服务端 `POST /plugins/dsh-kdczyz-mode/wb/models/refresh?region=`
> （`lib/index.js`）经 `currentApi()` 拉一次上游实时目录并更新内存 catalog ——
> vendor 的启动种子只在插件加载时拉一次，WorkBuddy 之后新上的模型要靠它才能
> 免重启看见；前端随回执把整段五键选择覆盖写入（fresh 全部启用、图片能力跟随
> 上游、既有推理强度沿用），写完读回确认。勾选落盘仍走管理页的
> settingsScope 写入路径，路由只负责「取目录」。

> **模型卡上只有「启用」一个勾选。** 原先挂在卡上的「支持图片」（checkbox）与
> 「限制到 200K」（radio / number）**已移除** —— 两者看着能勾，其实都改不动结果：
> 图片能力在上游是 `supportsImages || imageSet.has(id)`（**或**），目录说不支持
> 时勾上也不生效；上下文上限则是服务端每次拉目录都会重写 selection，手工写入的
> `contextBudgets` 会被下一次刷新覆盖。现在两项一律跟随上游：保存时
> `imageModelIds` 按目录的 `supportsImages` 生成，`contextBudgets` 整段清空
> （每个模型都用满原生窗口）。
>
> 这条对**三家都成立**（WorkBuddy / Trae / Qoder）。Qoder 侧曾经多留了一版
> 「补勾图片 + 上下文上限」（理由是想给上游漏标的模型留个口子），现已与另两家
> 对齐删除：`lib/console.mjs` 的 `QoderModelsPanel` 里两个控件都拆掉了，
> 「从 Qoder 刷新」也改成拉取即落盘。图片与上下文在模型卡上照旧看得见 ——
> 名字后面的「图片」标记、meta 里的「上下文 180K」（上游 `max_input_tokens`）。

> **三个配置页（workbuddy / trae / qoder）共用同一套骨架与控件。** 它们由
> `console.mjs` 的 `PoolConfigTab` / `TraeConfigTab` / `QoderPoolPanel` +
> `QoderModelsPanel` 各自实现，但自上而下是同一个形状：
>
> | 位置 | 三页统一的形态 |
> |---|---|
> | 页头 | `ColumnHead`：标题 + 区域切换（Qoder 无区域）+ 右侧按钮（都是「刷新」，Qoder 另有「添加账号」）。**按钮文案固定**，状态变化用禁用态与下面的说明行表达 |
> | 状态行 | 固定顺序：只读提示（`READONLY_NOTE`）→ `读取失败：` → `保存失败：` → 已保存 → 正在读取 → 空态 `EmptyBox` |
> | 统计 | `StatsRow`：**四格** —— 账号 / 可用 / 冷却中 / 当前使用（每页第三、四格的事实各按本页数据措辞） |
> | 「账号」区 | `Section`：标题 + 计数副标题 + 右上角分配策略与**「清除冷却」**；卡走 `AccountCard`，卡内控件走共用 `CardActions`（参与轮换 / 保留额度 / 保存 / 移出池子）。**卡上的标签词汇、压暗规则、余额读法三页逐字同款**：首标签只有「当前使用 / 备用」（当前那张亮着，其余压暗；宿主没给「当前是谁」时一张都不压暗）；状态标签是「冷却中 / 已停用 / 已保留·暂停 / 限流 N 次」——**限流次数是标签，不是常驻的「触发限流 0 次」行**；余额统一走 `accountCreditsOf`（WorkBuddy 的 `credits` 是 `{total, packages…}` **对象**，曾经直接 `fmtNum` 渲染成「通用余额 –」，而数字就在响应体里）。三页的**卡片底部都是「切换账号」**，且**当前使用的那张都不给「切换到此账号」**（它已经是当前了）：Trae / Qoder 的那一行里并排两颗按钮 ——「切换到此账号」+「签到」（**签到是每张卡都有**，含当前使用那张），WorkBuddy 同款。WorkBuddy 先前在当前那张上放的是「取消固定」（`accountId: null`，等于把池子清成「没有当前账号」→ 每次请求都 503），已删除，三页现在完全一致 |
> | 「模型」区 | `Section` 收尾 + `wbc-cols` 网格的 `ModelCard`（勾选 / 元信息 / 附加控件 / 测试徽章）+ 底部 sticky 保存条 `wbc-model-actions` |
>
> 三页**功能集**不同（Trae 页头有供应商开关；workbuddy 多「已移出账号池」「积分自动化」两个分区；Qoder 页头有「添加账号」、账号卡多「令牌到期 / 余额」行），
> 签到也是这一层差异：**三家的签到都按账号**（每张登录着的卡都能签自己那个账号），
> 区别在上游：workbuddy 自己认 `accountId`；Trae 的 `checkin_credits/claim` **没有这个参数** —— 那一边靠「换一份凭证」实现（路由收 `accountId`，用 `clientOfAccount` 造一次性 client 走同一条流程，
> `creditsOfAccount` 那条不重绑 store 的老路子），所以按下备用卡的「签到」签的是那个账号，Trae 正在服务的账号一动不动；Trae 另有一道**设备**门禁（`did_checked_in` / `code: 9095`），
> 界面因此把「这个账号今天已经签过了」与「本机今天已经签过了」分开说 —— 混成一句会让用户以为新账号拿到了钱，而它一分没拿；
> 而**这道门禁是按 `x-device-id` 认设备的，所以每个账号领一个自己的设备身份**（`TraeCredentialStore#deviceIdOf`）：
> 上游把签到结算到设备上，全池共用一个 id 就等于整台机器一天只可能有一次入账 ——
> 备用卡按下去换来的会是 `9095`「当前设备今日已经签到」。各自持一个 id 之后，同机每个登录都能签到自己那份
> （2026-10-12 实测：同一个未签账号，真机 id 答 `9095`、换成派生 id 立刻 `code: 0`，而 `x-machine-id` 完全不影响结果）；
> 代价是**账号的设备身份不再是桌面安装那个 id**，Trae 自己日志里的 `X-Device-Id` 与本插件发的对不上，这是刻意的；
> **Qoder 的签到在活动线上**（`GET /sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`，见下文「每日签到（活动线）」一节）：
> 凭据按 `accountId` 取那一份，整个流程**不碰 `selectedAccountId`**（不切号），
> 而且上游的领取是**幂等**的 —— 对已领活动再 POST 回 200 + `replayed: true` 而余额一分不变，
> 所以界面按 `replayed` 把「这一下真领到」与「今天早已领过」分成两句话（拿 `grantId` 非空判成败，会每天谎报一次 +100），
> 这些差异保留 —— 统一的是骨架、控件与措辞，不是内容。`test/console-render.test.mjs`
> 里有「三页样式一致性」「账号卡标签词汇/压暗规则/余额读法逐字同款」「账号卡能切换账号
> 并断言整页不出现「取消固定」（连 region 参数一起断言）」「Trae 与 Qoder 的签到每张卡都在、带的是自己那张卡的 accountId、且一个字节都不写 selectedAccountId」「Trae 签到与取数同一个 region、设备拒签(9095)说成「本机已签」」「Qoder 的重放不许说成「签到完成 · 已领」」「页头按钮文案不随状态变」「号池快照为空时主要按钮仍在」几组断言守着它，因为这类退化不会让任何功能测试失败，
> 只能显式断言（而且整页文本断言不够 —— 卡上贴错的标签，整页搜词照样通过，得按卡片取文本）。
>
> 补充两点实现细节：`Section`（分区）与 `CardActions`（卡片操作）也是共用模块里的
> 原语，新增分区/卡片控件请直接用它们，别在页面里另起一套；「qoder」页的两个
> 面板用 `flat` 平铺（`.wbc-flat{display:contents}`）直接成为页面 `wbc-body` 的子项，
> 这样它与另两页的分区间距一致（16px），而同一个 `QoderPoolPanel` 在「账号」页第三列
> 里仍是自带 `wbc-col` 的一列（12px）。
>
> workbuddy 的 vendored 客户端（`vendor/xdpool/lib/client.js`）仍被内联执行，但只用于
> 两件事：注册它那份 locale 文案，以及解析它原本绑定的 settings 作用域 ——
> 配置界面本身已由本包自写，不再嵌入上游的 `PoolCard`。
>
> trae tab 同样是**本包自写**：不嵌入上游 dsh-connect-trae 的浏览器卡片
> （`vendor/trae` 已移除），读写走 `lib/trae.js` 已有的路由与 `regions` / `accounts`
> 设置字段。它的 settings 作用域由 `client.js` 的 `resolveTraeSettings()` 解析后传入。

打开本页默认停在 **workbuddy**。

## 目录结构

```
kdczyz-dsh-model/
├── package.json
├── cordis.patch.yml           两个 Loader entry（见文件内注释，勿改 id）
├── lib/
│   ├── index.js               WorkBuddy 半边（provider 注册 + 管理页接口）
│   ├── trae.js                Trae 半边（上游 lib/index.js 并入；号池为新增）
│   ├── client.js              浏览器端唯一 bundle（两块内联 + 卡片截获层）
│   ├── console.mjs            三标签页管理页 + 胶囊卡片源码（唯一事实来源）
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
      name: kdczyz-dsh-model        # -> lib/index.js
    - id: dsh-connect-trae
      name: kdczyz-dsh-model/trae   # -> lib/trae.js
```

原因：两半各自声明 `enabledModelIds` / `contextBudgets` 等**语义不同**的同名字段，
而 cordis 按 `apply` 的函数身份给运行时和 `Config` schema 建键 ——
同一个模块会被塌成一份 schema，两边互相覆盖。两个模块才是两份独立 schema。

两个 entry 的 id 也**不能改名**：`llm-workbuddy-xdpool` 是 vendored 池卡片
查自己设置作用域用的精确键；`dsh-connect-trae` 匹配 Trae 半边的 `/trae/i` 探测，
并保留 profile 里已保存的 Trae 设置。

客户端 bundle 仍然只有**一个**：entry B 用的是子路径 specifier（含 `/`），
client-modules 不会为它建客户端条目，所以三个标签页只加载一次。

## 设置入口：一个页面、三个标签页

两个 vendored 客户端原本各自把设置卡片注册成**独立入口**：

| vendored | 原本的入口 | 现在 |
|---|---|---|
| `vendor/xdpool` | `settings.section` id=`workbuddy-xdpool`（设置面板一整个页面，order 440） | 截获为 WOTR 页的 **workbuddy** 标签页 |

做法在 `lib/client.js` 的 `captureCards()`：转发 vendored `apply` 时套一层
**替身 ctx**，只把目标槽位的 `register` 拦下来，记下组件本体与它原本会收到的
props（`opts.inject()` 求值一次，`settingsScope` 是同一对象引用），
然后照常执行它们的 apply。于是：

- 上游源码**一行未改**，日后仍可逐字节对照升级；
- 个别失效的 effect 按标签丢弃（见下）。

### 完全手动切换账号（三渠道统一，无任何轮询/冷却策略）

三个渠道（WorkBuddy / Trae / Qoder）的账号池**全部改为完全手动取号**：

- **取号语义**：请求只用你「切换到此账号」选中的那一张；未选、选中账号被停用、
  不在池里或区域不符时，请求**直接失败**（503 + 「请手动切换账号」提示），
  **绝不自动让位 / 自动换号**；
- **已删除**：分配策略（优先 / 轮换 / 均衡，含 `priority` / `round-robin` /
  `balanced` 与随机权重）、「参与轮换」开关、冷却机制（`cooldownMs` /
  `exhaustCooldownMs` / 冷却重置路由 `/cooldowns/reset`、冷却展示与
  「清除冷却」按钮）、保留额度（`creditReserves` / `/credit-reserve` 路由）；
- **保留**（手动管理）：移出池子 / 恢复、切换到此账号、签到领取。三家都不给「清空选择」
  这条路 —— WorkBuddy 先前那颗「取消固定」（`accountId: null`）已删除：它让池子从此
  没有当前账号，之后**每一次请求都 503**；换账号一律点另一张卡上的「切换到此账号」。

管理页（`console.mjs`）与号池实现（`vendor/xdpool/lib/index.js`、`lib/trae.js`、
`lib/qoder-pool.mjs`）已同步精简：统计格、卡片标签、按钮与路由都只留下与
「手动选中」相关的部分。

### trae tab：本包自写

上游 `dsh-connect-trae` 的浏览器半边（`vendor/trae/client.js`）**已整体移除**，
trae 页改为本包自写（`console.mjs` 的 `TraeConfigTab`），与 workbuddy 页共用同一套
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

早先按快照传值，后果是「WOTR 页正常、三个标签页都在，但配置组件显示
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

> **必须丢弃的 effect**：`installNavIcon` 会给「workbuddy」那条设置导航行画图标，
> 方式是往 `document.body` 挂一个 `MutationObserver`（childList + subtree +
> characterData），每次 DOM 变动全页扫一遍找那条行。合并后那条行已不存在，
> 它匹配不到任何目标却仍常驻监听整个应用 DOM —— 纯粹的开销。
> 所以 `captureCards` 按标签（`settings nav icon`）把该 effect 丢掉了。

## composer 的积分胶囊（点开 = 这个平台的全部账号）

输入框下面那颗胶囊（槽位 `conversation.composer.dock`）从「只显示一个数字」
变成了**按钮**：点开是一张卡片，列出**当前模型所属那一个反代平台**的全部账号。
用户的原话是「是单独反代平台的所有账号，不是所有账号」—— 所以卡片按
`provider → 平台` 分组，而不是把五个 provider 的账号混在一张表里：

| 平台（provider） | 卡片里列什么 | 组标题副文本 |
|---|---|---|
| WorkBuddy（`workbuddy-xdpool` / `-global`） | 国内版 + 国际版**两个区域** | `国内版 2 个 · 本轮用 1412` |
| Trae（`trae` / `trae-global`） | 国内版（cn）+ 国际版（ai）**两个区域** | `国内版 2 个` |
| Qoder（`qoder`） | 单个号池（没有区域概念 → **不画组标题**） | — |

`CREDIT_FAMILIES` 是这张表在代码里的样子；胶囊自己的数字仍然只讲**当前 provider
那个区域里正在服务的那一个账号**（WorkBuddy 用 `activeAccountId`、Trae 用
`lastServedId` 退回「当前账号」、Qoder 用 `serving.accountId`），与卡片是两个口径。

每一行只有一个控件（原先还有一个「停用 / 启用」开关，已移除 —— 完全手动语义下
它只对「已选中的那个」有效，停用别的账号对请求毫无影响；账号管理只剩「移出池子」）：

| 控件 | 干什么 | 打到哪 |
|---|---|---|
| **「切换到此账号」** | 下一次请求优先用它 | WorkBuddy：`POST …/accounts/select?region=cn\|global`；Trae：`POST /pool/account?region=` **且必须补一次 `accounts` 设置写**；Qoder：写 `selectedAccountId` |

已经是「当前账号」的那一行：三家**都不给按钮** —— 「切换到这个已经是当前的账号」
是纯 no-op（三个配置页也是这么做的）。WorkBuddy 先前例外，给的是「**取消固定**」
（`{accountId:null}`）：完全手动语义下那不是「退出固定」，而是把池子清成「没有当前
账号」，之后每一次请求都 503，所以已删除。

### 四个「做反了也不会报错」的坑

| 坑 | 后果 | 现在的做法 |
|---|---|---|
| Trae 的 `credits.total` 是**发放总量**，不是余额 | 真机上把 3,050（发放）当成余额显示，而账号只剩 796.88 | `accountCreditsOf(row, family)` 按平台取字段：Trae 取 `generalAvailable → available → total`，WorkBuddy / Qoder 取 `total → …`（Qoder 就是裸数字） |
| WorkBuddy 的 `disabledAccountIds` 是**两个区域共用的一份扁平数组**（两个 provider 注册同一个 `settingsNs` + `settingsPath: []`） | 配置页只看得见本区域的账号，照本区域拼一份完整名单写回设置，会把**另一个区域**已停用的账号静默重新启用 | 启停只走 `/accounts/disabled` 路由（服务端对 `current().disabledAccountIds` 合并）；单测里除了断言「请求发出去了」，还断言**没有**顺手写那份设置 —— 只断言前者的话，「路由 + 顺手再写一次」也能全绿 |
| 卡片开着的时候轮询额度 | 上游按账号计费（Trae 的 `/usage` 是一次实时计费读），卡片开着不动也在持续花钱 | 只在**打开卡片 / 手动刷新 / 写完一次切换之后**取一次；`CREDIT_REFRESH_MS = 30000` 只作用于胶囊那颗数字。单测里钉着「展开卡片不新增任何 interval」 |
| 行里的名字直接用上游昵称 | Qoder / Trae 的 label 是 uuid，卡片被撑破 | `shortAccountName()` 截到 8 个字符 + `…`，完整值放 `title` |

### 浮层为什么是 portal + fixed

胶囊本身在 composer 那一行里是 `inline-flex`，而嵌入形态下 composer 外层有
`overflow:hidden` 的容器（`.ST7X_W_embeddedBody`）—— 行内绝对定位的卡片会被裁掉。
所以卡片走 `createPortal(card, document.body)` + `position: fixed`，
`z-index: 1100`，与内置的 `ContextMeter` 同一条路；坐标由
`measureCreditCard(anchor, panel)` 量出来（贴着胶囊上沿弹出，顶到视口就翻到下方）。
拿不到 `react-dom` 时（`lib/client.js` 里 `require('react-dom')` 的 try/catch）
退回行内渲染并打一条 `console.error` —— 卡片会难看，但不至于整个设置面板崩掉。

点外面或按 Esc 关闭：捕获阶段的 `pointerdown`（click 会被卡片里的按钮吃掉，
而且「按下即关」更接近原生浮层），命中判定同时看**胶囊**与**卡片**两个 ref ——
卡片已经 portal 到 body，不在胶囊的 DOM 子树里，只判断胶囊的话，
在卡片里点任何东西都会立刻把它关掉。

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
node test/console-render.test.mjs   # 402 项：真正渲染三个 tab（三个配置页的同一套骨架与页头按钮、Qoder 单列）与 **composer 胶囊展开的账号卡片**，空/坏数据与边界值、自动刷新定时器、分配策略读写、Qoder 模型列（图片/上下文跟随上游 + 「从 Qoder 刷新」拉取即落盘）、Trae 与 Qoder 的「签到」（每张卡带自己的 accountId、不写 selectedAccountId、重放不许说成「已领 +100」）、卡片的启停/切换两条写路径与「展开卡片不新增任何定时器」
node test/host-assembly.test.mjs    # 10 项：cordis 装配层（exports 白名单、cordis.patch.yml 条目）
node test/trae-pool.test.mjs        # 46 项：Trae 号池（scan/分配策略/冷却换号/停用/保留额度）
node test/trae-checkin-route.test.mjs # 36 项：Trae 签到路由（指定账号走 clientOfAccount 且绝不碰绑定账号、设备门禁 9095 与「账号已签」分开、未知账号 404、方法/区域/来源/坏 JSON 边界）
node test/trae-auth.test.mjs        # 71 项：Trae 浏览器登录（PKCE+回环回调，自动回调）、凭据落盘
node test/wb-auth.test.mjs          # 64 项：WorkBuddy 浏览器登录（state 轮询）、凭据落盘
node test/wb-pool-selected.test.mjs # 35 项：WorkBuddy「选中的账号」语义（空串/undefined 都算清除）
node test/wb-fingerprint.test.mjs   # 38 项：WorkBuddy 指纹头（Message-ID / X-Request-ID 同值）
node test/qoder-auth.test.mjs       # 70 项：Qoder 设备流登录（PKCE、404 继续轮询、machine_id、逐账号落盘）
node test/qoder-pool.test.mjs       # 156 项：Qoder 号池（磁盘为唯一真相、分配策略、逐模型冷却、停用、保留额度）
node test/qoder-pool-route.test.mjs # 35 项：Qoder 号池路由（快照形状、旧的四条写路由不许回来、点「切换到此账号」写 settings 后请求路径真的换人、冷却自动让位但「当前使用」标记不动）
node test/qoder-credits.test.mjs    # 100 项：Qoder 积分额度（三池解析、查不到≠余额0、负数 clamp、逐账号刷新、保留额度联动）
node test/qoder-campaign.test.mjs   # 112 项：Qoder 每日签到（活动线头必须是 Cosy-ClientType 10 且与额度链的 5 互不污染、活动/领取响应解析、`replayed` 才是判据、按 actionType 挑签到活动、已领不发领取、失败码）
node test/qoder-checkin-route.test.mjs # 51 项：Qoder 签到路由（按 accountId 取那一份凭据且**绝不改 selectedAccountId**、已领只读列表、成功顺带读额度记回池、未知账号 404、GET 405、外域 403、坏 JSON 400）
node test/qoder-relay.test.mjs      # 112 项：Qoder 反代请求（COSY 签名公式、路径归一、dt- 原样可用、SSE 信封判据、失败回灌号池）
node test/qoder-catalog.test.mjs    # 86 项：Qoder 模型目录（**失败时目录永不为空**、每条必带 contextWindow、解析不出不倒退、`is_vl` → 图片能力、并发刷新只打一次上游）
node test/qoder-provider.test.mjs   # 52 项：Qoder provider 注册、白名单/图片（与上游取并集）/上下文预算真的生效、discovery 与 toPiModel 判据一致、含图 stream() 必过附件服务（含负向对照）
node test/qoder-chat.test.mjs       # 28 项：Qoder 推理链（内层业务码、成功判据）
node test/qoder-payload.test.mjs    # 32 项：Qoder 请求体构造（手写/官方两条路径的 body 与 Content-Length 一致）+ **图片块逐字透传**
node test/qoder-streaming.test.mjs  # 18 项：Qoder SSE（双层信封还原成裸哨兵）
node test/qoder-dedup.test.mjs      # 25 项：Qoder 请求去重（18 次调用只打 1 次上游）
node test/qoder-fingerprint.test.mjs # 50 项：Qoder 官方 wasm 指纹器提取与实例化
node test/qoder-shim.test.mjs       # 52 项：loopback shim（loopback/bearer/Content-Type 防护、timingSafeEqual 长度坑、SSE 头）
```

一次跑完（25 个文件）：`for f in test/*.test.mjs; do node "$f" || break; done`。

> **跑测试前先解决宿主包的解析**。三个 Loader 入口在模块顶层 import 只存在于 DSH
> 宿主里的包（`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm-pi-ai`、
> `@deepseek-ai/schemastery`），而本仓库的 `node_modules` 是空的 —— 凡是要
> `import` 三个入口的测试（`qoder-*` 全部、`trae-*`、`wb-*`）都会直接
> `ERR_MODULE_NOT_FOUND`，**不是测试坏了**。两条路二选一：
>
> ```sh
> # A) 没有 profile 时：正常装依赖（会拉 177 MB）
> pnpm install
>
> # B) 有已部署的 profile 时：直接把它的 node_modules 链过来（零下载）
> ln -sfn ~/.dsh/profiles/desktop/node_modules node_modules
> ```
>
> B 那条正是 `tools/apply-wotr.sh` 第 1 步「源码门禁」跑测试时依赖的环境；
> 部署本身不需要它（部署后插件在 profile 里，往上就能解析到宿主包）。

后两层各对应一次真实事故，**不能省**：

- **`client-apply`** 防「应用无法启动」：`client.js` 的 wrapper 里曾引用未声明的
  `react`，`apply` 抛 `ReferenceError` → cordis fiber 变 `failed` →
  宿主弹「应用无法启动或已意外停止」。只测「内联工厂能求值」抓不到。
  卡片并入后它还守一条跨模块契约：截获到的组件必须真的**渲染进**管理页，
  且拿到 `settingsScope` 与 Trae 的 `view: 'page'` —— 否则这三个配置标签页
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
    写入也真点一次：左列要往 `wbSettings` 写 `distribution`，中列要往
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

## Trae 号池（按 workbuddy 的做法）

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

- **WorkBuddy**：池**同时扫描两处** —— 桌面端 app 的登录态目录
  （vendored `defaultDesktopAuthDirs()`）+ 插件自有凭据目录
  `$DSH_HOME/.wb-auth`（`dsh-wotr-<账号id>.info`，本 fork 新增，对齐 Trae 半边）；
  由 vendored xdpool 读取（用 `currentApi().pool` 拿**已解密**的凭证）
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

**凭据落盘**：写成 `dsh-wotr-<账号id>.info`，放进 **`$DSH_HOME/.wb-auth`**
（vendored 池的 `candidateAuthDirs()` 同时扫描桌面目录与本目录，对齐 Trae 的
`.trae-auth.*` 双源模型），权限 `0600`。删掉桌面端 app、卸载清掉它的数据目录
**都不影响插件账号**；桌面端登录态照常被扫描，同账号按 id 合并、取较新的那份。
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

「账号」页中列（Trae）也有「**添加账号**」，协议与 WorkBuddy **完全不同** —— 真 PKCE
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

## Qoder 号池与模型列

Qoder 半边**已接成 provider**（`qoder`，见文首说明与下文「已完成：池已接成
`qoder` provider」）；本节讲号池本身，模型列见下一节。

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
| `POST /plugins/kdczyz-dsh-model/qoder/login/start` | 发起设备流登录，返回 `sessionId` + `authUrl` |
| `GET  …/qoder/login/status?session=` | 轮询登录状态；`done` 时落盘并让池重扫 |
| `POST …/qoder/login/cancel?session=` | 取消登录 |
| `GET  …/qoder/pool` | 号池快照（账号 + 冷却 + 停用 + 保留额度） |
| `POST …/qoder/pool/config` | 分配策略 / 冷却时长 / 停用列表 / 保留额度 |
| `POST …/qoder/pool/account` | 启停单个账号 |
| `POST …/qoder/pool/credit-reserve` | 设置单个账号的保留额度 |
| `POST …/qoder/pool/remove` | 移出池子（删除插件凭据，**不碰桌面端登录态**） |
| `POST …/qoder/credits/refresh` | **刷新上游积分额度**（逐账号查 `quota/usage` 并记回池）；前端每 30 秒自动调用，多窗口共享同一发在途请求 |
| `POST …/qoder/checkin` | **按账号签到**（body `{accountId}`，省略则签「当前使用」那个）。走活动线 `me/campaigns` → `…/claim`，签的是**那个账号自己的凭据**，**绝不改 `selectedAccountId`**；成功时顺带读一次 `quota/usage` 并把余额记回池 |
| `POST …/qoder/cooldowns/reset` | 重置全部冷却 |
| `GET  …/qoder/models/refresh` | **只读模型目录快照**（模型 id/名称/上下文窗口/是否支持图片 + 是否在用兜底表 + 上次拉取时间 + `capabilities` 接线自述）。**不触上游、不花额度** —— 面板打开时走这条 |
| `POST …/qoder/models/refresh` | **拉一次上游目录**（`model/list`）后返回同一份快照。卡片的「从 Qoder 刷新」按钮走这条（拉取即落盘，见下节） |

> **`capabilities.imageAttachments` 是「跑的是哪一版代码」的判据。** 部署
> （`tools/apply-wotr.sh`）之后**必须整个退出重开 DSH** 才生效，而没接上
> `resolveAttachments` 时的报错（`pi-ai image input requires the durable
> attachment service`）与「模型不支持图片」长得几乎一样 —— 只看现象分不清
> 「代码没加载」还是「代码不对」。所以回执里带了这个自述字段：**为 `true`
> 才说明当前进程加载的这一版把图片链路第二层接上了**。

`OK` 之外的细节：`POST …/qoder/models/refresh` 拉取失败时返回 **502**，但 body 里
**仍然带那份快照**（`ok:false` + `message` + 兜底/旧目录）—— 面板因此能同时显示
「刷新失败了」和「当前可用的是哪些模型」。前端读它用裸 `fetch` 而不是
`fetchJson`（后者对非 2xx 直接抛错，会把 body 丢掉）。

全部带本机 Origin 校验（非 loopback 返回 `403 origin-not-trusted`）。

### Qoder 模型（「qoder」页的「模型」区）

这一区与 WorkBuddy / Trae 的模型列**逐条同款**：每张卡只有一个「启用」勾选，图片
能力与上下文窗口都跟随上游目录，没有任何手动开关。三个字段仍会被写入，但值由
设置页按**当次目录**推导（`lib/console.mjs` 的 `upstreamFieldsOf`）：

| 设置字段 | 语义 |
|---|---|
| `enabledModelIds` | 下发给 DSH 的模型白名单。**空 = 不限制**（目录里所有模型都可用）。⚠️ 这是与 WorkBuddy 侧刻意不同的一处：那边把空列表当成「一个都不用」，于是新装的机器上「一个模型都看不到」；这里按 schema 的自然语义处理，界面上也把这种状态画成「全部已勾选」并提示「保存后将成为固定白名单（不再自动跟随上游新增）」 |
| `imageModelIds` | 图片能力，由目录里 `supportsImages`（上游 `is_vl`）的 id 组成 —— **随上游刷新而重写，页面上没有勾选框**。provider 侧与上游取并集（`lib/qoder.js` 的 `selectModels`），所以这个字段只会**加**、不会把上游已给的图片能力撤掉 |
| `contextBudgets` | 逐模型的上下文窗口，**只下调**；页面写入的永远是 `{}` = 每个模型都用满上游原生窗口（`max_input_tokens`，兜底表见 `lib/qoder-catalog.mjs`）。调大无效：上游按档位选窗口，本插件不改请求档位 |

#### 为什么这两个控件被删掉了

它们曾经挂在这里（另两家更早就删了）：

- **补勾图片**：对上游已声明图片的模型它是「撤销」——做不到，只能画成禁用；对
  上游标漏的模型它是**猜**：猜错了 DSH 会把图片原样发出去、由上游在**准入之后**
  拒绝，用户看到的是「模型不收图片」，而一次额度已经扣掉了。两种情况下都不是一个
  诚实的开关。（标错的代价仍然不对称：漏标只是少发图片。）
- **上下文上限**：`contextBudgets` 只能压低上游窗口，而每次拉目录都会被按上游
  重写 —— 手填的数字下一次刷新就没了。留着它等于让用户维护一份随时被覆盖的副本。

图片与上下文在模型卡上**照旧看得见**：名字后面有「图片」标记，meta 里有
「上下文 180K」和「输出 …」。

#### 「从 Qoder 刷新」= 拉取即落盘

与「从 Trae 刷新」「从 WorkBuddy 刷新」同一语义：**一次点击**拉上游目录 → 目录里
的模型全部启用 → 图片/上下文按上游写回 → 逐字段读回确认，**不需要再点保存**
（写完才丢草稿，所以不会出现「拉到了新目录、选择还是旧的」这种半截状态）。

⚠️ **拉取失败时一个字段都不写。** `POST …/qoder/models/refresh` 在失败时仍回一份
兜底目录（`ok:false` + `usingFallback:true`，502），照它写下去等于把内置兜底表
固化成用户的白名单 —— 而兜底表里的图片标记、模型集合都可能与他的账号实际可用的
不一样，他看到的提示却只是「刷新失败」。所以面板只显示错误 + 当前目录，不落盘。

手动勾选仍然保留（改完点底部的保存栏）：保存写的是同一条 `writeSelection`
路径，图片/上下文同样按目录推导，只有 `enabledModelIds` 来自勾选。

#### 面板打的两条路由

打开面板走 **GET**（只读快照，不触上游、不花额度），只有点「从 Qoder 刷新」才走
**POST**。写反了会变成「一进设置页就替你打一次上游」。

#### 保存写不进去时会发生什么

保存是**逐字段写 + 读回确认**：写完一个字段立刻读回作用域，值没落地就抛错并
在面板上显示「`qoder`: settings 字段 \"xxx\" 未能写入」。这条护栏是必需的 ——
宿主的写入闸门可以拒绝写入而 `set()` 仍然正常 resolve，没有读回确认就会表现为
「提示保存成功、值自己弹回去」。

最典型的成因是**该入口的 schema 里一个 volatile 字段都没有**：
`dsh-settings` 的 `volatileForm(schema)` 返回 `undefined` 时，`describe()` 会
**整个跳过这个入口**（而写入闸门抛 `Plugin entry \"<ns>\" has no volatile fields`）。
症状是：profile 的 `cordis.patch.yml` 里这个入口**永远不出现 `config:` 块**，
管理页上则显示「设置作用域不可写（本页只读）」。排查步骤：

1. 看 profile 的 `cordis.patch.yml` 里 `dsh-connect-qoder` 有没有 `config:` 块；
2. 确认 `lib/qoder.js` 的 `Config` 里至少有一个字段是 volatile（`asVolatile(...)`）；
3. 重启 DSH 让 Loader 重新 describe 一次（`describe()` 的结果是启动期缓存的）。

#### 图片能发出去要**两处**接线（少一处就报「不支持图片」）

模型层声明 `image` 只是第一层。含图消息真正发出去还要过 pi-ai 适配器里的第二层，
两层的报错长得几乎一样 —— **只测模型层是测不出来的**：

| 层 | 判定处 | 判据 | 缺了会看到 |
|---|---|---|---|
| 1 | 准入闸门 `dsh-api-session-controller/src/commands.ts` | `resolveModelInfo().inputModalities` 含 `image` | 横幅「当前模型不支持图片」 |
| 2 | pi-ai 适配器 `streamWithSnapshot`（`dsh-llm-pi-ai`） | `this.config.resolveAttachments?.()` 拿到宿主的 `attachments` 服务 | `pi-ai image input requires the durable attachment service` |

第 2 层靠 `new PiAiAdapter({ resolveAttachments: () => ctx.get('attachments') })` 接线。
Trae（`lib/trae.js`）与 WorkBuddy（`vendor/xdpool/lib/index.js`）一直有这一行，
**Qoder 漏了**（2026-10-11 补上，见 `lib/qoder.js` 的 `createQoderAdapter`）。
`test/qoder-provider.test.mjs` 的 2c 段用「替身附件服务 + 摘掉接线的负向对照」把它
钉住：负向对照必须复现上面那句报错，否则说明这段测试根本没走到那层判定。

另外每条 route 的 profile 要带图片预算三件套
（`maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes`，
与 Trae 的 `REQUEST_IMAGE_BUDGETS` 逐字同值）：前两个 pi-ai 侧有同值兜底、
缺了不崩，第三个缺了就是**完全没有总量闸门**。

图片块本身在本插件里逐字透传：pi-ai 会把它转成 OpenAI 形状的
`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`，
`normalizeQoderPayload` 只改 `content:null + tool_calls` 的 assistant 消息，
两条发包路径（手写 COSY / 官方 wasm 指纹）都带着完整 data URL
（`test/qoder-payload.test.mjs` 第 7 段逐字断言，含 `Content-Length`）。

#### 为什么图片勾选只能在这个页面做

宿主自己的「模型」设置页（`dsh-client-ui-settings-models`）只认
`llm-deepseek` / `llm-pi-ai` 两个 layout，其它 namespace 一律判成 `unknown`，
于是**逐模型的「图片」勾选框和提交按钮都不会出现**。三个插件 provider
（`llm-workbuddy-xdpool` / `dsh-connect-trae` / `dsh-connect-qoder`）因此都只能
用本插件自己的管理页改模型配置。

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

### 每日签到（活动线 `sash/api/v1/me/campaigns`）

签到**不在** `quota/usage` 那条线上，而在「活动（campaign）」线上 —— 服务端每天下发
一条 `CLAIM_BENEFIT` 活动，客户端去 `claim` 它。两条线的**请求头不一样**，这是本节
最重要的一个坑：

```
GET  {openapiBase}/sash/api/v1/me/campaigns                    # 列出今天的活动
POST {openapiBase}/sash/api/v1/me/campaigns/{campaignId}/claim # 领取（空 body，Content-Length: 0）

Accept: application/json
Authorization: Bearer <令牌>
Cosy-ClientType: 10        # ⚠️ 活动线是 10；额度线是 5
User-Agent: Qoder
```

| 事实 | 取证 |
|---|---|
| 活动线必须是 `Cosy-ClientType: 10` | 桌面端 bundle 里的常量与头构造器逐字是 `{clientType:10,…}` / `Authorization: Bearer …` + `Cosy-ClientType: String(10)` + `User-Agent: "Qoder"`（**裸头**，不发 `Cosy-Version` / `Cosy-MachineOS`） |
| **用 5 打活动线不会报错，只会"没有活动"** | 真机实测：同一账号同一时刻，`Cosy-ClientType: 5` → HTTP 200 `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}`；换成 `10` → `showCampaign:true` 且活动列表非空。**静默失效、日志里一行错都没有** —— 本插件曾据此得出「Qoder 没有签到」的错误结论 |
| 领取是**幂等**的 | 对已领活动再 POST：HTTP 200 `{"grantId":"…","status":"CLAIMED","replayed":true,…}`，而余额**一分不变**（实测 577 → 577），再列一次仍是 `CLAIMED` |
| 判据只能是 `replayed` | 重放响应里 `grantId` / `benefit.amount` 一应俱全，用「`grantId` 非空」判成败就会在已签的那天**谎报 +100** |
| 每天 10:00（UTC+8）刷新 | 活动窗口实测 `startAt 1791684000` / `endAt 1791770340`（**秒**，当毫秒会算到 1970 年），间隔 86340 秒；文案「每日 10:00（UTC+8）刷新，领取后 30 天有效」，详情页 `https://docs.qoder.cn/events/100credits` |
| 领到的是**活动积分** | `benefit {kind: CREDITS, amount: 100, modelScope {modelSeries {key: ALL_MODELS}}, validity {mode: RELATIVE_DAYS, days: 30}}`，落进 `addOnQuota`（见上一节的三池口径） |
| 列表里不止签到活动 | 还有 `actionType: VIEW_DETAILS` 的营销活动（如 Pro 首月翻倍）。只有 `CLAIM_BENEFIT` 才是签到，挑错就等于"签了营销活动"，所以挑选逻辑按 `actionType` 过滤、同状态取窗口更近的那条 |

`lib/qoder-campaign.mjs` 是这条线的全部实现（解析 / 挑选 / 领取 / 单账号编排），
`lib/index.js` 的 `POST …/qoder/checkin` 只做三件事：按 `accountId` 取**那一份**凭据 →
`checkinQoderAccount(credential)` → 成功时顺带读一次 `quota/usage` 并把余额记回池
（签完余额立刻是新的，卡片不用等下一拍 30 秒刷新）。

四条刻意保留的形态，每条都对应一种「做错了也不报错」：

| 形态 | 做反了会怎样 |
|---|---|
| 收 `accountId`，**不调** `pool.selectAccount()` | 「先切过去签名、再切回来」会在一段时间里把用户正在用的账号换掉 —— 而这只为领 100 Credits。用例断言：点完签到，`selectedAccountId` 一个字节都没写、`pool.acquire()` 仍返回原来那个账号 |
| 「今天已领」**只读列表、不发领取** | 白打一次上游领取，还会在日志里留下一次「重放」，让人以为有人手工签过 |
| 「今天已领」是 **`ok: true`** | 用户点一次看到红字「失败」，会去反复重试。界面把它说成「这个账号今天已经签过了（每天 10:00（UTC+8）刷新）」 |
| 没有活动是 `ok: false, code: 'no-campaign'` | 反过来把「活动已下线」说成「签到成功」，用户以为钱到了 |

**冷却中 / 已停用的账号也能签**：领的是活动 Credit，与这个账号当前能不能接请求无关，
上游也没有设备级门禁（一台机器可以给池里每个账号各签一次）。所以这颗按钮只受
「池正忙 / 只读」与「正在签另一个账号」限制。

**令牌不会自动续**（`qoder-pool.mjs` 的 `resolveFor()` 本期未接线 `deviceToken/refresh`），
所以令牌过期时签到如实返回 `code: 'unauthorized'` 并提示重新登录该账号 —— 不假装成功，
也不重试。

`test/qoder-campaign.test.mjs`（112 项：头与路径、两条链不许互相污染、活动/领取响应解析、
`replayed` 语义、`actionType` 挑选、网络层与失败码）与 `test/qoder-checkin-route.test.mjs`
（51 项：真凭据 + 真号池 + 真挂路由，断言答复正确**且当前账号没动**、两条链各自的 clientType、
已领不发领取、未知账号 404 / GET 405 / 外域 403 / 坏 JSON 400）守着它。

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

**② 目录链是 GET + 空 body（官方同形），且必须显式带 `Content-Length`。**

| 方法 / body | 结果 |
|---|---|
| POST | `400 Request method 'POST' not supported` |
| GET，不带 `Content-Length` | `403 / 101 Signature invalid` |
| GET，空 body + `Content-Length: 0`（`?Encode=1`） | **200，正常返回 14 个模型（官方形态，现用这条）** |
| GET，`{}` body + `Content-Length: 2` | 200（早期探测的形态，仍可用，已降级为兼容路径） |

第二行是最阴的坑：GET 发 body 时 Node 的 `http` 走 chunked 而**不自动加**
`Content-Length`，服务端读到空 body，与签名用的 body 不一致 → 摘要对不上 → 101。
更麻烦的是 Node 的 `fetch` **禁止** GET 带 body（直接抛错），所以这条链只能用
`node:http` 发（`sendQoderRequest`）。

> **为什么从 `{}` 换成了空 body**：`?Encode=1` 是「请用官方自定义 Base64 解码
> 请求体」的开关，发一个明文的 `{}` 时服务端会去解它并触发 Java 异常 —— 之前
> 之所以能过，是因为当时没带 `Encode`。现在查询串与官方 worker 一致
> （`Encode=1`），body 也必须跟着变成**空串**（`buildQoderModelsRequest` 里显式
> `body = ''`、`Content-Length: 0`），两边配套才对得上。

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
   未声明的子路径解析不了，Loader 加载 `kdczyz-dsh-model/qoder` 会失败。
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
- 「积分」与「使用记录」两个标签页已移除：采集接口（`/plugins/kdczyz-dsh-model/sample`
  与 `/history-summary`）仍在服务端保留，但管理页不再读取，落盘历史因此不再增长。
