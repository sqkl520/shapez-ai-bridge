/**
 * loop/health.mjs — 世界健康快照、可 diff 的增量、以及**每步 tx 的净效果判定**。
 *
 * ## 为什么需要这个文件
 *
 * 用户原话（2026-11-03）：「你看看做出来的是什么样子的一坨玩意，毫无逻辑可言」。
 *
 * 复盘那次 AI 跑出来的世界：
 *
 *   136 实体 / 120 条带子 / **49 条到不了 hub（41%）** / debug_items 里 40 条入口带子**0 条有货**
 *   而 run 历史里 8 次 run 有 6 次的 `goal_delta` 是 **0**、实体数不变。
 *
 * 真正的问题不是「它做错了」，而是**没有任何量能把「做错了」和「什么都没做」区分开**。
 * `goal_delta` 只测一个数（本轮 hub 涨了几个目标形状），于是：
 *
 *   · 改坏了线 → goal_delta 0
 *   · 什么都没做 → goal_delta 0
 *   · 把一条死带子挪到另一处 → goal_delta 0
 *
 * 三者在前面的记录里长得**完全一样**。模型学不到东西，人也看不出问题。
 *
 * 所以本文件提供三样东西：
 *
 *   1. `worldHealth()`      —— 一份可 diff 的世界体检快照（纯函数）；
 *   2. `healthDelta()`      —— 两份快照的差，只报「变了且有意义」的项；
 *   3. `classifyNetEffect()` —— 一次 tx 到底是 positive / regressive / constructive /
 *                              churn / inert。**这是「这步是好是坏」的唯一判据**。
 *
 * ## 口径纪律
 *
 * · **纯函数**：不读时钟、不读文件、不 spawn。同一份 obs 两次调用逐字节相同
 *   （`diagnose` / `fingerprintOf` 依赖这条）。
 * · **只读观测面**：只吃 obs / debug_items / production 三个读取面的原文。
 *   缺任何一个都**降级为 null**，不猜、不补零 —— 「没读到」与「是 0」必须分开。
 * · **不复制几何真值**：可达性一律走 `topology.mjs` 的 `flowReachable`，
 *   不为了一行摘要发明第二套 `accepts`。
 *
 * 零 IO、零副作用。
 */
import crypto from "node:crypto";

import {
    indexOf, flowReachable, isBelt, isTunnel, sourceEntityOf,
} from "./topology.mjs";

/** 非带子、非 hub 的实体就算「机器」。用于区分「加机器」与「铺带子」。 */
const MACHINE_LIKE = new Set([
    "miner", "cutter", "rotater", "stacker", "mixer", "painter",
    "balancer", "trash", "constant_signal", "switch", "tunnel",
]);

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = v => (Number.isInteger(v) ? v : null);
const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/**
 * 世界的**形态**指纹：身份 + 几何 + 朝向，按 uid 升序。
 *
 * 为什么不复用 `handles.obsHash`：那个的用途是「句柄表与这个世界是不是同一份」
 * （`OBS_STALE` 的判据），它的字段集是**句柄需要的**字段。这里要回答的是另一个问题 ——
 * 「这一轮的世界和上一轮**是否逐实体相同**」。两者将来若各自增减字段，共用一份实现
 * 会让一边的需求去改另一边的语义。所以这里独立算，字段集写死在下面。
 *
 * 用途：区分 `churn` 与 `inert`。改了一条带子的朝向之后，所有**健康指标**都不动
 * （带子还是 160 条、还是 133 条到 hub），但世界确实变了 —— 那是 churn 不是 inert。
 * 没有这个指纹，「原地打转」和「什么都没做」分不开，而那正是本文件要解的题。
 */
export function shapeHash(obs) {
    const o = obs && obs.result && Array.isArray(obs.result.entities) ? obs.result : obs;
    const ents = (o && Array.isArray(o.entities) ? o.entities : []).filter(e => e && Number.isInteger(e.uid));
    const rows = ents
        .map(e => [e.uid, e.type, e.variant || "default", e.x, e.y, e.r | 0,
            typeof e.rotation_variant === "number" ? e.rotation_variant
                : (typeof e.code === "number" ? e.code - 1 : 0)])
        .sort((a, b) => a[0] - b[0])
        .map(r => r.join(","));
    return `w:${crypto.createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16)}:n=${rows.length}`;
}

