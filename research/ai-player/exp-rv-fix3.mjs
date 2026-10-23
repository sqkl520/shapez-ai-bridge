/**
 * exp-rv-fix3.mjs — 拐角确定性反例实验（修正版，测量方式无歧义）。
 *
 * 要证伪的命题：「performImmutableOperation 包裹让蓝图粘贴的 rotationVariant 不受邻居影响」。
 *
 * 设计（避免上一版的坐标/占位混淆）：
 *   1) 造源拐角：竖直进料 → 拐角（右转）→ 水平输出。记下拐角格 code（预期 3 = 右转）。
 *   2) 导出仅"拐角 + 左右邻各一格"的 3 格小蓝图（竖直带、拐角、水平带），锚点=其 min corner。
 *   3) 粘贴两次，同一蓝图：
 *      · SITE_CLEAN：什么都不预置。
 *      · SITE_DISTURB：在拐角落点的**正上方一格**预置一条"朝上"的带 ——
 *        它是蓝图为空的格子（不冲突），但会让 belt.js 的启发式认为"该格应把货往上送"，
 *        即若无 immutable 保护，粘贴后重算会把拐角 rv 改掉。
 *   4) 判定**不看坐标推算**，只数每个粘贴点里 code=3 的拐角还在不在：
 *      CLEAN 与 DISTURB 都存在 code=3 且 rv=2 → 修复有效（邻居被 immutable 屏蔽）。
 *      DISTURB 的拐角变成别的 code（如直带 code=1）→ 修复无效。
 *
 * 清理：每站用**很宽**的盒子 bulk_delete，事后逐 uid 对拍快照（INCIDENT 教训）。
 */
import fs from "node:fs";
const BASE = "http://127.0.0.1:7777"; let id = 1;
async function rpc(m, a = {}) {
  const r = await fetch(BASE + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: a }), signal: AbortSignal.timeout(240000) });
  const b = await r.json(); if (b.error) { const e = new Error(b.error.message); e.rpc = b.error; throw e; } return b.result;
}
const log = (...a) => console.log(...a);

async function findRes(kind, minDist) {
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  for (const [x, y, s] of res) {
    if (s !== kind || Math.hypot(x, y) < minDist) continue;
    const o = await rpc("obs", { region: [x - 6, y - 8, x + 12, y + 6], max_entities: 10 });
    if (!(o.entities || []).length) return [x, y];
  }
  return null;
}
// 数一个区域内各 code 的带子；返回 {cornerRv, cornerCount, all}
async function beltsHere(region) {
  const o = await rpc("obs", { region, max_entities: 100 });
  return (o.entities || []).filter(e => e.type === "belt").map(e => ({ x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code }));
}

