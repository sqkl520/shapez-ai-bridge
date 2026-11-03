/**
 * remove.mjs — 宏：**减法与改造**。`remove_run` / `replace_run` / `trash_unused`。
 *
 * ═════════════════════════ 为什么需要这三个宏（DIRECTION-FINAL 阶段 1）═════════════════════════
 * `connect` 只做**加法**。实测（CONNECT-USABILITY-FINDING.md）它在真实存档上的失败
 * 绝大多数是「端口已被既有带子接走」的**正确拒绝** —— 几何能力 100%，可用性受限于
 * 它无法先拆。而真实改造场景几乎全是减法：
 *   · 从带子中间切开，插一台机器（L4 的唯一已知正解）
 *   · 把一段带子改道
 *   · 给一个没有去处的输出槽接垃圾桶
 * 所以「宏动作层」这个赌注在三个减法宏落地前**无法验证**。
 *
 * ═════════════════════════ 与 contract.mjs 的关系（★ 两处显式扩展，已登记）═════════════════════════
 * 入参一律先过 `contract.mjs` 的校验器 —— 它是唯一入口，本文件不自己解构 args。
 *
 * 【扩展 1】`replace_run.building` 接受**建筑数组**与**机器**（契约 v1 只写了 `"belt"`）。
 *   理由：任务书要求它表达 L4 的真实改造「3 格带 → 1 台 cutter + 1 个 trash」；
 *   而契约自身的 `whenNotToUse` 又把「带子换机器」推给 `insert_machine`，两者对不上。
 *   这里按「照 plan 实现 + 登记，不自行改接口」的纪律处理（CONTEST.md 的规则）：
 *   · `building:"belt"` 走**契约原义**（逐格解 rv 修复，见 §4.1），行为与契约逐字一致；
 *   · `building: "cutter"` / `["cutter", {kind:"trash", port:"left"}]` 走扩展路径，
 *     并把**契约对 region 的全部检查原样复用**（把 building 强制成 "belt" 复用校验器，
 *     所以裸坐标/未知键/反序 bbox 仍然逐条被拒）。
 *   · 扩展路径的公开参数里**依然没有任何 x/y/r/rv**：落点由 region + 建筑几何内部解。
 *   · 每台 trash 必须点名 `port`（role 名，是 choice 不是坐标）—— 宏绝不替调用方猜
 *     「哪一路是废料」。L4 的 RuRu---- 恰好与 `wasteRoles`（右列）相反，契约 §2.6 已论证
 *     这一侧宏查不出来，只能要求签字，故非 wasteRoles 的 port 还要求 `confirm_waste:true`。
 *
 * 【扩展 2】`trash_unused.outlet` 也接受**一段带子的末端**（不只是机器输出槽）。
 *   理由：任务书的用例是「给铜线那个死路 (-10,-3) 接垃圾桶」，而 (-10,-3) 是一条带子
 *   （uid 10008），不是机器。带子的「输出槽」就是它的 exit 面，语义一一对应：
 *   唯一出口、可判「是否已有下游」。垃圾桶落在 **exit 的下一格**，不是带子自己那格。
 *
 * ═════════════════════════ 几何权威 ═════════════════════════
 * 方向逻辑**一行都不自己写**：一律 `belt-rules.mjs` 的 beltEntry / beltExit / solveTurn /
 * rotateLocal + `op-templates.mjs` 的槽位表（经 `connect.mjs` 的 `portsOf` 复用，不重写）。
 *
 * 实测口径（不是推理，见 connect.mjs 文件头 F1/F3）：
 *   · 相邻两带闭合：exit(a) === OPP[entry(b)]（161 条真实带子 145/146）
 *   · 机器 ejector：槽格 S、面 d ⇒ 带格 = S + DIRV[d]，带子 entry = OPP[d]
 *   · 机器 acceptor：槽格 S、面 d ⇒ 带格 = S + DIRV[d]，带子 exit  = OPP[d]
 *   于是「端口 ↔ 带格」是一条**对称**规则：端口 q 的带格恒为 `q.cell`；
 *   eject 要求 belt.entry === OPP[q.face]，accept 要求 belt.exit === OPP[q.face]。
 *   （机器紧贴机器 = 0 格连接：eject 的 cell 正好是对方 accept 的 slot，同上式推出。）
 *
 * ⚠️ 本文件**零游戏写操作**：三个宏都只规划 + 自证，`dry_run` **恒为 true**；
 *    真正的 delete/place 由调用方（tx）执行。返回值里的 changed/removed/placed 是**计划**。
 *    「调用方有没有要求 dry-run」是另一件事，单列在 `requested_dry_run`（+ `planned_only:true`）。
 *    以前 replace_run 把 opts.dry_run 直接写进 dry_run，于是 dry_run:false 被误读成「已写入」
 *    —— 实际什么都没写（E2E 验收缺陷 3）。
 *
 * ⓘ 宏之间的**串接**：`replace_run` 的每台新建筑、`trash_unused` 的垃圾桶都返回 `pending`
 *   （计划态实体引用，见 contract.PENDING_REF_SPEC）。下游宏可以直接把它当 outlet/endpoint：
 *       const a = replace_run(...);            // 计划态
 *       trash_unused({ outlet: a.placed[0].pending, port: "right" }, ctx)
 *   要把它折进世界（例如让 remove_run/connect 看到它占地），用 place.mjs 的 `applyToWorld()`；
 *   合成 uid 是负数（不是游戏 uid），真正落盘仍走 tx + 重新 obs。
 *
 * 用法：
 *   removeRun({ uids:[10209,10149,10143] }, ctx)
 *   removeRun({ cells:[[4,-13],[5,-13],[4,-14]] }, ctx)
 *   replaceRun({ region:[4,-14,5,-13],
 *                building:["cutter", {kind:"trash", port:"left", confirm_waste:true}] }, ctx)
 *   trashUnused({ outlet:{ uid:10008 } }, ctx)        // 带子死路
 *   trashUnused({ outlet:{ uid:10036, port:"left" } }, ctx)
 *
 * 离线自测：node src/agent/macros/remove.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 唯一方向权威 —— 本文件不得再写任何方向旋转逻辑
import { ORDER, OPP, DIRV, beltEntry, beltExit, solveTurn, rotateLocal } from "../../ai/belt-rules.mjs";
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import {
    validateRemoveRunArgs, validateReplaceRunArgs, validateTrashUnusedArgs, validateMacroResult,
} from "./contract.mjs";
// 世界模型 / 端口枚举 / footprint 展开都复用 connect 的既有实现（不另写一套）
import { buildWorld, portsOf } from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(HERE, "../../ai/machine-spec.json");

/* ═══════════════════════════════ 0. 小工具 ═══════════════════════════════ */

const isInt = n => typeof n === "number" && Number.isInteger(n);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const key = (x, y) => `${x},${y}`;
const keyOf = c => `${c[0]},${c[1]}`;
const eqCell = (a, b) => a[0] === b[0] && a[1] === b[1];
/** 确定性排序：先 y 再 x（同一输入的输出顺序必须可复现，红队与逐格 diff 都依赖这点） */
const byYX = (a, b) => (a[1] - b[1]) || (a[0] - b[0]);

let _spec = null;
function loadSpec() {
    if (_spec === null) _spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
    return _spec;
}

/** 建筑尺寸真值（footprint 展开用；原点=左上角，见 connect.mjs F2） */
function sizeOf(spec, type, variant) {
    const b = spec.buildings && spec.buildings[type];
    if (!b || !b.variants) return [1, 1];
    const v = b.variants[variant] || b.variants.default || Object.values(b.variants)[0];
    return (v && Array.isArray(v.size)) ? v.size : [1, 1];
}

/** ctx → 实体数组（支持 {entities}、obs 整体 {entities:[...]}、已建好的 world） */
const _worldCache = new WeakMap();
function entitiesOf(ctx) {
    if (!ctx) return null;
    if (Array.isArray(ctx.entities)) return ctx.entities;
    if (ctx.entities && Array.isArray(ctx.entities.entities)) return ctx.entities.entities;
    return null;
}
function worldFrom(entities, spec) {
    if (!Array.isArray(entities)) return null;
    let w = _worldCache.get(entities);
    if (!w) { w = buildWorld(entities, spec); _worldCache.set(entities, w); }
    return w;
}
function worldFor(ctx, spec) {
    if (!ctx) return null;
    if (ctx.cells && ctx.byUid) return ctx;              // 已经是 world
    const ents = entitiesOf(ctx);
    return ents ? worldFrom(ents, spec) : null;
}

/** 归一化 ctx（createContext 的结果可直接当 ctx 传回来） */
function ctxOf(ctx, spec) {
    if (ctx && ctx.__removeCtx) return ctx;
    const world = worldFor(ctx, spec);
    if (!world) return null;
    const ents = ctx && ctx.cells ? (ctx.entities || []) : (entitiesOf(ctx) || []);
    return makeContext(world, ents, spec);
}

/* ═══════════════════════════════ 1. 世界上下文 + 端口↔带子图 ═══════════════════════════════ */

/**
 * 只读上下文：world + 每格的机器端口 + 每台机器的端口表 + 带子几何。
 *
 * 端口↔带子只有一条规则（见文件头）：端口 q 的带格 = q.cell；
 *   eject  要求 belt.entry === OPP[q.face]
 *   accept 要求 belt.exit  === OPP[q.face]
 *
 * @returns {{world, entities, spec, belts:Map, machines:Map, portAtCell:Map, __removeCtx:true}}
 */
export function makeContext(world, entities, spec = loadSpec()) {
    const belts = new Map();          // uid → {uid,x,y,r,rv,entry,exit}
    const machines = new Map();       // uid → {rec, eject:[], accept:[]}
    const portAtCell = new Map();     // "x,y" → [port…]（端口自己的带格）

    for (const rec of world.byUid.values()) {
        if (rec.type === "belt") {
            belts.set(rec.uid, {
                uid: rec.uid, x: rec.x, y: rec.y, r: rec.r, rv: rec.rv,
                entry: beltEntry(rec.rv, rec.r), exit: beltExit(rec.rv, rec.r),
            });
            continue;
        }
        if (rec.type === "underground_belt") continue;   // 隧道：不透明节点，不参与链接推导
        if (rec.r !== 0) {
            /* portsOf 对 r≠0 返回空表（v1 决策 D1）。这里显式登记，而不是当成"没有端口" */
            machines.set(rec.uid, { rec, eject: [], accept: [], rotatedOutOfScope: true });
            continue;
        }
        let pp;
        try { pp = portsOf(rec, spec); } catch { pp = { eject: [], accept: [] }; }
        const eject = pp.eject.map(q => ({ ...q, uid: rec.uid, type: rec.type, kind: "eject" }));
        const accept = pp.accept.map(q => ({ ...q, uid: rec.uid, type: rec.type, kind: "accept" }));
        machines.set(rec.uid, { rec, eject, accept });
        for (const q of [...eject, ...accept]) {
            const k = keyOf(q.cell);
            if (!portAtCell.has(k)) portAtCell.set(k, []);
            portAtCell.get(k).push(q);
        }
    }
    return { __removeCtx: true, world, entities: (entities || []).slice(), spec, belts, machines, portAtCell };
}

const cellOf = rec => [rec.x, rec.y];

/** 某条带子的上游：谁在喂它（最多一个，因为 entry 是单一面） */
function inLink(belt, ctx) {
    const c = [belt.x + DIRV[belt.entry][0], belt.y + DIRV[belt.entry][1]];
    const occ = ctx.world.cells.get(keyOf(c));
    if (!occ) return null;
    const rec = ctx.world.byUid.get(occ.uid);
    if (!rec) return null;
    if (rec.type === "belt") {
        const m = ctx.belts.get(rec.uid);
        if (!m) return null;
        return (m.exit === OPP[belt.entry])
            ? { type: "belt", uid: m.uid, cell: [m.x, m.y] }
            : { type: "mismatch", uid: m.uid, cell: [m.x, m.y] };
    }
    if (rec.type === "underground_belt") return { type: "opaque", uid: rec.uid, cell: c };
    /* 机器 ejssctor：槽格 == 上格，面朝 OPP[本带 entry]（即朝本带喷）。
       ⚠️ 不能用 portAtCell 查这里：portAtCell 的键是**端口的带格**（q.cell），
       而紧贴的机器 q.cell = 本带自己那格，不是上格 c —— 用 c 去查永远查不到（旧实现的 bug：
       被机器喷的带子被误判成 starved）。直接按槽格比。 */
    const q = (ctx.machines.get(rec.uid) || { eject: [] }).eject
        .find(p => eqCell(p.slot, c) && p.face === OPP[belt.entry]);
    return q ? { type: "machine", uid: rec.uid, port: q, cell: c } : null;
}

/** 某条带子的下游：它把货推给谁 */
function outLink(belt, ctx) {
    const c = [belt.x + DIRV[belt.exit][0], belt.y + DIRV[belt.exit][1]];
    const occ = ctx.world.cells.get(keyOf(c));
    if (!occ) return null;
    const rec = ctx.world.byUid.get(occ.uid);
    if (!rec) return null;
    if (rec.type === "belt") {
        const n = ctx.belts.get(rec.uid);
        if (!n) return null;
        return (n.entry === OPP[belt.exit])
            ? { type: "belt", uid: n.uid, cell: [n.x, n.y] }
            : { type: "mismatch", uid: n.uid, cell: [n.x, n.y] };
    }
    if (rec.type === "underground_belt") return { type: "opaque", uid: rec.uid, cell: c };
    /* accept 端口的 cell 是「它从哪格收货」—— 正是本条带子自己那格 */
    const bc = key(belt.x, belt.y);
    const q = (ctx.machines.get(rec.uid) || { accept: [] }).accept
        .find(p => p.face === OPP[belt.exit] && keyOf(p.cell) === bc);
    return q ? { type: "machine", uid: rec.uid, port: q, cell: c } : null;
}

/** 端口当前绑定的带子（没有 → null）。eject 看 entry、accept 看 exit，同一条规则。 */
function boundBeltOf(q, ctx) {
    const occ = ctx.world.cells.get(keyOf(q.cell));
    if (!occ) return null;
    const b = ctx.belts.get(occ.uid);
    if (!b) return null;
    const want = OPP[q.face];
    return q.kind === "eject"
        ? (b.entry === want ? b : null)
        : (b.exit === want ? b : null);
}

