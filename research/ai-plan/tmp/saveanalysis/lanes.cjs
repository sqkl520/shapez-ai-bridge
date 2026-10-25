const b=require('./graph3.cjs');
const {obj,at,S,byUid,beltOut}=b;
const BP=obj.dump.beltPaths;
// uid -> dominant item
const dom=new Map();
for(const p of BP){
  if(!p.items.length)continue;
  const c={};
  for(const pair of p.items){const it=pair[1];const k=it?(it.$==='shape'?it.data:(it.$==='color'?'col:'+it.data:'?')):'?';c[k]=(c[k]||0)+1;}
  const top=Object.entries(c).sort((a,b)=>b[1]-a[1])[0][0];
  for(const u of p.entityPath)dom.set(u,top);
}
// corridor rows
console.log('Corridor lane inventory x[95..220] y[-146..-127]:');
for(let y=-146;y<=-127;y++){
  const cells=[];
  for(let x=95;x<=220;x++){const e=at.get(x+','+y);if(e){const s=S(e);if(s.code<=3)cells.push(x);}}
  if(!cells.length)continue;
  // runs
  const runs=[];let st=cells[0],prev=cells[0];
  for(const x of cells.slice(1)){if(x-prev>1){runs.push([st,prev]);st=x;}prev=x;}
  runs.push([st,prev]);
  const desc=runs.map(([a,z])=>{
    const mid=at.get(Math.floor((a+z)/2)+','+y);
    const d=dom.get(mid.uid)||'-';
    return a+'..'+z+'('+(z-a+1)+' '+(mid.components?S(mid).code:'?')+' '+d+')';
  });
  console.log('  y='+y+'  '+desc.join(' | '));
}
