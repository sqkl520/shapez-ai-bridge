const b=require('./graph3.cjs');
const {obj,ents,belts,machines,at,cellOwner,S,beltOut,inn,out,byUid,tunnelPairs,rotLocal,DIRV,tunnelPairs:tp}=b;
const BP=obj.dump.beltPaths;
const carry=new Map();
for(const p of BP){const sh={};for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}for(const uid of p.entityPath){if(!carry.has(uid))carry.set(uid,{});const t=carry.get(uid);for(const k in sh)t[k]=(t[k]||0)+sh[k];}}
const HUBACC=[[0,0,'top'],[1,0,'top'],[2,0,'top'],[3,0,'top'],[0,3,'bottom'],[1,3,'bottom'],[2,3,'bottom'],[3,3,'bottom'],[0,0,'left'],[0,1,'left'],[0,2,'left'],[0,3,'left'],[3,0,'right'],[3,1,'right'],[3,2,'right'],[3,3,'right']];
const OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
const hub=ents.find(e=>S(e).code===26).uid;
function upstreamShapes(uid){
  const shapes={};const seen=new Set();const q=[uid];let nodes=0;
  while(q.length&&seen.size<6000){const u=q.shift();if(seen.has(u))continue;seen.add(u);nodes++;
    const c=carry.get(u);if(c)for(const k in c)shapes[k]=(shapes[k]||0)+c[k];
    for(const p of (inn.get(u)||[]))q.push(p);}
  return {shapes,nodes};
}
console.log('HUB 16 entries (origin-anchored geometry):');
let used=0;
for(const [tx,ty,dir] of HUBACC){
  const wx=-2+tx, wy=-2+ty, dv=DIRV[dir];
  const nx=wx+dv[0], ny=wy+dv[1];
  const uid=cellOwner.get(nx+','+ny);
  let info='EMPTY';
  if(uid!=null){
    const e=byUid.get(uid); const s=S(e);
    if(s.code<=3&&beltOut(e)===OPP[dir]){used++;const u=upstreamShapes(e.uid);const top=Object.entries(u.shapes).sort((a,b)=>b[1]-a[1]).slice(0,3);info='belt@'+nx+','+ny+' items='+JSON.stringify(top)+' nodes='+u.nodes;}
    else info='non-feeding code'+s.code+'@'+nx+','+ny;
  }
  console.log(('  hub('+tx+','+ty+') '+dir).padEnd(20)+' <- '+info);
}
console.log('USED',used,'/ 16');
// hub upstream composition
const rev=new Set([hub]),st=[hub];while(st.length){const n=st.pop();for(const p of (inn.get(n)||[]))if(!rev.has(p)){rev.add(p);st.push(p);}}
const NM={4:'balancer',7:'miner',9:'cutter',11:'rotater',12:'rotater',13:'rotater',15:'mixer',16:'painter',17:'painter',20:'trash',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'hub'};
const cnt={};for(const u of rev){const e=byUid.get(u);const c=S(e).code;const k=c<=3?'belt':(NM[c]||('c'+c));cnt[k]=(cnt[k]||0)+1;}
console.log('\nhub-feeding subgraph ('+rev.size+' entities):',JSON.stringify(cnt));
