/**
 * dead_end_slot_body.test.mjs — 「出口格是机器槽位本体」不许判成 DEAD_END。
 *
 * ## 真机现场（2026-11-13，产线跑到 270/600 时）
 *
 * `B87 @(-10,0)` 是 mixer→painter 那条 59 格长链的**最后一格**，
 * 出口格正是 painter 的 color 槽本体 `(-9,0)`。产线在稳定交货。
 *
 * 而 `DEAD_END` 报了它，因为 `at()` 用 footprint 索引，而「槽位本体格」
 * 不总是落在 footprint 内 —— painter 在 `(-9,1)`（r=270），color 槽的
 * `slot` 是 `(-9,0)`，那一格不在它的 footprint 覆盖范围里。
 *
 * 模型连着两轮照做（「B87 出口无接收方，去桥接它到画家」）——
 * 而画家早就接好了。它在修一条完全正常的线。
 *
 * 运行：node --test src/agent/loop/dead_end_slot_body.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { structuralDiagnoses } from "./structural.mjs";
import { buildHandles } from "./handles.mjs";
import { indexOf, at } from "./topology.mjs";
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";

const RECIPE = Object.freeze({
    ok: true,
    steps: [
        { op: "mine", hash: "CuCuCuCu", inputs: [], args: {} },
        { op: "mineColor", hash: "color:blue", inputs: [], args: { color: "blue" } },
        { op: "mineColor", hash: "color:red", inputs: [], args: { color: "red" } },
        { op: "mix", hash: "color:purple", inputs: ["color:blue", "color:red"], args: { color: "purple" } },
        { op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "color:purple"], args: { color: "purple" } },
    ],
    needs: {},
});

/** 造一个「喂料带最后一格正好停在机器槽位本体前」的世界。 */
function worldFeedingSlotBody() {
    return {
        level: 9,
        goal: { level: 9, requirement: { shape: "CpCpCpCp", required: 600, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 50, y: 50, r: 0, variant: "default", layer: "regular" },
            /* painter 在 (0,0)，r=270 —— 与真机同朝向 */
            { uid: 2, type: "painter", x: 0, y: 0, r: 270, variant: "default", rotation_variant: 0, code: 21, layer: "regular" },
            /* 喂料带在 color 槽的 feedCell 上 */
            { uid: 3, type: "belt", x: -1, y: -1, r: 90, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        ],
        resources: [],
    };
}

test("D1 出口格是机器槽位本体 ⇒ 不许报 DEAD_END", () => {
    const w = worldFeedingSlotBody();
    const idx = indexOf(w);
    const p = idx.byUid.get(2);

    /* 先确认这个夹具的几何真的构成了那个陷阱：
       · painter 的 color 槽 `slot` 是某一格 S；
       · 喂料带的出口格正好是 S；
       · 而 `at(idx, S)` 是 null（S 不在 footprint 内）。 */
    const s = slotsOf(p.type, p.variant, p.x, p.y, p.r || 0, beltRvOf(p));
    const colorSlot = s.inputs.find(x => x.role === "color");
    assert.ok(colorSlot, "painter 必须有 color 槽");

    const belt = idx.byUid.get(3);
    const beltExit = [belt.x + 1, belt.y];      // r=90 → 出口 right
    /* 让喂料带正好停在该槽的 feedCell，出口指向 slot 本体 */
    const feed = colorSlot.cell;
    belt.x = feed[0]; belt.y = feed[1];
    belt.r = colorSlot.dir === "left" ? 90 : colorSlot.dir === "top" ? 0 : colorSlot.dir === "bottom" ? 180 : 270;

    const idx2 = indexOf(w);
    const belt2 = idx2.byUid.get(3);
    assert.ok(belt2, "带子必须在世界里");

    /* 关键前提：`at()` 在槽位本体那格必须返回 null —— 否则这个夹具测不到东西。 */
    const slotBody = colorSlot.slot;
    assert.equal(at(idx2, slotBody), null,
        `★ 夹具前提：槽位本体格 ${JSON.stringify(slotBody)} 必须不在 footprint 索引里，`
        + `实得 ${JSON.stringify(at(idx2, slotBody) && at(idx2, slotBody).type)}`);

    const ds = structuralDiagnoses(w, null, "CpCpCpCp", buildHandles(w, null), { recipe: RECIPE });
    const dead = ds.filter(d => d.code === "DEAD_END");
    assert.equal(dead.length, 0,
        `★ 货是进机器的，不是死端。实得 ${dead.length} 条 DEAD_END：`
        + JSON.stringify(dead.map(d => ({ subject: d.subject, observed: d.observed }))));
});

test("D2 对照：出口格真的是空地 ⇒ 仍然必须报 DEAD_END", () => {
    /* 防止 D1 的修复把判据放松成「永远不报」。 */
    const w = worldFeedingSlotBody();
    /* 把带子挪到空地，出口朝一片空白 */
    const belt = w.entities.find(e => e.uid === 3);
    belt.x = 20; belt.y = 20; belt.r = 90;
    const ds = structuralDiagnoses(w, null, "CpCpCpCp", buildHandles(w, null), { recipe: RECIPE });
    const dead = ds.filter(d => d.code === "DEAD_END");
    assert.ok(dead.length > 0,
        "出口朝空地的带子必须仍然报 DEAD_END —— 否则这条诊断就没用了");
});
