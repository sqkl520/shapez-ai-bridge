/**
 * kit.mjs — P7 `live` shared toolkit (real-machine verification package).
 *
 * Everything the five experiments need: rpc client, world observation,
 * offline save decoding, blueprint synthesis, per-cell intent diffing,
 * baseline auditing and cleanup.
 *
 * Ownership: this file lives in research/ai-plan/live/ (P7's own dir).
 * It imports ONLY:
 *   - src/ai/belt-rules.mjs      (authoritative belt math; the proto/ copy is a known-bad twin)
 *   - src/shared/blueprint.mjs   (SZBP1 container)
 *   - recon/decode_full.cjs      (offline save decode)
 *
 * Safety discipline (plan-compiler.md §4, compiler-constraints.md C1/C2/C8):
 *   - destructive experiments only in a NEW game; level-11 save is never pasted into
 *   - snapshot before touching the world; assert the world uid-by-uid afterwards
 *   - never paste onto non-empty ground (replaceable belts are destroyed silently, C1)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { solveTurn, beltCode, DIRV, OPP, angleToDir } from "../../../src/ai/belt-rules.mjs";
import { encodeBlueprint, decodeBlueprint, summarizeBlueprint } from "../../../src/shared/blueprint.mjs";

const require = createRequire(import.meta.url);
const { decodeSave } = require("../../../recon/decode_full.cjs");

// ───────────────────────────── constants ─────────────────────────────

export const BASE = "http://127.0.0.1:7777";

/** level-11 save: the world every experiment must return to, plus its snapshot. */
export const HOME_INTERNAL_ID = "5c96706563c0b74c4d2ce4c7f8bf7a244392de89";
export const HOME_SNAPSHOT = "ai-research-base";
export const HOME_BASELINE_COUNT = 2805;

/** building codes, live-extracted (facts/building-codes-live.json). Belt: beltCode(rv) = 1+rv. */
export const CODE = {
    belt: 1, // +rv  => 1 straight / 2 left curve / 3 right curve
    miner: 7,
    stacker: 14,
    trash: 20,
};

export const MIN_SITE_DIST = 150; // experiments land >150 cells from origin
export const GV = "1.5.6"; // blueprint payload gv; mismatch => rpc 2006

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SNAPDIR = path.join(ROOT, "snapshots");
const RESULTS = path.join(import.meta.dirname, "results");
const SAVES_DIR = path.join(process.env.APPDATA || "", "shapez.io", "saves");

// ───────────────────────────── rpc plumbing ─────────────────────────────

let rpcId = 1;
export const errors = [];

export async function rpc(method, params = {}, timeoutMs = 300000) {
    const res = await fetch(BASE + "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) {
        const e = new Error(`${method}: ${body.error.message}`);
        e.rpc = body.error;
        e.code = body.error.code;
        e.codeName = body.error.data && body.error.data.code_name;
        throw e;
    }
    return body.result;
}

/** act() that never throws: records the failure and returns null (so a step of a
 *  multi-step build can be reported without aborting the whole experiment). */
export async function act(action) {
    try {
        return await rpc("act", action);
    } catch (e) {
        errors.push({ action, message: e.message, code: e.code, codeName: e.codeName });
        return null;
    }
}

