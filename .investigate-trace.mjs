import fs from "fs";
import {indexOf,at,isBelt,accepts,exitCellOf,exitDirOf,entryCellOf,flowReachable,sourceEntityOf} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const idx=indexOf(obs);
const pathOf=new Map(); for(const p of it.paths) for(const c of p.cells) pathOf.set(c.join(","),it.paths.indexOf(p));
function up(cell,depth,seen){
  if(depth>14) return "";
  const e=at(idx,cell);
  if(!e){return "EMPTY";}
  if(e.type!=="belt") return `${e.type}#${e.uid}`;
  const inp=entryCellOf(e);
  const k=inp.join(",");
  if(seen.has(k)) return "CYCLE";
  seen.add(k);
  return `belt#${e.uid}${e.r?"/r"+e.r:""}(path${pathOf.get(cell.join(","))??"?"})<-`+up(inp,depth+1,seen);
}
const seeds=[[-5,1],[27,-42],[33,-40],[35,-41],[0,-3],[1,-3]];
for(const s of seeds){
  const e=at(idx,s);
  console.log(`\n### source trace from ${s} : ${e?e.type+"#"+e.uid:"EMPTY"}`);
  console.log("   ",up(s,0,new Set([s.join(",")])));
}
