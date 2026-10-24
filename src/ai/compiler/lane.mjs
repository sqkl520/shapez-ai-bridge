/**
 * lane.mjs — P4 router：车道分配（left-edge 区间着色 + 串行加障碍）。
 *
 * 权威依据：
 *   research/ai-player/plan-compiler.md §1.4（本包）/ §2.3（LayoutReport）
 *   research/ai-player/routing-prior-art.md §1（channel routing：left-edge 首适 + vertical
 *     constraint 判据；27405 例穷举 = 色数最优）、§6（cell_footprint 预占 + 串行加障碍）、
 *     §8 选型结论（主线程采纳：主干 = left-edge 车道 + 带朝向 Dijkstra，A* 只兜底）
 *   facts/MILESTONE-M4-partial-and-pitfalls.md 陷阱 #1（同格对向死循环）/ #3（退化段）/
 *     #5（两条车道必须不同行）；facts/MILESTONE-M4-SUCCESS.md（只让一条分支拐弯）
 *   src/ai/belt-rules.mjs —— 唯一方向权威（本文件只读 ORDER/OPP/DIRV，不实现任何方向逻辑）
 *
 * 职责：输入 P3 的 LayoutReport.channels[]（端点对，from.cell/to.cell 是**机器的槽位格**），
 *   输出每条通道的几何形态 + 车道行号，写回 channels[].lane 与 lanes[]。
 *   **不产带子格与 (rot,rv,code)** —— 那是 route.mjs。
 *
 * ── 端点语义（读法 A，与 fixtures/plan-l1.json、fixtures/report-layout.json 逐格对拍确认）──
 *   first = from.cell + DIRV[from.outDir]   上游 ejector 面外一格的带子格
 *   last  = to.cell   + DIRV[to.inDir]      下游 acceptor 面外一格的带子格
 *   首格 entryDir = OPP[from.outDir]        首格的进货面朝着上游机器
 *   末格 goalOut  = OPP[to.inDir]           末格的出货面朝着下游机器
 *   凭据：plan-l1 里 belt(0,3) outDir="top" 的下游 cutter(0,4) inDir="bottom" —— 互为反向
 *   ⇒ inDir 是**槽位方位**（读法 A），不是货流入向量。prior-art §6 的【待验】歧义在此钉死。
 *
 * ── lane 字段口径（NOTES C-1，v2 修订）──
 *   fixture report-layout.json 里 channels[1].lane=3 与 lanes[0].row=3 同值（v1 的「lane = 行号」）。
 *   v2 起 `channels[].lane` 仍只是**下标**，轴由 `channels[].laneAxis` 给出：
 *   `{lane:3, laneAxis:"row"}` ↔ `lanes[]{row:3}`；`{lane:3, laneAxis:"col"}` ↔ `lanes[]{column:3}`。
 *   旧报告缺 laneAxis ⇒ 按 "row" 读（唯一向后兼容读法，见 types.mjs 的 LayoutChannel 注释）。
 *
 * ── 形状语义：竖直出 + 竖直进 ⇒ 水平车道（hlane，契约 lanes[] 的 `{row}`）；
 *   水平出 + 水平进 ⇒ 竖直车道（vlane，契约 lanes[] 的 `{column}`）。
 *   **LANE_SCHEMA_VERSION = 2**：lanes[] 的条目是 `{row|null, column|null, channelIds}`，
 *   恰一个非 null；channels[].lane 只装**下标**，轴由 channels[].laneAxis（"row"|"col"）给出。
 *   ⇒ vlane 与 hlane 共用整数 3 是两条不同车道，P5 的 V6 与 types 的判重都按 (轴, 下标) 比较。
 *   vlane 默认参与分配（`opts.allowVerticalLane === false` 可显式关闭，用于「只允许 hlane」的诊断口径）。
 *
 * 零依赖：ESM + node: 内置 + ../belt-rules.mjs + ./grid.mjs + ./errors.mjs + ./types.mjs（只取版本常量）。
 * 禁 import research/ai-player/proto/**（错误副本；判据在 research/ai-plan/contract/lint-imports.mjs）。
 */

import { ORDER, OPP, DIRV } from "../belt-rules.mjs";
import { cellKey } from "./grid.mjs";
import { ContractViolation, assertInt, isAngle } from "./errors.mjs";
import { LANE_SCHEMA_VERSION } from "./types.mjs";

/** lanes[] / channels[].laneAxis 的契约版本。**单一来源 = types.mjs**（P1 拥有 §2.3 契约）；
 *  这里 re-export 只为兼容旧 import（曾经本文件自己声明 v1）。 */
export { LANE_SCHEMA_VERSION };

/** 通道几何形态（P4 内部枚举，不进 §2.3 契约） */
export const GEOM_KINDS = Object.freeze([
    "direct",    // 0 个带子格：两机器面贴面（first===to.cell && last===from.cell）
    "single",    // 退化段：1 个带子格（first===last）—— plan §1.4 明令 IR 里保留一格
    "straight",  // 轴对齐直线，0 拐角
    "elbow",     // 单拐角（一进轴 ⊥ 一出轴），无需车道
    "hlane",     // 竖直出/竖直进 ⇒ 一条**水平**车道行（两次转向）→ left-edge 分 row
    "vlane",     // 水平出/水平进 ⇒ 一条**竖直**车道列（两次转向）→ 同轴分 col
    "search",    // 单调折线不成立 → 交给 route.mjs 的带朝向 Dijkstra（兜底，绝不硬凑）
]);

/** conflicts[].kind 只能取 §2.3 五枚举（**不扩**，prior-art §7 明令） */
export const CONFLICT_KIND = Object.freeze({
    occupied: "cell-occupied",
    lane: "lane-column",
    crossing: "crossing",
    noTurn: "no-turn",
    hub: "hub-contention",
});

