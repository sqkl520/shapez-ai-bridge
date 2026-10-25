const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid}=m;
const {out,inn}=g;
const lab=uid=>{const e=byUid.get(uid);const s=S(e);if(s.code<=3)return 'belt';if(s.code>=22&&s.code<=25)return 'tunnel';return (e.components.Miner?'miner':{4:'balancer',5:'merger',9:'cutter',10:'cutter',11:'rotater',12:'rotater',13:'rotater',15:'mixer',16:'painter',17:'painter',20:'trash',21:'storage',26:'hub'}[s.code]||'code'+s.code);};
const hub=ents.find(e=>S(e).code===26).uid;
function shortestToHub(start){
  const prev=new Map([[start,null]]); const q=[start];
  while(q.length){const n=q.shift(); if(n===hub){break;} for(const o of (out.get(n)||[])) if(!prev.has(o)){prev.set(o,n);q.push(o);} }
  if(!prev.has(hub))return null;
  const path=[]; let c=hub; while(c!==null){path.push(c);c=prev.get(c);} return path.reverse();
}
const miners=machines.filter(e=>e.components.Miner);
const results=[];
for(const mi of miners){
  const p=shortestToHub(mi.uid);
  if(p){
    const s=S(mi); const segs=[]; let run=null;
    for(const u of p){const k=lab(u); if(!run||run.kind!==k){run={kind:k,n:0,from:S(byUid.get(u)).origin};segs.push(run);} run.n++;}
    results.push({x:s.origin.x,y:s.origin.y,p,segs});
  }
}
console.log('miners with a path to hub:',results.length,'/',miners.length);
for(const r of results){
  console.log('\nminer@'+r.x+','+r.y+'  pathlen='+r.p.length);
  console.log('  '+r.segs.map(s=>s.kind+'×'+s.n).join(' -> '));
}
// overall: hub-feeding subgraph machine list
