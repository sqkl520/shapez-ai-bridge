/**
 * exp-belt-silent-overwrite.mjs — F1: the ONLY live evidence for redteam #3b / R3 —
 * paste silently DESTROYS replaceable belts it lands on, and reports NOTHING.
 *
 * Method (redteam needs_live_test #5):
 *   1. place_path a 5-cell belt line; record its 5 uids.
 *   2. snapshot the world (for forensics / recovery if the delete step ever misbehaves).
 *   3. paste a blueprint that OVERLAPS 2 of those belt cells.
 *   4. Assert the falsification:
 *        - the 2 old belt uids are GONE from the world
 *        - paste.ok === true, paste.failed does NOT mention those 2 cells, applied counts them
 *        => the mod gave no signal that it destroyed pre-existing belts.
 *   5. targeted-delete every cell this experiment touched, then bulk_delete dry_run + uid
 *      audit back to the pristine new-world baseline. (No snapshot_load: that state
 *      transition is slow and has wedged the session; the falsification is fully
 *      captured by then anyway.)
 *
 * This is deliberately destructive (it destroys belts) but ONLY inside the isolated P7 new save.
 * It is never run against level-11.
 */
import {
    rpc, errors, ensureFreshWorld, ensureWindowAwake, snapshotSave, currentWorldUids,
    buildBlueprint, beltPart, findClearSite, obsCellMap, isRectClear, newWorldBaseline,
    writeResult, log, bbox, cellKey, cleanup,
} from "./kit.mjs";

const NAME = "belt-silent-overwrite";

