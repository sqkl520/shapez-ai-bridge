import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
// 目标格：corner rot=0 rv=2（入 bottom 出 right）。这是 M4 实机建出来并跑通的形态。
// 环境（真实）：
//   下游 (右边一格) 是一条朝右(r=90)的带子 —— 它是 acceptor，fromDirection = 它面向的方向。
//   上游 (下边一格) 是一条朝上(r=0)的带子 —— 它是 ejector，toDirection = 'top'（朝上喷进本格）。
// 试正确的两类邻居表达：
const cases = {
  "只有上游 ejector(toDirection=top)": [{ toDirection: "top" }],
  "只有下游 acceptor(fromDirection=right)": [{ fromDirection: "right" }],
  "上游 ejector + 下游 acceptor(fromDirection=right)": [{ toDirection: "top" }, { fromDirection: "right" }],
  "上游 ejector(toDirection=top) + 下游 acceptor(fromDirection=left)": [{ toDirection: "top" }, { fromDirection: "left" }],
};
for (const [label, ns] of Object.entries(cases)) {
  console.log(`\n${label}:`);
  for (const orig of [0,90,180,270]) {
    const r = computeBelt({ rotation: orig, neighbors: ns });
    console.log(`  orig=${String(orig).padStart(3)} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅":"");
  }
}
