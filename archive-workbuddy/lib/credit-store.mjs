/**
 * credit-store.mjs — 积分采样与签到历史的本地存储。
 *
 * 背景：这两个文件原先由控制台时代的 lib/credit-samples.mjs 与 lib/history.mjs
 * 写入，控制台移除后采集链路断了（数据停在 2026-10-09 16:47）。本模块恢复采集，
 * 且**沿用完全相同的文件格式与路径**，所以历史数据可以直接续上：
 *
 *   $DSH_HOME/plugin-data/dsh-workbuddy-console/credit-samples.jsonl
 *     每行: { ts, day, uid, nickname, credit }
 *   $DSH_HOME/plugin-data/dsh-workbuddy-console/history.jsonl
 *     每行: { ts, day, uid, nickname, credit, checkedIn, streakDays, source }
 *   另外新增（本模块引入，用于算准「每日净变化」）：
 *   $DSH_HOME/plugin-data/dsh-workbuddy-console/daily.jsonl
 *     每行: { day, uid, nickname, first, firstTs, last, lastTs, n }
 *
 * **为什么要有 daily.jsonl**：samples 按 (day, uid) 去重后会丢掉当天的最初值，
 * 于是「当天最后 - 当天最初」的净变化永远算成 0。daily 专门记录首末两端，
 * 与 samples 的去重策略解耦 —— samples 用于看「最新快照」，daily 用于看趋势。
 *
 * 设计要点：
 *   - **追加写 + 同一 (day, uid) 去重**：同一账号同一天只保留最后一条，
 *     避免轮询刷爆文件（原实现就是这个语义）。
 *   - **整文件重写用临时文件 + rename**：中途崩溃不会留下半截 JSON。
 *   - **出错绝不上抛**：采集失败不能影响 provider 主功能。
 *   - 文件锁：同一进程内串行化，避免并发写互相覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 一个账号一天的积分快照 */
const SAMPLE_KEEP_DAYS = 120;
/** history 保留天数（比 samples 长，因为要算连续签到） */
const HISTORY_KEEP_DAYS = 400;

let dataDir = null;
let queue = Promise.resolve();

/**
 * 设置数据目录。由 index.js 在 apply 时调用（用 DSH 的 plugin-data 路径）。
 * 传 null 表示禁用采集（例如宿主没提供路径）。
 */
export function setDataDir(dir) {
  dataDir = dir ?? null;
}

export function getDataDir() {
  return dataDir;
}

function filePath(kind) {
  if (dataDir === null) return null;
  const name =
    kind === 'samples' ? 'credit-samples.jsonl' : kind === 'history' ? 'history.jsonl' : 'daily.jsonl';
  return path.join(dataDir, name);
}

