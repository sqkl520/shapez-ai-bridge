import fs from "node:fs";
const es = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const at = (x,y) => es.find(e=>e.x===x&&e.y===y);
console.log("=== 现有钌线向上段（r=0，流向 y 减小）===");
for (let x=2;x<=5;x++){
  const ys=[];
  for(let y=-16;y<=-9;y++){const e=at(x,y); if(e&&e.type==="belt"&&e.r===0) ys.push(y);}
  console.log(` x=${x} 向上带子 y=${ys.length?Math.min(...ys)+".."+Math.max(...ys):"无"} (${ys.length} 格)`);
}
console.log("\n=== 候选插入点：切割机放 (2,-12) [占 2,-12 与 3,-12] ===");
for (const [x,y,role] of [[2,-11,"输入槽"],[2,-13,"左半输出"],[3,-13,"右半输出"],[3,-14,"trash 候选"]]) {
  const e=at(x,y);
  console.log(`  (${x},${y}) ${role}:`, e?`${e.type} r=${e.r} uid=${e.uid}`:"空");
}
console.log("\n=== hub 目前收到的钌是什么 ===");
console.log("  obs.goal.requirement:", JSON.stringify({shape:"RuRu----", required:70, delivered:0}));
console.log("  hub.stored_shapes: RuRuRuRu=112481 → 旧线交的是整块，不算目标");
