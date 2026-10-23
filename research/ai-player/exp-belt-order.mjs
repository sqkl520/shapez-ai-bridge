/**
 * exp-belt-order.mjs — 验证：蓝图粘贴时，传送带的**拐角变体**是否正确？
 *
 * 背景：belt.js:161 的自动定向只看邻居。若粘贴顺序是"乱序"，拐角可能算错。
 * 但我们的 paste 显式传 rot（opPasteBlueprint）——那么 rotationVariant 呢？
 * 关键问题（对"用蓝图落地布局"至关重要）：蓝图能否完整保留带子形状？
 */
import fs from "node:fs";
const BASE = "http://127.0.0.1:7777"; let id = 1;
async function rpc(m, a = {}) {
  const r = await fetch(BASE + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: a }), signal: AbortSignal.timeout(240000) });
  const b = await r.json(); if (b.error) { const e = new Error(b.error.message); e.rpc = b.error; throw e; } return b.result;
}
const log = (...a) => console.log(...a);

async function findEmpty(x, y, w, h) {
  for (let tries = 0; tries < 25; tries++) {
    const X = x + tries * 40;
    const o = await rpc("obs", { region: [X - 2, y - 2, X + w + 2, y + h + 2], max_entities: 20 });
    if ((o.entities || []).length === 0) return [X, y];
  }
  return null;
}

async function main() {
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const ents = world.entities || [];
  const nearEnt = (x, y, r = 20) => ents.some(e => Math.hypot(e.x - x, e.y - y) < r);

  // 找远处、且远离已建工厂的 RuRuRuRu
  let target = null;
  for (const [x, y, s] of res) {
    if (s === "RuRuRuRu" && Math.hypot(x, y) > 120 && !nearEnt(x, y)) { target = [x, y]; break; }
  }
  if (!target) { log("no clean Ru found"); return; }
  const [mx, my] = target;
  log(`资源 (${mx},${my}) RuRuRuRu  —— 距原点 ${Math.round(Math.hypot(mx, my))}`);

  // 自查空
  const pre = await rpc("obs", { region: [mx - 3, my - 8, mx + 8, my + 3], max_entities: 40 });
  if ((pre.entities || []).length) { log("区域非空，中止:", (pre.entities || []).length); return; }
  log("区域已确认无实体");

  const r = {};
  r.miner = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 90 });
  log(`矿机 uid=${r.miner.entity_uid}（朝右）`);
  r.b1 = await rpc("act", { op: "place_path", building: "belt", from: [mx + 1, my], to: [mx + 3, my] });
  log(`水平带 applied=${r.b1.applied}`);
  r.b2 = await rpc("act", { op: "place_path", building: "belt", from: [mx + 3, my - 1], to: [mx + 3, my - 3] });
  log(`垂直带 applied=${r.b2.applied}`);

  const o1 = await rpc("obs", { region: [mx, my - 4, mx + 5, my + 2], max_entities: 40 });
  const belts = (o1.entities || []).filter(e => e.type === "belt").sort((a, b) => b.y - a.y || a.x - b.x);
  log("\n★ 原地产线（重点看拐角格）：");
  for (const b of belts) log(`  (${b.x},${b.y}) r=${b.r} rv=${b.rotation_variant}${b.x === mx + 3 && b.y === my ? "   ← 拐角格" : ""}`);

  // 导出 → 远处粘贴
  const exp = await rpc("act", { op: "export_blueprint", region: [mx, my - 4, mx + 5, my + 2] });
  const text = exp.blueprint || exp.text || exp.blueprint_text;
  log(`\n蓝图长度 ${text ? text.length : 0}`);

  const site = await findEmpty(mx + 80, my + 80, 8, 8);
  if (!site) { log("no paste site"); return; }
  const [px, py] = site;
  const paste = await rpc("act", { op: "paste_blueprint", text, x: px, y: py, charge: false });
  log(`粘贴 applied=${paste.applied} failed=${(paste.failed || []).length}`);

  const o2 = await rpc("obs", { region: [px - 1, py - 5, px + 7, py + 3], max_entities: 40 });
  const belts2 = (o2.entities || []).filter(e => e.type === "belt").sort((a, b) => b.y - a.y || a.x - b.x);
  log("\n★ 粘贴产物：");
  for (const b of belts2) log(`  (${b.x},${b.y}) r=${b.r} rv=${b.rotation_variant}`);

  // 归一化对比（用各自的 min x / max y 作为锚）
  const norm = (arr, ox, oy) => arr.map(b => `${b.x - ox},${b.y - oy}:r${b.r}v${b.rotation_variant}`).sort();
  const ax = Math.min(...belts.map(b => b.x)), ay = Math.max(...belts.map(b => b.y));
  const bx = Math.min(...belts2.map(b => b.x)), by = Math.max(...belts2.map(b => b.y));
  const n1 = norm(belts, ax, ay), n2 = norm(belts2, bx, by);
  log("\n归一化对比：");
  log("  原地:", JSON.stringify(n1));
  log("  粘贴:", JSON.stringify(n2));
  const same = JSON.stringify(n1) === JSON.stringify(n2);
  log(`  → ${same ? "✅ 完全一致：蓝图完整保留了 r/rotation_variant" : "⚠️ 不一致 —— 蓝图未保留带子变体（对布局落地是重大问题）"}`);

  log("\n清理...");
  await rpc("act", { op: "bulk_delete", region: [mx - 4, my - 9, mx + 9, my + 3] });
  await rpc("act", { op: "bulk_delete", region: [px - 3, py - 7, px + 9, py + 4] });
  const chk1 = await rpc("obs", { region: [mx - 4, my - 9, mx + 9, my + 3], max_entities: 10 });
  const chk2 = await rpc("obs", { region: [px - 3, py - 7, px + 9, py + 4], max_entities: 10 });
  log(`清理后：原地 ${(chk1.entities || []).length} / 粘贴点 ${(chk2.entities || []).length}（都应为 0）`);

  fs.writeFileSync("research/ai-player/facts/live/exp-belt-order.result.json",
    JSON.stringify({ hypothesis: "H7: 蓝图保留带子变体", same, in_place: n1, pasted: n2, site: [mx, my], paste_at: [px, py] }, null, 1));
  log(`\n写入 facts/live/exp-belt-order.result.json`);
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
