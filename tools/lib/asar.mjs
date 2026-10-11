/**
 * 纯 JS 的 asar 读取器 —— 让「把 DSH 宿主内包取出来」这件事不再依赖 Electron。
 *
 * # 为什么需要它
 *
 * DSH 桌面版把宿主代码打包在 `app.asar` 里，宿主自带的包（`@deepseek-ai/dsh-llm`、
 * `@earendil-works/pi-ai` …）就在 `app.asar/dsh/node_modules/` 下。本插件的三个
 * Loader 入口在**模块顶层** import 这些包，所以它们必须以**磁盘实体**的形式出现在
 * profile 的解析范围内 —— 但 asar 内部路径纯 Node 读不到（`ENOTDIR`），软链过去无效。
 * 于是必须把包内容读出来写成真文件。
 *
 * 旧实现（`tools/link-host-deps.mjs` 的第一版）是借 DSH 自带的 Electron 可执行文件
 * 当 Node 用（`ELECTRON_RUN_AS_NODE`）去读 asar，问题是：
 *
 *   - 硬编码 macOS 的 `.app` 路径，Windows / Linux 上直接找不到；
 *   - 多起一个 100+ MB 的 Electron 进程，慢且容易在别的平台上出怪问题。
 *
 * asar 本身只是个很薄的归档格式，头部结构固定，用 `fs.readSync` 就能读。
 * 实测本机 app.asar 的头部（十六进制）：
 *
 *   04 00 00 00 | 50 c8 33 00 | 4c c8 33 00 | 46 c8 33 00 | {"files":{…
 *   @0  u32 = 4          外层 pickle 长度字段自身
 *   @4  u32 = 3393616    头部区长度 → **数据基址 = 8 + 该值 = 3393624**（已对齐）
 *   @8  u32 = 3393612    内层 pickle 长度
 *   @12 u32 = 3393606    头部 JSON 字节数
 *   @16 起是头部 JSON
 *
 * 也就是说长度字段有两级嵌套，且随实现细节（对齐、padding）变化。为了不把
 * 「某个版本的写入方式」写死，这里**不依赖那两个长度字段定位 JSON 起点**：
 * 从 @8 起找第一个 `{`，再用括号配平（跳过字符串与转义）算出 JSON 终点。
 * 数据基址仍用 `8 + u32@4` —— 它与「JSON 终点按 4 字节对齐」一致，实测吻合。
 *
 * # 条目形态
 *
 * `{ files: {…} }` 是目录；叶子是 `{ size, offset: "123" }`，另有三种特殊标记：
 *   - `unpacked: true` → 内容其实在磁盘的 `app.asar.unpacked/<相对路径>`；
 *   - `link: "…"`      → 归档内的软链（本用途不需要，遇到就明确报错而不是猜）；
 *   - `executable`     → 权限位，Windows 上无意义。
 */

import fs from 'node:fs';
import path from 'node:path';

/** asar 头部 JSON 的根节点形状。 */
const HEADER_KEYS = ['files'];

/**
 * 从 asar 头部区里切出 JSON 文本。
 *
 * 起点：@8 之后第一个 `{`；终点：括号配平（跳过字符串内部的括号与转义）。
 * 不用长度字段是刻意的 —— 那些字段的嵌套层级随实现变化，而配平是自证的。
 */
function sliceHeaderJson(head) {
  const start = head.indexOf(0x7b, 8); // '{'
  if (start === -1) throw new Error('asar 头部里找不到 JSON 起点');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < head.length; i += 1) {
    const c = head[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true; // '\'
      else if (c === 0x22) inString = false; // '"'
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b) depth += 1; // '{'
    else if (c === 0x7d) { // '}'
      depth -= 1;
      if (depth === 0) return head.subarray(start, i + 1).toString('utf8');
    }
  }
  throw new Error('asar 头部 JSON 括号不配平（文件被截断？）');
}

/**
 * 判断一个路径像不像 asar：头 4 字节必须是 `04 00 00 00`（pickle 长度 = 4）。
 * 只看魔数，不解析内容 —— 用于在候选列表里快速筛掉非 asar 文件。
 */
