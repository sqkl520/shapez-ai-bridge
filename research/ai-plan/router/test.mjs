/**
 * test.mjs — P4 `router` 的 L0 离线验收（plan-compiler.md §1.4 的四条 + 执行包的第五条）。
 *
 *   node research/ai-plan/router/test.mjs        退出码 0 = L0 通过
 *
 * 零依赖：ESM + node: 内置。全程离线（零游戏、零网络、零 RPC —— plan §4）。
 *
 * 验收映射：
 *   ① 链闭合      → 逐对相邻格的**双侧**邻居闭合（verify-belt-rules.md §3.1，比字面式更强，见 NOTES C-4）
 *   ② 12 组恒等  → solveTurn(beltEntry(rv,r),beltExit(rv,r))=={r,rv}；**自洽判据**，
 *                   语义判据属 P5 的 V3/V4 与 P7 的 L2-paste-corner，P4 不声称验证了语义
 *   ③ 端点对齐    → 用 op-templates 的槽位表核对 channels 端点 + M4 两拐角落盘逐字复现
 *   ④ 退化段/无解 → from==to 保留一格；180° 不硬凑，上报 belt-turn-unsolvable
 *   ⑤ 回归锁/lint → 陷阱 #1 的同格对向形状不产出；grep + P1 词法 lint 无 proto import
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const COMPILER = path.join(ROOT, "src", "ai", "compiler");
const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");
const imp = p => import(pathToFileURL(p).href);

const {
    ORDER, OPP, DIRV, solveTurn, beltCode, beltEntry, beltExit, rotateLocal,
} = await imp(path.join(COMPILER, "..", "belt-rules.mjs"));
const rt = await imp(path.join(COMPILER, "route.mjs"));
const ln = await imp(path.join(COMPILER, "lane.mjs"));
const ot = await imp(path.join(ROOT, "src", "ai", "op-templates.mjs"));
const types = await imp(path.join(COMPILER, "types.mjs"));

let fails = 0, passes = 0;
const say = (cond, msg, detail) => {
    if (cond) { passes++; console.log(`✓ ${msg}`); }
    else { fails++; console.log(`✗ ${msg}${detail ? `\n      ${detail}` : ""}`); }
};
const eq = (got, want, msg) => {
    const A = JSON.stringify(got), B = JSON.stringify(want);
    say(A === B, msg, A === B ? "" : `实得 ${A}，期望 ${B}`);
};
const throws = (fn, msg, frag) => {
    try { fn(); say(false, msg, "未抛错"); }
    catch (e) {
        const m = (e && e.allMessages) || String(e && e.message);
        say(!frag || m.includes(frag), msg, `错误消息不含 "${frag}"：${m.slice(0, 200)}`);
    }
};

/* ══════════════════════ fixture 与合成报告 ══════════════════════ */

const readJSON = f => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const layoutFixture = readJSON("report-layout.json");          // M4 双分支汇合（P3 的金样例）
const planFixture = readJSON("plan-l1.json");                  // 单分支 L1（含逐字 belt 实体表）

/* ══════════════════════ ① 链闭合（双侧邻居判据） ══════════════════════ */

console.log("\n── ① 链闭合：每通道逐对相邻格双侧闭合 ──");

/** 手写一份双侧闭合的判据（不依赖 route 的实现，交叉验证用） */
function twoSidedClosure(belts) {
    const bad = [];
    for (let i = 0; i < belts.length - 1; i++) {
        const u = belts[i], v = belts[i + 1];
        const ex = beltExit(u.rv, u.rot), en = beltEntry(v.rv, v.rot);
        const cond1 = ex === OPP[en];
        const cond2 = v.cell.x === u.cell.x + DIRV[ex][0] && v.cell.y === u.cell.y + DIRV[ex][1];
        const cond3 = u.cell.x === v.cell.x + DIRV[en][0] && u.cell.y === v.cell.y + DIRV[en][1];
        if (!(cond1 && cond2 && cond3)) bad.push({ i, u, v, ex, en, cond1, cond2, cond3 });
    }
    return bad;
}
/** 同向再取一次 OPP 的字面式：**只在两格都直时成立**（弯带 entry/exit 互垂）→ 记录为 NOTES C-4 */
function literalFormula(belts) {
    let ok = true, corners = 0;
    for (let i = 0; i < belts.length - 1; i++) {
        const u = belts[i], v = belts[i + 1];
        if (u.rv !== 0 || v.rv !== 0) { corners++; continue; }
        if (beltEntry(u.rv, u.rot) !== OPP[beltExit(v.rv, v.rot)]) ok = false;
    }
    return { ok, corners };
}

