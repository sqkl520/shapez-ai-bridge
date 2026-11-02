/**
 * Q4：失败到底发生在哪一层？
 *   · 宏层（buildTxPlan ③ 的 MACRO_REFUSED）——「跳过失败的调用」能救
 *   · planToTxOps 层（R5/R6/R7/R13）——「跳过」救不了，它拒的是**整份 op 集合**
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const cnt = { macroFail: 0, planReject: 0, ok: 0 };
const rules = {};
const all = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`; if (seen.has(k)) continue; seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    let calls = p.calls;
    try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) { cnt.planReject++; rules['resolveRefs'] = (rules['resolveRefs']||0)+1; continue; } if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
    all.push(calls);
  }
}
for (const calls of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  if (per.some(r => !r || r.ok !== true)) { cnt.macroFail++; continue; }
  const ex = calls.map((c, i) => ({ macro: c.macro, args: c.args, result: per[i] }));
  const tp = planToTxOps(ex, { obs: OBS, items: null });
  if (!tp || tp.ok !== true) {
    cnt.planReject++; const r = (tp && tp.error && tp.error.rule) || '?'; rules[r] = (rules[r] || 0) + 1;
  } else cnt.ok++;
}
console.log('样本', all.length);
console.log('  宏层失败（跳过能救）:', cnt.macroFail, `(${(100*cnt.macroFail/all.length).toFixed(1)}%)`);
console.log('  planToTxOps 层拒绝（跳过救不了）:', cnt.planReject, `(${(100*cnt.planReject/all.length).toFixed(1)}%)`, JSON.stringify(rules));
console.log('  全绿（现状就成功）:', cnt.ok, `(${(100*cnt.ok/all.length).toFixed(1)}%)`);