export const log = (...a) => console.log(...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** true when the error is the "world paused by an overlay" rejection (2002 from step). */
export function isOverlayBlocked(e) {
    return !!e && (e.code === 2002 || e.codeName === "game_rejected");
}

// ───────────────────────────── game state ─────────────────────────────

export async function status() {
    return rpc("status", {}, 15000);
}

/** entering a world is slow on this machine (~2-3 min measured); wait generously. */
export async function waitInGame(maxSeconds = 360) {
    for (let i = 0; i < maxSeconds; i++) {
        const s = await status();
        if (s.in_game) return s;
        await sleep(1000);
    }
    throw new Error(`never entered the game within ${maxSeconds}s`);
}

/** start a fresh regular-mode save — the only place destructive experiments may run. */
export async function newGame() {
    await rpc("new_game", { game_mode: "regularMode" });
    return waitInGame();
}

export async function loadHome() {
    await rpc("load_save", { internal_id: HOME_INTERNAL_ID });
    return waitInGame();
}

const WORLD_FILE = "world.json";

/**
 * shapez drives its InGameState transition off requestAnimationFrame. If the game window is
 * minimized, no frames pump, `gameStarted` never fires, and mod.root stays null — every world
 * call returns 1003 while `status` still answers (it only needs mod JS). P7 exclusively owns
 * this process, so it re-asserts the window is restored before touching the world.
 * Reversible and non-destructive (ShowWindow restore only); never kills or restarts the game.
 */
export async function ensureWindowAwake() {
    if (process.platform !== "win32") return { skipped: "non-win32" };
    const { execFileSync } = await import("node:child_process");
    const ps = [
        "Add-Type @'",
        'using System;using System.Runtime.InteropServices;',
        'public class W{[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);',
        '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);',
        '[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}',
        "'@",
        "$p=Get-Process shapezio -ErrorAction SilentlyContinue|?{$_.MainWindowHandle -ne 0}|Select -First 1",
        "if($p){$h=$p.MainWindowHandle;$i=[W]::IsIconic($h);if($i){[void][W]::ShowWindow($h,9)};[void][W]::ShowWindow($h,5);[void][W]::SetForegroundWindow($h);Write-Output ($i)}",
    ].join("\n");
    try {
        const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { timeout: 20000, encoding: "utf8" }).trim();
        return { wasIconic: out === "True", restored: out === "True" };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Ensure a disposable new-game world is live, and REUSE it if it already is.
 *
 * Why reuse: every `new_game`/`load_save` is a client-side state transition gated on render
 * frames (see ensureWindowAwake). Retrying blindly burns save slots and wedge exposure. The
 * five experiments share ONE isolated new save, each taking its own snapshot and cleaning its
 * own region; the level-11 world is touched once, at the end, for the final audit.
 * The record of "our" save lives in results/world.json.
 */
export async function ensureFreshWorld(label = "") {
    await ensureWindowAwake();
    let recorded = null;
    try {
        recorded = JSON.parse(fs.readFileSync(path.join(RESULTS, WORLD_FILE), "utf8"));
    } catch { /* first run */ }

    const s = await status();
    if (s.in_game) {
        const sv = await saveNow();
        if (recorded && recorded.internal_id === sv.internal_id) {
            log(`  [world] reusing the p7 new save ${sv.internal_id} (${label})`);
            return { reused: true, internal_id: sv.internal_id, level: sv.level };
        }
        if (!recorded) {
            // a fresh save we just created but haven't recorded yet (e.g. resumed after a wedge)
            fs.mkdirSync(RESULTS, { recursive: true });
            fs.writeFileSync(
                path.join(RESULTS, WORLD_FILE),
                JSON.stringify({ internal_id: sv.internal_id, created: new Date().toISOString(), level: sv.level, adopted: true }, null, 1)
            );
            log(`  [world] adopting the live level-${sv.level} save ${sv.internal_id} (${label})`);
            return { reused: true, adopted: true, internal_id: sv.internal_id, level: sv.level };
        }
    }
    log(`  [world] creating a new regularMode save (${label}) ...`);
    await newGame();
    const sv = await saveNow();
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(
        path.join(RESULTS, WORLD_FILE),
        JSON.stringify({ internal_id: sv.internal_id, created: new Date().toISOString(), level: sv.level }, null, 1)
    );
    log(`  [world] new save ${sv.internal_id} live`);
    return { reused: false, internal_id: sv.internal_id, level: sv.level };
}

/** baseline of the shared p7 new world: every uid present right after creation, per region. */
export async function newWorldBaseline(file = "new-world-baseline.json") {
    const cur = await currentWorldUids();
    const p = path.join(RESULTS, file);
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify({ uids: [...cur.uids], seed: cur.seed, internal_id: cur.internal_id }, null, 1));
        return { created: true, count: cur.uids.size, seed: cur.seed };
    }
    const base = JSON.parse(fs.readFileSync(p, "utf8"));
    const B = new Set(base.uids);
    const extra = [...cur.uids].filter((u) => !B.has(u));
    const missing = base.uids.filter((u) => !cur.uids.has(u));
    return { created: false, count: cur.uids.size, want: base.uids.length, extra: extra.length, missing: missing.length, extra_uids: extra.slice(0, 40), missing_uids: missing.slice(0, 40), pass: extra.length === 0 && missing.length === 0 };
}

