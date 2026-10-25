const m=require('./net2.cjs');
const {obj,ents,belts,machines,S,at,byUid}=m;
const bp=obj.dump.beltPaths;
// map uid -> dominant shape
const carry=new Map();
for(const p of bp){const sh={};for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}for(const uid of p.entityPath){if(!carry.has(uid))carry.set(uid,{});const t=carry.get(uid);for(const k in sh)t[k]=(t[k]||0)+sh[k];}}
const nm={4:'bal',5:'merg',6:'merginv',7:'MINER',9:'cut',10:'cutQ',11:'rot',12:'rotCCW',13:'rot180',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'HUB'};
function machineShape(e){
  // look upstream 6 hops for shapes
  const {inn}=require('./dgraph2.cjs');
  const sh={};const seen=new Set();let q=[e.uid];
  for(let d=0;d<6&&q.length;d++){
    const nq=[];
    for(const u of q){if(seen.has(u))continue;seen.add(u);
      const c=carry.get(u);if(c)for(const k in c)sh[k]=(sh[k]||0)+c[k];
      for(const p of (inn.get(u)||[]))nq.push(p);
    }
    q=nq;
  }
  return Object.entries(sh).sort((a,b)=>b[1]-a[1]).slice(0,3);
}
const region=(x0,x1,y0,y1)=>machines.filter(e=>{const s=S(e);return s.origin.x>=x0&&s.origin.x<=x1&&s.origin.y>=y0&&s.origin.y<=y1;});
const args=process.argv.slice(2).map(Number);
const [x0,x1,y0,y1]=args;
console.log('MACHINES in x['+x0+'..'+x1+'] y['+y0+'..'+y1+']:');
const list=region(x0,x1,y0,y1).sort((a,b)=>S(a).origin.y-S(b).origin.y||S(a).origin.x-S(b).origin.x);
for(const e of list){const s=S(e);console.log('  '+nm[s.code]||s.code,'@'+s.origin.x+','+s.origin.y,'rot'+s.rotation,JSON.stringify(machineShape(e)));}
console.log('count',list.length);
