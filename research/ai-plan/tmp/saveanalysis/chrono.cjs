const b=require('./graph3.cjs');
const {ents,machines,belts,S,at,byUid}=b;
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
// uid -> build time proxy
const zones={
 'A early hub cell (x-10..30,y-12..20)':[-10,30,-12,20],
 'B Ru factory (x0..66,y-14..4)':[0,66,-14,4],
 'C blue zigzag (x45..62,y-2..14)':[45,62,-2,14],
 'D mixer lab (x0..38,y38..76)':[0,38,38,76],
 'E Cu vertical+red west (x-30..20,y76..128)':[-30,20,76,128],
 'F star/cyan mega (x84..175,y-162..-128)':[84,175,-162,-128],
 'G Cu 4-row wall (x92..125,y-146..-128)':[92,125,-146,-128],
 'H Cu S-block (x96..112,y-192..-172)':[96,112,-192,-172],
 'I green east (x200..236,y-146..-130)':[200,236,-146,-130],
 'J corridor east (x126..218,y-148..-128)':[126,218,-148,-128],
};
const rows=[];
for(const [n,[x0,x1,y0,y1]] of Object.entries(zones)){
  const es=ents.filter(e=>{const s=S(e);return s.origin.x>=x0&&s.origin.x<=x1&&s.origin.y>=y0&&s.origin.y<=y1;});
  if(!es.length)continue;
  const uids=es.map(e=>e.uid).sort((a,b)=>a-b);
  rows.push({n,n:es.length,min:uids[0],max:uids[uids.length-1],med:uids[Math.floor(uids.length/2)]});
}
rows.sort((a,b)=>a.med-b.med);
console.log('zone chronology by median uid (uid increases with build order):');
for(const r of rows)console.log('  uid '+String(r.min).padStart(6)+'..'+String(r.max).padStart(6)+'  med '+String(r.med).padStart(6)+'  n='+String(r.n).padStart(4)+'  '+r.n2||'');
for(const r of rows)console.log('  '+r.n+'  min='+r.min+' med='+r.med+' max='+r.max);
