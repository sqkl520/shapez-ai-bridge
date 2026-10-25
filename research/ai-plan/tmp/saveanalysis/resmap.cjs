const m=require('./net2.cjs');
const {at,S}=m;
const w=require('../../../../src/ai/world.mjs');
const seed=43391;
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EXIT_LOCAL={0:'top',1:'left',2:'right'};
const ARROW={top:'^',right:'>',bottom:'v',left:'<'};
const G={4:'B',5:'m',6:'n',7:'M',8:'m',9:'C',10:'Q',11:'R',12:'R',13:'R',14:'S',15:'X',16:'P',17:'p',18:'P',19:'P',20:'T',21:'O',22:'u',23:'U',24:'u',25:'U',26:'H'};
const RC={red:'r',green:'g',blue:'b',purple:'p',cyan:'c',CuCuCuCu:'C',RuRuRuRu:'R',SuSuSuSu:'S',CrCrCrCr:'K',CpCpCpCp:'P',CgCgCgCg:'G',RbRbRbRb:'B',ScScScSc:'N'};
function glyph(e){const s=S(e);if(s.code<=3)return s.code===1?ARROW[rotLocal(EXIT_LOCAL[0],s.rotation)]:(s.code===2?'/':'\\');return G[s.code]||'#';}
function render(x0,x1,y0,y1,title,withRes){
  console.log('');
  console.log('=== '+(title||'')+'  x['+x0+'..'+x1+'] y['+y0+'..'+y1+'] ===');
  let hdr='     ';for(let x=x0;x<=x1;x++)hdr+=String((x%10+10)%10);
  console.log(hdr);
  for(let y=y0;y<=y1;y++){
    let row=String(y).padStart(4)+' ';
    for(let x=x0;x<=x1;x++){
      const e=at.get(x+','+y);
      if(e){row+=glyph(e);continue;}
      if(withRes){const r=w.tileResource(seed,x,y);row+= r?(RC[r]||r[0].toLowerCase()):'.';}
      else row+='.';
    }
    console.log(row);
  }
}
const a=process.argv.slice(2);
render(+a[0],+a[1],+a[2],+a[3],a[4]||'',a[5]==='res');
