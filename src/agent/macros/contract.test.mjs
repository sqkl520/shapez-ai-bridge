/**
 * contract.test.mjs — **契约与实现的一致性**测试。
 *
 * 运行：node src/agent/macros/contract.test.mjs      退出码 0 全过 / 1 有失败
 *
 * 为什么要有这个文件（而 contract.mjs 自带的 selftest 不够）：
 *   contract.mjs 末尾的 selftest 证明的是「契约自己前后一致」；
 *   它无法证明「契约与实现一致」—— 那需要 import 实现、跑真实用例、把两者的说法对拍。
 *   本项目反复出问题的地方正是这里：同一件事有两份真值，各自都自洽，合起来打脸
 *   （replace_run 的 building 形态、insert_machine 的 facing 必填性、warnings 的 code 集合）。
 *
 * 本文件的三类判据：
 *   A. 每个宏的每个参数形态：校验器**接受**的与 `MACRO_SPECS[n].params` 声明的逐条一致；
 *      契约声明「会被拒」的，校验器/实现必须真的拒（或真的警告）。
 *   B. `warnings` 的每个 code 都在 `WARNING_CODES` 闭集里；级别与登记一致；
 *      `ok:true` 不得携带 error 级警告。
 *   C. `whenNotToUse` 的每一条都有对应的拒绝码或警告码（防「只是文档，不参与校验」）。
 *
 * 只读：不写世界、不碰游戏。世界 = research/ai-plan/live-L4-entities.json。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* 从真值派生 wasteRoles —— 测试不许硬编码 left/right。
   2026-10-29 之前 op-templates 把 cutter 的 wasteRoles 写成了 ["right"]，
   而本文件也断言 ["right"] —— 两个模块互相印证同一个错误，谁也没发现。
   实机三方证据指出废料其实是 left 之后，这个"互相印证"才暴露出来。 */
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";

