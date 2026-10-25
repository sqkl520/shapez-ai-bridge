/**
 * assess.mjs — 看局势：现在有什么、缺什么、下一步该干什么。
 *
 * 这是"像人一样玩"的核心：不按脚本推进，而是**每次根据存档当前状态决定下一步**。
 *
 * 输入：一次 obs（世界实体 + hub 库存 + 目标 + 升级等级）
 * 输出：结构化的差距清单 + 建议动作（按优先级排序）
 *
 * 判断依据全部来自 rules.mjs（可复核的源码规则），不是拍脑袋。
 */
import {
    RATES, UPGRADES, UPGRADE_MULTIPLIERS, FIXED_ORES,
    machinesForOneBelt, machinesPerBelt, LAYOUT_RULES,
} from "./rules.mjs";

/**
 * @typedef {object} Obs  简化后的观测：{
 *   level, goal: {shape, required, delivered},
 *   stored: {shape: count}, upgrades: {line: level},
 *   entities: [{type, x, y}], oreCells: [{x,y,kind}]
 * }
 */

/**
 * 目标形状需要哪些**工序**。
 *
 * 这是"像人一样玩"最关键的一步：先看懂目标要什么，才知道该造什么。
 * 我这一轮反复在"造了矿机却达不成目标"上浪费时间 —— 因为目标是 RuRu----（切半），
 * 而我只是在产 RuRuRuRu（整块）。
 *
 * 判据（shapez 形状代数）：
 *   · 任意位置有空缺 ⇒ 该形状是**切**出来的
 *   · 含 ':' ⇒ 是**叠**出来的（多层）
 *   · 四个象限颜色不同 ⇒ 是**染/mix**出来的
 */
export function requiredOps(goalShape, knownMinerals = []) {
    const ops = [];
    if (!goalShape) return ops;

    // 多层：RuRu----:CuCuCuCu 之类
    if (goalShape.includes(":")) ops.push({ op: "stack", why: "含 ':' ⇒ 多层叠成" });

    const flat = goalShape.split(":")[0];
    // 每层 8 字符 = 4 象限 × 色号
    const quads = [];
    for (let i = 0; i + 1 < flat.length; i += 2) quads.push(flat.slice(i, i + 2));

    const hasEmpty = quads.some(q => q === "--");
    const nonEmpty = quads.filter(q => q !== "--");
    const colors = new Set(nonEmpty.map(q => q[0]));

    if (hasEmpty && nonEmpty.length) {
        ops.push({
            op: "cut",
            why: `${quads.length} 个象限里有 ${quads.filter(q => q === "--").length} 个空缺 ⇒ 必须切的`,
            /** 切几次：半切一次出两半；如果两个空缺不连续，可能要四切 */
            note: nonEmpty.length === 2 && quads.filter(q => q === "--").length === 2 ? "半切一刀" : "可能需要四切",
        });
    }
    if (colors.size > 1) {
        ops.push({ op: "paint", why: `含 ${[...colors].join("/")} 多种颜色` });
    }
    // 全色号相同且无空缺 ⇒ 直接采矿即可
    if (!hasEmpty && colors.size <= 1) {
        ops.push({ op: "mine", why: "全象限同色无空缺 ⇒ 挖整块即可" });
    }
    return ops;
}

/** 某形状是"挖"出来的还是"加工"出来的 */
export function isRawShape(shape, knownMinerals) {
    const ops = requiredOps(shape);
    return ops.length === 1 && ops[0].op === "mine";
}

/** 某形状还差多少（关卡目标） */
function goalGap(obs) {
    const g = obs.goal;
    if (!g || !g.shape) return null;
    return {
        shape: g.shape,
        required: g.required || 0,
        delivered: g.delivered || 0,
        remaining: Math.max(0, (g.required || 0) - (g.delivered || 0)),
        // 关卡进度读的是 stored[shape]（hub_goals.js:150-165），与升级共用同一个池
        stored: obs.stored[g.shape] || 0,
    };
}

