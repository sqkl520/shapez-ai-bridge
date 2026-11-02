/**
 * 系统扫描：删掉每一条带子，看下一轮 diagnose 会不会看到「我造成的断口」。
 * 若某条带子被删后**没有任何新诊断**，那部分执行造成的破坏对下一轮是隐形的。
 */
import fs from 'node:fs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';
import { hubReachable } from '../../src/agent/loop/topology.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const key = (d) => `${d.code}|${d.subject.handle}`;
const before = new Set(structuralDiagnoses(OBS, null, 'RuRu----', buildHandles(OBS, null), {}).map(key));

const belts = OBS.entities.filter(e => e.type === "belt");
let silent = 0, noisy = 0, newCodes = {};
for (const b of belts) {
  const obs2 = { ...OBS, entities: OBS.entities.filter(e => e.uid !== b.uid) };
  const after = structuralDiagnoses(obs2, null, 'RuRu----', buildHandles(obs2, null), {});
  const added = after.filter(d => !before.has(key(d)));
  if (!added.length) { silent++; continue; }
  noisy++;
  for (const d of added) newCodes[d.code] = (newCodes[d.code] || 0) + 1;
}
console.log(`删带子 ${belts.length} 条：`);
console.log(`  下一轮诊断**看不到**任何新问题: ${silent}  (${(100 * silent / belts.length).toFixed(1)}%)  ← 破坏是隐形的`);
console.log(`  能看到新问题: ${noisy}  (${(100 * noisy / belts.length).toFixed(1)}%)`);
console.log(`  新问题的码: ${JSON.stringify(newCodes)}`);
