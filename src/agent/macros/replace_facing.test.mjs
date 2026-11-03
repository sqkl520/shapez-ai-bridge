/**
 * `replace_run(opts.facing)` —— 显式指定带子方向。
 *
 * ## 为什么需要它
 *
 * 真机实测（2026-11-03）：4 处 `BELT_HANDOFF_REJECTED`，模型**每一处**都用
 * `replace_run` 去修方向错的那条带子，全部失败：
 *
 *   (1,-17) 的邻居证据不足以反解方向（入口 top / 出口 未知）
 *
 * 把 region 扩到 `[1,-18 .. 1,-16]` 也一样 —— 只要**包含**那一格就必然失败。
 *
 * 宏的判据是对的：只有一侧邻居时，另一侧在 3 个方向里任取一个都能让 solveTurn
 * 成立，那是三选一不是唯一解，不能猜。但它让「修一条方向错的带子」变成无解。
 *
 * ## 三条设计约束
 *
 * 1. **不能用这条带子自己记录的 rv 当输入** —— entry/exit 是由 rv 算出来的，
 *    拿它反解等于用坏数据自证（那正是这条路径要修的病）。
 *    所以只能由调用方显式给。
 * 2. `facing:"top"` 的语义是「**出口**朝 top」。带子的 entry 永远是 exit 的对面
 *    （`belt-rules` 里没有 entry===exit 的合法形态，那是直穿不是带子），
 *    所以 entry 由 exit 反推，不是照抄。
 * 3. **`beltEntry`/`beltExit` 返回方向名**（`"top"`），不是 0..3。
 *    拿数字比会永远不等 —— 这一条我写错过一次。
 */
import { replaceRun } from "./remove.mjs";
import { beltEntry, beltExit } from "../../ai/belt-rules.mjs";
import { validateReplaceRunArgs } from "./contract.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); pass++; console.log("✓ " + name); }
    catch (e) { fail++; console.log("✗ " + name + "  " + (e && e.message)); }
};
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ""} got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); };

/** 一条孤立带子（两侧都没有邻居证据）—— 正是真机上修不动的那种。 */
const LONE = [
    { uid: 1, type: "belt", x: 0, y: 0, r: 180, rotation_variant: 0, variant: "default" },
];
const CTX = { entities: LONE };
const FN = ["top", "right", "bottom", "left"];

/* ── F1：孤立带子无邻居时走「保持原样」分支（不是拒绝，也不是猜） ──
 *
 * 真机上真正会拒的是「**只有一侧**有邻居」那种（另一侧三选一）。
 * 两侧都没有邻居时，宏据实说「没有修复价值」，保持原样 —— 那是唯一说得通的解释。 */
t("F1 孤立带子不给 facing ⇒ 保持原样（不猜也不拒）", () => {
    const r = replaceRun({ region: [0, 0, 0, 0], building: "belt" }, CTX);
    ok(r.ok, "两侧都无邻居时保持原样，不算失败");
    const p = (r.placed || [])[0];
    eq(p.rotation, 180, "应保持原来的 rotation");
    eq(p.rotationVariant, 0, "应保持原来的 rv");
});

/* ── F2：★ 核心 ★ 给 facing 就能修 ── */
t("F2 给 facing 就能改方向", () => {
    const r = replaceRun({ region: [0, 0, 0, 0], building: "belt", opts: { facing: "top" } }, CTX);
    ok(r.ok, "应成功：" + JSON.stringify(r.error));
    const p = (r.placed || [])[0];
    ok(p, "要有 placed");
    /* 出口朝 top ⇒ rotation 0 */
    eq(p.rotation, 0, "facing=top 应得 rotation 0");
});

/* ── F3：四个方向都精确可控 ── */
t("F3 四个 facing 分别对应 rotation 0/90/180/270", () => {
    const want = { top: 0, right: 90, bottom: 180, left: 270 };
    for (const [face, rot] of Object.entries(want)) {
        const r = replaceRun({ region: [0, 0, 0, 0], building: "belt", opts: { facing: face } }, CTX);
        ok(r.ok, `facing=${face} 应成功：${JSON.stringify(r.error)}`);
        const p = (r.placed || [])[0];
        eq(p.rotation, rot, `facing=${face}`);
    }
});

/* ── F4：★ entry 必须是 exit 的对面（带子没有 entry===exit 的形态） ── */
t("F4 entry 由 exit 反推，不是照抄", () => {
    /* facing="top" ⇒ exit=top(0)，entry 必须是其对面 bottom(2)。
       若把它当成「entry=exit=top」会解不出任何合法形态。 */
    const r = replaceRun({ region: [0, 0, 0, 0], building: "belt", opts: { facing: "top" } }, CTX);
    ok(r.ok, "若 entry 照抄 exit 会失败 —— 成功即证明是反推的");
});

/* ── F5：{entry, exit} 形态能表达转弯 ── */
t("F5 {entry, exit} 能表达转弯", () => {
    const r = replaceRun(
        { region: [0, 0, 0, 0], building: "belt", opts: { facing: { entry: "bottom", exit: "right" } } },
        CTX,
    );
    ok(r.ok, "转弯形态应成功：" + JSON.stringify(r.error));
    const p = (r.placed || [])[0];
    /* entry=bottom(2) → exit=right(1) 是 rv=2 rot=0 */
        eq(beltEntry(p.rotationVariant, p.rotation), "bottom");
    eq(beltExit(p.rotationVariant, p.rotation), "right");
});

/* ── F6：只给 entry ⇒ exit 取对面 ── */
t("F6 只给 entry ⇒ exit 取对面", () => {
    const r = replaceRun(
        { region: [0, 0, 0, 0], building: "belt", opts: { facing: { entry: "left" } } },
        CTX,
    );
    ok(r.ok, "应成功：" + JSON.stringify(r.error));
    const p = (r.placed || [])[0];
        eq(beltEntry(p.rotationVariant, p.rotation), "left");
    eq(beltExit(p.rotationVariant, p.rotation), "right");
});

/* ── F7：非法值被拒 ── */
t("F7 非法的 facing 值被拒，且报错指明字段", () => {
    for (const bad of ["up", "TOP", "", 3, null, []]) {
        const r = replaceRun({ region: [0, 0, 0, 0], building: "belt", opts: { facing: bad } }, CTX);
        ok(!r.ok, `${JSON.stringify(bad)} 应被拒`);
        ok(/facing/.test(String(r.error.field || "")), `字段应指向 facing，实得 ${r.error.field}`);
    }
});

/* ── F8：机器模式下 opts.facing 被校验器拒 ──
 *
 * 用**校验器**直接验（不是跑整个 replaceRun）：宏的 region/供料前置检查
 * 会先拦下来，走不到 facing 那一步。契约层的判据必须独立可测。 */
t("F8 机器模式下 opts.facing 被校验器拒", () => {
    const v = validateReplaceRunArgs({ region: [0, 0, 1, 0], building: "cutter", opts: { facing: "top" } });
    ok(!v.ok, "应被拒");
    ok(/facing/.test(String(v.error.message || "")), "报错要提到 facing：" + JSON.stringify(v.error));
});

/* ── F9：facing 出现在 opts 白名单里（不报 unknown_field） ── */
t("F9 opts.facing 在白名单里", () => {
    const r = replaceRun({ region: [0, 0, 0, 0], building: "belt", opts: { facing: "top" } }, CTX);
    ok(!(r.error && r.error.code === "unknown_field"), "不该报 unknown_field");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
