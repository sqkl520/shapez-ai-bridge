/**
 * exp-merge-line2.mjs — 双分支汇合，**用修复后的 rv 控制**（M4 的正确收尾）。
 *
 * 与上一版的区别：
 *   · 拐角不再依赖自动定向，而是**用蓝图**落地（H7 修复后已验证确定性）
 *   · 具体做法：先在**一个临时位置**用 place_path 造出正确形状，导出蓝图，
 *     再粘贴到目标位置 —— 拐角 rv 被蓝图固定
 *
 * 更简单的等价做法（本脚本采用）：**全用直线段，拐角处用"显式 r + 邻居已就位"**：
 *   先放所有直线段（它们方向确定），**最后**放拐角格 —— 此时上下游都已存在，
 *   自动定向会算出正确的 rv（这是 M1b/H7 原始实验成功的原因）。
 *   而修复后的 placeOne 让我们**还能**用蓝图层面的确定性 —— 两条路都通向正确。
 *
 * 布局（两条竖直通道 → 两条错开的水平车道 → 汇入 stacker 的两个底部输入）：
 *
 *    colA          colB
 *      ↑             ↑        （各自的竖直通道）
 *      └→→→→┐   ┌←←←←┘        （拐角 + 水平车道，错开一行）
 *           ↓   ↓
 *         [stacker]           （两个输入都在底部）
 *             ↓
 *           trash
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

/** 生成布局动作（采用 M3 已验证的模式：**只有一条分支拐弯**，另一条竖直直入） */
function plan({ aCol, bCol, sCol, sRow, aTopY, bTopY }) {
  const acts = [];
  const V = (x, y0, y1) => {                        // 竖直段；y0 = 起点（靠机器）
    if (y0 === y1) acts.push({ op: "place", building: "belt", x, y: y0, r: 0 });
    else acts.push({ op: "place_path", building: "belt", from: [x, y0], to: [x, y1] });
  };
  acts.push({ op: "place", building: "stacker", x: sCol, y: sRow, r: 0 });
  acts.push({ op: "place", building: "trash", x: sCol, y: sRow - 6, r: 0 });
  acts.push({ op: "place_path", building: "belt", from: [sCol, sRow - 1], to: [sCol, sRow - 5] });

  // 分支 A：矿A 在 stacker 左格的正下方 → **竖直直入**（无拐角）—— M3 证明这样可行
  V(aCol, aTopY, sRow + 1);

  // 分支 B：矿B 在别处 → 竖直上来 → 拐角 → 水平 → 再拐角朝上进 stacker 右格
  const laneY = sRow + 2;
  V(bCol, bTopY, laneY + 1);
  if (bCol !== sCol + 1) {
    // 水平段（从车道拐角后一格到目标列前一格），按**流动顺序**传参
    const from = bCol + (sCol + 1 < bCol ? -1 : 1);
    const to = sCol + 1 + (sCol + 1 < bCol ? 1 : -1);
    acts.push({ op: "place_path", building: "belt", from: [from, laneY], to: [to, laneY] });
  }
  V(sCol + 1, laneY - 1, sRow + 1);
  // 拐角（最后放，邻居已就位）
  acts.push({ op: "place", building: "belt", x: bCol, y: laneY, r: sCol + 1 < bCol ? 270 : 90 });
  acts.push({ op: "place", building: "belt", x: sCol + 1, y: laneY, r: 0 });
  return { acts, box: [Math.min(aCol, bCol, sCol) - 2, sRow - 8, Math.max(aCol, bCol, sCol + 1) + 2, Math.max(aTopY, bTopY) + 2] };
}

