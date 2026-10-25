/**
 * build-copper-line.mjs — 按攻略规则建一座**能长大**的产线。
 *
 * 规则来源 research/ai-plan/tmp/STRATEGY-RESEARCH.md：
 *   · 前 5 关瓶颈 100% 是矿机数量（矿机 0.4/s、带子 2/s ⇒ 一条带要 5 台）
 *   · hub 16 个入口任意口都收，不必按形状分配
 *   · 堵了会自动改道的分流件（balancer/splitter），不做精确配平
 *   · 每个废料口必须接垃圾站
 *
 * 这一版只建**骨架**：N 台矿机 → 一条干道 → hub。
 * 不接切割/上色：先证明"多矿机并联真的能线性加产量"，
 * 再往上叠工序。每步都有独立判据。
 *
 * 几何（矿机在南、hub 在北，全部朝北）：
 *
 *   miner(x1) miner(x2) ... miner(xN)     ← 一排矿机，都在 y = my
 *      │         │             │
 *      └────┬────┴─────────────┘         ← 每个矿机正北一格就是干道
 *           ▼
 *     干道（y = my-1，向东）
 *           │ 东端拐角
 *           ▼
 *      竖直北行（x = eastX）
 *           │ hub 入口行上向西拐
 *           ▼
 *         hub 底部入口
 */
import { rpc, act, log } from "./kit.mjs";

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rot = (local, r) => ORDER[(ORDER.indexOf(local) + Math.round(r / 90)) % 4];
const solve = (inDir, outDir) => {
    for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
        if (rot("bottom", r) === inDir && rot(EXIT_LOCAL[rv], r) === outDir) return { rot: r, rv };
    }
    throw new Error(`no belt ${inDir}->${outDir}`);
};

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const WANT = argOf("--miners", 4);
const MEASURE = 6000;
const RES = argOf("--resource", -1);          // 0=铜 1=钌；-1=按当前目标推

const SHAPES = { CuCuCuCu: "CuCuCuCu", RuRuRuRu: "RuRuRuRu" };

