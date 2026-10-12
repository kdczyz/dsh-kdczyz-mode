/**
 * dsh-workbuddy-console — WorkBuddy 模型接入（纯 provider 插件）
 *
 * 形态与 dsh-connect-trae 一致：只做「把 WorkBuddy 桌面端的模型接进 DSH」，
 * 不注册任何 HTTP 路由、不提供独立 Web 控制台、不落盘任何额外数据。
 *
 * 它做的事情：
 *   - 通过 vendored 的 xdpool 实现注册两个 LLM provider：
 *       workbuddy-xdpool         国内版
 *       workbuddy-xdpool-global  国际版
 *   - 转发 vendored 的 Config schema，让 DSH 设置页能生成配置表单
 *   - 兜底清理热重载时残留的 LLM 注册，避免 DUPLICATE_ADAPTER
 *
 * 界面：全部走 DSH 内置的设置面板（同 Trae）。
 * 凭据：由 vendored xdpool 自己管理，本文件不读不写任何凭据文件。
 *
 * 相对官方 2.0.48 的修复（保留）：
 *   1. 工具定义丢失（legacyContext）—— 在 vendor/xdpool/lib/index.js
 *   2. 文本重复两遍（finish_reason 空串）—— 在 vendor/xdpool/lib/dsml-bridge.mjs
 *   3. 凭证未解密导致误报账号失效 —— 在 vendor/xdpool/lib/index.js
 *   4. macOS 拉起桌面版崩溃 —— 已随控制台一并移除（不再有此功能）
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 并入的模型池实现（原 dsh-workbuddy-xdpool，MIT，(c) XDTrees）。
// 见 vendor/xdpool/README.md —— 代码原样保留，便于与上游对照升级。
import * as xdpoolModule from '../vendor/xdpool/lib/index.js';
import * as creditStore from './credit-store.mjs';

export const name = 'workbuddy-console';

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
      `[workbuddy-console] 清掉 ${cleared} 条残留 LLM 注册（${reason}）：否则新实例会撞 DUPLICATE_ADAPTER，` +
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
                  '[workbuddy-console] provider 已注册，但可见模型为 0 —— 检查 modelSelectionCn.enabledModelIds',
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
      ctx.logger?.error?.('[workbuddy-console] ' + poolError.message);
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
 *   GET  /plugins/dsh-workbuddy-console/history-summary
 *        账号维度汇总 + 按天净变化，供「积分」「使用记录」两个 tab 渲染
 *   POST /plugins/dsh-workbuddy-console/sample
 *        让服务端去读一次最新额度并落盘采样（管理页打开时调用）
 *
 * 为什么采样要服务端做：额度数据在 vendored 的账号池里，浏览器只能通过
 * 它的 /status 路由拿；让前端把 /status 的结果回传再落盘，会把网络往返
 * 变成两跳，且前端能伪造写入内容。服务端直接调 vendored 更短也更可控。
 *
 * 返回 disposer；宿主没有 webServer 时返回 null（功能降级，不报错）。
 */
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

      const BASE = '/plugins/dsh-workbuddy-console';

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

      ctx.logger?.info?.('[workbuddy-console] 管理页接口已挂载（history-summary / sample）');
    });
  } catch (e) {
    ctx.logger?.warn?.(
      '[workbuddy-console] 管理页接口挂载失败（历史记录将不可用）：' + (e?.message ?? String(e)),
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
    ctx.logger?.error?.('[workbuddy-console] 模型池(xdpool) 启动失败：' + poolError.message);
  }

  // —— 数据目录：沿用控制台时代的路径，历史数据可直接续上 ——
  //
  // $DSH_HOME/plugin-data/dsh-workbuddy-console/{credit-samples,history}.jsonl
  // 取不到 DSH_HOME 时退化为「不采集」而不是报错：管理页会显示暂无记录，
  // provider 功能不受影响。
  try {
    const home = resolveDshHome(ctx);
    if (home !== null) {
      creditStore.setDataDir(join(home, 'plugin-data', 'dsh-workbuddy-console'));
    } else {
      ctx.logger?.warn?.('[workbuddy-console] 未取到 DSH_HOME，积分采集已禁用（管理页仍可看实时额度）');
    }
  } catch (e) {
    ctx.logger?.warn?.('[workbuddy-console] 数据目录初始化失败：' + (e?.message ?? String(e)));
  }

  // —— 管理页的两条只读接口 ——
  //
  // 按需自注入 webServer，与 vendored 账号池路由同样做法。挂不上就跳过：
  // 管理页会显示"暂无记录"，provider 功能完全不受影响。
  const pageDispose = mountConsoleRoutes(ctx, config);

  ctx.logger?.info?.('[workbuddy-console] WorkBuddy provider 已注册（管理页在设置面板）');

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