/** 各升级线离下一档还差什么 */
function upgradeGaps(obs) {
    const out = [];
    for (const [line, tiers] of Object.entries(UPGRADES)) {
        const lvl = obs.upgrades[line] || 0;
        const next = tiers.find(t => t.tier === lvl + 1);
        if (!next) continue;                          // 已满或未登记
        const missing = next.required.map(req => ({
            shape: req.shape,
            amount: req.amount,
            have: obs.stored[req.shape] || 0,
            short: Math.max(0, req.amount - (obs.stored[req.shape] || 0)),
        }));
        out.push({
            line, tier: lvl + 1,
            affordable: missing.every(m => m.short === 0),
            missing,
            multiplierAfter: UPGRADE_MULTIPLIERS[Math.min(lvl + 1, UPGRADE_MULTIPLIERS.length - 1)],
        });
    }
    return out;
}

/**
 * 产能评估：现在有多少台矿机、能喂满几条带、瓶颈在哪。
 *
 * 这是这一轮我最缺的东西 —— 我一直不知道"1 台矿机"意味着什么。
 */
function throughput(obs) {
    const miners = obs.entities.filter(e => e.type === "miner");
    const perBelt = machinesForOneBelt("miner", obs.upgrades);
    const beltSpeed = RATES.beltPerSec * UPGRADE_MULTIPLIERS[Math.min(obs.upgrades.belt || 0, 7)];
    const minerSpeed = RATES.minerPerSec * UPGRADE_MULTIPLIERS[Math.min(obs.upgrades.miner || 0, 7)];
    const total = miners.length * minerSpeed;

    // 每台矿机压着什么矿
    const oreAt = new Map(obs.oreCells.map(c => [`${c.x},${c.y}`, c.kind]));
    const mining = miners.map(m => ({
        at: [m.x, m.y],
        onOre: oreAt.get(`${m.x},${m.y}`) || null,
    }));
    const idle = mining.filter(m => !m.onOre);

    return {
        minerCount: miners.length,
        minerSpeedPerSec: +minerSpeed.toFixed(3),
        totalPerSec: +total.toFixed(3),
        beltsFed: +(total / beltSpeed).toFixed(2),
        minersPerBeltNeeded: perBelt,
        beltSpeedPerSec: beltSpeed,
        /** 闲置（没压在矿上）的矿机 —— 纯浪费 */
        idleMiners: idle,
    };
}

/** 矿点利用率：周边有多少矿格，用了几格 */
function oreUtilization(obs) {
    const counts = {};
    for (const c of obs.oreCells) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const used = {};
    for (const m of obs.entities.filter(e => e.type === "miner")) {
        const k = obs.oreCells.find(c => c.x === m.x && c.y === m.y);
        if (k) used[k.kind] = (used[k.kind] || 0) + 1;
    }
    return Object.keys(counts).sort().map(kind => ({
        kind, available: counts[kind], used: used[kind] || 0,
        utilization: counts[kind] ? +((used[kind] || 0) / counts[kind]).toFixed(2) : 0,
    }));
}

/**
 * 下一步建议。按"投入产出比 × 紧迫度"排。
 *
 * 优先级逻辑（来自攻略，不是拍脑袋）：
 *   1. 闲置矿机 → 立刻修（纯浪费，零成本）
 *   2. 能立刻买的升级 → 买（白送的产能）
 *   3. 关卡缺口大 → 加矿机（前 5 关瓶颈 100% 是矿机数）
 *   4. 矿格利用率低 → 铺满矿簇（同 3）
 *   5. 升级材料差得不多 → 建专线（升级供应链，别靠关卡顺带）
 */
