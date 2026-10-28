/**
 * place.mjs — 放置类宏：`insert_machine` / `extend_line`。**零游戏写操作**。
 *
 * ═════════════════════════ 角色定位 ═════════════════════════
 * LLM 是**改稿人**：它只说「在哪放什么、朝哪边」，以及「从这条带的末端再长几格」。
 * footprint 展开、origin 反解、rotation 反解、每格的 (r, rv)、槽位世界格，全部在本文件算。
 *
 * ═════════════════════════ 几何权威（一行都不自己发明） ═════════════════════════
 * · 方向旋转        → `belt-rules.mjs` 的 ORDER / OPP / DIRV / rotateLocal / solveTurn
 * · 槽位 / footprint → `op-templates.mjs` 的 templateByBuildingVariant（GEOMETRY 表1）
 * · 旋转后 footprint 的 origin 语义 → 上游 `static_map_entity.js:127-141 getTileSpaceBounds`
 *
 * ═════════════════════════ 关键几何事实（本文件依赖的，都写清来源） ═════════════════════════
 * 【G1】旋转后 footprint 的世界格 = origin + rotate90(localCell, r)，**origin 不位移**。
 *       与 getTileSpaceBounds 四档逐档等价：
 *         r=0   → [x, x+w) × [y, y+h)
 *         r=90  → [x-h+1, x] × [y, y+w)
 *         r=180 → [x-w+1, x] × [y-h+1, y]
 *         r=270 → [x, x+h) × [y-w+1, y]
 *       实测校验：level-11 存档 2805 实体按此式展开，**重叠 0 处**（204 个格）；
 *       按「不旋转的左上角展开」会有大量重叠（旋转机器占的格会错位）。
 * 【G2】槽位世界格 = origin + rotate90(localCell, r)；槽位世界方位 = rotateLocal(localDir, r)；
 *       带子该占的格 = 槽位格 + DIRV[槽位方位]（与 connect.mjs 的 F3 同一口径）。
 *       注意：本式对 r≠0 的机器**只有 observed 级凭据**（见 CAPABILITY_ASSUMPTIONS
 *       .rotated_machine_slots），所以本宏对 r≠0 **一定**返回 `rotation_not_live_verified` 警告，
 *       并要求执行方落地后读回槽位邻接自证。
 * 【G3】`place` 的 rv 由游戏按邻居猜（machine_place_sets_rv = assumed）。
 *       所以 extend_line 的每格 (rotation, rv) 由 solveTurn 反解并**逐格读回自证**；
 *       执行方必须用带显式 rv 的 paste_blueprint，或 place 后读回 code 不等即回滚。
 *
 * ═════════════════════════ 契约 ═════════════════════════
 * 入参一律先过 `contract.mjs` 的 validateInsertMachineArgs / validateExtendLineArgs。
 *
 *   insertMachine(at, facing, machine, opts?, ctx?)      ← 位置形态
 *   insertMachine({ at, facing, machine, opts }, ctx)    ← 契约形态
 *     at      = [x,y]（origin）| { cell:[x,y], part:"any" }（机器要占的任意一格，宏反解 origin）
 *     facing  = "top"|"right"|"bottom"|"left" = **primary output 的世界喷射方向**（不是 r、不是角度）
 *     machine = "cutter" | { kind:"painter", variant:"mirrored" } | …
 *     ctx     = { entities: obs.entities } | obs | { obs }，可选 { region, level }
 *
 *   extendLine(from, len, dir?, opts?, ctx?)
 *   extendLine({ from, len, dir, opts }, ctx)
 *     from    = { uid } | { cell:[x,y] }（带子末端，或机器输出口）
 *     len     = 1..500
 *     dir     = 世界方向；缺省沿用 from 当前出口（直行）。给垂直方向 = 一个 90° 转弯（首格转）。
 *
 * 返回 = 契约 MacroResult（{ok, macro, cells_planned, cells_placed, first_mismatch, changed,
 *        warnings, error, dry_run}）+ 本宏诊断字段：
 *        insert_machine → { origin, rotation, facing, site, cells, ports:{in,out}, wiring:[…],
 *                           removed_uids, expected_code, footprint, unlock, pending:PendingRef }
 *        extend_line    → { cells, from, start, terminal:{cell,exit}, terminal_orphaned, firstConflict }
 *
 * 计划态串接（E2E 验收缺陷 1）：`insert_machine` 的 `pending` 是**自描述**的实体引用
 * （footprint + 每个槽位的世界格/面），下游宏（`trash_unused` 等）不需要世界里有它就能解析：
 *     const a = insertMachine(...);   trash_unused({ outlet: { ...a.pending, port: "left" } }, ctx)
 * 要把它折进世界（让别的宏按格看到它占地），用 `applyToWorld(result, ctx)`；
 * 合成 uid 是负数（**不是**游戏 uid），真落盘仍必须走 tx + 重新 obs。
 *
 * 离线自测：node src/agent/macros/place.test.mjs
 */

import {
    ORDER, OPP, DIRV, rotateLocal, solveTurn, beltEntry, beltExit, beltCode,
} from "../../ai/belt-rules.mjs";
import { templateByBuildingVariant, isRotatable } from "../../ai/op-templates.mjs";
import { validateInsertMachineArgs, validateExtendLineArgs, validateMacroResult } from "./contract.mjs";

/* ═══════════════════════════════ 0. 小工具 ═══════════════════════════════ */

const isInt = n => typeof n === "number" && Number.isInteger(n);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const key = (x, y) => `${x},${y}`;
const cellKey = c => key(c[0], c[1]);

/** 归一成 0/90/180/270 */
const rot90 = r => (((Math.round((r || 0) / 90) * 90) % 360) + 360) % 360;

/**
 * 局部格 → 旋转后的**偏移**（不含 origin）。与上游 `Vector.rotateFastMultipleOf90` 同号：
 *   r=90  → (x,y) ↦ (-y, x)   （y 向下 ⇒ 视觉上顺时针）
 * 这是 G1 的代码化；`getTileSpaceBounds` 的四档可由它逐档推出（见本文件单测）。
 */
export function rotOffset(cell, rotation) {
    let [x, y] = cell;
    const steps = rot90(rotation) / 90;
    for (let i = 0; i < steps; i++) {
        const nx = -y, ny = x;
        x = nx; y = ny;
    }
    /* 归一掉 -0：JSON.stringify(-0) === "0"，但 assert.deepEqual 会把 -0 与 0 判为不同。
       旋转结果会参与相等比较（测试/自证），这里抹掉这个与几何无关的 JS 细节。 */
    return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

/** 方位 → 角度（诊断/回报用；不参与判定） */
const angleOf = d => ORDER.indexOf(d) * 90;

/* ═══════════════════════════════ 1. 机器几何（槽位 / footprint 的世界展开） ═══════════════════════════════ */

/**
 * 模板 + origin + rotation → 世界格与槽位。**这是本文件唯一算机器几何的地方**。
 *
 * @param {object} tpl   op-templates 的模板（footprint/inputs/outputs）
 * @param {[number,number]} origin  机器 origin（= obs 的 x,y = 左上角）
 * @param {number} rotation 0|90|180|270
 * @returns {{cells:Array<[number,number]>, inputs:Array<object>, outputs:Array<object>}}
 *   槽位对象 = { role, local, slot, dir, face, cell }
 *     slot = 机器自己那一格（世界）
 *     dir / face = 机器的那一面（世界方位）
 *     cell = 带子该占的格 = slot + DIRV[dir]
 */
export function machineGeometry(tpl, origin, rotation) {
    const r = rot90(rotation);
    const [w, h] = tpl.footprint;
    const cells = [];
    for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
            const off = rotOffset([dx, dy], r);
            cells.push([origin[0] + off[0], origin[1] + off[1]]);
        }
    }
    /* 确定序：先 y 再 x —— 冲突报告与自证顺序都必须可复现（无 RNG、无 Map 迭代序依赖） */
    cells.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

    const conv = s => {
        const off = rotOffset(s.cell, r);
        const slot = [origin[0] + off[0], origin[1] + off[1]];
        const dir = rotateLocal(s.dir, r);
        return {
            role: s.role, local: [s.cell[0], s.cell[1]],
            slot, dir, face: dir,
            cell: [slot[0] + DIRV[dir][0], slot[1] + DIRV[dir][1]],
            ...(s.filter ? { filter: s.filter } : {}),
        };
    };
    return { cells, inputs: tpl.inputs.map(conv), outputs: tpl.outputs.map(conv) };
}

