const b=require('./graph3.cjs');
const {ents,machines,belts,S,byUid,at,cellOwner,ejectors,acceptors,DIRV,beltOut,beltIn}=b;
const OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
const key=(x,y)=>x+','+y;
// Does the entity at (x,y) push into cell (tx,ty) with dir d?
function pushesInto(x,y,tx,ty){
  const uid=cellOwner.get(key(x,y)); if(uid==null) return false;
  const e=byUid.get(uid); const s=S(e);
  const [dx,dy]=[tx-x,ty-y];
  const dir=dx>0?'right':dx<0?'left':dy>0?'bottom':'top';
  if(s.code<=3) return beltOut(e)===dir;
  for(const ej of ejectors(e)) if(ej.x===x&&ej.y===y&&ej.dir===dir) return true;
  // ejector from another cell of a multi-cell machine
  for(const ej of ejectors(e)){ if(ej.dir===dir && ej.x+DIRV[dir][0]===tx && ej.y+DIRV[dir][1]===ty) return true; }
  return false;
}
function acceptsFrom(x,y,fx,fy){
  const uid=cellOwner.get(key(x,y)); if(uid==null) return false;
  const e=byUid.get(uid); const s=S(e);
  const [dx,dy]=[fx-x,fy-y];
  const dir=dx>0?'right':dx<0?'left':dy>0?'bottom':'top';
  if(s.code<=3) return beltIn(e)===dir;
  for(const a of acceptors(e)) if(a.x===x&&a.y===y&&a.dir===dir) return true;
  return false;
}
const stats={'2in1out':0,'1in2out':0,'2in2out':0,'1in1out':0,'0in':0,'0out':0,'other':0};
const examples={};
for(const e of machines){
  const s=S(e);
  if(s.code!==4) continue;
  const acc=acceptors(e), ej=ejectors(e);
  let nin=0,nout=0; const ins=[],outs=[];
  for(const a of acc){
    const [dx,dy]=DIRV[a.dir]; // entity is on the opposite side: a position + dir means item comes FROM dir
    const sx=a.x+dx, sy=a.y+dy;
    if(pushesInto(sx,sy,a.x,a.y)){nin++;ins.push([sx,sy]);}
  }
  for(const o of ej){
    const [dx,dy]=DIRV[o.dir];
    const tx=o.x+dx, ty=o.y+dy;
    if(acceptsFrom(tx,ty,o.x,o.y)){nout++;outs.push([tx,ty]);}
  }
  const k=nin+'in'+nout+'out';
  if(stats[k]===undefined)stats[k]=0;
  stats[k]++;
  if(!examples[k])examples[k]=[[s.origin.x,s.origin.y]];
}
console.log('balancer (code 4) port usage:');
for(const k of Object.keys(stats).sort((a,b)=>stats[b]-stats[a]))console.log('  '+k.padEnd(8)+stats[k]+'   e.g. '+JSON.stringify(examples[k]||[]));
// also counts for painter/mixer
for(const code of [15,16,17]){
  let n=0,full=0,partial=0;
  for(const e of machines){
    if(S(e).code!==code)continue;n++;
    const acc=acceptors(e);let nin=0;
    for(const a of acc){const [dx,dy]=DIRV[a.dir];if(pushesInto(a.x+dx,a.y+dy,a.x,a.y))nin++;}
    if(nin===acc.length)full++;else if(nin>0)partial++;
  }
  console.log('code'+code+': total '+n+' fully-fed '+full+' partially '+partial);
}