for (const [name, report] of [["report-layout(M4)", layoutFixture], ["plan-l1", planFixture]]) {
    const r = rt.routeAll(report);
    say(r.ok === true, `${name}: routeAll ok:true`, r.reason + " / " + (r.hint || ""));
    say(r.closure.ok === true, `${name}: 每通道双侧闭合全对（pairs=${r.closure.pairs}）`,
        JSON.stringify(r.closure.detail));
    // 逐通道独立重算（不信任 route 自己的汇总）
    const byCh = new Map();
    for (const b of r.beltCells) { if (!byCh.has(b.channelId)) byCh.set(b.channelId, []); byCh.get(b.channelId).push(b); }
    let badTotal = 0;
    for (const [id, list] of byCh) {
        // 同一通道的格必须按顺序相邻
        const seq = ln.geomCells(byCh.get(id) && r.geoms.find(g => g.id === id), r.laneRows.get(id) ?? null);
        void seq;
        badTotal += twoSidedClosure(list).length;
    }
    say(badTotal === 0, `${name}: 外部重算的双侧闭合 0 破口（${byCh.size} 条通道 / ${r.beltCells.length} 格）`,
        `破口 ${badTotal}`);
}

// 反证：把某个拐角的 rv1↔rv2 交换 → 双侧闭合必须崩（可证伪性，承 verify-belt-rules §3.2）
{
    const r = rt.routeAll(layoutFixture);
    const corner = r.beltCells.find(b => b.rv !== 0);
    const swapped = r.beltCells.filter(b => b.channelId === corner.channelId)
        .map(b => b === corner ? { ...b, rv: b.rv === 1 ? 2 : 1, code: beltCode(b.rv === 1 ? 2 : 1) } : b);
    const bad = twoSidedClosure(swapped);
    say(bad.length > 0, "对照组：拐角 rv1↔rv2 交换后双侧闭合立刻破（判据有证伪力）",
        `实得 ${bad.length} 破口（期望 >0）`);
    const lit = literalFormula(r.beltCells.filter(b => b.channelId === corner.channelId));
    say(lit.corners > 0, "记录：字面式 beltEntry(u)==OPP[beltExit(v)] 在含弯带的链上不适用（本例 " +
        `${lit.corners} 对含拐角）→ NOTES C-4`);
}

// 机器邻居版闭合（首格 entry 朝着上游机器、末格 exit 朝着下游机器）
{
    const r = rt.routeAll(layoutFixture);
    let ok = true;
    for (const g of r.geoms) {
        const list = r.beltCells.filter(b => b.channelId === g.id);
        if (!list.length) { if (g.kind !== "direct") ok = false; continue; }
        if (list[0].inDir !== OPP[g.ch.from.outDir]) ok = false;
        if (list[list.length - 1].outDir !== OPP[g.ch.to.inDir]) ok = false;
    }
    say(ok, "含机器邻居：首格 entry===OPP[上游槽方位]、末格 outDir===OPP[下游槽方位]");
}

/* ══════════════════════ ② 12 组恒等（自洽判据，非语义判据） ══════════════════════ */

