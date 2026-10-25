/**
 * exp-tunnel-falsify.mjs — P0-1, part 2: try to BREAK the tunnel result.
 *
 * exp-tunnel-transport.mjs reported TUNNEL-WORKS. A single positive is not proof; the number
 * could come from the rig rather than the tunnel. This script attacks that result three ways.
 *
 * ── arm C: negative control ────────────────────────────────────────────────────
 *
 * The same rig, same miner, same downstream, but the gap has NO tunnel and NO belts:
 *
 *   miner ──► belt ──► belt │      (nothing)      │ belt ──► corner ──► hub
 *
 * Nothing can cross an empty gap. Expected delivery: 0. If this arm delivers, then the
 * sensor is lying or the hub is fed another way, and arm A's result is void.
 *
 * ── arm D: does our paste really protect belts under a tunnel? ─────────────────
 *
 * C4 says placing a receiver with `enableTunnelSmartplace` ON deletes same-direction belts
 * between it and its sender (systems/underground_belt.js:53-200). Our paste suspends that
 * setting (commit fbfe0fe). This arm builds belts in the gap FIRST, then pastes a tunnel
 * over them through the production path, and checks the belts survived.
 *
 * ── arm E: can that check go red? ──────────────────────────────────────────────
 *
 * Arm D is only meaningful if it is capable of failing. Arm E repeats the setup but places
 * the receiver with a plain `place` while smartplace is ON — the un-protected path. If the
 * belts survive there too, arm D proves nothing and C4 does not reproduce on this build.
 *
 * Usage: node research/ai-plan/live/exp-tunnel-falsify.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rpc, act, log } from "./kit.mjs";
import { encodeBlueprint } from "../../../src/shared/blueprint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const ROW_Y = 10;
const MINER = [-11, 10];
const TUNNEL = { sender: [-9, 10], receiver: [-5, 10] };
const GAP = [[-8, 10], [-7, 10], [-6, 10]];
const CORNER_X = -2;
const SETTLE = { chunk: 300, maxChunks: 14, stopAt: 8 };

async function main() {
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("no world loaded");

    const o = await rpc("obs", { max_entities: 5000, include_stats: false }, 120000);
    const hub = (o.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub");
    const dropY = hub.y + 4;
    log("hub", [hub.x, hub.y], "| bottom entry row y =", dropY);

    const settings0 = (await rpc("game_setting", {}, 15000)).settings;
    log("enableTunnelSmartplace:", settings0.enableTunnelSmartplace);

    const results = {};

    // ═══════════ arm C: negative control ═══════════
    log("\n=== ARM C: negative control — empty gap, no tunnel ===");
    await clearRig(dropY);
    const c = await runNegative(dropY);
    results.negative = c;
    await clearRig(dropY);

    // ═══════════ arm D: production paste must preserve gap belts ═══════════
    log("\n=== ARM D: pasting a tunnel over existing belts (production path) ===");
    await clearRig(dropY);
    // belts in the gap first, flowing east — exactly the belts C4 would delete
    const straight = solveTurn("left", "right");
    for (const [gx, gy] of GAP) {
        const r = await act({ op: "place", building: "belt", x: gx, y: gy, r: straight.rot });
        if (!r) log(`  ✗ pre-place belt (${gx},${gy})`);
    }
    const preGap = await bodiesAt(GAP);
    log("  gap belts present before paste:", preGap.length, "/", GAP.length);

    const d = await runPasteTunnel(dropY);
    const postGap = await bodiesAt(GAP);
    d.gapBefore = preGap.length;
    d.gapAfter = postGap.length;
    d.gapSurvived = postGap.length === GAP.length;
    log("  gap belts after paste:", postGap.length, "/", GAP.length, d.gapSurvived ? "✓ survived" : "✗ DELETED");
    results.pasteOverBelts = d;
    await clearRig(dropY);

    // ═══════════ arm E: the un-protected path must delete (proves D can fail) ═══════════
    log("\n=== ARM E: same setup, receiver placed with smartplace ON (un-protected) ===");
    await clearRig(dropY);
    for (const [gx, gy] of GAP) {
        const r = await act({ op: "place", building: "belt", x: gx, y: gy, r: straight.rot });
        if (!r) log(`  ✗ pre-place belt (${gx},${gy})`);
    }
    const preGap2 = await bodiesAt(GAP);
    log("  gap belts present before:", preGap2.length, "/", GAP.length);

    // sender first (plain place), then receiver — both with smartplace ON, as a player would
    const s = await act({ op: "place", building: "underground_belt", x: TUNNEL.sender[0], y: TUNNEL.sender[1], r: 90 });
    // point the receiver back at the sender: r=270 makes the game infer "receiver" facing east
    const rec = await act({ op: "place", building: "underground_belt", x: TUNNEL.receiver[0], y: TUNNEL.receiver[1], r: 270 });
    log("  sender placed:", s ? "yes" : "NO", "| receiver placed:", rec ? "yes" : "NO");

    const postGap2 = await bodiesAt(GAP);
    const codes = await codesAt([TUNNEL.sender, TUNNEL.receiver]);
    log("  tunnel codes:", JSON.stringify(codes));
    log("  gap belts after:", postGap2.length, "/", GAP.length, postGap2.length < GAP.length ? "✓ deleted (C4 reproduced)" : "✗ survived");
    results.unprotected = { gapBefore: preGap2.length, gapAfter: postGap2.length, deleted: postGap2.length < GAP.length, codes };
    await clearRig(dropY);

    const settings1 = (await rpc("game_setting", {}, 15000)).settings;

    // ── verdicts ──
    const negOk = c.delivered === 0;
    const protectOk = results.pasteOverBelts.gapSurvived === true;
    const redOk = results.unprotected.deleted === true;

    log("\n════════════════ RESULT ════════════════");
    log(`arm C negative control: delivered ${c.delivered} (want 0) — ${negOk ? "PASS" : "FAIL: the sensor fires without a tunnel"}`);
    log(`arm D production paste: gap belts ${results.pasteOverBelts.gapAfter}/${GAP.length} survived — ${protectOk ? "PASS" : "FAIL: smartplace was not suspended"}`);
    log(`arm E un-protected place: gap belts ${results.unprotected.gapAfter}/${GAP.length}, deleted=${results.unprotected.deleted} — ${redOk ? "PASS: the check can fail" : "INCONCLUSIVE: C4 did not reproduce, so arm D proves nothing"}`);
    log("smartplace after:", settings1.enableTunnelSmartplace);

    const record = {
        at: new Date().toISOString(),
        rig: { miner: MINER, rowY: ROW_Y, tunnel: TUNNEL, gap: GAP, cornerX: CORNER_X, dropY },
        negative: c,
        pasteOverBelts: results.pasteOverBelts,
        unprotected: results.unprotected,
        verdicts: { negativeControlOk: negOk, pasteProtects: protectOk, unProtectedDeletes: redOk },
    };
    const outDir = path.join(HERE, "results");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "tunnel-falsify.json");
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    log("record written to", outFile);

    return record;
}

/** place the rig WITHOUT a tunnel and WITHOUT belts in the gap. Expect zero delivery. */
async function runNegative(dropY) {
    const parts = [];
    const straight = solveTurn("left", "right");
    const [mx, my] = MINER;
    parts.push({ cell: [mx, my], code: 7, rot: 90 });
    parts.push({ cell: [mx + 1, my], code: straight.code, rot: straight.rot });
    parts.push({ cell: [TUNNEL.sender[0], my], code: straight.code, rot: straight.rot });   // belt where the sender would be
    // GAP INTENTIONALLY EMPTY
    parts.push({ cell: [TUNNEL.receiver[0], my], code: straight.code, rot: straight.rot });  // belt where the receiver would be
    for (let x = -4; x < CORNER_X; x++) parts.push({ cell: [x, my], code: straight.code, rot: straight.rot });
    const corner = solveTurn("left", "top");
    parts.push({ cell: [CORNER_X, my], code: corner.code, rot: corner.rot });
    const up = solveTurn("bottom", "top");
    for (let yy = my - 1; yy >= dropY; yy--) parts.push({ cell: [CORNER_X, yy], code: up.code, rot: up.rot });

    await pasteParts(parts, "C");
    return await measure(dropY, "C");
}

