const m=require('./net.cjs');
const g=require('./dgraph.cjs');
const {ents,belts,machines,at,S,ejectors,footprint}=m;
const {out,inn,cellOwner,byUid}=g;
const key=(x,y)=>x+','+y;
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const b of set)uni(a,b);
// also belt->adjacent machine even if not flow-connected? No: only flow edges.
const comps=new Map();
for(const e of ents){const r=find(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
const list=[...comps.values()].sort((a,b)=>b.length-a.length);
const glyph={4:'BAL',5:'MERG',9:'CUT',11:'ROT',15:'MIX',16:'PAINT',17:'PAINTm',20:'TRASH',21:'STOR',22:'TUN',23:'TUN',26:'HUB'};
function desc(c){
  const cnt={}; let miners=[]; let beltsN=0; const xs=[],ys=[];
  for(const e of c){const s=S(e);xs.push(s.origin.x);ys.push(s.origin.y);
    if(s.code<=3){beltsN++;continue;}
    if(e.components.Miner){miners.push(e);continue;}
    const g=glyph[s.code]||('code'+s.code); cnt[g]=(cnt[g]||0)+1;}
  return {beltsN,miners,cnt,bbox:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]};
}
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
(async()=>{}); // tileResource sync? check
console.log('total components',list.length);
console.log('top 15:');
for(let i=0;i<15;i++){
  const d=desc(list[i]);
  let res={};
  for(const mi of d.miners){const s=S(mi);const r=w.tileResource(seed,s.origin.x,s.origin.y);const k=r||'?';res[k]=(res[k]||0)+1;}
  console.log('#'+(i+1),'entities='+list[i].length,'belts='+d.beltsN,'miners='+d.miners.length,JSON.stringify(res),'machines='+JSON.stringify(d.cnt),'bbox='+JSON.stringify(d.bbox));
}
// component size histogram
const hist={};
for(const c of list){const b=Math.min(c.length,200);const k=c.length>=100?'>=100':c.length>=50?'50-99':c.length>=20?'20-49':c.length>=10?'10-19':'<10';hist[k]=(hist[k]||0)+1;}
console.log('size hist',JSON.stringify(hist));
// single-entity components count
console.log('isolated machines (no connections):',list.filter(c=>c.length===1&&S(c[0]).code>3).length);
console.log('isolated belts:',list.filter(c=>c.length===1&&S(c[0]).code<=3).length);
