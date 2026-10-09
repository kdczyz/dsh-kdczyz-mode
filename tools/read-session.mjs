import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Split the concatenated zstd frames on the frame magic and decode each.
const starts = [];
let at = buf.indexOf(MAGIC, 0);
while (at !== -1) {
  starts.push(at);
  at = buf.indexOf(MAGIC, at + 4);
}
if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

let out = '';
let frames = 0;
let failed = 0;
for (let i = 0; i < starts.length; i += 1) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
  try {
    out += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8');
    frames += 1;
  } catch {
    failed += 1;
  }
}
console.log('frames decoded:', frames, 'failed:', failed, 'chars:', out.length);

const idx = out.indexOf('DSML');
if (idx === -1) {
  console.log('no DSML found in decoded text');
} else {
  console.log('\n--- raw text around first DSML (JSON-escaped) ---');
  console.log(JSON.stringify(out.slice(Math.max(0, idx - 200), idx + 400)));
}

// Also report how the assistant text looked, doubled or not.
const m = out.match(/"text":"((?:[^"\\]|\\.){0,400})"/g);
if (m) {
  console.log('\n--- first text fields ---');
  for (const s of m.slice(0, 3)) console.log(s.slice(0, 400));
}
