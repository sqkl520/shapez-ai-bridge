import { execFileSync } from "child_process";
const rpc=(m,p)=>JSON.parse(execFileSync("curl",["-s","-m","40","-X","POST","http://127.0.0.1:7777/rpc","-H","Content-Type: application/json","-d",JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p||{}}) ],{encoding:"utf8"})).result;
const snap=()=>{ const it=rpc("debug_items",{region:[-300,-300,300,300]}); const o=rpc("obs",{include_hub:true});
  const byPath=new Map(); for(const b of it.belts){ if(!byPath.has(b.path))byPath.set(b.path,[]); byPath.get(b.path).push(b);} return {byPath,o,raw:it}; };
const A=await snap(); await new Promise(r=>setTimeout(r,30000)); const B=await snap();
console.log("tick",A.o.tick.toFixed(0),"->",B.o.tick.toFixed(0),"| hub bytes equal:",JSON.stringify(A.o.hub.stored_shapes)===JSON.stringify(B.o.hub.stored_shapes));
console.log("belts-with-items",A.raw.belts.length,"->",B.raw.belts.length);
console.log("ejectors equal:",JSON.stringify(A.raw.ejectors)===JSON.stringify(B.raw.ejectors));
for(let pi=0;pi<A.raw.pathCount;pi++){
  const a=(A.byPath.get(pi)||[]), b=(B.byPath.get(pi)||[]);
  const ka=a.map(x=>x.item+"@"+x.pos.toFixed(2)).sort(), kb=b.map(x=>x.item+"@"+x.pos.toFixed(2)).sort();
  const same=ka.length===kb.length && ka.every((v,i)=>v===kb[i]);
  if(a.length||b.length) console.log(`path#${pi}: n=${a.length}->${b.length} ${same?"FROZEN":"MOVING"}`);
}
