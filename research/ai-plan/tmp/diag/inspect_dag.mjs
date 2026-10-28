import { solveGoal, mapOps, rebuildDag, inspectGoal } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
const goal = process.argv[2] || "RuRu----";
console.log("inspectGoal:", JSON.stringify(inspectGoal(goal)));
const s = solveGoal(goal, { seed: 43391 });
console.log("solve ok?", s.ok !== false, "reason", s.reason);
if (s.ok === false) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
console.log("steps:", JSON.stringify(s.steps || s.dag || s, null, 1).slice(0, 4000));
