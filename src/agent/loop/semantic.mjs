/**
 * loop/semantic.mjs — 语义层诊断（P-a 第二块）：**形状传播 + 配方闭包 + 作业分配**。
 *
 * 结构层（`structural.mjs`）只回答「线断没断」；这一层回答「这条线在造什么、离目标差哪一步」。
 * 它不重算几何 —— 出入口、槽位、可达性全部来自 P-a0 的 `topology.mjs`，形状代数的唯一真值
 * 来自 `research/ai-player/proto/shape-ops.mjs`（`compile.mjs:46` 也是只读引用它）。
 *
 * ## 四个码（v2 裁决 §2 / §3 / §4 / §6 的修正版）
 *
 * | 码 | 判据 | severity |
 * |---|---|---|
 * | `PROCESSOR_REQUIRED{scope:"stream"}` | 流头形状是配方的中间形状、下一步要工序 P，但 P 不在**这条流**上 | **warn** |
 * | `PROCESSOR_REQUIRED{scope:"factory"}` | 工厂里该类机器总数 < 配方所需（纯计数） | blocker |
 * | `WRONG_SHAPE_AT_HUB` | 货抵达 hub 时形状 ∈ **orbit(goal)** 但不是 goal | blocker |
 * | `DISCARDED_INTERMEDIATE` | 机器 ≥2 输出口，一口死在 trash/空/拒收、另一口到 hub，且被丢的那口形状 ∈ orbit(goal) ∪ 闭包 | blocker |
 *
 * 另加一个 `SHAPE_UNKNOWN`（info，`candidates: []`，**绝不喂给 LLM 当行动依据**）：
 * 契约 §2 要求传播遇到 no-resources / tunnel / unknown-op / cycle / unverified-rotation 时
 * **显式降级**，不许猜。这一条不是新码，是 P-a0 就登记在 `DIAG_CODES` 里的既有码。
 *
 * ## 三条必须写下来的判据修正（否则会重犯「判据把正解判错」的老毛病）
 *
 * 1. **接受集运行期枚举**（v2 §1）。`evidence.site_handles` 给**全部**物理可行落点：
 *    L4 实测 38 个（x=2 二十个、x=3 十二个、x=4 六个），**不是**手写的 x∈{4,5}。
 *    枚举规则与 `replace_run` 的扩展路径逐条对齐（region 覆盖机器 footprint + 废料喷口、
 *    四个网格只含带子/空格、所有区内带子同向、trash 落在 left 喷口、产品口下游能到 hub）。
 *    `semantic.test.mjs` 有一条测试**直接调真宏**逐个对拍这 38 个落点。
 *
 * 2. **排序键**（v2 §3）：`(canReachHub↓, inGoalRawCorridor↓, shapeKnown↓, hopsFromMiner↑,
 *    chainHeadHandle↑)`。**不用「到 hub 跳数」** —— L4 的 x=1 主干有 32 条可达带子，
 *    按拓扑就近会把 cutter 分给主干，正好与目标相反。
 *
 * 3. **上限**（v2 §6）：每码 ≤3、总量 ≤8；超出不静默丢弃，首条带 `evidence.suppressed`。
 *
 * ## 两处比任务书更严的抑制条件（都是为了让它**不跟正解打架**，实测有反例）
 *
 * - `DISCARDED_INTERMEDIATE` 额外要求「另一口送出的形状**不含 goal**」。
 *   字面判据会在**正确的修复**上误报：L4 修好后新 cutter 切 `RuRuRuRu`，右口送 `RuRu----`（=goal）、
 *   左口丢 `----RuRu` —— 而 `----RuRu ∈ orbit(RuRu----)`（180° 就是目标）。
 *   但「切一刀只用一半」是正常工艺，另一半本来就该丢。真正病态的是
 *   **送出去的那口还不是目标**（L5：送 `CuCu----`、丢 `----CuCu`，两者都要再转一次）。
 *   不加这条，任务书自己的负例 T5（修好后 0 条 blocker）必然红。
 *
 * - `WRONG_SHAPE_AT_HUB` **只认 orbit**，不把配方的祖先形状也算进去。这会让 L4 **没有**
 *   这个码（hub 收到 `RuRuRuRu` 是「原料直达」，属祖先而非 orbit）——
 *   与 v1 契约 §5 的期望不符，但与任务书的判据表逐字一致；若把祖先也算进来，
 *   L4 修好后 x=2/x=3/x=5 的残流仍把 `RuRuRuRu` 送进 hub，T5 会红。
 *
 * ## 纪律
 *
 * - **纯函数**：同一份 `(obs, items, goal, handles, opts)` 两次调用逐字节相同（无时钟、无缓存）。
 * - **零副作用**：不读文件、不 spawn。`opts.recipe` 由调用方注入；缺失时整体返回 `[]`，
 *   **绝不自己跑 solver**（solver 一次 200–400ms，且会让「同 obs 两次结果不同」成为可能）。
 * - **不吐坐标**：subject/expected/observed/evidence.handles 只有句柄与计数；
 *   坐标只出现在 `evidence.site_cells`（独立字段，prompt 不渲染）。
 */
import { templateByBuildingVariant, UNLOCK_LEVEL_FALLBACK } from "../../ai/op-templates.mjs";
import { DIRV, OPP, beltEntry } from "../../ai/belt-rules.mjs";
/* 只在「给模型挑一对矿机」时用（见 chooseMinerPair）——
   connect.mjs 不 import 本文件，所以不成环（已实测）。 */
import { connect as planConnect } from "../macros/connect.mjs";
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";
import {
    parse, hash, cutHalf, cutQuad, rotateCW, rotateCCW, rotate180, stack, paint, ALL_COLORS,
} from "../../../research/ai-player/proto/shape-ops.mjs";
import {
    K, indexOf, at, isBelt, isTunnel, tunnelIsSender,
    dirOfRotation, exitDirOf, exitCellOf, entryDirOf, entryCellOf,
    accepts, runEnd, hubReachable, sourceEntityOf,
} from "./topology.mjs";
import { LIMITS, subjectOf, handleOf } from "./structural.mjs";
/* 升级链的「下一档要什么」唯一真值在 `rules.mjs` —— 已与实机的 `upgrade` RPC
   逐项对过（miner T2 = RuRuRuRu×740 + Cu------×800、painting T1 = RbRb----×600，
   四条链全一致）。不在这里抄第二份。 */
import { UPGRADES, UPGRADE_MULTIPLIERS } from "../rules.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 小工具
 * ══════════════════════════════════════════════════════════════════════════ */

const sameCell = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const variantOf = e => (e && e.variant) || "default";

/**
 * 从候选矿机里挑一对，让它们分头喂 mixer 的两个 color 槽而**路线不重叠**。
 *
 * ## 为什么必须真的试算，不能靠几何近似
 *
 * 真机 r-20261112210803-e1a3 → r-20261113093827-cf54：模型反复选 M2+M3
 * （相邻两格）。两条路共用 5 个格子，而 `(35,-12)` 既是 slot1 的喂料格
 * 又是 slot0 那条线的过路格 —— 它只能有一个朝向 ⇒ 游戏落盘时按邻居重算，
 * 计划要 corner（`code=3`）落成直线（`code=1`）⇒ `L1-landing: want 3, got 1`。
 *
 * 我先后试过两个近似判据，都不准：
 *   · 「曼哈顿距离 ≤3 就冲突」—— M6/M9 相距 2 格却**不冲突**
 *     （它们路线平行：slot0 走 x=34 一列、slot1 走 x=35 一列）；
 *   · 「方位角要不同」—— 这一带 8 台矿机**全在东南**，角度差不出 50°。
 *
 * 能分开它们的只有**实际路径**。所以这里直接调 `connect` 的 dry-run
 * 跑两两组合，取第一对不重叠的。最多 8×8 次，每次都是纯函数规划，很便宜。
 *
 * @returns {{a:string,b:string,idxA:number,idxB:number}|null}
 *   找不到时返回 null（调用方退回原来的通用建议，不编）。
 */
function chooseMinerPair(obs, handles, mixer, handlesOfMiners, slotIdx, feedCells) {
    const scratch = Array.isArray(feedCells) ? feedCells : [];
    const t0 = Date.now();
    /* ★ 硬预算：诊断是同步跑的，不能在这儿花几百毫秒 ★
     *
     * 真机实测（第 9 关，2026-11-13）：8 台蓝矿机 × 2 个槽 × 2 种分配
     * = 32 次完整 `connect` 规划，单次几十毫秒 ⇒ 一次诊断要好几秒，
     * 而诊断每轮都跑 —— 整个 run 卡在「算配对」上。
     *
     * 三处收紧：
     *   · 只试**前 4 台**矿机（够用了：不重叠的那对通常就在前几台）；
     *   · 累计超过 1500ms 就放弃，退回通用建议；
     *   · 命中第一对立刻返回（已有）。
     *
     * 放弃是安全的：调用方拿到 null 会退回「挑两台隔得远的」那句通用提示，
     * 不会编假配对。 */
    const MAX_MINERS = 4;
    /* 跨矿种配对会跑两遍（[蓝,红] 与 [红,蓝]），每次最多 4×4 组合 ⇒ 最坏 32 次规划。
       预算给 1200ms：实测一次完整 `connect` 约 30–60ms，
       正常情况头几组就命中；超预算就放弃，退回通用提示（不编假配对）。 */
    const MAX_MS = 1200;
    const cellsOf = (uid, idx) => {
        if (Date.now() - t0 > MAX_MS) return null;
        const r = planConnect(
            { from: { uid }, to: { uid: mixer.uid, port: { role: "color", index: idx } }, opts: { rebind: true } },
            { entities: obs.entities, obs, scratch_feed_cells: scratch },
        );
        return (r && r.ok && Array.isArray(r.cells)) ? r.cells.map(c => `${c.x},${c.y}`) : null;
    };
    /* `handlesOfMiners` 是句柄名数组；转成 uid。 */
    const byHandle = new Map();
    for (const e of obs.entities || []) {
        const h = handleOf(handles, e.uid);
        if (h) byHandle.set(h, e);
    }
    /* ★ 候选顺序要**交错**，不能先塞满一种颜料 ★
     *
     * `MAX_MINERS` 只有 4，如果调用方按「[蓝蓝蓝蓝…红红红]」传进来，
     * slice 之后只剩蓝的，配对就永远是「两台蓝」——
     * 而 mix() 恰恰需要两种不同的颜料。
     *
     * 所以从第二种颜料开始，与前一种交替取：
     *   [蓝0, 红0, 蓝1, 红1, …]
     * 这样前 4 个里一定有至少一台红的。 */
    const interleaved = (() => {
        const out = [];
        const left = handlesOfMiners.slice();
        /* `handlesOfMiners` 的调用方约定：前一段是颜料 A，后一段是颜料 B。
           用「取首、取尾、取次首、取次尾…」交错，无需知道分界点。 */
        let i = 0, j = left.length - 1;
        while (i <= j) {
            if (i === j) { out.push(left[i]); break; }
            out.push(left[i++]);
            out.push(left[j--]);
        }
        return out;
    })();
    const ms = interleaved.slice(0, MAX_MINERS).map(h => ({ h, e: byHandle.get(h) })).filter(x => x.e);
    if (ms.length < 2) return null;
    /* 每种 (slotA, slotB) 都试，允许两台各接任一槽。 */
    for (const [ia, ib] of (slotIdx.length === 2 ? [[slotIdx[0], slotIdx[1]], [slotIdx[1], slotIdx[0]]] : [])) {
        const cache = new Map();
        const get = (uid, idx) => {
            const k = `${uid}:${idx}`;
            if (!cache.has(k)) cache.set(k, cellsOf(uid, idx));
            return cache.get(k);
        };
        for (const x of ms) {
            for (const y of ms) {
                if (x.e.uid === y.e.uid) continue;
                const ca = get(x.e.uid, ia);
                if (!ca) continue;
                const cb = get(y.e.uid, ib);
                if (!cb) continue;
                const setA = new Set(ca);
                if (cb.some(k => setA.has(k))) continue;      // 重叠 ⇒ 换一对
                return { a: x.h, b: y.h, idxA: ia, idxB: ib };
            }
        }
    }
    return null;
}

const unwrapObs = obs =>
    (obs && typeof obs === "object" && !Array.isArray(obs.entities) && obs.result
        && Array.isArray(obs.result.entities) ? obs.result : (obs && typeof obs === "object" ? obs : {}));

/** op → 机器种类（任务书 §F-10 的字段口径：op + machine 两个都要）。 */
const MACHINE_OF_OP = Object.freeze({
    mine: "miner",
    cut: "cutter", cutQuad: "cutter",
    rotate: "rotater", rotateCCW: "rotater", rotate180: "rotater",
    stack: "stacker",
    paint: "painter", paintMirrored: "painter", paintQuad: "painter",
    mix: "mixer",
});

/** 一次传播值的内部表示：Set<symbol>。symbol = 形状 hash（含 `:` 的多层）或颜色名。 */
const isColorSymbol = s => ALL_COLORS.includes(s);

function safeParse(s) {
    if (typeof s !== "string" || !s) return null;
    try { return parse(s); } catch { return null; }
}

function safeHash(shape) {
    try { return hash(shape); } catch { return null; }
}

/** 把传播值里的形状符号取出来（颜色不算形状）。 */
function shapesOf(value) {
    if (!value) return [];
    const out = [];
    for (const v of value) if (typeof v === "string" && !isColorSymbol(v)) out.push(v);
    return out.sort();
}

/** 目标形状的全部旋转（含自身）。解析失败时只有自身（保守，不编）。 */
function orbitOf(goal) {
    const p = safeParse(goal);
    if (!p) return new Set([goal]);
    const out = new Set([goal]);
    for (const f of [rotateCW, rotateCCW, rotate180]) {
        const h = safeHash(f(p));
        if (h) out.add(h);
    }
    return out;
}

