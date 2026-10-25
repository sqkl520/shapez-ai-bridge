import { rpc, act } from "../live/kit.mjs";

// 用游戏内状态判断哪台矿机在产出：读 ItemEjector 的 slot.progress
// 桥接没暴露这个，所以用间接法：每次只留一条线，测产量。
const shape = "RuRuRuRu";

async function measure(label) {
  const a = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
  const s0 = (a.hub.stored_shapes || {})[shape] || 0;
  await act({ op: "step", ticks: 1800 });
  const b = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
  const s1 = (b.hub.stored_shapes || {})[shape] || 0;
  const rate = (s1 - s0) / 30;
  console.log(`${label.padEnd(28)} +${s1 - s0}  ${rate.toFixed(3)}/s`);
  return rate;
}

console.log("=== 两条线都在 ===");
await measure("两条线");

console.log("\n=== 拆掉矿机(2,-6) 那条 ===");
// 只删矿机 (2,-6) 和它的第一格带子
const d1 = await rpc("act", { op: "bulk_delete", region: [2, -6, 2, -6], dry_run: false }, 60000);
console.log("删了", d1.applied);
await measure("只剩 (3,-5)");

console.log("\n=== 恢复：拆掉矿机(3,-5) 那条，放回 (2,-6) ===");
// 这里不恢复了，留待人工决定
