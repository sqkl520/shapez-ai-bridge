import fs from "fs";
import {indexOf,at,isBelt,accepts,exitCellOf,exitDirOf,entryCellOf,entryDirOf,flowReachable} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const idx=indexOf(obs);
const F=flowReachable(obs,idx);
const itemAt=new Map(); for(const b of it.belts){const k=b.cell.join(","); if(!itemAt.has(k))itemAt.set(k,[]); itemAt.get(k).push(b.item);}
const machines=obs.entities.filter(e=>!["belt","hub"].includes(e.type));
const fedBy=new Map(), feedsTo=new Map();
for(const b of obs.entities.filter(e=>e.type==="belt")){
  const ec=exitCellOf(b), ed=exitDirOf(b);
  const acc=accepts(idx,ec,ed);
  if(acc&&acc.ok&&acc.by){
    const dest=obs.entities.find(e=>e.uid===acc.by);
    if(dest&&dest.type!=="belt"){ if(!fedBy.has(dest.uid))fedBy.set(dest.uid,[]); fedBy.get(dest.uid).push({belt:b.uid,cell:b.cell,kind:acc.kind,items:itemAt.get(b.x+","+b.y)||[]}); }
  }
}
console.log("=== MACHINES: belts actually pointing INTO them (verified by accepts()) ===");
for(const m of machines){
  const f=fedBy.get(m.uid)||[];
  console.log(`${m.type}#${m.uid} (${m.x},${m.y}) r=${m.r} rv=${m.rotation_variant} :: fedBy=${f.length} ${JSON.stringify(f)}`);
}
