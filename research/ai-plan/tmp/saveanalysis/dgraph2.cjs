const m=require('./net2.cjs');
const {ents,belts,machines,at,S,beltOut,DIRV,ejectors,footprint,cellOwner,byUid,tunnelPairs}=m;
const key=(x,y)=>x+','+y;
const out=new Map(), inn=new Map();
const addEdge=(a,b)=>{if(a===b)return;if(!out.has(a))out.set(a,new Set());out.get(a).add(b);if(!inn.has(b))inn.set(b,new Set());inn.get(b).add(a);};
let deadBelt=[];
for(const b of belts){
  const s=S(b); const [dx,dy]=DIRV[beltOut(b)];
  const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));
  if(t) addEdge(b.uid,t.uid); else deadBelt.push(b.uid);
}
for(const e of machines){
  if(S(e).code===22||S(e).code===24) continue; // tunnel sender: no ejector
  for(const ej of ejectors(e)){
    const [dx,dy]=DIRV[ej.dir];
    const t=cellOwner.get(key(ej.x+dx,ej.y+dy));
    if(t) addEdge(e.uid,t.uid);
  }
}
// tunnel edges sender->receiver
for(const p of tunnelPairs) addEdge(p.sender,p.receiver);
// receiver behaves like a belt: eject toward its dir
for(const p of tunnelPairs){
  const r=byUid.get(p.receiver); const s=S(r); const [dx,dy]=DIRV[p.dir];
  const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));
  if(t) addEdge(p.receiver,t.uid);
}
module.exports={out,inn,addEdge,deadBelt,cellOwner,byUid};
if(require.main===module){
  console.log('dead-end belts',deadBelt.length);
  const hub=ents.find(e=>S(e).code===26).uid;
  const rev=new Set([hub]),st=[hub];
  while(st.length){const n=st.pop();for(const p of (inn.get(n)||[]))if(!rev.has(p)){rev.add(p);st.push(p);}}
  console.log('entities reaching hub:',rev.size,'/',ents.length);
  const miners=machines.filter(e=>e.components.Miner).map(e=>e.uid);
  console.log('miners->hub:',miners.filter(u=>rev.has(u)).length,'/',miners.length);
  // which sink machines (trash) exist
  console.log('trash reachable from miners?');
  const fwd=new Set(miners),q=miners.slice();
  while(q.length){const n=q.pop();for(const o of (out.get(n)||[]))if(!fwd.has(o)){fwd.add(o);q.push(o);}}
  console.log('reachable from miners:',fwd.size,'/',ents.length);
  // hub-bound subgraph breakdown by machine type
  const cnt={};for(const uid of rev){const e=byUid.get(uid);const c=S(e).code;const g=c<=3?'belt':(e.components.Miner?'miner':{4:'balancer',5:'merger',9:'cutter',10:'cutter',11:'rotater',15:'mixer',16:'painter',17:'painter',20:'trash',22:'tun',23:'tun',26:'hub'}[c]||('code'+c));cnt[g]=(cnt[g]||0)+1;}
  console.log('hub-subgraph:',JSON.stringify(cnt));
}
