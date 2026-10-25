/**
 * build-line.mjs — 建一条**完整**的产线：矿机 → 工序 → hub，每段都通到底。
 *
 * 这一版基于一个刚查清的事实（`debug_items` 诊断出来的）：
 *
 *   每条 belt path 的 `boundAcceptor` 为 null ⇒ 那段带子的末端**没有去处**，货会堆死。
 *   实测现象：切割机的两个 ejector 都 `progress:1`（想弹出但没接收方），
 *   而带子上一个物品都没有 —— 我一开始以为是"没产出"，其实是"产了但出不去"。
 *
 * 所以本脚本的硬规则：**每一段路的末端必须是 hub 入口或 trash**。
 * 建之前先用同一个判据检查，不合格就不建（而不是建一半再说）。
 *
 * 几何（全部源码核证）：
 *   miner  出口 local top，1×1
 *   cutter 入口 local(0,0) bottom，出口 local(0,0)+local(1,0) 都朝 top，2×1
 *   trash  四边全收，1×1，恒 r=0
 *   hub    底部入口 y=hub.y+4（带子朝上）；右侧入口 x=hub.x+4（带子朝左）
 *
 * 用法：node src/agent/build-line.mjs [--execute]
 */
import { requiredOps } from "./assess.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rid = 1;
async function rpc(method, params = {}, timeout = 180000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
        signal: AbortSignal.timeout(timeout),
    });
    const b = await res.json();
    if (b.error) { const e = new Error(`${method}: ${b.error.message}`); e.code = b.error.code; throw e; }
    return b.result;
}

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const rotOf = d => ({ top: 0, right: 90, bottom: 180, left: 270 })[d];
const rand = (l, r) => ORDER[(ORDER.indexOf(l) + Math.round(r / 90)) % 4];
const solve = (i, o) => {
    for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
        if (rand("bottom", r) === i && rand(EXIT_LOCAL[rv], r) === o) return { rot: r, rv };
    }
    return null;
};
const k = (x, y) => `${x},${y}`;

const EXEC = process.argv.slice(2).includes("--execute");

/* ───────────── 观测 ───────────── */
async function observe() {
    const o = await rpc("obs", {
        max_entities: 5000, include_hub: true, include_resources: true,
        max_resources: 20000, region: [-60, -60, 60, 60],
    });
    return {
        hub: (o.entities || []).find(e => e.type === "hub"),
        ents: (o.entities || []).map(e => ({ type: e.type, x: e.x, y: e.y, r: e.r })),
        ore: (o.resources || []).map(([x, y, kind]) => ({ x, y, kind })),
        goal: o.goal.requirement.shape, stored: o.hub.stored_shapes || {},
    };
}

function hubEntries(hub) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        out.push({ cell: [hub.x + i, hub.y - 1], face: "top", dir: "bottom" });
        out.push({ cell: [hub.x + i, hub.y + 4], face: "bottom", dir: "top" });
        out.push({ cell: [hub.x - 1, hub.y + i], face: "left", dir: "right" });
        out.push({ cell: [hub.x + 4, hub.y + i], face: "right", dir: "left" });
    }
    return out;
}

/* ───────────── 找一条从 A 到某个 hub 入口的路 ─────────────
 * 只允许 0 或 1 次拐弯（简单、可验证）。必须首格方向 == startDir（由上游机器决定）。 */
function findRoute(from, startDir, entries, occupied, used) {
    const [dx, dy] = DIRV[startDir];
    const free = c => !occupied.has(k(c[0], c[1]));

    /* 直线 */
    for (const e of entries) {
        if (used.has(k(e.cell[0], e.cell[1]))) continue;
        if (e.dir !== startDir) continue;
        const cells = [];
        let [x, y] = from;
        for (let n = 0; n < 80; n++) {
            cells.push([x, y]);
            if (x === e.cell[0] && y === e.cell[1]) break;
            x += dx; y += dy;
        }
        const last = cells[cells.length - 1];
        if (last[0] !== e.cell[0] || last[1] !== e.cell[1]) continue;
        if (cells.some(c => !free(c))) continue;
        return { cells, entry: e, kind: "straight" };
    }

    /* 一次拐弯 */
    for (const e of entries) {
        if (used.has(k(e.cell[0], e.cell[1]))) continue;
        for (let t = 1; t <= 40; t++) {
            const tx = from[0] + dx * t, ty = from[1] + dy * t;
            let axis = null;
            if (tx === e.cell[0]) axis = "v";
            else if (ty === e.cell[1]) axis = "h";
            if (!axis) continue;

            const seg1 = [];
            for (let i = 0; i <= t; i++) seg1.push([from[0] + dx * i, from[1] + dy * i]);
            const seg2 = [];
            if (axis === "v") {
                if (ty === e.cell[1]) continue;
                const st = e.cell[1] > ty ? 1 : -1;
                for (let y = ty + st; ; y += st) { seg2.push([tx, y]); if (y === e.cell[1]) break; }
            } else {
                if (tx === e.cell[0]) continue;
                const st = e.cell[0] > tx ? 1 : -1;
                for (let x = tx + st; ; x += st) { seg2.push([x, ty]); if (x === e.cell[0]) break; }
            }
            // 不折返
            const s1 = new Set(seg1.map(c => k(c[0], c[1])));
            if (seg2.some(c => s1.has(k(c[0], c[1])))) continue;
            const cells = [...seg1, ...seg2];
            if (cells.some(c => !free(c))) continue;
            const lastDir = axis === "v" ? (e.cell[1] > ty ? "bottom" : "top") : (e.cell[0] > tx ? "right" : "left");
            if (lastDir !== e.dir) continue;
            return { cells, entry: e, kind: "turn" };
        }
    }
    return null;
}

