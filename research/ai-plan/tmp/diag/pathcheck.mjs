/* 严格可行性：从 n1.left 输出第一格 -> hub 任一入口的"带子末格"，4 邻接 BFS。
   阻挡 = 机器占地 + 既有实体（local 系）+ hub 内部 4x4。
   不引入 HUB_CLEAR 假设（那是机器簇下移用的，不是带子路由约束）。 */
import fs from "node:fs";
const o=JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/obs.json","utf8"));
const HUB=[[-2,-2],[0,0]];               // world hub origin, local offset = +2,+2
const toLocal=(x,y)=>[x+2,y+2];
const hubCells=new Set(); for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)hubCells.add(`${dx},${dy}`);
const entries=[];
for(let i=0;i<4;i++){entries.push({cell:[i,-1],inDir:"bottom"});}    // top row: belt ends above hub, flows down
for(let i=0;i<4;i++){entries.push({cell:[i,4],inDir:"top"});}         // bottom row
for(let i=0;i<4;i++){entries.push({cell:[-1,i],inDir:"right"});}      // left col
for(let i=0;i<4;i++){entries.push({cell:[4,i],inDir:"left"});}        // right col

function bfs(label, occupiedSet, starts){
  const q=[], seen=new Set();
  for(const s of starts){const k=s.join(","); if(occupiedSet.has(k))continue; q.push([s,0]); seen.add(k);}
  const entryKeys=new Map(entries.map(e=>[e.cell.join(","),e]));
  let best=null;
  while(q.length){
    const [c,d]=q.shift();
    if(entryKeys.has(c.join(","))){best={cell:c,d};break;}
    for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
      const n=[c[0]+dx,c[1]+dy], k=n.join(",");
      if(seen.has(k)||occupiedSet.has(k))continue;
      if(Math.abs(n[0])>100||Math.abs(n[1])>100)continue;
      seen.add(k); q.push([n,d+1]);
    }
  }
  console.log(label, "=>", best?`可达 ${JSON.stringify(best.cell)} 长度 ${best.d}`:"不可达");
  return best;
}

function buildOcc(entities, n1x){
  const s=new Set();
  for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)s.add(`${dx},${dy}`);
  // 新机器：n0 mine at (4,-5), n1 cut at (n1x,-13) 2x1
  s.add("4,-5");
  s.add(`${n1x},-13`); s.add(`${n1x+1},-13`);
  if(entities) for(const e of entities){
    if(e.type==="hub") continue;
    const [lx,ly]=toLocal(e.x,e.y);
    s.add(`${lx},${ly}`);
    if(e.type==="balancer"||e.type==="cutter"||e.type==="mixer"||e.type==="stacker"||e.type==="painter") s.add(`${lx+1},${ly}`);
  }
  return s;
}
const real=JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;

// case A: no-world, cutter at (4,-13); slot left at (4,-13) out top => first belt (4,-14)
console.log("--- A: 空地图，切割机 x=4，废料口 (4,-13) 朝上 => 首格 (4,-14)");
bfs("  废料口->hub", buildOcc(null,4), [[4,-14]]);
console.log("--- A2: 同图，目标可用：右半口 (5,-13) 朝上 => 首格 (5,-14)");
bfs("  右半口->hub", buildOcc(null,4), [[5,-14]]);

// case B: with-world, cutter at (5,-13); left slot (5,-13) => first (5,-14)
console.log("--- B: 181 实体，切割机 x=5，废料口首格 (5,-14)");
bfs("  废料口->hub", buildOcc(real,5), [[5,-14]]);
console.log("--- B2: 同上，右半口 (6,-13) 首格 (6,-14)");
bfs("  右半口->hub", buildOcc(real,5), [[6,-14]]);
