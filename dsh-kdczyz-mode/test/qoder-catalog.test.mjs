/**
 * qoder-catalog.mjs 的测试。
 *
 * # 这里最重要的一条：目录**永不为空**
 *
 * DSH 会因 `INVALID_MODEL_CONTEXT` 拒掉整个 provider，且判据是 per-provider
 * 的 —— **一行模型缺 contextWindow，整个 region 下线**。而空目录等于「这个
 * provider 没有任何模型」，同样是下线。
 *
 * 所以「拉取失败时目录会变成什么样」是最该钉住的行为：它必须**回落到兜底**，
 * 而不是清空、也不是抛错。这类 bug 的后果是「模型选择器里 Qoder 整个消失」，
 * 而日志里只有一行 warn，很容易被当成「没登录而已」。
 *
 * 运行：node test/qoder-catalog.test.mjs
 */

import {
  QODER_FALLBACK_CONTEXT_WINDOW,
  QODER_FALLBACK_MODELS,
  QoderCatalog,
  qoderInputModalities,
} from '../lib/qoder-catalog.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};

const CRED = { accessToken: 'dt-xyz', userId: 'u-1', userName: 'alice' };

/** 造一个假 fetcher；`script` 按调用序号返回响应 */
const fakeFetcher = (script) => {
  let n = 0;
  return async () => {
    const item = script[Math.min(n, script.length - 1)];
    n += 1;
    if (item instanceof Error) throw item;
    return item;
  };
};
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

console.log('Qoder 模型目录\n');

/* —— 1) 兜底目录本身必须合规 —— */
ok('兜底目录非空（空目录 = provider 下线）', QODER_FALLBACK_MODELS.length > 0);
{
  const cat = new QoderCatalog({ fetcher: fakeFetcher([jsonResponse({ models: [] })]) });
  const all = cat.current();
  ok('初始目录非空', all.length > 0);
  ok(
    '每一条都有正整数 contextWindow（缺一行整个 provider 下线）',
    all.every((m) => Number.isInteger(m.contextWindow) && m.contextWindow > 0),
  );
  ok('每一条都有 maxTokens', all.every((m) => Number.isInteger(m.maxTokens) && m.maxTokens > 0));
  ok('每一条都有 id', all.every((m) => typeof m.id === 'string' && m.id !== ''));
  ok('初始标记为「在用兜底」', cat.usingFallback() === true);
}

/* —— 2) 拉取成功 —— */
{
  const cat = new QoderCatalog({
    fetcher: fakeFetcher([jsonResponse({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] })]),
  });
  const r = await cat.refresh(CRED);
  ok('拉取成功返回 ok', r.ok === true);
  ok('目录被替换成上游结果', r.models.length === 2 && r.models[0].id === 'm1');
  ok('不再标记为兜底', cat.usingFallback() === false);
  ok('无错误', cat.lastError() === undefined);
  ok('current() 反映新目录', cat.current()[0].id === 'm1');
  ok(
    '拉取到的条目也被补上 contextWindow',
    cat.current().every((m) => Number.isInteger(m.contextWindow) && m.contextWindow > 0),
  );
  ok('name 缺失时不影响列出', cat.current()[1].id === 'm2');
}

/* —— 3) 各种失败都必须回落、且目录不空 —— */
for (const [label, script] of [
  ['网络异常', [new Error('boom')]],
  ['HTTP 401（未登录/签名错）', [jsonResponse('{"code":"TOKEN_INVALID"}', 401)]],
  ['HTTP 403（签名不一致）', [jsonResponse('forbidden', 403)]],
  ['HTTP 500', [jsonResponse('err', 500)]],
  ['响应是坏 JSON', [jsonResponse('not json')]],
  ['响应里没有模型条目', [jsonResponse({ foo: 1 })]],
  ['响应是空数组', [jsonResponse({ models: [] })]],
]) {
  const cat = new QoderCatalog({ fetcher: fakeFetcher(script) });
  let err = null;
  let r = null;
  try {
    r = await cat.refresh(CRED);
  } catch (e) {
    err = e;
  }
  ok(`${label}：不抛异常`, err === null, err?.message);
  ok(`${label}：返回 ok:false`, r?.ok === false);
  ok(
    `${label}：current() 目录**不为空**（否则 provider 下线）`,
    cat.current().length > 0,
    `实际 ${cat.current().length} 条`,
  );
  // 返回给调用方的那一份也必须不为空 —— 只测 current() 会漏掉「refresh 返回了
  // 空数组、但 current() 自己又补了兜底」这种不一致。
  ok(
    `${label}：refresh() 返回的 models 也不为空`,
    Array.isArray(r?.models) && r.models.length > 0,
    `实际 ${r?.models?.length} 条`,
  );
  ok(`${label}：带错误信息`, typeof r?.message === 'string' && r.message !== '');
  ok(`${label}：仍标记为兜底`, cat.usingFallback() === true);
}

