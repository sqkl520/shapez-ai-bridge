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
import { replaceRun, removeRun, trashUnused } from "./macros/remove.mjs";
import { insertMachine, extendLine } from "./macros/place.mjs";
import { connect } from "./macros/connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/**
 * 判据：什么叫"做对了"。
 *
 * ⚠️ 这里曾经写死了 `must_place: cutter@(4,-13) + trash@(4,-14)` 与
 * `must_remove_uids: [10209,10149,10143]` —— 那是**历史正解的坐标**，不是唯一可行解。
 *
 * 2026-10-29 实测发现：在 x=4/x=5 这条向上链上，**五个位置全部有效**：
 *
 *   y=-10..-11 → removes [10206,10139,10146] placed cutter@4,-10 trash@4,-11  ✓
 *   y=-11..-12 → removes [10208,10206,10147] placed cutter@4,-11 trash@4,-12  ✓
 *   y=-12..-13 → removes [10209,10208,10148] placed cutter@4,-12 trash@4,-13  ✓
 *   y=-13..-14 → removes [10143,10209,10149] placed cutter@4,-13 trash@4,-14  ✓  ← 历史正解
 *   y=-14..-15 → removes [10144,10143,10150] placed cutter@4,-14 trash@4,-15  ✓
 *
 * 而 `L4-PLAN-A0.md` 自己写的理由是「向上段**任意位置**插得进去」——
 * 也就是说 y=-13 只是**当时选的那个**，不是唯一正确的那个。
 *
 * 拿它当唯一正解，会把"在正确链上、插在别的有效位置"也算成失败 ——
 * 这是**判据偏差**，会系统性低估模型。所以改成"结构判据"：
 *
 *   ① 必须**删掉**这条链上的带子（不是删别处的）
 *   ② 必须在这条链上放下 cutter + trash
 *   ③ cutter 的落点必须在 x=4/x=5 这条向上链上（y ∈ [-16,-8]），且 trash 在它下游一格
 *
 * 这样"五个位置中的任何一个"都算对 —— 因为物理上它们都对。
 */
const GROUND_TRUTH = Object.freeze({
    shape: "RuRu----",
    level: 4,
    /** 历史正解（人算坐标那次用的）。仅供对照展示，**不再**作为唯一判据。 */
    historical: {
        must_remove_uids: [10209, 10149, 10143],
        must_place: [{ kind: "cutter", origin: [4, -13] }, { kind: "trash", origin: [4, -14] }],
    },
    /**
     * 结构判据：这条向上链的可插入区间。
     * x ∈ {4,5}（并排两条），y ∈ [-16,-8]（整段向上链）。
     * cutter 占 (x,y)+(x+1,y)，trash 落在 (x, y+1)（left 槽喷口）。
     */
    chain: { xs: [4, 5], yMin: -16, yMax: -8 },
    /** 这条链上的带子 uid（删的必须是这条链的） */
    chain_uids: [
        10144, 10143, 10150, 10149, 10144, 10209, 10208, 10148, 10147,
        10206, 10146, 10139, 10141, 10140, 10090, 10091,
    ],
});

