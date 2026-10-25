const b=require('./graph3.cjs');
const {at,S,cells,out,inn,byUid,machines,obj}=b;
const NM={1:'belt',2:'bL',3:'bR',4:'bal',7:'miner',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'hub'};
console.log('--- cutter/trash pairs ---');
for(const c of [ [13,17],[16,17],[19,17],[22,17],[2,14],[5,14] ]){
  const e=at.get(c[0]+','+c[1]); if(!e)continue;
  const s=S(e);
  console.log(' cutter@'+c+' rot'+s.rotation,'outs:',[...(out.get(e.uid)||[])].map(u=>{const q=S(byUid.get(u));return NM[q.code]+'@'+q.origin.x+','+q.origin.y;}));
}
console.log('\n--- trash machines ---');
for(const t of machines.filter(e=>S(e).code===20)){
  const s=S(t);
  console.log(' trash@'+s.origin.x+','+s.origin.y,'in:',[...(inn.get(t.uid)||[])].map(u=>{const q=S(byUid.get(u));return NM[q.code]+'@'+q.origin.x+','+q.origin.y;}));
}
console.log('\n--- pyramid merge rows (Su) ---');
for(let y=-159;y<=-154;y++){
  const row=[];
  for(let x=158;x<=176;x++){const e=at.get(x+','+y);if(e&&S(e).code===4)row.push(x);}
  console.log('  y='+y+' balancers x='+row.join(','));
}
console.log('\n--- tunnel examples crossing a perpendicular lane ---');
const tp=b.tunnelPairs.slice(0,6);
for(const p of tp){
  const s=S(byUid.get(p.sender)),r=S(byUid.get(p.receiver));
  console.log('  sender@'+s.origin.x+','+s.origin.y+' rot'+s.rotation+' -> receiver@'+r.origin.x+','+r.origin.y+' dist'+p.dist+' dir'+p.dir);
}
console.log('\n--- recent player edits (uid>=20000) by machine type ---');
const recent=machines.filter(e=>e.uid>=20000);
const h={};for(const e of recent){h[NM[S(e).code]||S(e).code]=(h[NM[S(e).code]||S(e).code]||0)+1;}
console.log(JSON.stringify(h));
for(const e of recent){const s=S(e);if(S(e).code!==4&&S(e).code!==7)console.log('  '+(NM[s.code]||s.code)+'@'+s.origin.x+','+s.origin.y+' uid'+e.uid);}
console.log('\n--- dead-end belt uid ---');
const de=at.get('47,-143');
console.log('  belt@47,-143 uid',de.uid,de.uid>=20000?'(recent)':'(older)');
