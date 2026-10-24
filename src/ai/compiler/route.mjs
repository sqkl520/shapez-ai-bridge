/**
 * route.mjs — P4 router：把 LayoutReport.channels[] 铺成带子格序列（每格显式 (rot,rv,code)）。
 *
 * 权威依据：
 *   research/ai-player/plan-compiler.md §1.4（本包）/ §2.3（LayoutReport）/ §2.5（reason 枚举）
 *   src/ai/belt-rules.mjs —— **唯一方向权威**：solveTurn / beltCode / beltEntry / beltExit /
 *     rotateLocal / OPP / DIRV。本文件**不写任何方向换算**（除取 OPP）。
 *     禁 import research/ai-player/proto/**（proto/belt-rules.mjs:49 的 beltEntry=OPP[beltExit]
 *     对弯带是错的 → 整条 L 形 rv 全错；判据在 research/ai-plan/contract/lint-imports.mjs）。
 *   research/ai-player/routing-prior-art.md §6（带朝向搜索的移植要点 + 三条陷阱）、§8（选型：
 *     主干 = left-edge 车道（lane.mjs）+ **带朝向 Dijkstra（不是 A\*）** 只铺 lane 内格与兜底）
 *   facts/MILESTONE-M4-partial-and-pitfalls.md 陷阱 #1/#3/#5、facts/MILESTONE-M4-SUCCESS.md
 *   research/ai-player/verify-belt-rules.md §3.1（邻居双侧闭合判据 —— 本包 L0 验收 1 的依据）
 *
 * 三条不可混的失败语义（prior-art §6「不可行上报（本项目红线）」）：
 *   cell-occupied → 走廊被占；crossing → 需隧道；no-turn → 端点朝向无解。
 *   熔断（pops 预算耗尽）用独立 reason，**不复用**「无路」。
 *
 * 弯带代价：0.78 是 `components/belt.js:6` 的 **curvedBeltLength（弯带弧长）**，
 *   不是容量系数；到 item-capacity 的换算没有任何一手文档给出（prior-art §7 明令）→
 *   本包只做 `cornerCostTiles = corners × 0.78` 的**有效格折算**并上报，
 *   **不进代价函数、不宣称折算成吞吐**。P5 的 V7 用它。
 *
 * 零依赖：ESM + node: 内置 + ../belt-rules.mjs + ./grid.mjs + ./errors.mjs + ./lane.mjs。
 */

import { ORDER, OPP, DIRV, solveTurn, beltCode, beltEntry, beltExit } from "../belt-rules.mjs";
import { cellKey } from "./grid.mjs";
import { ContractViolation, assertInt, makeFailure, isFailureReason } from "./errors.mjs";
import {
    assignLanes, channelGeom, geomCells, geomCorners, leftEdge, CONFLICT_KIND, RESOLVED_BY,
} from "./lane.mjs";

export const ROUTE_SCHEMA_VERSION = 1;

/** 弯带有效长度（`recon/upstream-full/src/js/game/components/belt.js:6` curvedBeltLength）。
 *  ⚠️ 它是**弧长**（rv0=1.0 格，rv1/rv2=0.78 格）—— 不是容量折扣（prior-art §7）。 */
export const CURVED_BELT_LENGTH = 0.78;
export const STRAIGHT_BELT_LENGTH = 1.0;
/** 一个拐角相对直带的「有效格」成本 = 1 - 0.78 = 0.22；折算量 = corners × 0.78 有效格。 */
export const CORNER_COST_TILES = CURVED_BELT_LENGTH;

/** 带朝向搜索的代价（prior-art §6：turnCost = 2 × straightCost，两个独立外部项目分别给 2 与 2.5） */
export const STEP_COST = 1;
export const TURN_COST = 2;
/** 熔断预算（状态数上限），耗尽 → 独立语义，不许混成「无路」 */
export const SEARCH_POP_CAP = 4000;
/** 隧道最大跨度（基础 tier 的 sender↔receiver 间距）。与 place.mjs 的 TUNNEL_MAX_SPAN 同值；
 *  route.mjs 不 import place.mjs（依赖方向只能是 P4 → 更低层），所以这里独立声明一份。 */
export const TUNNEL_MAX_SPAN = 4;

/* ───────────────────────────── 结构化内部错误 ───────────────────────────── */

/**
 * 内部不变量破了的错误（端点对不齐、链不闭合）—— **不是**业务失败。
 * 业务失败一律 makeFailure（§2.5 枚举 + ok:false + 永不 throw，plan §2.5 / errors.mjs 头注）。
 * 继承 ContractViolation 以复用它的 {path, rule, got, aggregated} 结构与聚合能力。
 */
