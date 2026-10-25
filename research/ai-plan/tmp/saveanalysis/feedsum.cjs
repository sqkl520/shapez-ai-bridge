const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,inn,out}=b;
const BP=obj.dump.beltPaths;
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',9:'cut',10:'cutQ',11:'rot',12:'rotCCW',13:'rot180',15:'mix',16:'paint',17:'paintM',18:'paintD',19:'paintQ',20:'trash',21:'stor',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'HUB'};
const nm=e=>{const s=S(e);return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y+'r'+s.rotation;};
// For each hub feed, list the immediate machine feeders of the upstream tree (topological summary)
function upstreamSummary(uid,maxDepth){
  const seen=new Set([uid]);const q=[[uid,0]];const machinesAt=[];const mSet={};
  while(q.length&&seen.size<4000){const [u,d]=q.shift();if(d>maxDepth)continue;
    const e=byUid.get(u);const s=S(e);
    if(s.code>3&&s.code!==22&&s.code!==23&&s.code!==24&&s.code!==25){(mSet[NM[s.code]||('c'+s.code)]=mSet[NM[s.code]||('c'+s.code)]||[]).push(s.origin.x+','+s.origin.y);}
    for(const p of (inn.get(u)||[]))if(!seen.has(p)){seen.add(p);q.push([p,d+1]);}
  }
  return {mSet,n:seen.size};
}
const hub=ents.find(e=>S(e).code===26).uid;
for(const u of (inn.get(hub)||[])){
  const {mSet,n}=upstreamSummary(u,999);
  console.log('\nfeed '+nm(byUid.get(u))+'  upstream nodes='+n);
  for(const k in mSet)console.log('   '+k+' ×'+mSet[k].length+': '+mSet[k].slice(0,60).join(' '));
}
