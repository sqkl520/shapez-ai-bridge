/**
 * test.mjs — P5 validator 的 L0 验收（plan-compiler.md §1.5 验收 + §5 的 L0/L1.5 门）。
 *
 * 运行（两条都等价）：
 *   node research/ai-plan/validator/test.mjs
 *   node src/ai/compiler/validate.mjs --test
 *
 * 五组验收，逐条打印 pass/fail：
 *   A 判据自测 + 契约（11 条 check id 全覆盖、report 过 P1 的 assertValidatorReport）
 *   B **变异测试矩阵**（19 条注入：7 条 M4 陷阱 + 8 条清单反例 + 4 条补充）
 *     断言：恰好报出对应 check id、failingNode 指对格、其余 check 不 fail（不受染）
 *   C **双实现交叉对拍**：belt-sim 的槽位法拓扑 vs src/ai/belt-rules.test.mjs 的 OPP 回指法，
 *     同一份存档数据（facts/live/world-full.json），要求 **0 差异**；并实跑 P0-verify 的测试
 *   D golden：report-validator.json round-trip（assertValidatorReport + 逐字段等）；
 *     三金样例 plan-l1/report-layout 全 pass；golden 场景重放复现它的 3 条 fail id
 *   E lint：本包两个文件不含 proto/belt-rules import（跑 P1 的 lint-imports 判据 + 自查）
 *
 * 铁律：零依赖（ESM + node 内置）；不 import P3/P4 实现；100% 离线；不碰桥接；不 commit。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validate, validateWithFailure, CURVED_EFFICIENCY, CHECK_ORDER, RUNNER_IDS, hashOf, worldGrid, normalizeInput, hubAnchorOf } from "../../../src/ai/compiler/validate.mjs";
import {
    computeBelt, simulateBelts, topologyScore, loadSaveWorld, saveFixedPointScore,
    saveRvDistribution, checkSaveBeltCodes, buildWorldModel, neighborsAffecting, WORLD_FULL_PATH,
} from "../../../src/ai/compiler/belt-sim.mjs";
import { assertValidatorReport, assertCompiledPlan } from "../../../src/ai/compiler/types.mjs";
import { CHECK_IDS } from "../../../src/ai/compiler/errors.mjs";
import { beltCode, solveTurn, beltEntry, beltExit, OPP, norm360 } from "../../../src/ai/belt-rules.mjs";
import { lintDirectory, collectImportSpecifiers, isProtoBeltRules } from "../contract/lint-imports.mjs";
import { RATES } from "../../../src/ai/op-templates.mjs";
import { PLACE_MACHINE } from "../../../src/ai/compiler/grid.mjs";

import { mutationCases } from "./mutation-cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const rd = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/* ─────────────────────────── 断言小工具 ─────────────────────────── */
let passed = 0, failed = 0;
const results = [];
function ok(cond, label, detail = "") {
    if (cond) { passed++; results.push(`✓ ${label}`); }
    else { failed++; results.push(`✗ ${label}${detail ? "\n    " + detail : ""}`); }
}
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
function group(title) { results.push("", `── ${title} ──────────────────────────────`); }

const throws = fn => { try { fn(); return false; } catch { return true; } };
const clone = o => JSON.parse(JSON.stringify(o));

/* ─────────────────────────── fixture ─────────────────────────── */
const F = {
    plan: rd("research/ai-plan/fixtures/plan-l1.json"),
    layout: rd("research/ai-plan/fixtures/report-layout.json"),
    intent: rd("research/ai-plan/contract/merge-belt-intent.json"),
    golden: rd("research/ai-plan/fixtures/report-validator.json"),
};

/* ═══════════════════════════ A. 判据自测与契约 ═══════════════════════════ */
group("A 判据自测 + §2.4 契约");

eq(CHECK_ORDER.length, 11, "A1 11 条 check id 全在表内（V1..V10 + S1）");
eq([...CHECK_ORDER].sort(), [...CHECK_IDS].sort(), "A2 check id 与 P1 的 CHECK_IDS 逐字相同");
{
    // 弯带折算系数：与 P4 的同名常量对拍，但**不 import route.mjs**（P5 不依赖 P3/P4 的实现，
    // 而且 P4 此刻还在写 —— 从源码文本读它的常数，比对值，两边都不引入依赖）。
    const routeSrc = fs.readFileSync(path.join(ROOT, "src/ai/compiler/route.mjs"), "utf8");
    const direct = /export const CORNER_COST_TILES\s*=\s*([0-9.]+)/.exec(routeSrc);
    const aliased = /export const CORNER_COST_TILES\s*=\s*([A-Z_][A-Z_0-9]*)/.exec(routeSrc);
    const aliasVal = aliased && new RegExp(`(?:const|export const)\\s+${aliased[1]}\\s*=\\s*([0-9.]+)`).exec(routeSrc);
    const p4Val = direct ? Number(direct[1]) : aliasVal ? Number(aliasVal[1]) : null;
    ok(p4Val !== null, "A3 从 route.mjs 解析到 P4 的弯带折算常数（CORNER_COST_TILES，可能是 CURVED_BELT_LENGTH 的别名）");
    eq(CURVED_EFFICIENCY, p4Val, `A4 弯带折算 ${CURVED_EFFICIENCY} == P4 的 ${p4Val}（不 import，值必须一致）`);
    ok(typeof RUNNER_IDS === "function" && RUNNER_IDS().length === 11, "A4b RUNNER 覆盖 11 条判据（执行序 ≠ 报告序）");
}

{
    // 12 组 (rv,rot) 的 computeBelt 语义自测：不动点/漂移方向与 belt-rules 的几何一致
    const straight = computeBelt({ rotation: 0, neighbors: [{ toDirection: "top" }, { fromDirection: "bottom" }] });
    eq(straight, { rotation: 0, rotationVariant: 0 }, "A5 computeBelt 下 ejector + 上 acceptor → 直带（不动点）");
    eq(computeBelt({ rotation: 0, neighbors: [{ toDirection: "right" }] }), { rotation: 90, rotationVariant: 1 }, "A6 局部左侧 ejector → +90 rv1（支①）");
    eq(computeBelt({ rotation: 0, neighbors: [{ toDirection: "left" }] }), { rotation: 270, rotationVariant: 2 }, "A7 局部右侧 ejector → +270 rv2（支①）");
    eq(computeBelt({ rotation: 0, neighbors: [{ fromDirection: "left" }] }), { rotation: 0, rotationVariant: 2 }, "A8 局部右侧 acceptor → rotation **不变** rv2（支②，与支①不同）");
    eq(computeBelt({ rotation: 0, neighbors: [{ fromDirection: "right" }] }), { rotation: 0, rotationVariant: 1 }, "A9 局部左侧 acceptor → rotation 不变 rv1");
    eq(computeBelt({ rotation: 90, neighbors: [{ toDirection: "left" }, { fromDirection: "left" }] }), { rotation: 90, rotationVariant: 0 }, "A10 西行直带（r=90）：局下 ejector + 局上 acceptor → 自己就是不动点");
    // solveTurn 的解一定是该邻居拓扑下的不动点（P4 的显式定向与游戏启发式对齐）
    let turnOk = 0, turnBad = [];
    for (const inDir of ["top", "right", "bottom", "left"]) for (const outDir of ["top", "right", "bottom", "left"]) {
        const s = solveTurn(inDir, outDir);
        if (!s) continue;
        const nb = [];
        nb.push({ toDirection: inDir });                 // 上游从我"入边方位"喷进来
        nb.push({ fromDirection: OPP[outDir] });         // 下游在我"出边方位"要收
        const got = computeBelt({ rotation: s.rotation, neighbors: nb });
        if (got.rotation === s.rotation && got.rotationVariant === s.rotationVariant) turnOk++;
        else turnBad.push({ inDir, outDir, s, got });
    }
    eq(turnBad, [], `A11 solveTurn 的 12 组解在 computeBelt 下全是不动点（${turnOk}/12）`);
    eq(turnOk, 12, "A12 12 组全部命中（红队 #1：这条是自洽，语义凭据在 A5-A10 + C 组双实现）");
}

