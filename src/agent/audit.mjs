/**
 * audit.mjs — 按研究 01 的 R1~R8 强制规则审计一座工厂。
 *
 * 为什么单独一个文件：`expect.mjs` 回答"跑得好不好"（速率对账），
 * 这里回答"结构对不对"（就算跑得动，结构错了也是错的）。
 * 两者缺一不可 —— 这一轮 L4 的失败就是结构错（切割机没有 sink、方向反了）
 * 而 dry_run 显示"108/108 全放、0 阻断"，看着完美。
 *
 * 每条规则都对应一个我们真实犯过的错，违反即拒绝执行（见 research/01 §8）。
 *
 * 用法：
 *   node src/agent/audit.mjs           # 人读
 *   node src/agent/audit.mjs --json    # 机读
 *
 * 判据全部来自 rules.mjs（数字经源码复核）+ 研究 01 §8 的验收伪代码，
 * 不在本文件里硬编码任何速率。
 */
import { RATES, UPGRADES, machinesForOneBelt } from "./rules.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rpcId = 1;

async function rpc(method, params = {}, timeoutMs = 60000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const b = await res.json();
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
    return b.result;
}

const MULT = [1, 1.5, 2, 3, 4, 6, 7, 8];
const multOf = lvl => MULT[Math.min(Math.max(lvl | 0, 0), 7)];

/** 一台机器的实际速率（含该线的升级倍率） */
function machineSpeed(kind, upgrades) {
    const line = { miner: "miner", cutter: "processors", rotater: "processors",
        stacker: "processors", painter: "painting", mixer: "painting" }[kind];
    const base = RATES.machinePerSec[kind];
    if (base === undefined) return null;
    return base * (line ? multOf(upgrades[line]) : 1);
}

/* ═══════════════════════════ R1：产能配比 ═══════════════════════════ */

/**
 * R1 — 每段机器数必须够喂满它那条带；矿机必须铺满矿簇。
 *
 * 违反的样子：一台矿机就报喜（0.4/s 对 2/s 的带 = 1/5 产能）。
 *
 * ⚠️ 覆盖率的分母要小心：全图 ±60 有 447 格矿，但绝大多数在远处、
 * 现在根本用不上。拿全图当分母永远显示 2%，那是个没用的数字。
 * 这里只统计**厂区附近**的矿（以矿机为中心 30 格内），
 * 这才是"我该铺满却没铺满"的那部分。
 */
function checkR1(obs) {
    const up = obs.upgrades || {};
    const beltSpeed = RATES.beltPerSec * multOf(up.belt);
    const miners = obs.entities.filter(e => e.type === "miner");
    const needMiners = Math.ceil(beltSpeed / machineSpeed("miner", up));

    const oreAt = new Set(obs.oreCells.map(c => `${c.x},${c.y}`));
    const onOre = miners.filter(m => oreAt.has(`${m.x},${m.y}`)).length;

    /* 厂区附近的矿：每格矿到**最近矿机**的距离 ≤ 30。
       没有矿机时（空厂）分母为 0，覆盖率不参与判定。 */
    const NEAR = 30;
    const nearOre = miners.length
        ? obs.oreCells.filter(c => miners.some(m => Math.max(Math.abs(m.x - c.x), Math.abs(m.y - c.y)) <= NEAR))
        : [];
    const nearCoverage = nearOre.length ? onOre / nearOre.length : null;

    const problems = [];
    if (miners.length > 0 && miners.length < needMiners) {
        problems.push({
            rule: "R1",
            detail: `只有 ${miners.length} 台矿机，喂满一条 ${beltSpeed}/s 的带需要 ${needMiners} 台`
                + `（产能只用了 ${Math.round((miners.length / needMiners) * 100)}%）`,
        });
    }
    if (nearCoverage !== null && nearCoverage < 0.8) {
        /* 覆盖率低本身不是问题 —— 厂区已经喂满时，旁边的矿用不上才是对的。
           真正该报的是"**产线还有缺口，而且旁边就有矿**"这个组合：
           那说明不是没矿可用，是没去用。 */
        const hasSpareOre = nearOre.length - onOre;
        const lineNotFull = miners.length < needMiners;
        if (lineNotFull && hasSpareOre > 0) {
            problems.push({
                rule: "R1",
                detail: `产线还没喂满（${miners.length}/${needMiners} 台），而厂区附近还有 `
                    + `${hasSpareOre} 格没开采的矿（覆盖率 ${Math.round(nearCoverage * 100)}%）`
                    + ` —— 不是没矿可用，是没去用`,
            });
        }
    }
    const idle = miners.filter(m => !oreAt.has(`${m.x},${m.y}`));
    if (idle.length) {
        problems.push({
            rule: "R1",
            detail: `${idle.length} 台矿机没压在矿上：${idle.slice(0, 5).map(m => `(${m.x},${m.y})`).join(" ")}`,
        });
    }
    return {
        rule: "R1", ok: problems.length === 0,
        data: { minerCount: miners.length, needMiners, beltSpeed,
            nearCoverage: nearCoverage === null ? null : +nearCoverage.toFixed(2),
            oreNearPlant: nearOre.length },
        problems,
    };
}

