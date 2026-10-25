/**
 * validate.mjs — 布局编译器的离线自检器（P5 validator 独占）。
 * **产蓝图前的硬闸：编译器绝不产出会堵死的蓝图**（redteam:158 / plan §0 / C1-C6）。
 *
 * 需求单 = research/ai-player/redteam-compiler-assumptions.md:141-150「可布性必要检查清单」8 条
 * + facts/MILESTONE-M4-partial-and-pitfalls.md:59-67 的 7 条陷阱 + plan §1.5 表 V1..V10/S1。
 * 输出契约 = plan §2.4 ValidatorReport（由 P1 的 assertValidatorReport 把关，本文件不放宽）。
 *
 *   V1-occupancy                  落点矩形 vs 既有 solid（三态占用；决策 D1 ⇒ 无需旋转包围盒）
 *   V2-no-overwrite-existing-belt 规划区 ∩ WorldState.replaceableBeltCells == ∅（C1 最高危）
 *   V3-belt-fixed-point           **含机器邻居**逐格 computeBelt 不动点（belt-sim.mjs）+ 施工顺序
 *   V4-slot-alignment             通道端点 ⇄ 机器槽位 + 通道走格闭合 + 出口有 acceptor + 槽有供料
 *   V5-degree                     每节点入度 ≤ 输入槽数；退化自环（陷阱表 #3）也归本条
 *   V6-crossing                   两股流同格 / 通道穿机器占地 / 两条车道同行 → 需隧道
 *   V7-throughput                 min(节点速率) × 行数 vs 需求；弯带 0.78 折算（见 V7 注释）
 *   V8-scope                      多层 / wire / 隧道 / 旋转机器 / quad 4 路 → 显式 ok:false
 *   V9-unused-outlet              未接走的输出槽必须有 trash（陷阱表 #7）
 *   V10-unlock-report             解锁等级清单（**只报告不阻断**，C7 god-mode 口径）
 *   S1-shape-replay               shape-ops 重放每个节点，输入→输出 hash 相等
 *
 * 四条设计纪律
 *  1. **归因唯一**（变异测试硬要求："恰好报出对应 check id，其余不受染"）：
 *     一条故障只有一个 owner。V1 不管既有可替换带（V2 的活）；V4 不管入度溢出（V5 的活）；
 *     V3 只看规划区（既有世界交 V2）；V8 只看 goal/scope（不看 channel payload 的 ':'）。
 *     另外有 **blame 归属**（attribute()）：按执行序，谁的 blame 键（格/节点）先被认领谁是根因，
 *     撞上同一键的后续 fail 降级 not-applicable 并点名根因 —— **不删除、不静默**。
 *  2. 永不 throw 业务失败：越界/堵死一律 status:"fail" + errors[]（fatal）；内部异常也收敛成
 *     该 check 的 fail 并标注"P5 内部异常"（plan §0 顶层入口"永不 throw"）。
 *  3. 不 import P3/P4 的实现（防环 + 可先行，plan §7.2）：输入是 P1 类型（LayoutReport /
 *     CompiledPlan.entities）+ fixture 手工构造。方向/槽位真值只经 src/ai/belt-rules.mjs
 *     与 src/ai/op-templates.mjs（P2）。CORNER_COST_TILES 在 P4 里同名，本包独立声明并对拍。
 *  4. 零依赖；**不 import proto/belt-rules.mjs**（已知错误副本，plan §1.1 lint / §3 陷阱）。
 *     proto/shape-ops.mjs 是只读复用（plan §2.4 S1 明写"只 import 不改"）；
 *     形状 hash 另在本地复刻一份（hashOf），使 S1 的几何闸不依赖 proto 可加载性。
 *
 * 运行：node src/ai/compiler/validate.mjs --test            （判据自测 + 变异矩阵，见 test.mjs）
 *       node src/ai/compiler/validate.mjs --plan <file.json>（L1.5 可布性闸，plan §5）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ORDER, OPP, DIRV, norm360, beltCode, beltEntry, beltExit, rotateLocal } from "../belt-rules.mjs";
import {
    resolveTemplates, RATES, UNLOCK_LEVEL_FALLBACK,
    templateByBuildingVariant, codeFor, v1ScopeReason, hubEntriesWorld,
} from "../op-templates.mjs";
import { assertValidatorReport, assertLayoutReport, entityOrderPhase } from "./types.mjs";
import { Grid, SOLID, REPLACEABLE, PLACE_MACHINE, PLACE_BELT } from "./grid.mjs";
import { CHECK_IDS, validateReason, makeFailure } from "./errors.mjs";
import { simulateBelts } from "./belt-sim.mjs";
// S1 用：形状运算的离线复刻（**只 import 不改**；与 proto/belt-rules 那份错误副本无关）
import * as SHAPE_OPS from "../../../research/ai-player/proto/shape-ops.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 模板表：走 P2 的 resolveTemplates()（带缓存，machine-spec.json 存在则覆盖内嵌表）。
 * research/ai-plan/data/NOTES.md:257 明确要求 P3/P4/P5 统一走它，别各自读 JSON。
 * 缺 spec 文件时它退回内嵌表并记 gap（不会抛），所以本包不依赖 spec 的可加载性。
 */
const TEMPLATES = resolveTemplates().templates;

/* ════════════════════════════════ 常量 ════════════════════════════════ */

export const VALIDATOR_VERSION = 1;
/** plan §2.4 的 11 条 check id（报告顺序）。 */
export const CHECK_ORDER = Object.freeze([...CHECK_IDS]);

/**
 * 弯带 0.78 的折算系数。真值 = recon/upstream-full/src/js/game/components/belt.js:6
 * `curvedBeltLength = 0.78`、`:64-71` getEffectiveLengthTiles()（直带 1.0 / 弯带 0.78）。
 * ⚠️ P4 的 route.mjs 里同名常量 CORNER_COST_TILES；本包不 import P4（防环 + 可先行），
 *    所以独立声明，**值必须相同** —— L0 有对拍断言（见 test.mjs A5）。
 * ⚠️ 它是**弧长**不是容量系数（routing-prior-art.md:347-352 明确警告），用法见 V7 注释。
 */
export const CURVED_EFFICIENCY = 0.78;

/** v1 范围外的建筑 kind（V8）。 */
export const OUT_OF_SCOPE_KINDS = Object.freeze([
    "wire", "underground_belt", "balancer", "storage", "reader", "filter", "display",
    "lever", "logic_gate", "constant_signal", "virtual_processor", "item_producer", "block",
]);
/** v1 可产出的 kind（plan §2.2 迁移路径 5 + op-templates isV1Emittable 的编译器侧口径）。 */
export const V1_KINDS = Object.freeze(["miner", "belt", "cutter", "rotater", "painter", "stacker", "mixer", "trash", "hub"]);

/** 通道走格上限（防御无限环；超过即认定路由不闭合）。 */
const MAX_WALK = 256;
/** 隧道最大跨度（与 place.mjs / route.mjs 同值；P5 独立声明，不跨层 import）。 */
const TUNNEL_MAX_SPAN = 4;

/* ════════════════════════════════ 小工具 ════════════════════════════════ */

const key = (x, y) => `${x},${y}`;
const parseKey = k => k.split(",").map(Number);
const add = (cell, dir, n = 1) => [cell[0] + DIRV[dir][0] * n, cell[1] + DIRV[dir][1] * n];
const isBeltKind = k => k === "belt";
const fmt = v => (v === null || v === undefined ? "null" : String(v));
const knode = id => (id ? `node:${id}` : null);
const shortKeyGrammar = s => typeof s === "string" && /^[RCSWrgbypcwu-]{8}(:[RCSWrgbypcwu-]{8})*$/.test(s);
const clone = o => JSON.parse(JSON.stringify(o));

/** 造一条 check（§2.4 evidence 五字段齐全，note 永不空）。 */
function check(id, status, e) {
    if (!CHECK_IDS.includes(id)) throw new Error(`unknown check id ${id}`);
    return { id, status, evidence: { cell: e.cell ?? null, nodeId: e.nodeId ?? null, expected: e.expected ?? null, actual: e.actual ?? null, note: e.note } };
}
/** 造一条 error（§2.4 errors[]）。 */
function error(checkId, nodeId, cell, message, severity = "fatal") {
    return { check: checkId, severity, nodeId: nodeId ?? "", cell: cell ?? null, message };
}
/** 认领 blame 键（格 "x,y" / 节点 "node:<id>" / 通道 "ch:<idx>"）。 */
function claim(ctx, id, keys) {
    const set = new Set((keys || []).map(k => (Array.isArray(k) ? `${k[0]},${k[1]}` : k)).filter(Boolean));
    ctx.claims.set(id, set);
}

/* ════════════════════════ 输入归一（P1 类型 → 内部视图） ════════════════════════ */

/**
 * 接受三种输入（都属 P1 类型，不需要 P3/P4 的实现）：
 *   a) CompiledPlan（fixtures/plan-l1.json）—— 用 plan.layout + plan.entities + plan.scope/goal
 *   b) LayoutReport（fixtures/report-layout.json）—— 需 opts.entities（beltIntent）才能跑 V3/V4
 *   c) 裸对象 {layout, entities, scope, goal}
 * ⚠️ 结构性非法输入（不是 CompiledPlan/LayoutReport 形态）→ **显式抛 TypeError**：
 *    那是调用方用错了 API（programmer error），不是业务失败；业务失败一律走
 *    {status:"fail", errors[]}。绝不把"根本没图可判"的东西静默当成 pass:false 的绿灯反面。
 * @param {object} input
 * @param {{entities?:Array, world?:object, demandPerSec?:number, currentLevel?:number|null,
 *          enforceUnlocks?:boolean, strict?:boolean, dag?:Array, goal?:string, scope?:object,
 *          chargeMode?:string, shapeOps?:object|null, checkEntityOrder?:boolean}} [opts]
 */
export function normalizeInput(input, opts = {}) {
    if (input === null || input === undefined) throw new TypeError("validate: 输入不能是 null/undefined（要 CompiledPlan / LayoutReport / {layout,entities}）");
    if (typeof input !== "object" || Array.isArray(input)) throw new TypeError(`validate: 输入必须是对象，实得 ${typeof input === "object" ? "Array" : typeof input}`);
    const layout = input.layout && typeof input.layout === "object" ? input.layout : (Array.isArray(input.placements) ? input : null);
    if (!layout) throw new TypeError("validate: 找不到 LayoutReport（input.layout 或 input.placements）");
    return {
        goal: opts.goal ?? input.goal ?? null,
        scope: opts.scope ?? input.scope ?? null,
        layout,
        entities: opts.entities || input.entities || layout.entities || [],
        world: opts.world || input.world || null,
        demandPerSec: opts.demandPerSec ?? input.demandPerSec ?? 0,
        currentLevel: opts.currentLevel !== undefined ? opts.currentLevel : (input.currentLevel ?? null),
        enforceUnlocks: opts.enforceUnlocks === true,
        chargeMode: opts.chargeMode ?? (input.stats ? input.stats.chargeMode : null) ?? "false",
        strict: opts.strict === true,
    };
}

/**
 * 既有世界的**三态占用网格**（§2.6 WorldState + §2.3 LayoutReport.occupancy）。
 * ⚠️ 三态（empty / occupied_solid / occupied_replaceable）与冲突矩阵的**实现真值在 P1 的
 *    grid.mjs**（plan §1.1 明写 Grid 必须支持三态；§1.5 说 P5 依赖 P1）。所以这里只负责
 *    "把世界灌进 Grid"，V1/V2 的判定一律走 Grid.placementConflicts —— 不另写一份冲突语义。
 *    灌入用 try/catch 包住：Grid.set 对同格二次占用**抛错**（这是 P1 的正确语义 —— 写入必须严格），
 *    而既有世界/存档拍平数据本来就有多实体同格（182 条隧道压在带子上），这里要的是**查询**
 *    不是写入，所以同格后来者跳过（先入者为准，C1：绝不覆盖既有实体）。
 * @returns {Grid}
 */
export function worldGrid(view) {
    const g = new Grid({ name: "p5-existing-world" });
    for (const o of view.layout.occupancy || []) {
        try { g.set(o.cell[0], o.cell[1], o.who || "world", { state: o.state === "replaceable" ? REPLACEABLE : SOLID, kind: o.kind || (o.state === "replaceable" ? "belt" : "machine"), isAnchor: true }); } catch { /* 同格已占：先入者为准 */ }
    }
    const w = view.world;
    if (w) {
        const rep = w.replaceableBeltCells instanceof Set ? w.replaceableBeltCells : new Set(w.replaceableBeltCells || []);
        for (const k of rep) { const [x, y] = parseKey(k); try { g.set(x, y, `world:${k}`, { state: REPLACEABLE, kind: "belt", isAnchor: true }); } catch { /* 已占 */ } }
        for (const e of w.entities || []) {
            if (e.type === "belt" || e.type === "wire") { try { g.set(e.x, e.y, `uid:${e.uid}`, { state: REPLACEABLE, kind: e.type, isAnchor: true }); } catch { /* 已占 */ } continue; }
            const t = templateByBuildingVariant(e.type, e.variant || "default");
            const [fw, fh] = t ? t.footprint : [1, 1];
            for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) {
                try { g.set(e.x + dx, e.y + dy, `uid:${e.uid}`, { state: SOLID, kind: e.type }); } catch { /* 已占 */ }
            }
        }
    }
    return g;
}

/** 占用审计：规划区每个落点 vs Grid 的冲突矩阵（一次算完，V1/V2 各取所需）。
 *  @returns {{solid:Array, replaceable:Array, self:Array}} 三项都是 {cell,nodeId,kind,...} */
