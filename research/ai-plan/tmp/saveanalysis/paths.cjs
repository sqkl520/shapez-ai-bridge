const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid,at}=m;
const {out,inn}=g;
const isBelt=uid=>S(byUid.get(uid)).code<=3;
const isTun=uid=>{const c=S(byUid.get(uid)).code;return c===22||c===23||c===24||c===25;};
const lab=uid=>{const e=byUid.get(uid);const s=S(e);if(s.code<=3)return 'belt';if(isTun(uid))return 'tunnel';return (e.components.Miner?'miner':{4:'balancer',5:'merger',9:'cutter',10:'cutter',11:'rotater',15:'mixer',16:'painter',17:'painter',20:'trash',21:'storage',26:'hub'}[s.code]||'code'+s.code);};
const hub=ents.find(e=>S(e).code===26).uid;
// walk upstream collapsing belt chains into segments
function chainUp(uid){
  const seg=[]; let cur=uid, guard=0, beltsN=0;
  while(guard++<2000){
    if(isBelt(cur)){ beltsN++; const ups=[...(inn.get(cur)||[])]; if(ups.length!==1){seg.push({kind:'belt',start:cur,branch:ups.length,belts:beltsN});break;} cur=ups[0]; continue; }
    seg.push({kind:lab(cur),uid:cur,coords:S(byUid.get(cur)).origin,belts:beltsN});
    const ups=[...(inn.get(cur)||[])];
    if(ups.length!==1){break;} cur=ups[0]; beltsN=0;
  }
  return seg;
}
// All entities that reach hub; compute path for each miner
const rev=new Set([hub]); const st=[hub];
while(st.length){const n=st.pop();for(const p of (inn.get(n)||[]))if(!rev.has(p)){rev.add(p);st.push(p);}}
const minersIn=[...rev].filter(u=>byUid.get(u).components.Miner);
console.log('=== hub-ing miners:',minersIn.length);
for(const mi of minersIn){
  const seg=chainUp(mi); // upstream of miner is empty; instead walk downstream
}
// downstream path to hub per miner
function downPath(uid,maxLen=3000){
  const path=[uid]; let cur=uid;
  for(let i=0;i<maxLen;i++){
    const outs=[...(out.get(uid===cur?cur:cur)||[])];
    if(outs.length===0)return {path,dead:true};
    if(outs.length>1)return {path,split:true,n:outs.length};
    cur=outs[0]; path.push(cur);
    if(cur===hub)return {path,hub:true};
    if(path.length>400)break;
  }
  return {path};
}
console.log('\n=== downstream path per hub-ing miner ===');
for(const mi of minersIn){
  const s=S(byUid.get(mi));
  const r=downPath(mi);
  let b=0,t=0; const mac=[];
  for(const u of r.path){const e=byUid.get(u);const c=S(e).code;if(c<=3)b++;else if(c===22||c===23||c===24||c===25)t++;else mac.push(lab(u));}
  console.log('miner@'+s.origin.x+','+s.origin.y+' rot'+s.rotation+' -> '+r.path.length+' nodes, belts='+b+' tunnels='+t+' machines='+JSON.stringify(mac)+(r.hub?' HUB':r.dead?' DEADEND':' SPLIT'));
}
