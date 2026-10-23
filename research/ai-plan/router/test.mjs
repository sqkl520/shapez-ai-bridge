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

for (const [name, report] of [["report-layout(M4)", layoutFixture], ["plan-l1", planFixture.layout]]) {
    const r = rt.routeAll(report);
    say(r.ok === true, `${name}: routeAll ok:true`, `${r.reason} / ${JSON.stringify(r.conflicts)}`);
    say(r.closure.ok === true, `${name}: 每通道双侧闭合全对（pairs=${r.closure.pairs}）`,
        JSON.stringify(r.closure.detail));
    // 逐通道独立重算（不信任 route 自己的汇总）
    const byCh = new Map();
    for (const b of r.beltCells) { if (!byCh.has(b.channelId)) byCh.set(b.channelId, []); byCh.get(b.channelId).push(b); }
    let badTotal = 0;
    for (const [, list] of byCh) badTotal += twoSidedClosure(list).length;
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
    // ⚠️ 语义声明（**可证伪版**，不是一句永绿的 say(true)）：
    //   以上是 rotateLocal 的**左逆自洽**（同一套表自己映回自己），红队 #1(1) 指出它不验语义。
    //   P4 若"越界声称验了语义"，唯一途径是把 P5 的语义机器（computeBelt/belt-sim）引进来 ——
    //   那就断在这里：route/lane 源码里出现任何语义求解器，本条立刻红，提示 P4 越了职责边界。
    //   语义判据归 P5 V3-belt-fixed-point（含机器邻居）与 P7 L2-paste-corner（plan §1.4 明写）。
    const rtSrc = fs.readFileSync(path.join(COMPILER, "route.mjs"), "utf8")
        + fs.readFileSync(path.join(COMPILER, "lane.mjs"), "utf8");
    say(!/computeBelt|belt-sim/.test(rtSrc),
        "语义边界锁：route/lane **不含** computeBelt/belt-sim（P4 只有自洽判据，无从声称语义）");
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
 * P4 复核：slot/outDir/inDir + cell 与模板在 rot 下的世界槽位**逐格一致** → 不一致就是 P3 的 bug。
 * 不在 placements 里的端点节点（既有世界的 hub）单独返回，由调用方断言它只能是 hub。
 */
function checkSlotsAgainstTemplates(report) {
    const problems = [], external = [];
    const byNode = new Map((report.placements || []).map(p => [p.nodeId, p]));
    for (const ch of report.channels) {
        for (const [ep, kind] of [[ch.from, "outputs"], [ch.to, "inputs"]]) {
            const pl = byNode.get(ep.nodeId);
            if (!pl) { external.push(ep.nodeId); continue; }
            const t = ot.ALL_TEMPLATES[pl.op];
            if (!t) { problems.push({ nodeId: ep.nodeId, why: `op ${pl.op} 无模板` }); continue; }
            const slots = ot.worldSlots(t, pl.rot)[kind];
            const dirKey = kind === "outputs" ? "outDir" : "inDir";
            const dir = ep[dirKey];
            const hit = slots.find(s => s.dir === dir &&
                pl.cell[0] + s.cell[0] === ep.cell[0] && pl.cell[1] + s.cell[1] === ep.cell[1]);
            if (!hit) {
                problems.push({ nodeId: ep.nodeId, dirKey, got: { cell: ep.cell, dir },
                    want: slots.map(s => ({ cell: [pl.cell[0] + s.cell[0], pl.cell[1] + s.cell[1]], dir: s.dir })) });
            }
        }
    }
    return { problems, external: [...new Set(external)] };
}
{
    const a = checkSlotsAgainstTemplates(layoutFixture);
    eq([a.problems, a.external], [[], []], "report-layout 的 channel 端点 = op-templates 世界槽位（逐格 + 方位）");
    const b = checkSlotsAgainstTemplates(planFixture.layout);
    eq(b.problems, [], "plan-l1 的 channel 端点 = op-templates 世界槽位（逐格 + 方位）");
    eq(b.external, ["hub"], "plan-l1 里唯一不在 placements 的端点节点 = hub（既有世界，P3 不重复作图）");
    // hub 端点用 hubEntriesWorld 复核：to.cell 必须在 16 个世界入口表里
    const hubEp = planFixture.layout.channels.map(c => c.to).filter(t => t.nodeId === "hub");
    const hubOrigin = [hubEp[0].cell[0], hubEp[0].cell[1] - 4];     // 底排入口 = (hx+i, hy+4)
    const he = ot.hubEntriesWorld(hubOrigin);
    say(hubEp.every(ep => he.some(e => e.cell[0] === ep.cell[0] && e.cell[1] === ep.cell[1])),
        `hub 端点格在 16 个世界入口表里（反推 hub 原点 ${hubOrigin.join(",")}）`);
}
{   // 端点对齐守卫：assertEndpoints 是 P4 的**内部不变量**（破了 = P4 自己有 bug，不是业务失败）
    const r = rt.routeAll(layoutFixture);
    const g = r.geoms.find(x => x.kind === "hlane");
    const list = r.beltCells.filter(b => b.channelId === g.id);
    say(rt.assertEndpoints(list, g, g.id).aligned === true, "正确产出 → assertEndpoints 放行");
    // 篡改首格的 inDir（模拟 P4 铺错）→ 必须抛结构化错，带字段路径
    throws(() => rt.assertEndpoints([{ ...list[0], inDir: "left" }, ...list.slice(1)], g, g.id),
        "首格 entry 与上游槽方位不符 → RouteError（字段路径点名）", "first.inDir");
    throws(() => rt.assertEndpoints([...list.slice(0, -1), { ...list[list.length - 1], outDir: "left" }], g, g.id),
        "末格 exit 与下游槽方位不符 → RouteError", "last.outDir");
    throws(() => rt.assertEndpoints([{ ...list[0], cell: { x: 99, y: 99 } }, ...list.slice(1)], g, g.id),
        "首格不在上游面外一格 → RouteError", "first.cell");
    // 链被拆断（相邻两格不共边）→ 抛
    const broken = [...list];
    broken[1] = { ...broken[1], cell: { x: broken[1].cell.x + 3, y: broken[1].cell.y } };
    throws(() => rt.assertEndpoints(broken, g, g.id), "相邻两格不共边 → RouteError（链不闭合）", "chain");
    // P3 写出与模板矛盾的槽方位 → checkSlotsAgainstTemplates 抓到（这条才是"上游 bug"的正解）
    const bad = JSON.parse(JSON.stringify(layoutFixture));
    bad.channels[0].from.outDir = "left";          // miner 出口恒 top（模板）
    say(checkSlotsAgainstTemplates(bad).problems.length === 1,
        "P3 写了模板里没有的槽方位 → 端点复核抓到 1 条（不靠 routeAll 猜）");
}
{
    // ★ M4 金样例逐字复现：facts/MILESTONE-M4-SUCCESS.md:13-20
    //   矿A@(137,100) 矿B@(147,100) stacker@(137,91)（左格与矿A 同列 → 分支A 零拐角）
    //   拐角落盘：(147,93) r=0  rv=1 code=2 ；(138,93) r=270 rv=2 code=3
    const m4 = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [137, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [137, 91], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [137, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [137, 91], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            { from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [138, 91], slot: "bottom", inDir: "bottom" },
              lane: 93, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [11, 10], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(m4);
    say(r.ok === true, "M4 实机坐标版：routeAll ok", `${r.reason} / ${JSON.stringify(r.conflicts)}`);
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
    eq([chA.length, chA[0].cell.x, chA[0].cell.y, chA[chA.length - 1].cell.y], [8, 137, 99, 92],
        "分支 A = 8 格 (137,99)→(137,92)");
    // 槽位对拍（P3 端点 vs op-templates 世界槽位）也必须是这份 M4 坐标
    eq(checkSlotsAgainstTemplates(m4).problems, [], "M4 实机坐标版端点 = op-templates 世界槽位");
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
            // 退化段：cutter 右格 (1,3) 出 top → first=(1,2)；trash (1,1) 入 bottom → last=(1,2) ⇒ 同格
            // （与 fixtures/plan-l1.json 的 n1→d1 通道同形，那条在金样例里就是一格 belt@1,3）
            { from: { nodeId: "ct", cell: [1, 3], slot: "top", outDir: "top" },
              to: { nodeId: "tr", cell: [1, 1], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCu----", id: "degenerate" },
        ],
        lanes: [], hubConnection: null, bbox: [2, 5], occupancy: [], conflicts: [], cornerCount: 0,
    };
    rep.placements.push({ nodeId: "tr", op: "trash", kind: "trash", cell: [1, 1], rot: 0, footprint: [1, 1] });
    const r = rt.routeAll(rep);
    say(r.ok === true, "含退化段的报告：ok（IR 不报 2001，plan §1.4）", `${r.reason} / ${JSON.stringify(r.conflicts)}`);
    const dg = r.beltCells.filter(b => b.channelId === "degenerate");
    eq(dg.length, 1, "退化段（first==last）在 IR 里**保留为一格**");
    eq(dg[0] && [dg[0].cell.x, dg[0].cell.y, dg[0].rot, dg[0].rv, dg[0].code, dg[0].inDir, dg[0].outDir],
        [1, 2, 0, 0, 1, "bottom", "top"], "退化格 = 直带 rv0 code1，进 bottom 出 top");
    const dr = r.beltCells.filter(b => b.channelId === "direct");
    eq(dr.length, 0, "direct（两机器贴面）= 0 格，不硬塞一格");
    eq(r.closure.pairs, 0, "0/1 格的通道没有相邻对 → 闭合 pairs=0");
}
{   // 180° 掉头 / 同向穿过：solveTurn 恒 null → 结构化上报，**不许硬凑**
    // 单格带子要 inDir===outDir 才无解；inDir=OPP[flowOut]，所以 goalOut===flowOut 的反面时成立。
    const g = { flowOut: "top", goalOut: "bottom",
        ch: { from: { nodeId: "a", cell: [0, 0] }, to: { nodeId: "b", cell: [0, 0] } } };
    const single = rt.layCells(g, [[9, 9]], "u1");
    eq([single.ok, single.reason], [false, "belt-turn-unsolvable"], "layCells：单格 180° 掉头 → belt-turn-unsolvable");
    eq(single.failingNode && single.failingNode.cell, [9, 9], "失败归因指到那一格（P8 分诊表用）");
    eq(single.conflict && single.conflict.kind, "no-turn", "conflict.kind = §2.3 的 no-turn（不是新枚举值）");
    // 直线穿过单格（flowOut=top, goalOut=top）反而**有解**（bottom→top），这是正常退化段
    eq(rt.layCells({ flowOut: "top", goalOut: "top",
        ch: { from: { nodeId: "a", cell: [0, 1] }, to: { nodeId: "b", cell: [0, 1] } } }, [[0, 0]], "ok1").ok,
        true, "对照：退化段 flowOut==goalOut 是直带，有解");
    // 真实会走到的无路形态：绕行走廊被墙彻底堵死 → 判死且 reason ∈ §2.5
    const wall = [];
    for (let x = -3; x <= 3; x++) if (x !== 0) wall.push({ nodeId: `w${x}`, op: "trash", kind: "trash", cell: [x, 1], rot: 0, footprint: [1, 1] });
    for (let x = -3; x <= 3; x++) if (x !== 0) wall.push({ nodeId: `W${x}`, op: "trash", kind: "trash", cell: [x, -1], rot: 0, footprint: [1, 1] });
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 2], rot: 0, footprint: [1, 1] },
            { nodeId: "tr", op: "trash", kind: "trash", cell: [0, 0], rot: 0, footprint: [1, 1] },
            ...wall,
        ],
        // miner 出 top → first (0,1) 那行被墙占；下游要 last (0,-1) 也被墙占 ⇒ 无可行车道
        channels: [
            { from: { nodeId: "mA", cell: [0, 2], slot: "top", outDir: "top" },
              to: { nodeId: "tr", cell: [0, 0], slot: "top", inDir: "top" },
              lane: null, payload: "CuCuCuCu", id: "sealed" },
        ],
        lanes: [], hubConnection: null, bbox: [7, 5], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const rr = rt.routeAll(rep, { searchRadius: 3 });
    say(rr.ok === false, "绕行走廊被墙堵死 → ok:false（判死，不产出堵死蓝图）", JSON.stringify(rr.conflicts));
    say(types.isFailureReason(rr.reason), `reason ∈ §2.5 枚举（实得 ${rr.reason}）`);
    eq(rr.beltCells.filter(b => b.channelId === "sealed").length, 0, "判死的通道一条带子都不产");
}

