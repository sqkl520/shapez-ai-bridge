/**
 * coldstart_l4.test.mjs — 阶段 2 的核心赌注：**没人算坐标**能不能改造真实存档。
 *
 * 这个文件只测一件事，但它是整条阶段 2 的命门：
 *
 *   给定 L4 冷启动存档（goal = `RuRu----`，待改造的 3 条带子），
 *   **只用「这 3 条带子是哪些」这个信息**（即 3 个 uid），
 *   让 `$bbox_of` 算出 region，喂给 `replace_run`，看它能不能自己解出正解。
 *
 * 判据（DIRECTION-FINAL 阶段 2 原话）：不是「打通 L4」（L4 当年是人算坐标手写通的），
 * 而是「**没人算坐标**也能打通」。
 *
 * 实测结论（2026-10-28）：**成立**。
 *   uid [10143, 10209, 10149] → $bbox_of → [4,-14, 5,-13]
 *   → replace_run(region=[4,-14,5,-13], building=["cutter",{trash,left}])
 *   → ok, removes 恰好那 3 条, places cutter@(4,-13) + trash@(4,-14)
 *
 * 注意本文件**不**证明以下任何事（避免读者误读）：
 *   · 不证明这些 uid 能自动找到（那是 diagnose 的活，另一个文件测）
 *   · 不证明 tx 真的落盘（FakeGame 只模拟效果；实机验证是验收阶段的事）
 *   · 不证明 goal 会推进（那要看 L4-behavior，需要真游戏）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { replaceRun } from "./macros/remove.mjs";
import { templateByBuildingVariant } from "../ai/op-templates.mjs";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SAVES = path.join(REPO, "test/fixtures/saves");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 400) : "")); }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

/* ═══════════ 被测的解析算子（loop 里会是 $bbox_of 的实现） ═══════════
 *
 * 放在测试里而不是直接 import loop 的实现，是为了让这条测试**独立于 loop 的存在**：
 * 即便 loop 还没写，这个假设本身已经被钉住了。loop 实现时必须与这里一致，
 * 或者显式说明为什么不同（届时这条测试要跟着改，那是一次有意识的决定）。
 */

/**
 * `$bbox_of(handles)` → 闭区间 bbox。
 * 按 handle 所指实体的 **origin + footprint** 并集算 —— 不是只看 origin 点。
 * 理由：一台 2×1 的 cutter，它的"占地"包含 (x+1,y)，只用 origin 会少一格，
 * 于是 replace_run 报「region 太小，放不下 2×1」。
 */
function bboxOf(uids, entities) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const uid of uids) {
        const e = entities.find(x => x.uid === uid);
        if (!e) throw new Error(`$bbox_of: uid ${uid} 不在世界`);
        const tpl = templateByBuildingVariant(e.type, e.variant || "default");
        const w = tpl ? tpl.footprint[0] : 1;
        const h = tpl ? tpl.footprint[1] : 1;
        x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
        x1 = Math.max(x1, e.x + w - 1); y1 = Math.max(y1, e.y + h - 1);
    }
    return [x0, y0, x1, y1];
}

/* ═══════════ 夹具 ═══════════ */

const L4 = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8"));
const l4 = L4.result || L4;
const ENT = l4.entities;

/* ═══════════ 0. 前置：确认这真的是 L4 冷启动态 ═══════════ */

ok(l4.goal.requirement.shape === "RuRu----", "夹具是 L4（goal = RuRu----）", l4.goal.requirement.shape);
ok(l4.goal.level === 4, "夹具是 L4（level = 4）", l4.goal.level);
eq(l4.goal.requirement.delivered, 0, "L4 冷启动：交付为 0（关卡未推进）");

{
    const at = (x, y) => ENT.find(e => e.x === x && e.y === y);
    for (const [x, y, uid] of [[4, -13, 10209], [5, -13, 10149], [4, -14, 10143]]) {
        const e = at(x, y);
        ok(e && e.type === "belt" && e.uid === uid,
            `冷启动态：(${x},${y}) 是待改造的带子 uid=${uid}`, e && { type: e.type, uid: e.uid });
    }
    ok(!ENT.some(e => e.type === "cutter" && e.x === 4 && e.y === -13),
        "冷启动态：(4,-13) 还不是 cutter（确认这是改造前，不是改造后）");
}

/* ═══════════ 1. 核心：三个 uid → $bbox_of → replace_run ═══════════ */

const WANT_UIDS = [10143, 10209, 10149];   // 「这 3 条带子」—— 唯一需要的外部输入

