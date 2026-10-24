import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
const OPP = { top: "bottom", bottom: "top", left: "right", right: "left" };
// 编译器产出的那个拐角：r0 rv2（入 bottom、出 right），inDir=bottom outDir=right
const inDir = "bottom", outDir = "right";
const ns = [
  { toDirection: OPP[inDir] === "top" ? "bottom" : OPP[inDir] },   // 上游喷入本格
  { toDirection: outDir },                                          // 下游槽朝本格
];
console.log("邻居集:", JSON.stringify(ns));
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: ns });
  console.log(`orig=${orig} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅ 命中":"");
}
// 关键：扰动后的真实环境（左邻朝右喷）下，什么 orig 能停在 (0,2)？
console.log("\n扰动环境（左邻 toDirection=right）：");
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: [{toDirection:"right"}] });
  console.log(`orig=${orig} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅":"");
}
