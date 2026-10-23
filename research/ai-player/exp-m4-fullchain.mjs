/**
 * exp-m4-fullchain.mjs — M4：**完整 level-11 配方链**（最后一个未验证的几何模式）。
 *
 * 配方（已离线验证）：
 *   分支1: CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg (上排)
 *   分支2: SuSuSuSu --paint cyan --> ScScScSc --cutHalf[1]--> ScSc---- --rotateCW --> --ScSc-- (下排)
 *   汇合:  stack(--ScSc--, Cg----Cg) = CgScScCg
 *
 * 本实验做**简化可验证版**：验证"两个分支各自加工后，汇入一个 stacker"这个几何模式，
 * 不必完全复刻 payload（用任意两个不同的半形状即可证明模式成立）。
 *
 * 模式：
 *   分支A: 矿A → 切割 → 取右列半形状 → rotater → 进 stacker 槽0（下层）
 *   分支B: 矿B → 切割 → 取右列半形状 → rotater → 进 stacker 槽1（上层）
 *   stacker → 输出 → trash
 *
 * 这验证了：**多分支交汇 + 中间加工 + 全部几何约束同时成立**。
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
/** place_path 的安全包装：跳过退化段（from==to，会报 2001） */
async function placeSeg(building, from, to) {
  if (from[0] === to[0] && from[1] === to[1]) {
    // 退化成一个点：直接 place 一格，方向取"朝上"（本脚本里所有单格都是朝上）
    try { return await rpc("act", { op: "place", building, x: from[0], y: from[1], r: 0 }); }
    catch (e) { return { applied: 0, error: e.message }; }
  }
  try { return await rpc("act", { op: "place_path", building, from, to }); }
  catch (e) { log(`  ⚠️ place_path ${JSON.stringify(from)}→${JSON.stringify(to)} 失败: ${e.message}`); return { applied: 0, error: e.message }; }
}
const findEmptySite = async (region) => {
  const o = await rpc("obs", { region, max_entities: 300 });
  return (o.entities || []).length === 0 ? true : (o.entities || []).length;
};

