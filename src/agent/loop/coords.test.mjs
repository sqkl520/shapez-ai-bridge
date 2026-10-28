/**
 * loop/coords.test.mjs — 「LLM 不算坐标」三道关口的自测。
 *
 * 判据（任务书点名 + 契约 §2.3/§2.5）：
 *   · `assertNoHumanCoords` 对 **5 种违规各一条**（V1/V2/V3/V4/V5），加 V6 与「合法为绿」；
 *   · `resolveRefs` 对 **L4 冷启动的正确调用**（`replace_run` + `$bbox_of`）必须绿；
 *   · `assertProvenance` 在**变异测试**下必须红（把任一个 cell 的 x 加 1）。
 *
 * 关键不是「能过」，而是「反着写一定红」：每一条正向断言后面都跟一条负例。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    COORD_SOURCES, PROVENANCE_RE, COORD_TEXT_RE, COORD_KEYS,
    assertNoHumanCoords, resolveRefs, assertProvenance, getPath,
} from "./coords.mjs";
import { buildHandles, bboxOf } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");

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
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 500) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });
const jEq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, { got, want });

const read = f => {
    const raw = JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8"));
    return raw.result || raw;
};
const l4 = read("L4-obs.json");
const t4 = buildHandles(l4, null);

/* 「这 3 条带子」—— 阶段 2 唯一需要的外部输入（`coldstart_l4.test.mjs` 的 WANT_UIDS） */
const WANT_UIDS = [10143, 10209, 10149];
const H = WANT_UIDS.map(u => t4.byUid.get(u));
ok(H.every(Boolean), "L4 的三个 uid 都拿到了句柄", H);

/* ═══════════ 0. 常量 ═══════════ */

{
    ok(Object.isFrozen(COORD_SOURCES), "COORD_SOURCES 冻结");
    jEq(COORD_SOURCES, {
        OBS_REF: "$ref", OBS_REFS: "$uids", DERIVED_BBOX: "$bbox_of", DERIVED_PATH: "$path_of",
    }, "COORD_SOURCES 只有四种算子（唯一闭集）");
    ok(COORD_KEYS.includes("at") && COORD_KEYS.includes("region"), "V3 键清单含 at/region");
    ok(!COORD_KEYS.includes("len"), "V3 键清单**不含** len（len 是格数，不是坐标）");
    ok(!COORD_KEYS.includes("max_cells"), "V3 键清单不含 max_cells");
    /* 不带 global：带 g 的正则有 lastIndex 状态，跨调用会漏判 */
    eq(COORD_TEXT_RE.global, false, "坐标正则不带 g（无 lastIndex 状态）");
    /* 正则真的能抓（负例）：这是「后续所有 V4 断言非空转」的前提 */
    ok(COORD_TEXT_RE.test("(4,-13)") && COORD_TEXT_RE.test("4, -13") && COORD_TEXT_RE.test("( -13 , 5 )"),
        "V4 正则能抓三种写法");
}

/* ═══════════ 1. assertNoHumanCoords —— 正例 ═══════════ */

