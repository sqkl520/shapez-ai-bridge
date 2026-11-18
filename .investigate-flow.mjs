import fs from "fs";
import {indexOf,at,isBelt,flowReachable,entryCellOf,entryDirOf,exitCellOf,exitDirOf,rvOf} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const res=JSON.parse(fs.readFileSync(".investigate-res2.json","utf8")).result;
const idx=indexOf(obs);
const F=flowReachable(obs,idx);

// resource lookup from runs
const rmap=new Map();
for(const r of res.resources) for(const run of r.runs) for(let x=run.from;x<=run.to;x++) rmap.set(x+","+run.y, r.key);

const itemsByPath=new Map();
for(const b of it.belts){ if(!itemsByPath.has(b.path)) itemsByPath.set(b.path,[]); itemsByPath.get(b.path).push(b); }

console.log("=== MINERS: position -> resource -> output-cell belt ===");
for(const m of obs.entities.filter(e=>e.type==="miner")){
  const rk=rmap.get(m.x+","+m.y)||"NONE";
  const dirs={0:[0,-1],90:[1,0],180:[0,1],270:[-1,0]};
  const d=dirs[m.r]||[0,-1];
  const oc=[m.x+d[0],m.y+d[1]];
  const e=at(idx,oc);
  const onPath=e&&isBelt(e)? (itemsByPath.get([...itemsByPath.entries()].find(([p,arr])=>arr.some(x=>x.cell[0]===oc[0]&&x.cell[1]===oc[1]))?.[0])||[]) : [];
  const shapes={};
  for(const b of (e&&isBelt(e)? it.belts.filter(b=>b.cell[0]===oc[0]&&b.cell[1]===oc[1]) : [])) shapes[b.item]=(shapes[b.item]||0)+1;
  console.log(`${String(m.uid).padEnd(6)} (${m.x},${m.y}) r=${String(m.r).padStart(3)} resource=${rk.padEnd(10)} out=${oc} -> ${e?e.type+"#"+e.uid:"EMPTY"} flow=${e&&isBelt(e)&&F.has(e.uid)?1:0} items=${JSON.stringify(shapes)}`);
}

console.log("\n=== PATHS: source / acceptor / fullness ===");
const paths=it.paths;
for(let pi=0;pi<paths.length;pi++){
  const p=paths[pi];
  const arr=(itemsByPath.get(pi)||[]).sort((a,b)=>a.pos-b.pos);
  const shapes={}; for(const b of arr) shapes[b.item]=(shapes[b.item]||0)+1;
  const first=p.cells[0], last=p.cells[p.cells.length-1];
  // source: entity at entry of first cell
  const fe=at(idx,first);
  const srcInfo = fe&&isBelt(fe)? `entry=${entryCellOf(fe)} from ${at(idx,entryCellOf(fe))?.type||"EMPTY"}#${at(idx,entryCellOf(fe))?.uid||"-"}` : "?";
  // acceptor: entity at exit of last cell
  const le=at(idx,last);
  const acInfo = le&&isBelt(le)? `${exitCellOf(le)} -> ${at(idx,exitCellOf(le))?.type||"EMPTY"}#${at(idx,exitCellOf(le))?.uid||"-"}` : "?";
  const used = arr.length? arr[arr.length-1].pos+0.63 : 0;
  console.log(`#${pi} len=${String(p.cells.length).padStart(3)} ${String(first).padEnd(9)}->${String(last).padEnd(9)} items=${String(arr.length).padStart(3)} fill=${used.toFixed(1)}/${p.cells.length} shapes=${JSON.stringify(shapes)}`);
  console.log(`     src ${srcInfo}  | acceptor ${acInfo} (bound=${JSON.stringify(p.boundAcceptor)})`);
}
