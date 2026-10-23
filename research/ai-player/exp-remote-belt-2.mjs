/**
 * exp-remote-belt-2.mjs — H5：用**离线存档解码**验证未生成区域的长链条**物品真的在流动**。
 *
 * 思路（绕过 obs 看不到带上物品的限制）：
 *   1. 在远处未生成区域建 矿机 + 40 格传送带
 *   2. `save_now` 存档
 *   3. 用 recon/decode_full.cjs **离线解码存档**，读 `dump.beltPaths` —— 里面记录了带上物品
 *   4. 若带上出现物品 → 物品真的在流动 → 长链条在未生成区域**功能完整**
 *
 * 这同时验证了一个更有价值的能力：**存档可作为"带内物品"的观测通道**（mod 端补观测的替代方案）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "facts", "live");
const KEEP = process.argv.includes("--keep");

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

// —— 生成器（内联） ——
const MCS = 16;
function Mash() { let n = 0xefc8249d; return function (d) { d = d.toString(); for (let i = 0; i < d.length; i++) { n += d.charCodeAt(i); let h = 0.02519603282416938 * n; n = h >>> 0; h -= n; h *= n; n = h >>> 0; h -= n; n += h * 0x100000000; } return (n >>> 0) * 2.3283064365386963e-10; }; }
function mk(seed) { let c = 1; const m = Mash(); let a = m(" "), b = m(" "), d = m(" "); a -= m(seed); if (a < 0) a += 1; b -= m(seed); if (b < 0) b += 1; d -= m(seed); if (d < 0) d += 1; return function () { const t = 2091639 * a + c * 2.3283064365386963e-10; a = b; b = d; return (d = t - (c = t | 0)); }; }
class R { constructor(s) { this.r = mk(s); } n() { return this.r(); } ch(a) { return a[this.i(0, a.length)]; } i(mn, mx) { return Math.floor(this.n() * (mx - mn) + mn); } rng(mn, mx) { return this.n() * (mx - mn) + mn; } }
const cl = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const SH = { rect: "R", circle: "C", star: "S", windmill: "W" };
class C {
    constructor(seed, x, y) {
        this.x = x; this.y = y; this.tx = x * MCS; this.ty = y * MCS;
        this.l = Array.from({ length: MCS }, () => new Array(MCS).fill(null));
        const r = new R(this.x + "|" + this.y + "|" + seed);
        if (this.pre(r)) return;
        const d = Math.round(Math.hypot(this.x + 0.5, this.y + 0.5)), c = 0.9 - cl(d / 25, 0, 1) * 0.5;
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
        if (ox !== null) px = ox; if (oy !== null) py = oy;
        for (let k = 0; k <= ps; ++k) {
            const rad = Math.min(1 + k, ps), rs = rad * rad, off = (ps - k) / 2 + 2;
            const sx = r.rng(0.9, 1.1), sy = r.rng(0.9, 1.1);
            const cx = px + r.i(-off, off), cy = py + r.i(-off, off);
            for (let dx = -rad * sx - 2; dx <= rad * sx + 2; ++dx) for (let dy = -rad * sy - 2; dy <= rad * sy + 2; ++dy) {
                const X = Math.round(cx + dx), Y = Math.round(cy + dy);
                if (X >= 0 && X < MCS && Y >= 0 && Y <= MCS) { const a = dx / sx, bb = dy / sy; if (a * a + bb * bb <= rs && !this.l[X][Y]) this.l[X][Y] = item; }
            }
        }
    }
    cp(r, s, d) { const a = ["red", "green"]; if (d > 2) a.push("blue"); this.p(r, s, r.ch(a)); }
    sp(r, s, d) {
        const w = { rect: 100, circle: Math.round(50 + cl(d * 2, 0, 50)), star: Math.round(20 + cl(d, 0, 30)), windmill: Math.round(6 + cl(d / 2, 0, 20)) };
        if (d < 7) { w.star = 0; w.windmill = 0; }
        const pk = () => { const s2 = Object.values(w).reduce((a, b) => a + b, 0); const n = r.i(0, s2 - 1); let ac = 0; for (const k in w) { if (ac + w[k] > n) return k; ac += w[k]; } return "circle"; };
        let ss;
        if (d < 10) { const a = pk(); ss = [a, a, a, a]; } else if (d < 15) { const a = pk(), b = pk(); ss = [a, a, b, b]; } else ss = [pk(), pk(), pk(), pk()];
        let wc = 0; for (const s2 of ss) if (s2 === "windmill") ++wc;
        if (wc > 1) { ss[0] = "rect"; ss[1] = "rect"; }
        this.p(r, s, ss.map(s2 => SH[s2] + "u").join(""));
    }
}
const tileAt = (seed, x, y) => { const c = new C(seed, Math.floor(x / MCS), Math.floor(y / MCS)); return c.l[x - c.tx][y - c.ty]; };

const log = (...a) => console.log(...a);

async function main() {
    const SEED = 43391;
    const st = await rpc("status", {});
    if (!st.in_game) throw new Error("not in game");

    // 新的远处区域（未用过）
    let target = null;
    outer:
    for (let cx = 120; cx <= 170 && !target; cx += 2)
        for (let cy = -150; cy >= -200 && !target; cy -= 2)
            for (let lx = 2; lx < MCS - 2; lx += 3)
                for (let ly = 2; ly < MCS - 2; ly += 3) {
                    const x = cx * MCS + lx, y = cy * MCS + ly;
                    if (tileAt(SEED, x, y)) { target = [x, y, tileAt(SEED, x, y)]; break outer; }
                }
    if (!target) { log("无候选"); return; }
    const [mx, my, mshape] = target;
    log(`目标: 矿机@(${mx},${my}) 预测 ${mshape}   距原点 ${Math.round(Math.hypot(mx, my))} 格`);

    // 为了能验证"物品到达"，我们把带子接向一个 **trash**（垃圾机）——它不需要 hub，
    // 且能被观测到。但更简单的验证：让带子末端就是**终点**（物品堆在那里）。
    // 我们先建矿机 + 带，然后存档，解存档读 beltPaths。
    const beltStart = [mx + 1, my];
    const beltEnd = [mx + 30, my];

    let r1 = null;
    try { r1 = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 90 }); } catch (e) { log("矿机失败", JSON.stringify(e.rpc || e.message)); return; }
    log(`矿机 ✅ uid=${r1.entity_uid}`);
    let r2 = null;
    try { r2 = await rpc("act", { op: "place_path", building: "belt", from: beltStart, to: beltEnd }); } catch (e) { log("铺带失败", JSON.stringify(e.rpc || e.message)); return; }
    log(`传送带 ✅ applied=${r2.applied}`);

    // 快进让矿机产出并让物品走到带上
    log("快进 1200 tick ...");
    await rpc("act", { op: "step", ticks: 1200 });

    // 存档（用 save_now 让游戏写盘）
    log("存档 ...");
    const saved = await rpc("save_now", {});
    log(`已存档 internal_id=${saved.internal_id}`);

    // 离线解码存档，读 beltPaths
    const savePath = path.join(process.env.APPDATA || "", "shapez.io", "saves", `savegame-${saved.internal_id}.bin`);
    log(`解码 ${savePath} ...`);
    const { decodeSave } = require(path.join(REPO, "recon", "decode_full.cjs"));
    const { obj } = decodeSave(savePath);
    const beltPaths = obj.dump && obj.dump.beltPaths;
    log(`beltPaths keys: ${beltPaths ? Object.keys(beltPaths).join(", ") : "(无)"}`);

    // 找我们那条带（末格坐标 beltEnd）
    let found = null, itemsOnBelt = 0, itemSamples = [];
    if (beltPaths && beltPaths.items) {
        // beltPaths.items: 数组，每项 {pos, r, items: [...]}
        const arr = Array.isArray(beltPaths.items) ? beltPaths.items : Object.values(beltPaths.items);
        log(`beltPath 条目数: ${arr.length}`);
        for (const bp of arr) {
            const p = bp.pos || bp.position;
            if (!p) continue;
            const px = typeof p.x === "number" ? p.x : p[0];
            const py = typeof p.y === "number" ? p.y : p[1];
            // 带子沿 y=my 从 mx+1 到 mx+30
            if (py === my && px >= mx + 1 && px <= mx + 30) {
                const items = bp.items || [];
                itemsOnBelt += items.length;
                if (items.length) itemSamples.push({ x: px, y: py, n: items.length, sample: JSON.stringify(items[0]).slice(0, 160) });
                if (!found) found = bp;
            }
        }
    }
    log(`\n在目标带上发现 ${itemsOnBelt} 个物品，涉及 ${itemSamples.length} 格`);
    for (const s of itemSamples.slice(0, 4)) log(`  (${s.x},${s.y}) n=${s.n} 样例=${s.sample}`);

    // 也看 hub 是否变化（对照）
    log(`\nhub 库存（对照，未连接）：${JSON.stringify(obj.dump.hubGoals.storedShapes).slice(0, 200)}`);

    let verdict;
    if (itemsOnBelt > 0) {
        verdict = "SUPPORTED";
        log("\n✅ H5 成立：未生成区域的长链条上**有物品** → 物流在未生成区域**功能完整**。");
    } else {
        verdict = "INCONCLUSIVE";
        log("\n⚠️ 未在带上发现物品（可能：物品已被消耗到达末端/时间不够/beltPaths 结构解析问题）。");
        log("   这不是否证 —— 需要更精确的验证。");
    }

    if (!KEEP) {
        log("\n清理 ...");
        try { await rpc("act", { op: "bulk_delete", region: [mx - 2, my - 2, mx + 32, my + 2] }); log("✓ 已清理"); } catch (e) { log("⚠️", e.message); }
    }

    const p = path.join(OUT, "exp-remote-belt-2.result.json");
    fs.writeFileSync(p, JSON.stringify({ hypothesis: "H5", verdict, tile: [mx, my], predicted: mshape, items_on_belt: itemsOnBelt, item_samples: itemSamples.slice(0, 5), keep: KEEP }, null, 1));
    log(`\n写入 ${p}`);
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