async function main() {
  const base = (await rpc("obs", { max_entities: 1 })).stats.total;
  log(`基线实体数: ${base}`);
  const zones = [];   // 记录所有动过的区域，末尾统一清理

  // ── 源拐角 ──
  const S = await findRes("RuRuRuRu", 140);
  if (!S) { log("no source"); return; }
  const [mx, my] = S;
  log(`\n[源] (${mx},${my})：竖直进料 → 拐角(右转) → 水平输出`);
  // 竖直：矿机上方两格向上；拐角在 (mx+2, my-1)：从左边(mx+1,my-1)进料、向上出→但我们要"右转"
  // 直接构造：横向带向右流 → 拐角把货转向"下"→ 这是可稳定产生的右转形态
  await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 90 });          // 朝右喷
  await rpc("act", { op: "place", building: "belt", x: mx + 1, y: my, r: 90 });      // 紧邻一格（退化段用 place，见 §4.4）
  // 拐角落在 (mx+2, my)，左右邻居将决定它弯向；我们显式让它成为 code=3 的样本——先放置，读实际 code
  await rpc("act", { op: "place", building: "belt", x: mx + 2, y: my, r: 90 });
  await rpc("act", { op: "place_path", building: "belt", from: [mx + 3, my], to: [mx + 4, my] });
  const srcBelts = await beltsHere([mx - 1, my - 3, mx + 6, my + 3]);
  log(`源带子: ${JSON.stringify(srcBelts)}`);
  // 找一个"非直带"(code 2 或 3)作为拐角样本；若源里没有，退而用竖直进料构造
  let corner = srcBelts.find(b => b.code === 3) || srcBelts.find(b => b.code === 2) || srcBelts.find(b => b.rv > 0);
  if (!corner) {
    log("源没产生弯带，改用 L 形（竖直进料→水平出）");
    // 竖直进料：矿机朝上，向上铺，再在顶部向右拐
    await rpc("act", { op: "bulk_delete", region: [mx - 1, my - 3, mx + 6, my + 3] });
    await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 0 });
    await rpc("act", { op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, my - 3] });
    await rpc("act", { op: "place", building: "belt", x: mx, y: my - 4, r: 90 });   // 拐角：从下进、向右出
    await rpc("act", { op: "place_path", building: "belt", from: [mx + 1, my - 4], to: [mx + 2, my - 4] });
    const s2 = await beltsHere([mx - 1, my - 6, mx + 4, my + 1]);
    log(`L 形源带子: ${JSON.stringify(s2)}`);
    corner = s2.find(b => b.code >= 2) || s2.find(b => b.rv > 0);
    Object.assign(globalThis, { SRC: { mx, my, cy: my - 4 } });
    if (!corner) { log("仍无弯带，中止"); return; }
  }
  log(`拐角样本: ${JSON.stringify(corner)}  (code=${corner.code}, rv=${corner.rv})`);
  const cornerCode = corner.code, cornerRv = corner.rv;

  // ── 小蓝图：以拐角为中心 3×1（左邻、拐角、右邻）——但为避免锚点歧义，导出**包围盒=拐角±1**
  const cx = corner.x, cy = corner.y;
  const exp = await rpc("act", { op: "export_blueprint", region: [cx - 1, cy - 1, cx + 1, cy + 1] });
  const text = exp.blueprint || exp.text || exp.blueprint_text;
  if (!text) { log("导出失败"); return; }
  log(`小蓝图 ${text.length} 字符，区域 [${cx - 1},${cy - 1},${cx + 1},${cy + 1}]（min corner = (${cx - 1},${cy - 1})）`);
  // 粘贴时 anchor→(X,Y)，则拐角落在 (X+1, Y+1)
  zones.push([cx - 3, cy - 3, cx + 4, cy + 3]);

  async function pasteAt(label, X, Y, disturb) {
    // 找一个 (X,Y) 起点附近足够空的位置
    let px = X, py = Y;
    for (let t = 0; t < 40; t++) {
      const o = await rpc("obs", { region: [px - 3, py - 3, px + 5, py + 5], max_entities: 10 });
      if (!(o.entities || []).length) break;
      py += 30; px += 15;
    }
    log(`\n[${label}] 粘贴锚点 (${px},${py})（拐角落点应为 (${px + 1},${py + 1})）`);
    if (disturb) {
      // 干扰：在拐角落点的正上方一格预置朝上的带（蓝图为空、不冲突；但启发式会想"往上送"）
      const dx = px + 1, dy = py + 1 - 1;
      const chk = await rpc("obs", { region: [dx, dy, dx, dy], max_entities: 5 });
      if (!((chk.entities || []).length)) {
        await rpc("act", { op: "place", building: "belt", x: dx, y: dy, r: 0 });
        log(`  预置干扰带 @ (${dx},${dy}) r=0 朝上（拐角正上方）`);
      } else log(`  干扰位已被占，跳过预置`);
    }
    const paste = await rpc("act", { op: "paste_blueprint", text, x: px, y: py, charge: false });
    log(`  粘贴 applied=${paste.applied}`);
    const bs = await beltsHere([px - 3, py - 4, px + 6, py + 6]);
    const c = bs.find(b => b.x === px + 1 && b.y === py + 1);
    const hasCorner = bs.some(b => b.code === cornerCode);
    log(`  拐角落点 (${px + 1},${py + 1}) 实况: ${JSON.stringify(c)}`);
    log(`  该 code=${cornerCode}(rv=${cornerRv}) 的拐角是否存在于结果中？ ${hasCorner ? "✅ 在" : "❌ 被改写"}`);
    zones.push([px - 5, py - 6, px + 8, py + 6]);
    return { corner: c, hasCorner };
  }

  const clean = await pasteAt("CLEAN", mx + 40, my, false);
  const dist = await pasteAt("DISTURB", mx + 80, my, true);

  log(`\n=== 判定 ===`);
  const pass = clean.hasCorner && dist.hasCorner;
  log(`CLEAN   拐角保留: ${clean.hasCorner}`);
  log(`DISTURB 拐角保留: ${dist.hasCorner}  （邻居有朝上干扰带，若无 immutable 屏蔽会被重算）`);
  log(`${pass
    ? "✅ performImmutableOperation 修复有效：同一蓝图的拐角 rv 在两处都保持，不受粘贴时邻居影响。"
    : (clean.hasCorner && !dist.hasCorner
      ? "❌ 修复无效：干净处 OK，但受扰处拐角被邻居重算改写 —— 印证审查的 F1。"
      : "⚠️ 连干净处拐角都没保留，测试或导出有问题，需查。")}`);

  // ── 清理 + 逐 uid 对拍 ──
  log("\n清理...");
  let del = 0;
  for (const box of zones) { try { const d = await rpc("act", { op: "bulk_delete", region: box }); del += d.applied; } catch (e) { log("  清理区失败:", e.message); } }
  const after = await rpc("obs", { max_entities: 1 });
  log(`删除 ${del}；世界 = ${after.stats.total}（基线 ${base}）${after.stats.total === base ? " ✅" : " ⚠️ 差 " + (after.stats.total - base)}`);
  fs.writeFileSync("research/ai-player/facts/live/exp-rv-fix3.result.json",
    JSON.stringify({ test: "rv-falsification-v3", cornerCode, cornerRv,
      clean: { hasCorner: clean.hasCorner, corner: clean.corner },
      disturb: { hasCorner: dist.hasCorner, corner: dist.corner },
      pass, base, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
