/**
 * 追加方案 E/F/G：红队只对比了 A/B/C/D，但没试「按可撤销性筛」。
 *
 * ## 红队的核心发现
 *
 * 方案 B（提交全部成功子集）的 78 次「不可逆 place」里，大头是 `trash_unused` ——
 * 它把 `DEAD_END` 带子的出口**封死**，而 6 个宏里**没有一个能删机器/垃圾桶**。
 *
 * ⇒ 如果只提交**可撤销**的那些，收益能不能保住、风险能不能消掉？
 *
 * ## 可撤销性分类（基于宏的能力，不是猜测）
 *
 * | 宏 | 产物 | 可撤销吗 |
 * |---|---|---|
 * | `connect` | 带子 | ✅ `remove_run` 能删带子 |
 * | `extend_line` | 带子 | ✅ 同上 |
 * | `replace_run`（belt 模式） | 带子 | ✅ 同上 |
 * | `replace_run`（机器模式） | 机器 | ❌ 没有宏能删机器 |
 * | `insert_machine` | 机器 | ❌ 同上 |
 * | `trash_unused` | 垃圾桶 | ❌ 同上 |
 * | `remove_run` | 删带子 | ⚠️ 「删」本身不可逆，但可以再 place 回来 |
 *
 * 验证方式：`remove.mjs` 的 `removeRun` 只处理带子
 * （「选集里有 N 个非带子实体（整单拒绝）」），所以机器/垃圾桶确实删不掉。
 *
 * ## 测的方案
 *
 *   E = 成功子集里**只留可撤销的**（connect / extend_line / replace_run-belt / remove_run）
 *   F = E 但**再要求第 1 条可撤销的必须是目标动作**（connect/insert/replace/extend）
 *   G = 只提交**前缀**且前缀里不能有不可逆（更严）
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';

const F = {
    remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
    insert_machine: insertMachine, extend_line: extendLine, connect,
};
const BELT = new Set(["belt", "underground_belt"]);
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);

/* ── 收样本（与红队同一口径） ── */
const all = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
    const file = `.tmpverify/ab-real/results${f}.json`;
    if (!fs.existsSync(file)) continue;
    const seen = new Set();
    for (const x of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (!x.parse_ok) continue;
        const k = `${x.arm}#${x.rep}`;
        if (seen.has(k)) continue;
        seen.add(k);
        let p;
        try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); }
        catch { continue; }
        if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
        let calls = p.calls;
        try {
            const rr = resolveRefs(p, handles, OBS);
            if (rr && rr.ok === false) continue;
            if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls;
        } catch { continue; }
        all.push(calls);
    }
}
const N = all.length;

/* ── 一个调用「产物可撤销吗」 ──
 *
 * 判据来自**宏的结果**，不是宏名猜：看这个调用最终产生了什么 op。
 * · 只产 place(belt) / delete(belt) → 可撤销（带子既能量回来也能删掉）
 * · 产 place(机器/垃圾桶) → 不可逆
 */
function opsOf(ex) {
    const tp = planToTxOps(ex, { obs: OBS, items: null });
    return (tp && tp.ok === true && tp.ops.length) ? tp.ops : null;
}
function isReversible(ops) {
    if (!ops) return false;
    return ops.every(o => {
        if (o.op === "delete") return true;                       // 删带子（可重建）
        if (o.op === "place") return BELT.has(o.building);        // 只放带子
        return false;
    });
}

const stat = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
const irrev = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
const goal = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
const GOAL_MACROS = new Set(["connect", "replace_run", "insert_machine", "extend_line"]);

for (const calls of all) {
    const per = calls.map(c => {
        const fn = F[c.macro];
        if (!fn) return null;
        try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; }
    });
    const okFlags = per.map(r => !!(r && r.ok === true));

    /* 每条调用单独翻译成 op，判断它可不可撤销 */
    const opsPer = calls.map((c, i) => okFlags[i] ? opsOf([{ macro: c.macro, args: c.args, result: per[i] }]) : null);

    const commit = {
        A: okFlags.every(Boolean) ? calls.map((c, i) => i) : [],
        B: okFlags.map((o, i) => o ? i : -1).filter(i => i >= 0),
        C: okFlags[0] ? [0] : [],
        D: (() => { const out = []; for (let i = 0; i < calls.length; i++) { if (!okFlags[i]) break; out.push(i); } return out; })(),
        /* E：成功子集里只留**产物可撤销**的 */
        E: okFlags.map((o, i) => (o && isReversible(opsPer[i])) ? i : -1).filter(i => i >= 0),
        /* F：E，且至少含一个目标动作 */
        F: (() => {
            const idx = okFlags.map((o, i) => (o && isReversible(opsPer[i])) ? i : -1).filter(i => i >= 0);
            return idx.some(i => GOAL_MACROS.has(calls[i].macro)) ? idx : [];
        })(),
        /* G：前缀，且前缀里不许有不可逆 */
        G: (() => {
            const out = [];
            for (let i = 0; i < calls.length; i++) {
                if (!okFlags[i]) break;
                if (!isReversible(opsPer[i])) break;      // 遇到不可逆就停（不是跳过）
                out.push(i);
            }
            return out;
        })(),
    };

    for (const k of Object.keys(commit)) {
        if (!commit[k].length) continue;
        const ex = commit[k].map(i => ({ macro: calls[i].macro, args: calls[i].args, result: per[i] }));
        const ops = opsOf(ex);
        if (!ops) continue;
        stat[k]++;
        if (!isReversible(ops)) irrev[k]++;
        if (commit[k].some(i => GOAL_MACROS.has(calls[i].macro))) goal[k]++;
    }
}

console.log(`样本 ${N}（六轮去重，与红队同一口径 + v6）\n`);
console.log('方案                                  提交        含目标动作   含不可逆');
const LABEL = {
    A: "A 全有或全无（现状）",
    B: "B 全部成功子集（红队否掉的）",
    C: "C 只提交 #1",
    D: "D 只提交前缀",
    E: "E 成功子集 ∩ 可撤销 ★",
    F: "F E 且含目标动作 ★",
    G: "G 前缀 ∩ 可撤销 ★",
};
for (const k of Object.keys(stat)) {
    const pct = (100 * stat[k] / N).toFixed(1);
    console.log(`${LABEL[k].padEnd(34)} ${String(stat[k]).padStart(4)} (${pct.padStart(5)}%)  `
        + `${String(goal[k]).padStart(6)}      ${String(irrev[k]).padStart(4)}`);
}

console.log('\n关键对比：');
const ratio = k => stat[k] ? (goal[k] / stat[k]) : 0;
console.log(`  B 的「提交里有多少是真目标动作」: ${(100 * ratio("B")).toFixed(1)}%，不可逆 ${irrev.B} 次`);
console.log(`  E 的同一指标                    : ${(100 * ratio("E")).toFixed(1)}%，不可逆 ${irrev.E} 次`);
console.log(`  F 的同一指标                    : ${(100 * ratio("F")).toFixed(1)}%，不可逆 ${irrev.F} 次`);
