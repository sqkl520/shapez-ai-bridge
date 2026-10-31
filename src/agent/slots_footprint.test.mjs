/**
 * slots_footprint.test.mjs — 锁死「槽口按 footprint 查，不能只按 origin 查」。
 *
 * ## 这个文件存在的原因
 *
 * `checkSlots` 判断「这台机器的槽有没有接上」时，要拿**格**去查「那格上是什么」。
 * 早先用的是 `byOrigin`（只按 `e.x, e.y` 建索引），于是：
 *
 *   balancer@(2,-8)  占 (2,-8) 和 (3,-8)           ← 2×1
 *   cutter@(3,-9)    输入 approach = (3,-8)         ← 落在 balancer 的第二格
 *
 * `byOrigin.get("3,-8")` = null ⇒ 判「cutter 没被喂」⇒ L2 假红。
 * 而实际上 balancer 的 secondary 喷口 `(3,-9)` 正好喂着它。
 *
 * 同类错误在这个项目里出现过 5 次（L4/L5 夹具混用、手抄 hubReachable、
 * byCell 用 origin 索引、以为 footprint 只对 hub 重要、把夹具 bug 当成堵点 D）。
 * 所以这里把它钉成测试。
 *
 * 顺带也钉住 hub：4×4，`cutter → hub` 的链会走到 `(1,-2)` 这种 hub 内部格。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkSlots, slotsOf } from "./verify_runtime.mjs";

/* ══════════════════════════ 夹具 ══════════════════════════ */

const ent = (uid, type, x, y, extra = {}) => ({
    uid, type, x, y, r: 0, variant: "default", rotation_variant: 0, ...extra,
});
const planOf = (list) => ({
    placements: list.map(e => ({ kind: e.type, variant: "default", x: e.x, y: e.y, rot: 0 })),
    removes: [],
});

/* ══════════════════════════ 1. 2×1 机器的第二格 ══════════════════════════ */

test("balancer 第二格喂 cutter：不许判 cutter「没被喂」", () => {
    /* 真实的机对机直连：balancer.secondary 喷口 (3,-9) → cutter 输入 approach (3,-8)。
       而 (3,-8) 是 balancer 的**第二格**，不在 byOrigin 里。 */
    const bal = ent(20001, "balancer", 2, -8, { code: 15 });
    const cutter = ent(20002, "cutter", 3, -9, { code: 9 });
    const obs = { entities: [bal, cutter] };

    /* 前置断言：确认几何真是这样（否则测试就在测别的东西） */
    const ci = slotsOf("cutter", "default", 3, -9, 0).inputs[0];
    assert.deepEqual(ci.cell, [3, -8], "cutter 的输入 approach 必须是 (3,-8)");
    const bs = slotsOf("balancer", "default", 2, -8, 0);
    assert.deepEqual(bs.footprint, [2, 1], "balancer 必须是 2×1");
    assert.ok(bs.outputs.some(o => o.cell[0] === 3 && o.cell[1] === -9),
        "balancer 必须有一个喷口在 (3,-9)");

    const r = checkSlots(planOf([bal, cutter]), obs, null, {});
    const cutterUnfed = r.evidence.unfed_inputs.some(u => u.cell[0] === 3 && u.cell[1] === -9);
    assert.equal(cutterUnfed, false, `cutter 被 balancer 第二格喂着，不该进 unfed_inputs（${JSON.stringify(r.evidence.unfed_inputs)}）`);
    assert.equal(r.evidence.fed_inputs >= 1, true, "至少要有一条被喂");
});

