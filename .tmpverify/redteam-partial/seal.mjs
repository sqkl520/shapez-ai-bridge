/**
 * Q2 的杀手序列：**执行的那一半，封死了没执行的那一半。**
 *
 * 判据：同一轮里
 *   · 有至少一条 connect 失败（connect 的 from 是某条带子 X）
 *   · 有至少一条 trash_unused **成功**，落点正好是 X 的出口格
 * ⇒ 部分执行把世界改成了「X 的出口被垃圾桶永久占住」。
 *   垃圾桶在现有 6 个宏里**删不掉**（已实测：remove_run/replace_run 都判 not_a_run），
 *   所以那条 connect 从此**永远不可能成功**，而它的 DEAD_END 诊断也消失了。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { beltExit, DIRV } from '../../src/ai/belt-rules.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const byUid = new Map(OBS.entities.map(e => [e.uid, e]));

const exitCellOf = (e) => {
  const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
  const d = beltExit(rv, e.r || 0);
  return [e.x + DIRV[d][0], e.y + DIRV[d][1]];
};

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

let hits = 0;
const cases = [];
for (const { key, calls } of rows) {
  const per = calls.map(c => {
    const fn = F[String(c.macro || '')];
    if (!fn) return null;
    try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; }
  });
  const okTrash = [];
  const failConnect = [];
  calls.forEach((c, i) => {
    if (!per[i]) return;
    if (c.macro === "trash_unused" && per[i].ok === true && Array.isArray(per[i].trashCell)) okTrash.push(per[i].trashCell);
    if (c.macro === "connect" && per[i].ok !== true && c.args && c.args.from && typeof c.args.from.uid === "number") failConnect.push(c.args.from.uid);
    if (c.macro === "replace_run" && per[i].ok !== true && c.args && c.args.region) { /* region 里可能含这条带子 */ }
  });
  const sealed = [];
  for (const uid of failConnect) {
    const e = byUid.get(uid);
    if (!e || (e.type !== "belt" && e.type !== "underground_belt")) continue;
    const exit = exitCellOf(e);
    if (okTrash.some(t => t[0] === exit[0] && t[1] === exit[1])) sealed.push({ uid, exit });
  }
  if (sealed.length) { hits++; cases.push({ key, n: calls.length, sealed, okTrash }); }
}

console.log('总样本:', rows.length);
console.log('★ 「执行的那一半封死了没执行的那一半」的样本:', hits, `(${(100 * hits / rows.length).toFixed(1)}%)`);
for (const c of cases.slice(0, 15)) {
  console.log(`  ${c.key}  calls=${c.n}  被封死的 from 带子: ${c.sealed.map(s => `uid=${s.uid}@exit[${s.exit}]`).join(", ")}`);
}
