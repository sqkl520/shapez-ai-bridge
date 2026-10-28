/**
 * planToTxOps.mjs — 「宏计划 → 一次 tx 的 ops[]」唯一的翻译器（纯函数，不碰网络）。
 *
 * 真值来源：`research/ai-plan/PHASE2-CONTRACT-V2.md`（v2 补丁优先于 v1）。
 * 本文件按 v2 的实际代码事实实现，五处 v1 曾引用的不存在字段已全部替换：
 *
 *   · `produced_delta`            → 不在本文件（属 verify.mjs），但同样按 v2 读 `goal_delivered_delta`
 *   · `tx.verify.uid_set_equal`   → 不在本文件（apply.mjs 的活），见 verify.mjs
 *   · `tx.results[i].mismatch`    → **不存在**（bridge:3402-3406 只有 index/op/ok/uid/applied）。
 *                                   所以本文件不假装能读 mismatch；`pendingByOp` 的 uid 桥接只靠
 *                                   `results[i].uid`（apply 侧），本文件只产出 `pendingByOp[opIndex]=token`。
 *   · `report.uidDiff`            → 不存在，verify.mjs 自己算
 *   · `fixture_hash`              → 不在本文件
 *
 * 红队的另外两条直接改变了本文件的实现：
 *
 *   1. **`connect(allow_replace)` 不报 destroys**（connect.mjs:861-866 只发 warning，
 *      `changed.removed_uids` 恒 []）。v1 的 R3 只收集宏自报 ⇒ 这类销毁永远进不了 destroys。
 *      本文件按 v2 §5.1 的裁定，用 `connect.cells[]` ∩ `obs` 自己算出被覆盖的带子，
 *      并打 `DESTROYS_DERIVED` 警告 —— **算出来的销毁必须留痕**，不许静默补全。
 *   2. **`flows` 的语义必须定义，且 `from===to` 必须丢弃**（verify_runtime.mjs:652 的
 *      `reach()` 以 `start.uid` 起手 ⇒ 自环恒绿）。见 `deriveFlows`。
 *      没有下游时要报 `OUTPUT_UNROUTED`，**不许造一个自环来「满足」L3**。
 *
 * 零依赖（只用仓库内文件）；不读写世界，不读时钟。
 */

import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { DIRV, beltExit } from "../../ai/belt-rules.mjs";
import { slotsOf, acceptorOf } from "../verify_runtime.mjs";
import { validateMacroResult } from "../macros/contract.mjs";

/* ══════════════════════════ 小工具 ══════════════════════════ */

const isInt = n => typeof n === "number" && Number.isInteger(n);
const isPosInt = n => isInt(n) && n >= 0;
const K = c => `${c[0]},${c[1]}`;

/** 带子类（需要在 op 里显式给 rotationVariant 的类型） */
const BELT_KINDS = new Set(["belt", "underground_belt"]);

/** 6 个宏的白名单（与 contract.mjs 的 MACRO_NAMES 同源，但本文件不 import 那份表：
 *  这里要的是「翻译器认识哪几种返回形状」，不是「ABI 里有哪些宏」—— 两者会分叉，
 *  分叉时必须显式报错（`UNKNOWN_MACRO_SHAPE`），不能静默跳过。 */
const PLACE_MACROS = new Set(["insert_machine", "replace_run", "connect", "extend_line", "trash_unused"]);
const REMOVE_MACROS = new Set(["remove_run", "replace_run"]);

const MAX_OPS = 2000;              // = mod 的硬限（shapez-ai-bridge.js:3258）
const MAX_PLACES = 1200;
const MAX_CHAIN_STEPS = 512;       // 沿带子链走的上限（防环）

function unwrapObs(obs) {
    if (obs && typeof obs === "object" && !Array.isArray(obs.entities)
        && obs.result && Array.isArray(obs.result.entities)) return obs.result;
    return obs && typeof obs === "object" ? obs : {};
}

/** debug_items 的响应可能被 `{jsonrpc,id,result}` 包着（真桥）—— 也要认。 */
function unwrapItems(items) {
    if (items && typeof items === "object" && !Array.isArray(items.paths)
        && items.result && typeof items.result === "object") return items.result;
    return items || null;
}

/** 模板 footprint 的世界格（v1 只支持 rotation=0 的机器；rot≠0 的非方形机器在宏层已被
 *  `out_of_scope` 挡住，这里若真遇到就只报 origin 一格并留 warning，不猜。） */
