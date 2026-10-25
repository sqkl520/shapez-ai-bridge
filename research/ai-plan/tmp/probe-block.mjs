// 量清 CgScScCg 两条失败通道被挡住的宽度：是几格，还是一整列？
import { place } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';

const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
const r = place({ steps: mp.steps, seed: 43391, range: 400, hub: {x:0,y:0}, site: {x:0,y:0},
  world: hubWorldState([0,0], null), connectHub: false });
if (r.ok === false) { console.log('place 失败:', r.reason); process.exit(0); }

console.log('冲突:');
for (const c of r.conflicts) console.log(' ', c.kind, c.nodeIds.join('->'), JSON.stringify(c.cells));

// 重建 occupied：机器占地
const occ = new Map();
for (const p of r.placements) {
  const [w,h] = p.footprint || [1,1];
  for (let dy=0; dy<h; dy++) for (let dx=0; dx<w; dx++) occ.set((p.cell[0]+dx)+','+(p.cell[1]+dy), p.nodeId);
}
console.log('\nplacements:');
for (const p of r.placements) console.log(`  ${p.nodeId.padEnd(10)} ${p.op.padEnd(7)} (${p.cell[0]},${p.cell[1]})`);
console.log('\n各占用列（x → 被谁占）:');
const byCol = new Map();
for (const [k, id] of occ) { const [x,y] = k.split(',').map(Number); if (!byCol.has(x)) byCol.set(x,[]); byCol.get(x).push(y); }
const cols = [...byCol.keys()].sort((a,b)=>a-b);
console.log('  占用列范围:', cols[0], '..', cols[cols.length-1], '共', cols.length, '列');
