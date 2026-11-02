/**
 * 设计第 3 步（`partial:true ⇒ av.ok === false`）在 loop 里的**实际后果**：
 *   loop.mjs:2054 `if (!av.ok) { ... code = TX_ROLLED_BACK ... continue; }`
 * ⇒ 已落盘的 op 被当成「回滚了」，模型收到 TX_ROLLED_BACK，
 *   下一轮它会**重发同一批调用** —— 而那些调用现在打在已经落盘的世界上。
 * 本节量化：重发会失败多少。
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
function fakeApply(entities, ops, placements) {
  const removed = new Set(); const added = [];
  for (const op of ops) {
    if (op.op === "delete") { removed.add(op.uid); continue; }
    const pl = placements.find(p => p.x === op.x && p.y === op.y) || {};
    const rv = op.rotationVariant !== undefined ? op.rotationVariant : 0;
    added.push({ uid: 900000 + added.length, type: op.building, x: op.x, y: op.y, r: op.r || 0,
      variant: op.variant || "default", rotation_variant: rv,
      code: op.rotationVariant !== undefined ? 1 + op.rotationVariant : (pl.code ?? undefined) });
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
    all.push(calls);
  }
}
let n = 0, reEmitAllFail = 0, reEmitSomeFail = 0, reEmitAllOk = 0;
const why = {};
for (const calls of all) {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = []; calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null }); if (!tp || !tp.ok || !tp.ops.length) continue;
  const ents2 = fakeApply(OBS.entities, tp.ops, tp.placements);
  n++;
  /* 重发：同一批已经落盘的调用（模型收到 TX_ROLLED_BACK 后的最自然反应） */
  const again = okList.map(c => { try { return F[c.macro](c.args, { entities: ents2 }); } catch { return null; } });
  const fails = again.filter(r => !r || r.ok !== true);
  for (const r of fails) { const c = (r && r.error && r.error.code) || 'throw'; why[c] = (why[c] || 0) + 1; }
  if (fails.length === again.length) reEmitAllFail++;
  else if (fails.length) reEmitSomeFail++;
  else reEmitAllOk++;
}
console.log('部分执行轮次:', n);
console.log('  重发同一批调用：**全部失败**:', reEmitAllFail, `(${(100*reEmitAllFail/n).toFixed(0)}%)`);
console.log('  部分失败:', reEmitSomeFail, '  全部成功（幂等）:', reEmitAllOk);
console.log('  失败码:', JSON.stringify(why));
