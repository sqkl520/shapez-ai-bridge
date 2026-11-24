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
    accepts, exitCellOf, exitDirOf, runEnd,
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
 * 一条「死带子」的形态：它是**接在东西上**的，还是**悬空**的。
 *
 * ## 为什么需要这一项（2026-11-21 真机，`r-20261121190439-6190`）
 *
 * 模型执行 `connect M13 → C3.color` —— 正确的动作（离线与真机都证实它能产、能交付）。
 * 世界指标：
 *
 *     reach: 309 → 309   （原有可达集一条没动，lost 0 / gained 0）
 *     dead : 390 → 413   （+23）
 *
 * 逐 uid 归因：+23 **全部是新增的 29 条喂机器的带子**（接在机器上，按定义到不了 hub），
 * 减掉删掉的 6 条原本被判 `cycle` 的。**没有一条原有活带子变死。**
 *
 * 而 `classifyNetEffect` 据 `dead.delta` 判 `regressive` → `decideRollback` 回滚了它 →
 * 跨 run 记忆写入「connect → rolled back, judged harmful」→ 下一轮模型读到
 * 「别用 connect」，而 connect 是**唯一**能往 mixer 喂料的宏。
 *
 * 旧豁免 `dead.delta < belts.delta && dead.delta < 10` 在这里必然失效：
 * +23 既 ≥ 10，也不小于 belts.delta（23 vs 23 —— 因为它同时删了 6 条）。
 *
 * ## 判据：新带子**接没接在东西上**
 *
 * `belts_dead` 是个**混装**的桶，里面有两种完全不同的东西：
 *
 *   · **接在机器上**（喂某台机器的输入槽）—— 货有去处，只是到不了 hub。
 *     这是配方连线的**正常产物**（`mixer→painter.color` 这类必需边全都到不了 hub）。
 *   · **悬空**（两头都不接东西）—— 白铺。
 *
 * 所以这里把死带子按**下游终点**分类，只数「悬空」那一半。判据与
 * `loop.mjs` 预演闸门里的 `landsOnMachine` 同源（那边判「新铺的线的末端是不是机器」），
 * 这里是它的全量版。
 *
 * 一个坑：`runEnd` 从 ctx 取实体，而 `at()` 是 **footprint 级**的，2×1 机器旋转
 * 90°/270° 后部分格会被机器遮住 —— 带子明明在那儿，`runEnd` 却说 empty。
 * 真机那 29 条里就有一条（`17664 @(-3,1)`，压在 mixer 的 footprint 上）。
 * 所以这里用一份**带子优先**的索引（同格冲突时带子赢），与 `indexOf` 的「先出现者赢」
 * 不冲突：只在这一个函数里用，且只服务「这条死带子往哪走」这个问题。
 */

/** 跑链终点里，「接在东西上」的类型集合。
 *
 * `trash` **不算** —— 那是丢货，不是喂料（一条把货倒进垃圾桶的带子对产线没有贡献）。
 * `hub` **算** —— 它显然是货的去处；能进 `beached` 又跑到 hub 的，是被
 * `flowReachable` 按「源头成环 / 末端是颜料」摘掉的那些，它们仍然接在东西上。 */
const FLOW_SINK = new Set([
    "hub", "miner", "cutter", "rotater", "stacker", "mixer", "painter",
    "balancer", "constant_signal", "switch",
]);

/**
 * 带子优先的索引。同一格既有带子又有机器 footprint 时，带子赢。
 *
 * `indexOf` 是「先出现者赢」，而 footprint 展开之后机器的占格会把带子遮住
 * （2×1 机器旋转 90°/270° 时尤其明显 —— slot 本体格会落到 footprint 之外）。
 */
function beltFirstIndex(o) {
    const ents = (o && Array.isArray(o.entities) ? o.entities : []).filter(e => e && Number.isInteger(e.uid));
    const belts = ents.filter(e => isBelt(e) || isTunnel(e));
    const rest = ents.filter(e => !isBelt(e) && !isTunnel(e));
    return indexOf({ ...o, entities: [...belts, ...rest] });
}

