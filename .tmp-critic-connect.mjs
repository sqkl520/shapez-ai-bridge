/* Read-only: dry-run the repeatedly-attempted connect calls against the live world. */
import fs from "node:fs";
import { connect } from "./src/agent/macros/connect.mjs";

const raw = JSON.parse(fs.readFileSync(".tmp-critic-obs.json", "utf8"));
const obs = raw.result || raw;

/* Build a handle table the way the loop does — simplest: uids directly. */
const byUid = new Map(obs.entities.map(e => [e.uid, e]));

const cases = [
  { name: "C1->B41  (339 attempts in history)", from: { uid: 16598 }, to: { uid: 17258 } },
  { name: "C4->B106 (49)", from: { uid: 17294 }, to: { uid: 17369 } },
  { name: "C4->B114 (47)", from: { uid: 17294 }, to: { uid: 17377 } },
];

for (const c of cases) {
  let res;
  try {
    res = connect({ from: c.from, to: c.to, opts: { dry_run: true } }, { entities: obs.entities });
  } catch (e) {
    res = { threw: String(e && e.message || e) };
  }
  const brief = {
    ok: res && res.ok,
    error: res && res.error ? { code: res.error.code, field: res.error.field, message: String(res.error.message || "").slice(0, 160) } : null,
    cells: res && Array.isArray(res.cells) ? res.cells.length : (res && res.path ? res.path.length : undefined),
    threw: res && res.threw,
    keys: res && typeof res === "object" ? Object.keys(res) : typeof res,
  };
  console.log("=== " + c.name);
  console.log(JSON.stringify(brief, null, 1));
}
