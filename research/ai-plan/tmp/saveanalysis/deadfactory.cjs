const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,out,inn,cellOwner}=b;
const NM={4:'bal',7:'miner',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'hub'};
const nm=u=>{const e=byUid.get(u);const s=S(e);return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y;};
const hub=ents.find(e=>S(e).code===26).uid;
// comp of a given entity
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const bb of set)uni(a,bb);
const rootOf=e=>find(e.uid);
// comp 649 = the one containing belt 47,-143
const sink=at.get('47,-143');
const comp=ents.filter(e=>rootOf(e)===rootOf(sink));
console.log('comp size',comp.length);
// Miners in comp and their downstream chain to sink
function chain(uid){
  const path=[uid];let cur=uid;const seen=new Set([uid]);
  for(let i=0;i<5000;i++){
    const outs=[...(out.get(cur)||[])];
    if(!outs.length)return {path,dead:true};
    // prefer route to sink
    let next=outs[0];
    if(outs.length>1){next=outs.find(o=>comp.some(e=>e.uid===o))??outs[0];}
    if(seen.has(next))return {path,loop:true};
    seen.add(next);path.push(next);cur=next;
    if(cur===sink.uid)return {path,sink:true};
  }
  return {path};
}
const ms=comp.filter(e=>e.components.Miner).map(e=>S(e));
const byRes={};for(const s of ms){const r=require('../../../../src/ai/world.mjs');}
// group miners by position to summarize
console.log('miners:',ms.length);
// count machines in comp
const cnt={};for(const e of comp){const s=S(e);const k=s.code<=3?'belt':(NM[s.code]||s.code);cnt[k]=(cnt[k]||0)+1;}
console.log('comp machines',JSON.stringify(cnt));
// which lane feeds the sink and from where
let cur=sink;
const ups=[];
for(let i=0;i<60;i++){
  const u=[...(inn.get(cur.uid)||[])];
  if(u.length!==1)break;
  cur=byUid.get(u[0]);ups.push(cur);
}
console.log('sink upstream (last 10):',ups.slice(-10).map(nm).join(' <- '));
console.log('sink upstream length',ups.length);
// total length of this dead factory's transport
console.log('dead factory belts',comp.filter(e=>S(e).code<=3).length);
