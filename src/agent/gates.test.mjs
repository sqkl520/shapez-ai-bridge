/**
 * gates.test.mjs — gates.mjs 的离线自测（不连游戏）。
 *
 * 为什么必须有它：研究里那条"arm E 纪律"——
 * **每条断言必须能在一个"去掉它就会假绿"的夹具上变红。**
 *
 * 光有实现不够。如果某道闸写成 `return true` 也能过所有测试，
 * 那它就是个摆设，而我们会以为自己有了防线。
 *
 * 所以这里的每个用例都是"构造一份**必须被判红**的数据"，
 * 然后断言它真的红了 —— 加上对应的"必须判绿"对照。
 *
 * 用法：node src/agent/gates.test.mjs
 * 退出码：0 全过 / 1 有失败
 *
 * ★ 2026-10 修订（M3-REDTEAM-L4.md §5）★
 * 新增 G2'/G7/G8 三道闸的必红/必绿用例，并修掉报告点名的测试缺陷：
 *   §5.2(1) goodAfter 与 cutterOriginOnly 不再是同一份夹具（前者改用 rot≠0 的夹具）
 *   §5.2(2) 夹具里有 rot=90/180/270 的实体，G4 "读 intent.rot" 才有灵敏度
 *   §5.2(3) 朝向反例加在 **belt** 上（L4 的事故发生在 belt，不是 cutter）
 *   §5.2(4) boundAcceptor 缺失的夹具改成**全覆盖**，红在 dead-end 而不是 uncovered
 *   §5.3(5) runGates 三条流程测试（参数顺序 / 基线顺序 / region 来源）
 *   §5.3(8) mkSlices 每片计数不同，测得出"排除最后一片"
 * 另补 §5.3(6)(7)(9)(10)(11) 的零覆盖判据。
 */
import http from "node:http";
import {
    entityCells, expectedCells, gateG3, gateG4, gateG6, gateG6b,
    gateG7flow, gateG8chains, gateIntentMatchesBlueprint, itemsRegionFor,
    expectedRateOf, runGates,
} from "./gates.mjs";
import { encodeBlueprint, decodeBlueprint } from "../shared/blueprint.mjs";
import { solveTurn, beltCode, DIRV, OPP } from "../ai/belt-rules.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra ? "  " + JSON.stringify(extra) : "")); }
}
function eq(got, want, label) {
    ok(got === want, label, { got, want });
}
const jEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ═════════════════════════ 夹具 ═════════════════════════ */

/** 一台带方向的实体，rot/rv 由 solveTurn 求出，保证几何自洽。 */
function E(kind, dx, dy, rot, rv, code, inDir, outDir, nodeId) {
    return { kind, dx, dy, rot, rotationVariant: rv, code, inDir, outDir, nodeId };
}
function beltE(dx, dy, inDir, outDir, nodeId) {
    const s = solveTurn(inDir, outDir);
    if (!s) throw new Error(`夹具不自洽：${inDir}→${outDir} 无解（${nodeId}）`);
    return E("belt", dx, dy, s.rotation, s.rotationVariant, beltCode(s.rotationVariant), inDir, outDir, nodeId);
}
const bpOf = ents => encodeBlueprint({
    gv: "1.5.6", w: [0, 0],
    entities: ents.map(e => ({ code: e.code, dx: e.dx, dy: e.dy, rot: e.rot })),
});

/* ── 夹具 A：最小 intent（G3/G6b/G6 用；不含 blueprint，不参与 G2'） ── */
const intent = {
    goal: "RuRu----",
    anchor: [10, 10],
    count: 4,
    entities: [
        { kind: "miner", dx: 0, dy: 0, rot: 0, rotationVariant: 0, code: 7, nodeId: "m0" },
        { kind: "cutter", dx: 0, dy: 2, rot: 0, rotationVariant: 0, code: 9, nodeId: "c0" },
        { kind: "belt", dx: 0, dy: 1, rot: 0, rotationVariant: 0, code: 1, nodeId: "b0" },
        { kind: "belt", dx: 1, dy: 1, rot: 0, rotationVariant: 0, code: 1, nodeId: "b1" },
    ],
};

/* ── 夹具 B：rot 覆盖 0/90/180/270 的自洽线（G4/G2' 用） ──
 *   miner(4,0) 出口 left
 *   → (3,0) 入right 出left  rot=180 rv=0 code=1
 *   → (2,0) 入right 出left  rot=180 rv=0 code=1
 *   → (1,0) 入right 出top   rot=270 rv=2 code=3
 *   → (1,-1) 入bottom 出top rot=0  rv=0 code=1
 *   → (1,-2) 入bottom 出right rot=0 rv=2 code=3
 *   → (2,-2) 入left 出right rot=90 rv=0 code=1
 *   → (3,-2) 入left 出top   rot=90 rv=1 code=2
 *   → (3,-3) 入bottom 出top rot=0  rv=0 code=1
 *   → cutter(3,-4)
 * 唯一的朝向反例如果只有 cutter（旧套件的做法），这四个 rot 里任何一个都测不到。 */
const richEnts = [
    E("miner", 4, 0, 0, 0, 7, null, "left", "m0"),
    beltE(3, 0, "right", "left", "g0"),
    beltE(2, 0, "right", "left", "g1"),
    beltE(1, 0, "right", "top", "g2"),
    beltE(1, -1, "bottom", "top", "g3"),
    beltE(1, -2, "bottom", "right", "g4"),
    beltE(2, -2, "left", "right", "g5"),
    beltE(3, -2, "left", "top", "g6"),
    beltE(3, -3, "bottom", "top", "g7"),
    E("cutter", 3, -4, 0, 0, 9, "bottom", "top", "c0"),
];
const rich = { goal: "RuRu----", anchor: [0, 0], entities: richEnts, blueprint: bpOf(richEnts) };

/* ── 夹具 C：L4 事故现场（来自 redteam-newgate.mjs，已实跑验证） ──
 * 健康：miner(18,2) 出口 top → 竖直 6 格 → 拐角 (18,-5) → 横 3 格 → 拐角 (21,-5) → (21,-6) → cutter(21,-7)
 * 事故：(21,-5) 被游戏重算成向东的直带，货顺着 82 格绕行进 hub；(21,-6) 变成有 acceptor 的单格 path。 */
const l4Ents = [
    E("miner", 18, 2, 0, 0, 7, null, "top", "m0"),
    E("belt", 18, 1, 0, 0, 1, "bottom", "top", "f0"),
    E("belt", 18, 0, 0, 0, 1, "bottom", "top", "f1"),
    E("belt", 18, -1, 0, 0, 1, "bottom", "top", "f2"),
    E("belt", 18, -2, 0, 0, 1, "bottom", "top", "f3"),
    E("belt", 18, -3, 0, 0, 1, "bottom", "top", "f4"),
    E("belt", 18, -4, 0, 0, 1, "bottom", "top", "f5"),
    E("belt", 18, -5, 0, 2, 3, "bottom", "right", "f6"),
    E("belt", 19, -5, 90, 0, 1, "left", "right", "f7"),
    E("belt", 20, -5, 90, 0, 1, "left", "right", "f8"),
    E("belt", 21, -5, 90, 1, 2, "left", "top", "j0"),
    E("belt", 21, -6, 0, 0, 1, "bottom", "top", "j1"),
    E("cutter", 21, -7, 0, 0, 9, "bottom", "top", "c0"),
];
function mkL4(anchor = [0, 0]) {
    return { goal: "RuRu----", anchor, entities: l4Ents, blueprint: bpOf(l4Ents) };
}
const L4 = mkL4([0, 0]);

const isBelt = e => e.kind === "belt";
const cellOf = (intentObj, e) => [intentObj.anchor[0] + e.dx, intentObj.anchor[1] + e.dy];