/** 是否「再转一次就是 goal」。 */
function oneRotationFrom(shape, goal) {
    const p = safeParse(shape);
    if (!p) return false;
    for (const f of [rotateCW, rotateCCW, rotate180]) if (safeHash(f(p)) === goal) return true;
    return false;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 配方模型（level 门控 + 闭包 + 下一步）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 配方模型：闭包 / 原料 / 所需机器 / 「这个形状下一步该被哪一步消费」。
 *
 * **level 门控**：`opts.level` 给出时，解锁等级高于它的步骤被剔除（记进 `gated`）。
 * 理由不是洁癖 —— 契约 §6 已实测：L5 用未门控配方会渲染出 L16 的 cutQuad，
 * 而模型照做必然失败。剔掉之后 `needs` 只统计**这个等级真能造**的机器，
 * `scope:"factory"` 的 blocker 就一定是可修的（否则会出现「要求造 L16 机器」的死局）。
 */
function recipeModel(recipe, level) {
    const steps = (Array.isArray(recipe.steps) ? recipe.steps : [])
        .filter(s => s && typeof s.hash === "string");
    const usable = [];
    const gated = [];
    const lvl = Number.isInteger(level) ? level : null;
    for (const s of steps) {
        const need = UNLOCK_LEVEL_FALLBACK[s.op];
        if (lvl !== null && typeof need === "number" && need > lvl) gated.push(s.op);
        else usable.push(s);
    }

    const closure = new Set();
    const raw = new Set();
    const needs = new Map();
    const next = new Map();          // 形状 hash → 消费它的步骤（取步骤表里第一条，确定性）
    for (const s of usable) {
        closure.add(s.hash);
        if (s.op === "mine") { raw.add(s.hash); continue; }
        const m = MACHINE_OF_OP[s.op];
        if (m && m !== "miner") needs.set(m, (needs.get(m) || 0) + 1);
        for (const inp of (Array.isArray(s.inputs) ? s.inputs : [])) {
            if (typeof inp === "string" && !next.has(inp)) next.set(inp, s);
        }
    }
    /* 调用方若显式给了 raw/closure（数组或 Set），合并进来 —— 但**不覆盖**推导结果：
       推导来自 steps 是唯一可核对的口径，外部字段只当补充。 */
    for (const bag of [recipe.raw, recipe.closure]) {
        if (!bag) continue;
        const list = bag instanceof Set ? bag : (Array.isArray(bag) ? bag : []);
        for (const v of list) if (typeof v === "string") (bag === recipe.raw ? raw : closure).add(v);
    }
    return { usable, gated, closure, raw, needs, next };
}

/** 配方里「该被工序机消费」的形状集合：所有非 miner 步骤的 inputs（去重）。 */
function consumableSet(model) {
    const out = new Set();
    for (const s of model.usable) {
        if (s.op === "mine") continue;
        for (const i of (Array.isArray(s.inputs) ? s.inputs : [])) if (typeof i === "string") out.add(i);
    }
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 形状传播
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 前向传播引擎。
 *
 * **按输出槽传播**（红队 F-6）：一台 cutter 的 left / right 各得各的形状，
 * 不能把整台机器的输出都赋同一个值 —— 否则 `B135` 会得到 `----CuCu|CuCu----` 这种并集。
 *
 * 传播规则（任务书逐条要求，全部走 shape-ops，不硬编码产品/废料）：
 *   · `mine`  → `resources[origin]`；
 *   · `belt`  → 上游实体；
 *   · `balancer` → 两路输入并集 → 两路输出都发全集（`process_BALANCER` 只改流向不改货物）；
 *   · `cutter` → `cutHalf(parse(s))[0]=left / [1]=right`；
 *   · `rotater` → default=CW、ccw=CCW、rotate180=180；
 *   · `stacker` → `stack(lower, upper)`；
 *   · `painter` → `paint(shape, color)`，颜色解析不出 ⇒ 停（记 SHAPE_UNKNOWN）；
 *   · `underground_belt` → 屏障；
 *   · 其余/无模板 → 停（记 SHAPE_UNKNOWN）。
 *
 * 遇到无法判定的情形一律**记原因**，绝不猜。
 */
function makeShapeEngine(obs, idx) {
    const ore = new Map();
    const resourcesPresent = Array.isArray(obs.resources) && obs.resources.length > 0;
    for (const r of (Array.isArray(obs.resources) ? obs.resources : [])) {
        if (Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && typeof r[2] === "string") {
            ore.set(K([r[0], r[1]]), r[2]);
        }
    }

    /** reason → {uids:Set, kinds:Set}。同因合并，避免把预算吃光。 */
    const unknown = new Map();
    const mark = (reason, uid, kind) => {
        if (!Number.isInteger(uid)) return;
        let g = unknown.get(reason);
        if (!g) { g = { uids: new Set(), kinds: new Set() }; unknown.set(reason, g); }
        g.uids.add(uid);
        if (kind) g.kinds.add(kind);
    };

    const slotMemo = new Map();      // `${uid}:${role}` → Set|null
    const beltMemo = new Map();      // belt uid → Set|null
    const busy = new Set();
    /* 本次递归中「撞过环」的实体 —— 它们的值是半成品，不能进 memo。见 beltValue 的注释。 */
    const poisoned = new Set();

    const tplOf = e => templateByBuildingVariant(e.type, variantOf(e));

    /** 上游实体是否把货「喷进」`cell`（且方向对）。
     *
     * @param fromDir 宿主**槽的朝向**（`sl.dir`）或带子的**入口方向**——
     *   两者都表示「货从这个方位进入宿主」，所以上游机器的输出方向必须是它的反面
     *   （`OPP[fromDir]`）：槽在机器的下沿 ⇒ 上游在更下方 ⇒ 它往上喷。
     *
     * ⚠️ 2026-11-13：我曾把这里改成 `o.dir === fromDir`，理由是
     * 「M3 在 B307 下方、输出 dir=bottom 却被判不匹配」。**那是错的** ——
     * 改完 `semantic.test.mjs` 立刻红了 8 条（T1/T3/T4/T5/T8/T11…），
     * 因为 cutter 的输入槽 `dir=bottom`、上游矿机 `dir=top`，
     * 只有 `OPP[bottom]==="top"` 才对得上。
     *
     * 真实情况是 `B307` 那条线的**方向本身坏了**（游戏落盘时按邻居重算 rv），
     * 不是判据的问题。诊断正确地指出了「这条线不通」，我不该为了让诊断闭嘴而改判据。
     *
     * 教训：判据红了先查数据，不要先改判据 —— 那会把「检测到问题」变成「检测不到」。 */
    function ejectSlotInto(up, cell, fromDir) {
        if (!up) return null;
        if (isBelt(up) || isTunnel(up)) return null;
        const s = slotsOf(up.type, up.variant, up.x, up.y, up.r || 0, beltRvOf(up));
        if (!s) return null;
        return s.outputs.find(o => sameCell(o.cell, cell) && o.dir === OPP[fromDir]) || null;
    }

    /** 机器输入槽收到的形状（按槽位 role 找槽）。 */
    function inputValue(m, role) {
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
        if (!s) return null;
        const sl = s.inputs.find(i => i.role === role);
        if (!sl) return null;
        const up = at(idx, sl.cell);
        if (!up) return null;
        if (isBelt(up)) {
            if (!sameCell(exitCellOf(up), sl.slot)) return null;
            if (!accepts(idx, sl.slot, exitDirOf(up)).ok) return null;
            return beltValue(up);
        }
        if (isTunnel(up)) {
            if (tunnelIsSender(up)) return null;                        // sender 只会吞
            if (!sameCell(exitCellOf(up), sl.slot)) return null;
            const sender = senderOf(up);
            mark("tunnel", sender ? sender.uid : up.uid, "underground_belt");
            return null;
        }
        const o = ejectSlotInto(up, sl.slot, sl.dir);
        return o ? outValue(up, o.role) : null;
    }

    /** 带子的形状 = 喂它的那个输出槽的形状。
     *
     * ★ 「算完了是 null」和「暂时算不出」必须分开 ★
     *
     * 递归里有 `busy` 环保护：撞上正在算的祖先就返回 null。
     * 但那个 null 原来会被**沿途每一层**当成结果缓存进 `beltMemo` ——
     * 于是一次环检测的副作用被永久化，整条链以后永远返回 null。
     *
     * 实测（第 9 关 mixer C7）：M6/M2 两台矿机都在挖蓝矿、
     * 喂料带每跳的 `sameCell` 与 `accepts` 全部通过、
     * `computeOut(M6)` 也确实跑到了 `op==="mine"`、`kind=blue`，
     * 但 `slot_values` 恒为 `[null,null]`，诊断于是永远说「源头断了」，
     * 让模型反复重接已经接好的线。
     *
     * 现在用一个 `poisoned` 标记：本次递归中遇到过环 ⇒ 这一格的值**不可缓存**，
     * 下次还会重算（那时环已经被打破，能算出真值）。 */
    function beltValue(b) {
        if (!isBelt(b)) return null;
        if (beltMemo.has(b.uid)) return beltMemo.get(b.uid);
        const key = `belt:${b.uid}`;
        if (busy.has(key)) { mark("cycle", b.uid, "belt"); poisoned.add(b.uid); return null; }
        busy.add(key);
        let val = null;
        const up = at(idx, entryCellOf(b));
        if (up) {
            if (isBelt(up)) {
                if (sameCell(exitCellOf(up), [b.x, b.y]) && accepts(idx, [b.x, b.y], exitDirOf(up)).ok) {
                    val = beltValue(up);
                }
            } else if (isTunnel(up)) {
                if (!tunnelIsSender(up) && sameCell(exitCellOf(up), [b.x, b.y])) {
                    const sender = senderOf(up);
                    mark("tunnel", sender ? sender.uid : up.uid, "underground_belt");
                }
            } else {
                const o = ejectSlotInto(up, [b.x, b.y], entryDirOf(b));
                if (o) val = outValue(up, o.role);
            }
        }
        busy.delete(key);
        /* 递归中撞过环 ⇒ 这个值是「半成品」，别写进 memo。 */
        if (!poisoned.has(b.uid)) beltMemo.set(b.uid, val);
        return val;
    }

    /** 机器某个输出槽的形状（按槽传播）。 */
    function outValue(m, role) {
        const key = `${m.uid}:${role}`;
        if (slotMemo.has(key)) return slotMemo.get(key);
        if (busy.has(key)) { mark("cycle", m.uid, m.type); poisoned.add(m.uid); return null; }
        busy.add(key);
        const val = computeOut(m, role);
        busy.delete(key);
        /* 与 beltValue 同理：撞过环的值是半成品，不缓存。 */
        if (!poisoned.has(m.uid)) slotMemo.set(key, val);
        return val;
    }

    function computeOut(m, role) {
        const tpl = tplOf(m);
        if (!tpl) { mark("unknown-op", m.uid, m.type); return null; }
        if (m.type === "trash" || m.type === "hub") return null;
        /* ★ 2026-11-13：删掉了 `if (rot !== 0) return null` ★
         *
         * 那行原本的顾虑是「旋转后的槽几何没验证过，不敢推形状」。
         * 现在 `slotsOf` 已经实测四种旋转全给对几何（见下），
         * 这行不再是保守，而是**在破坏整个语义层**。
         *
         * 实测代价（第 9 关 r-20261113103514-fda0）：M6/M2 两台矿机都接了线、
         * 喂料带都正确对准 mixer 的槽（`exitCell` 都命中 slot 格），
         * 但 M6 的 `r=270` ⇒ 这一行直接返回 null ⇒
         *   · 蓝颜料在传播第一跳就断掉；
         *   · 两个槽都报 `no known incoming pigment`；
         *   · 诊断于是永远说「源头断了」，让模型一遍遍重接**已经接好的线**。
         *   那个 run 里模型重复执行了 4 次同样的 connect。
         *
         * `slotsOf(type, variant, x, y, r, rv)` 的实测结果（rot 0/90/180/270 各不同且正确）：
         *   miner   0:out top  90:out right  180:out bottom  270:out left
         *   cutter  0:in bottom 90:in left    180:in top      270:in right
         *   mixer   0:in bottom×2 90:in left×2 …
         *   painter 0:out right 90:out bottom 180:out left    270:out top
         * 与游戏 `getTileSpaceBounds` / `Vector.rotateFastMultipleOf90` 一致。
         *
         * ⚠️ 保留 `rot` 变量：下面 `paint` 分支要用它决定颜色从哪一侧进
         * （镜像 variant 的语义）。 */
        const rot = (((Number(m.r) || 0) % 360) + 360) % 360;
        const op = tpl.op;
        const unions = (...vals) => {
            const out = new Set();
            for (const v of vals) if (v) for (const x of v) out.add(x);
            return out.size ? out : null;
        };

        if (op === "mine") {
            const kind = ore.get(K([m.x, m.y]));
            if (kind === undefined) { mark(resourcesPresent ? "no-ore" : "no-resources", m.uid, m.type); return null; }
            /* ★ 颜料矿的输出是 `color:<name>`，不是裸 `<name>` ★
             *
             * 矿种（`obs.resources` 的第三元）用的是裸名：`blue` / `red` / `green` / `CuCuCuCu` / …
             * 而配方里颜料用的是带前缀的：`color:blue` / `color:red`（见 `recipeForCached`
             * 的 `mineColor` 步）。
             *
             * 两套命名在这个函数里撞车：矿机站在蓝矿上，`kind` 是 `"blue"`，
             * 原样返回 ⇒ 下游 `mixer` 的 color 槽收到 `"blue"`，
             * 而判据找的是 `v.startsWith("color:")` ⇒ **一条都认不出来**。
             *
             * 实机症状（第 9 关）：两条喂料带子方向完全正确、确实连着蓝矿机，
             * 诊断却报 `color slot 0: no known incoming pigment` —— 传播在命名这一层就断了。
             * `beltsCarryingShape(obs, recipe, "color:blue")` 也因此返回 0 条。
             *
             * 判据：只有**颜料类**矿种需要加前缀。形状类（`CuCuCuCu` / `RuRuRuRu`）
             * 本身就是最终形态，配方里也是裸名，加了反而对不上。 */
            const PIGMENTS = new Set(["red", "green", "blue", "cyan", "purple", "yellow", "white", "uncolored"]);
            return new Set([PIGMENTS.has(kind) ? `color:${kind}` : kind]);
        }
        if (op === "balance") {
            /* 两路输入并集 → 两路输出都发全集。 */
            return unions(inputValue(m, "primary"), inputValue(m, "secondary"));
        }
        if (op === "cut") {
            const v = inputValue(m, "primary");
            const pick = role === "left" ? 0 : role === "right" ? 1 : -1;
            if (pick < 0) return null;
            const out = new Set();
            for (const s of v || []) {
                const p = safeParse(s);
                if (!p) { mark("not-a-shape", m.uid, m.type); continue; }
                const h = safeHash(cutHalf(p)[pick]);
                if (h) out.add(h);
            }
            return out.size ? out : null;
        }
        if (op === "cutQuad") {
            const idxq = /^quad([0-3])$/.exec(role);
            if (!idxq) return null;
            const v = inputValue(m, "primary");
            const out = new Set();
            for (const s of v || []) {
                const p = safeParse(s);
                if (!p) { mark("not-a-shape", m.uid, m.type); continue; }
                const h = safeHash(cutQuad(p)[Number(idxq[1])]);
                if (h) out.add(h);
            }
            return out.size ? out : null;
        }
        if (op === "rotate" || op === "rotateCCW" || op === "rotate180") {
            const f = op === "rotate" ? rotateCW : op === "rotateCCW" ? rotateCCW : rotate180;
            const v = inputValue(m, "primary");
            const out = new Set();
            for (const s of v || []) {
                const p = safeParse(s);
                if (!p) { mark("not-a-shape", m.uid, m.type); continue; }
                const h = safeHash(f(p));
                if (h) out.add(h);
            }
            return out.size ? out : null;
        }
        if (op === "stack") {
            const lo = inputValue(m, "lower");
            const up = inputValue(m, "upper");
            const out = new Set();
            for (const a of lo || []) {
                for (const b of up || []) {
                    const pa = safeParse(a), pb = safeParse(b);
                    if (!pa || !pb) { mark("not-a-shape", m.uid, m.type); continue; }
                    try { const h = safeHash(stack(pa, pb)); if (h) out.add(h); }
                    catch { mark("stack-incompatible", m.uid, m.type); }
                }
            }
            return out.size ? out : null;
        }
        if (op === "paint" || op === "paintMirrored") {
            const v = inputValue(m, "shape");
            const colors = [...(inputValue(m, "color") || [])].filter(isColorSymbol);
            if (!colors.length) { mark("unknown-color", m.uid, m.type); return null; }
            const out = new Set();
            for (const s of v || []) {
                const p = safeParse(s);
                if (!p) { mark("not-a-shape", m.uid, m.type); continue; }
                for (const c of colors) { const h = safeHash(paint(p, c)); if (h) out.add(h); }
            }
            return out.size ? out : null;
        }
        /* ★ `mix` 必须有分支 ★
         *
         * 契约 §2 要求传播遇到不认识的 op 时显式降级成 `unknown-op` —— 那是对的，
         * 但 `mix` 是**已注册**的 op（`op-templates.mjs:454`，机器是 mixer），
         * 把它算进「不认识」是自己的缺陷，不是契约要求。
         *
         * 独立审计实测的后果：425 个 L12 run 里 1444 次 `SHAPE_UNKNOWN`，
         * 每一台 mixer 都把形状传播链切断；连带 `WRONG_SHAPE_AT_HUB` 在
         * 2113 条诊断里**一次都没出现过** —— 也就是说「hub 收到的形状不对」
         * 这件事，这套系统从来没能力说出来。
         *
         * L12 恰好需要白颜料的级联（蓝+绿→青，青+红→白），mixer 是关键工序。
         * 不补这一支，语义层在最需要它的关卡上是瞎的。
         *
         * mix 的语义：两个 color 槽的颜料取并集，得到一个颜色。
         * 形状本身不变（mixer 不改变形状），所以输出的 payload 是那个颜色符号。 */
        if (op === "mix") {
            const a = [...(inputValue(m, "color") || [])][0];
            const b = [...(inputValue(m, "color2") || [])][0];
            /* 两种写法都接受：有的模板把两个槽都叫 color（两格），
             * 有的给 color / color2。取不到就退化成「所有 color 槽的值并起来」。 */
            let cols = [a, b].filter(Boolean);
            if (cols.length < 2) {
                const all = [...(inputValue(m, "color") || [])];
                cols = all.slice(0, 2);
            }
            if (cols.length < 2) { mark("mix-missing-input", m.uid, m.type); return null; }
            /* 混色规则：按位并集。表与 `compile.mjs` 的 `mixColors` 同源
             * （`validate.mjs:1352-1353` 的 COLOR_BITS / BITS_COLOR）——
             * 不另抄一份真值，直接按同一规则算。 */
            const BITS = { red: 1, green: 2, blue: 4, yellow: 3, purple: 5, cyan: 6, white: 7 };
            const BY_BITS = { 1: "red", 2: "green", 4: "blue", 3: "yellow", 5: "purple", 6: "cyan", 7: "white" };
            const bit = cols.reduce((acc, c) => acc | (BITS[c] || 0), 0);
            const merged = BY_BITS[bit];
            if (!merged) { mark("unknown-color", m.uid, m.type); return null; }
            const h = safeHash(merged);
            return h ? new Set([h]) : null;
        }
        mark("unknown-op", m.uid, m.type);
        return null;
    }

    /** 隧道 receiver 的配对 sender（沿反方向找 1..span 格）。 */
    function senderOf(receiver) {
        if (!isTunnel(receiver) || tunnelIsSender(receiver)) return null;
        const d = dirOfRotation(receiver.r || 0);
        const op = OPP[d];
        const span = (receiver.variant === "tier2" ? 9 : 5);
        for (let i = 1; i <= span; i++) {
            const e = at(idx, [receiver.x + DIRV[op][0] * i, receiver.y + DIRV[op][1] * i]);
            if (!e) continue;
            if (!isTunnel(e) || !tunnelIsSender(e)) continue;
            if (dirOfRotation(e.r || 0) !== d) continue;
            return e;
        }
        return null;
    }

    /* 隧道 sender 只要被喂了货，就记一条 tunnel —— 下游的形状不可判定（屏障）。
       放在这里做是因为「被喂」的判据与 sender 自己的 acceptor 相同。 */
    for (const e of idx.ent) {
        if (!isTunnel(e) || !tunnelIsSender(e)) continue;
        const acc = accepts(idx, [e.x, e.y], dirOfRotation(e.r || 0));
        if (acc.ok) mark("tunnel", e.uid, "underground_belt");
    }

    /**
     * 机器某个**槽位**（按索引，不是 role）收到的形状。
     *
     * `inputValue(m, role)` 按 role 查，对多输入同 role 的机器（mixer / stacker
     * 两个槽都叫 `color` / `lower|upper` 分得开，但 mixer 分不开）只能拿到第一个。
     * 而「两个槽分别喂了什么」正是判断 mixer 能否产出的**唯一**依据 ——
     * 配方里 `mix` 步的 inputs 是 `["color:blue","color:red"]`，两种不同的颜料。
     *
     * @param {object} m    机器实体
     * @param {number} i    第几个输入槽（按模板顺序，旋转后）
     * @returns {{slot:Array, cell:Array, dir:string, value:any}|null}
     */
    function inputSlotValue(m, i) {
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
        if (!s || !Array.isArray(s.inputs) || !s.inputs[i]) return null;
        const sl = s.inputs[i];
        const up = at(idx, sl.cell);
        const base = { slot: sl.slot, cell: sl.cell, dir: sl.dir, role: sl.role };
        if (!up) return { ...base, value: null, why: "feed-cell-empty" };
        if (isBelt(up)) {
            if (!sameCell(exitCellOf(up), sl.slot)) return { ...base, value: null, why: "belt-not-aimed", beltUid: up.uid };
            if (!accepts(idx, sl.slot, exitDirOf(up)).ok) return { ...base, value: null, why: "belt-not-accepted", beltUid: up.uid };
            return { ...base, value: beltValue(up), beltUid: up.uid };
        }
        if (isTunnel(up)) {
            if (tunnelIsSender(up)) return { ...base, value: null, why: "tunnel-sender", tunnelUid: up.uid };
            if (!sameCell(exitCellOf(up), sl.slot)) return { ...base, value: null, why: "tunnel-not-aimed", tunnelUid: up.uid };
            return { ...base, value: null, why: "tunnel-barrier", tunnelUid: up.uid };
        }
        const o = ejectSlotInto(up, sl.slot, sl.dir);
        return {
            ...base, machineUid: up.uid, machineType: up.type,
            value: o ? outValue(up, o.role) : null,
            ...(o ? {} : { why: "machine-not-aimed" }),
        };
    }

    return { ore, resourcesPresent, unknown, beltValue, outValue, inputValue, inputSlotValue, senderOf };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 流（相邻带子的极大段）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 这条带子是不是「流头」。
 *
 * 判据：入口**没有被另一条带子有效供给**。注意这不是「没有上游」——
 * 矿机/机器输出口喂的第一条带子也是流头（它的形状来自那台机器的输出槽），
 * 隧道 receiver 之后也算新流（隧道是屏障，跨界形状不可判定）。
 * 把「有上游机器」排除掉会让 L4 的整条 Ru 链**一条流都建不出来**（第一次就踩到了）。
 */
function isStreamHead(idx, b) {
    const up = at(idx, entryCellOf(b));
    if (!up || !isBelt(up)) return true;
    return !(sameCell(exitCellOf(up), [b.x, b.y]) && accepts(idx, [b.x, b.y], exitDirOf(up)).ok);
}

/**
 * 把世界切成流。边界 = 矿机/机器输出口 / hub / trash / 空 / 拒收 / 隧道。
 * 只走带子 —— 隧道是屏障（任务书 §传播表）。
 */
function buildStreams(idx) {
    const heads = idx.ent.filter(b => isBelt(b) && isStreamHead(idx, b))
        .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.uid - b.uid));
    const streams = [];
    for (const h of heads) {
        const list = [];
        const seen = new Set();
        let cur = h;
        let end = null;
        while (cur && !seen.has(cur.uid)) {
            seen.add(cur.uid);
            list.push(cur);
            const c = exitCellOf(cur);
            const d = exitDirOf(cur);
            const e = at(idx, c);
            if (!e) { end = { kind: "empty", by: null, accepted: false }; break; }
            if (isBelt(e)) {
                if (!accepts(idx, c, d).ok) { end = { kind: "belt", by: e.uid, accepted: false }; break; }
                cur = e;
                continue;
            }
            if (isTunnel(e)) {
                end = { kind: "underground_belt", by: e.uid, accepted: accepts(idx, c, d).ok, sender: tunnelIsSender(e) };
                break;
            }
            end = { kind: e.type, by: e.uid, accepted: accepts(idx, c, d).ok };
            break;
        }
        if (!end) end = { kind: "cycle", by: null, accepted: false };
        streams.push({ head: h, belts: list, end });
    }
    return streams;
}

/** 透传建筑（内容不变、只改流向）—— 只有它们的出口可以继续跟。判据来自模板的 `passthrough`。 */
function isPassthrough(e) {
    if (!e) return false;
    const t = templateByBuildingVariant(e.type, variantOf(e));
    return !!(t && t.passthrough === true);
}

/** 沿带子走的跳数上限（防御性：真实世界里一段流远达不到这个量）。 */
const TRACE_MAX_HOPS = 4096;

/**
 * 从 `cell`/`fromDir` 出发，沿货流走到第一个非带子实体。
 *
 * 与 `topology#runEnd` 的区别：**每一跳都验 `accepts`**。`runEnd` 只看几何（它服务的是
 * 「这条带子有去处吗」），而这里要回答「货**真的**能流过去吗」——
 * 一条反向的带子几何上相邻，货却推不进去。隧道不跟（与形状传播的“隧道是屏障”一致）。
 *
 * @returns {{kind:string, entity:object|null, truncated:boolean}}
 */
function traceDownstream(idx, cell, fromDir) {
    let cur = cell;
    let dir = fromDir;
    for (let i = 0; i < TRACE_MAX_HOPS; i++) {
        const e = at(idx, cur);
        if (!e) return { kind: "empty", entity: null, truncated: false };
        if (isTunnel(e)) return { kind: "underground_belt", entity: e, truncated: false };
        if (!isBelt(e)) return { kind: e.type, entity: e, truncated: false };
        /* 货进得来这条带子吗（入口朝向） */
        if (!accepts(idx, cur, dir).ok) return { kind: "belt", entity: e, truncated: false };
        cur = exitCellOf(e);
        dir = exitDirOf(e);
    }
    return { kind: "truncated", entity: null, truncated: true };
}

/**
 * 从 `st` 的**终点**继续往下游找 `kind`：遇到透传节点（balancer）枚举**全部**输出槽。
 *
 * 为什么必须跨过 balancer：`buildStreams` 把 balancer 当边界（它不是带子），
 * 于是一条真实产线被切成「矿机 → balancer」与「balancer → …→ cutter」两段。
 * 2026-10-31 实机三次复现：`cutter@(4,-17)` 就在 `(2,-7)/(3,-7)/(4,-7)/(2,-9)`
 * 四条流的下游（`balancer (2,-8) → balancer (3,-10) → belts → cutter`），
 * 但旧的 `processorOnStream` 只认「流内带子直接喂」⇒ 报「工厂有 1 台 cutter，但都不在这条流上」，
 * 模型于是去**再放一台 cutter**（`replace_run` 两次失败），一次都没想过补断掉的 3 格带子。
 *
 * balancer 有 2 个输出槽（`process_BALANCER` 轮流发），**两路都要跟** ——
 * 只跟一路会漏掉「货从另一路到 cutter」的情况，而两路都跟不会把独立的线连起来：
 * 只有真的共用一个 balancer 的两段，才是同一条货流。
 *
 * 跟到非透传机器就**停**（它改形状，下游不再属于这条流的货）。
 */
function passthroughReaches(idx, st, kind) {
    const end = st && st.end;
    /* 货必须**真的进了**这台 balancer：撞在它侧面上（accepted=false）不算这条流的延续。 */
    if (!end || !Number.isInteger(end.by) || end.accepted !== true) return false;
    const root = idx.byUid.get(end.by);
    if (!isPassthrough(root)) return false;

    const queue = [root];
    const seen = new Set();
    for (let hops = 0; queue.length && hops < TRACE_MAX_HOPS; hops++) {
        const node = queue.shift();
        if (!node || seen.has(node.uid)) continue;
        seen.add(node.uid);
        const s = slotsOf(node.type, node.variant, node.x, node.y, node.r || 0, beltRvOf(node));
        if (!s) continue;
        for (const o of s.outputs) {
            const r = traceDownstream(idx, o.cell, o.dir);
            if (r.kind === kind) return true;
            if (r.truncated) continue;
            if (r.entity && isPassthrough(r.entity)) queue.push(r.entity);
        }
    }
    return false;
}

/**
 * 该类机器是否**在这条流上**。
 *
 * 三个判据，任一成立即算：
 *   1. 流的终点就是它（`buildStreams` 停在机器上时 `end.kind === kind`）；
 *   2. 它的输入槽由**流内带子**直接喂（同一条带子链，原有行为）；
 *   3. 流经透传节点（balancer）之后还到得了它 —— 见 `passthroughReaches`。
 *
 * ★ 判据 3 不能退化成「世界上有这类机器」★
 *   那会让这条诊断永远不触发（等于删掉它）。它仍然要求**物理连通**：
 *   从这条流的终点出发、沿真实带子走、只穿过内容不变的 balancer。
 *   另一条独立产线上的 cutter 不在同一条货流里 ⇒ 仍然 false。
 */
export function processorOnStream(idx, st, kind) {
    if (st.end && st.end.kind === kind) return true;
    const uids = new Set(st.belts.map(b => b.uid));
    for (const e of idx.ent) {
        if (e.type !== kind) continue;
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        if (!s) continue;
        for (const sl of s.inputs) {
            const up = at(idx, sl.cell);
            if (up && isBelt(up) && uids.has(up.uid)
                && sameCell(exitCellOf(up), sl.slot) && accepts(idx, sl.slot, exitDirOf(up)).ok) return true;
        }
    }
    return passthroughReaches(idx, st, kind);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 可落点枚举（v2 §1：运行期枚举，不写死 x/y 范围）
 * ══════════════════════════════════════════════════════════════════════════ */

const freeOrBelt = (idx, cell) => {
    const e = at(idx, cell);
    return !e || isBelt(e);
};

/**
 * `cut` 的可落点：`replace_run(region=[x,y-1,x+1,y], building=[cutter, trash(port=left)])`。
 *
 * 与宏的扩展路径逐条对齐（`remove.mjs#replaceRun` / `planForOrigin`）：
 *   · region 覆盖 cutter footprint `(x,y)(x+1,y)` + 废料喷口 `(x,y-1)`；
 *   · 区内只能有带子/空格（碰到机器、hub、隧道 → 宏整单拒绝）；
 *   · 区内带子必须同向（`inferFlow`），且 cutter 输入朝 bottom ⇒ 全部 exit=top；
 *   · 输入：`(x,y+1)` 供料（带子出口向上喷，或矿机/机器的 ejector 朝上喷进 `(x,y)`）；
 *   · 左口喷 `(x,y-1)` → trash（trash 四边全收，无方向约束），且那一格必须在 region 内；
 *   · 右口喷 `(x+1,y-1)` → 必须有一条**接得住**的带子（entry=bottom），
 *     且那条带的货能到 hub（v2 §1 的「产品口能到达 hub」）。
 *
 * ★ 三条实测出来的对齐细节（不加就会与真宏差 3~10 个落点）★
 *   1. region **必须含至少两列带子**：`replace_run` 的扩展路径按 `regionBelts` 挑 origin，
 *      只有一列带时它选不出 cutter 的第二个 footprint 格（实证：铜线 x=-10..-8 单列）。
 *   2. 废料喷口 `(x,y-1)` 上**必须已有一条带子**（空格不算「区内带子」，同源）。
 *   3. 供料方**不一定**是带子：L4 的 `(2,-9)/(3,-9)/(4,-9)` 由矿机的 ejector 直接朝上喷，
 *      只扫带子会漏掉这 3 个真实落点（它们正是链头那一格）。
 *
 * `semantic.test.mjs` 里有一条测试**直接调真宏**逐格对拍（L4 走廊内 = 38 个）。
 *
 * @param {object} idx
 * @param {Set<number>} reach 能到 hub 的实体 uid
 * @param {(cell:[number,number])=>boolean} inCorridor 该格的上游源头是配方 raw 矿机
 * @returns {Array<{anchor:[number,number], handleUid:number}>}
 */
function cutSites(idx, reach, inCorridor, tblRef = null) {
    /* 候选锚点：供料方把货推进 `(x,y)` 的所有格。带子出口向上 / 机器 ejector 向上。 */
    const anchors = [];
    const push = (x, y) => anchors.push([x, y]);
    for (const e of idx.ent) {
        if (isBelt(e) && exitDirOf(e) === "top") {
            const c = exitCellOf(e);
            if (c) push(c[0], c[1]);
        } else if (!isBelt(e) && !isTunnel(e) && e.type !== "hub" && e.type !== "trash") {
            const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
            if (!s) continue;
            for (const o of s.outputs) if (o.dir === "top") push(o.cell[0], o.cell[1]);
        }
    }
    anchors.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

    const out = [];
    const seen = new Set();
    for (const [sx, sy] of anchors) {
        if (seen.has(`${sx},${sy}`)) continue;
        seen.add(`${sx},${sy}`);
        const cells = [[sx, sy], [sx + 1, sy], [sx, sy - 1], [sx + 1, sy - 1]];
        if (!cells.every(c => freeOrBelt(idx, c))) continue;
        const inside = cells.map(c => at(idx, c)).filter(e => e && isBelt(e));
        if (inside.length < 2) continue;                       // ① 至少两列带子
        if (!inside.every(b => exitDirOf(b) === "top")) continue;
        const waste = at(idx, [sx, sy - 1]);
        if (!waste || !isBelt(waste)) continue;                // ② 废料喷口上要有带子
        const prod = at(idx, [sx + 1, sy - 1]);
        if (!prod || !isBelt(prod)) continue;
        if (entryDirOf(prod) !== "bottom") continue;
        if (!sameCell(entryCellOf(prod), [sx + 1, sy])) continue;
        if (!reach.has(prod.uid)) continue;
        /* 走廊过滤（v2 §3）：铜线落在 x=-10..-8，也是物理可行点，但**不在**目标原料走廊上，
           把它列进 `site_handles` 会把模型引到错误的产线 —— 这正是 F-2 的形态。 */
        if (!inCorridor([sx, sy])) continue;
        const anchor = inside.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))[0];
        /* ★ `pair` 给 **4 格**（完整 2×2），不是 3 格 ★
         *
         * 2026-10-30 实测（第十五次修正）：
         * 给 3 格 `(sx,sy)` `(sx+1,sy)` `(sx,sy-1)` 时，`$path_of` 算出
         * region `[sx, sy-1, sx+1, sy]` 是 **2×2**，而三格只填了 L 形三个角
         * ⇒ `holes:[[sx+1, sy-1]]` ⇒ `contiguous: false` ⇒ `PATH_NOT_RECT`。
         *
         * 而第四格 `(sx+1, sy-1)` **本来就是产品出口的带子**（开始就校验过
         * `prod` 存在且 entry 朝下），所以把它算进来：
         *   · 让 4 格填满 2×2 ⇒ contiguous:true
         *   · region 与 `replace_run` 需要的完全一致
         *   · 不会多框进无关格子
         */
        const pairUids = [
            at(idx, [sx, sy]), at(idx, [sx + 1, sy]),
            waste, prod,
        ].filter(Boolean).map(b => b.uid);
        const pair = pairUids.map(u => handleOf(tblRef, u)).filter(Boolean);
        out.push({ anchor: [sx, sy], handleUid: anchor.uid, pair, pairUids });
    }
    return out.sort((a, b) => (a.anchor[1] - b.anchor[1]) || (a.anchor[0] - b.anchor[0]));
}

/**
 * 1×1 机器（rotater 族：输入 bottom、输出 top）的可落点：
 * 把一条「入口朝下、出口朝上」的直带直接换成机器，上下游都保持闭合。
 *
 * @param {(cell:[number,number])=>boolean} inCorridor 同 `cutSites`：只列目标原料走廊上的落点
 */
function oneCellSites(idx, reach, inCorridor) {
    const out = [];
    for (const b of idx.ent) {
        if (!isBelt(b)) continue;
        if (entryDirOf(b) !== "bottom" || exitDirOf(b) !== "top") continue;
        if (!reach.has(b.uid)) continue;
        if (!inCorridor([b.x, b.y])) continue;
        const up = at(idx, entryCellOf(b));
        if (!up) continue;
        /* 上游：带子必须真的喷进这一格；机器喷口同理。 */
        if (isBelt(up)) {
            if (!sameCell(exitCellOf(up), [b.x, b.y]) || !accepts(idx, [b.x, b.y], exitDirOf(up)).ok) continue;
        } else if (isTunnel(up)) {
            continue;
        } else {
            const s = slotsOf(up.type, up.variant, up.x, up.y, up.r || 0, beltRvOf(up));
            if (!s || !s.outputs.some(o => sameCell(o.cell, [b.x, b.y]) && o.dir === OPP[entryDirOf(b)])) continue;
        }
        /* 下游：机器出口喷 (b.x,b.y-1)，那里必须接得住。 */
        const dn = at(idx, [b.x, b.y - 1]);
        if (!dn) continue;
        if (isBelt(dn)) {
            if (entryDirOf(dn) !== "bottom" || !sameCell(entryCellOf(dn), [b.x, b.y])) continue;
        } else if (isTunnel(dn)) {
            if (!tunnelIsSender(dn)) continue;
        } else {
            if (!accepts(idx, [b.x, b.y - 1], "top").ok) continue;
        }
        out.push({ anchor: [b.x, b.y], handleUid: b.uid });
    }
    return out.sort((a, b) => (a.anchor[1] - b.anchor[1]) || (a.anchor[0] - b.anchor[0]));
}

/**
 * 2×1 双输入机器（painter）的可落点：把**一段直带**就地换成机器，上下游都保持闭合。
 *
 * ## 为什么必须有这个（第 9 关实测的「无解诊断」）
 *
 * `sitesFor()` 原来只给 `cut` 与 `rotate` 系列算落点，`paint` 走的是空数组。
 * 于是 `PROCESSOR_REQUIRED` 对 painter 永远报
 * 「a painter fits at **0** place(s) on the goal corridor」—— 而宏完全放得下。
 *
 * 后果不是「少一条建议」，而是**诊断把模型钉死**：第 9 关的 run 里，模型连着三轮
 * 追这条 painter 诊断（`replace_run` 三次不同写法全部失败），一次都没去看那条
 * 「缺 mixer」的诊断 —— 尽管 mixer 有 3737 个空位、是配方里真正的前置步骤。
 * 一条**看起来可施工、实际无解**的诊断，比没有诊断更糟。
 *
 * ## 判据（与 `oneCellSites` 同源，只是多一格）
 *
 * painter 有 4 个朝向，逐朝向检查「整台机器能不能嵌进这段带子」：
 *   · 两个 footprint 格必须空着或是这条流上的带子（带子会让位）
 *   · 主输入（`shape` 槽）的**来料落点**必须是这条流上的带子，且它的出口正对着
 *   · 输出槽的落点必须空着，或是一条接得住货的带子（朝本机开口）
 *   · 辅料槽（`color`）不检查 —— 配方允许开新支线送颜料，那不是「放不下」
 *
 * 只收 `reach`（能到 hub）且在目标走廊上的位置：与 `cutSites` 同一口径。
 */
