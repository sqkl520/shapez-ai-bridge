/**
 * 如果「部分执行」只允许提交**可逆**的宏（成功子集里不含非带子 place），
 * 能保住多少推进力、去掉多少伤害？
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const BELT = new Set(["belt", "underground_belt"]);
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
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
    rows.push(calls);
  }
}
let partialAll = 0, partialReversible = 0, sealedAll = 0, sealedRev = 0;
for (const calls of rows) {
  const per = calls.map(c => { const fn = F[String(c.macro || '')];
    if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  partialAll++;
  const irrev = tp.ops.filter(o => o.op === "place" && !BELT.has(o.building));
  const sealed = okList.some(c => c.macro === "trash_unused");
  if (sealed) sealedAll++;
  /* 「只提交可逆的那一半」：去掉 trash_unused / insert_machine，以及任何落在非带子 place 上的宏 */
  const revOk = okList.filter(c => {
    const sub = planToTxOps([c], { obs: OBS, items: null });
    if (!sub || sub.ok !== true) return false;
    return !sub.ops.some(o => o.op === "place" && !BELT.has(o.building));
  });
  if (revOk.length && revOk.length < calls.length) {
    const sub2 = planToTxOps(revOk, { obs: OBS, items: null });
    if (sub2 && sub2.ok === true && sub2.ops.length) partialReversible++;
  }
  if (sealed && revOk.length === 0) sealedRev++;
}
console.log('部分执行轮次（全量）:', partialAll);
console.log('  其中落 trash（封死出口）:', sealedAll, `(${(100*sealedAll/partialAll).toFixed(0)}%)`);
console.log('限制「只提交可逆宏」后仍能部分执行的轮次:', partialReversible, `(${(100*partialReversible/partialAll).toFixed(0)}%)`);
console.log('限制后「只剩封死出口」的轮次:', sealedRev);