/** 端口有没有「供料/去处」（belt 或紧贴的另一台机器） */
function inLinkOfPort(q, ctx) {
    const occ = ctx.world.cells.get(keyOf(q.cell));
    if (!occ) return null;
    const rec = ctx.world.byUid.get(occ.uid);
    if (!rec) return null;
    if (rec.type === "belt") {
        const b = ctx.belts.get(rec.uid);
        return b && b.exit === OPP[q.face] ? { type: "belt", uid: b.uid } : null;
    }
    if (rec.type === "underground_belt") return { type: "opaque", uid: rec.uid };
    /* 紧贴的机器：来源机器的 eject 必须就在 q.cell 且朝 OPP[q.face] 喷 */
    const src = (ctx.machines.get(rec.uid) || { eject: [] }).eject
        .find(p => eqCell(p.slot, q.cell) && p.face === OPP[q.face]);
    return src ? { type: "machine", uid: rec.uid, port: src } : null;
}
function outLinkOfPort(q, ctx) {
    const occ = ctx.world.cells.get(keyOf(q.cell));
    if (!occ) return null;
    const rec = ctx.world.byUid.get(occ.uid);
    if (!rec) return null;
    if (rec.type === "belt") {
        const b = ctx.belts.get(rec.uid);
        return b && b.entry === OPP[q.face] ? { type: "belt", uid: b.uid } : null;
    }
    if (rec.type === "underground_belt") return { type: "opaque", uid: rec.uid };
    /* 紧贴的机器（0 格连接）：对方 accept 的**槽格**必须是货落下的那一格 q.cell，
       且面朝回本机（= OPP[q.face]）。这是 F3 的同一条规则在"对方没有带格"时的退化。 */
    const dst = (ctx.machines.get(rec.uid) || { accept: [] }).accept
        .find(p => eqCell(p.slot, q.cell) && p.face === OPP[q.face]);
    return dst ? { type: "machine", uid: rec.uid, port: dst } : null;
}

/* ═══════════════════════════════ 2. 返回信封 ═══════════════════════════════ */

function okResult(macro, planned, extras = {}, warnings = []) {
    const r = {
        ok: true, macro,
        cells_planned: planned, cells_placed: planned,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings, error: null,
        /* 语义（E2E 缺陷 3）：本宏**永不写世界**，所以 dry_run 恒 true；
           「调用方有没有要求 dry-run」是另一件事，单列在 requested_dry_run。
           以前 replace_run 把 opts.dry_run 直接写进 dry_run，于是 dry_run:false 被误读成
           「已经写入」—— 实际什么都没写。 */
        dry_run: true,
        planned_only: true,
        ...extras,
    };
    const chk = validateMacroResult(r);
    if (!chk.ok) {
        return failure(macro, {
            code: "internal", field: chk.error.field,
            message: `返回值不合契约：${chk.error.message}`,
            hint: "这是宏的 bug，不是调用错。请把入参与本返回值一起报告。",
        });
    }
    return r;
}

/**
 * 统一失败信封。**带上空诊断数组**：调用方不该因为失败就去判断
 * `r.removed === undefined`（那会让「零删除」和「字段缺失」混为一谈）。
 */
function failure(macro, err, extras = {}) {
    const e = {
        code: err.code,
        field: err.field === undefined ? null : err.field,
        message: err.message,
        hint: err.hint || null,
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
        planned_only: true,
        reason: err.message,
        // 三个宏共用的诊断槽位，恒在场（失败 = 什么都没做，所以是空集而不是"没有这个字段"）
        removed: [], placed: [], kept: [], would_disconnect: [],
        consequences: { orphaned_outputs: [], starved_belts: [], starved_machines: [], opaque: [] },
        sideEffects: [],
        firstConflict: null,
        ...extras,
    };
}

/* ═══════════════════════════════ 3. remove_run ═══════════════════════════════ */

/**
 * 删除前后拓扑会怎么断。**只报告，不阻止** —— 与契约一致
 * （remove_run 的 orphaned_outputs 明写「不阻止执行，但必须如实出现」）。
 *
 * 为什么必须不阻止：L4 的唯一正解就是「先删 3 格带再插机器」，
 * 删的那 3 格在删除那一刻**必然**断 4 条链接；阻止它等于禁止唯一正解。
 * 但调用方必须看到断在哪，才能知道下一步该插什么。
 *
 * kind 三档：
 *   · orphaned-output  某条带子/某个机器输出槽的唯一去处被删了 → 它会堵住
 *   · starved-belt     某条留下的带子再没有任何供料方 → 它会空转
 *   · starved-machine  某台机器的输入槽再没有任何供料方
 */
export function analyzeRemoval(ctx, removedUids) {
    const R = new Set(removedUids);
    const out = [];
    for (const uid of [...R].sort((a, b) => a - b)) {
        const b = ctx.belts.get(uid);
        if (!b) continue;

        const o = outLink(b, ctx);
        if (o && o.type === "belt" && !R.has(o.uid)) {
            out.push({
                kind: "starved-belt", uid: o.uid, cell: o.cell,
                why: `(${b.x},${b.y}) uid=${uid} 被删后，下游 (${o.cell[0]},${o.cell[1]}) uid=${o.uid} 再没有任何供料方`,
            });
        }
        if (o && o.type === "machine") {
            const q = o.port;
            const only = boundBeltOf(q, ctx);
            if (only && only.uid === uid) {
                out.push({
                    kind: "starved-machine", uid: q.uid, cell: q.slot,
                    port: { role: q.role, index: q.index, face: q.face, cell: q.cell },
                    why: `机器 uid=${q.uid} 的输入槽 ${q.role}#${q.index} 只剩 (${b.x},${b.y}) 供料`,
                });
            }
        }

        const i = inLink(b, ctx);
        if (i && i.type === "belt" && !R.has(i.uid)) {
            out.push({
                kind: "orphaned-output", uid: i.uid, cell: i.cell,
                why: `(${i.cell[0]},${i.cell[1]}) uid=${i.uid} 的唯一去处 (${b.x},${b.y}) 被删，之后无处可去`,
            });
        }
        if (i && i.type === "machine") {
            const q = i.port;
            const only = boundBeltOf(q, ctx);
            if (only && only.uid === uid) {
                out.push({
                    kind: "orphaned-output", uid: q.uid, cell: q.slot,
                    port: { role: q.role, index: q.index, face: q.face, cell: q.cell },
                    why: `机器 uid=${q.uid} 的输出槽 ${q.role}#${q.index} 的唯一去处 (${b.x},${b.y}) 被删`,
                });
            }
        }
        if ((i && i.type === "opaque") || (o && o.type === "opaque")) {
            out.push({
                kind: "opaque-neighbour", uid, cell: [b.x, b.y],
                why: "这段带子紧贴隧道;隧道的吞吐无法离线判定,删除后请用 debug_items 复核该隧道两端",
            });
        }
    }
    out.sort((a, b) => byYX(a.cell, b.cell) || cmpStr(a.kind, b.kind));
    return out;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 4-邻接连通分量（删选集是否连成一段） */
function componentsOf(cells) {
    const set = new Map(cells.map(c => [keyOf(c), c]));
    const seen = new Set();
    const comps = [];
    for (const c of cells.slice().sort(byYX)) {
        if (seen.has(keyOf(c))) continue;
        const stack = [c]; const comp = [];
        seen.add(keyOf(c));
        while (stack.length) {
            const cur = stack.pop(); comp.push(cur);
            for (const d of ORDER) {
                const n = [cur[0] + DIRV[d][0], cur[1] + DIRV[d][1]];
                const k = keyOf(n);
                if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push(n); }
            }
        }
        comps.push(comp.sort(byYX));
    }
    return comps;
}

/**
 * `remove_run` — 删掉一段带子（uid 优先，cells 次选）。**整段原子删除**。
 *
 * 形态：
 *   removeRun({ uids:[…] } | { cells:[[x,y],…] }, ctx)
 *   removeRun([10209, 10149, 10143], opts?, ctx?)      // 数字数组 = uids
 *   removeRun([[4,-13],[5,-13]], opts?, ctx?)          // 二元组数组 = cells
 *
 * @returns MacroResult + {removed:[{uid,cell}], would_disconnect:[…], consequences, kept, stranded_items}
 */
export function removeRun(a, b, c) {
    const A = "remove_run";
    let args, ctx;
    if (Array.isArray(a)) {
        const isCells = a.length > 0 && Array.isArray(a[0]);
        args = isCells ? { cells: a, opts: isObj(b) ? b : undefined } : { uids: a, opts: isObj(b) ? b : undefined };
        ctx = c || {};
    } else if (isObj(a)) {
        args = a; ctx = b || {};
    } else {
        return failure(A, {
            code: "bad_type", field: null,
            message: `${A} 的入参必须是 {uids|cells, opts?} 或一个非空数组`,
            hint: "uid 来自 obs.entities[].uid，例如 remove_run({uids:[10209,10149,10143]})。",
        });
    }

    const v = validateRemoveRunArgs(args);
    if (!v.ok) {
        return failure(A, {
            ...v.error,
            hint: v.error.hint || `优先用 uid（稳定）：removeRun({uids:[…]})；cells 必须逐格命中带子。`,
        });
    }
    const sel = v.value;
    const opts = sel.opts;

    const spec = loadSpec();
    const c0 = ctxOf(ctx, spec);
    if (!c0) {
        return failure(A, {
            code: "precondition_failed", field: null,
            message: `${A} 需要 ctx.entities（obs 的实体表）才能把 uid/cell 解析成实体`,
            hint: "先 obs，再把 {entities} 作为第二个参数传进来；本宏不读世界、也不猜。",
        });
    }

    /* ── 解析选集：uid 优先，cells 次选；任何一格解析到机器 → 整单拒绝 ── */
    const picked = [];        // {uid, cell, rec}
    const bad = [];
    if (sel.uids) {
        for (const uid of sel.uids) {
            const rec = c0.world.byUid.get(uid);
            if (!rec) { bad.push({ uid, why: "不在当前世界（obs 过期或已被删）" }); continue; }
            if (rec.type !== "belt" && rec.type !== "underground_belt") {
                bad.push({ uid, why: `解析到 ${rec.type}（本宏只处理带子）`, cell: cellOf(rec) });
                continue;
            }
            picked.push({ uid, cell: cellOf(rec), rec });
        }
    } else {
        for (const cell of sel.cells) {
            const occ = c0.world.cells.get(keyOf(cell));
            if (!occ) { bad.push({ cell, why: "该格没有任何实体（obs 过期？）" }); continue; }
            const rec = c0.world.byUid.get(occ.uid);
            if (!rec) { bad.push({ cell, why: "占用记录指向不存在的实体" }); continue; }
            if (rec.type !== "belt" && rec.type !== "underground_belt") {
                bad.push({ cell, why: `该格是 ${rec.type} uid=${rec.uid}（本宏只处理带子）` });
                continue;
            }
            if (!eqCell(cellOf(rec), cell)) {
                bad.push({ cell, why: `该格不是 uid=${rec.uid} 的 origin（是它 footprint 的一部分）` });
                continue;
            }
            picked.push({ uid: rec.uid, cell, rec });
        }
    }

    if (bad.length) {
        /* 分类按**原因**，不按字段形态：cells 形态下"该格没有任何实体"同样是
           endpoint_not_found（那一格在 obs 里不存在）。它以前被归到 precondition_failed，
           于是"删空格"和"删该删但状态不对"混成同一个码，调用方无法分诊。 */
        const missing = bad.filter(x => /不在当前世界|没有任何实体|指向不存在的实体/.test(x.why));
        const machines = bad.filter(x => /只处理带子/.test(x.why));
        if (missing.length) {
            return failure(A, {
                code: "endpoint_not_found", field: sel.uids ? "uids" : "cells",
                message: sel.uids
                    ? `${missing.length}/${bad.length} 个 uid 在当前世界不存在：${missing.slice(0, 5).map(x => x.uid).join(", ")}`
                    : `${missing.length}/${bad.length} 个 cell 在当前世界没有实体：${missing.slice(0, 5).map(x => JSON.stringify(x.cell)).join(", ")}`,
                hint: "重新 obs 再用**新的** uid/cell 重写选集；不要用旧 uid 重试（uid 不会复活，"
                    + "同坐标可能已经是别的东西）。本宏宁可失败，也不静默跳过。",
                candidates: missing.slice(0, 5).map(x => (x.uid !== undefined ? x.uid : x.cell)),
                detail: { missing, bad },
            });
        }
        if (machines.length) {
            return failure(A, {
                code: "not_a_run", field: sel.uids ? "uids" : "cells",
                message: `选集里有 ${machines.length} 个非带子实体（整单拒绝，不「尽量删」）`,
                hint: `第一个：${JSON.stringify(machines[0].cell || machines[0].uid)} ${machines[0].why}。`
                    + "要删机器是另一个动作（removes[] + tx，且 hub 不可删）；本宏只动带子。",
                detail: { offending: machines.slice(0, 5) },
            });
        }
        return failure(A, {
            code: "precondition_failed", field: sel.uids ? "uids" : "cells",
            message: `选集有 ${bad.length} 个无法解析的项`,
            hint: "先 obs 再重选；cells 形态要求该格既是带子、又是它的 origin。",
            detail: { bad: bad.slice(0, 5) },
        });
    }

    /* ── 连通性：不连通通常是选集错（契约默认拒绝） ── */
    const cells = picked.map(p => p.cell);
    const comps = componentsOf(cells);
    if (comps.length > 1 && !opts.allow_scattered) {
        return failure(A, {
            code: "run_not_contiguous", field: sel.uids ? "uids" : "cells",
            message: `选集分成 ${comps.length} 段，4-邻接不连通`,
            hint: "确认选集是不是拼错了；确实要删分散的几段就传 opts.allow_scattered=true"
                + "（返回里会按段分组，便于逐段复核）。",
            detail: { components: comps.map(c => c.slice(0, 8)) },
        });
    }

    /* ── 拓扑后果（只报告，不阻止） ── */
    const wouldDisconnect = analyzeRemoval(c0, picked.map(p => p.uid));
    const consequences = {
        orphaned_outputs: wouldDisconnect.filter(w => w.kind === "orphaned-output"),
        starved_belts: wouldDisconnect.filter(w => w.kind === "starved-belt"),
        starved_machines: wouldDisconnect.filter(w => w.kind === "starved-machine"),
        opaque: wouldDisconnect.filter(w => w.kind === "opaque-neighbour"),
    };

    /* 在途物品：离线拿不到 debug_items。如实报 unknown，不用 0 冒充「没有」。
       （契约的 opts 白名单里没有「传物品数」的位置，所以这里**只**能是 null ——
       要写死这个数就得先读 debug_items，那是执行期的事，不是宏的事。） */
    const strandedItems = null;

    const warnings = [];
    if (wouldDisconnect.length) {
        warnings.push({
            code: "would-disconnect",
            detail: `删除会让 ${wouldDisconnect.length} 处链接断开（orphaned ${consequences.orphaned_outputs.length} / `
                + `starved-belt ${consequences.starved_belts.length} / starved-machine ${consequences.starved_machines.length}）。`
                + "这是**报告的后果，不是拒绝**：L4 的唯一正解就是先删 3 格再插机器。",
            hint: "执行后立刻用 insert_machine / trash_unused 把断点补上；不要停在中间态。",
        });
    }
    if (strandedItems === null) {
        warnings.push({
            code: "stranded-items-unknown",
            detail: "本宏零游戏写操作，拿不到 debug_items；被删带子上的在途物品数无法离线确定",
            hint: "要在计划里写死这个数，执行前用 debug_items 读一次并写进 plan（宏不读世界）。",
        });
    }

    const removed = picked
        .map(p => ({ uid: p.uid, cell: p.cell, type: p.rec.type }))
        .sort((x, y) => byYX(x.cell, y.cell));

    return okResult(A, removed.length, {
        removed,
        would_disconnect: wouldDisconnect,
        consequences,
        stranded_items: strandedItems,
        components: comps.map(c => c.map(x => x.slice())),
        kept: [],                       // remove_run 不保留任何被指名的格
        removed_uids: removed.map(r => r.uid),
        removed_cells: removed.map(r => [r.cell[0], r.cell[1]]),
        // 契约 removals 的可直接落盘形态（expect 必填，来自本次 obs）
        removes: removed.map(r => ({
            uid: r.uid,
            expect: { type: r.type, x: r.cell[0], y: r.cell[1], r: picked.find(p => p.uid === r.uid).rec.r },
        })),
        changed: { added_uids: [], removed_uids: removed.map(r => r.uid) },
    }, warnings);
}

