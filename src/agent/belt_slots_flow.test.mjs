/**
 * belt_slots_flow.test.mjs — 两个堵点的回归：`slotsOf` 认识带子、`deriveFlows` 认识纯带子计划。
 *
 * 实测的两个红（修前）：
 *   1. `slotsOf('belt','default',1,-5,0)` → `{footprint:[1,1],inputs:[],outputs:[]}`（全空）
 *      ⇒ `checkFlow.reach()` 无法从带子起手；`connect`/`extend_line` 铺的纯带子计划永远没 flow。
 *   2. `deriveFlows(3格带子的placements, before, null)` → `[]`
 *      ⇒ `flowsProvided:false` ⇒ `strictVerdict` 硬红（FLOW_UNVERIFIED）。
 *
 * 反例同样重要：带子链是死端时**不许**凭空造一条「到达 hub」的 flow。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { slotsOf, checkFlow, beltRvOf } from "./verify_runtime.mjs";
import { deriveFlows } from "./loop/planToTxOps.mjs";
import { beltExit, beltEntry, DIRV } from "../ai/belt-rules.mjs";

const K = c => `${c[0]},${c[1]}`;

/* ═══════════ 1. slotsOf 对带子：12 组 (r, rv) 必须与 beltExit/beltEntry 一致 ═══════════ */
test("slotsOf(belt): 4 种 r × 3 种 rv 的入口/出口与 belt-rules 完全一致", () => {
    for (const r of [0, 90, 180, 270]) {
        for (const rv of [0, 1, 2]) {
            const x = 7, y = -5;
            const s = slotsOf("belt", "default", x, y, r, rv);
            const tag = `r=${r} rv=${rv}`;
            assert.ok(s, `${tag}: slotsOf 不能返回 null`);
            assert.deepEqual(s.footprint, [1, 1], `${tag}: footprint 必须是 [1,1]`);
            assert.equal(s.inputs.length, 1, `${tag}: 带子恰有 1 个入口`);
            assert.equal(s.outputs.length, 1, `${tag}: 带子恰有 1 个出口`);

            const inDir = beltEntry(rv, r), outDir = beltExit(rv, r);
            const i0 = s.inputs[0], o0 = s.outputs[0];
            assert.equal(i0.dir, inDir, `${tag}: 入口方向`);
            assert.equal(o0.dir, outDir, `${tag}: 出口方向`);
            assert.deepEqual(i0.slot, [x, y], `${tag}: 入口本体格 = 带子自己那格`);
            assert.deepEqual(o0.slot, [x, y], `${tag}: 出口本体格 = 带子自己那格`);
            /* cell = slot + DIRV[dir]：出口 cell 是货**离开后进入的那一格**，
               也是游戏 path 的 cells[0] —— checkFlow.reach() 靠它对上 path。 */
            assert.deepEqual(i0.cell, [x + DIRV[inDir][0], y + DIRV[inDir][1]], `${tag}: 入口 approach 格`);
            assert.deepEqual(o0.cell, [x + DIRV[outDir][0], y + DIRV[outDir][1]], `${tag}: 出口 approach 格`);
        }
    }
});

test("slotsOf(belt): rv 缺省时按 rv=0 算（与 portSlots 的钳制口径一致），与显式 rv=0 同值", () => {
    for (const r of [0, 90, 180, 270]) {
        const a = slotsOf("belt", "default", 3, 3, r);
        const b = slotsOf("belt", "default", 3, 3, r, 0);
        assert.deepEqual(a, b, `r=${r}: 缺省 rv 必须等价于 rv=0`);
    }
    /* 越界 rv 不静默算出垃圾方位：退回 rv=0 */
    assert.deepEqual(slotsOf("belt", "default", 3, 3, 0, 9), slotsOf("belt", "default", 3, 3, 0, 0),
        "rv=9 越界 ⇒ 退回 rv=0");
});

test("beltRvOf: rotation_variant 优先，其次 code-1；都没有 ⇒ null（不猜）", () => {
    assert.equal(beltRvOf({ rotation_variant: 2, code: 1 }), 2);
    assert.equal(beltRvOf({ code: 3 }), 2);
    assert.equal(beltRvOf({ rv: 1 }), 1);
    assert.equal(beltRvOf({}), null);
    assert.equal(beltRvOf({ rotation_variant: 0 }), 0);
});

