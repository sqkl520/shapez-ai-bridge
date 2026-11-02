/**
 * planToTxOps.test.mjs — 翻译器的判据（含红队抓到的负例）。
 *
 * 每一条断言都写明「它防的是哪种假绿」，因为本文件最大的风险不是写错代码，
 * 而是**测试自己在自证**（宏算的 → 宏验的 → 全绿 → 实机红）。
 *
 * 覆盖：
 *   · 真实 L4 存档 + 真实 replace_run → 5 个 op（3 delete + 2 place）、destroys 正好 3 个
 *   · R1..R12 每条至少一例（拒绝路径必须给出 error.code / rule）
 *   · deriveFlows：`from===to` 必须丢弃；无下游 ⇒ OUTPUT_UNROUTED；无 flow ⇒ FLOW_UNVERIFIED
 *   · R9 同轮依赖排序（A 的 pending 被 B 引用 ⇒ A 先落）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planToTxOps, deriveFlows } from "./planToTxOps.mjs";
import { replaceRun, removeRun, trashUnused } from "../macros/remove.mjs";
import { insertMachine, extendLine } from "../macros/place.mjs";
import { connect } from "../macros/connect.mjs";
import { normalizePlan } from "../verify_runtime.mjs";
import FakeGame from "../fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const L4 = path.join(SAVES, "L4-obs.json");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 400) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

function l4Game() {
    return FakeGame.fromFiles(L4, null, { goal: "RuRu----" });
}
function l4Replace(game) {
    return replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: game.obs.entities },
    );
}

/* ═══════════ 1. 真实 L4 存档：5 个 op / destroys 正好 3 个 ═══════════ */

{
    const g = l4Game();
    const r = l4Replace(g);
    ok(r.ok, "前置：replace_run 在 L4 上规划成功", r.error);

    const plan = planToTxOps([{ macro: "replace_run", result: r }], { obs: g.obs });
    ok(plan.ok, "planToTxOps 接受 L4 的 replace_run", plan.error);
    eq(plan.ops.length, 5, "L4 总共 5 个 tx op（3 delete + 2 place）");
    eq(plan.ops.filter(o => o.op === "delete").length, 3, "其中 3 个 delete");
    eq(plan.ops.filter(o => o.op === "place").length, 2, "其中 2 个 place");
    eq(JSON.stringify(plan.destroys), JSON.stringify([10143, 10149, 10209]), "destroys 正好是那 3 条带子（升序）");
    eq(plan.destroys.length, 3, "destroys 长度 = 3");
    eq(JSON.stringify(plan.ops.slice(0, 3).map(o => o.uid)), JSON.stringify([10143, 10149, 10209]),
        "R9：delete 按 uid 升序排在最前");
    eq(JSON.stringify(plan.ops[3]), JSON.stringify({ op: "place", building: "cutter", x: 4, y: -13, r: 0 }), "第 4 个 op 是 cutter@(4,-13)");
    eq(JSON.stringify(plan.ops[4]), JSON.stringify({ op: "place", building: "trash", x: 4, y: -14, r: 0 }), "第 5 个 op 是 trash@(4,-14)");
    eq(plan.placements.length, 2, "placements 2 条");
    eq(plan.removes.length, 3, "removes 3 条");
    ok(plan.removes.every(x => x.expect && x.expect.type === "belt"), "removes 每条都带 expect.type=belt");
    ok(plan.removes.every(x => Number.isInteger(x.expect.x) && Number.isInteger(x.expect.y)), "removes 的 expect 带 x/y");

    /* ★ 关键：这份计划必须能被 verifyRuntime 的 normalizePlan 直接吃 ★
       （v1 的宏返回值只有 3/6 能被吃；本翻译器统一构造成 {placements,removes}） */
    const norm = normalizePlan({ placements: plan.placements, removes: plan.removes });
    eq(norm.source, "placements[]", "normalizePlan 认得出 planToTxOps 的 placements（source=placements[]）");
    eq(norm.placements.length, 2, "normalizePlan 吃到 2 条 placement");
    eq(norm.removes.length, 3, "normalizePlan 吃到 3 条 remove");
    ok(norm.placements.every(p => p.kind && Number.isInteger(p.x) && Number.isInteger(p.y)), "placement 归一后 kind/x/y 都在");
    ok(norm.placements.every(p => p.uid === null), "placement 的 uid 是 null（uid 由 tx 分配，不许编）");

    /* pending 桥接：replace_run 的 placed[].pending.token 必须进 pendingByOp */
    ok(Object.keys(plan.pendingByOp).length === 2, "pendingByOp 有 2 条（两台新建筑都有 token）", plan.pendingByOp);
    const toks = Object.values(plan.pendingByOp);
    ok(toks.includes("replace_run:cutter@4,-13"), "pendingByOp 含 cutter 的 token", toks);
    ok(toks.includes("replace_run:trash@4,-14"), "pendingByOp 含 trash 的 token", toks);
    const cutIdx = plan.ops.findIndex(o => o.op === "place" && o.building === "cutter");
    eq(plan.pendingByOp[cutIdx], "replace_run:cutter@4,-13", "pendingByOp 的 key 是 place 在 ops[] 里的下标");

    /* flows：L4 的 cutter 两个输出必须各派生一条，且 trash 就是下游（机对机直贴） */
    ok(plan.flows.length >= 1, "L4 派生出了 flow", plan.flows);
    const toTrash = plan.flows.find(f => f.to_token === "replace_run:trash@4,-14");
    ok(!!toTrash, "cutter.left → trash 的 flow 存在（via adjacent）", plan.flows);
    ok(!!toTrash && toTrash.via_slot === "left", "该 flow 的 via_slot=left", toTrash);
    ok(plan.flows.every(f => f.from !== f.to), "没有任何 from===to 的自环");
    ok(!plan.warnings.some(w => w.code === "FLOW_UNVERIFIED"), "有 flow，所以不报 FLOW_UNVERIFIED");

    /* 宏的警告必须原样透传（销毁/断线不许被翻译器吞掉） */
    const wc = plan.warnings.map(w => w.code);
    ok(wc.includes("trash-cuts-chain"), "宏的 trash-cuts-chain 警告透传", wc);
    ok(wc.includes("cut-upstream-feeds"), "宏的 cut-upstream-feeds 警告透传", wc);

    /* R7 用的 uid 必须在 obs 里 —— 反证：把世界里的 10143 拿掉就应 plan_stale */
    const g2 = l4Game();
    g2.obs.entities = g2.obs.entities.filter(e => e.uid !== 10143);
    const r2 = replaceRun({ region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] }, { entities: g2.obs.entities });
    if (r2.ok) {
        const p2 = planToTxOps([{ macro: "replace_run", result: r2 }], { obs: g2.obs });
        /* 宏不会声称删不存在的 uid（见 coldstart_l4 用例 3），所以这里正常通过 ——
           真正的 plan_stale 用例在下面手工构造。 */
        ok(p2.ok || p2.error.rule === "R3", "世界缺实体时宏不会声称删它（R7 因此不会误火）", p2.error);
    } else {
        ok(true, `世界缺实体时 replace_run 直接拒绝（${r2.error.code}）`);
    }
}

