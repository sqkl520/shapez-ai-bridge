/**
 * unfed_slot_body.test.mjs — 「入口格是机器槽位本体」不许判成 CHAIN_UNFED。
 *
 * 和 `dead_end_slot_body.test.mjs` 是同一个陷阱的**另一侧**：
 * `at()` 用 footprint 索引，而「槽位本体格」不总是落在 footprint 内。
 *
 * 真机（2026-11-13，产线跑到 437/600 时）：`B79 @(-9,-1)` 是 painter→hub
 * 那条链的第一格，入口格 `(-9,0)` 正是 painter 的 out 槽本体。
 * 产线在交货，而 `CHAIN_UNFED` 说它「没有源头」—— 模型连着两轮想把它接上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { indexOf, at, upstreamFed, entryCellOf } from "./topology.mjs";
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";

test("U1 入口格是机器输出槽本体 ⇒ upstreamFed 必须为 true", () => {
    const w = {
        level: 9,
        goal: { level: 9, requirement: { shape: "CpCpCpCp", required: 600, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 50, y: 50, r: 0, variant: "default", layer: "regular" },
            /* painter r=270，out 槽 slot=(-1,0)、cell=(0,-1) */
            { uid: 2, type: "painter", x: 0, y: 0, r: 270, variant: "default", rotation_variant: 0, code: 21, layer: "regular" },
            /* 带子放在 out 槽的 cell 上，入口格指向 slot 本体 */
            { uid: 3, type: "belt", x: 0, y: -1, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        ],
        resources: [],
    };
    const idx = indexOf(w);
    const p = idx.byUid.get(2);
    const s = slotsOf(p.type, p.variant, p.x, p.y, p.r || 0, beltRvOf(p));
    const out = s.outputs[0];
    assert.ok(out, "painter 必须有输出槽");

    const belt = w.entities.find(e => e.uid === 3);
    belt.x = out.cell[0]; belt.y = out.cell[1];
    /* 入口格必须是 out 槽的 slot 本体 */
    assert.deepEqual(entryCellOf(belt), out.slot,
        `夹具备置：带子入口格应等于槽位本体 ${JSON.stringify(out.slot)}`);

    const idx2 = indexOf(w);
    assert.equal(at(idx2, out.slot), null,
        `★ 夹具前提：槽位本体 ${JSON.stringify(out.slot)} 必须不在 footprint 索引里`);

    assert.equal(upstreamFed(idx2, idx2.byUid.get(3)), true,
        "★ 货是那台机器吐出来的，不是断头。upstreamFed 必须认它");
});

test("U2 对照：入口真是空地 ⇒ upstreamFed 仍然 false", () => {
    const w = {
        level: 9,
        goal: { level: 9, requirement: { shape: "CpCpCpCp", required: 600, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 50, y: 50, r: 0, variant: "default", layer: "regular" },
            { uid: 3, type: "belt", x: 20, y: 20, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        ],
        resources: [],
    };
    const idx = indexOf(w);
    assert.equal(upstreamFed(idx, idx.byUid.get(3)), false,
        "入口朝空地必须是 false —— 否则这条判据就没用了");
});