/** 按给定 nodeId 顺序把带子格串成一条 path（上游→下游序）。 */
function pathOf(intentObj, nodeIds, acceptorCell) {
    const byId = new Map(intentObj.entities.map(e => [e.nodeId, e]));
    return {
        cells: nodeIds.map(id => cellOf(intentObj, byId.get(id))),
        itemsOnPath: 3,
        boundAcceptor: acceptorCell,
    };
}
/** 夹具 B 的健康运行时：一条 8 格链，终点是 cutter。 */
function healthyItems(intentObj) {
    const ids = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"];
    const cutter = intentObj.entities.find(e => e.kind === "cutter");
    return { pathCount: 1, paths: [pathOf(intentObj, ids, cellOf(intentObj, cutter))] };
}
/** 夹具 C（L4）的健康运行时：一条 11 格链，终点是 cutter@(21,-7)。 */
function l4HealthyItems(intentObj) {
    const ids = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "j0", "j1"];
    const cutter = intentObj.entities.find(e => e.kind === "cutter");
    return { pathCount: 1, paths: [pathOf(intentObj, ids, cellOf(intentObj, cutter))] };
}

/* ═════════ ① entityCells：footprint 必须展开 ═════════ */
console.log("── ① entityCells：footprint 必须展开 ──");
eq(entityCells("belt", 5, 5).length, 1, "belt 占 1 格");
eq(entityCells("cutter", 5, 5).length, 2, "cutter 2×1 占 2 格");
eq(entityCells("hub", 5, 5).length, 16, "hub 4×4 占 16 格");
eq(entityCells("miner", 5, 5).length, 1, "miner 占 1 格（实测：四台在 (2..5,-8) 相邻共存）");
eq(entityCells("rotater", 5, 5).length, 1, "rotater 占 1 格（继承默认 Vector(1,1)）");
eq(entityCells("cutter", 5, 5, 90).length, 2, "cutter 转 90° 仍占 2 格（宽高互换）");
{
    const cells = entityCells("cutter", 5, 5);
    ok(cells.some(c => c[0] === 6 && c[1] === 5), "cutter 的右半格被展开", cells);
}
/* ★ §5.3(10)：只数个数测不出 180/270 的方向 —— 必须查坐标 ★
   旧套件只断言 length，于是 `dx0=dy0=0` 的变异体（180/270 也向正方向长）存活；
   而 M3-ROUND3 第 1 条那个"ox=-1 时跳错格"的 bug 正属于这一类。 */
{
    ok(jEq(entityCells("cutter", 5, 5, 180), [[4, 5], [5, 5]]),
        "cutter rot=180 向负 x 方向长（查坐标，不只查个数）", entityCells("cutter", 5, 5, 180));
    ok(jEq(entityCells("cutter", 5, 5, 270), [[5, 4], [5, 5]]),
        "cutter rot=270 向负 y 方向长（查坐标，不只查个数）", entityCells("cutter", 5, 5, 270));
    ok(jEq(entityCells("cutter", 5, 5, 90), [[5, 5], [5, 6]]),
        "cutter rot=90 向正 y 方向长（宽高互换）", entityCells("cutter", 5, 5, 90));
}

/* ═════════ ② expectedCells：世界坐标 = anchor + [dx,dy] ═════════ */
console.log("\n── ② expectedCells：世界坐标 = anchor + [dx,dy] ──");
{
    const cells = expectedCells(intent);
    eq(cells.size, 5, "展开后共 5 格（miner 1 + cutter 2 + belt 2）");
    ok(cells.has("10,10"), "miner 在 anchor 上");
    ok(cells.has("10,12"), "cutter 原点在 anchor+[0,2]");
    ok(cells.has("11,12"), "cutter 右半被展开");
    eq(cells.collisions, undefined, "无自叠时不带 collisions");

    const overlap = {
        goal: "RuRu----", anchor: [0, 0], count: 2,
        entities: [
            { kind: "belt", dx: 0, dy: 0, rot: 0, code: 1, nodeId: "b0" },
            { kind: "cutter", dx: 0, dy: 0, rot: 0, code: 9, nodeId: "c0" },
        ],
    };
    const ov = expectedCells(overlap);
    ok(Array.isArray(ov.collisions) && ov.collisions.length > 0,
        "同格自叠 → collisions 非空（回归锁）", ov.collisions);

    let anchorThrew = false;
    try { expectedCells({ ...intent, anchor: ["10", "20"] }); } catch (e) { anchorThrew = true; }
    ok(anchorThrew, "非整数 anchor → 抛错（回归锁：不许字符串拼接）");
}

/* ═════════ ③ gateG3：三个条件都必须有灵敏度 ═════════ */
console.log("\n── ③ gateG3：三个条件都必须有灵敏度 ──");
{
    const good = await gateG3(intent, { blocked: [], destroys: [], would_apply: 4, would_delete: 0 });
    ok(good.ok, "干净落点 → 绿");

    const blocked = await gateG3(intent, { blocked: [{ cell: [10, 10], reason: "solid collision" }], destroys: [], would_apply: 3, would_delete: 0 });
    ok(!blocked.ok, "有 blocked → 红（arm E）", blocked.reason);

    const destroys = await gateG3(intent, { blocked: [], destroys: [{ uid: 1, cell: [5, 5], type: "belt" }], would_apply: 4, would_delete: 1 });
    ok(!destroys.ok, "有 destroys → 红（arm E）", destroys.reason);

    const miscount = await gateG3(intent, { blocked: [], destroys: [], would_apply: 3, would_delete: 0 });
    ok(!miscount.ok, "would_apply 与实体数不符 → 红（arm E）", miscount.reason);

    const asCells = await gateG3(intent, { blocked: [], destroys: [], would_apply: 5, would_delete: 0 });
    ok(!asCells.ok, "若把 would_apply 当格数（5）→ 红，证明代码用的是实体数口径", asCells.reason);

    /* ★ §5.3(6)：G3 的两条内部判据以前零覆盖 ★
       `G3a`（关掉自叠检查）与 `G3b`（关掉 unknown_code 检查）都存活过。 */
    const selfOverlap = {
        goal: "RuRu----", anchor: [0, 0], count: 2,
        entities: [
            { kind: "belt", dx: 0, dy: 0, rot: 0, code: 1, nodeId: "b0" },
            { kind: "cutter", dx: 0, dy: 0, rot: 0, code: 9, nodeId: "c0" },   // 压住 b0
        ],
    };
    const g3o = await gateG3(selfOverlap, { blocked: [], destroys: [], would_apply: 2, would_delete: 0 });
    ok(!g3o.ok, "G3：蓝图自叠（cutter 压住 belt）→ 红", g3o.reason);
    ok(/自叠/.test(g3o.reason), 'G3 自叠的 reason 明确说「自叠」', g3o.reason);
    ok(Array.isArray(g3o.evidence.collisions) && g3o.evidence.collisions.length > 0,
        "G3 自叠时把 collisions 写进 evidence");

    const unknownCode = await gateG3(intent, {
        blocked: [], destroys: [], would_apply: 4, would_delete: 0,
        unknown_code: [{ code: 4711, cell: [10, 10] }],
    });
    ok(!unknownCode.ok, "G3：蓝图含游戏不认识的 code → 红", unknownCode.reason);
    ok(/不认识的 code/.test(unknownCode.reason), 'G3 unknown_code 的 reason 说「不认识的 code」', unknownCode.reason);

    /* 报告 §5.3(12)：would_delete 进了 evidence 但从不判定 —— 这一条锁住"它确实只记录"，
       免得以后有人以为它判了。 */
    const delOnly = await gateG3(intent, { blocked: [], destroys: [], would_apply: 4, would_delete: 7 });
    ok(delOnly.ok, "would_delete>0 但 destroys=[] 时 G3 仍绿（只记录不判定，如实锁定当前语义）");
    eq(delOnly.evidence.would_delete, 7, "G3 把 would_delete 如实记进 evidence");
}

