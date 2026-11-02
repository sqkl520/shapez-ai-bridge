/**
 * `remove_machine` —— 删掉一台机器（hub 除外）。
 *
 * ## 为什么需要这个宏
 *
 * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）把三条路全堵死了：
 *
 *   · 接在**铜切割机**上的那台矿机 `@(4,-16)` 脚下**没有矿**（7×7 邻域一格都没有）
 *     ⇒ 永久零产出，整条铜线因此从来没跑起来；
 *   · 它同时**占着 cutter 的输入口**（cutter 在 `(4,-17)`，输入槽朝下）；
 *   · 模型想换掉它，但：
 *       - `insert_machine` 报 `blocked_by_machine`（"机器永远不会被覆盖"）
 *       - `connect` 的路径被 `trash@(3,-18)` 挡住；**删掉 trash 之后还是撞 rotater**
 *       - `max_cells` 提到 3000 也一样 —— `connect` 在**第一处冲突就放弃**，不绕路
 *
 * 也就是说：**没有任何宏能移除一台挡路的机器**。`remove_run` 明确只处理带子
 * （"要删机器是另一个动作"），而那个"另一个动作"一直没被实现。
 *
 * ## 与 remove_run 的分工（都是有意的）
 *
 * | | remove_run | remove_machine |
 * |---|---|---|
 * | 目标类型 | 只允许带子 | 只允许机器 |
 * | hub | 不涉及 | **永不可删** |
 * | 连通性检查 | 有 | 无（一组机器不需要连通） |
 * | 拓扑后果 | orphaned outputs | starved 下游机器 |
 */
import { removeMachine, MACRO_IMPLS } from "./remove.mjs";
import { validateRemoveMachineArgs, ERROR_CODES, WARNING_CODES } from "./contract.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass++; console.log("✓ " + name); }
    catch (e) { fail++; console.log("✗ " + name + "  " + (e && e.message)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ""} got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };

/* ── 造一个最小世界 ── */
const HUB = 10000;
const CT = 200;      // cutter @ (4,-17)，输入槽在下方 (4,-16)
const BAD_MINER = 201; // 无矿矿机 @ (4,-16)，占着 cutter 的输入
const GOOD_MINER = 202;
const BELT = 300;
const TRASH = 400;

const ENTITIES = [
    { uid: HUB, type: "hub", x: 0, y: 0, r: 0, rotation_variant: 0, variant: "default" },
    { uid: CT, type: "cutter", x: 4, y: -17, r: 0, rotation_variant: 0, variant: "default" },
    { uid: BAD_MINER, type: "miner", x: 4, y: -16, r: 0, rotation_variant: 0, variant: "default" },
    { uid: GOOD_MINER, type: "miner", x: -9, y: 3, r: 0, rotation_variant: 0, variant: "default" },
    { uid: BELT, type: "belt", x: 3, y: -18, r: 0, rotation_variant: 0, variant: "default" },
    { uid: TRASH, type: "trash", x: 2, y: -18, r: 0, rotation_variant: 0, variant: "default" },
];
const CTX = { entities: ENTITIES };

/* ── R1：★ 核心 ★ 能删掉那台无矿矿机 ── */
t("R1 删掉挡路的无矿矿机", () => {
    const r = removeMachine({ uids: [BAD_MINER], opts: { allow_unwired: true } }, CTX);
    ok(r.ok, "应成功：" + JSON.stringify(r.error));
    eq(r.changed.removed_uids, [BAD_MINER]);
    eq(r.removed.length, 1);
    eq(r.removed[0].type, "miner");
});

/* ── R2：★ hub 永不可删 ── */
t("R2 hub 永不可删 ⇒ immutable", () => {
    const r = removeMachine({ uids: [HUB] }, CTX);
    ok(!r.ok, "删 hub 必须失败");
    eq(r.error.code, "immutable");
    ok(/hub/i.test(r.error.message), "报错要点名 hub");
});

/* ── R3：带子要走 remove_run ── */
t("R3 带子 ⇒ not_a_machine（指向 remove_run）", () => {
    const r = removeMachine({ uids: [BELT] }, CTX);
    ok(!r.ok);
    eq(r.error.code, "not_a_machine");
    ok(/remove_run/.test(r.error.hint || ""), "hint 要指向 remove_run");
});