/* ═══════════════════════════ R2：hub 槽独占 ═══════════════════════════ */

/**
 * R2 — 每条产线独占一个 hub 槽，禁止在 hub 前合流；hub 16 格内不建厂。
 *
 * hub 有 16 个入口（12 格 + 4 角格双向）。把 N 条线并在一条带上再进 hub，
 * 等于把 N 条带的吞吐压成 1 条。
 */
function checkR2(obs) {
    const hub = obs.entities.find(e => e.type === "hub");
    const problems = [];
    if (!hub) return { rule: "R2", ok: true, data: { skipped: "no-hub" }, problems };

    // hub 4x4 外的 16 个入口格（外缘那一圈）
    const slots = [];
    for (let i = 0; i < 4; i++) {
        slots.push([hub.x + i, hub.y - 1]);       // 上
        slots.push([hub.x + i, hub.y + 4]);       // 下
        slots.push([hub.x - 1, hub.y + i]);       // 左
        slots.push([hub.x + 4, hub.y + i]);       // 右
    }

    // 哪些槽有带子指向 hub
    const beltAt = new Map();
    for (const e of obs.entities) {
        if (e.type === "belt" || e.type === "underground_belt") beltAt.set(`${e.x},${e.y}`, e);
    }
    const usedSlots = slots.filter(([x, y]) => beltAt.has(`${x},${y}`));

    // 16 格缓冲区内有多少非矿机/带子/隧道的实体
    const nearHub = obs.entities.filter(e => {
        if (["hub", "belt", "underground_belt", "miner"].includes(e.type)) return false;
        const dx = Math.max(hub.x - e.x, 0, e.x - (hub.x + 3));
        const dy = Math.max(hub.y - e.y, 0, e.y - (hub.y + 3));
        return Math.max(dx, dy) <= 4;                 // hub 外 4 格内
    });
    if (nearHub.length) {
        problems.push({
            rule: "R2",
            detail: `hub 4 格缓冲区内有 ${nearHub.length} 台机器：`
                + `${nearHub.slice(0, 5).map(e => `${e.type}(${e.x},${e.y})`).join(" ")}`
                + ` —— 后期 16 路进料会没地方放`,
        });
    }
    return {
        rule: "R2", ok: problems.length === 0,
        data: { hubSlotsAvailable: 16, hubSlotsUsed: usedSlots.length,
            usedSlotCells: usedSlots.map(s => s.join(",")) },
        problems,
    };
}

/* ═══════════════════════════ R3：每个输出必须有 sink ═══════════════════════════ */

/**
 * R3 — 任何机器的每个输出槽都必须有去处（下游/垃圾站/仓库）。
 *
 * 这是**最容易犯、后果最严重**的一条：机器只有 2 个 charge 的内部队列，
 * 输出堵一次就停摆。
 *
 * 判据不能只看 `progress === 1`：那是"手上有一个成品在等"，正常的背压也会这样。
 * 实测铜线 7 台机器都显示 progress=1，而工厂照样出料 1.23/s —— 因为那些是
 * 间歇的（产一个、送走、再产一个）。
 *
 * 真正的判据是**它动不动**：同一批 ejector 槽在两个时间点上 progress 完全不变，
 * 才是真的卡死。所以这里要求调用方给两次采样（`itemsNow` / `itemsBefore`）。
 * 没有前值时退化成"全槽 progress=1"的粗判，并在 data 里标注 low_confidence。
 */
