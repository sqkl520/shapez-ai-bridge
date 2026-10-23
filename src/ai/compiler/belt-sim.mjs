/**
 * belt-sim.mjs — 离线带子不动点模拟器（P5 validator 独占）。
 *
 * 为什么单独写一份（plan §1.5 V3 / §2.4 / redteam:144 / §6 R1）
 * ─────────────────────────────────────────────────────────────
 *   现成的 `research/ai-player/proto/validate-belt-rules.mjs` 只把**带子**邻居喂进
 *   computeBelt（:126-127 `if (nb.belt ...)`），吻合率 82.5%，漂移全在"邻居含机器"的
 *   角落。那个结论**不可复用**：编译器产的带子必然贴着机器，机器 ejector/acceptor
 *   会改变每一个相邻带格的启发式输入。本文件因此**独立实现**一份 computeBelt，并把
 *   机器槽位（OP_TEMPLATES + rotateSlot，v1 机器恒 r=0）与带子 fake 槽一起喂进去。
 *
 * 与 belt-rules.mjs / belt-rules.test.mjs 的关系（"双实现交叉对拍"的两条腿）
 * ─────────────────────────────────────────────────────────────────────
 *   - `src/ai/belt-rules.test.mjs`（P0-verify）：邻居**拓扑**判据 —— 出口方位 + OPP 回指
 *     （dnOk 1267/1268、弯带双侧 69/69），可证伪旋转手性与 rv1↔rv2 分配。
 *   - 本文件（P5）：**槽位**判据 —— 照上游 `logic.js:391-470 getEjectorsAndAcceptorsAtTile`
 *     的几何（localTileToWorld + 方向旋转 + targetTile==本格）算 ejectors/acceptors，
 *     再走 `buildings/belt.js:159-247` 的三支启发式，逐格检不动点。
 *   两份**互不 import 的独立代码**在同一批存档数据（facts/live/world-full.json）上必须
 *   给出同一个闭合数 → `topologyScore()` 就是这一拍腿，L0 断言 0 差异。
 *
 * 复刻对照（逐条对齐上游源码，不是对齐 proto 脚本）
 *   computeBelt        ← buildings/belt.js:159-247（三支：侧向 ejector → +270/+90；
 *                          侧向 acceptor → rotation 不变；否则 rv0）
 *   邻居槽位收集        ← logic.js:391-470（四邻、regular 层、ejector 看 targetTile、
 *                          acceptor 看 sourceTile；带子贡献 fake 槽）
 *   带子 fake 槽        ← components/belt.js:9-12（acceptor 恒局部 bottom）
 *                          components/belt.js:14-36 + buildings/belt.js:12（ejector = 局部
 *                          arrayBeltVariantToRotation[rv] = top/left/right）
 *   localTileToWorld    ← components/static_map_entity.js:182-188 + core/vector.js:503-525
 *                          （90:(-y,x) 180:(-x,-y) 270:(y,-x)，再加 origin）
 *   localDirectionToWorld← static_map_entity.js:164-168 / core/vector.js:533+（顺时针）
 *   非 belt 建筑槽位     ← src/ai/op-templates.mjs（P2 的 GEOMETRY 表1 归一形式，唯一权威）
 *                          balancer / underground_belt 不在 v1 op 集合内 → 本文件自带一份
 *                          SAVE_ONLY_SLOTS（照 buildings/balancer.js:179-243、
 *                          buildings/underground_belt.js:271-295），**只用于回放存档**。
 *
 * 铁律：零依赖（ESM + node 内置 + src/ai/belt-rules.mjs + src/ai/op-templates.mjs）；
 *      不 import proto/belt-rules.mjs（已知错误副本，plan §1.1 lint / §3）；
 *      不 import P3/P4 的实现（防环，P5 可先行）；100% 离线，绝不碰桥接。
 *
 * 自测：`node src/ai/compiler/belt-sim.mjs --test`
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ORDER, OPP, DIRV, norm360, angleToDir, beltCode, EXIT_LOCAL } from "../belt-rules.mjs";
import { ALL_TEMPLATES, templateByBuildingVariant, rotateSlot } from "../op-templates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 同一批存档带子数据（P0-verify 用的也是这份，已提交在库里，可确定性复现）。 */
export const WORLD_FULL_PATH = path.resolve(HERE, "..", "..", "..", "research", "ai-player", "facts", "live", "world-full.json");

