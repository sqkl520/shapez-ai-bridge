/**
 * exp-parallel-miners.mjs — N miners on one ore cluster, measured against a baseline.
 *
 * The audit was blunt: 18 rutile cells within reach, one miner running, throughput pinned at
 * 0.6/s while the ore sat idle. A person does not meet a 70-item goal by waiting longer; they
 * put more miners on the ore and give each one its own path into the hub.
 *
 * Structure — deliberately the simplest that can scale, because my first attempt used a shared
 * spine and I got the joins wrong twice:

 *   miner(2,-6)  ─► belts east ─► turn south ─► own hub entry
 *   miner(3,-8)  ─► belts east ─► turn south ─► own hub entry
 *   miner(4,-10) ─► belts east ─► turn south ─► own hub entry
 *
 * No merging, no shared columns, no corners shared between paths. Each miner owns a column and
 * an entry. Fewer things to get wrong, and it uses the 16 hub entries the way they exist.
 *
 * Everything is placed through the bridge and read back cell by cell; the hub's accepted count
 * is the only success signal.
 *
 * Usage: node research/ai-plan/live/exp-parallel-miners.mjs [--miners 3]
 */
import { rpc, act, log } from "./kit.mjs";

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rot = (local, r) => ORDER[(ORDER.indexOf(local) + Math.round(r / 90)) % 4];
const solve = (inDir, outDir) => {
    for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
        if (rot("bottom", r) === inDir && rot(EXIT_LOCAL[rv], r) === outDir) return { rot: r, rv, code: 1 + rv };
    }
    throw new Error(`no belt ${inDir}->${outDir}`);
};

const MEASURE_TICKS = 6000;
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const WANT_MINERS = argOf("--miners", 3);