function checkR3(itemsNow, itemsBefore) {
    const problems = [];
    const paths = itemsNow.paths || [];

    /* `boundAcceptor` 为 null = 这条带子的末端没有接收者。
       `itemsOnPath > 0` 才是"真的在堵"；空且无接收者的短带可能是中间态。 */
    const deadEnds = paths.filter(p => p.boundAcceptor === null && p.itemsOnPath > 0);
    for (const p of deadEnds.slice(0, 8)) {
        problems.push({
            rule: "R3",
            detail: `死路带子 ${JSON.stringify(p.cells[0])}..${JSON.stringify(p.cells[p.cells.length - 1])}`
                + `（${p.cells.length} 格）堆了 ${p.itemsOnPath} 个物品，末端没有接收者 —— 上游会被堵死`,
        });
    }

    const keyOf = e => `${e.cell.join(",")}#${e.slot}`;
    const now = new Map();
    for (const e of itemsNow.ejectors || []) now.set(keyOf(e), e);
    const before = itemsBefore ? new Map((itemsBefore.ejectors || []).map(e => [keyOf(e), e])) : null;

    // 按机器分组
    const byMachine = new Map();
    for (const [k, e] of now) {
        const cell = e.cell.join(",");
        if (!byMachine.has(cell)) byMachine.set(cell, []);
        byMachine.get(cell).push({ k, e });
    }

    let stalled = 0, partial = 0;
    for (const [cell, list] of byMachine) {
        const allFull = list.every(x => x.e.progress >= 0.999);
        if (!allFull) { partial++; continue; }
        /* 有两次采样时用"完全没动"作判据；没有时退回粗判并标注置信度低。 */
        const frozen = before
            ? list.every(x => { const b = before.get(x.k); return b && b.progress === x.e.progress; })
            : true;
        if (!frozen) { partial++; continue; }
        stalled++;
        if (stalled <= 6) {
            problems.push({
                rule: "R3",
                detail: `机器 (${cell}) 的所有输出槽卡死（${list[0].e.item}，progress 在 `
                    + `${before ? "两次采样间完全没动" : "本次采样全为 1"}）`
                    + ` —— 这台机器已经完全停摆，上游会被它堵住`,
            });
        }
    }

    return {
        rule: "R3", ok: problems.length === 0,
        data: {
            deadEndPaths: deadEnds.length, stalledMachines: stalled,
            partiallyBlocked: partial, totalPaths: paths.length,
            low_confidence: !before,
        },
        problems,
    };
}

/* ═══════════════════════════ R4：升级同档 ═══════════════════════════ */

/**
 * R4 — 四条升级线等级差 ≤ 1，且先升瓶颈。
 *
 * 倍率是加法（1→1.5→2→3...），不同档会让配比漂移：
 * 带 L3 / 矿机 L0 ⇒ 需要 15 台矿机喂一条带，而不是 5 台。
 */
function checkR4(obs) {
    const up = obs.upgrades || {};
    const lv = { belt: up.belt | 0, miner: up.miner | 0,
        processors: up.processors | 0, painting: up.painting | 0 };
    const vals = Object.values(lv);
    const spread = Math.max(...vals) - Math.min(...vals);
    const problems = [];
    if (spread > 1) {
        const hi = Object.entries(lv).sort((a, b) => b[1] - a[1])[0];
        const lo = Object.entries(lv).sort((a, b) => a[1] - b[1])[0];
        problems.push({
            rule: "R4",
            detail: `升级档位相差 ${spread} 档（${hi[0]}=L${hi[1]} vs ${lo[0]}=L${lo[1]}）`
                + ` —— 倍率是加法，不同档会让配比漂移。`
                + `例如带 L${lv.belt} / 矿机 L${lv.miner} 时，一条带需要 `
                + `${machinesForOneBelt("miner", { belt: lv.belt, miner: lv.miner })} 台矿机`,
        });
    }
    // 只升带子不升矿机 = 白丢产能（研究 01 的第 8 条外行特征）
    if (lv.belt > lv.miner) {
        problems.push({
            rule: "R4",
            detail: `带子 L${lv.belt} 高于矿机 L${lv.miner}：矿机是瓶颈，升带子对产量零贡献。`
                + `应该先升矿机`,
        });
    }
    return { rule: "R4", ok: problems.length === 0, data: { levels: lv, spread }, problems };
}

/* ═══════════════════════════ R8：验收口径 ═══════════════════════════ */