{
    const good = {
        say: "把那段带子换成切割机，右边接垃圾桶",
        calls: [{
            macro: "replace_run",
            args: { region: { $bbox_of: [H[0], H[1], H[2]] }, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
            why: "目标形状要求半切，右侧是废料",
        }],
    };
    const r = assertNoHumanCoords(good, t4);
    ok(r.ok, "正例：L4 正确计划（$bbox_of + 句柄）判绿", r.violations);
    eq(r.violations.length, 0, "正例无 violation");
    ok(r.rulesRun.includes("V5"), "给了 handles → V5 也跑了");

    /* `$ref` / `$uids` 形态也绿 */
    const good2 = {
        calls: [
            { macro: "trash_unused", args: { outlet: { $ref: H[0], port: "left" }, opts: { confirm_waste: true } } },
            { macro: "remove_run", args: { uids: { $uids: [H[1], H[2]] } } },
        ],
    };
    ok(assertNoHumanCoords(good2, t4).ok, "正例：$ref + $uids 判绿", assertNoHumanCoords(good2, t4).violations);

    /* `len:4` / `max_cells:2000` 是计数，不是坐标 —— 必须绿（V3 的边界） */
    const good3 = {
        calls: [
            { macro: "extend_line", args: { from: { $ref: H[0] }, len: 4 } },
            { macro: "connect", args: { from: { $ref: H[0] }, to: { $ref: H[1] }, opts: { max_cells: 2000 } } },
        ],
    };
    ok(assertNoHumanCoords(good3, t4).ok, "正例：len/max_cells 是计数不判红", assertNoHumanCoords(good3, t4).violations);

    /* 不带 handles 时 V5 跳过（说清楚，不假装检过） */
    const noV5 = assertNoHumanCoords(good, null);
    ok(noV5.ok && noV5.rulesSkipped.includes("V5"), "不给 handles → V5 标记为 skipped（不假绿）");
}

/* ═══════════ 2. 五种违规各一条（任务书点名）+ V6 ═══════════ */

{
    /* V1：字面 [int,int] */
    const v1 = assertNoHumanCoords({
        calls: [{ macro: "insert_machine", args: { at: [4, -13], facing: "top", machine: "cutter" } }],
    }, t4);
    ok(!v1.ok && v1.violations.some(x => x.rule === "V1"),
        "负例 V1：at:[4,-13] 字面坐标 → 红", v1.violations);
    eq(v1.violations.find(x => x.rule === "V1").path, "calls[0].args.at", "V1 的 path 定位到 args.at");

    /* V2：字面 bbox [int,int,int,int] */
    const v2 = assertNoHumanCoords({
        calls: [{ macro: "replace_run", args: { region: [4, -14, 5, -13], building: "belt" } }],
    }, t4);
    ok(!v2.ok && v2.violations.some(x => x.rule === "V2"),
        "负例 V2：region:[4,-14,5,-13] 字面 bbox → 红", v2.violations);

    /* V3：键名在清单内且值是数字 */
    const v3 = assertNoHumanCoords({
        calls: [{ macro: "insert_machine", args: { at: { cell: [4, -13] }, x: 5, machine: "cutter" } }],
    }, t4);
    ok(!v3.ok && v3.violations.some(x => x.rule === "V3" && x.path === "calls[0].args.x"),
        "负例 V3：键 x 赋数字 → 红", v3.violations);
    ok(v3.violations.some(x => x.rule === "V1"), "同一条里 cell:[4,-13] 也被 V1 抓住（全文列出，不只报第一条）", v3.violations.map(x => x.rule));

    /* V4：字符串里出现坐标（say 夹带） */
    const v4 = assertNoHumanCoords({
        say: "把 (4,-13) 那条带删掉",
        calls: [{ macro: "remove_run", args: { uids: { $uids: [H[0]] } } }],
    }, t4);
    ok(!v4.ok && v4.violations.some(x => x.rule === "V4" && x.path === "say"),
        "负例 V4：say 里写 (4,-13) → 红", v4.violations);

    /* V4 也管 why（不只是 say） */
    const v4b = assertNoHumanCoords({
        calls: [{ macro: "remove_run", args: { uids: { $uids: [H[0]] } }, why: "这条在 4, -13 上" }],
    }, t4);
    ok(!v4b.ok && v4b.violations.some(x => x.rule === "V4" && x.path === "calls[0].why"),
        "负例 V4：why 里写坐标 → 红", v4b.violations);

    /* V5：幻觉句柄 */
    const v5 = assertNoHumanCoords({
        calls: [{ macro: "remove_run", args: { uids: { $uids: ["B999"] } } }],
    }, t4);
    ok(!v5.ok && v5.violations.some(x => x.rule === "V5"),
        "负例 V5：$uids 里的 B999 不在句柄表 → 红", v5.violations);
    const v5b = assertNoHumanCoords({ calls: [{ macro: "trash_unused", args: { outlet: { $ref: "Z9" } } }] }, t4);
    ok(!v5b.ok && v5b.violations.some(x => x.rule === "V5"), "负例 V5b：$ref 幻觉句柄 → 红", v5b.violations);

    /* V6：未知 $ 算子（防止 LLM 发明「偏移」来变相算数） */
    const v6 = assertNoHumanCoords({
        calls: [{ macro: "replace_run", args: { region: { $offset: [H[0], 1, 0] }, building: "belt" } }],
    }, t4);
    ok(!v6.ok && v6.violations.some(x => x.rule === "V6"),
        "负例 V6：$offset 是未登记的算子 → 红", v6.violations);

    /* 结构负例：$ref 值不是句柄 */
    const br = assertNoHumanCoords({ calls: [{ macro: "trash_unused", args: { outlet: { $ref: 7 } } }] }, t4);
    ok(!br.ok && br.violations.some(x => x.rule === "REF_SHAPE"), "负例：$ref 给数字而不给句柄 → 红", br.violations);

    /* 结构负例：$bbox_of 空数组 */
    const be = assertNoHumanCoords({ calls: [{ macro: "replace_run", args: { region: { $bbox_of: [] }, building: "belt" } }] }, t4);
    ok(!be.ok && be.violations.some(x => x.rule === "REF_SHAPE"), "负例：$bbox_of:[] → 红", be.violations);

    /* asCell 只能出现在 $ref 里 */
    const ac = assertNoHumanCoords({ calls: [{ macro: "insert_machine", args: { at: { $uids: [H[0]], asCell: true } } }] }, t4);
    ok(!ac.ok && ac.violations.some(x => x.rule === "AS_CELL_SCOPE"), "负例：asCell 挂在 $uids 上 → 红", ac.violations);
}

/* ═══════════ 3. resolveRefs —— L4 冷启动正确调用必须绿 ═══════════ */

{
    const plan = {
        say: "把这三条带换成 cutter，右侧废料进垃圾桶",
        calls: [{
            macro: "replace_run",
            args: {
                region: { $bbox_of: [H[0], H[1], H[2]] },
                building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
            },
            why: "目标形状 RuRu---- 要左列",
        }],
    };
    const r = resolveRefs(plan, t4, l4);
    ok(r.ok, "L4 冷启动调用解析为绿（这是任务书点名的判据）", r.violations);
    eq(r.calls.length, 1, "解析出 1 条调用");
    const c = r.calls[0];
    eq(c.macro, "replace_run", "宏名保留");
    jEq(c.args.region, [4, -14, 5, -13], "$bbox_of 解析成 [4,-14,5,-13]（含 footprint 并集）");
    eq(c.provenance.region, `computed:bbox_of[${H.join(",")}]`,
        "region 的 provenance 是 computed:bbox_of[句柄…]（存句柄，不存坐标）");
    ok(PROVENANCE_RE.test(c.provenance.region), "provenance 形态合法");

    /* 解析结果**直接**能喂真宏 —— 这是「没人算坐标」的实证（不是断言 JSON 长什么样） */
    const { replaceRun } = await import("../macros/remove.mjs");
    const mr = replaceRun({ region: c.args.region, building: c.args.building }, { entities: l4.entities });
    ok(mr.ok, "解析出的 args 能直接喂 replace_run 且规划成功", mr.error);
    eq(mr.placed.length, 2, "replace_run 放了 cutter + trash");
    jEq((mr.removed || []).map(x => x.uid).sort((a, b) => a - b), [10143, 10149, 10209],
        "删的正好是那 3 条（bbox 没多圈）");
}

/* ═══════════ 4. resolveRefs —— $ref / $uids / asCell ═══════════ */

{
    /* $ref → {uid}（+ 可选 port，见下） */
    const p1 = { calls: [{ macro: "trash_unused", args: { outlet: { $ref: H[0], port: "left" }, opts: { confirm_waste: true } } }] };
    const r1 = resolveRefs(p1, t4, l4);
    ok(r1.ok, "$ref 解析绿", r1.violations);
    jEq(r1.calls[0].args.outlet, { uid: 10143, port: "left" },
        "$ref+port → {uid:10143, port:'left'}（多输出机器的端点选择必须能表达）");
    eq(r1.calls[0].provenance.outlet, "obs:uid=10143", "$ref 的 provenance 是 obs:uid=N（标量）");

    /* $ref 不带 port → 只有 uid（不塞默认值，让宏自己判 auto 的唯一性） */
    const p1b = { calls: [{ macro: "trash_unused", args: { outlet: { $ref: H[0] } } }] };
    const r1b = resolveRefs(p1b, t4, l4);
    jEq(r1b.calls[0].args.outlet, { uid: 10143 }, "$ref 不带 port → 只有 uid（不替宏填 auto）");

    /* $ref + asCell → {cell:[x,y]}（**any-cell** 形态，不是裸 [x,y] origin） */
    const p2 = { calls: [{ macro: "insert_machine", args: { at: { $ref: H[0], asCell: true }, facing: "top", machine: "cutter" } }] };
    const r2 = resolveRefs(p2, t4, l4);
    ok(r2.ok, "$ref.asCell 解析绿", r2.violations);
    jEq(r2.calls[0].args.at, { cell: [4, -14] }, "$ref.asCell → {cell:[4,-14]}（宏的 any-cell 形态，会反解 origin）");
    ok(!Array.isArray(r2.calls[0].args.at),
        "asCell 产出的是 {cell} 对象，**不是**裸 [x,y]（红队 #10：裸数组 = origin，2×1 机器会静默删带）");
    eq(r2.calls[0].provenance.at, "obs:uid=10143", "asCell 的 provenance 仍是 obs:uid=N");

    /* $uids → uid[] */
    const p3 = { calls: [{ macro: "remove_run", args: { uids: { $uids: [H[0], H[1], H[2]] } } }] };
    const r3 = resolveRefs(p3, t4, l4);
    ok(r3.ok, "$uids 解析绿", r3.violations);
    jEq(r3.calls[0].args.uids, [10143, 10209, 10149], "$uids → [uid…]");
    jEq(r3.calls[0].provenance.uids, ["obs:uid=10143", "obs:uid=10209", "obs:uid=10149"],
        "$uids 的 provenance 是**标签数组**（顺序与 uid 一致）");

    /* 负例：$ref 幻觉句柄 → resolved 为空 + violation */
    const r4 = resolveRefs({ calls: [{ macro: "remove_run", args: { uids: { $uids: ["B999"] } } }] }, t4, l4);
    ok(!r4.ok && r4.violations.some(v => v.rule === "V5"), "负例：幻觉句柄 → 解析失败且报 V5", r4.violations);
    eq(r4.calls.length, 0, "解析失败的 call 不进 calls（不留下半解析结果）");

    /* 负例：未知宏 */
    const r5 = resolveRefs({ calls: [{ macro: "build_line", args: {} }] }, t4, l4);
    ok(!r5.ok && r5.violations.some(v => v.rule === "MACRO"), "负例：build_line 不在白名单 → 红", r5.violations);

    /* 负例：calls 不是数组 */
    const r6 = resolveRefs({ calls: "nope" }, t4, l4);
    ok(!r6.ok && r6.violations.some(v => v.rule === "PLAN_SHAPE"), "负例：calls 不是数组 → 红", r6.violations);

    /* 负例 V7：解析后的 args 仍然带裸坐标（绕过了 $ 算子但键名不在 V3 清单里） */
    const r7 = resolveRefs({
        calls: [{ macro: "remove_run", args: { cells: [[4, -13]] } }],
    }, t4, l4);
    ok(!r7.ok, "负例：remove_run.cells 给字面坐标 → 红（V1 先抓，V7 兜底）", r7.violations.map(v => v.rule));
}

/* ═══════════ 5. assertProvenance —— 正例 + 变异测试（必须红） ═══════════ */

{
    const plan = { calls: [{ macro: "replace_run", args: { region: { $bbox_of: [H[0], H[1], H[2]] }, building: "belt" } }] };
    const res = resolveRefs(plan, t4, l4);
    ok(res.ok, "前置：解析绿");

    /* 用一个「形状正确」的 txPlan：region 内 2×2 全 place（这里不跑真宏，只测溯源本身） */
    const mkTxPlan = () => ({
        ops: [
            { op: "delete", uid: 10143, provenance: { uid: "obs:uid=10143" } },
            { op: "delete", uid: 10209, provenance: { uid: "obs:uid=10209" } },
            { op: "delete", uid: 10149, provenance: { uid: "obs:uid=10149" } },
            { op: "place", building: "cutter", x: 4, y: -13, r: 0,
                provenance: { x: `computed:bbox_of[${H.join(",")}]`, y: `computed:bbox_of[${H.join(",")}]` } },
            { op: "place", building: "trash", x: 4, y: -14, r: 0,
                provenance: { x: `computed:bbox_of[${H.join(",")}]`, y: `computed:bbox_of[${H.join(",")}]` } },
        ],
    });

    const good = assertProvenance(res, mkTxPlan(), l4);
    ok(good.ok, "正例：resolved + txPlan 溯源全绿", good.violations);

    /* ── 变异 1（契约 §2.4 点名）：把解析结果里 region 的 x 加 1 ── */
    const mutated = structuredClone(res);
    mutated.calls[0].args.region[0] += 1;
    const m1 = assertProvenance(mutated, mkTxPlan(), l4);
    ok(!m1.ok && m1.violations.some(v => v.rule === "COORD_PROVENANCE"),
        "变异：region[0] 加 1 → 红（只验标签形状是红不了的）", m1.violations);

    /* ── 变异 2：place 的 x 挪出 bbox ── */
    const tx2 = mkTxPlan();
    tx2.ops[3].x = 99;
    const m2 = assertProvenance(res, tx2, l4);
    ok(!m2.ok && m2.violations.some(v => v.reason.includes("不在 provenance bbox")),
        "变异：place 的 x 挪出 bbox → 红", m2.violations);

    /* ── 变异 3：delete 的 uid 改成一个不存在的 ── */
    const tx3 = mkTxPlan();
    tx3.ops[0].uid = 42;
    const m3 = assertProvenance(res, tx3, l4);
    ok(!m3.ok && m3.violations.some(v => v.path.includes("ops[0]")),
        "变异：delete 的 uid 改成 42（obs 里没有）→ 红", m3.violations);

    /* ── 变异 4：obs:uid=N 标签配一个被改过的 cell ── */
    const res4 = structuredClone(res);
    res4.calls[0].provenance.cell = "obs:uid=10209";
    res4.calls[0].args.cell = [4, -13];   // 10209 的真 origin 是 [4,-13] —— 先确认这条是绿的
    const okCell = assertProvenance(res4, mkTxPlan(), l4);
    ok(okCell.ok, "正例：obs:uid= 标签配正确的 cell 是绿的", okCell.violations);
    res4.calls[0].args.cell = [4, -12];   // 加 1 格
    const m4 = assertProvenance(res4, mkTxPlan(), l4);
    ok(!m4.ok && m4.violations.some(v => v.reason.includes("cell")),
        "变异：cell 的 y 挪一格 → 红", m4.violations);

    /* ── 负例：op 没有 provenance ── */
    const tx5 = mkTxPlan();
    delete tx5.ops[2].provenance;
    const m5 = assertProvenance(res, tx5, l4);
    ok(!m5.ok && m5.violations.some(v => v.rule === "MISSING_PROVENANCE"),
        "负例：delete 没有 provenance → 红（不许『没标签就当没事』）", m5.violations);

    /* ── 负例：provenance 形态非法 ── */
    const tx6 = mkTxPlan();
    tx6.ops[4].provenance = { x: "trust me", y: "trust me" };
    const m6 = assertProvenance(res, tx6, l4);
    ok(!m6.ok && m6.violations.some(v => v.rule === "COORD_PROVENANCE"),
        "负例：provenance 是自由文本 → 红", m6.violations);

    /* ── 负例：delete 的 uid 用 macro: 标签（删的必须是 obs 里已存在的实体） ── */
    const tx7 = mkTxPlan();
    tx7.ops[0].provenance = { uid: "macro:replace_run:cutter@4,-13" };
    tx7.pendingByOp = { 3: "replace_run:cutter@4,-13" };
    const m7 = assertProvenance(res, tx7, l4, { knownTokens: ["replace_run:cutter@4,-13"] });
    ok(!m7.ok && m7.violations.some(v => v.reason.includes("只能来自 obs:uid=N")),
        "负例：delete 用 macro: 标签 → 红（token 合法也不行）", m7.violations);

    /* ── 负例：$bbox_of 标签里的句柄被换成幻觉句柄 ── */
    const res8 = structuredClone(res);
    res8.calls[0].provenance.region = "computed:bbox_of[B999]";
    const m8 = assertProvenance(res8, mkTxPlan(), l4);
    ok(!m8.ok && m8.violations.some(v => v.reason.includes("B999")),
        "负例：bbox 标签引用幻觉句柄 → 红", m8.violations);

    /* ── 负例：resolved 里的调用完全没有 provenance 表 ── */
    const m9 = assertProvenance({ calls: [{ macro: "remove_run", args: { uids: [1] } }] }, mkTxPlan(), l4);
    ok(!m9.ok && m9.violations.some(v => v.rule === "MISSING_PROVENANCE"),
        "负例：call 没有 provenance 表 → 红", m9.violations);

    /* ── 跨文件契约不一致（**本实现发现的真实缺口**）──
       `planToTxOps.mjs` 明确「不产出 per-op provenance」（它认为翻译器不该判溯源）。
       若 assertProvenance 对此静默放行，L-C 就变成空炮。这里钉住「必须显式拒绝」。 */
    const noProv = { ops: [{ op: "delete", uid: 10143 }, { op: "place", building: "cutter", x: 4, y: -13 }] };
    const m10 = assertProvenance(res, noProv, l4);
    ok(!m10.ok && m10.violations.some(v => v.reason.includes("planToTxOps 目前不产出这一层")),
        "负例：txPlan 整层没有 provenance → 红（不许静默放行，否则 L-C 是空炮）", m10.violations);

    /* 只要**有一条** op 带 provenance，就逐条判（缺的那些会单独红） */
    const partial = { ops: [{ op: "delete", uid: 10143, provenance: { uid: "obs:uid=10143" } },
        { op: "place", building: "cutter", x: 4, y: -13 }] };
    const m11 = assertProvenance(res, partial, l4);
    ok(!m11.ok && m11.violations.some(v => v.path === "txPlan.ops[1].provenance"),
        "负例：只有部分 op 带 provenance → 缺的那条单独红", m11.violations.map(v => v.path));
}

/* ═══════════ 6. getPath ═══════════ */

{
    const o = { a: { b: [10, { c: 3 }] }, x: 1 };
    eq(getPath(o, "x"), 1, "getPath 顶层");
    eq(getPath(o, "a.b[0]"), 10, "getPath 下标");
    eq(getPath(o, "a.b[1].c"), 3, "getPath 深层");
    eq(getPath(o, "a.zz"), undefined, "getPath 缺键 → undefined");
    eq(getPath(o, "a.b[9]"), undefined, "getPath 越界 → undefined");
    eq(getPath(o, ""), o, "getPath 空路径返回自身");
}

/* ═══════════ 7. PROVENANCE_RE 的边界 ═══════════ */

{
    ok(PROVENANCE_RE.test("obs:uid=7"), "obs:uid=N 合法");
    ok(PROVENANCE_RE.test("macro:replace_run:cutter@4,-13"), "macro:<token> 合法（token 里的坐标是宏给的，不是 LLM 写的）");
    ok(PROVENANCE_RE.test("computed:bbox_of[B69,B81]"), "computed:bbox_of[…] 合法");
    ok(!PROVENANCE_RE.test("obs:uid=-1"), "负数 uid 非法");
    ok(!PROVENANCE_RE.test("macro:"), "空 token 非法");
    ok(!PROVENANCE_RE.test("computed:bbox_of[]"), "空 bbox 非法");
    ok(!PROVENANCE_RE.test("llm:says so"), "未知来源前缀非法");
}

/* ═══════════ 8. $path_of —— 精确格集 vs 外接矩形（第三轮实验 §15 的修法） ═══════════
 *
 * 这组测试的存在理由：`$bbox_of` 在**直线一宽**的链上与 `$path_of` 完全等价，
 * 差别只在链拐弯或两条链并行时才出现。而第三轮真 LLM 实验的 5 次失败全部来自这个差别
 * （`EXPERIMENT-COLDSTART.md` §15：occupied / not_a_run / precondition_failed）。
 * 所以每一条正向断言都必须配一条「`$bbox_of` 确实会更大/更宽」的对照，
 * 否则「`$path_of` 解决了问题」这句话无法证伪。
 */

console.log("\n── 8. $path_of ──");
{
    const { pathOf, footprintCells } = await import("./handles.mjs");
    const { PATH_PROVENANCE_PREFIX } = await import("./coords.mjs");
    const uidOf = h => t4.byHandle.get(h).uid;

    /* ── 8.1 精确格集：不含额外的格子 ──
       `B69/B81/B82` 是 x=4 上 y=-14..-13 的两格 + x=5 上 y=-13 的一格（一条拐弯的链段）。
       外接矩形是 2×2 = 4 格，实际只有 3 格 —— 这正是 #5 那次「多框了一格」的形态。 */
    {
        const p = pathOf(["B69", "B81", "B82"].map(uidOf), l4);
        jEq(p.cells, [[4, -14], [4, -13], [5, -13]], "$path_of 给精确格集（3 格，按输入顺序展开 footprint）");
        eq(p.cells.length, 3, "格集恰好 3 格（不是矩形的 4 格）");
        eq(p.area, 4, "外接矩形面积 4 —— 与格集长度不等，说明确实有缺口");
        eq(p.contiguous, false, "★ 拐弯的链被判 contiguous:false");
        jEq(p.holes, [[5, -14]], "★ 报出缺的那一格（而不是把 region 扩成 2×2）");
        ok(!p.cells.some(c => c[0] === 5 && c[1] === -14),
            "★ 格集里**没有** (5,-14) —— 它没被任何输入句柄指到");
    }

    /* ── 8.2 对照：同样的输入交给 $bbox_of，得到更大的矩形 ── */
    {
        const bb = bboxOf(["B69", "B81", "B82"].map(uidOf), l4);
        jEq(bb, [4, -14, 5, -13], "$bbox_of 同样的输入 → 2×2 矩形（含没被点名的 (5,-14)）");
        const p = pathOf(["B69", "B81", "B82"].map(uidOf), l4);
        ok(bb[0] === p.region[0] && bb[1] === p.region[1] && bb[2] === p.region[2] && bb[3] === p.region[3],
            "（对照）两者的 region/bbox 数值相同 —— 差别只在『格集有没有填满它』");
        ok(p.cells.length < p.area, "（对照）bbox 覆盖 4 格而输入只有 3 格：多出的那一格就是 bbox 的病根");
    }

    /* ── 8.3 直线连续链：两者等价（避免「$path_of 处处更严」的误解） ── */
    {
        const hs = ["B97", "B90", "B81"].map(uidOf);
        const p = pathOf(hs, l4);
        jEq(p.cells, [[4, -11], [4, -12], [4, -13]], "直线段：格集 = 3 格");
        eq(p.contiguous, true, "直线段：contiguous:true（可以投影成 region）");
        jEq(p.region, bboxOf(hs, l4), "（对照）直线段上 region === bbox（两算子等价）");
    }

    /* ── 8.4 并排 2×2：格集恰好填满 → 可以投影（这不是「非连续」） ── */
    {
        const p = pathOf(["B69", "B70", "B81", "B82"].map(uidOf), l4);
        eq(p.cells.length, 4, "并排两条链各取 2 格 = 4 格");
        eq(p.area, 4, "外接矩形也是 4 格");
        eq(p.contiguous, true, "★ 恰好填满 ⇒ contiguous:true（判据是『填满矩形』，不是『同一条链』）");
        jEq(p.holes, [], "没有空洞");
    }

    /* ── 8.5 关键负例：不连续的格集 → 必须报错，**不能**返回把它们都包住的矩形 ──
       `B69`(4,-14) 与 `B112`(4,-9) 之间隔着 4 条带子。若实现返回 region，那就是静默扩大 = bug。 */
    {
        const hs = ["B69", "B112"].map(uidOf);
        const p = pathOf(hs, l4);
        eq(p.cells.length, 2, "格集只有 2 格（B69 与 B112）");
        eq(p.area, 6, "外接矩形 6 格（纵向 y=-14..-9）");
        eq(p.contiguous, false, "★ 不连续 ⇒ contiguous:false");
        jEq(p.holes, [[4, -13], [4, -12], [4, -11], [4, -10]],
            "★ 空洞逐格报出（中间那 4 条带子被点名了吗？没有）");
        ok(p.cells.length !== p.area, "★ 格数 ≠ 面积 —— 任何『用面积当格数』的实现都会在这里露馅");

        /* 走完整的 resolveRefs：region 参数**必须**红，且 calls 里不能留下这条调用 */
        const bad = resolveRefs({
            calls: [{ macro: "replace_run", args: { region: { $path_of: ["B69", "B112"] }, building: "belt" } }],
        }, t4, l4);
        ok(!bad.ok, "★ 不连续选区喂给 replace_run.region ⇒ 解析失败（不是静默扩成矩形）", bad.violations);
        ok(bad.violations.some(v => v.rule === "PATH_NOT_RECT"), "★ 报的是 PATH_NOT_RECT（专用码）",
            bad.violations.map(v => v.rule));
        eq(bad.calls.length, 0, "★ 失败的调用不进 calls（没有半个 args 往下走）");
        /* 这条是「不许静默扩大」的**直接**断言：任何返回 region 的实现都会在这里红 */
        ok(!bad.calls.some(c => Array.isArray(c.args.region)),
            "★ 没有任何 call 带着一个 4 元 region 溜过去");
        const reason = bad.violations.find(v => v.rule === "PATH_NOT_RECT").reason;
        ok(/-13|-12|-11|-10/.test(reason), "★ 报错里列出了缺口坐标（模型能据此拆段，不用猜）", reason);
    }

    /* ── 8.6 正例：连续选区喂给 replace_run.region → 投影成 4 元 bbox，带 path_of 标签 ── */
    {
        const r = resolveRefs({
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B70", "B81", "B82"] }, building: "belt" },
            }],
        }, t4, l4);
        ok(r.ok, "连续 $path_of → replace_run 解析为绿", r.violations);
        jEq(r.calls[0].args.region, [4, -14, 5, -13], "region 投影成 4 元闭区间（宏只吃这个形态）");
        eq(r.calls[0].provenance.region, `computed:path_of[B69,B70,B81,B82]`,
            "provenance 是 computed:path_of[…]，存的是句柄不是坐标");
        ok(PROVENANCE_RE.test(r.calls[0].provenance.region), "path_of 标签形态合法");
        jEq(assertNoHumanCoords({
            calls: [{ macro: "replace_run", args: { region: { $path_of: ["B69", "B70"] }, building: "belt" } }],
        }, t4), { ok: true, violations: [], rulesRun: ["V1", "V2", "V3", "V4", "V5", "V6"], rulesSkipped: [] },
        "V1 白名单放行 $path_of 的句柄数组（不误判成字面坐标）");
    }

    /* ── 8.7 Cell[] 参数：投影成精确格集（remove_run.cells 本来就允许稀疏） ── */
    {
        const r = resolveRefs({
            calls: [{ macro: "remove_run", args: { cells: { $path_of: ["B69", "B81", "B82"] } } }],
        }, t4, l4);
        ok(r.ok, "Cell[] 位置接受非连续格集（不需要矩形）", r.violations);
        jEq(r.calls[0].args.cells, [[4, -14], [4, -13], [5, -13]], "cells 拿到的是精确格集（3 格）");
        eq(r.calls[0].provenance.cells, "computed:path_of[B69,B81,B82]", "cells 的 provenance 同样是 path_of");
        /* 但真正的宏要 3 格都是带子 —— 这几格确实是，所以能过 */
        const lint = r.calls.length === 1 && Array.isArray(r.calls[0].args.cells) && r.calls[0].args.cells.length === 3;
        ok(lint, "cells 形态完整（长度为 3，不是矩阵）");
    }

    /* ── 8.8 用错位置：$path_of 给一个非坐标参数 → REF_SHAPE ── */
    {
        const r = resolveRefs({ calls: [{ macro: "remove_run", args: { uids: { $path_of: ["B69"] } } }] }, t4, l4);
        ok(!r.ok && r.violations.some(v => v.rule === "REF_SHAPE"),
            "负例：$path_of 用在 uids（身份参数）上 → REF_SHAPE", r.violations.map(v => v.rule));
        eq(r.calls.length, 0, "负例：没有 call 溜过去");
    }

    /* ── 8.9 结构负例：空数组 / 幻觉句柄 ── */
    {
        const e1 = resolveRefs({ calls: [{ macro: "replace_run", args: { region: { $path_of: [] }, building: "belt" } }] }, t4, l4);
        ok(!e1.ok && e1.violations.some(v => v.rule === "REF_SHAPE" || v.rule === "V5"),
            "负例：$path_of:[] → 红", e1.violations.map(v => v.rule));
        const e2 = resolveRefs({ calls: [{ macro: "replace_run", args: { region: { $path_of: ["B999"] }, building: "belt" } }] }, t4, l4);
        ok(!e2.ok && e2.violations.some(v => v.rule === "V5"), "负例：$path_of 幻觉句柄 → V5", e2.violations);
        /* V6 也认它（否则「未知算子」与「已知算子」的边界会说两套话） */
        ok(Object.values(COORD_SOURCES).includes("$path_of"), "COORD_SOURCES 里有 $path_of（V6 的放行名单从它派生）");
        const e3 = assertNoHumanCoords({ calls: [{ macro: "replace_run", args: { region: { $path_of: ["B69"] } } }] }, t4);
        ok(e3.ok, "assertNoHumanCoords 对 $path_of 不报 V6", e3.violations);
    }

    /* ── 8.10 溯源变异：改格集 / 改 region 必须红 ── */
    {
        const plan = {
            calls: [{
                macro: "replace_run",
                args: { region: { $path_of: ["B69", "B70", "B81", "B82"] }, building: "belt" },
            }],
        };
        const res = resolveRefs(plan, t4, l4);
        ok(res.ok, "（前置）连续 path_of 计划解析绿", res.violations);
        const tx = () => ({
            ops: [
                { op: "place", building: "belt", x: 4, y: -13, r: 0,
                    provenance: { x: res.calls[0].provenance.region, y: res.calls[0].provenance.region } },
            ],
        });
        ok(assertProvenance(res, tx(), l4).ok, "正例：path_of 标签 + region 内的落点 → 绿");

        /* ★ 变异 A（任务书点名）：改一个坐标 → 必须红 ★ */
        const mA = structuredClone(res);
        mA.calls[0].args.region[0] += 1;                       // x0 从 4 改成 5
        const vA = assertProvenance(mA, tx(), l4);
        ok(!vA.ok && vA.violations.some(v => v.rule === "COORD_PROVENANCE"),
            "★ 变异：region[0] 加 1 → 红（标签没变、值变了）", vA.violations);
        ok(vA.violations.some(v => /重算不符/.test(v.reason)),
            "★ 红的原因是「与重算不符」（真的回到 obs 重算了）", vA.violations.map(v => v.reason));

        /* 变异 B：把 region 改成覆盖更多格的更大矩形（这正是「静默扩大」的形态） */
        const mB = structuredClone(res);
        mB.calls[0].args.region = [4, -15, 5, -9];
        ok(!assertProvenance(mB, tx(), l4).ok, "变异：region 被悄悄扩大 → 红（不许静默扩范围）");

        /* 变异 C：标签里的句柄被换掉 */
        const mC = structuredClone(res);
        mC.calls[0].provenance.region = "computed:path_of[B69,B112]";
        const vC = assertProvenance(mC, tx(), l4);
        ok(!vC.ok && vC.violations.some(v => v.rule === "COORD_PROVENANCE"),
            "变异：path_of 标签换成不连续的句柄集 → 红（不连续集合不存在合法 region 投影）", vC.violations);

        /* 变异 D：标签换成幻觉句柄 */
        const mD = structuredClone(res);
        mD.calls[0].provenance.region = "computed:path_of[B999]";
        ok(!assertProvenance(mD, tx(), l4).ok, "变异：path_of 标签引用幻觉句柄 → 红");

        /* 变异 E：place 落点挪出选区 */
        const tE = tx();
        tE.ops[0].x = 99;
        ok(!assertProvenance(res, tE, l4).ok, "变异：place 的 x 挪出 path_of 选区 → 红");
    }
}