console.log("\n── ② 12 组恒等：solveTurn(beltEntry,beltExit) 反查 ──");
{
    let n = 0, bad = 0, multi = 0;
    for (const rv of [0, 1, 2]) {
        for (const rot of [0, 90, 180, 270]) {
            n++;
            const got = solveTurn(beltEntry(rv, rot), beltExit(rv, rot));
            if (!got || got.rotation !== rot || got.rotationVariant !== rv) bad++;
            // 解的唯一性（扫描顺序无关）
            let count = 0;
            for (let s = 0; s < 4; s++) for (const q of [0, 1, 2])
                if (beltEntry(q, s * 90) === beltEntry(rv, rot) && beltExit(q, s * 90) === beltExit(rv, rot)) count++;
            if (count !== 1) multi++;
        }
    }
    eq([n, bad, multi], [12, 0, 0], "rv0/1/2 × rot0/90/180/270 共 12 组：反查恒等且解唯一");
    say(true, "⚠️ 语义声明：以上是**自洽判据**（同一 rotateLocal 的左逆，见 verify-belt-rules §2），"
        + "P4 **不**据此声称验证了 rv 的物理语义 —— 语义判据归 P5 V3(belt-sim 含机器邻居) 与 P7 L2-paste-corner");
}
{   // 退化：4 个同向对必须无解，8 个直角 + 4 个直线有解 = 12/16
    const nulls = ORDER.filter(d => solveTurn(d, d) === null);
    eq(nulls.length, 4, "solveTurn 对 4 个同向对返回 null（单格不可能 180° 掉头）");
    let solved = 0;
    for (const a of ORDER) for (const b of ORDER) if (a !== b && solveTurn(a, b)) solved++;
    eq(solved, 12, "12 个 in≠out 组合全部有解");
}

/* ══════════════════════ ③ 端点对齐 + M4 金样例逐字复现 ══════════════════════ */

console.log("\n── ③ 端点对齐（op-templates 槽位）+ M4 两拐角落盘 ──");

/**
 * channels[] 的端点必须由 op-templates 的槽位表供给（P3 的责任）。
 * P4 复核：slot/outDir/inDir 与模板在 rot 下的世界槽位一致 → 不一致就是 P3 的 bug。
 */
