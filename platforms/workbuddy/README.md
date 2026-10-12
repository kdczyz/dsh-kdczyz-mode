# WorkBuddy 平台文件

> 本目录内**全部是符号链接**，真实文件在 [`kdczyz-dsh-model/`](../../kdczyz-dsh-model/)。
> 改链接目标即改真实代码；**勿在此目录新建同名文件覆盖链接**。

---

## 一、这一侧是什么

把 **WorkBuddy / CodeBuddy 桌面端**已登录的账号接成 DSH 的模型 provider，
通过本地反代转发到上游，并维护一个多账号模型池。

| 项目 | 值 |
|---|---|
| provider id | `workbuddy-xdpool`、`workbuddy-xdpool-global` |
| Loader entry id | `llm-workbuddy-xdpool`（**不能改名**） |
| 入口模块 | [`index.js`](index.js) |
| 路由前缀 | `/plugins/dsh-workbuddy-xdpool/*` |
| 登录方式 | 服务端发 authUrl → 浏览器登录 → **state 轮询**换 token（**不开本地端口**） |
| 多账号来源 | 扫本机**已登录**账号 |
| 凭据文件 | 由 vendored xdpool 自管 |

---

## 二、文件清单

| 链接 | 真实路径 | 行数 | 作用 |
|---|---|---:|---|
| [`index.js`](index.js) | [`lib/index.js`](../../kdczyz-dsh-model/lib/index.js) | 1396 | entry；⚠️ **同时承担三平台全部管理页路由，见下** |
| [`wb-auth.mjs`](wb-auth.mjs) | [`lib/wb-auth.mjs`](../../kdczyz-dsh-model/lib/wb-auth.mjs) | 555 | 登录协议（authUrl + state 轮询） |
| [`xdpool/`](xdpool) | [`vendor/xdpool/`](../../kdczyz-dsh-model/vendor/xdpool/) | 12 文件 | WorkBuddy 模型池实现（上游 1.7.1 并入，MIT） |
| [`test/wb-auth.test.mjs`](test/wb-auth.test.mjs) | [`test/wb-auth.test.mjs`](../../kdczyz-dsh-model/test/wb-auth.test.mjs) | — | 登录协议 64 项 |
| [`test/wb-fingerprint.test.mjs`](test/wb-fingerprint.test.mjs) | [`test/wb-fingerprint.test.mjs`](../../kdczyz-dsh-model/test/wb-fingerprint.test.mjs) | — | 出站指纹 |
| [`test/wb-pool-selected.test.mjs`](test/wb-pool-selected.test.mjs) | [`test/wb-pool-selected.test.mjs`](../../kdczyz-dsh-model/test/wb-pool-selected.test.mjs) | — | 选中账号语义 |

### `xdpool/` 明细

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主侧：账号发现、模型池、shim、签到/任务（上游代码） |
| `lib/client.js` | 浏览器侧「XD Pool」卡片，被内联进 `shared/client.js` |
| `lib/dsml-bridge.mjs` | **本 fork 新增**：DSML → tool_calls 桥接（四种方言） |
| `lib/bin.js` | 命令行 `dsh-workbuddy-xdpool doctor` 等 |
| `lib/index.d.ts` | 类型定义 |
| `README.md` / `LICENSE-ORIGINAL` | 上游说明与 MIT 声明（**不能删**） |

---

## 三、⚠️ `index.js` 不是 WorkBuddy 专属

[`lib/index.js`](../../kdczyz-dsh-model/lib/index.js) 同时 import 了
`trae-auth` / `qoder-auth` / `qoder-pool` / `qoder-campaign`，并托管三平台管理页的**全部后端路由**
（`Trae` 出现 20 次、`Qoder` 94 次）。

它落在这个文件夹，**只是因为 cordis 用 entry id `llm-workbuddy-xdpool` 注册 WorkBuddy provider**。
改它会影响另外两个平台 —— 动手前先确认改的是哪一侧。

---

## 四、这一侧的特殊之处

- **需要打补丁**：上游有 3 个真实 bug，补丁在 [`patches/`](../../patches/)。
- **能力字段**：上游 `supportsImages` ✅ 可直接解析；用户可手动补勾 `imageModelIds`。
- **上下文双窗口**：`contextBudgets` 只能**压低**，不能抬高。
- **inflight 去重** ✅（三家中唯一做了的）。
- **兜底表** 10 行。
- **刷新时机**：启动种子 + 手动刷新按钮。

---

## 五、相关文档

- 文字清单：[`docs/platforms/workbuddy.md`](../../docs/platforms/workbuddy.md)
- 上游指纹取证：[`docs/upstream-fingerprint.md`](../../docs/upstream-fingerprint.md)
- 给上游的问题报告：[`docs/upstream-issue-workbuddy.md`](../../docs/upstream-issue-workbuddy.md)
- 能力审计：[`docs/upstream-model-audit-2026-10-11.md`](../../docs/upstream-model-audit-2026-10-11.md)
- 平台归档总览：[`platforms/README.md`](../README.md)