/* ═══════════════════════════════ 4. replace_run ═══════════════════════════════ */

const inRegion = (region, c) => c[0] >= region[0] && c[0] <= region[2] && c[1] >= region[1] && c[1] <= region[3];

/** 区域内每格 → 占用（null=空） */
function scanRegion(region, ctx) {
    const cells = [];
    for (let y = region[1]; y <= region[3]; y++) {
        for (let x = region[0]; x <= region[2]; x++) {
            const occ = ctx.world.cells.get(key(x, y));
            const rec = occ ? ctx.world.byUid.get(occ.uid) : null;
            cells.push({ cell: [x, y], rec });
        }
    }
    return cells;
}

/**
 * 从 region 内的带子推断「这一段的流向」。
 * 权重：入口来自 region 之外的带子/机器 = 2（真正的来料方向），region 内部 = 1。
 * 平票 → null（不猜）。
 */
function inferFlow(regionBelts, region, ctx) {
    const votes = new Map();
    for (const b of regionBelts) {
        const l = inLink(b, ctx);
        let w = 1;
        if (l) {
            if (l.type === "belt" && !inRegion(region, l.cell)) w = 2;
            else if (l.type === "machine") w = 2;
        }
        votes.set(b.exit, (votes.get(b.exit) || 0) + w);
    }
    let best = null, bestN = -1, tie = false;
    for (const d of ORDER) {
        const n = votes.get(d) || 0;
        if (n > bestN) { best = d; bestN = n; tie = false; }
        else if (n === bestN && n > 0) tie = true;
    }
    return bestN > 0 && !tie ? best : null;
}

/** 机器要摆成什么 rotation，才能让它的主输入面接住 flow */
function rotationForFlow(tpl, flow) {
    const inp = (tpl.inputs && tpl.inputs[0]) || null;
    if (inp) {
        for (let s = 0; s < 4; s++) {
            if (rotateLocal(inp.dir, s * 90) === OPP[flow]) return s * 90;
        }
        return null;
    }
    const out = (tpl.outputs && tpl.outputs[0]) || null;
    if (out) {
        for (let s = 0; s < 4; s++) {
            if (rotateLocal(out.dir, s * 90) === flow) return s * 90;
        }
        return null;
    }
    return 0;    // 无输入无输出（trash）：朝向无意义
}

/** 模板槽位的世界格：origin + tile + DIRV[dir] */
const portCellOf = (origin, q) => [origin[0] + q.cell[0] + DIRV[q.dir][0], origin[1] + q.cell[1] + DIRV[q.dir][1]];

function footprintAt(origin, [w, h]) {
    const out = [];
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) out.push([origin[0] + dx, origin[1] + dy]);
    return out;
}

/**
 * 给一台机器在 region 里挑 origin。
 *
 * 打分（越大越好）—— 只体现一条工程判据：**机器必须接在既有货流的断口上**。
 *   · 输入槽对着 region 外的带子（能来料）        +12
 *   · 输入槽对着 region 内的带子（那格将被删）    -12  ← 这是排除"摆反了"的关键
 *   · 输入槽对着空格（会饿死）                    -6
 *   · 输出槽对着 region 外的带子（能续上）        +6
 *   · 输出槽对着 region 内的带子                  +0  （可能就是要让位给 trash）
 * footprint 压到机器 → 整条候选作废（宏永不删机器）。
 */
function scoreOrigin(origin, tpl, region, ctx) {
    const cells = footprintAt(origin, [tpl.__w, tpl.__h]);
    for (const c of cells) {
        if (!inRegion(region, c)) return { invalid: true, why: `footprint 越出 region：${JSON.stringify(c)}`, cell: c };
        const occ = ctx.world.cells.get(keyOf(c));
        if (!occ) continue;
        const rec = ctx.world.byUid.get(occ.uid);
        if (rec && rec.type !== "belt" && rec.type !== "underground_belt") {
            return { invalid: true, why: `footprint 覆盖机器 ${rec.type} uid=${rec.uid}（宏只替换带子）`, cell: c };
        }
    }
    let score = 0;
    for (const q of tpl.inputs || []) {
        const c = portCellOf(origin, q);
        const occ = ctx.world.cells.get(keyOf(c));
        if (!occ) { score -= 6; continue; }
        const rec = ctx.world.byUid.get(occ.uid);
        if (rec.type === "belt") {
            const b = ctx.belts.get(rec.uid);
            if (inRegion(region, c)) score -= 12;
            else score += (b && b.exit === OPP[q.dir]) ? 12 : -4;
        } else if (rec.type === "underground_belt") score -= 3;
        else score += 2;      // 紧贴机器（0 格连接）：允许，交给后验
    }
    for (const q of tpl.outputs || []) {
        const c = portCellOf(origin, q);
        const occ = ctx.world.cells.get(keyOf(c));
        if (!occ) continue;
        const rec = ctx.world.byUid.get(occ.uid);
        if (rec.type === "belt") {
            const b = ctx.belts.get(rec.uid);
            if (!inRegion(region, c) && b && b.entry === OPP[q.dir]) score += 6;
        }
    }
    return { invalid: false, score, cells };
}

/**
 * 给定机器 origin，推演出完整计划并**在计划后的世界里验证**。
 *
 * 「删哪些、放哪些」的算法（这是 replace_run 的核心，任务书要求说清楚）：
 *   1. 放：机器 footprint = origin + [0..w) × [0..h)；
 *      每个 trash 的落点 = 机器某个**被点名**输出槽的**喷口格**（slot + DIRV[dir]），
 *      不是随便挑个空格 —— 偏一格就完全收不到货。
 *   2. 删：region 内**所有被 placed footprint 覆盖的带子**。
 *   3. 留：region 内**没被覆盖**的带子原样保留 —— 这是关键，
 *      L4 的 (5,-14) 必须留下，它是 cutter 右槽唯一的下游。
 *   4. 验：把 plan 应用到世界的副本上，逐端口查链接；冲突按「先机器输入、再机器输出、
 *      再 trash 落点」的**确定序**报第一处。
 *
 * 冲突判定里**不做**的两件事（有意为之，不是遗漏）：
 *   · 不要求 trash 的 4 个输入面全都有货。trash 是 4 边全收的被动建筑，
 *     只有一个面会被喂；要求全喂等于永远拒绝。
 *   · 不阻止「保留下来的带子没供料」。它可能本来就断着，那是如实报告的 warning，
 *     不是本次改造的错（何况删掉它会让 region 内的格数对不上）。
 *
 * @returns {{placed:Array, removed:Array, kept:Array, conflicts:Array}}
 */
function planForOrigin(origin, primary, trashSpecs, region, ctx, spec) {
    const [w, h] = [primary.tpl.__w, primary.tpl.__h];
    const placed = [{
        kind: primary.kind, variant: primary.variant, uid: null,
        origin: [origin[0], origin[1]], rotation: 0,
        cells: footprintAt(origin, [w, h]),
        ports: [
            ...(primary.tpl.inputs || []).map(q => ({
                kind: "accept", role: q.role, index: q.index || 0,
                cell: portCellOf(origin, q), face: rotateLocal(q.dir, 0),
            })),
            ...(primary.tpl.outputs || []).map(q => ({
                kind: "eject", role: q.role, index: q.index || 0,
                cell: portCellOf(origin, q), face: rotateLocal(q.dir, 0),
            })),
        ],
    }];

    const conflicts = [];
    /** 落点上的带子还有下游 ⇒ 接 trash = 把一条活链永久剪断（要求签字，见下方语义闸） */
    const cutsChains = [];

    /* trash 落点 = 被点名输出槽的喷口格（role 已在枚举前校验过，这里是纯几何） */
    for (const t of trashSpecs) {
        const outPorts = primary.tpl.outputs || [];
        const hit = outPorts.filter(q => q.role === t.role);
        if (hit.length !== 1) {
            /* 不该发生：调用方已校验。留一条明确冲突而不是静默跳过。 */
            conflicts.push({
                cell: origin, what: "bad-trash-port",
                why: `trash 的 port="${t.role}" 在推演阶段无法唯一命中（内部不一致）`,
            });
            continue;
        }
        const target = portCellOf(origin, hit[0]);
        if (!inRegion(region, target)) {
            conflicts.push({
                cell: target, what: "trash-outside-region",
                why: `${primary.kind} 的 "${hit[0].role}" 槽喷口在 (${target[0]},${target[1]})，落在 region 之外`,
            });
            continue;
        }
        const occ = ctx.world.cells.get(keyOf(target));
        if (occ) {
            const rec = ctx.world.byUid.get(occ.uid);
            if (rec && rec.type !== "belt" && rec.type !== "underground_belt") {
                conflicts.push({
                    cell: target, what: "trash-occupied",
                    why: `trash 落点 (${target[0]},${target[1]}) 被 ${rec.type} uid=${rec.uid} 占着`,
                });
                continue;
            }
            if (rec && rec.type === "underground_belt") {
                conflicts.push({
                    cell: target, what: "trash-tunnel",
                    why: `trash 落点 (${target[0]},${target[1]}) 是隧道 uid=${rec.uid}`,
                });
                continue;
            }
            /* 「trash 把一条**还在供货的链**剪断」——语义闸（E2E §4 V9 的静默通过）。
               判据是可机器检查的：落点上的带子自己有没有活下游。
                 · 没有下游（死端）→ 接 trash 是收尾，wasteRoles 签字就够；
                 · 有下游 → trash 会把这条链永久切断，比"接一个死路"危险一个量级，
                   即使 role ∈ wasteRoles 也必须签字（confirm_waste）。
               为什么不是"一律拒绝"：L4 的 left 槽正是这种形态（(4,-14)→(4,-15) 还接着
               balancer），而 L4 的正解就是把它销毁 —— 拒绝等于禁止唯一正解。
               所以闸门是**必须为这次剪断签字**，而不是替调用方判断目标形状。 */
            const tb = rec ? ctx.belts.get(rec.uid) : null;
            if (tb) {
                const dn = outLink(tb, ctx);
                if (dn && dn.type === "belt") cutsChains.push({ cell: target, uid: tb.uid, downstream: dn.uid, downstreamCell: dn.cell });
                else if (dn && dn.type === "machine") cutsChains.push({ cell: target, uid: tb.uid, downstream: dn.uid, downstreamCell: dn.cell });
            }
        }
        placed.push({
            kind: "trash", variant: "default", uid: null,
            origin: [target[0], target[1]], rotation: 0,
            cells: [[target[0], target[1]]],
            forPort: { role: hit[0].role, cell: target },
            ports: [],
        });
    }

    /* 删 = 被 placed 覆盖的带子；留 = region 内其余带子 */
    const placedCells = new Map();
    for (const p of placed) for (const c of p.cells) placedCells.set(keyOf(c), p);

    const regionBelts = [];
    for (let y = region[1]; y <= region[3]; y++) {
        for (let x = region[0]; x <= region[2]; x++) {
            const occ = ctx.world.cells.get(key(x, y));
            if (!occ) continue;
            const b = ctx.belts.get(occ.uid);
            if (b && b.x === x && b.y === y) regionBelts.push(b);
        }
    }
    regionBelts.sort((p, q) => byYX([p.x, p.y], [q.x, q.y]));

    const removed = [], kept = [];
    const removedUids = new Set();
    for (const b of regionBelts) {
        if (placedCells.has(key(b.x, b.y))) {
            removed.push({ uid: b.uid, cell: [b.x, b.y], type: "belt" });
            removedUids.add(b.uid);
        } else {
            kept.push({ uid: b.uid, cell: [b.x, b.y] });
        }
    }

    /* 推演 + 验证 */
    const post = ctx.entities.filter(e => !removedUids.has(e.uid));
    const synthUid = p => -(placed.indexOf(p) + 1);
    for (const p of placed) {
        post.push({
            uid: synthUid(p), type: p.kind, variant: p.variant,
            x: p.origin[0], y: p.origin[1], r: 0, rotation_variant: 0, layer: "regular",
        });
    }
    const c1 = makeContext(worldFrom(post, spec), post, spec);

    for (const p of placed) {
        const mrec = c1.machines.get(synthUid(p));
        if (!mrec) continue;
        if (p.kind !== "trash") {
            for (const q of mrec.accept) {
                if (!inLinkOfPort(q, c1)) {
                    conflicts.push({
                        cell: q.slot, what: "unfed-input", uid: p.kind,
                        port: { role: q.role, index: q.index, cell: q.cell },
                        why: `${p.kind} 的输入槽 ${q.role} 在计划执行后没有任何供料方`,
                    });
                }
            }
        }
        for (const q of mrec.eject) {
            if (!outLinkOfPort(q, c1)) {
                conflicts.push({
                    cell: q.cell, what: "orphaned-output", uid: p.kind,
                    port: { role: q.role, index: q.index, cell: q.cell },
                    why: `${p.kind} 的输出槽 ${q.role} 喷口 (${q.cell[0]},${q.cell[1]}) 在计划执行后没有任何去处`,
                });
            }
        }
    }

    /* 相关但非致命的后果：挂在 plan 上，调用方决定要不要当 warning */
    const sideEffects = [];
    for (const k of kept) {
        const kb = c1.belts.get(k.uid);
        if (!kb) continue;
        if (!inLink(kb, c1)) sideEffects.push({ code: "kept-belt-starved", cell: k.cell, uid: k.uid });
        else if (!outLink(kb, c1)) sideEffects.push({ code: "kept-belt-dead-end", cell: k.cell, uid: k.uid });
    }
    for (const r of removed) {
        const rb = ctx.belts.get(r.uid);
        const o = outLink(rb, ctx);
        if (o && o.type === "belt" && !removedUids.has(o.uid)) {
            const ob = c1.belts.get(o.uid);
            if (ob && !inLink(ob, c1)) sideEffects.push({ code: "starved-belt", cell: o.cell, uid: o.uid });
        }
    }

    /* ── 谁能"吃掉"一条链接：新建筑（机器）的槽位 ──
       一条既有带子的出口指向某格时，改造后那一格可能是：
         · 新机器的**输入槽槽格**（合法：货被机器吃进去）→ 不算断
         · 新机器的**机身**（机器没有朝向这一格的输入槽）→ 货被机身吃掉，**真断线**
         · 新机器的输出槽槽格 → 也不会收货（输出槽是喷的）→ 真断线
       后者就是验收报告 §3.5 的 10148@(5,-12) 指向 (5,-13)（cutter 第二个机身格）。
       旧实现只在「被删带子自己的下游是带子」时报 starved-belt，**从不看"谁指向被删格"**，
       于是这条真断线静默消失 —— 打包宏的诊断比 remove_run 的 consequences 还弱。 */
    const removedSet = new Set(removed.map(r => keyOf(r.cell)));
    /* consumed：改造后**由新放的机器**接手的既有带子（机器人 → 带子）。
       这是合法的「接力」，以前被 starved-belt 误报（10144 就是这种形态：
       它原本从被删的 (4,-14) 接货，改造后由新机器的 ejector 供料）。
       判据必须是「供料方是新机器」，不能只是「该格上有个 accept 槽」——
       后者会把闸道/既有机器的既有连接也算进来。 */
    const synthUids = new Set(placed.map(p => synthUid(p)));
    const consumed = [];
    for (const rec of c1.world.byUid.values()) {
        const b = c1.belts.get(rec.uid);
        if (!b || removedUids.has(b.uid)) continue;
        const il = inLink(b, c1);
        if (!il || il.type !== "machine" || !synthUids.has(il.uid)) continue;
        consumed.push({
            kind: "consumed-by-machine", uid: b.uid, cell: [b.x, b.y],
            byMachine: il.uid,
            slot: { role: il.port.role, index: il.port.index, cell: il.port.cell, face: il.port.face },
            why: `(${b.x},${b.y}) uid=${b.uid} 原本从被替换的走线接货，改造后由新机器的输出槽 ${il.port.role} 供料`
                + `（喷口 ${JSON.stringify(il.cell)}）—— 这是接力，不是断线`,
        });
    }

    /* ── 「谁指向被删格」：这一侧以前完全没报（E2E §3.5 的漏报） ──
       判据：某条**保留的**带子 exit 指向的格，被新建筑占用、且那里没有朝它的输入槽。
       这不依赖 removed 是哪条带子，而是按**格子所有权**判 —— 因为吃掉链接的是
       机器的机身，不是某条被删带子。 */
    const cutFeeds = [];
    for (const rec of c1.world.byUid.values()) {
        const b = c1.belts.get(rec.uid);
        if (!b || removedUids.has(b.uid)) continue;               // 只看活下来的带子
        const oc = [b.x + DIRV[b.exit][0], b.y + DIRV[b.exit][1]];
        if (!removedSet.has(keyOf(oc))) continue;                 // 它指向的格没被改造 → 与本次无关
        /* 原世界里它真的接着吗？（避免把"本来就是死路"算成本次后果） */
        const was = outLink(ctx.belts.get(b.uid), ctx);
        if (!was || was.type === "mismatch") continue;
        /* 改造后：目标格上是新建筑。有输入槽朝它 → 接力；否则 → 被机身吃掉 */
        const occ = c1.world.cells.get(keyOf(oc));
        if (!occ) {
            /* 目标格变成空的：下游没了（被删且没东西顶上） */
            cutFeeds.push({
                kind: "orphaned-output", uid: b.uid, cell: [b.x, b.y],
                why: `(${b.x},${b.y}) uid=${b.uid} 的唯一去处 ${JSON.stringify(oc)} 被删且没有新建筑顶替，之后无处可去`,
            });
            continue;
        }
        const owner = c1.world.byUid.get(occ.uid);
        if (!owner) continue;
        /* 合法接力：owner 有一个 accept 槽，它的**带格**正好是本带自己那格，
           且面朝 OPP[本带 exit]（即从这个方向收货）。这才是 F3 的口径。
           （不能用 portAtCell.get(目标格) 判：portAtCell 的键是端口的**带格**，
             对本带而言就是本带自己那格，不是它指向的目标格。） */
        const into = (c1.machines.get(owner.uid) || { accept: [] }).accept
            .find(q => eqCell(q.cell, [b.x, b.y]) && q.face === OPP[b.exit]);
        if (into) continue;                                        // 合法接力
        cutFeeds.push({
            kind: "orphaned-output", uid: b.uid, cell: [b.x, b.y],
            why: `(${b.x},${b.y}) uid=${b.uid} 的出口指向 ${JSON.stringify(oc)}，那里现在被 `
                + `${owner.type} uid=${owner.uid} 的机身占着（没有朝这一格的输入槽）—— 货被机身吃掉`,
            eatenBy: { type: owner.type, uid: owner.uid, cell: [owner.x, owner.y] },
        });
    }

    return { placed, removed, kept, conflicts, sideEffects, consumed, cutFeeds, cutsChains };
}

