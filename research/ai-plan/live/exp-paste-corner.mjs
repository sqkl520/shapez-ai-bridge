/**
 * exp-paste-corner.mjs — T2: new variable = ONE corner, tested against a contradicting neighbour.
 *
 * This is the RV-FIX falsification template (exp-rv-fix3.mjs) rebuilt with solveTurn-derived
 * cells and a per-cell intent_diff, targeting redteam #2 (belt half) / #3a / #1(1):
 *
 *   A standalone L corner: belt(bottom->top) -> corner(bottom->right, r0/rv2/code3) -> belt(left->right).
 *   Paste it TWICE onto obs-empty ground:
 *     ARM CLEAN:    nothing around the corner landing cell.
 *     ARM DISTURB:  BEFORE pasting, a right-flowing belt sits immediately LEFT of the corner's
 *                   landing cell. Its ejector feeds INTO the corner from the left, so the game's
 *                   auto-orient heuristic (belt.js:204-223, "hasLeftEjector") would rewrite the
 *                   corner to rv=1 (code 2) — UNLESS the immutable paste wrapper shields it.
 *
 *   Gate (computed in code): corner cell lands at the DESIGNED (r,rv,code) in BOTH arms, i.e.
 *   intent_diff.length === 0 for each. If DISTURB's corner flips code, immutable shielding has
 *   FAILED for a belt neighbour (this is the belt-against-machine mirror). We do NOT rely on
 *   delivery here — the corner-preservation is the whole point; the blueprint is detached.
 */
import {
    rpc, errors, ensureFreshWorld, ensureWindowAwake, snapshotSave, hubPosition, currentWorldUids,
    buildBlueprint, beltPart, pasteAndDiff, pasteSiteCheck, findClearSite, isRectClear,
    newWorldBaseline, writeResult, log, bbox, cleanup, DIRV, OPP, solveTurn, beltCode,
} from "./kit.mjs";

const NAME = "paste-corner";

/** the 3-cell standalone L: in "bottom", corner out "right". */
function cornerBlueprint() {
    // cells are relative; buildBlueprint normalises the anchor
    const parts = [
        beltPart([0, 2], "bottom", "top"), // vertical feed, flows up into the corner
        beltPart([0, 1], "bottom", "right"), // THE CORNER: in bottom, out right
        beltPart([1, 1], "left", "right"), // horizontal leg
    ];
    return { bp: buildBlueprint(parts), cornerRel: [0, 1] };
}

async function arm(label, { disturb, keepOut = [] }) {
    const { bp, cornerRel } = cornerBlueprint();
    const [bw, bh] = bp.summary.bounds;
    const site = await findClearSite(bw, bh, {
        minDist: 160, // detached build, keep it far from the (empty) hub too
        keepOut, // so the two arms never overlap
    });
    if (!site) return { label, error: "no-clear-site" };
    const [ax, ay] = site.anchor;
    const placed = bp.placeAt(ax, ay);
    const cornerCell = placed.find((p) => p.cell[0] === cornerRel[0] && p.cell[1] === cornerRel[1]).world;
    const want = { r: 0, rv: 2, code: 3 }; // solveTurn(bottom,right)

    // disturb: right-flowing belt at corner-(1,0), NOT a blueprint cell
    let disturbPlaced = null;
    if (disturb) {
        const dcell = [cornerCell[0] - 1, cornerCell[1]];
        const dchk = await isRectClear([dcell[0], dcell[1], dcell[0], dcell[1]]);
        if (!dchk.clear) return { label, error: "disturb-cell-occupied", dcell, hits: dchk.hits };
        const r = await rpc("act", { op: "place", building: "belt", x: dcell[0], y: dcell[1], r: 90 });
        disturbPlaced = { cell: dcell, uid: r && r.entity_uid, res: r };
    }

    // sanity: the blueprint's own cells (and disturb cell) must be clear before paste
    const cells = placed.map((p) => p.world);
    const site2 = await pasteSiteCheck(cells);
    const paste = await pasteAndDiff(bp, ax, ay);

    const cornerGot = paste.readback.find((r) => r.cell[0] === cornerCell[0] && r.cell[1] === cornerCell[1]);
    return {
        label, anchor: [ax, ay], want, cornerCell,
        disturb: disturbPlaced,
        site_clear_before: site2.clear, site_occupied: site2.occupied,
        paste_applied: paste.paste && paste.paste.applied,
        paste_count: paste.count, applied_ok: paste.applied_ok, failed: paste.failed,
        intent_diff: paste.intent_diff,
        corner_land: cornerGot && cornerGot.got,
        corner_preserved: !!(cornerGot && cornerGot.got && cornerGot.got.r === want.r && cornerGot.got.rv === want.rv && cornerGot.got.code === want.code),
        region: paste.region,
    };
}

