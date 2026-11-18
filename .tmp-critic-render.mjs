/* Read-only: render the exact prompt the loop would build for the live L12 world. */
import fs from "node:fs";
import { buildPrompt } from "./src/agent/loop/prompt.mjs";
import { recipeForCached } from "./src/agent/loop/recipe.mjs";

const raw = JSON.parse(fs.readFileSync(".tmp-critic-obs.json", "utf8"));
const obs = raw.result || raw;

const goal = "CbCbCbRb:CwCwCwCw";
const lvl = obs.goal && obs.goal.level;
const recipe = recipeForCached(goal, Number.isFinite(lvl) ? { level: lvl } : { level: 12 });

console.log("=== RECIPE RESULT ===");
console.log("ok:", recipe.ok, "capped:", recipe.capped, "reason:", recipe.reason);
console.log("layers:", JSON.stringify(recipe.layers, null, 2));
console.log("hint:", recipe.hint);
console.log("stats:", JSON.stringify(recipe.stats));

let out;
try {
  out = buildPrompt({
    goal,
    obs,
    handles: [],
    diagnoses: [
      { code: "NO_PRODUCTION", layer: "L4", severity: "blocker", subject: { handle: "H1", type: "hub" },
        expected: `有产线在造 ${goal}`, observed: "窗口内产出 0",
        evidence: { handles: ["H1"], goal, machines: 28, mixers: 4, needs_cascade: true },
        candidates: ["insert_machine", "connect", "replace_run", "remove_run"],
        hint: "占位" },
    ],
    candidates: ["replace_run", "connect", "insert_machine", "extend_line", "remove_machine", "trash_unused"],
    budget: { ROUNDS_MAX: 10, LLM_CALLS_MAX: 20, TX_MAX: 10, TICKS_MAX: 24000, WALL_MS_MAX: 900000, round: 1 },
    recipe,
  });
} catch (e) {
  console.log("=== BUILD FAILED ===");
  console.log(e && e.message);
  console.log(JSON.stringify(e && e.detail, null, 2));
  process.exit(0);
}

const text = typeof out === "string" ? out : (out.user || "") + "\n" + (out.system || "");
console.log("\n=== PROMPT CHARS ===", text.length);
console.log("keys:", typeof out === "object" ? Object.keys(out) : "string");
if (out.blocks) console.log("blocks lens:", JSON.stringify(Object.fromEntries(Object.entries(out.blocks).map(([k, v]) => [k, typeof v === "string" ? v.length : null]))));
fs.writeFileSync(".tmp-critic-prompt.txt", text, "utf8");
console.log("written .tmp-critic-prompt.txt");

// Critical checks
const checks = [
  ["CHEAT SHEET present", /SHAPE CODE CHEAT SHEET/.test(text)],
  ["cheat says UPPERCASE = lower color", /UPPERCASE letter is the/.test(text)],
  ["cheat decodes Cb as cyan+blue (WRONG per game)", /cyan lower layer, upper layers/.test(text)],
  ["RECIPE section present", /## RECIPE/.test(text)],
  ["layer hint present", /分层做/.test(text)],
  ["stacker mentioned", /stacker/i.test(text)],
  ["white cascade mentioned", /CASCADE/.test(text)],
  ["WHITE/no-ore mentioned", /white/i.test(text)],
];
console.log("\n=== CHECKS ===");
for (const [n, v] of checks) console.log((v ? "YES " : "NO  ") + n);
