/**
 * exp-v2-orig.mjs — 验证 v2（平行数组 o）真的治好了 P7-F2 的拐角翻向。
 *
 * P7-F2 的原始结论（`results/orig-flip.json`）：9 格矩阵里 **3 个 PULL 扰动让拐角翻向**，
 *   NONE/EJECT 不翻 —— 因为 v1 蓝图不存 originalRotation，游戏按 `orig = rot` 重算。
 * 本实验用**同一个扰动手法**，但蓝图来自 v2 编译器（带 o），预期：**翻向数 = 0**。
 *
 * 手法（照抄 F2）：paste 含拐角蓝图 → 记录拐角 code → 在拐角**输出侧**补一格带（触发
 *   entityAdded→updateSurroundingBeltPlacement）→ 再读拐角 code。变 = 翻；不变 = 稳。
 *
 * 用法：node research/ai-plan/live/exp-v2-orig.mjs
 */
import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:7777";
let rid = 1;
async function rpc(m, p = {}, t = 240000) {
    const r = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method: m, params: p }), signal: AbortSignal.timeout(t) });
    const b = await r.json(); if (b.error) throw Object.assign(new Error(b.error.message), { rpc: b.error }); return b.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const { encodeBlueprint, decodeBlueprint } = await import("../../../src/shared/blueprint.mjs");

/** 造一个"入 bottom → 出 right"的拐角 + 上下游直带，L 形，v2 带 orig */
function makeCornerBlueprint(useOrig) {
    // 坐标：竖带 (0,0)-(0,2)，拐角 (0,3)，横带 (1,3)-(3,3)
    // rotation=0 时：竖带 r=0(朝上)；拐角需要"从下进、向右出" → solveTurn(bottom,right)
    // belt code=1+rv；rv2=右弯。rotation 0 + rv2 → 入口 bottom、出口 right ✓
    const ents = [
        { code: 1, dx: 0, dy: 2, rot: 0 },   // 竖带（朝上）
        { code: 1, dx: 0, dy: 1, rot: 0 },
        { code: 3, dx: 0, dy: 0, rot: 0 },   // 拐角 rv2（code=3）—— 锚点在 dy=0
        { code: 1, dx: 1, dy: 0, rot: 90 },  // 横带（朝右）
        { code: 1, dx: 2, dy: 0, rot: 90 },
    ];
    return encodeBlueprint({
        gv: "1.5.6", w: [0, 0],
        entities: ents.map(e => ({ ...e, orig: useOrig ? e.rot : null })),
    });
}

async function findClear() {
    for (const cx of [40, 80, 120, 160, 200]) for (const cy of [40, 80, 120, -40, -80]) {
        const o = await rpc("obs", { region: [cx - 6, cy - 6, cx + 12, cy + 12], max_entities: 20 });
        if (!(o.entities || []).length) return [cx, cy];
    }
    return null;
}

async function runCase(label, useOrig) {
    const site = await findClear();
    if (!site) return { label, error: "no clear site" };
    const [X, Y] = site;
    const text = makeCornerBlueprint(useOrig);
    const bp = decodeBlueprint(text);
    const paste = await rpc("act", { op: "paste_blueprint", text, x: X, y: Y, charge: false });
    const corner = [X + 0, Y + 0];
    const read = async () => {
        const o = await rpc("obs", { region: [X - 2, Y - 2, X + 5, Y + 5], max_entities: 40 });
        const c = (o.entities || []).find(e => e.x === corner[0] && e.y === corner[1]);
        return c ? { code: c.code, rv: c.rotation_variant, r: c.r } : null;
    };
    const before = await read();
    // P7-F2 的精确手法（与其 results/orig-flip.json 的 C00-bottom->right/PULL 一致）：
    // 扰动格在拐角的**左侧**（输入侧），r=270（朝右，把货"拉"进拐角）—— 正是 PULL 模式。
    // 我在第一版把扰动放在了输出侧，所以 v1 也没翻、整个对照失效。
    await rpc("act", { op: "place", building: "belt", x: X - 1, y: Y, r: 270 });
    const after = await read();
    // 清理
    try { await rpc("act", { op: "bulk_delete", region: [X - 3, Y - 3, X + 6, Y + 6] }); } catch {}
    const flipped = !!(before && after && (before.code !== after.code || before.rv !== after.rv));
    log(`  ${label}: paste=${paste.applied}  before=${JSON.stringify(before)}  after=${JSON.stringify(after)}  → ${flipped ? "🔴 翻向" : "✅ 稳定"}`);
    return { label, useOrig, formatVersion: bp.v, hasO: bp.entities.every(e => e.orig !== e.rot) || useOrig, before, after, flipped, paste_applied: paste.applied };
}

try {
    const st = await rpc("status");
    if (!st.in_game) { log("not in game"); process.exit(2); }
    log(`[v2-orig] 世界 in_game, 当前 tick=${Math.round(st.tick)}`);
    const results = [];
    results.push(await runCase("v1 蓝图（无 o，复刻 P7-F2 的翻向条件）", false));
    results.push(await runCase("v2 蓝图（带 o）", true));
    const out = {
        test: "v2-orig-fix",
        cases: results,
        // 判据：v1 应该翻（证明手法有效），v2 应该不翻（证明修复有效）
        v1_flipped: results[0] && results[0].flipped,
        v2_flipped: results[1] && results[1].flipped,
        pass: !!(results[0] && results[0].flipped && results[1] && !results[1].flipped),
        note: "v1 翻向 = 扰动手法有效（复刻 P7-F2）；v2 不翻 = stride=5 修复有效。若 v1 也没翻，说明该拓扑在此 corner 不是 PULL 敏感格，需换角度重试。",
    };
    fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
    fs.writeFileSync(path.join(import.meta.dirname, "results", "v2-orig-fix.json"), JSON.stringify(out, null, 1));
    log(`\n=== ${out.pass ? "✅ v2 修复有效（v1 翻、v2 稳）" : (out.v1_flipped && !out.v2_flipped ? "" : "⚠️ 见 cases（v1 未复现翻向 → 换拓扑重试）")} ===`);
    log(`v1_flipped=${out.v1_flipped}  v2_flipped=${out.v2_flipped}`);
} catch (e) {
    log("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    process.exit(1);
}
