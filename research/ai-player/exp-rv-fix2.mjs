/**
 * exp-rv-fix2.mjs — 拐角确定性的**反例实验**（对抗审查要求的检验）。
 *
 * 审查结论（review/ADVERSARIAL-REVIEW.md F1，我已亲自核实源码）：
 *   systems/belt.js:63 把 updateSurroundingBeltPlacement 挂在 entityAdded 上；
 *   每放一格，它会把**周围一圈**带子的 rotation/rotationVariant 按邻居重算并覆写
 *   （belt.js:129-175），唯一豁免 = immutableOperationRunning（belt.js:169）。
 *   游戏原生粘贴用 performBulkOperation+performImmutableOperation 双层（blueprint.js:159）；
 *   我们只有第一层 → 蓝图的 rv 在粘贴**过程中**就会被邻居改写。
 *
 * 本实验（修复后运行）：
 *   T1 反例粘贴：先在粘贴点**正上方预置**一条会诱发启发式"左转"的竖直进料带，
 *      再粘贴一条"该格应为右转(code3)"的拐角蓝图。
 *      若邻居重算仍生效 → 拐角被改成左转；修复生效 → 保持右转。
 *   T2 双点幂等：同一蓝图在两个不同环境粘贴，逐格（相对锚点）比对 r/rv/code。
 *   T3 事后扰动：粘贴完成后在拐角旁补放一格，检查拐角是否被"事后"重算
 *      （这个**不在** immutable 保护内 —— 预期 rv 会变！如实记录，文档必须写明）。
 *
 * 严格遵循 INCIDENT 教训：选址远离工厂、事前 obs 自查、事后 bulk_delete + 逐 uid 对拍。
 */
import fs from "node:fs";
const BASE = "http://127.0.0.1:7777"; let id = 1;
async function rpc(m, a = {}) {
  const r = await fetch(BASE + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: a }), signal: AbortSignal.timeout(240000) });
  const b = await r.json(); if (b.error) { const e = new Error(b.error.message); e.rpc = b.error; throw e; } return b.result;
}
const log = (...a) => console.log(...a);

async function findClearRes(mine, kind, r = 120) {
  const res = JSON.parse(fs.readFileSync("research/ai-player/facts/live/resources.json", "utf8"));
  // 不依赖可能过期的 world-full.json：逐个候选用**实机 obs** 检查所需盒子是否为空
  for (const [x, y, s] of res) {
    if (s !== kind || Math.hypot(x, y) < r) continue;
    const o = await rpc("obs", { region: [x - 8, y - 10, x + 16, y + 6], max_entities: 10 });
    if (!(o.entities || []).length) return [x, y];
  }
  return null;
}
const dumpBelts = async region => {
  const o = await rpc("obs", { region, max_entities: 200 });
  return (o.entities || []).filter(e => e.type === "belt")
    .map(e => ({ x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code }));
};

