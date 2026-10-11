# Trae 平台文件清单

> 本文件是 [`dsh-wotr-console`](../../dsh-wotr-console/) 插件中 **Trae 侧**的
> 文件归档。三个平台的总览见 [`README.md`](README.md)。

| 项 | 值 |
|---|---|
| Loader entry id | `dsh-connect-trae` |
| 入口模块 | [`lib/trae.js`](../../dsh-wotr-console/lib/trae.js) |
| 注册的 provider | `trae`（国内版）、`trae-global`（国际版） |
| 路由前缀 | `/plugins/dsh-connect-trae/*` |
| 设置命名空间 | `trae` |
| 上游 | `dsh-connect-trae@3.0.0`（MIT，作者 dingminhua） |

> **上游宿主代码未做任何改动。** 它本身就把工具循环做对了，不需要打补丁
> —— 与 WorkBuddy 侧形成鲜明对比（见 [workbuddy.md](workbuddy.md)）。
> 合并时以 `lib/trae.js` **逐字节并入**，已核对零差异。
> 上游的浏览器半边（`vendor/trae/client.js`）**已整体移除**，Trae 配置页
> 改由本包自写（见 [`lib/console.mjs`](../../dsh-wotr-console/lib/console.mjs)）。

---

## 一、模块

### `lib/trae.js` —— Trae 半边入口

单文件约 6100 行，承载 Trae 的全部逻辑。内部按 region 参数化，同一份代码服务
国内 / 国际两条线。

**注册方式**（`lib/trae.js:6025`）：

```js
registration[region].adapter = region === "cn"
  ? ctx.llm.registerAdapter([TRAE_PROVIDER], trae.adapter)       // "trae"
  : ctx.llm.registerAdapter([TRAE_AI_PROVIDER], trae.adapter);   // "trae-global"
```

**区域与网关**（`REGION_GATEWAYS`）：

| region | chat | remote | pay |
|---|---|---|---|
| `cn` | `https://trae-api-cn.mchost.guru` | `https://solo.trae.cn/api/remote/v1` | `https://api.trae.cn` |
| `ai` | `https://coresg-normal.trae.ai` | `https://coresg-normal.trae.ai/api/remote/v1` | `https://growsg-normal.trae.ai` |

### `lib/trae-auth.mjs` —— Trae 登录协议

**与 WorkBuddy 完全不同**：Trae 是**真** PKCE 授权码流程，回调走**本机回环
HTTP**（WorkBuddy 是服务端发 authUrl + state 轮询，不开端口）。

| 项 | 值 |
|---|---|
| 凭据落盘 | `$DSH_HOME/.trae-auth.<region>.<accountId>.json`（**按账号一份文件**） |
| 兼容读取 | 旧格式 `.trae-auth.<region>.json` 仍被 store 当作**迁移源**读取 |
| 测试 | [`test/trae-auth.test.mjs`](../../dsh-wotr-console/test/trae-auth.test.mjs)（92 项） |

### 支持的安装与账号来源

自动发现本机 **4 种**安装的登录凭据：

| edition | macOS 应用名 | region |
|---|---|---|
| `cn` | `Trae CN` | `cn` |
| `sg` | `Trae` | `ai` |
| `solo` | `TRAE SOLO CN` | `cn` |
| `solo-sg` | `TRAE SOLO` | `ai` |

- 桌面端：读 `User/globalStorage/storage.json`（含 `state.vscdb` 兜底，
  `TRAE_STATE_DB_FILENAME = "state.vscdb"`）
- CLI：读 `~/.trae-cn/trae-jwt-token`（CLI 用 dotfile home，**不是**
  `Application Support`，只装 CLI 的机器没有 `storage.json`）
- 按凭证自带的 `userRegion` **自动判定区域**
- Linux / Windows 各有一套目录名探测表（macOS 拼写与 Linux 小写拼写都探，
  避免漏掉真实安装）

### 设备身份：**一个账号一个** `x-device-id`

上游把签到结算到**设备**上，不是账号上 —— 同一个 `x-device-id` 上换第二个账号，答复是
`code: 9095`（这台设备今天已经签过）。2026-10-12 本机实测：