/**
 * conflicts[].resolvedBy 取值（plan §2.3 是自由字符串；prior-art §8 要求解法可归因）。
 * null = 未解决 → 上层必须 ok:false。
 */
export const RESOLVED_BY = Object.freeze({
    preAssigned: "pre-assigned-lane",     // P3 已给 lane 且可行 → 原样采纳
    newRow: "left-edge-new-row",          // left-edge 新开/复用一条车道行
    newCol: "left-edge-new-col",          // 竖直车道列（v1 默认不产）
    moved: "shift-x",                     // P3 的 lane 不可行 → 重排到别的行
    widened: "widen-row",                 // 行距加宽后放得下
    none: null,
});

/* ───────────────────────────── 坐标算术（无方向语义） ───────────────────────────── */

const isVert = d => d === "top" || d === "bottom";
const sgn = n => (n > 0 ? 1 : n < 0 ? -1 : 0);
const NEG = -Infinity, POS = Infinity;

/** cell 沿 dir 面外一格（"槽位格 → 带子格"的唯一位移；方向语义仍在 belt-rules） */
export function step(cell, dir) {
    const v = DIRV[dir];
    if (!v) throw new ContractViolation("lane.step(dir)", "top|right|bottom|left", dir);
    if (!Array.isArray(cell) || cell.length !== 2) throw new ContractViolation("lane.step(cell)", "[x,y]", cell);
    return [cell[0] + v[0], cell[1] + v[1]];
}
export function sameCell(a, b) {
    return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}
/** 严格单调：from→to 的位移 = DIRV[dir] 的正倍数（至少一格；同格返回 false） */
export function monotoneAlong(from, to, dir) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const v = DIRV[dir];
    if (v[0] !== 0) return dy === 0 && sgn(dx) === sgn(v[0]) && dx !== 0;
    return dx === 0 && sgn(dy) === sgn(v[1]) && dy !== 0;
}
/** 闭区间轴对齐格序列（含两端）；两格不同轴 → null */
export function spanCells(a, b) {
    if (a[0] === b[0] && a[1] === b[1]) return [[a[0], a[1]]];
    if (a[0] === b[0]) {
        const s = sgn(b[1] - a[1]), out = [];
        for (let y = a[1]; ; y += s) { out.push([a[0], y]); if (y === b[1]) break; }
        return out;
    }
    if (a[1] === b[1]) {
        const s = sgn(b[0] - a[0]), out = [];
        for (let x = a[0]; ; x += s) { out.push([x, a[1]]); if (x === b[0]) break; }
        return out;
    }
    return null;
}
/** 去掉与上一段重复的首格（拼接用） */
const tail = cells => cells.slice(1);

/**
 * 通道 id。契约的 lanes[].channelIds 是字符串，但 channels[] **没有** id 字段
 * （plan §7.3 只预留 slotRole/ordinal）→ 推导优先级：
 *   显式 ch.id → "from->to#ordinal" → "from->to[slotRole]" → "from->to@i"。
 * 缺口登记 NOTES C-2（不改 types.mjs）。
 */
export function channelIdOf(ch, i) {
    if (typeof ch.id === "string" && ch.id !== "") return ch.id;
    const base = `${ch.from.nodeId}->${ch.to.nodeId}`;
    if (Number.isInteger(ch.ordinal)) return `${base}#${ch.ordinal}`;
    if (typeof ch.slotRole === "string" && ch.slotRole) return `${base}[${ch.slotRole}]`;
    return `${base}@${i}`;
}

/* ───────────────────────────── 几何推导 ───────────────────────────── */

/**
 * 由端点对推出通道形态。判不出单调折线的一律 kind="search"（**不许硬凑方向**）。
 * @param {object} ch LayoutReport.channels[i] @param {number} i
 * @returns {object} Geom
 */
