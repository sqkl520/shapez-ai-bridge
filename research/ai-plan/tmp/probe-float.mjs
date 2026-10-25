// 若允许矿机 x 自由浮动（保序），CpCpCpCp / CgScScCg 是否有解？
// 判据：同一行、保序、相邻矿机之间的通道长度可接受（<=200）。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const SEED = 43391, R = 400;
const cells = resourcesInRegion(SEED, { x0: -R, y0: -R, x1: R, y1: R });
const rows = new Map();
for (const [x, y, s] of cells) {
  if (!rows.has(y)) rows.set(y, new Map());
  const m = rows.get(y);
  if (!m.has(s)) m.set(s, []);
  m.get(s).push(x);
}
for (const m of rows.values()) for (const a of m.values()) a.sort((p, q) => p - q);

const CASES = {
  CpCpCpCp: ['blue', 'red', 'CuCuCuCu'],
  CgScScCg: ['green', 'blue', 'green', 'SuSuSuSu', 'CuCuCuCu'],
};
for (const [goal, seq] of Object.entries(CASES)) {
  const out = [];
  for (const [y, m] of rows) {
    // 保序贪心：每台取比前一台大的最小同色 x（这是最紧的取法，跨度最小）
    let prev = -Infinity, ok = true; const picked = [];
    for (const s of seq) {
      const arr = m.get(s) || [];
      const x = arr.find(v => v > prev);
      if (x === undefined) { ok = false; break; }
      picked.push(x); prev = x;
    }
    if (!ok) continue;
    const span = picked[picked.length - 1] - picked[0];
    const gaps = picked.slice(1).map((v, i) => v - picked[i]);
    out.push({ y, span, maxGap: Math.max(...gaps), picked });
  }
  out.sort((a, b) => a.maxGap - b.maxGap || Math.abs(a.y + 2) - Math.abs(b.y + 2));
  console.log(`\n=== ${goal} 保序浮动 x ===`);
  console.log(`  可行行 ${out.length}`);
  for (const o of out.slice(0, 5)) console.log(`   y=${String(o.y).padStart(4)} span=${String(o.span).padStart(3)} maxGap=${String(o.maxGap).padStart(3)} xs=[${o.picked}]`);
}
