/**
 * `$ore` 算子 —— 让模型能指名「一格矿」而不用写坐标。
 *
 * ## 为什么需要它
 *
 * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）三轮里模型**每次都诊断对了**：
 *
 *   r1: "the only Cu miner sits on barren ground, so nothing is mined;
 *        **no ore handle is listed**, so I will put a working miner on the belt cell..."
 *   r2: "miner M1 sits on no ore and **no ore-patch handle is exposed**"
 *   r3: "its only miner sits on no ore and **no listed handle exposes the Cu patch**"
 *
 * 它明确说出了缺什么。矿格不是实体、没有句柄，而 `insert_machine.at` 只接受
 * `{cell}` / `[x,y]`，模型又不许写坐标 —— 于是只能猜（r1 猜 B7 的格）或写
 * 不合法形态（r2 用 `{at:{uid:M1}}`，被 `LLM_ARGS: unknown_field` 拒）。
 *
 * `$ore` 补的就是这一个洞：`{"$ore":"Cu"}` → `{cell:[x,y]}`（该矿种离 hub 最近的一格）。
 *
 * ## 硬约束
 *
 *   · 只接受**两字母矿种前缀**，不接受完整形状串（`CuCuCuCu` 也拒）——
 *     让模型写全串没有收益，反而容易写错
 *   · 地图上没有该矿种 ⇒ `ORE_NOT_FOUND`，绝不返回一个假坐标
 *     （返回假坐标会让矿机放在空地上，正是这次要修的那个 bug 的复现）
 *   · 产出的是 `{cell}`，和 `$ref` 的 `asCell` 同型，所以 `insert_machine.at` 不用改
 */
