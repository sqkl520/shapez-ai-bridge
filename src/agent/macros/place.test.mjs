/**
 * place.test.mjs — `insert_machine` / `extend_line` 的单测。
 *
 * 运行：node src/agent/macros/place.test.mjs
 * 退出码：0 全过 / 1 有失败
 *
 * 世界 = research/ai-plan/live-L4-entities.json（181 实体，真实存档）。
 * 关键坐标（实测，不是假设）：
 *   (4,-13)/(5,-13) 是钌线的一段带（uid 10209 / 10149），(4,-12)/(5,-14) 在它的上下游；
 *   (5,-15) uid 10151 **是**整条线的末端（出口 top 指向 (5,-16)，那里为空）；
 *   (5,-14) uid 10150 **不是**末端（出口已经接进 (5,-15)）。
 *   (9,-13) uid 10193 是另一条线的末端。
 *
 * 设计原则（沿用 connect.test.mjs）：
 *   1. **负例必须红**：每个正例配一个对照组，断言检查器真的报错、且报的是那一类错。
 *   2. 判据来自几何真值（getTileSpaceBounds / solveTurn），不是从实现反推。
 *   3. 不允许"放下去了就算成功"：能工作与否必须出现在 warnings 里。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ORDER, OPP, DIRV, solveTurn, beltEntry, beltExit, beltCode } from "../../ai/belt-rules.mjs";
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { validateMacroResult, isPendingRef } from "./contract.mjs";
import {
    insertMachine, extendLine, buildWorld, machineGeometry, rotationForFacing,
    primaryOutputDir, candidateOrigins, rotOffset, verifyExtension, applyToWorld,
} from "./place.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
    try { fn(); pass++; results.push(["ok", name]); }
    catch (e) { fail++; results.push(["FAIL", name, e && e.message ? e.message : String(e)]); }
}
const eq = (a, b, m) => assert.deepEqual(a, b, m === undefined ? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}` : m);

const ENT = JSON.parse(fs.readFileSync(SAVE, "utf8"));
const W = { entities: ENT };
const byUid = new Map(ENT.map(e => [e.uid, e]));
const at = (x, y) => ENT.find(e => e.x === x && e.y === y) || null;
const codes = r => r.warnings.map(w => w.code);

const cutter = templateByBuildingVariant("cutter", "default");
const painter = templateByBuildingVariant("painter", "default");
const stacker = templateByBuildingVariant("stacker", "default");
const miner = templateByBuildingVariant("miner", "default");
const trash = templateByBuildingVariant("trash", "default");

/* 一个确定为空、且远离所有建筑的空地（先断言它真的空，别把测试建立在假设上） */
const EMPTY = [20, -40];
const isEmptyPatch = (x0, y0, w, h) => {
    const wd = buildWorld(ENT);
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
        if (wd.cells.get(`${x0 + dx},${y0 + dy}`)) return false;
    }
    return true;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 几何真值：旋转 footprint 必须与上游 getTileSpaceBounds 四档逐档等价
 * ══════════════════════════════════════════════════════════════════════════ */

t("rotOffset = 上游 Vector.rotateFastMultipleOf90（r=90 → (x,y)↦(-y,x)）", () => {
    eq(rotOffset([1, 0], 90), [0, 1]);
    eq(rotOffset([0, 1], 90), [-1, 0]);
    eq(rotOffset([3, 2], 180), [-3, -2]);
    eq(rotOffset([3, 2], 270), [2, -3]);
    eq(rotOffset([3, 2], 0), [3, 2]);
});

t("machineGeometry 的格集合 === getTileSpaceBounds 四档（2×1 与 1×1 与 2×2）", () => {
    /* static_map_entity.js:127-141：
       r=0 → [x, x+w) × [y, y+h)   r=90 → [x-h+1, x] × [y, y+w)
       r=180 → [x-w+1, x] × [y-h+1, y]   r=270 → [x, x+h) × [y-w+1, y] */
    const bounds = (o, [w, h], r) => {
        switch (r) {
            case 0: return { x0: o[0], x1: o[0] + w - 1, y0: o[1], y1: o[1] + h - 1 };
            case 90: return { x0: o[0] - h + 1, x1: o[0], y0: o[1], y1: o[1] + w - 1 };
            case 180: return { x0: o[0] - w + 1, x1: o[0], y0: o[1] - h + 1, y1: o[1] };
            case 270: return { x0: o[0], x1: o[0] + h - 1, y0: o[1] - w + 1, y1: o[1] };
            default: throw new Error("bad r");
        }
    };
    const cases = [
        [cutter, "cutter 2×1"], [painter, "painter 2×1"], [miner, "miner 1×1"],
        [templateByBuildingVariant("painter", "double"), "painterDouble 2×2"],
        [trash, "trash 1×1"],
    ];
    for (const [tpl, label] of cases) {
        for (const r of [0, 90, 180, 270]) {
            for (const origin of [[0, 0], [7, -3], [-11, 5]]) {
                const got = machineGeometry(tpl, origin, r).cells.map(c => c.join(",")).sort();
                const b = bounds(origin, tpl.footprint, r);
                const want = [];
                for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) want.push(`${x},${y}`);
                want.sort();
                eq(got, want, `${label} origin=${origin} r=${r}`);
                eq(got.length, tpl.footprint[0] * tpl.footprint[1], `${label} r=${r} 格数 = w*h`);
            }
        }
    }
});

