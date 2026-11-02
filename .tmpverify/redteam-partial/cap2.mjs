/* 诊断上限会不会把「部分执行自己造成的断口」压出窗口（PER_CODE 3 / TOTAL 8） */
import fs from 'node:fs';
import { diagnose } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const k = (d) => `${d.code}|${d.subject.handle}`;
const base = new Set(diagnose(OBS, null, null, null, 'RuRu----', buildHandles(OBS, null), {}).map(k));
const belts = OBS.entities.filter(e => e.type === "belt");
for (const n of [1, 3, 6, 10, 20]) {
  const drop = new Set(belts.slice(0, n).map(b => b.uid));
  const obs2 = { ...OBS, entities: OBS.entities.filter(e => !drop.has(e.uid)) };
  const d = diagnose(obs2, null, null, null, 'RuRu----', buildHandles(obs2, null), {});
  const shown = new Set(d.map(k));
  const created = [...shown].filter(x => !base.has(x));
  const supp = d[0].evidence.suppressed_total || 0;
  const per = d.map(x => x.evidence.suppressed || 0).reduce((a, b) => a + b, 0);
  console.log(`删 ${n} 条带子: diagnose 显示 ${d.length} 条, 其中新问题 ${created.length} 条, ` +
    `被 per-code 压掉 ${per}, 被总量压掉 ${supp}`);
}
