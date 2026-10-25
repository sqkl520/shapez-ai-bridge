import { planChannel } from '../../../src/ai/compiler/place.mjs';
import { ALL_TEMPLATES } from '../../../src/ai/op-templates.mjs';
const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const T = ALL_TEMPLATES;
function slotAbs(n, s) { return [n.x + s.cell[0], n.y + s.cell[1]]; }
function check(from, to, toSlotIdx, label) {
  const fT = T[from.op], tT = T[to.op];
  const o = fT.outputs[0];
  const i = tT.inputs[toSlotIdx];
  const fc = slotAbs(from, o), tc = slotAbs(to, i);
  const first = [fc[0] + DIRV[o.dir][0], fc[1] + DIRV[o.dir][1]];
  const last = [tc[0] + DIRV[i.dir][0], tc[1] + DIRV[i.dir][1]];
  const r = planChannel(first, o.dir, last, i.dir, {});
  console.log(`  ${label}: first=${JSON.stringify(first)} d1=${o.dir} last=${JSON.stringify(last)} in=${i.dir} => ${r.ok ? r.kind + '/' + r.cornerCount : 'FAIL ' + r.why}`);
  return r.ok;
}
const blue = { op: 'mine', x: 52, y: 11 };
const red = { op: 'mine', x: 57, y: 37 };
const Cu = { op: 'mine', x: 58, y: 37 };
const mix = { op: 'mix', x: 52, y: 21 };
const paint = { op: 'paint', x: 54, y: 4 };
console.log('=== CpCpCpCp 手工分行 ===');
check(blue, mix, 0, 'blue->mix.lower');
check(red, mix, 1, 'red->mix.upper');
check(Cu, paint, 0, 'Cu->paint.shape');
check(mix, paint, 1, 'mix->paint.color');