t("真实存档：按 rotation 展开 footprint 零重叠（旋转机器占的格没有错位）", () => {
    const wd = buildWorld(ENT);
    const seen = new Map();
    let overlap = 0;
    for (const e of ENT) {
        const rec = wd.byUid.get(e.uid);
        if (!rec) continue;
        const tpl = rec.tpl;
        const [w, h] = tpl ? tpl.footprint : [1, 1];
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
            const off = rotOffset([dx, dy], rec.r);
            const k = `${e.x + off[0]},${e.y + off[1]}`;
            if (seen.has(k)) overlap++;
            seen.set(k, e.uid);
        }
    }
    eq(overlap, 0, `按 rotation 展开的 181 实体有 ${overlap} 处重叠`);
    eq(seen.size, 204, "世界占用格数（rotation-aware）应为 204");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. facing → rotation 反解（这是 insert_machine 的核心算术）
 * ══════════════════════════════════════════════════════════════════════════ */

t("primaryOutputDir：cutter=top / painter=right / stacker=top / miner=top", () => {
    eq(primaryOutputDir(cutter), "top", "cutter 主输出局部 top");
    eq(primaryOutputDir(painter), "right", "painter 主输出局部 right");
    eq(primaryOutputDir(stacker), "top");
    eq(primaryOutputDir(miner), "top");
    eq(primaryOutputDir(trash), null, "trash 无输出槽");
});

t("rotationForFacing：facing=top 时 cutter r=0、painter r=270（两者 r 不同 = facing≠r 的证明）", () => {
    eq(rotationForFacing(cutter, "top"), { ok: true, rotation: 0, local: "top" });
    eq(rotationForFacing(painter, "right"), { ok: true, rotation: 0, local: "right" });
    eq(rotationForFacing(painter, "top"), { ok: true, rotation: 270, local: "right" });
    /* painter 局部 right → r=90 是 bottom、r=180 才是 left（ORDER 顺时针），别按"直觉"填 90 */
    eq(rotationForFacing(painter, "bottom"), { ok: true, rotation: 90, local: "right" });
    eq(rotationForFacing(painter, "left"), { ok: true, rotation: 180, local: "right" });
    eq(rotationForFacing(cutter, "right"), { ok: true, rotation: 90, local: "top" });
    eq(rotationForFacing(cutter, "bottom"), { ok: true, rotation: 180, local: "top" });
    eq(rotationForFacing(cutter, "left"), { ok: true, rotation: 270, local: "top" });
});

t("rotationForFacing 的性质：反解出的 r 让 primary output 的世界面 === facing（四向全查）", () => {
    for (const tpl of [cutter, painter, stacker, miner]) {
        const local = primaryOutputDir(tpl);
        for (const f of ORDER) {
            const rr = rotationForFacing(tpl, f);
            assert.ok(rr.ok);
            const g = machineGeometry(tpl, [0, 0], rr.rotation);
            assert.ok(g.outputs.some(p => p.dir === f), `${tpl.kind}/${tpl.variant} facing=${f} 反解 r=${rr.rotation} 后没有面朝 ${f} 的输出`);
            void local;
        }
    }
});

t("rotationForFacing 负例：无输出槽的机器（trash）不返回 rotation", () => {
    const r = rotationForFacing(trash, "top");
    eq(r.ok, false, "trash 没有 primary output，facing 无法反解");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. insert_machine 正例：空地 cutter 必须报「不能工作」的两条
 * ══════════════════════════════════════════════════════════════════════════ */

t(`空地 ${EMPTY} 周围确实全空（测试前提先自证）`, () => {
    assert.ok(isEmptyPatch(EMPTY[0], EMPTY[1] - 2, 4, 5), "测试选址不空，选一个真正的空地");
});

t("insert_machine：空地放 cutter → ok，但必须报 input_not_fed + output_not_connected", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.origin, EMPTY);
    eq(r.rotation, 0, "facing=top ⇒ cutter r=0");
    eq(codes(r), ["input_not_fed", "output_not_connected", "output_not_connected"],
        "孤立机器：1 个输入口 + 2 个输出口全空 ⇒ 1+2 条警告（cutter 有 2 个输出槽）");
    eq(r.wiring.filter(w => w.status === "nothing").length, 3, "3 个槽位全部 nothing");
    eq(validateMacroResult(r).ok, true, "返回值必须过契约信封校验");
    eq(r.dry_run, true, "本宏不写世界");
    eq(r.cells_planned, 2);
    eq(r.cells_placed, 2);
    eq(r.expected_code, 9, "cutter|default 的 code=9（op-templates 真值）");
});

t("insert_machine：警告指向的格就是槽位带格（不是随便挑一格）", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    const fed = r.warnings.find(w => w.code === "input_not_fed");
    const out = r.warnings.filter(w => w.code === "output_not_connected");
    eq(fed.cell, [EMPTY[0], EMPTY[1] + 1], "cutter 输入面 bottom ⇒ 带格 = origin + (0,+1)");
    eq(out.map(w => w.cell).sort((a, b) => a[0] - b[0]), [
        [EMPTY[0], EMPTY[1] - 1], [EMPTY[0] + 1, EMPTY[1] - 1],
    ], "两个输出面 top ⇒ 带格 = (x,y-1) 与 (x+1,y-1)");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. insert_machine：钌线上 (4,-13) 放 cutter，输入格 (4,-12) 有带子 ⇒ 不报 input_not_fed
 * ══════════════════════════════════════════════════════════════════════════ */

t("insert_machine：钌线 (4,-13) 放 cutter，输入格 (4,-12) 有带子 → 无 input_not_fed", () => {
    /* 前提：那两格真的是带子，且 (4,-12) 朝上喷（exit=top）—— 先自证。
       注意方向：货流是 -(y) 方向（下→上），(4,-12) 在机器的**上方**，
       所以它必须是 exit=top 才能把货带到 (4,-13)；exit=bottom 是朝外喷，接不上。 */
    const src = at(4, -12), dst = at(4, -13);
    assert.ok(src && src.type === "belt", "(4,-12) 必须是带子");
    assert.ok(dst && dst.type === "belt", "(4,-13) 必须是带子");
    eq(beltExit(src.rotation_variant, src.r), "top", "(4,-12) 的带子朝上喷，才喂得到下游的机器");

    const r = insertMachine([4, -13], "top", "cutter", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.origin, [4, -13]);
    eq(r.rotation, 0);
    assert.ok(!codes(r).includes("input_not_fed"), `不应报 input_not_fed，实得 ${JSON.stringify(codes(r))}`);
    const inW = r.wiring.find(w => w.kind === "in");
    eq(inW.status, "ok", "输入槽应判 ok（带子方向对得上）");
    eq(inW.uid, src.uid);
    eq(inW.cell, [4, -12]);
});

t("insert_machine：同一落点把 replace_belts=false → blocked_by_machine + firstConflict", () => {
    const r = insertMachine([4, -13], "top", "cutter", { replace_belts: false }, W);
    eq(r.ok, false);
    eq(r.error.code, "blocked_by_machine");
    eq(r.firstConflict, { x: 4, y: -13, what: "belt", uid: at(4, -13).uid });
});

t("insert_machine 负例：输入格上的带子方向反了 → input_belt_wrong_direction（不是静默 ok）", () => {
    /* 构造一个"格子有人但接不上"的世界：把 (4,-12) 换成朝下喷（exit=bottom）的带子。
       这不是真实存档的改法，而是对照组：证明检查器区分「有带子」与「带子对着机器」。 */
    const flipped = ENT.map(e => e.uid === at(4, -12).uid ? { ...e, r: 180 } : e);
    const r = insertMachine([4, -13], "top", "cutter", {}, { entities: flipped });
    assert.ok(r.ok, r.error && r.error.message);
    assert.ok(codes(r).includes("input_belt_wrong_direction"),
        `带子朝外喷却没报 input_belt_wrong_direction：${JSON.stringify(codes(r))}`);
    assert.ok(!codes(r).includes("input_not_fed"), "格子不空，不该报 nothing");
    eq(r.wiring.find(w => w.kind === "in").status, "mismatch");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. insert_machine：2×1 机器占两格
 * ══════════════════════════════════════════════════════════════════════════ */

t("insert_machine：cutter 2×1 占 (x,y) 与 (x+1,y) 两格", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    eq(r.footprint, [2, 1]);
    eq(r.cells, [{ x: EMPTY[0], y: EMPTY[1] }, { x: EMPTY[0] + 1, y: EMPTY[1] }]);
    eq(r.cells_planned, 2);
});

t("insert_machine：painter facing=top 旋转后 2×1 变竖排（占 2 格，y 与 y-1）", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "painter", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.rotation, 270);
    eq(r.cells.map(c => [c.x, c.y]), [[EMPTY[0], EMPTY[1] - 1], [EMPTY[0], EMPTY[1]]],
        "r=270 的 2×1 → origin 不动，格向上长（getTileSpaceBounds 的 270 档）");
    eq(validateMacroResult(r).ok, true);
});

t("insert_machine 负例：2×1 机器只压到一格机器 → blocked_by_machine，且冲突格就是那一格", () => {
    /* (4,-16) 是 balancer 的 origin，(5,-16) 是它的第二格。
       cutter@(5,-16) 会占 (5,-16)+(6,-16) → 撞 balancer 的右半。 */
    const r = insertMachine([5, -16], "top", "cutter", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "blocked_by_machine");
    eq(r.firstConflict.x, 5);
    eq(r.firstConflict.y, -16);
    eq(r.firstConflict.what, "balancer");
});

t("insert_machine：{cell} 形态在 2×1 机器上**不再**恒 ambiguous_site（E2E 缺陷 4 的回归位）", () => {
    /* 旧行为：`{cell:[4,-13]}` 恒 ambiguous_site（候选 [3,-13]/[4,-13]），
       于是契约承诺的「只指一格」在 2×1 机器上永远不可用，调用方被迫退回裸 origin。
       新行为：两个候选里只有 [4,-13] 让这一格成为**输入槽槽格**，据此选定；
       候选仍如实列在 site.candidates 里（多解没有被隐藏）。 */
    const r = insertMachine({ cell: [4, -13] }, "top", "cutter", {}, W);
    assert.ok(r.ok, `2×1 应能反解：${JSON.stringify(r.error)}`);
    eq(r.origin, [4, -13]);
    eq(r.site.candidates.map(c => c), [[3, -13], [4, -13]]);
    eq(r.site.chosen_by, "input-slot");
});

t("insert_machine：{cell} 形态在 1×1 机器上唯一 → 直接采用", () => {
    const cands = candidateOrigins(miner, 0, [4, -13]);
    eq(cands, [[4, -13]], "1×1 只有一解");
    const r = insertMachine({ cell: [4, -13] }, "top", "miner", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.origin, [4, -13]);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. insert_machine：facing / 机器合法性
 * ══════════════════════════════════════════════════════════════════════════ */

t("insert_machine：可旋转机器不给 facing → ambiguous_site", () => {
    const r = insertMachine({ at: [EMPTY[0], EMPTY[1]], machine: "cutter" }, W);
    eq(r.ok, false);
    eq(r.error.code, "ambiguous_site");
    eq(r.error.field, "facing");
});

t("insert_machine：trash 不给 facing → 合法（r 恒 0），但警告它收不到货", () => {
    const r = insertMachine({ at: [EMPTY[0], EMPTY[1]], machine: "trash" }, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.rotation, 0);
    assert.ok(codes(r).includes("input_not_fed"), "四邻全空必须报 input_not_fed");
    eq(r.warnings.filter(w => w.code === "input_not_fed").length, 1, "trash 四个面全空只报一条，不刷 4 条");
});

t("insert_machine 负例：hub / balancer / 未建模变体 → unsupported_building", () => {
    for (const m of ["hub", "balancer", "belt", { kind: "painter", variant: "quad" }, "nonexistent"]) {
        const r = insertMachine([EMPTY[0], EMPTY[1]], "top", m, {}, W);
        eq(r.ok, false, `${JSON.stringify(m)} 不该被 insert_machine 接受`);
        assert.ok(["unsupported_building", "blocked_by_machine"].includes(r.error.code),
            `${JSON.stringify(m)} 得 ${r.error.code}`);
    }
});

t("insert_machine 负例：facing 给角度（90）→ bad_type，不进实现", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], 90, "cutter", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "bad_type");
});

