import fs from "fs";
import { indexOf, at, isBelt } from "../../src/agent/loop/topology.mjs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { templateByBuildingVariant } from "../../src/ai/op-templates.mjs";

/**
 * 「这一格是什么」—— 人话版查询工具。
 *
 * ## 为什么需要它
 *
 * AI 内部用**句柄**（`C7` / `B159`），那是给程序看的短名。
 * 但人看截图时没有句柄，只有「左上角那个红的」「中间的圆圈」。
 *
 * 这个工具做两件事：
 *   ① 把格子翻译成**人话**：「hub 东北 47 格 · mixer（混色机）」
 *   ② 支持从**截图**反推：你指一个像素点，它告诉你那是哪一格、什么名字
 *
 * ## 用法
 *
 *   node what.mjs --map                         # 列出所有机器（人话）
 *   node what.mjs --cell -9 1                   # 查某一格叫什么
 *   node what.mjs --shot <shot.json> <px> <py>  # 从截图像素反推
 *   node what.mjs --shot <shot.json> --list     # 这张图里有哪些机器
 */
const TILE = 32;
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => { const e = [...h.byHandle.values()].find(x => x.uid === uid); return e ? e.handle : "?"; };
const hub = obs.entities.find(e => e.type === "hub");
const ore = new Map((obs.resources || []).map(r => [r[0] + "," + r[1], r[2]]));

const CN = {
    hub: "hub（交付点）", miner: "采矿机", cutter: "切割机", rotater: "旋转机",
    stacker: "堆叠机", mixer: "混色机", painter: "染色机", trash: "垃圾桶",
    balancer: "平衡器", belt: "传送带", underground_belt: "地下传送带",
};

/* 占用表按 footprint × 旋转展开 */
const occ = new Map();
for (const e of obs.entities) {
    if (e.layer !== undefined && e.layer !== "regular") continue;
    if (!Number.isInteger(e.x) || !Number.isInteger(e.y)) continue;
    let fp = [1, 1];
    try {
        const t = templateByBuildingVariant(e.type, e.variant || "default");
        if (t && Array.isArray(t.footprint)) fp = t.footprint;
    } catch { }
    const rot = (((e.r || 0) % 360) + 360) % 360;
    const sw = (rot === 90 || rot === 270);
    const w = sw ? fp[1] : fp[0], hh = sw ? fp[0] : fp[1];
    for (let dy = 0; dy < hh; dy++) for (let dx = 0; dx < w; dx++) {
        const k = (e.x + dx) + "," + (e.y + dy);
        if (!occ.has(k)) occ.set(k, { e, isOrigin: dx === 0 && dy === 0 });
    }
}

const bearing = (x, y) => {
    const dx = x - hub.x, dy = y - hub.y;
    if (dx === 0 && dy === 0) return "hub 本身";
    const ns = dy < 0 ? "北" : dy > 0 ? "南" : "";
    const ew = dx < 0 ? "西" : dx > 0 ? "东" : "";
    return `hub ${(ns && ew) ? ew + ns : (ns || ew)} ${Math.abs(dx) + Math.abs(dy)} 格`;
};

const describe = (x, y) => {
    const k = `${x},${y}`;
    const rec = occ.get(k);
    const o = ore.get(k);
    const b = bearing(x, y);
    if (!rec) return `${b} · ${o ? o + " 矿（空地）" : "空地"}`;
    const e = rec.e;
    const hd = hOf(e.uid);
    if (isBelt(e)) {
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        const d = (s && s.outputs && s.outputs[0]) ? s.outputs[0].dir : "?";
        return `${b} · 传送带 ${hd}（朝${d}）`;
    }
    const where = rec.isOrigin ? "" : `，占 ${JSON.stringify([e.x, e.y])} 起的那一片`;
    const onOre = ore.get(e.x + "," + e.y);
    return `${b} · ${CN[e.type] || e.type} ${hd}${onOre ? "（在 " + onOre + " 矿上）" : ""}${where}`;
};

const args = process.argv.slice(2);
const mode = args[0] || "--map";

if (mode === "--map") {
    console.log("=== 世界上所有机器（按离 hub 远近）===");
    const ms = obs.entities.filter(e => !isBelt(e)).sort((a, b) => {
        const da = Math.abs(a.x - hub.x) + Math.abs(a.y - hub.y);
        const db = Math.abs(b.x - hub.x) + Math.abs(b.y - hub.y);
        return da - db;
    });
    for (const e of ms) console.log("  " + describe(e.x, e.y).padEnd(58) + "[" + e.x + "," + e.y + "]");
    console.log("");
    console.log("传送带 " + obs.entities.filter(e => isBelt(e)).length + " 条（不逐条列，用 --cell 查具体格）");
} else if (mode === "--cell") {
    const x = Number(args[1]), y = Number(args[2]);
    console.log(describe(x, y) + "   [" + x + "," + y + "]");
} else if (mode === "--shot") {
    const file = args[1];
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const r = j.result || j;
    const wr = r.world_rect;
    if (!wr || !wr.px) { console.log("这张图没有 world_rect，无法反推"); process.exit(1); }
    const [px0, py0, pw, ph] = wr.px;
    const toCell = (sx, sy) => [
        Math.floor((px0 + (sx / r.css_w) * pw) / TILE),
        Math.floor((py0 + (sy / r.css_h) * ph) / TILE),
    ];
    if (args[2] === "--list") {
        const [tx, ty] = toCell(0, 0);
        const [bx, by] = toCell(r.css_w, r.css_h);
        console.log("这张图覆盖格子 (" + tx + "," + ty + ") → (" + bx + "," + by + ")");
        console.log("");
        for (const e of obs.entities.filter(e => !isBelt(e))) {
            if (e.x >= tx && e.x <= bx && e.y >= ty && e.y <= by) {
                console.log("  " + describe(e.x, e.y));
            }
        }
    } else {
        const c = toCell(Number(args[2]), Number(args[3]));
        console.log(describe(c[0], c[1]) + "   [" + c[0] + "," + c[1] + "]");
    }
} else {
    console.log("用法: --map | --cell <x> <y> | --shot <json> <px> <py> | --shot <json> --list");
}
