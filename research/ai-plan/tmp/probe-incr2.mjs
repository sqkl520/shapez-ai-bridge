import { place } from "../../../src/ai/compiler/place.mjs";
const steps = [{ id: "m0", op: "mine", args: {}, inputs: [], hash: "CuCuCuCu" }];
const base = { steps, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, seed: 43391, range: 96 };
const cases = {
  "无既有实体": [{ type: "hub", x: 0, y: 0 }],
  "堵住默认矿位(-6,6)": [{ type: "hub", x: 0, y: 0 }, { type: "cutter", x: -6, y: 6 }],
  "堵住整个 x=-6..6 行": [{ type: "hub", x: 0, y: 0 },
    ...Array.from({ length: 13 }, (_, i) => ({ type: "belt", x: -6 + i, y: 5 })),
    ...Array.from({ length: 13 }, (_, i) => ({ type: "belt", x: -6 + i, y: 6 })),
    ...Array.from({ length: 13 }, (_, i) => ({ type: "belt", x: -6 + i, y: 7 }))],
};
for (const [name, entities] of Object.entries(cases)) {
  const rep = place({ ...base, world: { entities } });
  const pl = (rep.placements || []).map(p => `${p.nodeId}@${p.cell}`);
  console.log(name.padEnd(22), rep.ok === false ? "FAIL " + rep.reason : "ok", pl.join(" "),
    "| occupancy", (rep.occupancy || []).length, "| belts", (rep.beltCells || []).length);
}
