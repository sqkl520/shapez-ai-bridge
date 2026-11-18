/* Read-only: probe whether the repeated connect has ANY working port combination. */
import fs from "node:fs";
import { connect } from "./src/agent/macros/connect.mjs";

const raw = JSON.parse(fs.readFileSync(".tmp-critic-obs.json", "utf8"));
const obs = raw.result || raw;
const ctx = { entities: obs.entities };

function tryC(from, to, opts = {}) {
  let r;
  try { r = connect({ from, to, opts: { dry_run: true, ...opts } }, ctx); }
  catch (e) { return { code: "THREW", msg: String(e && e.message || e).slice(0, 120) }; }
  if (r.ok) return { ok: true, cells: Array.isArray(r.cells) ? r.cells.length : r.pathLen, warnings: (r.warnings || []).map(w => w.code || w) };
  return { code: r.error && r.error.code, field: r.error && r.error.field, msg: String(r.error && r.error.message || "").slice(0, 140) };
}

const C1 = 16598, B41 = 17258, C4 = 17294, B106 = 17369, B114 = 17377;

console.log("### C1 -> B41, all port combos (no opts)");
for (const role of ["left", "right"]) {
  const r = tryC({ uid: C1, port: { role, index: 0 } }, { uid: B41 });
  console.log(`  from ${role}#0 :`, JSON.stringify(r));
}
console.log("\n### C1 -> B41 with rebind on each from-port");
for (const role of ["left", "right"]) {
  const r = tryC({ uid: C1, port: { role, index: 0 } }, { uid: B41 }, { rebind: true });
  console.log(`  from ${role}#0 rebind :`, JSON.stringify(r));
}
console.log("\n### C1 -> B41 with allow_replace");
for (const role of ["left", "right"]) {
  const r = tryC({ uid: C1, port: { role, index: 0 } }, { uid: B41 }, { allow_replace: true });
  console.log(`  from ${role}#0 allow_replace :`, JSON.stringify(r));
}

console.log("\n### C4 -> B114 all from-ports");
for (const role of ["left", "right", "top", "bottom"]) {
  const r = tryC({ uid: C4, port: { role, index: 0 } }, { uid: B114 });
  if (r.code !== "endpoint_not_a_port" && r.code !== "ambiguous_port") console.log(`  from ${role}#0 :`, JSON.stringify(r));
}

/* What is B41's entry? Is it even an acceptor? */
const b41 = obs.entities.find(e => e.uid === B41);
const c1 = obs.entities.find(e => e.uid === C1);
console.log("\nB41 entity:", JSON.stringify(b41));
console.log("C1 entity:", JSON.stringify(c1));
console.log("\nAll belts near B41:");
for (const e of obs.entities.filter(e => e.type === "belt" && Math.abs(e.x - b41.x) <= 2 && Math.abs(e.y - b41.y) <= 2)) {
  console.log("  ", JSON.stringify(e));
}
