# dsh-wotr-console

把 **WorkBuddy** 与 **Trae** 两个桌面 App 的模型接进 DeepSeek Harness，
**合并为一个插件**。两个 App 各是一个独立的 provider 家族，
设置里共用一张四标签页管理页。

> 「WOTR」= **W**orkBuddy + T**rae**（WorkBuddy-O-Tr-Ae 的缩写读法）。

## 提供的 provider

| provider | 来源 | 说明 |
|---|---|---|
| `workbuddy-xdpool` | WorkBuddy 国内版 | 本机已登录账号构成自动容错的模型池 |
| `workbuddy-xdpool-global` | WorkBuddy 国际版 | 同上，两边账号互相独立 |
| `trae` | Trae 国内版 | 跟随 Trae 桌面端 / CLI 的登录态 |
| `trae-global` | Trae 国际版（Trae / TRAE SOLO） | 同上，按凭据自带的 `userRegion` 判定区域 |

四个 provider 可以同时使用；某一侧的改动不影响另一侧。

## 设置里的两个入口

| 入口 | 管什么 |
|---|---|
| **XD Pool** 卡片 | WorkBuddy 侧的**配置**：模型勾选、账号分配策略、积分自动化 |
| **Trae** 卡片 | Trae 侧的**配置**：区域开关、账号与 Token 刷新、模型勾选与测试 |
| **WOTR 管理** 管理页 | 两边的**查看**：四标签页 |

管理页的四个 tab：

| Tab | 内容 |
|---|---|
| WorkBuddy 账号 | 本机已登录账号、正常/冷却状态、额度、签到与连签、令牌到期 |
| 积分 | 当前总积分、每账号额度与积分包明细 |
| 使用记录 | 每日净变化 + 按账号的首次/最新对比（本地落盘数据） |
| Trae 账号 | Trae 各区域账号、选中状态、可用余额、签到 |

## 目录结构

```
dsh-wotr-console/
├── package.json
├── cordis.patch.yml           两个 Loader entry（见文件内注释，勿改 id）
├── lib/
│   ├── index.js               WorkBuddy 半边（provider 注册 + 管理页接口）
│   ├── trae.js                Trae 半边（上游 lib/index.js 原样并入）
│   ├── client.js              浏览器端唯一 bundle（三块内联，见下）
│   ├── console.mjs            四标签页源码（唯一事实来源）
│   └── credit-store.mjs       积分与历史记录落盘
├── vendor/
│   ├── xdpool/                WorkBuddy 模型池（MIT, XDTrees）
│   └── trae/client.js         Trae 浏览器端（MIT, dingminhua）
├── scripts/
│   ├── gen-console-inline.mjs 把 console.mjs 内联进 client.js（支持 --check）
│   ├── gen-trae-client.mjs    把 vendor/trae/client.js 内联进 client.js
│   └── gen-xdpool-client.mjs  把 vendor/xdpool/lib/client.js 内联进 client.js
├── test/                      三层单测（见下）
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
client-modules 不会为它建客户端条目，所以四标签页只加载一次。

## 构建（改了源码必须跑）

`lib/client.js` 是三块生成内容的容器，改动对应源码后要重新生成：

```sh
node scripts/gen-console-inline.mjs   # 改 lib/console.mjs 后（支持 --check 校验）
node scripts/gen-trae-client.mjs      # 改 vendor/trae/client.js 后
node scripts/gen-xdpool-client.mjs    # 改 vendor/xdpool/lib/client.js 后
```

**忘了跑不会报错，界面上也不会有变化** —— 用 `node scripts/gen-console-inline.mjs --check` 拦。

## 测试

```sh
node test/credit-store.test.mjs     # 14 项：积分/历史记录读写、去重、坏行容错
node test/client-apply.test.mjs     # 21 项：仿浏览器执行 client.js 并真正调用 apply
node test/console-render.test.mjs   # 31 项：真正渲染四个 tab，含空/坏数据与边界值
```

后两层各对应一次真实事故，**不能省**：

- **`client-apply`** 防「应用无法启动」：`client.js` 的 wrapper 里曾引用未声明的
  `react`，`apply` 抛 `ReferenceError` → cordis fiber 变 `failed` →
  宿主弹「应用无法启动或已意外停止」。只测「内联工厂能求值」抓不到。
- **`console-render`** 防「设置面板白屏」：组件曾用 `status?.accounts ?? []`
  取数组，接口返回非数组时 `.map` 在**渲染期**抛错 —— 启动阶段完全正常。
  合并后这一层还抓到过一次真实的 TDZ 缺陷：`useEffect` 的依赖数组
  在 `loadTrae` 的 `const` 定义之前就引用它，抛
  `Cannot access 'loadTrae' before initialization`，30 个渲染用例全灭。

## 凭据

- **WorkBuddy**：由 vendored xdpool 读取（用 `currentApi().pool` 拿**已解密**的凭证）
- **Trae**：只读桌面端 `User/globalStorage/storage.json` 或 CLI 的
  `trae-jwt-token`，刷新后写到 `$DSH_HOME/.trae-auth.<region>.json`

两者都**不把 token 写进 DSH 设置**，本仓库**不含任何凭据文件**。

## 已知局限

- 改动落在 `node_modules` 里，**插件升级会被覆盖**。
- 依赖各客户端的**私有接口**，官方改协议可能失效。
- 管理页的使用记录**只在打开页面时采集**（刻意不做后台轮询），
  所以每日净变化在「当天只在消耗后才打开过」时会显示为 0 而非负数。