/**
 * 一份世界体检快照。**所有字段要么是数，要么是 null**（读不到就是 null）。
 *
 * @param {object} p
 * @param {object} p.obs        ObsSnapshot（`reader.obs` 的 result）
 * @param {object|null} [p.items]      `debug_items` 的 result
 * @param {object|null} [p.production] `production` 的 result
 * @param {string|null} [p.goalShape]  关注的目标形状（缺省取 `obs.goal.requirement.shape`）
 * @returns {object} 快照（结构见下方 `out`）
 */
export function worldHealth({ obs, items = null, production = null, goalShape = null } = {}) {
    const o = obs && obs.result && Array.isArray(obs.result.entities) ? obs.result : obs;
    const ents = (o && Array.isArray(o.entities) ? o.entities : []).filter(e => e && Number.isInteger(e.uid));

    const byType = Object.create(null);
    for (const e of ents) byType[e.type] = (byType[e.type] || 0) + 1;

    const belts = ents.filter(e => isBelt(e) || isTunnel(e));
    const machines = ents.filter(e => e.type !== "hub" && !isBelt(e) && !isTunnel(e)
        && MACHINE_LIKE.has(e.type)).length;

    /* ── 可达性：**物理口径**（每一跳都验 accepts），不是「几何相邻就算通」 ── */
    let reach = null;
    let reachBelts = null;
    let deadBelts = null;
    let deadBySource = null;
    if (ents.length) {
        try {
            const idx = indexOf(o);
            const set = flowReachable(o, idx);
            reach = set.size;
            const beached = belts.filter(b => !set.has(b.uid));
            reachBelts = belts.length - beached.length;
            deadBelts = beached.length;
            /* 死带子按「它想从哪个源头取货」归类 —— 这比一个总数有用得多：
               全是 miner 说明矿机在空转，全是 cutter 说明加工链断了。
               `sourceEntityOf` 是既有的上游爬行，不另写一套。 */
            const by = Object.create(null);
            for (const b of beached) {
                let kind = "unknown";
                try { kind = sourceEntityOf(idx, b).kind || "unknown"; } catch { kind = "unknown"; }
                by[kind] = (by[kind] || 0) + 1;
            }
            deadBySource = by;
        } catch {
            /* 索引失败（未知建筑/坏 obs）⇒ 可达性整片为 null。**不报 0**：
               0 与 null 在 diff 里必须是不同的结论。 */
            reach = null; reachBelts = null; deadBelts = null; deadBySource = null;
        }
    }

    /* ── 货：真的在带子上跑的有多少 ──
       `items.paths[].itemsOnPath` 是游戏自己数的每段路上的货。
       120 条带子 + 0 个货 = 一条在跑但不出货的线，与「线没接上」是两回事。 */
    let itemsOnBelts = null;
    let pathsWithItems = null;
    let pathsTotal = null;
    const it = items && items.result ? items.result : items;
    if (it && Array.isArray(it.paths)) {
        pathsTotal = it.paths.length;
        pathsWithItems = 0;
        itemsOnBelts = 0;
        for (const p of it.paths) {
            const n = int(p && p.itemsOnPath);
            if (n === null) continue;
            itemsOnBelts += n;
            if (n > 0) pathsWithItems++;
        }
    }

    const req = (o && o.goal && o.goal.requirement) || {};
    const gs = typeof goalShape === "string" && goalShape.trim()
        ? goalShape.trim()
        : (typeof req.shape === "string" ? req.shape : null);

    const produced = obj(production && production.produced_total);
    const stored = obj(o && o.hub && o.hub.stored_shapes);

    /* 升级档位。**必须进健康快照**，否则「买了升级」在净效果里不存在。
     *
     * 真机实测（r-20261113180132-31ba，2026-11-13）：模型买了 painting T1，
     * 实机上 hub 的 painting 从 L0 变成 L1、库存扣了 RbRb----×600 ——
     * 而 `classifyNetEffect` 判的是 `inert`（「世界没有任何变化」）。
     *
     * 那不是措辞问题：升级**不产生任何 op**，所以所有拓扑指标一个都不动，
     * 而三次真实的、不可逆的库存支出被判成「什么都没做」。
     * 下一次排查会看到「模型说要买升级 → 世界没变」，与事实正好相反。 */
    const upLevels = obj(o && o.goal && o.goal.upgrade_levels);

    return {
        /* 形态指纹（区分 churn / inert 的唯一依据） */
        shape: shapeHash(o),

        /* 目标 */
        level: int(o && o.goal && o.goal.level),
        goal_shape: gs,
        required: int(req.required),
        delivered: int(req.delivered),
        progress: num(req.progress),
        stored_goal: (gs && stored && num(stored[gs]) !== null) ? stored[gs] : null,
        produced_goal: (gs && produced && num(produced[gs]) !== null) ? produced[gs] : null,

        /* 升级档位（★ 见上面那段：没有它，买升级会被判成「什么都没做」） */
        upgrade_levels: upLevels ? { ...upLevels } : null,

        /* 规模 */
        entities: ents.length,
        by_type: byType,
        belts: belts.length,
        machines,

        /* 连通性 */
        belts_reaching_hub: reachBelts,
        belts_dead: deadBelts,
        reach_pct: (reachBelts !== null && belts.length) ? Math.round((reachBelts / belts.length) * 1000) / 1000 : null,
        dead_by_source: deadBySource,

        /* 流动 */
        items_on_belts: itemsOnBelts,
        paths_with_items: pathsWithItems,
        paths_total: pathsTotal,

        /* 存量（hub 累计账本，跨关不清零） */
        produced: produced ? { ...produced } : null,
        stored: stored ? { ...stored } : null,
    };
}