export const BELT_CODES = Object.freeze({ 1: 0, 2: 1, 3: 2 });

/* ═══════════════════════════ 1. computeBelt 的独立复刻 ═══════════════════════════ */

/**
 * 上游 `MetaBeltBuilding.computeOptimalDirectionAndRotationVariantAtTile`
 * （buildings/belt.js:159-247）的复刻。
 *
 * @param {object} args
 * @param {number} args.rotation  **originalRotation**（systems/belt.js:160 读的就是它）
 * @param {Array<{toDirection?:string, fromDirection?:string}>} args.neighbors
 *        影响本格的 ejector（toDirection = 世界方位，从邻居格指向本格）与
 *        acceptor（fromDirection = 世界方位，从槽位格指向本格）。
 * @returns {{rotation:number, rotationVariant:number}}
 */
export function computeBelt({ rotation, neighbors = [] }) {
    const topDirection = angleToDir(rotation);
    const rightDirection = angleToDir(rotation + 90);
    const bottomDirection = angleToDir(rotation + 180);
    const leftDirection = angleToDir(rotation + 270);

    let hasBottomEjector = false, hasRightEjector = false, hasLeftEjector = false;
    let hasTopAcceptor = false, hasLeftAcceptor = false, hasRightAcceptor = false;

    for (const n of neighbors) {
        // ① 邻居往本格喷（ejector.toDirection 指向本格）
        if (n.toDirection) {
            const d = n.toDirection;
            if (d === topDirection) hasBottomEjector = true;       // 在我们"局部下方"
            else if (d === leftDirection) hasRightEjector = true;  // 在我们"局部右侧"
            else if (d === rightDirection) hasLeftEjector = true;  // 在我们"局部左侧"
        }
        // ② 本格往邻居喷且邻居要收（acceptor.fromDirection 从槽位格指向本格）
        if (n.fromDirection) {
            const d = n.fromDirection;
            if (d === bottomDirection) hasTopAcceptor = true;
            else if (d === rightDirection) hasLeftAcceptor = true;
            else if (d === leftDirection) hasRightAcceptor = true;
        }
    }

    // 支①：局部下方有 ejector 时**永远优先**接它；否则按侧向出弯（rotation +270/+90）
    if (!hasBottomEjector) {
        if (hasRightEjector && !hasLeftEjector) return { rotation: norm360(rotation + 270), rotationVariant: 2 };
        if (hasLeftEjector && !hasRightEjector) return { rotation: norm360(rotation + 90), rotationVariant: 1 };
    }
    // 支②：局部上方没有 acceptor 时，按侧向 acceptor 拐弯（rotation **不变**）
    if (!hasTopAcceptor) {
        if (hasRightAcceptor && !hasLeftAcceptor) return { rotation, rotationVariant: 2 };
        if (hasLeftAcceptor && !hasRightAcceptor) return { rotation, rotationVariant: 1 };
    }
    return { rotation, rotationVariant: 0 };
}

/* ═══════════════════════════ 2. 世界槽位模型 ═══════════════════════════ */

/** 局部格 → 世界格（static_map_entity.js:182-188 + vector.js:503-525，非方形占地同样成立）。
 *  ⚠️ 与 op-templates.rotateCell 的区别：rotateCell 只对**方形**占地做绕心旋转并且
 *  拒绝非方形 rot≠0（D1）；上游真正的公式是 `rotateFastMultipleOf90(local) + origin`，
 *  这里照上游实现，存档里那些 r=90/180/270 的 cutter/painter 才能回放。
 *  v1 规划布局里机器恒 r=0，两种实现退化成同一个（L0 有对拍断言）。 */
export function localTileToWorld(cell, rotation, origin) {
    const r = norm360(rotation);
    const [x, y] = cell;
    let out;
    if (r === 0 || r === 360) out = [x, y];
    else if (r === 90) out = [-y, x];
    else if (r === 180) out = [-x, -y];
    else if (r === 270) out = [y, -x];
    else throw new Error(`localTileToWorld: 非 90 倍数角度 ${rotation}`);
    return [out[0] + origin[0], out[1] + origin[1]];
}

