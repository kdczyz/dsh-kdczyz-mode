# 上游 issue 正文（可直接粘贴给 dsh-workbuddy-console 作者）

> 说明：本文件是**给插件作者的问题报告草稿**，含复现步骤、根因定位与证据。
> 已脱敏：不含任何 token、账号 uid 或本机路径中的用户名。
> 三个问题按严重程度排列，第 1 个会让 WorkBuddy 模型的**工具调用完全失效**。

---

## 标题

**[Bug] WorkBuddy 模型在 DSH 中工具调用完全失效：请求未携带 `tools`，且 5.6+ 凭证未解密导致误报账号失效**

## 环境

| 项 | 值 |
|---|---|
| 插件 | `dsh-workbuddy-console` 2.0.48（内嵌 `vendor/xdpool`） |
| DSH | `0.2.0-rc.2`（desktop profile，macOS arm64） |
| 宿主依赖 | `@earendil-works/pi-ai` 0.87.1、`@deepseek-ai/dsh-llm-pi-ai` 0.2.0-rc.2 |
| WorkBuddy 桌面端 | 5.7.6（已登录，凭证文件为 `$wbEncrypted` 信封格式） |
| 复现模型 | `deepseek-v4.1-flash`（`hy3` / `glm-5.3` / `kimi-k2.6` 同样复现） |

---

## Bug 1（严重）：工具定义没发到上游，模型只能瞎编调用格式

### 现象

选 WorkBuddy 的模型对话时，助手回复里出现**工具调用标记当正文**，例如：

```
I'll search for this plugin.
<tool_calls><invoke name="bash"><parameter name="command" string="true">ls ...</parameter></invoke></tool_calls>
```

DSH 只认原生 `tool_calls`，于是把这段标记当普通文本渲染（用户看到的就是"乱码"），**并且工具永远不会执行**。

### 复现步骤

1. 在 DSH 里把会话模型切到 `workbuddy-xdpool/deepseek-v4.1-flash`。
2. 发一句会触发工具的话，比如「跑一下 echo OK」。
3. 结果：回复里是 `DSML` 标记文本，没有工具卡片。
4. 看插件自己的请求结构日志 `~/.dsh/.workbuddy-xdpool/upstream-request-shape.log`：

```
keys=model|messages|stream|stream_options|store|max_completion_tokens
                                                          ^^^^^ 没有 tools
```

### 根因

pi-ai 解析请求时走的是：

```
api.stream(model, context, options)
  -> resolveTranscript(context, supportsMidConvoSystemMessages)
       -> collapseSystemMessages(context)
```

而 `collapseSystemMessages()` **只用 `context.messages` 重建 transcript**：

```js
function collapseSystemMessages(context) {
  const head = getCurrentSystemMessage(context.messages);
  const messages = context.messages.filter((m) => m.role !== "system");
  return { messages: head ? [head, ...messages] : messages };   // 只返回 messages
}
```

也就是说**顶层的 `context.systemPrompt` 和 `context.tools` 会被直接丢掉**。pi-ai 只认另一种形状——把提示词和工具折进**首条 `role: "system"` 消息**（`content` 放提示词、`toolsAdded` 放工具声明）——这正是 pi-ai 自己的 `normalizeContext()` 做的事：

```js
export function normalizeContext(context) {
  const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
  const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
  return { messages };
}
```

pi-ai 的 `Models` 包装层会替调用方做这步归一化，但本插件是在 `hostCompatibleApi()` 里**直接调用 `api.stream()`**，绕过了 `normalizeContext()`，于是工具声明在到达 `collapseSystemMessages()` 之前就已经不在 transcript 里了。

**最小验证**（`@earendil-works/pi-ai/dist/utils/transcript.js`）：

```js
const T = { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } };

// 当前插件产出的形状
const ctx = { systemPrompt: "SYS", messages: [{ role: "user", content: "hi" }], tools: [T] };
const norm = resolveTranscript(ctx, false);                       // => { messages: [...] }
resolveTranscriptTools(norm.messages, true).requestTools.length;  // => 0   ← 工具丢失

// pi-ai 期望的形状
const fixed = { messages: [{ role: "system", content: "SYS", toolsAdded: [T] }, { role: "user", content: "hi" }] };
const norm2 = resolveTranscript(fixed, false);
resolveTranscriptTools(norm2.messages, true).requestTools.length; // => 1   ← 正常
```

