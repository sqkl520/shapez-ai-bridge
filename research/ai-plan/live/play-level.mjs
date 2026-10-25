/**
 * play-level.mjs — play ONE level the way the user asked: look at the save, plan from it,
 * build, wait, verify.
 *
 * The point is not "does the compiler emit entities" — the offline suite already answers that.
 * The point is the loop a real player runs:
 *
 *   observe the save → compile against ITS seed and hub → dry-run the paste →
 *   paste → diff every cell → let the world run → did the hub actually accept the shape?
 *
 * Each stage can fail and says which one did. Nothing is assumed from the offline reports.
 *
 * Usage:
 *   node research/ai-plan/live/play-level.mjs --out <dir>        (default research/ai-plan/tmp/lvl2)
 *   node research/ai-plan/live/play-level.mjs --clean            (clear the build area first)
 */
import fs from "node:fs";
import path from "node:path";

import { rpc, act, log } from "./kit.mjs";

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = argOf("--out", "research/ai-plan/tmp/lvl2");
const CLEAN = args.includes("--clean");
const SETTLE = { chunk: 300, maxChunks: 20, stopWhenDelivered: 40 };

async function main() {
    // ── 1. observe the save ───────────────────────────────────────────────
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("no world loaded");
    const o = await rpc("obs", { max_entities: 5000, include_hub: true, include_stats: true }, 120000);
    const hub = (o.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub");
    const goal = o.goal;
    log("save:", { level: goal.level, shape: goal.requirement.shape, need: goal.requirement.required, have: goal.requirement.delivered });
    log("hub:", [hub.x, hub.y], "| entities already in world:", o.stats.total);

    // ── 2. the blueprint the compiler produced for THIS goal ──────────────
    const bpFile = path.join(OUT, `${goal.requirement.shape}.szbp.txt`);
    const intentFile = path.join(OUT, `${goal.requirement.shape}.intent.json`);
    if (!fs.existsSync(bpFile)) throw new Error(`no blueprint at ${bpFile} (compile first)`);
    const text = fs.readFileSync(bpFile, "utf8").trim();
    const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
    const anchor = intent.provenance.worldPlacement.pasteAt;
    log("blueprint:", bpFile, `${text.length} chars`, "| anchor", anchor);

    // ── 3. optional clean ────────────────────────────────────────────────
    if (CLEAN) {
        const r = intent.provenance.worldPlacement.worldFrameV1.worldRect;
        const pad = 2;
        const del = await rpc("act", {
            op: "bulk_delete",
            region: [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad],
            dry_run: false,
        }, 90000);
        log("cleaned:", del.applied, "entities from", [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]);
    }

    // ── 4. dry run: never paste blind ────────────────────────────────────
    const dry = await rpc("act", { op: "paste_blueprint", text, x: anchor[0], y: anchor[1], dry_run: true, charge: false }, 90000);
    log("dry_run:", { would_apply: dry.would_apply, blocked: dry.blocked.length, destroys: dry.destroys.length, unknown_code: dry.unknown_code.length });
    if (dry.blocked.length) {
        log("BLOCKED sample:", JSON.stringify(dry.blocked.slice(0, 5)));
        throw new Error(`${dry.blocked.length} cells blocked — site is not clear`);
    }

    // ── 5. paste ─────────────────────────────────────────────────────────
    const paste = await rpc("act", { op: "paste_blueprint", text, x: anchor[0], y: anchor[1], charge: false }, 120000);
    log("paste:", { applied: paste.applied, failed: paste.failed.length });
    if (paste.failed.length) log("  failures:", JSON.stringify(paste.failed.slice(0, 5)));

    // ── 6. diff every cell against the design ────────────────────────────
    const ents = intent.entities || [];
    const minX = Math.min(...ents.map(e => anchor[0] + e.dx));
    const maxX = Math.max(...ents.map(e => anchor[0] + e.dx));
    const minY = Math.min(...ents.map(e => anchor[1] + e.dy));
    const maxY = Math.max(...ents.map(e => anchor[1] + e.dy));
    const rb = await rpc("obs", { region: [minX - 2, minY - 2, maxX + 2, maxY + 2], max_entities: 20000, include_stats: false }, 120000);
    const byCell = new Map();
    for (const e of rb.entities || []) byCell.set(`${e.x},${e.y}`, e);
    const bad = [];
    for (const e of ents) {
        const wx = anchor[0] + e.dx, wy = anchor[1] + e.dy;
        const got = byCell.get(`${wx},${wy}`);
        if (!got) { bad.push({ cell: [wx, wy], want: e.code, got: null }); continue; }
        if (got.code !== e.code || got.r !== e.rot) {
            bad.push({ cell: [wx, wy], want: { code: e.code, rot: e.rot }, got: { code: got.code, rot: got.r } });
        }
    }
    log("readback:", `${ents.length - bad.length}/${ents.length} cells match` + (bad.length ? ` — ${JSON.stringify(bad.slice(0, 5))}` : ""));

    // ── 7. run the world and see if the hub accepts ──────────────────────
    const stored0 = await storedOf(goal.requirement.shape);
    let delivered = 0, ticks = 0;
    for (let i = 0; i < SETTLE.maxChunks; i++) {
        const s = await act({ op: "step", ticks: SETTLE.chunk });
        if (!s) { log("step failed"); break; }
        ticks += s.ticks_run || 0;
        const now = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
        if (now.goal.level !== goal.level) {
            log("LEVEL CHANGED during run:", goal.level, "->", now.goal.level);
            delivered = (now.hub.stored_shapes || {})[goal.requirement.shape] || 0;
            break;
        }
        delivered = storedOfSync(now, goal.requirement.shape);
        if (delivered >= SETTLE.stopWhenDelivered) break;
    }

    const finalObs = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    const finalLevel = finalObs.goal.level;
    const ok = finalLevel > goal.level || delivered >= goal.requirement.required;

    log("\n══════════ RESULT ══════════");
    log(`stored ${goal.requirement.shape}: ${stored0} → ${delivered} / need ${goal.requirement.required}`);
    log(`ticks run: ${ticks}${finalLevel !== goal.level ? `, LEVEL UP ${goal.level} → ${finalLevel}` : ""}`);
    log("VERDICT:", ok ? "LEVEL ADVANCED" : delivered > 0 ? "PRODUCING but not yet delivered enough" : "NO PRODUCTION");

    const record = {
        at: new Date().toISOString(),
        level: goal.level, shape: goal.requirement.shape, required: goal.requirement.required,
        anchor, entities: ents.length,
        dry, paste: { applied: paste.applied, failed: paste.failed },
        readback: { matched: ents.length - bad.length, total: ents.length, mismatches: bad },
        measured: { storedBefore: stored0, delivered, ticks, finalLevel },
        verdict: ok ? "LEVEL-ADVANCED" : delivered > 0 ? "PRODUCING" : "NO-PRODUCTION",
    };
    fs.writeFileSync(path.join(OUT, "play-result.json"), JSON.stringify(record, null, 2));
    log("record →", path.join(OUT, "play-result.json"));
    return record;
}

function storedOfSync(obs, shape) {
    return (obs.hub && obs.hub.stored_shapes && obs.hub.stored_shapes[shape]) || 0;
}
async function storedOf(shape) {
    const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
    return storedOfSync(o, shape);
}

main()
    .then(r => { log("\nDONE"); process.exitCode = r.verdict === "LEVEL-ADVANCED" ? 0 : 1; })
    .catch(e => { console.error("\nPLAY ERROR:", e.message); process.exitCode = 2; });
