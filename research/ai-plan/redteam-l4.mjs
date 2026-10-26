/**
 * redteam-l4.mjs — 把 2026-10-26 的 L4 事故做成离线夹具，逐闸实跑，看哪几道会假绿。
 *
 * 事故（research/ai-plan/L4-ATTEMPT-LOG.md:26-46）：
 *   108 实体贴进去，dry_run 0 阻断 0 销毁，G4 逐实体全过；
 *   但 (21,-5) 本应 in=left/out=top（rv=1），运行时是 r=90 的**直带**（rv=0，出口 right）；
 *   货顺着 82 格绕行直接进 hub，切割机一个都没切到；
 *   RuRuRuRu 涨到 2.95/s（"总产量"看着正常）。
 *
 * 几何自洽性（用 src/ai/belt-rules.mjs 的 solveTurn 逐格核过）：
 *   miner(18,2) out=top → 竖带 (18,1)…(18,-4) → 拐角 (18,-5) in=bottom/out=right
 *   → (19,-5)(20,-5) in=left/out=right → 拐角 (21,-5) in=left/out=top
 *   → (21,-6) in=bottom/out=top → cutter(21,-7)
 *
 * 不连游戏、不写源文件。用法：node research/ai-plan/redteam-l4.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const G = await import(pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);

const A = [0, 0];
const E = (kind, x, y, rot, rv, code, inDir, outDir, nodeId) =>
    ({ kind, dx: x, dy: y, rot, rotationVariant: rv, code, inDir, outDir, nodeId });

const entities = [
    E("miner", 18, 2, 0, 0, 7, null, "top", "m0"),
    E("belt", 18, 1, 0, 0, 1, "bottom", "top", "f0"),
    E("belt", 18, 0, 0, 0, 1, "bottom", "top", "f1"),
    E("belt", 18, -1, 0, 0, 1, "bottom", "top", "f2"),
    E("belt", 18, -2, 0, 0, 1, "bottom", "top", "f3"),
    E("belt", 18, -3, 0, 0, 1, "bottom", "top", "f4"),
    E("belt", 18, -4, 0, 0, 1, "bottom", "top", "f5"),
    E("belt", 18, -5, 0, 2, 3, "bottom", "right", "f6"),     // 拐角：入 bottom 出 right
    E("belt", 19, -5, 90, 0, 1, "left", "right", "f7"),
    E("belt", 20, -5, 90, 0, 1, "left", "right", "f8"),
    E("belt", 21, -5, 90, 1, 2, "left", "top", "j0"),        // ★ 事故格（intent 声明）
    E("belt", 21, -6, 0, 0, 1, "bottom", "top", "j1"),
    E("cutter", 21, -7, 0, 0, 9, "bottom", "top", "c0"),
];
const intent = { goal: "RuRu----", anchor: A, entities };

const mk = (list, truncated = false) => ({
    entities: list,
    byUid: new Map(list.map(e => [e.uid, e])),
    byCell: new Map(list.map(e => [`${e.x},${e.y}`, e])),
    truncated,
});

/* before：既有工厂（hub + 一段旧带子） */
const old = [
    { uid: 1, type: "belt", x: 0, y: 0, r: 180, rotation_variant: 0, code: 1 },
    { uid: 2, type: "hub", x: -2, y: -2, r: 0, rotation_variant: 0, code: 26 },
];
const before = mk(old);

/* after 形态 A：游戏"忠实"贴了蓝图（r/ rv / code 与 intent 一致） */
let uid = 20000;
const addedFaithful = entities.map(e => ({
    uid: uid++, type: e.kind, x: e.dx, y: e.dy,
    r: e.rot, rotation_variant: e.rotationVariant, code: e.code,
}));
/* after 形态 B：j0 在游戏里被重算成直带（r=90, rv=0, code=1）—— 事故的最终态 */
const addedFlipped = addedFaithful.map((e, i) => i === 10
    ? { ...e, r: 90, rotation_variant: 0, code: 1 } : e);
/* after 形态 C：G4 在贴完那一瞬间采样，之后才翻向 —— 等价于形态 A 的快照 */
const afterA = mk([...old, ...addedFaithful]);
const afterB = mk([...old, ...addedFlipped]);

/* debug_items：事故的运行时拓扑
 *   主干 (18,1)…(21,-5) 一路向东，接上 82 格绕行 → hub（boundAcceptor 非空）
 *   (21,-6) 成为没有上游的单格 path（boundAcceptor = cutter —— 所以不是死路！）
 */
const detour = [];
for (let x = 22; x <= 60; x++) detour.push([x, -5]);
for (let y = -4; y <= 0; y++) detour.push([60, y]);
for (let x = 59; x >= 0; x--) detour.push([x, 0]);
const itemsAccident = {
    pathCount: 2,
    paths: [
        { cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                  [19, -5], [20, -5], [21, -5], ...detour], itemsOnPath: 5, boundAcceptor: [-1, 0] },
        { cells: [[21, -6]], itemsOnPath: 0, boundAcceptor: [21, -7] },
    ],
};
const itemsHealthy = {
    pathCount: 1,
    paths: [{ cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                      [19, -5], [20, -5], [21, -5], [21, -6]],
              itemsOnPath: 6, boundAcceptor: [21, -7] }],
};