/**
 * 哪些指标「变大是好事」，哪些「变大是坏事」。
 *
 * `null` = 不判方向（规模类：加机器当然该变大，那不是健康度）。
 * 没列进来的字段一律按「不判方向」处理，所以新增字段不会意外变成红项。
 */
const GOOD_UP = new Set(["delivered", "stored_goal", "belts_reaching_hub", "items_on_belts", "reach_pct"]);
const GOOD_DOWN = new Set(["belts_dead"]);

/**
 * 两份快照的差。**只报真的变了的项** —— 一条静默的 diff 比一条噪音 diff 好用。
 *
 * @param {object} before `worldHealth()` 的返回
 * @param {object} after  同上
 * @returns {Array<{metric:string, before:*, after:*, delta:number|null, dir:"up"|"down"|"changed",
 *                  sign:"+"|"-"|"0"|null}>}
 *   `sign`：`"+"` 变好、`"-"` 变坏、`"0"` 变了但方向不判、`null` 不可比（一边是 null）
 */
export function healthDelta(before, after) {
    const out = [];
    if (!before || !after) return out;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        if (k === "by_type" || k === "dead_by_source" || k === "produced" || k === "stored") continue;
        const b = before[k], a = after[k];
        if (b === a) continue;

        /* ★ 对象型指标要逐键 diff，不能走 num() ★
         *
         * 已有的两个例子：`upgrade_levels`（`{belt:1, miner:2,…}`）与
         * `redundancy`（`{belts, safe, breaking, safe_pct, …}`）。
         * `num()` 对它们返回 null，于是掉进「不可比」分支，最后被 `formatDelta`
         * 印成 `[object Object]→[object Object]` —— 真机日志里两样都是这么写的
         * （r-20261113180536-5070 的 miner L1→L2、r-20261113180840-edab 的 redundancy）。
         *
         * 统一展开成可读串。判方向的规则按指标自己的语义定：
         *   · upgrade_levels —— 涨了就是好事（`delta` = 涨了的链数）；
         *   · redundancy     —— **没有方向**（它说「有几格带子删了不伤下游」；
         *     安全可删变多既可能是清理机会变多，也可能是废线变多，不构成好坏）。
         *     所以它的 `sign` 是 `0`，只在 `all:true` 时打印。 */
        if (b && a && typeof b === "object" && typeof a === "object" && !Array.isArray(b)) {
            const diff = [];
            for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
                const x = b[key], y = a[key];
                if (x === y) continue;
                if (x === null || y === null || typeof x === "object" || typeof y === "object") continue;
                diff.push(`${key} ${x}→${y}`);
            }
            if (!diff.length) continue;
            const isUpgrade = k === "upgrade_levels";
            /* `delta` 的取舍：
             *   · upgrade_levels —— 涨了几条链（有方向，positive）；
             *   · 其它对象指标 —— 给 0 而不是 null。
             *     给 null 会被 `formatDelta` 的 keep 判据当成「不可比」而**总是打印**，
             *     但 redundancy 的变化（`safe 0→2`）绝大多数轮次都在抖动，
             *     不属于「每轮都该出现在时间线上」的那种事实。
             *     给 0 ⇒ `sign: "0"` ⇒ 只在 `all:true` 时出现，需要时也查得到。 */
            const upGained = isUpgrade ? diff.filter(s => {
                const m = /(\d+)→(\d+)$/.exec(s);
                return m && +m[2] > +m[1];
            }).length : 0;
            out.push({
                metric: k,
                before: diff.join(","), after: "",
                delta: upGained,
                dir: "changed",
                sign: isUpgrade ? "+" : "0",
                detail: diff,
            });
            continue;
        }

        const nb = num(b), na = num(a);
        if (nb === null || na === null) {
            /* 一边读不到 ⇒ 不可比。**照样报出来**，标 `changed` + `sign:null`：
               「从 null 变成 0」是一个真实发生的事实（观测面刚恢复），不是噪音。 */
            out.push({ metric: k, before: b === undefined ? null : b, after: a === undefined ? null : a, delta: null, dir: "changed", sign: null });
            continue;
        }
        /* 比率类（reach_pct）是除出来的，浮点尾差会污染 diff 与「变了没有」的判断。
           统一收敛到 6 位：比率的实际分辨率远粗于此，不会吞掉真实变化，
           但能让 `0.831 → 0.836` 不再打印成 `0.0050000000000000044`。 */
        const d = Math.round((na - nb) * 1e6) / 1e6;
        const dir = d > 0 ? "up" : (d < 0 ? "down" : "changed");
        let sign = "0";
        if (GOOD_UP.has(k)) sign = d > 0 ? "+" : (d < 0 ? "-" : "0");
        else if (GOOD_DOWN.has(k)) sign = d < 0 ? "+" : (d > 0 ? "-" : "0");
        out.push({ metric: k, before: b, after: a, delta: d, dir, sign });
    }
    return out;
}

