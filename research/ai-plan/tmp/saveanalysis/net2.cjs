const m=require('./net.cjs');
const {ents,belts,machines,at,S,DIRV,OPP,rotLocal,footprint,ejectors,acceptors,spec}=m;
const key=(x,y)=>x+','+y;
const cellOwner=new Map();
for(const e of ents){const s=S(e);const fp=footprint(e);for(let y=fp.y;y<fp.y+fp.h;y++)for(let x=fp.x;x<fp.x+fp.w;x++)cellOwner.set(key(x,y),{uid:e.uid,code:s.code});}
const byUid=new Map(ents.map(e=>[e.uid,e]));
// tunnels
const senders=ents.filter(e=>S(e).code===22||S(e).code===24);
const receivers=ents.filter(e=>S(e).code===23||S(e).code===25);
const tunnelPairs=[]; // {sender, receiver, dist, dir}
for(const s of senders){
  const ss=S(s); const travel=rotLocal('top',ss.rotation); const dv=DIRV[travel];
  const maxR=(ss.code===22)?5:9;
  for(let d=1;d<=maxR;d++){
    const x=ss.origin.x+dv[0]*d, y=ss.origin.y+dv[1]*d;
    const o=at.get(key(x,y));
    if(o&&(S(o).code===23||S(o).code===25)) { tunnelPairs.push({sender:s.uid,receiver:o.uid,dist:d,dir:travel,from:[ss.origin.x,ss.origin.y],to:[x,y]}); break; }
  }
}
module.exports={...m,cellOwner,byUid,tunnelPairs,senders,receivers};
if(require.main===module){
  console.log('senders',senders.length,'receivers',receivers.length,'paired',tunnelPairs.length);
  const dist={}; for(const p of tunnelPairs)dist[p.dist]=(dist[p.dist]||0)+1;
  console.log('dist hist',JSON.stringify(dist));
  const unpairedS=senders.filter(s=>!tunnelPairs.find(p=>p.sender===s.uid));
  const unpairedR=receivers.filter(r=>!tunnelPairs.find(p=>p.receiver===r.uid));
  console.log('unpaired senders',unpairedS.length,'unpaired receivers',unpairedR.length);
  // verify receiver eject dir continues same dir
  let ok=0,bad=0;
  for(const p of tunnelPairs){
    const r=byUid.get(p.receiver);const rs=S(r);
    const ejDir=rotLocal('top',rs.rotation);
    if(ejDir===p.dir)ok++;else bad++;
  }
  console.log('receiver same-dir',ok,'diff',bad);
}
