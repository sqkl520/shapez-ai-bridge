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
    jEq(COORD_SOURCES, { OBS_REF: "$ref", OBS_REFS: "$uids", DERIVED_BBOX: "$bbox_of" },
        "COORD_SOURCES 只有三种算子（唯一闭集）");
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

/* ═══════════ 汇总 ═══════════ */

console.log(`\ncoords 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