{
    const r = validate(F.plan, { strict: true });
    ok(r.pass === true, "A13 plan-l1 全 pass（strict：报告过 P1 的 assertValidatorReport）", JSON.stringify(r.errors));
    const r2 = validate(F.layout, { entities: F.intent.entities, strict: true });
    ok(r2.pass === true, "A14 report-layout（双分支汇合 + 2 拐角 + 车道）全 pass", JSON.stringify(r2.errors));
    eq(r.beltSim.includesMachineNeighbors, true, "A15 beltSim.includesMachineNeighbors === true（§2.4 硬规定）");
    eq(r.beltSim.drift.length, 0, "A16 L1.5 门：drift.length === 0");
    eq(r.checks.map(c => c.id), [...CHECK_ORDER], "A17 报告顺序 = CHECK_ORDER（不受执行序影响）");
    ok(r.checks.every(c => typeof c.evidence.note === "string" && c.evidence.note.length > 8), "A18 每条 check 都有人读 evidence.note");
    // 与 P1 fixture 里存的 validation 段落对齐（check id + status + beltSim 计数）
    const stored = F.plan.validation;
    eq(r.checks.map(c => [c.id, c.status]), stored.checks.map(c => [c.id, c.status]), "A19 我的 status 与 plan-l1 里存的 validation 逐条相同");
    eq(r.beltSim.tilesChecked, stored.beltSim.tilesChecked, `A20 beltSim.tilesChecked == fixture（${r.beltSim.tilesChecked}）`);
    eq(r.beltSim.fixedPoints, stored.beltSim.fixedPoints, "A21 beltSim.fixedPoints == fixture");
    eq(r.throughput, stored.throughput, "A22 throughput 与 fixture 逐字段等（瓶颈 miner@0.4）");
}

{
    // 两类输入的两种契约（**故意的不对称**）：
    //   ① 结构性非法输入（不是对象 / 没有 LayoutReport）= 调用方用错 API → **显式抛** TypeError。
    //      绝不静默返回 pass:false 的报告 —— 那会把"没图可判"伪装成"图有问题"。
    //   ② 形态对但内容畸形（layout 缺字段、 placements:null）= 业务输入 → 收敛成报告，不冒泡。
    const structural = [null, undefined, 0, "x", [], [{}], {}];
    let threwStructural = 0, leakedStructural = [];
    for (const j of structural) {
        try { validate(j); } catch (e) { if (e instanceof TypeError) threwStructural++; else leakedStructural.push([String(j), e.message.slice(0, 60)]); }
    }
    eq(threwStructural, structural.length, "A23 结构性非法输入（非对象/数组/无 LayoutReport）→ 显式 TypeError（programmer error，不伪装成业务失败）");
    eq(leakedStructural, [], "A24 结构性输入只抛 TypeError，不抛别的");
    const malformed = [{ layout: {} }, { placements: [] }, { layout: { placements: null } }, { layout: { channels: null }, entities: null }, { layout: { placements: [null] } }, { layout: {}, entities: [{ kind: "belt", dx: 0, dy: 0, rot: 0, rotationVariant: 0 }] }];
    let leaked = [];
    for (const m of malformed) { try { const r = validate(m); if (!r || !Array.isArray(r.checks)) leaked.push([JSON.stringify(m).slice(0, 40), "报告缺 checks"]); } catch (e) { leaked.push([JSON.stringify(m).slice(0, 40), e.message.slice(0, 80)]); } }
    eq(leaked, [], "A25 形态对但内容畸形的输入一律收敛成报告（业务失败永不 throw，plan §0 顶层入口）");
}

{
    const { report, failure } = validateWithFailure(mutationCases(F).find(c => c.id === "P1-rv-derived").make().input, { checkEntityOrder: false });
    ok(report.pass === false, "A26 有 error ⇒ pass:false");
    ok(failure && failure.ok === false && /^validate:V3$/.test(failure.reason), "A27 失败对象 reason = validate:<Vn>（§2.5）", JSON.stringify(failure));
    ok(failure && failure.failingNode && failure.failingNode.cell[0] === 0 && failure.failingNode.cell[1] === 1, "A28 failingNode 指对格 (0,1)");
}

{
    // 本地 hash 复刻 vs proto（S1 的几何闸不依赖 proto 可加载性）
    const { parse, hash } = await import("../../../research/ai-player/proto/shape-ops.mjs");
    const keys = ["CuCuCuCu", "----CuCu", "CuCu----", "CgScScCg", "RuRuCuCu", "CuCuSuSu:RuRuCuCu"];
    eq(keys.map(k => hashOf(parse(k))), keys, "A29 hashOf 复刻与 proto/shape-ops.hash 逐字符相同（getHash 同式）");
    eq(hash(parse("CuCuSuSu:RuRuCuCu")), "CuCuSuSu:RuRuCuCu", "A30 多层形状 hash 带 ':' 分隔（S1 语法判据）");
}

/* ═══════════════════════════ B. 变异测试矩阵 ═══════════════════════════ */
group("B 变异测试矩阵（7 陷阱 + 8 清单反例 + 4 补充）");

