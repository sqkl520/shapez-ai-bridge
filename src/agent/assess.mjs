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
    MACHINE_UPGRADE_LINE, SHAPES_PER_CHARGE, PRODUCT_PER_CHARGE, machineRatePerSec,
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

/**
 * 产能链分析：**供给 → 处理 → 交付**，瓶颈在哪一段。
 *
 * ## 这个函数为什么存在
 *
 * 用户的原话：「明明有可以快捷提高产能的方法却没有用」。
 * 实测的 L4 存档（`belt:1 miner:1 processors:0`，3 台矿机）：
 *
 *   供给 3 × 0.60 = 1.80/s     处理 1 × 0.50 = 0.50/s     ⇒ 利用率 28%
 *
 * 也就是 **72% 的矿机产出堵在单台 cutter 前面**。而当时的 prompt 里
 * 只有矿机台数和带子条数，没有任何一句说「你现在卡在哪、加什么最划算」。
 * 模型就算推理满分，也没有数据支撑「加 cutter 比加矿机划算」这个判断。
 *
 * ## 判据（全部来自 rules.mjs，不拍脑袋）
 *
 *   · 供给 = Σ 压在矿上的矿机 × 该机速率（`machineRatePerSec("miner", levels)`）
 *   · 处理 = Σ 每种**加工机器**数量 × 该机速率 × 每 charge 吃进/产出的形状数
 *     （`SHAPES_PER_CHARGE` / `PRODUCT_PER_CHARGE`）
 *   · 只统计**在产线上**的机器（从矿机出发沿带子 BFS 能走到的）。
 *     孤立的旧机器不参与 —— 否则「有一台没接线的 cutter」会让利用率虚高。
 *   · 瓶颈 = 供给与处理里较小的那个；另一侧就是「堵住的」那一侧。
 *
 * ## 已知边界（诚实写出来，不假装）
 *
 *   · **是一条链的近似，不是真流网络**。存档里多条独立产线时，这里把它们的产能
 *     加在一起比较，可能低估单链上的堵塞。判据用「总供给 vs 总处理」，
 *     那是这个 agent 现阶段唯一能可靠算出的东西。
 *   · 只算「矿机 → 第一道加工」这一段。更深的链（cut→paint→stack）没有逐步模拟。
 *   · 不带 resources（`obs.oreCells` 为空）时算不出「压在矿上」，于是**全部**矿机
 *     都算进供给 —— 会偏高。`confidence` 字段会标出来。
 *
 * @returns {object} 见下面 return 的点
 */
