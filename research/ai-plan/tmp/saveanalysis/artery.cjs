const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,cellOwner,inn,out}=b;
const BP=obj.dump.beltPaths;
// find the longest path in beltPaths and print its full geometry, with machines at both ends
const longest=[...BP].sort((a,b)=>b.entityPath.length-a.entityPath.length)[0];
const coords=longest.entityPath.map(u=>{const s=S(byUid.get(u));return [s.origin.x,s.origin.y,s.code,s.rotation];});
console.log('longest beltPath: '+coords.length+' belts, items='+longest.items.length);
console.log('first',coords[0],'last',coords[coords.length-1]);
// print segments as direction runs
const runs=[];let prev=null;
for(let i=1;i<coords.length;i++){const dx=coords[i][0]-coords[i-1][0],dy=coords[i][1]-coords[i-1][1];const d=dx>0?'E':dx<0?'W':dy>0?'S':dy<0?'N':'?';if(!prev||prev.d!==d){prev={d,n:0,from:coords[i-1],to:null};runs.push(prev);}prev.n++;prev.to=coords[i];}
console.log('geometry runs:');
for(const r of runs)console.log('  '+r.d+' ×'+r.n+'  from ('+r.from[0]+','+r.from[1]+') to ('+r.to[0]+','+r.to[1]+')');
// upstream source machine and downstream sink
const src=[...(inn.get(longest.entityPath[0])||[])];
const snk=[...(out.get(longest.entityPath[longest.entityPath.length-1])||[])];
const NM={4:'bal',7:'miner',9:'cut',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'HUB'};
console.log('upstream of path start:',src.map(u=>{const s=S(byUid.get(u));return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y;}));
console.log('downstream of path end:',snk.map(u=>{const s=S(byUid.get(u));return (NM[s.code]||('c'+s.code))+'@'+s.origin.x+','+s.origin.y;}));
// shape composition
const sh={};for(const pair of longest.items){const it=pair[1];if(it&&it.$==='shape')sh[it.data]=(sh[it.data]||0)+1;}
console.log('items by shape:',JSON.stringify(sh));
// density
console.log('items/tile',(longest.items.length/coords.length).toFixed(3));
