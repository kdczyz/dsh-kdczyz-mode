/**
 * settings 的 volatile 标记与解引用。
 *
 * # 为什么单独一个模块
 *
 * DSH 0.1.7 起，插件设置的**写入闸门**要求 schema 里至少有一个字段被标成
 * volatile，否则 `set()` 直接抛：
 *
 * ```
 * Plugin entry "qoder" has no volatile fields
 * ```
 *
 * （宿主判据见 `dsh-settings/lib/index.js`：`volatileForm(schema)` 在没有
 * volatile 字段时返回 `undefined`，随后抛出。两个插件的 `apply` 是各自独立的
 * 模块，但这条**契约**是宿主的，与哪一半无关 —— 所以放在这里共享，而不是在
 * 每个入口里各抄一份。）
 *
 * 没有标记的后果**不是**「保存时报错」那么明显：scope 的 `set()` 仍然会
 * resolve，卡片看上去保存成功，实际每次都被静默丢弃并回滚。Qoder 半边此前
 * 就是这个状态 —— 它的 `config:` 块在 profile 里从来不存在，因为**根本写不进去**。
 *
 * 同理，读的时候要解引用：0.1.7 把 volatile 字段作为**活引用**（`{get(): T}`）
 * 交回来。活引用 `typeof === 'object'`，能骗过普通对象判断，而上面每次查字段都是
 * `undefined`；更糟的是展开它（`{ ...ref }`）**不会**读到值，只会得到
 * `{ get: <function> }`。
 *
 * @module
 */

/**
 * 把一个字段标成 volatile。
 *
 * `volatile()` 从 schemastery 3.18.3 起提供；本包的 peer 范围自 2.3.0 起要求
 * `>=3.18.4`，所以在受支持的宿主上一定存在。保留探测是为了「消费者解析到了更老
 * 的 schemastery」这一种情况——那时助手必须退化成恒等函数（手写
 * `meta.volatile = true` 会绕过 schemastery 自己的 `validateVolatileSchema` 校验）。
 *
 * @template T
 * @param {T} schema
 * @returns {T}
 */
export function asVolatile(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  return schema;
}

/**
 * 剥掉**一层** `{get(): T}` 活引用，返回它解析出的值。
 *
 * 非活引用的值原样返回 —— 所以对旧宿主（直接给普通值）也安全。
 *
 * @template T
 * @param {T | {get(): T}} value
 * @returns {T}
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get();
  }
  return value;
}
