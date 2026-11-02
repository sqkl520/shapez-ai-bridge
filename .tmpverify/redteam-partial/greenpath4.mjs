/**
 * Q1 的最终复算（修正两处夹具错：① 机器 code 用模板 code；② 每个实体都带 rotation_variant，
 * 因为真 obs 里连 trash 都带 rotation_variant=0，见 L4-obs.json 的 uid=10037）。
 * 问题：**部分执行之后，applied 子集自己是不是绿的？**
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding, checkSlots } from '../../src/agent/verify_runtime.mjs';
import { obsReach } from '../../src/agent/loop/verify.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

function fakeApply(entities, ops, placements) {
  const removed = new Set(); const added = [];
  for (const op of ops) {
    if (op.op === "delete") { removed.add(op.uid); continue; }
    const pl = placements.find(p => p.x === op.x && p.y === op.y) || {};
    const rv = op.rotationVariant !== undefined ? op.rotationVariant : (typeof pl.rv === "number" ? pl.rv : 0);
    added.push({
      uid: 900000 + added.length, type: op.building, x: op.x, y: op.y, r: op.r || 0,
      variant: op.variant || "default", rotation_variant: rv,
      code: op.rotationVariant !== undefined ? 1 + op.rotationVariant : (typeof pl.code === "number" ? pl.code : null),
    });
  }
  return [...entities.filter(e => !removed.has(e.uid)), ...added];
}

const all = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`; if (seen.has(k)) continue; seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    let calls = p.calls;
    try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) continue; if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
    all.push({ key: `${f || 'v1'}:${x.arm}#${x.rep}`, calls });
  }
}

let examined = 0, l1ok = 0, l2ok = 0, vok = 0, full = 0;
const winners = [];
for (const { key, calls } of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null;
    try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  examined++;
  const after = { ...OBS, entities: fakeApply(OBS.entities, tp.ops, tp.placements) };
  const l1 = checkLanding({ placements: tp.placements, removes: tp.removes }, after);
  const l2 = checkSlots({ placements: tp.placements, removes: tp.removes }, after, null, {});
  if (l1.ok) l1ok++; if (l2.ok) l2ok++;
  let okf = true, n = 0;
  for (const fl of tp.flows) {
    if (typeof fl.from !== "number" || typeof fl.to !== "number") continue;
    n++;
    const r = obsReach(fl.from, after);
    if (r.missing || !r.seen.has(fl.to)) { okf = false; break; }
  }
  const vpass = n > 0 && okf;
  if (vpass) vok++;
  if (l1.ok && l2.ok && vpass) { full++; winners.push(`${key}  applied=${okList.map(c => c.macro).join('+')}  (calls=${calls.length})`); }
}
console.log('部分执行样本:', examined);
console.log('  L1 绿:', l1ok, `(${(100 * l1ok / examined).toFixed(0)}%)`);
console.log('  L2 绿:', l2ok, `(${(100 * l2ok / examined).toFixed(0)}%)`);
console.log('  V-obs-flow 绿:', vok, `(${(100 * vok / examined).toFixed(0)}%)`);
console.log(`\n★ L1 ∧ L2 ∧ V-obs-flow 全绿: ${full}/${examined} (${(100 * full / examined).toFixed(0)}%)`);
for (const w of winners.slice(0, 15)) console.log('   · ' + w);