import {
    MACRO_SPECS, MACRO_NAMES, MACRO_VALIDATORS, WARNING_CODES, WARNING_SEVERITIES, ERROR_CODES,
    validateMacroResult, validateReplaceRunArgs, validateInsertMachineArgs, validateConnectArgs,
    validateRemoveRunArgs, validateExtendLineArgs, validateTrashUnusedArgs,
    lintNoBareCoords, worstSeverity, warningVerdict, isCanonicalWarningCode,
} from "./contract.mjs";
import {
    removeRun, replaceRun, trashUnused, makeContext, MACRO_IMPLS,
} from "./remove.mjs";
import { insertMachine, extendLine, buildWorld as buildPlaceWorld } from "./place.mjs";
import { connect, buildWorld } from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; console.log(`\x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
};
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 世界（只读）
 * ══════════════════════════════════════════════════════════════════════════ */

const ENTITIES = JSON.parse(fs.readFileSync(SAVE, "utf8"));
const W = buildWorld(ENTITIES);            // connect.mjs 的 world（remove/connect 用）
const PW = buildPlaceWorld(ENTITIES);      // place.mjs 的 world（insert_machine/extend_line 用；两者形状不同）
const CTX = makeContext(buildPlaceWorld(ENTITIES), ENTITIES);

const L4_REGION = [4, -14, 5, -13];
const L4_BUILDING = ["cutter", { kind: "trash", port: "left", confirm_waste: true }];
/* L4 的 trash 接在 (4,-14)，那里原本有一条带子 10143，它下游还接着 10144 ——
   confirm_waste 这一签同时覆盖「这一侧是废料」与「我知道会剪断 10143→10144」两层后果。 */

/** 跑一个宏的**真实实现**并返回 (result, 入参是否通过校验器) */
const CALL = {
    connect: (a) => connect(a, { entities: ENTITIES }),
    insert_machine: (a) => insertMachine(a, PW),
    remove_run: (a) => removeRun(a, CTX),
    extend_line: (a) => extendLine(a, PW),
    replace_run: (a) => replaceRun(a, CTX),
    trash_unused: (a) => trashUnused(a, CTX),
};

/** 收集一个返回值里出现的所有 warning code（含 plan.sideEffects 的诊断码） */
function codesOf(r) {
    const c = new Set((r.warnings || []).map(w => w.code));
    for (const se of r.sideEffects || []) c.add(se.code);
    return c;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 硬伤 1：replace_run 的 building 三形态 —— 契约声明 === 校验器 === 实现
 * ══════════════════════════════════════════════════════════════════════════ */

t("replace_run：契约声明的 building 三形态，校验器全部接受", () => {
    const cases = [
        { building: "belt", region: [4, -14, 5, -13], expectMode: "belt" },
        { building: "cutter", region: [4, -14, 5, -13], expectMode: "machines" },
        { building: { kind: "cutter", variant: "default" }, region: L4_REGION, expectMode: "machines" },
        { building: L4_BUILDING, region: L4_REGION, expectMode: "machines" },
        { building: [{ kind: "trash", port: "left", confirm_waste: true }, "cutter"], region: L4_REGION, expectMode: "machines" },
    ];
    for (const c of cases) {
        const v = validateReplaceRunArgs({ region: c.region, building: c.building });
        ok(v.ok, `${JSON.stringify(c.building)} 应通过校验器：${JSON.stringify(v.error)}`);
        eq(v.value.mode, c.expectMode, `${JSON.stringify(c.building)} 的 mode`);
    }
});

t("★ 关键验收：L4 的改造 replace_run({region, building:[\"cutter\",{kind:\"trash\",...}]}) 通过校验器", () => {
    const v = validateReplaceRunArgs({ region: L4_REGION, building: L4_BUILDING });
    ok(v.ok, JSON.stringify(v.error));
    eq(v.value.building.map(b => b.kind), ["cutter", "trash"]);
    eq(v.value.building[1].port, "left");
    eq(v.value.building[1].confirm_waste, true);
    /* 并且实现确实按这个入参做出了 L4 的改造（不是「校验器放过、实现拒绝」） */
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    ok(r.ok, JSON.stringify(r.error));
    eq(r.placed.map(p => p.kind), ["cutter", "trash"]);
    eq(r.removed.length, 3);
    eq(r.kept.length, 1);
});

t("replace_run：契约声明「会被拒」的形态，校验器逐条拒绝且错误码一致", () => {
    const neg = [
        ["空数组", { building: [] }, "bad_type"],
        ["数组里混 belt", { building: ["belt", "cutter"] }, "bad_type"],
        ["隧道（字符串）", { building: "underground_belt" }, "unsupported_building"],
        ["隧道（对象）", { building: { kind: "underground_belt" } }, "unsupported_building"],
        ["hub（字符串）", { building: "hub" }, "unsupported_building"],
        ["hub（对象）", { building: { kind: "hub" } }, "unsupported_building"],
        ["未知键 r", { building: { kind: "cutter", r: 90 } }, "unknown_field"],
        ["port 是对象", { building: { kind: "trash", port: { role: "left", index: 0 } } }, "bad_type"],
        ["confirm_waste 非布尔", { building: { kind: "trash", port: "left", confirm_waste: "yes" } }, "bad_type"],
        ["building 是数字", { building: 42 }, "bad_type"],
        ["反序 bbox", { building: "belt", region: [5, 5, 1, 1] }, "bad_type"],
        ["缺 region", { building: "belt", region: undefined }, "missing_field"],
    ];
    for (const [why, args, code] of neg) {
        const v = validateReplaceRunArgs({ region: L4_REGION, ...args });
        assert.equal(v.ok, false, `${why} 应被拒`);
        eq(v.error.code, code, `${why} 的错误码`);
    }
});

t("replace_run：契约声明的「机器模式允许空格、belt 模式不允许」与实现一致", () => {
    /* region = [5,-18,6,-18]：(5,-18) 是带子，(6,-18) 是空的 */
    const regionWithHole = [5, -18, 6, -18];
    const belt = replaceRun({ region: regionWithHole, building: "belt" }, CTX);
    eq(belt.ok, false, "belt 模式遇空格必须拒");
    eq(belt.error.code, "precondition_failed");
    ok(/空/.test(belt.error.message));

    const machine = replaceRun({ region: regionWithHole, building: "cutter" }, CTX);
    ok(!(machine.ok === false && /空/.test(machine.error.message)),
        "机器模式不应因空格被拒（这是契约写明的有意差异）");
});

t("replace_run：机器模式的两条「语义校验」契约与实现一致（trash 缺 port / 未签字）", () => {
    const noPort = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash" }] }, CTX);
    eq(noPort.ok, false);
    eq(noPort.error.code, "missing_field");

    const noSign = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: "left" }] }, CTX);
    eq(noSign.ok, false);
    eq(noSign.error.code, "precondition_failed");
    eq(noSign.error.field, "building[1].confirm_waste");
});

t("replace_run：confirm_waste 是**一次签字覆盖两层后果** —— 契约声明、校验器、实现三处一致", () => {
    const spec = MACRO_SPECS.replace_run;
    const noChainOpt = spec.params.find(x => x.name === "opts.confirm_chain_cut");
    eq(noChainOpt, undefined,
        "实现已把「剪活链」并回 confirm_waste；契约不得再留一个实现不认的 opts（那会变成又一份假 ABI）");
    const pre = spec.preconditions.find(s => /confirm_waste/.test(s) && /下游/.test(s));
    ok(pre, "preconditions 必须写明 confirm_waste 同时覆盖「这一侧是废料」与「会剪断下游」");
    ok(/不可省/.test(pre), "必须写清它不是可省的");

    /* 缺 confirm_waste 的两种拒绝理由（实现先判 wasteRoles，再判活链）。
     *
     * ⚠️ 这里**不写死 left/right**：2026-10-29 之前 `wasteRoles` 被写成 `["right"]`，
     * 这组测试跟着断言 `["right"]` —— 错误的真值被测试锁死，两个模块互相印证同一个错误。
     * 实机三方证据（L4-COMPILER-DIAGNOSIS.md:460 / L4-E2E-RESULT 的 ejector 读数 /
     * L4-PLAN-A0 的落点）一致指出废料是 **left**，修正后旧断言就红了。
     * 现在从 `templateByBuildingVariant` 派生，单点真值。 */
    const cutterTpl = templateByBuildingVariant("cutter", "default");
    const wasteRoles = cutterTpl.wasteRoles || [];
    const outRoles = (cutterTpl.outputs || []).map(q => q.role);
    const nonWasteRole = outRoles.find(r => !wasteRoles.includes(r));
    ok(!!nonWasteRole, "（前置）cutter 有一个非废料输出槽", { wasteRoles, outRoles });

    const notWaste = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: nonWasteRole }] }, CTX);
    eq(notWaste.ok, false);
    eq(notWaste.error.code, "precondition_failed");
    eq(notWaste.error.field, "building[1].confirm_waste");
    eq(notWaste.error.detail.role, nonWasteRole);
    eq(notWaste.error.detail.wasteRoles, wasteRoles,
        "必须告诉调用方模板默认的废料侧是哪一边（值从 op-templates 派生，不手抄）");

    const wasteRole = wasteRoles[0];
    const cutsLive = replaceRun({ region: L4_REGION, building: ["cutter", { kind: "trash", port: wasteRole }] }, CTX);
    eq(cutsLive.ok, false);
    eq(cutsLive.error.code, "precondition_failed");
    ok(Array.isArray(cutsLive.error.detail?.cuts) && cutsLive.error.detail.cuts.length > 0,
        "剪活链必须列出 uid→下游（否则调用方只是盲签）");

    /* 签了 → ok，且签字留痕（warnings.trash-cuts-chain） */
    const done = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    ok(done.ok, JSON.stringify(done.error));
    ok(done.warnings.some(w => w.code === "trash-cuts-chain"), "签字后必须留痕");
    eq(WARNING_CODES["trash-cuts-chain"].severity, "warn");

    /* 契约不得凭空发明实现不认的 opts —— 任何 opts.* 都必须在 opts 白名单里 */
    const bad = validateReplaceRunArgs({ region: L4_REGION, building: L4_BUILDING, opts: { confirm_chain_cut: true } });
    eq(bad.ok, false, "实现不认的 opts 必须被校验器拒（不能留一个「契约有、实现无」的影子参数）");
    eq(bad.error.code, "unknown_field");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 硬伤 2：region 的坐标身份（lint 从规格表派生，不再有手写白名单）
 * ══════════════════════════════════════════════════════════════════════════ */

t("硬伤 2：lint 的坐标放行名单从 MACRO_SPECS **派生**（region 是被声明为 endpoint 的）", () => {
    const spec = MACRO_SPECS.replace_run;
    const p = spec.params.find(x => x.name === "region");
    ok(p, "replace_run.region 必须存在");
    eq(p.coordClass, "endpoint", "region 必须声明为 endpoint（v2 裁定：它是选集不是推导）");

    const lint = lintNoBareCoords("replace_run", { region: L4_REGION, building: "belt" });
    ok(lint.ok, JSON.stringify(lint.violations));
    ok(lint.coordParams.includes("region"), "region 必须在派生名单里");
});

t("硬伤 2：没有声明 coordClass 的坐标参数会被 lint 抓住（白名单后门已封）", () => {
    /* 手工伪造一份「忘了登记 coordClass」的规格，看 lint 是否报红。
       这是防止「新增坐标参数但不登记」的唯一机器判据。 */
    const lint = lintNoBareCoords("connect", { from: { uid: 1 }, to: { uid: 2 }, extraBox: [0, 0, 3, 3] });
    eq(lint.ok, false, "未登记的 bbox 参数必须判红");
    ok(/coordClass/.test(lint.violations.join(";")), lint.violations.join(";"));
});

t("硬伤 2：每个宏声明的端点/落点数量不超上界，且坐标容器参数都被声明", () => {
    for (const name of MACRO_NAMES) {
        const spec = MACRO_SPECS[name];
        const eps = spec.params.filter(p => p.coordClass === "endpoint").length;
        const sites = spec.params.filter(p => p.coordClass === "site").length;
        ok(eps <= 2, `${name} 端点 ${eps} 个超上界 2`);
        ok(sites <= 1, `${name} 落点 ${sites} 个超上界 1`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 硬伤 3：warnings 闭集 + 分级
 * ══════════════════════════════════════════════════════════════════════════ */

/** 实现里**实际**会发出的全部 warnings code（用真实世界跑出来的 + 源码扫描得到的） */
const IMPL_WARNING_CODES = Object.freeze([
    /* connect */
    "replacing-belts", "hub-entry-chosen",
    /* insert_machine / extend_line */
    "facing_ignored", "replacing_belts", "input_not_fed", "input_belt_wrong_direction",
    "output_not_connected", "output_belt_wrong_direction", "orphaned_upstream", "orphaned_downstream",
    "rotation_not_live_verified", "wiring_mismatch", "world_unknown_entities", "terminal_orphaned",
    /* remove_run */
    "would-disconnect", "stranded-items-unknown",
    /* replace_run */
    "rv-drift", "variant-unverified", "kept-belts", "internal-trash-offset",
    /* trash_unused */
    "replacing-belt",
]);

t("硬伤 3：实现会发出的每个 warning code 都在 WARNING_CODES 闭集里", () => {
    for (const c of IMPL_WARNING_CODES) {
        ok(WARNING_CODES[c], `实现会发 "${c}"，但契约没登记它`);
    }
});

t("硬伤 3：WARNING_CODES 的源码里没有重复键（JS 会静默取最后一个）", () => {
    const src = fs.readFileSync(path.resolve(HERE, "contract.mjs"), "utf8");
    const block = src.slice(src.indexOf("export const WARNING_CODES"), src.indexOf("export const SIDE_EFFECT_CODES"));
    const keys = [...block.matchAll(/^    (?:"([a-z][a-z0-9_-]*)"|([a-z][a-z0-9_]*)): \{/gm)].map(m => m[1] || m[2]);
    ok(keys.length >= 20, `只扫到 ${keys.length} 个键，扫描规则可能失效`);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    eq(dups, [], `重复键会被 Object.freeze 的对象字面量静默取最后一个：${dups.join(", ")}`);
    eq(keys.length, Object.keys(WARNING_CODES).length, "源码扫描的键数必须等于运行时键数（否则有键被覆盖掉了）");
});

t("硬伤 3：闭集里每个条目都必须有 severity ∈ WARNING_SEVERITIES 与 action", () => {
    for (const [c, d] of Object.entries(WARNING_CODES)) {
        ok(WARNING_SEVERITIES.includes(d.severity), `${c} 的 severity "${d.severity}" 不合法`);
        ok(typeof d.action === "string" && d.action.length > 0, `${c} 缺 action（调用方该做什么）`);
        ok(typeof d.what === "string" && d.what.length > 0, `${c} 缺 what`);
    }
});

t("硬伤 3：非规范拼写被登记为 canonical:false 且指向规范码", () => {
    for (const [c, d] of Object.entries(WARNING_CODES)) {
        if (d.canonical === false) {
            ok(WARNING_CODES[d.aliasOf], `${c} 的 aliasOf "${d.aliasOf}" 不存在`);
            eq(isCanonicalWarningCode(c), false, `${c} 应被判为非规范`);
        } else {
            eq(isCanonicalWarningCode(c), true, `${c} 应被判为规范`);
        }
    }
    /* 同一件事的三种拼写，规范名只能有一个 */
    eq(isCanonicalWarningCode("replacing-belts"), true);
    eq(isCanonicalWarningCode("replacing_belts"), false);
    eq(isCanonicalWarningCode("replacing-belt"), false);
});

t("硬伤 3：warningVerdict 给 ok:true 的呼叫方一个**确定的**动作", () => {
    eq(worstSeverity([]), null);
    eq(warningVerdict([]).ok, true);
    eq(warningVerdict([]).severity, null);

    const info = [{ code: "kept-belts" }];   // 这里故意用错级别：kept-belts 是 warn
    eq(worstSeverity(info), "warn", "码表决定级别，不看调用方怎么写");

    eq(worstSeverity([{ code: "hub-entry-chosen" }]), "info");
    eq(warningVerdict([{ code: "hub-entry-chosen" }]).severity, "info");
    eq(warningVerdict([{ code: "hub-entry-chosen" }]).ok, true);

    eq(worstSeverity([{ code: "hub-entry-chosen" }, { code: "kept-belts" }]), "warn");
    eq(warningVerdict([{ code: "kept-belts" }]).ok, true, "warn 不阻断");

    eq(worstSeverity([{ code: "internal-trash-offset" }]), "error");
    eq(warningVerdict([{ code: "internal-trash-offset" }]).ok, false, "error 级必须按 ok:false 处理");
});

t("硬伤 3：validateMacroResult 拒绝闭集外的 warning code", () => {
    const r = {
        ok: true, macro: "connect", cells_planned: 1, cells_placed: 1,
        first_mismatch: null, changed: { added_uids: [], removed_uids: [] },
        warnings: [{ code: "made-up-code", detail: "x" }], error: null,
    };
    const v = validateMacroResult(r);
    eq(v.ok, false);
    ok(/不在闭集/.test(v.error.message), v.error.message);
});

t("硬伤 3：validateMacroResult 拒绝 ok:true + error 级警告（ok 不许撒谎）", () => {
    const r = {
        ok: true, macro: "replace_run", cells_planned: 1, cells_placed: 1,
        first_mismatch: null, changed: { added_uids: [], removed_uids: [] },
        warnings: [{ code: "internal-trash-offset", detail: "x" }], error: null,
    };
    const v = validateMacroResult(r);
    eq(v.ok, false, "ok:true 携带 error 级警告必须判红");
    ok(/error 级警告/.test(v.error.message), v.error.message);
});

t("硬伤 3：validateMacroResult 拒绝实现自行升降级（severity 与码表不符）", () => {
    const r = {
        ok: true, macro: "connect", cells_planned: 1, cells_placed: 1,
        first_mismatch: null, changed: { added_uids: [], removed_uids: [] },
        warnings: [{ code: "kept-belts", severity: "info", detail: "x" }], error: null,
    };
    const v = validateMacroResult(r);
    eq(v.ok, false, "kept-belts 登记为 warn，实现不得就地降成 info");
});

t("硬伤 3：真实返回值里所有 warning 都过 validateMacroResult（闭集在实跑中成立）", () => {
    const runs = [
        connect({ from: { uid: 10002 }, to: { uid: 10036, port: "primary" } }, { entities: ENTITIES }),
        insertMachine({ at: [-9, -11], facing: "top", machine: "cutter" }, { entities: ENTITIES.filter(e => e.uid !== 10036) }),
        removeRun({ uids: [10209, 10149] }, CTX),
        replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX),
        replaceRun({ region: L4_REGION, building: "belt" }, CTX),
        trashUnused({ outlet: { uid: 10008 } }, CTX),
        extendLine({ from: { uid: 10151 }, len: 2 }, PW),
    ];
    let seen = new Set();
    for (const r of runs) {
        const v = validateMacroResult(r);
        ok(v.ok, `真实返回值不合契约：${JSON.stringify(v.error)}`);
        for (const w of r.warnings) seen.add(w.code);
        /* warningVerdict 只对「计划成功」的返回值给执行建议；失败单的判据是 error.code */
        if (r.ok) eq(warningVerdict(r.warnings).ok, true, "ok:true 时 verdict 不得翻成 false");
    }
    ok(seen.size > 0, "至少要跑出一些真实警告，否则这条测试没有检查力");
    for (const c of seen) ok(WARNING_CODES[c], `实跑出现未登记 code: ${c}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 每个宏：参数形态 契约声明 === 校验器行为
 * ══════════════════════════════════════════════════════════════════════════ */

t("每个宏的校验器都挂在 MACRO_VALIDATORS 上，且与 MACRO_SPECS 一一对应", () => {
    eq(Object.keys(MACRO_VALIDATORS).sort(), [...MACRO_NAMES].sort());
    eq(MACRO_NAMES.length, 6);
});

t("每个校验器都拒绝未知参数（含裸坐标键），且错误码是 unknown_field", () => {
    const calls = {
        connect: { from: { uid: 1 }, to: { uid: 2 } },
        insert_machine: { at: [0, 0], facing: "top", machine: "cutter" },
        remove_run: { uids: [1] },
        extend_line: { from: { uid: 1 }, len: 2 },
        replace_run: { region: [0, 0, 1, 1], building: "belt" },
        trash_unused: { outlet: { uid: 1 } },
    };
    for (const [name, base] of Object.entries(calls)) {
        for (const bad of ["x", "y", "r", "rv"]) {
            const v = MACRO_VALIDATORS[name]({ ...base, [bad]: 1 });
            eq(v.ok, false, `${name}.${bad} 应被拒`);
            eq(v.error.code, "unknown_field", `${name}.${bad} 的错误码`);
        }
    }
});

t("connect：opts.rebind / allow_replace 是两个独立开关，契约与实现一致", () => {
    const spec = MACRO_SPECS.connect;
    eq(spec.optsRelation.independent, ["opts.rebind", "opts.allow_replace"]);
    ok(WARNING_CODES[spec.optsRelation.bothTrueWarning], "bothTrueWarning 必须在闭集里");

    /* 只开 allow_replace：路径上的带子可覆盖，但源口仍被占 → 仍拒（证明两者不互相顶替） */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 10, type: "belt", x: 0, y: 5, r: 0, rotation_variant: 0 },
    ];
    const onlyReplace = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { allow_replace: true } }, { entities: ents });
    eq(onlyReplace.ok, false);
    eq(onlyReplace.error.code, "port_already_bound", "allow_replace 不应解决「口被占」");
});

