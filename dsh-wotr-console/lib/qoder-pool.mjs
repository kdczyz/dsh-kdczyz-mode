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
 * - 三种分配策略：`priority`（默认）/ `round-robin` / `balanced`
 * - `cooldownMs` 短冷却（限流）/ `exhaustCooldownMs` 长冷却（额度耗尽）
 * - 逐模型冷却：Qoder 的限流是按模型计的，一个模型 429 不该带走整个账号
 * - `disabledIds` 停用、`creditReserves` 保留额度、`prefer` 显式偏好
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

/** 空闲加权：每空闲一小时 +0.5 权重，封顶 5（与 Trae 侧同口径）。 */
const QODER_IDLE_WEIGHT_PER_HOUR = 0.5;
const QODER_IDLE_WEIGHT_MAX = 5;

/** 刷新余量：过期前 5 分钟内触发一次续期。 */
const QODER_REFRESH_MARGIN_MS = 3e5;

/** 凭据文件名前缀（`.qoder-auth.cn.<accountId>.json`）。 */
const QODER_AUTH_PREFIX = '.qoder-auth.cn.';
const QODER_AUTH_SUFFIX = '.json';

export const QODER_DISTRIBUTIONS = ['priority', 'round-robin', 'balanced'];

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

/** 空闲加权：越久没用过权重越高（`undefined` = 从未用过，给最高基础权重）。 */
export function qoderIdleWeight(lastUsedAt, now) {
  if (lastUsedAt === undefined) return QODER_IDLE_WEIGHT_MAX + 1;
  const hours = (now - lastUsedAt) / 36e5;
  return 1 + Math.min(Math.max(hours, 0) * QODER_IDLE_WEIGHT_PER_HOUR, QODER_IDLE_WEIGHT_MAX);
}

