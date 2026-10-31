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

/* ═════════ ⑤ provenance 不能是伪证：改了坐标，标签必须跟着红 ═════════
 *
 * 这是本轮最重要的一条防线，值得单独一节。
 *
 * 实测漏洞（2026-10-28，loop.mjs 的实现者发现，主线程复核并修复）：
 *   `assertProvenance` 对 `macro:<token>` 标签**只校验 token 存在**，不校验 token 里
 *   嵌的 `@x,y` 与 op 的实际坐标是否一致。于是把 `place.x` 从 4 改成 5、
 *   标签仍写 `macro:replace_run:cutter@4,-13`，它**照样判绿**。
 *
 *   而 `macro:` 恰恰是主力宏（replace_run / insert_machine）**全部**用的标签形态。
 *   也就是说「每条落盘坐标可追溯」这条唯一的可证伪防线，对最重要的路径是空的 ——
 *   一个被篡改的计划可以带着一份「看起来完全合规」的 provenance 落盘。
 *
 * 修法：token 里的 `@x,y` 必须与 op 的实际 (x,y) 逐位相等。
 * 下面三条断言盯死它：原样绿、改 x 红、改 y 红。
 */
{
    const handles = [H.byUid.get(10209), H.byUid.get(10149), H.byUid.get(10143)];
    const text = JSON.stringify({
        calls: [{
            macro: "replace_run",
            args: { region: { $bbox_of: handles }, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        }],
    });
    const r = pipeline(text);
    ok(r.stops.length === 0 && r.txp, "provenance 防线：正确链路先跑通（否则下面的变异没有对照组）", r.stops);
    if (r.txp) {
        const clone = o => JSON.parse(JSON.stringify(o));
        const prov = t => assertProvenance(r.resolved.calls, t, OBS);

        ok(prov(r.txp).ok, "provenance 防线：原样 → 绿（对照组）");

        /* 改 x */
        {
            const m = clone(r.txp);
            const cut = m.ops.find(o => o.op === "place" && o.building === "cutter");
            ok(!!cut, "provenance 防线：找得到 cutter 的 place op", m.ops.map(o => o.building));
            if (cut) {
                cut.x = cut.x + 1;
                const v = prov(m);
                ok(!v.ok, "provenance 防线：把 cutter 的 x 加 1 → 必须红（否则标签是伪证）",
                    v.ok ? "仍然绿 —— 防线是空的" : v.violations.map(x => x.rule));
                ok(!v.ok && v.violations.some(x => x.rule === "COORD_PROVENANCE"),
                    "provenance 防线：红的规则是 COORD_PROVENANCE", v.ok ? null : v.violations.map(x => x.rule));
            }
        }

        /* 改 y */
        {
            const m = clone(r.txp);
            const cut = m.ops.find(o => o.op === "place" && o.building === "cutter");
            if (cut) {
                cut.y = cut.y - 1;
                ok(!prov(m).ok, "provenance 防线：把 cutter 的 y 减 1 → 必须红",
                    prov(m).ok ? "仍然绿" : null);
            }
        }

        /* 改另一台机器（trash）—— 防止「只保护第一个 place」 */
        {
            const m = clone(r.txp);
            const tra = m.ops.find(o => o.op === "place" && o.building === "trash");
            if (tra) {
                tra.x = tra.x + 5;
                ok(!prov(m).ok, "provenance 防线：改 trash 的坐标 → 必须红（防线不只管第一台机器）",
                    prov(m).ok ? "仍然绿" : null);
            }
        }

        /* 对照：完全不挂 provenance 也必须红（证明确实是这一层在起作用） */
        {
            const m = clone(r.txp);
            for (const op of m.ops) delete op.provenance;
            ok(!prov(m).ok, "provenance 防线：所有 op 都不挂 provenance → 必须红（MISSING_PROVENANCE）",
                prov(m).ok ? "仍然绿" : null);
        }
    }
}

/* ═════════ ⑥ $path_of → 真宏 → tx：一条拐弯的链不再被静默扩成矩形 ═════════
 *
 * 这里的每一条都对应第三轮真 LLM 实验的一个失败码（`EXPERIMENT-COLDSTART.md` §15）。
 * 关键不是「`$path_of` 能解析」，而是：**同一组句柄交给 `$bbox_of` 时，宏会拒绝**——
 * 没有这条对照，「新算子解决了问题」就没有对照组，测试会变成恒真的。
 */
{
    /* `B69/B81/B82` 是 L3 上游拐弯链段的三格：x=4 上 (4,-14)/(4,-13) + x=5 上 (5,-13)。
       外接矩形 2×2 会顺带框进 (5,-14) —— 那是**同高另一条链**的带子。 */
    const bend = [H.byUid.get(10209), H.byUid.get(10149), H.byUid.get(10143)];   // B81,B82,B69
    ok(bend.every(Boolean), "⑥ 夹具：拐弯链段的三个句柄都在", bend);

    /* ── ⑥a：`$path_of` 给不连续格集 → 在 coords 层停住，零写入 ── */
    {
        const text = JSON.stringify({
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B81", "B82"] }, building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            }],
        });
        const r = pipeline(text);
        ok(r.stops.length > 0, "⑥a 拐弯链的 $path_of → 流水线停住（不静默扩大）", r.stops);
        ok(r.stops[0] === "resolveRefs:PATH_NOT_RECT", "⑥a 停住的位置是 resolveRefs 的 PATH_NOT_RECT", r.stops);
        ok(!r.txp, "⑥a 被拦住的计划不产出 tx（零写入）");
        /* 半解析的调用不许留下：否则宏会拿到一个「少一格」的 region 继续跑 */
        ok(r.resolved && r.resolved.calls.length === 0, "⑥a 没有半解析的 call 继续往下走",
            r.resolved && r.resolved.calls);
    }

    /* ── ⑥b：对照组 —— 同一组句柄交给 `$bbox_of` 会走到宏，并**多删一条没被点名的带子** ──
       这条是「$path_of 真的修好了东西」的唯一证据。实测（本文件跑出来的真实结果，trash:right）：
         · `$bbox_of(["B69","B81","B82"])` → region `[4,-14,5,-13]`（2×2，含 (5,-14)）
         · `replace_run` 对它是 **ok:true** —— 但删掉的 3 条是 `[10149, 10150, 10209]`：
           其中 `10150` = `B70` @(5,-14) **从头到尾没被点名**，而被点名的 `10143` = `B69`
           反而被留了下来。
       也就是说 `$bbox_of` 的失败形态不一定是「宏拒绝」（那要看多出来那一格上是谁）：
       这里宏接受了，却静默地动了模型没指的东西 —— 比拒绝更糟，因为**没有任何信号**。
       （实验记录里的 #1/#3/#5 是同一个病在不同格子上的三种表现：occupied / not_a_run /
       precondition_failed；本夹具恰好落在「成功但换了对象」这一支上。） */
    {
        const text = JSON.stringify({
            calls: [{
                macro: "replace_run",
                args: { region: { $bbox_of: ["B69", "B81", "B82"] }, building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            }],
        });
        const r = pipeline(text);
        ok(r.resolved && r.resolved.ok, "⑥b（对照）$bbox_of 版本能过 coords 层（说明差别不在这一层）",
            r.resolved && r.resolved.violations);
        ok(r.resolved && JSON.stringify(r.resolved.calls[0].args.region) === JSON.stringify([4, -14, 5, -13]),
            "⑥b（对照）$bbox_of 产出 2×2 矩形（覆盖了没被点名的 (5,-14)）",
            r.resolved && r.resolved.calls[0].args.region);
        ok(r.stops.length === 0 && r.txp && r.txp.ok,
            "⑥b（对照）宏**接受了**它 —— 失败是静默的，没有任何拒绝信号", r.stops);
        const named = [10209, 10149, 10143];               // 模型点名的三格：B81/B82/B69
        const destroyed = (r.txp && r.txp.destroys) || [];
        ok(destroyed.includes(10150),
            "★★ ⑥b（对照）$bbox_of 把一个**没被点名**的实体删了（B70 @(5,-14)，uid 10150）",
            { destroyed, named });
        ok(!named.includes(10150), "★★ ⑥b（对照）10150 确实不在输入句柄里 —— 这就是『静默扩大』的实证",
            { named });
        ok(named.includes(10143) && !destroyed.includes(10143),
            "★★ ⑥b（对照）更糟：**被点名的 B69 反而没动**，动的是它旁边没被点名的 —— 选区换了对象",
            { destroyed, named });
    }

    /* ── ⑥b'：`$path_of` 对**完全同一组句柄**绝不会删到选区外的实体 ──
       与 ⑥b 并排读：同一个输入，一个多删一条，一个连解析都不过。
       （`$path_of` 不连续的版本见 ⑥a —— 它直接拒绝，所以更谈不上误删。） */
    {
        const text = JSON.stringify({
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B81", "B82"] }, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
            }],
        });
        const r = pipeline(text);
        ok(!r.txp, "⑥b' $path_of 版本没有任何写入（先停住，再谈精确）");
        const c = r.resolved;
        ok(c && c.calls.length === 0,
            "⑥b' 没有任何 call 带着 region 走到宏（因此不可能删到选区外）", c && c.calls);
    }

    /* ── ⑥c：把链段选成**恰好填满**的 2×2 → 新算子放行，宏真的能跑通 ──
       `B69/B70/B81/B82` = (4,-14)/(5,-14)/(4,-13)/(5,-13) 恰好填满 2×2。
       这证明 `$path_of` 的判据是「填满矩形」而不是「必须同一条链」——后者会让唯一正解无法表达。 */
    {
        const text = JSON.stringify({
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B70", "B81", "B82"] }, building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            }],
        });
        const r = pipeline(text);
        ok(r.stops.length === 0, "⑥c 恰好填满的 2×2 → 整条链跑通", r.stops);
        ok(r.txp && r.txp.ok, "⑥c 产出 tx plan", r.txp && r.txp.error);
        ok(r.txp && r.txp.ops.length === 5, "⑥c ops 恰好 5 条（3 delete + 2 place）", r.txp && r.txp.ops.length);
        /* ★ 核心：删的必须是 region 里那 4 条中的 3 条，**不多不少** ★
           第 4 条（(5,-14)，即 B70）被 cutter 的机身占到，所以它也在删除清单里；
           真正的断言是「没有任何 region 之外的 uid 被删」。 */
        const regionUids = [10143, 10150, 10209, 10149].sort((a, b) => a - b);
        const destroyed = r.txp && r.txp.destroys.slice().sort((a, b) => a - b);
        ok(destroyed.every(u => regionUids.includes(u)),
            "⑥c 被删的 uid 全部落在 $path_of 指的 4 格里（没有扩到选区外）", { destroyed, regionUids });
        ok(r.prov && r.prov.ok, "⑥c 溯源全绿", r.prov && r.prov.violations);
        const tags = r.resolved.calls.flatMap(c => Object.values(c.provenance || {}));
        ok(tags.some(t => typeof t === "string" && t.startsWith("computed:path_of[")),
            "⑥c region 的出处是 computed:path_of[…]", tags);
    }

    /* ── ⑥d：溯源不能是伪证 —— 把 region 改宽一格，必须红 ── */
    {
        const text = JSON.stringify({
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B70", "B81", "B82"] }, building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            }],
        });
        const r = pipeline(text);
        ok(r.stops.length === 0 && r.txp, "⑥d（前置）正确链路先跑通", r.stops);
        if (r.txp) {
            const clone = o => JSON.parse(JSON.stringify(o));
            const prov = t => assertProvenance(r.resolved.calls, t, OBS);
            ok(prov(r.txp).ok, "⑥d 原样 → 绿（对照组）");

            const m = clone(r.txp);
            const cut = m.ops.find(o => o.op === "place" && o.building === "cutter");
            ok(!!cut, "⑥d 找得到 cutter 的 place op");
            if (cut) {
                cut.x += 1;
                const v = prov(m);
                ok(!v.ok && v.violations.some(x => x.rule === "COORD_PROVENANCE"),
                    "⑥d 把 cutter 的 x 加 1 → 必须红（path_of 标签不是伪证）", v.ok ? "仍然绿" : v.violations);
            }
        }
    }
}