/** full observation of one region (loops if truncated). */
export async function obsFull(params = {}) {
    const out = [];
    let truncated = true;
    let guard = 0;
    let obs = null;
    while (truncated && guard++ < 50) {
        obs = await rpc("obs", { ...params, max_entities: 50000 }, 300000);
        truncated = obs.truncated === true;
        out.push(...(obs.entities || []));
        if (!truncated) return Object.assign({}, obs, { entities: out, truncated: false });
        // truncated with max_entities 50000 => mod settings cap; keep what we got and say so
        return Object.assign({}, obs, { entities: out, truncated: true });
    }
    return Object.assign({}, obs, { entities: out });
}

/** Map "x,y" -> entity for a region. Multi-tile buildings appear under their ORIGIN only. */
export async function obsCellMap(region) {
    const o = await rpc("obs", { region, max_entities: 20000, include_stats: false }, 300000);
    const m = new Map();
    for (const e of o.entities || []) m.set(`${e.x},${e.y}`, e);
    return { map: m, raw: o, truncated: o.truncated === true };
}

/** every cell a region touches, including entities whose footprint reaches in from outside. */
export async function obsOccupied(region) {
    const pad = 4; // hub is 4x4; an origin up to 3 cells outside can still cover a cell
    const inflated = [region[0] - pad, region[1] - pad, region[2] + pad, region[3] + pad];
    const o = await rpc("obs", { region: inflated, max_entities: 20000, include_stats: false }, 300000);
    const cells = new Map(); // "x,y" -> entity owning that cell
    for (const e of o.entities || []) {
        // r=0 footprints only (v1 never rotates a machine): stacker/cutter 2x1, hub 4x4
        const w = e.type === "hub" ? 4 : e.type === "stacker" || e.type === "cutter" || e.type === "mixer" || e.type === "painter" ? 2 : 1;
        const h = e.type === "hub" ? 4 : 1;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) cells.set(`${e.x + dx},${e.y + dy}`, e);
    }
    return cells;
}

/** is a rectangle completely free? (obs-measured, never a static snapshot) */
export async function isRectClear(rect) {
    const cells = await obsOccupied(rect);
    const hits = [];
    for (let x = rect[0]; x <= rect[2]; x++)
        for (let y = rect[1]; y <= rect[3]; y++) {
            const e = cells.get(`${x},${y}`);
            if (e) hits.push({ cell: [x, y], entity: e });
        }
    return { clear: hits.length === 0, hits, region: rect };
}

/**
 * The REAL C1 pre-paste check: are the exact cells we are about to paste onto empty?
 * A padded bbox may sweep the hub/machines the route legitimately sits next to, so we test
 * the pasted cells themselves, and separately classify any occupant as solid (abort) vs
 * replaceable belt (would be silently destroyed — also abort for v1).
 * @returns {{clear:boolean, occupied:Array, solid:Array, replaceable:Array}}
 */
