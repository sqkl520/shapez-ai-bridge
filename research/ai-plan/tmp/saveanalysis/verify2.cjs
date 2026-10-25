const b=require('./graph3.cjs');
const {obj,machines,at,cellOwner,byUid,S,acceptors,DIRV}=b;
const BP=obj.dump.beltPaths;
// For each path, its last belt should be accepted by some machine (unless it dead-ends)
let agree=0,disagree=0,dead=0;const bad=[];
for(const p of BP){
  const lastUid=p.entityPath[p.entityPath.length-1];
  const last=byUid.get(lastUid);
  if(!last)continue;
  const s=S(last);
  // where does it point? use successor graph
  const succ=[...(b.out.get(lastUid)||[])];
  if(!succ.length){dead++;continue;}
  const targetUid=succ[0];
  const target=byUid.get(targetUid);
  const ts=S(target);
  if(ts.code<=3){continue;} // belt-to-belt
  // does target have an acceptor facing the belt?
  const ok=acceptors(target).some(a=>{
    const [dx,dy]=DIRV[a.dir];
    return (a.x+dx)+','+(a.y+dy)===(s.origin.x+','+s.origin.y);
  });
  if(ok)agree++;else{disagree++;if(bad.length<6)bad.push({belt:s.origin,code:s.code,rot:s.rotation,target:ts.origin,tcode:ts.code,trot:ts.rotation});}
}
console.log('path-end belt -> machine acceptor check: agree',agree,'disagree',disagree,'dead-end',dead);
console.log(JSON.stringify(bad,null,1));
