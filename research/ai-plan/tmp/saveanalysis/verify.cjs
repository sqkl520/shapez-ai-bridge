const b=require('./graph3.cjs');
const {obj,S,byUid,at}=b;
const BP=obj.dump.beltPaths;
const ORDER=['top','right','bottom','left'];
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EX={0:'top',1:'left',2:'right'};
function pred(code,rot){return rotLocal(EX[code-1],rot);}
// For every consecutive pair in paths that are both belts and orthogonally adjacent, check predicted exit
let ok=0,bad=0;const badSamples={};
for(const p of BP){
  for(let i=0;i<p.entityPath.length-1;i++){
    const a=byUid.get(p.entityPath[i]), c=byUid.get(p.entityPath[i+1]);
    if(!a||!c)continue;
    const sa=S(a), sc=S(c);
    if(sa.code>3||sc.code>3)continue;
    const dx=sc.origin.x-sa.origin.x, dy=sc.origin.y-sa.origin.y;
    if(Math.abs(dx)+Math.abs(dy)!==1){continue;}
    const dir=dx>0?'right':dx<0?'left':dy>0?'bottom':'top';
    const pr=pred(sa.code,sa.rotation);
    if(pr===dir)ok++; else {bad++;const k='code'+sa.code+' rot'+sa.rotation+' pred'+pr+' actual'+dir;badSamples[k]=(badSamples[k]||0)+1;}
  }
}
console.log('consecutive belt-belt transitions: ok',ok,'bad',bad);
console.log('bad samples',JSON.stringify(badSamples,null,1).slice(0,1500));
// Also validate the direction of a belt feeding a machine: machine acceptor cell
