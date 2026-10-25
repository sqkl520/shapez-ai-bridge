import { planChannel } from '../../../src/ai/compiler/place.mjs';
import { ALL_TEMPLATES as T } from '../../../src/ai/op-templates.mjs';
const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const slotAbs = (n, s) => [n.x + s.cell[0], n.y + s.cell[1]];
function check(from, to, idx, label) {
  const o = T[from.op].outputs[0], i = T[to.op].inputs[idx];
  const fc = slotAbs(from, o), tc = slotAbs(to, i);
  const first = [fc[0]+DIRV[o.dir][0], fc[1]+DIRV[o.dir][1]];
  const last = [tc[0]+DIRV[i.dir][0], tc[1]+DIRV[i.dir][1]];
  const r = planChannel(first, o.dir, last, i.dir, {});
  console.log(`  ${label.padEnd(20)} ${JSON.stringify(first)}→${JSON.stringify(last)} : ${r.ok ? r.kind+'/'+r.cornerCount : 'FAIL '+r.why}`);
  return r.ok;
}
// y=22 行：blue@-155 red@-61 Cu@-31（保序 blue < red < Cu）
const blue = { op:'mine', x:-155, y:22 };
const red  = { op:'mine', x:-61,  y:22 };
const Cu   = { op:'mine', x:-31,  y:22 };
// mix 放在 blue 正上方（mix 两个 bottom 输入在 x 和 x+1）
const mix  = { op:'mix', x:-155, y:14 };
console.log('=== CpCpCpCp: mix@blue, 检查四条 ===');
check(blue, mix, 0, 'blue->mix.lower');
check(red,  mix, 1, 'red->mix.upper');
// paint: shape←left (cell 0), color←top (cell 1)
const paint = { op:'paint', x:-153, y:6 };
check(Cu,    paint, 0, 'Cu->paint.shape');
check(mix,   paint, 1, 'mix->paint.color');
