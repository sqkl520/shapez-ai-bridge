/**
 * Q2 的杀手序列（修正口径）：**成功的 trash_unused 把一条 DEAD_END 带子的出口永久封死。**
 *
 * 判据（对每一轮真实样本）：
 *   · 存在成功的 trash_unused，落点 == 某条 DEAD_END 带子 X 的出口格；
 *   · 同轮存在失败的 connect（模型想接出去的那一半没做成）；
 * ⇒ 这一轮若部分执行：X 从「可修的死端」变成「垃圾桶占着出口的死端」。
 *   垃圾桶删不掉（remove_run / replace_run 都判 not_a_run，已实测），
 *   而 DEAD_END 诊断随之消失 ⇒ 下一轮模型连「这里有问题」都看不到。
 *
 * 另外实测：这一轮之后，从 X 出发的 connect 是否真的做不成了（拿 connect 再跑一次）。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const deadUids = new Set(structuralDiagnoses(OBS, null, 'RuRu----', handles, {})
  .filter(d => d.code === "DEAD_END").map(d => d.evidence.uids[0]));

const rows = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`; if (seen.has(k)) continue; seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    let calls = p.calls;
    try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) continue; if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
    rows.push({ key: `${f || 'v1'}:${x.arm}#${x.rep}`, calls });
  }
}

const DEC = (c) => OBS.entities.some(e => deadUids.has(e.uid) && e.type === "belt"
  && Math.abs(e.x - c[0]) + Math.abs(e.y - c[1]) === 1);

let n = 0;                         // 「有成功 trash 且封住 DEAD_END」
let withFailedConnect = 0;         // 其中同轮还有失败的 connect
const sealedBelts = new Map();
for (const { key, calls } of rows) {
  const per = calls.map(c => { const fn = F[String(c.macro || '')];
    if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okTrash = [];
  let failedConnect = 0;
  calls.forEach((c, i) => {
    if (!per[i]) return;
    if (c.macro === "trash_unused" && per[i].ok === true && Array.isArray(per[i].trashCell)) okTrash.push(per[i].trashCell);
    if ((c.macro === "connect" || c.macro === "replace_run") && per[i].ok !== true) failedConnect++;
  });
  const sealed = okTrash.filter(DEC);
  if (!sealed.length) continue;
  n++;
  if (failedConnect) withFailedConnect++;
  /* 记住被封的是哪条带子 */
  for (const c of sealed) {
    const e = OBS.entities.find(x => deadUids.has(x.uid) && x.type === "belt"
      && Math.abs(x.x - c[0]) + Math.abs(x.y - c[1]) === 1);
    if (e) sealedBelts.set(e.uid, (sealedBelts.get(e.uid) || 0) + 1);
  }
}

console.log('样本总数:', rows.length);
console.log('★ 成功的 trash_unused 封住一条 DEAD_END 带子:', n, `(${(100 * n / rows.length).toFixed(1)}%)`);
console.log('  其中同轮还有失败的 connect/replace_run（即「那一半真的没做成」）:', withFailedConnect, `(${(100 * withFailedConnect / rows.length).toFixed(1)}%)`);
console.log('  被反复封死的带子:', [...sealedBelts.entries()].map(([u, k]) => `uid=${u}×${k}`).join(", "));

/* 再确认一次：封死之后，从那条带子接出去真的做不到了 */
const OBS2 = JSON.parse(JSON.stringify(OBS));
const tr = trashUnused({ outlet: { uid: 10008 } }, { entities: OBS.entities });
OBS2.entities.push({ uid: 99999, type: "trash", x: tr.trashCell[0], y: tr.trashCell[1], r: 0, variant: "default" });
const hubUid = OBS2.entities.find(e => e.type === "hub").uid;
const retry = connect({ from: { uid: 10008 }, to: { uid: hubUid } }, { entities: OBS2.entities });
console.log('\n封死之后重试同一条 connect（B129 → H1）:', retry.ok ? "竟然 ok" : `${retry.error.code}: ${(retry.error.message || "").slice(0, 90)}`);
const diagAfter = structuralDiagnoses(OBS2, null, 'RuRu----', buildHandles(OBS2, null), {});
console.log('DEAD_END 诊断:', diagAfter.filter(d => d.code === "DEAD_END").map(d => d.subject.handle));