### 建议修复

在 `legacyContext()` 里把结果折成 pi-ai 认的形状（等价于在 `hostCompatibleApi()` 里先跑一次 `normalizeContext`）：

```js
function legacyContext(context) {
  if (typeof context !== "object" || context === null) return context;
  const messages = context["messages"];
  if (!Array.isArray(messages)) return context;

  const tools = new Map();
  for (const tool of Array.isArray(context["tools"]) ? context["tools"] : []) {
    if (tool && typeof tool.name === "string") tools.set(tool.name, tool);
  }

  const prompt = [];
  if (typeof context.systemPrompt === "string" && context.systemPrompt !== "") prompt.push(context.systemPrompt);

  const kept = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    if (message.role !== "system") { kept.push(message); continue; }
    for (const tool of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : []) {
      if (tool) tools.delete(tool.name);
    }
    for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
      if (tool && typeof tool.name === "string") tools.set(tool.name, tool);
    }
    const text = transcriptText(message.content);
    if (text !== "") prompt.push(text);
  }

  const initial = {
    role: "system",
    content: prompt.join("\n\n"),
    ...(tools.size === 0 ? {} : { toolsAdded: [...tools.values()] }),
    timestamp: 0
  };
  return { messages: [initial, ...kept] };
}
```

### 修复后的实测结果

- 请求日志变成 `keys=...|tools` ✓
- 让模型用 `write` 工具写文件 → **去磁盘核对内容**，4 个模型全部写对：

| 模型 | 写入内容 | 结果 |
|---|---|---|
| deepseek-v4.1-flash | ✓ 与预期一致 | ✅ |
| hy3 | ✓ | ✅ |
| glm-5.3 | ✓ | ✅ |
| kimi-k2.6 | ✓ | ✅ |

（对照组 `deepseek-account/deepseek-flash` 同样成功，说明测试方法本身有效。）

> 附带说明：上游本身是**正常**的——绕过 DSH 直接用凭证调 `v2/chat/completions`，返回的是标准原生 `tool_calls`。所以这不是 WorkBuddy 网关的问题，问题只出在中间这一跳。

---

## Bug 2（严重）：WorkBuddy 5.6+ 的凭证未解密，被误报成"所有账号均已失效"

### 现象

控制台顶部报「所有账号均已失效，需要重新登录」，`/api/accounts/check` 返回 `valid: 0, needsLogin: true`，但实际上账号完全可用（账号池的余额/签到接口调用全部成功）。

### 根因

`lib/account-check.mjs` 的 `scanCredentialFiles()` 对凭证文件只做 `JSON.parse`。WorkBuddy 5.6+ 把 `accessToken` / `refreshToken` / `nickname` 写成了 `$wbEncrypted` 信封：

```json
{ "$wbEncrypted": 1, "envelope": "...", "keyId": "...", "nonce": "...", "authTag": "...", "ciphertext": "..." }
```

于是 `accessToken` 拿到的是**对象**，当成 Bearer 发出去就变成 `Authorization: Bearer [object Object]`，上游回 401 —— 被判定为"失效"。

实测证据：
- `accessToken.len = NaN`（不是字符串）
- 刷新接口返回 `code: 12153` / `refresh token failed:10000:token format error`（"格式错误"正是收到了 `[object Object]`）
- 同一账号经 `vendor/xdpool`（会解密）调用则完全正常：余额、签到、模型目录都能读

### 建议修复

让控制台复用账号池解密后的凭证，而不是自己扫文件。例如在 `account-check.mjs` 里加：

```js
export async function scanDecryptedAccounts() {
  try {
    const mod = await import(new URL("../vendor/xdpool/lib/index.js", import.meta.url).href);
    let pool = null;
    if (typeof mod.currentApi === "function") {
      const api = mod.currentApi();
      if (api && api.pool && typeof api.pool.list === "function") pool = api.pool;  // 复用已在运行的池子
    }
    if (pool === null) {
      if (typeof mod.WorkBuddyAccountPool !== "function") return null;
      pool = new mod.WorkBuddyAccountPool({});
      await pool.scan();
    }
    const list = pool.list();
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map((a) => ({
      uid: (a.credential && a.credential.uid) || a.id,
      nickname: (a.credential && a.credential.nickname) || a.label || a.id,
      credential: a.credential
    }));
  } catch {
    return null;   // 拿不到就回退到原来的文件扫描
  }
}
```