async function main() {
    const st = await rpc("status", {});
    log(`bridge ok: mod ${st.mod_version} game ${st.game_version}`);
    await ensureWindowAwake();
    log("\n[world] reuse/adopt P7 disposable new save ...");
    const world = await ensureFreshWorld("belt-silent-overwrite");
    const base = await newWorldBaseline();
    log(`  world ${world.internal_id} base ${JSON.stringify(base)}`);

    // a detached clear site wide+tall enough for a 5-belt line and a 3-belt overlapping paste
    const site = await findClearSite(9, 5, { minDist: 200 });
    if (!site) { writeResult(NAME, { test: "belt-silent-overwrite", pass: false, reason: "no-clear-site" }); return; }
    const [ax, ay] = site.anchor;
    log(`\n[site] ${ax},${ay} (detached, >200 from origin)`);

    // 1. snapshot BEFORE building: the restore must return to the pristine new-world baseline,
    //    not to "baseline + our belt line". (First run snapshotted after place_path and the
    //    audit correctly flagged 5 extra uids — that ordering mistake is what this fixes.)
    await snapshotSave("p7-" + NAME);

    // 2. place a horizontal 5-cell belt line at row ay, flowing right
    const line = [];
    for (let i = 0; i < 5; i++) line.push([ax + i, ay]);
    const pp = await rpc("act", { op: "place_path", building: "belt", from: line[0], to: line[4], r: 90 });
    log(`  place_path applied=${pp && pp.applied}`);
    const { map: before } = await obsCellMap([ax - 1, ay - 1, ax + 6, ay + 1]);
    const oldUids = line.map((c) => before.get(cellKey(c[0], c[1]))?.uid).filter(Boolean);
    log(`  original belt uids: ${JSON.stringify(oldUids)}`);

    // 3. blueprint: 2 belts that land exactly on line[2] and line[3], plus 1 belt on a free row.
    //    Build with world coordinates; buildBlueprint normalises the anchor, and placeAt maps back.
    const overlap = [line[2], line[3]];
    const pasteParts = [
        beltPart([line[2][0], ay - 1], "left", "right"), // free row, keeps the blueprint non-trivial
        beltPart([line[2][0], ay], "left", "right"), // -> line[2]
        beltPart([line[3][0], ay], "left", "right"), // -> line[3]
    ];
    const bp = buildBlueprint(pasteParts); // anchor = min corner of the three cells
    const placed = bp.placeAt(bp.anchor[0], bp.anchor[1]);
    const worldCells = placed.map((p) => p.world);
    const overlapHit = worldCells.filter((c) => overlap.some((o) => o[0] === c[0] && o[1] === c[1]));
    log(`\n[paste] blueprint world cells ${JSON.stringify(worldCells)} overlap ${overlapHit.length} of the line (want 2)`);
    // the free cell (row ay-1) must be empty before we start
    const freeCell = worldCells.find((c) => c[1] === ay - 1);
    const pv = await isRectClear([freeCell[0], freeCell[1], freeCell[0], freeCell[1]]);
    if (!pv.clear) log(`  ⚠ free cell ${JSON.stringify(freeCell)} not empty: ${JSON.stringify(pv.hits)}`);

    log(`  pasting at anchor ${JSON.stringify(bp.anchor)} (charge:false) ...`);
    const paste = await rpc("act", { op: "paste_blueprint", text: bp.text, x: bp.anchor[0], y: bp.anchor[1], charge: false });
    log(`  paste -> ok=${paste.ok} applied=${paste.applied} failed=${JSON.stringify(paste.failed)} warnings=${JSON.stringify(paste.warnings || null)}`);

    // 4. assertions
    const { map: after } = await obsCellMap([ax - 1, ay - 2, ax + 6, ay + 1]);
    const newUidAt2 = after.get(cellKey(overlap[0][0], overlap[0][1]))?.uid;
    const newUidAt3 = after.get(cellKey(overlap[1][0], overlap[1][1]))?.uid;
    const old2Gone = !oldUids.includes(newUidAt2);
    const old3Gone = !oldUids.includes(newUidAt3);
    const failedMentionsOverlap = (paste.failed || []).some((f) => overlap.some((o) => f.x === o[0] && f.y === o[1]));
    // did the destroy show up ANYWHERE in the response?
    const reported = JSON.stringify(paste);
    const mentionsDestroy = /destroy|replace|overwrite|removed|delet/i.test(reported);

    const falsified =
        paste.ok === true &&
        old2Gone && old3Gone && // old belts really got replaced
        paste.applied === bp.entities.length && // counted as placed, no penalty
        !failedMentionsOverlap && // not in failed
        !mentionsDestroy; // and no destroy reported at all

    log(`\n[assert] old@line[2] uid ${newUidAt2} replaced? ${old2Gone} ; old@line[3] ${newUidAt3} replaced? ${old3Gone}`);
    log(`         failed mentions overlap=${failedMentionsOverlap} ; response mentions destroy/replace=${mentionsDestroy}`);
    log(`         => paste silently destroyed 2 existing belts and reported ok:true with applied=${paste.applied} : ${falsified ? "CONFIRMED (R3 falsified 'paste reports overwrite')" : "NOT reproduced"}`);

    // 5. cleanup = targeted delete of EVERY cell this experiment touched (our 5-belt line, including
    //    its 3 survivors, plus the 3 pasted cells), then audit back to the pristine new-world baseline.
    //    No snapshot_load: the state transition it triggers is slow and has wedged the session before
    //    (see LIVE-LOG "World wedge"), and the falsification is already fully captured above.
    //    bulk_delete dry_run is the audit that proves the region came down to exactly the hub.
    log("\n[cleanup] targeted delete of all cells we touched ...");
    const allCells = [...line, ...worldCells];
    const delResults = [];
    for (const [x, y] of allCells) {
        try { const d = await rpc("act", { op: "delete", x, y }, 60000); delResults.push({ cell: [x, y], ok: !!(d && d.ok) }); }
        catch (e) { delResults.push({ cell: [x, y], ok: false, err: e.message }); }
    }
    const reg = bbox(allCells, 3);
    const dry = await cleanup([reg], { commit: false });
    log(`  deleted ${delResults.filter((d) => d.ok).length}/${allCells.length} cells; dry_run over ${JSON.stringify(reg)} still reports would_delete=${dry.total_would_delete} by_type=${JSON.stringify(dry.plans[0].by_type)}`);
    if (dry.total_would_delete > 0) await cleanup([reg], { commit: true });
    const wAudit = await newWorldBaseline();
    log(`  new-world audit after targeted cleanup: ${JSON.stringify(wAudit)}`);

    const pass = falsified && wAudit.pass === true;
    writeResult(NAME, {
        test: "belt-silent-overwrite",
        kind: "F1 — paste silently destroys replaceable belts, reports nothing (redteam #3b / R3 / needs_live_test #5)",
        pass,
        falsified_report_damages: falsified,
        world: world.internal_id,
        site: [ax, ay],
        line_cells: line,
        original_belt_uids: oldUids,
        paste: { ok: paste.ok, applied: paste.applied, count: bp.entities.length, failed: paste.failed, raw_keys: Object.keys(paste) },
        overlap_cells: [line[2], line[3]],
        new_uid_at_overlap: [newUidAt2, newUidAt3],
        old_belts_replaced: [old2Gone, old3Gone],
        failed_mentions_overlap: failedMentionsOverlap,
        response_mentions_destroy: mentionsDestroy,
        new_world_audit: wAudit,
        mod_gap: "paste_blueprint has no dry_run and does not report destroyed/replaced entities (MOD-GAPS).",
        errors,
    });
    log(`\n=== ${pass ? "PASS" : "FAIL"} — silent-overwrite-confirmed=${falsified} restore-audit=${wAudit.pass} ===`);
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult(NAME, { test: "belt-silent-overwrite", pass: false, fatal: e.message, rpc: e.rpc || null, errors });
    process.exit(1);
});