/* —— 4) 拉到了但解析不出 → 保留旧目录（不倒退）—— */
{
  let n = 0;
  const cat = new QoderCatalog({
    fetcher: async () => {
      n += 1;
      return n === 1
        ? jsonResponse({ models: [{ id: 'good1' }, { id: 'good2' }] })
        : jsonResponse({ models: [] });
    },
  });
  const first = await cat.refresh(CRED);
  ok('第一次拉到 2 条', first.ok === true && cat.current().length === 2);
  const second = await cat.refresh(CRED);
  ok('第二次解析不出时 ok:false', second.ok === false);
  ok(
    '**保留**已有目录而不是清空（不让 provider 下线）',
    cat.current().length === 2 && cat.current()[0].id === 'good1',
  );
}

/* —— 5) 凭据不完整 —— */
{
  const cat = new QoderCatalog({ fetcher: fakeFetcher([jsonResponse({ models: [{ id: 'x' }] })]) });
  const r = await cat.refresh({ accessToken: 'dt-x' }); // 缺 userId
  ok('缺 userId 时 ok:false', r.ok === false);
  ok('缺 userId 时目录仍不为空', cat.current().length > 0);
  ok('错误信息说明了原因', /userId|accessToken/.test(r.message ?? ''), r.message);
  ok('无凭据不抛', (await cat.refresh(undefined)).ok === false);
}

/* —— 6) 无 fetcher —— */
{
  const cat = new QoderCatalog({});
  const prev = globalThis.fetch;
  globalThis.fetch = undefined;
  const r = await cat.refresh(CRED);
  ok('没有 fetcher 时 ok:false 且不抛', r.ok === false);
  ok('没有 fetcher 时目录不为空', cat.current().length > 0);
  globalThis.fetch = prev;
}

/* —— 7) 兜底常量合理 —— */
ok('兜底 contextWindow 是正数', QODER_FALLBACK_CONTEXT_WINDOW > 0);
ok('兜底目录 id 无重复', new Set(QODER_FALLBACK_MODELS.map((m) => m.id)).size === QODER_FALLBACK_MODELS.length);

/**
 * 兜底表的内容断言。
 *
 * 兜底表是**真机目录的快照**（2026-10-11 实测 14 条 chat 模型，13 条 `is_vl`），
 * 所以这里把条数、图片分布和 id 一起钉住：
 *
 *   - 少一条 = 上游目录拉不到时用户会少看到模型；
 *   - 图片标记写错 = 直接复现「不支持图片」那个 bug（兜底表会在没登录/刚装好
 *     第一次启动时生效，正是最容易出问题的那段时间）。
 *
 * 上游若真的改了模型清单，这条会红 —— 那是**应该**红：兜底表要跟着更新。
 */
ok('兜底目录 14 条（与真机 chat 组一致）', QODER_FALLBACK_MODELS.length === 14, String(QODER_FALLBACK_MODELS.length));
ok(
  '兜底目录 13 条声明支持图片',
  QODER_FALLBACK_MODELS.filter((m) => m.supportsImages === true).length === 13,
  String(QODER_FALLBACK_MODELS.filter((m) => m.supportsImages === true).length),
);
ok(
  '唯一不支持图片的是 mmodel（MiniMax-M2.7，真机 is_vl:false）',
  QODER_FALLBACK_MODELS.filter((m) => m.supportsImages !== true)
    .map((m) => m.id)
    .join(',') === 'mmodel',
  QODER_FALLBACK_MODELS.filter((m) => m.supportsImages !== true)
    .map((m) => m.id)
    .join(','),
);
ok(
  '每条都带严格布尔 supportsImages（不留 undefined）',
  QODER_FALLBACK_MODELS.every((m) => typeof m.supportsImages === 'boolean'),
);
ok(
  '兜底表覆盖 dfmodel 且标为支持图片（用户默认模型就是它）',
  QODER_FALLBACK_MODELS.some((m) => m.id === 'dfmodel' && m.supportsImages === true),
);

