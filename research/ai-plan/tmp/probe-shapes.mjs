// 逐通道列出 (first, d1, last, d2)，并判定 planChannel 能否铺。
import { place } from '../../../src/ai/compiler/place.mjs';
import { planChannel } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal, hubWorldState } from '../../../src/ai/compiler/compile.mjs';
for (const goal of ['CpCpCpCp', 'CgScScCg']) {
  const g = inspectGoal(goal);
  const sv = solveGoal(g.goal, { level: g.level });
  const mp = mapOps(rebuildDag(sv.steps));
  const noHub = place({ steps: mp.steps, site: {x:0,y:0}, hub: {x:0,y:0}, world: hubWorldState([0,0], null), connectHub: false, rowGap: 8, colGap: 3 });
  console.log(`\n=== ${goal} (no hub) ok=${noHub.ok} ===`);
  if (noHub.ok === false) { console.log('  ', noHub.reason); continue; }
  console.log('  placements', JSON.stringify(noHub.placements.map(x=>[x.nodeId,x.op,x.cell])));
  // 每个通道：from/to + 实际 first/last
  for (const c of noHub.channels) {
    const f = c.from.cell, t = c.to.cell;
    const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
    const OPP = { top:'bottom', bottom:'top', left:'right', right:'left' };
    const first = [f[0]+DIRV[c.from.outDir][0], f[1]+DIRV[c.from.outDir][1]];
    const last = [t[0]+DIRV[c.to.inDir][0], t[1]+DIRV[c.to.inDir][1]];
    const r = planChannel(first, c.from.outDir, last, c.to.inDir, {});
    console.log(`  ${c.from.nodeId}→${c.to.nodeId} first=${JSON.stringify(first)} d1=${c.from.outDir} last=${JSON.stringify(last)} d2=${OPP[c.to.inDir]}  => ${r.ok ? r.kind+'/'+r.cornerCount+'拐' : 'FAIL '+r.why}`);
  }
}