async function main() {
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const st0 = await rpc("obs", { max_entities: 1 });
  const baseline = st0.stats.total;

  // 找一对不同形状、距离 10~24、实机确认周边清净的矿
  let pair = null, best = 1e9;
  const cand = [];
  for (const [x, y, s] of res) {
    if (["red", "green", "blue"].includes(s) || Math.hypot(x, y) < 80) continue;
    const o = await rpc("obs", { region: [x - 30, y - 30, x + 30, y + 30], max_entities: 15 });
    if ((o.entities || []).length) continue;
    cand.push([x, y, s]);
    if (cand.length > 400) break;
  }
  log(`实机确认清净的形状矿: ${cand.length} 个`);
  // ⚠️ 前置条件：两个矿必须在**不同列**，否则两条竖直通道会重叠（实测踩过）
  let considered = 0;
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    if (cand[i][2] === cand[j][2]) continue;
    if (cand[i][0] === cand[j][0]) continue;          // 同列 → 通道冲突，跳过
    if (Math.abs(cand[i][1] - cand[j][1]) > 6) continue;  // 行差太大 → 车道绕行过长
    const d = Math.hypot(cand[i][0] - cand[j][0], cand[i][1] - cand[j][1]);
    if (d < 10 || d > 24) continue;
    considered++;
    if (d < best) { best = d; pair = { a: cand[i], b: cand[j] }; }
  }
  log(`其中"不同列且行差≤6"的候选配对: ${considered}`);
  if (!pair) { log("没找到配对"); return; }
  const [ax, ay, as] = pair.a, [bx, by, bs] = pair.b;
  log(`矿A ${as}@(${ax},${ay})  矿B ${bs}@(${bx},${by})  距离 ${best.toFixed(1)}  基线 ${baseline}`);

  // stacker 左格必须与矿A **同列**（分支A 竖直直入，无拐角）—— M3 的成功模式
  const sCol = ax, sRow = Math.min(ay, by) - 9;
  const L = plan({ aCol: ax, bCol: bx, sCol, sRow, aTopY: ay - 1, bTopY: by - 1 });
  log(`stacker (${sCol},${sRow})  包围盒 ${JSON.stringify(L.box)}  ${L.acts.length} 个动作`);

  const chk = await rpc("obs", { region: L.box, max_entities: 200 });
  if ((chk.entities || []).length) { log(`⚠️ 区域非空 ${(chk.entities || []).length}，中止`); return; }

  await rpc("act", { op: "place", building: "miner", x: ax, y: ay, r: 0 });
  await rpc("act", { op: "place", building: "miner", x: bx, y: by, r: 0 });
  let built = 0;
  for (const a of L.acts) {
    try { const r = await rpc("act", a); built += (r.applied || (r.entity_uid !== undefined ? 1 : 0)); }
    catch (e) { log(`  ✗ ${JSON.stringify(a)} → ${e.message}`); }
  }
  log(`建设完成：${built} 个实体落地`);

  // 看拐角 rv 是否正确
  const o1 = await rpc("obs", { region: L.box, max_entities: 200 });
  const corners = (o1.entities || []).filter(e => e.type === "belt" && e.rotation_variant > 0);
  log(`\n拐角格（rv>0）：`);
  for (const c of corners) log(`  (${c.x},${c.y}) r=${c.r} rv=${c.rotation_variant} code=${c.code}`);

  log("\n快进 4000 tick ...");
  await rpc("act", { op: "step", ticks: 4000 });
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const { obj } = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${(await rpc("save_now", {})).internal_id}.bin`));
  const pos = new Map();
  for (const e of (obj.dump.entities || [])) { const s = e.components?.StaticMapEntity; if (s && typeof e.uid === "number") pos.set(e.uid, { x: s.origin.x, y: s.origin.y }); }
  const rows = [];
  for (const k of Object.keys(obj.dump.beltPaths)) {
    const e = obj.dump.beltPaths[k]; if (!e || !Array.isArray(e.entityPath)) continue;
    for (const uid of e.entityPath) {
      const q = pos.get(uid); if (!q) continue;
      if (q.x >= L.box[0] && q.x <= L.box[2] && q.y >= L.box[1] && q.y <= L.box[3]) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("★ 带上物品：");
  for (const s of rows.filter(s => s.items.length).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${s.x},${s.y}) ${s.items.slice(0, 3).join(" ")}`);
  const all = [...new Set(rows.flatMap(s => s.items))];
  const stacked = all.filter(i => i.includes(":"));
  const pass = stacked.length > 0;
  log(`\n物品种类: ${all.join(" ") || "(无)"}`);
  log(`\n=== ${pass ? "✅ PASS —— 双分支汇合成功，堆叠产物: " + stacked.join(" ") : "⚠️ 仍未堆叠"} ===`);

  log("\n清理...");
  let total = 0;
  for (const box of [L.box, [L.box[0] - 2, L.box[1] - 2, L.box[2] + 2, L.box[3] + 2]]) {
    const d = await rpc("act", { op: "bulk_delete", region: box }); total += d.applied;
  }
  const after = await rpc("obs", { max_entities: 1 });
  log(`清理 ${total}；世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);
  fs.writeFileSync("research/ai-player/facts/live/exp-merge2.result.json",
    JSON.stringify({ pass, pair, corners, all, stacked, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