async function main() {
  const base = (await rpc("obs", { max_entities: 1 })).stats.total;
  log(`基线实体数: ${base}`);

  // ── 源产线：竖直进料（向上）→ 拐角（右转，r=90→实际游戏会算成 code?）→ 水平向右 ──
  const S = await findClearRes(null, "RuRuRuRu");
  if (!S) { log("no source site"); return; }
  const [mx, my] = S;
  const pre = await rpc("obs", { region: [mx - 8, my - 10, mx + 16, my + 6], max_entities: 30 });
  if ((pre.entities || []).length) { log("源区非空"); return; }
  log(`\n[源] 矿机 (${mx},${my}) → 竖直带×3 → 拐角 → 水平带×3`);
  await rpc("act", { op: "place", building: "miner", x: mx, y: my, r: 0 });
  await rpc("act", { op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, my - 3] });
  const cornerPos = [mx, my - 4];   // 拐角：从下进、向右出
  await rpc("act", { op: "place", building: "belt", x: cornerPos[0], y: cornerPos[1], r: 90 });
  await rpc("act", { op: "place_path", building: "belt", from: [mx + 1, my - 4], to: [mx + 3, my - 4] });
  const src = await dumpBelts([mx - 2, my - 6, mx + 5, my + 1]);
  log(`源带子（${src.length} 条）: ${JSON.stringify(src)}`);
  const exp = await rpc("act", { op: "export_blueprint", region: [mx - 1, my - 5, mx + 4, my - 1] });
  const text = exp.blueprint || exp.text || exp.blueprint_text;
  if (!text) { log("导出失败"); return; }
  log(`蓝图 ${text.length} 字符（含矿机上方 3 竖直带 + 拐角 + 3 水平带，区域不含矿机）`);

  // 蓝图的**相对锚点** = 导出区 min corner (mx-1, my-5)。拐角在区内相对位置：
  const anchor = [mx - 1, my - 5];
  const rel = b => `${b.x - mx},${b.y - my}`;
  const srcCorner = src.find(b => b.x === cornerPos[0] && b.y === cornerPos[1]);
  log(`源拐角: ${JSON.stringify(srcCorner)}（相对锚点 ${srcCorner.x - anchor[0]},${srcCorner.y - anchor[1]}）`);

  // ── T1 反例：粘贴点上方预置一条朝上的竖直带，与拐角格形成"从下注入"的邻居，
  //     使启发式若重算则倾向把它改成"左/直"（与蓝图的右转意图相悖）
  const P1 = await findClearRes(null, "RuRuRuRu", 130);
  if (!P1) { log("no T1 site"); return; }
  let [p1x, p1y] = P1;
  for (let t = 0; t < 30; t++) {
    const chk = await rpc("obs", { region: [p1x - 4, p1y - 6, p1x + 8, p1y + 6], max_entities: 10 });
    if (!(chk.entities || []).length) break;
    p1y += 40;
  }
  // 先在**拐角落点**处放一条诱饵竖直带（r=0 朝上），再移除它 → 邻居信号存在过；
  // 更直接：在其上方 (p1c_x, p1c_y-1) 放一条带，使"上方有 acceptor-ish"。
  const cDx = srcCorner.x - anchor[0], cDy = srcCorner.y - anchor[1];
  const pc = [p1x + cDx, p1y + cDy];   // 拐角粘贴后的绝对位置
  log(`\n[T1 反例] 预置干扰带 @ (${pc[0]},${pc[1] - 1})（拐角落点正上方），r=0 朝上 —— 启发式重算会认为拐角应把货送上这条带`);
  await rpc("act", { op: "place", building: "belt", x: pc[0], y: pc[1] - 1, r: 0 });
  const t1 = await rpc("act", { op: "paste_blueprint", text, x: p1x, y: p1y, charge: false });
  log(`T1 粘贴 applied=${t1.applied}`);
  const b1 = await dumpBelts([p1x - 2, p1y - 6, p1x + 8, p1y + 6]);
  const t1Corner = b1.find(b => b.x === pc[0] && b.y === pc[1]);
  log(`T1 拐角落点实况: ${JSON.stringify(t1Corner)}   （源: ${JSON.stringify(srcCorner)}）`);
  const T1ok = t1Corner && t1Corner.r === srcCorner.r && t1Corner.rv === srcCorner.rv && t1Corner.code === srcCorner.code;
  log(`T1 ${T1ok ? "✅ 蓝图 rv 抵抗住了邻居干扰（immutable 包裹生效）" : "❌ 拐角被邻居重算改写 —— 修复无效"}`);

  // ── T2 双点幂等（干净环境）
  const P2 = [p1x + 60, p1y];
  for (let t = 0; t < 30; t++) {
    const chk = await rpc("obs", { region: [P2[0] - 3, P2[1] - 6, P2[0] + 9, P2[1] + 6], max_entities: 10 });
    if (!(chk.entities || []).length) break;
    P2[1] += 40;
  }
  const t2 = await rpc("act", { op: "paste_blueprint", text, x: P2[0], y: P2[1], charge: false });
  const b2 = await dumpBelts([P2[0] - 2, P2[1] - 6, P2[0] + 8, P2[1] + 6]);
  const norm = (bs, ax, ay) => JSON.stringify(bs.filter(b => b.x >= ax - 2 && b.x <= ax + 6 && b.y <= ay + 2 && b.y >= ay - 6)
    .map(b => `${b.x - ax},${b.y - ay}:r${b.r}v${b.rv}c${b.code}`).sort());
  const nT1 = norm(b1.filter(b => !(b.x === pc[0] && b.y === pc[1] - 1)), p1x, p1y);  // 去掉干扰带
  const nT2 = norm(b2, P2[0], P2[1]);
  log(`\n[T2] 干净粘贴 applied=${t2.applied}`);
  const T2ok = nT1 === nT2;
  log(`T2 同蓝图两处（含受扰/干净）逐格比对: ${T2ok ? "✅ 完全一致" : "❌ 不一致"}\n  受扰点: ${nT1}\n  干净点: ${nT2}`);

  // ── T3 事后扰动：粘贴后再在拐角旁放一格 —— 这**不在** immutable 保护内，
  //     按源码（entityAdded→updateSurroundingBeltPlacement）拐角**应当**被改写。
  const disturb = [pc[0] + 1, pc[1]];   // 拐角右侧再放一条带
  await rpc("act", { op: "place", building: "belt", x: disturb[0], y: disturb[1], r: 90 });
  const b3 = await dumpBelts([p1x - 2, p1y - 6, p1x + 9, p1y + 6]);
  const t3Corner = b3.find(b => b.x === pc[0] && b.y === pc[1]);
  log(`\n[T3 事后扰动] 拐角旁补放一格后，拐角实况: ${JSON.stringify(t3Corner)}`);
  log(`T3 ${t3Corner && t3Corner.rv === srcCorner.rv ? "（未变 —— 值得注意）" : "（被改写 —— 符合源码预期：immutable 只保护粘贴过程本身）"}`);

  // ── 清理：逐区删除 + 逐 uid 对拍
  log("\n清理...");
  let del = 0;
  for (const box of [[mx - 3, my - 8, mx + 7, my + 2], [p1x - 4, p1y - 8, p1x + 10, p1y + 2], [P2[0] - 4, P2[1] - 8, P2[0] + 10, P2[1] + 2]]) {
    const d = await rpc("act", { op: "bulk_delete", region: box }); del += d.applied;
  }
  const after = await rpc("obs", { max_entities: 1 });
  log(`清理 ${del} 实体；世界 = ${after.stats.total}（基线 ${base}）${after.stats.total === base ? " ✅" : " ⚠️ 差 " + (after.stats.total - base)}`);

  const allPass = T1ok && T2ok;
  log(`\n=== 总判定: ${allPass ? "✅ 修复后的粘贴对**粘贴时邻居**确定（T3 的事后重算属预期行为，需在文档标注）" : "❌ 修复无效或不完整"} ===`);
  fs.writeFileSync("research/ai-player/facts/live/exp-rv-fix2.result.json",
    JSON.stringify({ test: "rv-falsification", T1: { ok: T1ok, corner_src: srcCorner, corner_after: t1Corner },
      T2: { ok: T2ok }, T3: { corner_after_disturb: t3Corner }, base, after_total: after.stats.total }, null, 1));
}
main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