function nextActions(obs, gaps) {
    const acts = [];
    const tp = gaps.throughput;
    const util = gaps.oreUtilization;

    // 1. 闲置矿机
    if (tp.idleMiners.length) {
        acts.push({
            priority: 1, kind: "fix-idle-miner",
            reason: `${tp.idleMiners.length} 台矿机没压在矿上（纯浪费）`,
            detail: tp.idleMiners.map(m => m.at),
        });
    }

    // 2. 能买就买
    for (const u of gaps.upgrades.filter(x => x.affordable)) {
        acts.push({
            priority: 2, kind: "buy-upgrade", line: u.line, tier: u.tier,
            reason: `${u.line} T${u.tier} 已够料（倍率 → ${u.multiplierAfter}×），白送的产能`,
        });
    }

    // 3. 关卡缺口 + 工序链
    const g = gaps.goal;
    if (g && g.remaining > 0) {
        const currentRate = tp.totalPerSec;
        const etaSec = currentRate > 0 ? Math.ceil(g.remaining / currentRate) : Infinity;
        const ops = requiredOps(g.shape);
        const missingOps = ops.filter(o => o.op !== "mine");

        acts.push({
            priority: 3, kind: "grow-production",
            reason: `目标 ${g.shape} 还差 ${g.remaining}（当前 ${currentRate.toFixed(2)}/s，约 ${etaSec}s）`,
            /** 加一台矿机能省多少秒 —— 让"加矿机"的价值可量化 */
            marginalGain: currentRate > 0
                ? Math.round(g.remaining / currentRate - g.remaining / (currentRate + tp.minerSpeedPerSec))
                : null,
            suggestedMiners: Math.max(0, Math.ceil(g.remaining / 30 / tp.minerSpeedPerSec) - tp.minerCount),
        });

        /* ★ 缺工序 ⇒ 光加矿机没用 ★
           RuRu---- 是切出来的，只有矿机永远达不成目标。这条以前完全缺失，
           于是我建了矿机却不知道该接切割机，白白等产量。
           ⚠️ 判据不能只看"世界里有没有 cutter" —— 旧产线留下的孤儿切割机也算存在，
           但它没接上游/下游。所以要看**工序链是否完整**：目标需要的机器，
           必须真的连在从矿机到 hub 的线上。这里用简化判据：机器存在 + 它的四邻
           至少有一个带子或矿机（孤立机器视为不存在）。 */
        if (missingOps.length) {
            /* 判据：机器必须**在从矿机到 hub 的连通块里**。
               只看"有没有邻居"不够 —— 旧产线留下的孤儿机器也连着它自己的残骸带子。
               做法：从所有矿机出发，沿带子做一次 BFS，看能走到哪些机器。
               走不到的机器 = 孤立，视为不存在。 */
            const byCell = new Map();
            for (const e of obs.entities) byCell.set(`${e.x},${e.y}`, e);
            const seen = new Set();
            const queue = obs.entities.filter(e => e.type === "miner").map(e => `${e.x},${e.y}`);
            for (const k of queue) seen.add(k);
            while (queue.length) {
                const k = queue.shift();
                const [x, y] = k.split(",").map(Number);
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nk = `${x + dx},${y + dy}`;
                    if (seen.has(nk) || !byCell.has(nk)) continue;
                    seen.add(nk);
                    queue.push(nk);
                }
            }
            const reachable = (type) => obs.entities.some(e => e.type === type && seen.has(`${e.x},${e.y}`));
            const lacks = [];
            if (missingOps.some(o => o.op === "cut") && !reachable("cutter")) {
                lacks.push({ op: "cut", why: "没有任何**接在矿机产线上**的切割机" });
            }
            if (missingOps.some(o => o.op === "stack") && !reachable("stacker")) {
                lacks.push({ op: "stack", why: "没有任何接在产线上的堆叠机" });
            }
            if (missingOps.some(o => o.op === "paint") && !reachable("painter")) {
                lacks.push({ op: "paint", why: "没有任何接在产线上的上色机" });
            }
            if (missingOps.some(o => o.op === "mix") && !reachable("mixer")) {
                lacks.push({ op: "mix", why: "没有任何接在产线上的调色器" });
            }
            if (lacks.length) {
                acts.push({
                    priority: 2, kind: "add-machine",
                    reason: `目标 ${g.shape} 需要 ${lacks.map(l => l.op).join("+")}，但${lacks.map(l => l.why).join("；")}`,
                    machines: lacks.map(l => l.op),
                    note: "光加矿机不会达成目标：矿机只产原料形状",
                });
            }
        }
    }

    // 4. 矿格利用率
    const lowUtil = util.filter(u => u.available >= 4 && u.utilization < 0.5);
    for (const u of lowUtil) {
        acts.push({
            priority: 4, kind: "fill-ore-cluster", kind_: u.kind,
            reason: `${u.kind} 有 ${u.available} 格但只用了 ${u.used} 格（${(u.utilization * 100).toFixed(0)}%）`,
            suggestMiners: Math.min(u.available - u.used, 8),
        });
    }

    // 5. 升级材料专线
    for (const u of gaps.upgrades.filter(x => !x.affordable)) {
        const totalShort = u.missing.reduce((a, m) => a + m.short, 0);
        if (totalShort > 0 && totalShort < 5000) {
            acts.push({
                priority: 5, kind: "build-upgrade-line", line: u.line, tier: u.tier,
                reason: `${u.line} T${u.tier} 还差 ${totalShort}（${u.missing.map(m => `${m.shape}×${m.short}`).join(", ")}）`,
                note: "升级材料要独立产线，不能靠关卡顺带（需求 300-600 远超单关 30-170）",
            });
        }
    }

    return acts.sort((a, b) => a.priority - b.priority);
}

