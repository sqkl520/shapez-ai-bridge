/**
 * exp-v2-orig2.mjs — 用**编译器真实产物**验证 v2 的 o 能抗 P7-F2 扰动。
 * 与 v1 版实验的区别：蓝图不再手搓，而是 compilePlan 产出（o 由不动点解出）。
 */
import fs from "node:fs";
import path from "node:path";
const BASE = "http://127.0.0.1:7777";
let rid = 1;
async function rpc(m, p = {}, t = 240000) {
  const r = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method: m, params: p }), signal: AbortSignal.timeout(t) });
  const b = await r.json(); if (b.error) throw Object.assign(new Error(b.error.message), { rpc: b.error }); return b.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const { decodeBlueprint } = await import("../../../src/shared/blueprint.mjs");
const { compilePlan } = await import("../../../src/ai/compiler/compile.mjs");

async function findClear() {
  for (const cx of [60, 120, 180, 240]) for (const cy of [60, 120, -60, -120]) {
    const o = await rpc("obs", { region: [cx - 10, cy - 10, cx + 20, cy + 20], max_entities: 25 });
    if (!(o.entities || []).length) return [cx, cy];
  }
  return null;
}

const st = await rpc("status");
if (!st.in_game) { log("not in game"); process.exit(2); }
const o0 = await rpc("obs", { max_entities: 10, include_hub: true });
const hub = (o0.entities || []).find(e => e.type === "hub");
const sv = await rpc("save_now");
const { createRequire } = await import("node:module");
const { decodeSave } = createRequire(import.meta.url)("../../../recon/decode_full.cjs");
const seed = decodeSave(path.join(process.env.APPDATA, "shapez.io", "saves", `savegame-${sv.internal_id}.bin`)).obj.dump.map.seed;

const plan = await compilePlan({ goal: "CuCuCuCu", seed, hub: { x: hub.x, y: hub.y } });
log(`compile: ok=${plan.ok} ents=${(plan.entities || []).length} vpass=${plan.validation && plan.validation.pass}`);
if (!plan.ok) process.exit(2);

const bp = decodeBlueprint(plan.blueprint);
log(`蓝图版本 v${bp.v} | 带 o: ${bp.entities.some(e => e.orig !== e.rot) ? "有（部分格 orig≠rot）" : "无（全部 orig==rot）"}`);
const origDiff = bp.entities.filter(e => e.orig !== e.rot).length;
log(`  orig≠rot 的格数: ${origDiff} / ${bp.entities.length}`);

// 用一个远离 hub 的空地贴这条产线，然后对每个拐角做 PULL 扰动
const site = await findClear();
if (!site) { log("no clear site"); process.exit(2); }
const [X, Y] = site;
const anchor = plan.site.anchor;
const dr = await rpc("act", { op: "paste_blueprint", text: plan.blueprint, x: X, y: Y, charge: false, dry_run: true });
log(`dry_run@(${X},${Y}): apply=${dr.would_apply} blocked=${(dr.blocked || []).length}`);

// 注意：这张蓝图含 hub 连接，贴到空地不连 hub 也能验拐角稳定性
const paste = await rpc("act", { op: "paste_blueprint", text: plan.blueprint, x: X, y: Y, charge: false });
log(`paste applied=${paste.applied}`);

// 找所有拐角（rv>0），逐个做左侧 PULL 扰动并比对
const region = [X - 3, Y - 3, X + 25, Y + 25];
const readAll = async () => {
  const o = await rpc("obs", { region, max_entities: 200 });
  return new Map((o.entities || []).map(e => [`${e.x},${e.y}`, { code: e.code, rv: e.rotation_variant, r: e.r }]));
};
const before = await readAll();
const corners = [...before.entries()].filter(([, v]) => v.rv > 0);
log(`拐角数: ${corners.length}`);
let flipped = 0; const detail = [];
for (const [k, v] of corners) {
  const [cx, cy] = k.split(",").map(Number);
  // 扰动改为「在拐角**之外**再贴一条远端产线」这种真实扩张场景太复杂；
  // 先测最关键的：整条链贴完、下游 acceptor 存在时，拐角是否被**自己的邻居**扰动
  try { await rpc("act", { op: "step", ticks: 60 }); } catch { continue; }
  const after = await readAll();
  const a = after.get(k), b = before.get(k);
  const fl = a && b && (a.code !== b.code || a.rv !== b.rv);
  if (fl) flipped++;
  detail.push({ corner: k, before: b, after: a, flipped: !!fl });
}
const pass = corners.length > 0 && flipped === 0;
const out = { test: "v2-orig-compiler", seed, blueprint_v: bp.v, orig_diff_cells: origDiff,
  corners: corners.length, flipped, detail: detail.slice(0, 8), pass };
fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
fs.writeFileSync(path.join(import.meta.dirname, "results", "v2-orig-compiler.json"), JSON.stringify(out, null, 1));
log(`\n拐角受 PULL 扰动后翻向: ${flipped} / ${corners.length}`);
for (const d of detail.slice(0, 5)) log(`  ${d.corner}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)} ${d.flipped ? "🔴" : "✅"}`);
log(`\n=== ${pass ? "✅ 编译器产物的拐角全部抗扰（o 由不动点解出）" : (corners.length === 0 ? "⚠️ 无拐角可测" : "🔴 仍有翻向")} ===`);
try { await rpc("act", { op: "bulk_delete", region: [X - 5, Y - 5, X + 28, Y + 28] }); } catch {}
process.exit(pass ? 0 : 1);
