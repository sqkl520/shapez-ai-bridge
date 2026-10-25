// 确认：挡住的是「别的通道的带子」还是「机器」
import { place, planChannel } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';
import { rebuildDag as _r } from '../../../src/ai/compiler/compile.mjs';

const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
const r = place({ steps: mp.steps, seed: 43391, range: 400, hub:{x:0,y:0}, site:{x:0,y:0},
  world: hubWorldState([0,0], null), connectHub: false });

// grid 里的字符：带子是 ^ v < > 7 9 L J，机器是字母
const lines = r.grid.split('\n');
const ys = r.placements.map(p=>p.cell[1]);
const maxY = Math.max(...ys);
// bbox 原点
const minX = Math.min(...r.placements.map(p=>p.cell[0]));
const charAt = (x,y) => { const row = lines[maxY - y]; return row ? row[x - minX] : '?'; };

console.log('(-219,53..45) 在 grid 里的字符:');
for (let y = 53; y >= 45; y--) console.log(`  (${-219},${y}) = '${charAt(-219,y)}'`);

console.log('\n含义: ^v<> 是带子, 7/9/L/J 是拐角带, 字母是机器, . 是空');
