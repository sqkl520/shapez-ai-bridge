/**
 * Q3 的实测：把「部分执行的成功子集」真的 apply 到一块假世界上，
 * 再重跑 diagnose，看世界诊断指纹变了没有。
 * 变了 ⇒ countFingerprint 的计数键就换了一个 ⇒ 那一轮的 stall 计数从 0 开始。
 *
 * 不引 FakeGame（它只改实体表、不改 paths，够用），直接克隆 entities。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { diagnose, fingerprintOf, actionSetHash } from '../../src/agent/loop.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';

const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const f0 = fingerprintOf(diagnose(OBS, null, null, null, 'RuRu----', handles, {}));

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

function applyOps(entities, ops) {
  const out = [];
  const removed = new Set();
  for (const op of ops) {
    if (op.op === "delete") removed.add(op.uid);
    else if (op.op === "place") {
      out.push({ uid: 900000 + out.length, type: op.building, x: op.x, y: op.y, r: op.r || 0,
                 variant: op.variant || "default",
                 ...(op.rotationVariant !== undefined ? { rotation_variant: op.rotationVariant, code: 1 + op.rotationVariant } : {}) });
    }
  }
  return [...entities.filter(e => !removed.has(e.uid)), ...out];
}

let changed = 0, unchanged = 0, noops = 0, planFailed = 0, n = 0;
const actKeyEx = actionSetHash(['connect', 'connect', 'trash_unused', 'trash_unused']);
for (const calls of rows) {
  const results = calls.map(c => {
    const fn = F[String(c.macro || '')];
    if (!fn) return null;
    try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; }
  });
  const okCalls = calls.filter((c, i) => results[i] && results[i].ok === true)
                        .map((c, k) => ({ macro: c.macro, args: c.args, result: results[0] && null }));
  // 重算（上面的 map 顺序已错，干脆重做）
  const okList = [];
  calls.forEach((c, i) => { if (results[i] && results[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: results[i] }); });
  if (!okList.length) continue;
  n++;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) { planFailed++; continue; }
  const ents = applyOps(OBS.entities, tp.ops);
  const obs2 = { ...OBS, entities: ents };
  const f1 = fingerprintOf(diagnose(obs2, null, null, null, 'RuRu----', buildHandles(obs2, null), {}));
  if (f1 === f0) unchanged++; else changed++;
}
console.log('有 ≥1 条成功调用的样本:', n);
console.log('  子集被 planToTxOps 拒（无 op）:', planFailed);
console.log('  apply 后世界诊断指纹 **变了**（计数归零）:', changed, `(${(100 * changed / n).toFixed(1)}%)`);
console.log('  apply 后世界诊断指纹 **没变**（计数累加）:', unchanged, `(${(100 * unchanged / n).toFixed(1)}%)`);
