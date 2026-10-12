/**
 * kdczyz-dsh-model —— **WorkBuddy 半边**的宿主入口（合并后的包根）。
 *
 * 本包把两个原本独立的插件合并成「一个包、两个 Loader 入口」：
 *
 *   entry A  name: kdczyz-dsh-model        -> 本文件        WorkBuddy 池半边
 *   entry B  name: kdczyz-dsh-model/trae   -> lib/trae.js   Trae 半边
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
import {
  fetchQoderQuotaUsage,
  refreshQoderPoolCredits,
  resolveQoderServingCredits,
} from './qoder-credits.mjs';
import { checkinQoderAccount } from './qoder-campaign.mjs';
// 跨 Loader 入口取 Qoder provider 的句柄（目录刷新）。这里只是**读**那个模块的
// 模块级状态，不改 `lib/qoder.js` 的 `apply` 引用同一性 —— 它作为独立入口注册
// 的约束不受影响。
import { currentQoderApi } from './qoder.js';

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
 *   GET  /plugins/kdczyz-dsh-model/history-summary
 *        账号维度汇总 + 按天净变化，供「积分」「使用记录」两个 tab 渲染
 *   POST /plugins/kdczyz-dsh-model/sample
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

/**
 * 只给**回退单例**用的 logger（`apply` 时从宿主 ctx 取一次）。
 *
 * provider 就绪时 `qoderPool()` 返回的是 provider 的池，那边已经带了
 * `ctx.logger`（见 lib/qoder.js）—— 这里管的只是「provider 还没就绪」那条
 * 极早路径：那时池仍要能说出「谁被限流 / 为什么让位」，不能因为少个 logger
 * 就把唯一的可观测痕迹丢掉。
 */
let qoderPoolLogger;

export function qoderPool() {
  /**
   * **优先复用 provider 入口那个池。**
   *
   * 这里曾经无条件新建自己的池实例，于是同一个进程里有两个池：管理页在 A 上
   * 切「当前账号」，请求路径（provider 入口）用的是 B —— B 的 `selectedId`
   * 一直是 undefined，`acquire()` 便按池内顺序取第一个账号。用户看到的现象
   * 就是「固定了账号，请求还是打到别的号上」。
   *
   * `currentQoderApi()` 是本模块与 provider 入口之间**既有的**模块级句柄
   * （见 lib/qoder.js 顶部的说明），provider 注册成功后才可用。它可用时两边
   * 就是**同一个对象**：选择、冷却、停用、保留额度、使用时刻全部一份，不存在
   * 对不上的可能。只有 provider 还没就绪（极早的路由调用、或单测没装 provider）
   * 时才退回自建实例。
   */
  const shared = currentQoderApi()?.pool;
  if (shared !== undefined && shared !== null) return shared;
  if (qoderPoolSingleton === null) {
    qoderPoolSingleton = new QoderAccountPool({
      store: new QoderCredentialStore({ dshHome: dshHomeDir() }),
      logger: qoderPoolLogger,
    });
  }
  return qoderPoolSingleton;
}

/** 测试/诊断用：丢掉单例，让下次调用重建。 */
export function resetQoderPool() {
  qoderPoolSingleton = null;
}

/**
 * 「Qoder 现在是谁在被调用，它还剩多少积分」。
 *
 * 实现整体在 `lib/qoder-credits.mjs` 的 `resolveQoderServingCredits()` 里 ——
 * 那是纯函数（只依赖池与 fetch），因此能在单测里直接跑；这里只负责宿主侧的
 * 两件事：拿到单例池、把「显示侧节流窗口」传下去。
 *
 * 节流的理由：界面上（账号页 / Qoder 号池页 / 额度胶囊）都是 30 秒一拍，而
 * Qoder 的额度查询是**真的打上游**。若每拍都真读，「谁在被调用」这个纯显示
 * 需求就会变成「开着设置面板的窗口稳定地每 30 秒打一次额度接口」。余额是
 * 分钟级变化的东西，30 秒的精度毫无意义，所以显示侧只在「没读到过」或
 * 「上次读到已经超过 QODER_DISPLAY_CREDIT_FRESH_MS」时才真读。
 *
 * **手动刷新不受它限制**：人点了「刷新积分」走 `refreshQoderPoolCredits`
 * （不带 sinceMs 即全读），点了就该看到新数字。
 */
const QODER_DISPLAY_CREDIT_FRESH_MS = 180000;

