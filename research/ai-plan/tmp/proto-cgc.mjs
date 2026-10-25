// 原型：CgScScCg 的矿机分行布局，逐通道验证
import { planChannel } from '../../../src/ai/compiler/place.mjs';
import { ALL_TEMPLATES as T } from '../../../src/ai/op-templates.mjs';
const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
const slotAbs = (n, s) => [n.x + s.cell[0], n.y + s.cell[1]];
function chk(from, to, slotIdx, label) {
  const o = T[from.op].outputs[0], i = T[to.op].inputs[slotIdx];
  const fc = slotAbs(from, o), tc = slotAbs(to, i);
  const first = [fc[0]+DIRV[o.dir][0], fc[1]+DIRV[o.dir][1]];
  const last = [tc[0]+DIRV[i.dir][0], tc[1]+DIRV[i.dir][1]];
  const r = planChannel(first, o.dir, last, i.dir, {});
  console.log(`  ${label.padEnd(22)} ${JSON.stringify(first)}→${JSON.stringify(last)} : ${r.ok ? r.kind+'/'+r.cornerCount : 'FAIL'}`);
  return r.ok;
}
// 资源：blue(387,-192) green(387,-196) — 最近的一对
// 其余：找 Su 和 Cu 和另一个 green
const nodes = {
  blue:  { op:'mine', x:387, y:-192 },
  green1:{ op:'mine', x:387, y:-196 },
  mix:   { op:'mix',  x:387, y:-204 },
  su:    { op:'mine', x:300, y:-192 },
  cut1:  { op:'cut',  x:300, y:-200 },
  cu:    { op:'mine', x:450, y:-192 },
  cut2:  { op:'cut',  x:450, y:-200 },
  green2:{ op:'mine', x:450, y:-196 },
  paint1:{ op:'paint', x:302, y:-212 },
  paint2:{ op:'paint', x:452, y:-212 },
  stack: { op:'stack', x:400, y:-220 },
  rot:   { op:'rotate', x:400, y:-228 },
};
console.log('=== CgScScCg 分行原型 ===');
chk(nodes.blue, nodes.mix, 0, 'blue->mix.lower');
chk(nodes.green1, nodes.mix, 1, 'green1->mix.upper');
chk(nodes.su, nodes.cut1, 0, 'su->cut1');
chk(nodes.cut1, nodes.paint1, 0, 'cut1->paint1.shape');
chk(nodes.mix, nodes.paint1, 1, 'mix->paint1.color');
chk(nodes.cu, nodes.cut2, 0, 'cu->cut2');
chk(nodes.cut2, nodes.paint2, 0, 'cut2->paint2.shape');
chk(nodes.green2, nodes.paint2, 1, 'green2->paint2.color');
chk(nodes.paint1, nodes.stack, 0, 'paint1->stack.lower');
chk(nodes.paint2, nodes.stack, 1, 'paint2->stack.upper');
chk(nodes.stack, nodes.rot, 0, 'stack->rot');
