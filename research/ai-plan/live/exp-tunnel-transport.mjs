/**
 * exp-tunnel-transport.mjs — P0-1: does an item actually TRAVEL THROUGH a tunnel?
 *
 * Every tunnel claim this project has made so far rests on source reading, save decoding and
 * stub tests. Not one run has shown an item enter one end and leave the other. "green ≠ true"
 * is the standing rule here, so this experiment is built to be able to FAIL, and its failure
 * must be distinguishable from "the rig never worked".
 *
 * ── the rig ────────────────────────────────────────────────────────────────────
 *
 *   miner ──► belt ──► sender ═══ 3 EMPTY CELLS ═══► receiver ──► belts ──► corner ──► hub
 *   (-11,10) (-10,10) (-9,10)   (-8,-7,-6)          (-5,10)      (-4,-3)   (-2,10)    (-2,2)
 *
 * The three cells between sender and receiver are deliberately LEFT EMPTY. That is the whole
 * experiment: a belt needs a solid chain, so with the gap empty there is NO belt-only path from
 * the miner to the hub. If items arrive anyway, they travelled through the tunnel.
 *
 * `findRecieverForSender` (systems/underground_belt.js:225-290) walks up to
 * undergroundBeltMaxTilesByTier[0] = 5 cells, `continue`s past empty tiles, and stops at a
 * second sender — so sender at x, receiver at x+4 is exactly the tier-1 maximum.
 *
 * ── the control arm ────────────────────────────────────────────────────────────
 *
 * The control is the SAME rig with the tunnel cells replaced by five plain belts flowing the
 * same direction. Every other cell — miner, belt into the tunnel, belts out, corner, drop,
 * hub entry — is byte-identical. So the only variable is the tunnel itself, and the control
 * failing means the rig is broken rather than the tunnel.
 *
 * The control is built and measured AFTER arm A is torn down, so the two delivery counts
 * cannot mix (the sensor is a monotonic counter).
 *
 * ── measurement ────────────────────────────────────────────────────────────────
 *
 * Sensor: `hub.stored_shapes["CuCuCuCu"]`, incremented once per item the hub accepts
 * (hub_goals.js:219-221 handleDefinitionDelivered). Read as a delta around each arm.
 *
 * Both arms are placed by `paste_blueprint` with explicit codes (22 sender / 23 receiver) —
 * the production path, so this also exercises the smartplace suspend added in fbfe0fe.
 *
 * Usage: node research/ai-plan/live/exp-tunnel-transport.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rpc, act, log } from "./kit.mjs";
import { encodeBlueprint } from "../../../src/shared/blueprint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CODE = { miner: 7, tunnelSender: 22, tunnelReceiver: 23 };

/** world-direction belt solver, mirroring src/ai/belt-rules.mjs (authoritative copy is there). */
const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rotateLocal = (local, rot) => ORDER[(ORDER.indexOf(local) + Math.round(rot / 90)) % 4];
function solveTurn(inDir, outDir) {
    for (let rot = 0; rot < 360; rot += 90) {
        for (const rv of [0, 1, 2]) {
            if (rotateLocal("bottom", rot) === inDir && rotateLocal(EXIT_LOCAL[rv], rot) === outDir) {
                return { rot, rv, code: 1 + rv };
            }
        }
    }
    throw new Error(`solveTurn(${inDir} → ${outDir}) has no solution`);
}

const SETTLE = { chunk: 300, maxChunks: 14, stopAt: 8 };
const ROW_Y = 10;
const MINER = [-11, 10];          // copper (live ore map: y=10 → x=-11,-10)
const TUNNEL = { sender: [-9, 10], receiver: [-5, 10] };
const CORNER_X = -2;              // must be a hub bottom entry column: hub.x .. hub.x+3
const HUB_ENTRY_Y_OFFSET = 4;     // belt at hub.y+4 flowing north feeds the hub's bottom slot

