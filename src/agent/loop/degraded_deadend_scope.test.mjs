/**
 * degraded_deadend_scope.test.mjs — L3 降级分支不许把「有接收方但几何推不出来」判成死端。
 *
 * ## 实机 bug（受控实验，2026-10-31）
 *
 * 纯带子 `connect(B34 → H1)` 计划在**修复 (a) 之前** flows=[]，于是 L3 走降级分支：
 *
 *     L3-flow: ok=false, degraded=true
 *     "计划附近有 2 段带子没有去处（[2,-7]..[2,-7]，1 格）—— 货会堆在那里"
 *
 * 但那两格分别是矿机 → balancer 的输出带，`debug_items` 对它们回的是
 * `boundAcceptor: "yes"`（**有接收方**，只是桥拿不到接收方坐标）。
 *
 * ## 根因（两层，都要钉住）
 *
 * 1. **`acceptorOf()` 把「不知道接收方在哪」当成「没有接收方」**
 *    `boundAcceptor: "yes"` = 游戏明确说有接收方（mod 的 `computeAcceptingEntityAndSlot`
 *    返回了 acceptor，只是那份快照拿不到 `StaticMapEntity.origin`）。
 *    而 `acceptorOf()` 在 `cells.length < 2` 时直接 `return null` —— 因为单格 path
 *    没有走向可以外推。**「推不出坐标」≠「末端断头」**，这两件事混在一个 null 里，
 *    降级分支就只能误报。
 *
 * 2. **降级分支只看 `acceptorOf()` 的 null，不看游戏的权威布尔**
 *    `boundAcceptor` 本身就是「有没有接收方」的权威答案（`gates.mjs#G6b` 一直用的就是它：
 *    `if (!p.boundAcceptor)`）。降级分支却绕开了它。
 *
 * ## 修法（(c)：兜底）
 *
 * 降级分支用 `boundAcceptor` 判死端，**不是**用 `acceptorOf()`。
 * `acceptorOf()` 的语义保持不变（它回答的是「接收方在哪个格」，用于 reach 的逐跳）。
 *
 * 反例是核心：`boundAcceptor: null`（游戏说没有接收方）**必须**继续红，
 * 否则这次修法只是把「假红」换成「假绿」。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { checkFlow, acceptorOf } from "../verify_runtime.mjs";

const HUB = { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26 };
const MINER = { uid: 10505, type: "miner", x: 2, y: -6, r: 0, variant: "default", rotation_variant: 0, code: 7 };
const BAL = { uid: 10508, type: "balancer", x: 2, y: -8, r: 0, variant: "default", rotation_variant: 0, code: 4 };
const B27 = { uid: 10512, type: "belt", x: 2, y: -7, r: 0, variant: "default", rotation_variant: 0, code: 1 };
const B37 = { uid: 10513, type: "belt", x: 3, y: -7, r: 0, variant: "default", rotation_variant: 0, code: 1 };

const obs = { entities: [HUB, MINER, BAL, B27, B37], entity_count: 5, truncated: false, tick: 1, layer: "regular" };

/** connect 补的 3 格（实机坐标）。计划 bbox 外扩 2 格正好框住 (2,-7)(3,-7)。 */
const PLAN = {
    placements: [[1, -5], [1, -4], [1, -3]].map(([x, y]) => ({ uid: null, kind: "belt", variant: "default", x, y, rot: 180, rv: 0, code: 1 })),
    removes: [],
    source: "test",
    flows: null,
};

/* ═══════════ 1. acceptorOf 的两种 null 必须分开 ═══════════ */

test("acceptorOf: 单格 path + boundAcceptor='yes' ⇒ 推不出坐标（null），但游戏说有接收方", () => {
    const p = { cells: [[2, -7]], boundAcceptor: "yes" };
    assert.equal(acceptorOf(p), null, "单格无走向，坐标确实推不出来");
    /* 这一条是**事实记录**，不是断言正确性：acceptorOf 不回答「有没有接收方」。
       正因为如此，拿它判死端才会误报 —— 见下面的对拍。 */
    assert.equal(p.boundAcceptor, "yes", "但游戏的权威答案是「有」");
});