/* ═══════════ 2. 反例：机器的 slotsOf 一个字段都不许变 ═══════════ */
test("反例：cutter / miner 的 slotsOf 结果不变（防误伤机器路径）", () => {
    const cutter = slotsOf("cutter", "default", 4, -17, 0);
    assert.deepEqual(cutter.footprint, [2, 1]);
    assert.deepEqual(cutter.inputs, [
        { role: "primary", slot: [4, -17], dir: "bottom", cell: [4, -16] },
    ]);
    assert.deepEqual(cutter.outputs, [
        { role: "left", slot: [4, -17], dir: "top", cell: [4, -18] },
        { role: "right", slot: [5, -17], dir: "top", cell: [5, -18] },
    ]);

    const miner = slotsOf("miner", "default", 2, -6, 0);
    assert.deepEqual(miner.footprint, [1, 1]);
    assert.deepEqual(miner.inputs, []);
    assert.deepEqual(miner.outputs, [{ role: "out", slot: [2, -6], dir: "top", cell: [2, -7] }]);

    /* 多带一个 rv 参数也不能改变机器结果（beltRvOf 对机器返回 null） */
    const cutter2 = slotsOf("cutter", "default", 4, -17, 0, beltRvOf({ rotation_variant: 2 }));
    assert.deepEqual(cutter2, cutter, "机器不吃 rv");

    /* 没有模板的建筑仍然 null（隧道不是带子） */
    assert.equal(slotsOf("underground_belt", "default", -7, -12, 0), null);
});

/* ═══════════ 3. checkFlow.reach() 能从带子起手 ═══════════
 *
 * 修前：belt 的 outputs 为空 ⇒ trail 恒为 [] ⇒ reached 0。
 */
{
    const hub = { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26 };
    /* (1,-5) 的带子朝 top（rv0,r0）⇒ 出口 (1,-6)；(1,-6) 再朝 top ⇒ (1,-7) …到 hub 本体。
       这里只用「带子 → path」这一跳来证明 reach 能从带子起手。 */
    const belt = { uid: 20000, type: "belt", x: 1, y: -5, r: 0, variant: "default", rotation_variant: 0, code: 1 };
    const obs = { entities: [hub, belt] };
    const items = { pathCount: 1, paths: [{ cells: [[1, -6], [1, -5]], boundAcceptor: [-2, -2] }] };
    const plan = { placements: [{ kind: "belt", variant: "default", x: 1, y: -5, rot: 0, rv: 0 }] };

    test("checkFlow: flow.from 是带子（不是机器）也能走到 hub", () => {
        const r = checkFlow(plan, obs, items, { flows: [{ from: 20000, to: 10000 }] });
        assert.equal(r.ok, true, r.reason);
        assert.equal(r.evidence.reached, 1);
        assert.equal(r.evidence.last_trail.length, 1, "必须真的走了一条 path，不是靠 from===to 恒绿");
        assert.equal(r.degraded, undefined, "给了 flows ⇒ 不是降级绿");
    });
}

/* ═══════════ 4. deriveFlows：纯 connect 计划必须产出 flow，to 是 hub ═══════════
 *
 * 夹具几何（与 .tmpverify/final-half/probe-obs.json 同形：miner → 带链 → hub）：
 *   miner @(1,-7)，出口格 (1,-8)；
 *   本轮新铺 (1,-8..-16) 朝 top（r=0, rv=0）的带子；
 *   hub @(-2,-20) 4×4 ⇒ 本体覆盖 x∈[-2,1]、y∈[-20,-17] ⇒ (1,-17) 是第一格本体。
 *
 * ★ 起点是**整条链的链首之前的机器**（miner），不是紧邻新带子的那格 ★
 *   游戏给一段带子跑的 path 是整段：`cells[0]` 是货**进入这一段**的格。
 *   所以 from 必须是链首（miner），它的 out.cell 才是 cells[0]。
 */
const HUB = { uid: 10000, type: "hub", x: -2, y: -20, r: 0, variant: "default", rotation_variant: 0, code: 26 };
const MINER = { uid: 10505, type: "miner", x: 1, y: -7, r: 0, variant: "default", rotation_variant: 0, code: 7 };
const connectPlan = (ys) => ys.map((y, i) => ({
    kind: "belt", variant: "default", x: 1, y, rot: 0, rv: 0,
    uid: null, token: null, cells: [[1, y]], macro: "connect", callIndex: 0, pathIndex: i,
}));
const FULL = [-8, -9, -10, -11, -12, -13, -14, -15, -16];