export function channelGeom(ch, i) {
    if (!ch || !ch.from || !ch.to) throw new ContractViolation(`lane.channelGeom(channels[${i}])`, "{from,to}", ch);
    for (const [ep, key] of [[ch.from, "from"], [ch.to, "to"]]) {
        if (!Array.isArray(ep.cell) || ep.cell.length !== 2 || !ep.cell.every(Number.isInteger)) {
            throw new ContractViolation(`lane.channelGeom(channels[${i}].${key}.cell)`, "[x,y] 整数", ep.cell);
        }
        if (!ORDER.includes(ep.slot)) throw new ContractViolation(`lane.channelGeom(channels[${i}].${key}.slot)`, "DirName", ep.slot);
        if (!ORDER.includes(ep[key === "from" ? "outDir" : "inDir"])) {
            throw new ContractViolation(`lane.channelGeom(channels[${i}].${key}.${key === "from" ? "outDir" : "inDir"})`, "DirName", ep[key]);
        }
    }
    const first = step(ch.from.cell, ch.from.outDir);
    const last = step(ch.to.cell, ch.to.inDir);
    const entryDir = OPP[ch.from.outDir];       // 首格进货面
    const goalOut = OPP[ch.to.inDir];           // 末格出货面
    const g = {
        id: channelIdOf(ch, i), index: i, ch,
        first, last, entryDir, goalOut, flowOut: ch.from.outDir,
        cFrom: first[0], rFrom: first[1], cTo: last[0], rTo: last[1],
        kind: null, corner: null, interval: null, band: null, laneAxis: null, reason: null,
    };

    // 1) 零格：两机器出口面与入口面互贴（竖直直串，零拐角）
    if (sameCell(first, ch.to.cell) && sameCell(last, ch.from.cell)) { g.kind = "direct"; return g; }
    // 2) 退化段（陷阱 #3）：**IR 里保留一格**，不报 2001、不当异常
    if (sameCell(first, last)) { g.kind = "single"; return g; }
    // 3) 直线：出向 == 末格出向且同轴单调
    if (g.flowOut === g.goalOut && monotoneAlong(first, last, g.flowOut)) { g.kind = "straight"; return g; }

    // 4) 单拐角
    const el = tryElbow(g);
    if (el) return Object.assign(g, el);

    // 5) 双拐角 ⇒ 车道。竖直出+竖直进 → 水平车道（row）；水平出+水平进 → 竖直车道（col）。
    if (isVert(g.flowOut) && isVert(g.goalOut) && g.cFrom !== g.cTo) {
        g.kind = "hlane"; g.laneAxis = "row";
        g.interval = [Math.min(g.cFrom, g.cTo), Math.max(g.cFrom, g.cTo)];   // 车道在 row 上张开的列区间
        // 车道 row 必须同时落在两条竖直腿的**前进半平面**里（带子不能倒着走）：
        //   flowOut=top ⇒ 腿1 向上走 ⇒ row <= rFrom；flowOut=bottom ⇒ row >= rFrom
        //   goalOut=top ⇒ 腿3 向上走进机器 ⇒ row >= rTo；goalOut=bottom ⇒ row <= rTo
        g.band = intersect(
            g.flowOut === "top" ? [NEG, g.rFrom] : [g.rFrom, POS],
            g.goalOut === "top" ? [g.rTo, POS] : [NEG, g.rTo],
        );
        if (!g.band) { g.kind = "search"; g.reason = "两条竖直腿的可行半平面不相交"; g.band = null; }
        return g;
    }
    if (!isVert(g.flowOut) && !isVert(g.goalOut) && g.rFrom !== g.rTo) {
        g.kind = "vlane"; g.laneAxis = "col";
        g.interval = [Math.min(g.rFrom, g.rTo), Math.max(g.rFrom, g.rTo)];   // 沿列轴张开的行区间
        g.band = intersect(
            g.flowOut === "left" ? [NEG, g.cFrom] : [g.cFrom, POS],
            g.goalOut === "left" ? [g.cTo, POS] : [NEG, g.cTo],
        );
        if (!g.band) { g.kind = "search"; g.reason = "两条水平腿的可行半平面不相交"; g.band = null; }
        return g;
    }
    // 6) 兜底（一竖一横但两腿都反向、同列反向等）→ 交给带朝向 Dijkstra
    g.kind = "search";
    g.reason = `端点朝向不构成单调折线（flowOut=${g.flowOut} goalOut=${g.goalOut} first=${first} last=${last}）`;
    return g;
}

function intersect(...ranges) {
    let lo = NEG, hi = POS;
    for (const r of ranges) { if (r == null) return null; lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]); }
    return lo <= hi ? [lo, hi] : null;
}

/** 单拐角判据：corner 处 solveTurn(OPP[flowOut], goalOut) 由 route.mjs 求，这里只管几何 */
function tryElbow(g) {
    if (isVert(g.flowOut) && !isVert(g.goalOut)) {
        const corner = [g.cFrom, g.rTo];                    // 先竖走到目标行，再横着进机器
        if (!sameCell(corner, g.first) && !sameCell(corner, g.last) &&
            monotoneAlong(g.first, corner, g.flowOut) && monotoneAlong(corner, g.last, g.goalOut)) {
            return { kind: "elbow", corner };
        }
    }
    if (!isVert(g.flowOut) && isVert(g.goalOut)) {
        const corner = [g.cTo, g.rFrom];                    // 先横走到目标列，再竖着进机器
        if (!sameCell(corner, g.first) && !sameCell(corner, g.last) &&
            monotoneAlong(g.first, corner, g.flowOut) && monotoneAlong(corner, g.last, g.goalOut)) {
            return { kind: "elbow", corner };
        }
    }
    return null;
}

/**
 * 形态 → 依次经过的格（占位与链闭合用；不含 (rot,rv)）。
 * 车道型必须给 laneFixed；search 无法在这里展开（返回 null）。
 * @param {object} g @param {number} [laneFixed] @returns {Array<[number,number]>|null}
 */
export function geomCells(g, laneFixed) {
    if (g.kind === "direct") return [];
    if (g.kind === "single") return [g.first];
    if (g.kind === "straight") return spanCells(g.first, g.last);
    if (g.kind === "elbow") {
        const a = spanCells(g.first, g.corner), b = spanCells(g.corner, g.last);
        return a && b ? [...a, ...tail(b)] : null;
    }
    if (laneFixed === undefined || laneFixed === null) return null;
    if (g.kind === "hlane") {
        const r = laneFixed;
        const legA = spanCells(g.first, [g.cFrom, r]);
        const lane = spanCells([g.cFrom, r], [g.cTo, r]);
        const legB = spanCells([g.cTo, r], g.last);
        return legA && lane && legB ? [...legA, ...tail(lane), ...tail(legB)] : null;
    }
    if (g.kind === "vlane") {
        const c = laneFixed;
        const legA = spanCells(g.first, [c, g.rFrom]);
        const lane = spanCells([c, g.rFrom], [c, g.rTo]);
        const legB = spanCells([c, g.rTo], g.last);
        return legA && lane && legB ? [...legA, ...tail(lane), ...tail(legB)] : null;
    }
    return null;
}

/**
 * 形态 → 需要转向的格（拐角计数与 rv 求解的输入）。
 * 车道型每条**恒两个**拐角（进道/出道）—— 即使车道行正好等于 first/last 的行：
 * 那一格照样要「从上游面进货、朝车道方向出货」，垂向 → 横向必然是弯带（实机 M4 就是这种）。
 * inDir=本格进货面、outDir=本格出货面（世界方位，一律由流向 + OPP 算出，不新写方向逻辑）。
 * @param {object} g @param {number} [laneFixed]
 * @returns {Array<{cell:number[], inDir:string, outDir:string, where:string}>}
 */
