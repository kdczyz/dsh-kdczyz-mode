/**
 * 新设备安装器（tools/install-wotr.mjs + tools/lib/*）的单测。
 *
 * # 为什么这条测试重要
 *
 * 安装器是「别的设备能不能用起来」的唯一入口，而它的每一段都很难在出错时被察觉：
 *
 * 1. **tar.gz 解压**：本仓库不依赖 `tar` 命令（Windows 上不保证有），自己解。
 *    解错的表现不是报错，是「少几个文件」—— 而插件缺 vendor/ 或 lib/ 里的
 *    某个文件时，往往要到运行时才炸。
 * 2. **asar 读取**：宿主内包必须从这个单文件归档里读出来。头部结构是两层
 *    嵌套 pickle，长度字段的层级随实现变；这里用真机 app.asar 硬校验
 *    「读出来的内容与磁盘上已装配副本逐字节一致」。
 * 3. **profile 修补**：改的是用户自己的配置。profile 层 `cordis.patch.yml`
 *    条目下面的 `config:` 就是用户设置本身（Trae 那条实测近 500 行），
 *    所以「只改名、只补条目、绝不删除」必须是断言，而不是注释里的承诺。
 * 4. **pnpm 副本清理**：新设备上多半先用插件管理器装过一次。pnpm 装出来的
 *    副本在解析链上比宿主更近，只要它还在，宿主那份永远轮不到 ——
 *    而且现象是静默的（provider 不出现，零报错）。
 *
 * 最后一段是**真装一次**：往一个临时 profile 里跑完整 install()，
 * 断言插件能在那份 profile 下被真实 import（复用 host-assembly 的判据）。
 *
 * 运行：node tools/test/install-wotr.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { AsarArchive, looksLikeAsar } from '../lib/asar.mjs';
import { extractTarGz, unsafeEntryReason, walkTar } from '../lib/tar-gz.mjs';
import {
  PLUGIN_NAME,
  copyTree,
  install,
  mergeNpmrc,
  neutralizePnpmCopies,
  patchCordisYaml,
  patchProfilePackageJson,
} from '../lib/install.mjs';
import { PLUGIN_TOP_LEVEL, discoverHost, isPlatformNoise, linkTopLevel } from '../lib/host-deps.mjs';

// 引导段（单独跑时那一段）也直接测：它是新设备上**第一个**跑起来的代码，
// 网络抖一下就得能自己缓过来，且失败时要说清楚为什么。
import { download, describe as describeFetchError, parseArgs, tarballUrl } from '../install-wotr.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
};
const eq = (name, actual, expected) =>
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
const skipped = (name, why) => { skip += 1; console.log(`  - ${name}（跳过：${why}）`); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wotr-install-test-'));

/* ------------------------------------------------------------------ *
 * 0) 造一个 tar.gz：本测试自己写 tar，不依赖 tar 命令、不联网
 * ------------------------------------------------------------------ */

const BLOCK = 512;

/** 单个 tar 头（含 ustar magic；长路径走 pax 扩展头）。 */
function tarHeader(name, size, type = '0') {
  const buf = Buffer.alloc(BLOCK);
  const write = (str, offset, length) => {
    Buffer.from(str, 'utf8').copy(buf, offset, 0, length);
  };
  // 名字超过 100 字节时留空，改由 pax 的 path 记录提供
  if (Buffer.byteLength(name) <= 100) write(name, 0, 100);
  write('0000644', 100, 8);       // mode
  write('0000000', 108, 8);       // uid
  write('0000000', 116, 8);       // gid
  write(size.toString(8).padStart(11, '0'), 124, 12);
  write('00000000000', 136, 12);  // mtime
  write('        ', 148, 8);      // checksum 先填空格
  write(type, 156, 1);
  write('ustar', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const b of buf) sum += b;
  write(sum.toString(8).padStart(6, '0'), 148, 6);
  buf[154] = 0;
  return buf;
}

