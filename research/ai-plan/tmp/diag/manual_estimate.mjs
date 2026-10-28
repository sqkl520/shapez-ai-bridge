/* 半手工方案量级估算：基于 T_block3m 的真实成功蓝图（最简单可用形态） */
import fs from "node:fs";
const p = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/T_block3m.json","utf8"));
const a = p.site.anchor;
const k = {};
for (const e of p.entities) k[e.kind] = (k[e.kind]||0)+1;
console.log("T_block3m（单矿机+单切割机+trash，已贴进真实存档且不压旧实体）");
console.log("  实体构成:", JSON.stringify(k), "总计", p.entities.length);
console.log("  机器世界坐标:");
for (const e of p.entities) if (["miner","cutter","trash","balancer"].includes(e.kind))
  console.log("   ", e.kind, (a[0]+e.dx)+","+(a[1]+e.dy));
console.log("  hub 入口:", JSON.stringify(p.layout.hubConnection));
console.log("  吞吐:", p.stats.estThroughputPerSec, "/s  bottleneck:", p.stats.bottleneck);
console.log("  需求:", 70, "个 => 单矿机需", (70/0.4).toFixed(0), "秒");
console.log();
console.log("--- 若要提速到 ~5 秒（14/s）---");
console.log("  矿机 0.4/s =>", Math.ceil(14/0.4), "台 → 但存档里 Ru 矿格总共只有 22 格");
console.log("  按 --miners 4 实测（52 实体），5 台 ≈ 60 实体，且要求 5 格相邻 Ru");
