const b=require('./graph3.cjs');
const {ents,machines,S}=b;
const zones={
 'early hub cell':[-10,30,-12,20],
 'Ru factory':[0,66,-14,4],
 'blue zigzag':[45,62,-2,14],
 'mixer lab':[0,38,38,76],
 'Cu vertical + red west':[-30,20,76,128],
 'star/cyan mega':[84,175,-162,-128],
 'Cu 4-row + painter wall':[92,125,-146,-128],
 'Cu S-block':[96,112,-192,-172],
 'green east':[200,236,-146,-130],
 'corridor east':[126,218,-148,-128],
};
const out=[];
for(const [n,[x0,x1,y0,y1]] of Object.entries(zones)){
  const es=ents.filter(e=>{const s=S(e);return s.origin.x>=x0&&s.origin.x<=x1&&s.origin.y>=y0&&s.origin.y<=y1;});
  if(!es.length)continue;
  const u=es.map(e=>e.uid).sort((a,b)=>a-b);
  out.push({name:n,n:es.length,min:u[0],p25:u[Math.floor(u.length*0.25)],med:u[Math.floor(u.length/2)],max:u[u.length-1]});
}
out.sort((a,b)=>a.med-b.med);
console.log('zone              entities   uid min    p25    median    p75     max');
for(const z of out){
  console.log(z.name.padEnd(26)+String(z.n).padStart(5)+String(z.min).padStart(9)+String(z.p25).padStart(7)+String(z.med).padStart(8)+String(z.max).padStart(8));
}
console.log('\nuid span overall',Math.min(...ents.map(e=>e.uid)),'-',Math.max(...ents.map(e=>e.uid)));
// count entities per 1000-uid bucket to see build campaigns
const h={};for(const e of ents){const k=Math.floor(e.uid/1000)*1000;h[k]=(h[k]||0)+1;}
console.log('\nbuild campaigns (entities per 1000 uids):');
for(const k of Object.keys(h).map(Number).sort((a,b)=>a-b))console.log('  '+k+'-'+(k+999)+': '+h[k]);