import { nearestOreCell, resolveOreRef, resolveRefs } from "./coords.mjs";
import { buildHandles } from "./handles.mjs";
import { buildTxPlan } from "../loop.mjs";
import { insertMachine } from "../macros/place.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log("PASS", name); }
    catch (e) { fail++; console.log("FAIL", name, "->", e && e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

/** hub 在 (0,0) 4×4 ⇒ 中心 (1.5,1.5)。 */
const mkObs = resources => ({
    entities: [],
    hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
    resources,
});

/* ── O1：★ 核心 ★ 选离 hub 最近的那一格 ── */
check("O1 取离 hub 最近的矿格", () => {
    const obs = mkObs([
        [50, 50, "CuCuCuCu"],     // 远
        [-9, 3, "CuCuCuCu"],      // 近：|−9−1.5|+|3−1.5| = 12
        [20, 20, "CuCuCuCu"],
    ]);
    const r = nearestOreCell(obs, "Cu");
    assert(r, "应找到铜矿");
    assert(r.cell[0] === -9 && r.cell[1] === 3, `应选 (-9,3)，实际 ${JSON.stringify(r.cell)}`);
    assert(r.kind === "CuCuCuCu", `kind 应为 CuCuCuCu，实际 ${r.kind}`);
    assert(r.count === 3, `count 应为 3，实际 ${r.count}`);
});

/* ── O2：只匹配前缀，不匹配别的矿种 ── */
check("O2 前缀匹配：Ru 不命中 Cu", () => {
    const obs = mkObs([[2, 2, "RuRuRuRu"], [50, 50, "CuCuCuCu"]]);
    const r = nearestOreCell(obs, "Ru");
    assert(r && r.kind === "RuRuRuRu", `应命中 RuRuRuRu，实际 ${JSON.stringify(r)}`);
});

/* ── O3：★ 没有该矿种 ⇒ null（绝不返回假坐标） ── */
check("O3 地图上没有该矿种 ⇒ null", () => {
    const obs = mkObs([[2, 2, "RuRuRuRu"]]);
    assert(nearestOreCell(obs, "Cu") === null, "没有铜矿时必须返回 null");
});

/* ── O4：没有 resources 数据 ⇒ null（不猜） ── */
check("O4 无 resources ⇒ null", () => {
    assert(nearestOreCell(mkObs(undefined), "Cu") === null);
    assert(nearestOreCell(mkObs([]), "Cu") === null);
});

/* ── O5：没有处理机器时退回 hub 中心 ── */
check("O5 没有机器时按 hub 中心算距离", () => {
    /* hub 在 (100,100) 4×4 ⇒ 中心 (101.5,101.5) */
    const obs = {
        entities: [],
        hub: { uid: 10000, x: 100, y: 100, w: 4, h: 4 },
        resources: [
            [0, 0, "CuCuCuCu"],        // 距 (101.5,101.5) = 203
            [102, 102, "CuCuCuCu"],    // 距 = 1
        ],
    };
    const r = nearestOreCell(obs, "Cu");
    assert(r.cell[0] === 102 && r.cell[1] === 102,
        `应选靠近偏移 hub 的那格，实际 ${JSON.stringify(r.cell)}`);
});

/* ── O6：resolveOreRef 的形状校验 ── */
check("O6 拒绝完整形状串 / 空串 / 非字符串（但接受颜料名）", () => {
    /* ★ 2026-11-12：判据放宽 ★
     *
     * 原来只收 `/^[A-Z][a-z]$/`（`Cu` / `Ru`），而世界的矿种里还有颜料矿
     * （`red` / `green` / `blue` / …）。第 9 关需要把红颜料接到 mixer 上，
     * 模型 r1 的 say 直接说「no handle exists for the blue/red ore field」——
     * 矿不是实体没有句柄，`$ore` 又不收 `red`/`blue` ⇒ **它没有任何合法方式
     * 指定颜料矿**，只能往 mixer 旁边瞎塞矿机（blocked_by_machine ×2）。
     *
     * 现在收「形状矿两字母前缀 ∪ 颜料名」。下面那条「该拒」的清单里，
     * `Cuu` 从「该拒」变成「可以」（它符合颜料名的形状，虽然世界上没有这种矿 ——
     * 那种情况由 `ORE_NOT_FOUND` 报，见 O8，不是形状错误）。 */
    const obs = mkObs([[2, 2, "CuCuCuCu"], [5, 5, "red"], [8, 8, "blue"]]);
    assert(resolveOreRef({ $ore: "Cu" }, obs), "Cu 应可用");
    assert(resolveOreRef({ $ore: "red" }, obs), "★ 颜料名 red 必须可用");
    assert(resolveOreRef({ $ore: "blue" }, obs), "★ 颜料名 blue 必须可用");
    for (const bad of ["CuCuCuCu", "C", "", 42, null, undefined]) {
        assert(resolveOreRef({ $ore: bad }, obs) === null,
            `${JSON.stringify(bad)} 不该被接受`);
    }
});

/* ── O7：★ 端到端 ★ resolveRefs 把 $ore 解析成 {cell} ── */
check("O7 resolveRefs: $ore → {cell:[x,y]}", () => {
    const obs = mkObs([[2, 2, "CuCuCuCu"], [50, 50, "CuCuCuCu"]]);
    const tbl = buildHandles(obs, null);
    const r = resolveRefs(
        { calls: [{ macro: "insert_machine", args: { at: { $ore: "Cu" }, facing: "top", machine: "miner" } }] },
        tbl, obs,
    );
    assert(r.ok, `应解析成功，violations=${JSON.stringify(r.violations)}`);
    const at = r.calls[0].args.at;
    assert(at && Array.isArray(at.cell), `at 应是 {cell}，实际 ${JSON.stringify(at)}`);
    assert(at.cell[0] === 2 && at.cell[1] === 2, `应选最近格，实际 ${JSON.stringify(at.cell)}`);
});

/* ── O8：★ 没有该矿种时给 ORE_NOT_FOUND，不是静默失败 ── */
check("O8 $ore 指名不存在的矿种 ⇒ ORE_NOT_FOUND", () => {
    const obs = mkObs([[2, 2, "RuRuRuRu"]]);
    const tbl = buildHandles(obs, null);
    const r = resolveRefs(
        { calls: [{ macro: "insert_machine", args: { at: { $ore: "Cu" }, facing: "top", machine: "miner" } }] },
        tbl, obs,
    );
    assert(!r.ok, "应解析失败");
    const v = r.violations.find(x => x.rule === "ORE_NOT_FOUND");
    assert(v, `应有 ORE_NOT_FOUND，实际 ${JSON.stringify(r.violations.map(x => x.rule))}`);
    assert(/Cu/.test(v.reason), "报错应点名那个矿种");
});

/* ── O9：$ore 允许附加 asCell / port，其它键报错 ── */
check("O9 $ore 只允许 asCell / port 两个附加键", () => {
    const obs = mkObs([[2, 2, "CuCuCuCu"]]);
    const tbl = buildHandles(obs, null);
    const ok1 = resolveRefs(
        { calls: [{ macro: "insert_machine", args: { at: { $ore: "Cu", asCell: true }, facing: "top", machine: "miner" } }] },
        tbl, obs,
    );
    assert(ok1.ok, `asCell 应被接受，violations=${JSON.stringify(ok1.violations)}`);
    const bad = resolveRefs(
        { calls: [{ macro: "insert_machine", args: { at: { $ore: "Cu", whatever: 1 }, facing: "top", machine: "miner" } }] },
        tbl, obs,
    );
    assert(!bad.ok, "多出的键应被拒");
});

/* ── O10：V6 认识 $ore（不在白名单外的算子才报错） ── */
check("O10 $ore 在算子白名单里（不报 V6）", () => {
    const obs = mkObs([[2, 2, "CuCuCuCu"]]);
    const tbl = buildHandles(obs, null);
    const r = resolveRefs(
        { calls: [{ macro: "insert_machine", args: { at: { $ore: "Cu" }, facing: "top", machine: "miner" } }] },
        tbl, obs,
    );
    assert(!r.violations.some(v => v.rule === "V6"),
        `不该报 V6（未知算子），实际 ${JSON.stringify(r.violations.map(x => x.rule))}`);
});

/* ── O11：★ 新判据 ★ 选「离处理机器最近」的矿，而不是离 hub 最近 ──
 *
 * 真机实测（2026-11-03）：第一版按 hub 选，选中 (-9,3)；但产线机器在 (4,-17)，
 * 距离 33 格 —— 矿机放上去是个孤岛，模型要 connect 一条 33 格的路。
 * 正确的参照是「吃形状的机器」：矿机要么直接喂给某台，要么只走短带子。
 */
check("O11 优先选离 cutter 近的矿（不是离 hub 近的）", () => {
    const obs = {
        entities: [
            { uid: 1, type: "cutter", x: 100, y: 100 },
        ],
        hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
        resources: [
            [2, 2, "CuCuCuCu"],        // 离 hub 近（约 2 格），离 cutter 很远（196 格）
            /* ⚠️ 不能放 (101,100) —— cutter 的 footprint 是 [2,1]，
               展开后覆盖 (100,100) 和 (101,100)，那格放不下矿机。
               这条测的是「按距离排序」，不该被可放性干扰，所以放到 (99,100)
               （cutter 左边一格，距离仍是 1）。 */
            [99, 100, "CuCuCuCu"],     // 离 cutter 近（1 格）
        ],
    };
    const r = nearestOreCell(obs, "Cu");
    assert(r.cell[0] === 99 && r.cell[1] === 100,
        `应选靠近 cutter 的那格，实际 ${JSON.stringify(r.cell)}`);
    assert(r.to === 1, `到最近机器应为 1 格，实际 ${r.to}`);
});

/* ── O12：多台机器时取「到最近那台」的距离 ── */
check("O12 多个处理机器时取最近的那个", () => {
    const obs = {
        entities: [
            { uid: 1, type: "cutter", x: 0, y: 0 },
            { uid: 2, type: "painter", x: 50, y: 50 },
        ],
        resources: [
            [49, 50, "CuCuCuCu"],   // 到 painter 1 格、到 cutter 99 格 ⇒ 应选它
            [10, 10, "CuCuCuCu"],   // 到 cutter 20 格
        ],
    };
    const r = nearestOreCell(obs, "Cu");
    assert(r.cell[0] === 49 && r.cell[1] === 50,
        `应选靠近 painter 的那格，实际 ${JSON.stringify(r.cell)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/* ── O10：★ 颜料名必须能走完整条链路（含 provenance 审计） ──
 *
 * 真机 r-20261111190429-81d1：`$ore:"blue"` 解析成功、宏也放得下，
 * 却在**最后一道溯源审计**被判 `COORD_PROVENANCE: ore 标签解析失败 "ore:blue@37,-9"`。
 *
 * 因为 `$ore` 的白名单散在四处：checkRefShape / resolveNode / resolveOreRef /
 * assertProvenance 的 tag 解析。放宽前三处时漏了第四处 ——
 * 那条报错看起来像「标签格式错」，实际是白名单没同步，极难查。
 *
 * 这条走完整的 buildTxPlan → assertProvenance，任何一处漏掉都会红。
 */
check("O13 颜料名能走完整条链路（含 provenance 审计）", () => {
    const obs = mkObs([[2, 2, "red"], [8, 8, "blue"], [5, 5, "CuCuCuCu"]]);
    const tbl = buildHandles(obs, null);
    for (const [ore, facing] of [["red", "top"], ["blue", "top"], ["Cu", "top"]]) {
        const r = buildTxPlan(
            { calls: [{ macro: "insert_machine", args: { at: { $ore: ore }, facing, machine: "miner" } }] },
            obs, null, tbl, { partial: true },
        );
        assert(r.ok, `${ore}: 必须通过整条链路（含 provenance），实得 ${r.ok ? "" : r.diagnosis.code + " " + r.diagnosis.observed}`);
    }
});

/* ── O14：★ `$ore` 选出的格子，`insert_machine` 必须真的放得下 ──
 *
 * 真机 r-20261112083132-d9d8：`nearestOreCell("blue")` 返回 (38,-10)，
 * 而那格被一台 **2×2 painter 的第二格**压着（painter 的 origin 在别处）。
 * 四个朝向逐一试全 `blocked_by_machine`。
 *
 * 判据错了两次：
 *   ① 只按 origin 建占用表 ⇒ 把「被别人的第二格压着」当成空格
 *   ② 用「四面至少两面空」近似 ⇒ 与宏的「输出格必须能出货」不是一回事，
 *      实测 (38,-10) 四面基本空却四向全拒
 *
 * 现在按 footprint 展开 + 逐朝向看输出格。这条守的是「两边必须一致」——
 * 只要 `$ore` 说能用、宏就必须放得下，否则模型会拿到一个注定失败的落点。 */
check("O14 $ore 选出的格子必须真的放得下（与 insert_machine 一致）", () => {
    /* 造一个逼真的局面：`[2,1]` 机器的**第二格**压在最靠近的那格矿上。
     * 这台机器 origin 在 (9,10)，footprint 覆盖 (9,10) 和 (10,10)
     * ⇒ (10,10) 那格矿**表面看是空的**（按 origin 建表查不到占用），
     * 但实际放不下矿机。这正是真机 (38,-10) 的形态。 */
    const res = [[10, 10, "blue"], [10, 11, "blue"], [11, 10, "blue"], [11, 11, "blue"], [20, 20, "blue"]];
    const obs = {
        entities: [
            { uid: 1, type: "painter", x: 9, y: 10, r: 0, variant: "default", rotation_variant: 0 },
        ],
        hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
        resources: res,
    };
    const hit = nearestOreCell(obs, "blue");
    assert(hit, "必须选出某一格（不能因为最近几格被占就报 ORE_NOT_FOUND）");

    /* 核心断言：选出来的这一格，宏必须真的接受。 */
    let ok = null;
    for (const f of ["top", "right", "bottom", "left"]) {
        if (insertMachine({ at: hit.cell, machine: "miner", facing: f }, { entities: obs.entities }).ok) {
            ok = f; break;
        }
    }
    assert(ok, `$ore 选了 ${JSON.stringify(hit.cell)}，但四个朝向都放不下 —— `
        + `判据与 insert_machine 不一致（这正是 r-20261112083132 的形态）`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * O15 —— 颜料矿的参照物必须是 **mixer**，不能是任意消费者
 *
 * 真实缺陷（第 9 关真机 `r-20261112141704-642e`，2026-11-12）：
 *
 *   红矿有两片：
 *     · `(8,5)`   —— 离 mixer C7 **44 格**（MIXER_UNFED 说的就是这片）
 *     · `(52,21)` —— 离 C7 **52 格**，但旁边 3 格有一台 **painter**
 *
 *   锚点原来是「任意消费者取最近」⇒ `(52,21)` 距离 3、`(8,5)` 距离 17
 *   ⇒ **永远选远的那片**。
 *
 *   于是诊断和 `$ore` 各说一片矿：诊断让去 (8,5) 放，`$ore` 放到 (52,21)，
 *   下一轮诊断看去 (8,5) 还是「0 台」⇒ 模型以为没放成，**再放一台**。
 *   一个 run 里因此堆了 7 台红矿机，**一台都没接到 mixer**。
 *
 * 判据：有 mixer 时只锚 mixer —— painter 是次级消费者（它抹的颜料
 * 本该由 mixer 先混好）。
 * ══════════════════════════════════════════════════════════════════════════ */
check("O15 ★ 颜料矿锚 mixer，不锚更近的 painter（否则与 MIXER_UNFED 各说一片矿）", () => {
    const obs = {
        entities: [
            /* 真正要吃这份颜料的 mixer，在 (0,0) */
            { uid: 1, type: "mixer", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0 },
            /* 一台离「远矿」很近的 painter —— 这正是把 $ore 带偏的东西 */
            { uid: 2, type: "painter", x: 52, y: 20, r: 0, variant: "default", rotation_variant: 0 },
        ],
        hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
        resources: [
            /* 近矿：离 mixer 4 格，但离 painter 52 格 */
            [0, 4, "red"], [1, 4, "red"], [0, 5, "red"], [1, 5, "red"],
            /* 远矿：离 mixer 52 格，但离 painter 2 格 */
            [52, 22, "red"], [53, 22, "red"], [52, 23, "red"], [53, 23, "red"],
        ],
    };
    const hit = nearestOreCell(obs, "red");
    assert(hit, "必须选出某一格");
    const dToMixer = Math.abs(hit.cell[0] - 0) + Math.abs(hit.cell[1] - 0);
    assert(dToMixer <= 6,
        `★ 颜料矿必须选**离 mixer 近**的那片（实得 ${JSON.stringify(hit.cell)}，离 mixer ${dToMixer} 格）—— `
        + `锚到 painter 会让 $ore 和诊断指向两片不同的矿，模型会一直放矿机`);
});

check("O16 对照：一台 mixer 都没有时，才退到 painter", () => {
    /* 没有 mixer 的世界上，颜料总有去处（painter 直接抹），
       这时锚 painter 是对的 —— 别把 O15 的收紧做成「颜料矿找不到位置」。 */
    const obs = {
        entities: [{ uid: 2, type: "painter", x: 52, y: 20, r: 0, variant: "default", rotation_variant: 0 }],
        hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
        resources: [[0, 4, "red"], [1, 4, "red"], [52, 22, "red"], [53, 22, "red"]],
    };
    const hit = nearestOreCell(obs, "red");
    assert(hit, "没有 mixer 时仍要选出格子（退到 painter）");
    const dToPainter = Math.abs(hit.cell[0] - 52) + Math.abs(hit.cell[1] - 20);
    assert(dToPainter <= 3,
        `没有 mixer ⇒ 应当锚 painter（实得 ${JSON.stringify(hit.cell)}，离 painter ${dToPainter} 格）`);
});

check("O17 形状矿不受影响：仍锚最近的 cutter/rotater", () => {
    /* O15 的收窄只针对颜料。形状矿（Cu/Ru）的消费者是 cutter/rotater/painter，
       这条防止「颜料优先 mixer」被写成「所有矿都只锚 mixer」。 */
    const obs = {
        entities: [
            { uid: 1, type: "cutter", x: 30, y: 30, r: 0, variant: "default", rotation_variant: 0 },
            { uid: 2, type: "mixer", x: -30, y: -30, r: 0, variant: "default", rotation_variant: 0 },
        ],
        hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
        resources: [[30, 33, "CuCuCuCu"], [31, 33, "CuCuCuCu"], [-30, -27, "CuCuCuCu"]],
    };
    const hit = nearestOreCell(obs, "Cu");
    assert(hit, "必须选出某一格");
    const dToCutter = Math.abs(hit.cell[0] - 30) + Math.abs(hit.cell[1] - 30);
    assert(dToCutter <= 5,
        `形状矿必须锚 cutter（实得 ${JSON.stringify(hit.cell)}，离 cutter ${dToCutter} 格）—— `
        + `O15 的收窄只该针对颜料`);
});