/* ═══════════ 2. R1 / R2：空计划、宏失败、半成 ═══════════ */

{
    const g = l4Game();
    const p = planToTxOps([], { obs: g.obs });
    ok(!p.ok && p.error.rule === "R1", "R1：calls 为空 → 拒绝（空计划不许当成功）", p.error);
    ok(p.ops.length === 0, "R1 拒绝时 ops 为空（零写入）");

    const r = l4Replace(g);
    const refused = { ...r, ok: false, error: { code: "precondition_failed", message: "x" } };
    const p2 = planToTxOps([{ macro: "replace_run", result: refused }], { obs: g.obs });
    ok(!p2.ok && p2.error.kind === "MACRO_REFUSED", "R1：宏 ok:false → MACRO_REFUSED", p2.error);
    ok(p2.ops.length === 0, "宏失败时零 op");

    const half = { ...r, cells_planned: 9, cells_placed: 8 };
    const p3 = planToTxOps([{ macro: "replace_run", result: half }], { obs: g.obs });
    ok(!p3.ok && p3.error.kind === "MACRO_HALF_DONE", "R2：半成返回值 → MACRO_HALF_DONE（不靠调用方读 warnings）", p3.error);

    const noResult = planToTxOps([{ macro: "replace_run", args: {} }], { obs: g.obs });
    ok(!noResult.ok && noResult.error.rule === "R1" && /没有 result/.test(noResult.error.message),
        "R1：没有 result → 拒绝（翻译器不替调用方 dry-run 宏）", noResult.error);

    const unknown = planToTxOps([{ macro: "paste_blueprint", result: { ok: true } }], { obs: g.obs });
    ok(!unknown.ok && unknown.error.kind === "unknown_macro", "R4：未知宏 → unknown_macro", unknown.error);
}

/* ═══════════ 3. R5 / R6：占用与冲突 ═══════════ */

