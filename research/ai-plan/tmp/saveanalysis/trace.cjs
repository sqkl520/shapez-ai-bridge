const b=require('./graph3.cjs');
const {at,S,inn,out,byUid,obj,tunnelPairs,rotLocal,DIRV,cellOwner}=b;
const NM={1:'belt',2:'bL',3:'bR',4:'bal',7:'MINER',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'HUB'};
const nm=u=>{const e=byUid.get(u);const s=S(e);return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y;};
function upTree(startUid,depth){
  const seen=new Set([startUid]);const q=[[startUid,0]];const srcs=[];const branches=[];
  while(q.length){
    const [u,d]=q.shift();
    const e=byUid.get(u);const s=S(e);
    if(e.components.Miner){srcs.push(nm(u));continue;}
    if(s.code>3&&s.code!==22&&s.code!==23&&s.code!==24&&s.code!==25){srcs.push(nm(u));continue;}
    const ups=[...(inn.get(u)||[])];
    if(ups.length===0){srcs.push('(open end) '+nm(u));continue;}
    for(const p of ups)if(!seen.has(p)){seen.add(p);q.push([p,d+1]);}
  }
  return {srcs,n:seen.size};
}
console.log('=== colour input of painter @96,-135 (belt @97,-136) ===');
console.log(JSON.stringify(upTree(at.get('97,-136').uid),null,1));
console.log('\n=== shape input of painter @96,-135 (belt @96,-134) ===');
console.log(JSON.stringify(upTree(at.get('96,-134').uid),null,1));
console.log('\n=== cyan mixer @132,-137 inputs ===');
for(const k of ['132,-138','131,-138']){
  const e=at.get(k);
  console.log(' ',k,JSON.stringify(upTree(e.uid)));
}