| 账号 | 真机 deviceId | 派生 deviceId |
|---|---|---|
| 1412（已签） | `code: 0` | `code: 0` |
| 用户9773022806（未签） | **`code: 9095` 设备已用** | **`code: 0` 成功** |

`x-machine-id` 对结果**完全没有影响**（换掉它，未签账号照样 `9095`），所以门禁只认
`x-device-id`。

结论：设备身份不能全池共用，否则整台机器一天只可能有一次入账。每个账号由
`TraeCredentialStore#deviceIdOf` 领一个自己的 id：

- 派生方式：`sha256("trae-device\0" + accountId)` 取前 32 位，`1e14 + n % 9e14` → **15 位、首位非零的纯数字** ——
  与官方 `icube-dc` 键同形（16 位纯数字），也与参考脚本 `gen_device_id()`
  （`randbelow(9e14) + 1e14`）同宽同规则；
- **刻意用派生而不是随机**：随机 id 只有在「记住它」之后才可用 —— 参考脚本把它写进账号状态文件、
  之后每次读回，于是「写盘与读盘都成功」成了正确性的**前提**。这个前提静默失效时，账号会每天换
  一台设备，上游看到的是陌生机器，风险落在账号上却无人报错。派生没有这个前提：同一个
  `accountId` 在不同注册表、不同 `$DSH_HOME`、不同机器上算出来都是同一串（有断言守着）。下面两处
  持久化因此只是**保险**，不是正确性的依据；
- 持久化两处，互为兜底：账号**自己的凭据文件**里的 `deviceId` 字段（`rememberDeviceId` 首次使用时写回，
  随 token 一起迁移），以及 `$DSH_HOME/trae-devices.json` 的 `accountId → deviceId` 映射
  （桌面登录态的账号没有可写的凭据文件，全靠这份注册表；丢了它上游每天会看到一台新机器）；
- 未知 `accountId` 返回 `undefined` —— 不凭空捏造一个身份给打错的帐号。

> **代价（刻意的）**：账号的设备身份不再是桌面安装那个 id，Trae 自己日志里的
> `X-Device-Id` 与本插件发的对不上。换来的是同机每个登录都能签到自己那份。
>
> 回归测试：[`test/trae-auth.test.mjs`](../../dsh-wotr-console/test/trae-auth.test.mjs)
> 的「多账号」一组（每账号一个 id、重启后不变、凭据文件优先于注册表、未知账号不编造、
> 换一个 `$DSH_HOME` 仍算出同一 id）。

#### 换一台电脑

**能直接用，不需要额外条件**：`deviceId` 由 `accountId` 派生，而 `accountId =
sha256(edition + "\0" + userId)` —— `userId` 与 `edition` 都不是机器相关的量，所以新机器算出的 id
与旧机器相同。签到路径也**不碰** `storage.json`：`deviceIdOf` 只在凭据里没有 `deviceId` 时才派生，
与桌面安装的 `icube-dc` 键无关（新机器上没装官方客户端照样能签）。`$DSH_HOME` 只读也不影响 ——
派生值本来就不依赖写盘成功。

迁移时**建议连注册表一起带走**：

```bash
# 旧机 → 新机：凭据（deviceId 就在里面）+ 注册表
cp ~/.dsh/.trae-auth.*.json ~/.dsh/trae-devices.json <新机>/.dsh/
```

| 迁移内容 | 新机上的设备身份 |
|---|---|
| 凭据 + `trae-devices.json` | 与旧机**逐字一致**（实测 `000000771046875` / `000002488226875`） |
| 只带凭据 | 一般也一致（凭据里就存着 `deviceId`）；凭据也丢了才按当前算法重新派生 |

> **一处已知例外**：本机这两个账号的 id 是**首位非零规则之前**的历史值，注册表把它们钉住了，
> 所以「旧机读注册表、新机重新派生」会得到 `100000771046875`（同一串数字，首位换成 `1`）。
> 对上游来说是另一台设备：这一天在新机上照样能签，只是设备身份变了。要避免就带上注册表。
> 新建账号没有这个问题 —— 两边都按首位非零规则算，天然一致。


### `icube-dc` 多候选：必须取**纯数字**的那个键