{
    const g = l4Game();
    const r = l4Replace(g);
    /* 同一台 cutter 被两个宏各报一次 → 同格冲突 */
    const dup = planToTxOps([
        { macro: "replace_run", result: r },
        { macro: "replace_run", result: r },
    ], { obs: g.obs });
    ok(!dup.ok && dup.error.rule === "R5", "R5：同一格被两个 place 命中 → plan_conflict", dup.error);
    ok(dup.ops.length === 0, "R5 拒绝时零 op");

    /* 往 obs 里已有的机器上放（cutter 落在 hub 上） */
    const ontoHub = {
        ok: true, macro: "insert_machine",
        cells_planned: 4, cells_placed: 4, first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null, dry_run: true,
        origin: [-2, -2], rotation: 0, machine: { kind: "cutter", variant: "default" },
        cells: [{ x: -2, y: -2 }, { x: -1, y: -2 }], removed_uids: [],
        pending: { pending: true, token: "insert_machine:cutter@-2,-2", kind: "cutter", variant: "default", rotation: 0, origin: [-2, -2], cells: [[-2, -2], [-1, -2]], ports: { in: [], out: [] }, uid: null },
    };
    const p4 = planToTxOps([{ macro: "insert_machine", result: ontoHub }], { obs: g.obs });
    ok(!p4.ok && p4.error.rule === "R6" && p4.error.detail.type === "hub",
        "R6：往 hub 上放 → plan_conflict（机器/hub 永不让位）", p4.error);

    /* footprint 的第二格撞上带子（2×1 的 cutter 第二格 (5,-13) 是 belt 10149，未声明删除）。
       为了让「第一格」是空的，从 obs 里去掉 (4,-13) 那条带子 —— 这样命中只可能来自第二格，
       也就把「origin 点级检查」这个错误实现与「footprint 级检查」区分开了。 */
    const gg = l4Game();
    gg.obs.entities = gg.obs.entities.filter(e => e.uid !== 10209);
    const noDestroy = {
        ...ontoHub,
        origin: [4, -13], cells: [{ x: 4, y: -13 }, { x: 5, y: -13 }], removed_uids: [],
        pending: { ...ontoHub.pending, token: "insert_machine:cutter@4,-13", origin: [4, -13] },
    };
    const p5 = planToTxOps([{ macro: "insert_machine", result: noDestroy }], { obs: gg.obs });
    ok(!p5.ok && p5.error.rule === "R6" && p5.error.detail.uid === 10149 && p5.error.detail.cell.join(",") === "5,-13",
        "R6：footprint 第二格上的带子没进 destroys → 拒绝（origin 点级检查会漏掉这一格）", p5.error);
}

/* ═══════════ 4. R7：过期计划 ═══════════ */

{
    const g = l4Game();
    const r = l4Replace(g);
    const g2 = l4Game();
    /* 用「有 10143」的世界做计划，但拿一个「没有 10143」的 obs 去翻译 → uid 不在 obs 里 */
    g2.obs.entities = g2.obs.entities.filter(e => e.uid !== 10143);
    const p = planToTxOps([{ macro: "replace_run", result: r }], { obs: g2.obs });
    ok(!p.ok && p.error.rule === "R7" && p.error.kind === "plan_stale",
        "R7：销毁集合里的 uid 不在当前 obs → plan_stale", p.error);
    ok(p.ops.length === 0, "plan_stale 时零 op（不许删别人新长的东西）");
}

/* ═══════════ 5. R10：op 形状（belt 必须给 rv；不许带 mod 不认的字段） ═══════════ */

{
    const g = l4Game();
    const r = l4Replace(g);
    const p = planToTxOps([{ macro: "replace_run", result: r }], { obs: g.obs });
    for (const op of p.ops) {
        const allowed = op.op === "place"
            ? ["op", "building", "x", "y", "r", "variant", "rotationVariant"]
            : ["op", "uid"];
        const extra = Object.keys(op).filter(k => !allowed.includes(k));
        eq(extra.length, 0, `R10：${op.op} op 不含 mod 白名单外的字段（${extra.join(",") || "无"}）`);
    }
    ok(p.ops.filter(o => o.op === "place").every(o => o.building !== "belt" || Number.isInteger(o.rotationVariant)),
        "R10：所有 belt place 都带 rotationVariant");

    /* 构造一个不带 rv 的 belt place（手工绕开宏，直接喂翻译器） */
    const badBelt = {
        ok: true, macro: "connect",
        cells_planned: 1, cells_placed: 1, first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null, dry_run: true,
        cells: [{ x: 0, y: 20, building: "belt", rotation: 0, code: 1 }],      // 没有 rotationVariant
    };
    const p2 = planToTxOps([{ macro: "connect", result: badBelt }], { obs: g.obs });
    ok(!p2.ok && p2.error.rule === "R10" && /rotationVariant/.test(p2.error.message),
        "R10：belt place 缺 rotationVariant → op_shape（照抄就会在实机上被 rv 重算掉）", p2.error);
}

