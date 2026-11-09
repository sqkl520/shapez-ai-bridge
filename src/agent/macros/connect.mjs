/**
 * connect.mjs — 宏：从 A 的 ejector 连一条带到 B 的 acceptor，**中间每一格坐标/旋转/rv 全部内部算**。
 *
 * ═════════════════════════ 角色定位（DIRECTION-FINAL 阶段 1）═════════════════════════
 * LLM 是**改稿人**，不是算数的人。调用方只给两个端点（uid 来自 obs），
 * 不给任何坐标、不给转角、不给 rv。路径的形状选择（直线 / L / Z）、Z 在哪条腿拐、
 * 每格用哪个 rv，全部在本文件里定，并且**返回里如实说明选了哪一种**。
 *
 * 学术依据：
 *   · PAL / CodeAct（RESEARCH-B）：把计算卸载给程序；
 *   · LLM 网格推理随规模掉 42.7%（RESEARCH-A §4）；
 *   · 我们自己的 L4 43 实体事故：13 个朝向全反（L4-PLAN-A-REVIEW）。
 *
 * ═════════════════════════ 几何权威 ═════════════════════════
 * 方向逻辑**一行都不自己写**：一律 `belt-rules.mjs` 的 solveTurn / beltEntry / beltExit / beltCode。
 * 本文件只做「哪几格、往哪走」的算术（坐标加减），不做「局部方向如何旋转」的判断。
 *
 * ═════════════════════════ 关键几何事实（实测，不是推理）═════════════════════════
 * 【F1】相邻两格带的闭合关系是  exit(a) === OPP[entry(b)]，**不是** exit(a) === entry(b)。
 *       实测 161 条真实带子 / 146 对相邻：OPP 口径 145/146 成立，直连口径 **0/146**。
 *       唯一例外 (-2,-3) 是 T 型侧向汇入（两条上游进同一格），不是几何错。
 *       推导：带子的 entry 面是货流**进来**的那一面，故「货流速度」= OPP[entry]；
 *       a 以 exit(a) 方向射出，走到 b 的入口面所在的那一边 = OPP[exit(a)]。
 *       本文件的 `verifyChain()` 用的就是正确口径，并附带一条**负例**证伪「全反」事故形态。
 * 【F2】机器 footprint 原点 = obs 的 (x,y) = **左上角**，向 +x/+y 展开。
 *       对 181 个实体的全部 footprint 展开：重叠 0 处（另两种原点口径分别踩 7 处 / 3 处）。
 * 【F3】端口→带格：ejector/acceptor 的 slot 格 + DIRV[dir]。
 *       ejector：带子 entry = OPP[dir]（带子朝机器接货）——实机 14/14 成立；
 *       acceptor：带子 exit  = OPP[dir]（带子朝机器喷射）——实机 12/12 成立。
 * 【F4】belt-rules.solveTurn 对 12 种 (in,out) 组合穷举：无 null 遗漏、**每种恰好 1 解**；
 *       只有「反向」无解（exit === OPP[entry] 以外的 180° 掉头被拒绝）。
 *
 * ═════════════════════════ 契约 ═════════════════════════
 * 入参按 `contract.mjs` 的 `validateConnectArgs()`：
 *   connect({ from: Endpoint, to: Endpoint, opts? }, ctx)      ← 契约形态（推荐）
 *   connect(from, to, opts, ctx)                               ← 位置形态（任务书口径，等价）
 *
 *   Endpoint = { uid } | { cell:[x,y] } | { hub:{ entry:0..15 } }   + 可选 port
 *   port     = "auto"（缺省，候选唯一才合法）| 角色名 | {role,index} | {entry:0..15}
 *   opts     = { rebind?, allow_replace?, max_cells?, prefer?, dry_run? }（白名单见契约）
 *   ctx      = { entities: obs.entities, spec? }   ← 世界（只读）
 *
 * 返回 = 契约 MacroResult（{ok, macro, cells_planned, cells_placed, first_mismatch, changed,
 *        warnings, error, dry_run}）**外加**本宏的诊断字段：
 *        { cells, reason, firstConflict, pathLen, choice, strategy }
 *
 * ⚠️ 本宏**零游戏写操作**：它只规划并自证几何闭合。落盘由调用方（tx / place）执行。
 *    `cells_placed` 的口径 = **通过了内部逐格自证**（solveTurn 反解后重新读回比对）的格数，
 *    不是"已在游戏里读到"。真实读回自证属于阶段 2 的 verifyRuntime。
 *
 * 离线自测：node src/agent/macros/connect.mjs --self-test
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 唯一方向权威 —— 本文件**不得**再写任何方向旋转逻辑
import { ORDER, OPP, DIRV, beltEntry, beltExit, solveTurn, beltCode, rotateLocal } from "../../ai/belt-rules.mjs";
import { hubEntriesWorld, templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { validateConnectArgs, validateMacroResult } from "./contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(HERE, "../../ai/machine-spec.json");

/* ═══════════════════════════════ 0. 小工具 ═══════════════════════════════ */

const isInt = n => typeof n === "number" && Number.isInteger(n);
const key = (x, y) => `${x},${y}`;

/** 顺时针 90°（ORDER=[top,right,bottom,left] 是顺时针序，y 向下） */
const RIGHT = { top: "right", right: "bottom", bottom: "left", left: "top" };
/** 逆时针 90° */
const LEFT = { top: "left", left: "bottom", bottom: "right", right: "top" };

/** 两格位移 → 方位名（要求共边相邻） */
function dirBetween(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const d of ORDER) if (DIRV[d][0] === dx && DIRV[d][1] === dy) return d;
    return null;
}

/** 位移在方位 d 上的有符号投影（d 必须是轴对齐方位） */
const proj = (disp, d) => disp[0] * DIRV[d][0] + disp[1] * DIRV[d][1];

let _spec = null;
/** machine-spec.json 是 footprint / 端口几何的真值（按需加载，避免 import 期 I/O） */
function loadSpec() {
    if (_spec === null) {
        _spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
    }
    return _spec;
}

function variantOf(spec, type, variant) {
    const b = spec.buildings && spec.buildings[type];
    if (!b || !b.variants) return null;
    return b.variants[variant] || b.variants.default || Object.values(b.variants)[0] || null;
}

/* ═══════════════════════════════ 1. 世界模型（只读） ═══════════════════════════════ */

/**
 * 从 obs.entities 建只读世界：占用图 + 实体索引 + 每台机器的端口表。
 *
 * 端点解析、占用检查、端口枚举都走这里。**不写任何东西**。
 *
 * @param {Array<{uid:number,type:string,x:number,y:number,r?:number,rotation_variant?:number,layer?:string,variant?:string}>} entities
 * @param {object} [spec]
 */
export function buildWorld(entities, spec = loadSpec()) {
    if (!Array.isArray(entities)) throw new TypeError("buildWorld(entities) 需要 obs.entities 数组");
    const cells = new Map();      // "x,y" → {uid, type, isAnchor}
    const byUid = new Map();
    const byOrigin = new Map();

    for (const e of entities) {
        if (!e || typeof e !== "object") continue;
        if (!isInt(e.x) || !isInt(e.y)) continue;
        if (e.layer !== undefined && e.layer !== "regular") continue;   // v1 单层
        const v = variantOf(spec, e.type, e.variant);
        const [w, h] = (v && Array.isArray(v.size)) ? v.size : [1, 1];
        const rec = {
            uid: e.uid, type: e.type, x: e.x, y: e.y,
            r: e.r === undefined ? 0 : e.r,
            rv: e.rotation_variant === undefined ? 0 : e.rotation_variant,
            variant: e.variant || "default",
            w, h,
        };
        byUid.set(rec.uid, rec);
        byOrigin.set(key(rec.x, rec.y), rec);
        /* ★ 展开时必须考虑旋转 ★
           2×1 的机器在 r=90/270 时，第二格在 (x, y+1)，不是 (x+1, y)。
           游戏自己的 `getTileSpaceBounds()` 就是按 rotation 算的；
           朴素地用 `x+dx, y+dy` 只对 r=0 成立。
           当前存档里 8 台多格机器恰好都是 r=0（实测重叠数 0），
           所以这个 bug 一直没暴露 —— 但只要出现一台 r≠0 的 balancer 就会占错格，
           让 connect 以为某格空着、实际有机器。

           旋转规则（与游戏 Vector.rotateFastMultipleOf90 一致，y 向下）：
             r=0   : (dx, dy) → ( dx,  dy)
             r=90  : (dx, dy) → (-dy,  dx)
             r=180 : (dx, dy) → (-dx, -dy)
             r=270 : (dx, dy) → ( dy, -dx)
           原点（dx=dy=0）恒映射到自身，所以 origin 不变。 */
        const rot = ((rec.r % 360) + 360) % 360;
        for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
                let ox = dx, oy = dy;
                if (rot === 90) { ox = -dy; oy = dx; }
                else if (rot === 180) { ox = -dx; oy = -dy; }
                else if (rot === 270) { ox = dy; oy = -dx; }
                const k = key(rec.x + ox, rec.y + oy);
                if (!cells.has(k)) {
                    cells.set(k, { uid: rec.uid, type: rec.type, isAnchor: dx === 0 && dy === 0 });
                }
            }
        }
    }
    return { cells, byUid, byOrigin, entities: entities.slice() };
}

/** 世界模型缓存：同一 entities 数组引用只建一次（离线批量跑用例时省掉 O(n²)） */
const worldCache = new WeakMap();
function worldFor(ctx) {
    if (!ctx) return null;
    if (ctx.cells && ctx.byUid) return ctx;                       // 已经是 world
    let ents = ctx.entities;
    if (ents && !Array.isArray(ents) && Array.isArray(ents.entities)) ents = ents.entities;  // obs 整体
    if (!Array.isArray(ents)) return null;
    let w = worldCache.get(ents);
    if (!w) { w = buildWorld(ents, ctx.spec || loadSpec()); worldCache.set(ents, w); }
    return w;
}

/* ═══════════════════════════════ 2. 端口枚举 ═══════════════════════════════ */

/**
 * 端口**槽位**真值（tile + dir）。只有两个来源，且都不是第二套端口逻辑：
 *
 *   ① 带子：方向**必须**由 `beltExit(rv, r)` / `beltEntry(rv, r)` 算。
 *      spec 是静态 JSON，`belt.ejectors[0].dir = "top"` / `belt.acceptors[0].dir = "bottom"`
 *      只是 **(r=0, rv=0)** 的快照；带子的真实方向随 4 种 r × 3 种 rv 变化，
 *      spec 没有「按 r/rv 推导」的表达能力，改 spec 只能写死另一种、仍然会错。
 *      实测（2026-11-01，34 条真实带子）：21 条出口被算错，r≠0 的 17/19 错；
 *      唯一「碰巧对」的是 (r=90, rv=1) —— 恰好 `beltExit(1,90)="top"` 与 spec 相同，
 *      所以既有测试（只测 r=0）全绿。错的那 21 条让 `connect` 以错误起点搜索，
 *      842 条候选全部落到错误位置。
 *
 *   ② 其余实体：仍然逐字段读 spec —— v1 不支持旋转机器，静态值即真值。
 *
 * 默认 `dir`（r=0, rv=0 时）两侧完全一致：`beltExit(0,0)="top"`、`beltEntry(0,0)="bottom"`，
 * 所以这不是「改全表」，只是给带子补上随旋转变化的那一维。
 *
 * ⚠️ `underground_belt` **故意**不走这条：它的 `rotation_variant` 是 sender/receiver 位，
 *    不是弯带的「直/左弯/右弯」，`beltExit(1,0)="left"` 套上去就是错的
 *    （见 `loop/topology.test.mjs` 事实 1）。隧道真正的槽位在 spec 的
 *    `rotationVariantSlots`，且连接语义还需要处理成对 portal —— 那是独立特性，不在本修复范围。
 *
 * @returns {{ejectors:Array, acceptors:Array}|null}
 */
