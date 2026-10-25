/**
 * op-templates.mjs — Op 占地/槽位/code 模板 + 机器规格适配（P2 data 包）
 *
 * 定位：编译器其余包（P3 placer / P4 router / P5 validator / P6 emitter / P8 harness）
 * 的**全部机器几何与 code 真值**经本文件供给。几何权威 =
 *   research/ai-player/facts/GEOMETRY-TABLE.md 表1（槽位）、表2（速率）
 *   research/ai-player/facts/building-codes-live.json（实机提取：60 条记录 → **15 个去重 code**
 *     覆盖 14 个 building|variant 组合（belt 的 4 条都是 rv=0→code 1）；全部 rv=0）
 *   上游源码复核：recon/upstream-full/src/js/game/buildings/{cutter,painter,stacker,mixer,rotater,miner,trash}.js
 * 方向真值 = src/ai/belt-rules.mjs 的 rotateLocal（**唯一方向函数，禁止二次实现**）。
 *
 * 三条硬断言（红队 + 审查结论，落到代码与测试）：
 *   H1 belt 族 code 唯一权威 = beltCode(rv) = 1 + rv（belt-rules.mjs:58-59，1906/1906 实机）。
 *      machine-spec.json 若给出不同的 belt code，一律以 belt-rules.mjs 为准并登记冲突。
 *   H2 非 belt 建筑 v1 **只允许 rv=0**。三层凭据（见 RV_ALLOWED 注释 / NOTES G1）：
 *      实机提取表 60 条全 rv=0 ＋ level-11 存档 2805 实体里非 belt/隧道 rv 恒 0
 *      ＋ 上游 meta_building_registry.js:42-53 的注册表里**根本不存在**这些建筑的 rv≠0 code。
 *      请求 rv≠0 → 抛结构化错误。（plan 说"无任何证据"，实际比那更强，结论不变。）
 *   H3 v1 加工机器朝向恒 r=0（plan §2.3 决策 D1：GEOMETRY 表1 的槽位只在 r=0 定义，
 *      static_map_entity.js 旋转时 origin 位移未实机验证）。见 assertV1Rotation()。
 *      rotateSlot() 仍为未来实现并单测：世界槽位 = rotateLocal(局部槽位, rotation)。
 *      例外 trash/hub：上游 getIsRotateable()=false ⇒ 游戏里就恒 r=0（NOTES G9）。
 *
 * 职责分界（容易混，写死）：
 *   codeFor()            = **世界真值解码器**：凡实机观测过的 (building|variant) 都解得出 code，
 *                          含 v1 范围外的 balancer=4 / hub=26 / tunnel=22 —— P7 读盘对拍要用（NOTES 四）。
 *   isV1Emittable()      = **产出权限**：编译器该不该产出它（P5 的 V8-scope 用）。
 *   v1ScopeReason()      = 范围外建筑的 §2.5 分诊串（out-of-scope:tunnel / :wire）。
 *
 * 导出清单（其余包按需 import，**不要**自己去读 machine-spec.json）：
 *   常量  OP_TEMPLATES(10 op) / AUX_TEMPLATES(trash,belt,hub,mineChainable,paintDouble,paintQuad) /
 *         ALL_TEMPLATES / MACHINE_CODES(15 提取表) / SAVE_CODES(存档) / RATES(表2) /
 *         UNLOCK_LEVEL_FALLBACK / RV_ALLOWED / ROTATABLE / SPEC_FIELD_ALIASES /
 *         OUT_OF_SCOPE_BUILDINGS_WITH_RV / DEFAULT_SPEC_PATH / SpecError
 *   查询  opByName / templateForBuildingCode / templateByBuildingVariant / crossCheckCodes /
 *         allowedRvariants / isRotatable / isV1Emittable / v1ScopeReason / bottleneckOf
 *   code  codeFor / beltCode(重导出) / hubEntriesWorld
 *   几何  rotateSlot(委托 belt-rules.rotateLocal) / rotateCell / worldSlots / machineWorldBounds /
 *         assertV1Rotation
 *   spec  loadMachineSpec / resolveTemplates / specGapReport
 *   重导出自 belt-rules：rotateLocal, beltCode, ORDER, OPP, DIRV, norm360, angleToDir
 *
 * 零依赖：只 import ESM + node: 内置 + ./belt-rules.mjs。
 * 自测：`node src/ai/op-templates.mjs --test`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 唯一方向函数来源 —— 本文件内**不得**再写任何方向旋转逻辑
import { rotateLocal, beltCode, ORDER, OPP, DIRV, norm360, angleToDir, EXIT_LOCAL } from "./belt-rules.mjs";

// 只重导出**从 belt-rules 导入**的符号；本文件自己声明的 export 不能再列进来（否则重复导出）
export { rotateLocal, beltCode, ORDER, OPP, DIRV, norm360, angleToDir };

/* ───────────────────────────── 结构化错误（本地版） ─────────────────────────────
 * TODO(P1 落地后)：换成 `src/ai/compiler/errors.mjs` 的 ContractViolation / makeFailure，
 * 保持 {path, rule, got, reason} 字段名不变即可（本包测试要求自包含，故现在自带一份）。 */
export class SpecError extends Error {
    /** @param {string} path 字段/参数路径 @param {string} rule 违反的规则 @param {unknown} got 实得值 */
    constructor(pathKey, rule, got, reason = "validate:V8-scope") {
        super(`契约违反 ${pathKey}: 期望 ${rule}，实得 ${safe(got)}`);
        this.name = "SpecError";
        this.path = pathKey; this.rule = rule; this.got = got;
        /** §2.5 风格的分诊 reason（P8/LLM 修复层用） */
        this.reason = reason;
        /** 归一化的失败对象，对齐 plan §2.1 的 {ok:false,reason,failingNode,hint} */
        this.failure = { ok: false, reason, failingNode: { nodeId: null, cell: null, check: pathKey }, hint: null };
    }
}
function safe(v) {
    if (v === undefined) return "undefined";
    if (typeof v === "string") return JSON.stringify(v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 120); } catch { return String(v); } }

/* ───────────────────────────── 兜底解锁等级（C7 god-mode 口径） ─────────────────────────────
 * plan §2.2：machine-spec.json 没这个字段时用它兜底，并把"用了兜底"登记为 spec 缺口（NOTES G2）。
 * 出处：human-strategies.md §2.1 剧情等级表 + §2.2 建筑解锁谓词（levels.js:164-364）。 */
export const UNLOCK_LEVEL_FALLBACK = Object.freeze({
    mine: 1,              // 矿机/垃圾站随 level1 目标即在（L1 完成 → reward_cutter_and_trash）
    cut: 1,               // L1 → reward_cutter_and_trash
    rotate: 4,            // L4 → reward_rotater
    paint: 6,             // L6 → reward_painter
    mix: 8,               // L8 → reward_mixer
    stack: 10,            // L10 → reward_stacker
    // —— 以下为 §2.2 未给常量的补充值（从 human-strategies §2.1 等级表推得，NOTES G2/G3 登记） ——
    cutQuad: 16,          // L16 → reward_cutter_quad（plan §1.5 V10 行"cutQuad 默认开 → L16 建筑"与此一致）
    rotateCCW: 7,         // L7 → reward_rotater_ccw（⚠️ 与 §2.2 的 rotate=4 不同级：变体独立解锁）
    rotate180: 18,        // L18 → reward_rotater_180
    paintMirrored: 6,     // mirrored 不是独立 reward，随 reward_painter（painter.js:107-110 getIsUnlocked）
    paintDouble: 17,      // L17 → reward_painter_double
    paintQuad: 20,        // L20 → reward_wires_painter_and_levers（⚠️ 同时需要 wire 层 → v1 范围外）
    mineChainable: 11,    // L11 → reward_miner_chainable
    trash: 1,             // L1 → reward_cutter_and_trash
});

/* ───────────────── 非 belt 建筑的 rv 许可集（H2 的代码化，源码+实机双证） ─────────────────
 * 证据（比"没有证据"强，见 NOTES.md G1）：
 *   1. 实机：building-codes-live.json 60 条记录 rotation_variant 恒 0。
 *   2. 源码：code 由 building_codes.js:41-56 `registerBuildingVariant(code, meta, variant,
 *      rotationVariant = 0)` 经 meta_building_registry.js:42-53 用 `getAllVariantCombinations()`
 *      注册；查表 key = `metaBuildingId/variant/rotationVariant`（building_codes.js:87-99）。
 *      **只有 belt.js:25-43（rv 0/1/2 → internalId 1/2/3）、underground_belt.js:48-63、wire.js:45-80**
 *      注册了 rv≠0 的组合；miner/cutter/rotater/stacker/mixer/painter/trash 的组合里
 *      **根本不出现 rotationVariant 字段**（缺省 0）→ 这些建筑在注册表里只有 rv=0 这一个 code。
 *      请求 rv≠0 不是"我们不支持"，而是**该 code 不存在**，游戏侧解码不出实体。
 *   ⇒ v1 编译器对非 belt 机器只出 rv=0；belt 的 rv 见 H1（权威 = belt-rules.mjs 的 beltCode）。
 *   ⇒ 注意 belt 的 code 也**不是通用公式** `base+rv`，而是 belt.js 里 internalId=1+rv 的硬编码
 *      + 1906/1906 实机；其它建筑 rv 恒 0，所以 `base+rv` 在它们身上**退化等于 base**——
 *      facts/building-code-table.md 的推断结论正确，但成立的理由是"rv 只能取 0"。 */
export const RV_ALLOWED = Object.freeze({
    belt: [0, 1, 2],
    /* 隧道的 rv 是 **sender/receiver 区分位**（0=sender、1=receiver），有实机凭据：
       `buildings/underground_belt.js:45-48` 的 getAllVariantCombinations（22/23）+ 存档取证。
       与 belt 的"rv=转弯形态"是**不同的语义**，只是恰好共用同一个字段。 */
    underground_belt: [0, 1],
    miner: [0], cutter: [0], rotater: [0], stacker: [0], mixer: [0], painter: [0], trash: [0], hub: [0],
});
/** 有 rv≠0 但语义无实机凭据、明确落在 v1 范围外的建筑（wire）。隧道已移出（见 RV_ALLOWED）。 */
export const OUT_OF_SCOPE_BUILDINGS_WITH_RV = Object.freeze(["wire"]);

/** 是否可旋转（上游 `getIsRotateable()`：基类默认 true，meta_building.js:176-178/258-262 会在
 *  false 时强制返回 {rotation:0, rotationVariant:0}）。**实机印证**：level-11 存档里
 *  trash 10 台与 hub 1 台**全部 r=0**，而 painter/cutter/mixer/rotater/miner/belt 出现 r=90/180/270
 *  （facts/live/world-full.json 直读）。
 *  用途：机器旋转的**上游真值依据**，替代此前只靠"提取实验人为摆 4 个朝向"的弱证据。 */
export const ROTATABLE = Object.freeze({
    belt: true, miner: true, cutter: true, rotater: true, stacker: true, mixer: true, painter: true,
    trash: false,   // trash.js:27-29 getIsRotateable()=false
    hub: false,     // hub.js:31-33 同上
});