`x-device-id` 不是一个无关紧要的头：**签到领取按它结算「这台设备今天还能不能领」**。
同机官方客户端日志（`TRAE SOLO CN`，2026-10-10）里它带的 `X-Device-Id` 是
`2833884447254011` —— 一个 16 位纯数字。

`storage.json` 里 `iCubeAuthInfo://icube-dc:` 可以有**多个**键，新版 SOLO 安装就是
两个：上面那个纯数字的，加上 `has_device_id_updated_to_aha` 写下的迁移名
`aha-e4b8d545e2fb07ee4cd01c966d4264ab`。

> **曾经踩的坑（已修，2026-10-12）**：解析函数写的是 `ids.length === 1 ? ids[0] :
> undefined`，于是「两个键」的机器上 `deviceId` 静默回落到
> `telemetry.devDeviceId` 这个 UUID。后果是**只有领取会失败**：
>
> | 用的 id | `status` 查询 | `claim` 领取 |
> |---|---|---|
> | 纯数字 `icube-dc` 键 | 200，正常 | `code: 0`，到账 |
> | `telemetry.devDeviceId`（UUID） | 200，**看起来一样正常** | `code: 9074` |
>
> `9074` 的文案是「当前参与用户太多，请稍后再试」——一句把人引向「等会儿再试」的
> 假话，真实原因是设备 id 不被认。同机两账号、两套设备头全部复现 `9074`，换成纯数字
> id 立刻 `code: 0`；把 `x-device-id` 整个去掉则答 `9004`（参数不合法）。
>
> 选择规则取官方客户端自己的行为：**纯数字者优先**，没有纯数字候选时取首个（单键的
> 旧安装行为不变）。回归测试在
> [`test/trae-auth.test.mjs`](../../dsh-wotr-console/test/trae-auth.test.mjs)
> 的多候选断言里。

---

## 二、模型目录

| 机制 | 说明 |
|---|---|
| 静态兜底 | `FALLBACK_TRAE_MODELS`（cn）/ `FALLBACK_TRAE_MODELS_AI`（ai） |
| 持久化 | 存 settings 的 `lastCatalog` 字段（旧字段 `models` 仍被读取） |
| 刷新时机 | 启动 + **DSH 触发** + 手动（比 Qoder 多一条 DSH 触发，见 [qoder.md](qoder.md) 的能力对照表） |
| 界面入口 | 管理页「Trae 配置」标签页的「**从 Trae 刷新**」 |
| 一键测试 | 「一键测试启用模型」 |

> 兜底表的每一行 **必须带正整数 `contextWindow`**：DSH 会拒绝没有可用上下文的
> adapter（`INVALID_MODEL_CONTEXT`），且该失败是**按 provider 计**的 —— 一行坏
> 数据会让整个 region 下线。兜底表恰好在"无实时目录可用"（该区域没装、未登录、
> 刷新失败）时被服务，所以缺字段是致命的而不是装饰性的。

---

## 三、号池

Trae 侧的账号池（[`lib/trae.js`](../../dsh-wotr-console/lib/trae.js) 内的
`TraeAccountPool` / `TraeCredentialStore`）是**按 XD Pool 的做法**实现的，
三种分配策略（`priority` / `round-robin` / `balanced`）与逐模型冷却一致。

### 为什么刷新 token 要按账号分文件

与 Qoder 的「磁盘是唯一真相」形成对照：

| | Trae | Qoder |
|---|---|---|
| 账号来源 | 桌面端登录态 **+** 插件自有凭据 | **只有**插件自有凭据文件 |
| 扫描语义 | **只合并不删除** | 以磁盘为准，文件没了就出池 |

Trae 用「只合并不删除」，是因为它的账号有一部分来自桌面端登录态 ——
那些账号不会因为插件侧删了个文件就消失。

### 签到

Trae 签到是**按账号**的（每张卡签自己那个账号，不切换正在服务的账号）：
靠「拿那个账号的凭据走同一条流程」实现。

| 端点 | 用途 |
|---|---|
| `POST /trae/api/v2/ug/checkin_credits/status` | 查询签到状态 |
| `POST /trae/api/v2/ug/checkin_credits/claim` | 领取 |

