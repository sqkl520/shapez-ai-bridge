/* 诊断窗口挤出：部分执行造成的断口把「原来就有的问题」挤出 prompt 的 8 条窗口。 */
import fs from 'node:fs';
import { diagnose } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const k = d => `${d.code}|${d.subject.handle}`;
const d0 = diagnose(OBS, null, null, null, 'RuRu----', buildHandles(OBS, null), {});
const base = new Set(d0.map(k));
console.log('基线', d0.length, '条:', [...base].join(', '));
const belts = OBS.entities.filter(e => e.type === "belt");
for (const n of [4, 8, 12, 20]) {
  const drop = new Set(belts.slice(0, n).map(b => b.uid));
  const obs2 = { ...OBS, entities: OBS.entities.filter(e => !drop.has(e.uid)) };
  const d = diagnose(obs2, null, null, null, 'RuRu----', buildHandles(obs2, null), {});
  const shown = d.map(k);
  const evicted = [...base].filter(x => !shown.includes(x));
  const created = shown.filter(x => !base.has(x));
  console.log(`删 ${String(n).padStart(2)} 条: 显示 ${d.length} 条 | 新造出 ${created.length} 条 | **原有被挤出 ${evicted.length} 条** ${evicted.length ? "[" + evicted.join(", ") + "]" : ""}`);
}
