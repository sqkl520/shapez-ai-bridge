/**
 * prompt.test.mjs — buildPrompt 的离线自测（不连游戏、不调 API）。
 *
 * 每条硬规矩都配一个**去掉它就会假绿**的负例：
 *   · 坐标正则  → 用真实 L5 存档（181 实体、158 条带子）渲染，0 命中；
 *                 再手工把一个句柄 desc 写成 `(4,-13)`，断言它被脱敏而不是漏出去
 *   · S1 稳定   → 同一输入渲染两次全等；L4 与 L5 两张存档渲染出的 system **仍**全等
 *   · 只砍带子  → 超预算前后 `s3_goal` / `s3_hub` / S4 逐字节相等，只有带子数下降
 *   · 不静默    → 硬上限超了就抛 PROMPT_OVER_BUDGET（不是悄悄截断 goal）
 *   · S2 白名单 → 每张卡片都 ∈ MACRO_NAMES，未知宏名直接抛（不静默丢弃）
 *
 * 用法：node src/agent/loop/prompt.test.mjs
 * 退出码：0 全过 / 1 有失败
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildPrompt, PROMPT_RULES, MACRO_WHITELIST, coordRegex, hasCoords, PromptOverBudget,
} from "./prompt.mjs";
import { MACRO_NAMES, MACRO_SPECS } from "../macros/contract.mjs";
import { buildHandles } from "./handles.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，断言无效；漏了 await 吗？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const loadObs = name => JSON.parse(fs.readFileSync(path.join(SAVES, name), "utf8")).result;

const L4 = loadObs("L4-obs.json");
const L5 = loadObs("L5-obs.json");
const L5_ITEMS = JSON.parse(fs.readFileSync(path.join(SAVES, "L5-items.json"), "utf8")).result;

/* ═══════════════════ 辅助：真实存档 → 句柄表 ═══════════════════
 *
 * handles.mjs 由并行 agent 实现；这里按契约 §Q3.2 的编号规则做一个**测试内**的最小实现，
 * 用来喂真实数据（181 实体）而不是手搓假表。前缀规则：
 *   hub→H / cutter,painter,mixer,stacker,rotater→C / miner→M / belt,underground_belt→B
 *   trash→T / balancer→L / 其它→X，按 (y,x) 排序编号。
 * desc 用契约 §Q3.2 的带子/机器短语（**刻意不含坐标**，这是被下游保证的不变量）。
 */
