import { solveGoal, mapOps, rebuildDag } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
import { place } from "file:///D:/Projects/rea/Project%20work/shapez/research/ai-plan/tmp/diag/place_dbg.mjs";
const sv = solveGoal("RuRu----", { level: 4 });
const mp = mapOps(rebuildDag(sv.steps));
const r = place({ steps: mp.steps, site:{x:-2,y:-2}, hub:{x:-2,y:-2}, world:null, seed:55013, range:96, demandPerSec:0, instanceIdx:0 });
console.log("ok:", r.ok, r.reason);
