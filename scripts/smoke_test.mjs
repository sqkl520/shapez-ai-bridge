#!/usr/bin/env node
// shapez-ai-bridge smoke test — zero-dependency (node: builtins + global fetch).
//
// Verifies the full stack end-to-end against a RUNNING game + bridge:
//   1. GET  /health                     — bridge process is up
//   2. POST /rpc status                 — a mod is connected and in-game (world loaded)
//   3. POST /rpc obs {max_entities:5}   — observation pipeline works; prints entity total
//   4. POST /rpc act {op:"place"}       — place a belt on an empty tile near the hub,
//                                         then observe the same tile to confirm it exists
//   5. POST /rpc act {op:"delete"}      — delete that belt and confirm the tile is empty
//                                         again (the world is left exactly as found)
//
// Fully non-interactive in every mode. Set SHAPEZ_SMOKE_AUTOPLAY=1 to suppress the
// courtesy notice about the temporary belt placed in the user's world.
//
// Usage:
//   node scripts/smoke_test.mjs [--url http://127.0.0.1:7777] [--token <bearer>]
//
// Environment:
//   SHAPEZ_BRIDGE_URL       Override bridge base URL (default http://127.0.0.1:7777)
//   SHAPEZ_BRIDGE_TOKEN     Bearer token when the bridge has auth enabled
//   SHAPEZ_SMOKE_AUTOPLAY=1 Suppress the temporary-modification notice
//
// Exit codes:
//   0  all checks passed
//   1  bridge not reachable (start it first)
//   2  bridge up but the game side is not ready (no mod connection / not in a world)
//   3  a later check failed (details printed with raw JSON + troubleshooting hint)

import process from "node:process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CHECK_TOTAL = 5;
const REQUEST_TIMEOUT_MS = 30_000;

function parseArgv(argv) {
    const out = { url: null, token: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--url" && i + 1 < argv.length) {
            out.url = argv[++i];
        } else if (a.startsWith("--url=")) {
            out.url = a.slice("--url=".length);
        } else if (a === "--token" && i + 1 < argv.length) {
            out.token = argv[++i];
        } else if (a.startsWith("--token=")) {
            out.token = a.slice("--token=".length);
        } else if (a === "--help" || a === "-h") {
            console.log(
                "Usage: node scripts/smoke_test.mjs [--url http://127.0.0.1:7777] [--token <bearer>]\n" +
                    "Env:   SHAPEZ_BRIDGE_URL, SHAPEZ_BRIDGE_TOKEN, SHAPEZ_SMOKE_AUTOPLAY=1\n" +
                    "用途:  node scripts/smoke_test.mjs [--url ...] [--token ...]  （无交互冒烟测试）"
            );
            process.exit(0);
        } else {
            console.error(`[FAIL] Unknown argument: ${a} (see --help)`);
            console.error(`[失败] 未知参数: ${a}（见 --help）`);
            process.exit(1);
        }
    }
    return out;
}

