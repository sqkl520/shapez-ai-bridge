const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,out,inn}=b;
const w=require('../../../../src/ai/world.mjs');
const hub=ents.find(e=>S(e).code===26).uid;
// BFS hop distance from miner to hub
function hops(start){
  const dist=new Map([[start,0]]);const q=[start];
  while(q.length){const n=q.shift();if(n===hub)return dist.get(n);for(const o of (out.get(n)||[]))if(!dist.has(o)){dist.set(o,dist.get(n)+1);q.push(o);}}
  return null;
}
const miners=machines.filter(e=>e.components.Miner).map(e=>{const s=S(e);return {x:s.origin.x,y:s.origin.y,res:w.tileResource(43391,s.origin.x,s.origin.y),uid:e.uid};});
const hs=miners.map(m=>({...m,h:hops(m.uid)}));
const reach=hs.filter(m=>m.h!==null);
console.log('miners with path to hub:',reach.length,'/',hs.length);
const sorted=reach.slice().sort((a,b)=>b.h-a.h);
console.log('longest supply chains (hops to hub):');
for(const m of sorted.slice(0,10))console.log('  miner@'+m.x+','+m.y+' '+m.res+'  hops='+m.h+'  manhattan='+(Math.abs(m.x+2)+Math.abs(m.y+2)));
const arr=reach.map(m=>m.h).sort((a,b)=>a-b);
console.log('median hops',arr[Math.floor(arr.length/2)],'max',arr[arr.length-1],'min',arr[0]);
const buckets={};for(const h of arr){const k=h>=50?'>=50':h>=30?'30-49':h>=15?'15-29':'<15';buckets[k]=(buckets[k]||0)+1;}
console.log('hop buckets',JSON.stringify(buckets));
// belt length per miner-to-hub shortest path
let totalBelt=0;for(const m of reach){totalBelt+=m.h;}
console.log('sum of hop counts',totalBelt);
// component 649 membership
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const bb of set)uni(a,bb);
const comps=new Map();for(const e of ents){const r=find(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
const c649=[...comps.values()].filter(c=>c.length===649)[0];
const ms=c649.filter(e=>e.components.Miner).map(e=>{const s=S(e);return w.tileResource(43391,s.origin.x,s.origin.y)+'@'+s.origin.x+','+s.origin.y;});
console.log('\ncomponent 649 miners ('+ms.length+'):');
console.log('  '+ms.join(' '));
// where does comp 649 output? find its belts with no downstream inside comp
const NM={4:'bal',7:'miner',9:'cut',15:'mix',16:'paint',17:'paintM',22:'tunIn',23:'tunOut'};
const leads=[];
for(const e of c649){const o=[...(out.get(e.uid)||[])];for(const t of o){if(!c649.includes(byUid.get(t))){leads.push(NM[S(e).code]+'@'+S(e).origin.x+','+S(e).origin.y+' -> outside');}}}
console.log('  outgoing leads:',JSON.stringify(leads.slice(0,10)));
const srcLeads=[];
for(const e of c649){const i=[...(inn.get(e.uid)||[])];for(const t of i){if(!c649.includes(byUid.get(t))){srcLeads.push(NM[S(e).code]+'@'+S(e).origin.x+','+S(e).origin.y+' <- outside');}}}
console.log('  incoming leads:',JSON.stringify(srcLeads.slice(0,10)));
