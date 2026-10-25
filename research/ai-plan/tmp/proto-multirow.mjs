// 原型：矿机各自落在资源上（不同 y），消费者放在上方，逐通道验证可布。
import { planChannel } from '../../../src/ai/compiler/place.mjs';
import { ALL_TEMPLATES } from '../../../src/ai/op-templates.mjs';

const OPP = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const slotCellOf = (n, s) => [n.x + s.cx, n.y + s.cy];

// 手工构造一个"矿机分行"的布局，看每个通道能否 planChannel
function tryLayout(name, spec) {
  // spec: nodes {id, op, x, y}; links {from, to, toSlot}
  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  for (const n of spec.nodes) n.outputs = (ALL_TEMPLATES[n.op].outputs||[]).map(s=>({dir:s.dir,cx:s.cell[0],cy:s.cell[1]}));
  console.log(`\n=== ${name} ===`);
  let allOk = true;
  for (const L of spec.links) {
    const f = byId.get(L.from), t = byId.get(L.to);
    const tpl = ALL_TEMPLATES[t.op];
    const inSlot = tpl.inputs[L.toSlot];
    const outTpl = ALL_TEMPLATES[f.op];
    const outSlot = outTpl.outputs[0];
    const fromCell = slotCellOf(f, outSlot);
    const toCell = slotCellOf(t, inSlot);
    const DIRV = { top:[0,-1], right:[1,0], bottom:[0,1], left:[-1,0] };
    const first = [fromCell[0]+DIRV[outSlot.dir][0], fromCell[1]+DIRV[outSlot.dir][1]];
    const last = [toCell[0]+DIRV[inSlot.dir][0], toCell[1]+DIRV[inSlot.dir][1]];
    const r = planChannel(first, outSlot.dir, last, inSlot.dir, {});
    console.log(`  ${L.from}→${L.to}[${L.toSlot}] first=${JSON.stringify(first)} d1=${outSlot.dir} last=${JSON.stringify(last)} in=${inSlot.dir} => ${r.ok ? r.kind : 'FAIL ' + r.why}`);
    if (!r.ok) allOk = false;
  }
  console.log(`  => ${allOk ? 'ALL ROUTABLE' : 'HAS FAILURES'}`);
}

// CpCpCpCp: blue(52,11) red(57,37) Cu(58,37) ; mix ; paint
// 把 mix / paint 放在矿机上方
tryLayout('CpCpCpCp 手工', {
  nodes: [
    { id: 'blue', op: 'mine', x: 52, y: 11 },
    { id: 'red', op: 'mine', x: 57, y: 37 },
    { id: 'Cu', op: 'mine', x: 58, y: 37 },
    { id: 'mix', op: 'mix', x: 57, y: 21 },
    { id: 'paint', op: 'paint', x: 60, y: 2 },
  ],
  links: [
    { from: 'blue', to: 'mix', toSlot: 0 },
    { from: 'red', to: 'mix', toSlot: 1 },
    { from: 'Cu', to: 'paint', toSlot: 0 },
    { from: 'mix', to: 'paint', toSlot: 1 },
  ],
});
