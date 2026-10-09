import * as cs from '../lib/credit-store.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wbc-'));
cs.setDataDir(dir);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra??''}`); } };

ok('空状态', cs.summarize().accounts.length===0);

await cs.recordStatus([
  { id:'u1', nickname:'1412', credits:{total:1000}, checkin:{todayCheckedIn:true,streakDays:9} },
  { id:'u2', nickname:'test', credits:{total:500}, checkin:{todayCheckedIn:false,streakDays:2} },
], {source:'test'});
let s = cs.summarize();
ok('两个账号', s.accounts.length===2, `got ${s.accounts.length}`);
ok('总额正确', s.accounts.find(a=>a.uid==='u1')?.credit===1000);
ok('签到状态', s.accounts.find(a=>a.uid==='u1')?.checkedIn===true);

await cs.recordStatus([{id:'u1',nickname:'1412',credits:{total:1200},checkin:{todayCheckedIn:true,streakDays:9}}]);
s = cs.summarize();
ok('净变化 +200', s.dailyTrend[0]?.delta===200, `got ${JSON.stringify(s.dailyTrend)}`);
ok('samples 去重为2', cs.readSamples({}).length===2, `got ${cs.readSamples({}).length}`);
ok('最新额度 1200', s.accounts.find(a=>a.uid==='u1')?.credit===1200);

await cs.recordStatus([{id:'u1',nickname:'1412',credits:{total:800}}]);
s = cs.summarize();
ok('消耗后净变化 -200', s.dailyTrend[0]?.delta===-200, `got ${s.dailyTrend[0]?.delta}`);
const d0 = JSON.parse(fs.readFileSync(path.join(dir,'daily.jsonl'),'utf8').trim().split('\n')[0]);
ok('daily 首=1000 末=800', d0.first===1000 && d0.last===800, JSON.stringify(d0));
ok('daily n 计数', d0.n===3, `got ${d0.n}`);

fs.appendFileSync(path.join(dir,'credit-samples.jsonl'),'not-json\n');
ok('坏行容错', cs.readSamples({}).length===2);

await cs.recordStatus([{id:'u9'}]);
ok('缺积分跳过', cs.readSamples({}).length===2);

ok('history 有记录', cs.readHistory({}).length>=2, `got ${cs.readHistory({}).length}`);
ok('uid 过滤', cs.readHistory({uid:'u1'}).every(r=>r.uid==='u1'));

fs.rmSync(dir,{recursive:true,force:true});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail>0?1:0);