function occupancyAudit(ctx) {
    if (ctx.occ) return ctx.occ;
    const { view } = ctx;
    const g = worldGrid(view);
    const solid = [], replaceable = [], self = [];
    const seen = new Map();
    for (const p of view.layout.placements || []) {
        const [w, h] = p.footprint || [1, 1];
        for (const c of g.placementConflicts(p.cell[0], p.cell[1], w, h, PLACE_MACHINE, { rot: p.rot || 0 })) {
            (c.state === SOLID ? solid : replaceable).push({ cell: c.cell, nodeId: p.nodeId, kind: p.kind, who: c.who, hitKind: c.kind, by: "machine" });
        }
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
            const k = key(p.cell[0] + dx, p.cell[1] + dy);
            const prev = seen.get(k);
            if (prev && prev.nodeId !== p.nodeId) self.push({ cell: [p.cell[0] + dx, p.cell[1] + dy], a: prev, b: { nodeId: p.nodeId, kind: p.kind } });
            else seen.set(k, { nodeId: p.nodeId, kind: p.kind });
        }
    }
    for (const e of view.entities) {
        if (!isBeltKind(e.kind)) continue;
        for (const c of g.placementConflicts(e.dx, e.dy, 1, 1, PLACE_BELT)) {
            (c.state === SOLID ? solid : replaceable).push({ cell: [e.dx, e.dy], nodeId: e.nodeId, kind: "belt", who: c.who, hitKind: c.kind, by: "belt" });
        }
        const k = key(e.dx, e.dy);
        const prev = seen.get(k);
        if (prev) self.push({ cell: [e.dx, e.dy], a: prev, b: { nodeId: e.nodeId, kind: "belt" } });
        else seen.set(k, { nodeId: e.nodeId, kind: "belt" });
    }
    // 只在 entities 里、不在 placements 里的机器（LayoutReport-only 输入的兜底）
    for (const e of view.entities) {
        if (isBeltKind(e.kind)) continue;
        if ((view.layout.placements || []).some(p => p.nodeId === e.nodeId)) continue;
        for (const c of g.placementConflicts(e.dx, e.dy, 1, 1, PLACE_MACHINE, { rot: e.rot || 0 })) {
            (c.state === SOLID ? solid : replaceable).push({ cell: [e.dx, e.dy], nodeId: e.nodeId, kind: e.kind, who: c.who, hitKind: c.kind, by: "machine" });
        }
    }
    ctx.occ = { solid, replaceable, self, grid: g, planned: [...seen.entries()].map(([k, v]) => ({ cell: parseKey(k), ...v })) };
    return ctx.occ;
}

/** 落点格属于哪个实体（规划机器 / entities 里的机器 / 既有 hub）；带子返回 null。 */
function hostAt(view, cell) {
    for (const p of view.layout.placements || []) {
        const [w, h] = p.footprint || [1, 1];
        if (cell[0] >= p.cell[0] && cell[0] < p.cell[0] + w && cell[1] >= p.cell[1] && cell[1] < p.cell[1] + h) return { nodeId: p.nodeId, kind: p.kind };
    }
    const k = key(cell[0], cell[1]);
    const e = view.entities.find(x => !isBeltKind(x.kind) && key(x.dx, x.dy) === k);
    if (e) return { nodeId: e.nodeId, kind: e.kind };
    const occ = (view.layout.occupancy || []).find(o => key(o.cell[0], o.cell[1]) === k);
    if (occ) return { nodeId: occ.who || occ.kind || "world", kind: occ.kind || "solid" };
    return null;
}

/**
 * hub 的**锚点**（4×4 左上角格），不是某个入口格。
 * 凭据序：WorldState 里 type=hub 的实体 → layout.occupancy 里 kind=hub 的最小格
 * → layout.hubConnection.entry（P3 记的是入口格 = anchor+[0,4]，需反推）→ null。
 * ⚠️ 为什么要反推：plan-l1 的 hub 属于**既有世界**、不在 entities 里，只以 16 格 occupancy 出现；
 *    直接把入口格 (0,-1) 当锚点会让 16 个槽位全部错位 → V4 假 fail。
 */
export function hubAnchorOf(view) {
    const w = view.world;
    if (w && Array.isArray(w.entities)) { const h = w.entities.find(e => e.type === "hub"); if (h) return [h.x, h.y]; }
    if (w && w.hub) return [w.hub.x, w.hub.y];
    const occ = (view.layout.occupancy || []).filter(o => o.kind === "hub" || o.who === "hub");
    if (occ.length) return [Math.min(...occ.map(o => o.cell[0])), Math.min(...occ.map(o => o.cell[1]))];
    const hc = view.layout.hubConnection;
    if (hc && hc.entry) {
        const e = view.entities.find(x => x.kind === "hub");
        if (e) return [e.dx, e.dy];
        // 反推锚点：**按 side 分支**，绝不一律 y-4（那是底排专属，顶/左/右三面全错一格序列）。
        // P3 的 hubConnection.entry = 带子末格 = hub 锚点外侧那一格；偏移表与 P2 的
        // hubEntriesWorld（上游 hub.js:73-91 同源）逐面对齐。
        const [ex, ey] = hc.entry;
        const FACE = { bottom: [0, -4], top: [0, 1], left: [1, 0], right: [-4, 0] };
        const off = FACE[hc.side];
        if (!off) return null;                        // side 非法 → **不猜**，返回 null，让 V4 显式 fail
        const a = [ex + off[0], ey + off[1]];
        // 自证：按 P3 声称的那个面反推出的锚点，其 16 入口表里必须真有这个入口格。
        // 对不上说明 (side, entry) 本身就矛盾 ⇒ 同样返回 null（不猜、不静默放过）。
        return hubEntriesWorld(a).some(h2 => h2.cell[0] === ex && h2.cell[1] === ey) ? a : null;
    }
    return null;
}

/** nodeId（或端点 cell）→ {template, kind, cell(锚点), rot, footprint}。 */
function resolveNode(view, nodeId, cell) {
    const ps = view.layout.placements || [];
    let p = nodeId ? ps.find(x => x.nodeId === nodeId) : null;
    if (!p && cell) p = ps.find(x => { const [w, h] = x.footprint || [1, 1]; return cell[0] >= x.cell[0] && cell[0] < x.cell[0] + w && cell[1] >= x.cell[1] && cell[1] < x.cell[1] + h; });
    if (p) return { placement: p, template: TEMPLATES[p.op] || templateByBuildingVariant(p.kind, "default"), kind: p.kind, cell: p.cell, rot: p.rot || 0, footprint: p.footprint || [1, 1] };
    if (nodeId === "hub" || (cell && hostAt(view, cell)?.kind === "hub")) {
        const anchor = hubAnchorOf(view) ?? cell ?? null;
        return { placement: null, template: TEMPLATES.hub, kind: "hub", cell: anchor, rot: 0, footprint: [4, 4] };
    }
    const e = view.entities.find(x => x.nodeId === nodeId && !isBeltKind(x.kind));
    if (e) return { placement: null, template: TEMPLATES[e.kind] || templateByBuildingVariant(e.kind, "default"), kind: e.kind, cell: [e.dx, e.dy], rot: e.rot || 0, footprint: [1, 1] };
    return { placement: null, template: null, kind: null, cell: cell ?? null, rot: 0, footprint: [1, 1] };
}

/** 模板槽位的世界形态（v1 机器恒 r=0；rot≠0 走 V8，这里仍按上游公式算以便诊断）。 */
function worldSlotsOf(template, rot, anchor) {
    if (!template || !anchor) return { inputs: [], outputs: [] };
    const conv = list => (list || []).map(s => ({ tile: localTile(s.cell, rot, anchor), dir: rotateLocal(s.dir, norm360(rot)), role: s.role ?? null, filter: s.filter ?? null }));
    return { inputs: conv(template.inputs), outputs: conv(template.outputs) };
}
/** 局部格 → 世界格（上游 static_map_entity.js:182-188 + vector.js:503-525；同 belt-sim 的实现）。 */
function localTile(cell, rotation, origin) {
    const r = norm360(rotation), [x, y] = cell;
    const o = r === 0 ? [x, y] : r === 90 ? [-y, x] : r === 180 ? [-x, -y] : r === 270 ? [y, -x] : (() => { throw new Error(`localTile: 非 90 倍数角度 ${rotation}`); })();
    return [o[0] + origin[0], o[1] + origin[1]];
}

/** 该实体**应当**有的 code（belt 族 = beltCode(rv)；其余 = codeFor(building,variant,r=0,rv=0)）。
 *  building/variant 从 placement 的 **op** 反查（同一个 kind 可能有多个 variant，
 *  例如 miner/default=7 与 miner/chainable=8 —— 只看 kind 会把 chainable 误判成 code 不符）。
 *  查不到凭据时返回 null（不猜 —— plan §1.6「不得手填 magic number」，也不许编译器瞎补）。 */
function codeOf(view, e) {
    if (isBeltKind(e.kind)) return beltCode(e.rotationVariant || 0);
    if ((e.rotationVariant || 0) !== 0) return null;                 // 非 belt rv≠0 由另一条 vios 报，不重复
    const n = resolveNode(view, e.nodeId, [e.dx, e.dy]);
    const t = n.template || TEMPLATES[e.kind];
    if (!t) return null;
    try { return codeFor(t.building, t.variant, 0, 0); } catch { return null; }
}

/** 带子的**权威**朝向：一律从 (r,rv) 现推；存储的 inDir/outDir 只是文档。 */
/* 隧道（underground_belt）不走 beltEntry/beltExit：那套是给 rv∈{0,1,2} 的普通带子算转弯的，
   而隧道的 code 是 22/23、rv 只表示 sender/receiver。它的方向就是实体上记的 inDir/outDir。 */
const beltDirs = e => (e.kind === "underground_belt"
    ? { entry: e.inDir, exit: e.outDir }
    : { entry: beltEntry(e.rotationVariant, e.rot), exit: beltExit(e.rotationVariant, e.rot) });

/* ════════════════════════ 通道合法性预检（V5 认领，V4/V6/V9/S1 跳过） ════════════════════════ */
/**
 * 通道图的**非法边**（纯图论、不看几何）：
 *   - 退化/自环 from==to（陷阱表 #3：place_path 报 2001 中断整条脚本）
 *   - 溢出边：某节点入度 > 输入槽数后**多出来**的那些通道（redteam:146）
 * 它们的几何失败是 V5 那条非法边的**派生**（自环没有"下游"可走、第 3 条边根本没有空槽），
 * 后续判据一律跳过，否则一次注入报出 4 个 id，违反"恰好报出对应 check"。
 */
function edgeAudit(view) {
    const selfLoops = new Set(), excess = new Set(), byNode = [];
    const chs = view.layout.channels || [];
    const idxByTarget = new Map();
    chs.forEach((c, i) => {
        if (c.from.nodeId === c.to.nodeId && c.from.cell[0] === c.to.cell[0] && c.from.cell[1] === c.to.cell[1]) { selfLoops.add(i); return; }
        if (!idxByTarget.has(c.to.nodeId)) idxByTarget.set(c.to.nodeId, []);
        idxByTarget.get(c.to.nodeId).push(i);
    });
    for (const [nodeId, list] of idxByTarget) {
        const n = resolveNode(view, nodeId, chs[list[0]].to.cell);
        const cap = n.template ? (n.template.inputs || []).length : Infinity;
        if (list.length > cap) { byNode.push({ nodeId, kind: n.kind, cap, got: list.length, cell: n.cell }); list.slice(cap).forEach(i => excess.add(i)); }
    }
    return { selfLoops, excess, byNode, skip: new Set([...selfLoops, ...excess]) };
}

/* ════════════════════════════════ 主入口 ════════════════════════════════ */

/**
 * 跑 V1..V10 + S1，产出 §2.4 ValidatorReport。**永不 throw 业务失败。**
 *
 * 执行序（≠ 报告序；报告一律按 CHECK_ORDER 重排）：
 *   V8 → V1 → V2 → V5 → V3 → V4 → V6 → V9 → V7 → V10 → S1
 * V8 最先：越界形态（旋转机器 / wire / 隧道 / quad 4 路）下槽位表与不动点都没有真值定义，
 * 继续判会把**一次**越界报成一串错；被它阻断的 check 记 not-applicable 并点名根因，
 * **不静默跳过**（变异测试的"其余 check 不受染"= 其余不得出现 fail）。
 * V3 排在 V4/V6 之前：rv 漂移是"唯一要防住的东西"（plan §2.4），由它认领根因。
 *
 * @param {CompiledPlan|LayoutReport|object} input
 * @param {object} [opts] 见 normalizeInput
 * @returns {ValidatorReport}
 */
export function validate(input, opts = {}) {
    const ctx = makeContext(input, opts);
    const checks = [], errors = [];
    for (const run of RUNNERS) {
        const blockedBy = ctx.blockers.filter(b => (BLOCKED_BY[b] || []).includes(run.id));
        if (blockedBy.length) {
            checks.push(check(run.id, "not-applicable", {
                expected: `${run.id} 的判据可执行`, actual: "被前置闸阻断",
                note: `前置闸 ${blockedBy.join("/")} 已 fail：该形态下本条的几何/物流真值未定义（v1 的槽位表与不动点判据只在范围内布局上成立）。原始判据见 NOTES『归因与被染』`,
            }));
            continue;
        }
        try {
            run(ctx, checks, errors);
        } catch (err) {
            const where = String((err && err.stack) || "").split("\n").slice(1, 3).map(l => l.trim()).join(" <- ");
            checks.push(check(run.id, "fail", {
                expected: "判据正常执行", actual: String((err && err.message) || err),
                note: `P5 内部异常（判据 bug，不是布局 bug）${where ? " @ " + where : ""}`,
            }));
            errors.push(error(run.id, "", null, `${run.id} crashed: ${err && err.message}${where ? " @" + where : ""}`));
        }
        if (checks.some(c => c.id === run.id && c.status === "fail")) ctx.blockers.push(run.id);
    }
    const suppressed = attribute(ctx, checks, errors);
    const report = assemble(ctx, checks, errors);
    report.suppressed = suppressed;
    if (ctx.strict) assertValidatorReport(report, "validation");
    return report;
}