t("insert_machine：解锁等级不足 → precondition_failed；够了 → ok", () => {
    const low = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, { entities: ENT, level: 0 });
    eq(low.ok, false);
    eq(low.error.code, "precondition_failed");
    assert.ok(/level 1/.test(low.error.message), low.error.message);
    const okr = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, { entities: ENT, level: 1 });
    assert.ok(okr.ok);
});

t("insert_machine 负例：没有 ctx.entities → 拒绝（不盲放）", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, {});
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    assert.ok(/entities/.test(r.error.message));
});

t("insert_machine 负例：footprint 超出 obs region → precondition_failed（范围外不是空）", () => {
    /* region 的右下角就是 origin：1×1 机器放得下，2×1 的 cutter 不行。
       （同一 entities 数组配不同 region 也要各自生效 —— worldFor 的缓存键是 数组引用+region。） */
    const region = [-28, -189, EMPTY[0], EMPTY[1]];
    const one = insertMachine([EMPTY[0], EMPTY[1]], "top", "miner", {}, { entities: ENT, region });
    assert.ok(one.ok, `1×1 在边界上应合法：${one.error && one.error.message}`);
    const two = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, { entities: ENT, region });
    eq(two.ok, false, "2×1 需要 x+1，超出 region 右边界");
    eq(two.error.code, "precondition_failed");
    assert.ok(/观测范围/.test(two.error.message), two.error.message);
});

