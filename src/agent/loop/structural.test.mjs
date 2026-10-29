/**
 * structural.test.mjs — `loop/structural.mjs` 的验收（P-a0）。
 *
 * 这 10 条对应**基线文档的 5 条必要条件 + 3 条几何回归 + 2 条工程约束**：
 *
 *   1. L4 出口为空的带子恰好 2 条 —— 用 footprint 索引（10008、10193）
 *   2. 删掉全部矿机 ⇒ 必须报 `RAW_MATERIAL_MISSING`，且至少 1 条 `CHAIN_UNFED`
 *   3. 删掉全部 trash ⇒ 必须报 `WASTE_NO_SINK`
 *   4. L4 冷启动 ⇒ 至少一条 subject 在 x∈{2,3,4,5} 链上的诊断
 *   5. 隧道不被误判 —— 无 `DEAD_END` 指向隧道；cutter 右口跑链终点是 trash
 *   6. 2×1 机器入口判据（真实结果是 10024 与 10030 都命中，任务书的数字对不上，见测试内注释）
 *   7. 负例：把 L4 的 2 条死端补上 ⇒ 0 条 blocker 级结构码
 *   8. 坐标禁令
 *   9. 确定性（同一份 obs 两次调用逐字节相同）
 *  10. 上限（每码 ≤3，总量 ≤8，超出记 `evidence.suppressed`）
 *
 * 运行：`node --test src/agent/loop/structural.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { structuralDiagnoses, LIMITS } from "./structural.mjs";
import { indexOf, at, exitCellOf, exitDirOf, isTunnel, K, hubReachable } from "./topology.mjs";
import { buildHandles } from "./handles.mjs";
import { slotsOf } from "../verify_runtime.mjs";
import { DIAG_CODES } from "./constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const load = f => JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8")).result;

const L4 = load("L4-obs.json");
const L5 = load("L5-obs.json");
const L5_ITEMS = JSON.parse(fs.readFileSync(path.join(SAVES, "L5-items.json"), "utf8")).result;

const goalOf = obs => (obs.goal && obs.goal.requirement && obs.goal.requirement.shape) || null;
const handlesOf = obs => buildHandles(obs, null);

/** 深拷贝一份 obs（改世界用；不改夹具）。 */
const clone = obs => JSON.parse(JSON.stringify(obs));

/**
 * 极简配方对象：`RAW_MATERIAL_MISSING` 只需要知道「配方里有一步 mine」。
 * 刻意**不调用 solver**（`solveRecipe` 会 spawn 子进程，`structural.mjs` 自己不许有副作用，
 * 测试也不该为了一个布尔值去跑外部程序）。
 */
const RECIPE_NEEDS_MINE = { ok: true, steps: [{ hash: "RuRuRuRu", op: "mine", args: {}, inputs: [] }] };

const run = (obs, opts = {}) =>
    structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs), opts);

const codes = ds => ds.map(d => d.code);
const byCode = (ds, code) => ds.filter(d => d.code === code);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. L4 死端恰好 2 条（footprint 索引）
 * ══════════════════════════════════════════════════════════════════════════ */

test("T1 ★ L4 冷启动：DEAD_END 恰好 2 条，且就是 10008/10193", () => {
    const ds = run(L4);
    const dead = byCode(ds, "DEAD_END");
    assert.equal(dead.length, 2, "footprint 索引下只有 2 条（origin 索引会给 8 条）");
    const uids = dead.map(d => d.evidence.uids[0]).sort((a, b) => a - b);
    assert.deepEqual(uids, [10008, 10193]);
});

test("T1 ★ L5 冷启动：DEAD_END 同样是 2 条（10008/10193）", () => {
    const ds = run(L5);
    const uids = byCode(ds, "DEAD_END").map(d => d.evidence.uids[0]).sort((a, b) => a - b);
    assert.deepEqual(uids, [10008, 10193]);
});