/* ═════════ ④ gateG4：uid 消失 / code / 朝向 都必须红 ═════════ */
console.log("\n── ④ gateG4：uid 消失与 code 不符都必须红 ──");
{
    const mkSnap = list => ({ byUid: new Map(list.map(e => [e.uid, e])) });
    /** 按 intent 生成一份"忠实落地"的 after，r 默认取 intent.rot。 */
    const obsOf = (intentObj, uidBase, mut = () => null) => mkSnap(intentObj.entities.map((e, i) => {
        const base = {
            uid: uidBase + i,
            x: intentObj.anchor[0] + e.dx,
            y: intentObj.anchor[1] + e.dy,
            code: e.code,
            type: e.kind,
            r: e.rot,
        };
        return mut(base, e) || base;
    }));
    const oldEnt = { uid: 1, x: 100, y: 100, code: 1, type: "belt", r: 0 };
    const before = mkSnap([oldEnt]);

    /* ★ §5.2(1)(2)：正例改用 rot≠0 的夹具 ★
       旧套件的 goodAfter 与 cutterOriginOnly 逐字相同（同一条断言写了两遍），
       而且所有 rot 都是 0 —— 于是 `wantR = ent.rot` 改成 `wantR = 0` 也 52/52 全绿。
       现在这份夹具的 rot 覆盖 0/90/180/270。 */
    const richAfterOnly = obsOf(rich, 100);
    const goodAfter = mkSnap([oldEnt, ...richAfterOnly.byUid.values()]);
    const g4good = gateG4(rich, before, goodAfter);
    ok(g4good.ok, "全部到位（rot 覆盖 0/90/180/270）→ 绿", g4good.reason);

    // ★ 必红：把 wantR 换成 0 / 换成 rv 都活不过这两条 ★
    const allZeroR = mkSnap([oldEnt, ...obsOf(rich, 100, b => ({ ...b, r: 0 })).byUid.values()]);
    const g4z = gateG4(rich, before, allZeroR);
    ok(!g4z.ok, "所有 r 都是 0 而 intent 有 90/180/270 → 红（G4 真的读 intent.rot）", g4z.reason);

    const rvAsR = mkSnap([oldEnt, ...obsOf(rich, 100, (b, e) => ({ ...b, r: e.rotationVariant })).byUid.values()]);
    const g4rv = gateG4(rich, before, rvAsR);
    ok(!g4rv.ok, "把 rv 当 rot 用 → 红（G4 不能拿 rotationVariant 顶替 rot）", g4rv.reason);

    /* ★ §5.2(3)：朝向反例必须在 **belt** 上 ★
       L4 的事故发生在 belt；旧套件唯一的朝向反例是 cutter，
       于是 `只查 cutter` / `跳过 belt` 两个变异体都存活。 */
    const beltRotWrong = mkSnap([oldEnt, ...obsOf(rich, 100, (b, e) => {
        // 只把 g2（rot=270）写成 rot=90：code 不变，物理占地与进出料口全变
        return e.nodeId === "g2" ? { ...b, r: 90 } : null;
    }).byUid.values()]);
    const g4br = gateG4(rich, before, beltRotWrong);
    ok(!g4br.ok, "belt 的 rot 不符（code 相同）→ 红（A2 发生在 belt 上）", g4br.reason);
    ok(/朝向/.test(g4br.reason), 'G4 belt 方向错时 reason 说「朝向」', g4br.reason);

    const cutterWrongRot = mkSnap([oldEnt, ...obsOf(rich, 100, (b, e) => {
        return e.kind === "cutter" ? { ...b, r: 90 } : null;
    }).byUid.values()]);
    ok(!gateG4(rich, before, cutterWrongRot).ok, "cutter 的 rot 不符 → 红（保留原 cutter 反例）");

    // ★ 必红：贴后多出来一个实体（数量不符）★
    /* 红队 §8.2(3)：`added` 的数量从没与 `expected` 比过 —— mutant
       「新增集合退化为全集」存活。多贴和少贴一样是事故：少贴线不通，
       多贴凭空多出占位、堵后面的通道。 */
    const extraEnt = { uid: 999999, x: 100, y: 100, code: 1, type: "belt", r: 0 };
    const tooMany = mkSnap([oldEnt, ...richAfterOnly.byUid.values(), extraEnt]);
    const g4extra = gateG4(rich, before, tooMany);
    ok(!g4extra.ok, "贴后多出蓝图里没有的实体 → 红（数量必须等于 expected）", g4extra.reason);
    ok(/新增 \d+ 个实体，蓝图只有 \d+ 个/.test(g4extra.reason), "G4 多贴时 reason 说明数量不符", g4extra.reason);

    // 反例：既有 uid 消失（A3 静默销毁）
    const vanishedList = rich.entities.map((e, i) => ({
        uid: 100 + i, x: rich.anchor[0] + e.dx, y: rich.anchor[1] + e.dy, code: e.code, type: e.kind, r: e.rot,
    }));
    const g4a = gateG4(rich, before, mkSnap(vanishedList));
    ok(!g4a.ok, "既有 uid 消失 → 红（A3 的兜底，arm E）", g4a.reason);

    // 反例：code 不符
    const wrongCode = mkSnap([
        oldEnt, ...rich.entities.map((e, i) => ({
            uid: 100 + i, x: rich.anchor[0] + e.dx, y: rich.anchor[1] + e.dy,
            code: e.nodeId === "g5" ? 99 : e.code, type: e.kind, r: e.rot,
        })),
    ]);
    ok(!gateG4(rich, before, wrongCode).ok, "code 不符 → 红（arm E）");

    // 反例：缺实体
    const missing = mkSnap([oldEnt, ...rich.entities.slice(0, 3).map((e, i) => ({
        uid: 100 + i, x: rich.anchor[0] + e.dx, y: rich.anchor[1] + e.dy, code: e.code, type: e.kind, r: e.rot,
    }))]);
    ok(!gateG4(rich, before, missing).ok, "缺实体 → 红（arm E）");

    /* ★ §5.2(1)：cutter 只有 origin 一条 obs 时也要绿 —— 这条现在用**不同的夹具** ★
       旧版这里与 goodAfter 逐字相同（同一份快照、同一个断言写了两遍）。
       现在 goodAfter 用 rot≠0 的 rich 夹具，这一条用最小 intent + 显式断言
       "右半格在 obs 里不存在也可以绿"，两件事不再重复。 */
    const baseAfter = mkSnap([
        oldEnt,
        { uid: 11, x: 10, y: 10, code: 7, type: "miner", r: 0 },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter", r: 0 },   // 只有 origin，没有右半
        { uid: 13, x: 10, y: 11, code: 1, type: "belt", r: 0 },
        { uid: 14, x: 11, y: 11, code: 1, type: "belt", r: 0 },
    ]);
    const g4origin = gateG4(intent, before, baseAfter);
    ok(g4origin.ok, "cutter 只有 origin 一条 obs 时也要绿（回归锁：不按格要求）", g4origin.reason);
    ok(![...baseAfter.byUid.values()].some(e => e.x === 11 && e.y === 12),
        "夹具里确实没有 (11,12) 那条 —— 绿不是因为它存在");

    /* ★ §5.3(11)：贴前截断分支以前零覆盖（G4h 存活）★ */
    const beforeTrunc = { byUid: new Map([[1, oldEnt]]), truncated: true };
    const g4bt = gateG4(intent, beforeTrunc, baseAfter);
    ok(!g4bt.ok, "before 被截断 → 红（无法建立 uid 基线）", g4bt.reason);
    eq(g4bt.undecidable, true, 'before 截断时标 undecidable');
    ok(/贴前/.test(g4bt.reason), 'before 截断的 reason 明确说「贴前」', g4bt.reason);

    /* ★ 回归锁：after 被截断时必须是 undecidable，不是"销毁了" ★ */
    const truncatedAfter = { byUid: new Map([[100, { uid: 100, x: 18, y: 2, code: 7, r: 0 }]]), truncated: true };
    const g4t = gateG4(intent, before, truncatedAfter);
    ok(!g4t.ok, "after 被截断 → 红", g4t.reason);
    eq(g4t.undecidable, true, 'after 截断时标 undecidable（不是「销毁了」）');
    ok(/截断/.test(g4t.reason), 'after 截断的 reason 明确说「截断」', g4t.reason);
}

