const m=require('./net.cjs');
const {ents,belts,machines,at,S,beltOut,DIRV,OPP,ejectors,acceptors,footprint}=m;
const key=(x,y)=>x+','+y;
const cellOwner=new Map(); // cell -> {uid,code}
for(const e of ents){const s=S(e);const fp=footprint(e);for(let y=fp.y;y<fp.y+fp.h;y++)for(let x=fp.x;x<fp.x+fp.w;x++)cellOwner.set(key(x,y),{uid:e.uid,code:s.code});}
const byUid=new Map(ents.map(e=>[e.uid,e]));
// edges: uid -> Set(uid)
const out=new Map(), inn=new Map();
const addEdge=(a,b)=>{if(a===b)return;if(!out.has(a))out.set(a,new Set());out.get(a).add(b);if(!inn.has(b))inn.set(b,new Set());inn.get(b).add(a);};
// belt exit
for(const b of belts){
  const s=S(b); const [dx,dy]=DIRV[beltOut(b)];
  const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));
  if(t) addEdge(b.uid,t.uid);
}
// machine ejectors
for(const e of machines){
  for(const ej of ejectors(e)){
    const [dx,dy]=DIRV[ej.dir];
    const t=cellOwner.get(key(ej.x+dx,ej.y+dy));
    if(t) addEdge(e.uid,t.uid);
  }
}
// dead-end belt (nothing ahead) counts as sink
const sinks=new Set(), sources=new Set();
for(const b of belts){const s=S(b);const [dx,dy]=DIRV[beltOut(b)];const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));if(!t)sinks.add(b.uid);}
for(const e of machines){ if(!inn.has(e.uid)||inn.get(e.uid).size===0) sources.add(e.uid); }
module.exports={out,inn,cellOwner,byUid,addEdge,sinks,sources,key};
if(require.main===module){
  console.log('nodes with out-edges',out.size,'sink belts',sinks.size);
  // reverse reachability from hub
  const hub=ents.find(e=>S(e).code===26).uid;
  const seen=new Set([hub]); const stack=[hub];
  while(stack.length){const n=stack.pop();for(const p of (inn.get(n)||[]))if(!seen.has(p)){seen.add(p);stack.push(p);}}
  console.log('entities that can reach hub:',seen.size);
  const miners=machines.filter(e=>e.components.Miner).map(e=>e.uid);
  console.log('miners reaching hub:',miners.filter(u=>seen.has(u)).length,'/',miners.length);
  // forward from miners
  const fwd=new Set(); const st=miners.slice();
  st.forEach(u=>fwd.add(u));
  while(st.length){const n=st.pop();for(const q of(out.get(n)||[]))if(!fwd.has(q)){fwd.add(q);st.push(q);}}
  console.log('entities reachable FROM any miner:',fwd.size);
}
