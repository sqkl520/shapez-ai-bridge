/**
 * 方案 E 的端到端效果：跑真实 buildTxPlan，看提交率和不可逆。
 * 区别于 reversible.mjs（那个是手工推演），这个走**真实现**。
 */
import fs from 'node:fs';
import { buildTxPlan } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h = buildHandles(OBS, null);

const plans = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
  const file = `.tmpverify/ab-real/results${f}.json`;
  if (!fs.existsSync(file)) continue;
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    plans.push(p);
  }
}

let nFull = 0, nPartial = 0, nRejected = 0;
let irrevFull = 0, irrevPartial = 0;
const reasons = {};
const partialSamples = [];

for (const plan of plans) {
  const a = buildTxPlan(plan, OBS, null, h);
  if (a.ok) {
    nFull++;
    if (a.txPlan.ops.some(o => o.op === 'place' && !['belt', 'underground_belt'].includes(o.building))) irrevFull++;
  }
  const b = buildTxPlan(plan, OBS, null, h, { partial: true });
  if (b.ok) {
    nPartial++;
    const bad = b.txPlan.ops.some(o => o.op === 'place' && !['belt', 'underground_belt'].includes(o.building));
    if (bad) irrevPartial++;
    if (b.partial && partialSamples.length < 3) {
      partialSamples.push({
        skipped: b.skipped.map(s => `${s.macro}:${s.reason}`),
        ops: b.txPlan.ops.length,
      });
    }
  } else {
    nRejected++;
    const c = b.diagnosis.code;
    reasons[c] = (reasons[c] || 0) + 1;
  }
}

console.log(`样本 ${plans.length}\n`);
console.log('                   全有或全无    partial:true');
console.log(`提交               ${String(nFull).padStart(4)}          ${String(nPartial).padStart(4)}`);
console.log(`  其中不可逆 place ${String(irrevFull).padStart(4)}          ${String(irrevPartial).padStart(4)}`);
console.log(`拒绝               ${String(plans.length - nFull).padStart(4)}          ${String(nRejected).padStart(4)}`);
console.log(`提交率             ${(100 * nFull / plans.length).toFixed(1).padStart(5)}%       ${(100 * nPartial / plans.length).toFixed(1).padStart(5)}%`);

console.log('\npartial 模式的拒绝原因:');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${String(v).padStart(3)} × ${k}`);
}

if (partialSamples.length) {
  console.log('\n部分执行的样例:');
  for (const s of partialSamples) {
    console.log(`  ops=${s.ops} skipped=${JSON.stringify(s.skipped)}`);
  }
}