export function capacityOf(obs) {
    const levels = obs.upgrades || {};
    const entities = Array.isArray(obs.entities) ? obs.entities : [];
    const oreCells = Array.isArray(obs.oreCells) ? obs.oreCells : [];

    const minerRate = machineRatePerSec("miner", levels);
    const beltRate = RATES.beltPerSec * UPGRADE_MULTIPLIERS[Math.min(levels.belt | 0, UPGRADE_MULTIPLIERS.length - 1)];

    /* ── 1. 谁在产线上：从所有矿机出发，沿带子/机器格 BFS ──
       不算这一步的话，一座废弃工厂里的孤儿机器会被算进处理能力。 */
    const byCell = new Map(entities.map(e => [`${e.x},${e.y}`, e]));
    const miners = entities.filter(e => e.type === "miner");
    const commandeered = new Set();
    const queue = miners.map(m => `${m.x},${m.y}`);
    for (const k of queue) commandeered.add(k);
    while (queue.length) {
        const k = queue.shift();
        const [x, y] = k.split(",").map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${x + dx},${y + dy}`;
            if (commandeered.has(nk) || !byCell.has(nk)) continue;
            const nb = byCell.get(nk);
            /* 只沿带子和机器走；hub 是端点，穿不过去（hub 后面没有产线） */
            if (nb.type === "hub") { commandeered.add(nk); continue; }
            commandeered.add(nk);
            queue.push(nk);
        }
    }
    const onLine = e => commandeered.has(`${e.x},${e.y}`);

    /* ── 2. 矿机：压没压在矿上 ── */
    const oreAt = new Map(oreCells.map(c => [`${c.x},${c.y}`, c.kind]));
    const mining = miners.map(m => ({ at: [m.x, m.y], onOre: oreAt.get(`${m.x},${m.y}`) || null }));
    const idle = mining.filter(m => !m.onOre);
    /* resources 没给时 onOre 一律 null，不能据此说"全都没压在矿上" ——
       那会把一座正常工厂报成 0 产能。此时按「全在挖」算，并降 confidence。 */
    const haveOreMap = oreCells.length > 0;
    const activeMiners = haveOreMap ? miners.length - idle.length : miners.length;

    const supply = activeMiners * minerRate;

    /* ── 3. 加工机器：处理能力（按**成品**出件口径，与供给同单位） ── */
    const PROCESSORS = ["cutter", "rotater", "stacker", "painter", "painterDouble", "painterQuad", "mixer"];
    const machines = [];
    for (const kind of PROCESSORS) {
        const list = entities.filter(e => e.type === kind && onLine(e));
        if (!list.length) continue;
        const rate = machineRatePerSec(kind, levels);
        const per = PRODUCT_PER_CHARGE[kind] === undefined ? 1 : PRODUCT_PER_CHARGE[kind];
        machines.push({
            kind,
            count: list.length,
            ratePerSec: +rate.toFixed(3),
            productPerSec: +(list.length * rate * per).toFixed(3),
            /** 这条机器吃哪条升级线（给「升哪条线」的建议用） */
            upgradeLine: MACHINE_UPGRADE_LINE[kind] || null,
        });
    }
    /* 处理能力 = 各**串联工序**里最窄的那一段。
       简化：当前仓库的产线几乎都是「矿机 → 单道工序 → hub」，
       所以取**最小**的那一类机器的产能（并联的不同机器种类视为串联）。
       多类机器时这是保守估计 —— 宁可说"更堵"也不说"更通"。 */
    const processCapacity = machines.length
        ? Math.min(...machines.map(m => m.productPerSec))
        : null;

    /* ── 4. 带子：只作参考，**不参与**瓶颈判定 ──
     *
     * 为什么不参与：`N 条带 × 带速` 不是「路的容量」。一条工厂的真实通过能力取决于
     * **串/并联拓扑**（单链上串联的带子是 1 条带的容量，不是 N 倍）。拿一堆实体的
     * 数量去乘带速会得到 160 条带 = 480/s 这种荒唐数字，然后它永远不是瓶颈，
     * 于是「路」这一段就等于没算 —— 却让 utilization 看起来有依据。
     * 宁可明说「这一段没算」，也不给一个假精度。
     * （真要做需要拓扑；`loop/prompt.mjs` 的 `pickBeltsForGoal` 里有连通分量，
     *   但那是另一层，不该在这里复制。） */
    const beltCount = entities.filter(e => (e.type === "belt" || e.type === "underground_belt") && onLine(e)).length;

    /* ── 5. 结论 ── */
    let bottleneck = "none";
    let bottleneckDetail = "no production chain found";
    let bottleneckMachine = null;
    let utilization = null;
    if (processCapacity === null) {
        if (supply > 0) {
            bottleneck = "no-processor";
            bottleneckDetail = `${activeMiners} 台矿机在产 ${supply.toFixed(2)}/s，但产线上**一台加工机器都没有**`;
        }
    } else if (supply > 0 || processCapacity > 0) {
        /* 只比 supply vs process 两段。path 段见上面第 4 条（刻意不算）。 */
        const worst = processCapacity < supply ? "process" : "supply";
        bottleneck = worst;
        /* 利用率口径写死：**处理能力 / 供给**（都是 items/s）。
           矿不够时 process > supply ⇒ 夹到 1.0，读作「没有东西堵」，
           不能写成 >1（那读起来像"超产"）。 */
        utilization = supply > 0 ? Math.min(1, processCapacity / supply) : null;
        if (worst === "process") {
            const tightest = machines.reduce((a, b) => (b.productPerSec < a.productPerSec ? b : a));
            bottleneckDetail = `${tightest.count} 台 ${tightest.kind} 只能处理 ${tightest.productPerSec.toFixed(2)}/s，`
                + `而 ${activeMiners} 台矿机在产 ${supply.toFixed(2)}/s`
                + (utilization !== null ? ` —— ${Math.round((1 - utilization) * 100)}% 的产出堵在这里` : "");
            bottleneckMachine = tightest.kind;
        } else {
            bottleneckDetail = `矿只有 ${supply.toFixed(2)}/s，是整条链最窄的一段（处理能力 ${processCapacity.toFixed(2)}/s 有余）`;
        }
    }

    return {
        /* 四条线**一律补齐为数字**。不补的话调用方会拿到 `levels.miner === undefined`，
           再拿它去查 `UPGRADE_MULTIPLIERS[undefined]` 就是 undefined —— 后面乘以它得 NaN。
           归一化放在这里（唯一出口），别让每个调用方自己 `|| 0`。 */
        levels: {
            belt: levels.belt | 0,
            miner: levels.miner | 0,
            processors: levels.processors | 0,
            painting: levels.painting | 0,
        },
        miners: { count: miners.length, active: activeMiners, idle: idle.length, ratePerSec: +minerRate.toFixed(3) },
        supplyPerSec: +supply.toFixed(3),
        process: { capacityPerSec: processCapacity === null ? null : +processCapacity.toFixed(3), machines },
        /** 带子只报**数量**，不报"容量" —— 理由见上面第 4 条 */
        path: { beltsOnLine: beltCount, beltRatePerSec: beltRate, capacityComputed: false },
        bottleneck,
        bottleneckMachine,
        bottleneckDetail,
        /** 处理能力 ÷ 供给。1.0 = 平衡；<1 = 产出堵住。null = 无法判定 */
        utilization,
        /** 这个数的可信度。`low` 时不许拿它做结论 */
        confidence: haveOreMap ? (entities.length ? "ok" : "low") : "low",
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
 * 「加机器」与「升升级」两条路的**可比较**选项。
 *
 * 用户的原话是「明明有可以快捷提高产能的方法却没有用」。要回答它，光说「瓶颈在 cutter」
 * 不够 —— 模型需要能比较：
 *
 *   · 再加 N 台 cutter → 处理能力涨到多少（立刻见效，但要占格子）
 *   · 升 processors 到 T(k+1) → 每台机器的速率 ×1.5（一次性、全局、但要材料）
 *
 * 两条路必须放在**同一个数轴**上（都是「处理能力 /s」），否则模型没法比。
 *
 * ## 判据
 *
 *   加机器：`现有台数 + n` × 该机速率 × PRODUCT_PER_CHARGE
 *   升升级：`现有台数` × 该机速率 × 新倍率 × PRODUCT_PER_CHARGE
 *           新倍率 = `UPGRADE_MULTIPLIERS[lvl+1] / UPGRADE_MULTIPLIERS[lvl]`
 *
 * `affordable` 直接来自 `upgradeGaps`（需求表已与源码对账，含 carry-over）。
 *
 * 返回 `null` 表示**无法给出对比**（没有瓶颈机器 / 没有下一档 / 数据不可信）。
 */
function capacityOptions(cap, upgrades, goalShape) {
    if (!cap || cap.confidence !== "ok") return null;
    const kind = cap.bottleneckMachine;
    if (!kind || kind === "belt") return null;
    const levels = cap.levels || {};
    const machineInfo = (cap.process.machines || []).find(m => m.kind === kind);
    if (!machineInfo) return null;

    const line = MACHINE_UPGRADE_LINE[kind];
    if (!line) return null;

    const per = PRODUCT_PER_CHARGE[kind] === undefined ? 1 : PRODUCT_PER_CHARGE[kind];
    const rate = machineInfo.ratePerSec;
    const count = machineInfo.count;
    const current = count * rate * per;

    /* ① 加机器：加到「刚好吃满供给」需要几台 */
    const needed = cap.supplyPerSec > 0
        ? Math.max(count + 1, Math.ceil(cap.supplyPerSec / (rate * per)))
        : count + 1;
    const addKinds = {
        addMachines: {
            kind,
            from: count,
            to: needed,
            add: needed - count,
            capacityAfter: +(needed * rate * per).toFixed(3),
            /** 加完是否已经吃满（≥供给） */
            enough: needed * rate * per >= cap.supplyPerSec - 1e-9,
        },
    };

    /* ② 升升级：这一档升完，**每台**机器的速率变成多少 */
    const lvl = Math.max(0, levels[line] | 0);
    const opt = (upgrades || []).find(u => u.line === line);
    const curMul = UPGRADE_MULTIPLIERS[Math.min(lvl, UPGRADE_MULTIPLIERS.length - 1)];
    const nextMul = UPGRADE_MULTIPLIERS[Math.min(lvl + 1, UPGRADE_MULTIPLIERS.length - 1)];
    const upgradeOption = (opt && nextMul > curMul)
        ? {
            line, tier: opt.tier,
            multiplierFrom: curMul, multiplierTo: nextMul,
            capacityAfter: +(count * rate * per * (nextMul / curMul)).toFixed(3),
            affordable: opt.affordable,
            missing: opt.affordable ? [] : opt.missing.filter(m => m.short > 0)
                .map(m => ({ shape: m.shape, short: m.short })),
        }
        : null;

    /* ③ 哪条更划算：只回答「**不加任何材料**的前提下，哪条更快把供给吃满」 */
    const actions = [];
    const supply = cap.supplyPerSec;
    if (addKinds.addMachines.enough) {
        actions.push({ action: "add-machines", kind, from: count, to: needed, add: needed - count,
            capacityAfter: addKinds.addMachines.capacityAfter, getsTo: "feed-full-supply" });
    }
    if (upgradeOption && upgradeOption.affordable) {
        actions.push({ action: "buy-upgrade", kind, line, tier: upgradeOption.tier,
            capacityAfter: upgradeOption.capacityAfter,
            getsTo: upgradeOption.capacityAfter >= supply - 1e-9 ? "feed-full-supply" : "partial" });
    }
    return {
        bottleneckMachine: kind,
        /* 还要几台同类机器才能吃满供给（含已有） */
        machinesToSaturate: needed,
        current: +current.toFixed(3),
        supply: supply,
        addMachines: addKinds.addMachines,
        upgrade: upgradeOption,
        /** 现在就能做的（白送的优先） */
        doNow: actions,
        goalShape: goalShape || null,
    };
}

/**
 * 原始 obs（`reader.obs()` 的 result，**游戏原样**）→ `assess()` 吃的简化形状。
 *
 * 为什么要有这个适配器：`assess` 的入参是我为了算账自己设计的扁平结构，而 loop 手里的
 * obs 是 mod 原样返回的（`goal.requirement` / `goal.upgrade_levels` / `hub.stored_shapes` /
 * `resources: [[x,y,kind]]`）。这层映射以前在 `look.mjs` / `grow.mjs` / `process.mjs`
 * 各抄了一遍 —— 三份，任何一份漏字段都会静默算错。收成一份。
 *
 * 全部字段都**容错**：缺 `resources` 时 `oreCells` 是 `[]`（不是 undefined），
 * 缺 `goal` 时给 `null` 形状而不是抛 —— 降级由 `capacityOf` 的 `confidence` 表达。
 *
 * @param {object} raw 原始 obs（允许包一层 `{result: …}`）
 */
export function obsForAssess(raw) {
    const o = (raw && typeof raw === "object" && !Array.isArray(raw.entities) && raw.result) ? raw.result : (raw || {});
    const goal = o.goal || {};
    const req = goal.requirement || {};
    const hub = o.hub || {};
    const upgrades = goal.upgrade_levels || o.upgrades || {};
    return {
        level: goal.level,
        goal: req.shape
            ? { shape: req.shape, required: req.required, delivered: req.delivered }
            : null,
        stored: hub.stored_shapes || o.stored || {},
        upgrades,
        entities: (Array.isArray(o.entities) ? o.entities : []).map(e => ({ type: e.type, x: e.x, y: e.y })),
        oreCells: (Array.isArray(o.resources) ? o.resources : [])
            .filter(r => Array.isArray(r) && r.length >= 3)
            .map(r => ({ x: r[0], y: r[1], kind: r[2] })),
    };
}

/**
 * 一步拿到 CAPACITY 段需要的两样东西：`{capacity, options}`。
 *
 * 给 `loop/prompt.mjs` 的 `renderCapacity` 用。存在的理由是**别让调用方自己拼**：
 *   · 入参是**原始 obs**（loop 手里那个），不是简化形状 —— 免得 prompt 层再抄一遍映射；
 *   · `options` 依赖 `upgradeGaps`（需求表 + 已存库存），漏了它「升级这条路」就永远不出现。
 *
 * `raw` 可以是 `{result: …}` 包一层的形态（`reader.obs()` 直接返回的那个）。
 */
export function capacityFor(raw) {
    const obs = obsForAssess(raw);
    const capacity = capacityOf(obs);
    const upgrades = upgradeGaps(obs);
    const options = capacityOptions(capacity, upgrades, obs.goal && obs.goal.shape);
    return { capacity, options, obs };
}

/**
 * 主入口：吃 obs，出完整评估。
 */
export function assess(obs) {
    const goal = goalGap(obs);
    const upgrades = upgradeGaps(obs);
    const tp = throughput(obs);
    const oreUtil = oreUtilization(obs);
    const capacity = capacityOf(obs);
    const options = capacityOptions(capacity, upgrades, goal && goal.shape);
    const gaps = { goal, upgrades, throughput: tp, oreUtilization: oreUtil, capacity, options };
    const actions = nextActions(obs, gaps);

    return {
        level: obs.level,
        goal,
        upgrades,
        throughput: tp,
        capacity,
        options,
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