test("T1 ★ 反例：用 origin 级索引时，同一判据会给出 8 条 —— 这就是主线程错过三次的那个点", () => {
    /* 这里**故意**不调 `structuralDiagnoses`（它用 footprint 索引），而是手算一遍 origin 级。
       如果哪天有人把 `indexOf` 的 footprint 展开删掉，上面的 T1 会立刻变红。
       ⚠️ 设计文档说「多出的 6 条全是出口落进 hub 4×4 占地」—— **不准确**。
       实测：2 条是 hub（4×4）、4 条是 **2×1 balancer 的第二格**。
       footprint 索引必须对**所有**非方形建筑生效，不能只给 hub 特判。 */
    const idx = indexOf(L4);
    const originOnly = new Set(L4.entities.map(e => K([e.x, e.y])));
    const dead = L4.entities.filter(e => e.type === "belt" && !originOnly.has(K(exitCellOf(e))));
    assert.equal(dead.length, 8);
    /* 8 条里真正没东西的只有 2 条；另外 6 条用 footprint 索引查得到实体。
       （第一条 filter 是恒真的 —— origin 级索引当然查不到这些格 —— 关键是第二条。） */
    const missed = dead
        .map(e => ({ uid: e.uid, cell: exitCellOf(e), real: at(idx, exitCellOf(e)) }))
        .filter(m => m.real !== null);
    assert.equal(missed.length, 6, "这 6 条是 origin 索引漏掉的（footprint 索引下它们有接收方）");
    const byType = {};
    for (const m of missed) byType[m.real.type] = (byType[m.real.type] || 0) + 1;
    assert.deepEqual(byType, { hub: 2, balancer: 4 });
    for (const m of missed) assert.ok(["hub", "balancer"].includes(m.real.type));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 删掉全部矿机
 * ══════════════════════════════════════════════════════════════════════════ */

test("T2 ★ 删掉全部矿机 ⇒ RAW_MATERIAL_MISSING 且至少 1 条 CHAIN_UNFED", () => {
    const obs = clone(L4);
    obs.entities = obs.entities.filter(e => e.type !== "miner");
    const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs), { recipe: RECIPE_NEEDS_MINE });

    const raw = byCode(ds, "RAW_MATERIAL_MISSING");
    assert.equal(raw.length, 1, "必须有且只有一条 RAW_MATERIAL_MISSING");
    assert.equal(raw[0].severity, "blocker");

    const unfed = byCode(ds, "CHAIN_UNFED");
    assert.ok(unfed.length >= 1, `至少 1 条 CHAIN_UNFED（实际 ${unfed.length}）`);
});

test("T2 对照：不删矿机时**不许**报 RAW_MATERIAL_MISSING", () => {
    const ds = run(L4, { recipe: RECIPE_NEEDS_MINE });
    assert.equal(byCode(ds, "RAW_MATERIAL_MISSING").length, 0);
});

test("T2 对照：配方不需要 mine 时，删光矿机也不报 RAW_MATERIAL_MISSING", () => {
    const obs = clone(L4);
    obs.entities = obs.entities.filter(e => e.type !== "miner");
    const noMine = { ok: true, steps: [{ hash: "RuRu----", op: "cut", args: { half: "right" }, inputs: [] }] };
    const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs), { recipe: noMine });
    assert.equal(byCode(ds, "RAW_MATERIAL_MISSING").length, 0,
        "这是**负例**：判据必须真的看配方，不是「矿机为 0 就报」");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 删掉全部 trash
 * ══════════════════════════════════════════════════════════════════════════ */

