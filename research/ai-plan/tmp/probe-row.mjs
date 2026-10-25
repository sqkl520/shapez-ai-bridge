// 更弱的约束：所有矿机在**同一行**，但 x 任意（通道退化成 hlane，2 拐角）。
// 看这两个目标在 ±400 内有没有这样的行。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const SEED = 43391, R = 400;
const cells = resourcesInRegion(SEED, { x0: -R, y0: -R, x1: R, y1: R });
const rows = new Map();   // y -> Map(shape -> [x...])
for (const [x, y, s] of cells) {
  if (!rows.has(y)) rows.set(y, new Map());
  const m = rows.get(y);
  if (!m.has(s)) m.set(s, []);
  m.get(s).push(x);
}
const NEED = {
  CpCpCpCp: { blue: 1, red: 1, CuCuCuCu: 1 },
  CgScScCg: { SuSuSuSu: 1, blue: 1, green: 2, CuCuCuCu: 1 },
};
for (const [goal, need] of Object.entries(NEED)) {
  let hits = [];
  for (const [y, m] of rows) {
    let ok = true;
    const picked = {};
    for (const [shape, n] of Object.entries(need)) {
      const xs = m.get(shape) || [];
      if (xs.length < n) { ok = false; break; }
      picked[shape] = xs.slice(0, n);
    }
    if (ok) hits.push({ y, picked });
  }
  hits.sort((a, b) => Math.abs(a.y) - Math.abs(b.y));
  console.log(`\n=== ${goal}: 需要 ${JSON.stringify(need)} ===`);
  console.log(`  同一行可行: ${hits.length} 行`);
  for (const h of hits.slice(0, 5)) console.log(`   y=${h.y}`, JSON.stringify(h.picked));
}