function portSlots(rec, spec) {
    if (rec.type === "belt") {
        const rv0 = rec.rv === undefined ? 0 : rec.rv;
        /* 带子只有 rv 0/1/2（belt.js:25-43）。越界值不静默算出垃圾方位，退回直带。 */
        const rv = (rv0 === 0 || rv0 === 1 || rv0 === 2) ? rv0 : 0;
        const r = rec.r === undefined ? 0 : rec.r;
        return {
            ejectors: [{ tile: [0, 0], dir: beltExit(rv, r) }],
            acceptors: [{ tile: [0, 0], dir: beltEntry(rv, r) }],
        };
    }
    const v = variantOf(spec, rec.type, rec.variant);
    if (!v) return null;

    /* ★ r≠0 的机器：spec 里的 ejectors/acceptors 是 **(r=0, rv=0) 的快照** ★
     *
     * 这份数据来自静态 JSON（machine-spec），只有 tile+dir，**不含旋转**。
     * 原来这里直接把快照原样返回，所以 r≠0 的机器端口全错 ——
     * 调用方（`machinePorts`）发现对不上，干脆在 r≠0 时返回空端口表。
     *
     * 真机后果（2026-11-09，L6）：铜线 `CuCuCuCu → cut → rotate → Cu----Cu`
     * 直达 hub，缺最后那道 cut右。要补的 cutter 只能插在这条**往下流**的线上
     * ⇒ 需要 r=180 ⇒ 端口表为空 ⇒ `replace_run` 永远报「输入槽没有供料方」。
     * level 6 的 `Cu270` 一件都产不出来。
     *
     * 修法：按旋转规则（与游戏 `rotateFastMultipleOf90` 一致，y 向下）转 tile 与 dir。
     *   r=90  : (dx,dy) → (-dy,dx)
     *   r=180 : (dx,dy) → (-dx,-dy)
     *   r=270 : (dx,dy) → (dy,-dx)
     * 方向用既有的 `rotateLocal`（belt-rules 的唯一真值）。 */
    const r = rec.r || 0;
    if (r === 0) return { ejectors: v.ejectors, acceptors: v.acceptors };

    const rotCell = ([dx, dy]) => {
        switch (((r % 360) + 360) % 360) {
            case 90: return [-dy, dx];
            case 180: return [-dx, -dy];
            case 270: return [dy, -dx];
            default: return [dx, dy];
        }
    };
    const rotList = (list) => (Array.isArray(list) ? list : []).map(s => ({
        ...s,
        tile: rotCell(s.tile || [0, 0]),
        dir: rotateLocal(s.dir, r),
    }));
    return { ejectors: rotList(v.ejectors), acceptors: rotList(v.acceptors) };
}

/**
 * 一台实体的端口表。每个端口给出：
 *   · slot  = 实体自己那一格（acceptors/ejectors 的 tile）
 *   · cell  = 带子该占的那一格 = slot + DIRV[dir]
 *   · vel   = 货流在**带子上**的方向
 *               ejector: vel = dir（实体沿 dir 喷出）
 *               acceptor: vel = OPP[dir]（带子朝实体喷，即反向冲进去）
 *   · face  = 实体的那一面（acceptors/ejectors 的 dir）
 * 依据 F3（实机 14/14 + 12/12）。
 *
 * ⚠️ 带子的 dir 不是静态值 —— 见 `portSlots()` 的说明（r/rv ≠ 0 时必须由 belt-rules 推导）。
 *
 * `accept.vel` 的语义是「接进来的带子上的货流方向」（= 朝本实体喷），**不是**本带的入口面。
 * 三条独立证据：F3 的「acceptor 带子 exit = OPP[dir]」、`mk()` 的 `vel = OPP[face]`、
 * 以及 `connect` 把它当 `candidateShapes(..., E, vE)` 的 `vE`（末格出货方向）。
 */
export function portsOf(rec, spec) {
    const out = { eject: [], accept: [] };
    /* r≠0 的机器**可以**有端口 —— 见 `portSlots` 里的旋转推导。
       这里原有一条 `if (rec.r !== 0 && !ROTATION_FREE.has(rec.type)) return out;`
       把加工机器的 r≠0 一律当"无端口"，那等于禁止一切旋转的加工机器。 */

    if (rec.type === "hub") {
        // hub 入口表**只**来自 op-templates.hubEntriesWorld（裁决 K1）—— 索引顺序也是它定的
        hubEntriesWorld([rec.x, rec.y]).forEach((e, i) => {
            const vel = ORDER[Math.round((((e.dir % 360) + 360) % 360) / 90) % 4];
            out.accept.push({
                kind: "accept", role: "primary", index: i,
                // acceptor 的带格 = slot + DIRV[face]，vel = OPP[face] ⇒ slot = cell + DIRV[vel]
                slot: [e.cell[0] + DIRV[vel][0], e.cell[1] + DIRV[vel][1]],
                cell: [e.cell[0], e.cell[1]],
                vel, face: e.face,
            });
        });
        return out;
    }

    const slots = portSlots(rec, spec);
    if (!slots) return out;

    /* 角色名真值 = op-templates（contract.PORT_FORMS 的枚举就是它：primary/secondary/
       left/right/lower/upper/shape/color/out）。spec 的 acceptor/ejector 只有 tile+dir+filter，
       没有 role，所以按 (tile,dir) 去模板里配；配不上才退化到合成的 out/in<i>。 */
    const tpl = templateByBuildingVariant(rec.type, rec.variant);
    const roleAt = (list, tile, dir) => {
        if (!Array.isArray(list)) return null;
        const hit = list.find(s => s && Array.isArray(s.cell) && s.cell[0] === tile[0] && s.cell[1] === tile[1] && s.dir === dir);
        return hit && typeof hit.role === "string" ? hit.role : null;
    };

    const mk = (kind, list) => {
        const arr0 = Array.isArray(list) ? list.slice() : [];
        // 确定序：先 y 再 x，同格多面按 ORDER 方位序 —— 角色名/索引必须可复现
        arr0.sort((a, b) => (a.tile[1] - b.tile[1]) || (a.tile[0] - b.tile[0]) || (ORDER.indexOf(a.dir) - ORDER.indexOf(b.dir)));
        const tplList = kind === "eject" ? (tpl && tpl.outputs) : (tpl && tpl.inputs);
        const raw = arr0.map((s, i) => {
            const [tx, ty] = s.tile;
            const slot = [rec.x + tx, rec.y + ty];
            const face = s.dir;
            const vel = kind === "eject" ? face : OPP[face];
            const role = roleAt(tplList, [tx, ty], face)
                || (arr0.length === 1 ? (kind === "eject" ? "out" : "primary") : (kind === "eject" ? "out" : "in") + i);
            return { kind, role, slot, cell: [slot[0] + DIRV[face][0], slot[1] + DIRV[face][1]], vel, face };
        });
        /* index 必须按**同一角色内**编号（contract.PORT_FORMS 写的是 "{role,index}：
           角色重复时按 index 消歧"）。曾经用全局序号，于是 {role:"secondary",index:1}
           永远找不到 —— 多输出机器的第二个口连不上。 */
        const seen = new Map();
        return raw.map((p) => {
            const n = seen.get(p.role) || 0;
            seen.set(p.role, n + 1);
            return { ...p, index: n };
        });
    };
    out.eject = mk("eject", slots.ejectors);
    out.accept = mk("accept", slots.acceptors);
    return out;
}

/** 端口选择器 → 唯一端口。语义按 contract.PORT_FORMS。 */
function selectPort(list, sel, kindWord, field) {
    if (!list.length) return { ok: false, code: "endpoint_not_a_port", message: `${field} 指向的实体没有${kindWord}` };
    if (sel === undefined || sel === "auto") {
        if (list.length === 1) return { ok: true, port: list[0] };
        return {
            ok: false, code: "ambiguous_port",
            message: `${field} 有 ${list.length} 个${kindWord}，必须显式给 port`,
            candidates: list.map(p => ({ role: p.role, index: p.index, cell: p.cell })),
        };
    }
    if (typeof sel === "string") {
        const hit = list.filter(p => p.role === sel);
        if (hit.length === 1) return { ok: true, port: hit[0] };
        if (hit.length > 1) return { ok: false, code: "ambiguous_port", message: `${field}.port="${sel}" 命中 ${hit.length} 个，需 {role,index}`, candidates: hit.map(p => ({ role: p.role, index: p.index, cell: p.cell })) };
        return { ok: false, code: "bad_type", message: `${field}.port="${sel}" 不是合法角色`, candidates: list.map(p => ({ role: p.role, index: p.index })) };
    }
    if (sel && typeof sel === "object" && isInt(sel.entry)) {
        const p = list.find(q => q.index === sel.entry);
        return p ? { ok: true, port: p } : { ok: false, code: "bad_type", message: `${field}.port.entry=${sel.entry} 越界（0..${list.length - 1}）` };
    }
    if (sel && typeof sel === "object" && typeof sel.role === "string" && isInt(sel.index)) {
        const hit = list.filter(q => q.role === sel.role);
        const p = hit[sel.index];
        return p ? { ok: true, port: p } : { ok: false, code: "bad_type", message: `${field}.port {role:"${sel.role}",index:${sel.index}} 不存在（该角色有 ${hit.length} 个）` };
    }
    return { ok: false, code: "bad_type", message: `${field}.port 形态不认识` };
}

/** 端点 → 实体记录 */
function resolveEntity(ep, world, field) {
    if (!world) return { ok: false, code: "precondition_failed", message: `connect 需要 ctx.entities（obs 的实体表）才能解析 ${field}` };
    if (ep.uid !== undefined) {
        const r = world.byUid.get(ep.uid);
        return r ? { ok: true, rec: r } : { ok: false, code: "endpoint_not_found", message: `${field}.uid=${ep.uid} 不在世界（obs 过期或已被删）` };
    }
    if (ep.hub !== undefined) {
        if (ep.hub.uid !== undefined) {
            const r = world.byUid.get(ep.hub.uid);
            if (r && r.type === "hub") return { ok: true, rec: r };
            return { ok: false, code: "endpoint_not_found", message: `${field}.hub.uid=${ep.hub.uid} 不是 hub` };
        }
        if (ep.hub.cell !== undefined) {
            const r = world.byOrigin.get(key(ep.hub.cell[0], ep.hub.cell[1]));
            if (r && r.type === "hub") return { ok: true, rec: r };
            return { ok: false, code: "endpoint_not_found", message: `${field}.hub.cell 不是 hub 原点` };
        }
        const hubs = [...world.byUid.values()].filter(r => r.type === "hub");
        if (hubs.length === 1) return { ok: true, rec: hubs[0] };
        return { ok: false, code: "endpoint_not_found", message: `世界里有 ${hubs.length} 个 hub，无法唯一确定 ${field}` };
    }
    if (ep.cell !== undefined) {
        const r = world.byOrigin.get(key(ep.cell[0], ep.cell[1]));
        return r ? { ok: true, rec: r } : { ok: false, code: "endpoint_not_found", message: `${field}.cell=${ep.cell} 不是任何实体的 origin` };
    }
    return { ok: false, code: "bad_type", message: `${field} 形态不认识` };
}

/* ═══════════════════════════════ 3. 路径形状（纯几何） ═══════════════════════════════ */

/**
 * 给定**方向序列**与位移，解出每条腿的步数。
 *
 *   sum(n_i * DIRV[d_i]) === disp   （两个轴各一条方程）
 *
 * 这是**欠定**的：同一轴上可能有两条同向腿，它们的步数可以互相搬运而不改变总位移。
 * 两个典型例子：
 *   · 直线        dirs=[top]                 → 唯一解
 *   · Z 形        dirs=[top,right,top]       A 轴两条 top 腿：a + c = A（A-1 种拆法）
 *   · 绕行        dirs=[right,top,right]     X 轴两条 right 腿：b + d = X（X-1 种拆法）
 * 最后这种正是真实存档里 miner@(3,-8)→balancer@(8,-9) 需要的几何：
 * 直线走法要穿过被 balancer 自己占住的那一格，绕行必须「先右 4、下 1、再右 1」。
 * 如果只把残差全推给一条腿，这条路永远生成不出来 —— 那是本宏一开始 74% 的根因。
 *
 * 所以这里枚举**同向腿组内的整数拆分**（按确定性次序增广），而不是只给一个解。
 *
 * @param {string[]} dirs @param {number[]} mins @param {[number,number]} disp
 * @param {{maxSplits?:number}} [opt]
 * @returns {Array<number[]>} 全部步数解（首个是最短解）
 */
