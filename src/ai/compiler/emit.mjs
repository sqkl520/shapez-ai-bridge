/**
 * emit.mjs — SZBP1 发射器（P6 emitter，plan-compiler.md §1.6）
 *
 * 输入 = 已过闸的 CompiledPlan（**必须** plan.ok === true 且 plan.validation.pass === true），
 * 输出 = 蓝图字符串 + 逐格 beltIntent（P7 实机对拍的唯一凭据，redteam:155）。
 *
 * 三条不可协商的出口纪律
 *   1. 任何闸不过 → `{ok:false, blueprint:null, beltIntent:[], reason, failingNode, hint}`，
 *      **绝不产出会堵死的蓝图**（plan §2.1 硬规定 / redteam:158）。永不 throw（契约级异常也归一成
 *      结构化失败），因为 P8 的顶层签名规定「永不 throw；失败走 {ok:false,reason,...}」。
 *   2. belt 格 code 一律 `beltCode(rv)`（`src/ai/belt-rules.mjs:59`，1906/1906 实机；唯一权威），
 *      机器格一律 `codeFor(building, variant, r=0, rv=0)`（`src/ai/op-templates.mjs:504`）。
 *      **手填 magic number 在本文件里不存在**：每个 code 都是现算 + 与 plan.entities 对拍。
 *   3. entities 顺序 = 蓝图内顺序 = 机器 → 直线带 → 拐角（plan §2.1 硬规定 / 陷阱表 #6 /
 *      `proto/layout-merge.mjs:96-127` 的分层）。排序函数在 `orderEntities()`，L1 门用
 *      「把拐角挪到直线前」的反例锁住它。
 *
 * 锚点归一（compiler-constraints C1 + plan §2.1）
 *   世界格 = site.anchor + [dx,dy] → w = 世界格的 min corner = [minx,miny]，
 *   发射时 dx' = x - minx、dy' = y - miny（**非负**）。这样 `paste_blueprint{x,y}` 直接填
 *   `anchor` 就复原设计（与 mod 的 export_blueprint 同式，`shapez-ai-bridge.js:1467-1477`），
 *   也与 P7 的 kit.buildBlueprint / pasteAndDiff 口径一致。plan 原 dx/dy 未归一（min≠0）时
 *   这里负责归一，并保证 site.anchor + 原 dx === w + 新 dx。
 *
 * 输出形状（`emitPlan` 的成功分支）
 *   {ok:true, blueprint:"SZBP1.…", gv, anchor:[minx,miny]（= paste 的 x,y）, siteAnchor,
 *    entities:[…归一后的 §2.1 entities], beltIntent:[{index,nodeId,instanceIdx,kind,x,y,dx,dy,
 *      rotation,rotationVariant,code,inDir,outDir,isCorner,phase}], count, stride:4,
 *    cost / blueprintCost, chargeMode:"false", beltTiles, corners, bbox, warnings:[…], plan（完整
 *    CompiledPlan，blueprint 已填真串）, reason:null, failingNode:null, hint:null}
 *   失败分支一律 rejectEmit(...)：{ok:false, stage:"emit", blueprint:null, beltIntent:[],
 *   reason（§2.5）, failingNode{nodeId,cell,check}, hint, gate, path, got, sourceReason}
 *
 * 已知缺口（stride=4 不存 originalRotation，C2 / 红队 #3a）：治本方案写在
 *   `research/ai-plan/emitter/NOTES.md`，**本文件不动 `src/shared/blueprint.mjs`**（plan §3 禁改清单）。
 *
 * 零依赖：ESM + node: 内置 + 仓库内已批准的只读模块。不 import P3/P4/P5/P8 的实现（防环 + 骨架未落地），
 *   只用 P1 的类型与断言、P2 的 code 真值、belt-rules 的方向真值、shared/blueprint 的容器层。
 * 自测：`node src/ai/compiler/roundtrip.mjs --test`（L1 门；本文件的 --test 只跑最小烟测）
 */

import {
    assertCompiledPlan,
    entityOrderPhase,
    BLUEPRINT_PREFIX,
    BLUEPRINT_STRIDE,
    GAME_VERSION,
} from "./types.mjs";
import { ContractViolation, CHECK_IDS, isFailureReason, makeFailure, validateReason } from "./errors.mjs";
import { beltCode, beltEntry, beltExit } from "../belt-rules.mjs";
import { computeBelt } from "./belt-sim.mjs";
import { encodeBlueprint, decodeBlueprint, blueprintCost } from "../../shared/blueprint.mjs";

/** 角度归一（局部工具；belt-rules 的 norm360 未被本文件引入） */
const norm360 = a => ((a % 360) + 360) % 360;

/* ───────────────────────────── P2 的装载（一处必要的绕行） ─────────────────────────────
 * `src/ai/op-templates.mjs:1165` 的自测判据是 **argv 里有 --test**（`process.argv.slice(2).includes("--test")`），
 * 而不是像 P1/belt-rules 那样按「被直接运行的文件名」判据。后果：本包的 L1 门 CLI
 *   `node src/ai/compiler/roundtrip.mjs --test`
 * 会把 P2 的自测输出（实测 175 行）灌进 stdout、并把 `process.exitCode` 设成 P2 的结果 ——
 * L1 门的退出码与「谁失败了」的归因就都不是 P6 的了（ADVERSARIAL:31-40 的 result-vs-文档教训同源）。
 *
 * 处置：**不改 P2 的文件**（所有权在 P2，plan §3 冲突仲裁），只在 import 期间临时摘掉
 * `--test`/`--gaps`，装载完原样恢复。缺陷与修法建议登记在
 * `research/ai-plan/emitter/NOTES.md`（G-P2-argv-guard），交主线程裁决。 */