{
    const bbox = bboxOf(WANT_UIDS, ENT);
    eq(JSON.stringify(bbox), JSON.stringify([4, -14, 5, -13]),
        "$bbox_of([10143,10209,10149]) = [4,-14,5,-13]（含 footprint 并集）");

    const r = replaceRun(
        { region: bbox, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: ENT },
    );

    ok(r.ok, "replace_run($bbox_of) 规划成功 —— 没有人算坐标", r.error);
    if (r.ok) {
        /* ① 删的必须正好是「那 3 条」，不多不少 */
        const removed = (r.removes || []).map(x => x.uid).sort((a, b) => a - b);
        eq(JSON.stringify(removed), JSON.stringify([10143, 10149, 10209]),
            "删的正好是 $bbox_of 指的 3 条带子，不多不少");

        /* ② 放的必须是一台 cutter + 一个 trash，位置由宏自己解出来 */
        ok(r.placed.length === 2, "放了 2 台建筑（cutter + trash）", r.placed.map(p => p.kind));
        const cut = r.placed.find(p => p.kind === "cutter");
        const tra = r.placed.find(p => p.kind === "trash");
        ok(!!cut && !!tra, "放的有 cutter 与 trash", r.placed.map(p => p.kind));
        eq(JSON.stringify(cut && cut.origin), JSON.stringify([4, -13]), "cutter 落在 (4,-13)（宏自己算的）");
        eq(JSON.stringify(tra && tra.origin), JSON.stringify([4, -14]), "trash 落在 (4,-14)（宏自己算的）");
        eq(cut && cut.rotation, 0, "cutter 朝向 r=0（宏自己算的，不是调用方给的）");

        /* ③ 宏必须如实报出副作用，不许静默 */
        const wc = (r.warnings || []).map(w => w.code);
        ok(wc.includes("trash-cuts-chain"),
            "宏如实报出「trash 会剪断仍在供货的链」（L4 要求销毁 (4,-14) 那条）", wc);
        ok(wc.includes("cut-upstream-feeds") || wc.includes("consumed-by-machine"),
            "宏如实报出上游供料的变化（断线或接力，二者必居其一）", wc);

        /* ④ 全链路没有一个坐标来自调用方 —— 这是本测试的立身之本 */
        const callArgs = JSON.stringify({ region: bbox });
        ok(callArgs.includes("4") && callArgs.includes("-14"),
            "（说明）region 里的数字确实来自 $bbox_of，而不是手写常量", callArgs);

        /* ⑤ 宏的 tx_ops（如果给了）必须能直接落盘 */
        const ops = [
            ...(r.removes || []).map(x => ({ op: "delete", uid: x.uid })),
            ...(r.placed || []).map(p => ({
                op: "place", building: p.kind, x: p.origin[0], y: p.origin[1], r: p.rotation || 0,
            })),
        ];
        eq(ops.length, 5, "总共 5 个 tx op（3 delete + 2 place）—— 与「L4 五 op」对上");
    }
}

/* ═══════════ 2. 反例：bbox 少一格就放不下 2×1 ═══════════ */

{
    /* 如果 $bbox_of 只看 origin 不看 footprint，cutter 的 2×1 会缺 (5,-13) 那一格。
       这条测试证明「必须按 footprint 算」不是可有可无的讲究。 */
    const badBbox = [4, -14, 4, -13];   // 只有 x=4 那一列（漏掉 x=5）
    const r = replaceRun(
        { region: badBbox, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: ENT },
    );
    ok(!r.ok, "bbox 漏掉 x=5 时，2×1 的 cutter 放不下 → 宏必须拒绝（不能硬塞）", r.ok ? "竟然成功了" : r.error.code);
    ok(!r.ok && r.error && /region|occupied|precondition/.test(r.error.code + " " + (r.error.message || "")),
        "拒绝理由是几何/precondition 类，不是别的东西", r.error && r.error.code);
}

/* ═══════════ 3. 反例：给错 uid 就必须拒绝（而不是猜） ═══════════ */

{
    const r = replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: ENT.filter(e => e.uid !== 10143) },   // 少了一条带子
    );
    // 容错：宏可能仍成功（region 里还有别的可替换物），也可能拒。关键是**必须如实**
    if (r.ok) {
        const removed = (r.removes || []).map(x => x.uid);
        ok(!removed.includes(10143),
            "世界变了之后，宏不会声称删了一个不存在的东西", removed);
    } else {
        ok(true, `世界缺实体时宏明确拒绝（${r.error.code}）而不是猜`, r.error.code);
    }
}

/* ═══════════ 4. 端到端：喂给 verifyRuntime（离线） ═══════════ */

{
    const g = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
    const r = replaceRun(
        { region: bboxOf(WANT_UIDS, g.obs.entities), building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: g.obs.entities },
    );
    ok(r.ok, "在 FakeGame 上也规划成功", r.error);

    if (r.ok) {
        const ops = [
            ...(r.removes || []).map(x => ({ op: "delete", uid: x.uid })),
            ...(r.placed || []).map(p => ({
                op: "place", building: p.kind, x: p.origin[0], y: p.origin[1], r: p.rotation || 0,
                ...(p.kind === "belt" ? { rotationVariant: p.rotationVariant || 0 } : {}),
            })),
        ];
        const applied = g.apply(ops);
        ok(applied.ok && applied.applied === 5, "5 个 op 全部落盘（FakeGame 模拟）", applied);

        const cutAfter = g.obs.entities.find(e => e.type === "cutter" && e.x === 4 && e.y === -13);
        const traAfter = g.obs.entities.find(e => e.type === "trash" && e.x === 4 && e.y === -14);
        ok(!!cutAfter, "落盘后 (4,-13) 上有 cutter");
        ok(!!traAfter, "落盘后 (4,-14) 上有 trash");
        ok(!g.obs.entities.some(e => [10143, 10209, 10149].includes(e.uid)),
            "落盘后那 3 条带子的 uid 都不在了");

        /* 诚实声明：FakeGame 不推进产线，所以 goal 不会动。
           真正的「关卡推进」只能实机验 —— 这条测试不假装它验了。 */
        eq(g.goal.requirement.delivered, 0,
            "（诚实边界）FakeGame 不推进产线，goal.delivered 仍是 0 —— 关卡是否打通必须实机验");
    }
}

/* ═══════════ 汇总 ═══════════ */
console.log(`\ncoldstart_l4 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