/* ═══════════ 9. 变异测试：把连续性检查改成恒真，测试必须红 ═══════════
 *
 * 契约的变异纪律（§2.4）要求「反着写一定红」。这一条针对 `$path_of` 的**核心判据**：
 * 若把 `contiguous` 改成恒 `true`，`$path_of(B69,B112)` 就会安静地返回一个 6 格矩形，
 * 于是「拐弯时宏必须拒绝」这件事**没有任何机器检查**——正是当前 `$bbox_of` 的病。
 *
 * 做法：把 `handles.mjs` **逐字复制**到临时目录，只改 `contiguous` 那一行，然后让
 * `coords.mjs` 的副本 import 这个变异体（用 data: URL 不必要 —— 直接写文件更接近真实模块）。
 * 判据：变异体下 `resolveRefs` 必须**返回绿 / 返回一个 region**，而原实现必须红。
 * 两者都断言，缺任一条这个测试就变成恒真。
 */
console.log("\n── 9. 变异：连续性检查恒真 → 必须被抓 ──");
{
    const os = await import("node:os");
    const { pathToFileURL } = await import("node:url");
    const src = fs.readFileSync(path.join(HERE, "handles.mjs"), "utf8");
    const ANCHOR = "const contiguous = dupes.length === 0 && cells.length === area;";
    ok(src.includes(ANCHOR), "变异锚点存在（连续性判据只有这一行）", { found: src.includes(ANCHOR) });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pathof-mut-"));
    try {
        /* 变异体：只把判据换成恒真，其余逐字照抄 */
        const mutant = src.replace(ANCHOR, "const contiguous = true; // MUTANT: 恒真");
        ok(mutant !== src, "变异体确实被改过（不是照抄）");
        /* import 路径改成绝对 URL —— 临时目录里的相对路径会指到别处（实测会以
           「模块找不到」退出，而那个退出码 1 会被误当成「变异被抓」）。 */
        const uri = f => pathToFileURL(path.resolve(HERE, f)).href;
        const fixed = mutant
            .replace('"../../ai/op-templates.mjs"', JSON.stringify(uri("../../ai/op-templates.mjs")))
            .replace('"../../ai/belt-rules.mjs"', JSON.stringify(uri("../../ai/belt-rules.mjs")))
            .replace('"../verify_runtime.mjs"', JSON.stringify(uri("../verify_runtime.mjs")));
        ok(!/from "\.\.?\//.test(fixed), "变异体的 import 全部换成绝对 URL（否则会假绿）");
        const mPath = path.join(tmp, "handles.mutant.mjs");
        fs.writeFileSync(mPath, fixed);
        const M = await import(pathToFileURL(mPath).href);
        ok(typeof M.pathOf === "function", "变异体可加载（pathOf 存在）");

        /* ① 先确认变异体**真的**改变了行为：同一个非连续输入被判 contiguous:true */
        const pm = M.pathOf(["B69", "B112"].map(h => t4.byHandle.get(h).uid), l4);
        eq(pm.contiguous, true, "★ 变异体：不连续选区被判 contiguous:true（说明变异生效）");

        /* ② 原实现下 resolveRefs 必红，变异体下同样的计划必绿 —— 两条都要断言。
              只断言 ② 不够：原实现若也绿，这个测试就是恒真的。 */
        const mkPlan = () => ({
            calls: [{ macro: "replace_run", args: { region: { $path_of: ["B69", "B112"] }, building: "belt" } }],
        });
        const real = resolveRefs(mkPlan(), t4, l4);
        ok(!real.ok && real.violations.some(v => v.rule === "PATH_NOT_RECT"),
            "★ 原实现：同一计划报 PATH_NOT_RECT（对照组）", real.violations.map(v => v.rule));

        /* ③ 变异体版的 coords.mjs：把它对 handles.mjs 的 import 指到变异体上，
              看同一条判据链是否整段失效。这比只测 pathOf 更接近「测试会不会红」。 */
        const coordsSrc = fs.readFileSync(path.join(HERE, "coords.mjs"), "utf8");
        const coordsMut = coordsSrc
            .replace('from "./handles.mjs"', `from ${JSON.stringify(pathToFileURL(mPath).href)}`)
            /* 其余相对 import 也要换成绝对 URL —— 临时目录里的相对路径会指到别处，
               子模块会以「模块找不到」崩掉，而那个崩溃**不是**「变异被抓」（假绿来源）。 */
            .replace('"../macros/contract.mjs"', JSON.stringify(uri("../macros/contract.mjs")));
        ok(!/from "\.\.?\//.test(coordsMut), "coords 变异体的 import 全部换成绝对 URL（否则会假绿）");
        const cPath = path.join(tmp, "coords.mutant.mjs");
        fs.writeFileSync(cPath, coordsMut);
        const C = await import(pathToFileURL(cPath).href);
        const mutated = C.resolveRefs(mkPlan(), M.buildHandles(l4, null), l4);
        ok(mutated.ok, "★★ 变异体下同一计划**通过**（连续性检查失效 ⇒ 静默扩大）", mutated.violations.map(v => v.rule));
        ok(mutated.calls.length === 1 && Array.isArray(mutated.calls[0].args.region) && mutated.calls[0].args.region.length === 4,
            "★★ 变异体返回了一个 4 元 region（这就是 $bbox_of 的老病）", mutated.calls);
        /* 这一切的结论：如果本文件的 8.5 断言被删，上面这个变异体就会全绿通过测试套件 */
        ok(real.ok !== mutated.ok, "★ 原实现与变异体的判定**必须不同** —— 否则测试套件抓不到这个变异");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/* ═══════════ 汇总 ═══════════ */

console.log(`\ncoords 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
