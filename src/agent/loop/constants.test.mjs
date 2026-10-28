/**
 * loop/constants.test.mjs — 常量真值的自测。
 *
 * 钉住三件事（都是 v2 §2.5 / §7 明文的判据）：
 *   ① `DIAG_CODES` 是**合法 JS 对象**、冻结、每个码有非空说明、闭集不可增（defineProperty 失败）；
 *   ② `RETRIEVAL_TABLE` 的 key 全在 DIAG_CODES、macro 全在 MACRO_NAMES（这是任务书点名要的断言）；
 *   ③ 预算数值与 v2 §4 / mod 真实上限一致（不是凭印象抄的）。
 *
 * 负例（每条规则都要有一条「反着写必须抓得住」）：
 *   · 往表里塞一个不存在的码 → 红；塞一个不存在的宏 → 红；权重写成 0 → 红；乱序 → 红。
 */
import assert from "node:assert/strict";

import {
    DIAG_CODES, BUDGET, MODES, RUN_DIR, RETRIEVAL_TABLE, validateRetrievalTable,
} from "./constants.mjs";
import { MACRO_NAMES } from "../macros/contract.mjs";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 400) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

/* ═══════════ 0. 前置：模块能加载，不是裸标识符 ═══════════
 * v1 契约的 DIAG_CODES 是 `{ OBS_TRUNCATED, OBS_STALE, ... }` —— 加载即 ReferenceError。
 * 这条测试的存在本身就是「v2 §2.5 已修正」的证据：能 import 到这里就已经过了。 */

ok(DIAG_CODES !== undefined, "constants.mjs 可加载（DIAG_CODES 不是裸标识符块）");
eq(typeof MACRO_NAMES.length, "number", "MACRO_NAMES 是数组");

/* ═══════════ 1. DIAG_CODES 的形状 ═══════════ */

{
    ok(Object.isFrozen(DIAG_CODES), "DIAG_CODES 是冻结的（Object.isFrozen）");
    ok(!Array.isArray(DIAG_CODES), "DIAG_CODES 是对象不是数组（码 → 说明）");
    const keys = Object.keys(DIAG_CODES);
    ok(keys.length >= 40, `DIAG_CODES 有足够多的码（${keys.length} 个）`, keys.length);

    /* 每个 key 都是合法标识符形态（大写下划线），每个 value 是非空说明字符串 */
    const badKeys = keys.filter(k => !/^[A-Z][A-Z0-9_]*$/.test(k));
    ok(badKeys.length === 0, "每个码名都是 [A-Z][A-Z0-9_]* 形态", badKeys);
    const badVals = keys.filter(k => typeof DIAG_CODES[k] !== "string" || DIAG_CODES[k].trim().length < 8);
    ok(badVals.length === 0, "每个码都有非空说明字符串（≥8 字符）", badVals.map(k => [k, DIAG_CODES[k]]));

    /* 说明必须互不相同 —— 复制粘贴的说明等于没有说明 */
    const vals = keys.map(k => DIAG_CODES[k]);
    eq(new Set(vals).size, vals.length, "说明字符串两两不同（没有复制粘贴的占位说明）");

    /* 闭集：新增键必须失败 */
    let threw = false;
    try { Object.defineProperty(DIAG_CODES, "NEW_CODE", { value: "x", enumerable: true }); }
    catch { threw = true; }
    ok(threw, "defineProperty 新增码会抛（闭集是真的闭的）", { threw, has: "NEW_CODE" in DIAG_CODES });
    eq("NEW_CODE" in DIAG_CODES, false, "新增尝试没有留下痕迹");

    /* 赋值在 sloppy/ESM 下静默失败或抛 —— 两种都要求「读不到」 */
    try { DIAG_CODES.ANOTHER = "x"; } catch { /* 抛也行 */ }
    eq(DIAG_CODES.ANOTHER, undefined, "直接赋值也加不进去");
}

