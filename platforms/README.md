# 平台归档视图（platforms/）

本目录把 [`kdczyz-dsh-model/`](../kdczyz-dsh-model/) 里**三平台的反代/接入文件**按平台分开摆放，
每个平台一个文件夹，另有一个 `shared/` 放不归任何单一平台的文件。

> ⚠️ **这里全部是符号链接（symlink），不是文件副本。**
> 真实代码仍然只有一份，在 [`kdczyz-dsh-model/`](../kdczyz-dsh-model/) 里。
> 改这里的链接目标 = 改真实代码；**不要在本目录下新建同名真实文件覆盖链接**。

---

## 一、为什么用链接而不是搬移

`kdczyz-dsh-model` 的目录形状**被三处硬性约束**锁死，物理搬移会直接让插件停摆：

| 约束 | 位置 | 搬移后会怎样 |
|---|---|---|
| 三个 Loader entry 按**包名**解析模块 | [`cordis.patch.yml`](../kdczyz-dsh-model/cordis.patch.yml) | entry 解析不到 → 插件在管理页显示「未运行」 |
| 四个 `exports` 子路径指向 `lib/` 固定路径 | [`package.json`](../package.json) | `kdczyz-dsh-model/trae` 等导入失败 |
| 25 套测试用**相对路径** `../lib/...` 导入 | [`test/`](../kdczyz-dsh-model/test/) | 部署硬门禁全红，`apply-wotr.sh` 直接停 |

链接方案让「按平台看文件」和「跑得起来」同时成立：**链接不参与 Node 模块解析**，
测试与部署路径完全不受影响（已验证：43 个链接全部有效，25 套测试全绿）。

---

## 二、目录怎么读

```
platforms/
├── workbuddy/     WorkBuddy 侧 （1 入口 + 1 登录 + vendored 模型池 + 3 测试）
├── trae/          Trae 侧      （1 入口 + 1 登录 + 3 测试）
├── qoder/         Qoder 侧     （1 入口 + 8 模块 + 15 测试）
└── shared/        三平台共用   （4 模块 + 4 测试）
```

每个平台文件夹内：`test/` 子目录放该平台专属测试。

---

## 二·五、📌 命名规则：本目录名不带前缀，归档带 `archive-`

根目录同时存在**两类**与平台同名的东西，靠前缀区分，**不要看错**：

| 路径 | 性质 | 改名/改代码有用吗 |
|---|---|---|
| `platforms/workbuddy/` `platforms/trae/` `platforms/qoder/` | **链接视图** → 指向活跃代码 | ✅ 改链接目标 = 改真实代码 |
| `archive-workbuddy/` `archive-trae/`（在仓库根） | **归档**：合并前的旧插件源码 | ❌ **没有用**，且部署脚本会主动清理 |

规则一句话：**带 `archive-` 的是历史留存，不带前缀的 `platforms/*` 才指向在跑的代码。**

> 这条规则是修出来的：早期归档目录直接叫 `workbuddy/` `trae/`，与本目录同名，
> 导致 `platforms/trae/README.md` 里一句 `../workbuddy/index.js` 误指到**归档**而不是活跃代码。
> 加上 `archive-` 前缀后重名消除，该链接已修正为指向 `kdczyz-dsh-model/lib/index.js`。

---

## 三、平台归属总表

归属依据是**实际 import 关系**与关键字计数（下表数字为该文件内平台名出现次数），
不是按文件名猜的。

### `workbuddy/`

| 链接 | 真实路径 | 行数 | 归属依据 |
|---|---|---:|---|
| `index.js` | [`lib/index.js`](../kdczyz-dsh-model/lib/index.js) | 1396 | entry id `llm-workbuddy-xdpool`；⚠️ **名实不符，见下** |
| `wb-auth.mjs` | [`lib/wb-auth.mjs`](../kdczyz-dsh-model/lib/wb-auth.mjs) | 555 | 仅 `lib/index.js` 导入；WorkBuddy 8 / Trae 1 / Qoder 0 |
| `xdpool/` | [`vendor/xdpool/`](../kdczyz-dsh-model/vendor/xdpool/) | 12 文件 | 上游 WorkBuddy 模型池，WorkBuddy 392–158 次、另两家 0 次 |
| `test/wb-auth` · `wb-fingerprint` · `wb-pool-selected` | [`test/`](../kdczyz-dsh-model/test/) | — | 名字即平台，专测 WorkBuddy |

### `trae/`

| 链接 | 真实路径 | 行数 | 归属依据 |
|---|---|---:|---|
| `trae.js` | [`lib/trae.js`](../kdczyz-dsh-model/lib/trae.js) | 6096 | entry id `dsh-connect-trae`；Trae 522 次、Qoder 0 次 |
| `trae-auth.mjs` | [`lib/trae-auth.mjs`](../kdczyz-dsh-model/lib/trae-auth.mjs) | 812 | 仅 `lib/index.js` 导入；Trae 46 次 |
| `test/trae-auth` · `trae-pool` · `trae-checkin-route` | [`test/`](../kdczyz-dsh-model/test/) | — | 专测 Trae |

### `qoder/`

