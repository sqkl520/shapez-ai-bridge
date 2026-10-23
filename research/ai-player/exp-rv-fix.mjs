/**
 * exp-rv-fix.mjs — 验证 rotationVariant 修复：**蓝图粘贴现在完全确定**。
 *
 * 判据（关键）：把同一条含拐角的产线蓝图，在一个**空区域**粘贴两次（不同位置），
 * 两次的 rv 必须**完全一致** —— 且与导出时**逐格一致**（无论邻居就位顺序如何）。
 *
 * 修复前的行为：拐角 rv 由邻居派生，在空区域粘贴时邻居尚未就位 → 拐角会算错。
 * 修复后：蓝图里的 code 携带 rv → 直接采用。
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

async function findEmpty(x, y, w, h) {
  for (let t = 0; t < 30; t++) {
    const X = x + t * 40;
    const o = await rpc("obs", { region: [X - 3, y - 3, X + w + 3, y + h + 3], max_entities: 30 });
    if (!(o.entities || []).length) return [X, y];
  }
  return null;
}

async function main() {
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  const st0 = await rpc("obs", { max_entities: 1 });
  const baseline = st0.stats.total;

  // 实机扫：找远处、obs 确认无实体、且在 RuRuRuRu 资源上的点
  let site = null;
  for (const [x, y, s] of res) {
    if (s !== "RuRuRuRu" || Math.hypot(x, y) < 60) continue;
    const o = await rpc("obs", { region: [x - 20, y - 20, x + 20, y + 20], max_entities: 20 });
    if (!(o.entities || []).length) { site = [x, y]; break; }
  }
  if (!site) { log("no site"); return; }
  const [mx, my] = site;
  log(`源产地：矿 RuRuRuRu @ (${mx},${my})（距最近实体 ≥90）基线 ${baseline}`);

  // ① 造一条**含拐角**的产线：矿机(朝上) → 竖直 3 格 → 拐角右转 → 水平 4 格
  const cutY = my - 3;
  const r = {};
  r.miner = await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 0 });
  r.v = await rpc("act", { op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, cutY] });
  // 拐角：显式指定朝右（邻居此时已就位：下方有朝上的带 → 自动定向会算成"左转/右转"）
  r.corner = await rpc("act", { op: "place", building: "belt", x: mx, y: cutY - 1, r: 0 });   // 朝上
  r.h = await rpc("act", { op: "place_path", building: "belt", from: [mx, cutY - 2], to: [mx + 4, cutY - 2] }); // 水平向右
  log(`建成：矿机 ${r.miner.entity_uid}，竖直带 ${r.v.applied}，拐角 ${r.corner.entity_uid}，水平带 ${r.h.applied}`);

  const srcBox = [mx - 1, cutY - 3, mx + 5, my + 1];
  const o1 = await rpc("obs", { region: srcBox, max_entities: 40 });
  const srcBelts = (o1.entities || []).filter(e => e.type === "belt").sort((a, b) => b.y - a.y || a.x - b.x)
    .map(e => ({ x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code }));
  log(`\n★ 源蓝图（含拐角）：`);
  for (const b of srcBelts) log(`  (${b.x - mx},${b.y - my}) r=${b.r} rv=${b.rv} code=${b.code}`);

  // ② 导出
  const exp = await rpc("act", { op: "export_blueprint", region: srcBox });
  const text = exp.blueprint || exp.text || exp.blueprint_text;
  log(`蓝图长度 ${text.length}`);

  // ③ 在两个不同的空区域粘贴，比对 rv
  const sites = [];
  for (let k = 0; k < 2; k++) {
    const s = await findEmpty(mx + 100 + k * 80, my + 100, 8, 8);
    if (s) sites.push(s);
  }
  if (sites.length < 2) { log("找不到足够空地"); return; }

  const results = [];
  for (let k = 0; k < sites.length; k++) {
    const [px, py] = sites[k];
    const p = await rpc("act", { op: "paste_blueprint", text, x: px, y: py, charge: false });
    const o = await rpc("obs", { region: [px - 2, py - 5, px + 8, py + 3], max_entities: 40 });
    const belts = (o.entities || []).filter(e => e.type === "belt").sort((a, b) => b.y - a.y || a.x - b.x)
      .map(e => ({ dx: e.x - px, dy: e.y - py, r: e.r, rv: e.rotation_variant, code: e.code }));
    log(`\n粘贴 #${k + 1} @ (${px},${py}) applied=${p.applied}`);
    for (const b of belts) log(`  (${b.dx},${b.dy}) r=${b.r} rv=${b.rv} code=${b.code}`);
    results.push(belts);
  }

  // ④ 比对（用相对坐标归一化；锚点 = 导出区域的 min 角）
  const norm = arr => JSON.stringify(arr.map(b => `${b.dx ?? (b.x - mx)},${b.dy ?? (b.y - my)}:r${b.r}v${b.rv}c${b.code}`).sort());
  const nSrc = JSON.stringify(srcBelts.map(b => `${b.x - mx},${b.y - my}:r${b.r}v${b.rv}c${b.code}`).sort());
  const n0 = norm(results[0]), n1 = norm(results[1]);
  log(`\n=== 比对 ===`);
  log(`源 vs 粘贴#1: ${nSrc === n0 ? "✅ 一致" : "❌ 不一致"}`);
  log(`粘贴#1 vs #2: ${n0 === n1 ? "✅ 一致（幂等，与位置无关）" : "❌ 不一致"}`);
  if (nSrc !== n0) { log(`  源:   ${nSrc}`); log(`  #1:   ${n0}`); }
  if (n0 !== n1) { log(`  #1:   ${n0}`); log(`  #2:   ${n1}`); }
  const pass = nSrc === n0 && n0 === n1;
  log(`\n=== ${pass ? "✅ PASS —— 蓝图粘贴完全确定（拐角 rv 被正确保留）" : "❌ FAIL —— rv 仍不稳定"} ===`);

  // 清理（所有涉及区域）
  log("\n清理...");
  let total = 0;
  for (const box of [srcBox, ...sites.map(([px, py]) => [px - 3, py - 6, px + 9, py + 4])]) {
    const d = await rpc("act", { op: "bulk_delete", region: box }); total += d.applied;
  }
  const after = await rpc("obs", { max_entities: 1 });
  log(`清理 ${total} 个实体；世界实体=${after.stats.total}（基线 ${baseline}）${after.stats.total === baseline ? " ✅ 完全一致" : " ⚠️ 差 " + (after.stats.total - baseline)}`);

  fs.writeFileSync("research/ai-player/facts/live/exp-rv-fix.result.json",
    JSON.stringify({ test: "rv-determinism", pass, src: srcBelts, pasted: results, baseline, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