async function loadP2() {
    const saved = process.argv.slice();
    for (const flag of ["--test", "--gaps"]) {
        let i = process.argv.indexOf(flag);
        while (i >= 0) { process.argv.splice(i, 1); i = process.argv.indexOf(flag); }
    }
    try {
        return await import("../op-templates.mjs");
    } finally {
        process.argv.length = 0;
        process.argv.push(...saved);
    }
}
const P2 = await loadP2();
export { P2 };
const codeFor = P2.codeFor;
const templateForBuildingCode = P2.templateForBuildingCode;
const assertV1Rotation = P2.assertV1Rotation;

/* ═══════════════════════════════ 常量 / 词汇 ═══════════════════════════════ */

/** 本包所在管线阶段（P8 的分诊字段） */
export const EMIT_STAGE = "emit";

/** 拒发射的闸门名（进 failure.gate 与 failingNode.check，便于 P8 归因） */
export const EMIT_GATES = Object.freeze({
    PLAN_OK: "emit:plan-not-ok",
    VALIDATION: "emit:validation-not-pass",
    CODE: "emit:code-mismatch",
    ORDER: "emit:entity-order",
    CELL_CONFLICT: "emit:cell-conflict",
    CONTRACT: "emit:contract-violation",
});

/**
 * 「等发射」的蓝图占位串。
 * §2.1 规定 ok:true 的 plan 必须带非空 blueprint，但 blueprint **正是发射的产物** ——
 * 所以发射前入参要么带真串（重发射/自检），要么带这个哨兵。它只在**入参校验**期间存在，
 * 出参永远是真串（哨兵绝不会被写进返回值，见 `PENDING_BLUEPRINT` 的使用点）。
 */
export const PENDING_BLUEPRINT = BLUEPRINT_PREFIX + "pending-emit";

/* ═══════════════════════════════ 结构化拒发射 ═══════════════════════════════ */

/**
 * 归一化一条拒发射结果：blueprint 恒 null、beltIntent 恒空数组。
 * @param {string} reason §2.5 枚举值（或 validate:<Vn>）
 * @param {{gate?:string, check?:string, nodeId?:string|null, cell?:[number,number]|null,
 *          hint?:string|null, path?:string, got?:unknown, plan?:object}} [info]
 * @returns {{ok:false, stage:string, blueprint:null, beltIntent:[], reason:string,
 *            failingNode:{nodeId:string, cell:[number,number]|null, check:string}, hint:string|null}}
 */
export function rejectEmit(reason, info = {}) {
    const node = {
        nodeId: info.nodeId ?? null,
        cell: info.cell ?? null,
        check: info.check ?? info.gate ?? EMIT_GATES.CONTRACT,
    };
    const hint = info.hint ?? null;
    // makeFailure 会校验 reason ∈ §2.5（不在则抛 ContractViolation = 程序错误）
    const base = makeFailure(reason, node, hint);
    return {
        ok: false,
        stage: EMIT_STAGE,
        blueprint: null,
        beltIntent: [],
        ...base,
        /** 附加凭据：哪道闸、字段路径、实得值（人/LLM 修复层读这个，不靠 message 猜） */
        gate: info.gate ?? null,
        path: info.path ?? null,
        got: info.got === undefined ? null : info.got,
        /** 上游 plan 自己的 reason（若与本次不同），P8 追溯用 */
        sourceReason: info.plan && typeof info.plan.reason === "string" ? info.plan.reason : null,
    };
}

/** 从 ValidatorReport 的第一条 fatal error 造 `validate:<Vn>` reason（§2.5 的参数化形式） */
function validateReasonFrom(report) {
    const errs = report && Array.isArray(report.errors) ? report.errors : [];
    const fatal = errs.find(e => e && e.severity === "fatal") || errs[0];
    const check = fatal && typeof fatal.check === "string" ? fatal.check : null;
    if (!check) return "emit:mismatch";
    try { return validateReason(check); }      // "V9-unused-outlet" → "validate:V9"
    catch { return "emit:mismatch"; }
}

/* ═══════════════════════════════ 顺序锁（§2.1 硬规定） ═══════════════════════════════ */

/**
 * entities 的执行顺序 = 机器(0) → 直线带(1) → 拐角带(2)。
 * 相位取自 P1 的 `entityOrderPhase`（单一真源，本文件不另立分类），相位相同**保持入参相对次序**
 * （稳定排序 —— 直线段按 P4 产出的沿流次序保留，拐角按通道次序保留）。
 *
 * 为什么要显式排序：§2.1 把「entities 顺序即执行顺序」写成硬规定，而 P3/P4 的产物是分两次
 * 追加的（`place_path` 降级通道同样依赖这个次序）。发射是唯一把两者拼成一张扁平表的地方，
 * 拼完必须保证单调，否则 `place_path`/粘贴次序就错了（陷阱表 #6：拐角先放 → 邻居未齐 → rv 算歪）。
 *
 * @param {Array<object>} entities @returns {object[]} 新数组（不改入参）
 */
export function orderEntities(entities) {
    if (!Array.isArray(entities)) throw new TypeError("orderEntities: 需要数组，实得 " + typeof entities);
    const tagged = entities.map((e, i) => ({ e, i, phase: entityOrderPhase(e) }));
    tagged.sort((a, b) => (a.phase - b.phase) || (a.i - b.i));   // (b.i - a.i) 兜住 sort 不稳定
    return tagged.map(t => t.e);
}

/** 单调性检查（orderEntities 的自检，也是 L1 门「顺序锁」的判据函数）
 *  @returns {{ok:boolean, violations:Array<{index:number, phase:number, prev:number}>}} */
