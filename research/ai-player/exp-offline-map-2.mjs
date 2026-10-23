/**
 * exp-offline-map-2.mjs — 强版本实验：**不移动相机**，直接在被预测的"从未生成" chunk 上放矿机。
 *
 * H2：离线预测的坐标，无需先生成 chunk，直接放建筑即成功（游戏会按需生成）。
 *      若成立 → AI 可以直接"盲建"在任意离线预测的资源上，不需要先探索。
 *
 * 与 exp-offline-map.mjs 的区别：**跳过 camera 步骤**。
 * 为了确保目标 chunk 真的从未生成，选一个**极远**的坐标（>1000 格）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "facts", "live");

let rpcId = 1;
async function rpc(method, params = {}, timeoutMs = 240000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) { const e = new Error(body.error.message); e.rpc = body.error; throw e; }
    return body.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// —— 生成器（与 gen-resources.mjs 同源；这里为了独立可执行做了内联精简） ——
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
    const lx = x - ch.tileX, ly = y - ch.tileY;
    return ch.lower[lx][ly];
}

const log = (...a) => console.log(...a);

async function main() {
    const SEED = 43391;
    const st = await rpc("status", {});
    if (!st.in_game) throw new Error("not in game");

    // 扫描远处区域，找一个确有资源的格（patch 生成率约 25%/chunk，远处更难）
    const MIN_DIST = 500;
    const scan = [];
    for (let cx = 40; cx <= 90 && scan.length < 40; cx += 3) {
        for (let cy = 40; cy <= 90 && scan.length < 40; cy += 3) {
            for (let lx = 2; lx < MAP_CHUNK_SIZE - 2 && scan.length < 40; lx += 3) {
                for (let ly = 2; ly < MAP_CHUNK_SIZE - 2 && scan.length < 40; ly += 3) {
                    const x = cx * MAP_CHUNK_SIZE + lx, y = cy * MAP_CHUNK_SIZE + ly;
                    if (Math.hypot(x, y) < MIN_DIST) continue;
                    const s = tileAt(SEED, x, y);
                    if (s) scan.push([x, y, s]);
                }
            }
        }
    }
    log(`远处扫描找到 ${scan.length} 个有资源的候选（距离 > ${MIN_DIST}）`);
    if (!scan.length) { log("没找到候选"); return; }
    const [tx, ty, predicted] = scan[Math.floor(scan.length / 2)];
    log(`\n目标: (${tx},${ty}) 预测 ${predicted}（距离原点 ~${Math.round(Math.hypot(tx, ty))} 格）`);

    // 关键：**不移动相机**。直接观测该点（如果 chunk 未生成，obs 应该看不到资源）
    const before = await rpc("obs", { region: [tx - 4, ty - 4, tx + 4, ty + 4], include_resources: true, max_resources: 200, max_entities: 100 });
    const seenBefore = (before.resources || []).some(r => r[0] === tx && r[1] === ty);
    log(`放置前观测该点有资源？ ${seenBefore}  （false = chunk 确实未生成）`);

    // 直接放矿机
    let placed = null, err = null;
    try { placed = await rpc("act", { op: "place", building: "miner", x: tx, y: ty, r: 0 }); }
    catch (e) { err = e.rpc || { message: e.message }; }

    let verdict;
    if (placed && placed.entity_uid !== undefined) {
        log(`✅ 盲建成功 uid=${placed.entity_uid}`);
        // 事后观测确认
        await sleep(500);
        const after = await rpc("obs", { region: [tx - 4, ty - 4, tx + 4, ty + 4], include_resources: true, max_resources: 200, max_entities: 100 });
        const seenAfter = after.resources ? after.resources.filter(r => r[0] === tx && r[1] === ty) : [];
        log(`放置后观测该点: ${JSON.stringify(seenAfter)}`);
        verdict = seenAfter.length && seenAfter[0][2] === predicted ? "SUPPORTED_AND_VERIFIED" : "SUPPORTED";
        log("清理 ...");
        try { await rpc("act", { op: "delete", x: tx, y: ty }); log("✓ 已删除"); } catch (e) { log("⚠️ 删除失败", e.message); }
    } else {
        log(`❌ 放置失败: ${JSON.stringify(err)}`);
        verdict = "REFUTED";
    }

    const p = path.join(OUT, "exp-offline-map-2.result.json");
    fs.writeFileSync(p, JSON.stringify({ hypothesis: "H2", verdict, tile: [tx, ty], predicted, seen_before: seenBefore, error: err }, null, 1));
    log(`\n写入 ${p}`);
    log(`\n=== H2 结论 ===`);
    log(verdict.startsWith("SUPPORTED")
        ? "H2 成立：可以**盲建**在离线预测的远处资源上，无需先探索。AI 的离线规划可直接落到执行。"
        : "H2 不成立：必须先生成 chunk（移动相机或靠近）才能在其上建。AI 需在规划里加一步'探索/生成'。");
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