/**
 * 机器的「primary output 局部方位」。facing 的定义锚点（契约 §2.2）。
 *  · 有 role="out" 的 → 用它（painter/rotater/stacker/mixer/miner）
 *  · 有 role="primary" 的 → 用它
 *  · 否则若全部输出槽同向（cutter 的 left/right 都在 top）→ 用那个方向
 *  · 否则 null（多向输出，facing 无法唯一反解 → 调用方必须显式指定）
 */
export function primaryOutputDir(tpl) {
    const outs = tpl.outputs || [];
    if (!outs.length) return null;
    const named = outs.find(s => s.role === "out") || outs.find(s => s.role === "primary");
    if (named) return named.dir;
    const dirs = new Set(outs.map(s => s.dir));
    if (dirs.size === 1) return outs[0].dir;
    return null;
}

/**
 * facing → rotation 反解：`rotateLocal(local, r) === facing`。
 *
 *   r = ((ORDER.indexOf(facing) - ORDER.indexOf(local)) + 4) % 4 × 90
 *
 * 例：cutter 的 primary output 局部 top ⇒ facing="top" → r=0；
 *     painter 的 primary output 局部 right ⇒ facing="right" → r=0、facing="top" → r=270。
 *
 * @returns {{ok:true, rotation:number, local:string} | {ok:false, local:string|null, message:string}}
 */
export function rotationForFacing(tpl, facing) {
    const local = primaryOutputDir(tpl);
    if (local === null) {
        return {
            ok: false, local: null,
            message: `${tpl.building}/${tpl.variant} 没有唯一的 primary output（输出槽 ${JSON.stringify((tpl.outputs || []).map(s => `${s.role}@${s.dir}`))}），`
                + `facing 无法反解 —— 该建筑不适合用 insert_machine 放`,
        };
    }
    if (!ORDER.includes(facing)) {
        return { ok: false, local, message: `facing "${facing}" 不是方位词` };
    }
    const rotation = (((ORDER.indexOf(facing) - ORDER.indexOf(local)) + 4) % 4) * 90;
    return { ok: true, rotation, local };
}

/**
 * `{cell:[x,y], part:"any"}` 形态反解 origin：枚举「该格是 footprint 里哪一格」。
 * 命中 0 个 → 这格根本不在任何合法摆法里；>1 个 → 多解（契约要求 ambiguous_site，不猜）。
 * @returns {Array<[number,number]>} 去重后的 origin 候选（确定序：先 y 再 x）
 */
export function candidateOrigins(tpl, rotation, cell) {
    const r = rot90(rotation);
    const [w, h] = tpl.footprint;
    const seen = new Set();
    const out = [];
    for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
            const off = rotOffset([dx, dy], r);
            const origin = [cell[0] - off[0], cell[1] - off[1]];
            const k = cellKey(origin);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(origin);
        }
    }
    out.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
    return out;
}

/* ═══════════════════════════════ 2. 只读世界模型 ═══════════════════════════════ */

/**
 * 从 obs.entities 建只读世界。与 connect.buildWorld 的差别只有一处、但很关键：
 * **footprint 按 rotation 展开**（G1）。不这样做，r≠0 的既有机器占的格会错位，
 * 于是 insert_machine 会把新机器摆到别人的机身里而报 ok。
 *
 * @param {Array} entities obs.entities
 * @param {{region?:number[]}} [opt]
 */
export function buildWorld(entities, opt = {}) {
    if (!Array.isArray(entities)) throw new TypeError("buildWorld(entities) 需要 obs.entities 数组");
    const cells = new Map();      // "x,y" → rec（该格属于哪个实体）
    const byUid = new Map();
    const byOrigin = new Map();
    const gaps = [];

    for (const e of entities) {
        if (!e || typeof e !== "object") continue;
        if (!isInt(e.x) || !isInt(e.y)) continue;
        if (e.layer !== undefined && e.layer !== "regular") continue;   // v1 单层
        const variant = e.variant || "default";
        const tpl = templateByBuildingVariant(e.type, variant);
        const [w, h] = tpl ? tpl.footprint : [1, 1];
        if (!tpl) {
            /* 未建模的建筑（隧道 / balancer / 其它 mod 建筑）保守按 1×1 占位：宁可多报 occupied，不可少报。
               按 type 去重登记，别把 3000 实体刷成 3000 行 gap。 */
            if (!gaps.includes(`${e.type}/${variant}`)) gaps.push(`${e.type}/${variant}`);
        }
        const rec = {
            uid: e.uid, type: e.type, x: e.x, y: e.y,
            r: rot90(e.r === undefined ? 0 : e.r),
            rv: e.rotation_variant === undefined ? 0 : e.rotation_variant,
            variant, w, h, tpl,
        };
        byUid.set(rec.uid, rec);
        byOrigin.set(key(rec.x, rec.y), rec);
        for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
                const off = rotOffset([dx, dy], rec.r);
                const k = key(rec.x + off[0], rec.y + off[1]);
                if (!cells.has(k)) cells.set(k, rec);
            }
        }
    }
    return { cells, byUid, byOrigin, entities: entities.slice(), gaps, region: opt.region || null };
}

const worldCache = new WeakMap();   // entities 数组 → Map(regionKey → world)
/** ctx 的四种写法（entities 数组 / obs / {obs} / 已是 world）统一成 world；只读、带缓存。
 *  缓存键 = 数组引用 + region：同一个 entities 数组配不同 region 是两次不同的观测范围，
 *  用同一个数组引用做键会把「范围外」和「范围内为空」混为一谈。 */
function worldFor(ctx) {
    if (!ctx) return null;
    if (ctx.cells instanceof Map && ctx.byUid instanceof Map) return ctx;
    let ents = ctx.entities;
    if (ents && !Array.isArray(ents) && Array.isArray(ents.entities)) ents = ents.entities;   // obs 整体
    if (!Array.isArray(ents) && ctx.obs && Array.isArray(ctx.obs.entities)) ents = ctx.obs.entities;
    if (!Array.isArray(ents) && Array.isArray(ctx.world && ctx.world.entities)) ents = ctx.world.entities;
    if (!Array.isArray(ents)) return null;
    const region = Array.isArray(ctx.region) && ctx.region.length === 4 ? ctx.region.slice() : null;
    const regionKey = region ? region.join(",") : "-";
    let perRegion = worldCache.get(ents);
    if (!perRegion) { perRegion = new Map(); worldCache.set(ents, perRegion); }
    let w = perRegion.get(regionKey);
    if (!w) {
        w = buildWorld(ents, { region });
        perRegion.set(regionKey, w);
    }
    return w;
}

/** 端点 → 实体记录（uid 优先；cell 必须是 origin，与契约同口径） */
function resolveEntity(ep, world, field) {
    if (!world) {
        return { ok: false, code: "precondition_failed", message: `${field} 需要 ctx.entities（obs 的实体表）才能解析` };
    }
    if (ep.uid !== undefined) {
        const r = world.byUid.get(ep.uid);
        return r ? { ok: true, rec: r } : { ok: false, code: "endpoint_not_found", message: `${field}.uid=${ep.uid} 不在世界（obs 过期或已被删）` };
    }
    if (ep.cell !== undefined) {
        const r = world.byOrigin.get(cellKey(ep.cell));
        return r ? { ok: true, rec: r } : { ok: false, code: "endpoint_not_found", message: `${field}.cell=[${ep.cell}] 不是任何实体的 origin` };
    }
    if (ep.hub !== undefined) {
        const hubs = [...world.byUid.values()].filter(r => r.type === "hub");
        if (ep.hub.uid !== undefined) {
            const r = world.byUid.get(ep.hub.uid);
            if (r && r.type === "hub") return { ok: true, rec: r };
            return { ok: false, code: "endpoint_not_found", message: `${field}.hub.uid=${ep.hub.uid} 不是 hub` };
        }
        if (hubs.length === 1) return { ok: true, rec: hubs[0] };
        return { ok: false, code: "endpoint_not_found", message: `世界里有 ${hubs.length} 个 hub，${field} 无法唯一确定` };
    }
    return { ok: false, code: "bad_type", message: `${field} 形态不认识` };
}

