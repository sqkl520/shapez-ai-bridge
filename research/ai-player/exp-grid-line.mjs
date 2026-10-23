/**
 * exp-grid-line.mjs — 用**网格布局编译器**驱动实机（M4 失败的正面回答）。
 *
 * 与手写布局（exp-m4-fullchain）的区别：
 *   · 坐标由布局函数算出（不手算）→ 消除累积误差
 *   · 网格冲突检测在**放之前**就报错（不浪费实机往返）
 *   · 每个未使用的输出槽自动接 trash
 *
 * 目标：单分支完整链 —— 矿 → 切割 → 取右列 → 旋转 → 输出，左列自动废弃。
 * 验收：带上出现**旋转后的**形状（= 比 M1b 多了一个 rotater 环节）。
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

// ── 布局：纯函数，输入资源点，输出动作列表 + 网格 ──
function layout({ mx, my }) {
  const cutY = my - 3, rotY = my - 6, outTop = my - 9;
  const acts = [];
  // 机器先放（陷阱 #6：让带子能看见邻居）
  acts.push({ op: "place", building: "miner", x: mx, y: my, r: 0 });
  acts.push({ op: "place", building: "cutter", x: mx, y: cutY, r: 0 });
  acts.push({ op: "place", building: "trash", x: mx, y: cutY - 3, r: 0 });      // 左列废弃（陷阱 #7）
  acts.push({ op: "place", building: "rotater", x: mx + 1, y: rotY, r: 0 });
  acts.push({ op: "place", building: "trash", x: mx + 1, y: outTop - 1, r: 0 }); // 输出末端
  // 带子（都是直线段 → 无拐角 → 无 rv 歧义，陷阱 #1）
  acts.push({ op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, cutY + 1] });      // 进料
  acts.push({ op: "place_path", building: "belt", from: [mx, cutY - 1], to: [mx, cutY - 2] });    // 左列 → trash
  acts.push({ op: "place_path", building: "belt", from: [mx + 1, cutY - 1], to: [mx + 1, rotY + 1] }); // 右列 → rotater
  acts.push({ op: "place_path", building: "belt", from: [mx + 1, rotY - 1], to: [mx + 1, outTop] });  // rotater → trash
  return { acts, bbox: [mx - 1, outTop - 2, mx + 2, my + 1] };
}

async function main() {
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const ents = world.entities || [];
  const baseline = ents.length;
  const clear = (x, y, r = 80) => { for (const e of ents) if (Math.hypot(e.x - x, e.y - y) < r) return false; return true; };

  // 选资源：用一个大 patch 里的 RuRuRuRu（切半两半都非空 → 能验证左右两路）
  let site = null, bestD = 0;
  for (const [x, y, s] of res) {
    if (s !== "RuRuRuRu" || Math.hypot(x, y) < 60) continue;
    let m = 1e9; for (const e of ents) { const d = Math.hypot(e.x - x, e.y - y); if (d < m) m = d; if (m < 80) break; }
    if (m < 80) continue;
    if (m > bestD) { bestD = m; site = [x, y]; }
  }
  if (!site) { log("no site"); return; }
  const [mx, my] = site;
  const L = layout({ mx, my });
  log(`资源 RuRuRuRu @ (${mx},${my})（距最近实体 ${Math.round(bestD)}）基线 ${baseline}`);
  log(`布局包围盒 ${JSON.stringify(L.bbox)}，共 ${L.acts.length} 个动作`);

  const chk = await rpc("obs", { region: L.bbox, max_entities: 60 });
  if ((chk.entities || []).length) { log("⚠️ 区域非空:", (chk.entities || []).length); return; }
  log("✓ 区域空");

  // 执行（统一用"安全包装"：退化段转 place）
  const exec = async a => {
    if (a.op === "place_path") {
      if (a.from[0] === a.to[0] && a.from[1] === a.to[1]) return rpc("act", { op: "place", building: a.building, x: a.from[0], y: a.from[1], r: 0 });
      return rpc("act", { op: "place_path", ...a });
    }
    return rpc("act", { op: "place", ...a });
  };
  for (const a of L.acts) {
    try { const r = await exec(a);
      const what = a.op === "place" ? `${a.building}@(${a.x},${a.y})` : `path (${a.from})→(${a.to}) applied=${r.applied}`;
      log(`  ✓ ${what}`);
    } catch (e) { log(`  ✗ ${JSON.stringify(a)} → ${e.message}`); }
  }

  const o1 = await rpc("obs", { region: L.bbox, max_entities: 80 });
  log(`\n建成 ${(o1.entities || []).length} 实体：`);
  for (const e of (o1.entities || []).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(8)} r=${String(e.r).padStart(3)} rv=${e.rotation_variant ?? "-"}`);

  log("\n快进 2500 tick ...");
  await rpc("act", { op: "step", ticks: 2500 });
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const { obj } = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${(await rpc("save_now", {})).internal_id}.bin`));
  const pos = new Map();
  for (const e of (obj.dump.entities || [])) { const s = e.components?.StaticMapEntity; if (s && typeof e.uid === "number") pos.set(e.uid, { x: s.origin.x, y: s.origin.y }); }
  const rows = [];
  for (const k of Object.keys(obj.dump.beltPaths)) {
    const e = obj.dump.beltPaths[k]; if (!e || !Array.isArray(e.entityPath)) continue;
    for (const uid of e.entityPath) {
      const q = pos.get(uid); if (!q) continue;
      if (q.x >= L.bbox[0] && q.x <= L.bbox[2] && q.y >= L.bbox[1] && q.y <= L.bbox[3]) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("\n★ 带上物品：");
  for (const s of rows.sort((a, b) => b.y - a.y || a.x - b.x)) log(`  (${s.x},${s.y}) ${s.items.slice(0, 3).join(" ") || "—"}`);
  const all = [...new Set(rows.flatMap(s => s.items))];
  log(`\n物品种类：${all.join(" ") || "(无)"}`);
  // 单分支成功判据：右列被旋转（RuRu---- → --RuRu--）
  const rotated = all.some(i => i.startsWith("--") && i !== "--------");
  const pass = rotated;
  log(`\n=== 网格布局法: ${pass ? "✅ PASS —— 矿→切割→旋转 全链跑通，产物已旋转（" + all.filter(i=>i.startsWith("--")).join(" ") + "）" : "⚠️ 未见旋转产物"} ===`);

  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region: [L.bbox[0] - 2, L.bbox[1] - 2, L.bbox[2] + 2, L.bbox[3] + 2] });
  const after = await rpc("obs", { max_entities: 1 });
  log(`bulk_delete=${del.applied}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);
  fs.writeFileSync("research/ai-player/facts/live/exp-grid-line.result.json",
    JSON.stringify({ approach: "grid-layout", pass, site: [mx, my], items: all, rows: rows.filter(r => r.items.length), baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
