/**
 * exp-orig-flip.mjs — F2: redteam #3a / R2 — SZBP1 stride=4 drops originalRotation, so a belt
 * pasted at an explicit rv may be REWRITTEN by the game's later neighbour recalculation
 * (systems/belt.js:160 reads `originalRotation`, which for a paste equals `rotation`, bridge:814).
 * The paste itself is safe (immutable wrapper shields it — T2 proved that); the risk is the FIRST
 * post-paste neighbour perturbation.
 *
 * One corner at r0/rv2 is a single point in the space, and it turned out UNCHANGED for a real
 * reason (it already has a bottom ejector -> belt.js branch-1 is skipped, branch-2 returns the
 * same rv). To characterise the compiler's actual boundary we sweep a small MATRIX:
 *
 *   corner configs (rv/code from solveTurn):
 *     C00  bottom->right  = r0,  rv2, code3   (exp-e2e / "T2 同款")
 *     C270 right->bottom  = r270,rv1, code2   (a NON-zero rotation: bridge:814 forces orig=270)
 *     C180 top->left      = r180,rv2, code3
 *   perturbations applied AFTER the paste, to the corner's LEFT cell:
 *     EJECT  a belt flowing right (its ejector feeds INTO the corner from the left)
 *     PULL   a belt flowing left  (an acceptor pulling FROM the corner's left)
 *     NONE   control (re-observe only)
 *
 * For each cell we record corner before/after + the SAVED originalRotation, and classify
 * flip / unchanged. The compiler may rely on a pasted corner surviving incremental neighbours
 * ONLY for the cells that come back unchanged; any flip is live proof stride=5 / V3 is required.
 */
import {
    rpc, errors, ensureFreshWorld, ensureWindowAwake, snapshotSave, currentWorldUids,
    buildBlueprint, beltPart, pasteAndDiff, findClearSite, obsCellMap,
    newWorldBaseline, writeResult, log, bbox, cleanup, cellKey, saveNow, savesPath, decodeEntities,
    solveTurn, beltCode,
} from "./kit.mjs";

const NAME = "orig-flip";
const V = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const OPP = (d) => ({ top: "bottom", bottom: "top", left: "right", right: "left" }[d]);

/**
 * Minimal corner rig: a feed belt, the corner, an outlet belt — pasted as one block, sized by
 * solveTurn so the corner lands at its explicit (r,rv,code). Orientation verified against
 * belt-rules: cargo enters FROM inDir (source cell = corner + V[inDir]), leaves TOWARD outDir.
 *   feed  : beltPart(corner+V[in],      in,  OPP(in))   -> flows into the corner
 *   corner: beltPart([0,0],             in,  out)
 *   outlet: beltPart(corner+V[out],     OPP(out), out)  -> flows away from the corner
 */
function cornerConfig(inDir, outDir) {
    const feedCell = [V[inDir][0], V[inDir][1]];
    const outCell = [V[outDir][0], V[outDir][1]];
    const parts = [
        beltPart(feedCell, inDir, OPP(inDir)),
        beltPart([0, 0], inDir, outDir),
        beltPart(outCell, OPP(outDir), outDir),
    ];
    return { parts };
}

/** the 4-neighbour cells of the corner, preferring LEFT; the caller picks one the rig leaves free. */
function perturbCandidates(cornerWorld) {
    return ["left", "top", "bottom", "right"].map((d) => ({ side: d, cell: [cornerWorld[0] + V[d][0], cornerWorld[1] + V[d][1]] }));
}

async function runCell(tag, inDir, outDir, perturb) {
    const { parts } = cornerConfig(inDir, outDir);
    const want = solveTurn(inDir, outDir);
    const bp = buildBlueprint(parts);
    const minX = Math.min(...parts.map((p) => p.cell[0]));
    const minY = Math.min(...parts.map((p) => p.cell[1]));
    void minX; void minY; // corner is looked up by raw cell [0,0] below (robust to normalisation)

    const site = await findClearSite(bp.summary.bounds[0] + 2, bp.summary.bounds[1] + 2, { minDist: 220 });
    if (!site) return { tag, error: "no-clear-site" };
    const placed = bp.placeAt(site.anchor[0], site.anchor[1]);
    // the corner is the part whose RAW cell is [0,0] (cornerConfig puts it there); placeAt keeps p.cell raw
    const cornerWorld = placed.find((p) => p.cell[0] === 0 && p.cell[1] === 0).world;

    const pd = await pasteAndDiff(bp, site.anchor[0], site.anchor[1]);

    const win = [site.anchor[0] - 3, site.anchor[1] - 2, site.anchor[0] + 4, site.anchor[1] + 2];
    const { map: mb } = await obsCellMap(win);
    const before = mb.get(cellKey(cornerWorld[0], cornerWorld[1]));

    // saved originalRotation for that uid, read offline
    const sv = await saveNow();
    const dec = decodeEntities(savesPath(sv.internal_id));
    const rec = dec.rows.find((x) => x.uid === before.uid);
    const origSaved = rec ? rec.originalRotation : null;

    let perturbed = null;
    if (perturb !== "NONE") {
        const ANG = { top: 0, right: 90, bottom: 180, left: 270 };
        const cands = perturbCandidates(cornerWorld);
        const used = new Set(placed.map((p) => cellKey(p.world[0], p.world[1])));
        const free = cands.find((c) => !used.has(cellKey(c.cell[0], c.cell[1])));
        if (free) {
            const toward = OPP(free.side); // world dir from perturb cell into the corner
            const dirR = perturb === "EJECT" ? ANG[toward] : ANG[free.side]; // EJECT flows in, PULL flows out
            const r = await rpc("act", { op: "place", building: "belt", x: free.cell[0], y: free.cell[1], r: dirR });
            perturbed = { cell: free.cell, side: free.side, r: dirR, mode: perturb, uid: r && r.entity_uid };
        }
    }

    const { map: ma } = await obsCellMap([win[0] - 1, win[1], win[2], win[3]]);
    const after = ma.get(cellKey(cornerWorld[0], cornerWorld[1]));
    const same = before && after && before.r === after.r && before.rotation_variant === after.rotation_variant && before.code === after.code;

    const reg = bbox([...placed.map((p) => p.world), ...(perturbed ? [perturbed.cell] : [])], 3);
    await cleanup([reg], { commit: true });

    return {
        tag, inDir, outDir, want: { r: want.rotation, rv: want.rotationVariant, code: beltCode(want.rotationVariant) },
        anchor: site.anchor, corner_cell: cornerWorld,
        paste_intent_diff: pd.intent_diff, paste_applied: pd.paste && pd.paste.applied,
        corner_before: before && { r: before.r, rv: before.rotation_variant, code: before.code, uid: before.uid },
        corner_after: after && { r: after.r, rv: after.rotation_variant, code: after.code, uid: after.uid },
        saved_original_rotation: origSaved,
        perturbation: perturbed,
        outcome: !before || !after ? "indeterminate" : same ? "unchanged" : "flipped",
        same,
        region: reg,
    };
}