/* ═════════ ⑤ gateG6b：死路判据不能看 itemsOnPath ═════════ */
console.log("\n── ⑤ gateG6b：死路判据不能看 itemsOnPath ──");
{
    const good = {
        paths: [
            { cells: [[10, 11], [11, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] },
        ],
    };
    ok(gateG6b(intent, good).ok, "全部连通 → 绿");

    const emptyDead = {
        paths: [
            { cells: [[10, 11], [11, 11]], itemsOnPath: 0, boundAcceptor: null },
        ],
    };
    const g6b1 = gateG6b(intent, emptyDead);
    ok(!g6b1.ok, "空的死路（itemsOnPath=0）也要红 —— 证明真的不看 itemsOnPath（arm E）", g6b1.reason);

    const uncovered = {
        paths: [
            { cells: [[10, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] },
        ],
    };
    const g6b2 = gateG6b(intent, uncovered);
    ok(!g6b2.ok, "有带子格没被覆盖 → 红（arm E）", g6b2.reason);

    const truncatedItems = {
        paths: [{ cells: [[10, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] }],
        pathCount: 55,
    };
    const g6b3 = gateG6b(intent, truncatedItems);
    ok(!g6b3.ok, 'paths 被截断 → 红（无法判定）', g6b3.reason);
    ok(/截断/.test(g6b3.reason), '截断的 reason 里明确说「截断」，不是「没连上」', g6b3.reason);
    eq(g6b3.evidence.truncated, true, "evidence.truncated 为 true");

    const notTruncated = { ...truncatedItems, pathCount: 1 };
    const g6b4 = gateG6b(intent, notTruncated);
    ok(!g6b4.ok, '未截断时 → 红（没覆盖）', g6b4.reason);
    ok(/没出现在任何路径/.test(g6b4.reason), '未截断的 reason 是「没覆盖」', g6b4.reason);

    const truncatedButCovered = {
        paths: [{ cells: [[10, 11], [11, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] }],
        pathCount: 50,
    };
    const g6b5 = gateG6b(intent, truncatedButCovered);
    ok(!g6b5.ok, '被截断（但看到的部分全覆盖）→ 红，不能绿（回归锁）', g6b5.reason);
    eq(g6b5.undecidable, true, "被截断标 undecidable");

    const tunnelIntent = {
        goal: "RuRu----", anchor: [0, 0], count: 3,
        entities: [
            { kind: "belt", dx: 0, dy: 0, rot: 0, code: 1, nodeId: "b0" },
            { kind: "underground_belt", dx: 1, dy: 0, rot: 0, code: 22, nodeId: "t0" },
            { kind: "underground_belt", dx: 3, dy: 0, rot: 0, code: 23, nodeId: "t1" },
        ],
    };
    const tunnelItems = {
        paths: [{ cells: [[0, 0], [4, 0]], itemsOnPath: 0, boundAcceptor: [9, 9] }],
    };
    const g6bt = gateG6b(tunnelIntent, tunnelItems);
    ok(g6bt.ok, '含隧道时不算"没覆盖"（隧道格不参与判定，回归锁）', g6bt.reason);
    eq(g6bt.evidence.tunnel_cells_not_verifiable, 2, "evidence 里如实记隧道格数");

    /* ★ §5.2(4)：boundAcceptor 缺失的夹具必须**全覆盖** ★
       旧夹具 paths.cells 只有 [[10,11]]，而 intent 有 2 格带子 ——
       它红在 `uncovered`，所以把判据改成 `=== null`（真 fail-open）也照样红，
       这个变异体因此存活。现在两条带子都在同一条 path 上，红只可能来自 dead-end。 */
    const undefAcceptor = {
        paths: [{ cells: [[10, 11], [11, 11]], itemsOnPath: 0 }],   // 没有 boundAcceptor 字段
    };
    const g6bu = gateG6b(intent, undefAcceptor);
    ok(!g6bu.ok, 'boundAcceptor 缺失（undefined）→ 红（不许 fail-open）', g6bu.reason);
    eq(g6bu.evidence.uncovered_cells, 0, "该夹具是全覆盖的（红只能来自 dead-end，不是 uncovered）");
    eq(g6bu.evidence.dead_end_paths, 1, "boundAcceptor 缺失时确实进的是 dead-end 分支");
    ok(/没有去处/.test(g6bu.reason), 'reason 是「没有去处」而不是「没覆盖」', g6bu.reason);

    const beltErr = { paths: [], beltError: "some internal failure" };
    const g6be = gateG6b(intent, beltErr);
    ok(!g6be.ok, "beltError 存在 → 红", g6be.reason);
    ok(/自己报错/.test(g6be.reason), 'beltError 的 reason 明确说「debug_items 自己报错」', g6be.reason);
}

/* ═════════ ⑥ gateG6：用游戏时间片算速率 ═════════ */
console.log("\n── ⑥ gateG6：用游戏时间片算速率 ──");
{
    /* ★ §5.3(8)：每片计数必须不同 ★
       旧夹具每片都是同一个数，于是"排除最后一片"排不排结果一样，G6c 变异体存活。
       现在 mkSlices 接受一个数组，片与片之间有差异。 */
    const mkSlices = (counts, tail = 0) => {
        const list = [...counts, tail];
        return {
            slice_seconds: 10,
            delivered_slices: list.map(n => ({ "RuRu----": n })),
            produced_slices: list.map(n => ({ "RuRu----": n })),
        };
    };
    const zero = mkSlices([0, 0, 0, 0, 0]);

    // 5 片 ×10 个 = 1.0/s ≥ 阈值 0.32，基线 0 → 绿
    ok(gateG6(intent, zero, mkSlices([10, 10, 10, 10, 10]), 0.4).ok,
        "每片 10 个（1.0/s）≥ 阈值 0.32，基线为 0 → 绿");

    // 稳态：贴前贴后一样 → 无法证明本线有贡献
    const steady = mkSlices([10, 10, 10, 10, 10]);
    ok(!gateG6(intent, steady, steady, 0.4).ok,
        "贴前就在交、贴后没变化 → 红（回归锁：不能证明本线有贡献）");

    const noTarget = {
        slice_seconds: 10,
        delivered_slices: Array.from({ length: 6 }, () => ({ CuCuCuCu: 50 })),
        produced_slices: Array.from({ length: 6 }, () => ({ CuCuCuCu: 50 })),
    };
    ok(!gateG6(intent, noTarget, noTarget, 0.4).ok,
        "片里没有目标形状（老线在交别的）→ 红（回归锁：不看全厂）");

    ok(!gateG6(intent, zero, mkSlices([2, 2, 2, 2, 2]), 0.4).ok,
        "每片 2 个（0.2/s）< 0.32 → 红（arm E）");

    eq(mkSlices([10]).delivered_slices.length, 2, "夹具：1 片历史 + 1 片累积中 = 2 片");
    const g6one = gateG6(intent, zero, mkSlices([10]), 0.4);
    eq(g6one.evidence.slices_used, 1, "2 片里只有 1 片可算（另一片在累积）→ 只按 1 片求平均");
    eq(g6one.evidence.rate, 1, "1 片 ×10 个 / 10 秒 = 1.0/s");
    ok(!gateG6(intent, zero, { slice_seconds: 10, delivered_slices: [{ "RuRu----": 10 }], produced_slices: [] }).ok,
        "真的只有 1 片 → 红（少于 2 片直接拒）");

    const empty = { slice_seconds: 10, delivered_slices: Array.from({ length: 6 }, () => ({})), produced_slices: [] };
    const g6e = gateG6(intent, empty, empty, 0.4);
    ok(!g6e.ok, "全空片 → 红", g6e.reason);
    eq(g6e.undecidable, true, '全空片标 undecidable（不是「零产出」）');

    const g6x = gateG6(intent, noTarget, noTarget, 0.4);
    ok(/从未出现/.test(g6x.reason), '形状键缺失的 reason 明确说「从未出现」不是「速率 0」', g6x.reason);

    ok(!gateG6(intent, zero, mkSlices([10, 10, 10, 10, 10]), 0).ok,
        "理论值 0 → 红，不许 fail-open（回归锁）");

    /* ★ §5.3(8)：最后一片必须被排除 ★
       前 5 片全 0、最后一片（还在累积）1000 —— 排掉最后一片后速率是 0 → 红。
       若把 `slice(0, n-1)` 改成 `slice(0)`，速率变成 166/s → 绿，这条立刻红。 */
    const tailHeavy = mkSlices([0, 0, 0, 0, 0], 1000);
    const g6tail = gateG6(intent, zero, tailHeavy, 0.4);
    ok(!g6tail.ok, "最后一片（累积中）的巨量计数不能算进速率 → 红", g6tail.reason);
    eq(g6tail.evidence.rate, 0, "排除最后一片后 rate=0（若没排除会是 16.7/s）");
    eq(g6tail.evidence.slices_used, 5, "证据里明确记了用了 5 片（6 片 − 累积中的 1 片）");

    /* ★ §5.3(7)：p1=null（真实调用里 catch 会得到 null）时的绝对阈值分支 ★
       旧套件所有夹具的基线都非 null，`after.rate < target` 是死代码，G6a 变异体存活。 */
    const g6abs = gateG6(intent, null, mkSlices([2, 2, 2, 2, 2]), 0.4);
    ok(!g6abs.ok, "基线为 null 时走绝对阈值分支：0.2/s < 0.32 → 红", g6abs.reason);
    ok(/阈值/.test(g6abs.reason), '绝对阈值分支的 reason 说「阈值」', g6abs.reason);
    eq(g6abs.evidence.baseline_rate, null, "基线为 null 时 evidence 如实标注");

    const g6absOk = gateG6(intent, null, mkSlices([10, 10, 10, 10, 10]), 0.4);
    ok(g6absOk.ok, "基线为 null 且 1.0/s ≥ 0.32 → 绿（同一分支的必绿对照）", g6absOk.reason);

    /* 基线非 0 时"被既有产能掩盖" */
    const hidden = gateG6(intent, mkSlices([10, 10, 10, 10, 10]), mkSlices([10, 10, 10, 10, 10]), 0.4);
    ok(/掩盖|无法归因/.test(hidden.reason || ""), '基线已达标时 reason 说「被既有产能掩盖」', hidden.reason);
}

/* ═════════ ⑦ gateG2'：同源自洽（贴前，零写入） ═════════ */
console.log("\n── ⑦ gateG2'：intent.entities 与 intent.blueprint 必须同源 ──");
{
    const g = gateIntentMatchesBlueprint(rich);
    ok(g.ok, "自洽的健康蓝图（rot 0/90/180/270）→ 绿", g.reason);
    eq(g.evidence.blueprint_count, rich.entities.length, "evidence 记录蓝图实体数");
    eq(g.evidence.intent_count, rich.entities.length, "evidence 记录 intent 实体数");

    // 必红 1: blueprint 与 intent 不是同一张图（只改 intent 侧一个格子的 rv）
    const t1 = JSON.parse(JSON.stringify(rich));
    t1.entities.find(e => e.nodeId === "g6").rotationVariant = 0;
    const g1 = gateIntentMatchesBlueprint(t1);
    ok(!g1.ok, "intent 的 rv 与 blueprint 的 code 解耦 → 红（paste 载荷 ≠ G4 期望）", g1.reason);
    ok(g1.evidence.field_diff.length > 0, "evidence.field_diff 指出具体格子");

    // 必红 2: belt 的 rv 与 code 矛盾（intent 与 blueprint 一起错，仍然要红）
    const t2 = JSON.parse(JSON.stringify(rich));
    const g6e = t2.entities.find(e => e.nodeId === "g6");
    g6e.code = 1;                       // rot=90/rv=1 的拐角，code 却写成直带的 1
    t2.blueprint = bpOf(t2.entities);
    const g2 = gateIntentMatchesBlueprint(t2);
    ok(!g2.ok, "belt 的 code ≠ 1+rv（两侧一致地写错）→ 红", g2.reason);
    ok(/code-vs-rv|不一致/.test(g2.reason), 'reason 指出 code 与 rv 的矛盾', g2.reason);

    // 必红 3: 声明方向与几何不自洽（rot/rv/code 全不动，只翻 inDir）
    const t3 = JSON.parse(JSON.stringify(rich));
    const e3 = t3.entities.find(e => e.nodeId === "g6");
    e3.inDir = OPP[e3.inDir];
    const g3 = gateIntentMatchesBlueprint(t3);
    ok(!g3.ok, "只翻转声明的 inDir（几何不动）→ 红（L4 形态 C 的入口）", g3.reason);
    ok(g3.evidence.direction_inconsistent.length > 0, "evidence.direction_inconsistent 指向该格");

    // 必红 4: 缺 inDir/outDir —— 不许 fail-open
    const t4 = JSON.parse(JSON.stringify(rich));
    delete t4.entities.find(e => e.nodeId === "g5").inDir;
    const g4 = gateIntentMatchesBlueprint(t4);
    ok(!g4.ok, "belt 缺 inDir → 红（不许 fail-open）", g4.reason);

    // 必红 5: blueprint 与 intent 实体数/格子不同源
    const t5 = JSON.parse(JSON.stringify(rich));
    t5.entities = t5.entities.filter(e => e.nodeId !== "g4");
    const g5 = gateIntentMatchesBlueprint(t5);
    ok(!g5.ok, "intent 少一格而 blueprint 没少 → 红", g5.reason);
    ok(g5.evidence.only_in_blueprint.length > 0, "evidence 列出只在 blueprint 里的格");

    // 必红 6: blueprint 缺失 / 无法解码
    const g6a = gateIntentMatchesBlueprint({ ...rich, blueprint: undefined });
    ok(!g6a.ok, "缺 blueprint 字段 → 红（paste 会拿到 undefined）", g6a.reason);
    const g6b = gateIntentMatchesBlueprint({ ...rich, blueprint: "SZBP1.not-a-blueprint" });
    ok(!g6b.ok, "blueprint 解码失败 → 红", g6b.reason);

    // 必红 7: blueprint 的 rot 与 intent 的 rot 不同源（code 相同）
    const t7 = JSON.parse(JSON.stringify(rich));
    t7.entities.find(e => e.nodeId === "g2").rot = 90;
    const g7 = gateIntentMatchesBlueprint(t7);
    ok(!g7.ok, "blueprint 与 intent 的 rot 不同源（code 相同）→ 红", g7.reason);
    ok(g7.evidence.field_diff.some(d => d.field === "rot"), "evidence.field_diff 里 field=rot");

    /* 必绿对照：真实 L4 交接件同源（证明原型不是只会红） */
    ok(jEq(decodeBlueprint(rich.blueprint).entities.map(e => [e.code, e.dx, e.dy, e.rot]),
        rich.entities.map(e => [e.code, e.dx, e.dy, e.rot])),
        "夹具的 blueprint 确实是 entities 的逐格编码（自检）");
}

/* ═════════ ⑧ gateG7：逐格流向（贴后） ═════════ */
console.log("\n── ⑧ gateG7：游戏 path 的逐格邻接必须等于声明的 in/out ──");
{
    const healthy = healthyItems(rich);
    const g = gateG7flow(rich, healthy);
    ok(g.ok, "健康线 → 绿（逐格邻接全部一致）", g.reason);
    eq(g.evidence.checked_in, 8, "evidence 记了 8 次入向比对");
    eq(g.evidence.checked_out, 8, "evidence 记了 8 次出向比对");

    /* 事故回放：j0 被游戏重算成向东的直带（cells 里它的后继变成 (22,-5)）。
       注意坐标没变、code 也没变（都是 1）—— 只有邻接关系能看出来。 */
    const detour = [];
    for (let x = 22; x <= 60; x++) detour.push([x, -5]);
    for (let y = -4; y <= 0; y++) detour.push([60, y]);
    for (let x = 59; x >= 0; x--) detour.push([x, 0]);
    const accident = {
        pathCount: 2,
        paths: [
            {
                cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                    [19, -5], [20, -5], [21, -5], ...detour],
                itemsOnPath: 5, boundAcceptor: [-1, 0],
            },
            { cells: [[21, -6]], itemsOnPath: 0, boundAcceptor: [21, -7] },
        ],
    };
    const ga = gateG7flow(L4, accident);
    ok(!ga.ok, "G7：L4 事故回放（拐角被翻成直带）→ 红", ga.reason);
    eq(ga.evidence.violations, 2, "事故里恰好 2 处邻接不符（j0 的出向 + j1 的入向）");
    ok(ga.evidence.sample.some(v => v.field === "out" && v.want === "top" && v.got === "right"),
        "诊断指出 j0 的出向 want=top got=right", ga.evidence.sample);
    ok(ga.evidence.sample.some(v => v.field === "in" && v.got === "disconnected-from-belt"),
        "诊断指出 j1 的上游带子不在同一 path 的 prev（disconnected-from-belt）", ga.evidence.sample);

    /* 必红 1b: **中间格**的 in 声明与 path 的实际 prev 不符。
       这是 G7 的 in 向中段判据：与"链首是机器"和"not_on_any_path"都不是同一条分支。 */
    const midIn = JSON.parse(JSON.stringify(rich));
    midIn.entities.find(e => e.nodeId === "g5").inDir = "bottom";
    const gmi = gateG7flow(midIn, healthy);
    ok(!gmi.ok, "G7：中间格声明的 inDir 与 path 的实际 prev 不符 → 红", gmi.reason);
    ok(gmi.evidence.sample.some(v => v.field === "in" && v.want === "bottom" && v.got === "left"),
        "诊断指出中间格的入向 want=bottom got=left", gmi.evidence.sample);

    // 必红 2: 矿机出口的带子反向（L4 的"机器侧"形态）
    const reversed = JSON.parse(JSON.stringify(rich));
    const g0 = reversed.entities.find(e => e.nodeId === "g0");
    g0.inDir = "left"; g0.outDir = "right";          // 声明被翻，几何不动
    const gr = gateG7flow(reversed, healthy);
    ok(!gr.ok, "带子声明反向（几何不动）→ 红", gr.reason);
    ok(gr.evidence.violations >= 2, "反向会同时破坏它与上下游的邻接（至少 2 处）", gr.evidence.violations);

    // 必红 3: 某一格完全不在任何 path 上 —— 不许 fail-open
    const missingCell = JSON.parse(JSON.stringify(rich));
    missingCell.entities = missingCell.entities.filter(e => e.nodeId !== "g5");
    // 注意：删掉 g5 后 g4 的 out 与 g6 的 in 仍按原声明比，会另外红；
    // 这里只关心 not_on_any_path 这条判据本身。
    const shortPath = healthyItems(rich);
    shortPath.paths[0].cells = shortPath.paths[0].cells.filter(c => !(c[0] === 2 && c[1] === -2));
    const gm = gateG7flow(rich, shortPath);
    ok(!gm.ok, "有带子格不在任何 path 上 → 红（not_on_any_path，不许 fail-open）", gm.reason);
    ok(gm.evidence.sample.some(v => v.got === "not_on_any_path"), "诊断指出 not_on_any_path", gm.evidence.sample);

    // 必红 4: 截断 → undecidable，不是绿
    const trunc = { pathCount: 55, paths: healthy.paths };
    const gt = gateG7flow(rich, trunc);
    ok(!gt.ok, "paths 截断 → 红", gt.reason);
    eq(gt.undecidable, true, "G7 截断标 undecidable");

    // 必红 5: beltError / 无 paths
    ok(!gateG7flow(rich, { beltError: "boom" }).ok, "G7：beltError → 红");
    ok(!gateG7flow(rich, {}).ok, "G7：没有 paths 数组 → 红");

    // 必红 6: 一条可判的邻接都没有时不能真空绿
    const allGone = { pathCount: 0, paths: [] };
    const gv = gateG7flow(rich, allGone);
    ok(!gv.ok, "G7：一格都不在 path 上 → 红（真空绿保护）", gv.reason);
}

/* ═════════ ⑨ gateG8：链划分（贴后） ═════════ */
console.log("\n── ⑨ gateG8：蓝图推导的带子链必须与游戏 path 逐格同序 ──");
{
    const healthy = healthyItems(rich);
    const g = gateG8chains(rich, healthy);
    ok(g.ok, "健康线 → 绿（一条 10 格的链，链尾是 cutter）", g.reason);
    eq(g.evidence.expected_chains, 1, "蓝图推出 1 条链");
    eq(g.evidence.actual_chains, 1, "游戏也给了 1 条链");

    /* 事故回放：j0 的货顺着 82 格绕行接到了 hub。
       —— 这是 G8 的核心必红用例：链划分不同，且诊断必须说清"期望链尾是谁、实际接到哪"。 */
    const detour = [];
    for (let x = 22; x <= 60; x++) detour.push([x, -5]);
    for (let y = -4; y <= 0; y++) detour.push([60, y]);
    for (let x = 59; x >= 0; x--) detour.push([x, 0]);
    const itemsAccident = {
        pathCount: 2,
        paths: [
            {
                cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                    [19, -5], [20, -5], [21, -5], ...detour],
                itemsOnPath: 5, boundAcceptor: [-1, 0],
            },
            { cells: [[21, -6]], itemsOnPath: 0, boundAcceptor: [21, -7] },
        ],
    };
    const ga = gateG8chains(L4, itemsAccident);
    ok(!ga.ok, "G8：L4 事故回放 → 红（货流绕进了 hub）", ga.reason);
    ok(/链尾/.test(ga.reason) && /c0/.test(ga.reason),
        "诊断写明「期望链尾 c0@[21,-7]」", ga.reason);
    ok(/链长/.test(ga.reason), "诊断写明链长对比（11 → 114 这类）", ga.reason);

    /* ★ 形态 C：intent 与 blueprint 都自洽地写成直带，游戏也忠实贴成直带 ★
       这时 G2' 绿、G4 绿、G6b 绿 —— 只有 G8 红。
       这是三道新闸里唯一能在"编译器自己写错且内部矛盾已消除"时变红的。 */
    const altEnts = l4Ents.map(e => e.nodeId === "j0"
        ? E("belt", 21, -5, 90, 0, 1, "left", "right", "j0")
        : e);
    const altIntent = { goal: "RuRu----", anchor: [0, 0], entities: altEnts, blueprint: bpOf(altEnts) };
    ok(gateIntentMatchesBlueprint(altIntent).ok, "形态 C：G2' 绿（内部完全自洽）");
    const gAlt = gateG8chains(altIntent, itemsAccident);
    ok(!gAlt.ok, "形态 C：G8 仍红（链尾被接到 hub，不是 cutter）", gAlt.reason);
    ok(/邻接不互反/.test(gAlt.reason) && /j1/.test(gAlt.reason),
        "形态 C 的诊断指出 j0/j1 的声明邻接不互反（j0 说向东、j1 却说从下往上）", gAlt.reason);

    // 必红 2: 链被拆成两段（链划分不等，即使格子集合相同）
    const split = {
        pathCount: 2,
        paths: [
            { cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3]], itemsOnPath: 0, boundAcceptor: [18, -4] },
            { cells: [[18, -4], [18, -5], [19, -5], [20, -5], [21, -5], [21, -6]], itemsOnPath: 0, boundAcceptor: [21, -7] },
        ],
    };
    const gs = gateG8chains(L4, split);
    ok(!gs.ok, "同一批格子被拆成两条 path → 红（链划分敏感，不只是集合覆盖）", gs.reason);

    /* 必红 2b: 同一批格子、顺序相反。
       若把链签名做成"集合相等"（排序后 join），这条会假绿 —— 而链的方向正是全部意义所在。 */
    const reversedPath = {
        pathCount: 1,
        paths: [{ cells: healthy.paths[0].cells.slice().reverse(), itemsOnPath: 0, boundAcceptor: [4, 0] }],
    };
    const grp = gateG8chains(rich, reversedPath);
    ok(!grp.ok, "G8：格子集合相同但顺序相反 → 红（链比对对顺序敏感）", grp.reason);

    // 必红 3: 缺 inDir/outDir → 不许 fail-open
    const noDir = JSON.parse(JSON.stringify(rich));
    delete noDir.entities.find(e => e.nodeId === "g3").outDir;
    const gn = gateG8chains(noDir, healthy);
    ok(!gn.ok, "带子缺 outDir → 红（推不出链，不许 fail-open）", gn.reason);
    ok(/不许 fail-open/.test(gn.reason), "reason 明确说不许 fail-open", gn.reason);

    // 必红 4: 截断
    const gt = gateG8chains(rich, { pathCount: 55, paths: healthy.paths });
    ok(!gt.ok, "paths 截断 → 红", gt.reason);
    eq(gt.undecidable, true, "G8 截断标 undecidable");

    // 必红 5: 蓝图里没有带子（真空绿保护）
    const noBelts = { goal: "RuRu----", anchor: [0, 0], entities: [E("miner", 0, 0, 0, 0, 7, null, "top", "m0")] };
    const gb = gateG8chains(noBelts, healthy);
    ok(!gb.ok, "G8：蓝图没有带子 → 红（真空绿保护）", gb.reason);

    /* 必红 5b: 链**尾**缺 outDir —— 链头/中段的方向齐全，只有尾格声明不全。
       旧实现若在"尾格没有 outDir"时静默把链截断，链仍然能推出来，于是假绿。 */
    const tailNoOut = JSON.parse(JSON.stringify(rich));
    delete tailNoOut.entities.find(e => e.nodeId === "g7").outDir;
    const gtn = gateG8chains(tailNoOut, healthy);
    ok(!gtn.ok, "G8：链尾格缺 outDir → 红（不许 fail-open 把链截断）", gtn.reason);

    // 必红 6: 蓝图里的链闭环 —— 蓝图自身不成立
    const cyc = {
        goal: "RuRu----", anchor: [0, 0],
        entities: [
            beltE(0, 0, "left", "right", "c0"),
            beltE(1, 0, "left", "right", "c1"),
            beltE(2, 0, "right", "left", "c2"),
            beltE(-1, 0, "right", "left", "c3"),
        ],
    };
    const gc = gateG8chains(cyc, { pathCount: 0, paths: [] });
    ok(!gc.ok, "蓝图推出闭环 → 红（蓝图自身不成立）", gc.reason);
    ok(/环/.test(gc.reason), "reason 指出有环", gc.reason);
}

