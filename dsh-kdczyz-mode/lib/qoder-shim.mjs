/**
 * Qoder 的本地 loopback shim。
 *
 * # 为什么要有这一层
 *
 * DSH 的 LLM 侧只认 pi-ai 的 OpenAI 协议客户端。Qoder 上游是**私有协议**
 * （COSY 签名 + 套了两层信封的 SSE），两者对不上。
 *
 * 照抄 Trae 的解法：在本机起一个只监听 `127.0.0.1` 的小 HTTP server，
 * 对外**伪装成 OpenAI 的 `/v1/chat/completions`**，对内做「取号 → 签名 →
 * 打上游 → 解信封 → 转成标准 OpenAI SSE」。
 *
 * 于是职责是干净的：**pi-ai 管 OpenAI 协议，shim 管号池与 Qoder 私有协议**。
 *
 * # 安全边界
 *
 * 这个 server 虽然只听 loopback，但仍然校验三件事 —— 本机上的其它进程也可能
 * 访问它：
 *
 * 1. **随机 secret + `timingSafeEqual`**：不是「知道端口就能用」；
 * 2. **Host / Origin 必须是 loopback**：防 DNS rebinding 与浏览器跨站调用；
 * 3. **Content-Type 必须是 JSON**。
 *
 * ⚠️ `timingSafeEqual` **必须先比长度**：长度不等它会直接抛异常，而抛在鉴权
 * 路径上等于把「token 不对」变成 500。
 *
 * @module
 */

import crypto from 'node:crypto';
import http from 'node:http';

/** 回给 DSH 的状态码。与 Trae 侧同款，Qoder 多一个 `signature`。 */
export const STATUS_BY_KIND = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 502,
  server: 502,
  client: 400,
  // 签名错 = 本端配置/实现问题，不该重试，按客户端错误处理
  signature: 400,
  unconfigured: 503,
};

/** loopback 判定：只认本机地址。 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  // ⚠️ **IPv6 必须先把括号里的整体取出来再判断，不能「先剥端口」**：
  // `::1` 结尾的 `:1` 长得就像端口号，直接剥会把它削成 `:`，于是 `[::1]`
  // 被判成非本机 —— 实测踩过。带括号时整体取用；不带括号（IPv4 / 裸主机名）
  // 才剥端口。
  // ⚠️ **IPv6 必须在「剥端口」之前整体判定**：`::1` 结尾的 `:1` 长得就像端口，
  // 直接剥会把它削成 `:`，于是 `::1` / `[::1]` 全被判成非本机 —— 实测踩过。
  const LOOPBACK_NAMES = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
  ]);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed !== null) return LOOPBACK_NAMES.has(bracketed[1]);
  if (LOOPBACK_NAMES.has(host)) return true;
  // 不带括号的剩余情形（IPv4 / 裸主机名）才剥端口
  const name = host.replace(/:\d+$/, '');
  if (LOOPBACK_NAMES.has(name)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** Origin 头也必须是 loopback（防跨站调用）。 */
export function isLoopbackOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true; // 无 Origin 视为同源
  try {
    return isLoopbackHost(new URL(String(origin)).host);
  } catch {
    return false;
  }
}

/**
 * 比对 Bearer。
 *
 * ⚠️ **先比长度**再 `timingSafeEqual`：后者对不等长入参会抛，抛在鉴权路径上
 * 会把「token 不对」变成 500，且掩盖了真正的原因。
 */
export function bearerMatches(header, secret) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? ''));
  if (m === null) return false;
  const given = Buffer.from(m[1], 'utf8');
  const want = Buffer.from(secret, 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function writeError(res, status, kind, message, upstream) {
  writeJson(res, status, {
    error: {
      message,
      kind,
      // 只有上游真给过状态码时才带，避免把「本端判定」伪装成上游结论。
      ...(typeof upstream === 'number' ? { upstream } : {}),
    },
  });
}

/** 读完请求体（带上限，防超大 body 打爆内存）。 */
async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 起一个 Qoder shim。
 *
 * `routeChat` 是**注入点**（由 `lib/qoder.js` 提供真实实现）：
 * `(bodyJson, signal, parsed) => { ok, status, kind, message } | { ok:true, response }`。
 * 这样本文件不依赖号池与上游，可以独立单测路由与防护。
 */
export async function createQoderShim(options = {}) {
  const secret = options.secret ?? crypto.randomBytes(32).toString('base64url');
  const routeChat = options.routeChat;
  const log = options.log ?? (() => {});

  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = String(req.url ?? '/').split('?')[0];

    // —— 防护：Host / Origin 必须本机 ——
    if (!isLoopbackHost(req.headers.host)) {
      writeError(res, 403, 'client', 'host_not_allowed');
      return;
    }
    if (!isLoopbackOrigin(req.headers.origin)) {
      writeError(res, 403, 'client', 'origin_not_allowed');
      return;
    }

    // 健康检查与模型列表不需要 secret（pi-ai 在某些实现里先探活）
    if (req.method === 'GET' && (url === '/healthz' || url === '/health')) {
      writeJson(res, 200, { ok: true });
      return;
    }

    // —— 防护：token ——
    if (!bearerMatches(req.headers.authorization, secret)) {
      writeError(res, 401, 'authentication', 'unauthorized');
      return;
    }

    if (req.method === 'GET' && url === '/v1/models') {
      const models = typeof options.models === 'function' ? options.models() : [];
      writeJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'qoder',
        })),
      });
      return;
    }

    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        writeError(res, 415, 'client', 'unsupported_media_type');
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        writeError(res, 400, 'client', 'body_too_large');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        writeError(res, 400, 'client', 'invalid_json');
        return;
      }

      // 客户端断开要中止上游 —— 否则上游会继续把整个流吐完
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      req.socket?.once?.('close', abort);

      let result;
      try {
        result = await routeChat(raw, controller.signal, parsed);
      } catch (e) {
        writeError(res, 500, 'server', e?.message ?? String(e));
        return;
      }
      if (!result?.ok) {
        // `upstream` 是上游真实状态码（有的话）。**必须单独带上**：
        // `not_found` 与 `server` 都折成 502，只看到 502 无法区分
        // 「上游 404」「上游 5xx」「收到无法识别的流」「连接层异常」——
        // 2026-10-11 的排查就因为这一点绕了很久（真实原因是上游的业务
        // provider_error，HTTP 层面是 200）。
        writeError(
          res,
          STATUS_BY_KIND[result?.kind] ?? 500,
          result?.kind ?? 'server',
          result?.message ?? 'upstream failed',
          result?.upstream,
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // 防中间代理缓冲，否则流式会一坨一坨地出来
        'X-Accel-Buffering': 'no',
      });
      try {
        if (result.response?.body?.pipeTo) {
          // Web ReadableStream
          const reader = result.response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } else if (result.response?.body?.pipe) {
          result.response.body.pipe(res);
          return;
        }
      } catch {
        /* 流中断：客户端多半已断开，无需处理 */
      }
      res.end();
      return;
    }

    writeError(res, 404, 'not_found', 'not_found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // 端口 0 = 系统分配，避免与别的插件抢固定端口
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address()?.port;
  log(`qoder shim listening on 127.0.0.1:${port}`);

  return {
    secret,
    port,
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => secret,
    async close() {
      // 必须销毁所有 keep-alive socket，否则热重载会留下半死连接
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
