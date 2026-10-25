const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,cellOwner,inn,out}=b;
const BP=obj.dump.beltPaths;
const carry=new Map();
for(const p of BP){const sh={};for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}for(const uid of p.entityPath){if(!carry.has(uid))carry.set(uid,{});const t=carry.get(uid);for(const k in sh)t[k]=(t[k]||0)+sh[k];}}
// For each hub feed, determine upstream raw color/shape inputs reaching it: collect miner resources upstream
const w=require('../../../../src/ai/world.mjs');
const hub=ents.find(e=>S(e).code===26).uid;
const NM={22:'tunIn',23:'tunOut'};
function readFeed(u){
  const seen=new Set([u]);const q=[u];const miners=[];
  while(q.length&&seen.size<6000){const n=q.shift();
    const e=byUid.get(n);const s=S(e);
    if(e.components.Miner)miners.push(w.tileResource(43391,s.origin.x,s.origin.y));
    for(const p of (inn.get(n)||[]))if(!seen.has(p)){seen.add(p);q.push(p);}
  }
  return {miners,n:seen.size};
}
const names={'c1@-2,-3':'ScScScSc (star) 800/level11','c1@-1,2':'CpCpCpCp (purple) ','c1@0,2':'CrCrCrCr (crimson)','c1@1,2':'Cu------ half-copper','c1@2,1':'RuRu---- + RbRb----','c1@-2,2':'CuCuCuCu (copper)','c1@-3,-1':'CuCuCuCu (copper)'};
for(const u of (inn.get(hub)||[])){
  const e=byUid.get(u);const s=S(e);
  const key='c'+s.code+'@'+s.origin.x+','+s.origin.y;
  const r=readFeed(u);
  const res={};for(const x of r.miners)res[x]=(res[x]||0)+1;
  console.log((names[key]||key).padEnd(28)+' <- upstream '+JSON.stringify(res));
}