/** 前置闸 → 被它阻断的 check（只在"继续判没有真值定义"时才阻断）。
 *  V8：越界形态下 v1 的槽位表/不动点都没有真值定义。
 *  V3：rv 漂移 ⇒ 由 (r,rv) 推导的进/出向本身就不成立，链闭合与流交叉的判定基础同时失效
 *      （带子意图表是 P7 对拍的凭据，漂移先修再谈几何）。V1/V2/V5/V7/V9/V10/S1 不依赖
 *      带向真值，照常执行。 */
export const BLOCKED_BY = Object.freeze({
    "V8-scope": ["V3-belt-fixed-point", "V4-slot-alignment", "V5-degree", "V6-crossing", "V9-unused-outlet", "S1-shape-replay"],
    "V3-belt-fixed-point": ["V4-slot-alignment", "V6-crossing"],
});

/**
 * blame 归属：按执行序，撞上已认领键的 fail 判为**派生**，降级 not-applicable 并点名根因。
 *
 * ⚠️ 只在**显式声明的派生关系**上降级，绝不"凡键相撞就降级"。
 *    反例（曾真实踩到）：golden 场景里 V4 的『输入槽空供料』与 V9 的『输出槽无去向』
 *    共享 node:n1 + cell(0,0) 两个键，但它们是**两个独立缺陷**；若按键相撞就把 V9 吞掉，
 *    等于闸门自己把 redteam 清单第 9 条弄丢（比多报一个严重得多）。
 *    粗粒度阻断交给 BLOCKED_BY（V8/V3 → 一批判据），通道级非法边交给 edgeAudit（V5 认领）。
 */
const DERIVES = Object.freeze({
    "V4-slot-alignment": ["V5-degree"],
    "V6-crossing": ["V3-belt-fixed-point", "V4-slot-alignment", "V5-degree"],
    "S1-shape-replay": ["V4-slot-alignment", "V5-degree"],
});
function attribute(ctx, checks, errors) {
    const accepted = [], suppressed = [];
    for (const c of checks) {
        if (c.status !== "fail") continue;
        const keys = ctx.claims.get(c.id) || new Set();
        const allow = DERIVES[c.id] || [];
        const root = keys.size && allow.length
            ? accepted.find(a => allow.includes(a.id) && [...keys].some(k => a.keys.has(k)))
            : null;
        if (root) {
            c.status = "not-applicable";
            c.evidence = {
                cell: c.evidence.cell, nodeId: c.evidence.nodeId,
                expected: `${c.id} 的判据可执行`, actual: "故障与根因同源，已归因给前序 check",
                note: `派生自 ${root.id}（同一根因键 ${[...keys].filter(k => root.keys.has(k)).join(", ")}）；本条没有独立缺陷`,
            };
            for (let i = errors.length - 1; i >= 0; i--) if (errors[i].check === c.id) errors.splice(i, 1);
            suppressed.push({ id: c.id, root: root.id });
            continue;
        }
        accepted.push({ id: c.id, keys });
    }
    return suppressed;
}

/** 校验 + 顺带给 §2.1 的失败对象（P8 分诊用；plan §0「永不 throw」）。 */
export function validateWithFailure(input, opts = {}) {
    const report = validate(input, opts);
    if (report.pass) return { report, failure: null };
    const first = report.errors.find(e => e.severity === "fatal") || report.errors[0];
    return { report, failure: makeFailure(validateReason(first.check), { nodeId: first.nodeId || null, cell: first.cell, check: first.check }, first.message) };
}

function makeContext(input, opts) {
    const view = normalizeInput(input, opts);
    if (view.strict) assertLayoutReport(view.layout, "layout", { allowRotatedMachine: true });
    return {
        view, claims: new Map(), blockers: [], audit: null, sim: null,
        orderCheck: opts.checkEntityOrder !== false,
        shapeReplay: [], throughput: null, unlockRows: [],
        ops: opts.shapeOps === null ? null : (opts.shapeOps || SHAPE_OPS),
        dag: opts.dag || input.dag || null,
    };
}

/** §2.4 报告装配（顺序 = CHECK_ORDER；缺判据补 not-applicable，绝不静默缺项）。 */
function assemble(ctx, checks, errors) {
    const ordered = [];
    for (const id of CHECK_ORDER) {
        const found = checks.filter(c => c.id === id);
        ordered.push(...(found.length ? found : [check(id, "not-applicable", { note: "本条未执行（RUNNERS 未覆盖该 id = P5 自身缺陷）" })]));
    }
    const sim = ctx.sim || { tilesChecked: 0, fixedPoints: 0, drift: [] };
    return {
        pass: errors.length === 0,
        checks: ordered,
        errors,
        beltSim: {
            tilesChecked: sim.tilesChecked, fixedPoints: sim.fixedPoints,
            drift: sim.drift.map(d => ({ cell: d.cell, wantRv: d.wantRv, gotRv: d.gotRv })),
            includesMachineNeighbors: true,          // ← §2.4 硬规定
        },
        shapeReplay: ctx.shapeReplay,
        throughput: ctx.throughput || { demandPerSec: ctx.view.demandPerSec, bottleneck: null, rowsRequired: 1, rowsPlanned: 1 },
    };
}

/* ════════════════════════ V1 落点占用 ════════════════════════ */
/* redteam:142-143 / C1：落点矩形全空；多格机器按 r=0 包围盒（D1 ⇒ 无需旋转包围盒）；
 * 三态里 replaceable **对非带子算冲突**。既有可替换带本身留给 V2（归因唯一）。 */
const runV1 = (ctx, checks, errors) => {
    const { view } = ctx;
    const audit = occupancyAudit(ctx);
    // V1 认领：撞既有 solid（任何落点）+ 落点自撞 + **机器**压既有可替换带
    //（redteam:143 的"replaceable 对非带子算冲突"）。带子压可替换带留给 V2（归因唯一）。
    const worldHits = audit.solid;
    const machineOnReplaceable = audit.replaceable.filter(h => h.by === "machine");
    const hits = [...worldHits, ...machineOnReplaceable];
    const selfHits = audit.self;

    if (selfHits.length || hits.length) {
        const isSelf = !!selfHits.length;
        const first = isSelf ? selfHits[0] : hits[0];
        const list = isSelf ? selfHits : hits;
        claim(ctx, "V1-occupancy", list.flatMap(h => [h.cell, knode(h.nodeId), h.a && knode(h.a.nodeId), h.b && knode(h.b.nodeId)].filter(Boolean)));
        checks.push(check("V1-occupancy", "fail", {
            cell: first.cell, nodeId: first.nodeId ?? null,
            expected: "落点矩形全空（r=0 包围盒；replaceable 对非带子算冲突）",
            actual: isSelf
                ? `${selfHits.length} 格自撞：${first.a.nodeId} 与 ${first.b.nodeId} 同要 (${first.cell.join(",")})`
                : `${hits.length} 格撞既有实体：(${first.cell.join(",")}) 属 ${first.who}/${first.hitKind}`,
            note: isSelf ? "一格两实体 = 作图 bug（陷阱表 #2/#3：行列偏移累积误差）"
                : "C1：落既有机器 → 该格进 failed 而其余格照常放置 = 半建线（堵死）→ 整单 abort",
        }));
        errors.push(error("V1-occupancy", first.nodeId ?? "", first.cell, isSelf
            ? `规划自撞 (${first.cell.join(",")})：${first.a.nodeId} ↔ ${first.b.nodeId}（C1 三态占用：非空格一律 abort）`
            : `规划区 (${first.cell.join(",")}) 压到既有 ${first.hitKind}（${first.who}）：paste 该格 game_rejected、其余照常 → 半建线（C1）`));
        return;
    }
    const planned = audit.planned;
    checks.push(check("V1-occupancy", "pass", {
        cell: planned.length ? planned[0].cell : null, nodeId: planned.length ? planned[0].nodeId : null,
        expected: "落点矩形全空（r=0 包围盒）",
        actual: `${planned.length} 格全空（机器 ${(view.layout.placements || []).length} 台 + 带子 ${view.entities.filter(e => isBeltKind(e.kind)).length} 格）`,
        note: "决策 D1：机器恒 r=0 → 无需旋转包围盒；三态占用与冲突矩阵一律走 P1 的 Grid.placementConflicts",
    }));
};
runV1.id = "V1-occupancy";

/* ════════════════════════ V2 零覆盖既有可替换带 ════════════════════════ */
/* redteam:102-112 / C1：paste 落在既有 belt/wire 上会被 freeEntityAreaBeforeBuild
 * （logic.js:139-165）**静默销毁**，applied/failed 不报告删了什么（真实事故：毁过 6 条带）。
 * 判据 = 规划的**带子**格 ∩ 既有 replaceable == ∅（机器压可替换带归 V1）。 */
const runV2 = (ctx, checks, errors) => {
    const hits = occupancyAudit(ctx).replaceable.filter(h => h.by === "belt");
    if (hits.length) {
        const h = hits[0];
        claim(ctx, "V2-no-overwrite-existing-belt", hits.flatMap(t => [t.cell, knode(t.nodeId)]));
        checks.push(check("V2-no-overwrite-existing-belt", "fail", {
            cell: h.cell, nodeId: h.nodeId ?? `belt@${h.cell.join(",")}`,
            expected: "规划区 ∩ replaceableBeltCells = ∅",
            actual: `${hits.length} 格重叠：(${h.cell.join(",")}) 既有${h.hitKind === "wire" ? " wire" : "带"}（${h.who}）`,
            note: "C1 最高危：paste 静默销毁可替换实体、applied/failed 不报告被删了什么 → 整单 abort（v1 无 allowOverwrite）",
        }));
        errors.push(error("V2-no-overwrite-existing-belt", h.nodeId ?? "", h.cell,
            `规划区 (${h.cell.join(",")}) 压住既有可替换带（${h.who}）：paste 会静默销毁它且不报告 → 整单 abort（C1；曾毁 6 条真实带）`));
        return;
    }
    checks.push(check("V2-no-overwrite-existing-belt", "pass", {
        expected: "规划区 ∩ replaceableBeltCells = ∅",
        actual: `0 格重叠（既有可替换格 ${countReplaceable(occupancyAudit(ctx).grid)} 个，全在规划区外）`,
        note: "破坏半径的最终凭据是 paste dry_run（mod 缺口 → MOD-GAPS.md）；本闸只判零重叠",
    }));
};
runV2.id = "V2-no-overwrite-existing-belt";

/** 既有网格里 replaceable 格的总数（V2 的 pass 证据用）。 */
function countReplaceable(grid) {
    let n = 0;
    for (const [, rec] of grid) if (rec.state === REPLACEABLE) n++;
    return n;
}

/* ════════════════════════ V3 含机器邻居的带子不动点 + 施工顺序 ════════════════════════ */
/* redteam:144 / plan §2.4 / §6 R1 —— **唯一能防住 rv 漂移的闸**。
 * 现成 proto 脚本只喂带子邻居（82.5%），结论不可复用（编译器产的带子必然贴机器）。
 * 第二判据：陷阱表 #6「不能边想边放」—— entities 顺序必须 机器→直线带→拐角带。
 * 顺序错 ⇒ 该带在**定型时刻**邻居不齐（游戏按当时的邻居写回 rv），与"非不动点"同一语义，
 * 所以由 V3 认领（映射理由见 NOTES『陷阱表 → check id』）。 */
const runV3 = (ctx, checks, errors) => {
    const { view } = ctx;
    const belts = view.entities.filter(e => isBeltKind(e.kind));
    if (!belts.length) {
        checks.push(check("V3-belt-fixed-point", "not-applicable", {
            expected: "每条带子是 computeBelt(含机器邻居) 不动点", actual: "规划区无带子格",
            note: "没有带子就没有可漂的东西（beltSim 计数 0，includesMachineNeighbors 仍为 true）",
        }));
        return;
    }
    // 既有世界的带子**不进**邻居模型：v1 只做全新址，增量场景已被 V2 阻断；
    // 让它们参与会把"V2 已 abort 的布局"的次生噪声算到 V3 头上（归因唯一）。
    const sim = simulateBelts(view.layout, { entities: view.entities, iterate: false });
    ctx.sim = sim;

    // 施工顺序（陷阱表 #6）。opts.checkEntityOrder===false 关闭它 —— 变异测试要用它
    // 隔离"只注入一种故障"（追加机器会顺带破坏分层序，那不是被注入的那一条）。
    const orderBad = ctx.orderCheck === false ? [] : orderViolation(view);

    if (sim.drift.length || orderBad.length) {
        const d = sim.drift[0];
        claim(ctx, "V3-belt-fixed-point", [
            ...sim.drift.map(x => x.cell),
            ...sim.drift.map(x => knode(x.nodeId || `belt@${x.cell.join(",")}`)),
            ...sim.drift.map(x => knode(`belt@${x.cell.join(",")}`)),
            ...orderBad.flatMap(o => [knode(o.early.nodeId), knode(o.late.nodeId), o.late.cell]),
        ]);
        const onlyOrder = !d;
        checks.push(check("V3-belt-fixed-point", "fail", {
            cell: d ? d.cell : orderBad[0].late.cell ?? null,
            nodeId: d ? (d.nodeId || `belt@${d.cell.join(",")}`) : orderBad[0].early.nodeId,
            expected: onlyOrder ? "entities 顺序 = 机器 → 直线带 → 拐角带" : `(${d.gotRot},${d.gotRv}) 是 computeBelt 不动点`,
            actual: d ? `rv 漂到 ${d.wantRv}${d.wantRot !== d.gotRot ? `、rotation 漂到 ${d.wantRot}` : ""}（drift ${sim.drift.length}/${sim.tilesChecked}${orderBad.length ? `；另含 ${orderBad.length} 处施工顺序错` : ""}）`
                : `第 ${orderBad[0].lateIndex} 项 ${orderBad[0].late.kind}/rv=${orderBad[0].late.rotationVariant} 排在 ${orderBad[0].early.kind}/rv=${orderBad[0].early.rotationVariant} 之前`,
            note: d ? "§2.4：V3 是唯一能防住 rv 漂移的闸；漂移全在邻居含机器的角落（belt-rules.mjs:8-10）"
                : "陷阱表 #6：先放的带子按**当时的**邻居定型，后来邻居变了也不会更新 ⇒ 定型时刻不满足不动点条件",
        }));
        if (d) for (const dd of sim.drift) errors.push(error("V3-belt-fixed-point", dd.nodeId || `belt@${dd.cell.join(",")}`, dd.cell,
            `(${dd.cell.join(",")}) 的 (r,rv)=(${dd.gotRot},${dd.gotRv}) 在含机器邻居下不是 computeBelt 不动点（期望 rv=${dd.wantRv}${dd.wantRot !== dd.gotRot ? `, r=${dd.wantRot}` : ""}）：贴上去物流会在第一个拐角死掉`));
        for (const o of orderBad) errors.push(error("V3-belt-fixed-point", o.late.nodeId, o.late.cell ?? null,
            `施工顺序错（陷阱表 #6）：${o.late.kind}/rv=${o.late.rotationVariant} (${o.lateIndex}) 排在 ${o.early.kind}/rv=${o.early.rotationVariant} 之前 ⇒ 邻居不齐时定型`));
        return;
    }
    checks.push(check("V3-belt-fixed-point", "pass", {
        cell: [belts[0].dx, belts[0].dy], nodeId: belts[0].nodeId,
        expected: "computeBelt(含机器邻居) 不动点 = 设计的 (r,rv)",
        actual: `${sim.fixedPoints}/${sim.tilesChecked} 全是不动点；施工顺序合规`,
        note: `includesMachineNeighbors=true（邻居含机器 ${sim.machineNeighbors} 次、带子 ${sim.beltNeighbors} 次）—— 现成 proto 脚本只喂带子，其 82.5% 不可复用；`
            + "stride=4 ⇒ originalRotation=rotation（bridge:814），不动点成立即绕过 R2",
    }));
};
runV3.id = "V3-belt-fixed-point";