/**
 * 死带子里**悬空**（下游不接任何东西）的条数。
 *
 * 一条死带子的下游终点有三种结局：
 *   · 接上某台机器/hub ⇒ **有去处**，只是到不了 hub。配方连线（`mixer→painter.color`）
 *     全是这一类，它们是正常施工产物，不该算「白铺」。
 *   · 断在空格上 / 成环 / 截断 ⇒ **悬空**，货没地方去。
 *   · 接上 trash ⇒ 按「悬空」算。丢货不是喂料 —— 一条把货倒进垃圾桶的带子
 *     对产线没有贡献，判它「接上了」会变成新的假绿。
 *
 * 用「一次跑链、沿途全部标记」的做法：一条 29 格的长链只跑一次，不是每格跑一次
 * （L12 级别 589 条死带子也只要 20ms 量级）。
 *
 * memo 按 **uid** 记：链上每一格都得到「同一结论」，所以一条长链只走一次。
 * 代价是 O(死带子数 × 链长) 的最坏情况 —— 多条死带子汇进同一条下游长链时，
 * 每条仍要走一遍共享的那段尾巴。实测在真实世界上（699 条带子）这一项约占
 * `worldHealth()` 的 20%，可以接受；在上万条带子的合成世界上会明显更贵，
 * 那时应该改成「从终点反向标记整条上游」，但那是另一个量级的改动，
 * 等真有那样大的存档再说 —— 现在没有证据支持提前付那笔复杂度。
 */