export function checkEntityOrder(entities) {
    const violations = [];
    let prev = -1;
    entities.forEach((e, i) => {
        const phase = entityOrderPhase(e);
        if (phase < prev) violations.push({ index: i, phase, prev });
        prev = Math.max(prev, phase);
    });
    return { ok: violations.length === 0, violations };
}

/* ═══════════════════════════════ code 现算（不用 plan 里的值） ═══════════════════════════════ */

/**
 * belt 格：code = beltCode(rv)。同时用 P2 的 codeFor("belt",...) 走第二遍，两个入口必须同值
 * （belt-rules 是权威、op-templates 是解码器，二者漂移 = 硬证据，见 NOTES「双 code 源」）。
 * @returns {{ok:true, code:number} | {ok:false, reason:string, check:string, detail:string}}
 */
function resolveBeltCode(e) {
    const want = beltCode(e.rotationVariant);
    if (e.code !== want) {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `belt 格 code=${e.code} 而 beltCode(rv=${e.rotationVariant})=${want}` };
    }
    let viaP2;
    try {
        viaP2 = codeFor("belt", "default", e.rot, e.rotationVariant);
    } catch (err) {
        return { ok: false, reason: specReason(err), check: EMIT_GATES.CODE, detail: `codeFor(belt) 抛错：${err && err.message}` };
    }
    if (viaP2 !== want) {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `belt 双 code 源漂移：beltCode=${want} codeFor=${viaP2}` };
    }
    return { ok: true, code: want };
}

/** belt 方向自洽：(rot,rv) 反推 entry/exit，必须等于 plan 声明的 inDir/outDir */
function checkBeltDirections(e) {
    const entry = beltEntry(e.rotationVariant, e.rot);
    const exit = beltExit(e.rotationVariant, e.rot);
    if (entry !== e.inDir) return `entry(r=${e.rot})=${entry} 而 inDir=${e.inDir}`;
    if (exit !== e.outDir) return `exit(r=${e.rot},rv=${e.rotationVariant})=${exit} 而 outDir=${e.outDir}`;
    if (e.inDir === e.outDir) return `inDir===outDir（不是带子该有的形态）`;
    return null;
}

/** P2 的 SpecError → §2.5 reason（透传，但**规范化 `validate:<Vn>` 的形式**）
 *
 * P1 的 `errors.mjs:74-81` 同时接受长号 `validate:V8-scope` 与短号 `validate:V8`，而它自己在
 * CONTEST C-2 里建议「规范形式 = 短号，长号只作容错读入」—— 因为 P8 的分诊表要做等值比较。
 * `op-templates.mjs:62` 的 SpecError **默认 reason** 恰是长号 `validate:V8-scope`
 * （`opByName()` 也在显式用它），所以从 P2 透传上来的串必须折成短号再出口。
 * 实测（NOTES「P2 reason 与 §2.5」）：12 处 `new SpecError` 里只有 `opByName` 走长号，
 * P6 不调它 ⇒ 正常路径碰不到；但**默认参数**意味着 P2 以后新增的抛错会随手带出长号，
 * 所以这里做无条件归一，而不是赌上游不产生。 */
function specReason(err) {
    const r = err && err.reason;
    if (typeof r !== "string") return "emit:mismatch";
    if (r.startsWith("validate:") && CHECK_IDS.includes(r.slice("validate:".length))) {
        return validateReason(r.slice("validate:".length));       // "validate:V8-scope" → "validate:V8"
    }
    return isFailureReason(r) ? r : "emit:mismatch";
}
/** 导出版（给 L1 门用真实 P2 错误对象测这条归一；本包内部一律走 specReason） */
export const normalizeP2Reason = specReason;

/**
 * 机器格：非 belt 一律 rv=0、r=0（H2/H3/D1）。P2 的 codeFor 是**第一道**判据：
 * 请求 rv≠0 时它抛 SpecError → 这里透传它的 reason（L1 门第 3 条走的就是这条路径）。
 * ⚠️ 本包**不提供** allowNonBeltRv 之类的口子：P2 的 `gatePlan` 前置（preflightP2Assertions）
 *    已经把 rv≠0 挡在门外，而 code 是 `codeFor(...,r=0,rv=0)` 现算的 —— 若一边放行 rv≠0、
 *    一边仍按 rv=0 出 code，产出的就是「意图与 code 不符」的蓝图，比拒绝危险得多。
 *    将来 RV_ALLOWED 若扩容，要同时改这里的 code 计算口径（带 rv 参数），由主线程裁决。
 * @returns {{ok:true, code:number, building:string, variant:string}
 *          | {ok:false, reason:string, check:string, detail:string}}
 */
