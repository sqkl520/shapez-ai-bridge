/**
 * types.mjs — 布局编译器接口契约（P1 contract 独占）。
 *
 * 唯一真源：research/ai-player/plan-compiler.md
 *   §2.1 CompiledPlan ｜ §2.3 LayoutReport（含决策 D1）｜ §2.4 ValidatorReport
 *   §2.5 失败枚举（在 errors.mjs）｜ §2.6 WorldState
 * 其余 7 个包 import 本文件；类型改动只能走 P1（plan §3 冲突仲裁）。
 *
 * 形态：JSDoc @typedef（给读者与 IDE）+ **纯函数运行时校验器**（给 L0 与 P8 分诊）。
 *   缺字段 / 枚举外值 / 违反 §2.1 硬规定 → 抛带**字段路径**的 ContractViolation，绝不静默。
 *
 * 零依赖：ESM + node: 内置 + src/ai/belt-rules.mjs（只读常量）+ ./errors.mjs。
 *   不 import src/shared/blueprint.mjs（容器层归 P6，本文件只做字符串前缀检查）；
 *   不 import proto/belt-rules.mjs（已知错误副本，plan §1.1 lint / §3 陷阱）。
 */

import { rotateLocal, beltCode, DIRV, ORDER, OPP } from "../belt-rules.mjs";
import {
    ContractViolation, assertInt, assertCell, assertWH, requireKeys, req, oneOf,
    DIR_NAMES, isAngle, FAILURE_REASONS, CHECK_IDS, isFailureReason,
} from "./errors.mjs";

/* ════════════════════════════ §2 类型定义（人读真值） ════════════════════════════ */

/**
 * 方向名：字符串，y 向下（src/ai/belt-rules.mjs:16-18）。
 * @typedef {"top"|"right"|"bottom"|"left"} DirName
 * 角度一律 0/90/180/270（= ORDER 索引 × 90）。
 * @typedef {0|90|180|270} Angle
 * 世界坐标 / 尺寸二元整数对。
 * @typedef {[number, number]} Cell2
 */

/**
 * §2.1 编译器总产物（P6 发射、P5 校验、P7 落地）。
 * @typedef {{
 *   ok: boolean,
 *   goal: string,
 *   reason: string|null,
 *   failingNode: {nodeId:string, cell:Cell2|null, check:string}|null,
 *   hint: string|null,
 *   site: {anchor: Cell2, hub: Cell2|null},
 *   blueprint: string|null,
 *   entities: Array<CompiledEntity>,
 *   layout: LayoutReport,
 *   validation: ValidatorReport,
 *   stats: PlanStats,
 *   scope: Scope,
 * }} CompiledPlan */

/**
 * entities 单元 = 蓝图实体 + beltIntent（P7 逐格对拍的凭据，plan §1.6）。
 * instanceIdx：§7.1.2 的缓解措施（一个 nodeId 可对应多实例，v1 恒 0）。
 * @typedef {{
 *   code:number, dx:number, dy:number, rot:number,
 *   nodeId:string, instanceIdx:number,
 *   kind:EntityKind, rotationVariant:number,
 *   inDir:DirName|null, outDir:DirName|null,
 * }} CompiledEntity */

/** @typedef {"miner"|"belt"|"cutter"|"rotater"|"painter"|"stacker"|"mixer"|"trash"|"hub"} EntityKind */

/** @typedef {{machines:Record<string,number>, beltTiles:number, trash:number, bbox:[number,number],
 *   corners:number, estThroughputPerSec:number, bottleneck:string|null,
 *   blueprintCost:number, chargeMode:"false"|"auto"}} PlanStats */

/** v1 范围（§0 范围裁决 / §2.1「scope 是契约的一部分」）：超出者一律 ok:false。
 * @typedef {{layers:1, wires:false, tunnels:false, rotatedMachines:false, maxFanIn:2}} Scope */

/**
 * §2.3 P3 产出、P4 消费、P5 复核。
 * @typedef {{
 *   grid: string,
 *   rows: Array<{level:number, y:number, nodeIds:string[]}>,
 *   placements: Array<{nodeId:string, op:string, kind:string, cell:Cell2, rot:number, footprint:[number,number]}>,
 *   channels: Array<LayoutChannel>,
 *   lanes: Array<LayoutLane>,
 *   hubConnection: {entry:Cell2, side:DirName, dir:number}|null,
 *   bbox: [number,number],
 *   occupancy: Array<{cell:Cell2, state:"solid"|"replaceable", who?:string, kind?:string}>,
 *   conflicts: Array<LayoutConflict>,
 *   cornerCount: number,
 * }} LayoutReport */

/**
 * 车道台账条目（§2.3 lanes[]）。**轴 + 下标**二元组是唯一身份：
 *   - 水平车道（hlane，竖直出/竖直进）→ 记 `{row: r, channelIds}`
 *   - 竖直车道（vlane，水平出/水平进）→ 记 `{column: c, channelIds}`
 * **恰好一个** of row/column 是非 null（规则由 assertLayoutReport 强制；两个都给或都不给 = 契约错）。
 * 为什么不是「一个 lane 字段 + 一个 axis 字段」：row=3 与 column=3 是**两条不同的车道**，
 *   用同一字段装会让「同一行只能属于一条车道」的判重把跨轴的同号车道误判成冲突
 *   （P5 的 V6 与 types 自己的判重都要按 (轴, 下标) 比较）。
 * @typedef {{row:number|null, column:number|null, channelIds:string[]}} LayoutLane
 */

/**
 * 通道 = 端点对（plan §7.3 自我批判：多对多关系可能要加 slotRole/ordinal，P1 预留可空字段）。
 * `lane` 的**口径（LANE_SCHEMA_VERSION = 2）**：车道轨道的**下标**（行号或列号），无轴信息；
 *   轴由 `laneAxis` 给出（"row" = 水平车道行，留空或 "row" 时 `lane` 直接与 `lanes[].row` 对拍；
 *   "col" = 竖直车道列，与 `lanes[].column` 对拍）。
 *   两者都为空 ⇔ 该通道**没有占用车道**（direct/single/straight/elbow/search）。单看 `lane`
 *   无法区分 row=3 与 column=3，所以轴必须随行 —— 这正是 scheme v1 装不下 vlane 的原因。
 * @typedef {{
 *   from:{nodeId:string, cell:Cell2, slot:DirName, outDir:DirName},
 *   to:{nodeId:string, cell:Cell2, slot:DirName, inDir:DirName},
 *   lane:number|null, payload:string,
 *   laneAxis?:("row"|"col"|null),
 *   slotRole?:("primary"|"secondary"|"shape"|"color"|"lower"|"upper"|"out"|string|null),
 *   ordinal?:number|null,
 * }} LayoutChannel */

/** @typedef {{kind:"cell-occupied"|"lane-column"|"crossing"|"no-turn"|"hub-contention",
 *   cells:Cell2[], nodeIds:string[], resolvedBy:string|null}} LayoutConflict */

/**
 * §2.4 P5 产出；ok:false 时 CompiledPlan.reason 取自 §2.5 的 validate:<Vn>。
 * @typedef {{
 *   pass: boolean,
 *   checks: Array<{id:string, status:"pass"|"fail"|"not-applicable", evidence:CheckEvidence}>,
 *   errors: Array<{check:string, severity:"fatal"|"warn", nodeId:string, cell:Cell2|null, message:string}>,
 *   beltSim: {tilesChecked:number, fixedPoints:number, drift:Array<{cell:Cell2, wantRv:number, gotRv:number}>, includesMachineNeighbors:true},
 *   shapeReplay: Array<{nodeId:string, expectedHash:string, actualHash:string, equal:boolean}>,
 *   throughput: {demandPerSec:number, bottleneck:{nodeId:string, ratePerSec:number}, rowsRequired:number, rowsPlanned:number},
 * }} ValidatorReport */

/** @typedef {{cell:Cell2|null, nodeId:string|null, expected:string|null, actual:string|null, note:string}} CheckEvidence */

/**
 * §2.6 既有世界输入（obs 归一化；P1 定义、P8 采集、P3/P5 消费）。
 * 注意：Set 无法进 JSON —— 落盘用数组，读回走 normalizeWorldState()。
 * @typedef {{
 *   tick:number, seed:number|null, hub:{x:number,y:number}|null,
 *   goal:{level:number, shape:string, required:number, delivered:number},
 *   upgradeLevels:Record<"belt"|"miner"|"processors"|"painting", number>,
 *   entities: Array<{uid:number, type:string, x:number, y:number, r:number,
 *                    variant:string, rotationVariant:number, code:number, layer:string}>,
 *   resources: Array<[number,number,string]>,
 *   replaceableBeltCells: Set<string>,
 * }} WorldState */

/* ════════════════════════════ 常量（P1 独占，见 plan §3 冲突仲裁） ════════════════════════════ */

/** §2.1 kind 枚举（逐字） */
/* 实体 kind 枚举。`underground_belt` 是 scope.tunnels=true 时才出现的合法 kind
   （code 22=sender / 23=receiver）。它不在 V1_KINDS 里 —— 那是 P5 用来判"越界"的另一份表，
   两份表的差异正是"契约允许表达" vs "v1 默认允许使用"。 */
export const ENTITY_KINDS = Object.freeze(["miner", "belt", "cutter", "rotater", "painter", "stacker", "mixer", "trash", "hub", "underground_belt"]);
/** 非带子的实体（= 三态里的 solid） */
export const SOLID_KINDS = Object.freeze(ENTITY_KINDS.filter(k => k !== "belt"));

/** §2.2 OpTemplate.op 枚举 */
export const OP_NAMES = Object.freeze(["mine", "cut", "cutQuad", "rotate", "rotateCCW", "rotate180", "paint", "paintMirrored", "mix", "stack"]);
/** §2.2 inputs[].role 枚举 */
export const SLOT_IN_ROLES = Object.freeze(["primary", "secondary", "shape", "color", "lower", "upper"]);
/** §2.2 outputs[].role 枚举 */
export const SLOT_OUT_ROLES = Object.freeze(["left", "right", "quad0", "quad1", "quad2", "quad3", "out", "discard"]);

/** §2.3 conflicts[].kind 枚举 */
export const CONFLICT_KINDS = Object.freeze(["cell-occupied", "lane-column", "crossing", "no-turn", "hub-contention"]);
/** §2.3 lanes[] / channels[].lane 的**轴**枚举（LANE_SCHEMA_VERSION = 2 新增）。
 *  "row" = 水平车道（固定 y 的整行），"col" = 竖直车道（固定 x 的整列）。
 *  唯一身份 = (轴, 下标)：`{row:3}` 与 `{column:3}` 是**两条不同**的车道（不得互相判重）。 */
export const LANE_AXES = Object.freeze(["row", "col"]);
/** §2.3 lanes[] 的契约版本。v1 = 只有 `row` 的条目（vlane 无法表达 → 被 P4 拒绝）；
 *  v2 = `{row|null, column|null}` 恰一个非空 + `channels[].laneAxis`（vlane 可表达）。
 *  版本号的意义：读旧报告（v1 形态）永远合法（`row` 在场、`column` 缺省 null），
 *  所以 bump 不破坏 fixture；bump 只标记「新写法开始产出 v1 装不下的信息」。 */
export const LANE_SCHEMA_VERSION = 2;
/** §2.3 occupancy[].state 用词（注意：与 grid.mjs 的 CELL_STATES 不同名，这里刻意照 plan 原文） */
export const OCCUPANCY_STATES = Object.freeze(["solid", "replaceable"]);
/** §2.4 checks[].status 枚举 */
export const CHECK_STATUSES = Object.freeze(["pass", "fail", "not-applicable"]);
/** §2.4 errors[].severity 枚举 */
export const SEVERITIES = Object.freeze(["fatal", "warn"]);
/** §2.1 stats.chargeMode 枚举（字符串！"false" 表示 charge:false 的 god-mode 口径） */
export const CHARGE_MODES = Object.freeze(["false", "auto"]);
/** §2.6 upgradeLevels 键 */
export const UPGRADE_KEYS = Object.freeze(["belt", "miner", "processors", "painting"]);

/** v1 范围常量（plan §0 / §2.1）—— 编译器不许静默近似，超出即 ok:false */
export const SCOPE_V1 = Object.freeze({ layers: 1, wires: false, tunnels: false, rotatedMachines: false, maxFanIn: 2 });