/** pax 扩展头（长路径用）。记录格式：`"<整条记录字节数> key=value\n"`。 */
function paxHeader(records) {
  let body = '';
  for (const [key, value] of Object.entries(records)) {
    const payload = `${key}=${value}\n`;
    // 长度字段本身也计入长度，所以要迭代到稳定（数字位数可能进位）
    let len = Buffer.byteLength(payload) + 3;
    for (;;) {
      const candidate = Buffer.byteLength(`${len} ${payload}`);
      if (candidate === len) break;
      len = candidate;
    }
    body += `${len} ${payload}`;
  }
  const data = Buffer.from(body, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
  data.copy(padded);
  return Buffer.concat([tarHeader('PaxHeaders/x', data.length, 'x'), padded]);
}

/** 打一个 tar.gz。 */
function makeTarGz(entries, top = 'repo-main') {
  const chunks = [];
  for (const e of entries) {
    const full = `${top}/${e.path}`;
    const data = Buffer.from(e.content ?? '', 'utf8');
    if (Buffer.byteLength(full) > 100) chunks.push(paxHeader({ path: full }));
    if (e.type === '5') {
      chunks.push(tarHeader(`${full}/`, 0, '5'));
      continue;
    }
    chunks.push(tarHeader(Buffer.byteLength(full) > 100 ? 'placeholder' : full, data.length));
    const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
    data.copy(padded);
    chunks.push(padded);
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // 结束标记
  return zlib.gzipSync(Buffer.concat(chunks));
}

console.log('新设备安装器（tools/install-wotr.mjs）\n');

/* ------------------------------------------------------------------ *
 * 1) tar.gz 解压
 * ------------------------------------------------------------------ */
console.log('—— 1) tar.gz 解压 ——');
{
  const dest = path.join(tmpRoot, 'untar');
  const longPath = `dsh-wotr-console/vendor/${'x'.repeat(90)}/client.js`;
  const gz = makeTarGz([
    { path: 'dsh-wotr-console/package.json', content: '{"name":"dsh-wotr-console"}' },
    { path: 'dsh-wotr-console/lib/', type: '5' },
    { path: 'dsh-wotr-console/lib/index.js', content: 'export const a = 1;' },
    { path: 'dsh-wotr-console/lib/empty.js', content: '' },
    { path: longPath, content: '// long' },
  ]);
  const r = extractTarGz(gz, dest, { strip: 1 });
  eq('解出文件数', r.files, 4);
  eq('目录条目', r.dirs, 1);
  ok('普通文件内容正确',
    fs.readFileSync(path.join(dest, 'dsh-wotr-console/lib/index.js'), 'utf8') === 'export const a = 1;');
  ok('空文件也建出来', fs.existsSync(path.join(dest, 'dsh-wotr-console/lib/empty.js')));
  ok('超长路径（pax path）解对', fs.existsSync(path.join(dest, longPath)));
  ok('顶层目录已 strip 掉', !fs.existsSync(path.join(dest, 'repo-main')));
}

{
  // 路径安全：解的是远端内容，逃出目标目录必须整包失败
  const dest = path.join(tmpRoot, 'untar-evil');
  const evil = makeTarGz([{ path: '../evil.txt', content: 'x' }]);
  let threw;
  try { extractTarGz(evil, dest, { strip: 0 }); } catch (error) { threw = error.message; }
  ok('拒绝 ../ 路径', threw !== undefined && threw.includes('不安全'), threw);
  eq('unsafeEntryReason 判绝对路径', unsafeEntryReason('/etc/passwd'), '绝对路径');
  eq('unsafeEntryReason 判盘符', unsafeEntryReason('C:/x'), 'Windows 盘符');
  eq('unsafeEntryReason 判反斜杠', unsafeEntryReason('a\\b'), '含反斜杠');
  eq('正常路径放行', unsafeEntryReason('a/b/c.js'), undefined);
}

{
  // xz 之外的分支：归档里的块设备等条目应被跳过而不是当成文件写出来
  const dest = path.join(tmpRoot, 'untar-special');
  const gz = makeTarGz([{ path: 'a/b', content: 'x' }]);
  let types = [];
  walkTar(zlib.gunzipSync(gz), (e) => types.push(e.type));
  eq('普通文件的 typeflag 归一为 0', types.join(','), '0');
  const r = extractTarGz(gz, dest, { strip: 0 });
  eq('解压计数一致', r.files, 1);
}

/* ------------------------------------------------------------------ *
 * 2) profile 配置修补（纯函数）
 * ------------------------------------------------------------------ */
console.log('\n—— 2) profile 配置修补 ——');
{
  const pkg = {
    name: 'desktop',
    dependencies: { 'dsh-workbuddy-console': 'link:/old/wb', 'dsh-connect-trae': '^1.0.0', 'left-pad': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-workbuddy-console', 'dsh-connect-trae'] } },
  };
  const r = patchProfilePackageJson(pkg);
  ok('旧包名从 dependencies 移除', pkg.dependencies['dsh-workbuddy-console'] !== undefined
    && r.pkg.dependencies['dsh-workbuddy-console'] === undefined);
  ok('新包名指向 link:.dsh-wotr-src', r.pkg.dependencies[PLUGIN_NAME] === 'link:.dsh-wotr-src');
  eq('其他依赖不动', r.pkg.dependencies['left-pad'], '^1.0.0');
  eq('bundles 里旧包已替换', r.bundles.join(','), '@deepseek-ai/dsh-base,dsh-wotr-console');
  ok('不重复插入', patchProfilePackageJson(r.pkg).bundles.filter((b) => b === PLUGIN_NAME).length === 1);
  ok('不改原对象', pkg.dependencies[PLUGIN_NAME] === undefined);
}

{
  const yaml = [
    '- id: llm-workbuddy-xdpool',
    '  name: dsh-workbuddy-console',
    '  config:',
    '    selectedAccountId: abc',
    '- id: dsh-connect-trae',
    '  name: dsh-connect-trae',
    '  config:',
    '    accounts:',
    '      cn: user@example.com',
    '',
  ].join('\n');
  const r = patchCordisYaml(yaml);
  ok('WorkBuddy 条目改名', r.yaml.includes('name: dsh-wotr-console\n'));
  ok('Trae 条目改成子路径', r.yaml.includes('name: dsh-wotr-console/trae'));
  ok('**config 逐字保留**（WorkBuddy）', r.yaml.includes('selectedAccountId: abc'));
  ok('**config 逐字保留**（Trae 账号绑定）', r.yaml.includes('cn: user@example.com'));
  ok('补上 Qoder 条目', r.yaml.includes('- id: dsh-connect-qoder\n  name: dsh-wotr-console/qoder'));
  eq('只补缺的那一条（另两条已存在）', r.added.join(','), 'dsh-connect-qoder');
  eq('改名了两条', r.renamed.length, 2);

  const again = patchCordisYaml(r.yaml);
  ok('幂等：再跑一次不改动', again.changed === false, JSON.stringify(again.renamed));
  eq('幂等：不重复插 Qoder 条目',
    again.yaml.split('name: dsh-wotr-console/qoder').length - 1, 1);
  ok('幂等：旧包名一个不剩', !/name: dsh-(workbuddy-console|connect-trae)\s*$/m.test(again.yaml));
}

{
  // 全新 profile：cordis.patch.yml 可能不存在，或只有一个别的 preset
  const fresh = patchCordisYaml('- id: preset-standard\n  name: "@deepseek-ai/dsh-preset-standard"\n  config:\n    persona: x\n');
  eq('空 profile 补齐三个条目', fresh.added.join(','), 'llm-workbuddy-xdpool,dsh-connect-trae,dsh-connect-qoder');
  for (const spec of [['llm-workbuddy-xdpool', 'dsh-wotr-console'],
    ['dsh-connect-trae', 'dsh-wotr-console/trae'],
    ['dsh-connect-qoder', 'dsh-wotr-console/qoder']]) {
    ok(`三个条目都在（${spec[0]}）`, fresh.yaml.includes(`- id: ${spec[0]}\n  name: ${spec[1]}`));
  }
  ok('别人的 preset 原样保留', fresh.yaml.includes('persona: x'));
  ok('空文件时没有改名动作', fresh.renamed.length === 0);
  const freshAgain = patchCordisYaml(fresh.yaml);
  ok('新 profile 二次跑也不改动', freshAgain.changed === false);
}

{
  eq('npmrc：新写一行', mergeNpmrc(''), 'auto-install-peers=false\n');
  eq('npmrc：保留已有配置',
    mergeNpmrc('registry=https://registry.npmmirror.com\n'), 'registry=https://registry.npmmirror.com\nauto-install-peers=false\n');
  eq('npmrc：覆盖同名的旧值（幂等）',
    mergeNpmrc('auto-install-peers=true\n'), 'auto-install-peers=false\n');
  const twice = mergeNpmrc(mergeNpmrc('registry=x\n'));
  eq('npmrc：重复合并不叠加', twice, 'registry=x\nauto-install-peers=false\n');
}

/* ------------------------------------------------------------------ *
 * 3) asar 读取（真机 app.asar）
 * ------------------------------------------------------------------ */
console.log('\n—— 3) asar 读取 ——');
const host = discoverHost();
if (host === undefined || host.kind !== 'asar') {
  skipped('asar 读取', '本机没有找到 app.asar（非 DSH 安装机？）');
} else {
  const archive = new AsarArchive(host.file);
  ok('looksLikeAsar 认得出真 asar', looksLikeAsar(host.file));
  ok('looksLikeAsar 不会被普通文件骗', !looksLikeAsar(path.join(REPO_ROOT, 'package.json')));

  const rel = 'dsh/node_modules/@deepseek-ai/dsh-llm/package.json';
  const pj = JSON.parse(archive.readFile(rel).toString('utf8'));
  ok('读得出宿主包版本', /^\d+\.\d+\.\d+/.test(String(pj.version)), String(pj.version));
  ok('锚点包名对', pj.name === '@deepseek-ai/dsh-llm', String(pj.name));

  const files = archive.listFiles('dsh/node_modules/@deepseek-ai/dsh-llm');
  ok('能列目录', files.length > 10, `${files.length} 个文件`);

  // 与磁盘上已装配的副本逐字节比对 —— 这条才是「读出来的内容是真的」的证据
  const disk = path.join(
    path.dirname(path.dirname(host.file)), '..', '..', '..', '..', '..',
  );
  const assembled = path.join(os.homedir(), '.dsh', 'profiles', 'desktop',
    '.dsh-runtime-deps', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json');
  if (fs.existsSync(assembled)) {
    ok('内容与已装配副本逐字节一致',
      archive.readFile(rel).equals(fs.readFileSync(assembled)));
  } else {
    skipped('与已装配副本比对', 'profile 里还没有已装配的副本');
  }
  void disk;

  let threw;
  try { new AsarArchive(path.join(REPO_ROOT, 'package.json')); } catch (error) { threw = error.message; }
  ok('非 asar 文件明确报错', typeof threw === 'string' && threw.includes('asar'), threw);
  archive.close();
}

/* ------------------------------------------------------------------ *
 * 4) 端到端：往临时 profile 里真装一次
 * ------------------------------------------------------------------ */
console.log('\n—— 4) 端到端安装（临时 profile） ——');
if (host === undefined) {
  skipped('端到端安装', '本机没有 DSH 宿主包目录');
} else {
  const home = path.join(tmpRoot, 'home');
  const profile = path.join(home, '.dsh', 'profiles', 'desktop');
  const nm = path.join(profile, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: 'desktop',
    dependencies: { 'dsh-workbuddy-console': 'link:/gone', 'left-pad': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-workbuddy-console'] } },
  }, undefined, 2)}\n`);
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- id: dsh-connect-trae',
    '  name: dsh-connect-trae',
    '  config:',
    '    accounts:',
    '      cn: keep-me@example.com',
    '',
  ].join('\n'));
  // 模拟「先用插件管理器装过一次」：实体在 .pnpm 里，顶层是软链
  const pnpmPkg = path.join(nm, '.pnpm', 'dsh-wotr-console@https+github', 'node_modules');
  fs.mkdirSync(path.join(pnpmPkg, 'dsh-wotr-console'), { recursive: true });
  fs.writeFileSync(path.join(pnpmPkg, 'dsh-wotr-console', 'package.json'), '{"name":"dsh-wotr-console"}');
  fs.mkdirSync(path.join(pnpmPkg, '@deepseek-ai', 'dsh-llm'), { recursive: true });
  fs.writeFileSync(path.join(pnpmPkg, '@deepseek-ai', 'dsh-llm', 'package.json'), '{"name":"@deepseek-ai/dsh-llm","version":"0.1.7-rc.2"}');
  fs.symlinkSync(path.join(pnpmPkg, 'dsh-wotr-console'), path.join(nm, 'dsh-wotr-console'), 'dir');
  fs.mkdirSync(path.join(nm, 'dsh-workbuddy-console'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'dsh-workbuddy-console', 'package.json'), '{"name":"dsh-workbuddy-console"}');

  const logs = [];
  const summary = install({
    sourceDir: REPO_ROOT,
    profile,
    home,
    log: (m) => logs.push(m),
  });

  ok('插件实体是真目录（不是软链）',
    fs.lstatSync(path.join(nm, PLUGIN_NAME)).isDirectory() && !fs.lstatSync(path.join(nm, PLUGIN_NAME)).isSymbolicLink());
  ok('lib/index.js 到位', fs.existsSync(path.join(nm, PLUGIN_NAME, 'lib', 'index.js')));
  ok('源码副本 .dsh-wotr-src 到位', fs.existsSync(path.join(profile, '.dsh-wotr-src', 'package.json')));
  ok('pnpm 副本已清理', !fs.existsSync(path.join(nm, '.pnpm')));
  ok('旧包目录已移除', !fs.existsSync(path.join(nm, 'dsh-workbuddy-console')));
  ok('宿主内包软链到位', fs.existsSync(path.join(nm, '@earendil-works', 'pi-ai', 'package.json')));
  ok('宿主内包实体在位',
    fs.existsSync(path.join(profile, '.dsh-runtime-deps', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')));

  const pj = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  eq('profile 依赖指向 link:.dsh-wotr-src', pj.dependencies[PLUGIN_NAME], 'link:.dsh-wotr-src');
  eq('旧依赖已删', pj.dependencies['dsh-workbuddy-console'], undefined);
  eq('其他依赖保留', pj.dependencies['left-pad'], '^1.0.0');
  eq('bundles 正确', pj.dsh.profile.bundles.join(','), '@deepseek-ai/dsh-base,dsh-wotr-console');

  const yml = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
  ok('用户 Trae config 保留', yml.includes('cn: keep-me@example.com'));
  ok('Trae 条目改名', yml.includes('name: dsh-wotr-console/trae'));
  ok('Qoder 条目已补', yml.includes('name: dsh-wotr-console/qoder'));
  eq('.npmrc 已写', fs.readFileSync(path.join(profile, '.npmrc'), 'utf8'), 'auto-install-peers=false\n');
  ok('备份目录建了', summary.backup !== undefined && fs.existsSync(summary.backup));
  ok('备份里有原 package.json', summary.backup !== undefined
    && JSON.parse(fs.readFileSync(path.join(summary.backup, 'package.json'), 'utf8')).dependencies['left-pad'] === '^1.0.0');
  ok('日志里有自检通过', logs.some((l) => l.includes('host-assembly')));

  // 幂等：再装一次，配置不变、宿主包沿用
  const before = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
  const second = install({ sourceDir: REPO_ROOT, profile, home, log: () => {} });
  eq('二次安装 profile 配置不变', fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), before);
  eq('二次安装版本一致', second.version, summary.version);

  // dry-run：一个文件都不该动
  const pkgBefore = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
  fs.writeFileSync(path.join(profile, '.npmrc'), 'sentinel=1\n');
  install({ sourceDir: REPO_ROOT, profile, home, dryRun: true, log: () => {} });
  eq('dry-run 不改 package.json', fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), pkgBefore);
  eq('dry-run 不改 .npmrc', fs.readFileSync(path.join(profile, '.npmrc'), 'utf8'), 'sentinel=1\n');

  // 缺 profile 时给出可操作的报错，而不是堆栈
  let err;
  try { install({ sourceDir: REPO_ROOT, profile: path.join(tmpRoot, 'nope'), home, log: () => {} }); }
  catch (error) { err = error.message; }
  ok('profile 不存在时报错可操作', typeof err === 'string' && err.includes('先启动一次 DSH'), err);
}

/* ------------------------------------------------------------------ *
 * 5) peer 版本范围：必须选得中宿主的版本
 * ------------------------------------------------------------------ */

/**
 * 一个极小的 semver satisfies（只覆盖本仓库写出来的那几种范围写法）。
 *
 * 为什么自己写而不是引 semver：本仓库零运行时依赖，测试也不该为一条断言
 * 引包。这里的期望值全部用**宿主 asar 里的 semver 7.8.5** 核对过
 * （旧范围 `>=0.1.7-rc.1 <0.3.0-0` 对 `0.2.0-rc.2` 判 false，新范围判 true）——
 * 也就是说这个实现是被真实现校准过的，不是「我自己觉得对」。
 */
const parseVer = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v));
  if (m === null) return undefined;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
};
const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;   // 有 pre 的小于没有 pre 的
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;  // 数字标识符 < 字母标识符
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const cmpVer = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  return cmpPre(a.pre, b.pre);
};
/** 单条比较符；`^` 展开成上界时用 `<下一个元组>-0`（semver 的规则）。 */
function cmpOne(version, op, target) {
  const c = cmpVer(version, target);
  if (op === '>=') return c >= 0;
  if (op === '<') return c < 0;
  if (op === '^') {
    if (c < 0) return false;
    const [maj, min] = target.nums;
    const upper = maj > 0 ? [maj + 1, 0, 0] : min > 0 ? [0, min + 1, 0] : [0, 0, target.nums[2] + 1];
    return cmpVer(version, { nums: upper, pre: ['0'] }) < 0;
  }
  throw new Error(`测试里的迷你 semver 不认识 ${op}`);
}
function satisfies(version, range) {
  const v = parseVer(version);
  for (const alt of String(range).split('||')) {
    const parts = alt.trim().split(/\s+/).filter((x) => x !== '');
    const comparators = parts.map((p) => {
      const m = /^(>=|<|\^)?\s*(.+)$/.exec(p);
      const op = m[1] ?? '';
      return { op: op === '' ? '=' : op, target: parseVer(m[2]) };
    });
    if (comparators.some((c) => c.target === undefined)) throw new Error(`迷你 semver 不认识的写法：${range}`);
    if (!comparators.every((c) => (c.op === '=' ? cmpVer(v, c.target) === 0 : cmpOne(v, c.op, c.target)))) continue;
    // semver 的预发布规则：带 pre 的版本，必须有**同一个元组**的比较符也带 pre 才算命中
    if (v.pre.length > 0
      && !comparators.some((c) => c.target.pre.length > 0
        && c.target.nums[0] === v.nums[0] && c.target.nums[1] === v.nums[1] && c.target.nums[2] === v.nums[2])) continue;
    return true;
  }
  return false;
}

console.log('\n—— 5) peer 版本范围 ——');
{
  // 先校准迷你 semver 本身：这几条与宿主 asar 里的 semver 7.8.5 结论一致
  ok('迷你 semver：旧范围选不中 0.2.0-rc.2（这就是那个 bug）',
    satisfies('0.2.0-rc.2', '>=0.1.7-rc.1 <0.3.0-0') === false);
  ok('迷你 semver：新范围选得中 0.2.0-rc.2',
    satisfies('0.2.0-rc.2', '^0.1.7-rc.1 || ^0.2.0-rc.1') === true);
  ok('迷你 semver：同级更高线不越界',
    satisfies('0.3.0', '^0.1.7-rc.1 || ^0.2.0-rc.1') === false);
  ok('迷你 semver：另一条预发布线不误命中',
    satisfies('0.2.1-alpha.2', '^0.1.7-rc.1 || ^0.2.0-rc.1') === false);
  ok('迷你 semver：0.1.7 线仍然命中',
    satisfies('0.1.7-rc.2', '^0.1.7-rc.1 || ^0.2.0-rc.1') === true);

  for (const manifest of ['package.json', path.join('dsh-wotr-console', 'package.json')]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest), 'utf8'));
    const peers = pkg.peerDependencies ?? {};
    const wrong = [];
    for (const name of PLUGIN_TOP_LEVEL) {
      const range = peers[name];
      if (range === undefined) { wrong.push(`${name} 未声明`); continue; }
      // `@deepseek-ai/dsh-*` 跟着 DSH 自己的版本线走（0.1.x → 0.2.x）；
      // cordis / schemastery / pi-ai 各有各的线，交给下面「宿主实际版本」那条断言兜。
      if (!name.startsWith('@deepseek-ai/dsh-')) continue;
      for (const probe of ['0.1.7-rc.2', '0.2.0-rc.2']) {
        if (!satisfies(probe, range)) wrong.push(`${name}@${probe} 不在 ${range} 内`);
      }
      if (satisfies('0.3.0', range)) wrong.push(`${name} 范围过宽（放进 0.3.0）`);
    }
    ok(`${manifest} 的 6 个 dsh-* peer 覆盖两条版本线`, wrong.length === 0, wrong.join('；'));
    ok(`${manifest} 的 pi-ai 范围覆盖宿主 0.87.1`, satisfies('0.87.1', peers['@earendil-works/pi-ai'] ?? ''));
    ok(`${manifest} 的 cordis 范围覆盖 4.0.4`, satisfies('4.0.4', peers['@deepseek-ai/cordis'] ?? ''));
    ok(`${manifest} 的 schemastery 范围覆盖 3.18.4`, satisfies('3.18.4', peers['@deepseek-ai/schemastery'] ?? ''));
  }

  // 最强的判据：宿主**实际**装着哪个版本，声明就必须覆盖它。
  // 这条断言正是当初发现 bug 的方式，换一台机器/换一版 DSH 之后仍然有效。
  if (host === undefined) {
    skipped('宿主实际版本 satisfy 声明的范围', '本机没有 DSH 宿主包目录');
  } else {
    const peers = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).peerDependencies;
    const bad = [];
    const seen = [];
    for (const name of PLUGIN_TOP_LEVEL) {
      let version;
      try {
        version = JSON.parse(host.read(`${name}/package.json`).toString('utf8')).version;
      } catch (error) {
        bad.push(`${name} 读不到（${error.message.split('\n')[0]}）`);
        continue;
      }
      seen.push(`${name.replace(/^@[^/]+\//, '')}@${version}`);
      if (!satisfies(version, peers[name])) bad.push(`${name}@${version} 不满足 ${peers[name]}`);
    }
    ok('宿主实际版本全部落在声明范围内', bad.length === 0, bad.join('；'));
    console.log(`    （本机宿主：${seen.join(', ')}）`);
  }
}

/* ------------------------------------------------------------------ *
 * 6) 清理与辅助
 * ------------------------------------------------------------------ */
console.log('\n—— 6) 辅助函数 ——');
{
  const from = path.join(tmpRoot, 'copy-src');
  fs.mkdirSync(path.join(from, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(from, 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(from, '.git'), { recursive: true });
  fs.writeFileSync(path.join(from, 'lib', 'a.js'), 'x');
  fs.writeFileSync(path.join(from, 'node_modules', 'junk', 'b.js'), 'x');
  fs.writeFileSync(path.join(from, '.git', 'HEAD'), 'x');
  const to = path.join(tmpRoot, 'copy-dst');
  const r = copyTree(from, to);
  eq('复制文件数', r.files, 1);
  ok('跳过 node_modules', !fs.existsSync(path.join(to, 'node_modules')));
  ok('跳过 .git', !fs.existsSync(path.join(to, '.git')));
  ok('内容在位', fs.existsSync(path.join(to, 'lib', 'a.js')));
}
{
  const profileNm = path.join(tmpRoot, 'guard', 'node_modules');
  const pnpmReal = path.join(profileNm, '.pnpm', 'dsh-wotr-console@x', 'node_modules', 'dsh-wotr-console');
  fs.mkdirSync(pnpmReal, { recursive: true });
  fs.symlinkSync(pnpmReal, path.join(profileNm, 'dsh-wotr-console'), 'dir');
  const removed = neutralizePnpmCopies({ profileNm, dryRun: false, log: () => {} });
  eq('清理两处（顶层软链 + .pnpm 真身）', removed.length, 2);
  ok('.pnpm 下的副本没了', !fs.existsSync(path.join(profileNm, '.pnpm', 'dsh-wotr-console@x')));
  ok('顶层软链也没了', !fs.existsSync(path.join(profileNm, 'dsh-wotr-console')));
  ok('空掉的 .pnpm 一并收走', !fs.existsSync(path.join(profileNm, '.pnpm')));
}
{
  ok('平台噪音过滤（win32 原生包）', isPlatformNoise('@img/sharp-win32-x64'));
  ok('平台噪音过滤（linux）', isPlatformNoise('@esbuild/linux-x64'));
  ok('真缺失不放过', !isPlatformNoise('@deepseek-ai/dsh-llm'));
}
{
  let err;
  try { install({ sourceDir: path.join(tmpRoot, 'no-such-src'), profile: tmpRoot, home: tmpRoot, log: () => {} }); }
  catch (error) { err = error.message; }
  ok('源码目录不存在时报错', typeof err === 'string' && err.includes('找不到插件'), err);
}

/* ------------------------------------------------------------------ *
 * 7) 引导段的下载与参数：新设备上第一段跑起来的代码
 * ------------------------------------------------------------------ */
{
  const http = await import('node:http');
  const { once } = await import('node:events');

  /** 起一个本地服务器当靶子（不碰外网，门禁离线也能跑）。 */
  const serve = async (handler) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    return { url: `http://127.0.0.1:${port}/x`, close: () => new Promise((r) => server.close(r)) };
  };
  const quiet = async (fn) => {
    const lines = [];
    const real = console.log;
    console.log = (m) => lines.push(String(m));
    try { return { value: await fn(), lines }; } finally { console.log = real; }
  };

  // 前两次 500、第三次成功 —— 实测网络抖动就是这个形状
  let hits = 0;
  const flaky = await serve((req, res) => {
    hits += 1;
    if (hits < 3) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200); res.end('OK-PAYLOAD');
  });
  {
    const { value, lines } = await quiet(() => download(flaky.url, '测试'));
    eq('抖两次后仍下成功', value.toString(), 'OK-PAYLOAD');
    eq('一共请求了三次', hits, 3);
    eq('重试过程有交代', lines.filter((l) => l.includes('重试')).length, 2);
    ok('重试提示带底层原因', lines.some((l) => l.includes('500')), lines.join(' | '));
  }
  await flaky.close();

  // 404 是地址写错了：不许重试，且要给出下一步
  let notFoundHits = 0;
  const missing = await serve((req, res) => { notFoundHits += 1; res.writeHead(404); res.end('nope'); });
  {
    let err = '';
    const { lines } = await quiet(async () => {
      try { await download(missing.url, '测试'); } catch (error) { err = error.message; }
      return undefined;
    });
    ok('404 报错提到 HTTP 404', err.includes('HTTP 404'), err);
    ok('404 给出线索（--repo/--ref）', err.includes('--repo'), err);
    ok('404 教了离线退路（--from）', err.includes('--from'), err);
    eq('404 只请求一次（不重试）', notFoundHits, 1);
    eq('404 时没有重试日志', lines.filter((l) => l.includes('重试')).length, 0);
  }
  await missing.close();
}
{
  eq('describe 带出 cause 的 code', describeFetchError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } }),
    'fetch failed（ECONNRESET）');
  eq('describe 无 cause 时只用 message', describeFetchError(new Error('HTTP 500')), 'HTTP 500');
  eq('describe 兜住 undefined', describeFetchError(undefined), '未知错误');

  const opts = parseArgs(['--profile', '/tmp/p', '--ref', 'v1.2.3', '--dry-run', '--repo', 'a/b']);
  eq('--profile 解析', opts.profile, '/tmp/p');
  eq('--ref 解析', opts.ref, 'v1.2.3');
  eq('--repo 解析', opts.repo, 'a/b');
  eq('--dry-run 解析', opts.dryRun, true);
  eq('默认 ref 是 main', parseArgs([]).ref, 'main');
  eq('默认仓库', parseArgs([]).repo, 'kdczyz/dsh-workbuddy-mode');

  const yamlErr = (argv) => { try { parseArgs(argv); return ''; } catch (error) { return error.message; } };
  ok('不认识的参数会报错', yamlErr(['--nope']).includes('--nope'), yamlErr(['--nope']));
  ok('参数缺值会报错', yamlErr(['--profile', '--dry-run']).includes('缺一个值'), yamlErr(['--profile', '--dry-run']));

  ok('分支走 refs/heads', tarballUrl('a/b', 'main').includes('/refs/heads/main'),
    tarballUrl('a/b', 'main'));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  ok('sha 直接拼', tarballUrl('a/b', sha).endsWith(`/${sha}`) && !tarballUrl('a/b', sha).includes('refs/'),
    tarballUrl('a/b', sha));
}

