/**
 * mustchange_filter.test.mjs — 锁死「必须换动作」只剔除**真正试过并失败**的宏。
 *
 * ## 这个文件存在的原因（2026-10-31 半成品世界实验）
 *
 * `loop.mjs` 的 `countFingerprint()` 在「同一世界诊断第 2 次出现」时强制换动作：
 *
 *     const next = candidatesFor(diagnoses).filter(m => !last.includes(m));
 *     st.candidatesOverride = next;
 *
 * 而 `last` 来自 `settleFailure(diags, macros, ...)`，那里记的是**整轮计划里的所有宏**：
 *
 *     st.lastMacros = Array.isArray(macros) ? macros.slice() : [];
 *
 * ## 实测的后果
 *
 * 第 1 轮模型一次给了两个调用：
 *
 *     calls: [ {macro:"replace_run", ...}, {macro:"connect", ...} ]
 *
 * `replace_run` 在宏校验阶段就失败了（`out_of_scope: 需要 rotation=90`），
 * 于是 `planToTxOps` 按 R1「一条宏失败 ⇒ 一条 op 都不生成」整轮拒绝 ——
 * **`connect` 根本没有被执行过一次**。
 *
 * 但第 2 轮 `candidatesOverride` 把 `replace_run` **和** `connect` 一起剔了，
 * 候选变成 `["insert_machine","trash_unused","extend_line"]`。
 *
 * 结果：**正确答案 `connect` 被一个它从未参与过的失败牵连出局**。
 * 模型第 2 轮只能从剩下的宏里挑，于是又选了 `replace_run`（不在候选里，靠记忆写）
 * 且用了错的字段名 `machine`，整轮 `LLM_ARGS` 被拒。
 *
 * ## 正确的语义
 *
 * 「换动作」要换的是**导致这次失败的那个动作**。一个因为同轮别的宏先失败而
 * 根本没执行的宏，等于没试过 —— 把它剔掉是在惩罚一个未被检验的假设。
 *
 * 但也不能简单地「全不剔」：如果模型真的反复用同一个宏，就必须拦住它。
 *
 * 所以判据是：**剔掉「真正被执行过并失败」的宏；没轮到的保留。**
 * 如果整轮一条都没执行（全部在 plan 阶段被拒），那这条规则无法区分谁该背锅 ——
 * 此时**保留全部候选**，让模型自己换（`NO_PROGRESS_3X` 仍是兜底）。
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ══════════════════════════ 纯函数：剔除逻辑 ══════════════════════════
 *
 * 这里复刻 `loop.mjs:countFingerprint` 的剔除规则，独立成纯函数以便测试。
 * 改动 `loop.mjs` 时必须让两边逐字同义（下面有一条对照断言）。
 */

/**
 * 「必须换动作」时，从候选里剔掉哪些宏。
 *
 * @param {string[]} candidates   `candidatesFor(diagnoses)` 的原始候选（有序）
 * @param {{macro:string, executed?:boolean}[]} lastCalls  上一轮的调用
 * @returns {string[]} 剩余候选（保持原顺序）
 */
export function filterCandidatesForMustChange(candidates, lastCalls) {
    const calls = Array.isArray(lastCalls) ? lastCalls : [];
    /* 只有**真正执行过**的宏才该出局。`executed` 未声明视为 true
       （向后兼容：老代码只传名字，那种情况下确实都跑过了）。 */
    const triedAndFailed = new Set();
    for (const c of calls) {
        if (!c) continue;
        const name = typeof c === "string" ? c : c.macro;
        const executed = typeof c === "string" ? true : c.executed !== false;
        if (name && executed) triedAndFailed.add(name);
    }
    return (candidates || []).filter(m => !triedAndFailed.has(m));
}

/* ══════════════════════════ 1. 核心场景 ══════════════════════════ */

test("★ 整轮被 plan 拒绝（一条都没执行）⇒ 不许剔除任何候选", () => {
    /* 这正是实测的形态：replace_run 在宏校验阶段失败，connect 根本没跑。
       两个都不该出局 —— 尤其是 connect。 */
    const cands = ["replace_run", "insert_machine", "connect", "trash_unused", "extend_line"];
    const last = [
        { macro: "replace_run", executed: false },
        { macro: "connect", executed: false },
    ];
    const next = filterCandidatesForMustChange(cands, last);
    assert.deepEqual(next, cands, "一条都没执行时，候选必须原样保留");
    assert.ok(next.includes("connect"), "★ 关键：connect 没被执行过，不能剔");
});

test("★ 部分执行：只有失败的那个出局，没轮到的不出局", () => {
    const cands = ["replace_run", "insert_machine", "connect"];
    const last = [
        { macro: "insert_machine", executed: true },    // 真的放下去了，然后 tx 失败
        { macro: "connect", executed: false },          // 排在后面，没轮到
    ];
    const next = filterCandidatesForMustChange(cands, last);
    assert.ok(!next.includes("insert_machine"), "真正执行过并失败的应出局");
    assert.ok(next.includes("connect"), "★ 没轮到的必须保留");
    assert.ok(next.includes("replace_run"), "没被调用的本来就该在");
});