/** the production path: paste a tunnel blueprint that does NOT include the gap cells. */
async function runPasteTunnel(dropY) {
    const parts = [];
    const straight = solveTurn("left", "right");
    const up = solveTurn("bottom", "top");
    const corner = solveTurn("left", "top");
    const [mx, my] = MINER;

    parts.push({ cell: [mx, my], code: 7, rot: 90 });
    parts.push({ cell: [mx + 1, my], code: straight.code, rot: straight.rot });
    parts.push({ cell: [TUNNEL.sender[0], my], code: 22, rot: 90, kind: "tunnel_sender" });
    parts.push({ cell: [TUNNEL.receiver[0], my], code: 23, rot: 90, kind: "tunnel_receiver" });
    for (let x = -4; x < CORNER_X; x++) parts.push({ cell: [x, my], code: straight.code, rot: straight.rot });
    parts.push({ cell: [CORNER_X, my], code: corner.code, rot: corner.rot });
    for (let yy = my - 1; yy >= dropY; yy--) parts.push({ cell: [CORNER_X, yy], code: up.code, rot: up.rot });

    const res = await pasteParts(parts, "D");
    const m = await measure(dropY, "D");
    m.paste = res.paste ? { applied: res.paste.applied, tunnels: res.paste.tunnels } : null;
    return m;
}

