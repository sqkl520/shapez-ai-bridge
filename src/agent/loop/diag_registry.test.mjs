/**
 * diag_registry.test.mjs — 诊断码三处登记的一致性守卫
 *
 * ## 为什么需要这个文件
 *
 * 加一个新诊断码要在**三个地方**登记，缺一处就**静默失效**：
 *
 *   ① `constants.mjs` 的 `DIAG_CODES` 闭集 —— `mkDiag` 的 `owns()` 会校验，
 *      缺了直接抛（这个还算好，会响）
 *   ② `constants.mjs` 的 `RETRIEVAL_TABLE` —— 缺了它就没有候选宏，
 *      prompt 里那张卡不会出现（不响）
 *   ③ `loop.mjs` 的跨层 `RANK` —— 缺了落到默认 50，
 *      在 `LIMITS.TOTAL = 8` 的截断里**被挤到看不见**（不响，最难查）
 *
 * 2026-11-21 一天之内踩了 ③ 两次（`WRONG_SHAPE_PRODUCED`、`OUTPUT_STRANDED`），
 * 历史上还有 `MACHINE_STARVED`。症状永远是同一个：
 * **「我加了诊断，测试全绿，真机一条都不报。」**
 *
 * ## 判据的边界
 *
 * 不是所有码都需要 RANK。`DIAG_CODES` 里有一大批是**元层 / 流程码**
 * （`INTERNAL`、`LLM_ARGS`、`TX_UNAVAILABLE`、`BUDGET_*`……），
 * 它们根本不会和语义诊断排在同一个列表里竞争 `LIMITS.TOTAL`。
 *
 * 所以守卫只覆盖**语义层真正会产出的码**（从 `semantic.mjs` 静态提取），
 * 那些码每一条都可能出现在 8 条名额里，缺 RANK 就一定会被后面挤掉。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEMANTIC = path.resolve(HERE, "semantic.mjs");
const STRUCTURAL = path.resolve(HERE, "structural.mjs");
const LOOP = path.resolve(HERE, "../loop.mjs");
const CONSTANTS = path.resolve(HERE, "constants.mjs");

/** 语义层自己 emit 的码（`code: "XXX"` 静态提取）。 */
function semanticCodes() {
    const s = fs.readFileSync(SEMANTIC, "utf8");
    return new Set((s.match(/code:\s*"([A-Z_0-9]+)"/g) || [])
        .map(x => x.match(/"([A-Z_0-9]+)"/)[1]));
}

/**
 * 结构层 emit 的码。
 *
 * ⚠️ 第一版只扫了 `semantic.mjs`，于是 `BELT_HANDOFF_REJECTED` / `CHAIN_UNFED` /
 * `DEAD_END` / `WASTE_NO_SINK` / `RAW_MATERIAL_MISSING` 全被判成
 * 「RANK 里登记了但从不会产出」—— 而它们在真机上每一轮都在报。
 * 它们来自 `structural.mjs`，是**第三个源**。
 */
function structuralCodes() {
    const s = fs.readFileSync(STRUCTURAL, "utf8");
    return new Set((s.match(/code:\s*"([A-Z_0-9]+)"/g) || [])
        .map(x => x.match(/"([A-Z_0-9]+)"/)[1]));
}

/** `diagnose()` 里 `mkDiag("XXX")` 的码。 */
function diagnoseCodes() {
    const s = fs.readFileSync(LOOP, "utf8");
    return new Set((s.match(/mkDiag\("([A-Z_0-9]+)"/g) || [])
        .map(x => x.match(/"([A-Z_0-9]+)"/)[1]));
}

function rankCodes() {
    const s = fs.readFileSync(LOOP, "utf8");
    const i = s.indexOf("const RANK = {");
    assert.ok(i > 0, "loop.mjs 里找不到 RANK 表");
    const j = s.indexOf("\n    };", i);
    assert.ok(j > i, "RANK 表没有闭合");
    return new Set(s.slice(i, j).match(/\b[A-Z][A-Z_0-9]{2,}\b(?=\s*:\s*\d)/g) || []);
}

function diagCodeSet() {
    const s = fs.readFileSync(CONSTANTS, "utf8");
    const i = s.indexOf("export const DIAG_CODES = Object.freeze({");
    assert.ok(i > 0, "constants.mjs 里找不到 DIAG_CODES");
    const j = s.indexOf("\n});", i);
    assert.ok(j > i, "DIAG_CODES 没有闭合");
    const out = new Set();
    for (const m of s.slice(i, j).matchAll(/^\s{4}([A-Z_0-9]+):/gm)) out.add(m[1]);
    return out;
}

/* 已经在 RANK 里的语义码之外，有这几个是**确定要补的**（本次盘点发现）。
   它们会进 diagnose() 的输出、会和别的诊断竞争 8 条名额，但没登记。 */
test("★ 语义层产出的每一个码都必须在跨层 RANK 里登记", () => {
    const rank = rankCodes();
    const sem = new Set([...semanticCodes(), ...structuralCodes()]);
    const missing = [...sem].filter(c => !rank.has(c)).sort();
    assert.deepEqual(missing, [],
        `这些语义码会产出但没登记 RANK —— 会落到默认 50，`
        + `在 LIMITS.TOTAL=8 的截断里被挤到看不见：\n  ${missing.join(", ")}\n`
        + `症状是「加了诊断、测试全绿、真机一条都不报」。`);
});

test("★ diagnose() 里 mkDiag 的码必须在 DIAG_CODES 闭集里", () => {
    const diag = diagCodeSet();
    const emitted = diagnoseCodes();
    const missing = [...emitted].filter(c => !diag.has(c)).sort();
    assert.deepEqual(missing, [],
        `这些码会被 mkDiag 产出但没登记 DIAG_CODES（owns() 会抛）：${missing.join(", ")}`);
});

test("RANK 里不许有拼错的死码（登记了一个从不产出的码）", () => {
    /* 反向检查：RANK 里每个码要么是语义码、要么是 diagnose 码、要么是已知的
       「只由别处产出」的码。防的是「我登记了 OUTPUT_STRANDEDS（多了个字母）」。 */
    const rank = rankCodes();
    const known = new Set([...semanticCodes(), ...structuralCodes(), ...diagnoseCodes()]);
    /* 这几个由 verify / loop 的其它路径产出（不是 mkDiag 或 semantic/structural 的字面量） */
    const fromElsewhere = new Set([
        "GOAL_CHANGED", "GOAL_MISMATCH", "INTERNAL", "NO_DIAGNOSIS", "NO_PROGRESS",
        "NO_PROGRESS_3X", "BUDGET_ROUNDS", "BUDGET_LLM_CALLS", "BUDGET_TX",
        "BUDGET_TICKS", "BUDGET_WALL", "OBSOLETE_LINE", "WORLD_REVERTED",
        "PRODUCTION_UNAVAILABLE", "ITEMS_UNAVAILABLE", "TX_UNAVAILABLE",
        /* verify 层把 check 名映射成码时用的（LANDING_* 由 verify.mjs 产出） */
        "LANDING_MISSING", "LANDING_MISMATCH", "NO_WORLD_CHANGE",
        /* 不是诊断码，是 LIMITS 的键，被同一个正则误抓 */
        "PER_CODE", "TOTAL",
    ]);
    const unknown = [...rank].filter(c => !known.has(c) && !fromElsewhere.has(c)).sort();
    assert.deepEqual(unknown, [],
        `RANK 里这些码从来不会被产出（拼错？还是删了实现忘了删登记？）：${unknown.join(", ")}`);
});
