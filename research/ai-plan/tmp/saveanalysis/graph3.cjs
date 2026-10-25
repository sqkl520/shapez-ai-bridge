const b=require('./base.cjs');
const {obj,ents,belts,machines,at,cellOwner,S,beltOut,DIRV,rotLocal,ejectors,acceptors,spec,rotOff}=b;
const key=(x,y)=>x+','+y;
const byUid=new Map(ents.map(e=>[e.uid,e]));
// tunnel pairing
const senders=ents.filter(e=>S(e).code===22||S(e).code===24);
const receivers=ents.filter(e=>S(e).code===23||S(e).code===25);
const tunnelPairs=[];
for(const s of senders){
  const ss=S(s); const dir=rotLocal('top',ss.rotation); const dv=DIRV[dir]; const maxR=ss.code===22?5:9;
  for(let d=1;d<=maxR;d++){const x=ss.origin.x+dv[0]*d,y=ss.origin.y+dv[1]*d;const o=cellOwner.get(key(x,y));if(o!=null){const oe=byUid.get(o);const oc=S(oe).code;if(oc===23||oc===25){tunnelPairs.push({sender:s.uid,receiver:oe.uid,dist:d,dir});break;}}}
}
const out=new Map(), inn=new Map();
const addEdge=(a,b)=>{if(a===b)return;if(!out.has(a))out.set(a,new Set());out.get(a).add(b);if(!inn.has(b))inn.set(b,new Set());inn.get(b).add(a);};
const deadBelt=[];
for(const bl of belts){const s=S(bl);const [dx,dy]=DIRV[beltOut(bl)];const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));if(t!=null)addEdge(bl.uid,t);else deadBelt.push(bl.uid);}
for(const e of machines){const c=S(e).code;if(c===22||c===24)continue;for(const ej of ejectors(e)){const [dx,dy]=DIRV[ej.dir];const t=cellOwner.get(key(ej.x+dx,ej.y+dy));if(t!=null)addEdge(e.uid,t);}}
for(const p of tunnelPairs)addEdge(p.sender,p.receiver);
for(const p of tunnelPairs){const r=byUid.get(p.receiver);const s=S(r);const [dx,dy]=DIRV[p.dir];const t=cellOwner.get(key(s.origin.x+dx,s.origin.y+dy));if(t!=null)addEdge(p.receiver,t);}
module.exports={...b,byUid,tunnelPairs,out,inn,addEdge,deadBelt,key};
if(require.main===module){
  console.log('tunnel pairs',tunnelPairs.length,'belts',belts.length,'machines',machines.length,'dead-end belts',deadBelt.length);
  const hub=ents.find(e=>S(e).code===26).uid;
  const rev=new Set([hub]),st=[hub];while(st.length){const n=st.pop();for(const p of (inn.get(n)||[]))if(!rev.has(p)){rev.add(p);st.push(p);}}
  console.log('entities reaching hub',rev.size,'/',ents.length);
  const miners=machines.filter(e=>e.components.Miner).map(e=>e.uid);
  console.log('miners feeding hub',miners.filter(u=>rev.has(u)).length,'/',miners.length);
  const fwd=new Set(miners),q=miners.slice();while(q.length){const n=q.pop();for(const o of (out.get(n)||[]))if(!fwd.has(o)){fwd.add(o);q.push(o);}}
  console.log('entities reachable from miners',fwd.size,'/',ents.length);
}
