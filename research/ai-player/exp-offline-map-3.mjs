/**
 * exp-offline-map-3.mjs — 真·盲建：完全不 obs、不 camera，直接在未生成坐标放矿机。
 *
 * H3：AI 可以在**从未被观测/生成**的 chunk 上直接放建筑（游戏按需生成 chunk）。
 *      这是 H2 的干净版本（H2 被"obs 触发生成"混淆）。
 *
 * 方法：挑一个远坐标 → **不做任何观测** → 直接 place → 事后才 obs 确认。
 * 为排除"之前的实验已生成该区域"，选一个从未被实验碰过的区域。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "facts", "live");

let rpcId = 1;
async function rpc(method, params = {}, timeoutMs = 240000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST", headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) { const e = new Error(body.error.message); e.rpc = body.error; throw e; }
    return body.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 生成器（内联精简版，与 gen-resources.mjs 同源）
const MAP_CHUNK_SIZE = 16;
function Mash() { let n = 0xefc8249d; return function (data) { data = data.toString(); for (let i = 0; i < data.length; i++) { n += data.charCodeAt(i); let h = 0.02519603282416938 * n; n = h >>> 0; h -= n; h *= n; n = h >>> 0; h -= n; n += h * 0x100000000; } return (n >>> 0) * 2.3283064365386963e-10; }; }
function makeNewRng(seed) { let c = 1; const mash = Mash(); let s0 = mash(" "), s1 = mash(" "), s2 = mash(" "); s0 -= mash(seed); if (s0 < 0) s0 += 1; s1 -= mash(seed); if (s1 < 0) s1 += 1; s2 -= mash(seed); if (s2 < 0) s2 += 1; return function () { const t = 2091639 * s0 + c * 2.3283064365386963e-10; s0 = s1; s1 = s2; return (s2 = t - (c = t | 0)); }; }
class RNG { constructor(s) { this.r = makeNewRng(s); } next() { return this.r(); } choice(a) { return a[this.nextIntRange(0, a.length)]; } nextIntRange(mn, mx) { return Math.floor(this.next() * (mx - mn) + mn); } nextRange(mn, mx) { return this.next() * (mx - mn) + mn; } }
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const SHORT = { rect: "R", circle: "C", star: "S", windmill: "W" };
class Chunk {
    constructor(seed, x, y) {
        this.x = x; this.y = y; this.tileX = x * MAP_CHUNK_SIZE; this.tileY = y * MAP_CHUNK_SIZE;
        this.lower = Array.from({ length: MAP_CHUNK_SIZE }, () => new Array(MAP_CHUNK_SIZE).fill(null));
        const rng = new RNG(this.x + "|" + this.y + "|" + seed);
        if (this.pre(rng)) return;
        const d = Math.round(Math.hypot(this.x + 0.5, this.y + 0.5));
        const chance = 0.9 - clamp(d / 25, 0, 1) * 0.5;
        if (rng.next() < chance / 4) this.colorPatch(rng, Math.max(2, Math.round(1 + clamp(d / 8, 0, 4))), d);
        if (rng.next() < chance / 4) this.shapePatch(rng, Math.max(2, Math.round(1 + clamp(d / 8, 0, 4))), d);
    }
    pre(rng) {
        if (this.x === 0 && this.y === 0) { this.patch(rng, 2, "red", 7, 7); return true; }
        if (this.x === -1 && this.y === 0) { this.patch(rng, 2, "CuCuCuCu", MAP_CHUNK_SIZE - 9, 7); return true; }
        if (this.x === 0 && this.y === -1) { this.patch(rng, 2, "RuRuRuRu", 5, MAP_CHUNK_SIZE - 7); return true; }
        if (this.x === -1 && this.y === -1) { this.patch(rng, 2, "green"); return true; }
        if (this.x === 5 && this.y === -2) { this.patch(rng, 2, "SuSuSuSu", 5, MAP_CHUNK_SIZE - 7); return true; }
        return false;
    }
    patch(rng, patchSize, item, ox = null, oy = null) {
        const border = Math.ceil(patchSize / 2 + 3);
        let px = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        let py = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        if (ox !== null) px = ox; if (oy !== null) py = oy;
        for (let i = 0; i <= patchSize; ++i) {
            const r = Math.min(1 + i, patchSize), rs = r * r, off = (patchSize - i) / 2 + 2;
            const sx = rng.nextRange(0.9, 1.1), sy = rng.nextRange(0.9, 1.1);
            const cx = px + rng.nextIntRange(-off, off), cy = py + rng.nextIntRange(-off, off);
            for (let dx = -r * sx - 2; dx <= r * sx + 2; ++dx) for (let dy = -r * sy - 2; dy <= r * sy + 2; ++dy) {
                const x = Math.round(cx + dx), y = Math.round(cy + dy);
                if (x >= 0 && x < MAP_CHUNK_SIZE && y >= 0 && y <= MAP_CHUNK_SIZE) {
                    const a = dx / sx, b = dy / sy;
                    if (a * a + b * b <= rs && !this.lower[x][y]) this.lower[x][y] = item;
                }
            }
        }
    }
    colorPatch(rng, size, d) { const av = ["red", "green"]; if (d > 2) av.push("blue"); this.patch(rng, size, rng.choice(av)); }
    shapePatch(rng, size, d) {
        const w = { rect: 100, circle: Math.round(50 + clamp(d * 2, 0, 50)), star: Math.round(20 + clamp(d, 0, 30)), windmill: Math.round(6 + clamp(d / 2, 0, 20)) };
        if (d < 7) { w.star = 0; w.windmill = 0; }
        const pick = () => { const sum = Object.values(w).reduce((a, b) => a + b, 0); const n = rng.nextIntRange(0, sum - 1); let acc = 0; for (const k in w) { if (acc + w[k] > n) return k; acc += w[k]; } return "circle"; };
        let ss;
        if (d < 10) { const a = pick(); ss = [a, a, a, a]; }
        else if (d < 15) { const a = pick(), b = pick(); ss = [a, a, b, b]; }
        else ss = [pick(), pick(), pick(), pick()];
        let wc = 0; for (const s of ss) if (s === "windmill") ++wc;
        if (wc > 1) { ss[0] = "rect"; ss[1] = "rect"; }
        this.patch(rng, size, ss.map(s => SHORT[s] + "u").join(""));
    }
}
function tileAt(seed, x, y) {
    const ch = new Chunk(seed, Math.floor(x / MAP_CHUNK_SIZE), Math.floor(y / MAP_CHUNK_SIZE));
    return ch.lower[x - ch.tileX][y - ch.tileY];
}

const log = (...a) => console.log(...a);

async function main() {
    const SEED = 43391;
    const st = await rpc("status", {});
    if (!st.in_game) throw new Error("not in game");

    // 全新象限（之前实验用过 +x+y 与 -x-y，这次用 +x-y，且更远）
    const scan = [];
    for (let cx = -95; cx >= -140 && scan.length < 30; cx -= 3)
        for (let cy = 60; cy <= 105 && scan.length < 30; cy += 3)
            for (let lx = 2; lx < MAP_CHUNK_SIZE - 2 && scan.length < 30; lx += 4)
                for (let ly = 2; ly < MAP_CHUNK_SIZE - 2 && scan.length < 30; ly += 4) {
                    const x = cx * MAP_CHUNK_SIZE + lx, y = cy * MAP_CHUNK_SIZE + ly;
                    const s = tileAt(SEED, x, y);
                    if (s) scan.push([x, y, s]);
                }
    if (!scan.length) { log("无候选"); return; }
    const [tx, ty, predicted] = scan[Math.floor(scan.length / 2)];
    log(`目标: (${tx},${ty}) 预测 ${predicted}（距原点 ${Math.round(Math.hypot(tx, ty))} 格，全新象限）`);
    log(`>>> 注意：以下不进行任何 obs/camera —— 直接放置 <<<`);

    let placed = null, err = null;
    const t0 = Date.now();
    try { placed = await rpc("act", { op: "place", building: "miner", x: tx, y: ty, r: 0 }); }
    catch (e) { err = e.rpc || { message: e.message }; }
    const ms = Date.now() - t0;

    let verdict, after = null;
    if (placed && placed.entity_uid !== undefined) {
        log(`✅ 真·盲建成功 uid=${placed.entity_uid}（${ms}ms）`);
        await sleep(400);
        const o = await rpc("obs", { region: [tx - 3, ty - 3, tx + 3, ty + 3], include_resources: true, max_resources: 100, max_entities: 50 });
        const r = (o.resources || []).filter(z => z[0] === tx && z[1] === ty);
        const m = (o.entities || []).find(e => e.type === "miner");
        after = { resource_now: r, miner: m || null };
        log(`事后观测: 资源=${JSON.stringify(r)}  矿机=${m ? "在" : "不在"}`);
        verdict = (m && r.length && r[0][2] === predicted) ? "SUPPORTED_VERIFIED" : "SUPPORTED_UNVERIFIED";
        try { await rpc("act", { op: "delete", x: tx, y: ty }); log("✓ 已清理"); } catch (e) { log("⚠️ 清理失败", e.message); }
    } else {
        log(`❌ 盲建失败: ${JSON.stringify(err)}`);
        verdict = "REFUTED";
    }

    const p = path.join(OUT, "exp-offline-map-3.result.json");
    fs.writeFileSync(p, JSON.stringify({ hypothesis: "H3", verdict, tile: [tx, ty], predicted, latency_ms: ms, after, error: err }, null, 1));
    log(`\n=== H3 结论 ===`);
    log(verdict.startsWith("SUPPORTED")
        ? "H3 成立：完全不观测也能在预测坐标建 —— AI 可直接在离线规划的位置施工，无需探索。"
        : "H3 不成立：必须先让游戏生成 chunk 才能建。");
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