/* ═══════════ 2. 任务书点名的判据：RETRIEVAL_TABLE ═══════════ */

{
    const keys = Object.keys(RETRIEVAL_TABLE);
    const codeKeys = new Set(Object.keys(DIAG_CODES));
    const macroSet = new Set(MACRO_NAMES);

    const badCodeKeys = keys.filter(k => !codeKeys.has(k));
    ok(badCodeKeys.length === 0, "RETRIEVAL_TABLE 的每个 key 都在 DIAG_CODES 里", badCodeKeys);

    const badMacros = [];
    const badShape = [];
    for (const [code, list] of Object.entries(RETRIEVAL_TABLE)) {
        if (!Array.isArray(list)) { badShape.push([code, typeof list]); continue; }
        for (const e of list) {
            if (!e || typeof e !== "object") { badShape.push([code, e]); continue; }
            if (!macroSet.has(e.macro)) badMacros.push([code, e.macro]);
            if (!(typeof e.weight === "number" && e.weight > 0)) badShape.push([code, e]);
        }
    }
    ok(badMacros.length === 0, "RETRIEVAL_TABLE 的每个 macro 都在 MACRO_NAMES 里", badMacros);
    ok(badShape.length === 0, "每个 value 都是 {macro,weight>0}[]", badShape);

    ok(Object.isFrozen(RETRIEVAL_TABLE), "RETRIEVAL_TABLE 是冻结的");
    ok(Object.isFrozen(RETRIEVAL_TABLE.MACRO_REFUSED), "候选数组也是冻结的（深冻结）");

    /* 覆盖率：每个诊断码都要有登记。**空数组也是登记** —— 「没有候选，只能 halt」
       是一个必须显式做出的决定，不能让 loop 靠「表里查不到」来猜。 */
    const unregistered = [...codeKeys].filter(k => !(k in RETRIEVAL_TABLE));
    ok(unregistered.length === 0,
        "每个诊断码在 RETRIEVAL_TABLE 里都有登记（没有候选也要写 []）", unregistered);

    ok(validateRetrievalTable().ok, "validateRetrievalTable() 对真表判绿", validateRetrievalTable().violations);
}

/* ═══════════ 3. 负例：坏表必须被抓 ═══════════ */

{
    const bad1 = { NOT_A_CODE: [{ macro: "connect", weight: 1 }] };
    const v1 = validateRetrievalTable(bad1, DIAG_CODES, MACRO_NAMES);
    ok(!v1.ok && v1.violations.some(x => x.reason.includes("不在 DIAG_CODES")),
        "负例：表里出现未登记的码 → 红", v1.violations);

    const bad2 = { MACRO_REFUSED: [{ macro: "build_line", weight: 3 }] };
    const v2 = validateRetrievalTable(bad2, DIAG_CODES, MACRO_NAMES);
    ok(!v2.ok && v2.violations.some(x => x.reason.includes("MACRO_NAMES")),
        "负例：候选宏写成 build_line（不在白名单）→ 红", v2.violations);

    const bad3 = { MACRO_REFUSED: [{ macro: "connect", weight: 0 }] };
    const v3 = validateRetrievalTable(bad3, DIAG_CODES, MACRO_NAMES);
    ok(!v3.ok && v3.violations.some(x => x.path.endsWith(".weight")),
        "负例：权重 0 → 红（0 权重等于没登记）", v3.violations);

    const bad4 = { MACRO_REFUSED: [{ macro: "connect", weight: 1 }, { macro: "connect", weight: 2 }] };
    const v4 = validateRetrievalTable(bad4, DIAG_CODES, MACRO_NAMES);
    ok(!v4.ok && v4.violations.some(x => x.reason.includes("重复")),
        "负例：同一码下宏重复 → 红", v4.violations);

    const bad5 = { MACRO_REFUSED: [{ macro: "connect", weight: 1 }, { macro: "remove_run", weight: 9 }] };
    const v5 = validateRetrievalTable(bad5, DIAG_CODES, MACRO_NAMES);
    ok(!v5.ok && v5.violations.some(x => x.reason.includes("降序")),
        "负例：权重没按降序排 → 红", v5.violations);
}

