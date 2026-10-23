/**
 * errors.mjs — 编译器规范化失败对象（P1 contract 独占）。
 *
 * 契约来源：
 *   research/ai-player/plan-compiler.md §2.5（reason 枚举，逐字照抄）
 *   §2.4（check id 枚举 V1..V10 + S1）
 *   §2（方向/角度约定：字符串 dir，y 向下；角度 0/90/180/270）
 *   DESIGN:114 + redteam:158 —— 编译管线**永不 throw**，失败一律走
 *   {ok:false, reason, failingNode, hint}；任何 error 都必须让 ok:false 且 blueprint:null。
 *
 * 本模块自身不抛「业务失败」，只抛 ContractViolation（= 有人写错类型，属于 L0 单测要抓的 bug）。
 *
 * 零依赖：只有 ESM + node: 内置。禁止 import proto/belt-rules.mjs（已知错误副本）。
 */

/** 方向名（与 src/ai/belt-rules.mjs:16 ORDER 一致，y 向下）。 */
export const DIR_NAMES = Object.freeze(["top", "right", "bottom", "left"]);

/** 方向 → 角度（= ORDER 索引 × 90，与 belt-rules.mjs:22 dirToAngle 同值）。 */
export const DIR_ANGLES = Object.freeze({ top: 0, right: 90, bottom: 180, left: 270 });

export const isDirName = d => DIR_NAMES.includes(d);
export const isAngle = a => a === 0 || a === 90 || a === 180 || a === 270;

/* ───────────────────────────── §2.5 失败原因枚举 ───────────────────────────── */

/** plan §2.5 的固定枚举（逐字照抄，顺序与 plan 一致；不含参数化项 validate:<Vn>）。 */
export const FAILURE_REASONS = Object.freeze([
    "dag-not-placeable:crossing-needs-tunnel",
    "dag-not-placeable:fanin>2",
    "dag-not-placeable:column-conflict-unresolved",
    "out-of-scope:multilayer",
    "out-of-scope:wire",
    "out-of-scope:tunnel",
    "out-of-scope:rotated-machine",
    "no-resource-in-range",
    "no-site-large-enough",
    "throughput:stacker-bottleneck",
    "belt-turn-unsolvable",
    "unlock:machine-not-available",
    "emit:mismatch",
    "live:paste-rejected-2002",
    "live:await-timeout",
    "live:intent-diff",
]);

/** 参数化形式 `validate:<Vn>`（plan 把它列在枚举里，实际值由 V1..V10 代入，见 CONTEST）。 */
export const VALIDATE_REASON_TEMPLATE = "validate:<Vn>";
export const REASON_PREFIX_VALIDATE = "validate:";

/** §2.4 check id 枚举（V1..V10 + S1）。 */
export const CHECK_IDS = Object.freeze([
    "V1-occupancy",
    "V2-no-overwrite-existing-belt",
    "V3-belt-fixed-point",
    "V4-slot-alignment",
    "V5-degree",
    "V6-crossing",
    "V7-throughput",
    "V8-scope",
    "V9-unused-outlet",
    "V10-unlock-report",
    "S1-shape-replay",
]);

/** check 的短号（"V1-occupancy" → "V1"），用于 validate:<Vn> 代入。 */
export const checkShortId = id => (typeof id === "string" ? id.split("-")[0] : id);

/**
 * reason 是否合法：固定枚举之一，或 validate:<Vn>（Vn 取 §2.4 的 check id 或其短号）。
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isFailureReason(reason) {
    if (typeof reason !== "string") return false;
    if (FAILURE_REASONS.includes(reason)) return true;
    if (!reason.startsWith(REASON_PREFIX_VALIDATE)) return false;
    const vn = reason.slice(REASON_PREFIX_VALIDATE.length);
    if (!vn) return false;
    return CHECK_IDS.some(id => id === vn || checkShortId(id) === vn);
}

/**
 * 由 check id 造 `validate:<Vn>` reason（代入短号，与 plan 的 `validate:<Vn>` 写法一致）。
 * @param {string} checkId
 */
export function validateReason(checkId) {
    return REASON_PREFIX_VALIDATE + checkShortId(checkId);
}

/* ───────────────────────────── 规范化失败对象 ───────────────────────────── */

/**
 * 规范化 failingNode：{nodeId, cell:[x,y], check}。允许传 null（顶层失败无归因）。
 * @param {{nodeId?:string, cell?:[number,number], check?:string}|null|undefined} node
 */
function normFailingNode(node) {
    if (node == null) return null;
    if (typeof node !== "object" || Array.isArray(node)) throw new ContractViolation("failingNode", "object|null", node);
    const cell = node.cell == null ? null : [assertInt(node.cell[0], "failingNode.cell[0]"), assertInt(node.cell[1], "failingNode.cell[1]")];
    return {
        nodeId: typeof node.nodeId === "string" ? node.nodeId : "",
        cell,
        check: typeof node.check === "string" ? node.check : "",
    };
}