function footprintCells(kind, variant, x, y, rot) {
    const tpl = templateByBuildingVariant(kind, variant || "default");
    const w = tpl ? tpl.footprint[0] : 1;
    const h = tpl ? tpl.footprint[1] : 1;
    const out = [];
    if (rot && rot % 360 === 0) rot = 0;
    if (rot) {
        /* 旋转会造成 origin 位移（上游 static_map_entity.js），未实机验证 ⇒ 不展开。 */
        return { cells: [[x, y]], unverified: true };
    }
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push([x + dx, y + dy]);
    return { cells: out, unverified: false };
}

function kindRank(kind) {
    return BELT_KINDS.has(kind) ? 1 : 0;      // R9：machines 先于 belts
}

/* ══════════════════════════ 调用归一化 ══════════════════════════
 *
 * 接受三种输入形态（都来自真实调用方，不做「猜」以外的解释）：
 *   ① {macro, args, result}   —— loop 的标准形态（propose 后 dry-run 填 result）
 *   ② {macro, result}         —— args 不重要时
 *   ③ 裸宏返回值（带 macro + ok）—— 测试/回放里最常见的形态
 * 缺 result 一律拒绝：本函数**不执行宏**（它是纯翻译器；执行宏是 plan 阶段的事）。
 */
function normalizeCall(c, i) {
    if (!c || typeof c !== "object") return { error: `calls[${i}] 不是对象` };
    if (c.result && typeof c.result === "object") {
        return { macro: c.macro || c.result.macro, args: c.args || {}, result: c.result, callIndex: i };
    }
    if (typeof c.ok === "boolean") {
        return { macro: c.macro, args: c.args || {}, result: c, callIndex: i };
    }
    if (typeof c.macro === "string") {
        return { error: `calls[${i}] (${c.macro}) 没有 result —— planToTxOps 只翻译已 dry-run 过的宏结果，不替调用方执行宏` };
    }
    return { error: `calls[${i}] 形态不认识（需要 {macro,args,result} 或宏返回值）` };
}

/* ══════════════════════════ R3：destroys ══════════════════════════ */

/** 宏自报的销毁集合（v1 R3 的五路来源，去重）。 */
function selfReportedDestroys(result) {
    const out = new Set();
    const push = v => { if (isPosInt(v)) out.add(v); };
    if (result.changed && Array.isArray(result.changed.removed_uids)) result.changed.removed_uids.forEach(push);
    if (Array.isArray(result.removed_uids)) result.removed_uids.forEach(push);
    if (Array.isArray(result.removes)) result.removes.forEach(r => push(r && r.uid));
    if (isPosInt(result.replaced_belt_uid)) push(result.replaced_belt_uid);
    if (Array.isArray(result.replaced_uids)) result.replaced_uids.forEach(push);
    if (Array.isArray(result.removed)) result.removed.forEach(r => push(r && r.uid));
    return [...out];
}

/**
 * `connect(allow_replace)` 的销毁**必须由这里补算**。
 *
 * 实测（红队 #6 / connect.mjs:861-866）：`allow_replace` 打开时 connect 只发一条
 * `replacing-belts` 警告（带格数），`changed.removed_uids` 恒为 `[]`。v1 的 R3 因此
 * 永远看不到这些销毁，而 R6 又要求 place 目标格「空或在 destroys 里」⇒ 二者互否。
 *
 * 这里取 connect 覆盖的每一格与 obs 求交：占着的是带子 ⇒ 它必然被销毁（connect 只覆盖带子）。
 * 结果进 destroys，并**单独打警告**——补算出来的销毁与宏自报的销毁在审计上不是一回事。
 */
function connectDestroysFromObs(result, entByCell) {
    const out = [];
    if (!Array.isArray(result.cells)) return out;
    for (const c of result.cells) {
        if (!c || !isInt(c.x) || !isInt(c.y)) continue;
        const e = entByCell.get(K([c.x, c.y]));
        if (e && BELT_KINDS.has(e.type) && isPosInt(e.uid)) out.push({ uid: e.uid, cell: [c.x, c.y] });
    }
    return out;
}

/* ══════════════════════════ R4：places ══════════════════════════
 *
 * 统一产出内部形态（不是最终 op）：
 *   {kind, variant, x, y, rot, rv, code, cells, token, macro, callIndex, pathIndex}
 * `cells` 是该建筑占的全部世界格（R5/R6 用它做 footprint 级检查，而不是只看 origin）。
 */
