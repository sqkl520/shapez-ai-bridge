/**
 * exp-m2a-line.mjs — M2a 里程碑：**颜料 + 上色**（M1b 之后的下一块）。
 *
 * 目标：跑通「矿机 → painter(蓝) → 蓝形状 → trash」，证明**颜料物流**（painter 的 color 从 top 进）能工作。
 *
 * 选址：实测地图上有一对相邻的 RuRuRuRu + blue（相隔约 4 格），且都远离工厂。
 *
 * 几何（已核证，src/js/game/buildings/painter.js:118-183）：
 *   painter 2×1 @ (px,py)，占 (px,py) 与 (px+1,py)，rotation=0：
 *     · shape 输入槽 = (px,   py) 方向 left   ← 形状从左来
 *     · color 输入槽 = (px+1, py) 方向 top    ← 颜料从上来
 *     · 输出槽       = (px+1, py) 方向 right  → 上色后从右出
 *   因此：
 *     · 形状带需要**朝右**流向 (px-1,py) → (px,py)
 *     · 颜料带需要**朝下**流向 (px+1,py-1) → (px+1,py)
 *     · 输出带从 (px+2,py) 开始**朝右**
 *
 * 布局（全部 r=0 除非注明）：
 *      [Ru 矿机] 必须朝上 → 需要 L 形：竖直上 → 拐弯 → 水平右 → 进 painter 左侧
 *      为简化：把矿机放在 painter 左下方，用 L 形带（先上后右）
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
const decodeSaveOf = saved => {
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  return decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${saved.internal_id}.bin`));
};

async function main() {
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const baseline = (world.entities || []).length;

  // 实测配对
  const SHAPE = [-23, -189], SHAPE_KIND = "RuRuRuRu";
  const COLOR = [-27, -188], COLOR_KIND = "blue";
  log(`形状矿 ${SHAPE_KIND} @ (${SHAPE})   颜料矿 ${COLOR_KIND} @ (${COLOR})`);
  log(`世界基线 ${baseline}`);

  // 布局坐标（全部围绕这两个矿）
  // 形状侧：矿机 (sx,sy) 朝上 → 带 (sx,sy-1) .. (sx,py) → 然后需要向右拐到 painter 左侧
  //   为避免拐弯，让 painter 的**左格正好在形状带的顶端正上方**不行（painter 的 shape 槽是 left）
  //   → 必须拐弯。用 L：竖直带顶格 (sx, py+1)，然后 (sx+1..px-1, py) 水平向右，
  //     最后 (px,py) 是 painter 左格，带子在 (px-1,py) 朝右即可
  const px = SHAPE[0] + 2, py = SHAPE[1] - 3;          // painter 左格
  const sx = SHAPE[0], sy = SHAPE[1];                   // 形状矿机
  const gx = COLOR[0], gy = COLOR[1];                   // 颜料矿机
  log(`\npainter 左格 = (${px},${py})（占 (${px},${py})+(${px + 1},${py})）`);
  log(`形状矿机 (${sx},${sy})  颜料矿机 (${gx},${gy})`);

  const region = [Math.min(sx, gx, px) - 4, Math.min(sy, gy, py) - 8, Math.max(sx, gx, px) + 8, Math.max(sy, gy, py) + 4];
  const pre = await rpc("obs", { region, max_entities: 150 });
  if ((pre.entities || []).length) { log(`⚠️ 工作区已有 ${(pre.entities || []).length} 个实体，中止`); return; }
  log("✓ 工作区无实体");

  const r = {};
  // ① 形状分支
  r.minerS = await rpc("act", { op: "place", building: "miner", x: sx, y: sy, r: 0 });
  // 竖直带：从 (sx,sy-1) 到 (sx,py+1)（朝上）
  r.beltS1 = await rpc("act", { op: "place_path", building: "belt", from: [sx, sy - 1], to: [sx, py + 1] });
  // 拐角 + 水平带：从 (sx, py) 到 (px-1, py)（朝右）
  r.beltS2 = await rpc("act", { op: "place_path", building: "belt", from: [sx, py], to: [px - 1, py] });
  log(`形状分支：矿机 uid=${r.minerS.entity_uid}，竖直带 ${r.beltS1.applied}，水平带 ${r.beltS2.applied}`);

  // ② painter
  r.painter = await rpc("act", { op: "place", building: "painter", x: px, y: py, r: 0 });
  log(`painter uid=${r.painter.entity_uid}`);

  // ③ 颜料分支：矿机在 (gx,gy) 朝上 → 需要到 (px+1, py-1) 并且**朝下**
  //    矿机输出恒为 top（向上），所以先上到某行，再水平移到 px+1，再……"朝下"需要单独一格
  //    简化：让颜料带从下方上来，把 painter 的 color 输入改成 mirrored 变体（从 bottom 进）！
  //    但变体要通过 place 的 variant 参数指定 —— 我们先试默认变体 + 从上方喂
  r.minerG = await rpc("act", { op: "place", building: "miner", x: gx, y: gy, r: 0 });
  const colorTarget = [px + 1, py - 1];   // painter color 槽的上方格
  log(`颜料分支：矿机 uid=${r.minerG.entity_uid} → 需要送到 (${colorTarget}) 且**朝下**`);

  // 水平送到 px+1，再单独放一格朝下的带
  // 先竖直：从 (gx, gy-1) 上到 (gx, colorTarget[1])
  r.beltG1 = await rpc("act", { op: "place_path", building: "belt", from: [gx, gy - 1], to: [gx, colorTarget[1]] });
  // 再水平：从 (gx, colorTarget[1]) 到 (colorTarget[0], colorTarget[1]) —— 方向取决于 gx vs px+1
  const horizFrom = [gx, colorTarget[1]], horizTo = [colorTarget[0], colorTarget[1]];
  r.beltG2 = await rpc("act", { op: "place_path", building: "belt", from: horizFrom, to: horizTo });
  // 最后在 (px+1, py-1) 放一格**朝下**的带：用 place 显式指定 r=180
  r.beltG3 = await rpc("act", { op: "place", building: "belt", x: colorTarget[0], y: colorTarget[1], r: 180 });
  log(`颜料带：竖直 ${r.beltG1.applied}，水平 ${r.beltG2.applied}，末格(朝下) uid=${r.beltG3.entity_uid}`);

  // ④ 输出带：从 (px+2, py) 向右 → trash
  const outEnd = px + 8;
  r.beltOut = await rpc("act", { op: "place_path", building: "belt", from: [px + 2, py], to: [outEnd, py] });
  r.trash = await rpc("act", { op: "place", building: "trash", x: outEnd + 1, y: py, r: 0 });
  log(`输出带 ${r.beltOut.applied} 格 → trash uid=${r.trash.entity_uid}`);

  // 观测
  const o1 = await rpc("obs", { region, max_entities: 150 });
  log(`\n产线共 ${(o1.entities || []).length} 实体：`);
  for (const e of (o1.entities || []).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(9)} r=${String(e.r).padStart(3)} rv=${e.rotation_variant ?? "-"}`);

  log("\n快进 2500 tick ...");
  await rpc("act", { op: "step", ticks: 2500 });
  const { obj } = decodeSaveOf(await rpc("save_now", {}));
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

  const all = rows.flatMap(s => s.items);
  const painted = all.filter(i => /[rgbypcw]/.test(i) && !/^[rgb]$/.test(i));
  log(`\n出现过的物品：${[...new Set(all)].join(" ") || "(无)"}`);
  log(`上色后的形状（含颜色码的 8 字符串）：${[...new Set(painted)].join(" ") || "(无)"}`);
  const pass = painted.length > 0;
  log(`\n=== M2a: ${pass ? "✅ PASS —— 颜料真的进入了 painter 并给形状上了色" : "⚠️ 未上色（见上：可能是颜料没送到位或槽位不对）"} ===`);

  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region });
  const after = await rpc("obs", { max_entities: 1 });
  log(`bulk_delete=${del.applied}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m2a-line.result.json",
    JSON.stringify({ milestone: "M2a", pass, site: { SHAPE, SHAPE_KIND, COLOR, COLOR_KIND }, rows, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