test("acceptorOf: boundAcceptor=null ⇒ null（真的没接收方）", () => {
    assert.equal(acceptorOf({ cells: [[2, -7]], boundAcceptor: null }), null);
});

/* ═══════════ 2. 降级分支：单格 + "yes" 不许判死端（本次修复） ═══════════ */

test("降级 L3：计划附近只有「单格 path + boundAcceptor='yes'」⇒ 不再误报死端", () => {
    const items = {
        pathCount: 2,
        paths: [
            { cells: [[2, -7]], boundAcceptor: "yes", itemsOnPath: 2 },
            { cells: [[3, -7]], boundAcceptor: "yes", itemsOnPath: 2 },
        ],
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, true, "这两段都有去处（游戏说的），不许判「货会堆在那里」：" + r.reason);
    assert.equal(r.degraded, true, "仍然是降级绿 —— 修复不是让它变成「完整验证」");
    assert.deepEqual(r.evidence.dead_ends, [], "dead_ends 必须为空");
    assert.equal(r.evidence.paths_with_acceptor, 2, "两段都记成「有接收方」");
});

/* ═══════════ 3. 反例（关键）：真的没接收方必须继续红 ═══════════ */

test("降级 L3 反例：boundAcceptor=null ⇒ 必须红（否则修法只是把假红换成假绿）", () => {
    const items = {
        pathCount: 1,
        paths: [{ cells: [[2, -7]], boundAcceptor: null, itemsOnPath: 2 }],
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, false, "没有接收方就是死端：" + r.reason);
    assert.equal(r.degraded, true, "红的理由仍来自降级检测");
    assert.equal(r.evidence.dead_ends.length, 1, "dead_ends 记 1 段");
    assert.deepEqual(r.evidence.dead_ends[0].head, [2, -7]);
});

test("降级 L3 反例：boundAcceptor 缺失（undefined）⇒ 必须红（不许 fail-open）", () => {
    const items = {
        pathCount: 1,
        paths: [{ cells: [[2, -7]], itemsOnPath: 0 }],     // 没有 boundAcceptor 字段
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, false, "key 缺失 === 不知道有没有接收方 ⇒ 不许当绿：" + r.reason);
    assert.equal(r.evidence.dead_ends.length, 1);
});

/* ═══════════ 4. 多格 path 的既有行为不许回退 ═══════════ */

test("降级 L3：多格 path 且 boundAcceptor=null ⇒ 仍红（既有判据不被削弱）", () => {
    const items = {
        pathCount: 1,
        paths: [{ cells: [[1, -4], [1, -3]], boundAcceptor: null, itemsOnPath: 1 }],
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, false, r.reason);
    assert.equal(r.evidence.dead_ends.length, 1);
});

test("降级 L3：多格 path 且 boundAcceptor 是坐标 ⇒ 绿（原本就正确，防回退）", () => {
    const items = {
        pathCount: 1,
        paths: [{ cells: [[1, -4], [1, -3]], boundAcceptor: [-2, -2], itemsOnPath: 1 }],
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.evidence.dead_ends, []);
});

/* ═══════════ 5. 本次计划产生的死端 vs 本来就在那里的死端 ═══════════
 *
 * 降级分支的覆盖范围是「计划 bbox 外扩 flowPad 格」。计划外 10 格的死端**不在**里面，
 * 这既有设计（覆盖范围小是降级自曝的原因），不许因为修 (c) 而扩大范围。
 */
test("降级 L3：计划 bbox 之外的真死端不影响结论（覆盖范围不变，仍靠 degraded 自曝）", () => {
    const items = {
        pathCount: 2,
        paths: [
            { cells: [[2, -7]], boundAcceptor: "yes", itemsOnPath: 2 },
            { cells: [[20, 20]], boundAcceptor: null, itemsOnPath: 0 },   // 远处死端，不在 bbox 内
        ],
        truncatedPaths: false,
    };
    const r = checkFlow(PLAN, obs, items, { flows: [] });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.degraded, true, "仍然降级：远处的死端没被检查，这一点必须继续自曝");
});
