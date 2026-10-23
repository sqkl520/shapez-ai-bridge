/**
 * exp-paste-l1.mjs — T1: the paste channel has never delivered end-to-end (redteam #5, level 1).
 *
 * The ONLY variable changed versus exp-e2e.mjs is the landing channel:
 *   exp-e2e: place/place_path  -> delivered (pass:true, facts/live/exp-e2e.result.json)
 *   this:    paste_blueprint(charge:false) on the SAME geometry -> must also deliver.
 * Blueprint hand-synthesised offline: src/ai/belt-rules.mjs (solveTurn/beltCode) +
 * src/shared/blueprint.mjs (encodeBlueprint). Same 16 hub entries, same miner-on-Cu rule.
 *
 * Why an L with one corner (not the brief's "2-3 straight belts"): a straight miner->entry
 * line needs a CuCuCuCu cell exactly on one of the 16 hub rays. Measured offline over 15
 * random seeds: the level-1 pre-seeded copper patch (chunk(-1,0), tiles ~(-14..-4,2..12)) is
 * off every ray, so the shortest Cu->hub route is ALWAYS an L. The corner is therefore not a
 * new variable at T1 (exp-e2e already had one); T2 adds the adversarial neighbour.
 *
 * Gate (all computed in code — the doc never flips it):
 *   offline_seed_predicted_cell_matches_obs === true
 *   paste.applied === entities.length
 *   intent_diff.length === 0
 *   await hub_delivered_increased .met === true
 *   delivered_after > delivered_before || level_after > level_before
 */
import {
    rpc, act, errors, ensureFreshWorld, ensureWindowAwake, snapshotSave, currentWorldUids, hubPosition,
    buildBlueprint, pasteAndDiff, isRectClear, verifyOfflineResource, goal, newWorldBaseline,
    writeResult, log, bbox, cleanup, DIRV,
} from "./kit.mjs";
import { planLRoutes } from "./routes.mjs";

const NAME = "paste-l1";
const SH = "CuCuCuCu";