/**
 * 一次 tx 的**净效果**。这是「这步是好是坏」的唯一判据。
 *
 * 六档（互斥，按优先级判）：
 *
 * | 判定            | 条件                                                     |
 * |-----------------|----------------------------------------------------------|
 * | `positive`      | 目标交付涨了（delivered 或 stored_goal 涨）              |
 * | `regressive`    | 到 hub 的带子变少，或死带子变多 —— **它把世界改坏了**    |
 * | `cleanup`       | 到 hub 的变多 / 死带子变少 / 带上的货变多，且没长大      |
 * | `constructive`  | 规模变了（实体/带子/机器），但没坏，也没交货              |
 * | `churn`         | 世界形态变了，但所有健康指标都没动 —— 等价替换            |
 * | `inert`         | 世界形态完全没变                                          |
 *
 * `cleanup` 必须与 `constructive` 分开：删掉一条永远通不到 hub 的带子，
 * 在「实体数」口径下与「什么都没干成」长得一样（都是不交货），但它**确实改善了世界**。
 * 混在一起，模型就学不到「清理是对的」。
 *
 * `churn` 是这套判定存在的理由：把一条死带子挪到另一处、或者拆了重建一个等价结构，
 * 在旧口径下与「什么都不做」完全等价。它必须被单独点出来。
 *
 * @param {object} before 快照
 * @param {object} after  快照
 * @param {Array} [delta] `healthDelta(before, after)`（省一次计算）
 * @returns {{kind:string, why:string[], delta:Array}}
 */