/**
 * R8 — 报告必须给吞吐/配比/占用，不能只给"关卡通过"。
 *
 * 这条是元规则：它约束**我们怎么汇报**。这里把它变成"必须存在的数据"，
 * 缺任何一项就说明这份审计不完整。
 */
function checkR8(obs, production) {
    const problems = [];
    const required = {
        "实测 delivered/s": production && production.delivered_per_sec,
        "升级线等级": obs.upgrades,
        "hub 槽占用": obs.entities.some(e => e.type === "hub"),
        "矿机数": obs.entities.some(e => e.type === "miner"),
    };
    for (const [name, v] of Object.entries(required)) {
        if (v === undefined || v === null) problems.push({ rule: "R8", detail: `缺少必需指标：${name}` });
    }
    return { rule: "R8", ok: problems.length === 0, data: {}, problems };
}

/* ═══════════════════════════ 主流程 ═══════════════════════════ */

async function snapshot() {
    const loop = await rpc("debug_loop", {});
    const obs = await rpc("obs", { max_entities: 6000, include_hub: true, include_stats: true, include_resources: true, max_resources: 30000, region: [-60, -60, 60, 60] }, 180000);
    let production = null;
    try { production = await rpc("production", { slices: 6 }); } catch (e) { /* 新存档可能还没数据 */ }

    /* R3 需要两次采样：progress=1 本身是正常背压，只有"两次采样间完全没动"
       才是真卡死。先取一次，推进 20 游戏秒，再取一次。 */
    const itemsBefore = await rpc("debug_items", { region: [-60, -60, 60, 60] }, 120000);
    try { await rpc("act", { op: "step", ticks: 2400 }); } catch (e) { /* 时钟没开就跳过 */ }
    const items = await rpc("debug_items", { region: [-60, -60, 60, 60] }, 120000);

    return {
        loop,
        obs: {
            upgrades: (obs.goal && obs.goal.upgrade_levels) || {},
            entities: obs.entities || [],
            oreCells: (obs.resources || []).map(([x, y, kind]) => ({ x, y, kind })),
            goal: obs.goal,
            hub: obs.hub,
        },
        items,
        itemsBefore,
        production,
    };
}

async function run(asJson) {
    const { loop, obs, items, itemsBefore, production } = await snapshot();

    // 时钟闸：在冻结的世界上任何审计都没有意义（这一轮踩过）
    const clockOk = loop.speed === "regular" && loop.logic_budget_ms !== null && loop.logic_budget_ms !== undefined;
    if (!clockOk) {
        const msg = `时钟异常：speed=${loop.speed} budget=${loop.logic_budget_ms} —— 先修时钟（debug_loop）`;
        if (asJson) console.log(JSON.stringify({ ok: false, fatal: "clock", detail: msg }, null, 2));
        else console.error("✗ " + msg);
        return 1;
    }

    const results = [
        checkR1(obs),
        checkR2(obs),
        checkR3(items, itemsBefore),
        checkR4(obs),
        checkR8(obs, production),
    ];

    const allProblems = results.flatMap(r => r.problems);
    const ok = allProblems.length === 0;

    if (asJson) {
        console.log(JSON.stringify({ ok, results, problems: allProblems }, null, 2));
    } else {
        console.log("═".repeat(70));
        console.log("结构审计（研究 01 §8 的强制规则）");
        console.log("═".repeat(70));
        for (const r of results) {
            const mark = r.ok ? "✓" : "✗";
            const d = r.data && Object.keys(r.data).length
                ? Object.entries(r.data).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ")
                : "";
            console.log(`${mark} ${r.rule.padEnd(4)} ${d}`);
            for (const p of r.problems) console.log(`     ${p.detail}`);
        }
        console.log("");
        console.log(ok ? "✓ 全部通过" : `✗ ${allProblems.length} 个结构问题`);
        if (!ok) {
            const byRule = {};
            for (const p of allProblems) byRule[p.rule] = (byRule[p.rule] || 0) + 1;
            console.log("  按规则: " + Object.entries(byRule).map(([k, v]) => `${k}×${v}`).join(" "));
        }
    }
    return ok ? 0 : 2;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/audit.mjs");
if (isMain) {
    run(process.argv.includes("--json"))
        .then(c => process.exit(c))
        .catch(e => { console.error("✗ " + e.message); process.exit(1); });
}

export { checkR1, checkR2, checkR3, checkR4, checkR8 };