async function main() {
    const st = await rpc("status", {});
    log(`bridge ok: mod ${st.mod_version} game ${st.game_version} allow_write=${st.allow_write}`);
    await ensureWindowAwake();

    log("\n[1] world: reuse/adopt the P7 disposable new save (never level-11) ...");
    const world = await ensureFreshWorld("paste-l1");
    const nwBase = newWorldBaseline();
    log(`  world ${world.internal_id} reused=${world.reused} pristine-baseline: ${JSON.stringify(nwBase)}`);

    const g0 = await goal();
    const hub = await hubPosition();
    log(`  level ${g0.goal.level} target ${g0.goal.requirement.shape} ${g0.goal.requirement.delivered}/${g0.goal.requirement.required}  hub=(${hub.x},${hub.y})`);

    log("\n[2] seed OFFLINE (save_now -> decode_full) ...");
    const w0 = await currentWorldUids();
    const seed = w0.seed;
    log(`  seed=${seed} entities=${w0.uids.size}`);

    log("\n[3] offline plan: shortest L route Cu -> hub side entry (every rv from solveTurn) ...");
    const routes = planLRoutes(seed, SH, hub, { minBelts: 2, maxBelts: 40 });
    if (!routes.length) { writeResult(NAME, { test: "paste-l1", pass: false, reason: "no-route", seed, hub }); return; }
    const R = routes[0];
    const cells = R.parts.map((p) => p.cell);
    log(`  miner=${JSON.stringify(R.miner)} entry=${JSON.stringify(R.entry.at)} side=${R.entry.side} belts=${R.belts} parts=${R.parts.length}`);
    log(`  corner(s): ${JSON.stringify(R.corners.map((c) => [c.cell, c.rot, c.rv, c.code]))}`);

    log("\n[4] cross-check offline prediction vs live obs on the miner cell ...");
    const xchk = await verifyOfflineResource(seed, [R.miner], SH);
    log(`  ${JSON.stringify(xchk.rows)}`);

    const bp = buildBlueprint(R.parts);
    log(`  blueprint entities=${bp.entities.length} anchor=${JSON.stringify(bp.anchor)} by_code=${JSON.stringify(bp.summary.by_code)}`);

    log("\n[5] landing box must be obs-empty (C1: paste silently destroys replaceable belts) ...");
    const need = bbox(cells, 2);
    const chk = await isRectClear(need);
    log(`  bbox ${JSON.stringify(need)} clear=${chk.clear} hits=${chk.hits.length}`);

    log("\n[6] snapshot the world, then paste (charge:false) at the planned anchor ...");
    await snapshotSave("p7-" + NAME);
    const gBefore = await goal();
    const before = { delivered: gBefore.goal.requirement.delivered, required: gBefore.goal.requirement.required, level: gBefore.goal.level };
    const storedBefore = (gBefore.hub && gBefore.hub.stored_shapes && gBefore.hub.stored_shapes[SH]) || 0;
    log(`  before: delivered=${before.delivered}/${before.required} level=${before.level} stored[Cu]=${storedBefore}`);

    const pd = await pasteAndDiff(bp, bp.anchor[0], bp.anchor[1]);
    log(`  paste applied=${pd.paste && pd.paste.applied}/${pd.count} failed=${JSON.stringify(pd.paste && pd.paste.failed)}`);
    log(`  intent_diff=${pd.intent_diff.length}`);
    if (pd.intent_diff.length) log(`  DIFF: ${JSON.stringify(pd.intent_diff.slice(0, 8))}`);

    log("\n[7] await hub_delivered_increased (timeout_ticks 15000) ...");
    let met = null, ticks_run = null, await_error = null, step_fallback = null;
    try {
        const w = await rpc("act", { op: "await", until: "hub_delivered_increased", timeout_ticks: 15000 }, 600000);
        met = w.met; ticks_run = w.ticks_run;
    } catch (e) {
        await_error = { message: e.message, code: e.code, codeName: e.codeName };
        log(`  await threw ${e.code}/${e.codeName}: ${e.message}`);
        if (e.code === 2002) {
            step_fallback = [];
            for (let i = 0; i < 15; i++) {
                try { const s = await rpc("act", { op: "step", ticks: 1200 }, 600000); step_fallback.push(s.ticks_run); }
                catch (e2) { log(`   step also blocked (${e2.code})`); break; }
                const gg = await goal();
                if (gg.goal.requirement.delivered > before.delivered || gg.goal.level > before.level) break;
            }
            ticks_run = step_fallback.reduce((a, b) => a + b, 0);
        }
    }
    const gAfter = await goal();
    const after = { delivered: gAfter.goal.requirement.delivered, required: gAfter.goal.requirement.required, level: gAfter.goal.level };
    const storedAfter = (gAfter.hub && gAfter.hub.stored_shapes && gAfter.hub.stored_shapes[SH]) || 0;
    log(`  met=${met} ticks=${ticks_run} after delivered=${after.delivered}/${after.required} level=${after.level} stored[Cu]Δ=${storedAfter - storedBefore}`);

    const deliveredIncreased = after.delivered > before.delivered;
    const levelIncreased = after.level > before.level;
    const pass =
        xchk.all_match === true && chk.clear === true && pd.applied_ok === true &&
        pd.intent_diff.length === 0 && met === true && (deliveredIncreased || levelIncreased);

    // cleanup our build, then audit the shared new world against its pristine baseline
    log("\n[cleanup] bulk_delete dry_run over our region, then delete ...");
    const dry = await cleanup([bbox(cells, 3)], { commit: false });
    log(`  would_delete=${dry.total_would_delete} by_type=${JSON.stringify(dry.plans[0] && dry.plans[0].by_type)}`);
    await cleanup([bbox(cells, 3)], { commit: true });
    const wAudit = await newWorldBaseline();
    log(`  new-world audit: ${JSON.stringify(wAudit)}`);

    writeResult(NAME, {
        test: "paste-l1",
        kind: "T1 — paste channel end-to-end delivery (redteam #5 L1 / needs_live_test #4)",
        pass,
        channel: "paste_blueprint(charge:false)",
        world: world.internal_id,
        seed, hub, goal_shape: g0.goal.requirement.shape,
        route: { miner: R.miner, entry: R.entry.at, side: R.entry.side, belts: R.belts,
                 corners: R.corners.map((c) => ({ cell: c.cell, r: c.rot, rv: c.rv, code: c.code })) },
        anchor: [bp.anchor[0], bp.anchor[1]], site_bbox: need, site_clear: chk.clear, site_hits: chk.hits.length,
        blueprint: { entities: bp.entities.length, chars: bp.text.length, summary: bp.summary },
        offline_seed_predicted_cell_matches_obs: xchk.all_match, offline_resource_check: xchk.rows,
        paste_applied: pd.paste ? pd.paste.applied : null, paste_count: pd.count, applied_ok: pd.applied_ok,
        failed: pd.failed, intent_diff: pd.intent_diff, readback: pd.readback,
        delivered_before: before.delivered, delivered_after: after.delivered,
        required_before: before.required, required_after: after.required,
        level_before: before.level, level_after: after.level,
        progress_form: levelIncreased ? "level-increased (L1 resets at 30)" : deliveredIncreased ? "delivered-increased" : "none",
        hub_stored_delta: storedAfter - storedBefore, met, ticks_run, await_error, await_step_fallback: step_fallback,
        new_world_audit: wAudit,
        errors,
    });
    log(`\n=== ${pass ? "PASS" : "FAIL"} — offline=${xchk.all_match} clear=${chk.clear} applied_ok=${pd.applied_ok} intent_diff=${pd.intent_diff.length} met=${met} progress=${deliveredIncreased || levelIncreased ? "yes" : "no"} ===`);
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult(NAME, { test: "paste-l1", pass: false, fatal: e.message, rpc: e.rpc || null, errors });
    process.exit(1);
});
