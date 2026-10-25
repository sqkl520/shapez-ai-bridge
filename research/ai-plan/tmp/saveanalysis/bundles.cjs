const b=require('./graph3.cjs');
const {belts,S,at,cellOwner,byUid,machines}=b;
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90|0);return ORDER[(ORDER.indexOf(d)+steps)%4];};
const ARROW={top:'N',right:'E',bottom:'S',left:'W'};
const beltDir=e=>{const s=S(e);if(s.code!==1)return null;return ARROW[rotLocal('top',s.rotation)];};
// find horizontal bundles: straight belts going E or W forming consecutive columns on adjacent rows
const grid=new Map();
for(const bl of belts){const s=S(bl);grid.set(s.origin.x+','+s.origin.y,{dir:beltDir(bl),code:s.code});}
function runsInRow(y,dir){const xs=[];for(const [k,v] of grid){const [x,yy]=k.split(',').map(Number);if(yy===y&&v.dir===dir)xs.push(x);}xs.sort((a,b)=>a-b);const runs=[];let st=null,prev=null;for(const x of xs){if(prev===null||x-prev!==1){if(st!==null)runs.push([st,prev]);st=x;}prev=x;}if(st!==null)runs.push([st,prev]);return runs;}
// bundles: rows y where runs align in x-range, for E and W separately
const rowsE=new Map(), rowsW=new Map(), colsN=new Map(), colsS=new Map();
for(const [k,v] of grid){const [x,y]=k.split(',').map(Number);if(v.dir==='E'){if(!rowsE.has(y))rowsE.set(y,[]);rowsE.get(y).push(x);}if(v.dir==='W'){if(!rowsW.has(y))rowsW.set(y,[]);rowsW.get(y).push(x);}if(v.dir==='N'){if(!colsN.has(x))colsN.set(x,[]);colsN.get(x).push(y);}if(v.dir==='S'){if(!colsS.has(x))colsS.set(x,[]);colsS.get(x).push(y);}}
function bundleReport(map,axis,name){
  const rows=[...map.keys()].sort((a,b)=>a-b);
  const groups=[];
  let cur=[];
  for(const r of rows){
    const xs=map.get(r).sort((a,b)=>a-b);
    // longest consecutive run
    let best=[],run=[xs[0]];
    for(let i=1;i<xs.length;i++){if(xs[i]-xs[i-1]===1)run.push(xs[i]);else{if(run.length>best.length)best=run;run=[xs[i]];}}
    if(run.length>best.length)best=run;
    if(best.length>=3){
      if(cur.length&&r-cur[cur.length-1].r===1&&Math.abs(best[0]-cur[0].x0)<=2){cur.push({r,x0:best[0],x1:best[best.length-1],len:best.length});}
      else{if(cur.length>=2)groups.push(cur);cur=[{r,x0:best[0],x1:best[best.length-1],len:best.length}];}
    } else {if(cur.length>=2)groups.push(cur);cur=[];}
  }
  if(cur.length>=2)groups.push(cur);
  console.log('\n'+name+' bundles (>=2 adjacent parallel lanes, each >=3 long):');
  for(const g of groups){
    console.log('  lanes='+g.length+' axis '+g[0].r+'..'+g[g.length-1].r+'  span '+g[0].x0+'..'+g[0].x1+' (lane len ~'+g[0].len+')');
  }
  console.log('  total bundles '+groups.length+', lanes '+groups.reduce((a,g)=>a+g.length,0));
}
bundleReport(rowsE,'row','E-going');
bundleReport(rowsW,'row','W-going');
bundleReport(colsN,'col','N-going');
bundleReport(colsS,'col','S-going');
