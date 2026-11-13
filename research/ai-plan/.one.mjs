import fs from "fs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { entryDirOf } from "../../src/agent/loop/topology.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const b307 = atM.get("39,-11");
const m3 = atM.get("39,-12");
console.log("B307 entryDir =", entryDirOf(b307));
const s = slotsOf(m3.type, m3.variant, m3.x, m3.y, m3.r || 0, beltRvOf(m3));
console.log("M3 outputs =", JSON.stringify(s.outputs));
const hit = s.outputs.find(o => o.cell[0] === 39 && o.cell[1] === -11 && o.dir === entryDirOf(b307));
console.log("match =", JSON.stringify(hit));
// ore?
const ore = new Map((obs.resources || []).map(r => [r[0] + "," + r[1], r[2]]));
console.log("ore under M3 =", ore.get("39,-12"));
// template op
const { templateByBuildingVariant } = await import("../../src/ai/op-templates.mjs");
const t = templateByBuildingVariant(m3.type, m3.variant || "default");
console.log("M3 tpl.op =", t && t.op);