/* ------------------------------------------------------------------ *
 * 7.5) 宿主发现：Windows / Linux 的候选路径也要算出来
 *
 * 这一段没法在 macOS 上装出真的 Windows DSH，但候选路径算不算得出来是能验的：
 * 这些机子上路径只有一个，猜错了安装器就找不到宿主内包，而且报错必须告诉
 * 用户「我去哪儿找过了」，否则无从下手（`DSH_HOST_ASAR` 是逃生门）。
 * ------------------------------------------------------------------ */
{
  const winEnv = {
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    APPDATA: 'C:\\Users\\someone\\AppData\\Roaming',
  };
  const winHome = 'C:\\Users\\someone';
  const found = discoverHost({ platform: 'win32', env: winEnv, home: winHome });
  ok('win32：本机没有 DSH 时返回 undefined（不是抛错）', found === undefined, String(found));

  const { candidatePaths } = await import('../lib/host-deps.mjs');
  // 注意：path.join 用的是**宿主**的分隔符，所以在 macOS 上算 Windows 候选
  // 会得到混合分隔符（真机上全是反斜杠）。断言统一归一化后再比。
  const flat = (cands) => cands.map((c) => (c.file ?? c.root ?? '').replace(/\\/g, '/')).join('|');
  const wins = flat(candidatePaths({ platform: 'win32', env: winEnv, home: winHome }));
  ok('win32：翻 %LOCALAPPDATA%/Programs', wins.includes('AppData/Local/Programs'), wins.slice(0, 200));
  ok('win32：也翻 %ProgramFiles%', wins.includes('Program Files'), wins.slice(0, 200));
  ok('win32：候选里带 app.asar 与 resources', wins.includes('app.asar') && wins.includes('resources'), wins.slice(0, 200));
  ok('win32：每个候选都带 dsh/node_modules 与 node_modules 两个根',
    wins.includes('resources/dsh/node_modules'), wins.slice(0, 200));

  const nix = flat(candidatePaths({ platform: 'linux', env: {}, home: '/home/someone' }));
  ok('linux：翻 /opt 与 /usr/lib', nix.includes('/opt') && nix.includes('/usr/lib'), nix);
  ok('linux：也翻用户目录', nix.includes('/home/someone'), nix);

  // 逃生门：显式指定优先，且能被真正打开
  const viaEnv = discoverHost({ platform: 'linux', env: { DSH_HOST_ASAR: host.file }, home: '/nonexistent' });
  ok('DSH_HOST_ASAR 优先且可用', viaEnv !== undefined && viaEnv.kind === 'asar', String(viaEnv?.kind));
}