async function main() {
    const st = await rpc("status", {});
    log(`bridge ok: mod ${st.mod_version} game ${st.game_version}`);
    await ensureWindowAwake();
    log("\n[world] reuse/adopt P7 disposable new save ...");
    const world = await ensureFreshWorld("paste-corner");
    const nwBase = await newWorldBaseline();
    log(`  world ${world.internal_id} reused=${world.reused} base ${JSON.stringify(nwBase)}`);

    log("\n[solveTurn] corner intent: " + JSON.stringify(solveTurn("bottom", "right")) + " code=" + beltCode(2));

    await snapshotSave("p7-" + NAME);
    log("\n=== ARM CLEAN (no neighbour) ===");
    const clean = await arm("clean", { disturb: false });
    log(`  corner ${JSON.stringify(clean.cornerCell)} landed ${JSON.stringify(clean.corner_land)} preserved=${clean.corner_preserved} intent_diff=${clean.intent_diff && clean.intent_diff.length}`);

    log("\n=== ARM DISTURB (contradicting belt to the left of the corner) ===");
    // keep the disturb site clear of the clean arm (live obs already rejects overlap, this is belt-and-braces)
    const keepOut = clean.region ? [clean.region[0] - 6, clean.region[1] - 6, clean.region[2] + 6, clean.region[3] + 6] : [];
    const dist = await arm("disturb", { disturb: true, keepOut: [keepOut] });
    log(`  corner ${JSON.stringify(dist.cornerCell)} landed ${JSON.stringify(dist.corner_land)} preserved=${dist.corner_preserved} intent_diff=${dist.intent_diff && dist.intent_diff.length}`);

    // cleanup both regions (dry_run first)
    log("\n[cleanup]");
    const regions = [clean.region, dist.region].filter(Boolean);
    const dry = await cleanup(regions, { commit: false });
    log(`  would_delete=${dry.total_would_delete} types=${dry.plans.map((p) => JSON.stringify(p.by_type))}`);
    await cleanup(regions, { commit: true });
    const wAudit = await newWorldBaseline();

    const pass =
        clean.corner_preserved === true && dist.corner_preserved === true &&
        clean.intent_diff && clean.intent_diff.length === 0 &&
        dist.intent_diff && dist.intent_diff.length === 0 &&
        wAudit.pass === true;

    writeResult(NAME, {
        test: "paste-corner",
        kind: "T2 — one corner vs a contradicting neighbour (redteam #2 belt-half / #1 / RV-FIX method)",
        pass,
        corner_intent: { in: "bottom", out: "right", r: 0, rv: 2, code: 3 },
        world: world.internal_id,
        clean: { anchor: clean.anchor, corner_land: clean.corner_land, corner_preserved: clean.corner_preserved, intent_diff: clean.intent_diff, applied_ok: clean.applied_ok, site_clear_before: clean.site_clear_before },
        disturb: { anchor: dist.anchor, disturb_cell: dist.disturb && dist.disturb.cell, corner_land: dist.corner_land, corner_preserved: dist.corner_preserved, intent_diff: dist.intent_diff, applied_ok: dist.applied_ok, site_clear_before: dist.site_clear_before },
        new_world_audit: wAudit,
        conclusion: pass
            ? "immutable paste wrapper shields the corner from a contradicting belt neighbour in both arms (redteam #2 belt-half CONFIRMED)."
            : "corner was NOT preserved — see which_arm in failures; immutable shielding insufficient for this topology.",
        errors,
    });
    log(`\n=== ${pass ? "PASS" : "FAIL"} — clean_preserved=${clean.corner_preserved} disturb_preserved=${dist.corner_preserved} audit=${wAudit.pass} ===`);
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult(NAME, { test: "paste-corner", pass: false, fatal: e.message, rpc: e.rpc || null, errors });
    process.exit(1);
});
