/**
 * exp-remote-belt-3.mjs — H5b：正确解析 beltPaths（用 entityPath 里的 uid 定位），
 * 验证未生成区域的长链条**物品是否真的流动**。
 *
 * 上一版的 bug：beltPaths 的条目结构是 {entityPath: [uid...], items: [[offset, item]...], spacingToFirstItem}，
 * **没有 pos 字段** —— 需先用 dump.entityMgr.entities 把 uid → (x,y) 映射出来。
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

/** 从存档建 uid → (x,y) 映射 */
function uidToPos(obj) {
    const map = new Map();
    // 实测：dump.entityMgr 只有 nextUid；实体列表在 dump.entities
    const ents = (obj.dump && (obj.dump.entities || (obj.dump.entityMgr && obj.dump.entityMgr.entities))) || [];
    if (!Array.isArray(ents)) return map;
    for (const e of ents) {
        const sme = e.components && e.components.StaticMapEntity;
        if (sme && typeof e.uid === "number") {
            map.set(e.uid, { x: sme.origin.x, y: sme.origin.y, code: sme.code });
        }
    }
    return map;
}

async function main() {
    const SEED = 43391;
    const st = await rpc("status", {});
    if (!st.in_game) throw new Error("not in game");

    // 新的远处区域
    let target = null;
    outer:
    for (let cx = -60; cx >= -105 && !target; cx -= 2)
        for (let cy = 150; cy <= 195 && !target; cy += 2)
            for (let lx = 2; lx < MCS - 2; lx += 3)
                for (let ly = 2; ly < MCS - 2; ly += 3) {
                    const x = cx * MCS + lx, y = cy * MCS + ly;
                    if (tileAt(SEED, x, y)) { target = [x, y, tileAt(SEED, x, y)]; break outer; }
                }
    if (!target) { log("无候选"); return; }
    const [mx, my, mshape] = target;
    log(`矿机@(${mx},${my}) 预测 ${mshape}  距原点 ${Math.round(Math.hypot(mx, my))} 格`);

    const beltStart = [mx + 1, my], beltEnd = [mx + 24, my];

    const r1 = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 90 });
    log(`矿机 uid=${r1.entity_uid}`);
    const r2 = await rpc("act", { op: "place_path", building: "belt", from: beltStart, to: beltEnd });
    log(`带子 applied=${r2.applied}  uid_first=${r2.first_uid}`);

    // 建**第二条**对照带：在 hub 附近的已生成区域，同样的结构 —— 用来区分"step 不推进带"还是"未生成区域不推进带"
    // 简化：hub 在 (-2,-2)。在 (5,-2) 放矿机+带（那里是预置 RuRuRuRu 资源！）
    log("\n对照组合（hub 附近已生成区域）：矿机@(5,-2) + 带 (6,-2)→(20,-2)");
    let ctrl = null;
    try {
        const c1 = await rpc("act", { op: "place", building: "miner", x: 5, y: -2, r: 90 });
        const c2 = await rpc("act", { op: "place_path", building: "belt", from: [6, -2], to: [20, -2] });
        ctrl = { miner: c1.entity_uid, applied: c2.applied };
        log(`对照组: 矿机 uid=${c1.entity_uid} 带 applied=${c2.applied}`);
    } catch (e) { log(`对照组建失败: ${JSON.stringify(e.rpc || e.message)}`); }

    log("\n快进 2000 tick ...");
    await rpc("act", { op: "step", ticks: 2000 });

    log("存档 ...");
    const saved = await rpc("save_now", {});
    const savePath = path.join(process.env.APPDATA || "", "shapez.io", "saves", `savegame-${saved.internal_id}.bin`);

    const { decodeSave } = require(path.join(REPO, "recon", "decode_full.cjs"));
    const { obj } = decodeSave(savePath);
    const pos = uidToPos(obj);
    log(`uid→pos 映射: ${pos.size} 个实体`);

    const bp = obj.dump.beltPaths;
    const analyze = (x0, y0, x1, y1, label) => {
        let paths = 0, withItems = 0, totalItems = 0, sample = null;
        for (const k of Object.keys(bp)) {
            const e = bp[k];
            if (!e || !Array.isArray(e.entityPath)) continue;
            // entityPath 里任一 uid 落在窗口内即算
            let hit = false;
            for (const uid of e.entityPath) {
                const p = pos.get(uid);
                if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) { hit = true; break; }
            }
            if (!hit) continue;
            paths++;
            const n = (e.items || []).length;
            totalItems += n;
            if (n > 0) { withItems++; if (!sample) sample = { path_len: e.entityPath.length, items: n, item0: JSON.stringify(e.items[0]).slice(0, 120) }; }
        }
        log(`[${label}] 路径数=${paths}  有物品的=${withItems}  物品总数=${totalItems}`);
        if (sample) log(`   样例: ${JSON.stringify(sample)}`);
        return { paths, withItems, totalItems, sample };
    };

    const remote = analyze(mx - 2, my - 2, mx + 26, my + 2, "远端（未生成区域）");
    const control = ctrl ? analyze(4, -4, 22, 0, "对照（hub 附近）") : null;

    let verdict;
    if (remote.withItems > 0) { verdict = "SUPPORTED"; log("\n✅ H5b 成立：远端未生成区域的带子上**有物品** → 物流功能完整。"); }
    else if (control && control.withItems > 0) { verdict = "REFUTED"; log("\n❌ H5b 否证：对照组有物品、远端没有 → **未生成区域不推进物流**。AI 必须先让区域生成。"); }
    else { verdict = "INCONCLUSIVE"; log("\n⚠️ 两组都没物品 → 可能是 step/save 时序问题，需要再设计实验。"); }

    // 清理
    if (!KEEP) {
        log("\n清理 ...");
        try { await rpc("act", { op: "bulk_delete", region: [mx - 2, my - 2, mx + 26, my + 2] }); } catch (e) { log("远端清理:", e.message); }
        if (ctrl) { try { await rpc("act", { op: "bulk_delete", region: [4, -4, 22, 0] }); } catch (e) { log("对照清理:", e.message); } }
        log("✓ 已清理");
    }

    const p = path.join(OUT, "exp-remote-belt-3.result.json");
    fs.writeFileSync(p, JSON.stringify({ hypothesis: "H5b", verdict, remote, control, tile: [mx, my], predicted: mshape, keep: KEEP }, null, 1));
    log(`\n写入 ${p}`);
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
