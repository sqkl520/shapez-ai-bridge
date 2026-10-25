// 逐格查：两条失败通道的「理想路径」上都被什么挡住，连续几格
import { place, planChannel } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';

const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
const r = place({ steps: mp.steps, seed: 43391, range: 400, hub:{x:0,y:0}, site:{x:0,y:0},
  world: hubWorldState([0,0], null), connectHub: false });

// 机器占地
const occ = new Map();
for (const p of r.placements) {
  const [w,h] = p.footprint || [1,1];
  for (let dy=0; dy<h; dy++) for (let dx=0; dx<w; dx++) occ.set((p.cell[0]+dx)+','+(p.cell[1]+dy), p.nodeId);
}
// 已铺带子
const belts = new Set();
for (const c of r.channels) { /* channels 只有端点 */ }
// 从 grid 反推带子（用回放）
const gridLines = r.grid.split('\n');
const yTop = Math.max(...r.placements.map(p=>p.cell[1]), ...r.beltCells?.map?.(b=>b.cell[1]) ?? []);
void yTop;

const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const OPP = { top:'bottom', bottom:'top', left:'right', right:'left' };

// 失败的通道 1: -b------ → -c------（mix slot0）
// 失败点 [-219,48]
console.log('=== 通道 -b------ → -c------ ===');
const m1 = r.placements.find(p=>p.nodeId==='-b------');
const mix = r.placements.find(p=>p.nodeId==='-c------');
console.log('  mine', m1.cell, '→ mix', mix.cell);
console.log('  first =', [m1.cell[0], m1.cell[1]-1], ' last =', [mix.cell[0], mix.cell[1]-1]);

// 逐行扫描：从 first 到 last 的竖直段上有什么
for (let y = m1.cell[1]-1; y >= mix.cell[1]-1; y--) {
  const k = m1.cell[0]+','+y;
  const owner = occ.get(k);
  console.log(`   (${m1.cell[0]},${y})`, owner ? '机器:'+owner : '空');
}

console.log('\n=== 通道 ---g---- → n9 ===');
const g2 = r.placements.find(p=>p.nodeId==='---g----');
const n9 = r.placements.find(p=>p.nodeId==='n9');
console.log('  mine', g2.cell, '→ paint', n9.cell);
// n9 的 color 槽在 [1,0] 朝 top ⇒ last = (n9.x+1, n9.y-1)
const lastX = n9.cell[0]+1, lastY = n9.cell[1]-1;
console.log('  first =', [g2.cell[0], g2.cell[1]-1], ' last =', [lastX, lastY]);
// 这条要横跨 226 格，检查每一列在该 y 上是否被占
let blocked = [];
for (let x = g2.cell[0]; x <= lastX; x++) {
  const owner = occ.get(x+','+lastY);
  if (owner) blocked.push({x, owner});
}
console.log('  车道行 y='+lastY+' 上被机器占的格:', blocked.length ? JSON.stringify(blocked) : '无');
