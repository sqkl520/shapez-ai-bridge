/**
 * Q1 的实测：把「部分执行」的成功子集送进 verifyRound，
 * 看 L1/L2/L3/V-obs-flow 能不能看见「有 3 个调用被跳过了」。
 *
 * 用的是真实样本（147 条里「部分执行且含目标动作」那一桶）。
 * 离线 L3/L4 不可信（FakeGame 不重建 paths、不推进生产），这是 offline_boundary 明写的边界；
 * 所以我们只问一件事：**applied 子集自己是绿的吗**。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding, checkSlots, checkFlow } from '../../src/agent/verify_runtime.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
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

let examined = 0, l1green = 0, l2green = 0, l2skip = 0, flowsEmpty = 0;
const examples = [];
for (const calls of rows) {
  const per = calls.map(c => { const fn = F[String(c.macro || '')];
    if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  examined++;
  const plan = { placements: tp.placements, removes: tp.removes, flows: tp.flows };
  const l1 = checkLanding(plan, OBS);
  if (l1.ok) l1green++;
  const l2 = checkSlots(plan, OBS, null, {});
  if (l2.ok) l2green++;
  if (l2.skipped) l2skip++;
  if (!tp.flows.length) flowsEmpty++;
  if (examples.length < 5 && l1.ok && l2.ok && tp.flows.length) {
    examples.push({ macros: okList.map(c => c.macro), n: calls.length, ops: tp.ops.length, flows: tp.flows.length });
  }
}
console.log('部分执行样本（applied 子集可翻译成 op）:', examined);
console.log('  L1 绿（applied 子集真的落地了）:', l1green, `(${(100 * l1green / examined).toFixed(0)}%)`);
console.log('  L2 绿:', l2green, `  其中 skipped（纯带子计划）:`, l2skip);
console.log('  flows 为空（会被 FLOW_UNVERIFIED 判红）:', flowsEmpty);
console.log('\nL1 绿 ∧ L2 绿 ∧ 有 flows 的例子（这些只需要 L4 的 goalDelta>0 就能 achieved）:');
for (const e of examples) console.log('  calls', e.n, '→ applied', e.macros.join('+'), 'ops', e.ops, 'flows', e.flows);