async function main() {
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("no world loaded; load or create a save first");
    log("status:", { tick: Math.round(st.tick), speed: st.speed, hub_level: st.hub_level });

    const o = await rpc("obs", { max_entities: 5000, include_stats: false }, 120000);
    const hub = (o.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub in this world");
    const dropY = hub.y + HUB_ENTRY_Y_OFFSET;
    log("hub at", [hub.x, hub.y], "— occupies", [hub.x, hub.y, hub.x + 3, hub.y + 3], "| bottom entries at y =", dropY);

    // ── preflight: the miner must stand on copper, and the row must be clear ──
    const ore = await rpc("obs", {
        region: [MINER[0] - 2, ROW_Y - 2, MINER[0] + 2, ROW_Y + 2],
        include_resources: true, max_resources: 5000, include_stats: false,
    }, 200000);
    const onOre = (ore.resources || []).find(r => r[0] === MINER[0] && r[1] === MINER[1]);
    log("ore under miner", [MINER[0], MINER[1]], "=", onOre ? onOre[2] : "NONE");
    if (!onOre) throw new Error(`no ore under the miner at ${MINER}`);

    if (CORNER_X < hub.x || CORNER_X > hub.x + 3) {
        throw new Error(`corner column ${CORNER_X} is not a hub bottom entry (needs ${hub.x}..${hub.x + 3})`);
    }

    const settingsBefore = (await rpc("game_setting", {}, 15000)).settings;
    log("enableTunnelSmartplace before:", settingsBefore.enableTunnelSmartplace);

    // ═══════════ arm A — the real question ═══════════
    log("\n=== ARM A: tunnel (3 empty cells between sender and receiver) ===");
    const a = await runArm("A", dropY, true);

    // tear A down completely so its deliveries cannot be counted as B's
    const torn = await rpc("act", {
        op: "bulk_delete", region: [MINER[0] - 1, dropY - 1, CORNER_X + 1, ROW_Y + 1], dry_run: false,
    }, 60000);
    log("arm A torn down:", torn.applied, "entities,", torn.failed.length, "failed");
    const leftover = await rpc("obs", {
        region: [MINER[0] - 1, dropY - 1, CORNER_X + 1, ROW_Y + 1], max_entities: 500, include_stats: false,
    }, 60000);
    const left = (leftover.entities || []).filter(e => e.type !== "hub");
    if (left.length) throw new Error(`arm A left ${left.length} entities behind: ` + JSON.stringify(left.slice(0, 5)));

    // ═══════════ arm B — the control ═══════════
    log("\n=== ARM B: control (plain belts on the tunnel cells) ===");
    const b = await runArm("B", dropY, false);

    const settingsAfter = (await rpc("game_setting", {}, 15000)).settings;
    const restored = settingsAfter.enableTunnelSmartplace === settingsBefore.enableTunnelSmartplace;

    // ── verdict: the control gates everything ──
    const controlOk = b.delivered >= 1;
    const tunnelOk = a.delivered >= 1;
    let verdict, why;
    if (!controlOk) {
        verdict = "INVALID";
        why = "the control arm delivered nothing, so the rig itself is broken and arm A proves nothing";
    } else if (!tunnelOk) {
        verdict = "TUNNEL-FAILED";
        why = "the control delivered but the tunnel arm did not — items do not cross the gap";
    } else {
        verdict = "TUNNEL-WORKS";
        why = "items crossed a 3-cell gap that no belt could have spanned";
    }

    log("\n════════════════ RESULT ════════════════");
    log(`arm A (tunnel)  delivered ${a.delivered} in ${a.ticksRun} ticks | ${a.matched}/${a.count} cells match, gap empty: ${a.gapEmpty}`);
    log(`arm B (control) delivered ${b.delivered} in ${b.ticksRun} ticks | ${b.matched}/${b.count} cells match`);
    log("enableTunnelSmartplace restored:", restored);
    log("VERDICT:", verdict, "—", why);

    const record = {
        at: new Date().toISOString(),
        game_version: st.game_version || null,
        hub: [hub.x, hub.y],
        rig: { miner: MINER, rowY: ROW_Y, tunnel: TUNNEL, cornerX: CORNER_X, dropY },
        armA: summarise(a),
        armB: summarise(b),
        settings: { before: settingsBefore, after: settingsAfter, restored },
        controlOk, tunnelOk, verdict, why,
    };
    const outDir = path.join(HERE, "results");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "tunnel-transport.json");
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    log("record written to", outFile);
    return record;
}

