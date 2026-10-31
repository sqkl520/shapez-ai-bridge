/**
 * tunnels_gate.test.mjs — 隧道（underground_belt）的**等级门控**回归。
 *
 * 背景（已实测确认的缺陷，2026-10-28）：
 *   `--tunnels` 只是"允许用隧道"，但旧编译器把它当成"已解锁" ——
 *   `--goal RuRu---- --level 4 --tunnels` 会产出 2 条 underground_belt 并报 ok:true，
 *   而游戏侧 `buildings/underground_belt.js:178-180` 要求 `isRewardUnlocked(reward_tunnel)`，
 *   该 reward 是 `modes/levels.js` 三套关卡表里**第 5 项（Cu----Cu）完成时**才授予的
 *   （`hub_goals.js:46-52` 按 `i < level-1` 回填 gainedRewards）。
 *   ⇒ 进行到 level=5 时仍拿不到；level≥6 才有。
 *
 * 覆盖（每条都带"必须红"的反向对照，否则测不出判据是在真判断还是恒绿）：
 *   A. level 4 / 5 + tunnels ⇒ 必须被拒，且 reason/code 明确（unlock:machine-not-available / tunnels-not-unlocked）
 *   B. level 6 + tunnels ⇒ 通过，且 scope.tunnels 如实地是 true（不再是写死的 false）
 *   C. level 4 不带 tunnels ⇒ 不受影响（失败原因仍是真的几何/空间原因，不是隧道门）
 *   D. 无隧道方案 + --tunnels（开关开着但没用上）⇒ 不受影响（不能误伤）
 *   E. `--enforce-unlocks` 开/关不影响本闸（它是产出前的硬门，不是 P5 的报告口径）
 *   F. P5 的 V10 现在能看见隧道（enforce 时阻断 / 默认只报告）
 *   G. 契约：scope.tunnels 必须与实体表一致（两向都拒）
 *
 * 全程离线：compilePlan 只 spawn 仓库内的 solver，零 RPC、零网络、不写交接件。
 * 用法：node --test src/ai/compiler/tunnels_gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compilePlan } from "./compile.mjs";
import { validate } from "./validate.mjs";
import { assertCompiledPlan } from "./types.mjs";
import { TUNNEL_UNLOCKED_LEVEL, UNLOCK_LEVEL_FALLBACK } from "../op-templates.mjs";
import { buildLine } from "../../agent/macros/build_line.mjs";

/* 固定参数：与任务书里的实测命令逐字一致（`RuRu---- --seed 60908 --hub -2,-2 --tunnels`）。
   这组参数是**唯一**已知会在 L4 上真的用到隧道的组合 —— 用来测门控正好。 */
const GOAL = "RuRu----";
const SEED = 60908;
const HUB = [-2, -2];
const base = { goal: GOAL, seed: SEED, hub: HUB };

const tunnelCount = p => (p && Array.isArray(p.entities) ? p.entities.filter(e => e.kind === "underground_belt").length : 0);

test("真值：隧道在 levels.js 第 5 关完成（level 6）后解锁", () => {
    assert.equal(TUNNEL_UNLOCKED_LEVEL, 6);
    assert.equal(UNLOCK_LEVEL_FALLBACK.tunnel, 5, "关卡表里的**关卡号**是 5（不是可用关卡）");
});

test("A1 level=4 + tunnels ⇒ 拒绝，reason=unlock:machine-not-available / code=tunnels-not-unlocked", () => {
    const p = compilePlan({ ...base, level: 4, tunnels: true });
    assert.equal(p.ok, false, "L4 上隧道未解锁，不得报 ok:true");
    assert.equal(p.reason, "unlock:machine-not-available");
    assert.equal(p.code, "tunnels-not-unlocked", "稳定标签供宏/CLI 分支（reason 是冻结枚举）");
    assert.equal(p.entities, null, "失败不得带实体表（绝不给半成品）");
    assert.ok(Array.isArray(p.tunnelCells) && p.tunnelCells.length >= 2, "失败凭据要写清「哪几格要隧道」", p.tunnelCells);
    assert.match(p.hint, /reward_tunnel/, "hint 必须给出真依据（levels.js 第 5 关完成时授予）");
    assert.match(p.hint, /去掉 --tunnels|去掉 opts\.tunnels/, "hint 要给出可行动的处置");
});