const cases = mutationCases(F);
const matrix = [];
for (const c of cases) {
    const { input, opts } = c.make();
    const r = validate(input, opts);
    const id = c.expect.split(":")[0];
    const hit = r.checks.find(x => x.id === id);
    const failedIds = r.checks.filter(x => x.status === "fail").map(x => x.id);
    const naIds = r.checks.filter(x => x.status === "not-applicable").map(x => x.id);
    const reportOnly = c.expect.endsWith(":report-only");

    let verdict, why = [];
    if (reportOnly) {
        // V10 只报告不阻断（C7）：该条注入**不能**产生任何 fail / error
        if (failedIds.length) { verdict = false; why.push(`不该有 fail：${failedIds.join(",")}`); }
        if (!r.pass) { verdict = false; why.push("pass 必须仍为 true（报告项不阻断）"); }
        if (r.errors.length) { verdict = false; why.push("errors 必须为空"); }
        if (!/越级/.test(String(hit && hit.evidence.actual))) { verdict = false; why.push("V10 未列出越级清单"); }
        verdict ??= true;
    } else {
        verdict = true;
        if (!hit) { verdict = false; why.push("该 check 没出现在报告里"); }
        else if (hit.status !== "fail") { verdict = false; why.push(`${id}.status=${hit.status}`); }
        if (failedIds.length !== 1 || failedIds[0] !== id) { verdict = false; why.push(`fails=[${failedIds.join(",")}] 期望只含 ${id}`); }
        if (c.expectCell !== undefined && hit && JSON.stringify(hit.evidence.cell) !== JSON.stringify(c.expectCell)) why.push(`cell=${JSON.stringify(hit.evidence.cell)} 期望 ${JSON.stringify(c.expectCell)}`);
        if (c.expectNode !== undefined && hit && hit.evidence.nodeId !== c.expectNode) why.push(`nodeId=${hit.evidence.nodeId} 期望 ${c.expectNode}`);
        if (c.sub && hit && !String(hit.evidence.actual + hit.evidence.note).includes(c.sub)) why.push(`子判据未命中「${c.sub}」`);
        if (why.length) verdict = false;
    }
    // 被染的 check 只能是 not-applicable 且写明阻断者
    const naBad = r.checks.filter(x => x.status === "not-applicable" && x.id !== "V7-throughput")
        .filter(x => !/前置闸|派生自|阻断|未执行|无可重放|无带子|不适用/.test(x.evidence.note));
    matrix.push({ injected: c.id, caught_by: failedIds.join(",") || (reportOnly ? "(report-only)" : "NONE"), clean: verdict, na: naIds, note: why.join("; ") });
    ok(verdict, `B ${c.id.padEnd(30)} → ${c.expect}`, why.join("; ") + (naIds.length ? ` | 被染(na)=${naIds.join(",")}` : ""));
}
eq(cases.length, 19, "B20 注入条数 = 7 条陷阱 + 8 条清单 + 4 条补充");
eq(new Set(cases.map(c => c.id)).size, 19, "B21 每条注入 id 唯一");
eq([...new Set(cases.map(c => c.expect.split(":")[0]))].sort(),
    ["S1-shape-replay", "V1-occupancy", "V10-unlock-report", "V2-no-overwrite-existing-belt", "V3-belt-fixed-point",
        "V4-slot-alignment", "V5-degree", "V6-crossing", "V7-throughput", "V8-scope", "V9-unused-outlet"],
    "B22 11 条 check id **全部**至少被一条注入命中（没有无人守的闸）");

/* good fixture 在变异前后必须仍然全 pass（防"判据过敏"） */
ok(validate(F.plan, { strict: true }).pass, "B23 good fixture plan-l1 仍全 pass");
ok(validate(F.layout, { entities: F.intent.entities, strict: true }).pass, "B24 good fixture report-layout 仍全 pass");

/* ★ V6 的车道比较必须按 (轴, 下标)：row:3 与 col:3 是两条正交车道，不得报 crossing。
 *   这条是**正例**（旧实现会假红）；反例（同轴同号 = 真冲突）在同一份 fixture 上必须红，
 *   两条一起才证明「按轴比较」不是把判据关掉。 */
{
    const l = clone(F.layout);
    l.channels[0] = { ...l.channels[0], lane: 3, laneAxis: "row" };
    l.channels[1] = { ...l.channels[1], lane: 3, laneAxis: "col" };
    l.lanes = [{ row: 3, column: null, channelIds: ["chA"] }, { row: null, column: 3, channelIds: ["chB"] }];
    const r = validate(l, { entities: clone(F.intent.entities), strict: true });
    eq(r.checks.find(c => c.id === "V6-crossing").status, "pass",
        "B25 row:3 与 col:3 并存 → V6 pass（车道身份 = (轴, 下标)，裸整数实现会假红）");
    // 反例：同一个 row 上挂两条不同 payload → 必须 fail（判据没被关掉）
    const bad = clone(l);
    bad.channels[1] = { ...bad.channels[1], lane: 3, laneAxis: "row" };
    bad.lanes = [{ row: 3, column: null, channelIds: ["chA", "chB"] }];
    const rb = validate(bad, { entities: clone(F.intent.entities), strict: true });
    eq(rb.checks.find(c => c.id === "V6-crossing").status, "fail", "B26 同一个 row:3 挂两条不同 payload → V6 fail（同行才真冲突）");
    // 反例：同一个 column 上挂两条不同 payload → 必须 fail（列也要判）
    const badC = clone(l);
    badC.channels[0] = { ...badC.channels[0], lane: 3, laneAxis: "col" };
    badC.lanes = [{ row: null, column: 3, channelIds: ["chA", "chB"] }];
    const rc = validate(badC, { entities: clone(F.intent.entities), strict: true });
    eq(rc.checks.find(c => c.id === "V6-crossing").status, "fail", "B27 同一个 column:3 挂两条不同 payload → V6 fail（同列同样判）");
    // v1 报告（channels[].laneAxis 缺省）仍按 row 处理：不得因缺字段而漏判
    const legacy = clone(l);
    delete legacy.channels[0].laneAxis;
    legacy.channels[1] = { ...legacy.channels[1], laneAxis: "row" };
    legacy.lanes = [{ row: 3, column: null, channelIds: ["chA", "chB"] }];
    eq(validate(legacy, { entities: clone(F.intent.entities), strict: true }).checks.find(c => c.id === "V6-crossing").status, "fail",
        "B28 v1 报告（laneAxis 缺省 = row）与显式 row 同样判冲突（缺字段不漏判）");
}

/* ═══════════════════════ C. 双实现交叉对拍 ═══════════════════════ */
group("C 双实现交叉对拍（belt-sim 槽位法 vs belt-rules.test.mjs OPP 回指法）");

const save = loadSaveWorld();
ok(fs.existsSync(WORLD_FULL_PATH), `C0 双实现共用的存档数据存在（${path.relative(ROOT, WORLD_FULL_PATH)}，离线、已提交在库里）`);
ok(RATES.stacker === 0.25 && RATES.belt === 2.0, `C0b P2 的速率表可用（stacker ${RATES.stacker}/s 必在 —— V7 的瓶颈判据、GEOMETRY 表2）`);
eq(save.filter(e => e.type === "belt").length, 1906, "C1 存档快照 1906 条带子（单一 regular 层）");
eq(saveRvDistribution(save), { 0: 1487, 1: 223, 2: 196 }, "C2 rv 分布与 P0-verify 的存档护栏相同");
eq(checkSaveBeltCodes(save), 0, "C3 code == 1+rv 违反数 0（beltCode 唯一权威）");

const mine = topologyScore(save);
eq([mine.dnOk, mine.dnT], [1267, 1268], `C4 槽位法下游闭合 ${mine.dnOk}/${mine.dnT}（logic.js:391-470 的独立算法）`);
eq([mine.bothOk, mine.bothT], [mine.bothOk, 69], `C5 弯带双侧闭合 ${mine.bothOk}/69`);
eq(mine.bothOk, 69, "C6 双侧闭合 69 条 = P0-verify 实测值（verify-belt-rules.md §3.2 H1）");

