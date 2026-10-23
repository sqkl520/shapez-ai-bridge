/**
 * make-fixtures.mjs — 生成 P1 的三个金样例（research/ai-plan/fixtures/**，只有 P1 能写）。
 *
 * 为什么用脚本生成而不是手写：
 *   - plan-l1.json 的 blueprint 字段必须是**真**的 SZBP1 串（要能被 src/shared/blueprint.mjs 的
 *     decodeBlueprint / summarizeBlueprint 读通，L0 §1.1-4）—— 压缩结果人手写不出来；
 *   - 无随机、可复现、逐字节可 diff；
 *   - 带子 (r, rv) 一律用 src/ai/belt-rules.mjs 的 solveTurn/beltCode **现算并与实机期望值对拍**，
 *     不一致就抛错停下（绝不把猜出来的方向写进 fixture —— 红队 #1 的教训）。
 *
 * 运行：node research/ai-plan/contract/make-fixtures.mjs
 * 读回：node src/ai/compiler/types.mjs --test（round-trip + summarizeBlueprint 读通）
 *
 * 事实来源（全部仓库已核证）：
 *   建筑码  facts/building-codes-live.json —— miner=7 cutter=9 stacker=14 trash=20 belt=1+rv
 *   几何    facts/GEOMETRY-TABLE.md 表1/表2/表3 —— miner 1×1 出 top；cutter 2×1 下进、左格 top=左列、
 *           右格 top=右列；stacker 2×1 双 bottom（左=下层 右=上层）出 top；速率 miner 0.4 / belt 2.0 /
 *           cutter 0.5 / stacker 0.25
 *   拐角    facts/MILESTONE-M4-SUCCESS.md:18-21 —— (147,93) r=0 rv=1 code=2、(138,93) r=270 rv=2 code=3
 *   hub     exp-e2e.mjs:93-102 hubEntries（源 buildings/hub.js:73-91）—— 底排格带子 dir=0 向上喷进 hub
 *   分层序  facts/MILESTONE-M4-partial-and-pitfalls.md 陷阱表 #6 —— 先机器 → 再直线 → 最后拐角
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBlueprint, blueprintCost } from "../../../src/shared/blueprint.mjs";
import { beltCode, solveTurn } from "../../../src/ai/belt-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");
fs.mkdirSync(FIX, { recursive: true });

/* ═══════════════════════ 共享小工具（方向一律由 belt-rules 推导） ═══════════════════════ */

const ORDER = ["top", "right", "bottom", "left"];          // belt-rules.mjs:16
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };    // belt-rules.mjs:33
const rot90 = (n) => { if (n % 90 !== 0) throw new Error("非 90 倍数角度: " + n); return n / 90; };
/** 局部方向 → 世界方向（与 belt-rules.rotateLocal 同式，这里只做 fixture 内部推导） */
const rotDir = (d, rot) => ORDER[(ORDER.indexOf(d) + rot90(rot)) % 4];

/** 由 (dx,dy,rot,rv) 造一个带子 entity（inDir/outDir 由 belt-rules 规则推，不手填） */
function beltEnt(t, nodeId) {
    const inDir = rotDir("bottom", t.rot);
    const outDir = rotDir(EXIT_LOCAL[t.rv], t.rot);
    return {
        code: beltCode(t.rv), dx: t.dx, dy: t.dy, rot: t.rot,
        nodeId: nodeId || `belt@${t.dx},${t.dy}`, instanceIdx: 0, kind: "belt",
        rotationVariant: t.rv, inDir, outDir,
    };
}
/** 链闭合自检：相邻两格必须满足 exit(u) === OPP(entry(v))（belt-rules.mjs:59-70 的判据） */
function assertChain(path2) {
    const OPP = { top: "bottom", bottom: "top", left: "right", right: "left" };
    for (let i = 0; i + 1 < path2.length; i++) {
        const u = path2[i], v = path2[i + 1];
        const uDir = rotDir(EXIT_LOCAL[u.rv], u.rot), vEntry = rotDir("bottom", v.rot);
        if (uDir !== OPP[vEntry]) {
            throw new Error(`链闭合失败 ${u.dx},${u.dy} → ${v.dx},${v.dy}：exit=${uDir} 而 entry=${vEntry}（应为 ${OPP[vEntry]}）`);
        }
    }
    return path2;
}

