// R1 门：把 WP1（mix 槽序）+ WP2（stacker 父分行）应用到真实 DAG，用真实占用跑完所有通道。
// 到不了 11/11 就说明方案不完整，必须先补 WP0。
import { buildDag, layerAndOrder, planChannel, inSlotsOf, outSlotsOf } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal } from '../../../src/ai/compiler/compile.mjs';
import { ALL_TEMPLATES as T } from '../../../src/ai/op-templates.mjs';
import { resourcesInRegion } from '../../../src/ai/world.mjs';

const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const cellAbs = (n, s) => [n.x + s.cx, n.y + s.cy];

// 1) 取真实 DAG
const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
const dag = buildDag(mp.steps, {});
const levels = layerAndOrder(dag.nodes);
const byId = new Map(dag.nodes.map(n => [n.id, n]));

// 2) 矿机 x 由资源决定（复用已实现的 planMinerColumns 思路，但这里手工取一行做对照）
const SEED = 43391;
const rowsMap = new Map();
for (const [x, y, s] of resourcesInRegion(SEED, { x0:-400, y0:-400, x1:400, y1:400 })) {
  if (!rowsMap.has(y)) rowsMap.set(y, new Map());
  const m = rowsMap.get(y); if (!m.has(s)) m.set(s, []);
  m.get(s).push(x);
}
for (const m of rowsMap.values()) for (const a of m.values()) a.sort((p,q)=>p-q);

// 布局的矿机顺序（layerAndOrder 给出）
const miners = levels[0].filter(n => n.op === 'mine');
console.log('矿机顺序:', miners.map(m => m.id + '(' + (m.resource||m.hash) + ')').join(' '));

// 用两行 y=53/54 里跨度最小的
let bestRow = null;
for (const [y, m] of rowsMap) {
  const need = ['SuSuSuSu','blue','green','green','CuCuCuCu'];
  if(!need.every(s => (m.get(s)||[]).length >= need.filter(z=>z===s).length)) continue;
  const span = Math.max(...need.map(s=>m.get(s)[0])) - Math.min(...need.map(s=>m.get(s)[0]));
  if (!bestRow || span < bestRow.span) bestRow = { y, m, span };
}
console.log('选用行 y=' + bestRow.y + ' span=' + bestRow.span);

// 3) WP1：mix 的槽序必须西→东
const mix = dag.nodes.find(n => n.op === 'mix');
console.log('\n--- WP1: mix 槽序 ---');
console.log('mix.parents 原序:', mix.parents.map(p=>p.id).join(' '));

// 4) 摆放：按 slot 顺序给 mix 的父分配列
// mix slot0 在 mix.x, slot1 在 mix.x+1 ⇒ 父 x 必须 <= 各自列
// 选 mix 放在最西的父上方
const Y_MINER = bestRow.y;
const Y_MIX = Y_MINER - 8;

// 给每台矿机一个真实资源的坐标
function pick(shape, preferX) {
  const xs = bestRow.m.get(shape) || [];
  return preferX === undefined ? xs[0] : xs.reduce((b,x)=> Math.abs(x-preferX)<Math.abs(b-preferX)?x:b, xs[0]);
}
const blueX = pick('blue'), greenXs = (bestRow.m.get('green')||[]).slice(0,2);
const suX = pick('SuSuSuSu'), cuX = pick('CuCuCuCu');

// 让 mix 的 slot0 父（假设是 blue）在 slot1 父（green）西侧
// 若 blue 在东，则交换 mix.parents（语义安全）
let p0 = byId.get(mix.parents[0].id), p1 = byId.get(mix.parents[1].id);
const blueNode = mix.parents.find(p => p.resource === 'blue');
const greenNode0 = mix.parents.find(p => p.resource === 'green');
console.log('mix 父的资源:', mix.parents.map(p=>p.id+')').join(''), mix.parents.map(p=>p.resource).join(', '));

// 按实际 x 决定谁是 slot0
const pairs = [
  { slot0: blueX, slot1: greenXs[0], s0res:'blue', s1res:'green' },
  { slot0: greenXs[0], slot1: blueX, s0res:'green', s1res:'blue' },
];
const chosen = pairs.find(p => p.slot0 < p.slot1) || pairs.sort((a,b)=>(a.slot1-a.slot0)-(b.slot1-b.slot0))[0];
console.log('选定 slot0=' + chosen.s0res + '@' + chosen.slot0 + '  slot1=' + chosen.s1res + '@' + chosen.slot1);
