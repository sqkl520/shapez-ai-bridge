/**
 * exp-remote-belt.mjs — 实验 H4：未生成区域的**长链条**能工作吗？
 *
 * 这是「离线全知规划 → 实机直接施工」的**真正边界测试**。
 * H1/H2/H3 只证明了"放一个矿机"可行。真正要建工厂，需要：
 *   矿机 → 一长串传送带（跨越多个从未生成的 chunk）→ hub（或某个落点）
 *   并且**物品真的能流动**（不是只有建筑摆在那）。
 *
 * 设计：
 *   1. 选一个远处（>1000 格）的离线预测资源格
 *   2. 建：矿机 + 一条 ~40 格长的传送带（跨越 ≥3 个 chunk）
 *   3. **不移动相机**（保持 chunk 未渲染）
 *   4. `step` 快进若干 tick，观测传送带上是否出现物品（用 obs 看该带末端附近）
 *   5. 结论：长链在未生成区域是否可工作
 *
 * 用法：node research/ai-player/exp-remote-belt.mjs [--keep]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
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

// —— 生成器（内联，同源） ——
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

    // 找一个远处资源格，并且它的正右方能铺 40 格带（避开其他资源？其实带上可以压资源㮳? 不——带上会占用 regular 层，资源在 lower 层，所以可以！）
    let target = null;
    outer:
    for (let cx = -160; cx <= -110 && !target; cx += 2)
        for (let cy = -60; cy >= -110 && !target; cy -= 2)
            for (let lx = 2; lx < MCS - 2; lx += 3)
                for (let ly = 2; ly < MCS - 2; ly += 3) {
                    const x = cx * MCS + lx, y = cy * MCS + ly;
                    if (tileAt(SEED, x, y)) { target = [x, y, tileAt(SEED, x, y)]; break outer; }
                }
    if (!target) { log("无候选"); return; }
    const [mx, my, mshape] = target;
    log(`目标: 矿机@(${mx},${my}) 预测 ${mshape}   距原点 ${Math.round(Math.hypot(mx, my))} 格`);

    // 传送带：从矿机右侧 2 格开始，向右铺 40 格（跨越 ≥3 个 chunk）
    const beltStart = [mx + 1, my];
    const beltEnd = [mx + 40, my];
    log(`传送带: (${beltStart}) → (${beltEnd})（40 格，跨越 chunk ${Math.floor(mx / 16)}..${Math.floor((mx + 40) / 16)}）`);
    log(`>>> 全程不移动相机 <<<`);

    // 1) 放矿机（rot 90 = 向右喷）
    let r1 = null, e1 = null;
    try { r1 = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 90 }); } catch (e) { e1 = e.rpc || { message: e.message }; }
    log(`矿机: ${r1 && r1.entity_uid !== undefined ? "✅ uid=" + r1.entity_uid : "❌ " + JSON.stringify(e1)}`);
    if (!r1 || r1.entity_uid === undefined) { log("矿机失败，中止"); return; }

    // 2) 铺带
    let r2 = null, e2 = null;
    try { r2 = await rpc("act", { op: "place_path", building: "belt", from: beltStart, to: beltEnd }); } catch (e) { e2 = e.rpc || { message: e.message }; }
    log(`传送带: ${r2 ? `✅ applied=${r2.applied}/${41}${r2.failed && r2.failed.length ? " failed=" + r2.failed.length : ""}` : "❌ " + JSON.stringify(e2)}`);
    if (!r2 || !r2.applied) { log("铺带失败，中止"); return; }

    // 3) 快进，看物品会不会流动 —— 关键：检查**末端**（离矿机 40 格）
    const probe = async label => {
        const o = await rpc("obs", { region: [beltEnd[0] - 8, beltEnd[1] - 3, beltEnd[0] + 3, beltEnd[1] + 3], max_entities: 200, include_resources: false });
        const ents = (o.entities || []).filter(e => e.type === "belt");
        return { label, belt_count: ents.length, sample: ents.slice(0, 3) };
    };

    log(`\n快进 900 tick（约 15 秒游戏时间）...`);
    const t0 = Date.now();
    let stepped = null, e3 = null;
    try { stepped = await rpc("act", { op: "step", ticks: 900, collect: true }); } catch (e) { e3 = e.rpc || { message: e.message }; }
    log(`step: ${stepped ? `✅ met=${stepped.met} ticks_run=${stepped.ticks_run} (${Date.now() - t0}ms)` : "❌ " + JSON.stringify(e3)}`);

    // 4) 观测末端区域 —— 物品在 obs 里看不到（obs 只列建筑），所以改用一个代理指标：
    //    "传送带是否被占用" 需要 mod 支持；这里我们检查**矿机是否在工作 + 带子是否还在**。
    const after = await rpc("obs", { region: [mx - 2, my - 2, mx + 42, my + 2], max_entities: 300, include_resources: true, max_resources: 100 });
    const belts = (after.entities || []).filter(e => e.type === "belt");
    const miner = (after.entities || []).find(e => e.type === "miner");
    log(`\n事后观测: 带子 ${belts.length} 条（期望 41），矿机 ${miner ? "在" : "不在"}`);
    const res = (after.resources || []).filter(r => r[0] === mx && r[1] === my);
    log(`资源格仍在: ${JSON.stringify(res)}`);

    // 5) 间接证据：如果物品流动正常，矿机会持续产出——但我们没法直接读带上的物品。
    //    用 step 的 collect 观测（如果有 entities）或 hub 交付变化来判断链是否"活"。
    //    这里如实报告我们能测到什么、测不到什么。
    let verdict, notes = [];
    if (belts.length >= 40) {
        notes.push("41 格带子全部建成（跨越多个未生成 chunk）");
        verdict = "PARTIAL_PASS";
        notes.push("⚠️ 物品流动无法用当前 obs 直接验证（obs 只列建筑，不列带上物品）");
        notes.push("→ 需要 mod 增加 'belt contents' 观测，或把带子接到 hub 看交付");
    } else {
        verdict = "FAIL";
        notes.push(`只有 ${belts.length} 格带子建成`);
    }

    if (!KEEP) {
        log("\n清理 ...");
        try { await rpc("act", { op: "bulk_delete", region: [mx - 2, my - 2, mx + 42, my + 2] }); log("✓ 已清理"); }
        catch (e) { log("⚠️ 清理失败:", e.message); }
    }

    const p = path.join(OUT, "exp-remote-belt.result.json");
    fs.writeFileSync(p, JSON.stringify({ hypothesis: "H4", verdict, tile: [mx, my], predicted: mshape, belt_applied: r2.applied, belts_after: belts.length, notes, keep: KEEP }, null, 1));
    log(`\n=== H4 结论 ===`);
    log(`${verdict}: ${notes.join("\n  ")}`);
    log(`\n${verdict === "PARTIAL_PASS"
        ? "长链条的**建造**在未生成区域可行。但「物品是否真的流动」需要 mod 增加观测才能验证——这是下一阶段的明确待办。"
        : "长链条建造在未生成区域**不完整**。"}`);
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
