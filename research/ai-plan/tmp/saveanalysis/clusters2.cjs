const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,out,inn,belts:bl}=b;
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
const BP=obj.dump.beltPaths;
const carry=new Map();
for(const p of BP){const sh={};for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}for(const uid of p.entityPath){if(!carry.has(uid))carry.set(uid,{});const t=carry.get(uid);for(const k in sh)t[k]=(t[k]||0)+sh[k];}}
// undirected components
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const bb of set)uni(a,bb);
const comps=new Map();
for(const e of ents){const r=find(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
const list=[...comps.values()].sort((a,bb)=>bb.length-a.length);
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',8:'minerCh',9:'cut',10:'cutQ',11:'rot',12:'rotCCW',13:'rot180',15:'mix',16:'paint',17:'paintM',18:'paintD',19:'paintQ',20:'trash',21:'stor',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'HUB'};
console.log('flow-connected components:',list.length);
console.log('\ncomponents >= 20 entities:');
let i=0;
for(const c of list){
  if(c.length<20)continue;
  i++;
  const cnt={};const minerRes={};let beltsN=0;const xs=[],ys=[];const shapes={};
  for(const e of c){const s=S(e);xs.push(s.origin.x);ys.push(s.origin.y);
    if(s.code<=3){beltsN++;continue;}
    if(e.components.Miner){const r=w.tileResource(seed,s.origin.x,s.origin.y);minerRes[r]=(minerRes[r]||0)+1;continue;}
    cnt[NM[s.code]||('c'+s.code)]=(cnt[NM[s.code]||('c'+s.code)]||0)+1;
    const cc=carry.get(e.uid);if(cc)for(const k in cc)shapes[k]=(shapes[k]||0)+cc[k];
  }
  const top=Object.entries(shapes).sort((a,bb)=>bb[1]-a[1]).slice(0,3).map(x=>x[0]+':'+x[1]);
  console.log('\n['+i+'] n='+c.length+' belts='+beltsN+' bbox x['+Math.min(...xs)+'..'+Math.max(...xs)+'] y['+Math.min(...ys)+'..'+Math.max(...ys)+']');
  console.log('    machines '+JSON.stringify(cnt));
  if(Object.keys(minerRes).length)console.log('    miners '+JSON.stringify(minerRes));
  if(top.length)console.log('    shapes '+top.join(' '));
}
