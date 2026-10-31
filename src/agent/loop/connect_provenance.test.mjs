/**
 * connect_provenance.test.mjs — 钉住「connect / extend_line 的 cells[] 也是合法溯源来源」。
 *
 * ## 为什么需要这个文件（实机跑出来的 bug）
 *
 * 半成品世界里 loop 的计划**只有一个 connect**（把 B34 的断头接进 hub），宏返回 ok:true：
 *
 *     cells: [[1,-5],[1,-4],[1,-3]]      ← 宏算出来的合法坐标，逐格过了 verifyChain
 *
 * 但 plan 阶段被判红：
 *
 *     COORD_PROVENANCE: txPlan 的 3 条 op 都没有 provenance
 *
 * 根因：`attachProvenance` 的三级来源对 connect 全落空 ——
 *   ① `src.token`：connect 没有 pending（它不产生「新 uid 待分配」的东西）；
 *   ② `$bbox_of`：connect 用 `$ref` 端点，不用 bbox；
 *   ③ `obs:uid`：connect 落的是**新格**，不是任何既有实体的 origin。
 * 而 `sourceOfPlace` **已经**能按 `r.cells[]` 把 op 反查回调用（它返回 `token: null`），
 * 缺的只是「给这一格编一个带坐标的 macro 标签」。
 *
 * 契约 `coords.mjs:26` 写明 `macro:<token>` 可以来自「pending / terminal / placed[].origin /
 * **cells[]**」—— 本文件守的就是最后那一项。
 *
 * ## 反例 C/D 是核心，不是陪衬
 *
 * 修「挂不上标签」很容易滑成「挂个随便的标签就放行」。`macro:` 标签的全部意义是
 * **坐标来自宏**，所以它必须可证伪：
 *   · C：标签挂好之后把 op 的坐标改掉 ⇒ token 里嵌的 @x,y 对不上 ⇒ 必须红；
 *   · D：op 落在宏 cells 之外的格 ⇒ 根本找不到来源 ⇒ 必须红（MISSING_PROVENANCE）。
 * 没有 C/D，正例 A/B 只是「让红变绿」，不构成修复。
 *
 * 夹具是**内联的最小世界**（hub + 3 条带子），坐标取自实机半成品世界
 * （`.tmpverify/final-half/probe-obs.json` 的 B34/H1 几何），但不依赖那个临时目录。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildHandles } from "./handles.mjs";
import { resolveRefs, assertProvenance, PROVENANCE_RE } from "./coords.mjs";
import { planToTxOps } from "./planToTxOps.mjs";
import { attachProvenance, buildTxPlan, verifyMacroTokenCoords } from "../loop.mjs";
import { connect } from "../macros/connect.mjs";
import { extendLine } from "../macros/place.mjs";

/* ═══════════════════════════ 最小世界 ═══════════════════════════
 *
 * 与实机半成品世界同几何：
 *   hub  (-2,-2) 4×4
 *   B34  (1,-6)  r=180 / rv=0 → 出口朝 bottom，下一格 (1,-5) 是空地（断头）
 *   B33  (1,-7)  r=180 / rv=0 → B34 的上游
 *   B99  (3,-6)  r=180 / rv=0 → 备用带子（给 insert_machine 做锚点，远离 connect 路径）
 */