const SCOPE_V1 = { layers: 1, wires: false, tunnels: false, rotatedMachines: false, maxFanIn: 2 };
const ev = (cell, nodeId, expected, actual, note) => ({ cell, nodeId, expected, actual, note });

/* ══════════════════════════════ 1. plan-l1.json ══════════════════════════════════
 * 最小 ok:true 计划：全新址、单层、**零拐角、全竖直线**（plan §2.7 / GRID-LAYOUT:41-62 第一原则）。
 * 目标 ----CuCu（level-2，只需 miner + hub；plan §6 R4 说这条验收在两种口径下都成立）。
 *
 *   dy=0  ^   带子 —— 落 hub 底排入口格（世界 (hub.x+1, hub.y+4)，流向 top）
 *   dy=1  ^
 *   dy=2  ^
 *   dy=3  ^
 *   dy=4  M   矿机（出 top，吃 "----CuCu" 矿格）
 *
 * ⚠️ 为什么进 hub 走**底排**而不是「侧口」：矿机与所有加工机恒「下进上出」（GEOMETRY 表3 规则 1/2），
 *   竖直上行流只能从底排（dir=0 向上）进 hub；要走左/右侧口必须先拐弯（≥1 个拐角）。
 *   plan §1.7 的三级实验正是这么排的：exp-paste-l1 = 顶/底口直带，exp-paste-corner = 先横移再进侧口。
 *   ⇒ 见 CONTEST.md 第 4 条（P1 任务书写的是「hub 侧口」，与「零拐角」互斥）。
 */
const HUB = [1200, -1400];                       // hub 4×4 的左上角（obs 回报）
const BP_ANCHOR = [HUB[0] + 1, HUB[1] + 4];      // = hub 底排第 2 列入口格 → 蓝图 (0,0)
const MINER_DY = 4;

const l1Tiles = assertChain([
    { dx: 0, dy: MINER_DY - 1, rot: 0, rv: 0 },  // 3
    { dx: 0, dy: MINER_DY - 2, rot: 0, rv: 0 },  // 2
    { dx: 0, dy: MINER_DY - 3, rot: 0, rv: 0 },  // 1
    { dx: 0, dy: 0, rot: 0, rv: 0 },              // 0：贴 hub 底排
].sort((a, b) => b.dy - a.dy));                   // 自下而上（与施工顺序一致）