/** 蓝图容器前缀（src/shared/blueprint.mjs:20 同值；P1 只做前缀检查，不 import 容器层） */
export const BLUEPRINT_PREFIX = "SZBP1.";
/** 本仓库开发基线的游戏版本（compat.json / docs/PROTOCOL.md:162 gv 字段；P6 写入） */
export const GAME_VERSION = "1.5.6";
/** 蓝图实体 stride（src/shared/blueprint.mjs:44-53；stride=5 是交主 Agent 的缺口，见 plan §1.6 D2） */
export const BLUEPRINT_STRIDE = 4;

/** §2.5 枚举 + §2.4 check id 从 errors.mjs 转出，调用方只 import types 也够用 */
export { FAILURE_REASONS, CHECK_IDS, isFailureReason, DIR_NAMES, ORDER, OPP, DIRV };
export { ContractViolation } from "./errors.mjs";

/* ════════════════════════════ 内部小工具 ════════════════════════════ */

const isPosInt = n => Number.isInteger(n) && n >= 0;

/** 必需数组字段 @returns {Array} */
function arr(obj, key, path) {
    const v = req(obj, key, path);
    if (!Array.isArray(v)) throw new ContractViolation(`${path}.${key}`, "数组", v);
    return v;
}

/** 可选数组字段（缺失/ null → []）@returns {Array} */
function optArr(obj, key, path) {
    const v = obj[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new ContractViolation(`${path}.${key}`, "数组|null", v);
    return v;
}

/** 数字（非整数也可，用于速率/坐标之外的量） */
function num(obj, key, path, { min, int = false, nullable = false } = {}) {
    const v = obj[key];
    if (nullable && (v === null || v === undefined)) return v;
    if (typeof v !== "number" || Number.isNaN(v)) throw new ContractViolation(`${path}.${key}`, "数字", v);
    if (int && !Number.isInteger(v)) throw new ContractViolation(`${path}.${key}`, "整数", v);
    if (min !== undefined && v < min) throw new ContractViolation(`${path}.${key}`, `>= ${min}`, v);
    return v;
}

/**
 * 包围盒断言：正整数 [w,h]，但允许 [0,0] 表示「空」（早退失败的 plan 没有实体表；
 * Grid.bbox() 对空网格也返回 [0,0]）。opts.allowEmpty=false 时 [0,0] 也算违规。
 * @param {unknown} v @param {string} path @param {{allowEmpty?:boolean}} [opts]
 * @returns {[number,number]}
 */
export function assertBBox(v, path, opts = {}) {
    if (!Array.isArray(v) || v.length !== 2) throw new ContractViolation(path, "[w,h] 二元数组", v);
    const w = assertInt(v[0], `${path}[0]`), h = assertInt(v[1], `${path}[1]`);
    if (w === 0 && h === 0) {
        if (opts.allowEmpty === false) throw new ContractViolation(path, "w>=1 且 h>=1（非空计划）", v);
        return [0, 0];
    }
    if (w < 1 || h < 1) throw new ContractViolation(path, "w>=1 且 h>=1（或 [0,0] 表示空）", v);
    return [w, h];
}

/** 字符串字段 */
function str(obj, key, path, { nullable = false, allowEmpty = false } = {}) {
    const v = obj[key];
    if (nullable && (v === null || v === undefined)) return v;
    if (typeof v !== "string") throw new ContractViolation(`${path}.${key}`, "string", v);
    if (!allowEmpty && v === "") throw new ContractViolation(`${path}.${key}`, "非空字符串", v);
    return v;
}

/**
 * shapez shortKey 语法自检（每层 8 字符：4 象限 × [sub][color]，sub ∈ RCSW|-，层间 ":" 分隔）。
 * 判据抄自 research/ai-player/proto/shape-ops.mjs:26-45 parse（**只读参考，不 import**）。
 * ⚠️ 权威解析仍是 shape-ops.parse（P5 的 S1、P8 的分诊用它们）；本函数只在 L0 挡住"goal 写成垃圾串"。
 * @param {string} shortKey @param {string} path
 */
function checkShortKeyGrammar(shortKey, path) {
    const SUBS = "RCSW";
    const COLORS = "rgbypcuw";
    const layers = String(shortKey).split(":");
    layers.forEach((text, li) => {
        if (text.length !== 8) {
            throw new ContractViolation(`${path}（层 ${li}）`, "shortKey 每层恰 8 字符（4 象限 × [sub][color]）", text);
        }
        for (let q = 0; q < 4; q++) {
            const sub = text[q * 2], cc = text[q * 2 + 1];
            if (sub === "-") continue;
            if (!SUBS.includes(sub)) throw new ContractViolation(`${path}（层 ${li} 象限 ${q}）`, "sub ∈ R|C|S|W|-", sub);
            if (!COLORS.includes(cc)) throw new ContractViolation(`${path}（层 ${li} 象限 ${q}）`, "color ∈ r|g|b|y|p|c|u|w", cc);
        }
    });
    return layers.length;
}

/* ════════════════════════════ §2.1 CompiledPlan ════════════════════════════ */

/**
 * 校验单个 entity。rot/inDir/outDir/code 交叉约束：
 *   - kind==="belt" → code 必须 === beltCode(rotationVariant)（plan §2.2 迁移路径 3：belt 族 code 唯一权威）
 *   - 非 belt → rotationVariant 必须 0（plan §2.2 迁移路径 4：v1 绝不产出 rv≠0 的非 belt 机器）
 *   - 加工机器（非 belt/miner）rot 必须 0（决策 D1）；rot ∈ {0,90,180,270}
 * @param {unknown} e @param {string} path
 * @param {{allowRotatedMachine?:boolean}} [opts]
 * @returns {CompiledEntity}
 */
export function assertCompiledEntity(e, path = "entities[0]", opts = {}) {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new ContractViolation(path, "object", e);
    requireKeys(e, ["code", "dx", "dy", "rot", "nodeId", "kind", "rotationVariant", "inDir", "outDir"], path);
    const out = {
        code: assertInt(e.code, `${path}.code`),
        dx: assertInt(e.dx, `${path}.dx`),
        dy: assertInt(e.dy, `${path}.dy`),
        rot: e.rot,
        nodeId: str(e, "nodeId", path),
        instanceIdx: e.instanceIdx === undefined ? 0 : assertInt(e.instanceIdx, `${path}.instanceIdx`),
        kind: oneOf(e.kind, ENTITY_KINDS, `${path}.kind`),
        rotationVariant: assertInt(e.rotationVariant, `${path}.rotationVariant`),
        inDir: e.inDir === null ? null : oneOf(e.inDir, DIR_NAMES, `${path}.inDir`),
        outDir: e.outDir === null ? null : oneOf(e.outDir, DIR_NAMES, `${path}.outDir`),
    };
    if (!isAngle(out.rot)) throw new ContractViolation(`${path}.rot`, "0|90|180|270", out.rot);
    if (!isPosInt(out.instanceIdx)) throw new ContractViolation(`${path}.instanceIdx`, ">=0 整数", out.instanceIdx);
    for (const k of ["dx", "dy"]) if (Math.abs(out[k]) > 1e7) throw new ContractViolation(`${path}.${k}`, "蓝图内相对坐标（|v|<=1e7）", out[k]);

    /* 隧道（underground_belt）：sender/receiver 的朝向与身份都由 rot/rv 表达，
       下面两处"机器不许转、非 belt 不许带 rv"的规则要给它开例外 ——
       它本来就是有向的 1×1 建筑，不是"被旋转的机器"。 */
    const isTunnel = out.kind === "underground_belt";

    if (out.kind === "belt") {
        if (out.rotationVariant < 0 || out.rotationVariant > 2) {
            throw new ContractViolation(`${path}.rotationVariant`, "belt 的 rv ∈ 0|1|2（1=直 2=左弯 3=右弯）", out.rotationVariant);
        }
        const want = beltCode(out.rotationVariant);
        if (out.code !== want) throw new ContractViolation(`${path}.code`, `belt 的 code === beltCode(rv) = 1+rv = ${want}（belt-rules.mjs:55-56，唯一权威）`, out.code);
        if (out.inDir === null || out.outDir === null) {
            throw new ContractViolation(`${path}`, "belt 必须同时带 inDir 与 outDir（beltIntent 是 P7 对拍凭据）", { inDir: out.inDir, outDir: out.outDir });
        }
        if (out.inDir === out.outDir) throw new ContractViolation(`${path}`, "belt 的 inDir !== outDir（同向穿过的不是带子该有的形态，belt-rules.mjs:43）", out.inDir);
        // 带子的 (r,rv) 必须自洽：entry===inDir 且 exit===outDir（等价于 solveTurn 反查恒等）
        const entry = rotateLocal("bottom", out.rot);
        const exit = rotateLocal({ 0: "top", 1: "left", 2: "right" }[out.rotationVariant], out.rot);
        if (entry !== out.inDir) throw new ContractViolation(`${path}.rot`, `entry(旋转后局部 bottom)=${entry} 必须等于 inDir=${out.inDir}`, out.rot);
        if (exit !== out.outDir) throw new ContractViolation(`${path}`, `exit(r=${out.rot},rv=${out.rotationVariant})=${exit} 必须等于 outDir=${out.outDir}`, { rot: out.rot, rv: out.rotationVariant });
    } else {
        /* 隧道的 rv 位是 **sender/receiver 的区分位**（0=sender、1=receiver），
           不是"非 belt 实体不许带 rv"那条规则要防的东西。实机存档里正是这样编码的
           （`underground_belt.js:45-48`：code 22=rv0、code 23=rv1）。 */
        if (out.rotationVariant !== 0 && !isTunnel) {
            throw new ContractViolation(`${path}.rotationVariant`, `非 belt 实体 v1 恒 rv=0（plan §2.2 迁移路径 4：实机无 rv≠0 证据；隧道除外——它的 rv 是 sender/receiver 位）`, out.rotationVariant);
        }
        /* 隧道需要 rot：sender/receiver 的朝向就是它的 `rotation`（实机存档里都是 180/90）。
           它不是"机器被旋转"意义上的 rot——隧道本身就是有向的 1×1 建筑，
           方向必须由 rot 表达（蓝图格式里没有别的字段能承载）。 */
        if (out.rot !== 0 && !opts.allowRotatedMachine && out.kind !== "belt" && !isTunnel) {
            // D1 + §0 范围（scope.rotatedMachines:false）：只有带子靠旋转表达方向；
            // 机器（含 miner/trash/hub）的 r≠0 会让 ejector/acceptor 方位整体移位，v1 一律禁止。
            throw new ContractViolation(`${path}.rot`, `0（决策 D1 / scope.rotatedMachines:false：v1 不旋转任何机器，旋转需求由 belt 拐弯 solveTurn 实现）`, out.rot);
        }
        /* 隧道码 22/23 不在"机器码 7..20"区间里：它是 underground_belt 家族
           （op-templates 的 MACHINE_CODES：default=22、rv=1→23），实机存档已确认。 */
        const codeLo = isTunnel ? 22 : 7, codeHi = isTunnel ? 23 : 20;
        if (out.code < codeLo || out.code > codeHi) {
            throw new ContractViolation(`${path}.code`, isTunnel
                ? `隧道的 code ∈ 22(sender)|23(receiver)（underground_belt.js:45-48，实机存档确认）`
                : `非 belt 实体用建筑码 7..20（facts/building-codes-live.json）`, out.code);
        }
        if (out.kind === "trash" || out.kind === "hub") {
            if (out.outDir !== null) throw new ContractViolation(`${path}.outDir`, `${out.kind} 无输出（outDir 必须 null，GEOMETRY 表1）`, out.outDir);
        }
        if (out.kind === "miner" && out.inDir !== null) {
            throw new ContractViolation(`${path}.inDir`, "miner 无输入槽（吃所在资源格，GEOMETRY 表1）", out.inDir);
        }
    }
    return out;
}

/** entities 的产出分层（plan §2.1 硬规定 + 陷阱表 #6 / layout-merge.mjs:96-127）：
 *  0=机器（P3） 1=直线带（P4） 2=拐角带（最后放）。返回 phase 或 -1（非带子机器归 0）。 */
export function entityOrderPhase(e) {
    /* 隧道与拐角带同属"最后放"的一档：它的两端要与相邻带子对接，
       提前放会在邻居不齐时定型（正是陷阱表 #6 讲的施工顺序）。 */
    if (e.kind === "underground_belt") return 2;
    if (e.kind !== "belt") return 0;
    return e.rotationVariant === 0 ? 1 : 2;
}

/**
 * §2.1 校验。纯函数：不改入参；返回规范化后的浅拷贝（便于 instanceIdx 补默认值）。
 *
 * 硬规定（全部断言）：
 *   1. ok:true ⟺ validation.errors.length === 0 且 blueprint !== null；
 *   2. !ok 时 reason 必填且 ∈ §2.5；
 *   3. scope 必须等于 v1 常量（超出 = 契约错误，不是"近似"）；
 *   4. stats.beltTiles / corners 与 entities 自洽（拐角数 = rv≠0 的带子数）；
 *   5. entities 顺序 = 机器 → 直线带 → 拐角带（可 opts.entityOrder="off" 关闭，默认严格）；
 *   6. blueprint 非 null 时必须以 SZBP1. 开头。
 *
 * opts.stages === "nullable"：允许 layout/validation 为 null（**阶段未跑到**的失败计划）。
 *   plan §2.1 把两者都定成必填（不可 null），但 solver/选矿位/作图阶段就失败的 plan 根本没有
 *   它们可填 —— 见 CONTEST.md 第 1 条。默认仍按 plan 严格校验。
 * @param {unknown} v @param {string} [path]
 * @param {{entityOrder?:"strict"|"off", requireBlueprint?:boolean, allowRotatedMachine?:boolean,
 *          stages?:"required"|"nullable"}} [opts]
 * @returns {CompiledPlan}
 */
export function assertCompiledPlan(v, path = "plan", opts = {}) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ContractViolation(path, "CompiledPlan object", v);
    requireKeys(v, ["ok", "goal", "reason", "failingNode", "hint", "site", "blueprint", "entities", "layout", "validation", "stats", "scope"], path);
    const errs = [];
    const push = e => errs.push(e);
    const stagesNullable = opts.stages === "nullable";

    if (typeof v.ok !== "boolean") throw new ContractViolation(`${path}.ok`, "boolean", v.ok);
    const goal = str(v, "goal", path);
    try { checkShortKeyGrammar(goal, `${path}.goal`); } catch (e) { push(e); }

    /* --- reason / failingNode / hint --- */
    let failingNode = null;
    if (v.failingNode !== null) {
        if (!v.failingNode || typeof v.failingNode !== "object" || Array.isArray(v.failingNode)) {
            push(new ContractViolation(`${path}.failingNode`, "{nodeId,cell,check}|null", v.failingNode));
        } else {
            requireKeys(v.failingNode, ["nodeId", "cell", "check"], `${path}.failingNode`);
            try {
                failingNode = {
                    nodeId: str(v.failingNode, "nodeId", `${path}.failingNode`),
                    cell: v.failingNode.cell === null ? null : assertCell(v.failingNode.cell, `${path}.failingNode.cell`),
                    check: str(v.failingNode, "check", `${path}.failingNode`, { allowEmpty: true }),
                };
                if (failingNode.check && !CHECK_IDS.includes(failingNode.check)) {
                    push(new ContractViolation(`${path}.failingNode.check`, `∈ §2.4 CHECK_IDS`, failingNode.check));
                }
            } catch (e) { push(e); }
        }
    }
    if (v.reason !== null && typeof v.reason !== "string") push(new ContractViolation(`${path}.reason`, "string|null", v.reason));
    if (v.hint !== null && typeof v.hint !== "string") push(new ContractViolation(`${path}.hint`, "string|null", v.hint));

    /* --- 硬规定 1：ok ⟺ 无 error 且有蓝图 --- */
    let rawEntities = [];
    try { rawEntities = arr(v, "entities", path); } catch (e) { push(e); }
    let validation = null;
    if (stagesNullable && (v.validation === null || v.validation === undefined)) validation = null;
    else { try { validation = assertValidatorReport(v.validation, `${path}.validation`); } catch (e) { push(e); } }
    /* --- layout（也要在 ok 交叉检查之前解析：ok:true 必须有 LayoutReport） --- */
    let layout = null;
    if (stagesNullable && (v.layout === null || v.layout === undefined)) layout = null;
    else { try { layout = assertLayoutReport(v.layout, `${path}.layout`); } catch (e) { push(e); } }
    const errCount = validation ? validation.errors.length : 0;
    const hasBp = typeof v.blueprint === "string" && v.blueprint !== "";
    if (typeof v.blueprint !== "string" && v.blueprint !== null) push(new ContractViolation(`${path}.blueprint`, "string|null", v.blueprint));
    if (hasBp && !v.blueprint.startsWith(BLUEPRINT_PREFIX)) {
        push(new ContractViolation(`${path}.blueprint`, `以 "${BLUEPRINT_PREFIX}" 开头（src/shared/blueprint.mjs:20）`, v.blueprint));
    }
    if (v.ok === true) {
        if (errCount !== 0) push(new ContractViolation(`${path}.ok`, "ok:true 要求 validation.errors.length===0（实得 " + errCount + "）", true));
        if (!hasBp) push(new ContractViolation(`${path}.ok`, "ok:true 要求 blueprint 非 null（绝不产出无蓝图的绿灯）", v.blueprint));
        if (v.reason !== null) push(new ContractViolation(`${path}.reason`, "ok:true 时 reason 必须 null", v.reason));
        if (rawEntities.length === 0) push(new ContractViolation(`${path}.entities`, "ok:true 要求非空实体表（空蓝图不可能交付）", rawEntities.length));
        // ok:true 意味着「已经过闸」，因此 stages 逃生口对 ok:true 不适用：两者必须在场
        if (validation === null) push(new ContractViolation(`${path}.validation`, "ok:true 必须有 ValidatorReport（绿灯只能是过闸的结果，见 CONTEST C-1）", v.validation));
        if (layout === null) push(new ContractViolation(`${path}.layout`, "ok:true 必须有 LayoutReport（P3 未产出却报绿灯不成立）", v.layout));
    } else if (v.ok === false) {
        // 硬规定 2 + plan §2.5：失败必须有枚举内 reason
        if (v.reason === null || v.reason === undefined || v.reason === "") {
            push(new ContractViolation(`${path}.reason`, "!ok 时必填（§2.5 枚举）", v.reason));
        } else if (!isFailureReason(v.reason)) {
            push(new ContractViolation(`${path}.reason`, "∈ §2.5 FAILURE_REASONS 或 validate:<Vn>", v.reason));
        }
        if (hasBp) push(new ContractViolation(`${path}.blueprint`, "!ok 时必须 null（绝不产出会堵死的蓝图，redteam:158）", v.blueprint));
        // 失败必须可归因（P8 的 LLM 修复层靠 failingNode 定位；plan §2.5 的分诊表）
        if (errCount > 0 && v.failingNode === null) {
            push(new ContractViolation(`${path}.failingNode`, "!ok 且 validation.errors 非空时必须给出归因 {nodeId,cell,check}（实得 null）", v.failingNode));
        }
    }
    if (opts.requireBlueprint === true && !hasBp) push(new ContractViolation(`${path}.blueprint`, "必须有蓝图字符串", v.blueprint));

    /* --- site --- */
    let site = null;
    if (!v.site || typeof v.site !== "object" || Array.isArray(v.site)) push(new ContractViolation(`${path}.site`, "{anchor, hub}", v.site));
    else {
        try {
            requireKeys(v.site, ["anchor", "hub"], `${path}.site`);
            site = { anchor: assertCell(v.site.anchor, `${path}.site.anchor`), hub: v.site.hub === null ? null : assertCell(v.site.hub, `${path}.site.hub`) };
        } catch (e) { push(e); }
    }

    /* --- entities --- */
    /** @type {CompiledEntity[]} */
    const entities = [];
    rawEntities.forEach((e, i) => {
        try { entities.push(assertCompiledEntity(e, `${path}.entities[${i}]`, { allowRotatedMachine: opts.allowRotatedMachine === true })); }
        catch (x) {
            if (x instanceof ContractViolation) { push(x); entities.push(null); } else throw x;
        }
    });
    if (entities.some(e => e === null) === false) {
        // 硬规定 5：产出分层顺序
        if (opts.entityOrder !== "off") {
            let prev = -1;
            entities.forEach((e, i) => {
                const ph = entityOrderPhase(e);
                if (ph < prev) push(new ContractViolation(`${path}.entities[${i}]`, "顺序 = 机器(0) → 直线带(1) → 拐角带(2)（plan §2.1 硬规定 / 陷阱表 #6）", { prevPhase: prev, phase: ph, kind: e.kind, rv: e.rotationVariant }));
                prev = Math.max(prev, ph);
            });
        }
        // 坐标唯一性（蓝图内不允许两实体同格 —— 与 grid 的「同格二次 set 抛错」同源）
        const seen = new Map();
        entities.forEach((e, i) => {
            const k = `${e.dx},${e.dy}`;
            if (seen.has(k)) push(new ContractViolation(`${path}.entities[${i}]`, `格 ${k} 已被 entities[${seen.get(k)}] 占用（同格二次放置不允许）`, i));
            else seen.set(k, i);
        });
    }

    /* --- layout 已在硬规定 1 之前解析完（ok:true 需要它存在） --- */

    /* --- scope（硬规定 3） --- */
    if (!v.scope || typeof v.scope !== "object" || Array.isArray(v.scope)) push(new ContractViolation(`${path}.scope`, "Scope object", v.scope));
    else {
        try {
            requireKeys(v.scope, ["layers", "wires", "tunnels", "rotatedMachines", "maxFanIn"], `${path}.scope`);
            for (const k of Object.keys(SCOPE_V1)) {
                if (v.scope[k] !== SCOPE_V1[k]) push(new ContractViolation(`${path}.scope.${k}`, `v1 恒为 ${JSON.stringify(SCOPE_V1[k])}（超出必须 ok:false + reason，不许静默近似）`, v.scope[k]));
            }
        } catch (e) { push(e); }
    }

    /* --- stats（硬规定 4：与 entities 自洽） --- */
    let stats = null;
    if (!v.stats || typeof v.stats !== "object" || Array.isArray(v.stats)) push(new ContractViolation(`${path}.stats`, "PlanStats object", v.stats));
    else {
        try {
            requireKeys(v.stats, ["machines", "beltTiles", "trash", "bbox", "corners", "estThroughputPerSec", "bottleneck", "blueprintCost", "chargeMode"], `${path}.stats`);
            stats = {
                machines: { ...req(v.stats, "machines", `${path}.stats`) },
                beltTiles: num(v.stats, "beltTiles", `${path}.stats`, { min: 0, int: true }),
                trash: num(v.stats, "trash", `${path}.stats`, { min: 0, int: true }),
                bbox: assertBBox(v.stats.bbox, `${path}.stats.bbox`, { allowEmpty: rawEntities.length === 0 }),
                corners: num(v.stats, "corners", `${path}.stats`, { min: 0, int: true }),
                estThroughputPerSec: num(v.stats, "estThroughputPerSec", `${path}.stats`, { min: 0 }),
                bottleneck: v.stats.bottleneck === null ? null : str(v.stats, "bottleneck", `${path}.stats`),
                blueprintCost: num(v.stats, "blueprintCost", `${path}.stats`, { min: 0, int: true }),
                chargeMode: oneOf(v.stats.chargeMode, CHARGE_MODES, `${path}.stats.chargeMode`),
            };
            for (const [k, n] of Object.entries(stats.machines)) {
                assertInt(n, `${path}.stats.machines.${k}`);
                if (n < 0) push(new ContractViolation(`${path}.stats.machines.${k}`, ">=0 计数", n));
            }
            if (entities.length && entities.every(Boolean)) {
                const belts = entities.filter(e => e.kind === "belt").length;
                const corners = entities.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length;
                const trash = entities.filter(e => e.kind === "trash").length;
                if (stats.beltTiles !== belts) push(new ContractViolation(`${path}.stats.beltTiles`, `=== entities 内 belt 数 (${belts})`, stats.beltTiles));
                if (stats.corners !== corners) push(new ContractViolation(`${path}.stats.corners`, `=== rv≠0 的拐角带数 (${corners})`, stats.corners));
                if (stats.trash !== trash) push(new ContractViolation(`${path}.stats.trash`, `=== entities 内 trash 数 (${trash})`, stats.trash));
                // machines 计数 = 非 belt 实体数（逐 kind）
                const byKind = {};
                for (const e of entities) if (e.kind !== "belt") byKind[e.kind] = (byKind[e.kind] || 0) + 1;
                const keys = new Set([...Object.keys(byKind), ...Object.keys(stats.machines)]);
                for (const k of keys) {
                    const got = stats.machines[k] || 0, want = byKind[k] || 0;
                    if (got !== want) push(new ContractViolation(`${path}.stats.machines.${k}`, `=== entities 内该 kind 数 (${want})`, got));
                }
                // bbox 与 entities 的 dx/dy 跨度一致（蓝图内）
                const xs = entities.map(e => e.dx), ys = entities.map(e => e.dy);
                const bb = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
                if (bb[0] !== stats.bbox[0] || bb[1] !== stats.bbox[1]) {
                    push(new ContractViolation(`${path}.stats.bbox`, `=== entities 的 dx/dy 跨度 ${JSON.stringify(bb)}`, stats.bbox));
                }
                if (layout && (layout.bbox[0] !== stats.bbox[0] || layout.bbox[1] !== stats.bbox[1])) {
                    push(new ContractViolation(`${path}.stats.bbox`, `=== layout.bbox ${JSON.stringify(layout.bbox)}（plan §1.6 L1 门要求 bbox 一致）`, stats.bbox));
                }
                if (layout && layout.cornerCount !== corners) {
                    push(new ContractViolation(`${path}.stats.corners`, `=== layout.cornerCount (${layout.cornerCount})`, stats.corners));
                }
            }
        } catch (e) { push(e); }
    }

    if (errs.length) {
        const first = errs[0];
        for (let i = 1; i < errs.length; i++) first.add(errs[i]);
        throw first;
    }
    return {
        ok: v.ok, goal, reason: v.reason === undefined ? null : v.reason, failingNode,
        hint: v.hint === undefined ? null : v.hint,
        site, blueprint: v.blueprint, entities, layout, validation, stats,
        scope: { ...SCOPE_V1, ...v.scope },
    };
}