function buildHandleTable(obs, items, opts = {}) {
    const prefix = t => {
        if (t === "hub") return "H";
        if (["cutter", "painter", "mixer", "stacker", "rotater"].includes(t)) return "C";
        if (t === "miner") return "M";
        if (t === "belt" || t === "underground_belt") return "B";
        if (t === "trash") return "T";
        if (t === "balancer") return "L";
        return "X";
    };
    const ents = [...(obs.entities || [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const counts = {};
    const byHandle = new Map();
    const byUid = new Map();
    for (const e of ents) {
        const p = prefix(e.type);
        counts[p] = (counts[p] || 0) + 1;
        const handle = p + counts[p];
        const desc = opts.describe ? opts.describe(e) : describeEntity(e, items);
        const entry = { handle, uid: e.uid, type: e.type, variant: e.variant || "default", desc };
        byHandle.set(handle, entry);
        byUid.set(e.uid, entry);
    }
    const hub = [...byHandle.values()].find(e => e.type === "hub");
    return { byHandle, byUid, hubHandle: hub ? hub.handle : null, version: `v:${obs.tick}` };
}

/** 契约 §Q3.2 的两条短语模板。**不打印 uid / x / y / r / code**。 */
function describeEntity(e, items) {
    if (e.type === "belt" || e.type === "underground_belt") {
        const path = ((items && items.paths) || []).find(p => (p.cells || []).some(c => c[0] === e.x && c[1] === e.y));
        const idx = path ? ((items.paths || []).indexOf(path) + 1) : null;
        return `${e.type} segment=${idx === null ? "?" : "#" + idx}`;
    }
    if (e.type === "cutter") return "cutter inputs=bottom outputs=left,right";
    if (e.type === "miner") return "miner ready";
    if (e.type === "trash") return "trash idle";
    if (e.type === "balancer") return "balancer 2-in 2-out";
    if (e.type === "hub") return "hub 16 entries";
    return e.type;
}

const L5_TABLE = buildHandleTable(L5, L5_ITEMS);
const L4_TABLE = buildHandleTable(L4, null);

const baseOpts = (over = {}) => ({
    goal: L5.goal.requirement.shape,
    obs: L5,
    handles: L5_TABLE,
    diagnoses: [],
    candidates: ["replace_run", "connect", "trash_unused"],
    lastRound: null,
    budget: { rounds_left: 3, llm_calls_left: 4, tx_left: 3 },
    ...over,
});

/* ═══════════════════ 0. 常量与形状 ═══════════════════ */

console.log("\n── 0. 返回形状与常量 ──");
{
    const p = buildPrompt(baseOpts());
    ok(typeof p.system === "string" && p.system.length > 0, "system 非空");
    ok(typeof p.user === "string" && p.user.length > 0, "user 非空");
    eq(typeof p.tokens_estimate, "number", "tokens_estimate 是数字");
    ok(p.blocks && typeof p.blocks === "object", "blocks 存在");
    for (const k of ["S1", "S2", "S3", "S4", "S5", "S6", "s3_goal", "s3_hub", "s3_machines", "s3_belts"]) {
        ok(typeof p.blocks[k] === "string", `blocks.${k} 是字符串`);
    }
    eq(p.blocks.S1, p.system, "blocks.S1 === system");
    ok(p.user.includes(p.blocks.S3) && p.user.includes(p.blocks.S4), "user = S2..S6");
    ok(!p.user.includes(p.system), "user 里不重复 S1");

    ok(Object.isFrozen(PROMPT_RULES), "PROMPT_RULES 被冻结");
    eq(PROMPT_RULES.LLM_IN_CHARS_MAX, 12000, "LLM_IN_CHARS_MAX === 12000");
    eq(PROMPT_RULES.CALLS_MAX, 6, "CALLS_MAX === 6");
    eq(PROMPT_RULES.CHARS_PER_TOKEN, 3.5, "chars/token 估算比 3.5");

    /* ⚠️ 这里**不** import constants.mjs。prompt.test.mjs 必须能单独跑；
       「PROMPT_RULES 与 BUDGET 同源」那条由 llm.test.mjs 的集成段负责（它本来就 import 两个文件）。
       两条『上限』说的是不同的事，合并会让其中一条防线永不触发 —— 这里只钉这一条口径。 */
    eq(PROMPT_RULES.CALLS_MAX, 6, "calls 上限是 6（**不是** BUDGET.LLM_CALLS_MAX=8，两者说的是不同的事）");
    ok(MACRO_WHITELIST.every(n => MACRO_NAMES.includes(n)), "MACRO_WHITELIST ⊆ MACRO_NAMES");
    eq(MACRO_WHITELIST.length, 7, "白名单 7 个（$ore 时代的 remove_machine 于 2026-11-03 加入）");
}

/* ═══════════════════ 1. S1 内容与字节稳定 ═══════════════════ */

console.log("\n── 1. S1：内容与字节稳定 ──");
{
    const p = buildPrompt(baseOpts());
    const s1 = p.system;
    ok(/shapez/i.test(s1), "S1 说明角色（shapez）");
    ok(/calls/.test(s1) && /JSON/.test(s1), "S1 给出输出 JSON 格式");
    ok(/NEVER output coordinates|coordinates/i.test(s1), "S1 禁坐标");
    ok(/build_line/.test(s1) && /never emit build_line/i.test(s1), "S1 显式禁 build_line");
    ok(/1 to 6 entries/.test(s1), "S1 写明 ≤6 调用");
    ok(/RAW JSON only/.test(s1), "S1 写「只输出 JSON」");
    for (const n of MACRO_NAMES) ok(s1.includes(n), `S1 白名单列出 ${n}`);

    /* 稳定：同一输入两次 */
    const a = buildPrompt(baseOpts()).system;
    const b = buildPrompt(baseOpts()).system;
    eq(a, b, "同一输入渲染两次：system 完全相同");
    eq(a.length, s1.length, "system 长度稳定");

    /* 稳定：换世界（L4 冷启动 RuRu---- vs L5 Cu----Cu） */
    const p4 = buildPrompt({
        goal: L4.goal.requirement.shape, obs: L4, handles: L4_TABLE,
        diagnoses: [{ code: "NO_PRODUCTION", layer: "L4", severity: "blocker", subject: { handle: "H1" }, expected: { delivered: 70 }, observed: { delivered: 0 }, evidence: { handles: ["B7"] }, candidates: ["replace_run"] }],
        candidates: ["insert_machine", "replace_run"],
        lastRound: { round: 2, calls: [{ macro: "remove_run" }], codes: ["NO_PRODUCTION"] },
        budget: { rounds_left: 1 },
    });
    eq(p4.system, s1, "换世界后 system **仍然**完全相同（只有 user 变）");
    ok(p4.user !== p.user, "换世界后 user 确实不同（否则上一条是空的）");
    ok(p4.user.includes("RuRu----"), "L4 的 user 带上了 L4 目标");
    ok(!p4.user.includes("Cu----Cu"), "L4 的 user 不混入 L5 目标");

    /* 稳定：换诊断/候选/预算也不能动 S1 */
    const pv = buildPrompt(baseOpts({
        diagnoses: [{ code: "SLOT_STARVED", layer: "L2", subject: { handle: "C1" }, expected: { fed: true }, observed: { fed: false }, evidence: { handles: ["B1"] }, candidates: ["connect"] }],
        candidates: ["connect"],
        lastRound: { round: 1, actions: ["replace_run"], verdict: "fail" },
        budget: { rounds_left: 0, llm_calls_left: 0 },
    }));
    eq(pv.system, s1, "诊断/候选/上一轮/预算变化均不影响 system");
}

/* ═══════════════════ 2. 坐标：真实 L5 存档渲染后 0 命中 ═══════════════════ */

console.log("\n── 2. 坐标禁令（真实 L5 存档） ──");
{
    /* 造一份"最坏情况"的诊断：带 uid、带坐标形态的 expected/observed、带 handles */
    const diag = [{
        code: "SLOT_STARVED", layer: "L2", severity: "blocker",
        subject: { handle: "C1", uid: 10036, type: "cutter" },
        slot: { role: "left", index: 0, cell_ref: "B9" },
        expected: { fed: true, cell: [4, -13], note: "approach at (5,-13)" },
        observed: { fed: false, approach: "empty", at: [-8, -12] },
        evidence: { uids: [10143, 10144], handles: ["C1", "B12", "B13"], path_ids: [17] },
        candidates: ["connect", "trash_unused"],
        repairHints: ["upstream_belt_missing"],
    }, {
        code: "NO_PRODUCTION", layer: "L4", severity: "blocker",
        subject: { handle: "H1" },
        expected: { delivered: 170 }, observed: { delivered: 0, produced: 12 },
        evidence: { uids: [10000], handles: ["H1"] }, candidates: ["replace_run"],
    }];
    const p = buildPrompt(baseOpts({
        diagnoses: diag,
        lastRound: {
            round: 2,
            calls: [{ macro: "replace_run", args: { region: [4, -14, 5, -13] } }],
            verify: { checks: [{ name: "L1-landing", ok: true }, { name: "L3-flow", ok: false, degraded: true }], codes: ["FLOW_UNVERIFIED"] },
            decision: "continue",
        },
    }));

    const whole = p.system + "\n" + p.user;
    const m = whole.match(coordRegex()) || [];
    eq(m.length, 0, "渲染后的 prompt 里坐标正则 0 命中", { hits: m.slice(0, 5) });
    ok(!/\(5,-13\)/.test(whole), "诊断 expected 里的 (5,-13) 没有漏出去");
    ok(!/\(4,-13\)/.test(whole), "诊断里的 (4,-13) 没有漏出去");
    ok(!/\[4,-13\]/.test(whole), "上一轮 args 里的 region 没有漏出去（S5 只带宏名）");
    eq(p.blocks.redactions >= 2, true, `脱敏计数 > 0（实际 ${p.blocks.redactions}）—— 脱敏不是摆设`);
    ok(whole.includes("<coord>"), "被脱敏的位置留下 <coord> 标记（可审计，不是静默删除）");

    /* uid 也不许出现（契约 §Q3.2）；顺带避免 "0143, 1014" 这类假坐标 */
    ok(!/\b10143\b/.test(whole), "uid 10143 不在 prompt 里");
    ok(!/\b10036\b/.test(whole), "uid 10036 不在 prompt 里");

    /* 正例：不误伤合法数字 */
    ok(/RuRu|Cu----Cu/.test(p.user), "goal 形状串保留");
    ok(/required|delivered/.test(p.user), "计数保留");
}
{
    /* 句柄 desc 里塞坐标 —— 第一层（不搬运 x/y）挡不住，第二层（redactCoords）必须挡住 */
    const dirty = buildHandleTable(L5, L5_ITEMS, { describe: e => `${e.type} at (${e.x},${e.y}) uid=${e.uid}` });
    const p = buildPrompt(baseOpts({ handles: dirty, diagnoses: [] }));
    const hits = (p.system + "\n" + p.user).match(coordRegex()) || [];
    eq(hits.length, 0, "上游把坐标写进 desc 时，渲染层仍然 0 命中", { hits: hits.slice(0, 5) });
    ok(p.blocks.redactions > 0, `脱敏计数记录了上游的坐标违规（${p.blocks.redactions} 处）`);
    ok(p.blocks.redacted_uids > 0, `uid 也被摘掉并计数（${p.blocks.redacted_uids} 处）`);
    ok(!new RegExp(`\\b${L5.entities[0].uid}\\b`).test(p.user), "dirty desc 里的 uid 也没有漏出去");
    ok(!/\buid\s*[=:]\s*\d+/.test(p.user), "渲染后没有任何 uid=数字 残留");
}
{
    /* 把 L5 的**每个**实体逐个当 subject 渲染一遍：任何一格都不能带出坐标 */
    let worst = 0;
    for (const e of L5.entities.slice(0, 60)) {
        const handle = L5_TABLE.byUid.get(e.uid).handle;
        const p = buildPrompt(baseOpts({
            diagnoses: [{
                code: "LANDING_MISMATCH", layer: "L1", subject: { handle, uid: e.uid, type: e.type },
                expected: { x: e.x, y: e.y }, observed: { x: e.x + 1, y: e.y }, evidence: { handles: [handle] },
                candidates: ["replace_run"],
            }],
        }));
        const hits = (p.system + "\n" + p.user).match(coordRegex()) || [];
        if (hits.length > worst) worst = hits.length;
    }
    eq(worst, 0, "逐实体扫 60 条诊断，坐标命中最大值 === 0");
}

/* ═══════════════════ 3. S2 宏卡片 ═══════════════════ */

console.log("\n── 3. S2 宏卡片 ──");
{
    const p = buildPrompt(baseOpts());
    const s2 = p.blocks.S2;
    for (const n of ["replace_run", "connect", "trash_unused"]) {
        ok(s2.includes(`### ${n}`), `S2 有 ${n} 的卡片`);
        ok(s2.includes(MACRO_SPECS[n].summary.slice(0, 20)), `S2 的 ${n} 摘要来自 MACRO_SPECS（不是抄的）`);
        ok(s2.includes("not when:"), `S2 的 ${n} 带 whenNotToUse`);
        ok(s2.includes("example:"), `S2 的 ${n} 带调用例`);
    }
    ok(!s2.includes("### build_line"), "S2 没有 build_line 卡片");
    eq(s2.match(coordRegex()), null, "S2 文本本身不含坐标形态");

    /* 卡片里的宏名必须 ∈ MACRO_NAMES */
    const cardNames = [...s2.matchAll(/^### (\S+)$/gm)].map(m => m[1]);
    ok(cardNames.length === 3, `S2 恰好 3 张卡片（实际 ${cardNames.length}）`);
    ok(cardNames.every(n => MACRO_NAMES.includes(n)), "S2 每张卡片都 ∈ MACRO_NAMES", { cardNames });

    /* 例子用句柄，不用坐标 */
    ok(/\$ref|\$uids|\$bbox_of/.test(s2), "S2 的例子里有句柄算子");
    ok(!/\[\s*-?\d+\s*,\s*-?\d+\s*\]/.test(s2), "S2 的例子里没有数字坐标容器");
    ok(!/"(x|y|r|rv|rot)":/.test(s2), "S2 的例子里没有 x/y/r/rv/rot 键");
}
{
    /* 未知候选宏 → 抛（静默丢弃会让「检索表写错了」变成「模型就是没被提示」） */
    let thrown = null;
    try { buildPrompt(baseOpts({ candidates: ["replace_run", "build_line"] })); } catch (e) { thrown = e; }
    ok(!!thrown && /build_line/.test(thrown.message), "候选中出现 build_line → 直接抛并点名", { msg: thrown && thrown.message });
    let thrown2 = null;
    try { buildPrompt(baseOpts({ candidates: ["nope"] })); } catch (e) { thrown2 = e; }
    ok(!!thrown2, "候选中出现未知宏名 → 抛");
    /* 去重 + 接受 {macro} 形态 */
    const p = buildPrompt(baseOpts({ candidates: ["connect", { macro: "connect" }, { macro: "remove_run", why: "x" }] }));
    eq((p.blocks.S2.match(/^### /gm) || []).length, 2, "候选去重（含 {macro} 形态）");
    /* 空候选也不能崩，且要明确说"没有卡片，只能从白名单里选" */
    const pe = buildPrompt(baseOpts({ candidates: [] }));
    ok(/none retrieved/.test(pe.blocks.S2), "空候选给出明确提示，不静默输出空段");
}

/* ═══════════════════ 4. S3：goal / hub / 只列 ≤12 条带子 ═══════════════════ */

console.log("\n── 4. S3 goal + state ──");
{
    const p = buildPrompt(baseOpts());
    ok(p.blocks.s3_goal.includes("Cu----Cu"), "goal 形状在 S3");
    ok(/level 5/.test(p.blocks.s3_goal), "goal 等级在 S3");
    ok(/required 170/.test(p.blocks.s3_goal), "goal required 在 S3");
    ok(/delivered 0/.test(p.blocks.s3_goal), "goal delivered 在 S3");
    ok(/^## HUB\nH1 hub/.test(p.blocks.s3_hub), "hub 以句柄形式给出（不是坐标）");
    ok(p.blocks.s3_machines.includes("C1 cutter"), "机器表以句柄形式给出");
    ok(!/10036/.test(p.blocks.s3_machines), "机器表不含 uid");

    /* 只列 ≤12 条带子：L5 有 158 条 */
    const beltsInS3 = (p.blocks.s3_belts.match(/^B\d+ /gm) || []).length;
    ok(beltsInS3 <= PROMPT_RULES.STATE_BELTS_MAX, `带子列表 ≤ ${PROMPT_RULES.STATE_BELTS_MAX} 条（实际 ${beltsInS3}）`);
    ok(p.blocks.belts_total === 160, `L5 实际带子总数 160（实际 ${p.blocks.belts_total}）`);
    ok(/not shown/.test(p.blocks.s3_belts), "被省略的带子有明示，不静默丢弃");

    /* 诊断点名的带子**优先**进入列表（这是"与诊断相关"的可测口径）。
     *
     * ⚠️ 2026-10-30 修正：这条原来断言「诊断点名的就一定进」，
     * 但那是**旧优先级**（referenced 排在 byGoal 之前）下的行为。
     *
     * 实测发现那个顺序有害：P-a/P-b 接上真诊断后，诊断的 evidence.handles 里
     * 含大量**不在目标原料走廊上**的带子（这条测试自己用的 B150/B151/B152
     * 就是 L5 的铜线 x=-10..-7，而 L5 的目标链在 x=4），
     * 它们把正解三条从 3/3 挤到了 1/3。
     *
     * 现在的优先级是 **目标走廊 > 诊断点名 > 表顺序**。
     * 所以这条测试改成断言**真正该成立**的东西：
     *   ① 诊断点名的带子只要**不与走廊冲突**，仍然优先进入；
     *   ② 走廊优先时，正解可见性不受影响（由另一条测试守）。
     */
    const named = ["B150", "B151", "B152"].filter(h => L5_TABLE.byHandle.has(h));
    ok(named.length === 3, "夹具里的带子句柄存在", { named });
    const pd = buildPrompt(baseOpts({
        diagnoses: [{
            code: "FLOW_UNREACHABLE", layer: "L3", subject: { handle: "C1" },
            expected: { reach: true }, observed: { reach: false },
            evidence: { handles: ["C1", ...named] }, candidates: ["connect"],
        }],
    }));
    /* ① 诊断点名的带子被识别为 referenced（口径没变：诊断确实点名了它们）。
     *    `blocks.belts_referenced` 是**数量**不是数组（见 prompt.mjs:1352）。 */
    ok(pd.blocks.belts_referenced >= named.length,
        `诊断点名的 ${named.length} 条带子被识别为 referenced`, { referenced: pd.blocks.belts_referenced });
    /* ② 至少有一条点名的带子进了最终列表 —— 证明 referenced 仍然有优先级
     *    （不是被走廊完全压死；它们只是排在走廊之后） */
    const inList = named.filter(h => pd.blocks.s3_belts.includes(`${h} `));
    ok(inList.length >= 1,
        `诊断点名的带子里至少 1 条进入列表（证明 referenced 仍有优先级）`, { inList, named });
    eq(pd.blocks.belts_referenced, 3, "belts_referenced === 3");
    /* ★ 上限从「≤ 12」改成「≤ cap + diag reserve」★
     *
     * 2026-11-10 起诊断点名的带子**追加在 cap 之外**（见 pickBelts 的注释）：
     * 走廊吃满 cap，点名溢出到 `cap + STATE_BELTS_DIAG_RESERVE`。
     * 旧断言 `≤ 12` 会把这条新机制判成回归。真正要守的是「有硬上限，不会无限膨胀」。 */
    const capPlus = PROMPT_RULES.STATE_BELTS_MAX + PROMPT_RULES.STATE_BELTS_DIAG_RESERVE;
    ok((pd.blocks.s3_belts.match(/^B\d+ /gm) || []).length <= capPlus,
        `点名 + 补足合计仍 ≤ ${capPlus}（cap + diag reserve）`);
}
{
    /* 诊断点名的机器必须排进 20 台上限内。
       注意：L5 恰好只有 20 台机器，**装得下**，所以拿 L5 测这条是空转的
       （第一版就是这么写的，把排序删掉测试仍然绿）。这里造 25 台，点名排在最后的那台。 */
    const manyMachines = new Map();
    for (let i = 1; i <= 25; i++) {
        manyMachines.set(`C${i}`, { handle: `C${i}`, type: "cutter", variant: "default", desc: `cutter #${i}` });
    }
    manyMachines.set("H1", { handle: "H1", type: "hub", variant: "default", desc: "hub" });
    const named = "C25";
    const pm = buildPrompt(baseOpts({
        handles: { byHandle: manyMachines, hubHandle: "H1" },
        diagnoses: [{ code: "LANDING_MISMATCH", layer: "L1", subject: { handle: named }, expected: {}, observed: {}, candidates: ["replace_run"] }],
    }));
    ok(pm.blocks.s3_machines.includes(`${named} `), `25 台机器里，被点名的 ${named} 仍在表内（排到上限之外的不许是 subject）`);
    ok(!pm.blocks.s3_machines.includes("C24 "), `${named} 优先于未被点名的 C24（排序真的生效）`);
    const pmPlain = buildPrompt(baseOpts({ handles: { byHandle: manyMachines, hubHandle: "H1" }, diagnoses: [] }));
    ok(!pmPlain.blocks.s3_machines.includes(`${named} `), `无诊断时 ${named} 不在前 20（证明上一条不是恒真）`);

    /* production 摘要：给了就渲染，没给就明确说 unavailable（不许猜"在跑"） */
    /* desc 的两种真实形态都要能渲染，且**不许出现 `B7 belt B7 belt` 这种重复前缀**
       （handles.mjs 的 describeEntity 自带 `<handle> <type>` 前缀；直接拼会把句柄在一行里
       写两遍 —— 既费预算，又给模型多一个抄错句柄的来源）。
       这里的 desc 用 uid→handle 预表构造，**模拟 handles.mjs 的真实输出形态**，不是随手编的。 */
    const l4HandlesByUid = new Map([...L4_TABLE.byHandle.values()].map(e => [e.uid, e.handle]));
    const fullForm = buildHandleTable(L4, null, {
        describe: e => `${l4HandlesByUid.get(e.uid)} ${e.type} 上游=无 下游=无 货=0`,
    });
    const pf = buildPrompt(baseOpts({
        goal: L4.goal.requirement.shape, obs: L4, handles: fullForm, diagnoses: [], candidates: ["remove_run"],
    }));
    ok(!/^(B\d+) \w+ \1 /m.test(pf.blocks.s3_belts), "完整式 desc 的前缀被摘掉（不出现 `B1 belt B1 …`）");
    ok(/^B\d+ \w+ 上游=无/m.test(pf.blocks.s3_belts), "完整式 desc 的剩余部分保留");
    ok(!/^(H\d+) \w+ — \1 /m.test(pf.blocks.s3_hub), "hub 段同样不重复句柄");
    ok(/undefined/.test(pf.blocks.s3_belts) === false, "desc 里没有 undefined（夹具自身也没写错）");
    ok(/上游=无/.test(pf.blocks.s3_belts), "摘要按原样保留（摘掉的只是重复前缀）");
    /* ★ 走**显式参数** `production`，不是塞进 obs ★
       这里原来写的是 `obs: {...L5, production: {...}}` —— 而 loop 传的是 `ob.obs`，
       production 在 `ob.production`（另一个字段）。于是测试绿、实机永远 unavailable。
       完整回归见 prompt_production.test.mjs（含 loop→prompt 的接线用例）。 */
    const withProd = buildPrompt(baseOpts({
        production: { window_seconds: 60, produced_total: { "Cu----Cu": 12 }, delivered_per_sec: { "Cu----Cu": 0.2 } },
    }));
    ok(withProd.blocks.s3_production.includes("window_seconds: 60"), "production 窗口渲染");
    ok(withProd.blocks.s3_production.includes("produced Cu----Cu: 12"), "production 产出渲染");
    ok(withProd.blocks.s3_production.includes("rate Cu----Cu: 0.2"), "production 速率渲染");
    /* 负例：塞进 obs 不再生效 —— 钉住「不从 obs 里摸」，防止有人改回去 */
    const smuggled = buildPrompt(baseOpts({
        obs: { ...L5, production: { window_seconds: 60, produced_total: { "Cu----Cu": 12 } } },
    }));
    ok(/unavailable/.test(smuggled.blocks.s3_production),
        "把 production 塞进 obs 不生效（它是独立参数；否则「忘了传」又会被静默吞掉）");
    const noProd = buildPrompt(baseOpts());
    ok(/unavailable/.test(noProd.blocks.s3_production), "没有 production 时明说 unavailable");
}

/* ═══════════════════ 5. S4 / S5 ═══════════════════ */

console.log("\n── 5. S4 诊断 / S5 上一轮 ──");
{
    const p = buildPrompt(baseOpts());
    ok(/no diagnosis/.test(p.blocks.S4), "首轮无诊断时明说（不是空段）");
    ok(/this is round 1|none/.test(p.blocks.S5), "首轮 S5 明说 none");

    const pd = buildPrompt(baseOpts({
        diagnoses: [{
            code: "SLOT_STARVED", layer: "L2", severity: "blocker",
            subject: { handle: "C1", type: "cutter" }, slot: { role: "left", index: 0 },
            expected: { fed: true }, observed: { fed: false },
            evidence: { handles: ["B12", "B13"] }, candidates: ["connect", "trash_unused"],
        }],
        lastRound: {
            round: 2, calls: [{ macro: "replace_run" }, { macro: "connect" }],
            verify: { checks: [{ name: "L1-landing", ok: true }, { name: "L2-slots", ok: false }, { name: "L4-behavior", skipped: true }] },
            codes: ["SLOT_STARVED"], decision: "continue",
        },
    }));
    const s4 = pd.blocks.S4;
    ok(s4.includes("SLOT_STARVED"), "S4 带码");
    ok(s4.includes("C1") && s4.includes("@left[0]"), "S4 带 subject 与 slot");
    ok(/expected/.test(s4) && /observed/.test(s4), "S4 带 expected vs observed");
    ok(s4.includes("B12,B13"), "S4 带 evidence handles");
    ok(s4.includes("connect,trash_unused"), "S4 带 candidates");
    ok(!/10036/.test(s4), "S4 不带 uid");

    const s5 = pd.blocks.S5;
    ok(s5.includes("replace_run, connect"), "S5 带上一轮的宏名");
    ok(!/"args"/.test(s5), "S5 不带 args（否则模型会复读上一轮的错误）");
    ok(s5.includes("L1-landing ok") && s5.includes("L2-slots FAIL") && s5.includes("L4-behavior skipped"),
        "S5 带 check 名与三态（ok / FAIL / skipped）");
    ok(s5.includes("SLOT_STARVED"), "S5 带诊断码");
    ok(s5.includes("continue"), "S5 带 decision");
    /* S5 只带名字：诊断上百条也不能让 S5 膨胀 → 逐项上限 */
    const many = buildPrompt(baseOpts({
        lastRound: { round: 3, checks: Array.from({ length: 40 }, (_, i) => ({ name: `L${i}`, ok: i % 2 === 0 })),
            codes: Array.from({ length: 40 }, (_, i) => `CODE_${i}`) },
    }));
    ok((many.blocks.S5.match(/L\d+ (ok|FAIL|skipped)/g) || []).length <= 8, "S5 的 check 列表按 ≤8 截断");
    ok(many.blocks.S5.length < 900, `S5 有长度上界（实际 ${many.blocks.S5.length} 字符）`);
}

/* ═══════════════════ 6. 预算：只砍带子 ═══════════════════ */

console.log("\n── 6. 预算与截断 ──");
{
    const diag = [{
        code: "SLOT_STARVED", layer: "L2", subject: { handle: "C1" }, slot: { role: "left" },
        expected: { fed: true }, observed: { fed: false }, evidence: { handles: ["B12"] }, candidates: ["connect"],
    }];
    const full = buildPrompt(baseOpts({ diagnoses: diag, budget: { rounds_left: 3 } }));
    ok(full.blocks.trimmed_belts === 0, `默认预算下不截断（实际砍了 ${full.blocks.trimmed_belts}）`);
    /* 基线不再是硬编码的 12：诊断点名会溢出 cap（2026-11-10），
       所以用「至少 cap 条」而不是「恰好 12 条」。 */
    ok(full.blocks.belts_shown >= PROMPT_RULES.STATE_BELTS_MAX,
        `默认预算下至少 ${PROMPT_RULES.STATE_BELTS_MAX} 条带子（实际 ${full.blocks.belts_shown}）`);

    /* 压预算，逼它截断 */
    const tight = buildPrompt(baseOpts({
        diagnoses: diag,
        budget: { rounds_left: 3, prompt_tokens_max: Math.floor(full.blocks.chars / PROMPT_RULES.CHARS_PER_TOKEN) - 60 },
    }));
    ok(tight.blocks.trimmed_belts > 0, `压低预算后确实砍了带子（砍 ${tight.blocks.trimmed_belts} 条）`);
    ok(tight.blocks.belts_shown < full.blocks.belts_shown,
        `带子数下降（${tight.blocks.belts_shown}/${full.blocks.belts_shown}）`);

    /* 硬规矩：goal / hub / diagnosis / S1 **逐字节不变** */
    eq(tight.blocks.S1, full.blocks.S1, "截断后 S1 逐字节相同");
    eq(tight.blocks.s3_goal, full.blocks.s3_goal, "截断后 goal 段逐字节相同");
    eq(tight.blocks.s3_hub, full.blocks.s3_hub, "截断后 hub 段逐字节相同");
    eq(tight.blocks.s3_machines, full.blocks.s3_machines, "截断后机器表逐字节相同");
    eq(tight.blocks.S4, full.blocks.S4, "截断后诊断段逐字节相同");
    eq(tight.blocks.S2, full.blocks.S2, "截断后宏卡片逐字节相同");
    eq(tight.blocks.s3_production, full.blocks.s3_production, "截断后 production 段逐字节相同");
    eq(tight.blocks.S5, full.blocks.S5, "截断后上一轮摘要逐字节相同");
    eq(tight.blocks.S6, full.blocks.S6, "截断后指令段逐字节相同");
    /* ★ 配方段也必须逐字节不变 ★
     *
     * 这里原本没有这条断言 —— 而 truncation 循环里把 `goalAndRecipe` 误写成 `s3Goal`，
     * 于是**一旦触发截断，RECIPE 段就整个消失**。红队实测：字面的 13 条诊断下，
     * 模型再也看不到"这个形状该怎么造"，而那正是第五轮实验唯一起作用的信号。
     *
     * 截断的契约是「只动带子列表」。任何别的段（尤其配方）都必须逐字节不变。 */
    eq(tight.blocks.s3_recipe, full.blocks.s3_recipe, "★ 截断后配方段逐字节相同（曾经在这里丢过）");
    ok(tight.user.includes("## RECIPE"), "★ 截断后 user 里仍有 RECIPE 段");
    ok(tight.blocks.chars < full.blocks.chars, "总字符数确实下降");
    ok(tight.blocks.chars <= Math.floor((Math.floor(full.blocks.chars / PROMPT_RULES.CHARS_PER_TOKEN) - 60) * PROMPT_RULES.CHARS_PER_TOKEN),
        "压预算后总字符 ≤ 目标", { chars: tight.blocks.chars });
    /* 砍到底也不许丢 goal */
    ok(tight.user.includes("Cu----Cu") && tight.user.includes("required 170"), "极端预算下 goal 仍在");
}
{
    /* 砍到 0 条带子仍然超（诊断巨多）→ 必须抛，而不是继续截断别的段 */
    const manyDiag = Array.from({ length: 40 }, (_, i) => ({
        code: "SLOT_STARVED", layer: "L2", subject: { handle: "C" + (i + 1) },
        expected: { fed: true, detail: "a rather long expected description ".repeat(4) },
        observed: { fed: false, detail: "another rather long observed description ".repeat(4) },
        evidence: { handles: ["B12", "B13", "B14"] }, candidates: ["connect", "trash_unused"],
    }));
    let thrown = null;
    try { buildPrompt(baseOpts({ diagnoses: manyDiag, budget: { prompt_tokens_max: 500 } })); } catch (e) { thrown = e; }
    ok(!!thrown, "预算压到不可能满足时抛错（不静默截断 goal）");
    eq(thrown && thrown.code, "PROMPT_OVER_BUDGET", "抛的是 PROMPT_OVER_BUDGET");
    ok(thrown instanceof PromptOverBudget, "是 PromptOverBudget 实例");
    ok(thrown && thrown.detail && thrown.detail.sections && thrown.detail.sections.s3_goal > 0,
        "错误里带各段字符数（可定位是哪一段撑爆的）");

    /* 硬上限独立于 token 预算：in_chars_max 更低也必须抛 */
    let thrown2 = null;
    try { buildPrompt(baseOpts({ budget: { in_chars_max: 400 } })); } catch (e) { thrown2 = e; }
    ok(!!thrown2 && thrown2.code === "PROMPT_OVER_BUDGET", "in_chars_max 压低到 400 → 抛 PROMPT_OVER_BUDGET");
}

/* ═══════════════════ 7. 输入校验 ═══════════════════ */

console.log("\n── 7. 输入校验 ──");
{
    let t1 = null;
    try { buildPrompt({ goal: "RuRu----" }); } catch (e) { t1 = e; }
    ok(!!t1 && /obs/.test(t1.message), "缺 obs → TypeError 并点名 obs");
    let t2 = null;
    try { buildPrompt({ obs: L4 }); } catch (e) { t2 = e; }
    ok(!!t2 && /goal/.test(t2.message), "缺 goal → TypeError 并点名 goal");
    /* goal 允许对象形态 */
    const p = buildPrompt(baseOpts({ goal: { shape: "Cu----Cu", level: 5, required: 170, delivered: 3 } }));
    ok(p.blocks.s3_goal.includes("Cu----Cu") && p.blocks.s3_goal.includes("delivered 3"), "goal 对象形态可用");
    /* 句柄表：三种形态都能吃 */
    const asArray = [...L5_TABLE.byHandle.values()];
    const pa = buildPrompt(baseOpts({ handles: asArray }));
    eq(pa.blocks.s3_hub, buildPrompt(baseOpts()).blocks.s3_hub, "句柄表数组形态与 Map 形态渲染一致");
    const asUids = Object.fromEntries([...L5_TABLE.byHandle.entries()].map(([h, e]) => [h, e.uid]));
    const pu = buildPrompt(baseOpts({ handles: asUids }));
    ok(/^## HUB\nH1 hub/.test(pu.blocks.s3_hub), "句柄表 {handle: uid} 扁平形态可用（从 obs 补 type）");
    /* 没有 hub 句柄时不能编一个 */
    const noHub = new Map([...L5_TABLE.byHandle.entries()].filter(([, e]) => e.type !== "hub"));
    const pn = buildPrompt(baseOpts({ handles: { byHandle: noHub } }));
    ok(/no hub handle/.test(pn.blocks.s3_hub), "没有 hub 时明说，不编一个句柄");
}

/* ═══════════════════ 8. 输出可与 parseLlmPlan 对接 ═══════════════════ */

console.log("\n── 8. prompt 与 mock 夹具一致 ──");
{
    /* S6 要求的输出形态必须就是 parseLlmPlan 能吃的东西（否则 prompt 在教错格式） */
    const p = buildPrompt(baseOpts());
    const want = '{"say":"...","calls":[{"macro":"...","args":{...},"why":"..."}]}';
    ok(p.blocks.S6.includes(want), "S6 给出的示例与 parseLlmPlan 的输入形态一致");
    const sample = '{"say":"swap the run","calls":[{"macro":"replace_run","args":{"region":{"$bbox_of":["B1"]},"building":"belt"}}]}';
    ok(!hasCoords(sample), "合法的宏调用 JSON 本身不含坐标形态（否则 prompt 的自证是假的）");
}

/* ═══════════════════ 9. L4 冷启动：BELTS 段必须含正解要改的三条 ═══════════════════ */

/**
 * 这一节锁的是 PHASE2-ACCEPTANCE §E / P0-① 的核心缺口：
 *
 *   L4 冷启动有 163 条带子，正解要改的三条（`B69`/`B81`/`B82`，uid 10143/10209/10149）
 *   按句柄表顺序排第 69/81/82 位。以前"取前 12 条"⇒ **一条都看不到** ⇒ 真 LLM 结构上
 *   不可能产出 L4 的正解，而我们会误读成"模型能力不够"。
 *
 * 本节用 **prompt.test.mjs 自己的** `buildHandleTable`（不 import handles.mjs），
 * 所以它同时证明了一件重要的事：`pickBeltsForGoal` 的几何判据不依赖 handles.mjs 的
 * 任何字段（它只要求句柄表给出 `uid` —— 那是身份不是坐标）。
 */
console.log("\n── 9. L4 冷启动：BELTS 段含正解三条 ──");
{
    const L4_COLD = {
        goal: { shape: "RuRu----", level: 4, required: 70, delivered: 0 },
        obs: L4,
        handles: L4_TABLE,
        diagnoses: [],                       // 冷启动第一轮：没有诊断（真实情况只有一条 NO_PRODUCTION 点名 H1）
        candidates: ["replace_run"],
        lastRound: null,
        budget: {},
    };
    const render = (over = {}) => {
        const p = buildPrompt({ ...L4_COLD, ...over });
        return { p, text: p.system + "\n" + p.user };
    };

    const TARGETS = ["B69", "B81", "B82"];
    {
        const { p, text } = render();
        /* 三条必须都出现在 **BELTS 段**里（不是别处偶然出现的字符串）。 */
        const belts = p.blocks.s3_belts;
        for (const h of TARGETS) {
            ok(new RegExp(`^${h} `, "m").test(belts), `${h} 出现在 BELTS 段（L4 冷启动、无诊断）`);
        }
        /* 同一份渲染结果的整体坐标禁令 */
        const hits = text.match(coordRegex()) || [];
        eq(hits.length, 0, "同一份渲染里坐标正则 0 命中", { hits: hits.slice(0, 5) });
        ok(!/\b10143\b|\b10209\b|\b10149\b/.test(text), "目标带子的 uid 没有泄进 prompt");

        /* 并排的两条链必须**成对**给出：`replace_run` 的 region 是 `$bbox_of`，
           只给一列会让 bbox 覆盖到它没见过的格子。这里断言 x=4 / x=5 两列的
           同高度带子都在（`B81`↔`B82`、`B69`↔`B70`）。 */
        for (const [a, b] of [["B81", "B82"], ["B69", "B70"]]) {
            ok(new RegExp(`^${a} `, "m").test(belts) && new RegExp(`^${b} `, "m").test(belts),
                `并排两条 ${a}/${b} 同时出现（bbox 才覆盖得到整段）`);
        }
        ok(p.blocks.belts_shown === PROMPT_RULES.STATE_BELTS_MAX,
            `带子名额用满 ${PROMPT_RULES.STATE_BELTS_MAX} 条（实际 ${p.blocks.belts_shown}）`);
    }

    /* ── 对照：把 `pickBeltsForGoal` 的结果丢掉，退回"按句柄表顺序"——
       上面那条**必须失败**，否则这条测试是恒真的（比如 `B69` 恰好排在前 12 位）。 */
    {
        const total = [...L4_TABLE.byHandle.values()].filter(e => e.type === "belt" || e.type === "underground_belt");
        const byOrder = total.slice(0, PROMPT_RULES.STATE_BELTS_MAX).map(e => e.handle);
        const missing = TARGETS.filter(h => !byOrder.includes(h));
        eq(missing.length, 3,
            "对照：按句柄表顺序取前 12 条时，三条目标**一条都不在**（证明上一条不是恒真）", { byOrder });
    }

    /* ── 对照 2：让 `obs.entities` 缺席 → 几何判据整体失效 → 退回表顺序 → 目标消失。
       这条防的是"判据其实没起作用、只是恰好排上了"这类假绿。 */
    {
        const { p } = render({ obs: { ...L4, entities: [] } });
        const belts = p.blocks.s3_belts;
        const present = TARGETS.filter(h => new RegExp(`^${h} `, "m").test(belts));
        eq(present.length, 0,
            "对照：没有 obs.entities 时几何判据失效，三条目标一条都不出现（判据真的在起作用）", { present });
    }

    /* ── 反面：L5（另一张存档，目标 `Cu----Cu`）不能被 L4 的拓扑带歪。
       只要求"能正常渲染、坐标 0 命中、带子名额用满"，不要求任何具体句柄 ——
       L5 的正解是另一回事，把它写进来就是把测试变成第二份答案。 */
    {
        const p = buildPrompt(baseOpts());
        const hits = (p.system + "\n" + p.user).match(coordRegex()) || [];
        eq(hits.length, 0, "L5 渲染仍然坐标 0 命中");
        eq(p.blocks.belts_shown, PROMPT_RULES.STATE_BELTS_MAX, "L5 带子名额同样用满");
    }
}

/* ═══════════════════ 10. $path_of 必须进 S1 / S2（否则模型不知道它存在） ═══════════════════
 *
 * 第三轮实验 §15 的修法只有在**模型看得见**时才成立。两个必要条件：
 *   ① S1 的算子清单里有 `$path_of`，并且说清「链拐弯时用 path_of 而不是 bbox_of」；
 *   ② S2 的 `replace_run` 卡片示例本身就示范正确用法（模型最常照着示例抄）。
 * 另加一条不是本任务核心、但同源实证的修正：示例里 trash 的 port 必须是 cutter 的废料侧。
 */
console.log("\n── 10. $path_of 进 prompt ──");
{
    const p = buildPrompt(baseOpts());
    const s1 = p.system, s2 = p.blocks.S2;

    ok(s1.includes("$path_of"), "S1 的算子清单里列出 $path_of");
    ok(/\$path_of[\s\S]{0,200}EXACTLY the cells/.test(s1),
        "S1 说明了 $path_of 的语义（EXACTLY the cells，与外接矩形对比）");
    /* 「链拐弯时用 path_of 而不是 bbox_of」—— 这是任务书点名要写清的一句 */
    ok(/\$path_of,\s*NOT\s*\$bbox_of/i.test(s1),
        "★ S1 明确写了『用 $path_of，不要用 $bbox_of』（rule 11 的第一句）");
    ok(/bend|bends/i.test(s1) && /side by side|parallel/i.test(s1),
        "★ S1 点名了两个触发场景：链拐弯 / 两条并排");
    ok(/REJECTED/.test(s1) && /missing|hole|cells are not/i.test(s1),
        "S1 说明了非连续会被拒绝，且报错里会给出缺的格（模型据此拆段，不用猜）");
    /* 禁止清单仍然完整：新算子不能把「未知算子一律拒绝」这条冲掉 */
    ok(/Any other \$-operator/.test(s1), "S1 仍然明确『其它 $ 算子一律拒绝』");

    ok(s2.includes('"$path_of"'), "S2 的 replace_run 示例用 $path_of（示例即正确用法）");
    ok(s2.includes('"$path_of"') && !/region":\{"\$bbox_of"/.test(s2),
        "★ S2 的 region 示例**不再**示范 $bbox_of（避免模型抄错的那一半）");

    /* S2 的 trash port 示例必须与 `op-templates` 的 `wasteRoles` 一致。
     *
     * ⚠️ 这里**不硬编码 left / right**：2026-10-29 之前 `wasteRoles` 被写成了 `["right"]`，
     * 而这组测试跟着它一起断言 `right` —— 于是**错误的真值被测试锁住了**，
     * 两个模块（实现 + 测试）互相印证同一个错误，谁也没发现。
     * 后来实机证据（L4-COMPILER-DIAGNOSIS.md:460 / L4-E2E-RESULT 的 ejector 读数 /
     * L4-PLAN-A0 的落点）三方一致地指出废料是 **left**，这才暴露出来。
     *
     * 所以现在只断言「示例与真值同向」，方向由 op-templates 决定 —— 单点真值。
     */
    const { templateByBuildingVariant } = await import("../../ai/op-templates.mjs");
    const tpl = templateByBuildingVariant("cutter", "default");
    const waste = (tpl && Array.isArray(tpl.wasteRoles) && tpl.wasteRoles[0]) || null;
    ok(waste === "left" || waste === "right",
        "（前置）cutter 有唯一的 wasteRole", { waste });
    ok(new RegExp(`"trash",\\s*"port":\\s*"${waste}"`).test(s1 === null ? "" : s2),
        `★ S2 示例里 trash 的 port 与 op-templates.wasteRoles 同向（应为 "${waste}"）`,
        { waste, sample: s2.match(/trash[^}]*\}/)?.[0] });
    ok(s2.includes(`must use port "${waste}"`),
        `★ S2 的 legal values 与真值同向（应说 "${waste}"）`, s2.match(/legal values:.*$/m)?.[0]);
    ok(s2.includes(`"confirm_waste":true`) || s2.includes(`"confirm_waste": true`),
        "★ S2 示例带 confirm_waste:true（第六轮 #3 只差这一个字段）",
        s2.match(/trash[^}]*\}/)?.[0]);

    /* 最后：整份 prompt 仍然坐标 0 命中（新文字里不许夹带数字对） */
    const hits = (p.system + "\n" + p.user).match(coordRegex()) || [];
    eq(hits.length, 0, "加了 $path_of 说明后，整份 prompt 仍然坐标 0 命中", { hits: hits.slice(0, 5) });
}

/* ══════════════════════════════════════════════════════════════════════════
 * §R. 配方段（第五轮）：把 solver 的形状代数接进 prompt
 *
 * 第四轮真 LLM 实验：5 次里 4 次坚持要 rotater，而 `RuRu----` 只需要 cutter 切一半。
 * 模型在形状代数上瞎猜 —— 而正确配方 `proto/solver.mjs` 早就算得出来。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── §R. 配方段 —— 形状代数接进 prompt ──");
{
    const p = buildPrompt(baseOpts());
    const all = p.system + "\n" + p.user;

    ok(typeof p.blocks.s3_recipe === "string" && p.blocks.s3_recipe.length > 0,
        "★ blocks.s3_recipe 非空（solver 可用时必须有配方）", p.blocks.recipe_unavailable);
    ok(/## RECIPE/.test(all), "渲染文本里有 ## RECIPE 段");
    ok(!!p.blocks.s3_recipe && p.blocks.s3_recipe.includes(baseOpts().goal),
        "配方里含**本轮的**目标形状串（不是别的形状）", (p.blocks.s3_recipe || "").slice(0, 160));

    /* L5 的目标是 `Cu----Cu`，**等级门控后**的真配方是 mine → cut → rotate：
     * 它需要 cutter **和** rotater。
     *
     * ⚠️ 这里原来断言的是「不需要 rotater」—— 那句在**未门控**的旧配方下是真的
     * （旧配方是 cutQuad×2 + stack，不含 rotate 步），但那份配方本身是 bug：
     * cutQuad 要 L16、stacker 要 L10，而这是 L5 关卡。P-a 修了门控之后
     * （`recipeFor(…,{level:5})` 加 `--no-cutquad --no-stacker`），真解里**有** rotate 步。
     * 所以这里改成断言门控后的真值，而不是把错误配方锁进测试。
     *
     * 第四轮「模型坚持要 rotater」的教训仍然成立，只是它的正确修法不是「prompt 说不需要
     * rotater」，而是「prompt 说清**要不要**，由配方决定」—— 门控后的配方自己会说。 */
    ok(/does NOT need.*(stacker|painter)/.test(all),
        "★ 配方明确说「不需要」门控掉的那些机器（stacker/painter 在 L5 没解锁）",
        (p.blocks.s3_recipe || "").slice(0, 300));
    ok(/rotate/.test(p.blocks.s3_recipe || ""),
        "★ L5 门控后的真配方含 rotate 步（旧断言「不需要 rotater」锁的是未门控的错配方）",
        p.blocks.s3_recipe);
    ok(/cut/.test(p.blocks.s3_recipe || "") && /cutter/.test(p.blocks.s3_recipe || ""),
        "配方说清了要用 cutter 切", p.blocks.s3_recipe);
    ok(/rotater/.test(p.blocks.s3_recipe || ""),
        "★ 配方把 rotater 列进「需要的机器」（L5 真解需要它）", p.blocks.s3_recipe);
    ok(!/cutQuad/.test(p.blocks.s3_recipe || "") && !/stacker×/.test(p.blocks.s3_recipe || ""),
        "★ 配方里没有 L16 的 cutQuad / 没解锁的 stacker（等级门控生效）", p.blocks.s3_recipe);

    /* 另跑一次 L4（RuRu----）：同一套断言，证明配方随目标变而不是硬编码 */
    {
        const { buildPrompt: bp } = await import("./prompt.mjs");
        const l4obs = { ...L5, goal: { level: 4, requirement: { shape: "RuRu----", required: 70, delivered: 0 } } };
        const p4 = bp({ ...baseOpts(), goal: "RuRu----", obs: l4obs });
        ok(!!p4.blocks.s3_recipe && p4.blocks.s3_recipe.includes("RuRu----"),
            "换目标 RuRu---- ⇒ 配方跟着变（含 RuRu----）", (p4.blocks.s3_recipe || "").slice(0, 160));
        ok(/does NOT need.*rotater/.test(p4.blocks.s3_recipe || ""),
            "RuRu---- 也不需要 rotater（第四轮失败的直接对象）");
    }

    /* 顺序：GOAL 在 RECIPE 之前（配方是"这个目标怎么造"的一部分） */
    const iGoal = p.user.indexOf("## GOAL");
    const iRecipe = p.user.indexOf("## RECIPE");
    ok(iGoal >= 0 && iRecipe > iGoal, "RECIPE 紧跟在 GOAL 之后", { iGoal, iRecipe });

    /* 坐标仍必须 0 —— 配方是形状层面的，不含世界坐标 */
    ok(!coordRegex().test(p.blocks.s3_recipe || ""),
        "配方段里没有坐标形态", p.blocks.s3_recipe);
}

/* ══════════════════════════ THIS RUN（本次 run 的决策轨迹） ══════════════════════════
 *
 * 第 9 关实测的策略漂移：诊断明确说「红矿在 44 格外，这是支线工程」，
 * 模型第 4 轮的 say 原文是「... rather than building a far-off color branch first」——
 * 它知道那个选项、主动选择先做别的，然后下一轮完全忘了，又回头试同一件事。
 *
 * `## LAST ROUND` 只带上一轮，不带「我前几轮决定过什么」。这一段补的就是那个缺口。
 * ══════════════════════════════════════════════════════════════════════════════════ */

{
    const base = () => JSON.parse(fs.readFileSync(path.join(
        path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/saves/L4-obs.json"), "utf8")).result;
    const h4 = () => buildHandles(base(), null);
    const mk = (log) => buildPrompt({
        goal: "RuRu----", obs: base(), handles: h4(), diagnoses: [],
        candidates: ["connect"], budget: { prompt_tokens_max: 4600, in_chars_max: 16000 },
        runLog: log,
    });

    const log = [
        { round: 2, say: "place a mixer first, rather than building a far-off color branch", calls: ["insert_machine"], outcome: "constructive" },
        { round: 3, say: "connect B192 into C7 slot 1", calls: ["connect"], outcome: "regressive" },
    ];
    const p = mk(log);

    ok(p.user.includes("## THIS RUN"), "有 runLog 时必须出现 THIS RUN 段");
    ok(p.blocks.this_run_shown === true, "blocks.this_run_shown 必须为 true");
    /* 模型自己的话必须原样还给它 —— 那是「我决定过什么」的唯一来源 */
    ok(p.user.includes("rather than building a far-off color branch"),
        "上一轮 say 里那句「我先不做远处支线」必须被还回去");
    /* 意图与结果必须并排，否则看不出「说了要做 X、结果改坏了」 */
    ok(/r2 insert_machine → added stuff, no delivery/.test(p.user), "r2 的动作 + 结局");
    ok(/r3 connect → made it worse/.test(p.user), "r3 的结局必须是 made it worse");
    /* 收尾必须给出可执行的纪律，而不只是陈列 */
    ok(/Stay on one plan until it is DONE/.test(p.user), "必须给出「守着一个计划做到底」的指令");

    /* ★  优先于宏名 ★
     *
     * 只渲染宏名等于告诉模型「你用过 insert_machine」，而它需要的是
     * 「你刚把一台 miner 放在 blue ore 上」—— 后者才能指导下一步（去接它）。
     * 真机 r-20261112093135-cdeb：连着放 3 台矿机全成功，但 r4/r5 又回到盲目
     * insert_machine，因为它只看到「r3 insert_machine」。 */
    const withDetail = mk([{
        round: 2, say: "seed both pigments", calls: ["insert_machine", "insert_machine"],
        detail: ["miner on blue ore", "miner on red ore"], outcome: "constructive",
    }]);
    ok(withDetail.user.includes("miner on blue ore"), "★ detail 必须进 prompt（不只是宏名）");
    ok(withDetail.user.includes("miner on red ore"), "★ 两台都要写出来");
    ok(!/r2 insert_machine+insert_machine/.test(withDetail.user), "有 detail 时不再退回宏名串");
    /* 收尾那句要提醒「已放好的还在」—— 否则模型会重复放同一件东西 */
    ok(/Anything you already PLACED is still there/.test(withDetail.user), "必须提醒已放置的东西还在");
    /* 没有 runLog 时整段不出现，且不占预算 */
    const q = mk(null);
    ok(!q.user.includes("## THIS RUN"), "没有 runLog 时不许出现空段");
    ok(q.blocks.this_run_shown === false, "blocks.this_run_shown 必须为 false");

    /* 轮数上限：只列最近 4 轮。历史再长也不允许把预算吃光。 */
    const long = Array.from({ length: 9 }, (_, i) => ({
        round: i + 1, say: `step ${i + 1}`, calls: ["connect"], outcome: "inert",
    }));
    const l = mk(long);
    ok(l.blocks.this_run_rounds === 4, `最多渲染 4 轮（实际 ${l.blocks.this_run_rounds}）`);
    ok(!l.user.includes("r1 connect"), "最早那几轮不再渲染（只留最近的）");
    ok(l.user.includes("r9 connect"), "最近一轮必须在");

    /* `planned` 说明 tx 还没跑 —— 渲染成原样，不许伪装成已有结论 */
    const pending = mk([{ round: 1, say: "x", calls: ["connect"], outcome: "planned" }]);
    ok(/r1 connect → planned/.test(pending.user), "planned 状态必须如实显示");
}


/* ══════════════════════ STICKY GOAL（跨多轮的成因不许被忘掉） ══════════════════════
 *
 * 第 9 关实测：MIXER_UNFED 说「红矿 44 格外，要规划长支线」，但每轮 observe 都会
 * 重算出结构层的红点（BELT_HANDOFF_REJECTED / CHAIN_UNFED），模型连续 8 轮都在修
 * 它们、tx=5，一次都没往红矿那个方向走。
 *
 * 光把诊断置顶不够 —— 模型仍按「先修最红的」这条本能行事。这一段负责说清
 * 「它是长期目标、那些红点是它的下游」。
 * ══════════════════════════════════════════════════════════════════════════════════ */

{
    const base = () => JSON.parse(fs.readFileSync(path.join(
        path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/saves/L4-obs.json"), "utf8")).result;
    const mk = (sticky) => buildPrompt({
        goal: "RuRu----", obs: base(), handles: buildHandles(base(), null), diagnoses: [],
        candidates: ["connect"], budget: { prompt_tokens_max: 4600, in_chars_max: 16000 },
        stickyGoal: sticky,
    });

    const p = mk({ code: "MIXER_UNFED", since: 2, rounds: 3 });
    ok(p.user.includes("## STICKY GOAL"), "有粘性目标时必须出现该段");
    ok(p.blocks.sticky_goal_shown === true);
    ok(p.blocks.sticky_goal_code === "MIXER_UNFED");
    ok(/`MIXER_UNFED` has been present for 3 rounds/.test(p.user), "码与轮数都要写出");
    /* 最关键的一句：那些红点是**下游**，修它们没用 */
    ok(/are downstream of it/.test(p.user), "必须说清结构层红点是它的下游");
    ok(/Do not go back to patching the red spots/.test(p.user), "必须给出「别回头修红点」的纪律");
    /* 一轮做不完时的出路 —— 否则禁用「修红点」等于把模型逼死 */
    ok(/cannot be finished in one round/.test(p.user), "必须给「多轮推进」的许可");

    const q = mk(null);
    ok(!q.user.includes("## STICKY GOAL"), "没有粘性目标时不许出现空段");
    ok(q.blocks.sticky_goal_shown === false);
}

/* ═══════════════════ 汇总 ═══════════════════ */

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("\n失败项：");
    for (const f of failures) console.log("  · " + f);
    process.exitCode = 1;
}

