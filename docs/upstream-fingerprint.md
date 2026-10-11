# 三链路上游指纹取证（防检测）

取证对象：本机三个官方客户端。全部为**静态读取 + 一次主动验证**，
没有执行官方客户端、没有修改 `/Applications`。

| 链路 | 官方产物 | 版本 |
|---|---|---|
| WorkBuddy | `WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs` | `genieVersion 5.7.7` / CLI `2.156.0` |
| Trae | `TRAE SOLO CN.app/.../app/node_modules/@byted-icube/ai-modules-chat/dist/index.mjs` | `1.107.1` |
| Qoder | `Qoder CN.app/.../app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs` | `1.1.64` |

> WorkBuddy 的大包在 asar 里标 `unpacked:true`，实体在 `app.asar.unpacked/` 下，
> **直接读磁盘**（读 asar 数据区会拿到 `offset: NaN`）。

## 一、WorkBuddy

### 官方头装配（`codebuddy-lite-wb.mjs` @3447300）

```js
delete I.authorization, delete I["user-agent"];
// ↑ 先删掉 SDK 的小写 user-agent，再注入自己的
if (accessToken && 没有大小写变体的 authorization)
  I[AUTHORIZATION] = `Bearer ${accessToken}`;
for (const [k, v] of Object.entries(runIdentityHeaders()))
  if (没有同名大小写变体) I[k] = v;
```

### `runIdentityHeaders()`（模块 26492 @1301799）

```js
if (n?.uid)          c[X-User-Id] = n.uid;
if (n?.enterpriseId) c[X-Enterprise-Id] = n.enterpriseId;
if (i?.method)       c[X-Auth-Method] = i.method;
if (n?.idSource)     c[X-Id-Source] = n.idSource;
if (n?.uid && (n.enterpriseId || n.idSource || i?.method))
  c[X-Userinfo] = base64(JSON.stringify({
    uin: n.uid,
    ...(n.enterpriseId ? { owner_uin: n.enterpriseId } : {}),
    ...(n.idSource     ? { id_source: n.idSource }      : {}),
    ...(i?.method      ? { token_source: i.method }     : {}),
  }));
return { ...c, ...t.headers };
```

头常量表（模块 67865 @6479004，逐字）：

```
X-User-Id  X-Enterprise-Id  X-Auth-Method  X-Id-Source  X-Userinfo
X-Department-Info  X-Tenant-Id  X-Domain
X-No-User-Id  X-No-Enterprise-Id  X-No-Department-Info
X-No-Authorization  X-Skip-Auth-Interceptor
```

### 其它常量

- `X-Product = deploymentType ?? "SaaS"`（`ProductEndpointHttpInterceptor` @7749707）
- `X-Private-Data = "false"`（`enableModelOptimization` 默认开）
- `X-IDE-Type/Name = WorkBuddy`，`X-IDE-Version = 5.7.7`
- 版本三条链：`5.7.7`（桌面，进 `X-IDE-Version` 与 UA）／`2.156.0`（CLI）／`0.0.0`（占位，勿用）
- 推理 base：`https://www.workbuddy.cn/v2`，路径由内嵌 OpenAI SDK 拼 `/chat/completions`
- `Authorization: Bearer <accessToken>`，**无任何签名头**

### 插件当前缺陷

| 项 | 官方 | 插件现状 |
|---|---|---|
| `X-Auth-Method` / `X-Id-Source` / `X-Userinfo` | 有 | **完全没有** |
| chat UA | 桌面/CLI 形态 | `CLI/2.63.2 CodeBuddy/2.63.2`（硬编码，且与自动化路径的 `WorkBuddy/5.5.6` 不一致） |
| 版本常量 | 来自 product.json | 硬编码散落 |

## 二、Trae

官方 SDK 层（`ai-modules-chat` @439600）列出的头集合为**大量可选头**：
`x-ide-sign`、`web_sign_res`、`fp`、`x-device-id`、`package-type`、`store-region`、
`x-agent-flag`、`X-Plugin-Channel`、`Request-Traffic-Type` 等，由调用方按区域填充。