/** 一串格子 → 每格朝向（首格的入口由 startDir 决定） */
function beltOrient(cells, entry, startDir) {
    const out = [];
    for (let i = 0; i < cells.length; i++) {
        const [x, y] = cells[i];
        const prev = i === 0 ? null : cells[i - 1];
        const next = i === cells.length - 1 ? entry.cell : cells[i + 1];
        const dFrom = p => (p[0] === x ? (p[1] < y ? "top" : "bottom") : (p[0] < x ? "left" : "right"));
        const inDir = i === 0 ? startDir : dFrom(prev);
        const outDir = i === cells.length - 1 ? entry.dir : dFrom(next);
        const s = solve(inDir, outDir);
        if (!s) return { ok: false, why: `(${x},${y}) ${inDir}->${outDir}` };
        out.push({ x, y, rot: s.rot });
    }
    return { ok: true, belts: out };
}

/* ───────────── 主流程 ───────────── */
async function main() {
    const st = await observe();
    const ops = requiredOps(st.goal);
    const needCut = ops.some(o => o.op === "cut");
    console.log(`目标 ${st.goal}（需要 ${ops.map(o => o.op).join("+") || "采矿"}）`);

    const occupied = new Set(st.ents.map(e => k(e.x, e.y)));
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) occupied.add(k(st.hub.x + dx, st.hub.y + dy));

    const entries = hubEntries(st.hub);
    const usedEntries = new Set();

    // 候选矿位：按到 hub 距离
    const ore = st.ore.filter(c => c.kind === "RuRuRuRu" && !occupied.has(k(c.x, c.y)))
        .sort((a, b) => (Math.abs(a.x - st.hub.x) + Math.abs(a.y - st.hub.y)) - (Math.abs(b.x - st.hub.x) + Math.abs(b.y - st.hub.y)));

    const build = [];
    let targetHalf = /^[^-]/.test(st.goal) ? "left" : "right";

    for (const cell of ore) {
        if (build.length) break;

        if (!needCut) {
            /* 直接采矿 → hub */
            for (const outDir of ["bottom", "top", "right", "left"]) {
                const start = [cell.x + DIRV[outDir][0], cell.y + DIRV[outDir][1]];
                if (occupied.has(k(start[0], start[1]))) continue;
                const route = findRoute(start, outDir, entries, occupied, usedEntries);
                if (!route) continue;
                const bo = beltOrient(route.cells, route.entry, outDir);
                if (!bo.ok) continue;
                build.push({ miner: cell, outDir, route: bo.belts, entry: route.entry, kind: "mine" });
                usedEntries.add(k(route.entry.cell[0], route.entry.cell[1]));
                break;
            }
            continue;
        }

        /* 矿机 → 切割机 → hub。
           切割机看着简单实际很挑：输入在南、输出在北（r=0）。
           所以矿机必须在切割机南边，而 hub 还要在切割机北边 —— 否则输出朝反方向。
           钌矿在 hub 北侧 ⇒ 想用 r=0 的切割机就必须让货"往南"回 hub，做不到。
           **用 r=180 的切割机**：输入在北、输出在南，正好朝 hub。 */
        for (let gap = 2; gap <= 5; gap++) {
            const cutX = cell.x, cutY = cell.y - gap;     // 切割机在矿机北边
            // r=180 占位：local(0,0)->(cutX,cutY)，local(1,0)->(cutX-1,cutY)
            const cutCells = [[cutX, cutY], [cutX - 1, cutY]];
            if (cutCells.some(([x, y]) => occupied.has(k(x, y)))) continue;
            // 送料：矿机朝北，从 cell.y-1 到 cutY+1
            const feed = [];
            let okFeed = true;
            for (let y = cell.y - 1; y > cutY; y--) {
                if (occupied.has(k(cell.x, y))) { okFeed = false; break; }
                feed.push([cell.x, y]);
            }
            if (!okFeed || !feed.length) continue;
            // r=180 输出：两个槽都在 local(0,0)/local(1,0)，方向 top 旋转 180 = bottom
            // 输出格 = 槽位世界格 + (0,+1)
            const outA = [cutX, cutY + 1];          // slot0 = left 半
            const outB = [cutX - 1, cutY + 1];      // slot1 = right 半
            if (occupied.has(k(outA[0], outA[1])) || occupied.has(k(outB[0], outB[1]))) continue;
            const half = targetHalf === "left" ? outA : outB;
            const waste = targetHalf === "left" ? outB : outA;

            // 目标半 → hub
            const route = findRoute(half, "bottom", entries, occupied, usedEntries);
            if (!route) continue;
            const bo = beltOrient(route.cells, route.entry, "bottom");
            if (!bo.ok) continue;

            // 副产品 → trash（紧贴下游 2 格）
            const trashAt = [waste[0], waste[1] + 1];
            if (occupied.has(k(trashAt[0], trashAt[1]))) continue;

            build.push({
                kind: "cut", miner: cell, cutter: [cutX, cutY], cutRot: 180,
                feed, half, waste, trashAt,
                route: bo.belts, entry: route.entry,
            });
            usedEntries.add(k(route.entry.cell[0], route.entry.cell[1]));
        }
    }

    if (!build.length) { console.log("✗ 找不到完整可行的产线"); return; }

    for (const b of build) {
        if (b.kind === "mine") {
            console.log(`\n矿机 (${b.miner.x},${b.miner.y}) 朝 ${b.outDir}`);
            console.log(`  ${b.route.length} 格带 → hub 入口 (${b.entry.cell})`);
        } else {
            console.log(`\n矿机 (${b.miner.x},${b.miner.y}) 朝北 → 送料 ${b.feed.length} 格`);
            console.log(`  切割机 (${b.cutter}) r=180`);
            console.log(`  目标半 (${b.half}) → ${b.route.length} 格带 → hub 入口 (${b.entry.cell})`);
            console.log(`  副产品 (${b.waste}) → trash (${b.trashAt})`);
        }
    }

    if (!EXEC) { console.log("\n（--plan 模式）"); return; }

    /* ───── 执行 ───── */
    console.log("\n──── 建造 ────");
    const put = async a => { try { const r = await rpc("act", a); return r; } catch (e) { console.log(`  ✗ ${a.op} ${e.message}`); return null; } };

    for (const b of build) {
        if (b.kind === "mine") {
            const m = await put({ op: "place", building: "miner", x: b.miner.x, y: b.miner.y, r: rotOf(b.outDir) });
            if (!m) return;
            for (const c of b.route) await put({ op: "place", building: "belt", x: c.x, y: c.y, r: c.rot });
            console.log(`  矿机 (${b.miner.x},${b.miner.y}) + ${b.route.length} 格带 ✓`);
            continue;
        }
        // 矿机
        if (!await put({ op: "place", building: "miner", x: b.miner.x, y: b.miner.y, r: 0 })) return;
        // 送料带（矿机朝北 ⇒ 全部朝北）
        for (const [x, y] of b.feed) await put({ op: "place", building: "belt", x, y, r: solve("bottom", "top").rot });
        // 切割机
        if (!await put({ op: "place", building: "cutter", x: b.cutter[0], y: b.cutter[1], r: 180 })) return;
        // 目标半的路
        for (const c of b.route) await put({ op: "place", building: "belt", x: c.x, y: c.y, r: c.rot });
        // 副产品：一格带 + trash
        const w1 = [b.waste[0], b.waste[1] + 1];
        if (w1[0] !== b.trashAt[0] || w1[1] !== b.trashAt[1]) {
            await put({ op: "place", building: "belt", x: w1[0], y: w1[1], r: solve("top", "bottom").rot });
        }
        await put({ op: "place", building: "trash", x: b.trashAt[0], y: b.trashAt[1], r: 0 });
        console.log(`  矿机+切割机+双路 ✓`);
    }

    /* ───── 验收：每段路都有 acceptor ───── */
    const diag = await rpc("debug_items", { region: [-60, -60, 60, 60] }, 120000);
    const dead = (diag.paths || []).filter(p => !p.boundAcceptor && p.cells.length);
    console.log(`\n──── 验收 ────`);
    console.log(`belt paths: ${diag.pathCount}，末端无去处的: ${dead.length}`);
    for (const d of dead) console.log(`  ⚠ ${JSON.stringify(d.cells)}`);
    if (diag.ejectors && diag.ejectors.length) {
        console.log(`堵住的 ejector: ${diag.ejectors.length}`);
        for (const e of diag.ejectors.slice(0, 5)) console.log(`  ${JSON.stringify(e.cell)} slot${e.slot} ${e.item}`);
    }

    /* ───── 产量 ───── */
    const t0 = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).tick;
    const s0 = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).hub.stored_shapes[st.goal] || 0;
    await rpc("act", { op: "step", ticks: 7200 }, 300000);
    const fin = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    const elapsed = fin.tick - t0;
    const got = (fin.hub.stored_shapes[st.goal] || 0) - s0;
    console.log(`\n${elapsed.toFixed(0)} 秒内 ${st.goal}: +${got}  (${(got / elapsed).toFixed(3)}/s)`);
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 2; });