test("老形态（裸字符串）仍按「都执行过」处理（向后兼容）", () => {
    const cands = ["replace_run", "connect"];
    const next = filterCandidatesForMustChange(cands, ["replace_run", "connect"]);
    assert.deepEqual(next, [], "裸字符串 = 都试过 ⇒ 全剔（旧行为）");
});

/* ══════════════════════════ 2. 护栏 ══════════════════════════ */

test("护栏：真的反复用同一个宏，仍必须被剔（不能因为放宽就拦不住）", () => {
    const cands = ["connect", "trash_unused"];
    const last = [{ macro: "connect", executed: true }];
    const next = filterCandidatesForMustChange(cands, last);
    assert.ok(!next.includes("connect"), "真的执行过又失败 ⇒ 必须出局");
});

test("护栏：剔空的结果要能被调用方识别（不能静默变成空候选）", () => {
    const cands = ["connect"];
    const last = [{ macro: "connect", executed: true }];
    const next = filterCandidatesForMustChange(cands, last);
    assert.equal(next.length, 0, "剔空就是剔空 —— 调用方据此 halt NO_PROGRESS");
});

test("候选里没有的宏，不出现在结果里也不报错", () => {
    const cands = ["connect"];
    const last = [{ macro: "replace_run", executed: true }];
    assert.deepEqual(filterCandidatesForMustChange(cands, last), ["connect"]);
});

test("lastCalls 是空数组 ⇒ 原样保留", () => {
    const cands = ["connect", "extend_line"];
    assert.deepEqual(filterCandidatesForMustChange(cands, []), cands);
});

/* ══════════════════════════ 3. 与 loop.mjs 的同义性 ══════════════════════════ */

test("★ loop.mjs 的 countFingerprint 必须与本文件同义（防两份实现漂移）", async () => {
    /* 读源码做结构断言：loop.mjs 里必须按 `executed` 过滤，
       而不是把 `lastMacros` 里的所有宏无条件剔除。 */
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.mjs", import.meta.url), "utf8");
    assert.match(src, /executed/, "loop.mjs 的剔除逻辑必须认 `executed`（否则又会把没轮到的动作剔掉）");
    assert.match(src, /lastCalls|lastExecuted|executedMacros/,
        "loop.mjs 必须单独追踪「真正执行过的宏」，不能只看 lastMacros");
});

/* ══════════════════════════ 4. 执行面：机器判定也必须用「执行过的」 ══════════════════════════
 *
 * 上面测的是**候选剔除**（`countFingerprint`）。但 loop 还有一处**执行面**的判定：
 *
 *     if (st.mustChange) {
 *         const now = planned.calls.map(c => c.macro);
 *         if (actionSetHash(now) === actionSetHash(st.lastMacros)) { halt: NO_PROGRESS }
 *     }
 *
 * 2026-11-01 最终验证实测：第 1 轮 `connect` 因为**参数校验失败**
 * （`unknown_field: opts.reuse_existing`）根本没执行；第 2 轮模型去掉坏参数、
 * 给了合法的 `connect`，`plan` 通过 —— 结果执行面拿 `lastMacros`（含未执行的那个）一比，
 * 判成「照抄上一轮」，直接 halt，**把一次正确的修复合上了**。
 *
 * 所以这条检查也必须比 `lastExecutedMacros`。这里做源码级断言 + 语义断言两层。
 */

test("★ 执行面的 mustChange 判定必须比 lastExecutedMacros（不是 lastMacros）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.mjs", import.meta.url), "utf8");

    /* 找到执行面那一段：`if (st.mustChange...)` 之后的 actionSetHash 比较 */
    const m = /if \(st\.mustChange[^)]*\)\s*\{[\s\S]{0,400}?actionSetHash\(now\)\s*===\s*actionSetHash\(([^)]+)\)/.exec(src);
    assert.ok(m, "应当能在 loop.mjs 里找到执行面的 mustChange 判定");
    assert.equal(m[1].trim(), "st.lastExecutedMacros",
        `执行面必须比 lastExecutedMacros，实际比的是 ${m[1].trim()}`);
});

test("★ 上一轮什么都没执行时，mustChange 判定不该触发", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.mjs", import.meta.url), "utf8");
    /* 必须带 `lastExecutedMacros.length` 这个前置条件 ——
       否则「上一轮全部 plan 阶段被拒」时，lastExecutedMacros 是空数组，
       actionSetHash([]) 与 actionSetHash(now) 的比较虽然不同，但这条规则本身没意义。 */
    assert.match(src, /st\.mustChange\s*&&\s*st\.lastExecutedMacros\.length/,
        "mustChange 判定必须要求 lastExecutedMacros 非空");
});

test("语义：同一套宏但上一轮没执行 ⇒ 不算「照抄」", () => {
    /* 用 filterCandidatesForMustChange 的「executed」口径做类比断言 ——
       两处判定共用同一个语义：只有 executed 的才算「试过」。 */
    const last = [{ macro: "connect", executed: false }];
    const executed = last.filter(c => c.executed !== false).map(c => c.macro);
    assert.deepEqual(executed, [], "没执行的宏不该进「上轮试过」的集合");
});
