/**
 * exp-paste-machine.mjs — T3: new variable = a processing machine (stacker), with belt
 * corners that have the machine as a DIRECT neighbour. Live evidence for R1 / redteam #4
 * check2 / needs_live_test #2: "paste 含机器的布局，读回每根带子 (r,rv) 与设计逐格 diff".
 *
 * Geometry (fresh level-1 save, hub origin (-2,-2); left hub entry (-3,1)):
 *   stacker 2x1 origin (-9,2) cells (-9,2)(-8,2)          (GEOMETRY 表1: inputs both bottom, output top-left)
 *   minerA (-9,4) -top-> belt (-9,3) -top-> stacker LEFT input   (slot0 => lower layer)
 *   minerB (-8,4) -top-> belt (-8,3) -top-> stacker RIGHT input  (slot1 => upper layer)
 *   stacker output (-9,2)top -> belt (-9,1) CORNER(bottom->right, rv2) -> (-8..-3,1) -> hub entry (-3,1)
 *
 *   The corner (-9,1) has the STACKER at (-9,2) directly below it, and belt (-8,3)/(-8,1) touch it too:
 *   those belts' neighbour set contains a machine. If the game rewrote any of them (computeBelt fed by
 *   the stacker's ejector/acceptor), intent_diff would be non-zero. machine_neighbors_count is the
 *   field redteam needs_live_test #2 asked for.
 *
 *   Delivery gate: the stacker product is the 2-layer CuCuCuCu:CucuCuCu, which is NOT the level-1 goal,
 *   so `await hub_delivered_increased` is invalid here (§4.5). We measure hub.stored_shapes[product]
 *   delta after stepping instead.
 */
import {
    rpc, errors, ensureFreshWorld, ensureWindowAwake, snapshotSave, hubPosition, currentWorldUids,
    buildBlueprint, beltPart, minerPart, machinePart, pasteAndDiff, pasteSiteCheck, verifyOfflineResource,
    goal, newWorldBaseline, writeResult, log, bbox, cleanup, offlineTile, DIRV, OPP, CODE,
} from "./kit.mjs";

const NAME = "paste-machine";
const IN_SH = "CuCuCuCu";
// The stacker of two solid-copper layers. Exact hub key casing is asserted empirically by
// scanning stored_shapes deltas (PRODUCT_EXPECT below is only the label we log if it matches).
const PRODUCT_EXPECT = "CuCuCuCu:CuCuCuCu";

/** build the whole machine layout for a given stacker origin (sx,sy) and hub entry (ex,ey). */
function machineBlueprint(sx, sy, entry) {
    const [ex, ey] = entry;
    const parts = [];
    // vertical input feeds (both flow "top" into the stacker's two bottom slots)
    parts.push(minerPart([sx, sy + 2], "top")); // minerA
    parts.push(beltPart([sx, sy + 1], "bottom", "top"));
    parts.push(minerPart([sx + 1, sy + 2], "top")); // minerB
    parts.push(beltPart([sx + 1, sy + 1], "bottom", "top"));
    // stacker
    parts.push(machinePart("stacker", [sx, sy]));
    // output: belt at (sx, sy-1) rises from stacker top-left, corners toward the hub entry row
    const outRow = sy - 1;
    if (outRow !== ey) throw new Error(`output row ${outRow} != entry row ${ey} (design assumes a single corner)`);
    parts.push(beltPart([sx, outRow], "bottom", "right")); // THE machine-adjacent corner
    const step = 1; // run right to the entry
    for (let x = sx + step; x <= ex; x += step) parts.push(beltPart([x, outRow], "left", "right"));
    const last = parts[parts.length - 1].cell;
    if (last[0] !== ex || last[1] !== ey) throw new Error(`tail ${JSON.stringify(last)} != entry ${JSON.stringify(entry)}`);
    return { parts, cornerCell: [sx, outRow], stackerCells: [[sx, sy], [sx + 1, sy]] };
}

