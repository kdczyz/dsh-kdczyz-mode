# 诊断：Qoder 模型跑不通（登录明明成功）

排查时间：2026-10-11 14:0x
宿主进程：PID 78206（2026-10-11 11:51:09 启动），profile = `~/.dsh/profiles/desktop`

## 一句话结论

**账号和上游链路都是好的；跑不通的是「qoder provider 根本没被注册进宿主」**，
而没注册的原因在宿主侧——`lib/qoder.js` 的 `import` 在 DSH 里解析不了：

```
@earendil-works/pi-ai                        → ERR_PACKAGE_PATH_NOT_EXPORTED
@earendil-works/pi-ai/api/openai-completions.lazy → ERR_PACKAGE_PATH_NOT_EXPORTED
@deepseek-ai/dsh-llm-pi-ai                   → MODULE_NOT_FOUND（profile 里没装）
```

## 证据链

### 1. 登录态、额度、目录、签名、上游全通（真机跑通）

用插件自己的模块（`qoder-pool` → `qoder-catalog` → `qoder-relay` → `qoder-shim`）
起真实 shim 打 `/v1/chat/completions`：

```
readAll 池内账号: 457220f4d511558e7b9f5ed5, f7661348faadd61e5b376b54
取号: 457220f4d511558e7b9f5ed5
目录模型数: 14 ["auto","qmodel_38max","qfmodel"]
shim: http://127.0.0.1:60524
正确 token -> {"status":200,"text":"收到","done":true}
错误 token -> {"status":401,...}          ← 鉴权链路也是活的
```

所以「账号已登录但模型跑不通」**不是**凭据、额度、签名或协议的问题。

### 2. 宿主侧装配断在两个 import 上

宿主 Electron 环境（`app.asar/dsh`）里解析：

| specifier | 结果 |
|---|---|
| `dsh-kdczyz-mode/qoder` | `MODULE_NOT_FOUND`（正常，应由 Loader 按 profile 解析） |
| `@earendil-works/pi-ai` | **`ERR_PACKAGE_PATH_NOT_EXPORTED`** |
| `@earendil-works/pi-ai/api/openai-completions.lazy` | **`ERR_PACKAGE_PATH_NOT_EXPORTED`** |
| `@deepseek-ai/dsh-llm-pi-ai` | profile `node_modules/` 里只有 `dsh-kdczyz-mode` 一个包 |

宿主 asar 里的 `@earendil-works/pi-ai@0.87.1` 的 `exports` 白名单是：

```json
{ ".": …, "./compat": …, "./providers/*": …,
  "./api/*": { "import": "./dist/api/*.js" }, … }
```

Node 的 `exports` 对 `./api/*` 的 `*` **不做「去掉 `.lazy`」的映射**，
所以 `./api/openai-completions.lazy` 这个子路径解析不了；
`dist/api/openai-completions.lazy.js` 文件本身是存在的。

### 3. 这个失败被静默吞掉了

`lib/qoder.js` 的 `apply()` 把全部注册放在 `void (async () => {…})()` 里，
末尾挂了 `.catch((error) => ctx.logger?.error?.(…))`。

**模块顶层 import 失败时 `apply` 根本不会被执行**，这层 catch 也跑不到 ——
于是现象只剩「重启后 qoder 依然跑不通」，没有任何可见报错。
`test/qoder-provider.test.mjs` 测不到它：单测有自己的 `node_modules`
（软链到 `/private/tmp/dsh-extract/full/dsh/node_modules`），
**测试环境的解析结果和宿主不一致**，这正是此前连续 10+ 次「重启后仍然不行」的根因。

### 4. 顺带解释另外两个现象

- **「管理页能看到账号、provider 却取不到号」**：管理页走 `lib/index.js` 的
  `qoderPoolSingleton`（实例 A，`dshHome: dshHomeDir()`），provider 走 `lib/qoder.js`
  自己的池（实例 B）。两个实例互不共享；`QoderCredentialStore` 在 `dshHome` 为空串时
  `readAll()` 直接返回 `[]`（`lib/qoder-pool.mjs:132`），池空 → 取号失败 → 503。
  与实例共享无关，是**每个实例都必须显式拿到 dshHome**。
