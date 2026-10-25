const m=require('./net2.cjs');
const {ents,at,S,footprint}=m;
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EXIT_LOCAL={0:'top',1:'left',2:'right'};
const ARROW={top:'^',right:'>',bottom:'v',left:'<'};
const CURVE={1:'/',2:'\\'};
const G={4:'B',5:'m',6:'n',7:'M',8:'m',9:'C',10:'Q',11:'R',12:'R',13:'R',14:'S',15:'X',16:'P',17:'p',18:'P',19:'P',20:'T',21:'O',22:'u',23:'U',24:'u',25:'U',26:'H'};
function glyph(e){const s=S(e);if(s.code<=3){const o=rotLocal(EXIT_LOCAL[s.code-1],s.rotation);return s.code===1?ARROW[o]:CURVE[s.code-1];}return G[s.code]||'#';}
function render(x0,x1,y0,y1,title){
  console.log('');
  console.log('=== '+(title||'')+'  x['+x0+'..'+x1+'] y['+y0+'..'+y1+'] ===');
  let hdr='     ';for(let x=x0;x<=x1;x++)hdr+=String((x%10+10)%10);
  console.log(hdr);
  for(let y=y0;y<=y1;y++){
    let row=String(y).padStart(4)+' ';
    for(let x=x0;x<=x1;x++){
      const e=at.get(x+','+y);
      row+= e? glyph(e) : '.';
    }
    console.log(row);
  }
}
module.exports={render,glyph};
if(require.main===module){
  const a=process.argv.slice(2).map(Number);
  render(a[0],a[1],a[2],a[3],process.argv[6]||'');
}