test("A2 level=5 + tunnels ⇒ 仍拒绝（L5 进行中还没拿到 reward_tunnel）", () => {
    const p = compilePlan({ ...base, level: 5, tunnels: true });
    assert.equal(p.ok, false, "第 5 关**进行中**没有 reward_tunnel —— 这是最容易写成 off-by-one 的地方");
    assert.equal(p.code, "tunnels-not-unlocked");
});

test("A3 level=1 + tunnels ⇒ 拒绝（原实测命令的复现）", () => {
    const p = compilePlan({ ...base, level: 1, tunnels: true });
    assert.equal(p.ok, false);
    assert.equal(p.code, "tunnels-not-unlocked");
});

test("B1 level=6 + tunnels ⇒ 通过（正向对照）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    assert.equal(p.ok, true, p.ok ? "" : `reason=${p.reason} hint=${p.hint}`);
    assert.equal(tunnelCount(p), 2, "这组参数在 L6 上会真的用隧道 —— 否则本正向对照测不到门");
    assert.ok(p.blueprint && p.blueprint.startsWith("SZBP1."));
});

test("B2 level=6 的产出 scope.tunnels 必须如实为 true（旧代码写死 false）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    assert.equal(p.ok, true);
    assert.equal(p.scope.tunnels, true, "产出里真有 underground_belt，scope 就不能说 tunnels:false");
    assert.equal(p.scope.layers, 1);
    assert.equal(p.scope.wires, false);
    assert.equal(p.scope.rotatedMachines, false);
    // 契约必须接受这个形态（否则 ok:true 的计划过不了 assertCompiledPlan）
    const norm = assertCompiledPlan(JSON.parse(JSON.stringify(p)), "plan");
    assert.equal(norm.scope.tunnels, true);
});

test("C level=4 不带 tunnels ⇒ 失败原因仍是几何/空间，不是隧道门", () => {
    const p = compilePlan({ ...base, level: 4 });
    assert.equal(p.ok, false, "这组参数在 L4 上本来就不成立（无隧道解法）");
    assert.notEqual(p.code, "tunnels-not-unlocked", "★不能把「本来就没有隧道」的方案也扣上隧道门");
    assert.equal(p.reason, "no-site-large-enough", `实得 ${p.reason}`);
});

test("D 无隧道方案 + --tunnels（开关开着但没用上）⇒ 不受影响", () => {
    // CuCuCuCu 不需要任何交叉 → place/route 不会用隧道。开关开着只是"允许"，不是"强制"。
    const on = compilePlan({ goal: "CuCuCuCu", seed: SEED, hub: HUB, level: 4, tunnels: true });
    const off = compilePlan({ goal: "CuCuCuCu", seed: SEED, hub: HUB, level: 4 });
    assert.equal(on.ok, true, "L4 的 CuCuCuCu 本身合法，不能被隧道门误伤");
    assert.equal(tunnelCount(on), 0, "本目标确实没用隧道（否则这条对照没意义）");
    assert.equal(on.blueprint, off.blueprint, "开关开着但没用上 ⇒ 产物与不开逐字节相同");
    assert.equal(on.scope.tunnels, false, "没用上就仍报 false（如实的「没用到」）");
});

test("E --enforce-unlocks 开/关不改变本闸（产出前的硬门，不是 P5 的报告口径）", () => {
    const on = compilePlan({ ...base, level: 4, tunnels: true, enforceUnlocks: true });
    const off = compilePlan({ ...base, level: 4, tunnels: true, enforceUnlocks: false });
    assert.equal(on.ok, false);
    assert.equal(off.ok, false, "默认（enforce 关）也必须拒 —— 否则默认配置下这道门形同虚设");
    assert.equal(on.code, off.code);
    assert.equal(on.reason, off.reason);
});