/* ───────────────────────────── 实机 code 表（15 条，全部 rv=0） ─────────────────────────────
 * 逐条抄自 facts/building-codes-live.json（实机 dump）。belt 不在这里解决：
 * 它的 code 由 beltCode(rv) 决定（H1）。 */
export const MACHINE_CODES = Object.freeze({
    "miner|default": 7,
    "miner|chainable": 8,
    "cutter|default": 9,
    "cutter|quad": 10,
    "rotater|default": 11,
    "rotater|ccw": 12,
    "rotater|rotate180": 13,
    "stacker|default": 14,
    "mixer|default": 15,
    "painter|default": 16,
    "painter|mirrored": 17,
    "painter|double": 18,
    "painter|quad": 19,
    "trash|default": 20,
});

/* 第二个实机凭据：level-11 存档 dump（world-full.json，2805 实体）里**实际观测到**的
 * (type|variant) → code。用途：① P6 反查 code→kind 要覆盖 hub；② 与 MACHINE_CODES 交叉校验
 * （两份独立实机数据必须一致）。
 * ⚠️ 只列**存档里真有**的：stacker 不在 level-11 存档里（0 台），故此处**没有** stacker——
 *   它的 code=14 只由 facts/building-codes-live.json（专用提取实验）供给。
 * ⚠️ 这里 hub 是实机直读 code=26，与 GEOMETRY 表1 :23 的"hub 直连未实机测"不矛盾：
 *   那句说的是"把线直接插进 hub 槽位"没测过，而"hub 实体在存档里的 code=26"是直接事实（NOTES G8）。 */
export const SAVE_CODES = Object.freeze({
    "belt|default": 1,               // 存档里 rv=1→2（354 格）、rv=2→3（196 格）也在
    "balancer|default": 4,
    "miner|default": 7,
    "cutter|default": 9,             // 只有 default（quad 未出现）
    "rotater|default": 11,
    "mixer|default": 15,             // 24 台
    "painter|default": 16,
    "painter|mirrored": 17,          // 实机 15 台 mirrored
    "trash|default": 20,
    "hub|default": 26,               // 唯一一台
    "underground_belt|default": 22,  // rv=1 → 23（C4：v1 范围外，仅作交叉校验用）
});
/** 存档里带 rv≠0 的实体类型 —— 再次印证只有 belt/隧道/wire 家族有 rv 位 */
export const SAVE_TYPES_WITH_NONZERO_RV = Object.freeze(["belt", "underground_belt"]);

/** 两份实机凭据交叉校验：SAVE_CODES ∩ MACHINE_CODES 的键必须逐键相等。
 *  belt 不参与比对（它的 code 由 beltCode(rv) 管）。
 *  @returns {{overlap:string[],conflicts:Array,onlyInSave:string[],onlyInExtraction:string[]}} */
export function crossCheckCodes() {
    const overlap = [], conflicts = [], onlyInSave = [];
    for (const [k, v] of Object.entries(SAVE_CODES)) {
        if (k === "belt|default") continue;
        if (MACHINE_CODES[k] !== undefined) {
            overlap.push(k);
            if (MACHINE_CODES[k] !== v) conflicts.push({ key: k, extraction: MACHINE_CODES[k], save: v });
        } else onlyInSave.push(k);
    }
    const onlyInExtraction = Object.keys(MACHINE_CODES).filter(k => !(k in SAVE_CODES) || k === "belt|default");
    return { overlap, conflicts, onlyInSave, onlyInExtraction };
}

/** 表2：base 速率（× 对应升级倍率；倍率不在本表，V7 吞吐判定用 base 值） */
export const RATES = Object.freeze({
    belt: 2.0, miner: 0.4, rotater: 2.0, cutter: 0.5,
    stacker: 0.25, painter: 0.33, mixer: 0.4, trash: 0, hub: 0,
});

/* ───────────────────────── machine-spec.json 字段名别名（唯一一处映射） ─────────────────────────
 * P2 是**唯一**读 src/ai/machine-spec.json 字段名的地方（plan §2.2 迁移路径 2）。
 * P0-spec 的 schema 由它自己定；任何 schema 变动**只改这张表 + specEntries/normalizeEntry 各一个分支**。
 * 候选名按顺序取第一个命中的；实机优先项（code、rv 语义、belt）不走覆盖，见 loadMachineSpec 注释。
 *
 * ★ P0-spec 已落地（提交 325e436，schema 2026-10-24 实测）★
 * 顶层：{ version:"1.5.6", game_commit:"ee2279d", buildings:{...}, codes:[...], rates:{...},
 *         rateMeta, codeTableSummary, notes }
 * buildings.<building> = { variants: { <variant>: <记录> }, note }
 * 记录字段（P0-spec 的真实命名）：
 *   internalId=实机 code | size=[w,h] | acceptors/ejectors=槽位数组（元素 {tile:[x,y],dir,filter}）
 *   pins=WiredPins 引脚 | hasRotationVariants=该变体支持的 rv 列表（**直接印证 RV_ALLOWED**）
 *   verifiedBy="M1b|M2a|M3|source-only"（实机 vs 源码） | liveEvidence=人读凭据
 *   slotRole=槽位→语义映射说明 | processor=处理器类型（rateMeta 的键） | source={file,lines}
 * rates.<name>=base 速率（含 painterDouble 0.25 / painterQuad 1.0，**与内嵌表不同，见下覆盖**）。 */
export const SPEC_FIELD_ALIASES = Object.freeze({
    ROOT_LIST: ["buildings", "machines", "buildingTypes", "specs", "entities", "items", "data"],
    KEY: ["id", "key", "name", "internalName", "type"],
    BUILDING: ["building", "family", "category", "type", "id", "key", "name"],
    VARIANT: ["variant", "shape", "subType", "variantName"],
    // internalId 是 P0-spec 的实机 code 字段名（放在最前 → 优先命中）
    CODE: ["internalId", "code", "buildingCode", "numericCode", "code_in_blueprint", "szbpCode", "blueprintCode", "id_code"],
    UNLOCK_LEVEL: ["unlockLevel", "unlock_level", "level", "requiredLevel", "unlockedAtLevel", "hubLevel", "unlock"],
    FOOTPRINT: ["size", "footprint", "boundingBox", "tileSpace", "dimensions", "dims", "bbox"],
    INPUTS: ["acceptors", "inputs", "inputSlots", "acceptorSlots"],
    OUTPUTS: ["ejectors", "outputs", "outputSlots", "ejectorSlots"],
    RATE: ["ratePerSec", "rate", "speed", "throughput", "itemsPerSecond", "baseRate"],
    CELL: ["tile", "cell", "rel", "relative", "offset", "pos", "position", "at"],
    DIR: ["dir", "direction", "side", "face"],
    ROLE: ["role", "slotRole", "kind", "purpose", "slot", "name"],
    FILTER: ["filter"],
    VERIFIED_BY: ["verifiedBy", "verified", "liveVerified"],
    RV_SET: ["hasRotationVariants", "rotationVariants", "allowedRv", "rvariants"],
    VARIANTS: ["variants"],        // P0-spec 的二级容器名
});

/* ───────────────────────────── 内嵌最小表（先行落地，不等 P0-spec） ─────────────────────────────
 * 槽位逐行抄 GEOMETRY 表1（**只在 rotation=0 定义**）+ 上游 buildings/*.js 的
 * ItemAcceptor/ItemEjector slots（pos 相对格 + direction 局部方位）。
 * verifiedOnLive 承表1 的 ✅/⬜（C7 修正：quad/rotater/mixer/mirrored/hub 未实机跑）。
 *
 * 字段：op/building/variant/code/unlockLevel/footprint/inputs[]/outputs[]/ratePerSec/
 *       mustDiscardUnused/verifiedOnLive
 *       + 本包补充（plan 未禁止附加字段）：
 *         wasteRoles[] 该机器**注定是废料**的输出槽 role（cutter 右列、quad 的 1..3）
 *         filter:"shape"|"color" 槽口收什么（上游 slots 的 filter 字段）
 *         kind 用于 CompiledPlan.entities[].kind 反查 */
function slot(cell, dir, role, filter = null) {
    return filter === null ? { cell, dir, role } : { cell, dir, role, filter };
}