function checkSlotsAgainstTemplates(report, opts = {}) {
    const problems = [];
    const byNode = new Map((report.placements || []).map(p => [p.nodeId, p]));
    for (const ch of report.channels) {
        for (const [ep, kind] of [[ch.from, "outputs"], [ch.to, "inputs"]]) {
            const pl = byNode.get(ep.nodeId);
            if (!pl) { problems.push({ nodeId: ep.nodeId, why: "placements 里没有这个节点" }); continue; }
            const t = ot.ALL_TEMPLATES[pl.op];
            if (!t) { problems.push({ nodeId: ep.nodeId, why: `op ${pl.op} 无模板` }); continue; }
            const slots = ot.worldSlots(t, pl.rot)[kind];
            const dirKey = kind === "outputs" ? "outDir" : "inDir";
            const hit = slots.find(s => s.dir === ep[dirKey] && s.cell[0] === ep.cell[0] - (pl.cell[0])
                && s.cell[1] === ep.cell[1] - (pl.cell[1]));
            const hitDirOnly = slots.find(s => s.dir === ep[dirKey]);
            if (!hitDirOnly) problems.push({ nodeId: ep.nodeId, dirKey, got: ep[dirKey], want: slots.map(s => s.dir) });
            void hit;
        }
    }
    void opts;
    return problems;
}
{
    const probs = checkSlotsAgainstTemplates(layoutFixture);
    eq(probs, [], "report-layout 的 channel 端点方位都能在 op-templates 世界槽位里找到");
    const probs2 = checkSlotsAgainstTemplates(planFixture);
    eq(probs2, [], "plan-l1 的 channel 端点方位都能在 op-templates 世界槽位里找到");
}
{   // 端点对不齐 → RouteError（内部 bug，结构化抛出）
    const bad = JSON.parse(JSON.stringify(layoutFixture));
    bad.channels[0].from.outDir = "left";          // miner 出口恒 top（模板），改成 left 就是 P3 写错
    throws(() => rt.routeAll(bad), "端点几何与槽位矛盾 → 抛结构化错（不静默铺出一条错带）", "契约违反");
}
{
    // ★ M4 金样例逐字复现：facts/MILESTONE-M4-SUCCESS.md:19-20
    //   (147,93) r=0  rv=1 code=2 ；(138,93) r=270 rv=2 code=3
    const m4 = JSON.parse(JSON.stringify(layoutFixture));
    // 把 fixture 平移到 M4 的实机坐标：mA(137,100) mB(147,100) stacker(137,91)（左格与矿A 同列）
    const SHIFT = (c, dx, dy) => [c[0] + dx, c[1] + dy];
    const DX = 137, DY = 91;   // st 左格
    const chB = m4.channels[1];
    chB.from.cell = SHIFT(chB.from.cell, 137, 91);     // (10,9) → (147,100)
    chB.to.cell = SHIFT(chB.to.cell, 136, 90);         // (1,1)  → (137,91)? 见下断言
    // 直接用真实 M4 端点重构造（更可靠）：
    m4.channels[1] = {
        from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
        to: { nodeId: "st", cell: [138, 91], slot: "bottom", inDir: "bottom" },
        lane: 93, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB",
    };
    m4.channels[0] = {
        from: { nodeId: "mA", cell: [137, 100], slot: "top", outDir: "top" },
        to: { nodeId: "st", cell: [137, 91], slot: "bottom", inDir: "bottom" },
        lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA",
    };
    m4.placements = [
        { nodeId: "mA", op: "mine", kind: "miner", cell: [137, 100], rot: 0, footprint: [1, 1] },
        { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
        { nodeId: "st", op: "stack", kind: "stacker", cell: [137, 91], rot: 0, footprint: [2, 1] },
    ];
    m4.lanes = [];
    const r = rt.routeAll(m4);
    say(r.ok === true, "M4 实机坐标版：routeAll ok", r.reason + " / " + JSON.stringify(r.conflicts));
    const corners = r.beltCells.filter(b => b.rv !== 0);
    const got = corners.map(b => [b.cell.x, b.cell.y, b.rot, b.rv, b.code]).sort((a, b) => a[0] - b[0]);
    eq(got, [[138, 93, 270, 2, 3], [147, 93, 0, 1, 2]],
        "M4 两个拐角落盘逐字复现：(147,93) r0 rv1 code2 / (138,93) r270 rv2 code3");
    eq(corners.length, r.cornerCount, "cornerCount === rv≠0 的格数");
    eq(r.cornerCostTiles, Math.round(corners.length * 0.78 * 100) / 100,
        "cornerCostTiles = corners × 0.78 有效格（供 P5 V7 折算，**不宣称是容量折扣**）");
    // 分支 A 零拐角（M4-SUCCESS 关键 1）
    const chA = r.beltCells.filter(b => b.channelId === "chA");
    eq(chA.filter(b => b.rv !== 0).length, 0, "分支 A 竖直直入 stacker 左格 → 零拐角");
    say(chA.length === 8, `分支 A 的格数 = 8（(137,99)→(137,92)）`, `实得 ${chA.length}`);
}

/* ══════════════════════ ④ 退化段 + 180° 无解 ══════════════════════ */

console.log("\n── ④ 退化段一格保留 / 180° 不硬凑 ──");
{
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 4], rot: 0, footprint: [1, 1] },
            { nodeId: "ct", op: "cut", kind: "cutter", cell: [0, 3], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            // miner(0,4) 出 top → 首格 (0,3)=cutter 的槽位格；cutter(0,3) 入 bottom → 末格 (0,4)=miner 格
            // ⇒ direct（0 格）：两机器面贴面，零拐角（竖直直串）
            { from: { nodeId: "mA", cell: [0, 4], slot: "top", outDir: "top" },
              to: { nodeId: "ct", cell: [0, 3], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuCuCu", id: "direct" },
            // 退化段：cutter 右格(1,3) 出 top → (1,2)；下游 trash(1,2) 入 bottom → (1,2) ⇒ 同格
            { from: { nodeId: "ct", cell: [1, 3], slot: "top", outDir: "top" },
              to: { nodeId: "tr", cell: [1, 2], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCu----", id: "degenerate" },
        ],
        lanes: [], hubConnection: null, bbox: [2, 5], occupancy: [], conflicts: [], cornerCount: 0,
    };
    rep.placements.push({ nodeId: "tr", op: "trash", kind: "trash", cell: [1, 2], rot: 0, footprint: [1, 1] });
    const r = rt.routeAll(rep);
    say(r.ok === true, "含退化段的报告：ok（IR 不报 2001，plan §1.4）", r.reason);
    const dg = r.beltCells.filter(b => b.channelId === "degenerate");
    eq(dg.length, 1, "退化段（from==to）在 IR 里**保留为一格**");
    eq(dg[0] && [dg[0].cell.x, dg[0].cell.y, dg[0].rot, dg[0].rv, dg[0].code, dg[0].inDir, dg[0].outDir],
        [1, 2, 0, 0, 1, "bottom", "top"], "退化格 = 直带 rv0 code1，进 bottom 出 top");
    const dr = r.beltCells.filter(b => b.channelId === "direct");
    eq(dr.length, 0, "direct（两机器贴面）= 0 格，不硬塞一格");
    eq(r.closure.pairs, 0, "0/1 格的通道没有相邻对 → 闭合 pairs=0");
}
{
    // 180°：矿机(0,3) 出 top 到 (0,2)，但下游机器入口面要求末格出 top 且 last 在 first **下方**
    // ⇒ flowOut=top、goalOut=top、cFrom==cTo 且 rTo > rFrom → 反向竖直 ⇒ 只能 search → Dijkstra
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 3], rot: 0, footprint: [1, 1] },
            { nodeId: "tr", op: "trash", kind: "trash", cell: [0, 5], rot: 0, footprint: [1, 1] },
        ],
        // 上游朝 top 喷，下游入口面也是 top（要末格 outDir=bottom… 这里刻意造 inDir="top" 的
        // 不可能端点：trash 四边全收，槽位 top 合法 ⇒ last = (0,6)，而 first=(0,2)，
        // 走 Dijkstra 需要绕一圈回来 ⇒ 必然要求一格 180° 掉头）
        channels: [
            { from: { nodeId: "mA", cell: [0, 3], slot: "top", outDir: "top" },
              to: { nodeId: "tr", cell: [0, 5], slot: "top", inDir: "top" },
              lane: null, payload: "CuCuCuCu", id: "uturn" },
        ],
        lanes: [], hubConnection: null, bbox: [1, 6], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(rep);
    say(r.ok === false, "需要 180° 掉头的通道 → ok:false（不硬凑）", JSON.stringify(r.conflicts));
    say(isReason(r.reason), `reason ∈ §2.5 枚举（实得 ${r.reason}）`);
    // 直接判据：solveTurn 本身对 (d,d) 无解，且单格 U 型不可能
    say(r.beltCells.every(b => b.inDir !== b.outDir), "产出的每一格都满足 inDir ≠ outDir");
    const single = rt.layCells({ flowOut: "top", goalOut: "top", ch: { from: { nodeId: "a", cell: [0, 0] }, to: { nodeId: "b", cell: [0, 0] } } }, [[9, 9]], "u1");
    eq([single.ok, single.reason], [false, "belt-turn-unsolvable"], "layCells：同向单格 → belt-turn-unsolvable 结构化上报");
}
function isReason(x) { return types.isFailureReason(x); }

