/**
 * exp-m2-line.mjs — M2 里程碑：**完整实现 level-11 目标配方 `CgScScCg` 的产线**。
 *
 * 配方（主 Agent 已离线验证，见 facts/ops-semantics-VERIFIED.md §4）：
 *   SuSuSuSu --paint cyan--> ScScScSc --cutHalf[1]--> ScSc---- --rotateCW--> --ScSc--  (下排)
 *   CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg (上排)
 *   stack(--ScSc--, Cg----Cg) = CgScScCg
 *
 * 但这条链在几何上很复杂（需要 4 个分支 + 2 个 mixer + 交汇堆叠）。
 * 本脚本先做**可管理的子集**：验证「颜料 + 上色 + 切割」这一段跑通（M2a）。
 *   CuCuCuCu 矿机 → painter(绿) → CgCgCgCg → cutter → 右列 CgCg---- → trash
 *   green 矿机 → painter 的 color 输入（从 top 进）
 *
 * 几何（全部按已核证）：
 *   painter 2×1 @ (px,py)：shape 从 left (px,py) 进；color 从 top (px+1,py) 进；输出 right (px+1,py)
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

  // 找一对"距离近、都远离工厂"的 CuCuCuCu 与 green（颜料）—— 距离 <60 格
  let pair = null, bestD = 0;
  const cuAll = res.filter(([x, y, s]) => s === "CuCuCuCu" && Math.hypot(x, y) > 60);
  const greenAll = res.filter(([x, y, s]) => s === "green");
  const clear = (x, y, r = 70) => { for (const e of ents) if (Math.hypot(e.x - x, e.y - y) < r) return false; return true; };
  for (const [cx, cy] of cuAll) {
    if (!clear(cx, cy)) continue;
    for (const [gx, gy] of greenAll) {
      const d = Math.hypot(cx - gx, cy - gy);
      if (d > 70) continue;
      if (!clear(gx, gy)) continue;
      if (d < 3) continue;   // 太近会挤在一起
      if (d < 200 - bestD || !pair) { }
      const score = 200 - d;
      if (score > bestD) { bestD = score; pair = { cu: [cx, cy], green: [gx, gy], d }; }
    }
  }
  if (!pair) { log("没有找到合适的 Cu+green 配对"); return; }
  log(`配对：Cu(${pair.cu}) + green(${pair.green})  相距 ${pair.d.toFixed(1)} 格`);
  const [cx, cy] = pair.cu, [gx, gy] = pair.green;
  log(`Cu 距原点 ${Math.round(Math.hypot(cx, cy))}，green 距原点 ${Math.round(Math.hypot(gx, gy))}`);

  // 简化布局：让 Cu 在下方，painter 在中间，green 从上方垂直喂入 painter 的 color 槽
  //   Cu 矿机 (cx,cy) 朝上 → 带 (cx,cy-1)
  //   painter 需要：shape 从 left 进 —— 所以把 painter 放在 (cx-1, cy-2)，
  //     它的 shape 输入槽 = (cx-1, cy-2) 的 left = 需要带子在 (cx-2, cy-2) 朝右
  //   → 需要把矿机出来的料**拐弯**。为简化，我们直接改造：让 Cu 矿机朝左，从左边进 painter
  //   === 重新设计（避免拐弯）===
  //   Cu 矿机在 (cx,cy)，朝上不行（painter 要 left 进）。
  //   改为：Cu 矿机朝**右**？矿机输出槽恒为 top（源码 miner.js:82）。
  //   → 所以必须拐弯。用 L 形：矿机朝上 → 竖直带 → 拐弯 → 水平带 → 进 painter 左侧
  const work = [cx - 8, cy - 12, cx + 10, cy + 4];   // 工作区（自查用）
  const pre = await rpc("obs", { region: work, max_entities: 120 });
  if ((pre.entities || []).length) { log("工作区非空:", (pre.entities || []).length, "—— 跳过"); return; }
  // 也检查 green 那侧
  const work2 = [gx - 10, gy - 12, gx + 10, gy + 4];
  const pre2 = await rpc("obs", { region: work2, max_entities: 120 });
  if ((pre2.entities || []).length) { log("green 工作区非空:", (pre2.entities || []).length, "—— 跳过"); return; }
  log("✓ 两个工作区都无实体");

  const r = {};
  // ── Cu 分支：矿机朝上 → 竖直 3 格 → 拐角向右 → 水平 3 格 → 进 painter 左侧 ──
  // painter @ (px,py) = (cx, cy-6)：shape 输入在 (px,py) 的 left
  const px = cx, py = cy - 6;
  r.minerCu = await rpc("act", { op: "place", building: "miner", x: cx, y: cy, r: 0 });
  r.beltUp = await rpc("act", { op: "place_path", building: "belt", from: [cx, cy - 1], to: [cx, py] });
  log(`Cu 矿机 uid=${r.minerCu.entity_uid}；竖直带 applied=${r.beltUp.applied}（${cy - 1} → ${py}）`);

  // painter 的 shape 从它的 left 进 —— 但我们的带是从下面 (cx, py+1) 上来的，
  // 而 (cx,py) 是 painter 的左格。带子在 (cx,py+1) 朝上 → 会喷到 (cx,py) 的 bottom。
  // painter 的 shape 槽是 left，不是 bottom → 不匹配！
  // 所以需要 L 形：竖直带到 (cx, py+1)，再在 (cx-1, py) 放一格朝右的带 → 但那要先拐弯。
  // 简化：把 painter 转 90°，使它的 shape 输入朝向变成 bottom。
  //   painter rotation=90 → 原 left 方向变成 bottom？需实测。
  // 先用 rotation=90 试（slot 会随之旋转）。
  r.painter = await rpc("act", { op: "place", building: "painter", x: cx, y: py, r: 90 });
  log(`painter uid=${r.painter.entity_uid} @ (${cx},${py}) r=90（尝试让 shape 输入朝下）`);

  // ── green 分支：矿机朝上 → 竖直带到 painter 的 color 槽 ──
  // painter rotation=90 后，color 槽位置也旋转了 —— 我们先放，再观测实际槽位
  // 为稳妥：把 green 矿机放在 painter 正上方，竖直带向下？但矿机输出恒为 top（朝上）……
  // 所以 green 矿机必须在 painter **下方**才能向上喷。但下方被 shape 带占了。
  // → 把 green 矿机放在 painter 的**侧面**，用 L 形绕上去。
  // 这里先只验证 **Cu 分支 + painter** 能否让物品上色（颜料先不接，看是否卡住）

  // 观测 painter 的实际槽位（通过尝试放置并观察行为）
  const o1 = await rpc("obs", { region: [cx - 3, py - 6, cx + 6, cy + 3], max_entities: 120 });
  log(`\n当前实体（${(o1.entities || []).length}）:`);
  for (const e of (o1.entities || []).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(8)} r=${e.r}`);
  log(`   变体: ${JSON.stringify((o1.entities || []).map(e => e.type + ":" + (e.rotation_variant ?? "-")))}`);

  log("\n快进 1200 tick，看 Cu 是否流到 painter 前...");
  await rpc("act", { op: "step", ticks: 1200 });
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
      if (q.x >= cx - 3 && q.x <= cx + 6 && q.y >= py - 6 && q.y <= cy + 3) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("带上物品:");
  for (const s of rows.sort((a, b) => a.x - b.x || b.y - a.y)) log(`  (${s.x},${s.y}) ${s.items.slice(0, 4).join(" ") || "—"}`);

  log("\n清理...");
  await rpc("act", { op: "bulk_delete", region: work });
  const after = await rpc("obs", { max_entities: 1 });
  log(`世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m2a-line.result.json",
    JSON.stringify({ milestone: "M2a", pair, rows, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