const EMBEDDED = [
    {
        op: "mine", building: "miner", variant: "default", code: 7,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.mine,
        footprint: [1, 1],
        inputs: [],                       // 矿机不吃带子：它"吃"自己所在的资源格（miner.js:79-85 只有 ejector）
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.miner,
        mustDiscardUnused: true,
        wasteRoles: [],
        verifiedOnLive: true,             // GEOMETRY 表1 :13 ✅ M1b/M2a/M3
        kind: "miner",
    },
    {
        op: "cut", building: "cutter", variant: "default", code: 9,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.cut,
        footprint: [2, 1],
        inputs: [slot([0, 0], "bottom", "primary", "shape")],
        outputs: [slot([0, 0], "top", "left"), slot([1, 0], "top", "right")],
        ratePerSec: RATES.cutter,
        mustDiscardUnused: true,
        wasteRoles: ["right"],            // 半切场景右列是废料（GEOMETRY 表3-4；fixtures/report-validator V9 的例）
        verifiedOnLive: true,             // ✅ M1b（产物逐字符一致）
        kind: "cutter",
    },
    {
        op: "cutQuad", building: "cutter", variant: "quad", code: 10,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.cutQuad,
        footprint: [4, 1],
        inputs: [slot([0, 0], "bottom", "primary", "shape")],
        outputs: [slot([0, 0], "top", "quad0"), slot([1, 0], "top", "quad1"),
                  slot([2, 0], "top", "quad2"), slot([3, 0], "top", "quad3")],
        ratePerSec: RATES.cutter,
        mustDiscardUnused: true,
        wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 未测（GEOMETRY 表1 :16）
        kind: "cutter",
        v1Blocked: true,                  // C6 第 3 条：quad 4 路输出 v1 需汇合方案 → P5 V8 直接 ok:false
    },
    {
        op: "rotate", building: "rotater", variant: "default", code: 11,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.rotate,
        footprint: [1, 1],
        inputs: [slot([0, 0], "bottom", "primary", "shape")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.rotater,
        mustDiscardUnused: true,
        wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 未测（GEOMETRY 表1 :17）
        kind: "rotater",
    },
    {
        op: "rotateCCW", building: "rotater", variant: "ccw", code: 12,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.rotateCCW,
        footprint: [1, 1],
        inputs: [slot([0, 0], "bottom", "primary", "shape")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.rotater,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 与 rotater 同几何，同样未实机跑
        kind: "rotater",
    },
    {
        op: "rotate180", building: "rotater", variant: "rotate180", code: 13,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.rotate180,
        footprint: [1, 1],
        inputs: [slot([0, 0], "bottom", "primary", "shape")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.rotater,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false,
        kind: "rotater",
    },
    {
        op: "paint", building: "painter", variant: "default", code: 16,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.paint,
        footprint: [2, 1],
        // painter.js:130-142 / :163-170 —— shape←left(0,0)，color←top(1,0)
        inputs: [slot([0, 0], "left", "shape", "shape"), slot([1, 0], "top", "color", "color")],
        outputs: [slot([1, 0], "right", "out")],
        ratePerSec: RATES.painter,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: true,             // ✅ M2a（RbRbRbRb）
        kind: "painter",
        flowAxis: "x",                    // GEOMETRY 表3-3：+x 系，不与 +y 系机器串同一直线
    },
    {
        op: "paintMirrored", building: "painter", variant: "mirrored", code: 17,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.paintMirrored,
        footprint: [2, 1],
        // 与 default 只差 color 口方位：painter.js:163-170（variant!==default → bottom）
        inputs: [slot([0, 0], "left", "shape", "shape"), slot([1, 0], "bottom", "color", "color")],
        outputs: [slot([1, 0], "right", "out")],
        ratePerSec: RATES.painter,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 未测（GEOMETRY 表1 :20）
        kind: "painter",
        flowAxis: "x",
    },
    {
        op: "mix", building: "mixer", variant: "default", code: 15,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.mix,
        footprint: [2, 1],
        inputs: [slot([0, 0], "bottom", "color", "color"), slot([1, 0], "bottom", "color", "color")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.mixer,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 未测（GEOMETRY 表1 :21）
        kind: "mixer",
    },
    {
        op: "stack", building: "stacker", variant: "default", code: 14,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.stack,
        footprint: [2, 1],
        // stacker.js:74-86 两个 bottom；M3 实测：**左格 = 下层，右格 = 上层**
        inputs: [slot([0, 0], "bottom", "lower", "shape"), slot([1, 0], "bottom", "upper", "shape")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.stacker,
        mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: true,             // ✅ M3（CuCuSuSu:RuRuCuCu）
        kind: "stacker",
    },
];

/** trash / belt / 其余变体：不是 plan §2.2 的 op 枚举成员，但 P3/P5/P6 需要它们的 code+占地反查 */
const AUX = [
    {
        op: "trash", building: "trash", variant: "default", code: 20,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.trash,
        footprint: [1, 1],
        // trash.js:74-92 —— 四边全收，同格 (0,0)
        inputs: [slot([0, 0], "top", "primary"), slot([0, 0], "right", "primary"),
                 slot([0, 0], "bottom", "primary"), slot([0, 0], "left", "primary")],
        outputs: [],
        ratePerSec: 0, mustDiscardUnused: false, wasteRoles: [],
        verifiedOnLive: true,             // ✅ M1b/M2a/M3
        kind: "trash",
    },
    {
        op: "belt", building: "belt", variant: "default", code: beltCode(0), // = 1；rv 位见 codeFor
        unlockLevel: 1, footprint: [1, 1], inputs: [], outputs: [],
        ratePerSec: RATES.belt, mustDiscardUnused: false, wasteRoles: [],
        verifiedOnLive: true,             // ✅ M1b + exp-rv-fix3
        kind: "belt",
    },
    /* balancer：2 进 2 出，**内容不变**、只改流向（见下方 note）。
     *
     * 几何来自 buildings/balancer.js:178-196（default variant）：
     *   输入  local (0,0) ← bottom、local (1,0) ← bottom
     *   输出  local (0,0) → top   、local (1,0) → top
     * 占地在 balancer.js:60-62 = Vector(2,1)。
     *
     * 语义（systems/item_processor.js:342-362 process_BALANCER）：把收到的每一件依次塞进
     * `nextOutputSlot++ % availableSlots` —— 即**轮流发到两个输出槽**，从不改动 item 本身。
     * 所以它是编译器里的**透传节点**：进去什么形状，出来还是什么形状，只是分成两路。
     *
     * 这正是"一个输出喂多个消费者"（扇出）缺的那块：以前 place() 一遇到扇出就整段拒绝
     * （place.mjs 的 `n.consumers > 1` 分支）。真人存档 514 个 balancer（level-11 那个）
     * 也印证它是常规组网手段，不是特例。
     *
     * 解锁：level 3 → reward_balancer（modes/levels.js:41「RuRuRuRu × 30」）。
     */
    {
        op: "balance", building: "balancer", variant: "default", code: 4,
        unlockLevel: 3,
        footprint: [2, 1],
        // role 必须落在 types.mjs 的 slotRole 枚举里（primary/secondary/…/out/discard），
        // "a"/"b" 会被契约闸拒。两路都用 primary：balancer 的两路是等价的。
        inputs: [slot([0, 0], "bottom", "primary"), slot([1, 0], "bottom", "secondary")],
        outputs: [slot([0, 0], "top", "primary"), slot([1, 0], "top", "secondary")],
        // 不设速率瓶颈：它只是把上游的流量分成两路，两路合计仍受上游限制。
        // 取 null（非数字）而不是 0 —— 0 会被 bottleneckOf 当成"零产能"而误判成卡口。
        ratePerSec: null,
        mustDiscardUnused: false, wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 几何源码核证；实机未单测
        codeVerifiedOnLive: true,         // ← level-11 存档直读 code=4 × 514
        kind: "balancer",
        passthrough: true,                // ← 形状不变：编译器可以把它当"分叉点"处理
        note: "process_BALANCER 只做 nextOutputSlot++ % 2，不改 item ⇒ 透传。"
            + "扇出改写要插的就是这个节点。",
    },
    {
        op: "mineChainable", building: "miner", variant: "chainable", code: 8,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.mineChainable, footprint: [1, 1],
        inputs: [], outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.miner, mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false,            // ⬜ 链式矿机实机未单测（同 default 几何）
        kind: "miner",
    },
    {
        op: "paintDouble", building: "painter", variant: "double", code: 18,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.paintDouble, footprint: [2, 2],
        // painter.js:186-207 —— 两个 shape 口都在 left，(0,0) 与 (0,1)
        inputs: [slot([0, 0], "left", "shape", "shape"), slot([0, 1], "left", "secondary", "shape"),
                 slot([1, 0], "top", "color", "color")],
        outputs: [slot([1, 0], "right", "out")],
        ratePerSec: RATES.painter, mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false, kind: "painter", flowAxis: "x",
        note: "footprint [2,2] 由上游 painter.js:51-52 推（P0-spec 源码核证一致）。ratePerSec 内嵌借 painter 的 0.33 占位，" +
              "P0-spec 落地后被覆盖为 0.25 —— ⚠️ 那是 **charges/s**，件/s 是 0.5（每 charge 出 2 件），见 NOTES G10",
    },
    {
        op: "paintQuad", building: "painter", variant: "quad", code: 19,
        unlockLevel: UNLOCK_LEVEL_FALLBACK.paintQuad, footprint: [4, 1],
        // painter.js:250-272 —— shape←(0,0)left，4 个 color←bottom(0..3,0)；出→(0,0)top
        inputs: [slot([0, 0], "left", "shape", "shape"), slot([0, 0], "bottom", "color", "color"),
                 slot([1, 0], "bottom", "color", "color"), slot([2, 0], "bottom", "color", "color"),
                 slot([3, 0], "bottom", "color", "color")],
        outputs: [slot([0, 0], "top", "out")],
        ratePerSec: RATES.painter, mustDiscardUnused: true, wasteRoles: [],
        verifiedOnLive: false, kind: "painter",
        v1Blocked: true, note: "quad painter 需 WiredPins（wire 层）→ C3：v1 范围外",
    },
    /* hub：不是 op，但 P6 反查 code→kind、P3 连 hub 都要它。
     * 16 个入口逐格来自上游 hub.js:73-91（与 GEOMETRY 表1 :23、exp-e2e.mjs:93-102 的 hubEntries 同一张表）：
     *   顶排 (i,0) dir=top / 底排 (i,3) dir=bottom / 左列 (0,i) dir=left / 右列 (3,i) dir=right
     * ⚠️ 表1 把 hub 标 ⬜（"直连未实机测"= 没验证过把带子直接插进 hub 槽位）；
     *    但 hub **实体本身**是实机观测过的：facts/live/world-full.json 里唯一一台 hub = code 26、r=0、rv=0
     *    → code/footprint 有实机凭据，槽位几何是源码核证（verifiedOnLive 保守取 false，见 NOTES G8）。 */
    {
        op: "hub", building: "hub", variant: "default", code: 26,
        unlockLevel: 1, footprint: [4, 4],
        inputs: (() => {
            const s = [];
            for (let i = 0; i < 4; i++) {
                s.push(slot([i, 0], "top", "primary", "shape"));
                s.push(slot([i, 3], "bottom", "primary", "shape"));
                s.push(slot([0, i], "left", "primary", "shape"));
                s.push(slot([3, i], "right", "primary", "shape"));
            }
            return s;
        })(),
        outputs: [],
        ratePerSec: 0, mustDiscardUnused: false, wasteRoles: [],
        verifiedOnLive: false,             // 槽位未实机测（表1 :23）；code/占地已实机观测
        codeVerifiedOnLive: true,          // ← 区分这两件事：level-11 存档直读 code=26
        kind: "hub",
    },
];

/** op(名) → OpTemplate，全部导出为普通对象（plan §2.2 归一形式） */
export const OP_TEMPLATES = Object.fromEntries(EMBEDDED.map(t => [t.op, t]));
/** 非 op 枚举成员但必须的实体（trash/belt/额外变体） */
export const AUX_TEMPLATES = Object.fromEntries(AUX.map(t => [t.op, t]));

/** plan §2.2 的 10 个 op 枚举成员 == GEOMETRY 表2 覆盖到的建筑集合。
 *  这 10 个的 ratePerSec 以**表2 为权威**，spec 不同只登记（plan §1.2）；
 *  表2 没列的变体（painterDouble/painterQuad）允许 spec 补值（见 loadMachineSpec 速率分支）。 */
const V1_OPS = new Set(Object.keys(OP_TEMPLATES));

/** 合并视图：P6 反查 code→kind、P3 放置任意实体时用这张 */
export const ALL_TEMPLATES = Object.freeze({ ...OP_TEMPLATES, ...AUX_TEMPLATES });

export function opByName(op) {
    const t = ALL_TEMPLATES[op];
    if (!t) throw new SpecError("opByName(op)", "已知 op 名之一", op, "validate:V8-scope");
    return t;
}
/**
 * 隧道的两条"合成模板"：code 22/23 ↔ underground_belt 的 sender/receiver。
 *
 * 为什么要合成：`OP_TEMPLATES` 是**算子**表（mine/cut/stack…），隧道不是算子而是布线元件，
 * 所以它不在 EMBEDDED 里。但 P6 发射时需要从 code 反查建筑（"不依赖游戏注册表"的自证），
 * 没有它就只能拒绝隧道蓝图。
 *
 * 依据（实机确认）：`buildings/underground_belt.js:45-48` 的 getAllVariantCombinations
 *   { internalId: 22, variant: default, rotationVariant: 0 }  → sender（入口）
 *   { internalId: 23, variant: default, rotationVariant: 1 }  → receiver（出口）
 * 两者都是 1×1、靠 `rotation` 表达朝向（存档里是 180/90）。
 */
const TUNNEL_TEMPLATES = Object.freeze([
    Object.freeze({
        op: "tunnelSender", building: "underground_belt", variant: "default",
        kind: "underground_belt", code: 22, footprint: Object.freeze([1, 1]),
        inputs: Object.freeze([]), outputs: Object.freeze([{ cell: Object.freeze([0, 0]), dir: "top", role: "out" }]),
        ratePerSec: null, isTunnel: true,
    }),
    Object.freeze({
        op: "tunnelReceiver", building: "underground_belt", variant: "default",
        kind: "underground_belt", code: 23, footprint: Object.freeze([1, 1]),
        inputs: Object.freeze([{ cell: Object.freeze([0, 0]), dir: "top", role: "in" }]), outputs: Object.freeze([]),
        ratePerSec: null, isTunnel: true,
    }),
]);

export function templateForBuildingCode(code) {
    const all = [...EMBEDDED, ...AUX, ...TUNNEL_TEMPLATES];
    return all.find(t => t.code === code) || null;
}
export function templateByBuildingVariant(building, variant) {
    /* ⚠️ **不含** TUNNEL_TEMPLATES：sender/receiver 共用 building+variant，
       按 (building,variant) 反查会二选一，spec 加载循环会把两者的字段互相覆盖。
       隧道只能按 **code** 查（templateForBuildingCode）。 */
    const all = [...EMBEDDED, ...AUX];
    return all.find(t => t.building === building && t.variant === variant) || null;
}

/* ───────────────────────────── codeFor：code 计算（H1/H2/H3 落点） ───────────────────────────── */

const ROT_ANGLES = [0, 90, 180, 270];

/** 严格象限校验：非 0/90/180/270 的角度**直接抛**，不静默截断。
 *  ⚠️ 为什么不能依赖 belt-rules.rotateLocal：它对非 90 倍数角度做 `|0` **截断**
 *  （45° → 当 0° 用），而同文件的 angleToDir 却是"量化到最近象限"（Math.round）。
 *  两者语义不同 → 任何角度先过本函数。见 NOTES.md G7（已上报主 Agent）。 */
function assertQuadrantAngle(rot, pathKey) {
    if (typeof rot !== "number" || !Number.isFinite(rot))
        throw new SpecError(pathKey, "0|90|180|270（整数角度）", rot, "emit:mismatch");
    const r = norm360(Math.trunc(rot));
    if (!ROT_ANGLES.includes(r))
        throw new SpecError(pathKey, `0|90|180|270（量化后）；注意 rotateLocal 对非象限角是**截断**不是量化，故此处强制拒绝`, rot,
            "emit:mismatch");
    return r;
}

/**
 * 建筑实机 code。
 *   belt：唯一权威 = beltCode(rv) = 1 + rv（H1，实机 1906/1906）。
 *   其他：查 MACHINE_CODES（实机 15 条，全部 rv=0）；**rv≠0 → 抛错**（H2，无编码证据）。
 * rotation 不影响非 belt 的 code（building-codes-live.json 里同一建筑 0/90/180/270 四个朝向 code 全等），
 * 但 v1 是否允许旋转由 assertV1Rotation() 单独把关（D1）。
 * @param {string} building @param {string} variant @param {number} rot @param {number} rv
 * @returns {number}
 */
export function codeFor(building, variant = "default", rot = 0, rv = 0) {
    if (typeof building !== "string" || building.length === 0)
        throw new SpecError("codeFor.building", "非空建筑名", building, "emit:mismatch");
    assertQuadrantAngle(rot, "codeFor.rot");
    if (typeof rv !== "number" || !Number.isInteger(rv))
        throw new SpecError("codeFor.rv", "整数 rotationVariant", rv, "emit:mismatch");

    if (building === "belt") {
        // H1：belt 族 code 只看 rv，与 rot 无关；rv∈{0,1,2}（直/左弯/右弯）
        if (rv < 0 || rv > 2) throw new SpecError("codeFor.rv", "belt rv ∈ {0,1,2}", rv, "emit:mismatch");
        return beltCode(rv);
    }
    // codeFor 是**世界真值解码器**：凡实机观测过的 (building|variant) 都要能解出 code，
    // 包括 v1 范围外的 tunnel/wire —— P7 读回 level-11 存档对拍时必须能解码 182 条隧道。
    // "编译器有没有权产出它"是另一件事，交给 isV1Emittable()（P5 的 V8-scope 用它）。
    const key = `${building}|${variant}`;
    // MACHINE_CODES = 15 条专用提取实验；SAVE_CODES = level-11 存档实机直读（hub/balancer/隧道只在这里有）。
    // 两张表都必须与各自的原始数据文件逐键相等 —— 由包测试直接读文件校验。
    let code = MACHINE_CODES[key] ?? SAVE_CODES[key];
    /* ★ 隧道：rv 是 sender/receiver 位，code = 基码 + rv（22 → sender、23 → receiver）★
       MACHINE_CODES/SAVE_CODES 只登记基码（rv=0 的那一个），rv=1 的 23 不在表里；
       但注册表 `underground_belt.js:45-48` 明确给了 22/23 两条，且 level-11 存档里
       两种 code 各 107 个 —— 这是**实机凭据**，不是推测。 */
    if (building === "underground_belt" && code !== undefined && rv === 1) code = code + 1;
    if (code === undefined)
        throw new SpecError(`codeFor(${key})`, "已知 building|variant 组合（见 MACHINE_CODES / SAVE_CODES）", key, "emit:mismatch");
    // H2：非 belt 只允许 rv=0。隧道/wire **确有** rv≠0 的 code（存档：22→23），
    // 但它们的 rv **语义**不在本包证据范围内（belt 的 rv 语义由 belt-rules 供给），
    // 且两者都是 v1 范围外 → 这里只承认 rv=0，rv≠0 一律拒绝并指向 isV1Emittable。
    if (!allowedRvariants(building).includes(rv)) {
        const scope = v1ScopeReason(building);
        throw new SpecError(
            `codeFor("${building}","${variant}").rv`,
            scope
                ? `${building} 属 v1 范围外（${scope}）；它确有 rv≠0 的 code，但 rv **语义**无凭据 → 本包只承认 rv=0`
                : `非 belt 建筑 rv 必须为 0（building-codes-live.json 60 条全 rv=0 + level-11 存档 2805 实体中非 belt/非隧道 rv 恒 0 + meta_building_registry.js:42-53 注册表不存在 rv≠0）`,
            rv, scope ?? "out-of-scope:rotated-machine");
    }
    return code;
}

/** 该建筑**有 code 凭据**的 rv 取值（见 RV_ALLOWED 注释）。
 *  未列出的建筑默认 **[0]** —— 这正是注册表证据的含义：只有 belt/隧道/wire 注册过 rv≠0。
 *  ⚠️ 这里回答的是"解码得出来吗"，不是"v1 能产出吗"（后者 = isV1Emittable）。
 *  ⚠️ 隧道虽有 code 23（rv=1）但语义无凭据 → 本表只承认 rv=0。 */
export function allowedRvariants(building) {
    return RV_ALLOWED[building] ?? [0];
}

/** v1 范围外建筑的专门分诊 reason（in-scope 的返回 null）；P5 的 V8-scope / §2.5 枚举用。 */
export function v1ScopeReason(building) {
    if (OUT_OF_SCOPE_BUILDINGS_WITH_RV.includes(building))
        return building === "wire" ? "out-of-scope:wire" : "out-of-scope:tunnel";
    return null;
}

/** code 是"世界的真值"，**emit 权限**是另一回事：
 *  - codeFor / templateForBuildingCode 覆盖**所有观测到的** code（含 balancer=4、hub=26），
 *    因为 P7 读回落盘世界时必须能解码它们（存档里真有 475 台 balancer）。
 *  - 编译器**只应产出** v1 op 集合里的东西。P5 的 V8-scope 用本函数把关。
 *  @param {string} building @param {string} variant @returns {boolean} */
export function isV1Emittable(building, variant = "default") {
    if (v1ScopeReason(building)) return false;                                        // C3/C4
    const t = templateByBuildingVariant(building, variant);
    if (!t) return false;
    if (t.v1Blocked) return false;                                                    // quad cutter / quad painter
    // v1 的产出集合 = OP_TEMPLATES（plan §2.2 op 枚举）+ trash + belt + hub（hub 是终点，不是 op）
    return OP_TEMPLATE_OPS.includes(t.op) || ["trash", "belt", "hub"].includes(building);
}
const OP_TEMPLATE_OPS = Object.keys(OP_TEMPLATES);

/** 该建筑**能否**旋转（上游 getIsRotateable + 存档实机印证）。未知建筑名 → null（不抛，P5 自行决定）。 */
export function isRotatable(building) {
    return building in ROTATABLE ? ROTATABLE[building] : null;
}

/** D1 守卫：v1 加工机器朝向恒 0。
 *  例外：belt（rot 是它本来的方向语义）、trash/hub —— 后两者上游 getIsRotateable()=false
 *  （trash.js:27-29 / hub.js:31-33），**游戏里就恒 r=0**（存档实机印证：10 台 trash + 1 台 hub 全 r=0）。
 *  所以对 trash/hub 放行任意 rot 是不对的：它们只允许 r=0，且放行原因是"游戏不让转"。 */
export function assertV1Rotation(building, rot = 0) {
    const r = assertQuadrantAngle(rot, `rotation("${building}")`);
    if (building === "belt") return r;
    /* 隧道（underground_belt）也是**靠 rot 表达朝向**的布线元件，和 belt 同类：
       sender/receiver 各自朝哪个方向就由 rotation 决定（实机存档里是 180/90）。
       "加工机器恒 r=0" 防的是机器旋转后 ejector/acceptor 方位整体移位，
       而隧道的 ejector/acceptor 方位**本来就是随 rot 走的**。 */
    if (building === "underground_belt") return r;
    if (r !== 0 && ROTATABLE[building] === false)
        throw new SpecError(`rotation("${building}")`,
            "上游 getIsRotateable()=false ⇒ 恒 r=0（trash.js:27-29 / hub.js:31-33，存档实机印证）", rot,
            "out-of-scope:rotated-machine");
    if (r !== 0) throw new SpecError(`rotation("${building}")`, "v1 加工机器 rotation 必须为 0（决策 D1）", rot,
        "out-of-scope:rotated-machine");
    return r;
}

/* ───────────────────────────── 世界槽位（未来旋转机器用；v1 恒 r=0） ───────────────────────────── */

/** 局部方位 → 世界方位。**委托** belt-rules 的 rotateLocal（不二次实现），
 *  但先严格校验角度是象限角 —— rotateLocal 对非 90 倍数角度是 `|0` 截断（45→按 0 用），
 *  静默给错方位；这里把它变成显式错误（NOTES G7）。 */
export function rotateSlot(localDir, rotation) {
    if (!ORDER.includes(localDir))
        throw new SpecError("rotateSlot.localDir", "top|right|bottom|left", localDir, "emit:mismatch");
    assertQuadrantAngle(rotation, "rotateSlot.rotation");
    return rotateLocal(localDir, rotation);
}

/** 把 slot 的相对格坐标按 rotation 绕 origin 旋转（4×4 之类方阵适用；
 *  ⚠️ 非方形 footprint 旋转时上游 static_map_entity.js 会位移 origin，实机未验证 → 本函数
 *  **只用于方形占地**，非方形一律走 assertV1Rotation 拦住。见 NOTES G6）。 */
export function rotateCell(cell, rotation, footprint = [1, 1]) {
    const r = assertQuadrantAngle(rotation, "rotateCell.rotation");
    const steps = (r / 90) | 0;
    const [w, h] = footprint;
    if (steps === 0) return [cell[0], cell[1]];
    // 方形：绕 (w-1)/2 顺时针（y 向下）旋转
    const [dx, dy] = cell;
    if (w !== h)
        throw new SpecError("rotateCell.footprint", "非方形占地在 rotation≠0 时 origin 位移未实机验证 → 只允许 rotation=0",
            footprint, "out-of-scope:rotated-machine");
    const c = (w - 1) / 2;
    const x = dx - c, y = dy - c;
    let out = [x, y];
    for (let i = 0; i < steps; i++) out = [-out[1], out[0]];   // y 向下 ⇒ 顺时针 = (x,y)→(-y,x)
    return [out[0] + c, out[1] + c];
}

/** 模板在 rotation 下的世界槽位（inputs/outputs 深拷贝，dir 已旋转） */
export function worldSlots(template, rotation = 0) {
    const r = assertQuadrantAngle(rotation, "worldSlots.rotation");
    const conv = list => list.map(s => ({
        ...s,
        cell: rotateCell(s.cell, r, template.footprint),
        dir: rotateSlot(s.dir, r),
    }));
    return { inputs: conv(template.inputs), outputs: conv(template.outputs) };
}

/** v1 世界占地（rotation 必须 0，否则抛 D1） */
export function machineWorldBounds(template, origin, rotation = 0) {
    assertV1Rotation(template.building, rotation);
    const [w, h] = template.footprint;
    return { x0: origin[0], y0: origin[1], x1: origin[0] + w - 1, y1: origin[1] + h - 1, w, h };
}

/* ───────────────────────── machine-spec.json 适配（唯一一处读字段名） ───────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SPEC_PATH = path.join(HERE, "machine-spec.json");

/** 按候选名取第一个命中的字段 */
function pick(obj, candidates) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const k of candidates) if (obj[k] !== undefined) return obj[k];
    return undefined;
}
/** 从 spec 里拿到"机器列表"。支持三种形态：
 *   (1) 数组 [ {…}, … ]
 *   (2) 对象映射 { miner: {…}, cutter: {…} }
 *   (3) **P0-spec 的实际形态**：{ buildings: { miner: { variants: { default:{…}, chainable:{…} } } } }
 *       —— 二级 variants 容器会被**展平**成一条条形如 {building, variant, ...记录字段} 的条目。 */
function specEntries(raw) {
    if (Array.isArray(raw)) return flattenVariants(raw);
    let root = null, rootKey = null;
    for (const k of SPEC_FIELD_ALIASES.ROOT_LIST) {
        if (Array.isArray(raw[k])) return flattenVariants(raw[k]);
        if (raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) { root = raw[k]; rootKey = k; break; }
    }
    if (!root) {
        // 裸映射：顶层就是 { "cutter": {...}, ... }（无 buildings 包裹）
        const vals = Object.values(raw);
        if (vals.length && vals.every(v => v && typeof v === "object")) root = raw;
        else return null;
    }
    const entries = Object.entries(root).map(([name, v]) =>
        (v && typeof v === "object" && !Array.isArray(v))
            ? { ...v, [SPEC_FIELD_ALIASES.BUILDING[0]]: v[SPEC_FIELD_ALIASES.BUILDING[0]] ?? name }
            : { [SPEC_FIELD_ALIASES.BUILDING[0]]: name, code: v });
    void rootKey;
    return flattenVariants(entries);
}
/** 把带 `variants:{...}` 的条目展平成每条一个变体（P0-spec 形态）；无 variants 的原样返回 */
function flattenVariants(entries) {
    const out = [];
    for (const e of entries) {
        const vs = e && typeof e === "object" ? e[SPEC_FIELD_ALIASES.VARIANTS[0]] : null;
        if (vs && typeof vs === "object" && !Array.isArray(vs)) {
            for (const [vname, rec] of Object.entries(vs)) {
                if (!rec || typeof rec !== "object") continue;
                out.push({ ...rec,
                    [SPEC_FIELD_ALIASES.BUILDING[0]]: e[SPEC_FIELD_ALIASES.BUILDING[0]] ?? e.building,
                    [SPEC_FIELD_ALIASES.VARIANT[0]]: vname });
            }
        } else out.push(e);
    }
    return out;
}
/** 一条 spec 记录 → 归一候选对象（拿不到就返回 null） */
function normalizeEntry(e) {
    const building = pick(e, SPEC_FIELD_ALIASES.BUILDING);
    const variant = pick(e, SPEC_FIELD_ALIASES.VARIANT) ?? "default";
    const code = pick(e, SPEC_FIELD_ALIASES.CODE);
    if (typeof building !== "string" || typeof code !== "number") return null;
    return {
        building, variant, code,
        key: pick(e, SPEC_FIELD_ALIASES.KEY) ?? `${building}|${variant}`,
        unlockLevel: pick(e, SPEC_FIELD_ALIASES.UNLOCK_LEVEL),
        footprint: pick(e, SPEC_FIELD_ALIASES.FOOTPRINT),
        inputs: pick(e, SPEC_FIELD_ALIASES.INPUTS),
        outputs: pick(e, SPEC_FIELD_ALIASES.OUTPUTS),
        ratePerSec: pick(e, SPEC_FIELD_ALIASES.RATE),
        verifiedBy: pick(e, SPEC_FIELD_ALIASES.VERIFIED_BY),
        rvSet: pick(e, SPEC_FIELD_ALIASES.RV_SET),
        source: e.source,
    };
}

/**
 * 读 machine-spec.json → 用它的值覆盖内嵌表，并把差异/缺口登记进返回值。
 * 不可识别 / 文件不存在 → **保留内嵌表** + 记 gap（绝不 fork 那个文件）。
 * @param {string} [file] @returns {{templates:Object, diffs:Array, gaps:string[], recognized:boolean, source:string|null}}
 */
export function loadMachineSpec(file = DEFAULT_SPEC_PATH) {
    const diffs = [], gaps = [];
    const templates = structuredCloneSafe(ALL_TEMPLATES);

    if (!fs.existsSync(file)) {
        gaps.push(`machine-spec.json 不存在（${path.relative(process.cwd(), file)}）→ 用内嵌表`);
        return { templates, diffs, gaps, recognized: false, source: null };
    }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) {
        gaps.push(`machine-spec.json 解析失败：${err.message} → 用内嵌表`);
        return { templates, diffs, gaps, recognized: false, source: file };
    }
    const entries = specEntries(raw);
    if (!entries) {
        gaps.push("machine-spec.json schema 无法识别（没有可映射的机器列表 / 没有 building+code 字段）→ 用内嵌表；差异已记录以便改 SPEC_FIELD_ALIASES");
        return { templates, diffs, gaps, recognized: false, source: file };
    }
    let matched = 0;
    const unknownCombos = new Set();
    const rates = raw && raw.rates && typeof raw.rates === "object" ? raw.rates : null;
    for (const item of entries) {
        const n = normalizeEntry(item);
        if (!n) continue;
        const key = `${n.building}|${n.variant}`;
        const mine = MACHINE_CODES[key];
        const t = templateByBuildingVariant(n.building, n.variant);

        // —— H1：belt 族一律以 belt-rules 为准 ——
        if (n.building === "belt") {
            if (n.code !== beltCode(0))
                diffs.push({ op: "belt", field: "code", embedded: beltCode(0), spec: n.code, kept: beltCode(0), why: "H1：belt code 唯一权威 = beltCode(rv)=1+rv（实机 1906/1906），machine-spec 被驳回" });
            // P0-spec 的 beltVariants（rv→exitLocal/code）与 belt-rules 的 EXIT_LOCAL 同表 → 只核对不覆盖
            const bv = item.beltVariants;
            if (bv) {
                for (const rv of Object.keys(bv)) {
                    const specExit = bv[rv] && bv[rv].exitLocal;
                    if (specExit && specExit !== EXIT_LOCAL[rv])
                        diffs.push({ op: "belt", field: `beltVariants[${rv}].exitLocal`, embedded: EXIT_LOCAL[rv], spec: specExit, kept: EXIT_LOCAL[rv], why: "H1：belt 出口局部方位的唯一权威是 belt-rules.EXIT_LOCAL" });
                }
            }
            matched++; continue;
        }
        if (!t) { unknownCombos.add(key); continue; }

        if (mine !== undefined && mine !== n.code)
            diffs.push({ op: t.op, field: "code", embedded: mine, spec: n.code, kept: mine,
                why: "实机 building-codes-live.json 优先于 machine-spec（rv=0 的 code 有实机凭据）" });
        else matched++;

        // 覆盖型字段：spec 有值且与内嵌不同 → 记录，按 plan §2.2「用它的值覆盖」
        if (typeof n.unlockLevel === "number" && n.unlockLevel !== t.unlockLevel) {
            diffs.push({ op: t.op, field: "unlockLevel", embedded: t.unlockLevel, spec: n.unlockLevel, kept: n.unlockLevel, why: "spec 权威（内嵌表是 §2.2 兜底常量）" });
            templates[t.op].unlockLevel = n.unlockLevel;
        }
        const fp = normalizeFootprint(n.footprint);
        if (fp && (fp[0] !== t.footprint[0] || fp[1] !== t.footprint[1])) {
            diffs.push({ op: t.op, field: "footprint", embedded: t.footprint, spec: fp, kept: fp, why: "spec 覆盖内嵌表（GEOMETRY 表1 与 spec 冲突时以 spec 记差异，需回实机复核）" });
            templates[t.op].footprint = fp;
        }
        // 速率：P0-spec 的速率在顶层 rates{} 里按 processor 名索引（记录里没有 ratePerSec）。
        // 权威方向与"槽位几何"一致：**GEOMETRY 表2 覆盖到的 op → 表2 权威、只登记不覆盖**；
        // 表2 没给的变体（painterDouble/painterQuad 这类 AUX，内嵌是借同族值的占位）→ spec 补值。
        // ⚠️ 这样切还有个安全理由：spec 的数值口径是 **charges/s**，对 v1 的 op 恰好
        //    等于 items/s（每 charge 出 1 件），但 painterDouble 每 charge 出 **2** 件
        //    （0.25 charges/s = 0.5 件/s）、painterQuad 出 4 件 → 直接覆盖会把单位口径混进 V7。
        const specRate = typeof n.ratePerSec === "number" ? n.ratePerSec : lookupSpecRate(rates, item.processor);
        if (typeof specRate === "number" && specRate !== t.ratePerSec) {
            if (V1_OPS.has(t.op)) {
                diffs.push({ op: t.op, field: "ratePerSec", embedded: t.ratePerSec, spec: specRate, kept: t.ratePerSec,
                    why: "GEOMETRY 表2 为 base 速率权威（plan §1.2）→ 保留内嵌；差异仅圆整（如 painter 0.33 vs 1/6=0.3333…）" });
            } else {
                diffs.push({ op: t.op, field: "ratePerSec", embedded: t.ratePerSec, spec: specRate, kept: specRate,
                    why: "表2 未给该变体（内嵌是借同族值的占位）→ spec 补值。⚠️ spec 口径是 charges/s，" +
                         "该变体每 charge 出多件 → 件/s 需换算，见 spec 的 rateMeta.formulas（NOTES G10）" });
                templates[t.op].ratePerSec = specRate;
            }
        }
        // verifiedBy → verifiedOnLive：P0-spec 的 "M1b/M2a/M3" == 实机流动验证，"source-only" == 未实机
        if (typeof n.verifiedBy === "string") {
            const specLive = /M1b|M2a|M3|M4|e2e|rv-fix/.test(n.verifiedBy);
            if (specLive !== t.verifiedOnLive) {
                diffs.push({ op: t.op, field: "verifiedOnLive", embedded: t.verifiedOnLive, spec: specLive, kept: specLive,
                    why: "spec 覆盖内嵌表（P0-spec 的 verifiedBy 逐条带了实验号，比 GEOMETRY 表1 的 ✅/⬜ 更细）" });
                templates[t.op].verifiedOnLive = specLive;
            }
        }
        // hasRotationVariants → RV_ALLOWED：**只登记，不覆盖**（belt 之外的 rv 语义无凭据，见 RV_ALLOWED 注释）
        if (Array.isArray(n.rvSet)) {
            const specRv = n.rvSet.filter(v => v !== 0);
            if (specRv.length && !specRv.every(v => allowedRvariants(n.building).includes(v)))
                diffs.push({ op: t.op, field: "hasRotationVariants", embedded: allowedRvariants(n.building), spec: n.rvSet, kept: allowedRvariants(n.building),
                    why: `spec 给了 rv ${JSON.stringify(n.rvSet)}（源码注册表），但 rv 的**语义**无实机凭据且 ${n.building} 不产 rv≠0 → 保留 rv=0-only` });
        }
        const slotsIn = normalizeSlots(n.inputs), slotsOut = normalizeSlots(n.outputs);
        // 槽位是几何真值：GEOMETRY 表1 为权威，spec 不同只登记、不改写
        if (slotsIn && slotsIn.length !== t.inputs.length)
            diffs.push({ op: t.op, field: "inputs.length", embedded: t.inputs.length, spec: slotsIn.length, kept: t.inputs.length, why: "GEOMETRY 表1 为槽位数权威 → 保留内嵌，登记差异" });
        else if (slotsIn && slotSignature(slotsIn) !== slotSignature(t.inputs.map(s => ({ cell: s.cell, dir: s.dir }))))
            diffs.push({ op: t.op, field: "inputs.geometry", embedded: slotSignature(t.inputs.map(s => ({ cell: s.cell, dir: s.dir }))), spec: slotSignature(slotsIn), kept: "内嵌", why: "GEOMETRY 表1 为槽位几何权威 → 保留内嵌，登记差异" });
        if (slotsOut && slotsOut.length !== t.outputs.length)
            diffs.push({ op: t.op, field: "outputs.length", embedded: t.outputs.length, spec: slotsOut.length, kept: t.outputs.length, why: "GEOMETRY 表1 为槽位数权威 → 保留内嵌，登记差异" });
        else if (slotsOut && slotSignature(slotsOut) !== slotSignature(t.outputs.map(s => ({ cell: s.cell, dir: s.dir }))))
            diffs.push({ op: t.op, field: "outputs.geometry", embedded: slotSignature(t.outputs.map(s => ({ cell: s.cell, dir: s.dir }))), spec: slotSignature(slotsOut), kept: "内嵌", why: "GEOMETRY 表1 为槽位几何权威 → 保留内嵌，登记差异" });
        if (!slotsIn && t.inputs.length) gaps.push(`${t.op}: machine-spec 未提供 inputs 槽位 → 用内嵌（GEOMETRY 表1）`);
        if (!slotsOut && t.outputs.length) gaps.push(`${t.op}: machine-spec 未提供 outputs 槽位 → 用内嵌（GEOMETRY 表1）`);
    }
    // 内嵌表没有的组合：P0-spec 是**全部 28 个建筑**的注册表，v1 只用其中 8 个家族。
    // 这是**预期**而非异常 → 汇总成一条 gap，别把报告刷成 33 行噪声（NOTES G2）。
    if (unknownCombos.size) {
        const combos = [...unknownCombos].sort();
        const fams = [...new Set(combos.map(k => k.split("|")[0]))].sort();
        const shown = combos.length <= 8 ? combos.join(", ") : combos.slice(0, 8).join(", ") + ` …（共 ${combos.length} 个）`;
        gaps.push(`machine-spec 覆盖 ${combos.length} 个内嵌表没有的 (building|variant)，涉及 ${fams.length} 个 v1 不需要的建筑家族：${fams.join(", ")} → 全部忽略（本包只管 v1 op 集；要支持新的就加 AUX 模板）。明细：${shown}`);
    }
    // 槽位几何对拍结果（无论有无差异都记一条，这是本包内嵌表与 P0-spec 的交叉验证凭据）
    const slotDiffs = diffs.filter(d => /\.length$|\.geometry$/.test(d.field));
    gaps.push(slotDiffs.length === 0
        ? `交叉验证：内嵌表的槽位几何与 machine-spec（源码核证）**逐格一致**（15 个组合的 acceptors/ejectors 数量+tile+dir 全部吻合，0 差异）`
        : `⚠️ 槽位几何与 machine-spec 有 ${slotDiffs.length} 处不一致：${slotDiffs.map(d => `${d.op}.${d.field}`).join(", ")}（保留内嵌=GEOMETRY 表1，需人工裁决）`);
    // P0-spec 不带解锁等级字段（实测）→ 全用 §2.2 兜底常量，集中记一条
    if (entries.some(e => normalizeEntry(e)) && !entries.some(e => typeof pick(e, SPEC_FIELD_ALIASES.UNLOCK_LEVEL) === "number"))
        gaps.push("machine-spec 无 unlockLevel/unlock_level 字段 → 用 UNLOCK_LEVEL_FALLBACK 兜底（plan §2.2 迁移路径的登记项，NOTES G3）");
    if (matched === 0) {
        gaps.push("machine-spec.json 与内嵌表零命中（字段名不同）→ 保留内嵌表 + 需在 SPEC_FIELD_ALIASES 加映射");
        return { templates, diffs, gaps, recognized: false, source: file };
    }
    return { templates, diffs, gaps, recognized: true, source: file };
}

/** P0-spec 的速率在顶层 rates{} 里、按 processor 名索引（记录本身没有 ratePerSec）。
 *  processor 形如 "cutter (inputsPerCharge 1)" / "painterDouble (inputsPerCharge 3, …)"
 *  → 取第一个括号前的标识符去 rates 里找。找不到返回 null（不猜）。 */
function lookupSpecRate(rates, processorStr) {
    if (!rates || typeof processorStr !== "string") return null;
    const name = processorStr.trim().split(/[\s(]/)[0];
    const v = rates[name];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeFootprint(fp) {
    if (!fp) return null;
    if (Array.isArray(fp) && fp.length === 2 && Number.isInteger(fp[0]) && Number.isInteger(fp[1])) return [fp[0], fp[1]];
    if (typeof fp === "object") {
        const w = fp.w ?? fp.width ?? fp.x ?? fp[0], h = fp.h ?? fp.height ?? fp.y ?? fp[1];
        if (Number.isInteger(w) && Number.isInteger(h)) return [w, h];
    }
    return null;
}
function normalizeSlots(list) {
    if (!Array.isArray(list)) return null;
    return list.map(s => {
        if (Array.isArray(s)) return { cell: s, dir: null, role: null };
        const cell = pick(s, SPEC_FIELD_ALIASES.CELL);
        const out = { cell: Array.isArray(cell) ? cell : null,
                      dir: pick(s, SPEC_FIELD_ALIASES.DIR), role: pick(s, SPEC_FIELD_ALIASES.ROLE) };
        // 兼容 {"x":1,"y":0} 形式的相对格
        if (!out.cell && s && typeof s === "object" && Number.isInteger(s.x) && Number.isInteger(s.y))
            out.cell = [s.x, s.y];
        return out;
    });
}
/** 把 spec 的槽位列归一成可比较的签名，便于判断"同不同" */
function slotSignature(list) {
    return (list || []).map(s => `${Array.isArray(s.cell) ? s.cell.join(",") : "?"}:${s.dir ?? "?"}`).sort().join("|");
}
function structuredCloneSafe(o) {
    // 零依赖深拷贝：node 18+ 有全局 structuredClone，但为兼容旧 node 走 JSON 往返（本表全 JSON-safe）
    return JSON.parse(JSON.stringify(o));
}

/** 一次调用拿到"内嵌表 + 可选 spec 覆盖"的结果（P3/P4/P5 直接用它，别各自去读 JSON） */
let _resolved = null;
export function resolveTemplates({ useSpec = true, refresh = false } = {}) {
    if (_resolved && !refresh) return _resolved;
    if (!useSpec) { _resolved = { templates: ALL_TEMPLATES, diffs: [], gaps: [], recognized: false, source: null }; return _resolved; }
    _resolved = loadMachineSpec();
    return _resolved;
}

/** 交给 NOTES.md 的缺口清单（代码侧同步，文档不漂移） */
export function specGapReport() {
    const { gaps, diffs } = resolveTemplates();
    return [...gaps, ...diffs.map(d => `差异 ${d.op}.${d.field}: 内嵌 ${safe(d.embedded)} vs spec ${safe(d.spec)} → 保留 ${safe(d.kept)}（${d.why}）`)];
}

/** hub 的 16 个入口（世界坐标）。origin = hub 实体左上角格。
 *  与 exp-e2e.mjs:93-102 的 hubEntries() **同源**（上游 hub.js:73-91），但这里给的是
 *  "带子末格落在哪 + 该带子的流向"，P4/P5 直接可用。
 *  dir = 带子的流向（0=上 90=右 180=下 270=左）；belt 从 entry 沿 dir 的反方向外推。
 *  @param {[number,number]} origin @returns {Array<{cell:[number,number], face:string, dir:number, opp:string}>} */
export function hubEntriesWorld(origin) {
    const [hx, hy] = origin;
    const out = [];
    for (let i = 0; i < 4; i++) {
        out.push({ cell: [hx + i, hy - 1], face: "top", dir: 180, opp: OPP.top });      // 顶排口：带子向下喷进 (i,0)
        out.push({ cell: [hx + i, hy + 4], face: "bottom", dir: 0, opp: OPP.bottom });  // 底排口：带子向上喷进 (i,3)
        out.push({ cell: [hx - 1, hy + i], face: "left", dir: 90, opp: OPP.left });     // 左列口：带子向右喷进 (0,i)
        out.push({ cell: [hx + 4, hy + i], face: "right", dir: 270, opp: OPP.right });  // 右列口：带子向左喷进 (3,i)
    }
    return out;
}

/** 吞吐：一条链的瓶颈（V7 用；plan §1.5 V7 的 `stacker@0.25` 字符串形态） */
export function bottleneckOf(ops) {
    let slow = null;
    for (const op of ops) {
        const t = opByName(op);
        if (!slow || t.ratePerSec < slow.ratePerSec) slow = { op, ratePerSec: t.ratePerSec };
    }
    return slow ? `${slow.op}@${slow.ratePerSec}` : null;
}

/* ================================ 自测（node src/ai/op-templates.mjs --test） ================================
 * TODO(P1)：P1 的 errors.mjs/ContractViolation 落地后，这些断言可换成 assert*()；
 * 现在刻意**不 import types.mjs**（P1 仍在写），断言一律用普通对象比较，保持本包自包含。 */

function runTests() {
    let failed = 0;
    const eq = (label, got, want) => {
        const a = JSON.stringify(got), b = JSON.stringify(want);
        if (a === b) console.log("✓ " + label);
        else { failed++; console.log(`✗ ${label}\n    got  ${a}\n    want ${b}`); }
    };
    const ok = (label, cond, detail = "") => {
        if (cond) console.log("✓ " + label);
        else { failed++; console.log(`✗ ${label} ${detail}`); }
    };
    const throws = (label, fn, msgPart = "") => {
        try { fn(); failed++; console.log(`✗ ${label} —— 未抛错`); }
        catch (e) {
            if (msgPart && !String(e.message).includes(msgPart)) { failed++; console.log(`✗ ${label} —— 抛错但消息不含 "${msgPart}"：${e.message}`); }
            else console.log(`✓ ${label}（抛 ${e.name}${e.reason ? " / " + e.reason : ""}）`);
        }
    };

    /* ── 验收 1：15 条实机 code 逐条对拍（r=0, rv=0） ── */
    const livePath = path.join(HERE, "..", "..", "research", "ai-player", "facts", "building-codes-live.json");
    const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
    const seenCodes = new Set();
    for (const rec of live) {
        const got = codeFor(rec.building, rec.variant, 0, 0);
        eq(`实机 code ${rec.building}/${rec.variant} r=${rec.rotation} = ${rec.code}`, got, rec.code);
        seenCodes.add(rec.code);
    }
    eq("实机 code 去重后 15 条", [...seenCodes].sort((a, b) => a - b), [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    eq("trash code = 20", codeFor("trash", "default", 0, 0), 20);

    /* ── 硬断言 H1：belt code = 1+rv ── */
    eq("belt rv0 → code 1", codeFor("belt", "default", 0, 0), beltCode(0));
    eq("belt rv1 → code 2", codeFor("belt", "default", 90, 1), beltCode(1));
    eq("belt rv2 → code 3", codeFor("belt", "default", 270, 2), beltCode(2));
    eq("belt code 与 rot 无关", [0, 90, 180, 270].map(r => codeFor("belt", "default", r, 1)), [2, 2, 2, 2]);
    throws("belt rv=3 越界 → 抛错", () => codeFor("belt", "default", 0, 3), "rv ∈ {0,1,2}");

    /* ── 硬断言 H2：非 belt 只允许 rv=0 ── */
    for (const b of ["miner", "cutter", "rotater", "painter", "mixer", "stacker", "trash"]) {
        throws(`非 belt ${b} rv=1 → 结构化抛错`, () => codeFor(b, "default", 0, 1), "rv 必须为 0");
    }
    throws("未知建筑 → 抛错", () => codeFor("nonexistent_machine", "default", 0, 0), "已知 building|variant");
    // codeFor 是"世界的真值表"：存档里观测到的 code 也要能解（P7 读盘对拍需要），
    // 编译器是否**有权产出**它由 isV1Emittable 管（见下）。
    eq("balancer code=4（存档观测 475 台，可解码）", codeFor("balancer", "default", 0, 0), 4);
    eq("hub code=26（存档观测 1 台）", codeFor("hub", "default", 0, 0), 26);
    eq("balancer 虽可解码但 v1 不可 emit", [codeFor("balancer", "default", 0, 0) === 4, isV1Emittable("balancer")], [true, false]);
    eq("isV1Emittable 集合（quad 变体与范围外建筑 = false）",
        ["miner", "cutter", "stacker", "trash", "belt", "hub", "cutter|quad", "painter|quad", "balancer", "underground_belt", "wire"]
            .map(s => { const [b, v] = s.split("|"); return isV1Emittable(b, v || "default"); }),
        [true, true, true, true, true, true, false, false, false, false, false]);
    throws("非法 rotation → 抛错", () => codeFor("cutter", "default", 45, 0), "0|90|180|270");

    /* ── 验收 2：槽位数 == GEOMETRY 表1 + 关键语义 ── */
    const slotCounts = { mine: [0, 1], cut: [1, 2], cutQuad: [1, 4], rotate: [1, 1], rotateCCW: [1, 1],
                         rotate180: [1, 1], paint: [2, 1], paintMirrored: [2, 1], mix: [2, 1], stack: [2, 1] };
    for (const [op, [ni, no]] of Object.entries(slotCounts)) {
        const t = OP_TEMPLATES[op];
        ok(`${op} 存在`, !!t);
        eq(`${op} 槽位数 in/out`, [t.inputs.length, t.outputs.length], [ni, no]);
    }
    eq("OP_TEMPLATES 覆盖 plan §2.2 的 op 枚举", Object.keys(OP_TEMPLATES),
        ["mine", "cut", "cutQuad", "rotate", "rotateCCW", "rotate180", "paint", "paintMirrored", "mix", "stack"]);
    eq("trash 四边全收", opByName("trash").inputs.map(s => s.dir), ["top", "right", "bottom", "left"]);
    // stacker：左格=下层、右格=上层（M3 实机）
    eq("stacker 左格=lower / 右格=upper",
        OP_TEMPLATES.stack.inputs.map(s => [s.cell, s.dir, s.role]),
        [[[0, 0], "bottom", "lower"], [[1, 0], "bottom", "upper"]]);
    // painter：shape←left / color←top / 出→right（M2a 实机）
    eq("painter shape←left(0,0) color←top(1,0) 出→right(1,0)",
        OP_TEMPLATES.paint.inputs.map(s => [s.cell, s.dir, s.role]).concat(OP_TEMPLATES.paint.outputs.map(s => [s.cell, s.dir, s.role])),
        [[[0, 0], "left", "shape"], [[1, 0], "top", "color"], [[1, 0], "right", "out"]]);
    // mirrored 与 default 只差 color 方位
    eq("paintMirrored color←bottom", OP_TEMPLATES.paintMirrored.inputs[1].dir, "bottom");
    // cutter：左列/右列
    eq("cutter 输出 (0,0)top=left / (1,0)top=right",
        OP_TEMPLATES.cut.outputs.map(s => [s.cell, s.dir, s.role]),
        [[[0, 0], "top", "left"], [[1, 0], "top", "right"]]);
    // mixer 双 bottom 进、top 出
    eq("mixer 双 color←bottom、出→top",
        OP_TEMPLATES.mix.inputs.map(s => [s.cell, s.dir, s.role]).concat(OP_TEMPLATES.mix.outputs.map(s => [s.cell, s.dir, s.role])),
        [[[0, 0], "bottom", "color"], [[1, 0], "bottom", "color"], [[0, 0], "top", "out"]]);
    // 矿机输出恒 top
    eq("miner 输出恒 top 且无输入槽", [OP_TEMPLATES.mine.inputs.length, OP_TEMPLATES.mine.outputs[0].dir], [0, "top"]);
    // footprint
    eq("footprint 表", Object.fromEntries(Object.entries(OP_TEMPLATES).map(([k, v]) => [k, v.footprint])),
        { mine: [1, 1], cut: [2, 1], cutQuad: [4, 1], rotate: [1, 1], rotateCCW: [1, 1], rotate180: [1, 1],
          paint: [2, 1], paintMirrored: [2, 1], mix: [2, 1], stack: [2, 1] });

    /* ── 验收 3：速率表（V7 要用 stacker:0.25） ── */
    eq("RATES 表", { ...RATES }, { belt: 2.0, miner: 0.4, rotater: 2.0, cutter: 0.5, stacker: 0.25, painter: 0.33, mixer: 0.4, trash: 0, hub: 0 });
    eq("模板 ratePerSec 与 RATES 一致", Object.values(OP_TEMPLATES).map(t => t.ratePerSec),
        [0.4, 0.5, 0.5, 2.0, 2.0, 2.0, 0.33, 0.33, 0.4, 0.25]);
    eq("bottleneckOf 取最慢（stacker）", bottleneckOf(["mine", "cut", "stack"]), "stack@0.25");
    eq("bottleneckOf 无 stacker 时取 cutter", bottleneckOf(["mine", "cut"]), "mine@0.4");

    /* ── 验收 2b：旋转律 —— 世界槽位 = rotateLocal(局部, rot)，复用 belt-rules ── */
    eq("rotateSlot 与 rotateLocal 同函数", ORDER.map(d => rotateSlot(d, 90)), ORDER.map(d => rotateLocal(d, 90)));
    eq("rotateSlot 四方位转 90", ORDER.map(d => rotateSlot(d, 90)), ["right", "bottom", "left", "top"]);
    eq("rotateSlot 转 360 = 恒等", ORDER.map(d => rotateSlot(d, 360)), ORDER);
    throws("rotateSlot 非法方位抛错", () => rotateSlot("up", 0), "top|right|bottom|left");
    // 未来 rot≠0 的方形机器：stacker 2×1 非方形 → 必须被拦住（不假装会旋转）
    throws("非方形占地 rotation=90 → 拦住（D1）", () => worldSlots(OP_TEMPLATES.stack, 90), "只允许 rotation=0");
    // 方形机器 rot=90：miner 出口局部 top → 世界 right
    eq("方形 rotate 机器 rot=90：出口 top→right", worldSlots(OP_TEMPLATES.rotate, 90).outputs[0].dir, "right");
    eq("方形 rotate 机器 rot=90：入口 bottom→left", worldSlots(OP_TEMPLATES.rotate, 90).inputs[0].dir, "left");
    eq("方形 rotate 机器 rot=270：入口 bottom→right", worldSlots(OP_TEMPLATES.rotate, 270).inputs[0].dir, "right");
    // trash 四边全收：旋转不改变集合（用排序数组比较，Set 走 JSON.stringify 会恒等）
    const sortU = arr => [...new Set(arr)].sort();
    eq("trash 世界槽位集合不随 rot 变",
        [0, 90, 180, 270].map(r => sortU(worldSlots(opByName("trash"), r).inputs.map(s => s.dir))),
        [[...sortU(ORDER)], [...sortU(ORDER)], [...sortU(ORDER)], [...sortU(ORDER)]]);
    eq("trash 旋转后仍占同格 (0,0)", sortU(worldSlots(opByName("trash"), 270).inputs.map(s => s.cell.join(","))), ["0,0"]);
    // v1 出口必须恒 r=0
    throws("v1 加工机器 rot=90 → assertV1Rotation 抛错", () => assertV1Rotation("cutter", 90), "rotation 必须为 0");
    ok("v1 belt rot=90 放行（带子本来的方向语义）", assertV1Rotation("belt", 90) === 90);
    throws("v1 trash rot=180 → 抛（上游 getIsRotateable()=false ⇒ 恒 r=0）", () => assertV1Rotation("trash", 180), "getIsRotateable");
    throws("v1 hub rot=90 → 抛（同上）", () => assertV1Rotation("hub", 90), "getIsRotateable");
    ok("v1 trash rot=0 放行", assertV1Rotation("trash", 0) === 0);
    eq("isRotatable 承上游：trash/hub=false、加工机=true、未知=null",
        [isRotatable("trash"), isRotatable("hub"), isRotatable("cutter"), isRotatable("belt"), isRotatable("balancer")],
        [false, false, true, true, null]);
    eq("两份实机凭据交叉校验：零冲突", crossCheckCodes().conflicts, []);
    eq("存档观测 code 全部能在提取表或 hub 里对上",
        crossCheckCodes().conflicts.length === 0 && SAVE_CODES["hub|default"] === 26, true);
    eq("v1 bounds cutter @ (10,20)", machineWorldBounds(OP_TEMPLATES.cut, [10, 20], 0),
        { x0: 10, y0: 20, x1: 11, y1: 20, w: 2, h: 1 });
    throws("v1 bounds 旋转机器 → 抛错", () => machineWorldBounds(OP_TEMPLATES.cut, [10, 20], 90), "rotation 必须为 0");

    /* ── mustDiscardUnused / verifiedOnLive / unlockLevel 兜底 ── */
    eq("全部模板 mustDiscardUnused=true（除 trash/belt）",
        Object.values(OP_TEMPLATES).every(t => t.mustDiscardUnused === true), true);
    eq("verifiedOnLive 承 GEOMETRY ✅",
        Object.fromEntries(Object.entries(OP_TEMPLATES).map(([k, v]) => [k, v.verifiedOnLive])),
        { mine: true, cut: true, cutQuad: false, rotate: false, rotateCCW: false, rotate180: false,
          paint: true, paintMirrored: false, mix: false, stack: true });
    /* ── hub：16 入口（GEOMETRY 表1 :23 + 表3-8；上游 hub.js:73-91）＋ code=26 实机凭据 ── */
    const hub = opByName("hub");
    eq("hub 16 个输入槽", hub.inputs.length, 16);
    eq("hub footprint 4×4", hub.footprint, [4, 4]);
    eq("hub code=26（level-11 存档实机直读）", codeFor("hub", "default", 0, 0), 26);
    eq("hub 槽位方位分布（顶排 top / 底排 bottom / 左列 left / 右列 right 各 4）",
        hub.inputs.reduce((a, s) => ((a[s.dir] = (a[s.dir] || 0) + 1), a), {}),
        { top: 4, bottom: 4, left: 4, right: 4 });
    eq("hub 顶排 = (i,0)、底排 = (i,3)、左列 = (0,i)、右列 = (3,i)",
        hub.inputs.filter(s => s.dir === "top").map(s => s.cell.join(",")).sort(), ["0,0", "1,0", "2,0", "3,0"]);
    eq("hub 不可旋转（上游 getIsRotateable=false + 存档 r=0）", [isRotatable("hub"), hub.verifiedOnLive, hub.codeVerifiedOnLive], [false, false, true]);
    eq("hub 不在 v1 op 枚举里但允许 emit（它是终点）", [OP_TEMPLATES.hub === undefined, isV1Emittable("hub")], [true, true]);

    /* ── hubEntriesWorld：与 exp-e2e.mjs:93-102 的 hubEntries() 同源核对 ── */
    const he = hubEntriesWorld([100, 200]);
    eq("hub 16 个世界入口", he.length, 16);
    // 顺序与 exp-e2e.mjs:95-100 一致：每个 i 依次 push 顶/底/左/右（交错），故按 face 分组比较
    const byFace = f => he.filter(e => e.face === f).map(e => `${e.cell.join(",")}:${e.dir}`);
    eq("顶排入口 = (hx+i, hy-1) dir=180", byFace("top"), ["100,199:180", "101,199:180", "102,199:180", "103,199:180"]);
    eq("底排入口 = (hx+i, hy+4) dir=0", byFace("bottom"), ["100,204:0", "101,204:0", "102,204:0", "103,204:0"]);
    eq("左列入口 = (hx-1, hy+i) dir=90", byFace("left"), ["99,200:90", "99,201:90", "99,202:90", "99,203:90"]);
    eq("右列入口 = (hx+4, hy+i) dir=270", byFace("right"), ["104,200:270", "104,201:270", "104,202:270", "104,203:270"]);
    eq("每个入口的 outDir 名与 dir 角度自洽（angleToDir 同一张表）",
        he.every(e => angleToDir(e.dir) === e.opp), true);
    eq("入口格全部紧邻 hub 4×4 包围盒外一格", he.every(e => {
        const [x, y] = e.cell;
        const onRing = (y === 199 || y === 204 || x === 99 || x === 104);
        const inside = x >= 100 && x <= 103 && y >= 200 && y <= 203;
        return onRing && !inside;
    }), true);

    /* ── 两份实机凭据交叉校验 ── */
    const cc = crossCheckCodes();
    eq("MACHINE_CODES(15 提取) 与 SAVE_CODES(存档) 零冲突", cc.conflicts, []);
    ok(`共有键 ${cc.overlap.length} 个、存档独有 ${cc.onlyInSave.length} 个、提取表独有 ${cc.onlyInExtraction.length} 个`,
        cc.overlap.length === 7 && cc.onlyInSave.length === 3 && cc.onlyInExtraction.length === 7);
    eq("stacker 只有提取表一份凭据（level-11 存档里没有 stacker）", cc.onlyInExtraction.includes("stacker|default"), true);

    /* ── 兜底常量（C7） ── */
    eq("§2.2 兜底常量", Object.fromEntries(["mine", "cut", "rotate", "paint", "mix", "stack"].map(o => [o, OP_TEMPLATES[o].unlockLevel])),
        { mine: 1, cut: 1, rotate: 4, paint: 6, mix: 8, stack: 10 });
    eq("cutQuad 补值 16", OP_TEMPLATES.cutQuad.unlockLevel, 16);

    /* ── code → 模板反查（P6 自检用：summarizeBlueprint 不解 code→名字） ── */
    eq("反查 code 9 = cut", templateForBuildingCode(9).op, "cut");
    eq("反查 code 20 = trash", templateForBuildingCode(20).op, "trash");
    eq("反查 code 15 = mix", templateForBuildingCode(15).op, "mix");
    eq("反查 code 13 = rotate180", templateForBuildingCode(13).op, "rotate180");
    eq("反查未知 code → null", templateForBuildingCode(999), null);
    eq("反查 building|variant", templateByBuildingVariant("painter", "quad").op, "paintQuad");
    throws("opByName 非法名抛错", () => opByName("nope"), "已知 op 名");

    /* ── loadMachineSpec：文件不存在 → 保内嵌 + 记 gap（当前 P0-spec 未落地，这条必过） ── */
    const spec = loadMachineSpec(path.join(HERE, "machine-spec.json"));
    ok(`machine-spec.json 存在与否都不崩（recognized=${spec.recognized}）`, !!spec.templates && Array.isArray(spec.gaps));
    eq("内嵌表在无 spec 时原样保留", spec.templates.stack.inputs.map(s => s.role), ["lower", "upper"]);
    ok("缺口清单非空（至少登记了 belt 之外 rv 无证据 / spec 缺失或差异）", specGapReport().length > 0, JSON.stringify(specGapReport()));

    /* ── 用合成 spec 走一遍覆盖逻辑（本包私有 fixture，与 research/ai-plan/data/op-templates.test.mjs
          写的是同一份、内容必须一致） ── */
    const tmp = path.join(HERE, "..", "..", "research", "ai-plan", "data", "fixtures", "spec-sample.json");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([
        { id: "cutter|default", building: "cutter", variant: "default", code: 999, unlockLevel: 1, ratePerSec: 0.5,
          inputs: [{ cell: [0, 0], dir: "bottom" }],
          outputs: [{ cell: [0, 0], dir: "top" }, { cell: [1, 0], dir: "top" }, { cell: [2, 0], dir: "top" }] },
        { id: "belt|default", building: "belt", variant: "default", code: 777 },
        // stacker 是表2 覆盖的 op → ratePerSec 用 GEOMETRY 表2 权威，spec 的 0.5 只登记不覆盖
        { id: "stacker|default", building: "stacker", variant: "default", code: 14, unlockLevel: 12, footprint: [2, 1], ratePerSec: 0.5 },
        // painterDouble 表2 没给 → 允许 spec 补值（0.25）
        { id: "painter|double", building: "painter", variant: "double", code: 18, ratePerSec: 0.25 },
        { id: "weird|default", building: "weird", code: 42 },
    ], null, 1) + "\n");
    {
        const s2 = loadMachineSpec(tmp);
        ok("合成 spec 被识别", s2.recognized === true);
        eq("belt code 冲突以 belt-rules 为准", codeFor("belt", "default", 0, 0), 1);
        ok("belt 冲突已登记", s2.diffs.some(d => d.op === "belt" && d.field === "code" && d.kept === 1));
        ok("非 belt code 分歧保留实机值 9", s2.diffs.some(d => d.op === "cut" && d.field === "code" && d.kept === 9 && d.spec === 999));
        eq("unlockLevel 被 spec 覆盖（表2 不管这个字段）", s2.templates.stack.unlockLevel, 12);
        eq("表2 覆盖的 op → ratePerSec 保留表2（spec 0.5 只登记不覆盖）", s2.templates.stack.ratePerSec, 0.25);
        ok("但差异仍登记在案", s2.diffs.some(d => d.op === "stack" && d.field === "ratePerSec" && d.kept === 0.25 && d.spec === 0.5));
        eq("表2 未覆盖的变体 → spec 补值", s2.templates.paintDouble.ratePerSec, 0.25);
        ok("未知组合登记为 gap", s2.gaps.some(g => g.includes("weird|default")));
        // 覆盖后仍不许 rv≠0
        throws("spec 覆盖不影响 H2（stacker rv=1 仍抛）", () => codeFor("stacker", "default", 0, 1), "rv 必须为 0");
    }

    console.log(failed ? `\n✗ op-templates 自测：${failed} 条失败` : "\n✓ op-templates 自测全部通过");
    process.exitCode = failed ? 1 : 0;
}

// 直接运行才跑自测：被别的包 import 时（哪怕对方 argv 带 --test）绝不运行、绝不写 process.exitCode。
// 否则 runTests() 末尾的 process.exitCode=failed?1:0 会把调用方的红灯洗成绿灯（P6 探针实测 red→green）。
// 判据同 research/ai-plan/contract/lint-imports.mjs:98。
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly && process.argv.slice(2).includes("--test")) runTests();
if (invokedDirectly && process.argv.slice(2).includes("--gaps")) console.log(specGapReport().join("\n"));