async function main() {
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("no world");
    const o = await rpc("obs", { max_entities: 5000, include_stats: true, include_hub: true }, 120000);
    const hub = o.entities.find(e => e.type === "hub");
    log("hub", [hub.x, hub.y], "| level", o.goal.level, o.goal.requirement.shape);

    const want = RES === 0 ? "CuCuCuCu" : RES === 1 ? "RuRuRuRu" : "CuCuCuCu";
    log("目标资源:", want);

    // ── 找矿 ────────────────────────────────────────────────────────
    const ore = await rpc("obs", { region: [hub.x - 40, hub.y - 40, hub.x + 40, hub.y + 40],
        include_resources: true, max_resources: 20000, include_stats: false }, 120000);
    const cells = (ore.resources || []).filter(r => r[2] === want).map(([x, y]) => ({ x, y }));
    log(want, "格数:", cells.length);

    // 选一行能排下 WANT 台的连续段（同一行最省接线）
    const rows = new Map();
    for (const c of cells) { if (!rows.has(c.y)) rows.set(c.y, []); rows.get(c.y).push(c.x); }
    let my = null, xs = null;
    for (const [y, list] of [...rows.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const s = list.sort((a, b) => a - b);
        let best = [s[0]], cur = [s[0]];
        for (let i = 1; i < s.length; i++) {
            if (s[i] === s[i - 1] + 1) cur.push(s[i]);
            else { if (cur.length > best.length) best = cur; cur = [s[i]]; }
        }
        if (cur.length > best.length) best = cur;
        if (best.length >= 2) { my = y; xs = best.slice(0, WANT); break; }
    }
    if (!my) throw new Error("找不到能密排的矿行");
    log(`矿行 y=${my}，矿格`, xs);

    /* 矿机必须朝北出料 ⇒ 干道在矿机**北侧**（y 更小）。
       如果矿行在 hub 北边（my < hub.y），干道就要往南走；这里统一处理： */
    const northOfHub = my > hub.y;              // 矿在 hub 南边 = 正常（y 更大）
    log("矿在 hub", northOfHub ? "南边" : "北边");

    // ── 清场 ────────────────────────────────────────────────────────
    const pad = 6;
    const r0 = Math.min(Math.min(...xs), hub.x) - pad;
    const r1 = Math.min(Math.min(my, hub.y)) - pad;
    const r2 = Math.max(Math.max(...xs), hub.x + 3) + pad;
    const r3 = Math.max(Math.max(my, hub.y + 3)) + pad;
    const del = await rpc("act", { op: "bulk_delete", region: [r0, r1, r2, r3], dry_run: false }, 90000);
    log("清场:", del.applied, "实体");

    // ── 建线 ────────────────────────────────────────────────────────
    /* 全部朝北：矿机 (x,my) 出料到 (x,my-1)。
       干道在 y = my-1，向东流；到东端拐北；北上到 hub 的**南侧入口行** hub.y+4，
       在那行向西走到某个入口列，再北上进 hub。
       ⚠️ 北行段必须绕开 hub 本体（x 在 hub.x..hub.x+3、y 在 hub.y..hub.y+3），
       所以东端的 x 要 > hub.x+3。 */
    const eastX = Math.max(...xs) + 2;
    const entryY = hub.y + 4;
    const entryX = hub.x + 3;
    if (eastX <= hub.x + 3) throw new Error(`东端 x=${eastX} 撞上 hub 右侧（需 > ${hub.x + 3}）`);
    if (entryY >= my - 1) throw new Error(`hub 入口行 y=${entryY} 在干道行 y=${my - 1} 下方`);

    log(`干道 y=${my - 1}，东端 x=${eastX}，入口 (${entryX},${entryY})`);
    const parts = [];
    const put = (x, y, building, r) => parts.push({ op: "place", building, x, y, r });

    // 矿机
    for (const x of xs) put(x, my, "miner", 0);

    // 干道：最西矿机 → 东端
    const westX = Math.min(...xs);
    const isMinerCol = new Set(xs);
    for (let x = westX; x <= eastX; x++) {
        if (isMinerCol.has(x)) {
            // 这格要同时"从南收货"和"向东送" ⇒ 从 bottom 进、向 right 出
            put(x, my - 1, "belt", x === eastX ? solve("bottom", "top").rot : solve("bottom", "right").rot);
        } else if (x === eastX) {
            put(x, my - 1, "belt", solve("left", "top").rot);
        } else {
            put(x, my - 1, "belt", solve("left", "right").rot);
        }
    }

    // 北行段：从 eastX 往北到 entryY
    for (let y = my - 2; y > entryY; y--) {
        put(eastX, y, "belt", solve("bottom", "top").rot);
    }

    // 入口行：从 eastX 向西走到 entryX（只在需要时），再由 entryX 北上
    if (eastX > entryX) {
        put(eastX, entryY, "belt", solve("bottom", "left").rot);
        for (let x = eastX - 1; x > entryX; x--) put(x, entryY, "belt", solve("right", "left").rot);
        put(entryX, entryY, "belt", solve("left", "top").rot);
    } else {
        put(entryX, entryY, "belt", solve("bottom", "top").rot);
    }

    log(`\n放置 ${parts.length} 个实体`);
    const res = [];
    for (const p of parts) res.push({ ...p, ok: !!(await act(p)) });
    const okN = res.filter(r => r.ok).length;
    log(`成功 ${okN}/${parts.length}`);
    const failed = res.filter(r => !r.ok);
    if (failed.length) log("  失败:", JSON.stringify(failed.slice(0, 10).map(f => [f.building, f.x, f.y])));

    // 读回
    const rb = await rpc("obs", { region: [westX - 2, entryY - 2, eastX + 2, my + 2], max_entities: 3000, include_stats: false }, 90000);
    const grid = new Set((rb.entities || []).map(e => `${e.x},${e.y}`));
    const missing = res.filter(r => !grid.has(`${r.x},${r.y}`));
    log(`读回 ${res.length - missing.length}/${res.length}` +
        (missing.length ? ` 缺 ${JSON.stringify(missing.slice(0, 6).map(m => [m.building, m.x, m.y]))}` : ""));

    // 测产量
    const s0 = await stored(want);
    const step = await act({ op: "step", ticks: MEASURE });
    const s1 = await stored(want);
    const secs = (step.ticks_run || MEASURE) / 60;
    const rate = (s1 - s0) / secs;
    log(`\n══════ 结果 ══════`);
    log(`${want}: ${s0} → ${s1}  (+${s1 - s0}) = ${rate.toFixed(3)}/s over ${secs.toFixed(0)}s`);
    log(`${xs.length} 台矿机上限 = ${(xs.length * 0.6).toFixed(1)}/s（miner T1）`);
    log(`单台基线 0.6/s ⇒ 提升 ${(rate / 0.6).toFixed(1)}×`);

    return { miners: xs.length, rate, placed: okN, planned: parts.length };
}

async function stored(shape) {
    const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    return (o.hub.stored_shapes && o.hub.stored_shapes[shape]) || 0;
}

main()
    .then(r => { log("\nDONE"); process.exitCode = r.rate > 1.0 ? 0 : 1; })
    .catch(e => { console.error("\nERROR:", e.message); process.exitCode = 2; });
