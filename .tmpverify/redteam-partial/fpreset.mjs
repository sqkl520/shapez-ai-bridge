/**
 * 红队 Q3 的实测：一条 trash_unused 落盘（部分执行里成功率 79% 的那个宏）
 * 会不会让世界诊断指纹变掉 ⇒ countFingerprint 的计数归零 ⇒ 免掉 mustChange。
 */
import fs from 'node:fs';
import { diagnose, fingerprintOf, actionSetHash } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const hand = buildHandles(OBS, null);
const d0 = structuralDiagnoses(OBS, null, 'RuRu----', hand, {});
console.log('原始诊断:', JSON.stringify(d0.map(x => [x.code, x.subject.handle])));

const tr = trashUnused({ outlet: { uid: d0[0].evidence.uids[0] } }, { entities: OBS.entities });
console.log('trash_unused:', tr.ok, tr.ok ? JSON.stringify(tr.trashCell) : tr.error && tr.error.code);

const OBS2 = JSON.parse(JSON.stringify(OBS));
OBS2.entities.push({ uid: 99999, type: "trash", x: tr.trashCell[0], y: tr.trashCell[1], r: 0, variant: "default" });
const d1 = structuralDiagnoses(OBS2, null, 'RuRu----', buildHandles(OBS2, null), {});
console.log('落盘后诊断:', JSON.stringify(d1.map(x => [x.code, x.subject.handle])));

/* 用 diagnose 的正式口径（含 report 层为 null、recipe 为 null）算指纹 */
const f0 = fingerprintOf(diagnose(OBS, null, null, null, 'RuRu----', hand, {}));
const f1 = fingerprintOf(diagnose(OBS2, null, null, null, 'RuRu----', buildHandles(OBS2, null), {}));
console.log('\n世界诊断指纹 before:', f0);
console.log('世界诊断指纹 after :', f1);
console.log('指纹是否变了:', f0 !== f1);
const act = actionSetHash(['connect', 'connect', 'trash_unused', 'trash_unused']);
console.log('计数键 before:', (f0 + '#' + act).slice(0, 40));
console.log('计数键 after :', (f1 + '#' + act).slice(0, 40));
console.log('⇒ 同一套动作、只因为一条 trash 落盘，计数键就不同 ⇒ count 从 0 重新开始');

/* 对照：如果不落盘（同一份 obs），计数键当然一样 */
const f0b = fingerprintOf(diagnose(OBS, null, null, null, 'RuRu----', hand, {}));
console.log('\n对照（世界不变）:', f0 === f0b);
