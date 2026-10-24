import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
const OPP = { top:"bottom", bottom:"top", left:"right", right:"left" };
// 编译器的拐角：in=bottom out=right → (r0,rv2)，设计邻居集意=上游 ejector(top) + 下游 acceptor(from=left)
const declared = [{ toDirection:"top" }, { fromDirection: OPP["right"] }];
console.log("设计邻居集下的不动点检查（orig=0）:");
console.log("  ", JSON.stringify(computeBelt({ rotation: 0, neighbors: declared })), "→ 期望 {r:0,rv:2}");
// 加上"左邻朝右喷"（合成扰动）后：
const perturbed = [...declared, { toDirection: "right" }];
console.log("\n加上左邻 ejector(right) 之后（orig=0）:");
console.log("  ", JSON.stringify(computeBelt({ rotation: 0, neighbors: perturbed })));
console.log("  → 这就是 P7-F2 的翻向：**布局没声明的邻居**改变了重算结果");
console.log("\n结论：o 守护的是『声明的邻居拓扑』下的稳定性；");
console.log("     用户/其他 agent 事后在拐角旁乱贴一格，任何 orig 都救不了 —— 这属于 C2 的『整块贴完不旁补』纪律。");
