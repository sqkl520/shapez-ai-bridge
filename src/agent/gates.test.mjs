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
eq(entityCells("miner", 5, 5).length, 1, "miner 占 1 格（实测：四台在 (2..5,-8) 相邻共存）");
eq(entityCells("rotater", 5, 5).length, 1, "rotater 占 1 格（继承默认 Vector(1,1)）");
eq(entityCells("cutter", 5, 5, 90).length, 2, "cutter 转 90° 仍占 2 格（宽高互换）");
{
    const cells = entityCells("cutter", 5, 5);
    ok(cells.some(c => c[0] === 6 && c[1] === 5), "cutter 的右半格被展开", cells);
}

console.log("\n── ② expectedCells：世界坐标 = anchor + [dx,dy] ──");
{
    const cells = expectedCells(intent);
    // miner 1×1 = 1 格 + cutter 2×1 = 2 格 + belt ×2 = 2 格 → 5 格
    eq(cells.size, 5, "展开后共 5 格（miner 1 + cutter 2 + belt 2）");
    ok(cells.has("10,10"), "miner 在 anchor 上");
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
    /* 正例：既有保留 + 新增与蓝图一致。
       ★ 关键：按**实体**比对，不是按格 ★
       obs 对每台建筑只报一条（origin），cutter 2×1 也不会给出右半那条。
       所以这里每条:  miner(1) + cutter(1) + belt(2) = 4 条，不是 5 格。 */
    const goodAfter = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 13, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 14, x: 11, y: 11, code: 1, type: "belt" },
    ]);
    ok(gateG4(intent, before, goodAfter).ok, "全部到位 → 绿（按实体口径，cutter 只报 origin）");

    // 反例 1：既有 uid 消失（A3 静默销毁）
    const vanished = mkSnap([
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 13, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 14, x: 11, y: 11, code: 1, type: "belt" },
    ]);
    const g4a = gateG4(intent, before, vanished);
    ok(!g4a.ok, "既有 uid 消失 → 红（A3 的兜底，arm E）", g4a.reason);

    // 反例 2：code 不符
    const wrongCode = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter" },
        { uid: 13, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 14, x: 11, y: 11, code: 99, type: "belt" },   // 错
    ]);
    const g4b = gateG4(intent, before, wrongCode);
    ok(!g4b.ok, "code 不符 → 红（arm E）", g4b.reason);

    // 反例 3：缺实体
    const missing = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
    ]);
    const g4c = gateG4(intent, before, missing);
    ok(!g4c.ok, "缺实体 → 红（arm E）", g4c.reason);

    /* ★ 回归锁：cutter 在 obs 里只报 origin 一条 ★
       曾经按格比对，要求 (11,12) 也有实体 —— 而游戏永远不给，
       任何含 cutter 的蓝图都会被判死。这条锁住"不这么要求"。 */
    const cutterOriginOnly = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt" },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner" },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter" },   // 只有 origin，没有右半
        { uid: 13, x: 10, y: 11, code: 1, type: "belt" },
        { uid: 14, x: 11, y: 11, code: 1, type: "belt" },
    ]);
    ok(gateG4(intent, before, cutterOriginOnly).ok,
        "cutter 只有 origin 一条 obs 时也要绿（回归锁：不按格要求）");
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

console.log("\n── ⑥ gateG6：用游戏时钟算时长，比的是速率不是增量 ──");
{
    /* 签名：(intent, t1, t2, production, expectedRate)
       t 是两个时间点的**游戏时钟**（秒），不是 window_seconds ——
       桥的 window_seconds 是 `slices*10` 常量，拿它算 dt 永远是 0。
       比的是"后一次采样的速率"而不是"速率之差" ——
       稳态线（1.0→1.0）的差是 0，拿差值比阈值会把正常线判死。 */
    const p = (r) => ({ delivered_per_sec: { "RuRu----": r, CuCuCuCu: 999 } });

    // 达标：稳态 1.0/s，理论 0.4/s 的 80% = 0.32
    ok(gateG6(intent, 100, 160, p(1.0), 0.4).ok, "稳态 1.0/s ≥ 0.32 → 绿");

    // ★ 回归锁：稳态线（两次相同）必须绿 ★
    //   旧实现比"速率之差的绝对值"，1.0→1.0 的差是 0 → 被判死。
    ok(gateG6(intent, 100, 160, p(1.0), 0.4).ok, "两次速率相同（稳态）→ 绿（回归锁：不比增量）");

    // ★ 回归锁：全厂别的形状再高也不能救目标形状 ★
    const allHigh = { delivered_per_sec: { "RuRu----": 0.1, CuCuCuCu: 999 } };
    ok(!gateG6(intent, 100, 160, allHigh, 0.4).ok, "目标形状只有 0.1/s 而别的形状 999 → 红（按形状口径）");

    // 时钟没前进
    ok(!gateG6(intent, 100, 100, p(1.0), 0.4).ok, "t1===t2（时钟没走）→ 红");

    // 产量不足
    ok(!gateG6(intent, 100, 160, p(0.2), 0.4).ok, "0.2/s < 0.32/s 阈值 → 红（arm E）");

    // ★ 理论值为 0 时不能 fail-open ★
    //   旧实现在 0 台矿机时阈值 = 0，任何速率都 ≥ 0 → 永远绿。
    ok(!gateG6(intent, 100, 160, p(0), 0).ok, "理论值 0（没矿机）→ 红，不许 fail-open（回归锁）");
}

console.log("\n" + "═".repeat(60));
console.log(`gates 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
}
process.exit(fail ? 1 : 0);