{
    // 从 P0-verify 的测试源码里**读出**它断言的常数，与我自己算出的数字比 → 两份代码 0 差异
    const tsrc = fs.readFileSync(path.join(ROOT, "src/ai/belt-rules.test.mjs"), "utf8");
    const dnOk = /assert\.equal\(s\.dnOk,\s*(\d+)\)/.exec(tsrc);
    const dnT = /assert\.equal\(s\.dnT,\s*(\d+)\)/.exec(tsrc);
    const bothOk = /assert\.equal\(s\.bothOk,\s*(\d+)\)/.exec(tsrc);
    const bothT = /assert\.equal\(s\.bothT,\s*(\d+)\)/.exec(tsrc);
    ok(dnOk && dnT && bothOk && bothT, "C7 从 belt-rules.test.mjs 解析到 4 个断言常数（对拍不是我自己定的数）");
    if (dnOk && dnT && bothOk && bothT) {
        eq([mine.dnOk, mine.dnT, mine.bothOk, mine.bothT],
            [Number(dnOk[1]), Number(dnT[1]), Number(bothOk[1]), Number(bothT[1])],
            `C8 **双实现 0 差异**：槽位法(${mine.dnOk}/${mine.dnT}, ${mine.bothOk}/${mine.bothT}) == OPP 回指法(${dnOk[1]}/${dnT[1]}, ${bothOk[1]}/${bothT[1]})`);
    }
    // 实跑 P0-verify 自己的测试（同一数据、独立代码），退出码必须 0
    let verifyPass = false, verifyOut = "";
    try {
        verifyOut = execFileSync(process.execPath, ["--test", path.join(ROOT, "src/ai/belt-rules.test.mjs")], { encoding: "utf8", cwd: ROOT });
        verifyPass = true;
    } catch (e) { verifyOut = String(e.stdout || e.message).slice(0, 400); }
    const nPass = /pass\s+(\d+)/.exec(verifyOut) || /ℹ pass (\d+)/.exec(verifyOut);
    ok(verifyPass, "C9 `node --test src/ai/belt-rules.test.mjs` 实跑通过（P0-verify 那份代码也认这份数据）", verifyOut.slice(0, 200));
    ok(nPass && Number(nPass[1]) >= 16, `C10 P0-verify 通过条数 ${nPass ? nPass[1] : "?"} ≥ 16`, verifyOut.slice(0, 200));
}

{
    // 含机器邻居 vs 只喂带子：证明"现成脚本的 82.5% 不可复用"这条纪律是**真的**
    const withMachines = saveFixedPointScore(save, { machineNeighbors: true });
    const beltOnly = saveFixedPointScore(save, { machineNeighbors: false });
    ok(withMachines.pct > beltOnly.pct, `C11 含机器邻居的不动点吻合 ${withMachines.pct}% > 只喂带子 ${beltOnly.pct}%（proto 脚本口径不可复用）`);
    ok(withMachines.total === 1906 && beltOnly.total === 1906, "C12 两种口径的分母都是 1906 条带子");
    results.push(`    ℹ 存档带子不动点吻合率：含机器邻居 ${withMachines.pct}% / 只喂带子（proto 口径）${beltOnly.pct}%`);
    results.push(`    ℹ 对拍闭合数：槽位法 dnOk=${mine.dnOk}/${mine.dnT}、bothOk=${mine.bothOk}/${mine.bothT}`);
}

{
    // 同一个文件里两条入口必须给同一个数（belt-sim 内部一致性；不是"双实现"那条腿）
    const asPlan = save.filter(e => e.type === "belt").map(e => ({
        code: beltCode(e.rotation_variant), dx: e.x, dy: e.y, rot: e.r, nodeId: `belt@${e.x},${e.y}`,
        kind: "belt", rotationVariant: e.rotation_variant, inDir: beltEntry(e.rotation_variant, e.r), outDir: beltExit(e.rotation_variant, e.r),
    }));
    const layout = { grid: "", rows: [], placements: [], channels: [], lanes: [], hubConnection: null, bbox: [0, 0], occupancy: [], conflicts: [], cornerCount: 0 };
    const sim = simulateBelts(layout, { entities: asPlan });
    const beltOnly = saveFixedPointScore(save, { machineNeighbors: false });
    eq(sim.tilesChecked, 1906, "C13 simulateBelts 认到全部 1906 条带子");
    eq(sim.fixedPoints, beltOnly.ok, `C14 simulateBelts 与 saveFixedPointScore 在同一子集上吻合数一致（${beltOnly.ok}）—— 同一份数据的两条入口`);
    eq(sim.drift.length, sim.tilesChecked - sim.fixedPoints, "C15 drift 数 = tilesChecked − fixedPoints（自洽）");
    ok(sim.includesMachineNeighbors === true, "C16 simulateBelts 恒报 includesMachineNeighbors=true（§2.4 硬规定，即使这批数据里没有机器）");
    eq([sim.iterations, sim.converged], [0, false], "C16b iterate 默认关（权威判据是逐格单步；迭代是 opt-in）");
    {
        // 全局不动点搜索（opt-in）：人工摆放的存档必须**收敛**（收敛 ≠ 每格是不动点，
        // 它说明反复重算不会发散/震荡 —— 编译器产的图则要求第一轮就稳定）
        const it = simulateBelts(layout, { entities: asPlan, iterate: true });
        ok(it.converged === true, `C16c 存档 1906 条带子的全局迭代收敛（${it.iterations} 轮）`);
        ok(it.drift.length === sim.drift.length, "C16d 迭代后的 drift 集合与单步判据同源（迭代不改设计态判定）");
    }
}

{
    // ★ 2×2 矩阵：邻居口径 × originalRotation 口径。这是"proto 的 82.5% 不可复用"的**量化证据**，
    //   也是红队 #3a（orig 丢失）与 #4（机器邻居）两条攻击线在同一批数据上的交叉点。
    const SHIFT = { 0: 0, 1: 90, 2: 270 };                 // belt.js:210/216 的 +270/+90 两支（proto :74 同款）
    const withMachines = buildWorldModel(save.map(e => ({ type: e.type, variant: e.variant, x: e.x, y: e.y, r: e.r, rv: e.rotation_variant, code: e.code })));
    const beltsOnlyWorld = buildWorldModel(save.filter(e => e.type === "belt").map(e => ({ type: "belt", variant: "default", x: e.x, y: e.y, r: e.r, rv: e.rotation_variant })));
    const belts = save.filter(e => e.type === "belt");
    const score = (world, origFn) => {
        let ok = 0;
        for (const b of belts) {
            const g = computeBelt({ rotation: origFn(b), neighbors: neighborsAffecting(world, b.x, b.y) });
            if (g.rotation === norm360(b.r) && g.rotationVariant === b.rotation_variant) ok++;
        }
        return +(ok / belts.length * 100).toFixed(1);
    };
    const origR = b => norm360(b.r);                                       // stride=4 粘贴后的真实状态（bridge:814）
    const origInferred = b => norm360(norm360(b.r) - SHIFT[b.rotation_variant]);   // proto 的 inferOrig
    const cell = {
        beltOnly_origR: score(beltsOnlyWorld, origR),
        machines_origR: score(withMachines, origR),
        beltOnly_inferred: score(beltsOnlyWorld, origInferred),
        machines_inferred: score(withMachines, origInferred),
    };
    results.push(`    ℹ 2×2 不动点吻合率矩阵：${JSON.stringify(cell)}`);
    ok(cell.machines_origR > cell.beltOnly_origR, `C17 喂机器邻居提高吻合率（${cell.machines_origR}% > ${cell.beltOnly_origR}%）→ proto 只喂带子的口径确实是低估`);
    ok(cell.machines_inferred > cell.beltOnly_inferred, `C18 换 orig 口径后同样成立（${cell.machines_inferred}% > ${cell.beltOnly_inferred}%）`);
    ok(Math.abs(cell.beltOnly_inferred - 82.5) < 3, `C19 我的实现复现 proto 的 82.5% 基线（belt-only + inferOrig = ${cell.beltOnly_inferred}%，差 ${Math.abs(cell.beltOnly_inferred - 82.5).toFixed(1)}pt）`);
    ok(cell.machines_origR >= 90, `C20 编译器侧口径（含机器邻居 + orig=r）吻合率 ${cell.machines_origR}%：剩下的 ${cell.machines_origR >= 99 ? "0" : (100 - cell.machines_origR).toFixed(1)}% 是**人工摆放**留下的非不动点，正是 V3 要在编译器产物上排除的东西`);
    results.push("    ℹ 注：world-full.json 无 originalRotation（obs 只回 code/r/rv，bridge:441-456）；");
    results.push("       orig=r 这一列就是 stride=4 粘贴后世界的真实状态 ⇒ 对编译器的意义最直接（plan §1.6 D2）。");
}

