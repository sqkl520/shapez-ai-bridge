/**
 * 密度对照实验：**同一批计划**，在不同密度的世界里重放。
 *
 * ## 为什么这个实验能一锤定音
 *
 * 六轮 `ab-real` 都在 L4-obs（181 实体 / 163 带子）上跑，`connect:occupied` 占失败 43%。
 * 而 `capacity-scenario`（45 实体）的 `occupied` 是 **0/45**。
 *
 * 但那个对比**不是受控的**：两个世界不只是密度不同，布局形态、目标、诊断完全不同。
 *
 * 这个脚本消除那个混淆：**保留 LLM 的原始输出不变**，只改世界。
 *
 * 做法：
 *   1. 从六轮的 results 里取每一轮的 `text`（LLM 原始回复）
 *   2. 构造几个**同一世界**的稀疏化变体（删掉一部分带子）
 *   3. 对每个变体重放**同一批计划**，记录执行成功
 *
 * ⚠️ 关键约束：稀疏化**不能破坏被计划引用的实体**。所以做法是
 *    「先算出所有计划引用到的 uid 集合，只删不在集合里的带子」。
 *
 * 用法：node .tmpverify/ab-density/runner.mjs
 */
import fs from "node:fs";
import { MACRO_NAMES } from "../../src/agent/macros/contract.mjs";
import { resolveRefs } from "../../src/agent/loop/coords.mjs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { removeRun, replaceRun, trashUnused } from "../../src/agent/macros/remove.mjs";
import { insertMachine, extendLine } from "../../src/agent/macros/place.mjs";
import { connect } from "../../src/agent/macros/connect.mjs";

const MACRO_FNS = Object.freeze({
    remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
    insert_machine: insertMachine, extend_line: extendLine, connect,
});
const missing = MACRO_NAMES.filter(n => typeof MACRO_FNS[n] !== "function");
if (missing.length) { console.error(`✗ 宏表缺：${missing.join(", ")}`); process.exit(2); }

const BASE = JSON.parse(fs.readFileSync("test/fixtures/saves/L4-obs.json", "utf8")).result;

/* ─────────── 收集所有计划 ─────────── */
const plans = [];
const seen = new Set();
for (const f of ["", "-v2", "-v3", "-v4", "-v5", "-v6"]) {
    const file = `.tmpverify/ab-real/results${f}.json`;
    if (!fs.existsSync(file)) continue;
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of rows) {
        if (!r.parse_ok) continue;
        const k = `${r.arm}#${r.rep}#${f}`;
        if (seen.has(k)) continue;
        seen.add(k);
        let plan;
        try {
            plan = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
        } catch { continue; }
        if (!Array.isArray(plan.calls) || !plan.calls.length) continue;
        plans.push({ key: k, plan, nCalls: plan.calls.length });
    }
}
console.log(`收集到 ${plans.length} 个计划（calls 1..6）\n`);

/* ─────────── 计划引用到的 uid 集合 ─────────── */
/* 用 resolveRefs 在**原世界**上解析一次，拿到 uid。解析失败的计划在稀疏世界里
   也不会计入分母（它们连句柄都解析不了，与密度无关）。 */
const baseHandles = buildHandles(BASE, null);
const referenced = new Set();
const resolvable = [];
for (const p of plans) {
    let calls;
    try {
        const r = resolveRefs(p.plan, baseHandles, BASE);
        if (r && r.ok === false) continue;
        calls = (r && Array.isArray(r.calls) && r.calls.length) ? r.calls : p.plan.calls;
    } catch { continue; }
    const uids = new Set();
    for (const c of calls) {
        const walk = (v) => {
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v && typeof v === "object") {
                if (typeof v.uid === "number") uids.add(v.uid);
                Object.values(v).forEach(walk);
            }
        };
        walk(c.args || {});
    }
    for (const u of uids) referenced.add(u);
    resolvable.push({ ...p, calls });
}
console.log(`可解析 ${resolvable.length} 个；它们共引用 ${referenced.size} 个不同实体\n`);

/* ─────────── 构造稀疏变体 ─────────── */
/**
 * 按「保留比例」删带子，但**绝不删**：
 *   · 被任何计划引用的实体
 *   · hub / miner / 机器（只删纯带子，保持拓扑骨架）
 *
 * 保留的优先级：离 hub 近的优先留（那才是产线主体）；
 * 远的先删（它们最可能是「挡路」的那些）。
 */
function sparsify(keepRatio) {
    const hub = BASE.entities.find(e => e.type === "hub");
    const deletable = BASE.entities
        .filter(e => e.type === "belt" && !referenced.has(e.uid))
        .map(e => ({ e, d: Math.abs(e.x - hub.x) + Math.abs(e.y - hub.y) }))
        .sort((a, b) => b.d - a.d);          // 远的排前面 = 先删

    const nDrop = Math.round(deletable.length * (1 - keepRatio));
    /* ⚠️ 元素是 `{ e, d }`，不是实体本身 —— 写 `x.uid` 会得到 undefined，
       于是 drop 集合永远是空的，所有变体都等于原世界。
       第一版就是这么写的，跑了 5 分钟得到五行一模一样的数字。 */
    const drop = new Set(deletable.slice(0, nDrop).map(x => x.e.uid));

    const entities = BASE.entities.map(e => (e.uid && drop.has(e.uid)) ? null : e).filter(Boolean);
    return { ...BASE, entities };
}

