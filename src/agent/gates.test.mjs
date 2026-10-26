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
    eq(cells.collisions, undefined, "无自叠时不带 collisions");

    /* ★ 回归锁：同格被两个实体占用不能静默覆盖 ★
       Map.set 后写覆盖先写 → belt 从集合里消失 → G6b 少要求一格 → 可以假绿。 */
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

    /* ★ 回归锁：anchor 必须是整数，否则会走字符串拼接 ★
       anchor: ["10","20"] 时 a[0]+e.dx 得到 "100"，key 全错位。 */
    let anchorThrew = false;
    try { expectedCells({ ...intent, anchor: ["10", "20"] }); } catch (e) { anchorThrew = true; }
    ok(anchorThrew, "非整数 anchor → 抛错（回归锁：不许字符串拼接）");
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

    /* ★ 回归锁：cutter 只有 origin 一条 obs 时也要绿 ★
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

    /* ★ 回归锁：朝向不符必须红 ★
       code 相同不代表落对了：cutter 2×1 在 rot=0 占 {(x,y),(x+1,y)}，
       rot=90 占 {(x,y),(x,y+1)} —— origin 与 code 都一样，物理格完全不同。
       这是 A2（方向反了）的形态，光比 code 抓不到。 */
    const wrongRot = mkSnap([
        { uid: 1, x: 100, y: 100, code: 1, type: "belt", r: 0 },
        { uid: 11, x: 10, y: 10, code: 7, type: "miner", r: 0 },
        { uid: 12, x: 10, y: 12, code: 9, type: "cutter", r: 90 },   // 朝向错
        { uid: 13, x: 10, y: 11, code: 1, type: "belt", r: 0 },
        { uid: 14, x: 11, y: 11, code: 1, type: "belt", r: 0 },
    ]);
    const g4r = gateG4(intent, before, wrongRot);
    ok(!g4r.ok, "朝向不符（code 对但 rot 错）→ 红（A2 的形态）", g4r.reason);

    /* ★ 回归锁：after 被截断时必须是 undecidable，不是"销毁了" ★
       obs 有 max_entities 上限。截断时既有 uid 会"消失"，
       那会被误报成"paste 销毁了它们，必须回滚" —— 完全错误的诊断。 */
    const truncatedAfter = {
        byUid: new Map([
            { uid: 11, x: 10, y: 10, code: 7, type: "miner", r: 0 },
        ].map(e => [e.uid, e])),
        truncated: true,
    };
    const g4t = gateG4(intent, before, truncatedAfter);
    ok(!g4t.ok, "after 被截断 → 红", g4t.reason);
    eq(g4t.undecidable, true, 'after 截断时标 undecidable（不是「销毁了」）');
    ok(/截断/.test(g4t.reason), 'after 截断的 reason 明确说「截断」', g4t.reason);
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

    /* ★ 回归锁：paths 被截断时不能当成"没连上" ★
       桥对 paths 做 slice(0,40)，但给了 pathCount（未截断总数）。
       两者不等 = 我们没看到全部 ⇒ 结论必须是"无法判定"，不是"红"。
       否则会误导去修一条本来没问题的线。 */
    const truncatedItems = {
        paths: [{ cells: [[10, 11]], itemsOnPath: 0, boundAcceptor: [10, 13] }],
        pathCount: 55,                       // 55 条但只返回 1 条
    };
    const g6b3 = gateG6b(intent, truncatedItems);
    ok(!g6b3.ok, 'paths 被截断 → 红（无法判定）', g6b3.reason);
    ok(/截断/.test(g6b3.reason), '截断的 reason 里明确说「截断」，不是「没连上」', g6b3.reason);
    eq(g6b3.evidence.truncated, true, "evidence.truncated 为 true");

    // 对照：没截断时同样数据应报"没覆盖"
    const notTruncated = { ...truncatedItems, pathCount: 1 };
    const g6b4 = gateG6b(intent, notTruncated);
    ok(!g6b4.ok, '未截断时 → 红（没覆盖）', g6b4.reason);
    ok(/没出现在任何路径/.test(g6b4.reason), '未截断的 reason 是「没覆盖」', g6b4.reason);

    /* ★ 回归锁：隧道格不参与"被覆盖"的判定 ★
       游戏的地下带没有 Belt 组件，beltPaths 只由 Belt 组件构成，
       所以隧道格永远不出现在任何 path 的 cells 里。
       实测：隧道在 (-7,-12)/(-7,-14)，经过它的路径直接跨过去，两格都不在。
       拿它去要求覆盖 = 任何含隧道的蓝图必然假红。 */
    const tunnelIntent = {
        goal: "RuRu----", anchor: [0, 0], count: 3,
        entities: [
            { kind: "belt", dx: 0, dy: 0, rot: 0, code: 1, nodeId: "b0" },
            { kind: "underground_belt", dx: 1, dy: 0, rot: 0, code: 22, nodeId: "t0" },
            { kind: "underground_belt", dx: 3, dy: 0, rot: 0, code: 23, nodeId: "t1" },
        ],
    };
    const tunnelItems = {
        paths: [{ cells: [[0, 0], [4, 0]], itemsOnPath: 0, boundAcceptor: [9, 9] }],   // 跳过隧道两格
    };
    const g6bt = gateG6b(tunnelIntent, tunnelItems);
    ok(g6bt.ok, '含隧道时不算"没覆盖"（隧道格不参与判定，回归锁）', g6bt.reason);
    eq(g6bt.evidence.tunnel_cells_not_verifiable, 2, "evidence 里如实记隧道格数");

    /* ★ 回归锁：boundAcceptor 缺失（undefined）也要算死路 ★
       桥在异常分支里可能根本不带这个 key，`undefined !== null` 会 fail-open。 */
    const undefAcceptor = {
        paths: [{ cells: [[10, 11]], itemsOnPath: 0 }],   // 没有 boundAcceptor 字段
    };
    const g6bu = gateG6b(intent, undefAcceptor);
    ok(!g6bu.ok, 'boundAcceptor 缺失（undefined）→ 红（不许 fail-open）', g6bu.reason);

    /* ★ 回归锁：debug_items 自己报错时要明说，不能混成"没连上" ★ */
    const beltErr = { paths: [], beltError: "some internal failure" };
    const g6be = gateG6b(intent, beltErr);
    ok(!g6be.ok, "beltError 存在 → 红", g6be.reason);
    ok(/自己报错/.test(g6be.reason), 'beltError 的 reason 明确说「debug_items 自己报错」', g6be.reason);
}

