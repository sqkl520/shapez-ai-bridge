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
 */
import { entityCells, expectedCells, gateG3, gateG4, gateG6, gateG6b } from "./gates.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra ? "  " + JSON.stringify(extra) : "")); }
}
function eq(got, want, label) {
    ok(got === want, label, { got, want });
}

/* ═════════ 夹具：一份最小 intent ═════════ */
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

console.log("── ① entityCells：footprint 必须展开 ──");
eq(entityCells("belt", 5, 5).length, 1, "belt 占 1 格");
eq(entityCells("cutter", 5, 5).length, 2, "cutter 2×1 占 2 格");
eq(entityCells("hub", 5, 5).length, 16, "hub 4×4 占 16 格");
eq(entityCells("cutter", 5, 5, 90).length, 2, "cutter 转 90° 仍占 2 格（宽高互换）");
{
    const cells = entityCells("cutter", 5, 5);
    ok(cells.some(c => c[0] === 6 && c[1] === 5), "cutter 的右半格被展开", cells);
}

console.log("\n── ② expectedCells：世界坐标 = anchor + [dx,dy] ──");
{
    const cells = expectedCells(intent);
    // miner 2×1 = 2 格 + cutter 2×1 = 2 格 + belt ×2 = 2 格 → 6 格
    eq(cells.size, 6, "展开后共 6 格（miner 2 + cutter 2 + belt 2）");
    ok(cells.has("10,10"), "miner 左半在 anchor 上");
    ok(cells.has("11,10"), "miner 右半被展开");
    ok(cells.has("10,12"), "cutter 原点在 anchor+[0,2]");
    ok(cells.has("11,12"), "cutter 右半被展开");
}

console.log("\n── ③ gateG3：三个条件都必须有灵敏度 ──");
{
    // 正例
    const good = await gateG3(intent, { blocked: [], destroys: [], would_apply: 4, would_delete: 0 });
    ok(good.ok, "干净落点 → 绿");

    // 反例 1：有阻断
    const blocked = await gateG3(intent, { blocked: [{ cell: [10, 10], reason: "solid collision" }], destroys: [], would_apply: 3, would_delete: 0 });
    ok(!blocked.ok, "有 blocked → 红（arm E）", blocked.reason);

    // 反例 2：会销毁
    const destroys = await gateG3(intent, { blocked: [], destroys: [{ uid: 1, cell: [5, 5], type: "belt" }], would_apply: 4, would_delete: 1 });
    ok(!destroys.ok, "有 destroys → 红（arm E）", destroys.reason);

    // 反例 3：实体数对不上
    const miscount = await gateG3(intent, { blocked: [], destroys: [], would_apply: 3, would_delete: 0 });
    ok(!miscount.ok, "would_apply 与实体数不符 → 红（arm E）", miscount.reason);

    // 单位检查：would_apply 是实体数（4），不是格数（5）
    const asCells = await gateG3(intent, { blocked: [], destroys: [], would_apply: 5, would_delete: 0 });
    ok(!asCells.ok, "若把 would_apply 当格数（5）→ 红，证明代码用的是实体数口径", asCells.reason);
}

