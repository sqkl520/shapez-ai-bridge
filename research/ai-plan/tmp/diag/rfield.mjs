/* 复现 cli.mjs 的映射，看 r / rotation_variant 是否被丢弃 */
const raw = [{ uid:1, type:"cutter", x:-8, y:-11, r:0, rotation_variant:0 },
             { uid:2, type:"balancer", x:8, y:-9, r:0 },
             { uid:3, type:"belt", x:1, y:-3, r:180 }];
const mapped = raw.filter(e => e && typeof e.type === "string" && Number.isFinite(e.x) && Number.isFinite(e.y))
  .map(e => ({ type: e.type, x: e.x, y: e.y }));
console.log("cli.mjs:130-132 产出:", JSON.stringify(mapped));
console.log("含 r 字段?", mapped.some(o => "r" in o));
