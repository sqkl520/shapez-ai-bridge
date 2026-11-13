import fs from "fs";
import { connect } from "../../src/agent/macros/connect.mjs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const uid = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
const C7 = uid("C7");
const scratch = [[34, -12], [35, -12]];

const run = (from, idx) => connect(
    { from: { uid: uid(from) }, to: { uid: C7, port: { role: "color", index: idx } }, opts: { rebind: true } },
    { entities: obs.entities, obs, scratch_feed_cells: scratch },
);

const pairs = [
    ["M6", 0, "M2", 1], ["M2", 0, "M6", 1],
    ["M9", 0, "M6", 1], ["M6", 0, "M9", 1],
];
for (const [a, ia, b, ib] of pairs) {
    const ra = run(a, ia), rb = run(b, ib);
    if (!ra.ok || !rb.ok) {
        console.log(`${a}->${ia} + ${b}->${ib}: FAIL ${ra.ok ? "" : ra.error.code} ${rb.ok ? "" : rb.error.code}`);
        continue;
    }
    const ca = ra.cells.map(c => `${c.x},${c.y}`);
    const cb = rb.cells.map(c => `${c.x},${c.y}`);
    const sa = new Set(ca);
    const ov = cb.filter(k => sa.has(k));
    const end = (r) => r.cells.slice(-1).map(c => `(${c.x},${c.y}) rv=${c.rotationVariant}`);
    console.log(`${a}->slot${ia} (${ra.pathLen}) + ${b}->slot${ib} (${rb.pathLen}) 重叠=${ov.length} 末=${end(ra)}/${end(rb)}`);
}
