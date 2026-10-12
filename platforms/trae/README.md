# Trae 平台文件

> 本目录内**全部是符号链接**，真实文件在 [`kdczyz-dsh-model/`](../../kdczyz-dsh-model/)。
> 改链接目标即改真实代码；**勿在此目录新建同名文件覆盖链接**。

---

## 一、这一侧是什么

把 **Trae 桌面端**的模型接成 DSH 的 provider。与 WorkBuddy 侧最大的不同是
登录走**真正的 PKCE 授权码流程**，需要**本机回环 HTTP 端口**接回调。

| 项目 | 值 |
|---|---|
| provider id | `trae`、`trae-global` |
| Loader entry id | `dsh-connect-trae`（**不能改名**，改了已存配置会丢） |
| 入口模块 | [`trae.js`](trae.js) |
| 路由前缀 | `/plugins/dsh-connect-trae/*` |
| 登录方式 | **真** PKCE 授权码流程 |
| 本地端口 | **开**回环 HTTP 等回调 |
| 多账号来源 | 桌面端登录态 **+** 插件自有凭据 |
| 凭据文件 | `.trae-auth.<region>.<accountId>.json` |

> `trae.js` 是上游 `dsh-connect-trae@3.0.0` **逐字节并入、零改动**的。
> 原版归档在 [`archive-trae/`](../../archive-trae/)。

---

## 二、文件清单

| 链接 | 真实路径 | 行数 | 作用 |
|---|---|---:|---|
| [`trae.js`](trae.js) | [`lib/trae.js`](../../kdczyz-dsh-model/lib/trae.js) | 6096 | Trae 入口（含宿主侧 + 内联客户端半边） |
| [`trae-auth.mjs`](trae-auth.mjs) | [`lib/trae-auth.mjs`](../../kdczyz-dsh-model/lib/trae-auth.mjs) | 812 | PKCE 授权码流程 + 回环回调 |
| [`test/trae-auth.test.mjs`](test/trae-auth.test.mjs) | [`test/trae-auth.test.mjs`](../../kdczyz-dsh-model/test/trae-auth.test.mjs) | — | 登录流程 71 项 |
| [`test/trae-pool.test.mjs`](test/trae-pool.test.mjs) | [`test/trae-pool.test.mjs`](../../kdczyz-dsh-model/test/trae-pool.test.mjs) | — | 号池 46 项 |
| [`test/trae-checkin-route.test.mjs`](test/trae-checkin-route.test.mjs) | [`test/trae-checkin-route.test.mjs`](../../kdczyz-dsh-model/test/trae-checkin-route.test.mjs) | — | 签到路由 |

> `trae-auth.mjs` **也**被 [`workbuddy/index.js`](../workbuddy/index.js) 导入 ——
> 因为三平台的管理页后端集中在那一个模块里。这不改变本文件的平台归属。

---

## 三、这一侧的特殊之处

- **不需要打补丁**：上游做对了（三家中唯一不需要补的）。
- **能力字段**：上游 `multimodal` ✅；用户可手动补勾 `imageModelIds`。
- **上下文双窗口**：`dev` / `Max` 双档 + `contextBudgets`。
- **inflight 去重 ❌ 无**（审计时的状态）。
- **目录持久化**：`lastCatalog` 落 settings。
- **兜底表**：cn 4 行 / ai 7 行。
- **刷新时机**：启动 + DSH 触发 + 手动。
- **号池 `scan()` 语义**：**只合并不删除**（与 Qoder 的「磁盘即真相」相反）。
- **4 种安装发现**：能识别多个区域的 Trae 安装与网关。

---

## 四、相关文档

- 文字清单：[`docs/platforms/trae.md`](../../docs/platforms/trae.md)
- 上游指纹取证：[`docs/upstream-fingerprint.md`](../../docs/upstream-fingerprint.md)
- 能力审计：[`docs/upstream-model-audit-2026-10-11.md`](../../docs/upstream-model-audit-2026-10-11.md)
- 原版归档：[`archive-trae/README.md`](../../archive-trae/README.md)
- 单插件安装/回滚：[`tools/install-trae.sh`](../../tools/install-trae.sh)
- 平台归档总览：[`platforms/README.md`](../README.md)