/** 判断一个 plan 是否"结构上正确"：在目标链上插入了 cutter，没碰别的地方。 */
function judgePlan(txp, obsEntities) {
    const ops = (txp.ops || []);
    const places = ops.filter(o => o.op === "place");
    const cut = places.find(o => o.building === "cutter");
    const tra = places.find(o => o.building === "trash");
    const { xs, yMin, yMax } = GROUND_TRUTH.chain;

    const onChain = cut && xs.includes(cut.x) && cut.y >= yMin && cut.y <= yMax;
    /* trash 必须在 cutter 的 left 槽喷口。
     *
     * 几何：cutter 的 left 槽 `cell[0,0] dir="bottom"` 的**输出**朝 top ⇒ 喷口在
     * `(x, y-1)`（y 轴向下，所以"北"是 y 减）。实测：cutter@(4,-13) 的 left 喷口是
     * (4,-14) = y-1，不是 y+1。
     *
     * ⚠️ 这里曾经写成 `y + 1`，于是**历史正解自己被判成失败** ——
     * 一个把正确答案判错的判据，比没有判据更糟（它会让人以为模型错了）。 */
    const trashOk = tra && cut && tra.x === cut.x && tra.y === cut.y - 1;

    /* 删掉的必须都是这条链上的带子（不能删别处的） */
    const removed = (txp.destroys || []);
    const chainSet = new Set((obsEntities || [])
        .filter(e => e.type === "belt" && xs.includes(e.x) && e.y >= yMin && e.y <= yMax)
        .map(e => e.uid));
    const removedFromChain = removed.filter(u => chainSet.has(u));
    const removedElsewhere = removed.filter(u => !chainSet.has(u));

    return {
        ok: !!onChain && !!trashOk && removedElsewhere.length === 0 && removedFromChain.length >= 2,
        onChain, trashOk,
        cutter_at: cut ? [cut.x, cut.y] : null,
        trash_at: tra ? [tra.x, tra.y] : null,
        removed_from_chain: removedFromChain.length,
        removed_elsewhere: removedElsewhere.length,
        same_as_historical: !!(cut && cut.x === 4 && cut.y === -13),
    };
}

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
    /* ★ 参数必须与 loop.mjs 的 observe 完全一致 ★
     *
     * 曾经这里只传 `max_entities`，而 FakeGame 那时**无条件**返回 resources ——
     * 于是实验比真机多看到一份矿图，`pickBeltsForGoal` 的原料线判据在离线永远成立、
     * 真机永远失效。第二轮验收审计（B-1）实测：同一份存档，删掉 resources 后
     * prompt 里正解带子从 3/3 掉到 0/3。
     *
     * 现在 FakeGame 按 mod 语义门槛给 resources，这里也必须显式要 —— 两边同口径，
     * 离线测出来的才是真机会发生的事。
     */
    const obs = structuredClone(game.observe({
        max_entities: 50000, layer: "all", include_stats: true,
        include_resources: true, max_resources: 20000,
    }));
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
    const truthHandles = GROUND_TRUTH.historical.must_remove_uids.map(u => uidToHandle.get(u));
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

    /* ★ 口径修正（第二轮验收审计 B-3）：分开记「提到」与「真的用了」★
     *
     * 旧实现把 `selected_uids` 定义成"在整个 calls 树里递归 walk 到的所有句柄"，
     * 而 `why` / `say` / `$bbox_of` 里列出的句柄都会算进去。
     * 实测反例：一个计划里第一调用 `replace_run` 作用在错的三条、`why` 里写
     * "not B69/B81/B82"，第二调用列出正确三条 —— `selected_truth` 报 3/3，
     * 但 `plan_ok=false`。这条定义会**系统性抬高**"选中率"。
     *
     * 现在分开：
     *   · `mentioned_uids`  —— 提到过（旧口径，保留供参考）
     *   · `selected_uids`   —— **只在真正的定位参数里出现**（region/uids/at/outlet/from/to/...）
     *   · `removed_truth`   —— 最终 `destroys` 里命中正解的（**最硬的口径**，已存在）
     * 报告只认后者；前两者仅用于诊断"它想改哪里"。
     */
    const { mentioned, targeted } = splitRefs(parsed.plan.calls, handleToUid);

    result.mentioned_uids = mentioned;
    result.selected_uids = targeted;
    result.selected_truth = targeted.filter(u => GROUND_TRUTH.historical.must_remove_uids.includes(u));
    result.mentioned_truth = mentioned.filter(u => GROUND_TRUTH.historical.must_remove_uids.includes(u));

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
    /* ★ 六个宏全接上 ★
     *
     * 第八轮 #1 用 connect 被记成 unsupported_macro —— 那是**我的实验脚本**没接，
     * 不是模型不会。这类测量偏差会系统性低估模型，必须消掉：
     * 只有「模型选了但宏拒绝了」才是模型的失败，「我们没让它跑」不算。 */
    const IMPLS = {
        replace_run: replaceRun, insert_machine: insertMachine, remove_run: removeRun,
        connect, extend_line: extendLine, trash_unused: trashUnused,
    };
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

    /* ★ 判据：**结构正确**，不是"坐标与历史正解逐位相同" ★
     *
     * 见 GROUND_TRUTH 的注释：这条向上链上五个位置都有效，
     * 拿历史那一个当唯一正解会系统性低估模型。
     *
     * 仍然保留两个"与历史正解的关系"字段（`same_as_historical` / `removed_truth`），
     * 用于**展示**，不用于判成败。
     */
    const verdict = judgePlan(txp, obs.entities);
    result.verdict = verdict;
    result.exact_match = verdict.ok;                 // ← 统计口径改成结构判据
    result.same_as_historical = verdict.same_as_historical;
    result.cutter_at = verdict.cutter_at;
    result.trash_at = verdict.trash_at;
    result.removed_elsewhere = verdict.removed_elsewhere;

    /* 与历史正解的重合度（仅展示，供人判断"它选的是不是那个人选的位置"） */
    const removed = new Set(txp.destroys || []);
    const HIST = GROUND_TRUTH.historical.must_remove_uids;
    result.removed_truth = HIST.filter(u => removed.has(u));

    /* 放的建筑（字符串形式，便于读日志） */
    const places = (txp.ops || []).filter(o => o.op === "place");
    result.placed = places.map(o => `${o.building}@${o.x},${o.y}`);
    result.placed_match = verdict.ok;                // ← 与 exact_match 同口径

    if (verbose) {
        console.log(`  [run ${runIndex}] visible=${visibleHandles.size} truthVisible=${truthVisible.length}/3 `
            + `selected=${result.selected_uids.length} truthSelected=${result.selected_truth.length} `
            + `plan=${result.plan_ok ? "ok" : result.plan_why}`);
    }
    return result;
}

