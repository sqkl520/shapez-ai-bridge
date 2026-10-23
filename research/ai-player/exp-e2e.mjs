/**
 * exp-e2e.mjs — 最后一公里：离线世界模型 → 实机建造 → **hub 目标计数器真的上涨**。
 *
 * 补上 SYNTHESIS §5.2 头号缺口（对抗审查 unverified#3）：本研究中每个里程碑都以 trash
 * 收尾，从没看过 hub_delivered_increased。这里补上，并且**只用新造的机制**：
 *
 *   1. new_game（level 1，目标 CuCuCuCu×30）
 *   2. save_now → **离线**解码读 map.seed → 离线算整张资源图（不靠 obs 侦察资源！）
 *   3. 规划器：对 hub 的 16 个入口，沿"正对入口的射线"向外扫离线 CuCuCuCu
 *      —— 找到的话，矿机→带子→hub 是**一条直线、零拐角**（最确定的几何）
 *   4. 建线；先用实机 obs 交叉核对"离线预测的格 == 实机的格"
 *   5. await hub_delivered_increased → 看目标计数器 + 等级
 *   6. 恢复：load_save 回原来的 level-11 存档（新档与旧档是两个文件，旧档未被改动）
 *
 * 安全：实验前已 snapshot_save "pre-e2e"（level-11 档）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BASE = "http://127.0.0.1:7777"; let id = 1;
async function rpc(m, a = {}) {
  const r = await fetch(BASE + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: a }), signal: AbortSignal.timeout(300000) });
  const b = await r.json(); if (b.error) { const e = new Error(b.error.message); e.rpc = b.error; throw e; } return b.result;
}
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let errors = [];
async function safeAct(a) { try { return await rpc("act", a); } catch (e) { errors.push(`${JSON.stringify(a)} → ${e.message}`); return null; } }

// ── 离线资源生成（与 proto/gen-resources.mjs 同源） ──
const MCS = 16;
function Mash() { let n = 0xefc8249d; return function (d) { d = d.toString(); for (let i = 0; i < d.length; i++) { n += d.charCodeAt(i); let h = 0.02519603282416938 * n; n = h >>> 0; h -= n; h *= n; n = h >>> 0; h -= n; n += h * 0x100000000; } return (n >>> 0) * 2.3283064365386963e-10; }; }
function mk(seed) { let c = 1; const m = Mash(); let a = m(" "), b = m(" "), d = m(" "); a -= m(seed); if (a < 0) a += 1; b -= m(seed); if (b < 0) b += 1; d -= m(seed); if (d < 0) d += 1; return function () { const t = 2091639 * a + c * 2.3283064365386963e-10; a = b; b = d; return (d = t - (c = t | 0)); }; }
class R { constructor(s) { this.r = mk(s); } n() { return this.r(); } ch(a) { return a[this.i(0, a.length)]; } i(mn, mx) { return Math.floor(this.n() * (mx - mn) + mn); } rg(mn, mx) { return this.n() * (mx - mn) + mn; } }
const cl = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const SH = { rect: "R", circle: "C", star: "S", windmill: "W" };
const chunkCache = new Map();
class C {
  constructor(seed, x, y) {
    this.x = x; this.y = y; this.tx = x * MCS; this.ty = y * MCS;
    this.l = Array.from({ length: MCS }, () => new Array(MCS).fill(null));
    const r = new R(this.x + "|" + this.y + "|" + seed);
    if (this.pre(r)) return;
    const d = Math.round(Math.hypot(this.x + 0.5, this.y + 0.5)), c = 0.9 - cl(d / 25, 0, 1) * 0.5;
    if (r.n() < c / 4) this.cp(r, Math.max(2, Math.round(1 + cl(d / 8, 0, 4))), d);
    if (r.n() < c / 4) this.sp(r, Math.max(2, Math.round(1 + cl(d / 8, 0, 4))), d);
  }
  pre(r) {
    if (this.x === 0 && this.y === 0) { this.p(r, 2, "red", 7, 7); return true; }
    if (this.x === -1 && this.y === 0) { this.p(r, 2, "CuCuCuCu", MCS - 9, 7); return true; }
    if (this.x === 0 && this.y === -1) { this.p(r, 2, "RuRuRuRu", 5, MCS - 7); return true; }
    if (this.x === -1 && this.y === -1) { this.p(r, 2, "green"); return true; }
    if (this.x === 5 && this.y === -2) { this.p(r, 2, "SuSuSuSu", 5, MCS - 7); return true; }
    return false;
  }
  p(r, ps, item, ox = null, oy = null) {
    const b = Math.ceil(ps / 2 + 3);
    let px = r.i(b, MCS - b - 1), py = r.i(b, MCS - b - 1);
    if (ox !== null) px = ox; if (oy !== null) py = oy;
    for (let k = 0; k <= ps; ++k) {
      const rad = Math.min(1 + k, ps), rs = rad * rad, off = (ps - k) / 2 + 2;
      const sx = r.rg(0.9, 1.1), sy = r.rg(0.9, 1.1);
      const cx = px + r.i(-off, off), cy = py + r.i(-off, off);
      for (let dx = -rad * sx - 2; dx <= rad * sx + 2; ++dx) for (let dy = -rad * sy - 2; dy <= rad * sy + 2; ++dy) {
        const X = Math.round(cx + dx), Y = Math.round(cy + dy);
        if (X >= 0 && X < MCS && Y >= 0 && Y <= MCS) { const a = dx / sx, bb = dy / sy; if (a * a + bb * bb <= rs && !this.l[X][Y]) this.l[X][Y] = item; }
      }
    }
  }
  cp(r, s, d) { const a = ["red", "green"]; if (d > 2) a.push("blue"); this.p(r, s, r.ch(a)); }
  sp(r, s, d) {
    const w = { rect: 100, circle: Math.round(50 + cl(d * 2, 0, 50)), star: Math.round(20 + cl(d, 0, 30)), windmill: Math.round(6 + cl(d / 2, 0, 20)) };
    if (d < 7) { w.star = 0; w.windmill = 0; }
    const pk = () => { const s2 = Object.values(w).reduce((a, b) => a + b, 0); const n = r.i(0, s2 - 1); let ac = 0; for (const k in w) { if (ac + w[k] > n) return k; ac += w[k]; } return "circle"; };
    let ss;
    if (d < 10) { const a = pk(); ss = [a, a, a, a]; } else if (d < 15) { const a = pk(), b = pk(); ss = [a, a, b, b]; } else ss = [pk(), pk(), pk(), pk()];
    let wc = 0; for (const s2 of ss) if (s2 === "windmill") ++wc;
    if (wc > 1) { ss[0] = "rect"; ss[1] = "rect"; }
    this.p(r, s, ss.map(s2 => SH[s2] + "u").join(""));
  }
}
function offlineTile(seed, x, y) {
  const cx = Math.floor(x / MCS), cy = Math.floor(y / MCS);
  const key = cx + "," + cy;
  let ch = chunkCache.get(key);
  if (!ch) { ch = new C(seed, cx, cy); chunkCache.set(key, ch); }
  return ch.l[x - ch.tx][y - ch.ty];
}

/** hub 的 16 个入口 + 直冲方向：entry = 落在该格的带子的**最后一格**，dir = 其流向（0=上 90=右 180=下 270=左）
 *  依据 buildings/hub.js:73-91（direction 是"物品从哪个方向被接收"），带子需从入口沿 dir 的反方向外推。 */