/** 局部方位 → 世界方位（委托 belt-rules.rotateLocal —— 唯一方向函数，禁止二次实现）。 */
export function localDirToWorld(dir, rotation) {
    return rotateSlot(dir, rotation);        // rotateSlot 内含严格象限校验
}

/** balancer / underground_belt：v1 不产出，但回放 level-11 存档必须有它们的槽位。
 *  来源：buildings/balancer.js:179-243、buildings/underground_belt.js:271-295 +
 *  arrayUndergroundRotationVariantToMode = [sender, receiver]（underground_belt.js:15-18）。
 *  ⚠️ 只在 buildWorldFromSave() 里用到；规划布局（v1 范围）不含这两类，见 V8-scope。 */
const SAVE_ONLY_SLOTS = Object.freeze({
    balancer: {
        default: {
            footprint: [2, 1],
            inputs: [{ cell: [0, 0], dir: "bottom" }, { cell: [1, 0], dir: "bottom" }],
            outputs: [{ cell: [0, 0], dir: "top" }, { cell: [1, 0], dir: "top" }],
        },
    },
    underground_belt: {
        // rv=0 sender（只收 local bottom）/ rv=1 receiver（只喷 local top）
        default: {
            footprint: [1, 1],
            inputs: [{ cell: [0, 0], dir: "bottom" }],
            outputs: [{ cell: [0, 0], dir: "top" }],
            rvInputs: { 0: [{ cell: [0, 0], dir: "bottom" }], 1: [] },
            rvOutputs: { 0: [], 1: [{ cell: [0, 0], dir: "top" }] },
        },
    },
});

/** 一个实体在世界上占的格 + 它的 ejector/acceptor 世界槽位。 */
function slotsFor(type, variant, rotation, rv) {
    if (type === "belt") {
        return {
            footprint: [1, 1],
            inputs: [{ cell: [0, 0], dir: "bottom" }],
            outputs: [{ cell: [0, 0], dir: EXIT_LOCAL[rv] }],
        };
    }
    const t = templateByBuildingVariant(type, variant) || (type === "belt" ? ALL_TEMPLATES.belt : null);
    if (t) return { footprint: t.footprint, inputs: t.inputs, outputs: t.outputs };
    const so = SAVE_ONLY_SLOTS[type] && SAVE_ONLY_SLOTS[type][variant === undefined ? "default" : variant];
    if (so) {
        if (so.rvInputs || so.rvOutputs) {
            return {
                footprint: so.footprint,
                inputs: (so.rvInputs[rv] ?? so.inputs),
                outputs: (so.rvOutputs[rv] ?? so.outputs),
            };
        }
        return so;
    }
    return null;
}

/**
 * 世界模型：`{ byCell: Map<"x,y", {origin, type, variant, r, rv, code, cells, slots}>,
 *             ejectors: Map<"x,y", Array<{fromCell, toDirection, entity}>>,   // 目标格 → 喷进来的
 *             acceptors: Map<"x,y", Array<{slotCell, fromDirection, entity}>> // 源格 → 要收的
 *           }`
 * ejectors/acceptors 的语义逐字对齐 logic.js:391-470：
 *   ejector 命中 tile ⇔ localTileToWorld(slot.pos,r)+origin 再沿世界方向走 1 格 == tile
 *   acceptor 命中 tile ⇔ 槽位格沿世界方向走 1 格 == tile
 */