test("F1 P5 的 V10 能看见隧道：enforceUnlocks 关 ⇒ 只报告（pass + 越级清单）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });      // 借一份真含隧道的布局
    assert.equal(p.ok, true);
    const rep = validate({ layout: p.layout, entities: p.entities, scope: p.scope, goal: p.goal },
        { currentLevel: 4, enforceUnlocks: false });
    const v10 = rep.checks.find(c => c.id === "V10-unlock-report");
    assert.equal(v10.status, "pass", "god-mode 口径：只报告不阻断");
    assert.match(String(v10.evidence.actual), /越级/);
    assert.match(String(v10.evidence.actual), /underground_belt/, "★清单里必须真有隧道（旧实现只扫 placements，看不见它）");
    assert.equal(rep.errors.some(e => e.check === "V10-unlock-report"), false);
});

test("F2 P5 的 V10 能看见隧道：enforceUnlocks 开 ⇒ 阻断（fatal error）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    const rep = validate({ layout: p.layout, entities: p.entities, scope: p.scope, goal: p.goal },
        { currentLevel: 4, enforceUnlocks: true });
    const v10 = rep.checks.find(c => c.id === "V10-unlock-report");
    assert.equal(v10.status, "fail");
    assert.ok(rep.errors.some(e => e.check === "V10-unlock-report" && /underground_belt/.test(e.message)));
});

test("F3 V10 在 level=6 时不报隧道（不能反向误报）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    const rep = validate({ layout: p.layout, entities: p.entities, scope: p.scope, goal: p.goal },
        { currentLevel: 6, enforceUnlocks: true });
    const v10 = rep.checks.find(c => c.id === "V10-unlock-report");
    assert.equal(v10.status, "pass");
    assert.doesNotMatch(String(v10.evidence.actual), /underground_belt/);
});

test("F4 未给 currentLevel ⇒ V10 按 god-mode 不判定（不能因为缺 level 就报越级）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    const rep = validate({ layout: p.layout, entities: p.entities, scope: p.scope, goal: p.goal }, {});
    const v10 = rep.checks.find(c => c.id === "V10-unlock-report");
    assert.equal(v10.status, "pass");
    assert.doesNotMatch(String(v10.evidence.actual), /越级/);
});

test("G1 契约：scope.tunnels=true 但没有隧道实体 ⇒ 拒（声明假能力）", () => {
    const p = compilePlan({ goal: "CuCuCuCu", seed: SEED, hub: HUB, level: 6 });
    const bad = { ...JSON.parse(JSON.stringify(p)), scope: { ...p.scope, tunnels: true } };
    assert.throws(() => assertCompiledPlan(bad, "plan"), /scope\.tunnels/, "true 必须有实体支撑");
});

test("G2 契约：有隧道实体但 scope.tunnels=false ⇒ 拒（旧实现就在撒这个谎）", () => {
    const p = compilePlan({ ...base, level: 6, tunnels: true });
    const bad = { ...JSON.parse(JSON.stringify(p)), scope: { ...p.scope, tunnels: false } };
    assert.throws(() => assertCompiledPlan(bad, "plan"), /scope\.tunnels/, "false 而实体里有隧道 = 自相矛盾");
});

test("G3 契约：其余 scope 项仍是 v1 常量（放宽 tunnels 不能顺手放宽别的）", () => {
    const p = compilePlan({ goal: "CuCuCuCu", seed: SEED, hub: HUB, level: 6 });
    for (const [k, v] of [["layers", 2], ["wires", true], ["rotatedMachines", true], ["maxFanIn", 3]]) {
        const bad = { ...JSON.parse(JSON.stringify(p)), scope: { ...p.scope, [k]: v } };
        assert.throws(() => assertCompiledPlan(bad, "plan"), new RegExp(`scope\\.${k}`), `scope.${k} 仍必须被拒`);
    }
});

test("H 宏层：buildLine 的隧道门失败必须给出「去掉 tunnels」的 hint，而不是「等解锁」", () => {
    const r = buildLine(GOAL, { hub: HUB, seed: SEED, level: 4 }, { tunnels: true });
    assert.equal(r.ok, false);
    assert.equal(r.compilerReason, "unlock:machine-not-available");
    assert.match(r.hint, /tunnels/, "hint 必须指向那个开关（tunnel 的具体分支，不是通用「机器没解锁」）", );
    assert.doesNotMatch(r.hint, /等解锁，或换目标/, "不能被通用 unlock hint 吞掉");
});
