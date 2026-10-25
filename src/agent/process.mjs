/**
 * process.mjs — 给产线加**加工工序**（切割 / 堆叠 / 上色）。
 *
 * 为什么单独一个文件：`grow.mjs` 只放矿机+带子，产的是原料形状（RuRuRuRu）。
 * 而目标是加工形状（RuRu----），没有工序永远达不成 —— 框架的 assess 已经能识别这一点
 * （`[P2] 需要 cut，但没有任何接在矿机产线上的切割机`），这里补上执行。
 *
 * 几何（cutter.js:85-110 源码核证）：
 *   输入  local (0,0) ← bottom   （货从**南边**进来）
 *   输出  local (0,0) → top      （left 半，往北出）
 *         local (1,0) → top      （right 半，往北出）
 *   占地  2×1
 *
 * ⇒ 矿机必须朝北（r=0），货往北送到切割机；切割机再往北出两路，
 *   一路是目标形状（接 hub），一路是副产品（接 trash）。
 *
 * 用法：
 *   node src/agent/process.mjs --plan     看计划
 *   node src/agent/process.mjs --execute  执行
 */
import { requiredOps } from "./assess.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rpcId = 1;
async function rpc(method, params = {}, timeout = 180000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
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
const rotateLocal = (l, r) => ORDER[(ORDER.indexOf(l) + Math.round(r / 90)) % 4];
const solve = (inDir, outDir) => {
    for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
        if (rotateLocal("bottom", r) === inDir && rotateLocal(EXIT_LOCAL[rv], r) === outDir) return { rot: r, rv };
    }
    return null;
};

const args = process.argv.slice(2);
const EXEC = args.includes("--execute");