/**
 * 用**邻居的记录**反推本带子的 entry/exit 面。
 *
 * 为什么不读本带子自己的 rv：`building:"belt"` 路径的全部意义是「rv 可能被游戏算坏了」。
 * 拿坏 rv 算 entry/exit 再反解 rv，等于自证 —— 实测把一个 rv0 改成 rv2 后 0 处 drift（假绿）。
 *
 * 只依赖邻居（它们是独立的观测）：
 *   · 出口面 f ⟺ C+DIRV[f] 的带子**声称自己从 OPP[f]** 收货（它的 entry === OPP[f]）
 *   · 入口面 f ⟺ C+DIRV[f] 的带子**声称自己朝 OPP[f]** 喷货（它的 exit === OPP[f]）
 *   · 邻居是机器时用它的端口面：accept 面 d ⇒ 本格 exit = OPP[d]；eject 面 d ⇒ entry = OPP[d]
 * 只有一侧有证据就如实返回未知（**不猜**，见调用处注释）。
 *
 * @returns {{entry:string|null, exit:string|null, evidence:object}}
 */
export function neighborFaces(belt, ctx) {
    let entry = null, exit = null;
    const evidence = {};
    for (const f of ORDER) {
        const c = [belt.x + DIRV[f][0], belt.y + DIRV[f][1]];
        const occ = ctx.world.cells.get(keyOf(c));
        if (!occ) continue;
        const rec = ctx.world.byUid.get(occ.uid);
        if (!rec) continue;
        if (rec.type === "belt") {
            const nb = ctx.belts.get(rec.uid);
            if (!nb) continue;
            /* 邻居声称从本格收货 ⇒ 本格的出口朝它 */
            if (nb.entry === OPP[f] && exit === null) { exit = f; evidence.exit = { uid: nb.uid, cell: c, why: `邻居 entry=${nb.entry}` }; }
            /* 邻居声称朝本格喷货 ⇒ 本格的入口朝它 */
            if (nb.exit === OPP[f] && entry === null) { entry = f; evidence.entry = { uid: nb.uid, cell: c, why: `邻居 exit=${nb.exit}` }; }
        } else if (rec.type === "underground_belt") {
            evidence.opaque = { cell: c, uid: rec.uid };
        } else {
            const m = ctx.machines.get(rec.uid);
            if (!m) continue;
            const acc = m.accept.find(p => p.face === OPP[f] && keyOf(p.cell) === key(belt.x, belt.y));
            if (acc && exit === null) { exit = f; evidence.exit = { uid: rec.uid, cell: c, why: `机器 accept ${acc.role}` }; }
            const ej = m.eject.find(p => p.face === OPP[f] && eqCell(p.slot, c) && keyOf(p.cell) === key(belt.x, belt.y));
            if (ej && entry === null) { entry = f; evidence.entry = { uid: rec.uid, cell: c, why: `机器 eject ${ej.role}` }; }
        }
    }
    return { entry, exit, evidence };
}

/**
 * `replace_run` — 把 region 里的带子**原位换成建筑**，保持每格 entry/exit 拓扑。
 *
 * 两条路径：
 *   A. `building:"belt"`  → **契约原义**：逐格按邻居反解 (r, rv) 重放（用途：修复被游戏重算坏的 rv）。
 *   B. `building: 机器 | [机器…]` → **本文件的扩展**（见文件头「扩展 1」）：
 *      内部算出「新建筑占哪些格、原来的带子要删哪些」，未被占到的带子**原样保留**。
 *      典型：L4 的 [4,-14,5,-13] 里 4 条带 → cutter 占 2 格、trash 占 1 格、
 *      剩下的 (5,-14) 必须保留（它是 cutter 右槽的下游）。
 *
 * @returns MacroResult + {removed, placed, kept, firstConflict?, reason?, flow, building}
 */