/** 实体 → 世界槽位（非机器返回空表；footprint/槽位未知时 tpl 缺失也返回空表） */
function portsWorld(rec) {
    if (!rec.tpl) return { inputs: [], outputs: [] };
    const g = machineGeometry(rec.tpl, [rec.x, rec.y], rec.r);
    return { inputs: g.inputs, outputs: g.outputs };
}

/* ═══════════════════════════════ 3. 接线判定（"放下去了能不能工作"） ═══════════════════════════════ */

/**
 * 某一格的状态（对「本机器的某个槽位」而言）。
 *   输入槽：cell 上有带子且 beltExit === OPP[dir]  → 带子朝机器喷 ⇒ 供得上
 *   输出槽：cell 上有带子且 beltEntry === OPP[dir] → 带子朝机器接货 ⇒ 有去处
 * 机器紧贴（0 格连接）：对端的输出/输入槽**带格**正好等于本槽的 cell，且流向闭合 ⇒ 也算通。
 *
 * @returns {{status:"ok"|"nothing"|"mismatch", why?:string, uid?:number, type?:string}}
 */
function classifyFeed(world, port, kind) {
    const rec = world ? world.cells.get(cellKey(port.cell)) : null;
    if (!rec) return { status: "nothing" };

    if (rec.type === "belt") {
        const b = world.byUid.get(rec.uid);
        if (!b) return { status: "nothing" };
        const face = kind === "in" ? beltExit(b.rv, b.r) : beltEntry(b.rv, b.r);
        const want = OPP[port.dir];
        if (face === want) return { status: "ok", uid: b.uid, type: "belt" };
        return {
            status: "mismatch", uid: b.uid, type: "belt",
            why: `${b.x},${b.y} 的带子 ${kind === "in" ? "exit" : "entry"}=${face}，不是 ${want}`
                + `（${kind === "in" ? "它没有朝这台机器喷" : "它不会从这台机器接货"}）`,
        };
    }

    /* 非带子：看它的槽位表里有没有一个槽正好落在同一格、且背靠背闭合（机器↔机器紧贴 = 0 格连接）。
       本槽带格 C = slot + DIRV[dir]；对端要么占着 C 且有一个面朝回本机（face = OPP[dir]）的槽。
       只判「朝向闭合」，不判「同向」—— 同向是两个背对背，谁也没接谁。 */
    const other = world.byUid.get(rec.uid);
    if (other && other.tpl) {
        const ports = portsWorld(other);
        const list = kind === "in" ? ports.outputs : ports.inputs;
        /* 0 格连接有两种口径，必须都认，否则会把真连接误报成 mismatch：
             a) 对端有一个槽的**带格**落在本槽的朝向上（ejector 喷进 acceptor 的带格）
             b) 对端有一个槽的**槽格**正好等于本槽的带格、面朝回本机（两个槽贴在同一格上） */
        const hitA = list.find(q => q.cell[0] === port.cell[0] && q.cell[1] === port.cell[1] && q.dir === OPP[port.dir]);
        const hitB = list.find(q => q.slot[0] === port.cell[0] && q.slot[1] === port.cell[1] && q.dir === OPP[port.dir]);
        if (hitA || hitB) return { status: "ok", uid: other.uid, type: other.type };
        const anySlot = list.find(q =>
            (q.slot[0] === port.cell[0] && q.slot[1] === port.cell[1])
            || (q.cell[0] === port.cell[0] && q.cell[1] === port.cell[1] && q.dir === port.dir));
        if (anySlot) {
            return {
                status: "mismatch", uid: other.uid, type: other.type,
                why: `${other.type}@${other.x},${other.y} 的槽位面 =${anySlot.dir}，不是 ${OPP[port.dir]}（背对背，接不上）`,
            };
        }
        return {
            status: "mismatch", uid: other.uid, type: other.type,
            why: `${other.type}@${other.x},${other.y} 没有朝这一格的${kind === "in" ? "输出" : "输入"}槽`,
        };
    }
    return { status: "mismatch", uid: rec.uid, type: rec.type, why: `${rec.type} 没有可解析的槽位表` };
}

/* ═══════════════════════════════ 4. insert_machine ═══════════════════════════════ */

/** 本宏支持的建筑（契约 §2.2 的 whenNotToUse 决定了 hub/balancer 不在此列） */
export const SUPPORTED_BUILDINGS = Object.freeze({
    miner: ["default", "chainable"],
    cutter: ["default"],
    rotater: ["default", "ccw", "rotate180"],
    stacker: ["default"],
    mixer: ["default"],
    painter: ["default", "mirrored", "double"],
    trash: ["default"],
});

const supportedHint = () => Object.entries(SUPPORTED_BUILDINGS)
    .map(([b, vs]) => `${b}(${vs.join("|")})`).join(" / ");

/**
 * 在 at 放一台机器，朝向 facing。**只读**：返回计划，不落盘。
 *
 * @param {object|[number,number]} a 契约形态 args；或位置形态的 at
 * @param {string} [b] 位置形态的 facing
 * @param {string|object} [c] 位置形态的 machine
 * @param {object} [d] 位置形态的 opts
 * @param {object} [e] 位置形态的 ctx
 */
