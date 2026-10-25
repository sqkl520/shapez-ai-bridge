/**
 * grow.mjs — 按 assess 的建议，**一小步一小步**地把工厂做大。
 *
 * 这一轮我失败 4 次的根因是：一次想把整座工厂建对。真人不是这样 ——
 * 他先放一台矿机、接一条带、看它出不出货，再加第二台。
 *
 * 所以这个脚本的每一"步"都：
 *   1. 只做一件事（放一台矿机 / 接一条带）
 *   2. 立刻读回验证（这一格真的放下了吗）
 *   3. 全部做完后测产量，与预期对比
 *   4. **失败时不继续**，把真实状态报出来
 *
 * 用法：
 *   node src/agent/grow.mjs --plan          只打印计划，不动手
 *   node src/agent/grow.mjs --execute       执行
 *   node src/agent/grow.mjs --monitor 30    监测 30 秒产量
 */
import { assess } from "./assess.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rpcId = 1;
async function rpc(method, params = {}, timeout = 180000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeout),
    });
    const b = await res.json();
    if (b.error) {
        const e = new Error(`${method}: ${b.error.message}`);
        e.code = b.error.code; e.codeName = b.error.data && b.error.data.code_name;
        throw e;
    }
    return b.result;
}

const args = process.argv.slice(2);
const MODE = args.includes("--execute") ? "execute"
    : args.includes("--monitor") ? "monitor"
    : "plan";
const MONITOR_SEC = (() => { const i = args.indexOf("--monitor"); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 30; })();

/* ───────────── 观测 ───────────── */
async function observe() {
    const o = await rpc("obs", {
        max_entities: 5000, include_hub: true, include_resources: true,
        max_resources: 20000, region: [-60, -60, 60, 60],
    });
    const hub = (o.entities || []).find(e => e.type === "hub");
    return {
        raw: o, hub,
        obs: {
            level: o.goal.level,
            goal: { shape: o.goal.requirement.shape, required: o.goal.requirement.required, delivered: o.goal.requirement.delivered },
            stored: o.hub.stored_shapes || {},
            upgrades: o.goal.upgrade_levels || {},
            entities: (o.entities || []).map(e => ({ type: e.type, x: e.x, y: e.y })),
            oreCells: (o.resources || []).map(([x, y, kind]) => ({ x, y, kind })),
        },
    };
}

/* ───────────── hub 入口表（op-templates.hubEntriesWorld 的同一张表）───────────── */
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

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rot = (l, r) => ORDER[(ORDER.indexOf(l) + Math.round(r / 90)) % 4];
const solve = (inDir, outDir) => {
    for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
        if (rot("bottom", r) === inDir && rot(EXIT_LOCAL[rv], r) === outDir) return { rot: r, rv };
    }
    return null;
};
const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/**
 * 为**一台矿机**规划一条到 hub 的路径。
 *
 * 策略（按简单度排）：
 *   ① 矿机正南/正北一线直达某个 hub 入口（零拐角）
 *   ② 一次拐弯（矿机出口方向 → 某行 → 某列 → 入口）
 *
 * 返回 {ok, cells:[{x,y,rot}], entry, reason}
 */