/* —— 8) `is_vl` → 图片能力：这就是「支持图片的模型不能发图」的根因 —— */
{
  const body = JSON.stringify({
    chat: [
      { key: 'dfmodel', display_name: 'DeepSeek-Flash', is_vl: true },
      { key: 'mmodel', display_name: 'MiniMax-M2.7', is_vl: false },
      { key: 'nomodel', display_name: '没给标记' },
      { key: 'strmodel', display_name: '字符串 true', is_vl: 'true' },
      { key: 'nullmodel', display_name: 'null', is_vl: null },
    ],
  });
  const cat = new QoderCatalog({ fetcher: fakeFetcher([jsonResponse(body)]) });
  const r = await cat.refresh(CRED);
  const byId = new Map(cat.current().map((m) => [m.id, m]));
  ok('上游给了 5 条就解析出 5 条', r.ok === true && cat.current().length === 5, String(cat.current().length));
  ok('is_vl:true → supportsImages:true（dfmodel）', byId.get('dfmodel')?.supportsImages === true);
  ok('is_vl:false → supportsImages:false（mmodel）', byId.get('mmodel')?.supportsImages === false);
  // 下面三条都要求「不猜」：宁可少发图片（用户能手动补勾），也不能对纯文本
  // 模型声明 image —— 那会让 DSH 把图片发出去，由上游在准入之后拒绝。
  ok('缺 is_vl → 纯文本', byId.get('nomodel')?.supportsImages === false);
  ok('is_vl 是字符串 "true" → 纯文本（严格布尔）', byId.get('strmodel')?.supportsImages === false);
  ok('is_vl:null → 纯文本', byId.get('nullmodel')?.supportsImages === false);
  ok(
    '每条都带布尔 supportsImages（归一化不留 undefined）',
    cat.current().every((m) => typeof m.supportsImages === 'boolean'),
  );
}

/* —— 9) 共用谓词：provider 侧与选择器侧必须同源 —— */
{
  // 这两处（toPiModel 与 registerModelDiscovery）各写一份 `input` 就会
  // 出现「能发图但界面说不能」或反之，所以只允许有一个判据。
  ok(
    'supportsImages:true → ["text","image"]',
    qoderInputModalities({ supportsImages: true }).join(',') === 'text,image',
    qoderInputModalities({ supportsImages: true }).join(','),
  );
  ok('supportsImages:false → 只有 text', qoderInputModalities({ supportsImages: false }).join(',') === 'text');
  ok('缺字段 → 只有 text（不猜）', qoderInputModalities({}).join(',') === 'text');
  ok('undefined 也不抛', qoderInputModalities(undefined).join(',') === 'text');
}

/* —— 10) 并发刷新只打一次上游 —— */
{
  // 启动种子 / 登录后补拉 / 手动刷新三个触发点会撞在一起。除了浪费请求，
  // 真正的危害是**先发的慢响应覆盖后发的快响应**，所以必须合并。
  let calls = 0;
  const cat = new QoderCatalog({
    fetcher: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return jsonResponse({ chat: [{ key: 'a1', display_name: 'A1', is_vl: true }] });
    },
  });
  const [r1, r2] = await Promise.all([cat.refresh(CRED), cat.refresh(CRED)]);
  ok('两次并发 refresh 只打了一次上游', calls === 1, `实际 ${calls} 次`);
  ok('两次都拿到同一份结果', r1?.ok === true && r2?.ok === true && r2.models[0].id === 'a1');
  await cat.refresh(CRED);
  ok('刷新结束后能重新打（不是永久复用旧 promise）', calls === 2, `实际 ${calls} 次`);
  ok('并发期间不影响目录可用', cat.current().length === 1 && cat.current()[0].id === 'a1');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
