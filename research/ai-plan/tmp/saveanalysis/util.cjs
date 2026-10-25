const m=require('./net2.cjs');
const {obj,ents,belts,machines,S,byUid}=m;
const bp=obj.dump.beltPaths;
// density per path
let totalItems=0,totalSlots=0;
const dens=[];
for(const p of bp){const L=p.entityPath.length;const n=p.items.length;totalItems+=n;totalSlots+=L;if(L>=5)dens.push({L,n,d:n/L});}
console.log('paths',bp.length,'belts in paths',totalSlots,'items on belts',totalItems,'overall items/tile',(totalItems/totalSlots).toFixed(3));
dens.sort((a,b)=>b.d-a.d);
console.log('densest paths (items/tile):',dens.slice(0,8).map(d=>d.n+'/'+d.L+'='+d.d.toFixed(2)).join(' '));
console.log('median density',dens[Math.floor(dens.length/2)].d.toFixed(2));
const buckets={};for(const d of dens){const k=d.d>=1.2?'>=1.2':d.d>=0.8?'0.8-1.2':d.d>=0.4?'0.4-0.8':d.d>0?'0-0.4':'empty';buckets[k]=(buckets[k]||0)+1;}
console.log('density buckets',JSON.stringify(buckets));
// unique belts in paths
const inPath=new Set(); for(const p of bp)for(const u of p.entityPath)inPath.add(u);
console.log('unique belts referenced by paths',inPath.size,'of',belts.length);
// overproduction vs hub goals (level definitions up to 11)
const goals=[['CuCuCuCu',30],['----CuCu',40],['RuRuRuRu',70],['RuRu----',70],['Cu----Cu',170],['Cu------',270],['CrCrCrCr',300],['RbRb----',480],['CpCpCpCp',600],['ScScScSc',800],['CgScScCg',1000]];
const stored=obj.dump.hubGoals.storedShapes;
console.log('\nStored vs level requirement (sum of reqs through lvl11):');
const need={}; for(const [s,a] of goals)need[s]=(need[s]||0)+a;
for(const s of Object.keys(stored).sort((a,b)=>stored[b]-stored[a])){
  const n=need[s]||0;
  console.log('  '+(s+'        ').slice(0,10)+' stored='+String(stored[s]).padStart(7)+'  goalNeedThroughL11='+String(n).padStart(5)+(n?'  x'+(stored[s]/n).toFixed(0):''));
}
console.log('total stored items',Object.values(stored).reduce((a,b)=>a+b,0));
// dangling by type
const NM={4:'balancer',5:'merger',6:'mergerInv',7:'miner',9:'cutter',11:'rotater',12:'rotaterCCW',13:'rotater180',15:'mixer',16:'painter',17:'painterMirror',20:'trash',21:'storage',22:'tunIn',23:'tunOut',26:'hub'};
const g=require('./dgraph2.cjs');
const dang={}; for(const e of machines){const c=S(e).code;if(c===22||c===24||c===26)continue;const ej=m.ejectors(e);if(!ej.length)continue;const outs=[...(g.out.get(e.uid)||[])];if(!outs.length)dang[NM[c]||c]=(dang[NM[c]||c]||0)+1;}
console.log('\ndangling (ejector into empty):',JSON.stringify(dang),'total',Object.values(dang).reduce((a,b)=>a+b,0));
