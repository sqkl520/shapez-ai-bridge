import fs from "node:fs";
const es = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const wide = new Set(["cutter","balancer","mixer","stacker","painter"]);
const occ = new Set();
for (const e of es) {
  const w = wide.has(e.type) ? 2 : 1;
  for (let dx=0; dx<w; dx++) occ.add(`${e.x+dx},${e.y}`);
}
const hubEntry = [0,-3];          // 唯一空着的 hub 顶排入口
console.log("hub 顶排入口占用：");
for (let x=-2;x<=1;x++) console.log("  ("+x+",-3)", occ.has(`${x},-3`) ? "占用" : "空");
function bfs(from, to) {
  const q=[[from,0]], seen=new Set([from.join(",")]);
  while(q.length){
    const [c,d]=q.shift();
    if(c[0]===to[0]&&c[1]===to[1]) return d;
    for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
      const n=[c[0]+dx,c[1]+dy], k=n.join(",");
      if(seen.has(k)||occ.has(k))continue;
      if(Math.abs(n[0])>40||Math.abs(n[1])>40)continue;
      seen.add(k); q.push([n,d+1]);
    }
  }
  return null;
}
// 自由 Ru 格（tileResource=RuRuRuRu 且未被实体占）
const ruCells=[[4,-6],[5,-6],[6,-7],[6,-6],[6,-5],[6,-4],[7,-7],[7,-6],[7,-5],[7,-4],[8,-7],[8,-6],[8,-5]];
console.log("\n自由 Ru 格 -> hub 入口 (0,-3) 的带子格数（BFS 不含机器）：");
for (const c of ruCells) {
  if (occ.has(`${c[0]},${c[1]}`)) { console.log("  ",c.join(","),"已被占"); continue; }
  // 矿机占 c，输出格 c+[0,-1]
  const out=[c[0],c[1]-1];
  if (occ.has(out.join(","))) { console.log("  ",c.join(","),"输出格被占"); continue; }
  const d=bfs(out,hubEntry);
  console.log("  ",c.join(","),"-> 输出格",out.join(","),"距离",d);
}
