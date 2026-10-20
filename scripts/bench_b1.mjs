/**
 * 基准 B1：放一条「矿机 → 传送带 → HUB」链路，判据 = HUB 交付数在 T tick 内 +1。
 * 输出可量化的结果行（阶段 6 要求）。
 *
 * 用法：node scripts/bench_b1.mjs [--timeout-ticks 1200] [--dry-run] [--out result.json] [--url ...]
 */
import process from "node:process";
import fs from "node:fs";

const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = (argVal("--url", process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777")).replace(/\/+$/, "");
const TIMEOUT = parseInt(argVal("--timeout-ticks", "1200"), 10);
const DRY = args.includes("--dry-run");
const OUT = argVal("--out", null);

const t0 = Date.now();
const metrics = { actions: 0, failures: [] };

let rpcId = 1;
async function rpc(method, params = {}) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(180000),
    });
    const body = await res.json();
    if (body.error) {
        const e = new Error(body.error.message);
        e.rpc = body.error;
        throw e;
    }
    return body.result;
}

async function doAct(a) {
    metrics.actions++;
    if (DRY) {
        console.log("  [dry]", JSON.stringify(a));
        return { ok: true, dry_run: true };
    }
    try {
        const r = await rpc("act", a);
        console.log(`  ok  ${a.op}${r.applied !== undefined ? " applied=" + r.applied : ""}${r.entity_uid !== undefined ? " uid=" + r.entity_uid : ""}`);
        return r;
    } catch (e) {
        const code = e.rpc ? e.rpc.code : "?";
        metrics.failures.push({ op: a.op, code, detail: e.rpc && e.rpc.data ? e.rpc.data.detail : e.message });
        console.log(`  FAIL ${a.op} [${code}] ${e.rpc && e.rpc.data ? e.rpc.data.detail : e.message}`);
        return null;
    }
}

function report(pass, note, extra) {
    const wallMs = Date.now() - t0;
    const dist = {};
    for (const f of metrics.failures) dist[f.code] = (dist[f.code] || 0) + 1;
    const distStr = Object.keys(dist).length ? Object.entries(dist).map(([k, v]) => `${k}:${v}`).join(" ") : "none";
    console.log("\n| bench | pass | actions | wall | failures | failure types | note |");
    console.log(
        `| B1 | ${pass ? "PASS" : "FAIL"} | ${metrics.actions} | ${(wallMs / 1000).toFixed(1)}s | ${metrics.failures.length} | ${distStr} | ${note || "-"} |`
    );
    if (OUT) {
        fs.writeFileSync(
            OUT,
            JSON.stringify({ bench: "B1", pass, actions: metrics.actions, wallMs, failures: metrics.failures, failureTypes: dist, note, extra }, null, 2)
        );
        console.log("result written to " + OUT);
    }
    process.exitCode = pass ? 0 : 2;
}

