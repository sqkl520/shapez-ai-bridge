/**
 * belt_only_flows.test.mjs — 纯带子计划（connect / extend_line）必须能派生出真正的 flow。
 *
 * ## 实机 bug（受控实验，2026-10-31）
 *
 * 半成品世界里 loop 的唯一动作是 `connect(B34 → H1)`（把矿机输出带的断头接进 hub）：
 *
 *     apply:  tx_ok=true, applied:3, diff.added:3     ← 世界真写进去了
 *     L0/L1/L2/L4  全绿
 *     L3-flow:  ok=false, degraded=true
 *               "计划附近有 2 段带子没有去处（[2,-7]..[2,-7]，1 格）—— 货会堆在那里"
 *
 * 而 `(2,-7)` 是矿机输出带、连到 balancer `(2,-8)`，跟这次 connect 补的
 * `(1,-5)(1,-4)(1,-3)` **毫无关系**。`strictVerdict` 对 `degraded === true` 一律判红
 * （verify.mjs:305），于是「唯一正确的计划」被判失败。
 *
 * 根因：`deriveFlows` 只从**机器输出槽**起手，`connect` / `extend_line` 铺的是纯带子、
 * 没有机器 ⇒ `flows = []` ⇒ L3 走「无显式 flows」的降级分支。
 *
 * ## 本文件守的两件事
 *
 * 1. **正例**：`connect(from,to)` 与 `extend_line(from,len)` 自己就声明了一条路线，
 *    必须能变成一条 flow —— 端点由 cells 的**真实几何**走出来的实体，不是宏的说法。
 * 2. **反例 D/E 必须先红**：修「没有 flow」最容易滑成「编一条 flow」。所以链被篡改、
 *    或者末端落在空格/死端带子上时，必须产出 **0 条** flow。
 *
 * 夹具几何全部先用**真宏**跑过（`connect` / `extendLine`），坐标不是手算的：
 *   hub  (-2,-2) 4×4  ⇒ 本体覆盖 x∈[-2,1], y∈[-2,1]
 *   miner (1,7)       ⇒ 输出槽 approach 格 (1,6)
 *   belt  (1,6)(1,5)  ⇒ r=0/rv=0，出口朝 top
 *   connect(from=(1,5)) ⇒ cells (1,4)(1,3)(1,2)，最后一格出口朝 top ⇒ 进 hub 本体 (1,1)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveFlows } from "./planToTxOps.mjs";
import { checkFlow } from "../verify_runtime.mjs";
import { connect } from "../macros/connect.mjs";
import { extendLine } from "../macros/place.mjs";

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const HUB = { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" };

/** 矿机 → 两格带子。`at` 让同一套几何平移到别的列（反例要用到）。 */
function sourceWorld(at = 1) {
    return {
        hub: HUB,
        miner: { uid: 20100, type: "miner", x: at, y: 7, r: 0, variant: "default", rotation_variant: 0, code: 7, layer: "regular" },
        b6: { uid: 20101, type: "belt", x: at, y: 6, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
        b5: { uid: 20102, type: "belt", x: at, y: 5, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    };
}
const obsOf = (...ents) => ({ entities: ents, entity_count: ents.length, truncated: false, tick: 1, layer: "regular" });

/** 宏结果 → deriveFlows 认识的 placements（与 planToTxOps 的 collectPlaces 同形）。 */
function placementsOf(result, macro) {
    return result.cells.map(c => ({
        kind: c.building || "belt", variant: c.variant || "default",
        x: c.x, y: c.y, rot: c.rotation, rv: c.rotationVariant,
        uid: null, token: null, cells: [[c.x, c.y]], macro,
    }));
}

const itemsWithHub = () => ({
    pathCount: 1,
    paths: [{
        /* `reach()` 用 `startAt` 按 path 的**首格**索引，而 flow.from 是矿机（uid 20100）。
           矿机的输出格是 (1,6)，所以这条 path 必须**从 (1,6) 起手**才能被 reach 找到 ——
           真实游戏里从矿机到 hub 本来就是一条连续的 path，不是只有最后 3 格。
           `boundAcceptor` 用 hub 的 origin（mod 真实语义：报 `StaticMapEntity.origin`）。 */
        cells: [[1, 6], [1, 5], [1, 4], [1, 3], [1, 2]], boundAcceptor: [-2, -2], itemsOnPath: 3,
    }],
    truncatedPaths: false,
});

/* ═══════════ 0. 夹具自检：几何来自真宏，不是手算 ═══════════ */

test("0. 夹具：connect(from=(1,5) → H1) 真的铺出 (1,4)(1,3)(1,2)，且 3 格都朝 top", () => {
    const w = sourceWorld();
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } },
        { entities: [w.hub, w.miner, w.b6, w.b5] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.cells.map(c => [c.x, c.y]), [[1, 4], [1, 3], [1, 2]]);
    for (const c of r.cells) assert.equal(c.rotationVariant, 0, "直带 rv=0");
});

