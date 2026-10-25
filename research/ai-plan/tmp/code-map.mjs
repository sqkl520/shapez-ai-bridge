import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { decodeSave } = require("../../../recon/decode_full.cjs");
const f = path.join(process.env.APPDATA, "shapez.io", "saves", "savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin");
const { obj } = decodeSave(f);
const ents = obj.dump.entities;

// code 4 的实体长什么样
const c4 = ents.filter(e => e.components?.StaticMapEntity?.code === 4);
console.log("code 4 数量:", c4.length);
console.log("样例:", JSON.stringify(c4[0], null, 1).slice(0, 600));
console.log("\n组件类型:", [...new Set(c4.map(e => Object.keys(e.components).join("+")))]);