function collectPlaces(c, tplFor) {
    const r = c.result, macro = c.macro;
    const places = [];
    const add = (p, idx) => places.push({
        kind: p.kind,
        variant: p.variant || "default",
        x: p.x, y: p.y,
        rot: isInt(p.rot) ? p.rot : 0,
        rv: isInt(p.rv) ? p.rv : (BELT_KINDS.has(p.kind) ? null : 0),
        code: p.code === undefined ? null : p.code,
        cells: p.cells || null,
        token: p.token || null,
        macro, callIndex: c.callIndex, pathIndex: idx,
    });

    if (macro === "insert_machine") {
        const kind = (r.machine && r.machine.kind) || r.kind;
        if (typeof kind !== "string" || !Array.isArray(r.origin)) return { error: "insert_machine 返回缺 machine.kind / origin" };
        const cells = Array.isArray(r.cells) ? r.cells.filter(v => v && isInt(v.x) && isInt(v.y)).map(v => [v.x, v.y]) : null;
        add({
            kind, variant: (r.machine && r.machine.variant) || "default",
            x: r.origin[0], y: r.origin[1], rot: r.rotation, rv: 0,
            code: tplFor(kind, (r.machine && r.machine.variant) || "default").code ?? null,
            cells, token: (r.pending && r.pending.token) || null,
        }, 0);
        return { places };
    }

    if (macro === "replace_run") {
        if (!Array.isArray(r.placed)) return { error: "replace_run 返回缺 placed[]" };
        r.placed.forEach((p, i) => {
            if (!p || !Array.isArray(p.origin) || typeof p.kind !== "string") return;
            add({
                kind: p.kind, variant: p.variant || "default",
                x: p.origin[0], y: p.origin[1], rot: p.rotation,
                rv: p.rotationVariant, code: p.code !== undefined ? p.code : null,
                cells: Array.isArray(p.cells) ? p.cells.map(v => Array.isArray(v) ? [v[0], v[1]] : [v.x, v.y]) : null,
                token: (p.pending && p.pending.token) || null,
            }, i);
        });
        return { places };
    }

    if (macro === "connect" || macro === "extend_line") {
        if (!Array.isArray(r.cells)) return { error: `${macro} 返回缺 cells[]` };
        r.cells.forEach((cell, i) => {
            if (!cell) return;
            add({
                kind: cell.building || "belt", variant: cell.variant || "default",
                x: cell.x, y: cell.y, rot: cell.rotation,
                rv: cell.rotationVariant, code: cell.code !== undefined ? cell.code : null,
                cells: [[cell.x, cell.y]], token: null,
            }, i);
        });
        return { places, reversePath: true };
    }

    if (macro === "trash_unused") {
        if (!Array.isArray(r.trashCell)) return { error: "trash_unused 返回缺 trashCell" };
        add({
            kind: "trash", variant: "default",
            x: r.trashCell[0], y: r.trashCell[1], rot: 0, rv: 0,
            code: tplFor("trash", "default").code ?? null,
            cells: [[r.trashCell[0], r.trashCell[1]]],
            token: (r.pending && r.pending.token) || null,
        }, 0);
        return { places };
    }

    if (macro === "remove_run") {
        /* 纯删除宏：没有 place，只有 destroys（已由 R3 收走 changed.removed_uids / removed_uids）。 */
        return { places };
    }

    return { error: `planToTxOps 不认识宏 "${macro}" 的返回形状` };
}

/* ══════════════════════════ R9：依赖排序 ══════════════════════════
 *
 * v2 §5.3 补的一条：若宏 B 的 args 里引用了宏 A 的 `pending.token`，
 * A 的 place 必须排在 B 之前（否则 B 按计划态几何算出来的东西会在 A 落盘前失效）。
 * 判定是纯文本包含：token 形如 `insert_machine:cutter@4,-13`，在 JSON 里出现即依赖。
 */
function callRanks(calls) {
    const tokens = calls.map(c => (c.result && c.result.pending && c.result.pending.token) || null);
    const rank = new Array(calls.length).fill(0);
    for (let i = 0; i < calls.length; i++) {
        let dep = -1;
        let blob = "";
        try { blob = JSON.stringify(calls[i].args || {}); } catch { blob = ""; }
        for (let j = 0; j < i; j++) {
            if (!tokens[j]) continue;
            if (blob.includes(tokens[j])) dep = Math.max(dep, j);
        }
        rank[i] = dep >= 0 ? rank[dep] + 1 : 0;
    }
    return rank;
}

/* ══════════════════════════ R10：op 形状 ══════════════════════════
 *
 * 白名单**照抄 mod 的 actionSpecs**（shapez-ai-bridge.js:2424-2426），不自己造字段：
 *   place: building,x,y,r,variant,rotationVariant,rv,originalRotation,orig  —— **没有 code**
 *   delete: x,y,layer,uid
 * 抄错一个字段名 = 实机 2001（macro_execution_ops.test.mjs 记录过这个事故）。
 */
