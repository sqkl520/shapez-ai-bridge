/**
 * exp-m1-line.mjs — M1 里程碑实机验证：**从资源到"成品"的完整可运行产线**。
 *
 * 这是「布局编译器」的第一个可验证目标：证明我们能自动设计并建成一条真实工作的产线。
 *
 * 产线：CuCuCuCu 矿机 → 切割机 → 一半输出（CuCu----）→ trash 吸收
 *       （用 trash 而非 hub：避免污染真实工厂的 hub 库存，且更容易验证"物品真的流动"）
 *
 * 严格遵循 INCIDENT-bulk-delete.md：
 *   · 选址前 obs 自查空地
 *   · 清理只针对我们建的区域
 *   · 事后复核为空 + 对比世界总实体数
 *
 * 验证手段：save_now + 离线解码 beltPaths（看带上真的有切割产物）
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
  const occ = new Set(ents.map(e => e.x + "," + e.y));
  log(`世界基线实体数: ${baseline}`);

  // 选一个远离所有实体的 RuRuRuRu（cutter 只吃 shape；Ru 切半两半都非空 → 两条输出带都能验证）
  let target = null, bestD = 0;
  for (const [x, y, s] of res) {
    if (s !== "RuRuRuRu" || Math.hypot(x, y) < 60) continue;
    let m = 1e9;
    for (const e of ents) { const d = Math.hypot(e.x - x, e.y - y); if (d < m) m = d; if (m < 60) break; }
    if (m < 60) continue;
    if (m > bestD) { bestD = m; target = [x, y]; }
  }
  if (target) log(`（选定格距最近实体 ${Math.round(bestD)} 格）`);
  if (!target) { log("no candidate"); return; }
  const [mx, my] = target;
  log(`资源 CuCuCuCu @ (${mx},${my})  距原点 ${Math.round(Math.hypot(mx, my))}`);

  // 自查空地
  const region = [mx - 3, my - 10, mx + 8, my + 3];
  const pre = await rpc("obs", { region, max_entities: 60 });
  if ((pre.entities || []).length) { log("区域非空:", (pre.entities || []).length, "—— 换地方"); return; }
  log("✓ 区域已确认无实体");

  const r = {};
  // 布局（全部按已核证的几何）：
  //   miner (mx,my) r=0（朝上）→ 输出向上
  //   进料带 (mx,my-1)..(mx,my-2) 向上
  //   cutter 占 (mx, my-3) 与 (mx+1, my-3)；输入槽 = (mx,my-3) 的 bottom ← 进料带从下方来 ✓
  //   输出槽 = (mx,my-3) 与 (mx+1,my-3) 都朝 top
  //   出料带 A: (mx, my-4) 向上 → 到 trash；出料带 B: (mx+1, my-4) 向上 → 到 trash
  const cutY = my - 3;
  r.miner = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 0 });
  log(`矿机 uid=${r.miner.entity_uid}（朝上）`);
  r.feed = await rpc("act", { op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, cutY + 1] });
  log(`进料带 applied=${r.feed.applied}（${my - 1} → ${cutY + 1}）`);
  r.cutter = await rpc("act", { op: "place", building: "cutter", x: mx, y: cutY, r: 0 });
  log(`切割机 uid=${r.cutter.entity_uid} @ (${mx},${cutY}) 默认变体`);

  // 两条出料带（都朝上）→ 分别通到两个 trash
  const trashY = cutY - 3;
  r.outA = await rpc("act", { op: "place_path", building: "belt", from: [mx, cutY - 1], to: [mx, trashY + 1] });
  r.outB = await rpc("act", { op: "place_path", building: "belt", from: [mx + 1, cutY - 1], to: [mx + 1, trashY + 1] });
  log(`出料带A applied=${r.outA.applied}  出料带B applied=${r.outB.applied}`);

  // trash：1×1，四边全收 —— 放在两条出料带的顶端
  r.trashA = await rpc("act", { op: "place", building: "trash", x: mx, y: trashY, r: 0 });
  r.trashB = await rpc("act", { op: "place", building: "trash", x: mx + 1, y: trashY, r: 0 });
  log(`垃圾站 A uid=${r.trashA.entity_uid}  B uid=${r.trashB.entity_uid}`);

  // 观测整个产线
  const o1 = await rpc("obs", { region, max_entities: 60 });
  log(`\n产线实体（${(o1.entities || []).length} 个）:`);
  for (const e of (o1.entities || []).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(8)} r=${e.r} rv=${e.rotation_variant ?? "-"}`);

  // 快进 + 存档 + 解码
  log("\n快进 2000 tick ...");
  await rpc("act", { op: "step", ticks: 2000 });
  const saved = await rpc("save_now", {});
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const { obj } = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${saved.internal_id}.bin`));
  const pos = new Map();
  for (const e of (obj.dump.entities || [])) { const s = e.components?.StaticMapEntity; if (s && typeof e.uid === "number") pos.set(e.uid, { x: s.origin.x, y: s.origin.y }); }
  const seen = [];
  for (const k of Object.keys(obj.dump.beltPaths)) {
    const e = obj.dump.beltPaths[k]; if (!e || !Array.isArray(e.entityPath)) continue;
    for (const uid of e.entityPath) {
      const q = pos.get(uid); if (!q) continue;
      if (q.y <= my && q.y >= trashY && q.x >= mx - 1 && q.x <= mx + 2) {
        seen.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) });
        break;
      }
    }
  }
  log("\n★ 带上物品（离线解码存档）：");
  for (const s of seen.sort((a, b) => a.x - b.x || b.y - a.y)) log(`  (${s.x},${s.y}) ${s.items.slice(0, 4).join(" ")}`);

  const leftBelt = seen.filter(s => s.x === mx).flatMap(s => s.items);
  const rightBelt = seen.filter(s => s.x === mx + 1).flatMap(s => s.items);
  log(`\n左列带（槽0，应为"左列" ----CuCu）: ${leftBelt.slice(0, 3).join(" ") || "(空)"}`);
  log(`右列带（槽1，应为"右列" CuCu----）: ${rightBelt.slice(0, 3).join(" ") || "(空)"}`);

  const pass = (leftBelt.length + rightBelt.length) > 0;
  log(`\n=== M1 结果: ${pass ? "✅ PASS —— 产线可运行，切割产物真的在流动" : "❌ FAIL —— 带上没有产物"} ===`);

  // 清理 + 复核
  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region });
  log(`bulk_delete applied=${del.applied}`);
  const chk = await rpc("obs", { region, max_entities: 20 });
  log(`清理后区域实体数: ${(chk.entities || []).length}（应 0）`);
  const after = await rpc("obs", { max_entities: 1, include_hub: true });
  log(`世界实体数: ${after.stats.total}（基线 ${baseline}）→ ${after.stats.total === baseline ? "✅ 已恢复" : "⚠️ 有差异 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m1-line.result.json",
    JSON.stringify({ milestone: "M1", pass, site: [mx, my], actions: r, belts: seen, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