// entities 顺序 = 机器(P3) → 直线带(P4) → 拐角带（§2.1 硬规定 + 陷阱表 #6）
const l1Entities = [
    { code: 7, dx: 0, dy: MINER_DY, rot: 0, nodeId: "n0", instanceIdx: 0, kind: "miner", rotationVariant: 0, inDir: null, outDir: "top" },
    ...l1Tiles.map(t => beltEnt(t)),
];
const spanOf = ents => {
    const xs = ents.map(e => e.dx), ys = ents.map(e => e.dy);
    return [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
};
const l1Bbox = spanOf(l1Entities);               // [1, 5]
const l1Grid = [...Array(l1Bbox[1]).keys()].map(dy => l1Entities.some(e => e.dy === dy && e.kind === "miner") ? "M" : "^").join("\n");
// hub 自身的 4×4 是**既有世界**（不在 entities 里），相对 BP_ANCHOR = (hub.x+1, hub.y+4) 落在 dx -1..2 / dy -4..-1
const hubOccupancy = [];
for (let dy = -4; dy <= -1; dy++) for (let dx = -1; dx <= 2; dx++) hubOccupancy.push({ cell: [dx, dy], state: "solid", who: "hub", kind: "hub" });

const planL1 = {
    ok: true,
    goal: "----CuCu",
    reason: null,
    failingNode: null,
    hint: null,
    site: { anchor: BP_ANCHOR, hub: HUB },
    blueprint: null,                              // 下面用 encodeBlueprint 现算
    entities: l1Entities,
    layout: {
        grid: l1Grid,
        rows: [{ level: 0, y: MINER_DY, nodeIds: ["n0"] }],
        placements: [{ nodeId: "n0", op: "mine", kind: "miner", cell: [0, MINER_DY], rot: 0, footprint: [1, 1] }],
        channels: [{
            from: { nodeId: "n0", cell: [0, MINER_DY], slot: "top", outDir: "top" },
            to: { nodeId: "hub", cell: [0, -1], slot: "bottom", inDir: "bottom" },
            lane: null, payload: "----CuCu", slotRole: null, ordinal: null,
        }],
        lanes: [],
        hubConnection: { entry: [0, 0], side: "bottom", dir: 0 },
        bbox: l1Bbox,
        occupancy: hubOccupancy,
        conflicts: [],
        cornerCount: 0,
    },
    validation: {
        pass: true,
        checks: [
            { id: "V1-occupancy", status: "pass", evidence: ev([0, MINER_DY], "n0", "落点矩形全空", "1×1 空格 ×5", "矿机 + 4 条带子互不重叠，且不压 hub 4×4（hub 在 dy<0）") },
            { id: "V2-no-overwrite-existing-belt", status: "pass", evidence: ev(null, null, "规划区 ∩ replaceableBeltCells = ∅", "0 格重叠", "C1 最高危闸：paste 落既有可替换带 = 静默销毁旧带、applied/failed 不报告（曾毁 6 条真实带）") },
            { id: "V3-belt-fixed-point", status: "pass", evidence: ev([0, 0], l1Entities[4].nodeId, "computeBelt(含机器邻居) 不动点 = (r=0,rv=0)", "不动点", "末格北邻是 hub acceptor：上行直带正是它该有的形态") },
            { id: "V4-slot-alignment", status: "pass", evidence: ev([0, 3], "belt@0,3", "exit(top) 落在下游 entry(bottom)", "逐格对齐", "矿机 ejector top → entry bottom 链 → 末格 exit top → hub 底排 acceptor") },
            { id: "V5-degree", status: "pass", evidence: ev(null, "n0", "入度 ≤ 槽位数", "fanIn=1", "单输入，无需二叉化") },
            { id: "V6-crossing", status: "pass", evidence: ev(null, null, "两股流不穿格", "0 处穿格", "一条竖直线，无交叉 → 不需要隧道（v1 无隧道）") },
            { id: "V7-throughput", status: "not-applicable", evidence: ev(null, null, "demandPerSec", "0", "v1 口径：0 = 只要能跑通，不做吞吐判定（§0 demandPerSec 参数）") },
            { id: "V8-scope", status: "pass", evidence: ev(null, null, "单层/无 wire/无隧道/机器 r=0/入度≤2/全新址", "6 项全满足", "scope 是契约的一部分（§2.1）；超出者必须 ok:false") },
            { id: "V9-unused-outlet", status: "pass", evidence: ev(null, "n0", "未接走的输出槽必须接 trash", "唯一输出已被接走", "矿机只有 top 一个 ejector（GEOMETRY 表1）") },
            { id: "V10-unlock-report", status: "pass", evidence: ev(null, "n0", "miner/belt 解锁等级 = 1", "level-2 目标可用", "god-mode 口径见 stats.chargeMode（§6 R4）") },
            { id: "S1-shape-replay", status: "pass", evidence: ev(null, "n0", "----CuCu", "----CuCu", "矿机直接产出目标形状，无需加工 → shape-ops 重放 hash 相等（DESIGN:93 Level-1）") },
        ],
        errors: [],
        beltSim: { tilesChecked: l1Tiles.length, fixedPoints: l1Tiles.length, drift: [], includesMachineNeighbors: true },
        shapeReplay: [{ nodeId: "n0", expectedHash: "----CuCu", actualHash: "----CuCu", equal: true }],
        throughput: { demandPerSec: 0, bottleneck: { nodeId: "n0", ratePerSec: 0.4 }, rowsRequired: 1, rowsPlanned: 1 },
    },
    stats: {
        machines: { miner: 1 },
        beltTiles: l1Tiles.length,
        trash: 0,
        bbox: l1Bbox,
        corners: 0,
        estThroughputPerSec: 0.4,                 // 瓶颈 = 矿机 0.4/s（GEOMETRY 表2）
        bottleneck: "miner@0.4",
        blueprintCost: 0,                         // 下面现算 blueprintCost(n)
        chargeMode: "false",
    },
    scope: { ...SCOPE_V1 },
};
{
    const w = [Math.min(...l1Entities.map(e => e.dx)), Math.min(...l1Entities.map(e => e.dy))];
    if (w[0] !== 0 || w[1] !== 0) throw new Error("plan-l1: 蓝图内 min dx/dy 必须为 0（否则 dx/dy 不是相对锚点）");
    planL1.blueprint = encodeBlueprint({ gv: "1.5.6", w, entities: l1Entities.map(e => ({ code: e.code, dx: e.dx, dy: e.dy, rot: e.rot })) });
    planL1.stats.blueprintCost = blueprintCost(l1Entities.length);
}

/* ══════════════════════════════ 2. report-layout.json ══════════════════════════════════
 * 双分支汇合（plan §2.7：唯一会产生拐角 + 车道的形态；P4 用它验 solveTurn 落地）。
 * 照 facts/MILESTONE-M4-SUCCESS.md 的实机形态（level-11 目标 CuCuSuSu:RuRuCuCu）：
 *
 *   dy=9   M.........M      矿A(0,9) CuCuSuSu ／ 矿B(10,9) RuRuCuCu
 *   dy=8..4 ^.........^     两条竖直腿
 *   dy=3    ^.......7<<<<<   拐角1(10,3) → 西向车道 y=3（r=270 rv=0）→ 拐角2(1,3)
 *   dy=2    ^..9.^           拐角2 上行（(1,2) 直带）
 *   dy=1    .SS......        stacker 2×1：左格(0,1)=下层、右格(1,1)=上层
 *   dy=0    ^.             收集带 (0,0) 出 top
 *   dy=-1   T              trash（stacker 输出的去向；实机形态是接 hub 底排）
 *
 * 拐角一律 solveTurn 现算，并与 M4-SUCCESS 的**实机期望值**对拍（不一致就停下）：
 *   物流西行 = 从本格 right 侧进、left 侧出（entry/exit 是「方位」，不是「去向」）。
 *   红队 #1(2) 的错误副本 beltEntry=OPP[beltExit] 会把这里判反 → 整条 L 形 rv 全错。
 */
const turn1 = solveTurn("bottom", "left");   // 矿B 上行 → 改西向｜实机 (147,93) r=0   rv=1 code=2
const turn2 = solveTurn("right", "top");     // 车道西行 → 改回上行｜实机 (138,93) r=270 rv=2 code=3
for (const [got, want, label] of [
    [turn1, { rotation: 0, rotationVariant: 1 }, "(147,93)"],
    [turn2, { rotation: 270, rotationVariant: 2 }, "(138,93)"],
]) {
    if (got.rotation !== want.rotation || got.rotationVariant !== want.rotationVariant) {
        throw new Error(`solveTurn 与 M4-SUCCESS 实机期望不符 ${label}：实得 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
    }
}
const chA = assertChain([...[8, 7, 6, 5, 4, 3, 2].map(dy => ({ dx: 0, dy, rot: 0, rv: 0 }))]);          // 矿A → stacker 左格：零拐角
const chBLeg = assertChain([...[8, 7, 6, 5, 4].map(dy => ({ dx: 10, dy, rot: 0, rv: 0 }))]);             // 矿B 竖直腿
const chBLane = assertChain([                                                                            // 拐角1 + 西向车道 + 拐角2 + 入右格
    { dx: 10, dy: 3, rot: turn1.rotation, rv: turn1.rotationVariant },
    ...[9, 8, 7, 6, 5, 4, 3, 2].map(dx => ({ dx, dy: 3, rot: 270, rv: 0 })),
    { dx: 1, dy: 3, rot: turn2.rotation, rv: turn2.rotationVariant },
    { dx: 1, dy: 2, rot: 0, rv: 0 },
]);
// 通道 B 的竖直腿与拐角1 必须闭合
assertChain([...chBLeg, chBLane[0]]);
const outLine = assertChain([{ dx: 0, dy: 0, rot: 0, rv: 0 }]);
const mergeTiles = [...chA, ...chBLeg, ...chBLane, ...outLine];
const laneRow = 3;
const cornerTiles = mergeTiles.filter(t => t.rv !== 0);
const straightTiles = mergeTiles.filter(t => t.rv === 0);

const mergeEntities = [
    { code: 7, dx: 0, dy: 9, rot: 0, nodeId: "mA", instanceIdx: 0, kind: "miner", rotationVariant: 0, inDir: null, outDir: "top" },
    { code: 7, dx: 10, dy: 9, rot: 0, nodeId: "mB", instanceIdx: 0, kind: "miner", rotationVariant: 0, inDir: null, outDir: "top" },
    { code: 14, dx: 0, dy: 1, rot: 0, nodeId: "st", instanceIdx: 0, kind: "stacker", rotationVariant: 0, inDir: "bottom", outDir: "top" },
    { code: 20, dx: 0, dy: -1, rot: 0, nodeId: "out", instanceIdx: 0, kind: "trash", rotationVariant: 0, inDir: "top", outDir: null },
    ...straightTiles.map(t => beltEnt(t)),      // ② 直线带
    ...cornerTiles.map(t => beltEnt(t)),        // ③ 拐角最后放（陷阱表 #6）
];
const gridMerge = () => {
    const xs = mergeEntities.map(e => e.dx), ys = mergeEntities.map(e => e.dy);
    const minX = Math.min(...xs), minY = Math.min(...ys), W = Math.max(...xs) - minX + 1, H = Math.max(...ys) - minY + 1;
    const g = Array.from({ length: H }, () => Array(W).fill("."));
    const put = (x, y, ch) => { g[y - minY][x - minX] = ch; };
    for (const e of mergeEntities) {
        if (e.kind === "miner") put(e.dx, e.dy, "M");
        else if (e.kind === "stacker") put(e.dx, e.dy, "S");
        else if (e.kind === "trash") put(e.dx, e.dy, "T");
        else put(e.dx, e.dy, e.rotationVariant === 1 ? "7" : e.rotationVariant === 2 ? "9" : e.rot === 270 ? "<" : "^");
    }
    return g.map(r => r.join("")).join("\n");
};

const reportLayout = {
    grid: gridMerge(),
    rows: [
        { level: 0, y: 9, nodeIds: ["mA", "mB"] },
        { level: 1, y: 1, nodeIds: ["st"] },
        { level: 2, y: -1, nodeIds: ["out"] },
    ],
    placements: [
        { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 9], rot: 0, footprint: [1, 1] },
        { nodeId: "mB", op: "mine", kind: "miner", cell: [10, 9], rot: 0, footprint: [1, 1] },
        { nodeId: "st", op: "stack", kind: "stacker", cell: [0, 1], rot: 0, footprint: [2, 1] },
        { nodeId: "out", op: "trash", kind: "trash", cell: [0, -1], rot: 0, footprint: [1, 1] },
    ],
    channels: [
        { from: { nodeId: "mA", cell: [0, 9], slot: "top", outDir: "top" },
          to: { nodeId: "st", cell: [0, 1], slot: "bottom", inDir: "bottom" },
          lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0 },
        { from: { nodeId: "mB", cell: [10, 9], slot: "top", outDir: "top" },
          to: { nodeId: "st", cell: [1, 1], slot: "bottom", inDir: "bottom" },
          lane: laneRow, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1 },
        { from: { nodeId: "st", cell: [0, 1], slot: "top", outDir: "top" },
          to: { nodeId: "out", cell: [0, -1], slot: "bottom", inDir: "bottom" },
          lane: null, payload: "CuCuSuSu:RuRuCuCu", slotRole: "out", ordinal: null },
    ],
    lanes: [{ row: laneRow, channelIds: ["chB"] }],
    hubConnection: null,
    bbox: spanOf(mergeEntities),
    occupancy: [],
    conflicts: [
        { kind: "lane-column", cells: [[0, laneRow]], nodeIds: ["chA", "chB"],
          resolvedBy: "只让分支 B 拐弯（M4-SUCCESS 关键 1：分支 A 竖直直入 stacker 左格 → 车道行 3 与 col 0 不冲突）" },
    ],
    cornerCount: cornerTiles.length,
};

/* ══════════════════════════════ 3. report-validator.json ══════════════════════════════
 * 一张**故意错**的 plan 的 ValidatorReport（plan §2.7：P5 的变异测试以它为 golden，
 * P8 的分诊表以它的 check 名对齐 §2.5）。三个错：
 *   V9-unused-outlet fail —— cutter 左列 top 输出没接走（陷阱表 #7：堵死整机）
 *   V2 fail —— 规划区压住既有带子（C1：paste 静默销毁、不报告）
 *   V3 fail —— 1 格 drift（含机器邻居下 (r,rv) 非不动点 → 贴上去会堵死）
 * 场景几何：矿机(4,3) 出 top → 直带(4,2) → 拐角(4,1) 改西向 → 西向带(3,1)(2,1) → 拐角(1,1) 改上行
 *   → 直带 (1,0)? —— 简化：cutter 2×1 占 (0,0)(1,0)，右格 (1,0) 的 top 被接走，左格 (0,0) 的 top 无人接。
 */
const reportValidator = {
    pass: false,
    checks: [
        { id: "V1-occupancy", status: "pass", evidence: ev([0, 0], "n1", "落点矩形全空（r=0 的 2×1）", "2 格全空", "决策 D1：机器恒 r=0 → 无需旋转包围盒") },
        { id: "V2-no-overwrite-existing-belt", status: "fail", evidence: ev([5, 0], "belt@5,0", "规划区 ∩ replaceableBeltCells = ∅", "1 格重叠：(5,0) 既有带 uid 4113", "C1 最高危：paste 静默销毁可替换带，applied/failed 不报告被删了什么 → 整单 abort") },
        { id: "V3-belt-fixed-point", status: "fail", evidence: ev([6, 0], "belt@6,0", "(r=0,rv=0) 是 computeBelt 不动点", "rv 漂到 2", "§2.4：V3 是唯一能防住 rv 漂移的闸；漂移全在邻居含机器的角落（belt-rules.mjs:8-10）") },
        { id: "V4-slot-alignment", status: "pass", evidence: ev([1, 0], "n1", "被接走的输出 = cutter 右格 top（→ 左列）", "exit/entry 对齐", "只校验被接走的那条输出；另一条见 V9") },
        { id: "V5-degree", status: "pass", evidence: ev(null, "n1", "cutter 入度 1 ≤ 输入槽 1", "fanIn=1", "无 N>2 汇合（stacker/mixer 只有 2 个 bottom）") },
        { id: "V6-crossing", status: "pass", evidence: ev(null, null, "两股流不穿格", "0 处", "两条通道不同行 → 不需要隧道") },
        { id: "V7-throughput", status: "pass", evidence: ev(null, "n1", "需求 0.2/s", "瓶颈 0.5/s（cutter）", "无 stacker 0.25/s 瓶颈（GEOMETRY 表2）") },
        { id: "V8-scope", status: "pass", evidence: ev(null, null, "单层/无 wire/无隧道/机器 r=0/入度≤2", "满足", "越界应直接 ok:false + reason=out-of-scope:*（§2.5）") },
        { id: "V9-unused-outlet", status: "fail", evidence: ev([0, 0], "n1", "每个未接走的输出槽必须有 trash", "cutter 左格 (0,0) top 输出无去向", "陷阱表 #7：废弃输出不接走 → 堵死整机（开发期 B3 卡住的根因）") },
        { id: "V10-unlock-report", status: "pass", evidence: ev(null, "n1", "cutter 解锁等级 1", "level-2 目标可用", "§6 R4：L3 用 level-2 目标，两种口径都成立") },
        { id: "S1-shape-replay", status: "pass", evidence: ev(null, "n1", "----CuCu → 右列 CuCu", "hash 相等", "shape-ops 重放：被接走的右列产物与目标一致") },
    ],
    errors: [
        { check: "V2-no-overwrite-existing-belt", severity: "fatal", nodeId: "belt@5,0", cell: [5, 0], message: "规划区 (5,0) 压住既有可替换带（uid 4113）：paste 会静默销毁它且不报告 → 整单 abort（C1）" },
        { check: "V3-belt-fixed-point", severity: "fatal", nodeId: "belt@6,0", cell: [6, 0], message: "(6,0) 的 (r,rv)=(0,0) 在含机器邻居下不是 computeBelt 不动点（期望 rv=2）：贴上去物流会在第一个拐角死掉" },
        { check: "V9-unused-outlet", severity: "fatal", nodeId: "n1", cell: [0, 0], message: "cutter 左格 top 输出槽未接走且无 trash → 整机堵死；对策：自动补 trash（陷阱表 #7 / layout-grid.mjs:90-92）" },
    ],
    beltSim: {
        tilesChecked: 4,
        fixedPoints: 3,
        drift: [{ cell: [6, 0], wantRv: 2, gotRv: 0 }],
        includesMachineNeighbors: true,
    },
    shapeReplay: [
        { nodeId: "n0", expectedHash: "----CuCu", actualHash: "----CuCu", equal: true },
        { nodeId: "n1", expectedHash: "CuCu----", actualHash: "CuCu----", equal: true },
    ],
    throughput: { demandPerSec: 0.2, bottleneck: { nodeId: "n1", ratePerSec: 0.5 }, rowsRequired: 1, rowsPlanned: 1 },
};

/* ══════════════════════════════ 落盘 ══════════════════════════════ */
for (const [name, obj] of [["plan-l1.json", planL1], ["report-layout.json", reportLayout], ["report-validator.json", reportValidator]]) {
    fs.writeFileSync(path.join(FIX, name), JSON.stringify(obj, null, 2) + "\n", "utf8");
    console.log(`✓ 写出 research/ai-plan/fixtures/${name}`);
}
console.log(`✓ plan-l1：${planL1.entities.length} 实体 bbox=${JSON.stringify(l1Bbox)} cost=${planL1.stats.blueprintCost} 蓝图长度=${planL1.blueprint.length}`);
console.log(`✓ report-layout：${mergeEntities.length} 实体，拐角 ${cornerTiles.length}（r/rv 与 M4-SUCCESS 实机值一致），车道 row=${laneRow}`);
console.log(`✓ report-validator：${reportValidator.errors.length} 条 fatal（V2/V3/V9）`);
