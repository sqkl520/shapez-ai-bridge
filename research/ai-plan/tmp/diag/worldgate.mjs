import { compilePlan } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
import fs from "node:fs";
const ents = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const base = { goal: "RuRu----", hub: [-2,-2], level: 4, seed: 55013 };
for (const [label, extra] of [
  ["只有 worldEntities（= CLI --world 的路径）", { worldEntities: ents }],
  ["只有 input.world.entities", { world: { entities: ents } }],
  ["两者都给", { worldEntities: ents, world: { entities: ents } }],
]) {
  const p = compilePlan({ ...base, ...extra });
  console.log(label, "=> ok:", p.ok, "reason:", p.reason, "hint:", String(p.hint||"").slice(0,90));
}
