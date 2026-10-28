import { place } from "../../../src/ai/compiler/place.mjs";
const hub = { x: 0, y: 0 };
// 旧厂：hub 右侧一条既有带子 + 两台旧机器，模拟"真实存档已有建筑"
const world = {
  entities: [
    { type: "hub", x: 0, y: 0 },
    { type: "belt", x: 12, y: 6 },
    { type: "cutter", x: 14, y: 8 },
    { type: "belt", x: 15, y: 6 },
  ],
};
const steps = [{ id: "m0", op: "mine", args: {}, inputs: [], hash: "CuCuCuCu" }];
try {
  const rep = place({ steps, site: hub, hub, world, seed: 43391, range: 96 });
  console.log("ok=", rep.ok, rep.ok === false ? rep.reason : "");
  if (rep.ok !== false) {
    console.log("placements=", JSON.stringify((rep.placements || []).map(p => [p.nodeId, p.kind, p.cell])));
    console.log("occupancy=", (rep.occupancy || []).length);
    console.log("beltCells=", (rep.beltCells || []).length);
  }
} catch (e) { console.log("threw:", e.message); }
