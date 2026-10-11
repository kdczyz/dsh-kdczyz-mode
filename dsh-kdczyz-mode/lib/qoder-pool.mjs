/**
 * qoder-pool.mjs —— Qoder CN 的**多账号号池**。
 *
 * ## 为什么需要它
 *
 * Qoder 桌面端每个安装只保存一份登录（在 App 里重新登录会覆盖前一个），
 * 所以「扫本机登录态自动成池」这条路在 Qoder 侧结构上走不通。号池里的每个
 * 账号都来自一次显式的设备流登录（lib/qoder-auth.mjs），落盘成
 * **按账号一个文件** `.qoder-auth.cn.<accountId>.json`。
 *
 * 本模块就是把这些文件读成一个池，并给出「这一请求用哪个账号」的决策。
 * 语义与 lib/trae.js 的 TraeAccountPool **刻意保持一致**，这样两边的行为、
 * 配置项名、UI 文案可以复用，用户不必学两套：
 *
 * - 「当前使用」一个账号 + 其余全部是「备用」：请求优先用当前账号，它确实
 *   不可用（停用 / 冷却中 / 该模型冷却中 / 不在池里）时才让位给下一个可用的
 *   —— 与 Trae 的 priority 同一条语义，界面也如实标出这一轮调用的是谁
 * - `cooldownMs` 短冷却（限流）/ `exhaustCooldownMs` 长冷却（额度耗尽）
 * - 逐模型冷却：Qoder 的限流是按模型计的，一个模型 429 不该带走整个账号
 * - `disabledIds` 停用、`creditReserves` 保留额度
 *
 * **没有分配策略**：轮换（round-robin）与均衡（balanced）已从池里删除。它们
 * 与「哪个账号在服务必须由用户手动切换决定」直接冲突 —— 同一份配置下每两次
 * 请求落到不同账号上，用户无法回答「这一轮扣的是谁的钱」，界面上的「当前使用」
 * 也失去意义。留在这里的只有优先模式：一个账号一直用到它不可用为止。
 *
 * 「当前账号」存在 `selectedId`，但**不是真相来源**：真相是设置里的
 * `selectedAccountId`（见 lib/qoder.js 的 Config），provider 在
 * `loader/volatile-update` 时把它推给池。池自身不落盘 —— 管理页与 provider
 * 是两个入口，各自建池会各记一份选择，早先的 bug 就是这么来的。
 *
 * 与 Trae 侧的**唯一实质差别**在入池方式（显式登录 vs 扫本机），池本身的行为
 * 完全同构。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { QODER_AUTH_VERSION, qoderAccountIdOf, qoderOwnAccountAuthPath } from './qoder-auth.mjs';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 号池默认短冷却：限流后先歇 60 秒再试这个账号。 */
export const QODER_COOLDOWN_MS = 6e4;

/** 号池默认长冷却：额度耗尽后歇 30 分钟（等上游额度重置）。 */
export const QODER_EXHAUST_COOLDOWN_MS = 18e5;

/** 刷新余量：过期前 5 分钟内触发一次续期。 */
const QODER_REFRESH_MARGIN_MS = 3e5;

/** 凭据文件名前缀（`.qoder-auth.cn.<accountId>.json`）。 */
const QODER_AUTH_PREFIX = '.qoder-auth.cn.';
const QODER_AUTH_SUFFIX = '.json';

/* ------------------------------------------------------------------ *
 * 跨实例共享的「最近服务账号」
 * ------------------------------------------------------------------ */

/**
 * 「最近一次真正服务了请求的账号 id」的**跨实例**登记处。
 *
 * ## 为什么不能只用 `this.lastUsedAt`
 *
 * Qoder 在本插件里有**两个池实例**，它们不是同一个对象：
 *
 * | 实例 | 在哪 | 谁在写 |
 * |---|---|---|
 * | provider 池 | `lib/qoder.js`（Loader entry `dsh-connect-qoder`） | 真请求：`acquire()` + `noteServed()` |
 * | 管理页池 | `lib/index.js` 的 `qoderPool()` 单例 | 设备流登录、停用、保留额度、刷新积分 |
 *
 * 两边扫描的是同一批凭据文件，所以「池里有哪些账号」一致；但**只有 provider 池
 * 知道刚刚是谁服务的**。管理页若只读自己那个实例的 `lastUsedAt`，永远是空的 ——
 * 表现就是「明明刚用某个账号跑过模型，界面上却没有任何账号被标成正在使用」。
 *
 * ## 为什么是一个单槽位全局，而不是文件
 *
 * 值只有「最后服务的那个账号」一个，不需要历史；而 `noteServed()` 在**每次
 * 成功请求**上都会调用，写文件会把它变成一条热路径上的磁盘 I/O。放全局内存里
 * 是零成本，且两个实例（无论 ESM 缓存是否共享）都能读到同一份。
 *
 * 用 `Symbol.for` 而不是字符串键：不污染 `globalThis` 的可见命名空间，也不会
 * 和别的插件撞名。
 *
 * 记的是 `{ accountId, atMs }`：`atMs` 让读方能判断这个信息是不是陈旧的
 * （例如进程重启后 provider 池还没服务过任何请求）。
 */
