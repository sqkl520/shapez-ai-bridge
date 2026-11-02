/* 逐条删带子：下一轮的**指纹键**（code|handle）里出现几条新键？
   0 条 ⇒ 「我造成的断口」与「原来就有的问题」在指纹上完全不可分。 */
import fs from 'node:fs';
import { diagnose, fingerprintOf } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const k = d => `${d.code}|${d.subject.handle}`;
const d0 = diagnose(OBS, null, null, null, 'RuRu----', buildHandles(OBS, null), {});
const base = new Set(d0.map(k));
const fp0 = fingerprintOf(d0);
const belts = OBS.entities.filter(e => e.type === "belt");
let zero = 0;
const hist = {};
for (const b of belts) {
  const obs2 = { ...OBS, entities: OBS.entities.filter(e => e.uid !== b.uid) };
  const d = diagnose(obs2, null, null, null, 'RuRu----', buildHandles(obs2, null), {});
  const shown = new Set(d.map(k));
  const added = [...shown].filter(x => !base.has(x)).length;
  hist[added] = (hist[added] || 0) + 1;
  if (added === 0) zero++;
}
console.log(`删掉 ${belts.length} 条带子（逐条）：`);
console.log(`  新指纹键数分布: ${JSON.stringify(hist)}`);
console.log(`  ★ 0 条新键（破坏在指纹上完全隐形）: ${zero} (${(100 * zero / belts.length).toFixed(1)}%)`);
