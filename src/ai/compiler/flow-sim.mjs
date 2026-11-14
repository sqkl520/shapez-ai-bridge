/**
 * flow-sim.mjs — **离线货流仿真**：不依赖游戏窗口，纯 JS 算「多少件货到了 hub」。
 *
 * ## 为什么需要它（用户的原话）
 *
 * 「不能后台吗？不能后台的话这个项目存在的意义是什么」
 *
 * 前面三步（无头驱动 / 看门狗增强 / step 同步推进）解决的是**让游戏在后台活着**。
 * 但它们仍然需要游戏进程：窗口最小化了、机器休眠了、游戏崩了，就什么都没有。
 *
 * 这一层是真正的离线：给定一份 `obs`（实体列表 + 资源图），
 * **不启动游戏**就能算出「这条产线每秒交付多少件」。它让三件事第一次成立：
 *   1. 批量实验：跑 100 个候选布局，几秒钟出结果；
 *   2. 夜间长跑：不需要任何人盯着窗口；
 *   3. RL 采样：真正的并行（多个进程各算各的，互不干扰）。
 *
 * ## 与 belt-sim.mjs 的分工
 *
 * `belt-sim.mjs` 只解**不动点**（这条带的 r/rv 在邻居下是否稳定）—— 它是 validator。
 * 本文件解**动力学**：货从矿机出来、沿带子走、进机器、被加工、到 hub。
 * 两者共用 `buildWorldModel()` 的空间索引，但循环逻辑完全独立。
 *
 * ## 模型（刻意简化，但每个简化都标了误差方向）
 *
 * · **带子**：每格容量 1，每 tick 前进一格（shapez 的实际行为）。
 *   ⚠️ 真实游戏里带子速度随 belt 升级变快（T1 ×1、T2 ×2、T3 ×3）。
 *   这里用 `beltSpeed` 参数表示「每 tick 前进几格」，默认 1。
 *
 * · **机器**：有 `processingTime` 秒的加工节拍，输入槽有货、输出槽空时才开工。
 *   ⚠️ 真实节拍来自 op-templates 的 `processingTime`；这里读不到就按类型给默认值，
 *   且**在结果里报 `assumed_rates`** —— 不许假装是实测值。
 *
 * · **矿机**：只要脚下有矿、输出槽没堵，就按 `miningSpeed` 产货。
 *
 * · **hub / trash**：进货即销毁（计交付 / 计丢弃）。
 *
 * ⚠️ 明确**不模拟**的：颜色混合的精确语义（只按「有几个不同输入」近似）、
 * 隧道的延迟、balancer 的轮转。这些都会让结果偏乐观或偏悲观 ——
 * 所以本文件的第一职责是**给出可观测量级**，不是替代真机验收。
 *
 * @module flow-sim
 */

import { buildWorldModel } from "./belt-sim.mjs";

const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/** 各类机器的默认加工节拍（秒）。读不到模板真值时的兜底，会在结果里标注。 */
const DEFAULT_PROCESSING_SEC = {
    cutter: 1.0,
    rotater: 1.0,
    stacker: 1.0,
    mixer: 1.0,
    painter: 1.0,
    trash: 0,
    hub: 0,
};

/** 矿机默认产出速率（件/秒）。 */
const DEFAULT_MINER_PER_SEC = 1.0;

/**
 * 从 obs 建一个可推进的仿真世界。
 *
 * @param {object} obs  `reader.obs()` 的 result（要有 entities + 可选 resources + goal）
 * @param {object} [opts]
 * @param {number} [opts.beltSpeed=1]      每 tick 前进几格（belt 升级后 >1）
 * @param {number} [opts.minerPerSec]      矿机产出速率覆盖
 * @param {object} [opts.processingSec]    按类型覆盖加工节拍
 * @returns {object} sim
 */