/* ════════════════════════════ §2.3 LayoutReport ════════════════════════════ */

function assertEndpoint(ep, path, dirKey) {
    if (!ep || typeof ep !== "object" || Array.isArray(ep)) throw new ContractViolation(path, `{nodeId, cell, slot, ${dirKey}}`, ep);
    requireKeys(ep, ["nodeId", "cell", "slot", dirKey], path);
    return {
        nodeId: str(ep, "nodeId", path),
        cell: assertCell(ep.cell, `${path}.cell`),
        slot: oneOf(ep.slot, DIR_NAMES, `${path}.slot`),
        [dirKey]: oneOf(ep[dirKey], DIR_NAMES, `${path}.${dirKey}`),
    };
}

/**
 * §2.3 校验。要点：
 *   - placements[*].rot：kind 为加工机器时恒 0（决策 D1）；
 *   - channels[*] 端点必须带 slot+outDir / slot+inDir，且预留 slotRole/ordinal（§7.1.1 缓解）；
 *   - occupancy[].state ∈ "solid"|"replaceable"（照 plan 用词，不是 grid 的三态全名）；
 *   - conflicts[].kind ∈ 5 项枚举；
 *   - hubConnection.dir ∈ 0|90|180|270，side ∈ DirName。
 * @param {unknown} v @param {string} [path] @param {{allowRotatedMachine?:boolean}} [opts]
 * @returns {LayoutReport}
 */