然后在 `healthCheck()`、`localAccounts()` / `pickAuthAccount()`、`/api/tasks`、`/api/tasks/claim` 里优先使用它（回退逻辑保留）。

修复后 `/api/accounts/check` → `valid: 1, needsLogin: false`，「未完成任务」也能读到数据。

---

## Bug 3（高危）：macOS 上点「拉起 WorkBuddy 桌面版」会让 DSH 整个崩溃

### 现象

点控制台里的「拉起 WorkBuddy 桌面版」按钮 → DSH 宿主进程 fatal 崩溃并重启。

崩溃日志（`~/Library/Logs/DeepSeek Harness/crash-*-host.log`）：

```
dsh: fatal uncaught exception: Error: spawn /Applications/WorkBuddy.app EACCES
    syscall: 'spawn /Applications/WorkBuddy.app',
    path: '/Applications/WorkBuddy.app',
```

### 根因

`account-check.mjs` 的 `launchDesktopApp()` 用 `spawn('/Applications/WorkBuddy.app', ...)` 去启动一个 **`.app` 目录**。macOS 上这会直接 `EACCES`，而该 `ChildProcess` 没有挂 `error` 监听，未捕获的异步错误冒到宿主 → DSH 整体崩溃（崩溃一次连带丢掉正在进行的工作）。

`openUrl()` 里同样的 `spawn` 也有相同隐患。

### 建议修复

macOS 用 `open` 打开 `.app`，并给所有子进程补上 `error` 监听：

```js
if (process.platform === 'darwin' && target.endsWith('.app')) {
  const r = spawnSync('open', [target]);            // 同步、不会抛未捕获异步错误
  return { ok: r.status === 0, launched: target };
}
const child = spawn(target, [], { detached: true, stdio: 'ignore' });
child.on('error', () => {});                        // 关键：吞掉异步 error，别让宿主 fatal
child.unref();
```

---

## 我这边已做的修复（可作 PR 参考）

三处改动都已在本地跑通并回归验证，供你参考或直接采纳：

| 文件 | 改动 |
|---|---|
| `vendor/xdpool/lib/index.js` | ① `legacyContext()` 折成 `systemPrompt + toolsAdded` 的首条 system 消息（Bug 1）② 转发上游流时接入 `DsmlBridge`（见下） |
| `vendor/xdpool/lib/dsml-bridge.mjs` | **新增**：SSE 流式改写器，把模型漏在 `delta.content` 里的调用标记实时改写成标准 `delta.tool_calls`（兜底；上游正常时它是透明的） |
| `lib/account-check.mjs` | ① 新增 `scanDecryptedAccounts()` 走账号池解密凭证（Bug 2）② `spawn` → `spawnSync('open')` + `error` 监听（Bug 3） |
| `lib/index.js` | 账号检查/任务/技能市场改用解密后的凭证 |

补充两点实现细节，可能对你有用：

1. **桥接层有个容易踩的坑**：上游**每一帧**都会带 `finish_reason: ""`。如果只把 `null`/`undefined` 当作"未结束"，内容帧会被"改写一遍 + 原帧又透传一遍"，结果每个 token 重复两遍（现象：`DONEDONE`、`TheThe sea sea`）。判空必须按非空字符串来。我这边的回归测试覆盖了这个 case。

2. **验收方式建议**：不要看模型自称"已完成"。让模型用 `write` 工具写一个文件，然后**去磁盘核对内容**——这是唯一能区分"真的执行了"和"模型在幻觉"的办法（曾经出现过 5 个模型全说 DONE 但一个文件都没写的情况）。

---

## 复现材料

需要的话我可以提供：

- `upstream-request-shape.log` 修复前后的对照行
- 44 项桥接层单元测试（含方言识别、分块边界、重复回归）
- 一段真实上游 SSE 的字节回放脚本（按 1/3/7/64/4096 切块验证零重复零丢失）
- 直接调上游的原始响应样本（证明上游返回的是标准 `tool_calls`）
