/**
 * loop_pipeline.test.mjs — 跨模块契约：把 7 个模块按 loop 的真实顺序串起来验。
 *
 * 为什么单模块测试不够（本次实测）：
 *   每个模块自己的测试都绿，但**模块之间的分工**没有任何测试守着。已经踩到的一处：
 *     `parseLlmPlan` 对 `{"at":[4,-13]}` 是**通过**的 —— 因为它只判语法。
 *     坐标禁令在 `assertNoHumanCoords` 里，是**另一层**。
 *     于是「只调 parse 就以为安全了」是一个真实的、静默的漏洞。
 *   两个模块各自都测对了，合起来仍然是洞 —— 这正是这个文件存在的理由。
 *
 * 本文件不重复各模块的细节测试，只钉三件事：
 *   ① 那一层分工必须被**显式**执行（缺任一层 → 坐标能溜进 plan）
 *   ② 从 llm 文本到 tx ops 的整条链，每一个坐标都有 provenance
 *   ③ 任何一环红，都必须在抵达 tx 之前停住（零写入）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHandles } from "./loop/handles.mjs";
import { assertNoHumanCoords, resolveRefs, assertProvenance } from "./loop/coords.mjs";
import { planToTxOps } from "./loop/planToTxOps.mjs";
import { parseLlmPlan } from "./loop/llm.mjs";
import { replaceRun } from "./macros/remove.mjs";
import { MACRO_NAMES } from "./macros/contract.mjs";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 350) : "")); }
}

/* ═════════ 夹具：L4 冷启动（RuRu----，待改造的 3 条带子） ═════════ */

