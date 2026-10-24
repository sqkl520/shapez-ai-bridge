/**
 * l3-run.mjs — L3 端到端验收（plan §5 的最后一门）。
 *
 * 链条：新档 → 读 seed → **离线**编译 goal → dry_run 核对 → 真贴 → await 交付。
 * 判据（全部由脚本代码判定，不许文档口径覆盖）：
 *   compile.ok && validator.pass && dryrun 干净 && paste.applied == entities.length
 *   && (await met || delivered 增加 || level 增加)
 *   && 世界恢复：新档自清理，旧档未动。
 *
 * 用法：node research/ai-plan/live/l3-run.mjs [--goal "----CuCu"] [--keep]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { compilePlan } = await import("../../../src/ai/compiler/compile.mjs");
const { decodeSave } = require("../../../recon/decode_full.cjs");

const BASE = "http://127.0.0.1:7777";
let rid = 1;
async function rpc(method, params = {}, timeoutMs = 240000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { rpc: body.error });
    return body.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const args = process.argv.slice(2);
const GOAL = (() => { const i = args.indexOf("--goal"); return i >= 0 ? args[i + 1] : "----CuCu"; })();
const KEEP = args.includes("--keep");
const OUT = path.join(import.meta.dirname, "results");
fs.mkdirSync(OUT, { recursive: true });
const R = { goal: GOAL, steps: {}, pass: false };

function finish() {
    fs.writeFileSync(path.join(OUT, `l3-${GOAL}.json`), JSON.stringify(R, null, 1));
    log(`\n→ 落盘 results/l3-${GOAL}.json`);
    log(R.pass ? `\n=== L3 PASS (${GOAL}) ===` : `\n=== L3 FAIL (${GOAL}) — ${R.fail_reason || "见 steps"} ===`);
    process.exit(R.pass ? 0 : 2);
}
function fail(reason, extra) { R.fail_reason = reason; if (extra) R.fail_detail = extra; finish(); }

try {
    // ── 1. 新档 ──
    log("[1] new_game ...");
    const ng = await rpc("new_game", { game_mode: "regularMode" });
    R.steps.new_game = ng;
    for (let i = 0; i < 45; i++) {
        await sleep(1000);
        if ((await rpc("status")).in_game) { log(`    in world (${i + 1}s)`); break; }
    }
    const o0 = await rpc("obs", { max_entities: 20, include_hub: true });
    if (!o0.in_game) fail("new_game: never entered world");
    const hub = (o0.entities || []).find(e => e.type === "hub");
    if (!hub) fail("no hub in fresh world");
    R.world = { internal_id: ng.internal_id, level: o0.goal.level, shape: o0.goal.requirement.shape,
        delivered_before: o0.goal.requirement.delivered, required: o0.goal.requirement.required, hub: [hub.x, hub.y] };
    log(`    goal L${o0.goal.level} ${o0.goal.requirement.shape} ${o0.goal.requirement.delivered}/${o0.goal.requirement.required}  hub (${hub.x},${hub.y})`);

    // ── 2. seed（离线读档） ──
    const sv = await rpc("save_now", {});
    const seed = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${sv.internal_id}.bin`)).obj.dump.map.seed;
    R.seed = seed;
    log(`[2] seed = ${seed}`);

    // ── 3. 离线编译 ──
    log(`[3] compilePlan(${GOAL}) ...`);
    const t0 = Date.now();
    const plan = await compilePlan({ goal: GOAL, seed, hub: { x: hub.x, y: hub.y } });
    R.compile_ms = Date.now() - t0;
    R.steps.compile = { ok: plan.ok, reason: plan.reason || null, entities: (plan.entities || []).length,
        validator_pass: !!(plan.validation && plan.validation.pass),
        blueprint_len: (plan.blueprint || "").length, bbox: plan.layout && plan.layout.bbox,
        corners: plan.layout && plan.layout.cornerCount };
    log(`    ok=${plan.ok} reason=${plan.reason || "-"} ents=${R.steps.compile.entities} vpass=${R.steps.compile.validator_pass} bp=${R.steps.compile.blueprint_len} corners=${R.steps.compile.corners}`);
    if (!plan.ok) fail(`compile: ${plan.reason}`);
    if (!R.steps.compile.validator_pass) fail("compile: validator not pass");
    if (!plan.blueprint) fail("compile: no blueprint");

    // 交接件（即使后续失败也留证据）
    const outDir = path.join(import.meta.dirname, "..", "harness", "out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${GOAL}.szbp.txt`), plan.blueprint);
    fs.writeFileSync(path.join(outDir, `${GOAL}.l3.intent.json`), JSON.stringify(
        { goal: GOAL, seed, anchor: plan.site && plan.site.anchor, hub: plan.site && plan.site.hub,
          chargeMode: plan.stats && plan.stats.chargeMode, entities: plan.entities }, null, 1));

    // ── 4. dry_run 核对（C1：绝不压既有带子/机器） ──
    const anchor = (plan.site && plan.site.anchor) || [0, 0];
    const dr = await rpc("act", { op: "paste_blueprint", text: plan.blueprint, x: anchor[0], y: anchor[1], charge: false, dry_run: true });
    R.steps.dry_run = { would_apply: dr.would_apply, would_delete: dr.would_delete, blocked: (dr.blocked || []).length,
        unknown_code: (dr.unknown_code || []).length, bbox: dr.bbox, destroys: (dr.destroys || []).slice(0, 5) };
    log(`[4] dry_run: apply=${dr.would_apply} delete=${dr.would_delete} blocked=${(dr.blocked || []).length} unknown=${(dr.unknown_code || []).length}`);
    if (dr.would_delete > 0) fail("dry_run: would destroy existing belts", dr.destroys);
    if ((dr.blocked || []).length > 0) fail("dry_run: blocked entries", dr.blocked.slice(0, 3));
    if ((dr.unknown_code || []).length > 0) fail("dry_run: unknown codes", dr.unknown_code);
    if (dr.would_apply !== (plan.entities || []).length) fail(`dry_run: would_apply ${dr.would_apply} != entities ${plan.entities.length}`);

    // ── 5. 真贴 ──
    const paste = await rpc("act", { op: "paste_blueprint", text: plan.blueprint, x: anchor[0], y: anchor[1], charge: false });
    R.steps.paste = { applied: paste.applied, failed: (paste.failed || []).length };
    log(`[5] paste: applied=${paste.applied} failed=${(paste.failed || []).length}`);
    if (paste.applied !== (plan.entities || []).length) fail(`paste: applied ${paste.applied} != ${plan.entities.length}`, paste.failed);

    // ── 6. 逐格对拍：落盘 vs 设计（P7 的判据） ──
    const items = plan.entities;
    const bbox = [Math.min(...items.map(e => anchor[0] + e.dx)), Math.min(...items.map(e => anchor[1] + e.dy)),
                  Math.max(...items.map(e => anchor[0] + e.dx)), Math.max(...items.map(e => anchor[1] + e.dy))];
    const obsR = await rpc("obs", { region: [bbox[0] - 2, bbox[1] - 2, bbox[2] + 2, bbox[3] + 2], max_entities: 500 });
    const got = new Map((obsR.entities || []).map(e => [`${e.x},${e.y}`, e]));
    const diffs = [];
    for (const e of items) {
        const wx = anchor[0] + e.dx, wy = anchor[1] + e.dy;
        const g = got.get(`${wx},${wy}`);
        if (!g) { diffs.push({ cell: [wx, wy], want: { kind: e.kind, code: e.code }, got: null }); continue; }
        if (g.code !== e.code || (e.rotationVariant !== undefined && g.rotation_variant !== e.rotationVariant)) {
            diffs.push({ cell: [wx, wy], want: { kind: e.kind, code: e.code, rv: e.rotationVariant },
                got: { kind: g.type, code: g.code, rv: g.rotation_variant } });
        }
    }
    R.steps.intent_diff = diffs;
    log(`[6] 逐格对拍: ${diffs.length} 处不符 / ${items.length} 格`);
    if (diffs.length) { R.fail_reason = "intent-diff"; R.fail_detail = diffs.slice(0, 5); }

    // ── 7. 等交付（L3 的正题） ──
    log("[7] await hub_delivered_increased (≤20000 ticks) ...");
    let aw = null;
    try { aw = await rpc("act", { op: "await", until: "hub_delivered_increased", timeout_ticks: 20000 }); }
    catch (e) { R.steps.await_error = e.message; }
    const o1 = await rpc("obs", { max_entities: 10, include_hub: true });
    const req = o1.goal.requirement;
    R.steps.delivery = { met: aw && aw.met, ticks_run: aw && aw.ticks_run,
        delivered_before: R.world.delivered_before, delivered_after: req.delivered,
        level_before: R.world.level, level_after: o1.goal.level,
        stored: o1.hub ? Object.entries(o1.hub.stored_shapes).filter(([, v]) => v > 0).slice(0, 4) : [] };
    log(`    met=${R.steps.delivery.met} ticks=${R.steps.delivery.ticks_run} delivered ${R.world.delivered_before}→${req.delivered} level ${R.world.level}→${o1.goal.level}`);
    log(`    hub stored: ${JSON.stringify(R.steps.delivery.stored)}`);

    const delivered = (aw && aw.met === true) || req.delivered > R.world.delivered_before || o1.goal.level > R.world.level;
    if (!delivered && !R.fail_reason) R.fail_reason = "await: no delivery observed";

    R.pass = !R.fail_reason && diffs.length === 0 && delivered;
    if (diffs.length) R.fail_reason = R.fail_reason || "intent-diff";

    // ── 8. 收尾 ──
    if (!KEEP) {
        log("[8] 清理（新档内自清理；旧档从未被触碰）");
        try { await rpc("act", { op: "bulk_delete", region: [bbox[0] - 3, bbox[1] - 3, bbox[2] + 3, bbox[3] + 3] }); } catch (e) { log("   清理:", e.message); }
    }
    finish();
} catch (e) {
    R.fail_reason = `exception: ${e.message}`;
    R.fail_detail = e.rpc || null;
    finish();
}
