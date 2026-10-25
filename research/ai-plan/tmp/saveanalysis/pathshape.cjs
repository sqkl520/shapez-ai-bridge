const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,cellOwner}=b;
const BP=obj.dump.beltPaths;
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',9:'cut',10:'cutQ',11:'rot',12:'rotCCW',13:'rot180',15:'mix',16:'paint',17:'paintM',18:'paintD',19:'paintQ',20:'trash',21:'stor',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'HUB'};
const name=e=>{const s=S(e);return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y;};
// Classify paths
const stats={};
const serp=[];
for(const p of BP){
  const seq=p.entityPath.map(u=>{const s=S(byUid.get(u));return [s.origin.x,s.origin.y];});
  // direction sequence
  const dirs=[];
  for(let i=1;i<seq.length;i++){const dx=seq[i][0]-seq[i-1][0],dy=seq[i][1]-seq[i-1][1];dirs.push(dx>0?'E':dx<0?'W':dy>0?'S':'N');}
  // compression
  const runs=[];for(const d of dirs){if(!runs.length||runs[runs.length-1][0]!==d)runs.push([d,1]);else runs[runs.length-1][1]++;}
  const nRuns=runs.length;
  const len=seq.length;
  const kinds=new Set(dirs);
  // serpentine: many reversals between E/W or N/S
  let rev=0;for(let i=1;i<dirs.length;i++){if((dirs[i]==='E'&&dirs[i-1]==='W')||(dirs[i]==='W'&&dirs[i-1]==='E')||(dirs[i]==='N'&&dirs[i-1]==='S')||(dirs[i]==='S'&&dirs[i-1]==='N'))rev++;}
  let key;
  if(len>=20&&rev>=6)key='serpentine';
  else if(len>=20&&rev<=2)key='straightish';
  else if(len>=20)key='mixed';
  else key='short';
  stats[key]=(stats[key]||0)+1;
  if(key==='serpentine')serp.push({len,rev,runs:runs.length,start:seq[0],end:seq[seq.length-1],items:p.items.length});
}
console.log('paths',BP.length,JSON.stringify(stats));
serp.sort((a,b)=>b.len-a.len);
console.log('serpentine paths (len>=20, >=6 reversals):',serp.length);
for(const s of serp.slice(0,25))console.log('  len='+s.len+' rev='+s.rev+' runs='+s.runs+' items='+s.items+' '+s.start+' -> '+s.end);
// per path endpoints
const ends={};
for(const p of BP){
  const first=byUid.get(p.entityPath[0]);
  const prevCell=null;
}
// Count belts per path seq length distribution
const L=BP.map(p=>p.entityPath.length);
console.log('\npath length histogram:',JSON.stringify({len1:L.filter(x=>x===1).length,'2-5':L.filter(x=>x>=2&&x<=5).length,'6-20':L.filter(x=>x>5&&x<=20).length,'21-60':L.filter(x=>x>20&&x<=60).length,'>60':L.filter(x=>x>60).length}));