async function main() {
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("no world");
    const o = await rpc("obs", { max_entities: 5000, include_stats: true, include_hub: true }, 120000);
    const hub = o.entities.find(e => e.type === "hub");
    log("hub", [hub.x, hub.y], "| level", o.goal.level, o.goal.requirement.shape);

    // find rutile cells and take the WANT_MINERS closest to the hub
    const ore = await rpc("obs", { region: [hub.x - 30, hub.y - 30, hub.x + 30, hub.y + 30],
        include_resources: true, max_resources: 5000, include_stats: false }, 120000);
    const rutile = (ore.resources || []).filter(r => r[2] === "RuRuRuRu")
        .map(([x, y]) => ({ x, y, d: Math.abs(x - hub.x) + Math.abs(y - hub.y) }))
        .sort((a, b) => a.d - b.d);
    log("rutile cells in range:", rutile.length);
    if (rutile.length < WANT_MINERS) throw new Error(`only ${rutile.length} rutile cells`);

    // One per ROW keeps the belts from crossing each other.
    const byRow = new Map();
    for (const c of rutile) {
        if (!byRow.has(c.y)) byRow.set(c.y, []);
        byRow.get(c.y).push(c);
    }
    const rows = [...byRow.keys()].sort((a, b) => Math.abs(a - hub.y) - Math.abs(b - hub.y));
    const miners = [];
    for (const y of rows) {
        if (miners.length >= WANT_MINERS) break;
        miners.push(byRow.get(y)[0]);          // westernmost on that row
    }
    log("picked miners:", JSON.stringify(miners.map(m => [m.x, m.y])));

    // clear the work area
    const minX = Math.min(...miners.map(m => m.x)) - 1;
    const maxX = Math.max(...miners.map(m => m.x)) + 8;
    const minY = Math.min(...miners.map(m => m.y)) - 1;
    const maxY = hub.y + 5;
    const del = await rpc("act", { op: "bulk_delete", region: [minX, minY, maxX, maxY], dry_run: false }, 60000);
    log("cleared", del.applied, "entities");

    // ── one independent path per miner ──────────────────────────────────
    // Miner i ejects east along its row, turns south at column cx_i, runs down, then turns
    // into a hub bottom entry. cx_i are spaced so the paths never touch.
    const parts = [];
    const usedEntries = new Set();
    /* Track every cell we plan so two paths never claim the same one. The first version let
     * all three miners walk along the same hub entry row and overwrite each other's belts —
     * 33 planned, 30 landed, and no ore moved. */
    const claimed = new Set();
    const claim = (x, y) => {
        const k = `${x},${y}`;
        if (claimed.has(k)) return false;
        claimed.add(k);
        return true;
    };
    const push = (x, y, building, r) => { parts.push({ op: "place", building, x, y, r }); claim(x, y); };

    miners.forEach((m, i) => {
        /* Entry column and turn column must DIFFER, otherwise the path comes straight down
           onto the hub entry cell and the last belt would have to be `top -> top`, which has
           no solution (a belt cannot enter and leave on the same axis pointing the same way).
           So the turn column sits west of the entry column and the path always makes a final
           west-to-north corner. */
        let entryX = null;
        for (let ex = hub.x; ex <= hub.x + 3; ex++) {
            if (!usedEntries.has(ex)) { entryX = ex; break; }
        }
        if (entryX === null) throw new Error("no hub entry left");
        usedEntries.add(entryX);
        const cx = entryX - 1;                 // one west of the entry: guarantees the corner

        for (let x = m.x + 1; x <= cx; x++) {
            const t = x === cx ? solve("left", "bottom") : solve("left", "right");
            push(x, m.y, "belt", t.rot);
        }
        // south run down the turn column to the entry row
        for (let y = m.y + 1; y < hub.y + 4; y++) {
            push(cx, y, "belt", solve("top", "bottom").rot);
        }
        // along the entry row eastward to the entry column, then north into the hub
        for (let x = cx; x < entryX; x++) {
            const t = solve(x === cx ? "top" : "left", "right");
            push(x, hub.y + 4, "belt", t.rot);
        }
        push(entryX, hub.y + 4, "belt", solve("left", "top").rot);
        parts.push({ op: "place", building: "miner", x: m.x, y: m.y, r: 90 });
    });

    log(`\nbuilding ${parts.length} cells for ${miners.length} miners`);
    const results = [];
    for (const p of parts) results.push({ ...p, ok: !!(await act(p)) });
    const okCount = results.filter(r => r.ok).length;
    log(`placed ${okCount}/${parts.length}`);
    const failed = results.filter(r => !r.ok);
    if (failed.length) log("  failed:", JSON.stringify(failed.slice(0, 8).map(f => [f.building, f.x, f.y])));

    // readback
    const rb = await rpc("obs", { region: [minX, minY, maxX, maxY], max_entities: 3000, include_stats: false }, 90000);
    const grid = new Set((rb.entities || []).map(e => `${e.x},${e.y}`));
    const missing = results.filter(r => !grid.has(`${r.x},${r.y}`));
    log(`readback: ${results.length - missing.length}/${results.length} present` +
        (missing.length ? ` — missing ${JSON.stringify(missing.slice(0, 5).map(m => [m.building, m.x, m.y]))}` : ""));

    // measure rutile delivered straight to the hub
    const s0 = await stored("RuRuRuRu");
    const step = await act({ op: "step", ticks: MEASURE_TICKS });
    const s1 = await stored("RuRuRuRu");
    const secs = (step.ticks_run || MEASURE_TICKS) / 60;

    log(`\n══════ RESULT ══════`);
    log(`RuRuRuRu in hub: ${s0} -> ${s1} (+${s1 - s0}) => ${((s1 - s0) / secs).toFixed(3)}/s`);
    log(`over ${secs.toFixed(1)}s, ${miners.length} miners`);
    log(`single miner at tier-1 upgrade = ~0.6/s; ${miners.length} should approach ~${(0.6 * miners.length).toFixed(1)}/s`);

    return { miners: miners.length, gained: s1 - s0, rate: (s1 - s0) / secs, placed: okCount, planned: parts.length };
}

async function stored(shape) {
    const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    return (o.hub.stored_shapes && o.hub.stored_shapes[shape]) || 0;
}

main()
    .then(r => { log("\nDONE"); process.exitCode = r.gained > 0 ? 0 : 1; })
    .catch(e => { console.error("\nERROR:", e.message); process.exitCode = 2; });