/** how many belt cells have a machine (stacker/miner) in their 4-neighbourhood? */
function machineNeighbourReport(parts) {
    const machineSet = new Set(parts.filter((p) => p.kind === "stacker" || p.kind === "miner").map((p) => `${p.cell[0]},${p.cell[1]}`));
    const belts = parts.filter((p) => p.kind === "belt");
    const n4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const withMachine = [];
    for (const b of belts) {
        const nb = n4.map(([dx, dy]) => `${b.cell[0] + dx},${b.cell[1] + dy}`).filter((k) => machineSet.has(k));
        if (nb.length) withMachine.push({ belt: b.cell, code: b.code, machine_neighbors: nb });
    }
    return { machine_neighbors_count: withMachine.length, detail: withMachine };
}

async function main() {
    const st = await rpc("status", {});
    log(`bridge ok: mod ${st.mod_version} game ${st.game_version}`);
    await ensureWindowAwake();
    log("\n[world] reuse/adopt P7 disposable new save ...");
    const world = await ensureFreshWorld("paste-machine");
    const nwBase = await newWorldBaseline();
    log(`  world ${world.internal_id} reused=${world.reused} base ${JSON.stringify(nwBase)}`);

    const hub = await hubPosition();
    const entry = [hub.x - 1, hub.y + 3]; // left column, bottom-ish entry row -> (-3, 1)
    const sx = -9, sy = 2;
    log(`  hub=(${hub.x},${hub.y})  stacker origin=(${sx},${sy})  hub entry=${JSON.stringify(entry)}`);

    // offline resource cross-check on the two miner cells
    const { seed } = await currentWorldUids();
    log("\n[offline] seed=" + seed + " ; verify miner cells are " + IN_SH);
    const xchk = await verifyOfflineResource(seed, [[sx, sy + 2], [sx + 1, sy + 2]], IN_SH);
    log(`  ${JSON.stringify(xchk.rows)}`);

    const { parts, cornerCell, stackerCells } = machineBlueprint(sx, sy, entry);
    const bp = buildBlueprint(parts);
    const mnr = machineNeighbourReport(parts);
    log(`\n[blueprint] entities=${bp.entities.length} by_code=${JSON.stringify(bp.summary.by_code)}`);
    log(`  corner=${JSON.stringify(cornerCell)} (rv from solveTurn(bottom,right)) code=${beltCodeOf(cornerCell, parts)}`);
    log(`  machine_neighbors_count=${mnr.machine_neighbors_count}  ${JSON.stringify(mnr.detail)}`);

    // landing check on exact cells
    const cells = parts.map((p) => p.cell);
    const site = await pasteSiteCheck(cells);
    log(`  paste site: occupied=${site.occupied.length} solid=${site.solid.length} replaceable=${site.replaceable.length} clear=${site.clear}`);

    await snapshotSave("p7-" + NAME);
    log("\n[paste] charge:false ...");
    const pd = await pasteAndDiff(bp, bp.anchor[0], bp.anchor[1]);
    log(`  applied=${pd.paste && pd.paste.applied}/${pd.count} failed=${JSON.stringify(pd.paste && pd.paste.failed)} intent_diff=${pd.intent_diff.length}`);
    if (pd.intent_diff.length) log(`  DIFF: ${JSON.stringify(pd.intent_diff)}`);
    // was the machine-adjacent corner preserved?
    const cornerGot = pd.readback.find((r) => r.cell[0] === cornerCell[0] && r.cell[1] === cornerCell[1]);
    log(`  corner landed: ${JSON.stringify(cornerGot && cornerGot.got)}`);

    log("\n[delivery] step (stacker@0.25/s, product is 2-layer copper, not the level-1 goal) ...");
    const g0 = await goal();
    const shapes0 = (g0.hub && g0.hub.stored_shapes) || {};
    // robust: measure the delta of EVERY stored shape, then find the 2-layer copper product
    let ticks = 0, stepErr = null;
    for (let i = 0; i < 12; i++) {
        try { const s = await rpc("act", { op: "step", ticks: 1500 }, 600000); ticks += s.ticks_run; }
        catch (e) { stepErr = { code: e.code, message: e.message }; log(`  step threw ${e.code}: ${e.message}`); break; }
    }
    const g1 = await goal();
    const shapes1 = (g1.hub && g1.hub.stored_shapes) || {};
    const deltas = {};
    for (const k of new Set([...Object.keys(shapes0), ...Object.keys(shapes1)])) {
        const d = (shapes1[k] || 0) - (shapes0[k] || 0);
        if (d !== 0) deltas[k] = d;
    }
    const prod0 = shapes0[PRODUCT_EXPECT] || 0;
    const prod1 = shapes1[PRODUCT_EXPECT] || 0;
    const anyIncrease = Object.values(deltas).some((v) => v > 0);
    log(`  after ${ticks} ticks: stored[${PRODUCT_EXPECT}] ${prod0} -> ${prod1}; all nonzero deltas = ${JSON.stringify(deltas)}`);

    // cleanup + audit
    log("\n[cleanup]");
    const reg = bbox(cells, 3);
    const dry = await cleanup([reg], { commit: false });
    log(`  would_delete=${dry.total_would_delete} types=${JSON.stringify(dry.plans[0].by_type)}`);
    await cleanup([reg], { commit: true });
    const wAudit = await newWorldBaseline();

    const belts = parts.filter((p) => p.kind === "belt");
    // Primary T3 gate = paste fidelity with machine neighbours (the redteam #4/R1 concern).
    // Delivery is measured and reported; a machine that lands perfectly but does not flow is a
    // separate finding (attributed to "machine", not "paste"), captured in product_delta.
    const pasteFidelity =
        xchk.all_match === true && site.clear === true && pd.applied_ok === true &&
        pd.intent_diff.length === 0 && mnr.machine_neighbors_count >= 1 &&
        !!(cornerGot && cornerGot.got && cornerGot.got.rv === 2 && cornerGot.got.code === 3) &&
        wAudit.pass === true;
    const pass = pasteFidelity && anyIncrease;

    writeResult(NAME, {
        test: "paste-machine",
        kind: "T3 — layout with a stacker machine + machine-adjacent corners (redteam #4 check2 / R1 / needs_live_test #2)",
        pass,
        paste_fidelity_gate: pasteFidelity,
        delivery_gate: anyIncrease,
        world: world.internal_id, seed, hub,
        stacker_origin: [sx, sy], stacker_cells: stackerCells, corner_cell: cornerCell, hub_entry: entry,
        product_shape: PRODUCT_EXPECT,
        offline_resource_check: xchk.rows,
        paste_site_clear: site.clear,
        blueprint: { entities: bp.entities.length, summary: bp.summary },
        paste_applied: pd.paste && pd.paste.applied, applied_ok: pd.applied_ok, failed: pd.failed,
        intent_diff: pd.intent_diff, readback: pd.readback,
        corner_land: cornerGot && cornerGot.got,
        machine_neighbors_count: mnr.machine_neighbors_count,
        machine_neighbor_detail: mnr.detail,
        belt_count: belts.length,
        product_before: prod0, product_after: prod1, product_delta: prod1 - prod0,
        all_shape_deltas: deltas,
        ticks_run: ticks, step_error: stepErr,
        new_world_audit: wAudit,
        conclusion: pasteFidelity
            ? "belts whose neighbours include a machine land at the designed (r,rv,code) — immutable paste + explicit rv defeats the computeBelt-from-machine-neighbour rewrite (R1 held for full-block paste; the validate script's drift was for INCREMENTAL place). Delivery: " + (anyIncrease ? `a shape increased by ${JSON.stringify(deltas)}` : "NO shape increased in " + ticks + " ticks — machine/flow issue, not a paste-fidelity failure.")
            : "machine-adjacent belt(s) deviated — see intent_diff; R1 (V3 fixed-point) is required for machine neighbours even under paste.",
        errors,
    });
    log(`\n=== ${pass ? "PASS" : "FAIL"} — offline=${xchk.all_match} clear=${site.clear} applied_ok=${pd.applied_ok} intent_diff=${pd.intent_diff.length} corner_rv=${cornerGot && cornerGot.got && cornerGot.got.rv} mnCount=${mnr.machine_neighbors_count} anyΔ=${anyIncrease} audit=${wAudit.pass} ===`);
}

function beltCodeOf(cell, parts) { const p = parts.find((q) => q.cell[0] === cell[0] && q.cell[1] === cell[1]); return p && p.code; }

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult(NAME, { test: "paste-machine", pass: false, fatal: e.message, rpc: e.rpc || null, errors });
    process.exit(1);
});