export function buildWorldModel(entities) {
    const byCell = new Map();
    const ejectors = new Map();
    const acceptors = new Map();
    const records = [];

    for (const e of entities) {
        const type = e.type, variant = e.variant === undefined ? "default" : e.variant;
        const r = norm360(e.r === undefined ? e.rotation : e.r);
        const rv = e.rv === undefined ? (e.rotation_variant === undefined ? 0 : e.rotation_variant) : e.rv;
        const origin = [e.x, e.y];
        const s = slotsFor(type, variant, r, rv);
        if (!s) { records.push({ skipped: true, type, variant, origin, r, rv }); continue; }
        const [w, h] = s.footprint;
        const rec = {
            origin, type, variant, r, rv, code: e.code, cells: [],
            outSlots: s.outputs.map(o => ({ tile: localTileToWorld(o.cell, r, origin), dir: localDirToWorld(o.dir, r) })),
            inSlots: s.inputs.map(i => ({ tile: localTileToWorld(i.cell, r, origin), dir: localDirToWorld(i.dir, r) })),
        };
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
            const k = `${origin[0] + dx},${origin[1] + dy}`;
            rec.cells.push(k);
            // ★ 同格多实体（world-full.json 把 regular/tunnel 层拍平成同一张表：182 条隧道压在带子上）
            //   "本格是什么"以**带子优先** —— 与 P0-verify 的 buildGrid 同一策略（belt-rules.test.mjs:143-157：
            //   先放带子，非带子只在空位落占位）。两侧独立实现必须有同一归并规则，否则对拍必然出差异。
            const cur = byCell.get(k);
            if (cur && cur.type === "belt" && rec.type !== "belt") continue;
            byCell.set(k, rec);
        }
        records.push(rec);
    }

    const push = (map, key, val) => {
        const list = map.get(key);
        if (list) list.push(val); else map.set(key, [val]);
    };
    for (const rec of records) {
        if (rec.skipped) continue;
        for (const s of rec.outSlots) push(ejectors, `${s.tile[0] + DIRV[s.dir][0]},${s.tile[1] + DIRV[s.dir][1]}`, { fromCell: s.tile, toDirection: s.dir, rec });
        for (const s of rec.inSlots) push(acceptors, `${s.tile[0] + DIRV[s.dir][0]},${s.tile[1] + DIRV[s.dir][1]}`, { slotCell: s.tile, fromDirection: s.dir, rec });
    }
    return { byCell, ejectors, acceptors, records };
}

/** 影响 tile 的邻居槽位集合（= logic.js 返回给 belt 启发式的 {ejectors, acceptors}）。 */
export function neighborsAffecting(world, x, y) {
    const out = [];
    for (const e of world.ejectors.get(`${x},${y}`) || []) out.push({ toDirection: e.toDirection, kind: "ejector", src: e.fromCell });
    for (const a of world.acceptors.get(`${x},${y}`) || []) out.push({ fromDirection: a.fromDirection, kind: "acceptor", src: a.slotCell });
    return out;
}

/* ═══════════════════════════ 3. 逐格不动点检查 ═══════════════════════════ */

/**
 * 从 LayoutReport + 带子意图表构造**含机器邻居**的世界，逐带格跑 computeBelt。
 *
 * @param {LayoutReport} report  plan §2.3（placements/channels/occupancy/hubConnection）
 * @param {object} [opts]
 * @param {CompiledEntity[]} [opts.entities] 带子意图表（P4 产物 / fixture 手工构造）。
 *        缺省时只用 report.placements 里的机器 + layout 里出现的 belt 格（无带子 = 无需检）。
 * @param {{replaceableBeltCells?:Set<string>|string[], entities?:Array}} [opts.world]
 *        既有世界（§2.6 WorldState 或其子集）。v1 只做全新址，缺省 = 只有 layout.occupancy。
 * @param {boolean} [opts.iterate] 是否**再跑一次全局不动点搜索**（默认 **关**，opt-in）。
 *        关掉是因为权威判据是"逐格单步"：stride=4 ⇒ orig=设计 r，所以每格必须自己就是
 *        不动点；全局迭代回答的是另一个问题（"把这批带子反复重算会不会收敛"），
 *        1906 条带子的存档 3 轮收敛（见 test.mjs C15）。迭代是 O(轮数 × 带格数)。
 * @returns {{tilesChecked:number, fixedPoints:number, drift:Array, includesMachineNeighbors:true,
 *            iterations:number, converged:boolean, machineNeighbors:number, beltNeighbors:number,
 *            state:Map<string,{r:number,rv:number}>}}
 */