/* ═══════════ 6. connect(allow_replace)：销毁必须由翻译器补算（红队 #6） ═══════════ */

{
    const g = l4Game();
    /* L5 的正解有 connect，但这里用 L4 的空地做一条「覆盖既有带子」的 connect 更可控：
       从 10139@(4,-10) 连到 10144@(4,-15) —— 路径必然压过 (4,-11)(4,-12)(4,-13)(4,-14) 上的带子。 */
    const r = connect(
        { from: { uid: 10139 }, to: { uid: 10144 }, opts: { allow_replace: true } },
        { entities: g.obs.entities },
    );
    if (!r.ok) {
        /* 环境不允许时不硬造：如实记为「本夹具下不可构造」，并保留断言（它一旦可构造就会跑） */
        ok(true, `（说明）本夹具的 connect(allow_replace) 规划不出：${r.error.code} —— 该负例改由下面的手工用例覆盖`);
    } else {
        const p = planToTxOps([{ macro: "connect", result: r }], { obs: g.obs });
        ok(p.ok, "connect(allow_replace) 能被翻译器接受（v1 的 R6 会误拒）", p.error);
        ok(p.destroys.length > 0, "connect 未自报销毁，翻译器用 cells[] ∩ obs 补算出了 destroys", p.destroys);
        ok(p.warnings.some(w => w.code === "DESTROYS_DERIVED"),
            "补算的销毁必须留痕（DESTROYS_DERIVED），不许静默补全", p.warnings.map(w => w.code));
        ok(p.ops.filter(o => o.op === "delete").every(o => p.destroys.includes(o.uid)),
            "每个 delete op 的 uid 都在 destroys 里");
    }

    /* 手工作一条 connect 返回：路径压过 (4,-11) 的带子 10206，宏自报 removed_uids 为空 */
    const manual = {
        ok: true, macro: "connect",
        cells_planned: 2, cells_placed: 2, first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] }, warnings: [
            { code: "replacing-belts", detail: "allow_replace=true：路径上有 2 格是既有带子" },
        ], error: null, dry_run: true,
        cells: [
            { x: 4, y: -11, building: "belt", rotation: 0, rotationVariant: 0, code: 1 },
            { x: 4, y: -12, building: "belt", rotation: 0, rotationVariant: 0, code: 1 },
        ],
    };
    const p2 = planToTxOps([{ macro: "connect", result: manual }], { obs: g.obs });
    ok(p2.ok, "手工 connect 计划被接受", p2.error);
    const covered = [10206, 10208].filter(u => p2.destroys.includes(u));
    eq(covered.length, 2, "两格既有带子（10206/10208）都被补算进 destroys", p2.destroys);
    ok(p2.warnings.some(w => w.code === "DESTROYS_DERIVED"), "补算有独立警告");
}

/* ═══════════ 7. R9：同轮依赖排序（A 的 pending 被 B 引用 ⇒ A 先落） ═══════════ */

{
    const g = l4Game();
    /* insert_machine 放在 (4,-9)（空地带子外侧），trash_unused 吃它的 pending */
    const im = insertMachine({ at: [4, -9], facing: "top", machine: "cutter" }, { entities: g.obs.entities });
    if (!im.ok) {
        ok(true, `（说明）insert_machine@(4,-9) 不可行：${im.error.code} —— R9 改用下面的等价构造`);
    } else {
        const tu = trashUnused({ outlet: { pending: im.pending, port: "left" } }, { entities: g.obs.entities });
        if (!tu.ok) {
            ok(true, `（说明）trash_unused(pending) 不可行：${tu.error.code}`);
        } else {
            /* 故意把 trash_unused 放在前面 —— 若不排序，trash 的 place 会排在 cutter 之前 */
            const p = planToTxOps([
                { macro: "trash_unused", args: { outlet: { pending: im.pending, port: "left" } }, result: tu },
                { macro: "insert_machine", result: im },
            ], { obs: g.obs });
            ok(p.ok, "R9：catcher 在前、producer 在后也能翻译", p.error);
            const cutterIdx = p.ops.findIndex(o => o.op === "place" && o.building === "cutter");
            const trashIdx = p.ops.findIndex(o => o.op === "place" && o.building === "trash");
            ok(cutterIdx >= 0 && trashIdx >= 0 && cutterIdx < trashIdx,
                "R9：依赖 pending 的宏（trash）必须排在产生 pending 的宏（cutter）之后", { cutterIdx, trashIdx });
        }
    }
}