export function insertMachine(a, b, c, d, e) {
    let args, ctx;
    if (isObj(a) && (a.at !== undefined || a.machine !== undefined)) {
        args = a; ctx = b || {};
    } else {
        args = { at: a, facing: b, machine: c, opts: d };
        ctx = e || {};
    }

    const v = validateInsertMachineArgs(args);
    if (!v.ok) return failure("insert_machine", v.error);

    const { at, facing, machine, opts } = v.value;
    const world = worldFor(ctx);
    const warnings = [];

    /* ── ① 模板：槽位/footprint/code 的唯一真值 ── */
    const tpl = templateByBuildingVariant(machine.kind, machine.variant);
    if (!tpl) {
        return failure("insert_machine", {
            code: "unsupported_building", field: "machine",
            message: `op-templates 里没有 ${machine.kind}/${machine.variant}（或该变体不存在）`,
            hint: `本宏支持：${supportedHint()}`,
        });
    }
    if (tpl.v1Blocked) {
        return failure("insert_machine", {
            code: "unsupported_building", field: "machine",
            message: `${machine.kind}/${machine.variant} 标记为 v1Blocked（${tpl.note || "多路输出需汇合方案"}）`,
            hint: `先放可用的变体；quad 类变体留给 build_line / 后续合并宏。支持：${supportedHint()}`,
        });
    }
    if (machine.kind === "hub") {
        return failure("insert_machine", {
            code: "unsupported_building", field: "machine",
            message: "hub 不能用 insert_machine 放（它是终点、不可删、不可转）",
            hint: "hub 的选址/入口由 build_line 规划；本宏只放加工机器与 trash。",
        });
    }
    if (!(SUPPORTED_BUILDINGS[machine.kind] || []).includes(machine.variant)) {
        return failure("insert_machine", {
            code: "unsupported_building", field: "machine",
            message: `${machine.kind}/${machine.variant} 不在本宏支持矩阵`,
            hint: `支持：${supportedHint()}。balancer 是布线元件，由 connect 的扇出改写处理。`,
        });
    }

    /* ── ② rotation：facing → r 反解（不是调用方给的角度） ── */
    const hasOut = (tpl.outputs || []).length > 0;
    let rotation = 0;
    let facingOut = facing;
    if (!hasOut) {
        /* 无输出槽的机器只有 trash：上游 getIsRotateable()=false ⇒ 游戏里恒 r=0 */
        if (facing !== null) {
            warnings.push({
                code: "facing_ignored",
                detail: `${machine.kind} 没有输出槽且 getIsRotateable()=false ⇒ 游戏里恒 r=0；facing="${facing}" 已忽略`,
                hint: "trash 四边全收，方向无意义 —— 通常该用 trash_unused（它会检查 outlet 是否真的没去处）。",
            });
        }
        rotation = 0;
        facingOut = null;
    } else if (facing === null) {
        if (isRotatable(machine.kind) === false) {
            rotation = 0;
        } else {
            return failure("insert_machine", {
                code: "ambiguous_site", field: "facing",
                message: `${machine.kind} 有 ${tpl.outputs.length} 个输出槽且可旋转 ⇒ facing 必填（旋转不变以外的机器不给 facing 无法确定朝向）`,
                hint: `facing = primary output 的世界喷射方向。${machine.kind}/${machine.variant} 的 primary 局部在 ${primaryOutputDir(tpl)}。`,
            });
        }
    } else {
        const rr = rotationForFacing(tpl, facing);
        if (!rr.ok) {
            return failure("insert_machine", {
                code: "ambiguous_site", field: "facing", message: rr.message,
                hint: "这类建筑请显式给 rotation 无关的摆法，或改用 connect（它不改机器朝向）。",
            });
        }
        rotation = rr.rotation;
        facingOut = facing;
    }

    /* ── ③ origin：两种形态不混用（一个走算术、一个不走） ── */
    let origin;
    let site = null;          // {mode, candidates, chosen_by} —— 多解时如实回报依据
    if (at.kind === "origin") {
        origin = [at.cell[0], at.cell[1]];
    } else {
        const cands = candidateOrigins(tpl, rotation, at.cell);
        if (cands.length === 0) {
            return failure("insert_machine", {
                code: "precondition_failed", field: "at",
                message: `[${at.cell}] 不在 ${machine.kind}/${machine.variant} @ rotation=${rotation} 的任何 footprint 里`,
                hint: "at 必须是这台机器**要占的其中一格**（来自 obs 的那条带子）。",
            });
        }
        if (cands.length > 1) {
            /* 多解（2×1 / 2×2 机器）：以前直接 ambiguous_site —— 于是契约承诺的
               「调用方一个坐标都不给」在多格机器上永远做不到（E2E 缺陷 4）。
               现在先按**语义**判：`at.cell` 是机器输入槽的落点格（= 货流进机器的入口）
               的那个 origin。插进一段带子时，调用方指的那一格正是「要喂给机器的那格」，
               所以它有唯一语义，不是猜。
               仍然多解 ⇒ 不猜，报 ambiguous_site 并给出可直接用的 at。 */
            const hits = cands.filter(o => {
                const g = machineGeometry(tpl, o, rotation);
                return g.inputs.some(p => cellKey(p.slot) === cellKey(at.cell));
            });
            if (hits.length === 1) {
                origin = hits[0];
                /* 消歧依据进 `site`（诊断字段），不进 warnings：warning 码是契约闭集，
                   这里不是"要处理的风险"，而是"宏替你把多解收窄了"的事实记录。 */
                site = {
                    mode: "any-cell", candidates: cands, chosen_by: "input-slot",
                    why: `{cell:${JSON.stringify(at.cell)}} 可反解出 ${cands.length} 个 origin；`
                        + `只有 ${JSON.stringify(hits[0])} 让这一格成为机器的**输入槽槽格**（machine 自己那格），据此选定`,
                };
            } else {
                return failure("insert_machine", {
                    code: "ambiguous_site", field: "at",
                    message: `[${at.cell}] 可反解出 ${cands.length} 个 origin（高 ${tpl.footprint[1]} 宽 ${tpl.footprint[0]}），且这一格不是唯一的输入槽落点`,
                    hint: `改用 origin 形态 \`at:[x,y]\` 直接指定左上角。候选：${cands.map(c2 => JSON.stringify(c2)).join(" / ")}`,
                    candidates: cands.map(c2 => ({ origin: c2 })),
                });
            }
        } else {
            origin = cands[0];
            site = { mode: "any-cell", candidates: cands, chosen_by: "unique" };
        }
    }

    /* ── ④ 世界模型必须存在：没有 obs 就无从谈"格子空不空" ── */
    if (!world) {
        return failure("insert_machine", {
            code: "precondition_failed", field: "at",
            message: "没有 ctx.entities（obs 实体表）⇒ 无法检查占位，拒绝在盲区放机器",
            hint: "先 obs，把 entities 传进来。凭空放机器正是「把假设当结论用」。",
        });
    }

    const geom = machineGeometry(tpl, origin, rotation);

    /* region 有给 => 落点必须在观测范围内（否则"空格"只是"没看见"） */
    if (world.region) {
        const [x0, y0, x1, y1] = world.region;
        const outside = geom.cells.find(([x, y]) => x < x0 || x > x1 || y < y0 || y > y1);
        if (outside) {
            return failure("insert_machine", {
                code: "precondition_failed", field: "at",
                message: `footprint 有格 ${outside} 在观测范围 [${world.region}] 之外`,
                hint: "先扩大 obs 的 region；范围外的空格不代表真空。",
            });
        }
    }

    /* ── ⑤ 占位：机器/hub 永不让位；带子按 opts.replace_belts ── */
    const conflicts = [];
    const replaced = [];
    for (const [x, y] of geom.cells) {
        const rec = world.cells.get(key(x, y));
        if (!rec) continue;
        if (rec.type === "belt") {
            if (opts.replace_belts) replaced.push(rec);
            else conflicts.push({ x, y, what: "belt", uid: rec.uid });
            continue;
        }
        conflicts.push({ x, y, what: rec.type, uid: rec.uid });
    }
    if (conflicts.length) {
        /* 确定序：先 y 再 x（geom.cells 已排好，这里再兜一次） */
        conflicts.sort((p, q) => (p.y - q.y) || (p.x - q.x));
        const fc = conflicts[0];
        const isMachine = fc.what !== "underground_belt" && fc.what !== "wire";
        return failure("insert_machine", {
            code: isMachine ? "blocked_by_machine" : "occupied",
            field: "at",
            message: `footprint 覆盖到 ${fc.what}@${fc.x},${fc.y}（uid=${fc.uid}，共 ${conflicts.length} 处冲突）`,
            hint: "机器永远不会被覆盖。换落点，或用 remove_run 删掉挡路的带子（带子才可让位）。",
            firstConflict: fc,
            detail: { conflicts: conflicts.slice(0, 8), origin, rotation },
        });
    }

    /* 同一台带子被两个 footprint 格命中（2×1 机器横跨同一台机器？不可能，但兜住） */
    const replacedUniq = [...new Map(replaced.map(r => [r.uid, r])).values()]
        .sort((p, q) => (p.y - q.y) || (p.x - q.x));

    if (replacedUniq.length) {
        warnings.push({
            code: "replacing_belts",
            detail: `footprint 内有 ${replacedUniq.length} 格既有带子（uid ${replacedUniq.map(r => r.uid).join(", ")}）`
                + `→ 执行时必须 delete{uid} 并纳入 tx 回滚`,
        });
    }

    /* ── ⑥ 解锁等级（ctx.level 有给才判；obs 里没有等级字段） ── */
    const level = Number.isFinite(ctx && ctx.level) ? ctx.level : (Number.isFinite(ctx && ctx.game_level) ? ctx.game_level : null);
    const unlock = { level: tpl.unlockLevel, checked: level !== null };
    if (level !== null && tpl.unlockLevel > level) {
        return failure("insert_machine", {
            code: "precondition_failed", field: "machine",
            message: `${machine.kind}/${machine.variant} 需要 level ${tpl.unlockLevel}，当前 ${level}`,
            hint: "先解锁；这属于计划不可行，不是几何问题（换落点没用）。",
            detail: { unlock },
        });
    }

    /* ── ⑦ 能不能工作：逐槽位判供料/去处（这是本宏与"只查空格"的分界线） ── */
    const wiring = [];
    const inCells = new Set(geom.inputs.map(p => cellKey(p.cell)));
    const outCells = new Set(geom.outputs.map(p => cellKey(p.cell)));
    const footprintSet = new Set(geom.cells.map(c => cellKey(c)));

    for (const p of geom.inputs) {
        const c = classifyFeed(world, p, "in");
        const insideOwn = footprintSet.has(cellKey(p.cell));
        const status = insideOwn ? "mismatch" : c.status;
        wiring.push({
            kind: "in", role: p.role, slot: p.slot, cell: p.cell, dir: p.dir, status,
            ...(c.uid !== undefined ? { uid: c.uid, type: c.type } : {}),
            ...(insideOwn ? { why: "该槽位的带格落在本机 footprint 内 —— 几何上不可能接到" } : (c.why ? { why: c.why } : {})),
        });
        if (status === "nothing") {
            warnings.push({
                code: "input_not_fed", cell: p.cell, role: p.role,
                detail: `输入槽 ${p.role}@${p.slot}（面 ${p.dir}）的带格 ${p.cell} 是空的 —— 没有上游供料`,
                hint: "放下去也不会工作。先用 connect 把上游接过来，或换一个上游已经有带子的落点。",
            });
        } else if (status === "mismatch") {
            warnings.push({
                code: "input_belt_wrong_direction", cell: p.cell, role: p.role,
                detail: `输入槽 ${p.role} 的带格 ${p.cell} 上的东西接不上：${wiring[wiring.length - 1].why}`,
                hint: "带子方向反了或落点被别的机器占着；这两种都不是「放下就好」，执行方必须修。",
            });
        }
    }
    for (const p of geom.outputs) {
        const c = classifyFeed(world, p, "out");
        const insideOwn = footprintSet.has(cellKey(p.cell));
        const status = insideOwn ? "mismatch" : c.status;
        wiring.push({
            kind: "out", role: p.role, slot: p.slot, cell: p.cell, dir: p.dir, status,
            ...(c.uid !== undefined ? { uid: c.uid, type: c.type } : {}),
            ...(insideOwn ? { why: "该槽位的带格落在本机 footprint 内 —— 几何上不可能接到" } : (c.why ? { why: c.why } : {})),
        });
        if (status === "nothing") {
            warnings.push({
                code: "output_not_connected", cell: p.cell, role: p.role,
                detail: `输出槽 ${p.role}@${p.slot}（面 ${p.dir}）的带格 ${p.cell} 是空的 —— 产物没有去处`,
                hint: "机器会因为出口堵住而停转。执行后用 extend_line/connect 接下游，或确认它就是缓冲。",
            });
        } else if (status === "mismatch") {
            warnings.push({
                code: "output_belt_wrong_direction", cell: p.cell, role: p.role,
                detail: `输出槽 ${p.role} 的带格 ${p.cell} 上的东西接不上：${wiring[wiring.length - 1].why}`,
                hint: "下游带子方向反了（它不会从机器接货）。执行方必须修，否则机器出口堵死。",
            });
        }
    }
    /* trash 四边全收：全部 4 个输入都没料时只报一条，避免 4 条同名警告 */
    if (machine.kind === "trash") {
        const nothing = wiring.filter(w => w.kind === "in" && w.status === "nothing");
        if (nothing.length === wiring.filter(w => w.kind === "in").length && nothing.length) {
            for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i].code === "input_not_fed") warnings.splice(i, 1);
            warnings.push({
                code: "input_not_fed",
                cell: nothing[0].cell,
                detail: `trash 四邻 ${nothing.map(w => `[${w.cell}]`).join(" ")} 全空 —— 这台垃圾桶什么也收不到`,
                hint: "trash 的落点必须正好在喷口格（偏一格就完全收不到）。",
            });
        }
    }

    /* ⑦b 被替换的带子：它的上游/下游会不会因此断掉（"放下去了但把旧线弄死了"）。
       口径（两边都要求"原先真的接着"）：
         上游断 = 上游带子的 exit 指向被替换格（exit(a)===OPP[entry(b)]），且本机在该方向没有输入槽
         下游断 = 下游带子的 entry 指向被替换格（exit(b)===OPP[entry(c)]），且本机在该方向没有输出槽
       注意：被替换格自己那一对相邻关系必然消失（格子没了）；这里报的是**跨越被替换格的连线**，
       所以判据用被替换格自己的入口面/出口面做参照。 */
    const upBreaks = [];
    const downBreaks = [];
    for (const b of replacedUniq) {
        const entryFace = beltEntry(b.rv, b.r);     // 货流进来那一面
        const exitFace = beltExit(b.rv, b.r);       // 货流出去那一面
        const upCell = [b.x + DIRV[entryFace][0], b.y + DIRV[entryFace][1]];
        const up = world.cells.get(key(upCell[0], upCell[1]));
        /* 上游若正好落在本机的某个输入槽带格上，那机器接力了，不算断 */
        if (up && up.type === "belt" && !inCells.has(cellKey(upCell))) {
            const ub = world.byUid.get(up.uid);
            if (ub && beltExit(ub.rv, ub.r) === OPP[entryFace]) upBreaks.push({ uid: ub.uid, cell: [ub.x, ub.y], into: [b.x, b.y] });
        }
        const dnCell = [b.x + DIRV[exitFace][0], b.y + DIRV[exitFace][1]];
        const dn = world.cells.get(key(dnCell[0], dnCell[1]));
        if (dn && dn.type === "belt" && !outCells.has(cellKey(dnCell))) {
            const db = world.byUid.get(dn.uid);
            if (db && beltEntry(db.rv, db.r) === OPP[exitFace]) downBreaks.push({ uid: db.uid, cell: [db.x, db.y], from: [b.x, b.y] });
        }
    }
    const seenBreak = new Set();
    for (const br of upBreaks) {
        const k = `u${br.uid}`;
        if (seenBreak.has(k)) continue;
        seenBreak.add(k);
        warnings.push({
            code: "orphaned_upstream", cell: br.cell, uid: br.uid,
            detail: `被替换的带子有上游 ${br.uid}@${br.cell} 正朝它喷，而本机在这个方向没有输入槽 ⇒ 那条线会堵在这里`,
            hint: "这是「机器能工作、但把旧线剪断了」。要么换落点，要么连带改上游（connect/remove_run）。",
        });
    }
    for (const br of downBreaks) {
        const k = `d${br.uid}`;
        if (seenBreak.has(k)) continue;
        seenBreak.add(k);
        warnings.push({
            code: "orphaned_downstream", cell: br.cell, uid: br.uid,
            detail: `被替换的带子下游 ${br.uid}@${br.cell} 原本从它接货，而本机在这个方向没有输出槽 ⇒ 下游会断供`,
            hint: "同上：机器能转，但旧线断了一截。",
        });
    }

    /* ⑦c r≠0 的槽位公式只有 observed 级凭据 —— 必须如实标注并要求读回自证 */
    if (rotation !== 0) {
        warnings.push({
            code: "rotation_not_live_verified",
            rotation,
            detail: `facing="${facingOut}" 反解出 rotation=${rotation}；槽位公式（G2）在实机上是 observed 级、`
                + `且与 WHY-NO-CUTTER-INSERT 的旧结论冲突（CAPABILITY_ASSUMPTIONS.rotated_machine_slots）`,
            hint: "执行方落地后必须用 obs/debug_items 读回槽位邻接并逐条比对 wiring；任一 mismatch 即回滚并报 verification_failed。",
        });
    }
    if (wiring.some(w => w.status === "mismatch")) {
        warnings.push({
            code: "wiring_mismatch",
            detail: `有 ${wiring.filter(w => w.status === "mismatch").length} 个槽位接不上（见 wiring[].status=mismatch）`,
            hint: "机器放下去了但某些口是死的；执行方要么先修线，要么承认这是部分可用。",
        });
    }
    /* 世界里存在 op-templates 没建模的建筑（隧道/balancer）⇒ 它们的占位只有 1×1 的保守假设。
       只在这台机器的 footprint 真的挨着它们时才报，避免每条结果都挂一条无关警告。 */
    if (world.gaps.length) {
        const near = geom.cells.some(([x, y]) => {
            for (const d of ORDER) {
                const rec = world.cells.get(key(x + DIRV[d][0], y + DIRV[d][1]));
                if (rec && !rec.tpl) return true;
            }
            return false;
        });
        if (near) {
            warnings.push({
                code: "world_unknown_entities",
                detail: `footprint 邻接的建筑不在 op-templates（${world.gaps.join("、")}）→ 它们的占地按 1×1 保守假设`,
                hint: "这些建筑的真正 footprint 未建模；若它们是多格建筑，落点检查可能漏判。",
            });
        }
    }

    const result = {
        ok: true,
        macro: "insert_machine",
        cells_planned: geom.cells.length,
        cells_placed: geom.cells.length,     // 每格都过了本文件的自证（见 §5 verifyPlacement）
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: replacedUniq.map(r => r.uid) },
        warnings,
        error: null,
        dry_run: true,
        /* ── 诊断字段 ── */
        origin: [origin[0], origin[1]],
        rotation,
        facing: facingOut,
        site,
        machine: { kind: machine.kind, variant: machine.variant },
        footprint: [tpl.footprint[0], tpl.footprint[1]],
        cells: geom.cells.map(([x, y]) => ({ x, y })),
        /* 每条宏的结果都自带"怎么执行"的提示：本宏只读，落盘由调用方 tx/paste 做。
           expected_code 是落地后**必须读回**的值（契约 invariant），不是建议。 */
        execution: {
            needs_tx: true,
            read_back: ["code", "x", "y", "r"],
            note: `先 delete{uid} 掉 removed_uids（${replacedUniq.length} 条带子），再 place{code:${tpl.code}, x:${origin[0]}, y:${origin[1]}, r:${rotation}}；`
                + `读回 code 必须等于 ${tpl.code}，否则回滚并报 verification_failed。`,
        },
        ports: {
            in: geom.inputs.map(p => ({ role: p.role, slot: p.slot, cell: p.cell, dir: p.dir })),
            out: geom.outputs.map(p => ({ role: p.role, slot: p.slot, cell: p.cell, dir: p.dir })),
        },
        wiring,
        /* ── 计划态引用：让下游宏（trash_unused / remove_run via applyToWorld）能消费 ── */
        pending: pendingRefOf({
            macro: "insert_machine", kind: machine.kind, variant: machine.variant,
            origin, rotation, cells: geom.cells,
            inputs: geom.inputs, outputs: geom.outputs,
        }),
        removed_uids: replacedUniq.map(r => r.uid),
        /* 执行方读回时要对的值（契约 invariant：读回 code 必须等于 op-templates 的 code） */
        expected_code: tpl.code,
        expected_rotation_variant: 0,
        unlock,
    };
    const chk = validateMacroResult(result);
    if (!chk.ok) return failure("insert_machine", { code: "internal", field: chk.error.field, message: `返回值不合契约：${chk.error.message}` });
    return result;
}

