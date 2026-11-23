#!/usr/bin/env node
/**
 * tools/macro-census.mjs —— 「模型到底在干什么」的读数。
 *
 * ## 为什么需要它
 *
 * 2026-11-22 的一个发现：`## BUILD ORDER FOR A COMPOUND SHAPE` 那 2677 字符
 * 要求模型「挖矿 → 混合 → 切割 → 喷漆 → 叠层」，而 L12 全部 4221 次宏调用里
 * `insert_machine`（建机器的核心动作）只占 **3.2%** ——
 * 96.8% 的动作在动**已有的线**。
 *
 * 也就是说：**教学写的和模型实际做的不是同一件事。**
 * 而这一点在单轮 prompt 里看不出来，只有跨 run 统计宏分布才看得见。
 *
 * 这个工具把那个统计固化。以后每次改 prompt / 诊断，都可以用它量
 * 「模型的行为有没有真的变」—— 比读 transcript 靠人眼快得多，也客观得多。
 *
 * ## 关键指标
 *
 * `insert_machine` 占比 = **模型在不在建东西**。
 *
 *   · 零进度（506 个快照，目标从未出现）时它是 3.2%
 *   · 如果 PROGRESS 读数生效（模型知道链不存在，转去建新链），它应该上升
 *
 * 另一组：`connect + replace_run + remove_run` 占比 = **模型在不在修旧线**。
 *
 * ## 用法
 *
 *   node tools/macro-census.mjs                       # 全部 L12 run
 *   node tools/macro-census.mjs --since 2026-11-22    # 只看某个时间之后的
 *   node tools/macro-census.mjs --last 20             # 最近 20 个 run
 *   node tools/macro-census.mjs --goal RuRu----       # 换目标
 *   node tools/macro-census.mjs --json
 *
 * 只读：只读 `research/ai-plan/runs/` 的落盘 transcript，不连游戏。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const RUNS = path.join(REPO, "research/ai-plan/runs");

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const JSON_OUT = argv.includes("--json");
const GOAL = argVal("--goal") || "CbCbCbRb:CwCwCwCw";
const SINCE = argVal("--since");
const LAST = argVal("--last") ? Number(argVal("--last")) : null;

/** 「在建设」的宏：会往世界里加新东西。 */
const BUILD = new Set(["insert_machine", "extend_line"]);
/** 「在修线」的宏。 */
const REPAIR = new Set(["connect", "replace_run", "remove_run", "remove_machine", "trash_unused"]);

function runDirs() {
    if (!fs.existsSync(RUNS)) return [];
    const all = fs.readdirSync(RUNS)
        .filter(x => x.startsWith("r-"))
        .map(x => ({ id: x, dir: path.join(RUNS, x) }))
        .filter(x => fs.existsSync(path.join(x.dir, "transcript.jsonl")));
    /* 目录名里的时间戳是 `r-YYYYMMDDHHMMSS-xxxx`，字典序即时间序。 */
    all.sort((a, b) => (a.id < b.id ? -1 : 1));
    let list = all;
    if (SINCE) {
        const stamp = SINCE.replace(/[-:]/g, "");
        list = list.filter(x => x.id.slice(2, 10) >= stamp.slice(0, 8));
    }
    if (LAST !== null) list = list.slice(-LAST);
    return list;
}

/** 一个 run 属于哪个目标（读 obs-last 的 goal.requirement.shape）。 */
function goalOf(dir) {
    const p = path.join(dir, "obs-last.json");
    if (!fs.existsSync(p)) return null;
    try {
        const o = JSON.parse(fs.readFileSync(p, "utf8"));
        return (o.goal && o.goal.requirement && o.goal.requirement.shape) || null;
    } catch { return null; }
}

const stats = {
    runs: 0, runsWithPlan: 0,
    calls: 0, byMacro: {},
    runsTouched: 0,      // 至少提过一个计划的 run
    emptyPlans: 0,
};

for (const { dir } of runDirs()) {
    const g = goalOf(dir);
    if (GOAL && g !== GOAL) continue;
    let t;
    try { t = fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }
    catch { continue; }
    stats.runs++;
    let hadPlan = false;
    for (const x of t) {
        if (x.kind !== "propose" || !x.data || !x.data.plan) continue;
        const calls = Array.isArray(x.data.plan.calls) ? x.data.plan.calls : [];
        if (!calls.length) { stats.emptyPlans++; continue; }
        hadPlan = true;
        for (const c of calls) {
            const m = c && c.macro;
            if (!m) continue;
            stats.byMacro[m] = (stats.byMacro[m] || 0) + 1;
            stats.calls++;
        }
    }
    if (hadPlan) stats.runsWithPlan++;
}

const total = stats.calls;
const share = (m) => (total ? stats.byMacro[m] || 0 : 0);
const pct = (n) => (total ? (100 * n / total).toFixed(1) : "0.0");

const buildN = [...BUILD].reduce((s, m) => s + share(m), 0);
const repairN = [...REPAIR].reduce((s, m) => s + share(m), 0);

const rows = Object.entries(stats.byMacro).sort((a, b) => b[1] - a[1]);

if (JSON_OUT) {
    console.log(JSON.stringify({
        goal: GOAL, since: SINCE || null, last: LAST,
        runs: stats.runs, runsWithPlan: stats.runsWithPlan, calls: total,
        byMacro: stats.byMacro,
        buildShare: total ? +(100 * buildN / total).toFixed(1) : 0,
        repairShare: total ? +(100 * repairN / total).toFixed(1) : 0,
    }, null, 1));
    process.exit(0);
}

console.log(`目标 ${GOAL}   run ${stats.runs} 个（其中 ${stats.runsWithPlan} 个提过计划）`);
console.log(`宏调用合计 ${total}\n`);
console.log("  " + "占比".padStart(6) + "  次数   宏                  性质");
for (const [m, n] of rows) {
    const kind = BUILD.has(m) ? "建设" : REPAIR.has(m) ? "修现有线" : "其它";
    console.log(`  ${pct(n).padStart(6)}%  ${String(n).padStart(5)}   ${m.padEnd(18)} ${kind}`);
}
console.log("");
console.log(`  建设（insert_machine + extend_line）: ${pct(buildN)}%`);
console.log(`  修现有线（connect/replace/remove/trash）: ${pct(repairN)}%`);
console.log("");
if (total && repairN / total > 0.8) {
    console.log(`  ⚠ 修线占 ${pct(repairN)}% —— 模型几乎只在动已有的线。`);
    console.log(`    若 goal 进度恒为 0，说明它在修一条造不出目标的线（见 .findings/TEACHING-VS-BEHAVIOR.md）。`);
}