const VARIANTS = [
    { name: "100% (原世界)", obs: BASE },
    { name: "85%", obs: sparsify(0.85) },
    { name: "70%", obs: sparsify(0.70) },
    { name: "55%", obs: sparsify(0.55) },
    { name: "40%", obs: sparsify(0.40) },
];

console.log("变体：");
for (const v of VARIANTS) {
    const belts = v.obs.entities.filter(e => e.type === "belt").length;
    console.log(`  ${v.name.padEnd(14)} 实体 ${String(v.obs.entities.length).padStart(3)}  带子 ${String(belts).padStart(3)}`);
}
/* ★ 自检：变体必须真的不同 ★
 *
 * 第一版因为 `deletable.map(x => x.uid)`（元素是 `{e,d}`，应为 `x.e.uid`）
 * 让 drop 集合永远是空的，五个变体跑出五行一模一样的数字 —— 而且**没有任何报错**。
 *
 * 这类「实验根本没生效但看起来跑完了」的失败比崩溃更危险：
 * 它会产生一个看起来很有说服力的假结论。
 * 所以这里硬断言：带子数必须单调递减。 */
{
    const counts = VARIANTS.map(v => v.obs.entities.filter(e => e.type === "belt").length);
    const strictlyDown = counts.every((c, i) => i === 0 || c < counts[i - 1]);
    if (!strictlyDown) {
        console.error(`\n✗ 自检失败：变体的带子数没有单调递减 ${JSON.stringify(counts)}`);
        console.error("  稀疏化没生效 —— 这个实验会产出一个假的「密度无影响」结论。");
        process.exit(2);
    }
    console.log(`  ✓ 自检：带子数单调递减 ${counts.join(" → ")}\n`);
}

/* ─────────── 重放 ─────────── */
function replay(calls, obs) {
    /* ⚠️ 用**原世界**解析出来的 calls（含 uid），不再走 resolveRefs ——
       这样「句柄在新世界里不存在」不会被误算成密度效应。 */
    for (const call of calls) {
        const fn = MACRO_FNS[String(call.macro || call.name || "")];
        if (typeof fn !== "function") return { ok: false, why: `no_macro` };
        let res;
        try { res = fn(call.args || {}, { entities: obs.entities }); }
        catch { return { ok: false, why: `${call.macro}:throw` }; }
        if (!res || res.ok !== true) {
            const ec = (res && res.error && (res.error.code || res.error.reason)) || "not_ok";
            return { ok: false, why: `${call.macro}:${ec}` };
        }
    }
    return { ok: true, why: null };
}

console.log("═".repeat(74));
console.log("密度 vs 执行成功（同一批计划，只换世界）");
console.log("═".repeat(74));
console.log("世界            计划数  成功  成功率   主要失败原因");

const detail = {};
for (const v of VARIANTS) {
    let ok = 0;
    const fails = {};
    for (const p of resolvable) {
        const r = replay(p.calls, v.obs);
        if (r.ok) ok++;
        else fails[r.why] = (fails[r.why] || 0) + 1;
    }
    const top = Object.entries(fails).sort((a, b) => b[1] - a[1])[0];
    detail[v.name] = { ok, n: resolvable.length, fails };
    console.log(`${v.name.padEnd(15)} ${String(resolvable.length).padStart(5)}  ${String(ok).padStart(4)}  `
        + `${(100 * ok / resolvable.length).toFixed(1).padStart(5)}%   ${top ? `${top[0]} (${top[1]})` : "—"}`);
}

/* ─────────── 按 calls 数分组 ─────────── */
console.log("\n" + "═".repeat(74));
console.log("密度 × calls 数（成功率）");
console.log("═".repeat(74));
console.log("世界            " + [1, 2, 3, 4, 5].map(n => `calls=${n}`.padStart(9)).join(""));
for (const v of VARIANTS) {
    const cells = [];
    for (const n of [1, 2, 3, 4, 5]) {
        const g = resolvable.filter(p => p.nCalls === n);
        if (!g.length) { cells.push("     —".padStart(9)); continue; }
        const ok = g.filter(p => replay(p.calls, v.obs).ok).length;
        cells.push(`${ok}/${g.length}`.padStart(9));
    }
    console.log(v.name.padEnd(15) + cells.join(""));
}

/* ─────────── 诚实边界 ─────────── */
console.log("\n" + "═".repeat(74));
console.log("诚实边界");
console.log("═".repeat(74));
console.log(`
1. 稀疏化是**人为的**，不是真的游戏状态。删掉带子会改变连通性，
   有些计划在新世界里可能指向不存在的上游 —— 那是密度的效应，也可能是「世界变残缺」的效应。
   两者在这个实验里分不开。
2. 只删**未被计划引用**的带子（保护分母），所以稀疏化对「被引用的那几个实体」
   周围的局部密度影响比数字显示的小。
3. 用原世界解析出的 uid 重放，所以「句柄在新世界不存在」不计入失败。
4. 只测一个基础世界（L4-obs）的稀疏化，不是「另一个世界的真实布局」。
5. 判据是「宏全过」，跳过 planToTxOps / verifyRuntime。
`);
fs.writeFileSync(".tmpverify/ab-density/result.json", JSON.stringify(detail, null, 1));
