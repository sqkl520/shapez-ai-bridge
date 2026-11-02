/**
 * 句柄重编号污染指纹：handles 按 (y,x) 排序编号，任何增删都可能让**同一条诊断**换 handle。
 * fingerprintOf 读 subject.handle ⇒ 指纹变了，但语义没变。
 * 这会同时污染 Q2（「新问题」有多少是真的新）和 Q3（计数重置有多廉价）。
 */
import fs from 'node:fs';
import { diagnose, fingerprintOf } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const d0 = diagnose(OBS, null, null, null, 'RuRu----', buildHandles(OBS, null), {});
const uidToHandle = (o) => { const h = buildHandles(o, null); return new Map([...h.byUid.entries()]); };
const m0 = uidToHandle(OBS);

/* 在世界上放一个与任何诊断无关的 trash，看有多少诊断的 handle 变了 */
const tr = trashUnused({ outlet: { uid: 10008 } }, { entities: OBS.entities });
const OBS2 = JSON.parse(JSON.stringify(OBS));
OBS2.entities.push({ uid: 99999, type: "trash", x: tr.trashCell[0], y: tr.trashCell[1], r: 0, variant: "default", rotation_variant: 0, code: 20 });
const m1 = uidToHandle(OBS2);
let renum = 0;
for (const d of d0) {
  const uid = d.subject.uid;
  if (!Number.isInteger(uid)) continue;
  const a = m0.get(uid), b = m1.get(uid);
  if (a !== b) { renum++; console.log(`  uid=${uid}: ${a} → ${b}（同一个实体，句柄变了）`); }
}
console.log(`\n放 1 个 trash：${renum}/${d0.filter(d=>Number.isInteger(d.subject.uid)).length} 条诊断的句柄被重编号`);
console.log('指纹 before:', fingerprintOf(d0));
console.log('指纹 after :', fingerprintOf(diagnose(OBS2, null, null, null, 'RuRu----', buildHandles(OBS2, null), {})));
