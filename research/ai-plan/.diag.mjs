import fs from "fs";
import { semanticDiagnoses } from "../../src/agent/loop/semantic.mjs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const RECIPE = {
    ok: true,
    steps: [
        { op: "mine", hash: "CuCuCuCu", inputs: [], args: {} },
        { op: "mineColor", hash: "color:blue", inputs: [], args: { color: "blue" } },
        { op: "mineColor", hash: "color:red", inputs: [], args: { color: "red" } },
        { op: "mix", hash: "color:purple", inputs: ["color:blue", "color:red"], args: { color: "purple" } },
        { op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "color:purple"], args: { color: "purple" } },
    ],
};
const h = buildHandles(obs, null);
const list = semanticDiagnoses(obs, null, "CpCpCpCp", h, { recipe: RECIPE, level: 9 });
console.log("codes:", list.map(d => d.code + "[" + d.severity + "]").join(", "));
for (const d of list) {
    console.log("\n=== " + d.code + " (" + d.layer + ") ===");
    console.log("observed:", String(d.observed).slice(0, 300));
    if (d.code === "MIXER_UNFED") {
        console.log("upstream:", JSON.stringify(d.evidence.upstream));
        console.log("slots:", JSON.stringify(d.evidence.slot_values), "why:", JSON.stringify(d.evidence.slot_why));
        console.log("ore_reach:", JSON.stringify(d.evidence.ore_reach.map(x => ({ p: x.pigment, d: x.distance, m: x.miners }))));
    }
    console.log("hint(180):", String(d.hint).slice(0, 180));
}
