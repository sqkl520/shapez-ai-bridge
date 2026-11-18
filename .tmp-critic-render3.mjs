/* Faithful re-render: use a real run's obs-last.json + its real diagnoses. */
import fs from "node:fs";
import { buildPrompt } from "./src/agent/loop/prompt.mjs";
import { recipeForCached } from "./src/agent/loop/recipe.mjs";

const runDir = process.argv[2];
const obs = JSON.parse(fs.readFileSync(runDir + "/obs-last.json", "utf8"));
const tran = fs.readFileSync(runDir + "/transcript.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const diag = tran.find(e => e.kind === "diagnose");
const diagnoses = (diag.data.diagnoses || []);

const goal = obs.goal.requirement.shape;
const recipe = recipeForCached(goal, { level: obs.goal.level });

// Candidate list as it appeared in the run's first propose
const prop = tran.find(e => e.kind === "propose" && Array.isArray(e.data.candidates));
const candidates = prop.data.candidates;

let out;
try {
  out = buildPrompt({
    goal, obs, handles: [], diagnoses, candidates,
    budget: { round: 1, rounds_left: 5, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 900000, in_chars_max: 24000, prompt_tokens_max: 4600 },
    recipe,
  });
} catch (e) {
  console.log("BUILD FAILED:", e && e.message);
  console.log(JSON.stringify(e && e.detail, null, 1).slice(0, 2000));
  process.exit(0);
}
const text = out.system + "\n\n" + out.user;
fs.writeFileSync(".tmp-critic-prompt2.txt", text, "utf8");
console.log("chars:", text.length, "limit 24000");
console.log("blocks:", JSON.stringify(Object.fromEntries(Object.entries(out.blocks).map(([k, v]) => [k, typeof v === "string" ? v.length : (typeof v === "boolean" ? v : null)]))));
for (const k of ["s3_goal", "s3_hub", "s3_machines", "s3_belts", "s3_production", "s3_capacity", "capacity_unavailable", "resource_dropped_for_capacity", "ore_hint_dropped_for_capacity", "belts_shown", "belts_total", "recipe_capped"]) {
  console.log(" ", k, "=", typeof out.blocks[k] === "string" ? JSON.stringify(out.blocks[k].slice(0, 200)) : out.blocks[k]);
}
console.log("\n--- GOAL..MACHINES region ---");
const i = text.indexOf("## GOAL");
console.log(text.slice(i, i + 2000));
