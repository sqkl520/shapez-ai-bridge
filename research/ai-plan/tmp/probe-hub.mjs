// 忽略资源后，卡在「hub 16 入口都接不上」。为什么？
// 复刻 place() 的 hub 连接段，看每个入口失败的原因。
import { place } from '../../../src/ai/compiler/place.mjs';
import { compilePlan, rebuildDag, mapOps, solveGoal, inspectGoal } from '../../../src/ai/compiler/compile.mjs';
const g = inspectGoal('CpCpCpCp');
const sv = solveGoal(g.goal, { level: g.level });
const mp = mapOps(rebuildDag(sv.steps));
// connectHub:false → 看布局本身
const withHub = place({ steps: mp.steps, site: {x:0,y:0}, hub: {x:0,y:0},
  world: null, connectHub: true, rowGap: 8, colGap: 3 });
console.log('with hub ok=', withHub.ok, withHub.reason || '');
const noHub = place({ steps: mp.steps, site: {x:0,y:0}, hub: {x:0,y:0},
  world: null, connectHub: false, rowGap: 8, colGap: 3 });
console.log('no hub  ok=', noHub.ok, noHub.reason || '', noHub.ok ? 'belts='+noHub.meta.beltTiles+' corners='+noHub.cornerCount : '');
if (noHub.ok !== false) { console.log(noHub.grid); }