/** 分层序：**直接用 P1 的 entityOrderPhase**（plan §3 冲突仲裁：P1 已发布的共享真值不许二次实现）。
 *  0=机器（P3）1=直线带（P4）2=拐角带（最后放）—— 同 plan §2.1「entities 顺序」+ 陷阱表 #6。 */
const orderPhase = entityOrderPhase;
/** 违规项的落点格（带子取自身 dx/dy；机器没有 dx/dy 时回退到 placement）。 */
const entCell = e => (typeof e.dx === "number" && typeof e.dy === "number" ? [e.dx, e.dy] : null);
function orderViolation(view) {
    const out = [];
    let maxPhase = -1, maxItem = null, maxIndex = -1;
    view.entities.forEach((e, i) => {
        const ph = orderPhase(e);
        if (ph < maxPhase) out.push({ early: { ...maxItem, cell: entCell(maxItem), index: maxIndex }, late: { ...e, cell: entCell(e), index: i }, lateIndex: i });
        else if (ph > maxPhase) { maxPhase = ph; maxItem = e; maxIndex = i; }
    });
    return out;
}

/* ════════════════════════ V5 入度 ≤ 输入槽数（+ 退化段） ════════════════════════ */
/* redteam:146：stacker/mixer 只有 2 个 bottom、cutter=1；N>2 必须先二叉化成树。
 * 陷阱表 #3 的退化段（from==to 自环）同归本条：自环是一条非法入边（place_path 会报 2001）。 */
const runV5 = (ctx, checks, errors) => {
    const { view } = ctx;
    const audit = ctx.audit || (ctx.audit = edgeAudit(view));
    const over = audit.byNode.map(x => ({ ...x, selfLoop: false }));
    const self = [...audit.selfLoops].map(i => (view.layout.channels || [])[i]).filter(Boolean);
    if (self.length) {
        const n = resolveNode(view, self[0].to.nodeId, self[0].to.cell);
        over.push({
            nodeId: self[0].to.nodeId, kind: n.kind, cell: self[0].to.cell, selfLoop: true,
            cap: (n.template ? (n.template.inputs || []).length : "?"),
            got: `${(view.layout.channels || []).filter(c => c.to.nodeId === self[0].to.nodeId).length}（含 ${self.length} 条自环）`,
        });
    }
    if (over.length) {
        const o = over[0];
        claim(ctx, "V5-degree", over.flatMap(x => [
            x.cell, knode(x.nodeId),
            ...(view.layout.channels || []).filter(c => c.to.nodeId === x.nodeId).map(c => knode(c.from.nodeId)),
        ].filter(Boolean)));
        checks.push(check("V5-degree", "fail", {
            cell: o.cell, nodeId: o.nodeId,
            expected: `${o.kind} 入度 ≤ 输入槽数 ${o.cap}`, actual: `fanIn=${o.got}`,
            note: o.selfLoop ? "退化通道 from==to（陷阱表 #3：place_path 报 2001 中断整条脚本）—— 自环不是合法入边，路径生成器必须过滤零长度段"
                : (o.got > 2 ? "N>2 必须先二化成二叉树（stacker/mixer 只有 2 个 bottom，redteam:147）" : "入度溢出 = 至少一条通道无处落槽 → 该分支堵死"),
        }));
        errors.push(error("V5-degree", o.nodeId, o.cell, o.selfLoop
            ? `退化通道：${o.nodeId} 的通道 from==to（同节点同格自环）→ 必须过滤零长度段（陷阱表 #3）`
            : `${o.kind} ${o.nodeId} 入度 ${o.got} > 槽位 ${o.cap}：${o.got > 2 ? "必须先二叉化" : "有通道接不上"}（redteam:146）`));
        return;
    }
    checks.push(check("V5-degree", "pass", {
        expected: "每节点入度 ≤ 输入槽数（stacker/mixer=2、cutter=1、trash=4）+ 无退化自环",
        actual: `${(view.layout.placements || []).length} 个落点、${(view.layout.channels || []).length} 条通道全满足`,
        note: "无 N>2 汇合（有的话先二化成树，redteam:147）；quad cutter 的 4 路输出越界 → 归 V8",
    }));
};
runV5.id = "V5-degree";

/* ════════════════════════ V4 槽位对齐 / 链闭合 ════════════════════════ */
/* redteam:142 / GEOMETRY 表3：每根带子的 exit 落在下游 acceptor 槽、entry 承接上游 ejector 槽。
 * 五条子判据（任一破裂都算 V4 fail，只报第一处；入度/退化边交 V5，V5 认领的通道这里跳过）：
 *   a 通道端点 ∈ 该节点模板的槽位（方位也对）
 *   a2 存储的 inDir/outDir == 由 (r,rv) 推导值（意图表可信性）
 *   b 每条通道在规划区里能走通（逐格轴对齐）
 *   c 逐带格链闭合 exit(u) == OPP(entry(v))
 *   d 带子出口顶着的机器格那一方位真是它的输入槽（否则物品撞墙）
 *   e 生产机的每个输入槽都有供料（上游带子 / 声明过的通道 / 邻机直连） */
const runV4 = (ctx, checks, errors) => {
    const { view } = ctx;
    const audit = ctx.audit || (ctx.audit = edgeAudit(view));
    const bad = [], keys = [];
    const beltByCell = new Map();
    /* 隧道也进这张表：walkChannel 要在 sender 处识别"接下来是跳跃"；
       表里没有它会走到 sender 就当"没有带子格"判死（V4 超时的根因）。 */
    for (const e of view.entities) if (isBeltKind(e.kind) || e.kind === "underground_belt") beltByCell.set(key(e.dx, e.dy), e);
    const fedSlots = new Map();

    for (const [ci, ch] of (view.layout.channels || []).entries()) {
        if (audit.skip.has(ci)) continue;                      // V5 的非法边，不在此双报
        for (const end of [ch.from, ch.to]) {
            const n = resolveNode(view, end.nodeId, end.cell);
            if (!n.template) { bad.push({ cell: end.cell, nodeId: end.nodeId, kind: "端点节点无模板", detail: `${end.nodeId}（kind=${fmt(n.kind)}）查不到 OpTemplate` }); continue; }
            const slots = worldSlotsOf(n.template, n.rot, n.cell);
            const list = end === ch.from ? slots.outputs : slots.inputs;
            // trash 四边全收都在同格（trash.js:74-92）⇒ 先按 (格,方位) 精确匹配，退而按格匹配
            const hit = list.find(s => s.tile[0] === end.cell[0] && s.tile[1] === end.cell[1] && (!end.slot || s.dir === end.slot))
                || list.find(s => s.tile[0] === end.cell[0] && s.tile[1] === end.cell[1]);
            if (!hit) { bad.push({ cell: end.cell, nodeId: end.nodeId, kind: "端点不在槽位上", detail: `(${end.cell.join(",")}) 不是 ${end.nodeId}(${fmt(n.kind)}) 的${end === ch.from ? "输出" : "输入"}槽` }); continue; }
            if (end.slot && hit.dir !== end.slot) { bad.push({ cell: end.cell, nodeId: end.nodeId, kind: "槽位方位不符", detail: `${end.nodeId} 槽 (${end.cell.join(",")}) 世界方位=${hit.dir}，通道写的是 ${end.slot}` }); continue; }
            if (end === ch.to) fedSlots.set(`${end.nodeId}|${hit.tile.join(",")}|${hit.dir}`, true);
        }
        const walk = walkChannel(ch, beltByCell, view);
        if (!walk.ok) { keys.push(`ch:${ci}`, knode(ch.from.nodeId), knode(ch.to.nodeId), ...walk.path.map(c => c), walk.at); bad.push({ cell: walk.at || ch.from.cell, nodeId: ch.from.nodeId, kind: "通道不闭合", detail: walk.detail }); }
    }

    // a2) 意图表与 (r,rv) 一致
    for (const e of view.entities) {
        if (!isBeltKind(e.kind)) continue;
        const d = beltDirs(e);
        if ((e.outDir != null && e.outDir !== d.exit) || (e.inDir != null && e.inDir !== d.entry)) {
            bad.push({ cell: [e.dx, e.dy], nodeId: e.nodeId, kind: "意图表与 (r,rv) 不符", detail: `存储 in=${fmt(e.inDir)}/out=${fmt(e.outDir)}，而 r=${e.rot} rv=${e.rotationVariant} 推得 entry=${d.entry}/exit=${d.exit}` });
        }
    }
    // c) 带链逐格闭合
    for (const u of view.entities.filter(e => isBeltKind(e.kind))) {
        const { exit } = beltDirs(u);
        const v = beltByCell.get(key(...add([u.dx, u.dy], exit)));
        if (!v) continue;                                       // 下游是机器/hub/空格 → d)/b) 负责
        const vEntry = beltDirs(v).entry;
        if (vEntry !== OPP[exit]) bad.push({ cell: [u.dx, u.dy], nodeId: u.nodeId, kind: "带链断裂", detail: `(${u.dx},${u.dy}) exit=${exit} 而 (${v.dx},${v.dy}) entry=${vEntry}（应 ${OPP[exit]}）` });
    }
    // d) 出口有真实 acceptor
    const sinks = [];
    for (const b of view.entities.filter(e => isBeltKind(e.kind))) {
        const { exit } = beltDirs(b);
        const dst = add([b.dx, b.dy], exit);
        if (beltByCell.has(key(dst[0], dst[1]))) continue;      // 下游是带子，链闭合已判
        const host = hostAt(view, dst);
        if (!host) continue;                                    // 空格 = 路由缺口，b) 已报
        const n = resolveNode(view, host.nodeId, host.cell);
        if (!n.template) continue;
        const want = OPP[exit];
        const slots = worldSlotsOf(n.template, n.rot, n.cell);
        const ok = slots.inputs.some(s => s.tile[0] === dst[0] && s.tile[1] === dst[1] && s.dir === want)
            || (n.kind === "trash" && slots.inputs.some(s => s.tile[0] === dst[0] && s.tile[1] === dst[1]));
        if (!ok) sinks.push({ nodeId: b.nodeId, cell: [b.dx, b.dy], dst, want, hostNode: host.nodeId, hostKind: n.kind });
    }
    // e) 生产机输入槽有供料（V5 认领的溢出节点跳过：它的槽位天然不够）
    const unfed = [];
    const claimedByV5 = new Set(audit.byNode.map(x => x.nodeId).concat([...audit.selfLoops].map(i => (view.layout.channels || [])[i]?.to.nodeId)));
    for (const p of view.layout.placements || []) {
        if (claimedByV5.has(p.nodeId)) continue;
        const n = resolveNode(view, p.nodeId, p.cell);
        if (!n.template || !(n.template.inputs || []).length || !(n.template.outputs || []).length) continue;
        for (const s of worldSlotsOf(n.template, n.rot, n.cell).inputs) {
            const srcTile = add(s.tile, s.dir);
            const upBelt = beltByCell.get(key(srcTile[0], srcTile[1]));
            const fedByBelt = !!upBelt && beltDirs(upBelt).exit === OPP[s.dir];
            const fedByChannel = fedSlots.get(`${p.nodeId}|${s.tile.join(",")}|${s.dir}`);
            const fedByMachine = !upBelt && machineEjectsInto(view, srcTile, s);
            if (!fedByBelt && !fedByChannel && !fedByMachine) unfed.push({ nodeId: p.nodeId, cell: s.tile, dir: s.dir, role: s.role, kind: p.kind });
        }
    }

    if (bad.length || sinks.length || unfed.length) {
        const first = bad[0] || null;
        claim(ctx, "V4-slot-alignment", [
            ...keys, ...bad.flatMap(x => [x.cell, knode(x.nodeId)]),
            ...sinks.flatMap(s => [s.cell, s.dst, knode(s.nodeId), knode(s.hostNode)]),
            ...unfed.flatMap(u => [u.cell, knode(u.nodeId)]),
        ]);
        const pick = first || (sinks.length ? { cell: sinks[0].cell, nodeId: sinks[0].nodeId, kind: "出口无 acceptor", detail: `带子 (${sinks[0].cell.join(",")}) 出口指向 (${sinks[0].dst.join(",")}) 的 ${sinks[0].want} 方位，那里不是 ${sinks[0].hostNode}(${sinks[0].hostKind}) 的输入槽` }
            : { cell: unfed[0].cell, nodeId: unfed[0].nodeId, kind: "输入槽空供料", detail: `${unfed[0].kind} ${unfed[0].nodeId} 的 (${unfed[0].cell.join(",")}) ${unfed[0].dir}${unfed[0].role ? "/" + unfed[0].role : ""} 没有任何上游供料` });
        checks.push(check("V4-slot-alignment", "fail", {
            cell: pick.cell ?? null, nodeId: pick.nodeId ?? null,
            expected: "带子 exit 落在下游 acceptor 槽、entry 承接上游 ejector 槽（GEOMETRY 表3）",
            actual: `${pick.kind}：${pick.detail}`,
            note: first ? "断链 = 物品停在半路（M4：两条分支各自完美、汇合区死掉）"
                : (sinks.length ? "M4 的『物品停在 rotater 输出、没到 stacker』就是这个形态（撞墙）"
                    : "空输入槽 = 该机器不收件 → 上游带子无处可去（redteam #4；颜料通道缺失见 GEOMETRY 规则6）"),
        }));
        errors.push(error("V4-slot-alignment", pick.nodeId ?? "", pick.cell ?? null, `槽位对齐失败（${pick.kind}）：${pick.detail}`));
        return;
    }
    checks.push(check("V4-slot-alignment", "pass", {
        expected: "端点 ∈ 模板槽位 + 通道走通 + 链闭合 + 出口有 acceptor + 生产槽有供料",
        actual: `${(view.layout.channels || []).length - audit.skip.size} 条通道 / ${beltByCell.size} 带格全对齐`,
        note: "槽位真值 = P2 OP_TEMPLATES + rotateSlot（v1 机器恒 r=0）；带向真值 = src/ai/belt-rules.mjs（**不 import proto 那份**）",
    }));
};
runV4.id = "V4-slot-alignment";

