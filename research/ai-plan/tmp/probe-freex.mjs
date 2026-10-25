// 受控实验：矿机 x 自由浮动（保序），其余不动，能否布通 CpCpCpCp？
// 做法：直接在 place() 之前把矿机节点的 x 改到资源列上，再走原有流程。
import { resourcesInRegion, tileResource } from '../../../src/ai/world.mjs';
import { place } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';
const SEED = 43391, R = 400;
const rowsMap = new Map();
for (const [x, y, s] of resourcesInRegion(SEED, { x0: -R, y0: -R, x1: R, y1: R })) {
  if (!rowsMap.has(y)) rowsMap.set(y, new Map());
  const m = rowsMap.get(y); if (!m.has(s)) m.set(s, []); m.get(s).push(x);
}
for (const m of rowsMap.values()) for (const a of m.values()) a.sort((p, q) => p - q);

// 找一行：保序可行
function findByRow(seq) {
  for (const [y, m] of rowsMap) {
    let prev = -Infinity, ok = true; const xs = [];
    for (const s of seq) {
      const arr = m.get(s) || [];
      const x = arr.find(v => v > prev);
      if (x === undefined) { ok = false; break; }
      xs.push(x); prev = x;
    }
    if (ok) return { y, xs };
  }
  return null;
}
const goal = 'CpCpCpCp';
const g = inspectGoal(goal);
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
// 布局的矿机顺序（按 x）
const base = place({ steps: mp.steps, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, world: hubWorldState([0, 0], null), connectHub: false, rowGap: 8, colGap: 3 });
const minerPl = base.placements.filter(p => p.kind === 'miner').sort((a, b) => a.cell[0] - b.cell[0]);
console.log('layout miner order:', minerPl.map(p => p.nodeId).join(' '));
const resourceOf = base.meta.minerResources;
console.log('resources:', JSON.stringify(resourceOf));
// 按 layout 顺序查可行行
const seq = minerPl.map(p => resourceOf[p.nodeId]);
const hit = findByRow(seq);
console.log('order-preserving row:', hit ? `y=${hit.y} xs=[${hit.xs}]` : 'NONE');