t("insert_machine：at 两种形态走不同算术，归一化后 kind 可区分", () => {
    const origin = validateInsertMachineArgs({ at: [4, -13], facing: "top", machine: "cutter" });
    const anyCell = validateInsertMachineArgs({ at: { cell: [4, -13] }, facing: "top", machine: "cutter" });
    ok(origin.ok && anyCell.ok);
    eq(origin.value.at.kind, "origin");
    eq(anyCell.value.at.kind, "any-cell");
    eq(MACRO_SPECS.insert_machine.paramRules.at.recommendedForm, "{cell:[x,y]}");
});

t("insert_machine：{cell} 多解时的消歧口径 —— 契约文字与实现一致", () => {
    /* 实现（place.mjs）在 2×1 机器上多解时，若只有一解让 at.cell 成为输入槽槽格则采用，
       并回报 site.chosen_by；仍多解才 ambiguous_site。契约必须说同一件事。 */
    const spec = MACRO_SPECS.insert_machine;
    ok(/输入槽槽格/.test(spec.params.find(p => p.name === "at").description),
        "at 的 description 必须写明「唯一输入槽解则采用」");
    ok(spec.preconditions.some(s => /输入槽槽格/.test(s) && /ambiguous_site/.test(s)),
        "preconditions 必须说同一句话");
    ok(/输入槽/.test(spec.paramRules.at.disambiguation || ""), "paramRules.at.disambiguation 必须登记这条口径");

    const r = insertMachine({ at: { cell: [4, -13] }, facing: "top", machine: "cutter" }, PW);
    ok(r.ok, `2×1 的 cutter 在带子格上应能唯一反解：${JSON.stringify(r.error)}`);
    eq(r.origin, [4, -13]);
    eq(r.site.chosen_by, "input-slot", "多解被输入槽语义收窄时，依据必须如实回报");
});