/** srcTile 是否是某台机器的输出槽、且朝 slotTile 的那个方位喷（邻机直连供料）。 */
function machineEjectsInto(view, srcTile, slot) {
    const host = hostAt(view, srcTile);
    if (!host) return false;
    const n = resolveNode(view, host.nodeId, host.cell);
    if (!n.template || !(n.template.outputs || []).length) return false;
    return worldSlotsOf(n.template, n.rot, n.cell).outputs
        .some(o => o.tile[0] === srcTile[0] && o.tile[1] === srcTile[1] && o.dir === OPP[slot.dir]);
}

/**
 * 沿通道从 from.cell 走到 to.cell。端点几何（logic.js:421-434 的槽位语义）：
 *   ejector 槽在格 T、世界方向 D ⇒ 目标格 = T + DIRV[D]（首带格）
 *   acceptor 槽在格 T、世界方向 D ⇒ 源格   = T + DIRV[D]（末带格）
 * 所以末带格 = to.cell + DIRV[to.inDir]（**加**：inDir 是"从哪个方位收"）。
 */
function walkChannel(ch, beltByCell, view) {
    const startTile = add(ch.from.cell, ch.from.outDir);
    const goal = ch.to.cell, lastBelt = add(goal, ch.to.inDir);
    const path = [];
    /* 走格上限**按端点跨度动态给**：固定的 256 只够短通道，而长通道（多矿机目标里
       矿机铺开 300+ 格）本来就是几十到几百格 —— 拿 256 判它"环"是误判（实测 ch7 跨 385 格）。
       仍保留上限（跨度 + 余量），环依旧会被抓到，只是不再冤枉长通道。 */
    const span = Math.abs(goal[0] - startTile[0]) + Math.abs(goal[1] - startTile[1]);
    const walkCap = Math.max(MAX_WALK, span * 3 + 16);
    if (startTile[0] === goal[0] && startTile[1] === goal[1]) return { ok: true, path };
    let cur = startTile, prevDir = ch.from.outDir;
    for (let step = 0; step < walkCap; step++) {
        const at = beltByCell.get(key(cur[0], cur[1]));
        if (!at) {
            if (cur[0] === goal[0] && cur[1] === goal[1]) return { ok: true, path };
            return { ok: false, path, at: [...cur], detail: `走到 (${cur.join(",")}) 没有带子格（路由缺口 = 陷阱表 #2 对角缺口）` };
        }
        path.push([cur[0], cur[1]]);
        const d = beltDirs(at);
        if (d.entry !== OPP[prevDir]) return { ok: false, path, at: [...cur], detail: `(${cur.join(",")}) entry=${d.entry} 与来向 ${prevDir} 不接（应 ${OPP[prevDir]}）` };
        if (cur[0] === lastBelt[0] && cur[1] === lastBelt[1]) {
            if (d.exit !== OPP[ch.to.inDir]) return { ok: false, path, at: [...cur], detail: `末格 (${cur.join(",")}) exit=${d.exit}，但 ${ch.to.nodeId} 输入槽 (${goal.join(",")})/${ch.to.inDir} 要 ${OPP[ch.to.inDir]}` };
            return { ok: true, path };
        }
        /* ★ 隧道跳跃 ★
           走到 sender（code 22）后，下一格不是相邻格，而是沿同方向找到的 receiver（code 23）——
           中间那些格被"穿过"、本来就没有实体。不跳这一步的话，walker 会在空档处判定
           「没有带子格（路由缺口）」，把一条合法通道判死（实测 V4 走满 256 格超时）。 */
        if (at.code === 22) {
            const dir = d.exit;
            let hop = cur;
            let found = null;
            for (let k = 0; k < (TUNNEL_MAX_SPAN + 1); k++) {
                hop = add(hop, dir);
                const nx = beltByCell.get(key(hop[0], hop[1]));
                /* 中间格**可能站着别的通道的带子**（隧道正是用来穿过它的）——
                   不能因为"有实体"就停，只有碰到 receiver 才算到达。 */
                if (nx && nx.code === 23) { found = hop; break; }
            }
            if (!found) return { ok: false, path, at: [...cur], detail: `sender (${cur.join(",")}) 前方 ${TUNNEL_MAX_SPAN + 1} 格内没有配对的 receiver（隧道不成立）` };
            prevDir = d.exit;
            cur = found;
            continue;
        }
        prevDir = d.exit;
        cur = add(cur, d.exit);
    }
    return { ok: false, path, detail: `走满 ${MAX_WALK} 格仍未到终点（环/无限延伸）` };
}

/** 通道在规划区占的带格序列（走不到终点返回 null）。 */
function channelCells(ch, beltByCell) {
    const out = [];
    let cur = add(ch.from.cell, ch.from.outDir);
    const goal = ch.to.cell, lastBelt = add(goal, ch.to.inDir);
    for (let step = 0; step < MAX_WALK; step++) {
        if (cur[0] === goal[0] && cur[1] === goal[1]) return out;
        const at = beltByCell.get(key(cur[0], cur[1]));
        if (!at) return null;
        out.push([cur[0], cur[1]]);
        if (cur[0] === lastBelt[0] && cur[1] === lastBelt[1]) return out;
        cur = add(cur, beltDirs(at).exit);
    }
    return null;
}

/* ════════════════════════ V6 流交叉 → 需隧道 ════════════════════════ */
/* redteam:149 / C6 第 4/5 条 / 陷阱表 #4#5：regular 层一格一实体（logic.js:61-104），
 * 两条流要在同一格相遇必须有隧道；v1 无隧道（C4 隧道还会 smartplace 删带）→ 报
 * "dag-not-placeable:crossing-needs-tunnel"，**不硬凑**。三条子判据：
 *   ① 同一带格承载两股不同 payload
 *   ② 通道走格路径穿过**别人的**机器占地（+y 系与 painter(+x) 系硬串同一直线的典型后果）
 *   ③ 两条车道同一行（陷阱表 #5） */
const runV6 = (ctx, checks, errors) => {
    const { view } = ctx;
    const audit = ctx.audit || (ctx.audit = edgeAudit(view));
    const beltByCell = new Map();
    /* 隧道也进这张表：walkChannel 要在 sender 处识别"接下来是跳跃"；
       表里没有它会走到 sender 就当"没有带子格"判死（V4 超时的根因）。 */
    for (const e of view.entities) if (isBeltKind(e.kind) || e.kind === "underground_belt") beltByCell.set(key(e.dx, e.dy), e);
    const payloads = new Map(), owners = new Map(), clashes = [], thru = [];

    (view.layout.channels || []).forEach((ch, ci) => {
        if (audit.skip.has(ci)) return;
        const cells = channelCells(ch, beltByCell);
        if (!cells) return;                                      // 断链由 V4 报，这里不双报
        for (const c of cells) {
            const k = key(c[0], c[1]);
            if (!payloads.has(k)) { payloads.set(k, new Set()); owners.set(k, new Set()); }
            payloads.get(k).add(ch.payload);
            owners.get(k).add(knode(ch.from.nodeId) + "→" + knode(ch.to.nodeId));
        }
        // ② 穿别人的机器占地
        for (const c of cells) {
            const host = hostAt(view, c);
            if (host && host.nodeId !== ch.from.nodeId && host.nodeId !== ch.to.nodeId) {
                thru.push({ cell: c, hostNode: host.nodeId, hostKind: host.kind, ch: `${ch.from.nodeId}→${ch.to.nodeId}` });
            }
        }
    });
    for (const [k, set] of payloads) if (set.size > 1) {
        const [x, y] = parseKey(k);
        clashes.push({ cell: [x, y], payloads: [...set], owners: [...owners.get(k)] });
    }
    // ③ 车道同行/同列（陷阱表 #5）：同一条**轨道**上挂了两条以上、承载不同 payload 的通道。
    //    轨道的身份 = **(轴, 下标)**，不是裸整数（LANE_SCHEMA_VERSION=2）：
    //      row=3（水平车道行）与 column=3（竖直车道列）是两条完全不同的轨道，
    //      P4 现在真的会同时产出它们（vlane 打开后收集带的列号常与某条行车道同号）。
    //      只按裸整数分组 = 把两条正交的车道误报成「同排穿格」→ 假 crossing。
    //    轴来源：channels[].laneAxis（缺省/null ⇒ "row"，兼容 v1 报告与 fixture）。
    //    两个凭据：通道自己的 (laneAxis, lane) 字段；LayoutReport.lanes[] 的台账条目（{row}|{column}）。
    const laneKeyOf = c => `${c.laneAxis === "col" ? "col" : "row"}:${c.lane}`;
    /** 人读标签：`row:3` → "lane=3"（行车道沿用旧词，评测/日志兼容）、`col:3` → "column=3"。
     *  兼容不带轴前缀的键（防御性：只看整数字面量时也不至于打印成空串）。 */
    const laneLabel = k => {
        const s = String(k);
        if (s.startsWith("col:")) return `column=${s.slice(4)}`;
        if (s.startsWith("row:")) return `lane=${s.slice(4)}`;
        return `lane=${s}`;
    };
    const ledgerKeyOf = l => `${l.column === null || l.column === undefined ? "row" : "col"}:${l.column === null || l.column === undefined ? l.row : l.column}`;
    const laneSeen = new Map();
    (view.layout.channels || []).forEach((c, i) => {
        if (c.lane === null || c.lane === undefined || audit.skip.has(i)) return;
        const k = laneKeyOf(c);
        if (!laneSeen.has(k)) laneSeen.set(k, []);
        laneSeen.get(k).push(i);
    });
    const dupLane = [...laneSeen].map(([lane, list]) => ({ lane, list, payloads: [...new Set(list.map(i => (view.layout.channels || [])[i].payload))] }))
        .filter(x => x.list.length > 1 && x.payloads.length > 1);
    const ledgerConflict = (view.layout.lanes || []).find(l => (l.channelIds || []).length > 1 && new Set(l.channelIds).size > 1);
    const ledgerKey = ledgerConflict ? ledgerKeyOf(ledgerConflict) : null;

    const hit = clashes[0] || thru[0] || null;
    if (hit) {
        claim(ctx, "V6-crossing", [hit.cell, ...(clashes.flatMap(c => c.owners || [])), knode(hit.hostNode)]);
        checks.push(check("V6-crossing", "fail", {
            cell: hit.cell, nodeId: null,
            expected: "两股流不穿格（regular 层一格一实体）",
            actual: clashes[0] ? `(${hit.cell.join(",")}) 同时承载 ${hit.payloads.length} 股流：${hit.payloads.join(" / ")}`
                : `通道 ${hit.ch} 的带格 (${hit.cell.join(",")}) 落在 ${hit.hostNode}(${hit.hostKind}) 的占地里`,
            note: "v1 无隧道 → 必须换车道/换址/换配方；同格相遇 = 需 underground_belt，而 C4：隧道 smartplace 会在 paste 中途删带",
        }));
        errors.push(error("V6-crossing", hit.owners ? hit.owners[0] : hit.ch, hit.cell,
            clashes[0] ? `两股流穿同一格 (${hit.cell.join(",")})：${hit.payloads.join(" / ")} → 需隧道，v1 不支持（redteam:149）`
                : `流穿机器占地：带格 (${hit.cell.join(",")}) 属 ${hit.hostNode}(${hit.hostKind}) → 需隧道/绕行（+y 与 +x 系不可硬串，GEOMETRY 表3 规则3）`));
        return;
    }
    if (dupLane.length || ledgerConflict) {
        claim(ctx, "V6-crossing", dupLane.length ? dupLane[0].list.map(i => knode(view.layout.channels[i].from.nodeId)) : [knode("lane")]);
        const d = dupLane[0];
        checks.push(check("V6-crossing", "fail", {
            expected: "不同分支的车道必须不同行/列（陷阱表 #5；同一轨道 = 同 (轴, 下标)）",
            actual: d ? `车道 ${laneLabel(d.lane)} 被 ${d.list.length} 条通道共用，承载 ${d.payloads.join(" / ")}`
                : `lanes 台账行 ${ledgerKey} 上挂了 ${ledgerConflict.channelIds.length} 条车道：${ledgerConflict.channelIds.join(",")}`,
            note: "同一轨道上的车道会互相穿格 → 需隧道/立体绕行，v1 拒绝（redteam:150 第 4 条）。对策：加宽行距 + 换 lane 号",
        }));
        errors.push(error("V6-crossing", d ? knode(view.layout.channels[d.list[0]].from.nodeId).slice(5) : "", d ? view.layout.channels[d.list[0]].from.cell : null,
            d ? `车道 ${laneLabel(d.lane)} 被 ${d.list.length} 条通道共用（${d.payloads.join(" / ")}）→ 同轨穿格，需隧道，v1 不支持（陷阱表 #5）`
                : `车道 ${ledgerKey} 冲突（${ledgerConflict.channelIds.join(",")}）→ 需隧道，v1 不支持（台账行）`));
        return;
    }
    checks.push(check("V6-crossing", "pass", {
        expected: "两股流不穿格 + 车道分行 + 不穿机器占地", actual: "0 处",
        note: (view.layout.lanes || []).length ? "车道分行 → 不需要隧道（v1 无隧道）" : "单通道布局，天然无交叉",
    }));
};
runV6.id = "V6-crossing";

