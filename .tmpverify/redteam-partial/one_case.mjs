/**
 * Q1 的具体失败序列（逐字段打印，供报告引用）。
 * 挑选条件：部分执行样本中，applied 子集 L1/L2/V-obs-flow 全绿，且换掉了目标相关的宏。
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
import { diagnose, fingerprintOf } from '../../src/agent/loop.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
function fakeApply(entities, ops, placements) {
  const removed = new Set(); const added = [];
  for (const op of ops) {
    if (op.op === "delete") { removed.add(op.uid); continue; }
    const pl = placements.find(p => p.x === op.x && p.y === op.y) || {};
    const rv = op.rotationVariant !== undefined ? op.rotationVariant : (typeof pl.rv === "number" ? pl.rv : 0);
    added.push({ uid: 900000 + added.length, type: op.building, x: op.x, y: op.y, r: op.r || 0,
      variant: op.variant || "default", rotation_variant: rv,
      code: op.rotationVariant !== undefined ? 1 + op.rotationVariant : (typeof pl.code === "number" ? pl.code : undefined) });
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
    all.push({ key: `${f || 'v1'}:${x.arm}#${x.rep}`, say: String(p.say||'').slice(0,240), calls });
  }
}
const deadBefore = structuralDiagnoses(OBS, null, 'RuRu----', handles, {}).filter(d => d.code === "DEAD_END");
const fp0 = fingerprintOf(diagnose(OBS, null, null, null, 'RuRu----', handles, {}));
let printed = 0;
for (const { key, say, calls } of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = []; const failList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] });
    else failList.push({ macro: c.macro, code: (per[i] && per[i].error && per[i].error.code) || '?' }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null }); if (!tp || !tp.ok || !tp.ops.length) continue;
  const after = { ...OBS, entities: fakeApply(OBS.entities, tp.ops, tp.placements) };
  const l1 = checkLanding({ placements: tp.placements, removes: tp.removes }, after);
  const l2 = checkSlots({ placements: tp.placements, removes: tp.removes }, after, null, {});
  let okf = true, n = 0;
  for (const fl of tp.flows) { if (typeof fl.from !== "number" || typeof fl.to !== "number") continue; n++; const r = obsReach(fl.from, after); if (r.missing || !r.seen.has(fl.to)) { okf = false; break; } }
  const vpass = n > 0 && okf;
  if (!(l1.ok && l2.ok && vpass)) continue;
  /* 必须有 goal 相关的宏被跳过 */
  if (!failList.some(f => f.macro === 'connect' || f.macro === 'replace_run')) continue;
  printed++;
  if (printed > 2) break;
  console.log(`\n════════ ${key} ════════`);
  console.log('模型原文:', say);
  console.log('calls:');
  calls.forEach((c, i) => console.log(`  #${i + 1} ${c.macro}  ${JSON.stringify(c.args)}  → ${per[i] && per[i].ok ? 'OK' : '失败 ' + ((per[i] && per[i].error || {}).code)}`));
  console.log('部分执行提交的 op:', JSON.stringify(tp.ops));
  console.log('L1:', l1.ok, ' L2:', l2.ok, ' V-obs-flow:', vpass, `(${n} 条 flow)`);
  const deadAfter = structuralDiagnoses(after, null, 'RuRu----', buildHandles(after, null), {}).filter(d => d.code === "DEAD_END");
  console.log('DEAD_END:', deadBefore.map(d => d.subject.handle), '→', deadAfter.map(d => d.subject.handle));
  const fp1 = fingerprintOf(diagnose(after, null, null, null, 'RuRu----', buildHandles(after, null), {}));
  console.log('世界诊断指纹变了:', fp0 !== fp1);
  const hub = after.entities.find(e => e.type === 'hub');
  console.log('⇒ 若 L4 在 live 下读到 goal_delivered_delta>0（例如旧产线本来就在出货），');
  console.log('  strict 全绿 + goalDelta>0 ⇒ achieved=true，而 #' +
    calls.map((c,i)=>per[i]&&per[i].ok?null:i+1).filter(Boolean).join(',#') + ' 从未执行。');
}