export function assertLayoutReport(v, path = "layout", opts = {}) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ContractViolation(path, "LayoutReport object", v);
    requireKeys(v, ["grid", "rows", "placements", "channels", "lanes", "hubConnection", "bbox", "occupancy", "conflicts", "cornerCount"], path);
    const errs = [];
    const push = e => errs.push(e);

    const report = {
        grid: typeof v.grid === "string" ? v.grid : (() => { throw new ContractViolation(`${path}.grid`, "字符网格字符串", v.grid); })(),
        rows: [], placements: [], channels: [], lanes: [], hubConnection: null,
        bbox: [0, 0], occupancy: [], conflicts: [], cornerCount: 0,
    };

    /* rows */
    try {
        report.rows = arr(v, "rows", path).map((r, i) => {
            const p = `${path}.rows[${i}]`;
            requireKeys(r, ["level", "y", "nodeIds"], p);
            return { level: assertInt(r.level, `${p}.level`), y: assertInt(r.y, `${p}.y`), nodeIds: arr(r, "nodeIds", p).map((s, j) => str({ s }, "s", `${p}.nodeIds[${j}]`)) };
        });
    } catch (e) { push(e); }

    /* placements */
    try {
        report.placements = arr(v, "placements", path).map((pl, i) => {
            const p = `${path}.placements[${i}]`;
            requireKeys(pl, ["nodeId", "op", "kind", "cell", "rot", "footprint"], p);
            const rot = pl.rot;
            if (!isAngle(rot)) throw new ContractViolation(`${p}.rot`, "0|90|180|270", rot);
            if (rot !== 0 && !opts.allowRotatedMachine && pl.kind !== "belt") {
                // D1 + scope.rotatedMachines:false：只有带子靠旋转表达方向，任何机器（含 miner/trash/hub）恒 r=0
                throw new ContractViolation(`${p}.rot`, `0（决策 D1：v1 任何机器恒 r=0，旋转需求由 belt 拐弯 solveTurn 实现）`, rot);
            }
            return {
                nodeId: str(pl, "nodeId", p), op: str(pl, "op", p), kind: str(pl, "kind", p),
                cell: assertCell(pl.cell, `${p}.cell`), rot, footprint: assertWH(pl.footprint, `${p}.footprint`),
            };
        });
    } catch (e) { push(e); }

    /* channels */
    try {
        report.channels = arr(v, "channels", path).map((c, i) => {
            const p = `${path}.channels[${i}]`;
            requireKeys(c, ["from", "to", "lane", "payload"], p);
            const out = { from: assertEndpoint(c.from, `${p}.from`, "outDir"), to: assertEndpoint(c.to, `${p}.to`, "inDir"), lane: c.lane === null ? null : assertInt(c.lane, `${p}.lane`), payload: str(c, "payload", p, { allowEmpty: true }) };
            // laneAxis（LANE_SCHEMA_VERSION=2）：lane 的轴。缺省/null = "row"（v1 的唯一轴，向后兼容）。
            // 与 lane 的交叉约束：lane===null ⇒ laneAxis 必须 null（未占车道就没有轴可言）；
            //   lane!==null 且显式给 "row"|"col" ⇒ 采纳；lane!==null 但给 null ⇒ 归一成 "row"（v1 口径）。
            let axis = null;
            if (c.laneAxis !== undefined && c.laneAxis !== null) axis = oneOf(c.laneAxis, LANE_AXES, `${p}.laneAxis`);
            if (c.laneAxis !== undefined && c.laneAxis === null) axis = null;
            if (out.lane === null) {
                if (axis !== null) throw new ContractViolation(`${p}.laneAxis`, "lane===null ⇒ laneAxis 必须 null（未占车道的通道没有轴）", axis);
            } else {
                out.laneAxis = axis === null ? "row" : axis;
            }
            if (c.slotRole !== undefined && c.slotRole !== null) oneOf(c.slotRole, [...SLOT_IN_ROLES, ...SLOT_OUT_ROLES], `${p}.slotRole`);
            if (c.slotRole !== undefined) out.slotRole = c.slotRole;
            if (c.ordinal !== undefined && c.ordinal !== null) out.ordinal = assertInt(c.ordinal, `${p}.ordinal`);
            if (c.ordinal !== undefined) out.ordinal = c.ordinal;
            try { checkShortKeyGrammar(out.payload, `${p}.payload`); } catch (e) { push(e); }
            return out;
        });
    } catch (e) { push(e); }

    /* lanes —— LANE_SCHEMA_VERSION=2：`{row, column}` **恰一个非 null**（见 LayoutLane 注释）。
     *   v1 形态 `{row:3, channelIds}` 原样合法（column 缺省 → null），fixture 无需改动；
     *   新形态 `{column:3, channelIds}` 表达竖直车道。两个都给 / 都不给 = 契约错（不静默择一）。 */
    try {
        report.lanes = arr(v, "lanes", path).map((l, i) => {
            const p = `${path}.lanes[${i}]`;
            requireKeys(l, ["channelIds"], p);
            const row = l.row === undefined || l.row === null ? null : assertInt(l.row, `${p}.row`);
            const column = l.column === undefined || l.column === null ? null : assertInt(l.column, `${p}.column`);
            if ((row === null) === (column === null)) {
                throw new ContractViolation(`${p}`, "{row} 或 {column} **恰一个**非 null（row=行号 / column=列号；两个都给或都不给都无法确定车道身份）",
                    { row, column });
            }
            return { row, column, channelIds: arr(l, "channelIds", p).map((s, j) => str({ s }, "s", `${p}.channelIds[${j}]`)) };
        });
    } catch (e) { push(e); }

    /* hubConnection */
    try {
        if (v.hubConnection !== null) {
            requireKeys(v.hubConnection, ["entry", "side", "dir"], `${path}.hubConnection`);
            report.hubConnection = {
                entry: assertCell(v.hubConnection.entry, `${path}.hubConnection.entry`),
                side: oneOf(v.hubConnection.side, DIR_NAMES, `${path}.hubConnection.side`),
                dir: v.hubConnection.dir,
            };
            if (!isAngle(report.hubConnection.dir)) throw new ContractViolation(`${path}.hubConnection.dir`, "0|90|180|270", report.hubConnection.dir);
        }
    } catch (e) { push(e); }

    // bbox 允许 [0,0]：P3 什么都没作图（早退失败）时它是唯一合法值，与 Grid.bbox() 的口径一致
    try { report.bbox = assertBBox(v.bbox, `${path}.bbox`); } catch (e) { push(e); }

    /* occupancy（来自 obs 的既有世界 —— P5 的 V2 判据数据源） */
    try {
        report.occupancy = arr(v, "occupancy", path).map((o, i) => {
            const p = `${path}.occupancy[${i}]`;
            requireKeys(o, ["cell", "state"], p);
            return { cell: assertCell(o.cell, `${p}.cell`), state: oneOf(o.state, OCCUPANCY_STATES, `${p}.state`), who: o.who === undefined ? undefined : str(o, "who", p), kind: o.kind === undefined ? undefined : str(o, "kind", p) };
        });
    } catch (e) { push(e); }

    /* conflicts */
    try {
        report.conflicts = arr(v, "conflicts", path).map((c, i) => {
            const p = `${path}.conflicts[${i}]`;
            requireKeys(c, ["kind", "cells", "nodeIds", "resolvedBy"], p);
            return {
                kind: oneOf(c.kind, CONFLICT_KINDS, `${p}.kind`),
                cells: arr(c, "cells", p).map((cc, j) => assertCell(cc, `${p}.cells[${j}]`)),
                nodeIds: arr(c, "nodeIds", p).map((s, j) => str({ s }, "s", `${p}.nodeIds[${j}]`)),
                resolvedBy: c.resolvedBy === null ? null : str(c, "resolvedBy", p),
            };
        });
    } catch (e) { push(e); }

    try { report.cornerCount = num(v, "cornerCount", path, { min: 0, int: true }); } catch (e) { push(e); }

    /* 交叉一致性（plan §7.2：conflicts 可上报 + cornerCount 是第一原则度量） */
    try {
        // occupancy 里的格不得被 placements 占据（否则 P3 自己在规划区里撞既有世界）
        const occ = new Set(report.occupancy.map(o => `${o.cell[0]},${o.cell[1]}`));
        for (const pl of report.placements) {
            for (let dy = 0; dy < pl.footprint[1]; dy++) {
                for (let dx = 0; dx < pl.footprint[0]; dx++) {
                    const k = `${pl.cell[0] + dx},${pl.cell[1] + dy}`;
                    if (occ.has(k) && pl.rot === 0) {
                        push(new ContractViolation(`${path}.placements`, `占地 ${k} 与既有世界 occupancy 冲突（P5 的 V2/V1 会 fatal：paste 静默销毁既有带，C1）`, pl.nodeId));
                    }
                }
            }
        }
        // 车道身份 = (轴, 下标)：**同一行**不得属于两条车道（陷阱表 #5），同一列同理；
        // 但 row=3 与 column=3 是**两条不同**的车道，跨轴同号不冲突（vlane 与 hlane 共用整数很常见：
        // 收集带所在的那一列往往正好等于某条水平车道的行号）。
        const laneKeys = report.lanes.map(l => `${l.column === null ? "row" : "col"}:${l.column === null ? l.row : l.column}`);
        if (new Set(laneKeys).size !== laneKeys.length) push(new ContractViolation(`${path}.lanes`, "同一 (轴, 下标) 只能属于一条车道（陷阱表 #5：不同分支必须不同行/列；row 与 column 同号不算冲突）", laneKeys));

        /* ★ 互逆判据（审查 F1，本轮补齐）：`channels[].lane/laneAxis` 与 `lanes[]` 台账必须**互相对得上**。
           在此之前这条只写在 lane.mjs 的注释里、没有任何代码执行它 —— 于是「通道说 row:99、台账只有 row:3」
           这样的自相矛盾报告能同时通过 P1 和 P5 的 V6，`laneAxis` 只是**建议**而非契约。
           判据（逐条，双向）：
             ① 每条占了车道的通道，其 (轴,下标) 必须能在 lanes[] 里找到一条**同键**的车道；
             ② 那条车道的 channelIds 必须**包含**该通道（id 推导与 lane.mjs:channelIdOf 同规则）；
             ③ 台账里列出的每个 channelId 必须对应一条**真的占了这条车道**的通道（不许挂僵尸 id）。
           id 推导在这里重写一份而不是 import：types.mjs 是 P1 契约层，不依赖 P4 实现（依赖方向只能 P4→P1）。
           规则与 lane.mjs:channelIdOf 逐字相同；两边漂移时由 P4 套件里的对拍断言抓。 */
        const chIdOf = (c, i) => {
            if (typeof c.id === "string" && c.id !== "") return c.id;
            const base = `${c.from.nodeId}->${c.to.nodeId}`;
            if (Number.isInteger(c.ordinal)) return `${base}#${c.ordinal}`;
            if (typeof c.slotRole === "string" && c.slotRole) return `${base}[${c.slotRole}]`;
            return `${base}@${i}`;
        };
        const keyOf = (axis, idx) => `${axis}:${idx}`;
        const ledgerByKey = new Map();
        for (const l of report.lanes) {
            const k = l.column === null ? keyOf("row", l.row) : keyOf("col", l.column);
            ledgerByKey.set(k, l);
        }
        const occupying = new Map();   // channelId → key
        const derivableIds = new Set(); // channelIdOf 能推导出的全部 id（用于 ③ 的可判定域）
        report.channels.forEach((c, i) => {
            derivableIds.add(chIdOf(c, i));
            if (c.lane === null || c.lane === undefined) return;
            const axis = c.laneAxis === "col" ? "col" : "row";      // 缺省 = row（v1 兼容）
            const k = keyOf(axis, c.lane);
            occupying.set(chIdOf(c, i), k);
            const l = ledgerByKey.get(k);
            if (!l) {
                push(new ContractViolation(`${path}.channels[${i}].lane`,
                    `通道声明占 ${axis}=${c.lane}，但 lanes[] 里没有这条车道（互逆判据①：台账必须列出每一条被占用的车道）`,
                    { lane: c.lane, laneAxis: axis, ledger: report.lanes }));
                return;
            }
            const id = chIdOf(c, i);
            /* ② 通道 → 台账的**反向**指认。这里必须容忍 v1 的手写 id（金 fixture 用「chB」，
               而 channelIdOf 会推出「mB->st#1」）—— 两套命名都合法，不能因为命名不同就判死一个
               结构正确的报告。可判定的部分：
                 · 台账条目**不能是空的**（占了一条车道却不列任何通道 ⇒ 台账没在履职）；
                 · 若该条目里出现的是**可推导 id**，则本通道的 id 必须在其中（可推导 id 是 P4 的
                   产出形态，出现即说明这份台账用的是新命名，就必须互指）。
               v1 手写命名下「台账列了别的名字」这一情形无法机器区分「助记名」与「挂错」，
               故不做断言 —— 残余风险记录在此，由 P4 的对拍断言（producer 侧）兜住。 */
            const ids = l.channelIds || [];
            if (ids.length === 0) {
                push(new ContractViolation(`${path}.lanes`,
                    `车道 ${k} 的 channelIds 为空，但通道 ${id} 声明占着它（互逆判据②：台账必须列出占用者）`,
                    { laneKey: k, channelId: id }));
            } else if (ids.some(x => derivableIds.has(x)) && !ids.includes(id)) {
                push(new ContractViolation(`${path}.lanes`,
                    `车道 ${k} 用的是可推导 id，却不包含声明占用它的通道 ${id}（互逆判据②：新命名下通道与台账必须互指）`,
                    { laneKey: k, channelIds: ids, channelId: id }));
            }
        });
        for (const l of report.lanes) {
            const k = l.column === null ? keyOf("row", l.row) : keyOf("col", l.column);
            for (const id of l.channelIds || []) {
                // ③ 只在 id **确实指向一条真实通道**时判：v1 手写 fixture 用「chB」这类助记 id，
                //    与 channelIdOf 的可推导形态不同 —— 那不是僵尸 id，是另一套命名，不该被判死。
                //    判据因此收窄成「若这个 id 可被推导出来，它指向的通道就必须真的占这条车道」，
                //    仍然挡住真正危险的形态（台账把一条真实通道挂到它没占的车道上）。
                if (!derivableIds.has(id)) continue;
                if (occupying.get(id) !== k) {
                    push(new ContractViolation(`${path}.lanes`,
                        `车道 ${k} 挂了 id "${id}"，但该通道并未占这条车道（互逆判据③：台账不许把真实通道挂错车道 —— 会让 V6 的同行判重看错对象）`,
                        { laneKey: k, channelId: id, actual: occupying.get(id) ?? null }));
                }
            }
        }
    } catch (e) { push(e); }

    if (errs.length) { const f = errs[0]; for (let i = 1; i < errs.length; i++) f.add(errs[i]); throw f; }
    return report;
}