export function replaceRun(a, b) {
    const A = "replace_run";
    let args, ctx;
    if (isObj(a) && (a.region !== undefined || a.building !== undefined)) { args = a; ctx = b || {}; }
    else if (Array.isArray(a) && isObj(b) && b.building !== undefined) { args = b; ctx = arguments[2] || {}; }
    else { args = { region: a, building: b }; ctx = arguments[2] || {}; }

    /* 用契约校验器校验 region / opts / 未知键（building 强制成 "belt" 只为复用检查） */
    const probe = validateReplaceRunArgs({ ...args, building: "belt" });
    if (!probe.ok) {
        return failure(A, {
            ...probe.error,
            hint: probe.error.hint || "region 是闭区间 bbox [x0,y0,x1,y1]，必须与 obs 的既有实体对齐。",
        });
    }
    const region = probe.value.region;
    const dryRun = probe.value.opts.dry_run;

    /* ── building：字符串 | {kind,variant} | 数组（扩展） ── */
    const rawList = Array.isArray(args.building) ? args.building : [args.building];
    if (!rawList.length) {
        return failure(A, {
            code: "missing_field", field: "building",
            message: `${A}.building 不能是空数组`,
            hint: '给一台机器（"cutter"）或一列建筑（["cutter", {kind:"trash", port:"left"}]）。',
        });
    }
    const specs = [];
    for (let i = 0; i < rawList.length; i++) {
        const at = rawList.length > 1 ? `building[${i}]` : "building";
        const x = rawList[i];
        if (typeof x === "string") { specs.push({ kind: x, variant: "default", at }); continue; }
        if (!isObj(x)) {
            return failure(A, {
                code: "bad_type", field: at,
                message: `${at} 必须是字符串或 {kind, variant?, port?, confirm_waste?}`,
                hint: '例如 "cutter" 或 {kind:"trash", port:"left", confirm_waste:true}。',
            });
        }
        for (const k of Object.keys(x)) {
            if (!["kind", "variant", "port", "confirm_waste"].includes(k)) {
                return failure(A, {
                    code: "unknown_field", field: `${at}.${k}`,
                    message: `${at} 不认识键 '${k}'`,
                    hint: `允许：kind, variant, port, confirm_waste。坐标一律不给 —— 落点由 region 与建筑几何内部解。`,
                });
            }
        }
        if (typeof x.kind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(x.kind)) {
            return failure(A, {
                code: "bad_type", field: `${at}.kind`,
                message: `${at}.kind 必须是小写建筑标识`,
                hint: `例如 "cutter"、"trash"；实得 ${JSON.stringify(x.kind)}。`,
            });
        }
        if (x.variant !== undefined && typeof x.variant !== "string") {
            return failure(A, { code: "bad_type", field: `${at}.variant`, message: `${at}.variant 必须是字符串`, hint: "缺省 default。" });
        }
        specs.push({
            kind: x.kind, variant: x.variant === undefined ? "default" : x.variant, at,
            ...(x.port !== undefined ? { port: x.port } : {}),
            confirmWaste: x.confirm_waste === true,
        });
    }

    const spec = loadSpec();
    const c0 = ctxOf(ctx, spec);
    if (!c0) {
        return failure(A, {
            code: "precondition_failed", field: null,
            message: `${A} 需要 ctx.entities（obs 的实体表）`,
            hint: "先 obs，再把 {entities} 作为第二个参数传进来。",
        });
    }

    /* ── region 逐格检查（契约的「框选偏了」检查，保留） ──
       ⚠️ 必须按**机器 footprint** 判，不能按 origin 判：一台 2×1 的 balancer 只有
       origin 那格会在 entities[] 里出现，(x+1,y) 那格在 cells 里也是它的。
       只看 origin 会漏掉「region 框到机器右半格」—— 那正是误删 42 实体的形态。 */
    const scan = scanRegion(region, c0);
    const area = (region[2] - region[0] + 1) * (region[3] - region[1] + 1);
    const machineCells = [];
    {
        const seenM = new Set();
        for (const s of scan) {
            if (!s.rec) continue;
            if (s.rec.type === "belt" || s.rec.type === "underground_belt") continue;
            if (seenM.has(s.rec.uid)) continue;
            seenM.add(s.rec.uid);
            machineCells.push({ cell: s.cell, type: s.rec.type, uid: s.rec.uid });
        }
        /* cells.get() 对 footprint 的非 origin 格返回 isAnchor=false 的记录，
           但 uid 仍是那台机器，所以上面一循环已经覆盖；无需第二遍。 */
    }
    if (machineCells.length) {
        return failure(A, {
            code: "not_a_run", field: "region",
            message: `region 里有 ${machineCells.length} 台机器/hub（整单拒绝）`,
            hint: `第一台：${JSON.stringify(machineCells[0].cell)} 是 ${machineCells[0].type} uid=${machineCells[0].uid}；`
                + `本宏的 footprint 会把整台机器算进去，所以只要碰到一角就拒。`
                + "要动机器请用 removes[] + tx；本宏只替换带子，永不删机器。",
            detail: { offending: machineCells.slice(0, 5) },
        });
    }
    const empties = scan.filter(s => !s.rec);
    const regionBelts = scan.filter(s => s.rec && s.rec.type !== "underground_belt").map(s => c0.belts.get(s.rec.uid));
    const tunnels = scan.filter(s => s.rec && s.rec.type === "underground_belt");

    /* 契约原义（belt 路径）要求「每格都是带子、数量===面积」；扩展路径放宽到「带子或空格」，
       但**仍然拒绝机器**。理由：机器替换时 region 常用来圈一块地，留空是正常的；
       而"框选偏到机器上"才是那次误删 42 个实体的形态，必须继续拦。 */
    if (empties.length && specs.every(s => s.kind === "belt")) {
        return failure(A, {
            code: "precondition_failed", field: "region",
            message: `building="belt" 要求 region 每格都是带子，但有 ${empties.length}/${area} 格是空的`,
            hint: "框选偏了。用 obs 逐格核对后重选；或先 bulk_delete dry_run 看 items 清单。",
            detail: { emptyCells: empties.slice(0, 5).map(e => e.cell) },
        });
    }
    if (!regionBelts.length) {
        return failure(A, {
            code: "precondition_failed", field: "region",
            message: "region 里没有任何带子可替换",
            hint: "先 obs 确认这块地有带子；空地上直接放建筑应该用 insert_machine（本宏不算 footprint 之外的落点）。",
            detail: { emptyCells: empties.slice(0, 5).map(e => e.cell) },
        });
    }
    if (tunnels.length) {
        return failure(A, {
            code: "out_of_scope", field: "region",
            message: `region 里有 ${tunnels.length} 格隧道；隧道是 sender/receiver 成对，v1 不替换`,
            hint: "把隧道排除在 region 外（它需要成对建模）；确需改隧道请人工规划 + tx。",
            detail: { tunnelCells: tunnels.slice(0, 5).map(t => t.cell) },
        });
    }

    /* ══════════ 路径 A：building:"belt"（契约原义：按邻居反解 rv） ══════════ */
    if (specs.length === 1 && specs[0].kind === "belt") {
        /* 显式方向（可选）：见下面 opts.facing 那段注释 */
        const bopts = (probe && probe.value && probe.value.opts) || {};
        const replaced = [];
        const mismatched = [];
        for (const b of regionBelts.slice().sort((x, y) => byYX([x.x, x.y], [y.x, y.y]))) {
            /* ⚠️ 不能用「带子自己记录的 entry/exit」当输入：那两者是**由 rv 算出来的**，
               而这条路径的全部意义就是 rv 可能是坏的。用它反解等于拿坏数据自证 ——
               实测把一个 rv0 改成 rv2 后，旧写法报 0 处 drift（假绿）。
               正确做法：只用**邻居**推本格的面。
                 entry：上游带子的 exit（邻居自己的记录也可能是坏的，但它只影响一格判定）
                        上游机器 eject 的面
                 exit ：下游带子 entry / 下游机器 accept 的面
               某侧没有邻居 ⇒ 该侧未知，用「4 个面里唯一能让 solveTurn 成立的那个」兜底；
               两侧都未知 ⇒ 无法反解，如实报 precondition_failed（不猜）。 */
            let { entry, exit } = neighborFaces(b, c0);
            let want = null;

            /* Explicit direction: when the caller knows the answer, do not force
             * neighbor-inference.
             *
             * Measured on the live world (2026-11-03): of 4 BELT_HANDOFF_REJECTED
             * sites, the model tried replace_run on EVERY one and failed each time:
             *
             *   (1,-17) neighbor evidence is insufficient (entry top / exit unknown)
             *
             * Widening the region to [1,-18 .. 1,-16] does not help either -- as long
             * as that one cell is INCLUDED, it fails. The guard itself is correct (with
             * only one side known, the other side has 3 valid answers, so it is a
             * three-way choice, not a unique one; guessing is wrong). But it makes
             * "fix one belt whose direction is wrong" impossible -- and that is exactly
             * what the model is doing.
             *
             * IMPORTANT: this belt's OWN recorded rv cannot be used as input. entry/exit
             * are DERIVED from rv, so feeding it back is using corrupt data to attest
             * itself (that is the very bug this path exists to fix). So the caller must
             * supply it explicitly, and only on this path.
             *
             * Form: opts.facing = "top" (exit face) or {entry:"left", exit:"top"}.
             * This is a CHOICE (pick a face), not a coordinate -- does not violate V4. */
            if (bopts.facing !== undefined) {
                const FACE_IDX = { top: 0, right: 1, bottom: 2, left: 3 };
                const FACE_NAME = { top: 0, right: 1, bottom: 2, left: 3 };
                const spec = bopts.facing;
                let en = null, ex = null;
                if (typeof spec === "string") {
                    if (!(spec in FACE_IDX)) {
                        return failure(A, {
                            code: "bad_type", field: "opts.facing",
                            message: "opts.facing string form must be top/right/bottom/left, got " + JSON.stringify(spec),
                        });
                    }
                    /* 字符串形态 = 「出口朝这个面」。带子的 entry 永远是 exit 的对面 ——
                     * belt-rules 里没有任何 entry===exit 的合法形态（那是「直穿」，
                     * 不是带子）。所以 entry 由 exit 反推，不是照抄。 */
                    ex = FACE_IDX[spec];
                    en = (ex + 2) % 4;
                } else if (isObj(spec)) {
                    if (spec.exit !== undefined) {
                        if (!(spec.exit in FACE_IDX)) {
                            return failure(A, {
                                code: "bad_type", field: "opts.facing.exit",
                                message: "opts.facing.exit must be top/right/bottom/left, got " + JSON.stringify(spec.exit),
                            });
                        }
                        ex = FACE_IDX[spec.exit];
                    }
                    if (spec.entry !== undefined) {
                        if (!(spec.entry in FACE_IDX)) {
                            return failure(A, {
                                code: "bad_type", field: "opts.facing.entry",
                                message: "opts.facing.entry must be top/right/bottom/left, got " + JSON.stringify(spec.entry),
                            });
                        }
                        en = FACE_IDX[spec.entry];
                    }
                } else {
                    return failure(A, {
                        code: "bad_type", field: "opts.facing",
                        message: "opts.facing must be a string or {entry?, exit?}, got " + JSON.stringify(spec),
                    });
                }
                /* Only entry given => exit is its opposite (straight belt);
                 * only exit given => entry is its opposite. Both given => solve the turn.
                 *
                 * NOTE: solveTurn() returns null when inDir === outDir -- a belt cannot
                 * "pass straight through" in that encoding. So the straight case must be
                 * found with beltEntry/beltExit directly, not via solveTurn. */
                if (en !== null && ex === null) ex = (en + 2) % 4;
                if (ex !== null && en === null) en = (ex + 2) % 4;
                let turn = null;
                for (let rot = 0; rot < 360 && !turn; rot += 90) {
                    for (const rv of [0, 1, 2]) {
                        /* beltEntry/beltExit 返回**方向名**（"top"/"right"/...），不是 0..3 ——
                         * 拿数字比会永远不等。用同一张 FACE 表把名字换回来。 */
                        if (FACE_NAME[beltEntry(rv, rot)] === en && FACE_NAME[beltExit(rv, rot)] === ex) { turn = { rotation: rot, rotationVariant: rv }; break; }
                    }
                }
                if (!turn) {
                    return failure(A, {
                        code: "bad_type", field: "opts.facing",
                        message: "opts.facing entry=" + en + " / exit=" + ex + " does not solve to a legal belt form",
                        hint: "entry == exit means straight; different means one turn. Both must be faces 0..3.",
                    });
                }
                want = turn;
            }
            if (!want && entry && exit && entry !== exit) want = solveTurn(entry, exit);
            /* 只有一侧有独立证据时**不猜**：另一侧可以在 3 个方向里任取一个让 solveTurn 成立，
               那是「三选一」而不是唯一解。用本格自己的 rv 去填等于拿坏数据自证 ——
               正是这条路径要修的病。如实报错，让调用方显式给 rv（paste_blueprint）。 */
            if (!want && !entry && !exit) {
                /* 两侧都没有邻居证据：这一段是「孤立带子」，只在它**自己那一格**上等价于
                   「保持原样」——那没有修复价值，也不算 drift。用原 rv 自证是唯一的解释。 */
                want = { rotation: b.r, rotationVariant: b.rv };
            }
            if (!want) {
                /* ★ 2026-11-02：hint 从「解释」改成「动作」★
                 *
                 * 原来这条写的是：「把 region 缩到『两侧都有可参照邻居』的那几格；
                 * 或对孤立/单侧带子改用 place/paste_blueprint 显式带 rv」。
                 *
                 * 实测（`HINT-AB-RESULT.md`，38 条多轮样本）：它是**最高频的 hint**
                 * （18/38），但模型读完仍然改不对。原因是它要求模型自己判断
                 * 「哪几格两侧都有邻居」——**而 prompt 里没有这个信息**。
                 * 模型看不到邻居关系，只能再猜一次。
                 *
                 * 修法：宏**已经把邻居证据算出来了**（`neighborFaces`），
                 * 直接把「哪些格不能碰、哪些格可以」写成句柄，模型照抄即可。
                 * 这是同一次失败里能立刻重写出来的东西 —— 判据是
                 * 「模型读完能不能不推理就写出一个不同的调用」。
                 *
                 * 句柄从 `ctx` 的实体表取（`b.uid` 已经在手里，邻居 uid 在 evidence 里）。
                 * **不引入坐标**（契约 V4 禁止），只说格数和句柄。 */
                const ev = neighborFaces(b, c0).evidence || {};
                const hasEntry = !!ev.entry, hasExit = !!ev.exit;
                const sideDesc = hasEntry && hasExit ? "两侧都有"
                    : (hasEntry || hasExit) ? "只有一侧有"
                        : "两侧都没有";
                return failure(A, {
                    code: "precondition_failed", field: "region",
                    message: `(${b.x},${b.y}) 的邻居证据不足以反解方向（入口 ${entry || "未知"} / 出口 ${exit || "未知"}）`,
                    hint: `${sideDesc}邻居证据，这一格的方向有 3 种合法解，宏不猜。`
                        + `把这个 uids 从 region 里去掉，或改用 replace_run 的 belt 模式逐格保持原样。`
                        + (hasEntry || hasExit
                            ? `（这一格能参照的邻居是 ${[ev.entry && ev.entry.uid, ev.exit && ev.exit.uid].filter(Boolean).join(" / ")}，`
                            + `但它只给出一侧方向，另一侧仍然三选一。）`
                            : `（这一格四周没有任何带子邻居。）`),
                    detail: { cell: [b.x, b.y], uid: b.uid, entry, exit, evidence: ev },
                });
            }
            if (want.rotation !== b.r || want.rotationVariant !== b.rv) {
                mismatched.push({
                    cell: [b.x, b.y], field: "code",
                    requested: 1 + want.rotationVariant, actual: 1 + b.rv,
                    entry, exit,
                });
            }
            replaced.push({ uid: b.uid, cell: [b.x, b.y], entry, exit, rotation: want.rotation, rotationVariant: want.rotationVariant });
        }
        const warnings = [];
        if (mismatched.length) {
            warnings.push({
                code: "rv-drift",
                detail: `${mismatched.length}/${replaced.length} 格现有 (r,rv) 与邻居反解不符 —— 这正是本路径的用途`,
                hint: "执行 tx 后必须逐格读回 code（1+rv），不等即 verification_failed。",
            });
        }
        return okResult(A, replaced.length * 2, {
            mode: "belt",
            removed: replaced.map(r => ({ uid: r.uid, cell: r.cell, type: "belt" })),
            placed: replaced.map(r => ({
                kind: "belt", variant: "default", uid: null, origin: r.cell, rotation: r.rotation,
                rotationVariant: r.rotationVariant, code: 1 + r.rotationVariant, cells: [r.cell], entry: r.entry, exit: r.exit,
            })),
            kept: [],
            replaced_uids: replaced.map(r => r.uid),
            removed_uids: replaced.map(r => r.uid),
            added_uids: [],
            mismatched,
            flow: null,
            summary: { removed: replaced.length, placed: replaced.length, kept: 0 },
            changed: { added_uids: [], removed_uids: replaced.map(r => r.uid) },
        }, warnings);
    }

    /* ══════════ 路径 B：机器（扩展） ══════════ */
    for (const s of specs) {
        const b = spec.buildings && spec.buildings[s.kind];
        if (!b || !b.variants) {
            return failure(A, {
                code: "unsupported_building", field: `${s.at}.kind`,
                message: `未知建筑 "${s.kind}"`,
                hint: `本存档已知建筑：${Object.keys(spec.buildings).join(", ")}。`,
            });
        }
        if (s.kind === "hub") {
            return failure(A, {
                code: "unsupported_building", field: `${s.at}.kind`,
                message: "hub 不能被 replace_run 放置",
                hint: "hub 是固定目标（16 入口），不参与改造；要接线用 connect 到 hub。",
            });
        }
        if (s.kind === "underground_belt") {
            return failure(A, {
                code: "unsupported_building", field: `${s.at}.kind`,
                message: "隧道需要 sender/receiver 成对建模，v1 范围外",
                hint: "选择 out_of_scope 而不是静默降级 —— 逐格替换隧道会得到一半的隧道。",
            });
        }
        s.tpl = templateByBuildingVariant(s.kind, s.variant);
        if (!s.tpl) {
            return failure(A, {
                code: "unsupported_building", field: `${s.at}.kind`,
                message: `${s.kind}${s.variant !== "default" ? "/" + s.variant : ""} 没有槽位模板，无法计算端口`,
                hint: "只支持 op-templates 里有槽位真值的建筑（cutter/painter/balancer/trash/miner…）。",
            });
        }
        const [w, h] = sizeOf(spec, s.kind, s.variant);
        s.tpl.__w = w; s.tpl.__h = h;
        /* 只有 trash 是「四边全收、朝向无意义」的被动建筑；其余必须能对齐流向 */
        const isPassive = (s.tpl.inputs || []).length >= 4 && (s.tpl.outputs || []).length === 0;
        s.passive = isPassive;
    }

    const machinesSpecs = specs.filter(s => !s.passive);
    const trashSpecs = specs.filter(s => s.passive);
    if (!machinesSpecs.length) {
        return failure(A, {
            code: "precondition_failed", field: "building",
            message: "只给 trash 没有意义：trash 必须接在一台机器的输出槽上",
            hint: '给一台机器 + 它的废料槽，例如 ["cutter", {kind:"trash", port:"left"}]；'
                + "单给一个死路接垃圾桶请用 trash_unused。",
        });
    }
    if (machinesSpecs.length > 1) {
        return failure(A, {
            code: "out_of_scope", field: "building",
            message: `一次只能换入 1 台主动机器（给了 ${machinesSpecs.length} 台）`,
            hint: "拆成多次 replace_run（每次 region 只圈一个断口）；多机器联排需要布局器，不在本宏 v1。",
        });
    }

    const flow = inferFlow(regionBelts, region, c0);
    if (!flow) {
        return failure(A, {
            code: "precondition_failed", field: "region",
            message: "region 内的带子流向不一致，无法决定机器朝向",
            hint: "把 region 缩到**同一段**带子上（断口两侧应同向）；混了拐角或多条线时宏不猜朝向。",
            detail: { belts: regionBelts.map(b => ({ uid: b.uid, cell: [b.x, b.y], entry: b.entry, exit: b.exit })) },
        });
    }

    const primary = machinesSpecs[0];
    const rot = rotationForFlow(primary.tpl, flow);
    if (rot === null) {
        return failure(A, {
            code: "precondition_failed", field: "building",
            message: `${primary.kind} 的槽位几何无法与流向 "${flow}" 对齐`,
            hint: "这台机器的输入/输出面是固定组合，这个方向上摆不出可用的断口；换机器或换 region。",
            detail: { flow, inputs: primary.tpl.inputs, outputs: primary.tpl.outputs },
        });
    }
    if (rot !== 0) {
        return failure(A, {
            code: "out_of_scope", field: "building",
            message: `${primary.kind} 在流向 "${flow}" 下需要 rotation=${rot}，v1 只放 r=0 的机器`,
            hint: "旋转机器的槽位换算仍是 observed 级假设（contract.CAPABILITY_ASSUMPTIONS.rotated_machine_slots）；"
                + "改为把 region/流向安排成 r=0，或人工规划 + tx 并读回自证。",
            detail: { flow, rotation: rot },
        });
    }

    /* ══════════ 先做「建筑参数」的硬校验（与落点无关，所以只做一次） ══════════
       ⚠️ 这一步不能挪进 planForOrigin：那是逐 origin 的几何推演，
       把「trash 没点名废料槽」「没为销毁签字」这类**语义**检查放进去，
       会在某个 origin 恰好几何可行时被静默跳过 —— 那正是 poka-yoke 失效的形态。 */
    for (const t of trashSpecs) {
        const outPorts = primary.tpl.outputs || [];
        if (typeof t.port !== "string") {
            return failure(A, {
                code: "missing_field", field: `${t.at}.port`,
                message: `${t.at} 是 trash，但没有点名 port —— 宏不会猜哪一路是废料`,
                hint: `候选：${outPorts.map(q => `"${q.role}"`).join(" / ")}。`
                    + "选中一路的后果是**永久销毁**；L4 的 RuRu---- 要右列、丢左列，恰好与 wasteRoles（右列）相反，"
                    + "所以这一侧只能由你签字。",
                detail: { candidates: outPorts.map(q => q.role) },
            });
        }
        const hit = outPorts.filter(q => q.role === t.port);
        if (hit.length !== 1) {
            return failure(A, {
                code: hit.length ? "ambiguous_port" : "bad_type", field: `${t.at}.port`,
                message: hit.length
                    ? `${t.at}.port="${t.port}" 命中 ${hit.length} 个输出槽，无法唯一确定`
                    : `${t.at}.port="${t.port}" 不是 ${primary.kind} 的输出槽`,
                hint: `这台机器可用的输出槽：${outPorts.map(q => q.role).join(", ")}。`,
                candidates: outPorts.map(q => ({ role: q.role })),
            });
        }
        t.role = hit[0].role;
        const wasteRoles = primary.tpl.wasteRoles || [];
        if (!wasteRoles.includes(t.role) && !t.confirmWaste) {
            return failure(A, {
                code: "precondition_failed", field: `${t.at}.confirm_waste`,
                message: `${primary.kind} 的 "${t.role}" 槽不在模板 wasteRoles（${wasteRoles.length ? wasteRoles.join(",") : "空"}）里，需要签字`,
                hint: `确认 "${t.role}" 这一路确实是废料后，把 ${t.at} 写成 {kind:"trash", port:"${t.role}", confirm_waste:true}。`
                    + "trash 是永久销毁，签字的目的是让「销毁」这个后果有主；宏查不出目标形状，所以不替你决定。",
                detail: { role: t.role, wasteRoles },
            });
        }
    }

    /* 枚举 origin：footprint 必须整个落在 region 内。
       每个候选都要**完整推演一遍计划后的世界**，因为 trash 的位置依赖机器 origin ——
       只有推演完才知道有没有「输出没去处 / 输入没来料」。 */
    const [w, h] = [primary.tpl.__w, primary.tpl.__h];
    const cands = [];
    for (let y = region[1]; y + h - 1 <= region[3]; y++) {
        for (let x = region[0]; x + w - 1 <= region[2]; x++) {
            const sc = scoreOrigin([x, y], primary.tpl, region, c0);
            if (sc.invalid) continue;
            const plan = planForOrigin([x, y], primary, trashSpecs, region, c0, spec);
            cands.push({ origin: [x, y], score: sc.score, plan });
        }
    }
    if (!cands.length) {
        /* ★ 报错要指出**怎么改**，不只是"不行" ★
         *
         * 2026-10-28 第五轮实测：模型对两条并排链**各调一次** replace_run，
         * 每次 region 只有 1 列宽 ⇒ 2×1 的 cutter 放不下 ⇒ 这里报 occupied。
         * 而原来的 hint 写的是「扩大到覆盖断口两侧」—— 那句话对"分两次调用"这个
         * 真实病因完全没帮助，模型只会把同一个 1 列 region 再扩大一点点。
         *
         * 现在把最可能的病因直接说出来：region 太窄，把并排的另一列也框进来。 */
        return failure(A, {
            code: "occupied", field: "region",
            message: `${primary.kind}(${w}×${h}) 在 region 里没有任何合法落点（会压到机器或越界）`,
            hint: w >= 2
                ? `region 至少要 ${w} 格宽、${h} 格高，且那一片不含机器。`
                    + `**最常见的原因：你想改的两条链是并排的，但只框了一条。**`
                    + `把并排的另一条链的句柄也放进同一次调用的 region（例如 $path_of([...链A, ...链B])），`
                    + `而不是分两次调用 —— 分开调每次只有 1 列宽，${w}×${h} 的机器放不进去。`
                : `region 至少要有 ${w}×${h} 的连续带子/空格，且不含机器；扩大到覆盖断口两侧。`,
            detail: { region, footprint: [w, h], occupied_by_machine: true },
        });
    }
    /* 先要「推演无冲突」的，再按 score；都冲突时取冲突最少的那个来讲诊断 */
    cands.sort((p, q) => (p.plan.conflicts.length - q.plan.conflicts.length)
        || (q.score - p.score) || byYX(p.origin, q.origin));
    const pick = cands[0];

    if (pick.plan.conflicts.length) {
        const fc = pick.plan.conflicts[0];
        const hintByWhat = {
            "unfed-input": "region 挑的位置接不到来料。把 region 向**上游**扩一格，让这台机器的输入面正对"
                + "一条 region 外的带子（宏会自己算出哪一格）。",
            "orphaned-output": "这台机器有输出没去处。在 building 里加 {kind:\"trash\", port:\"<role>\", confirm_waste:true} "
                + "收掉它，或把 region 扩到覆盖它喷口外侧那条带子。",
            "trash-outside-region": "废料槽的喷口在 region 外。region 必须包含「机器 footprint + 各废料槽喷口格」——"
                + "宏已算出那一格，扩 region 就行。",
            "trash-occupied": "废料槽的喷口格被机器占着。trash 必须正好在喷口格（4 边全收 ≠ 位置无关），"
                + "先腾开或换一个输出槽。",
        };
        return failure(A, {
            code: "precondition_failed", field: "region",
            message: fc.why,
            hint: hintByWhat[fc.what] || "调整 region / building 后重试。",
            detail: { firstConflict: fc, tried: cands.length },
        }, { firstConflict: fc, flow, building: primary.kind, requested_dry_run: dryRun });
    }

    const { placed, removed, kept, conflicts: _ig, consumed, cutFeeds } = pick.plan;
    void _ig;

    /* ── 语义闸：trash 想剪断一条**还在供货的链** → 必须签字 ──
       放在硬校验段之后、挑定 origin 之后：它不是几何问题，不该逐 origin 重复判断。
       E2E §4 V9 实测：trash 指到 right（模板默认废料侧）会删掉 10150，而 10150 下游
       还接着 10151 —— 旧实现只发一条 kept-belts，几乎静默通过。静默的数据损失必须被拒。 */
    /* ── 语义闸：trash 落点上的带子**还有下游** ⇒ 必须签字（E2E §4 V9 的静默通过）──
       为什么不是"一律拒绝"：L4 的 left 槽正是这种形态（(4,-14)→(4,-15) 还接着 balancer），
       而 L4 的正解就是把它销毁 —— 拒绝等于禁止唯一正解。所以闸门是「必须签字」，
       而不是替调用方判断目标形状。
       为什么 confirm_waste 够用：它现在的语义被收紧成「我知道这会永久销毁**这条带子的下游**」。
       旧实现里它对 role ∈ wasteRoles 的调用是免签的，于是 V9（trash 指 right，
       删掉仍在供货的 10150）只发一条 kept-belts 就通过 —— 静默的数据损失。 */
    const planCuts = pick.plan.cutsChains || [];
    if (planCuts.length && !trashSpecs.every(t => t.confirmWaste)) {
        const cut = planCuts[0];
        return failure(A, {
            code: "precondition_failed", field: `${trashSpecs[0].at}.confirm_waste`,
            message: `trash 会剪断一条**仍在供货**的链：喷口格 ${JSON.stringify(cut.cell)} 上的带子 uid=${cut.uid} `
                + `还有下游 ${cut.downstream}${cut.downstreamCell ? `@(${cut.downstreamCell[0]},${cut.downstreamCell[1]})` : ""}`,
            hint: "**怎么改：在 building 里那台 trash 上写 `confirm_waste: true`。** 例如 "
                + '`building: [{kind:"cutter"}, {kind:"trash", port:"right", confirm_waste:true}]`。'
                + "confirm_waste 是**一次签字覆盖两层后果**：① 这一侧是废料；② 即使该 role ∈ 模板 wasteRoles、"
                + "即使喷口格上的带子还有下游，也确认要永久销毁。"
                + "接 trash 是永久销毁一条活链，比「接一个死路」危险一个量级，所以不可省。"
                + `本次会剪：${planCuts.map(c => `${c.uid}→${c.downstream}`).join(", ")}。`,
            detail: { cuts: planCuts },
        }, { flow, building: primary.kind });
    }

    /* ── consequences：与 remove_run 同一口径（缺陷 2）──
       remove_run 报的是「删了哪些链接」；replace_run 是「删 + 放」，所以还要多一档
       `consumed_by_machine`（上游被新机器吃进去 = 合法接力，不该报成断线）。
       以前 replace_run 只给 sideEffects（kept/starved），**从不报"谁指向被删格"**，
       于是 E2E 那条 10148@(5,-12)→(5,-13)（cutter 第二格机身）静默消失。 */
    const consequences = {
        orphaned_outputs: cutFeeds,
        starved_belts: pick.plan.sideEffects.filter(s => s.code === "starved-belt")
            .map(s => ({ kind: "starved-belt", uid: s.uid, cell: s.cell,
                why: `uid=${s.uid}@(${s.cell[0]},${s.cell[1]}) 原本从被替换的走线接货，改造后再没有供料方` })),
        starved_machines: [],
        consumed_by_machine: consumed,
        opaque: [],
    };

    const warnings = [];
    if (primary.tpl.verifiedOnLive === false) {
        warnings.push({
            code: "variant-unverified",
            detail: `${primary.kind}/${primary.variant} 的槽位映射未实机验证（op-templates.verifiedOnLive=false）`,
            hint: "执行后必须用 debug_items 读回该机器的 boundAcceptor，不等即失败。",
        });
    }
    if (kept.length) {
        warnings.push({
            code: "kept-belts",
            detail: `${kept.length} 格带子在 region 内但没被任何新建筑占到，**原样保留**：`
                + kept.map(k => `${k.uid}@(${k.cell[0]},${k.cell[1]})`).join(", "),
            hint: "这是设计：region 里不是所有带子都该删。执行前请逐条确认它们确实该留下。",
        });
    }
    /* 谁指向被改造的格：以前完全静默（E2E §3.5）。现在必须浮到 warnings，
       因为这是**真断线**（货被机身吃掉），不是"可能"的副作用。 */
    if (cutFeeds.length) {
        warnings.push({
            code: "cut-upstream-feeds",
            detail: `${cutFeeds.length} 条既有带子的出口指向本次改造的格，而那里现在是机身（不是输入槽）——`
                + `货会被机身吃掉：${cutFeeds.map(c => `${c.uid}@(${c.cell[0]},${c.cell[1]})→${JSON.stringify((c.eatenBy || {}).cell || [])}`).join(", ")}`,
            hint: "这是 remove_run 的 orphaned_outputs 在打包宏里的等价物。"
                + "要么把 region/机器朝向改到让那一侧成为输入槽，要么把这些带子一起纳入改造（会真删货流）。",
        });
    }
    if (consumed.length) {
        warnings.push({
            code: "consumed-by-machine",
            detail: `${consumed.length} 条既有带子的出口正好落在新机器的输入槽槽格上 —— 这是接力，不是断线`,
            hint: "不需要处理；这条 warning 的存在是为了让「断线」与「接力」在日志里可区分。",
        });
    }
    for (const p of placed) {
        if (p.kind !== "trash") continue;
        const served = (placed.find(x => x.kind !== "trash") || {}).ports || [];
        const q = served.find(x => x.role === p.forPort.role);
        if (q && !eqCell(q.cell, p.origin)) {
            warnings.push({
                code: "internal-trash-offset",
                detail: `trash 落点 ${JSON.stringify(p.origin)} 与输出槽喷口 ${JSON.stringify(q.cell)} 不一致`,
                hint: "这是宏的 bug（trash 偏一格就完全收不到货），请报告。",
            });
        }
    }
    /* 已签字剪断活链 ⇒ 如实回报（用户签了字不等于可以不留痕） */
    if (planCuts.length) {
        warnings.push({
            code: "trash-cuts-chain",
            detail: `confirm_waste 已签字：trash 会永久销毁仍在供货的 ${planCuts.map(c =>
                `uid=${c.uid}@(${c.cell[0]},${c.cell[1]}) →${c.downstream}`).join(", ")}`,
            hint: "这是目标形状要求的销毁；执行后这些下游（含在途物品）不复存在，必须进 plan 的 destroys。",
        });
    }

    /* 契约的 first_mismatch 只在「逐格读回不符」时非空；这里是计划态，故恒 null。 */
    const extras = {
        mode: "machine",
        flow,
        removed,
        placed: placed.map(p => ({
            ...p,
            cells: p.cells.map(c => c.slice()),
            /* 每台新建筑都带**计划态引用**（E2E 缺陷 1）：下游宏可以拿
               `r.placed[i].pending` 直接当 outlet，不必等 tx 落盘 + 重读 obs。 */
            pending: {
                pending: true,
                token: `replace_run:${p.kind}@${p.origin[0]},${p.origin[1]}`,
                macro: "replace_run", kind: p.kind, variant: p.variant,
                rotation: p.rotation || 0,
                origin: [p.origin[0], p.origin[1]],
                cells: p.cells.map(c => [c[0], c[1]]),
                ports: {
                    /* planForOrigin 的 q.cell 已经是**带格**（slot + DIRV[face]），
                       与 machineGeometry 的约定一致；slot 要反推回来。 */
                    in: (p.ports || []).filter(q => q.kind === "accept")
                        .map(q => ({ role: q.role, index: q.index || 0,
                            slot: [q.cell[0] - DIRV[q.face][0], q.cell[1] - DIRV[q.face][1]],
                            cell: q.cell.slice(), dir: q.face, face: q.face })),
                    out: (p.ports || []).filter(q => q.kind === "eject")
                        .map(q => ({ role: q.role, index: q.index || 0,
                            slot: [q.cell[0] - DIRV[q.face][0], q.cell[1] - DIRV[q.face][1]],
                            cell: q.cell.slice(), dir: q.face, face: q.face })),
                },
                uid: null,
            },
        })),
        kept,
        sideEffects: pick.plan.sideEffects,
        consequences,
        firstConflict: null,
        building: primary.kind,
        summary: { removed: removed.length, placed: placed.length, kept: kept.length },
        removed_uids: removed.map(r => r.uid),
        added_uids: [],                       // 计划态没有真实 uid（由 tx 分配）
        removes: removed.map(r => ({
            uid: r.uid,
            expect: { type: "belt", x: r.cell[0], y: r.cell[1], r: c0.world.byUid.get(r.uid).r },
        })),
        changes: placed.reduce((s, p) => s + p.cells.length, 0),
        changed: { added_uids: [], removed_uids: removed.map(r => r.uid) },
        /* 「没要求 dry-run」≠「已写入」（缺陷 3）。dry_run 恒 true（本宏零写），
           调用方的意图单列，名字自解释。 */
        requested_dry_run: dryRun,
    };
    return okResult(A, removed.length + placed.reduce((s, p) => s + p.cells.length, 0), extras, warnings);
}

