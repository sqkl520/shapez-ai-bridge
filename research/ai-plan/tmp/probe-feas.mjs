// 目标：量清楚「要多少自由度」才能让 CpCpCpCp / CgScScCg 的矿机联合命中。
// 自由度候选：(1) 同一行的排列顺序；(2) 每台矿机的纵向错位；(3) 列间距。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const SEED = 43391, R = 400;
const cells = resourcesInRegion(SEED, { x0: -R, y0: -R, x1: R, y1: R });
const byKey = new Map();
for (const [x, y, s] of cells) byKey.set(`${x},${y}`, s);
const at = (x, y) => byKey.get(`${x},${y}`) ?? null;

// 目标资源序列（按布局的 x 槽从左到右）
const CASES = [
  { goal: 'CpCpCpCp', slots: [{dx:-8,res:'blue'},{dx:-4,res:'red'},{dx:0,res:'CuCuCuCu'}] },
  { goal: 'CgScScCg', slots: [{dx:-12,res:'green'},{dx:-8,res:'blue'},{dx:-4,res:'green'},{dx:0,res:'SuSuSuSu'},{dx:4,res:'CuCuCuCu'}] },
];

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((v, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([v, ...rest]);
  });
  return out;
}

for (const { goal, slots } of CASES) {
  const resList = slots.map(s => s.res);
  const perms = permutations(resList);
  console.log(`\n=== ${goal}: ${resList.length} 台矿机，${perms.length} 种排列 ===`);

  // (1) 同排 + 原间距：任一排列命中？
  for (const p of perms) {
    let hits = 0;
    for (const [x, y] of byKey.keys ? [] : []) {} // noop
    // 用锚点扫描：以第一台的资源格为锚
    const anchors = cells.filter(([, , s]) => s === p[0]);
    for (const [ax, ay] of anchors) {
      let ok = true;
      for (let i = 1; i < p.length; i++) {
        const cx = ax + (slots[i].dx - slots[0].dx), cy = ay;
        if (at(cx, cy) !== p[i]) { ok = false; break; }
      }
      if (ok) hits++;
    }
    if (hits) console.log(`  同排 pitch4 排列 [${p.join(',')}] → ${hits} 处`);
  }

  // (2) 同排，间距可调（pitch = p，从 1 到 32）
  for (let pitch = 1; pitch <= 32; pitch++) {
    const offs = slots.map((_, i) => (i - Math.floor((slots.length - 1) / 2)) * pitch);
    for (const p of perms) {
      const anchors = cells.filter(([, , s]) => s === p[0]);
      let hits = 0;
      for (const [ax, ay] of anchors) {
        let ok = true;
        for (let i = 1; i < p.length; i++) {
          if (at(ax + offs[i] - offs[0], ay) !== p[i]) { ok = false; break; }
        }
        if (ok) hits++;
      }
      if (hits) console.log(`  同排 pitch${pitch} 排列 [${p.join(',')}] → ${hits} 处`);
    }
  }
}
