const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid}=m;
const {out,inn}=g;
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
const NM={4:'balancer',5:'merger',6:'mergerInv',7:'miner',8:'minerChain',9:'cutter',10:'cutterQuad',11:'rotater',12:'rotaterCCW',13:'rotater180',15:'mixer',16:'painter',17:'painterMirror',20:'trash',21:'storage',22:'tunnelIn',23:'tunnelOut',24:'tunnel2In',25:'tunnel2Out',26:'hub'};
// isolated under full graph (tunnels paired)
const iso=machines.filter(e=>!(out.get(e.uid)&&out.get(e.uid).size)&&!(inn.get(e.uid)&&inn.get(e.uid).size));
const isoBy={}; for(const e of iso){const k=NM[S(e).code];isoBy[k]=(isoBy[k]||0)+1;}
console.log('isolated machines (full graph):',iso.length,JSON.stringify(isoBy));
// machines with only output no input (sources)
const src=machines.filter(e=>!(inn.get(e.uid)&&inn.get(e.uid).size)&&(out.get(e.uid)&&out.get(e.uid).size));
const srcBy={}; for(const e of src){const k=NM[S(e).code];srcBy[k]=(srcBy[k]||0)+1;}
console.log('machines with no input but output:',src.length,JSON.stringify(srcBy));
// machines with input but no output (sinks)
const snk=machines.filter(e=>(inn.get(e.uid)&&inn.get(e.uid).size)&&!(out.get(e.uid)&&out.get(e.uid).size));
const snkBy={}; for(const e of snk){const k=NM[S(e).code];snkBy[k]=(snkBy[k]||0)+1;}
console.log('machines with input but no output:',snk.length,JSON.stringify(snkBy));
// how many machines output into NOTHING (ejector lands on empty) - dangling
let dangling=0, danglingList=[];
for(const e of machines){
  if(S(e).code===22||S(e).code===24||S(e).code===26) continue;
  const ej=m.ejectors(e);
  if(!ej.length) continue;
  const outs=[...(out.get(e.uid)||[])];
  if(outs.length===0){dangling++;danglingList.push(NM[S(e).code]+'@'+S(e).origin.x+','+S(e).origin.y);}
}
console.log('dangling machines (ejector -> nothing):',dangling,JSON.stringify(danglingList.slice(0,20)));
// truncation: machines with input belts but no out
// total supply capacity: miners x rate
const beltAssert={1:'belt',2:'belt',3:'belt'};
const minerRate=0.4*3; // 0.4 items/s * minerMult 3
console.log('miner total rate', (145*minerRate).toFixed(1),'items/s');
// per resource
const per={}; for(const e of machines.filter(x=>x.components.Miner)){const s=S(e);const r=w.tileResource(seed,s.origin.x,s.origin.y);per[r]=(per[r]||0)+1;}
console.log('miners per resource',JSON.stringify(per));
// how many miners are on the hub-connected subgraph
const hub=ents.find(e=>S(e).code===26).uid;
const rev=new Set([hub]),st=[hub];
while(st.length){const n=st.pop();for(const p of (inn.get(n)||[]))if(!rev.has(p)){rev.add(p);st.push(p);}}
const minersIn=[...rev].filter(u=>byUid.get(u).components.Miner);
console.log('miners feeding hub (transitively):',minersIn.length);
// productivity per resource that reaches hub
const perHub={}; for(const u of minersIn){const s=S(byUid.get(u));const r=w.tileResource(seed,s.origin.x,s.origin.y);perHub[r]=(perHub[r]||0)+1;}
console.log('hub miners per resource',JSON.stringify(perHub));
