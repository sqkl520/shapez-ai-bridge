import { execFileSync } from "child_process";
const rpc=(m,p)=>JSON.parse(execFileSync("curl",["-s","-m","40","-X","POST","http://127.0.0.1:7777/rpc","-H","Content-Type: application/json","-d",JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p||{}}) ],{encoding:"utf8"})).result;
const watch=[[36,-53],[36,-46],[8,4],[2,1],[0,-6],[1,-4],[-5,8],[-5,13],[-2,3],[27,-51]];
const t0=Date.now();
for(let i=0;i<7;i++){
  const it=rpc("debug_items",{region:[-300,-300,300,300]});
  const obs=rpc("obs",{include_hub:true});
  const m=new Map(); for(const b of it.belts){const k=b.cell.join(","); if(!m.has(k))m.set(k,[]); m.get(k).push(b.item+"@"+b.pos.toFixed(2));}
  const st=obs.hub.stored_shapes;
  console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] tick=${obs.tick.toFixed(0)} delivered=${obs.goal.requirement.delivered} CuCuCuCu=${st.CuCuCuCu} Cu----Cu=${st["Cu----Cu"]} nBeltsWithItems=${it.belts.length}`);
  console.log("   ", watch.map(c=>`${c[0]},${c[1]}=${JSON.stringify(m.get(c.join(","))||[])}`).join(" "));
  if(i<6) await new Promise(r=>setTimeout(r,10000));
}