/* ═════════ ⑦ 诊断码接线：PATH_NOT_RECT 是独立码，且从 plan 入口能观察到 ═════════ */
{
    const { buildTxPlan } = await import("./loop.mjs");
    const { DIAG_CODES } = await import("./loop/constants.mjs");
    ok(Object.prototype.hasOwnProperty.call(DIAG_CODES, "PATH_NOT_RECT"),
        "⑦ PATH_NOT_RECT 在 DIAG_CODES 闭集里（不是自造码）");
    ok(DIAG_CODES.PATH_NOT_RECT !== DIAG_CODES.LLM_COORD, "⑦ 它与 LLM_COORD 是两条不同的说明");

    const r = buildTxPlan({
        calls: [{
            macro: "replace_run",
            args: { region: { $path_of: ["B69", "B112"] }, building: "belt" },
        }],
    }, OBS, ITEMS, H);
    ok(r.ok === false, "⑦ 不连续选区 ⇒ plan 拒绝", r.ok);
    ok(r.code === "PATH_NOT_RECT", "⑦ 拒绝码是 PATH_NOT_RECT（不是 LLM_COORD / MACRO_REFUSED）", r.code);
    ok(!r.txPlan, "⑦ 被拒时没有 txPlan（零写入）");
    ok(Array.isArray(r.diagnosis.candidates) && r.diagnosis.candidates.includes("replace_run"),
        "⑦ 候选里保留 replace_run（它选的宏是对的，只是选区要拆小）", r.diagnosis.candidates);
    ok(/拆|split|空洞/.test(r.diagnosis.hint || ""),
        "⑦ hint 说的是「拆成更小的连续段」，不是「坐标只能来自算子」", r.diagnosis.hint);
}

/* ═════════ 汇总 ═════════ */
console.log(`\nloop_pipeline 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
