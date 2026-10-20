/**
 * 参考 Agent（play.mjs）—— 「能用 vs 玩得起来」的分界线就是这个文件。
 *
 * 它演示一个最小但完整的「观测 → 决策 → 动作 → 等结果 → 再观测」循环，
 * 全部走桥接的 HTTP /rpc 接口（协议 §11.1）。零依赖。
 *
 * 模式：
 *   node src/agent/play.mjs observe          打印人类可读的观测摘要
 *   node src/agent/play.mjs action '<json>'  执行一个动作（或 {"batch":[...]}）
 *   node src/agent/play.mjs b1               内置 B1 启发式：建 矿机→传送带→HUB 链路
 *   node src/agent/play.mjs plan <file.jsonl>  逐行执行动作计划
 *
 * 配置：--url / SHAPEZ_BRIDGE_URL（默认 http://127.0.0.1:7777）
 *       --token / SHAPEZ_BRIDGE_TOKEN
 */
import process from "node:process";
import fs from "node:fs";

const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = (argVal("--url", process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777")).replace(/\/+$/, "");
const TOKEN = argVal("--token", process.env.SHAPEZ_BRIDGE_TOKEN || null);

// ─────────────────────── RPC 客户端（协议 §11.1） ───────────────────────

let rpcId = 1;
async function rpc(method, params = {}) {
    const payload = { jsonrpc: "2.0", id: rpcId++, method, params };
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: Object.assign(
            { "content-type": "application/json", connection: "close" },
            TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}
        ),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000),
    });
    const body = await res.json();
    if (body.error) {
        const err = new Error(body.error.message || "rpc error");
        err.rpc = body.error;
        throw err;
    }
    return body.result;
}

/** 执行一个动作，打印结果；出错时打印诊断提示（参考实现的核心价值） */
async function act(action, { quiet = false } = {}) {
    try {
        const result = await rpc("act", action);
        if (!quiet) {
            const bits = [`ok`, `op=${result.op}`];
            if (result.applied !== undefined) bits.push(`applied=${result.applied}`);
            if (result.met !== undefined) bits.push(`met=${result.met}`, `ticks=${result.ticks_run}`);
            if (result.entity_uid !== undefined) bits.push(`uid=${result.entity_uid}`);
            console.log("  →", bits.join(" "), result.failed && result.failed.length ? `failed=${result.failed.length}` : "");
        }
        return result;
    } catch (e) {
        const code = e.rpc && e.rpc.code;
        console.log(`  ✗ action failed [${code} ${e.rpc && e.rpc.data ? e.rpc.data.code_name : ""}] ${e.message}`);
        // 参考实现：按错误类型给诊断（这就是「玩得起来」的差别）
        if (code === 2002 && e.rpc.data && e.rpc.data.hint) {
            console.log(`    hint: ${e.rpc.data.hint}`);
            try {
                const obs = await rpc("obs", { region: regionAround(action), max_entities: 20 });
                if (obs.entities && obs.entities.length) {
                    console.log(`    occupants: ${obs.entities.map(en => `${en.type}@(${en.x},${en.y})`).join(", ")}`);
                }
            } catch {}
        } else if (code === 2001) {
            console.log(`    hint: fix the parameters and retry. ${e.rpc.data && e.rpc.data.hint ? e.rpc.data.hint : ""}`);
        } else if (code === 1003) {
            console.log(`    hint: the game is not in a world. Load a savegame first.`);
        }
        throw e;
    }
}

function regionAround(action) {
    const x = action.x !== undefined ? action.x : action.from ? action.from[0] : 0;
    const y = action.y !== undefined ? action.y : action.from ? action.from[1] : 0;
    return [x - 2, y - 2, x + 2, y + 2];
}

// ─────────────────────── 观测摘要 ───────────────────────

function summarize(obs) {
    const lines = [];
    lines.push(`tick=${obs.tick.toFixed(1)} speed=${obs.speed} layer=${obs.layer}`);
    if (obs.goal) {
        const r = obs.goal.requirement;
        lines.push(
            `goal: level ${obs.goal.level} — ${r.shape} ${r.delivered}/${r.required} (${(r.progress * 100).toFixed(1)}%)${r.throughput_only ? " [throughput]" : ""}`
        );
    }
    if (obs.stats) {
        const top = Object.entries(obs.stats.by_type)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, v]) => `${k}:${v}`)
            .join(" ");
        lines.push(`entities: total=${obs.stats.total} (${top})`);
    }
    const hub = (obs.entities || []).filter(e => e.type === "hub");
    if (hub.length) lines.push(`hub at (${hub[0].x},${hub[0].y})`);
    if (obs.resources && obs.resources.length) {
        const uniq = [...new Set(obs.resources.map(r => r[2]))].slice(0, 6);
        lines.push(`resources: ${obs.resources.length} tiles, kinds: ${uniq.join(", ")}`);
    }
    if (obs.truncated) lines.push(`(truncated; entity_count=${obs.entity_count})`);
    return lines.join("\n");
}

// ─────────────────────── B1 启发式 ───────────────────────