test("0b. 夹具：extend_line(from=(1,5), len=3) 铺出同一组格子", () => {
    const w = sourceWorld();
    const r = extendLine({ from: { uid: w.b5.uid }, len: 3 }, { entities: [w.hub, w.miner, w.b6, w.b5] });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual(r.cells.map(c => [c.x, c.y]), [[1, 4], [1, 3], [1, 2]]);
    assert.equal(r.terminal_orphaned, false, "末端真的有接收方（hub）");
});

/* ═══════════ A. 正例：纯 connect 必须产出 ≥1 条 flow，to 是 hub ═══════════ */

test("A. 纯 connect 计划：deriveFlows 产出 1 条 flow，from=矿机、to=hub", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    assert.equal(r.ok, true, JSON.stringify(r.error));

    const flows = deriveFlows(placementsOf(r, "connect"), obs, null);
    assert.equal(flows.length, 1, "纯带子 connect 必须派生出一条 flow（修复前是 []）: " + JSON.stringify(flows));
    const f = flows[0];
    assert.equal(f.to, HUB.uid, "flow.to 必须是 hub 的 uid（不是带子）");
    assert.equal(f.from, w.miner.uid, "flow.from 必须走到链首的**实体**（矿机），不是带子 —— reach() 从带子起手找不到 path");
    assert.equal(f.via, "chain", "via 沿用既有闭集 chain/adjacent/paths（没有 connect 这一档）");
    assert.equal(f.via_slot, "out", "via_slot 是链首实体的输出槽角色（miner.out）");
    assert.ok(Array.isArray(f.from_token) || f.from_token === undefined, "计划态端点才带 token");
});

test("A2. 同一条 flow 喂给 checkFlow：非 degraded、判绿", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    const flows = deriveFlows(placementsOf(r, "connect"), obs, null);

    const plan = { placements: placementsOf(r, "connect"), removes: [], flows: null };
    const l3 = checkFlow(plan, obs, itemsWithHub(), { flows });
    assert.equal(l3.degraded, undefined, "有显式 flows 就不是降级检查：" + l3.reason);
    assert.equal(l3.ok, true, "货流沿游戏自己的 path 走得到 hub：" + l3.reason);
    assert.equal(l3.evidence.reached, 1);
});

/* ═══════════ B. 正例：connect + insert_machine 混合 ⇒ 两类 flow 都要有 ═══════════ */

