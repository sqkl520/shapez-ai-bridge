/**
 * verify_runtime.test.mjs — verifyRuntime 的离线自测（不连游戏）。
 *
 * 纪律（与 gates.test.mjs 同源）：每条断言都要有一个「去掉对应检查就会假绿」的夹具。
 * 所以这里的核心用例全部是**负例**：
 *   · 说贴了但世界里没有            → L1 必须红
 *   · rotation 被改错               → L1 必须红
 *   · code/rv 被改错                → L1 必须红
 *   · 换了一个 uid 的同格实体        → L1 必须红（uid 是身份）
 *   · 声明删除的东西还在            → L1 必须红
 *   · 机器放进去但没接上游           → L2 必须红
 *   · 货流走不到目的地               → L3 必须红
 *   · 截断（obs / paths）            → 必须 undecidable，**不是绿**
 * 每个负例都配一个正例，证明它不是恒红。
 *
 * 另外钉住「验证器不借用生成器的算术」这条：各检查的期望值全部来自夹具里手写的
 * obs / paths 字面量，不从宏或编译器算出来。
 *
 * 用法：node src/agent/verify_runtime.test.mjs
 * 退出码：0 全过 / 1 有失败
 */
import {
    verifyRuntime, normalizePlan, checkLanding, checkSlots, checkFlow, slotsOf, acceptorOf,
} from "./verify_runtime.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    // 防假绿：若漏了 await，cond 会是 Promise（恒真）——当场判死，与 gates.test.mjs 同一条纪律。
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，断言无效；漏了 await 吗？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

/* ═════════════════════════ 夹具 ═════════════════════════
 *
 * 场景：测试区的 cutter(60,-45) + trash(60,-46)，上游 3 格带子（60,-44..-42），
 * 右槽的产物经 (61,-46)(61,-47) 进另一个 trash(61,-48)。
 *
 *   belt 60,-42 → 60,-43 → 60,-44 → [cutter 60,-45 (in: bottom)]
 *                                        ├ left  → trash 60,-46   （废料）
 *                                        └ right → belt 61,-46 → 61,-47 → trash 61,-48
 */