插件 `lib/trae.js` 的 `buildTraeHeaders()` + `identityHeaders()` 已覆盖其中真正
必需的那部分。**结论：Trae 半边已对齐，本轮零改动。**

实测插件实际发出的头集合（从 `buildTraeHeaders` 提取）：

```
Authorization(X-Cloudide-Token 变体)  X-Ide-Token  x-plugin-channel  User-Agent
x-app-id  x-app-version-code  x-ide-version-code  x-custom-trace-id
x-flow-traceparent  request-traffic-type  Content-Type  Accept
X-Cloudide-Token  x-uid  x-request-id  x-trae-request-id
```

与官方 `ai-modules-chat` SDK 的必需项逐项对应：

| 官方 SDK 头 | 插件 | 说明 |
|---|---|---|
| `authorization` / `x-ide-token` | ✅ | `Cloud-IDE-JWT <token>` + `X-Ide-Token` |
| `x-app-id` | ✅ | 同一常量 `6eefa01c-…` |
| `x-app-version` / `x-ide-version` | ✅ | 来自凭据的 `appVersion` |
| `x-ide-version-code` | ✅ | `buildVersion`（纯数字，非法值有兜底） |
| `X-Request-ID` / `X-Trae-Request-ID` | ✅ | 同一个 `randomUUID` |
| `X-Plugin-Channel` | ✅ | `icube-ai` |
| `Request-Traffic-Type` | ✅ | `prod` |
| `x-device-id` / `fp` / `x-ide-sign` / `web_sign_res` | ⚠️ 未发 | 官方 SDK 把它们列为**调用方按需填充**的可选项（浏览器侧签名链），CLI 侧 nonce 路径不要求 |

**判定依据**：Trae 这条链路在插件里本来就工作正常（本轮未改一行），
官方头集合里的硬性项已覆盖；未发的四个是浏览器侧签名链，服务端不强制。
真机旁证：`/plugins/dsh-connect-trae/usage?region=cn` 返回 `signed-in` +
`available 696.88`，说明该链路鉴权与额度查询都通。

## 三、Qoder（差异最大）

### 真正的推理客户端

桌面 asar 的 `out/main/index.js` **不含** `agent_chat_generation`。真正发推理请求的是：

```
app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/
  dist/_worker/qoder-worker-runtime.obf.mjs   (33 MB)
```

桌面端只是宿主（`spawn` worker）。**拿 `out/main/index.js` 的头做伪装是错的**
——那是 feedback / campaign / webRequest 注入路径。

### 官方请求构造（worker @18762192 / @19042230）

```js
// ① 生成运行时鉴权字段
const e = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid, security_oauth_token, organization_id, organization_tags, data_policy_agreed,
})));
// → { encrypt_user_info, key }

// ② 匿名占位 ctx
const ctx = new QoderContext(machineId, COSY_VERSION,
  JSON.stringify({ uid: "", encrypt_user_info: "", key: "" }),
  JSON.stringify(getClientMetadata()));

// ③ 注入真实身份（关键：不是构造时传 token）
ctx.refreshAuthFields(JSON.stringify({
  uid, encrypt_user_info: e.encrypt_user_info, key: e.key, ...
}));

// ④ 生成请求
ctx.prepareInferRequest(base, body, modelKey, modelSource)
// → { url, headers, body(已自定义编码) }
```

`COSY_VERSION` 硬编码 `"1.1.64"`（worker @37753 `s5="1.1.64"`）。

### 真实请求头（本机实测，打真上游 HTTP 200）

```
Accept: text/event-stream
Authorization: Bearer COSY.<payload>.<md5>
Cache-Control: no-cache
Connection: keep-alive
Content-Type: application/json
Cosy-Business-Product: cli
Cosy-Business-Type: agent
Cosy-ClientType: 5
Cosy-Data-Policy: disagree
Cosy-Date: <unix>
Cosy-Key: <RSA 包裹的会话密钥>
Cosy-MachineId / Cosy-MachineToken: <machine_id>
Cosy-MachineType: 5
Cosy-Scene: assistant
Cosy-User: <uid>
Cosy-Version: 1.1.64
Login-Version: v2
X-Model-Key: <model>
X-Model-Source: system
```