function routeMinerToHub(miner, outDir, hub, occupied) {
    const entries = hubEntries(hub);
    const [dx, dy] = DIRV[outDir];
    const start = [miner.x + dx, miner.y + dy];       // 矿机喷出的第一格

    // ① 直线：从 start 沿 outDir 走到某个入口格，且入口方向 == outDir
    for (const e of entries) {
        if (e.dir !== outDir) continue;
        // 检查 start → e.cell 是否共线且方向一致
        const cells = [];
        let [x, y] = start;
        let guard = 0;
        while (guard++ < 200) {
            cells.push([x, y]);
            if (x === e.cell[0] && y === e.cell[1]) break;
            x += dx; y += dy;
            if (Math.abs(x - start[0]) > 100 || Math.abs(y - start[1]) > 100) { cells.length = 0; break; }
        }
        if (!cells.length) continue;
        const last = cells[cells.length - 1];
        if (last[0] !== e.cell[0] || last[1] !== e.cell[1]) continue;
        if (cells.some(([cx, cy]) => occupied.has(`${cx},${cy}`))) continue;
        return { ok: true, kind: "straight", cells, entry: e };
    }

    // ② 一次拐弯：先沿 outDir 走 d 步，再转向目标入口的轴向
    for (const e of entries) {
        const [ex, ey] = e.cell;
        for (let turnAt = 1; turnAt <= 30; turnAt++) {
            const tx = start[0] + dx * turnAt, ty = start[1] + dy * turnAt;
            let seg2 = null;
            if (tx === ex) seg2 = "vertical";
            else if (ty === ey) seg2 = "horizontal";
            if (!seg2) continue;

            /* ⚠️ 这里曾经把段1 写成 `start + d*i` 而段2 从 `tx,ty` 接着写 —— 于是
               当段2 与段1 反向时，路径会**原地折返**（矿机朝 bottom、路径却先 +y 再 -y），
               生成的自相矛盾带子（同轴同向 ⇒ solve() 无解，或被游戏改写成错误朝向）。
               实测后果：矿机 (3,-5) 朝 bottom，路径 (3,-4) 却朝回矿机，产量只有 0.3/s。
               正确做法：段2 必须从 (tx,ty) **继续向前**，不能回头。 */
            const seg1 = [];
            for (let i = 0; i <= turnAt; i++) seg1.push([start[0] + dx * i, start[1] + dy * i]);

            const seg2Cells = [];
            if (seg2 === "vertical") {
                if (ty === ey) continue;
                const step = ey > ty ? 1 : -1;
                for (let y = ty + step; ; y += step) { seg2Cells.push([tx, y]); if (y === ey) break; }
            } else {
                if (tx === ex) continue;
                const step = ex > tx ? 1 : -1;
                for (let x = tx + step; ; x += step) { seg2Cells.push([x, ty]); if (x === ex) break; }
            }
            // 段1 与段2 不能重叠（除了拐点本身），否则就是折返
            const seenCells = new Set(seg1.map(([x, y]) => `${x},${y}`));
            if (seg2Cells.some(([x, y]) => seenCells.has(`${x},${y}`))) continue;

            const cells = [...seg1, ...seg2Cells];
            if (cells.some(([cx, cy]) => occupied.has(`${cx},${cy}`))) continue;
            const lastDir = seg2 === "vertical" ? (ey > ty ? "bottom" : "top") : (ex > tx ? "right" : "left");
            if (lastDir !== e.dir) continue;
            return { ok: true, kind: "turn", cells, entry: e, turnAt };
        }
    }
    return { ok: false, reason: "no-route" };
}

/* ───────────── 计划 ───────────── */
function makePlan(state) {
    const { obs, hub } = state;
    const r = assess(obs);
    const occupied = new Set(obs.entities.map(e => `${e.x},${e.y}`));
    // hub 本体也算占用
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) occupied.add(`${hub.x + dx},${hub.y + dy}`);

    const goalShape = obs.goal.shape;                       // 例如 RuRu----
    const baseShape = goalShape.replace(/-/g, "") || goalShape;  // 粗略推基础形状

    // 找钌矿（当前关卡要 RuRu----，原料是 RuRuRuRu）
    const wantOre = "RuRuRuRu";
    const cells = obs.oreCells.filter(c => c.kind === wantOre);
    const free = cells.filter(c => !occupied.has(`${c.x},${c.y}`));
    // 按到 hub 的距离排，近的先
    free.sort((a, b) => (Math.abs(a.x - hub.x) + Math.abs(a.y - hub.y)) - (Math.abs(b.x - hub.x) + Math.abs(b.y - hub.y)));

    const steps = [];
    const usedEntries = new Set();

    for (const c of free.slice(0, 6)) {
        const dirs = ["bottom", "right", "left", "top"];    // 优先朝 hub 的方向
        for (const outDir of dirs) {
            // 矿机自己占的格也要算进占用
            const trial = new Set(occupied);
            trial.add(`${c.x},${c.y}`);
            const route = routeMinerToHub(c, outDir, hub, trial);
            if (!route.ok) continue;
            const entryKey = `${route.entry.cell[0]},${route.entry.cell[1]}`;
            if (usedEntries.has(entryKey)) continue;
            usedEntries.add(entryKey);
            steps.push({
                ore: [c.x, c.y], outDir, route: route.cells, entry: route.entry,
                belts: route.cells.length,
            });
            // 把这些格也标占用，下一台不能再用
            for (const [x, y] of route.cells) occupied.add(`${x},${y}`);
            occupied.add(`${c.x},${c.y}`);
            break;
        }
        if (steps.length >= 4) break;
    }
    return { assessment: r, steps, wantOre };
}

