const b=require('./graph3.cjs');
const {machines,belts,S,byUid,at,cellOwner,acceptors,ejectors,inn,out,DIRV}=b;
const NM={1:'belt',2:'beltL',3:'beltR',4:'bal',7:'miner',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'hub'};
const nm=u=>{const e=(u&&typeof u==='object')?u:byUid.get(u);const s=S(e);return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y+(s.code<=3?'r'+s.rotation:'');};
function show(x,y){
  const e=at.get(x+','+y); if(!e){console.log('nothing at',x,y);return;}
  const s=S(e);
  console.log('\n### '+nm(e)+'  (uid '+e.uid+')');
  const acc=acceptors(e);
  for(const a of acc){
    const [dx,dy]=DIRV[a.dir];
    const src=cellOwner.get((a.x-dx)+','+(a.y-dy));
    console.log('  acceptor @'+a.x+','+a.y+' from '+a.dir+'  <- '+(src!=null?nm(src):'EMPTY'));
  }
  const ej=ejectors(e);
  for(const o of ej){
    const [dx,dy]=DIRV[o.dir];
    const t=cellOwner.get((o.x+dx)+','+(o.y+dy));
    console.log('  ejector  @'+o.x+','+o.y+' toward '+o.dir+' -> '+(t!=null?nm(t):'EMPTY'));
  }
}
show(94,-135);   // painter in the 15-wide wall
show(96,-135);
show(-1,79);     // painter in folded column
show(-8,107);    // mixer column
show(48,-2);     // painter row near Ru factory
show(162,-154);  // pyramid base balancer
show(93,-137);   // ladder balancer feeding painters
show(95,-132);
