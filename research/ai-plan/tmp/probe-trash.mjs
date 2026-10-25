import { place } from "../../../src/ai/compiler/place.mjs";
import { inspectGoal, solveGoal, rebuildDag, mapOps } from "../../../src/ai/compiler/compile.mjs";

const g = inspectGoal("RuRu----");
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
// 打印设计节点（buildDag 之后）
import { buildDag } from "../../../src/ai/compiler/place.mjs";
const dag = buildDag(mp.steps);
for (const n of dag.nodes) {
  console.log(n.id.padEnd(6), n.op.padEnd(7), "parents:", n.parents.map(p=>p&&p.id).join(","), "| role outs:", (n.template.outputs||[]).map(o=>o.role).join(","));
}