async function main() {
    console.log("=== B1: miner -> belts -> HUB ===");

    if (args.includes("--new-game")) {
        console.log("  starting a fresh savegame (level 1) ...");
        await doAct({ op: "new_game" });
        await new Promise(r => setTimeout(r, 8000));
    }

    const obs = await rpc("obs", { max_entities: 300, include_resources: true, max_resources: 500 });
    if (!obs.in_game) {
        console.error("not in game — load a savegame first (or pass --new-game)");
        process.exit(2);
    }
    const hub = (obs.entities || []).find(e => e.type === "hub");
    if (!hub) {
        console.error("no hub found");
        process.exit(2);
    }
    // 资源可能不在实体 bbox 内（新档只有 hub）——以 hub 为中心明确拉一个区域
    const obs2 = await rpc("obs", {
        max_entities: 300,
        region: [hub.x - 48, hub.y - 48, hub.x + 48, hub.y + 48],
        include_resources: true,
        max_resources: 2000,
    });
    const res = obs2.resources || [];
    if (!res.length) {
        console.error("no resources within 96x96 of the hub — unexpected; check the savegame");
        process.exit(2);
    }

    // 诊断：当前关卡目标形状能否由纯矿机链直接产出？
    // hub 只接收"当前目标"形状；纯采矿链只能产出原始资源形状。
    const goalShape = obs.goal && obs.goal.requirement ? obs.goal.requirement.shape : null;
    const resKinds = [...new Set(res.map(r => r[2]))];
    const matching = goalShape ? res.filter(r => r[2] === goalShape) : [];
    const directProducible = goalShape && resKinds.includes(goalShape);
    if (goalShape && !directProducible) {
        console.log(`note: current level ${obs.goal.level} goal is '${goalShape}', but the resources here are [${resKinds.join(", ")}].`);
        console.log(`      A pure miner->belt->hub chain cannot deliver '${goalShape}' — it needs processing buildings.`);
        console.log(`      B1 is designed for levels where the goal equals a raw resource (e.g. level 1).`);
        console.log(`      Tip: re-run with --new-game to test B1 on a fresh level-1 savegame.`);
        report(false, `goal '${goalShape}' needs processing (resources: ${resKinds.join("/")}); run --new-game for a clean B1`);
        return;
    }

    // 选离 hub 最近的【匹配目标形状】的资源（不匹配的话矿机产出会被 hub 拒收）
    const pool = matching.length ? matching : res;
    if (matching.length) {
        console.log(`resource choice: ${matching.length} tiles match goal '${goalShape}'`);
    } else {
        console.log(`warning: no resource matches goal '${goalShape}' exactly; using nearest and hoping for the best`);
    }
    pool.sort(
        (a, b) => Math.hypot(a[0] - (hub.x + 1.5), a[1] - (hub.y + 1.5)) - Math.hypot(b[0] - (hub.x + 1.5), b[1] - (hub.y + 1.5))
    );
    const [rx, ry] = pool[0];
    console.log(`hub=(${hub.x},${hub.y})  nearest resource=(${rx},${ry})`);

    // 矿机（幂等：已在该资源格则复用）
    let minerRot = computeMinerRot();
    const existingMiner = (obs.entities || []).find(e => e.type === "miner" && e.x === rx && e.y === ry);
    if (!existingMiner) {
        try {
            await rpc("act", { op: "delete", x: rx, y: ry });
        } catch (e) {
            if (e.rpc && e.rpc.code !== 2002) throw e;
        }
        const m = await doAct({ op: "place", building: "miner", x: rx, y: ry, r: minerRot });
        if (!m) {
            report(false, "miner placement failed");
            return;
        }
    } else {
        console.log("  (miner already present, reusing)");
    }

    function computeMinerRot() {
        // 矿机喷射方向 = 朝 hub
        if (Math.abs(hub.x + 1 - rx) > Math.abs(hub.y + 1 - ry)) return hub.x > rx ? 90 : 270;
        return hub.y > ry ? 180 : 0;
    }

    // ── 路径规划 ──
    // 关键：最后一段带子必须朝向 hub（rotation = 流向）。
    // entry = hub 外侧邻格；dirIntoHub = entry 指向 hub 的方向；
    // behind = entry 再往外一格（最后一段从 behind 铺到 entry，两格都朝 hub；
    //          若 behind 已被主段占用，传送带可替换 → 直接覆盖转向）。
    const hx = hub.x;
    const hy = hub.y;
    let entry, dirIntoHub, behind;
    if (rx <= hx) {
        entry = [hx - 1, Math.max(hy, Math.min(ry, hy + 3))];
        dirIntoHub = 90; // 向右进 hub
        behind = [hx - 2, entry[1]];
    } else if (rx >= hx + 3) {
        entry = [hx + 4, Math.max(hy, Math.min(ry, hy + 3))];
        dirIntoHub = 270; // 向左进 hub
        behind = [hx + 5, entry[1]];
    } else if (ry <= hy) {
        entry = [Math.max(hx, Math.min(rx, hx + 3)), hy - 1];
        dirIntoHub = 180; // 向下进 hub
        behind = [entry[0], hy - 2];
    } else {
        entry = [Math.max(hx, Math.min(rx, hx + 3)), hy + 4];
        dirIntoHub = 0; // 向上进 hub
        behind = [entry[0], hy + 5];
    }
    console.log(`entry=( ${entry.join(",")} ) dirIntoHub=${dirIntoHub}  behind=( ${behind.join(",")} )`);

    const segList = (from, toMid, to) => {
        const segs = [];
        if (!(toMid[0] === from[0] && toMid[1] === from[1])) {
            segs.push({ op: "place_path", building: "belt", from: [from[0], from[1]], to: [toMid[0], toMid[1]] });
        }
        if (!(to[0] === toMid[0] && to[1] === toMid[1])) {
            segs.push({ op: "place_path", building: "belt", from: [toMid[0], toMid[1]], to: [to[0], to[1]] });
        }
        return segs;
    };

    let beltOk = false;
    const attempts = [segList([rx, ry], [behind[0], ry], behind), segList([rx, ry], [rx, behind[1]], behind)];
    for (const [i, segs] of attempts.entries()) {
        // 保证矿机朝向与主段第一段一致
        if (segs.length) {
            const f = segs[0].from;
            const t = segs[0].to;
            let needed;
            if (t[0] > f[0]) needed = 90;
            else if (t[0] < f[0]) needed = 270;
            else if (t[1] > f[1]) needed = 180;
            else needed = 0;
            if (needed !== minerRot) {
                try {
                    await rpc("act", { op: "delete", x: rx, y: ry });
                } catch (e) {
                    if (e.rpc && e.rpc.code !== 2002) throw e;
                }
                const m = await doAct({ op: "place", building: "miner", x: rx, y: ry, r: needed });
                if (!m) continue;
                minerRot = needed;
            }
        }
        let allOk = true;
        for (const s of segs) {
            const r = await doAct(s);
            if (!r) {
                allOk = false;
                break;
            }
        }
        if (!allOk) continue;
        // 最后一段：behind → entry（两格朝 hub；behind 若是旧带子会被替换转向）
        const fin = await doAct({ op: "place_path", building: "belt", from: behind, to: entry });
        if (!fin) continue;
        beltOk = true;
        console.log(`  (route attempt ${i + 1} succeeded)`);
        break;
    }
    if (!beltOk) {
        report(false, "belt pathing failed");
        return;
    }

    if (DRY) {
        console.log("  [dry] await hub_delivered_increased");
        report(false, "dry-run");
        return;
    }

    metrics.actions++;
    let awaited;
    try {
        awaited = await rpc("act", { op: "await", until: "hub_delivered_increased", timeout_ticks: TIMEOUT });
    } catch (e) {
        metrics.failures.push({ op: "await", code: e.rpc ? e.rpc.code : "?", detail: e.message });
        report(false, "await failed: " + e.message);
        return;
    }
    const after = await rpc("obs", { max_entities: 1 });
    const req = after.goal && after.goal.requirement;
    console.log(`await: met=${awaited.met} ticks=${awaited.ticks_run}; delivered=${req ? req.delivered : "?"}/${req ? req.required : "?"}`);
    report(awaited.met === true, awaited.met ? "" : "delivery did not increase within window", {
        delivered: req ? req.delivered : null,
        required: req ? req.required : null,
        ticks_run: awaited.ticks_run,
    });
}

main().catch(e => {
    console.error("FATAL:", e.message);
    report(false, "crash: " + e.message);
});