/* ═══════════════════════════ D. golden ═══════════════════════════ */
group("D golden report-validator.json round-trip + 三金样例");

{
    const a = assertValidatorReport(F.golden, "validation");
    const b = assertValidatorReport(JSON.parse(JSON.stringify(a)), "validation(rt)");
    eq(b, a, "D1 golden round-trip 逐字段等（assert → JSON → parse → assert）");
    eq(Object.keys(a).sort(), ["beltSim", "checks", "errors", "pass", "shapeReplay", "throughput"], "D2 顶层六字段齐全（§2.4）");
    eq(a.checks.map(c => c.id), F.golden.checks.map(c => c.id), "D3 checks 顺序与 id 保持");
    eq(a.checks.map(c => c.status), ["pass", "fail", "fail", "pass", "pass", "pass", "pass", "pass", "fail", "pass", "pass"], "D4 三条 fail = V2/V3/V9（plan §2.7 的故意错）");
    eq(a.errors.length, 3, "D5 errors 非空且 3 条");
    eq(a.errors.map(e => e.check), ["V2-no-overwrite-existing-belt", "V3-belt-fixed-point", "V9-unused-outlet"], "D6 errors[].check 与 fail 的 check 一一对应");
    eq(a.beltSim, { tilesChecked: 4, fixedPoints: 3, drift: [{ cell: [6, 0], wantRv: 2, gotRv: 0 }], includesMachineNeighbors: true }, "D7 beltSim 段逐字段等（drift 1 格、wantRv=2）");
    eq(a.shapeReplay.length, 2, "D8 shapeReplay 2 个节点");
    eq(a.throughput, { demandPerSec: 0.2, bottleneck: { nodeId: "n1", ratePerSec: 0.5 }, rowsRequired: 1, rowsPlanned: 1 }, "D9 throughput 段逐字段等");
    for (const c of a.checks) ok(typeof c.evidence.note === "string" && c.evidence.note.length > 0, `D10 ${c.id} 的 evidence.note 非空`);
}

{
    // golden 场景重放：V2/V3/V9 三条错**同时**注入一张图，必须复现 golden 的三条 fail id。
    // 几何按 golden 的 evidence 反推（belt-rules 现算，不猜）：
    //   · 矿机 (0,1) 出 top → cutter 左格 (0,0) bottom 进（喂住 V4 的 e 判据）
    //   · cutter 左格 (0,0) 的 top 输出**没接走** ⇒ V9 fail（cell [0,0]、node n1）
    //   · 既有可替换带 (5,0) 被规划带压住 ⇒ V2 fail（cell [5,0]）
    //   · (7,0) 一台 trash，它的 left acceptor 落在 (6,0) 那条直带的**局部右侧**
    //     ⇒ computeBelt 走支② 返回 rv=2、rotation 不变 ⇒ V3 drift{wantRv:2, gotRv:0}（cell [6,0]）
    //     这正是 golden 里那条 drift 的产生机制（邻居含机器的角落）。
    const bad = {
        ok: false, goal: "----CuCu",
        layout: {
            grid: "", rows: [], channels: [], lanes: [], hubConnection: null, bbox: [8, 2], conflicts: [], cornerCount: 0,
            placements: [
                { nodeId: "n0", op: "mine", kind: "miner", cell: [0, 1], rot: 0, footprint: [1, 1] },
                { nodeId: "n1", op: "cut", kind: "cutter", cell: [0, 0], rot: 0, footprint: [2, 1] },
                { nodeId: "t7", op: "trash", kind: "trash", cell: [7, 0], rot: 0, footprint: [1, 1] },
            ],
            occupancy: [],
        },
    };
    const r = validate(bad, {
        entities: [
            { code: 1, dx: 5, dy: 0, rot: 0, nodeId: "belt@5,0", instanceIdx: 0, kind: "belt", rotationVariant: 0, inDir: "bottom", outDir: "top" },
            { code: 1, dx: 6, dy: 0, rot: 0, nodeId: "belt@6,0", instanceIdx: 0, kind: "belt", rotationVariant: 0, inDir: "bottom", outDir: "top" },
        ],
        world: { entities: [], replaceableBeltCells: ["5,0"] },
        checkEntityOrder: false,
    });
    const fails = r.checks.filter(c => c.status === "fail").map(c => c.id).sort();
    eq(fails, ["V2-no-overwrite-existing-belt", "V3-belt-fixed-point", "V9-unused-outlet"].sort(),
        "D11 重放复现 golden 的三条 fail（V2/V3/V9），且**只**这三条", JSON.stringify(fails));
    eq(r.checks.find(c => c.id === "V2-no-overwrite-existing-belt").evidence.cell, [5, 0], "D12 V2 的 failingNode = (5,0)（golden 同值）");
    eq(r.checks.find(c => c.id === "V9-unused-outlet").evidence.cell, [0, 0], "D13 V9 的 failingNode = cutter 左格 (0,0)（golden 同值）");
    const v3 = r.checks.find(c => c.id === "V3-belt-fixed-point");
    eq(v3.evidence.cell, [6, 0], "D14 V3 的 failingNode = (6,0)（golden 同值）");
    eq(r.beltSim.drift, [{ cell: [6, 0], wantRv: 2, gotRv: 0 }], "D15 beltSim.drift 与 golden 的 drift 逐字段等（wantRv=2 gotRv=0）");
    eq(F.golden.beltSim.drift, r.beltSim.drift, "D16 drift 直接对拍 golden 文件本身");
    ok(r.pass === false && r.errors.length >= 3, "D17 pass:false 且 errors 非空（golden 语义成立）", JSON.stringify(r.errors.map(e => e.check)));
    ok(v3.evidence.note.length > 20 && /机器/.test(r.checks.find(c => c.id === "V3-belt-fixed-point").evidence.note || r.beltSim.drift[0].note + ""), "D18 V3 的 note 点名『邻居含机器』这条根因");
}