function hubEntries(hub) {
  const { x: hx, y: hy } = hub, out = [];
  for (let i = 0; i < 4; i++) {
    out.push({ at: [hx + i, hy - 1], dir: 180 });   // 顶排：带子向下(180)喷进 (i,0)
    out.push({ at: [hx + i, hy + 4], dir: 0 });     // 底排：带子向上(0)喷进 (i,3)
    out.push({ at: [hx - 1, hy + i], dir: 90 });    // 左列：带子向右(90)喷进 (0,i)
    out.push({ at: [hx + 4, hy + i], dir: 270 });   // 右列：带子向左(270)喷进 (3,i)
  }
  return out;
}
/** 找离 hub 中心最近的离线 CuCuCuCu（半径内），返回最优 L 形（竖直腿 + 末拐角 + 水平腿进 hub 侧口）
 *  几何全部来自已核证事实：hub 左右列入口 x=hub.x-1 / hub.x+4，流向 90/270（hub.js:73-91）；
 *  拐角最后放（M3 模式：邻居齐了自动定向才正确）。 */
function planL(seed, hub, range = 48) {
  const cands = [];
  const hx = hub.x, hy = hub.y, ccx = hx + 1.5, ccy = hy + 1.5;
  for (let x = Math.floor(ccx) - range; x <= Math.ceil(ccx) + range; x++)
    for (let y = Math.floor(ccy) - range; y <= Math.ceil(ccy) + range; y++) {
      if (offlineTile(seed, x, y) !== "CuCuCuCu") continue;
      if (x >= hx - 1 && x <= hx + 4 && y >= hy - 1 && y <= hy + 4) continue;   // 紧贴/压在 hub 上
      // 左口（带子向右流）
      if (x < hx - 1) {
        const ey = y > hy + 3 ? hy + 3 : (y < hy ? hy : hy + 1);
        cands.push({ miner: [x, y], corner: [x, ey], entry: [hx - 1, ey], leg: "V-then-H-right",
          vdir: (ey < y ? 0 : 180), hdir: 90, len: Math.abs(y - ey) + (hx - 1 - x) + 1 });
        // 上/下口也行（先水平后腿竖直），略：竖直接法总存在
      }
      // 右口（带子向左流）
      if (x > hx + 4) {
        const ey = y > hy + 3 ? hy + 3 : (y < hy ? hy : hy + 1);
        cands.push({ miner: [x, y], corner: [x, ey], entry: [hx + 4, ey], leg: "V-then-H-left",
          vdir: (ey < y ? 0 : 180), hdir: 270, len: Math.abs(y - ey) + (x - hx - 4) + 1 });
      }
    }
  if (!cands.length) return null;
  cands.sort((a, b) => a.len - b.len);
  // 检查 L 两条腿互不穿越 hub：竖直腿在 x=miner.x（已排除 hub 区），水平腿 ey 行 [minx..ex]
  return cands[0];
}

