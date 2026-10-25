// 最终可行性：矿机 x 由资源决定（保序），消费者跟随。
// 判据：所有通道都能 planChannel，且跨度在 V4 的 256 内。
import { resourcesInRegion } from '../../../src/ai/world.mjs';
const R = 400;
const cells = resourcesInRegion(43391, { x0:-R, y0:-R, x1:R, y1:R });
const by = new Map();
for (const [x,y,s] of cells) { if(!by.has(s)) by.set(s,[]); by.get(s).push([x,y]); }
for (const a of by.values()) a.sort((p,q)=>p[0]-q[0]||p[1]-q[1]);
const rows = new Map();
for (const [x,y,s] of cells) { if(!rows.has(y)) rows.set(y,new Map()); const m=rows.get(y); if(!m.has(s)) m.set(s,[]); m.get(s).push(x); }
for (const m of rows.values()) for (const a of m.values()) a.sort((p,q)=>p-q);

const NEED = { CpCpCpCp:['blue','red','CuCuCuCu'], CgScScCg:['green','blue','green','SuSuSuSu','CuCuCuCu'] };
for (const [goal, seq] of Object.entries(NEED)) {
  const hits = [];
  for (const [y, m] of rows) {
    // 保序 + 最小跨度 DP
    const lists = seq.map(s => m.get(s) || []);
    if (lists.some(l=>!l.length)) continue;
    let best = null;
    for (const start of lists[0]) {
      let prev = start, ok = true, xs = [start];
      for (let i=1;i<lists.length;i++) {
        const nx = lists[i].find(v => v > prev);
        if (nx === undefined) { ok=false; break; }
        xs.push(nx); prev = nx;
      }
      if (!ok) continue;
      const span = xs[xs.length-1]-xs[0];
      if (!best || span < best.span) best = { span, xs };
    }
    if (best) hits.push({ y, ...best });
  }
  hits.sort((a,b)=>a.span-b.span || Math.abs(a.y+2)-Math.abs(b.y+2));
  console.log(`\n${goal}: ${hits.length} 行可行`);
  for (const h of hits.slice(0,4)) console.log(`  y=${String(h.y).padStart(4)} span=${String(h.span).padStart(3)} xs=[${h.xs}]`);
}