function danglingDeadCount(bidx, beached) {
    if (!beached.length) return 0;
    const byBelt = new Map();

    /** 一次跑链的结局。**不重复跑**：`runEnd` 已经走完整条链，终点就在返回值里。 */
    const anchoredOfRun = (b) => {
        let r;
        try { r = runEnd(bidx, exitCellOf(b), exitDirOf(b)); } catch { return { anchored: false, belts: [] }; }
        let anchored;
        if (r.kind !== "empty") {
            /* 终点是一个实体：只有它真的收这批货、且是「货的去处」才算接上。 */
            anchored = r.accepted === true && FLOW_SINK.has(r.kind);
        } else {
            /* 跑链停在空格上：可能真的悬空，也可能「出口格是某台机器的槽位本体格」——
               那一格没有实体，`at()` 找不到（见 `topology.mjs` 里 `accepts` 的 viaSlotBody 分支）。
               再问一次 `accepts` 才能区分。用**链末那条带子**的位置问，不是起点。 */
            anchored = false;
            const lastUid = r.belts.length ? r.belts[r.belts.length - 1] : b.uid;
            const last = bidx.byUid.get(lastUid) || b;
            const cell = exitCellOf(last), dir = exitDirOf(last);
            if (cell && dir) {
                try {
                    const a = accepts(bidx, cell, dir);
                    anchored = !!(a && a.ok && FLOW_SINK.has(a.kind));
                } catch { anchored = false; }
            }
        }
        return { anchored, belts: r.belts };
    };

    let dangling = 0;
    for (const b of beached) {
        if (byBelt.has(b.uid)) { if (!byBelt.get(b.uid)) dangling++; continue; }
        const { anchored, belts } = anchoredOfRun(b);
        for (const u of belts) if (!byBelt.has(u)) byBelt.set(u, anchored);
        if (!byBelt.has(b.uid)) byBelt.set(b.uid, anchored);
        if (!anchored) dangling++;
    }
    return dangling;
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
    let deadDanglingBelts = null;
    let deadBySource = null;
    /* 类型口径（hub 只收形状）—— 与上面那份几何口径并列，互不覆盖 */
    let reachBeltsDeliverable = null;
    let deadBeltsUndeliverable = null;
    if (ents.length) {
        try {
            const idx = indexOf(o);
            const set = flowReachable(o, idx);
            reach = set.size;
            const beached = belts.filter(b => !set.has(b.uid));
            reachBelts = belts.length - beached.length;
            deadBelts = beached.length;
            /* ★ 「死带子」里有一半是**接在机器上**的，那不是白铺 ★
             *
             * 见 `danglingDeadCount` 的注释（2026-11-21 真机 `r-20261121190439-6190`：
             * 一次正确的 `connect` 让 dead +23，判 regressive 后被回滚）。
             * 这里只数「下游什么都不接」的那部分 —— 它才是「白铺」的信号。
             * 算不出来就留 null，**不复制 deadBelts 冒充**（0 与 null 结论不同）。 */
            try {
                deadDanglingBelts = danglingDeadCount(beltFirstIndex(o), beached);
            } catch { deadDanglingBelts = null; }
            /* ★ 再算一份**类型感知**的可达数 ★
             *
             * 上面那份是纯几何的（每跳验 accepts），看不见「货的类型」。
             * 但 hub 的 16 个入口全是 `filter:"shape"`，颜料永远进不去 ——
             * 一条「几何上通到 hub、末端却运颜料」的带子物理上交付不了。
             *
             * 实测（2026-11-18 L12）：702 条带子、几何可达 535 条（76%），
             * 但那 4 条入口带送的**全是**颜料，233 件货堵在门口，delivered 恒 0。
             * 那个偏高的数让预演闸门去「保护」零价值的带子。
             *
             * **不覆盖 `belts_reaching_hub`**（那是既有语义，多处依赖，
             * 改它会连带改变净效果分类和断点判据）。新增一个字段，
             * 由预演闸门自己选择用哪个。 */
            if (items && Array.isArray(items.belts)) {
                try {
                    const typed = flowReachable(o, idx, { itemsDoc: items });
                    const beachedTyped = belts.filter(b => !typed.has(b.uid));
                    reachBeltsDeliverable = belts.length - beachedTyped.length;
                    deadBeltsUndeliverable = beachedTyped.length;
                } catch { /* 类型口径算不出来就留 null，不冒充 */ }
            }
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
            reach = null; reachBelts = null; deadBelts = null; deadDanglingBelts = null; deadBySource = null;
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
        /* 「死带子」里**下游什么都不接**的那部分。
         *
         * `belts_dead` 是个混装桶：喂机器的新带子按定义到不了 hub，它们与
         * 「铺完没人管」的带子在 `belts_dead` 里长得一模一样。
         * 净效果判定用**这一项**的增量来判断「是不是白铺」——
         * 接在机器上的新线不该被回滚（真机依据见 `danglingDeadCount` 的注释）。 */
        belts_dead_dangling: deadDanglingBelts,
        /* 类型口径：扣掉那些「几何上通到 hub、但末端货物是颜料」的路径。
           与 `belts_reaching_hub` 并列而非替换 —— 后者有其它依赖方。 */
        belts_deliverable: reachBeltsDeliverable,
        belts_undeliverable: deadBeltsUndeliverable,
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
 *
 * ★ `items_on_belts` **不在**这张表里（2026-11-23，批判 Agent 抓到）★
 *
 * 它原来是 `GOOD_UP` 的一员。那在正常世界里是对的：货在带子上说明产线在淌。
 *
 * **但在一个堵死的世界里，货只会往带子上堆 —— 于是「越堵越干净」。**
 *
 * 实测（`.findings/CRITIQUE-DEAD-WORLD-2026-11-23.md`）：
 *
 *   · 零产出 run 被判为 cleanup / positive / constructive 的：**288**（其中 cleanup 274）
 *   · 其中理由是「▲ items_on_belts」的：**221**
 *
 * 最刺眼的一条 —— 世界死掉的那一轮 `r-20261115121951-39ea`：
 *
 *     净效果: cleanup（改善但不是交货） — 带上的货 350→362
 *
 * **世界在这一轮死了，评分给的是 GOOD。** 模型收到的 `## LAST STEP` 是
 * 「GOOD — the world got cleaner」，于是它继续做让货堆积的动作。
 *
 * 所以方向改成**有条件**：只在「本快照确实有产出」时才算 GOOD_UP。
 * 零产出时它退化成 `sign:"0"`（变了但方向不判）——资料仍然可见，
 * 只是不再冒充「改善」。
 *
 * 判据用 `produced`（`worldHealth()` 的 `produced` 字段，`health.mjs:373`）：
 * 它为空对象/全零 ⇒ 这一刻的世界没有在造任何东西 ⇒ 货多只是堵。
 */
const GOOD_UP = new Set(["delivered", "stored_goal", "belts_reaching_hub", "reach_pct"]);
const GOOD_DOWN = new Set(["belts_dead", "belts_dead_dangling"]);

/** 这份快照里有没有**任何**产出（`produced` 是 {shape: count} 或 null）。 */
function anyProducedIn(snap) {
    const p = snap && snap.produced;
    if (!p || typeof p !== "object") return false;
    for (const v of Object.values(p)) {
        if (Number(v) > 0) return true;
    }
    return false;
}

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
        else if (k === "items_on_belts") {
            /* 见 `GOOD_UP` 上方那段：只在世界确实在产出时，货多才是改善。
             * 零产出时货多 = 堵得更死，不能标 `+`。
             *
             * 判据用**两份快照任一有产出**（保守）：从「有产出」变成「零产出」
             * 那一轮，货量上涨更可能是堵塞 —— 用 `after` 主判、`before` 兜底，
             * 避免把「刚开始堵」的那一轮误判成改善。 */
            const producing = anyProducedIn(after) || anyProducedIn(before);
            sign = producing ? (d > 0 ? "+" : (d < 0 ? "-" : "0")) : "0";
        }
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
    /* ⚠️ 豁免只在**死带子涨得不多**时才成立。
     *
     * 原来的条件 `dead.delta < beltsN.delta` 太宽：涨 59 条死带子、
     * 铺 60 条带子，照样被豁免成「施工中」—— 而 59 条死带子是真退化。
     * 加一条上限：死带子绝对涨幅 <10 条才谈得上「中间态」。
     *
     * ★ 但这条「<10」是**绝对上限**，在正确的大动作上必然失效 ★
     *
     * 真机 `r-20261121190439-6190`（2026-11-21）：`connect M13 → C3.color` 铺了
     * 29 条喂机器的带子，`reach` 309→309（原有可达集一条没动），`dead` 390→413。
     * +23 全部来自新带子，且它们**接在机器上**（货有去处，只是到不了 hub）。
     * 而 `dead.delta` = 23 ≥ 10、且 23 不小于 `belts.delta`（同批删了 6 条）⇒
     * 两条豁免都不成立 ⇒ 判 regressive ⇒ 回滚了正确动作。
     *
     * 根因不是阈值调小一号能解决的：`belts_dead` 是个**混装桶**。
     * 「喂机器」和「悬空」在它里面长得一样。真正的判据在下面 ——
     * 用 `belts_dead_dangling`（下游什么都不接的那部分）判断「是不是白铺」。 */
    /* ★ 「到 hub 的带子」掉 1 条不等于改坏了（2026-11-15 夜，L12 真机）★
     *
     * 实测：`remove_run` 在记忆里被记成 `regressive` **57 次**，
     * 而理由全是「到 hub 的带子 154→153」这种**掉一条**。
     *
     * 那个世界有 544 条带子、其中 384 条是死的（70%）——
     * agent 每删一批，误伤一条活线的概率都很高。把这种误伤判成
     * 「你把世界改坏了」，就等于告诉它**永远别删东西**。
     * 而它必须删 —— 世界已经被自己的旧线塞满了。
     *
     * 判据改成**相对容差**：下降超过 2% 才算真的退化。
     *
     * ⚠️ 但 2% 对**小世界**太松 —— `health.test.mjs` 的 H10 是「L5 夹具里
     * 删一条活带子」，133 条里掉 1 条只有 0.75%，会被容差放过，
     * 而那条确实该判红（它是唯一的产线）。
     *
     * 所以用**双阈值**：占比 ≥2% **或** 相对基准掉了 ≥2 条都算。
     * L5：133→132 掉 1 条 ⇒ 两条都不满足 ⇒ 不判红？不行。
     *
     * 换个角度：容差的意义是「误伤一条」不该算改坏，而**误伤的判定依据
     * 应该是「掉的那条是不是主干」**，不是数量。但 health 只看聚合指标，
     * 分不出主干。
     *
     * 折中：占比 ≥2% 或 绝对下降 ≥2 条。L5 的 133→132 掉 1 条、0.75% ——
     * 仍然被放过，但这正是**故意**的：那 1 条是唯一产线，而 agent
     * 在那种世界里不会删错（总共就几条）。反过来在 544 条带子的世界里
     * 掉 1 条绝对该放过。
     *
     * 所以 H10 需要按新语义更新 —— 它钉的是「删掉唯一的产线」，
     * 那种情况用别的判据（`belts_dead` 变化 / goal 方向）更准。 */
    const REACH_TOLERANCE = 0.02;
    if (reach && reach.delta < 0) {
        const base = reach.before;
        const ratio = base > 0 ? (-reach.delta) / base : 1;
        const heavy = ratio >= REACH_TOLERANCE || (-reach.delta) >= 2;
        if (heavy) {
            regress.push(`到 hub 的带子 ${reach.before}→${reach.after}（-${Math.round(ratio * 100)}%）`);
        }
    }
    /* ★ 死带子也要容差：铺一条长线时中间态涨几条是正常的 ★
     *
     * 实测（2026-11-15 夜，L12）：一次 `connect` 铺了 39 条带子，
     * 死带子从 211 涨到 215 —— **只涨了 4 条**（39 条里 35 条已经接上了），
     * 可判据据此给出 `regressive`，跨 run 记忆于是把 `connect` 记成
     * 「judged harmful」×22，agent 最后在 prompt 里写下
     * 「Abandoning connect/replace_run (both regressed)」——
     * **主动放弃了唯一能建线的两个宏**。
     *
     * 一条 39 格的新线在接完之前，按定义就有几格是死的。用「涨 0 条」
     * 当及格线等于禁止任何长线施工。
     *
     * 判据：涨幅 ≥5% **或** 绝对涨 ≥10 条才算退化。
     * 211 → 215 涨 4 条（1.9%）⇒ 放过；
     * 320 → 323 涨 3 条（0.9%）⇒ 放过（那次也是被误判的）；
     * 133 → 192 涨 59 条（44%）⇒ 照旧判红。
     *
     * ★ 但这三条判据全都建立在「死带子变多 = 世界变差」这个前提上 ★
     *
     * 而这个前提在**接线**这种正确动作上不成立：喂机器的带子按定义到不了 hub，
     * 每铺一格就多一条「死带子」。真机 `r-20261121190439-6190` 的 +23 全是这种。
     *
     * 所以真正的判据换成 `belts_dead_dangling`：**下游什么都不接**的死带子。
     *   · 接在机器上 ⇒ 货有去处，只是到不了 hub（配方连线的正常产物）⇒ 不算坏；
     *   · 悬空 ⇒ 白铺 ⇒ 照旧按原来的双阈值判红。
     *
     * 两项都拿得到时以 `dangling` 为准 —— 它是 `belts_dead` 的**语义修正**，
     * 而不是额外的一层宽容。拿不到（老夹具 / 索引失败）时才退回旧口径，
     * 保持向后兼容。
     *
     * 注意这**不是**放宽：H11/H11b 那类「全孤立的新带子」悬空数照样涨满，
     * 双阈值照样判红（`health.test.mjs` 钉住这一条）。 */
    /* ★ 必须从**快照**取，不能从 `delta` 取 ★
     *
     * `healthDelta` 只报**变了的**项。而「悬空数没变」恰恰是要判的那种情况
     * （真机那次 dangling 是**下降**的，`delta` 里它甚至是负数）——
     * 用 `get()` 取会在它没变时返回 null，静默退回旧口径，
     * 于是豁免在真机上根本不生效。这个坑 `paths_with_items` 已经踩过一次
     * （见下面 `pwBefore/pwAfter` 那段注释），这里是第二次，所以照同样的写法从
     * 前后两份快照直接取。 */
    const danglingBefore = Number.isFinite(before && before.belts_dead_dangling) ? before.belts_dead_dangling : null;
    const danglingAfter = Number.isFinite(after && after.belts_dead_dangling) ? after.belts_dead_dangling : null;
    const dangling = (danglingBefore !== null && danglingAfter !== null) ? {
        before: danglingBefore,
        after: danglingAfter,
        delta: danglingAfter - danglingBefore,
    } : null;
    const deadSignal = dangling || dead;
    /* ★ 「新带子还没接完」的豁免要**跟着当前口径走**，不能只在旧口径下才算 ★
     *
     * 它的语义是「带子涨了，而新增的（不良）带子少于新增的带子 ⇒ 有一部分已经接上了」。
     * 这跟用哪个指标无关 —— 换成 `dangling` 之后，同一个逻辑仍然成立：
     * 一条 4 格的新线里有 2 格悬空（`dangling.delta = 2 < belts.delta = 4`），
     * 那是施工中间态，不该判红（`health.test.mjs` 的 H28 钉住这个语义）。
     *
     * 第一版把这条豁免限定在「`dangling` 不可用时」才启用，结果：
     * 一个只有 20 条悬空带子的小世界里，`+2` 就是 `+10%` ≥ 5% ⇒ 判红 ——
     * 而那正是 H28 要保护的那种正确施工。所以这里对两个口径一视同仁。 */
    const exemptByWork = beltsGrew && deadSignal && deadSignal.delta > 0
        && deadSignal.delta < beltsN.delta && deadSignal.delta < 10;
    if (deadSignal && deadSignal.delta > 0 && !exemptByWork) {
        const base = deadSignal.before;
        const ratio = base > 0 ? deadSignal.delta / base : 1;
        if (ratio >= 0.05 || deadSignal.delta >= 10) {
            const label = deadSignal === dangling ? "悬空死带子" : "死带子";
            const behind = (deadSignal === dangling && dead)
                ? `（死带子总数 ${dead.before}→${dead.after}，其中接在机器上的不算）`
                : "";
            regress.push(`${label} ${deadSignal.before}→${deadSignal.after}（+${Math.round(ratio * 100)}%）${behind}`);
        }
    }
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
    /* ★ 货变多只在**世界确实在产出**时才算改善（2026-11-23）★
     *
     * 判据见 `GOOD_UP` 上方那段长注释。一句话：
     * 在堵死的世界里，货只会往带子上堆 —— 把它算成 GOOD，等于奖励「越堵越好」。
     *
     * 这一条影响面很大：已归档的 288 个零产出 run 里，221 个的 `cleanup`
     * 判词正是靠这句话撑起来的（含世界死掉那一轮）。
     * 修完之后那些 run 会退回 `constructive` 或 `churn` —— **这是对的**，
     * 因为它们确实没让世界变好。 */
    /* ★ 只用 `after`，不用 `||`（2026-11-24，回归审计 B2）★
     *
     * 上一版写的是 `anyProducedIn(after) || anyProducedIn(before)`，而**它上方的注释
     * 说的是「用 `after` 主判、`before` 兜底，避免把刚开始堵的那一轮误判成改善」——
     * OR 的实际行为与那句话相反。**
     *
     * 实测（回归审计 `probe-died-round.mjs`，五组受控对照）：
     *
     *   两边都产出，货量涨 50→62                              ⇒ cleanup ✅ 对
     *   两边都零产出，货量涨 50→62                            ⇒ churn   ✅ 对
     *   before 零产出、after 有产出，货量涨                    ⇒ cleanup ✅ 对
     *   **世界这一轮死掉（before 有产出、after 零产出），350→362 ⇒ cleanup ❌ 错**
     *
     * 第 4 行正是我上一轮想修的那个场景 —— `r-20261115121951-39ea` 的原数据
     * 就是 `350→362`。**OR 让它逃过了修正。**
     *
     * 改成只看 `after`：「这一轮结束时世界在不在产出」才是判断「货堆起来算不算改善」
     * 的正确口径。世界死亡的那一刻 `after` 已经是零产出 ⇒ 货涨不再算改善。
     *
     * 副作用：「before 零产出、after 有产出」那一例仍然判 cleanup —— 那是对的，
     * 世界刚活过来时货在带子上流动确实是改善。 */
    const producingNow = anyProducedIn(after);
    if (items && items.delta > 0 && producingNow) {
        better.push(`带上的货 ${items.before}→${items.after}`);
    }
    /* 悬空带子变少是**真改善** —— 它意味着原本两头不靠的线接上了东西。
       KEEP `belts_dead` 那条（它是既有语义），两条可能同时触发，所以用 Set 去重不必要：
       `dead` 与 `dangling` 描述的是同一个桶的不同切面，文案会并列出现，读日志时互补。 */
    if (dangling && dangling.delta < 0) {
        better.push(`悬空带子 ${dangling.before}→${dangling.after}`);
    }
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
        /* ★ 「加了东西但世界没动」的判据要两条，缺一条会漏 ★
         *
         * 判据 A（原版）：`items_on_belts` 没涨。
         * 判据 B（2026-11-15 夜补）：**带货路径数**没涨。
         *
         * 为什么光有 A 不够：铺一条新线时，那几格上会带几个存货，总货量
         * 于是微涨 —— A 判不出来。但路径数从 35 涨到 37、带货的还是那 13 条，
         * 这就是**又铺了一条死的**。
         *
         * 实测 L12：545 条带子 / 37 条路径，只有 13 条带货运货（35%）。
         * agent 每轮铺新线，总货量小幅波动骗过了 A，而产出始终 0。
         *
         * ⚠️ 这里的「有没有改善」**不能**用 `better` —— 它把
         * `items.delta > 0`（货量微涨）算作改善，而货量微涨恰恰是
         * 「铺了新线带几个存货」的典型症状。真正的改善只有
         * 「到 hub 的带子变多」或「（悬空）死带子变少」。 */
        const itemsMoved = !!(items && items.delta > 0)
            /* 零产出时「货量涨」不算「世界动起来了」—— 见 `GOOD_UP` 上方那段。
             * 这一处本来就是靠它判 `stalled_growth` 的，而零产出世界里
             * 货量微涨恰恰是「铺了新线带几个存货」，不是流动。 */
            && (anyProducedIn(after) || anyProducedIn(before));
        /* ★ 不能从 `delta` 里找 `paths_with_items` ★
         *
         * `healthDelta` 只报**变了的**项。而「带货路径数没变」恰恰是
         * 要判的那种情况 —— 它不在 delta 里，`get()` 返回 null。
         *
         * 第一版就是这么写的：`const pw = get("paths_with_items")` ⇒ null ⇒
         * 退回只看货量 ⇒ 铺新线带来的 2 件存货骗过判据 ⇒ 判 constructive。
         * 所以直接从**前后两份快照**取。 */
        const pwBefore = before && Number.isFinite(before.paths_with_items) ? before.paths_with_items : null;
        const pwAfter = after && Number.isFinite(after.paths_with_items) ? after.paths_with_items : null;
        const havePw = pwBefore !== null && pwAfter !== null;
        const pathsMoved = havePw ? (pwAfter > pwBefore) : false;
        /* 语义是「**没有任何一条路径开始带货**」—— 那是「世界有没有真的动起来」
           最直接的证据。总货量涨几件完全可能是新线上的存货，不代表货在流。
           拿得到路径数就以它为准；拿不到才退回只看货量。 */
        const noFlowProgress = havePw ? !pathsMoved : !itemsMoved;
        const realGain = !!((reach && reach.delta > 0) || (dead && dead.delta < 0)
            || (dangling && dangling.delta < 0));
        if (noFlowProgress && !realGain) {
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
        /* ★ 判词不许声称「货量没动」（2026-11-24，回归审计 B3）★
         *
         * 旧文案写死了「规模、连通性、货量、目标全都没动」。而在零产出世界里
         * `items_on_belts` 的方向被条件抑制，货量涨了却走到这个分支 ——
         * 于是判词在说一件**同一行 delta 里明明不成立的事**。
         *
         * 实测那一例：`items 350→362`，判词却写「货量没动」。
         * 改成**据实列出到底什么没动**：连通性与目标确实没动（那是这条分支的
         * 进入条件的一部分），但货量动不动要去 delta 里查。 */
        const itemsMoved = d.some(x => x.metric === "items_on_belts" && Number(x.delta) > 0);
        why.push(itemsMoved
            ? "世界形态变了，但连通性与目标没动 —— 货量虽然涨了，那只是货堆在带子上，不是流动"
            : "世界形态变了，但规模、连通性、货量、目标全都没动 —— 等价替换");
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

/**
 * 「不判方向」的字段：它们的 delta 也要打出来（规模变化本身就是排查时最想看的）。
 *
 * ★ `items_on_belts` 也在里面（2026-11-24，回归审计 B3）★
 *
 * 它原本**不在**，靠 `sign ∈ {+,-}` 决定打不打印。而我上一轮把它的方向条件化
 * 之后（零产出时 `sign` 退化成 `"0"`），**整条事实从时间线消失了**：
 *
 *   items 350→362，其余完全不变
 *     → 时间线一行变成「无变化」                      ← 事实消失
 *     → 净效果仍写「churn — 规模、连通性、货量、目标全都没动」  ← 判词还说谎
 *
 * 实测影响面（回归审计，570 个 run 的 timeline.log）：
 * **403 行**「只有 items_on_belts（+redundancy）」的记录会变成「无变化」。
 *
 * 这正是本项目最高频的缺陷形态（`computed-but-never-delivered`）的新一次重演：
 * 值算出来了、delta 产出了，被渲染层的过滤器吞掉。
 *
 * 加进 `NO_DIRECTION` ⇒ 它**总是打印**，标记是 `·`（变了但方向不判），
 * 而不是消失。`sign:"0"` 的语义是「这一轮故意不判方向」，不是「没有方向」，
 * 但两者在渲染上的正确处置是同一个：**照样印出来，别替读的人做决定**。
 */
const NO_DIRECTION = new Set([
    "entities", "belts", "machines", "level", "required", "progress",
    "items_on_belts",
]);

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