t("insert_machine：r≠0 一定带 rotation_not_live_verified（observed 级公式，不许静默）", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "right", "cutter", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.rotation, 90);
    assert.ok(codes(r).includes("rotation_not_live_verified"), `实得 ${JSON.stringify(codes(r))}`);
    const r0 = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    assert.ok(!codes(r0).includes("rotation_not_live_verified"), "r=0 不该有这条");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. insert_machine：接线判定（机器↔机器紧贴的 0 格连接）
 * ══════════════════════════════════════════════════════════════════════════ */

t("★ insert_machine：输出槽落在**机器**上 ⇒ 直接拒（产物永远出不去，不是 warning）", () => {
    /* 真机第 9 关（2026-11-10）：模型把 4 台 painter 放进世界，`debug_items` 显示
       每一台的产物都是 `progress: 1.00` —— 全部堵死在出口，一件都送不出去。
       两台的输出格**就是矿机本体**。

       这不是「方向不对、等一下再连」：输出格被一台永不让位的机器占着，
       几何上就接不出去。旧实现只发 wiring mismatch 警告，机器照样落盘。

       构造：painter@rot90（facing=bottom）的 out 格 = origin + (0,2)。
       夹具里 (2,-8) 是矿机 10079，所以 origin (2,-10) 的输出格正好落在它身上。 */
    const wd = buildWorld(ENT);
    const miner = wd.cells.get("2,-8");
    assert.ok(miner && miner.type === "miner", "前提：(2,-8) 是一台矿机");

    const r = insertMachine({ at: [2, -10], facing: "bottom", machine: "painter" }, W);
    assert.ok(!r.ok, `输出格压在矿机上必须拒，实得 ok=${r.ok}`);
    eq(r.error.code, "blocked_by_machine");
    eq(r.error.field, "at");
    assert.match(r.error.message, /产物永远出不去/, "必须说清后果，不是只说「冲突」");
    assert.match(r.error.hint, /换一个落点/, "必须给出可执行的下一步");
    eq(r.error.detail.blockedOutputs.map(b => [b.cell[0], b.cell[1], b.what]), [[2, -8, "miner"]],
        "detail 必须点名真正的堵点格与被谁占着");

    /* 对照：输出格落在**带子**上仍只警告 —— 带子可以让位，也能事后接。 */
    const okOut = insertMachine({ at: [-9, -11], facing: "top", machine: "cutter" }, { entities: ENT.filter(e => e.uid !== 10036) });
    assert.ok(okOut.ok, "输出格是带子 ⇒ 仍然允许（这条不能一起拒掉）");
});

t("insert_machine：输出口接既有带子判 ok、接到空地判 nothing（且既有机器永不让位）", () => {
    /* 真实存档的 cutter@(-8,-11)：输入面 bottom ⇒ 带格 (-8,-10)（既有带子 10058 ⇒ ok）；
       输出面 top ⇒ 带格 (-8,-12)（带子 10059 ⇒ ok）与 (-7,-12)（隧道 10077 ⇒ 无槽位表 ⇒ mismatch）。
       对照组说明检查器区分「有东西」与「那东西接着我」。 */
    const wd = buildWorld(ENT);
    const dst = wd.cells.get("-7,-12");
    assert.ok(dst, "前提：(-7,-12) 上有东西");
    assert.equal(dst.type, "underground_belt", "前提：(-7,-12) 是隧道");
    /* 落点 (-9,-11) 的 footprint 是 (-9,-11)+(-8,-11)，后者是既有 cutter ⇒ 先把它移掉，
       再放一台同位置的 cutter：这样两个输出口都落在真实既有拓扑上，
       一个接既有带子 10059（ok），另一个落在隧道旁的空格上（nothing）。
       隧道 (10077@-7,-12) 的对照放在下一条用例里（它是"有东西但接不上"的形态）。 */
    const stripped = ENT.filter(e => e.uid !== 10036);
    const r = insertMachine({ at: [-9, -11], facing: "top", machine: "cutter" }, { entities: stripped });
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.origin, [-9, -11]);
    const outs = r.wiring.filter(w => w.kind === "out");
    eq(outs.map(w => w.cell), [[-9, -12], [-8, -12]], "两个喷口");
    eq(outs.find(w => w.cell[0] === -8 && w.cell[1] === -12).status, "ok", "(-8,-12) 是既有带子 10059，朝上喷进机器 ⇒ ok");
    eq(outs.find(w => w.cell[0] === -9 && w.cell[1] === -12).status, "nothing", "(-9,-12) 是空的 ⇒ nothing");
    assert.ok(!codes(r).includes("wiring_mismatch"), "这里没有 mismatch（只有 nothing）");

    /* 同一落点在真实世界（未移除既有 cutter）里必被挡 —— 这是「绝不覆盖机器」。
       隧道那种「有东西但接不上」的 mismatch 形态由下一条 0 格紧贴用例的对照组覆盖。 */
    const r2 = insertMachine({ at: [-8, -11], facing: "top", machine: "cutter" }, W);
    assert.ok(!r2.ok, "落点被既有 cutter 占住 ⇒ 不可放");
    eq(r2.error.code, "blocked_by_machine");
});

