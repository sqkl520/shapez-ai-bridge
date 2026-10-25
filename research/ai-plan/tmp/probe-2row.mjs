// 关键实验：矿机分两行（矿机层本身占多行），保序。
// 因为应变只受「同一行相邻矿机的通道跨度」影响，不同行之间的通道可以走 Z 形。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const R = 400;
const rowsMap = new Map();
for (const [x, y, s] of resourcesInRegion(43391, { x0: -R, y0: -R, x1: R, y1: R })) {
  if (!rowsMap.has(y)) rowsMap.set(y, new Map());
  const m = rowsMap.get(y); if (!m.has(s)) m.set(s, []); m.get(s).push(x);
}
for (const m of rowsMap.values()) for (const a of m.values()) a.sort((p, q) => p - q);

const CASES = { CpCpCpCp: ['blue','red','CuCuCuCu'], CgScScCg: ['green','blue','green','SuSuSuSu','CuCuCuCu'] };
// 用「所有矿机都在同一行，但 x 完全自由（保序）」，允许跨度大；量最大相邻间距
for (const [goal, seq] of Object.entries(CASES)) {
  let best = null;
  for (const [y, m] of rowsMap) {
    const lists = seq.map(s => m.get(s) || []);
    if (lists.some(l => l.length === 0)) continue;
    // 贪心：每台取 >= 前一台的最小值
    let prev = -Infinity, ok = true; const xs = [];
    for (const l of lists) { const x = l.find(v => v > prev); if (x === undefined) { ok = false; break; } xs.push(x); prev = x; }
    if (!ok) continue;
    const maxGap = Math.max(...xs.slice(1).map((v, i) => v - xs[i]));
    if (!best || maxGap < best.maxGap) best = { y, xs, maxGap, span: xs[xs.length-1]-xs[0] };
  }
  console.log(`${goal}: ${best ? `best row y=${best.y} xs=[${best.xs}] maxGap=${best.maxGap} span=${best.span}` : 'none'}`);
}