/** 从 `?model=` 里取模型 id；缺失或畸形都返回 undefined（按不带模型处理）。 */
function modelIdOf(req) {
  try {
    const raw = new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('model');
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function resolveQoderServing(pool, options = {}) {
  return resolveQoderServingCredits(pool, {
    now: options.now,
    modelId: options.modelId,
    freshMs: QODER_DISPLAY_CREDIT_FRESH_MS,
    fetch,
  });
}

/**
 * 挂载管理页的只读路由。
 *
 * 导出它**只为测试**：路由表（尤其 `/qoder/pool` 快照里那几个字段）是这个包
 * 的对外契约，而先前只有「拿夹具渲染」这一层覆盖 —— 快照少一个字段、或者旧的四条
 * 写路由被谁加回来，渲染测试全绿也照样发布出去。加回来恰恰是本 bug 的形状
 * （写的地方与用的地方不是同一个池），所以这里必须有直接对着路由的断言。
 */
export function mountConsoleRoutes(ctx, config) {
  if (!ctx || typeof ctx.inject !== 'function') return null;

  const disposers = [];
  let mounted = false;

  try {
    ctx.inject(['webServer'], (web) => {
      const webServer = web?.webServer ?? ctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      if (mounted) return;
      mounted = true;

      const BASE = '/plugins/kdczyz-dsh-model';

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

              // 登录完成 → 落盘凭据到 DSH 主目录下的 `.wb-auth`（vendored 池
              // 现在也扫这个目录），让池下次扫描就能认出这个新账号；不写桌面端
              // app 目录 —— 删掉桌面 app 也不影响插件账号，桌面登录态照常被扫。
              const dir = wbAuth.dshAuthDir(xdpoolModule.dshHome?.() ?? join(homedir(), '.dsh'));
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
              /**
               * 出快照前先把设置里的号池配置推给池。
               *
               * 用户点「切换到此账号」→ 写设置 → 这里读快照，中间只差一次
               * `loader/volatile-update` 事件；不等它就先推一次，页面刷新出来
               * 的「当前使用」就一定是刚点的那一个。
               */
              currentQoderApi()?.syncPoolConfig?.();
              const pool = qoderPool();
              await pool.scan();
              const now = Date.now();
              // `?model=` 曾用于逐模型冷却的预告选号；冷却已删除，仅保留解析
              // 以兼容旧调用。
              const modelId = modelIdOf(req);
              /**
               * 界面上标「当前使用」的那一个 —— 完全手动语义：只有用户显式选中
               * 且还在池里的账号（见 `QoderAccountPool.effectiveSelectedAccountId`），
               * 没选就是 null。
               *
               * 刻意**不是**「本次调用」那一个：`serving` 回答的是「这一轮真的
               * 扣了谁的钱」，两者都要如实展示，混成一个字段就再也说不清
               * 「我选的」和「实际用的」。
               */
              const effectiveSelected = pool.effectiveSelectedAccountId() ?? null;
              json(res, 200, {
                ok: true,
                disabledIds: pool.disabledIdsInOrder(),
                // 用户**显式**选中的账号（null = 没选过，界面提示手动切换）。
                selectedAccountId: pool.selectedAccountId() ?? null,
                // 实际会显示成「当前使用」的那一个。
                effectiveSelectedAccountId: effectiveSelected,
                lastServedId: pool.lastServedId() ?? null,
                status: pool.status(),
                accounts: pool.list().map((account) => ({
                  id: account.id,
                  label: account.label,
                  userId: account.credential.userId ?? '',
                  expiresAtMs: account.credential.expiresAtMs ?? 0,
                  expired: (account.credential.expiresAtMs ?? 0) > 0 && (account.credential.expiresAtMs ?? 0) <= now,
                  disabled: pool.isDisabled(account.id),
                  selected: effectiveSelected === account.id,
                  credits: pool.creditsOf(account.id) ?? null,
                })),
                // 「谁在被调用 + 它还剩多少」—— 界面与额度胶囊**唯一**该读的字段。
                // 见 resolveQoderServing 的注释（为什么要单独算、为什么要按需读一次）。
                serving: await resolveQoderServing(pool, { now, modelId }),
              });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 池配置（停用 / 当前账号）**没有路由** ——
      //
      // 这四件事以前各有 POST 路由（`/qoder/pool/config`、`/pool/account`、
      // `/pool/select`、`/pool/credit-reserve`），但它们改的只是**本入口**这个
      // 池实例：provider 入口是另一个 Loader 入口、另一个池，请求路径根本不读
      // 这里写下的值。于是「固定了账号，请求还是打到别的号上」——写的地方与用的
      // 地方不是同一个对象，而且重启即丢。
      //
      // 现在与 Trae 半边**同一条链**：
      //
      //   设置页写 `dsh-connect-qoder` 的 `selectedAccountId` /
      //   `disabledAccountIds`（见 lib/console.mjs 的 qoder* 写入助手，读回
      //   确认落地）
      //     → 宿主发 `loader/volatile-update`
      //     → lib/qoder.js 重新解引用配置并 `pool.applyConfig()`
      //     → `pool.acquire()` 用新的「当前账号」
      //
      // 两件套因此都**持久化**（重启后仍是它），并且只有一个真相来源。
      // 管理页这边只读不写：上面的 `/qoder/pool` 快照会先调
      // `syncPoolConfig()` 再出数据，所以点完按钮刷新看到的立刻是新值。
      // 冷却 / 保留额度 / 分配策略已随「完全手动」一并删除，无运行时状态可清。

      // —— 刷新上游积分额度 ——
      //
      // 逐账号打 `GET {openapi}/api/v2/quota/usage`，把三池合计记回号池，
      // 卡片据此显示余额。失败的账号**不写余额**（保持未知），卡片显示
      // 「—」而不是「0」—— 把查不到显示成 0 会让用户误删好账号。
      // 单个账号失败不影响其它账号，故整体仍返回 200。
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
                // 「谁在被调用 + 它还剩多少」。刷新刚写过余额，所以这里不会再
                // 打上游（新鲜窗口内直接复用），只是把口径统一到同一个字段上，
                // 免得前端一半读 `pool[].credits`、一半读 `serving.credits`。
                serving: await resolveQoderServing(pool, { now }),
              });
            } catch (e) {
              json(res, 500, { ok: false, error: e?.message ?? String(e) });
            }
          },
        }),
      );

      // —— 每日签到（活动线）——
      //
      // 与 Trae 侧同一条设计约束：**签的是"某一个账号"，不切换当前服务的账号**。
      // 请求体给 `accountId` 就签那一个；不给就签"当前使用"那一个（界面上就是
      // 卡片标着「当前使用」的那张）。整条链只取一次凭据、只发两次上游请求，
      // 全程不碰 `pool.selectAccount()` —— 签到是"顺手领 100 Credits"，
      // 没有任何理由把用户正在用的账号换掉。
      //
      // 端点与头见 `lib/qoder-campaign.mjs` 顶部：签到链要 `Cosy-ClientType: 10`
      // （额度链是 5），用错了服务端会回一个「今天没有活动」的空列表而不是报错。
      //
      // 冷却中/已停用的账号**照样可以签到**：领的是活动 Credits，不与请求额度
      // 的可用性挂钩，也没有任何选号参与。所以这里刻意不查 `isUsable`。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/checkin`,
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
            const wantedId = typeof body?.accountId === 'string' ? body.accountId : '';

            try {
              const pool = qoderPool();
              await pool.scan();
              const accounts = pool.list();
              if (accounts.length === 0) {
                return json(res, 200, {
                  ok: false,
                  code: 'no-account',
                  message: '号池里还没有账号，先在下方登录一个 Qoder 账号',
                });
              }
              // 不给 accountId = 签「当前使用」那一个；池里显式选中的没了就退回第一个，
              // 与界面「当前使用」的算法（effectiveSelectedAccountId）同一个口径。
              const target =
                wantedId === ''
                  ? (accounts.find((a) => a.id === pool.effectiveSelectedAccountId()) ?? accounts[0])
                  : accounts.find((a) => a.id === wantedId);
              if (target === undefined) {
                return json(res, 404, { ok: false, code: 'not-found', error: 'account not found' });
              }

              const result = await checkinQoderAccount(target.credential, { fetch });

              /**
               * 顺带把该账号的余额读回来。
               *
               * 只在签到链**成功**（真领到 或 今天已领过）时读：失败时余额没有
               * 变化，多打一次上游只是噪声。读不到就 `credits: null` ——
               * 绝不退化成 0（见 `fetchQoderQuotaUsage` 的注释）。
               * 用 `rememberCredits` 而不是 `noteCredits`：顺带更新「读到的时刻」，
               * 于是界面上的余额立刻是新的，不必再点一次「刷新积分」。
               */
              let credits = null;
              if (result.ok === true) {
                const usage = await fetchQoderQuotaUsage(target.credential, { fetch });
                if (usage.ok) {
                  const total = pool.rememberCredits(target.id, usage.total);
                  credits = { total, usage: usage.usage };
                }
              }

              const campaign = result.campaign;
              json(res, 200, {
                ok: result.ok === true,
                accountId: target.id,
                label: target.label ?? '',
                // 两个语义**分开**：`claimed` = 这一下真领到了；`alreadyCheckedIn` =
                // 今天早就领过了。混成一个，界面每天都会喊一次「签到成功 +100」。
                claimed: result.claimed === true,
                alreadyCheckedIn: result.alreadyCheckedIn === true,
                code: result.code ?? '',
                message: result.message ?? '',
                claimStatus: result.claimStatus ?? campaign?.claimStatus ?? '',
                campaignId: campaign?.campaignId ?? '',
                campaignKey: campaign?.campaignKey ?? '',
                amount: result.claim?.amount ?? campaign?.benefit?.amount ?? null,
                kind: result.claim?.kind || campaign?.benefit?.kind || '',
                validDays: result.claim?.validDays ?? campaign?.benefit?.validDays ?? null,
                title: campaign?.content?.title ?? '',
                description: campaign?.content?.description ?? '',
                detailUrl: campaign?.content?.detailUrl ?? '',
                panelUrl: campaign?.campaignUrl ?? '',
                windowEndsAtMs: campaign?.endAtMs ?? null,
                // 只有营销活动时把它们的 key 带出来：「为什么没有签到活动」要答得出来。
                otherCampaignKeys: result.otherCampaignKeys ?? [],
                credits,
                checkedAtMs: Date.now(),
              });
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

      // —— 刷新模型目录 ——
      //
      // Qoder 的目录由**另一个 Loader 入口**（`lib/qoder.js`）持有，本文件拿不到
      // 它的实例，只能通过模块级句柄 `currentQoderApi()` 请求刷新。并发合并放在
      // 目录自己那侧（`QoderCatalog.refresh` 的 inflight），这里不必再挡一层。
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: `${BASE}/qoder/models/refresh`,
          handler: async (req, res) => {
            // GET  = 只读当前目录（打开面板时用，不触上游、不花额度）
            // POST = 先刷上游再回读（「从 Qoder 刷新」按钮：拉取即落盘，见
            //        lib/console.mjs 的 refreshFromUpstream）
            if (req.method !== 'POST' && req.method !== 'GET') {
              return json(res, 405, { error: 'method not allowed' });
            }
            if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
            const api = currentQoderApi();
            if (api === undefined) {
              return json(res, 503, { ok: false, error: 'Qoder provider 尚未就绪，稍后再试' });
            }
            /**
             * 回给前端的目录快照。
             *
             * 用 `directory()`（上游原样）而**不是** `models()`（已按勾选过滤）：
             * 卡片要能列出被取消勾选的模型，否则一取消就从列表里消失、再也勾不
             * 回来。过滤态由 `enabledModelIds` 自己表达。
             */
            const snapshot = () => ({
              models: api.directory().map((m) => ({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
                supportsImages: m.supportsImages === true,
                // 积分倍率（上游 `price_factor`）透传给管理页，让 Qoder 模型卡与
                // Trae 一样在名称后显示 `x倍率`。`undefined` = 上游没给倍率，页面
                // 保持原名。
                ...(m.priceFactor === undefined ? {} : { priceFactor: m.priceFactor }),
              })),
              usingFallback: api.catalog.usingFallback(),
              lastFetchAtMs: api.catalog.lastFetchAtMs(),
              // 接线自述（`imageAttachments` = 图片链路第二层是否接上）。部署后
              // 要重启 DSH 才生效，这个字段让「跑的是哪一版代码」直接从回执里
              // 读出来，不必靠「试发一张图」判断。
              capabilities: api.capabilities?.() ?? {},
            });
            if (req.method === 'GET') return json(res, 200, { ok: true, ...snapshot() });
            try {
              const result = await api.refreshCatalog();
              if (result?.ok !== true) {
                // 拉取失败**不等于**没有目录：`models` 仍是当前可用的那份（兜底或
                // 上一次成功的），照旧回给前端，让它能把「失败了但仍能用哪些」画出来。
                return json(res, 502, {
                  ok: false,
                  error: result?.message ?? '刷新模型目录失败',
                  ...snapshot(),
                });
              }
              json(res, 200, { ok: true, ...snapshot() });
            } catch (e) {
              json(res, 502, { ok: false, error: e?.message ?? String(e) });
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
              // 顺带补拉一次模型目录：provider 启动时如果池里还没账号，会一直停在
              // 静态兜底表上（表只有 14 行真机快照，且没有上游的新增/改名）—— 这就是
              // 「登录了但模型不对」的来源。放 `await` 是为了让面板紧接着拿到的就是
              // 真目录；失败与登录无关，只记不报。
              try {
                await currentQoderApi()?.refreshCatalog();
              } catch (e) {
                ctx.logger?.warn?.('[wotr-console] 登录后刷新 Qoder 模型目录失败', e);
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
  // 目录名与包名不一致是**有意的**：合并改名时若跟着改成 kdczyz-dsh-model，
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
  //
  // 先给回退单例备好 logger：`/qoder/pool` 可能在 provider 就绪前就被调到，
  // 那时池仍要能说出「为什么让位」（见 qoderPoolLogger 的说明）。
  qoderPoolLogger = ctx.logger;
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
