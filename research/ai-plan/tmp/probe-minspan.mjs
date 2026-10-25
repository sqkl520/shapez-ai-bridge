// 每行上「所需资源各取一格」的最小跨度（跨度决定通道长度，V4 上限 256）
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
const NEED = {
  CpCpCpCp: ['CuCuCuCu', 'blue', 'red'],
  CgScScCg: ['SuSuSuSu', 'blue', 'green', 'green', 'CuCuCuCu'],
};
for (const [goal, need] of Object.entries(NEED)) {
  const out = [];
  for (const [y, m] of rows) {
    const uniq = [...new Set(need)];
    if (!uniq.every(s => (m.get(s) || []).length >= need.filter(n => n === s).length)) continue;
    // 最小跨度：每个资源取最左的 n 个（同色取连续两个）
    const xs = [];
    for (const s of uniq) {
      const n = need.filter(z => z === s).length;
      const arr = m.get(s).slice().sort((a, b) => a - b);
      xs.push(...arr.slice(0, n));
    }
    out.push({ y, span: Math.max(...xs) - Math.min(...xs), xs: xs.sort((a,b)=>a-b), dist: Math.hypot(y + 2, (Math.min(...xs) + Math.max(...xs)) / 2 + 2) });
  }
  out.sort((a, b) => a.span - b.span || a.dist - b.dist);
  console.log(`\n=== ${goal} (需要 ${need.join(',')}) — 可行行 ${out.length} ===`);
  for (const o of out.slice(0, 6)) console.log(`  y=${o.y} span=${o.span} xs=[${o.xs}] dist=${o.dist.toFixed(0)}`);
}