export function simulateBelts(report, opts = {}) {
    const belts = (opts.entities || report.entities || []).filter(e => e.kind === "belt");
    const design = new Map();
    for (const b of belts) design.set(`${b.dx},${b.dy}`, { r: norm360(b.rot), rv: b.rotationVariant, nodeId: b.nodeId });

    const world = buildWorldModel(worldEntitiesFrom(report, opts));
    const beltKeys = [...design.keys()];

    let fixedPoints = 0;
    const drift = [];
    let machineNeighbors = 0, beltNeighbors = 0;

    // ── 单格判据（权威）：把设计态 (r,rv) 当作输入，含机器邻居，看 compute 是否原样返回。
    //    SZBP1 stride=4 ⇒ 粘贴时 originalRotation = rotation（bridge:814），所以"orig"
    //    就是设计 r —— 这也是 plan §1.6 决策 D2 说的"缺口被绕过"的确切条件。
    for (const key of beltKeys) {
        const [x, y] = key.split(",").map(Number);
        const d = design.get(key);
        const nb = neighborsAffecting(world, x, y);
        if (nb.length) {
            for (const n of nb) {
                const ownerKey = `${n.src[0]},${n.src[1]}`;
                const rec = world.byCell.get(ownerKey);
                if (rec && rec.type === "belt") beltNeighbors++; else if (rec) machineNeighbors++;
            }
        }
        const got = computeBelt({ rotation: d.r, neighbors: nb });
        if (got.rotation === d.r && got.rotationVariant === d.rv) fixedPoints++;
        else drift.push({
            cell: [x, y],
            wantRv: got.rotationVariant, gotRv: d.rv,
            wantRot: got.rotation, gotRot: d.r,
            nodeId: d.nodeId || `belt@${x},${y}`,
            note: `含机器邻居下 (${d.r},${d.rv}) 非不动点：compute → (${got.rotation},${got.rotationVariant})（neighbors=${nb.length}）`,
        });
    }

    // ── 配置级迭代：把每格按 compute 改写，直到稳定或到上限（真正的不动点搜索）。
    //    设计态若每格都是不动点，这一步必然 1 轮收敛且状态不变。
    //    ⚠️ 影子世界**每轮重建一次**（不是每格一次）：每格重建会把这里变成 O(n²)
    //    （1906 条带子的存档实测 40s → 修后 <1s）。
    let state = new Map([...design].map(([k, v]) => [k, { r: v.r, rv: v.rv }]));
    let iterations = 0, converged = false;
    if (opts.iterate === true && beltKeys.length) {
        for (; iterations < 8; iterations++) {
            const shadow = beltStateToWorld(world, state);
            const next = new Map();
            for (const key of beltKeys) {
                const [x, y] = key.split(",").map(Number);
                const cur = state.get(key);
                const got = computeBelt({ rotation: cur.r, neighbors: neighborsAffecting(shadow, x, y) });
                next.set(key, { r: got.rotation, rv: got.rotationVariant });
            }
            let same = true;
            for (const [k, v] of next) { const c = state.get(k); if (c.r !== v.r || c.rv !== v.rv) { same = false; break; } }
            state = next;
            if (same) { converged = true; break; }
        }
    }

    return {
        tilesChecked: beltKeys.length,
        fixedPoints,
        drift,
        includesMachineNeighbors: true,      // ← §2.4 硬规定：绝不退回"只喂带子"
        iterations, converged,
        machineNeighbors, beltNeighbors,
        state,
    };
}

/** 迭代时带子的槽位随 state 变化 → 造一个"影子世界"。 */
function beltStateToWorld(world, state) {
    const entities = [];
    for (const rec of world.records) {
        if (rec.skipped) continue;
        if (rec.type === "belt") {
            const st = state.get(`${rec.origin[0]},${rec.origin[1]}`);
            // 不在 state 里 = 既有世界的带子（v1 全新址时为空），保持原样参与邻居计算
            entities.push(st
                ? { type: "belt", variant: "default", x: rec.origin[0], y: rec.origin[1], r: st.r, rv: st.rv }
                : { type: "belt", variant: "default", x: rec.origin[0], y: rec.origin[1], r: rec.r, rv: rec.rv });
        } else {
            entities.push({ type: rec.type, variant: rec.variant, x: rec.origin[0], y: rec.origin[1], r: rec.r, rv: rec.rv });
        }
    }
    return buildWorldModel(entities);
}

