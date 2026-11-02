/**
 * Q3：「部分执行 + 动作集计数」叠加后，同一份计划能不能一轮一轮地继续成功？
 * 把 147 条样本里成功子集 apply 到假世界上，再用**同一份 calls**重放，
 * 看第 2 轮还能成功几条。若还能成功，就是「无限续命」的实物证据。
 * （真 loop 里 ROUNDS_MAX=3 是硬上限，所以问的是「3 轮里能刷出几次」）
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { diagnose, fingerprintOf } from '../../src/agent/loop.mjs';
import { checkLanding, checkSlots } from '../../src/agent/verify_runtime.mjs';
import { obsReach } from '../../src/agent/loop/verify.mjs';
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
const runOne = (ents, calls) => {
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: ents }); } catch { return null; } });
  const ok = []; calls.forEach((c, i) => { if (per[i] && per[i].ok === true) ok.push({ macro: c.macro, args: c.args, result: per[i] }); });
  return ok;
};

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
    /* 保留 args（重放要用） */
    all.push(calls.map(c => ({ macro: c.macro, args: c.args })));
  }
}

/* 模拟 3 轮：每轮 → 取成功子集 → 提交 → 同一份原计划再来一次 */
let r2progress = 0, r3progress = 0, anyRepeat = 0;
let n = 0;
const fps = [];
for (const calls of all) {
  let ents = OBS.entities;
  let prevFp = fingerprintOf(diagnose({ ...OBS, entities: ents }, null, null, null, 'RuRu----', buildHandles({ ...OBS, entities: ents }, null), {}));
  let progressedRounds = 0;
  for (let round = 1; round <= 3; round++) {
    const ok = runOne(ents, calls);
    if (!ok.length) break;
    const tp = planToTxOps(ok, { obs: { ...OBS, entities: ents }, items: null });
    if (!tp || tp.ok !== true || !tp.ops.length) break;
    ents = fakeApply(ents, tp.ops, tp.placements);
    const fp = fingerprintOf(diagnose({ ...OBS, entities: ents }, null, null, null, 'RuRu----', buildHandles({ ...OBS, entities: ents }, null), {}));
    if (fp !== prevFp) progressedRounds++;
    prevFp = fp;
    fps.push(fp);
  }
  if (progressedRounds >= 1) n++;
  if (progressedRounds >= 2) r2progress++;
  if (progressedRounds >= 3) r3progress++;
  if (progressedRounds > 1) anyRepeat++;
}
console.log('样本:', all.length);
console.log('  第 1 轮世界指纹变了:', n);
console.log('  ★ 第 2 轮**同一份计划**还继续成功并改变指纹:', r2progress);
console.log('  ★ 第 3 轮还继续:', r3progress);
console.log('  ⇒ 若 2/3 轮都还在变，那么「换动作不算 stall」+「部分执行让世界变」＝3 轮里累计 3 次免检');