/* ═══════════════════════════════ 4b. 计划态引用（PendingRef） ═══════════════════════════════ */

/**
 * 把本宏算出的机器几何打包成一个**计划态实体引用**。
 *
 * 为什么需要（E2E 验收缺陷 1）：宏是纯规划器，`insert_machine` 的产物没有 uid
 * （uid 由 tx 分配）。下游宏（`trash_unused` 等）原本只认 `uid>=0`，于是
 * 「insert_machine → trash_unused」在计划态断链 —— 而组合正是这套设计的核心。
 *
 * 这个引用是**自描述**的：带 footprint 与每个槽位的世界格/面，下游宏不需要世界里有它
 * 也能按几何解析。要把它折进世界（让 `remove_run`/`connect` 看到它占地），用 `applyToWorld`。
 *
 * @returns {object} 形状见 contract.mjs 的 PENDING_REF_SPEC
 */
export function pendingRefOf({ macro, kind, variant = "default", origin, rotation = 0, cells, inputs = [], outputs = [], token = null }) {
    const conv = q => ({
        role: q.role, index: q.index || 0,
        slot: [q.slot[0], q.slot[1]], cell: [q.cell[0], q.cell[1]],
        dir: q.dir, face: q.dir,
    });
    return {
        pending: true,
        token: token || `${macro}:${kind}@${origin[0]},${origin[1]}`,
        macro, kind, variant, rotation,
        origin: [origin[0], origin[1]],
        cells: cells.map(c => [c[0], c[1]]).sort((a, b) => (a[1] - b[1]) || (a[0] - b[0])),
        ports: { in: inputs.map(conv), out: outputs.map(conv) },
        uid: null,      // 计划态没有 uid；applyToWorld 后才有（负数是合成 uid，不是游戏 uid）
    };
}

