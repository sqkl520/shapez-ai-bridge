const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid,at,obj}=m;
const {out,inn}=g;
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
const NM={4:'B',5:'m',6:'n',7:'M',9:'C',11:'R',12:'r',13:'r',15:'X',16:'P',17:'p',20:'T',22:'u',23:'U',26:'H'};
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const ARROW={top:'^',right:'>',bottom:'v',left:'<'};
function ch(e){const s=S(e);if(s.code<=3)return s.code===1?ARROW[rotLocal('top',s.rotation)]:(s.code===2?'/':'\\');return NM[s.code]||'#';}
function local(cx,cy,r,title){
  console.log('\n### '+title);
  let hdr='       ';for(let x=cx-r;x<=cx+r;x++)hdr+=String((x%10+10)%10);
  console.log(hdr);
  for(let y=cy-r;y<=cy+r;y++){
    let row=String(y).padStart(5)+'  ';
    for(let x=cx-r;x<=cx+r;x++){const e=at.get(x+','+y);row+= e?ch(e):'.';}
    console.log(row);
  }
  // print miners and their resource
  const ms=machines.filter(e=>e.components.Miner&&Math.abs(S(e).origin.x-cx)<=r&&Math.abs(S(e).origin.y-cy)<=r);
  console.log('   miners: '+ms.map(e=>{const s=S(e);return '('+s.origin.x+','+s.origin.y+')rot'+s.rotation+' '+w.tileResource(seed,s.origin.x,s.origin.y);}).join('  '));
  // print each miner's downstream targets
  for(const e of ms){const s=S(e);const o=[...(out.get(e.uid)||[])];console.log('   M('+s.origin.x+','+s.origin.y+') -> '+o.map(u=>{const t=byUid.get(u);return NM[S(t).code]+'@'+S(t).origin.x+','+S(t).origin.y;}).join(','));}
}
local(104,-184,9,'copper S-block 19 miners');
local(166,-153,9,'star miners 12 -> pyramid');
local(213,-139,8,'green miners 13');
local(228,-138,8,'green miners 13 (east)');
local(55,5,9,'blue miners 10 -> zigzag');
local(8,103,8,'copper miners 12 (double column)');
local(25,102,8,'copper miners 9');
