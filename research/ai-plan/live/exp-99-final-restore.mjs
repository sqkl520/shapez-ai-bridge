/**
 * exp-99-final-restore.mjs — mandatory wrap-up: load the level-11 save and audit uid-by-uid
 * against snapshots/ai-research-base.bin (the C8 baseline). Exits nonzero if the world is not
 * exactly the baseline. This is the closing LIVE-LOG line.
 */
import { status, ensureWindowAwake, loadHome, assertWorldBaseline, currentWorldUids, hubPosition,
    snapshotSave, writeResult, log } from "./kit.mjs";

async function main() {
    await ensureWindowAwake();
    const s = await status();
    log(`before restore: in_game=${s.in_game} level=${s.hub_level}`);
    log("\n[1] re-snapshot level-11 to confirm the on-disk save is still the baseline ...");
    // (home was snapshotted at p7-paste-l1-home start; verify current live world once loaded)

    log("\n[2] load_save level-11 ...");
    await loadHome();
    const s2 = await status();
    log(`  in_game=${s2.in_game} level=${s2.hub_level}`);

    log("\n[3] uid-by-uid audit vs ai-research-base ...");
    const audit = await assertWorldBaseline();
    log(`  count=${audit.count} want=${audit.want} extra=${audit.extra} missing=${audit.missing} pass=${audit.pass}`);
    if (!audit.pass) log(`  extra=${JSON.stringify(audit.extra_uids)} missing=${JSON.stringify(audit.missing_uids)}`);
    const hub = await hubPosition();

    // belt-and-braces: a fresh canonical snapshot of the restored level-11 world
    const sn = await snapshotSave("p7-final-level11");
    log(`  re-snapshot ${sn.name} (internal_id ${sn.internal_id}, level ${sn.level})`);

    writeResult("final-restore", {
        test: "final-restore",
        pass: audit.pass,
        hub,
        audit,
        snapshot: sn,
    });
    log(`\n=== world_final: level-11 count=${audit.count}/${audit.want} extra=${audit.extra} missing=${audit.missing} — ${audit.pass ? "BASELINE EXACT" : "DRIFT"} ===`);
    process.exitCode = audit.pass ? 0 : 1;
}

main().catch((e) => {
    console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : "");
    writeResult("final-restore", { test: "final-restore", pass: false, fatal: e.message, rpc: e.rpc || null });
    process.exit(1);
});