async function pasteParts(parts, arm) {
    const minX = Math.min(...parts.map(p => p.cell[0]));
    const minY = Math.min(...parts.map(p => p.cell[1]));
    const entities = parts.map(p => ({ code: p.code, dx: p.cell[0] - minX, dy: p.cell[1] - minY, rot: p.rot }));
    const text = encodeBlueprint({ gv: "1.5.6", w: [minX, minY], entities });
    const dry = await rpc("act", { op: "paste_blueprint", text, x: minX, y: minY, dry_run: true, charge: false }, 60000);
    log(`  arm ${arm}: ${parts.length} cells, dry_run would_apply=${dry.would_apply} blocked=${dry.blocked.length}`);
    if (dry.blocked.length) {
        log("  BLOCKED:", JSON.stringify(dry.blocked.slice(0, 5)));
        throw new Error(`arm ${arm}: ${dry.blocked.length} blocked cells`);
    }
    const paste = await rpc("act", { op: "paste_blueprint", text, x: minX, y: minY, charge: false }, 60000);
    log(`  arm ${arm}: applied=${paste.applied}/${parts.length}` +
        (paste.tunnels ? ` smartplace_suspended=${paste.tunnels.smartplace_suspended}` : ""));
    return { dry, paste };
}

async function measure(dropY, arm) {
    const before = await copperStored();
    let delivered = 0;
    let ticks = 0;
    for (let i = 0; i < SETTLE.maxChunks; i++) {
        const s = await act({ op: "step", ticks: SETTLE.chunk });
        if (!s) break;
        ticks += s.ticks_run || 0;
        delivered = (await copperStored()) - before;
        if (delivered >= SETTLE.stopAt) break;
    }
    log(`  arm ${arm}: hub copper ${before} → ${before + delivered} (+${delivered}) in ${ticks} ticks`);
    return { delivered, ticksRun: ticks };
}

async function copperStored() {
    const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    return (o.hub && o.hub.stored_shapes && o.hub.stored_shapes["CuCuCuCu"]) || 0;
}

/** codes at the given cells (for confirming 22/23 landed). */
async function codesAt(cells) {
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const o = await rpc("obs", {
        region: [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1],
        max_entities: 500, include_stats: false,
    }, 60000);
    const m = new Map();
    for (const e of o.entities || []) m.set(`${e.x},${e.y}`, { code: e.code, type: e.type, rv: e.rotation_variant });
    return cells.map(c => ({ cell: c, at: m.get(`${c[0]},${c[1]}`) || null }));
}

/** which of these cells have any (non-hub) body on them */
async function bodiesAt(cells) {
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    const o = await rpc("obs", {
        region: [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1],
        max_entities: 500, include_stats: false,
    }, 60000);
    const m = new Map();
    for (const e of o.entities || []) m.set(`${e.x},${e.y}`, e);
    return cells.filter(c => m.has(`${c[0]},${c[1]}`)).map(c => m.get(`${c[0]},${c[1]}`));
}

async function clearRig(dropY) {
    const r = await rpc("act", {
        op: "bulk_delete", region: [MINER[0] - 1, dropY - 1, CORNER_X + 1, ROW_Y + 1], dry_run: false,
    }, 60000);
    return r.applied;
}

main()
    .then(r => {
        const v = r.verdicts;
        log("\nDONE");
        process.exitCode = v.negativeControlOk && v.pasteProtects && v.unProtectedDeletes ? 0 : 1;
    })
    .catch(e => { console.error("\nEXPERIMENT ERROR:", e.message); process.exitCode = 2; });
