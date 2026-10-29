/**
 * loop/structural.mjs — 结构层诊断（P-a0）。**只判拓扑，不判形状/配方**。
 *
 * ## 为什么要有这一层
 *
 * 实测基线（`research/ai-plan/tmp/DIAGNOSE-BASELINE.md`）：
 *
 * | 人为损坏 | 旧 `diagnose()` 的输出 |
 * |---|---|
 * | 删 40 条带子（逐条试） | `NO_PRODUCTION` ×40，`DEAD_END` **×0** |
 * | 删掉全部矿机 | **只有 `NO_PRODUCTION`** |
 * | 删掉全部 trash | **只有 `NO_PRODUCTION`** |
 *
 * 根因不是「缺语义」，是**结构层的判据与可达性互斥**：
 * 旧 `DEAD_END` 要求「可达 hub」且「出口为空」，而「可达」正是从 hub 反向走出来的
 * ⇒ 出口为空的带子在拓扑上不可能进入可达集 ⇒ **这条诊断永远不可能触发**。
 *
 * 所以本文件的第一条纪律：
 *
 * > **结构判据不依赖「能不能走到 hub」；可达性只用于排序。**
 *
 * ## P-a0 的码（5 个，全部纯拓扑）
 *
 * | 码 | 判据 | 不需要 |
 * |---|---|---|
 * | `DEAD_END` | 带子/隧道的出口格上**没有实体** | 配方 |
 * | `BELT_HANDOFF_REJECTED` | 出口格上有实体，但**接收方不接受这个来向** | 配方 |
 * | `CHAIN_UNFED` | 跑链源头没有有效供给（断在空格 / 断在自身不能吐货的机器） | 配方 |
 * | `WASTE_NO_SINK` | 声明为废料口的输出跑链终点 ∈ {trash, empty, rejected}，且世界里**一台 trash 都没有** | 配方 |
 * | `RAW_MATERIAL_MISSING` | 配方需要 mine，但世界里 **0 台矿机** | 具体配方（只看「需要 mine」） |
 *
 * `RAW_MATERIAL_MISSING` 的判据刻意做得保守：`opts.recipe` 明确说需要 mine 时，
 * 只有「矿机数 == 0」才报 —— 「有矿机但没矿」不报（那是 `CHAIN_UNFED` 的活，
 * 而且需要资源层数据，不在 P-a0）。
 *
 * ## 不实现的（留给 P-a）
 *
 * `MISSING_STEP` / `WRONG_SHAPE_AT_HUB` / `DISCARDED_INTERMEDIATE` / `PROCESSOR_REQUIRED`
 * —— 这些都要知道「这条流在造什么形状」，属于语义层。
 *
 * ## 排序、tier、上限（按 v2 裁决 §3 / §6）
 *
 * - `evidence.tier`：0 = 在目标原料走廊内，1 = hub 可达，2 = 其它。
 *   排序键按 F-2 的裁决：**`inGoalRawCorridor` 优先于「到 hub 的拓扑距离」**，
 *   否则 L4 的 cutter 会被分配给离 hub 最近的主干（x=1，32 条带子），而不是 x=4 段。
 * - 上限：**每码 ≤3 条，总量 ≤8 条**（v2 §6 修正，不是 v1 的 12）。
 *   超出**不静默丢弃**：被截的那条码的第一条带 `evidence.suppressed = <被压掉的条数>`。
 *
 * ## 纪律
 *
 * - **纯函数**：同一份 `(obs, items, goal, handles, opts)` 两次调用逐字节相同。
 * - **零副作用**：不读写文件、不起子进程。这一条是**可 grep 的**：
 *   源码里不许出现任何 `fs` / `child_process` 的调用形态（`structural.test.mjs` 有断言）。
 *   这里刻意不把那几个函数名写出来 —— 写出来 grep 就不再为空了。
 * - **不吐坐标**：`subject` / `expected` / `observed` / `evidence.handles` 只有句柄与计数。
 *   坐标只允许出现在 `evidence.cells`（独立字段，prompt 不渲染它）。
 */
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { slotsOf } from "../verify_runtime.mjs";
import { OPP } from "../../ai/belt-rules.mjs";
import {
    K, indexOf, at, isBelt, isTunnel, tunnelIsSender, tunnelPeer,
    dirOfRotation, exitDirOf, exitCellOf, entryCellOf,
    accepts, runEnd, upstreamFed, hubReachable, sourceEntityOf,
} from "./topology.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 常量
 * ══════════════════════════════════════════════════════════════════════════ */