const OBS = {
    entities: [
        { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
        { uid: 10537, type: "belt", x: 1, y: -7, r: 180, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        { uid: 10538, type: "belt", x: 1, y: -6, r: 180, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        { uid: 10600, type: "belt", x: 3, y: -6, r: 180, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    ],
};
const H = buildHandles(OBS, null);
const hOf = uid => H.byUid.get(uid);

/** 走 `buildTxPlan` 前面那半段（resolveRefs → 真宏），返回带 result 的 calls。 */
function executedCalls(calls) {
    const res = resolveRefs({ calls }, H, OBS);
    assert.equal(res.ok, true, "resolveRefs 必须先绿：" + JSON.stringify(res.violations));
    const fns = { connect, extend_line: extendLine };
    return {
        resolved: res.calls,
        executed: res.calls.map(c => ({ macro: c.macro, args: c.args, provenance: c.provenance, result: fns[c.macro](c.args, { entities: OBS.entities }) })),
    };
}

const CONNECT_ONLY = { calls: [{ macro: "connect", args: { from: { $ref: hOf(10538) }, to: { hub: { $ref: H.hubHandle } } }, why: "把断头接进 hub" }] };

/* ═══════════════════════════ 0. 夹具自检 ═══════════════════════════ */

test("0. 夹具：connect(B34 → H1) 真的算出 3 格 (1,-5)(1,-4)(1,-3)，且返回值没有 pending/token", () => {
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const r = executed[0].result;
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.cells.map(c => [c.x, c.y]), [[1, -5], [1, -4], [1, -3]]);
    assert.equal(r.pending, undefined, "connect 没有 pending —— 这正是它挂不上 token 的原因");
    assert.ok(!("token" in r.cells[0]), "cells[] 自己也不带 token（宏不该为此改契约之外的形状）");
});

/* ═══════════════════════════ 1. 正例 A：只有 connect ═══════════════════════════ */

test("A. 只有 connect 的计划：attachProvenance + assertProvenance 全绿（knownTokens 由 loop 传）", () => {
    const { executed, resolved } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    assert.equal(tx.ok, true, JSON.stringify(tx.error));
    assert.equal(tx.ops.length, 3);

    const withProv = attachProvenance(tx, executed, OBS);
    assert.equal(withProv.tagged, 3, "3 条 place 全部挂上标签");
    assert.equal(withProv.untagged.length, 0, JSON.stringify(withProv.untagged));
    for (const op of withProv.ops) {
        assert.match(op.provenance.x, PROVENANCE_RE, "标签必须是合法 provenance 形态");
        assert.match(op.provenance.x, /^macro:connect:belt@-?\d+,-?\d+$/, "connect 的标签形如 macro:connect:belt@x,y");
        assert.equal(op.provenance.x, op.provenance.y);
    }
    assert.deepEqual(new Set(withProv.tokens || []), new Set([
        "connect:belt@1,-5", "connect:belt@1,-4", "connect:belt@1,-3",
    ]), "knownTokens 必须来自宏返回的 cells[]");

    const lc = assertProvenance({ calls: executed }, { ...tx, ops: withProv.ops }, OBS, { knownTokens: withProv.tokens });
    assert.equal(lc.ok, true, "connect 的落盘坐标必须可溯源：" + JSON.stringify(lc.violations));
    assert.equal(verifyMacroTokenCoords({ ops: withProv.ops }).ok, true, "⑤b 也必须绿");
    assert.equal(resolved.length, 1);
});

test("A2. 整条 plan 阶段（buildTxPlan）对只有 connect 的计划不再 COORD_PROVENANCE", () => {
    const r = buildTxPlan(CONNECT_ONLY, OBS, null, H);
    assert.equal(r.ok, true, "plan 阶段必须绿：" + JSON.stringify({ code: r.code, stage: r.stage, observed: r.observed }));
    assert.equal(r.txPlan.ops.length, 3);
    assert.equal(r.provenance.tagged, 3);
    assert.equal(r.provenance.untagged, 0);
});

test("A3. extend_line 同样能从 cells[] 挂标签（同一段代码路径）", () => {
    const plan = { calls: [{ macro: "extend_line", args: { from: { $ref: hOf(10538) }, len: 2 } }] };
    const r = buildTxPlan(plan, OBS, null, H);
    assert.equal(r.ok, true, "extend_line 计划必须绿：" + JSON.stringify({ code: r.code, stage: r.stage, observed: r.observed }));
    assert.equal(r.txPlan.ops.length, 2);
    for (const op of r.txPlan.ops) assert.match(op.provenance.x, /^macro:extend_line:belt@-?\d+,-?\d+$/);
});

/* ═══════════════════════════ 2. 正例 B：connect + insert_machine 混合 ═══════════════════════════ */

test("B. connect + insert_machine 混合：两边都挂得上，plan 阶段全绿", () => {
    const plan = {
        calls: [
            { macro: "connect", args: { from: { $ref: hOf(10538) }, to: { hub: { $ref: H.hubHandle } } } },
            { macro: "insert_machine", args: { at: { $ref: hOf(10600), asCell: true }, machine: "trash" } },
        ],
    };
    const r = buildTxPlan(plan, OBS, null, H);
    assert.equal(r.ok, true, "混合计划必须绿：" + JSON.stringify({ code: r.code, stage: r.stage, observed: r.observed }));

    const belts = r.txPlan.ops.filter(o => o.op === "place" && o.building === "belt");
    const trash = r.txPlan.ops.filter(o => o.op === "place" && o.building === "trash");
    assert.equal(belts.length, 3, "connect 的 3 格");
    assert.equal(trash.length, 1, "insert_machine 的 1 台");
    for (const op of belts) assert.match(op.provenance.x, /^macro:connect:belt@/);
    assert.match(trash[0].provenance.x, /^macro:insert_machine:trash@3,-6$/);
    /* 被 trash 顶掉的带子必须是 obs 溯源（删的是既有实体，不是宏算出来的） */
    const del = r.txPlan.ops.filter(o => o.op === "delete");
    assert.equal(del.length, 1, "insert_machine replace_belts 删掉锚点带子");
    assert.equal(del[0].uid, 10600);
    assert.equal(del[0].provenance.uid, "obs:uid=10600");
});

/* ═══════════════════════════ 3. 反例 C：标签挂好后改坐标 ═══════════════════════════ */

test("C. 改 op 的落点（9,9）但标签仍说 @1,-5 ⇒ assertProvenance 必须红", () => {
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    const withProv = attachProvenance(tx, executed, OBS);
    assert.equal(withProv.tagged, 3, "（前置）三条都挂上了");

    const mutated = {
        ...tx,
        ops: withProv.ops.map(op => (op.op === "place" && op.x === 1 && op.y === -5 ? { ...op, x: 9, y: 9 } : op)),
    };
    const lc = assertProvenance({ calls: executed }, mutated, OBS, { knownTokens: withProv.tokens });
    assert.equal(lc.ok, false, "★ 坐标被改、标签没跟着改 ⇒ 必须红（标签不许成为伪证）");
    const hit = lc.violations.find(v => /token 里的坐标/.test(v.reason));
    assert.ok(hit, "红的理由必须是「token 里的坐标与被验坐标不一致」，实得：" + JSON.stringify(lc.violations));
    assert.equal(verifyMacroTokenCoords({ ops: mutated.ops }).ok, false, "⑤b 独立复核也必须红");
});

/* ═══════════════════════════ 4. 反例 D：op 落在宏 cells 之外 ═══════════════════════════ */

test("D. op 落在 connect 宏 cells 之外 ⇒ attachProvenance 找不到来源 ⇒ 必须红（MISSING_PROVENANCE）", () => {
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    const stray = { op: "place", building: "belt", x: 2, y: -5, r: 0, rotationVariant: 0 };
    const withStray = { ...tx, ops: [...tx.ops, stray] };

    const withProv = attachProvenance(withStray, executed, OBS);
    assert.equal(withProv.tagged, 3, "宏返回的 3 格仍然挂得上");
    assert.equal(withProv.untagged.length, 1, "★ 多出来的那一格必须被如实报成 untagged");
    assert.equal(withProv.untagged[0].op.x, 2);

    const lc = assertProvenance({ calls: executed }, { ...withStray, ops: withProv.ops }, OBS, { knownTokens: withProv.tokens });
    assert.equal(lc.ok, false, "★ 落在 cells 之外的 op 不许被随便挂个标签放行");
    assert.ok(lc.violations.some(v => v.rule === "MISSING_PROVENANCE" && v.path === "txPlan.ops[3].provenance"),
        "红的是第 4 条 op 的 MISSING_PROVENANCE，实得：" + JSON.stringify(lc.violations));
});

test("D2. 伪造一个宏没返回过的 token（形如 connect:belt@2,-5）也不许过", () => {
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    const forged = {
        ...tx,
        ops: tx.ops.map(op => (op.x === 1 && op.y === -5
            ? { ...op, x: 2, y: -5, provenance: { x: "macro:connect:belt@2,-5", y: "macro:connect:belt@2,-5" } }
            : op)),
    };
    const lc = assertProvenance({ calls: executed }, forged, OBS, { knownTokens: ["connect:belt@1,-5", "connect:belt@1,-4", "connect:belt@1,-3"] });
    assert.equal(lc.ok, false, "★ token 不在宏返回值里 ⇒ 必须红");
    assert.ok(lc.violations.some(v => /不在当轮宏返回值里/.test(v.reason)), JSON.stringify(lc.violations));
});

test("D3. 同一格被两个宏认领、但 building 不同 ⇒ 只认与之相符的那个，不去把 op 硬塞给第一个", () => {
    /* connect 的 cells[] 已经是 belt；若某条 op 的 building 是 trash 且落在同一格，
       `cell.building ("belt") !== op.building ("trash")` ⇒ 不认领 ⇒ untagged（红）。
       这条守的是「building 一致性不是用来放行的，而是用来**拒绝认领**的」。 */
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    const impostor = { op: "place", building: "trash", x: 1, y: -5, r: 0, rotationVariant: 0 };
    const withProv = attachProvenance({ ...tx, ops: [impostor] }, executed, OBS);
    assert.equal(withProv.tagged, 0, "★ 坐标对得上但建筑对不上 ⇒ 不许认领");
    assert.equal(withProv.untagged.length, 1);
    const lc = assertProvenance({ calls: executed }, { ops: withProv.ops }, OBS, { knownTokens: withProv.tokens });
    assert.equal(lc.ok, false, "⇒ MISSING_PROVENANCE");
});

test("D4. 宏返回值里没有 cells[]（形状异常）⇒ 不许凭 op 坐标编一个 token", () => {
    const { executed } = executedCalls(CONNECT_ONLY.calls);
    const tx = planToTxOps(executed, { obs: OBS, items: null });
    const broken = executed.map(c => ({ ...c, result: { ...c.result, cells: undefined } }));
    const withProv = attachProvenance(tx, broken, OBS);
    assert.equal(withProv.tagged, 0);
    assert.equal(withProv.tokens.length, 0, "没有 cells 就没有 token 可登记");
    assert.equal(assertProvenance({ calls: broken }, { ...tx, ops: withProv.ops }, OBS, { knownTokens: withProv.tokens }).ok, false);
});