/** 本地日期 YYYY-MM-DD（不是 UTC，避免跨时区把一天的记录劈成两天） */
export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读 jsonl，坏行跳过（手工编辑过或写一半的文件不应让整份数据不可用） */
function readJsonl(file) {
  if (file === null || !fs.existsSync(file)) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/** 原子写：先写同目录临时文件再 rename，避免半截内容 */
function writeJsonlAtomic(file, rows) {
  if (file === null) return false;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 丢掉超过 keepDays 的旧记录 */
function prune(rows, keepDays) {
  const cutoff = Date.now() - keepDays * 86400000;
  return rows.filter((r) => {
    const ts = typeof r?.ts === 'number' ? r.ts : 0;
    return ts >= cutoff;
  });
}

/**
 * 同一 (day, uid) 只保留最后一条。
 * 输入按时间升序时，等价于「当天最后一次观测覆盖之前的」。
 */
function dedupeByDayUid(rows) {
  const map = new Map();
  for (const r of rows) {
    const uid = typeof r?.uid === 'string' ? r.uid : '';
    const day = typeof r?.day === 'string' ? r.day : '';
    if (uid === '' || day === '') continue;
    map.set(`${day}\u0000${uid}`, r);
  }
  return [...map.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/**
 * 记录一批账号的积分快照。传进来的每个 account 应含
 * { id, nickname, credits: { total } }。
 *
 * @returns {Promise<{ok: boolean, samples: number, history: number}>}
 */
export function recordStatus(accounts, opts = {}) {
  // 串行化：多次轮询可能并发进来，避免读-改-写互相覆盖
  queue = queue.then(() => doRecord(accounts, opts)).catch(() => {});
  return queue;
}

async function doRecord(accounts, opts) {
  if (dataDir === null) return { ok: false, samples: 0, history: 0 };
  if (!Array.isArray(accounts) || accounts.length === 0) return { ok: true, samples: 0, history: 0 };

  const ts = Date.now();
  const day = localDay(ts);
  const source = typeof opts.source === 'string' ? opts.source : 'status';

  const sampleRows = [];
  const historyRows = [];
  for (const a of accounts) {
    if (!a || typeof a !== 'object') continue;
    const uid = typeof a.id === 'string' ? a.id : '';
    if (uid === '') continue;
    const credit = typeof a.credits?.total === 'number' ? a.credits.total : undefined;
    const nickname = typeof a.nickname === 'string' ? a.nickname : (typeof a.label === 'string' ? a.label : '');
    // 积分拿不到（如账号在冷却）就跳过这一条，不要把 undefined 写成 0
    if (credit === undefined) continue;

    sampleRows.push({ ts, day, uid, nickname, credit });

    const checkin = a.checkin;
    historyRows.push({
      ts,
      day,
      uid,
      nickname,
      credit,
      checkedIn: checkin?.todayCheckedIn === true,
      streakDays: typeof checkin?.streakDays === 'number' ? checkin.streakDays : 0,
      source,
    });
  }

  let sOK = true;
  let hOK = true;
  let dOK = true;
  if (sampleRows.length > 0) {
    const f = filePath('samples');
    const merged = dedupeByDayUid(prune([...readJsonl(f), ...sampleRows], SAMPLE_KEEP_DAYS));
    sOK = writeJsonlAtomic(f, merged);
  }
  if (historyRows.length > 0) {
    const f = filePath('history');
    const merged = dedupeByDayUid(prune([...readJsonl(f), ...historyRows], HISTORY_KEEP_DAYS));
    hOK = writeJsonlAtomic(f, merged);
  }
  if (sampleRows.length > 0) {
    dOK = writeDaily(sampleRows);
  }
  return { ok: sOK && hOK && dOK, samples: sampleRows.length, history: historyRows.length };
}

/**
 * 维护 daily.jsonl：每个 (day, uid) 一行，记首末两端。
 *
 * 这是「每日净变化」的数据源。不能用 samples 代替 —— samples 按 (day, uid)
 * 去重后只剩最后一条，当天最初值没了，净变化恒为 0。
 *
 * 合并语义：已有一天记录时
 *   - first/firstTs 保持最早的（`Math.min(ts)`）
 *   - last/lastTs 换成最新的
 *   - n 累加观测次数
 */
function writeDaily(sampleRows) {
  const f = filePath('daily');
  if (f === null) return false;

  const map = new Map();
  for (const r of readJsonl(f)) {
    const key = `${r.day}\u0000${r.uid}`;
    map.set(key, r);
  }

  for (const r of sampleRows) {
    const key = `${r.day}\u0000${r.uid}`;
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, {
        day: r.day,
        uid: r.uid,
        nickname: r.nickname,
        first: r.credit,
        firstTs: r.ts,
        last: r.credit,
        lastTs: r.ts,
        n: 1,
      });
      continue;
    }
    // 以时间戳为准判断谁是首、谁是末（同一秒内的重复观测两种顺序都要对）
    const rIsEarlier = r.ts < (prev.firstTs ?? 0);
    const rIsLater = r.ts >= (prev.lastTs ?? 0);
    map.set(key, {
      ...prev,
      nickname: r.nickname || prev.nickname,
      first: rIsEarlier ? r.credit : prev.first,
      firstTs: rIsEarlier ? r.ts : prev.firstTs,
      last: rIsLater ? r.credit : prev.last,
      lastTs: rIsLater ? r.ts : prev.lastTs,
      n: (typeof prev.n === 'number' ? prev.n : 1) + 1,
    });
  }

  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 86400000;
  const rows = [...map.values()]
    .filter((r) => (r.lastTs ?? 0) >= cutoff)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return writeJsonlAtomic(f, rows);
}

/**
 * 读取使用记录。返回按时间倒序的扁平行，供界面直接渲染。
 *
 * @param {{limit?: number, uid?: string}} opts
 */
export function readHistory(opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 200;
  const file = filePath('history');
  let rows = readJsonl(file);
  if (typeof opts.uid === 'string' && opts.uid !== '') {
    rows = rows.filter((r) => r.uid === opts.uid);
  }
  rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return rows.slice(0, limit);
}

/** 读取积分采样序列（按时间升序，适合画趋势） */
export function readSamples(opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 500;
  const file = filePath('samples');
  let rows = readJsonl(file);
  if (typeof opts.uid === 'string' && opts.uid !== '') {
    rows = rows.filter((r) => r.uid === opts.uid);
  }
  rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return rows.slice(-limit);
}

/**
 * 汇总：每个账号的最新积分、当前连续签到、以及相对前一天的变化。
 * 界面顶部那三个数字和「使用记录」表头都用它。
 */
export function summarize() {
  const samples = readSamples({ limit: 5000 });
  const history = readHistory({ limit: 5000 });

  /** uid -> 该账号的全部采样（升序） */
  const byUid = new Map();
  for (const r of samples) {
    const uid = typeof r.uid === 'string' ? r.uid : '';
    if (uid === '') continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(r);
  }

  /** uid -> 最近一条 history（含 checkedIn / streakDays） */
  const lastHistory = new Map();
  for (const r of history) {
    const uid = typeof r.uid === 'string' ? r.uid : '';
    if (uid === '') continue;
    const prev = lastHistory.get(uid);
    if (prev === undefined || (r.ts ?? 0) > (prev.ts ?? 0)) lastHistory.set(uid, r);
  }

  const accounts = [];
  for (const [uid, rows] of byUid) {
    const latest = rows[rows.length - 1];
    const first = rows[0];
    const h = lastHistory.get(uid);
    accounts.push({
      uid,
      nickname: latest.nickname ?? '',
      credit: typeof latest.credit === 'number' ? latest.credit : 0,
      firstCredit: typeof first.credit === 'number' ? first.credit : 0,
      delta: (typeof latest.credit === 'number' ? latest.credit : 0) - (typeof first.credit === 'number' ? first.credit : 0),
      firstTs: first.ts ?? 0,
      lastTs: latest.ts ?? 0,
      checkedIn: h?.checkedIn === true,
      streakDays: typeof h?.streakDays === 'number' ? h.streakDays : 0,
      points: rows.map((r) => ({ ts: r.ts ?? 0, credit: typeof r.credit === 'number' ? r.credit : 0 })),
    });
  }
  accounts.sort((a, b) => b.credit - a.credit);

  // 按天的净变化：来自 daily.jsonl（首末两端），不是从去重后的 samples 推。
  // 详见文件头「为什么要有 daily.jsonl」。
  const dailyRows = readJsonl(filePath('daily'));
  const daily = new Map();
  for (const r of dailyRows) {
    const day = typeof r?.day === 'string' ? r.day : '';
    if (day === '') continue;
    const delta = (typeof r.last === 'number' ? r.last : 0) - (typeof r.first === 'number' ? r.first : 0);
    daily.set(day, (daily.get(day) ?? 0) + delta);
  }

  // 老数据兼容：daily.jsonl 不存在时（控制台时代只写了 samples），
  // 退化成「当天最后一条 - 前一天最后一条」，至少看得出趋势而不是全 0。
  if (dailyRows.length === 0 && samples.length > 0) {
    const lastOfDay = new Map();
    for (const r of samples) {
      const day = typeof r.day === 'string' ? r.day : '';
      const uid = typeof r.uid === 'string' ? r.uid : '';
      if (day === '' || uid === '') continue;
      lastOfDay.set(`${day}\u0000${uid}`, typeof r.credit === 'number' ? r.credit : 0);
    }
    const perDay = new Map();
    for (const [key, credit] of lastOfDay) {
      const day = key.split('\u0000')[0];
      perDay.set(day, (perDay.get(day) ?? 0) + credit);
    }
    const days = [...perDay.keys()].sort();
    for (let i = 1; i < days.length; i++) {
      daily.set(days[i], (perDay.get(days[i]) ?? 0) - (perDay.get(days[i - 1]) ?? 0));
    }
  }

  const dailyTrend = [...daily.entries()]
    .map(([day, delta]) => ({ day, delta }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    accounts,
    dailyTrend,
    totalSamples: samples.length,
    totalHistory: history.length,
  };
}

/** 仅供测试：清空内存队列状态 */
export function _resetForTest() {
  dataDir = null;
  queue = Promise.resolve();
}