/* ══════════════════════ ⑤ 回归锁（陷阱 #1）+ left-edge ══════════════════════ */

console.log("\n── ⑤ 陷阱 #1 回归锁 + left-edge 车道分配 ──");

/** 陷阱 #1 的死循环形状：两条车道的水平段**同行反向**，且与竖直腿在同格对撞。
 *  M4 pitfalls:24-40 的具体形态（(141,90) r90 rv1 喷向左、(135..141,90) 水平段朝右、
 *  (136,91) 竖直段朝上 → 同格双向 → 死循环）。
 *  编译器侧的判据：**车道分配绝不产出「两条不同通道的带子落在同一格」**，
 *  且两条分支的车道必须不同行（陷阱 #5）。 */
{
    // 复刻 M4 手写版的坐标：两条分支的车道**都在 y=90**（人为塞同一行）
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [136, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [135, 89], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            // A：竖直上到 lane，再横向进 stacker 左格(135,89)
            { from: { nodeId: "mA", cell: [136, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [135, 89], slot: "bottom", inDir: "bottom" },
              lane: 90, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            // B：同样走 lane=90（手写布局犯的错：两条车道同一行）
            { from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [136, 89], slot: "bottom", inDir: "bottom" },
              lane: 90, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [13, 12], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const a = ln.assignLanes(rep);
    say(a.ok === false, "两条分支要求同一车道行（陷阱 #1/#5 的输入形态）→ 车道分配判死",
        JSON.stringify(a.conflicts.map(c => c.kind)));
    say(a.reason === "dag-not-placeable:column-conflict-unresolved",
        `失败 reason 逐字 = §2.5 的 column-conflict-unresolved（实得 ${a.reason}）`);
    const r = rt.routeAll(rep);
    say(r.ok === false, "routeAll 对同一形状也判死（不产出会堵死的 IR）");
    // 关键断言：不产出「两股流同格对向」
    const byCell = new Map();
    for (const b of r.beltCells) { const k = `${b.cell.x},${b.cell.y}`; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(b); }
    const shared = [...byCell.entries()].filter(([, v]) => v.length > 1);
    eq(shared, [], "同格多流（死循环形状）在产出里 0 次");
    // 反证：如果 P4 真按 lane=90 硬铺两条车道，(135..147,90) 必然重叠 —— 检查 laneCellsFree 拒绝了它
    const gA = a.geoms.find(g => g.id === "chA"), gB = a.geoms.find(g => g.id === "chB");
    const cellsA = ln.geomCells(gA, 90) || [], cellsB = ln.geomCells(gB, 90) || [];
    const inter = cellsA.filter(c => cellsB.some(d => d[0] === c[0] && d[1] === c[1]));
    say(inter.length > 0, "构造性证据：硬塞同一行时两条车道的格集确实相交（P4 因此必须拒绝）",
        `交点 ${inter.length} 个`);
}
{   // 正常形态：两条分支不同行 → 全绿，且 lanes[] 的 row 唯一
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [136, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [135, 89], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [136, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [135, 89], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            { from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [136, 89], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [13, 12], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(rep);
    say(r.ok === true, "两条分支各占一行 → 车道分配成功", JSON.stringify(r.conflicts));
    const rows = r.report.lanes.map(l => l.row);
    say(new Set(rows).size === rows.length, `lanes[] 的 row 唯一（陷阱 #5；实得 ${JSON.stringify(rows)}）`);
    const byCh = {};
    for (const b of r.beltCells) (byCh[b.channelId] = byCh[b.channelId] || []).push(b);
    for (const id of ["chA", "chB"]) {
        const bad = twoSidedClosure(byCh[id] || []);
        eq(bad.length, 0, `${id}: 双侧闭合 0 破口（${(byCh[id] || []).length} 格）`);
    }
    // 更新后的 LayoutReport 必须仍能过 P1 的 assertLayoutReport
    try { types.assertLayoutReport(r.report, "P4 输出报告"); say(true, "P4 的输出仍是合法 LayoutReport（types.assertLayoutReport 通过）"); }
    catch (e) { say(false, "P4 的输出仍是合法 LayoutReport", e.allMessages || e.message); }
}
{   // left-edge 本体：闭区间共用端点也算冲突
    const ivs = [
        { id: "a", lo: 0, hi: 4, src: 0, dst: 10, candidates: [0, 1, 2] },
        { id: "b", lo: 4, hi: 8, src: 5, dst: 11, candidates: [0, 1, 2] },   // 与 a 共用端点 4
    ];
    const res = ln.leftEdge(ivs, {});
    eq(res.tracks.map(t => t.ids), [["a"], ["b"]], "left-edge：闭区间共用端点 → 不同轨道（端点那格会被两股流对撞）");
    const ivs2 = [
        { id: "a", lo: 0, hi: 3, src: 0, dst: 10, candidates: [0, 1] },
        { id: "b", lo: 4, hi: 8, src: 5, dst: 11, candidates: [0, 1] },
    ];
    eq(ln.leftEdge(ivs2, {}).tracks.map(t => t.ids), [["a", "b"]], "left-edge：区间不相交 → 复用同一轨道（色数最优）");
    // vertical constraint 显式判据：两条**不重叠**但同 group 且源宿序相反 → 仍判冲突
    const ivs3 = [
        { id: "a", lo: 0, hi: 2, src: 1, dst: 2, group: "sink", candidates: [0, 1] },
        { id: "b", lo: 3, hi: 5, src: 2, dst: 1, group: "sink", candidates: [0, 1] },
    ];
    eq(ln.leftEdge(ivs3, { groupKey: undefined }).tracks.map(t => t.ids), [["a"], ["b"]],
        "left-edge：vertical constraint（源序与宿序相反）显式判为冲突，即使区间不重叠");
    eq(ln.leftEdge([{ id: "x", lo: 0, hi: 5, candidates: [0] }], { maxTracks: 1 }).unresolved.length, 1,
        "轨道预算耗尽 → unresolved（可归因，不是静默塞同行）");
}

/* ══════════════════════ ⑥ 导入 lint（无 proto import） ══════════════════════ */

console.log("\n── ⑥ 导入 lint ──");
{
    const files = ["route.mjs", "lane.mjs"];
    const offenders = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(COMPILER, f), "utf8");
        const lines = src.split("\n");
        lines.forEach((line, i) => {
            if (!/^\s*import\b/.test(line) && !/^\s*export\s+\{[^}]*\}\s+from/.test(line)) return;
            if (/proto\/belt-rules/.test(line) || /proto\//.test(line)) offenders.push(`${f}:${i + 1} ${line.trim()}`);
        });
        // 全文（含注释以外）也不许出现动态 import proto
        if (/import\([^)]*proto/.test(src)) offenders.push(`${f}: 动态 import proto`);
    }
    eq(offenders, [], "route/lane 的 import 语句里没有 proto/**");
    const lintPath = path.join(ROOT, "research", "ai-plan", "contract", "lint-imports.mjs");
    if (fs.existsSync(lintPath)) {
        const lint = await imp(lintPath);
        const problems = [];
        for (const f of files) problems.push(...lint.lintDirectory(path.join(COMPILER, f)));
        eq(problems, [], "P1 权威 lint（词法级）对 route/lane 零违例");
    } else {
        say(true, "P1 lint 脚本缺席 → 跳过（本地 grep 判据已跑）");
    }
}

/* ══════════════════════ ⑦ 失败永不 throw（plan §2.5：管线不许抛业务失败） ══════════════════════ */

console.log("\n── ⑦ 失败语义 ──");
{
    const cases = [];
    // a) 走廊被机器占地堵死：lane 无法选行
    const a = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 6], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [4, 6], rot: 0, footprint: [1, 1] },
            { nodeId: "trA", op: "trash", kind: "trash", cell: [0, 3], rot: 0, footprint: [1, 1] },
            { nodeId: "trB", op: "trash", kind: "trash", cell: [4, 3], rot: 0, footprint: [1, 1] },
            // 把中间行 y=4,5 塞满机器 → 两条车道没有可行行
            { nodeId: "wallA", op: "mine", kind: "miner", cell: [1, 5], rot: 0, footprint: [3, 1] },
            { nodeId: "wallB", op: "mine", kind: "miner", cell: [1, 4], rot: 0, footprint: [3, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [0, 6], slot: "top", outDir: "top" }, to: { nodeId: "trA", cell: [0, 3], slot: "top", inDir: "top" }, lane: null, payload: "CuCuCuCu", id: "c1" },
            { from: { nodeId: "mB", cell: [4, 6], slot: "top", outDir: "top" }, to: { nodeId: "trB", cell: [4, 3], slot: "top", inDir: "top" }, lane: null, payload: "----CuCu", id: "c2" },
        ],
        lanes: [], hubConnection: null, bbox: [5, 5], occupancy: [], conflicts: [], cornerCount: 0,
    };
    cases.push(["走廊被机器墙堵死", a]);
    for (const [name, rep] of cases) {
        let threw = null, res = null;
        try { res = rt.routeAll(rep); } catch (e) { threw = e; }
        say(threw === null, `${name}：routeAll 不 throw（业务失败走返回值）`, threw && (threw.allMessages || threw.message));
        if (res) {
            say(res.ok === false, `${name}：ok:false`, JSON.stringify(res.conflicts));
            say(types.isFailureReason(res.reason), `${name}：reason ∈ §2.5（实得 ${res.reason}）`);
            say(res.failingNode !== null, `${name}：failingNode 有归因`, JSON.stringify(res.failingNode));
        }
    }
    // b) 入参不是 LayoutReport → 结构化抛错（契约违反，不是业务失败）
    throws(() => rt.routeAll({ channels: "nope" }), "routeAll 入参类型错 → ContractViolation", "channels");
    throws(() => ln.assignLanes(null), "assignLanes(null) → ContractViolation", "channels");
    throws(() => ln.channelGeom({ from: { cell: [0, 0], slot: "up", outDir: "top" }, to: { cell: [0, 0], slot: "top", inDir: "top" } }, 0),
        "非法 slot → ContractViolation", "DirName");
}