test("deriveFlows: 纯 connect 计划（9 格新带子接到 hub）产出 1 条 flow，to 是 hub", () => {
    const flows = deriveFlows(connectPlan(FULL), { entities: [HUB, MINER] }, null);
    assert.equal(flows.length, 1, "纯带子计划必须产出 1 条 flow（修前恒 []）: " + JSON.stringify(flows));
    const f = flows[0];
    assert.equal(f.to, 10000, "flow.to 必须是 hub 的 uid，不能是带子");
    assert.equal(f.from, 10505, "flow.from 是链首的机器（新带子还没有 uid，当不了端点）");
    assert.equal(f.via, "chain");
    assert.equal(f.via_slot, "out", "上游是 miner ⇒ role=out（与机器槽同形的形状）");
    /* 端点不能是带子 token（connect 的 cells 没有 token） */
    assert.equal(f.to_token, undefined);
    assert.ok(!String(f.to).startsWith("b"), "没有以带子为终点的 flow");
});

test("deriveFlows: 新带子直接接在机器喷口上 ⇒ from 是那台机器（带 role）", () => {
    /* miner@(2,-6) 的 out 格是 (2,-7)（slotsOf 核对过）。带子从 (2,-7) 起朝 top（rot 0，出口 y-1）
       一路铺到 (2,-10)，下一格 (2,-11) 放一台已有的 trash。
       注意入口必须朝 bottom 才接得住 miner 的 top 喷口 ⇒ rot=0, rv=0。 */
    const miner = { uid: 10505, type: "miner", x: 2, y: -6, r: 0, variant: "default", rotation_variant: 0, code: 7 };
    const belts = [-7, -8, -9, -10].map((y, i) => ({
        kind: "belt", variant: "default", x: 2, y, rot: 0, rv: 0,
        uid: null, token: null, cells: [[2, y]], macro: "connect", callIndex: 0, pathIndex: i,
    }));
    const trash = { uid: 30000, type: "trash", x: 2, y: -11, r: 0, variant: "default", rotation_variant: 0, code: 20 };
    const flows = deriveFlows(belts, { entities: [HUB, miner, trash] }, null);
    assert.equal(flows.length, 1, "4 格新带子只产 1 条 flow（不按格重复）");
    assert.equal(flows[0].from, 10505, "from = 喷货的机器");
    assert.equal(flows[0].to, 30000, "to = 链尾的实体");
    assert.equal(flows[0].via_slot, "out", "机器路径给出的 role");
});

/* ═══════════ 5. 反例：死端不许造 flow ═══════════
 *
 * 口径：**不产 flow**（不是「产出但 to 为 null」）。
 * 理由：`deriveFlows` 的返回直接喂给 `checkFlow`；带 `to:null` 的条目只会被记成
 * 「to 不存在」，把「本来就没接上」伪装成「端点解析失败」，两种红混在一起就失去诊断价值。
 * 死端该由 `OUTPUT_UNROUTED` / L3 的 dead_ends 报。
 */
test("反例：新带子链走出世界（死端）⇒ deriveFlows 不产 flow", () => {
    /* 只铺到 (1,-10)，(1,-11) 是空的：链在这里断，离 hub 本体 (1,-17) 还差 7 格 */
    const flows = deriveFlows(connectPlan([-8, -9, -10]), { entities: [HUB, MINER] }, null);
    assert.deepEqual(flows, [], "死端不许凭空造一条到达 hub 的 flow");

    /* 差异只是「有没有铺到 hub」：铺满就产 flow —— 证明上面的 [] 不是「功能没生效」 */
    const okFlows = deriveFlows(connectPlan(FULL), { entities: [HUB, MINER] }, null);
    assert.equal(okFlows.length, 1, "（对照）铺满必须产出 1 条 flow");
});