test("T3 ★ 删掉全部 trash ⇒ WASTE_NO_SINK（L5：cutter#10902 的左口直通 trash，删掉后断成空格）", () => {
    /* 为什么用 L5 而不是 L4：L4 那台 cutter 的废料口（left）走的是**通往 hub 的长链**，
       删掉 trash 之后它仍然接在 hub 上，所以「无去处」这个条件在 L4 上**不成立** ——
       这是判据正确，不是漏报。L5 多了一台 cutter#10902，它的左口直接怼着 trash#10901，
       删掉 trash 后跑链终点是 empty，才是真正的 WASTE_NO_SINK 样本。 */
    const obs = clone(L5);
    obs.entities = obs.entities.filter(e => e.type !== "trash");
    const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs));

    const w = byCode(ds, "WASTE_NO_SINK");
    assert.ok(w.length >= 1, "必须报出「废料无去处」");
    assert.ok(w.every(d => d.severity === "blocker"));
    assert.ok(w.some(d => d.evidence.waste_role === "left"), "废料口是 left（op-templates 的 wasteRoles）");
    assert.equal(w[0].evidence.run_kind, "empty", "跑链终点是空格");
});

test("T3 对照：有 trash 时**不许**报 WASTE_NO_SINK（哪怕是噪音也该压住）", () => {
    const ds = run(L4);
    assert.equal(byCode(ds, "WASTE_NO_SINK").length, 0);
});

