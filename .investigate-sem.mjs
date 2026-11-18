import fs from "fs";
import { semanticDiagnoses } from "./src/agent/loop/semantic.mjs";
const obs = JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const items = JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const goal = obs.goal.requirement.shape;
const handles = obs.entities.map(e=>({id:String(e.uid),uid:e.uid,type:e.type,x:e.x,y:e.y}));
const ds = semanticDiagnoses(obs, items, goal, handles, { level: 12 });
for(const d of ds){
  console.log("\n=========", d.code, "sev="+d.severity);
  for(const [k,v] of Object.entries(d)){
    let s = typeof v==="object"?JSON.stringify(v):String(v);
    if(s.length>1200) s=s.slice(0,1200)+"…";
    console.log("  ",k,"=",s);
  }
}
