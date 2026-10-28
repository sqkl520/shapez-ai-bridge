#!/usr/bin/env node
/**
 * experiment-coldstart.mjs — 阶段 2 的核心实验：**冷启动时 LLM 能不能选中该改的东西**。
 *
 * 为什么是这个实验（验收审计的建议，我认同）：
 *   阶段 2 的赌注是「宏动作层能把真实存档从 0 抬起来」。但这有个前提：
 *   LLM 得先**看见**该改哪里、并且**选对**它。离线环境验不了产线，
 *   但完全可以验「它选的是不是那几条带子」——这是整条链路的第一环，
 *   而且只需要 FakeGame，不需要游戏实例。
 *
 *   验了这个，才知道后面的失败到底该归咎于谁：
 *     选不对 → prompt 的问题（信息没给到），不是模型也不会是宏
 *     选得对但跑不通 → 宏/计划层的问题
 *     跑通但没交货 → 需要实机才能判
 *
 * 实验设计：
 *   ① 对同一份 L4 冷启动存档跑 N 次（每次从同一个 obs 起点，深拷贝）
 *   ② 每次用 buildPrompt 渲染 → LLM 输出 → parse → 解析句柄
 *   ③ 统计：选中的带子集合 ∩ 正解三条带子集合 的大小
 *   ④ 同时记录它最终产出的 plan 能不能过 plan 阶段（零写入）
 *
 * 用法：
 *   node src/agent/experiment-coldstart.mjs                     # 用 mock（离线，免费）
 *   node src/agent/experiment-coldstart.mjs --mock-dir <dir>    # 指定 mock 场景
 *   node src/agent/experiment-coldstart.mjs --llm               # 用真 API（需 key）
 *   node src/agent/experiment-coldstart.mjs --runs 5 --json     # 5 次，JSON 输出
 *
 * 零依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "./fake_game.mjs";
import { buildHandles } from "./loop/handles.mjs";
import { buildPrompt } from "./loop/prompt.mjs";
import { parseLlmPlan, makeClient } from "./loop/llm.mjs";
import { assertNoHumanCoords, resolveRefs } from "./loop/coords.mjs";
import { planToTxOps } from "./loop/planToTxOps.mjs";
import { replaceRun, removeRun } from "./macros/remove.mjs";
import { insertMachine } from "./macros/place.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** L4 冷启动的正解：删这三条带子，放 cutter + trash。 */
const GROUND_TRUTH = Object.freeze({
    shape: "RuRu----",
    level: 4,
    /** 必须被删掉的带子（uid） */
    must_remove_uids: [10209, 10149, 10143],
    /** 必须放下的建筑（kind → origin） */
    must_place: [{ kind: "cutter", origin: [4, -13] }, { kind: "trash", origin: [4, -14] }],
});

/* ─────────────────────── 参数 ─────────────────────── */

function parseArgs(argv) {
    const a = {
        runs: 1, json: false, mode: "mock", mockDir: null, scenario: "l4-coldstart",
        verbose: false, baseUrl: null, model: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === "--runs") a.runs = Math.max(1, parseInt(argv[++i], 10) || 1);
        else if (k === "--json") a.json = true;
        else if (k === "--verbose") a.verbose = true;
        else if (k === "--llm") a.mode = "live";
        else if (k === "--base-url") a.baseUrl = argv[++i];
        else if (k === "--model") a.model = argv[++i];
        else if (k === "--mock-dir") {
            a.mockDir = argv[++i];
            a.mode = "mock";
            a.scenario = path.basename(a.mockDir);
        } else if (k === "--scenario") a.scenario = argv[++i];
    }
    return a;
}

/* ─────────────────────── 单次尝试 ─────────────────────── */

/**
 * 跑一次冷启动尝试，返回结构化结果。
 *
 * 注意：这里**不写世界**。它只走到 plan 阶段（这是"没人算坐标"的第一道门），
 * 因为离线环境验不了 L3/L4（见 offline_boundary.mjs）。
 */