/* ════════════════════════════ §2.4 ValidatorReport ════════════════════════════ */

/**
 * §2.4 校验。要点：
 *   - checks[].id ∈ CHECK_IDS（V1..V10 + S1）、status ∈ 3 项；
 *   - pass === (errors.length === 0)；
 *   - beltSim.includesMachineNeighbors **必须为 true**（plan §2.4 / redteam:144：现成脚本只喂带子，82.5%）；
 *   - errors[].check 非空且 ok:false 的 check 必须至少有一条 error（否则报告自相矛盾）。
 * @param {unknown} v @param {string} [path]
 * @returns {ValidatorReport}
 */
export function assertValidatorReport(v, path = "validation") {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ContractViolation(path, "ValidatorReport object", v);
    requireKeys(v, ["pass", "checks", "errors", "beltSim", "shapeReplay", "throughput"], path);
    const errs = [];
    const push = e => errs.push(e);
    const out = { pass: false, checks: [], errors: [], beltSim: null, shapeReplay: [], throughput: null };

    if (typeof v.pass !== "boolean") push(new ContractViolation(`${path}.pass`, "boolean", v.pass));
    else out.pass = v.pass;

    try {
        out.checks = arr(v, "checks", path).map((c, i) => {
            const p = `${path}.checks[${i}]`;
            requireKeys(c, ["id", "status", "evidence"], p);
            const id = oneOf(c.id, CHECK_IDS, `${p}.id`);
            const status = oneOf(c.status, CHECK_STATUSES, `${p}.status`);
            if (!c.evidence || typeof c.evidence !== "object") throw new ContractViolation(`${p}.evidence`, "{cell,nodeId,expected,actual,note}", c.evidence);
            requireKeys(c.evidence, ["cell", "nodeId", "expected", "actual", "note"], `${p}.evidence`);
            const ev = {
                cell: c.evidence.cell === null ? null : assertCell(c.evidence.cell, `${p}.evidence.cell`),
                nodeId: c.evidence.nodeId === null ? null
                    : typeof c.evidence.nodeId === "string" ? c.evidence.nodeId
                        : (() => { throw new ContractViolation(`${p}.evidence.nodeId`, "string|null", c.evidence.nodeId); })(),
                expected: c.evidence.expected === null ? null : String(c.evidence.expected),
                actual: c.evidence.actual === null ? null : String(c.evidence.actual),
                note: typeof c.evidence.note === "string" ? c.evidence.note : (() => { throw new ContractViolation(`${p}.evidence.note`, "string（人读证据）", c.evidence.note); })(),
            };
            return { id, status, evidence: ev };
        });
    } catch (e) { push(e); }

    try {
        out.errors = arr(v, "errors", path).map((er, i) => {
            const p = `${path}.errors[${i}]`;
            requireKeys(er, ["check", "severity", "nodeId", "cell", "message"], p);
            const severity = oneOf(er.severity, SEVERITIES, `${p}.severity`);
            const check = str(er, "check", p);
            if (!CHECK_IDS.includes(check) && !isFailureReason(check)) {
                push(new ContractViolation(`${p}.check`, "§2.4 check id 或 §2.5 reason", check));
            }
            return {
                check, severity, nodeId: str(er, "nodeId", p, { allowEmpty: true }),
                cell: er.cell === null ? null : assertCell(er.cell, `${p}.cell`),
                message: str(er, "message", p),
            };
        });
    } catch (e) { push(e); }

    try {
        requireKeys(v.beltSim, ["tilesChecked", "fixedPoints", "drift", "includesMachineNeighbors"], `${path}.beltSim`);
        const bs = {
            tilesChecked: num(v.beltSim, "tilesChecked", `${path}.beltSim`, { min: 0, int: true }),
            fixedPoints: num(v.beltSim, "fixedPoints", `${path}.beltSim`, { min: 0, int: true }),
            drift: arr(v.beltSim, "drift", `${path}.beltSim`).map((d, i) => {
                const p = `${path}.beltSim.drift[${i}]`;
                requireKeys(d, ["cell", "wantRv", "gotRv"], p);
                return { cell: assertCell(d.cell, `${p}.cell`), wantRv: assertInt(d.wantRv, `${p}.wantRv`), gotRv: assertInt(d.gotRv, `${p}.gotRv`) };
            }),
            includesMachineNeighbors: v.beltSim.includesMachineNeighbors,
        };
        // §2.4 硬规定：必须为 true（邻居只喂带子的自检没有价值）
        if (bs.includesMachineNeighbors !== true) {
            throw new ContractViolation(`${path}.beltSim.includesMachineNeighbors`, "true（必须含机器邻居，redteam:144）", bs.includesMachineNeighbors);
        }
        if (bs.fixedPoints > bs.tilesChecked) push(new ContractViolation(`${path}.beltSim.fixedPoints`, "<= tilesChecked", { fixedPoints: bs.fixedPoints, tilesChecked: bs.tilesChecked }));
        out.beltSim = bs;
    } catch (e) { push(e); }

    try {
        out.shapeReplay = arr(v, "shapeReplay", path).map((s, i) => {
            const p = `${path}.shapeReplay[${i}]`;
            requireKeys(s, ["nodeId", "expectedHash", "actualHash", "equal"], p);
            const equal = s.equal;
            if (typeof equal !== "boolean") throw new ContractViolation(`${p}.equal`, "boolean", equal);
            const got = { nodeId: str(s, "nodeId", p), expectedHash: str(s, "expectedHash", p, { allowEmpty: true }), actualHash: str(s, "actualHash", p, { allowEmpty: true }), equal };
            if (got.equal !== (got.expectedHash === got.actualHash)) {
                push(new ContractViolation(`${p}.equal`, `=== (expectedHash === actualHash)`, { equal: got.equal, expectedHash: got.expectedHash, actualHash: got.actualHash }));
            }
            return got;
        });
    } catch (e) { push(e); }

    try {
        requireKeys(v.throughput, ["demandPerSec", "bottleneck", "rowsRequired", "rowsPlanned"], `${path}.throughput`);
        const th = {
            demandPerSec: num(v.throughput, "demandPerSec", `${path}.throughput`, { min: 0 }),
            bottleneck: v.throughput.bottleneck, rowsRequired: num(v.throughput, "rowsRequired", `${path}.throughput`, { min: 0, int: true }),
            rowsPlanned: num(v.throughput, "rowsPlanned", `${path}.throughput`, { min: 0, int: true }),
        };
        if (th.bottleneck !== null) {
            requireKeys(th.bottleneck, ["nodeId", "ratePerSec"], `${path}.throughput.bottleneck`);
            th.bottleneck = { nodeId: str(th.bottleneck, "nodeId", `${path}.throughput.bottleneck`), ratePerSec: num(th.bottleneck, "ratePerSec", `${path}.throughput.bottleneck`, { min: 0 }) };
        }
        out.throughput = th;
    } catch (e) { push(e); }

    /* 交叉一致性 */
    try {
        const fatal = out.errors.filter(e => e.severity === "fatal").length;
        if (out.pass !== (out.errors.length === 0)) {
            push(new ContractViolation(`${path}.pass`, `=== (errors.length === 0)，实得 errors.length=${out.errors.length}`, out.pass));
        }
        if (out.checks.length) {
            const ids = new Set(out.checks.map(c => c.id));
            for (const id of ids) {
                const c = out.checks.find(x => x.id === id);
                const failed = c.status === "fail";
                const hasErr = out.errors.some(e => e.check === id || checkIdMatches(e.check, id));
                if (failed && !hasErr) push(new ContractViolation(`${path}.checks`, `check ${id} status=fail 但 errors[] 无对应条目（报告自相矛盾，P8 分诊会漏）`, id));
                if (c.status === "pass" && hasErr) push(new ContractViolation(`${path}.checks`, `check ${id} status=pass 但 errors[] 有对应条目`, id));
            }
            for (const e of out.errors) {
                if (!ids.has(e.check) && !out.checks.some(c => checkIdMatches(e.check, c.id))) {
                    push(new ContractViolation(`${path}.errors`, `errors[].check=${e.check} 在 checks[] 里没有对应条目（§2.4 要求 checks 与 errors 对齐）`, e.check));
                }
            }
        }
        // ok:false 的 report 必须有 fatal（否则 P8 会把它当绿灯）
        if (out.pass === false && fatal === 0 && out.errors.length > 0) {
            push(new ContractViolation(`${path}.errors`, "pass:false 时至少一条 severity===\"fatal\"（warn 不得单独让计划失败）", out.errors.map(e => e.severity)));
        }
        // 漂移与 V3 一致（plan L1.5 门：drift.length===0）
        const v3 = out.checks.find(c => c.id === "V3-belt-fixed-point");
        if (v3 && out.beltSim) {
            if (out.beltSim.drift.length > 0 && v3.status === "pass") {
                push(new ContractViolation(`${path}.checks`, "beltSim.drift 非空时 V3-belt-fixed-point 不得为 pass（防 rv 漂移的唯一闸，plan §2.4）", v3.status));
            }
        }
    } catch (e) { push(e); }

    if (errs.length) { const f = errs[0]; for (let i = 1; i < errs.length; i++) f.add(errs[i]); throw f; }
    return out;
}