/**
 * 造规范化失败对象 —— P8/P3/P4/P5/P6 失败时的唯一出口（永不 throw 的管线用它 return）。
 * reason 不在 §2.5 枚举内 → 抛 ContractViolation（programmer error，不是业务失败）。
 *
 * @param {string} reason §2.5 枚举值或 validate:<Vn>
 * @param {{nodeId:string, cell?:[number,number], check?:string}|null} [failingNode]
 * @param {string} [hint] 给 LLM/人读的修复建议
 * @returns {{ok:false, reason:string, failingNode:{nodeId:string, cell:[number,number]|null, check:string}|null, hint:string|null}}
 */
export function makeFailure(reason, failingNode = null, hint = null) {
    if (!isFailureReason(reason)) {
        throw new ContractViolation("reason", "one of FAILURE_REASONS 或 validate:<Vn>（见 plan §2.5）", reason);
    }
    return {
        ok: false,
        reason,
        failingNode: normFailingNode(failingNode),
        hint: hint == null ? null : String(hint),
    };
}

/**
 * 断言一个对象是合法规范化失败对象（ok 必须为 false、reason 必须在枚举内）。
 * @template T
 * @param {T} obj
 * @param {string} [path]
 * @returns {T}
 */
export function assertFailure(obj, path = "failure") {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new ContractViolation(path, "object", obj);
    if (obj.ok !== false) throw new ContractViolation(path + ".ok", "false（失败对象的 ok 恒为 false）", obj.ok);
    if (!isFailureReason(obj.reason)) throw new ContractViolation(path + ".reason", "§2.5 枚举 reason", obj.reason);
    if (obj.failingNode !== null && (typeof obj.failingNode !== "object" || Array.isArray(obj.failingNode))) {
        throw new ContractViolation(path + ".failingNode", "{nodeId,cell,check}|null", obj.failingNode);
    }
    if (obj.hint !== null && typeof obj.hint !== "string") throw new ContractViolation(path + ".hint", "string|null", obj.hint);
    return obj;
}

export function isCheckId(id) { return CHECK_IDS.includes(id); }

/* ───────────────────────────── 结构化契约错误 ───────────────────────────── */

/**
 * 契约违反：某个字段缺失/类型不对/取值在枚举之外。
 * message 一定带**字段路径**，满足「缺字段 → 结构化错误且不静默」（L0 §1.1-2）。
 *
 * 用法约定：`throw new ContractViolation("entities[3].outDir", "DirName|null", "up")`
 * 一次校验可聚合多条错误：errors[] 里 push 更多 ContractViolation。
 */
export class ContractViolation extends Error {
    /**
     * @param {string} path 字段路径，如 "plan.entities[3].outDir"
     * @param {string} rule 违反的规则（人读，含期望取值）
     * @param {unknown} got 实际值
     */
    constructor(path, rule, got) {
        super(`契约违反 ${path}: 期望 ${rule}，实得 ${render(got)}`);
        this.name = "ContractViolation";
        /** 结构化字段：便于测试断言与 LLM 分诊 */
        this.path = path;
        this.rule = rule;
        this.got = got;
        /** 聚合的额外错误（同一次 assert 里的其它问题） */
        this.aggregated = [];
    }

    /** 把所有错误（含聚合）拼成多行文本 @returns {string} */
    get allMessages() {
        return [this.message, ...this.aggregated.map(e => e.message)].join("\n");
    }

    /** @param {ContractViolation} e @returns {this} */
    add(e) { this.aggregated.push(e); return this; }
}

/** 值的短渲染（进错误消息，避免超长） */
function render(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v.length > 60 ? v.slice(0, 57) + "..." : v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Set) return `Set(${v.size})`;
    if (Array.isArray(v)) return JSON.stringify(v.length > 12 ? v.slice(0, 12) : v);
    if (typeof v === "object") {
        try {
            const s = JSON.stringify(v);
            if (s === undefined) return String(v);
            return s.length > 120 ? s.slice(0, 117) + "..." : s;
        } catch { return String(v); }
    }
    return String(v);
}
export { render as renderValue };

/* ───────────────────────────── 共享小断言（types/grid 都用） ───────────────────────────── */

export function assertInt(v, path) {
    if (typeof v !== "number" || !Number.isInteger(v)) throw new ContractViolation(path, "整数", v);
    return v;
}

/** [x,y] 整数对（Cell2） */
export function assertCell(v, path) {
    if (!Array.isArray(v) || v.length !== 2) throw new ContractViolation(path, "[x,y] 二元数组", v);
    return [assertInt(v[0], path + "[0]"), assertInt(v[1], path + "[1]")];
}

/** [w,h] 正整数对 */
export function assertWH(v, path) {
    if (!Array.isArray(v) || v.length !== 2) throw new ContractViolation(path, "[w,h] 二元数组", v);
    const w = assertInt(v[0], path + "[0]"), h = assertInt(v[1], path + "[1]");
    if (w < 1 || h < 1) throw new ContractViolation(path, "w>=1 且 h>=1", v);
    return [w, h];
}

