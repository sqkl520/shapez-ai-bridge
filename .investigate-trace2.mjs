import fs from "fs";
import {indexOf,at,isBelt,accepts,exitCellOf,exitDirOf,entryCellOf,flowReachable,upstreamFed} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const idx=indexOf(obs);
const itemAt=new Map(); for(const b of it.belts){const k=b.cell.join(","); if(!itemAt.has(k))itemAt.set(k,[]); itemAt.get(k).push(b.item);}

// 1. path 8 last cells: does stacker accept?
const p8=it.paths[8].cells.slice(-4);
console.log("=== PATH8 tail cells ===");
for(const c of p8){
  const e=at(idx,c);
  const a=isBelt(e)?accepts(idx,exitCellOf(e),exitDirOf(e)):{};
  console.log(`  ${c} ${e.type}#${e.uid} rv=${e.rotation_variant} r=${e.r} exit=${isBelt(e)?exitCellOf(e):"-"} dir=${isBelt(e)?exitDirOf(e):"-"} accepts=${JSON.stringify(a)} items=${JSON.stringify(itemAt.get(c.join(","))||[])}`);
}
// 2. what is at stacker accept cells
console.log("\n=== STACKER 14684 (-2,5) 2x1: cells (-2,5),(-1,5) ===");
for(const c of [[-2,6],[-1,6],[-2,5],[-1,5],[-2,4]]){
  const e=at(idx,c);
  console.log(`  ${c}: ${e?e.type+"#"+e.uid+(isBelt(e)?` rv=${e.rotation_variant} entry=${entryCellOf(e)} exit=${exitCellOf(e)}`:""):"EMPTY"} items=${JSON.stringify(itemAt.get(c.join(","))||[])}`);
}
// 3. CuCuCuCu source trace - full backward walk of path 4
console.log("\n=== PATH4 (CuCuCuCu) backward ===");
const e0=at(idx,[-9,2]);
let cur=e0, seen=new Set();
for(let i=0;i<20&&cur&&isBelt(cur);i++){
  const k=cur.x+","+cur.y; if(seen.has(k)){console.log("  CYCLE");break;} seen.add(k);
  const inp=entryCellOf(cur); const u=at(idx,inp);
  console.log(`  belt#${cur.uid} (${cur.x},${cur.y}) rv=${cur.rotation_variant} entry=${inp} upstream=${u?u.type+"#"+u.uid:"EMPTY"} items=${JSON.stringify(itemAt.get(k)||[])}`);
  cur=u;
}
// 4. painters
console.log("\n=== PAINTERS ===");
for(const m of obs.entities.filter(e=>e.type==="painter")){
  console.log(` painter#${m.uid} (${m.x},${m.y}) r=${m.r}`);
  for(const c of [[m.x,m.y-1],[m.x+1,m.y-1],[m.x,m.y+1],[m.x+1,m.y+1],[m.x-1,m.y],[m.x+1,m.y],[m.x,m.y+2],[m.x,m.y-2]]){
    const e=at(idx,c);
    if(e) console.log(`    ${c}: ${e.type}#${e.uid} items=${JSON.stringify(itemAt.get(c.join(","))||[])}`);
  }
}
