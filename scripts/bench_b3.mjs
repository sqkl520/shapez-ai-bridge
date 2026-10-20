/**
 * 基准 B3：从新档玩到 level 3，无人工干预，动作数 ≤ N。
 *
 * 用法：node scripts/bench_b3.mjs [--budget 500] [--plan-dir plans/] [--timeout-ticks 4000]
 *
 * 策略来源：
 *   默认启发式（level 1 直送；level 2 是骨架，可能 needs_live_tuning）
 *   --plan-dir 提供每个 level 的计划文件（plan-lv1.jsonl / plan-lv2.jsonl / ...），
 *   有则优先用（这是给外部 LLM 或人工生成计划用的插槽）。
 *
 * 输出：总动作数、每级动作数、失败类型分布（阶段 6 要求的表格）。
 */
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function argVal(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = (argVal("--url", process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777")).replace(/\/+$/, "");
const BUDGET = parseInt(argVal("--budget", "500"), 10);
const PLAN_DIR = argVal("--plan-dir", null);
const TICK_TIMEOUT = parseInt(argVal("--timeout-ticks", "15000"), 10);

const t0 = Date.now();
const perLevel = [];
let totalActions = 0;
const allFailures = [];

let rpcId = 1;
async function rpc(method, params = {}) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(300000),
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
    totalActions++;
    try {
        return await rpc("act", a);
    } catch (e) {
        const code = e.rpc ? e.rpc.code : "?";
        allFailures.push({ op: a.op, code, detail: e.rpc && e.rpc.data ? e.rpc.data.detail : e.message });
        return null;
    }
}

/** 逐格显式铺带（消除 place_path 拐角方向的不确定性——实机踩过的坑）。
 *  对折线 [p0..pn]：每格的流向 = 该格指向下一格的方向；末格沿用前一段方向。
 *  已经存在且方向正确的格子跳过；方向不符则先删后放。 */
async function placeLane(tiles) {
    let placed = 0;
    const dirOf = (a, b) => {
        if (b[0] > a[0]) return 90;
        if (b[0] < a[0]) return 270;
        if (b[1] > a[1]) return 180;
        return 0;
    };
    for (let i = 0; i + 1 < tiles.length; ++i) {
        const cur = tiles[i];
        const next = tiles[i + 1];
        if (cur[0] === next[0] && cur[1] === next[1]) continue;
        const r = dirOf(cur, next);
        // 先查现状
        const obs = await rpc("obs", { region: [cur[0], cur[1], cur[0], cur[1]], max_entities: 3 });
        const existing = (obs.entities || []).find(e => e.x === cur[0] && e.y === cur[1] && e.type === "belt");
        if (existing && existing.r === r) {
            placed++;
            continue;
        }
        if (existing) {
            try {
                await rpc("act", { op: "delete", x: cur[0], y: cur[1] });
            } catch (e) {
                // 删除失败仅记录，继续尝试放置
            }
        }
        if (await doAct({ op: "place", building: "belt", x: cur[0], y: cur[1], r })) placed++;
    }
    // 末格：沿用最后一段的方向（此前只作为方向参照，从未落地——实机踩过的坑：
    // 紧贴 hub 的最后一格缺失导致整条线差一格不通）
    if (tiles.length >= 2) {
        const last = tiles[tiles.length - 1];
        const prev = tiles[tiles.length - 2];
        const r = dirOf(prev, last);
        const obs = await rpc("obs", { region: [last[0], last[1], last[0], last[1]], max_entities: 3 });
        const existing = (obs.entities || []).find(e => e.x === last[0] && e.y === last[1] && e.type === "belt");
        if (existing && existing.r === r) {
            placed++;
        } else {
            if (existing) {
                try {
                    await rpc("act", { op: "delete", x: last[0], y: last[1] });
                } catch (e) {
                    /* 继续尝试 */
                }
            }
            if (await doAct({ op: "place", building: "belt", x: last[0], y: last[1], r })) placed++;
        }
    }
    return placed;
}

function finalReport(pass, note, reachedLevel) {
    const wallMs = Date.now() - t0;
    const dist = {};
    for (const f of allFailures) dist[f.code] = (dist[f.code] || 0) + 1;
    const distStr = Object.keys(dist).length ? Object.entries(dist).map(([k, v]) => `${k}:${v}`).join(" ") : "none";
    console.log("\n=== B3 summary ===");
    console.log(`reached level: ${reachedLevel} (target: 3)`);
    console.log("per-level actions:");
    for (const l of perLevel) console.log(`  level ${l.level} -> ${l.endLevel}: ${l.actions} actions, ${l.failures} failures, ${(l.ms / 1000).toFixed(1)}s`);
    console.log("\n| bench | pass | actions | wall | failures | failure types | note |");
    console.log(
        `| B3 | ${pass ? "PASS" : "FAIL"} | ${totalActions} | ${(wallMs / 1000).toFixed(1)}s | ${allFailures.length} | ${distStr} | ${note || `budget ${BUDGET}`} |`
    );
    const out = argVal("--out", null);
    if (out) {
        fs.writeFileSync(out, JSON.stringify({ bench: "B3", pass, reachedLevel, totalActions, wallMs, perLevel, failures: allFailures }, null, 2));
        console.log("result written to " + out);
    }
    process.exitCode = pass ? 0 : 2;
}

/** 用 bench_b1 同款逻辑建一条「匹配目标的资源 → hub」链路 */
async function buildChainForGoal(level) {
    const obs = await rpc("obs", { max_entities: 300 });
    const hub = (obs.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub");
    const shape = obs.goal.requirement.shape;
    const obs2 = await rpc("obs", {
        region: [hub.x - 48, hub.y - 48, hub.x + 48, hub.y + 48],
        max_entities: 300,
        include_resources: true,
        max_resources: 2000,
    });
    const matching = (obs2.resources || []).filter(r => r[2] === shape);
    if (!matching.length) return { ok: false, note: `level ${level}: no '${shape}' resource near hub (needs processing chain)` };
    matching.sort((a, b) => Math.hypot(a[0] - (hub.x + 1.5), a[1] - (hub.y + 1.5)) - Math.hypot(b[0] - (hub.x + 1.5), b[1] - (hub.y + 1.5)));
    const [rx, ry] = matching[0];
    // 建链（与 bench_b1 相同的规划：矿机朝向必须与第一段带子方向一致，否则物品掉不出来）
    const hx = hub.x;
    const hy = hub.y;
    let entry, behind;
    if (rx <= hx) {
        entry = [hx - 1, Math.max(hy, Math.min(ry, hy + 3))];
        behind = [hx - 2, entry[1]];
    } else if (rx >= hx + 3) {
        entry = [hx + 4, Math.max(hy, Math.min(ry, hy + 3))];
        behind = [hx + 5, entry[1]];
    } else if (ry <= hy) {
        entry = [Math.max(hx, Math.min(rx, hx + 3)), hy - 1];
        behind = [entry[0], hy - 2];
    } else {
        entry = [Math.max(hx, Math.min(rx, hx + 3)), hy + 4];
        behind = [entry[0], hy + 5];
    }
    const attempts = [
        [[rx, ry], [behind[0], ry], behind],
        [[rx, ry], [rx, behind[1]], behind],
    ];
    for (const [from, mid, to] of attempts) {
        const segs = [];
        if (!(from[0] === mid[0] && from[1] === mid[1])) segs.push({ op: "place_path", building: "belt", from, to: mid });
        if (!(to[0] === mid[0] && to[1] === mid[1])) segs.push({ op: "place_path", building: "belt", from: mid, to });
        // 矿机朝向 = 第一段方向（无第一段时朝 behind 方向）
        const dirSeg = segs.length ? segs[0] : { from, to: behind };
        let needRot;
        if (dirSeg.to[0] > dirSeg.from[0]) needRot = 90;
        else if (dirSeg.to[0] < dirSeg.from[0]) needRot = 270;
        else if (dirSeg.to[1] > dirSeg.from[1]) needRot = 180;
        else needRot = 0;

        const existing = (await rpc("obs", { max_entities: 300 })).entities || [];
        const cur = existing.find(e => e.type === "miner" && e.x === rx && e.y === ry);
        if (!cur || cur.r !== needRot) {
            if (cur) {
                try {
                    await rpc("act", { op: "delete", x: rx, y: ry });
                } catch (e) {
                    if (!e.rpc || e.rpc.code !== 2002) throw e;
                }
            }
            if (!(await doAct({ op: "place", building: "miner", x: rx, y: ry, r: needRot }))) continue;
        }

        let ok = true;
        for (const s of segs) if (!(await doAct(s))) { ok = false; break; }
        if (!ok) continue;
        if (!(await doAct({ op: "place_path", building: "belt", from: behind, to: entry }))) continue;
        return { ok: true };
    }
    return { ok: false, note: "routing failed" };
}

/** 建「矿机 → 切割机 → hub」链路，用于产出半形状目标（如 ----CuCu = 右半）。
 *
 *  切割机语义（bundle MetaCutterBuilding._updateVariants）：
 *   - 输入槽：(0,0) direction=bottom（物品从下方进）
 *   - 输出槽：default 变体两个，(0,0) 与 (1,0)，方向都是 top（向上出）
 *     —— 左半形状从 (0,0) 出、右半从 (1,0) 出（cutHalf 的两个输出按注册顺序）
 *   - 所以：传送带从下方送原料进来；两个输出上各接一条带；
 *     把承载目标半形状的那条（右侧槽 = 目标以 ---- 开头时）接进 hub。
 */
async function buildCutterChain(goalShape) {
    const obs = await rpc("obs", { max_entities: 300 });
    const hub = (obs.entities || []).find(e => e.type === "hub");
    if (!hub) throw new Error("no hub");
    const hx = hub.x;
    const hy = hub.y;

    // 清空工作区（hub 自身不可删）
    await rpc("act", { op: "bulk_delete", region: [hx - 40, hy - 40, hx + 40, hy + 40] }).catch(() => {});
    console.log("  (workspace cleared)");

    // 目标半形状 -> 原料全形状（8 字符键：4 象限 × 2 字符）
    const goal = goalShape;
    let base = null;
    if (/^----.{4}$/.test(goal)) base = goal.slice(4, 8).repeat(2);
    else if (/^.{4}----$/.test(goal)) base = goal.slice(0, 4).repeat(2);
    if (!base) return { ok: false, note: "shape '" + goal + "' is not a simple half-cut target; provide --plan" };

    // 找原料资源
    const obs2 = await rpc("obs", {
        region: [hx - 48, hy - 48, hx + 48, hy + 48],
        max_entities: 300,
        include_resources: true,
        max_resources: 2000,
    });
    const matching = (obs2.resources || []).filter(r => r[2] === base);
    if (!matching.length) return { ok: false, note: "no '" + base + "' resource near hub for cutting into '" + goal + "'" };
    matching.sort((a, b) => Math.hypot(a[0] - (hx + 1.5), a[1] - (hy + 1.5)) - Math.hypot(b[0] - (hx + 1.5), b[1] - (hy + 1.5)));
    const [rx, ry] = matching[0];

    // ── 确定性布局（全部手工规划）──
    // 输入语义（源码依据 item_acceptor.js findMatchingSlot + vector.js）：
    //   acceptor.direction=bottom ⇒ 需要 ejector.toDirection=top ⇒ 物品必须【向上】喷入。
    //   切割机输入槽在局部 (0,0) direction=bottom ⇒ 需从世界 (cx, cy+1) 向上喷入。
    //   输出槽 default 变体在局部 (0,0)/(1,0) direction=top ⇒ 向上喷出，
    //   由上方格 (cx, cy-1)/(cx+1, cy-1) 接收。
    const cx = hx + 8;
    const cy = hy + 2;

    // 1) 矿机（朝向 = 输入走廊第一段方向）
    const mid = [cx, ry];
    await rpc("act", { op: "delete", x: rx, y: ry }).catch(() => {});
    if (!(await doAct({ op: "place", building: "miner", x: rx, y: ry, r: 90 }))) return { ok: false, note: "miner failed" };

    // 用 place_path 分段铺（关键机制，有实机与源码双证）：
    //   传送带放置时游戏按【当时存在的邻居】自动选曲线变体；
    //   分段铺设会让拐角格被相邻两段各放置一次——第二次放置时上游邻带已存在，
    //   曲线变体才被正确计算。逐格单次放置会把拐角铺成直带（实机验证的失败模式）。
    const seg = async (from, to, r) => {
        if (from[0] === to[0] && from[1] === to[1]) return true; // 退化段跳过（实机踩过的 2001）
        const a = { op: "place_path", building: "belt", from, to };
        if (r !== undefined) a.r = r;
        return !!(await doAct(a));
    };

    // 输入走廊：矿机 → (cx, ry) → (cx, cy+1)
    if (!(await seg([rx, ry], mid))) return { ok: false, note: "input seg1 failed" };
    if (ry !== cy + 1) {
        if (!(await seg(mid, [cx, cy + 1]))) return { ok: false, note: "input seg2 failed" };
    }
    // 输入头格强制朝上（进切割机输入槽）
    if (!(await doAct({ op: "place", building: "belt", x: cx, y: cy + 1, r: 0 }))) return { ok: false, note: "input head failed" };

    // 2) 切割机
    if (!(await doAct({ op: "place", building: "cutter", x: cx, y: cy, r: 0 }))) return { ok: false, note: "cutter failed" };

    // 3) 两条输出线（分段 place_path）。
    //    【关键机制，实机+源码双证】切割机两个输出槽的 ejector direction=top（向上喷），
    //    所以紧邻输出的第一格传送带必须【朝上流】（r0）——带子的"背部"朝下，
    //    正好接住从下方喷上来的物品。首格朝下（r180）会造成物品堵死在切割机出口，
    //    且堵一个输出会让整个切割机停转（queuedEjects 不排空则不开新 charge）——
    //    这就是"交付 2 个后永久停滞"的根因（截图 + 上游 item_processor.js 双证）。
    let routed = 0;
    {
        // lane1：输出(6,-1) 朝上 → 左 → 下 → 左进 hub 右侧槽行 hy
        const ok1 =
            (await seg([cx, cy - 1], [cx, hy - 3])) &&
            (await seg([cx, hy - 3], [hx + 6, hy - 3])) &&
            (await seg([hx + 6, hy - 3], [hx + 6, hy])) &&
            (await seg([hx + 6, hy], [hx + 4, hy], 270));
        if (ok1) routed++;
        // lane2：输出(7,-1) 朝上 → 继续上 → 左（顶层绕行）→ 下（左侧列）→ 右进 hub 左侧槽行 hy+1
        //        与 lane1 完全无重叠：lane1 用 col x=cx 与行 hy-3，lane2 用 col x=cx+1、
        //        行 hy-7、col x=hx-3、行 hy+1。
        const ok2 =
            (await seg([cx + 1, cy - 1], [cx + 1, hy - 7])) &&
            (await seg([cx + 1, hy - 7], [hx - 3, hy - 7])) &&
            (await seg([hx - 3, hy - 7], [hx - 3, hy + 1])) &&
            (await seg([hx - 3, hy + 1], [hx - 1, hy + 1], 90));
        if (ok2) routed++;
    }
    if (routed === 0) return { ok: false, note: "no cutter output lane routed" };
    console.log(
        "  (" + routed + "/2 output lanes routed: lane1 -> hub right slot row hy+0, lane2 -> hub left slot row hy+1)"
    );    return { ok: true };
}

async function runPlanFile(file) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
    for (const line of lines) {
        const a = JSON.parse(line);
        if (a.await) {
            if (!(await doAct(Object.assign({ op: "await" }, a.await)))) return false;
        } else {
            if (!(await doAct(a))) return false;
        }
    }
    return true;
}

async function main() {
    console.log("=== B3: fresh game -> level 3 ===");
    console.log(`budget: ${BUDGET} actions`);
    await rpc("act", { op: "new_game" });
    await new Promise(r => setTimeout(r, 8000));

    let guard = 0;
    while (guard++ < 20) {
        const obs = await rpc("obs", { max_entities: 1 });
        if (!obs.in_game) break;
        const level = obs.goal.level;
        if (level >= 3) {
            finalReport(true, `reached level ${level}`, level);
            return;
        }
        if (totalActions >= BUDGET) {
            finalReport(false, `budget exhausted at level ${level}`, level);
            return;
        }
        const lvStart = { level, actions: totalActions, failures: allFailures.length, ms: Date.now() };
        console.log(`\n--- level ${level} (${obs.goal.requirement.shape} x${obs.goal.requirement.required}) ---`);

        // 优先用计划文件
        const planFile = PLAN_DIR ? path.join(PLAN_DIR, `plan-lv${level}.jsonl`) : null;
        if (planFile && fs.existsSync(planFile)) {
            console.log(`using plan: ${planFile}`);
            await runPlanFile(planFile);
        } else {
            // level 1：纯资源直送；level 2：半形状用切割机；其余交给 plan
            let r;
            const shape = obs.goal.requirement.shape;
            const isHalf = /^----.{4}$/.test(shape) || /^.{4}----$/.test(shape);
            if (isHalf) {
                console.log(`strategy: cutter chain for half-shape '${shape}'`);
                r = await buildCutterChain(shape);
                if (r.ok) {
                    // 切割链路的实机验证尚不充分（见下方 note）；
                    // 在这里如实标注：不假装完成 level 2。
                    const after = await doAct({ op: "await", until: "level_increased", timeout_ticks: TICK_TIMEOUT });
                    const obsNow = await rpc("obs", { max_entities: 1 });
                    lvStart.endLevel = obsNow.goal.level;
                    lvStart.actions = totalActions - lvStart.actions;
                    lvStart.failures = allFailures.length - lvStart.failures;
                    lvStart.ms = Date.now() - lvStart.ms;
                    perLevel.push(lvStart);
                    if (after && after.met) {
                        continue;
                    }
                    finalReport(
                        false,
                        `needs_live_tuning: cutter chain built (${lvStart.actions} actions) but '${shape}' not delivered in ${TICK_TIMEOUT} ticks ` +
                            `— cutter input/output belt routing needs live tuning; use --plan-dir for exact layouts`,
                        obsNow.goal.level
                    );
                    return;
                }
            } else {
                r = await buildChainForGoal(level);
            }
            if (!r.ok) {
                lvStart.endLevel = level;
                lvStart.actions = totalActions - lvStart.actions;
                lvStart.failures = allFailures.length - lvStart.failures;
                lvStart.ms = Date.now() - lvStart.ms;
                perLevel.push(lvStart);
                finalReport(false, r.note, level);
                return;
            }
        }
        // 等升级
        const awaited = await doAct({ op: "await", until: "level_increased", timeout_ticks: TICK_TIMEOUT });
        const after = await rpc("obs", { max_entities: 1 });
        lvStart.endLevel = after.goal.level;
        lvStart.actions = totalActions - lvStart.actions;
        lvStart.failures = allFailures.length - lvStart.failures;
        lvStart.ms = Date.now() - lvStart.ms;
        perLevel.push(lvStart);
        if (!awaited || !awaited.met) {
            console.log(`level ${level} did not complete within ${TICK_TIMEOUT} ticks (delivered ${after.goal.requirement.delivered}/${after.goal.requirement.required})`);
            finalReport(false, `stuck at level ${level}`, after.goal.level);
            return;
        }
        console.log(`level ${level} complete -> ${after.goal.level}`);
    }
    finalReport(false, "loop guard hit", -1);
}

main().catch(e => {
    console.error("FATAL:", e.message);
    finalReport(false, "crash: " + e.message, -1);
});
