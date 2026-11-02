/**
 * Q1/Q2 的具体失败序列（实测，不是假想）：
 * 找一条真实样本 —— connect 全红、trash_unused 成功，且那个 trash 正好落在
 * **一条 DEAD_END 带子的出口格**上。然后：
 *   ① 它永久封死这条路（没有任何宏能删 trash）；
 *   ② DEAD_END 诊断消失 ⇒ 下一轮模型看不到「这里还该接出去」；
 *   ③ 世界诊断指纹变了 ⇒ countFingerprint 计数归零；
 *   ④ applied 子集自己 L1/L2/obs-flow 全绿 ⇒ live 下只差 goalDelta>0 就 achieved。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { diagnose, fingerprintOf } from '../../src/agent/loop.mjs';
import { structuralDiagnoses } from '../../src/agent/loop/structural.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding, checkSlots } from '../../src/agent/verify_runtime.mjs';
import { obsReach } from '../../src/agent/loop/verify.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const deadBefore = structuralDiagnoses(OBS, null, 'RuRu----', handles, {}).filter(d => d.code === "DEAD_END");
const deadUids = new Set(deadBefore.map(d => d.evidence.uids[0]));

function applyOps(entities, ops) {
  const removed = new Set(); const added = [];
  for (const op of ops) {
    if (op.op === "delete") removed.add(op.uid);
    else added.push({ uid: 900000 + added.length, type: op.building, x: op.x, y: op.y, r: op.r || 0,
      variant: op.variant || "default",
      ...(op.rotationVariant !== undefined ? { rotation_variant: op.rotationVariant, code: 1 + op.rotationVariant } : {}) });
  }
  return [...entities.filter(e => !removed.has(e.uid)), ...added];
}

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
    rows.push({ key: `${f || "v1"}:${x.arm}#${x.rep}`, calls });
  }
}

let found = 0;
const cases = [];
for (const { key, calls } of rows) {
  const per = calls.map(c => { const fn = F[String(c.macro || '')];
    if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  /* 要求：成功的 trash_unused 落点封住的是一条 DEAD_END 带子 */
  const capDead = okList.filter(c => c.macro === "trash_unused" && c.result && Array.isArray(c.result.trashCell))
    .filter(c => {
      const cell = c.result.trashCell;
      return OBS.entities.some(e => deadUids.has(e.uid) && e.type === "belt"
        && Math.abs(e.x - cell[0]) + Math.abs(e.y - cell[1]) === 1);
    });
  if (!capDead.length) continue;
  found++;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  const after = { ...OBS, entities: applyOps(OBS.entities, tp.ops) };
  const plan = { placements: tp.placements, removes: tp.removes, flows: tp.flows };
  const l1 = checkLanding(plan, after), l2 = checkSlots(plan, after, null, {});
  let vok = true, resolved = 0;
  for (const fl of tp.flows) {
    if (typeof fl.from !== "number" || typeof fl.to !== "number") continue;
    resolved++;
    const r = obsReach(fl.from, after);
    if (r.missing || !r.seen.has(fl.to)) { vok = false; break; }
  }
  const deadAfter = structuralDiagnoses(after, null, 'RuRu----', buildHandles(after, null), {}).filter(d => d.code === "DEAD_END");
  const fpAfter = fingerprintOf(diagnose(after, null, null, null, 'RuRu----', buildHandles(after, null), {}));
  const fpBefore = fingerprintOf(diagnose(OBS, null, null, null, 'RuRu----', handles, {}));
  cases.push({
    key, calls: calls.length, applied: okList.map(c => c.macro),
    capped: capDead.map(c => c.result.trashCell),
    deadBefore: deadBefore.length, deadAfter: deadAfter.length,
    l1: l1.ok, l2: l2.ok, obsFlow: resolved > 0 && vok,
    fpChanged: fpAfter !== fpBefore,
  });
}

console.log('★ 真实样本里「trash_unused 成功并封死一条 DEAD_END 带子」的条数:', found, '/', rows.length);
console.log('');
for (const c of cases) {
  console.log(`${c.key}  calls=${c.calls}  applied=[${c.applied.join(",")}]  trash@${JSON.stringify(c.capped)}`);
  console.log(`   DEAD_END ${c.deadBefore} → ${c.deadAfter}（那条诊断消失了）   L1=${c.l1} L2=${c.l2} obs-flow=${c.obsFlow}  指纹变了=${c.fpChanged}`);
}