export function createFlowSim(obs, opts = {}) {
    const o = opts || {};
    const entities = Array.isArray(obs && obs.entities) ? obs.entities : [];
    const model = buildWorldModel(entities);

    const beltSpeed = Number.isFinite(o.beltSpeed) ? o.beltSpeed : 1;
    const minerPerSec = Number.isFinite(o.minerPerSec) ? o.minerPerSec : DEFAULT_MINER_PER_SEC;
    const procOverride = (o.processingSec && typeof o.processingSec === "object") ? o.processingSec : {};

    /* ── 按格索引 ── */
    const cellRec = new Map();       // "x,y" → rec（带子优先）
    for (const [k, rec] of model.byCell) cellRec.set(k, rec);

    /* 每格上的带子状态：货物在不在（0/1）+ 它下一格去哪 */
    const beltCargo = new Map();     // "x,y" → true
    const beltNext = new Map();      // "x,y" → "x,y" | null（下一格）
    for (const rec of model.records) {
        if (rec.skipped || rec.type !== "belt") continue;
        const [x, y] = rec.origin;
        const k = `${x},${y}`;
        /* 带子的出口方向：从 outSlots 拿（buildWorldModel 已经算好世界方向） */
        const out = rec.outSlots && rec.outSlots[0];
        if (!out) { beltNext.set(k, null); continue; }
        const nx = out.tile[0] + DIRV[out.dir][0];
        const ny = out.tile[1] + DIRV[out.dir][1];
        beltNext.set(k, `${nx},${ny}`);
    }

    /* 机器状态：输入缓冲（按槽）+ 输出待取 + 加工进度 */
    const machines = [];
    for (const rec of model.records) {
        if (rec.skipped || rec.type === "belt") continue;
        const perSec = (rec.type === "miner")
            ? minerPerSec
            : (Number.isFinite(procOverride[rec.type])
                ? procOverride[rec.type]
                : DEFAULT_PROCESSING_SEC[rec.type]);
        machines.push({
            rec,
            type: rec.type,
            origin: rec.origin,
            cells: rec.cells,
            inSlots: rec.inSlots.map(s => ({ ...s, has: false })),
            outSlots: rec.outSlots.map(s => ({ ...s, has: false })),
            /** 加工进度（0..1）；miner 不用它 */
            progress: 0,
            /** 每秒产出件数（miner）或每秒加工件数（其它） */
            perSec: perSec,
            /** 累计产出 / 加工完成数 */
            produced: 0,
        });
    }

    /* 机器占格 → machine，方便带子流进来时投递 */
    const machineAtCell = new Map();
    for (const m of machines) for (const k of m.cells) machineAtCell.set(k, m);

    /* hub 统计 */
    const hub = machines.find(m => m.type === "hub") || null;
    let delivered = 0;
    let trashed = 0;

    /* 有矿的矿机才算「活的」—— 与真机一致（脚下无矿的矿机永远 0 产出） */
    const oreCells = new Set(
        (Array.isArray(obs && obs.resources) ? obs.resources : [])
            .map(r => `${r[0]},${r[1]}`)
    );
    for (const m of machines) {
        if (m.type !== "miner") continue;
        m.hasOre = oreCells.size === 0 ? null : oreCells.has(`${m.origin[0]},${m.origin[1]}`);
    }

    const dt = 1 / 60;   // 每 tick 秒数

    /**
     * 把一个件投递到某格。
     * @returns {"delivered"|"trashed"|"stored"|"blocked"|"vanished"}
     */
    function deliver(k) {
        const rec = cellRec.get(k);
        if (!rec) return "vanished";                 // 空地

        if (rec.type === "belt") {
            if (beltCargo.get(k)) return "blocked";   // 带子满了
            beltCargo.set(k, true);
            return "stored";
        }

        if (rec.type === "hub") { delivered += 1; return "delivered"; }
        if (rec.type === "trash") { trashed += 1; return "trashed"; }

        const m = machineAtCell.get(k);
        if (!m) return "vanished";

        /* 投到某个空闲输入槽 */
        const slot = m.inSlots.find(s => s.tile[0] === rec.origin[0] && s.tile[1] === rec.origin[1] && !s.has)
            || m.inSlots.find(s => !s.has);
        if (!slot) return "blocked";
        slot.has = true;
        return "stored";
    }

    /** 推进一个 tick。 */
    function tick() {
        /* ① 带子前进：从末端往前扫，避免同一 tick 内一步走两格 */
        const order = [...beltCargo.keys()].sort((a, b) => {
            /* 简单的保守顺序：按坐标倒序（近似从下游往上游）。
               精确做法要拓扑排序，但一格的误差对「量级估计」无所谓。 */
            const [ax, ay] = a.split(",").map(Number);
            const [bx, by] = b.split(",").map(Number);
            return (by - ay) || (bx - ax);
        });
        for (const k of order) {
            if (!beltCargo.get(k)) continue;
            const nk = beltNext.get(k);
            if (!nk) continue;
            const r = deliver(nk);
            /* ★ 只有 `blocked` 才留在原地 ★
             *
             * 第一版写的是「`stored` 才删」，其余（delivered / trashed / vanished）
             * 都留在带子上。后果：货一旦流进 hub，`deliver` 每 tick 都
             * `delivered += 1`，而带子上那件货永远不删 ⇒ 一件货被反复计数。
             *
             * 实测：6 格带子的最小产线，矿机正确只产 6 件，
             * 但 60 秒报 **3535 件交付**（理论 60）。
             * 这类 bug 不崩、不报错，只有拿手算答案对才看得见 ——
             * 所以 flow-sim.test.mjs 的 F1 判据必须写成
             * 「40~65 件」这种**闭区间**，而不是 `> 0`。 */
            if (r !== "blocked") beltCargo.delete(k);
        }

        /* ② 矿机产出
         *
         * ⚠️ 矿机是**连续产出**的设备（不像加工机要凑齐输入才开工），
         * 所以它没有「输出槽被占」这个概念 —— 它是「按速率往出口推，
         * 出口那一格堵了才停」。第一版错误地把 `outSlot.has` 当闸门，
         * 而那个标志从来没人置位 ⇒ 每 tick 都投一次 ⇒ 60 秒产出 3535 件
         * （理论值 60）。这类 bug 的特征是**数字大得离谱但不崩**，
         * 只有拿手算答案去对才看得见。
         *
         * 正确的闸门是「出口格有没有位置」，由 `deliver()` 返回的 blocked 决定。 */
        for (const m of machines) {
            if (m.type !== "miner") continue;
            if (m.hasOre === false) continue;        // 脚下没矿
            m.progress += m.perSec * dt;
            if (m.progress < 1) continue;

            const slot = m.outSlots[0];
            if (!slot) { m.progress = 1; continue; }  // 没有出口：憋着
            const k = `${slot.tile[0] + DIRV[slot.dir][0]},${slot.tile[1] + DIRV[slot.dir][1]}`;
            const r = deliver(k);
            if (r === "stored" || r === "delivered" || r === "trashed") {
                m.progress -= 1;
                m.produced += 1;
            } else {
                /* 出口堵了：进度停在 1，等下个 tick 再试。
                   **不累加** —— 累积会让它在疏通瞬间一次性吐出几十件。 */
                m.progress = 1;
            }
        }

        /* ③ 加工机器 */
        for (const m of machines) {
            if (m.type === "miner" || m.type === "hub" || m.type === "trash") continue;
            const need = Math.max(1, m.inSlots.length);
            const have = m.inSlots.filter(s => s.has).length;
            if (have < need) continue;                 // 输入不全，不开工
            m.progress += m.perSec * dt * beltSpeed;
            if (m.progress < 1) continue;
            m.progress -= 1;
            /* 产物进第一个空闲输出槽 */
            const out = m.outSlots.find(s => !s.has);
            if (!out) { m.progress += 1; continue; }   // 出口堵了
            /* 消费输入 */
            for (const s of m.inSlots) s.has = false;
            const k = `${out.tile[0] + DIRV[out.dir][0]},${out.tile[1] + DIRV[out.dir][1]}`;
            const r = deliver(k);
            if (r === "stored" || r === "delivered" || r === "trashed") m.produced += 1;
            else { m.progress += 1; for (const s of m.inSlots) s.has = true; }
        }
    }

    /**
     * 跑指定秒数。
     * @param {number} seconds
     * @param {{onTick?:Function}} [o2]
     */
    function run(seconds, o2 = {}) {
        const ticks = Math.max(1, Math.round((Number(seconds) || 0) / dt));
        for (let i = 0; i < ticks; i++) {
            tick();
            if (o2 && typeof o2.onTick === "function" && i % 600 === 0) o2.onTick(i);
        }
        return stats();
    }

    /** 当前统计。 */
    function stats() {
        return {
            delivered,
            trashed,
            in_flight: beltCargo.size,
            machines: machines.length,
            belts: beltNext.size,
            by_machine: machines
                .filter(m => m.type !== "hub")
                .map(m => ({
                    type: m.type, at: m.origin,
                    produced: m.produced,
                    fed: m.inSlots.filter(s => s.has).length + "/" + m.inSlots.length,
                })),
            /** ★ 这些数字是**假设**，不是实测 —— 调用方必须知道 */
            assumed_rates: {
                belt_speed: beltSpeed,
                miner_per_sec: minerPerSec,
                processing_sec: Object.fromEntries(
                    Object.entries(DEFAULT_PROCESSING_SEC).map(([k, v]) => [k, procOverride[k] !== undefined ? procOverride[k] : v])
                ),
                note: "加工节拍读不到模板真值时用默认值。结论只用于量级比较，不替代真机验收。",
            },
        };
    }

    return { tick, run, stats, machines, beltCargo, get delivered() { return delivered; } };
}

/**
 * 便捷入口：给定 obs 和秒数，直接返回统计。
 * @param {object} obs
 * @param {number} seconds
 * @param {object} [opts]
 */
export function simulateFlow(obs, seconds, opts) {
    return createFlowSim(obs, opts).run(seconds);
}