test("T3 ★ 删掉全部 trash + 全部矿机 ⇒ 两个码同时出现（不是互相掩盖）", () => {
    const obs = clone(L5);
    obs.entities = obs.entities.filter(e => e.type !== "trash" && e.type !== "miner");
    const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs), { recipe: RECIPE_NEEDS_MINE });
    assert.ok(byCode(ds, "WASTE_NO_SINK").length >= 1);
    assert.equal(byCode(ds, "RAW_MATERIAL_MISSING").length, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. L4 冷启动：subject 落在 x∈{2,3,4,5} 链上
 * ══════════════════════════════════════════════════════════════════════════ */

test("T4 ★ L4 冷启动：至少一条诊断的 subject 在 x∈{2,3,4,5} 的链上", () => {
    const ds = run(L4);
    const idx = indexOf(L4);
    /* 注意判据是 x∈{2,3,4,5}，**不是**只 x=4/5（v2 裁决 F-3：x=2 有 18 个可行位，x=5 是 0 个）。
       这里用「subject 的 uid 所在实体的 x」，没有就用 evidence.uids[0]。 */
    const xs = [];
    for (const d of ds) {
        for (const uid of d.evidence.uids) {
            const e = idx.byUid.get(uid);
            if (e) xs.push([d.code, uid, e.x, e.y]);
        }
    }
    const inRange = xs.filter(([, , x]) => x >= 2 && x <= 5);
    assert.ok(inRange.length >= 1, `必须有至少一条落在 x=2..5，实际 ${JSON.stringify(xs)}`);
});

test("T4 L4 冷启动的完整输出可复现（钉住 7 条与它们的码）", () => {
    const ds = run(L4);
    assert.deepEqual(ds.map(d => [d.code, d.subject.handle]), [
        ["DEAD_END", "B129"],              // 10008 @ x=-10，出口为空
        ["BELT_HANDOFF_REJECTED", "B130"], // 10024 @ x=-9 → balancer 不收 right
        ["CHAIN_UNFED", "B136"],           // 10032 @ x=-1，入口是空格
        ["CHAIN_UNFED", "M4"],             // 10082 @ x=5，矿机被架空（x=5 的源头）
        ["DEAD_END", "B83"],               // 10193 @ x=9，出口为空
        ["BELT_HANDOFF_REJECTED", "B134"], // 10030 @ x=-3 → B135 不收 right
        ["CHAIN_UNFED", "B131"],           // 10027 @ x=-6，上游 balancer 不吐这路
    ]);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 隧道不被误判
 * ══════════════════════════════════════════════════════════════════════════ */

test("T5 ★ 没有任何 DEAD_END 指向隧道（sender/receiver 都不该被当成死端）", () => {
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        const idx = indexOf(obs);
        const ds = run(obs);
        const tunnelUids = new Set(idx.ent.filter(isTunnel).map(e => e.uid));
        const bad = byCode(ds, "DEAD_END").filter(d => d.evidence.uids.some(u => tunnelUids.has(u)));
        assert.deepEqual(bad, [], `${name}: 没有 DEAD_END 指向隧道`);
    }
});

test("T5 ★ cutter#10036 右口跑链终点是 trash（穿过 sender→receiver），不是 empty", () => {
    const idx = indexOf(L4);
    const c = idx.byUid.get(10036);
    const s = slotsOf("cutter", "default", c.x, c.y, c.r || 0);
    const right = s.outputs.find(o => o.role === "right");
    /* 直接看 runEnd 的语义（structural 内部用的就是它） */
    const { runEnd } = require_topology();
    const r = runEnd(idx, right.cell, right.dir);
    assert.equal(r.kind, "trash");
    assert.equal(r.accepted, true);
    assert.ok(r.belts.includes(10077) && r.belts.includes(10078));
});

/** 顶部用 import 已经引入 `runEnd` 会与局部同名冲突，所以这里显式拿一次。 */
function require_topology() {
    return { runEnd: runEndRef };
}
import { runEnd as runEndRef } from "./topology.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 2×1 机器入口判据
 * ══════════════════════════════════════════════════════════════════════════ */

test("T6 ★ BELT_HANDOFF_REJECTED：正确判据下命中 10024 与 10030（任务书的数字对不上，见注释）", () => {
    /* ⚠️ 任务书写「命中 10030 但不命中 10024」。**真几何是两条都命中**，理由：
     *
     *   10024@(-9,-3) rv=2 出口 right → 落点 (-8,-3) 是 balancer#10035 的左半格本体。
     *     balancer 的输入槽在 (x, y+1) 且方向是 bottom ⇒ 从 right 推来的货它不收。
     *     外部真值：L5-items.json 里这条 path 的 `boundAcceptor` == null。
     *
     *   10030@(-3,-3) r=90 rv=0 出口 right → 落点 (-2,-3) 是 B135 r=180 rv=0（入口 top、出口 bottom）
     *     ⇒ 从 right 推来的货它也不收。外部真值同样是 boundAcceptor == null。
     *
     * 所以「正确判据下不误报 balancer」在 L4/L5 上不成立 —— 那一格 balancer 确实接错了。
     * 这条测试钉住**真实结果**；若未来发现 10024 真的可接，必须先重做几何论证。 */
    const ds = run(L4);
    const rej = byCode(ds, "BELT_HANDOFF_REJECTED");
    const uids = rej.map(d => d.evidence.uids[0]).sort((a, b) => a - b);
    assert.deepEqual(uids, [10024, 10030]);

    const l5bc = new Map();
    for (const p of L5_ITEMS.paths) l5bc.set(K(p.cells[p.cells.length - 1]), p.boundAcceptor);
    assert.equal(l5bc.get(K([-9, -3])), null, "10024 的 path 接收方 = null（游戏自己说的）");
    assert.equal(l5bc.get(K([-3, -3])), null, "10030 的 path 接收方 = null");
});

test("T6 ★ 反例：写错成 approach 格判据会多报 12 条（2×1 机器上致命）", () => {
    const idx = indexOf(L4);
    let correct = 0;
    let wrong = 0;
    for (const e of idx.ent) {
        if (e.type !== "belt") continue;
        const d = exitDirOf(e);
        const L = exitCellOf(e);
        const R = at(idx, L);
        if (!R || R.type === "belt" || R.type === "underground_belt") continue;
        const s = slotsOf(R.type, R.variant, R.x, R.y, R.r || 0);
        if (!s) continue;
        /* 正确：本体格 == 落点格；错误：approach 格 == 落点格 */
        if (!s.inputs.some(sl => sl.slot[0] === L[0] && sl.slot[1] === L[1] && sl.dir === OPP_MAP[d])) correct++;
        if (!s.inputs.some(sl => sl.cell[0] === L[0] && sl.cell[1] === L[1] && sl.dir === OPP_MAP[d])) wrong++;
    }
    assert.equal(correct, 1);
    assert.equal(wrong, 13);
    assert.ok(wrong > correct * 10, "错误判据比正确判据多一个数量级");
});
import { OPP as OPP_MAP } from "../../ai/belt-rules.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 负例：世界修好 ⇒ 0 条 blocker 结构码
 * ══════════════════════════════════════════════════════════════════════════ */

test("T7 ★ 把 L4 的 2 条死端补上 ⇒ 0 条 DEAD_END 级 blocker", () => {
    const obs = clone(L4);
    /* 在两条死端的出口格各放一台 trash（最小的合法接收方）。
       这一条**只**验 DEAD_END 会消失，不假装整个世界变好（其余诊断本来就存在）。 */
    const idx = indexOf(obs);
    const dead = obs.entities.filter(e => e.type === "belt" && !at(idx, exitCellOf(e)));
    assert.equal(dead.length, 2, "前提：先确认确实有 2 条");
    let nextUid = Math.max(...obs.entities.map(e => e.uid)) + 1;
    for (const b of dead) {
        const c = exitCellOf(b);
        obs.entities.push({ uid: nextUid++, type: "trash", x: c[0], y: c[1], r: 0, variant: "default", rotation_variant: 0, code: 20, layer: "regular" });
    }
    const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs));
    assert.equal(byCode(ds, "DEAD_END").length, 0, "补上之后 DEAD_END 必须归零");
});