/* ------------------------------------------------------------------ *
 * 8) 软链那一层：Windows 走目录联接（junction），且要能反复跑
 *
 * 这是安装器里**最平台相关**的一段：Windows 的 junction 用 unlink 删、
 * 过期重链是常态（同一个 profile 反复装）。macOS 上也能验：Node 在 POSIX
 * 接受 'junction' 这个 type（忽略它），所以这一段能真的走通 win32 分支。
 * ------------------------------------------------------------------ */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-link-test-'));
  const vendorNm = path.join(root, 'vendor', 'node_modules');
  const profileNm = path.join(root, 'profile', 'node_modules');
  const writePkg = (dir, name, version) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  };
  writePkg(path.join(vendorNm, '@deepseek-ai', 'dsh-llm'), '@deepseek-ai/dsh-llm', '0.2.0-rc.2');
  fs.mkdirSync(profileNm, { recursive: true });

  const linkPath = path.join(profileNm, '@deepseek-ai', 'dsh-llm');
  for (const platform of ['win32', 'linux', 'darwin']) {
    const r = linkTopLevel({ profileNm, names: ['@deepseek-ai/dsh-llm'], vendorNm, platform, log: () => {} });
    eq(`${platform}: 建了 1 条`, r.linked, 1);
    eq(`${platform}: 没有跳过`, r.skipped.length, 0);
    ok(`${platform}: 是软链`, fs.lstatSync(linkPath).isSymbolicLink());
    const seen = JSON.parse(fs.readFileSync(path.join(linkPath, 'package.json'), 'utf8'));
    eq(`${platform}: 透过链读到实体`, seen.version, '0.2.0-rc.2');
    ok(`${platform}: 作用域目录也建了`, fs.existsSync(path.join(profileNm, '@deepseek-ai')));
  }

  // 反复装（链已存在）：要先删再建，不许抛 —— Windows 上 junction 不能用 rmSync 递归删
  const again = linkTopLevel({ profileNm, names: ['@deepseek-ai/dsh-llm'], vendorNm, platform: 'win32', log: () => {} });
  eq('重复装仍是 1 条（先删后建）', again.linked, 1);
  ok('重复装后链还在', fs.lstatSync(linkPath).isSymbolicLink());

  // 指向 asar 内部 / 临时目录的失效链要被清掉
  fs.unlinkSync(linkPath);
  fs.symlinkSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm',
    linkPath, 'dir');
  const cleaned = linkTopLevel({ profileNm, names: ['@deepseek-ai/dsh-llm'], vendorNm, platform: 'win32', log: () => {} });
  eq('清掉指向 asar 的失效链', cleaned.cleaned, 1);
  eq('清完照样重链', cleaned.linked, 1);

  // 实体不存在 → 跳过（不建一条指向空气的链）
  const gone = linkTopLevel({ profileNm, names: ['@deepseek-ai/does-not-exist'], vendorNm, platform: 'win32', log: () => {} });
  eq('实体缺失时跳过', gone.skipped.join(','), '@deepseek-ai/does-not-exist');
  ok('没给缺失的包建链', !fs.existsSync(path.join(profileNm, '@deepseek-ai', 'does-not-exist')));

  fs.rmSync(root, { recursive: true, force: true });
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\ninstall-wotr: ${pass} 通过, ${fail} 失败${skip > 0 ? `, ${skip} 跳过` : ''}\n`);
process.exit(fail === 0 ? 0 : 1);