test("B. connect + insert_machine：机器槽 flow 与 connect 的端点 flow 同时存在", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    const chain = placementsOf(r, "connect");

    /* 计划里另外放一台 cutter(5,0) + trash(5,-1)：cutter.left 的 approach 格就是 (5,-1) */
    const cutter = { kind: "cutter", variant: "default", x: 5, y: 0, rot: 0, rv: 0, uid: null, token: "im:cutter", cells: [[5, 0], [6, 0]], macro: "insert_machine" };
    const trash = { kind: "trash", variant: "default", x: 5, y: -1, rot: 0, rv: 0, uid: null, token: "im:trash", cells: [[5, -1]], macro: "insert_machine" };

    const flows = deriveFlows([cutter, trash, ...chain], obs, null);
    const machineFlow = flows.find(f => f.via_slot === "left");
    const chainFlow = flows.find(f => f.via === "chain");

    assert.ok(machineFlow, "机器输出槽的 flow 仍在：" + JSON.stringify(flows));
    assert.equal(machineFlow.to_token, "im:trash", "cutter.left → 直贴的 trash");
    assert.ok(chainFlow, "connect 的端点 flow 也在：" + JSON.stringify(flows));
    assert.equal(chainFlow.to, HUB.uid);
    assert.equal(flows.length, 2, "两条 flow，不多不少（没有重复、没有自环）");
});

/* ═══════════ C. 正例：extend_line 同理（它也是纯带子） ═══════════ */

test("C. 纯 extend_line 计划：同样派生出一条到 hub 的 flow", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = extendLine({ from: { uid: w.b5.uid }, len: 3 }, { entities: obs.entities });
    assert.equal(r.ok, true, JSON.stringify(r.error));

    const flows = deriveFlows(placementsOf(r, "extend_line"), obs, null);
    assert.equal(flows.length, 1, "extend_line 也必须派生 flow：" + JSON.stringify(flows));
    assert.equal(flows[0].from, w.miner.uid);
    assert.equal(flows[0].to, HUB.uid);
    assert.equal(flows[0].via, "chain");
});

test("C2. 反例：extend_line 延到空地里（terminal_orphaned）⇒ 0 条 flow", () => {
    const w = sourceWorld(10);          // 平移一列，远离 hub
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = extendLine({ from: { uid: w.b5.uid }, len: 3 }, { entities: obs.entities });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.terminal_orphaned, true, "前提：这次延长确实接了空 —— 宏自己说了");

    const flows = deriveFlows(placementsOf(r, "extend_line"), obs, null);
    assert.deepEqual(flows, [], "末端没有接收方 ⇒ 不许凭空造 flow");
});

/* ═══════════ D. 反例（关键）：cells 被篡改（链断一格）⇒ 0 条 flow ═══════════ */

test("D. 篡改版 cells（中间缺一格）：链断了 ⇒ 0 条 flow，且不报「到达 hub」", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    const cells = r.cells.filter(c => !(c.x === 1 && c.y === 3));    // 挖掉中间那格
    assert.deepEqual(cells.map(c => [c.x, c.y]), [[1, 4], [1, 2]], "篡改后的链：(1,4) 与 (1,2) 不相连");

    const flows = deriveFlows(placementsOf({ cells }, "connect"), obs, null);
    assert.deepEqual(flows, [], "链断了就不能说「到 hub 了」：" + JSON.stringify(flows));
});

test("D2. 篡改版 cells（上游被抹掉）：链首上游是空格 ⇒ 0 条 flow", () => {
    const w = sourceWorld();
    /* 上游两格带子不在 obs 里 ⇒ 链首 (1,4) 的 entry 指向 (1,5)，那里什么都没有 */
    const obs = obsOf(w.hub, w.miner);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: [w.hub, w.miner, w.b6, w.b5] });
    const flows = deriveFlows(placementsOf(r, "connect"), obs, null);
    assert.deepEqual(flows, [], "源实体解析不到 ⇒ 不许编 flow：" + JSON.stringify(flows));
});

/* ═══════════ E. 反例（关键）：`to` 是个死端格 ⇒ 0 条 flow ═══════════ */