/** errors[].check 可能写短号（"V3"）或全名（"V3-belt-fixed-point"）—— 归一比对 */
function checkIdMatches(errCheck, checkId) {
    if (typeof errCheck !== "string") return false;
    return errCheck === checkId || errCheck.split("-")[0] === checkId.split("-")[0];
}

/* ════════════════════════════ §2.6 WorldState ════════════════════════════ */

/**
 * §2.6 校验。入参的 replaceableBeltCells 允许 Set 或 "x,y" 数组（JSON 往返用数组）。
 * @param {unknown} v @param {string} [path] @returns {WorldState}
 */
export function assertWorldState(v, path = "world") {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ContractViolation(path, "WorldState object", v);
    requireKeys(v, ["tick", "seed", "hub", "goal", "upgradeLevels", "entities", "resources", "replaceableBeltCells"], path);
    const errs = [];
    const push = e => errs.push(e);
    const out = { tick: 0, seed: null, hub: null, goal: null, upgradeLevels: {}, entities: [], resources: [], replaceableBeltCells: new Set() };

    try { out.tick = assertInt(v.tick, `${path}.tick`); } catch (e) { push(e); }
    if (v.seed !== null) { try { out.seed = assertInt(v.seed, `${path}.seed`); } catch (e) { push(e); } }
    try {
        if (v.hub !== null) {
            requireKeys(v.hub, ["x", "y"], `${path}.hub`);
            out.hub = { x: assertInt(v.hub.x, `${path}.hub.x`), y: assertInt(v.hub.y, `${path}.hub.y`) };
        }
    } catch (e) { push(e); }
    try {
        requireKeys(v.goal, ["level", "shape", "required", "delivered"], `${path}.goal`);
        out.goal = {
            level: assertInt(v.goal.level, `${path}.goal.level`), shape: str(v.goal, "shape", `${path}.goal`),
            required: num(v.goal, "required", `${path}.goal`, { min: 0, int: true }), delivered: num(v.goal, "delivered", `${path}.goal`, { min: 0, int: true }),
        };
        try { checkShortKeyGrammar(out.goal.shape, `${path}.goal.shape`); } catch (e) { push(e); }
    } catch (e) { push(e); }
    try {
        if (!v.upgradeLevels || typeof v.upgradeLevels !== "object") throw new ContractViolation(`${path}.upgradeLevels`, "Record<belt|miner|processors|painting, number>", v.upgradeLevels);
        for (const k of UPGRADE_KEYS) {
            if (!(k in v.upgradeLevels)) throw new ContractViolation(`${path}.upgradeLevels.${k}`, "字段必须存在（obs 的升级等级）", v.upgradeLevels[k]);
            out.upgradeLevels[k] = assertInt(v.upgradeLevels[k], `${path}.upgradeLevels.${k}`);
        }
        for (const k of Object.keys(v.upgradeLevels)) {
            if (!UPGRADE_KEYS.includes(k)) push(new ContractViolation(`${path}.upgradeLevels.${k}`, `∈ [${UPGRADE_KEYS.join("|")}]（§2.6）`, k));
        }
    } catch (e) { push(e); }
    try {
        out.entities = arr(v, "entities", path).map((en, i) => {
            const p = `${path}.entities[${i}]`;
            requireKeys(en, ["uid", "type", "x", "y", "r", "variant", "rotationVariant", "code", "layer"], p);
            return {
                uid: assertInt(en.uid, `${p}.uid`), type: str(en, "type", p),
                x: assertInt(en.x, `${p}.x`), y: assertInt(en.y, `${p}.y`),
                r: en.r, variant: str(en, "variant", p, { allowEmpty: true }),
                rotationVariant: assertInt(en.rotationVariant, `${p}.rotationVariant`),
                code: assertInt(en.code, `${p}.code`), layer: str(en, "layer", p),
            };
        });
        for (const en of out.entities) {
            if (en.type === "belt" && en.code !== beltCode(en.rotationVariant)) {
                push(new ContractViolation(`${path}.entities`, `type==="belt" 必须满足 code === beltCode(rv) = ${beltCode(en.rotationVariant)}（belt-rules.mjs:55-56；obs 已回报 code 与 rv）`, { uid: en.uid, code: en.code, rv: en.rotationVariant }));
            }
        }
    } catch (e) { push(e); }
    try {
        out.resources = arr(v, "resources", path).map((r, i) => {
            const p = `${path}.resources[${i}]`;
            if (!Array.isArray(r) || r.length !== 3) throw new ContractViolation(p, "[x, y, shortKey] 三元组", r);
            return [assertInt(r[0], `${p}[0]`), assertInt(r[1], `${p}[1]`), str({ s: r[2] }, "s", `${p}[2]`)];
        });
    } catch (e) { push(e); }
    try {
        const rbc = v.replaceableBeltCells;
        const keys = rbc instanceof Set ? [...rbc] : Array.isArray(rbc) ? rbc
            : (() => { throw new ContractViolation(`${path}.replaceableBeltCells`, "Set<string> 或 [\"x,y\"] 数组（JSON 往返用数组）", rbc); })();
        const seen = new Set();
        for (const k of keys) {
            if (typeof k !== "string") throw new ContractViolation(`${path}.replaceableBeltCells`, "元素为 \"x,y\" 字符串", k);
            const parts = k.split(",");
            if (parts.length !== 2 || !parts.every(s => /^-?\d+$/.test(s.trim()))) {
                throw new ContractViolation(`${path}.replaceableBeltCells`, "元素格式 \"x,y\"", k);
            }
            seen.add(`${Number(parts[0])},${Number(parts[1])}`);
        }
        out.replaceableBeltCells = seen;
    } catch (e) { push(e); }

    /* 交叉一致性：type==="belt" 的实体必须出现在 replaceableBeltCells（C1 的判据数据源） */
    try {
        for (const en of out.entities) {
            if (en.type === "belt" && !out.replaceableBeltCells.has(`${en.x},${en.y}`)) {
                push(new ContractViolation(`${path}.replaceableBeltCells`, `必须包含既有带格 "${en.x},${en.y}"（uid=${en.uid}）—— 否则 P5 的 V2 无从判定「paste 静默毁带」（C1）`, en.uid));
            }
        }
    } catch (e) { push(e); }

    if (errs.length) { const f = errs[0]; for (let i = 1; i < errs.length; i++) f.add(errs[i]); throw f; }
    return out;
}

/** WorldState → 可落盘 JSON（Set → 排序数组；数组顺序稳定便于 diff） */
export function worldStateToJSON(w) {
    const ws = assertWorldState(w);
    return {
        tick: ws.tick, seed: ws.seed, hub: ws.hub, goal: ws.goal, upgradeLevels: { ...ws.upgradeLevels },
        entities: ws.entities, resources: ws.resources,
        replaceableBeltCells: [...ws.replaceableBeltCells].sort((a, b) => {
            const [ax, ay] = a.split(",").map(Number), [bx, by] = b.split(",").map(Number);
            return ay - by || ax - bx;
        }),
    };
}

/** 落盘 JSON → WorldState（replaceableBeltCells 数组 → Set）@returns {WorldState} */
export function normalizeWorldState(raw) {
    let obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && !Array.isArray(obj) && typeof obj === "object" && Array.isArray(obj.replaceableBeltCells)) {
        obj = { ...obj, replaceableBeltCells: new Set(obj.replaceableBeltCells) };
    }
    return assertWorldState(obj);
}

/* ════════════════════════════ CompiledPlan 辅助（P1 只给原语，不做发射） ════════════════════════════ */

/** 补齐可缺省字段并规范化（instanceIdx→0、Set 往返），返回新对象；不做深改语义。 */
export function normalizeCompiledPlan(p, opts = {}) {
    const a = assertCompiledPlan(p, "plan", opts);
    return { ...a, entities: a.entities.map(e => ({ ...e, instanceIdx: e.instanceIdx === undefined ? 0 : e.instanceIdx })) };
}

/**
 * 从 CompiledPlan.entities 造蓝图**容器骨架** {v,gv,w,e:[code,dx,dy,rot,...]}。
 * P1 只为 L0 自检与 fixture 生成提供它（不做 LZString 压缩 —— 那是 P6 的发射职责）。
 * 锚点 w=[minx,miny]（src/shared/blueprint.mjs:64 同构）。
 * @param {CompiledPlan|object} plan @param {{gv?:string}} [opts]
 */
export function blueprintSkeleton(plan, opts = {}) {
    const p = plan && plan.entities ? plan : assertCompiledPlan(plan, "plan", { entityOrder: "off" });
    if (!p.entities.length) throw new ContractViolation("blueprintSkeleton", "entities 非空（空蓝图无意义）", p.entities.length);
    let minX = Infinity, minY = Infinity;
    for (const e of p.entities) { if (e.dx < minX) minX = e.dx; if (e.dy < minY) minY = e.dy; }
    const e = [];
    for (const en of p.entities) e.push(en.code, en.dx, en.dy, en.rot);
    return { v: 1, gv: opts.gv || GAME_VERSION, w: [minX, minY], e };
}

/** 从 blueprintSkeleton 读回逐格 (code,dx,dy,rot)（stride=4，plan §1.6 D2 的缺口就在这个 4 上） */
export function readBlueprintSkeleton(skel) {
    if (!skel || !Array.isArray(skel.e) || skel.e.length % BLUEPRINT_STRIDE !== 0) {
        throw new ContractViolation("readBlueprintSkeleton(e)", `长度必须是 ${BLUEPRINT_STRIDE} 的倍数`, skel && skel.e && skel.e.length);
    }
    const out = [];
    for (let i = 0; i < skel.e.length; i += BLUEPRINT_STRIDE) {
        out.push({ code: skel.e[i], dx: skel.e[i + 1], dy: skel.e[i + 2], rot: skel.e[i + 3] });
    }
    return out;
}