function resolveMachineCode(e) {
    const tpl = templateForBuildingCode(e.code);
    if (!tpl) {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `code=${e.code} 在 OP_TEMPLATES 里反查不到建筑（P6 必须能自证 code↔kind，不依赖游戏注册表）` };
    }
    if (tpl.kind !== e.kind) {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `code=${e.code} 解出 kind=${tpl.kind}，plan 声明 kind=${e.kind}` };
    }
    if (tpl.building === "belt") {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `非 belt kind=${e.kind} 却解出 building=belt` };
    }
    // H2：非 belt 只出 rv=0。**没有** allowNonBeltRv 之类的口子 —— 下面算 code 用的是
    // codeFor(...,rv=0)，若此处放行 rv≠0 就会产出「意图带 rv、code 却是 rv=0」的蓝图（比拒绝危险）。
    // gatePlan 的 preflightP2Assertions 已经先拒过一次，这里是第二道（防 opts 组合出来的旁路）。
    if (e.rotationVariant !== 0) {
        // 故意把 offending rv 交给 P2 —— 让它给出权威的「不存在该 code」判定与分诊串
        try {
            codeFor(tpl.building, tpl.variant, e.rot, e.rotationVariant);
        } catch (err) {
            return { ok: false, reason: specReason(err), check: EMIT_GATES.CODE, detail: `P2 断言透传：${err && err.message}` };
        }
        return { ok: false, reason: "out-of-scope:rotated-machine", check: EMIT_GATES.CODE, detail: `${tpl.building} rv=${e.rotationVariant}（v1 只出 rv=0）` };
    }
    try {
        // D1：机器 rot 恒 0（trash/hub 连「能不能转」都不给，上游 getIsRotateable=false）
        assertV1Rotation(tpl.building, e.rot);
    } catch (err) {
        return { ok: false, reason: specReason(err), check: EMIT_GATES.CODE, detail: `assertV1Rotation 抛错：${err && err.message}` };
    }
    let code;
    try {
        code = codeFor(tpl.building, tpl.variant, 0, 0);       // 任务书规定的调用形态
    } catch (err) {
        return { ok: false, reason: specReason(err), check: EMIT_GATES.CODE, detail: `codeFor 抛错：${err && err.message}` };
    }
    if (code !== e.code) {
        return { ok: false, reason: "emit:mismatch", check: EMIT_GATES.CODE, detail: `codeFor(${tpl.building},${tpl.variant},0,0)=${code} 而 plan 写的是 ${e.code}` };
    }
    return { ok: true, code, building: tpl.building, variant: tpl.variant };
}

/* ═══════════════════════════════ 主入口 ═══════════════════════════════ */

/**
 * 发射一个 CompiledPlan。
 *
 * @param {object} plan CompiledPlan（ok:true + validation.pass:true 才会产出蓝图；
 *        未发射过的入参可以把 blueprint 留成 null —— 内部用 PENDING_BLUEPRINT 占位过 §2.1 的
 *        「ok:true 必须有 blueprint」这一条，出参一定是真串）
 * @param {{entityOrder?:"strict"|"off"|"reorder", stages?:"required"|"nullable",
 *          gv?:string, ignoreInputBlueprint?:boolean}} [opts]
 *   entityOrder：默认 "strict"（不合 §2.1 就地拒）；"reorder" = 先按相位重排再校验（P8 逃生口，记 warning）；
 *               "off" 透传给 P1 的契约（调试用，会让出参也跳过顺序断言）。
 *   ignoreInputBlueprint：入参自带蓝图且与 entities 不符时，仍按 entities 重发射（默认拒）。
 * @returns {object} 成功：见文件头「输出」；失败：rejectEmit(...)
 */
