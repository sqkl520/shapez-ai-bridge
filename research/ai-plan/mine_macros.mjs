#!/usr/bin/env node
/**
 * mine_macros.mjs —— 从历史 transcript 里挖宏的使用情况。
 *
 * 用法：
 *   node research/ai-plan/mine_macros.mjs              # 中文报表
 *   node research/ai-plan/mine_macros.mjs --json       # 机器可读
 *   node research/ai-plan/mine_macros.mjs --macro remove_machine   # 只展开某个宏的逐条记录
 *
 * 为什么需要它：`remove_machine` 在源码里实现了、接了线、prompt 里还有卡片示例，
 * 但没有任何地方能回答「模型到底用没用过它」。transcript 是唯一的事实来源。
 *
 * 事件配对规则（transcript 是 JSONL，每行一个事件，seq 单调）：
 *   propose(seq=n) → 同 round 内、seq 之后第一个 plan
 *   plan.ok=true   → 同 round 内、seq 之后第一个 apply（data.tx_ok 判成败）
 *   plan.ok=false  → data.rejected.code 是计划级码；被踢掉的单条调用在
 *                    data.rejected.evidence.skipped[] 里（按 macro 名贪心配对到 calls[]）
 *
 * 注意：plan 是**全或无**的。ok=false 时整批调用一条都没落盘，
 * 所以「成功」只能由 apply.tx_ok 确认，不能由 plan.ok 推断。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(HERE, "runs");

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const FOCUS = (() => {
    const i = argv.indexOf("--macro");
    return i >= 0 ? argv[i + 1] : null;
})();

/* ─────────────────────────── 读取 ─────────────────────────── */

function listRuns() {
    if (!fs.existsSync(RUNS_DIR)) return [];
    return fs
        .readdirSync(RUNS_DIR)
        .filter((d) => d.startsWith("r-") && fs.statSync(path.join(RUNS_DIR, d)).isDirectory())
        .sort();
}

/** 读一个 run 的 transcript，返回带行号的事件数组。坏行不静默忽略，计数上报。 */
function loadEvents(runId) {
    const p = path.join(RUNS_DIR, runId, "transcript.jsonl");
    if (!fs.existsSync(p)) return { events: [], badLines: 0, missing: true };
    const raw = fs.readFileSync(p, "utf8").split("\n");
    const events = [];
    let badLines = 0;
    raw.forEach((line, i) => {
        const s = line.trim();
        if (!s) return;
        try {
            events.push({ ...JSON.parse(s), __line: i + 1 });
        } catch {
            badLines++;
        }
    });
    return { events, badLines, missing: false };
}

/* ─────────────────────── 事件配对 ─────────────────────── */

/**
 * 把 skipped[] 的条目按 macro 名贪心配到 calls[] 的下标上。
 * skipped 只包含被踢掉的调用，顺序与 calls 一致，但少了成功的那些，
 * 所以不能直接按下标对齐 —— 必须按宏名逐个占位。
 */
function attributeSkipped(calls, skipped) {
    const assign = new Array(calls.length).fill(null);
    const used = new Set();
    for (const sk of skipped || []) {
        let hit = -1;
        for (let i = 0; i < calls.length; i++) {
            if (used.has(i)) continue;
            if (calls[i] === sk.macro) {
                hit = i;
                break;
            }
        }
        if (hit >= 0) {
            used.add(hit);
            assign[hit] = sk;
        }
    }
    return assign;
}

