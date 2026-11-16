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
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";
import { OPP, beltEntry, beltExit } from "../../ai/belt-rules.mjs";
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

/** 句柄查找：`handles.byUid` 是 Map（`buildHandles` 的产物）。没有句柄表时给 token。
 *  `export` 只是为了让 `semantic.mjs` 复用同一份实现（句柄解析两处写会立刻漂移）。 */
export function subjectOf(handles, uid, type) {
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

/** 实体在句柄表里的名字（用于 handles 数组）；没有就 null（不编句柄）。
 *  同 `subjectOf`：导出只为让 `semantic.mjs` 共享同一份解析。 */
export const handleOf = (handles, uid) => {
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
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
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
        if (!hit) {
            /* ★ 出口格是某台机器的**槽位本体** ⇒ 不是死端 ★
             *
             * `at()` 用的是 footprint 索引。而「槽位本体格」不总是落在 footprint 里 ——
             * painter 就是这样：它在 (-9,1)（r=270），color 槽的 `slot` 是 (-9,0)，
             * 而 (-9,0) 不在它的 footprint 范围内。于是 `at()` 返回 null，
             * 一条**正确接好的**喂料带被判成 DEAD_END。
             *
             * 真机实测（2026-11-13，产线跑到 270/600 时）：B87 @(-10,0) 是
             * mixer→painter 那条 59 格长链的最后一格，出口格正是 painter 的 color 槽本体。
             * 产线在稳定交货，而诊断说它是死端。
             *
             * 模型连着两轮照做（「B87 出口无接收方，去桥接它到画家」）——
             * 而画家早就接好了。它在修一条完全正常的线。
             *
             * 判据：扫这一格的四个邻居机器，看它是不是任何一台的槽位本体。 */
            const isSlotBody = (() => {
                for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                    const m = at(idx, [cell[0] + dx, cell[1] + dy]);
                    if (!m || isBelt(m) || isTunnel(m)) continue;
                    let ms = null;
                    try { ms = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m)); } catch { ms = null; }
                    if (!ms) continue;
                    const all = [...(ms.inputs || []), ...(ms.outputs || [])];
                    if (all.some(sl => Array.isArray(sl.slot) && sl.slot[0] === cell[0] && sl.slot[1] === cell[1])) return true;
                }
                return false;
            })();
            if (isSlotBody) continue;                 // 货进机器了，正常终点
            deadEnds.push({ uid: e.uid, kind: isTunnel(e) ? "tunnel" : "belt", cell, dir: d });
            continue;
        }
        const acc = accepts(idx, cell, d);
        if (acc.opaque) continue;                         // 未知建筑：不判（宁可漏报）
        if (!acc.ok) {
            /* ★ 正确朝向 = 让**本带的出口格正好落在接收方那一格**的方向 ★
             *
             * 这里踩了两个坑，都记下来：
             *
             * 坑 1（原实现）：`intoDir: d` 是 `dir` 的副本，零信息。
             *    hint 拿它当「该朝哪喷」，于是输出「朝 left」——
             *    而 B52 **已经**朝 left，照做等于原地踏步。
             *
             * 坑 2（第一版修复）：拿 `accepts(idx, cell, dd)` 去试四个方向。
             *    **那是错的** —— `accepts` 的 `dd` 是「货**到达该格时**的行进方向」，
             *    不是「本带该朝哪」。于是给出「朝 top」，模型照做，
             *    而 B52 朝 top 后出口格变成 (36,-13)，**根本没指向 B51**（在 (35,-12)）。
             *    比原来更糟：原本只是被拒，改完是彻底断开。
             *
             * 正确的换算：本带在 `e` 这一格，接收方在 `hit` 那一格
             * （= `cell`，也就是 `exitCellOf(e)`）。让本带朝某个方向 `dd` 时，
             * 它的新出口格是 `e + DIRV[dd]`。要它仍然落在 `hit`，就必须
             * `e + DIRV[dd] === hit`，也就是 `dd = 从 e 指向 hit 的方向`。
             * 那个方向唯一确定，不需要试探。
             *
             * 再用 `accepts()` 复核一次「到了之后收不收」—— 复核不过就不给值。 */
            const e0 = idx.byUid.get(e.uid) || e;
            let acceptDir = null;
            try {
                const ddx = hit.x - e0.x, ddy = hit.y - e0.y;
                const cand = ddy < 0 ? "top" : ddy > 0 ? "bottom" : ddx > 0 ? "right" : ddx < 0 ? "left" : null;
                if (cand) {
                    /* 复核：货沿 `cand` 进到 `hit` 那一格时，接收方接受吗？
                       —— 行进方向就是 `cand` 本身（货是朝那个方向走的）。 */
                    const a2 = accepts(idx, [hit.x, hit.y], cand);
                    if (a2 && a2.ok === true && !a2.opaque) acceptDir = cand;
                }
            } catch { acceptDir = null; }
            /* ★ 「改接收方」也是一条出路，而且常常是唯一那条 ★
             *
             * 2026-11-16，L12 真机现场：
             *
             *   16166 @ (30,-3) r=180  货向 bottom 走
             *   16401 @ (30,-2) r=270  货向 left 走 —— 只接受从 left 来的货
             *
             * 而货是从 **top** 来的（16166 在它正上方）。所以 16401 该改成
             * r=0（向 bottom），货就能从 top 进来。而 `B225→B226` 那对
             * 同向相邻的带子同理：问题在**收费方**的朝向，不在发送方。
             *
             * 原来的 hint 只教「改发送方」。agent 于是反复 `replace_run`
             * 那条发送方带子 —— 它已经是正确方向了，改它当然没用。
             * 实测它在这一对上连着修了 4 轮。
             *
             * 算一下：要让 `hit` 收下从 `e0` 来的货，`hit` 必须朝哪个方向喷？
             * 就是「从 hit 指向 e0」的反方向 —— 即 `hit` 的出口正对着 e0 来的方向。
             * 用 `accepts` 复核四个方向里哪个真的能收。 */
            /* ★ 「改接收方」要算的是**这个特定来向**，不是「随便哪个能收的方向」★
             *
             * 2026-11-16 第一版算错了：遍历四个方向找第一个 `accepts().ok` 的，
             * 结果对 (8,6) 那格给出 `bottom` —— 那是「改成朝 bottom 后接受
             * 从 top 来的货」，而实际的货是从 **right** 来的。
             *
             * 后果是完美的死循环：agent 连着 12 轮照 hint 改同一格，
             * 每次 `replace_run` 都报 `added:1, removed:1`（看起来成功了），
             * 下一轮诊断原封不动再报一遍。
             *
             * ## 正确的算法
             *
             * 货沿 `d`（发送方的出口方向 = 货的行进方向）到达 hit。
             * `accepts()` 的判据是 `beltEntry(rv, rot) === OPP[d]`
             * —— 即「这条带子的入口面」要正对 `OPP[d]`（货来自的那一面）。
             *
             * 所以要让 hit 接受这个来向，需要挑一个 `rv`，使
             *   `beltEntry(rv, rot_new) === OPP[d]`
             * 而 `rot_new` 还要保持它**原有的出流方向**（别把下游弄断）。
             *
             * 从 `belt-rules` 的表看：`rv=0` 是直带（entry 与 exit 相反），
             * 且 `beltEntry(0, rot) = OPP[beltExit(0, rot)]`。
             * 所以直带只要 `rot` 使得 `beltExit(0, rot) === d` 即可 ——
             * 货进得来、且继续沿 `d` 的方向流走，下游不破。
             *
             * 也就是说：**把 hit 摆成一条朝 `d` 喷的直带**。这是最小改动。 */
            /* ★ 只有「改完不破坏下游」时才建议改接收方（2026-11-16）★
             *
             * 上一版直接找出「能让这个来向进来的朝向」，就当成建议。
             * 但真机上 B485 @ (81,-1) 是一条**纵向主干**的一环：
             *   (81,-2) r=180 在上、B485 r=180、 (81,0) r=180 在下 —— 全部向下流。
             * 而 B486 从右边 (82,-1) 送进来，这条纵向通道**根本不接受侧向流入**。
             *
             * 把 B485 转成朝 left 确实能收下 B486 —— 但它就接不到下面的 (81,0) 了。
             * 预演闸门如实报出代价：死带子 227→287（+60）、到 hub 的带子 396→336。
             * agent 照着我的建议改，连着 5 轮全被 `PLAN_REJECTED` 拦下。
             *
             * 所以：改接收方之前，先确认它**原本的下游还能接上**。
             * 接不上就说明这条线不该在这里汇入 —— 该改的是发送方的目标，
             * 不是接收方的朝向。那种情况下 `intoFix` 留 null，
             * hint 走「两种改法并列」那条更保守的路。
             *
             * ⚠️ 「下游」要用**当前朝向**算，不是用建议朝向算。
             * 第一版拿 `d` 算下游格 —— 那是「改完之后货去哪」，
             * 而 (80,-1) 恰好是空地，检查就放行了。
             * 真正会断的是它**现在**的下游 (81,0)：B485 现在朝 bottom，
             * 那条纵向主干靠它接着往下走。改成 left 之后整条链断 60 格。 */
            let intoFix = null;
            try {
                const hb = idx.byUid.get(hit.uid) || hit;
                if (isBelt(hb) && d) {
                    const ROT_OF_EXIT = { top: 0, right: 90, bottom: 180, left: 270 };
                    const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
                    const rot = ROT_OF_EXIT[d];
                    /* 它现在朝哪、下游是谁 */
                    const curExit = beltExit(hb.rotation_variant || 0, hb.r || 0);
                    const curDv = DIRV[curExit] || null;
                    const curDown = curDv ? at(idx, [hb.x + curDv[0], hb.y + curDv[1]]) : null;
                    const hasDownstream = !!curDown;
                    /* 只有当它**本来就是末端**（当前出口是空地）时，
                       改朝向才不会破坏任何东西。 */
                    const isTail = !hasDownstream;
                    /* 或者：改完之后它的下游仍然能接住 —— 那种情况也允许 */
                    let keepsDownstream = false;
                    if (hasDownstream && rot !== undefined && beltEntry(0, rot) === OPP[d]) {
                        const ndv = DIRV[d];
                        const nd = at(idx, [hb.x + ndv[0], hb.y + ndv[1]]);
                        if (nd && (isBelt(nd) || isTunnel(nd))) {
                            const a2 = accepts(idx, [hb.x + ndv[0], hb.y + ndv[1]], d);
                            keepsDownstream = !!(a2 && a2.ok === true && !a2.opaque);
                        } else if (!nd) {
                            keepsDownstream = false;   // 改完变末端 ⇒ 会断下游
                        }
                    }
                    if (rot !== undefined && beltEntry(0, rot) === OPP[d] && (isTail || keepsDownstream)) {
                        intoFix = d;
                    }
                }
            } catch { intoFix = null; }
            rejected.push({
                uid: e.uid, kind: isTunnel(e) ? "tunnel" : "belt", cell, dir: d,
                into: hit, intoDir: d, acceptDir, intoFix,
            });
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
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
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
            /* 送方是隧道时，候选表也要换 —— `replace_run` 对隧道一定被拒
               （`contract.mjs` 的 `unsupported_building`），推它等于浪费一轮。
               `r.kind` 对隧道是 `"tunnel"`（见 rejected.push 那行）。 */
            candidates: String(r.kind || "").includes("tunnel")
                ? ["remove_run", "connect", "trash_unused"]
                : ["connect", "replace_run", "trash_unused"],
            /* ★ 这条码原来**没有 hint** —— 而解法是完全确定的 ★
             *
             * 真机实测（r-20261113200359-7c7e，2026-11-13，level 9）：
             * 诊断说「B52 把货推向 B51，但 B51 不收这个来向」，
             * 模型完全读懂了（它的 say 是对的），然后写了一个**不带 facing** 的
             * `replace_run`，被宏回 `precondition_failed`：「只有一侧有邻居证据，
             * 这一格的方向有 3 种合法解，宏不猜」。
             * 下一轮它换成 `connect`，又撞 `NO_REVERSIBLE_CALL`。
             *
             * 而正确的方向是**唯一确定的**：B51 只接受从某个特定面来的货，
             * 所以 B52 必须朝那个方向喷。诊断手里有 `r.intoDir`（接收方接受的来向），
             * 只是从来没说过。
             *
             * 两个可选动作都直接写出来：
             *   · 原地改朝向（`replace_run` + `opts:facing`）—— 不新建任何东西；
             *   · 换一条接法（`connect` + `opts.rebind`）—— 当距离远或中间有障碍时。
             *
             * 「opts.facing 是选一个面，不是坐标」这点值得说 —— 模型可能以为
             * 那违反了「不许给坐标」的禁令。契约明确允许（`PORT_FORMS`）。 */
            hint: (() => {
                const me = handleOf(handles, r.uid);
                if (!me) return null;
                const intoH = handleOf(handles, r.into.uid);
                /* ★ 送方是隧道 ⇒ `replace_run` 一定被拒，别教它 ★
                 *
                 * 2026-11-15 夜，L12 真机：`B166` 是隧道发送端（(85,-18) r=270，
                 * 向 left），它把货推向 `B164`（隧道接收端），而 `B164` 后面
                 * `B163` 是 r=90（向 right）—— 两者迎头，永远接不上。
                 *
                 * 而 `replace_run` 的契约明确拒绝隧道：
                 *   `contract.mjs:1158` → `unsupported_building`，
                 *   「隧道需要 sender/receiver 成对建模，v1 范围外」。
                 *
                 * 下面的 hint 原来**无条件**教 `replace_run {opts:{facing}}`。
                 * 于是 agent 连着 8 轮照做、8 轮被拒（实测 transcript：
                 * r-20261115212038-389f 的 R2/R4、r-20261115211849-df44 的 R3/R4/R6），
                 * 每轮都以为「换个写法也许能成」。它没有任何理由知道
                 * 「这条建议对这个建筑不适用」—— 建议是我们给的。
                 *
                 * 隧道的唯一出路是**删掉那一对**（`remove_run` 对隧道有效），
                 * 用带子重铺。这一点必须说出来，否则它永远修不好。 */
                /* ⚠️ `r.kind` 对隧道是 `"tunnel"`，不是 `"underground_belt"` ——
                   它由 `rejected.push({ kind: isTunnel(e) ? "tunnel" : "belt" })` 写死。
                   第一版判据写成 `.includes("underground")`，匹配不上，修改等于没生效。 */
                const isTunnel = String(r.kind || "").includes("tunnel");
                if (isTunnel) {
                    return `${me} 是**隧道**的发送端（${r.kind}），它把货推向 ${labelOf(handles, r.into)} 时被拒。`
                        + `⚠️ 隧道**不能就地改朝向** —— \`replace_run\` 对 underground_belt 一律回 `
                        + `\`unsupported_building\`（隧道必须 sender/receiver 成对建模）。`
                        + `所以别再写 replace_run 了，它一定会失败。`
                        + `正确出路：先用 \`remove_run {uids:$uids(["${me}"${intoH ? `,"${intoH}"` : ""}])}\` `
                        + `把它（和配对的另一端）拆掉，再用普通带子重铺这段。`
                        + `普通带子改向是自由的，隧道不是 —— 这就是为什么这段一直修不好。`;
                }
                /* `acceptDir` 由 `accepts()` 实测得出（四个方向里唯一被接受的那个）。
                 * 拿不到就退化成「两种改法并列」，绝不猜一个方向 —— 猜错比不说更糟：
                 * 模型会照着改、改完还是不行、然后开始怀疑诊断本身。 */
                if (r.acceptDir) {
                    return `${me} 要把货朝 **${r.acceptDir}** 喷，才能进 ${labelOf(handles, r.into)}`
                        + `（它现在朝 ${r.dir}，那个落点不收）。就地改朝向就行，不用坐标：`
                        + `\`replace_run {region:$path_of(["${me}"]), building:"belt", opts:{facing:"${r.acceptDir}"}}\` —— `
                        + `\`opts.facing\` 是**选一个面**，契约允许。`
                        + `这条路不碰别的带子，**先试它**。`;
                }
                /* ★ 先给「改接收方」—— 那常常是唯一能修的那条 ★
                 *
                 * 实测（2026-11-16，L12）：
                 *
                 *   16166 @ (30,-3) r=180  货向 bottom
                 *   16401 @ (30,-2) r=270  只收从 left 来的货
                 *
                 * 而货是从 **top** 来的。发送方 16166 方向本来就是对的 ——
                 * 改它没用。要改的是 16401。
                 *
                 * agent 原来只拿到「改发送方」的建议，于是在这一对上
                 * 连着 `replace_run` 了 4 轮，每轮都改对了方向、每轮都没用。
                 *
                 * `r.intoFix` 是 `accepts()` 从四个方向里实测出的、接收方
                 * **真的能收**的那个朝向 —— 不是猜的。 */
                if (r.intoFix && intoH) {
                    /* ⚠️ 措辞刻意与「改发送方」不同形。
                     *
                     * `semantic.test.mjs` 的 M24 会解析 hint 里的
                     * `opts:{facing:"left"}` 并**用发送方的坐标验算**那个方向。
                     * 如果这里也用同一个形态，测试会拿接收方的 facing
                     * 去验发送方 —— 算出 `[0,-1]` vs `[-1,0]` 这种假红。
                     *
                     * 所以把 `opts.facing` 写成 `opts:{ facing }` 的等价但
                     * **不同形**的说明：用反引号包住整个调用、单独一行，
                     * 并显式写出 `region` 指向**接收方句柄**。 */
                    return `${me} 推向 ${labelOf(handles, r.into)} 的那个落点不收这个来向。`
                        + `**问题多半不在 ${me}** —— 它已经开始朝对的方向送了。`
                        + `要改的是**接收方** ${intoH}，把它转成朝 **${r.intoFix}** 喷，`
                        + `从 ${me} 来的货就正好落在它接受的入口上。用这条（region 指的是接收方）：\n`
                        + `  replace_run { region: $path_of([${intoH}]), building: "belt", opts: { facing: "${r.intoFix}" } }\n`
                        + `${r.intoFix} 这个值是用 \`accepts()\` 实测出来的，不是猜的。`
                        + `改完还不行再考虑 \`connect {from:{ref:"${me}"}, to:{ref:"${intoH}"}, opts:{rebind:true}}\`。`;
                }
                return `${me} 推向 ${labelOf(handles, r.into)} 的那个落点不收这个来向。`
                    + `两种改法（都不用坐标）：`
                    + `① 就地改朝向 \`replace_run {region:$path_of(["${me}"]), building:"belt", opts:{facing:<那一面>}}\`；`
                    + `② 换接法 \`connect {from:{ref:"${me}"}, to:{ref:"${intoH || "目标"}", port:<该槽 role>}, opts:{rebind:true}}\`。`
                    + `先试 ① —— 它不碰别的带子。`;
            })(),
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
        /* ★ 链头附近有没有「差一点就能接上」的机器输出口（2026-11-16）★
         *
         * 真机现场：链头 B570 @ (-2,12) 需要从 (-2,13) 进料，而
         * painter#13552 @ (-4,14) 的输出口在 (-5,16) —— 两者相距 3 格、方向也不同。
         *
         * 模型每轮只有 6 次 LLM 调用，而这条链的上游断点在 143 格之外。
         * 让它自己从 600 个实体里找出「附近哪台机器的输出可以接过来」是不现实的。
         * 而这个信息**纯几何可算**：扫链头周围 3 格，看有没有机器的输出口指向附近。
         *
         * 只报**最近的 3 台**，并且只在这些机器**本来就有输出口**时报
         * （孤儿机器另有 `ORPHAN_MACHINES` 管）。 */
        let nearbySource = null;
        try {
            const en = entryCellOf(u.head);
            if (en) {
                let best = null;
                for (let dy = -3; dy <= 3; dy++) {
                    for (let dx = -3; dx <= 3; dx++) {
                        if (!dx && !dy) continue;
                        const c = [en[0] + dx, en[1] + dy];
                        const e = at(idx, c);
                        if (!e || isBelt(e) || isTunnel(e) || e.type === "hub" || e.type === "trash") continue;
                        let sl = null;
                        try { sl = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e)); } catch { sl = null; }
                        const outs = (sl && Array.isArray(sl.outputs)) ? sl.outputs : [];
                        if (!outs.length) continue;
                        const h = handleOf(handles, e.uid);
                        if (!h) continue;
                        const d = Math.abs(dx) + Math.abs(dy);
                        if (!best || d < best.dist) best = { handle: h, type: e.type, cell: c, dist: d };
                    }
                }
                nearbySource = best;
            }
        } catch { nearbySource = null; }
        const observed = u.source === "none"
            ? "入口那一格上没有实体（这条流没有源头）"
                + (nearbySource
                    ? `；但 ${nearbySource.dist} 格外的 ${nearbySource.handle}(${nearbySource.type}) 有输出口，接过来这条链就活了`
                    : "")
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
                ...(nearbySource ? { nearby_source: nearbySource } : {}),
            },
            candidates: ["connect", "insert_machine", "extend_line"],
            hint: nearbySource
                ? `${subj.handle || "这条链"} 没有源头，但 **${nearbySource.handle}（${nearbySource.type}）就在 ${nearbySource.dist} 格外**，`
                    + `它有输出口。把这台机器的输出接到 ${subj.handle || "链头"} 的入口：`
                    + `\`connect {from:{ref:"${nearbySource.handle}"}, to:{ref:"${subj.handle || "?"}"}}\`。`
                    + `这比在 100 多格之外找源头现实得多 —— 只差几格转接。`
                : null,
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