export function emitPlan(plan, opts = {}) {
    /* ── 0. 显式修复模式：opts.entityOrder === "reorder" ──
     * 默认 strict：入参顺序不合 §2.1 就地拒（上游 bug 要在边界上响，不许被发射器悄悄抹平）。
     * "reorder" 是给 P8 的逃生口：按相位重排后**继续走全套校验**，并记 warning。
     * 为什么敢提供这个口子：orderEntities 是纯函数、按相位分桶，重排**不改变任何格子内容**
     * （同一 multiset），因此不可能把一张能跑的蓝图重排成会堵死的蓝图 —— 它只改执行次序，
     * 而执行次序恰恰是 §2.1 要求的那个子序。 */
    let working = plan;
    const preWarnings = [];
    if (opts.entityOrder === "reorder" && plan && Array.isArray(plan.entities)) {
        const before = checkEntityOrder(plan.entities);
        if (!before.ok) {
            working = { ...plan, entities: orderEntities(plan.entities) };
            preWarnings.push(`入参 entities 顺序不合 §2.1（违规位 ${before.violations.map(v => v.index).join(",")}），已按 opts.entityOrder="reorder" 重排`);
        }
    }

    const gated = gatePlan(working, opts);
    if (gated.ok === false) return gated;
    const p = gated.plan;

    /* ── 1. 执行顺序（§2.1 硬规定；闸里已经用 P1 的 strict 序校验过，这里再排一次保证幂等） ── */
    const ordered = orderEntities(p.entities);
    const ord = checkEntityOrder(ordered);
    if (!ord.ok) {
        const bad = ord.violations[0];
        return rejectEmit("emit:mismatch", {
            gate: EMIT_GATES.ORDER, path: `plan.entities[${bad.index}]`,
            nodeId: ordered[bad.index] && ordered[bad.index].nodeId, cell: null, got: ord.violations,
            hint: "orderEntities 之后仍非单调（内部不变量破了 —— 不要绕过 emit 直接编表）", plan: p,
        });
    }

    /* ── 2. 逐格 code 现算 + 方向自洽 ── */
    const codes = [];
    for (let i = 0; i < ordered.length; i++) {
        const e = ordered[i];
        const r = e.kind === "belt" ? resolveBeltCode(e) : resolveMachineCode(e);
        if (!r.ok) {
            return rejectEmit(r.reason, {
                gate: EMIT_GATES.CODE, path: `plan.entities[${i}]`, nodeId: e.nodeId,
                cell: [p.site.anchor[0] + e.dx, p.site.anchor[1] + e.dy], got: r.detail,
                hint: "belt 用 beltCode(rv)、机器用 codeFor(building,variant,0,0)；两者都不许手填", plan: p,
            });
        }
        if (e.kind === "belt") {
            const bad = checkBeltDirections(e);
            if (bad) {
                return rejectEmit("emit:mismatch", {
                    gate: EMIT_GATES.CODE, path: `plan.entities[${i}]`, nodeId: e.nodeId,
                    cell: [p.site.anchor[0] + e.dx, p.site.anchor[1] + e.dy], got: bad,
                    hint: "带子的 (rot,rv) 必须由 belt-rules.solveTurn 现算，不许猜方向（红队 #1）", plan: p,
                });
            }
        }
        codes.push(r.code);
    }

    /* ── 3. 锚点归一（C1）：世界格 = site.anchor + [dx,dy] → w = 世界 min corner，dx' 非负 ── */
    const site = p.site.anchor;
    const world = ordered.map(e => [site[0] + e.dx, site[1] + e.dy]);
    const minX = Math.min(...world.map(c => c[0]));
    const minY = Math.min(...world.map(c => c[1]));
    const anchor = [minX, minY];

    // 同格二次放置 = 契约破坏（P1 的 assertCompiledPlan 已在**原 dx/dy** 空间查过一遍；
    // 归一是平移，不改变重合性 —— 这里再查一次，作为发射侧的独立证据）
    const seen = new Map();
    for (let i = 0; i < world.length; i++) {
        const k = `${world[i][0]},${world[i][1]}`;
        if (seen.has(k)) {
            return rejectEmit("emit:mismatch", {
                gate: EMIT_GATES.CELL_CONFLICT, path: `plan.entities[${i}]`, nodeId: ordered[i].nodeId,
                cell: world[i], got: { first: seen.get(k), second: i },
                hint: "两格同坐标 —— 蓝图内一格只能一个实体（与 Grid 同格二次 set 抛错同源）", plan: p,
            });
        }
        seen.set(k, i);
    }

    const emitted = ordered.map((e, i) => ({
        ...e,
        code: codes[i],
        dx: world[i][0] - minX,
        dy: world[i][1] - minY,
    }));

    /* ── 4. 容器层编码（只读 import，禁改 blueprint.mjs；stride=4 缺口见 NOTES） ── */
    // 4a. 入参若已带**真**蓝图（P8 重发射 / 自检场景），必须先与 entities 逐格对得上：
    //     对不上 = 递给我一张会堵死的蓝图的那类 bug，宁可不产也不盖过去（redteam:158）。
    //     占位哨兵/ null 表示「尚未发射」，跳过。opts.ignoreInputBlueprint 可显式关闭。
    if (p.blueprint && opts.ignoreInputBlueprint !== true) {
        const cmp = compareInputBlueprint(p.blueprint, p.entities, p.site.anchor);
        if (!cmp.ok) {
            return rejectEmit("emit:mismatch", {
                gate: EMIT_GATES.CONTRACT, path: "plan.blueprint", nodeId: cmp.nodeId, cell: cmp.cell,
                got: cmp.detail,
                hint: "入参自带的蓝图与 entities 不一致（陈旧蓝图/字段谎报）。要按 entities 重发射请传 opts.ignoreInputBlueprint:true", plan: p,
            });
        }
    }
    const gv = opts.gv || GAME_VERSION;
    let blueprint;
    try {
        // v2 的 o[]：逐格**解不动点**（不是简单写 orig=rot —— 那是 v1 语义，也是 P7-F2 翻向的原因）。
        // 邻居编码已用真实工厂样本反解验证：上游把货喷进本格 ⇒ ejector 的 toDirection = 本格入边方向。
        //   （实测：corner r90/rv2 + orig180 与 toDirection='right' 精确吻合真实存档 23 个同拓扑拐角。）
        // 若某拐角**无解**（四个 orig 都不落在想要的 (rot,rv) 上），说明该拓扑下这格天生会翻：
        //   ⇒ 整单拒绝，不产出"贴上去当时对、旁边一放就翻"的蓝图。
        const opp = { top: "bottom", bottom: "top", left: "right", right: "left" };
        const unsolvable = [];
        const origSolved = emitted.map(e => {
            if (e.kind !== "belt") return null;
            const ns = [];
            // 上游：把货喷进本格的是 **ejector**，其 toDirection = 本格的入边方位（'top' = 朝上喷入）。
            if (e.inDir) ns.push({ toDirection: e.inDir });
            // 下游：接货的是 **acceptor**，fromDirection = 它面向本格的方向 = outDir 的反向。
            // ⚠️ 这里不能写成 toDirection（下游是接收方，不是喷口）——写错会让所有拐角判无解。
            if (e.outDir) ns.push({ fromDirection: opp[e.outDir] });
            const wantR = norm360(e.rot), wantV = e.rotationVariant || 0;
            for (const orig of [0, 90, 180, 270]) {
                const r = computeBelt({ rotation: orig, neighbors: ns });
                if (r.rotation === wantR && r.rotationVariant === wantV) return orig;
            }
            unsolvable.push({ cell: [e.dx, e.dy], kind: e.kind, rot: e.rot, rv: wantV, inDir: e.inDir, outDir: e.outDir });
            return null;
        });
        if (unsolvable.length) {
            return rejectEmit("validate:V3", {
                gate: EMIT_GATES.CONTRACT, nodeId: unsolvable[0].cell ? null : null,
                cell: unsolvable[0].cell,
                got: unsolvable.slice(0, 4),
                hint:
                    "这些带子格在任何 originalRotation 下都不是其在邻居拓扑中的不动点 —— 扰动后必然翻向。" +
                    "v2 无法用 o 修复它们（不是缺信息，是该拓扑无解）。布局应避免此类拐角，或改走 place_path 通道。",
                plan: p,
            });
        }
        blueprint = encodeBlueprint({
            gv, w: anchor,
            entities: emitted.map((e, i) => ({
                code: e.code, dx: e.dx, dy: e.dy, rot: e.rot,
                orig: origSolved[i],
            })),
        });
    } catch (err) {
        return rejectEmit("emit:mismatch", {
            gate: EMIT_GATES.CONTRACT, nodeId: null, cell: null, got: String(err && err.message),
            hint: "encodeBlueprint 抛错（容器层异常）", plan: p,
        });
    }
    if (typeof blueprint !== "string" || !blueprint.startsWith(BLUEPRINT_PREFIX)) {
        return rejectEmit("emit:mismatch", { gate: EMIT_GATES.CONTRACT, got: blueprint, hint: "产物不带 SZBP1. 前缀", plan: p });
    }

    /* ── 5. beltIntent（P7 对拍凭据，字段名照 plan §1.6） ── */
    const beltIntent = emitted.map((e, i) => ({
        index: i,
        nodeId: e.nodeId,
        instanceIdx: e.instanceIdx === undefined ? 0 : e.instanceIdx,
        kind: e.kind,
        x: world[i][0],
        y: world[i][1],
        dx: e.dx,
        dy: e.dy,
        rotation: e.rot,
        rotationVariant: e.rotationVariant,
        code: e.code,
        inDir: e.inDir,
        outDir: e.outDir,
        isCorner: e.kind === "belt" && e.rotationVariant !== 0,
        phase: entityOrderPhase(e),
    }));

    /* ── 6. 成本与口径（§1.6 / §6 R4 god-mode：显式 chargeMode:"false"，绝不 "auto"） ── */
    const count = emitted.length;
    const cost = blueprintCost(count);
    const beltTiles = emitted.filter(e => e.kind === "belt").length;
    const corners = emitted.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length;
    const xs = emitted.map(e => e.dx), ys = emitted.map(e => e.dy);
    const bbox = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];

    /* ── 7. 出参自检：把产物塞回 §2.1 契约（顺序/坐标/bbox/stats 全量重验） ── */
    const emittedPlan = {
        ...p,
        blueprint,
        entities: emitted,
        stats: { ...p.stats, blueprintCost: cost, chargeMode: "false", beltTiles, corners, bbox },
    };
    const warnings = preWarnings.slice();
    if (p.stats.chargeMode !== "false") warnings.push(`入参 stats.chargeMode=${JSON.stringify(p.stats.chargeMode)}，发射按 v1 口径钉成 "false"`);
    let revalidated;
    try {
        revalidated = assertCompiledPlan(emittedPlan, "emittedPlan", { entityOrder: "strict" });
    } catch (err) {
        if (err instanceof ContractViolation) {
            return rejectEmit("emit:mismatch", {
                gate: EMIT_GATES.CONTRACT, path: err.path, got: err.allMessages,
                hint: "产出的 plan 不过 §2.1 契约（发射器自证失败，绝不返回）", plan: p,
            });
        }
        throw err;
    }

    return {
        ok: true,
        stage: EMIT_STAGE,
        blueprint,
        gv,
        anchor,                                  // = w = 世界 min corner = paste_blueprint 的 x,y
        siteAnchor: site,
        entities: emitted,
        beltIntent,
        count,
        stride: BLUEPRINT_STRIDE,
        cost,
        blueprintCost: cost,
        chargeMode: "false",
        beltTiles,
        corners,
        bbox,
        warnings,
        plan: revalidated,                        // 完整 CompiledPlan（blueprint 已填真串）
        reason: null,
        failingNode: null,
        hint: null,
    };
}