/* ═════════ ⑩ expectedRateOf（§5.3(9)：以前零覆盖） ═════════ */
console.log("\n── ⑩ expectedRateOf：二进一必须折算 ──");
{
    eq(expectedRateOf({ entities: [{ kind: "miner" }] }), 0.4, "单台矿机 0.4/s");
    eq(expectedRateOf({ entities: [{ kind: "stacker" }] }), 0.125, "单台 stacker 0.25/2 = 0.125/s（INPUT_FACTOR）");
    eq(expectedRateOf({ entities: [{ kind: "mixer" }] }), 0.2, "单台 mixer 0.4/2 = 0.2/s（INPUT_FACTOR）");
    eq(expectedRateOf({ entities: [{ kind: "miner" }, { kind: "cutter" }] }), 0.4, "矿机 0.4 与切割机 0.5 取 min");
    eq(expectedRateOf({ entities: [{ kind: "miner" }] }, { miner: 1 }), 0.6, "矿机 1 级升级 → 0.4×1.5");
    eq(expectedRateOf({ entities: [{ kind: "belt" }, { kind: "hub" }] }), 0,
        "只有带子/hub → 0（没有可识别的生产机器）");
}

/* ═════════ ⑪ itemsRegionFor：region 必须覆盖 bbox ═════════ */
console.log("\n── ⑪ itemsRegionFor：debug_items 的 region 来自 bbox ──");
{
    const far = mkL4([300, -260]);
    const region = itemsRegionFor(far);
    ok(region[0] <= 318 && region[2] >= 321,
        "region 的 x 范围覆盖全部实体（不是写死的 [-80,80]）", region);
    ok(region[1] <= -267 && region[3] >= -258,
        "region 的 y 范围覆盖全部实体", region);
    ok(region[2] > 80 || region[0] < -80,
        "夹具锚点足够远：写死 [-80,80]² 会漏（这是 §5.3(5) FLOW-c 的必红条件）", region);
    eq(region.length, 4, "region 是 4 元组 [x0,y0,x1,y1]");
    ok(region.every(Number.isInteger), "region 全是整数");
}

