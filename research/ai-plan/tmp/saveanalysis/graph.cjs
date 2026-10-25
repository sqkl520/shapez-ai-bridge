const m=require('./net.cjs');
const {belts,at,S,beltOut,beltIn,DIRV,OPP,machines,ejectors,acceptors,footprint}=m;
const key=(x,y)=>x+','+y;
// Build directed successor for belts: next cell in exit dir
const succ=new Map(), pred=new Map();
for(const b of belts){
  const s=S(b); const d=beltOut(b); const [dx,dy]=DIRV[d];
  const nx=s.origin.x+dx, ny=s.origin.y+dy;
  succ.set(b.uid,{x:nx,y:ny,ent:at.get(key(nx,ny))||null});
}
// Build machine ejector -> target
const ejectMap=new Map(); // uid -> [{x,y,target}]
for(const e of machines){
  const list=ejectors(e).map(o=>{const [dx,dy]=DIRV[o.dir];const nx=o.x+dx,ny=o.y+dy;return {x:nx,y:ny,target:at.get(key(nx,ny))||null,from:{x:o.x,y:o.y,dir:o.dir}};});
  ejectMap.set(e.uid,list);
}
// machine acceptor lookup: cell -> machine uid list with dir
const accCells=new Map();
for(const e of machines){
  for(const a of acceptors(e)){
    const [dx,dy]=DIRV[a.dir];
    const srcCell=key(a.x-dx,a.y-dy); // the cell feeding into this acceptor
    if(!accCells.has(srcCell)) accCells.set(srcCell,[]);
    accCells.get(srcCell).push({uid:e.uid,dir:a.dir,cell:key(a.x,a.y)});
  }
}
// classify each belt: is it "delivering" into machine acceptor? (i.e., next cell machine and its acceptor dir matches approach)
function beltDeliversTo(b){
  const s=succ.get(b.uid); if(!s||!s.ent) return null;
  const t=S(s.ent);
  if(t.code<=3) return null;
  // check acceptors of target machine facing this approach
  const out=accCells.get(key(s.ent.components.StaticMapEntity.origin.x,s.ent.components.StaticMapEntity.origin.y))||[];
  // more robust: check all acceptors of target for the cell we're entering
  return {uid:s.ent.uid,code:t.code};
}
// source: belt whose predecessor is machine ejector or nothing
const srcByBelt=new Map(); // belt uid -> machine uid
for(const [uid,list] of ejectMap){
  for(const o of list){
    if(o.target && S(o.target).code<=3) srcByBelt.set(o.target.uid,uid);
  }
}
// Undirected components over belts + through machines? First just belts
const parent=new Map();
const find=x=>{if(!parent.has(x))parent.set(x,x);let r=x;while(parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
for(const b of belts){find(b.uid); const s=succ.get(b.uid); if(s&&s.ent&&S(s.ent).code<=3) uni(b.uid,s.ent.uid);}
const comps=new Map();
for(const b of belts){const r=find(b.uid); if(!comps.has(r))comps.set(r,[]); comps.get(r).push(b);}
const compList=[...comps.values()].sort((a,b)=>b.length-a.length);
console.log('belt components:',compList.length);
console.log('sizes:',JSON.stringify(compList.map(c=>c.length)));
function bbox(list){const xs=list.map(b=>S(b).origin.x),ys=list.map(b=>S(b).origin.y);return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};}
compList.slice(0,40).forEach((c,i)=>{
  const bb=bbox(c);
  const srcs=new Set(), dsts=new Set();
  for(const b of c){ if(srcByBelt.has(b.uid)) srcs.add(srcByBelt.get(b.uid)); const d=beltDeliversTo(b); if(d) dsts.add(d.code+'@'+d.uid); }
  console.log('#'+(i+1),'belts='+c.length,'bbox x['+bb.minX+'..'+bb.maxX+'] y['+bb.minY+'..'+bb.maxY+']','sources='+srcs.size,'sinks='+dsts.size+' '+JSON.stringify([...dsts].slice(0,6)));
});
console.log('total components size sum',compList.reduce((a,c)=>a+c.length,0));
module.exports={succ,pred,srcByBelt,accCells,compList,bbox,find};