{
    // plan §5 L1.5 门的字面判据 + 被染项必须点名阻断者（不静默跳过）
    for (const [name, report] of [["plan-l1", validate(F.plan)], ["report-layout", validate(F.layout, { entities: F.intent.entities })]]) {
        const gate = report.pass && report.beltSim.includesMachineNeighbors === true && report.beltSim.drift.length === 0;
        ok(gate, `D19 L1.5 可布性闸 ${name}：PASS`);
    }
    // "被染"= 因**别的** check fail 而变成 not-applicable 的那些（V7 的 demand=0、V3 的无带子
    // 是判据自身的 not-applicable，不算被染）。被染项的 note 必须写出阻断者/派生来源。
    const SELF_NA = [
        /^v1 口径/, /^规划区无带子格/, /^无可重放的节点/, /^无可算速率的机器/,
        /^本条未执行/, /^落点矩形全空（r=0 包围盒）$/,
    ];
    let naive = [], mislabeled = 0;
    for (const c of cases) {
        const { input, opts } = c.make();
        const r = validate(input, opts);
        const anyFail = r.checks.some(x => x.status === "fail");
        for (const x of r.checks.filter(y => y.status === "not-applicable")) {
            const selfNa = SELF_NA.some(re => re.test(x.evidence.actual || "")) || SELF_NA.some(re => re.test(x.evidence.note || ""));
            if (selfNa) continue;                                    // 判据自身不适用（与别的 check 无关）
            if (/前置闸|派生自|阻断/.test(x.evidence.note)) { mislabeled++; continue; }
            naive.push([c.id, x.id, String(x.evidence.note).slice(0, 50)]);
        }
    }
    eq(naive, [], "D20 所有被染的 check 都在 note 里点名了阻断者（不静默跳过）", JSON.stringify(naive).slice(0, 400));
    ok(mislabeled > 0, `D21 确实存在"被前置闸阻断"的被染项（${mislabeled} 个）—— 证明阻断机制在被用到`);
}

/* ═══════════════════════════ E. lint ═══════════════════════════ */
group("E import lint（禁用 proto/belt-rules 那份错误副本）");

