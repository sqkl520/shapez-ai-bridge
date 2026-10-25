import { buildDag, layerAndOrder, planMultiInputRows, assignRows } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal } from '../../../src/ai/compiler/compile.mjs';
const g = inspectGoal('CgScScCg'); const sv = solveGoal(g.goal,{level:g.level});
const dag = buildDag(mapOps(rebuildDag(sv.steps)).steps, {});
const levels = layerAndOrder(dag.nodes);
// 第一轮（无约束）
assignRows(levels, { rowGap: 8, colGap: 3, minerX: null });
for (const n of dag.nodes) if (['n5','n9','n10'].includes(n.id)) console.log('1st', n.id, n.x, n.y);
const rr = planMultiInputRows(dag.nodes, { rowGap: 8 });
console.log('rowY:', [...rr.rowY.entries()], 'colX:', [...rr.colX.entries()]);