/**
 * 把 LayoutReport(+opts.entities) 摊平成 world 实体表：机器 placements（恒 r=0，D1）
 * + 带子意图 (rot,rv) + 既有世界（occupancy 里的 hub 等 solid）。
 * 注意 hub：plan-l1 的 hub 只在 layout.occupancy 里（谁="hub"），不在 entities。
 */
export function worldEntitiesFrom(report, opts = {}) {
    const out = [];
    for (const p of report.placements || []) {
        out.push({ type: p.kind, variant: "default", x: p.cell[0], y: p.cell[1], r: norm360(p.rot || 0), rv: 0, code: null });
    }
    for (const e of (opts.entities || report.entities || [])) {
        if (e.kind === "belt") out.push({ type: "belt", variant: "default", x: e.dx, y: e.dy, r: norm360(e.rot), rv: e.rotationVariant, code: e.code });
        else if (!report.placements || !report.placements.some(p => p.nodeId === e.nodeId)) {
            out.push({ type: e.kind, variant: "default", x: e.dx, y: e.dy, r: norm360(e.rot || 0), rv: e.rotationVariant || 0, code: e.code });
        }
    }
    // layout.occupancy 里的既有实体（hub 4×4 等）：按 who 归并出 origin = 最小格
    const groups = new Map();
    for (const o of report.occupancy || []) {
        if (o.state === "replaceable") continue;          // 既有带子交给 V2，不进带子邻居？→ 见下
        const who = o.who || `cell:${o.cell[0]},${o.cell[1]}`;
        if (!groups.has(who)) groups.set(who, { kind: o.kind || "unknown", cells: [] });
        groups.get(who).cells.push(o.cell);
    }
    for (const [who, g] of groups) {
        if (g.kind !== "hub") continue;                   // 只有 hub 有 16 入口表；其余按单格
        const x = Math.min(...g.cells.map(c => c[0])), y = Math.min(...g.cells.map(c => c[1]));
        out.push({ type: "hub", variant: "default", x, y, r: 0, rv: 0, code: 26, _who: who });
    }
    // 既有可替换带子（WorldState.replaceableBeltCells）：它们**真实存在**于世界上，
    // 会作为邻居参与 computeBelt（增量施工场景）；v1 全新址时为空。
    const worldBelts = opts.world && opts.world.replaceableBeltCells;
    if (worldBelts) {
        const keys = worldBelts instanceof Set ? [...worldBelts] : worldBelts;
        for (const k of keys) {
            const [x, y] = String(k).split(",").map(Number);
            if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
            if (out.some(e => e.x === x && e.y === y)) continue;
            out.push({ type: "belt", variant: "default", x, y, r: 0, rv: 0, code: 1, _existing: true });
        }
    }
    return out;
}

/* ═══════════════════════════ 4. 存档回放 + 双实现拓扑对拍 ═══════════════════════════ */

/** 读 facts/live/world-full.json（2805 实体，1906 条带子，单一 regular 层）。 */
export function loadSaveWorld(file = WORLD_FULL_PATH) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data.entities.filter(e => e.layer === "regular");
}

/** 只保留带子邻居的世界（复刻 proto 脚本 [C] 项的口径，用来重现 82.5% 这条基线）。 */
export function beltOnlyWorld(entities) {
    return buildWorldModel(entities.filter(e => e.type === "belt").map(e => ({
        type: "belt", variant: "default", x: e.x, y: e.y, r: e.r, rv: e.rotation_variant,
    })));
}

/**
 * 含机器邻居地跑一遍存档带子，返回吻合率（对照 proto 的 82.5%）。
 * ⚠️ world-full.json 不带 originalRotation（obs 只回 code/r/rv/…，bridge:441-456），
 *    这里以 orig=r 为口径 —— 正是 stride=4 下**粘贴后**世界的实际状态（bridge:814），
 *    所以对编译器的意义比"复现游戏当时的 orig"更直接。
 */