export function geomCorners(g, laneFixed) {
    if (g.kind === "elbow") return [{ cell: g.corner, inDir: OPP[g.flowOut], outDir: g.goalOut, where: "elbow" }];
    if (g.kind === "hlane") {
        if (laneFixed == null) return [];
        const h = g.cTo > g.cFrom ? "right" : "left";             // 车道上的前进方向
        return [
            { cell: [g.cFrom, laneFixed], inDir: OPP[g.flowOut], outDir: h, where: "lane-in" },
            { cell: [g.cTo, laneFixed], inDir: OPP[h], outDir: g.goalOut, where: "lane-out" },
        ];
    }
    if (g.kind === "vlane") {
        if (laneFixed == null) return [];
        const v = g.rTo > g.rFrom ? "bottom" : "top";
        return [
            { cell: [laneFixed, g.rFrom], inDir: OPP[g.flowOut], outDir: v, where: "lane-in" },
            { cell: [laneFixed, g.rTo], inDir: OPP[v], outDir: g.goalOut, where: "lane-out" },
        ];
    }
    return [];
}

/* ───────────────────────────── 阻挡集合 ───────────────────────────── */

/**
 * 不可布格 = 机器占地 ∪ hub 4×4 ∪ 既有 occupancy ∪ extra（已铺/已占的通道格）。
 * v1 铁律：任何非空格都不许压（constraints C1 paste 静默毁带；scope.tunnels:false）。
 * @param {object} report @param {{hubOrigin?:number[]|null, extra?:Iterable<string>}} [opts]
 * @returns {{blocked:Set<string>, why:Map<string,string>}}
 */
export function buildBlocked(report, opts = {}) {
    const blocked = new Set(), why = new Map();
    const mark = (x, y, reason) => {
        const k = cellKey(x, y);
        if (!blocked.has(k)) { blocked.add(k); why.set(k, reason); }
    };
    for (const p of report.placements || []) {
        if (!isAngle(p.rot)) throw new ContractViolation(`lane.buildBlocked(${p.nodeId}).rot`, "0|90|180|270", p.rot);
        const [w, h] = p.footprint;
        // 决策 D1：机器恒 r=0 ⇒ 占地不旋转（rot≠0 的 origin 位移真值属 P2 且未实机验证）
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) mark(p.cell[0] + dx, p.cell[1] + dy, `machine:${p.nodeId}(${p.kind})`);
        if (p.kind === "hub") for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) mark(p.cell[0] + dx, p.cell[1] + dy, "hub:4x4");
    }
    if (opts.hubOrigin) {
        const [hx, hy] = opts.hubOrigin;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) mark(hx + dx, hy + dy, "hub:4x4");
    }
    for (const o of report.occupancy || []) mark(o.cell[0], o.cell[1], `world:${o.state}${o.who ? "/" + o.who : ""}`);
    for (const k of opts.extra || []) if (!blocked.has(k)) { blocked.add(k); why.set(k, "pending-belt"); }
    return { blocked, why };
}

/* ───────────────────────────── left-edge 核心 ───────────────────────────── */

/**
 * 左边缘（left-edge）首次适配区间着色 = 2 层 dogleg channel routing 的 track 分配。
 * routing-prior-art §1 的实测：无 vertical constraint 时 27405 例穷举**全部等于色数最优**；
 * 作者把 vertical constraint 也算进冲突判据后，首适仍没出现次优 → 本实现照抄这个判据。
 *
 * 冲突判据：
 *   C1 闭区间重叠 —— **共用端点也算冲突**：端点那一格会被两条车道同时占据，
 *      且两条车道在端点处的进出方向相反 → 正是陷阱 #1 的死循环形状。
 *   C2 vertical constraint —— 同一 group（同一 sink 机器）里，两条车道的源序与宿序相反。
 *      （在同一轴上 C1 已能推出「不重叠 ⇒ 保序」，C2 作为**显式判据**保留：
 *        换轴（hlane vs vlane 并存）时 C1 不再蕴含 C2，L0 有用构造样例锁它生效。）
 *   C3 opts.feasible(fixed, iv) —— 该轨道在此区间被占地/hub/旧厂/别的通道挡住。
 *
 * @param {Array<{id:string, lo:number, hi:number, src?:number, dst?:number,
 *                group?:string|null, candidates:number[]}>} intervals
 *        candidates = 该通道可用的轨道值，**已按调用方偏好排序**（决定"新开哪一行"的确定性）
 * @param {{tracks?: Array<{fixed:number, ivs:Array}>, maxTracks?:number,
 *          feasible?: (fixed:number, iv:object)=>boolean,
 *          onAssign?: (fixed:number, iv:object)=>void}} [opts]
 * @returns {{assign:Map<string,number>, tracks:Array<{fixed:number, ids:string[]}>,
 *            unresolved:Array<{iv:object, tried:number[]}>}}
 */