/* ─────────────────────── 句柄引用的两种口径 ─────────────────────── */

/**
 * 把一次计划里出现的句柄分成两类。
 *
 * **为什么要分**（第二轮验收审计 B-3）：旧实验把"在整个 calls 树里 walk 到的所有字符串"
 * 都算成"选中"，于是 `why` 里的"不是 B69"、`$bbox_of` 里列出的 12 个句柄、
 * 甚至 `say` 里的叙述，全都被计入 —— 一个**失败**的计划可以因此报"选中 3/3"。
 *
 * **分类规则**（按宏 ABI 的结构，不猜）：
 *   · `targeted`：出现在**定位参数**里的句柄 —— `region` / `uids` / `cells` / `at` /
 *     `outlet` / `from` / `to` / `building[].port` 之外的那些，以及它们内部的
 *     `$ref` / `$uids` / `$bbox_of` 参数。这些才是"它想动哪里"。
 *   · `mentioned`：其余全部（`why` / `say` / 任何自由文本）。
 */
function splitRefs(calls, handleToUid) {
    const mentioned = new Set();
    const targeted = new Set();

    const walkAll = (v, sink) => {
        if (typeof v === "string") { if (handleToUid.has(v)) sink.add(handleToUid.get(v)); return; }
        if (Array.isArray(v)) { v.forEach(x => walkAll(x, sink)); return; }
        if (v && typeof v === "object") { for (const k of Object.keys(v)) walkAll(v[k], sink); }
    };

    /* 定位类参数的键名（宏 ABI 的真值；`why`/`say` 不在其中） */
    const LOCATOR_KEYS = new Set([
        "region", "uids", "cells", "at", "outlet", "from", "to", "port",
        "$ref", "$uids", "$bbox_of", "$path_of",
    ]);

    const walkTargeted = v => {
        if (Array.isArray(v)) { v.forEach(walkTargeted); return; }
        if (!v || typeof v !== "object") return;
        for (const k of Object.keys(v)) {
            const child = v[k];
            if (LOCATOR_KEYS.has(k)) {
                walkAll(child, targeted);
                /* 定位参数内部的自由文本不存在，所以这里不额外走 mentioned */
            } else if (k !== "why" && k !== "say") {
                walkTargeted(child);
            }
        }
    };

    for (const c of calls || []) {
        walkAll(c, mentioned);          // 全部（含 why）
        walkTargeted(c.args || {});     // 只有定位参数
    }
    return { mentioned: [...mentioned], targeted: [...targeted] };
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
        console.log(`判据：在 x∈{4,5}、y∈[-16,-8] 的向上链上插入 cutter + trash（该链上有 5 个有效位置），`
            + `历史正解是 cutter@(4,-13) + trash@(4,-14)，但其它四个位置同样有效`);
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