test("T7 ★ 干净世界 ⇒ 0 条结构码（用一张手造的最小正常世界）", () => {
    /* 逐格推一遍，别凭直觉（我第一版就把最后一条带子的朝向写反了）：
     *
     *   miner(0,5)  出口槽在 (0,4)，dir=top（`op-templates` 的 miner output slot [0,0] dir top）
     *   belt(0,4)   入口 bottom、出口 top → 落点 (0,3)
     *   belt(0,3)   入口 bottom、出口 top → 落点 (0,2)
     *   belt(0,2)   入口 bottom、出口 top → 落点 (0,1)
     *   belt(0,1)   入口 bottom、出口 top → 落点 (0,0)   ← 出口朝上是空的，会断
     *
     * 所以最后一条必须**拐弯**：入口 bottom、出口 right（rv=2, r=0）→ 落点 (1,1)。
     * hub 在 (1,0)，占地 (1,0)..(4,3)；左列入口是 slot (1,y) dir=left，approach 格 = (0,y)。
     * (1,1) 正是 slot (1,1) 的本体格，来向 right = OPP[left] ⇒ **收**。
     */
    const mk = (uid, type, x, y, r, rv, code) =>
        ({ uid, type, x, y, r, variant: "default", rotation_variant: rv, code });
    const ents = [
        mk(1, "hub", 1, 0, 0, 0, 26),
        mk(2, "miner", 0, 5, 0, 0, 7),
        mk(3, "belt", 0, 4, 0, 0, 1),
        mk(4, "belt", 0, 3, 0, 0, 1),
        mk(5, "belt", 0, 2, 0, 0, 1),
        mk(6, "belt", 0, 1, 0, 2, 3),      // rv=2（右弯）：入口 bottom、出口 right
    ];
    const obs = { entities: ents, goal: { requirement: { shape: "RuRuRuRu", required: 10, delivered: 0 } } };
    const ds = structuralDiagnoses(obs, null, "RuRuRuRu", buildHandles(obs, null));
    assert.deepEqual(ds.map(d => [d.code, d.subject.handle]), [], "这个拓扑是干净的");
});