test("cutter 第二格喂下游：输出侧的格查找同样要按 footprint", () => {
    /* cutter 占 (3,-9)(4,-9)。它的右槽 slot 是 (4,-9) = 第二格。
       让下游机器的输入 approach 落在 (4,-9)，检查输出是否被判定为「有去处」。 */
    const cutter = ent(20002, "cutter", 3, -9, { code: 9 });
    const ct = slotsOf("cutter", "default", 3, -9, 0);
    assert.deepEqual(ct.footprint, [2, 1]);
    /* 右槽 slot 在 (4,-9)，喷口在 (4,-8)（dir=top）。
       造一台 trash 在 (4,-8)：它的输入 approach 会是哪？
       直接用一台 cutter 放在 (4,-8) 会很乱 —— 改用 hub 的松散判据：
       这里只断言「右槽被算进 outputs 且 slot 是 (4,-9)」，确认第二格参与了判定。 */
    const right = ct.outputs.find(o => o.role === "right");
    assert.deepEqual(right.slot, [4, -9], "右槽的 slot 必须落在 cutter 的第二格");
    const obs = { entities: [cutter] };
    const r = checkSlots(planOf([cutter]), obs, null, {});
    const unrouted = r.evidence.unrouted_outputs.find(u => u.cell[0] === 3 && u.cell[1] === -9);
    assert.ok(unrouted, "cutter 两个输出都没接东西 ⇒ 必须报 unrouted");
    const slots = unrouted.slots.map(s => s.slot.join(","));
    assert.ok(slots.includes("4,-9"), `右槽（第二格）必须出现在 unrouted 里，实际 ${JSON.stringify(slots)}`);
});

/* ══════════════════════════ 2. hub 4×4 ══════════════════════════ */

test("hub 的覆盖格能被查到（不是只有 origin）", () => {
    /* hub@(-2,-2) 覆盖 x∈[-2,1], y∈[-2,1]，origin 是 (-2,-2)。
       cutter@(1,2) 的左槽喷口 = (1,1) —— 正好是 hub 的覆盖格，且**不是** origin。
       （cutter 的槽口朝上，所以 cutter 必须在 hub 下方才能喷进去。） */
    const hub = ent(10000, "hub", -2, -2, { code: 26 });
    const cutter = ent(20002, "cutter", 1, 2, { code: 9 });
    const ct = slotsOf("cutter", "default", 1, 2, 0);
    const left = ct.outputs.find(o => o.role === "left");
    assert.deepEqual(left.cell, [1, 1], "左槽喷口必须是 (1,1)");
    assert.notDeepEqual([1, 1], [-2, -2], "而且它确实是 hub 的非 origin 格");

    const obs = { entities: [hub, cutter] };
    const r = checkSlots(planOf([cutter]), obs, null, {});
    const unrouted = r.evidence.unrouted_outputs.find(u => u.cell[0] === 1 && u.cell[1] === 2);
    /* 左槽喷口 (1,1) 落在 hub 上 ⇒ 该槽有去处；右槽 (2,1) 在 hub 外且是空的 ⇒ 右槽 unrouted。
       关键是：左槽**不能**出现在 unrouted 里。 */
    if (unrouted) {
        const bad = unrouted.slots.some(s => s.role === "left");
        assert.equal(bad, false, "左槽喷口落在 hub 覆盖格上，不该被判 unrouted");
    }
});

/* ══════════════════════════ 3. 反例：真没接上仍然要红 ══════════════════════════ */

test("真没喂的机器仍进 unfed_inputs（修 footprint 不能把假绿放进来）", () => {
    const cutter = ent(20002, "cutter", 3, -9, { code: 9 });
    const obs = { entities: [cutter] };          // 周围什么都没有
    const r = checkSlots(planOf([cutter]), obs, null, {});
    assert.ok(r.evidence.unfed_inputs.some(u => u.cell[0] === 3 && u.cell[1] === -9),
        "孤立 cutter 必须被判没被喂");
});

test("真没去处仍进 unrouted_outputs", () => {
    const cutter = ent(20002, "cutter", 3, -9, { code: 9 });
    const obs = { entities: [cutter] };
    const r = checkSlots(planOf([cutter]), obs, null, {});
    assert.ok(r.evidence.unrouted_outputs.some(u => u.cell[0] === 3 && u.cell[1] === -9),
        "孤立 cutter 的两个输出都没去处");
});