function paintSites(idx, reach, inCorridor, tblRef = null) {
    const tpl = templateByBuildingVariant("painter", "default");
    if (!tpl || !Array.isArray(tpl.footprint)) return [];
    const out = [];
    const seen = new Set();
    for (const b of idx.ent) {
        if (!isBelt(b)) continue;
        if (!reach.has(b.uid)) continue;
        if (!inCorridor([b.x, b.y])) continue;
        /* 逐个 rotation 试：机器放进世界后，它的主输入槽槽格必须正好是 b 那一格。
           这里直接问 `slotsOf`（与宏用的是同一张模板），不自己算旋转 ——
           方向函数在本项目里只允许有一个实现。 */
        for (const rot of [0, 90, 180, 270]) {
            const base = slotsOf("painter", "default", 0, 0, rot);
            if (!base) continue;
            const main = base.inputs.find(p => p.role === "shape") || base.inputs[0];
            if (!main) continue;
            /* origin = b - main.slot（同一 rotation 下偏移是常量）。 */
            const ox = b.x - main.slot[0], oy = b.y - main.slot[1];
            const s = slotsOf("painter", "default", ox, oy, rot);
            if (!s) continue;
            const m2 = s.inputs.find(p => p.role === "shape") || s.inputs[0];
            if (!m2 || !sameCell(m2.slot, [b.x, b.y])) continue;
            const k = `${ox},${oy}`;
            if (seen.has(k)) continue;
            /* footprint 每格：空着，或是一条会让位的带子。 */
            const cells = [];
            for (let dx = 0; dx < tpl.footprint[0]; dx++) {
                for (let dy = 0; dy < tpl.footprint[1]; dy++) {
                    cells.push([ox + dx, oy + dy]);       // footprint 是从 origin 起的矩形（旋转后仍由 slotsOf 覆盖）
                }
            }
            /* 用槽位/输出格的收纳范围判占位：凡 footprint 里的格都不能是机器。 */
            const bad = [];
            for (const c of cells) {
                const e = at(idx, c);
                if (e && !isBelt(e)) bad.push(c);
            }
            if (bad.length) continue;
            const o = s.outputs[0];
            if (!o) continue;
            const dn = at(idx, o.cell);
            if (dn && isBelt(dn) && entryDirOf(dn) !== OPP[o.dir]) continue;
            if (dn && !isBelt(dn) && !isTunnel(dn)) continue;      // 机器挡在出口 ⇒ 出不去
            seen.add(k);
            const pairUids = [...new Set(
                [...cells, o.cell].map(c => at(idx, c)).filter(e => e && isBelt(e)).map(e => e.uid),
            )];
            out.push({
                anchor: [ox, oy], handleUid: b.uid,
                pair: pairUids.map(u => handleOf(tblRef, u)).filter(Boolean),
                pairUids, rotation: rot,
            });
        }
    }
    return out.sort((a, b) => (a.anchor[1] - b.anchor[1]) || (a.anchor[0] - b.anchor[0]));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 主入口
 * ══════════════════════════════════════════════════════════════════════════ */

const SEVERITY_RANK = Object.freeze({ blocker: 0, warn: 1, info: 2 });
const CODE_RANK = Object.freeze({
    DISCARDED_INTERMEDIATE: 0,
    WRONG_SHAPE_AT_HUB: 1,
    /* ★ `MIXER_UNFED` 排第一档（在 `PROCESSOR_REQUIRED` 之前）★
     *
     * 它和「配方缺工序」是同一类病：**配方下一步跑不起来**。落在默认档（50）
     * 意味着它排在所有 `PROCESSOR_REQUIRED` / `BELT_HANDOFF_REJECTED` 之后 ——
     * 而后者是**症状**，这条是**成因**。
     *
     * 第 9 关实测：`MIXER_UNFED` 那一轮恰好排到 prompt 第 1 位（同分后按 code
     * 字典序碰巧靠前），但只要世界上还有别的语义诊断，它就往后掉，模型五轮
     * 都没看它一眼，一直在追 `BELT_HANDOFF_REJECTED` 和 painter。
     *
     * 为什么该压在 `PROCESSOR_REQUIRED` 之前：紫色的链是
     * `mine → mix → paint`。mixer 产不出紫颜料，下游的 painter 修了也白修 ——
     * 前提没满足时，先修前提。 */
    MIXER_UNFED: 2,
    PROCESSOR_REQUIRED: 3,
    SHAPE_UNKNOWN: 4,
    /* ★ `DEAD_LINES` 的位置取决于**比例**（2026-11-15 夜，L12 真机）★
     *
     * 它本来是「地形问题」，排在最后（9）——那个判断在废线占少数时成立：
     * 先修配方/前提，废线以后再说。
     *
     * 但实测 L12：485 条带子里 313 条是死的（**65%**），到 hub 的只有 36%。
     * 这时它不是「地形问题」，它是**当前所有尝试失败的原因** ——
     * 每一次 connect 都会撞到那 313 条。而 agent 每轮只清 4 条，
     * 按那个速度要 78 轮。
     *
     * 排序本身不改（`sortByPriority` 用的是这张表），但 severity 在
     * 发诊断时按 `ratio >= 0.5` 升级成 blocker —— blocker 会排在 warn 之前，
     * 效果等价而且不需要让这张表知道运行时的比例。 */
    DEAD_LINES: 9,
    /* 孤儿机器和废线是同一类「地形垃圾」，同级。 */
    ORPHAN_MACHINES: 9,
});

/**
 * 语义层诊断。
 *
 * @param {object} obs   ObsSnapshot（`reader.obs` 的 result 或整个返回体）
 * @param {object|null} items `debug_items` 的 result（本层**不使用**；保留参数位以与 `diagnose` 对齐）
 * @param {string|object|null} goal 形状串或 `{shape,…}`
 * @param {object|null} handles `buildHandles(obs, items)` 的表
 * @param {object} [opts]
 * @param {object} [opts.recipe] 调用方注入的 `{ok, steps, needs, closure, raw}`。**缺失 ⇒ 返回 []**
 * @param {number} [opts.level]  hub 等级（用于配方门控）
 * @param {{PER_CODE?:number, TOTAL?:number}} [opts.limits] 覆盖上限（测试用）
 * @returns {Array<object>} Diagnosis[]（确定性排序，每码 ≤3、总量 ≤8）
 */
export function semanticDiagnoses(obs, items, goal, handles, opts = {}) {
    /* ★ 第二个参数是真数据，以前被 `void items;` 丢掉了 ★
     *
     * 想报 `HUB_FED_BY_COLOR`（hub 入口在送颜料）就必须知道带子上有什么，
     * 而那就是这个参数。历史实现只读几何，所以它一路被忽略。
     * 这里保持「没有 items 也不崩」：下面用到的地方都有 null 检查。 */
    const itemsDoc = (items && typeof items === "object") ? items : null;
    const o = unwrapObs(obs);
    const recipe = opts.recipe;
    /* ★ 配方不可用**不等于**什么都别说了（2026-11-15 夜，L12 真机）★
     *
     * 原来这里是 `if (!recipe || recipe.ok !== true || ...) return [];` ——
     * 配方解不出来就整个语义层关掉。
     *
     * 而 L12 的求解器**搜索超限**（`recipe.ok=false`，报了「not proven unreachable」），
     * 于是从第一轮起这个函数一条诊断都不产。实测代价：
     *
     *   · `ORPHAN_MACHINES` 报过「23 of 59 machines have NOTHING connected
     *     (miner×15, stacker×1, rotater×1, trash×6)」—— 一直能算，从来没送出去；
     *   · `HUB_INLET_THIN` 报过「3 格上放了带子但方向不对，9 个入口空着」——
     *     这正是 L12 卡死的直接原因；
     *   · `DEAD_LINES`、`UPGRADE_AVAILABLE` 同理。
     *
     * agent 只看得到 `NO_PRODUCTION` 一个干诊断（「没有产线在造目标」），
     * 于是它只能在黑暗里加带子 —— 而世界真正的问题是「入口接错了方向」
     * 和「23 台机器一根线都没接」。
     *
     * 这些诊断**不依赖配方**：谁没接线、谁的入口指错了、哪条线到不了 hub ——
     * 全是纯拓扑/几何。只有「该用 cutter 还是 rotater」才需要配方。
     *
     * 所以改成：配方缺席时用**空的** model（`usable` 为空 ⇒ 依赖配方的分支
     * 自然一条都不产），但纯拓扑的那几条照常跑。
     *
     * 前提不变：`truncated` 时仍然整体返回空（世界不完整时任何结论都不可信）。 */
    const recipeUsable = !!(recipe && recipe.ok === true
        && Array.isArray(recipe.steps) && recipe.steps.length);
    if (o.truncated === true) return [];            // 契约 §4：世界不完整 ⇒ 语义层整体返回空
    const goalShape = typeof goal === "string" ? goal : (goal && (goal.shape || goal.goal)) || null;
    if (typeof goalShape !== "string" || !goalShape) return [];

    const idx = indexOf(o);
    const reach = hubReachable(o, idx);
    /* `recipeModel` 对空 steps 返回 `{usable:[], …}` —— 正是我们要的。
       末尾两个 web 依赖 `model.usable.length` 的判断会因此跳过，
       但它们各自前面有 `!model.usable.length` 的早退，行为不变。 */
    const model = recipeModel(recipeUsable ? recipe : { steps: [] }, opts.level);

    const engine = makeShapeEngine(o, idx);
    /* ★ 目标需要哪些颜色、地图上有哪些颜料矿、哪些只能靠合成（2026-11-21）★
     *
     * 这三件事**原来各算一遍**：`MIXER_MISSING` 那一段（约 1560 行）内部算了
     * `goalColorCodes` / `COLOR_NAMES` / `mustMix`，而 `MACHINE_STARVED` 的
     * `feed_sources` 又从头写了一遍 —— 而且写错了（TDZ：引用了后声明的变量，
     * 异常被外层 catch 吞掉，`feed_sources` 静默变空）。
     *
     * 真机代价：`feed_sources` 推荐了**绿矿**去喂 painter 的 color 槽，
     * 而目标 `CbCbCbRb:CwCwCwCw` 需要 **blue + white**（白无矿，必须合成）。
     * 模型照接，tx 成功、货真的流了、hub 真入库 9 件 —— **产出的是 L11 的形状**。
     * 修好了机制，产出了错的东西。
     *
     * 提到函数级共用一份，两处不再各算各的。 */
    const GOAL_COLOR_NAMES = { r: "red", g: "green", b: "blue", y: "yellow", p: "purple", c: "cyan", w: "white" };
    const goalColorCodesShared = (() => {
        const s = new Set();
        for (const layer of String(goalShape).split(":")) {
            for (let q = 0; q + 1 < layer.length; q += 2) {
                const cc = layer[q + 1];
                if (/[a-z]/.test(cc) && cc !== "u") s.add(cc);
            }
        }
        return s;
    })();
    const wantColorsShared = new Set([...goalColorCodesShared].map(c => GOAL_COLOR_NAMES[c]).filter(Boolean));
    const mapPigmentsShared = (() => {
        const ore = engine && engine.ore ? engine.ore : null;
        if (!ore) return null;
        const s = new Set([...ore.values()].filter(v => /^[a-z]+$/.test(String(v))));
        return s.size ? s : null;
    })();
    const mustMixShared = mapPigmentsShared
        ? [...wantColorsShared].filter(c => !mapPigmentsShared.has(c))
        : [];
    const hull = orbitOf(goalShape);
    const streams = buildStreams(idx);
    const hub = idx.ent.find(e => e.type === "hub") || null;

    /* 工厂里各类机器的总数（纯计数）。 */
    const factoryCount = kind => idx.ent.filter(e => e.type === kind).length;

    /* 目标原料走廊：流的源头是脚底下有配方 raw 的矿机（v2 §3 的 inGoalRawCorridor）。 */
    const corridorOf = st => {
        const src = sourceEntityOf(idx, st.head);
        if (src.kind !== "miner" || !src.entity) return false;
        const kind = engine.ore.get(K([src.entity.x, src.entity.y]));
        if (!engine.resourcesPresent) return true;          // 无矿图：保守算进走廊
        return kind !== undefined && (model.raw.size === 0 || model.raw.has(kind));
    };

    /** 某个格子往上爬到的源头是不是「配方 raw 矿机」—— 可落点枚举与流共用这一条判据。 */
    const cellInCorridor = cell => {
        const e = at(idx, cell);
        if (!e) return false;
        if (isBelt(e)) return corridorOf({ head: e, belts: [e], end: null });
        return false;
    };

    /** 从流头到源头矿机的带子数（v2 §3 的 `hopsFromMiner`）。 */
    const hopsFromMiner = st => {
        let n = 0, cur = st.head;
        const seen = new Set();
        while (cur && n < 4096) {
            if (seen.has(cur.uid)) return 4096;
            seen.add(cur.uid);
            n++;
            const up = at(idx, entryCellOf(cur));
            if (!up || !isBelt(up)) break;
            cur = up;
        }
        return n;
    };

    const tierOf = uid => {
        if (Number.isInteger(uid) && reach.has(uid)) return 1;
        return 2;
    };

    const out = [];

    /* ────────────────────────────────────────────────────────────────────
     * ① PROCESSOR_REQUIRED{scope:"stream"} —— 流带着中间形状，但缺下一步工序
     * ──────────────────────────────────────────────────────────────────── */
    const needByOp = new Map();     // op → [{stream, shapes}]
    const consumable = consumableSet(model);
    for (const st of streams) {
        /* 判据看**流头**的形状（"这条流入口处运的是什么"）。
         *
         * 为什么不用整条链的并集：L4 修好后 x=2/x=3/x=5 的残流与 cutter 的产品在 balancer 汇合，
         * 链上同时出现 `RuRuRuRu` 与 `RuRu----`。那是**混合**，报出去等于说「这条链还在运没切过的原料」,
         * 但它上游其实已经有 cutter 了 —— 这正是 v1 §11 预测的「越修越红」。
         * 按流头判：残流的头是矿机直出的 `RuRuRuRu`（换算理），报出来是**真实**的
         * 「这条支线还没切」；而已被切过的下游段不会因为我看见并集而误报。
         *
         * 只对「配方里真的会被某一步消费」的形状报（`consumable`）—— 目标形状本身、
         * 以及配方的终点都不在其中。 */
        const val = engine.beltValue(st.head);
        const shapes = shapesOf(val);
        if (!shapes.length) continue;
        const ops = new Set();
        for (const s of shapes) {
            if (!consumable.has(s)) continue;
            const step = model.next.get(s);
            if (step && MACHINE_OF_OP[step.op] && MACHINE_OF_OP[step.op] !== "miner") ops.add(step.op);
        }
        for (const op of [...ops].sort()) {
            const kind = MACHINE_OF_OP[op];
            if (processorOnStream(idx, st, kind)) continue;      // 该工序已经在这条流上 ⇒ 不缺
            /* ★ 已有的同类机器**自己都没料可吃**时，不再建议「再放一台」★
             *
             * 2026-11-10 第 9 关实测出的自相矛盾：同一份 prompt 里同时有
             *
             *   1. MIXER_UNFED  ……「配方要 blue+red，红矿 44 格外，去建支线」
             *   2. PROCESSOR_REQUIRED{scope:stream} ……「put it ON the stream named above」
             *
             * 第 2 条更容易执行，模型 7 轮里 4 次调 connect(B194→C7)、
             * 2 次 replace_run(building:mixer) —— 都在往别的流上放第二台 mixer，
             * 一次都没去接红矿。
             *
             * ⚠️ 判据必须**窄**：只压「已有的那台因为缺料根本跑不起来」的情形。
             * L4 上那台 cutter 只是**不在某条流上**，它自己是有料的，
             * 所以「往这条流上放一台 cutter」仍然是正解 —— 一刀切会把它也压掉
             * （实测：直接按 `have > 0` 压，T1/T5/T8/T11 五条当场变红）。
             *
             * 这里只看**多输入同类机器**（mixer / stacker）：它们有「两路必须都喂」
             * 的硬约束，而「一路有料、另一路没有」正是「放一台新的」救不了的病。 */
             const TWIN_INPUT = kind === "mixer" || kind === "stacker";
             if (TWIN_INPUT) {
                 const existing = idx.ent.filter(e => e.type === kind);
                 const stalled = existing.some((m) => {
                     const sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
                     if (!sl || !Array.isArray(sl.inputs) || sl.inputs.length < 2) return false;
                     let fed = 0;
                     for (let i = 0; i < sl.inputs.length; i++) {
                         const f = engine.inputSlotValue(m, i);
                         if (f && Array.isArray(f.value) && f.value.length) fed++;
                     }
                     return fed < sl.inputs.length;      // 至少一路没料 ⇒ 这台机器跑不起来
                 });
                 if (stalled) continue;
             }
            const rec = needByOp.get(op) || [];
            rec.push({ stream: st, shapes, corridor: corridorOf(st), canReach: st.belts.some(b => reach.has(b.uid)) });
            needByOp.set(op, rec);
        }
    }

    /* 可落点：同一 op 全枚举一次，供**全部**同 op 的诊断共享（「全部可行位置」）。 */
    const siteCache = new Map();
    const sitesFor = op => {
        if (siteCache.has(op)) return siteCache.get(op);
        let sites = [];
        if (op === "cut") sites = cutSites(idx, reach, cellInCorridor, handles);
        else if (op === "rotate" || op === "rotateCCW" || op === "rotate180") sites = oneCellSites(idx, reach, cellInCorridor);
        /* ★ paint 曾经漏在这里 ⇒ painter 诊断永远报「fits at 0 place(s)」★
         * 一条看起来可施工、实际无解的诊断会把模型钉死在上面（第 9 关实测三轮）。 */
        else if (op === "paint" || op === "paintMirrored" || op === "paintDouble") sites = paintSites(idx, reach, cellInCorridor, handles);
        siteCache.set(op, sites);
        return sites;
    };

    for (const [op, recs] of needByOp) {
        const kind = MACHINE_OF_OP[op];
        /* 排序键（v2 §3）：canReachHub↓ → inGoalRawCorridor↓ → shapeKnown↓ → hopsFromMiner↑ → chainHeadHandle↑ */
        const ranked = recs.slice().sort((a, b) => {
            if (a.canReach !== b.canReach) return a.canReach ? -1 : 1;
            if (a.corridor !== b.corridor) return a.corridor ? -1 : 1;
            if (a.shapes.length !== b.shapes.length) return b.shapes.length - a.shapes.length;
            const ha = hopsFromMiner(a.stream), hb = hopsFromMiner(b.stream);
            if (ha !== hb) return ha - hb;
            const sa = handleOf(handles, a.stream.head.uid) || `uid:${a.stream.head.uid}`;
            const sb = handleOf(handles, b.stream.head.uid) || `uid:${b.stream.head.uid}`;
            if (sa !== sb) return sa < sb ? -1 : 1;
            return a.stream.head.uid - b.stream.head.uid;
        });
        const top = ranked[0];
        const subj = subjectOf(handles, top.stream.head.uid, "belt");
        const sites = sitesFor(op);
        const siteHandles = [];
        for (const s of sites) {
            const h = handleOf(handles, s.handleUid);
            if (h && !siteHandles.includes(h)) siteHandles.push(h);
        }
        const near = [];
        for (const b of top.stream.belts) {
            const h = handleOf(handles, b.uid);
            if (h && h !== subj.handle && !near.includes(h)) near.push(h);
            if (near.length >= 3) break;
        }

        out.push({
            code: "PROCESSOR_REQUIRED",
            layer: "L4",
            severity: "warn",                       // v2 §2：机器存在、只是不在那条流上 ⇒ 该做的事，不是坏的东西
            subject: subj,
            /* ★ expected 必须说清「机器 + 它的废料出口」 ★
             *
             * 2026-10-30 第十六轮实测（9/10 次）：
             * 模型的落点**全对**（on_site 9/10），但它只给了 `building: {kind:"cutter"}` ——
             * 没给 trash。而 replace_run 的 region 里有 4 格（含废料喷口），
             * 宏需要 `[cutter, {trash, port:"left", confirm_waste}]` 才成立。
             *
             * 诊断只说「a cutter on the stream」，模型就只放了 cutter。
             * 这不是模型笨 —— 是我们没告诉它「cutter 有废料出口，得配 trash」。 */
            expected: `a ${kind} on the stream that carries ${top.shapes.join("/")}`
                + (kind === "cutter" ? `, plus a trash on its waste port (build: [cutter, {kind:"trash", port:"left", confirm_waste:true}])` : ""),
            observed: `this stream carries ${top.shapes.join("/")}, which the recipe turns into the next shape with `
                + `${op}; the factory has ${factoryCount(kind)} ${kind}(s) but none of them is reachable from this stream`
                + ` (the check follows the line downhill across balancers)`
                + ` (a ${kind} fits at ${sites.length} place(s) on the goal corridor)`,
            evidence: {
                /* ★ `handles` 必须给出**可施工的落点对**，不能只给一列带子 ★
                 *
                 * 2026-10-30 实测（第十三轮真 LLM，10/10 次）：
                 * 原来这里是 `[subj.handle, ...near]` —— 一条**同列的 4 格链**
                 * （B110/B103/B95/B88 全在 x=2）。
                 * 模型**完美地跟随了诊断**，拿这 4 个句柄调 `$path_of`，
                 * 得到宽度 1 的 region ⇒ 2×1 的 cutter 放不下 ⇒ `occupied`。
                 *
                 * 模型没做错任何事 —— 是我们把「流上的带子」当成了「能放机器的位置」。
                 * 现在：`handles` 前置一个**真实可行的落点对**（覆盖 2 格宽），
                 * 后面才跟流上的带子（供它理解上下文）。
                 * `site_handles` 仍然给全部可行落点，`site_cells` 给锚点。 */
                /* ★ `handles` 只放**可行落点**，流上的带子另放 `stream_handles` ★
                 *
                 * 2026-10-30 实测（第十四轮）：把两者混在一个数组里，模型会把
                 * **全部 6 个**句柄塞进 `$path_of(["B10","B11","B7","B110","B103","B95"])`，
                 * 得到 `PATH_NOT_RECT` —— 前三个是可行落点（连续），后三个是流上带子（在别处）。
                 *
                 * 模型分不清"这些是能放机器的地方"和"这些是当前跑货的带子"，
                 * 因为都在同一个 `handles` 里、语义上也都是"相关句柄"。
                 *
                 * 所以分开：
                 *   handles        = 可行落点的格子（模型应拿去当 region）
                 *   stream_handles = 目标流上的带子（仅供参考，表示"改的是这条流"）
                 */
                handles: [
                    ...((sites[0] && Array.isArray(sites[0].pair)) ? sites[0].pair
                        : (sites[0] && sites[0].handleUid !== undefined
                            ? [handleOf(handles, sites[0].handleUid)].filter(Boolean) : [])),
                ].filter(Boolean).slice(0, 4),
                stream_handles: [subj.handle, ...near].filter(Boolean).slice(0, 4),
                uids: [top.stream.head.uid],
                tier: top.corridor ? 0 : tierOf(top.stream.head.uid),
                scope: "stream",
                op,
                machine: kind,
                need: 1,
                have: factoryCount(kind),
                shape: top.shapes,
                site_handles: siteHandles,
                site_cells: sites.map(s => s.anchor),
                /* ★ 每个落点的朝向也要交回去 ★
                 *
                 * `insert_machine` 的 origin 形态（`at:[x,y]`）要求 `facing`，
                 * 而朝向不是随便选的：机器必须顺着那条带子的货流接力。
                 * 只说「放这儿」不说「朝哪」，模型只能猜 —— 猜错就被
                 * `facing_conflicts_with_flow` 打回来，多浪费一轮。
                 * 这里把 `paintSites` 已经算出来的 rotation 一并给出。 */
                site_facings: sites.map(s => (s.rotation === undefined ? null : s.rotation)),
                sites: sites.length,
                streams: ranked.map(r => ({
                    head: handleOf(handles, r.stream.head.uid),
                    belts: r.stream.belts.length,
                    shapes: r.shapes,
                    ended_at: r.stream.end.kind,
                })),
                ...(model.gated.length ? { level_gated: [...new Set(model.gated)].sort() } : {}),
            },
            /* ★ 有可行落点时 `insert_machine` 必须排第一 ★
             *
             * `replace_run` 要的是一个**连续矩形**，而 `site_handles` 给的是「带子本身」——
             * 那几格在一条流上往往不是矩形（带子转折处），于是 `$path_of(那三个句柄)`
             * 要么 `PATH_NOT_RECT`，要么 region 太窄 ⇒ `precondition_failed`
             * 「接不到来料」。第 9 关实测：模型连着三轮用它，三连败。
             *
             * 而 `insert_machine` 的 `at:{$ref,asCell:true}` **正好就是这些句柄的形态**，
             * 宏自己展开 footprint 并让位覆盖的带子。实测 B423/B424/B425 三个句柄
             * 在 `insert_machine` 下全部成功，在 `replace_run` 下全部失败。 */
            candidates: sites.length
                ? ["insert_machine", "replace_run", "connect"]
                : ["replace_run", "connect", "insert_machine"],
            ...(sites.length ? {
                hint: `用 insert_machine，at: {"$ref":"<site_handles 任取一个>","asCell":true}，`
                    + `宏会展开 footprint 并让位。不要用 replace_run —— 它要连续矩形，这些落点是散开的。`,
            } : {}),
        });
    }

    /* ────────────────────────────────────────────────────────────────────
     * ② PROCESSOR_REQUIRED{scope:"factory"} —— 纯计数：该类机器总数 < need
     * ──────────────────────────────────────────────────────────────────── */
    for (const [kind, need] of [...model.needs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const have = factoryCount(kind);
        if (have >= need) continue;
        const subj = hub ? subjectOf(handles, hub.uid, "hub") : { handle: null, type: null, uid: null };
        const ops = model.usable.filter(s => MACHINE_OF_OP[s.op] === kind).map(s => s.op);
        /* ★ 别再拿 hub 当「可放位置」★
         *
         * 原来 `handles: [subj.handle]`（= hub 的句柄，如 H1），意思是「相关对象是 hub」。
         * 但模型的读法是「这些是我该动手的格子」—— 第 9 关实测，它连着两轮调
         *   insert_machine {at: {$ref:"H1", asCell:true}, machine:"mixer"}
         * 而 hub 周围 16 个入口槽全被带子占着，一个 2×1 的 mixer 都放不下。
         *
         * 一条「工厂缺 X」的诊断，真正该回答的是「**那 X 能放哪**」。
         * 这里给出观测范围内**真实空着的格子**（按离 hub 的距离排序，越近越好 ——
         * 带子越短、越不容易和别人的线打架），并把 hub 的句柄降级成只是上下文。
         *
         * 找不到空地就**不给** handles（而不是给一个放不下的），并在 hint 里说清
         * 「先腾地方」—— 那才是那一刻的正解。 */
        const fp = (() => {
            const t = templateByBuildingVariant(kind, "default");
            return t && Array.isArray(t.footprint) ? t.footprint : [1, 1];
        })();
        const freeSites = [];
        const region = o && Array.isArray(o.region) && o.region.length === 4 ? o.region : null;
        if (region) {
            const [x0, y0, x1, y1] = region;
            for (let y = y0; y + fp[1] - 1 <= y1; y++) {
                for (let x = x0; x + fp[0] - 1 <= x1; x++) {
                    let ok = true;
                    for (let dx = 0; dx < fp[0] && ok; dx++) {
                        for (let dy = 0; dy < fp[1] && ok; dy++) {
                            /* 只收**完全空着**的格子：带子虽然可以让位，但让位会切断既有线，
                               不该由诊断替调用方决定。 */
                            if (at(idx, [x + dx, y + dy])) ok = false;
                        }
                    }
                    if (ok) freeSites.push([x, y]);
                }
            }
            const hx = hub ? hub.x : 0, hy = hub ? hub.y : 0;
            freeSites.sort((a, b) => (Math.abs(a[0] - hx) + Math.abs(a[1] - hy))
                - (Math.abs(b[0] - hx) + Math.abs(b[1] - hy)));
        }
        /* 空格子没有实体 ⇒ 没有句柄。给 `site_cells`（坐标只在**诊断证据**里出现，
           这是允许的：`assertNoHumanCoords` 管的是 LLM 输出，不是我们给它的材料）。 */
        const siteCells = freeSites.slice(0, 8);
        out.push({
            code: "PROCESSOR_REQUIRED",
            layer: "L4",
            severity: "blocker",                    // v2 §2：工厂里根本没有这台机器 ⇒ 真的坏
            subject: subj,
            expected: `the factory owns at least ${need} ${kind}(s)`,
            observed: `the recipe needs ${need} ${kind}(s) (${[...new Set(ops)].join("/")}), but the world has ${have}`
                + (freeSites.length
                    ? `; ${freeSites.length} empty ${fp[0]}×${fp[1]} site(s) exist for it`
                    : `; there is **no empty ${fp[0]}×${fp[1]} site** in the observed region`),
            evidence: {
                /* ★ `handles` 不再放 hub ★
                 *
                 * 原来放的是 hub 的句柄（H1），模型的读法是「这些是我该动手的格子」——
                 * 第 9 关实测它连着两轮 `insert_machine {at:{$ref:"H1"}}`，
                 * 而 hub 周围全被带子占着，一台 2×1 的机器都放不下。
                 *
                 * 空格子没有实体 ⇒ 没有句柄。所以这里把**可落点坐标**放 `site_cells`
                 * （诊断证据里的坐标是允许的：`assertNoHumanCoords` 管的是 LLM 的**输出**，
                 * 不是我们喂给它的材料），hub 的句柄降级到 `hub_handle` 只作上下文。 */
                handles: [],
                site_cells: siteCells,
                free_sites: freeSites.length,
                footprint: fp,
                hub_handle: subj.handle || null,
                uids: hub ? [hub.uid] : [],
                tier: hub ? tierOf(hub.uid) : 2,
                scope: "factory",
                op: ops[0] || null,
                machine: kind,
                need,
                have,
                ops: [...new Set(ops)].sort(),
            },
            candidates: freeSites.length ? ["insert_machine", "connect"] : ["remove_run", "trash_unused", "insert_machine"],
            hint: freeSites.length
                ? `用 insert_machine 放在 evidence.site_cells 里任意一格的 ${kind}（宏会按 footprint 展开）。`
                    + `这些格子里离 hub 最近的排在最前 —— 越近的线越短，越不容易和既有产线打架。`
                    + `**别把 hub 的句柄当落点**：hub 四周通常已经被入口带子占满。`
                : `工厂里没有能放下 ${kind}(${fp[0]}×${fp[1]}) 的空地。先把挡路的旧线拆掉`
                    + `（remove_run / trash_unused）腾出位置，再放机器。`,
        });
    }

    /* ────────────────────────────────────────────────────────────────────
     * ②b MIXER_UNFED —— mixer 在世界上，但两个 color 槽没凑齐**两种不同**的颜料
     *
     * ## 为什么这条诊断必须有（第 9 关实测的最后一堵墙）
     *
     * `PROCESSOR_REQUIRED` 只数「工厂里有几台 mixer」。第 9 关的模型照着它，
     * 把一台 mixer 插进了一条**只有蓝色**的流上 —— 数量达标了（`have: 1`），
     * 于是诊断消失，而配方里的 `mix` 步永远不可能发生：它需要**红 + 蓝**。
     *
     * 世界的真实数据（同一份 obs）：
     *   · 配方：`mix(inputs: ["color:blue","color:red"]) → color:purple`
     *   · 唯一那台 mixer 的两个槽，上游都是**同一条蓝矿线**
     *   · 而红矿在 44 格之外、有矿石有矿机（`(54,21)`），只是没有接过来
     *
     * 也就是说：**材料全在，判据只差一步「两个槽分别收到了什么」**。
     * 形状传播引擎早就算得出这件事（`inputSlotValue`），从没被用来回答这个问题。
     *
     * ## 判据（只报**能确定**的）
     *
     * 配方里 `mix` 步的 `inputs` 给出需要哪几种颜色（这里是两个不同的 color:*）。
     * 对世界上每一台 mixer，逐个 color 槽取上游值：
     *   · 两槽都解得出且**互不相同** → 正常，不报
     *   · 有一个槽解不出（空 / 没对准 / 隧道屏障 / 形状未知）→ 报「另一路没接上」
     *   · 两槽都有但**相同** → 报「同源，产不出第三种颜色」
     *
     * 解不出时**不猜**是哪种颜色 —— 只说「这一槽没有已知来料」，
     * 并把该槽的喂料格与缺口原因一起给出。
     * ──────────────────────────────────────────────────────────────────── */
    /* ★ 「一台 mixer 都没有」——**不依赖配方**，从目标形状就能判（2026-11-16）★
     *
     * 真机实测：世界 600 实体、11 台矿机（4 台挖 blue）、575 条带子，
     * **mixer 是 0 台**。而 L12 上层 4 个象限全要 white，
     * white 只能由 mixer 合成（blue+green+red），地图上没有 white 矿。
     *
     * 旧的检测在 `if (model.needs.has("mixer"))` 里面 —— 而 L12 的求解器
     * 搜索超限（`recipe.ok=false`），`model.needs` 是**空的**，
     * 那段一次都不执行。于是 agent 把全部预算花在修带子和清垃圾桶上，
     * 而它缺的是那台机器本身。
     *
     * 这条判断不需要配方：目标形状的色码里有 `w`，而矿表里没有 white 矿
     * ⇒ 白颜料一定得混出来 ⇒ 必须有 mixer。纯数据可推。 */
    {
        const mixersNow = idx.ent.filter(e => e.type === "mixer");
        /* 目标的色码集合（按 pair 的第二位取，见 prompt.mjs 的同款说明） */
        const goalColorCodes = new Set();
        for (const layer of String(goalShape || "").split(":")) {
            for (let q = 0; q + 1 < layer.length; q += 2) {
                const cc = layer[q + 1];
                if (/[a-z]/.test(cc) && cc !== "u") goalColorCodes.add(cc);
            }
        }
        /* 有几种目标的色码**在地图上没有颜料矿** ⇒ 只能混出来 */
        const COLOR_NAMES = { r: "red", g: "green", b: "blue", y: "yellow", p: "purple", c: "cyan", w: "white" };
        const oreKinds = engine && engine.ore ? new Set([...engine.ore.values()].filter(v => /^[a-z]+$/.test(String(v)))) : null;
        const mustMix = [...goalColorCodes]
            .map(c => COLOR_NAMES[c])
            .filter(name => !!name && oreKinds && oreKinds.size > 0 && !oreKinds.has(name));
        if (mixersNow.length === 0 && mustMix.length > 0) {
            const subj = subjectOf(handles, null, "mixer");
            out.push({
                code: "MIXER_MISSING",
                layer: "L4",
                severity: "blocker",
                subject: subj,
                expected: `世界上至少有一台 mixer，能合成 ${mustMix.join("+")}`,
                observed: `地图上有 0 台 mixer，而目标需要 ${mustMix.join("/")} —— `
                    + `这种颜料没有矿，只能靠 mixer 合成。再多的带子工作都产不出它。`,
                evidence: {
                    handles: [subj.handle].filter(Boolean),
                    uids: [],
                    wanted_colors: mustMix,
                    mixer_count: 0,
                },
                candidates: ["insert_machine"],
                hint: `**先造一台 mixer**，这是唯一的出路：`
                    + `\`insert_machine {at:{$ref:"<一条空带子>", asCell:true}, machine:"mixer", facing:"<方向>"}\`。`
                    + `放好之后，它的两个 color 槽分别接两种颜料，输出再往 hub 方向接。`
                    + `**在这之前修带子都是白费** —— 没有 mixer，${mustMix.join("/")} 永远不存在。`,
            });
        }
    }

    /* ★ 「mixer 有，但它的 color 槽没接到两种**不同**颜料」—— 也要能独立判（2026-11-16）★
     *
     * 与 `MIXER_MISSING` 是同一个病：这一段原来整块在
     * `if (model.needs.has("mixer"))` 里，而 L12 的 `recipe.ok=false`
     * 让 `model.needs` 空前置条件永不成立 ⇒ 整段不执行。
     *
     * 真机实测：agent 刚建好一台 mixer @ (-4,1)，三个槽都接了带子，
     * 但两个 color 输入的带子是 `r=180`（向下流）—— 货根本不进 mixer。
     * 而诊断一条都没报，agent 完全不知道那里有问题。
     *
     * 这条判据不需要配方：**看 mixer 的两个 color 喂料格上，货是往哪个方向走的**。
     * 走的方向不对 ⇒ 报。这个纯几何可判。 */
    {
        const mixersHere = idx.ent.filter(e => e.type === "mixer");
        for (const m of mixersHere) {
            let sl = null;
            try { sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m)); } catch { sl = null; }
            if (!sl) continue;
            const colorIns = (sl.inputs || []).filter(x => x.role === "color");
            if (colorIns.length < 2) continue;
            /* 逐个 color 槽：喂料格上那条带子的**出口**是不是指向 mixer 本体。
               同时算出**正确朝向** —— 每个槽的方向都不一样，笼统说「朝 left」
               对第二个槽就是错的（真机实测：(-3,1) 要 left、(-3,0) 要 bottom）。 */
            const bad = [];
            for (const x of colorIns) {
                const e = at(idx, x.cell);
                if (!e) { bad.push({ cell: x.cell, why: "空格", handle: null, fix: null }); continue; }
                if (!isBelt(e)) continue;                 // 机对机直贴，另算
                const exCell = exitCellOf(e);
                const exDir = exitDirOf(e);
                const pointsAtMixer = Array.isArray(exCell)
                    && exCell[0] === x.slot[0] && exCell[1] === x.slot[1];
                const acceptsIt = accepts(idx, x.slot, exDir);
                if (!pointsAtMixer || !(acceptsIt && acceptsIt.ok)) {
                    /* 正确朝向 = 从这条带子指向 mixer 槽位本体格的方向 */
                    const ddx = x.slot[0] - e.x, ddy = x.slot[1] - e.y;
                    const fix = ddy < 0 ? "top" : ddy > 0 ? "bottom" : ddx > 0 ? "right" : ddx < 0 ? "left" : null;
                    bad.push({
                        cell: x.cell,
                        why: `带子朝 ${exDir} 喷，出口在 ${JSON.stringify(exCell)}，没落在 mixer 的槽上`,
                        handle: handleOf(handles, e.uid),
                        fix,
                    });
                }
            }
            if (bad.length) {
                const subj = subjectOf(handles, m.uid, "mixer");
                const mh = handleOf(handles, m.uid);
                out.push({
                    /* ⚠️ 用**独立**的码，不是 `MIXER_UNFED`。
                       `MIXER_UNFED` 有一条既有的、很具体的语义：「两个 color 槽要**分开**接，
                       只接一个的话路径会穿过另一个槽的喂料格把它覆盖成死线」
                       —— 那条警告有真机依据（r-20261112202028-8e5a 两个槽一起废掉），
                       不能被这条更基础的「方向不对」挤掉（`semantic.test.mjs:1269` 钉着它）。 */
                    code: "MIXER_COLOR_AIMED",
                    layer: "L4",
                    severity: "blocker",
                    subject: subj,
                    expected: `${mh || "这台 mixer"} 的两个 color 槽各有一条**朝它喷**的带子`,
                    observed: `${bad.length}/${colorIns.length} 个 color 槽没接到货：`
                        + bad.map(b => `${JSON.stringify(b.cell)}（${b.why}${b.handle ? ` ${b.handle}` : ""}）`).join("；"),
                    evidence: {
                        handles: [subj.handle, ...bad.map(b => b.handle)].filter(Boolean),
                        uids: [m.uid],
                        bad_slots: bad,
                    },
                    candidates: ["replace_run", "connect"],
                    hint: `${mh || "这台 mixer"} 的 color 槽接的是**方向不对**的带子 —— `
                        + `货沿着它们流走了，根本不进 mixer。`
                        + bad.filter(b => b.handle && b.fix).map(b =>
                            `把 ${b.handle} 转成朝 **${b.fix}** 喷：`
                            + `\`replace_run {region:$path_of(["${b.handle}"]), building:"belt", opts:{facing:"${b.fix}"}}\``).join("；")
                        + `。`
                        /* 「每个槽方向不一样」这句只有**真的不一样**时才说 ——
                           两条都是 left 的时候说这句会让人以为还有别的方向。 */
                        + (new Set(bad.filter(b => b.fix).map(b => b.fix)).size > 1
                            ? `**每个槽的方向不一样，逐条按上面给的来**。`
                            : ``)
                        + `这条不修，白颜料永远合不出来。`,
                });
            }
        }
    }

    if (model.needs.has("mixer")) {
        const mixStep = model.usable.find(s => s.op === "mix");
        const wantColors = (mixStep && Array.isArray(mixStep.inputs) ? mixStep.inputs : [])
            .filter(v => typeof v === "string" && v.startsWith("color:"));
        const mixers = idx.ent.filter(e => e.type === "mixer");
        /* 只有**真的**需要两种不同颜色时才查（单输入配方不该被这条打扰） */
        const needDistinct = new Set(wantColors).size >= 2 || wantColors.length >= 2;

        /* ★ 一台 mixer 都没有 ⇒ 这是**不可绕过的**阻塞（2026-11-16，L12 真机）★
         *
         * 真机实测：世界 600 实体、11 台矿机（4 台挖 blue）、575 条带子，
         * **mixer 是 0 台**。而 L12 的上层 4 个象限全要 white，
         * white 只能由 mixer 合成（blue+green+red），地图上没有 white 矿。
         *
         * 旧的诊断只在 `for (const m of mixers)` 里逐台检查 ——
         * 0 台时这个循环一次都不跑，于是**一句提示都没有**。
         * agent 于是把全部预算花在修带子和清垃圾桶上，
         * 而它缺的是那台机器本身。
         *
         * 这与 `PROCESSOR_REQUIRED{scope:"factory"}` 同类：工厂缺工序机器。
         * 区别是这条比它更硬 —— 没有 mixer，白颜料永远不存在，
         * 再多的带子工作都是零。 */
        if (mixers.length === 0 && (needDistinct || wantColors.length > 0)) {
            const subj = subjectOf(handles, null, "mixer");
            /* 从配方里读出要混哪几种颜料，说给模型听 */
            const wanted = wantColors.map(c => String(c).replace(/^color:/, ""));
            out.push({
                code: "MIXER_MISSING",
                layer: "L4",
                severity: "blocker",
                subject: subj,
                expected: `世界上至少有一台 mixer，能合成 ${wanted.join("+") || "目标所需的白颜料"}`,
                observed: `地图上有 0 台 mixer，而目标需要 ${wanted.join("+") || "混合颜料"} —— `
                    + `这种颜料没有矿，只能靠 mixer 合成。再多的带子工作都产不出它。`,
                evidence: {
                    handles: [subj.handle].filter(Boolean),
                    uids: [],
                    wanted_colors: wanted,
                    mixer_count: 0,
                },
                candidates: ["insert_machine"],
                hint: `**先造一台 mixer**，这是唯一的出路：`
                    + `\`insert_machine {at:{ref:"<一条空带子>"}, asCell:true, machine:"mixer", facing:"<方向>"}\`。`
                    + `放好之后，它的两个 color 槽分别接 ${wanted.slice(0, 2).join(" 和 ") || "两种颜料"}，`
                    + `输出再往 hub 方向接。**在这之前修带子都是白费** —— `
                    + `没有 mixer，那几种颜料混不到一起。`,
            });
        }

        for (const m of mixers) {
            const tpl = templateByBuildingVariant(m.type, variantOf(m));
            const colorIdx = (tpl && Array.isArray(tpl.inputs) ? tpl.inputs : [])
                .map((s, i) => (s.role === "color" ? i : -1)).filter(i => i >= 0);
            if (colorIdx.length < 2) continue;

            const feeds = colorIdx.slice(0, 2).map(i => engine.inputSlotValue(m, i));
            /* ★ `f.value` 是 **Set**，不是 Array ★
             *
             * `makeShapeEngine` 的形状传播全程用 `Set`（`beltValue` / `outValue`
             * 都返回 `Set<string>|null`），而这里原来写的是 `Array.isArray(f.value)`。
             * `Array.isArray(new Set(...))` 恒为 false ⇒ **两个槽永远解析成 null**。
             *
             * 后果（第 9 关）：M6/M2 两台矿机都在挖蓝矿、整条喂料链每跳
             * `sameCell` 与 `accepts` 全通过、`computeOut` 也确实返回了 `color:blue`
             * （`[beltValue] 12210 => color:blue`），但 `slot_values` 恒为 `[null,null]`
             * ⇒ 诊断永远说「源头断了」⇒ 模型反复重接**已经接好的线**。
             *
             * 这条 bug 从 `MIXER_UNFED` 写出来那天就在，之前一直被更早的断点遮住
             * （先是 `$ore` 选错矿、再是 `rot !== 0` 掐断矿机输出）。
             * 把上游全修好之后它才露出来 —— 也正因为如此，它是最难定位的一层。 */
            const asList = v => (v instanceof Set ? [...v] : (Array.isArray(v) ? v : []));
            const vals = feeds.map(f => (f ? asList(f.value).filter(v => typeof v === "string" && v.startsWith("color:")) : []));
            const resolved = vals.map(v => (v.length ? v.slice().sort() : null));
            const anyUnresolved = resolved.some(v => v === null);
            const bothSame = resolved[0] && resolved[1]
                && resolved[0].join("|") === resolved[1].join("|");

            if (!needDistinct) continue;
            if (!anyUnresolved && !bothSame) continue;         // 两路不同 ⇒ 正常

            /* ★ `slot_why === null` ≠ 「没问题」★
             *
             * 实测（2026-11-12 第 9 关，实时 obs）：两条喂料带**方向完全正确**、
             * 也确实被 mixer 接受了 ⇒ `inputSlotValue` 返回 `why: null`，
             * 诊断于是只说「no known incoming pigment」——
             * 模型看不出问题在哪，只能反复去改**端口**（那是对的）。
             *
             * 真实原因在几十格之外：slot 0 那条链有 **50 格**，
             * 一路开到 `(7,-32)` —— 而那里**什么都没有**，是个断头。
             * 「紧邻那一格对不对准」和「这条线通不通」是两个问题，
             * `inputSlotValue` 只答前者。
             *
             * 这里补上后者：从 feed 格反向走，找到流头，如实说
             * 「上游 N 格之后断在 (x,y)」或「源头是 X 号矿机」。
             * 坐标不进 hint（硬约束），只进 evidence。 */
            const upstreamOf = (feedCell) => {
                if (!Array.isArray(feedCell)) return null;
                /* ★ 起始格就是空的 ⇒ 这里**没有线**，不是「线断了」★
                 *
                 * 两者的修法不同：
                 *   · feed 格空        ⇒ 槽上什么都没有，要**新建**一条线过来
                 *                        （这种情形 `slot_why` 已经是 `feed-cell-empty`，
                 *                          hint 那侧的端口选择器才有意义）
                 *   · feed 格上有带子   ⇒ 线存在但源头不通，要去**接线的另一端**
                 *
                 * 混为一谈会让空槽也收到「那条线源头是断的」+「别 connect 到 mixer 槽」
                 * —— 而空槽恰恰**必须** connect 到 mixer 槽。实测 M9 的夹具
                 * （mixer 四周全空）就被误导成这个形态。 */
                if (!at(idx, feedCell)) return null;
                const seen = new Set();
                let cur = feedCell;
                let len = 0;
                while (len < 200) {
                    const k = `${cur[0]},${cur[1]}`;
                    if (seen.has(k)) return { len, head: "loop", headCell: cur };
                    seen.add(k);
                    const e = at(idx, cur);
                    if (!e) return { len, head: "empty", headCell: cur };
                    if (!isBelt(e) && !isTunnel(e)) {
                        return { len, head: "machine", headCell: cur, headType: e.type, headUid: e.uid };
                    }
                    /* 找谁喂这一格 */
                    /* ★ 多个邻居都「指向」本格时，按本格自己的入口方向选 ★
                     *
                     * 世界里可以出现**两个带子都声称要喂同一格**的局面
                     * （都是模型早期铺错的产物，游戏会给其中一个改方向，另一个变死线）。
                     * 实测（第 9 关：(34,-11) 被 B342 从北、B302 从西同时指着）：
                     * 旧代码「最后一个赢」—— 循环顺序是 上/右/下/左，于是**西边的 B302 赢**，
                     * 而上游其实是北边的 B342。
                     *
                     * 后果：`upstreamOf` 沿 B302 一路往西跑到断头（106 格），
                     * 诊断说「这条线源头断了」，让模型去接一条**早就接好的线**。
                     * 实测那个 run 里模型重复执行了 4 次同样的 connect。
                     *
                     * `B303` 的 `entryDirOf` 是 `bottom`（货从北面来），
                     * 所以应当选 `(34,-10)` 那格的 `B342`。判据用本格**自己的**入口格，
                     * 而不是「谁的 exit 说指向我」—— 后者在冲突时没有优先级。 */
                    /* ★ 入口格上是**机器** ⇒ 这条线的源头就是它，别报「断头」★
                     *
                     * 实测（第 9 关：(36,-9) 的 B358）：它的入口格 (37,-9) 上是 M6 矿机，
                     * 而旧代码只找「exit 指向本格的**带子**」，找不到就报 `head`
                     * （＝「裸带子做起点，前面没东西」）。
                     *
                     * 那句对模型是**误导**：它让人以为要去接一个断头，
                     * 而实际源头是一台正在挖蓝矿的矿机 —— 也就是**已经接好了**。
                     * 那个 run 里模型为此重复执行了 4 次同样的 connect。
                     *
                     * 机器不是「断」，它是**源头**。区分开：`head` 只留给人真空手的情况。 */
                    const wantEntry0 = entryCellOf(e);
                    if (Array.isArray(wantEntry0)) {
                        const upM = at(idx, wantEntry0);
                        if (upM && !isBelt(upM) && !isTunnel(upM)) {
                            return {
                                len, head: "machine", headCell: wantEntry0,
                                headType: upM.type, headUid: upM.uid,
                                headHandle: handleOf(handles, upM.uid),
                            };
                        }
                    }
                    let feeder = null;
                    const wantEntry = entryCellOf(e);
                    if (Array.isArray(wantEntry)) {
                        const n = at(idx, wantEntry);
                        if (n && isBelt(n) && sameCell(exitCellOf(n), cur)) feeder = n;
                    }
                    if (!feeder) {
                        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                            const n = at(idx, [cur[0] + dx, cur[1] + dy]);
                            if (!n || !isBelt(n)) continue;
                            if (sameCell(exitCellOf(n), cur)) feeder = n;
                        }
                    }
                    if (!feeder) {
                        /* 流头但格子上是带子/隧道 ⇒ 它就是这条线的起点，前面没东西。
                           把它的句柄带出去 —— 模型要指的正是这一格，而没有句柄它只能猜。 */
                        return {
                            len, head: "head", headCell: cur,
                            headUid: e.uid, headType: e.type,
                            headHandle: handleOf(handles, e.uid),
                            headIsBelt: true,
                        };
                    }
                    cur = [feeder.x, feeder.y];
                    len++;
                }
                return { len, head: "too-long", headCell: cur };
            };

            const mh = handleOf(handles, m.uid);
            const feedHandles = feeds.map(f => (f && Number.isInteger(f.beltUid) ? handleOf(handles, f.beltUid) : null))
                .filter(Boolean);
            const shapeOfVal = v => (v ? v.join("+") : null);
            /* 每条喂料线的上游：多少格、源头是什么。见 upstreamOf 的注释。 */
            const ups = feeds.map(f => (f && Array.isArray(f.cell) ? upstreamOf(f.cell) : null));
            /* ★ 「线对准了但源头断了」的那几个槽 ★
             *
             * 一次性算出来给三处用（lead / describeSlot / hint 的动作块）——
             * 分头算会让它们**各自说不同的话**，而第 9 关的教训正是
             * 「两条自相矛盾的建议，模型只会挑更具体的那条」。 */
            const deadEnds = ups
                .map((u, i) => ({ u, i, f: feeds[i] }))
                .filter(x => x.u && (x.u.head === "empty" || x.u.head === "head" || x.u.head === "loop"));

            /* ★ 这条喂料线**本身**通不到 hub —— 单独标出来 ★
             *
             * 与 `deadEnds` 是**两件不同的事**，混在一起说会让模型做错动作：
             *   · deadEnds  —— 线的源头断了（要补源头）；
             *   · deadLine  —— 线的源头**可能**有货，但整条线到不了 hub
             *                  （补了源头也是白补，货送不出去）。
             *
             * 真机实测（r-20261113183309-79c3，2026-11-13，第 9 关）：
             * 诊断说「槽 0 的线源头断了，起点是 B2」，模型连着两轮照做
             * （`connect {from:M2, to:B2}`）。但 **B2 那条线整条都到不了 hub** ——
             * 预演闸门拦下了它（死带子 6 → 53，+47），两轮都拦。
             *
             * 预演判的是对的，可 hint 只说「这一步新铺了 47 格通不到 hub 的带子」，
             * 模型不知道**为什么**那 47 格必然白费 —— 因为它要接的那条线本来就是死的。
             * 下一轮它还去接同一处。
             *
             * 所以这里把「这条线是死的」提前说在诊断里，让模型在**决定接哪**的时候
             * 就知道，而不是等到预演被拦下才听说。 */
            /* ★ `reach` 为空时**不许**判死线 ★
             *
             * 红队实测（2026-11-13）：`hubReachable` 在**世界里没有 hub** 时
             * 返回一个只含空集的 Set（`topology.mjs` 的 `if (!hub) return seen`）。
             * 而这里写的是 `!reach.has(...)` —— 空集 ⇒ 全部为 true
             * ⇒ **所有喂料线都被判成「到不了 hub」**，hint 全变成「别补源头」。
             *
             * 那是个彻底的误判：没有 hub 的世界里，「到不了 hub」不是一个可判定
             * 的事实（没有 hub 就没有终点），它只是「读不到」。
             *
             * 这个仓库的纪律是：**读不到就说读不到，不许变成 0 / false**
             * （`health.mjs` 里「读不到的量是 null，不是 0」是同一件事）。
             * 所以 `reach.size === 0` 时一律 return false —— 退回旧行为
             * （让模型去补源头），而不是给出一个基于错误前提的建议。
             *
             * 正常路径下 hub 总在（`obs` 的 `include_hub` 默认 true），
             * 这个分支要靠 obs 被裁剪或 mod 侧 hub 丢失才会触发 —— 但误判的
             * 代价是模型被引向错误动作，宁可保守。 */
            const reachUsable = reach && typeof reach.size === "number" && reach.size > 0;
            /* ★ 但「不在 reach 里」≠「这条线是死的」★
             *
             * `hubReachable` 的语义是「货能不能**原样**流到 hub」。而一条喂料线
             * 进了一台机器之后，货就**变成别的东西**了 —— 它不在那个集合里，
             * 但它完全正常。
             *
             * 真机实测（2026-11-13，产线跑起来之后）：119 条带子里 111 条
             * 不在 `reach` 里，而那 111 条**全都在工作** —— 红矿→mixer、
             * mixer→painter 两条长链，货一直在流，hub 的交付稳定在涨（193/600）。
             *
             * 如果照旧判它们「到不了 hub」，模型每轮都会被告知「别在死线上花功夫」，
             * 而那条线正是它刚修好的。实测那一轮模型的第一反应就是
             * 「B87 出口无接收方，去桥接它到画家」—— 而画家早就接好了。
             *
             * 所以补一条：**下游链上有机器 ⇒ 不算死线**。
             * 那台机器会把货变成别的形状，那时「到不到得了 hub」由它的输出决定，
             * 不归这条带子管。 */
            const downstreamHitsMachine = (startUid) => {
                let cur = idx.byUid.get(startUid);
                const seen = new Set();
                for (let i = 0; i < 200 && cur; i++) {
                    if (seen.has(cur.uid)) return false;        // 成环，没机器
                    seen.add(cur.uid);
                    const ex = exitCellOf(cur);
                    const n = ex ? at(idx, ex) : null;
                    if (!n) return false;                       // 空地
                    if (!isBelt(n)) return true;                // 机器 / hub / trash
                    cur = n;
                }
                return false;
            };
            const feedLineDead = feeds.map((f) => {
                if (!reachUsable) return false;
                if (!f || !Number.isInteger(f.beltUid)) return false;
                if (reach.has(f.beltUid)) return false;         // 货能原样到 hub ⇒ 显然不死
                /* 下游有机器 ⇒ 货会被加工，这条路正常 */
                return !downstreamHitsMachine(f.beltUid);
            });
            /* ★ `describeSlot` 必须把**上游断在哪**说出来 ★
             *
             * `f.why === null` 表示「紧邻那一格对准了、mixer 也接受了」——
             * 它**不**表示这条线有货。第 9 关 slot 0 的链有 50 格，
             * 源头 (7,-32) 是空的；旧文案只说 "no known incoming pigment"，
             * 模型于是反复去改端口（那本来就没错）。
             *
             * 新文案按「断在哪」分四类说清楚：
             *   · 上游源头是空的      ⇒ 这条线是断头，要补源头
             *   · 上游源头是机器      ⇒ 机器有输出但形状推不出来
             *   · 上游成环            ⇒ 环里没有源
             *   · 上游太长            ⇒ 不判定（不猜）
             * 坐标不进 hint（硬约束），只进 evidence.upstream。 */
            const describeUp = (i) => {
                const u = ups[i];
                if (!u) return "";
                if (u.head === "empty") return `its line is ${u.len} tile(s) long and DEAD-ENDS (nothing feeds the far end)`;
                if (u.head === "head") return `its line is ${u.len} tile(s) long and starts at a bare belt with nothing feeding it`;
                if (u.head === "machine") {
                    return `its line is ${u.len} tile(s) long and starts at a ${u.headType || "machine"} whose output shape could not be derived`;
                }
                if (u.head === "loop") return `its line is ${u.len} tile(s) long and loops back on itself with no source`;
                return "";
            };
            /* 有值的那个槽也要报，否则「两个槽都是 null」时模型不知道该修哪个。 */
            const describeSlot = i => {
                const f = feeds[i];
                if (!f) return `color slot ${i}: no such slot`;
                if (f.value === null && f.why) return `color slot ${i}: ${f.why}`;
                if (Array.isArray(f.value) && f.value.length) return `color slot ${i}: ${shapeOfVal(resolved[i])}`;
                if (f.machineType) return `color slot ${i}: fed by ${f.machineType} whose output shape is not derived`;
                /* ★ 走到底了但没货 —— 说清楚上游断在哪 ★ */
                const up = describeUp(i);
                return `color slot ${i}: no known incoming pigment${up ? ` — ${up}` : ""}`;
            };
            const why = anyUnresolved
                ? `${describeSlot(0)}; ${describeSlot(1)}`
                : `both color slots receive the same pigment (${shapeOfVal(resolved[0])}), so mix() cannot produce a different colour`;

            /* ★ 每种要的颜料**最近在哪** —— 这是模型唯一缺的那块信息 ★
             *
             * 第 9 关实机：两条喂料带子（B11932/B11936）追溯上去是**同一台蓝矿机**，
             * 所以 mixer 拿到的是蓝+蓝。诊断只说「需要 blue+red」，模型知道缺红，
             * 但**不知道红在哪** —— 它对世界的认识只有句柄，没有矿图。
             *
             * 实测距离：蓝 5 格、红 **44 格**。这不是「接一根线」的量级，
             * 是一条需要单独规划的长支线。不给距离，模型会以为随手 connect 就能解决，
             * 于是反复试 `connect(B192→C7)` 然后被 `target_already_fed` 打回。
             *
             * 只给「最近的那一格」和距离，不给整张矿图（预算）。
             * 无矿图时如实说读不到，不编。 */
            /* ★ 「这种矿上有几台矿机」必须按**连通矿脉**算，不是按矿种 ★
             *
             * 第一版把所有 `red` 矿机加在一起，第 9 关报出「红矿已有 3 台」——
             * 而最近的**那片**红矿 (8,5) 上一台都没有；那 3 台在 44 格外的
             * 另一片 (52,21) 矿区。把两片矿合并计数，模型会以为「红矿那边已经就绪，
             * 只要接线」，实际要接的那片是空的。
             *
             * 所以：先把同种的矿格按 4-邻接并成矿脉，取离 mixer 最近的那条矿脉，
             * 只数**站在那条矿脉上**的矿机。 */
            const veinsOf = (() => {
                const cache = new Map();
                return (pig) => {
                    if (cache.has(pig)) return cache.get(pig);
                    const cells = [];
                    for (const [k, kind] of engine.ore) {
                        if (kind !== pig) continue;
                        const [x, y] = k.split(",").map(Number);
                        cells.push([x, y]);
                    }
                    const set = new Set(cells.map(c => `${c[0]},${c[1]}`));
                    const seen = new Set();
                    const veins = [];
                    for (const c of cells) {
                        const k0 = `${c[0]},${c[1]}`;
                        if (seen.has(k0)) continue;
                        const grp = [];
                        const stack = [c];
                        seen.add(k0);
                        while (stack.length) {
                            const [x, y] = stack.pop();
                            grp.push([x, y]);
                            for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
                                const nk = `${x + dx},${y + dy}`;
                                if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push([x + dx, y + dy]); }
                            }
                        }
                        const d = grp.reduce((mn, p) => Math.min(mn, Math.abs(p[0] - m.x) + Math.abs(p[1] - m.y)), Infinity);
                        const near = grp.reduce((a, p) => (Math.abs(p[0] - m.x) + Math.abs(p[1] - m.y)
                            < Math.abs(a[0] - m.x) + Math.abs(a[1] - m.y) ? p : a), grp[0]);
                        veins.push({ cells: grp, d, at: near });
                    }
                    veins.sort((a, b) => a.d - b.d);
                    cache.set(pig, veins);
                    return veins;
                };
            })();

            const minerOnPigment = (() => {
                const byPig = new Map();
                for (const e of idx.ent) {
                    if (e.type !== "miner") continue;
                    const kind = engine.ore instanceof Map ? engine.ore.get(`${e.x},${e.y}`) : null;
                    if (typeof kind !== "string") continue;
                    const rec = byPig.get(kind) || [];
                    rec.push({ handle: handleOf(handles, e.uid), cell: [e.x, e.y] });
                    byPig.set(kind, rec);
                }
                return byPig;
            })();

            const oreHint = (() => {
                if (!engine.resourcesPresent) return { text: "the observation carries no resource map, so where to mine a pigment cannot be read", sites: [] };
                const wantPig = [...new Set(wantColors)].map(c => String(c).replace(/^color:/, ""));
                const nearest = [];
                for (const pig of wantPig) {
                    const veins = veinsOf(pig);
                    const best = veins.length ? veins[0] : null;
                    const all = minerOnPigment.get(pig) || [];
                    /* 只数站在**最近那条矿脉**上的矿机，别把 44 格外那片算进来 */
                    const onVein = best
                        ? all.filter(mm => best.cells.some(c => c[0] === mm.cell[0] && c[1] === mm.cell[1]))
                        : [];
                    nearest.push({
                        pigment: `color:${pig}`,
                        ...(best ? { distance: best.d, at: best.at } : { distance: null }),
                        /* `miners` = 最近那条矿脉上的台数（这是「这一步该不该放矿机」的依据） */
                        miners: onVein.length,
                        miner_handles: onVein.map(x => x.handle),
                        /* `miners_anywhere` = 全图该矿种的台数，仅作参考 */
                        miners_anywhere: all.length,
                        vein_cells: best ? best.cells.length : 0,
                        veins: veins.length,
                    });
                }
                const missing = nearest.filter(n => n.distance === null);
                /* ★ 按「这一步要做什么」排序，不按颜料在配方里的顺序 ★
                 *
                 * prompt 只渲染 hint 的前 180 字符。第 9 关的形态是
                 * 「蓝：5 格 / 已有 7 台矿机」「红：44 格 / 0 台」——
                 * 蓝那半句是**已经做完的事情**（矿机在，只是没接），
                 * 红那半句才是**这一轮要动手的**（矿区是空的）。
                 * 按配方顺序写，红矿永远被截掉。
                 *
                 * ⇒ 缺矿机的（可推进的）排前面，已有矿机的（只剩接线的）排后面。 */
                const rank = n => (n.miners > 0 ? 1 : 0);
                const ordered = [...nearest].sort((a, b) => rank(a) - rank(b));
                const text = missing.length
                    ? `no ${missing.map(n => n.pigment).join("/")} ore exists in the observed region at all`
                    : ordered.map(n => {
                        const where = `${n.pigment} ore is ${n.distance} tile(s) away`
                            + (n.veins > 1 ? ` (${n.veins} separate patches)` : "");
                        return n.miners
                            ? `${where}; that patch already has ${n.miners} miner(s) (${n.miner_handles.slice(0, 3).join("/")}…)`
                            : `${where}; NO miner on it yet`;
                    }).join("; ");
                return { text, sites: nearest, ordered };
            })();

            /* ★ 必须点名**哪一个** color 槽，否则模型只能瞎猜 ★
             *
             * 第 9 关实测：诊断说「接到这个 mixer 的另一个 color 槽」，模型照做写
             * `to: {ref:"C7", port:"color"}` —— mixer 两个槽的 role **都叫 color**，
             * 于是 `selectPort` 命中 2 个 ⇒ `ambiguous_port` ⇒ 三连败。
             *
             * 这不是模型不懂消歧，是我们没告诉它该填哪个索引。`connect` 的
             * `port` 支持 `{role,index}` 与 `{entry:n}` 两种形态，把可用的那个直接写出来。 */
            const badSlots = resolved.map((v, i) => (v === null ? i : -1)).filter(i => i >= 0);
            /* ★ `belt-not-aimed` 这种情形，正确的出口方向是**唯一确定的** ★
             *
             * 那一格的带子就贴在 mixer 的输入面上，它必须朝 mixer 喷。
             * `replace_run` 的 belt 模式支持 `opts.facing:"<face>"` 显式给方向
             * （见 remove.mjs 的 `bopts.facing`），而模型 8 轮里试了 4 次
             * 都没能通过 —— 因为它不知道要传，也不知道该传哪个面。
             *
             * 这里把「哪一格、必须朝哪面」直接算出来写进 hint：
             *   face = 从该格指向 mixer 槽格的方向（= 该槽的 `dir`）。
             * 模型照抄 `opts.facing:"<face>"` 就能一次改对。 */
            const facingFix = [];
            for (const i of badSlots) {
                const f = feeds[i];
                if (!f || f.why !== "belt-not-aimed") continue;
                const h = Number.isInteger(f.beltUid) ? handleOf(handles, f.beltUid) : null;
                if (!h) continue;
                /* ⚠️ 不是 `f.dir`！`f.dir` 是**槽的朝向**（bottom = 槽在机器下沿），
                   而带子要朝的是**从它自己那格指向槽格**的方向 —— 两者正好相反。
                   实测（第 9 关 B198 @(34,-12)、mixer 槽 @(34,-13)）：
                     slot.dir = "bottom"（槽朝下）
                     带子必须 exit = "top"（朝上，才能喷进上方那格）
                   拿 `f.dir` 会给出「必须朝 bottom」，照做会把货喷到反方向 ——
                   比不给还糟。所以这里按**坐标差**算，不按槽的朝向。 */
                const dx = f.slot[0] - f.cell[0], dy = f.slot[1] - f.cell[1];
                const face = dy < 0 ? "top" : dy > 0 ? "bottom" : dx > 0 ? "right" : dx < 0 ? "left" : null;
                if (!face) continue;
                facingFix.push({ slot: i, belt: h, face });
            }
            /* ★ 断头存在时，这段必须闭嘴 ★
             *
             * 它说的是「connect 时写 port:{role,index:N}」—— 而断头时
             * 那个槽上已经压着线，connect 到它必然 `target_already_fed`。
             * 两句话同时出现时模型只会挑更具体的这句（实测
             * r-20261112175721-48ca：三轮全撞在 target_already_fed 上）。
             *
             * 端口选择器只在「槽是空的、需要新建一条线进来」时才有意义。 */
            /* ★ 拆成两句：`indexHint` 恒说，`slotHint` 只在非断头时说 ★
             *
             * 原实现是 `deadEnds.length ? "" : …` —— 断头时整段关掉。
             * 关掉的理由是对的：断头时那个槽上已经压着线，`connect` 到它必然
             * `target_already_fed`（M13 守的就是这个）。
             *
             * 但整段关掉把**另一件事**也关掉了：mixer 两个槽的 role **都叫 color**，
             * 所以任何涉及 mixer 的 `connect` 都必须给 `index`，否则 `ambiguous_port`。
             * 真机 r-20261113190330-c440：模型在修槽 0，写 `port:"color"` ⇒ ambiguous_port；
             * 宏算好的 `{role,index}` 要等**下一轮**的 LAST ROUND 才送到它眼前，
             * 这一轮它只能猜 —— 而它猜错了。
             *
             * 所以拆开：
             *   · `indexHint` —— 恒说（「两个槽同名，要写 index」）。这是**语法**信息，
             *     与「该不该接到这个槽」无关，断头时同样成立；
             *   · `slotHint` —— 只在**非断头**时说（「就接到这个槽」）。断头时这会引它撞车。 */
            const indexHint = badSlots.length
                ? `mixer 两个 color 槽同名 —— connect 时写 \`port:{role:"color", index:0}\` 或 \`index:1\` 指槽`
                    + `（**只写 \`port:"color"\` 会报 ambiguous_port**）。`
                : "";
            const slotHint = deadEnds.length ? "" : indexHint;
            out.push({
                code: "MIXER_UNFED",
                layer: "L4",
                severity: "blocker",
                subject: { handle: mh, type: "mixer", uid: m.uid },
                expected: `this mixer receives ${[...new Set(wantColors)].join(" + ")} (the recipe's mix step needs `
                    + `inputs ${JSON.stringify(mixStep.inputs)})`,
                observed: why,
                evidence: {
                    /* ★ hint 里点名的矿机句柄必须进 handles ★
                     *
                     * `renderMachines` 按 `referencedHandles(diagnoses)` 排序，
                     * 只显示前 `MACHINES_MAX`（20）台。世界有 28 台矿机时，
                     * 红矿那几台被截掉 —— 而 hint 正文却写着
                     * `connect {from:{ref:"M17"}, ...}`。
                     *
                     * 真机 r-20261113141840-a195 的 say 直接点破了这件事：
                     *   「the red miners named in the hint (M15/M16/M17) have
                     *     no handles in this prompt」
                     * 模型于是退回去放矿机（r3/r6）—— 因为它要指的那几台不存在于它的世界视图里。
                     *
                     * 把 `ore_reach` 里出现过的矿机句柄一并塞进 `handles`，
                     * `referencedHandles` 就会把它们排到前面，不再被上限截掉。 */
                    handles: [mh, ...feedHandles, ...oreHint.sites.flatMap(n => n.miner_handles || [])].filter(Boolean),
                    uids: [m.uid],
                    mixer_handle: mh,
                    feed_handles: feedHandles,
                    /* 每个槽的可施工描述：索引、槽格、喂料格、缺口原因 —— 模型据此写 port 选择器 */
                    slots: colorIdx.slice(0, 2).map((i, k) => ({
                        index: k, role: "color",
                        slot: feeds[k] ? feeds[k].slot : null,
                        feed_cell: feeds[k] ? feeds[k].cell : null,
                        value: shapeOfVal(resolved[k]),
                        why: feeds[k] ? (feeds[k].why || null) : "slot-missing",
                        feed_handle: (feeds[k] && Number.isInteger(feeds[k].beltUid))
                            ? handleOf(handles, feeds[k].beltUid) : null,
                    })),
                    slot_values: resolved.map(shapeOfVal),
                    slot_why: feeds.map(f => (f ? (f.why || null) : "slot-missing")),
                    /* ★ 每条喂料线的上游：多长、源头是什么 ★
                     *
                     * `slot_why` 全是 null 时（带子对准了、mixer 也接受），
                     * 问题只可能在上游。这里如实给出：格数 + 源头类型。
                     * `head: "empty"` = 那条线是断头，源头是空地。 */
                    upstream: ups.map(u => (u ? {
                        len: u.len, head: u.head,
                        ...(u.headType ? { head_type: u.headType } : {}),
                        /* ★ 源头那一格的句柄 ★
                         *
                         * 模型要「把矿机接到那条线的起点」，可它只有句柄、
                         * 没有坐标。不说出这一格叫什么，它就只能反复
                         * connect 到 mixer 那一端（必然 target_already_fed）。 */
                        ...(u.headHandle ? { head_handle: u.headHandle } : {}),
                    } : null)),
                    need_slot: badSlots.length === 1 ? badSlots[0] : null,
                    want_colors: [...new Set(wantColors)].sort(),
                    /* 每种要的颜料最近在哪、多远 —— 见上方 oreHint 的注释。 */
                    ore_reach: oreHint.sites,
                    mix_inputs: mixStep ? mixStep.inputs : null,
                },
                /* 可施工的下一步：那条缺的/重复的颜料得从别处的矿拉过来。
                   `connect` 能铺路；`insert_machine` 能补一台矿机；`replace_run` 能就地改线。
                   ⚠️ **两种**矿的最近矿区上都已有矿机时把 `insert_machine` 拿掉 ——
                   第 9 关实测，留着它模型就一直放矿机（7 次），一次都没接线。
                   只有**某种**矿的空矿区还等着放矿机时，才保留它。 */
                candidates: oreHint.sites.every(n => n.miners > 0 || n.distance === null)
                    ? ["connect", "replace_run"]
                    : ["connect", "insert_machine", "replace_run"],
                /* ★ 顺序是**按重要性**排的，因为 prompt 只给 hint 前 180 字符 ★
                 *
                 * 实测（第 9 关）：矿距信息原来排在最后，被 `clip(…, 180)` 整个切掉 ——
                 * prompt 里只剩「…」，模型看到的是「这台 mixer 只有一路颜料」
                 * 然后自己想办法，三轮都在改那条蓝线，一次都没去看 44 格外的红矿。
                 *
                 * 真正决定行动的是**矿在哪、多远**（蓝 5 格 / 红 44 格 ⇒ 这是支线工程，
                 * 不是接线问题）。所以它必须排在最前面。端口索引是「怎么调」的细节，
                 * 排在后面被截掉也不致命。 */
                hint: anyUnresolved
                    ? (() => {
                        /* ★ 前缀不是固定的：**断头**必须抢在「矿在哪」之前 ★
                         *
                         * prompt 只渲染前 180 字符。第 9 关实测：两槽的线都对准了、
                         * mixer 也接受，只是源头断头 —— 而 `oreHint.text` 那段
                         * 「蓝矿 5 格 / 红矿 44 格」有 100 多字符，把断头整段挤掉。
                         * 模型看到的是「颜料从哪来」，于是又去研究矿，
                         * 而真正该做的是**去那条线的起点补上**。
                         *
                         * 所以：有断头 ⇒ 断头排第一；没断头 ⇒ 矿信息排第一。 */
                        /* ★ 死线必须**排在补源头之前** ★
                         *
                         * 顺序不是排版：prompt 只渲染 hint 前 180 字符。
                         * 如果先说「槽 0 的线源头断了，起点是 B2」，模型就会去接 B2 ——
                         * 而 B2 那条线整条到不了 hub，接了也是白接（预演会拦）。
                         * 真机两轮连撞（r-20261113183309-79c3）。
                         *
                         * 所以：**先告诉它这条线是死的，再说源头在哪**。 */
                        const deadLineLead = (() => {
                            const dead = feedLineDead
                                .map((isDead, i) => (isDead ? i : -1))
                                .filter(i => i >= 0);
                            if (!dead.length) return "";
                            /* ★ 流头恰好在矿上 ⇒ 这是**一步就能做完**的正解，必须说 ★
                             *
                             * 真机现场（2026-11-13，level 9）：蓝矿在 (38,-12)，
                             * 距 mixer 只有 **5 格**，而**那条断头链的流头正好就是这一格**。
                             *
                             * 也就是说：在 (38,-12) 放一台矿机，槽 1 立刻就有料了。
                             * 全部信息诊断都有（`ore_reach[].at` 给了坐标、
                             * `miners: 0` 说明那儿没机器、`upstream[].headHandle` 给了流头），
                             * **但从来没有一句话把它们连起来说过**。
                             *
                             * 模型于是每轮都在「接到 B2 / 改朝向 / 铺一条 47 格的长线」
                             * 之间打转 —— 而正解是「在 5 格外的矿上放一台矿机」。
                             *
                             * 判据：某个死线的流头格**就是**某个所需颜料的最近矿点。
                             * 那就直接说「在那儿放矿机」，用 `$ore` 指矿（它不用坐标）。 */
                            const headOnOre = (() => {
                                for (const i of dead) {
                                    const u = ups[i];
                                    if (!u) continue;
                                    /* ⚠️ 要比的是**流头之前那一格**，不是流头带子自己那格。
                                     *
                                     * `u.headCell` 是流头带子所在的格（例如 B48 @(38,-13)），
                                     * 而「源头是空的」指的是它**入口格**（(38,-12)）上没有东西
                                     * —— 那一格才是模型要补的位置，也是可能长着矿的那一格。
                                     *
                                     * 第一版直接拿 `u.headCell` 去和矿点坐标比，于是
                                     * 明明 (38,-12) 有蓝矿、B48 的入口格也正是 (38,-12)，
                                     * 却永远配不上（差一格）。 */
                                    const headBelt = Number.isInteger(u.headUid)
                                        ? idx.byUid.get(u.headUid) : null;
                                    const holeCell = headBelt && isBelt(headBelt)
                                        ? entryCellOf(headBelt)
                                        : u.headCell;
                                    if (!Array.isArray(holeCell)) continue;
                                    const site = (oreHint.sites || []).find(s =>
                                        Array.isArray(s.at) && s.at[0] === holeCell[0] && s.at[1] === holeCell[1]);
                                    if (site && site.miners === 0) {
                                        const pig = String(site.pigment).replace(/^color:/, "");
                                        return { slot: i, pigment: pig, distance: site.distance };
                                    }
                                }
                                return null;
                            })();
                            if (headOnOre) {
                                return `配方 ${[...new Set(wantColors)].join("+")}，`
                                    + `**槽 ${headOnOre.slot} 的线流头就在 ${headOnOre.pigment} 矿上`
                                    + `（${headOnOre.distance} 格外）** —— `
                                    + `就地放一台矿机即可：\`insert_machine {at:{"$ore":"${headOnOre.pigment}"}, `
                                    + `facing:<朝 mixer 那一侧>, machine:"miner"}\`，`
                                    + `不用铺新线（矿机输出直接进现有的链）。`;
                            }
                            /* 长度预算：prompt 只渲染前 180 字符，而后面紧跟着
                               「接线的方向：起点是 `B15`」—— 那个句柄是这一轮唯一可执行的
                               抓手（M14 就是为它设的），**不能被这句挤出去**。
                               所以这句压到 60 字符以内：只保留「哪几个槽」+「别补源头」。
                               「断」这个字必须留着 —— 它是「这条线有问题」的语义标记，
                               模型和测试都按它找（M12）。 */
                            return `配方 ${[...new Set(wantColors)].join("+")}，`
                                + `**槽 ${dead.join("/")} 的线断了、到不了 hub**（补源头无用）。`;
                        })();
                        /* ★ 朝向错的那一格排**第一** ★
                         *
                         * `facingFix` 是这台 mixer 上**唯一可以立刻执行、且不需要新建任何东西**
                         * 的动作：某条喂料带方向反了，就地 `replace_run` 改对即可。
                         *
                         * 而它原来排在 hint 最末尾。prompt 只渲染前 180 字符 ⇒
                         * 模型只能看到前面的「源头断了 / 补源头」，看不到这条。
                         *
                         * 真机实测（2026-11-13，level 9，连续四个 run）：
                         * 喂料链 B2→B1→B6→B5→B4→B3 里 **B4 的朝向是错的**（要朝 top，
                         * 实际朝别处）—— 这条链因此根本不通。而模型每轮都被
                         * 「补源头」引去接 B2，四轮全撞在同一个预演闸门上（死带子 +47）。
                         *
                         * 「算出来 ≠ 送到」在这个项目里已经复发过太多次，这是又一次：
                         * `facingFix` 算得完全正确，只是它没进前 180 字。 */
                        const facingLead = facingFix.length
                            ? `**${facingFix[0].belt} 朝向错了**（必须朝 "${facingFix[0].face}"）——`
                                + `就地改：\`replace_run {region:$path_of(["${facingFix[0].belt}"]), `
                                + `building:"belt", opts:{facing:"${facingFix[0].face}"}}\`。`
                            : "";
                        const lead = deadEnds.length
                            ? `配方 ${[...new Set(wantColors)].join("+")}，`
                                + `**槽 ${deadEnds.map(x => x.i).join("/")} 的线源头断了**`
                                /* 上游 0 格 = feed 格自己就是流头，说「0 格」没意义 */
                                + (deadEnds.every(x => x.u.len === 0)
                                    ? ""
                                    : `（${deadEnds.map(x => `${x.u.len} 格`).join("/")}）`)
                            : "";
                        const oreLead = `配方要 ${[...new Set(wantColors)].join(" + ")}。**颜料从哪来**：${oreHint.text}。`;
                        /* ★ 有断头时**不**插矿信息 ★
                         *
                         * 那段有 100 多字符（「蓝矿 5 格 / 红矿 44 格，N 片矿区」），
                         * 插在中间会把「接线的方向：起点是 B57」推出前 180 字 ——
                         * 而那才是这一轮唯一可执行的动作（M14 抓到的正是这个）。
                         *
                         * 矿信息不会丢：后面的动作块照样会说
                         * 「color:blue 的矿机（M2/M6/M8，输出口空着）」和
                         * 「color:red 的最近矿区一台矿机都没有」。 */
                        return facingLead || deadLineLead || lead || oreLead;
                    })()
                        + (() => {
                            /* 「放矿机」只在**确实还没有矿机**的那一种上才该说。
                               第 9 关实测：这条提示连说 7 轮，模型就真放了 7 次，
                               蓝矿挤满矿机而一条线都没接成。
                               现在**分矿种**给动作，因为蓝矿和红矿的欠缺完全不同：
                               蓝矿「矿机在，缺线」，红矿「矿区是空的，缺矿机」。 */
                            const ready = oreHint.sites.filter(n => n.miners > 0);
                            const empty = oreHint.sites.filter(n => !n.miners && n.distance !== null);
                            const parts = [];
                            /* ★ 有断头时，「空矿区要放矿机」这句**也要让位** ★
                             *
                             * 它比断头警告更长（会说两个距离、还会说「长支线」），
                             * 插在前面就把真正的指令推出 180 字（M14 抓到）。
                             * 断头时放置矿机仍然在动作块里出现（「先在矿上放一台」），
                             * 不会丢信息 —— 只是不抢占前 180 字。 */
                            if (empty.length && !deadEnds.length) {
                                const far = empty.some(n => n.distance > 20);
                                parts.push(`${empty.map(n => n.pigment).join("/")} 的最近矿区**一台矿机都没有**`
                                    + `（${empty.map(n => `${n.distance} 格外`).join("，")}），`
                                    + `先 \`insert_machine\` 放一台${far ? "——这路要单独规划，是长支线，不是接一根线" : ""}`);
                            }
                            if (ready.length && !deadEnds.length) {
                                parts.push(`${ready.map(n => n.pigment).join("/")} 那边矿机已经在了（`
                                    + `${ready.map(n => n.miner_handles.slice(0, 3).join("/")).join("，")}）——`
                                    + `**别再放**，只做接线：\`connect\` 到 \`{ref:"${mh}", port:{role:"color", index:0}}\` 或 \`index:1\`，撞到带子加 \`allow_replace\``);
                            }
                            /* ★ 有断头时**不许**再说「connect 到 mixer 的槽」★
                             *
                             * 真机 r-20261112175721-48ca（第 9 关）：hint 前半段说
                             * 「去那条线的起点补」，后半段说「connect 到 index:0」。
                             * 两者**互相矛盾** —— 槽 0 上已经压着一条带子（就是那条断头线），
                             * `connect` 到它必然 `target_already_fed`。模型选了更具体的那句，
                             * 于是三轮全撞在 `target_already_fed` / `ambiguous_port` 上，
                             * 整轮 run `inert`（0 落盘）。
                             *
                             * ⚠️ 这条警告**不能**挂在 `ready.length` 上 ——
                             * 断头本身就是「别接 mixer 这一端」的理由，
                             * 与世界上有没有矿机无关。第一版挂在 ready 里，
                             * M13（无矿机的夹具）当场判红。
                             *
                             * 它说的是同一件事的两种情形：
                             *   · 有矿机 ⇒ 把**它**接到线的起点
                             *   · 没矿机 ⇒ 先在矿上放一台，再把线接到它 */
                            /* ★ 断头线太长时，**不要**教模型去接它的源头 ★
                             *
                             * 真机 r-20261112190707-de26 / r-20261112193013-99fb：
                             * 诊断说「起点是 B57，把它接上」，模型照做，铺了 57 格 ——
                             * 全通不到 hub，死带子 394→447；下一轮上游从 49 格涨到 106 格，
                             * 因为它接到的地方又是一条新的断头。
                             *
                             * 而那些矿机**就在 mixer 旁边**：M2 距 mixer 只有 5 格，
                             * 而 B306 在 7 格外、它那条线有 106 格。
                             * 正确动作不是「把矿机接到那条长线的源头」，是
                             * **把槽从那条死线手里抢过来，直接就近接** ——
                             * `connect {from:M2, to:C7, port:{role:"color",index:0}, opts:{rebind:true}}`，
                             * 5 格就完事（离线实测这两次 connect 都 OK，len=5/6）。
                             *
                             * 判据：断头线长度 > 最近矿机到 mixer 的距离 × 3 时，
                             * 修那条线就是绕远路。这是数量级的差别（106 vs 5），
                             * 乘 3 是留余量，避免把「线只长一点点」也判成绕路。 */
                            const nearDist = ready.length
                                ? Math.min(...ready.map(n => n.distance))
                                : (oreHint.sites.length ? Math.min(...oreHint.sites.map(n => n.distance === null ? 999 : n.distance)) : 999);
                            /* ⚠️ 用 `some` 不是 `every` —— 只要**有一个**槽的线长得离谱，
                               修它就是绕远路。第 9 关的形态是 106 格 vs 3 格：
                               `every` 会因为那个 3 格的正常槽而整条判假。 */
                            const longOnes = deadEnds.filter(x => x.u.len > nearDist * 3);
                            if (deadEnds.length) {
                                const firstIdx = deadEnds[0].i;
                                const d0 = deadEnds[0].u;
                                if (longOnes.length && ready.length) {
                                    const t = longOnes[0];
                                    const ti = t.i;
                                    /* 直接抢槽 —— 比修那条长线短一个数量级。
                                       ⚠️ 两条警告都必须落在**前 180 字**内：
                                         · 别加 allow_replace（会重铺带子改坏朝向）；
                                         · **一次把两个槽都接上** —— 第 9 关实测：
                                           只接 slot 0 的那 5 格路正好穿过 slot 1 的喂料格，
                                           把它的线覆盖成朝左的死线，两个槽一起废掉。 */
                                    const near3 = ready[0].miner_handles.slice(0, 3).join("/");
                                    /* ★ 两台矿机挨得太近 ⇒ 它们接两个槽的路径会重叠 ★
                                     *
                                     * 真机 r-20261113084958-4e86：模型按 hint 接了 M2+M3
                                     * （相邻两格）。两条路共用 5 个格子，游戏落盘时按邻居
                                     * 重算了 `(35,-12)` 的 rotation_variant（计划要 corner，
                                     * 落成直线）⇒ `L1-landing: want 3, got 1`。
                                     *
                                     * 离线实测：M6 / M9 给两个槽的路线**完全平行不重叠**
                                     * （M6 走 x=34 与 x=35 两列），那才是能同时成立的一对。
                                     *
                                     * 这里只能给提示，不能替模型算（那要在诊断里跑两次 connect，
                                     * 会成环）。判据取「曼哈顿 ≤ 4」= 相邻或隔一格。 */
                                    const mineCells = (() => {
                                        const out = [];
                                        for (const hd of ready[0].miner_handles.slice(0, 6)) {
                                            const e = idx.ent.find(x => x.type === "miner"
                                                && handleOf(handles, x.uid) === hd);
                                            if (e) out.push({ h: hd, x: e.x, y: e.y });
                                        }
                                        return out;
                                    })();
                                    const tooClose = (() => {
                                        for (let i = 0; i < mineCells.length; i++) {
                                            for (let j = i + 1; j < mineCells.length; j++) {
                                                const d2 = Math.abs(mineCells[i].x - mineCells[j].x)
                                                    + Math.abs(mineCells[i].y - mineCells[j].y);
                                                if (d2 <= 3) return [mineCells[i].h, mineCells[j].h];
                                            }
                                        }
                                        return null;
                                    })();
                                    /* ★ 真的试算出一对不重叠的矿机 ★
                                     *
                                     * 几何近似（距离 / 方位角）都试过，都不准：
                                     *   · M6/M9 只相距 2 格却不冲突（路线平行）；
                                     *   · 这一带 8 台矿机全在东南，角度差不出 50°。
                                     * 只有实际跑 connect 才分得开。见 chooseMinerPair。 */
                                    /* ★ 配对必须**跨矿种**：一蓝一红 ★
                                     *
                                     * 原来只从 `ready[0].miner_handles`（同一种颜料的那几台）里挑，
                                     * 于是永远选出「两台蓝」—— 而 mix() 需要的是两种**不同**的颜料。
                                     * 真机 r-20261113142544-ddbf：hint 推荐 M6+M2（都是蓝矿机），
                                     * 模型照做两次全 `macro_failed`，整轮 `inert`。
                                     *
                                     * 现在先从「有矿机的那种颜料」里挑一台，
                                     * 再从另一种颜料里挑一台 —— 顺序对两遍都试。 */
                                    const pigmentPools = oreHint.sites
                                        .filter(n => n.miners > 0 && Array.isArray(n.miner_handles) && n.miner_handles.length)
                                        .map(n => ({ pigment: n.pigment, handles: n.miner_handles }));
                                    const pair = (() => {
                                        if (pigmentPools.length < 2) {
                                            /* 只有一种颜料有矿机 ⇒ 退回同种内配对（至少能修一个槽） */
                                            return chooseMinerPair(o, handles, m, ready[0].miner_handles,
                                                colorIdx.slice(0, 2),
                                                feeds.map(f => (f && Array.isArray(f.cell) ? f.cell : null)).filter(Boolean));
                                        }
                                        const scratchCells = feeds.map(f => (f && Array.isArray(f.cell) ? f.cell : null)).filter(Boolean);
                                        /* pair 里两台必须来自**不同**的颜料池 ——
                                           `chooseMinerPair` 只保证「路线不重叠」，不保证「矿种不同」。 */
                                        const pigOf = new Map();
                                        for (const p of pigmentPools) for (const h of p.handles) pigOf.set(h, p.pigment);
                                        const [p0, p1] = pigmentPools;
                                        for (const [x, y] of [[p0, p1], [p1, p0]]) {
                                            const r = chooseMinerPair(o, handles, m, [...x.handles, ...y.handles],
                                                colorIdx.slice(0, 2), scratchCells);
                                            if (!r) continue;
                                            if (pigOf.get(r.a) !== pigOf.get(r.b)) return r;   // 跨矿种 ⇒ 采用
                                        }
                                        return null;
                                    })();
                                    const pairHint = pair
                                        ? `**用 ${pair.a} 接 index:${pair.idxA}、${pair.b} 接 index:${pair.idxB}**`
                                            + `（实测这一对路线不重叠；挨着的那两台会重叠，落盘时朝向被改成直线）`
                                        : (tooClose
                                            ? `**${tooClose.join(" 和 ")} 挨得太近，别拿它们各接一个槽**`
                                                + `（路线重叠，游戏落盘会把朝向改直线，槽就废）。`
                                                + `挑两台从**不同方向**进 mixer 的`
                                            : "");
                                    /* ★ 顺序 = 「错了就白干」的那条最先 ★
                                     *
                                     * prompt 只渲染前 180 字。真机 r-20261113091844-77ce：
                                     * 「别选挨太近的」写在末尾，模型没看到，于是照旧选 M2+M3，
                                     * 落盘 `L1-landing: want 3, got 1`（朝向被游戏按邻居改掉）。
                                     *
                                     * 前面那几句（别修长线 / 别加 allow_replace）说错也只是
                                     * 多花几格；「选错矿机对」会让整步白干 —— 它必须在前。 */
                                    parts.push(pair
                                        ? pairHint + `。照这个写：`
                                            + `\`connect {from:{ref:"${pair.a}"}, to:{ref:"${mh}", port:{role:"color", index:${pair.idxA}}}, opts:{rebind:true}}\``
                                            + ` + \`connect {from:{ref:"${pair.b}"}, to:{ref:"${mh}", port:{role:"color", index:${pair.idxB}}}, opts:{rebind:true}}\``
                                            + `。**只要 rebind，别加 allow_replace**（会重铺带子、改坏朝向）`
                                        : `**别修那条 ${t.u.len} 格的长线** —— `
                                            + `矿机（${near3}）离 mixer 只 ${nearDist} 格，就地抢槽。`
                                            + `**只要 rebind，别加 allow_replace**（会重铺带子、改坏朝向）；`
                                            + `**两个槽分开接、用不同矿机**（只接一个的话，路径会穿过另一个槽的喂料格）：`
                                            + `\`connect {from:{ref:"${ready[0].miner_handles[0]}"}, to:{ref:"${mh}", `
                                            + `port:{role:"color", index:${ti}}}, opts:{rebind:true}}\`，`
                                            + `另一个槽同样写法、换 index 和一台**不同的**矿机`);
                                } else {
                                    /* ★ 线本身到不了 hub ⇒ **不要**再让它去补源头 ★
                                     *
                                     * 上面 `deadLineLead` 已经说了「这条线是死的、补源头也没用」。
                                     * 如果这里还说「把矿机接到 B15」，两句话直接打架 ——
                                     * 而这个仓库的教训是：两条自相矛盾的建议，
                                     * 模型只会挑**更具体**的那条（也就是这句带句柄的）。
                                     *
                                     * 真机 r-20261113183309-79c3：模型连着两轮去接 B2，
                                     * 两轮都被预演闸门拦下（死带子 6→53）。它没有帮凶，
                                     * 但两句 hint 里它选错了那句。
                                     *
                                     * 死线的正确动作只有两个：整条接去 hub，或者别管它。
                                     * 说清这两个，不给「接到 B15」这条会白干的路。 */
                                    /* ⚠️ `d0` 是 `deadEnds[0].u` —— **上游对象**，它没有 `.i`。
                                       槽位索引在 `deadEnds[0].i` 上。这里原来写的是
                                       `d0 ? d0.i : -1`，恒为 undefined ⇒ `feedLineDead[undefined]`
                                       恒为 undefined ⇒ **死线分支从来没进过**。
                                       于是 hint 同时说了两句打架的话：
                                         「槽 0/1 的线断了、到不了 hub」（lead）
                                         「起点是 B2，把矿机接到它」（action）
                                       模型挑了更具体的那句 —— 连着四轮去接 B2。 */
                                    /* ★ 逐个槽说，不要只挑第一个 ★
                                     *
                                     * `deadEnds[0]` 只覆盖槽 0。而实测这两条链**都**是断头：
                                     * 槽 0 的流头是 B3、槽 1 的流头是 B5（各自独立）。
                                     * 只说槽 0 ⇒ 模型修完槽 0 就以为完事，槽 1 还是死的。
                                     *
                                     * 更糟的是 `deadEnds[0].u.headHandle` 配 `deadEnds[1]` 的
                                     * 话会被错当成「同一个源头」—— 而它们其实是两条不同的线。
                                     * 每个槽必须配**自己**的 headHandle。 */
                                    const perSlot = deadEnds.map(x => {
                                        const si = x.i;
                                        const dead = feedLineDead[si] === true;
                                        const hd = (x.u && x.u.headHandle) ? x.u.headHandle : null;
                                        if (dead) {
                                            return `**槽 ${si} 的线到不了 hub** —— 别把矿机接到 \`${hd || "它上游那一格"}\`，`
                                                + `那样货照样送不出去；要么先 \`connect\` 把它的**另一头（下游末端）**接去 hub，`
                                                + `要么另铺一条直接到 hub 的线`;
                                        }
                                        const who = ready.length
                                            ? `${ready[0].pigment} 的矿机（${ready[0].miner_handles.slice(0, 3).join("/")}）`
                                            : `先在矿上放一台矿机`;
                                        return `**接线的方向**：槽 ${si} 的起点是 \`${hd || "那条线最上游那一格"}\` —— `
                                            + `把 ${who}接**到它**（\`connect {from:{...矿机}, to:{ref:"${hd || "..."}"}}\`）`;
                                    });
                                    parts.push(perSlot.join("；")
                                        + `。⚠️ **不要** connect 到 \`{ref:"${mh}", port:{role:"color", index:${firstIdx}}}\` —— `
                                        + `那个槽上已经压着这条线，会报 \`target_already_fed\``);
                                }
                            }
                            return parts.length ? parts.join("；") + "。" : "";
                        })()
                        + `${slotHint}`
                        /* ⚠️ `indexHint` **不在断头时出现**。
                         *
                         * 我本来想在断头时也留一句「语法上要写 index」，理由是
                         * 「模型可能在接别的地方」。但 M13 直接证伪了：
                         * hint 里同时有「**不要** connect 到 {port:{role:"color",index:0}}」
                         * 和「connect 时写 port:{role:"color",index:0}」——
                         * 读起来就是自相矛盾，哪怕两句话说的是不同的事。
                         *
                         * 这个仓库的实测反复证明：两条矛盾的建议，模型只挑**更具体**的那条。
                         * 而断头时那个更具体的动作是「接到槽上」= 必然 target_already_fed。
                         *
                         * 所以断头时宁可不提 index。真正需要 index 的场合（槽是空的、
                         * 要新建一条线进来）`slotHint` 已经覆盖了。 */
                        /* `facingFix` 的正文已经提到 hint **最前面**（`facingLead`）——
                           那里才是唯一能进前 180 字的位置。这里不再重复：
                           同一句话说两遍只会把别的内容挤出去。 */
                    : (() => {
                        /* ★ 「两个槽同色」必须给出可执行的接线指令，不能只说「换一种颜料」★
                         *
                         * 真机 r-20261113140707-184b（第 9 关）：这一句是
                         *   「mix() 要的是两种不同的颜料 —— 把其中一路改接到另一种颜色的矿上。」
                         * 模型照做了 4 轮 —— 但每轮都是 `insert_machine {$ore:"red"}`，
                         * 连放 4 台红矿机，**一台都没接线**。红矿上的矿机从 2 台涨到 6 台。
                         *
                         * 两个缺失：
                         *   ① 没直说「红矿已经有矿机了，别再放」——
                         *      而 `candidates` 里其实已经剔掉了 `insert_machine`，
                         *      模型没把「候选里没有它」读成「不许用它」；
                         *   ② 没给「接哪台、接到哪个槽」的具体写法。
                         *
                         * 现在两件事都说：先禁放（点名红矿已有几台），再给可直接抄的 connect。 */
                        const curPig = shapeOfVal(resolved[0]);
                        const wantOther = [...new Set(wantColors)]
                            .find(c => shapeOfVal([c]) !== curPig) || null;
                        const other = wantOther
                            ? oreHint.sites.find(n => n.pigment === wantOther)
                            : null;
                        const banned = other && other.miners > 0
                            ? `**别再放矿机** —— ${other.pigment} 那片已经有 ${other.miners} 台了`
                                + `（${other.miner_handles.slice(0, 3).join("/")}），放着不接等于白放。`
                            : "";
                        const recipe = other && other.miners > 0
                            ? `把其中一台**接到另一个槽**：`
                                + `\`connect {from:{ref:"${other.miner_handles[0]}"}, to:{ref:"${mh}", `
                                + `port:{role:"color", index:1}}, opts:{rebind:true}}\``
                                + `（换 index 0/1 看你抢哪个槽；**只要 rebind，别加 allow_replace**）。`
                            : `另一种颜色的矿上还没有矿机 —— 先 \`insert_machine\` 放一台，下一轮再接过来。`;
                        return `两个 color 槽接的是**同一条**线（都是 ${curPig}），mix() 出不了新颜色。`
                            + banned + recipe
                            + `**颜料从哪来**：${oreHint.text}。`;
                    })(),
            });
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ③ WRONG_SHAPE_AT_HUB —— 货抵达 hub 时 ∈ orbit(goal) 但不是 goal
     *
     * ⚠️ v2 §4：`evidence.handles` **只放 hub 本身**。入口带子放 `evidence.hub_inlets`，
     *    否则 `pickBelts` 会把 B135/B136/B137 顶到 BELTS 段第 1–3 位，与目标相反。
     * ──────────────────────────────────────────────────────────────────── */
    if (hub) {
        const hs = slotsOf(hub.type, hub.variant, hub.x, hub.y, hub.r || 0, beltRvOf(hub));
        const inlet = [];
        const wrong = new Set();
        for (const sl of (hs ? hs.inputs : [])) {
            const e = at(idx, sl.cell);
            if (!e) continue;
            let val = null;
            if (isBelt(e)) {
                if (!sameCell(exitCellOf(e), sl.slot) || !accepts(idx, sl.slot, exitDirOf(e)).ok) continue;
                val = engine.beltValue(e);
            } else if (isTunnel(e)) {
                continue;                            // 隧道跨界的形状不可判定 ⇒ SHAPE_UNKNOWN 已记
            } else {
                const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
                const o = s && s.outputs.find(x => sameCell(x.cell, sl.slot) && x.dir === OPP[sl.dir]);
                if (o) val = engine.outValue(e, o.role);
            }
            for (const s of shapesOf(val)) {
                const h = handleOf(handles, e.uid);
                if (h) inlet.push({ handle: h, shape: s });
                if (hull.has(s) && s !== goalShape) wrong.add(s);
            }
        }
        if (wrong.size) {
            const subj = subjectOf(handles, hub.uid, "hub");
            const arrived = [...new Set(inlet.map(x => x.shape))].sort();
            out.push({
                code: "WRONG_SHAPE_AT_HUB",
                layer: "L4",
                severity: "blocker",
                subject: subj,
                expected: `hub receives ${goalShape}`,
                observed: `hub receives ${arrived.join(" and ") || wrong.size + " wrong shape(s)"} but the goal needs ${goalShape}. `
                    + "The fix is upstream: a missing process step on the line that FEEDS the hub, not at the inlet.",
                evidence: {
                    handles: [subj.handle].filter(Boolean),      // ★ 只放 hub（v2 §4）
                    uids: [hub.uid],
                    tier: tierOf(hub.uid),
                    goal: goalShape,
                    wrong: [...wrong].sort(),
                    hub_inlets: inlet
                        .slice()
                        .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
                        .slice(0, 6),
                },
                candidates: ["replace_run", "connect"],
            });
        }

        /* ────────────────────────────────────────────────────────────────
         * ③b HUB_INLET_THIN —— hub 的 16 个入口里，真正能把货送进来的太少
         *
         * 2026-11-15 夜，L12 真机：世界有 484 条带子、373 个物品在流动、
         * `production()` 恒为空、交付恒为 0。查下来 hub 的 16 个 feed cell
         * 只有 **7 个**上放了带子，而这 7 个里西侧那 4 个全是 `r=180`
         * （货向 bottom 流，**沿着 hub 外侧纵向穿过**，不是向 right 流进 hub）。
         * 真正能收货的只有 3 个。
         *
         * 这条信号系统**一直在算**（上面那个循环里就有 `accepts(exitDirOf(e))` 判据），
         * 但它只在 `wrong.size` 非空时才被用 —— 而这个世界 hub 一件货都没收到，
         * `inlet` 是空的，于是 `wrong` 也是空的，什么都不会报。
         *
         * 结果是：agent 看到的是「NO_PRODUCTION，没有产线」，而真相是
         * **收货口本身就不够用**。它于是去加更多带子，而那些带子同样接不上。
         *
         * 判据故意保守：只在「入口少**且**目标没有任何交付」时报。
         * 交付已经通了的时候入口少不是问题（一条线够用）。 */
        {
            const allInlets = (hs && Array.isArray(hs.inputs)) ? hs.inputs : [];
            const live = [];
            const misaimed = [];
            for (const sl of allInlets) {
                const e = at(idx, sl.cell);
                if (!e) continue;
                if (isBelt(e)) {
                    /* 真正能收货 ⇔ 带子的出口正好指向 hub 本体格，且 hub 收这个来向 */
                    const okDelivery = sameCell(exitCellOf(e), sl.slot) && accepts(idx, sl.slot, exitDirOf(e)).ok;
                    if (okDelivery) live.push({ cell: sl.cell, handle: handleOf(handles, e.uid) });
                    else misaimed.push({ cell: sl.cell, handle: handleOf(handles, e.uid) });
                } else if (isTunnel(e)) {
                    /* 隧道跨界，方向不可判定 ⇒ 不计入 live，也不计入 misaimed */
                } else {
                    const s2 = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
                    const o = s2 && s2.outputs.find(x => sameCell(x.cell, sl.slot) && x.dir === OPP[sl.dir]);
                    if (o) live.push({ cell: sl.cell, handle: handleOf(handles, e.uid) });
                }
            }
            /* 交付数：goal 可能是形状串，也可能是 {shape, required, delivered, progress}。
               自己取数，不依赖别的模块的 `num()` —— 这里只需要「是不是 0」。 */
            const deliveredNow = (goal && typeof goal === "object"
                && typeof goal.delivered === "number" && Number.isFinite(goal.delivered))
                ? goal.delivered
                : 0;
            /* 触发条件：
             *
             *   · `inlet.length === 0` —— hub 一个**能收到货**的入口都没有
             *     （`inlet` 是上面那个循环填的：只有带子的出口真的指向 hub 本体、
             *      且 hub 接受那个来向时才 push）。用这一条而不是 `delivered === 0`：
             *      后者在测试夹具里恒为 0，会把「已经修好」的世界也判进来
             *      （`semantic.test.mjs` 的 T5 就是这么红的）。
             *   · `misaimed.length > 0` —— 且确实有带子**摆在入口格上却指错了方向**。
             *
             * 为什么不加「live 太少」这种阈值：试过 `live < 4`，真机世界恰好
             * live=4（`[-2,-3]`、`[-2,2]`、`[-3,1]`、`[2,1]` 四个碰巧对上），
             * 于是判据不触发 —— 而 `[-3,-2]`/`[-3,-1]`/`[-3,0]` 三条明明指错了，
             * 货沿着 hub 外侧纵向穿过。**「有带子放错」本身就是明确的错误**，
             * 不需要再拿总数去凑阈值。 */
            const nothingArrives = inlet.length === 0;
            if (nothingArrives && misaimed.length > 0) {
                const subj = subjectOf(handles, hub.uid, "hub");
                const mk = x => `${JSON.stringify(x.cell)}${x.handle ? `(${x.handle})` : ""}`;
                out.push({
                    code: "HUB_INLET_THIN",
                    layer: "L3",
                    severity: "blocker",
                    subject: subj,
                    expected: `hub 的 16 个入口里至少 4 个能真正收货`,
                    observed: `只有 ${live.length} 个入口能收货`
                        + (misaimed.length
                            ? `；另有 ${misaimed.length} 格上放了带子但**方向不对**（货沿着 hub 外侧流过，送不进去）：`
                              + misaimed.slice(0, 4).map(mk).join(" ")
                            : "")
                        + `。空着的入口：${allInlets.length - live.length - misaimed.length} 个。`,
                    evidence: {
                        handles: [subj.handle].filter(Boolean),
                        uids: [hub.uid],
                        tier: tierOf(hub.uid),
                        live_inlets: live.length,
                        misaimed_inlets: misaimed.slice(0, 6),
                        live_list: live.slice(0, 6),
                        total_inlets: allInlets.length,
                    },
                    candidates: ["connect", "replace_run"],
                });
            }

            /* ★ `HUB_FED_BY_COLOR` —— hub 的入口在送**颜料**，而 hub 只收**形状** ★
             *
             * 游戏源码实证（`recon/bundle.js` 的 `MetaHubBuilding._setupEntityComponent`）：
             * hub 的全部 16 个入口都写成 `filter:"shape"`：
             *
             *   for(var t=[],r=0;r<4;++r) t.push(
             *     {pos:new Vector(r,0),direction:top,   filter:"shape"},
             *     {pos:new Vector(r,3),direction:bottom,filter:"shape"},
             *     {pos:new Vector(0,r),direction:left,  filter:"shape"},
             *     {pos:new Vector(3,r),direction:right, filter:"shape"});
             *
             * 而 `ColorItem.getItemType()` 返回 `"color"`（@153912），
             * `ShapeItem.getItemType()` 返回 `"shape"`（@121252）。
             * BeltPath 的收货判据按 `slot.filter` 过滤 => **颜料永远进不了 hub**。
             *
             * 实测（真机 L12）：hub 的 4 条装有货的入口带，上面全是 `green` / `red`
             * 颜料，共 233 件排在 hub 门口进不去；而另外 5 条**本来就能收形状**的
             * 空入口一个都没人用。`delivered` 于是恒为 0 —— 不是线路断，
             * 是**送错了东西**，而且是从源头就送错了。
             *
             * 这条诊断之前不存在：代码里对此一无所知，agent 一直把颜料往 hub 送。
             *
             * 判据故意保守：只在「入口带子上确实有货，且这些货是颜料」时报。
             * 拿不到 items 信息（没有 debug_items）⇒ 不报，不猜。 */
            try {
                /* ★ `debug_items` 的真实形状（**实测，不是猜**）★
                 *
                 * `{ belts:[{cell, path, idx, pos, spacing_to_next, item}], ejectors, …, paths, counts }`
                 * —— 每行是**一件货**，`item` 是字符串键（`"green"` / `"ScSc----"`）。
                 * **没有 uid，也没有 items 数组**（见 `dist/shapez-ai-bridge.js:1119` 的 push）。
                 *
                 * 第一版按 `{belts:[{uid, items:[…]}]}` 解析，那个形状**根本不存在**：
                 * `Number(undefined)` → NaN，map 退化成 `{NaN: []}`，于是永远查不到货，
                 * 诊断一次都没触发过 —— 而整个块被 try/catch 包着，所以是**静默**失效。
                 * 这正是本项目反复出现的「算出来 ≠ 送到」，只是这次连第一段都没算对。
                 *
                 * 按 cell 分组，用 pos 取靠近出口的那一件（游戏在 acceptor 端 `items.pop()`，
                 * pos 越大越靠近出口）；不用 idx 猜顺序。 */
                const rows = (itemsDoc && Array.isArray(itemsDoc.belts)) ? itemsDoc.belts : [];
                const byCell = new Map();
                for (const r of rows) {
                    if (!r || !Array.isArray(r.cell)) continue;
                    const k = r.cell[0] + "," + r.cell[1];
                    if (!byCell.has(k)) byCell.set(k, []);
                    byCell.get(k).push(r);
                }
                const PAINT = new Set(["red", "green", "blue", "yellow", "purple", "cyan", "white"]);
                /* ★ 不要只扫 `live`（方向判对的那几条）★
                 *
                 * 第一版用 `live.map(...)`，而 `live` 只收「出口正好对着 hub、
                 * 且 hub 接受这个来向」的带子。实测的 L12 世界里 4 条送颜料的入口带
                 * **全部**不在 `live` 里（它们的来向被判成 misaimed 或干脆不进表），
                 * 于是扫不到 —— 这也是它一次没触发的原因之一。
                 *
                 * 而「入口格上放着一条带、带上是颜料」本身就是要报的事实，
                 * 与那条带方向对不对无关：方向错了照样送不进去，方向对了颜色也进不去。
                 * 所以直接从 hub 的 16 个入口格扫，不看 live/misaimed 的分类。 */
                const hubEnt = idx.ent.find(e => e && e.type === "hub");
                const inletCells = [];
                if (hubEnt) {
                    const hs2 = slotsOf("hub", hubEnt.variant, hubEnt.x, hubEnt.y, hubEnt.r || 0, beltRvOf(hubEnt));
                    for (const sl of (hs2 && Array.isArray(hs2.inputs) ? hs2.inputs : [])) inletCells.push(sl.cell);
                }
                const beltsAtInlets = inletCells.map(c => at(idx, c)).filter(e => e && isBelt(e));
                const colorHeads = [];
                for (const b of beltsAtInlets) {
                    const list = byCell.get(b.x + "," + b.y);
                    if (!Array.isArray(list) || !list.length) continue;
                    /* pos 最大 = 最靠近出口 = 正要进 hub 的那一件 */
                    const head = list.slice().sort((p, q) => (q.pos || 0) - (p.pos || 0))[0];
                    const label = head && head.item;
                    if (typeof label === "string" && PAINT.has(label)) {
                        colorHeads.push({ uid: b.uid, handle: handleOf(handles, b.uid), color: label });
                    }
                }
                if (colorHeads.length) {
                    const subj = subjectOf(handles, hub.uid, "hub");
                    const names = [...new Set(colorHeads.map(c => c.color))];
                    out.push({
                        code: "HUB_FED_BY_COLOR",
                        layer: "L3",
                        severity: "blocker",
                        subject: subj,
                        expected: `hub 的入口送的是**形状**`,
                        observed: `${colorHeads.length} 条入口带上有货，但它们是**颜料**（${names.join(" / ")}），`
                            + `而 hub 只收形状（游戏里 hub 的 16 个入口全是 filter:"shape"）。`
                            + `这些货永远进不去 —— 它们会一路顶到 hub 门口堆着。`,
                        evidence: {
                            handles: [subj.handle, ...colorHeads.map(c => c.handle)].filter(Boolean),
                            uids: [hub.uid, ...colorHeads.map(c => c.uid)],
                            tier: tierOf(hub.uid),
                            color_inlets: colorHeads.slice(0, 6),
                            colors: names,
                        },
                        candidates: ["replace_run", "remove_run", "connect"],
                        hint: `hub 的 16 个入口**只接受形状，不接受颜料** —— 这是游戏写死的`
                            + `（每个入口的 filter 都是 "shape"）。`
                            + `现在有 ${colorHeads.length} 条入口带在送 ${names.join("/")}，它们到门口会被弹回来。`
                            + `处置：把这几个入口改接**已经染好色的形状**（painter 的输出），`
                            + `颜料那一路应该接到 painter 的 color 槽，而不是 hub。`
                            /* ★ 把「怎么写」提前说出来，别等被拒之后才说 ★
                             *
                             * 实测（r-20261118210356-3d48 R5）：模型读懂了这条诊断，
                             * 名字也全对，提出了
                             *   remove_run {uids:{$uids:["B452","B454","B455","B575"]}}
                             * —— 但那 4 条是**四格互不相邻的 1 格带**，
                             * 默认的 4-邻接连续性检查直接拒：`run_not_contiguous`。
                             * 而 `allow_scattered` 的提示是在**被拒之后**才出现的，
                             * 那时 `ROUNDS_MAX=5` 已经用完，没有第 6 轮用它。
                             *
                             * 也就是说：正确做法存在、模型也想对了，只是这句话
                             * 出现得太晚了一步。诊断本来就该在这时候说。 */
                            + `**这几条入口带通常互不相邻**（各在 hub 的不同侧面），`
                            + `所以删除它们要给 \`remove_run\` 传 \`opts:{allow_scattered:true}\`，`
                            + `否则会被「4-邻接不连通」拒掉。`,
                    });
                }
            } catch (e) {
                /* ★ 「没有数据」和「解析出错」必须分开 ★
                 *
                 * 第一版这里是个光秃秃的 `catch {}`，于是 schema 猜错（`debug_items`
                 * 真实形状和代码假设的不一样）被静默吞掉 —— 诊断一次没触发，
                 * 而所有测试都是绿的，直到有人在真机上量才发现。
                 *
                 * 现在：解析异常**记一条 SHAPE_UNKNOWN**（info 级，不阻塞），
                 * 让它在诊断流里可见；没数据（itemsDoc 为空）仍然静默，
                 * 因为那确实什么都不该说。 */
                if (itemsDoc && itemsDoc.__schema_warned !== true) {
                    try {
                        out.push({
                            code: "SHAPE_UNKNOWN",
                            layer: "L3",
                            severity: "info",
                            subject: null,
                            expected: "能从 debug_items 读到带子上的货",
                            observed: `读取 debug_items 时出错：${String((e && e.message) || e)}`,
                            evidence: { stage: "hub-color-scan", error: String((e && e.message) || e) },
                            candidates: [],
                        });
                    } catch { /* 连报错都失败就算了 */ }
                }
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ④ DISCARDED_INTERMEDIATE —— 一口丢、另一口送 hub，且丢的是「有用的」形状
     * ──────────────────────────────────────────────────────────────────── */
    for (const m of idx.ent) {
        const tpl = templateByBuildingVariant(m.type, variantOf(m));
        if (!tpl || !Array.isArray(tpl.outputs) || tpl.outputs.length < 2) continue;
        if (m.type === "balancer" || m.type === "trash" || m.type === "hub") continue;
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
        if (!s) continue;

        const ports = [];
        for (const o of s.outputs) {
            const run = runEnd(idx, o.cell, o.dir);
            const dead = run.kind === "trash" || run.kind === "empty"
                || (run.kind !== "hub" && run.accepted === false);
            const toHub = run.kind === "hub" || (run.by !== null && reach.has(run.by));
            ports.push({ role: o.role, cell: o.cell, dir: o.dir, run, dead, toHub, shapes: shapesOf(engine.outValue(m, o.role)) });
        }
        for (const bad of ports) {
            if (!bad.dead || !bad.shapes.length) continue;
            const useful = bad.shapes.filter(x => hull.has(x) || model.closure.has(x));
            if (!useful.length) continue;
            const good = ports.find(p => p !== bad && p.toHub && p.shapes.length && !p.shapes.includes(goalShape));
            if (!good) continue;              // 另一口送的就是 goal ⇒ 丢另一半是正常工艺（见文件头）
            const subj = subjectOf(handles, m.uid, m.type);
            const sink = bad.run.kind === "trash"
                ? handleOf(handles, bad.run.by)
                : bad.run.kind === "empty" ? null : handleOf(handles, bad.run.by);
            const phoneme = useful.some(x => oneRotationFrom(x, goalShape));
            out.push({
                code: "DISCARDED_INTERMEDIATE",
                layer: "L4",
                severity: "blocker",
                subject: subj,
                expected: `the ${bad.role} output of ${subj.handle || m.type} is used (or the delivered half is already the goal)`,
                observed: `${m.type} splits its input into ${bad.shapes.join("/")} (${bad.role}) and `
                    + `${good.shapes.join("/")} (${good.role}); the ${bad.role} half is destroyed`
                    + `${sink ? ` by ${sink}` : ""} while the ${good.role} half is delivered, `
                    + `and ${useful.join("/")} is ${phoneme ? "one rotation away from" : "part of the recipe for"} ${goalShape}`,
                evidence: {
                    handles: [subj.handle, sink, ...good.run.belts.slice(0, 1).map(u => handleOf(handles, u))].filter(Boolean),
                    uids: [m.uid, ...(Number.isInteger(bad.run.by) ? [bad.run.by] : [])],
                    tier: reach.has(m.uid) ? 1 : 2,
                    discarded: bad.shapes,
                    sibling: good.shapes,
                    one_rotation_from_goal: phoneme,
                    discarded_port: bad.role,
                    sibling_port: good.role,
                    run_kind: bad.run.kind,
                    ...(Number.isInteger(bad.run.by) ? { sink_type: bad.run.kind } : {}),
                },
                candidates: ["replace_run", "connect"],
            });
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ⑤ SHAPE_UNKNOWN —— 显式降级（info，绝不 blocker；candidates 为空 = 不许喂给 LLM）
     *
     * 按**原因**聚合成一条：L5 没有 resources 时 8 条矿机流会各自 unknown，
     * 逐条报会把 8 条预算全吃掉。subject 取该原因下 uid 最小的那个实体。
     * ──────────────────────────────────────────────────────────────────── */
    const REASON_ORDER = ["tunnel", "no-resources", "no-ore", "unknown-op", "unverified-rotation",
        "unknown-color", "stack-incompatible", "not-a-shape", "cycle"];
    for (const reason of REASON_ORDER) {
        const g = engine.unknown.get(reason);
        if (!g || !g.uids.size) continue;
        const uids = [...g.uids].sort((a, b) => a - b);
        const uid = uids[0];
        const ent = idx.byUid.get(uid) || null;
        const subj = subjectOf(handles, uid, ent ? ent.type : null);
        out.push({
            code: "SHAPE_UNKNOWN",
            layer: "L4",
            severity: "info",
            subject: subj,
            expected: "the shape on this stream is computable",
            observed: REASON_TEXT[reason] || `shape propagation stopped (${reason})`,
            evidence: {
                handles: [subj.handle].filter(Boolean),
                uids: uids.slice(0, 4),
                tier: tierOf(uid),
                reason,
                count: uids.length,
                kinds: [...g.kinds].sort(),
            },
            candidates: [],
        });
    }

    /* ────────────────────────────────────────────────────────────────────
     * ③b DEAD_LINES —— 到不了 hub 的带子堆成了山
     *
     * 用户直接指着屏幕说「这么多废弃的路线都没有拆」。
     * 实测那一刻的世界：646 条带子里 **403 条到不了 hub**（72%）。
     *
     * `V-health` 早就在数这个数（「死带子 480」），但它只是个**健康度指标** ——
     * 判红之后既不回滚、也不产生任何可执行动作。模型每轮看着它跳红，
     * 下一轮继续铺新线。这就是「测出来了 ≠ 有人去修」。
     *
     * 判据：`hubReachable` 反推出来的集合就是「能到 hub 的实体」。
     * 不在里面、且下游也没有任何机器在吃它的带子，就是纯废。
     *
     * ⚠️ **不报单条**。403 条按每码 ≤3 的额度只会出 3 条，
     * 模型根本看不出规模。所以聚成**一条**诊断，给出总数 + 最密的三片区域。
     * 修复动作是 `remove_run` 一片一片拆，不是逐条删。
     * ──────────────────────────────────────────────────────────────────── */
    if (!o.truncated) {
        const beltsAll = idx.ent.filter(b => isBelt(b));
        if (beltsAll.length >= 40) {                 // 小世界里不值得报
            /* ★ 判据必须是「纯垃圾」，不是「所有到不了 hub 的带子」 ★
             *
             * 用户三次问「残留物什么时候修」。而这条诊断一直没触发，因为
             * 它数的是**所有**死带子 —— 实测 level 9 那 66 条死带子里：
             *
             *   · 62 条的**源头是一台机器**（59 条来自 mixer，3 条来自矿机）；
             *   · 只有 1 条两端都不接机器。
             *
             * 那 62 条是**正在施工的主干**（mixer 的紫还没接完、矿机刚放上去），
             * 删掉等于把进度倒回去 —— 正是用户强调的「不是删有用的流水线！！」。
             * 而它们占 31%，恰好低于 0.35 的阈值，于是诊断整条不出现，
             * 连那 35 条真垃圾也没人管。
             *
             * 现在只数**两端都不接机器的**：正向走到空/空、反向走到空/空。
             * 那个集合才是「拆了不会有任何损失」的。 */
            const isMachine = e => e && !isBelt(e) && e.type !== "hub" && e.type !== "underground_belt";
            const junk = [];
            for (const b of beltsAll) {
                if (reach.has(b.uid)) continue;                 // 到得了 hub ⇒ 肯定有用
                /* 反向：它的上游链上有没有机器 */
                let cur = b, backMachine = false;
                const backSeen = new Set();
                for (let i = 0; i < 80 && cur; i++) {
                    if (backSeen.has(cur.uid)) break;
                    backSeen.add(cur.uid);
                    const en = entryCellOf(cur);
                    const tIn = en ? at(idx, en) : null;
                    if (tIn && isMachine(tIn)) { backMachine = true; break; }
                    cur = (tIn && isBelt(tIn)) ? tIn : null;
                }
                if (backMachine) continue;                      // 源头是机器 ⇒ 施工中，不动
                /* 正向：它的下游链上有没有机器 */
                let fwd = b, fwdMachine = false;
                const fwdSeen = new Set();
                for (let i = 0; i < 80 && fwd; i++) {
                    if (fwdSeen.has(fwd.uid)) break;
                    fwdSeen.add(fwd.uid);
                    const ex = exitCellOf(fwd);
                    const tOut = ex ? at(idx, ex) : null;
                    if (tOut && isMachine(tOut)) { fwdMachine = true; break; }
                    fwd = (tOut && isBelt(tOut)) ? tOut : null;
                }
                if (fwdMachine) continue;                       // 通向机器 ⇒ 施工中，不动
                junk.push(b);
            }
            const dead = junk;
            const ratio = dead.length / beltsAll.length;
            /* 阈值的依据（两份实机快照的实测值）：
             *
             *   level9-mixer-obs（688 实体脏世界）: 636 带子 / 21 条纯垃圾 = 3.3%
             *   level 9 现场（清理前）:              210 带子 / 147 条纯垃圾 = 70%
             *   清理后的世界:                          70 带子 /  0 条纯垃圾
             *
             * 12 条 + 2.5% 两条都满足第一份；第三份是 0，静默。
             * 门槛不能只看比例：小世界里 2 条垃圾也是 3%，不值得占一个诊断名额；
             * 也不能只看绝对数：大世界里 20 条纯垃圾混在 5000 条里无关痛痒。
             * 两条同时满足才算「成规模」。 */
            if (dead.length >= 12 && ratio >= 0.02) {
                /* 按 12×12 聚类，给出最密的几片 —— 那片就是一轮 remove_run 的对象 */
                const buckets = new Map();
                for (const b of dead) {
                    const k = `${Math.floor(b.x / 12) * 12},${Math.floor(b.y / 12) * 12}`;
                    const rec = buckets.get(k) || { n: 0, handles: [] };
                    rec.n++;
                    if (rec.handles.length < 3) {
                        const hh = handleOf(handles, b.uid);
                        if (hh) rec.handles.push(hh);
                    }
                    buckets.set(k, rec);
                }
                const hot = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3);
                const hotHandles = hot.flatMap(([, v]) => v.handles);
                /* ★ 比例高的时候要升级成 blocker（2026-11-15 夜，L12 真机）★
                 *
                 * 原来恒为 `warn`，且优先级排最后（9）。实测 L12：
                 * 485 条带子里 **313 条是死的（65%）**，到 hub 的只有 36%。
                 *
                 * 而 agent 每轮只清理 4 条（死带子 317→313）。按这个速度清 313 条要 78 轮。
                 * 它不知道问题有多大 —— 一条 warn 排在有 8 个 blocker 的列表末尾，
                 * 模型读到的是「还有些废线，以后再说」。
                 *
                 * 65% 的脚手架不是「以后再说」，它是**当前所有尝试失败的原因**
                 * （每一次 connect 都会撞到它）。超过一半就该当 blocker 报。 */
                const heavy = ratio >= 0.5;
                out.push({
                    code: "DEAD_LINES",
                    layer: "L3",
                    severity: heavy ? "blocker" : "warn",
                    subject: subjectOf(handles, null, "belt"),
                    expected: "every belt on the map feeds something that eventually reaches the hub",
                    observed: `${dead.length} of ${beltsAll.length} belts (${Math.round(ratio * 100)}%) `
                        + `do not reach the hub — leftover scaffolding from earlier attempts, `
                        + `densest patches: ${hot.map(([k, v]) => `${k} has ${v.n}`).join("; ")}`
                        + (heavy
                            ? `. More than half the map is dead weight — this is why every new `
                              + `connection runs into something. Clear it FIRST.`
                            : ""),
                    evidence: {
                        handles: hotHandles,
                        uids: dead.slice(0, 8).map(b => b.uid),
                        dead_count: dead.length,
                        belt_count: beltsAll.length,
                        ratio: Number(ratio.toFixed(2)),
                        heavy,
                        patches: hot.map(([k, v]) => ({ at: k, belts: v.n, handles: v.handles })),
                    },
                    /* 拆废线的首要修法就是 remove_run；trash_unused 也能顺手清 */
                    candidates: ["remove_run", "trash_unused"],
                    /* ★ 提示里的宏调用必须与宏的真实签名一致 ★
                     *
                     * 这里原来写的是 `remove_run {region:$path_of([...])}` ——
                     * 而 `remove_run` 的参数是 `uids` / `cells` / `opts.*`，**没有 region**。
                     *
                     * 后果：模型照着提示写，被拒成 LLM_ARGS，然后它不会怀疑提示有错，
                     * 只会换个写法重试 —— 实测 L12 连续几轮的最后一步全耗在这上面。
                     * 诊断教一个名字、宏卡片教另一个名字，模型只能二选一猜。
                     *
                     * 现在按真实签名写。`$uids` 直接收句柄数组，正合适。 */
                    hint: `${dead.length} 条带子到不了 hub（占全部 ${Math.round(ratio * 100)}%）—— `
                        + `这是早年反复试错留下的脚手架，不拆它会让后来每一次 connect 都撞到它。`
                        + `用 \`remove_run {uids:$uids([${hotHandles.slice(0, 4).join(",")}])}\` `
                        + `一片一片拆（最密的三片：${hot.map(([k, v]) => `${k} 有 ${v.n} 条`).join("，")}）。`
                        + `**拆之前先别铺新线** —— 空间腾出来之后，正解往往只要几格。`,
                });
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ③c ORPHAN_MACHINES —— 一根带子都没接的机器
     *
     * 用户 2026-11-13 第二次指屏幕：「我的意思是这些残留物需要清理」。
     * 截图上是一整排垃圾桶和孤立的 cutter / rotater —— 一根带子都没连。
     *
     * `DEAD_LINES` 只数**带子**，完全没看机器：那一刻 57 台机器里 **45 台是孤儿**
     * （29 台矿机里有 23 台输出口空着、12 个垃圾桶大部分一个输入都没接）。
     *
     * 判据：`slotsOf` 给出该机器的全部输入/输出槽位，逐个查那格上有没有东西。
     * 两端全空 ⇒ 它永远不会运转，只是占格 + 让 connect 绕路。
     *
     * ⚠️ 不删「半接」的机器：`mixer` 常常两槽已接、输出还没铺 ——
     *    那是**半成品**，删了等于把进度倒回去。只有两端全空才算孤儿。
     * ──────────────────────────────────────────────────────────────────── */
    if (!o.truncated) {
        const machines = idx.ent.filter(e => !isBelt(e) && e.type !== "hub");
        const orphans = [];
        for (const m of machines) {
            let sl = null;
            try {
                sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
            } catch { continue; }
            if (!sl) continue;
            const ins = Array.isArray(sl.inputs) ? sl.inputs : [];
            const outs = Array.isArray(sl.outputs) ? sl.outputs : [];
            if (!ins.length && !outs.length) continue;      // 无端口的（理论上没有）
            /* ★ 两侧用**不同**的判据 ★
             *
             * 输出侧：接的带子必须**活着**（能到 hub）—— 否则这台机器的产物
             *        永远送不到终点，等同于没接。
             * 输入侧：只要格子上**有东西**就算半成品 —— 上游可能还在铺
             *        （mixer C7 正是这样：两个槽接满蓝颜料，但那条链还没通到 hub，
             *        用「活」判会把一台正在建的核心机器判成废物）。
             *
             * 两处都用「活」时，清理后的世界报出 8 台孤儿、含 mixer ——
             * 而删掉 mixer 等于把唯一的紫色来源删了。 */
            const hasBelt = (cell) => !!at(idx, cell);
            const liveOut = (cell) => {
                const t = at(idx, cell);
                if (!t) return false;
                if (!isBelt(t)) return true;              // 机对机直贴，算连着
                return reach.has(t.uid);
            };
            const inFed = ins.filter(i => hasBelt(i.cell)).length;
            const outFed = outs.filter(x => liveOut(x.cell)).length;
            /* ★ 只有「两端都空」才算真孤儿 ★
             *
             * 清理后的世界一度报出 8 台，其中一台是 `mixer C7` —— 它两个 color 槽
             * 都已经接上蓝颜料，只是输出还没铺到 painter。那是**进度**，删掉等于倒回去。
             *
             * 「有输入没输出」= 半成品，留着；「有输出没输入」= 等料，也留着
             * （矿机正是这一类，它输出接着带子就说明有人在用它）。
             * 只有两端全空，才是永远不会运转的废件。
             *
             * ★ 站在矿上的矿机**永远不算孤儿**（2026-11-16 凌晨，L12 真机）★
             *
             * 实测：agent 刚按「没人挖 blue」的提示放了 4 台蓝矿机，
             * 下一轮 `ORPHAN_MACHINES` 把它们判成孤儿，它照着建议
             * `remove_machine {uids:$uids([M2,M8,M4,M3,M7,M6])}` 一次删了 6 台 ——
             * **包括刚放上去挖 blue 的那些**。矿机从 12 台回到 6 台，blue 从 4 台回到 1 台。
             *
             * 这不是 agent 乱来：它照的是诊断的建议。而「刚放的矿机」必然两端全空
             * —— 那正是 `insert_machine` 之后、`connect` 之前的状态。
             * 「先放矿机、下一轮才接线」是这套系统唯一可行的施工顺序，
             * 判据却把中间态判成废件。删掉它等于禁止这种施工法。
             *
             * 判据：矿机脚下有矿 ⇒ 它有产出能力，迟早要接 —— 留着。 */
            const isMiner = m.type === "miner";
            let onOre = false;
            if (isMiner) {
                /* `engine` 是本函数开头就建好的形状引擎，`engine.ore` 是
                   `${x},${y}` → 矿种 的 Map（1134 行已经在用同一个）。
                   不用 `idx.__ore` —— 那是 `structural.mjs` 自己挂的，
                   在这个函数里**从来不存在**（实测 `idx.__ore instanceof Map === false`）。 */
                const ore = engine && engine.ore instanceof Map ? engine.ore : null;
                if (ore) onOre = ore.has(`${m.x},${m.y}`);
                /* 没有矿图时**保守算它在矿上** —— 宁可漏报孤儿，
                   也不能因为读不到矿图就把所有矿机删光。 */
                else onOre = true;
            }
            if (inFed === 0 && outFed === 0 && !onOre) orphans.push(m);
        }
        /* 少于 6 台不报：零星几台可能是刚放的、还没接 */
        if (orphans.length >= 6) {
            const byType = new Map();
            for (const m of orphans) byType.set(m.type, (byType.get(m.type) || 0) + 1);
            const hs = orphans.map(m => handleOf(handles, m.uid)).filter(Boolean);
            const hub0 = idx.ent.find(e => e.type === "hub");
            const far = hub0 ? orphans.filter(m => Math.abs(m.x - hub0.x) + Math.abs(m.y - hub0.y) > 40).length : 0;
            out.push({
                code: "ORPHAN_MACHINES",
                layer: "L2",
                severity: "warn",
                subject: subjectOf(handles, orphans[0].uid, orphans[0].type),
                expected: "every machine on the map has at least one belt attached",
                observed: `${orphans.length} of ${machines.length} machines have NOTHING connected `
                    + `(${[...byType].map(([t, n]) => `${t}×${n}`).join(", ")}`
                    + (far ? `; ${far} of them are more than 40 tiles from the hub` : "") + `)`,
                evidence: {
                    handles: hs,
                    uids: orphans.map(m => m.uid),
                    orphan_count: orphans.length,
                    machine_count: machines.length,
                    by_type: Object.fromEntries(byType),
                    far_from_hub: far,
                },
                candidates: ["remove_machine", "remove_run"],
                hint: `${orphans.length} 台机器一根带子都没接（${[...byType].map(([t, n]) => `${t}×${n}`).join("，")}）—— `
                    + `它们永远不会运转，只占格并让 connect 绕路。`
                    + (far ? `其中 ${far} 台离 hub 超过 40 格，更要清。` : "")
                    + `用 \`remove_machine {uids:[${hs.slice(0, 4).join(",")}...]}\` 清掉。`
                    + `**留最近的矿机和已经半接通的机器**（输入接了但输出没接的 mixer 是半成品，别删）。`,
            });
        }

        /* ★ ③c-bis MINER_UNWIRED —— 矿机站在矿上，但输出口空着 ★
         *
         * 2026-11-20 真机实测（`r-20261120194302-bc94`）撞出来的一个**诊断盲区**。
         *
         * 那一轮 `insert_machine {at:{$ore:"Cu"}, facing:left, machine:"miner"}` 成功落盘：
         * 新矿机在 `(-10,9)`，脚下正是 `CuCuCuCu`（目标需要的圆形铜矿），
         * `tx ✓ applied 3/3`、`entities 748→749`。**放得完全正确。**
         *
         * 但它四周 `(-9,9) (-11,9) (-10,8) (-10,10)` 全是空地 —— 输出口 `(-11,9)` 空着。
         * 它挖得出铜矿，送不出去，一件也到不了 hub。
         *
         * 而下一轮的诊断里**没有任何一条提到它**：
         *
         *   · `ORE_UNMINED` 消失了 —— 判据是「有没有矿机踩在含该形状的矿上」，
         *     现在有了，所以满足。它说的是**有没有人在挖**，不是**挖出来的能不能走**；
         *   · `ORPHAN_MACHINES` 也**不报** —— 那条的判据里有一句
         *     「站在矿上的矿机**永远**不算孤儿」，是 2026-11-16 为了阻止模型
         *     把刚放的矿机删掉而加的。理由当时成立（`insert_machine` 之后、
         *     `connect` 之前必然两端全空），但它把这一类**彻底豁免**了。
         *
         * 于是「矿机已就位、只差接线」这个状态没有任何诊断覆盖 ——
         * 而它恰恰是这套系统**唯一可行的施工顺序**的中间态。
         *
         * 判据：矿机 + 脚下有矿 + 输出口那格是空的。
         * 与 `ORPHAN_MACHINES` 的分工：那条管「删」，这条管「接」。
         * 与 `ORE_UNMINED` 的分工：那条管「该不该挖」，这条管「挖了送不送得出去」。 */
        {
            const unwired = [];
            for (const m of idx.ent) {
                if (m.type !== "miner") continue;
                const ore = engine && engine.ore instanceof Map ? engine.ore : null;
                if (ore && !ore.has(`${m.x},${m.y}`)) continue;      // 不在矿上 ⇒ 另一条诊断的事
                let sl = null;
                try {
                    sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
                } catch { continue; }
                const outs = (sl && Array.isArray(sl.outputs)) ? sl.outputs : [];
                if (!outs.length) continue;
                /* 输出口全空 = 挖得出来但送不出去。有一格接了就不算（可能还在铺）。 */
                if (outs.every(x => !at(idx, x.cell))) {
                    unwired.push({ miner: m, cell: outs[0].cell });
                }
            }
            if (unwired.length) {
                const hs = unwired.map(u => handleOf(handles, u.miner.uid)).filter(Boolean);
                out.push({
                    code: "MINER_UNWIRED",
                    layer: "L2",
                    severity: "warn",
                    subject: subjectOf(handles, unwired[0].miner.uid, "miner"),
                    expected: "a miner standing on ore has a belt at its output so what it digs can travel",
                    observed: `${unwired.length} miner(s) stand on ore but their output cell is empty — `
                        + `they dig, and nothing carries it away`,
                    evidence: {
                        handles: hs,
                        uids: unwired.map(u => u.miner.uid),
                        /* 落点坐标是允许出现在**证据**里的（与 `site_cells` 同一条纪律：
                           `assertNoHumanCoords` 管的是 LLM 的**输出**，不是喂给它的材料）。 */
                        out_cells: unwired.slice(0, 6).map(u => u.cell),
                        unwired_count: unwired.length,
                    },
                    candidates: ["connect", "insert_machine"],
                    hint: `${unwired.length} 台矿机已经踩在矿上了，但输出口那格是空的 —— `
                        + `**挖得出来、送不出去**，一件都到不了 hub。`
                        + `接线：\`connect {from:{ref:"${hs[0] || "M1"}"}, to:<下游>}\`，`
                        + `或者先铺一段带子再连进已有的链。`
                        + `**别拆它们** —— 位置是对的，缺的只是一条线。`,
                });
            }
        }

        /* ★ ③c-quater OUTPUT_STRANDED —— 机器在跑，但某个输出口悬空 ★
         *
         * 2026-11-21 真机：`C2 cutter` 堵了**十个 run**，而 `diagnose()` 的 8 条诊断
         * 里一条都没提它。它的 `left` 口接着 `B104` 通向 painter，`right` 口在
         * `(-6,10)` 悬空 —— 它一直在切，一半产物没有去处。
         *
         * ## 为什么现有诊断都照不到
         *
         *   · `ORPHAN_MACHINES` 只认「**两端全空**」，通了一端就不算孤儿。
         *     那个豁免是有理由的（mixer 常见两槽已接、输出还没铺），
         *     但它把「一端通、一端堵」这一类**整体**漏掉了。
         *   · `DISCARDED_INTERMEDIATE` 要求被丢的那口形状 ∈ orbit(goal) ∪ 闭包。
         *     而 C2 是上一关遗留线，切出来的形状不在 L12 的闭包里 ⇒ 不报。
         *   · `OUTPUT_UNROUTED` 只检查**计划里**的机器，不看世界现状。
         *
         * ## 判据
         *
         * 机器满足全部三条才算：
         *   ① **至少有一个输入口接着东西** —— 它在跑，不是空壳
         *   ② **至少有一个输出口是空的** —— 有产物没去处
         *   ③ 不是矿机 —— 矿机那条已由 `MINER_UNWIRED` 专门管
         *
         * ①② 合起来的语义是「它在生产，而产品堵在里面」。
         * 这正是会造成「上游越堆越满、下游永远空着」的那种堵塞。
         *
         * ⚠️ 不算「全空」的机器：那是 `ORPHAN_MACHINES` 的地盘，
         *    两边都报会让模型在同一台机器上收到两条互相矛盾的指令
         *    （一条说「删掉」，一条说「接上」）。 */
        if (!o.truncated) {
            const stranded = [];
            for (const m of idx.ent) {
                if (isBelt(m) || m.type === "hub" || m.type === "miner" || m.type === "trash") continue;
                /* ★ `balancer` 不算 ★
                 *
                 * 分流器**天然**会有一半输出空着 —— 那是它的设计（把一路货分到两路），
                 * 不是故障。L4 夹具上第一版报了 5 台，全是 balancer，
                 * 而它们一条问题都没有。
                 *
                 * 报告一堆不是问题的问题，比不报更糟：模型会去「修」正常的机器，
                 * 而真正堵住的那台排在后面。 */
                if (m.type === "balancer") continue;
                let sl = null;
                try { sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m)); } catch { continue; }
                if (!sl) continue;
                const ins = Array.isArray(sl.inputs) ? sl.inputs : [];
                const outs = Array.isArray(sl.outputs) ? sl.outputs : [];
                if (!ins.length || !outs.length) continue;
                const fedIns = ins.filter(i => !!at(idx, i.cell)).length;
                const deadOuts = outs.filter(x => !at(idx, x.cell));
                if (fedIns === 0) continue;                 // 空壳 ⇒ ORPHAN_MACHINES
                if (deadOuts.length === 0) continue;        // 全接好了
                if (deadOuts.length === outs.length && fedIns === 0) continue;
                stranded.push({ m, fedIns, totalIn: ins.length, deadOuts, totalOut: outs.length });
            }
            if (stranded.length) {
                /* 优先报「完全堵死」的（所有输出口都悬空），其次按输入接通比例 */
                stranded.sort((a, b) => (b.deadOuts.length / b.totalOut) - (a.deadOuts.length / a.totalOut));
                const hs = stranded.map(s => handleOf(handles, s.m.uid)).filter(Boolean);
                const worst = stranded[0];
                const detail = stranded.slice(0, 4).map(s =>
                    `${s.m.type}#${s.m.uid}(${s.deadOuts.length}/${s.totalOut} 口悬空)`).join("；");
                const wHandle = handleOf(handles, worst.m.uid) || "?";
                out.push({
                    code: "OUTPUT_STRANDED",
                    layer: "L2",
                    severity: "warn",
                    subject: subjectOf(handles, worst.m.uid, worst.m.type),
                    expected: `机器在产出时，每个输出口都有去处`,
                    observed: `${stranded.length} 台机器在跑、但有输出口悬空：${detail}`,
                    handles: hs,
                    uids: stranded.map(s => s.m.uid),
                    evidence: {
                        handles: hs,
                        uids: stranded.map(s => s.m.uid),
                        stranded: stranded.slice(0, 6).map(s => ({
                            type: s.m.type, uid: s.m.uid,
                            fed_inputs: s.fedIns, total_inputs: s.totalIn,
                            dead_outputs: s.deadOuts.length, total_outputs: s.totalOut,
                        })),
                        note: "a machine whose input is wired but whose output has nowhere to go "
                            + "runs forever and piles its product up inside — upstream backs up, downstream starves",
                    },
                    candidates: ["connect", "trash_unused", "remove_machine"],
                    hint: `**${worst.m.type}#${worst.m.uid}（句柄 ${wHandle}）在跑，但 ${worst.deadOuts.length} 个输出口悬空**`
                        + ` —— 它切/加工出来的东西有一半没有去处，会一直堆在机器里，`
                        + `上游跟着堵死。三选一：`
                        + `\`connect\` 接到下游；\`trash_unused\` 把不要的那一路吃掉；`
                        + `或者这条线本来就该拆，\`remove_machine\` 整台移走。`
                        + (stranded.length > 1 ? `这台处理完再看另外 ${stranded.length - 1} 台。` : ""),
                });
            }
        }

        /* ★ ③c-ter MACHINE_STARVED —— 加工机器缺一路进料，整条链冻住 ★
         *
         * 2026-11-21。6 个 Agent 并行调查（`.findings/CONCLUSION.md`）挖出的
         * **L12 交付恒为 0 的真正根因**。这条诊断比任何症状码都更接近成因。
         *
         * ## 死锁链
         *
         *     painter#13552 的 color 槽 approach (-4,15) 是空格   ← 唯一断点
         *       → painter 不喷漆 → 16 格进料竖列全空
         *       → stacker#14684 两路进料只来一路（inputsPerCharge: 2）
         *       → 攒不满 2 件 → 不吐货
         *       → rotater → belt#15000 → hub 入口 #2 这条拓扑完美的通路永远空着
         *       → 上游 259 件货塞满 165 格带（98.9%）
         *       → miner 出料口堵死，19/19 ejector progress=1.0
         *       → itemProduced 不触发 → 整图 1000 秒零产出
         *
         * **一个空格，冻住整座工厂。**
         *
         * ## 为什么现有诊断都看不见它
         *
         *   · `NO_PRODUCTION` 只说「没有产出」——那是**结果**，不是原因；
         *   · `CHAIN_UNFED` / `BELT_HANDOFF_REJECTED` 说的是**带子**层面
         *     （某条带的入口没上游），而这里带子都接好了，断在**机器的槽**；
         *   · `MIXER_COLOR_AIMED` 只管 mixer 的 color 槽，不管 painter/stacker/cutter；
         *   · `PROCESSOR_REQUIRED` 按**配方计数**（配方要 1 台 painter、有 2 台 ⇒ 够），
         *     不看**这台机器当前吃不吃得到料**。
         *
         * ## 判据
         *
         * 对每台多输入机器（stacker / mixer / painter / painterDouble / cutter 的双输入）：
         *   某个输入槽的 approach 格上**没有货**，且该格**本来就没有可用的来料**
         *   （空格，或者有带子但那条带上没货）。
         *
         * 与 `MIXER_COLOR_AIMED` 的分工：那条专门看 mixer 的 color 槽**朝向对不对**；
         * 这条看**所有**多输入机器的**料够不够**。mixer 两条都报时以 `MIXER_COLOR_AIMED`
         * 为准（它有更具体的修法），所以这里跳过 mixer。
         *
         * ⚠️ 只在「至少有一路有料、至少一路没料」时报 —— 两路全空是**上游没建好**，
         *    那属于 `CHAIN_UNFED` 的地盘，报这条会误导模型去修错的地方。 */
        {
            const MULTI_IN = new Set(["stacker", "painter", "painterDouble"]);
            const starved = [];
            /* 「这格有没有料」：先看格上有没有实体，再看那条带子上有没有货。
               `itemsDoc` 可能为 null（离线/没读 debug_items），那时只判「格上有东西」。 */
            const cellHasCargo = (cell) => {
                const rec = at(idx, cell);
                if (!rec) return false;
                if (!isBelt(rec) && rec.type !== "underground_belt") return true;  // 机对机直贴
                if (!itemsDoc) return true;      // 没有 items 数据时，有带子就算有料（不猜）
                const list = Array.isArray(itemsDoc.belts) ? itemsDoc.belts : [];
                const k = cell[0] + "," + cell[1];
                return list.some(r => r && Array.isArray(r.cell) && (r.cell[0] + "," + r.cell[1]) === k);
            };
            for (const m of idx.ent) {
                if (!MULTI_IN.has(m.type)) continue;
                let sl = null;
                try { sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m)); } catch { continue; }
                const ins = (sl && Array.isArray(sl.inputs)) ? sl.inputs : [];
                if (ins.length < 2) continue;
                /* 槽的 `role` 必须带上 —— 它决定「什么能填这个槽」：
                 * `color` 槽只能吃颜料，`shape`/`primary` 吃形状。
                 * 第一版没带，下游只能用纯几何筛源头，于是给 `color` 槽
                 * 推荐了一台 cutter（最近的，但产物是形状，接上去一点用没有）。 */
                const fed = ins.map(i => ({ cell: i.cell, ok: cellHasCargo(i.cell), role: i.role || "" }));
                const nFed = fed.filter(f => f.ok).length;
                /* 只报「部分缺料」：全空交给 CHAIN_UNFED，全满不该报 */
                if (nFed > 0 && nFed < fed.length) {
                    starved.push({ m, fed, nFed, total: fed.length });
                }
            }
            if (starved.length) {
                /* ★ 排序：**上游的那台排第一**，不是下游的（2026-11-21 实测修正）★
                 *
                 * 第一版按「离 hub 近」排（用 `hubReachable` 当代理），结果把
                 * `stacker#14684` 排到了第一。**那是错的**，实测追出来的链条是：
                 *
                 *     painter#13552 输出 (-5,16)
                 *       → belt#14977@(-5,16) → 14978..14992（16 格竖列）
                 *       → stacker#14684 的进料格 (-2,6)     ← stacker 缺的正是这一路
                 *
                 * 也就是说 **painter 才是根**，stacker 只是它下游的第一个受害者。
                 * 修 stacker 是治不了根的 —— 它缺的那路料，源头就是 painter。
                 *
                 * 正确的判据：**在「缺料机器」这张图里，谁的输出通向谁**。
                 * 谁没有「缺料机器」给它供料，谁就是根。
                 *
                 * 具体做法（不建整图，只建这 N 台之间的关系，N 通常 ≤ 6）：
                 *   从每台机器缺料的那些格子出发，向上游走带子，
                 *   看能不能走到另一台「缺料机器」的输出。能，说明它在上游。
                 *
                 * 排序：**上游的排前面**（根先修）。同档按 uid 保证确定性。
                 *
                 * ⚠️ 没有 items 数据或走不通时，退回扫描顺序 —— 不假装知道更多。 */
                const starvedUids = new Set(starved.map(s => s.m.uid));
                const outCellsOf = (m) => {
                    try {
                        const sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
                        return (sl && Array.isArray(sl.outputs)) ? sl.outputs.map(o => o.cell) : [];
                    } catch { return []; }
                };
                /* 从某格向上游走，看能否遇到一台「缺料机器」的输出格 */
                const upstreamStarved = (startCell) => {
                    const seen = new Set();
                    let cell = startCell;
                    for (let hop = 0; hop < 40; hop++) {
                        const rec = at(idx, cell);
                        if (!rec || !isBelt(rec)) break;
                        if (seen.has(rec.uid)) break;          // 环
                        seen.add(rec.uid);
                        const up = entryCellOf(rec);
                        const upRec = at(idx, up);
                        if (!upRec) break;                     // 走到空地 = 断口
                        if (!isBelt(upRec)) {
                            /* 走到一台机器：它是不是「缺料机器」之一？ */
                            return starvedUids.has(upRec.uid) ? upRec : null;
                        }
                        cell = up;
                    }
                    return null;
                };
                /* 「我是谁的上游」—— 我的输出格能被谁向上追到 */
                const feedsAnotherStarved = (s) => {
                    const mine = new Set(outCellsOf(s.m).map(c => c[0] + "," + c[1]));
                    if (!mine.size) return false;
                    for (const other of starved) {
                        if (other.m.uid === s.m.uid) continue;
                        for (const f of other.fed) {
                            if (f.ok) continue;                // 只看它缺的那几路
                            const src = upstreamStarved(f.cell);
                            if (src && src.uid === s.m.uid) return true;
                        }
                    }
                    return false;
                };
                starved.sort((a, b) => {
                    const fa = feedsAnotherStarved(a) ? 0 : 1;   // 供给别的缺料机器 ⇒ 它在更上游
                    const fb = feedsAnotherStarved(b) ? 0 : 1;
                    if (fa !== fb) return fa - fb;               // 上游的排前面（根先修）
                    return a.m.uid - b.m.uid;
                });
                const worst = starved[0];
                const hs = starved.map(s => handleOf(handles, s.m.uid)).filter(Boolean);
                /* ★ 缺的是**哪个槽**，必须说出来（2026-11-25，真调 LLM 77:0 实测）★
                 *
                 * 旧版这里写 `缺 ${JSON.stringify(f.cell)}` —— 一个坐标。
                 * 而 `sanitize()` 会把坐标打成 `<coord>`，所以模型看到的是
                 * **`缺 [<coord>]`**：一个既看不懂、又不含角色名的东西。
                 *
                 * 实测（`.findings/C4-UPPER-WALL-2026-11-25.md`，192 条真调样本）：
                 *
                 *   目标是 C4 的提案：83 次
                 *     port=upper:  77
                 *     port=lower:   0     ← 一次都没有
                 *
                 * 因为 `## MACHINES` 那行给了两个候选（`lower@bottom(←B133)` /
                 * `upper@bottom(←B90)`，**两个都标着已接**），图例又说
                 * `port=a|b ⇒ must name one` 逼它二选一，而**没有任何一句说缺的是 lower**。
                 *
                 * 它只能猜 —— 而 hint 里「最靠**上游**」是它唯一能抓的线索，
                 * 「上游」(upstream) 和 `upper` 在中文模型里高度混淆
                 * （`why` 里提到 "上游/upstream" 44/77，提到 "upper" 字面 18/77）。
                 * **模型脑子里装的是「上游」，写出来的是 `upper`。**
                 *
                 * 对照：历史上 `SLOT_STARVED` 明说「lower 空着」时，模型立刻写了
                 * `port:"lower"` 并落地。⇒ **它会读角色名，问题是这次诊断没给。**
                 *
                 * 所以这里给出角色名而不是坐标：**更短、且含信息**。 */
                const detail = starved.map(s => {
                    const empty = s.fed.filter(f => !f.ok)
                        .map(f => (f.role ? `${f.role}槽` : JSON.stringify(f.cell)))
                        .join("/");
                    return `${s.m.type}#${s.m.uid}(${s.nFed}/${s.total}，缺 ${empty})`;
                }).join("；");
                /* ★ 谁最便宜地能填这个槽 ★
                 *
                 * ## 为什么需要（2026-11-21 真机验证的直接结论）
                 *
                 * 这条诊断能说出「painter C3 的 color 槽空」，模型也确实 9/10 选中了它
                 * （hint 带句柄那次 A/B）。但**选中端点 ≠ 能落地**：`replay-plan.mjs`
                 * 实测 30 个样本里「命中根因 9/10、真能落地 1/10」。
                 *
                 * 被闸门拒的那 9 个，绝大多数不是路径挑得差，而是**源头选错** ——
                 * 挑了一台 60 格外、路线横穿主干道的矿机。同一份世界上到 `C3.color`
                 * 的真实成本表是：
                 *
                 *   C8 (mixer)  16 格 / 拆 2 条   ← 已在产线上，产物就是颜料
                 *   M17          14 格 / 拆 1 条   ← 最便宜，但踩的是形状矿
                 *   M13/M15     29/30 格 / 拆 1 条  ← 绿矿，矿种对
                 *   M7/M14/M16  66~70 格 / 拆 3 条  ← 蓝矿，全是远路
                 *
                 * `MACHINE_STARVED` 只说「接上缺的那一路」，模型没有任何依据在这些
                 * 之间做选择 —— 它看不到距离，也看不到「拆几条」。这是
                 * `computed-but-never-delivered` 的又一形态：宏算得出代价，
                 * 但**闸门只在事后拒**，模型事前拿不到。
                 *
                 * ## 只给「输出口空闲」的机器，不猜矿种语义
                 *
                 * 判据只做两件事：① 输出口没被占；② 到缺料格的曼哈顿距离。
                 * **不判断「这台机器产的是不是对的颜色」** —— 那是模型该做的判断，
                 * 而且 `## MACHINES` 段已经标了每台矿机采什么（`采green`）。
                 * 这里越权会给错方向，而错方向比没方向更贵。
                 *
                 * 最多 3 台，按距离排。 */
                /* 颜色上下文要带出 IIFE，供 evidence 与渲染使用。
                   用外层变量而不是改 IIFE 返回类型 —— 那个返回值已经被
                   `slice(0,3)` 定形，动它会牵动渲染侧。 */
                let feedColor = null;
                const feedSources = (() => {
                    try {
                        const target = starved[0];
                        const missSlotIdx = target.fed.findIndex(f => !f.ok);
                        const missCell = (target.fed[missSlotIdx] || {}).cell;
                        if (!Array.isArray(missCell)) return [];
                        /* 缺的是哪个角色的槽 —— 用它来筛「产物类型对得上」的源头。
                         *
                         * 这是第一版踩出来的：纯按距离排，`color` 槽的第一名是
                         * `C2`（cutter，7 格）。cutter 输出的是**形状**，接到 pigment
                         * 槽上一个像素都不会变色 —— 而它距离最近，看起来最"便宜"。
                         *
                         * 给模型一条**语义上不可能成功**的建议，比不给更糟：
                         * 它会照着接，然后下一轮发现自己白干。
                         * 一个错误的指路比没有指路贵得多。 */
                        const missRole = (target.fed[missSlotIdx] || {}).role || "";
                        const wantsColor = /color/i.test(missRole);
                        /* ★ 目标需要哪些**颜色**，以及地图上有没有那种颜料矿 ★
                         *
                         * 2026-11-21 真机端到端（`r-20261121190439-6190`）挖到的
                         * 最深一层缺陷：`feed_sources` 推荐 M13（**绿**矿），
                         * 模型照接、货真的流起来了、hub 真的入库了 ——
                         * **但产出的是 `CgScScCg`（上一关 L11 的目标形状）**。
                         *
                         * 目标是 `CbCbCbRb:CwCwCwCw`，需要 **blue + white**；
                         * 而这份地图的颜料矿只有 blue / green / red，**没有 white**
                         * （white 必须靠 mixer 级联合成）。
                         *
                         * 也就是说：我的判据是「能不能产**某种**颜料」，
                         * 而需要的是「能不能产**需要的那种**颜料」。
                         * 这两件事差着一整个关卡。
                         *
                         * 现在：从目标形状解出色码，只推荐产这些颜色的源头；
                         * 若某个颜色**地图上根本没有矿**，那它只能靠 mixer ——
                         * 这时 mixer 才是最该推荐的（哪怕它更远）。 */
                        /* 复用函数级那一份 —— 这两处原来各算一遍，其中一份还写错了
                           （TDZ 引用后声明变量，异常被外层 catch 吞掉，feed_sources 静默变空）。
                           见 `semanticDiagnoses` 开头 `mustMixShared` 的注释。 */
                        const WANT = wantColorsShared;
                        const mapPigments = mapPigmentsShared;
                        const mustMix = mustMixShared;
                        /* ⚠️ `o` 必须先声明：下面的 `oreAtCell` 读 `o.resources`。
                           第一版把这两行放在 `const o = unwrapObs(obs)` 之前，
                           触发 TDZ（`Cannot access 'o' before initialization`），
                           而整个块包在 `try/catch` 里 —— 异常被吞掉，`feed_sources`
                           静默变成 `[]`，没有任何报错。 */
                        const o = unwrapObs(obs);
                        const ixd = indexOf(o);
                        /* 颜料矿的矿种是**纯小写单词**（`blue` / `green` / `red`…）；
                        * 形状矿是 `CuCuCuCu` 那种大写开头的码。矿机在形状矿上时
                        * 挖出来的是**形状**，喂 `color` 槽一个像素都不会变色。
                        *
                        * 第一版只判 `e.type === "miner"` 就放行，于是把 `M17`
                        * （踩 `CuCuCuCu`、距离 12 格最近）排到了第一位 —— 又是一条
                        * 「看起来最便宜但语义上不可能成功」的建议。 */
                        const oreAtCell = (() => {
                            const list = o && Array.isArray(o.resources) ? o.resources : null;
                            if (!list) return null;
                            const m = new Map();
                            for (const r of list) if (Array.isArray(r) && r.length >= 3) m.set(`${r[0]},${r[1]}`, r[2]);
                            return m;
                        })();
                        const minerOre = (e) => (oreAtCell ? oreAtCell.get(`${e.x},${e.y}`) : null);
                        const isPigmentOre = (kind) => typeof kind === "string" && /^[a-z]+$/.test(kind);
                        const rows = [];
                        for (const e of (o.entities || [])) {
                            if (!e || e.uid === target.m.uid) continue;
                            if (e.type === "belt" || e.type === "underground_belt" || e.type === "hub") continue;
                            /* 输出口必须空闲 —— 用既有的 slotsOf，不自己算朝向 */
                            let slots = null;
                            try { slots = slotsOf(e.type, e.variant || "default", e.x, e.y, e.r || 0, beltRvOf(e)); }
                            catch { slots = null; }
                            if (!slots || !slots.outputs || !slots.outputs.length) continue;
                            /* ★ 「输出口空闲」必须按 `connect` 的口径判，不是「格子上有没有东西」★
                             *
                             * 2026-11-21 验证 agent 抓到的真缺陷：原来的判据是
                             * `slots.outputs.some(sl => !at(ixd, sl.cell))` —— 输出格上
                             * **有任何实体**就算「被占」。
                             *
                             * 而 `connect` 判的是另一件事：`portBoundKind` 检查
                             * **那条带子是不是流进这台机器**（`beltEntry === OPP[port.face]`）。
                             * 一条从输出格**往外流**的带子完全不挡连接 —— 那正是这台机器
                             * 已经在用的出料带，`connect` 会沿着它继续铺。
                             *
                             * 实测（L12）：`C8`（mixer）的输出格上有一条 `belt#14827`
                             * 正往外流，旧判据把它判成「已占用」排除了。
                             * 而 `connect C8→C3.color` 实际 16 格/切 2 条，
                             * 连 `allow_replace:false` 都能过，闸门 18 ops 直接落地 ——
                             * **它是这份世界上第二便宜的可行源头，却从来没进过推荐列表。**
                             *
                             * 更糟的是我给它写了条测试断言「输出口被占的机器不该被推荐」，
                             * 把 bug 锁进了测试。判据错了，测试跟着错，两边互相印证。
                             * （`check-own-metric-before-concluding` 的又一形态。） */
                            const free = slots.outputs.some(sl => {
                                const occupied = at(ixd, sl.cell);
                                if (!occupied) return true;                 // 空格 ⇒ 空闲
                                if (occupied.type !== "belt" && occupied.type !== "underground_belt") return false;
                                /* 格上有带子：只有它**流向本机**才算占。
                                   带子的 entry 面朝向本机 ⇒ 货在往机器里灌 ⇒ 这个输出口已经被接走了。 */
                                const rv = typeof occupied.rotation_variant === "number"
                                    ? occupied.rotation_variant
                                    : Math.max(0, ((occupied.code | 0) - 1));
                                const entry = beltEntry(rv, occupied.r | 0);
                                /* `sl.dir` 是「机器 → 外侧」；带子从外面看进来方向相反 */
                                return !(entry === OPP[sl.dir]);
                            });
                            if (!free) continue;
                            /* 喂 `color` 槽只能用「产**目标需要的**颜料」的机器。
                             *
                             * 判据从「能不能产某种颜料」收紧成「能不能产需要的那种」
                             * —— 真机实测这两者差着一整个关卡：旧判据推荐了绿矿，
                             * 产出 `CgScScCg`（L11 的目标），而这一关要 blue+white。 */
                            if (wantsColor) {
                                let ok = false;
                                if (e.type === "mixer" || e.type === "painter"
                                    || e.type === "painterDouble" || e.type === "painterQuad") {
                                    /* mixer/painter 的产物颜色取决于它的**输入**，这里判不出来，
                                       但它至少是「能合成颜色」的机器 —— 留着，交给模型判断。
                                       若目标里有颜色必须靠合成（`mustMix` 非空），它更重要。 */
                                    ok = true;
                                } else if (e.type === "miner" && isPigmentOre(minerOre(e))) {
                                    /* 矿机：**采的颜色必须是目标要的**。
                                       地图上没有目标颜色时不推荐任何矿机 —— 它们产的都不对。 */
                                    const oreName = minerOre(e);
                                    ok = WANT.size ? WANT.has(oreName) : true;
                                }
                                if (!ok) continue;
                            }
                            const d = Math.abs(e.x - missCell[0]) + Math.abs(e.y - missCell[1]);
                            rows.push({ handle: handleOf(handles, e.uid), type: e.type, d, mustMix: e.type === "mixer" });
                        }
                        rows.sort((a, b) => a.d - b.d);
                        /* ★ 对前几名补算「接过去会切断多少东西」★
                         *
                         * 距离和矿种都不足以预测「这条接法能不能过预演闸门」。
                         * 实测（L12，到 `C3.color`）：
                         *
                         *   M13 绿 29格/拆1 → 落地   M11 绿 120格/拆1 → **拒**
                         *   M15 绿 30格/拆1 → 落地
                         *   M14 蓝 68格/拆3 → 拒      M7  蓝 70格/拆3 → 拒
                         *
                         * 「拆几条」也不准 —— M11 只拆 1 条却被拒（loss=24）。
                         *
                         * 真正准的是 `connect` 自己已经算好的 `consequences.would_disconnect`
                         * （覆盖这条路径会让多少下游断供）：
                         *
                         *   M13 0 → 落地    M15 0 → 落地
                         *   M14 3 / M16 3 / M7 3 / M9 3 / M11 1 → 全拒
                         *
                         * **0 与非 0 完美分开。**
                         *
                         * ⚠️ 但「按距离取前 N 名再算」是**错的**（2026-11-21 验证 agent 抓到的）：
                         *
                         * 这份世界上完整的合格候选（颜料类型对 + 输出口空闲）按距离排是
                         *
                         *   C8(14) M4(19) M3(20) M2(21) **M13(27) M15(28)** M14(64) …
                         *
                         * 而能落地的只有 **M13/M15** —— 它们排第 5、6 位，
                         * 按距离取前 4 名**永远看不到它们**。排序依据的数据
                         * 本身是从距离预筛出来的，这是个先有鸡还是先有蛋的问题。
                         *
                         * 解法：**先对全部合格候选算 `cut`（拆几条），按 `cut` 升序取前 6 名
                         * 再算 `disconnect`**。实测 `cut` 与能否落地相关性虽不完美
                         * （M11 只拆 1 条却被拒），但它能把「拆 3 条的远路」整批排到后面，
                         * 而 M13/M15（cut=1）自然浮上来。
                         *
                         * 代价：全量 connect 约 2.6 秒，genuine diagnose 会到 5 秒级。
                         * 权衡：诊断每轮跑一次，而**推荐错源头要浪费一整轮 + 一次模型调用**。
                         * 5 秒远小于一轮的模型延迟。
                         */
                        /* 对**全部**合格候选跑一次 connect，同时拿到 `cut` 与 `disconnect`。
                         * 不做两轮 —— `consequences` 本来就在同一次返回值里。 */
                        for (const r of rows) {
                            try {
                                const ent = (o.entities || []).find(e => handleOf(handles, e.uid) === r.handle);
                                if (!ent) continue;
                                const res = planConnect(
                                    { from: { uid: ent.uid }, to: { uid: target.m.uid, port: { role: target.fed[missSlotIdx].role, index: 0 } },
                                      opts: { allow_replace: true, prefer: "cheapest" } },
                                    { entities: o.entities },
                                );
                                if (res && res.ok) {
                                    r.cells = res.cells ? res.cells.length : null;
                                    r.cut = Array.isArray(res.changed && res.changed.removed_uids)
                                        ? res.changed.removed_uids.length : 0;
                                    const c = res.consequences;
                                    r.disconnect = c && Array.isArray(c.would_disconnect) ? c.would_disconnect.length : null;
                                }
                            } catch { /* 单台算不出来不影响其它 */ }
                        }
                        const ranked = rows.slice().sort((a, b) => {
                            const ca = typeof a.cut === "number" ? a.cut : 99;
                            const cb = typeof b.cut === "number" ? b.cut : 99;
                            if (ca !== cb) return ca - cb;
                            return a.d - b.d;
                        });
                        const topN = ranked.slice(0, 3);
                        /* ★ 排序：`disconnect === 0` 排最前，同档里按距离 ★
                         *
                         * ⚠️ `disconnect` **只有「等于 0」这一层信息**，不能按数值大小分档。
                         *
                         * 第一版分成 0 / null / >0 三档，结果把 `C8`（disc=1，14 格）
                         * 排到了 `M13`（disc=0，27 格）前面 —— 而实测 C8 和 M13 都能落地，
                         * 真正的问题是那样排序会把**能落地的那两台挤出前 3 名**。
                         *
                         * 验证 agent 的数据说得更清楚：
                         *
                         *   `disc=0 ⇒ 落地`   2/2  ✅ 成立
                         *   `disc>0 ⇒ 被拒`   2/6  ❌ **不成立**
                         *     —— C8 和 M17 都是 disc=1，两个都落地
                         *
                         * 所以它是**充分不必要**信号：0 说明「安全」，
                         * 非 0 只说明「要小心」，不能拿来排序谁更差。
                         *
                         * 最终排序：**`disconnect === 0` 优先，然后按 `cut` 再按距离**。
                         * `disc=0` 是唯一能保证「能落地」的信号，必须排最前。
                         *
                         * ★ 但「能落地」不等于「有用」★
                         * 真机 `r-20261121190439-6190`：推荐 M13（绿矿），
                         * 模型照着接，**tx 成功、货真的流了、hub 真的入库 9 件** ——
                         * 而产出的是 `CgScScCg`（L11 的目标），这一关要的是
                         * `CbCbCbRb:CwCwCwCw`（blue + white）。
                         * 修好了机制，产出了错的东西。
                         *
                         * 所以当目标里有颜色**必须靠 mixer 合成**时（`mustMix` 非空），
                         * mixer 要排到矿机前面 —— 它才是唯一能造出那个颜色的机器。
                         * 这一条排在 `disconnect` 之前：一条能落地但产出错误形状的路，
                         * 比一条会切断几处下游但方向正确的路更糟。 */
                        rows.sort((a, b) => {
                            const ma = mustMix.length && a.mustMix ? 0 : 1;
                            const mb = mustMix.length && b.mustMix ? 0 : 1;
                            if (ma !== mb) return ma - mb;
                            const za = a.disconnect === 0 ? 0 : 1;
                            const zb = b.disconnect === 0 ? 0 : 1;
                            if (za !== zb) return za - zb;
                            const ca = typeof a.cut === "number" ? a.cut : 99;
                            const cb = typeof b.cut === "number" ? b.cut : 99;
                            if (ca !== cb) return ca - cb;
                            return a.d - b.d;
                        });
                        /* 把颜色上下文带出去（见 `feedColor` 的声明处）。 */
                        if (wantsColor) {
                            feedColor = {
                                want: [...WANT],
                                on_map: mapPigments ? [...mapPigments] : null,
                                must_mix: mustMix,
                            };
                        }
                        return rows.filter(r => r.handle).slice(0, 3);
                    } catch { return []; }
                })();
                /* ★ 缺的槽名，在 hint 里直接写出来（2026-11-25）★
                 *
                 * 见下面 `detail` 与 `slot` 两处的长注释：77:0 的实测证明
                 * 不写角色名模型只能猜，而它 100% 猜错（全选 `upper`）。
                 * 这里算一次，供 `slot` / `hint` 两处共用。 */
                const worstMissRoles = worst.fed.filter(f => !f.ok).map(f => f.role || "").filter(Boolean);
                const missRole = worstMissRoles[0] || "";
                out.push({
                    code: "MACHINE_STARVED",
                    layer: "L4",
                    severity: "blocker",
                    subject: subjectOf(handles, worst.m.uid, worst.m.type),
                    /* ★ 缺的是哪个槽 —— 直接渲染进标题行（2026-11-25）★
                     *
                     * `prompt.mjs:2803` 的 `@${d.slot.role}` 从造出来就是死代码：
                     * 全 run 24 条诊断里 `.slot` 出现 **0 次**。这里把它填上，
                     * 标题行会变成 `1. MACHINE_STARVED …: C4 (stacker) @lower`（+6 字符）。
                     *
                     * 实测 77:0（模型全选 `upper`，一次都没选对）——
                     * **不写角色名，它只能猜，而它 100% 猜错。**
                     * 对照：历史上 `SLOT_STARVED` 明说「lower 空着」时，模型立刻写
                     * `port:"lower"` 并落地。⇒ 它会读角色名，问题是没给。 */
                    slot: (() => {
                        const miss = worst.fed.filter(f => !f.ok);
                        return miss.length ? { role: miss[0].role || null } : undefined;
                    })(),
                    expected: `每台多输入机器（${[...MULTI_IN].join("/")}）的每个输入槽都有货`,
                    observed: `${starved.length} 台机器缺进料：${detail}`,
                    evidence: {
                        handles: hs,
                        uids: starved.map(s => s.m.uid),
                        starved: starved.slice(0, 6).map(s => ({
                            type: s.m.type, uid: s.m.uid, at: [s.m.x, s.m.y],
                            fed: s.nFed, need: s.total,
                            missing_cells: s.fed.filter(f => !f.ok).map(f => f.cell),
                            /* ★ 角色名（2026-11-25）。`prompt.mjs:2803` 的 `@${d.slot.role}`
                             * 渲染位从造出来那天起就是死代码 —— 全 run 24 条诊断里 `.slot`
                             * 出现 **0 次**。这里把它填上，让 `MACHINE_STARVED` 的标题行
                             * 直接渲染成 `C4 (stacker) @lower`（+6 字符）。
                             *
                             * 见上面 `detail` 那段的长注释：77:0 的实测证明
                             * **不写角色名，模型只能猜，而它 100% 猜错。** */
                            missing: s.fed.filter(f => !f.ok).map(f => ({ role: f.role || null })),
                        })),
                        /* 可行源头：最近、且输出口空闲的 3 台。
                           渲染在 `renderDiagnoses` 里，带 `from:` 前缀。 */
                        feed_sources: feedSources,
                        /* 目标要哪些颜色、地图上有哪些、哪些必须靠合成。
                         * 真机实测：缺这一条时模型拉了绿矿，产出上一关的形状。 */
                        feed_color: feedColor,
                        note: "a multi-input machine that gets only some of its inputs never fires; "
                            + "everything upstream of it backs up and freezes",
                    },
                    candidates: ["connect", "insert_machine"],
                    /* ★ 文案去掉自相矛盾，并给出「从哪一端开始」（2026-11-21）★
                     *
                     * 旧版同时说「最典型的是 painter（扫描顺序第一个）」
                     * 和「先修最下游那一台」—— 而这两台在这台世界上不是同一台。
                     *
                     * 新版：`worst` 已按拓扑排过序，直接说「从这台开始，因为它是根」。
                     *
                     * ★ 三条来自 A/B 实验的硬约束（2026-11-21，n=10/组）★
                     *
                     * ① **必须带句柄**（`painter#13552（C3）`），不能只给 uid。
                     *    实测：只有 `painter#13552` 时 2/10 选中；加上 `（句柄 C3）` 后 **9/10**，
                     *    p=0.0027。成本 6 个字符。这是最大的单一杠杆。
                     *    （`subject.handle` 是结构化字段，模型读的是**渲染后的文本**，
                     *     两者不是一回事 —— 这是本仓库第三次栽在「算出来 ≠ 送到」。）
                     *
                     * ② **全文必须 ≤180 字符**。`renderDiagnoses` 是 `clip(hint, 180)`，
                     *    超出部分静默丢弃。上一版 210 字符，尾部被切在 `insert_mach|ine` 中间。
                     *
                     * ③ **不能用 `\n`**。诊断是「一条一行」渲染的，换行会把编号顶歪，
                     *    实测 DIAGNOSIS 段从 157 行涨到 159 行。
                     *
                     * 还有一条**反面教训**：不要设计「点名坐标」的 hint ——
                     * `sanitize()` 会按契约把 `(-4,15)` 换成 `<coord>`，
                     * 于是模型读到「先修 painter#13552 的 `<coord>` 那个空格」，
                     * 一半句子是废话，还占字符额度。想指位置就给句柄。 */
                    /* ★ 「上游」这个词必须点明它不是 `upper` 槽（2026-11-25）★
                     *
                     * 实测 192 条真调样本：目标是 C4 的提案 83 次，其中
                     * **`port=upper` 77 次、`port=lower` 0 次**。
                     *
                     * 而 `why` 里提到「上游/upstream」44/77、提到 `upper` 字面 18/77
                     * —— **模型脑子里装的是「上游」，写出来的 port 是 `upper`。**
                     * 这两个词在这份 prompt 里只差两个字母，而 `## MACHINES` 那行
                     * 恰好把两个槽命名为 `lower` / `upper`。
                     *
                     * 所以这里把「上游」明确排除掉，并把缺的槽直接写出来。
                     * 字数上是**净增 ~8 字符**，但它省掉的是整整一轮白干。 */
                    hint: `**${starved.length} 台机器只吃到一半的料，永远不会产出**，整条链会一起冻死。`
                        + `**从 ${worst.m.type}#${worst.m.uid}（句柄 ${handleOf(handles, worst.m.uid) || "?"}）开始**`
                        + (missRole ? `—— 缺的是 \`${missRole}\` 槽（不是别的槽）。` : `—— 它是这条链的根。`)
                        + `把这一路接上：\`connect\` 到它的 \`${missRole || "缺料"}\` 口；源头不存在就 \`insert_machine\`。`
                        + (starved.length > 1 ? `这台通了再看另外 ${starved.length - 1} 台。` : ""),
                });
            }
        }

        /* ★ ③c-bis TRASH_OVERGROWN —— 垃圾桶太多（2026-11-15 夜，L12 真机）★
         *
         * 实测：最近 5 次 run 的 59 个调用里 `trash_unused` 占 **12 个（20%）**，
         * 世界里的垃圾桶从 25 涨到 34，而产出始终 0。
         *
         * 为什么 agent 爱用它：它是少数**几乎总是成功**的宏
         * （不像 `connect` 会撞 `occupied`、`insert_machine` 会 `blocked_by_machine`）。
         * 于是它变成了「有事没事找个垃圾倒」—— 每次都能拿到 `cleanup` 的评分，
         * 而世界离目标一步没近。
         *
         * 判据：垃圾桶数量 > 8 **且**超过机器的 20%。
         * 这个阈值的依据：L12 需要的完整产线里，废料口只有 cutter 的右半
         * 和 painter 的多余色，正常不会超过 5-6 个。
         * 8 是「再宽也就这样了」的上限。 */
        {
            const trashes = idx.ent.filter(e => e.type === "trash");
            const machineTotal = machines.length;
            const tooMany = trashes.length > 8
                && (machineTotal === 0 || trashes.length / machineTotal >= 0.2);
            if (tooMany) {
                const hs = trashes.map(t => handleOf(handles, t.uid)).filter(Boolean);
                out.push({
                    code: "TRASH_OVERGROWN",
                    layer: "L2",
                    severity: "warn",
                    subject: subjectOf(handles, trashes[0].uid, "trash"),
                    expected: "垃圾桶只用来消化真正的废料（cutter 的边角、painter 的多余色）",
                    observed: `${trashes.length} 个垃圾桶 / ${machineTotal} 台机器 —— `
                        + `它们吞掉的货本来可以进目标产线`,
                    evidence: {
                        handles: hs,
                        uids: trashes.map(t => t.uid),
                        trash_count: trashes.length,
                        machine_count: machineTotal,
                    },
                    candidates: ["remove_machine", "remove_run"],
                    hint: `${trashes.length} 个垃圾桶太多了。它们是「止损」不是「产出」—— `
                        + `倒掉货能让 DEAD_END 从诊断里消失，但对造出目标形状零贡献。`
                        + `**别再用 trash_unused 图省事了**：它几乎总是成功，所以很容易变成惯性，`
                        + `而每一轮用它都离目标更远。`
                        + `清掉多余的：\`remove_machine {uids:$uids([${hs.slice(0, 4).join(",")}])}\`。`
                        + `判断标准：这条废料流**本来就不该存在**（源头是接错的线）⇒ 拆线，不是加垃圾桶。`,
                });
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ③c2 ORE_UNMINED —— **有矿，但没矿机在上面**
     *
     * 与 `ORPHAN_MACHINES` 正好相反：那条说的是「机器没接东西」，
     * 这条说的是「矿没被机器接」。后者更根本 —— 机器可以再放，矿是固定的。
     *
     * 实测（2026-11-19，L12）：全图 3,481 格「含圆形」的矿，
     * **0 台矿机在上面**；而目标 `CbCbCbRb:CwCwCwCw` 每一格都是圆形。
     * 16 台矿机全在挖颜料（红 4 / 蓝 6 / 绿 4 / 钌 1）。
     *
     * 更尖锐的一例：矩形矿（`RuRuRuRu`）就在距 hub 8 格处，
     * 一台矿机已经坐在上面 —— 但它的输出口朝右喷进空格，差**一条带子**。
     * 也就是说「缺料」这件事，有时只差一格。
     *
     * 判据保守：只在**目标需要的形状**完全没被开采时报。
     * 目标串里出现的形状码（R/C/S/W），逐个查「有没有矿机踩在含该形状的矿上」。
     * 有矿图才算，没矿图不报（不猜）。
     * ──────────────────────────────────────────────────────────────────── */
    if (!o.truncated && engine && engine.ore instanceof Map && engine.ore.size) {
        const SHAPE_NAME = { R: "rect", C: "circle", S: "star", W: "windmill" };
        /* 目标里出现哪些形状码 */
        const wantShapes = new Set();
        for (const ch of String(goalShape).replace(/:/g, "")) {
            if (SHAPE_NAME[ch]) wantShapes.add(ch);
        }
        if (wantShapes.size) {
            const miners = idx.ent.filter(e => e && e.type === "miner");
            /* 每台矿机脚下是什么矿 → 含哪些形状码 */
            const minedShapes = new Set();
            let minersOnShapeOre = 0;
            for (const m of miners) {
                const key = engine.ore.get(`${m.x},${m.y}`);
                if (typeof key !== "string") continue;
                let hit = false;
                for (const [ch] of Object.entries(SHAPE_NAME)) {
                    if (key.includes(ch)) { minedShapes.add(ch); hit = true; }
                }
                if (hit) minersOnShapeOre++;
            }
            const missing = [...wantShapes].filter(ch => !minedShapes.has(ch));
            if (missing.length) {
                /* 这些形状的矿在哪、最近的一格多远 */
                const hub0 = idx.ent.find(e => e.type === "hub");
                const spots = [];
                for (const [cell, key] of engine.ore) {
                    if (typeof key !== "string") continue;
                    if (!missing.some(ch => key.includes(ch))) continue;
                    const [x, y] = cell.split(",").map(Number);
                    const d = hub0 ? Math.abs(x - hub0.x) + Math.abs(y - hub0.y) : 0;
                    spots.push({ x, y, key, d });
                }
                spots.sort((a, b) => a.d - b.d);
                const names = missing.map(ch => `${SHAPE_NAME[ch]}(${ch})`).join(" / ");
                /* ★ 提示里的措辞必须**与 evidence 一致**，且语法必须可执行 ★
                 *
                 * 实测（验证 agent）抓出三个缺陷，都只在文案里：
                 *
                 * ① 原话「现在 16 台矿机**全**在挖颜料」是**假的** ——
                 *    其中一台（16597）就踩在矩形矿上，与自己的
                 *    `evidence.miners_on_shape_ore: 1` 自相矛盾。
                 *    模型读字面会以为矩形也没人挖，而它其实只差一条带子。
                 *
                 * ② 原话教 `{cell,machine:"miner",facing}` —— **这个参数不存在**。
                 *    真机校验返回 `unknown_field: 不允许 cell；可用 at/facing/machine/opts`，
                 *    而 unknown_field 的候选表是空的 ⇒ 模型照着做就走进死路。
                 *    本文件别处的正确写法是 `{at:{"$ore":"<前缀>"}}`（见上面 mixer 那段）。
                 *
                 * ③ `spots` 为空时仍然说「放到那个矿格上」—— 而根本没有那种矿。
                 *    模型会去 `$ore:"Su"`，拿到 `ORE_NOT_FOUND`，候选表同样为空 ⇒ 停机。
                 *
                 * 另外：诊断行会过 `sanitize()`，坐标会被改写成 `[<coord>]`，
                 * 所以**不要靠字面坐标传达位置** —— 用 `$ore` 让宏自己去挑格子。 */
                const missingPrefixes = missing.map(ch => {
                    /* 形状矿的 `$ore` 前缀用形状字母：`CuCuCuCu` → "Cu"，
                       取矿种名头两个字符即可（矿表里形状矿都是 XX 重复或组合）。 */
                    const hit = spots.find(s => s.key.includes(ch));
                    return hit ? { ch, prefix: hit.key.slice(0, 2) } : null;
                }).filter(Boolean);
                const canPlace = missingPrefixes.length > 0;
                out.push({
                    code: "ORE_UNMINED",
                    layer: "L4",
                    severity: "blocker",
                    subject: subjectOf(handles, hub0 && hub0.uid, "hub"),
                    expected: `目标需要的形状 ${[...wantShapes].map(c => SHAPE_NAME[c]).join("/")} 各自至少有一台矿机在开采`,
                    observed: `目标要 ${names}，但 ${miners.length} 台矿机里**没有一台**踩在含这些形状的矿上`
                        + `（踩在形状矿上的只有 ${minersOnShapeOre} 台）`
                        + (spots.length
                            ? `；最近的一格这类矿距 hub ${spots[0].d} 格`
                            : "；扫描范围内也找不到这类矿"),
                    evidence: {
                        handles: [subjectOf(handles, hub0 && hub0.uid, "hub").handle].filter(Boolean),
                        uids: hub0 ? [hub0.uid] : [],
                        tier: hub0 ? tierOf(hub0.uid) : null,
                        missing_shapes: missing,
                        miners_total: miners.length,
                        miners_on_shape_ore: minersOnShapeOre,
                        nearest: spots.slice(0, 4),
                    },
                    candidates: canPlace ? ["insert_machine", "connect"] : [],
                    hint: canPlace
                        ? `目标要 ${names}，而**没有一台矿机在挖这类矿**`
                            + `（${miners.length} 台矿机里只有 ${minersOnShapeOre} 台踩在形状矿上，其余都在挖颜料）。`
                            + `放一台上去：\`insert_machine {at:{"$ore":"${missingPrefixes[0].prefix}"}, `
                            + `facing:<朝外>, machine:"miner"}\` —— \`$ore\` 会让宏自己挑一格矿，`
                            + `不用你写坐标。放好再 \`connect\` 把输出接出去。`
                            + `**在挖到目标形状的原料之前，改带子朝向不会有任何产出。**`
                        /* spots 为空：不要说「去放矿机」，那是做不到的事。 */
                        : `目标要 ${names}，而扫描范围内**根本没有这类矿**，`
                            + `也没有任何矿机在挖它 —— 这不是放一台矿机能解决的。`
                            + `换一条思路：先确认 goal 是不是抄错了形状码（形状码大写 R/C/S/W，`
                            + `颜色码小写 r/g/b/y/p/c/w，两者是两套字母表），`
                            + `或者扩大扫描半径看远处有没有这种矿。**别再改现有带子。**`,
                });
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────
     * ③d UPGRADE_AVAILABLE —— hub 里存着的形状已经够买下一档升级
     *
     * 用户的原话：「AI 不会用更高级的方法提高效率」。
     *
     * 实测（2026-11-13，level 9 实机）：
     *
     *     miner     L1  下一档需 RuRuRuRu×740 + Cu------×800    can_buy=true
     *     painting  L0  下一档需 RbRb----×600                    can_buy=true
     *
     * 而 hub 里存着 RuRuRuRu×15583、Cu------×34332、RbRb----×7219。
     * **两档白送的升级躺在那里没人拿**，因为 prompt 里从来没提过。
     *
     * 判据完全离线：`rules.mjs` 的 `UPGRADES` 表给了每档要什么
     * （已对过实机的 `upgrade` RPC，四条链逐项一致），`obs.hub.stored_shapes`
     * 给了现在有多少。能买 ⇒ 报。
     *
     * ⚠️ 为什么 `severity: "warn"` 而不是 blocker：
     *    它**不是坏了**，是「有一件零成本的好事没做」。判成 blocker 会把它顶到
     *    `MIXER_UNFED` 那种「配方跑不起来」的前面，那方向是错的 ——
     *    产线断了的时候，升级救不了。
     *
     * ⚠️ 为什么只报**买得起**的，不报「离买得起还差多少」：
     *    差多少是 `CAPACITY` 段的事（它已经在算 `needs …`）。
     *    这条诊断的唯一职责是「现在就能做、而且划算」，那才值得占一个候选名额。
     * ──────────────────────────────────────────────────────────────────── */
    {
        const stored = (o.hub && o.hub.stored_shapes) || null;
        const lvls = (o.goal && o.goal.upgrade_levels) || null;
        if (stored && lvls) {
            const affordable = [];
            for (const [line, tiers] of Object.entries(UPGRADES)) {
                const cur = lvls[line] || 0;
                const next = tiers.find(t => t.tier === cur + 1);
                if (!next) continue;                       // 满级或未登记
                const missing = next.required
                    .map(req => ({ shape: req.shape, amount: req.amount, have: stored[req.shape] || 0 }))
                    .filter(m => m.have < m.amount);
                if (missing.length === 0) {
                    affordable.push({ line, tier: next.tier, from: cur, mult: UPGRADE_MULTIPLIERS });
                }
            }
            if (affordable.length) {
                /* 按「花掉的库存越少越优先」排 —— 便宜的升级先买，
                 * 因为所有升级都是全局倍率，先买便宜的能更早开始收益。 */
                affordable.sort((a, b) => {
                    const cost = x => (UPGRADES[x.line].find(t => t.tier === x.tier).required || [])
                        .reduce((s, r) => s + r.amount, 0);
                    return cost(a) - cost(b);
                });
                const top = affordable[0];
                const costOf = x => (UPGRADES[x.line].find(t => t.tier === x.tier).required || [])
                    .map(r => `${r.shape}×${r.amount}`).join(" + ");
                const detail = affordable
                    .map(x => `${x.line} T${x.tier}（要 ${costOf(x)}）`)
                    .join("，");
                out.push({
                    code: "UPGRADE_AVAILABLE",
                    layer: "L5",
                    severity: "warn",
                    subject: subjectOf(handles, hub ? hub.uid : null, "hub"),
                    expected: "shapes banked in the hub are spent on upgrades that make every machine of that kind faster",
                    observed: `${affordable.length} upgrade tier(s) are already paid for by the hub's stored shapes: ${detail}`,
                    evidence: {
                        handles: hub ? [handleOf(handles, hub.uid)].filter(Boolean) : [],
                        affordable: affordable.map(x => ({ line: x.line, tier: x.tier, cost: costOf(x) })),
                        note: "buying an upgrade costs no map space and is not undoable — spend deliberately",
                    },
                    candidates: ["upgrade"],
                    hint: `hub 里的形状已经够买 **${top.line} T${top.tier}** 了（要 ${costOf(top)}）—— `
                        + `用 \`upgrade {id:"${top.line}"}\` 买它：零占格、全图生效，`
                        + `比再铺一条线便宜得多。`
                        + (affordable.length > 1
                            ? `这一档之外还有：${affordable.slice(1).map(x => `${x.line} T${x.tier}`).join("、")}。`
                            : "")
                        + `⚠️ 库存一旦花掉拿不回来 —— 但如果现在不买，那些形状只是躺在 hub 里。`,
                });
            }
        }
    }

    out.sort((a, b) => {
        const sa = SEVERITY_RANK[a.severity] ?? 9;
        const sb = SEVERITY_RANK[b.severity] ?? 9;
        if (sa !== sb) return sa - sb;
        const ra = CODE_RANK[a.code] ?? 50;
        const rb = CODE_RANK[b.code] ?? 50;
        if (ra !== rb) return ra - rb;
        if (a.code !== b.code) return a.code < b.code ? -1 : 1;
        const ha = (a.subject && (a.subject.handle || a.subject.token)) || "";
        const hb = (b.subject && (b.subject.handle || b.subject.token)) || "";
        if (ha !== hb) return ha < hb ? -1 : 1;
        const ua = (a.evidence && a.evidence.uids && a.evidence.uids[0]) || 0;
        const ub = (b.evidence && b.evidence.uids && b.evidence.uids[0]) || 0;
        return ua - ub;
    });

    /* ── 上限：每码 ≤PER_CODE、总量 ≤TOTAL；超出记在首条 evidence.suppressed（v2 §6） ── */
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
            if (n) { d.evidence.suppressed = n; dropped.delete(d.code); }
        }
        const rest = [...dropped.values()].reduce((s, n) => s + n, 0);
        if (rest && kept.length) kept[0].evidence.suppressed = (kept[0].evidence.suppressed || 0) + rest;
    }
    return kept;
}

const REASON_TEXT = Object.freeze({
    tunnel: "this stream crosses an underground belt; a tunnel is a barrier for shape propagation, so the shape on the far side cannot be proven here",
    "no-resources": "the observation carries no resource map, so what the miners dig cannot be read",
    "no-ore": "a miner stands on a cell with no ore, so its output shape is unknowable (and it never produces)",
    "unknown-op": "this building has no shape rule in the template table, so its output cannot be derived",
    "unverified-rotation": "this machine is rotated; its slot geometry under rotation is not verified, so its output is not derived",
    "unknown-color": "the paint colour could not be resolved (no colour item arrives at the colour input)",
    "stack-incompatible": "the two stacked shapes cannot be merged by the shape algebra",
    "not-a-shape": "an input arriving here is not a shape (e.g. a pigment), so the processor output cannot be derived",
    cycle: "shape propagation met a cycle",
});

/**
 * 给定一个形状，找出**哪些带子属于正在搬运它的那条流**。
 *
 * ## 为什么需要它（`OBSOLETE_LINE` 一度无法施工）
 *
 * 残线诊断原来只说「工厂在造 `Cu----Cu` ×29、一件都没进 hub」，
 * `evidence.handles` 是**空的** —— 比对同一轮的 `PROCESSOR_REQUIRED`，
 * 后者老老实实给了 `stream_handles`。模型于是知道「有一条该拆的线」，
 * 却没有任何句柄可以交给 `remove_run`，下一轮只好去干别的。
 *
 * 产出窗口（`produced_total`）说的是「哪个形状在被造」，它**不含位置**；
 * 位置只能从形状传播（`makeShapeEngine` + `buildStreams`）里拿回来。
 * 这里就是那座桥。
 *
 * 判据刻意从宽：**只要这条流上任何一条带子的当前货是它**就算。
 * 残线要拆的是「这条线」，不是「恰好这一段」，所以宁可多给几条句柄，
 * 也不能给一条可能属于别处的。量由调用方（`remove_run` 的 `$path_of`）再收。
 *
 * @param {object} obs
 * @param {object} recipe  `recipeForCached` 的返回（与诊断同源，不重算）
 * @param {string} shape
 * @param {object|null} [handles] 句柄表；给了就把 uid 翻成句柄
 * @param {object} [opts] `{max}` 最多几条
 * @returns {string[]} 句柄（`handles` 缺失时退回 `uid:<n>`）
 */
export function beltsCarryingShape(obs, recipe, shape, handles = null, opts = {}) {
    const want = typeof shape === "string" ? shape.trim() : "";
    if (!want) return [];
    const o = unwrapObs(obs);
    if (!o || o.truncated === true) return [];
    if (!recipe || recipe.ok !== true || !Array.isArray(recipe.steps) || !recipe.steps.length) return [];
    const max = Number.isInteger(opts.max) ? opts.max : 8;

    let engine, streams;
    try {
        const idx = indexOf(o);
        engine = makeShapeEngine(o, idx);
        streams = buildStreams(idx);
    } catch {
        return [];                       // 世界读不全 ⇒ 不猜（与语义层其它地方同一条纪律）
    }

    const out = [];
    const seen = new Set();
    for (const st of streams) {
        for (const b of st.belts) {
            let shapes;
            try {
                shapes = shapesOf(engine.beltValue(b));
            } catch {
                continue;
            }
            if (!Array.isArray(shapes) || !shapes.includes(want)) continue;
            if (seen.has(b.uid)) continue;
            seen.add(b.uid);
            out.push(handles ? (handleOf(handles, b.uid) || `uid:${b.uid}`) : `uid:${b.uid}`);
            if (out.length >= max) return out;
        }
    }
    return out;
}

export default semanticDiagnoses;