const OP_FIELDS = Object.freeze({
    place: ["op", "building", "x", "y", "r", "variant", "rotationVariant"],
    delete: ["op", "uid"],
});

function checkOpShape(op) {
    const allowed = OP_FIELDS[op.op];
    if (!allowed) return `未知 op "${op.op}"`;
    for (const k of Object.keys(op)) {
        if (!allowed.includes(k)) return `op "${op.op}" 不允许字段 "${k}"（mod 会 2001）`;
    }
    if (op.op === "place") {
        if (typeof op.building !== "string") return "place.building 必须是字符串";
        if (!isInt(op.x) || !isInt(op.y)) return "place.x/y 必须是整数";
        if (!isInt(op.r)) return "place.r 必须是整数（缺省 0 也要显式给）";
        if (BELT_KINDS.has(op.building) && !isInt(op.rotationVariant)) {
            return `place 的 ${op.building} 必须给 rotationVariant（rv 由游戏按邻居重算，落盘后要读回比对）`;
        }
        if (!BELT_KINDS.has(op.building) && op.rotationVariant !== undefined) {
            return `机器 place 不带 rotationVariant（只有带子有 rv；带了就是第二份真值）`;
        }
    }
    if (op.op === "delete" && !isPosInt(op.uid)) return "delete.uid 必须是 >=0 整数";
    return null;
}

/* ══════════════════════════ flows 派生（v2 §2.6） ══════════════════════════
 *
 * 红队实测：`checkFlow.reach()` 以 `new Set([start.uid])` 起手 ⇒ `{from:X,to:X}` **恒绿**。
 * 所以 flows 必须由计划自己派生，且：
 *   · `from === to` 一律丢弃（不许自环）；
 *   · 找不到下游 ⇒ 产出 `OUTPUT_UNROUTED`，**不许造自环**；
 *   · flows 为空且计划里有机器 ⇒ `FLOW_UNVERIFIED`（由调用方判红，本文件只报缺口）。
 *
 * 下游怎么找（三级，任一命中即止）：
 *   ① 该槽的 approach 格上就是**本次新放的建筑**（机对机直贴）→ via:"adjacent"
 *   ② `debug_items.paths[]` 里有一条 path 的首格 == approach 格 → 沿 path 到 acceptor → via:"paths"
 *      （只有这一类能被 L3 的 checkFlow 复核 —— 它有 path 可走）
 *   ③ obs 里 approach 格是带子 → 沿 `beltExit` 逐格走，直到撞上非带子实体 → via:"chain"
 *      （obs 可复核：verify.mjs 在 apply 之后对 afterObs 重走一遍）
 */
function scanFlows(places, obs, items) {
    const entities = Array.isArray(obs.entities) ? obs.entities : [];
    const warnings = [];
    const flows = [];

    /* 位置索引：按 footprint 的每一格索引（机器 2×1 的第二格也要能命中） */
    const entByCell = new Map();
    for (const e of entities) {
        if (!e) continue;
        const f = footprintCells(e.type, e.variant, e.x, e.y, e.r || 0);
        for (const c of f.cells) if (!entByCell.has(K(c))) entByCell.set(K(c), e);
    }
    const placeByCell = new Map();
    for (const p of places) {
        const cells = p.cells && p.cells.length ? p.cells : footprintCells(p.kind, p.variant, p.x, p.y, p.rot).cells;
        for (const c of cells) if (!placeByCell.has(K(c))) placeByCell.set(K(c), p);
    }

    const paths = (items && Array.isArray(items.paths)) ? items.paths : null;
    const startAt = new Map();
    if (paths) for (const p of paths) { const c = (p.cells || [])[0]; if (c) startAt.set(K(c), p); }

    const refOf = (obj) => {
        if (obj.uid !== null && obj.uid !== undefined && isPosInt(obj.uid)) return { value: obj.uid, token: null };
        return { value: obj.token || null, token: obj.token || null };   // 计划态：用 token 当端点
    };

    const selfOf = (p) => refOf({ uid: p.uid, token: p.token });

    for (const p of places) {
        const s = slotsOf(p.kind, p.variant, p.x, p.y, p.rot || 0);
        const outs = (s && s.outputs) || [];
        for (const out of outs) {
            const hit = findDownstream(out, p, { entByCell, placeByCell, startAt, paths });
            if (!hit) {
                warnings.push({
                    code: "OUTPUT_UNROUTED",
                    macro: p.macro,
                    cell: [out.cell[0], out.cell[1]],
                    role: out.role,
                    detail: `${p.kind}@(${p.x},${p.y}) 的 "${out.role}" 输出槽在 (${out.cell[0]},${out.cell[1]}) `
                        + `找不到下游（新放的建筑 / path / 带子链都没有）—— 这台机器会因出口堵塞停转`,
                });
                continue;
            }
            const from = selfOf(p);
            const to = refOf(hit.target);
            /* ★ 自环必须丢弃 ★ 否则 L3 的 reach() 从 from 起手，恒绿。 */
            if (from.value !== null && from.value === to.value) continue;
            if (from.value === null && to.value === null) continue;   // 两个都不可解析，等价于自环
            flows.push({
                from: from.value,
                to: to.value,
                via_slot: out.role,
                via: hit.via,
                from_cell: [out.cell[0], out.cell[1]],
                to_cell: [hit.target.x, hit.target.y],
                /* 端点若是计划态（uid 未分配），把 token 一起带上：apply 之后由 verify.mjs
                   用 `uidMap[token]` 换真 uid。只留 value 会让调用方分不清 int 与 token。 */
                ...(from.token ? { from_token: from.token } : {}),
                ...(to.token ? { to_token: to.token } : {}),
            });
        }
    }
    return { flows, warnings };
}

