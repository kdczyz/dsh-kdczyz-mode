/**
 * 纯 JS 的 tar.gz 解包 —— 让「下载 → 解压」这一步不依赖 `git`、`tar`、`bash`。
 *
 * # 为什么需要它
 *
 * 新设备上装本插件的最大障碍是**外部命令**：
 *
 *   - `github:kdczyz/…` 这种包写法，pnpm 会先调 `git ls-remote` 问远端 ref
 *     → Windows 上没装 git 时直接 `'git' 不是内部或外部命令`（真机实测）；
 *   - 解压 `.tar.gz` 又要一个 `tar`（Windows 10 起自带 bsdtar，但不保证）。
 *
 * 所以安装器走「匿名 HTTPS 拉 codeload 的 tar.gz + 自己解压」这条路：
 * 只要求 Node ≥ 20（DSH 桌面端自带 runtime，一定有），不要求 git / tar / bash。
 *
 * # tar 格式（这里只用得到的部分）
 *
 * 每个条目固定 512 字节头 + 内容（按 512 对齐补齐）：
 *
 *   @0    文件名（100）
 *   @100  权限（8，八进制）
 *   @108  uid / @116 gid
 *   @124  内容长度（12，八进制）
 *   @136  修改时间（12，八进制）
 *   @148  校验和（8）
 *   @156  typeflag（1）：'0'/'\0' 普通文件、'5' 目录、'2' 软链、
 *                        'x'/'g' pax 扩展头、'L' GNU 长文件名
 *   @157  链接目标（100）
 *   @257  magic "ustar"
 *   @345  prefix（155，长路径的前半段）
 *
 * 长路径（本仓库的 `…/dsh-wotr-console/vendor/xdpool/lib/client.js` 就可能超 100）
 * 有两条来源，都要支持：`prefix` 字段拼接，以及 pax 扩展头的 `path=` 记录。
 *
 * # 安全
 *
 * 解的是**远端内容**，所以路径一律校验：拒绝绝对路径、`..`、Windows 盘符与
 * 反斜杠分隔符。任何一条不合规就整包失败（而不是跳过）—— 静默跳过会让
 * 「装完了但少文件」这种问题变得极难查。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;

const cstr = (buf, start, length) => {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
};

const octal = (buf, start, length) => {
  const raw = cstr(buf, start, length).trim();
  if (raw === '') return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
};

/** pax 扩展头：`"<总长> key=value\n"` 反复排列。 */
function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number.parseInt(data.subarray(i, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length) break;
    const record = data.subarray(sp + 1, i + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, '');
    i += len;
  }
  return out;
}

const isZeroBlock = (buf) => buf.every((b) => b === 0);

/**
 * 校验归档内的相对路径。
 *
 * @returns {string|undefined} 不合规时返回原因（中文，直接进错误信息）
 */
export function unsafeEntryReason(rel) {
  if (rel === '' || rel === '.' || rel === './') return '空路径';
  if (rel.includes('\\')) return '含反斜杠';
  if (rel.startsWith('/')) return '绝对路径';
  if (/^[a-zA-Z]:/.test(rel)) return 'Windows 盘符';
  const parts = rel.split('/');
  if (parts.some((p) => p === '..')) return '含 ..';
  return undefined;
}

/**
 * 遍历 tar（未压缩）的全部条目。
 *
 * @param {Buffer} buf
 * @param {(entry: {path: string, type: string, data: Buffer, mode: number, linkname?: string}) => void} onEntry
 */
export function walkTar(buf, onEntry) {
  let offset = 0;
  let pax = {};
  let longName;

  while (offset + BLOCK <= buf.length) {
    const block = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) break; // 归档结束（后面可能还有填充）

    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const data = buf.subarray(dataStart, Math.min(dataEnd, buf.length));

    const name = longName ?? pax.path ?? (() => {
      const base = cstr(block, 0, 100);
      const prefix = cstr(block, 345, 155);
      return prefix === '' ? base : `${prefix}/${base}`;
    })();

    if (type === 'x' || type === 'g') {
      pax = { ...(type === 'g' ? pax : {}), ...parsePax(data) };
      longName = undefined;
      offset = next;
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      offset = next;
      continue;
    }

    const entry = {
      path: name,
      type: type === '\0' || type === '' ? '0' : type,
      data,
      mode: octal(block, 100, 8) & 0o777,
      linkname: cstr(block, 157, 100),
    };

    onEntry(entry);
    pax = {};
    longName = undefined;
    offset = next;
  }
}

/**
 * 解压 `.tar.gz` 到目录。
 *
 * @param {Buffer} gz gzip 内容
 * @param {string} dest 目标目录（不存在则创建）
 * @param {{strip?: number, filter?: (rel: string) => boolean, onFile?: (rel: string, bytes: number) => void}} [opts]
 * @returns {{files: number, bytes: number, dirs: number, skipped: number}}
 */
export function extractTarGz(gz, dest, opts = {}) {
  const strip = opts.strip ?? 0;
  const filter = opts.filter;
  const tar = zlib.gunzipSync(gz);
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let skipped = 0;

  walkTar(tar, (entry) => {
    const parts = entry.path.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.length <= strip) { skipped += 1; return; }
    const rel = parts.slice(strip).join('/');
    const reason = unsafeEntryReason(rel);
    if (reason !== undefined) throw new Error(`归档内路径不安全（${reason}）：${entry.path}`);
    if (filter !== undefined && !filter(rel)) { skipped += 1; return; }

    const target = path.join(dest, rel);
    // 二次防线：拼出来的绝对路径必须仍在目标目录内
    const rel2 = path.relative(dest, target);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
      throw new Error(`归档内路径逃出目标目录：${entry.path}`);
    }

    if (entry.type === '5') {
      fs.mkdirSync(target, { recursive: true });
      dirs += 1;
      return;
    }
    if (entry.type === '2') {
      // 软链：本仓库里没有，出现了也照做（同为归档内容），但不允许指向目录外
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      fs.symlinkSync(entry.linkname, target);
      files += 1;
      return;
    }
    if (entry.type !== '0') { skipped += 1; return; } // 块设备/FIFO 之类一律跳过

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: entry.mode === 0 ? 0o644 : entry.mode });
    files += 1;
    bytes += entry.data.length;
    opts.onFile?.(rel, entry.data.length);
  });

  return { files, bytes, dirs, skipped };
}
