import { solveGoal, mapOps, rebuildDag } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
import { place } from "file:///D:/Projects/rea/Project%20work/shapez/research/ai-plan/tmp/diag/place_reorder.mjs";
import fs from "node:fs";

const goal = "RuRu----";
const sv = solveGoal(goal, { level: 4 });
const dg = rebuildDag(sv.steps);
const mp = mapOps(dg);
const hub = [-2, -2];
const worldEntities = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const ws = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/run_world.json","utf8"));

function run(label, ents, extra={}) {
  const input = {
    steps: JSON.parse(JSON.stringify(mp.steps)),
    site: { x: hub[0], y: hub[1] },
    hub: { x: hub[0], y: hub[1] },
    world: ents ? { entities: ents, hub: { x: hub[0], y: hub[1] }, seed: 43391, replaceableBeltCells: [] } : null,
    seed: 43391, range: 96, rowGap: undefined, colGap: undefined, demandPerSec: 0, instanceIdx: 0, ...extra,
  };
  const r = place(input);
  console.log("=====", label, "ok=", r.ok !== false, r.ok === false ? r.reason : "");
  if (r.ok === false) console.log(JSON.stringify(r.failingNode), r.hint);
  else {
    console.log("placements machine nodes:");
    for (const p of (r.placements||[])) console.log("  ", p.nodeId, p.op||p.kind, "x",p.x,"y",p.y, "fp", JSON.stringify(p.footprint||p.w+","+p.h));
    console.log("waste:", JSON.stringify(r.waste));
    console.log("hubConnection:", JSON.stringify(r.hubConnection));
    console.log("beltCells:", JSON.stringify((r.beltCells||[]).map(b=>[b.cell[0],b.cell[1],b.inDir,b.outDir])));
  }
  return r;
}
console.log("steps:", JSON.stringify(mp.steps));
run("no-world", null);
run("no-world (connectHub:false)", null, { connectHub: false });
run("with-world", worldEntities);
run("with-world (connectHub:false)", worldEntities, { connectHub: false });