- **Trae 半边同样 import 这两个包**（`lib/trae.js:2-5`），所以它大概率也一直没注册成功。

## 修复（已实施并验证）

**结论先行：`.lazy` 子路径不是问题。** 诊断时曾以为 `@earendil-works/pi-ai/api/openai-completions.lazy`
这个子路径违反宿主 `pi-ai@0.87.1` 的 `exports` 白名单 —— **那个推论是错的**：
宿主自带的 `dsh-llm-pi-ai` 自己就用同一个 specifier，且加载正常。
真正缺的只是**包实体本身**。包一旦落到磁盘上可解析的位置，`.lazy` 路径照常工作。

### 做法

新增 [`tools/link-host-deps.mjs`](../tools/link-host-deps.mjs)，把宿主自带的依赖
闭包装配到 profile 的解析范围：

| 位置 | 内容 |
|---|---|
| `<profile>/.dsh-runtime-deps/node_modules/` | 137 个包的**磁盘实体**（复制自宿主） |
| `<profile>/node_modules/@deepseek-ai/*`、`@earendil-works/*` | 指向上面那层的软链（9 个顶层包） |

三个关键点，缺一即失败：

1. **必须复制，不能软链到 asar。** asar 是单文件归档，软链过去 `lstat` 看着正常，
   但纯 Node 打开得到 `ENOTDIR`。实测软链方案在 Node 和 Electron 下**都**报
   `ERR_MODULE_NOT_FOUND`。
2. **持久层目录必须叫 `node_modules`。** 包之间互 import
   （`dsh-llm-pi-ai` → `dsh-launch-environment`、`schemastery` → `cosmokit`）
   靠向上查找 `node_modules` 解析；目录换个名字就连锁失败。
   实体单独放一层是为了不被下一次 `pnpm install` 清掉。
3. **闭包必须含 `peerDependencies`。** 宿主内包大量用 peer 互相声明
   （`dsh-llm-pi-ai` 的 11 个 peer 全是宿主内包），只收 `dependencies`
   会漏，且**安装时不报错**，要等真实加载才炸出来。

没有采用「改 import 路径」的方案：既然 `.lazy` 在宿主里合法，改它就是改错了地方。

### 验证

| 项 | 结果 |
|---|---|
| 三个 Loader 入口加载 + `apply` | 全部成功，零 `logger.error` |
| 注册结果 | `qoder` / `trae`+`trae-global` / `workbuddy-xdpool`+`-global`；discovery 三处齐全 |
| 端到端对话（走装配后的 profile 路径） | HTTP 200，回复「收到」，`[DONE]` 正常 |
| 装配耗时 / 体积 | 1.5 秒 / 51 MB |
| 幂等 | 二次执行跳过复制，软链重建 |

### 防回归

新增 [`test/host-assembly.test.mjs`](../dsh-kdczyz-mode/test/host-assembly.test.mjs)，
断言「从这个 profile 出发，三个入口能不能被加载」。它不复刻 `apply` 逻辑，
只回答宿主才会问的那个问题。**已反向验证**：临时移走 `@earendil-works/pi-ai`
→ 6 项变红，报错形态与真机故障一致。

[`tools/apply-wotr.sh`](../tools/apply-wotr.sh) 增加第 8 步（装配宿主内包），
且在装配**之后**跑一次 host-assembly —— 部署前跑没有意义，那时依赖还没落地。

### 原诊断中被推翻的两条

- ~~「`.lazy` 子路径违反 exports 白名单，要改用 `openai-completions.js`」~~
  —— 错。宿主自己的包就这么用，合法。
- ~~「Trae 半边大概率也一直没注册成功」~~ —— 对，但它与 Qoder 同因同解；
  修复后 Trae 的 `trae` / `trae-global` 两个 provider 也正常注册。

### 仍待处理

- **注册失败仍不够可见**：顶层 `import` 失败时 `apply` 不执行，
  `.catch(logger.error)` 打不出来。目前靠 host-assembly 测试与部署门禁兜底，
  但运行时（用户手动改坏 profile）仍会静默。值得补一条启动期自检日志。
