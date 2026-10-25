// 关键：如果允许矿机 **x 自由（保序）+ 各自 y 也自由**，两个目标有解吗？
// 这是真正需要的自由度：通道只要不穿过机器就行。
// 先不求解，先量：每行有哪些资源，能否构成一条"保序"链。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const R = 400;
const cells = resourcesInRegion(43391, { x0: -R, y0: -R, x1: R, y1: R });
const byShape = new Map();
for (const [x, y, s] of cells) {
  if (!byShape.has(s)) byShape.set(s, []);
  byShape.get(s).push([x, y]);
}
for (const [s, a] of byShape) a.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

// 两个目标：按布局顺序
const NEED = {
  CpCpCpCp: ['blue', 'red', 'CuCuCuCu'],
  CgScScCg: ['green', 'blue', 'green', 'SuSuSuSu', 'CuCuCuCu'],
};
// 贪心：从 hub 附近出发，每台取最近的、x 大于前一台的同类资源
for (const [goal, seq] of Object.entries(NEED)) {
  let cur = { x: -Infinity, y: -2 };
  const picked = [];
  let ok = true;
  for (const s of seq) {
    const cands = (byShape.get(s) || []).filter(([x]) => x > cur.x);
    if (!cands.length) { ok = false; break; }
    cands.sort((a, b) => Math.hypot(a[0] - cur.x, a[1] - cur.y) - Math.hypot(b[0] - cur.x, b[1] - cur.y));
    picked.push({ s, x: cands[0][0], y: cands[0][1] });
    cur = { x: cands[0][0], y: cands[0][1] };
  }
  console.log(`\n${goal} 保序贪心:`, ok ? picked.map(p => `${p.s}@${p.x},${p.y}`).join('  ') : 'FAILED at ' + seq[picked.length]);
}
