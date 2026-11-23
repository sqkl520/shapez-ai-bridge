/**
 * progress_ledger.test.mjs — `## GOAL` 里那行进度读数
 *
 * ## 为什么需要它（2026-11-22，506 个 L12 快照的实测）
 *
 * 用 `debug_items` 的真实货物对 506 个 L12 快照做 census：
 * 本关目标形状**一次都没出现过**（仅 3 个带上出现过形状，而那 3 个是
 * `CgScScCg` —— **上一关 L11 的目标**）。
 *
 * 而模型每一轮都在修一条 2026-11-16 就冻结的 L11 产线
 * （`CgScScCg` 存 2071 件，此后 373 个 run 一分没动）。
 * **没有任何一处告诉它「这条链不存在」**。
 *
 * ## 三条验收（都能在离线快照上跑，且都是可证伪的）
 *
 * 1. **不许恒等于常量** —— 不同世界必须能渲染出不同的行
 * 2. **三态必须分开** —— `absent` / `alive` / `present-stuck` 不能混成一个布尔
 * 3. **不许挤掉带子** —— 加了它之后 `belts_shown` 不能下降
 *
 * 第 2 条尤其重要：带上「有」不等于「在产」。
 * 真机 `r-20261121190439-6190` 的 `ScSc----` 有 139 件但产出为 0（尸体），
 * `----CgCg` 有 2 件且产出了 4 件（活的）。把两者混成一个「有」，
 * 模型会去修一条已经停转的线。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { progressLedger, buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";
import { diagnose, candidatesFor } from "../loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, "../../../research/ai-plan/runs");
const FIXTURE = path.resolve(HERE, "../../../test/fixtures/saves/L12-cheapest-obs.json");

const GOAL = "CbCbCbRb:CwCwCwCw";

/** 读一个 run 的三件套。缺任何一个都抛（不 skip）。 */
function loadRun(id) {
    const b = path.join(RUNS, id) + path.sep;
    const r = (f) => JSON.parse(fs.readFileSync(b + f, "utf8"));
    return { obs: r("obs-last.json"), items: r("items-last.json"), production: r("production-last.json") };
}

const HAS_LIVE = fs.existsSync(path.join(RUNS, "r-20261121190439-6190", "items-last.json"));

test("★ 三态：absent / alive / present-stuck 必须分开", { skip: !HAS_LIVE && "缺真机 run 快照" }, () => {
    const { obs, items, production } = loadRun("r-20261121190439-6190");
    /* `ScSc----`：带上 139 件，但产出窗口里没有它 ⇒ 尸体（present-stuck）
     * `----CgCg`：带上 2 件，产出 4 件 ⇒ 活的（alive） */
    const stuck = progressLedger({ obs, items, production, goalShape: "ScSc----" });
    assert.equal(stuck.layers[0].state, "present-stuck",
        `139 件但零产出必须判 present-stuck，实得 ${stuck.layers[0].state}`);
    assert.ok(stuck.layers[0].onBelt > 0, "前提：带上确实有货");

    const alive = progressLedger({ obs, items, production, goalShape: "----CgCg" });
    assert.equal(alive.layers[0].state, "alive",
        `有货且有产出必须判 alive，实得 ${alive.layers[0].state}`);

    const absent = progressLedger({ obs, items, production, goalShape: "CpCpCpCp" });
    assert.equal(absent.layers[0].state, "absent",
        `带上一件都没有必须判 absent，实得 ${absent.layers[0].state}`);
});

test("★ 两层的目标：每一层单独判状态", { skip: !HAS_LIVE && "缺真机 run 快照" }, () => {
    const { obs, items, production } = loadRun("r-20261121190439-6190");
    const L = progressLedger({ obs, items, production, goalShape: GOAL });
    assert.equal(L.layers.length, 2, `两层目标必须给两行，实得 ${L.layers.length}`);
    assert.deepEqual(L.layers.map(x => x.name), ["CbCbCbRb", "CwCwCwCw"]);
    /* 真机实测：本关两层都没出现过 */
    assert.ok(L.layers.every(x => x.state === "absent" || x.state === "partial"),
        `这一关两层都不在带上，实得 ${JSON.stringify(L.layers.map(x => x.state))}`);
    /* 关键：**没进过 hub**。这是模型最需要知道、而一直不知道的事实。 */
    assert.equal(L.everDelivered, false,
        `delivered=0 且 hub 账本里没有目标形状 ⇒ everDelivered 必须为 false`);
});

test("★ 不许恒等于常量：不同世界必须渲染出不同的行", { skip: !HAS_LIVE && "缺真机 run 快照" }, () => {
    /* 验收 1。如果台账字段是常量，它就是个昂贵的废话 ——
     * `feed_sources` 那一轮已经栽过「加了但输出恒等」（推荐错颜色）。
     *
     * 用**不同目标**而不是不同世界：两个真机世界的本关进度都真的是零
     * （506 个快照里本关目标只出现过 0 次），所以拿同一个目标去比它们必然相等 ——
     * 那不是缺陷，是真话。真正要钉的是「读数会随世界/目标变」。 */
    const a = loadRun("r-20261121190439-6190");
    const L1 = progressLedger({ ...a, goalShape: "ScSc----" });       // 有 139 件
    const L2 = progressLedger({ ...a, goalShape: "CpCpCpCp" });       // 一件没有
    const r1 = JSON.stringify(L1.layers), r2 = JSON.stringify(L2.layers);
    assert.notEqual(r1, r2, `两个不同目标必须渲染出不同的 layers，实得都是 ${r1}`);

    const p1 = JSON.stringify(L1.pigments), p2 = JSON.stringify(L2.pigments);
    assert.notEqual(p1, p2, `不同目标需要的颜料不同，pigments 必须不同：${p1} vs ${p2}`);
});

test("★ 不许挤掉带子：加了读数之后 belts_shown 不下降", () => {
    /* 验收 3。prompt 预算余量已经是 -72，任何增量都在和带子名额竞争。
       这条最容易悄悄红 —— 而带子是模型唯一能就地改造的对象。 */
    const obs = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const h = buildHandles(obs, null);
    const budget = { in_chars_max: 24000, prompt_tokens_max: 5300 };
    const ds = diagnose(obs, null, null, null, GOAL, h, { recipe: null });

    /* 传 items = null ⇒ ledger 靠 hub 账本仍能算；不传 items 时也必须有货
       （夹具里有 stored_shapes 吗？没有也不该崩）。 */
    const withL = buildPrompt({ goal: GOAL, obs, handles: h, diagnoses: ds, candidates: candidatesFor(ds), lastRound: null, budget, items: null });
    const shown = (withL.blocks.s3_belts.match(/^B\d+/gm) || []).length;
    assert.ok(shown > 0,
        `读数不许把带子挤到 0，实得 ${shown}（PROGRESS 行 ${(withL.blocks.s3_goal || "").split("\n").length} 行）`);
});

test("数据不足时整段不出现（不猜）", () => {
    const L = progressLedger({ obs: { goal: { requirement: { shape: GOAL } } }, items: null, production: null, goalShape: GOAL });
    assert.equal(L, null, `没有 items 也没有 hub 账本时应当返回 null，实得 ${JSON.stringify(L)}`);
});
