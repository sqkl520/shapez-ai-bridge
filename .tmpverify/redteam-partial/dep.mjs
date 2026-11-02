/* 模型写过多轮「宏之间互相依赖」的调用吗？若有，部分执行才有理论价值（先落 A，再让依赖 A 的 B 下轮成）。 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
let total = 0, withPending = 0, withBBox = 0, withPathOf = 0;
const samples = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`; if (seen.has(k)) continue; seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    total++;
    const blob = JSON.stringify(p.calls);
    if (/"pending"/.test(blob)) { withPending++; samples.push(blob.slice(0, 200)); }
    if (/\$bbox_of/.test(blob)) withBBox++;
    if (/\$path_of/.test(blob)) withPathOf++;
  }
}
console.log('去重样本:', total);
console.log('  引用上一宏 pending token（真正的宏间依赖）:', withPending);
console.log('  用 $bbox_of:', withBBox, '  用 $path_of:', withPathOf);
for (const s of samples.slice(0, 3)) console.log('   ', s);