function summarise(r) {
    return {
        delivered: r.delivered,
        ticksRun: r.ticksRun,
        cellsPlanned: r.count,
        cellsMatched: r.matched,
        mismatches: r.bad,
        gapEmpty: r.gapEmpty,
        paste: r.paste ? { applied: r.paste.applied, failed: r.paste.failed, tunnels: r.paste.tunnels } : null,
        dry: r.dry ? { would_apply: r.dry.would_apply, blocked: r.dry.blocked, tunnels: r.dry.tunnels } : null,
    };
}

/**
 * Build one arm and measure how many items the hub accepts.
 * `withTunnel` swaps five belt cells for sender + 3 empty + receiver; everything else identical.
 */
async function runArm(name, dropY, withTunnel) {
    const [mx, my] = MINER;
    const y = ROW_Y;
    const parts = [];

    // miner: ejector is local "top"; at rot 90 that is world east
    parts.push({ cell: [mx, my], code: CODE.miner, rot: 90, kind: "miner" });

    // belt directly east of the miner — present in BOTH arms, so the miner handoff is controlled
    const straight = solveTurn("left", "right");
    parts.push({ cell: [mx + 1, y], code: straight.code, rot: straight.rot, kind: "belt" });

    if (withTunnel) {
        const [sx, sy] = TUNNEL.sender;
        const [rx, ry] = TUNNEL.receiver;
        // sender: rot 90 → accepts from the west, searches east for a receiver
        parts.push({ cell: [sx, sy], code: CODE.tunnelSender, rot: 90, kind: "tunnel_sender" });
        // receiver: same rotation, ejects east. cells between are NOT placed.
        parts.push({ cell: [rx, ry], code: CODE.tunnelReceiver, rot: 90, kind: "tunnel_receiver" });
        log(`  tunnel: sender (${sx},${sy}) → receiver (${rx},${ry}), ${rx - sx - 1} empty cells between`);
        for (let x = rx + 1; x < CORNER_X; x++) {
            parts.push({ cell: [x, y], code: straight.code, rot: straight.rot, kind: "belt" });
        }
    } else {
        for (let x = mx + 2; x < CORNER_X; x++) {
            parts.push({ cell: [x, y], code: straight.code, rot: straight.rot, kind: "belt" });
        }
    }

    // corner: arrives from the west, leaves north
    const corner = solveTurn("left", "top");
    parts.push({ cell: [CORNER_X, y], code: corner.code, rot: corner.rot, kind: "belt_corner" });

    // vertical run north into the hub's bottom entry cell
    const up = solveTurn("bottom", "top");
    for (let yy = y - 1; yy >= dropY; yy--) {
        parts.push({ cell: [CORNER_X, yy], code: up.code, rot: up.rot, kind: "belt" });
    }

    // ── anchor at the min corner, exactly as the mod's export does ──
    const minX = Math.min(...parts.map(p => p.cell[0]));
    const minY = Math.min(...parts.map(p => p.cell[1]));
    const entities = parts.map(p => ({ code: p.code, dx: p.cell[0] - minX, dy: p.cell[1] - minY, rot: p.rot }));
    const text = encodeBlueprint({ gv: "1.5.6", w: [minX, minY], entities });
    log(`  ${parts.length} cells, paste anchor (${minX},${minY})`);

    // ── dry run: never paste blind ──
    const dry = await rpc("act", { op: "paste_blueprint", text, x: minX, y: minY, dry_run: true, charge: false }, 60000);
    log(`  dry_run: would_apply=${dry.would_apply} blocked=${dry.blocked.length} tunnel_cells=${dry.tunnels ? dry.tunnels.in_plan : 0}`);
    if (dry.blocked.length) {
        log("  BLOCKED:", JSON.stringify(dry.blocked.slice(0, 5)));
        throw new Error(`arm ${name}: ${dry.blocked.length} cells blocked — site is not clear`);
    }
    if (dry.would_apply !== parts.length) {
        throw new Error(`arm ${name}: dry_run would_apply=${dry.would_apply} but the rig has ${parts.length} cells`);
    }

    // ── paste ──
    const paste = await rpc("act", { op: "paste_blueprint", text, x: minX, y: minY, charge: false }, 60000);
    log(`  paste: applied=${paste.applied}/${parts.length} failed=${paste.failed.length}` +
        (paste.tunnels ? ` tunnel_cells=${paste.tunnels.in_plan} smartplace_suspended=${paste.tunnels.smartplace_suspended}` : ""));

    // ── readback: what is actually on the ground, cell by cell ──
    const reg = [minX - 1, Math.min(minY, dropY) - 1, CORNER_X + 1, Math.max(y, dropY) + 1];
    const rb = await rpc("obs", { region: reg, max_entities: 20000, include_stats: false }, 120000);
    const byCell = new Map();
    for (const e of rb.entities || []) byCell.set(`${e.x},${e.y}`, e);
    const bad = [];
    for (const p of parts) {
        const got = byCell.get(`${p.cell[0]},${p.cell[1]}`);
        if (!got) { bad.push({ cell: p.cell, kind: p.kind, got: null }); continue; }
        if (got.code !== p.code || got.r !== p.rot) {
            bad.push({ cell: p.cell, kind: p.kind, want: { code: p.code, rot: p.rot }, got: { code: got.code, rot: got.r, rv: got.rotation_variant, type: got.type } });
        }
    }

    // The gap must really be empty — otherwise this is not testing a tunnel at all.
    let gapEmpty = null;
    if (withTunnel) {
        const [sx, sy] = TUNNEL.sender;
        const [rx] = TUNNEL.receiver;
        const leaked = [];
        for (let x = sx + 1; x < rx; x++) if (byCell.has(`${x},${sy}`)) leaked.push([x, sy]);
        gapEmpty = leaked.length === 0;
        if (!gapEmpty) log("  ⚠ the gap is NOT empty:", JSON.stringify(leaked));
    }

    // ── measure ──
    const storedBefore = await copperStored();
    let delivered = 0;
    let ticksRun = 0;
    for (let i = 0; i < SETTLE.maxChunks; i++) {
        const s = await act({ op: "step", ticks: SETTLE.chunk });
        if (!s) { log("  step failed:", JSON.stringify(act.lastError || null)); break; }
        ticksRun += s.ticks_run || 0;
        delivered = (await copperStored()) - storedBefore;
        if (delivered >= SETTLE.stopAt) break;
    }

    log(`  readback: ${parts.length - bad.length}/${parts.length} cells match` +
        (bad.length ? ` — MISMATCH ${JSON.stringify(bad.slice(0, 6))}` : "") +
        (gapEmpty === null ? "" : ` | gap empty: ${gapEmpty}`));
    log(`  measured: hub copper ${storedBefore} → ${storedBefore + delivered} (+${delivered}) over ${ticksRun} ticks`);

    return { name, delivered, ticksRun, count: parts.length, matched: parts.length - bad.length, bad, gapEmpty, paste, dry };
}

/** how many copper shapes the hub has accepted so far (the monotonic sensor). */
async function copperStored() {
    const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    return (o.hub && o.hub.stored_shapes && o.hub.stored_shapes["CuCuCuCu"]) || 0;
}

main()
    .then(r => {
        log("\nDONE");
        process.exitCode = r.verdict === "TUNNEL-WORKS" ? 0 : 1;
    })
    .catch(e => { console.error("\nEXPERIMENT ERROR:", e.message); process.exitCode = 2; });
