import fs from "fs";
import {indexOf,at,isBelt,flowReachable,entryCellOf,exitCellOf} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const res=JSON.parse(fs.readFileSync(".investigate-res2.json","utf8")).result;
const idx=indexOf(obs);
const rmap=new Map();
for(const r of res.resources) for(const run of r.runs) for(let x=run.from;x<=run.to;x++) rmap.set(x+","+run.y,r.key);
console.log("resource key -> tile count:", res.resources.map(r=>`${r.key}:${r.count}`).join(" "));
console.log("\nMINER RESOURCE ASSIGNMENT:");
const byRes={};
for(const m of obs.entities.filter(e=>e.type==="miner")){
  const k=rmap.get(m.x+","+m.y)||"<no resource under miner>";
  byRes[k]=(byRes[k]||0)+1;
  console.log(`  miner#${m.uid} (${m.x},${m.y}) -> ${k}`);
}
console.log("\nMINER COUNTS BY RESOURCE:",JSON.stringify(byRes));
console.log("resource kinds present:",[...new Set(res.resources.map(r=>r.key))].join(","));

// item "type" inference: shape vs color
const isColor=(s)=>["red","green","blue","cyan","yellow","purple","white","uncolored"].includes(s);
const hist={color:0,shape:0};
const shapeDetail={};
for(const b of it.belts){ if(isColor(b.item)) hist.color++; else {hist.shape++; shapeDetail[b.item]=(shapeDetail[b.item]||0)+1;} }
console.log("\nITEMS ON ALL BELTS: color items =",hist.color,"shape items =",hist.shape);
console.log("shape items:",JSON.stringify(shapeDetail));
console.log("\nANY PAINTED SHAPE (contains lowercase color code in a shape string)?");
for(const k of Object.keys(shapeDetail)) console.log("  ",k,"-> painted?", /[a-z]/.test(k.replace(/^[A-Z]/,m=>m)) && k.split(/(?=[A-Z])/).some(p=>/[a-z]/.test(p.slice(1))));