test("E1. 链完整但末端出口是空格：to 解析不到实体 ⇒ 0 条 flow", () => {
    const w = sourceWorld(10);          // 平移一列：cells (10,4)(10,3)(10,2)，出口朝 (10,1) 空地
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: [w.hub, w.miner, w.b6, w.b5] });
    /* 前提已变：portsOf/slotsOf 修好带子方向后，connect 在平移世界也能接到 hub。
       E1 要测的是「链末端是空格 ⇒ 不产 flow」，与 connect 能否成功无关，所以改为断言它成功。 */
    assert.equal(r.ok, true, "前提：修复后 connect 在这个几何下也能接到 hub");

    /* 手工按同一套几何编一条「声称接上了」的 cells —— 正是反例要拦的形态 */
    const cells = [
        { x: 10, y: 4, building: "belt", rotation: 0, rotationVariant: 0, code: 1 },
        { x: 10, y: 3, building: "belt", rotation: 0, rotationVariant: 0, code: 1 },
        { x: 10, y: 2, building: "belt", rotation: 0, rotationVariant: 0, code: 1 },
    ];
    const flows = deriveFlows(placementsOf({ cells }, "connect"), obs, null);
    assert.deepEqual(flows, [], "末端是空格 ⇒ 不许造 flow（否则 L3 会拿一条假 flow 判红/判绿）");
});

test("E2. 链完整但末端接到的是一段**死端带子**（不是机器/hub/trash）⇒ 0 条 flow", () => {
    const w = sourceWorld();
    /* (1,1) 放一条朝 top 的带子，它的出口 (1,0) 也是空的 ⇒ 链一路走到底仍是死端 */
    const deadBelt = { uid: 20103, type: "belt", x: 1, y: 1, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" };
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5, deadBelt);
    /* 注意：hub 本体覆盖 (1,1)，所以这里把 hub 挪开，只留下那条死端带子 */
    const obsNoHub = obsOf({ ...w.hub, uid: 10001, x: -20, y: -20 }, w.miner, w.b6, w.b5, deadBelt);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    assert.equal(r.ok, true, "前提：夹具世界里 connect 能算出 3 格");
    assert.deepEqual(r.cells.map(c => [c.x, c.y]), [[1, 4], [1, 3], [1, 2]]);

    const flows = deriveFlows(placementsOf(r, "connect"), obsNoHub, null);
    assert.deepEqual(flows, [], "末端停在死端带子上 ⇒ 不许造 flow：" + JSON.stringify(flows));
});

test("E3. 对照：同一条链，末端换成真 hub ⇒ 又有 flow（证明 E1/E2 不是「什么都不产出」的假红）", () => {
    const w = sourceWorld();
    const obs = obsOf(w.hub, w.miner, w.b6, w.b5);
    const r = connect({ from: { uid: w.b5.uid }, to: { hub: { uid: w.hub.uid } } }, { entities: obs.entities });
    const flows = deriveFlows(placementsOf(r, "connect"), obs, null);
    assert.equal(flows.length, 1, "对照组必须产出 1 条 flow");
    assert.equal(flows[0].to, HUB.uid);
});

/* ═══════════ F. 不许自环、不许重复 ═══════════ */

test("F. connect 的链首实体与链尾实体相同（绕一圈回到自己）⇒ 0 条 flow", () => {
    /* 造一个「带子绕回自己的输出槽」的世界：矿机 → 带子 → 绕回矿机本体格 */
    const miner = { uid: 20200, type: "miner", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 7, layer: "regular" };
    const b = { uid: 20201, type: "belt", x: 0, y: -1, r: 180, variant: "default", rotation_variant: 0, code: 1, layer: "regular" };
    const obs = obsOf(miner, b);
    /* 只有一格带子，entry 朝 (0,0)=矿机（head=矿机），exit 也朝 (0,0)（tail=矿机）⇒ 自环 */
    const cells = [{ x: 0, y: -1, building: "belt", rotation: 180, rotationVariant: 0, code: 1 }];
    const flows = deriveFlows(placementsOf({ cells }, "connect"), obs, null);
    assert.deepEqual(flows, [], "from===to 的自环必须丢弃（checkFlow.reach() 从 from 起手会恒绿）");
});