t("insert_machine：facing 的必填性在 schema / description / precondition 三处说同一句话", () => {
    const spec = MACRO_SPECS.insert_machine;
    const facing = spec.params.find(p => p.name === "facing");
    eq(facing.required, false, "params 里 facing 必须是 required:false（必填性取决于机器）");
    ok(/必填性取决于机器/.test(facing.description), "description 必须写明必填性取决于机器");
    ok(/有输出槽且可旋转的机器必填/.test(facing.description), "description 必须写出判据");
    ok(/ambiguous_site/.test(facing.description), "description 必须写出缺失时的错误码");
    const pre = spec.preconditions.find(s => s.includes("facing` 缺失"));
    ok(pre, "preconditions 必须有一条专讲「facing 缺失」的规则");
    ok(/有输出槽且可旋转/.test(pre), "precondition 的判据必须与 description 一致");
    ok(/ambiguous_site/.test(pre), "precondition 必须写出缺失时的错误码");
    ok(/trash/.test(pre) && /允许省略/.test(pre), "precondition 必须写明哪些机器可以省略 facing");

    eq(spec.paramRules.facing.requiredWhen, "machine 有输出槽且可旋转（ROTATABLE !== false）");
    eq(spec.paramRules.facing.missingCode, "ambiguous_site");
    /* 实现行为对齐：可旋转机器不给 facing → ambiguous_site */
    const r = insertMachine({ at: [0, 0], machine: "cutter" }, PW);
    eq(r.ok, false);
    eq(r.error.code, "ambiguous_site");
    eq(r.error.field, "facing");
});

