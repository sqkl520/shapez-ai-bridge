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
import { DIRV, OPP } from "../../ai/belt-rules.mjs";
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

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 小工具
 * ══════════════════════════════════════════════════════════════════════════ */

const sameCell = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const variantOf = e => (e && e.variant) || "default";

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

    const tplOf = e => templateByBuildingVariant(e.type, variantOf(e));

    /** 上游实体是否把货「喷进」`cell`（且方向对）。 */
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

    /** 带子的形状 = 喂它的那个输出槽的形状。 */
    function beltValue(b) {
        if (!isBelt(b)) return null;
        if (beltMemo.has(b.uid)) return beltMemo.get(b.uid);
        const key = `belt:${b.uid}`;
        if (busy.has(key)) { mark("cycle", b.uid, "belt"); return null; }
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
        beltMemo.set(b.uid, val);
        return val;
    }

    /** 机器某个输出槽的形状（按槽传播）。 */
    function outValue(m, role) {
        const key = `${m.uid}:${role}`;
        if (slotMemo.has(key)) return slotMemo.get(key);
        if (busy.has(key)) { mark("cycle", m.uid, m.type); return null; }
        busy.add(key);
        const val = computeOut(m, role);
        busy.delete(key);
        slotMemo.set(key, val);
        return val;
    }

    function computeOut(m, role) {
        const tpl = tplOf(m);
        if (!tpl) { mark("unknown-op", m.uid, m.type); return null; }
        if (m.type === "trash" || m.type === "hub") return null;
        const rot = (((Number(m.r) || 0) % 360) + 360) % 360;
        if (rot !== 0) { mark("unverified-rotation", m.uid, m.type); return null; }
        const op = tpl.op;
        const unions = (...vals) => {
            const out = new Set();
            for (const v of vals) if (v) for (const x of v) out.add(x);
            return out.size ? out : null;
        };

        if (op === "mine") {
            const kind = ore.get(K([m.x, m.y]));
            if (kind === undefined) { mark(resourcesPresent ? "no-ore" : "no-resources", m.uid, m.type); return null; }
            return new Set([kind]);
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

    return { ore, resourcesPresent, unknown, beltValue, outValue, inputValue, senderOf };
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
    PROCESSOR_REQUIRED: 2,
    SHAPE_UNKNOWN: 3,
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
    void items;
    const o = unwrapObs(obs);
    const recipe = opts.recipe;
    if (!recipe || recipe.ok !== true || !Array.isArray(recipe.steps) || !recipe.steps.length) return [];
    if (o.truncated === true) return [];            // 契约 §4：世界不完整 ⇒ 语义层整体返回空
    const goalShape = typeof goal === "string" ? goal : (goal && (goal.shape || goal.goal)) || null;
    if (typeof goalShape !== "string" || !goalShape) return [];

    const idx = indexOf(o);
    const reach = hubReachable(o, idx);
    const model = recipeModel(recipe, opts.level);
    if (!model.usable.length) return [];

    const engine = makeShapeEngine(o, idx);
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

    /* ── 排序（确定性）：severity → 码优先级 → subject 句柄 → uid ── */
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