const QODER_SERVED_SLOT = Symbol.for('dsh-kdczyz-mode.qoder.lastServed');

/**
 * 共享槽位的保鲜期：超过这个时长的「最近服务账号」不再对外声称。
 *
 * 没有它会出现一种很隐蔽的错：进程里长期挂着第二个池实例时，**它自己从没服务
 * 过任何请求**，却会把几小时前（甚至上一轮会话里）的记录当成「本次调用」，
 * 界面上于是指着一个其实早就换掉的账号说「就是它扣的费」。宁可退回「预告下一
 * 个会用的账号」，也不要指错账号。
 *
 * 30 分钟这个量级足够宽松：正常使用中每隔几分钟就有请求刷新它，而一旦空闲
 * 到这个程度，「刚才那次调用是谁」对用户已经不再有意义。
 */
export const QODER_SERVED_SLOT_TTL_MS = 30 * 60 * 1000;

/** 记录「这个账号刚服务了一次请求」。跨实例可见，供管理页读。 */
export function noteQoderServed(accountId, atMs = Date.now()) {
  if (typeof accountId !== 'string' || accountId === '') return;
  globalThis[QODER_SERVED_SLOT] = { accountId, atMs };
}

/**
 * 读最近一次服务的账号；从未服务过（或进程重启后还没有请求）时返回 undefined。
 *
 * `atMs` 比 `now - QODER_SERVED_SLOT_TTL_MS` 更早即视为陈旧，返回 undefined ——
 * 理由见 {@link QODER_SERVED_SLOT_TTL_MS}。
 */
export function lastServedQoderAccountId(now = Date.now()) {
  const slot = globalThis[QODER_SERVED_SLOT];
  if (typeof slot?.accountId !== 'string' || slot.accountId === '') return undefined;
  // 槽位里没有时间戳时按「新鲜」处理：那是旧版本写下的值，能读到就说明
  // 本进程里确实有过一次服务，只是不知道什么时候。
  if (typeof slot.atMs === 'number' && Number.isFinite(slot.atMs)) {
    if (now - slot.atMs > QODER_SERVED_SLOT_TTL_MS) return undefined;
  }
  return slot.accountId;
}

/** 仅供测试：清掉共享槽位，避免用例之间互相影响。 */
export function _resetQoderServedSlot() {
  delete globalThis[QODER_SERVED_SLOT];
}

/* ------------------------------------------------------------------ *
 * 凭据解析
 * ------------------------------------------------------------------ */

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function timeToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 0xe8d4a51000 ? value : value * 1e3;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 归一化一份凭据；缺 accessToken 则视为无效。 */
export function normalizeQoderCredential(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const accessToken = optionalString(raw.accessToken) ?? optionalString(raw.access_token);
  if (accessToken === undefined) return undefined;
  const refreshToken = optionalString(raw.refreshToken) ?? optionalString(raw.refresh_token);
  const userId = optionalString(raw.userId) ?? optionalString(raw.user_id) ?? '';
  const userName = optionalString(raw.userName) ?? optionalString(raw.user_name) ?? '';
  const machineId = optionalString(raw.machineId) ?? optionalString(raw.machine_id);
  const expiresAtMs = timeToMs(raw.expiresAtMs ?? raw.expires_at) ?? 0;
  const refreshExpiresAtMs = timeToMs(raw.refreshExpiresAtMs ?? raw.refresh_expires_at);
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    userId,
    userName,
    ...(machineId === undefined ? {} : { machineId }),
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
  };
}

/** 账号 id：与 lib/qoder-auth.mjs 的 `qoderAccountIdOf` 必须是同一算法。 */
export function qoderAccountId(credential) {
  return qoderAccountIdOf({ userId: credential.userId, userName: credential.userName });
}