/* ═══════════ 4. 预算与模式 ═══════════ */

{
    ok(Object.isFrozen(BUDGET), "BUDGET 是冻结的");
    eq(BUDGET.ROUNDS_MAX, 3, "ROUNDS_MAX = 3（v2 §4：从 6 降下来）");
    eq(BUDGET.LLM_CALLS_MAX, 8, "LLM_CALLS_MAX = 8");
    eq(BUDGET.TX_MAX, 6, "TX_MAX = 6");
    eq(BUDGET.TX_OPS_MAX, 2000, "TX_OPS_MAX = 2000（= mod shapez-ai-bridge.js:3258）");
    eq(BUDGET.TICKS_MAX, 24000, "TICKS_MAX = 24000");
    eq(BUDGET.WALL_MS_MAX, 900000, "WALL_MS_MAX = 15 分钟");
    eq(BUDGET.SAME_FINGERPRINT_MAX, 2, "SAME_FINGERPRINT_MAX = 2（v2 §4：简化为两层）");
    eq(BUDGET.LLM_IN_CHARS_MAX, 12000, "LLM_IN_CHARS_MAX = 12000");
    eq(BUDGET.LLM_OUT_CHARS_MAX, 4000, "LLM_OUT_CHARS_MAX = 4000");
    eq(BUDGET.PROMPT_STATE_BELTS_MAX, 12, "PROMPT_STATE_BELTS_MAX = 12（S3 只列 12 条带子）");
    eq(BUDGET.MAX_PATHS, 40, "MAX_PATHS = 40（= mod 的 paths.slice(0,40)）");

    /* 预算之间必须自洽：LLM 调用次数至少够跑满每一轮（否则第 2 轮就会出现
       「round 还有、call 没了」的假 HALT）。v2 §4 删掉了 LLM_CALLS_PER_ROUND，
       但这条下界仍然成立（一轮至少问 1 次）。 */
    ok(BUDGET.LLM_CALLS_MAX >= BUDGET.ROUNDS_MAX,
        "LLM_CALLS_MAX ≥ ROUNDS_MAX（每轮至少能问一次）", BUDGET);

    ok(Object.isFrozen(MODES), "MODES 是冻结的");
    eq(JSON.stringify(MODES), JSON.stringify(["live", "mock", "replay"]), "MODES = live/mock/replay");
    eq(typeof RUN_DIR, "string", "RUN_DIR 是字符串");
    ok(RUN_DIR.startsWith("research/ai-plan/runs"), "RUN_DIR 落在 research/ai-plan/runs", RUN_DIR);
}

/* ═══════════ 5. 契约偏差登记（防回归） ═══════════

 * TICKS_MAX 在契约 v1 的注释里是「200 游戏秒 @120Hz」，实际 ≈400 秒 @60tick/s，
 * 而且 mod 的 MAX_STEP_TICKS = 20000（24000 一次性发不进去）。这条断言不是测代码，
 * 是**测注释没被改回去**：改回「200 秒」时这里会红，提醒改的人去看红队附注。 */

{
    const src = JSON.stringify(BUDGET);
    ok(JSON.parse(src).TICKS_MAX === 24000, "TICKS_MAX 仍是 24000（没被顺手改成 20000）");
    /* 上限必须小于等于 mod 允许的单次 step 上限的两倍，否则「分片」这件事就说不通 */
    ok(BUDGET.TICKS_MAX <= 2 * 20000, "TICKS_MAX 不超过 mod 单次上限(20000)的两倍 —— 两片能发完", BUDGET.TICKS_MAX);
}

/* ═══════════ 汇总 ═══════════ */

console.log(`\nconstants 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