export async function pasteSiteCheck(cells) {
    const region = bbox(cells, 4);
    const occ = await obsOccupied(region);
    const occupied = [];
    for (const [x, y] of cells) {
        const e = occ.get(cellKey(x, y));
        if (e) occupied.push({ cell: [x, y], type: e.type, code: e.code });
    }
    const REPLACEABLE = new Set(["belt", "wire"]);
    return {
        clear: occupied.length === 0,
        occupied,
        solid: occupied.filter((o) => !REPLACEABLE.has(o.type)),
        replaceable: occupied.filter((o) => REPLACEABLE.has(o.type)),
    };
}

export function cellKey(x, y) {
    return `${x},${y}`;
}

// ─────────────────────────── offline save decode ───────────────────────────

export function savesPath(internalId) {
    return path.join(SAVES_DIR, `savegame-${internalId}.bin`);
}

export async function saveNow() {
    return rpc("save_now", {}, 300000);
}

export async function snapshotSave(name) {
    return rpc("snapshot_save", { name }, 300000);
}

export async function snapshotLoad(name) {
    return rpc("snapshot_load", { name }, 300000);
}

/** decode a snapshot/save file into the things we audit: uid set, entity rows, seed. */
export function decodeEntities(file) {
    const { obj } = decodeSave(file);
    const ents = obj.dump.entities || [];
    const rows = [];
    for (const e of ents) {
        const sme = e.components && e.components.StaticMapEntity;
        if (!sme) continue;
        rows.push({
            uid: e.uid,
            x: sme.origin ? sme.origin.x : null,
            y: sme.origin ? sme.origin.y : null,
            rotation: sme.rotation,
            originalRotation: sme.originalRotation,
            code: sme.code,
        });
    }
    return { rows, uids: new Set(rows.map((r) => r.uid)), seed: obj.dump.map ? obj.dump.map.seed : null };
}

export function snapshotPath(name) {
    return path.join(SNAPDIR, `${name}.bin`);
}

/** uid set of the current world, read OFFLINE (save_now + decode) — the audit source of truth. */
export async function currentWorldUids() {
    const sv = await saveNow();
    const file = savesPath(sv.internal_id);
    if (!fs.existsSync(file)) throw new Error(`save file missing: ${file}`);
    const d = decodeEntities(file);
    return { ...d, internal_id: sv.internal_id, level: sv.level };
}

let _baselineCache = null;
export function homeBaseline() {
    if (_baselineCache) return _baselineCache;
    const file = snapshotPath(HOME_SNAPSHOT);
    if (!fs.existsSync(file)) throw new Error(`baseline snapshot missing: ${file}`);
    _baselineCache = decodeEntities(file);
    return _baselineCache;
}

/**
 * uid-by-uid diff of the live world against the level-11 baseline.
 * Returns {pass, extra, missing, extra_uids, missing_uids, count, want}.
 * `pass` is computed here, by comparing sets — no document can talk it into being true.
 */
export async function assertWorldBaseline() {
    const cur = await currentWorldUids();
    const base = homeBaseline();
    const extra = [...cur.uids].filter((u) => !base.uids.has(u)).sort((a, b) => a - b);
    const missing = [...base.uids].filter((u) => !cur.uids.has(u)).sort((a, b) => a - b);
    return {
        pass: extra.length === 0 && missing.length === 0 && cur.uids.size === base.uids.size,
        count: cur.uids.size,
        want: base.uids.size,
        extra: extra.length,
        missing: missing.length,
        extra_uids: extra.slice(0, 50),
        missing_uids: missing.slice(0, 50),
        seed: cur.seed,
        internal_id: cur.internal_id,
    };
}

// ───────────────────────────── goal / hub ─────────────────────────────

export async function goal(includeHub = true) {
    const o = await rpc("obs", { max_entities: 1, include_hub: includeHub }, 60000);
    return { goal: o.goal, hub: o.hub, tick: o.tick, total: o.stats ? o.stats.total : o.entity_count };
}

