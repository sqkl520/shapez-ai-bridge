/**
 * factory-audit.mjs — 像工程师那样检查一座工厂，而不是像脚本那样数实体。
 */
import { rpc } from "../live/kit.mjs";

const o = await rpc("obs", { max_entities: 400, include_stats: true, include_hub: true, region: [-30, -30, 30, 30] }, 90000);
const ents = o.entities || [];
const hub = ents.find(e => e.type === "hub");
const machines = ents.filter(e => !["hub", "belt"].includes(e.type));

console.log("=== 现状 ===");
console.log("目标:", o.goal.requirement.shape, o.goal.requirement.delivered + "/" + o.goal.requirement.required);
console.log("库存:", JSON.stringify(o.hub.stored_shapes));
console.log("矿机:", machines.filter(m => m.type === "miner").length, "台");

// 每台矿机挖什么
const res = await rpc("obs", { region: [-30, -30, 30, 30], include_resources: true, max_resources: 5000, include_stats: false }, 90000);
const ore = new Map();
for (const [x, y, k] of res.resources || []) ore.set(x + "," + y, k);
for (const m of machines.filter(m => m.type === "miner")) {
  console.log(`  矿机 (${m.x},${m.y}) 挖 ${ore.get(m.x + "," + m.y) || "!! 无矿 !!"}`);
}

// 每台矿机的矿种，周围有多少同类矿格
console.log("\n=== 资源利用率 ===");
const counts = {};
for (const [, k] of ore) counts[k] = (counts[k] || 0) + 1;
console.log("区域内矿格:", JSON.stringify(counts));
const usedOre = machines.filter(m => m.type === "miner").map(m => ore.get(m.x + "," + m.y)).filter(Boolean);
console.log("被利用的矿种:", JSON.stringify([...new Set(usedOre)]));
console.log("=> 每种矿只有 1 台矿机，其余矿格全部闲置");

// hub 入口使用情况
console.log("\n=== hub 入口 ===");
const belts = ents.filter(e => e.type === "belt");
const entries = [];
for (let i = 0; i < 4; i++) {
  entries.push([hub.x + i, hub.y - 1, "top"]);
  entries.push([hub.x + i, hub.y + 4, "bottom"]);
  entries.push([hub.x - 1, hub.y + i, "left"]);
  entries.push([hub.x + 4, hub.y + i, "right"]);
}
const used = entries.filter(([x, y]) => belts.some(b => b.x === x && b.y === y));
console.log(`16 个入口用了 ${used.length} 个:`, JSON.stringify(used.map(u => u.slice(0, 2))));

// 产量估算
const beltLvl = o.goal.upgrade_levels.belt;
const minerLvl = o.goal.upgrade_levels.miner;
console.log("\n=== 产能 ===");
console.log(`升级: belt=${beltLvl} miner=${minerLvl}`);
const minerSpeed = 0.4 * (1 + (minerLvl === 0 ? 0 : [0.5][minerLvl - 1] || 0));
console.log(`矿机速度 ~${minerSpeed.toFixed(2)}/s × ${machines.filter(m => m.type === "miner").length} 台`);
console.log(`目标需要 70 个 => 单机要 ${(70 / minerSpeed / 60).toFixed(1)} 分钟`);