/* ════════════════════════ V9 废弃输出必须有去向 ════════════════════════ */
/* 陷阱表 #7（pitfalls:67）：cutter 的另一半不接走 → 堵死整机（开发期 B3 的根因）。
 * mustDiscardUnused 的机器，每个**没有下游**的输出槽必须由 trash 接走。 */
const runV9 = (ctx, checks, errors) => {
    const { view } = ctx;
    const audit = ctx.audit || (ctx.audit = edgeAudit(view));
    const beltByCell = new Map();
    /* 隧道也进这张表：walkChannel 要在 sender 处识别"接下来是跳跃"；
       表里没有它会走到 sender 就当"没有带子格"判死（V4 超时的根因）。 */
    for (const e of view.entities) if (isBeltKind(e.kind) || e.kind === "underground_belt") beltByCell.set(key(e.dx, e.dy), e);
    const channels = (view.layout.channels || []).filter((c, i) => !audit.skip.has(i));
    const stranded = [];
    for (const p of view.layout.placements || []) {
        const n = resolveNode(view, p.nodeId, p.cell);
        const t = n.template;
        if (!t || t.mustDiscardUnused === false) continue;
        for (const s of worldSlotsOf(t, n.rot, n.cell).outputs) {
            const hasChannel = channels.some(c => c.from.nodeId === p.nodeId && c.from.cell[0] === s.tile[0] && c.from.cell[1] === s.tile[1]);
            if (hasChannel) continue;
            const dst = add(s.tile, s.dir);
            if (receiverAt(view, beltByCell, dst)) continue;             // 槽位直接顶着 trash/带子
            const path = channels.some(c => c.from.nodeId === p.nodeId && channelCells(c, beltByCell)?.some(cc => cc[0] === s.tile[0] && cc[1] === s.tile[1]));
            if (path) continue;
            stranded.push({ nodeId: p.nodeId, kind: p.kind, cell: s.tile, dir: s.dir, role: s.role });
        }
    }
    if (stranded.length) {
        const s = stranded[0];
        claim(ctx, "V9-unused-outlet", stranded.flatMap(x => [x.cell, knode(x.nodeId)]));
        checks.push(check("V9-unused-outlet", "fail", {
            cell: s.cell, nodeId: s.nodeId,
            expected: "每个未接走的输出槽必须有 trash",
            actual: `${s.kind} 的槽 ${fmt(s.role)} (${s.cell.join(",")}) ${s.dir} 无去向`,
            note: "陷阱表 #7：废弃输出不接走 → 整机堵死（开发期 B3 卡住的根因；layout-grid.mjs:90-92 的对策 = 自动补 trash）",
        }));
        errors.push(error("V9-unused-outlet", s.nodeId, s.cell,
            `${s.kind} ${s.nodeId} 的 (${s.cell.join(",")}) ${s.dir} 输出槽未接走且无 trash → 整机堵死；对策：自动补 trash（陷阱表 #7）`));
        return;
    }
    checks.push(check("V9-unused-outlet", "pass", {
        expected: "每个未接走的输出槽必须有 trash", actual: "0 个空转输出槽",
        note: "被接走的走 V4；这里只管 mustDiscardUnused 机器的剩余槽（陷阱表 #7）",
    }));
};
runV9.id = "V9-unused-outlet";

/** dst 格上是否有能收件的东西（trash 四边全收 / hub 入口 / 任何带子）。
 *  ⚠️ 必须走 worldSlotsOf —— 模板里的槽位是**局部** {cell,dir}，换算后才是世界 {tile,dir}。 */
function receiverAt(view, beltByCell, dst) {
    if (beltByCell.has(key(dst[0], dst[1]))) return true;
    const host = hostAt(view, dst);
    if (!host) return false;
    const n = resolveNode(view, host.nodeId, host.cell);
    if (!n.template) return false;
    return worldSlotsOf(n.template, n.rot, n.cell).inputs.some(s => s.tile[0] === dst[0] && s.tile[1] === dst[1]);
}

/* ════════════════════════ V7 吞吐可行性 ════════════════════════ */
/* DESIGN:122-136 / plan §1.5 / R5：min(节点速率) vs 需求；stacker 0.25/s 常是瓶颈。
 * 弯带 0.78 的用法（严格照源码，不做没有凭据的换算）：
 *   components/belt.js:6 curvedBeltLength=0.78、:64-71 getEffectiveLengthTiles() ⇒
 *   **直带每格 1.0 弧长、弯带每格 0.78**。这是**弧长/在途容量**，不是速率系数
 *   （routing-prior-art.md:347-352 明确警告"0.78 不能当容量系数直接算吞吐"）。
 *   因此折算法限定为：**只有当链路被带子而非机器卡住时**（min 机器速率 ≥ belt 2.0/s）
 *   才用 derate = (直格 + 0.78×拐角格)/(直格+拐角格) 折损；机器限速时（本项目所有 op
 *   的 base 速率 ≤ 2.0）拐角不改变稳态件/s —— 折损值仍然**报进 evidence/note**，
 *   因为"拐角不免费"的方向是对的（ADVERSARIAL:221-223），只是换算未落地（NOTES M6）。
 * demandPerSec==0 ⇒ not-applicable（plan §0："只要能跑通"）。 */
const runV7 = (ctx, checks, errors) => {
    const { view } = ctx;
    const demand = view.demandPerSec || 0;
    const chain = rateChain(view);
    const bottleneck = chain.length ? chain.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;
    const corners = view.layout.cornerCount ?? countCorners(view);
    const straight = view.entities.filter(e => isBeltKind(e.kind)).length - corners;
    const derate = corners > 0 && (straight + corners) > 0 ? (straight + CURVED_EFFICIENCY * corners) / (straight + corners) : 1;
    const beltLimited = !!bottleneck && bottleneck.rate >= RATES.belt;
    const capacity = bottleneck ? +((beltLimited ? bottleneck.rate * derate : bottleneck.rate).toFixed(4)) : null;
    const rowsPlanned = capacity === null ? 1 : countRows(view, bottleneck.kind);
    const rowsRequired = capacity && demand > 0 ? Math.max(1, Math.ceil(demand / capacity)) : 1;
    const achieved = capacity === null ? null : +(capacity * rowsPlanned).toFixed(4);

    ctx.throughput = {
        demandPerSec: demand,
        bottleneck: bottleneck ? { nodeId: bottleneck.nodeId, ratePerSec: bottleneck.rate } : null,
        rowsRequired, rowsPlanned,
    };

    if (!demand) {
        checks.push(check("V7-throughput", "not-applicable", {
            cell: null, nodeId: bottleneck ? bottleneck.nodeId : null,
            expected: "demandPerSec", actual: "0",
            note: `v1 口径：0 = 只要能跑通，不做吞吐判定（plan §0）；瓶颈已算出 = ${bottleneck ? `${bottleneck.kind}@${bottleneck.rate}/s` : "—"}；`
                + `拐角 ${corners} 个 → 有效带长 ${(straight + CURVED_EFFICIENCY * corners).toFixed(2)}（derate ${derate.toFixed(3)}，${beltLimited ? "带限速 ⇒ 已折进判定" : "机器限速 ⇒ 只报告不折进判定"}）`,
        }));
        return;
    }
    if (capacity === null) {
        checks.push(check("V7-throughput", "not-applicable", { expected: "链路速率", actual: "无可算速率的机器", note: "纯矿机→hub 链路按矿机速率算，正常不该走到这里" }));
        return;
    }
    if (rowsRequired > rowsPlanned) {
        const b = bottleneck;
        claim(ctx, "V7-throughput", [b.cell, knode(b.nodeId)]);
        checks.push(check("V7-throughput", "fail", {
            cell: b.cell, nodeId: b.nodeId,
            expected: `需求 ${demand}/s ⇒ 需 ${rowsRequired} 行（单行 ${capacity}/s）`,
            actual: `规划 ${rowsPlanned} 行 ⇒ ${achieved}/s；瓶颈 ${b.kind}@${b.rate}/s`,
            note: "stacker 0.25/s = 带的 1/8 ⇒ 一条满带要 8 台（DESIGN:32-34）；v1 只报不足、不自动复制行（plan §7.1.2）",
        }));
        errors.push(error("V7-throughput", b.nodeId, b.cell,
            `吞吐不足：需求 ${demand}/s > 瓶颈 ${b.kind}@${b.rate}/s × ${rowsPlanned} 行 = ${achieved}/s（需 ${rowsRequired} 行）→ reason=throughput:stacker-bottleneck`));
        return;
    }
    checks.push(check("V7-throughput", "pass", {
        cell: null, nodeId: bottleneck.nodeId,
        expected: `需求 ${demand}/s`, actual: `瓶颈 ${capacity}/s（${bottleneck.kind}）× ${rowsPlanned} 行 = ${achieved}/s`,
        note: `拐角 ${corners} 个按 ${CURVED_EFFICIENCY} 折算（有效带长 ${(straight + CURVED_EFFICIENCY * corners).toFixed(2)}）；机器限速 ⇒ 弧长不改稳态速率，0.78→item-capacity 的换算未落地（NOTES M6）`,
    }));
};
runV7.id = "V7-throughput";

/** 链路节点速率（RATES 的 base 值；升级倍率不计 —— C7 口径）。
 *  模板经 resolveNode 拿（kind 与 op 不同名：miner≠mine，见 NOTES M9）。 */
function rateChain(view) {
    const out = [];
    for (const p of view.layout.placements || []) {
        const t = resolveNode(view, p.nodeId, p.cell).template;
        if (!t || !t.ratePerSec) continue;                     // trash/hub = 0，不是吞吐环节
        out.push({ nodeId: p.nodeId, kind: p.kind, rate: t.ratePerSec, cell: p.cell });
    }
    return out;
}
/** 行数 = 瓶颈那类机器的**实例数**（一行 = 一套完整产线；2×1 占地是格数不是行数）。 */
function countRows(view, bottleneckKind) {
    const ps = view.layout.placements || [];
    if (!ps.length) return 1;
    const want = bottleneckKind && bottleneckKind !== "miner" ? bottleneckKind : "miner";
    return Math.max(1, ps.filter(p => p.kind === want).length);
}
const countCorners = view => view.entities.filter(e => isBeltKind(e.kind) && e.rotationVariant !== 0).length;

/* ════════════════════════ V8 v1 范围 ════════════════════════ */
/* redteam:150 / plan §0 范围裁决：单层、无 wire、无隧道、机器恒 r=0、入度≤2、只做全新址。
 * 超出者一律显式 ok:false，**不许静默近似**（ADVERSARIAL:162-164：quad 4 路无汇合模板）。 */