/* ═════════ ⑫ runGates 主流程（§5.3(5) 以前零覆盖） ═════════ */
console.log("\n── ⑫ runGates：主流程的参数顺序 / 基线顺序 / region 来源 ──");

/** 起一个假桥，按 phase 返回预设响应，并记录每一次 RPC。 */
async function withMockBridge(fn) {
    const calls = [];
    let phase = "before";
    let tick = 100;
    let itemsCalls = 0;

    const snap = (intentObj, ents) => ({
        entities: ents.map((e, i) => ({
            uid: 1000 + i,
            x: intentObj.anchor[0] + e.dx,
            y: intentObj.anchor[1] + e.dy,
            code: e.code,
            type: e.kind,
            r: e.rot,
        })),
        goal: { requirement: { shape: intentObj.goal }, upgrade_levels: {} },
        hub: { stored: {} },
        tick,
        truncated: false,
    });

    const state = { phase: () => phase, tick: () => tick, itemsCalls: () => itemsCalls };

    const handler = {
        intent: null,
        obsAfter: null,
        items0: null,
        items1: null,
        prodBefore: null,
        prodAfter: null,
        dry: { would_apply: 13, blocked: [], destroys: [], would_delete: 0, unknown_code: [] },
        applyResult: { applied: 13, count: 13, failed: [] },
        bulkDry: { would_delete: 13 },
        bulk: { applied: 13, failed: [] },
    };

    const handle = (method, params) => {
        if (method === "debug_loop") {
            return { tick, logic_budget_ms: 8, speed: "regular", tick_rate: 120 };
        }
        if (method === "act") {
            if (params.op === "step") { tick += (params.ticks || 0) / 120; return { ok: true }; }
            if (params.op === "paste_blueprint") {
                if (params.dry_run) return handler.dry;
                phase = "after";
                return handler.applyResult;
            }
            if (params.op === "bulk_delete") {
                return params.dry_run ? handler.bulkDry : handler.bulk;
            }
        }
        if (method === "obs") return phase === "before" ? handler.obsBefore : handler.obsAfter;
        if (method === "production") return phase === "before" ? handler.prodBefore : handler.prodAfter;
        if (method === "debug_items") {
            itemsCalls++;
            return itemsCalls === 1 ? handler.items0 : handler.items1;
        }
        throw new Error(`假桥不认识 ${method}`);
    };

    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            let out;
            try {
                const msg = JSON.parse(body);
                const result = handle(msg.method, msg.params || {});
                calls.push({ method: msg.method, params: msg.params || {}, result });
                out = { jsonrpc: "2.0", id: msg.id, result };
            } catch (e) {
                out = { jsonrpc: "2.0", id: null, error: { message: e.message } };
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(out));
        });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const prev = process.env.SHAPEZ_BRIDGE_URL;
    process.env.SHAPEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;
    let out;
    try {
        out = await fn(handler, state, snap);
    } finally {
        if (prev === undefined) delete process.env.SHAPEZ_BRIDGE_URL; else process.env.SHAPEZ_BRIDGE_URL = prev;
        server.close();
    }
    return { out, calls };
}