console.log("\n── ④ gateG4：uid 消失与 code 不符都必须红 ──");
{
    const mkSnap = list => ({ byUid: new Map(list.map(e => [e.uid, e])) });

    const before = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },   // 既有实体
    ]);
    // 正例：既有保留 + 新增齐全（6 格：miner 2 + cutter 2 + belt 2）
    const goodAfter = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 11, y: 10, code: 7, type: "miner" },    // miner 右半
        { uid: 13, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 14, x: 11, y: 12, code: 9, type: "cutter" },   // cutter 右半
        { uid: 15, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 16, x: 11, y: 11, code: 1, type: "belt" },
    ]);
    ok(gateG4(intent, before, goodAfter).ok, "全部到位 → 绿");

    // 反例 1：既有 uid 消失（A3 静默销毁）
    const vanished = mkSnap([
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 11, y: 10, code: 7, type: "miner" },
        { uid: 13, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 14, x: 11, y: 12, code: 9, type: "cutter" },
        { uid: 15, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 16, x: 11, y: 11, code: 1, type: "belt" },
    ]);
    const g4a = gateG4(intent, before, vanished);
    ok(!g4a.ok, "既有 uid 消失 → 红（A3 的兜底，arm E）", g4a.reason);

    // 反例 2：code 不符
    const wrongCode = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 11, y: 10, code: 7, type: "miner" },
        { uid: 13, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 14, x: 11, y: 12, code: 9, type: "cutter" },
        { uid: 15, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 16, x: 11, y: 11, code: 99, type: "belt" },   // 错
    ]);
    const g4b = gateG4(intent, before, wrongCode);
    ok(!g4b.ok, "code 不符 → 红（arm E）", g4b.reason);

    // 反例 3：缺格
    const missing = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
    ]);
    const g4c = gateG4(intent, before, missing);
    ok(!g4c.ok, "预期格缺失 → 红（arm E）", g4c.reason);
}

console.log("\n── ⑤ gateG6b：死路判据不能看 itemsOnPath ──");
{
    // 正例：所有带子格都有对应路径且有 acceptor
    const good = {
        paths: [
            { cells: [[10, 11], [11, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] },
        ],
    };
    ok(gateG6b(intent, good).ok, "全部连通 → 绿");

    // 反例 1：**空**的死路（itemsOnPath=0）—— 这是关键
    const emptyDead = {
        paths: [
            { cells: [[10, 11], [11, 11]], itemsOnPath: 0, boundAcceptor: null },
        ],
    };
    const g6b1 = gateG6b(intent, emptyDead);
    ok(!g6b1.ok, "空的死路（itemsOnPath=0）也要红 —— 证明真的不看 itemsOnPath（arm E）", g6b1.reason);

    // 反例 2：有格没出现在任何路径上
    const uncovered = {
        paths: [
            { cells: [[10, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] },
        ],
    };
    const g6b2 = gateG6b(intent, uncovered);
    ok(!g6b2.ok, "有带子格没被覆盖 → 红（arm E）", g6b2.reason);
}

console.log("\n── ⑥ gateG6：按形状算增量，不用全厂 ──");
{
    const p1 = { window_seconds: 10, delivered_per_sec: { "RuRu----": 0.5, CuCuCuCu: 10 } };
    const p2 = { window_seconds: 20, delivered_per_sec: { "RuRu----": 1.0, CuCuCuCu: 10 } };

    // 目标 0.4/s 的理论值，80% = 0.32；实际 1.0 远超
    ok(gateG6(intent, p1, p2, 0.4).ok, "达标 → 绿");

    // 反例：目标形状产量没涨，但其他形状涨了（全厂口径会误判绿）
    const p3 = { window_seconds: 20, delivered_per_sec: { "RuRu----": 0.5, CuCuCuCu: 999 } };
    const g6a = gateG6(intent, p1, p3, 0.4);
    ok(!g6a.ok, "只有别的形状涨、目标没涨 → 红（证明用按形状口径，arm E）", g6a.reason);

    // 反例：窗口没前进（时钟停了）
    const g6b = gateG6(intent, p1, { ...p1, window_seconds: 10 }, 0.4);
    ok(!g6b.ok, "窗口没前进 → 红（时钟停的兜底）", g6b.reason);

    // 反例：产量不足 80%
    const p4 = { window_seconds: 20, delivered_per_sec: { "RuRu----": 0.6 } };
    const g6c = gateG6(intent, p1, p4, 0.4);
    ok(!g6c.ok, "0.1/s < 0.32/s 阈值 → 红（arm E）", g6c.reason);
}

console.log("\n" + "═".repeat(60));
console.log(`gates 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
}
process.exit(fail ? 1 : 0);