/** v2 §6 的硬上限（不是 v1 的 12）。 */
export const LIMITS = Object.freeze({ PER_CODE: 3, TOTAL: 8 });

/** 排序优先级：数值小的先出。结构事实（断/拒收）优先于「没有源头」。 */
const CODE_RANK = Object.freeze({
    DEAD_END: 0,
    BELT_HANDOFF_REJECTED: 1,
    CHAIN_UNFED: 2,
    WASTE_NO_SINK: 3,
    RAW_MATERIAL_MISSING: 4,
});

/** 这些码是「确定坏了」；其余在 P-a0 里也是坏，但保留分级给 P-a 用。 */
const BLOCKERS = new Set(["DEAD_END", "BELT_HANDOFF_REJECTED", "CHAIN_UNFED", "WASTE_NO_SINK", "RAW_MATERIAL_MISSING"]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 小工具（只读，无副作用）
 * ══════════════════════════════════════════════════════════════════════════ */

const unwrapObs = obs =>
    (obs && typeof obs === "object" && !Array.isArray(obs.entities) && obs.result
        && Array.isArray(obs.result.entities) ? obs.result : (obs && typeof obs === "object" ? obs : {}));

const unwrapItems = items =>
    (items && typeof items === "object" && !Array.isArray(items.paths)
        && items.result && typeof items.result === "object" ? items.result : (items && typeof items === "object" ? items : null));

/** 句柄查找：`handles.byUid` 是 Map（`buildHandles` 的产物）。没有句柄表时给 token。 */
function subjectOf(handles, uid, type) {
    if (handles && Number.isInteger(uid)) {
        const h = handles.byUid && handles.byUid.get ? handles.byUid.get(uid) : null;
        if (h) {
            const e = handles.byHandle && handles.byHandle.get ? handles.byHandle.get(h) : null;
            return { handle: h, type: (e && e.type) || type || null, uid };
        }
    }
    return {
        handle: null,
        type: type || null,
        uid: Number.isInteger(uid) ? uid : null,
        token: Number.isInteger(uid) ? `uid:${uid}` : null,
    };
}

/** 实体在句柄表里的名字（用于 handles 数组）；没有就 null（不编句柄）。 */
const handleOf = (handles, uid) => {
    if (!handles || !Number.isInteger(uid)) return null;
    const h = handles.byUid && handles.byUid.get ? handles.byUid.get(uid) : null;
    return typeof h === "string" && h ? h : null;
};

/** 一个实体的「可读身份」——**类型 + 变体 + 句柄**，不含坐标。 */
const labelOf = (handles, e) =>
    `${handleOf(handles, e.uid) || `${e.type}#${e.uid}`}${e.variant && e.variant !== "default" ? `(${e.variant})` : ""}`;

const variantOf = e => (e && e.variant) || "default";

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 目标原料走廊
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 「这条流的源头是脚底下有配方所需原料的矿机」—— 这就是 v2 §3 的 `inGoalRawCorridor`。
 *
 * 两种能力各取所需：
 *   · 有 `opts.recipe`（solver 的 steps）⇒ 用「需要 mine 的形状」集合；
 *   · 没有配方 ⇒ 退化为「源头是**任何**有矿的矿机」，`precise:false`
 *     （保守方向：宁可在 L4 上把 Cu 主干也算进走廊，也不要漏掉 Ru 链）。
 *
 * 走廊的传递：从这类矿机出发，顺着货流往下走 **16 跳**以内的带子/隧道都算走廊内。
 * 16 是经验值（L4 的 Ru 链从矿机到 balancer 要 20+ 跳；到 hub 要 40+），
 * 目的只是**把「矿机直连的那一片」与「hub 附近的汇流主干」分开**，不是精确边界。
 *
 * @returns {{cells:Set<string>, uids:Set<number>, precise:boolean}}
 */
function rawCorridor(idx, recipe) {
    const uids = new Set();
    const cells = new Set();
    const precise = !!(recipe && recipe.ok === true && Array.isArray(recipe.steps) && recipe.steps.length);

    let wanted = null;
    if (precise) {
        wanted = new Set();
        for (const s of recipe.steps) {
            if (s && s.op === "mine" && typeof s.hash === "string") wanted.add(s.hash);
        }
        if (!wanted.size) return { cells, uids, precise };
    }

    /* 矿机脚底下的资源格。obs.resources 是 [[x,y,kind], …]；缺这个字段时退化为「所有矿机」。 */
    const ore = new Map();
    for (const r of (idx.__resources || [])) {
        if (Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1])) {
            ore.set(K([r[0], r[1]]), r[2]);
        }
    }
    idx.__ore = ore;
    const miners = idx.ent.filter(e => e.type === "miner");
    const heads = [];
    for (const m of miners) {
        const kind = ore.get(K([m.x, m.y]));
        if (precise) {
            if (!wanted.has(kind)) continue;
        } else if (ore.size && kind === undefined) {
            continue;                      // 有资源表但脚底没矿：不是原料源头
        }
        heads.push(m);
        cells.add(K([m.x, m.y]));
        uids.add(m.uid);
    }

    /* 顺流展开（只走带子/隧道，遇机器就停 —— 机器之后属于另一条流）。 */
    const MAX_HOPS = 16;
    for (const m of heads) {
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0);
        if (!s) continue;
        for (const o of s.outputs) {
            let cur = o.cell;
            let d = o.dir;
            for (let hop = 0; hop < MAX_HOPS; hop++) {
                const e = at(idx, cur);
                if (!e || !(isBelt(e) || isTunnel(e))) break;
                if (uids.has(e.uid)) break;
                uids.add(e.uid);
                cells.add(K([e.x, e.y]));
                if (isTunnel(e)) {
                    if (!tunnelIsSender(e)) break;
                    const peer = tunnelPeer(idx, e);
                    if (!peer) break;
                    uids.add(peer.uid);
                    cells.add(K([peer.x, peer.y]));
                    cur = exitCellOf(peer);
                    d = dirOfRotation(peer.r || 0);
                    continue;
                }
                d = exitDirOf(e);
                cur = exitCellOf(e);
            }
        }
    }
    return { cells, uids, precise };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 结构事实的采集
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 全世界的「断头 / 拒收 / 无源头」—— 一次遍历，给 5 个码共用。
 *
 * 只走**带子与隧道**。机器出口单独按 slot 判（见 `collectWaste`）。
 */
