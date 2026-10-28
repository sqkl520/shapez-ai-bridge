/* 手工方案可行性搜索：
   矿机(r=0, 输出向上) -> 带子向上 -> 切割机(r=0, 输入在 y+1) -> 左半(target)进 hub / 右半(waste)进 trash
   约束：不压任何既有实体；带子 4 邻接；切割机 2x1；
   终点：hub 顶排唯一空入口 (0,-3)（带子末格，流向 down 进 hub）
*/
import fs from "node:fs";
const es = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const wide = new Set(["cutter","balancer","mixer","stacker","painter"]);
const occ = new Set();
for (const e of es) { const w = wide.has(e.type)?2:1; for (let dx=0;dx<w;dx++) occ.add(`${e.x+dx},${e.y}`); }
const RU = [[4,-6],[5,-6],[6,-7],[6,-6],[6,-5],[6,-4],[7,-7],[7,-6],[7,-5],[7,-4],[8,-7],[8,-6],[8,-5]];
const ENTRY=[0,-3];
const inb = c => Math.abs(c[0])<40 && Math.abs(c[1])<40;
function path(from,to,blocked){
  const q=[[from,0,null]], prev=new Map(), seen=new Set([from.join(",")]);
  while(q.length){
    const [c,d] = q.shift();
    if(c[0]===to[0]&&c[1]===to[1]){
      const cells=[]; let k=to.join(","); 
      while(k){ cells.push(k.split(",").map(Number)); k=prev.get(k); }
      return { d, cells: cells.reverse() };
    }
    for(const [dx,dy] of [[0,-1],[1,0],[0,1],[-1,0]]){
      const n=[c[0]+dx,c[1]+dy], k=n.join(",");
      if(!inb(n)||seen.has(k)||blocked(n))continue;
      seen.add(k); prev.set(k,c.join(",")); q.push([n,d+1]);
    }
  }
  return null;
}
const results=[];
for(const m of RU){
  if(occ.has(m.join(","))) continue;
  for(const gap of [0,1,2]){                 // 矿机与切割机之间隔几格带子
    const cutTop = [m[0], m[1]-1-gap];        // 切割机所在行
    const cut=[cutTop[0],cutTop[1]];
    const inCell=[cut[0],cut[1]+1];
    if(gap===0) continue;                     // 矿机输出格必须由带子或直接输入承接；gap=0 即切割机紧贴
    const c1=[cut[0]+1,cut[1]];
    if(occ.has(cut.join(","))||occ.has(c1.join(","))||occ.has(inCell.join(","))) continue;
    for(const half of ["left","right"]){       // 哪个半块是目标
      const tgt = half==="left"? [cut[0],cut[1]-1] : [cut[0]+1,cut[1]-1];
      const wst = half==="left"? [cut[0]+1,cut[1]-1] : [cut[0],cut[1]-1];
      if(occ.has(tgt.join(","))||occ.has(wst.join(","))) continue;
      const blk = n => occ.has(n.join(","));
      const feed = path([m[0],m[1]-1], inCell, blk);
      if(!feed) continue;
      const toHub = path(tgt, ENTRY, blk);
      if(!toHub) continue;
      // trash：贴在 waste 首格旁（4 邻接且不在 waste 通路上）
      const trashCands=[[wst[0],wst[1]-1],[wst[0]+1,wst[1]],[wst[0]-1,wst[1]],[wst[0],wst[1]+1]];
      const trash=trashCands.find(t=>!blk(t)&&!(t[0]===wst[0]&&t[1]===wst[1])&&!toHub.cells.some(c=>c[0]===t[0]&&c[1]===t[1]));
      if(!trash) continue;
      const belts = (feed.d) + (toHub.d) + 1 /* trash 旁那一格带子 */;
      results.push({miner:m, gap, cut, half, tgt, wst, trash, feedBelts:feed.d, hubBelts:toHub.d, totalEnts: 3+belts});
    }
  }
}
results.sort((a,b)=>a.totalEnts-b.totalEnts);
console.log("候选数:",results.length);
for(const r of results.slice(0,6))
  console.log(`矿机${r.miner} gap${r.gap} 切割机${r.cut} 目标半块=${r.half} trash${r.trash} | 喂料带${r.feedBelts} 到hub带${r.hubBelts} => 约 ${r.totalEnts} 实体`);