---

## 四、路由

| 路由 | 注册位置 |
|---|---|
| `GET /plugins/dsh-connect-trae/usage` | `TRAE_USAGE_PATH`（`lib/trae.js:4411`） |
| `POST /plugins/dsh-connect-trae/checkin` | `TRAE_CHECKIN_PATH`（`lib/trae.js:4453`） |
| `POST /plugins/dsh-wotr-console/trae/login/start` | `lib/index.js`（浏览器登录添加账号） |
| `GET /plugins/dsh-wotr-console/trae/login/status` | 同上 |
| `POST /plugins/dsh-wotr-console/trae/login/cancel` | 同上 |

> **前缀有两套，别搞混**：`/plugins/dsh-connect-trae/*` 是 Trae 半边自己按
> 上游原 id 注册的（改名会让卡片变只读）；`/plugins/dsh-wotr-console/*` 是
> 合并后管理页自己的接口，用合并后的包名。

---

## 五、测试

| 文件 | 项数 | 守什么 |
|---|---|---|
| [`test/trae-auth.test.mjs`](../../dsh-wotr-console/test/trae-auth.test.mjs) | 71 | 登录（PKCE + 回环回调、自动回调）、凭据落盘 |
| [`test/trae-pool.test.mjs`](../../dsh-wotr-console/test/trae-pool.test.mjs) | 46 | 账号池与凭据落盘 |
| [`test/trae-checkin-route.test.mjs`](../../dsh-wotr-console/test/trae-checkin-route.test.mjs) | — | 按账号签到路由 |

---

## 六、凭据

| 项 | 路径 |
|---|---|
| 只读来源 | 桌面端 `User/globalStorage/storage.json` 或 CLI `~/.trae-cn/trae-jwt-token` |
| 刷新后写入 | `$DSH_HOME/.trae-auth.cn.json` 与 `$DSH_HOME/.trae-auth.ai.json`（按账号则为 `.trae-auth.<region>.<accountId>.json`） |
| **不写入** | DSH 设置（凭据不进 settings） |

> 本仓库**不含任何凭据文件**（只含插件代码）。

---

## 七、本机状态（2026-10-09 实测）

| 检查项 | 结果 |
|---|---|
| 上游版本 | `dsh-connect-trae@3.0.0`（MIT，作者 dingminhua） |
| 合并后位置 | `lib/trae.js`（与原文件 diff 为空）✓ |
| provider 注册 | `trae`、`trae-global` 都在 DSH 里 ✓ |
| 登录态 | `signed-in`，账号 `1412`，来源 `TRAE SOLO CN`（edition `solo`），区域 `cn` ✓ |
| 令牌到期 | 2026-10-17（未过期，自动续期）✓ |
| 可用额度 | 总 2900，可用 2383.77 ✓ |

> 上表是 2026-10-09 的快照，**不是实时值**。实时值用管理页或
> `curl "http://127.0.0.1:19387/plugins/dsh-connect-trae/usage?region=cn"` 查。

---

## 八、为什么 Trae 不需要像 WorkBuddy 那样修

| | Trae | WorkBuddy |
|---|---|---|
| 工具循环实现 | 把上游返回的结构化 `tool_calls` **解析出来**再交给 DSH 本地执行 | 把上游字节**原样转发**，且工具定义在中间层被丢掉 |
| 结果 | 工具调用正常，**无需补丁** | 模型只能自编 DSML 标记，工具从不执行 |

这条差异正是 [workbuddy.md](workbuddy.md) 里那三个补丁存在的原因。

---

## 九、相关

- 三平台总览：[`docs/platforms/README.md`](README.md)
- WorkBuddy 侧：[`docs/platforms/workbuddy.md`](workbuddy.md)
- Qoder 侧：[`docs/platforms/qoder.md`](qoder.md)
- 入口分工与共用模块：[`dsh-wotr-console/lib/README.md`](../../dsh-wotr-console/lib/README.md)
- 合并前的单插件归档：[`dsh-connect-trae/`](../../dsh-connect-trae/)
- 恢复单插件形态：[`tools/install-trae.sh`](../../tools/install-trae.sh)