/** 解析插件自有凭据文件（格式必须与 saveQoderCredential 一致）。 */
export function parseQoderOwn(text) {
  try {
    const document = JSON.parse(text);
    if (document?.version !== QODER_AUTH_VERSION) return undefined;
    return normalizeQoderCredential(document?.credential);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 凭据 store
 * ------------------------------------------------------------------ */

/**
 * 读本机全部 Qoder CN 账号凭据。
 *
 * 数据源只有一个：插件自有的按账号文件。**刻意不去扫桌面端登录态** ——
 * 桌面端每个安装只有一份登录，扫了也只会多出一个与池中账号重复的条目，
 * 且它的刷新会与池内账号互相覆盖。设备流登录是唯一的入池通道。
 *
 * 读盘失败（目录不存在 / 单个文件损坏）一律当作「这个账号不存在」，
 * 不抛：一个坏文件不该让整个池不可用。
 */
export class QoderCredentialStore {
  constructor(options = {}) {
    this.dshHome = options.dshHome ?? '';
  }

  /** 列出全部账号凭据（按 accountId 去重，后读到的覆盖先读到的）。 */
  async readAll() {
    if (typeof this.dshHome !== 'string' || this.dshHome === '') return [];
    let names;
    try {
      names = await readdir(this.dshHome);
    } catch {
      return [];
    }

    const byId = new Map();
    for (const name of names) {
      if (!name.startsWith(QODER_AUTH_PREFIX) || !name.endsWith(QODER_AUTH_SUFFIX)) continue;
      let text;
      try {
        text = await readFile(join(this.dshHome, name), 'utf8');
      } catch {
        continue;
      }
      const credential = parseQoderOwn(text);
      if (credential === undefined) continue;
      byId.set(qoderAccountId(credential), credential);
    }
    return [...byId.values()];
  }

  /** 按 accountId 取一份凭据（只读）。 */
  async credentialOf(accountId) {
    return (await this.readAll()).find((credential) => qoderAccountId(credential) === accountId);
  }

  /**
   * 续期一个账号的令牌。
   *
   * ⚠️ 本期**尚未接线**：Qoder 的续期端点（`deviceToken/refresh`）与设备流
   * 轮询回的是同一种载荷，但请求体还要带 `machine_id`，且刷新失败的处理
   * 与设备绑定语义需要单独验证。所以这里如实返回 undefined（=「没有新凭据」），
   * 由池保持现有令牌继续用；令牌真过期时上游会回 401，池据此换号。
   *
   * 留这个方法是**契约**：池的 `ensureFresh` 已经按「store 可能不提供续期」
   * 写好了降级路径，将来补上实现不需要动池。
   */
  async resolveFor() {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 号池
 * ------------------------------------------------------------------ */

/**
 * Qoder CN 的多账号号池。
 *
 * ## 定位：存储 + 单一「当前账号」，其余是备用
 *
 * 与 Trae 侧对齐后的语义（见 lib/trae.js 的 `TraeAccountPool`）：
 *
 *   - 池负责**存**所有账号的凭据与余额（每个账号一份文件，见
 *     qoder-auth.mjs），并给出完整列表供 UI 展示；
 *   - 请求优先用 `selectedId` 指向的那一个账号（界面上标「当前使用」）；
 *   - 用户点「切换到此账号」才改变当前账号，**选择持久化在设置里**
 *     （`selectedAccountId`，见 lib/qoder.js 的 Config），重启后仍是它；
 *   - 当前账号不可用时让位给下一个可用账号（界面上那一张标「备用」，
 *     并由 `servingAccount()` 如实报出这一轮真正扣的是谁）。
 *
 * 为什么要保留「让位」而不是直接锁死：Qoder 的凭据会因令牌过期或文件被删
 * 而消失，锁死会让请求直接失败，而用户看到的却是「我已经选了账号」。
 * 让位只在当前账号**确实不可用**时发生，且写一条 warn 日志（见
 * {@link fallbackReason}），不会静默换号。
 *
 * 所有配置项都能通过 `applyConfig` 在运行时改（设置页保存后立即生效），
 * 不必重建池。
 */
export class QoderAccountPool {
  constructor(options = {}) {
    this.logger = options.logger;
    this.store = options.store;
    this.cooldownMs = options.cooldownMs ?? QODER_COOLDOWN_MS;
    this.exhaustCooldownMs = options.exhaustCooldownMs ?? QODER_EXHAUST_COOLDOWN_MS;

    /** 池内账号快照。 */
    this.accounts = [];
    this.lastScanAtMs = 0;
    /**
     * 用户选定的「当前账号」id（界面上的「当前使用」）。
     *
     * 只是本实例的一份投影 —— 真相在设置里的 `selectedAccountId`，由
     * provider 入口在启动与 `loader/volatile-update` 时通过 `applyConfig`
     * 推过来（见 lib/qoder.js）。池自己不落盘：管理页与 provider 是两个
     * Loader 入口，各建一个池各记一份选择，正是「固定了账号却还打到别的号」
     * 那个 bug 的来源。
     */
    this.selectedId = undefined;
    /** 用户在卡片上关掉的账号 id。 */
    this.disabledIds = new Set();
    /** 每个账号的额度下限；0 / 缺省 = 用光为止。 */
    this.creditReserves = new Map();
    /** 每个账号最近一次已知余额。 */
    this.creditBalances = new Map();
    /** 每个账号余额**读到的时刻**（`creditsAt()` 用它做显示侧节流）。 */
    this.creditReadAt = new Map();
    /** 每个账号最近一次实际服务请求的时刻（空闲加权读它）。 */
    this.lastUsedAt = new Map();
  }

  /* -------- 当前账号 -------- */

  /**
   * 设定「当前账号」。
   *
   * 只记 id，不校验它是否存在：账号可能还没扫进来（刚登录、盘还没扫），
   * 此时拒绝写入会让「切换」在 UI 上静默失效。取号时由
   * {@link resolveSelected} 决定是否让位给备用账号。
   *
   * `undefined` / 空串 = 清除选择（回到「第一个账号」这个确定性默认值）。
   */
  selectAccount(accountId) {
    this.selectedId = typeof accountId === 'string' && accountId !== '' ? accountId : undefined;
    return this.selectedId;
  }

  /** 用户显式选中的账号 id；从未选过（或已清除）时 undefined。 */
  selectedAccountId() {
    return this.selectedId;
  }

  /**
   * 界面上该标「当前使用」的那一个账号 id —— **Trae 同款规则**。
   *
   * 显式选中且它还在池里 → 就是它；否则回退到池里第一个账号（确定性默认值，
   * 与 `acquire()` 的让位顺序一致）。刻意不看「是否可用」：可用性由卡片上的
   * 冷却/停用标签回答，把「当前使用」跟着冷却一起跳会让界面每 60 秒换一个
   * 「当前账号」，用户更看不懂自己在用谁。
   */
  effectiveSelectedAccountId() {
    if (this.selectedId !== undefined && this.accounts.some((a) => a.id === this.selectedId)) {
      return this.selectedId;
    }
    return this.accounts[0]?.id;
  }

  /**
   * 「当前账号」实际对应的池内条目。
   *
   * 返回 undefined 的三种情形（都走让位）：没选、选的账号不在池里、
   * 选的账号当前不可用（被停用 / 冷却中 / 该模型冷却中）。
   */
  resolveSelected(now = Date.now(), modelId) {
    if (this.selectedId === undefined) return undefined;
    const account = this.accounts.find((item) => item.id === this.selectedId);
    if (account === undefined) return undefined;
    return this.isUsable(account, now, modelId) ? account : undefined;
  }

  /** 单个账号此刻能否服务请求（不写状态，便于单测）。 */
  isUsable(account, now = Date.now(), modelId) {
    if (this.disabledIds.has(account.id)) return false;
    const reserve = this.creditReserves.get(account.id);
    if (reserve !== undefined && reserve > 0) {
      const balance = this.creditBalances.get(account.id);
      if (balance !== undefined && balance <= reserve) return false;
    }
    if (account.cooldownUntilMs > now) return false;
    if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false;
    return true;
  }

  /**
   * 当前账号因为限流/额度耗尽而不可用时，是否还能退回到轮换。
   *
   * 这是「单账号」与「号池」的分界：选中的账号不可用时不静默换号会让请求
   * 直接失败，但**无条件**换号又等于没改。折中是——只有选中账号确实不可用
   * 才回退，且在日志里说清楚。
   */
  fallbackReason(now = Date.now(), modelId) {
    if (this.selectedId === undefined) return 'no-selection';
    const account = this.accounts.find((item) => item.id === this.selectedId);
    if (account === undefined) return 'selected-missing';
    if (this.disabledIds.has(account.id)) return 'selected-disabled';
    if (account.cooldownUntilMs > now) return 'selected-cooling';
    if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now)
      return 'selected-model-cooling';
    const reserve = this.creditReserves.get(account.id);
    if (reserve !== undefined && reserve > 0) {
      const balance = this.creditBalances.get(account.id);
      if (balance !== undefined && balance <= reserve) return 'selected-reserved';
    }
    return undefined;
  }

  /* -------- 配置 -------- */

  applyConfig(options = {}) {
    if (options.cooldownMs !== undefined && options.cooldownMs >= 1e3) {
      this.cooldownMs = options.cooldownMs;
    }
    if (options.exhaustCooldownMs !== undefined && options.exhaustCooldownMs >= 1e3) {
      this.exhaustCooldownMs = options.exhaustCooldownMs;
    }
    if (options.selectedAccountId !== undefined) this.selectAccount(options.selectedAccountId);
    if (options.disabledAccountIds !== undefined) {
      this.disabledIds = new Set(options.disabledAccountIds);
    }
    if (options.creditReserves !== undefined) this.setCreditReserves(options.creditReserves);
  }

  setCreditReserves(reserves) {
    const next = new Map();
    for (const [id, value] of Object.entries(reserves ?? {})) {
      if (Number.isFinite(value) && value > 0) next.set(id, Math.floor(value));
    }
    this.creditReserves = next;
  }

  creditReservesInOrder() {
    const out = {};
    for (const account of this.accounts) {
      const reserve = this.creditReserves.get(account.id);
      if (reserve !== undefined && reserve > 0) out[account.id] = reserve;
    }
    return out;
  }

  creditReserveOf(accountId) {
    return this.creditReserves.get(accountId) ?? 0;
  }

  creditsOf(accountId) {
    return this.creditBalances.get(accountId);
  }

  /* -------- 扫描 -------- */

  /**
   * 重扫本机账号并重建池。
   *
   * **磁盘是唯一真相**：池里出现的每个账号都必须有一份凭据文件，文件没了
   * 账号就出池。这正是「移出池子」的实现方式 —— 删掉插件凭据，下次扫描
   * 它就不在候选里了。
   *
   * （Trae 侧的 scan 是「只合并不删除」，因为它的账号来源包含桌面端登录态，
   * 那些账号不会因为插件侧的删除而消失。Qoder 的入池通道只有设备流登录，
   * 池的内容**就是**这些文件，所以这里必须以磁盘为准。）
   *
   * 已有条目**保留冷却与使用状态** —— `scan()` 在「全池都冷却」时也会被调用，
   * 一个正在冷却的账号不该因为这次重扫被重置。只有凭据本身会被替换，且仅当
   * 新读到的过期时刻更晚（另一个窗口刚登录过 = 账号换了令牌）。
   */
  async scan() {
    if (this.store === undefined) return this.accounts;
    const credentials = await this.store.readAll();

    // 先按 id 索引旧状态，再**从凭据重建列表**：凭据决定「谁在池里」，
    // 旧状态只提供「它的冷却/用量是多少」。
    const previous = new Map(this.accounts.map((account) => [account.id, account]));
    const next = new Map();

    for (const credential of credentials) {
      const id = qoderAccountId(credential);
      const existing = previous.get(id);
      if (existing === undefined) {
        next.set(id, {
          id,
          label: credential.userName || credential.userId || 'Qoder 账号',
          credential,
          cooldownUntilMs: 0,
          modelCooldowns: {},
          rateLimitHits: 0,
        });
        continue;
      }
      // 保留冷却 / 用量状态；凭据只在更新鲜时替换。
      next.set(id, {
        ...existing,
        label: credential.userName || credential.userId || existing.label,
        credential:
          credential.expiresAtMs > existing.credential.expiresAtMs ? credential : existing.credential,
      });
    }

    // 顺带清掉已不在池里的账号的状态，别让 lastUsedAt / creditBalances 无限增长。
    for (const id of [...this.lastUsedAt.keys()]) if (!next.has(id)) this.lastUsedAt.delete(id);
    for (const id of [...this.creditBalances.keys()]) if (!next.has(id)) this.creditBalances.delete(id);
    for (const id of [...this.creditReadAt.keys()]) if (!next.has(id)) this.creditReadAt.delete(id);
    for (const id of [...this.creditReserves.keys()]) if (!next.has(id)) this.creditReserves.delete(id);
    for (const id of [...this.disabledIds]) if (!next.has(id)) this.disabledIds.delete(id);

    this.accounts = [...next.values()];
    this.lastScanAtMs = Date.now();
    return this.accounts;
  }

  list() {
    return this.accounts;
  }

  /* -------- 选号 -------- */

  /**
   * 当前可服务请求的账号。
   *
   * 带 `modelId` 时：账号既不能整体冷却，该模型也不能在它上面冷却 ——
   * Qoder 按模型限流，一个模型 429 不该带走该账号的其它模型。
   */
  available(now = Date.now(), modelId) {
    return this.accounts.filter((account) => {
      if (this.disabledIds.has(account.id)) return false;
      const reserve = this.creditReserves.get(account.id);
      if (reserve !== undefined && reserve > 0) {
        const balance = this.creditBalances.get(account.id);
        if (balance !== undefined && balance <= reserve) return false;
      }
      if (account.cooldownUntilMs > now) return false;
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false;
      return true;
    });
  }

  /**
   * 取一个账号来服务本次请求。
   *
   * ## 「当前账号」优先（默认路径）
   *
   * `selectedId` 指向的账号**只要可用就一定用它**，不看别的、不轮换。
   *
   * ## 让位（仅在当前账号确实不可用时）
   *
   * 当前账号被停用 / 冷却中 / 该模型冷却中 / 不在池里时，按**池内顺序**取第一个
   * 可用账号（Trae 的 priority 语义：一个账号一直用到它不可用，再换下一个）。
   * 这就是「限流或额度耗尽的账号会自动让位给备用账号」那条行为；让位会写一条
   * warn 日志说明原因（见 {@link fallbackReason}），界面上则由
   * `servingAccount()` 如实标出这一轮真正扣的是谁，不会变成静默换号。
   *
   * 首次使用时自动扫描；**全池都冷却时再扫一次** —— 刚登录一个新账号是
   * 走出「池子耗尽」的常规手段。
   *
   * @returns {Promise<object|undefined>} 选中的账号；无可用账号时 undefined。
   */
  async acquire(modelId) {
    if (this.accounts.length === 0) await this.scan();
    let pool = this.available(Date.now(), modelId);
    if (pool.length === 0) {
      await this.scan();
      pool = this.available(Date.now(), modelId);
    }
    if (pool.length === 0) return undefined;

    // ① 「当前账号」优先：可用则必定用它。
    const selected = this.resolveSelected(Date.now(), modelId);
    if (selected !== undefined) {
      await this.ensureFresh(selected);
      return selected;
    }
    // ② 当前账号不可用 → 记一笔再让位，别让换号变成静默行为。
    const reason = this.fallbackReason(Date.now(), modelId);
    if (reason !== undefined && reason !== 'no-selection') {
      this.logger?.warn?.(
        `qoder-pool: 当前账号不可用（${reason}），本次改用备用账号 ${pool[0].label ?? pool[0].id}`,
      );
    }

    const account = pool[0];
    if (account === undefined) return undefined;
    await this.ensureFresh(account);
    return account;
  }

  isDisabled(accountId) {
    return this.disabledIds.has(accountId);
  }

  disabledIdsInOrder() {
    return this.accounts.filter((account) => this.disabledIds.has(account.id)).map((account) => account.id);
  }

  /* -------- 状态记录 -------- */

  /**
   * 记录一个账号真的服务了请求（空闲加权读它）。
   *
   * 同时写一份到**跨实例共享槽位**（见文件头的 `noteQoderServed` 说明）：
   * 管理页读的是另一个池实例，只看本实例的 `lastUsedAt` 永远读不到东西。
   */
  noteServed(accountId, atMs = Date.now()) {
    if (!this.accounts.some((account) => account.id === accountId)) return;
    // 只允许由 `Date.now()` 产生的合理时间戳；调用方给不出（或给出 NaN）时补上。
    const at = Number.isFinite(atMs) ? atMs : Date.now();
    this.lastUsedAt.set(accountId, at);
    noteQoderServed(accountId, at);
  }

  /** 记录一个账号的最近已知余额，让保留额度判断有值可用。 */
  noteCredits(accountId, balance) {
    if (!Number.isFinite(balance)) return;
    if (!this.accounts.some((account) => account.id === accountId)) return;
    this.creditBalances.set(accountId, balance);
  }

  /**
   * 最近一次服务请求的账号。
   *
   * == 口径：**「被调用的账号」就是这里** ==
   *
   * 界面上的「当前使用中」、额度胶囊上的余额，都以本方法为唯一事实来源 ——
   * 而不是「被 fixed 的当前账号」：后者只是**下一次**用谁，与刚刚真扣了谁
   * 的额度是两件事（轮换模式下更是完全无关）。
   *
   * 回退链（本实例没记录时）：
   *   1. 跨实例共享槽位 —— provider 池服务过，但那是**另一个实例**；
   *   2. 都没有 → undefined，由调用方决定显示什么（绝不猜一个账号出来）。
   */
  lastServedId() {
    let newest;
    for (const [id, at] of this.lastUsedAt) {
      if (!this.accounts.some((account) => account.id === id)) continue;
      if (newest === undefined || at > newest.at) newest = { id, at };
    }
    if (newest !== undefined) return newest.id;
    const shared = lastServedQoderAccountId();
    return shared !== undefined && this.accounts.some((account) => account.id === shared)
      ? shared
      : undefined;
  }

  /** 余额已知时返回该账号的最近已知积分；未知（从没读到过）时 undefined。 */
  creditsOf(accountId) {
    return this.creditBalances.get(accountId);
  }

  /**
   * 最近一次**读到**（而不是刚生成）该账号余额的时刻；从没读到过返回 0。
   *
   * 号池本身不需要这个时间，但「只为显示而读一次」的那条路必须是**节流**的：
   * 界面上每 30 秒一拍，若每拍都真读上游，一个开着设置面板的窗口就会稳定地
   * 每 30 秒打一次 Qoder 的额度接口。有了它，调用方就能表达「3 分钟内读到过的
   * 余额别再读」——`creditBalances` 只回答「是多少」，回答不了「多旧」。
   */
  creditsAt(accountId) {
    return this.creditReadAt.get(accountId) ?? 0;
  }

  /**
   * 记录一次**读到**的余额（带读到的时刻）。
   *
   * 与 `noteCredits` 的区别是它同时更新时间戳，于是节流判据有值可用。名字
   * 分开是为了让调用点读起来能看出意图：`noteCredits` 是内部记账（批量刷新
   * 顺手带过），`rememberCredits` 是「这次读是为了显示」。
   *
   * **读失败必须整条不生效**（余额与时间戳都不动）：调用方拿到非数字时容易
   * 顺手传进来（`rememberCredits(id, result.total)`），而推进时间戳等于宣称
   * 「刚读到了」，于是下一次刷新会被节流判据跳过 —— 界面上那句「读取中…」
   * 就会一直挂着，一个失败的读取把成功的读取也挡掉了。
   */
  rememberCredits(accountId, balance, atMs = Date.now()) {
    if (!Number.isFinite(balance)) return this.creditBalances.get(accountId);
    this.noteCredits(accountId, balance);
    if (this.creditBalances.has(accountId)) this.creditReadAt.set(accountId, atMs);
    return this.creditBalances.get(accountId);
  }

  /**
   * **下一个**会被用来服务请求的账号（无副作用地预览）。
   *
   * 与 {@link acquire} 同一套判据，但**不**续期令牌、**不**写日志 —— 它只回答
   * 「如果现在发一个请求，会落到谁头上」，用于「还没有任何请求时」在界面上
   * 如实预告余额来源。
   */
  resolveNext(now = Date.now(), modelId) {
    const pool = this.available(now, modelId);
    if (pool.length === 0) return undefined;
    const selected = this.resolveSelected(now, modelId);
    if (selected !== undefined) return selected;
    return pool[0];
  }

  /**
   * 「谁在被调用」的统一入口 —— 界面唯一该用的那个。
   *
   * 返回 `{ account, source }`：
   *   - `source: 'served'`   —— 刚刚真的服务过请求的账号（`lastServedId`）。
   *     这是「所调用账号」的字面答案，余额、扣费都发生在这个账号上。
   *   - `source: 'next'`     —— 本进程还没有任何请求服务过，回退到「下一个会
   *     用它」的预告（{@link resolveNext}）。此时显示它的余额仍然是对的：
   *     下一次调用扣的就是它。
   *   - `account: undefined` —— 池里没有可用账号。调用方显示「—」，不要编造。
   */
  servingAccount(now = Date.now(), modelId) {
    const served = this.lastServedId();
    if (served !== undefined) {
      const account = this.accounts.find((item) => item.id === served);
      if (account !== undefined) return { account, source: 'served' };
    }
    const next = this.resolveNext(now, modelId);
    return next === undefined ? { account: undefined, source: 'none' } : { account: next, source: 'next' };
  }

  /* -------- 令牌续期 -------- */

  /**
   * 令牌进入刷新余量时续期一次。
   *
   * Qoder 的续期本期未接线（见 QoderCredentialStore#resolveFor），所以这里
   * 实际是**降级路径**：store 给不出新凭据就保持现有令牌继续用。刷新失败
   * 不该让一个仍然有效的会话不可用。
   */
  async ensureFresh(account) {
    if (this.store === undefined) return;
    if (account.credential.expiresAtMs > Date.now() + QODER_REFRESH_MARGIN_MS) return;
    try {
      const fresh = await this.store.credentialOf(account.id);
      if (fresh !== undefined && fresh.expiresAtMs > Date.now() + QODER_REFRESH_MARGIN_MS) {
        account.credential = fresh;
        return;
      }
      const resolved = await this.store.resolveFor(account.id);
      if (resolved !== undefined) account.credential = resolved;
    } catch (error) {
      this.logger?.warn?.(`qoder-pool: 账号 ${account.label} 令牌续期失败`, error);
    }
  }

  /** 强制让一个账号走一次续期（例如上游回了 session_dead）。 */
  async refreshAccount(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === undefined) return;
    account.credential = { ...account.credential, expiresAtMs: 0 };
    await this.ensureFresh(account);
  }

  /* -------- 冷却（换号的核心） -------- */

  /**
   * 额度耗尽 → 冷却整个账号。
   *
   * 额度耗尽是**账号级**的：该账号上每个模型都不可用，直到上游额度重置。
   * 所以这里冷却整个账号，而不是某一个模型。
   */
  penalizeExhausted(accountId) {
    const until = Date.now() + this.exhaustCooldownMs;
    this.penalize(accountId, until);
    this.logger?.warn?.(
      `qoder-pool: 账号额度耗尽，冷却到 ${new Date(until).toISOString()}`,
    );
  }

  /**
   * 标记账号（或它的某个模型）被限流。
   *
   * 带 `modelId` 时只冷却那个模型，对齐 Qoder 的**按模型限流**；不带则冷却
   * 整个账号。`resetAtMs` 由上游给出时以它为准（比本地估算准）。
   */
  penalize(accountId, resetAtMs, modelId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === undefined) return;
    account.rateLimitHits += 1;
    const until = resetAtMs ?? Date.now() + this.cooldownMs;
    if (modelId !== undefined && modelId !== '') {
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
      this.logger?.warn?.(
        `qoder-pool: ${account.label} 在模型 ${modelId} 上限流，该模型冷却到 ${new Date(until).toISOString()}`,
      );
      return;
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
    this.logger?.warn?.(
      `qoder-pool: ${account.label} 被限流，账号冷却到 ${new Date(until).toISOString()}`,
    );
  }

  /** 清空全部冷却（设置页「重置冷却」按钮）。 */
  resetCooldowns() {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0;
      account.modelCooldowns = {};
      account.rateLimitHits = 0;
    }
  }

  /** 诊断快照：总数、冷却数、上次扫描时间。 */
  status() {
    const now = Date.now();
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs,
    };
  }
}

/**
 * 判断上游错误该触发哪种冷却。
 *
 * 分类口径与 Trae/WorkBuddy 两侧一致（`KIND_STATUS`）：
 *   402 → 额度耗尽（账号级长冷却）
 *   429 → 限流（模型级短冷却，上游给了重置时间就用它）
 *   401 → 会话失效（先试续期，续不上就当作账号不可用）
 *
 * 返回 `{kind, modelId}`，由调用方决定冷却粒度 —— 本函数不碰池状态，
 * 便于单测。
 */
export function classifyQoderFailure({ status, modelId, body } = {}) {
  if (status === 402) return { kind: 'hard_credit' };
  if (status === 429) return { kind: 'soft_rate', modelId };
  if (status === 401 || status === 403) return { kind: 'session_dead' };
  const text = typeof body === 'string' ? body : '';
  if (/insufficient|quota|balance/i.test(text)) return { kind: 'hard_credit' };
  if (/rate.?limit|too many requests/i.test(text)) return { kind: 'soft_rate', modelId };
  return { kind: 'unknown' };
}