/** 每个流程测试都需要一份独立的模块实例：BASE 在模块加载时读环境变量。 */
let flowSeq = 0;
const loadFlow = () => import(new URL(`./gates.mjs?flow=${++flowSeq}`, import.meta.url).href);

{
    /* 流程 1：全绿路径。
       它同时锁三件事：
         · FLOW-a：gateG4 的参数顺序是 (intent, before, after)。若写反，
                   before/after 互换 → before 里 13 个 uid 在 after（旧的 1 条）里找不到 → 红。
         · FLOW-b：gateG6 的基线与采样顺序。贴前 0/s、贴后 1.0/s 才绿；若对调 → 红。
         · FLOW-c：debug_items 的 region 来自 bbox。夹具锚在 [300,-260]，
                   写死 [-80,-80,80,80] 会拿到空覆盖 → G6b/G7/G8 全红。 */
    const far = mkL4([300, -260]);
    const items = l4HealthyItems(far);
    const { out, calls } = await withMockBridge(async (h, state, snap) => {
        const old = [{ kind: "belt", dx: 200, dy: 200, code: 1, rot: 0 }];
        h.obsBefore = snap(far, old);
        h.obsAfter = snap(far, [...old, ...far.entities]);
        h.prodBefore = {
            slice_seconds: 10,
            delivered_slices: Array.from({ length: 6 }, () => ({})),
            produced_slices: [],
        };
        h.prodAfter = {
            slice_seconds: 10,
            delivered_slices: Array.from({ length: 6 }, () => ({ "RuRu----": 10 })),
            produced_slices: Array.from({ length: 6 }, () => ({ "RuRu----": 10 })),
        };
        h.items0 = items;
        h.items1 = items;
        const mod = await loadFlow();
        return mod.runGates(far, { apply: true });
    });
    const res = out;

    ok(res.ok === true, "流程：健康蓝图 + 健康运行时 → runGates 全绿",
        res.results.filter(r => !r.ok).map(r => r.id + ": " + r.reason));
    eq(res.results[0].id, "G2'-source", "G2' 在时钟闸之前跑（坏蓝图不碰游戏）");
    eq(res.results[1].id, "G-1-clock", "G2' 之后是时钟闸");
    ok(res.results.some(r => r.id === "G4-landing" && r.ok), "G4 绿（参数顺序是 before, after）");
    ok(res.results.some(r => r.id === "G7-flow@t0" && r.ok), "G7 在 t+0 判过一次");
    ok(res.results.some(r => r.id === "G7-flow@t60" && r.ok), "G7 在 t+60s 又判过一次");
    ok(res.results.some(r => r.id === "G8-chains@t0" && r.ok), "G8 在 t+0 判过一次");
    ok(res.results.some(r => r.id === "G8-chains@t60" && r.ok), "G8 在 t+60s 又判过一次");
    ok(res.results.some(r => r.id === "G6-behavior" && r.ok), "G6 绿（基线与采样没有对调）");

    const dbg = calls.filter(c => c.method === "debug_items");
    eq(dbg.length, 2, "debug_items 采了两次（t+0 与 t+60s）");
    ok(jEq(dbg[0].params.region, itemsRegionFor(far)),
        "debug_items 的 region == itemsRegionFor(intent)（不是写死 [-80,80]²）", dbg[0].params.region);
    ok(dbg[0].params.region[0] > 200,
        "region 确实跟着 anchor 走到了 [300,-260] 附近", dbg[0].params.region);

    const pastes = calls.filter(c => c.method === "act" && c.params.op === "paste_blueprint");
    eq(pastes.length, 2, "paste 调了两次（一次 dry_run，一次真贴）");
    eq(pastes[0].params.dry_run, true, "第一次 paste 是 dry_run");
    ok(!pastes[1].params.dry_run, "第二次 paste 是真贴");
    eq(pastes[1].params.x, 300, "真贴用的 x 来自 intent.anchor");
    eq(pastes[1].params.y, -260, "真贴用的 y 来自 intent.anchor");

    const t0 = res.results.find(r => r.id === "G7-flow@t60");
    eq(t0.evidence.path_count_t0, 1, "G7@t60 的 evidence 记了 t+0 的 pathCount");
    eq(t0.evidence.path_count_t60, 1, "G7@t60 的 evidence 记了 t+60s 的 pathCount");
}