/**
 * 把一次（或多次）宏调用的**计划产物折进世界**，得到一个可继续喂给下游宏的新 ctx。
 *
 * 语义边界（必须诚实）：
 *   · 写进新 entities 的机器带**合成负 uid**（-1, -2…），它只在本进程内有效，
 *     **不是**游戏 uid，也绝不能出现在 `intent.removes[].expect` 里；
 *   · 只做「删旧 + 加新」两件事，不校验、不落盘、不碰游戏；
 *   · 真正的落盘仍必须走 tx，落地后重新 obs 拿真 uid。
 *
 * @param {object|object[]} resultOrResults 宏返回值（单个 / 数组）
 * @param {{entities:Array}} [ctx]         当前世界（可选；给了就基于它生成新世界）
 * @returns {{entities:Array, added:Array<{token,uid,kind,origin}>, removed:number[], ctx:{entities:Array}}}
 */
export function applyToWorld(resultOrResults, ctx = {}) {
    const results = Array.isArray(resultOrResults) ? resultOrResults : [resultOrResults];
    const base = Array.isArray(ctx.entities) ? ctx.entities.slice() : [];
    const removed = [];
    for (const r of results) {
        if (!r || typeof r !== "object") continue;
        const rm = (r.changed && Array.isArray(r.changed.removed_uids)) ? r.changed.removed_uids
            : (Array.isArray(r.removed_uids) ? r.removed_uids : []);
        for (const u of rm) if (Number.isInteger(u) && u >= 0) removed.push(u);
        for (const it of (Array.isArray(r.removes) ? r.removes : [])) {
            if (it && Number.isInteger(it.uid) && it.uid >= 0) removed.push(it.uid);
        }
    }
    const removedSet = new Set(removed);
    const entities = base.filter(e => !removedSet.has(e.uid));

    /* 收集 pending：单机 (r.pending) 与多建筑 (r.placed[].pending) 都认；同一 token 只加一次 */
    const pend = [];
    const seen = new Set();
    const push = p => {
        if (!p || p.pending !== true || seen.has(p.token)) return;
        seen.add(p.token);
        pend.push(p);
    };
    for (const r of results) {
        if (!r || typeof r !== "object") continue;
        push(r.pending);
        for (const it of (Array.isArray(r.placed) ? r.placed : [])) push(it.pending);
    }
    const added = [];
    pend.forEach((p, i) => {
        const uid = -(i + 1);           // 合成 uid：负数 ⇒ 一眼能看出「不是游戏 uid」
        entities.push({
            uid, type: p.kind, variant: p.variant,
            x: p.origin[0], y: p.origin[1], r: p.rotation,
            rotation_variant: 0, layer: "regular", synthetic: true,
        });
        added.push({ token: p.token, uid, kind: p.kind, origin: [p.origin[0], p.origin[1]] });
    });
    return { entities, added, removed: [...removedSet], ctx: { entities } };
}

/* ═══════════════════════════════ 5. extend_line ═══════════════════════════════ */

/**
 * 从 from 沿 dir 再接 len 格带子。**只读**：返回计划，不落盘。
 *
 * 首格位置（写死，避免歧义）：
 *   · from 是带子：首格 = from.cell + DIRV[from 的当前出口]。`dir` 与出口垂直时，
 *     **首格自己就是那个 90° 弯**（from 是既有实体，本宏不改它 —— 契约 §2.4 "不改既有实体"）。
 *   · from 是机器：首格 = 选中输出槽的带格（= 槽格 + DIRV[槽面]）。
 * 后续每格都沿 dir 直行（一次调用只允许一个 90° 弯，契约 §2.4）。
 *
 * @param {object|[object]} a 契约形态 args；或位置形态的 from
 * @param {number} [b] 位置形态的 len
 * @param {string} [c] 位置形态的 dir
 * @param {object} [d] 位置形态的 opts
 * @param {object} [e] 位置形态的 ctx
 */