{
    const own = ["../../../src/ai/compiler/validate.mjs", "../../../src/ai/compiler/belt-sim.mjs"].map(p => path.resolve(HERE, p));
    for (const f of own) {
        const specs = collectImportSpecifiers(fs.readFileSync(f, "utf8"));
        ok(specs.every(s => !isProtoBeltRules(s)), `E1 ${path.basename(f)} 不 import proto/belt-rules`);
        ok(!specs.some(s => /proto\/belt-rules/.test(s)), `E2 ${path.basename(f)} 无任何指向 proto/belt-rules 的规格符`);
    }
    const problems = lintDirectory(path.join(ROOT, "src/ai/compiler"));
    const mine = problems.filter(p => /validate\.mjs|belt-sim\.mjs/.test(p.file));
    eq(mine, [], "E3 P1 的 lintDirectory 对本包两个文件 0 违规");
    eq(lintDirectory(path.join(HERE)), [], "E3b 本包目录（test/mutation-cases/results）也 0 违规");
    // 唯一的 proto/* import = proto/shape-ops.mjs（plan §2.4 S1 明写"只 import 不改"），
    // 且**绝不**是 proto/belt-rules（红队 #1(2) 的错误副本）。这条纪律要写进断言，不能只靠自觉。
    const OWN = ["src/ai/compiler/validate.mjs", "src/ai/compiler/belt-sim.mjs", "research/ai-plan/validator/test.mjs", "research/ai-plan/validator/mutation-cases.mjs"];
    const allProto = OWN.flatMap(f => collectImportSpecifiers(fs.readFileSync(path.join(ROOT, f), "utf8")).filter(s => /proto\//.test(s)));
    eq([...new Set(allProto)], ["../../../research/ai-player/proto/shape-ops.mjs"], "E4 唯一的 proto/* import 是 shape-ops（S1  mandated），proto/belt-rules 出现 0 次");
    ok(!allProto.some(isProtoBeltRules), "E5 无 proto/belt-rules import");
    // 不 import P3/P4 的实现（plan §7.2：P5 与 P3/P4 真并行）
    const p34 = OWN.flatMap(f => collectImportSpecifiers(fs.readFileSync(path.join(ROOT, f), "utf8")).filter(s => /\/(route|lane|place|emit|roundtrip|compile)\.mjs/.test(s)));
    eq(p34, [], "E6 不 import P3/P4/P6/P8 的实现（防环；P4 的常数改用源码文本对拍，见 A3/A4）");
    results.push(`    ℹ lintDirectory 对 src/ai/compiler 全目录报告 ${problems.length} 条（其中 P5 文件 ${mine.length} 条；其余属别的包，只在 NOTES 点名不改）`);
    for (const p of problems.filter(x => !/validate|belt-sim/.test(x.file))) results.push(`      · ${path.basename(p.file)}: ${p.kind} → ${p.detail}`);
}

/* ═══════════════════════ F. 交叉一致性（P1 的 assert 兜住） ═══════════════════════ */
group("F 报告自洽（checks ↔ errors、drift ↔ V3）");
{
    let bad = 0;
    for (const c of cases) {
        const { input, opts } = c.make();
        // ⚠️ allMessages 的形态不统一：ContractViolation 聚合时是**字符串**（已 join 过），
        //    单条时可能是数组或 undefined。旧代码直接 .join() ⇒ 一旦聚合路径被走到就 TypeError，
        //    把「测试报告里的一条失败」变成「测试进程崩掉」（本轮的互逆判据正好走这条路）。
        const msg = e => {
            const a = e && e.allMessages;
            if (Array.isArray(a)) return a.join(" ;; ");
            if (typeof a === "string" && a) return a;
            return String((e && e.message) || e);
        };
        try { validate(input, { ...opts, strict: true }); } catch (e) { bad++; results.push(`      ✗ ${c.id}: ${msg(e).slice(0, 200)}`); }
    }
    try { validate(F.plan, { strict: true }); validate(F.layout, { entities: F.intent.entities, strict: true }); } catch (e) { bad++; results.push(`      ✗ good fixture: ${e.message.slice(0, 200)}`); }
    ok(bad === 0, "F1 全部 19 条注入 + 2 张 good 报告的 ValidatorReport 都过 P1 的 assertValidatorReport");
}

/* ═══════════════════════ G. CLI（plan §5 的 L1.5 门命令） ═══════════════════════ */
group("G CLI：--plan 接 CompiledPlan / LayoutReport / ValidatorReport 三种输入");
{
    const run = args => {
        const r = spawnSync(process.execPath, [path.join(ROOT, "src/ai/compiler/validate.mjs"), ...args], { encoding: "utf8", cwd: ROOT });
        return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
    };
    const a = run(["--plan", "research/ai-plan/fixtures/plan-l1.json"]);
    eq(a.code, 0, "G1 CompiledPlan → 退出码 0（过闸）");
    ok(/可布性闸：PASS/.test(a.err), "G2 stderr 明写 PASS");
    ok(JSON.parse(a.out).beltSim.includesMachineNeighbors === true, "G3 stdout 是合法 JSON 报告且 includesMachineNeighbors=true");

    const b = run(["--plan", "research/ai-plan/fixtures/report-layout.json", "--intent", "research/ai-plan/contract/merge-belt-intent.json"]);
    eq(b.code, 0, "G4 LayoutReport + --intent（带子意图表）→ 过闸");
    eq(JSON.parse(b.out).beltSim.tilesChecked, 24, "G5 带子数取到 intent 表的 24 格");

    const b2 = run(["--plan", "research/ai-plan/fixtures/report-layout.json"]);
    eq(b2.code, 2, "G6 LayoutReport 不给带子意图 → UNDECIDABLE（退出码 2：闸拒绝在'判不了'时给绿灯）");
    ok(/UNDECIDABLE/.test(b2.err), "G7 stderr 明说判不了的原因", b2.err.slice(0, 200));

    const c = run(["--plan", "research/ai-plan/fixtures/report-validator.json"]);
    eq(c.code, 1, "G8 *.validator.json（plan §5 命令喂的形态）→ 走报告审计，故意错的报告退出码 1");
    ok(/validator-report-audit/.test(c.out), "G9 报告审计模式被显式标出");
    {
        const caud = JSON.parse(c.out);
        ok(caud.gate === false && caud.gateReasons.length >= 2, `G10 golden 报告**自洽**（problems=${caud.problems.length}）但不该过闸（gateReasons: ${caud.gateReasons.join(" / ")}）`, JSON.stringify(caud.problems));
        eq(caud.problems, [], "G10b 审计没有把『如实报告失败』当成『报告有 bug』（problems 与 gateReasons 分开）");
        eq(caud.contractOk, true, "G10c golden 过 P1 的 assertValidatorReport（P1/P5 契约互认）");
    }

    eq(run(["--plan", "research/ai-player/facts/live/world-full.json"]).code, 2, "G11 认不出的文件 → 退出码 2（用法错误），不崩溃");
    eq(run(["--plan", "does-not-exist.json"]).code, 2, "G12 文件不存在 → 退出码 2");
    eq(run([]).code, 2, "G13 缺 --plan → 用法提示 + 退出码 2");

    // P8 交接路径：真报告落盘 → 再喂回 CLI 应当过闸
    const tmp = path.join(HERE, "results", "_cli-roundtrip.json");
    fs.writeFileSync(tmp, JSON.stringify(validate(F.plan), null, 2), "utf8");
    eq(run(["--plan", path.relative(ROOT, tmp)]).code, 0, "G14 我自己产的报告喂回 CLI（P8 交接路径）→ 过闸");
    fs.unlinkSync(tmp);
}

/* ═══════════════════════ H. 三态占用的真值归属（plan §3 仲裁） ═══════════════════════ */
group("H 三态占用与分层序一律用 P1 的原语");
{
    const src = fs.readFileSync(path.join(ROOT, "src/ai/compiler/validate.mjs"), "utf8");
    ok(/from "\.\/grid\.mjs"/.test(src) && /Grid, SOLID, REPLACEABLE, PLACE_MACHINE, PLACE_BELT/.test(src),
        "H1 validate.mjs 的三态与冲突矩阵 import 自 P1 的 grid.mjs（不另写一份占用语义）");
    ok(/Grid\.placementConflicts|g\.placementConflicts/.test(src), "H2 V1/V2 走 Grid.placementConflicts（P1 的只读判定）");
    ok(/from "\.\/types\.mjs"/.test(src) && /entityOrderPhase/.test(src), "H3 分层序用 P1 的 entityOrderPhase（plan §3：共享真值不许二次实现）");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/occupied_solid|occupied_replaceable/.test(codeOnly), "H4 代码里没有把 P1 的态名硬抄成字符串常量（只 import；注释里提及不算）");

    // 行为等价性：同一份既有世界，P5 报的冲突必须与直接问 Grid 一致
    const p = JSON.parse(JSON.stringify(F.plan));
    // (0,3) 是既有机器（撞规划带子 belt@0,3）；(1,3) 是既有可替换带（撞规划带子 belt@1,3）
    //   → 两个**独立**缺陷，必须分别归 V1 与 V2，不能混报也不能漏
    p.world = { entities: [{ uid: 901, type: "cutter", x: 0, y: 3, r: 0, variant: "default", rotationVariant: 0, code: 9, layer: "regular" }], replaceableBeltCells: ["1,3"] };
    const grid = worldGrid(normalizeInput(p));
    const direct = grid.placementConflicts(0, 3, 2, 1, PLACE_MACHINE).length;
    const r = validate(p, { checkEntityOrder: false });
    const v1 = r.checks.find(c => c.id === "V1-occupancy");
    ok(direct > 0, `H5 直接问 Grid：机器矩形 (0,3) 2×1 有 ${direct} 处冲突`);
    eq(v1.status, "fail", "H6 V1 与 Grid 的判定一致（压既有 cutter → fail）");
    eq(v1.evidence.cell, [0, 3], "H7 V1 的 failingNode 指到真正被撞的那格 (0,3)");
    const v2 = r.checks.find(c => c.id === "V2-no-overwrite-existing-belt");
    eq(v2.status, "fail", "H8 V2 独立报出可替换带重叠（没有被 V1 吞掉 —— 归因唯一不等于合并）");
    eq(v2.evidence.cell, [1, 3], "H9 V2 的 failingNode 指到 (1,3)");
    const ids = r.checks.filter(c => c.status === "fail").map(c => c.id).sort();
    eq(ids, ["V1-occupancy", "V2-no-overwrite-existing-belt"], "H10 两条独立缺陷各自归位（solid→V1，可替换带→V2）");
}

/* ═══════════════════════ I. 回归锁（§2.4 硬规定 + C7 报告口径） ═══════════════════════ */
group("I 回归锁（§2.4 硬规定 + C7 报告口径）");
{
    const r = validate(F.plan);
    eq(r.beltSim.includesMachineNeighbors, true, "I1 includesMachineNeighbors 恒 true（proto 脚本只喂带子的口径被禁）");
    const broken = JSON.parse(JSON.stringify(r)); broken.beltSim.includesMachineNeighbors = false;
    ok(throws(() => assertValidatorReport(broken, "x")), "I2 includesMachineNeighbors:false 被 P1 契约拦住（不靠自觉）");
    const broken2 = JSON.parse(JSON.stringify(r)); broken2.beltSim.drift = [{ cell: [0, 0], wantRv: 2, gotRv: 0 }];
    ok(throws(() => assertValidatorReport(broken2, "x")), "I3 drift 非空而 V3=pass 被契约拦住（drift↔V3 是硬断言）");
    const broken3 = JSON.parse(JSON.stringify(r)); broken3.pass = false;
    ok(throws(() => assertValidatorReport(broken3, "x")), "I4 pass:false 但 errors:[] 被契约拦住（P8 不会拿到无归因的红灯）");

    const p2 = JSON.parse(JSON.stringify(F.plan));
    p2.layout.placements.push({ nodeId: "stk", op: "stack", kind: "stacker", cell: [9, 9], rot: 0, footprint: [2, 1] });
    p2.entities.push({ code: 14, dx: 9, dy: 9, rot: 0, nodeId: "stk", instanceIdx: 0, kind: "stacker", rotationVariant: 0, inDir: "bottom", outDir: "top" });
    const r2 = validate(p2, { currentLevel: 1, checkEntityOrder: false });
    const v10 = r2.checks.find(c => c.id === "V10-unlock-report");
    ok(v10.status === "pass", "I5 V10 越级时状态仍是 pass（只报告），不 fail");
    ok(!r2.errors.some(e => e.check === "V10-unlock-report"), "I6 V10 永不进 errors[]");
    ok(/只报告不阻断|god-mode/.test(v10.evidence.note), "I7 V10 的 note 写明 god-mode 口径（C7 要求『通关』主张带标注）", v10.evidence.note.slice(0, 90));
    const r2b = validate(p2, { currentLevel: 1, checkEntityOrder: false, enforceUnlocks: true });
    ok(r2b.checks.find(c => c.id === "V10-unlock-report").status === "fail", "I8 enforceUnlocks:true（定位 A）才让 V10 变成阻断闸");
}

/* ═══════════════════════ J. P5 ⇄ P1/P8 交接 ═══════════════════════ */
group("J 我的报告塞回 CompiledPlan 仍被 P1 认（P8 交接路径）");
{
    const p = JSON.parse(JSON.stringify(F.plan));
    p.validation = validate(F.plan);                 // 用我的报告替换 fixture 存的那份
    let a;
    try { a = assertCompiledPlan(p, "plan"); ok(true, "J1 P8 把我的 validation 塞回 plan 后 assertCompiledPlan 通过"); }
    catch (e) { ok(false, "J1b assertCompiledPlan 接受我的报告", (e.allMessages || [e.message]).join(" ;; ").slice(0, 300)); }
    if (a) {
        const b = assertCompiledPlan(JSON.parse(JSON.stringify(a)), "plan(rt)");
        eq(Object.keys(b.validation).sort(), ["beltSim", "checks", "errors", "pass", "shapeReplay", "throughput"],
            "J2 往返后 validation 只剩 §2.4 的六字段（我附加的 suppressed 被 P1 规范化掉，不会污染交接件）");
        eq(b.validation.checks.length, 11, "J3 11 条 check 全在");
        eq(b.validation.pass, true, "J4 pass 保持");
    }
    // *.validator.json 是 P8 交给 P7 的交接件：CLI 能直接审计它（plan §5 的 L1.5 命令字面用的就是它）
    {
        const tmp = path.join(HERE, "results", "_handoff.validator.json");
        fs.writeFileSync(tmp, JSON.stringify(validate(F.plan), null, 2), "utf8");
        const r = spawnSync(process.execPath, [path.join(ROOT, "src/ai/compiler/validate.mjs"), "--plan", path.relative(ROOT, tmp)], { encoding: "utf8", cwd: ROOT });
        eq(r.status, 0, "J5 交接件（*.validator.json）喂回 CLI → 过闸（plan §5 L1.5 的字面命令形态）");
        ok(/validator-report-audit/.test(r.stdout), "J6 走的是报告审计分支");
        fs.unlinkSync(tmp);
    }
}

/* ═══════════════════════ K. hub 锚点反推（四个面各自算对） ═══════════════════════ */
group("K hub 锚点：hubConnection.entry → anchor 的面分支");
{
    // plan-l1 的 hub 原本在 occupancy 里；把 occupancy 清空、只留 hubConnection，
    // 就必须走"从入口格反推锚点"这条兜底路径。四个面都要算对
    //（曾一律按 y-4 = 底排专属，是 bug；I 组之前修的）。
    const base = JSON.parse(JSON.stringify(F.plan));
    const mk = (side, entry) => {
        const p = JSON.parse(JSON.stringify(base));
        p.layout.occupancy = [];
        p.layout.hubConnection = { entry, side, dir: side === "bottom" ? 0 : side === "top" ? 180 : side === "left" ? 90 : 270 };
        return p;
    };
    // 底排第 0 列入口 = anchor+[0,4] ⇒ anchor=[0,-4]（plan-l1 的真值）
    const rBottom = validate(mk("bottom", [0, 0]), { checkEntityOrder: false });
    eq(rBottom.checks.find(c => c.id === "V4-slot-alignment").status, "pass", "K1 side=bottom：反推 anchor=[0,-4]，端点仍对齐");
    // 四个面的偏移反推逐一验证（曾一律按 y-4 = 底排专属 → 顶/左/右三面全错）
    eq(hubAnchorOf(normalizeInput(mk("bottom", [0, 0]))), [0, -4], "K2 side=bottom：entry=anchor+[0,4] ⇒ anchor=entry+[0,-4]");
    eq(hubAnchorOf(normalizeInput(mk("top", [2, -5]))), [2, -4], "K3 side=top：entry=anchor+[0,-1] ⇒ anchor=entry+[0,1]");
    eq(hubAnchorOf(normalizeInput(mk("left", [1199, -1400]))), [1200, -1400], "K4 side=left：entry=anchor+[-1,0] ⇒ anchor=entry+[1,0]");
    eq(hubAnchorOf(normalizeInput(mk("right", [1204, -1399]))), [1200, -1399], "K5 side=right：entry=anchor+[4,0] ⇒ anchor=entry+[-4,0]");
    eq(hubAnchorOf(normalizeInput(mk("bogus", [700, 700]))), null, "K6 反解不出 → null（不猜锚点）");
    // 反解失败必须落到 V4 的 fail（不是静默 pass、也不是崩溃）
    const rJunk = validate(mk("bogus", [700, 700]), { checkEntityOrder: false });
    eq(rJunk.checks.find(c => c.id === "V4-slot-alignment").status, "fail", "K7 反解不出锚点 → V4 显式 fail（宁可不判也不猜）");
    // 硬凭据优先：world 里有 hub 实体时用它的坐标，不看 entry
    {
        const p = mk("top", [1200, -1401]);
        p.world = { entities: [{ uid: 1, type: "hub", x: 1200, y: -1400, r: 0, variant: "default", rotationVariant: 0, code: 26, layer: "regular" }], replaceableBeltCells: [] };
        eq(hubAnchorOf(normalizeInput(p, { world: p.world })), [1200, -1400], "K8 world.hub 实体优先于 entry 反推（有凭据就不猜）");
    }
    // occupancy 路径同样优先（plan-l1 用的就是这条）
    {
        const p = JSON.parse(JSON.stringify(base));
        eq(hubAnchorOf(normalizeInput(p)), p.layout.occupancy.reduce((a, o) => [Math.min(a[0], o.cell[0]), Math.min(a[1], o.cell[1])], [Infinity, Infinity]), "K9 occupancy 里的 hub 最小格 = 锚点（优先于 entry 反推）");
    }
}

/* ════════════════════════════ 输出 ════════════════════════════ */
export function runSelfTest() {
    // 入口从 validate.mjs 的 --test 调进来时，上面的顶层已跑完
    print();
    return failed ? 1 : 0;
}
function print() {
    for (const line of results) console.log(line);
    console.log(`\nP5 validator L0：${passed} pass / ${failed} fail`);
    console.log("变异矩阵（injected → caught_by, clean）：");
    for (const m of matrix) console.log(`  ${m.clean ? "✓" : "✗"} ${m.injected.padEnd(30)} → ${String(m.caught_by).padEnd(28)} clean=${m.clean}${m.note ? "  [" + m.note + "]" : ""}`);
    if (fs.existsSync(path.join(HERE, "results"))) {
        fs.writeFileSync(path.join(HERE, "results", "l0.json"), JSON.stringify({ passed, failed, matrix, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    } else {
        fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
        fs.writeFileSync(path.join(HERE, "results", "l0.json"), JSON.stringify({ passed, failed, matrix, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    }
    console.log(`→ 落盘 research/ai-plan/validator/results/l0.json`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("validator/test.mjs")) print();
if (failed) process.exitCode = 1;