/* ═══════════════════════════════ 闸（ok / validation / 契约） ═══════════════════════════════ */

/**
 * P2 硬断言的前置闸（L1 门第 3 条的入口）。
 * 对每个 entity：非 belt 的 `codeFor(building,variant,r,rv)` 一旦抛 SpecError，就用它的 reason
 * 结构化拒发射；belt 只查 rv∈{0,1,2}（belt-rules 的取值域）。**不改入参、不做归一**，
 * 目的是让「P2 不允许的东西」以 P2 的分诊串出口（out-of-scope:rotated-machine / emit:mismatch）。
 * @returns {{ok:false,...}|null} null = 全部通过
 */
export function preflightP2Assertions(plan) {
    const ents = plan && Array.isArray(plan.entities) ? plan.entities : [];
    const site = plan && plan.site && Array.isArray(plan.site.anchor) ? plan.site.anchor : null;
    const cellOf = e => (site && Number.isInteger(e.dx) && Number.isInteger(e.dy) ? [site[0] + e.dx, site[1] + e.dy] : null);
    for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (!e || typeof e !== "object") continue;                       // 形状问题交给 gatePlan
        const cell = cellOf(e);
        if (e.kind === "belt") {
            if (!(e.rotationVariant >= 0 && e.rotationVariant <= 2)) {
                return rejectEmit("emit:mismatch", {
                    gate: EMIT_GATES.CODE, path: `plan.entities[${i}].rotationVariant`, nodeId: e.nodeId, cell,
                    got: e.rotationVariant, hint: "belt rv ∈ {0,1,2}（belt-rules.mjs:56-59）", plan,
                });
            }
            continue;
        }
        if (!Number.isInteger(e.code) || !Number.isInteger(e.rotationVariant) || !Number.isInteger(e.rot)) continue;
        const tpl = templateForBuildingCode(e.code);
        if (!tpl || tpl.building === "belt") continue;                   // 反查不到 = gatePlan/resolveMachineCode 处理
        try {
            assertV1Rotation(tpl.building, e.rot);
            codeFor(tpl.building, tpl.variant, e.rot, e.rotationVariant);   // ← 这里透传 P2 的 rv≠0 断言
        } catch (err) {
            if (err && typeof err.reason === "string" && isFailureReason(err.reason) && err.reason !== "emit:mismatch") {
                return rejectEmit(err.reason, {
                    gate: EMIT_GATES.CODE, check: `${EMIT_GATES.CODE}(${tpl.building} rv/rot)`,
                    path: `plan.entities[${i}]`, nodeId: e.nodeId, cell,
                    got: { kind: e.kind, code: e.code, rot: e.rot, rv: e.rotationVariant, message: err.message },
                    hint: "v1 非 belt 只出 rv=0、机器恒 r=0（H2/H3/D1；RV_ALLOWED 是判据源）", plan,
                });
            }
            // P2 给的是 emit:mismatch 之类的通用串 → 也拒，但 reason 保留通用串
            return rejectEmit(specReason(err), {
                gate: EMIT_GATES.CODE, path: `plan.entities[${i}]`, nodeId: e.nodeId, cell,
                got: String(err && err.message), hint: "P2 codeFor/assertV1Rotation 抛错", plan,
            });
        }
    }
    return null;
}