export function leftEdge(intervals, opts = {}) {
    const maxTracks = opts.maxTracks == null ? 32 : assertInt(opts.maxTracks, "lane.leftEdge.maxTracks");
    const feasible = opts.feasible || (() => true);
    const onAssign = opts.onAssign || (() => {});

    const tracks = new Map();                       // fixed → {fixed, ivs:[…]}
    const open = fixed => { if (!tracks.has(fixed)) tracks.set(fixed, { fixed, ivs: [] }); return tracks.get(fixed); };
    const assigned = new Map();
    for (const t of opts.tracks || []) {
        const tr = open(t.fixed);
        for (const iv of t.ivs || []) { tr.ivs.push(iv); if (!assigned.has(iv.id)) assigned.set(iv.id, t.fixed); }
    }

    // 扫描序 = left-edge 的经典序：左端升序 → 右端升序 → id。
    // ⚠️ id 平局必须用**码点序**（`<`/`>`），不许用 `String.prototype.localeCompare`：
    //   localeCompare 走 ICU 权重表，`#`(0x23) / `@`(0x40) / `[`(0x5B) 这类我们 channelIdOf
    //   会生成的分隔符在 ICU 里被当成 variable/punctuation 权重，与码点序**结论相反**
    //   （实测 `mA->st#0` vs `mA->st@0`：localeCompare=+1，码点序=-1）。平局决定的是
    //   **谁先占哪条车道行** → 换机器/换 ICU 就会产出不同的 lanes[]，破坏 L0 验收 7「确定性」
    //   与 P5 变异测试、P7 逐格 diff 的前提（plan §4「金网格逐字节相等、无随机」）。
    const cmpId = (a, b) => { const x = String(a.id), y = String(b.id); return x < y ? -1 : x > y ? 1 : 0; };
    const order = [...intervals].sort((a, b) => a.lo - b.lo || a.hi - b.hi || cmpId(a, b));

    const conflictKindWith = (tr, cand) => {
        for (const iv of tr.ivs) {
            if (iv.lo <= cand.hi && cand.lo <= iv.hi) return "interval";
            if (iv.group != null && cand.group != null && iv.group === cand.group &&
                Number.isInteger(iv.src) && Number.isInteger(cand.src) &&
                Number.isInteger(iv.dst) && Number.isInteger(cand.dst) &&
                (iv.src - cand.src) * (iv.dst - cand.dst) < 0) return "vertical";
        }
        return null;
    };

    const unresolved = [];
    for (const cand of order) {
        if (assigned.has(cand.id)) continue;
        const tried = [];
        let chosen = null;
        for (const fixed of cand.candidates) {      // 调用方排好序 → first-fit 即 left-edge
            tried.push(fixed);
            const tr = tracks.get(fixed);
            if (tr && conflictKindWith(tr, cand)) continue;
            if (!feasible(fixed, cand)) continue;
            if (!tr && tracks.size >= maxTracks) continue;   // 轨道预算上限（不是"放弃"，是预算）
            chosen = fixed; break;
        }
        if (chosen === null) { unresolved.push({ iv: cand, tried }); continue; }
        open(chosen).ivs.push(cand);
        assigned.set(cand.id, chosen);
        onAssign(chosen, cand);
    }
    return {
        assign: assigned,
        tracks: [...tracks.values()].sort((a, b) => a.fixed - b.fixed).map(t => ({ fixed: t.fixed, ids: t.ivs.map(iv => iv.id) })),
        unresolved,
    };
}

/* ───────────────────────────── 主入口 ───────────────────────────── */

/**
 * 给 LayoutReport 分配车道：写回 channels[].lane + channels[].laneAxis 与 lanes[]。
 * lanes[] 的条目 = `{row, column, channelIds}`（恰一个非 null，LANE_SCHEMA_VERSION=2）。
 * 落地顺序（prior-art §8 + §6「cell_footprint 预占 + 串行加障碍」）：
 *   0) 无车道形态（direct/single/straight/elbow）先占格 → 后来的通道看得见这些格
 *   1) P3 预分配 lane 的 hlane 通道先采纳（可行就原样保留，不可行则重排并记 resolvedBy=shift-x）
 *   2) 其余 hlane 按 left-edge 分 row；每分一条就把它的全部格加进占用集 → 下一条看得见
 *   3) vlane 按 left-edge 分 col（默认参与；`opts.allowVerticalLane === false` 显式关掉 = 只许 hlane 的诊断口径）。
 *      col 与 row **各自独立预算**（maxLanes 是每轴上限）：一条竖直车道不挤占水平车道的行数。
 *   4) search 形态留给 route.mjs 的带朝向 Dijkstra（不在这里判死）
 * 任一车道型通道找不到可行轨道 / 任一通道的格压到基座或别的通道 → ok:false +
 *   reason:"dag-not-placeable:column-conflict-unresolved"（占地类）或
 *   "dag-not-placeable:crossing-needs-tunnel"（需分层）。
 * 被标进 unresolvedChannels 的通道，route.mjs **必须整条跳过**（不留半成品 IR 流向 P5/P6）。
 *
 * @param {object} report LayoutReport（**不修改入参**）
 * @param {{hubOrigin?:number[]|null, maxLanes?:number, searchRadius?:number,
 *          preAssign?:boolean, allowVerticalLane?:boolean,
 *          prefer?: (candidates:number[], iv:object)=>number[]}} [opts]
 * @returns {{ok:boolean, reason:string|null, hint:string|null, report:object, geoms:object[],
 *            blocked:{blocked:Set,why:Map}, laneRows:Map, colLanes:Map, conflicts:object[],
 *            cellsByChannel:Map, cornerCells:object[], laneAxis:Map, trackAxis:Map,
 *            unresolvedChannels:Set}}
 */