/* ═══════════════════════════════ 5. trash_unused ═══════════════════════════════ */

/**
 * `trash_unused` — 给一个**没有去处**的输出槽接垃圾桶。
 *
 * outlet 两种形态（「扩展 2」，见文件头）：
 *   · { uid | cell, port? }  指向**机器**：port 缺省 auto（该机器恰好 1 个 ejector 才合法）
 *   · { uid | cell }         指向**一段带子**：它的 exit 就是 outlet（无下游才可以接）
 *
 * 安全检查（一条都不放宽）：
 *   · 该槽当前必须**没有接收方**（有 → port_already_bound，绝不抢别人的货）
 *   · 落点必须**正好**是喷口格（偏一格就完全收不到货 —— trash 4 边全收 ≠ 位置无关）
 *   · 落点被机器/hub 占 → occupied；被带子占 → 只有 opts.replace_belt=true 才让位
 *   · role ∉ 模板 wasteRoles → 必须 opts.confirm_waste=true（为「永久销毁」签字）
 *
 * @returns MacroResult + {trashCell, outletPort, replaced_belt_uid?, trash:{…}}
 */
export function trashUnused(a, b) {
    const A = "trash_unused";
    let args, ctx;
    if (isObj(a) && (a.outlet !== undefined || a.opts !== undefined)) { args = a; ctx = b || {}; }
    else { args = { outlet: a, opts: b }; ctx = arguments[2] || {}; }

    const v = validateTrashUnusedArgs(args);
    if (!v.ok) {
        return failure(A, {
            ...v.error,
            hint: v.error.hint || "outlet 指向一台机器（{uid, port?}）或一段带子（{uid}）。",
        });
    }
    const { outlet, opts } = v.value;

    const spec = loadSpec();
    const c0 = ctxOf(ctx, spec);
    if (!c0) {
        return failure(A, {
            code: "precondition_failed", field: null,
            message: `${A} 需要 ctx.entities（obs 的实体表）`,
            hint: "先 obs，再把 {entities} 作为第二个参数传进来。",
        });
    }

    /* ── 解析 outlet → 实体 ── */
    let rec = null;
    /* 计划态引用（E2E 缺陷 1 的正解）：上一个宏（insert_machine / replace_run）刚规划、
       **还没落盘**的实体。它不在世界里，但它自带槽位世界格 —— 对 trash_unused 来说，
       「该槽有没有接收方 / 喷口哪一格」全部可以从这份几何算出来。
       这条路径是「宏能组合」的关键：调用方不必先 tx + 重读 obs 才能给机器挂垃圾桶。 */
    if (outlet.pending !== undefined) {
        const p = outlet.pending;
        const ejects = p.ports.out.map(q => ({
            kind: "eject", role: q.role, index: q.index, slot: q.slot.slice(),
            cell: q.cell.slice(), vel: q.face, face: q.face, uid: null,
        })).sort((a, b) => byYX(a.cell, b.cell) || cmpStr(a.role, b.role));
        if (!ejects.length) {
            return failure(A, {
                code: "endpoint_not_a_port", field: "outlet.pending",
                message: `${p.kind}（计划态）没有 ejector（输出槽）`,
                hint: `这台 ${p.kind} 只收不产。trash 接的是**源**；给它挂垃圾桶没有意义。`,
            });
        }
        let port = null;
        const sel = outlet.port;
        if (sel === "auto" || sel === undefined) {
            if (ejects.length === 1) port = ejects[0];
            else {
                return failure(A, {
                    code: "ambiguous_port", field: "outlet.port",
                    message: `${p.kind}（计划态）有 ${ejects.length} 个输出槽，auto 不足以确定`,
                    hint: `点名其中一个：${ejects.map(x => `"${x.role}"`).join(" / ")}。`,
                    candidates: ejects.map(x => ({ role: x.role, index: x.index, cell: x.cell })),
                });
            }
        } else if (typeof sel === "string") {
            const hit = ejects.filter(x => x.role === sel);
            if (hit.length === 1) port = hit[0];
            else {
                return failure(A, {
                    code: hit.length ? "ambiguous_port" : "bad_type", field: "outlet.port",
                    message: hit.length
                        ? `port="${sel}" 在这台计划态机器上命中 ${hit.length} 个输出槽`
                        : `port="${sel}" 不是 ${p.kind}（计划态）的输出槽`,
                    hint: `可用角色：${ejects.map(x => x.role).join(", ")}。`,
                    candidates: ejects.map(x => ({ role: x.role, index: x.index, cell: x.cell })),
                });
            }
        } else if (sel && isInt(sel.entry)) {
            port = ejects[sel.entry] || null;
            if (!port) {
                return failure(A, {
                    code: "bad_type", field: "outlet.port.entry",
                    message: `entry=${sel.entry} 越界（0..${ejects.length - 1}）`,
                    hint: "entry 是出口槽的确定序索引（先 y 再 x）。",
                });
            }
        } else if (sel && typeof sel.role === "string") {
            port = ejects.filter(x => x.role === sel.role)[sel.index] || null;
            if (!port) {
                return failure(A, {
                    code: "bad_type", field: "outlet.port",
                    message: `{role:"${sel.role}",index:${sel.index}} 在计划态机器上不存在`,
                    hint: `可用角色：${ejects.map(x => x.role).join(", ")}。`,
                });
            }
        }
        /* 喷口格：世界里有东西就不能放（世界是**当前世界**，不含本 pending 自己） */
        const target = [port.cell[0], port.cell[1]];
        const occ0 = c0.world.cells.get(keyOf(target));
        if (occ0) {
            const oRec = c0.world.byUid.get(occ0.uid);
            /* 那格上的带子**是不是正从这台（计划态）机器接货**？
               entry === OPP[槽面] ⇔ 它朝机器���货。是 ⇒ port_already_bound（绝不抢）；
               不是 ⇒ 只是占位（occupied），replace_belt 才让位。 */
            const ob = oRec && oRec.type === "belt" ? c0.belts.get(oRec.uid) : null;
            if (ob && ob.entry === OPP[port.face]) {
                return failure(A, {
                    code: "port_already_bound", field: "outlet.port",
                    message: `计划态 ${p.kind} 的 "${port.role}" 喷口格已经有带子 uid=${ob.uid} 接货`,
                    hint: `这条带子是从这台机器接货的下游，不是废料。要真销毁它先 remove_run({uids:[${ob.uid}]})，`
                        + "并确认这一路确实是废料。本宏绝不抢既有货流。",
                    detail: { boundTo: ob.uid, target },
                });
            }
            if (oRec && oRec.type === "belt") {
                if (!opts.replace_belt) {
                    return failure(A, {
                        code: "occupied", field: "outlet.port",
                        message: `计划态 ${p.kind} 的 "${port.role}" 喷口格 ${JSON.stringify(target)} 被带子 uid=${oRec.uid} 占着`,
                        hint: `该带子不是从这台机器接货（机器还没落地）。传 opts.replace_belt=true 让 trash 顶掉它，`
                            + `或先 remove_run({uids:[${oRec.uid}]})。`,
                        detail: { target, beltUid: oRec.uid },
                    });
                }
            } else {
                return failure(A, {
                    code: "occupied", field: "outlet.port",
                    message: `计划态 ${p.kind} 的 "${port.role}" 喷口格 ${JSON.stringify(target)} 被 ${oRec ? oRec.type : occ0.type} 占着`,
                    hint: "trash 必须正好在喷口格（4 边全收 ≠ 位置无关）。",
                    detail: { target },
                });
            }
        }
        const tplP = templateByBuildingVariant(p.kind, p.variant);
        const wasteP = (tplP && tplP.wasteRoles) || [];
        if (!wasteP.includes(port.role) && !opts.confirm_waste) {
            return failure(A, {
                code: "precondition_failed", field: "opts.confirm_waste",
                message: `${p.kind} 的 "${port.role}" 槽不在模板 wasteRoles（${wasteP.length ? wasteP.join(",") : "空"}）里`,
                hint: `确认 "${port.role}" 这一路确实是废料后传 opts.confirm_waste=true。`,
                detail: { role: port.role, wasteRoles: wasteP },
            });
        }
        return okResult(A, 1, {
            trashCell: target,
            outletPort: { kind: "pending-eject", uid: null, role: port.role, index: port.index, cell: target, dir: port.face },
            replaced_belt_uid: null,
            trash: { kind: "trash", cell: target, forPort: { uid: null, role: port.role, index: port.index } },
            /* 组合链的关键：trash 也是计划态，下游/执行器按同一个 token 体系认领 */
            pending: {
                pending: true, token: `trash_unused:trash@${target[0]},${target[1]}`,
                macro: A, kind: "trash", variant: "default", rotation: 0,
                origin: [target[0], target[1]], cells: [[target[0], target[1]]],
                ports: { in: [], out: [] }, uid: null,
            },
            changed: { added_uids: [], removed_uids: [] },
        }, []);
    }

    if (outlet.uid !== undefined) {
        rec = c0.world.byUid.get(outlet.uid) || null;
    } else if (outlet.cell !== undefined) {
        const occ = c0.world.cells.get(keyOf(outlet.cell));
        rec = occ ? (c0.world.byUid.get(occ.uid) || null) : null;
        if (rec && !eqCell(cellOf(rec), outlet.cell)) rec = null;   // cell 必须是 origin
    } else if (outlet.hub) {
        return failure(A, {
            code: "endpoint_not_a_port", field: "outlet.hub",
            message: "hub 只收不产，没有 ejector 可以接 trash",
            hint: "方向搞反了：trash 接的是**源**。要往 hub 里送货请用 connect。",
        });
    }
    if (!rec) {
        return failure(A, {
            code: "endpoint_not_found", field: "outlet",
            message: `outlet ${outlet.uid !== undefined ? `uid=${outlet.uid}` : `cell=${JSON.stringify(outlet.cell)}`} 不在当前世界`,
            hint: "重新 obs 后取新的 uid（uid 不会复活）。注意 cell 形态必须正好是实体 origin。",
        });
    }

    /* ── 情况 1：带子末端（扩展 2） ── */
    if (rec.type === "belt") {
        const b = c0.belts.get(rec.uid);
        const target = [b.x + DIRV[b.exit][0], b.y + DIRV[b.exit][1]];
        const o = outLink(b, c0);
        if (o && o.type === "belt") {
            return failure(A, {
                code: "port_already_bound", field: "outlet",
                message: `带子 uid=${b.uid} 的出口已经有下游 (${o.cell[0]},${o.cell[1]}) uid=${o.uid}`,
                hint: "绝不抢既有货流。要改道先 remove_run 那段，再用 connect 接到你想要的地方；"
                    + "确实要在这个槽销毁就先拆下游。",
                detail: { boundTo: o.uid },
            });
        }
        if (o && o.type === "mismatch") {
            return failure(A, {
                code: "precondition_failed", field: "outlet",
                message: `带子 uid=${b.uid} 的出口那一格有带子 uid=${o.uid}，但它的 entry 不朝这条带子`,
                hint: "两格带子没有接上（拓扑错位）。先 obs 复核这两格，别在错位上再叠一个 trash。",
                detail: { neighbour: o.uid },
            });
        }
        if (o && o.type === "opaque") {
            return failure(A, {
                code: "out_of_scope", field: "outlet",
                message: `带子 uid=${b.uid} 的出口对着隧道 uid=${o.uid}`,
                hint: "隧道的吞吐无法离线判定；请用 debug_items 看这条路径的 bnd 后再决定。",
            });
        }
        if (o && o.type === "machine") {
            return failure(A, {
                code: "port_already_bound", field: "outlet",
                message: `带子 uid=${b.uid} 的出口已经接进机器 uid=${o.uid} 的输入槽`,
                hint: "这条带子不是死路。真要销毁那台机器的这一路，应该拆机器输出侧，不是在这里塞 trash。",
                detail: { boundTo: o.uid },
            });
        }
        const occ = c0.world.cells.get(keyOf(target));
        if (occ && occ.type !== "belt" && occ.type !== "underground_belt") {
            return failure(A, {
                code: "occupied", field: "outlet",
                message: `带子 uid=${b.uid} 的出口格 ${JSON.stringify(target)} 被 ${occ.type} uid=${occ.uid} 占着`,
                hint: "trash 必须正好落在出口格；先腾开那格（机器不能删，换方向或换出口）。",
                detail: { target },
            });
        }
        if (occ && occ.type === "underground_belt") {
            return failure(A, {
                code: "out_of_scope", field: "outlet",
                message: `带子 uid=${b.uid} 的出口格是隧道 uid=${occ.uid}`,
                hint: "隧道不能像带子一样让位；先人工处理隧道。",
                detail: { target },
            });
        }
        return okResult(A, 1, {
            trashCell: target,
            outletPort: { kind: "belt-exit", uid: b.uid, role: "belt", index: 0, cell: target, dir: b.exit },
            replaced_belt_uid: null,
            trash: { kind: "trash", cell: target, forBelt: b.uid },
            changed: { added_uids: [], removed_uids: [] },
            dry_run: true,     // 本宏零写操作
        }, []);
    }

    if (rec.type === "underground_belt") {
        return failure(A, {
            code: "out_of_scope", field: "outlet",
            message: "隧道不能直接接 trash（sender/receiver 的方向语义与带子不同）",
            hint: "先确认隧道的接收端（receiver）在哪，再对接收端下游的带子用本宏。",
        });
    }
    if (rec.r !== 0) {
        return failure(A, {
            code: "out_of_scope", field: "outlet",
            message: `${rec.type} uid=${rec.uid} rotation=${rec.r}；v1 只处理 r=0 的机器端口`,
            hint: "旋转机器的槽位换算仍是 observed 级假设；需要时人工规划 + tx，并用 debug_items 读回自证。",
        });
    }

    /* ── 情况 2：机器输出槽 ── */
    const m = c0.machines.get(rec.uid);
    if (!m || !m.eject.length) {
        return failure(A, {
            code: "endpoint_not_a_port", field: "outlet",
            message: `${rec.type} uid=${rec.uid} 没有 ejector（输出槽）`,
            hint: "trash 接的是源。hub/trash 只收不产；要往它们里送货用 connect。",
        });
    }
    const ejects = m.eject;
    let port = null;
    if (outlet.port === "auto" || outlet.port === undefined) {
        if (ejects.length === 1) port = ejects[0];
        else {
            return failure(A, {
                code: "ambiguous_port", field: "outlet.port",
                message: `${rec.type} uid=${rec.uid} 有 ${ejects.length} 个输出槽，auto 不足以确定`,
                hint: `点名其中一个：${ejects.map(p => `"${p.role}"`).join(" / ")}。`
                    + "多输出机器（cutter 2 / cutter-quad 4）选错边会把产品销毁 —— 所以这里不猜。",
                candidates: ejects.map(p => ({ role: p.role, index: p.index, cell: p.cell })),
            });
        }
    } else if (typeof outlet.port === "string") {
        const hit = ejects.filter(p => p.role === outlet.port);
        if (hit.length === 1) port = hit[0];
        else if (hit.length > 1) {
            return failure(A, {
                code: "ambiguous_port", field: "outlet.port",
                message: `port="${outlet.port}" 在这台机器上命中 ${hit.length} 个输出槽`,
                hint: `用 {role:"${outlet.port}",index:N} 消歧；候选见 candidates。`,
                candidates: hit.map(p => ({ role: p.role, index: p.index, cell: p.cell })),
            });
        } else {
            return failure(A, {
                code: "bad_type", field: "outlet.port",
                message: `port="${outlet.port}" 不是 ${rec.type} 的输出槽`,
                hint: `可用角色：${ejects.map(p => p.role).join(", ")}。`,
                candidates: ejects.map(p => ({ role: p.role, index: p.index })),
            });
        }
    } else if (outlet.port && isInt(outlet.port.entry)) {
        const p = ejects[outlet.port.entry];
        if (!p) {
            return failure(A, {
                code: "bad_type", field: "outlet.port.entry",
                message: `entry=${outlet.port.entry} 越界（0..${ejects.length - 1}）`,
                hint: "entry 是本宏输出的确定序索引（先 y 再 x），不是 hub 的入口号。",
            });
        }
        port = p;
    } else if (outlet.port && typeof outlet.port.role === "string") {
        const hit = ejects.filter(p => p.role === outlet.port.role);
        const p = hit[outlet.port.index];
        if (!p) {
            return failure(A, {
                code: "bad_type", field: "outlet.port",
                message: `{role:"${outlet.port.role}",index:${outlet.port.index}} 不存在（该角色有 ${hit.length} 个）`,
                hint: `可用角色：${ejects.map(p2 => p2.role).join(", ")}。`,
                candidates: hit.map(p2 => ({ role: p2.role, index: p2.index })),
            });
        }
        port = p;
    }

    /* 绝不抢：该槽已经有接收方 */
    const bound = boundBeltOf(port, c0);
    if (bound) {
        return failure(A, {
            code: "port_already_bound", field: "outlet.port",
            message: `输出槽 ${port.role}#${port.index} 已经有带子 uid=${bound.uid} 接货`,
            hint: `先 remove_run({uids:[${bound.uid}]}) 拆掉那条，确认它确实该空转，再接 trash；`
                + "或者把货接到别处（connect）。本宏绝不抢既有货流。",
            detail: { boundTo: bound.uid },
        });
    }

    /* 落点 = 喷口格，一格都不能偏 */
    const target = [port.cell[0], port.cell[1]];
    const occ = c0.world.cells.get(keyOf(target));
    let replacedBeltUid = null;
    if (occ) {
        const oRec = c0.world.byUid.get(occ.uid);
        if (oRec && oRec.type === "belt") {
            if (!opts.replace_belt) {
                return failure(A, {
                    code: "occupied", field: "outlet",
                    message: `喷口格 ${JSON.stringify(target)} 被带子 uid=${oRec.uid} 占着`,
                    hint: `该带子并没有接这个槽（entry 不朝它）。传 opts.replace_belt=true 让 trash 顶掉它，`
                        + `或先 remove_run({uids:[${oRec.uid}]})。`,
                    detail: { target, beltUid: oRec.uid },
                });
            }
            replacedBeltUid = oRec.uid;
        } else if (oRec && oRec.type !== "underground_belt") {
            return failure(A, {
                code: "occupied", field: "outlet",
                message: `喷口格 ${JSON.stringify(target)} 被 ${oRec.type} uid=${oRec.uid} 占着`,
                hint: "trash 必须正好在喷口格（4 边全收 ≠ 位置无关）。机器不能删，换个输出槽或先改造那里。",
                detail: { target },
            });
        } else if (oRec && oRec.type === "underground_belt") {
            return failure(A, {
                code: "out_of_scope", field: "outlet",
                message: `喷口格 ${JSON.stringify(target)} 是隧道 uid=${oRec.uid}`,
                hint: "隧道不能像带子一样让位；先人工处理隧道。",
                detail: { target },
            });
        }
    }

    /* wasteRoles：不在里面就必须签字 */
    const tpl = templateByBuildingVariant(rec.type, rec.variant);
    const wasteRoles = (tpl && tpl.wasteRoles) || [];
    if (!wasteRoles.includes(port.role) && !opts.confirm_waste) {
        return failure(A, {
            code: "precondition_failed", field: "opts.confirm_waste",
            message: `${rec.type} 的 "${port.role}" 槽不在模板 wasteRoles（${wasteRoles.length ? wasteRoles.join(",") : "空"}）里`,
            hint: `确认 "${port.role}" 这一路确实是废料后传 opts.confirm_waste=true。`
                + "注意 wasteRoles 只是半切场景的约定（右列），L4 的 RuRu---- 恰好要右列、丢左列 —— "
                + "目标形状决定哪侧是废料，宏查不出目标，只能要求你签字。",
            detail: { role: port.role, wasteRoles },
        });
    }

    const warnings = [];
    if (replacedBeltUid !== null) {
        warnings.push({
            code: "replacing-belt",
            detail: `opts.replace_belt=true：喷口格上的带子 uid=${replacedBeltUid} 会被销毁，必须纳入 tx 回滚`,
            hint: "执行后该槽的产物永久消失；这条警告要进 plan 的 destroys。",
        });
    }
    return okResult(A, 1, {
        trashCell: target,
        outletPort: { kind: "eject", uid: rec.uid, role: port.role, index: port.index, cell: target, dir: port.vel },
        replaced_belt_uid: replacedBeltUid,
        trash: { kind: "trash", cell: target, forPort: { uid: rec.uid, role: port.role, index: port.index } },
        changed: { added_uids: [], removed_uids: replacedBeltUid === null ? [] : [replacedBeltUid] },
        dry_run: true,     // 本宏零写操作
    }, warnings);
}