export async function hubPosition() {
    const o = await rpc("obs", { max_entities: 5000, include_stats: false }, 120000);
    const hub = (o.entities || []).find((e) => e.type === "hub");
    if (!hub) throw new Error("no hub entity found");
    return { x: hub.x, y: hub.y, uid: hub.uid };
}

/**
 * hub's 16 entry cells. A belt's LAST cell sits at `at` and flows in direction `dir`
 * into the hub slot behind it (buildings/hub.js:73-91; exp-e2e.mjs:93-102).
 */
export function hubEntries(hub) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        out.push({ at: [hub.x + i, hub.y - 1], dir: 180, side: "top", slot: [i, 0] });
        out.push({ at: [hub.x + i, hub.y + 4], dir: 0, side: "bottom", slot: [i, 3] });
        out.push({ at: [hub.x - 1, hub.y + i], dir: 90, side: "left", slot: [0, i] });
        out.push({ at: [hub.x + 4, hub.y + i], dir: 270, side: "right", slot: [3, i] });
    }
    return out;
}

// ───────────────────────── blueprint synthesis ─────────────────────────

/**
 * A part is {kind, cell:[x,y], rot, rv, code, inDir, outDir, ...}.
 * buildBlueprint(parts) normalises the anchor to the min corner (same rule as the
 * mod's export_blueprint, bridge:1470-1476) and emits SZBP1 text.
 */
export function buildBlueprint(parts) {
    const minX = Math.min(...parts.map((p) => p.cell[0]));
    const minY = Math.min(...parts.map((p) => p.cell[1]));
    const entities = parts.map((p) => ({ code: p.code, dx: p.cell[0] - minX, dy: p.cell[1] - minY, rot: p.rot }));
    const text = encodeBlueprint({ gv: GV, w: [minX, minY], entities });
    return {
        text,
        anchor: [minX, minY],
        entities,
        parts,
        summary: summarizeBlueprint(text),
        // the world position of a blueprint cell, given a paste (x,y)
        placeAt: (px, py) => parts.map((p) => ({ ...p, world: [px + (p.cell[0] - minX), py + (p.cell[1] - minY)] })),
    };
}

/** belt part with explicit (r,rv) solved offline from the world in/out directions. */
export function beltPart(cell, inDir, outDir) {
    const s = solveTurn(inDir, outDir);
    if (!s) throw new Error(`solveTurn(${inDir},${outDir}) has no solution @ ${cell}`);
    return {
        kind: "belt",
        cell,
        rot: s.rotation,
        rv: s.rotationVariant,
        code: beltCode(s.rotationVariant),
        inDir,
        outDir,
        corner: inDir !== OPP[outDir] ? true : false, // entry/exit not opposite => it is a turn
    };
}

/** straight run of belts from `from` to `to` (inclusive), all flowing in `dir`. */
export function beltRun(from, to, dir) {
    const [ddx, ddy] = DIRV[dir];
    const parts = [];
    if (ddx !== 0) {
        const n = Math.abs(to[0] - from[0]);
        for (let i = 0; i <= n; i++) parts.push(beltPart([from[0] + ddx * i, from[1]], OPP[dir], dir));
    } else {
        const n = Math.abs(to[1] - from[1]);
        for (let i = 0; i <= n; i++) parts.push(beltPart([from[0], from[1] + ddy * i], OPP[dir], dir));
    }
    return parts;
}

export function minerPart(cell, outDir) {
    // miner ejector is local top (buildings/miner.js:82-84) => world outDir = rotateLocal(top, rot)
    return { kind: "miner", cell, rot: dirToRot(outDir), rv: 0, code: CODE.miner, inDir: null, outDir };
}

export function dirToRot(dir) {
    return { top: 0, right: 90, bottom: 180, left: 270 }[dir];
}

export function trashPart(cell) {
    return { kind: "trash", cell, rot: 0, rv: 0, code: CODE.trash, inDir: null, outDir: null };
}

