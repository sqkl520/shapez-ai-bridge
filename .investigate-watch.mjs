import { execFileSync } from "child_process";
const rpc = (method, params) => JSON.parse(execFileSync("curl",["-s","-m","40","-X","POST","http://127.0.0.1:7777/rpc","-H","Content-Type: application/json","-d",JSON.stringify({jsonrpc:"2.0",id:1,method,params})],{encoding:"utf8"})).result;
const HUBCELLS = ["-2,-3","-1,-3","0,-3","1,-3","-3,-2","-3,-1","-2,2","2,-2","2,-1","2,1"];
for (let i=0;i<5;i++){
  const it = rpc("debug_items",{region:[-8,-8,8,8]});
  const obs = rpc("obs",{include_hub:true});
  const m = new Map();
  for(const b of it.belts){const k=b.cell.join(","); if(HUBCELLS.includes(k)) m.set(k,(m.get(k)||[]).concat(b.item+"@"+b.pos.toFixed(1)));}
  console.log("tick",obs.tick.toFixed(0),"delivered",obs.goal.requirement.delivered,
    "\n   ", HUBCELLS.map(k=>k+"="+JSON.stringify(m.get(k)||[])).join("\n    "));
  await new Promise(r=>setTimeout(r,4000));
}