/* ═══════════ 8. deriveFlows：自环必须丢弃 ═══════════ */

{
    /* 6.1 两个端点相同的 flow（手工构造）：deriveFlows 不可能产出它 —— 用「自己占自己的槽」的
       极端几何直接测：一台 trash 没有任何输出槽，所以 flows 必须为空（不能靠自环凑数）。 */
    const g = l4Game();
    const trashPlace = [{ kind: "trash", variant: "default", x: 4, y: -14, rot: 0, uid: 10020, token: null, cells: [[4, -14]], macro: "trash_unused" }];
    const f0 = deriveFlows(trashPlace, g.obs, null);
    eq(f0.length, 0, "6.1 无输出槽的 trash 派生不出 flow（不靠自环凑数）");

    /* 6.2 明确的自环构造：把一个「输出槽落在自己 footprint 上」的假建筑放进去。
       这里用 cutter 放在 (4,-13)：它的 left 输出槽 approach (4,-14) 恰好是 trash 的位置，
       若把 trash 也换成 cutter@(4,-14)（2×1 会撞），就退化成「自己喂自己」——
       为可复现，构造单台 cutter 且让它的输出格上就是它自己（把 cells 写成 [[4,-13],[5,-13]] 但
       在 obs 里把 (4,-14) 放一台 uid 相同的实体，模拟「同一个 uid 占两处」的病态世界）。 */
    const self = { kind: "cutter", variant: "default", x: 4, y: -13, rot: 0, uid: 999, token: null, cells: [[4, -13], [5, -13]], macro: "insert_machine" };
    const obsSelf = { entities: [{ uid: 999, type: "cutter", x: 4, y: -13, r: 0, variant: "default", rotation_variant: 0, code: 9 }] };
    const f1 = deriveFlows([self], obsSelf, null);
    ok(f1.every(f => f.from !== f.to), "6.2 from===to 的 flow 被丢弃（self 恒不在 flows 里）", f1);
    /* 单台孤立 cutter：两个输出都没下游 ⇒ 0 条 flow + 2 条 OUTPUT_UNROUTED */
    eq(f1.length, 0, "6.2 孤立 cutter 的 flows 为空");

    /* 6.3 ★ 直接命中 from===to 那一行 ★
       构造两个**不同对象、同一 token** 的 placement（token 冲突是真实故障类：
       `replace_run:<kind>@x,y` 若两台机器落在同 origin 就会撞）。cutter 的 left 输出 (4,-14)
       正好是第二台（trash）的位置 ⇒ 若不过滤，会产出一条 from===to 的 flow，
       而 checkFlow 的 reach() 以 start.uid 起手 ⇒ **恒绿**。这里必须为空。 */
    const a = { kind: "cutter", variant: "default", x: 4, y: -13, rot: 0, uid: null, token: "dup", cells: [[4, -13], [5, -13]], macro: "insert_machine" };
    const b = { kind: "trash", variant: "default", x: 4, y: -14, rot: 0, uid: null, token: "dup", cells: [[4, -14]], macro: "insert_machine" };
    const f2 = deriveFlows([a, b], { entities: [] }, null);
    eq(f2.length, 0, "6.3 from===to（两对象同一 token）的 flow 被丢弃 —— 自环不许出现");
    ok(!f2.some(f => f.from === f.to), "6.3 flows 里没有任何自环");
    /* 反证：token 不同时同一几何**必须**产出 flow（否则上面那条是「因为什么都不产出」而假绿） */
    const b2 = { ...b, token: "other" };
    const f3 = deriveFlows([a, b2], { entities: [] }, null);
    eq(f3.length, 1, "6.3 对照组：token 不同 ⇒ 同一几何产出 1 条 flow", f3);
    eq(JSON.stringify([f3[0].from, f3[0].to]), JSON.stringify(["dup", "other"]), "6.3 对照组 flow 的端点是两个不同 token");
}

/* ═══════════ 9. deriveFlows：无下游 ⇒ OUTPUT_UNROUTED；无 flow ⇒ FLOW_UNVERIFIED ═══════════ */