/* production：事故结局 —— 粗产物 RuRuRuRu 2.9/s（贴前 1.2/s），成品 RuRu---- 从未出现 */
const slices = (per, n = 6) => ({
    slice_seconds: 10,
    delivered_slices: Array.from({ length: n }, () => ({ ...per })),
    produced_slices: Array.from({ length: n }, () => ({ ...per })),
});
const prodBefore = slices({ RuRuRuRu: 12, "----CuCu": 5 });
const prodAfter = slices({ RuRuRuRu: 29, "----CuCu": 5 });

/* L4 的理论上限（expectedRateOf 的口径：min(矿机 4×0.4=1.6, 切割机 1×0.5=0.5) = 0.5） */
const EXPECTED = 0.5;

const line = s => "─".repeat(4) + " " + s + " " + "─".repeat(58);
const row = (id, r) => {
    console.log(`\n${line(id)}`);
    console.log(`  ok=${r.ok}${r.undecidable ? "  undecidable" : ""}`);
    console.log(`  reason: ${r.reason ?? "(null)"}`);
    console.log(`  evidence: ${JSON.stringify(r.evidence)}`);
};

console.log("═".repeat(80));
console.log("L4 事故夹具 · 逐闸实跑（离线，不连游戏）");
console.log("═".repeat(80));

console.log("\n" + line("G-1-clock"));
console.log("  需要真实 debug_loop。事故发生时时钟健康（tick 正常推进）⇒ 这一段必然绿。");
console.log("  它只保证「读数不是假的」，对内容对错没有任何信息量。");

row("G3-clearance", await G.gateG3(intent, {
    would_apply: entities.length, would_delete: 0, blocked: [], destroys: [], unknown_code: [],
}));

row("G4-landing · 形态A（贴完瞬间，r/rv/code 与 intent 一致）", G.gateG4(intent, before, afterA));
row("G4-landing · 形态B（j0 已被游戏重算成直带 rv=0/code=1）", G.gateG4(intent, before, afterB));

/* 形态 C：编译器自己就把几何字段写成了直带（rv=0/code=1/rot=90），
 * 只有 inDir/outDir 那段文本还写着 left/top。蓝图由同一份 entities 编码 ⇒ 游戏忠实落地。
 * 这时无论 G4 在什么时候采样，期望值都与世界一致 —— G4 在结构上不可能红。 */
const intentSelfWrong = {
    ...intent,
    entities: entities.map(e => e.nodeId === "j0"
        ? { ...e, rot: 90, rotationVariant: 0, code: 1 } : e),
};
const addedSelfWrong = entities.map((e, i) => ({
    uid: 50000 + i, type: e.kind, x: e.dx, y: e.dy,
    r: e.nodeId === "j0" ? 90 : e.rot,
    rotation_variant: e.nodeId === "j0" ? 0 : e.rotationVariant,
    code: e.nodeId === "j0" ? 1 : e.code,
}));
const afterC = mk([...old, ...addedSelfWrong]);
row("G3 · 形态C（编译器自己写成直带）", await G.gateG3(intentSelfWrong, {
    would_apply: entities.length, would_delete: 0, blocked: [], destroys: [], unknown_code: [],
}));
row("G4-landing · 形态C（编译器自己写成直带；in/out 文本仍是 left/top）",
    G.gateG4(intentSelfWrong, before, afterC));
row("G6b · 形态C（同一份事故拓扑）", G.gateG6b(intentSelfWrong, itemsAccident));

row("G6b-connectivity · 事故拓扑", G.gateG6b(intent, itemsAccident));
row("G6b-connectivity · 健康对照", G.gateG6b(intent, itemsHealthy));

row("G6 · goal=RuRu----（正确目标，事故后为 0）", G.gateG6(intent, prodBefore, prodAfter, EXPECTED));
row("G6 · goal=RuRuRuRu（粗产物，2.9/s —— 覆盖「总产量涨了就绿」）",
    G.gateG6({ ...intent, goal: "RuRuRuRu" }, prodBefore, prodAfter, EXPECTED));

console.log("\n" + "═".repeat(80));
console.log("G4 实际比较的字段（gates.mjs:413-431）");
console.log("═".repeat(80));
const j0 = intent.entities.find(e => e.nodeId === "j0");
console.log("intent.entities[j0]   =", JSON.stringify(j0));
console.log("obs after (21,-5)     =", JSON.stringify(afterA.byCell.get("21,-5")));
console.log("比较：cell ✓ | code 2==2 ✓ | rot 90==90 ✓");
console.log("不比较：rotationVariant（gates.mjs 全文 0 次命中）、inDir/outDir（0 次命中）");
console.log("intent 里 in=left/out=top 只是**文本**，G3/G4/G6b 都不读它；");
console.log("而 belt-rules.solveTurn('left','top') = {rotation:90, rotationVariant:1} —— 这份声明本身是自洽的，");
console.log("所以「期望值来自编译器」时，编译器算错=期望值也错，G4 永远只能验「贴得准不准」。");
