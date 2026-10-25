const b=require('./graph3.cjs');
const {obj,ents,machines,belts,S,byUid,at}=b;
const now=obj.dump.time.timeSeconds;
console.log('save time',now.toFixed(1),'s =',(now/3600).toFixed(1),'hours');
const miners=machines.filter(e=>e.components.Miner);
const buckets={stalled:[],recent:[],mid:[]};
for(const e of miners){
  const s=S(e);const lm=e.components.Miner.lastMiningTime;
  const age=now-lm;
  const rec={x:s.origin.x,y:s.origin.y,age};
  if(age>60)buckets.stalled.push(rec);else if(age>5)buckets.mid.push(rec);else buckets.recent.push(rec);
}
console.log('miners stalled (>60s since last mine):',buckets.stalled.length,'/',miners.length);
console.log('  mid (5-60s):',buckets.mid.length,' recent (<5s):',buckets.recent.length);
// list stalled by cluster
const grouped={};
for(const r of buckets.stalled){const k=Math.round(r.x/8)+'|'+Math.round(r.y/8);(grouped[k]=grouped[k]||[]).push(r);}
console.log('stalled clusters:');
for(const k in grouped){const g=grouped[k];const xs=g.map(x=>x.x),ys=g.map(x=>x.y);
  console.log('   n='+g.length+' x['+Math.min(...xs)+'..'+Math.max(...xs)+'] y['+Math.min(...ys)+'..'+Math.max(...ys)+'] maxAge='+Math.max(...g.map(x=>x.age)).toFixed(0)+'s');}
// belt occupancy per component
console.log('\nitems stuck: total on belts',obj.dump.beltPaths.reduce((a,p)=>a+p.items.length,0));
// tunnel pending
let pend=0;for(const e of ents){if(e.components.UndergroundBelt){pend+=(e.components.UndergroundBelt.pendingItems||[]).length;}}
console.log('items inside tunnels',pend);
// ejector slots filled
let filled=0,slots=0;
for(const e of machines){if(e.components.ItemEjector){for(const s of e.components.ItemEjector.slots){slots++;if(s.item)filled++;}}}
console.log('machine output slots',slots,'filled',filled,(100*filled/slots).toFixed(0)+'%');