function collectTopologyFacts(idx) {
    const deadEnds = [];      // {uid, kind, cell, dir}
    const rejected = [];      // {uid, kind, cell, dir, into:{uid,type}, intoDir}
    const unfedHeads = [];    // {uid, head, source}

    for (const e of idx.ent) {
        if (!isBelt(e) && !isTunnel(e)) continue;
        if (isTunnel(e) && !tunnelIsSender(e)) continue;   // receiver 的出口由配对逻辑负责

        /* 隧道的出口 = receiver 的出口；中途没配对 ⇒ 断在隧道口。 */
        let d, cell;
        if (isTunnel(e)) {
            const peer = tunnelPeer(idx, e);
            if (!peer) { deadEnds.push({ uid: e.uid, kind: "tunnel", cell: null, dir: dirOfRotation(e.r || 0) }); continue; }
            d = dirOfRotation(peer.r || 0);
            cell = exitCellOf(peer);
        } else {
            d = exitDirOf(e);
            cell = exitCellOf(e);
        }

        const hit = at(idx, cell);
        if (!hit) { deadEnds.push({ uid: e.uid, kind: isTunnel(e) ? "tunnel" : "belt", cell, dir: d }); continue; }
        const acc = accepts(idx, cell, d);
        if (acc.opaque) continue;                         // 未知建筑：不判（宁可漏报）
        if (!acc.ok) {
            rejected.push({ uid: e.uid, kind: isTunnel(e) ? "tunnel" : "belt", cell, dir: d, into: hit, intoDir: d });
        }
    }

    /* 跑链头：入口没有有效供给的带子。**只认带子**——隧道网络由上面的 deadEnds 覆盖。
       额外记录「源头是矿机、但矿机脚底没有矿」：那是矿机被架空的另一方面（实测 L4 的
       miner#10082@(5,-8) 脚底无矿，它的整条 x=5 支线事实上是死的）。 */
    const ore = idx.__ore || new Map();
    for (const e of idx.ent) {
        if (!isBelt(e)) continue;
        const src = sourceEntityOf(idx, e);
        const barren = src.kind === "miner" && src.entity && ore.size > 0
            && !ore.has(K([src.entity.x, src.entity.y]));
        /* 「有效供给」= 有上游实体吐货 **且** 那条流的源头真的能出货。
           矿机被架空（脚底无矿）时，上游实体存在、方向也对，但它永远不出货 ——
           这正是「上游没有**有效**供给」，所以要在这里一起报。 */
        if (upstreamFed(idx, e) && !barren) continue;
        unfedHeads.push({ uid: e.uid, head: e, source: src.kind, sourceEntity: src.entity, barren });
    }

    return { deadEnds, rejected, unfedHeads };
}