/** generic machine part at r=0 rv=0 (v1 never rotates machines, decision D1). */
export function machinePart(kind, cell) {
    const code = CODE[kind];
    if (code === undefined) throw new Error(`machinePart: no code for ${kind}`);
    return { kind, cell, rot: 0, rv: 0, code, inDir: null, outDir: null };
}

// ─────────────────────────── paste + intent diff ───────────────────────────

/**
 * paste a blueprint and diff EVERY cell against the design.
 * intent_diff is an ARRAY of {cell, want, got} — failure detail is worth more than a green light.
 */
export async function pasteAndDiff(bp, x, y, opts = {}) {
    const parts = bp.placeAt(x, y);
    const res = await act({ op: "paste_blueprint", text: bp.text, x, y, charge: opts.charge === undefined ? false : opts.charge });
    const region = [
        Math.min(...parts.map((p) => p.world[0])) - 1,
        Math.min(...parts.map((p) => p.world[1])) - 1,
        Math.max(...parts.map((p) => p.world[0])) + 1,
        Math.max(...parts.map((p) => p.world[1])) + 1,
    ];
    const { map } = await obsCellMap(region);
    const intent_diff = [];
    const readback = [];
    for (const p of parts) {
        const got0 = map.get(cellKey(p.world[0], p.world[1]));
        const got = got0
            ? { r: got0.r, rv: got0.rotation_variant, code: got0.code, type: got0.type, uid: got0.uid }
            : null;
        readback.push({ cell: p.world, kind: p.kind, want: wantOf(p), got });
        if (!got || got.r !== p.rot || got.rv !== p.rv || got.code !== p.code) {
            intent_diff.push({ cell: p.world, kind: p.kind, want: wantOf(p), got });
        }
    }
    return {
        paste: res,
        applied_ok: !!res && res.applied === bp.entities.length,
        failed: res ? res.failed : [{ reason: "paste_threw" }],
        count: bp.entities.length,
        intent_diff,
        readback,
        region,
        anchor: [x, y],
    };
}

function wantOf(p) {
    return { r: p.rot, rv: p.rv, code: p.code };
}

// ─────────────────────────── site finding ───────────────────────────

/**
 * Find the top-left of a w x h rectangle whose every cell is obs-empty, at least
 * minDist from the origin and outside every keepOut rect. Probes live — the world
 * has been modified by earlier experiments, so no static snapshot is trusted.
 */
export async function findClearSite(w, h, opts = {}) {
    const minDist = opts.minDist === undefined ? MIN_SITE_DIST : opts.minDist;
    const keepOut = opts.keepOut || [];
    const spiral = opts.spiral || [];
    const cands = [];
    // spiral of candidate anchors, nearest-first
    if (spiral.length) {
        for (const [sx, sy] of spiral) cands.push([sx, sy]);
    }
    for (let ring = 1; ring < 40; ring++) {
        const R = minDist + ring * 12;
        for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            cands.push([Math.round(Math.cos(a) * R), Math.round(Math.sin(a) * R)]);
        }
    }
    for (const [ax, ay] of cands) {
        if (Math.hypot(ax + w / 2, ay + h / 2) < minDist) continue;
        const rect = [ax, ay, ax + w - 1, ay + h - 1];
        if (keepOut.some((r) => overlaps(rect, r))) continue;
        const chk = await isRectClear(rect);
        if (chk.clear) return { anchor: [ax, ay], rect, minDist };
    }
    return null;
}

