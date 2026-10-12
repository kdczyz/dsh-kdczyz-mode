# 三平台共用文件

> 本目录内**全部是符号链接**，真实文件在 [`kdczyz-dsh-model/`](../../kdczyz-dsh-model/)。
> 改链接目标即改真实代码；**勿在此目录新建同名文件覆盖链接**。

---

## 一、为什么单列一个 `shared/`

按平台归档时最容易犯的错，是**把这些文件硬塞给某一个平台**。它们服务三侧，改名或分类都会误导：

| 链接 | 真实路径 | 行数 | 为什么共用 |
|---|---|---:|---|
| [`console.mjs`](console.mjs) | [`lib/console.mjs`](../../kdczyz-dsh-model/lib/console.mjs) | 5437 | **唯一事实来源**：三标签页管理页 + composer 积分胶囊，三平台 UI 混在一起（WB 79 / Trae 203 / Qoder 274 处） |
| [`client.js`](client.js) | [`lib/client.js`](../../kdczyz-dsh-model/lib/client.js) | 6092 | 浏览器端**唯一** bundle。**生成产物，勿手改**（115/233/290） |
| [`credit-store.mjs`](credit-store.mjs) | [`lib/credit-store.mjs`](../../kdczyz-dsh-model/lib/credit-store.mjs) | 373 | 积分与使用记录落盘（`credit-samples` / `history` / `daily` 三个 `.jsonl`） |
| [`volatile.mjs`](volatile.mjs) | [`lib/volatile.mjs`](../../kdczyz-dsh-model/lib/volatile.mjs) | 61 | 宿主 `volatile` 契约助手。**不这么做设置会被静默丢弃** |

---

## 二、共用测试（4 套）

同样跨平台，不归任何一侧。这 4 套是**各对应一次真实事故**的回归门禁：

| 链接 | 覆盖 | 防的是什么事故 |
|---|---|---|
| [`test/client-apply.test.mjs`](test/client-apply.test.mjs) | 仿浏览器执行 `client.js` 并真调 `apply` | **DSH 拒绝启动** —— 曾因 `client.js` 用了未声明的 `react` 导致 `apply` 抛 `ReferenceError`，cordis fiber 变 `failed` |
| [`test/console-render.test.mjs`](test/console-render.test.mjs) | 真正渲染三个 tab 与胶囊卡片（444 项） | **设置面板白屏** —— 曾因 `useEffect` 依赖数组写在 `const` 定义之前触发 TDZ |
| [`test/credit-store.test.mjs`](test/credit-store.test.mjs) | 数据层读写、去重、坏行容错 | 积分记录错乱 |
| [`test/host-assembly.test.mjs`](test/host-assembly.test.mjs) | 三个入口在目标 profile 下真的能加载 | 插件全部「未运行」 |

> 后两层（`client-apply` / `console-render`）在 [`tools/apply-wotr.sh`](../../tools/apply-wotr.sh) 里是**必须过**的。

---

## 三、改这些文件要注意

| 想做什么 | 怎么做 |
|---|---|
| 改设置面板界面 | 改 [`console.mjs`](console.mjs)，然后跑 [`scripts/gen-console-inline.mjs`](../../kdczyz-dsh-model/scripts/gen-console-inline.mjs) 重新内联进 [`client.js`](client.js) |
| 只想校验是否同步 | `node scripts/gen-console-inline.mjs --check`（门禁用的就是这个） |
| 手改 [`client.js`](client.js) | **不要**。它是生成产物，下次构建会被覆盖 |

---

## 四、相关文档

- 入口分工：[`kdczyz-dsh-model/lib/README.md`](../../kdczyz-dsh-model/lib/README.md)
- 共用文件警告：[`docs/platforms/README.md`](../../docs/platforms/README.md) §二
- 平台归档总览：[`platforms/README.md`](../README.md)