/**
 * 声明了废料口的机器：它的废料输出跑链终到哪儿。
 *
 * `WASTE_NO_SINK` 的触发条件（任务书：**世界里 trash 数为 0**）：
 *   · 机器有 `wasteRoles`（来自 `op-templates` 的模板真值）；
 *   · 该废料口跑链终点 ∈ {trash, empty, rejected（有实体但不收）}；
 *   · 全世界 `trash` 实体数 == 0。
 *
 * 为什么要求「0 台 trash」：只要世界里有任何一台 trash，模型已经知道「废料该丢哪」，
 * 再报就是噪音（v2 §4 的「必须不报」清单精神）。
 */
function collectWaste(idx) {
    const sinkCount = idx.ent.filter(e => e.type === "trash").length;
    const out = [];
    if (sinkCount > 0) return { out, sinkCount };
    for (const e of idx.ent) {
        const tpl = templateByBuildingVariant(e.type, variantOf(e));
        if (!tpl || !Array.isArray(tpl.wasteRoles) || !tpl.wasteRoles.length) continue;
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0);
        if (!s) continue;
        for (const o of s.outputs) {
            if (!tpl.wasteRoles.includes(o.role)) continue;
            const r = runEnd(idx, o.cell, o.dir);
            const sinks = r.kind === "trash" || r.kind === "empty" || r.accepted === false;
            if (sinks) out.push({ machine: e, role: o.role, run: r });
        }
    }
    return { out, sinkCount };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 主入口
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 结构层诊断。
 *
 * @param {object} obs       ObsSnapshot（`reader.obs` 的 result 或整个返回体）
 * @param {object|null} items `debug_items` 的 result（P-a0 **不使用**；保留参数位给 P-a）
 * @param {string|object|null} goal 形状串或 `{shape,…}`。P-a0 只用它做 `RAW_MATERIAL_MISSING` 的说明文案。
 * @param {object|null} handles `buildHandles(obs, items)` 的表；缺省时 worker 会用 `uid:N` token。
 * @param {object} [opts]
 * @param {object} [opts.recipe]     solver 的 `{ok, steps}`（决定矿机是否是「原料源头」）
 * @param {{PER_CODE?:number, TOTAL?:number}} [opts.limits] 覆盖上限（测试用）
 * @returns {Array<object>} Diagnosis[]（**确定性排序**）
 */
