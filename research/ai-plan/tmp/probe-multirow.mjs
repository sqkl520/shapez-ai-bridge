// 自由度三：矿机允许落在**不同行**（每台各自一行，但仍按从左到右的顺序）。
// 这样通道长度只取决于同一行的跨度，而不是全局跨度。
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
const CASES = {
  CpCpCpCp: ['blue','red','CuCuCuCu'],
  CgScScCg: ['green','blue','green','SuSuSuSu','CuCuCuCu'],
};
// 同一行内左右相邻的矿机对，最多允许相距 MAXDX；不同行的矿机不受限。
const MAXDX = 40;
for (const [goal, seq] of Object.entries(CASES)) {
  const cands = new Map();   // y -> shape -> sorted xs
  for (const [y, m] of rows) {
    const ok = {};
    for (const s of new Set(seq)) {
      const n = seq.filter(z => z === s).length;
      const arr = (m.get(s) || []).slice().sort((a,b)=>a-b);
      if (arr.length >= n) ok[s] = arr;
    }
    if (Object.keys(ok).length === new Set(seq).size) cands.set(y, ok);
  }
  // 贪心：每台矿机选一个候选 (y,x)，满足顺序且同行的相邻对 dx<=MAXDX
  let best = null;
  const ys = [...cands.keys()];
  // 只试离 hub 近的行（|y| 小的前 40 行）
  ys.sort((a,b) => Math.abs(a+2) - Math.abs(b+2));
  const trialRows = ys.slice(0, 40);
  for (const y0 of trialRows) {
    for (const dir of [1, -1]) {
      let prevX = -Infinity, ok = true; const picked = [];
      let curY = y0;
      for (const s of seq) {
        let found = null;
        for (let k = 0; k < 4 && !found; k++) {
          const y = y0 + dir * k;
          const m = cands.get(y); if (!m) continue;
          const x = (m[s] || []).find(v => v > prevX);
          if (x !== undefined) { found = { y, x }; }
        }
        if (!found) { ok = false; break; }
        // 同行相邻约束
        if (picked.length && found.y === picked[picked.length-1].y && found.x - picked[picked.length-1].x > MAXDX) { ok = false; break; }
        picked.push(found); prevX = found.x;
      }
      if (ok) {
        const span = Math.max(...picked.map(p => p.x)) - Math.min(...picked.map(p => p.x));
        if (!best || span < best.span) best = { span, picked: picked.map(p => `${p.x}@${p.y}`) };
      }
    }
  }
  console.log(`\n=== ${goal} 多行 (MAXDX=${MAXDX}) ===`);
  console.log(best ? `  span=${best.span} ${best.picked.join(' ')}` : '  无解');
}