console.log("\n── ⑥ gateG6：用两次 total 差值算本线速率 ──");
{
    /* 签名：(intent, t1, t2, p1, p2, expectedRate)
       · t 是**游戏时钟**（秒），不是 window_seconds（那是常量，dt 恒 0）
       · 速率 = (delivered_total[2] - delivered_total[1]) / (t2 - t1)
         —— 用 total 的差，不用 per_sec 的差，也不用全厂的绝对值。
         全厂绝对值会被老线掩盖（L4 全厂 4.18/s 恒过阈值而新线零产出）。
         per_sec 的差会把稳态线（1.0→1.0）判死（差是 0）。 */
    const mk = (tot, rate) => ({
        delivered_total: { "RuRu----": tot },
        delivered_per_sec: { "RuRu----": rate, CuCuCuCu: 999 },
        produced_per_sec: {},
    });

    // 达标：100→160 秒（60s）内交付 60 个 = 1.0/s，理论 0.4 的 80% = 0.32
    ok(gateG6(intent, 100, 160, mk(0, 0), mk(60, 1.0), 0.4).ok, "60s 内交付 60 个 = 1.0/s ≥ 0.32 → 绿");

    // ★ 回归锁：稳态（两次速率相同）必须绿 ★
    //   旧实现比"速率之差"，1.0→1.0 的差是 0 → 被判死。
    ok(gateG6(intent, 100, 160, mk(100, 1.0), mk(160, 1.0), 0.4).ok,
        "稳态交付（per_sec 相同但 total 在涨）→ 绿（回归锁：看 total 不看 per_sec 差）");

    // ★ 回归锁：老线已达标不能掩盖新线零产出 ★
    //   全厂绝对值口径下，只要 hub 里有人交这个形状就会绿。
    ok(!gateG6(intent, 100, 160, mk(5000, 5.0), mk(5000, 5.0), 0.4).ok,
        "老线一直在交（total 不变）→ 红（回归锁：不看全厂绝对值）");

    // 时钟没前进
    ok(!gateG6(intent, 100, 100, mk(0, 0), mk(60, 1.0), 0.4).ok, "t1===t2（时钟没走）→ 红");

    // 产量不足：60s 只交 12 个 = 0.2/s
    ok(!gateG6(intent, 100, 160, mk(0, 0), mk(12, 0.2), 0.4).ok, "0.2/s < 0.32/s 阈值 → 红（arm E）");

    // ★ 形状键从未出现 → 不能当成"速率为 0" ★
    //   intent.goal 与游戏 hash 格式不符时会走到这里，报"速率 0"会指向错误方向。
    const noKey = { delivered_total: { CuCuCuCu: 10 }, delivered_per_sec: {}, produced_per_sec: {} };
    const g6x = gateG6(intent, 100, 160, noKey, noKey, 0.4);
    ok(!g6x.ok, "形状键从未出现 → 红", g6x.reason);
    ok(/从未出现/.test(g6x.reason), '形状键缺失的 reason 明确说「从未出现」不是「速率 0」', g6x.reason);

    // ★ 理论值为 0 时不能 fail-open ★
    ok(!gateG6(intent, 100, 160, mk(0, 0), mk(60, 1.0), 0).ok, "理论值 0 → 红，不许 fail-open（回归锁）");
}

console.log("\n" + "═".repeat(60));
console.log(`gates 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
}
process.exit(fail ? 1 : 0);