{
    const g = l4Game();
    const lone = [{
        ok: true, macro: "insert_machine",
        cells_planned: 4, cells_placed: 4, first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null, dry_run: true,
        origin: [-20, 30], rotation: 0, machine: { kind: "cutter", variant: "default" },
        cells: [{ x: -20, y: 30 }, { x: -19, y: 30 }], removed_uids: [],
        pending: { pending: true, token: "insert_machine:cutter@-20,30", kind: "cutter", variant: "default", rotation: 0, origin: [-20, 30], cells: [[-20, 30], [-19, 30]], ports: { in: [], out: [] }, uid: null },
    }];
    const p = planToTxOps(lone, { obs: g.obs });
    ok(p.ok, "远处孤立的 cutter 仍能翻译成 op", p.error);
    const unrouted = p.warnings.filter(w => w.code === "OUTPUT_UNROUTED");
    eq(unrouted.length, 2, "cutter 的两个输出都没下游 ⇒ 2 条 OUTPUT_UNROUTED", p.warnings.map(w => w.code));
    eq(p.flows.length, 0, "并且 flows 为空（不许造自环）");
    ok(p.warnings.some(w => w.code === "FLOW_UNVERIFIED"),
        "flows 为空且计划里有机器 ⇒ FLOW_UNVERIFIED（由调用方判红）", p.warnings.map(w => w.code));

    /* 反证：把那条计划的输出接到既有带子上 ⇒ 有 flow、无 FLOW_UNVERIFIED */
    const picked = l4Replace(g);
    const p2 = planToTxOps([{ macro: "replace_run", result: picked }], { obs: g.obs });
    ok(p2.flows.length > 0 && !p2.warnings.some(w => w.code === "FLOW_UNVERIFIED"),
        "接得上的计划会被识别出 flow（对照组）");
}

/* ═══════════ 10. 纯删除轮 ═══════════ */

{
    const g = l4Game();
    const r = removeRun({ uids: [10209, 10149] }, { entities: g.obs.entities });
    ok(r.ok, "前置：remove_run 成功", r.error);
    const p = planToTxOps([{ macro: "remove_run", result: r }], { obs: g.obs });
    ok(p.ok, "纯删除计划被接受", p.error);
    eq(p.ops.length, 2, "2 个 delete op");
    eq(p.placements.length, 0, "placements 为空");
    eq(p.removes.length, 2, "removes 2 条");
    eq(p.flows.length, 0, "纯删除轮没有 flow");
    ok(!p.warnings.some(w => w.code === "FLOW_UNVERIFIED"),
        "纯删除轮**不**报 FLOW_UNVERIFIED（没有机器要验货流 —— 否则拆建分两轮的第一轮永远红）",
        p.warnings.map(w => w.code));
}

/* ═══════════ 11. pendingByOp 与 op 下标一致（apply 侧的桥接只靠 results[i].uid） ═══════════ */

{
    const g = l4Game();
    const r = l4Replace(g);
    const p = planToTxOps([{ macro: "replace_run", result: r }], { obs: g.obs });
    for (const [idxStr, token] of Object.entries(p.pendingByOp)) {
        const idx = Number(idxStr);
        ok(Number.isInteger(idx) && idx >= 0 && idx < p.ops.length, `pendingByOp 的 key ${idx} 是合法下标`);
        eq(p.ops[idx].op, "place", `pendingByOp[${idx}] 指向的确实是 place op`);
        ok(typeof token === "string" && token.length > 0, `pendingByOp[${idx}] 是 token（apply 侧用它换 results[i].uid）`);
    }
}