t("remove_run：cells 通道被标为 deprecated，但契约与校验器都仍认它", () => {
    const p = MACRO_SPECS.remove_run.params.find(x => x.name === "cells");
    eq(p.deprecated, true, "cells 必须标 deprecated");
    ok(/勿用/.test(p.description), "cells 的 description 必须写明勿用");
    /* 「二选一必填」不能靠两个 required:false 让 schema 生成器读成「都可省」 */
    eq(MACRO_SPECS.remove_run.exactlyOneOf, [["uids", "cells"]],
        "remove_run 必须机器可读地声明 uids/cells 恰好二选一");
    ok(validateRemoveRunArgs({ cells: [[4, -13]] }).ok, "保留通道：校验器仍接受 cells");
    ok(validateRemoveRunArgs({ uids: [1] }).ok, "uids 是推荐通道");
    eq(validateRemoveRunArgs({ uids: [1], cells: [[4, -13]] }).ok, false, "二选一互斥");
    eq(validateRemoveRunArgs({}).error.code, "missing_field", "都不给必须报 missing_field");
});

t("extend_line：契约不再要求调用方先数格子（len 的上限来自宏自己回报）", () => {
    const spec = MACRO_SPECS.extend_line;
    ok(!spec.preconditions.some(s => /len ≤ 与最近障碍的距离/.test(s)),
        "旧 precondition「len ≤ 与最近障碍的距离」必须删掉（那是 computed 的活）");
    ok(spec.preconditions.some(s => /occupied/.test(s) && /firstConflict/.test(s)),
        "必须写明「撞障碍 → occupied + firstConflict」让调用方据此缩短 len");
    /* 实现确实这么做：len 太长 → occupied + firstConflict 指向真实存在的格。
       from = (9,-13)，dir=left：首格 (9,-14)，第五格撞上带子 10150 —— 调用方只需缩短 len。 */
    const tail = ENTITIES.find(e => e.x === 9 && e.y === -13).uid;
    const short = extendLine({ from: { uid: tail }, len: 3, dir: "left" }, PW);
    ok(short.ok, `短 len 应成功：${JSON.stringify(short.error)}`);
    const r = extendLine({ from: { uid: tail }, len: 400, dir: "left" }, PW);
    eq(r.ok, false);
    eq(r.error.code, "occupied");
    ok(r.firstConflict, "必须给出被挡的第一格");
});

