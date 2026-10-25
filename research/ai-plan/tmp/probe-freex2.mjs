import { resourcesInRegion } from '../../../src/ai/world.mjs';
const R = 400;
const rowsMap = new Map();
for (const [x, y, s] of resourcesInRegion(43391, { x0: -R, y0: -R, x1: R, y1: R })) {
  if (!rowsMap.has(y)) rowsMap.set(y, new Map());
  const m = rowsMap.get(y); if (!m.has(s)) m.set(s, []); m.get(s).push(x);
}
for (const m of rowsMap.values()) for (const a of m.values()) a.sort((p, q) => p - q);

const CASES = {
  CpCpCpCp: ['blue', 'red', 'CuCuCuCu'],
  CgScScCg: ['green', 'blue', 'green', 'SuSuSuSu', 'CuCuCuCu'],
};
for (const [goal, seq] of Object.entries(CASES)) {
  const out = [];
  for (const [y, m] of rowsMap) {
    // 对每个起始选择做贪心（取第一个能继续的），得到该行的最小跨度解之一
    // 更稳的做法：动态规划求最小跨度（每台取其所有候选 x）
    const lists = seq.map(s => m.get(s) || []);
    if (lists.some(l => l.length === 0)) continue;
    // 保序：第 i 台 > 第 i-1 台
    let best = null;
    const rec = (i, prev, picked) => {
      if (best && picked.length && picked[picked.length-1] - picked[0] >= best.span) return;
      if (i === lists.length) {
        const span = picked[picked.length-1] - picked[0];
        if (!best || span < best.span) best = { span, xs: picked.slice() };
        return;
      }
      for (const x of lists[i]) {
        if (x <= prev) continue;
        picked.push(x); rec(i + 1, x, picked); picked.pop();
        if (best && picked.length && picked[0] !== undefined) { /* prune */ }
      }
    };
    rec(0, -Infinity, []);
    if (best) out.push({ y, ...best });
  }
  out.sort((a, b) => (a.span <= 200 ? 0 : 1) - (b.span <= 200 ? 0 : 1) || (a.span<=200 ? a.span : 0) - (b.span<=200 ? b.span : 0) || Math.abs(a.y + 2) - Math.abs(b.y + 2));
  console.log(`\n=== ${goal} 保序最小跨度 ===`);
  console.log(`  可行行 ${out.length}`);
  for (const o of out.slice(0, 6)) console.log(`   y=${String(o.y).padStart(4)} span=${String(o.span).padStart(3)} xs=[${o.xs}]  dist=${Math.hypot(o.y+2, (o.xs[0]+o.xs[o.xs.length-1])/2+2).toFixed(0)}`);
}
