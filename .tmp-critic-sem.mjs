/* Read-only: run the loop's real diagnose() semantic layer against live data. */
import fs from "node:fs";
import { semanticDiagnoses } from "./src/agent/loop/semantic.mjs";
import { recipeForCached } from "./src/agent/loop/recipe.mjs";

const obs = JSON.parse(fs.readFileSync(".tmp-critic-obs2.json", "utf8")).result;
const items = JSON.parse(fs.readFileSync(".tmp-critic-i3.json", "utf8")).result;
const goal = obs.goal.requirement.shape;
const recipe = recipeForCached(goal, { level: obs.goal.level });

let out;
try {
  out = semanticDiagnoses(obs, items, goal, [], { recipe, level: obs.goal.level });
} catch (e) {
  console.log("THREW:", e && e.message);
  console.log((e && e.stack || "").split("\n").slice(0, 8).join("\n"));
  process.exit(0);
}
console.log("diagnoses:", out.length);
for (const d of out) console.log("  " + d.code + "  " + String(d.observed || "").slice(0, 170));