/** 存在性检查：字段缺失（undefined / null 且规则要求非空）→ 结构化错误 */
export function req(obj, key, path) {
    if (obj == null || typeof obj !== "object") throw new ContractViolation(path, "object", obj);
    if (!(key in obj)) throw new ContractViolation(`${path}.${key}`, "字段必须存在", obj[key]);
    const v = obj[key];
    if (v === undefined || v === null) throw new ContractViolation(`${path}.${key}`, "非空值", v);
    return v;
}

/** 逐个检查对象上的必需 key（值可为 null，但 key 必须存在） */
export function requireKeys(obj, keys, path) {
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) throw new ContractViolation(path, "object", obj);
    const missing = keys.filter(k => !(k in obj));
    if (missing.length) throw new ContractViolation(`${path}`, `必需字段 [${keys.join(", ")}]`, { missing });
    return obj;
}

/** 枚举取值检查 */
export function oneOf(v, allowed, path, { nullable = false } = {}) {
    if (nullable && (v === null || v === undefined)) return v;
    if (!allowed.includes(v)) throw new ContractViolation(path, `取值 ∈ [${allowed.join(" | ")}]${nullable ? " | null" : ""}`, v);
    return v;
}

/* ───────────────────────── 测试入口：node src/ai/compiler/errors.mjs --test ───────────────────────── */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/errors.mjs")) {
    let fails = 0;
    const eq = (got, want, m) => {
        const A = JSON.stringify(got), B = JSON.stringify(want);
        if (A === B) console.log("✓ " + m);
        else { fails++; console.log(`✗ ${m}  got=${A} want=${B}`); }
    };
    const throws = (fn, m) => { try { fn(); fails++; console.log(`✗ ${m} 未抛错`); } catch (e) { console.log(`✓ ${m}（${e.name}）`); } };

    eq(FAILURE_REASONS.length, 16, "§2.5 固定枚举 16 项（validate:<Vn> 为参数化模板，见 CONTEST）");
    eq(CHECK_IDS.length, 11, "§2.4 check id 11 项（V1..V10 + S1）");
    eq(isFailureReason("dag-not-placeable:fanin>2"), true, "枚举内 reason 合法");
    eq(isFailureReason("validate:V3"), true, "validate:<Vn> 短号形式合法");
    eq(isFailureReason("validate:V3-belt-fixed-point"), true, "validate:<Vn> 全长形式合法");
    eq(isFailureReason("validate:V99"), false, "未知 Vn 拒绝");
    eq(isFailureReason("nope"), false, "枚举外 reason 拒绝");
    eq(isFailureReason(null), false, "null reason 拒绝");
    eq(validateReason("V3-belt-fixed-point"), "validate:V3", "check id → validate 短号");
    eq(makeFailure("emit:mismatch").ok, false, "makeFailure 的 ok 恒为 false");
    eq(makeFailure("no-site-large-enough", { nodeId: "n1", cell: [3, 4], check: "V1-occupancy" }).failingNode,
        { nodeId: "n1", cell: [3, 4], check: "V1-occupancy" }, "failingNode 规范化");
    eq(makeFailure("no-site-large-enough").failingNode, null, "failingNode 可缺省为 null");
    eq(makeFailure("no-site-large-enough", { nodeId: "n1" }).failingNode.cell, null, "failingNode.cell 可缺省");
    throws(() => makeFailure("reason-not-in-enum"), "非法 reason → ContractViolation");
    throws(() => assertFailure({ ok: true, reason: "emit:mismatch", failingNode: null, hint: null }), "assertFailure 要求 ok===false");
    eq(assertFailure(makeFailure("emit:mismatch")).ok, false, "assertFailure 放行合法失败");
    eq(isDirName("top"), true, "isDirName top");
    eq(isDirName("up"), false, "isDirName up 拒绝");
    eq(isAngle(90), true, "isAngle 90");
    eq(isAngle(45), false, "isAngle 45 拒绝");
    eq(assertCell([1, -2], "c"), [1, -2], "assertCell 通过");
    throws(() => assertCell([1, 2, 3], "c"), "assertCell 长度≠2 抛错");
    throws(() => assertCell([1, 1.5], "c"), "assertCell 非整数抛错");
    throws(() => assertWH([0, 1], "wh"), "assertWH w=0 抛错");
    throws(() => requireKeys({ a: 1 }, ["a", "b"], "o"), "requireKeys 缺字段 → 带字段名的错误");
    eq(DIR_ANGLES.left, 270, "角度约定 left=270（belt-rules:13 ORDER×90）");

    if (fails) { console.log(`errors.mjs: ${fails} 条失败`); process.exitCode = 1; }
    else console.log("errors.mjs: 全部通过");
}