{
    /* 流程 2：G2' 红 → 立即 fatal，零 RPC（这是"零写入"的硬证据） */
    const bad = JSON.parse(JSON.stringify(rich));
    bad.entities.find(e => e.nodeId === "g6").rotationVariant = 0;
    const { out, calls } = await withMockBridge(async () => {
        const mod = await loadFlow();
        return mod.runGates(bad, {});
    });
    ok(out.ok === false, "流程：G2' 红 → runGates 整体红");
    eq(out.fatal, true, "G2' 红是 fatal");
    eq(calls.length, 0, "G2' 红时一个 RPC 都没发（零写入）");
    eq(out.results.length, 1, "G2' 红时只留下一条 result");
}

{
    /* 流程 3：G4 红 → 走回滚，且不再跑 G6 */
    const far = mkL4([0, 0]);
    const { out, calls } = await withMockBridge(async (h, state, snap) => {
        const old = [{ kind: "belt", dx: 60, dy: 60, code: 1, rot: 0 }];
        h.obsBefore = snap(far, old);
        // 忠实贴着，但 j0 的 r 被游戏翻成 0（形态 B 的 t+0 版本）
        h.obsAfter = snap(far, [...old, ...far.entities.map(e => e.nodeId === "j0" ? { ...e, rot: 0 } : e)]);
        h.prodBefore = { slice_seconds: 10, delivered_slices: Array.from({ length: 6 }, () => ({})), produced_slices: [] };
        h.prodAfter = h.prodBefore;
        h.items0 = l4HealthyItems(far);
        h.items1 = l4HealthyItems(far);
        const mod = await loadFlow();
        return mod.runGates(far, { apply: true });
    });
    ok(out.ok === false, "流程：落地朝向不符 → runGates 红");
    ok(out.results.some(r => r.id === "G4-landing" && !r.ok), "G4 报红");
    ok(out.results.some(r => r.id === "rollback-plan" && r.ok), "G4 红后出了可行的回滚计划");
    ok(out.results.some(r => r.id === "rollback" && r.ok), "G4 红后执行了回滚");
    ok(!out.results.some(r => r.id === "G6-behavior"), "G4 红后不再跑 G6（早退）");
    const del = calls.filter(c => c.method === "act" && c.params.op === "bulk_delete");
    eq(del.length, 3, "bulk_delete 调了三次（回滚计划 dry_run + rollback 内部 dry_run + 真删）");
    eq(del.filter(d => !d.params.dry_run).length, 1, "真删只发生一次");
}

{
    /* 流程 4：--plan（不 apply）→ 只跑到 G3，零写入 */
    const { out, calls } = await withMockBridge(async (h, state, snap) => {
        h.obsBefore = snap(rich, [{ kind: "belt", dx: 60, dy: 60, code: 1, rot: 0 }]);
        h.dry = { would_apply: rich.entities.length, blocked: [], destroys: [], would_delete: 0, unknown_code: [] };
        const mod = await loadFlow();
        return mod.runGates(rich, { apply: false });
    });
    ok(out.ok === true, "流程：--plan 全绿");
    eq(out.planOnly, true, "planOnly=true");
    const writes = calls.filter(c => c.method === "act" && c.params.op === "paste_blueprint" && !c.params.dry_run);
    eq(writes.length, 0, "--plan 时没有任何真 paste（零写入）");
    eq(calls.filter(c => c.method === "debug_items").length, 0, "--plan 时不采 debug_items");
    ok(out.results.some(r => r.id === "G2'-source" && r.ok), "--plan 也会跑 G2'");
    ok(out.results.some(r => r.id === "G3-clearance" && r.ok), "--plan 跑到 G3");
}

{
    /* 流程 5：G7/G8 在 t+0 红 → 立刻回滚，不等 t+60s ★回归锁★
       事故的真实损失形态不是"没发现"，是"发现了以后线还在那儿"：
       旧版只有 G4 失败才回滚，G7/G8 红了只记一笔继续跑完 100 游戏秒，
       于是 108 个实体留在存档里、粗料灌进 hub，ok:false 最后才交出去。
       这条锁住"t+0 看到流向错就当场收回"。 */
    const far = mkL4([0, 0]);
    const { out, calls } = await withMockBridge(async (h, state, snap) => {
        const old = [{ kind: "belt", dx: 60, dy: 60, code: 1, rot: 0 }];
        h.obsBefore = snap(far, old);
        // 忠实贴着（G4 会绿），但游戏把 j0 的方向接错了 —— G7/G8 在 t+0 就该看见
        h.obsAfter = snap(far, [...old, ...far.entities]);
        h.prodBefore = { slice_seconds: 10, delivered_slices: Array.from({ length: 6 }, () => ({})), produced_slices: [] };
        h.prodAfter = h.prodBefore;
        // items0 = 贴完立刻的拓扑：j0 的出口指向右边而不是声明要的 top
        const bad0 = l4HealthyItems(far);
        for (const p of bad0.paths) {
            const i = (p.cells || []).findIndex(c => c[0] === far.anchor[0] + far.entities.find(e => e.nodeId === "j0").dx
                && c[1] === far.anchor[1] + far.entities.find(e => e.nodeId === "j0").dy);
            if (i >= 0 && i + 1 < p.cells.length) {
                // 把后继挪到右边一格，制造"出向是 right 不是 top"
                p.cells[i + 1] = [p.cells[i][0] + 1, p.cells[i][1]];
            }
        }
        h.items0 = bad0;
        h.items1 = bad0;
        const mod = await loadFlow();
        return mod.runGates(far, { apply: true });
    });
    ok(out.ok === false, "流程：G7/G8 在 t+0 红 → runGates 红");
    ok(out.results.some(r => (r.id === "G7-flow@t0" || r.id === "G8-chains@t0") && !r.ok),
        "t+0 就有 G7 或 G8 报了红（不是等到 t+60s）");
    ok(out.results.some(r => r.id === "rollback" && r.ok), "t+0 红后执行了回滚（不再只记一笔）");
    ok(!out.results.some(r => r.id === "G6b-connectivity"), "t+0 红后早退，不再等 60 秒跑 G6b");
    ok(!out.results.some(r => r.id === "G6-behavior"), "t+0 红后早退，不再跑 G6");
    const del = calls.filter(c => c.method === "act" && c.params.op === "bulk_delete");
    eq(del.filter(d => !d.params.dry_run).length, 1, "真删只发生一次");
}

/* ═════════ 汇总 ═════════ */
console.log("\n" + "═".repeat(60));
console.log(`gates 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
}
process.exit(fail ? 1 : 0);