/* ══════════════════════ ⑤ 回归锁（陷阱 #1）+ left-edge ══════════════════════ */

console.log("\n── ⑤ 陷阱 #1 回归锁 + left-edge 车道分配 ──");

/** 陷阱 #1 的死循环形状：两条车道的水平段**同行反向**，且与竖直腿在同格对撞。
 *  M4 pitfalls:24-40 的具体形态（(135,90) 朝右喷进 (136,90)，而 (136,90) 的 rv=1 又左转喷回
 *  (135,90) → 同格双向 → 死循环/死端）。
 *  编译器侧的两条锁：
 *   L1 产出锁：任何一条格都**不可能**被两条通道的带子同时占据（同格对向自然也不可能）
 *   L2 判死锁：走廊只够一条车道时，第二条必须判死 + reason，绝不"挤进去"产出堵死的形状 */
/** 陷阱 #1/#5 的输入形态：两条分支的车道区间重叠且走廊只够一条行（⑤ 与 ⑦ 共用同一份 fixture） */
function trapOneRowCase() {
    const wall = [];
    for (let y = 91; y <= 99; y++) wall.push({ nodeId: `w${y}`, op: "trash", kind: "trash", cell: [137, y], rot: 0, footprint: [10, 1] });
    return {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [136, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [135, 89], rot: 0, footprint: [2, 1] },
            ...wall,
        ],
        channels: [
            { from: { nodeId: "mA", cell: [136, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [135, 89], slot: "bottom", inDir: "bottom" },
              lane: 90, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            // 手写布局犯的错：两条车道同一行（陷阱 #5）。除了 90 没有别行 → 必须判死
            { from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [136, 89], slot: "bottom", inDir: "bottom" },
              lane: 90, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [13, 12], occupancy: [], conflicts: [], cornerCount: 0,
    };
}
{
    const rep = trapOneRowCase();
    const a = ln.assignLanes(rep);
    say(a.ok === false, "两条分支抢同一行且无别的可行行（陷阱 #1/#5 形态）→ 车道分配判死",
        JSON.stringify(a.conflicts.map(c => c.kind)));
    say(a.reason === "dag-not-placeable:column-conflict-unresolved",
        `失败 reason 逐字 = §2.5 的 column-conflict-unresolved（实得 ${a.reason}）`);
    const r = rt.routeAll(rep);
    say(r.ok === false, "routeAll 对同一形状也判死（不产出会堵死的 IR）");
    say(r.reason === "dag-not-placeable:column-conflict-unresolved", `routeAll 的 reason（实得 ${r.reason}）`);
    say(r.beltCells.filter(b => b.channelId === "chB").length === 0,
        "判死的通道一条带子都不产（没有半成品 IR 流向下游）");
    // 反证：硬按 P3 给的同一行铺，交点 (136,90) 就被两股流同时占据 = M4 的死循环格子
    const gA = a.geoms.find(g => g.id === "chA"), gB = a.geoms.find(g => g.id === "chB");
    const cellsA = ln.geomCells(gA, 90) || [], cellsB = ln.geomCells(gB, 90) || [];
    const inter = cellsA.filter(c => cellsB.some(d => d[0] === c[0] && d[1] === c[1]));
    say(inter.length > 0, "构造性证据：硬塞同一行时两条车道的格集确实相交（P4 因此必须拒绝）",
        `交点 ${inter.length} 个`);
    say(inter.some(c => c[0] === 136 && c[1] === 90), "交点含 (136,90) —— M4 pitfalls 里同格双向的那个格子");
}
{   // 产出锁的**可达性**证明（变异锁 M-8 的靶心）：counter 分支不是死代码。
    // 触发形态 = P3 给出两条 channelId 相同的通道（ordinal 撞号）：车道阶段按 id 记账看不见重复
    // （两通道几何相同 → left-edge 的 id 键去重），但 route 阶段两股流会落在**同一批格**上 →
    // counterDirectedCells 命中 → 必须 ok:false + §2.5 枚举 reason + 归因非空。
    const dup = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [6, 0], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [6, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", ordinal: 0 },
            // 与上一条端点**完全相同**但 payload 不同（P3 的 ordinal 撞号 bug）→ id 相同
            { from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [6, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "RuRuCuCu", ordinal: 0 },
        ],
        lanes: [], hubConnection: null, bbox: [8, 11], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(dup);
    say(r.ok === false, "同 id 双通道 → 同格对向被产出锁判死（counter 分支可达，非死代码）",
        `ok=${r.ok}`);
    say(types.isFailureReason(r.reason), `判死 reason ∈ §2.5 枚举（实得 ${JSON.stringify(r.reason)}）`);
    say(r.failingNode !== null && r.failingNode !== undefined, `判死归因非空（实得 ${JSON.stringify(r.failingNode)}）`);
    // ok:false 时**不得**把入参里未解决的 null 冲突谎称已解决（与 ⑬-B 同一条铁律的两面）
    const d2 = JSON.parse(JSON.stringify(dup)); d2.conflicts = [{ kind: "cell-occupied", cells: [[9, 9]], nodeIds: ["z"], resolvedBy: null }];
    const r2 = rt.routeAll(d2);
    say(r2.ok === false && r2.report.conflicts[0].resolvedBy === null,
        "判死报告里 null 冲突保持 null（失败状态不盖「已解决」戳）");
}
{   // 回归锁的另一半：**检测器本身**有效（不是永远返回空）
    const m = new Map([["136,90", [
        { cell: { x: 136, y: 90 }, rot: 270, rv: 0, code: 1, inDir: "right", outDir: "left", channelId: "laneB" },
        { cell: { x: 136, y: 90 }, rot: 90, rv: 0, code: 1, inDir: "left", outDir: "right", channelId: "laneA" },
    ]]]);
    const bad = rt.counterDirectedCells(m);
    eq(bad.length, 1, "counterDirectedCells 抓到同格对向（检测器有判别力）");
    say(bad[0] && bad[0].opposed === true, "对向被单独标出（opposed:true）", JSON.stringify(bad));
    const m2 = new Map([["5,5", [
        { cell: { x: 5, y: 5 }, rot: 0, rv: 0, code: 1, inDir: "bottom", outDir: "top", channelId: "only" },
    ]]]);
    eq(rt.counterDirectedCells(m2), [], "单条流独占一格 → 不算冲突");
    // 产出锁：所有已测报告的每一条格都由唯一通道独占
    for (const [name, report] of [["report-layout", layoutFixture], ["plan-l1", planFixture.layout]]) {
        const r = rt.routeAll(report);
        const byCell = new Map();
        for (const b of r.beltCells) { const k = `${b.cell.x},${b.cell.y}`; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(b); }
        eq(rt.counterDirectedCells(byCell), [], `${name} 的产出：没有任何一格被两股流同时占据`);
    }
}
{   // 正常形态：两条分支的车道**区间重叠** → left-edge 必须开两条不同行（陷阱 #5）
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [3, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "st1", op: "stack", kind: "stacker", cell: [5, 0], rot: 0, footprint: [2, 1] },
            { nodeId: "st2", op: "stack", kind: "stacker", cell: [8, 0], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st1", cell: [5, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            // 区间 [3,8] 与 [0,5] 在 3..5 重叠 → 不能同一条行
            { from: { nodeId: "mB", cell: [3, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st2", cell: [8, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [10, 11], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(rep);
    say(r.ok === true, "两条分支的车道区间重叠 → left-edge 自动开第二行，全绿",
        JSON.stringify(r.conflicts));
    const rows = r.report.lanes.map(l => l.row);
    eq(rows.length, 2, "两条车道行（陷阱 #5：不同分支不同行）");
    say(new Set(rows).size === rows.length, `lanes[] 的 row 唯一（实得 ${JSON.stringify(rows)}）`);
    say(r.report.channels.every(c => Number.isInteger(c.lane)), "channels[].lane 全部填上（= 行号口径）");
    const byCh = {};
    for (const b of r.beltCells) (byCh[b.channelId] = byCh[b.channelId] || []).push(b);
    for (const id of ["chA", "chB"]) {
        const bad = twoSidedClosure(byCh[id] || []);
        eq(bad.length, 0, `${id}: 双侧闭合 0 破口（${(byCh[id] || []).length} 格）`);
    }
    // 每条拐角恰好 2 个（进道 + 出道），车道行贴着下游那一端（M4 的车道）
    for (const id of ["chA", "chB"]) eq(byCh[id].filter(b => b.rv !== 0).length, 2, `${id}: 两个拐角`);
    // 更新后的 LayoutReport 必须仍能过 P1 的 assertLayoutReport
    try { types.assertLayoutReport(r.report, "P4 输出报告"); say(true, "P4 的输出仍是合法 LayoutReport（types.assertLayoutReport 通过）"); }
    catch (e) { say(false, "P4 的输出仍是合法 LayoutReport", e.allMessages || e.message); }
}
{   // 区间不相交 → left-edge 复用同一行（色数最优，不无谓加宽）
    const rep = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [3, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "st1", op: "stack", kind: "stacker", cell: [1, 0], rot: 0, footprint: [2, 1] },
            { nodeId: "st2", op: "stack", kind: "stacker", cell: [7, 0], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st1", cell: [1, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", ordinal: 0, id: "chA" },
            { from: { nodeId: "mB", cell: [3, 10], slot: "top", outDir: "top" },
              to: { nodeId: "st2", cell: [7, 0], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "RuRuCuCu", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [9, 11], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(rep);
    say(r.ok === true, "区间不相交 → 复用一条车道行", JSON.stringify(r.conflicts));
    eq(r.report.lanes.length, 1, "只开 1 条行（left-edge 的色数最优）");
    eq(r.report.lanes[0].channelIds.sort(), ["chA", "chB"], "lanes[0].channelIds 两条都在（§2.3 的凭据字段）");
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
    // 轨道预算耗尽 = 独立语义（竞品把「无路」与「太难」压成一个 false 是反面教材）
    const capped = ln.leftEdge(
        [{ id: "a", lo: 0, hi: 1, candidates: [0] }, { id: "b", lo: 0, hi: 1, candidates: [0, 1, 2] }],
        { maxTracks: 1 });
    eq([capped.unresolved.length, capped.assign.has("b")], [1, false],
        "轨道预算耗尽 → unresolved + 不落 lane（可归因，绝不静默塞回同一条行）");
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

console.log("\n── ⑦ 失败永不 throw（plan §2.5：管线不许抛业务失败） ──");
{
    // 三种不可行分开上报（prior-art §6 的本项目红线），且**一律走返回值**不走 throw
    const cases = [];
    // a) lane-column 无解：两条分支抢唯一一条可行车道行（= ⑤ 的陷阱 #1 形态）
    cases.push(["车道行争用（lane-column）", trapOneRowCase()]);
    // b) cell-occupied：唯一通道的首格正落在既有世界的带上
    cases.push(["落点被既有世界占（cell-occupied）", {
        grid: "", rows: [],
        placements: [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 4], rot: 0, footprint: [1, 1] },
            { nodeId: "tr", op: "trash", kind: "trash", cell: [0, 0], rot: 0, footprint: [1, 1] }],
        channels: [{ from: { nodeId: "mA", cell: [0, 4], slot: "top", outDir: "top" },
            to: { nodeId: "tr", cell: [0, 0], slot: "bottom", inDir: "bottom" },
            lane: null, payload: "CuCuCuCu", id: "c1" }],
        lanes: [], hubConnection: null, bbox: [1, 5],
        occupancy: [{ cell: [0, 3], state: "replaceable", who: "world", kind: "belt" }],   // C1：绝不覆盖既有带
        conflicts: [], cornerCount: 0,
    }]);
    for (const [name, rep] of cases) {
        let threw = null, res = null;
        try { res = rt.routeAll(rep); } catch (e) { threw = e; }
        say(threw === null, `${name}：routeAll 不 throw（业务失败走返回值）`, threw && (threw.allMessages || threw.message));
        if (res) {
            say(res.ok === false, `${name}：ok:false`, JSON.stringify(res.conflicts));
            say(types.isFailureReason(res.reason), `${name}：reason ∈ §2.5（实得 ${res.reason}）`);
            say(res.failingNode !== null, `${name}：failingNode 有归因`, JSON.stringify(res.failingNode));
            // 车道分配没落上行的通道（cellsByChannel 里没有它）→ 一条带子都不产
            const placedIds = new Set([...res.lanes.cellsByChannel.keys()]);
            const produced = new Set(res.beltCells.map(b => b.channelId));
            const ghost = [...produced].filter(id => !placedIds.has(id));
            say(ghost.length === 0, `${name}：未落定的通道不产半成品带子`, JSON.stringify(ghost));
        }
    }
    // 三种 kind 各自独立，不许混为一谈（竞品 layout.go/router.py 的反面教材）
    const kinds = new Set();
    for (const [, rep] of cases) { const r = rt.routeAll(rep); for (const c of r.conflicts) if (c.resolvedBy === null) kinds.add(c.kind); }
    say(kinds.has("lane-column") && kinds.has("cell-occupied"),
        `不可行分类独立：实得 ${JSON.stringify([...kinds])}`);
    // c) 熔断预算用尽 = 独立语义（不是"无路"的 kind）
    const capped = rt.dijkstraOriented(
        { first: [0, 0], last: [9, 9], flowOut: "top", goalOut: "right",
            ch: { from: { nodeId: "a", cell: [0, 1] }, to: { nodeId: "b", cell: [9, 8] } } },
        () => true, { cap: 5 });
    eq([capped.ok, capped.reason], [false, "dag-not-placeable:crossing-needs-tunnel"],
        "pops 预算耗尽 → 独立 reason（可归因，不压成 false）");
    say(capped.detail && capped.detail.budget === 5, "熔断把预算写进 detail", JSON.stringify(capped.detail));
    // 而同一端点给足预算 → 找得到路（证明上一条是**预算**而非**无路**）
    const open = rt.dijkstraOriented(
        { first: [0, 0], last: [9, 9], flowOut: "top", goalOut: "right",
            ch: { from: { nodeId: "a", cell: [0, 1] }, to: { nodeId: "b", cell: [9, 8] } } },
        () => true, {});
    say(open.ok === true, "同一端点、预算充足 → Dijkstra 找到路（兜底通路有效）",
        JSON.stringify(open).slice(0, 200));
    // 带朝向搜索的产物必须自身闭合（拐角数 = 转向次数）
    if (open.ok) {
        const g = { id: "dj", flowOut: "top", goalOut: "right", first: [0, 0], last: [9, 9],
            ch: { from: { nodeId: "a", cell: [0, 1] }, to: { nodeId: "b", cell: [9, 8] } } };
        const laid = rt.layCells(g, open.cells, "dj");
        say(laid.ok === true, "Dijkstra 路径逐格 solveTurn 全有解", JSON.stringify(laid).slice(0, 200));
        eq(twoSidedClosure(laid.cells).length, 0, "Dijkstra 路径的双侧闭合 0 破口");
        const turns = laid.cells.filter(b => b.rv !== 0).length;
        say(turns > 0, `带朝向搜索按 TURN_COST 偏好少拐弯（${turns} 个拐角 / ${open.cells.length} 格）`);
    }
    // 入参不是 LayoutReport → 结构化抛错（**契约违反**，不是业务失败：调用方写错了类型）
    throws(() => rt.routeAll({ channels: "nope" }), "routeAll 入参类型错 → ContractViolation", "channels");
    throws(() => ln.assignLanes(null), "assignLanes(null) → ContractViolation", "channels");
    throws(() => ln.channelGeom({ from: { cell: [0, 0], slot: "up", outDir: "top" }, to: { cell: [0, 0], slot: "top", inDir: "top" } }, 0),
        "非法 slot → ContractViolation", "DirName");
    throws(() => ln.channelGeom({ from: { cell: [0.5, 0], slot: "top", outDir: "top" }, to: { cell: [0, 0], slot: "top", inDir: "top" } }, 0),
        "非整数 cell → ContractViolation", "[x,y]");
    throws(() => ln.step([0, 0], "up"), "step 非法方位 → ContractViolation", "top|right|bottom|left");
}

/* ══════════════════════ ⑧ 形态覆盖：elbow / hub 阻挡 / vlane ══════════════════════ */

console.log("\n── ⑧ 形态覆盖（elbow / hub 4×4 不可穿 / 竖直车道） ──");
const mkRep = (placements, channels, occupancy = []) => ({
    grid: "", rows: [], placements, channels, lanes: [], hubConnection: null,
    bbox: [10, 10], occupancy, conflicts: [], cornerCount: 0,
});
{   // ★ 首格几何只用 outDir，绝不退到 slot 面（变异锁 M-6：读法 A/B 混用会整体错一格）
    //   slot 与 outDir 一致时二者同值（分不开），故构造 **slot≠outDir** 的端点。
    //   P3 的 channels[] 里 from 同时带 slot 与 outDir；plan 读法 A：first = from.cell + DIRV[outDir]。
    //   注意：slot≠outDir 的端点过不了 op-templates 槽位对拍（那是 P3 的事），这里只钉 P4 的取值口径。
    const ch = { from: { nodeId: "a", cell: [0, 5], slot: "left", outDir: "top" },
        to: { nodeId: "b", cell: [0, 1], slot: "bottom", inDir: "bottom" } };
    const g = ln.channelGeom(ch, 0);
    eq(g.first, [0, 4], "channelGeom：first = from.cell + DIRV[outDir]（用 outDir，不是 slot 面 [-1,5]）");
    eq(g.entryDir, "bottom", "entryDir = OPP[outDir]（首格进货面朝着上游机器的出口面）");
    const ch2 = { from: { nodeId: "a", cell: [0, 5], slot: "top", outDir: "top" },
        to: { nodeId: "b", cell: [2, 1], slot: "top", inDir: "top" } };
    const g2 = ln.channelGeom(ch2, 0);
    eq(g2.last, [2, 0], "channelGeom：last = to.cell + DIRV[inDir]（用 inDir，不是 slot 面）");
}
{   // ★ 车道候选必须落在「前进半平面」band 内（变异锁 M-11：带子不能倒着走）
    //   flowOut=top ⇒ 竖直腿1 只能向上 ⇒ row ≤ rFrom；goalOut=top ⇒ 腿3 向上进机器 ⇒ row ≥ rTo。
    //   ⇒ band = [rTo, rFrom]。给一个**出界**的 P3 预分配 lane，必须被拒并 shift-x 到 band 内。
    const rep = mkRep(
        [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [5, 0], rot: 0, footprint: [2, 1] }],
        [{ from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
            to: { nodeId: "st", cell: [5, 0], slot: "bottom", inDir: "bottom" },
            lane: 20, payload: "CuCuSuSu", ordinal: 0, id: "band" }]);   // ← lane=20 在 band 之外
    const a = ln.assignLanes(rep);
    const g = a.geoms.find(x => x.id === "band");
    say(g.kind === "hlane" && g.band && g.band[0] <= g.band[1], `hlane band 有界（实得 ${JSON.stringify(g.band)}）`);
    // ★ band 的**字面口径**（承重，别只断言"有界"）：flowOut=top ⇒ 腿向上 ⇒ row≤rFrom；
    //   goalOut=top ⇒ 出道腿向上进机器 ⇒ row≥rTo。⇒ band = [rTo, rFrom] = [1, 9]。
    //   变异锁 M-11 把两侧半平面同时翻向（变成 row≥rFrom 且 row≤rTo = 带子倒流），
    //   只断言"有界"抓不到它，必须钉死具体值。
    eq(g.band, [1, 9], "band = [rTo, rFrom]（两腿都朝前：源腿向上 row≤9、宿腿向上 row≥1）");
    const got = a.laneRows.get("band");
    say(Number.isInteger(got) && got >= g.band[0] && got <= g.band[1],
        `出界的 P3 lane 被拒 → 重排进 band 内（实得 ${got} ∈ ${JSON.stringify(g.band)}）`);
    eq(g.resolvedBy, "shift-x", "出界 lane 的解法归因 = shift-x（不是原样采纳 pre-assigned）");
    // 反证：M-11 把 inBand 判据摘掉后，出界的 20 会被**原样采纳**（这里断言它没有被采纳）
    say(got !== 20, "绝不为迁就 P3 而把车道放到倒着走的位置（lane 20 未被采纳）");
    // 且无论选哪条 row，双腿方向都必须与流向一致（带子不倒流）：逐格 inDir/outDir 与几何吻合
    const r = rt.routeAll(rep);
    const bad = r.beltCells.filter(b => b.channelId === "band")
        .filter(b => b.inDir === b.outDir);
    eq(bad.length, 0, "车道通道内没有 inDir===outDir 的格（单格不可能 180° 掉头）");
}
{   // 单拐角（一进轴 ⊥ 一出轴）
    const rep = mkRep(
        [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 4], rot: 0, footprint: [1, 1] },
            { nodeId: "tr", op: "trash", kind: "trash", cell: [5, 2], rot: 0, footprint: [1, 1] }],
        [{ from: { nodeId: "mA", cell: [0, 4], slot: "top", outDir: "top" },
            to: { nodeId: "tr", cell: [5, 2], slot: "left", inDir: "left" },
            lane: null, payload: "----CuCu", id: "el" }]);
    const r = rt.routeAll(rep);
    say(r.ok === true, "elbow：单拐角通道全绿", JSON.stringify(r.conflicts));
    eq(r.geoms[0].kind, "elbow", "形态 = elbow（无需车道）");
    eq(r.cornerCount, 1, "只有一个拐角");
    say(r.closure.ok && r.beltTiles === 6, `elbow 的格数 6 / 双侧闭合（实得 ${r.beltTiles}）`);
    eq(r.report.lanes, [], "elbow 不占用车道 → lanes[] 空（契约里没有假数据）");
}
{   // hub 4×4 不可穿：车道想走的行被 hub 占了 → 要么绕、要么判死
    const rep = mkRep(
        [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [8, 10], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [4, 2], rot: 0, footprint: [2, 1] }],
        [{ from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
            to: { nodeId: "hub", cell: [2, 2], slot: "bottom", inDir: "bottom" },
            lane: null, payload: "----CuCu", id: "toHub" }],
        [{ cell: [2, 2], state: "solid", who: "hub", kind: "hub" }]);
    // hub 占地 4×4 显式塞进 occupancy（P3 若没把 hub 放进 placements，这里就是它的口径）
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++)
        if (!rep.occupancy.some(o => o.cell[0] === x && o.cell[1] === y)) rep.occupancy.push({ cell: [x, y], state: "solid", who: "hub", kind: "hub" });
    const r = rt.routeAll(rep);
    const inside = r.beltCells.filter(b => b.cell.x >= 2 && b.cell.x <= 5 && b.cell.y >= 2 && b.cell.y <= 5);
    eq(inside, [], "hub 4×4 内部没有我们的带子（不穿 hub）");
    say(r.closure.ok, "hub 通道（或判死后的其余通道）闭合仍全对", JSON.stringify(r.closure.detail).slice(0, 200));
}
{   // hub 4×4 **由 placements 供给**时的承重证明（变异锁 M-12 的靶心）：
    // P3 若把 hub 写成 footprint [2,2]（hub 实体只 1 格、占地 4×4 是 GEOMETRY 表1 的规则），
    // 「kind==="hub" ⇒ 4×4」这条规则就是**唯一**把 (2..5,2..5) 挡住的东西 ——
    // 摘掉它，通道会直接穿 hub 内部产出 4 个带子格（实机 = 在 hub 身上盖带子）。
    const hubOnly = {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [4, 8], rot: 0, footprint: [1, 1] },
            { nodeId: "hub", op: "hub", kind: "hub", cell: [2, 2], rot: 0, footprint: [2, 2] },   // ← 故意少报占地
            { nodeId: "tr", op: "trash", kind: "trash", cell: [4, 0], rot: 0, footprint: [1, 1] },
        ],
        // 竖直通道 col 4：必经 (4,7)→(4,1)，其中 (4,5)(4,4)(4,3)(4,2) 只被「hub 4×4」规则挡住
        channels: [{ from: { nodeId: "mA", cell: [4, 8], slot: "top", outDir: "top" },
            to: { nodeId: "tr", cell: [4, 0], slot: "bottom", inDir: "bottom" },
            lane: null, payload: "CuCuCuCu", id: "vHub" }],
        lanes: [], hubConnection: null, bbox: [6, 9],
        occupancy: [],   // ← 不给 occupancy：4×4 只能由 placements 推出来
        conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(hubOnly, { searchRadius: 4 });
    const inside = r.beltCells.filter(b => b.cell.x >= 2 && b.cell.x <= 5 && b.cell.y >= 2 && b.cell.y <= 5);
    say(inside.length === 0, `hub placements 只报 [2,2] 时 4×4 规则承重：内部零带子（实得穿入 ${inside.length} 格 / 共 ${r.beltCells.length} 格）`);
    // buildBlocked 直接对拍：kind==="hub" 的 16 格必须全在 blocked 里
    const bb = ln.buildBlocked(hubOnly.placements.length ? { placements: hubOnly.placements, channels: [] } : {}, {});
    const need = []; for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) need.push(`${x},${y}`);
    say(need.every(k => bb.blocked.has(k)), "buildBlocked：hub 4×4 的 16 格全部标记为不可布");
    // 口径说明：mark() 是**首写优先**，hub 自己的 [2,2] 占地先被记成 machine:hub，
    // 只有 4×4 规则**额外**扩出来的那 12 格才带 hub:4x4 —— 断言扩出来的格子必须归因 hub:4x4。
    const extra = need.filter(k => ![[2, 2], [2, 3], [3, 2], [3, 3]].some(c => `${c[0]},${c[1]}` === k));
    say(extra.every(k => (bb.why.get(k) || "").startsWith("hub:")),
        `4×4 规则额外扩出的 ${extra.length} 格归因 hub:4x4（不是误记别的占用者）`);
}
{   // 竖直车道：默认拒绝（契约 lanes[] 只有 row），显式打开则可用且闭合
    const rep = mkRep(
        [{ nodeId: "mA", op: "mine", kind: "miner", cell: [2, 2], rot: 0, footprint: [1, 1] },
            { nodeId: "tr", op: "trash", kind: "trash", cell: [6, 5], rot: 0, footprint: [1, 1] }],
        [{ from: { nodeId: "mA", cell: [2, 2], slot: "right", outDir: "right" },
            to: { nodeId: "tr", cell: [6, 5], slot: "left", inDir: "left" },
            lane: null, payload: "----CuCu", id: "vl" }]);
    const d = rt.routeAll(rep);
    eq([d.ok, d.geoms[0].kind, d.reason], [false, "vlane", "dag-not-placeable:column-conflict-unresolved"],
        "vlane 默认拒绝（v1 不开隧道、契约 lanes[] 只有 row → 让 P3 改用 hlane 形态）");
    const a = rt.routeAll(rep, { allowVerticalLane: true });
    say(a.ok === true, "opts.allowVerticalLane 打开 → 竖直车道可布", JSON.stringify(a.conflicts));
    eq(a.cornerCount, 2, "竖直车道 = 2 个拐角");
    say(a.closure.ok, "竖直车道双侧闭合全对");
    eq(a.report.lanes, [], "竖直车道**不进** lanes[]（row 字段表达不了列，见 NOTES C-3）");
}

/* ══════════════════════ ⑨ P6 的取用形状：beltCells → CompiledEntity ══════════════════════ */

console.log("\n── ⑨ 产出可被 P1 assertCompiledEntity 接受（P6 直接取用的形状） ──");
{
    for (const [name, report] of [["report-layout", layoutFixture], ["plan-l1", planFixture.layout], ["M4 实机坐标", m4Case()]]) {
        const r = rt.routeAll(report);
        const entities = r.beltCells.map(b => ({
            code: b.code, dx: b.cell.x, dy: b.cell.y, rot: b.rot,
            nodeId: `belt@${b.cell.x},${b.cell.y}`, instanceIdx: 0, kind: "belt",
            rotationVariant: b.rv, inDir: b.inDir, outDir: b.outDir,
        }));
        let bad = null;
        try { for (const e of entities) types.assertCompiledEntity(e, `entities[${e.nodeId}]`); }
        catch (e) { bad = (e.allMessages || e.message).slice(0, 200); }
        say(bad === null, `${name}: 每条 beltCell 都过 assertCompiledEntity（${entities.length} 格）`, bad || "");
        // P4 **不负责**产出顺序（那是 P6 的 orderEntities / 陷阱 #6 的分层顺序），
        // 但要交出可排序的凭据：phase 只能 ∈ {1,2}（没有机器），且 phase-2 的数量 === cornerCount。
        const phases = [...new Set(entities.map(e => types.entityOrderPhase(e)))].sort();
        say(phases.every(p => p === 1 || p === 2),
            `${name}: beltCell 的 entityOrderPhase 只 ∈ {1 直线, 2 拐角}（实得 ${JSON.stringify(phases)}）`);
        eq(entities.filter(e => types.entityOrderPhase(e) === 2).length, r.cornerCount,
            `${name}: phase-2 的数量 === cornerCount（P6 排序后 stats.corners 与 layout.cornerCount 自动一致）`);
        // beltCells 必须**按通道路径顺序连续排列**（P6/P7 重建链的凭据：同一通道的下标不成段 = 铺错）
        const spans = new Map(), counts = new Map();
        r.beltCells.forEach((b, i) => {
            if (!spans.has(b.channelId)) spans.set(b.channelId, [i, i]);
            else spans.get(b.channelId)[1] = i;
            counts.set(b.channelId, (counts.get(b.channelId) || 0) + 1);
        });
        const contiguous = [...spans.entries()].every(([id, [a, z]]) => z - a + 1 === counts.get(id));
        say(contiguous, `${name}: beltCells 按通道连续成段（无交错，chainClosure 可直接切片）`,
            JSON.stringify([...spans.entries()]));
        for (const id of spans.keys()) {
            const list = r.beltCells.filter(b => b.channelId === id);
            if (rt.chainClosure(list).ok !== true) say(false, `${name}/${id}: 切片后闭合破口`);
        }
    }
}
function m4Case() {
    return {
        grid: "", rows: [],
        placements: [
            { nodeId: "mA", op: "mine", kind: "miner", cell: [137, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "mB", op: "mine", kind: "miner", cell: [147, 100], rot: 0, footprint: [1, 1] },
            { nodeId: "st", op: "stack", kind: "stacker", cell: [137, 91], rot: 0, footprint: [2, 1] },
        ],
        channels: [
            { from: { nodeId: "mA", cell: [137, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [137, 91], slot: "bottom", inDir: "bottom" },
              lane: null, payload: "CuCuSuSu", slotRole: "lower", ordinal: 0, id: "chA" },
            { from: { nodeId: "mB", cell: [147, 100], slot: "top", outDir: "top" },
              to: { nodeId: "st", cell: [138, 91], slot: "bottom", inDir: "bottom" },
              lane: 93, payload: "RuRuCuCu", slotRole: "upper", ordinal: 1, id: "chB" },
        ],
        lanes: [], hubConnection: null, bbox: [11, 10], occupancy: [], conflicts: [], cornerCount: 0,
    };
}

/* ══════════════════════ ⑩ 与 P1 fixture 的 beltIntent 逐格对拍 ══════════════════════ */

console.log("\n── ⑩ plan-l1 的 5 条带子逐格对拍（P4 输出 vs 金样例 entities） ──");
{
    const r = rt.routeAll(planFixture.layout);
    const want = planFixture.entities.filter(e => e.kind === "belt")
        .map(e => [e.dx, e.dy, e.rot, e.rotationVariant, e.code, e.inDir, e.outDir]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const got = r.beltCells.map(b => [b.cell.x, b.cell.y, b.rot, b.rv, b.code, b.inDir, b.outDir])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    eq(got, want, "逐格 (x,y,rot,rv,code,inDir,outDir) 与金样例 entities 全等");
    eq(r.beltTiles, planFixture.stats.beltTiles, `beltTiles === stats.beltTiles (${planFixture.stats.beltTiles})`);
    eq(r.cornerCount, planFixture.stats.corners, "cornerCount === stats.corners");
    eq(r.cornerCostTiles, 0, "plan-l1 无拐角 → cornerCostTiles=0");
}

/* ══════════════════════ ⑪ 弯带代价上报 ══════════════════════ */

console.log("\n── ⑪ 弯带 0.78 有效格上报（P5 V7 的输入） ──");
{
    const r = rt.routeAll(layoutFixture);
    const corners = r.beltCells.filter(b => b.rv !== 0).length;
    eq([r.cornerCount, r.cornerCostTiles], [corners, Math.round(corners * 0.78 * 100) / 100],
        `report-layout: corners=${corners} → cornerCostTiles=${Math.round(corners * 0.78 * 100) / 100}`);
    say(rt.CORNER_COST_TILES === 0.78, "常量 CORNER_COST_TILES=0.78（belt.js:6 curvedBeltLength）");
    say(rt.CURVED_BELT_LENGTH === 0.78 && rt.STRAIGHT_BELT_LENGTH === 1.0,
        "直带 1.0 / 弯带 0.78 有效格（**弧长口径，不是容量折扣** —— prior-art §7）");
}

/* ══════════════════════ ⑫ 幂等 / 确定性 ══════════════════════ */

console.log("\n── ⑫ 确定性（同输入同输出，P5 变异测试与 P7 逐格 diff 的前提） ──");
{
    const a = JSON.stringify(rt.routeAll(layoutFixture).beltCells);
    const b = JSON.stringify(rt.routeAll(layoutFixture).beltCells);
    say(a === b, "routeAll 两次调用逐字节相同（无随机、无 Date）");
    const src = fs.readFileSync(path.join(COMPILER, "route.mjs"), "utf8")
        + fs.readFileSync(path.join(COMPILER, "lane.mjs"), "utf8");
    say(!/Math\.random|new Date|performance\.now/.test(src), "源码里没有 Math.random / new Date / performance.now");
    // ★ localeCompare 是**隐性**不确定性（grep 抓不到 random/Date 也照样换机器变结果）：
    //   ICU 权重表把 #/@/[ 等我们 channelIdOf 会生成的分隔符排在码点序之外，
    //   left-edge 扫描序的 id 平局因此**随 locale 漂移** → lanes[] 逐格 diff 崩。
    //   变异锁 M-3 证明：把 cmpId 换回 localeCompare，下面的 locale-invariant 断言立刻红。
    const laneSrc = fs.readFileSync(path.join(COMPILER, "lane.mjs"), "utf8");
    say(!/\.localeCompare\(/.test(laneSrc), "lane.mjs 排序**不用** localeCompare（用码点序 cmpId，跨机器稳定）");
    {   // 直接证「同 (lo,hi) 但 id 分隔符不同」的两条通道，分配只由码点序决定：
        // '#'(0x23) < '@'(0x40) 码点序；localeCompare 给相反结论 → 若代码用 localeCompare，
        // 谁先占 track0 就会翻。这里断言 leftEdge 在两端都能复现**同一** assign（不依赖运行 locale）。
        const mk = (id, lo, hi) => ({ id, lo, hi, src: 0, dst: 9, candidates: [0, 1, 2] });
        const ivs = [mk("mA->st#0", 0, 4), mk("mA->st@0", 0, 4)];
        const res = ln.leftEdge(ivs, {});
        const got = [...res.assign.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
        // 码点序 '#'<'@' ⇒ mA->st#0 先扫到 ⇒ 占 track 0
        eq(got, [["mA->st#0", 0], ["mA->st@0", 1]], "left-edge id 平局按码点序（#0 抢在 @0 前）——跨 locale 确定");
    }
    const frozen = JSON.parse(JSON.stringify(layoutFixture));
    rt.routeAll(layoutFixture);
    eq(layoutFixture, frozen, "routeAll 不修改入参（返回新报告）");
}

{   // ★ 拐角凭据三处必须**同一个数**（变异锁 M-7 / M-17）：
    //   lanes.cornerCells（车道阶段申报的转向格）=== beltCells 里 rv≠0 的格集合
    //   === layoutReport.cornerCount === routeAll().cornerCount。
    //   cornerCount 恒 0 会让 P6 的 stats.corners 与 P5 的 V7 折算同时空转；
    //   geomCorners 少报一个拐角会让 cornerCells 与真实 rv≠0 格分家（P6 排序凭据错位）。
    const cases = [["report-layout", layoutFixture], ["plan-l1", planFixture.layout], ["M4 实机坐标", m4Case()], ["双分支重叠区间", (() => {
        return mkRep(
            [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 10], rot: 0, footprint: [1, 1] },
                { nodeId: "mB", op: "mine", kind: "miner", cell: [3, 10], rot: 0, footprint: [1, 1] },
                { nodeId: "st1", op: "stack", kind: "stacker", cell: [5, 0], rot: 0, footprint: [2, 1] },
                { nodeId: "st2", op: "stack", kind: "stacker", cell: [8, 0], rot: 0, footprint: [2, 1] }],
            [{ from: { nodeId: "mA", cell: [0, 10], slot: "top", outDir: "top" },
                to: { nodeId: "st1", cell: [5, 0], slot: "bottom", inDir: "bottom" }, lane: null, payload: "CuCuSuSu", ordinal: 0, id: "chA" },
                { from: { nodeId: "mB", cell: [3, 10], slot: "top", outDir: "top" },
                    to: { nodeId: "st2", cell: [8, 0], slot: "bottom", inDir: "bottom" }, lane: null, payload: "RuRuCuCu", ordinal: 1, id: "chB" }]);
    })()]];
    for (const [name, rep] of cases) {
        const r = rt.routeAll(rep);
        const real = r.beltCells.filter(b => b.rv !== 0).map(b => `${b.cell.x},${b.cell.y}`).sort();
        const declared = r.lanes.cornerCells.map(c => `${c.cell[0]},${c.cell[1]}`).sort();
        eq(declared, real, `${name}: cornerCells 申报的转向格 === 真实 rv≠0 的格（无吞角/多报）`);
        eq(r.report.cornerCount, real.length, `${name}: 输出报告 cornerCount = rv≠0 格数（P6 的 stats.corners 凭据）`);
        eq(r.cornerCount, r.report.cornerCount, `${name}: routeAll.cornerCount 与 report.cornerCount 同值`);
        eq(r.cornerCostTiles, Math.round(real.length * 0.78 * 100) / 100, `${name}: cornerCostTiles 跟着真实拐角数走`);
    }
}

/* ══════════════════════ ⑬ 报告更新契约（执行包明列的第 6 条验收） ══════════════════════ *//*
 * routeAll 产出**更新后的 LayoutReport**，三条硬契约（承 plan §2.3 / 执行包「内容」节）：
 *   ⑬-A lanes 填上：每条占用车道行的通道 → channels[].lane = 行号，且 lanes[] 里有一行
 *                   row===该 lane、channelIds 含该通道 id。
 *   ⑬-B resolvedBy 保留：P3 已写的 resolvedBy 字符串**原样不动**（那是 P3 的决策说明）；
 *                   本次车道分配**只**把入参里 kind==="lane-column" 且 resolvedBy===null 的
 *                   条目盖成 left-edge-new-row，**其它 kind 的 null 不盖**（承 P7 belt-silent-overwrite
 *                   教训：报告不能声称做了它没做的事 → 变异锁 M-5 证明 blanket 盖章是错的）。
 *   ⑬-C channels↔lane 互逆：`channels[i].lane !== null` ⟺ 该通道占了一条车道行（在 lanes[] 里）；
 *                   未落车道的通道（direct/single/straight/elbow/search）即便 P3 留了陈旧 lane 数字
 *                   也必须回写 null（变异锁 M-4 证明「保留陈旧值」会产出自相矛盾的报告）。
 */
console.log("\n── ⑬ 报告更新契约（lanes 填上 / resolvedBy 保留 / channels↔lane 互逆） ──");
{
    /* ── ⑬-A lanes 填上（正向）── */
    const r = rt.routeAll(layoutFixture);
    const chLane = r.report.channels.map(c => c.lane);
    say(chLane.some(l => Number.isInteger(l)), `⑬-A report-layout：有通道的 lane 落成行号（实得 ${JSON.stringify(chLane)}）`);
    const laneRows = new Map(r.report.lanes.map(l => [l.row, l.channelIds]));
    let aOK = true;
    r.geoms.forEach((g, i) => {
        const lane = r.report.channels[i].lane;
        if (lane === null) return;                 // 非车道形态：不要求
        const ids = laneRows.get(lane);
        if (!ids || !ids.includes(g.id)) aOK = false;   // lane 值必须在 lanes[] 里有对应行且含此 id
    });
    say(aOK, "⑬-A 每个非空 channels[].lane 都能在 lanes[] 找到 row===lane 且 channelIds 含该通道 id");
    // lanes[] 的 row 唯一（陷阱 #5 的契约面，types.assertLayoutReport 也锁，这里独立复算）
    const rowsArr = r.report.lanes.map(l => l.row);
    say(new Set(rowsArr).size === rowsArr.length, `⑬-A lanes[].row 唯一（实得 ${JSON.stringify(rowsArr)}）`);
    // 更新后的报告仍是合法 LayoutReport
    try { types.assertLayoutReport(r.report, "⑬ 输出报告"); say(true, "⑬ 输出仍过 types.assertLayoutReport"); }
    catch (e) { say(false, "⑬ 输出仍过 types.assertLayoutReport", e.allMessages || e.message); }

    /* ── ⑬-C channels↔lane 互逆（反方向：有 lanes 行 ⇒ 对应通道 lane!==null） ── */
    const idToIdx = new Map(r.geoms.map((g, i) => [g.id, i]));
    let cOK = true;
    for (const l of r.report.lanes) {
        for (const id of l.channelIds) {
            const idx = idToIdx.get(id);
            if (idx === undefined || r.report.channels[idx].lane !== l.row) cOK = false;
        }
    }
    say(cOK, "⑬-C lanes[] 每个 channelIds 反查其 channels[].lane 恰等于该行号（双向互逆成立）");
}
{
    /* ── ⑬-C 陈旧 lane 必须被清空（变异锁 M-4 的正例） ── */
    // straight 通道（不占车道）但 P3 留了 lane:7 → 输出必须回 null，否则「channels 说有行 7 /
    // lanes[] 里没有行 7」的自相矛盾报告会喂错 P5 的 V4/V6 与 P6 的排序凭据。
    const rep = {
        grid: "", rows: [],
        placements: [{ nodeId: "mA", op: "mine", kind: "miner", cell: [0, 4], rot: 0, footprint: [1, 1] },
            { nodeId: "ct", op: "cut", kind: "cutter", cell: [0, 1], rot: 0, footprint: [1, 1] }],
        channels: [{ from: { nodeId: "mA", cell: [0, 4], slot: "top", outDir: "top" },
            to: { nodeId: "ct", cell: [0, 1], slot: "bottom", inDir: "bottom" },
            lane: 7, payload: "CuCuCuCu", ordinal: 0 }],          // ← 陈旧 lane 数字
        lanes: [], hubConnection: null, bbox: [1, 5], occupancy: [], conflicts: [], cornerCount: 0,
    };
    const r = rt.routeAll(rep);
    eq(r.geoms[0].kind, "straight", "⑬-C 构造：这是 straight（本就不该占车道）");
    eq(r.report.channels[0].lane, null, "⑬-C 未落车道的通道，陈旧 lane:7 被回写 null（互逆不被陈旧值破坏）");
    eq(r.report.lanes, [], "⑬-C lanes[] 保持空（straight 不产车道）");
    // 全局互逆不变式（对任何产出都必须成立）
    const rows = new Set(r.report.lanes.map(l => l.row));
    const inv = r.report.channels.every(c => (c.lane !== null) === rows.has(c.lane));
    say(inv, "⑬-C 互逆不变式：channels[].lane!==null ⟺ row 在 lanes[] 里存在");
}
{
    /* ── ⑬-B resolvedBy 保留（正向：P3 写的字符串原样不动） ── */
    const f = JSON.parse(JSON.stringify(layoutFixture));
    // fixture 的 conflicts[0].resolvedBy 是 P3 的说明串；routeAll 必须保留它
    const r = rt.routeAll(f);
    say(r.report.conflicts.length >= 1, "⑬-B 入参 conflicts 透传到输出（至少 1 条）");
    eq(r.report.conflicts[0].resolvedBy, f.conflicts[0].resolvedBy,
        "⑬-B P3 写的 resolvedBy 字符串**原样保留**（不覆盖别人的决策说明）");
    // 其它字段透传：placements/rows/grid/hubConnection/bbox/occupancy 必须与入参等值
    for (const k of ["grid", "rows", "placements", "hubConnection", "bbox", "occupancy"]) {
        eq(r.report[k], layoutFixture[k], `⑬-B 透传字段 ${k} 与入参等值（routeAll 只改 channels/lanes/conflicts/cornerCount）`);
    }
}
{
    /* ── ⑬-B 只盖 lane-column 的 null；其它 kind 的 null 不盖（变异锁 M-5 的正例） ── */
    const f = JSON.parse(JSON.stringify(layoutFixture));
    f.conflicts = [
        { kind: "cell-occupied", cells: [[3, 3]], nodeIds: ["x"], resolvedBy: null },   // 不该被盖
        { kind: "lane-column", cells: [[0, 3]], nodeIds: ["a", "b"], resolvedBy: null },  // 该被盖
        { kind: "no-turn", cells: [[1, 1]], nodeIds: ["y"], resolvedBy: "P3 自述" },      // 保留字符串
    ];
    const r = rt.routeAll(f);
    const out = r.report.conflicts.slice(0, 3).map(c => [c.kind, c.resolvedBy]);
    eq(out[0], ["cell-occupied", null], "⑬-B cell-occupied 的 null **不**被盖成 left-edge（那是谎报归因）");
    say(out[1][0] === "lane-column" && typeof out[1][1] === "string",
        `⑬-B 只有 lane-column 的 null 被盖解法（实得 ${JSON.stringify(out[1])}）`);
    eq(out[2], ["no-turn", "P3 自述"], "⑬-B P3 写了字符串的条目原样保留");
    // 判死场景：lane.ok=false 时**不**盖章（失败不该声称解决了任何东西）
    const dead = rt.routeAll(trapOneRowCase());
    say(dead.ok === false, "⑬-B（反例）陷阱 #1 形态判死");
    say(dead.report.conflicts.every(c => !(c.kind === "lane-column" && typeof c.resolvedBy === "string" && c.resolvedBy === "left-edge-new-row" && c.cells.length && c.cells[0][0] === 999)),
        "⑬-B 判死时不把未落定的 lane-column 冲突谎称已解决（本例 P3 未给 lane-column 输入，核对不产出假戳）");
}

console.log(`\n${fails ? `✗ P4 router L0：${fails} 条失败（通过 ${passes}）` : `✓ P4 router L0：全部通过（${passes} 条断言）`}`);
process.exitCode = fails ? 1 : 0;