async function observe() {
    const o = await rpc("obs", {
        max_entities: 5000, include_hub: true, include_resources: true,
        max_resources: 20000, region: [-60, -60, 60, 60],
    });
    return {
        hub: (o.entities || []).find(e => e.type === "hub"),
        entities: (o.entities || []).map(e => ({ type: e.type, x: e.x, y: e.y, r: e.r })),
        ore: (o.resources || []).map(([x, y, kind]) => ({ x, y, kind })),
        goal: o.goal.requirement.shape,
        stored: o.hub.stored_shapes || {},
        upgrades: o.goal.upgrade_levels || {},
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

/**
 * 规划"矿机 → 切割机 → hub"这一段。
 *
 * 关键约束（源码）：
 *   · 矿机朝北（r=0），货往 y 减小方向
 *   · 切割机输入在南面 ⇒ 切割机必须在矿机**北边**至少 2 格（中间要一格带）
 *   · 切割机的两个输出都在北面：(x,y-1) 和 (x+1,y-1)
 *   · 目标那一半接 hub，另一半接 trash
 *
 * 返回 {miner, cutter, belts:[], hubBelts:[], wasteBelts:[], entry, wasteAt}
 */
function planCutterLine(ore, hub, occupied, targetHalf) {
    const entries = hubEntries(hub);
    const usedEntries = new Set();
    const results = [];

    for (const cell of ore) {
        if (occupied.has(`${cell.x},${cell.y}`)) continue;
        // 切割机中心候选：矿机正上方 2~6 格
        for (let gap = 2; gap <= 6; gap++) {
            const cutterY = cell.y - gap;
            // 切割机占 (x, cutterY) 和 (x+1, cutterY)
            const cutCells = [[cell.x, cutterY], [cell.x + 1, cutterY]];
            if (cutCells.some(([x, y]) => occupied.has(`${x},${y}`))) continue;

            // 矿机 → 切割机输入格 (x, cutterY) 的带子
            const feed = [];
            let ok = true;
            for (let y = cell.y - 1; y > cutterY; y--) {
                if (occupied.has(`${cell.x},${y}`)) { ok = false; break; }
                feed.push([cell.x, y]);
            }
            if (!ok) continue;

            // 切割机两个输出：(x, cutterY-1) 是 left 半，(x+1, cutterY-1) 是 right 半
            const outL = [cell.x, cutterY - 1];
            const outR = [cell.x + 1, cutterY - 1];
            const half = targetHalf === "left" ? outL : outR;
            const waste = targetHalf === "left" ? outR : outL;
            if (occupied.has(`${half[0]},${half[1]}`) || occupied.has(`${waste[0]},${waste[1]}`)) continue;

            // 目标半 → hub：找一条从 half 出发的路
            const route = routeFrom(half, "top", entries, usedEntries, occupied);
            if (!route) continue;

            // 副产品 → trash：放在 waste 正北 2 格
            const trashAt = [waste[0], waste[1] - 2];
            if (occupied.has(`${trashAt[0]},${trashAt[1]}`)) continue;

            return {
                miner: [cell.x, cell.y],
                cutter: [cell.x, cutterY],
                feed, half, waste, trashAt,
                route: route.cells, entry: route.entry,
            };
        }
    }
    return null;
}

/** 从某格沿初始方向走，找到能到 hub 入口的路径（直线或一次拐弯） */
function routeFrom(from, startDir, entries, usedEntries, occupied) {
    const [dx, dy] = DIRV[startDir];
    for (const e of entries) {
        const key = `${e.cell[0]},${e.cell[1]}`;
        if (usedEntries.has(key)) continue;
        // 直线
        const cells = [];
        let [x, y] = from;
        let guard = 0;
        while (guard++ < 100) {
            cells.push([x, y]);
            if (x === e.cell[0] && y === e.cell[1]) break;
            x += dx; y += dy;
            if (Math.abs(x - from[0]) > 60 || Math.abs(y - from[1]) > 60) { cells.length = 0; break; }
        }
        if (!cells.length) continue;
        const last = cells[cells.length - 1];
        if (last[0] !== e.cell[0] || last[1] !== e.cell[1]) continue;
        if (e.dir !== startDir) continue;
        if (cells.slice(1).some(([cx, cy]) => occupied.has(`${cx},${cy}`))) continue;
        return { cells, entry: e };
    }
    // 一次拐弯
    for (const e of entries) {
        const key = `${e.cell[0]},${e.cell[1]}`;
        if (usedEntries.has(key)) continue;
        for (let t = 1; t <= 40; t++) {
            const tx = from[0] + dx * t, ty = from[1] + dy * t;
            let seg2 = null;
            if (tx === e.cell[0]) seg2 = "v";
            else if (ty === e.cell[1]) seg2 = "h";
            if (!seg2) continue;
            const seg1 = [];
            for (let i = 0; i <= t; i++) seg1.push([from[0] + dx * i, from[1] + dy * i]);
            const seg2Cells = [];
            if (seg2 === "v") {
                if (ty === e.cell[1]) continue;
                const st = e.cell[1] > ty ? 1 : -1;
                for (let y = ty + st; ; y += st) { seg2Cells.push([tx, y]); if (y === e.cell[1]) break; }
            } else {
                if (tx === e.cell[0]) continue;
                const st = e.cell[0] > tx ? 1 : -1;
                for (let x = tx + st; ; x += st) { seg2Cells.push([x, ty]); if (x === e.cell[0]) break; }
            }
            const seen = new Set(seg1.map(([x, y]) => `${x},${y}`));
            if (seg2Cells.some(([x, y]) => seen.has(`${x},${y}`))) continue;
            const cells = [...seg1, ...seg2Cells];
            if (cells.slice(1).some(([cx, cy]) => occupied.has(`${cx},${cy}`))) continue;
            const lastDir = seg2 === "v" ? (e.cell[1] > ty ? "bottom" : "top") : (e.cell[0] > tx ? "right" : "left");
            if (lastDir !== e.dir) continue;
            return { cells, entry: e };
        }
    }
    return null;
}

/** 给一串格子求每格朝向 */
function beltsFor(cells, entry, finalDir) {
    const out = [];
    for (let i = 0; i < cells.length; i++) {
        const [x, y] = cells[i];
        const prev = i === 0 ? null : cells[i - 1];
        const next = i === cells.length - 1 ? entry.cell : cells[i + 1];
        const dirFrom = p => p ? (p[0] === x ? (p[1] < y ? "top" : "bottom") : (p[0] < x ? "left" : "right")) : null;
        const dirTo = t => (t[0] === x ? (t[1] < y ? "top" : "bottom") : (t[0] < x ? "left" : "right"));
        const inDir = prev ? dirFrom(prev) : (i === 0 ? dirFrom(null) : null);
        const outDir = i === cells.length - 1 ? (finalDir || entry.dir) : dirTo(next);
        if (inDir) {
            const t = solve(inDir, outDir);
            if (!t) return { ok: false, why: `(${x},${y}) ${inDir}->${outDir} 无解` };
            out.push({ x, y, rot: t.rot });
        } else {
            // 第一格：入口方向由上一层（切割机输出/矿机）决定，调用方给
            out.push({ x, y, rot: null, inDirNeeded: outDir });
        }
    }
    return { ok: true, belts: out };
}

async function main() {
    const st = await observe();
    const ops = requiredOps(st.goal);
    console.log(`目标 ${st.goal} 需要: ${ops.map(o => o.op).join("+")}`);

    if (!ops.some(o => o.op === "cut")) {
        console.log("目标不需要切割，process.mjs 无适用工序");
        return;
    }

    // 目标哪一半：RuRu---- 是左半（quad 0,1），----RuRu 是右半
    const targetHalf = /^[^-]/.test(st.goal) ? "left" : "right";
    console.log(`目标形状 ${st.goal} ⇒ 切割机 ${targetHalf === "left" ? "left(slot0)" : "right(slot1)"} 半`);

    const occupied = new Set(st.entities.map(e => `${e.x},${e.y}`));
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) occupied.add(`${st.hub.x + dx},${st.hub.y + dy}`);

    const ore = st.ore.filter(c => c.kind === "RuRuRuRu")
        .sort((a, b) => (Math.abs(a.x - st.hub.x) + Math.abs(a.y - st.hub.y)) - (Math.abs(b.x - st.hub.x) + Math.abs(b.y - st.hub.y)));

    const plan = planCutterLine(ore, st.hub, occupied, targetHalf);
    if (!plan) { console.log("找不到可行的切割机布局"); return; }

    console.log(`\n计划:`);
    console.log(`  矿机 (${plan.miner}) 朝北`);
    console.log(`  送料带 ${plan.feed.length} 格 → 切割机 (${plan.cutter})`);
    console.log(`  目标半 (${plan.half}) 出口 → ${plan.route.length} 格带 → hub 入口 (${plan.entry.cell})`);
    console.log(`  副产品 (${plan.waste}) → trash (${plan.trashAt})`);

    if (!EXEC) { console.log("\n（--plan 模式）"); return; }

    const put = async (a) => { try { return await rpc("act", a); } catch (e) { console.log("  ✗", a.op, e.message); return null; } };

    // 1. 矿机（朝北）
    console.log("\n── 建造 ──");
    let r = await put({ op: "place", building: "miner", x: plan.miner[0], y: plan.miner[1], r: 0 });
    console.log(`  矿机 ${r ? "✓" : "✗"}`);
    if (!r) return;

    // 2. 送料带（从矿机北侧到切割机输入）
    for (const [x, y] of plan.feed) {
        const t = solve("bottom", "top");
        await put({ op: "place", building: "belt", x, y, r: t.rot });
    }
    console.log(`  送料带 ${plan.feed.length} 格 ✓`);

    // 3. 切割机
    r = await put({ op: "place", building: "cutter", x: plan.cutter[0], y: plan.cutter[1], r: 0 });
    console.log(`  切割机 ${r ? "✓" : "✗"}`);
    if (!r) return;

    // 4. 目标半的出口带（第一格朝北出切割机）
    const route = plan.route;
    for (let i = 0; i < route.length; i++) {
        const [x, y] = route[i];
        const prev = i === 0 ? plan.half : route[i - 1];
        const next = i === route.length - 1 ? plan.entry.cell : route[i + 1];
        const dirFrom = p => (p[0] === x ? (p[1] < y ? "top" : "bottom") : (p[0] < x ? "left" : "right"));
        const dirTo = t => (t[0] === x ? (t[1] < y ? "top" : "bottom") : (t[0] < x ? "left" : "right"));
        const inDir = i === 0 ? "bottom" : dirFrom(prev);   // 第一格从切割机下方(南)进货
        const outDir = i === route.length - 1 ? plan.entry.dir : dirTo(next);
        const tt = solve(inDir, outDir);
        if (!tt) { console.log(`  ✗ 目标带 (${x},${y}) ${inDir}->${outDir} 无解`); return; }
        await put({ op: "place", building: "belt", x, y, r: tt.rot });
    }
    console.log(`  目标带 ${route.length} 格 ✓ → 入口 (${plan.entry.cell})`);

    // 5. 副产品 → trash（两格带 + trash）
    const w1 = [plan.waste[0], plan.waste[1] - 1];
    await put({ op: "place", building: "belt", x: w1[0], y: w1[1], r: solve("bottom", "top").rot });
    r = await put({ op: "place", building: "trash", x: plan.trashAt[0], y: plan.trashAt[1], r: 0 });
    console.log(`  副产品 → trash ${r ? "✓" : "✗"}`);

    // 6. 测产量
    const before = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    const t0 = before.tick;
    await rpc("act", { op: "step", ticks: 7200 }, 300000);
    const after = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    const elapsed = after.tick - t0;
    const got = (after.hub.stored_shapes[st.goal] || 0) - (before.hub.stored_shapes[st.goal] || 0);
    console.log(`\n═══ 实测 ${elapsed.toFixed(1)} 秒 ═══`);
    console.log(`  ${st.goal}: +${got}  (${(got / elapsed).toFixed(3)}/s)`);
    if (got === 0) console.log("  ⚠ 没有产出目标形状 —— 检查切割机朝向/槽位");
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 2; });
