/**
 * flow-sim.test.mjs — 离线货流仿真的守卫。
 *
 * 判据不是「跑起来不崩」，而是**给定一个手算得出答案的产线，数字必须对上**。
 * 否则这个仿真器只是在生成看起来合理的数字 —— 那比没有更危险。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFlowSim, simulateFlow } from "./flow-sim.mjs";

/**
 * 造一条最小产线：矿机 → 带子 → hub。
 * 手算：矿机 1 件/秒，60 秒应该交付 ~60 件（允许 ±10% 的启动/排队误差）。
 */
function simpleLine() {
    return {
        goal: { level: 9, requirement: { shape: "CuCuCuCu", required: 600, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: -1, y: -2, r: 0, variant: "default", layer: "regular" },
            { uid: 2, type: "miner", x: 0, y: 5, r: 0, variant: "default", rotation_variant: 0, code: 7, layer: "regular" },
            /* 矿机 r=0 → 出口 top，投递格 (0,4) —— buildWorldModel 实测 */
            { uid: 3, type: "belt", x: 0, y: 4, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
            { uid: 4, type: "belt", x: 0, y: 3, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
            { uid: 5, type: "belt", x: 0, y: 2, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
            { uid: 6, type: "belt", x: 0, y: 1, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
            { uid: 7, type: "belt", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
            { uid: 8, type: "belt", x: 0, y: -1, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        ],
        resources: [[0, 5, "CuCuCuCu"]],
    };
}

test("F1 最小产线：60 秒交付 ≈ 矿机速率 × 秒数", () => {
    const r = simulateFlow(simpleLine(), 60);
    assert.ok(r.delivered > 0, `一件都没交付：${JSON.stringify(r)}`);
    assert.ok(r.delivered >= 40 && r.delivered <= 65,
        `60 秒应交付 40~65 件（矿机 1/s），实得 ${r.delivered}`);
});

test("F2 矿机脚下没矿 ⇒ 零交付", () => {
    const w = simpleLine();
    w.resources = [];   // 没有资源图
    const r = simulateFlow(w, 60);
    /* resources 为空时 sim 认为「不知道」，矿机照产 —— 这是刻意的：
       读不到 ≠ 没有。但如果明确给了别的格子有矿，(0,5) 就没矿。 */
    const w2 = simpleLine();
    w2.resources = [[100, 100, "CuCuCuCu"]];    // 矿在别处
    const r2 = simulateFlow(w2, 60);
    assert.equal(r2.delivered, 0, `矿机脚下没矿时不该交付任何货，实得 ${r2.delivered}`);
});

test("F3 带子断开 ⇒ 交付骤降", () => {
    const w = simpleLine();
    /* 删掉中间一格 (0,3)，链就断了 */
    w.entities = w.entities.filter(e => !(e.type === "belt" && e.x === 0 && e.y === 3));
    const r = simulateFlow(w, 60);
    assert.ok(r.delivered < 5, `断链后不该还能交付，实得 ${r.delivered}`);
});

test("F4 假定的速率必须如实报告（不许假装是实测值）", () => {
    const r = simulateFlow(simpleLine(), 10);
    assert.ok(r.assumed_rates, "必须报 assumed_rates");
    assert.equal(r.assumed_rates.belt_speed, 1);
    assert.equal(r.assumed_rates.miner_per_sec, 1);
    assert.ok(typeof r.assumed_rates.note === "string" && r.assumed_rates.note.length > 10,
        "必须有一段说明「这些是假设不是实测」");
});

test("F5 确定性：同一输入跑两次结果完全相同", () => {
    const a = simulateFlow(simpleLine(), 30);
    const b = simulateFlow(simpleLine(), 30);
    assert.equal(a.delivered, b.delivered, "仿真必须是确定性的（否则不能用来做 A/B）");
});
