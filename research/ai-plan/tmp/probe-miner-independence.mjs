/**
 * probe-miner-independence.mjs — can each miner stand on its OWN ore?
 *
 * P1-3. `jointResourceShift` moves the whole miner layer by ONE shift vector, so the miners'
 * relative offsets are frozen by the DAG layout (CgScScCg: -12/-8/-4/0/+4). Real ore maps
 * scatter their patches, so that rigid relation usually cannot land — CgScScCg fails on every
 * seed we have (43391, 60908, 77844, 15935).
 *
 * This probe answers two questions BEFORE anything is changed:
 *
 *   1. If each miner picks its own nearest suitable ore cell, how far apart do they end up?
 *      (That distance is what the router would have to span, so it predicts feasibility.)
 *   2. Does the rigid single-shift search ever succeed? If it does on some seed, we have a
 *      baseline to compare against and we know the change cannot be a regression there.
 *
 * Read-only: imports the world model, touches no game state.
 *
 * Usage: node research/ai-plan/tmp/probe-miner-independence.mjs [goal...]
 */
import { compilePlan } from "../../../src/ai/compiler/compile.mjs";

const GOALS = process.argv.slice(2).length ? process.argv.slice(2)
    : ["CuCuCuCu", "----CuCu", "RuRu----", "CrCrCrCr", "RbRb----", "CpCpCpCp", "CgScScCg"];
const SEEDS = [43391, 60908, 77844, 15935];

for (const seed of SEEDS) {
    console.log(`\n═══ seed ${seed} ═══`);
    for (const goal of GOALS) {
        let r;
        try {
            r = compilePlan({ goal, seed, hub: [-2, -2], tunnels: true });
        } catch (e) {
            console.log(`  ${goal.padEnd(9)} THROW ${e.message.slice(0, 70)}`);
            continue;
        }
        if (r.ok) {
            const miners = (r.entities || []).filter(e => e.kind === "miner");
            const xs = miners.map(m => m.dx), ys = miners.map(m => m.dy);
            const span = miners.length
                ? `x ${Math.min(...xs)}..${Math.max(...xs)} (Δ${Math.max(...xs) - Math.min(...xs)}) | y ${Math.min(...ys)}..${Math.max(...ys)} (Δ${Math.max(...ys) - Math.min(...ys)})`
                : "-";
            const rels = miners.map(m => `${m.nodeId}@(${m.dx},${m.dy})`).join(" ");
            console.log(`  ${goal.padEnd(9)} OK   ${(r.entities || []).length} ents, ${miners.length} miners  ${span}`);
            if (miners.length > 1) console.log(`            ${rels}`);
        } else {
            console.log(`  ${goal.padEnd(9)} FAIL ${r.reason}`);
        }
    }
}
