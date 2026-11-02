/**
 * Q1 的实测（修正版）：apply 之后再查 L1/L2，并算 V-obs-flow（不依赖 debug_items 的连通性）。
 *
 * 目的：部分执行之后，**applied 子集自己**是不是绿的？
 * 若是，那么「被跳过的 3 个调用」就不会出现在任何 check 里 —— 只剩 planToTxOps 的 partial 标记
 * 能阻止 achieved。这正是我要攻击的那条单点依赖。
 *
 * 诚实边界（offline_boundary.mjs 明写）：FakeGame 不重建 paths、不推进生产，
 * 所以 L3 的 checkFlow 与 L4 在这里不可信。本脚本因此用 obsReach（verify.mjs 自己的
 * V-obs-flow 实现，纯 obs 运算）代替 L3 —— 它是 live 下同样会跑的一条真判据。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding, checkSlots } from '../../src/agent/verify_runtime.mjs';
import { obsReach, strictVerdict } from '../../src/agent/loop/verify.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

function applyOps(entities, ops) {
  const removed = new Set();
  const added = [];
  for (const op of ops) {
    if (op.op === "delete") removed.add(op.uid);
    else if (op.op === "place") {
      added.push({
        uid: 900000 + added.length, type: op.building, x: op.x, y: op.y,
        r: op.r || 0, variant: op.variant || "default",
        ...(op.rotationVariant !== undefined
          ? { rotation_variant: op.rotationVariant, code: 1 + op.rotationVariant } : {}),
      });
    }
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
    rows.push(calls);
  }
}

let examined = 0;
let l1ok = 0, l2ok = 0, obsFlowOk = 0, flowsEmpty = 0;
const stack = [];    // 「L1/L2/V-obs-flow 全绿」的样本
for (const calls of rows) {
  const per = calls.map(c => {
    const fn = F[String(c.macro || '')];
    if (!fn) return null;
    try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; }
  });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;     // 只要「部分执行」的样本
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  examined++;

  const after = { ...OBS, entities: applyOps(OBS.entities, tp.ops) };
  const plan = { placements: tp.placements, removes: tp.removes, flows: tp.flows };
  const l1 = checkLanding(plan, after);
  const l2 = checkSlots(plan, after, null, {});
  if (l1.ok) l1ok++;
  if (l2.ok) l2ok++;
  if (!tp.flows.length) flowsEmpty++;

  /* V-obs-flow：verifyRound 里那条「不依赖 paths」的连通判据（verify.mjs:542-553） */
  let vok = true;
  let resolved = 0;
  for (const fl of tp.flows) {
    const from = typeof fl.from === "number" ? fl.from : null;
    const to = typeof fl.to === "number" ? fl.to : null;
    if (from === null || to === null) continue;         // token 端点：uidMap 才有；离线没有
    resolved++;
    const r = obsReach(from, after);
    if (r.missing || !r.seen.has(to)) { vok = false; break; }
  }
  const vpass = resolved > 0 && vok;
  if (vpass) obsFlowOk++;
  if (l1.ok && l2.ok && vpass) stack.push({ macros: okList.map(c => c.macro), n: calls.length, ops: tp.ops.length, flows: resolved });
}

console.log('部分执行样本（成功子集可翻译）:', examined);
console.log('  L1 绿（after 世界里子集真的落地）:', l1ok, `(${(100 * l1ok / examined).toFixed(0)}%)`);
console.log('  L2 绿:', l2ok, `(${(100 * l2ok / examined).toFixed(0)}%)`);
console.log('  V-obs-flow 绿（纯 obs 连通性）:', obsFlowOk, `(${(100 * obsFlowOk / examined).toFixed(0)}%)`);
console.log('  flows 为空:', flowsEmpty);
console.log('\n★ L1 ∧ L2 ∧ V-obs-flow 全绿的部分执行样本:', stack.length, `(${(100 * stack.length / examined).toFixed(0)}%)`);
console.log('   这些样本在 live 下只差 L4（goalDelta>0）就能 achieved ——');
console.log('   而 goalDelta 测的是「hub 交付有没有涨」，与「计划是否完整」**无关**。');
for (const s of stack.slice(0, 10)) console.log(`   · calls ${s.n} → applied ${s.macros.join('+')}  ops ${s.ops}  flows ${s.flows}`);
