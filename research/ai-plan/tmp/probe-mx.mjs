import { planMultiInputRows, buildDag } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal } from '../../../src/ai/compiler/compile.mjs';
const g = inspectGoal('CgScScCg'); const sv = solveGoal(g.goal,{level:g.level}); const mp = mapOps(rebuildDag(sv.steps));
const dag = buildDag(mp.steps, {});
for (const n of dag.nodes) { n.x = 0; n.y = 0; }
const n5 = dag.nodes.find(n=>n.id==='n5'), n9 = dag.nodes.find(n=>n.id==='n9');
n5.x = -123; n5.y = 30;
n9.x = -41;  n9.y = 14;
const rr = planMultiInputRows(dag.nodes, { rowGap: 8 });
console.log('rowY:', [...rr.rowY.entries()]);
console.log('colX:', [...rr.colX.entries()]);
