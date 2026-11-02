/**
 * 红队 Q2 的实测：部分执行留下「半成品」后，下一轮还能不能把它修回来。
 *
 * 攻击形态：一轮里 `trash_unused` 成功（79% 成功率，是模型最常成功的宏），
 * 它把一条死端带子的出口永久占住。之后想「接上这段」的 connect 还能不能做？
 * 这决定了部分执行是「推进」还是「把待修的东西封死」。
 */
import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

/* 1) 找一条「出口为空」的带子（DEAD_END 的候选） */
const dead = structuralDiagnoses(OBS, null, 'RuRu----', handles, {}).filter(d => d.code === "DEAD_END");
console.log('DEAD_END 诊断条数:', dead.length);
const pick = dead[0];
const uid = pick && pick.evidence.uids[0];
const belt = OBS.entities.find(e => e.uid === uid);
console.log('选中的死端带子:', JSON.stringify({ uid: belt && belt.uid, x: belt && belt.x, y: belt && belt.y, type: belt && belt.type }));

/* 2) trash_unused 在这条带子上成不成功 */
const tr = trashUnused({ outlet: { uid } }, { entities: OBS.entities });
console.log('\ntrash_unused:', tr.ok ? `ok  落在 ${JSON.stringify(tr.trashCell)}` : `失败 ${tr.error && tr.error.code}`);

if (!tr.ok) process.exit(0);
const trashCell = tr.trashCell;

/* 3) 世界被改成「带子 + 垃圾桶」，然后看 diagnose 与 connect */
const OBS2 = JSON.parse(JSON.stringify(OBS));
OBS2.entities.push({ uid: 99999, type: "trash", x: trashCell[0], y: trashCell[1], r: 0, variant: "default" });
const h2 = buildHandles(OBS2, null);
const after = structuralDiagnoses(OBS2, null, 'RuRu----', h2, {});
console.log('trash 落盘后 DEAD_END 条数:', after.filter(d => d.code === "DEAD_END").length,
    '→ 那条诊断', after.some(d => d.code === "DEAD_END" && d.evidence.uids.includes(uid)) ? '仍在' : '消失了');
console.log('诊断码变化:', JSON.stringify(after.map(d => d.code)));

/* 4) 现在还想「从这条带子接出去」—— 还能吗？ */
const same = OBS2.entities.find(e => e.uid === uid);
const hub = OBS2.entities.find(e => e.type === "hub");
const hb = buildHandles(OBS2, null).byHandle.get("H1");
const hubUid = hub && hub.uid;
/* 句柄在 OBS2 上可能变了；直接用 uid 走宏（宏只认 uid） */
const c1 = connect({ from: { uid }, to: { uid: hubUid } }, { entities: OBS2.entities });
console.log('\n想把它接进 hub:', c1.ok ? "ok" : `失败 ${c1.error && c1.error.code}: ${c1.error && c1.error.message}`);
console.log('  hint:', c1.error && c1.error.hint);

/* 5) 能不能接进另一条带子（extend/connect 到某个已有的空入口） */
const anyBeltDownstream = OBS2.entities.filter(e => e.type === "belt" && e.uid !== uid)[0];
if (anyBeltDownstream) {
  const c2 = connect({ from: { uid }, to: { uid: anyBeltDownstream.uid } }, { entities: OBS2.entities });
  console.log('想把它接进另一条带子:', c2.ok ? "ok" : `失败 ${c2.error && c2.error.code}`);
}

/* 6) trash_unused 自己还能不能「反悔」—— 有没有宏能把 trash 删掉 */