const runV8 = (ctx, checks, errors) => {
    const { view } = ctx;
    const vios = [];
    const scope = view.scope;

    if (typeof view.goal === "string" && view.goal.includes(":")) vios.push({ what: "多层形状", detail: `goal=${view.goal} 含 ':' 分隔的多层`, reason: "out-of-scope:multilayer" });
    if (scope) {
        if (scope.layers !== 1) vios.push({ what: "层数", detail: `scope.layers=${fmt(scope.layers)}`, reason: "out-of-scope:multilayer" });
        if (scope.wires !== false) vios.push({ what: "wire", detail: `scope.wires=${fmt(scope.wires)}`, reason: "out-of-scope:wire" });
        /* 隧道：**不再是越界**。原判断依据是 C4（smartplace 会在 paste 中途删带），
           实机复现后确认那是 `enableTunnelSmartplace` 开关造成的：
             开 → sender↔receiver 之间的同向带子被删（复现，2→0）；
             关 → 完整保留（2→2）。
           隧道的编码/跨度/粘贴行为都已实测（见 research/ai-plan/tmp/TUNNEL-VERIFIED.md）。
           所以这里只校验「scope 声明与实际用法一致」，不再一律拒绝：
             · scope.tunnels=true   ⇒ 允许出现 underground_belt；
             · scope.tunnels=false  ⇒ 出现隧道仍按越界拒（保持旧口径，防静默扩权）。 */
        if (scope.tunnels !== true && scope.tunnels !== false) {
            vios.push({ what: "隧道许可", detail: `scope.tunnels=${fmt(scope.tunnels)}（只接受 true|false）`, reason: "out-of-scope:tunnel" });
        }
        if (scope.tunnels === false && (view.layout.beltCells || []).some?.(b => b.tunnel)) {
            vios.push({ what: "隧道", detail: "scope.tunnels=false 但布局里出现了隧道", reason: "out-of-scope:tunnel" });
        }
        if (scope.rotatedMachines !== false) vios.push({ what: "旋转机器许可", detail: `scope.rotatedMachines=${fmt(scope.rotatedMachines)}`, reason: "out-of-scope:rotated-machine" });
        if (scope.maxFanIn !== 2) vios.push({ what: "入度上限", detail: `scope.maxFanIn=${fmt(scope.maxFanIn)}`, reason: "dag-not-placeable:fanin>2" });
    }
    for (const p of view.layout.placements || []) {
        if ((p.rot || 0) !== 0) vios.push({ what: "旋转机器", detail: `${p.nodeId}(${p.kind}) rot=${p.rot}，违反决策 D1`, reason: "out-of-scope:rotated-machine", cell: p.cell });
        if (OUT_OF_SCOPE_KINDS.includes(p.kind)) vios.push({ what: "范围外建筑", detail: `${p.nodeId}=${p.kind}`, reason: v1ScopeReason(p.kind) || "out-of-scope:rotated-machine", cell: p.cell });
        const t = TEMPLATES[p.op];
        if (t && t.v1Blocked) vios.push({ what: "v1 阻断变体", detail: `${p.nodeId} op=${p.op}（${t.building}/${t.variant}：4 路输出无汇合模板 / 需 wire 层）`, reason: "dag-not-placeable:fanin>2", cell: p.cell });
    }
    for (const e of view.entities) {
        /* 隧道（underground_belt）在 scope.tunnels=true 时是**合法**实体，不再算"范围外"。
           它仍要过下面两条通用检查：rv 位（sender=0/receiver=1，属 belt 族所以跳过非 belt 那条）
           与 code 位（22/23 由 MACHINE_CODES 给出）。 */
        const tunnelAllowed = scope && scope.tunnels === true && e.kind === "underground_belt";
        if (e.kind && !V1_KINDS.includes(e.kind) && !tunnelAllowed) vios.push({ what: "范围外实体", detail: `${e.nodeId} kind=${e.kind}`, reason: v1ScopeReason(e.kind) || "out-of-scope:rotated-machine", cell: [e.dx, e.dy] });
        if (!isBeltKind(e.kind) && e.kind !== "underground_belt" && (e.rotationVariant || 0) !== 0) vios.push({ what: "非 belt rv≠0", detail: `${e.nodeId}(${e.kind}) rv=${e.rotationVariant}`, reason: "emit:mismatch", cell: [e.dx, e.dy] });
        if (isBeltKind(e.kind) && !ORDER.includes(beltDirs(e).exit)) vios.push({ what: "非法带向", detail: `${e.nodeId} r=${e.rot} rv=${e.rotationVariant}`, reason: "belt-turn-unsolvable", cell: [e.dx, e.dy] });
        // code 位必须由模板推导（plan §1.6：belt 用 beltCode(rv)、机器用 codeFor；**不得手填 magic number**）
        const want = codeOf(view, e);
        if (want !== null && e.code !== want) vios.push({ what: "code 与模板不符", detail: `${e.nodeId}(${e.kind}) code=${e.code} 而 codeFor/beltCode 给 ${want}`, reason: "emit:mismatch", cell: [e.dx, e.dy] });
    }

    if (vios.length) {
        const v = vios[0];
        claim(ctx, "V8-scope", vios.map(x => x.cell).filter(Boolean).concat(vios.map(x => x.what)));
        checks.push(check("V8-scope", "fail", {
            cell: v.cell ?? null, nodeId: null,
            expected: "单层/无 wire/无隧道/机器 r=0/入度≤2/全新址",
            actual: `${vios.length} 项越界：${v.what} — ${v.detail}`,
            note: `§2.5 分诊串 = ${v.reason}；越界必须 ok:false，不许静默近似（plan §0）。C3 wire 无 immutable 豁免、C4 隧道 smartplace 删带`,
        }));
        errors.push(error("V8-scope", "", v.cell ?? null, `越界（${v.what}）：${v.detail} → ${v.reason}`));
        return;
    }
    checks.push(check("V8-scope", "pass", {
        expected: "单层/无 wire/无隧道/机器 r=0/入度≤2/全新址", actual: "6 项全满足",
        note: "scope 是契约的一部分（§2.1）。C3 wire 无 immutable 豁免、C4 隧道 smartplace 删带"
            + (view.chargeMode === "false" ? "；chargeMode=false ⇒ god-mode 口径（C7）" : ""),
    }));
};
runV8.id = "V8-scope";

/* ════════════════════════ V10 解锁清单（只报告不阻断） ════════════════════════ */
/* redteam:190-216 / C7：place/paste 都不查 getIsUnlocked，本项目定位 = god-mode（B）。
 * ⇒ 本条**永不产生 fatal error**：它把"当前等级不可用"的清单写进报告，让任何"通关"主张
 *   带上 god-mode 标注。enforceUnlocks:true = 忠实玩家口径（定位 A）的开关。 */
const runV10 = (ctx, checks, errors) => {
    const { view } = ctx;
    const level = view.currentLevel;
    const rows = [];
    for (const p of view.layout.placements || []) {
        const t = resolveNode(view, p.nodeId, p.cell).template;
        if (!t) continue;
        const need = t.unlockLevel ?? UNLOCK_LEVEL_FALLBACK[p.op] ?? null;
        if (level === null || level === undefined || need === null) continue;
        if (level < need) rows.push({ nodeId: p.nodeId, kind: p.kind, op: p.op, need, level, cell: p.cell });
    }
    ctx.unlockRows = rows;

    if (rows.length && view.enforceUnlocks) {
        const r = rows[0];
        claim(ctx, "V10-unlock-report", rows.map(x => x.cell).concat(rows.map(x => knode(x.nodeId))));
        checks.push(check("V10-unlock-report", "fail", {
            cell: r.cell, nodeId: r.nodeId, expected: `当前等级 L${r.level} 已解锁 ${r.op}`, actual: `需要 L${r.need}`,
            note: "忠实玩家口径（redteam:235 定位 A）：门控生效 → reason=unlock:machine-not-available",
        }));
        errors.push(error("V10-unlock-report", r.nodeId, r.cell, `${r.kind}(${r.op}) 需 L${r.need}，当前 L${r.level}：unlock:machine-not-available`));
        return;
    }
    if (rows.length) {
        const list = rows.map(r => `${r.nodeId}=${r.kind}@L${r.need}`).join(", ");
        checks.push(check("V10-unlock-report", "pass", {
            cell: rows[0].cell, nodeId: rows[0].nodeId,
            expected: `当前等级 L${level} 的可用机器集`, actual: `${rows.length} 台越级：${list}`,
            note: "§6 R4 / C7：god-mode 口径（charge:false + 不查 getIsUnlocked）⇒ 本条**只报告不阻断**；"
                + "任何『通关/能力』主张必须带 god-mode 标注。忠实口径请传 enforceUnlocks:true",
        }));
        return;
    }
    checks.push(check("V10-unlock-report", "pass", {
        cell: null, nodeId: (view.layout.placements || [])[0]?.nodeId ?? null,
        expected: level === null ? "解锁等级清单（未给 currentLevel ⇒ 按全解锁列示）" : `当前等级 L${level} 的可用机器集`,
        actual: `${(view.layout.placements || []).length} 台机器全部在可用集内${level === null ? "（未给 currentLevel，按 god-mode 不判定）" : ""}`,
        note: "L3 用 level-2 目标 ----CuCu：miner/cutter/trash 在 L1 完成即解锁 ⇒ 两种口径都成立（C7）。"
            + "solver 默认开 cutQuad ⇒ L11 目标会用到 L16 建筑（redteam:198），清单在此显形",
    }));
};
runV10.id = "V10-unlock-report";

/* ════════════════════════ S1 形状重放（hash 相等） ════════════════════════ */
/* DESIGN:93 Level-1 / plan §2.4：用 proto/shape-ops.mjs（只 import 不改）重放每个节点，
 * 输入形状经该 op 语义运算后的 hash 必须等于下游通道承载的 payload（或 step.hash）。 */
const runS1 = (ctx, checks, errors) => {
    const { view } = ctx;
    const ops = ctx.ops;
    if (!ops || !ops.hash) {
        checks.push(check("S1-shape-replay", "not-applicable", { expected: "shape-ops 可加载", actual: "加载失败", note: "S1 依赖 proto/shape-ops.mjs；几何闸（V1-V9）不受影响" }));
        return;
    }
    const { replay, bad } = shapeReplay(view, ops, ctx.dag, ctx.audit || (ctx.audit = edgeAudit(view)));
    ctx.shapeReplay = replay;
    if (bad.length) {
        const b = bad[0];
        claim(ctx, "S1-shape-replay", [b.cell, knode(b.nodeId)].filter(Boolean));
        checks.push(check("S1-shape-replay", "fail", {
            cell: b.cell ?? null, nodeId: b.nodeId,
            expected: b.expectedHash ?? null, actual: b.actualHash ?? null,
            note: "shape-ops 重放：节点输入→输出 hash 必须相等（DESIGN:93 Level-1）",
        }));
        errors.push(error("S1-shape-replay", b.nodeId, b.cell ?? null, `形状重放不等：${b.detail}`));
        return;
    }
    if (!replay.length) {
        checks.push(check("S1-shape-replay", "not-applicable", {
            expected: "每节点 hash 相等", actual: "无可重放的节点（既无 DAG 也无 op+payload 链）",
            note: "LayoutReport-only 输入（没有 goal/DAG）时 S1 不适用；几何闸不受影响",
        }));
        return;
    }
    checks.push(check("S1-shape-replay", "pass", {
        cell: null, nodeId: replay[0].nodeId,
        expected: `${replay.length} 个节点 hash 相等`, actual: `${replay.filter(r => r.equal).length}/${replay.length} 相等`,
        note: "shape-ops 重放每个节点（DESIGN:93 Level-1）；cut 左右列语义按上游 shape_definition_manager.js:92 与 proto/shape-ops.mjs:103",
    }));
};
runS1.id = "S1-shape-replay";

/* ════════════════════════ shape-ops 重放实现 ════════════════════════ */

/** 本地 hash 复刻（components/shape_definition.js:266 getHash 同式；S1 不依赖 proto 可加载性）。 */
const SUB_TO_SHORT = { rect: "R", circle: "C", star: "S", windmill: "W" };
const COLOR_TO_SHORT = { red: "r", green: "g", blue: "b", yellow: "y", purple: "p", cyan: "c", white: "w", uncolored: "u" };
export function hashOf(shape) {
    let id = "";
    for (let li = 0; li < shape.layers.length; li++) {
        const layer = shape.layers[li];
        for (let q = 0; q < 4; q++) {
            const item = layer[q];
            id += item ? SUB_TO_SHORT[item.sub] + COLOR_TO_SHORT[item.color] : "--";
        }
        if (li < shape.layers.length - 1) id += ":";
    }
    return id;
}

/** 懒加载 proto/shape-ops.mjs（测试侧凭据；本模块用静态 import）。 */
export async function loadShapeOps() {
    const p = path.resolve(HERE, "..", "..", "..", "research", "ai-player", "proto", "shape-ops.mjs");
    try { return await import(pathToFileURL(p).href); } catch { return null; }
}

/** 把 solver 的 op 语义套到形状上（左右列取法严格照 proto/shape-ops.mjs:103 cutHalf）。 */
export function applyOp(ops, opName, args, parents) {
    switch (opName) {
        case "mine": return parents[0];
        case "cut": {
            /* `cutHalf` 返回 [quads(2,3), quads(0,1)]；solver 把 [0] 命名为 "left"、
               [1] 命名为 "right"。**这是 solver 自己的命名约定，与游戏槽位无关**，
               两者恰好对得上：solver "left" = cutHalf[0] = 游戏 slot 0。
               ⚠️ 曾经以为这里取反了并改动它 —— 那是误判：`mapOps` 的形状代数是自洽的，
                  改它只会让 solver 的重建校验失败（实测 validate:S1）。 */
            const halves = ops.cutHalf(parents[0]);
            return (args && args.half === "left") ? halves[0] : halves[1];
        }
        case "cutQuad": return ops.cutQuad(parents[0])[(args && args.quad) | 0];
        case "rotate": {
            const d = (args && args.dir) || "cw";
            return d === "ccw" ? ops.rotateCCW(parents[0]) : d === "180" ? ops.rotate180(parents[0]) : ops.rotateCW(parents[0]);
        }
        case "rotateCCW": return ops.rotateCCW(parents[0]);
        case "rotate180": return ops.rotate180(parents[0]);
        case "paint":
        case "paintMirrored": return ops.paint(parents[0], args && args.color);
        case "mix": return ops.paint4({ layers: parents[0].layers.map(l => l.map(x => (x ? { ...x } : null))) }, mixColors(args));
        case "stack": return ops.stack(parents[0], parents[1]);    // [0]=下层、[1]=上层
        default: throw new Error(`applyOp: 未知 op ${opName}`);
    }
}

/** mix 的颜料位域（colors.js:61 bitfieldToColor；proto/solver.mjs:37 COLOR_BITS 同一套）。 */
const COLOR_BITS = { red: 1, green: 2, blue: 4, yellow: 3, purple: 5, cyan: 6, white: 7 };
const BITS_COLOR = { 1: "red", 2: "green", 4: "blue", 3: "yellow", 5: "purple", 6: "cyan", 7: "white" };
function mixColors(args) {
    const bit = ((args && args.colors) || []).reduce((a, c) => a | (COLOR_BITS[c] || 0), 0);
    const merged = BITS_COLOR[bit];
    return [merged, merged, merged, merged];
}