export function extendLine(a, b, c, d, e) {
    let args, ctx;
    if (isObj(a) && (a.from !== undefined || a.len !== undefined)) {
        args = a; ctx = b || {};
    } else {
        /* 位置形态：dir 可省略（= 直行）。null/undefined 都按"省略"处理 —— 否则契约会把
           null 当成"给了非法方位"，把"我没说"误报成"你说错了"。 */
        args = { from: a, len: b, ...(c === null || c === undefined ? {} : { dir: c }), opts: d };
        ctx = e || {};
    }

    const v = validateExtendLineArgs(args);
    if (!v.ok) return failure("extend_line", v.error);

    const { from, len, dir: dirArg, opts } = v.value;
    const world = worldFor(ctx);
    if (!world) {
        return failure("extend_line", {
            code: "precondition_failed", field: "from",
            message: "没有 ctx.entities（obs 实体表）⇒ 无法判定 from 是不是末端、路径空不空",
            hint: "先 obs。extend_line 的整个意义就是「这里接得上」，盲接没有意义。",
        });
    }

    /* ── ① from 解析 + 起点/当前流向 ── */
    const rf = resolveEntity(from, world, "from");
    if (!rf.ok) return failure("extend_line", { code: rf.code, field: "from", message: rf.message });
    const rec = rf.rec;

    let startCell;      // 第一个**新**格
    let startDir;       // 货流从 from 出来时的方向
    let fromKind;
    const warnings = [];

    if (rec.type === "belt") {
        fromKind = "belt";
        const exitFace = beltExit(rec.rv, rec.r);
        startDir = exitFace;
        const next = [rec.x + DIRV[exitFace][0], rec.y + DIRV[exitFace][1]];
        const nrec = world.cells.get(key(next[0], next[1]));

        /* 末端判定（契约 §2.4 precondition）：出口方向的下游已经有接收方 ⇒ 不是末端 */
        if (nrec && nrec.type === "belt") {
            const nb = world.byUid.get(nrec.uid);
            if (nb && beltEntry(nb.rv, nb.r) === OPP[exitFace]) {
                return failure("extend_line", {
                    code: "precondition_failed", field: "from",
                    message: `from 的带子 ${rec.uid}@${rec.x},${rec.y} 不是末端：出口 ${exitFace} 的下游 ${next} 已经接着带子 ${nb.uid}`,
                    hint: "要从整段带子的**末端**延长。先沿下游找到真正没有接收方的那一格（或用 connect 接到具体目标）。",
                    firstConflict: { x: next[0], y: next[1], what: "belt", uid: nb.uid },
                });
            }
        }
        if (nrec && nrec.tpl) {
            /* 对端机器的「带格」正好是这一格、面朝回本带 ⇒ 本带的出口真的插进了它的输入口 */
            const acc = portsWorld(nrec).inputs.find(p =>
                (p.cell[0] === next[0] && p.cell[1] === next[1] && p.dir === OPP[exitFace])
                || (p.slot[0] === next[0] && p.slot[1] === next[1] && p.dir === OPP[exitFace]));
            if (acc) {
                return failure("extend_line", {
                    code: "precondition_failed", field: "from",
                    message: `from 的带子 ${rec.uid}@${rec.x},${rec.y} 不是末端：出口已经插进 ${nrec.type}@${nrec.x},${nrec.y} 的输入槽`,
                    hint: "该槽已被供料。要改去向就用 connect（它懂 rebind 的代价）。",
                    firstConflict: { x: next[0], y: next[1], what: nrec.type, uid: nrec.uid },
                });
            }
        }
        startCell = next;
    } else {
        fromKind = "machine";
        const ports = portsWorld(rec);
        if (!ports.outputs.length) {
            return failure("extend_line", {
                code: "endpoint_not_a_port", field: "from",
                message: `${rec.type}@${rec.x},${rec.y} 没有输出槽，无法作为延长起点`,
                hint: "from 必须是带子末端或机器输出口。",
            });
        }
        let port = null;
        const sel = from.port === undefined ? "auto" : from.port;
        if (sel === "auto") {
            if (ports.outputs.length !== 1) {
                return failure("extend_line", {
                    code: "ambiguous_port", field: "from.port",
                    message: `${rec.type}@${rec.x},${rec.y} 有 ${ports.outputs.length} 个输出槽，必须显式给 port`,
                    candidates: ports.outputs.map(p => ({ role: p.role, cell: p.cell, dir: p.dir })),
                });
            }
            port = ports.outputs[0];
        } else if (typeof sel === "string") {
            const hit = ports.outputs.filter(p => p.role === sel);
            if (hit.length === 1) port = hit[0];
            else {
                return failure("extend_line", {
                    code: hit.length ? "ambiguous_port" : "bad_type", field: "from.port",
                    message: hit.length ? `port="${sel}" 命中 ${hit.length} 个输出槽` : `port="${sel}" 不是该机器的输出角色`,
                    candidates: ports.outputs.map(p => ({ role: p.role, cell: p.cell, dir: p.dir })),
                });
            }
        } else if (isObj(sel) && typeof sel.role === "string" && isInt(sel.index)) {
            const hit = ports.outputs.filter(p => p.role === sel.role);
            port = hit[sel.index] || null;
            if (!port) {
                return failure("extend_line", {
                    code: "bad_type", field: "from.port",
                    message: `{role:"${sel.role}",index:${sel.index}} 不存在（该角色有 ${hit.length} 个）`,
                });
            }
        } else {
            return failure("extend_line", { code: "bad_type", field: "from.port", message: "from.port 形态不认识" });
        }
        /* 该槽当前是否已经有接收方 */
        const occ = world.cells.get(cellKey(port.cell));
        if (occ && occ.type === "belt") {
            const ob = world.byUid.get(occ.uid);
            if (ob && beltEntry(ob.rv, ob.r) === OPP[port.dir]) {
                return failure("extend_line", {
                    code: "precondition_failed", field: "from.port",
                    message: `输出槽 ${port.role}@${port.slot} 已经有带子 ${ob.uid}@${ob.x},${ob.y} 在接货`,
                    hint: "要改去向用 connect（opts.rebind 显式承担旧支路断流）。",
                    firstConflict: { x: ob.x, y: ob.y, what: "belt", uid: ob.uid },
                });
            }
        }
        if (occ && occ.tpl) {
            return failure("extend_line", {
                code: "blocked_by_machine", field: "from.port",
                message: `输出槽 ${port.role} 的喷口格 ${port.cell} 被 ${occ.type}@${occ.x},${occ.y} 占着`,
                hint: "机器永远不会被覆盖。",
                firstConflict: { x: occ.x, y: occ.y, what: occ.type, uid: occ.uid },
            });
        }
        startCell = [port.cell[0], port.cell[1]];
        startDir = port.dir;
        if (rec.r !== 0) {
            warnings.push({
                code: "rotation_not_live_verified",
                detail: `from 是 rotation=${rec.r} 的机器；其槽位世界格按 G2 推算（observed 级）`,
                hint: "执行前先 obs 读回该槽位邻接确认。",
            });
        }
    }

    /* ── ② dir：缺省直行。180° 掉头的判定放到 ⑤b（占位检查之后）── */
    const dir = dirArg === null ? startDir : dirArg;

    /* ── ③ 逐格几何：首格可转，其余直行 ── */
    const cells = [];
    let cur = [startCell[0], startCell[1]];
    cells.push(cur.slice());
    for (let i = 1; i < len; i++) {
        cur = [cur[0] + DIRV[dir][0], cur[1] + DIRV[dir][1]];
        cells.push(cur.slice());
    }

    const posed = [];
    for (let k = 0; k < cells.length; k++) {
        const vIn = k === 0 ? startDir : dir;
        const vOut = dir;
        const entry = OPP[vIn];
        const p = solveTurn(entry, vOut);
        if (!p) {
            return failure("extend_line", {
                code: "precondition_failed", field: "dir",
                message: `第 ${k} 格 [${cells[k]}] 无解：entry=${entry} exit=${vOut}`,
                hint: "这是宏的内部几何矛盾，按 bug 上报（正常输入不会走到这里）。",
            });
        }
        posed.push({
            x: cells[k][0], y: cells[k][1],
            building: "belt",
            rotation: p.rotation, rotationVariant: p.rotationVariant,
            code: beltCode(p.rotationVariant),
            inDir: vIn, outDir: vOut, entry, exit: vOut,
        });
    }

    /* ── ④ 自证：逐格重解 + 链闭合 + 与 from 的接口（这是本宏的立身之本） ── */
    const ver = verifyExtension(posed, { from, rec, startDir, startCell, dir, fromKind });
    if (!ver.ok) {
        return failure("extend_line", {
            code: "internal", field: null,
            message: `生成的延长链不自洽：${ver.breaks[0]}`,
            detail: { breaks: ver.breaks.slice(0, 5) },
        });
    }

    /* ── ⑤ 占位：len 格必须全空（本宏不提供 allow_replace） ──
       先查碰撞，再判转向：调用方给了掉头方向、而走廊恰好也堵着时，
       报「occupied + 第一处障碍」比报「180° 不能掉头」更有用（障碍是能清的，掉头不能）。 */
    const selfSeen = new Set();
    let firstConflict = null;
    for (const cell of cells) {
        const k = cellKey(cell);
        if (selfSeen.has(k)) { firstConflict = { x: cell[0], y: cell[1], what: "self-overlap" }; break; }
        selfSeen.add(k);
        const rec2 = world.cells.get(k);
        if (!rec2) continue;
        if (!firstConflict) firstConflict = { x: cell[0], y: cell[1], what: rec2.type, uid: rec2.uid };
    }
    if (firstConflict) {
        return failure("extend_line", {
            code: "occupied", field: "len",
            message: `延长路径上有 ${firstConflict.what}@${firstConflict.x},${firstConflict.y}`
                + `${firstConflict.uid !== undefined ? `（uid=${firstConflict.uid}）` : ""}`,
            hint: "extend_line 只往空地延长（不覆盖）。绕障用 connect，清障用 remove_run。",
            firstConflict,
        });
    }

    /* ── ⑤b 转向合法性：180° 掉头带子做不到（放在占位之后：障碍可清、掉头不可改，先报更可行动的） ── */
    if (dir === OPP[startDir]) {
        return failure("extend_line", {
            code: "precondition_failed", field: "dir",
            message: `dir="${dir}" 与 from 当前流向 "${startDir}" 相反 —— 180° 掉头，带子做不到`,
            hint: "掉头需要绕一段（U 形），那是 connect 的活；本宏一次只允许 0° 或 90°。",
        });
    }

    /* ── ⑥ 末端是不是死端（必须如实回报，不许静默） ── */
    const tail = posed[posed.length - 1];
    const termCell = [tail.x + DIRV[dir][0], tail.y + DIRV[dir][1]];
    const termRec = world.cells.get(cellKey(termCell));
    let terminalOrphaned = true;
    if (termRec && termRec.type === "belt") {
        const tb = world.byUid.get(termRec.uid);
        terminalOrphaned = !(tb && beltEntry(tb.rv, tb.r) === OPP[dir]);
    } else if (termRec && termRec.tpl) {
        terminalOrphaned = !portsWorld(termRec).inputs.some(p => p.slot[0] === termCell[0] && p.slot[1] === termCell[1] && p.dir === OPP[dir]);
    }
    if (terminalOrphaned) {
        warnings.push({
            code: "terminal_orphaned",
            cell: termCell,
            detail: `延长后末端 ${tail.x},${tail.y} 的出口 ${dir} 指向 ${termCell}，那里没有接收方 —— 死端`,
            hint: "本宏只保证「延长了」，不保证「接上了」。要接到具体目标用 connect。",
        });
    }

    const result = {
        ok: true,
        macro: "extend_line",
        cells_planned: posed.length,
        cells_placed: posed.length,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings,
        error: null,
        dry_run: true,
        /* ── 诊断字段 ── */
        cells: posed,
        from: fromKind === "belt"
            ? { kind: "belt", uid: rec.uid, cell: [rec.x, rec.y], exit: startDir }
            : { kind: "machine", uid: rec.uid, cell: [rec.x, rec.y], rotation: rec.r, exit: startDir },
        start: { cell: [startCell[0], startCell[1]], dir: startDir, turned: dir !== startDir },
        terminal: { cell: [tail.x, tail.y], exit: dir, next: termCell },
        terminal_orphaned: terminalOrphaned,
        firstConflict: null,
        /* 每格必须带显式 rv 落盘（machine_place_sets_rv = assumed）：
           用 paste_blueprint（immutable 粘贴不改 rv），或 place 后读回 code 并比对。
           expected 逐格列出来，调用方不必自己再解一遍 solveTurn。 */
        execution: {
            needs_tx: true,
            method: "paste_blueprint",
            read_back: ["code", "r", "rotation_variant"],
            cells: posed.map(c => ({ x: c.x, y: c.y, code: c.code, r: c.rotation, rv: c.rotationVariant })),
            note: "place 的 rv 由游戏按邻居猜；本宏给出的是 solveTurn 反解值，落地后必须读回并逐格比对 code=1+rv。",
        },
    };
    const chk = validateMacroResult(result);
    if (!chk.ok) return failure("extend_line", { code: "internal", field: chk.error.field, message: `返回值不合契约：${chk.error.message}` });
    return result;
}

