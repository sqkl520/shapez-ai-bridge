/**
 * Q4：替代方案的量化。四种「提交语义」在同一批 147 条真实样本上的表现。
 *   A 全有或全无（现状）
 *   B 提交全部成功子集（= 设计里的部分执行）
 *   C 只提交 #1（第一条），其余丢弃
 *   D 只提交前缀（#1,#2,… 直到第一条失败）
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const BELT = new Set(["belt", "underground_belt"]);
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
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
    all.push(calls);
  }
}
const N = all.length;
const stat = { A: 0, B: 0, C: 0, D: 0 };
const irrev = { A: 0, B: 0, C: 0, D: 0 };
const goalRelevant = { A: 0, B: 0, C: 0, D: 0 };
for (const calls of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okFlags = per.map(r => !!(r && r.ok === true));
  const commit = {
    A: okFlags.every(Boolean) ? calls.map((c, i) => ({ c, i })) : [],
    B: okFlags.map((o, i) => o ? { c: calls[i], i } : null).filter(Boolean),
    C: okFlags[0] ? [{ c: calls[0], i: 0 }] : [],
    D: (() => { const out = []; for (let i = 0; i < calls.length; i++) { if (!okFlags[i]) break; out.push({ c: calls[i], i }); } return out; })(),
  };
  for (const k of ["A", "B", "C", "D"]) {
    if (!commit[k].length) continue;
    const ex = commit[k].map(x => ({ macro: x.c.macro, args: x.c.args, result: per[x.i] }));
    const tp = planToTxOps(ex, { obs: OBS, items: null });
    if (!tp || tp.ok !== true || !tp.ops.length) continue;
    stat[k]++;
    if (tp.ops.some(o => o.op === "place" && !BELT.has(o.building))) irrev[k]++;
    if (commit[k].some(x => ["connect", "replace_run", "insert_machine", "extend_line"].includes(x.c.macro))) goalRelevant[k]++;
  }
}
console.log('样本', N);
for (const k of ["A", "B", "C", "D"]) {
  const label = { A: "全有或全无(现状)", B: "提交全部成功子集(设计)", C: "只提交 #1", D: "只提交前缀" }[k];
  console.log(`  ${k} ${label.padEnd(22)} 提交 ${String(stat[k]).padStart(3)} (${(100*stat[k]/N).toFixed(1)}%)  ` +
    `含目标动作 ${String(goalRelevant[k]).padStart(3)}  含不可逆 place ${String(irrev[k]).padStart(3)}`);
}