/**
 * 发射前的三道闸，顺序固定（先粗筛、再契约）：
 *   A. plan.ok === true                       —— !ok 的 plan 本身带 reason，透传它（gate=plan-not-ok）
 *   B. plan.validation.pass === true          —— 不过 → validate:<Vn>（§2.4 的第一条 fatal）
 *   C. P1 的 assertCompiledPlan（strict 顺序 + 必填 layout/validation + scope === v1）
 * @returns {{ok:true, plan:object} | {ok:false}（rejectEmit 的结果）}
 */
export function gatePlan(plan, opts = {}) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
        return rejectEmit("emit:mismatch", {
            gate: EMIT_GATES.CONTRACT, path: "plan", got: plan,
            hint: "emitPlan 的入参必须是 CompiledPlan 对象",
        });
    }

    // A. ok 标志（放在契约之前：契约要求 ok:true ⇒ blueprint 非空，未发射的 plan 天生不满足）
    if (plan.ok !== true) {
        const r = typeof plan.reason === "string" && isFailureReason(plan.reason) ? plan.reason : "emit:mismatch";
        return rejectEmit(r, {
            gate: EMIT_GATES.PLAN_OK, check: EMIT_GATES.PLAN_OK,
            nodeId: plan.failingNode && plan.failingNode.nodeId, cell: plan.failingNode && plan.failingNode.cell,
            got: { ok: plan.ok, reason: plan.reason },
            hint: "ok!==true 的计划绝不发射（§2.1 硬规定 1 / redteam:158）", plan,
        });
    }

    // B. validation.pass（P5 必须 0 error；顺带把 drift 也当硬条件看一眼，plan §1.5 的 L1.5 门口径）
    const rep = plan.validation;
    if (!rep || typeof rep !== "object" || Array.isArray(rep) || rep.pass !== true) {
        const reason = validateReasonFrom(rep);
        const first = rep && Array.isArray(rep.errors) ? rep.errors[0] : null;
        return rejectEmit(reason, {
            gate: EMIT_GATES.VALIDATION, check: first && first.check ? first.check : EMIT_GATES.VALIDATION,
            nodeId: first ? first.nodeId : null, cell: first && first.cell ? first.cell : null,
            got: rep ? { pass: rep.pass, errors: (rep.errors || []).length } : rep,
            hint: "ValidatorReport.pass!==true 不发射（P5 的 V1..V10+S1 是前置，plan §1.6）", plan,
        });
    }
    const drift = rep.beltSim && Array.isArray(rep.beltSim.drift) ? rep.beltSim.drift : [];
    if (drift.length > 0) {
        return rejectEmit("validate:V3", {
            gate: EMIT_GATES.VALIDATION, check: "V3-belt-fixed-point",
            nodeId: drift[0].cell ? null : null, cell: drift[0].cell || null, got: drift.length,
            hint: "beltSim.drift 非空 = 含机器邻居下不是不动点（L1.5 门，plan §5）", plan,
        });
    }

    // C. P2 硬断言（H2/D1）：非 belt rv≠0 / 机器 rot≠0 → 用 **P2 自己的 §2.5 reason** 拒。
    //    必须在契约之前：契约会把同一输入报成泛泛的 emit:mismatch，分诊表要的是 out-of-scope:*。
    const p2 = preflightP2Assertions(plan);
    if (p2) return p2;

    // D. 契约（P1 单一真源）。未发射的入参 blueprint=null → 用哨兵占位，出参换真串。
    const input = plan.blueprint === null || plan.blueprint === undefined || plan.blueprint === ""
        ? { ...plan, blueprint: PENDING_BLUEPRINT }
        : plan;
    try {
        // P1 的契约只认 "strict" | "off"；"reorder" 是本包的修复模式，落到契约层必须是 strict
        // （重排完之后就该按 strict 验，绝不能因为 opts 里有 "reorder" 就绕过顺序断言）。
        const contractOrder = opts.entityOrder === "off" ? "off" : "strict";
        const normalized = assertCompiledPlan(input, "plan", {
            entityOrder: contractOrder,
            stages: opts.stages || "required",
        });
        // 出参的 blueprint 不许残留哨兵（防「把占位串当真蓝图」）
        if (normalized.blueprint === PENDING_BLUEPRINT) normalized.blueprint = null;
        return { ok: true, plan: normalized };
    } catch (err) {
        if (err instanceof ContractViolation) {
            return rejectEmit("emit:mismatch", {
                gate: EMIT_GATES.CONTRACT, path: err.path, got: err.allMessages,
                hint: "入参不过 §2.1 契约（结构化错误已列出，不静默）", plan,
            });
        }
        throw err;      // 非契约异常 = 程序 bug，不吞
    }
}

