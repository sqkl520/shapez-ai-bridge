/**
 * Q3 的量化 + 「不可逆改动」的量化。
 *
 * 不可逆 = 现有 6 个宏里没有任何一个能撤销它（已实测 irreversible.mjs）：
 *   · place trash      —— remove_run / replace_run 都判 not_a_run（只处理带子），无宏可删机器
 *   · place cutter 等  —— 同上
 * 可逆：
 *   · place belt       —— remove_run 能删
 *   · delete belt      —— connect / replace_run 能重新铺
 *
 * 问题：部分执行会把多少不可逆改动落到**用户存档**上，然后因为 ROUNDS_MAX=3 停手？
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

let withOps = 0, irreversible = 0, irrevOnly = 0, irreversibleFull = 0;
const kinds = {};
for (const calls of rows) {
  const per = calls.map(c => { const fn = F[String(c.macro || '')];
    if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = [];
  calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null });
  if (!tp || tp.ok !== true || !tp.ops.length) continue;
  withOps++;
  /* 哪些 op 不可逆 */
  const irrev = tp.ops.filter(o => o.op === "place" && o.building !== "belt" && o.building !== "underground_belt");
  for (const o of irrev) kinds[o.building] = (kinds[o.building] || 0) + 1;
  if (irrev.length) {
    irreversible++;
    if (okList.every(c => c.macro === "trash_unused" || c.macro === "insert_machine")) irrevOnly++;
  }
  if (okList.length === calls.length) irreversibleFull += 0;
}
console.log('样本', rows.length, '  能产出 op 的', withOps);
console.log('★ 含不可逆 op（放机器/垃圾桶）的轮次:', irreversible, `(${(100 * irreversible / rows.length).toFixed(1)}% of all, ${(100 * irreversible / withOps).toFixed(1)}% of actionable)`);
console.log('  其中「成功的全是 trash/insert_machine」——一遍遍只加不可逆建筑:', irrevOnly);
console.log('  不可逆 op 种类与条数:', JSON.stringify(kinds));
console.log('\nROUNDS_MAX = 3 ⇒ 部分执行若每轮都推进一点，一次 run 最多落 3 批不可逆改动。');
console.log('可撤销它们的手段:', 'none（MACRO_NAMES 的 remove_run 只处理带子，replace_run 的 region 含机器则整单拒绝）');