const ENT = {
    b42: { uid: 20001, type: "belt", x: 60, y: -42, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    b43: { uid: 20002, type: "belt", x: 60, y: -43, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    b44: { uid: 20003, type: "belt", x: 60, y: -44, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    cutter: { uid: 20010, type: "cutter", x: 60, y: -45, r: 0, variant: "default", rotation_variant: 0, code: 9, layer: "regular" },
    waste: { uid: 20011, type: "trash", x: 60, y: -46, r: 0, variant: "default", rotation_variant: 0, code: 20, layer: "regular" },
    b46: { uid: 20004, type: "belt", x: 61, y: -46, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    b47: { uid: 20005, type: "belt", x: 61, y: -47, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" },
    out: { uid: 20012, type: "trash", x: 61, y: -48, r: 0, variant: "default", rotation_variant: 0, code: 20, layer: "regular" },
};

const mkObs = (entities, extra = {}) => ({
    entities, entity_count: entities.length, truncated: false, tick: 1000, layer: "regular", ...extra,
});

/** 游戏自己的 paths：两条，接收方都是机器（boundAcceptor 回 "yes"，与实测一致） */
const mkItems = (extra = {}) => ({
    pathCount: 2,
    paths: [
        { cells: [[60, -42], [60, -43], [60, -44]], boundAcceptor: "yes", itemsOnPath: 3 },
        { cells: [[61, -46], [61, -47]], boundAcceptor: "yes", itemsOnPath: 1 },
    ],
    truncatedPaths: false,
    ...extra,
});

const PLAN = {
    placements: [
        { uid: null, kind: "cutter", variant: "default", x: 60, y: -45, rot: 0, rv: 0, code: 9 },
        { uid: null, kind: "trash", variant: "default", x: 60, y: -46, rot: 0, rv: 0, code: 20 },
    ],
    removes: [{ uid: 19999, expect: null }],
    source: "test",
    flows: null,
};

const clone = o => JSON.parse(JSON.stringify(o));

/* ═════════════════════════ 0. 计划归一化 ═════════════════════════ */

{
    // intent 形态：anchor + dx/dy
    const n = normalizePlan({
        anchor: [10, 20],
        entities: [
            { dx: 0, dy: 0, kind: "miner", code: 7, rot: 0, rotationVariant: 0 },
            { dx: 1, dy: 2, kind: "belt", code: 1, rot: 90, rotationVariant: 0 },
        ],
    });
    eq(n.placements.length, 2, "normalize: intent 的 anchor+dx/dy 展开成世界坐标");
    eq(n.placements[0].x, 10, "normalize: anchor 加到 x");
    eq(n.placements[1].y, 22, "normalize: anchor 加到 y");
    eq(n.placements[0].code, 7, "normalize: code 原样保留");

    // 宏返回形态：placed[].origin
    const n2 = normalizePlan({ placed: [{ kind: "cutter", origin: [4, -13], rotation: 0, rotationVariant: 0, code: 9 }] });
    eq(n2.placements.length, 1, "normalize: 宏 placed[].origin");
    eq(n2.placements[0].x, 4, "normalize: origin → 世界 x");

    // ops 形态：delete{uid} + place
    const n3 = normalizePlan([
        { op: "delete", uid: 42 },
        { op: "place", building: "belt", x: 3, y: 4, r: 0, rotationVariant: 2 },
    ]);
    eq(n3.placements.length, 1, "normalize: ops[] 的 place 被收进来");
    eq(n3.removes.length, 1, "normalize: ops[] 的 delete{uid} 变成 removes");
    eq(n3.removes[0].uid, 42, "normalize: removes uid 正确");
    eq(n3.placements[0].rv, 2, "normalize: place 的 rotationVariant → rv");

    // belt 的 code → rv 单向补全（命题 A：code = 1 + rv）
    const n4 = normalizePlan({ placements: [{ kind: "belt", x: 0, y: 0, code: 3 }] });
    eq(n4.placements[0].rv, 2, "normalize: belt 的 code=3 补出 rv=2");

    // 机器不补 rv（机器 code 编码 kind+variant，不编码 rv）
    const n5 = normalizePlan({ placements: [{ kind: "cutter", x: 0, y: 0, code: 9 }] });
    eq(n5.placements[0].rv, null, "normalize: 机器不从 code 补 rv（不猜）");

    // 认不出的形态必须抛，不静默返回空
    let threw = false;
    try { normalizePlan({ hello: 1 }); } catch (e) { threw = true; }
    ok(threw, "normalize: 认不出的 plan 形态直接抛错（不静默返回空计划）");

    // 世界快照（obs.entities 数组）不是计划 —— 必须显式拒绝，不能当成"空计划"报真空绿
    {
        let msg = null;
        try { normalizePlan([{ uid: 10001, type: "belt", x: 0, y: 0, r: 0 }]); } catch (e) { msg = e.message; }
        ok(msg !== null, "normalize: 把世界快照当计划传进来 → 抛错（不报真空绿）");
        ok(/世界快照/.test(msg || ""), "normalize: 错误信息点名「这是世界快照，不是计划」", msg);
    }

    // 真正的 raw ops 仍然认
    {
        const n = normalizePlan([{ op: "place", building: "belt", x: 0, y: 0, r: 0 }]);
        eq(n.source, "ops[]", "normalize: 元素带 op 的数组仍然按 raw ops 处理");
        eq(n.placements.length, 1, "normalize: raw ops 的 place 被收进来");
    }
}

/* ═════════════════════════ 1. L1 落地 ═════════════════════════ */

{
    const obs = mkObs(Object.values(ENT));
    const good = checkLanding(PLAN, obs);
    ok(good.ok, "L1 正例：计划每台都在、type/code/rot/rv 全对 → 绿", good.reason);
    eq(good.evidence.removed_ok, 1, "L1 正例：声明删除的 uid 不在 obs 里 → 算已删");

    // 负例：说贴了但世界里没有
    {
        const p = clone(PLAN);
        p.placements.push({ uid: null, kind: "miner", variant: "default", x: 70, y: -40, rot: 0, rv: 0, code: 7 });
        const r = checkLanding(p, obs);
        ok(!r.ok, "L1 负例：计划里一台机器世界里不存在 → 红（说贴了但实际没有）", r.reason);
        eq(r.evidence.missing.length, 1, "L1 负例：missing 记了 1 台");
    }

    // 负例：rotation 被改错（核心负例）
    {
        const p = clone(PLAN);
        p.placements[0].rot = 90;
        const r = checkLanding(p, obs);
        ok(!r.ok, "L1 负例：cutter rotation 90 vs 实际 0 → 红", r.reason);
        eq(r.evidence.wrong_rot.length, 1, "L1 负例：wrong_rot 记 1 处");
        eq(r.evidence.wrong_rot[0].want, 90, "L1 负例：wrong_rot 报出期望 90");
        eq(r.evidence.wrong_rot[0].got, 0, "L1 负例：wrong_rot 报出实际 0");
    }

    // 负例：belt 的 rv 被改错（code 相同但 rv 不同 → 物理格不变但流向反了）
    {
        const obs2 = mkObs(Object.values(ENT).map(e => e.uid === 20001 ? { ...e, rotation_variant: 1, code: 2 } : e));
        const p = clone(PLAN);
        p.placements.push({ uid: null, kind: "belt", variant: "default", x: 60, y: -42, rot: 0, rv: 0, code: 1 });
        const r = checkLanding(p, obs2);
        ok(!r.ok, "L1 负例：belt rv 0 vs 实际 1 → 红", r.reason);
        ok(r.evidence.wrong_rv.length >= 1 || r.evidence.wrong_code.length >= 1, "L1 负例：rv/code 至少一处被判");
    }

    // 负例：code 被改错
    {
        const p = clone(PLAN);
        p.placements[1].code = 21;    // 实际 20
        const r = checkLanding(p, obs);
        ok(!r.ok, "L1 负例：trash code 21 vs 实际 20 → 红", r.reason);
        eq(r.evidence.wrong_code.length, 1, "L1 负例：wrong_code 记 1 处");
    }

    // 负例：type 被改错
    {
        const p = clone(PLAN);
        p.placements[1].kind = "cutter";
        const r = checkLanding(p, obs);
        ok(!r.ok, "L1 负例：把 trash 计划成 cutter → 红", r.reason);
        eq(r.evidence.wrong_type.length, 1, "L1 负例：wrong_type 记 1 处");
    }

    // 负例：uid 是身份 —— 计划给了 uid，世界里同格是一个新 uid（游戏删了又补）
    {
        const p = clone(PLAN);
        p.placements[0].uid = 99999;      // 同 origin 同 code，但 uid 不同
        const r = checkLanding(p, obs);
        // uid 优先查找：找不到直接算 missing —— 这是"贴的不是同一台"
        ok(!r.ok, "L1 负例：计划 uid 99999 在世界里不存在（同格有别的 uid）→ 红", r.reason);
    }

    // 负例：声明要删的 uid 还在
    {
        const p = clone(PLAN);
        p.removes = [{ uid: 20011, expect: null }];   // 20011 = waste trash，还活着
        const r = checkLanding(p, obs);
        ok(!r.ok, "L1 负例：声明删掉的 uid 仍然存在 → 红（删除没落地）", r.reason);
        eq(r.evidence.removed_still_there.length, 1, "L1 负例：removed_still_there 记 1 条");
    }

    // 负例：声明了 inDir/outDir 的带子，世界里的 (rv,rot) 推出来的方向反了
    //        —— L4 事故的形态：origin/code 都可能对，但流向被游戏重算
    {
        const p = clone(PLAN);
        p.placements.push({ uid: null, kind: "belt", variant: "default", x: 60, y: -42, rot: 0, rv: 0, code: 1, inDir: "bottom", outDir: "top" });
        const obsFlip = mkObs(Object.values(ENT).map(e => e.uid === 20001 ? { ...e, rotation_variant: 0, r: 180, code: 1 } : e));
        const r = checkLanding(p, obsFlip);
        // r=180, rv=0 → entry top / exit bottom，与声明的 bottom/top 正好相反
        ok(!r.ok, "L1 负例：带子声明 in=bottom/out=top，世界 r=180 推出来 in=top/out=bottom → 红", r.reason);
        eq(r.evidence.wrong_dir.length, 2, "L1 负例：wrong_dir 记 2 条（入口和出口各一）");
    }

    // 正例：声明与实际流向一致
    {
        const p = clone(PLAN);
        p.placements.push({ uid: null, kind: "belt", variant: "default", x: 60, y: -42, rot: 0, rv: 0, code: 1, inDir: "bottom", outDir: "top" });
        const r = checkLanding(p, obs);
        ok(r.ok, "L1 正例：带子 inDir/outDir 声明与世界一致 → 绿", r.reason);
        eq(r.evidence.wrong_dir.length, 0, "L1 正例：wrong_dir 为 0");
    }

    // 真空绿：空计划必须红，不能"没有东西要验 = 通过"
    {
        const r = checkLanding({ placements: [], removes: [] }, obs);
        ok(!r.ok, "L1 真空绿保护：空计划 → 红（没有可验证的东西不等于通过）", r.reason);
    }
}

/* ═════════════════════════ 2. L2 槽位邻接 ═════════════════════════ */

{
    const obs = mkObs(Object.values(ENT));
    const items = mkItems();
    const good = checkSlots(PLAN, obs, items);
    ok(good.ok, "L2 正例：cutter 有上游、trash 收 cutter 的左槽 → 绿", good.reason);
    ok(good.evidence.fed_inputs >= 2, "L2 正例：至少 2 个输入槽有证据", good.evidence);
    eq(good.evidence.unfed_inputs.length, 0, "L2 正例：没有挨饿的机器");

    // 负例：机器放进去了但上游是空的（把上游 3 格带子删掉）
    {
        const obs2 = mkObs([ENT.cutter, ENT.waste, ENT.b46, ENT.b47, ENT.out]);
        const items2 = { pathCount: 1, paths: [{ cells: [[61, -46], [61, -47]], boundAcceptor: "yes", itemsOnPath: 0 }], truncatedPaths: false };
        const r = checkSlots(PLAN, obs2, items2);
        ok(!r.ok, "L2 负例：cutter 没有上游带子 → 红（放进去了但线是死的）", r.reason);
        eq(r.evidence.unfed_inputs.length, 1, "L2 负例：unfed_inputs 记 1 台");
        eq(r.evidence.unfed_inputs[0].kind, "cutter", "L2 负例：挨饿的是 cutter");
    }

    // 负例：上游带子的**朝向反了**（格子还在，但出口朝外）
    {
        const flipped = { ...ENT.b44, rotation_variant: 2, code: 3 };   // rv=2 → exit right，不是 bottom
        const obs2 = mkObs([ENT.b42, ENT.b43, flipped, ENT.cutter, ENT.waste, ENT.b46, ENT.b47, ENT.out]);
        const items2 = mkItems({
            paths: [
                { cells: [[60, -42], [60, -43]], boundAcceptor: null, itemsOnPath: 0 },
                { cells: [[61, -46], [61, -47]], boundAcceptor: "yes", itemsOnPath: 0 },
            ],
        });
        const r = checkSlots(PLAN, obs2, items2);
        ok(!r.ok, "L2 负例：末格带子 rv 反了（entry/exit 掉头）→ cutter 无上游 → 红", r.reason);
    }

    // 负例：trash 悬空 —— **必须让它四边全空**。
    //   ⚠️ 这条用例第一版写错了：位于 (60,-46) 的 trash 正好在 cutter 左槽的喷口上，
    //   是**机对机直连**，本来就有上游。验证器报绿是对的，是断言错了。
    //   所以这里把 trash 挪到 (70,-60)，周围什么都没有。
    {
        const lone = { uid: 20099, type: "trash", x: 70, y: -60, r: 0, variant: "default", rotation_variant: 0, code: 20, layer: "regular" };
        const p = {
            placements: [{ uid: null, kind: "trash", variant: "default", x: 70, y: -60, rot: 0, rv: null, code: 20 }],
            removes: [], source: "t", flows: null,
        };
        const obs2 = mkObs([ENT.b42, ENT.b43, ENT.b44, ENT.cutter, ENT.waste, ENT.b46, ENT.b47, ENT.out, lone]);
        const r = checkSlots(p, obs2, mkItems());
        ok(!r.ok, "L2 负例：trash 悬空在 (70,-60)、四边全空 → 红", r.reason);
        eq(r.evidence.unfed_inputs.length, 1, "L2 负例：unfed_inputs 记 1 台");
        eq(r.evidence.unfed_inputs[0].kind, "trash", "L2 负例：挨饿的是 trash");
    }

    // 正例：机对机直连（cutter 左槽 → trash，中间没有带子）必须被认出来
    {
        const onlyWaste = {
            placements: [
                { uid: null, kind: "cutter", variant: "default", x: 60, y: -45, rot: 0, rv: null, code: 9 },
                { uid: null, kind: "trash", variant: "default", x: 60, y: -46, rot: 0, rv: null, code: 20 },
            ], removes: [], source: "t", flows: null,
        };
        const obs2 = mkObs([ENT.b42, ENT.b43, ENT.b44, ENT.cutter, ENT.waste, ENT.b46, ENT.b47, ENT.out]);
        const r = checkSlots(onlyWaste, obs2, mkItems());
        ok(r.ok, "L2 正例：trash 直接贴在 cutter 左槽喷口上（机对机）→ 绿", r.reason);
    }

    // 点名要求：require 一个不存在的槽 → 红
    {
        const r = checkSlots(PLAN, obs, items, { slots: { require: [{ uid: 20010, side: "in", role: "primary" }] } });
        ok(r.ok, "L2 点名：cutter 的 primary 输入有证据 → 绿（require 通过）", r.reason);
        const r2 = checkSlots(PLAN, obs, items, { slots: { require: [{ cell: [61, -48], side: "in", role: "primary" }] } });
        ok(!r2.ok, "L2 点名：点名一个断头 trash → 红", r2.reason);
    }

    // 正例：L2 用**世界的**朝向算槽位，不用计划里那个错朝向
    //   —— 计划说 cutter 是 r=90（错了，L1 会因此红），但世界里的 cutter 是 r=0 且接得好。
    //   L2 必须按 r=0 判，否则两个检查互相污染，报出一个不存在的机器的槽位问题。
    {
        const p = {
            placements: [
                { uid: null, kind: "cutter", variant: "default", x: 60, y: -45, rot: 90, rv: null, code: null },
                { uid: null, kind: "trash", variant: "default", x: 60, y: -46, rot: 0, rv: null, code: null },
            ], removes: [], source: "t", flows: null,
        };
        const r = checkSlots(p, mkObs(Object.values(ENT)), mkItems());
        ok(r.ok, "L2 用世界朝向：计划 rotation 错(90)但世界是 0 且接得好 → L2 绿（朝向错归 L1 管）", r.reason);
        eq(r.evidence.used_world_orientation, 2, "L2 用世界朝向：两台都从 obs 取了真实朝向");
    }

    // 截断：paths 被截断时必须 undecidable，不是绿
    {
        const r = checkSlots(PLAN, obs, mkItems({ pathCount: 44 }));
        ok(!r.ok && r.undecidable, "L2 截断：debug_items 只给 2/44 条 path → undecidable（不是绿）", r.reason);
    }

    // 纯带子计划：skipped（不适用），不算失败
    {
        const beltOnly = { placements: [{ uid: null, kind: "belt", variant: "default", x: 0, y: 0, rot: 0, rv: 0, code: 1 }], removes: [], source: "t", flows: null };
        const r = checkSlots(beltOnly, obs, items);
        ok(r.ok && r.skipped, "L2 纯带子：没有机器 → skipped（不适用，但不判红）", r.reason);
    }
}

/* ═════════════════════════ 3. L3 连通 ═════════════════════════ */

{
    const obs = mkObs(Object.values(ENT));
    const items = mkItems();

    // 正例：cutter → (61,-46)(61,-47) → trash(61,-48)
    const good = checkFlow(PLAN, obs, items, { flows: [{ from: 20010, to: 20012 }] });
    ok(good.ok, "L3 正例：cutter → 带链 → 下游 trash，游戏 path 能走到 → 绿", good.reason);
    eq(good.evidence.reached, 1, "L3 正例：reached=1");

    // 负例：到不了一个不相干的实体
    {
        const r = checkFlow(PLAN, obs, items, { flows: [{ from: 20010, to: 20011 }] });
        // cutter 右槽通到 20012，左槽（废料）通到 20011 —— 但左槽直连没有 path，
        // 游戏方也不给 boundAcceptor 坐标；这里按"沿 paths 走"的严格口径，应走不到。
        ok(!r.ok, "L3 负例：cutter → 落在没有 path 的左槽 trash → 红（游戏没给这条 path）", r.reason);
        eq(r.evidence.unreached.length, 1, "L3 负例：unreached 记 1 条");
    }

    // 负例：链路中间断一格（把 (61,-47) 删掉，path 只有 (61,-46)）
    {
        const obs2 = mkObs(Object.values(ENT).filter(e => e.uid !== 20005));
        const items2 = {
            pathCount: 2,
            paths: [
                { cells: [[60, -42], [60, -43], [60, -44]], boundAcceptor: "yes", itemsOnPath: 3 },
                { cells: [[61, -46]], boundAcceptor: null, itemsOnPath: 0 },
            ],
            truncatedPaths: false,
        };
        const r = checkFlow(PLAN, obs2, items2, { flows: [{ from: 20010, to: 20012 }] });
        ok(!r.ok, "L3 负例：链条断在 (61,-46) → 走不到 → 红", r.reason);
    }

    // 负例：端点不存在
    {
        const r = checkFlow(PLAN, obs, items, { flows: [{ from: 20010, to: 88888 }] });
        ok(!r.ok, "L3 负例：目的地 uid 不存在 → 红", r.reason);
    }

    // 无 flows：退化成「计划附近的断头路」
    {
        const itemsDead = mkItems({
            paths: [
                { cells: [[60, -42], [60, -43], [60, -44]], boundAcceptor: null, itemsOnPath: 3 },
                { cells: [[61, -46], [61, -47]], boundAcceptor: "yes", itemsOnPath: 0 },
            ],
        });
        const r = checkFlow(PLAN, obs, itemsDead, {});
        ok(!r.ok, "L3 无 flows：计划附近有断头路 → 红", r.reason);
        eq(r.evidence.dead_ends.length, 1, "L3 无 flows：dead_ends 记 1 段");
    }

    // 无 flows 且全是活路 → 绿
    {
        const r = checkFlow(PLAN, obs, items, {});
        ok(r.ok, "L3 无 flows：附近每段都有去处 → 绿", r.reason);
    }

    /* ── F10：无 flows 的绿必须自曝降级（否则 loop 会把「局部没新死端」读成「连通已验证」）──
       实测事故：一次 replace_run 改动落盘后 L3 绿，但同一存档里 bbox 外 3 格处就有
       一条零物品的死端带（正是 delivered:0 的真因）。判据没错，是**覆盖范围没说出来**。 */
    {
        const rGreen = checkFlow(PLAN, obs, items, {});
        ok(rGreen.degraded === true, "L3 无 flows：绿的时候必须带 degraded:true（降级必须自曝）");
        ok(!!rGreen.reason && rGreen.reason.includes("未给 flows"),
            "L3 无 flows：绿的 reason 必须写明「未给 flows」（不许用 null 让人以为是完整验证）", rGreen.reason);
        eq(rGreen.evidence.degraded, true, "L3 无 flows：evidence.degraded 也要有");

        const rRed = checkFlow(PLAN, obs, mkItems({
            pathCount: 1,
            paths: [{ cells: [[60, -43], [60, -44]], boundAcceptor: null, itemsOnPath: 3 }],
        }), {});
        ok(!rRed.ok && rRed.degraded === true, "L3 无 flows：红的时候同样要标 degraded（红的原因也是局部检测）", rRed.reason);

        // 给了 flows 就不是降级 —— 这时绿是完整的绿
        const rFull = checkFlow(PLAN, obs, items, { flows: [{ from: 20010, to: 20012 }] });
        if (rFull.ok) ok(rFull.degraded === undefined, "L3 给了 flows：不是降级，不该带 degraded 标记");
    }

    // 截断 → undecidable
    {
        const r = checkFlow(PLAN, obs, mkItems({ pathCount: 99 }), { flows: [{ from: 20010, to: 20012 }] });
        ok(!r.ok && r.undecidable, "L3 截断：paths 被截断 → undecidable（不是绿）", r.reason);
    }

    // 没有 paths 数组 → 不可判定
    {
        const r = checkFlow(PLAN, obs, { beltError: "boom" }, { flows: [{ from: 20010, to: 20012 }] });
        ok(!r.ok && r.undecidable, "L3 无 paths：debug_items 没给 paths → undecidable", r.reason);
    }
}

/* ═════════════════════════ 4. acceptorOf：boundAcceptor="yes" 的几何外推 ═════════════════════════ */

{
    eq(JSON.stringify(acceptorOf({ cells: [[61, -46], [61, -47]], boundAcceptor: "yes" })), JSON.stringify([61, -48]),
        "acceptorOf: 末格向上走 → 接收方是 (61,-48)");
    eq(JSON.stringify(acceptorOf({ cells: [[5, 5], [6, 5]], boundAcceptor: "yes" })), JSON.stringify([7, 5]),
        "acceptorOf: 末格向右走 → 接收方是 (7,5)");
    eq(JSON.stringify(acceptorOf({ cells: [[1, 1], [0, 1]], boundAcceptor: "yes" })), JSON.stringify([-1, 1]),
        "acceptorOf: 末格向左走 → 接收方是 (-1,1)");
    eq(acceptorOf({ cells: [[3, 3]], boundAcceptor: "yes" }), null, "acceptorOf: 单格 path 无法外推 → null");
    eq(acceptorOf({ cells: [[3, 3], [4, 3]], boundAcceptor: null }), null, "acceptorOf: 断头 path → null");
    eq(JSON.stringify(acceptorOf({ cells: [[1, 1], [2, 1]], boundAcceptor: [9, 9] })),
        JSON.stringify([9, 9]), "acceptorOf: 桥给了真坐标时以桥为准");
}

/* ═════════════════════════ 5. slotsOf：旋转后的世界槽位 ═════════════════════════ */

{
    const r0 = slotsOf("cutter", "default", 60, -45, 0);
    eq(JSON.stringify(r0.inputs[0].cell), JSON.stringify([60, -44]), "slotsOf r0: cutter 输入 approach=(60,-44)");
    eq(JSON.stringify(r0.outputs.find(o => o.role === "left").cell), JSON.stringify([60, -46]), "slotsOf r0: cutter 左槽 approach=(60,-46)");
    eq(JSON.stringify(r0.outputs.find(o => o.role === "right").cell), JSON.stringify([61, -46]), "slotsOf r0: cutter 右槽 approach=(61,-46)");

    // r=90：2×1 旋转成 1×2，槽位方向跟着转
    const r90 = slotsOf("cutter", "default", 0, 0, 90);
    eq(JSON.stringify(r90.inputs[0].slot), JSON.stringify([0, 0]), "slotsOf r90: 输入格仍在 origin");
    eq(r90.inputs[0].dir, "left", "slotsOf r90: 输入面从 bottom 转成 left");
    eq(JSON.stringify(r90.outputs.find(o => o.role === "right").slot), JSON.stringify([0, 1]), "slotsOf r90: 右半格转到 (0,1)");
}

/* ═════════════════════════ 6. verifyRuntime 端到端（注入 reader，不连游戏） ═════════════════════════ */

{
    const obs = mkObs(Object.values(ENT));
    const items = mkItems();

    const mkReader = (o, it, prodBefore, prodAfter, steps) => ({
        async obs() { return o; },
        async debugItems() { return it; },
        async production() { return steps.prodCalls++ === 0 ? prodBefore : prodAfter; },
        async step(t) { steps.ticks += t; return { ok: true, advanced: t }; },
    });

    // ① 全绿：计划与 ops 形态都吃
    {
        const steps = { prodCalls: 0, ticks: 0 };
        const r = await verifyRuntime(PLAN, { reader: mkReader(obs, items, { produced_total: {} }, { produced_total: {} }, steps) });
        ok(r.ok, "verify 正例：全绿", r.checks.filter(c => !c.ok).map(c => c.name + ":" + c.reason));
        eq(r.checks.length, 4, "verify 正例：L0/L1/L2/L3 四条");
    }

    // ② 负例：rotation 改错 → 整体红，且 L1 是红的
    {
        const p = clone(PLAN);
        p.placements[0].rot = 90;
        const steps = { prodCalls: 0, ticks: 0 };
        const r = await verifyRuntime(p, { reader: mkReader(obs, items, { produced_total: {} }, { produced_total: {} }, steps) });
        ok(!r.ok, "verify 负例：rotation 改错 → 整体红");
        const l1 = r.checks.find(c => c.name === "L1-landing");
        ok(l1 && !l1.ok, "verify 负例：红的正是 L1-landing");
    }

    // ③ 负例：说贴了但实际没有 → 整体红
    {
        const p = clone(PLAN);
        p.placements.push({ uid: null, kind: "miner", variant: "default", x: 70, y: -40, rot: 0, rv: 0, code: 7 });
        const steps = { prodCalls: 0, ticks: 0 };
        const r = await verifyRuntime(p, { reader: mkReader(obs, items, { produced_total: {} }, { produced_total: {} }, steps) });
        ok(!r.ok, "verify 负例：计划多一台不存在的机器 → 整体红");
    }

    // ④ obs 截断 → L0 undecidable，整体红，不再往下判（否则所有落地判据都是假数据）
    {
        const steps = { prodCalls: 0, ticks: 0 };
        const truncatedObs = mkObs(Object.values(ENT).slice(0, 3), { truncated: true, entity_count: 5000 });
        const r = await verifyRuntime(PLAN, { reader: mkReader(truncatedObs, items, { produced_total: {} }, { produced_total: {} }, steps) });
        ok(!r.ok, "verify 截断：obs 截断 → 整体红");
        ok(r.checks[0].undecidable, "verify 截断：L0 标 undecidable");
        eq(r.checks.length, 1, "verify 截断：obs 截断后不再往下判（只留 L0）");
    }

    // ⑤ 行为检查：目标形状真的出现 → 绿；一件没有 → 红
    {
        const steps = { prodCalls: 0, ticks: 0 };
        const reader1 = mkReader(obs, items,
            { produced_total: {} },
            { produced_total: { CuCuCuCu: 40 }, produced_per_sec: { CuCuCuCu: 0.4 }, window_seconds: 60 }, steps);
        const r1 = await verifyRuntime(PLAN, { reader: reader1, behavior: { shape: "CuCuCuCu", ticks: 2400 } });
        ok(r1.ok, "verify 行为正例：production 里目标形状出现 → 绿", r1.checks.map(c => c.name + ":" + c.reason));
        ok(steps.ticks === 2400, "verify 行为正例：真的推进了请求的 tick 数", steps.ticks);

        const steps2 = { prodCalls: 0, ticks: 0 };
        const reader2 = mkReader(obs, items,
            { produced_total: {} }, { produced_total: {}, produced_per_sec: {} }, steps2);
        const r2 = await verifyRuntime(PLAN, { reader: reader2, behavior: { shape: "CuCuCuCu", ticks: 2400 } });
        ok(!r2.ok, "verify 行为负例：跑完一件都没产出 → 红");
        const l4 = r2.checks.find(c => c.name === "L4-behavior");
        ok(l4 && !l4.ok, "verify 行为负例：红的正是 L4-behavior");
    }

    // ⑥ planId 找不到 → 结构化 error，不抛
    {
        const r = await verifyRuntime("no-such-plan-xyz", { reader: mkReader(obs, items, {}, {}, { prodCalls: 0, ticks: 0 }) });
        ok(!r.ok && r.error && r.error.code === "plan_not_found", "verify: planId 找不到 → 结构化 error", r.error);
    }

    // ⑦ 坏计划形态 → 结构化 error
    {
        const r = await verifyRuntime({ nonsense: true }, { reader: mkReader(obs, items, {}, {}, { prodCalls: 0, ticks: 0 }) });
        ok(!r.ok && r.error && r.error.code === "bad_plan", "verify: 认不出的计划 → 结构化 error", r.error);
    }

    // ⑧ obs 读失败 → 结构化 error，不抛
    {
        const reader = { async obs() { throw new Error("ECONNREFUSED"); }, async debugItems() { return items; }, async production() { return {}; }, async step() { return {}; } };
        const r = await verifyRuntime(PLAN, { reader });
        ok(!r.ok && r.error && r.error.code === "obs_failed", "verify: obs 读失败 → 结构化 error", r.error);
    }
}

/* ═════════════════════════ 汇总 ═════════════════════════ */
console.log(`\nverify_runtime 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
}
process.exit(fail ? 1 : 0);
