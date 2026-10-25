// ch1 (-g------ → -c------) 占用了 (-219,48)。
// 它是 Z 形：从 -265 竖直到某行，横走到 -219 附近，再竖进 mix。
// 我们想知道：这条通道在第 (-219, 4x) 列上占了几格连续？
import { place } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';
const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const r = place({ steps: mp0(), seed: 43391, range: 400, hub:{x:0,y:0}, site:{x:0,y:0},
  world: hubWorldState([0,0], null), connectHub: false });
function mp0(){ return mapOps(rebuildDag(sv.steps)).steps; }
// 用 grid 查 x=-219 那一列被占的格
const lines = r.grid.split('\n');
const maxY = Math.max(...r.placements.map(p=>p.cell[1]));
const minX = Math.min(...r.placements.map(p=>p.cell[0]));
const col = [];
for (let y = maxY; y >= maxY - lines.length + 1; y--) {
  const row = lines[maxY - y]; if (!row) continue;
  const ch = row[-219 - minX];
  if (ch && ch !== '.') col.push({ y, ch });
}
console.log('x=-219 列上的非空格:');
for (const c of col) console.log(`  y=${c.y} '${c.ch}'`);
