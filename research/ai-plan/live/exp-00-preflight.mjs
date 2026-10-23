/**
 * exp-00-preflight.mjs — establish that P7's ground truth holds before any experiment.
 *
 * Checks (all judged in code, written to results/preflight.json):
 *   1. bridge up, allow_write / allow_step true (read-only would stop the package)
 *   2. level-11 save loads and the world becomes live
 *   3. world uid set == snapshots/ai-research-base.bin uid set, uid-by-uid
 *      (expect 2805 / extra 0 / missing 0)
 *   4. the hub is where obs says it is, and offline seed predicts the CuCuCuCu we can
 *      cross-check in obs (foundation for T1's miner prediction)
 */
import {
    status, act, rpc, loadHome, waitInGame, assertWorldBaseline, hubPosition, hubEntries,
    currentWorldUids, homeBaseline, offlineTile, verifyOfflineResource, writeResult, log, errors,
} from "./kit.mjs";

async function main() {
    const s = await status();
    log(`bridge: mod ${s.mod_version} / game ${s.game_version} in_game=${s.in_game} allow_write=${s.allow_write} allow_step=${s.allow_step}`);
    if (s.allow_write === false || s.allow_step === false) {
        const r = { pass: false, reason: "read_only", status: s };
        writeResult("preflight", r);
        log("STOP: bridge/mod is in read-only mode — P7 cannot run. Not changing bridge.config.json.");
        return;
    }

    log("\n[1] load level-11 save ...");
    await loadHome();
    const st = await waitInGame(90);
    log(`  in_game=${st.in_game}`);

    log("\n[2] world audit vs baseline (uid-by-uid, offline decode) ...");
    const audit = await assertWorldBaseline();
    log(`  count=${audit.count} want=${audit.want} extra=${audit.extra} missing=${audit.missing} seed=${audit.seed} pass=${audit.pass}`);
    if (!audit.pass) {
        log(`  ⚠ extra_uids=${JSON.stringify(audit.extra_uids)} missing_uids=${JSON.stringify(audit.missing_uids)}`);
    }

    log("\n[3] hub + entries ...");
    const hub = await hubPosition();
    const ents = hubEntries(hub);
    log(`  hub origin=(${hub.x},${hub.y}) uid=${hub.uid}; 16 entries, e.g. ${JSON.stringify(ents.slice(8, 10))}`);

    log("\n[4] offline resource model vs live obs (level-11, 3 cells near hub) ...");
    const cand = [];
    for (let x = hub.x - 40; x <= hub.x + 40 && cand.length < 5; x++) {
        for (let y = hub.y - 40; y <= hub.y + 40 && cand.length < 5; y++) {
            if (offlineTile(audit.seed, x, y) === "CuCuCuCu") cand.push([x, y]);
        }
    }
    const xchk = await verifyOfflineResource(audit.seed, cand.slice(0, 3), "CuCuCuCu");
    log(`  predicted cells=${cand.length} sample=${JSON.stringify(xchk.rows)}`);

    const g = await rpc("obs", { max_entities: 1, include_hub: true });
    const pass = audit.pass && st.in_game === true && xchk.all_match && cand.length > 0;
    const res = {
        test: "preflight",
        pass,
        bridge: { mod_version: s.mod_version, game_version: s.game_version, allow_write: s.allow_write, allow_step: s.allow_step },
        world_audit: audit,
        hub,
        hub_entries_example: ents.slice(8, 10),
        offline_predictions_found: cand.length,
        resource_cross_check: xchk,
        goal: g.goal,
        hub_stored_shapes_nonzero: g.hub ? Object.entries(g.hub.stored_shapes).filter(([, v]) => v > 0).length : null,
        errors,
    };
    writeResult("preflight", res);
    log(`\n=== preflight ${pass ? "OK" : "NOT OK — see above"} ===`);
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult("preflight", { test: "preflight", pass: false, fatal: e.message, rpc: e.rpc || null });
    process.exit(1);
});
