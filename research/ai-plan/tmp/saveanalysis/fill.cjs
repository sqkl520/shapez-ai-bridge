const b=require('./graph3.cjs');
const {ents,machines,belts,S,cellOwner}=b;
const zones={
 'early hub factory':[-10,30,-12,20],
 'Ru factory':[0,66,-14,4],
 'blue zigzag':[45,62,-2,14],
 'mixer lab (closed)':[0,38,38,76],
 'Cu vertical painters (west)':[-12,20,76,105],
 'red + mixers west':[-30,0,104,128],
 'Cu mixing node (8,100)':[4,13,96,106],
 'Cu S-block (closed)':[96,112,-192,-172],
 'star/cyan mega factory':[84,175,-162,-128],
 'Cu painter+wall':[92,125,-146,-128],
 'mixer row':[124,156,-140,-132],
 'green east (closed)':[203,236,-148,-130],
 'Su pyramid':[155,180,-162,-147],
};
console.log('factory bbox fill (occupied cells / bbox area):');
for(const [n,[x0,x1,y0,y1]] of Object.entries(zones)){
  let occ=0;
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)if(cellOwner.has(x+','+y))occ++;
  const area=(x1-x0+1)*(y1-y0+1);
  console.log('  '+n.padEnd(30)+(x1-x0+1)+'x'+(y1-y0+1)+'  occ='+String(occ).padStart(4)+'  fill='+(100*occ/area).toFixed(1)+'%');
}
// bbox of each flow-component
const parent=new Map();
const find=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const uni=(a,c)=>{a=find(a);c=find(c);if(a!==c)parent.set(a,c);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of b.out)for(const c of set)uni(a,c);
const comps=new Map();
for(const e of ents){const r=find(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
console.log('\nflow components and bbox fill:');
for(const c of [...comps.values()].sort((a,b)=>b.length-a.length)){
  if(c.length<8)continue;
  const xs=c.map(e=>S(e).origin.x),ys=c.map(e=>S(e).origin.y);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  let occ=0;for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)if(cellOwner.has(x+','+y))occ++;
  const area=(x1-x0+1)*(y1-y0+1);
  console.log('  n='+String(c.length).padStart(5)+'  bbox '+(x1-x0+1)+'x'+(y1-y0+1)+'  fill='+(100*occ/area).toFixed(1)+'%');
}
// detour metric over long paths
const BP=b.obj.dump.beltPaths;
let act=0,man=0;
for(const p of BP){
  if(p.entityPath.length<10)continue;
  const a=S(b.byUid.get(p.entityPath[0])),z=S(b.byUid.get(p.entityPath[p.entityPath.length-1]));
  act+=p.entityPath.length;man+=Math.abs(a.origin.x-z.origin.x)+Math.abs(a.origin.y-z.origin.y);
}
console.log('\nlong paths (>=10 belts): total belts '+act+' vs manhattan '+man+' = detour factor '+(act/man).toFixed(3));