test("T7 负例：孤立矿机 + 一条接对的带子 ⇒ 也不报（不许把「短链」当坏）", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 5, r: 0, variant: "default", rotation_variant: 0, code: 7, layer: "regular" },
        { uid: 2, type: "belt", x: 0, y: 6, r: 0, variant: "default", rotation_variant: 0, code: 2, layer: "regular" },
        { uid: 3, type: "trash", x: 0, y: 7, r: 0, variant: "default", rotation_variant: 0, code: 20, layer: "regular" },
    ];
    /* 带子 rv=1（左弯）在 r=0 时：入口 bottom、出口 left —— 那是歪的，故意不用。
       改用一条直带 rv=0 r=0：入口 bottom（来自 (0,6) 下方），出口 top —— 它朝矿机流，
       所以不是「喂 trash」。为了构造干净的负例，这里用 rv=0 r=180：入口 top、出口 bottom。 */
    ents[1] = { ...ents[1], r: 180, code: 1 };
    const obs = { entities: ents };
    const ds = structuralDiagnoses(obs, null, null, buildHandles(obs, null));
    assert.equal(ds.filter(d => d.code === "DEAD_END").length, 0);
    assert.equal(ds.filter(d => d.code === "BELT_HANDOFF_REJECTED").length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 坐标禁令
 * ══════════════════════════════════════════════════════════════════════════ */

test("T8 ★ 所有诊断的 subject/expected/observed/evidence.handles 不含坐标形态", () => {
    const COORD = /\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/;
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        const ds = run(obs);
        const leaky = ds.filter(d => {
            const blob = JSON.stringify({
                subject: d.subject,
                expected: d.expected,
                observed: d.observed,
                handles: d.evidence.handles,
            });
            return COORD.test(blob);
        });
        assert.deepEqual(leaky.map(d => d.code), [], `${name}: 不许有坐标`);
    }
});

test("T8 ★ 坐标禁令在损坏世界里也成立（删矿机/删 trash 两条路径）", () => {
    const COORD = /\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/;
    for (const mutate of [
        o => { o.entities = o.entities.filter(e => e.type !== "miner"); },
        o => { o.entities = o.entities.filter(e => e.type !== "trash"); },
        o => { o.entities = o.entities.filter(e => e.type !== "miner" && e.type !== "trash"); },
    ]) {
        const obs = clone(L4);
        mutate(obs);
        const ds = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs), { recipe: RECIPE_NEEDS_MINE });
        const leaky = ds.filter(d => COORD.test(JSON.stringify({
            subject: d.subject, expected: d.expected, observed: d.observed, handles: d.evidence.handles,
        })));
        assert.deepEqual(leaky.map(d => d.code), []);
    }
});