export function solveLegsAll(dirs, mins, disp, opt = {}) {
    const maxSplits = opt.maxSplits === undefined ? 64 : opt.maxSplits;
    const n = dirs.length;

    /* 1) 每条轴单独算：需要多少正位移、负位移；再按"同向组"分配 */
    const base = mins.slice();
    const groups = new Map();          // `${axis}:${sign}` → [腿索引...]
    for (let i = 0; i < n; i++) {
        for (const axis of [0, 1]) {
            const s = DIRV[dirs[i]][axis];
            if (s === 0) continue;
            const k = `${axis}:${s > 0 ? "+" : "-"}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(i);
        }
    }

    /* 2) 更直接的做法：按轴解方程。
       每条轴的求和解 = Σ_pos n_p - Σ_neg n_n = want。
       先给所有腿取 mins，算出缺口 g = want - Σ mins*sign；
       若 g > 0 加给正组，g < 0 加给负组；加不进去 → 无解。
       加的时候在组内做**整数拆分**（组内每条腿 >= mins[i]）。 */
    const sols = [];
    // 把每条轴的处理串起来：先算出两轴各自要给哪一组加多少
    const plan = [];                   // [{idxs, amount}]
    for (const axis of [0, 1]) {
        const cur = dirs.reduce((s, d, i) => s + base[i] * DIRV[d][axis], 0);
        const gap = disp[axis] - cur;
        if (gap === 0) continue;
        const k = `${axis}:${gap > 0 ? "+" : "-"}`;
        const idxs = groups.get(k) || [];
        if (!idxs.length) return [];
        plan.push({ idxs, amount: Math.abs(gap), axis });
    }

    /* 3) 每个"组"的整数拆分递归。不同轴的组互不相交（一条腿只属于一个轴），
          所以可以独立拆分再笛卡尔积。 */
    const splitsOf = (idxs, amount) => {
        // 把 amount 拆给 idxs（顺序敏感，确定性：从前往后增广）
        const res = [];
        const carve = (k, left, acc) => {
            if (k === idxs.length - 1) { res.push([...acc, left]); return; }
            for (let v = 0; v <= left; v++) { acc.push(v); carve(k + 1, left - v, acc); acc.pop(); }
        };
        if (!idxs.length) return amount === 0 ? [[]] : [];
        carve(0, amount, []);
        return res;
    };

    let combos = [{ base: base.slice(), parts: [] }];
    for (const p of plan) {
        const opts = splitsOf(p.idxs, p.amount);
        if (!opts.length) return [];
        const next = [];
        for (const c of combos) {
            for (const o of opts) {
                if (next.length >= maxSplits * 4) break;
                const nb = c.base.slice();
                p.idxs.forEach((li, j) => { nb[li] += o[j]; });
                next.push({ base: nb, parts: c.parts.concat([{ idxs: p.idxs, add: o }]) });
            }
        }
        combos = next;
    }

    for (const c of combos) {
        // 校验
        let ok = true;
        for (let i = 0; i < n; i++) if (c.base[i] < mins[i] || !Number.isInteger(c.base[i])) { ok = false; break; }
        if (!ok) continue;
        for (const axis of [0, 1]) {
            const got = dirs.reduce((s, d, i) => s + c.base[i] * DIRV[d][axis], 0);
            if (got !== disp[axis]) { ok = false; break; }
        }
        if (!ok) continue;
        sols.push(c.base);
        if (sols.length >= maxSplits) break;
    }
    // 确定性排序：总长升序，再字典序
    sols.sort((a, b) => (a.reduce((x, y) => x + y, 0) - b.reduce((x, y) => x + y, 0))
        || (() => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; })());
    return sols;
}

/**
 * 单解版本：取最短解。保留给只需要"一条"的调用方；candidateShapes 用 solveLegsAll。
 * @returns {number[]|null}
 */
export function solveLegs(dirs, mins, disp) {
    const all = solveLegsAll(dirs, mins, disp, { maxSplits: 1 });
    return all.length ? all[0] : null;
}

export function candidateShapes(S, v0, E, vE, opt = {}) {
    const maxTurns = typeof opt === "number" ? opt : (opt.maxTurns === undefined ? 6 : opt.maxTurns);
    const fits = typeof opt === "object" && typeof opt.fits === "function" ? opt.fits : null;
    const disp = [E[0] - S[0], E[1] - S[1]];
    /* 步数上限（曼哈顿距离 + 余量）：没有它，6 转角枚举会产出几百条"绕大圈"的候选，
       在 hub 16 入口时把单次 connect 拖到 300ms+。绕行只需要**局部**余量：
       实测真实存档里最长的必要绕行是曼哈顿 +2。给 +8 已绰绰有余。 */
    const budget = typeof opt === "object" && Number.isInteger(opt.maxLen)
        ? opt.maxLen
        : (Math.abs(disp[0]) + Math.abs(disp[1])) + 8;
    const out = [];
    const seen = new Set();

    /* 端点约束（从带子语义直接推出，不是约定）：
         首格 c0 的 entry 面必须是 OPP[v0]（它在 v0 那一面接上游机器的货）
         末格 cn 的 exit  面必须是 vE   （它朝 vE 那一面喷进下游机器）
       货流方向 vel(ck) = OPP[entry(ck)]，所以：
         · 首格的出口方向 d0 只需满足 solveTurn(OPP[v0], d0) 有解
           ⇒ d0 ≠ OPP[v0]（180° 掉头无解）—— 这就是"首格自己可以拐弯"的全部约束。
         · 同理末格的入口方向要求 solveTurn(…, vE) 有解 ⇒ d(n-1) ≠ OPP[vE]。
       所以首腿/末腿都**不是**固定等于 v0/vE：端点那两格自己可以是弯带。
       最后仍由 poseChain() 用 solveTurn 逐格复核，这里只先剪掉明显不可能的。 */
    const firstOk = d0 => d0 !== OPP[v0];
    const lastOk = dLast => dLast !== OPP[vE];

    const pushSolution = (dirs, ns) => {
        const legs = dirs.map((d, i) => ({ dir: d, steps: ns[i] })).filter(l => l.steps > 0);
        if (!legs.length) {
            /* 0 格 = 两端槽位本来就贴在一起（编译器的 "direct" 形态）。
               connect 不铺带、只报告"本来就通了"，这是合法结果，不是失败。 */
            if (S[0] === E[0] && S[1] === E[1] && v0 === vE && !seen.has("direct")) {
                seen.add("direct");
                out.push({ shape: "direct", via: null, split: null, turns: 0, legs: [], cells: [] });
            }
            return;
        }
        // 去掉 0 步后可能出现相邻同向（合并）——那是几何上的直线，不是转角
        const merged = [];
        for (const l of legs) {
            if (merged.length && merged[merged.length - 1].dir === l.dir) merged[merged.length - 1].steps += l.steps;
            else merged.push({ ...l });
        }
        const cells = legsToCells(S, merged);
        if (cells.length > budget) return;              // 绕大圈的候选直接丢（见 budget 注释）
        // 末格必须真的是终点（腿的方向不固定 ⇒ 中途的方向序列可能落在别处）
        const end = cells[cells.length - 1];
        if (end[0] !== E[0] || end[1] !== E[1]) return;
        // 转角数按**货流实际转向**数：v0 → 各腿 → vE
        const flow = [v0, ...merged.map(l => l.dir), vE];
        let turns = 0;
        for (let i = 0; i + 1 < flow.length; i++) if (flow[i] !== flow[i + 1]) turns++;
        if (turns > maxTurns) return;
        if (fits && !fits(cells)) return;
        /* 端点约束先剪枝只是省时间；**真正的判据在这里**：逐格用 solveTurn 反解，
           任何一格解不出来（含端点格自己 180° 掉头）这条链就作废。
           0 步腿会让声明的末腿与实际末腿不一致，所以不能只靠 lastOk 剪枝。 */
        if (!poseChain(cells, v0, vE).ok) return;
        const sig = cells.map(c => c.join(",")).join(";");
        if (seen.has(sig)) return;
        seen.add(sig);
        const mid = merged.length > 2 ? merged[1] : null;
        out.push({
            shape: SHAPE_NAME[turns] || (turns + "turn"),
            via: mid ? mid.dir : null,
            /* split 只作人读标签（哪条腿吃掉了多少格）。**权威描述是 legs**：
               它逐腿给出方向与步数，调用方要复算或改稿都从 legs 来，不要解析字符串。 */
            split: merged.map(l => `${l.dir[0]}${l.steps}`).join(">"),
            turns, legs: merged, cells,
        });
    };

    /* 一条方向序列 → **全部**步数解（同向腿组内的整数拆分全枚举）。
       只取"最短解"会漏掉绕行几何：真实存档里 miner@(3,-8)→balancer@(8,-9) 的
       正确走法是 right4/bottom1/right1（首尾两条 right 腿分摊 5 格），
       而"最短解"给的是 right5/bottom1，正好穿过 balancer 占住的那格。 */
    const emit = (dirs) => {
        if (!firstOk(dirs[0]) || !lastOk(dirs[dirs.length - 1])) return;
        const mins = dirs.map((_, i) => (i === 0 || i === dirs.length - 1) ? 0 : 1);
        /* 同向腿组内的整数拆分**全枚举** —— 这是绕行能力的来源，见函数尾巴的说明。 */
        for (const ns of solveLegsAll(dirs, mins, disp, { maxSplits: 64 })) pushSolution(dirs, ns);
    };

    /* 枚举「相邻两腿成直角」的方向序列。首腿可以在任何不等于 OPP[v0] 的方向
       （首格自己转弯），末腿同理（末格自己转弯）。 */
    const walk = (dirs, depth) => {
        if (dirs.length >= 2) emit(dirs);
        if (depth >= maxTurns) return;
        const last = dirs[dirs.length - 1];
        for (const nd of [LEFT[last], RIGHT[last]]) walk([...dirs, nd], depth + 1);
    };
    for (const d0 of ORDER) if (d0 !== OPP[v0]) walk([d0], 0);

    // 直线：整条链只朝一个方向（v0 === vE 时才可能）
    if (v0 === vE) {
        const straight = solveLegsAll([v0], [0], disp, { maxSplits: 1 });
        if (straight.length) pushSolution([v0], straight[0]);
    }

    /* 返回前按固定次序排好（转角数 → 中间腿 → 拆分 → 长度），
       这样 [0] 就是本宏会选的那条，调用方和测试都不必再猜。 */
    out.sort((a, b) => (a.turns - b.turns)
        || ((VIA_ORDER[a.via] ?? 9) - (VIA_ORDER[b.via] ?? 9))
        || ((SPLIT_ORDER_CS[a.split] ?? 9) - (SPLIT_ORDER_CS[b.split] ?? 9))
        || (a.cells.length - b.cells.length));
    return out;
}

/** 破平序（与 cmpShape 同源；模块顶层常量，candidateShapes 排序用） */
const VIA_ORDER = { left: 0, right: 1, top: 0, bottom: 1 };
const SPLIT_ORDER_CS = { null: 0, "source-long": 1, "turn-at-source": 2, "target-long": 3 };

const SHAPE_NAME = { 0: "straight", 1: "L", 2: "Z", 3: "3turn", 4: "4turn" };

/** legs → 格序列 */
export function legsToCells(S, legs) {
    const cells = [[S[0], S[1]]];
    let cur = [S[0], S[1]];
    for (const { dir, steps } of legs) {
        for (let i = 0; i < steps; i++) {
            cur = [cur[0] + DIRV[dir][0], cur[1] + DIRV[dir][1]];
            cells.push([cur[0], cur[1]]);
        }
    }
    return cells;
}

/**
 * 格序列 + 起止货流 → 每格的 (entry, exit, rotation, rotationVariant, code)。
 *
 * **唯一**的 rv 来源 = belt-rules.solveTurn；同向穿过 / 180° 掉头它会返回 null，这里如实报错而不是硬凑。
 * @returns {{ok:true, cells:object[]} | {ok:false, index:number, inDir:string, outDir:string}}
 */
export function poseChain(cells, v0, vE) {
    const n = cells.length;
    const vIn = [], vOut = [];
    for (let k = 0; k < n; k++) {
        vIn[k] = k === 0 ? v0 : vOut[k - 1];
        vOut[k] = k === n - 1 ? vE : dirBetween(cells[k], cells[k + 1]);
        if (!vOut[k]) return { ok: false, index: k, inDir: vIn[k], outDir: String(vOut[k]) };
    }
    const out = [];
    for (let k = 0; k < n; k++) {
        const entry = OPP[vIn[k]], exit = vOut[k];
        const p = solveTurn(entry, exit);
        if (!p) return { ok: false, index: k, inDir: vIn[k], outDir: exit };
        out.push({
            x: cells[k][0], y: cells[k][1],
            building: "belt",
            rotation: p.rotation,
            rotationVariant: p.rotationVariant,
            code: beltCode(p.rotationVariant),
            inDir: vIn[k], outDir: exit,          // 货流方向（诊断用）
            entry, exit,                          // 面（诊断用）
        });
    }
    return { ok: true, cells: out };
}

/* ═══════════════════════════════ 4. 几何自洽验证（本文件的核心判据） ═══════════════════════════════ */

/**
 * 逐对相邻格验证**几何自洽**。这是「方向全反」事故形态的抓取器。
 *
 * 两条判据（都是实测口径，见 F1）：
 *   ① 位置连续：b === a + DIRV[exit(a)]
 *   ② 面闭合：  exit(a) === OPP[entry(b)]      ← **不是** exit(a) === entry(b)（实测 0/146）
 * 另外逐格重解：solveTurn(entry, exit) 必须解出**同一** (rotation, rv)，code 必须 = 1+rv。
 *
 * @param {Array<{x,y,rotation,rotationVariant,code}>} cells
 * @returns {{ok:boolean, breaks:Array<object>, pairs:number}}
 */
export function verifyChain(cells) {
    const breaks = [];
    if (!Array.isArray(cells) || !cells.length) return { ok: false, breaks: [{ at: "chain", why: "空链" }], pairs: 0 };

    for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const entry = beltEntry(c.rotationVariant, c.rotation);
        const exit = beltExit(c.rotationVariant, c.rotation);
        const re = solveTurn(entry, exit);
        if (!re || re.rotation !== c.rotation || re.rotationVariant !== c.rotationVariant) {
            breaks.push({ at: i, cell: [c.x, c.y], why: "单格自身不自洽：solveTurn(entry,exit) 与记录的 (rot,rv) 不符", entry, exit, got: { rotation: c.rotation, rotationVariant: c.rotationVariant }, want: re });
        }
        if (c.code !== beltCode(c.rotationVariant)) {
            breaks.push({ at: i, cell: [c.x, c.y], why: "code !== 1 + rotationVariant", got: c.code, want: beltCode(c.rotationVariant) });
        }
    }

    for (let i = 0; i + 1 < cells.length; i++) {
        const a = cells[i], b = cells[i + 1];
        const aExit = beltExit(a.rotationVariant, a.rotation);
        const bEntry = beltEntry(b.rotationVariant, b.rotation);
        if (aExit !== OPP[bEntry]) {
            breaks.push({
                at: i, cell: [a.x, a.y], next: [b.x, b.y],
                why: `断裂: ${a.x},${a.y} exit=${aExit} → ${b.x},${b.y} entry=${bEntry}（要求 exit(a)===OPP[entry(b)]=${OPP[bEntry]}）`,
                aExit, bEntry, want: OPP[bEntry],
            });
            continue;
        }
        const want = [a.x + DIRV[aExit][0], a.y + DIRV[aExit][1]];
        if (b.x !== want[0] || b.y !== want[1]) {
            breaks.push({
                at: i, cell: [a.x, a.y], next: [b.x, b.y],
                why: `位置不连续: 期望 ${want}（a + DIRV[exit=${aExit}]），实得 ${[b.x, b.y]}`,
            });
        }
    }
    return { ok: breaks.length === 0, breaks, pairs: Math.max(0, cells.length - 1) };
}

/* ═══════════════════════════════ 5. 占用检查 ═══════════════════════════════ */

/**
 * 路径占用检查。**一条路径**的判据，不是跨候选的统计（那在 `summarizeBlocked`）。
 *
 * ## 三种「撞」必须分开记，因为修法完全不同
 *   · `firstMachine` 撞机器/hub —— **永不可覆盖**，只能改布线或换端口；
 *   · `firstBelt`    撞既有带子 —— 传 `opts.allow_replace=true` 就能过，代价是删旧带；
 *   · `selfOverlap`  路径自己走回已经走过的格 —— 这条走法**本身不合法**
 *                    （同一格不可能既是上游又是下游），跟世界里有什么无关。
 *
 * ## 为什么不复现旧行为（`self-overlap` 一旦出现就 `return`）
 * 旧实现在 belt 检查**之前**判自交并**立刻返回**，于是「这条路既自交、又撞带子」时
 * 只报自交。实测（半成品世界 `(1,-6)→hub`，842 条候选）156 条自交候选**全部**同时撞带子，
 * 而自交是**候选生成器**的毛病（6 转角枚举会产出折回来的走法），对调用方毫无指导意义：
 * 它拿不到「撞的是带子还是机器」这个真正决定下一步（allow_replace / 换端口 / 重布线）的信息。
 * 现在三个都记，`firstConflict` 按 **机器 > 带子 > 自交** 的优先级挑一个（前两者里最有修法的那条）；
 * 自交仍然**判红**（`ok:false`），只是不再霸占诊断文案。
 * 注意：进了 `candidates[]` 的走法都过了 `fits`（不含机器），所以在「全部候选都撞」的聚合
 * 文案里机器只以计数出现，`firstConflict` 不会指向机器 —— 那是**另一批**被更早剔除的走法。
 *
 * @returns {{ok:boolean, firstConflict:null|{x,y,what,uid?}, replaceable:number,
 *            belts:number, firstBelt:null|object, firstMachine:null|object, selfOverlap:null|{x,y}}}
 */
function checkOccupancy(cells, world, opts) {
    const seen = new Set();
    let replaceable = 0;      // allow_replace 打开时，被覆盖的带子格数（旧口径，不改）
    let belts = 0;            // 路径上的既有带子格数（**与 allow_replace 无关**，供聚合统计）
    let firstBelt = null;
    let firstMachine = null;
    let selfOverlap = null;
    for (const c of cells) {
        const k = key(c[0], c[1]);
        const rec = world ? world.cells.get(k) : null;
        /* 先看世界再看自交：同一格既重复又撞实体时，两个事实都要留下 */
        if (seen.has(k)) {
            if (!selfOverlap) selfOverlap = { x: c[0], y: c[1] };
        } else {
            seen.add(k);
        }
        if (!rec) continue;
        if (rec.type === "belt") {
            belts++;
            if (opts.allow_replace) { replaceable++; continue; }
            if (!firstBelt) firstBelt = { x: c[0], y: c[1], what: "belt", uid: rec.uid };
            continue;
        }
        if (!firstMachine) firstMachine = { x: c[0], y: c[1], what: rec.type, uid: rec.uid };
    }
    const firstConflict = firstMachine || firstBelt
        || (selfOverlap ? { ...selfOverlap, what: "self-overlap" } : null);
    return {
        ok: firstConflict === null,
        firstConflict, replaceable, belts, firstBelt, firstMachine, selfOverlap,
    };
}

/**
 * 被覆盖的既有带子会切断谁 —— `connect(allow_replace)` 的后果分析。
 *
 * ## 为什么必须是**本文件的**轻量实现
 *
 * `remove.mjs` 有完整的 `analyzeRemoval`，但它已经 `import { buildWorld, portsOf }
 * from "./connect.mjs"`。反向 import 会成环，而这两个文件都在模块顶层建常量表
 * （`SHAPE_NAME` / `RV_*`），环上的顶层 const 初始化顺序不可靠 ——
 * 那类 bug 只在某些入口顺序下出现，极难复现。
 *
 * ## 只回答一个问题的原因
 *
 * 覆盖带子唯一要紧的后果是：**它原本供着的下游会不会饿死**。
 * 更细的分类（orphaned-output / starved-machine / opaque）由 `replace_run` 负责，
 * 那里有完整的机器端口图。这里顺着**出口格**走一格就够 ——
 * 出口格上是什么，就是谁原本在吃这条带子的货。
 *
 * @param {object} world `buildWorld()` 的返回（`cells` 是特格索引）
 * @param {Array<number>} replacedUids 将被覆盖的带子 uid
 * @returns {{replaced_uids:Array<number>, would_disconnect:Array<object>}}
 *   `would_disconnect` 每项 `{kind:"starved-belt"|"starved-machine", uid, cell, why}`
 */
function analyzeReplacedBelts(world, replacedUids) {
    const out = [];
    if (!world || !world.byUid) return { replaced_uids: replacedUids, would_disconnect: out };
    const R = new Set(replacedUids);
    const byUid = world.byUid;

    for (const uid of [...R].sort((a, b) => a - b)) {
        const b = byUid.get(uid);
        if (!b || b.type !== "belt") continue;
        /* 这条带子的出口格 —— 原来是谁在这里接货。 */
        let dir = null;
        try {
            /* buildWorld 的 rec 字段是 `rv`（不是 obs 的 `rotation_variant`）。 */
            dir = beltExit(b.rv || 0, b.r || 0);
        } catch { dir = null; }
        if (!dir || !DIRV[dir]) continue;
        const d = DIRV[dir];
        const outCell = [b.x + d[0], b.y + d[1]];
        const nx = world.cells.get(key(outCell[0], outCell[1]));
        if (!nx) continue;                                  // 出口本来就空着 ⇒ 覆盖它没让谁饿死
        if (nx.type === "belt") {
            if (R.has(nx.uid)) continue;                     // 下游也被覆盖了 ⇒ 一起拆，不算切断
            /* ⚠️ `world.cells` 的记录只有 `{uid,type,isAnchor}`，**没有坐标**。
               想拿坐标必须用 `outCell`（我们刚算出来的那一格）或查 `byUid`。
               第一版写 `[nx.x, nx.y]` ⇒ 得到 `[null, null]` —— 报告里出现
               一对空坐标，读的人根本不知道断在哪。 */
            out.push({
                kind: "starved-belt", uid: nx.uid, cell: outCell,
                why: `(${b.x},${b.y}) uid=${uid} 被覆盖后，下游 (${outCell[0]},${outCell[1]}) uid=${nx.uid} 再没有供料方`,
            });
            continue;
        }
        if (nx.type === "hub") continue;                     // 覆盖直连 hub 的带子：hub 不「饿死」
        out.push({
            kind: "starved-machine", uid: nx.uid, cell: outCell,
            why: `(${b.x},${b.y}) uid=${uid} 被覆盖后，${nx.type} (${outCell[0]},${outCell[1]}) 的这个入口再没有供料`,
        });
    }
    return { replaced_uids: replacedUids, would_disconnect: out };
}

/**
 * 「所有候选都撞」时的**聚合**诊断。
 *
 * 旧实现在 842 条候选里按 (y,x) 挑一条的 `firstConflict` 上报 —— 那是**任意**一条，
 * 不是有代表性的那一条，于是调用方读到 `(-3,-8) self-overlap`，而真相是
 * 「842 条**全部**撞在既有带子上，最少覆盖 1 格就能通」。
 *
 * 这里按**修法**分类聚合，并给出「最少要覆盖几格」这个可直接行动的结论。
 *
 * @param {Array<{cells:Array, occ:object, sh:object}>} cands
 * @param {number} machineBlocked 枚举阶段就因撞机器被 `fits` 剔除的走法数
 */
function summarizeBlocked(cands, machineBlocked) {
    const beltOnly = [];      // 撞带子、不自交 → allow_replace 可以救
    const beltAndSelf = [];   // 既撞带子又自交 → 覆盖也救不了（自交本身不合法）
    const selfOnly = [];      // 纯自交
    let clean = 0;            // 谁都没撞（理论上不会走到这里，留着自证）
    for (const cd of cands) {
        const oc = cd.occ;
        if (oc.selfOverlap) (oc.belts > 0 ? beltAndSelf : selfOnly).push(cd);
        else if (oc.belts > 0) beltOnly.push(cd);
        else clean++;
    }
    /* 「最少覆盖几格」只看**非自交**的候选：自交路径覆盖了也不合法，不能拿它当解。
       同分时按形状序（转角少 → 格少）挑，保证同一输入永远同一结论。 */
    beltOnly.sort((a, b) => (a.occ.belts - b.occ.belts)
        || (a.sh.turns - b.sh.turns)
        || (a.cells.length - b.cells.length));
    const best = beltOnly[0] || null;
    const minReplace = best ? best.occ.belts : null;

    const hist = new Map();   // 需要的覆盖格数 → 条数
    for (const cd of beltOnly) hist.set(cd.occ.belts, (hist.get(cd.occ.belts) || 0) + 1);
    const histText = [...hist.entries()].sort((a, b) => a[0] - b[0])
        .map(([n, c]) => `${n} 格 ${c} 条`).join(" / ");

    const parts = [];
    if (beltOnly.length) parts.push(`撞既有带子 ${beltOnly.length} 条（${histText}）`);
    if (beltAndSelf.length) parts.push(`撞带子且路径自交 ${beltAndSelf.length} 条`);
    if (selfOnly.length) parts.push(`纯自交 ${selfOnly.length} 条（候选生成器产出的折回走法，不是世界里挡了什么）`);
    if (machineBlocked) parts.push(`枚举阶段撞机器被剔除 ${machineBlocked} 条`);
    if (clean) parts.push(`无冲突 ${clean} 条`);   // 不应出现；出现即说明筛选逻辑有 bug

    return {
        total: cands.length,
        machineBlocked,
        beltOnly: beltOnly.length,
        beltAndSelf: beltAndSelf.length,
        selfOnly: selfOnly.length,
        beltHist: Object.fromEntries(hist),
        minReplace,
        example: best ? (best.occ.firstBelt || null) : null,
        bestShape: best ? best.sh : null,
        text: parts.join("；"),
    };
}

/* ═══════════════════════════════ 6. 主入口 ═══════════════════════════════ */

/**
 * 连一条带：from 的 ejector → to 的 acceptor。
 *
 * @param {object} a 契约形态 {from,to,opts}；或位置形态的 from
 * @param {object} [b] ctx（契约形态）| to（位置形态）
 * @param {object} [c] opts（位置形态）
 * @param {object} [d] ctx（位置形态）
 */
export function connect(a, b, c, d) {
    // ── 双形态派发：契约 `connect(args, ctx)` / 任务书 `connect(from, to, opts, ctx)` ──
    let args, ctx;
    if (a && typeof a === "object" && (a.from !== undefined || a.to !== undefined)) {
        args = a; ctx = b || {};
    } else {
        args = { from: a, to: b, opts: c };
        ctx = d || (c && c.ctx) || {};
    }

    const v = validateConnectArgs(args);
    if (!v.ok) return failure(v.error);

    const { from: fe, to: te, opts } = v.value;

    // ── 世界 ──
    const world = worldFor(ctx);
    const rf = resolveEntity(fe, world, "from");
    if (!rf.ok) return failure({ code: rf.code, field: "from", message: rf.message });
    const rt = resolveEntity(te, world, "to");
    if (!rt.ok) return failure({ code: rt.code, field: "to", message: rt.message });

    if (rf.rec.uid === rt.rec.uid && fe.port === te.port) {
        return failure({ code: "precondition_failed", field: "to", message: "from 与 to 是同一个实体的同一个端口" });
    }
    /* ★ r≠0 只对**机器**是限制，对带子不是 ★
     *
     * 这条限制的理由是「旋转**机器**的槽位偏移需要 P2 的 origin 位移表」—— 说的是机器。
     * 而带子根本没有「槽位偏移」这回事：它的方向完全由 `(rotation_variant, r)` 共同决定
     * （`beltExit(0,180)=bottom`、`beltExit(0,270)=left`），每个方向都合法。
     *
     * 旧实现没区分类型，于是**带子也被拦了**。实测后果：半成品世界实验里，
     * 断点 `(1,-6)` 是 r=180 的带子，loop 诊断正确（`DEAD_END`）、模型也选对了动作
     * （`connect`，原文「Route the dead-ended output into the hub」），却被这道闸拒成
     * `out_of_scope` —— 一个正确的计划被能力缺口挡死。
     *
     * 而真实世界里 r≠0 的带子占绝大多数（长竖直段全是 r=0/r=180，转角是 r=270）。
     */
    const ROTATABLE_ONLY_IF_MACHINE = new Set(["belt", "underground_belt"]);
    for (const [rec, field] of [[rf.rec, "from"], [rt.rec, "to"]]) {
        if (rec.r !== 0 && !ROTATABLE_ONLY_IF_MACHINE.has(rec.type)) {
            return failure({ code: "out_of_scope", field, message: `${field} 指向的 ${rec.type} rotation=${rec.r}；v1 只支持 r=0（旋转机器的槽位偏移需 P2 的 origin 位移表）` });
        }
    }

    const pfList = portsOf(rf.rec, loadSpec()).eject;
    const ptList = portsOf(rt.rec, loadSpec()).accept;

    /* contract 的 hub 端点把入口索引放在 `{hub:{entry:N}}` 里（不是 `port`）；
       不认它会让显式指定的入口被静默忽略（然后"按最短路径"挑一个完全不同的口）。 */
    const hubEntry = te.hub && isInt(te.hub.entry) ? te.hub.entry : null;
    const toPortSel = hubEntry !== null ? { entry: hubEntry } : te.port;

    const spf = selectPort(pfList, fe.port, " ejector（输出槽）", "from");
    if (!spf.ok) return failure({ code: spf.code, field: "from.port", message: spf.message, candidates: spf.candidates });

    /* 宿是 hub 且给了 "auto" 时走**入口分配**（契约 PORT_FORMS 明写）：
       hub 有 16 个入口，auto 不是 ambiguous，而是"你来挑"。这里把 16 个都放进候选，
       由路径打分挑最短的那个，并在 choice/warnings 里回报 chosen entry。 */
    const hubAuto = rt.rec.type === "hub" && (toPortSel === "auto" || toPortSel === undefined);
    let spt;
    if (hubAuto) {
        // 供内层报错用的"代表端口"：取 0 号；候选是真·16 个
        spt = { ok: true, port: ptList[0] };
    } else {
        spt = selectPort(ptList, toPortSel, " acceptor（输入槽）", "to");
        if (!spt.ok) return failure({ code: spt.code, field: "to.port", message: spt.message, candidates: spt.candidates });
    }

    const fromPorts = fe.port === "auto" ? pfList : [spf.port];
    const toPorts = hubAuto ? ptList : [spt.port];

    // ── 端口占用（契约 precondition）──
    const bindF = world ? portBoundKind(world, spf.port) : null;
    if (bindF === "accept" && !opts.rebind) {
        return failure({
            code: "port_already_bound", field: "from.port",
            message: `from 的端口 ${describePort(spf.port)} 已经有带子接货，再连一条会让旧的饿死`,
            hint: "确实要抢过来就传 opts.rebind=true（接受旧支路断流）。",
        });
    }
    /* 宿端：逐候选检查，只丢掉"已被供料"的那个入口，而不是整单失败 ——
       hub 有 16 个入口时这是必须的（否则一个口被占就永远连不上）。全部被占才报 target_already_fed。 */
    const fedFree = [];
    for (const pt of toPorts) {
        /* ★ 2026-11-02：目标的接收槽长在**源机器自己身上** ⇒ 立刻拒，并说清楚 ★
         *
         * 实测（`.tmpverify/ab-density/b7.mjs`，六轮 178 个计划）：
         * 142 次 `occupied` 里 **64 次（45%）** 是这个形状 ——
         *
         *   balancer(-8,-3) 占 (-8,-3) 和 (-7,-3)
         *   → belt(-6,-3) 的 acceptor 落点是 (-7,-3)  ← **balancer 自己的第二格**
         *
         * 模型想做「把 balancer 的 secondary 接到 6 格外的带子」，
         * 但那条带的输入端就长在 balancer 身上。货会绕回源头。
         *
         * 宏原来会走到 `fits` 那一步才报 `occupied`，错误信息是
         * 「第一处冲突在 -8,-3（balancer）—— 机器永远不会被覆盖」。
         * 那句话技术上对，但**没说出真正的问题**：
         * 不是路被挡了，是**目标本身就在源机上**。
         *
         * 这个检查是 O(1)，放在这里零成本。它把 45% 的 occupied 变成一条
         * 模型读完就知道该换目标的诊断。
         *
         * ⚠️ **要查的是 `pt.cell`（货的落点），不是 `pt.slot`（端口所在格）**。
         * 实测这个端口对：
         *   `pt.slot = [-6,-3]`（belt 自己所在的格）
         *   `pt.cell = [-7,-3]`（**货进入的落点** —— balancer 的第二格）
         * 查 `slot` 永远匹配不上；查 `cell` 才是「货会不会落回源机器」。 */
        if (world && pt.cell) {
            const landRec = world.cells.get(key(pt.cell[0], pt.cell[1]));
            if (landRec && fe.uid !== undefined && landRec.uid === fe.uid) {
                continue;   // 这个 to 口的落点在源机器上 —— 丢掉它，别整单失败
            }
        }
        if (world && portFedKind(world, pt) && !opts.rebind) continue;
        fedFree.push(pt);
    }
    if (!fedFree.length) {
        /* 全部被丢掉时，区分「被供料」和「长在源机上」—— 两者修法完全不同 */
        const onSelf = toPorts.filter(pt => {
            if (!world || !pt.cell) return false;
            const r = world.cells.get(key(pt.cell[0], pt.cell[1]));
            return r && fe.uid !== undefined && r.uid === fe.uid;
        });
        if (onSelf.length === toPorts.length) {
            return failure({
                code: "to_port_on_source", field: "to.port",
                message: `to 的接收槽就长在 from 自己身上（${describePort(spf.port)} 的货会绕回同一台机器）`,
                hint: "换一个 to 目标 —— 找一个接收槽不在 from 占地内的实体；或换 from 的另一个端口。",
                detail: { fromUid: fe.uid, toUid: spt.port && spt.port.uid, onSelf: onSelf.length },
            });
        }
        return failure({
            code: "target_already_fed", field: "to.port",
            message: `to 的${toPorts.length > 1 ? `全部 ${toPorts.length} 个` : ""}端口都已经有供料方`,
            hint: "换一个 port，或传 opts.rebind=true。",
        });
    }
    const usableToPorts = fedFree;

    // ── 枚举候选：端口对 × 形状 ──
    /* fits 钩子：**在枚举时就丢掉撞机器的候选**，而不是枚举完再筛。
       但**不许因此丢掉诊断**：被机器挡住的候选要把 firstConflict 记下来，
       否则「撞了」会被错报成「无解」，调用方就不知道是该绕还是该改端口。 */
    let blockedBy = null;      // 被硬障碍挡住的第一处（按 y,x 确定性排序）
    let machineBlocked = 0;    // 在枚举阶段就被机器剔除的**走法条数**（诊断用，不参与搜索）
    const noteBlocked = (cells) => {
        machineBlocked++;
        for (const c of cells) {
            const rec = world.cells.get(key(c[0], c[1]));
            if (!rec || rec.type === "belt") continue;
            const fc = { x: c[0], y: c[1], what: rec.type, uid: rec.uid };
            if (!blockedBy || fc.y < blockedBy.y || (fc.y === blockedBy.y && fc.x < blockedBy.x)) blockedBy = fc;
            return;
        }
    };
    const fits = cells => {
        if (cells.length > opts.max_cells) return false;
        if (!world) return true;
        for (const c of cells) {
            const rec = world.cells.get(key(c[0], c[1]));
            if (rec && rec.type !== "belt") { noteBlocked(cells); return false; }   // 机器/hub 永不可覆盖
        }
        return true;
    };

    const candidates = [];
    /* hub 有 16 个入口时，端口对 × 候选形状会到几千条。策略：
       ① 每个端口对只保留**没有冲突**的里最好的几条（同分同短的再多也没用）；
       ② 一旦某个端口对产出了"转角数已达下界且无冲突"的解，剩下的端口对只需追平它
          —— 用 `bestTurns` 给后续端口对当预算，避免每个口都跑满 6 转角枚举。
       这是**剪枝**，不是放宽判据：每条留在 candidates 里的都还是要过 verifyChain。 */
    let bestTurns = Infinity;
    for (const pf of fromPorts) {
        const S = pf.cell, v0 = pf.vel;
        for (const pt of usableToPorts) {
            const E = pt.cell, vE = pt.vel;
            const floor = Math.max(minTurnsPossible(v0, vE), 0);
            const capTurns = Math.min(MAX_TURNS, Math.max(floor, bestTurns === Infinity ? MAX_TURNS : bestTurns));
            for (const sh of candidateShapes(S, v0, E, vE, { fits, maxTurns: capTurns })) {
                const cells = sh.cells;
                const chain = poseChain(cells, v0, vE);
                if (!chain.ok) continue;
                const occ = checkOccupancy(cells, world, opts);
                candidates.push({ sh, cells, chain: chain.cells, occ, pf, pt });
                if (occ.ok && sh.turns < bestTurns) bestTurns = sh.turns;
                // 本端口对已拿到"无冲突 + 下界转角"的解 ⇒ 这一对不必再找
                if (occ.ok && sh.turns <= floor) break;
            }
        }
        // 源端有多个口时，只需第一个能连通的（其余口是冗余的，不该再花时间）
        if (candidates.some(c => c.pf === pf && c.occ.ok) && fromPorts.length > 1) break;
    }

    if (!candidates.length) {
        /* 全部候选都被**机器/hub**挡住 → 这是「撞了」，不是「无解」。如实报 firstConflict。 */
        if (blockedBy) {
            return failure({
                code: "occupied", field: "to",
                message: `所有候选路径都被挡住；第一处冲突在 ${blockedBy.x},${blockedBy.y}（${blockedBy.what}${blockedBy.uid !== undefined ? ` uid=${blockedBy.uid}` : ""}）`,
                /* ⚠️ 2026-11-02：删掉「要绕开需要阶段 3 的布线」。
                 * 实测证否（`CONNECT-OCCUPIED-DIAGNOSIS.md`）：7 个唯一 `occupied` 里
                 * 4 个是**端口落点被非带实体占死**——换端口即可，与路径长短无关。
                 * 那句「等阶段 3」会让模型不再试换端口，而换端口正是多数情况的正解。
                 * 现在只留可执行的那一半。 */
                hint: "这是「撞了」，不是参数错。换一个 from 端口（多输出机器的另一侧常是空的），或换一个 to 目标；机器永远不会被覆盖。",
                firstConflict: blockedBy,
                detail: { firstConflict: blockedBy, maxTurns: MAX_TURNS },
            });
        }
        return failure({
            code: "no_path", field: "to",
            message: `没有任何 ≤${MAX_TURNS} 转角的折线能连上：from ${describePort(spf.port)}（出货 ${spf.port.vel}）→ to ${describePort(spt.port)}（进货 ${spt.port.vel}）`,
            /* 同上：不指向「阶段 3」，指向**换端口/换目标**。
               这是模型读完能立刻写出一个不同调用的建议。 */
            hint: `换个 from 端口或换个 to 目标；当前这一对端口之间没有 ≤${MAX_TURNS} 转角的路径。`,
            detail: { fromPort: spf.port, toPort: spt.port },
        });
    }

    // ── 先要**无冲突**的，再按 prefer 排序 ──
    const free = candidates.filter(cd => cd.occ.ok);
    if (!free.length) {
        /* 842 条全撞时，**不能**随手挑一条的 firstConflict 上报（旧行为）：
           那一条是按 (y,x) 排序的**任意**候选，它的 `self-overlap` 既不是主因也
           不是能修的因。改为按「修法」聚合 + 给出最少要覆盖几格。 */
        const sum = summarizeBlocked(candidates, machineBlocked);
        const hasBelt = sum.beltOnly > 0;
        /* ⚠️ 2026-11-02：删掉「等阶段 3 的布线」这半句。
         *
         * 它原来写作「allow_replace 帮不上，只能换端口或等阶段 3 的布线」。
         * 前半句对，后半句**被实测证否**：
         *
         * `CONNECT-OCCUPIED-DIAGNOSIS.md` 逐条验证了 7 个唯一的 `occupied` 失败
         * （格子级 BFS，判据与 `candidateShapes` 独立）：
         *   · 4/7 是端口落点被非带实体占死 —— **换端口即可**，与路径无关
         *   · 3/7 只差 `allow_replace:true`，宏已枚举出 89~1045 条合法折线
         *   · **0/7 需要更好的布线**
         *
         * 而这句 hint 在多轮实验（`HINT-AB-RESULT.md`，38 条）里出现了 7 次，
         * 每次都把模型引向一个**不存在的能力**。它比不给 hint 更糟：
         * 模型读到「等阶段 3」，就不会再试换端口 —— 而换端口正是 4/7 的正解。
         *
         * 现在只留**真的可执行**的那一半：「换 from 端口，或换 to 目标」。
         * 这是模型读完能立刻写出一个不同调用的建议。 */
        const hint = hasBelt
            ? `这是「撞了」，不是参数错。有 ${sum.beltOnly} 条走法只需要覆盖既有带子（最少 ${sum.minReplace} 格）`
                + `就能通 —— 传 opts.allow_replace=true 即可（执行时要 delete 那些 uid 并纳入 tx 回滚）。`
                + `${sum.beltAndSelf + sum.selfOnly ? `另有 ${sum.beltAndSelf + sum.selfOnly} 条是候选生成器的自交走法，覆盖也救不了。` : ""}`
            : `这是「撞了」，不是参数错。${sum.selfOnly + sum.beltAndSelf} 条候选全部自交（候选生成器的折回走法），`
                + `没有一条是「撞了旧带子」—— allow_replace 帮不上。`
                + `换一个 from 端口（多输出机器的另一侧常是空的），或换一个 to 目标。`;
        /* firstConflict 只报**这批候选**里真实存在的那一类：
           能进 candidates[] 的走法都已过 `fits`，不含机器 —— 所以这里不该出现机器。
           撞带子时指向**覆盖代价最小**的那条走法的那一格（照着删/覆盖就是对的）；
           只有全是自交时才退回 self-overlap。机器挡路的信息在 detail.machineBlocked
           与 message 里（那是另一批走法，不能拿它的格冒充这 842 条的冲突点）。 */
        const fc = sum.example
            || (sum.total ? candidates.map(x => x.occ.firstConflict).filter(Boolean)
                .sort((p, q) => p.y - q.y || p.x - q.x)[0] : null);
        /* ★ 撞的都是带子而调用方没开 allow_replace ⇒ 自动试一次 ★
         *
         * 实测（`.tmpverify/connect/`）：一条 17 格长的墙上 340 条候选全被挡，
         * 其中 **212 条只差 1 格**。宏自己已经算得出「只要覆盖 1 格就能通」，
         * 却只把这句话写进 hint，让模型下一轮再调一次 —— 而实测模型常常不照做
         * （1405 次真实调用里 `opts.allow_replace` 极少出现）。
         *
         * 所以这里**替它试一次**：把 allow_replace 打开重跑同一套枚举。
         * 成功就正常返回（附带 `replace-would-disconnect` 后果报告），
         * 不成功再报原来的 `occupied`。
         *
         * 为什么这是安全的：`connect` 是**只读规划**宏（`dry_run: true`），
         * 它不写世界。真正的写入由调用方按返回值组 tx。所以「试一次」不产生副作用 ——
         * 调用方仍然可以选择忽略这个结果、传 opts 重来。
         *
         * 为什么必须带后果：替它打开 allow_replace 意味着**替它决定覆盖别人的带子**。
         * 那个决定必须把「会切断谁」一起交回去，否则就是用一次隐蔽破坏换一次成功。 */
        if (hasBelt && !opts.allow_replace && opts.auto_relax !== false) {
            const retry = connect({ from: fe, to: te, opts: { ...opts, allow_replace: true } }, ctx);
            if (retry && retry.ok) {
                return {
                    ...retry,
                    warnings: [
                        ...(retry.warnings || []),
                        {
                            code: "hub-entry-chosen",
                            detail: `原调用没开 allow_replace，宏自动用 allow_replace=true 重试并成功`
                                + `（${sum.beltOnly} 条走法只需覆盖既有带子，最少 ${sum.minReplace} 格）`,
                            hint: "这不是 hint，是**已替你做的选择**。若不想覆盖那几格带子，"
                                + "换 from 端口或换 to 目标重调；覆盖的 uid 在 changed.removed_uids 与 consequences.replaced_uids。",
                        },
                    ],
                    auto_relaxed: { allow_replace: true, reason: "all-candidates-blocked-by-belts", tried: sum.total, min_replace: sum.minReplace },
                };
            }
        }
        return failure({
            code: "occupied", field: "to",
            message: `${sum.total} 条候选路径全部被挡住：${sum.text}`,
            hint,
            firstConflict: fc,
            detail: { firstConflict: fc, tried: sum.total, machineBlocked: sum.machineBlocked, breakdown: sum, sample: sum.bestShape },
        });
    }

    const ranked = free.slice().sort((x, y) => scoreOf(x, opts, world) - scoreOf(y, opts, world)
        || cmpShape(x.sh, y.sh)
        || (x.cells[0][1] - y.cells[0][1]) || (x.cells[0][0] - y.cells[0][0]));

    const pick = ranked[0];

    // ── 自证：几何闭合（这是本宏的立身之本）──
    const ver = verifyChain(pick.chain);
    if (!ver.ok) {
        return failure({
            code: "internal", field: null,
            message: `生成的路径几何不自洽（第 ${ver.breaks[0].at} 处）：${ver.breaks[0].why}`,
            detail: { breaks: ver.breaks.slice(0, 5) },
        });
    }

    const cellsOut = pick.chain.map(c => ({
        x: c.x, y: c.y, building: c.building,
        rotation: c.rotation, rotationVariant: c.rotationVariant, code: c.code,
        inDir: c.inDir, outDir: c.outDir, entry: c.entry, exit: c.exit,
    }));

    const warnings = [];
    if (pick.occ.replaceable > 0) {
        warnings.push({
            code: "replacing-belts",
            detail: `allow_replace=true：路径上有 ${pick.occ.replaceable} 格是既有带子，执行时必须先 delete{uid} 并纳入 tx 回滚`,
        });
    }
    /* ★ 覆盖既有带子会切断谁 —— **必须报告**，不许盲拆 ★
     *
     * `replace_run` 早就有这个分析（`analyzeRemoval`），`connect` 一直没有。
     * 后果很具体：`allow_replace` 覆盖一条带子，可能正好切断一条主供料路，
     * 而调用方只看到 `replacing-belts: 3 格`，不知道那 3 格是别人的命脉。
     *
     * 实测（`.tmpverify/connect/`）：一条 17 格长的墙上，340 条候选全被挡，
     * 其中 212 条只差 1 格 —— 只要覆盖一格就能通。但那一格可能是关键链路。
     * 不给后果就直接替它覆盖，等于用一个更隐蔽的破坏换一次「成功」。
     *
     * 这里是**报告，不是阻止**（与 `replace_run` 的 `would_disconnect` 同一口径）：
     * 断开本身可能是对的（比如那条线本来就是残线），要不要覆盖是调用方的决定。 */
    const replacedUids = [];
    if (pick.occ.replaceable > 0 && world) {
        for (const c of pick.cells) {
            const rec = world.cells.get(key(c[0], c[1]));
            if (rec && rec.type === "belt" && !replacedUids.includes(rec.uid)) replacedUids.push(rec.uid);
        }
    }
    let consequences = null;
    if (replacedUids.length) {
        try {
            /* ⚠️ 用**同步的**轻量实现，不用 `remove.mjs` 的 `analyzeRemoval`。
             *
             * 原因：`remove.mjs` 已经 `import { buildWorld, portsOf } from "./connect.mjs"`
             * （它复用本文件的世界模型）。反向 import 会成环 —— ESM 能处理一部分循环，
             * 但**顶层 const 初始化顺序**在环上是不可靠的，而这两个文件都在模块顶层
             * 建常量表（`SHAPE_NAME` / `RV_*`）。那类 bug 只在某些 import 顺序下出现，
             * 极难复现。
             *
             * 所以这里只做**本文件负担得起**的那部分分析：对被覆盖的带子，
             * 顺着出口走一格，看它原本供着谁。这已经能回答
             * 「覆盖它会不会让别人饿死」这个唯一重要的问题。 */
            consequences = analyzeReplacedBelts(world, replacedUids);
            const disc = consequences.would_disconnect;
            if (disc.length) {
                warnings.push({
                    code: "replace-would-disconnect",
                    detail: `覆盖这 ${replacedUids.length} 格既有带子会断开 ${disc.length} 处链接`
                        + `（下游带子 ${disc.filter(d => d.kind === "starved-belt").length} / `
                        + `下游机器 ${disc.filter(d => d.kind === "starved-machine").length}）`,
                    hint: "这是**报告的后果，不是拒绝**。若那些下游本来就是死路/残线，照常覆盖；"
                        + "若它们还在供料，覆盖后必须立刻补上，否则会把别人的线弄死。",
                });
            }
        } catch (e) {
            /* 分析失败**不等于没有后果**：如实报 unavailable，不用空数组冒充「没有问题」。 */
            consequences = { replaced_uids: replacedUids, would_disconnect: null, unavailable: String(e && e.message ? e.message : e) };
            warnings.push({
                code: "replace-consequences-unknown",
                detail: `无法分析覆盖后果（${consequences.unavailable}）—— 这不代表没有切断`,
            });
        }
    }

    if (hubAuto && ptList.length > 1) {
        warnings.push({
            code: "hub-entry-chosen",
            detail: `hub 有 ${ptList.length} 个入口，按「拐角数 → 格数」选了 entry=${pick.pt.index}（${pick.pt.cell}）；不想要就显式给 to.port={entry:N}`,
        });
    }

    const result = {
        ok: true,
        macro: "connect",
        cells_planned: cellsOut.length,
        cells_placed: cellsOut.length,     // 每格都过了 verifyChain 的逐格重解（见文件头口径说明）
        first_mismatch: null,
        /* ★ `changed.removed_uids` 是契约里**唯一规范通道** ★
         *
         * 契约（`contract.mjs` 的 `replacing-belts` 条目）写得很明确：
         *   「把 `changed.removed_uids` 里的每个 uid 纳入 tx 的 destroys
         *    （这是唯一规范通道，不要解析 detail 的格数）」。
         *
         * 而实现一直是 `[]` —— 即使 `allow_replace` 覆盖了 5 格旧带子，
         * 调用方从规范通道读到的也是「什么都没销毁」。那条 warning 让人去读这个字段，
         * 字段却是空的 ⇒ 覆盖永远进不了 tx 的 destroys ⇒ **没有回滚**。
         *
         * 2026-11-04 修：按 uid 升序确定性填入。
         * （`consequences.replaced_uids` 保留作冗余，便于日志与红队对账。） */
        changed: { added_uids: [], removed_uids: replacedUids.slice().sort((a, b) => a - b) },
        warnings,
        /* 覆盖既有带子的后果（传了 allow_replace 才会有；缺省 = 没覆盖任何东西）。
           与 `replace_run` 的 `would_disconnect` 同一口径：**报告，不阻止**。 */
        ...(consequences ? { consequences } : {}),
        error: null,
        dry_run: true,                     // 本宏不写世界；写入由调用方 tx 执行
        // ── 诊断字段（任务书要求）──
        cells: cellsOut,
        pathLen: cellsOut.length,
        choice: {
            shape: pick.sh.shape,
            via: pick.sh.via,
            split: pick.sh.split,
            turns: pick.sh.turns,
            /* legs = 权威几何：逐段 (dir, steps)。调用方要复算、要改稿、要在别处重放，
               都从这里读，**不要解析 split 字符串**（它只是人读标签）。 */
            legs: pick.sh.legs.map(l => ({ dir: l.dir, steps: l.steps })),
            fromPort: { role: pick.pf.role, index: pick.pf.index, cell: pick.pf.cell, vel: pick.pf.vel },
            toPort: { role: pick.pt.role, index: pick.pt.index, cell: pick.pt.cell, vel: pick.pt.vel },
        },
        strategy: STRATEGY_DOC,
        alternatives: ranked.length - 1,
    };
    const chk = validateMacroResult(result);
    if (!chk.ok) return failure({ code: "internal", field: chk.error.field, message: `返回值不合契约：${chk.error.message}` });
    return result;
}

/** 选形策略（原样写进返回值，调用方不必猜"为什么选了这条"） */
export const STRATEGY_DOC =
    "枚举 ≤6 转角的全部折线：方向序列逐条枚举（相邻两腿必须成直角，首格/末格自己可以转弯），"
    + "每条序列再枚举同向腿组内的整数步数拆分（a+c=A 之类），得到全部候选几何。"
    + "先丢掉撞机器/越界/末端解不出的，再按 opts.prefer 排序"
    + "（默认 fewest_turns：转角数优先、其次格数；shortest 反之；reuse_existing 优先复用既有带子），"
    + "破平用固定次序（转角少的先；中间腿 LEFT 先于 RIGHT；同形取更短）。全程无 RNG。"
    + "最后选中的那条必须再过一遍 verifyChain 的逐格自洽检查 —— 不自洽就整单报 internal，绝不返回歪的路径。";

/** 候选分数里的固定量：折线最多几个转角（超出交给阶段 3 的 Dijkstra） */
export const MAX_TURNS = 6;

/**
 * 给定两端货流方向，**理论上最少需要几个转角**（与坐标无关，只看方位关系）。
 * 用来给候选剪枝定"够好了"的标准，也是测试里"是否选了最优形态"的判据。
 *   v0 === vE           → 0（共线则可以直线，否则要 Z：2）
 *   v0 ⊥ vE             → 1（L）
 *   v0 === OPP[vE]      → 2（U 形；实际常有 1 转角的 L 变体，由几何决定）
 * 这里只给一个下界，**不**代替 verifyChain：能不能真的走通仍看坐标。
 */
export function minTurnsPossible(v0, vE) {
    if (v0 === vE) return 0;
    if (v0 === OPP[vE]) return 2;
    return 1;
}

/** 候选打分（越小越好）。乘法权重把 prefer 做成**字典序**而不是可调和的折中。 */
function scoreOf(cd, opts, world) {
    const turns = cd.sh.turns;
    const len = cd.cells.length;
    switch (opts.prefer) {
        case "shortest": return len * 1000 + turns;
        case "reuse_existing": {
            let reuse = 0;
            if (world) for (const c of cd.cells) { const r = world.cells.get(key(c[0], c[1])); if (r && r.type === "belt") reuse++; }
            return (len - reuse) * 1000 + turns;
        }
        case "fewest_turns":
        default: return turns * 1000 + len;
    }
}

/* 固定破平序：转角少的先；中间腿 LEFT 先于 RIGHT；Z 的拆分按 source-long → turn-at-source → target-long。
   这几条是**确定性**的（无 RNG），保证同一输入永远同一输出 —— 红队与逐格 diff 都依赖这一点。 */
function cmpShape(a, b) {
    return (a.turns - b.turns)
        || ((VIA_ORDER[a.via] ?? 9) - (VIA_ORDER[b.via] ?? 9))
        || ((SPLIT_ORDER_CS[a.split] ?? 9) - (SPLIT_ORDER_CS[b.split] ?? 9));
}

const describePort = p => `${p.role}#${p.index}@${p.cell}（货流 ${p.vel}）`;

/** 源端口是否已有带子接货：首格有带子且其 entry 正好朝回本端口 */
function portBoundKind(world, port) {
    const r = world.cells.get(key(port.cell[0], port.cell[1]));
    if (!r || r.type !== "belt") return null;
    const b = world.byUid.get(r.uid);
    if (!b) return null;
    return beltEntry(b.rv, b.r) === OPP[port.face] ? "accept" : null;
}
/** 宿端口是否已有供料方：同格有带子且其 exit 正好朝本端口 */
function portFedKind(world, port) {
    const r = world.cells.get(key(port.cell[0], port.cell[1]));
    if (!r || r.type !== "belt") return null;
    const b = world.byUid.get(r.uid);
    if (!b) return null;
    return beltExit(b.rv, b.r) === OPP[port.face] ? true : null;
}

/* ── 统一失败信封（契约 MacroResult + 本宏诊断字段）── */
function failure(err) {
    const e = {
        code: err.code, field: err.field === undefined ? null : err.field,
        message: err.message, hint: err.hint || null,
    };
    if (err.candidates) e.candidates = err.candidates;
    if (err.detail) e.detail = err.detail;
    return {
        ok: false, macro: "connect",
        cells_planned: 0, cells_placed: 0,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings: [],
        error: e,
        dry_run: true,
        cells: null,
        pathLen: 0,
        reason: err.message,
        firstConflict: err.firstConflict || (err.detail && err.detail.firstConflict) || null,
        choice: null,
    };
}

/* ═══════════════════════════════ 7. 自测 ═══════════════════════════════ */

const SELF_TEST = (() => {
    const argv1 = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
    return argv1.endsWith("agent/macros/connect.mjs") && process.argv.includes("--self-test");
})();

if (SELF_TEST) {
    let pass = 0, fail = 0;
    const red = s => `\x1b[31m${s}\x1b[0m`, green = s => `\x1b[32m${s}\x1b[0m`;
    const ok = (cond, name, extra) => {
        if (cond) { pass++; console.log(green("✓") + " " + name); }
        else { fail++; console.log(red("✗") + " " + name + (extra ? `  ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : "")); }
    };
    const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

    /* ── 7.0 几何事实 F1/F3/F4 的可复现断言 ── */
    {
        // F4：solveTurn 对 12 种组合穷举，全解且唯一
        let bad = 0, nonUnique = 0;
        for (const i of ORDER) for (const o of ORDER) {
            const p = solveTurn(i, o);
            if (i === o) { if (p) bad++; continue; }             // entry===exit 无解（180° 掉头）
            if (!p) { bad++; continue; }
            if (beltEntry(p.rotationVariant, p.rotation) !== i || beltExit(p.rotationVariant, p.rotation) !== o) bad++;
            let n = 0;
            for (let s = 0; s < 4; s++) for (const rv of [0, 1, 2]) if (beltEntry(rv, s * 90) === i && beltExit(rv, s * 90) === o) n++;
            if (n !== 1) nonUnique++;
        }
        eq({ bad, nonUnique }, { bad: 0, nonUnique: 0 }, "F4 belt-rules.solveTurn：12 组合全解、每种唯一、无反向解");

        // F1：真实存档 161 条带子的闭合口径
        try {
            const ents = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json"), "utf8"));
            const belts = ents.filter(e => e.type === "belt");
            const by = new Map(belts.map(e => [key(e.x, e.y), e]));
            let oppHit = 0, directHit = 0, pairs = 0;
            for (const b of belts) {
                const ex = beltExit(b.rotation_variant, b.r);
                const nb = by.get(key(b.x + DIRV[ex][0], b.y + DIRV[ex][1]));
                if (!nb) continue;
                pairs++;
                const en = beltEntry(nb.rotation_variant, nb.r);
                if (ex === OPP[en]) oppHit++;
                if (ex === en) directHit++;
            }
            ok(pairs >= 140 && oppHit >= pairs - 1, `F1 真实带子闭合口径：OPP 口径 ${oppHit}/${pairs}（任务书的 exit===entry 口径 ${directHit}/${pairs}）`);
            ok(directHit === 0, "F1 反证：exit(a)===entry(b) 口径在真实存档上 0 命中 → 任务书里那条断言是反的");
        } catch (e) {
            console.log(red("! 跳过 F1 实测：读不到 live-L4-entities.json"));
        }

        // F2：footprint 左上角原点，181 实体零重叠
        try {
            const spec = loadSpec();
            const ents = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json"), "utf8"));
            const occ = new Map(); let overlap = 0;
            for (const e of ents) {
                const vv = variantOf(spec, e.type, e.variant);
                const [w, h] = vv && vv.size ? vv.size : [1, 1];
                for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
                    const k = key(e.x + dx, e.y + dy);
                    if (occ.has(k)) overlap++;
                    occ.set(k, e.uid);
                }
            }
            eq(overlap, 0, "F2 footprint 原点=左上角：181 实体展开零重叠");
        } catch { console.log(red("! 跳过 F2 实测")); }
    }

    /* ── 7.1 纯几何：直线 4 向 ── */
    {
        const cases = [
            ["top", [0, 0], [0, -5]],
            ["bottom", [0, 0], [0, 5]],
            ["right", [0, 0], [5, 0]],
            ["left", [0, 0], [-5, 0]],
        ];
        for (const [d, S, E] of cases) {
            const cand = candidateShapes(S, d, E, d);
            const straight = cand.filter(c => c.shape === "straight");
            ok(straight.length === 1, `直线 ${d}：恰好一条 straight 候选（另有 ${cand.length - 1} 条绕行）`);
            const ch = poseChain(straight[0].cells, d, d);
            const ver = verifyChain(ch.cells);
            ok(ch.ok && ver.ok && ch.cells.length === 6, `直线 ${d}：6 格、自洽闭合`);
            // 所有绕行候选也必须自洽（枚举出来的每一条都要立得住）
            let allOk = true;
            for (const c of cand) { const cc = poseChain(c.cells, d, d); if (!cc.ok || !verifyChain(cc.cells).ok) allOk = false; }
            ok(allOk, `直线 ${d}：全部 ${cand.length} 条候选（含 4/6 转角绕行）都自洽`);
        }
    }

    /* ── 7.2 纯几何：L 形四向 ── */
    {
        const cases = [
            ["top", "right", [0, 0], [4, -3], "先上后右"],
            ["top", "left", [0, 0], [-4, -3], "先上后左"],
            ["bottom", "right", [0, 0], [4, 3], "先下后右"],
            ["bottom", "left", [0, 0], [-4, 3], "先下后左"],
            ["right", "top", [0, 0], [3, -4], "先右后上"],
            ["left", "bottom", [0, 0], [-3, 4], "先左后下"],
        ];
        for (const [v0, vE, S, E, label] of cases) {
            const cand = candidateShapes(S, v0, E, vE);
            const L = cand.find(c => c.shape === "L");
            ok(!!L, `L 形 ${label}：存在 L 候选`);
            if (!L) continue;
            const ch = poseChain(legsToCells(S, L.legs), v0, vE);
            const ver = verifyChain(ch.cells);
            const last = ch.cells[ch.cells.length - 1];
            ok(ch.ok && ver.ok, `L 形 ${label}：${ch.cells.length} 格自洽`);
            ok(last.x === E[0] && last.y === E[1], `L 形 ${label}：末格落在目标 ${E}`);
            ok(ch.cells.filter(c => c.rotationVariant !== 0).length === 1, `L 形 ${label}：恰好 1 个弯带`);
        }
    }

    /* ── 7.3 纯几何：Z 形（两转角）── */
    {
        // vE === v0 且横向错开 ⇒ 必须 Z 形
        const S2 = [0, 0], E2 = [4, -6];
        const cand = candidateShapes(S2, "top", E2, "top");
        const Z = cand.filter(c => c.shape === "Z");
        ok(Z.length >= 2, `Z 形（同向错位）：给出 ${Z.length} 条候选（拐点行/列各不相同）`);
        for (const z of Z) {
            const ch = poseChain(z.cells, "top", "top");
            const ver = verifyChain(ch.cells);
            const last = ch.cells[ch.cells.length - 1];
            ok(ch.ok && ver.ok && last.x === E2[0] && last.y === E2[1], `Z 形 split=${z.split}：${ch.cells.length} 格自洽且落在目标`);
        }
        // 「明确选定一条」：默认 fewest_turns 下 Z 必须排在 4/6 转角绕行之前
        ok(cand[0].shape === "Z", `Z 形：默认 prefer 下第一条就是 Z（实得 ${cand[0].shape}/${cand[0].turns} 转角）`);
        // vE === OPP[v0]：U 形（出去、横移、折回）——至少要有能连上的候选
        const S3 = [0, 0], E3 = [4, 0];
        const cand3 = candidateShapes(S3, "top", E3, "bottom");
        ok(cand3.length >= 1, "U 形（vE=OPP[v0]）：存在候选");
        for (const u of cand3) {
            const ch = poseChain(u.cells, "top", "bottom");
            const ver = verifyChain(ch.cells);
            const last = ch.cells[ch.cells.length - 1];
            ok(ch.ok && ver.ok && last.x === E3[0] && last.y === E3[1], `U 形 ${u.shape}/${u.turns}转角：${ch.cells.length} 格自洽`);
        }
        // 「目标在正后方且必须同向到达」⇒ 无解（任何折线都要 180° 掉头，由 solveTurn 拒绝）
        const impossible = candidateShapes([0, 0], "top", [0, 0], "top", { maxTurns: 2 });
        eq(impossible.filter(c => c.turns <= 2).length, 1, "同格 S===E（0 步）：只有 0 转角一条候选");
    }

    /* ── 7.4 负例：方向全反必须被 verifyChain 抓住 ── */
    {
        const ch = poseChain(legsToCells([0, 0], [{ dir: "top", steps: 3 }, { dir: "right", steps: 3 }]), "top", "right");
        ok(verifyChain(ch.cells).ok, "负例基准：正确路径 verifyChain 通过");

        // 负例 ①：rv1 ↔ rv2 互换（正是「13 个朝向全反」的形态之一）
        const swapped = ch.cells.map(c => ({ ...c, rotationVariant: c.rotationVariant === 1 ? 2 : c.rotationVariant === 2 ? 1 : 0, code: beltCode(c.rotationVariant === 1 ? 2 : c.rotationVariant === 2 ? 1 : 0) }));
        const v1 = verifyChain(swapped);
        ok(!v1.ok, `负例① rv1↔rv2 互换 → verifyChain 报 ${v1.breaks.length} 处断裂（必须红）`);
        ok(v1.breaks.some(b => /断裂/.test(b.why)), "负例① 抓到的是「面闭合」断裂，不是别的");

        // 负例 ②：整链旋转 180°（方向全反的另一种形态）
        const flipped = ch.cells.map(c => ({ ...c, rotation: (c.rotation + 180) % 360 }));
        ok(!verifyChain(flipped).ok, "负例② 整链 rotation+180° → verifyChain 报红");

        // 负例 ③：把其中一格的 rv 从 0 改成 1（单点错位）
        const oneBad = ch.cells.map((c, i) => i === 2 ? { ...c, rotationVariant: 1, code: 2 } : c);
        ok(!verifyChain(oneBad).ok, "负例③ 单格 rv 改错 → verifyChain 报红");

        // 负例 ④：把任务书写的错误口径用上去 —— 正确链在 exit===entry 口径下会全红
        let directOk = 0;
        for (let i = 0; i + 1 < ch.cells.length; i++) {
            const a = ch.cells[i], b = ch.cells[i + 1];
            if (beltExit(a.rotationVariant, a.rotation) === beltEntry(b.rotationVariant, b.rotation)) directOk++;
        }
        eq(directOk, 0, "负例④ 正确链在 exit===entry 口径下 0 命中 → 证明任务书那条断言写反了");
    }

    /* ── 7.5 集成：真实 machine-spec 端点 ── */
    const spec = loadSpec();
    const worldOf = ents => buildWorld(ents, spec);

    // miner(顶) → cutter(底)：直线
    {
        const ents = [
            { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
            { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        ];
        const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
        ok(r.ok, `集成·直线 矿机→切割机：ok（${r.pathLen} 格）`, r.error);
        if (r.ok) {
            ok(verifyChain(r.cells).ok, "集成·直线：返回值 verifyChain 通过");
            eq(r.cells[0], { ...r.cells[0], x: 0, y: 5 }, "集成·直线：首格 = 矿机上方一格 (0,5)");
            ok(r.cells[r.cells.length - 1].y === 1, "集成·直线：末格 = 切割机入口外一格 y=1");
            ok(r.choice.shape === "straight", "集成·直线：choice.shape=straight");
        }
    }

    // miner → balancer（2 个 acceptors，auto 必须报 ambiguous）
    {
        const ents = [
            { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
            { uid: 2, type: "balancer", x: 0, y: 0, r: 0 },
        ];
        const amb = connect({ from: { uid: 1 }, to: { uid: 2 } }, { entities: ents });
        ok(!amb.ok && amb.error.code === "ambiguous_port", "集成·ambiguous：balancer 双入口 + port:auto → ambiguous_port");
        const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "secondary" } }, { entities: ents });
        ok(r.ok, `集成·指定端口：port:"secondary" 连上（${r.ok ? r.pathLen : "-"} 格）`, r.error);
        if (r.ok) ok(r.cells[r.cells.length - 1].x === 1, "集成·指定端口：末格对齐 balancer 第二格 x=1（secondary）");
    }

    // miner → hub（16 入口，auto 走入口分配）
    {
        const ents = [
            { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
            { uid: 9, type: "hub", x: -2, y: -2, r: 0 },
        ];
        const r = connect({ from: { uid: 1 }, to: { hub: { entry: 0 } } }, { entities: ents });
        ok(r.ok, `集成·hub entry=0：连上（${r.ok ? r.pathLen : "-"} 格，入口 ${r.ok ? r.cells[r.cells.length - 1].x + "," + r.cells[r.cells.length - 1].y : "-"}）`, r.error);
        if (r.ok) {
            ok(verifyChain(r.cells).ok, "集成·hub：返回值 verifyChain 通过");
            eq([r.cells[r.cells.length - 1].x, r.cells[r.cells.length - 1].y], [-2, -3], "集成·hub entry=0 末格 = (-2,-3)（hubEntriesWorld 顶排第 0 个）");
        }
    }

    // 撞墙：路径中间放一台机器
    {
        const ents = [
            { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
            { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
            { uid: 3, type: "balancer", x: 0, y: 4, r: 0 },   // 正好挡在直线上
        ];
        const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
        ok(r.ok || r.error.code === "occupied", "撞墙：返回 ok 或 occupied（不许崩溃）", r.error);
        if (!r.ok) {
            ok(!!r.firstConflict, "撞墙：firstConflict 非空");
            ok([0, 4].includes(r.firstConflict.y) && r.firstConflict.what === "balancer", `撞墙：firstConflict 指向 (${r.firstConflict.x},${r.firstConflict.y}) ${r.firstConflict.what}`);
        } else {
            // 若选了 Z 绕开，必须自洽且不穿过 balancer 的 footprint
            ok(verifyChain(r.cells).ok, "撞墙：绕行方案（若有）仍自洽");
            ok(!r.cells.some(c => c.y === 4 && (c.x === 0 || c.x === 1)), "撞墙：绕行方案不踩 balancer footprint");
        }
    }

    // 端点不存在 / 非端口 / 自连
    {
        const ents = [{ uid: 1, type: "miner", x: 0, y: 0, r: 0 }];
        ok(connect({ from: { uid: 99 }, to: { uid: 1 } }, { entities: ents }).error.code === "endpoint_not_found", "错误码：uid 不存在 → endpoint_not_found");
        const two = [{ uid: 1, type: "miner", x: 0, y: 0, r: 0 }, { uid: 2, type: "miner", x: 0, y: 8, r: 0 }];
        ok(connect({ from: { uid: 1 }, to: { uid: 2 } }, { entities: two }).error.code === "endpoint_not_a_port",
            "错误码：目标 miner 没有 acceptor → endpoint_not_a_port");
        ok(connect({ from: { uid: 1 }, to: { uid: 1 } }, { entities: ents }).error.code === "precondition_failed",
            "错误码：自连 → precondition_failed");
    }

    // 契约：裸坐标在入参层就被拒（231 条 lint 的核心）
    {
        const bad = connect({ from: { x: 1, y: 2 }, to: { uid: 3 } }, { entities: [] });
        ok(!bad.ok && (bad.error.code === "bad_type" || bad.error.code === "unknown_field"), "契约：裸坐标端点被拒（不许 LLM 传坐标）");
    }

    /* ── 7.6 硬指标：181 实体存档上「任意两台相邻机器」── */
    {
        let ents = null;
        try { ents = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json"), "utf8")); } catch { /* ignore */ }
        if (!ents) {
            console.log(red("! 跳过硬指标：读不到 live-L4-entities.json"));
        } else {
            const machines = ents.filter(e => e.type !== "belt" && e.layer !== "underground" && !/underground/.test(e.type));
            const rectOf = e => {
                const vv = variantOf(spec, e.type, e.variant);
                const [w, h] = vv && vv.size ? vv.size : [1, 1];
                return { x0: e.x, y0: e.y, x1: e.x + w - 1, y1: e.y + h - 1 };
            };
            const gap = (a, b) => {
                const A = rectOf(a), B = rectOf(b);
                return Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1)) + Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
            };
            const hasEject = e => portsOf(buildWorld([e], spec).byUid.get(e.uid), spec).eject.length > 0;
            const hasAccept = e => portsOf(buildWorld([e], spec).byUid.get(e.uid), spec).accept.length > 0;

            // 场景 A：只有机器当障碍（考的是几何能力）
            const machinesOnly = machines.map(m => ({ ...m }));
            const wA = worldOf(machinesOnly);

            /* 「任意两台相邻机器 A→B」的口径：**端口对也是宏该挑的**（契约：多端口时 auto 是
               ambiguous_port，但调用方不该被迫理解 secondary；这里对每对机器枚举 合法端口组合，
               任一组合能连上就算 A→B 成功）。这是「宏替 LLM 算」的正确含义。 */
            const tryPair = (A, B, entities, extraOpts) => {
                const pa = portsOf(worldOf(entities).byUid.get(A.uid), spec);
                const pb = portsOf(worldOf(entities).byUid.get(B.uid), spec);
                if (!pa.eject.length || !pb.accept.length) return { ok: false, code: "endpoint_not_a_port" };
                const codes = new Set();
                /* 角色名可能重复（trash 四个面都叫 primary）→ 用 {role,index} 消歧；
                   hub 用 {hub:{}} 走入口分配（16 口不该逼调用方选）。 */
                for (const pe of pa.eject) {
                    for (const pt of pb.accept) {
                        const r = connect({
                            from: { uid: A.uid, port: { role: pe.role, index: pe.index } },
                            to: B.type === "hub" ? { hub: {} } : { uid: B.uid, port: { role: pt.role, index: pt.index } },
                            ...(extraOpts ? { opts: extraOpts } : {}),
                        }, { entities, spec });
                        if (r.ok) return r;
                        codes.add(r.error.code);
                    }
                }
                return { ok: false, code: [...codes].join("|") };
            };

            for (const LIMIT of [2, 4, 8]) {
                let total = 0, impossible = 0, eligible = 0, good = 0;
                const fails = [];
                for (const A of machines) for (const B of machines) {
                    if (A.uid === B.uid) continue;
                    if (gap(A, B) > LIMIT) continue;
                    const pa0 = portsOf(wA.byUid.get(A.uid), spec).eject;
                    const pb0 = portsOf(wA.byUid.get(B.uid), spec).accept;
                    if (!pa0.length || !pb0.length) continue;
                    total++;
                    /* 「物理上就不可能」的判据（不是找借口，是可证的）：
                       如果 A 的全部 ejector 格 或 B 的全部 acceptor 格都落在**别的机器**的
                       footprint 里，那么即使铺满带子也接不上 —— 那一格根本站不下带子。
                       典型：三个 balancer 紧贴成一排时，中间的机器出口格就是旁边机器的机身。 */
                    const freeOfMachines = c => { const o = wA.cells.get(c.join(",")); return !o || o.type === "belt"; };
                    if (!pa0.some(pe => freeOfMachines(pe.cell)) || !pb0.some(pt => freeOfMachines(pt.cell))) { impossible++; continue; }
                    eligible++;
                    const r = tryPair(A, B, machinesOnly);
                    if (r.ok) good++; else fails.push(`${A.type}@${A.x},${A.y}→${B.type}@${B.x},${B.y}: ${r.code}`);
                }
                const pct = eligible ? (100 * good / eligible) : 0;
                console.log(`   · gap≤${LIMIT}: 总 ${total} 对，其中物理不可能 ${impossible} 对，应可连 ${eligible} 对 → 成功 ${good} = ${pct.toFixed(1)}%`);
                ok(eligible > 0 && pct >= 90,
                    `硬指标·相邻机器（仅机器为障碍）×gap≤${LIMIT}: ${good}/${eligible} = ${pct.toFixed(1)}%（物理不可能 ${impossible} 对已排除）`
                    + (fails.length ? `；失败：${fails.join("; ")}` : ""));
            }

            // 场景 B：真实世界（161 条既有带子也算障碍，allow_replace=false）—— 这是诚实的拥塞指标
            {
                let n = 0, good = 0;
                for (const A of machines) for (const B of machines) {
                    if (A.uid === B.uid) continue;
                    if (gap(A, B) > 8) continue;
                    if (!hasEject(A) || !hasAccept(B)) continue;
                    n++;
                    if (tryPair(A, B, ents).ok) good++;
                }
                console.log(`· 场景B（真实世界含 161 条既有带子，allow_replace=false）: ${good}/${n} = ${n ? (100 * good / n).toFixed(1) : 0}% —— 反映拥塞，不反映几何能力`);
            }

            // 场景 C：真实世界 + allow_replace=true（可以覆盖既有带子）—— 阶段 1 的真实可用性
            {
                let n = 0, good = 0;
                for (const A of machines) for (const B of machines) {
                    if (A.uid === B.uid) continue;
                    if (gap(A, B) > 8) continue;
                    if (!hasEject(A) || !hasAccept(B)) continue;
                    n++;
                    let okc = false;
                    const pa = portsOf(worldOf(ents).byUid.get(A.uid), spec);
                    const pb = portsOf(worldOf(ents).byUid.get(B.uid), spec);
                    for (const pe of pa.eject) for (const pt of pb.accept) {
                        if (okc) break;
                        const r = connect({ from: { uid: A.uid, port: pe.role }, to: { uid: B.uid, port: pt.role }, opts: { allow_replace: true, rebind: true } }, { entities: ents, spec });
                        if (r.ok) okc = true;
                    }
                    if (okc) good++;
                }
                console.log(`· 场景C（真实世界 + allow_replace=true + rebind=true）: ${good}/${n} = ${n ? (100 * good / n).toFixed(1) : 0}% —— 阶段 1 实际可用性`);
            }
        }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}