/* ==========================================================================
 * remove_machine -- 删掉一台机器（hub 除外）
 *
 * ## 为什么需要这个宏
 *
 * 真机实测（2026-11-03，level 5 / 目标 Cu----Cu）：
 *
 *   · 世界里有 4 台矿机，接在**铜切割机**上的那台 @(4,-16) 脚下**没有矿**
 *     （7x7 邻域一格都没有）=> 它永久零产出，整条铜线因此从来没跑起来；
 *   · 它同时**占着 cutter 的输入口**（cutter 在 (4,-17)，输入槽朝下）；
 *   · 模型想放新矿机到铜矿上、再把铜接进 cutter，但：
 *       - insert_machine 在那一格报 blocked_by_machine（机器永不让位）；
 *       - connect 的路径被 trash @(3,-18) 和 rotater @(5,-18) 挡住，
 *         而且**删掉 trash 之后还是撞 rotater** -- 整片产线堵死；
 *       - 把 max_cells 提到 3000 也一样：connect 在**第一处冲突就放弃**，
 *         它不做绕路搜索（CONNECT-OCCUPIED-DIAGNOSIS.md）。
 *
 * 也就是说：**没有任何宏能移除一台挡路的机器**，而这一步是这个 level 的必经之路。
 * remove_run 明确只处理带子（"要删机器是另一个动作"），但那个"另一个动作"
 * 一直没被实现出来。
 *
 * ## 与 remove_run 的差异（都是有意的）
 *
 *   remove_run      : 只允许带子；有连通性检查；报 orphaned outputs / starved belts
 *   remove_machine  : 只允许机器；无连通性检查；报 starved 下游机器；hub 永不可删
 *
 * ## 安全边界
 *
 * · **hub 永远不可删** -- 它是目标计数的唯一去处，删了这一局就废了；
 * · 只接受 uid（不接受坐标）-- 与 remove_run 的 uids 通道同一口径；
 * · 若这台机器**正在给下游供料**，默认拒绝并说清楚会饿死谁。
 *   要拆就得显式传 opts.allow_unwired=true。
 *
 * @param {object|Array} a  {uids, opts?} 或 uid 数组
 * @param {object} [b]      ctx {entities}
 */