async function attemptOnce({ runIndex, client, verbose }) {
    const game = FakeGame.fromFiles(
        path.join(REPO, "test/fixtures/saves/L4-obs.json"), null,
        { goal: GROUND_TRUTH.shape },
    );
    const obs = structuredClone(game.observe({ max_entities: 50000 }));
    const items = game.debugItems();
    const handles = buildHandles(obs, items);

    const uidToHandle = new Map();
    const handleToUid = new Map();
    for (const [h, e] of handles.byHandle) {
        if (typeof e.uid === "number") { uidToHandle.set(e.uid, h); handleToUid.set(h, e.uid); }
    }

    const prompt = buildPrompt({
        goal: { shape: GROUND_TRUTH.shape, level: GROUND_TRUTH.level },
        obs, handles,
        diagnoses: [],                        // 冷启动：没有任何诊断
        candidates: ["replace_run", "remove_run", "insert_machine"],
        lastRound: null,
        budget: {},
    });

    /* 记录 prompt 里到底出现了哪些句柄 —— 这是"LLM 能不能看见目标"的直接证据 */
    const text = prompt.system + "\n" + prompt.user;
    const visibleHandles = new Set();
    for (const h of handleToUid.keys()) {
        if (new RegExp(`\\b${h}\\b`).test(text)) visibleHandles.add(h);
    }
    const truthHandles = GROUND_TRUTH.must_remove_uids.map(u => uidToHandle.get(u));
    const truthVisible = truthHandles.filter(h => h && visibleHandles.has(h));

    /* 调用 LLM */
    let raw = null, llmErr = null;
    try {
        const r = await client.propose({ system: prompt.system, user: prompt.user, text });
        raw = r.text;
    } catch (e) {
        llmErr = String(e && e.message || e);
    }

    const result = {
        run: runIndex,
        prompt_chars: text.length,
        visible_handles: visibleHandles.size,
        truth_handles: truthHandles,
        truth_visible: truthVisible,
        truth_visible_count: truthVisible.length,
        llm_error: llmErr,
        /* ★ 保留模型原文 ★
           没有它，"选中 0/3" 只是一个数字；有了它才能看出模型**为什么**选错
           （实测第一次真 LLM：它把机器名写成 "rotator"（应为 "rotater"）、
            选了 B84 而不是目标，且只想着"加一台"没想到"删三条"）。
           诊断价值全在这段原文里。 */
        llm_raw: raw,
        parsed: null,
        selected_uids: [],
        selected_truth: [],
        plan_ok: false,
        plan_why: null,
        ops: null,
    };

    if (!raw) return result;

    /* 解析 → 收集它引用了哪些句柄 */
    const parsed = parseLlmPlan(raw);
    result.parsed = parsed.ok ? { calls: parsed.plan.calls.length } : { error: parsed.error.code };
    if (!parsed.ok) { result.plan_why = `parse:${parsed.error.code}`; return result; }

    const mentioned = new Set();
    const walk = v => {
        if (typeof v === "string") { if (handleToUid.has(v)) mentioned.add(v); }
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(parsed.plan.calls);

    result.selected_uids = [...mentioned].map(h => handleToUid.get(h)).filter(u => typeof u === "number");
    result.selected_truth = result.selected_uids.filter(u => GROUND_TRUTH.must_remove_uids.includes(u));

    /* 过 coords 层 */
    const coords = assertNoHumanCoords(parsed.plan);
    if (!coords.ok) { result.plan_why = `coords:${coords.violations.map(v => v.rule).join(",")}`; return result; }

    const res = resolveRefs(parsed.plan, handles, obs);
    if (!res.ok) { result.plan_why = `resolveRefs:${res.violations.map(v => v.rule).join(",")}`; return result; }

    /* 调真宏 + 编排
     *
     * 六个宏全接上 —— 只支持 replace_run 会让实验**系统性低估**模型：
     * 实测 #1 里模型用了 insert_machine（合理选择），却被记成 unsupported_macro，
     * 看起来像"它不会"，其实是"我们没让它跑"。这类测量偏差必须消掉。 */
    const IMPLS = { replace_run: replaceRun, insert_machine: insertMachine, remove_run: removeRun };
    const calls = [];
    for (const c of res.calls) {
        const impl = IMPLS[c.macro];
        if (!impl) { result.plan_why = `unsupported_macro:${c.macro}`; return result; }
        const out = impl(c.args, { entities: obs.entities });
        calls.push({ macro: c.macro, args: c.args, result: out, provenance: c.provenance });
        if (!out.ok) { result.plan_why = `macro:${c.macro}:${out.error.code}`; return result; }
    }
    const txp = planToTxOps(calls, { obs, handles, items });
    if (!txp.ok) { result.plan_why = `planToTxOps:${txp.error && txp.error.code}`; return result; }

    result.plan_ok = true;
    result.ops = txp.ops.length;
    result.destroys = txp.destroys;

    /* 关键判据：它删的是不是正好那三条？ */
    const removed = new Set(txp.destroys || []);
    result.removed_truth = GROUND_TRUTH.must_remove_uids.filter(u => removed.has(u));
    result.removed_extra = [...removed].filter(u => !GROUND_TRUTH.must_remove_uids.includes(u));
    result.exact_match =
        result.removed_truth.length === GROUND_TRUTH.must_remove_uids.length
        && result.removed_extra.length === 0;

    /* 放的建筑对不对 */
    const places = (txp.ops || []).filter(o => o.op === "place");
    result.placed = places.map(o => `${o.building}@${o.x},${o.y}`);
    result.placed_match = GROUND_TRUTH.must_place.every(g =>
        places.some(o => o.building === g.kind && o.x === g.origin[0] && o.y === g.origin[1]));

    if (verbose) {
        console.log(`  [run ${runIndex}] visible=${visibleHandles.size} truthVisible=${truthVisible.length}/3 `
            + `selected=${result.selected_uids.length} truthSelected=${result.selected_truth.length} `
            + `plan=${result.plan_ok ? "ok" : result.plan_why}`);
    }
    return result;
}

/* ─────────────────────── 主流程 ─────────────────────── */

async function main() {
    const args = parseArgs(process.argv.slice(2));

    let client;
    if (args.mode === "live") {
        client = makeClient({
            mode: "live",
            ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
            ...(args.model ? { model: args.model } : {}),
            /* 代理上的模型会先输出很长的 thinking 块；默认 1200 会被它吃满（实测
               stop_reason=max_tokens、text 为空）。20000 才够它想完再输出。 */
            maxTokens: 20000,
            timeoutMs: 280000,
        });
        if (!args.json) {
            console.log(`（真 LLM 模式：endpoint=${client.endpoint || "?"} model=${client.model || "?"}）`);
        }
    } else {
        /* MockLLMClient 的 `dir` 是**场景目录本身**（给了 scenario 才会再拼一层）。
           这里直接给场景目录，不给 scenario，避免拼成 dir/scenario/scenario。
           strict:true —— 夹具缺失必须**抛**，不能变成空 calls。
           strict:false 会把"文件没找到"伪装成"LLM 没想法"，这正是本轮踩过的坑。 */
        const dir = args.mockDir || path.join(REPO, "test/fixtures/llm", args.scenario);
        client = makeClient({ mode: "mock", dir, strict: true });
    }

    const results = [];
    for (let i = 1; i <= args.runs; i++) {
        try {
            results.push(await attemptOnce({ runIndex: i, client, verbose: args.verbose || args.runs > 1 }));
        } catch (e) {
            results.push({ run: i, llm_error: String(e && e.message || e), plan_ok: false });
        }
    }

    /* ── 汇总 ── */
    const n = results.length;
    const sum = {
        runs: n,
        mode: args.mode,
        /* ① LLM 看得见正解吗（prompt 的信息量） */
        truth_all_visible: results.filter(r => r.truth_visible_count === 3).length,
        truth_partial_visible: results.filter(r => r.truth_visible_count > 0 && r.truth_visible_count < 3).length,
        truth_none_visible: results.filter(r => r.truth_visible_count === 0).length,
        /* ② 它选中的带子里有几条是正解 */
        picked_any_truth: results.filter(r => (r.selected_truth || []).length > 0).length,
        picked_all_truth: results.filter(r => (r.selected_truth || []).length === 3).length,
        /* ③ 走到 plan 阶段的比例 */
        plan_ok: results.filter(r => r.plan_ok).length,
        /* ④ 删除集合精确匹配的比例 */
        exact: results.filter(r => r.exact_match).length,
        placements_ok: results.filter(r => r.placed_match).length,
    };

    const report = {
        generated_at: new Date().toISOString(),
        ground_truth: GROUND_TRUTH,
        summary: sum,
        results,
    };

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log("═".repeat(66));
        console.log(`冷启动实验 · ${n} 次 · mode=${args.mode}`);
        console.log("═".repeat(66));
        console.log(`正解：删 uid ${GROUND_TRUTH.must_remove_uids.join(",")}，`
            + `放 cutter@(4,-13) + trash@(4,-14)`);
        console.log("");
        console.log(`① prompt 里能看到几条正解带子？`);
        console.log(`    全看到 (3/3) : ${sum.truth_all_visible}/${n}`);
        console.log(`    部分 (1-2)   : ${sum.truth_partial_visible}/${n}`);
        console.log(`    完全看不到   : ${sum.truth_none_visible}/${n}`);
        console.log("");
        console.log(`② LLM 选中的带子里有几条是正解？`);
        console.log(`    至少 1 条    : ${sum.picked_any_truth}/${n}`);
        console.log(`    全部 3 条    : ${sum.picked_all_truth}/${n}`);
        console.log("");
        console.log(`③ 走到 plan 阶段 : ${sum.plan_ok}/${n}`);
        console.log(`④ 删除集合精确匹配 : ${sum.exact}/${n}`);
        console.log(`   放置坐标正确      : ${sum.placements_ok}/${n}`);
        console.log("");
        if (n <= 8) {
            console.log("逐次明细：");
            for (const r of results) {
                console.log(`  #${r.run} 看到 ${r.truth_visible_count}/3 · 选中 ${(r.selected_truth || []).length}/3 · `
                    + `${r.plan_ok ? "plan ok" : (r.plan_why || r.llm_error || "no output")}`);
                /* 真 LLM 模式：把模型的原始调用摘要打出来，供人判断"错在哪一类"。
                   只看 0/3 这个数字没有任何行动价值。 */
                if (args.mode === "live" && r.llm_raw) {
                    try {
                        const pj = JSON.parse(String(r.llm_raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
                        for (const c of (pj.calls || [])) {
                            const args_ = JSON.stringify(c.args || {});
                            console.log(`       → ${c.macro} ${args_.length > 160 ? args_.slice(0, 160) + "…" : args_}`);
                        }
                        if (pj.say) console.log(`       say: ${String(pj.say).slice(0, 160)}`);
                    } catch {
                        console.log(`       原文(前 160)：${String(r.llm_raw).slice(0, 160)}`);
                    }
                }
            }
        }
        console.log("");
        /* 结论 */
        if (sum.truth_none_visible === n) {
            console.log("✗ 结论：prompt 里一条正解带子都没出现 —— LLM 不可能选对。这是信息量问题，不是模型问题。");
        } else if (sum.picked_all_truth === 0) {
            console.log("✗ 结论：正解可见，但 LLM 一条都没选中。问题在引导（prompt 措辞 / 候选宏 / few-shot）。");
        } else if (sum.exact === 0) {
            console.log("△ 结论：LLM 能选中正解带子，但删除集合不精确 —— 需要检查 bbox 与 region 的语义。");
        } else {
            console.log("✓ 结论：LLM 在离线环境下能选中正解并产出精确的删除集合。");
            console.log("  下一步：这只能证明「决策链正确」，仍需实机验证 goal 真的推进（见 offline_boundary.mjs）。");
        }
    }

    /* 落盘（供报告引用） */
    const outDir = path.join(REPO, "research/ai-plan/experiments");
    try {
        fs.mkdirSync(outDir, { recursive: true });
        const stamp = report.generated_at.replace(/[:.]/g, "-");
        const file = path.join(outDir, `coldstart-${args.mode}-${stamp}.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        if (!args.json) console.log(`\n（结果已写入 ${path.relative(REPO, file)}）`);
    } catch (e) {
        if (!args.json) console.log(`\n（结果落盘失败：${e.message}）`);
    }

    /* 退出码：只有"LLM 选中全部正解且精确删除"才算 0 */
    process.exit(sum.exact === n && n > 0 ? 0 : 1);
}

main().catch(e => { console.error("实验失败：" + (e && e.stack || e)); process.exit(2); });