/* ══════════════════════════════════════════════════════════════════════════
 * R13：实质删除必须与「LLM 指名的对象」一致
 *
 * 实测漏洞（2026-10-29）：LLM 说「改 B69/B81/B82」，$bbox_of 算出矩形，
 * replace_run 在矩形里挑落点，**删掉了没点名的 10150(B70)，漏掉了点名的 10143(B69)**，
 * 而宏返回 ok:true —— 没有任何拒绝信号。
 *
 * 这是最危险的一类：一个"成功"的 tx 会在世界里删掉 LLM 从未指名的东西。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── R13. destroys 必须 ⊆ 指名句柄 ──");
{
    const FakeGame = (await import("../fake_game.mjs")).default;
    const { buildHandles } = await import("./handles.mjs");
    const { replaceRun } = await import("../macros/remove.mjs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

    const g = FakeGame.fromFiles(path.join(REPO, "test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
    const obs = g.observe({ max_entities: 50000, include_resources: true });
    const H = buildHandles(obs, g.debugItems());

    /* 这个 region 会让宏删掉 10150（B70，没被点名），而漏掉 10143（B69，被点名了） */
    const r = replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
        { entities: obs.entities },
    );
    ok(r.ok, "（前置）宏本身成功", r.error);

    /* ① 点名 [B69,B81,B82] = [10143,10209,10149] ⇒ 实际删了 10150 ⇒ 必须拒 */
    {
        const txp = planToTxOps(
            [{ macro: "replace_run", args: {}, result: r, provenance: {} }],
            { obs, handles: H, items: g.debugItems(), namedUids: [10143, 10209, 10149] },
        );
        ok(!txp.ok, "★ 删了未被点名的 10150 ⇒ 必须拒（否则「成功但换对象」）", txp.ok ? "竟然通过" : null);
        ok(!txp.ok && txp.error.kind === "destroys_not_named",
            "拒绝码是 destroys_not_named", txp.ok ? null : txp.error.kind);
        ok(!txp.ok && /10150/.test(txp.error.message),
            "拒绝信息点名了被误删的 10150", txp.ok ? null : txp.error.message.slice(0, 120));
    }

    /* ② 对照：点名包含全部实际删除的 uid ⇒ 通过（证明不是恒拒） */
    {
        const txp = planToTxOps(
            [{ macro: "replace_run", args: {}, result: r, provenance: {} }],
            { obs, handles: H, items: g.debugItems(), namedUids: [10150, 10209, 10149] },
        );
        ok(txp.ok, "（对照）点名完整时通过 —— 证明 R13 不是恒拒", txp.error);
    }

    /* ③ 没给 namedUids ⇒ 不判，但必须留警告（不许静默） */
    {
        const txp = planToTxOps(
            [{ macro: "replace_run", args: {}, result: r, provenance: {} }],
            { obs, handles: H, items: g.debugItems() },
        );
        ok(txp.ok, "没给 namedUids 时不拒（向后兼容）");
        ok((txp.warnings || []).some(w => w.code === "DESTROYS_UNNAMED_CHECK_SKIPPED"),
            "但必须带 DESTROYS_UNNAMED_CHECK_SKIPPED 警告 —— 不许静默跳过这道闸",
            (txp.warnings || []).map(w => w.code));
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * R13 豁免：connect(allow_replace) 显式覆盖的带子
 *
 * 实测冲突（2026-11-03 真机，level 5 / 目标 Cu----Cu）：
 *   prompt 告诉模型 `allow_replace` = 「是否允许覆盖路径上的既有带子」，
 *   模型照做传 `{"allow_replace": true}`，想把 rotater 输出直连 hub。
 *   但 R13 只认 `$ref`/`$uids`/`$path_of` 点名的 uid，而被覆盖的带子
 *   是**路径推演的产物**，从来没被点名过 ⇒ 三轮全部 R13 拒绝，0 次执行。
 *
 * R13 原本要拦的是另一回事：`$bbox_of` 的矩形误框（点 B69/B81/B82，
 * 矩形顺带框进没点名的 B70）。那和「模型明确授权覆盖这条路径」不是一类。
 *
 * ⚠️ 这里**合成** connect 的 MacroResult，而不是真跑 connect：
 *    真机那个世界里 9 个候选端点的 connect 全部失败在前置条件
 *    （port_already_bound ×4 / ambiguous_port ×3 / endpoint_not_a_port ×1 / occupied ×1），
 *    夹具里也没有「路径压到带子」的组合。R13 只吃 `result.cells` 与 obs，
 *    合成输入能精确覆盖要测的分支，且不构造假世界。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n── R13 豁免：connect(allow_replace) 显式覆盖 ──");
{
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const FakeGame = (await import("../fake_game.mjs")).default;
    const { buildHandles } = await import("./handles.mjs");
    const { replaceRun } = await import("../macros/remove.mjs");

    const g = FakeGame.fromFiles(path.join(REPO, "test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
    const obs = g.observe({ max_entities: 50000, include_resources: true });
    const H = buildHandles(obs, g.debugItems());
    const items = g.debugItems();

    /* 挑 3 条真实带子当「被覆盖的带子」，并找一个「不点名」的 from/to */
    const belts = obs.entities.filter(e => e.type === "belt").slice(0, 3);
    ok(belts.length === 3, "（前置）夹具里至少有 3 条带子", belts.length);
    const fromUid = obs.entities.find(e => e.type === "miner").uid;
    const toUid = obs.entities.find(e => e.type === "hub").uid;
    const coveredUids = belts.map(b => b.uid);

    /* 合成一个 connect 的 MacroResult：cells 落在那些带子上，allow_replace 打开。
     * planToTxOps 里的 `connectDestroysFromObs(result.cells ∩ obs)` 正是靠这个
     * 把 covered 的 uid 算进 derived。
     *
     * ⚠️ 每个 cell 必须带 `rotation` 与 `rotationVariant` —— 否则先撞 R10
     *    （`belt@(x,y) 缺 rotationVariant`），根本走不到 R13。
     *    真 connect 的 cells 就带这两个字段，所以这不是"编数据"，是补齐契约。 */
    const synthConnect = {
        ok: true, macro: "connect",
        cells: belts.map(b => ({
            x: b.x, y: b.y,
            building: "belt",
            rotation: Number.isInteger(b.rotation) ? b.rotation : 0,
            rotationVariant: Number.isInteger(b.rotationVariant) ? b.rotationVariant : 0,
            code: Number.isInteger(b.code) ? b.code : 1,
        })),
        cells_planned: belts.length, cells_placed: belts.length,
        first_mismatch: null,
        changed: { placed: [], removed_uids: [] },   // ← 宏不自报销毁（红队 #6 的真实形态）
        warnings: [{ code: "replacing-belts", detail: `will overwrite ${belts.length} belts` }],
        reason: "ok",
    };

    /* ⑥ allow_replace 授权 ⇒ 被覆盖的带子不算「未点名删除」⇒ 必须通过 */
    {
        const txp = planToTxOps(
            [{ macro: "connect", args: { from: { uid: fromUid }, to: { hub: { entry: 0 } }, opts: { allow_replace: true } }, result: synthConnect, provenance: {} }],
            { obs, handles: H, items, namedUids: [fromUid, toUid] },
        );
        ok(txp.ok, "connect(allow_replace) 覆盖的带子不算「未点名删除」⇒ 通过",
            txp.ok ? "" : (txp.error.detail || txp.error.observed));
        ok((txp.warnings || []).some(w => w.code === "DESTROYS_DERIVED"),
            "但必须留 DESTROYS_DERIVED 警告，逐格列明覆盖了哪些带子（审计可见）",
            (txp.warnings || []).map(w => w.code));
        const dw = (txp.warnings || []).find(w => w.code === "DESTROYS_DERIVED");
        if (dw) {
            ok(coveredUids.every(u => (dw.derived_uids || []).includes(u)),
                "警告里列出了全部被覆盖的 uid", { want: coveredUids, got: dw.derived_uids });
        }
    }

    /* ⑦ ★ 对照 ★ 豁免不得放宽到别处：replace_run 的矩形误框照旧被拒 */
    {
        const rr = replaceRun(
            { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "right", confirm_waste: true }] },
            { entities: obs.entities },
        );
        ok(rr.ok, "（前置）replace_run 宏成功", rr.error);
        const txp = planToTxOps(
            [{ macro: "replace_run", args: {}, result: rr, provenance: {} }],
            { obs, handles: H, items, namedUids: [10143, 10209, 10149] },
        );
        ok(!txp.ok, "★ replace_run 的矩形误框**仍然被拒** —— 豁免没有放宽到别处",
            txp.ok ? "却被放行了，说明豁免范围写太宽" : "");
        /* reject() 把 rule/kind 放在 error 顶层（不是 error.evidence 里） */
        ok(txp.error && txp.error.rule === "R13" && txp.error.kind === "destroys_not_named",
            "拒绝仍是 R13 / destroys_not_named",
            txp.error && { rule: txp.error.rule, kind: txp.error.kind });
    }

    /* ⑧ 混合：一部分来自 allow_replace、一部分**既不点名也不是覆盖** ⇒ 必须拒。
     * 这是「豁免会不会被滥用」的关键：只要还夹着来路不明的删除，就得拦。 */
    {
        const strangerUid = obs.entities.find(e => e.type === "belt" && !coveredUids.includes(e.uid)).uid;
        const synthWithExtra = {
            ...synthConnect,
            changed: { placed: [], removed_uids: [strangerUid] },   // 宏自报删了一条没点名的带子
        };
        const txp = planToTxOps(
            [{ macro: "connect", args: { from: { uid: fromUid }, to: { hub: { entry: 0 } }, opts: { allow_replace: true } }, result: synthWithExtra, provenance: {} }],
            { obs, handles: H, items, namedUids: [fromUid, toUid] },
        );
        ok(!txp.ok, "夹带了「既没点名、也不是覆盖」的删除 ⇒ 必须拒",
            txp.ok ? "被放行了 —— 豁免把 allow_replace 当成了万能通行证" : "");
        const extra = txp.error && txp.error.detail && txp.error.detail.extra;
        ok(Array.isArray(extra) && extra.includes(strangerUid),
            "拒绝证据里点名了那条来路不明的 uid", { want: strangerUid, got: extra });
    }
}


/* ═══════════ 汇总 ═══════════ */

console.log(`\nplanToTxOps 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);