worker 的 `oo()` 另外补 `Cosy-MachineOS`（`aarch64_darwin`）与
`Cosy-MachineHostname`（仅 `infer-sse`），`openResponse()` 补
`X-Request-ID` / `X-Session-ID`。

URL：`.../algo/api/v2/service/pro/sse/agent_chat_generation
?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
——**`Encode=1` 是官方用法**，body 是自定义 Base64。

### 插件当前缺陷

| 项 | 官方 | 插件现状 |
|---|---|---|
| body 编码 | 自定义 Base64 | **明文 JSON** |
| `Encode` | `1` | **不带** |
| `cosyVersion` / `ideVersion` | `1.1.64` | 硬编码 `1.1.58` / `1.0.0` |
| `Cosy-*` 头族 | 15 个 | 只有 `Cosy-User/Key/Date` |
| `X-Model-Key` / `X-Model-Source` | 有 | 无 |
| 签名实现 | 官方 wasm | 手写 JS 复刻 |

### 自定义 Base64 不可纯 JS 复现（实测）

用官方 wasm 作预言机，取**全新 ctx**逐字节探测：

```
重复性: {"a":1} → ep$$BMn%mYKi (三次一致，STABLE)
'A' → "$p$p"      'B' → "$&$p"
'AB' → "$aBp"     'AC' → "$aVp"
'ABCD' → "$$KRC_pa"  'ABCE' → "$$KRCppa"
```

单字节输入就出现**映射冲突**（同一 6-bit 值在不同位置映射到不同字符），
说明编码与**总长度/跨块状态相关**，不是固定置换表。
→ **必须用官方 wasm**，纯 JS 复刻不可靠。

### 结论：签名与编码直接驱动官方 wasm

wasm 以 base64 内联在 worker runtime 里（@3065551，398142 字符 → 298606 字节，
导出 34 个符号含 `qodercontext_*` / `generate_runtime_auth_fields`）。

`lib/qoder-fingerprint.mjs` 在**运行时从本机安装**提取该 wasm 并驱动它
——**不把厂商二进制提交进仓库**（避免再分发），本机不存在时退回手写 COSY。

### 复现坐标（不依赖任何随包分发的二进制）

| 项 | 值 |
|---|---|
| 源码 | `/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs` |
| 大小 | 33,191,711 字节 |
| wasm base64 起始偏移 | `3065551`（该文件是单行产物，按字节偏移定位） |
| wasm 字节数 | 298,606 |
| wasm sha256 | `6419471effa631519def7797d76d7ede38b9fcfa9a83c2148c8ef5d43355b43d` |
| 同目录 `runtime-info.json` | `version 1.1.64`、`commit 89288985d631108ed595e1f43b3c3f5dc62e5ca8` |

> 该文件里共有 **6 段**魔数合法的内联 wasm；只有含 `qodercontext_new` 的那段
> 是签名/编码用的。提取器靠**导出符号**筛选，不靠长度（最长的那段 1.38 MB
> 是别的依赖）——按大小取最大必然取错。

### 会伪装成别的问题的三个坑

| 症状 | 真实原因 |
|---|---|
| HTTP 200 + 业务 `403 Signature invalid` | 跳过了 `generate_runtime_auth_fields` / `refreshAuthFields`，签名 payload 里 `info` 是空串 |
| `qodercontext_new` 返回 `err=1` | `userInfo` 缺 `encrypt_user_info` 或 `key` 键（**可为空串，但键必须在**） |
| body 长度变成几万字节 | `requestresult_*` 读取顺序错了。**必须** `url → body → headers`；先读 `headers` 会消费掉头表，之后 `requestresult_body` 拿到被污染的偏移（实测 64,290 字节 vs 正确 100 字节） |

### 与「明文路径」的关系

两条路上游都收，但**只有 wasm 那条与官方客户端同形**，所以它是首选：

| | 手写 COSY（兜底） | 官方 wasm（首选） |
|---|---|---|
| 查询串 | 不带 `Encode` | **带 `Encode=1`** |
| body | 明文 JSON | **自定义 Base64** |
| `cosyVersion` / `ideVersion` | 旧值 | 官方真实值 |
| 头集合 | `Cosy-User/Key/Date` | 完整 `Cosy-*` + `X-Model-*` + `Login-Version` |

本机没装 Qoder（提取不到 wasm）时才退回左列 —— 那条路实测可用，只是不同形。

### 第二轮复查补上的三处（2026-10-11 复检）

第一轮只对齐了 wasm 直接产出的那层头。复查发现**官方在 wasm 之外还有两个包装层**，
它们各补一些头、也**删**一些头，漏掉就是可识别差异：

| 差异 | 官方行为 | 第一轮实现 | 处理 |
|---|---|---|---|
| `Cosy-MachineOS` | `oo()` 对**所有**请求注入，值 = `` `${arch}_${platform}` ``（arm64→`aarch64`、x64→`x86_64`） | **缺** | 补上 |
| `Cosy-MachineHostname` | `oo()` 在 `requestClass === "infer-sse"` 时注入，值经 `zei()` 归一（非可打印 ASCII 换成 `-` + 附 sha256 前 8，超 96 截断） | **缺** | 补上 |
| `Cosy-MachineToken` / `Cosy-MachineType` | `Vai()` **先删掉** wasm 产出的这两个头，只在 native bridge（UMID）给出真令牌时才补回 | **误发**：wasm 占位值是 `Cosy-MachineToken === machineId` | 按官方「拿不到就为空」分支**删掉** |

第三条是最值得记的：wasm 在匿名占位身份下会把 `Cosy-MachineToken` 填成
**machineId 本身**（实测 `Cosy-MachineToken === Cosy-MachineId`），而官方客户端
从不发这种「令牌等于机器 id」的组合 —— 真正的机器令牌由官方 UMID 二进制向服务端
换取，插件复刻不了，所以唯一忠实的做法就是照官方空分支删掉。

> 真机实测：这四种头组合**上游全部返回 200**（网关不校验）。所以这三处不影响
> 「能不能通」，只影响「像不像官方客户端」。防检测的目标是后者。

同时确认了 `X-Request-ID` / `X-Session-ID` **不是**缺口：它们只出现在
`openResponse()`（另一条 HTTP 传输）里，而我们走的 legacy 路径
（`Kvi` → `Vai` → `oo`）官方**不发**。

### 第二轮复查：WorkBuddy 的六个会话头

复查 `codebuddy-lite-wb.mjs` @3447300 的装配全段，发现官方**每次 chat**
（不只是自动化链）都无条件注入六个会话头，而插件主推理路径一个都没发：

```js
I[CONVERSATION_ID_HEADER]         = M.id;
I[CONVERSATION_REQUEST_ID_HEADER] = F || "";        // 空值也发
I[CONVERSATION_MESSAGE_ID_HEADER] = M.messageId;
I[REQUEST_ID_HEADER]              = M.messageId;    // 与上面同值
I[AGENT_TYPE_HEADER]              = resolveAgentType(M); // "team"|"subagent"|"main"
```

两个易错点（做错本身就是指纹）：

1. **`X-Request-ID` 与 `X-Conversation-Message-ID` 是同一个值**（dash 去横线的 uuid），
   官方从不发两个不同的 id；
2. **`X-Conversation-Request-ID` 即使为空串也要发**（官方是 `F || ""`）——
   「不发」和「发空串」在网关侧不是一回事。

已补进 `chatStream` / `completeChat`（`conversationHeaders()`，可注入 id 以利测试）。
真机实测：带与不带这六个头都返回 200，同样属于「不影响连通、只影响同形」。