/**
 * 三态占用查询：给定 CompiledPlan 的 entities 与既有世界的 replaceable 键集，
 * 返回 paste 落点冲突清单（P5 的 V2 用它做零重叠判定；P1 只提供原语，不做 check）。
 * @param {CompiledPlan|{entities:CompiledEntity[]}} plan @param {Set<string>|string[]} replaceableKeys
 * @returns {Array<{cell:[number,number], code:number, kind:string, reason:string}>}
 */
export function planVsReplaceableWorld(plan, replaceableKeys) {
    const keys = new Set(replaceableKeys instanceof Set ? replaceableKeys : (replaceableKeys || []));
    const out = [];
    for (const e of plan.entities) {
        const k = `${e.dx},${e.dy}`;
        if (keys.has(k)) out.push({ cell: [e.dx, e.dy], code: e.code, kind: e.kind, reason: "蓝图落点压住既有可替换带：paste 会静默销毁旧带且不报告（C1）" });
    }
    return out;
}

/* ════════════════════════════ 测试入口：node src/ai/compiler/types.mjs --test ════════════════════════════ */
// L0 §1.1-2：三个金样例 round-trip（assert → 序列化 → parse → assert）；缺字段 → 结构化错误且不静默。
// L0 §1.1-4：金样例的蓝图段能被 summarizeBlueprint 读通。
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/types.mjs")) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const FIX = path.join(root, "research", "ai-plan", "fixtures");

    let fails = 0;
    const eq = (got, want, m) => { const A = JSON.stringify(got), B = JSON.stringify(want); if (A === B) console.log("✓ " + m); else { fails++; console.log(`✗ ${m}  got=${A} want=${B}`); } };
    const ok = (v, m) => eq(!!v, true, m);
    const throws = (fn, m, frag) => { try { fn(); fails++; console.log(`✗ ${m} 未抛错`); } catch (e) { const msg = (e && e.allMessages) || String(e && e.message); if (frag && !msg.includes(frag)) { fails++; console.log(`✗ ${m}：错误不含 "${frag}"（实得 ${msg.slice(0, 200)}）`); return; } console.log(`✓ ${m}（${e.name}，含"${frag || ""}"）`); } };

    const readJSON = f => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
    const clone = o => JSON.parse(JSON.stringify(o));

    /* ── fixtures 存在性 ── */
    for (const f of ["plan-l1.json", "report-layout.json", "report-validator.json"]) {
        ok(fs.existsSync(path.join(FIX, f)), `fixture 存在：${f}`);
    }
    if (fails) { console.log(`types.mjs: ${fails} 条失败`); process.exitCode = 1; } else {
        /* ── plan-l1.json：完整 CompiledPlan round-trip ── */
        const planRaw = readJSON("plan-l1.json");
        const a1 = assertCompiledPlan(planRaw, "plan");
        ok(a1.ok === true, "plan-l1 ok:true");
        // 序列化 → parse → 再 assert（round-trip 恒等）
        const rt = assertCompiledPlan(JSON.parse(JSON.stringify(a1)), "plan(rt)");
        eq(JSON.parse(JSON.stringify(rt)), JSON.parse(JSON.stringify(a1)), "plan-l1 round-trip 恒等");
        eq(rt.entities.length, planRaw.entities.length, "plan-l1 entities 数量保持");

        /* ── report-layout.json ── */
        const layRaw = readJSON("report-layout.json");
        const lay = assertLayoutReport(layRaw, "layout");
        eq(assertLayoutReport(JSON.parse(JSON.stringify(lay)), "layout(rt)"), lay, "report-layout round-trip 恒等");
        ok(lay.channels.length > 0, "report-layout 有 channels（P4 的输入）");
        ok(lay.cornerCount > 0, "report-layout 是双分支汇合（必有拐角）");
        // LANE_SCHEMA_VERSION=2 的**向后兼容**：v1 fixture 的 `{row:3, channelIds}` 仍合法，
        // 规范化后 column 为 null；channels[].lane 保持数字（laneAxis 缺省不写，下游按 "row" 读）。
        eq(lay.lanes.map(l => ({ row: l.row, column: l.column })), [{ row: 3, column: null }],
            "v1 fixture 的 lanes[] 读成 {row:3, column:null}（column 缺省 = null，向后兼容）");
        eq(lay.channels[1].lane, 3, "v1 fixture 的 channels[].lane 仍是数字 3（未被改写）");

        /* ── lanes[] / laneAxis 的 v2 契约（column 车道 + 跨轴同号不判重） ── */
        {
            const v2 = clone(layRaw);
            // row=3 与 column=3 是两条**不同**的车道：不得被「同行唯一」判重误伤
            v2.lanes = [{ row: 3, channelIds: ["chB"] }, { column: 3, channelIds: ["chV"] }];
            let okCross = true, errCross = "";
            try { assertLayoutReport(v2, "layout(cross-axis)"); } catch (e) { okCross = false; errCross = (e.allMessages || e.message).slice(0, 200); }
            ok(okCross, "lanes[] 允许 row:3 与 column:3 并存（车道身份 = (轴, 下标)，不是裸整数）" + (okCross ? "" : "：" + errCross));
            const v2rt = assertLayoutReport(JSON.parse(JSON.stringify(assertLayoutReport(v2, "layout(cross-axis)"))), "layout(cross-axis-rt)");
            eq(v2rt.lanes.length, 2, "column 车道经 JSON round-trip 保持（两个轴都在）");
            // 同一 (轴, 下标) 重复 → 必须拒（陷阱表 #5 的契约面）
            const dup = clone(v2); dup.lanes = [{ row: 3, channelIds: ["a"] }, { row: 3, channelIds: ["b"] }];
            throws(() => assertLayoutReport(dup, "layout(dup-row)"), "同一 row 重复 → 拒", "同一 (轴, 下标)");
            const dupCol = clone(v2); dupCol.lanes = [{ column: 4, channelIds: ["a"] }, { column: 4, channelIds: ["b"] }];
            throws(() => assertLayoutReport(dupCol, "layout(dup-col)"), "同一 column 重复 → 拒", "同一 (轴, 下标)");
            // 两个都给 / 都不给 → 拒（车道身份无法确定，不许静默择一）
            const both = clone(v2); both.lanes = [{ row: 3, column: 4, channelIds: ["a"] }];
            throws(() => assertLayoutReport(both, "layout(both)"), "lanes[] 条目 row+column 同时给 → 拒（无法确定车道身份）", "恰一个");
            const neither = clone(v2); neither.lanes = [{ channelIds: ["a"] }];
            throws(() => assertLayoutReport(neither, "layout(neither)"), "lanes[] 条目 row/column 都不给 → 拒", "恰一个");
            // channels[].laneAxis 的交叉约束
            // ⚠️ 这些样例必须**同时**给出匹配的 lanes[] 台账：互逆判据（见 assertLayoutReport 的 ★ 段）
            //    要求「通道声明占某条车道」⟺「台账里有这条车道」。只改 channels 不改台账，
            //    现在会被正确判死 —— 那不是测试想要的（它想测 laneAxis 的保留/枚举，不是互逆）。
            //    用到的是 channels[2]（st->out），其推导 id = "st->out[out]"（slotRole="out"）。
            const ax = clone(layRaw);
            ax.channels[2] = { ...ax.channels[2], lane: 7, laneAxis: "col" };
            ax.lanes = [{ row: 3, channelIds: ["chB"] }, { column: 7, channelIds: ["st->out[out]"] }];
            const axOK = assertLayoutReport(ax, "layout(axis-col)");
            eq([axOK.channels[2].lane, axOK.channels[2].laneAxis], [7, "col"], "channels[].laneAxis:\"col\" 被保留（列号）");
            const axRow = clone(layRaw);
            axRow.channels[2] = { ...axRow.channels[2], lane: 7, laneAxis: "row" };
            axRow.lanes = [{ row: 3, channelIds: ["chB"] }, { row: 7, channelIds: ["st->out[out]"] }];
            eq(assertLayoutReport(axRow, "layout(axis-row)").channels[2].laneAxis, "row", "channels[].laneAxis:\"row\" 被保留");
            const axBad = clone(layRaw); axBad.channels[2] = { ...axBad.channels[2], lane: 7, laneAxis: "diag" };
            throws(() => assertLayoutReport(axBad, "layout(axis-bad)"), "laneAxis 枚举外 → 拒", "laneAxis");
            const axNull = clone(layRaw); axNull.channels[2] = { ...axNull.channels[2], lane: null, laneAxis: "col" };
            throws(() => assertLayoutReport(axNull, "layout(axis-null)"), "lane===null 却给 laneAxis → 拒（未占车道没有轴）", "laneAxis");
        }

        /* ── report-validator.json ── */
        const valRaw = readJSON("report-validator.json");
        const val = assertValidatorReport(valRaw, "validation");
        eq(assertValidatorReport(JSON.parse(JSON.stringify(val)), "validation(rt)"), val, "report-validator round-trip 恒等");
        eq(val.pass, false, "report-validator 是故意错的 plan（pass:false）");
        eq(val.errors.length, valRaw.errors.length, "report-validator errors 保持");

        /* ── 金样例蓝图段 → summarizeBlueprint 读通（L0 §1.1-4） ── */
        const bp = await import(pathToFileURL(path.join(root, "src", "shared", "blueprint.mjs")).href);
        const skel = blueprintSkeleton(a1);
        const text = typeof a1.blueprint === "string" && a1.blueprint.startsWith(BLUEPRINT_PREFIX) && a1.blueprint.length > BLUEPRINT_PREFIX.length + 1
            ? a1.blueprint : bp.encodeBlueprint(skel);
        const summary = bp.summarizeBlueprint(text);
        eq(summary.count, a1.entities.length, "summarizeBlueprint 读通：实体数一致");
        eq(summary.anchor, skel.w, "summarizeBlueprint anchor = [minx,miny]");
        eq(summary.format_version, 1, "summarizeBlueprint format_version=1");
        eq(Object.values(summary.by_code).reduce((x, y) => x + y, 0), a1.entities.length, "summarizeBlueprint by_code 计数总和一致");
        eq(readBlueprintSkeleton(skel).map(e => [e.code, e.dx, e.dy, e.rot]), a1.entities.map(e => [e.code, e.dx, e.dy, e.rot]), "容器 stride=4 与 entities 逐格全等（plan L1 门）");

        /* ── 缺字段 → 结构化错误且不静默 ── */
        const drop = (obj, p) => { const parts = p.split("."); let cur = obj; for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]; delete cur[parts[parts.length - 1]]; return obj; };
        for (const key of ["ok", "goal", "reason", "failingNode", "hint", "site", "blueprint", "entities", "layout", "validation", "stats", "scope"]) {
            const bad = clone(planRaw); delete bad[key];
            throws(() => assertCompiledPlan(bad, "plan"), `缺 plan.${key} → 结构化错误`, key);
        }
        throws(() => assertCompiledPlan(drop(clone(planRaw), "entities.0.rotationVariant"), "plan"), "缺 entity.rotationVariant → 报字段名", "rotationVariant");
        throws(() => assertCompiledPlan(drop(clone(planRaw), "layout.placements.0.footprint"), "plan"), "缺 layout.placements[].footprint → 报字段名", "footprint");
        throws(() => assertCompiledPlan(drop(clone(planRaw), "stats.chargeMode"), "plan"), "缺 stats.chargeMode → 报字段名", "chargeMode");

        /* ── 枚举外值 → 结构化错误 ── */
        const e1 = clone(planRaw); e1.entities[0].kind = "drill";
        throws(() => assertCompiledPlan(e1, "plan"), "kind 枚举外 → 错误", "kind");
        const e2 = clone(planRaw); e2.entities[0].rot = 45;
        throws(() => assertCompiledPlan(e2, "plan"), "rot 非法角度 → 错误", "rot");
        const e3 = clone(planRaw); e3.goal = "----CuX";
        throws(() => assertCompiledPlan(e3, "plan"), "goal 语法不合法 → 错误", "goal");
        const e4 = clone(planRaw); e4.stats.chargeMode = false;
        throws(() => assertCompiledPlan(e4, "plan"), "chargeMode 布尔 → 必须是字符串枚举", "chargeMode");
        const e5 = clone(planRaw); e5.scope.wires = true;
        throws(() => assertCompiledPlan(e5, "plan"), "scope 超出 v1 → 拒绝（不许静默近似）", "scope.wires");

        /* ── §2.1 硬规定 ── */
        const h1 = clone(planRaw); h1.ok = false; h1.blueprint = null; h1.reason = "made-up-reason";
        throws(() => assertCompiledPlan(h1, "plan"), "!ok 时 reason 必须 ∈ §2.5", "reason");
        const h2 = clone(planRaw); h2.ok = false; h2.reason = "out-of-scope:wire"; h2.blueprint = "SZBP1.zzz";
        throws(() => assertCompiledPlan(h2, "plan"), "!ok 时 blueprint 必须 null（绝不产出会堵死的蓝图）", "blueprint");
        const h3 = clone(planRaw); h3.blueprint = "BP1.nope";
        throws(() => assertCompiledPlan(h3, "plan"), "blueprint 前缀必须 SZBP1.", "blueprint");
        const h4 = clone(planRaw); h4.ok = false; h4.reason = "validate:V2"; h4.blueprint = null; h4.failingNode = { nodeId: "n1", cell: [0, 4], check: "V2-no-overwrite-existing-belt" };
        h4.validation = { ...h4.validation, pass: false, errors: [{ check: "V2-no-overwrite-existing-belt", severity: "fatal", nodeId: "n1", cell: [0, 4], message: "规划区压住既有带子" }], checks: h4.validation.checks.map(c => c.id === "V2-no-overwrite-existing-belt" ? { ...c, status: "fail" } : c) };
        eq(assertCompiledPlan(h4, "plan").reason, "validate:V2", "合法失败形态（validate:<Vn> + failingNode + blueprint:null）通过");
        // 失败必须可归因：validation.errors 非空而 failingNode:null → 结构化错误（P8 的修复层靠它定位）
        const h5 = clone(h4); h5.failingNode = null;
        throws(() => assertCompiledPlan(h5, "plan"), "!ok 且 errors 非空时 failingNode 应指明归因", "failingNode");
        const h6 = clone(planRaw); h6.validation = { ...h6.validation, pass: false, errors: [{ check: "V3-belt-fixed-point", severity: "fatal", nodeId: "n1", cell: null, message: "非不动点" }], checks: h6.validation.checks.map(c => c.id === "V3-belt-fixed-point" ? { ...c, status: "fail" } : c) };
        throws(() => assertCompiledPlan(h6, "plan"), "有 error 却 ok:true → 违反硬规定 1", "errors");

        /* ── CONTEST C-1 的逃生口：早退失败可以不带 layout/validation，但 ok:true 绝不可以 ── */
        const early = clone(h4); early.reason = "no-site-large-enough"; early.why = null;
        early.layout = null; early.validation = null; early.blueprint = null; early.entities = [];
        early.stats = { machines: {}, beltTiles: 0, trash: 0, bbox: [0, 0], corners: 0, estThroughputPerSec: 0, bottleneck: null, blueprintCost: 0, chargeMode: "false" };
        const earlyOK = assertCompiledPlan(early, "plan", { stages: "nullable" });
        eq([earlyOK.ok, earlyOK.reason], [false, "no-site-large-enough"], "stages:\"nullable\" 放行早退失败（P8 在 P3/P5 之前失败时无假报告可填）");
        throws(() => assertCompiledPlan(early, "plan"), "默认口径仍拒绝 layout:null（严格按 plan §2.1）", "layout");
        const fakeGreen = clone(early); fakeGreen.ok = true; fakeGreen.reason = null; fakeGreen.blueprint = planRaw.blueprint;
        throws(() => assertCompiledPlan(fakeGreen, "plan", { stages: "nullable" }), "ok:true 时 stages 逃生口失效：绿灯必须有 ValidatorReport", "validation");
        // 逃生口不放宽 stats.bbox（[0,0] 违反 w>=1），所以 fakeGreen 的错误里也要能看到 validation 这条
        const fakeGreen2 = { ...clone(planRaw), layout: null, validation: null };
        throws(() => assertCompiledPlan(fakeGreen2, "plan", { stages: "nullable" }), "ok:true + layout:null 也被拒", "layout");

        /* ── belt 交叉约束（belt-rules 一致性，唯一权威 = src/ai/belt-rules.mjs） ── */
        const b1 = clone(planRaw); b1.entities.find(e => e.kind === "belt").code = 5;
        throws(() => assertCompiledPlan(b1, "plan"), "belt code ≠ 1+rv → 拒绝", "code");
        const b2 = clone(planRaw); const belt2 = b2.entities.find(e => e.kind === "belt");
        belt2.rotationVariant = 1; belt2.code = beltCode(1);   // code 跟着改，只剩 (r,rv) 自洽性会失败
        throws(() => assertCompiledPlan(b2, "plan"), "rv 改了但 exit 不再等于 outDir → 拒绝", "outDir");
        const b3 = clone(planRaw); const mach = b3.entities.find(e => e.kind === "cutter"); mach.rotationVariant = 2;
        throws(() => assertCompiledPlan(b3, "plan"), "非 belt rv≠0 → 拒绝（plan §2.2 迁移路径 4）", "rotationVariant");
        const b4 = clone(planRaw); const belt4 = b4.entities.filter(e => e.kind === "belt")[2];
        belt4.inDir = "left";                                   // r=0 的带子入口恒在 bottom
        throws(() => assertCompiledPlan(b4, "plan"), "带子 inDir 与 r 不自洽 → 拒绝", "rot");
        const b5 = clone(planRaw); const belt5 = b5.entities.find(e => e.kind === "belt"); belt5.inDir = belt5.outDir;
        throws(() => assertCompiledPlan(b5, "plan"), "带子 inDir===outDir → 拒绝（belt-rules.mjs:43）", "inDir !== outDir");

        /* ── 产出分层顺序（§2.1 硬规定 + 陷阱表 #6：机器 → 直线 → 拐角） ── */
        const o1 = clone(planRaw);
        o1.entities = [...o1.entities].sort((x, y) => (x.kind === "belt" ? -1 : 1) - (y.kind === "belt" ? -1 : 1));
        throws(() => assertCompiledPlan(o1, "plan", { entityOrder: "strict" }), "带子排在机器之前 → 违反分层顺序", "entities");
        eq(assertCompiledPlan(o1, "plan", { entityOrder: "off" }).entities.length, o1.entities.length, "entityOrder:off 可显式关闭（调用方知情）");

        /* ── 同格唯一性 ── */
        const d1 = clone(planRaw); d1.entities[1].dx = d1.entities[0].dx; d1.entities[1].dy = d1.entities[0].dy;
        throws(() => assertCompiledPlan(d1, "plan"), "两实体同格 → 拒绝（与 grid 同格二次 set 同源）", "占用");

        /* ── stats 自洽 ── */
        const s1 = clone(planRaw); s1.stats.beltTiles += 1;
        throws(() => assertCompiledPlan(s1, "plan"), "stats.beltTiles 与 entities 不符 → 拒绝", "beltTiles");
        const s2 = clone(planRaw); s2.stats.corners = 9;
        throws(() => assertCompiledPlan(s2, "plan"), "stats.corners 与 rv≠0 带子数不符 → 拒绝", "corners");
        const s3 = clone(planRaw); s3.stats.bbox = [9, 9];
        throws(() => assertCompiledPlan(s3, "plan"), "stats.bbox 与 entities 跨度不符 → 拒绝", "bbox");

        /* ── ValidatorReport 的 §2.4 硬规定 ── */
        const v1 = clone(valRaw); v1.beltSim.includesMachineNeighbors = false;
        throws(() => assertValidatorReport(v1, "v"), "includesMachineNeighbors 必须 true（redteam:144）", "includesMachineNeighbors");
        const v2 = clone(valRaw); v2.pass = true;
        throws(() => assertValidatorReport(v2, "v"), "pass 必须 === (errors.length===0)", "pass");
        const v3 = clone(valRaw); v3.checks[0].id = "V11-something";
        throws(() => assertValidatorReport(v3, "v"), "check id 枚举外 → 拒绝", "id");
        const v4 = clone(valRaw); v4.checks[0].status = "maybe";
        throws(() => assertValidatorReport(v4, "v"), "status 枚举外 → 拒绝", "status");
        const v5 = clone(valRaw);
        v5.errors = []; v5.pass = true; v5.beltSim.drift = []; v5.beltSim.fixedPoints = v5.beltSim.tilesChecked;
        v5.checks = v5.checks.map(c => c.status === "fail" ? { ...c, status: "pass" } : c);
        ok(assertValidatorReport(v5, "v").pass === true, "全 pass 的报告可通过（drift 也要清空）");
        const v6 = clone(valRaw); v6.beltSim.drift = [{ cell: [0, 1], wantRv: 1, gotRv: 0 }];
        const v6b = { ...v6, checks: v6.checks.map(c => c.id === "V3-belt-fixed-point" ? { ...c, status: "pass" } : c) };
        throws(() => assertValidatorReport(v6b, "v"), "drift 非空却 V3:pass → 拒绝（防 rv 漂移）", "drift");

        /* ── WorldState（§2.6）往返 ── */
        const wsRaw = {
            tick: 1234, seed: 43391, hub: { x: 1198, y: -1384 },
            goal: { level: 2, shape: "----CuCu", required: 20, delivered: 0 },
            upgradeLevels: { belt: 0, miner: 0, processors: 0, painting: 0 },
            entities: [{ uid: 12, type: "belt", x: 5, y: 6, r: 0, variant: "default", rotationVariant: 0, code: 1, layer: "regular" }],
            resources: [[1198, -1384, "CuCuCuCu"]],
            replaceableBeltCells: ["5,6"],
        };
        const ws = assertWorldState(wsRaw);
        ok(ws.replaceableBeltCells instanceof Set, "replaceableBeltCells 归一为 Set");
        const wsJSON = worldStateToJSON(ws);
        ok(Array.isArray(wsJSON.replaceableBeltCells), "worldStateToJSON → 数组（可落盘）");
        assertWorldState(normalizeWorldState(JSON.parse(JSON.stringify(wsJSON))));
        ok(true, "WorldState JSON 往返再 assert 通过");
        const wsBad = clone(wsRaw); wsBad.entities[0].code = 3;
        throws(() => assertWorldState(wsBad), "obs 里 belt 的 code≠1+rv → 拒绝", "code");
        const wsBad2 = clone(wsRaw); wsBad2.entities.push({ uid: 13, type: "belt", x: 9, y: 9, r: 0, variant: "default", rotationVariant: 0, code: 1, layer: "regular" });
        throws(() => assertWorldState(wsBad2), "既有带格未进 replaceableBeltCells → 拒绝（V2 无从判定）", "replaceableBeltCells");
        const wsBad3 = clone(wsRaw); delete wsBad3.upgradeLevels.painting;
        throws(() => assertWorldState(wsBad3), "缺 upgradeLevels.painting → 报字段名", "painting");
        const wsEmpty = { ...clone(wsRaw), entities: [], replaceableBeltCells: [] };
        ok(assertWorldState(wsEmpty).entities.length === 0, "全新址（entities 空）通过");

        /* ── planVsReplaceableWorld（C1 原语：V2 的零重叠判定） ── */
        const hitCell = a1.entities.find(e => e.kind === "belt");
        const clash = planVsReplaceableWorld(a1, new Set([`${hitCell.dx},${hitCell.dy}`]));
        eq(clash.length, 1, "planVsReplaceableWorld 命中 1 格");
        ok(clash[0].reason.includes("静默"), "冲突理由点名「静默销毁」");
        eq(planVsReplaceableWorld(a1, []).length, 0, "零重叠时无冲突（P5 的 V2 判据）");
        eq(planVsReplaceableWorld(a1, a1.entities.map(e => `${e.dx},${e.dy}`)).length, a1.entities.length, "整片被既有带占据 → 全格冲突");

        /* ── rotateLocalSlot / entityOrderPhase 语义 ── */
        eq(entityOrderPhase({ kind: "miner" }), 0, "phase: 机器=0");
        eq(entityOrderPhase({ kind: "belt", rotationVariant: 0 }), 1, "phase: 直线带=1");
        eq(entityOrderPhase({ kind: "belt", rotationVariant: 1 }), 2, "phase: 拐角带=2");

        /* 导入 lint（L0 §1.1-3）不在这里自扫源码：权威判据在
           research/ai-plan/contract/lint-imports.mjs（词法级）+ test.mjs（全目录）。
           库文件正文里必须提到 proto/belt-rules 才能写清禁令，自扫会误报。 */
        console.log(fails ? `types.mjs: ${fails} 条失败` : "types.mjs: 全部通过");
        if (fails) process.exitCode = 1;
    }
}
