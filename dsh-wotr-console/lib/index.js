/**
 * dsh-wotr-console —— **WorkBuddy 半边**的宿主入口（合并后的包根）。
 *
 * 本包把两个原本独立的插件合并成「一个包、两个 Loader 入口」：
 *
 *   entry A  name: dsh-wotr-console        -> 本文件        WorkBuddy 池半边
 *   entry B  name: dsh-wotr-console/trae   -> lib/trae.js   Trae 半边
 *
 * 为什么必须是两个入口、而且两个**不同的模块说明符**：
 *   cordis 按 `apply` 函数的**引用同一性**登记 runtime
 *   （RegistryService._internal.set(callback, runtime)），而 `Config` 挂在
 *   runtime 上。两个入口若指向同一个模块，就会共享一个 runtime、一个
 *   `Config`；两半都声明了 `enabledModelIds`/`imageModelIds`/`contextBudgets`/
 *   `authFile` 但语义不同，合表之后这两半会抢同一个字段值。拆成两个模块
 *   才有两个独立 runtime，因此两个独立 Config。
 *
 * 入口 id 刻意保持不变（`llm-workbuddy-xdpool`）：vendored 的池卡片按这个
 * 确切 id 查自己的 settings 作用域，改名会让卡片变只读；同时已保存的配置
 * 也挂在这个 id 上，改名等于丢配置。
 *
 * 本文件只负责 WorkBuddy 这一半（原 dsh-workbuddy-console）：
 *   - 通过 vendored 的 xdpool 实现注册两个 LLM provider：
 *       workbuddy-xdpool         国内版
 *       workbuddy-xdpool-global  国际版
 *   - 转发 vendored 的 Config schema，让 DSH 设置页能生成配置表单
 *   - 挂两条只读接口给合并后的管理页读历史记录
 *   - 兜底清理热重载时残留的 LLM 注册，避免 DUPLICATE_ADAPTER
 *
 * 界面：全部走 DSH 内置的设置面板（六标签页由 lib/client.js 注册）。
 * 凭据：由 vendored xdpool 自己管理，本文件不读不写任何凭据文件。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 并入的模型池实现（原 dsh-workbuddy-xdpool，MIT，(c) XDTrees）。
// 见 vendor/xdpool/README.md —— 代码原样保留，便于与上游对照升级。
import * as xdpoolModule from '../vendor/xdpool/lib/index.js';
import * as creditStore from './credit-store.mjs';
import * as wbAuth from './wb-auth.mjs';
import * as traeAuth from './trae-auth.mjs';
import * as qoderAuth from './qoder-auth.mjs';
import { QoderAccountPool, QoderCredentialStore } from './qoder-pool.mjs';
import { refreshQoderPoolCredits } from './qoder-credits.mjs';

export const name = 'wotr-console';

/**
 * 只保留 vendored 那一半真正需要的服务。
 *
 * vendor/xdpool/lib/index.js 自己声明的是 inject = ['llm', 'settings']，
 * 但我们是**手动同步调用**它的 apply()，绕过了 cordis 的 inject 门控 ——
 * 于是「settings 还没就绪」时它会在内部抛错，被下面的 try/catch 吞掉，
 * 结果它那 9 条池路由一条都没注册。
 *
 * 把依赖列在这里，cordis 会等到它们全部可用才调用我们的 apply，
 * 那时再转发给 vendored apply 就是安全的。
 *
 * 注意：这里**不包含 'webServer'**。本插件不是"控制台"：没有任何独立页面。
 * 但管理页（设置面板里的一个 tab）需要两条只读接口来读历史记录，
 * 这两条路由通过 `ctx.inject(['webServer'], ...)` **按需自注入**挂载 ——
 * 与 vendored 账号池路由的做法完全一致。这样：
 *   - 宿主没提供 webServer 时，插件照常工作，只是管理页读不到历史
 *   - 不因为声明了 webServer 而拖慢插件启动（cordis 要等依赖就绪才 apply）
 */
export const inject = ['llm', 'settings'];

/**
 * 转发 vendored 的 Config schema —— **这一步是必须的**。
 *
 * 宿主按插件导出的 `Config` 生成「配置表单」(configForms 的 namespace)。
 * 浏览器端的账号池卡片靠 resolveSettingsScope() 找到这个表单，
 * 拿到**可写的** settingsScope 才写得进 modelSelectionCn / distribution /
 * disabledAccountIds 这些字段。
 *
 * 少了它的后果（实测）：
 *   卡片变成只读 —— 取消勾选几个模型、点保存，值立刻回到原样，
 *   因为写入根本没有可用的 settings 作用域。
 *
 * vendor/xdpool/lib/index.js 本来就 `export { ..., Config, ... }`，
 * 这里只是把它转出来，vendored 代码一行都不用改。
 */
export const Config = xdpoolModule.Config;

/**
 * 转发给 vendored xdpool 的那份配置。
 *
 * 条目的 config 就是 vendored 的配置本身：modelSelectionCn、
 * modelSelectionGlobal、distribution、automation… 全在顶层。
 *
 * 兼容 `config.pool`：万一将来有人把池配置收进子对象，也还能用。
 */
export function poolConfigFrom(config) {
  if (!config || typeof config !== 'object') return {};
  return config.pool && typeof config.pool === 'object' ? config.pool : config;
}

