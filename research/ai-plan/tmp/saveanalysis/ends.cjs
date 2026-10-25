const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,out,inn,deadBelt,cellOwner,at,ejectors,DIRV,beltOut}=b;
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',9:'cut',10:'cutQ',11:'rot',12:'rotCCW',13:'rot180',15:'mix',16:'paint',17:'paintM',20:'trash',21:'stor',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'HUB'};
console.log('dead-end belts',deadBelt.length);
for(const u of deadBelt){const s=S(byUid.get(u));console.log('  belt@'+s.origin.x+','+s.origin.y+' code'+s.code+' rot'+s.rotation);}
// dangling machines
let dang=[];
for(const e of machines){const c=S(e).code;if(c===22||c===24||c===26)continue;const ej=ejectors(e);if(!ej.length)continue;const o=[...(out.get(e.uid)||[])];if(!o.length){const s=S(e);dang.push({t:NM[c]||c,x:s.origin.x,y:s.origin.y,rot:s.rotation,ej:ej.length,dirs:ej.map(x=>x.dir).join('')});}}
console.log('\ndangling machines',dang.length);
const byT={};for(const d of dang)byT[d.t]=(byT[d.t]||0)+1;
console.log(JSON.stringify(byT));
for(const d of dang.slice(0,40))console.log('  '+d.t+'@'+d.x+','+d.y+' rot'+d.rot+' ej'+d.ej+' '+d.dirs);
// machines with no input at all but with output (pure sources other than miner)
let srcs=[];
for(const e of machines){const c=S(e).code;if(c===22||c===24)continue;const i=inn.get(e.uid);const o=out.get(e.uid);if((!i||!i.size)&&o&&o.size&&!e.components.Miner){const s=S(e);srcs.push(NM[c]||c+'@'+s.origin.x+','+s.origin.y);}}
console.log('\nnon-miner sources (no input, has output):',srcs.length,JSON.stringify(srcs.slice(0,40)));