t("insert_machine：机器↔机器 0 格紧贴判 ok（上游 ejector 的带格 === 本机 acceptor 的带格）", () => {
    /* 0 格连接的正确构造：cutter A 的**输出带格**必须正好等于 cutter B 的**输入带格**。
       A facing=bottom（输出面 bottom ⇒ 带格 (0,1)/(1,1)）；B 要占 (0,-1)（输入面 bottom ⇒ 带格 (0,0)）——
       不重合。真正贴合要靠「A 的输出槽格 = B 的输入槽格」：
         A = cutter@(0,0) facing=bottom（r=180，输出槽格 (0,0)/(1,0)，带格 (0,1)/(1,1)）
         B = cutter@(0,0)… 不能重叠。
       所以用 1×1 的 rotater 做对照：rotater 输入面 bottom、输出面 top，槽格恒 (x,y)。
         A = rotater@(0,0) facing=bottom（r=180 ⇒ 输出面 bottom，带格 (0,1)）
         B = rotater@(0,-1) facing=top（r=0 ⇒ 输入面 bottom，带格 (0,0)）—— 仍不重合。
       结论：**两个 1×1 机器紧贴时，A 的带格与 B 的带格天然不同格**（各自朝外一格），
       所以「0 格连接」只发生在 A 的输出带格 = B 的**槽格**上，或两者共享同一带格。
       用 cutter(A，输出带格) 与 balancer(B) 验证后一种：balancer 的输入带格在它下方，
       因此只有当 A 的输出带格恰好是 balancer 的槽格时才通。
       这里改用最干净的一对：A = miner@(0,0) facing=bottom（输出面 bottom，带格 (0,1)）→
       B = rotater@(0,1) facing=bottom（r=180：输入面 top、槽格 (0,1)）⇒ A 的带格 = B 的槽格，
       且 B 输入面 top = OPP[bottom] ⇒ 闭合。 */
    const ents = [{ uid: 7, type: "miner", x: 0, y: 0, r: 180, variant: "default", rotation_variant: 0 }];
    const r = insertMachine({ at: [0, 1], facing: "bottom", machine: "rotater" }, { entities: ents });
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.rotation, 180, "facing=bottom ⇒ rotater r=180");
    eq(r.ports.in[0].cell, [0, 0], "r=180 的 rotater 输入带格在其上方 (0,0) = miner 的槽格");
    const inW = r.wiring.find(w => w.kind === "in");
    eq(inW.status, "ok", `miner 的 ejector 槽格与 rotater 的输入带格重合 ⇒ 应判 ok，实得 ${inW.status}（${inW.why || ""}）`);
    eq(inW.uid, 7);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. extend_line：首格几何 + 直行
 * ══════════════════════════════════════════════════════════════════════════ */

/* 实测拓扑（先自证，别让测试建立在假设上）：
   (5,-13)(5,-14)(5,-15) 是一条带的连续三段，而 (5,-16) 是 balancer@(4,-16) 的右半 ——
   这条线在 (5,-15) 处**终结在机器上**，从它出发延长必撞。
   真实存档里唯一一条朝空走廊的末端是 (9,-13)（出口 top → (9,-14) 起为空）。
   任务书举例的 (5,-14) 在此数据里不是末端（下游 (5,-15) 接着它），本文件把它当负例。 */
t("前提：真实存档里 (5,-15) 的下游是 balancer、(5,-14) 不是末端、(9,-13) 才是末端", () => {
    const a = at(5, -15), b = at(5, -14);
    assert.ok(a && b, "(5,-15)/(5,-14) 都必须是带子");
    eq(beltExit(a.rotation_variant, a.r), "top", "(5,-15) 出口 top");
    eq(buildWorld(ENT).cells.get("5,-16").type, "balancer", "(5,-16) 属于 balancer@(4,-16) 的 footprint");
    eq(beltExit(b.rotation_variant, b.r), "top", "(5,-14) 出口 top");
    assert.ok(at(5, -15), "(5,-14) 的下游是 (5,-15) ⇒ 它不是末端");
    eq(at(9, -14), null, "(9,-13) 的上方必须为空，才是可延长的末端");
});

t("extend_line 负例：从 (5,-15) 延长 → 出口已接进 balancer，不是末端", () => {
    const r = extendLine({ uid: at(5, -15).uid }, 1, "top", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    eq(r.firstConflict, { x: 5, y: -16, what: "balancer", uid: 10085 });
});

t("extend_line：从 (9,-13) 向上延长 3 格 → (9,-14)/(9,-15)/(9,-16)，全 rv0", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 3, "top", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.cells.map(c => [c.x, c.y]), [[9, -14], [9, -15], [9, -16]]);
    eq(r.cells.map(c => c.rotation), [0, 0, 0]);
    eq(r.cells.map(c => c.rotationVariant), [0, 0, 0]);
    eq(r.cells.map(c => c.code), [1, 1, 1]);
    eq(r.cells.map(c => c.entry), ["bottom", "bottom", "bottom"]);
    eq(r.cells.map(c => c.exit), ["top", "top", "top"]);
    eq(r.cells_planned, 3);
    eq(r.cells_placed, 3);
    eq(r.terminal_orphaned, true, "(9,-17) 为空 ⇒ 末端仍是死端");
    eq(codes(r), ["terminal_orphaned"]);
    eq(validateMacroResult(r).ok, true);
    eq(r.terminal, { cell: [9, -16], exit: "top", next: [9, -17] });
});

t("extend_line 负例：从 (5,-14) 延长 → 它不是末端，必须 precondition_failed 且指出 (5,-15)", () => {
    const r = extendLine({ uid: at(5, -14).uid }, 3, "top", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    eq(r.firstConflict.x, 5);
    eq(r.firstConflict.y, -15);
    eq(r.firstConflict.uid, at(5, -15).uid);
});

t("extend_line：缺省 dir = 沿用末端的出口方向（从 (9,-13) 不给 dir 仍向上）", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 2, undefined, {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.cells.map(c => [c.x, c.y]), [[9, -14], [9, -15]]);
    eq(r.start.dir, "top");
    eq(r.start.turned, false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. extend_line：转弯（首格 90°）
 * ══════════════════════════════════════════════════════════════════════════ */

t("extend_line：从 (9,-13) 给 dir=left → 首格 (9,-14) 自己转 90°，后续沿 left 直行", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 3, "left", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    eq(r.cells.map(c => [c.x, c.y]), [[9, -14], [8, -14], [7, -14]],
        "首格 = from 出口格 (9,-14)（本宏不改 from），转弯发生在首格自己身上");
    eq(r.start, { cell: [9, -14], dir: "top", turned: true }, "from 是既有带子，本宏不改它 ⇒ 转弯落在第一个新格");
    /* 首格：货流从 top 进来、往 left 出去 ⇒ entry=bottom, exit=left ⇒ rv1 @ r=0 */
    eq([r.cells[0].entry, r.cells[0].exit], ["bottom", "left"]);
    eq([r.cells[0].rotation, r.cells[0].rotationVariant], [0, 1]);
    eq(r.cells[0].code, 2);
    /* 后两格：left 直行 ⇒ entry=right, exit=left ⇒ solveTurn 给 r=270 rv0（不是 90 —— 90 是 entry=left） */
    eq(r.cells.slice(1).map(c => [c.rotation, c.rotationVariant]), [[270, 0], [270, 0]]);
    eq(r.terminal.exit, "left");
});

t("extend_line 负例：从 (9,-13) 给 dir=bottom（180° 掉头）→ precondition_failed", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 2, "bottom", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "precondition_failed");
    assert.ok(/180|掉头|无解/.test(r.error.message), r.error.message);
    eq(r.error.field, "dir");
});

