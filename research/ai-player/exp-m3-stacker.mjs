/**
 * exp-m3-geometry.mjs — 验证**最后两个未核证的机器几何**：stacker 与 mixer。
 *
 * stacker（源码：2×1，输入 bottom×(0,0)+(1,0)，输出 top×(0,0)）—— 最难布线的一个。
 *   · 两个输入都要从下方进 → 需要两条平行的、都朝上的带子分别进两个输入槽
 *   · 输出从上方出 → 第三条带朝上
 * mixer（源码：2×1，两个 color 输入 bottom×(0,0)+(1,0)，输出 top×(0,0)）
 *   · 需要两个颜料矿（或两条颜料带）分别进两个输入槽
 *
 * 本脚本验证 **stacker**（更关键，因为它是 MAM 瓶颈）。
 *
 * 布局：找到一对相邻的、远离工厂的**不同**形状矿（用于堆叠出多层形状）。
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
  const clear = (x, y, r = 70) => { for (const e of ents) if (Math.hypot(e.x - x, e.y - y) < r) return false; return true; };

  // 找一对**不同形状**、都清净、且尽量近的矿（同一区域但不同 patch）
  const shapes = res.filter(([x, y, s]) => !["red", "green", "blue"].includes(s) && clear(x, y));
  let pair = null, bestD = 1e9;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [ax, ay, as] = shapes[i], [bx, by, bs] = shapes[j];
      if (as === bs) continue;
      const d = Math.hypot(ax - bx, ay - by);
      if (d < 8 || d > 60) continue;         // 不能挤在一起，也不能太远
      if (d < bestD) { bestD = d; pair = { a: [ax, ay, as], b: [bx, by, bs], d }; }
    }
  }
  if (!pair) { log("没找到合适的形状配对"); return; }
  const [ax, ay, as] = pair.a, [bx, by, bs] = pair.b;
  log(`矿 A ${as} @ (${ax},${ay})   矿 B ${bs} @ (${bx},${by})   相距 ${pair.d.toFixed(1)}`);
  log(`世界基线 ${baseline}`);

  // 布局：
  //   两个矿机都在各自资源格，输出朝上
  //   stacker 放在它们上方某处，两个输入槽在 (sx,sy) 与 (sx+1,sy) 的 bottom
  //   → 需要两条**竖直的、朝上的**带子分别进这两个槽
  //   让 stacker 的左格 = (ax, ay-4)，右格 = (ax+1, ay-4)
  //   带 A：(ax, ay-1)..(ax, ay-5) 朝上 → 进 stacker 左格 bottom ✓（左格底 = (ax, ay-3)?? 需对齐）
  //   注意：stacker 占 (sx,sy)+(sx+1,sy)；它的输入槽在 (sx,sy) bottom 与 (sx+1,sy) bottom
  //   所以带子必须结束在 (sx, sy+1) 与 (sx+1, sy+1)，且朝上
  const sx = ax, sy = ay - 4;
  log(`stacker 左格 = (${sx},${sy})，占 (${sx},${sy}) 与 (${sx + 1},${sy})`);
  log(`输入带需结束在 (${sx},${sy + 1}) 与 (${sx + 1},${sy + 1})，都朝上`);

  // 检查 B 矿能否对齐到 (sx+1, ...)：B 在 (bx,by)。若 bx !== sx+1，需要水平搬运
  const region = [Math.min(ax, bx) - 5, sy - 8, Math.max(ax, bx) + 12, Math.max(ay, by) + 3];
  const pre = await rpc("obs", { region, max_entities: 200 });
  if ((pre.entities || []).length) { log(`⚠️ 区域已有 ${(pre.entities || []).length} 实体，中止`); return; }
  log("✓ 区域无实体");

  const r = {};
  // 矿 A → 竖直带 → stacker 左输入
  r.minerA = await rpc("act", { op: "place", building: "miner", x: ax, y: ay, r: 0 });
  r.beltA = await rpc("act", { op: "place_path", building: "belt", from: [ax, ay - 1], to: [ax, sy + 1] });
  log(`矿A uid=${r.minerA.entity_uid}，竖直带A ${r.beltA.applied} 格`);

  // 矿 B → 需要到 (sx+1, sy+1) 朝上。路线：先竖直上到 sy+1 那一行，再水平到 sx+1，最后一格朝上
  r.minerB = await rpc("act", { op: "place", building: "miner", x: bx, y: by, r: 0 });
  // 竖直：从 (bx, by-1) 到 (bx, sy+2)（多上一格，便于水平）
  const laneY = sy + 2;
  r.beltB1 = await rpc("act", { op: "place_path", building: "belt", from: [bx, by - 1], to: [bx, laneY] });
  // 水平：从 (bx, laneY) 到 (sx+1, laneY)
  r.beltB2 = await rpc("act", { op: "place_path", building: "belt", from: [bx, laneY], to: [sx + 1, laneY] });
  // 最后一格：在 (sx+1, sy+1) 放一条**朝上**的带子
  r.beltB3 = await rpc("act", { op: "place", building: "belt", x: sx + 1, y: sy + 1, r: 0 });
  log(`矿B uid=${r.minerB.entity_uid}，带B1 ${r.beltB1.applied}，带B2 ${r.beltB2.applied}，末格(朝上) uid=${r.beltB3.entity_uid}`);

  // stacker
  r.stacker = await rpc("act", { op: "place", building: "stacker", x: sx, y: sy, r: 0 });
  log(`stacker uid=${r.stacker.entity_uid}`);

  // 输出带：从 (sx, sy-1) 朝上 → trash
  const outTop = sy - 6;
  r.beltOut = await rpc("act", { op: "place_path", building: "belt", from: [sx, sy - 1], to: [sx, outTop] });
  r.trash = await rpc("act", { op: "place", building: "trash", x: sx, y: outTop - 1, r: 0 });
  log(`输出带 ${r.beltOut.applied} 格 → trash uid=${r.trash.entity_uid}`);

  const o1 = await rpc("obs", { region, max_entities: 200 });
  log(`\n产线共 ${(o1.entities || []).length} 实体`);
  for (const e of (o1.entities || []).sort((a, b) => b.y - a.y || a.x - b.x).slice(0, 30))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(9)} r=${String(e.r).padStart(3)} rv=${e.rotation_variant ?? "-"}`);

  log("\n快进 3000 tick ...");
  await rpc("act", { op: "step", ticks: 3000 });
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const { obj } = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${(await rpc("save_now", {})).internal_id}.bin`));
  const pos = new Map();
  for (const e of (obj.dump.entities || [])) { const s = e.components?.StaticMapEntity; if (s && typeof e.uid === "number") pos.set(e.uid, { x: s.origin.x, y: s.origin.y }); }
  const rows = [];
  for (const k of Object.keys(obj.dump.beltPaths)) {
    const e = obj.dump.beltPaths[k]; if (!e || !Array.isArray(e.entityPath)) continue;
    for (const uid of e.entityPath) {
      const q = pos.get(uid); if (!q) continue;
      if (q.x >= region[0] && q.x <= region[2] && q.y >= region[1] && q.y <= region[3]) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("\n★ 带上物品：");
  for (const s of rows.sort((a, b) => b.y - a.y || a.x - b.x)) log(`  (${s.x},${s.y}) ${s.items.slice(0, 4).join(" ") || "—"}`);
  const all = [...new Set(rows.flatMap(s => s.items))];
  log(`\n出现的物品种类：${all.join(" ") || "(无)"}`);
  // 堆叠成功 = 出现**多层**（冒号）或非原料形状
  const stacked = all.filter(i => i.includes(":") || (!i.includes(as) && !i.includes(bs)));
  const pass = stacked.length > 0;
  log(`\n=== M3-stacker: ${pass ? "✅ PASS —— 堆叠产物出现: " + stacked.join(" ") : "⚠️ 未见堆叠产物（可能是输入未到位）"} ===`);

  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region });
  const after = await rpc("obs", { max_entities: 1 });
  log(`bulk_delete=${del.applied}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m3-stacker.result.json",
    JSON.stringify({ milestone: "M3-stacker", pass, pair, rows, all, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
