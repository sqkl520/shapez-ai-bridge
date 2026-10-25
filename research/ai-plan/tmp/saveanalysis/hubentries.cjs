const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid,at,obj}=m;
const {out,inn}=g;
const bp=obj.dump.beltPaths;
// uid -> shapes carried across paths
const carry=new Map();
for(const p of bp){
  const sh={};
  for(const pair of p.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}
  for(const uid of p.entityPath){
    if(!carry.has(uid))carry.set(uid,{});
    const t=carry.get(uid); for(const k in sh)t[k]=(t[k]||0)+sh[k];
  }
}
const HUBACC=[[0,0,'top'],[1,0,'top'],[2,0,'top'],[3,0,'top'],[0,3,'bottom'],[1,3,'bottom'],[2,3,'bottom'],[3,3,'bottom'],[0,0,'left'],[0,1,'left'],[0,2,'left'],[0,3,'left'],[3,0,'right'],[3,1,'right'],[3,2,'right'],[3,3,'right']];
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const beltOut=e=>{const s=S(e);return rotLocal(['top','left','right'][s.code-1],s.rotation);};
function upstreamShapes(startUid){
  const shapes={}; const seen=new Set(); const q=[startUid]; const visited=[];
  while(q.length&&seen.size<4000){
    const u=q.shift(); if(seen.has(u))continue; seen.add(u); visited.push(u);
    const c=carry.get(u); if(c)for(const k in c)shapes[k]=(shapes[k]||0)+c[k];
    for(const p of (inn.get(u)||[]))q.push(p);
  }
  return {shapes,visited};
}
console.log('HUB 16 entries:');
let used=0;
for(const [tx,ty,dir] of HUBACC){
  const wx=-2+tx, wy=-2+ty, dv=DIRV[dir], nx=wx+dv[0], ny=wy+dv[1];
  const e=at.get(nx+','+ny);
  let info='EMPTY';
  if(e){
    const s=S(e);
    const ok=s.code<=3 && beltOut(e)===OPP[dir];
    if(ok){
      used++;
      const {shapes,visited}=upstreamShapes(e.uid);
      const top=Object.entries(shapes).sort((a,b)=>b[1]-a[1]).slice(0,4);
      info='FEED by belt@'+nx+','+ny+'  upstream items='+JSON.stringify(top)+'  upstreamNodes='+visited.length;
    } else info='blocked/other code'+s.code;
  }
  console.log(('  tile('+tx+','+ty+') '+dir).padEnd(22)+' <- '+info);
}
console.log('USED',used,'/16');