async function main() {
    const st = await rpc("status", {});
    log(`bridge ok: mod ${st.mod_version} game ${st.game_version}`);
    await ensureWindowAwake();
    const world = await ensureFreshWorld("orig-flip");
    const nwBase = await newWorldBaseline();
    log(`\n[world] ${world.internal_id} reused=${world.reused} base ${JSON.stringify(nwBase)}`);
    await snapshotSave("p7-" + NAME);

    const matrix = [];
    for (const [tag, i, o] of [
        ["C00-bottom->right", "bottom", "right"],
        ["C270-right->bottom", "right", "bottom"], // NON-zero rotation
        ["C180-top->left", "top", "left"],
    ]) {
        for (const perturb of ["NONE", "EJECT", "PULL"]) {
            log(`\n--- cell ${tag} / perturb ${perturb} ---`);
            const c = await runCell(tag + "/" + perturb, i, o, perturb);
            log(`  ${c.outcome || c.error}: before=${JSON.stringify(c.corner_before && { r: c.corner_before.r, rv: c.corner_before.rv, code: c.corner_before.code })} after=${JSON.stringify(c.corner_after && { r: c.corner_after.r, rv: c.corner_after.rv, code: c.corner_after.code })} orig=${c.saved_original_rotation}`);
            matrix.push(c);
        }
    }

    const wAudit = await newWorldBaseline();
    const cellsRan = matrix.filter((c) => c.outcome && c.outcome !== "indeterminate");
    const flips = cellsRan.filter((c) => c.outcome === "flipped");
    const ranClean = cellsRan.length === matrix.length && wAudit.pass === true;

    // Experiment "passes" when it ran cleanly and characterised the boundary; flips are a finding,
    // not a failure of the experiment. We flag compiler_reliance separately.
    const pass = ranClean && cellsRan.length > 0;

    writeResult(NAME, {
        test: "orig-flip",
        kind: "F2 — originalRotation dropped by SZBP1, matrix sweep (redteam #3a / R2 / needs_live_test #1)",
        pass,
        ran_clean: ranClean,
        world: world.internal_id,
        matrix,
        summary: {
            cells: matrix.length,
            unchanged: cellsRan.filter((c) => c.outcome === "unchanged").map((c) => c.tag),
            flipped: flips.map((c) => c.tag),
            control_unchanged: matrix.filter((c) => c.tag.endsWith("/NONE")).map((c) => ({ tag: c.tag, outcome: c.outcome, orig: c.saved_original_rotation })),
        },
        compiler_reliance: flips.length === 0
            ? "No pasted corner in this matrix (incl. a r=270/r=180 corner) was rewritten by a post-paste neighbour. For the tested corners the stored originalRotation happens to be a computeBelt fixed point, so R2 is LATENT, not active. Compiler MAY rely on whole-block paste surviving an adjacent belt — but ONLY for corner topologies like these; this is not a proof for all neighbours, so V3/stride=5 stays a hardening item, not a launch blocker."
            : `At least one corner FLIPPED on post-paste perturbation: ${JSON.stringify(flips.map((f) => f.tag))}. R2 is ACTIVE for incremental work: the compiler must paste whole blocks only (C2) and never add a neighbour to a pasted corner, or stride=5 must be adopted.`,
        mod_gap: "SZBP1 stride=4 does not store originalRotation; mod sets originalRotation=rotation on paste (bridge:814).",
        errors,
    });
    log(`\n=== ${pass ? "RAN CLEAN" : "PROBLEM"} — ${cellsRan.length} cells, flips=${flips.length} ${flips.length ? JSON.stringify(flips.map((f) => f.tag)) : "(no flip: R2 latent for tested corners)"} audit=${wAudit.pass} ===`);
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult(NAME, { test: "orig-flip", pass: false, fatal: e.message, rpc: e.rpc || null, errors });
    process.exit(1);
});