export function structuralDiagnoses(obs, items, goal, handles, opts = {}) {
    const o = unwrapObs(obs);
    const it = unwrapItems(items);
    const idx = indexOf(o);
    idx.__resources = Array.isArray(o.resources) ? o.resources : [];

    const reach = hubReachable(o, idx);
    const corridor = rawCorridor(idx, opts.recipe);
    const goalShape = typeof goal === "string" ? goal : (goal && (goal.shape || goal.goal)) || null;

    const tierOf = (uid, cell) => {
        if (uid !== null && corridor.uids.has(uid)) return 0;
        if (cell && corridor.cells.has(K(cell))) return 0;
        if (uid !== null && reach.has(uid)) return 1;
        return 2;
    };

    const facts = collectTopologyFacts(idx);
    const waste = collectWaste(idx);
    const out = [];

    /* ── DEAD_END：出口格上**没有实体**（纯拓扑，不含「有实体但不收」） ── */
    for (const d of facts.deadEnds) {
        const e = idx.byUid.get(d.uid);
        const subj = subjectOf(handles, d.uid, e ? e.type : d.kind);
        out.push({
            code: "DEAD_END",
            layer: "L2",
            severity: "blocker",
            subject: subj,
            expected: `${d.kind === "tunnel" ? "隧道出口" : "带子出口"}有接收方`,
            observed: d.kind === "tunnel"
                ? `隧道在 ${describeSpan(e)} 内没有配对到 receiver（或 receiver 后无去处）`
                : `出口方向 ${d.dir} 的那一格上没有实体（货会堆在这里）`,
            evidence: {
                handles: [subj.handle].filter(Boolean),
                uids: [d.uid],
                tier: tierOf(d.uid, d.cell),
                ...(d.cell ? { cells: [d.cell] } : {}),
            },
            candidates: ["trash_unused", "extend_line", "connect"],
        });
    }

    /* ── BELT_HANDOFF_REJECTED：出口落点有实体，但接收方不接受这个来向 ── */
    for (const r of facts.rejected) {
        const e = idx.byUid.get(r.uid);
        const subj = subjectOf(handles, r.uid, e ? e.type : r.kind);
        const intoH = handleOf(handles, r.into.uid);
        out.push({
            code: "BELT_HANDOFF_REJECTED",
            layer: "L2",
            severity: "blocker",
            subject: subj,
            expected: `${r.into.type} 接收来自 ${r.intoDir} 的货`,
            observed: `${r.kind} 把货推向 ${labelOf(handles, r.into)}，但那个落点不是它接受的入口`
                + (intoH ? `（${intoH} 不收这个来向）` : ""),
            evidence: {
                handles: [subj.handle, intoH].filter(Boolean),
                uids: [r.uid, r.into.uid],
                tier: tierOf(r.uid, r.cell),
                into_type: r.into.type,
                cells: [r.cell],
            },
            candidates: ["connect", "replace_run", "trash_unused"],
        });
    }

    /* ── CHAIN_UNFED：跑链源头没有有效供给 ──
     *
     * 「矿机被架空」必须**按矿机去重**：一台脚底无矿的矿机往往馈着 5–7 条带子，
     * 逐条报会把 8 条上限全吃掉（L4 实测：同一台 M4 报 7 条）。
     * 根因是一个，诊断就该是一条 —— subject 指向矿机本身，evidence 里带代表链与条数。
     */
    const seenHeads = new Set();
    const barrenGroups = new Map();
    for (const u of facts.unfedHeads) {
        if (u.barren && u.sourceEntity) {
            const g = barrenGroups.get(u.sourceEntity.uid) || { miner: u.sourceEntity, heads: [] };
            g.heads.push(u);
            barrenGroups.set(u.sourceEntity.uid, g);
            continue;
        }
        if (seenHeads.has(u.uid)) continue;
        seenHeads.add(u.uid);
        const subj = subjectOf(handles, u.uid, "belt");
        const up = at(idx, entryCellOf(u.head));
        const observed = u.source === "none"
            ? "入口那一格上没有实体（这条流没有源头）"
            : `入口接的是 ${labelOf(handles, up)}，但它不往这里吐货`
                + (u.source === "trash" || u.source === "hub" ? `（${u.source} 没有输出）` : "");
        out.push({
            code: "CHAIN_UNFED",
            layer: "L2",
            severity: "blocker",
            subject: subj,
            expected: "带子的入口有供货方（矿机 / 机器输出 / 上游带子）",
            observed,
            evidence: {
                handles: [subj.handle].filter(Boolean),
                uids: [u.uid],
                tier: tierOf(u.uid, [u.head.x, u.head.y]),
                source: u.source,
            },
            candidates: ["connect", "insert_machine", "extend_line"],
        });
    }
    for (const g of barrenGroups.values()) {
        const minerH = handleOf(handles, g.miner.uid);
        const chainH = g.heads.map(x => handleOf(handles, x.uid)).filter(Boolean);
        const subj = subjectOf(handles, g.miner.uid, "miner");
        out.push({
            code: "CHAIN_UNFED",
            layer: "L2",
            severity: "blocker",
            subject: subj,
            expected: "矿机脚底下有矿，能持续出货",
            observed: `${labelOf(handles, g.miner)} 脚底下没有矿（矿机被架空，永远不出货）`
                + `，它馈着的 ${g.heads.length} 条链因此全是死的`,
            evidence: {
                handles: [minerH, ...chainH].filter(Boolean),
                uids: [g.miner.uid, ...g.heads.map(x => x.uid)],
                tier: tierOf(g.miner.uid, [g.miner.x, g.miner.y]),
                source: "miner",
                barren_miner: true,
                chain_belts: g.heads.length,
            },
            candidates: ["remove_run", "replace_run", "insert_machine"],
        });
    }

    /* ── WASTE_NO_SINK：声明废料口无处可倒，且世界 0 台 trash ── */
    for (const w of waste.out) {
        /* subject 指向**废料流**：优先取跑链上的第一条带子（那是模型该改的东西）；
           没有带子（废料口直接对着空格）才回落到机器本身。 */
        const flowUid = w.run.belts.length ? w.run.belts[0] : w.machine.uid;
        const flowEnt = idx.byUid.get(flowUid) || w.machine;
        const subj = subjectOf(handles, flowUid, flowEnt.type);
        const where = w.run.kind === "empty" ? "空格"
            : w.run.kind === "trash" ? "trash（但世界里没有可用的）"
                : `${w.run.kind}（不接受）`;
        out.push({
            code: "WASTE_NO_SINK",
            layer: "L3",
            severity: "blocker",
            subject: subj,
            expected: "废料口有 trash 可倒",
            observed: `${w.machine.type} 的 ${w.role} 废料口跑链终点是${where}，而世界里 trash 数为 0`,
            evidence: {
                handles: [subj.handle, handleOf(handles, w.machine.uid)].filter(Boolean),
                uids: [flowUid, w.machine.uid].filter(Number.isInteger),
                tier: tierOf(flowUid, [flowEnt.x, flowEnt.y]),
                waste_role: w.role,
                run_kind: w.run.kind,
            },
            candidates: ["insert_machine", "connect", "trash_unused"],
        });
    }

    /* ── RAW_MATERIAL_MISSING：配方要 mine，但世界 0 台矿机 ── */
    {
        const needed = !!corridor.precise && Array.isArray(opts.recipe.steps)
            && opts.recipe.steps.some(s => s && s.op === "mine");
        const miners = idx.ent.filter(e => e.type === "miner").length;
        if (needed && miners === 0) {
            const hub = idx.ent.find(e => e.type === "hub") || null;
            const subj = hub ? subjectOf(handles, hub.uid, "hub") : { handle: null, type: null, uid: null };
            out.push({
                code: "RAW_MATERIAL_MISSING",
                layer: "L4",
                severity: "blocker",
                subject: subj,
                expected: `世界里至少有一台矿机在采 ${goalShape || "配方所需的原料"}`,
                observed: `配方需要 mine，但世界里矿机数为 0`,
                evidence: {
                    handles: [subj.handle].filter(Boolean),
                    uids: hub ? [hub.uid] : [],
                    tier: hub && reach.has(hub.uid) ? 1 : 2,
                    miners: 0,
                },
                candidates: ["insert_machine", "connect"],
            });
        }
    }

    /* ── 排序（v2 §3 的修正键）：tier → 码优先级 → 句柄 → uid ── */
    out.sort((a, b) => {
        const ta = a.evidence && Number.isInteger(a.evidence.tier) ? a.evidence.tier : 9;
        const tb = b.evidence && Number.isInteger(b.evidence.tier) ? b.evidence.tier : 9;
        if (ta !== tb) return ta - tb;
        const ra = CODE_RANK[a.code] === undefined ? 50 : CODE_RANK[a.code];
        const rb = CODE_RANK[b.code] === undefined ? 50 : CODE_RANK[b.code];
        if (ra !== rb) return ra - rb;
        if (a.code !== b.code) return a.code < b.code ? -1 : 1;
        const ha = (a.subject && (a.subject.handle || a.subject.token)) || "";
        const hb = (b.subject && (b.subject.handle || b.subject.token)) || "";
        if (ha !== hb) return ha < hb ? -1 : 1;
        const ua = (a.evidence && a.evidence.uids && a.evidence.uids[0]) || 0;
        const ub = (b.evidence && b.evidence.uids && b.evidence.uids[0]) || 0;
        return ua - ub;
    });

    /* ── 上限：每码 ≤PER_CODE，总量 ≤TOTAL。超出记在首条的 evidence.suppressed ── */
    const limits = { ...LIMITS, ...(opts.limits || {}) };
    const kept = [];
    const perCode = new Map();
    const dropped = new Map();
    for (const d of out) {
        const n = perCode.get(d.code) || 0;
        if (n >= limits.PER_CODE || kept.length >= limits.TOTAL) {
            dropped.set(d.code, (dropped.get(d.code) || 0) + 1);
            continue;
        }
        perCode.set(d.code, n + 1);
        kept.push(d);
    }
    if (dropped.size) {
        for (const d of kept) {
            const n = dropped.get(d.code);
            if (n) {
                d.evidence.suppressed = n;
                dropped.delete(d.code);
            }
        }
        /* 兜底：某码全被总量上限压掉（一条都没留下）时，把数量挂到第一条上。 */
        const rest = [...dropped.values()].reduce((s, n) => s + n, 0);
        if (rest && kept.length) {
            kept[0].evidence.suppressed = (kept[0].evidence.suppressed || 0) + rest;
        }
    }

    /* ── P-a0 的 5 个码在这里全部是 blocker（见文件头的表） ──
     * 这一段的唯一作用是**保证**不会因为将来复制粘贴漏掉 severity 而产出没有等级的诊断；
     * 它不做闭集校验（闭集由 `constants.test.mjs` 与 `structural.test.mjs` 守着）。 */
    for (const d of kept) {
        if (BLOCKERS.has(d.code)) d.severity = "blocker";
    }
    return kept;
}

/** 隧道的跨度说明（不吐坐标）。 */
function describeSpan(e) {
    if (!e) return "允许跨度";
    const span = e.variant === "tier2" ? 9 : 5;
    return `${span} 格`;
}

export default structuralDiagnoses;