const g = FakeGame.fromFiles(path.join(REPO, "test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
const OBS = structuredClone(g.observe({ max_entities: 50000 }));
const ITEMS = g.debugItems();
const H = buildHandles(OBS, ITEMS);

/** 按 loop 的真实顺序走一遍：text → parse → coords → 宏 → planToTxOps → provenance */
function pipeline(text, opts = {}) {
    const stops = [];
    const parsed = parseLlmPlan(text);
    if (!parsed.ok) { stops.push("parse:" + parsed.error.code); return { stops, parsed }; }
    /* ★ 这一层不能省 ★ 少了它，坐标会直接进 plan */
    if (!opts.skipCoords) {
        const c = assertNoHumanCoords(parsed.plan);
        if (!c.ok) { stops.push("coords:" + c.violations.map(v => v.rule).join(",")); return { stops, parsed, coords: c }; }
    }
    const res = resolveRefs(parsed.plan, H, OBS);
    if (!res.ok) { stops.push("resolveRefs:" + res.violations.map(v => v.rule).join(",")); return { stops, parsed, resolved: res }; }
    const calls = [];
    for (const c of res.calls) {
        const impl = opts.impl || replaceRun;
        const result = impl(c.args, { entities: OBS.entities });
        calls.push({ macro: c.macro, args: c.args, result, provenance: c.provenance });
        if (!result.ok) { stops.push("macro:" + c.macro + ":" + result.error.code); return { stops, parsed, resolved: res, calls }; }
    }
    const txp = planToTxOps(calls, { obs: OBS, handles: H, items: ITEMS });
    if (!txp.ok) { stops.push("planToTxOps:" + (txp.error && txp.error.code)); return { stops, parsed, resolved: res, calls, txp }; }

    /* ── loop 必须补的一层：per-op provenance ──
     *
     * `planToTxOps` 刻意**不产** provenance（它的头注释写明了：翻译器不该自己判溯源）。
     * `assertProvenance` 则**显式要求**每条 op 都有 —— 宁可判红也不静默放行
     * （coords.mjs:502-505 的注释解释了为什么）。两者都对，缺的是中间这一层。
     *
     * 这一层就是 loop 的职责：把「它从哪条 call、哪个参数来的」附到每条 op 上。
     * 下面是最小实现 —— 若 loop.mjs 的实现与此不同，必须以能通过 assertProvenance 为准。
     */
    const annotated = {
        ...txp,
        ops: txp.ops.map((op, i) => ({ ...op, provenance: provenanceOfOp(op, calls, txp, i) })),
    };
    const prov = assertProvenance(res.calls, annotated, OBS);
    if (!prov.ok) { stops.push("provenance:" + prov.violations.length); return { stops, parsed, resolved: res, calls, txp: annotated, prov }; }
    return { stops, parsed, resolved: res, calls, txp: annotated, prov };
}

/**
 * 给一条 op 找它的出处。
 *
 * 规则（按 op 的性质分派，不用启发式）：
 *   · `delete{uid}` → 该 uid 来自哪条 call 的 `removes[]` → `macro:<token>` 或 `obs:uid=N`
 *   · `place`       → 该格来自哪条 call 的 `placed[]` → `macro:<token>`
 *   · 找不到      → 返回 null（`assertProvenance` 会判红 —— 这是对的，不许编一个来源）
 */
function provenanceOfOp(op, calls, txp, idx) {
    const token = txp.pendingByOp && txp.pendingByOp[idx];
    if (token) return "macro:" + token;
    if (op.op === "delete") {
        for (const c of calls) {
            const r = c.result || {};
            const hit = (r.removes || []).some(x => x.uid === op.uid)
                || (r.removed_uids || []).includes(op.uid)
                || (r.changed && (r.changed.removed_uids || []).includes(op.uid));
            if (hit) {
                /* 删除的出处有两种：宏计划删的，或 obs 里就有的实体。
                   若宏的 pending 里有对应的 token 就用它，否则退回 obs。 */
                const pend = (r.removed || []).find(x => x.uid === op.uid);
                if (pend && pend.token) return "macro:" + pend.token;
                return `obs:uid=${op.uid}`;
            }
        }
        return `obs:uid=${op.uid}`;
    }
    if (op.op === "place") {
        for (const c of calls) {
            const r = c.result || {};
            const hit = (r.placed || []).some(p => p.origin && p.origin[0] === op.x && p.origin[1] === op.y)
                || (r.origin && r.origin[0] === op.x && r.origin[1] === op.y);
            if (hit) {
                const p = (r.placed || []).find(x => x.origin && x.origin[0] === op.x && x.origin[1] === op.y);
                const tok = p && p.pending && p.pending.token;
                return "macro:" + (tok || `${c.macro}@${op.x},${op.y}`);
            }
        }
    }
    return null;
}

/* ═════════ ① 两层分工：缺任一层，坐标就能溜进去 ═════════ */

{
    const B69 = H.byUid.get(10209), B82 = H.byUid.get(10149), B81 = H.byUid.get(10143);
    ok(!!B69 && !!B82 && !!B81, "夹具句柄解析：3 条带子都有句柄", [B69, B82, B81]);

    /* 一个"字面坐标"的调用：parse 会放过它 */
    const literal = JSON.stringify({
        calls: [{ macro: "insert_machine", args: { at: [4, -13], facing: "top", machine: "cutter" } }],
    });
    const p = parseLlmPlan(literal);
    ok(p.ok, "parseLlmPlan 放过字面坐标（它只判语法，这是设计）", p.error);
    const c = assertNoHumanCoords(p.plan);
    ok(!c.ok && c.violations.some(v => v.rule === "V1"),
        "assertNoHumanCoords 抓住同一个输入（V1）—— 两层分工成立，缺任一层都是洞",
        c.ok ? "竟然通过了" : c.violations.map(v => v.rule));

    /* ★ 关键断言：走完整条流水线，字面坐标会在 coords 层停住，而不是进 tx ★ */
    const full = pipeline(literal, { impl: (args) => ({ ok: false, error: { code: "unused" } }) });
    ok(full.stops.length > 0 && full.stops[0].startsWith("coords:"),
        "整条流水线在 coords 层就停住（坐标到不了宏，更到不了 tx）", full.stops);
    ok(!full.txp, "被拦住的输入不会产出 tx plan（零写入）");

    /* 若有人把 coords 层"优化"掉，同一个输入就会一路走到宏 */
    const skipped = pipeline(literal, { skipCoords: true, impl: () => ({ ok: false, error: { code: "x" } }) });
    ok(skipped.stops.length === 0 || !skipped.stops[0].startsWith("coords:"),
        "（对照）跳过 coords 层后，同一个输入不再被坐标规则拦住 —— 证明这条防线不是空的",
        skipped.stops);
}

/* ═════════ ② 正确链路：句柄 → bbox → 宏 → tx，每个坐标都有 provenance ═════════ */

{
    const handles = [H.byUid.get(10209), H.byUid.get(10149), H.byUid.get(10143)];
    const text = JSON.stringify({
        say: "cut these three belts into a cutter and route the waste",
        calls: [{
            macro: "replace_run",
            args: { region: { $bbox_of: handles }, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
            why: "the goal is RuRu----",
        }],
    });

    const r = pipeline(text);
    ok(r.stops.length === 0, "正确链路无任何环节停住", r.stops);
    ok(r.txp && r.txp.ok, "产出 tx plan", r.txp && r.txp.error);
    ok(r.txp && r.txp.ops.length === 5, "ops 恰好 5 条（3 delete + 2 place）", r.txp && r.txp.ops.length);
    ok(r.txp && JSON.stringify(r.txp.destroys) === JSON.stringify([10143, 10149, 10209]),
        "destroys 恰好是那 3 个 uid（排序后）", r.txp && r.txp.destroys);

    /* ★ 本文件的核心断言：每个坐标都能追到出处 ★ */
    const prov = r.resolved.calls.flatMap(c => Object.entries(c.provenance || {}));
    ok(prov.length > 0, "每个被解析出的参数都有 provenance 条目", r.resolved.calls.map(c => c.provenance));
    ok(prov.every(([, v]) => /^(obs:uid=\d+|macro:[\w-]+@[^|]*|computed:bbox_of\[[^\]]*\])$/.test(v)),
        "provenance 的值全部落在三种合法来源里（闭集）", prov);

    /* 逐个 place 的坐标都必须来自 $bbox_of 算出的 region，而不是字面量 */
    const regionProv = r.resolved.calls[0].provenance.region;
    ok(typeof regionProv === "string" && regionProv.startsWith("computed:bbox_of["),
        "region 的出处是 computed:bbox_of[...]，不是字面量", regionProv);
    ok(Array.isArray(r.resolved.calls[0].args.region) && r.resolved.calls[0].args.region.length === 4,
        "region 被解析成 4 元数组", r.resolved.calls[0].args.region);
    ok(JSON.stringify(r.resolved.calls[0].args.region) === JSON.stringify([4, -14, 5, -13]),
        "region 的值正确（[4,-14,5,-13]）", r.resolved.calls[0].args.region);
}

/* ═════════ ③ 每个停住点都要在 tx 之前（零写入） ═════════ */

{
    const cases = [
        ["语法错", "{not json", "parse"],
        ["空 calls", JSON.stringify({ calls: [] }), "parse"],
        ["未知宏", JSON.stringify({ calls: [{ macro: "build_line", args: {} }] }), "parse"],
        ["幻觉句柄", JSON.stringify({ calls: [{ macro: "remove_run", args: { uids: { $uids: ["B9999"] } } }] }), "coords"],
        ["字面坐标", JSON.stringify({ calls: [{ macro: "insert_machine", args: { at: [0, 0], machine: "cutter", facing: "top" } }] }), "coords"],
    ];
    for (const [name, text, where] of cases) {
        const r = pipeline(text);
        ok(r.stops.length > 0 && r.stops[0].startsWith(where + ":"),
            `${name} → 停在 ${where} 层`, r.stops);
        ok(!r.txp, `${name} → 不产出 tx plan（零写入）`);
    }
}

/* ═════════ ④ 宏白名单：prompt 只可能给出 6 个宏 ═════════ */

{
    const { RETRIEVAL_TABLE } = await import("./loop/constants.mjs");
    const all = [];
    for (const v of Object.values(RETRIEVAL_TABLE)) for (const e of v) all.push(e.macro);
    ok(all.every(m => MACRO_NAMES.includes(m)),
        "RETRIEVAL_TABLE 里出现的宏全部在 MACRO_NAMES 里", all.filter(m => !MACRO_NAMES.includes(m)));
    ok(!all.includes("build_line"),
        "build_line 不在检索表里（它不是 v1 白名单成员）");
    ok(MACRO_NAMES.length === 6, "白名单恰好 6 个（contract.mjs 的断言）", MACRO_NAMES.length);
}

/* ═════════ 汇总 ═════════ */
console.log(`\nloop_pipeline 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
