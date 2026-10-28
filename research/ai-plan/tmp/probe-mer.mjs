import fs from "node:fs";
const raw = JSON.parse(fs.readFileSync("research/ai-player/facts/live/world-full.json", "utf8"));
const ents = raw.entities || raw;
// 每实体按其 footprint 铺格（近似：belt/miner 1x1，hub 4x4，cutter 2x1）
const FP = { hub: [4,4], cutter: [2,1], rotater: [1,1], painter: [2,1], mixer: [1,1], balancer: [2,1], trash: [1,1], miner: [1,1], belt: [1,1], underground_belt: [1,1] };
const occ = new Set();
let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
for (const e of ents) {
  const [w,h] = FP[e.type] || [1,1];
  for (let dy=0;dy<h;dy++) for (let dx=0;dx<w;dx++) occ.add(`${e.x+dx},${e.y+dy}`);
  minX=Math.min(minX,e.x); maxX=Math.max(maxX,e.x+w-1);
  minY=Math.min(minY,e.y); maxY=Math.max(maxY,e.y+h-1);
}
console.log("entities", ents.length, "occupied cells", occ.size, "bbox", [minX,minY,maxX,maxY], "area", (maxX-minX+1)*(maxY-minY+1));
// 朴素最大空矩形（直方图法），在 bbox 外扩 40 格上跑
const PAD=40, W=maxX-minX+1+2*PAD, H=maxY-minY+1+2*PAD;
const t0=Date.now();
let heights=new Int32Array(W);
let best={area:0,x:0,y:0,w:0,h:0};
const grid=[];
for (let yy=0; yy<H; yy++) {
  const row=new Uint8Array(W);
  const wy=minY-PAD+yy;
  for (let xx=0; xx<W; xx++) row[xx]= occ.has(`${minX-PAD+xx},${wy}`) ? 0 : 1;
  grid.push(row);
}
// 逐行直方图 + 单调栈，求每个单元格为底的最大矩形
for (let yy=0; yy<H; yy++) {
  for (let xx=0; xx<W; xx++) heights[xx] = grid[yy][xx] ? heights[xx]+1 : 0;
  const stack=[];
  for (let xx=0; xx<=W; xx++) {
    const h = xx===W?0:heights[xx];
    while (stack.length && heights[stack[stack.length-1]] >= h) {
      const i=stack.pop(); const left=stack.length?stack[stack.length-1]+1:0;
      const hh=heights[i], ww=xx-left, area=hh*ww;
      if (area>best.area) best={area,x:left,y:yy-hh+1,w:ww,h:hh};
    }
    stack.push(xx);
  }
}
const dt=Date.now()-t0;
console.log("MER", best, "in", dt, "ms", "→ world", [minX-PAD+best.x, minY-PAD+best.y]);
// 找"面积够放下一条 Cu------ 产线（约 7x28 + 光晕）"的最大几个