test("T8 subject 里不许出现坐标为 handle 的情况（handle 必须是句柄或 uid token）", () => {
    const ds = run(L4);
    for (const d of ds) {
        const h = d.subject && d.subject.handle;
        assert.ok(h === null || /^[A-Z]{1,2}\d{1,3}$/.test(h), `handle 形态不对：${h}`);
        if (h === null) assert.match(d.subject.token, /^uid:\d+$/);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 确定性
 * ══════════════════════════════════════════════════════════════════════════ */

test("T9 ★ 同一份 obs 调两次 ⇒ 结果逐字节相同", () => {
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        const a = run(obs);
        const b = run(obs);
        assert.equal(JSON.stringify(a), JSON.stringify(b), `${name} 必须确定性`);
    }
});

test("T9 确定性在损坏世界上也成立（指纹级别）", () => {
    const obs = clone(L4);
    obs.entities = obs.entities.filter(e => e.type !== "trash");
    const a = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs));
    const b = structuralDiagnoses(obs, null, goalOf(obs), handlesOf(obs));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. 上限
 * ══════════════════════════════════════════════════════════════════════════ */

test("T10 ★ L4/L5 上：总量 ≤8，每码 ≤3", () => {
    assert.equal(LIMITS.TOTAL, 8, "v2 §6 的裁决是 8，不是 v1 的 12");
    assert.equal(LIMITS.PER_CODE, 3);
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        const ds = run(obs);
        assert.ok(ds.length <= 8, `${name}: 总量 ${ds.length} ≤ 8`);
        const per = new Map();
        for (const d of ds) per.set(d.code, (per.get(d.code) || 0) + 1);
        for (const [c, n] of per) assert.ok(n <= 3, `${name}: ${c} 有 ${n} 条 > 3`);
    }
});

test("T10 ★ 超限不静默丢弃：被压掉的条数记在先出那条码的首条 evidence.suppressed", () => {
    /* 人为把上限压到 1/2，让 L5（8 条）必然超限 */
    const ds = structuralDiagnoses(L5, null, goalOf(L5), handlesOf(L5), { limits: { PER_CODE: 1, TOTAL: 2 } });
    assert.ok(ds.length <= 2);
    const sup = ds.filter(d => typeof d.evidence.suppressed === "number" && d.evidence.suppressed > 0);
    assert.ok(sup.length >= 1, "必须有 suppressed 计数（不许静默丢弃）");
    const total = ds.length + sup.reduce((s, d) => s + d.evidence.suppressed, 0);
    const full = run(L5);
    assert.equal(total, full.length, `suppressed 必须补回完整条数（${total} vs ${full.length}）`);
});

test("T10 每码上限真的按码分别生效（把 TOTAL 放开、只压 PER_CODE）", () => {
    const full = run(L5);
    const ds = structuralDiagnoses(L5, null, goalOf(L5), handlesOf(L5), { limits: { PER_CODE: 1, TOTAL: 99 } });
    const codesInFull = new Set(full.map(d => d.code));
    assert.equal(ds.length, codesInFull.size, "每个码留 1 条");
    const seen = new Set();
    for (const d of ds) {
        assert.ok(!seen.has(d.code), "同一码不许出现两次");
        seen.add(d.code);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. 工程约束：码闭集 / 无副作用
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-a0 产出的每个码都在 DIAG_CODES 闭集里", () => {
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        for (const d of run(obs)) {
            assert.ok(Object.prototype.hasOwnProperty.call(DIAG_CODES, d.code), `${name}: ${d.code} 不在闭集`);
        }
    }
});

test("P-a0 **不**产出留给 P-a 的语义码（越界即红）", () => {
    const SEMANTIC = ["MISSING_STEP", "WRONG_SHAPE_AT_HUB", "DISCARDED_INTERMEDIATE", "PROCESSOR_REQUIRED"];
    for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
        for (const d of run(obs)) {
            assert.ok(!SEMANTIC.includes(d.code), `${name}: P-a0 不许产出 ${d.code}`);
        }
    }
});

test("P-a0 的 5 个码都在 constants 里有说明与检索条目", () => {
    const P_A0 = ["DEAD_END", "BELT_HANDOFF_REJECTED", "CHAIN_UNFED", "WASTE_NO_SINK", "RAW_MATERIAL_MISSING"];
    for (const c of P_A0) {
        assert.ok(Object.prototype.hasOwnProperty.call(DIAG_CODES, c), `${c} 必须在闭集`);
        assert.ok(String(DIAG_CODES[c]).length >= 8, `${c} 必须有说明`);
    }
});

test("★ structural.mjs 无副作用（源码里不许出现 readFileSync/writeFileSync/spawnSync/execSync）", () => {
    const src = fs.readFileSync(path.join(HERE, "structural.mjs"), "utf8");
    /* 只看"调用形态"：`xxx(`。注释里提到这些名字是允许的（文件头就提到了）。 */
    const banned = [/\breadFileSync\s*\(/, /\bwriteFileSync\s*\(/, /\bspawnSync\s*\(/, /\bexecSync\s*\(/];
    for (const re of banned) {
        assert.ok(!re.test(src), `structural.mjs 不许调用 ${re}`);
    }
});

test("★ structural.mjs 只 import 仓库内的只读模块（不含 node: 内置）", () => {
    const src = fs.readFileSync(path.join(HERE, "structural.mjs"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) {
        assert.ok(!spec.startsWith("node:"), `不许 import node 内置模块：${spec}`);
        assert.ok(spec.startsWith("./") || spec.startsWith("../"), `只许相对路径：${spec}`);
    }
});
