/**
 * 对比三种"既有工厂"策略下 level 4 能否编译。
 * 这不是猜：每种策略都真的跑一遍 compilePlan，用结果说话。
 */
import { rpc } from "../live/kit.mjs";
import { compilePlan } from "../../../src/ai/compiler/compile.mjs";

const o = await rpc("obs", { max_entities: 500, include_stats: false }, 90000);
const ents = (o.entities || []).map(e => ({ uid: e.uid, type: e.type, x: e.x, y: e.y, r: e.r, code: e.code }));
console.log("世界里有", ents.length, "个实体");

const variants = [
  ["无既有工厂（推倒重来）", []],
  ["只有机器挡住（带子可覆盖）", ents.filter(e => e.type !== "belt" && e.type !== "hub")],
  ["全部挡住（现状策略）", ents.filter(e => e.type !== "hub")],
];

for (const [label, worldEntities] of variants) {
  const p = compilePlan({ goal: "RuRu----", seed: 60908, hub: [-2, -2], worldEntities, tunnels: true });
  console.log(label.padEnd(26), p.ok ? `OK ${p.entities.length} ents @${JSON.stringify(p.provenance.worldPlacement.pasteAt)}` : `FAIL ${p.reason}`);
}
