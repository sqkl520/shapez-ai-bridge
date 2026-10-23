/**
 * exp-merge-line.mjs — 双分支汇合布局的**实机验证**（M4 的正确做法）。
 *
 * 用 proto/layout-merge.mjs 的网格算法生成布局，翻译成动作，实机执行，验证堆叠产物。
 *
 * 与手写 M4 的区别：坐标全部由布局函数算出；拐角**最后放**（邻居已存在）；
 * 网格冲突在生成阶段就报错。
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

/** 生成双分支汇合布局（相对坐标；两个分支的竖直通道从各自矿机向上，到车道后横向汇入 stacker） */
function planMerge({ aCol, bCol, sCol, sRow, aTopY, bTopY }) {
  const aLane = sRow + 2, bLane = sRow + 4;
  const aTarget = sCol, bTarget = sCol + 1;
  const acts = [];
  // 退化段（单格）必须也能落地 —— 否则会在拐角与目标之间留下空洞（实测踩过）
  const vline = (x, y0, y1) => {  // y0 = 起点（靠机器），y1 = 终点
    if (y0 === y1) acts.push({ op: "place", building: "belt", x, y: y0, r: 0 });
    else acts.push({ op: "place_path", building: "belt", from: [x, y0], to: [x, y1] });
  };
  const hline = (y, x0, x1) => {
    if (x0 === x1) acts.push({ op: "place", building: "belt", x: x0, y, r: 90 });
    else acts.push({ op: "place_path", building: "belt", from: [x0, y], to: [x1, y] });
  };

  // 机器优先
  acts.push({ op: "place", building: "stacker", x: sCol, y: sRow, r: 0 });
  acts.push({ op: "place", building: "trash", x: sCol, y: sRow - 4, r: 0 });
  // 直线段（各自从矿机上方一格起）
  vline(aCol, aTopY, aLane + 1);
  vline(bCol, bTopY, bLane + 1);
  // ⚠️ 水平段必须按**流动顺序**传参：from = 靠车道的端点，to = 靠 stacker 的端点。
  //    否则方向会反（实测踩过：分支B 被判成向东流，与上游撞死）。
  if (aTarget > aCol) hline(aLane, aCol + 1, aTarget - 1); else hline(aLane, aCol - 1, aTarget + 1);
  if (bTarget < bCol) hline(bLane, bCol - 1, bTarget + 1); else hline(bLane, bCol + 1, bTarget - 1);
  vline(aTarget, aLane - 1, sRow + 1);
  vline(bTarget, bLane - 1, sRow + 1);
  vline(sCol, sRow - 1, sRow - 3);
  // 拐角最后
  acts.push({ op: "place", building: "belt", x: aCol, y: aLane, r: 90 });
  acts.push({ op: "place", building: "belt", x: bCol, y: bLane, r: 270 });
  acts.push({ op: "place", building: "belt", x: aTarget, y: aLane, r: 0 });
  acts.push({ op: "place", building: "belt", x: bTarget, y: bLane, r: 0 });
  return { acts, bbox: [Math.min(aCol, bCol, sCol) - 2, sRow - 6, Math.max(aCol, bCol, sCol + 1) + 2, Math.max(aTopY, bTopY) + 2] };
}

