# Qoder 平台文件

> 本目录内**全部是符号链接**，真实文件在 [`kdczyz-dsh-model/`](../../kdczyz-dsh-model/)。
> 改链接目标即改真实代码；**勿在此目录新建同名文件覆盖链接**。

---

## 一、这一侧是什么

把 **Qoder 桌面端**接成 DSH 的 provider。这是三侧里链路最长的一侧：
**号池 → 目录 → 反代 → loopback shim**，还要用官方 wasm 对齐出站指纹。

| 项目 | 值 |
|---|---|
| provider id | `qoder` |
| Loader entry id | `dsh-connect-qoder`（**不能改名**） |
| 入口模块 | [`qoder.js`](qoder.js) |
| 路由前缀 | `/plugins/kdczyz-dsh-model/qoder/*` |
| 登录方式 | **设备流**（PKCE + 轮询，**不开端口**） |
| 多账号来源 | **只能**逐个显式登录 |
| 凭据文件 | `.qoder-auth.cn.<accountId>.json` |
| 号池 `scan()` | **磁盘是唯一真相** |

> **为什么 Qoder 不能像另两家那样扫本机登录态**：Qoder 桌面端每个安装只保存**一份**登录，
> 再登一个账号会覆盖上一个 —— 无论怎么扫，永远只能扫出一个账号。
> 这是 [`qoder-auth.mjs`](qoder-auth.mjs) 存在的唯一理由。

---

## 二、反代链路（本平台的核心）

这是「反代」在三侧里最完整的一条链，按数据流顺序：

```
qoder-pool.mjs（选账号）
      ↓ 凭据
qoder-auth.mjs（拿 token）
      ↓
qoder-catalog.mjs（拉模型目录，带静态兜底）
      ↓
qoder-relay.mjs（★ 反代请求：COSY 签名 → 发请求 → 解双层信封 → 失败分类）
      ↓
qoder-shim.mjs（本地 loopback shim：OpenAI 协议 ↔ Qoder 私有协议）
      ↑
qoder-fingerprint.mjs（出站指纹对齐，驱动官方 wasm）
      ↕
qoder-credits.mjs（额度） · qoder-campaign.mjs（每日签到）
```

---

## 三、文件清单（9 个模块）

| 链接 | 真实路径 | 行数 | 作用 |
|---|---|---:|---|
| [`qoder.js`](qoder.js) | [`lib/qoder.js`](../../kdczyz-dsh-model/lib/qoder.js) | 1151 | 入口：把下列模块组装成 provider |
| [`qoder-relay.mjs`](qoder-relay.mjs) | [`lib/qoder-relay.mjs`](../../kdczyz-dsh-model/lib/qoder-relay.mjs) | 1012 | **★ 反代请求**：COSY 签名、发请求、解双层信封、失败分类 |
| [`qoder-fingerprint.mjs`](qoder-fingerprint.mjs) | [`lib/qoder-fingerprint.mjs`](../../kdczyz-dsh-model/lib/qoder-fingerprint.mjs) | 711 | 出站指纹对齐：运行时从本机安装提取并驱动官方 wasm |
| [`qoder-pool.mjs`](qoder-pool.mjs) | [`lib/qoder-pool.mjs`](../../kdczyz-dsh-model/lib/qoder-pool.mjs) | 660 | 多账号号池，`scan()` **以磁盘为唯一真相** |
| [`qoder-campaign.mjs`](qoder-campaign.mjs) | [`lib/qoder-campaign.mjs`](../../kdczyz-dsh-model/lib/qoder-campaign.mjs) | 602 | 每日签到（活动线 `me/campaigns → claim`），`Cosy-ClientType` 必须是 `10` |
| [`qoder-auth.mjs`](qoder-auth.mjs) | [`lib/qoder-auth.mjs`](../../kdczyz-dsh-model/lib/qoder-auth.mjs) | 533 | **设备流**登录（PKCE + 轮询）。**404 = 还没授权，必须继续轮询** |
| [`qoder-credits.mjs`](qoder-credits.mjs) | [`lib/qoder-credits.mjs`](../../kdczyz-dsh-model/lib/qoder-credits.mjs) | 513 | 积分额度查询（上游 `quota/usage`） |
| [`qoder-catalog.mjs`](qoder-catalog.mjs) | [`lib/qoder-catalog.mjs`](../../kdczyz-dsh-model/lib/qoder-catalog.mjs) | 360 | 模型目录 + 静态兜底（DSH 要求每行有正整数 `contextWindow`） |
| [`qoder-shim.mjs`](qoder-shim.mjs) | [`lib/qoder-shim.mjs`](../../kdczyz-dsh-model/lib/qoder-shim.mjs) | 285 | 本地 loopback shim（OpenAI 协议 ↔ Qoder 私有协议） |

---

## 四、测试（15 套）

`test/` 下 15 套，**全部是 [`tools/apply-wotr.sh`](../../tools/apply-wotr.sh) 的硬性门禁**：

| 测试 | 覆盖 |
|---|---|
| `qoder-auth` | 设备流登录 |
| `qoder-pool` | 号池读写 |
| `qoder-pool-route` | 号池管理页路由 |
| `qoder-dedup` | 账号去重 |
| `qoder-relay` | 签名、发请求、解信封、失败分类 |
| `qoder-payload` | `normalizeQoderPayload`（`content === null` 且有 `tool_calls`） |
| `qoder-fingerprint` | wasm 指纹四步顺序 |
| `qoder-shim` | loopback 透传 |
| `qoder-catalog` | 目录解析 + 兜底 |
| `qoder-credits` | 额度查询 |
| `qoder-campaign` | 签到 |
| `qoder-checkin-route` | 签到路由 |
| `qoder-provider` | provider 装配、`syncPoolConfig` |
| `qoder-chat` | 对话链路 |
| `qoder-streaming` | 流式（防「可流式响应被完整缓冲」回归） |

---

## 五、这一侧的坑（都有专门文档）

| 坑 | 表现 | 文档 |
|---|---|---|
| **老 502** | 不是限流，是**可流式响应被完整缓冲**（首字节 421ms → 5.3s） | [`qoder-502-rate-diagnosis.md`](../../docs/qoder-502-rate-diagnosis.md) |
| **工具消息 502** | `content === null` 且有 `tool_calls` 触发 | [`qoder-tool-message-502.md`](../../docs/qoder-tool-message-502.md) |
| **404 不是失败** | 设备流轮询中 404 = 用户还没点授权 | [`qoder-registration-diagnosis.md`](../../docs/qoder-registration-diagnosis.md) |
| **能力字段丢失** | `is_vl` 存在但**曾在解析层就没读** | [`upstream-model-audit-2026-10-11.md`](../../docs/upstream-model-audit-2026-10-11.md) |
| **`Cosy-ClientType`** | 签到必须 `10`，否则活动线不通 | 本目录 `qoder-campaign.mjs` |

其它特征：兜底表 9 行 vs **真机 14 行**；`contextBudgets` 是**死配置**；
`enabledModelIds` 声明了但**没用**；目录**不持久化**；仅启动时刷新一次；inflight 去重 ❌。

---

## 六、相关文档

- 文字清单：[`docs/platforms/qoder.md`](../../docs/platforms/qoder.md)
- 上游指纹取证：[`docs/upstream-fingerprint.md`](../../docs/upstream-fingerprint.md)
- 能力审计：[`docs/upstream-model-audit-2026-10-11.md`](../../docs/upstream-model-audit-2026-10-11.md)
- 平台归档总览：[`platforms/README.md`](../README.md)