export class RouteError extends ContractViolation {
    /** @param {string} path @param {string} rule @param {unknown} got */
    constructor(path, rule, got) {
        super(path, rule, got);
        this.name = "RouteError";
    }
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

const idxOf = d => ORDER.indexOf(d);
const sgn = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** 沿 dir 走一格 */
function advance(cell, dir) { return [cell[0] + DIRV[dir][0], cell[1] + DIRV[dir][1]]; }
function sameCell(a, b) { return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }

/**
 * 轴对齐直线填充（plan §1.4「直线段：轴对齐填充」）。**不许**用 solveTurn 判直行 ——
 * solveTurn(d,d) 恒 null（belt-rules.mjs:46，shapez-auto 的 BeltPose 同病，prior-art §7 反面教材），
 * 所以直行格固定走 rv0，只把 (inDir,outDir) 交给 solveTurn 求 rot（inDir=OPP[outDir] 必然有解）。
 * @param {[number,number]} from @param {[number,number]} to @param {string} dir
 * @returns {Array<[number,number]>|null} 不同轴或反向 → null
 */
export function straightCells(from, to) {
    if (from[0] === to[0]) {
        const s = sgn(to[1] - from[1]);
        if (!s) return [[from[0], from[1]]];
        const out = [];
        for (let y = from[1]; ; y += s) { out.push([from[0], y]); if (y === to[1]) break; }
        return out;
    }
    if (from[1] === to[1]) {
        const s = sgn(to[0] - from[0]);
        if (!s) return [[from[0], from[1]]];
        const out = [];
        for (let x = from[0]; ; x += s) { out.push([x, from[1]]); if (x === to[0]) break; }
        return out;
    }
    return null;
}

/**
 * 逐格 (inDir,outDir) → (rot,rv,code)。**唯一的 rv 来源** = belt-rules.solveTurn。
 * @param {string} inDir @param {string} outDir @returns {{rotation:number, rotationVariant:number, code:number}|null}
 */
export function poseOf(inDir, outDir) {
    const p = solveTurn(inDir, outDir);
    if (!p) return null;
    return { rotation: p.rotation, rotationVariant: p.rotationVariant, code: beltCode(p.rotationVariant) };
}

/**
 * 由格序列 + 端点流向算出每格的 (inDir,outDir)。
 * 规则：`inDir(k) = OPP[flow(k-1)]`，`outDir(k) = flow(k)`，其中 flow(-1)=OPP[from.outDir] 的
 * **反向**即从上游机器出来的流向 = from.outDir；末格 outDir = goalOut = OPP[to.inDir]。
 * @param {Array<[number,number]>} cells
 * @param {{flowOut:string, goalOut:string, first:number[], last:number[]}} g
 * @returns {Array<{inDir:string, outDir:string}>}
 */
function dirsAlong(cells, g) {
    if (!cells.length) return [];
    if (cells.length === 1) {
        // 退化段：入口面 = OPP[flowOut] 的反面？不 —— 首格既是首又是末：
        // 上游机器从 flowOut 面喷过来 ⇒ 本格进货面 = OPP[flowOut]；出货面 = goalOut。
        return [{ inDir: OPP[g.flowOut], outDir: g.goalOut }];
    }
    const flows = [];                       // flows[k] = 从 cells[k] 走到 cells[k+1] 的方向
    for (let k = 0; k < cells.length - 1; k++) {
        const dx = cells[k + 1][0] - cells[k][0], dy = cells[k + 1][1] - cells[k][1];
        if (Math.abs(dx) + Math.abs(dy) !== 1) {
            throw new RouteError(`route.dirsAlong(cells[${k}]→[${k + 1}])`, "相邻两格必须共边（曼哈顿距离 1）",
                { a: cells[k], b: cells[k + 1] });
        }
        const d = ORDER.find(n => DIRV[n][0] === dx && DIRV[n][1] === dy);
        flows.push(d);
    }
    const out = [];
    for (let k = 0; k < cells.length; k++) {
        const inDir = k === 0 ? OPP[g.flowOut] : OPP[flows[k - 1]];
        const outDir = k === cells.length - 1 ? g.goalOut : flows[k];
        out.push({ inDir, outDir });
    }
    return out;
}

/**
 * 通道格序列 → beltCells（带 (rot,rv,code)）。不合法形态返回结构化失败（不 throw 业务失败）。
 * @param {object} g channelGeom 的结果 @param {Array<[number,number]>} cells
 * @param {string} channelId
 * @returns {{ok:boolean, cells?:object[], reason?:string, conflict?:object, hint?:string}}
 */
export function layCells(g, cells, channelId) {
    const dirs = dirsAlong(cells, g);
    const out = [];
    for (let k = 0; k < cells.length; k++) {
        const p = poseOf(dirs[k].inDir, dirs[k].outDir);
        if (!p) {
            // 只有 inDir===outDir（同向穿过）或 180° 才会 null → **不许硬凑**（plan §1.4）
            const f = makeFailure("belt-turn-unsolvable",
                { nodeId: g.ch.from.nodeId, cell: cells[k], check: "V4-slot-alignment" },
                `通道 ${channelId} 第 ${k} 格需要 inDir=${dirs[k].inDir} 且 outDir=${dirs[k].outDir}：`
                + `单格带子不可能（solveTurn 同向/180° 返回 null，belt-rules.mjs:46）。`
                + `要么端点几何给错（P3），要么车道选错行（P4）。`);
            return { ok: false, reason: f.reason, hint: f.hint, failingNode: f.failingNode,
                conflict: { kind: CONFLICT_KIND.noTurn, cells: [cells[k]],
                    nodeIds: [g.ch.from.nodeId, g.ch.to.nodeId], resolvedBy: null } };
        }
        out.push({
            cell: { x: cells[k][0], y: cells[k][1] },
            rot: p.rotation, rv: p.rotationVariant, code: p.code,
            inDir: dirs[k].inDir, outDir: dirs[k].outDir,
            channelId,
        });
    }
    return { ok: true, cells: out };
}

/**
 * 端点对齐断言（L0 验收 3；P5 的 V4-slot-alignment 同判据）。
 * 首格 entry == 上游输出槽的世界方位的反面、末格 exit == 下游输入槽的反面，
 * 且首格紧贴 from.cell、末格紧贴 to.cell。不等 = 内部 bug（不是业务失败）→ 抛 RouteError。
 * @param {object[]} belts layCells 的 cells @param {object} g @param {string} channelId
 */
export function assertEndpoints(belts, g, channelId) {
    const path = `route.channel(${channelId})`;
    if (!belts.length) {
        if (g.kind !== "direct") throw new RouteError(`${path}.cells`, "非 direct 形态至少有 1 格", g.kind);
        return { aligned: true, kind: "direct" };
    }
    const head = belts[0], tailB = belts[belts.length - 1];
    // 1) 首格：进货面朝上游机器；且它就在 from.cell 的 outDir 面外一格
    if (head.inDir !== OPP[g.flowOut]) {
        throw new RouteError(`${path}.first.inDir`, `=== OPP[from.outDir]=${OPP[g.flowOut]}（首格必须朝着上游机器的出口面接货）`,
            { got: head.inDir, fromOutDir: g.flowOut, cell: head.cell });
    }
    if (!sameCell([head.cell.x, head.cell.y], advance(g.ch.from.cell, g.flowOut))) {
        throw new RouteError(`${path}.first.cell`, `=== from.cell ${g.ch.from.cell} 沿 ${g.flowOut} 面外一格 ${advance(g.ch.from.cell, g.flowOut)}`,
            head.cell);
    }
    // 2) 末格：出货面朝下游机器的入口面（inDir 的反面）
    if (tailB.outDir !== g.goalOut) {
        throw new RouteError(`${path}.last.outDir`, `=== OPP[to.inDir]=${g.goalOut}（末格必须朝着下游机器的入口面喷货）`,
            { got: tailB.outDir, toInDir: g.ch.to.inDir, cell: tailB.cell });
    }
    if (!sameCell([tailB.cell.x, tailB.cell.y], advance(g.ch.to.cell, g.ch.to.inDir))) {
        throw new RouteError(`${path}.last.cell`, `=== to.cell ${g.ch.to.cell} 沿 ${g.ch.to.inDir} 面外一格 ${advance(g.ch.to.cell, g.ch.to.inDir)}`,
            tailB.cell);
    }
    // 3) 逐对相邻（双侧闭合）：u 的出口面住着 v，v 的入口面住着 u，且方向互为反面
    const closed = chainClosure(belts);
    if (!closed.ok) {
        throw new RouteError(`${path}.chain`, "每对相邻格必须满足 beltExit(u)===OPP[beltEntry(v)] 且两侧共边",
            closed.detail);
    }
    return { aligned: true, kind: g.kind, closure: closed };
}

/**
 * **双侧邻居闭合**判据（verify-belt-rules.md §3.1，即 L0 验收 1；用双侧版）。
 * 每对相邻格 (u,v)（v 在 u 下游）三条同时成立：
 *   ① 方向方程 beltExit(u) === OPP[beltEntry(v)]
 *   ② 正向共边 v.cell === u.cell + DIRV[beltExit(u)]        ← 本带的出口面确实住着 v
 *   ③ 反向共边 u.cell === v.cell + DIRV[beltEntry(v)]        ← 下带的入口面确实朝着 u
 * ②③ 对手性/rv 交换高度敏感（verify §3.2：取逆或交换 rv1↔rv2 时双侧闭合从 69/69 崩到 0），
 * 比只查 ① 强 —— ① 单独可被「两格同时转」蒙混，②③ 把几何位置也钉住。
 * ⚠️ NOTES C-4：执行书写的 `beltEntry(u)===OPP[beltExit(v)]`（同向再取一次 OPP）**只在两格都直**
 *   时成立（弯带的 entry/exit 互相垂直），对拐角对必然为假 → 本函数实现的是 verify §3.1 的
 *   双侧判据本身，不是那条字面式。
 * @param {Array<{cell:{x:number,y:number}, rot:number, rv:number}>} belts
 * @returns {{ok:boolean, pairs:number, detail:object|null}}
 */
export function chainClosure(belts) {
    for (let k = 0; k < belts.length - 1; k++) {
        const u = belts[k], v = belts[k + 1];
        /* ★ 隧道：sender 与 receiver 之间隔了 1~4 格（那些格被"穿过"、没有实体）★
           u 是 sender、v 是 receiver 时两者**不要求相邻**：只要同向、共线、跨度在范围内。
           `tunnel` 字段由 P3 标出（见 place.mjs 的 tunnelOverPath）。
           普通带子（u.tunnel 不是 "sender"）仍走原来的严格相邻判据。 */
        if (u.tunnel === "sender" && v.tunnel === "receiver") {
            const exT = beltExit(u.rv, u.rot), enT = beltEntry(v.rv, v.rot);
            const dx = v.cell.x - u.cell.x, dy = v.cell.y - u.cell.y;
            const alongX = dy === 0 && DIRV[exT][1] === 0 && Math.sign(dx) === DIRV[exT][0];
            const alongY = dx === 0 && DIRV[exT][0] === 0 && Math.sign(dy) === DIRV[exT][1];
            const span = Math.abs(dx) + Math.abs(dy);
            const okT = exT === OPP[enT] && (alongX || alongY) && span >= 2 && span <= TUNNEL_MAX_SPAN + 1;
            if (!okT) {
                return { ok: false, pairs: k, detail: {
                    index: k, u: { cell: u.cell, rot: u.rot, rv: u.rv, exit: exT, tunnel: "sender" },
                    v: { cell: v.cell, rot: v.rot, rv: v.rv, entry: enT, tunnel: "receiver" },
                    want: `隧道两端须同向共线、跨度 2..${TUNNEL_MAX_SPAN + 1}（实得 span=${span}）`,
                } };
            }
            continue;
        }
        const ex = beltExit(u.rv, u.rot), en = beltEntry(v.rv, v.rot);
        const ux = u.cell.x + DIRV[ex][0], uy = u.cell.y + DIRV[ex][1];
        const vx = v.cell.x + DIRV[en][0], vy = v.cell.y + DIRV[en][1];
        const bad = ex !== OPP[en] || ux !== v.cell.x || uy !== v.cell.y || vx !== u.cell.x || vy !== u.cell.y;
        if (bad) {
            return { ok: false, pairs: k, detail: {
                index: k, u: { cell: u.cell, rot: u.rot, rv: u.rv, exit: ex },
                v: { cell: v.cell, rot: v.rot, rv: v.rv, entry: en },
                want: `exit(u)=${ex} → OPP[entry(v)]=${OPP[en]} 且 v===u+DIRV[exit(u)]`,
            } };
        }
    }
    return { ok: true, pairs: Math.max(0, belts.length - 1), detail: null };
}

/**
 * 陷阱 #1 的形态检测（回归锁判据）：M4 手写版里 (136,90) 一格同时被「竖直段朝上」和
 * 「水平段朝左」两股流占据，而 (135,90) 朝右又喷回它 → 死循环/死端。
 * **编译器侧的硬判据**：同一格最多只能属于一条通道的一条带子。只要成立，
 * 「两股流在同格对向」在数学上不可能（一条带子只有一个 inDir/outDir）。
 * @param {Map<string, object[]>} byCell 键 = "x,y"，值 = 落到该格的 beltCell 列表
 * @returns {Array<{cell:number[], who:string[], outDirs:string[], inDirs:string[], opposed:boolean}>}
 */
export function counterDirectedCells(byCell) {
    const bad = [];
    for (const [k, list] of byCell) {
        if (list.length < 2) continue;            // 独占一格 = 正常，永不被标记
        const outs = new Set(list.map(b => b.outDir));
        const ins = new Set(list.map(b => b.inDir));
        const opposed = [...outs].some(d => outs.has(OPP[d])) || [...ins].some(d => ins.has(OPP[d]));
        const [x, y] = k.split(",").map(Number);
        bad.push({ cell: [x, y], who: [...new Set(list.map(b => b.channelId))],
            outDirs: [...outs], inDirs: [...ins], opposed });
    }
    return bad;
}

/* ───────────────────────────── 带朝向 Dijkstra（兜底铺 lane 内格 / 单调折线不成立时） ───────────────────────────── */

/**
 * 状态 (cell, outDir) 的 **Dijkstra**（不是 A\*，plan §8：我们的走廊只有几十格，
 * 省掉「h 是否可采纳」的论证负担）。代价 = 直行 1 / 转向 2（§6 取值）。
 * 搜索期**不调** solveTurn：任意 90° 转向都可实现，只有 180° 掉头不行
 * （belt-rules.mjs:46 对 in===out 返回 null；把 solveTurn 当每边合法性判据会全线误报 —— §7 陷阱 1）。
 * (rot,rv) 全部在重建路径后逐格调 poseOf。
 *
 * @param {object} g lane.channelGeom 的结果（含 first/last/flowOut/goalOut/ch.from/ch.to）
 * @param {(x:number,y:number)=>boolean} free 可布判定（机器/hub/旧厂/别的通道都已排除）
 * @param {{cap?:number, bounds?:{minX:number,minY:number,maxX:number,maxY:number}}} [opts]
 * @returns {{ok:true, cells:Array<[number,number]>} | {ok:false, kind:string, reason:string, hint:string, detail?:object}}
 */
export function dijkstraOriented(g, free, opts = {}) {
    const cap = opts.cap == null ? SEARCH_POP_CAP : assertInt(opts.cap, "dijkstra.cap");
    const fromCell = g.ch.from.cell, toCell = g.ch.to.cell;
    const key = (x, y, d) => `${x},${y},${idxOf(d)}`;
    const first = g.first, last = g.last, goalOut = g.goalOut;
    const B = opts.bounds;
    const okCell = (x, y) => {
        if (B && (x < B.minX || x > B.maxX || y < B.minY || y > B.maxY)) return false;
        return free(x, y);
    };
    // 退化：首格就是末格
    if (sameCell(first, last)) {
        if (!okCell(first[0], first[1])) {
            return { ok: false, kind: CONFLICT_KIND.occupied, reason: "dag-not-placeable:column-conflict-unresolved",
                hint: `单格通道 ${g.ch.from.nodeId}→${g.ch.to.nodeId} 的落点 (${first.join(",")}) 已被占`, detail: { cell: first } };
        }
        return { ok: true, cells: [first] };
    }
    if (!okCell(first[0], first[1])) {
        return { ok: false, kind: CONFLICT_KIND.occupied, reason: "dag-not-placeable:column-conflict-unresolved",
            hint: `通道首格 (${first.join(",")}) 不可布（机器占地/hub/旧厂/别的通道）`, detail: { cell: first } };
    }

    const start = { x: first[0], y: first[1], out: g.flowOut, g: STEP_COST, prev: null };
    const best = new Map([[key(start.x, start.y, start.out), start.g]]);
    const front = [start];
    const atGoal = (x, y, out) => x === last[0] && y === last[1] && out === goalOut;
    let pops = 0, found = null;

    while (front.length) {
        if (++pops > cap) {
            // 熔断 = 独立语义（竞品 layout.go:587 把「无路」与「太难」压成一个 false 是反面教材）
            return { ok: false, kind: CONFLICT_KIND.crossing, reason: "dag-not-placeable:crossing-needs-tunnel",
                hint: `带朝向 Dijkstra 预算耗尽（pops>${cap}）：走廊太挤，v1 需要隧道 → 显式拒绝`,
                detail: { budget: cap, channel: `${g.ch.from.nodeId}->${g.ch.to.nodeId}` } };
        }
        // 线性取最小：我们的状态数只有几十，省掉堆（prior-art §6 移植成本节）
        let bi = 0;
        for (let i = 1; i < front.length; i++) if (front[i].g < front[bi].g) bi = i;
        const cur = front.splice(bi, 1)[0];
        const bk = best.get(key(cur.x, cur.y, cur.out));
        if (bk !== undefined && bk < cur.g) continue;                     // 已被更优者取代
        if (atGoal(cur.x, cur.y, cur.out)) { found = cur; break; }
        for (const out of ORDER) {
            if (out === OPP[cur.out]) continue;                            // 禁 180° 掉头（= solveTurn null 的那一类）
            const nx = cur.x + DIRV[out][0], ny = cur.y + DIRV[out][1];
            if (sameCell([nx, ny], toCell) || sameCell([nx, ny], fromCell)) continue;   // 不踩回机器格
            if (!okCell(nx, ny)) continue;
            const ng = cur.g + (out === cur.out ? STEP_COST : TURN_COST);
            const k = key(nx, ny, out);
            if (best.has(k) && best.get(k) <= ng) continue;
            best.set(k, ng);
            front.push({ x: nx, y: ny, out, g: ng, prev: cur });
        }
    }
    if (!found) {
        return { ok: false, kind: CONFLICT_KIND.crossing, reason: "dag-not-placeable:crossing-needs-tunnel",
            hint: `带朝向 Dijkstra 在可行域内找不到 (cell,outDir) 路径：${g.ch.from.nodeId}→${g.ch.to.nodeId}；`
                + `v1 不叠隧道（scope.tunnels:false）→ 需要加宽行距/换 site`,
            detail: { pops, states: best.size } };
    }
    const cells = [];
    for (let n = found; n; n = n.prev) cells.push([n.x, n.y]);
    cells.reverse();
    return { ok: true, cells };
}

/* ───────────────────────────── 主入口 ───────────────────────────── */

/**
 * 把整份 LayoutReport 路由成带子格集合，并返回更新后的报告（lanes 填上、conflicts 记账）。
 * 永不 throw 业务失败（plan §2.5）：失败一律 {ok:false, reason, failingNode, hint}。
 * 只有**内部不变量**破了（端点对不齐 / 链不闭合）才抛 RouteError —— 那是 P4 自己的 bug。
 *
 * @param {object} report LayoutReport（P3 产出，**不修改入参**）
 * @param {{hubOrigin?:number[]|null, allowVerticalLane?:boolean, maxLanes?:number,
 *          searchRadius?:number, preAssign?:boolean, bounds?:object,
 *          routeFallback?:boolean, prefer?:Function}} [opts]
 * @returns {{ok:boolean, reason:string|null, hint:string|null, failingNode:object|null,
 *            beltCells:object[], report:object, geoms:object[],
 *            cornerCount:number, cornerCostTiles:number, beltTiles:number,
 *            conflicts:object[], closure:{pairs:number, ok:boolean},
 *            laneRows:Map, colLanes:Map, failures:object[]}}
 */
export function routeAll(report, opts = {}) {
    if (!report || typeof report !== "object" || !Array.isArray(report.channels)) {
        throw new ContractViolation("route.routeAll(report.channels)", "LayoutReport 的 channels 数组（§2.3）",
            report && report.channels);
    }
    const lane = assignLanes(report, opts);
    const failures = [];
    const beltCells = [];
    const byCell = new Map();
    const extraConflicts = [];

    /* 可行域：lane 阶段算好的 blocked 集（机器 ∪ hub ∪ 旧厂 ∪ 已占通道格） */
    const blocked = lane.blocked.blocked;
    const free = (x, y) => !blocked.has(cellKey(x, y));
    const bounds = opts.bounds || (() => {
        const xs = [], ys = [];
        for (const p of report.placements || []) { xs.push(p.cell[0], p.cell[0] + p.footprint[0] - 1); ys.push(p.cell[1], p.cell[1] + p.footprint[1] - 1); }
        for (const c of report.channels) { xs.push(c.from.cell[0], c.to.cell[0]); ys.push(c.from.cell[1], c.to.cell[1]); }
        if (!xs.length) return { minX: -8, maxX: 8, minY: -8, maxY: 8 };
        return { minX: Math.min(...xs) - (opts.searchRadius ?? 16), maxX: Math.max(...xs) + (opts.searchRadius ?? 16),
            minY: Math.min(...ys) - (opts.searchRadius ?? 16), maxY: Math.max(...ys) + (opts.searchRadius ?? 16) };
    })();

    const mark = (channelId, cells) => {
        for (const c of cells) {
            const k = cellKey(c.cell.x, c.cell.y);
            if (!byCell.has(k)) byCell.set(k, []);
            byCell.get(k).push({ ...c, channelId });
        }
    };

    for (const g of lane.geoms) {
        /* ★ P3 已逐格铺好的通道（含隧道）：整条采纳，P4 不重算 ★
           必须在 `unresolvedChannels` / `cellsByChannel` / Dijkstra 之前处理 ——
           含隧道的通道端点对在 `channelGeom` 看来往往"不可布"（P3 是穿过去的），
           走到任何"重算"分支都会把它判死，隧道就白铺了。 */
        const preCells = Array.isArray(report.beltCells)
            ? report.beltCells.filter(b => b.channelId === g.id)
            : [];
        if (preCells.some(b => b.tunnel)) {
            const tunneled = preCells.map(b => {
                if (b.tunnel) {
                    /* 隧道格也要有 (rot, rv)：`chainClosure` 用 beltExit/beltEntry 校验相邻连通性，
                       rot=null 会让它算不出方向、把整条链判成不闭合（实测 ch8 第 79 对）。
                       隧道的进出方向就是该段的行进方向 —— 与普通直带同形，照常 solveTurn。
                       code 仍留 null：发射层按 `tunnel` 字段写 22/23，不按 solveTurn 的 1/2/3。 */
                    const pT = poseOf(b.inDir, b.outDir);
                    return { cell: { x: b.cell[0], y: b.cell[1] }, inDir: b.inDir, outDir: b.outDir,
                        tunnel: b.tunnel, rot: pT ? pT.rotation : null, rv: pT ? pT.rotationVariant : null,
                        code: null, channelId: g.id };
                }
                const p = poseOf(b.inDir, b.outDir);
                return { cell: { x: b.cell[0], y: b.cell[1] }, inDir: b.inDir, outDir: b.outDir,
                    tunnel: null, rot: p ? p.rotation : null, rv: p ? p.rotationVariant : null,
                    code: p ? p.code : null, channelId: g.id };
            });
            beltCells.push(...tunneled);
            mark(g.id, tunneled);
            for (const b of tunneled) blocked.add(cellKey(b.cell.x, b.cell.y));
            continue;
        }

        // 车道阶段判定「这条通道整条不铺」（撞既有世界 / 需分层 / 找不到行）→ 一条带子都不产，
        // 也不兜底：半成品 IR 流向 P5/P6 比整单失败更危险（plan §2.1「绝不产出会堵死的蓝图」）。
        if (lane.unresolvedChannels.has(g.id)) continue;

        let cells = lane.cellsByChannel.get(g.id) || null;

        // search 形态（单调折线不成立）→ 带朝向 Dijkstra 兜底铺 lane 内格（prior-art §8：兜底不进主干）。
        if (!cells && opts.routeFallback !== false) {
            const dj = dijkstraOriented(g, free, { bounds });
            if (!dj.ok) {
                extraConflicts.push({ kind: dj.kind, cells: [g.first, g.last],
                    nodeIds: [g.ch.from.nodeId, g.ch.to.nodeId], resolvedBy: null });
                failures.push({ ok: false, reason: dj.reason, hint: dj.hint, channelId: g.id, detail: dj.detail });
                continue;
            }
            cells = dj.cells;
            g.laneFixed = null; g.viaDijkstra = true;
        }
        if (!cells) {
            // 车道分配失败的通道：cellsByChannel 里没有 → 不重复报，交给 lane 的 reason
            continue;
        }


        const laid = layCells(g, cells, g.id);
        if (!laid.ok) {
            extraConflicts.push(laid.conflict);
            failures.push({ ok: false, reason: laid.reason, hint: laid.hint,
                failingNode: laid.failingNode, channelId: g.id });
            continue;
        }
        beltCells.push(...laid.cells);
        mark(g.id, laid.cells);

        // 端点对齐 + 双侧闭合（内部 bug 才 throw）
        assertEndpoints(laid.cells, g, g.id);

        // Dijkstra 兜底的通道也把格记进占用视图，后面的通道看得见
        if (g.viaDijkstra) {
            for (const b of laid.cells) blocked.add(cellKey(b.cell.x, b.cell.y));
        }
    }

    /* 陷阱 #1 回归锁：任何一格被两条通道的带子共用 → 立刻判死（绝不产出该形状） */
    const counter = counterDirectedCells(byCell);
    for (const c of counter) {
        extraConflicts.push({ kind: CONFLICT_KIND.crossing, cells: [c.cell],
            nodeIds: c.who, resolvedBy: null });
    }

    const corners = beltCells.filter(b => b.rv !== 0);
    const ok = lane.ok && failures.length === 0 && counter.length === 0;

    /* 失败语义：ok:false 时 reason **必须**落在 §2.5 枚举（types.mjs:396 hard rule：
       !ok 时 reason 必填、且 assertCompiledPlan 会拒绝 null reason 的失败对象）。
       优先级 lane 判死 > 单通道铺格失败 > 陷阱 #1 同格对向（counter 回归锁）。
       counter 分支的 reason 取 crossing-needs-tunnel：两股流对向 = 只能靠隧道分层，
       v1 scope.tunnels:false → 显式拒绝（与下面 hint 一致）。 */
    const reason = ok ? null
        : (!lane.ok ? lane.reason
            : (failures[0] ? failures[0].reason : "dag-not-placeable:crossing-needs-tunnel"));
    const failingNode = ok ? null
        : (!lane.ok
            ? { nodeId: (lane.conflicts[0] && lane.conflicts[0].nodeIds[0]) || "", cell: lane.conflicts[0] ? lane.conflicts[0].cells[0] : null, check: "V6-crossing" }
            : (failures[0]
                ? (failures[0].failingNode || { nodeId: failures[0].channelId || "", cell: null, check: "V4-slot-alignment" })
                : { nodeId: (counter[0] && counter[0].who && counter[0].who[0]) || "", cell: counter[0] ? counter[0].cell : null, check: "V6-crossing" }));

    const outReport = {
        ...lane.report,
        conflicts: [...lane.report.conflicts, ...extraConflicts],
        cornerCount: corners.length,
    };

    return {
        ok,
        reason: ok ? null : assertReason(reason),
        hint: ok ? null : (lane.ok
            ? (failures[0] ? failures[0].hint : "带子在同格相交（陷阱 #1：两股流对向）→ v1 需要隧道分层，显式拒绝")
            : lane.hint),
        failingNode,
        beltCells,
        report: outReport,
        geoms: lane.geoms,
        cornerCount: corners.length,
        cornerCostTiles: round2(corners.length * CORNER_COST_TILES),
        beltTiles: beltCells.length,
        conflicts: [...lane.conflicts, ...extraConflicts],
        closure: summarizeClosure(beltCells, lane.cellsByChannel),
        laneRows: lane.laneRows, colLanes: lane.colLanes, laneAxis: lane.laneAxis,
        failures, lanes: lane,
    };
}

/** 逐通道汇总双侧闭合的对数（L0 验收 1 的读数） */
function summarizeClosure(beltCells, cellsByChannel) {
    const byCh = new Map();
    for (const b of beltCells) { if (!byCh.has(b.channelId)) byCh.set(b.channelId, []); byCh.get(b.channelId).push(b); }
    let pairs = 0, bad = 0;
    const detail = [];
    for (const [id, list] of byCh) {
        const c = chainClosure(list);
        if (!c.ok) { bad++; detail.push({ channelId: id, index: c.pairs, ...c.detail }); }
        pairs += c.pairs;
    }
    void cellsByChannel;
    return { pairs, bad, ok: bad === 0, byChannel: byCh.size, detail };
}

/** reason 必须落在 §2.5 枚举里（写进 plan 的失败对象由 types.mjs 把关，这里先自审） */
function assertReason(r) {
    if (r === null || isFailureReason(r)) return r;
    throw new ContractViolation("route.routeAll.reason", "§2.5 FAILURE_REASONS 或 validate:<Vn>", r);
}
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 只路由**一条**通道（供测试与 P5 复核单条链用）。先做几何推导，
 * 车道用 opts.laneFixed（不给则按 left-edge 现算一个候选），再铺格。
 * @param {object} ch LayoutReport.channels[i] @param {object} report @param {object} [opts]
 */
export function routeChannel(ch, report, opts = {}) {
    const i = opts.index == null ? report.channels.indexOf(ch) : opts.index;
    const g = channelGeom(ch, i);
    const lane = assignLanes(report, opts);
    const fixed = opts.laneFixed == null ? lane.laneRows.get(g.id) : opts.laneFixed;
    let cells = opts.cells || geomCells(g, fixed);
    if (!cells) {
        const blocked = lane.blocked.blocked;
        const dj = dijkstraOriented(g, (x, y) => !blocked.has(cellKey(x, y)), { bounds: opts.bounds });
        if (!dj.ok) return { ok: false, ...dj, geom: g };
        cells = dj.cells;
    }
    const laid = layCells(g, cells, g.id);
    if (!laid.ok) return { ...laid, geom: g };
    assertEndpoints(laid.cells, g, g.id);
    return { ...laid, geom: g, cells: laid.cells };
}

export { RESOLVED_BY, CONFLICT_KIND };