/** 找 hub 与其周围最近的资源格 */
async function findBuildSite() {
    const obs = await rpc("obs", { max_entities: 200, include_resources: true, max_resources: 400, include_hub: true });
    if (!obs.in_game) throw new Error("not in game");
    const hub = (obs.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub found in observation — is a savegame loaded?");
    const hubPos = [hub.x, hub.y];
    // hub 是 4x4，中心约 +1.5
    const hubCenter = [hub.x + 1.5, hub.y + 1.5];
    const res = obs.resources || [];
    if (!res.length) throw new Error("no resources in the observed region");
    // 最近资源
    res.sort((a, b) => {
        const da = Math.hypot(a[0] - hubCenter[0], a[1] - hubCenter[1]);
        const db = Math.hypot(b[0] - hubCenter[0], b[1] - hubCenter[1]);
        return da - db;
    });
    const target = res[0];
    return { hub: hubPos, hubCenter, resource: [target[0], target[1]] };
}

/**
 * B1：在资源格放矿机，铺传送带到 HUB，等交付增加。
 * 关键决策（全部有实机验证）：
 * - 矿机 rotation 决定喷射方向（0=上 90=右 180=下 270=左）
 * - 传送带 rotation = 流动方向
 * - 路径必须是轴对齐直线：先沿一个轴到 hub 行/列，再沿另一轴进 hub 边缘
 * - 每个动作后检查结果，失败时换一种走法重试（至多 3 种）
 */
async function runB1({ timeoutTicks = 1200, dryRun = false } = {}) {
    const t0 = Date.now();
    let actionCount = 0;
    const failures = { count: 0, byCode: {} };
    const track = p => {
        if (!p) return;
        if (p.ok === false && p.error) {
            failures.count++;
            failures.byCode[p.error.code] = (failures.byCode[p.error.code] || 0) + 1;
        }
    };
    const doAct = async a => {
        actionCount++;
        if (dryRun) {
            console.log("  [dry-run]", JSON.stringify(a));
            return { ok: true, dry_run: true };
        }
        try {
            return await act(a);
        } catch (e) {
            track({ ok: false, error: e.rpc });
            return null;
        }
    };

    const site = await findBuildSite();
    console.log(`B1 plan: hub=(${site.hub.join(",")}) resource=(${site.resource.join(",")})`);

    const [rx, ry] = site.resource;
    const [hx, hy] = site.hub;
    // hub 4x4：目标是把带子铺到 hub 的邻格
    // 选择 hub 边上离资源最近的一个入口格
    const hubTiles = [];
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) hubTiles.push([hx + dx, hy + dy]);
    hubTiles.sort((a, b) => Math.hypot(a[0] - rx, a[1] - ry) - Math.hypot(b[0] - rx, b[1] - ry));
    const entry = hubTiles[0]; // hub 上离矿机最近的格子（带子要顶到这个格子的外侧邻格）

    // 入口外侧格（在 hub 外、紧邻 entry）
    const entryOut = [];
    if (entry[0] > hx) entryOut.push([entry[0] - 1, entry[1]]);
    if (entry[0] < hx + 3) entryOut.push([entry[0] + 1, entry[1]]);
    if (entry[1] > hy) entryOut.push([entry[0], entry[1] - 1]);
    if (entry[1] < hy + 3) entryOut.push([entry[0], entry[1] + 1]);

    // 尝试顺序：矿机 → 先横后纵 / 先纵后横 的 L 形路径、矿机喷射方向与之匹配
    // 简化：把矿机放在资源格，喷射方向朝向"路径第一段"的方向
    const paths = [];
    for (const out of entryOut) {
        // 路径 A：L 形（先横后纵）——矿机喷向 x 方向
        paths.push({ kind: "lr", out, mid: [out[0], ry] });
        // 路径 B：L 形（先纵后横）——矿机喷向 y 方向
        paths.push({ kind: "ud", out, mid: [rx, out[1]] });
    }

    let placedMiner = false;
    let minerUid = null;
    let beltOk = 0;

    for (const path of paths) {
        if (beltOk > 0) break;
        const { kind, out, mid } = path;
        // 矿机喷射方向 = 路径从矿机出发的第一段方向
        let minerRot;
        if (kind === "lr") minerRot = mid[0] > rx ? 90 : mid[0] < rx ? 270 : out[0] > rx ? 90 : 270;
        else minerRot = mid[1] > ry ? 180 : mid[1] < ry ? 0 : out[1] > ry ? 180 : 0;

        console.log(`try ${kind}: miner@(${rx},${ry}) r=${minerRot}, via (${mid.join(",")}) to entry-out (${out.join(",")})`);

        // 1) 清场（上一次尝试残留）
        if (dryRun) {
            await doAct({ op: "bulk_delete", region: [Math.min(rx, out[0]) - 1, Math.min(ry, out[1]) - 1, Math.max(rx, out[0]) + 1, Math.max(ry, out[1]) + 1] });
        }
        // 2) 放矿机
        if (!placedMiner || minerUid === null) {
            const m = await doAct({ op: "place", building: "miner", x: rx, y: ry, r: minerRot });
            if (!m) {
                console.log("  miner placement failed, trying next path");
                continue;
            }
            placedMiner = true;
            minerUid = m.entity_uid;
        } else {
            // 已放过矿机但方向不对：删掉重放
            await doAct({ op: "delete", x: rx, y: ry });
            const m = await doAct({ op: "place", building: "miner", x: rx, y: ry, r: minerRot });
            if (!m) continue;
            minerUid = m.entity_uid;
        }

        // 3) 第一段：矿机 → mid（含两端）
        let seg1;
        if (kind === "lr") seg1 = { op: "place_path", building: "belt", from: [rx, ry], to: [mid[0], ry] };
        else seg1 = { op: "place_path", building: "belt", from: [rx, ry], to: [rx, mid[1]] };
        const r1 = await doAct(seg1);
        if (!r1) {
            console.log("  segment 1 failed, trying next path");
            continue;
        }
        // 4) 第二段：mid → out
        let seg2;
        if (kind === "lr") seg2 = { op: "place_path", building: "belt", from: [mid[0], mid[1]], to: [out[0], out[1]] };
        else seg2 = { op: "place_path", building: "belt", from: [mid[0], mid[1]], to: [out[0], out[1]] };
        const r2 = await doAct(seg2);
        if (!r2) {
            console.log("  segment 2 failed, trying next path");
            continue;
        }
        // 5) 最后一段：out → entry（hub 边缘，一段 1-2 格）
        const r3 = await doAct({ op: "place_path", building: "belt", from: [out[0], out[1]], to: [entry[0], entry[1]] });
        if (!r3) {
            console.log("  entry segment failed, trying next path");
            continue;
        }
        beltOk = (r1.applied || 0) + (r2.applied || 0) + (r3.applied || 0);
    }

    if (!placedMiner) {
        return { pass: false, reason: "could not place miner on resource", actionCount, failures, wallMs: Date.now() - t0 };
    }

    // 6) 等一下看交付
    console.log(`waiting up to ${timeoutTicks} ticks for hub delivery ...`);
    if (dryRun) {
        await doAct({ op: "await", until: "hub_delivered_increased", timeout_ticks: timeoutTicks });
        return { pass: false, reason: "dry-run", actionCount, failures, wallMs: Date.now() - t0 };
    }
    let awaited;
    try {
        actionCount++;
        awaited = await rpc("act", { op: "await", until: "hub_delivered_increased", timeout_ticks: timeoutTicks });
    } catch (e) {
        track({ ok: false, error: e.rpc });
        return { pass: false, reason: "await failed: " + e.message, actionCount, failures, wallMs: Date.now() - t0 };
    }
    const obs = await rpc("obs", { max_entities: 1 });
    return {
        pass: awaited.met === true,
        delivered: obs.goal && obs.goal.requirement ? obs.goal.requirement.delivered : null,
        required: obs.goal && obs.goal.requirement ? obs.goal.requirement.required : null,
        met: awaited.met,
        ticksRun: awaited.ticks_run,
        actionCount,
        failures,
        wallMs: Date.now() - t0,
    };
}

