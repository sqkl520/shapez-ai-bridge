/* 穷举：在 no-world 布局下，n1.left 输出 -> hub 各入口，是否存在任何一条
   (竖直下 | 横向 | 竖直上) 的 Z 通道 + trash 落点 组合能同时成立。 */
const first = [4, -14];        // n1.left 输出第一格
const d1 = "top";              // 占位（实际 out.dir = top，first = slot + DIRV.top）
const slot = [4, -13];
const hub = [-2, -2];
const hubCells = new Set();
for (let dy=0; dy<4; dy++) for (let dx=0; dx<4; dx++) hubCells.add(`${hub[0]+dx},${hub[1]+dy}`);
const machine = new Set(["4,-13","5,-13","4,-5"]);
const hubEntries = [];
for (let i=0;i<4;i++){ hubEntries.push([hub[0]+i, hub[1]-1]); }        // top row, flow down
for (let i=0;i<4;i++){ hubEntries.push([hub[0]+i, hub[1]+4]); }        // bottom row, flow up
for (let i=0;i<4;i++){ hubEntries.push([hub[0]-1, hub[1]+i]); }        // left col, flow right
for (let i=0;i<4;i++){ hubEntries.push([hub[0]+4, hub[1]+i]); }        // right col, flow left

/* 判定：从 (4,-12) 起必须向上/下走，绕过 hub 圈，到某个入口。用 BFS 找最短路径，
   只允许 4 邻接，禁止机器格、hub 格、「hub 圈」上除入口外的格。 */
const HUB_CLEAR = 3;
const ring = new Set();
for (let dy=-1; dy<=4; dy++) for (let dx=-1; dx<=4; dx++) {
  if (dx>=0&&dx<4&&dy>=0&&dy<4) continue;
  if (dx>=-HUB_CLEAR && dx<=4+HUB_CLEAR-1 && dy>=-HUB_CLEAR && dy<=4+HUB_CLEAR-1) ring.add(`${hub[0]+dx},${hub[1]+dy}`);
}
const entries = new Set(hubEntries.map(c=>`${c[0]},${c[1]}`));
const blocked = c => {
  const k=`${c[0]},${c[1]}`;
  if (machine.has(k)) return true;
  if (hubCells.has(k)) return true;
  if (ring.has(k) && !entries.has(k)) return true;
  return false;
};
const start=[4,-12];
const q=[[start,0]]; const seen=new Set([`${start[0]},${start[1]}`]);
let reached=null;
while(q.length){
  const [c,d]=q.shift();
  if(entries.has(`${c[0]},${c[1]}`)){reached={c,d};break;}
  for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
    const n=[c[0]+dx,c[1]+dy]; const k=`${n[0]},${n[1]}`;
    if(seen.has(k)) continue; if(blocked(n)) continue;
    if(Math.abs(n[0])>80||Math.abs(n[1])>80) continue;
    seen.add(k); q.push([n,d+1]);
  }
}
console.log("最短可用路径（避开机器/hub/圈）:", reached ? JSON.stringify(reached) : "无");
console.log("入口数:", hubEntries.length, "被圈禁的非入口格:", ring.size-entries.size);
