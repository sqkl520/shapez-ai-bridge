const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid,at}=m;
const {out,inn}=g;
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const beltOut=e=>{const s=S(e);return rotLocal(['top','left','right'][s.code-1],s.rotation);};
function lab(uid){const e=byUid.get(uid);const s=S(e);if(s.code<=3)return 'belt';if(e.components.Miner)return 'MINER';if(s.code>=22&&s.code<=25)return 'tunnel'+(s.code);return {4:'balancer',5:'merger',9:'cutter',10:'cutterquad',11:'rotater',12:'rotCCW',13:'rot180',15:'mixer',16:'painter',17:'painterM',18:'painter2',19:'painter4',20:'trash',21:'storage',26:'HUB'}[s.code]||('code'+s.code);}
// walk upstream from belt -2,-3, collapsing
function upWalk(uid,label){
  const path=[]; let cur=uid; const seen=new Set();
  while(cur&&!seen.has(cur)){
    seen.add(cur); path.push(cur);
    const ups=[...(inn.get(cur)||[])];
    if(ups.length!==1) { path.push({branch:ups.length}); break; }
    cur=ups[0];
  }
  // compress
  const segs=[]; let run=null;
  for(const u of path){ if(typeof u==='object'){segs.push({kind:'BRANCH×'+u.branch});break;} const k=lab(u); if(!run||run.kind!==k){run={kind:k,n:0,at:S(byUid.get(u)).origin};segs.push(run);} run.n++; }
  console.log('\n'+label);
  console.log('  '+segs.map(s=>s.kind+(s.n?'×'+s.n:'')).join(' -> '));
  const first=path[0], lastSeg=segs[segs.length-1];
  console.log('  start '+S(byUid.get(first)).origin.x+','+S(byUid.get(first)).origin.y+'  endSeg@'+(lastSeg.at?lastSeg.at.x+','+lastSeg.at.y:'?'));
}
const hub=ents.find(e=>S(e).code===26).uid;
// For each immediate hub predecessor
for(const uid of (inn.get(hub)||[])){
  const s=S(byUid.get(uid));
  upWalk(uid,'HUB feed via '+lab(uid)+'@'+s.origin.x+','+s.origin.y);
}