/**
 * 最近一次「转发给 vendored xdpool 的 apply」失败的原因。
 * 只记在内存里并写日志 —— 控制台已移除，没有 /wb-console/api/diag 可查了。
 */
let poolError = null;

/** 暴露给外部（测试/诊断）读取最近一次池错误 */
export function lastPoolError() {
  return poolError;
}

/**
 * 上一实例是否已经向 llm 注册过 workbuddy 的 provider。
 *
 * vendored 的 apply() 是在 **Promise.all([cn.ready, global.ready]) 的 then 里**
 * 异步注册 provider 的 —— 也就是说 apply() 返回时它还没注册完。
 * 于是宿主热重载时存在一个窗口：旧实例的 provider 已经进了
 * `ctx.llm.adapters` / `ctx.llm.directory`，但它的 disposer 因为 apply
 * 还没返回而**没能登记到我们的 disposeLive()**，永远不会被调用。
 *
 * 新实例这时再注册同一批 provider，`registerAdapter()` 会抛
 * DUPLICATE_ADAPTER、`registerConfigurableProviders()` 会抛
 * DUPLICATE_DIRECTORY。而 vendored 把整段包在 try 里，失败只写一行
 * `ctx.logger.error`，然后**三个 release 全被调用把已成功的也撤掉** ——
 * 于是「插件显示运行中，但 workbuddy 模型一个都没有」，日志外完全看不出原因。
 *
 * 所以在转发 apply 之前，先按 provider id 清掉不属于本次的残留注册。
 * 只动 workbuddy 自己的两个 id，不碰别的插件。
 */
let ownsLlmRoutes = false;

/** 清掉残留的 workbuddy provider 注册，返回清掉的条数 */
export function clearStaleLlmRoutes(ctx, reason) {
  const llm = ctx?.llm;
  if (!llm) return 0;
  const ours = new Set(['workbuddy-xdpool', 'workbuddy-xdpool-global']);
  let cleared = 0;

  // 1) adapters（registerAdapter 建的）
  if (llm.adapters instanceof Map) {
    for (const id of [...llm.adapters.keys()]) {
      if (!ours.has(id)) continue;
      llm.adapters.delete(id);
      cleared++;
    }
  }

  // 2) directory（registerConfigurableProviders 建的）
  if (llm.directory instanceof Map) {
    for (const id of [...llm.directory.keys()]) {
      if (!ours.has(id)) continue;
      llm.directory.delete(id);
      cleared++;
    }
  }

  // 3) discoveries（registerModelDiscovery 建的，靠 settingsNs 索引）
  if (llm.discoveries instanceof Map) {
    for (const [ns, fn] of [...llm.discoveries.entries()]) {
      if (ns !== 'workbuddy' && !/workbuddy/i.test(ns)) continue;
      llm.discoveries.delete(ns);
      cleared++;
    }
  }

  if (cleared > 0) {
    ctx.logger?.warn?.(
      `[wotr-console] 清掉 ${cleared} 条残留 LLM 注册（${reason}）：否则新实例会撞 DUPLICATE_ADAPTER，` +
        'workbuddy 模型将完全不可用',
    );
    try {
      llm.emitAdaptersUpdated?.();
    } catch {
      /* 通知失败不影响已经清干净的表 */
    }
  }
  return cleared;
}

/**
 * 盯着 vendored 有没有真的把 provider 注册到 ctx.llm 上。
 *
 * vendored 的注册发生在异步回调里，而且**失败只写一行 logger.error**，
 * 外面完全看不出来 —— 这正是「插件运行中但 workbuddy 模型一个都没有」
 * 长期查不出原因的原因。这里主动轮询一小会儿，把结论写进 poolError
 * 并记日志。
 */
function watchLlmRegistration(ctx, hadStale) {
  const llm = ctx?.llm;
  if (!llm) return;
  const deadline = Date.now() + 12000;
  let waited = 0;

  const check = () => {
    const adapters = llm.adapters instanceof Map ? llm.adapters : null;
    const cn = adapters?.has('workbuddy-xdpool') || false;
    const global = adapters?.has('workbuddy-xdpool-global') || false;

    if (cn) {
      ownsLlmRoutes = true;
      // 给可见模型数也记一份，「注册成功但列表为空」是另一类故障
      try {
        const adapter = adapters.get('workbuddy-xdpool')?.adapter;
        const models = adapter?.listModels?.('workbuddy-xdpool');
        if (models && typeof models.then === 'function') {
          models.then(
            (list) => {
              if (!Array.isArray(list) || list.length === 0) {
                ctx.logger?.warn?.(
                  '[wotr-console] provider 已注册，但可见模型为 0 —— 检查 modelSelectionCn.enabledModelIds',
                );
              }
            },
            () => {},
          );
        }
      } catch {
        /* 只是诊断，取不到就算了 */
      }
      return;
    }

    if (Date.now() >= deadline) {
      poolError = {
        message:
          'workbuddy provider 未能注册到 llm（等 12s 仍无 workbuddy-xdpool adapter）' +
          (hadStale ? '；本次已清理残留注册仍失败，可能是端口/权限或 vendored 内部异常' : ''),
        stack: '',
        at: new Date().toISOString(),
        globalRegistered: global,
        llmKeys: adapters ? [...adapters.keys()] : null,
      };
      ctx.logger?.error?.('[wotr-console] ' + poolError.message);
      return;
    }

    waited += 400;
    const t = setTimeout(check, 400);
    t.unref?.();
  };

  const t = setTimeout(check, 600);
  t.unref?.();
}