/**
 * Qoder CN 的多账号号池。
 *
 * ## 定位：存储 + 单一「当前账号」，不再是自动轮换
 *
 * 与 Trae 侧对齐后的语义（见 lib/trae.js 的 `TraeAccountPool`）：
 *
 *   - 池负责**存**所有账号的凭据与余额（每个账号一份文件，见
 *     qoder-auth.mjs），并给出完整列表供 UI 展示；
 *   - 请求**只用** `selectedId` 指向的那一个账号；
 *   - 用户可以在卡片上切换「当前账号」，切换即持久化。
 *
 * 自动轮换（`acquire()` 的 priority / round-robin / balanced）**保留但默认
 * 不参与请求**：只有当 `selectedId` 没设、或它指向的账号不可用（被停用 /
 * 冷却中 / 不在池里）时，才回退到原来的轮换逻辑挑一个。这样「单账号」是
 * 默认行为，而旧的多账号能力没有删掉 —— 恢复方式是清掉 `selectedId`。
 *
 * 为什么要保留回退而不是直接锁死：Qoder 的凭据可能因令牌过期或文件被删而
 * 消失，锁死会让请求直接失败，而用户看到的却是「我已经选了账号」。
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
    this.distribution = options.distribution ?? 'priority';

    /** 池内账号快照。 */
    this.accounts = [];
    /** round-robin 游标（priority 模式下不用）。 */
    this.cursor = 0;
    this.lastScanAtMs = 0;
    this.preferredId = undefined;
    /**
     * 用户选定的「当前账号」id。
     *
     * 与 `preferredId` 的区别：`preferredId` 是 Trae 侧的「优先但不保证」
     * （冷却时会让位给其它账号）；`selectedId` 是**唯一服务请求的账号**。
     */
    this.selectedId = undefined;
    /** 用户在卡片上关掉的账号 id。 */
    this.disabledIds = new Set();
    /** 每个账号的额度下限；0 / 缺省 = 用光为止。 */
    this.creditReserves = new Map();
    /** 每个账号最近一次已知余额。 */
    this.creditBalances = new Map();
    /** 每个账号最近一次实际服务请求的时刻（空闲加权读它）。 */
    this.lastUsedAt = new Map();
  }

  /* -------- 当前账号 -------- */

  /**
   * 设定「当前账号」。
   *
   * 只记 id，不校验它是否存在：账号可能还没扫进来（刚登录、盘还没扫），
   * 此时拒绝写入会让「切换」在 UI 上静默失效。取号时由
   * {@link resolveSelected} 决定是否回退。
   */
  selectAccount(accountId) {
    this.selectedId = typeof accountId === 'string' && accountId !== '' ? accountId : undefined;
    return this.selectedId;
  }

  /** 当前选中的账号 id。 */
  selectedAccountId() {
    return this.selectedId;
  }

  /**
   * 「当前账号」实际对应的池内条目。
   *
   * 返回 undefined 的三种情形（都走回退）：没选、选的账号不在池里、
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
    if (options.distribution !== undefined) this.distribution = options.distribution;
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

  currentDistribution() {
    return this.distribution;
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

  pickRoundRobin(pool) {
    const index = this.cursor % pool.length;
    const account = pool[index];
    if (account === undefined) return undefined;
    this.cursor = (index + 1) % pool.length;
    return account;
  }

  /** 加权随机：偏向空闲最久的账号。 */
  pickByWeight(pool) {
    if (pool.length === 1) return pool[0];
    const now = Date.now();
    const weights = pool.map((account) => qoderIdleWeight(this.lastUsedAt.get(account.id), now));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(total) || total <= 0) return pool[0];
    let roll = Math.random() * total;
    for (let index = 0; index < pool.length; index += 1) {
      roll -= weights[index] ?? 0;
      if (roll < 0) return pool[index];
    }
    return pool[pool.length - 1];
  }

  /**
   * 取一个账号来服务本次请求。
   *
   * ## 「当前账号」优先（默认路径）
   *
   * `selectedId` 指向的账号**只要可用就一定用它**，不看分配策略、不轮换。
   * 这就是与 Trae 对齐后的「单账号」行为。
   *
   * ## 回退（仅在选中账号确实不可用时）
   *
   * 选中账号被停用 / 冷却中 / 该模型冷却中 / 不在池里时，退回三种分配策略：
   *
   * - **priority**（默认）：一个账号一直用到被冷却，再换下一个可用的。
   * - **round-robin**：连续请求在池内轮流。
   * - **balanced**：加权随机，偏向空闲最久的账号。
   *
   * 回退会写一条 warn 日志说明原因（见 {@link fallbackReason}），避免「我明明
   * 选了 A，怎么扣的是 B 的额度」无从查起。
   *
   * 显式偏好（`prefer`）在回退路径里仍优先于分配策略。
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

    // ① 「当前账号」优先：可用则必定用它，不看 strategy。
    const selected = this.resolveSelected(Date.now(), modelId);
    if (selected !== undefined) {
      await this.ensureFresh(selected);
      return selected;
    }
    // ② 选中账号不可用 → 记一笔再回退，别让换号变成静默行为。
    const reason = this.fallbackReason(Date.now(), modelId);
    if (reason !== undefined && reason !== 'no-selection') {
      this.logger?.warn?.(
        `qoder-pool: 当前账号不可用（${reason}），本次回退到号池轮换`,
      );
    }

    if (this.preferredId !== undefined) {
      const preferred = pool.find((account) => account.id === this.preferredId);
      if (preferred !== undefined) {
        await this.ensureFresh(preferred);
        return preferred;
      }
    }

    const account =
      this.distribution === 'round-robin'
        ? this.pickRoundRobin(pool)
        : this.distribution === 'balanced'
          ? this.pickByWeight(pool)
          : pool[0];
    if (account === undefined) return undefined;
    await this.ensureFresh(account);
    return account;
  }

  /** 显式偏好某个账号（三种分配模式下都优先）。 */
  prefer(accountId) {
    this.preferredId = accountId;
  }

  isDisabled(accountId) {
    return this.disabledIds.has(accountId);
  }

  disabledIdsInOrder() {
    return this.accounts.filter((account) => this.disabledIds.has(account.id)).map((account) => account.id);
  }

  /* -------- 状态记录 -------- */

  /** 记录一个账号真的服务了请求（空闲加权读它）。 */
  noteServed(accountId) {
    if (!this.accounts.some((account) => account.id === accountId)) return;
    this.lastUsedAt.set(accountId, Date.now());
  }

  /** 记录一个账号的最近已知余额，让保留额度判断有值可用。 */
  noteCredits(accountId, balance) {
    if (!Number.isFinite(balance)) return;
    if (!this.accounts.some((account) => account.id === accountId)) return;
    this.creditBalances.set(accountId, balance);
  }

  /** 最近一次服务请求的账号。 */
  lastServedId() {
    let newest;
    for (const [id, at] of this.lastUsedAt) {
      if (!this.accounts.some((account) => account.id === id)) continue;
      if (newest === undefined || at > newest.at) newest = { id, at };
    }
    return newest?.id;
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