function findDownstream(out, self, idx) {
    const cell = out.cell;
    /* ① 本次新放的建筑直接贴在这个槽上（L4 的 cutter.left → trash@(4,-14) 就是这种） */
    const placed = idx.placeByCell.get(K(cell));
    if (placed) {
        if (placed === self) return null;             // 自己占自己的槽 = 几何错，不造自环
        return { target: { uid: placed.uid, token: placed.token, x: placed.x, y: placed.y, type: placed.kind }, via: "adjacent" };
    }
    /* ② 游戏自己的 path */
    if (idx.paths) {
        const p = idx.startAt.get(K(cell));
        if (p) {
            const accCell = acceptorOf(p);
            if (accCell) {
                const acc = idx.entByCell.get(K(accCell))
                    || idx.placeByCell.get(K(accCell)) && entityOfPlacement(idx.placeByCell.get(K(accCell)));
                if (acc) return { target: acc, via: "paths" };
            }
            /* path 存在但末端没有接收方 ⇒ 死端。不继续用 ③ 猜（path 是游戏的权威说法）。 */
            if (!accCell) return null;
        }
    }
    /* ③ obs 里的带子链 */
    let cur = [cell[0], cell[1]];
    const seen = new Set();
    for (let step = 0; step < MAX_CHAIN_STEPS; step++) {
        const placedHere = idx.placeByCell.get(K(cur));
        if (placedHere) {
            if (placedHere === self) return null;
            return { target: { uid: placedHere.uid, token: placedHere.token, x: placedHere.x, y: placedHere.y, type: placedHere.kind }, via: "adjacent" };
        }
        const e = idx.entByCell.get(K(cur));
        if (!e || e === self) return null;
        if (e.uid === self.uid && e.uid !== null && e.uid !== undefined) return null;
        if (e.type === "belt") {
            const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
            const dir = beltExit(rv, e.r || 0);
            cur = [cur[0] + DIRV[dir][0], cur[1] + DIRV[dir][1]];
            if (seen.has(K(cur))) return null;
            seen.add(K(cur));
            continue;
        }
        if (e.type === "underground_belt") return null;   // 隧道语义不建模，如实报「找不到」
        return { target: e, via: "chain" };
    }
    return null;
}

function entityOfPlacement(p) {
    return { uid: p.uid, token: p.token, x: p.x, y: p.y, type: p.kind };
}

/** 公开入口：只给 flows（形状按 v2 §2.6）。诊断走 `scanFlows`（planToTxOps 内部用）。 */
export function deriveFlows(placements, obs, items) {
    return scanFlows(placements || [], unwrapObs(obs), items || null).flows;
}

/* ══════════════════════════ 主入口 ══════════════════════════ */

/**
 * @param {Array} calls  [{macro, args, result}]（或裸宏返回值）
 * @param {{obs:object, handles?:object}} ctx  obs = 当前世界快照（apply 之前）；handles 保留给
 *        坐标溯源（coords.mjs 的职责），本文件不使用它 —— 翻译器不该自己判 provenance。
 * @returns {{ok:boolean, ops:Array, destroys:number[], pendingByOp:object,
 *            placements:Array, removes:Array, flows:Array, warnings:Array, error:null|object}}
 */
