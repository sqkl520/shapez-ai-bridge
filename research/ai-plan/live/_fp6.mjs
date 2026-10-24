import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
// 真实工厂样本（P7-F2 同拓扑）: corner r90 rv2 orig180，左邻 r90 rv0（朝右喷）
// 已知：computeBelt({rotation:180, neighbors:[X]}) 必须 == {rotation:90, rotationVariant:2}
// 求 X：
for (const td of ["top","right","bottom","left"]) {
  const r = computeBelt({ rotation: 180, neighbors: [{ toDirection: td }] });
  console.log(`toDirection=${td.padEnd(6)} →`, JSON.stringify(r), (r.rotation===90&&r.rotationVariant===2)?"✅ 这就是正确编码":"");
}
console.log("\n--- 同一编码下，找能停在 (r0,rv2) 的 orig ---");
const correct = "left";
for (const orig of [0,90,180,270]) {
  const r = computeBelt({ rotation: orig, neighbors: [{ toDirection: correct }] });
  console.log(`orig=${String(orig).padStart(3)} →`, JSON.stringify(r), (r.rotation===0&&r.rotationVariant===2)?"✅":"");
}