/** 可以删的机器种类（hub 与带子都不在此列，各走各的规则）。 */
const REMOVABLE_MACHINE_TYPES = new Set([
    "miner", "cutter", "rotater", "stacker", "mixer", "painter", "balancer", "trash",
]);

export function removeMachine(a, b) {
    const A = "remove_machine";
    let args, ctx;
    if (Array.isArray(a)) {
        args = { uids: a, opts: isObj(b) ? b : undefined };
        ctx = {};
    } else if (isObj(a)) {
        args = a; ctx = b || {};
    } else {
        return failure(A, {
            code: "bad_type", field: null,
            message: A + " 的入参必须是 {uids, opts?} 或一个 uid 数组",
            hint: "uid 来自 obs.entities[].uid，例如 remove_machine({uids:[10553]})。",
        });
    }
    // 位置形态：removeMachine({uids}, ctx)
    if (isObj(b) && Array.isArray(b.entities)) ctx = b;

    const uids = args && Array.isArray(args.uids) ? args.uids : null;
    const opts = (args && isObj(args.opts)) ? args.opts : {};
    if (!uids || !uids.length) {
        return failure(A, {
            code: "missing_field", field: "uids",
            message: A + " 需要非空的 uids 数组",
            hint: "先 obs 拿到机器的 uid；hub 的 uid 不可删。",
        });
    }
    for (const u of uids) {
        if (!Number.isInteger(u) || u <= 0) {
            return failure(A, {
                code: "bad_type", field: "uids",
                message: "uids 里只能是正整数 uid，实得 " + JSON.stringify(u),
            });
        }
    }

    const spec = loadSpec();
    const c0 = ctxOf(ctx, spec);
    if (!c0) {
        return failure(A, {
            code: "precondition_failed", field: null,
            message: A + " 需要 ctx.entities（obs 的实体表）才能把 uid 解析成机器",
            hint: "先 obs，再把 {entities} 作为第二个参数传进来；本宏不读世界、也不猜。",
        });
    }

    /* -- 解析选集：每一条都必须是一台**可删的机器** -- */
    const picked = [];   // {uid, cell, rec, type}
    const bad = [];
    for (const uid of uids) {
        const rec = c0.world.byUid.get(uid);
        if (!rec) { bad.push({ uid, why: "不在当前世界（obs 过期或已被删）" }); continue; }
        if (rec.type === "hub") { bad.push({ uid, why: "hub 不可删", immutable: true, cell: cellOf(rec) }); continue; }
        if (rec.type === "belt" || rec.type === "underground_belt") {
            bad.push({ uid, why: "解析到 " + rec.type + "（带子请用 remove_run）", cell: cellOf(rec) });
            continue;
        }
        if (!REMOVABLE_MACHINE_TYPES.has(rec.type)) {
            bad.push({ uid, why: "类型 " + rec.type + " 不在可删清单里", cell: cellOf(rec) });
            continue;
        }
        picked.push({ uid, cell: cellOf(rec), rec, type: rec.type });
    }

    if (bad.length) {
        const immutable = bad.filter(x => x.immutable);
        if (immutable.length) {
            return failure(A, {
                code: "immutable", field: "uids",
                message: "选集里有 hub（uid=" + immutable.map(x => x.uid).join(",") + "）-- hub 永不可删",
                hint: "hub 是目标计数的唯一去处。删了它这一局就终结了。",
                detail: { offending: immutable },
            });
        }
        const belts = bad.filter(x => /带子请用 remove_run/.test(x.why));
        if (belts.length) {
            return failure(A, {
                code: "not_a_machine", field: "uids",
                message: "选集里有 " + belts.length + " 个是带子（本宏只删机器）",
                hint: "第一个：uid=" + belts[0].uid + " " + belts[0].why + "。整单拒绝，不「尽量删」。",
                detail: { offending: belts.slice(0, 5) },
            });
        }
        const missing = bad.filter(x => /不在当前世界/.test(x.why));
        if (missing.length) {
            return failure(A, {
                code: "endpoint_not_found", field: "uids",
                message: missing.length + "/" + bad.length + " 个 uid 在当前世界不存在：" + missing.slice(0, 5).map(x => x.uid).join(", "),
                hint: "重新 obs 再用**新的** uid 重写选集；uid 不会复活，同坐标可能已经是别的东西。",
                candidates: missing.slice(0, 5).map(x => x.uid),
            });
        }
        return failure(A, {
            code: "precondition_failed", field: "uids",
            message: "选集有 " + bad.length + " 个无法解析的项",
            hint: "先 obs 再重选。",
            detail: { bad: bad.slice(0, 8) },
        });
    }

    /* -- 拓扑后果：拆掉它们会让谁断供？ --
     *
     * ⚠️ `analyzeRemoval` 在这里用不上：它第一行就是 `const b = ctx.belts.get(uid)`
     *    然后 `if (!b) continue` —— 它只处理**带子**的删除。机器要单独判。
     *
     * 直接用现成的 `outLinkOfPort(q, ctx)`：它就是这个语义的既有实现
     * （输出口这一格上连了什么：带子 / 紧贴的机器 / 隧道）。重复实现一遍
     * 端口几何只会多一个错的地方 —— 上面第一次尝试就写错了（用了 `q.outCell`，
     * 那个字段不存在；又自己算 `q.cell + DIRV[q.face]`，而 `outLinkOfPort`
     * 早就把「accept 的 cell 是从哪格收货」这条规则处理掉了）。
     *
     * 只报**机器**被饿死；连到带子的情况由 `remove_run` 的
     * starved-belt 负责 —— 这里不重复报告同一条链。 */
    const removedUidSet = new Set(picked.map(p => p.uid));
    const starved = [];
    for (const p of picked) {
        const m = c0.machines && c0.machines.get(p.uid);
        if (!m) continue;
        for (const q of (m.eject || [])) {
            let link = null;
            try { link = outLinkOfPort(q, c0); } catch { link = null; }
            if (!link || link.type !== "machine") continue;
            if (!link.uid || link.uid === p.uid) continue;
            if (removedUidSet.has(link.uid)) continue;   // 一起删的不算「饿死」
            starved.push({ machine: p.uid, feeds: link.uid, cell: q.cell });
        }
    }

    /* 默认拒绝对"正在供料"的机器下手 -- 那等于悄悄剪断下游。 */
    if (starved.length && opts.allow_unwired !== true) {
        return failure(A, {
            code: "would_starve",
            field: "uids",
            message: "要删的 " + picked.length + " 台机器里有 " + new Set(starved.map(s => s.machine)).size
                + " 台正在给下游供料，删了会饿死 " + new Set(starved.map(s => s.feeds)).size + " 个下游",
            hint: "先接好替代供料，或确认确实要拆时传 opts.allow_unwired=true。"
                + "本宏宁可失败，也不静默剪断别人的上游。",
            detail: { starved: starved.slice(0, 8) },
        });
    }

    /* -- 成功：返回删除计划（本宏零写操作，落盘由 tx 执行） -- */
    const removed = picked.map(p => ({ uid: p.uid, type: p.type, cell: p.cell, origin: p.cell }));
    return {
        ok: true, macro: A,
        cells_planned: picked.length, cells_placed: picked.length,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: picked.map(p => p.uid) },
        warnings: (starved.length && opts.allow_unwired === true)
            ? [{
                code: "starves_downstream", severity: "warn", macro: A,
                what: "显式允许拆掉正在供料的机器，" + new Set(starved.map(s => s.feeds)).size + " 个下游会断供",
                action: "确认这是有意的；接好替代供料后再拆更安全。",
            }]
            : [],
        error: null,
        dry_run: opts.dry_run !== false,
        planned_only: true,
        reason: "ok",
        removed, placed: [], kept: [], would_disconnect: [],
        consequences: { orphaned_outputs: [], starved_belts: [], starved_machines: [], opaque: [] },
    };
}

/* ═══════════════════════════════ 6. 宏注册（供 MCP / loop 层按名调用） ═══════════════════════════════ */

export const MACRO_IMPLS = Object.freeze({
    remove_run: removeRun,
    remove_machine: removeMachine,
    replace_run: replaceRun,
    trash_unused: trashUnused,
});