| 链接 | 真实路径 | 行数 | 作用 |
|---|---|---:|---|
| `qoder.js` | [`lib/qoder.js`](../kdczyz-dsh-model/lib/qoder.js) | 1151 | entry：设备流号池 + 反代组装（Qoder 103 次） |
| `qoder-relay.mjs` | [`lib/qoder-relay.mjs`](../kdczyz-dsh-model/lib/qoder-relay.mjs) | 1012 | **反代请求**：COSY 签名、发请求、解双层信封、失败分类 |
| `qoder-shim.mjs` | [`lib/qoder-shim.mjs`](../kdczyz-dsh-model/lib/qoder-shim.mjs) | 285 | 本地 loopback shim（OpenAI 协议 ↔ Qoder 私有协议） |
| `qoder-fingerprint.mjs` | [`lib/qoder-fingerprint.mjs`](../kdczyz-dsh-model/lib/qoder-fingerprint.mjs) | 711 | 出站指纹对齐：驱动官方 wasm |
| `qoder-auth.mjs` | [`lib/qoder-auth.mjs`](../kdczyz-dsh-model/lib/qoder-auth.mjs) | 533 | 设备流登录（PKCE + 轮询，不开端口） |
| `qoder-pool.mjs` | [`lib/qoder-pool.mjs`](../kdczyz-dsh-model/lib/qoder-pool.mjs) | 660 | 多账号号池，`scan()` 以磁盘为唯一真相 |
| `qoder-catalog.mjs` | [`lib/qoder-catalog.mjs`](../kdczyz-dsh-model/lib/qoder-catalog.mjs) | 360 | 模型目录 + 静态兜底 |
| `qoder-credits.mjs` | [`lib/qoder-credits.mjs`](../kdczyz-dsh-model/lib/qoder-credits.mjs) | 513 | 积分额度查询 |
| `qoder-campaign.mjs` | [`lib/qoder-campaign.mjs`](../kdczyz-dsh-model/lib/qoder-campaign.mjs) | 602 | 每日签到（`Cosy-ClientType` 必须为 `10`） |
| `test/qoder-*.test.mjs`（15 套） | [`test/`](../kdczyz-dsh-model/test/) | — | 专测 Qoder |

### `shared/` —— ⚠️ 不属于任何单一平台

| 链接 | 真实路径 | 行数 | 为什么不能归给某一侧 |
|---|---|---:|---|
| `console.mjs` | [`lib/console.mjs`](../kdczyz-dsh-model/lib/console.mjs) | 5437 | **唯一事实来源**：三标签页管理页 + composer 胶囊，WB 79 / Trae 203 / Qoder 274 交织 |
| `client.js` | [`lib/client.js`](../kdczyz-dsh-model/lib/client.js) | 6092 | 浏览器端**唯一** bundle，生成产物勿手改（115/233/290） |
| `credit-store.mjs` | [`lib/credit-store.mjs`](../kdczyz-dsh-model/lib/credit-store.mjs) | 373 | 积分与使用记录落盘，三平台共用 |
| `volatile.mjs` | [`lib/volatile.mjs`](../kdczyz-dsh-model/lib/volatile.mjs) | 61 | 宿主 `volatile` 契约助手，被 `qoder.js` 用 |
| `test/client-apply` · `console-render` · `credit-store` · `host-assembly` | [`test/`](../kdczyz-dsh-model/test/) | — | 跨平台门禁，各对应一次真实事故 |

---

## 四、⚠️ `workbuddy/index.js` 其实不是 WorkBuddy 专属

这是本仓库最容易搞错的一点，**按平台归档时务必注意**：

[`lib/index.js`](../kdczyz-dsh-model/lib/index.js) 看着像 WorkBuddy 入口，实际同时承担
**三平台管理页的全部后端路由**（`Trae` 20 次、`Qoder` 94 次），并 import 了
`trae-auth` / `qoder-auth` / `qoder-pool` / `qoder-campaign`。

它出现在 `workbuddy/` 里，是因为 **cordis 用它的 entry id `llm-workbuddy-xdpool` 注册
WorkBuddy provider**；但改它会影响三个平台。**动它之前先确认改的是哪一侧的逻辑。**

同类警告也写在 [`docs/platforms/README.md`](../docs/platforms/README.md) §二。

---

## 五、验证这套视图仍然成立

```sh
# 1) 链接无断链（应为 43，且无 BROKEN 输出）
cd platforms && find . -type l | wc -l
for l in $(find . -type l); do [ -e "$l" ] || echo "BROKEN: $l"; done

# 2) 插件本身未被影响（25 套测试全绿 = 部署门禁通过）
cd ../kdczyz-dsh-model && npm test
```

---

## 六、相关文档

| 文档 | 内容 |
|---|---|
| [`docs/platforms/`](../docs/platforms/) | 三平台**文字**清单（能力对照、登录差异、诊断） |
| [`docs/FILES.md`](../docs/FILES.md) | 全仓库逐文件作用速查 |
| [`kdczyz-dsh-model/lib/README.md`](../kdczyz-dsh-model/lib/README.md) | 三个入口分工与共用模块 |
| [`kdczyz-dsh-model/cordis.patch.yml`](../kdczyz-dsh-model/cordis.patch.yml) | 三个 Loader entry（entry id 不能改名） |
