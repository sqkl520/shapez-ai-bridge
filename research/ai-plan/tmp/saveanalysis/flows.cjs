const m=require('./net2.cjs');
const {obj,ents,byUid,S,at}=m;
const bp=obj.dump.beltPaths;
function loc(uid){const e=byUid.get(uid);if(!e)return 'missing:'+uid;const s=S(e);return (s.code<=3?'belt':({4:'bal',9:'cut',15:'mix',16:'paint',17:'paint',11:'rot',20:'trash',22:'tun',23:'tun',26:'HUB'}[s.code]||'c'+s.code))+'@'+s.origin.x+','+s.origin.y;}
function itemKey(it){ if(!it) return 'null'; if(it.$==='shape') return it.data; if(it.$==='color') return 'color:'+it.data; return 'other:'+it.$; }
const rows=[];
for(const p of bp){
  if(!p.items.length)continue;
  const shapes={};
  for(const pair of p.items){const it=pair[1];const k=itemKey(it);shapes[k]=(shapes[k]||0)+1;}
  const top=Object.entries(shapes).sort((a,b)=>b[1]-a[1]);
  rows.push({n:p.entityPath.length,first:p.entityPath[0],last:p.entityPath[p.entityPath.length-1],shapes:top,items:p.items.length});
}
console.log('paths with items',rows.length);
const byShape={};
for(const r of rows)for(const [s,c] of r.shapes)byShape[s]=(byShape[s]||0)+c;
console.log('items by kind:',JSON.stringify(Object.entries(byShape).sort((a,b)=>b[1]-a[1]).slice(0,22)));
rows.sort((a,b)=>b.items-a.items);
console.log('\nTop 20 paths:');
for(const r of rows.slice(0,20)) console.log(r.items+' items len'+r.n+' '+loc(r.first)+' -> '+loc(r.last)+' shapes='+JSON.stringify(r.shapes.slice(0,3)));