export function saveFixedPointScore(entities, { machineNeighbors = true } = {}) {
    const belts = entities.filter(e => e.type === "belt");
    const world = machineNeighbors
        ? buildWorldModel(entities.map(e => ({ type: e.type, variant: e.variant, x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code })))
        : beltOnlyWorld(entities);
    let ok = 0; const drift = [];
    for (const b of belts) {
        const nb = neighborsAffecting(world, b.x, b.y);
        const got = computeBelt({ rotation: norm360(b.r), neighbors: nb });
        if (got.rotation === norm360(b.r) && got.rotationVariant === b.rotation_variant) ok++;
        else if (drift.length < 12) drift.push({ cell: [b.x, b.y], design: { r: norm360(b.r), rv: b.rotation_variant }, got: { r: got.rotation, rv: got.rotationVariant }, nb: nb.length });
    }
    return { total: belts.length, ok, pct: +(ok / belts.length * 100).toFixed(1), machineNeighbors, driftSamples: drift };
}

/**
 * ★ 双实现交叉对拍的另一条腿：用**槽位**几何（logic.js:391-470 的算法）算邻居拓扑，
 *   与 belt-rules.test.mjs 的 **OPP 回指**判据（独立代码）在同一份数据上比闭合数。
 *   期望：dnOk/dnT = 1267/1268，bothOk/bothT = 69/69（verify-belt-rules.md §3.2 实测）。
 */
export function topologyScore(entities) {
    const world = buildWorldModel(entities.map(e => ({
        type: e.type, variant: e.variant, x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code,
    })));
    const belts = entities.filter(e => e.type === "belt");
    let dnT = 0, dnOk = 0, bothT = 0, bothOk = 0;
    const isBelt = (x, y) => { const r = world.byCell.get(`${x},${y}`); return r && r.type === "belt" ? r : null; };
    for (const b of belts) {
        const exitDir = localDirToWorld(EXIT_LOCAL[b.rotation_variant], b.r);          // 槽位法：本带的 ejector 方向
        const tx = b.x + DIRV[exitDir][0], ty = b.y + DIRV[exitDir][1];
        const dn = isBelt(tx, ty);
        // 下游邻居是否"要收"本格（acceptor 命中 tile=(b.x,b.y)）
        const dnTakes = dn ? (world.acceptors.get(`${b.x},${b.y}`) || []).some(a => a.rec === dn) : false;
        if (dn) { dnT++; if (dnTakes) dnOk++; }
        if (b.rotation_variant !== 0) {
            const entryDir = localDirToWorld("bottom", b.r);
            const up = isBelt(b.x + DIRV[entryDir][0], b.y + DIRV[entryDir][1]);
            const upFeeds = up ? (world.ejectors.get(`${b.x},${b.y}`) || []).some(e => e.rec === up) : false;
            if (dn && up) { bothT++; if (dnTakes && upFeeds) bothOk++; }
        }
    }
    return { dnOk, dnT, bothOk, bothT };
}

/** 存档里的带子 rv 分布（与 belt-rules.test.mjs :184 的 {0:1487,1:223,2:196} 对拍）。 */
export function saveRvDistribution(entities) {
    const dist = { 0: 0, 1: 0, 2: 0 };
    for (const e of entities) if (e.type === "belt") dist[e.rotation_variant] = (dist[e.rotation_variant] || 0) + 1;
    return dist;
}

/** code ↔ rv 恒等（belt-rules.mjs:58-59 的 beltCode = 1+rv；存档 1906/1906）。 */
export function checkSaveBeltCodes(entities) {
    let viol = 0;
    for (const e of entities) if (e.type === "belt" && e.code !== beltCode(e.rotation_variant)) viol++;
    return viol;
}

