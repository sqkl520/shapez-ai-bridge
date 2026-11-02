/**
 * Q2/Q4 的核心量化：**部分执行之后，被跳过的那几条还做得成吗？**
 *
 * 对每一轮真实样本：
 *   ① 取成功的子集，apply 到假世界（只改实体表，够用）；
 *   ② 把**失败的调用**原样重放到新世界上，看结果：
 *        farther = 仍然失败（但错误码可能变了）
 *        now    = 现在能成功（说明这半成品其实把路铺好了 ⇒ 部分执行有价值）
 *   ③ 区分「仍然失败但错误码变成了 occupied」—— 那是**新加的障碍**（不可逆建筑占位）。
 *
 * 这一步是判断「部分执行是推进还是封路」的唯一直接证据。
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
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

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
    rows.push(calls);
  }
}

let cases = 0;
let allUnblocked = 0;          // 所有被跳过的现在都能做成
let someUnblocked = 0;         // 至少一条被跳过的现在能做成
let noneUnblocked = 0;         // 一条都做不成
let newlyOccupied = 0;         // 有调用从别的错误码变成了 occupied（我占了它的路）
const samples = [];
for (const calls of rows) {
  const per = calls.map(c => {
    const fn = F[String(c.macro || '')];
    if (!fn) return null;
    try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; }
  });
  const okList = []; const failList = [];
  calls.forEach((c, i) => {
    if (!per[i]) return;
    if (per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] });
    else failList.push({ macro: c.macro, args: c.args, oldCode: (per[i].error && per[i].error.code) || "?" });
  });
  if (!okList.length || !failList.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  const ents = applyOps(OBS.entities, tp.ops);
  cases++;
  let unblocked = 0, occ = false;
  const detail = [];
  for (const fl of failList) {
    const fn = F[fl.macro];
    let r = null;
    try { r = fn(fl.args, { entities: ents }); } catch { r = null; }
    const nowOk = !!(r && r.ok === true);
    const newCode = r && r.ok !== true ? ((r.error && r.error.code) || "?") : "OK";
    if (nowOk) unblocked++;
    if (newCode === "occupied" && fl.oldCode !== "occupied") occ = true;
    detail.push(`${fl.macro}:${fl.oldCode}→${newCode}`);
  }
  if (unblocked === failList.length) allUnblocked++;
  else if (unblocked > 0) someUnblocked++;
  else noneUnblocked++;
  if (occ) newlyOccupied++;
  if (samples.length < 12) samples.push({ detail, applied: okList.map(c => c.macro) });
}

console.log('可测的部分执行轮次:', cases);
console.log(`  ★ 被跳过的**全部**现在能做成: ${allUnblocked} (${(100*allUnblocked/cases).toFixed(1)}%)  ← 部分执行有价值`);
console.log(`  部分能做成: ${someUnblocked} (${(100*someUnblocked/cases).toFixed(1)}%)`);
console.log(`  ★ 一条都做不成（那半边白跳）: ${noneUnblocked} (${(100*noneUnblocked/cases).toFixed(1)}%)`);
console.log(`  ★ 有新障碍被这次部分执行造出来（错误码→occupied）: ${newlyOccupied} (${(100*newlyOccupied/cases).toFixed(1)}%)`);
console.log('\n样例（失败调用在新世界上的重放结果）:');
for (const s of samples) console.log(`  applied[${s.applied.join(",")}]   ${s.detail.join("  ")}`);