export function looksLikeAsar(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) !== 8) return false;
    return head.readUInt32LE(0) === 4 && head.readUInt32LE(4) > 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class AsarArchive {
  #fd;
  #base;
  #entries = new Map();
  #dirs = new Set();

  /**
   * @param {string} file asar 文件路径（例如 `…/Resources/app.asar`）
   */
  constructor(file) {
    this.path = file;
    this.unpackedRoot = `${file}.unpacked`;
    this.#fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(12);
      if (fs.readSync(this.#fd, head, 0, 12, 0) !== 12) throw new Error('asar 文件太短');
      if (head.readUInt32LE(0) !== 4) throw new Error('不是 asar：pickle 长度字段不是 4');
      const headerSize = head.readUInt32LE(4);
      if (headerSize <= 0 || headerSize > 256 * 1024 * 1024) {
        throw new Error(`asar 头部长度不合理：${headerSize}`);
      }
      // 头部区 = [8, 8 + headerSize)，一次读进来再配平切 JSON
      const region = Buffer.alloc(headerSize);
      if (fs.readSync(this.#fd, region, 0, headerSize, 8) !== headerSize) {
        throw new Error('asar 头部读取不完整');
      }
      const header = JSON.parse(sliceHeaderJson(region));
      for (const key of HEADER_KEYS) {
        if (header?.[key] === undefined) throw new Error(`asar 头部缺少 ${key}`);
      }
      this.#base = 8 + headerSize;
      this.#index(header, '');
    } catch (error) {
      fs.closeSync(this.#fd);
      this.#fd = undefined;
      throw error;
    }
  }

  #index(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (entry?.files !== undefined) {
        this.#dirs.add(rel);
        this.#index(entry, rel);
        continue;
      }
      this.#entries.set(rel, entry ?? {});
    }
  }

  close() {
    if (this.#fd !== undefined) {
      fs.closeSync(this.#fd);
      this.#fd = undefined;
    }
  }

  /** 归档内全部**文件**（不含目录）的相对路径，POSIX 分隔符。 */
  listFiles(prefix = '') {
    const p = prefix.replace(/\/+$/, '');
    const out = [];
    for (const rel of this.#entries.keys()) {
      if (p === '' || rel === p || rel.startsWith(`${p}/`)) out.push(rel);
    }
    return out.sort();
  }

  hasFile(rel) {
    return this.#entries.has(rel);
  }

  hasDir(rel) {
    return this.#dirs.has(rel);
  }

  entry(rel) {
    return this.#entries.get(rel);
  }

  /**
   * 读一个文件的内容。
   *
   * `unpacked: true` 的条目内容不在归档里，而在 `app.asar.unpacked/` 下的同名文件；
   * 这条路径必须支持 —— Electron 会把 `.node` 原生模块与部分大文件解包放外面。
   */
  readFile(rel) {
    const entry = this.#entries.get(rel);
    if (entry === undefined) throw new Error(`asar 内没有 ${rel}`);
    if (entry.unpacked === true) {
      return fs.readFileSync(path.join(this.unpackedRoot, rel));
    }
    if (entry.link !== undefined) {
      throw new Error(`asar 内 ${rel} 是软链（→ ${entry.link}），本工具不跟随`);
    }
    const size = Number(entry.size ?? 0);
    const offset = Number(entry.offset);
    if (!Number.isFinite(offset) || offset < 0) throw new Error(`asar 内 ${rel} 的 offset 非法`);
    if (size === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(size);
    const read = fs.readSync(this.#fd, buf, 0, size, this.#base + offset);
    if (read !== size) throw new Error(`asar 内 ${rel} 只读到 ${read}/${size} 字节`);
    return buf;
  }
}

/**
 * 打开一个 asar，失败返回 `undefined`（候选目录遍历时用，不抛）。
 */
export function tryOpenAsar(file) {
  try {
    if (!fs.existsSync(file)) return undefined;
    return new AsarArchive(file);
  } catch {
    return undefined;
  }
}