test("反例：新带子链绕回自己 ⇒ 不产 flow", () => {
    /* 一条朝 bottom 的带子 (1,-8)：入口朝 top、上游是 miner ⇒ from 会解析成功；
       但出口朝 bottom 走到 (1,-7)，那是 miner 本体格 ⇒ from===to，必须丢弃。 */
    const back = {
        kind: "belt", variant: "default", x: 1, y: -8, rot: 180, rv: 0,
        uid: null, token: null, cells: [[1, -8]], macro: "connect", callIndex: 0, pathIndex: 0,
    };
    const flows = deriveFlows([back], { entities: [HUB, MINER] }, null);
    assert.deepEqual(flows, [], "自环不许产出 flow（checkFlow 的 reach 从 from 起手会恒绿）");
});

test("反例：链头悬空（上游没有实体）⇒ 不产 flow", () => {
    /* (5,-9) 起铺三格朝 top，上游 (5,-8) 是空的 */
    const belts = [-9, -10, -11].map((y, i) => ({
        kind: "belt", variant: "default", x: 5, y, rot: 0, rv: 0,
        uid: null, token: null, cells: [[5, y]], macro: "connect", callIndex: 0, pathIndex: i,
    }));
    const flows = deriveFlows(belts, { entities: [HUB, MINER] }, null);
    assert.deepEqual(flows, [], "没有源头（from 不可解析）⇒ 不产 flow");
});

/* ═══════════ 6. 端到端：deriveFlows → checkFlow 全链 ═══════════
 *
 * items 用任务书给的真实形状（半成品世界里的那段带子 path）：
 *   {cells:[[1,-5],[1,-4],[1,-3]], boundAcceptor:[-2,-2]}。
 * 修前：deriveFlows=[] ⇒ checkFlow 只能走降级分支 ⇒ strict 的 flowsProvided=false 硬红。
 */
test("端到端：纯 connect 计划 deriveFlows + checkFlow → ok===true", () => {
    /* 实测存档的几何：B34=带子@(1,-6) r=180 ⇒ 出口 (1,-5)；新铺 (1,-5)(1,-4)(1,-3)；
       hub@(-2,-2) 4×4 ⇒ (1,-2) 是第一格本体。 */
    const hub2 = { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26 };
    const miner2 = { uid: 10505, type: "miner", x: 1, y: -7, r: 0, variant: "default", rotation_variant: 0, code: 7 };
    const b34 = { uid: 10538, type: "belt", x: 1, y: -6, r: 180, variant: "default", rotation_variant: 0, code: 1 };
    const obs = { entities: [hub2, miner2, b34] };
    const places = connectPlan([-5, -4, -3]).map(p => ({ ...p, rot: 180 }));
    const flows = deriveFlows(places, obs, null);
    assert.equal(flows.length, 1, "派生不出 flow 就谈不上验证: " + JSON.stringify(flows));
    assert.equal(flows[0].from, 10505, "链首是 miner（B34 的上游还有两格 obs 里的带子）");

    /* items 用任务书给的真实形状：接收方坐标是显式给的 [-2,-2]。
       （给 "yes" 时 acceptorOf 会从末两格外推，形状不同、结论也不同 —— 别混。）
       hub 的 origin 是 (-2,-2)，path 落到 (1,-2) 是它的**本体第二格** ——
       checkFlow 必须按 footprint 认 hub（只按 origin 查会漏，reached 恒 0）。

       ★ 两条 path：游戏给**每一段**带子各发一条 path，不是整条线一条 ★
         path1：miner 喷口 (1,-8) → 两格 → 落在 B34@(1,-6)
         path2：B34 的出口 (1,-5) → 新铺三格 → 落在 hub (-2,-2)
       少给 path1，「从 miner 起手」这一步就走不动 —— 这正是 reach 的真实口径。 */
    const items = {
        pathCount: 2,
        paths: [
            { cells: [[1, -8], [1, -7]], boundAcceptor: "yes", itemsOnPath: 0 },
            { cells: [[1, -5], [1, -4], [1, -3]], boundAcceptor: [-2, -2], itemsOnPath: 0 },
        ],
    };
    const plan = { placements: places.map(p => ({ kind: p.kind, variant: p.variant, x: p.x, y: p.y, rot: p.rot, rv: p.rv })) };
    const r = checkFlow(plan, obs, items, { flows });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.evidence.reached, 1);
    assert.equal(r.degraded, undefined, "有显式 flows ⇒ 不是降级绿");
});
