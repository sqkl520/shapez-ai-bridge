const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {obj,ents,belts,machines,S,byUid,at}=m;
const {out,inn}=g;
const bp=obj.dump.beltPaths;
const w=require('../../../../src/ai/world.mjs');
const seed=obj.dump.map.seed;
const carry=new Map();
for(const p of bp){const sh={};for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}for(const uid of p.entityPath){if(!carry.has(uid))carry.set(uid,{});const t=carry.get(uid);for(const k in sh)t[k]=(t[k]||0)+sh[k];}}
// undirected components over all entities via edges (incl machine-machine)
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const b of set)uni(a,b);
const comps=new Map();
for(const e of ents){const r=find(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
const list=[...comps.values()].sort((a,b)=>b.length-a.length);
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',8:'minerChain',9:'cutter',10:'cutterQuad',11:'rotater',12:'rotaterCCW',13:'rotater180',15:'mixer',16:'painter',17:'painterMirror',18:'painterDouble',19:'painterQuad',20:'trash',21:'storage',22:'tunnelIn',23:'tunnelOut',24:'tunnel2In',25:'tunnel2Out',26:'HUB'};
const shapeName=s=>s;
console.log('CLUSTERS (flow-connected), >=10 entities:');
let idx=0;
for(const c of list){
  if(c.length<10)continue;
  idx++;
  const cnt={}; const minerRes={}; let beltsN=0; const xs=[],ys=[]; const shapes={};
  for(const e of c){const s=S(e);xs.push(s.origin.x);ys.push(s.origin.y);
    if(s.code<=3){beltsN++;continue;}
    if(e.components.Miner){const r=w.tileResource(seed,s.origin.x,s.origin.y);minerRes[r]=(minerRes[r]||0)+1;continue;}
    cnt[NM[s.code]||('code'+s.code)]=(cnt[NM[s.code]||('code'+s.code)]||0)+1;
    const cc=carry.get(e.uid); if(cc)for(const k in cc)shapes[k]=(shapes[k]||0)+cc[k];
  }
  const topShapes=Object.entries(shapes).sort((a,b)=>b[1]-a[1]).slice(0,4).map(x=>x[0]+':'+x[1]);
  console.log('\n['+idx+'] entities='+c.length+' belts='+beltsN+' bbox x['+Math.min(...xs)+'..'+Math.max(...xs)+'] y['+Math.min(...ys)+'..'+Math.max(...ys)+']');
  console.log('   machines: '+JSON.stringify(cnt));
  if(Object.keys(minerRes).length)console.log('   miners: '+JSON.stringify(minerRes));
  if(topShapes.length)console.log('   shapes on belts: '+topShapes.join('  '));
}