export function overlaps(a, b) {
    return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/** inflate a list of cells into an axis-aligned bounding rect, padded. */
export function bbox(cells, pad = 1) {
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

// ─────────────────────────────── cleanup ───────────────────────────────

/**
 * bulk_delete over regions, dry_run first. Returns the manifest it would delete
 * (count + by type) so a destructive step is always accounted for before it runs.
 */
export async function cleanup(regions, { commit = true } = {}) {
    const plans = [];
    for (const region of regions) {
        const dry = await rpc("act", { op: "bulk_delete", region, dry_run: true }, 300000);
        plans.push({ region, would_delete: dry.would_delete, by_type: dry.by_type, items: dry.items });
    }
    const deleted = [];
    if (commit) {
        for (const p of plans) {
            if (!p.would_delete) continue;
            const res = await rpc("act", { op: "bulk_delete", region: p.region }, 300000);
            deleted.push({ region: p.region, applied: res.applied, failed: res.failed });
        }
    }
    return { plans, deleted, total_would_delete: plans.reduce((a, p) => a + (p.would_delete || 0), 0) };
}

// ───────────────────────────── results I/O ─────────────────────────────

export function writeResult(name, obj) {
    fs.mkdirSync(RESULTS, { recursive: true });
    const file = path.join(RESULTS, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(obj, null, 1));
    log(`\n[result] ${path.relative(ROOT, file)}  pass=${obj.pass}`);
    return file;
}

export function readResult(name) {
    return JSON.parse(fs.readFileSync(path.join(RESULTS, `${name}.json`), "utf8"));
}

// ─────────────────────── offline resource model ───────────────────────
// Same chunk algorithm as proto/gen-resources.mjs / exp-e2e.mjs:32-89, copied in so
// P7 does not touch files owned by other packages.

const MCS = 16;
function Mash() {
    let n = 0xefc8249d;
    return function (d) {
        d = d.toString();
        for (let i = 0; i < d.length; i++) {
            n += d.charCodeAt(i);
            let h = 0.02519603282416938 * n;
            n = h >>> 0;
            h -= n;
            h *= n;
            n = h >>> 0;
            h -= n;
            n += h * 0x100000000;
        }
        return (n >>> 0) * 2.3283064365386963e-10;
    };
}
function mk(seed) {
    let c = 1;
    const m = Mash();
    let a = m(" "), b = m(" "), d = m(" ");
    a -= m(seed); if (a < 0) a += 1;
    b -= m(seed); if (b < 0) b += 1;
    d -= m(seed); if (d < 0) d += 1;
    return function () {
        const t = 2091639 * a + c * 2.3283064365386963e-10;
        a = b; b = d;
        return (d = t - (c = t | 0));
    };
}
class RNG {
    constructor(s) { this.r = mk(s); }
    n() { return this.r(); }
    ch(a) { return a[this.i(0, a.length)]; }
    i(mn, mx) { return Math.floor(this.n() * (mx - mn) + mn); }
    rg(mn, mx) { return this.n() * (mx - mn) + mn; }
}
const cl = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const SH = { rect: "R", circle: "C", star: "S", windmill: "W" };
const chunkCache = new Map();
class Chunk {
    constructor(seed, x, y) {
        this.x = x; this.y = y; this.tx = x * MCS; this.ty = y * MCS;
        this.l = Array.from({ length: MCS }, () => new Array(MCS).fill(null));
        const r = new RNG(this.x + "|" + this.y + "|" + seed);
        if (this.pre(r)) return;
        const d = Math.round(Math.hypot(this.x + 0.5, this.y + 0.5));
        const c = 0.9 - cl(d / 25, 0, 1) * 0.5;
        if (r.n() < c / 4) this.cp(r, Math.max(2, Math.round(1 + cl(d / 8, 0, 4))), d);
        if (r.n() < c / 4) this.sp(r, Math.max(2, Math.round(1 + cl(d / 8, 0, 4))), d);
    }
    pre(r) {
        if (this.x === 0 && this.y === 0) { this.p(r, 2, "red", 7, 7); return true; }
        if (this.x === -1 && this.y === 0) { this.p(r, 2, "CuCuCuCu", MCS - 9, 7); return true; }
        if (this.x === 0 && this.y === -1) { this.p(r, 2, "RuRuRuRu", 5, MCS - 7); return true; }
        if (this.x === -1 && this.y === -1) { this.p(r, 2, "green"); return true; }
        if (this.x === 5 && this.y === -2) { this.p(r, 2, "SuSuSuSu", 5, MCS - 7); return true; }
        return false;
    }
    p(r, ps, item, ox = null, oy = null) {
        const b = Math.ceil(ps / 2 + 3);
        let px = r.i(b, MCS - b - 1), py = r.i(b, MCS - b - 1);
        if (ox !== null) px = ox;
        if (oy !== null) py = oy;
        for (let k = 0; k <= ps; ++k) {
            const rad = Math.min(1 + k, ps), rs = rad * rad, off = (ps - k) / 2 + 2;
            const sx = r.rg(0.9, 1.1), sy = r.rg(0.9, 1.1);
            const cx = px + r.i(-off, off), cy = py + r.i(-off, off);
            for (let dx = -rad * sx - 2; dx <= rad * sx + 2; ++dx)
                for (let dy = -rad * sy - 2; dy <= rad * sy + 2; ++dy) {
                    const X = Math.round(cx + dx), Y = Math.round(cy + dy);
                    if (X >= 0 && X < MCS && Y >= 0 && Y <= MCS) {
                        const a2 = dx / sx, b2 = dy / sy;
                        if (a2 * a2 + b2 * b2 <= rs && !this.l[X][Y]) this.l[X][Y] = item;
                    }
                }
        }
    }
    cp(r, s, d) { const a = ["red", "green"]; if (d > 2) a.push("blue"); this.p(r, s, r.ch(a)); }
    sp(r, s, d) {
        const w = {
            rect: 100,
            circle: Math.round(50 + cl(d * 2, 0, 50)),
            star: Math.round(20 + cl(d, 0, 30)),
            windmill: Math.round(6 + cl(d / 2, 0, 20)),
        };
        if (d < 7) { w.star = 0; w.windmill = 0; }
        const pk = () => {
            const s2 = Object.values(w).reduce((a, b) => a + b, 0);
            const n = r.i(0, s2 - 1);
            let ac = 0;
            for (const k in w) { if (ac + w[k] > n) return k; ac += w[k]; }
            return "circle";
        };
        let ss;
        if (d < 10) { const a = pk(); ss = [a, a, a, a]; }
        else if (d < 15) { const a = pk(), b = pk(); ss = [a, a, b, b]; }
        else ss = [pk(), pk(), pk(), pk()];
        let wc = 0;
        for (const s2 of ss) if (s2 === "windmill") ++wc;
        if (wc > 1) { ss[0] = "rect"; ss[1] = "rect"; }
        this.p(r, s, ss.map((s2) => SH[s2] + "u").join(""));
    }
}
export function offlineTile(seed, x, y) {
    const cx = Math.floor(x / MCS), cy = Math.floor(y / MCS);
    const key = cx + "," + cy;
    let ch = chunkCache.get(key);
    if (!ch) { ch = new Chunk(seed, cx, cy); chunkCache.set(key, ch); }
    return ch.l[x - ch.tx][y - ch.ty];
}

/** cross-check: does the live world agree with the offline model on these cells? */
export async function verifyOfflineResource(seed, cells, shape) {
    const rows = [];
    for (const [x, y] of cells) {
        const off = offlineTile(seed, x, y);
        const o = await rpc("obs", { region: [x - 1, y - 1, x + 1, y + 1], include_resources: true, max_resources: 50, max_entities: 1 }, 60000);
        const live = (o.resources || []).find((r) => r[0] === x && r[1] === y);
        rows.push({ cell: [x, y], offline: off, live: live ? live[2] : null, match: off === (live ? live[2] : null) && (!shape || off === shape) });
    }
    return { all_match: rows.every((r) => r.match), rows };
}

export { solveTurn, beltCode, encodeBlueprint, decodeBlueprint, summarizeBlueprint, DIRV, OPP, angleToDir };
