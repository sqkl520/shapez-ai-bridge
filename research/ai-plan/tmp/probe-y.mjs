// 约束：矿机必须在消费者下方（y 更大），因为带子只能向上走（d1=top）。
// 重查：CpCpCpCp 需要 blue/red 在 mix 下方，Cu 在 paint 下方。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const R = 400;
const cells = resourcesInRegion(43391, { x0: -R, y0: -R, x1: R, y1: R });
const by = new Map();
for (const [x, y, s] of cells) { if (!by.has(s)) by.set(s, []); by.get(s).push([x, y]); }
// 找一条链：blue/red 同排或近排，Cu 在附近，都能放在 mix/paint 下方
// 简化：找 y 较大的区域（矿机区），看那里各资源是否齐
const rows = new Map();
for (const [x, y, s] of cells) { if (!rows.has(y)) rows.set(y, new Map()); const m = rows.get(y); if (!m.has(s)) m.set(s, []); m.get(s).push(x); }
let best = null;
for (const [y, m] of rows) {
  const has = ['blue', 'red', 'CuCuCuCu'].every(s => (m.get(s) || []).length);
  if (!has) continue;
  const xs = ['blue', 'red', 'CuCuCuCu'].map(s => (m.get(s) || []).sort((a,b)=>a-b)[0]);
  const span = Math.max(...xs) - Math.min(...xs);
  if (!best || span < best.span) best = { y, xs, span };
}
console.log('CpCpCpCp 同一行三种资源最近的:', JSON.stringify(best));
