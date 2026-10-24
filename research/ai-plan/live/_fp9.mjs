import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
const OPP = { top:"bottom", bottom:"top", left:"right", right:"left" };
// 复刻 P7 的真实环境：只有 3 格（上游带 + 拐角），**下游缺失**。
// 拐角 in=bottom out=right，但右边没有 acceptor。
const lone = [{ toDirection: "top" }];          // 只有上游喷入
console.log("【P7 的粘贴后状态】只有上游，无下游 acceptor:");
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: lone });
  console.log(`  orig=${String(orig).padStart(3)} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅ 停在目标":"");
}
console.log("\n【P7 加上左侧 ejector 后】:");
const pulled = [{ toDirection:"top" }, { toDirection:"right" }];
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: pulled });
  console.log(`  orig=${String(orig).padStart(3)} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅":"");
}
console.log("\n【编译器产物：下游 acceptor 存在】:");
const full = [{ toDirection:"top" }, { fromDirection: OPP["right"] }];
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: full });
  console.log(`  orig=${String(orig).padStart(3)} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅ 稳":"");
}