/**
 * 主入口：吃 obs，出完整评估。
 */
export function assess(obs) {
    const goal = goalGap(obs);
    const upgrades = upgradeGaps(obs);
    const tp = throughput(obs);
    const oreUtil = oreUtilization(obs);
    const gaps = { goal, upgrades, throughput: tp, oreUtilization: oreUtil };
    const actions = nextActions(obs, gaps);

    return {
        level: obs.level,
        goal,
        upgrades,
        throughput: tp,
        oreUtilization: oreUtil,
        /** 一句话现状 */
        headline: describe(gaps),
        actions,
    };
}

function describe(g) {
    const parts = [];
    const t = g.throughput;
    parts.push(`${t.minerCount} 台矿机，合计 ${t.totalPerSec}/s(`);
    parts[parts.length - 1] = `${t.minerCount} 台矿机合计 ${t.totalPerSec}/s`;
    parts.push(`只喂满 ${t.beltsFed} 条带`);
    const low = g.oreUtilization.filter(u => u.available >= 4 && u.utilization < 0.5);
    if (low.length) parts.push(`闲置矿簇：${low.map(u => `${u.kind} ${u.used}/${u.available}`).join(" ")}`);
    if (t.idleMiners.length) parts.push(`⚠ ${t.idleMiners.length} 台矿机没压在矿上`);
    if (g.goal) parts.push(`目标 ${g.goal.shape} 还差 ${g.goal.remaining}`);
    return parts.join("，");
}

/* 自测：拿一个"当前状态"的假数据跑一遍，看它说的话对不对 */
if (process.argv[1] && process.argv[1].endsWith("assess.mjs")) {
    const sample = {
        level: 4,
        goal: { shape: "RuRu----", required: 70, delivered: 0 },
        stored: { CuCuCuCu: 12, RuRuRuRu: 311, "----RuRu": 4495, "----CuCu": 686 },
        upgrades: { belt: 1, miner: 1, processors: 0, painting: 0 },
        entities: [{ type: "miner", x: 2, y: -6 }, { type: "cutter", x: 2, y: -14 }],
        oreCells: [
            { x: 2, y: -6, kind: "RuRuRuRu" }, { x: 3, y: -6, kind: "RuRuRuRu" },
            { x: 4, y: -6, kind: "RuRuRuRu" }, { x: 5, y: -6, kind: "RuRuRuRu" },
        ],
    };
    const r = assess(sample);
    console.log("现状:", r.headline);
    console.log("\n建议动作:");
    for (const a of r.actions) console.log(`  [P${a.priority}] ${a.kind}: ${a.reason}`);
}