/* ═══════════════════════════ 自测（node src/ai/compiler/belt-sim.mjs --test） ═══════════════════════════ */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/belt-sim.mjs")) {
    let fails = 0;
    const eq = (m, got, want) => {
        const A = JSON.stringify(got), B = JSON.stringify(want);
        if (A === B) console.log("✓ " + m); else { fails++; console.log(`✗ ${m}\n    got  ${A}\n    want ${B}`); }
    };
    eq("belt code→rv 表 = 1/2/3", Object.keys(BELT_CODES).map(Number), [1, 2, 3]);
    eq("computeBelt 无邻居 → rv0", computeBelt({ rotation: 0, neighbors: [] }), { rotation: 0, rotationVariant: 0 });
    eq("computeBelt 局部下方 ejector → 直带", computeBelt({ rotation: 0, neighbors: [{ toDirection: "top" }] }), { rotation: 0, rotationVariant: 0 });
    eq("computeBelt 局部左侧 ejector → +90 rv1", computeBelt({ rotation: 0, neighbors: [{ toDirection: "right" }] }), { rotation: 90, rotationVariant: 1 });
    eq("computeBelt 局部右侧 ejector → +270 rv2", computeBelt({ rotation: 0, neighbors: [{ toDirection: "left" }] }), { rotation: 270, rotationVariant: 2 });
    eq("computeBelt 下方 ejector 优先于侧向", computeBelt({ rotation: 0, neighbors: [{ toDirection: "top" }, { toDirection: "right" }] }), { rotation: 0, rotationVariant: 0 });
    eq("computeBelt 局部左侧 acceptor → r 不变 rv1", computeBelt({ rotation: 0, neighbors: [{ fromDirection: "right" }] }), { rotation: 0, rotationVariant: 1 });
    eq("computeBelt 局部右侧 acceptor → r 不变 rv2", computeBelt({ rotation: 0, neighbors: [{ fromDirection: "left" }] }), { rotation: 0, rotationVariant: 2 });
    eq("computeBelt 上方 acceptor 屏蔽侧向", computeBelt({ rotation: 0, neighbors: [{ fromDirection: "bottom" }, { fromDirection: "left" }] }), { rotation: 0, rotationVariant: 0 });

    eq("localTileToWorld r=0 恒等", localTileToWorld([1, 0], 0, [10, 20]), [11, 20]);
    eq("localTileToWorld r=90 (-y,x)+origin", localTileToWorld([1, 0], 90, [10, 20]), [10, 21]);
    eq("localTileToWorld r=270 cutter 右格", localTileToWorld([1, 0], 270, [10, 20]), [10, 19]);
    eq("localDirToWorld top@90 = right", localDirToWorld("top", 90), "right");

    // r=0 时与 op-templates.worldSlots 必须逐字相同（两份实现同一真值）
    {
        const cut = templateByBuildingVariant("cutter", "default");
        const mine = slotsFor("cutter", "default", 0, 0);
        eq("cutter 槽位数与 P2 模板一致", [mine.inputs.length, mine.outputs.length], [cut.inputs.length, cut.outputs.length]);
        eq("cutter 输入槽世界位", mine.inputs.map(i => ({ tile: localTileToWorld(i.cell, 0, [3, 4]), dir: localDirToWorld(i.dir, 0) })), [{ tile: [3, 4], dir: "bottom" }]);
        eq("cutter 输出槽世界位", mine.outputs.map(o => ({ tile: localTileToWorld(o.cell, 0, [3, 4]), dir: localDirToWorld(o.dir, 0) })), [{ tile: [3, 4], dir: "top" }, { tile: [4, 4], dir: "top" }]);
    }

    // 存档：双实现拓扑对拍（P0-verify 的独立判据）
    {
        const ents = loadSaveWorld();
        eq("存档带子数 1906", ents.filter(e => e.type === "belt").length, 1906);
        eq("rv 分布与 belt-rules.test 一致", saveRvDistribution(ents), { 0: 1487, 1: 223, 2: 196 });
        eq("code==1+rv 违反数 0", checkSaveBeltCodes(ents), 0);
        eq("槽位法下游闭合 = OPP 法 1267/1268", topologyScore(ents), { dnOk: 1267, dnT: 1268, bothOk: 69, bothT: 69 });
        console.log("  ℹ 不动点吻合（含机器邻居）:", JSON.stringify(saveFixedPointScore(ents, { machineNeighbors: true }).pct), "%");
        console.log("  ℹ 不动点吻合（只喂带子 = proto 口径）:", JSON.stringify(saveFixedPointScore(ents, { machineNeighbors: false }).pct), "%");
    }

    console.log(fails ? `belt-sim: ${fails} 条失败` : "belt-sim: 自测通过");
    if (fails) process.exitCode = 1;
}
