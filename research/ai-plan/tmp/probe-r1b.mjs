// R1 门（完整版）：真实 DAG + 真实占用，跑完 11 条通道。
import { buildDag, layerAndOrder, planChannel } from '../../../src/ai/compiler/place.mjs';
import { rebuildDag, mapOps, solveGoal, inspectGoal } from '../../../src/ai/compiler/compile.mjs';
import { ALL_TEMPLATES as T } from '../../../src/ai/op-templates.mjs';
import { resourcesInRegion, tileResource } from '../../../src/ai/world.mjs';

const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const OPP = { top:'bottom', bottom:'top', left:'right', right:'left' };
const SEED = 43391;

const g = inspectGoal('CgScScCg');
const sv = solveGoal(g.goal, { level: g.level });
const dag = buildDag(mapOps(rebuildDag(sv.steps)).steps, {});
const byId = new Map(dag.nodes.map(n => [n.id, n]));

// ---- 资源行 ----
const rowsMap = new Map();
for (const [x, y, s] of resourcesInRegion(SEED, { x0:-400,y0:-400,x1:400,y1:400 })) {
  if (!rowsMap.has(y)) rowsMap.set(y, new Map());
  const m = rowsMap.get(y); if (!m.has(s)) m.set(s, []);
  m.get(s).push(x);
}
for (const m of rowsMap.values()) for (const a of m.values()) a.sort((p,q)=>p-q);
const Y = 54, M = rowsMap.get(Y);
const gx = (M.get('green')||[]).slice(0,2), bx = M.get('blue')[0], sux = M.get('SuSuSuSu')[0], cux = M.get('CuCuCuCu')[0];
console.log(`资源行 y=${Y}: green=[${gx}] blue=${bx} Su=${sux} Cu=${cux}`);

// ---- 摆位 ----
// 矿机：green1(x=gx[0]) blue(x=bx) green2(x=gx[1]) Su(x=sux) Cu(x=cux)
const X = {
  '---g----': gx[0], '-b------': bx, '-g------': gx[1],
  'n0': sux, 'n6': cux,
};
// mix：slot0 父必须西于 slot1 父。选 slot0=green(gx[0]), slot1=blue(bx) ⇒ mix.x >= bx
const mixX = Math.max(gx[0], bx);       // 满足 slot0(<= mix.x) 与 slot1(<= mix.x+1)
const mixY = Y - 8;
X['-c------'] = mixX;

// cut 在各自矿机上方。Su→cut1, Cu→cut2
const cut1X = sux, cut2X = cux;
X['n1'] = cut1X; X['n7'] = cut2X;

// painter：shape←left 要求 cropX <= paint.x-1（cutter 2 宽，出料在 [0,0]）
const p1X = cut1X + 2, p2X = cut2X + 2;
// WP2：喂 slot0 的 painter 必须比喂 slot1 的高（y 小）
const paintRow0 = Y - 16, paintRow1 = Y - 24;
X['n5'] = p1X;  // → stacker slot0
X['n9'] = p2X;  // → stacker slot1

// stacker：slot0 在 st.x, slot1 在 st.x+1；两 painter 都向右出料
// ⇒ st.x 必须 > 两个 painter 的出料列，且 slot1 的父列 <= st.x+1
const stX = Math.max(p1X + 2, p2X + 2) + 1;
const stY = Y - 32;
X['n10'] = stX;
X['n11'] = stX; // rotate 在 stacker 上方
const YS = { 'n5': paintRow0, 'n9': paintRow1, 'n10': stY, 'n11': stY - 8, 'n1': Y-8, 'n7': Y-8, '-c------': mixY };
const pos = {};
for (const n of dag.nodes) pos[n.id] = { x: X[n.id], y: YS[n.id] !== undefined ? YS[n.id] : Y };

console.log('\n摆位:');
for (const n of dag.nodes) console.log(`  ${n.id.padEnd(10)} ${n.op.padEnd(7)} (${pos[n.id].x}, ${pos[n.id].y})`);

// ---- 占用（真实 footprint）----
const occ = new Set();
for (const n of dag.nodes) {
  const fp = n.template.footprint;
  for (let dy=0;dy<fp[1];dy++) for (let dx=0;dx<fp[0];dx++) occ.add((pos[n.id].x+dx)+','+(pos[n.id].y+dy));
}

// ---- 跑通道：mix.parents 换序（WP1）----
const mix = byId.get('-c------');
console.log('\nmix.parents 原序:', mix.parents.map(p=>p.id).join(' '), '资源:', mix.parents.map(p=>p.resource).join(','));
// slot0 父必须西于 slot1 父
if (pos[mix.parents[0].id].x > pos[mix.parents[1].id].x) {
  console.log('  → 倒序，交换 slot0/slot1（mix 可交换，语义安全）');
  mix.parents = [mix.parents[1], mix.parents[0]];
  // 同步 template.inputs（role 相同，只是顺序）
}

// ---- 逐通道 planChannel ----
let ok = 0, fail = 0;
const lanePool = new Set();
const check = (fromId, toId, slotIdx, label) => {
  const f = byId.get(fromId), t = byId.get(toId);
  const o = f.template.outputs[0];
  const i = t.template.inputs[slotIdx];
  const fc = [pos[f.id].x + o.cell[0], pos[f.id].y + o.cell[1]];
  const tc = [pos[t.id].x + i.cell[0], pos[t.id].y + i.cell[1]];
  const first = [fc[0]+DIRV[o.dir][0], fc[1]+DIRV[o.dir][1]];
  const last  = [tc[0]+DIRV[i.dir][0], tc[1]+DIRV[i.dir][1]];
  const r = planChannel(first, o.dir, last, i.dir, { occupied: occ, lanePool });
  const mark = r.ok ? 'ok ' : 'FAIL';
  console.log(`  ${mark} ${label.padEnd(22)} ${JSON.stringify(first)}→${JSON.stringify(last)} d1=${o.dir} d2=${OPP[i.dir]} ${r.ok ? r.kind+'/'+r.cornerCount : r.why}`);
  if (r.ok) { ok++; if (r.lane !== null) lanePool.add((o.dir==='top'||o.dir==='bottom'?'row:':'col:')+r.lane); }
  else fail++;
  return r.ok;
};
console.log('\n通道:');
check('-b------','-c------', 0, 'blue->mix[0]');
check('-g------','-c------', 1, 'green->mix[1]');
check('n0','n1', 0, 'Su->cut1');
check('n1','n5', 0, 'cut1->paint1.shape');
check('-c------','n5', 1, 'mix->paint1.color');
check('n6','n7', 0, 'Cu->cut2');
check('n7','n9', 0, 'cut2->paint2.shape');
check('---g----','n9', 1, 'green2->paint2.color');
check('n5','n10', 0, 'paint1->stack[0]');
check('n9','n10', 1, 'paint2->stack[1]');
check('n10','n11', 0, 'stack->rot');
console.log(`\n=> ${ok} ok / ${fail} fail  (需 11/11)`);
