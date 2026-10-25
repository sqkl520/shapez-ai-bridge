// 关键问题：如果**保持矿机从左到右的顺序不变**，只让 x 自由（同一行），可行域还有多大？
// 顺序不变很重要 —— 换序会让通道交叉（陷阱 #1）。
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

// 布局给出的从左到右顺序
const CASES = {
  CpCpCpCp: ['blue', 'red', 'CuCuCuCu'],
  CgScScCg: ['green', 'blue', 'green', 'SuSuSuSu', 'CuCuCuCu'],  // x: -12,-8,-4,0,4
};
for (const [goal, seq] of Object.entries(CASES)) {
  const found = [];
  for (const [y, m] of rows) {
    // 贪心从左到右：每台取比前一台大的最小同色 x
    let prev = -Infinity, ok = true; const picked = [];
    for (const s of seq) {
      const arr = m.get(s) || [];
      const x = arr.find(v => v > prev);
      if (x === undefined) { ok = false; break; }
      picked.push(x); prev = x;
    }
    if (ok) found.push({ y, xs: picked, span: picked[picked.length-1] - picked[0] });
  }
  found.sort((a, b) => a.span - b.span || Math.abs(a.y) - Math.abs(b.y));
  console.log(`\n=== ${goal} 顺序保持 [${seq.join(' ')}] ===`);
  console.log(`  可行行 ${found.length}`);
  for (const f of found.slice(0, 6)) console.log(`   y=${f.y} span=${f.span} xs=[${f.xs}]`);
}