export function assignLanes(report, opts = {}) {
    if (!report || typeof report !== "object" || !Array.isArray(report.channels)) {
        throw new ContractViolation("lane.assignLanes(report.channels)", "LayoutReport 的 channels 数组（§2.3）", report && report.channels);
    }
    const R = opts.searchRadius == null ? 16 : assertInt(opts.searchRadius, "assignLanes.opts.searchRadius");
    const maxLanes = opts.maxLanes == null ? 24 : assertInt(opts.maxLanes, "assignLanes.opts.maxLanes");
    const geoms = report.channels.map((ch, i) => channelGeom(ch, i));
    /* ★ P3 已逐格铺好、且 P4 无法自行重算的通道：**只限含隧道的那些** ★
       含隧道的通道端点对在 `channelGeom` 看来往往"不可布"（P3 是穿过去的），
       P4 重算会把它判死 —— 所以这几条整条采纳 P3 的路径。
       ⚠️ **不能把所有 beltCells 都算进来**：那等于让 P4 完全不做车道分配，
          `CrCrCrCr` 的 col 车道就凭空消失了（回归会红）。
       判据：这条通道的 beltCells 里是否出现 `tunnel` 标记。 */
    const preRouted = new Set();
    if (Array.isArray(report.beltCells)) {
        const byCh = new Map();
        for (const b of report.beltCells) {
            if (!byCh.has(b.channelId)) byCh.set(b.channelId, []);
            byCh.get(b.channelId).push(b);
        }
        for (const [cid, list] of byCh) if (list.some(b => b.tunnel)) preRouted.add(cid);
    }
    const conflicts = [];
    const cornerCells = [];
    const unresolvedChannels = new Set();   // 有未解决冲突的通道：route.mjs **必须跳过**（不留半成品 IR）
    const laneRows = new Map();     // channelId → row（进契约 lanes[]）
    const colLanes = new Map();     // channelId → col（v1 默认不产）
    const laneAxis = new Map();     // channelId → "row" | "col"
    const trackAxis = new Map();    // axis → 该轴上的轨道数（left-edge 新开计数）
    const cellsByChannel = new Map();

    /* 占用集：既有世界/机器由 buildBlocked 给；通道格在这里累加（串行加障碍） */
    const occ = new Set();
    const baseBlocked = buildBlocked(report, { hubOrigin: opts.hubOrigin });
    const isBase = (x, y) => baseBlocked.blocked.has(cellKey(x, y));
    const whyBase = (x, y) => baseBlocked.why.get(cellKey(x, y)) || null;
    let view = baseBlocked;
    const rebuild = () => { view = buildBlocked(report, { hubOrigin: opts.hubOrigin, extra: occ }); };
    const free = (x, y) => !view.blocked.has(cellKey(x, y));

    /** 把一条通道的格计入占用；撞到基座（机器/hub/旧厂）或别的通道 → 记 conflict 并把该通道标为未解决 */
    const occupy = (g, cells) => {
        for (const c of cells) {
            const k = cellKey(c[0], c[1]);
            if (isBase(c[0], c[1])) {
                const w = whyBase(c[0], c[1]) || "";
                conflicts.push({
                    kind: w.startsWith("hub:") ? CONFLICT_KIND.hub : CONFLICT_KIND.occupied,
                    cells: [c], nodeIds: [g.ch.from.nodeId, g.ch.to.nodeId], resolvedBy: null,
                });
                unresolvedChannels.add(g.id);      // C1：v1 绝不覆盖既有世界 → 这条通道整条不铺
            } else if (occ.has(k)) {
                // 两股流共用一格 = 陷阱 #1 的死循环形状；v1 只能靠隧道分层 → 显式判死
                conflicts.push({ kind: CONFLICT_KIND.crossing, cells: [c],
                    nodeIds: [g.ch.from.nodeId, g.ch.to.nodeId], resolvedBy: null });
                unresolvedChannels.add(g.id);
            }
            occ.add(k);
        }
        rebuild();
    };

    /* ── 阶段 0：无车道形态先占格 ── */
    for (const g of geoms) {
        if (preRouted.has(g.id)) continue;        // P3 已铺好（含隧道）：不参与车道/占格
        if (g.kind === "direct") { cellsByChannel.set(g.id, []); continue; }   // 0 格：不占、不铺
        if (g.kind === "search" || g.kind === "hlane" || g.kind === "vlane") continue;
        const cells = geomCells(g);
        if (!cells) continue;
        cellsByChannel.set(g.id, cells);
        cornerCells.push(...geomCorners(g).map(c => ({ ...c, channelId: g.id })));
        occupy(g, cells);
    }

    /* ── 车道通用：候选轨道（已按偏好排序）+ 可行性 ── */
    const windowFor = band => {
        const lo = Number.isFinite(band[0]) ? band[0] : null;
        const hi = Number.isFinite(band[1]) ? band[1] : null;
        if (lo !== null && hi !== null) return [lo, hi];
        if (lo !== null) return [lo, lo + R];
        if (hi !== null) return [hi - R, hi];
        return null;
    };
    const laneCells = (iv, fixed) => geomCells(iv.g, fixed);
    const feasibleLane = (iv, fixed) => {
        const cells = laneCells(iv, fixed);
        if (!cells || !cells.length) return false;
        return cells.every(c => free(c[0], c[1]));
    };
    const candidatesFor = iv => {
        const win = windowFor(iv.g.band);
        if (!win) return [];
        const vals = [];
        for (let v = win[0]; v <= win[1]; v++) if (feasibleLane(iv, v)) vals.push(v);
        // 偏好：车道紧贴**下游机器**那一侧（M4 的车道贴着目标行 → 竖直腿最短、拐角最少）
        const anchor = iv.g.laneAxis === "row" ? iv.g.rTo : iv.g.cTo;
        vals.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor) || a - b);
        return opts.prefer ? opts.prefer(vals, iv) : vals;
    };
    const toInterval = g => ({
        id: g.id, lo: g.interval[0], hi: g.interval[1],
        src: g.laneAxis === "row" ? g.cFrom : g.rFrom,
        dst: g.laneAxis === "row" ? g.cTo : g.rTo,
        group: g.ch.to.nodeId,          // vertical constraint 的分组键 = 同一台下游机器
        g, get candidates() { return candidatesFor(this); },
    });

    /* ── 未落轨道的通道：记 lane-column（整条不铺）──
     * leftEdge 只回答「所有候选轨道都不可行」；本层按 §2.3 的口径记 kind=lane-column
     * （轨道预算/整页排布问题）。**真交叉不由这里判**：两股流要同一格时，
     * 先落定的那条把格加进 occ，后一条的候选全部不可行 → 也走到这里（记 lane-column），
     * 但 route.mjs 的产出锁 counterDirectedCells 与 dijkstra 失败会独立给出
     * crossing-needs-tunnel —— 两条语义各自可归因，不在这里混为一谈。 */
    const addUnresolved = iv => {
        unresolvedChannels.add(iv.id);
        conflicts.push({
            kind: CONFLICT_KIND.lane,
            cells: [[iv.g.cFrom, iv.g.rFrom], [iv.g.cTo, iv.g.rTo]],
            nodeIds: [iv.g.ch.from.nodeId, iv.g.ch.to.nodeId], resolvedBy: null,
        });
    };

    /* ── 阶段 1：hlane（水平车道 = row）── */
    const hgeoms = geoms.filter(g => g.kind === "hlane" && !preRouted.has(g.id));
    const preTracks = [];
    const htodo = [];
    for (const g of hgeoms) {
        const iv = toInterval(g);
        if (opts.preAssign !== false && Number.isInteger(g.ch.lane)) {
            const r = g.ch.lane;
            const inBand = r >= g.band[0] && r <= g.band[1];
            if (inBand && feasibleLane(iv, r) && !laneRows.has(g.id)) {
                // 采纳 P3 的车道；同 row 若与已采纳者区间重叠 → 由 leftEdge 的 C1 判据兜住
                preTracks.push({ fixed: r, ivs: [iv] });
                laneRows.set(g.id, r); laneAxis.set(g.id, "row");
                const cells = geomCells(g, r);
                cellsByChannel.set(g.id, cells);
                cornerCells.push(...geomCorners(g, r).map(c => ({ ...c, channelId: g.id })));
                for (const c of cells) occ.add(cellKey(c[0], c[1]));
                rebuild();
                markResolved(g, RESOLVED_BY.preAssigned, r);
                continue;
            }
            htodo.push({ iv, moved: true });       // P3 给的不可行 → 重排（记 shift-x）
            // 先清掉可能已被 occupy 标过的记录：重排成功就不算未解决
            continue;
        }
        htodo.push({ iv, moved: false });
    }
    const hRes = leftEdge(htodo.map(t => t.iv), {
        tracks: preTracks, maxTracks: maxLanes,
        feasible: (fixed, iv) => feasibleLane(iv, fixed),
        onAssign: (fixed, iv) => {
            laneRows.set(iv.id, fixed); laneAxis.set(iv.id, "row");
            const cells = geomCells(iv.g, fixed);
            cellsByChannel.set(iv.id, cells);
            cornerCells.push(...geomCorners(iv.g, fixed).map(c => ({ ...c, channelId: iv.id })));
            for (const c of cells) occ.add(cellKey(c[0], c[1]));
            rebuild();
            const moved = (htodo.find(t => t.iv.id === iv.id) || {}).moved;
            markResolved(iv.g, moved ? RESOLVED_BY.moved : RESOLVED_BY.newRow, fixed);
        },
    });
    trackAxis.set("row", hRes.tracks.length);
    for (const u of hRes.unresolved) addUnresolved(u.iv);

    /* ── 阶段 2：vlane（竖直车道 = col）──
     * 默认参与分配（契约 v2 起 lanes[] 能表达 column）。`allowVerticalLane === false` 是
     * **显式关闭**的诊断口径（只许 hlane）：此时每条 vlane 记 lane-column 冲突并整条跳过，
     * 让上层看到「这个目标需要竖直车道」而不是偷偷铺出它。
     * ⚠️ 与阶段 1 的 hlane 一样，**每一步 onAssign 都把格加进 occ 再 rebuild**：
     *   串行加障碍 ⇒ 后分配的车道看得见先分配的；两股流要同一格时后一条的候选全不可行
     *   （记 lane-column，整条不铺），而 route.mjs 的产出锁 counterDirectedCells 会独立给出
     *   crossing-needs-tunnel —— 真交叉绝不被「打开 vlane」抹成成功。 */
    const vgeoms = geoms.filter(g => g.kind === "vlane" && !preRouted.has(g.id));
    if (vgeoms.length && opts.allowVerticalLane === false) {
        for (const g of vgeoms) {
            unresolvedChannels.add(g.id);
            conflicts.push({
                kind: CONFLICT_KIND.lane,
                cells: [[g.cFrom, g.rFrom], [g.cTo, g.rTo]],
                nodeIds: [g.ch.from.nodeId, g.ch.to.nodeId], resolvedBy: null,
            });
        }
    } else if (vgeoms.length) {
        const vIvs = vgeoms.map(toInterval);
        const vRes = leftEdge(vIvs, {
            maxTracks: maxLanes,
            feasible: (fixed, iv) => feasibleLane(iv, fixed),
            onAssign: (fixed, iv) => {
                colLanes.set(iv.id, fixed); laneAxis.set(iv.id, "col");
                const cells = geomCells(iv.g, fixed);
                cellsByChannel.set(iv.id, cells);
                cornerCells.push(...geomCorners(iv.g, fixed).map(c => ({ ...c, channelId: iv.id })));
                for (const c of cells) occ.add(cellKey(c[0], c[1]));
                rebuild();
                markResolved(iv.g, RESOLVED_BY.newCol, fixed);
            },
        });
        trackAxis.set("col", vRes.tracks.length);
        for (const u of vRes.unresolved) addUnresolved(u.iv);
    }

    /* ── 阶段 3：写回 channels[].lane + channels[].laneAxis / lanes[]（§2.3, LANE_SCHEMA_VERSION=2）──
     * 车道身份 = (轴, 下标)：row 与 col **分开汇总**。row=3 与 column=3 是两条不同车道，
     * 压进同一个 `lanes[]` 数组但各自带轴字段；判重/比较一律用 "row:3" / "col:3" 的键。 */
    const rowToIds = new Map(), colToIds = new Map();
    for (const [id, r] of laneRows) { if (!rowToIds.has(r)) rowToIds.set(r, []); rowToIds.get(r).push(id); }
    for (const [id, c] of colLanes) { if (!colToIds.has(c)) colToIds.set(c, []); colToIds.get(c).push(id); }
    const byIndex = a => a.sort((x, y) => x[0] - y[0]);
    const lanes = [
        ...byIndex([...rowToIds.entries()]).map(([row, ids]) => ({ row, column: null, channelIds: [...ids].sort() })),
        ...byIndex([...colToIds.entries()]).map(([column, ids]) => ({ row: null, column, channelIds: [...ids].sort() })),
    ];

    /**
     * channels[].lane / laneAxis 的**规范化**（L0 验收 ⑬ 的互逆判据：
     *   `channels[].lane !== null` ⟺ 该 id 在 lanes[] 里有一条车道、下标===lane、轴===laneAxis）。
     * 只有**真的占用了一条车道**的通道才带 lane/laneAxis；P3 给 non-lane 形态
     * （direct/single/straight/elbow/search）留的 lane 数字是**陈旧值**，原样保留会产出一份
     * 「channels 说有行 7、lanes[] 里没有行 7」的自相矛盾报告（types.mjs 的
     * assertLayoutReport 抓不到，但 P5 的 V4/V6 与 P6 的 lanes 排序凭据会被它喂错）。
     * ⇒ 未落定的通道一律回写 lane:null（清空陈旧值，不是保留）+ laneAxis:null。
     * ⚠️ laneAxis **总是**显式写（占车道的写 "row"|"col"，未占的写 null）：
     *   「缺省 = row」只对**读**旧报告（v1 fixture）成立；P4 的产出必须自描述，
     *   否则 `{lane:3}` 让下游只能猜它是行还是列 —— 那正是 v1 契约的漏洞。
     */
    const channels = report.channels.map((ch, i) => {
        const id = geoms[i].id;
        const r = laneRows.get(id), c = colLanes.get(id);
        if (r !== undefined) return { ...ch, lane: r, laneAxis: "row" };
        if (c !== undefined) return { ...ch, lane: c, laneAxis: "col" };
        return ch.lane === null && ch.laneAxis === null ? ch : { ...ch, lane: null, laneAxis: null };
    });

    /**
     * conflicts[].resolvedBy 回写（执行书要求「更新后的 LayoutReport：lanes 填上、conflicts.resolvedBy」）。
     *
     * ⚠️ **只标注真正被本次分配消解的条目**：P4 全绿时，入参里 resolvedBy===null 且
     *   kind==="lane-column" 的条目 → 记 left-edge-new-row（确实是本次车道分配让它们各行其道）；
     *   其它 kind 的 null 条目**不许**盖同一个戳 —— 「left-edge 新开一行」并没有消解一个
     *   cell-occupied / no-turn / crossing 冲突，给它记这个解法是**谎报归因**
     *   （承 P7 的 belt-silent-overwrite 教训：报告不能声称做了它没做的事）。
     *   这类条目保持 null，交 P5 的对应 Vn 判定；P3 已写了字符串的条目**原样保留**。
     */
    const unresolvedFor = k => conflicts.filter(c => c.kind === k && c.resolvedBy === null).length;
    const nLane = unresolvedFor(CONFLICT_KIND.lane);
    const nCross = unresolvedFor(CONFLICT_KIND.crossing);
    const nOcc = unresolvedFor(CONFLICT_KIND.occupied);
    const nHub = unresolvedFor(CONFLICT_KIND.hub);
    // 本层（车道分配）只对自己的失败判死；其它 kind 由 route.mjs 的铺格阶段负责。
    const ok = nLane === 0 && nCross === 0 && nOcc === 0 && nHub === 0;
    // reason 优先级：需分层 > 车道争用；占地类与 hub 争用也归到 §2.5 的 column-conflict-unresolved
    // （v1 没有专门的「撞既有世界」枚举值，plan §2.5 的 16 项里这一条语义最贴；不新增枚举报主 Agent）。
    const reason = !ok
        ? (nCross > 0 ? "dag-not-placeable:crossing-needs-tunnel"
            : "dag-not-placeable:column-conflict-unresolved")
        : null;

    const inputConflicts = (report.conflicts || []).map(c =>
        (ok && (c.resolvedBy === null || c.resolvedBy === undefined) && c.kind === CONFLICT_KIND.lane)
            ? { ...c, resolvedBy: RESOLVED_BY.newRow } : c);

    return {
        ok, reason,
        hint: ok ? null : "v1 不开隧道（scope.tunnels:false）：按 M4-SUCCESS 关键 1 让一条分支竖直直入、"
            + "其余分支各占不同行车道（陷阱 #5）；仍无解则加宽行距或换 site。",
        report: { ...report, channels, lanes, conflicts: [...inputConflicts, ...conflicts] },
        geoms, blocked: view, laneRows, colLanes, laneAxis, trackAxis,
        conflicts, cellsByChannel, cornerCells, unresolvedChannels,
    };
}

/**
 * 记录「这条冲突被什么解法解决了」。plan §2.3 的 conflicts[].resolvedBy 是字符串|null；
 * P5 复核用它区分「已消解」与「留给 v2 隧道」。只在确实发生了轨道选择时记一条。
 */
const resolvedSeen = new WeakSet();
function markResolved(g, how, fixed) {
    if (!g || resolvedSeen.has(g)) return;
    resolvedSeen.add(g);
    g.resolvedBy = how; g.laneFixed = fixed;      // 挂在 geom 上，route.mjs 直接读
}