// ─────────────────────── CLI ───────────────────────

async function main() {
    const mode = args[0] || "observe";
    if (mode === "observe") {
        const obs = await rpc("obs", { max_entities: 50, include_resources: true, max_resources: 60 });
        console.log(summarize(obs));
        const ents = (obs.entities || []).slice(0, 15);
        if (ents.length) {
            console.log("\nnearby entities:");
            for (const e of ents) console.log(`  ${e.type.padEnd(18)} (${e.x},${e.y}) r=${e.r}`);
        }
        return 0;
    }
    if (mode === "action") {
        const json = args[1];
        if (!json) {
            console.error("usage: play.mjs action '<json action>'");
            return 1;
        }
        const a = JSON.parse(json);
        if (a.batch) {
            const r = await rpc("batch", { actions: a.batch });
            console.log(JSON.stringify(r, null, 2));
        } else {
            await act(a);
        }
        return 0;
    }
    if (mode === "b1") {
        const res = await runB1({ timeoutTicks: parseInt(argVal("--timeout-ticks", "1200"), 10), dryRun: args.includes("--dry-run") });
        console.log("\nB1 result:", JSON.stringify(res, null, 2));
        return res.pass ? 0 : 2;
    }
    if (mode === "plan") {
        const file = args[1];
        if (!file) {
            console.error("usage: play.mjs plan <file.jsonl>");
            return 1;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
        let n = 0;
        for (const line of lines) {
            const a = JSON.parse(line);
            console.log(`[${++n}/${lines.length}] ${JSON.stringify(a).slice(0, 120)}`);
            if (a.await) {
                await act(Object.assign({ op: "await" }, a.await));
            } else {
                await act(a);
            }
        }
        console.log(`plan finished: ${n} actions`);
        return 0;
    }
    console.error("modes: observe | action <json> | b1 | plan <file.jsonl>");
    return 1;
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch(e => {
        console.error("FATAL:", e.message);
        if (e.rpc) console.error("rpc error:", JSON.stringify(e.rpc));
        process.exitCode = 1;
    });