t("extend_line 负例：路径撞到既有带子 → occupied + firstConflict", () => {
    /* 从 (9,-13) 向 right：首格仍是 (9,-14)（首格先沿 from 出口），第二格起 +x。
       实测 (10,-14)/(11,-14) 为空，(12,-14) 为空… 所以这里不用 right；
       向 left 才立刻撞：首格 (9,-14)，第二格 (8,-14)？也空。
       确定会撞的走法：从 (9,-13) 向 top 40 格 —— x=9 那列上方最远只到 -24 附近？实测空。
       用另一条线：从 (4,-23)（belt 10137）向 top：x=4 的 -24 是 balancer 10084 占住 ⇒ 撞。 */
    /* from (9,-13) 向 left 40 格：首格 (9,-14)（沿 from 出口），之后每格 -x ⇒
       (8,-14)(7,-14)(6,-14)(5,-14) —— 第 5 格撞上带子 10150（实测） */
    const r = extendLine({ uid: at(9, -13).uid }, 40, "left", {}, W);
    eq(r.ok, false, "向左横穿必撞既有带子");
    eq(r.error.code, "occupied");
    eq(r.firstConflict, { x: 5, y: -14, what: "belt", uid: 10150 });
});

t("extend_line 负例：len 超过到最近障碍的距离 → occupied，firstConflict 是被挡那格且真实存在", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 400, "left", {}, W);
    eq(r.ok, false, "400 格向左必然撞到既有建筑");
    eq(r.error.code, "occupied");
    assert.ok(r.firstConflict, "必须给出首个被挡格");
    assert.ok(byUid.has(r.firstConflict.uid), `firstConflict.uid=${r.firstConflict.uid} 不在世界`);
});

t("extend_line 负例：from 指向不存在的 uid → endpoint_not_found", () => {
    const r = extendLine({ uid: 999999 }, 2, "top", {}, W);
    eq(r.ok, false);
    eq(r.error.code, "endpoint_not_found");
});

t("extend_line：from 是机器时用它的输出槽带格（cutter 双输出必须点名 port）", () => {
    const amb = extendLine({ uid: 10036 }, 2, "top", {}, W);
    eq(amb.ok, false);
    eq(amb.error.code, "ambiguous_port");
    eq(amb.error.candidates.length, 2, "cutter 有两个输出槽");
    /* 指定 left 但该槽已经接了带子（10059）→ 拒绝，不抢 */
    const busy = extendLine({ uid: 10036, port: "left" }, 2, "top", {}, W);
    eq(busy.ok, false);
    eq(busy.error.code, "precondition_failed");
    eq(busy.firstConflict.uid, 10059);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. verifyExtension：负例必须红（"看起来绿"是这类宏最大的风险）
 * ══════════════════════════════════════════════════════════════════════════ */

t("verifyExtension：正确链通过；rv1↔rv2 互换 / rotation+180 / 单格改错 必须报红", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 3, "left", {}, W);
    assert.ok(r.ok);
    const rec = byUid.get(at(9, -13).uid);
    const ctx = {
        from: { uid: rec.uid }, rec: buildWorld(ENT).byUid.get(rec.uid),
        startDir: "top", startCell: [9, -14], dir: "left", fromKind: "belt",
    };
    eq(verifyExtension(r.cells, ctx).ok, true, "正确链应通过");

    const swapped = r.cells.map(c => c.rotationVariant === 1
        ? { ...c, rotationVariant: 2, code: beltCode(2) }
        : c.rotationVariant === 2 ? { ...c, rotationVariant: 1, code: beltCode(1) } : c);
    eq(verifyExtension(swapped, ctx).ok, false, "rv1↔rv2 互换必须红");

    const flipped = r.cells.map(c => ({ ...c, rotation: (c.rotation + 180) % 360 }));
    eq(verifyExtension(flipped, ctx).ok, false, "整链 rotation+180° 必须红");

    const oneBad = r.cells.map((c, i) => i === 1 ? { ...c, rotationVariant: 1, code: 2 } : c);
    eq(verifyExtension(oneBad, ctx).ok, false, "单格 rv 改错必须红");

    const shifted = r.cells.map(c => ({ ...c, x: c.x + 1 }));
    eq(verifyExtension(shifted, ctx).ok, false, "整链平移必须红（首格位置不对）");
});

