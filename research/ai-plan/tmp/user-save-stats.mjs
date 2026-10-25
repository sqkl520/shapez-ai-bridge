import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeSave } = require("../../../recon/decode_full.cjs");
const path = "C:\Users\Administrator\AppData\Roaming\shapez.io\saves\savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin";

const { obj } = decodeSave(path);
const d = obj.dump;
const ents = Object.values(d.entityMgr.entities || {});
console.log("实体总数:", ents.length);
console.log("hubGoals:", JSON.stringify({ level: d.hubGoals.level, upgradeLevels: d.hubGoals.upgradeLevels, upgradeImprovements: d.hubGoals.upgradeImprovements }));
console.log("storedShapes 种类:", Object.keys(d.hubGoals.storedShapes || {}).length);

// 按 code 统计
const byCode = {};
for (const e of ents) {
  const code = e.components?.StaticMapEntity?.code ?? "?";
  byCode[code] = (byCode[code] || 0) + 1;
}
// building_codes: 1-3 belt, 7 miner, 9 cutter?, 11?, 22/23 tunnel, 26 hub
const NAMES = { 1: "belt-straight", 2: "belt-left", 3: "belt-right", 7: "miner", 8: "miner-chainable",
  9: "cutter", 10: "cutter-quad", 11: "rotater", 12: "rotater-ccw", 13: "rotater-180",
  14: "stacker", 15: "mixer", 16: "painter", 17: "painter-double", 18: "painter-quad",
  20: "trash", 22: "tunnel-in", 23: "tunnel-out", 26: "hub" };
console.log("\n建筑构成:");
for (const [c, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
  console.log(" ", (NAMES[c] || "code" + c).padEnd(16), n);
}

// 矿机按资源
const miners = ents.filter(e => [7, 8].includes(e.components?.StaticMapEntity?.code));
console.log("\n矿机:", miners.length, "台  (chainable:", miners.filter(m => m.components?.Miner?.chainable).length, ")");
const positions = miners.map(m => {
  const o = m.components.StaticMapEntity.origin;
  return [o.x, o.y];
});
console.log("矿机坐标:", JSON.stringify(positions.slice(0, 30)));