const argv = parseArgv(process.argv.slice(2));
const BASE_URL = (argv.url || process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const TOKEN = argv.token || process.env.SHAPEZ_BRIDGE_TOKEN || null;
const AUTOPLAY = process.env.SHAPEZ_SMOKE_AUTOPLAY === "1";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function j(v) {
    return JSON.stringify(v);
}

/** Truncate long raw JSON for display but keep it recognizable. */
function raw(v, max = 2000) {
    const s = typeof v === "string" ? v : j(v);
    return s.length > max ? s.slice(0, max) + `... (${s.length} chars total)` : s;
}

const results = []; // { name, ok }

function pass(checkNo, nameEn, detailEn) {
    results.push(true);
    console.log(`[${checkNo}/${CHECK_TOTAL}] PASS  ${nameEn}${detailEn ? " — " + detailEn : ""}`);
}

function fail(checkNo, nameEn, nameZh, detailEn, hintEn, hintZh, rawPayload) {
    results.push(false);
    console.error(`[${checkNo}/${CHECK_TOTAL}] FAIL  ${nameEn} — ${nameZh}`);
    if (detailEn) {
        console.error(`        detail : ${detailEn}`);
        console.error(`        详情   : ${detailEn}`);
    }
    if (rawPayload !== undefined) {
        console.error(`        response (原文): ${raw(rawPayload)}`);
    }
    if (hintEn) {
        console.error(`        hint   : ${hintEn}`);
        console.error(`        排查   : ${hintZh || hintEn}`);
    }
}

/** Control-flow sentinel: thrown by finish() to unwind back to main(). */
class Done extends Error {
    constructor() {
        super("done");
        this.name = "Done";
    }
}

function finish() {
    const passed = results.filter(Boolean).length;
    const ok = passed === CHECK_TOTAL;
    if (ok) {
        console.log("");
        console.log(`SMOKE TEST PASSED (${passed}/${CHECK_TOTAL})`);
        console.log(`冒烟测试通过 (${passed}/${CHECK_TOTAL})`);
    } else {
        console.error("");
        console.error(`SMOKE TEST FAILED (${passed}/${CHECK_TOTAL})`);
        console.error(`冒烟测试失败 (${passed}/${CHECK_TOTAL})`);
    }
    // Do NOT call process.exit() here: it tears down undici keep-alive sockets
    // abruptly and triggers a libuv assertion on Windows (misleading error).
    // Set exitCode and let the process exit naturally; an unref'd watchdog
    // force-exits after 3s if some handle still keeps the loop alive.
    process.exitCode = ok ? 0 : 3;
    const watchdog = setTimeout(() => process.exit(process.exitCode || 0), 3000);
    watchdog.unref();
    // Throw so mid-flow callers (`fail(...); finish();`) stop executing; the
    // rejection is recognized and swallowed in main().catch() below.
    throw new Done();
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function headers() {
    // "connection: close" disables undici keep-alive so the process can exit
    // without tearing down half-closed sockets — that raises a libuv assertion
    // on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
    const h = { "Content-Type": "application/json", Connection: "close" };
    // /health never needs a token, but sending it there is harmless.
    if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
    return h;
}

async function httpGet(path) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "GET",
        headers: headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    return { status: res.status, body };
}

let nextRpcId = 1;

/** POST /rpc with a JSON-RPC 2.0 request. Returns the parsed response envelope. */
async function rpcRaw(method, params) {
    const payload = { jsonrpc: "2.0", id: nextRpcId++, method, params: params ?? {} };
    const res = await fetch(`${BASE_URL}/rpc`, {
        method: "POST",
        headers: headers(),
        body: j(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try {
        body = JSON.parse(text);
    } catch {
        body = { parse_error: true, http_status: res.status, raw_text: text };
    }
    return { httpStatus: res.status, request: payload, response: body };
}

/** Like rpcRaw but throws a structured error when the response carries a JSON-RPC error. */
async function rpc(method, params) {
    const r = await rpcRaw(method, params);
    const body = r.response;
    if (!body || typeof body !== "object" || body.error) {
        const jrCode = body && body.error ? body.error.code : null;
        const jrName = body && body.error && body.error.data ? body.error.data.code_name : null;
        const detail = jrCode !== null
            ? `JSON-RPC error ${jrCode}${jrName ? " " + jrName : ""}`
            : `unexpected response (HTTP ${r.httpStatus})`;
        const err = new Error(`rpc ${method}: ${detail}`);
        err.rpcDetail = {
            httpStatus: r.httpStatus,
            request: r.request,
            response: body,
            code: jrCode,
            codeName: jrName,
        };
        throw err;
    }
    return body.result;
}

// ---------------------------------------------------------------------------
// Check 1 — bridge health
// ---------------------------------------------------------------------------

async function checkHealth() {
    let health;
    try {
        health = await httpGet("/health");
    } catch (e) {
        fail(
            1,
            "bridge reachable at " + BASE_URL,
            "无法连接桥接服务器",
            `GET /health failed: ${e && e.message ? e.message : e}`,
            "The bridge is not running. Start it first:  node src/bridge/bridge.mjs",
            "桥接未运行。请先启动:  node src/bridge/bridge.mjs",
        );
        console.error("");
        console.error(`SMOKE TEST FAILED (0/${CHECK_TOTAL}) — bridge not running`);
        console.error(`冒烟测试失败 (0/${CHECK_TOTAL}) — 桥接服务器未运行`);
        process.exit(1);
    }
    const b = health.body;
    if (health.status !== 200 || !b || b.ok !== true) {
        fail(
            1,
            "bridge reachable at " + BASE_URL,
            "桥接健康检查未通过",
            `HTTP ${health.status}, body: ${raw(b)}`,
            "If the bridge was started with a token, pass --token <bearer> or set SHAPEZ_BRIDGE_TOKEN.",
            "若桥接启用了 token，请用 --token <bearer> 或设置 SHAPEZ_BRIDGE_TOKEN。",
            b,
        );
        console.error("");
        console.error(`SMOKE TEST FAILED (0/${CHECK_TOTAL})`);
        console.error(`冒烟测试失败 (0/${CHECK_TOTAL})`);
        process.exit(1);
    }
    pass(
        1,
        "bridge healthy",
        `mod_connected=${b.mod_connected}, uptime=${Math.round(b.uptime_s ?? 0)}s`,
    );
    return b;
}

// ---------------------------------------------------------------------------
// Check 2 — status / in-game
// ---------------------------------------------------------------------------

async function checkStatus() {
    let status;
    try {
        status = await rpc("status", {});
    } catch (e) {
        const d = e.rpcDetail || {};
        if (d.code === 1005 || d.codeName === "no_connection") {
            fail(
                2,
                "mod connected & world loaded",
                "游戏未连接或未进入世界",
                "bridge reports no mod connection (1005 no_connection).",
                "Start shapez.io, make sure the mod is loaded (see README install step), and load a savegame.",
                "请启动 shapez.io，确认 mod 已安装（见 README 安装步骤），并进入一个存档。",
                d.response,
            );
        } else if (d.code === 1003 || d.codeName === "not_in_game") {
            fail(
                2,
                "world loaded",
                "尚未进入世界",
                "The game is running but is not inside a world (1003 not_in_game).",
                "Please load a savegame (or start a new one) in shapez.io, then re-run this test.",
                "请先在 shapez.io 中加载或新建一个存档（进入世界），然后重跑本测试。",
                d.response,
            );
        } else {
            fail(
                2,
                "status reachable",
                "status 调用失败",
                `${e.message}; response: ${raw(d.response)}`,
                "Check the bridge log; ensure the bridge and mod protocol versions match (should both be 1).",
                "查看桥接日志；确认桥接与 mod 的 protocol 版本一致（都应为 1）。",
                d.response,
            );
        }
        console.error("");
        console.error(`SMOKE TEST FAILED (1/${CHECK_TOTAL})`);
        console.error(`冒烟测试失败 (1/${CHECK_TOTAL})`);
        process.exit(2);
    }

    const inGame = status && status.in_game === true;
    console.log(
        `        game_version=${status.game_version} mod_version=${status.mod_version} in_game=${inGame}` +
            (status.hub_level !== undefined ? ` hub_level=${status.hub_level}` : "") +
            (status.allow_write === false ? " allow_write=false" : ""),
    );
    console.log(
        `        游戏版本=${status.game_version} mod版本=${status.mod_version} 是否在世界=${inGame ? "是" : "否"}`,
    );

    if (!inGame) {
        fail(
            2,
            "world loaded",
            "尚未进入世界",
            "status.in_game = false (still in menu / loading).",
            "Please load a savegame (or start a new one) in shapez.io, then re-run this test.",
            "请先在 shapez.io 中加载或新建一个存档（进入世界），然后重跑本测试。",
            status,
        );
        console.error("");
        console.error(`SMOKE TEST FAILED (1/${CHECK_TOTAL})`);
        console.error(`冒烟测试失败 (1/${CHECK_TOTAL})`);
        process.exit(2);
    }
    if (status.allow_write === false) {
        fail(
            2,
            "world writable",
            "mod 处于只读模式",
            "mod settings allow_write=false; the placement checks cannot run.",
            "Edit the mod settings in-game (ACCOUNT/mods menu) or the modsettings file to allow writes.",
            "请在游戏内 mod 设置或 modsettings 文件中开启 allow_write。",
            status,
        );
        console.error("");
        console.error(`SMOKE TEST FAILED (1/${CHECK_TOTAL})`);
        console.error(`冒烟测试失败 (1/${CHECK_TOTAL})`);
        process.exit(2);
    }
    pass(2, "mod connected & world loaded", `game ${status.game_version}`);
}

// ---------------------------------------------------------------------------
// Check 3 — observation
// ---------------------------------------------------------------------------

async function checkObs() {
    let obs5;
    try {
        obs5 = await rpc("obs", { max_entities: 5 });
    } catch (e) {
        const d = e.rpcDetail || {};
        fail(
            3,
            "obs {max_entities:5}",
            "观测调用失败",
            `${e.message}; response: ${raw(d.response)}`,
            "Check the bridge log for mod errors (2003). Try `obs {}` via curl to see the raw error.",
            "查看桥接日志中的 mod 错误（2003）。可用 curl 手动调 `obs {}` 查看原始错误。",
            d.response,
        );
        finish();
    }
    const total = obs5.entity_count !== undefined
        ? obs5.entity_count
        : obs5.stats && obs5.stats.total !== undefined
          ? obs5.stats.total
          : (obs5.entities ? obs5.entities.length : "?");
    pass(3, "observation works", `entities in world: ${total} (returned ${obs5.entities ? obs5.entities.length : "?"} sample)`);
    console.log(`        世界实体总数: ${total}`);
    return obs5;
}

// ---------------------------------------------------------------------------
// Empty-tile search near the hub
// ---------------------------------------------------------------------------

const HALF_SPAN = 16; // 32x32 region
const OCCUPANCY_DILATION = 3; // any building footprint up to 4x4 (hub is 4x4)

function regionAround(cx, cy) {
    return [cx - HALF_SPAN, cy - HALF_SPAN, cx + HALF_SPAN - 1, cy + HALF_SPAN - 1];
}

/**
 * From a full observation, pick the empty tile closest to the region center.
 *
 * Occupancy is derived by dilating every observed entity origin by
 * OCCUPANCY_DILATION tiles in all directions. Building footprints are anchored
 * at the origin corner and can be up to 4x4 (the hub), so a radius-3 dilation
 * conservatively covers every footprint shape without knowing each meta's size.
 */
function findEmptyTile(obs, region) {
    const [x0, y0, x1, y1] = region;
    const occupied = new Set();
    for (const e of obs.entities || []) {
        if (typeof e.x !== "number" || typeof e.y !== "number") continue;
        for (let dx = -OCCUPANCY_DILATION; dx <= OCCUPANCY_DILATION; dx++) {
            for (let dy = -OCCUPANCY_DILATION; dy <= OCCUPANCY_DILATION; dy++) {
                occupied.add(`${e.x + dx},${e.y + dy}`);
            }
        }
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let best = null;
    let bestDist = Infinity;
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            if (occupied.has(`${x},${y}`)) continue;
            const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if (d < bestDist) {
                bestDist = d;
                best = [x, y];
            }
        }
    }
    return best;
}

/** Find the hub entity (type "hub") in a full observation. */
function findHub(obs) {
    for (const e of obs.entities || []) {
        if (e.type === "hub") return e;
    }
    return null;
}

/** Observe a single tile; returns the entity sitting with its origin on that tile (or null). */
async function obsTile(x, y) {
    const r = await rpc("obs", { region: [x, y, x, y], max_entities: 50 });
    const hit = (r.entities || []).find((e) => e.x === x && e.y === y);
    return { obs: r, entity: hit || null };
}

// ---------------------------------------------------------------------------
// Checks 4 & 5 — place / verify / delete / verify
// ---------------------------------------------------------------------------

async function checkPlaceAndCleanup() {
    // Full observation to locate the hub (and any entities in the candidate region).
    let full;
    try {
        full = await rpc("obs", { max_entities: 20000 });
    } catch (e) {
        const d = e.rpcDetail || {};
        fail(4, "locate placement area", "获取全量观测失败", `${e.message}`, null, null, d.response);
        finish();
    }

    const hub = findHub(full);
    if (hub) {
        console.log(`        hub found at (${hub.x}, ${hub.y}) — searching a 32x32 area around it.`);
        console.log(`        找到 hub 于 (${hub.x}, ${hub.y})，在其周围 32x32 区域内寻找空位。`);
    } else {
        console.log("        no hub entity in observation — searching a 32x32 area around the origin (0,0).");
        console.log("        观测中未见 hub 实体，改为在原点 (0,0) 周围 32x32 区域寻找空位。");
    }

    const regions = hub
        ? [regionAround(hub.x, hub.y), regionAround(0, 0)]
        : [regionAround(0, 0)];

    let tile = null;
    let regionUsed = null;
    for (const region of regions) {
        // Observe an inflated window: the mod filters entities by their ORIGIN,
        // so an entity anchored up to 3 tiles outside the region can still have
        // its (max 4x4) footprint reach inside it. Picking is still restricted
        // to the core region by findEmptyTile().
        const inflated = [
            region[0] - OCCUPANCY_DILATION,
            region[1] - OCCUPANCY_DILATION,
            region[2] + OCCUPANCY_DILATION,
            region[3] + OCCUPANCY_DILATION,
        ];
        let obsRegion;
        try {
            obsRegion = await rpc("obs", { region: inflated, max_entities: 20000 });
        } catch (e) {
            const d = e.rpcDetail || {};
            fail(4, "locate placement area", "区域观测失败", `${e.message}`, null, null, d.response);
            finish();
        }
        if (obsRegion.truncated) continue; // region has more entities than requested — try fewer assumptions elsewhere
        const t = findEmptyTile(obsRegion, region);
        if (t) {
            tile = t;
            regionUsed = region;
            break;
        }
    }

    if (!tile) {
        fail(
            4,
            "empty tile found",
            "找不到空位",
            "No empty tile in the searched regions (they are fully built).",
            "The hub surroundings are too crowded. Clear a little space near the hub in-game and re-run.",
            "hub 周围已被建筑占满。请在游戏内腾出一点空地后重跑。",
        );
        finish();
    }

    const [px, py] = tile;
    console.log(`        region ${j(regionUsed)} — chosen empty tile: (${px}, ${py})`);
    console.log(`        区域 ${j(regionUsed)} — 选定空位: (${px}, ${py})`);

    if (!AUTOPLAY) {
        console.log("        [notice] This will place one belt, verify it, then delete it — the world is left unchanged.");
        console.log("        [提示] 本测试会临时放置一条传送带，验证后立即删除，世界将恢复原状。");
        console.log("        (set SHAPEZ_SMOKE_AUTOPLAY=1 to suppress this notice / 设 SHAPEZ_SMOKE_AUTOPLAY=1 可隐藏此提示)");
    }

    // ---- Check 4: place + verify -------------------------------------------
    let placeRes;
    try {
        placeRes = await rpc("act", { op: "place", building: "belt", x: px, y: py });
    } catch (e) {
        const d = e.rpcDetail || {};
        fail(
            4,
            `place belt at (${px}, ${py})`,
            "放置传送带失败",
            `${e.message} (code ${d.code} ${d.codeName || ""})`,
            "If code=2001 the building name may be wrong (expected \"belt\"); code=2002 means the tile was rejected by the game.",
            "若 code=2001 可能是建筑名不对（应为 \"belt\"）；code=2002 表示游戏拒绝该格（被占/不可放）。",
            d.response,
        );
        finish();
    }

    if (!placeRes || placeRes.ok !== true || placeRes.entity_uid === undefined) {
        fail(
            4,
            `place belt at (${px}, ${py})`,
            "放置结果不符合协议",
            `expected {ok:true, entity_uid:<int>}, got: ${raw(placeRes)}`,
            "The mod returned an unexpected shape — check the mod version matches this repo (protocol 1, mod 0.1.x).",
            "mod 返回了预期之外的结构 — 请确认 mod 版本与本仓库匹配（protocol 1、mod 0.1.x）。",
            placeRes,
        );
        finish();
    }
    const uid = placeRes.entity_uid;

    // Verify by observing the same tile.
    let verify;
    try {
        verify = await obsTile(px, py);
    } catch (e) {
        const d = e.rpcDetail || {};
        // Best-effort cleanup before bailing.
        await cleanupQuiet(px, py);
        fail(4, "verify placed belt", "验证放置结果失败", `${e.message}`, null, null, d.response);
        finish();
    }
    if (!verify.entity || verify.entity.type !== "belt") {
        await cleanupQuiet(px, py);
        fail(
            4,
            "verify placed belt",
            "放置后观测不到 belt",
            `tile (${px}, ${py}) observation: ${raw(verify.obs)}`,
            "The place call reported ok but the tile is not a belt. This is a mod bug — report it with this JSON.",
            "place 返回 ok 但该格不是 belt，这是 mod 的 bug — 请附此 JSON 上报。",
            verify.obs,
        );
        finish();
    }
    pass(4, `place & verify belt at (${px}, ${py})`, `uid=${uid}, type=${verify.entity.type}`);

    // ---- Check 5: delete + verify ------------------------------------------
    let delRes;
    try {
        delRes = await rpc("act", { op: "delete", x: px, y: py });
    } catch (e) {
        const d = e.rpcDetail || {};
        fail(
            5,
            `delete belt at (${px}, ${py})`,
            "删除传送带失败",
            `${e.message} (code ${d.code} ${d.codeName || ""}); the belt may still exist at (${px}, ${py}).`,
            "Delete the belt manually in-game, or re-run this smoke test (it will reuse the same tile).",
            "该传送带可能仍在游戏里，请在游戏内手动删除，或重跑本测试（会复用同一格）。",
            d.response,
        );
        finish();
    }
    if (!delRes || delRes.ok !== true) {
        fail(
            5,
            `delete belt at (${px}, ${py})`,
            "删除结果不符合协议",
            `expected {ok:true}, got: ${raw(delRes)}; the belt may still exist at (${px}, ${py}).`,
            "Delete the belt manually in-game.",
            "请在游戏内手动删除该传送带。",
            delRes,
        );
        finish();
    }

    let confirm;
    try {
        confirm = await obsTile(px, py);
    } catch (e) {
        const d = e.rpcDetail || {};
        fail(5, "confirm tile empty", "确认删除失败", `${e.message}`, null, null, d.response);
        finish();
    }
    if (confirm.entity) {
        fail(
            5,
            "confirm tile empty",
            "删除后该格仍有实体",
            `tile (${px}, ${py}) still holds: ${raw(confirm.entity)}`,
            "The world was NOT restored. Remove the leftover entity manually in-game.",
            "世界未恢复原状！请在游戏内手动移除残留实体。",
            confirm.obs,
        );
        finish();
    }
    pass(5, `delete & confirm at (${px}, ${py})`, "world restored");
}

/** Best-effort silent cleanup used when aborting between place and delete. */
async function cleanupQuiet(x, y) {
    try {
        await rpc("act", { op: "delete", x, y });
        console.log(`        [cleanup] removed the temporary belt at (${x}, ${y}).`);
        console.log(`        [清理] 已移除临时传送带 (${x}, ${y})。`);
    } catch {
        console.error(`        [cleanup] WARNING: could not remove the belt at (${x}, ${y}); remove it in-game.`);
        console.error(`        [清理] 警告: 未能移除 (${x}, ${y}) 的传送带，请在游戏内手动删除。`);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log("shapez-ai-bridge smoke test");
    console.log("shapez-ai-bridge 冒烟测试");
    console.log(`bridge: ${BASE_URL}${TOKEN ? " (token set)" : ""}` + (AUTOPLAY ? " (autoplay)" : ""));
    console.log("");

    await checkHealth(); // exits 1 on failure
    await checkStatus(); // exits 2 when not in a world
    await checkObs(); // exits 3 on failure
    await checkPlaceAndCleanup(); // exits 3 on failure
    finish(); // prints summary, exit 0 or 3 (throws Done to unwind)
}

main().catch((e) => {
    if (e instanceof Done) {
        return; // normal termination path: summary already printed, exitCode set
    }
    console.error("");
    console.error(`SMOKE TEST CRASHED — unexpected error: ${e && e.stack ? e.stack : e}`);
    console.error(`冒烟测试异常中断: ${e && e.message ? e.message : e}`);
    // Same Windows caveat as finish(): avoid process.exit() with live sockets.
    process.exitCode = 3;
    const watchdog = setTimeout(() => process.exit(3), 3000);
    watchdog.unref();
});
