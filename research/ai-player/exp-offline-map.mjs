/**
 * exp-offline-map.mjs — 决定性实验：离线预测的资源格在实机可用吗？
 *
 * 假设 H1：离线（seed 推导）预测的资源格，即使游戏尚未生成该 chunk，
 *          放矿机也能成功 —— 即"离线全知规划 → 实机执行"闭环成立。
 *
 * 步骤：
 *   1. 找出一批「离线有、实机 obs 没有」的坐标（= 未生成 chunk）
 *   2. 挑一个：移动相机过去（触发 chunk 加载）→ 再 obs 确认资源是否出现
 *   3. 在预测坐标放矿机 → 检查是否成功
 *   4. 清理（删掉矿机）
 *   5. 报告：H1 成立 / 不成立 / 需要更多样本
 *
 * 用法：node research/ai-player/exp-offline-map.mjs [--keep] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "facts", "live");
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const DRY = args.includes("--dry");

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

// 与 gen-resources.mjs 相同的生成器（内联副本，避免 import 触发 CLI）
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

function generateWorld(seed, x0, y0, x1, y1) {
    const out = [];
    const c0x = Math.floor(x0 / MAP_CHUNK_SIZE), c1x = Math.floor(x1 / MAP_CHUNK_SIZE);
    const c0y = Math.floor(y0 / MAP_CHUNK_SIZE), c1y = Math.floor(y1 / MAP_CHUNK_SIZE);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
        const ch = new Chunk(seed, cx, cy);
        for (let lx = 0; lx < MAP_CHUNK_SIZE; lx++) for (let ly = 0; ly < MAP_CHUNK_SIZE; ly++)
            if (ch.lower[lx][ly]) out.push([ch.tileX + lx, ch.tileY + ly, ch.lower[lx][ly]]);
    }
    return out;
}

// ───────────────────────── 主流程 ─────────────────────────

const log = (...a) => console.log(...a);

async function main() {
    const st = await rpc("status", {});
    if (!st.in_game) throw new Error("not in game — load a save first");
    log(`status: in_game=true tick=${st.tick?.toFixed?.(0)}`);

    const world = JSON.parse(fs.readFileSync(path.join(OUT, "world-full.json"), "utf8"));
    const seed = 43391;   // 从离线解码器读出（save dump.map.seed）
    log(`map seed = ${seed}`);

    // obs 里已知的资源格
    const obsRes = new Set((world.resources || []).map(r => r[0] + "," + r[1]));
    log(`obs 已知资源格: ${obsRes.size}`);

    // 离线生成一片"远处"区域（远超当前观测范围，几乎肯定未生成）
    const far = [[], []];
    const REGIONS = [
        { x0: 200, y0: 100, x1: 260, y1: 160 },      // 右下远处
        { x0: -80, y0: -200, x1: -30, y1: -150 },    // 左上远处
    ];
    const candidates = [];
    for (const R of REGIONS) {
        const gen = generateWorld(seed, R.x0, R.y0, R.x1, R.y1);
        const fresh = gen.filter(([x, y]) => !obsRes.has(x + "," + y));
        log(`区域 [${R.x0},${R.y0},${R.x1},${R.y1}]: 离线 ${gen.length} 格，其中 obs 未知 ${fresh.length} 格`);
        if (fresh.length) candidates.push({ region: R, tiles: fresh });
    }
    if (!candidates.length) { log("没有找到未生成的预测资源格 —— 换个区域"); return; }

    const pick = candidates[0];
    const [tx, ty, tshape] = pick.tiles[Math.floor(pick.tiles.length / 2)];
    log(`\n实验目标格: (${tx},${ty}) 预测形状 = ${tshape}`);

    if (DRY) { log("[dry] 停在这里"); return; }

    // 1) 先把相机移过去（触发 chunk 生成）
    log(`移动相机到 (${tx},${ty}) ...`);
    await rpc("act", { op: "camera", x: tx, y: ty, zoom: 0.5 });
    await sleep(1500);

    // 2) 重新观测该区域，看资源是否"出现"
    const region = [tx - 8, ty - 8, tx + 8, ty + 8];
    const obs1 = await rpc("obs", { region, include_resources: true, max_resources: 2000, max_entities: 500 });
    const nowRes = (obs1.resources || []).map(r => r[0] + "," + r[1]);
    const appeared = obs1.resources && obs1.resources.some(r => r[0] === tx && r[1] === ty);
    const shapeThere = appeared ? obs1.resources.find(r => r[0] === tx && r[1] === ty)[2] : null;
    log(`观测该区域: ${(obs1.resources || []).length} 格资源；目标格现在有资源？ ${appeared}（形状 ${shapeThere}）`);
    log(`  预测 vs 实测: ${tshape} vs ${shapeThere}  → ${tshape === shapeThere ? "✅ 一致" : "❌ 不一致"}`);

    // 3) 试放矿机
    log(`\n在 (${tx},${ty}) 放矿机 ...`);
    let placed = null, placeErr = null;
    try { placed = await rpc("act", { op: "place", building: "miner", x: tx, y: ty, r: 0 }); }
    catch (e) { placeErr = e.rpc || { message: e.message }; }

    let result;
    if (placed && placed.entity_uid !== undefined) {
        log(`  ✅ 矿机放置成功 uid=${placed.entity_uid}`);
        // 读矿机，看它认为自己采的是什么
        const obs2 = await rpc("obs", { region: [tx - 1, ty - 1, tx + 2, ty + 2], max_entities: 20, include_resources: true });
        const miner = (obs2.entities || []).find(e => e.type === "miner");
        log(`  矿机观测: ${miner ? JSON.stringify(miner) : "(未找到)"}`);
        result = { hypothesis: "H1", verdict: "SUPPORTED", tile: [tx, ty], predicted: tshape, observed: shapeThere };
        if (!KEEP) {
            log("  清理：删除矿机 ...");
            try { await rpc("act", { op: "delete", x: tx, y: ty }); log("  ✓ 已删除"); }
            catch (e) { log("  ⚠️ 删除失败:", e.message); }
        }
    } else {
        log(`  ❌ 放置失败: ${JSON.stringify(placeErr)}`);
        result = { hypothesis: "H1", verdict: "REFUTED", tile: [tx, ty], predicted: tshape, error: placeErr };
    }

    // 4) 回写结果
    const p = path.join(OUT, "exp-offline-map.result.json");
    fs.writeFileSync(p, JSON.stringify({ when: new Date().toISOString(), ...result }, null, 1));
    log(`\n结果已写入 ${p}`);
    log(`\n=== 结论 ===`);
    log(result.verdict === "SUPPORTED"
        ? "H1 成立：离线预测的资源格在实机可用 → 「离线全知规划 → 实机执行」闭环可成立。"
        : "H1 不成立：离线预测的格子在实机不可用 → 需要先让游戏生成 chunk（移动相机/探索）再建。");
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