/* ── R4：混单时整单拒绝（不「尽量删」） ── */
t("R4 混了 hub 和机器 ⇒ 整单拒绝，一个都不删", () => {
    const r = removeMachine({ uids: [BAD_MINER, HUB] }, CTX);
    ok(!r.ok, "必须整单拒绝");
    eq(r.error.code, "immutable");
    eq(r.changed.removed_uids, [], "失败时零删除");
});

/* ── R5：不存在的 uid ── */
t("R5 不存在的 uid ⇒ endpoint_not_found", () => {
    const r = removeMachine({ uids: [999999] }, CTX);
    ok(!r.ok);
    eq(r.error.code, "endpoint_not_found");
});

/* ── R6：★ 默认拒绝对「正在供料」的机器下手 ★
 *
 * 真机里的形态正是这样：无矿矿机 @(4,-16) 输出朝上，落点 (4,-17) 就是 cutter 的
 * 输入槽 —— 它在喂 cutter（虽然喂的是空气）。拆它会饿死 cutter，默认必须拒绝。
 */
t("R6 正在给下游供料的机器 ⇒ 默认 would_starve 并点名下游", () => {
    const r = removeMachine({ uids: [BAD_MINER] }, CTX);
    ok(!r.ok, "默认必须拒绝");
    eq(r.error.code, "would_starve");
    ok(/饿死/.test(r.error.message), "报错要说清后果");
    ok(/allow_unwired/.test(r.error.hint || ""), "hint 要给出放行开关");
    ok(Array.isArray(r.error.detail && r.error.detail.starved)
        && r.error.detail.starved.length > 0, "要列出会被饿死的下游");
    eq(r.changed.removed_uids, [], "失败时零删除");
});

/* ── R7：显式 allow_unwired ⇒ 放行 + 留警告 ── */
t("R7 allow_unwired=true ⇒ 放行且带 starves_downstream 警告", () => {
    const r = removeMachine({ uids: [BAD_MINER], opts: { allow_unwired: true } }, CTX);
    ok(r.ok, "显式放行后应成功");
    eq(r.changed.removed_uids, [BAD_MINER]);
    eq(r.warnings.map(w => w.code), ["starves_downstream"],
        "放行时必须留警告 —— 不许静默");
});

/* ── R8：错误码都在闭集里 ── */
t("R8 三个新错误码都在 ERROR_CODES 闭集里", () => {
    for (const c of ["immutable", "not_a_machine", "would_starve"]) {
        ok(c in ERROR_CODES, `${c} 必须登记在 ERROR_CODES`);
    }
    ok("starves_downstream" in WARNING_CODES, "starves_downstream 必须登记在 WARNING_CODES");
});

/* ── R9：校验器：形状 ── */
t("R9 校验器：空 uids / 非整数 / 重复 都拒", () => {
    ok(!validateRemoveMachineArgs({}).ok, "缺 uids");
    eq(validateRemoveMachineArgs({}).error.code, "missing_field");
    ok(!validateRemoveMachineArgs({ uids: [] }).ok, "空数组");
    ok(!validateRemoveMachineArgs({ uids: [1.5] }).ok, "非整数");
    ok(!validateRemoveMachineArgs({ uids: [-1] }).ok, "负数");
    ok(!validateRemoveMachineArgs({ uids: [1, 1] }).ok, "重复");
});

/* ── R10：校验器：只认 uids，不提供 cells 通道 ── */
t("R10 不提供 cells 通道（机器 footprint 会让坐标有歧义）", () => {
    const r = validateRemoveMachineArgs({ cells: [[4, -16]] });
    ok(!r.ok);
    eq(r.error.code, "unknown_field");
});

/* ── R11：注册表 ── */
t("R11 remove_machine 在 MACRO_IMPLS 里", () => {
    ok(typeof MACRO_IMPLS.remove_machine === "function");
});

/* ── R12：失败返回带 hint（可执行的下一步） ── */
t("R12 每个失败返回都带 hint", () => {
    const cases = [
        removeMachine({ uids: [HUB] }, CTX),
        removeMachine({ uids: [BELT] }, CTX),
        removeMachine({ uids: [999999] }, CTX),
        removeMachine({}, CTX),
    ];
    for (const r of cases) {
        ok(!r.ok, "应该失败");
        ok(typeof r.error.hint === "string" && r.error.hint.length > 0,
            `code=${r.error.code} 缺 hint`);
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
