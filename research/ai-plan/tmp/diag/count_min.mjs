import fs0 from "node:fs";
const fs=fs0;
/* 半手工方案量级估算：
   走"新矿机 -> 向上 -> 切割机(r=0) -> 右半进 hub，左半进 trash"的直串结构。
   基于 T11（--miners 4 成功）的真实布局，逐项计数。 */
const p=JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/T11.json","utf8"));
const kinds={};
for(const e of p.entities) kinds[e.kind]=(kinds[e.kind]||0)+1;
console.log("T11 实体构成:",JSON.stringify(kinds),"总计",p.entities.length);
console.log("stats:",JSON.stringify(p.stats));
console.log("---");
// 单矿机、单切割机的最小直串结构（RATES: miner 0.4/s, belt 2/s）
// 目标 70 个 RuRu----；每关需求 through requirement.required
const req=70, miner=0.4, belt=2.0;
console.log(`单矿机 ${miner}/s：${req} 个需 ${(req/miner).toFixed(0)} 秒；带子 ${belt}/s 不瓶颈`);
console.log(`若想 5 秒内交付 70 个，需 ${Math.ceil((req/5)/miner)} 台矿机`);
console.log(`矿机 x 方向并排 N 台需 balancer 树 ${Math.max(0,Math.ceil((Math.log2(Math.max(1,1)))))} 层（N=1 时 0）`);
// 手工线的固定开销：从 T11 里扣掉矿机与 balancer
const fixed = p.entities.length - (kinds.miner||0) - (kinds.balancer||0);
console.log(`T11 中"非矿机非 balancer"的固定开销 = ${fixed} 实体（含 ${kinds.cutter} 切割机 / ${kinds.trash} trash / ${kinds.belt} 带子）`);
