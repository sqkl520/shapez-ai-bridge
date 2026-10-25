const b=require('./graph3.cjs');
const {at,S,machines}=b;
const ORDER=['top','right','bottom','left'];
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EX={0:'top',1:'left',2:'right'};
const AR={top:'^',right:'>',bottom:'v',left:'<'};
const NM={4:'B',7:'M',9:'C',10:'Q',11:'R',12:'R',13:'R',15:'X',16:'P',17:'p',20:'T',22:'u',23:'U',24:'u',25:'U',26:'H'};
function g(e){const s=S(e);if(s.code<=3){if(s.code===1)return AR[rotLocal(EX[0],s.rotation)];return s.code===2?'/':'\\';}return NM[s.code]||'#';}
const a=process.argv.slice(2).map(Number);
const [x0,x1,y0,y1]=a;
console.log('     '+Array.from({length:x1-x0+1},(_,i)=>String(((x0+i)%10+10)%10)).join(''));
for(let y=y0;y<=y1;y++){let r=String(y).padStart(4)+' ';for(let x=x0;x<=x1;x++){const e=at.get(x+','+y);r+=e?g(e):'.';}console.log(r);}