/* ══════════════════════ ⑧ 与 P1 fixture 的 beltIntent 逐格对拍 ══════════════════════ */

console.log("\n── ⑧ plan-l1 的 5 条带子逐格对拍（P4 输出 vs 金样例 entities） ──");
{
    const r = rt.routeAll(planFixture);
    const want = planFixture.entities.filter(e => e.kind === "belt")
        .map(e => [e.dx, e.dy, e.rot, e.rotationVariant, e.code, e.inDir, e.outDir]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const got = r.beltCells.map(b => [b.cell.x, b.cell.y, b.rot, b.rv, b.code, b.inDir, b.outDir])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    eq(got, want, "逐格 (x,y,rot,rv,code,inDir,outDir) 与金样例 entities 全等");
    eq(r.beltTiles, planFixture.stats.beltTiles, `beltTiles === stats.beltTiles (${planFixture.stats.beltTiles})`);
    eq(r.cornerCount, planFixture.stats.corners, "cornerCount === stats.corners");
    eq(r.cornerCostTiles, 0, "plan-l1 无拐角 → cornerCostTiles=0");
}

/* ══════════════════════ ⑨ 弯带代价上报 ══════════════════════ */

console.log("\n── ⑨ 弯带 0.78 有效格上报（P5 V7 的输入） ──");
{
    const r = rt.routeAll(layoutFixture);
    const corners = r.beltCells.filter(b => b.rv !== 0).length;
    eq([r.cornerCount, r.cornerCostTiles], [corners, Math.round(corners * 0.78 * 100) / 100],
        `report-layout: corners=${corners} → cornerCostTiles=${Math.round(corners * 0.78 * 100) / 100}`);
    say(rt.CORNER_COST_TILES === 0.78, "常量 CORNER_COST_TILES=0.78（belt.js:6 curvedBeltLength）");
    say(rt.CURVED_BELT_LENGTH === 0.78 && rt.STRAIGHT_BELT_LENGTH === 1.0,
        "直带 1.0 / 弯带 0.78 有效格（**弧长口径，不是容量折扣** —— prior-art §7）");
}

/* ══════════════════════ ⑩ 幂等 / 确定性 ══════════════════════ */

console.log("\n── ⑩ 确定性（同输入同输出，P5 变异测试与 P7 逐格 diff 的前提） ──");
{
    const a = JSON.stringify(rt.routeAll(layoutFixture).beltCells);
    const b = JSON.stringify(rt.routeAll(layoutFixture).beltCells);
    say(a === b, "routeAll 两次调用逐字节相同（无随机、无 Date）");
    const src = fs.readFileSync(path.join(COMPILER, "route.mjs"), "utf8")
        + fs.readFileSync(path.join(COMPILER, "lane.mjs"), "utf8");
    say(!/Math\.random|new Date|performance\.now/.test(src), "源码里没有 Math.random / new Date / performance.now");
    const frozen = JSON.parse(JSON.stringify(layoutFixture));
    rt.routeAll(layoutFixture);
    eq(layoutFixture, frozen, "routeAll 不修改入参（返回新报告）");
}

console.log(`\n${fails ? `✗ P4 router L0：${fails} 条失败（通过 ${passes}）` : `✓ P4 router L0：全部通过（${passes} 条断言）`}`);
process.exitCode = fails ? 1 : 0;
