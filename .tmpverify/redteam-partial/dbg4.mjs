import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding } from '../../src/agent/verify_runtime.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
function applyOps(entities, ops, placements) {
  const removed = new Set(); const added = [];
  for (const op of ops) {
    if (op.op === "delete") { removed.add(op.uid); continue; }
    const pl = placements.find(p => p.x === op.x && p.y === op.y);
    added.push({ uid: 900000 + added.length, type: op.building, x: op.x, y: op.y, r: op.r || 0, variant: op.variant || "default",
      ...(op.rotationVariant !== undefined ? { rotation_variant: op.rotationVariant, code: 1 + op.rotationVariant }
        : { code: pl && typeof pl.code === "number" ? pl.code : null }) });
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
    if (!p || !Array.isArray(p.calls)) continue;
    let calls = p.calls;
    try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) continue; if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
    all.push({ key: `${f||'v1'}:${x.arm}#${x.rep}`, calls });
  }
}
let shown = 0;
for (const { key, calls } of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = []; calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null }); if (!tp || !tp.ok || !tp.ops.length) continue;
  const after = { ...OBS, entities: applyOps(OBS.entities, tp.ops, tp.placements) };
  const l1 = checkLanding({ placements: tp.placements, removes: tp.removes }, after);
  if (!l1.ok && shown < 4) {
    shown++;
    console.log(key, 'applied:', okList.map(c => c.macro).join('+'));
    console.log('  reason:', l1.reason);
    console.log('  wrong_rot:', JSON.stringify(l1.evidence.wrong_rot.slice(0,2)));
    console.log('  wrong_code:', JSON.stringify(l1.evidence.wrong_code.slice(0,2)));
    console.log('  missing:', JSON.stringify(l1.evidence.missing.slice(0,2)));
    const bad = (l1.evidence.wrong_rot[0]||l1.evidence.wrong_code[0]||{});
    if (bad.cell) console.log('  世界那格原样:', JSON.stringify(OBS.entities.find(e=>e.x===bad.cell[0]&&e.y===bad.cell[1])));
  }
}