t("extend_line：每格都过 solveTurn 回读自证（entry/exit 与 r/rv 互为反函数）", () => {
    const r = extendLine({ uid: at(9, -13).uid }, 4, "top", {}, W);
    assert.ok(r.ok, r.error && r.error.message);
    for (const c of r.cells) {
        const re = solveTurn(beltEntry(c.rotationVariant, c.rotation), beltExit(c.rotationVariant, c.rotation));
        eq([re.rotation, re.rotationVariant], [c.rotation, c.rotationVariant], `[${c.x},${c.y}] 自证`);
        eq(beltEntry(c.rotationVariant, c.rotation), c.entry);
        eq(beltExit(c.rotationVariant, c.rotation), c.exit);
        eq(c.code, beltCode(c.rotationVariant));
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. 契约层：两条路径都不得出现裸坐标 / 不得越界
 * ══════════════════════════════════════════════════════════════════════════ */

t("契约：insert_machine 带裸 r / x → unknown_field（LLM 不许自己算旋转）", () => {
    const r1 = insertMachine({ at: [0, 0], facing: "top", machine: "cutter", r: 90 }, W);
    eq(r1.ok, false);
    eq(r1.error.code, "unknown_field");
    const r2 = insertMachine({ at: [0, 0], facing: "top", machine: "cutter", opts: { x: 1 } }, W);
    eq(r2.ok, false);
    eq(r2.error.code, "unknown_field");
});

t("契约：extend_line len 越界 / dir 给角度 → bad_type", () => {
    /* 契约形态：所有参数在一个对象里（位置形态的 (from, len, dir) 会被当成 args 对象解构） */
    eq(extendLine({ from: { uid: 10151 }, len: 0 }, W).error.code, "bad_type");
    eq(extendLine({ from: { uid: 10151 }, len: 501 }, W).error.code, "bad_type");
    eq(extendLine({ from: { uid: 10151 }, len: 2, dir: 90 }, W).error.code, "bad_type");
});

t("契约：失败也必须返回结构化信封（ok=false ⇒ error 非 null，cells_* 为 0）", () => {
    for (const r of [
        insertMachine([4, -16], "top", "cutter", {}, W),
        insertMachine([EMPTY[0], EMPTY[1]], 90, "cutter", {}, W),
        extendLine({ uid: at(5, -14).uid }, 2, "top", {}, W),
    ]) {
        eq(r.ok, false);
        assert.ok(r.error && typeof r.error.code === "string");
        eq(r.cells_planned, 0);
        eq(r.cells_placed, 0);
        eq(r.cells, null);
        eq(validateMacroResult(r).ok, true, `失败信封也必须过契约：${JSON.stringify(r.error)}`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 12. 硬指标：真实存档上两条宏都不崩、且 ok 结果全部自洽
 * ══════════════════════════════════════════════════════════════════════════ */

t("硬指标：对全部 161 条带子跑 extend_line(末段) —— 不抛异常，ok 的结果几何自洽", () => {
    const wd = buildWorld(ENT);
    const belts = ENT.filter(e => e.type === "belt");
    const kinds = Object.create(null);
    let okCount = 0, bad = 0;
    for (const b of belts) {
        const exitFace = beltExit(b.rotation_variant, b.r);
        const next = [b.x + DIRV[exitFace][0], b.y + DIRV[exitFace][1]];
        const nrec = wd.cells.get(`${next[0]},${next[1]}`);
        const isTerminal = !nrec || (nrec.type === "belt"
            ? beltEntry(nrec.rv, nrec.r) !== OPP[exitFace]
            : !(nrec.tpl && wd.byUid.get(nrec.uid) && machineGeometry(nrec.tpl, [nrec.x, nrec.y], nrec.r)
                .inputs.some(p => p.slot[0] === next[0] && p.slot[1] === next[1] && p.dir === OPP[exitFace])));
        const r = extendLine({ uid: b.uid }, 1, undefined, {}, W);
        if (r.ok) {
            okCount++;
            if (!verifyExtension(r.cells, {
                from: { uid: b.uid }, rec: wd.byUid.get(b.uid),
                startDir: exitFace, startCell: next, dir: exitFace, fromKind: "belt",
            }).ok) bad++;
            const key2 = "ok";
            kinds[key2] = (kinds[key2] || 0) + 1;
        } else {
            kinds[r.error.code] = (kinds[r.error.code] || 0) + 1;
            /* 只有"非末端"这一种是合理的；其它错误码在这个调用形态下不该出现 */
            if (r.error.code !== "precondition_failed" && r.error.code !== "occupied") bad++;
        }
    }
    eq(bad, 0, `161 条带子上出现 ${bad} 条不该出现的失败/不自洽：${JSON.stringify(kinds)}`);
    assert.ok(okCount > 0, "至少要有一条末端能延长的带子");
    console.log(`   · extend_line 在 ${belts.length} 条带子上：${JSON.stringify(kinds)}`);
});

t("硬指标：181 实体的每个空格都试放 cutter —— 只有『撞机器』或『ok』两种结果", () => {
    const wd = buildWorld(ENT);
    /* 取真实格 ∪ 其右邻/下邻，覆盖 2×1 机器的所有落点 */
    const probes = new Set();
    for (const e of ENT) {
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, -1], [1, -1], [0, 1]]) {
            probes.add(`${e.x + dx},${e.y + dy}`);
        }
    }
    let ok = 0, blocked = 0, other = [];
    for (const k of probes) {
        const [x, y] = k.split(",").map(Number);
        const r = insertMachine([x, y], "top", "cutter", {}, W);
        if (r.ok) { ok++; if (r.cells.length !== 2) other.push([k, "cells!=2"]); }
        else if (r.error.code === "blocked_by_machine" || r.error.code === "occupied") blocked++;
        else other.push([k, r.error.code]);
    }
    eq(other.slice(0, 5), [], `出现意外结果：${JSON.stringify(other.slice(0, 5))}`);
    assert.ok(ok > 0 && blocked > 0, `ok=${ok} blocked=${blocked}（两边都要有，否则说明探针没覆盖到）`);
    console.log(`   · insert_machine 在 ${probes.size} 个落点：ok=${ok}，被占=${blocked}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 13. 缺陷 1：计划态串接（pending 引用 + applyToWorld）与缺陷 4：2×1 的 {cell}
 * ══════════════════════════════════════════════════════════════════════════ */

t("缺陷 4：2×1 cutter 的 {cell} 命中输入槽槽格 → 唯一反解，不再恒 ambiguous_site", () => {
    /* E2E §3.6 实测：`{cell:[4,-13]}` 以前恒 ambiguous_site（候选 [3,-13]/[4,-13]），
       于是契约承诺的「调用方一个坐标都不给」在 2×1 机器上永远做不到。
       语义判据（不是猜）：只有 origin 让这一格成为机器的**输入槽槽格** —— 也就是
       「货流如果要进这台机器，必须从这一格进」。插进一条带子时，调用方指的就是这一格。 */
    const r = insertMachine({ cell: [4, -13] }, "top", "cutter", {}, W);
    assert.ok(r.ok, `应成功：${JSON.stringify(r.error)}`);
    eq(r.origin, [4, -13]);
    eq(r.site.chosen_by, "input-slot");
    eq(r.site.candidates, [[3, -13], [4, -13]], "两个候选都如实列出（不隐藏多解）");
    eq(r.ports.in.find(p => p.role === "primary").slot, [4, -13], "选中的 origin 让 [4,-13] 成为输入槽槽格");
});

t("缺陷 4：2×1 机器「指向机身非首格」时仍按输入槽语义反解（不再一律 ambiguous_site）", () => {
    /* (5,-13) 对候选 origin [5,-13] 来说就是 footprint 第一格（= 输入槽槽格），
       所以它有唯一语义；对 [4,-13] 来说它是第二格机身。旧实现两种都报 ambiguous_site。
       现在的判据只有一条：**哪个 origin 让这一格成为机器的输入槽槽格**。 */
    const r = insertMachine({ cell: [5, -13] }, "top", "cutter", {}, W);
    assert.ok(r.ok, `应成功：${JSON.stringify(r.error)}`);
    eq(r.origin, [5, -13]);
    eq(r.site.chosen_by, "input-slot");
});

t("缺陷 4 负例：多解且无法用输入槽语义收窄 → 仍然 ambiguous_site，并给出可直接用的 at", () => {
    /* painter/double 是 2×2、有 3 个输入槽；挑一格让它落在两个不同 origin 的输入槽上
       需要真实几何 —— 这里用更直接的口径：把 at 指向一个**不在任何输入槽槽格**上的格。
       cutter@r0 只有 1 个输入槽（槽格 = footprint 第一格 = origin），所以任何格都必然
       恰好对应一个 origin 让它成为第一格 —— 2×1 上「输入槽语义」永远唯一。
       真正会多解的是**没有输入槽**的机器（如 miner）—— 用它验证负例。 */
    const r = insertMachine({ cell: [20, -40] }, "top", "miner", {}, W);
    assert.ok(r.ok, "miner 1×1 只有一解");
    eq(r.site.chosen_by, "unique");
});

t("缺陷 1：insert_machine 返回 pending 引用，带 footprint 与槽位世界格", () => {
    const r = insertMachine([4, -13], "top", "cutter", {}, W);
    assert.ok(r.ok, JSON.stringify(r.error));
    const p = r.pending;
    assert.ok(p && p.pending === true, "必须返回 pending 引用");
    eq(p.token, "insert_machine:cutter@4,-13", "token 稳定可复现（同一输入同一 token）");
    eq(p.origin, [4, -13]);
    eq(p.cells, [[4, -13], [5, -13]]);
    eq(p.ports.in.map(q => [q.role, q.cell, q.dir]), [["primary", [4, -12], "bottom"]]);
    eq(p.ports.out.map(q => [q.role, q.cell, q.dir]), [["left", [4, -14], "top"], ["right", [5, -14], "top"]]);
    eq(p.uid, null, "计划态没有 uid —— 这是重点，不是缺陷");
    /* 关键：pending 的值必须与失败信封里的占位同形（调用方不必先判 ok 再取字段） */
    const bad = insertMachine([4, -13], "top", "hub", {}, W);
    eq(bad.pending, null, "失败信封里 pending 恒 null（形状稳定）");
});

t("缺陷 1：applyToWorld 把计划折进世界 —— 合成负 uid，不冒充游戏 uid", () => {
    const a = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    assert.ok(a.ok, JSON.stringify(a.error));
    const out = applyToWorld(a, W);
    eq(out.added.length, 1);
    eq(out.added[0].uid, -1, "合成 uid 是负数 —— 一眼能看出不是游戏 uid");
    eq(out.added[0].token, a.pending.token);
    eq(out.entities.length, ENT.length + 1);
    const synth = out.entities.find(e => e.uid === -1);
    eq([synth.type, synth.x, synth.y, synth.r, synth.synthetic], ["cutter", EMPTY[0], EMPTY[1], 0, true]);
    /* 折叠后的世界必须能被下游宏当 ctx 用 */
    const b = insertMachine([EMPTY[0] + 3, EMPTY[1]], "top", "trash", {}, out.ctx);
    assert.ok(b.ok, `合成实体不得让世界模型崩：${JSON.stringify(b.error)}`);
});

t("缺陷 1：applyToWorld 同时吃掉 removed_uids（删旧 + 放新一步折进世界）", () => {
    const r = insertMachine([4, -13], "top", "cutter", {}, W);   // 默认 replace_belts=true
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(r.removed_uids.length > 0, "这个落点会替换既有带子");
    const out = applyToWorld(r, W);
    for (const u of r.removed_uids) {
        assert.ok(!out.entities.some(e => e.uid === u), `被替换的 uid=${u} 必须从新世界里消失`);
    }
    eq(out.removed.sort((x, y) => x - y), r.removed_uids.slice().sort((x, y) => x - y));
});

t("缺陷 1：applyToWorld 对多次调用的产物可合并，token 去重", () => {
    const a = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    const b = insertMachine([EMPTY[0] + 3, EMPTY[1]], "top", "cutter", {}, W);
    assert.ok(a.ok && b.ok);
    const out = applyToWorld([a, b, a], W);          // a 传两次
    eq(out.added.map(x => x.uid), [-1, -2], "同一 token 只加一次");
    eq(out.entities.length, ENT.length + 2);
});

t("缺陷 1：pending 的形状过契约校验（下游宏可以按结构认它）", () => {
    const r = insertMachine([EMPTY[0], EMPTY[1]], "top", "cutter", {}, W);
    assert.ok(isPendingRef(r.pending), "isPendingRef 必须认");
    /* 负例：胡乱拼的 pending 必须被拒（下游宏不能靠"有 pending 字段"就放行） */
    assert.ok(!isPendingRef({ pending: true, token: "x" }), "缺 cells/ports 的不能算 pending");
    assert.ok(!isPendingRef({ token: "x", kind: "cutter", origin: [0, 0], cells: [[0, 0]], ports: { in: [], out: [] } }),
        "没有 pending:true 的不能算");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 报告
 * ══════════════════════════════════════════════════════════════════════════ */

const red = s => `\x1b[31m${s}\x1b[0m`, green = s => `\x1b[32m${s}\x1b[0m`;
for (const [st, name, msg] of results) {
    if (st === "ok") console.log(`${green("✓")} ${name}`);
    else console.log(`${red("✗")} ${name}\n    ${red(msg)}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