/** 扫描一个 run，产出每一条「模型提议的宏调用」及其结局。 */
function collectRecords(runId, events) {
    const records = [];
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev.kind !== "propose") continue;

        const calls = ev.data?.plan?.calls || [];
        const llmError = ev.data?.error || null;

        // 解析失败：propose 层就挂了，没有 calls 可统计，单独记一条
        if (!calls.length) {
            if (llmError) {
                records.push({
                    run: runId,
                    line: ev.__line,
                    seq: ev.seq,
                    round: ev.round,
                    macro: null,
                    args: null,
                    outcome: "llm_error",
                    errorCode: String(llmError).split(":")[0],
                    errorText: llmError,
                });
            }
            continue;
        }

        // 往后找同 round 的 plan
        let plan = null;
        for (let j = i + 1; j < events.length; j++) {
            const e2 = events[j];
            if (e2.kind === "propose" || e2.kind === "run_end") break;
            if (e2.kind === "plan" && e2.round === ev.round) {
                plan = e2;
                break;
            }
        }

        // plan 成功后往后找同 round 的 apply
        let apply = null;
        if (plan && plan.data?.ok === true) {
            for (let j = events.indexOf(plan) + 1; j < events.length; j++) {
                const e2 = events[j];
                if (e2.kind === "propose" || e2.kind === "run_end") break;
                if (e2.kind === "apply" && e2.round === ev.round) {
                    apply = e2;
                    break;
                }
            }
        }

        const planMacros = plan?.data?.calls || [];
        /* 两处 skipped，语义不同，**必须都读**：
         *   · plan.data.skipped          —— partial 模式下「这批里哪些调用失败了」。
         *                                   此时 plan.ok 仍为 true（成功的那些照常提交），
         *                                   plan.data.calls 只列**成功的**宏。
         *   · plan.data.rejected.evidence.skipped —— 整批被拒时，每条调用各自的错误。
         * 只读后者会把 partial 成功的批次里失败的那几条误判成「成功落盘」。 */
        const skipped =
            plan?.data?.ok === true
                ? plan?.data?.skipped || []
                : plan?.data?.rejected?.evidence?.skipped || [];
        // 按「提议里的宏名」配对，不能用 plan.data.calls —— 那是**成功那部分**的名单。
        const skipAssign = attributeSkipped(calls.map((c) => c.macro), skipped);

        for (let k = 0; k < calls.length; k++) {
            const call = calls[k];
            const base = {
                run: runId,
                line: ev.__line,
                planLine: plan?.__line ?? null,
                applyLine: apply?.__line ?? null,
                seq: ev.seq,
                round: ev.round,
                macro: call.macro,
                args: call.args ?? null,
                why: typeof call.why === "string" ? call.why : null,
            };

            if (!plan) {
                // 有 calls 但没有 plan 事件 —— 数据异常，不能当成功
                records.push({ ...base, outcome: "no_plan_event", errorCode: "NO_PLAN_EVENT" });
                continue;
            }

            const planCode = plan.data?.rejected?.code ?? null;
            const sk = skipAssign[k] || null;

            if (plan.data?.ok === true) {
                /* partial：这批整体通过，但这一条可能被跳过了 —— 它没落盘。 */
                if (sk) {
                    records.push({
                        ...base,
                        outcome: "rejected_call",
                        errorCode: sk.code || sk.reason || "UNKNOWN",
                        hint: sk.hint || null,
                        partialBatch: true,
                    });
                    continue;
                }
                if (!apply) {
                    records.push({ ...base, outcome: "planned_no_apply", errorCode: "NO_APPLY_EVENT" });
                } else if (apply.data?.tx_ok === true) {
                    records.push({ ...base, outcome: "applied", errorCode: null });
                } else {
                    records.push({
                        ...base,
                        outcome: "apply_failed",
                        errorCode: "TX_FAILED",
                        detail: apply.data?.why || null,
                    });
                }
                continue;
            }

            // plan 失败
            if (sk) {
                records.push({
                    ...base,
                    outcome: "rejected_call",
                    errorCode: sk.code || sk.reason || "UNKNOWN",
                    hint: sk.hint || null,
                });
            } else {
                records.push({
                    ...base,
                    outcome: "rejected_plan",
                    errorCode: planCode || "UNKNOWN",
                    hint: plan.data?.rejected?.hint || null,
                    stage: plan.data?.stage || null,
                });
            }
        }
    }
    return records;
}

/* ─────────────────────── 统计 ─────────────────────── */

/**
 * 分两本账，因为两类失败不是一回事：
 *   · 调用级码（ambiguous_port / blocked_by_machine …）—— 针对**这一条调用**，按调用计数。
 *   · 计划级码（NO_REVERSIBLE_CALL / LLM_COORD …）—— 针对**整批 plan**，同一批里 N 条调用
 *     只会产生一次。按调用计数会把 1 次失败放大成 N 次，虚增分母。
 */
function tally(records) {
    const byMacro = new Map();
    const planCodes = new Map();   // 计划级：code → 次数，每个 plan 只记一次
    const seenPlan = new Set();    // `${run}:${planLine}` 去重
    for (const r of records) {
        if (!r.macro) continue; // llm_error 单独统计
        const m = r.macro;
        if (!byMacro.has(m)) {
            byMacro.set(m, {
                macro: m, proposed: 0, applied: 0, plannedOnly: 0,
                callFailed: 0, planFailed: 0, callCodes: new Map(),
            });
        }
        const t = byMacro.get(m);
        t.proposed++;
        if (r.outcome === "applied") t.applied++;
        else if (r.outcome === "planned_no_apply" || r.outcome === "no_plan_event") t.plannedOnly++;
        else if (r.outcome === "rejected_call") {
            t.callFailed++;
            const c = r.errorCode || "UNKNOWN";
            t.callCodes.set(c, (t.callCodes.get(c) || 0) + 1);
        } else {
            t.planFailed++;
            const key = `${r.run}:${r.planLine}`;
            if (!seenPlan.has(key)) {
                seenPlan.add(key);
                const c = r.errorCode || "UNKNOWN";
                planCodes.set(c, (planCodes.get(c) || 0) + 1);
            }
        }
    }
    return {
        rows: [...byMacro.values()].sort((a, b) => b.proposed - a.proposed),
        planCodes: [...planCodes].sort((a, b) => b[1] - a[1]),
    };
}