/**
 * 入参自带蓝图（不是占位串）时的对拍：decode 回来与 entities 逐格比 (code,dx,dy,rot)。
 *
 * 两点刻意的宽松（都是已登记的口径，不是放水）：
 *   - dx/dy 先各自折成「相对自己的 min corner」再比 —— 蓝图里的 dx/dy 相对 w=min corner，
 *     plan 里的 dx/dy 相对 site.anchor，天生差一个常数平移（NOTES「锚点口径」）。
 *   - 比的是**格子集合**而不是下标次序：执行顺序由顺序锁单独管（gate/契约），
 *     内容相同、次序不同不构成「会堵死的蓝图」。真正的错位（少一格、多一格、
 *     code/rot/位置被篡改）一律拒。
 * @returns {{ok:true} | {ok:false, detail:string, nodeId:string|null, cell:[number,number]|null}}
 */
export function compareInputBlueprint(text, entities, anchor) {
    let decoded;
    try { decoded = decodeBlueprint(text); }
    catch (err) { return { ok: false, detail: `入参蓝图无法解码（${err && err.code ? "err.code " + err.code : ""}）：${err && err.message}`, nodeId: entities[0] ? entities[0].nodeId : null, cell: null }; }
    if (decoded.entities.length !== entities.length) {
        return { ok: false, detail: `蓝图 ${decoded.entities.length} 格 vs entities ${entities.length} 格`, nodeId: null, cell: null };
    }
    const rel = (list, keyX, keyY) => {
        const xs = list.map(e => e[keyX]), ys = list.map(e => e[keyY]);
        const mx = Math.min(...xs), my = Math.min(...ys);
        return list.map(e => `${e.code},${e[keyX] - mx},${e[keyY] - my},${e.rot}`).sort();
    };
    const fromBp = rel(decoded.entities, "dx", "dy");
    const fromPlan = rel(entities, "dx", "dy");
    const i = fromBp.findIndex((k, j) => k !== fromPlan[j]);
    if (i >= 0) {
        return {
            ok: false,
            detail: `第 ${i} 项（按归一坐标排序）不符：蓝图 ${fromBp[i]} vs plan ${fromPlan[i]}`,
            nodeId: null,                       // 集合级差异不指到具体 nodeId（P8 靠 detail 的排序项定位）
            cell: anchor ? [...anchor] : null,
        };
    }
    return { ok: true };
}

/**
 * 只归一锚点、不编码（给 P8/测试对拍锚点用）。
 * @param {{entities:Array<{dx:number,dy:number}>, site:{anchor:[number,number]}}} plan
 * @returns {{anchor:[number,number], cells:Array<[number,number]>, local:Array<{dx:number,dy:number}>, bbox:[number,number]}}
 */
export function normalizeAnchor(plan) {
    const site = plan.site.anchor;
    const cells = plan.entities.map(e => [site[0] + e.dx, site[1] + e.dy]);
    const minX = Math.min(...cells.map(c => c[0]));
    const minY = Math.min(...cells.map(c => c[1]));
    const local = cells.map(c => ({ dx: c[0] - minX, dy: c[1] - minY }));
    const xs = local.map(l => l.dx), ys = local.map(l => l.dy);
    return { anchor: [minX, minY], cells, local, bbox: [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1] };
}

/* ═══════════════════════════════ 烟测（node src/ai/compiler/emit.mjs --test） ═══════════════════════════════
 * L1 门的完整验收在 roundtrip.mjs（任务书规定的 CLI）。这里只锁两件最容易在重构中破掉的事：
 *   顺序锁的判据函数 + 闸的「不过就不产蓝图」。 */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/emit.mjs") && process.argv.includes("--test")) {
    let fails = 0;
    const say = (cond, msg, extra) => { if (cond) console.log("✓ " + msg); else { fails++; console.log(`✗ ${msg}${extra ? "  " + JSON.stringify(extra) : ""}`); } };

    const fake = [
        { kind: "miner", rotationVariant: 0, code: 7 },
        { kind: "belt", rotationVariant: 0, code: 1 },
        { kind: "belt", rotationVariant: 1, code: 2 },
    ];
    say(orderEntities([...fake]).map(e => e.kind).join() === "miner,belt,belt", "orderEntities：机器→直线→拐角");
    say(orderEntities([fake[2], fake[1], fake[0]]).map(e => e.rotationVariant).join() === "0,0,1", "orderEntities：拐角排到最后");
    say(checkEntityOrder([fake[2], fake[0]]).ok === false, "checkEntityOrder：拐角在前 → 非单调");
    say(checkEntityOrder(fake).ok === true, "checkEntityOrder：单调 → ok");

    const gate = gatePlan(null);
    say(gate.ok === false && gate.blueprint === null && gate.beltIntent.length === 0, "gatePlan(null) → blueprint:null + 空 intent");
    const notOk = gatePlan({ ok: false, reason: "no-resource-in-range", validation: { pass: true, errors: [] } });
    say(notOk.ok === false && notOk.reason === "no-resource-in-range", "闸 A：ok:false → 透传上游 reason，不产蓝图");
    const badVal = gatePlan({ ok: true, reason: null, validation: { pass: false, errors: [{ check: "V9-unused-outlet", severity: "fatal", nodeId: "n1", cell: [1, 4], message: "x" }] } });
    say(badVal.ok === false && badVal.reason === "validate:V9", "闸 B：validation.pass:false → validate:<Vn>");

    console.log(fails ? `emit.mjs 烟测：${fails} 条失败` : "emit.mjs 烟测：全绿（L1 门见 roundtrip.mjs）");
    if (fails) process.exitCode = 1;
}