/**
 * 解析 DSH 主目录（`~/.dsh` 之类）。
 *
 * 优先问宿主提供的服务，取不到再退回环境变量与默认位置。
 * 任何一条都不可用时返回 null —— 调用方据此禁用采集。
 */
function resolveDshHome(ctx) {
  // 1) 宿主服务（不同版本字段名不同，逐个试）
  for (const name of ['homePaths', 'dshHomePaths']) {
    try {
      const svc = ctx?.get?.(name);
      const dir = svc?.home?.() ?? svc?.homeDir?.() ?? svc?.root?.();
      if (typeof dir === 'string' && dir !== '') return dir;
    } catch {
      /* 试下一个 */
    }
  }
  // 2) 环境变量
  for (const key of ['DSH_HOME', 'DSH_CONFIG_HOME']) {
    const v = process.env[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  // 3) 默认位置（宿主未提供任何线索时的兜底，与本机实际布局一致）
  try {
    const fallback = join(homedir(), '.dsh');
    if (existsSync(fallback)) return fallback;
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 管理页的两条接口（挂在本插件自己的命名空间下）。
 *
 *   GET  /plugins/dsh-wotr-console/history-summary
 *        账号维度汇总 + 按天净变化，供「积分」「使用记录」两个 tab 渲染
 *   POST /plugins/dsh-wotr-console/sample
 *        让服务端去读一次最新额度并落盘采样（管理页打开时调用）
 *
 * 为什么采样要服务端做：额度数据在 vendored 的账号池里，浏览器只能通过
 * 它的 /status 路由拿；让前端把 /status 的结果回传再落盘，会把网络往返
 * 变成两跳，且前端能伪造写入内容。服务端直接调 vendored 更短也更可控。
 *
 * 返回 disposer；宿主没有 webServer 时返回 null（功能降级，不报错）。
 */
/**
 * 在系统默认浏览器里打开一个 URL。
 *
 * 登录必须**在系统浏览器里完成**（而不是插件内嵌页）：邮箱/微信/Google 各种
 * 登录方式都在服务端下发的那个页面上，插件不该、也做不到代用户填密码。
 *
 * 用 `open`（macOS）/ `xdg-open`（Linux）/ `start`（Windows）。失败不抛，
 * 由调用方把 authUrl 交给前端让用户手动打开 —— 打不开浏览器不该让登录整体失败。
 */
async function openInSystemBrowser(url) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', url];
  const file = cmd[0];
  const args = cmd.length > 1 ? cmd[1] : [url];
  await run(file, Array.isArray(args) ? args : [args]);
}

/**
 * 取登录用的上游地址。
 *
 * 跟着本机现有凭据的 `domain` 走：跨品牌域的 token 不通用（codebuddy.ai 签发的
 * 会被 workbuddy.ai 网关拒），池也是按凭据自带的 domain 选上游的，所以登录必须
 * 打到同一个站，否则新账号的 token 池用不了。读不到就退回 CN 默认站。
 *
 * 注意：国际版的授权端点我没能验证（CLI 里没出现 workbuddy.ai 的 endpoint），
 * 所以这里只是保证与本机现有凭据一致，不代表国际版一定登录成功。
 */
async function loginBaseUrl() {
  const fallback = 'https://www.workbuddy.cn';
  try {
    const dirs = xdpoolModule.defaultDesktopAuthDirs?.() ?? [];
    return await wbAuth.resolveLoginBase(dirs, fallback);
  } catch {
    return fallback;
  }
}

/** DSH 主目录（与 vendored 的 dshHome 同口径，供 Trae 凭据落盘用） */
function dshHomeDir() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env !== '') return env;
  return join(homedir(), '.dsh');
}

/**
 * Qoder CN 号池的**进程级单例**。
 *
 * 为什么要单例：池的状态（冷却、停用、保留额度、使用时刻）必须跨请求存活 ——
 * 一次 429 冷却的账号，下一次请求就得跳过它。每次请求新建池等于每次重扫磁盘、
 * 冷却全部丢失，「自动换号」也就无从谈起。
 *
 * 凭据目录跟着 DSH 主目录走（与 Trae 侧同一口径）；取不到主目录时池仍可用，
 * 只是扫不出账号（登录会明确报「没有 DSH 主目录」）。
 */
let qoderPoolSingleton = null;

/**
 * 积分刷新的**在途去重**（进程级）。
 *
 * 前端是每 30 秒自动刷一次，于是同一个 DSH 上开着两个窗口就会变成两条独立的
 * 30 秒定时器 —— 上游调用量直接翻倍，而它们查的是同一个池、结果完全一样。
 * 手动按钮时代没有这个问题（人只会点一次），改成自动之后必须有这一层。
 *
 * 并发请求共享同一个在途 promise，因此 N 个窗口仍是每 30 秒一次上游调用。
 * 用 promise 而不是「上次刷新时间」做节流：后者会让第二个窗口拿到**上一次**的
 * 旧结果却以为是自己刚刷的，页面上就会出现两个窗口数字不一致。
 */
let qoderCreditsInFlight = null;

export function resetQoderCreditsInFlight() {
  qoderCreditsInFlight = null;
}

export function qoderPool() {
  if (qoderPoolSingleton === null) {
    qoderPoolSingleton = new QoderAccountPool({
      store: new QoderCredentialStore({ dshHome: dshHomeDir() }),
    });
  }
  return qoderPoolSingleton;
}

/** 测试/诊断用：丢掉单例，让下次调用重建。 */
export function resetQoderPool() {
  qoderPoolSingleton = null;
}

function mountConsoleRoutes(ctx, config) {
  if (!ctx || typeof ctx.inject !== 'function') return null;

  const disposers = [];
  let mounted = false;

  try {
    ctx.inject(['webServer'], (web) => {
      const webServer = web?.webServer ?? ctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      if (mounted) return;
      mounted = true;

      const BASE = '/plugins/dsh-wotr-console';

      /** 只接受本机来源：路由读的是账号额度，不该被远程页面拉到 */
      const loopbackOrigin = (req) => {
        const origin = req?.headers?.origin;
        if (typeof origin !== 'string' || origin === '') return true; // 同源导航无 Origin 头
        try {
          const u = new URL(origin);
          return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
        } catch {
          return false;
        }
      };

      const json = (res, status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        });
        res.end(text);
      };

      // —— 汇总：直接读本地 jsonl，不触碰网络 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/history-summary`,
          handler: (req, res) => {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              json(res, 200, { ok: true, ...creditStore.summarize() });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 采样：向 vendored 的 /status 取一次，然后落盘 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/sample`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });

            let region = 'cn';
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              if (raw !== '') {
                const parsed = JSON.parse(raw);
                if (parsed?.region === 'global') region = 'global';
              }
            } catch {
              /* 空 body 或坏 JSON 都按默认区域处理 */
            }

            try {
              const port = webServer.port ?? config?.port;
              const url = `http://127.0.0.1:${port}/plugins/dsh-workbuddy-xdpool/status?region=${region}`;
              const r = await fetch(url, {
                headers: { Accept: 'application/json', Origin: `http://127.0.0.1:${port}` },
                signal: AbortSignal.timeout?.(15000),
              });
              if (!r.ok) {
                return json(res, 502, { ok: false, error: `status HTTP ${r.status}` });
              }
              const status = await r.json();
              const written = await creditStore.recordStatus(status?.accounts ?? [], {
                source: `page:${region}`,
              });
              json(res, 200, { ok: true, ...written });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— WorkBuddy 浏览器登录：起一次登录 ——
      //
      // 协议见 lib/wb-auth.mjs 顶部注释：**不是** OAuth 授权码流程，
      // 是「服务端发 authUrl → 系统浏览器登录 → 客户端拿 state 轮询换 token」。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/wb/login/start`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const begun = await wbAuth.beginLogin({
                fetchImpl: fetch,
                baseUrl: await loginBaseUrl(),
                openUrl: openInSystemBrowser,
              });
              if (begun.error !== undefined) return json(res, 502, { error: begun.error });
              json(res, 200, {
                sessionId: begun.sessionId,
                authUrl: begun.authUrl,
                opened: begun.opened === true,
                ...(begun.openError === null || begun.openError === undefined
                  ? {}
                  : { openError: begun.openError }),
              });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 轮询登录状态 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/wb/login/status`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              if (typeof sessionId !== 'string' || sessionId === '') {
                return json(res, 400, { error: '缺少 session' });
              }
              const r = await wbAuth.stepLogin({ fetchImpl: fetch, sessionId });
              if (r.error !== undefined) return json(res, 400, { error: r.error });
              if (r.status === 'pending') return json(res, 200, { status: 'pending' });
              if (r.status === 'failed') return json(res, 200, { status: 'failed', error: r.error });

              // 登录完成 → 落盘凭据，让池下次扫描就能认出这个新账号
              const dir = await wbAuth.pickAuthDir(
                xdpoolModule.defaultDesktopAuthDirs?.() ?? [],
                xdpoolModule.pluginDataDir?.() ?? join(homedir(), '.dsh', 'plugin-data'),
              );
              const saved = await wbAuth.saveCredential({
                dir,
                credential: r.credential,
                identity: r.identity,
                // 用 vendored 自己的算法，保证与池算出的账号 id 完全一致
                accountIdOf: (identity) => xdpoolModule.workbuddyAccountId(identity),
              });
              if (saved.error !== undefined) {
                return json(res, 500, { status: 'failed', error: saved.error });
              }
              // 立刻让池重新扫描，不必等下一次定时
              try {
                await xdpoolModule.currentApi?.().pool?.scan?.();
              } catch {
                /* 扫描失败不影响本次结果，下次打开管理页也会扫 */
              }
              json(res, 200, { status: 'done', accountId: saved.accountId });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 取消登录 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/wb/login/cancel`,
          handler: (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              json(res, 200, { cancelled: wbAuth.cancelLogin(sessionId ?? '') });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— Trae 浏览器登录（PKCE + 本机回环回调，与 WorkBuddy 的 state 轮询不同）——
      //
      // 回调到达时**在 handler 里同步完成换 token**（AgentHub 同款），
      // 所以这里 start 之后前端只需轮询 status 读结果。
      // 手动粘贴兜底：浏览器没跳到回环地址时，整段粘回来换。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/trae/login/start`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const r = await traeAuth.beginLogin({
                fetchImpl: fetch,
                openUrl: openInSystemBrowser,
              });
              if (r.ok !== true) return json(res, 502, { error: r.message ?? '登录启动失败' });
              json(res, 200, { sessionId: r.sessionId, authUrl: r.url, port: r.port, opened: r.opened === true });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/trae/login/status`,
          // 必须是 async：路由要 await 凭据落盘（见下方注释）
          handler: async (req, res) => {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              if (typeof sessionId !== 'string' || sessionId === '') return json(res, 400, { error: '缺少 session' });
              const r = traeAuth.stepLogin({ sessionId });
              if (r.error !== undefined) return json(res, 400, { error: r.error });
              if (r.status === 'pending') return json(res, 200, { status: 'pending' });
              if (r.status === 'failed') return json(res, 200, { status: 'failed', error: r.error });

              // 登录完成 → 落盘到 Trae 自己的凭据文件（lib/trae.js 的 store 会读到）
              //
              // ⚠ 必须 await：saveTraeCredential 是 async 的。漏掉 await 时路由
              //   会在写盘完成前就回 200，写失败（磁盘/权限）也被静默吞进
              //   `saved.error` 之外 —— 表现为「登录显示成功，但号池里没有这个
              //   账号」，而且日志里什么都看不到。
              const region = 'cn';
              const saved = await traeAuth.saveTraeCredential({
                dshHome: dshHomeDir(),
                region,
                edition: 'solo',
                accessToken: r.accessToken,
                refreshToken: r.refreshToken,
                userId: r.identity?.uid ?? '',
                accountName: r.identity?.name ?? '',
                expiresAtMs: r.expiresAtMs,
                refreshExpiresAtMs: r.refreshExpiresAtMs,
              });
              if (saved.error !== undefined) {
                return json(res, 500, { status: 'failed', error: saved.error });
              }
              json(res, 200, { status: 'done', region: saved.region, accountId: saved.accountId });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/trae/login/cancel`,
          handler: (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              json(res, 200, { cancelled: traeAuth.cancelLogin(sessionId ?? '') });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— WorkBuddy 模型目录刷新 ——
      //
      // 对齐 Trae 半边的 POST /models/refresh：拉一次上游实时目录，立即更新
      // 内存里的 catalog（vendor 的启动种子只在插件加载时拉一次，WorkBuddy
      // 之后新上的模型要重启 DSH 才看得见），把解析后的目录行原样返回。
      //
      // 「自动全量启用」不放这半边：vendor 的启动种子同样只更新目录不动勾选，
      // 勾选落盘由管理页走 settingsScope 完成（与 vendored 卡片同一写入路径，
      // 写完读回确认），路由只负责「取目录」这一件事。
      const modelRefreshInflight = new Map();
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/wb/models/refresh`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            const region =
              new URL(req.url ?? '/', 'http://localhost').searchParams.get('region') === 'global'
                ? 'global'
                : 'cn';
            let inflight = modelRefreshInflight.get(region);
            if (inflight === undefined) {
              inflight = (async () => {
                const api = xdpoolModule.currentApi?.();
                if (!api?.pool || !api?.client || !api?.catalogs?.[region]) {
                  throw new Error('模型池尚未就绪，稍后再试');
                }
                let accounts = api.pool.list(region);
                if (accounts.length === 0) {
                  await api.pool.scan();
                  accounts = api.pool.list(region);
                }
                if (accounts.length === 0) {
                  throw new Error(
                    `没有 ${region === 'global' ? '国际版' : '国内版'} WorkBuddy 账号，无法拉取模型目录`,
                  );
                }
                // 优先用不在冷却里的账号拉目录（冷却账号的 token 可能已被上游限流）
                const usable =
                  accounts.find((a) => a.credential && (a.cooldownUntilMs ?? 0) <= Date.now()) ??
                  accounts[0];
                const models = await api.client.fetchModels(usable.credential);
                if (!Array.isArray(models) || models.length === 0) {
                  throw new Error('WorkBuddy 未返回任何模型');
                }
                api.catalogs[region].updateFromUpstream(models);
                // 尽力让已注册的 provider 重建模型表（失败不影响目录本身已更新）
                try {
                  api.adapter?.invalidate?.();
                } catch {
                  /* 下一次请求仍会按新目录取模型 */
                }
                return api.catalogs[region].current().map((model) => ({
                  id: model.id,
                  name: model.name,
                  contextWindow: model.contextWindow,
                  maxTokens: model.maxOutputTokens,
                  supportsImages: model.supportsImages === true,
                  ...(model.supportedEfforts === undefined
                    ? {}
                    : { supportedEfforts: model.supportedEfforts }),
                  ...(model.multiplier === undefined ? {} : { multiplier: model.multiplier }),
                }));
              })().finally(() => modelRefreshInflight.delete(region));
              modelRefreshInflight.set(region, inflight);
            }
            try {
              const models = await inflight;
              json(res, 200, { ok: true, region, models });
            } catch (e) {
              json(res, 502, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // ================================================================
      // Qoder CN —— 设备流登录 + 号池
      // ================================================================
      //
      // 与 Trae 侧的关键差别：Qoder 用**设备流**（PKCE + 轮询），不开回环
      // 端口、没有回调页。所以 start 返回 loginUrl 后，前端只需轮询 status，
      // 后台轮询拿到 token 时 status 就变成 done。
      //
      // 这条路是号池唯一的入池通道：Qoder 桌面端每个安装只保存一份登录，
      // 扫本机登录态永远只能扫出一个账号。

      // —— 号池快照：账号列表 + 冷却 + 停用 + 保留额度 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const pool = qoderPool();
              await pool.scan();
              const now = Date.now();
              json(res, 200, {
                ok: true,
                distribution: pool.currentDistribution(),
                disabledIds: pool.disabledIdsInOrder(),
                creditReserves: pool.creditReservesInOrder(),
                // 「当前账号」：请求固定用它（不可用才回退到轮换）。
                selectedAccountId: pool.selectedAccountId() ?? null,
                lastServedId: pool.lastServedId() ?? null,
                status: pool.status(),
                accounts: pool.list().map((account) => ({
                  id: account.id,
                  label: account.label,
                  userId: account.credential.userId ?? '',
                  expiresAtMs: account.credential.expiresAtMs ?? 0,
                  expired: (account.credential.expiresAtMs ?? 0) > 0 && (account.credential.expiresAtMs ?? 0) <= now,
                  disabled: pool.isDisabled(account.id),
                  selected: pool.selectedAccountId() === account.id,
                  creditReserve: pool.creditReserveOf(account.id),
                  credits: pool.creditsOf(account.id) ?? null,
                  cooldownUntilMs: account.cooldownUntilMs,
                  cooling: account.cooldownUntilMs > now,
                  modelCooldowns: account.modelCooldowns,
                  rateLimitHits: account.rateLimitHits,
                })),
              });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 池配置：分配策略 / 冷却时长 / 停用 / 保留额度 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool/config`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            let body;
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              body = raw === '' ? {} : JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            try {
              const pool = qoderPool();
              await pool.scan();

              const patch = {};
              if (body?.distribution !== undefined) {
                if (!['priority', 'round-robin', 'balanced'].includes(body.distribution)) {
                  return json(res, 400, { error: 'distribution 必须是 priority / round-robin / balanced' });
                }
                patch.distribution = body.distribution;
              }
              if (body?.cooldownMs !== undefined) patch.cooldownMs = Number(body.cooldownMs);
              if (body?.exhaustCooldownMs !== undefined) patch.exhaustCooldownMs = Number(body.exhaustCooldownMs);
              if (body?.disabledAccountIds !== undefined) {
                if (!Array.isArray(body.disabledAccountIds)) {
                  return json(res, 400, { error: 'disabledAccountIds 必须是数组' });
                }
                patch.disabledAccountIds = body.disabledAccountIds.filter((v) => typeof v === 'string');
              }
              if (body?.creditReserves !== undefined) {
                if (typeof body.creditReserves !== 'object' || body.creditReserves === null) {
                  return json(res, 400, { error: 'creditReserves 必须是对象' });
                }
                patch.creditReserves = body.creditReserves;
              }
              // 「当前账号」：null / 空字符串 = 清除选择，回到号池轮换。
              if (body?.selectedAccountId !== undefined) {
                const value = body.selectedAccountId;
                if (value !== null && typeof value !== 'string') {
                  return json(res, 400, { error: 'selectedAccountId 必须是字符串或 null' });
                }
                patch.selectedAccountId = value ?? '';
              }
              pool.applyConfig(patch);
              json(res, 200, {
                ok: true,
                distribution: pool.currentDistribution(),
                disabledIds: pool.disabledIdsInOrder(),
                creditReserves: pool.creditReservesInOrder(),
                selectedAccountId: pool.selectedAccountId() ?? null,
              });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 启停单个账号 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool/account`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            let body;
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              body = raw === '' ? {} : JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
            if (accountId === '') return json(res, 400, { error: '缺少 accountId' });
            try {
              const pool = qoderPool();
              await pool.scan();
              if (!pool.list().some((account) => account.id === accountId)) {
                return json(res, 404, { error: 'account not found' });
              }
              const next = new Set(pool.disabledIdsInOrder());
              if (body?.disabled === true) next.add(accountId);
              else next.delete(accountId);
              pool.applyConfig({ disabledAccountIds: [...next] });
              json(res, 200, { ok: true, disabledIds: [...next] });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 切换「当前账号」——
      //
      // 与启停不同：这是**选谁服务请求**，不是「谁参与池子」。请求固定走
      // selectedId 指向的账号（它不可用时才回退到轮换，见 qoder-pool.mjs）。
      // `accountId: null` 或空字符串 = 清除选择，回到号池轮换。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool/select`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            let body;
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              body = raw === '' ? {} : JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            // null / '' = 清除选择；其余必须是非空字符串。
            const raw = body?.accountId;
            if (raw !== null && raw !== undefined && typeof raw !== 'string') {
              return json(res, 400, { error: 'accountId 必须是字符串或 null' });
            }
            const accountId = typeof raw === 'string' ? raw : '';
            try {
              const pool = qoderPool();
              await pool.scan();
              // 只允许切到池里真实存在的账号：否则一个拼错的 id 会让所有请求
              // 静默回退到轮换，而 UI 显示「已选中」。
              if (accountId !== '' && !pool.list().some((account) => account.id === accountId)) {
                return json(res, 404, { error: 'account not found' });
              }
              pool.selectAccount(accountId);
              json(res, 200, { ok: true, selectedAccountId: pool.selectedAccountId() ?? null });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 设置单个账号的保留额度 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool/credit-reserve`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            let body;
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              body = raw === '' ? {} : JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
            if (accountId === '') return json(res, 400, { error: '缺少 accountId' });
            const value = Number(body?.credits);
            if (!Number.isFinite(value) || value < 0) {
              return json(res, 400, { error: 'credits 必须是非负数字' });
            }
            try {
              const pool = qoderPool();
              await pool.scan();
              if (!pool.list().some((account) => account.id === accountId)) {
                return json(res, 404, { error: 'account not found' });
              }
              const reserves = { ...pool.creditReservesInOrder() };
              if (value <= 0) delete reserves[accountId];
              else reserves[accountId] = Math.floor(value);
              pool.applyConfig({ creditReserves: reserves });
              json(res, 200, { ok: true, creditReserves: reserves });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 刷新上游积分额度 ——
      //
      // 逐账号打 `GET {openapi}/api/v2/quota/usage`，把三池合计记回号池，
      // 于是「保留额度」判据立刻有值可用。失败的账号**不写余额**（保持
      // 未知），卡片显示「—」而不是「0」—— 把查不到显示成 0 会让用户
      // 误删好账号。单个账号失败不影响其它账号，故整体仍返回 200。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/credits/refresh`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const pool = qoderPool();
              await pool.scan();
              // 多窗口共享同一发在途请求：第二个窗口拿到的是同一份结果，
              // 而不是再打一轮上游。见 qoderCreditsInFlight 的说明。
              if (qoderCreditsInFlight === null) {
                qoderCreditsInFlight = refreshQoderPoolCredits(pool, { fetch }).finally(() => {
                  qoderCreditsInFlight = null;
                });
              }
              const result = await qoderCreditsInFlight;
              const now = Date.now();
              json(res, 200, {
                ok: true,
                refreshed: result.refreshed,
                failed: result.failed,
                // 逐账号结果里带上池的 id 与失败原因，前端据此在每张卡上
                // 就地显示「读失败」而不是让整页报错。
                accounts: result.accounts.map((entry) => ({
                  id: entry.id,
                  ok: entry.ok,
                  total: entry.ok ? entry.total : null,
                  ...(entry.ok ? { usage: entry.usage } : { message: entry.message }),
                })),
                status: pool.status(),
                pool: pool.list().map((account) => ({
                  id: account.id,
                  credits: pool.creditsOf(account.id) ?? null,
                  creditReserve: pool.creditReserveOf(account.id),
                  cooldownUntilMs: account.cooldownUntilMs,
                  cooling: account.cooldownUntilMs > now,
                })),
              });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 重置全部冷却 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/cooldowns/reset`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const pool = qoderPool();
              await pool.scan();
              pool.resetCooldowns();
              json(res, 200, { ok: true, status: pool.status() });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 移出池子：删除该账号的插件凭据（不碰桌面端登录态）——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/pool/remove`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            let body;
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const raw = Buffer.concat(chunks).toString('utf8').trim();
              body = raw === '' ? {} : JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
            if (accountId === '') return json(res, 400, { error: '缺少 accountId' });
            try {
              const removed = await qoderAuth.deleteQoderCredential({ dshHome: dshHomeDir(), accountId });
              if (removed.error !== undefined) return json(res, 500, { ok: false, error: removed.error });
              const pool = qoderPool();
              await pool.scan();
              json(res, 200, { ok: true, accounts: pool.list().length });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 登录：发起（返回 loginUrl，后台开始轮询）——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/login/start`,
          handler: async (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const r = await qoderAuth.beginLogin({ fetch });
              if (r.ok !== true) return json(res, 502, { error: r.message ?? '登录启动失败' });
              // 设备流不开监听端口：浏览器由服务端直接打开（打不开也不致命，
              // authUrl 已回给前端，用户可手动点）。
              let opened = false;
              try {
                await openInSystemBrowser(r.url);
                opened = true;
              } catch {
                /* 交给前端展示链接 */
              }
              json(res, 200, { sessionId: r.sessionId, authUrl: r.url, opened });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 登录：轮询状态；done 时落盘并让池重扫 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/login/status`,
          handler: async (req, res) => {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              if (typeof sessionId !== 'string' || sessionId === '') {
                return json(res, 400, { error: '缺少 session' });
              }
              const r = qoderAuth.stepLogin({ sessionId });
              if (r.error !== undefined) return json(res, 400, { error: r.error });
              if (r.status === 'pending') return json(res, 200, { status: 'pending' });
              if (r.status === 'failed') return json(res, 200, { status: 'failed', error: r.error });

              // ⚠ 必须 await：写盘是 async 的。漏掉 await 会在写盘完成前回 200，
              //   表现为「登录显示成功，但号池里没有这个账号」。
              const saved = await qoderAuth.saveQoderCredential({
                dshHome: dshHomeDir(),
                accessToken: r.accessToken,
                refreshToken: r.refreshToken,
                userId: r.userId,
                userName: r.userName,
                expiresAtMs: r.expiresAtMs,
              });
              if (saved.error !== undefined) {
                return json(res, 500, { status: 'failed', error: saved.error });
              }
              // 立刻让池重扫，不必等下次打开面板
              let accounts = 0;
              try {
                const pool = qoderPool();
                await pool.scan();
                accounts = pool.list().length;
              } catch {
                /* 扫描失败不影响本次登录结果 */
              }
              json(res, 200, { status: 'done', accountId: saved.accountId, accounts });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 登录：取消 ——
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/login/cancel`,
          handler: (req, res) => {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            try {
              const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
              json(res, 200, { cancelled: qoderAuth.cancelLogin(sessionId ?? '') });
            } catch (e) {
              json(res, 500, { error: e?.message ?? String(e) });
            }
          },
        }),
      );

      ctx.logger?.info?.(
        '[wotr-console] 管理页接口已挂载（history-summary / sample / wb+trae+qoder login / wb models refresh）',
      );
    });
  } catch (e) {
    ctx.logger?.warn?.(
      '[wotr-console] 管理页接口挂载失败（历史记录将不可用）：' + (e?.message ?? String(e)),
    );
    return null;
  }

  return () => {
    for (const d of disposers) {
      try {
        d?.();
      } catch {
        /* 忽略重复释放 */
      }
    }
    disposers.length = 0;
    mounted = false;
  };
}

export function apply(ctx, config = {}) {
  // —— 兜底扫一遍 LLM 注册表 ——
  //
  // 必须排在转发 apply **之前**：vendored 是在异步回调里注册的，
  // 上一实例的注册可能已经进表而 disposer 还没登记（见 clearStaleLlmRoutes）。
  // 不清就会撞 DUPLICATE_ADAPTER，然后 vendored 把已成功的注册也一起撤掉，
  // 结果是 workbuddy 模型彻底不可用。
  const staleLlm = clearStaleLlmRoutes(ctx, '重复 apply');

  // —— 把「模型池」交给 vendored 的 xdpool 实现 ——
  //
  // vendored 代码原样保留（MIT, (c) XDTrees），见 vendor/xdpool/。
  let poolDispose = null;
  try {
    const pool = xdpoolModule.apply(ctx, poolConfigFrom(config));
    if (typeof pool === 'function') poolDispose = pool;
    poolError = null;
    // apply 是异步注册 provider 的，等一小会儿确认它真的注册上了；
    // 没注册上就把原因记进 poolError 并写日志。
    watchLlmRegistration(ctx, staleLlm > 0);
  } catch (e) {
    poolError = {
      message: e && e.message ? e.message : String(e),
      stack: String(e && e.stack ? e.stack : '').slice(0, 1200),
      at: new Date().toISOString(),
    };
    ctx.logger?.error?.('[wotr-console] 模型池(xdpool) 启动失败：' + poolError.message);
  }

  // —— 数据目录：**刻意沿用合并前的旧路径**，历史数据直接续上 ——
  //
  // $DSH_HOME/plugin-data/dsh-workbuddy-console/{credit-samples,history,daily}.jsonl
  //
  // 目录名与包名不一致是**有意的**：合并改名时若跟着改成 dsh-wotr-console，
  // 已经落盘的积分与使用记录就全部读不到了。这里只认数据，不认包名。
  // 取不到 DSH_HOME 时退化为「不采集」而不是报错：管理页会显示暂无记录，
  // provider 功能不受影响。
  try {
    const home = resolveDshHome(ctx);
    if (home !== null) {
      creditStore.setDataDir(join(home, 'plugin-data', 'dsh-workbuddy-console'));
    } else {
      ctx.logger?.warn?.('[wotr-console] 未取到 DSH_HOME，积分采集已禁用（管理页仍可看实时额度）');
    }
  } catch (e) {
    ctx.logger?.warn?.('[wotr-console] 数据目录初始化失败：' + (e?.message ?? String(e)));
  }

  // —— 管理页的两条只读接口 ——
  //
  // 按需自注入 webServer，与 vendored 账号池路由同样做法。挂不上就跳过：
  // 管理页会显示"暂无记录"，provider 功能完全不受影响。
  const pageDispose = mountConsoleRoutes(ctx, config);

  ctx.logger?.info?.('[wotr-console] WorkBuddy provider 已注册（管理页在设置面板）');

  const cleanup = () => {
    // 卸载管理页路由
    if (typeof pageDispose === 'function') {
      try {
        pageDispose();
      } catch {
        /* 忽略重复释放 */
      }
    }
    // 卸载模型池那一半（provider / 账号池 / shim）
    if (typeof poolDispose === 'function') {
      try {
        poolDispose();
      } catch {
        /* 忽略重复释放 */
      }
      poolDispose = null;
    }
    // provider 注册是异步完成的，poolDispose 未必覆盖得到；
    // 进程级标记 + clearStaleLlmRoutes 兜住这条路径，否则下次热重载
    // 会撞 DUPLICATE_ADAPTER，workbuddy 模型直接消失。
    ownsLlmRoutes = false;
  };

  return cleanup;
}
