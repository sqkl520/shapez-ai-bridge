// CgScScCg 的 5 台矿机顺序：布局把两台 green 放在 -4 和 -12（Cu 在 +4 最右）。
// 问题：顺序能不能换？换序的代价是什么？先看每一组顺序在同一行是否可行。
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
const perms = (a) => a.length <= 1 ? [a] : a.flatMap((v, i) => perms([...a.slice(0, i), ...a.slice(i+1)]).map(r => [v, ...r]));
const base = ['SuSuSuSu', 'blue', 'green', 'green', 'CuCuCuCu'];
const seen = new Set();
const results = [];
for (const seq of perms(base)) {
  const k = seq.join('|'); if (seen.has(k)) continue; seen.add(k);
  let best = null;
  for (const [y, m] of rows) {
    let prev = -Infinity, ok = true; const picked = [];
    for (const s of seq) {
      const arr = m.get(s) || [];
      const x = arr.find(v => v > prev);
      if (x === undefined) { ok = false; break; }
      picked.push(x); prev = x;
    }
    if (ok) {
      const span = picked[picked.length-1] - picked[0];
      if (!best || span < best.span || (span === best.span && Math.abs(y) < Math.abs(best.y))) best = { y, span, picked };
    }
  }
  if (best) results.push({ seq: seq.join(' '), ...best });
}
results.sort((a, b) => a.span - b.span);
console.log(`可行顺序 ${results.length} / ${seen.size}`);
for (const r of results.slice(0, 8)) console.log(`  span=${String(r.span).padStart(3)} y=${String(r.y).padStart(4)}  [${r.seq}]  xs=[${r.picked}]`);