async function main() {
  const world = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const ents = world.entities || [];
  const baseline = ents.length;
  const clear = (x, y, r = 75) => { for (const e of ents) if (Math.hypot(e.x - x, e.y - y) < r) return false; return true; };

  // 找一对不同形状、清净、相距 10~30 格的矿（给两个分支各自的矿机）
  const shapes = res.filter(([x, y, s]) => !["red", "green", "blue"].includes(s) && clear(x, y));
  let pair = null, bestD = 1e9;
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [ax, ay, as] = shapes[i], [bx, by, bs] = shapes[j];
      if (as === bs) continue;
      const d = Math.hypot(ax - bx, ay - by);
      if (d < 12 || d > 30) continue;
      if (d < bestD) { bestD = d; pair = { a: [ax, ay, as], b: [bx, by, bs], d }; }
    }
  }
  if (!pair) { log("没找到合适的配对"); return; }
  const [ax, ay, as] = pair.a, [bx, by, bs] = pair.b;
  log(`矿A ${as}@(${ax},${ay})   矿B ${bs}@(${bx},${by})   相距 ${pair.d.toFixed(1)}`);
  log(`世界基线 ${baseline}`);

  // ── 布局设计 ──
  // 让 stacker 在两者中间偏上。取：
  //   stacker 左格 = (sx, sy)，右格 = (sx+1, sy)，两者输入槽都在各自 bottom，输出在左格 top
  //   分支A（矿A，在左）走左输入；分支B（矿B，在右）走右输入
  //   每个分支：矿机(朝上) → 竖直带 → cutter → 取右列 → rotater → 竖直带 → stacker 输入
  //   难点：cutter 输出**向上**，必须接到 stacker 的**下方**输入 → 需要"抬高绕行"
  //   简化策略：让 cutter 的输出直接向上进入一个 rotater，rotater 再向上进入 stacker 输入
  //             （因为三者都是"下进上出"，可以**竖直串联**！）
  // stacker 的列必须**不等于任何分支的竖直通道 x**，否则水平段会退化成零长度
  const sx = Math.round((Math.min(ax, bx) + Math.max(ax, bx)) / 2);
  const sy = Math.min(ay, by) - 14;
  log(`stacker 左格 (${sx},${sy})，占 (${sx},${sy})+( ${sx + 1},${sy})`);
  log(`  分支A 走左输入 (${sx},${sy})，分支B 走右输入 (${sx + 1},${sy})`);
  log(`  设计：矿→带→cutter→rotater→带→stacker 全部"下进上出"竖直串联`);
  log(`  竖直通道: 分支A x=${ax + 1}，分支B x=${bx + 1}，stacker 列 x=${sx}/${sx + 1}（必须互不相同）`);

  const region = [Math.min(ax, bx, sx) - 6, sy - 10, Math.max(ax, bx, sx) + 10, Math.max(ay, by) + 4];
  const chk = await findEmptySite(region);
  if (chk !== true) { log(`⚠️ 区域已有 ${chk} 实体，中止`); return; }
  log("✓ 区域无实体");

  const r = {};
  // ── 分支 A（矿A → 左输入）──
  // 竖直链条：miner(A) 输出 top → 带 → cutter(占 2 格，输入在左格 bottom)
  //   但 cutter 占 2 格宽，会挤到分支B的通道。用 quad? 不，用 default 并把两列都接出来（只取一列，另一列接 trash）
  //   为避免复杂，分支A的 cutter 放在 (ax-1, cyA)、(ax, cyA)？cutter 左格必须正好在进料带正上方。
  //   → 令 cutter 左格 = (ax, cyA)，右格 = (ax+1, cyA)。进料带在 (ax, cyA+1) 朝上 ✓
  //   → 右列输出（槽1）在 (ax+1, cyA) 朝上 → 我们要它 → 竖直带到 rotater
  //   → 左列输出（槽0）在 (ax, cyA) 朝上 → 接一条带到 trash（避免堵塞）
  const cyA = ay - 4;   // cutter 行
  const rotA = ay - 7;  // rotater 行（cutter 输出 2 格带之后）
  const stkInY = sy + 1; // stacker 输入带必须结束在 (sx, sy+1)

  r.minerA = await rpc("act", { op: "place", building: "miner", x: ax, y: ay, r: 0 });
  r.beltA_feed = await placeSeg("belt", [ax, ay - 1], [ax, cyA + 1]);
  r.cutterA = await rpc("act", { op: "place", building: "cutter", x: ax, y: cyA, r: 0 });
  // 右列输出（我们要的）→ 向上
  r.beltA_right = await placeSeg("belt", [ax + 1, cyA - 1], [ax + 1, rotA + 1]);
  r.rotaterA = await rpc("act", { op: "place", building: "rotater", x: ax + 1, y: rotA, r: 0 });
  // 左列输出（不要）→ trash（避免堵塞）
  r.trashA = await rpc("act", { op: "place", building: "trash", x: ax, y: cyA - 1, r: 0 });
  log(`分支A: 矿 uid=${r.minerA.entity_uid} 带${r.beltA_feed.applied} cutter ${r.cutterA.entity_uid} 右列带${r.beltA_right.applied} rotater ${r.rotaterA.entity_uid} 废料trash ${r.trashA.entity_uid}`);

  // ── 分支 B（矿B → 右输入）──
  const cyB = by - 4;
  const rotB = by - 7;
  r.minerB = await rpc("act", { op: "place", building: "miner", x: bx, y: by, r: 0 });
  r.beltB_feed = await placeSeg("belt", [bx, by - 1], [bx, cyB + 1]);
  r.cutterB = await rpc("act", { op: "place", building: "cutter", x: bx, y: cyB, r: 0 });
  r.beltB_right = await placeSeg("belt", [bx + 1, cyB - 1], [bx + 1, rotB + 1]);
  r.rotaterB = await rpc("act", { op: "place", building: "rotater", x: bx + 1, y: rotB, r: 0 });
  r.trashB = await rpc("act", { op: "place", building: "trash", x: bx, y: cyB - 1, r: 0 });
  log(`分支B: 矿 uid=${r.minerB.entity_uid} 带${r.beltB_feed.applied} cutter ${r.cutterB.entity_uid} 右列带${r.beltB_right.applied} rotater ${r.rotaterB.entity_uid}`);

  // ── stacker 与汇入（按"先直线、后拐角"的顺序铺，避免自动定向误判）──
  // 分支A: rotater(ax+1,rotA) 输出朝上 → 竖直 → 拐角朝右 → 水平 → 拐角朝上 → stacker 左输入
  // 分支B: rotater(bx+1,rotB) 输出朝上 → 竖直 → 拐角朝左 → 水平 → 拐角朝上 → stacker 右输入
  const colA = ax + 1, colB = bx + 1;
  const cornerAy = sy + 3;        // A 的横向车道行（留出 ≥1 格给最后的竖直段）
  const cornerBy = sy + 5;        // B 的横向车道行（比 A 低，避免交叉）
  log(`汇入路线: A 竖 x=${colA} → 车道 y=${cornerAy} → 拐到 x=${sx}`);
  log(`          B 竖 x=${colB} → 车道 y=${cornerBy} → 拐到 x=${sx + 1}`);

  // ① 竖直段（到拐角前一格）
  r.beltA_up = await placeSeg("belt", [colA, rotA - 1], [colA, cornerAy + 1]);
  r.beltB_up = await placeSeg("belt", [colB, rotB - 1], [colB, cornerBy + 1]);
  // ② 水平段（拐角后一格 → 目标列前一格）
  r.beltA_horiz = await placeSeg("belt", [colA - 1, cornerAy], [sx + 1, cornerAy]);
  r.beltB_horiz = await placeSeg("belt", [colB - 1, cornerBy], [sx + 2, cornerBy]);
  // ③ 拐角（显式指定方向；此时邻居都在，自动定向能算对变体）
  r.cornerA1 = await rpc("act", { op: "place", building: "belt", x: colA, y: cornerAy, r: 90 });
  r.cornerA2 = await rpc("act", { op: "place", building: "belt", x: sx, y: cornerAy, r: 0 });
  r.cornerB1 = await rpc("act", { op: "place", building: "belt", x: colB, y: cornerBy, r: 270 });
  r.cornerB2 = await rpc("act", { op: "place", building: "belt", x: sx + 1, y: cornerBy, r: 0 });
  // ④ 从拐角到 stacker 输入的最后竖直段
  r.beltA_last = await placeSeg("belt", [sx, cornerAy - 1], [sx, sy + 1]);
  r.beltB_last = await placeSeg("belt", [sx + 1, cornerBy - 1], [sx + 1, sy + 1]);
  log(`A: 竖直${r.beltA_up.applied} 水平${r.beltA_horiz.applied} 拐角${r.cornerA1.entity_uid ? "✓" : "✗"}/${r.cornerA2.entity_uid ? "✓" : "✗"} 末段${r.beltA_last.applied}`);
  log(`B: 竖直${r.beltB_up.applied} 水平${r.beltB_horiz.applied} 拐角${r.cornerB1.entity_uid ? "✓" : "✗"}/${r.cornerB2.entity_uid ? "✓" : "✗"} 末段${r.beltB_last.applied}`);

  r.stacker = await rpc("act", { op: "place", building: "stacker", x: sx, y: sy, r: 0 });
  r.belt_out = await placeSeg("belt", [sx, sy - 1], [sx, sy - 6]);
  r.trash_out = await rpc("act", { op: "place", building: "trash", x: sx, y: sy - 7, r: 0 });
  log(`stacker uid=${r.stacker.entity_uid}，输出带 ${r.belt_out.applied} → trash ${r.trash_out.entity_uid}`);

  const o1 = await rpc("obs", { region, max_entities: 400 });
  log(`\n产线共 ${(o1.entities || []).length} 实体`);

  log("快进 4000 tick ...");
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
      if (q.x >= region[0] && q.x <= region[2] && q.y >= region[1] && q.y <= region[3]) {
        rows.push({ x: q.x, y: q.y, items: (e.items || []).map(z => z[1]?.data || String(z[1])) }); break;
      }
    }
  }
  log("\n★ 带上物品（按行）：");
  for (const s of rows.filter(s => s.items.length).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${s.x},${s.y}) ${s.items.slice(0, 3).join(" ")}`);

  const all = [...new Set(rows.flatMap(s => s.items))];
  log(`\n出现的物品种类：${all.join(" ") || "(无)"}`);
  const stacked = all.filter(i => i.includes(":"));
  const pass = stacked.length > 0;
  log(`\n=== M4 完整链: ${pass ? "✅ PASS —— 多分支交汇堆叠成功: " + stacked.join(" ") : "⚠️ 未见堆叠产物"} ===`);

  // 诊断：打印合并区布局（保留现场，便于分析）
  const diag = await rpc("obs", { region: [sx - 4, sy - 3, sx + 5, Math.max(cornerAy, cornerBy) + 2], max_entities: 120 });
  log("\n=== 合并区布局（rotation_variant 是关键）===");
  for (const e of (diag.entities || []).sort((a, b) => b.y - a.y || a.x - b.x))
    log(`  (${e.x},${e.y}) ${e.type.padEnd(9)} r=${String(e.r).padStart(3)} rv=${e.rotation_variant ?? "-"}`);

  log("\n清理...");
  const del = await rpc("act", { op: "bulk_delete", region });
  const after = await rpc("obs", { max_entities: 1 });
  log(`bulk_delete=${del.applied}  世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅" : " ⚠️ 差 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-m4-fullchain.result.json",
    JSON.stringify({ milestone: "M4", pass, pair, all, stacked, rows: rows.filter(s => s.items.length), baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