/* ───────────── 执行 ───────────── */
async function execute(plan) {
    const results = [];
    for (const [i, step] of plan.steps.entries()) {
        console.log(`\n── 第 ${i + 1} 台矿机 @(${step.ore}) 朝 ${step.outDir} ──`);
        // 先放矿机
        let r;
        try {
            r = await rpc("act", { op: "place", building: "miner", x: step.ore[0], y: step.ore[1], r: { top: 0, right: 90, bottom: 180, left: 270 }[step.outDir] });
            console.log(`  矿机 ✓ uid=${r.entity_uid}`);
        } catch (e) {
            console.log(`  矿机 ✗ ${e.message}`);
            results.push({ step: i, ok: false, why: e.message });
            break;                                   // 失败就停，不继续
        }
        // 再铺带子
        let beltFail = null;
        for (const [j, [x, y]] of step.route.entries()) {
            const isLast = j === step.route.length - 1;
            const prev = j === 0 ? [step.ore[0], step.ore[1]] : step.route[j - 1];
            const next = isLast ? step.entry.cell : step.route[j + 1];
            /* 方向语义（belt-rules.mjs）：
                 inDir  = **货从哪个方位进本格** = 上一格相对本格的方向
                 outDir = **货从哪个方位出本格** = 下一格相对本格的方向
               ⚠️ 我曾把 inDir 当成"流向"，于是 (1,-6) 算出 in=left/out=left —— 那是
               "从左边进、往左边出"，物理上不存在，solve() 返回 null。正确的 in=right。 */
            const dirFrom = (from) => from[0] === x ? (from[1] < y ? "top" : "bottom") : (from[0] < x ? "left" : "right");
            const dirTo = (to) => to[0] === x ? (to[1] < y ? "top" : "bottom") : (to[0] < x ? "left" : "right");
            // 第一格的入口 = 矿机喷出方向（矿机朝 outDir 喷，所以货从 OPP[outDir] 那一侧进来……）
            // 用 dirFrom(prev) 自然得到：prev 是矿机所在格，相对本格的方向就是入口。
            const inDir = dirFrom(prev);
            const outDir = isLast ? step.entry.dir : dirTo(next);
            void dirTo;
            const t = solve(inDir, outDir);
            if (!t) { beltFail = `(${x},${y}) 无法从 ${inDir} 转 ${outDir}`; break; }
            try {
                await rpc("act", { op: "place", building: "belt", x, y, r: t.rot });
            } catch (e) {
                beltFail = `(${x},${y}) ${e.message}`;
                break;
            }
        }
        if (beltFail) {
            console.log(`  带子 ✗ ${beltFail}`);
            results.push({ step: i, ok: false, why: beltFail });
            break;
        }
        console.log(`  带子 ✓ ${step.route.length} 格 → hub 入口 (${step.entry.cell})`);
        results.push({ step: i, ok: true });
    }
    return results;
}

/* ───────────── 实测产量 ───────────── */
async function monitor(shape, seconds) {
    const before = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).hub.stored_shapes || {};
    /* ⚠️ 时间基准：step 的 `ticks` 是**逻辑 tick**，不是 1/60 秒。
       实测 `step(3600)` 推进 30 游戏秒 ⇒ 120 ticks = 1 秒。
       用 ticks/60 算会把吞吐高估一倍 —— 我之前所有"理论 1.2/s、实测 0.6"的对比
       都因此把结论说错。这里直接读游戏时间，不靠换算。 */
    const t0 = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).tick;
    const r = await rpc("act", { op: "step", ticks: Math.round(seconds * 120) }, 300000);
    const after = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    const elapsed = after.tick - t0;                       // 游戏秒（权威）
    const d = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after.hub.stored_shapes || {})])) {
        const delta = ((after.hub.stored_shapes || {})[k] || 0) - (before[k] || 0);
        if (delta !== 0) d[k] = delta;
    }
    console.log(`\n═══ 实测 ${elapsed.toFixed(1)} 游戏秒（step ${r.ticks_run} ticks）═══`);
    if (!Object.keys(d).length) console.log("  (没有任何形状进 hub)");
    for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(12)} +${v}  (${(v / elapsed).toFixed(3)}/s)`);
    return d;
}

/* ───────────── main ───────────── */
async function main() {
    const state = await observe();
    const plan = makePlan(state);

    console.log("═══ 评估 ═══");
    console.log(plan.assessment.headline);
    console.log("\n═══ 计划 ═══");
    if (!plan.steps.length) {
        console.log("  没有可行的矿机落点");
    }
    for (const [i, s] of plan.steps.entries()) {
        console.log(`  ${i + 1}. 矿机 (${s.ore}) 朝 ${s.outDir}，${s.belts} 格带子 → 入口 (${s.entry.cell})`);
    }

    if (MODE === "plan") {
        console.log("\n（--plan 模式，未动手。用 --execute 执行）");
        return;
    }

    if (MODE === "execute") {
        const res = await execute(plan);
        const okN = res.filter(r => r.ok).length;
        console.log(`\n═══ 执行结果：${okN}/${plan.steps.length} 台完成 ═══`);
        if (okN < plan.steps.length) {
            console.log("⚠ 有失败，已在第一处停下（不带着错误继续）");
            return;
        }
        const expect = plan.steps.length * 0.6;
        console.log(`\n理论产量：${plan.steps.length} 台 × 0.6/s = ${expect.toFixed(1)}/s`);
        await monitor(plan.assessment.goal.shape, 20);
        return;
    }

    if (MODE === "monitor") {
        await monitor(plan.assessment.goal.shape, MONITOR_SEC);
    }
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 2; });