export function classifyNetEffect(before, after, delta = null) {
    const d = Array.isArray(delta) ? delta : healthDelta(before, after);
    const get = m => d.find(x => x.metric === m) || null;
    const why = [];

    const delivered = get("delivered");
    const storedGoal = get("stored_goal");
    if ((delivered && delivered.delta > 0) || (storedGoal && storedGoal.delta > 0)) {
        const bits = [];
        if (delivered && delivered.delta > 0) bits.push(`delivered +${delivered.delta}`);
        if (storedGoal && storedGoal.delta > 0) bits.push(`hub 存量 +${storedGoal.delta}`);
        why.push(`目标交付涨了（${bits.join(" / ")}）`);
        return { kind: "positive", why, delta: d };
    }

    const reach = get("belts_reaching_hub");
    const dead = get("belts_dead");
    const items = get("items_on_belts");
    const entities = get("entities");
    const beltsN = get("belts");
    const machines = get("machines");
    const regress = [];
    /* ★ 「新铺的带子还没接完」不是破坏（2026-11-15，L12 真机）★
     *
     * `connect` 的特征是**带子 +N、死带子 +N**：新铺的每一格在源头和下游
     * 都接上之前，按定义就是死带子。这不是把世界改坏了，是施工做到一半。
     *
     * 旧口径只看 `dead.delta > 0` 就判 `regressive`，于是：
     *   · 一次正确的 `connect` 被判成「改坏了」；
     *   · 跨 run 记忆记住 `connect → rolled back, judged harmful`（n=7）；
     *   · 模型读到「别用 connect」—— 而它是**唯一**能往 mixer 喂料的宏。
     *     实测 R3 就是靠 connect 推进的，R2/R5 却被记忆劝退。
     *
     * 判据：带子总数增加了，**且新增的死带子少于新增的带子** —— 说明这批新带子里
     * 有一部分已经接上了，剩下的还在等下游。那正是施工中间态。
     *
     * 为什么是**严格小于**而不是 `<=`：全部新带子都孤立（`dead.delta === belts.delta`）
     * 时没有任何一格接上，那不是「施工中」，是「铺了一堆没人要的带子」——
     * 照旧判 regressive（`health.test.mjs` 的 H11 钉住这一条）。
     *
     * 这不放宽「真拆坏了」的判定：把 N 条活带子拆掉同时铺 M<N 条新带子，
     * 带子总数下降 ⇒ 照旧判 regressive。 */
    const beltsGrew = !!(beltsN && beltsN.delta > 0);
    const deadRoseFromWork = beltsGrew && dead && dead.delta > 0 && dead.delta < beltsN.delta;
    if (reach && reach.delta < 0) regress.push(`到 hub 的带子 ${reach.before}→${reach.after}`);
    if (dead && dead.delta > 0 && !deadRoseFromWork) regress.push(`死带子 ${dead.before}→${dead.after}`);
    if (regress.length) {
        why.push(...regress);
        return { kind: "regressive", why, delta: d };
    }

    const grewN = (entities && entities.delta > 0) || (beltsN && beltsN.delta > 0) || (machines && machines.delta > 0);

    /* ── 升级：一种**不体现在拓扑上**的正向变化 ──
     *
     * 升级不增删实体（它改全局倍率、扣 hub 库存），所以拓扑指标一个都不会动。
     * 不加这一条，一次真实的升级会被判成 `inert`（「世界没有任何变化」）——
     * 实测就是这么发生的（r-20261113180132-31ba：买了 painting T1，
     * `classifyNetEffect` 说 inert，而 hub 里实实在在少了 600 个形状）。
     *
     * 为什么是 `positive` 而不是新加一种 kind：
     *   · 已有的 `positive` 语义就是「这一轮让局面变好了」，升级正是；
     *     下游所有拿 `kind === "positive"` 判「这步有价值」的地方都不用改。
     * 但 `why` 里必须说清是升级 —— 否则读日志的人会以为目标交付涨了。
     *
     * ★ 位置必须在这里（`grewN` 分支**之前**）★
     *
     * 原来它在最后，于是「同一轮既买升级又加机器」会被结构性变化盖掉，
     * 升级的功劳消失（`health.test.mjs` 的 H17g 一直钉着这个已知缺口）。
     * 加了 `stalled_growth` 之后这个位置问题变得更严重 —— 那种情况下
     * 模型会看到「你加了东西但世界没动」，而它其实买了一次升级（真实的进展）。
     * 判「好」的判据必须比判「没进展」的判据先跑。 */
    const upBefore = (before && before.upgrade_levels) || null;
    const upAfter = (after && after.upgrade_levels) || null;
    if (upBefore && upAfter) {
        const gained = [];
        for (const line of new Set([...Object.keys(upBefore), ...Object.keys(upAfter)])) {
            const a = upBefore[line] || 0, b = upAfter[line] || 0;
            if (b > a) gained.push(`${line} L${a}→L${b}`);
        }
        if (gained.length) {
            why.push(`买了升级（${gained.join("、")}）—— 不改拓扑，但倍率全图生效`);
            return { kind: "positive", why, delta: d };
        }
    }

    const better = [];
    if (reach && reach.delta > 0) better.push(`到 hub 的带子 ${reach.before}→${reach.after}`);
    if (dead && dead.delta < 0) better.push(`死带子 ${dead.before}→${dead.after}`);
    if (items && items.delta > 0) better.push(`带上的货 ${items.before}→${items.after}`);
    if (better.length && !grewN) {
        why.push(...better);
        return { kind: "cleanup", why, delta: d };
    }

    if (grewN) {
        const bits = [];
        if (machines && machines.delta) bits.push(`机器 ${machines.delta > 0 ? "+" : ""}${machines.delta}`);
        if (beltsN && beltsN.delta) bits.push(`带子 ${beltsN.delta > 0 ? "+" : ""}${beltsN.delta}`);
        /* ★ 「加了东西，但世界一点都没动」必须与 constructive 分开 ★
         *
         * 2026-11-15 夜，L12 真机实测：`production()` 的 `produced_total` 恒为空
         * （拉长窗口、加切片、甚至重启游戏重载存档之后仍然空），而 agent 连续
         * 七八轮都在加带子/加机器，每轮都被判成 `constructive`（「结构变了，
         * 但目标没动」）—— 那不是中性，那是在**给一个完全没运转的世界加分**。
         *
         * 后果很具体：世界从 435 涨到 467 实体、带子 382→411，产出始终 0。
         * 它在往一个死掉的世界里堆东西，而判据一路给绿灯。
         *
         * 判据：规模涨了，但**带上的货没有增加**，且没有任何目标产出。
         * 「带上的货」是货流是否真的在动的直接证据 —— 新铺的线如果接对了，
         * 货会开始流（items_on_belts 涨）；接错了就一动不动。
         *
         * 这不是把 constructive 判成 regressive：它没弄坏什么，所以不进
         * 「该撤销」那一档。它只是**不该算作进展**，得让模型看到
         * 「你加的东西没有让世界动起来」这句话。 */
        const itemsMoved = !!(items && items.delta > 0);
        if (!itemsMoved && !better.length) {
            why.push(`结构变了（${bits.join(" ") || `实体 ${entities ? entities.delta : "?"}`}），`
                + `但**世界完全没动**：带上的货没有增加，也没有任何产出。`
                + `新加的东西没有接进任何活着的货流里。`);
            return { kind: "stalled_growth", why, delta: d };
        }
        why.push(`结构变了（${bits.join(" ") || `实体 ${entities ? entities.delta : "?"}`}），但目标没动`
            + (better.length ? `；顺带改善：${better.join("、")}` : ""));
        return { kind: "constructive", why, delta: d };
    }
    if (better.length) {
        why.push(...better);
        return { kind: "cleanup", why, delta: d };
    }

    /* 升级判定已经提到 `grewN` 之前（见上面那段注释：判「好」的必须先跑）。 */

    /* 尺寸与连通性都没动 ⇒ 看形态指纹。变了就是「原地打转」（拆了重建一个等价的、
       把死带子挪个位置、改了一条带子的朝向……），没变才是真的什么都没做。
       这一条必须用指纹而不是 delta：上面所有指标对「A→B 与 B→A」都不敏感。 */
    if (before && after && before.shape !== after.shape) {
        why.push("世界形态变了，但规模、连通性、货量、目标全都没动 —— 等价替换");
        return { kind: "churn", why, delta: d };
    }
    why.push("世界没有任何变化");
    return { kind: "inert", why, delta: d };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 人读的格式（timeline.log 用）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 快照压成一行。**固定字段顺序**，便于 `diff` 两份 timeline。 */
export function formatHealth(h) {
    if (!h) return "health: (不可读)";
    const bits = [];
    bits.push(`L${h.level === null ? "?" : h.level}`);
    bits.push(`${h.goal_shape || "?"} ${h.delivered === null ? "?" : h.delivered}/${h.required === null ? "?" : h.required}`);
    bits.push(`实体 ${h.entities}`);
    bits.push(`带子 ${h.belts}(${h.machines} 机器)`);
    bits.push(h.belts_reaching_hub === null
        ? "到hub ?"
        : `到hub ${h.belts_reaching_hub}/${h.belts}${h.reach_pct === null ? "" : ` ${Math.round(h.reach_pct * 100)}%`}${h.belts_dead ? ` · 死 ${h.belts_dead}` : ""}`);
    bits.push(`带上货 ${h.items_on_belts === null ? "?" : h.items_on_belts}`);
    return bits.join("  |  ");
}

/** 死带子的源头分解，一行。 */
export function formatDeadBySource(h) {
    const by = h && h.dead_by_source;
    if (!by) return "";
    const rows = Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return "";
    return rows.map(([k, n]) => `${k}×${n}`).join(" ");
}

/** 人读的格式（timeline.log 用） */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 「不判方向」的字段：它们的 delta 也要打出来（规模变化本身就是排查时最想看的）。 */
const NO_DIRECTION = new Set(["entities", "belts", "machines", "level", "required", "progress"]);

/**
 * 在 `formatDelta` 里**不打印**的字段。
 *
 * `shape` 是 17 个字符的哈希 —— 它进 delta 只有一个作用：证明「世界变了」。
 * 而这个事实由旁边的 `entities 181→180` / `belts 163→160` 已经说得更清楚，
 * 把哈希打进时间线只会把一行有用的数字挤成两行。`healthDelta` 仍然产出它
 * （`classifyNetEffect` 要用它区分 churn / inert），只是不往人读的日志里印。
 */
const NOT_PRINTED = new Set(["shape"]);

/**
 * 增量压成一行。
 *
 * @param {Array} delta `healthDelta()` 的返回
 * @param {{all?:boolean}} [opts]
 *   `all:false`（默认）= 只列**有信息量**的项：
 *     · `sign` 为 `+`/`-`（变好或变坏）；
 *     · `delta === null`（不可比，例如观测面刚恢复）；
 *     · 规模类字段（entities/belts/machines）—— 它们没有方向，但「带子 163→160」
 *       是读日志的人最想知道的那类事实。**旧版把这些滤掉，于是「拆了 3 条带子」
 *       印成「无变化」** —— 那比不打印更糟。
 *   `all:true` = 全列。
 */
export function formatDelta(delta, { all = false } = {}) {
    if (!Array.isArray(delta) || !delta.length) return "无变化";
    const keep = x => !NOT_PRINTED.has(x.metric) && (all
        || x.sign === "+" || x.sign === "-"
        || x.delta === null
        || NO_DIRECTION.has(x.metric));
    const rows = delta.filter(keep);
    if (!rows.length) return "无变化";
    return rows.map(x => {
        const mark = x.sign === "+" ? "▲" : (x.sign === "-" ? "▼" : "·");
        /* 对象型指标（`upgrade_levels`）自带可读展开，别走数字那套 */
        if (Array.isArray(x.detail) && x.detail.length) {
            return `${mark} ${x.metric} ${x.detail.join(",")}`;
        }
        if (x.delta === null) return `${mark} ${x.metric} ${x.before}→${x.after}`;
        const shown = Number.isInteger(x.delta) ? x.delta : Math.round(x.delta * 1000) / 1000;
        return `${mark} ${x.metric} ${x.before}→${x.after}(${shown > 0 ? "+" : ""}${shown})`;
    }).join("  ");
}

/** 净效果的中文标签。 */
export const NET_EFFECT_LABEL = Object.freeze({
    positive: "有进展",
    regressive: "改坏了",
    cleanup: "清理（改善但不是交货）",
    constructive: "只加东西没交货",
    /* 「加了东西，但世界完全没动」—— 与 constructive 的区别见 classifyNetEffect 里那段注释。
       constructive 至少「顺带改善」了点东西；这一档什么改善都没有，纯粹是往死世界里堆料。 */
    stalled_growth: "加了东西但世界没动",
    churn: "原地打转",
    inert: "完全没变",
});

/** 净效果压成一行。 */
export function formatNetEffect(e) {
    if (!e) return "净效果: ?";
    const label = NET_EFFECT_LABEL[e.kind] || e.kind;
    return `净效果: ${e.kind}（${label}）${e.why && e.why.length ? " — " + e.why.join("；") : ""}`;
}