t("trash_unused：契约声明 outlet 可接带子末端（remove.mjs 的扩展 2），实现确实支持", () => {
    const spec = MACRO_SPECS.trash_unused;
    ok(/一段带子的末端/.test(spec.params.find(p => p.name === "outlet").description),
        "outlet 的 description 必须写明可接带子末端");
    const r = trashUnused({ outlet: { uid: 10008 } }, CTX);
    ok(r.ok, JSON.stringify(r.error));
    eq(r.outletPort.kind, "belt-exit");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. whenNotToUse 每一条都有对应的拒绝或警告（文档 → 机器判据）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每条 whenNotToUse 必须至少挂一个「机器可观测的落点」：一个 error code 或一个 warning code。
 * 没有落点的条目就是纯文档 —— 契约自己承认的「whenNotToUse 不参与校验」那种状态。
 */
const WHEN_NOT_TO_USE_ANCHORS = Object.freeze({
    connect: [
        ["宿不存在", ["endpoint_not_found"]],
        ["新建一整条产线", ["no_path", "endpoint_not_a_port"]],     // build_line 不在本宏；调用会以几何/端口拒绝
        ["「接进」", ["no_path", "occupied"]],        ["源端口已经有接收方", ["port_already_bound"]],
        ["紧贴", ["no_path", "precondition_failed"]],
    ],
    insert_machine: [
        ["孤立的机器", ["input_not_fed", "output_not_connected"]],
        ["trash", ["facing_ignored"]],
        ["换一台机器", ["blocked_by_machine"]],
        ["调整既有机器朝向", ["blocked_by_machine"]],
        ["周围接线", ["output_not_connected"]],
    ],
    remove_run: [
        ["给机器让位", ["would-disconnect"]],
        ["清一大片区域", ["would-disconnect"]],
        ["不确定某格是什么", ["not_a_run"]],
    ],
    extend_line: [
        ["具体的东西", ["terminal_orphaned"]],
        ["拐两个弯", ["precondition_failed"]],
        ["绕过障碍", ["occupied", "precondition_failed"]],
    ],
    replace_run: [
        ["删除带子", ["precondition_failed"]],
        ["insert_machine 更直接", ["kept-belts"]],
        ["铺隧道", ["unsupported_building"]],
        ["region 框不准", ["not_a_run", "precondition_failed"]],
    ],
    trash_unused: [
        ["接 hub", ["port_already_bound", "endpoint_not_a_port"]],
        ["缓冲/合流", ["occupied"]],
        ["端口已经接了东西", ["port_already_bound"]],
    ],
});

t("whenNotToUse：每条都有锚定到 error/warning code 的机器判据", () => {
    for (const name of MACRO_NAMES) {
        const spec = MACRO_SPECS[name];
        const anchors = WHEN_NOT_TO_USE_ANCHORS[name];
        ok(anchors, `${name} 缺 WHEN_NOT_TO_USE_ANCHORS 映射`);
        eq(anchors.length, spec.whenNotToUse.length, `${name} 的 whenNotToUse 条数与锚点数不一致`);
        for (let i = 0; i < anchors.length; i++) {
            const [frag, codeList] = anchors[i];
            ok(spec.whenNotToUse[i].includes(frag),
                `${name}.whenNotToUse[${i}] 应以「${frag}」开头/包含它，实得：${spec.whenNotToUse[i].slice(0, 40)}`);
            for (const c of codeList) {
                ok(c in WARNING_CODES || c in ERROR_CODES,
                    `${name}.whenNotToUse[${i}] 的锚点 "${c}" 既不是 error code 也不是 warning code`);
            }
        }
    }
});

t("whenNotToUse 的锚点里引用的 error code 都在 ERROR_CODES 闭集里", () => {
    for (const [name, list] of Object.entries(WHEN_NOT_TO_USE_ANCHORS)) {
        for (const [frag, codeList] of list) {
            for (const c of codeList) {
                ok(c in ERROR_CODES || c in WARNING_CODES, `${name}/${frag} 的 "${c}" 不在任何闭集里`);
            }
        }
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 已知的两份真值（登记项：实现与契约仍不一致，但已明确指出）
 * ══════════════════════════════════════════════════════════════════════════ */

t("登记项：replace_run / insert_machine 的 warnings code 拼写尚未统一（契约标了 alias）", () => {
    /* 这三个码在实现里各写各的（横线/下划线/单复数），契约把它们都收进闭集并标 canonical:false。
       合并动作属于实现方（本次任务不改实现），这里只保证「不静默」。 */
    eq(WARNING_CODES["replacing-belts"].severity, "warn");
    eq(WARNING_CODES.replacing_belts.aliasOf, "replacing-belts");
    eq(WARNING_CODES["replacing-belt"].aliasOf, "replacing-belts");
    const emitted = codesOf(insertMachine({ at: [4, -13], facing: "top", machine: "cutter" }, PW));
    ok(emitted.has("replacing_belts"), "insert_machine 目前仍发下划线形态（登记在案）");
});

t("登记项：connect 目前**不发** both_rebind_and_allow_replace（契约要求发）", () => {
    /* 契约在 connect.optsRelation 里要求「两者同时 true 时发 warn 级警告」。
       实现还没做 —— 这是本次任务明确允许的「必须改实现才能一致」的缺口，登记在这里，
       契约测试断言「目前确实没发」，于是将来实现补上时这条会红，提醒把登记项删掉。 */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 10, type: "belt", x: 0, y: 5, r: 0, rotation_variant: 0 },
        { uid: 11, type: "belt", x: 0, y: 4, r: 0, rotation_variant: 0 },
        { uid: 12, type: "belt", x: 0, y: 3, r: 0, rotation_variant: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { allow_replace: true, rebind: true } }, { entities: ents });
    ok(r.ok, JSON.stringify(r.error));
    ok(!codesOf(r).has("both_rebind_and_allow_replace"),
        "实现已经补上了 both_rebind_and_allow_replace —— 请删除这条登记项并把断言改成「必须发」");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 信封：changed 语义（计划态）
 * ══════════════════════════════════════════════════════════════════════════ */

t("信封：计划态下 added_uids 恒空（uid 由 tx 分配），契约已写明", () => {
    const r = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    ok(r.ok);
    eq(r.changed.added_uids, [], "计划态 added_uids 必须为空数组");
    ok(/added_uids 恒空/.test(MACRO_SPECS.insert_machine.returns),
        "insert_machine.returns 必须写明没有 uid 字段（否则『放机器→接垃圾桶』会被误以为能直接串起来）");

    /* 计划态的串联通道：实现已经返回 pending（PendingRef），契约必须承认它，
       否则「放机器 → 接垃圾桶」又要回到「必须重新 obs」的老路。
       用一个已被腾空的喷口格（4,-14）做世界：真实 L4 里那里还有一条带子，
       trash_unused 会正确地以 port_already_bound 拒绝（那不是串联失败，是它绝不抢货流）。 */
    const cleared = ENTITIES.filter(e => !(e.x === 4 && e.y === -14));
    const ins = insertMachine({ at: { cell: [4, -13] }, facing: "top", machine: "cutter" }, buildPlaceWorld(cleared));
    ok(ins.ok, JSON.stringify(ins.error));
    ok(ins.pending && ins.pending.pending === true, "insert_machine 必须返回计划态引用 pending");
    ok(/pending/.test(MACRO_SPECS.insert_machine.returns), "returns 必须写明 pending 是串联通道");
    const chained = trashUnused(
        { outlet: { pending: ins.pending, port: "left" }, opts: { confirm_waste: true } },
        makeContext(buildPlaceWorld(cleared), cleared),
    );
    ok(chained.ok, `insert_machine → trash_unused 必须能在计划态串起来：${JSON.stringify(chained.error)}`);
    eq(chained.trashCell, [4, -14], "trash 必须落在该 pending 机器的 left 喷口格");

    /* replace_run 机器路径的 dry_run 恒 true（实现已把它与 opts.dry_run 拆开：
       dry_run = 「有没有写世界」，requested_dry_run = 「调用方要不要 dry-run」） */
    const r2 = replaceRun({ region: L4_REGION, building: L4_BUILDING }, CTX);
    ok(r2.dry_run === true,
        `replace_run 机器路径的 dry_run 实得 ${r2.dry_run}，但该宏零写操作（契约要求 true）`);
    eq(r2.requested_dry_run, false, "opts.dry_run 缺省 false 必须单列在 requested_dry_run，不能混进 dry_run");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