/**
 * 延长链的自证。判据与 connect.verifyChain 同一套（F1：exit(a) === OPP[entry(b)]），
 * 外加两条本宏独有的：
 *   · 首格必须紧贴 from（带子：from.cell + DIRV[startDir]；机器：port.cell）
 *   · 首格 entry 必须是 OPP[startDir]（货流真的是从 from 流进来的）
 * @returns {{ok:boolean, breaks:string[]}}
 */
export function verifyExtension(posed, ctx) {
    const breaks = [];
    if (!Array.isArray(posed) || !posed.length) return { ok: false, breaks: ["空链"] };
    const { rec, startDir, startCell, dir, fromKind } = ctx;

    if (fromKind === "belt") {
        const want = [rec.x + DIRV[startDir][0], rec.y + DIRV[startDir][1]];
        if (startCell[0] !== want[0] || startCell[1] !== want[1]) breaks.push(`首格 ${startCell} != from 出口格 ${want}`);
    }
    const first = posed[0];
    if (first.entry !== OPP[startDir]) breaks.push(`首格 entry=${first.entry}，应为 OPP[${startDir}]=${OPP[startDir]}`);
    if (first.x !== startCell[0] || first.y !== startCell[1]) breaks.push(`首格坐标 ${first.x},${first.y} != ${startCell}`);

    for (let i = 0; i < posed.length; i++) {
        const c = posed[i];
        const re = solveTurn(beltEntry(c.rotationVariant, c.rotation), beltExit(c.rotationVariant, c.rotation));
        if (!re || re.rotation !== c.rotation || re.rotationVariant !== c.rotationVariant) {
            breaks.push(`第 ${i} 格 ${c.x},${c.y} 单格不自洽`);
        }
        if (c.code !== beltCode(c.rotationVariant)) breaks.push(`第 ${i} 格 code=${c.code} != 1+rv=${beltCode(c.rotationVariant)}`);
        if (c.exit !== dir) breaks.push(`第 ${i} 格 exit=${c.exit}，本段应恒为 ${dir}`);
    }
    for (let i = 0; i + 1 < posed.length; i++) {
        const a = posed[i], b = posed[i + 1];
        if (beltExit(a.rotationVariant, a.rotation) !== OPP[beltEntry(b.rotationVariant, b.rotation)]) {
            breaks.push(`第 ${i}→${i + 1} 断裂：exit(${a.x},${a.y}) 与 OPP[entry(${b.x},${b.y})] 不符`);
        }
        const want = [a.x + DIRV[beltExit(a.rotationVariant, a.rotation)][0], a.y + DIRV[beltExit(a.rotationVariant, a.rotation)][1]];
        if (b.x !== want[0] || b.y !== want[1]) breaks.push(`第 ${i}→${i + 1} 位置不连续（期望 ${want}）`);
    }
    return { ok: breaks.length === 0, breaks };
}

/* ═══════════════════════════════ 6. 统一失败信封 ═══════════════════════════════ */

function failure(macro, err) {
    const e = {
        code: err.code, field: err.field === undefined ? null : err.field,
        message: err.message, hint: err.hint || null,
    };
    if (err.candidates) e.candidates = err.candidates;
    if (err.detail) e.detail = err.detail;
    return {
        ok: false, macro,
        cells_planned: 0, cells_placed: 0,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings: [],
        error: e,
        dry_run: true,
        /* 诊断字段保持形状稳定：调用方不必先判 ok 再取字段 */
        origin: null, rotation: null, facing: null, cells: null, ports: null, wiring: null,
        pending: null,
        removed_uids: [],
        reason: err.message,
        firstConflict: err.firstConflict || (err.detail && err.detail.firstConflict) || null,
    };
}

/** 契约注册表用的蛇形别名（与宏名一致，便于按 name 派发） */
export const insert_machine = insertMachine;
export const extend_line = extendLine;

/** 诊断：方位 → 角度（A6/日志用；不参与任何判定） */
export const facingAngle = angleOf;
