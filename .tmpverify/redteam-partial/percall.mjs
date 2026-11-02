/**
 * 红队 Q3 的计算：单条宏成功率、部分执行门槛、以及「部分执行会不会绕开指纹计数」。
 *
 * 口径与 `.tmpverify/ab-real/multicall.mjs` 完全一致（同一份 L4-obs.json、同一套宏、同一份 results）。
 * 唯一的区别：multicall.mjs 判「整轮全成功」，这里**逐条**记录，于是能算出部分执行的门槛。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';

const MACRO_FNS = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
    insert_machine: insertMachine, extend_line: extendLine, connect };

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

function parse(text) {
  try { return JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
  catch { return null; }
}

const rows = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const r = JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'));
  const seen = new Set();
  for (const x of r) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`;
    if (seen.has(k)) continue; seen.add(k);
    const plan = parse(x.text);
    if (!plan || !Array.isArray(plan.calls) || !plan.calls.length) continue;
    let calls = plan.calls;
    try {
      const rr = resolveRefs(plan, handles, OBS);
      if (rr && rr.ok === false) continue;
      if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls;
    } catch { continue; }
    const per = [];
    for (const call of calls) {
      const fn = MACRO_FNS[String(call.macro || call.name || '')];
      if (typeof fn !== 'function') { per.push({ macro: call.macro, ok: false, why: 'unknown' }); continue; }
      let res;
      try { res = fn(call.args || {}, { entities: OBS.entities }); }
      catch { per.push({ macro: call.macro, ok: false, why: 'throw' }); continue; }
      per.push({
        macro: call.macro, ok: !!(res && res.ok === true),
        why: res && res.ok !== true ? ((res.error && res.error.code) || res.reason || '?') : null,
      });
    }
    rows.push({ n: per.length, per });
  }
}

console.log('去重样本数:', rows.length);
const N = rows.length;
const exactK = {};
let atLeastOne = 0, allOk = 0, sumOk = 0, sumCalls = 0;
for (const r of rows) {
  const k = r.per.filter(c => c.ok).length;
  exactK[k] = (exactK[k] || 0) + 1;
  if (k >= 1) atLeastOne++;
  if (k === r.n) allOk++;
  sumOk += k; sumCalls += r.n;
}
console.log('逐条总成功率:', sumOk + '/' + sumCalls, (100 * sumOk / sumCalls).toFixed(1) + '%');
console.log('全成功（现状 R1）:', allOk + '/' + N, (100 * allOk / N).toFixed(1) + '%');
console.log('至少一条成功（part: "any" 的门槛）:', atLeastOne + '/' + N, (100 * atLeastOne / N).toFixed(1) + '%');
console.log('整轮成功条数分布 k:', JSON.stringify(exactK));

const byMacro = {};
for (const r of rows) for (const c of r.per) {
  byMacro[c.macro] = byMacro[c.macro] || { t: 0, ok: 0, why: {} };
  byMacro[c.macro].t++;
  if (c.ok) byMacro[c.macro].ok++;
  else byMacro[c.macro].why[c.why] = (byMacro[c.macro].why[c.why] || 0) + 1;
}
console.log('\n按宏:');
for (const [m, v] of Object.entries(byMacro).sort((a, b) => b[1].t - a[1].t)) {
  console.log(`  ${m.padEnd(16)} ${v.ok}/${v.t}  (${(100 * v.ok / v.t).toFixed(0)}%)  失败码 ${JSON.stringify(v.why)}`);
}

/* 规划侧的一个前哨：模型写的调用**指向同一个目标**吗？
   若 N 个调用里只有 1 个是「真正的目标动作」，其余是清理/收尾，
   那「部分执行」实际推进的只有那 1 个 —— 这与 calls 数无关。 */
console.log('\n调用里宏的搭配（前 12 种）:');
const combo = {};
for (const r of rows) {
  const key = r.per.map(c => c.macro).join('+');
  combo[key] = (combo[key] || 0) + 1;
}
for (const [k, v] of Object.entries(combo).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(v).padStart(3)}×  ${k}`);
}

/* ★ 关键：部分执行的「成功」是哪一半 ★
 * 若成功的那条是 trash_unused（清理），而 connect / replace_run（真正干活的那一半）全红，
 * 则部分执行推进的只是清理 —— 这正是 L3-METRIC-GAMING 攻击 A 的形状。 */
const GOAL_RELEVANT = new Set(["connect", "replace_run", "insert_machine", "extend_line"]);
let cleanupOnly = 0, goalOk = 0, nothing = 0, full = 0;
const examples = [];
for (const r of rows) {
  const okCalls = r.per.filter(c => c.ok);
  if (!okCalls.length) { nothing++; continue; }
  if (okCalls.length === r.n) { full++; continue; }
  const hasGoal = okCalls.some(c => GOAL_RELEVANT.has(c.macro));
  if (hasGoal) goalOk++; else { cleanupOnly++; if (examples.length < 6) examples.push(r.per); }
}
console.log('\n=== 部分执行会把世界推到哪种状态 ===');
console.log('零 op（现状也是零 op）:', nothing + '/' + N);
console.log('全成功（现状已成功）  :', full + '/' + N);
console.log('部分执行且含目标动作  :', goalOk + '/' + N);
console.log('部分执行但只落了清理  :', cleanupOnly + '/' + N, '  ← 这一半只删东西不接东西');
console.log('\n「只落了清理」的例子:');
for (const ex of examples) console.log('  ' + ex.map(c => `${c.macro}:${c.ok ? "OK" : "×" + c.why}`).join('  '));

/* 按 n 分组：P(全对 | n) 与 P(至少一条对 | n) */
console.log('\n=== 按 calls 数分组 ===');
const byN = {};
for (const r of rows) {
  byN[r.n] = byN[r.n] || { t: 0, k: [], all: 0, any: 0 };
  const k = r.per.filter(c => c.ok).length;
  byN[r.n].t++; byN[r.n].k.push(k);
  if (k === r.n) byN[r.n].all++;
  if (k >= 1) byN[r.n].any++;
}
for (const [n, v] of Object.entries(byN).sort((a, b) => a[0] - b[0])) {
  console.log(`  n=${n}  样本 ${v.t}   全对 ${v.all} (${(100*v.all/v.t).toFixed(1)}%)   至少一条 ${v.any} (${(100*v.any/v.t).toFixed(1)}%)`);
}