async function main() {
  const st0 = await rpc("status", {});
  log(`桥接 OK，mod ${st0.mod_version} / 游戏 ${st0.game_version}`);

  // ① 新开局
  log("\n[1] new_game ...");
  try { await rpc("new_game", { game_mode: "regularMode" }); } catch (e) { log("new_game 失败:", e.message); return; }
  for (let i = 0; i < 40; i++) { await sleep(1000); const s = await rpc("status", {}, 8000); if (s.in_game) { log(`  进入世界（${i + 1}s）`); break; } }
  const o0 = await rpc("obs", { max_entities: 20, include_hub: true });
  if (!o0.in_game) { log("未进入游戏"); return; }
  const hub = (o0.entities || []).find(e => e.type === "hub");
  log(`目标: level ${o0.goal.level} — ${o0.goal.requirement.shape} ${o0.goal.requirement.delivered}/${o0.goal.requirement.required}  hub @ (${hub.x},${hub.y})`);

  // ② 离线读 seed（不靠 obs 侦察资源！）
  log("\n[2] 离线读 map.seed ...");
  const sv = await rpc("save_now", {});
  const saveFile = path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${sv.internal_id}.bin`);
  const { decodeSave } = require("D:/Projects/rea/Project work/shapez/recon/decode_full.cjs");
  const seed = decodeSave(saveFile).obj.dump.map.seed;
  log(`  seed = ${seed}`);

  // ③ 规划：离 hub 最近的离线 CuCuCuCu → 一条 L 形（竖直腿 + 拐角 + 水平腿进 hub 侧口）
  log("\n[3] 离线规划（全向扫 CuCuCuCu，取最短 L）...");
  const plan = planL(seed, hub, 48);
  if (!plan) { log("  48 格内没扫到 Cu —— 报告，不硬建"); fs.writeFileSync("research/ai-player/facts/live/exp-e2e.result.json", JSON.stringify({ pass: false, reason: "no-plan", seed }, null, 1)); return; }
  log(`  矿机 @ (${plan.miner}) 拐角 @ (${plan.corner}) hub 入口 (${plan.entry})  腿长=${plan.len} 竖 r=${plan.vdir} 横 r=${plan.hdir}`);

  // 交叉核对：实机 obs 该格是否真是 Cu（证明离线==在线）
  const chk = await rpc("obs", { region: [plan.miner[0] - 2, plan.miner[1] - 2, plan.miner[0] + 2, plan.miner[1] + 2], include_resources: true, max_resources: 100 });
  const realHere = (chk.resources || []).find(r => r[0] === plan.miner[0] && r[1] === plan.miner[1]);
  const offlineMatches = !!realHere && realHere[2] === "CuCuCuCu";
  log(`  交叉核对：实机该格 = ${realHere ? realHere[2] : "（obs 未列出）"}  → 离线==在线 ${offlineMatches ? "✅" : "❌"}`);

  // ④ 建线：**两腿先、拐角最后**（M3 验证的配方 —— 邻居齐了自动定向才算对）
  log("\n[4] 实机建线（两腿 → 拐角 → 矿机）...");
  const [vdx, vdy] = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[plan.vdir];
  const [hdx, hdy] = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[plan.hdir];
  const [mx, my] = plan.miner, [cx, cy] = plan.corner, [ex, ey] = plan.entry;
  let beltCount = 0;
  // 竖直腿：矿机出口后一格 → 拐角前一格
  const vFrom = [mx + vdx, my + vdy], vTo = [cx - vdx, cy - vdy];
  if (vFrom[0] !== vTo[0] || vFrom[1] !== vTo[1]) {
    const v = await safeAct({ op: "place_path", building: "belt", from: vFrom, to: vTo });
    if (v) beltCount += v.applied;
    log(`  竖直腿 applied=${v ? v.applied : 0} ${JSON.stringify(vFrom)}→${JSON.stringify(vTo)}${v && v.failed.length ? " failed " + JSON.stringify(v.failed.slice(0, 2)) : ""}`);
  } else {
    const v = await safeAct({ op: "place", building: "belt", x: vFrom[0], y: vFrom[1], r: plan.vdir });
    if (v) beltCount += 1;
    log(`  竖直腿（单格）${v ? "ok" : "失败"}`);
  }
  // 水平腿：拐角后一格 → hub 入口格
  const hFrom = [cx + hdx, cy + hdy], hTo = [ex, ey];
  const h = await safeAct({ op: "place_path", building: "belt", from: hFrom, to: hTo });
  if (h) beltCount += h.applied;
  log(`  水平腿 applied=${h ? h.applied : 0} ${JSON.stringify(hFrom)}→${JSON.stringify(hTo)}${h && h.failed.length ? " failed " + JSON.stringify(h.failed.slice(0, 2)) : ""}`);
  // 拐角（最后放，邻居已齐）
  const cor = await safeAct({ op: "place", building: "belt", x: cx, y: cy, r: plan.hdir });
  if (cor) beltCount += 1;
  log(`  拐角 ${cor ? "uid=" + cor.entity_uid : "失败: " + errors[errors.length - 1]}`);
  // 矿机
  const mm = await safeAct({ op: "place", building: "miner", x: mx, y: my, r: plan.vdir });
  log(`  矿机 ${mm ? "uid=" + mm.entity_uid + " r=" + plan.vdir : "失败: " + errors[errors.length - 1]}`);

  // 读回产线，检查拐角实际变体
  const line = await rpc("obs", { region: [Math.min(mx, ex) - 2, Math.min(my, cy) - 2, Math.max(mx, ex) + 2, Math.max(my, cy) + 2], max_entities: 200 });
  const cornerObs = (line.entities || []).find(e => e.x === cx && e.y === cy);
  log(`  拐角实况: ${JSON.stringify(cornerObs)}`);
  log(`  带子共 ${beltCount} 格；产线实体 ${(line.entities || []).length}`);

  // ⑤ 最后一步：看目标计数器动没动
  log("\n[5] await hub_delivered_increased（≤ 15000 tick）...");
  errors = [];
  const w = await safeAct({ op: "await", until: "hub_delivered_increased", timeout_ticks: 15000 });
  const o1 = await rpc("obs", { max_entities: 5, include_hub: true });
  const req = o1.goal.requirement;
  const stock = o1.hub ? Object.entries(o1.hub.stored_shapes).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join("  ") : "";
  log(`  met=${w && w.met}  ticks_run=${w && w.ticks_run}`);
  log(`  目标计数器: ${req.delivered}/${req.required}   等级: ${o1.goal.level}`);
  log(`  hub 库存: ${stock}`);
  const pass = !!(w && w.met === true && req.delivered > 0) && offlineMatches;
  log(`\n=== ${pass ? "✅ 最后一公里打通：seed→离线预测→直线建造→hub 收货计数上涨（且离线==在线）" : "⚠️ 见上：判定各分量"}`);
  log(`   分量：离线预测命中=${offlineMatches}  交付上升=${!!(w && w.met === true)}  delivered=${req.delivered}`);
  if (errors.length) log("   建造错误:", JSON.stringify(errors.slice(0, 8)));

  fs.writeFileSync("research/ai-player/facts/live/exp-e2e.result.json",
    JSON.stringify({ test: "e2e-delivery", pass, seed, plan, offlineMatches, delivered: req.delivered, required: req.required, met: w && w.met, ticks_run: w && w.ticks_run, errors }, null, 1));

  // ⑥ 恢复原 level-11 世界
  log("\n[6] 恢复原存档（load 5c9670… level 11）...");
  try { await rpc("load_save", { internal_id: "5c96706563c0b74c4d2ce4c7f8bf7a244392de89" }); } catch (e) { log("  恢复失败（旧档文件未损，可手动载入）:", e.message); }
  for (let i = 0; i < 40; i++) { await sleep(1000); const s = await rpc("status", {}, 8000); if (s.in_game) { const o = await rpc("obs", { max_entities: 1 }); log(`  已回到 level-11 世界，实体=${o.stats.total}（基线 2805）${o.stats.total === 2805 ? " ✅" : " ⚠️"}`); break; } }
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