export function planToTxOps(calls, ctx = {}) {
    const empty = {
        ok: false, ops: [], destroys: [], pendingByOp: {}, placements: [], removes: [],
        flows: [], warnings: [], error: null,
    };
    const reject = (rule, kind, message, detail) => ({
        ...empty,
        error: { code: "PLAN_REJECTED", rule, kind, message, ...(detail !== undefined ? { detail } : {}) },
    });

    /* ── R1：calls 非空、每条宏都成功 ── */
    if (!Array.isArray(calls) || calls.length === 0) {
        return reject("R1", "plan_rejected", "calls 为空：没有要执行的动作（空计划不许当成功）");
    }
    const normalized = [];
    for (let i = 0; i < calls.length; i++) {
        const n = normalizeCall(calls[i], i);
        if (n.error) return reject("R1", "plan_rejected", n.error);
        if (!PLACE_MACROS.has(n.macro) && !REMOVE_MACROS.has(n.macro)) {
            return reject("R4", "unknown_macro", `planToTxOps 不认识宏 "${n.macro}"`);
        }
        /* R1：宏自己说失败 ⇒ 一条 op 都不生成 */
        if (n.result.ok !== true) {
            const e = n.result.error || {};
            return reject("R1", "MACRO_REFUSED",
                `宏 ${n.macro} 返回 ok:false（${e.code || "?"}: ${e.message || n.result.reason || "无 message"}）`,
                { macro: n.macro, error: e });
        }
        /* ── R2：返回值过信封校验 ── */
        const v = validateMacroResult(n.result);
        if (!v.ok) {
            return reject("R2", "MACRO_HALF_DONE",
                `宏 ${n.macro} 的返回值不合信封（${v.error.code}: ${v.error.message}）`,
                { macro: n.macro, error: v.error });
        }
        normalized.push(n);
    }

    const obs = unwrapObs(ctx.obs);
    const entities = Array.isArray(obs.entities) ? obs.entities : [];
    const entByCell = new Map();
    const entByUid = new Map();
    for (const e of entities) {
        if (!e) continue;
        entByUid.set(e.uid, e);
        const f = footprintCells(e.type, e.variant, e.x, e.y, e.r || 0);
        for (const c of f.cells) if (!entByCell.has(K(c))) entByCell.set(K(c), e);
    }
    const tplFor = (kind, variant) => templateByBuildingVariant(kind, variant || "default") || {};

    /* ── R3 / R4：收集 destroys 与 places ── */
    const destroys = new Set();
    const derived = [];
    const warnings = [];
    const placeList = [];

    for (const c of normalized) {
        for (const uid of selfReportedDestroys(c.result)) destroys.add(uid);
        if (c.macro === "connect") {
            const d = connectDestroysFromObs(c.result, entByCell);
            for (const x of d) {
                if (!destroys.has(x.uid)) derived.push(x);
                destroys.add(x.uid);
            }
        }
        const col = collectPlaces(c, tplFor);
        if (col.error) return reject("R4", "op_shape", `宏 ${c.macro}: ${col.error}`);
        for (const p of col.places) { p.reversePath = !!col.reversePath; placeList.push(p); }
        for (const w of (c.result.warnings || [])) {
            warnings.push({ ...w, source: "macro", macro: c.macro });
        }
    }
    if (derived.length) {
        warnings.push({
            code: "DESTROYS_DERIVED",
            source: "planToTxOps",
            detail: `connect(allow_replace) 未自报销毁；由 cells[] ∩ obs 补算出 ${derived.length} 条将被覆盖的带子：`
                + derived.map(d => `uid=${d.uid}@(${d.cell[0]},${d.cell[1]})`).join(", "),
            hint: "宏只发 replacing-belts 警告、不给 uid（connect.mjs:861-866）。补算结果必须与宏的格数一致；"
                + "不一致说明 cells 与 obs 不同步，按 verif 失败处理。",
            derived_uids: derived.map(d => d.uid),
        });
    }

    /* ── R5 / R6：占用与冲突（footprint 级，不是 origin 点级） ── */
    const claimed = new Map();      // cell → {kind, x, y, macro}
    for (const p of placeList) {
        const cells = p.cells && p.cells.length
            ? p.cells.map(c => [c[0], c[1]])
            : footprintCells(p.kind, p.variant, p.x, p.y, p.rot).cells;
        p._cells = cells;
        for (const c of cells) {
            const key = K(c);
            if (claimed.has(key)) {
                const other = claimed.get(key);
                return reject("R5", "plan_conflict",
                    `同一格 (${c[0]},${c[1]}) 被两个 place 命中：${other.kind}@(${other.x},${other.y}) 与 ${p.kind}@(${p.x},${p.y})`,
                    { cell: c, first: other, second: { kind: p.kind, x: p.x, y: p.y } });
            }
            claimed.set(key, { kind: p.kind, x: p.x, y: p.y, macro: p.macro });
        }
    }
    for (const p of placeList) {
        for (const c of p._cells) {
            const e = entByCell.get(K(c));
            if (!e) continue;                                  // 空格
            if (destroys.has(e.uid)) continue;                  // 本单会删掉
            if (BELT_KINDS.has(e.type)) {
                /* 带子没被声明销毁却被覆盖 ⇒ 静默覆盖（正是 R6 要拦的形态） */
                return reject("R6", "plan_conflict",
                    `place ${p.kind}@(${p.x},${p.y}) 的目标格 (${c[0]},${c[1]}) 上有带子 uid=${e.uid}，但它不在 destroys 里`,
                    { cell: c, uid: e.uid, type: e.type, kind: p.kind });
            }
            return reject("R6", "plan_conflict",
                `place ${p.kind}@(${p.x},${p.y}) 的目标格 (${c[0]},${c[1]}) 被 ${e.type} uid=${e.uid} 占着（机器/hub 永不让位）`,
                { cell: c, uid: e.uid, type: e.type, kind: p.kind });
        }
    }

    /* ── R7：删除的 uid 必须真在 obs 里（过期计划不许删新长出来的东西） ── */
    for (const uid of destroys) {
        if (!entByUid.has(uid)) {
            return reject("R7", "plan_stale",
                `destroys 里的 uid=${uid} 不在当前 obs 里 —— 计划已过期（世界变了或选集抄错）`,
                { uid });
        }
    }

    /* ── R9：排序（deletes 升序 → 有依赖的宏先落 → machines 按 (y,x) → belts 路径倒序） ──
     *
     * 机器内部再分一层：`trash` 这类**附属建筑**必须排在主动机器之后。
     * 理由不是审美 —— trash 的落点是由主动机器的某个输出槽**算出来**的
     * （replace_run 的 placed[] 顺序、trash_unused 的 trashCell 都是这个关系）。
     * 反过来排会让「先放垃圾桶、再放它要接的机器」出现在同一 tx 里，
     * 事务中途读世界的东西（bv 重算、邻居定向）看到的是不完整的地形。
     */
    const isAux = p => p.kind === "trash";
    const ranks = callRanks(normalized);
    const ordered = placeList.slice().sort((a, b) => {
        const ra = ranks[a.callIndex] || 0, rb = ranks[b.callIndex] || 0;
        if (ra !== rb) return ra - rb;
        const ka = kindRank(a.kind), kb = kindRank(b.kind);
        if (ka !== kb) return ka - kb;
        if (ka === 1 && a.reversePath && b.reversePath) return b.pathIndex - a.pathIndex;
        if (isAux(a) !== isAux(b)) return isAux(a) ? 1 : -1;
        return (a.y - b.y) || (a.x - b.x);
    });

    /* ── R8 + R10：产出 ops 并逐条查形状 ── */
    const ops = [];
    const pendingByOp = {};
    const deleteUids = [...destroys].sort((a, b) => a - b);
    for (const uid of deleteUids) ops.push({ op: "delete", uid });
    for (const p of ordered) {
        const op = { op: "place", building: p.kind, x: p.x, y: p.y, r: p.rot || 0 };
        if (p.variant && p.variant !== "default") op.variant = p.variant;
        if (BELT_KINDS.has(p.kind)) {
            if (!isInt(p.rv)) {
                return reject("R10", "op_shape",
                    `${p.kind}@(${p.x},${p.y}) 缺 rotationVariant —— 带子必须显式给 rv（落盘后要读回比对 code=1+rv）`,
                    { place: { kind: p.kind, x: p.x, y: p.y, macro: p.macro } });
            }
            op.rotationVariant = p.rv;
        }
        ops.push(op);
        if (p.token) pendingByOp[ops.length - 1] = p.token;
    }
    if (ops.length > MAX_OPS) return reject("R8", "plan_too_large", `ops=${ops.length} 超过上限 ${MAX_OPS}`);
    if (placeList.length > MAX_PLACES) return reject("R8", "plan_too_large", `place 目标数=${placeList.length} 超过上限 ${MAX_PLACES}`);
    for (const op of ops) {
        const bad = checkOpShape(op);
        if (bad) return reject("R10", "op_shape", bad, { op });
    }

    /* ── R12：给 verifyRuntime 的计划（形状必须能被 normalizePlan 吃掉） ── */
    const placements = ordered.map(p => ({
        uid: null,                           // 新放的实体 uid 由 tx 分配；这里不许编
        kind: p.kind,
        variant: p.variant,
        x: p.x, y: p.y,
        rot: p.rot || 0,
        rv: BELT_KINDS.has(p.kind) ? p.rv : (p.rv === null ? null : p.rv),
        code: p.code === undefined ? null : p.code,
        ...(p.token ? { token: p.token } : {}),
    }));
    const removes = deleteUids.map(uid => {
        const e = entByUid.get(uid);
        return {
            uid,
            expect: {
                type: e.type,
                x: e.x, y: e.y,
                r: typeof e.r === "number" ? e.r : 0,
            },
        };
    });

    /* ── flows（v2 §2.6）：必须在 placements 定型之后派生 ── */
    const scanned = scanFlows(ordered.map(p => ({
        kind: p.kind, variant: p.variant, x: p.x, y: p.y, rot: p.rot,
        uid: null, token: p.token, cells: p._cells, macro: p.macro,
    })), obs, ctx.items ? unwrapItems(ctx.items) : ctx.items);
    const flows = scanned.flows;
    warnings.push(...scanned.warnings);
    if (!flows.length && placeList.length) {
        warnings.push({
            code: "FLOW_UNVERIFIED",
            source: "planToTxOps",
            detail: `计划里有 ${placeList.length} 台/格新建筑，但派生不出任何 flow —— L3 无法验证任何货流`,
            hint: "不许把「没有货流要验」当成通过；调用方必须按 FLOW_UNVERIFIED 判红。",
        });
    }

    /* ── R13：**实质删除必须与「LLM 指名的对象」一致** ──
     *
     * 这是本轮最危险的一类漏洞的防线（2026-10-29 实测发现）：
     *   LLM 说「改 B69/B81/B82」（故意不写坐标，只给句柄），
     *   `$bbox_of` 算出 `[4,-14, 5,-13]`，
     *   `replace_run` 在这个矩形里挑落点，结果删掉了 `[10150, 10209, 10149]`
     *   —— 其中 `10150`(B70) **没有被点名**，而被点名的 `10143`(B69) **反而没动**。
     *   而 `replace_run` 返回 **ok:true**，没有任何拒绝信号。
     *
     * 实测复现（L4 真实存档）：
     *   $bbox_of(["B69","B81","B82"]) → region [4,-14,5,-13]
     *   → 实际删除 [10150,10209,10149]，期望 [10209,10149,10143]
     *
     * 危害等级：**高于任何一次 explicit failure**。一个"成功"的 tx 会在世界里
     * 删掉 LLM 从未指名的东西，而 L1 落地检查只看"计划声明的有没有落地"，
     * 看不见"多删了谁"（那要靠 undeclaredDestruction，但前提是计划里声明正确）。
     *
     * 判据：如果调用方（resolveRefs）在 args 里留下了「指名句柄 → uid」的对照
     * （`ctx.namedUids`，由 loop 在解析 `$uids`/`$path_of` 时填），
     * 那么**每一个被删除的 uid 都必须在这个对照里**。
     * 没给对照时不判（保持向后兼容），但要记一条警告 —— 不许静默。
     */
    const named = ctx.namedUids instanceof Set ? ctx.namedUids
        : Array.isArray(ctx.namedUids) ? new Set(ctx.namedUids) : null;
    if (named && named.size && deleteUids.length) {
        const extra = deleteUids.filter(u => !named.has(u));
        if (extra.length) {
            const who = extra.map(u => {
                const e = entByUid.get(u);
                return e ? `${u}@(${e.x},${e.y})` : String(u);
            }).join(", ");
            return reject(
                "R13", "destroys_not_named",
                `计划要删除 ${deleteUids.length} 个实体，其中 ${extra.length} 个**不在 LLM 指名的句柄里**：${who}。`
                + `这通常是 $bbox_of 的矩形顺带框进了没点名的格子 —— 宏会"成功"但删错对象。`,
                { deleted: deleteUids, extra, named: [...named] },
            );
        }
    } else if (deleteUids.length) {
        warnings.push({
            code: "DESTROYS_UNNAMED_CHECK_SKIPPED",
            source: "planToTxOps",
            detail: `删除了 ${deleteUids.length} 个实体，但 ctx.namedUids 未提供 —— 无法断言"删的就是点名的那几个"`,
            hint: "loop 应把 resolveRefs 得到的 uid 集合传进 ctx.namedUids；否则 $bbox_of 删错对象这类问题查不出来。",
        });
    }

    return {
        ok: true,
        ops,
        destroys: deleteUids,
        pendingByOp,
        placements,
        removes,
        flows,
        warnings,
        error: null,
    };
}

export default planToTxOps;