function fmtPct(n, d) {
    if (!d) return "—";
    return `${((100 * n) / d).toFixed(0)}%`;
}

/* ─────────────────────── 报表 ─────────────────────── */

const runs = listRuns();
const allRecords = [];
let totalBadLines = 0;
let runsMissing = 0;
for (const run of runs) {
    const { events, badLines, missing } = loadEvents(run);
    totalBadLines += badLines;
    if (missing) {
        runsMissing++;
        continue;
    }
    allRecords.push(...collectRecords(run, events));
}

const { rows: table, planCodes } = tally(allRecords);

if (AS_JSON) {
    console.log(
        JSON.stringify(
            {
                runs: runs.length,
                runsMissingTranscript: runsMissing,
                badLines: totalBadLines,
                totalProposedCalls: allRecords.length,
                table: table.map((t) => ({
                    macro: t.macro,
                    proposed: t.proposed,
                    applied: t.applied,
                    plannedOnly: t.plannedOnly,
                    planFailed: t.planFailed,
                    callCodes: Object.fromEntries([...t.callCodes].sort((a, b) => b[1] - a[1])),
                })),
                planCodes: Object.fromEntries(planCodes),
                llmErrors: Object.fromEntries(
                    (() => {
                        const m = new Map();
                        for (const r of allRecords.filter((x) => !x.macro))
                            m.set(r.errorCode, (m.get(r.errorCode) || 0) + 1);
                        return m;
                    })()
                ),
                focus: FOCUS ? allRecords.filter((r) => r.macro === FOCUS) : undefined,
            },
            null,
            2
        )
    );
    process.exit(0);
}

console.log(`扫描 ${runs.length} 个 run 目录（缺 transcript: ${runsMissing}，坏行: ${totalBadLines}）`);
console.log(`共产出 ${allRecords.length} 条「模型提议的宏调用」记录\n`);



console.log("| 宏 | 提议次数 | 成功落盘 | 成功率 | 失败（调用级错误码） |");
console.log("|---|---|---|---|---|");
for (const t of table) {
    const codes = [...t.callCodes]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}×${n}`)
        .join(", ");
    const extra = [];
    if (t.planFailed) extra.push(`计划级×${t.planFailed}`);
    if (t.plannedOnly) extra.push(`无apply×${t.plannedOnly}`);
    console.log(
        `| ${t.macro} | ${t.proposed} | ${t.applied} | ${fmtPct(t.applied, t.proposed)} | ${codes || "—"}` +
            `${extra.length ? `（${extra.join("，")}）` : ""} |`
    );
}

const llmErrors = allRecords.filter((r) => !r.macro);
if (llmErrors.length) {
    const byCode = new Map();
    for (const r of llmErrors) byCode.set(r.errorCode, (byCode.get(r.errorCode) || 0) + 1);
    console.log(
        `\n另有 ${llmErrors.length} 次提议在解析前就失败（无 calls 可统计）：` +
            [...byCode].map(([c, n]) => `${c}×${n}`).join(", ")
    );
}

if (planCodes.length) {
    console.log(
        `\n计划级拒绝码（每个 plan 记一次）：` +
            planCodes.map(([c, n]) => `${c}×${n}`).join(", ")
    );
}

/* 聚焦某个宏：贴逐条记录 */
if (FOCUS) {
    const rows = allRecords.filter((r) => r.macro === FOCUS);
    console.log(`\n=== ${FOCUS} 逐条记录（${rows.length} 条）===`);
    if (!rows.length) console.log("（一条都没有）");
    for (const r of rows) {
        console.log(
            `${r.run} L${r.line} round=${r.round} → ${r.outcome}/${r.errorCode || "ok"}` +
                (r.hint ? `\n    hint: ${r.hint}` : "") +
                (r.args ? `\n    args: ${JSON.stringify(r.args)}` : "")
        );
    }
}

/* 项目级结论辅助：哪些宏从未出现在模型可见的 candidates 里 */
console.log("\n=== 补充 ===");
const resultsPath = path.join(HERE, "runs");
const candSets = new Map();
for (const run of runs) {
    const { events } = loadEvents(run);
    for (const e of events) {
        if (e.kind !== "propose") continue;
        const set = (e.data?.candidates || []).join(",") || "(empty)";
        candSets.set(set, (candSets.get(set) || 0) + 1);
    }
}
const everOffered = new Set();
for (const s of candSets.keys()) for (const m of s.split(",")) if (m) everOffered.add(m);
console.log(`历史上模型见过的 candidates 并集：${[...everOffered].sort().join(", ")}`);

void resultsPath;