/** 该 op 在给定输入下的**全部**合法输出 hash（LayoutReport 不带 args ⇒ 按候选集判定）。 */
function opCandidates(ops, opName, inputs) {
    const cands = [];
    const one = a => { try { cands.push(ops.hash(applyOp(ops, opName, a, inputs))); } catch { /* 此输入上该 op 非法 */ } };
    switch (opName) {
        case "mine": cands.push(ops.hash(inputs[0])); break;
        case "cut": one({ half: "left" }); one({ half: "right" }); break;
        case "cutQuad": for (let q = 0; q < 4; q++) one({ quad: q }); break;
        case "rotate": one({ dir: "cw" }); break;
        case "rotateCCW": one({ dir: "ccw" }); break;
        case "rotate180": one({ dir: "180" }); break;
        case "paint": case "paintMirrored": for (const c of ops.ALL_COLORS) one({ color: c }); break;
        case "mix": { const cols = ops.ALL_COLORS; for (const a of cols) for (const b of cols) one({ colors: [a, b] }); break; }
        case "stack": one({}); break;
        default: one({});
    }
    return cands;
}

/**
 * 重放。两条路径：
 *   1. 显式 DAG（opts.dag = proto/solver.mjs buildPlan().steps：{hash,op,args,parents}）→ 逐节点算 hash 比 step.hash
 *   2. LayoutReport 驱动（fixture 路径）→ 按 channels payload 走候选集，外加"送进 hub 的形状 == goal"
 * @returns {{replay:Array, bad:Array}}
 */
export function shapeReplay(view, ops, dag, audit) {
    const replay = [], bad = [];
    if (dag && dag.length) {
        const byHash = new Map();
        for (const step of dag) {
            const parents = (step.parents || []).map(h => byHash.get(h)).filter(Boolean);
            let out;
            try { out = ops.hash(applyOp(ops, step.op, step.args || {}, parents.length ? parents : [ops.parse(step.hash)])); }
            catch (e) { bad.push({ nodeId: step.nodeId || step.hash, cell: null, expectedHash: step.hash, actualHash: null, detail: `${step.op}: ${e.message}` }); continue; }
            byHash.set(step.hash, ops.parse(step.hash));
            const equal = out === step.hash;
            replay.push({ nodeId: step.nodeId || step.hash, expectedHash: step.hash, actualHash: out, equal });
            if (!equal) bad.push({ nodeId: step.nodeId || step.hash, cell: null, expectedHash: step.hash, actualHash: out, detail: `${step.op} 重放得 ${out}，应为 ${step.hash}` });
        }
        return { replay, bad };
    }

    const ins = new Map(), outs = new Map();
    (view.layout.channels || []).forEach((ch, i) => {
        if (audit && audit.skip.has(i)) return;                 // V5 的非法边不参与重放
        if (!ch.payload || !shortKeyGrammar(ch.payload)) return;
        if (!outs.has(ch.from.nodeId)) outs.set(ch.from.nodeId, []);
        outs.get(ch.from.nodeId).push(ch);
        if (!ins.has(ch.to.nodeId)) ins.set(ch.to.nodeId, []);
        ins.get(ch.to.nodeId).push(ch);
    });
    for (const p of view.layout.placements || []) {
        if (!TEMPLATES[p.op]) continue;
        const inChs = ins.get(p.nodeId) || [];
        if (!inChs.length) {
            const firstOut = (outs.get(p.nodeId) || [])[0];
            if (!firstOut) continue;                            // 矿机：产物 = 采到的形状，无上游可验
            replay.push({ nodeId: p.nodeId, expectedHash: firstOut.payload, actualHash: firstOut.payload, equal: true });
            continue;
        }
        let inputs = null;
        try { inputs = inChs.map(c => ops.parse(c.payload)); } catch { inputs = null; }
        const expected = inputs ? opCandidates(ops, p.op, inputs) : [];
        for (const ch of outs.get(p.nodeId) || []) {
            const equal = expected.includes(ch.payload);
            replay.push({ nodeId: p.nodeId, expectedHash: equal ? ch.payload : expected.join("|"), actualHash: ch.payload, equal });
            if (!equal) bad.push({
                nodeId: p.nodeId, cell: p.cell, expectedHash: expected.join("|"), actualHash: ch.payload, equal: false,
                detail: `${p.kind}(${p.op}) 由 ${inChs.map(c => c.payload).join(" + ")} 得 ${ch.payload}（候选 ${expected.join("|") || "无"}）`,
            });
        }
    }
    if (typeof view.goal === "string" && shortKeyGrammar(view.goal)) {
        const hubCh = (view.layout.channels || []).find(c => String(c.to.nodeId).startsWith("hub"));
        if (hubCh) {
            const equal = hubCh.payload === view.goal;
            replay.push({ nodeId: "goal", expectedHash: view.goal, actualHash: hubCh.payload, equal });
            if (!equal) bad.push({ nodeId: "goal", cell: hubCh.to.cell, expectedHash: view.goal, actualHash: hubCh.payload, equal: false, detail: `送进 hub 的形状 ${hubCh.payload} ≠ 目标 ${view.goal}` });
        }
    }
    return { replay, bad };
}

/* ════════════════════ RUNNERS 注册表（执行序 == 归因优先级） ════════════════════ */
const RUNNERS = [runV8, runV1, runV2, runV5, runV3, runV4, runV6, runV9, runV7, runV10, runS1];
/** 执行序（测试侧凭据：11 条判据全覆盖、且 V3 确实在 V4 之前认领根因）。 */
export const RUNNER_IDS = () => RUNNERS.map(r => r.id);

/* ════════════════════════════════ CLI（L1.5 可布性闸） ════════════════════════════════ */

/** 是不是一个 ValidatorReport（而不是 plan/layout）？—— plan §5 的 L1.5 命令喂的是
 *  `harness/out/*.validator.json`，那已经是 P5 的**产物**，不是输入，必须能直接复核。 */
const looksLikeValidatorReport = o => o && Array.isArray(o.checks) && Array.isArray(o.errors) && o.beltSim && o.throughput && !o.layout && !o.placements;

/**
 * `node src/ai/compiler/validate.mjs --plan <file.json> [--intent <file.json>] [--demand x] [--level n] [--strict]`
 * 三种输入都接（plan §5 的命令原文用的是 *.validator.json）：
 *   a) CompiledPlan      → 用 plan.layout + plan.entities 重跑，再判闸
 *   b) LayoutReport      → 需要带子意图表才能跑 V3/V4；用 --intent 指 P4 产物或
 *      contract/merge-belt-intent.json 那种 {entities:[...]} 附表（否则带子数为 0 → 判不了）
 *   c) ValidatorReport   → 不重跑（没有图可跑），改做**报告自洽审计**：过 P1 的
 *      assertValidatorReport + 逐条查 checks/errors 对齐、drift 长度、includesMachineNeighbors
 * @returns {number} 0=过闸 / 1=不过闸 / 2=用法或文件错误
 */
export function runCli(argv) {
    const file = argv[argv.indexOf("--plan") + 1];
    if (!file) { console.error("用法：node src/ai/compiler/validate.mjs --plan <CompiledPlan|LayoutReport|ValidatorReport json> [--intent <beltIntent json>]"); return 2; }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
    catch (e) { console.error(`读不了 ${file}：${e.message}`); return 2; }
    const opts = { strict: argv.includes("--strict") };
    if (argv.includes("--demand")) opts.demandPerSec = Number(argv[argv.indexOf("--demand") + 1]);
    if (argv.includes("--level")) opts.currentLevel = Number(argv[argv.indexOf("--level") + 1]);
    if (argv.includes("--enforce-unlocks")) opts.enforceUnlocks = true;
    if (argv.includes("--intent")) {
        const intentFile = argv[argv.indexOf("--intent") + 1];
        try {
            const it = JSON.parse(fs.readFileSync(path.resolve(intentFile), "utf8"));
            opts.entities = Array.isArray(it) ? it : it.entities;
            if (!opts.entities) { console.error(`--intent 指向的文件里没有 entities[]：${intentFile}`); return 2; }
        } catch (e) { console.error(`读不了 --intent ${intentFile}：${e.message}`); return 2; }
    }
    if (raw.replaceableBeltCells || raw.world) opts.world = raw.world || raw;

    if (looksLikeValidatorReport(raw)) {
        const audit = auditReport(raw);
        console.log(JSON.stringify({ mode: "validator-report-audit", file, ...audit }, null, 2));
        console.error(audit.gate ? "L1.5 可布性闸（报告审计）：PASS" : "L1.5 可布性闸（报告审计）：FAIL");
        for (const p of audit.problems) console.error("  · 自洽：" + p);
        for (const r of audit.gateReasons) console.error("  · 不过闸：" + r);
        return audit.gate ? 0 : 1;
    }

    // 没有实体表 ⇒ 闸**无从可判**（不是"没问题"）。绝不给绿灯：单独退出码 2 + 明说缺什么。
    // 判据是"调用方压根没给实体表"，不是"带子数为 0" —— 真·无带子的合法布局（机器直接相邻）
    // 本来就可以判，不该被当成缺凭据。
    const hasEntities = Array.isArray(opts.entities) || Array.isArray(raw.entities);
    if (!hasEntities) {
        console.error("L1.5 可布性闸：UNDECIDABLE —— 输入里没有实体表（V3/V4/V6 要用带子的 (r,rv) 逐格判）。");
        console.error("  用 --intent <beltIntent.json> 提供 P4 的带子逐格输出；或直接喂 CompiledPlan。");
        return 2;
    }

    let report;
    try {
        report = validate(raw.layout || raw, { ...opts, entities: opts.entities || raw.entities });
    } catch (e) {
        console.error(`无法判定该文件（既不是 CompiledPlan/LayoutReport，也不是 ValidatorReport）：${e.message}`);
        return 2;
    }
    console.log(JSON.stringify(report, null, 2));
    // 过闸判据 = 报告自洽审计（同一份代码既管自己新产的报告，也管 P8 交接来的 *.validator.json）
    const audit = auditReport(report);
    const gate = report.pass && audit.gate;
    console.error(gate ? "L1.5 可布性闸：PASS" : "L1.5 可布性闸：FAIL");
    for (const e of report.errors) console.error(`  · ${e.check} @${e.cell ? e.cell.join(",") : "-"} ${e.message}`);
    for (const p of audit.problems) console.error("  · 自洽：" + p);
    return gate ? 0 : 1;
}

/**
 * ValidatorReport 自洽审计（喂进来的是 P5 自己的产物时用）。
 * 判据 = plan §5 L1.5 那一行的字面要求 + P1 的 assertValidatorReport。
 * ⚠️ 两类结论**分开**给，不混成一锅：
 *   problems    = 报告自相矛盾（契约/对齐问题）→ 说明产这份报告的代码有 bug
 *   gateReasons = 报告如实反映了"这图不能过闸"的原因（pass:false / drift）→ 是闸正常工作
 * @returns {{gate:boolean, contractOk:boolean, problems:string[], gateReasons:string[], summary:object}}
 */
export function auditReport(rep) {
    const problems = [], gateReasons = [];
    let contractOk = true;
    try { assertValidatorReport(rep, "report"); }
    catch (e) { contractOk = false; problems.push(`契约违规：${(e && e.allMessages) || e.message}`); }
    if (rep) {
        if (rep.pass !== (Array.isArray(rep.errors) && rep.errors.length === 0)) problems.push("pass 与 errors.length 不等");
        if (!rep.beltSim) problems.push("缺 beltSim");
        else {
            if (rep.beltSim.includesMachineNeighbors !== true) problems.push("beltSim.includesMachineNeighbors 必须为 true（只喂带子的自检没有价值）");
            if (Array.isArray(rep.beltSim.drift) && rep.beltSim.drift.length) gateReasons.push(`beltSim.drift 有 ${rep.beltSim.drift.length} 格`);
        }
        const ids = new Set((rep.checks || []).map(c => c.id));
        if (!ids.has("V3-belt-fixed-point")) problems.push("缺 V3-belt-fixed-point（唯一防 rv 漂移的闸）");
        for (const c of rep.checks || []) if (c.status === "fail" && !(rep.errors || []).some(e => e.check === c.id || e.check.split("-")[0] === c.id.split("-")[0])) problems.push(`${c.id} fail 但 errors[] 无对应条目`);
        for (const e of rep.errors || []) if (!ids.has(e.check)) problems.push(`errors[].check=${e.check} 在 checks[] 无对应条目`);
        for (const c of rep.checks || []) if (typeof c.evidence?.note !== "string" || !c.evidence.note) problems.push(`${c.id} 缺 evidence.note`);
        if (rep.pass === false) gateReasons.push(`errors[] 有 ${rep.errors.length} 条（pass:false）`);
    }
    return {
        gate: problems.length === 0 && gateReasons.length === 0 && contractOk,
        contractOk, problems, gateReasons,
        summary: rep ? { pass: rep.pass, checks: rep.checks.length, errors: rep.errors.length, failIds: rep.checks.filter(c => c.status === "fail").map(c => c.id), beltSim: rep.beltSim } : null,
    };
}

/* ════════════════════════════════ 入口钩子 ════════════════════════════════ */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/validate.mjs")) {
    const argv = process.argv.slice(2);
    if (argv.includes("--plan")) process.exitCode = runCli(argv);
    else if (argv.includes("--test")) {
        // L0 的真入口是 research/ai-plan/validator/test.mjs（判据与 fixture 都写在那儿）。
        // 用子进程转发：库文件不静态 import 测试（会形成循环），也不用 top-level await
        //（Node 会报 unsettled top-level await）。
        const r = spawnSync(process.execPath, [path.resolve(HERE, "../../../research/ai-plan/validator/test.mjs"), ...argv.filter(a => a !== "--test")], { stdio: "inherit" });
        process.exitCode = r.status === null ? 1 : r.status;
    } else {
        console.log("用法：node src/ai/compiler/validate.mjs --test | --plan <file.json> [--intent <beltIntent.json>] [--demand n] [--level n] [--strict]");
        process.exitCode = 2;
    }
}
