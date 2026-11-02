/**
 * Q2 里问的那个具体例子：`remove_run` 成功、配对的 `replace_run` 失败 ⇒ 世界多一个断口。
 * 下一轮 diagnose 会看到什么？会不会把「我造成的断口」当成「原来就有的问题」？
 *
 * 做法：在 L4 世界里挑一条处于某条 path 中段的带子，删掉它，重跑 diagnose。
 */
import fs from 'node:fs';
import { diagnose } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';
import { removeRun, replaceRun } from '../../src/agent/macros/remove.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h0 = buildHandles(OBS, null);
const before = structuralDiagnoses(OBS, null, 'RuRu----', h0, {});
console.log('删之前:', JSON.stringify(before.map(d => [d.code, d.subject.handle])));

/* 找一条「上游有带子、下游有带子」的中段带子（删了必然造成两个断口） */
const byCell = new Map(OBS.entities.map(e => [`${e.x},${e.y}`, e]));
let mid = null;
for (const e of OBS.entities) {
  if (e.type !== "belt") continue;
  const around = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => byCell.get(`${e.x+dx},${e.y+dy}`)).filter(Boolean);
  if (around.filter(a => a.type === "belt").length >= 2) { mid = e; break; }
}
console.log('选中中段带子:', JSON.stringify({ uid: mid.uid, x: mid.x, y: mid.y, r: mid.r, code: mid.code }));

const r = removeRun({ uids: [mid.uid] }, { entities: OBS.entities });
console.log('remove_run:', r.ok ? "ok" : r.error.code);

const OBS2 = JSON.parse(JSON.stringify(OBS));
OBS2.entities = OBS2.entities.filter(e => e.uid !== mid.uid);
const h1 = buildHandles(OBS2, null);
const after = structuralDiagnoses(OBS2, null, 'RuRu----', h1, {});
console.log('\n删之后:', JSON.stringify(after.map(d => [d.code, d.subject.handle])));
const added = after.filter(a => !before.some(b => b.code === a.code && b.subject.handle === a.subject.handle));
console.log('新出现的诊断:', JSON.stringify(added.map(d => [d.code, d.subject.handle, d.evidence.uids])));
console.log('\n⇒ 「我造成的断口」在下一轮长什么样：与「原来就有的问题」**完全同形**（同一个 code，只换 subject）。');

/* 配对的 replace_run 失败会怎样（模型本来想删完立刻重铺） */
const rp = replaceRun({ region: [mid.x, mid.y, mid.x, mid.y], building: 'belt' }, { entities: OBS.entities });
console.log('\n配对 replace_run 同 region:', rp.ok ? "ok" : `${rp.error.code}: ${(rp.error.message || "").slice(0, 100)}`);
