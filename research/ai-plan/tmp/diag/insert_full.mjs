/* 最省事的半手工方案：在现有钌线的"向上段"里插一台切割机，把整块切成两半：
     左半块 ----RuRu → 继续沿原路进 hub（成为目标 RuRu----？需确认哪半是目标）
     右半块 RuRu---- → 侧向接 trash
   本脚本只核对几何与实体增量，不做速率/语义断言。 */
import fs from "node:fs";
const es = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const at=(x,y)=>es.find(e=>e.x===x&&e.y===y);
// 选 x=4 列：y=-15..-9 都是 r=0 向上，且 (3,*) / (5,*) 也是带子（可侧接）
console.log("x=4 列现状:");
for(let y=-16;y<=-8;y++){const e=at(4,y);console.log("  (4,"+y+")",e?e.type+" r"+e.r:"空");}
console.log("\n若把切割机放在 (4,-12)（占 (4,-12)(5,-12)）:");
for(const [x,y,note] of [[4,-11,"输入槽（需是带子 r=0，向上喂）"],[4,-13,"左半输出槽"],[5,-13,"右半输出槽"],[5,-12,"切割机右格(被占)"],[3,-12,"西侧一格"],[6,-12,"东侧一格"]]){
  const e=at(x,y);
  console.log(`  (${x},${y}) ${note}: ${e?e.type+" r"+e.r:"空"}`);
}