async function main() {
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const ents = world.entities || [];
  const baseline = ents.length;
  const clear = (x, y, r = 100) => { for (const e of ents) if (Math.hypot(e.x - x, e.y - y) < r) return false; return true; };

  // 找两个不同形状的矿，距离 9~22 格，都清净（不要求同行）
  let pair = null, bestD = 1e9;
  const sh = res.filter(([x, y, s]) => !["red", "green", "blue"].includes(s) && clear(x, y));
  for (let i = 0; i < sh.length; i++) for (let j = i + 1; j < sh.length; j++) {
    const [ax, ay, as] = sh[i], [bx, by, bs] = sh[j];
    if (as === bs) continue;
    const d = Math.hypot(ax - bx, ay - by);
    if (d < 9 || d > 22) continue;
    if (d < bestD) { bestD = d; pair = { a: [ax, ay], b: [bx, by], as, bs }; }
  }
  if (!pair) { log("没找到合适配对"); return; }
  const [ax, ay] = pair.a, [bx, by] = pair.b;
  log(`矿A ${pair.as}@(${ax},${ay})  矿B ${pair.bs}@(${bx},${by})  相距 ${bestD.toFixed(1)}  基线 ${baseline}`);

  // 网格参数（世界坐标）：两个分支各自竖直向上，车道在 stacker 下方
  const aCol = ax, bCol = bx, aTopY = ay - 1, bTopY = by - 1;
  const sCol = Math.round((ax + bx) / 2) - 1;
  const sRow = Math.min(ay, by) - 8;
  const L = planMerge({ aCol, bCol, sCol, sRow, aTopY, bTopY });
  log(`布局：分支A 通道 x=${aCol}，分支B 通道 x=${bCol}，stacker (${sCol},${sRow})`);
  log(`包围盒 ${JSON.stringify(L.bbox)}，${L.acts.length} 个动作`);

  const chk = await rpc("obs", { region: L.bbox, max_entities: 200 });
  if ((chk.entities || []).length) { log("⚠️ 区域非空:", (chk.entities || []).length); return; }
  log("✓ 区域空");

  // 矿机（两个分支的源头）
  await rpc("act", { op: "place", building: "miner", x: ax, y: ay, r: 0 });
  await rpc("act", { op: "place", building: "miner", x: bx, y: by, r: 0 });
  // 按顺序执行布局
  for (const a of L.acts) {
    try {
      if (a.op === "place_path") {
        if (a.from[0] === a.to[0] && a.from[1] === a.to[1]) continue;
        const r = await rpc("act", a);
        if (!r.applied) log(`  ⚠️ 路径未生效 ${JSON.stringify(a)}`);
      } else await rpc("act", a);
    } catch (e) { log(`  ✗ ${JSON.stringify(a)} → ${e.message}`); }
  }
  log("建设完成");

  const o1 = await rpc("obs", { region: L.bbox, max_entities: 200 });
  log(`\n建成 ${(o1.entities || []).length} 实体（含关键的拐角 rv）：`);
  for (const e of (o1.entities || []).filter(e => e.type === "belt").sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) r=${String(e.r).padStart(3)} rv=${e.rotation_variant ?? "-"}`);

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
      if (q.x >= L.bbox[0] && q.x <= L.bbox[2] && q.y >= L.bbox[1] && q.y <= L.bbox[3]) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("\n★ 带上物品：");
  for (const s of rows.filter(s => s.items.length).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${s.x},${s.y}) ${s.items.slice(0, 3).join(" ")}`);
  const all = [...new Set(rows.flatMap(s => s.items))];
  log(`\n物品种类：${all.join(" ") || "(无)"}`);
  const stacked = all.filter(i => i.includes(":"));
  const pass = stacked.length > 0;
  log(`\n=== 双分支汇合（网格法）: ${pass ? "✅ PASS —— 堆叠成功: " + stacked.join(" ") : "⚠️ 未见堆叠产物"} ===`);

  let del = { applied: 0 }, after = { stats: { total: baseline } };
  if (!process.argv.includes("--keep")) {
    log("\n清理...");
    del = await rpc("act", { op: "bulk_delete", region: [L.bbox[0] - 2, L.bbox[1] - 2, L.bbox[2] + 2, L.bbox[3] + 2] });
    after = await rpc("obs", { max_entities: 1 });
    log(`bulk_delete=${del.applied}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);
  } else {
    log("\n[--keep] 保留现场不清理");
  }
  fs.writeFileSync("research/ai-player/facts/live/exp-merge-line.result.json",
    JSON.stringify({ approach: "grid-merge", pass, pair, stacked, all, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
