/**
 * exp-m1b-line.mjs — M1 加强版：**看到切割产物在两条输出带上排队**。
 *
 * 与 m1 的区别：输出带加长到 8 格，trash 放在最远端。
 * 这样物品会在带上累积，离线解码存档能**逐格看到**左列/右列产物。
 *
 * 布局（全部按已核证几何）：
 *   miner (mx,my) r=0                      输出朝上
 *   belt  (mx,my-1)..(mx,my-2)  r=0        进料（向上）
 *   cutter (mx,my-3) 占 (mx,my-3)+(mx+1,my-3)，输入=左格 bottom（来自下方带）✓
 *   belt  (mx,my-4)..(mx,my-11)            出料槽0（左格）→ 应为「左列」----RuRu
 *   belt  (mx+1,my-4)..(mx+1,my-11)        出料槽1（右格）→ 应为「右列」RuRu----
 *   trash (mx,my-12) 与 (mx+1,my-12)       吸收
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BASE = "http://127.0.0.1:7777"; let id = 1;
async function rpc(m, a = {}) {
  const r = await fetch(BASE + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: a }), signal: AbortSignal.timeout(240000) });
  const b = await r.json(); if (b.error) { const e = new Error(b.error.message); e.rpc = b.error; throw e; } return b.result;
}
const log = (...a) => console.log(...a);

async function main() {
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const ents = world.entities || [];
  const baseline = ents.length;

  let target = null, bestD = 0;
  for (const [x, y, s] of res) {
    if (s !== "RuRuRuRu" || Math.hypot(x, y) < 60) continue;
    let m = 1e9;
    for (const e of ents) { const d = Math.hypot(e.x - x, e.y - y); if (d < m) m = d; if (m < 70) break; }
    if (m < 70) continue;
    if (m > bestD) { bestD = m; target = [x, y]; }
  }
  if (!target) { log("no candidate"); return; }
  const [mx, my] = target;
  log(`资源 RuRuRuRu @ (${mx},${my})  距最近实体 ${Math.round(bestD)} 格，世界基线 ${baseline}`);

  const cutY = my - 3, outEnd = my - 11, trashY = my - 12;
  const region = [mx - 3, trashY - 2, mx + 5, my + 2];
  const pre = await rpc("obs", { region, max_entities: 80 });
  if ((pre.entities || []).length) { log("区域非空:", (pre.entities || []).length); return; }
  log("✓ 区域无实体");

  const r = {};
  r.miner = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 0 });
  r.feed = await rpc("act", { op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, cutY + 1] });
  r.cutter = await rpc("act", { op: "place", building: "cutter", x: mx, y: cutY, r: 0 });
  r.outA = await rpc("act", { op: "place_path", building: "belt", from: [mx, cutY - 1], to: [mx, outEnd] });
  r.outB = await rpc("act", { op: "place_path", building: "belt", from: [mx + 1, cutY - 1], to: [mx + 1, outEnd] });
  r.trashA = await rpc("act", { op: "place", building: "trash", x: mx, y: trashY, r: 0 });
  r.trashB = await rpc("act", { op: "place", building: "trash", x: mx + 1, y: trashY, r: 0 });
  log(`建成：矿机+进料带(${r.feed.applied})+切割机+出料带A(${r.outA.applied})+出料带B(${r.outB.applied})+2 trash`);

  const o1 = await rpc("obs", { region, max_entities: 80 });
  log(`产线共 ${(o1.entities || []).length} 个实体`);

  log("快进 3000 tick（让产物在带上排队）...");
  await rpc("act", { op: "step", ticks: 3000 });
  const saved = await rpc("save_now", {});
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const { obj } = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${saved.internal_id}.bin`));
  const pos = new Map();
  for (const e of (obj.dump.entities || [])) { const s = e.components?.StaticMapEntity; if (s && typeof e.uid === "number") pos.set(e.uid, { x: s.origin.x, y: s.origin.y }); }

  const rows = [];
  for (const k of Object.keys(obj.dump.beltPaths)) {
    const e = obj.dump.beltPaths[k]; if (!e || !Array.isArray(e.entityPath)) continue;
    for (const uid of e.entityPath) {
      const q = pos.get(uid); if (!q) continue;
      if (q.x >= mx - 1 && q.x <= mx + 2 && q.y >= trashY - 1 && q.y <= my) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) });
        break;
      }
    }
  }
  log("\n★ 逐格物品（离线解码存档）：");
  for (const s of rows.sort((a, b) => a.x - b.x || b.y - a.y)) {
    const tag = s.x === mx ? "槽0/进料" : s.x === mx + 1 ? "槽1" : "";
    log(`  (${s.x},${s.y}) ${tag.padEnd(8)} ${s.items.slice(0, 5).join(" ") || "—"}`);
  }

  const left = rows.filter(s => s.x === mx).flatMap(s => s.items);
  const right = rows.filter(s => s.x === mx + 1).flatMap(s => s.items);
  const okLeft = left.some(i => i.startsWith("----"));
  const okRight = right.some(i => i.startsWith("RuRu"));
  log(`\n左列带（槽0）: ${[...new Set(left)].join(" ") || "(空)"}   → 期望含 ----RuRu  ${okLeft ? "✅" : "❌"}`);
  log(`右列带（槽1）: ${[...new Set(right)].join(" ") || "(空)"}   → 期望含 RuRu----  ${okRight ? "✅" : "❌"}`);

  const pass = okLeft && okRight;
  log(`\n=== M1b: ${pass ? "✅ PASS —— 两条输出带分别承载「左列/右列」两种产物（与源码预测一致）" : "⚠️ 未完全达成（见上）"} ===`);

  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region });
  const chk = await rpc("obs", { region, max_entities: 20 });
  const after = await rpc("obs", { max_entities: 1 });
  log(`bulk_delete=${del.applied}  残留=${(chk.entities || []).length}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️"}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m1b-line.result.json",
    JSON.stringify({ milestone: "M1b", pass, site: [mx, my], belts: rows, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
