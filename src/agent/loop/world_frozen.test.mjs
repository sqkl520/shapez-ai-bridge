/**
 * world_frozen.test.mjs — `WORLD_FROZEN`：整座工厂零产出时的堵点诊断
 *
 * ## 为什么需要它（2026-11-23，567 个快照的统计）
 *
 * 按关卡分组 `produced_total` 是否为空：
 *
 *   level  9   58 个快照，16 个空（28%）   ← 正常
 *   level 12  508 个快照，500 个空（98%） ← 异常
 *
 * 同一存档、同一桥、同一套代码。**只有 L12 是死的。**
 * 而 91.0% 的沉默快照同时满足「零产出」与「带子上有货」—— 世界是载入的，只是不动。
 *
 * 形态（`r-20261123151728-52a3` 实测）：
 *
 *   path8   165 格带子塞了 259 件（98.9%），blue ×131 + ScSc---- ×128
 *   path20   55 格带子塞了 87 件纯蓝颜料，末端 `boundAcceptor = null`
 *
 * ## 三条验收
 *
 * 1. **死世界上必须触发**，且数字对得上（259 件 / 165 格）
 * 2. **活世界上一律不报** —— 满载是这套工厂的常态（50 个在产出的快照里 30 个出口也全堵），
 *    拿「堵」当判据会去修正常的东西
 * 3. **必须带能落地的句柄** —— 一条说不出改哪里的诊断等于没诊断
 *
 * 第 2 条是这次最容易被写错的地方：判据只能是「**全图零产出**」，
 * 不能是「出口堵满」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { diagnose } from "../loop.mjs";
import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, "../../../research/ai-plan/runs");
const GOAL = "CbCbCbRb:CwCwCwCw";

/** 读一个 run 的三件套。缺任何一个都抛（不 skip —— 缺夹具必须红）。 */
function loadRun(id) {
    const b = path.join(RUNS, id) + path.sep;
    const r = (f) => JSON.parse(fs.readFileSync(b + f, "utf8"));
    return { obs: r("obs-last.json"), items: r("items-last.json"), production: r("production-last.json") };
}

const DEAD_RUN = "r-20261123151728-52a3";

/**
 * 「第二轮」的假 verify 报告。
 *
 * `WORLD_FROZEN` 用 `report === null` 判「本轮是不是第一次观察」：
 * `ProductionAnalytics` 不进存档，`load_save` 之后头 10 秒 `produced_total`
 * 必然是 `{}` —— 第一轮的空窗口可能只是预热（红队 §1.3：50 个活世界
 * 用空窗口当替身，50/50 全部误报）。
 *
 * 而**这个死世界的片也是全空的**（实测 6 片全空、`run_start → observe` 14.5 秒，
 * 早过了预热）。所以判据必须区分「第一轮的预热」与「后续轮次的真零产出」。
 *
 * 测试要测的是后者，所以显式给一个非 null 的 report。
 */
const SECOND_ROUND = { checks: [] };

test("★ 死世界上必须触发，且数字要与实测对得上", () => {
    const { obs, items, production } = loadRun(DEAD_RUN);
    /* 前提：这个世界确实是死的（否则这条测试就变成在测别的东西） */
    const produced = production.result && production.result.produced_total !== undefined
        ? production.result.produced_total : production.produced_total;
    assert.equal(Object.keys(produced || {}).length, 0,
        "前提：该快照的 produced_total 必须为空");

    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, `死世界必须报 WORLD_FROZEN，实得 ${ds.map(d => d.code).join(",")}`);

    /* 数字必须是真的，不是占位符 */
    const worst = wf.evidence && wf.evidence.worst;
    assert.equal(worst.items, 259, "最堵的一条必须是 259 件");
    assert.equal(worst.cells, 165, "那条带子必须是 165 格");
    assert.ok(wf.observed.includes("259"), `observed 里必须出现 259，实得：${wf.observed}`);
    assert.ok(wf.observed.includes("165"), `observed 里必须出现 165，实得：${wf.observed}`);
    assert.ok(wf.observed.includes("blue") && wf.observed.includes("ScSc----"),
        `必须说出堵的是什么货，实得：${wf.observed}`);
});

test("★ 句柄在 evidence 里，不在 `handles` 里（它不施工）", () => {
    /* 2026-11-23 红队复测 B1 的另一半：
     *
     * 改了 hint（不再开处方）之后，`handles` 仍然指向那 3 格，
     * 于是**模拟删除的结果和修复前一模一样**（0/516 让世界变好）。
     *
     * 原因：`handles` 是模型唯一能直接塞进 `$uids` 的形态。只要它在，
     * 模型就会去用 —— hint 说什么都拦不住一个现成的句柄数组。
     *
     * 而这条诊断的定位现在是**警报**：它报告「世界停转了」这个事实，
     * 不提供施工图。施工图由 `MACHINE_STARVED` 等成因类诊断给。
     *
     * 所以句柄挪进 `evidence.clogged_handles`：不参与渲染、不被 `pickBelts`
     * 优先显示、不占带子名额（红队 §2：`## CAPACITY` 被挤掉 66/516）。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");

    /* `handles` 必须为空 —— 有它模型就会照着拆 */
    assert.equal((wf.handles || []).length, 0,
        `handles 必须为空（否则模型会照拆），实得 ${JSON.stringify(wf.handles)}`);
    /* 但位置上必须留在 evidence 里 —— 报警要说得清是哪条 */
    assert.ok(Array.isArray(wf.evidence.clogged_handles) && wf.evidence.clogged_handles.length >= 1,
        `evidence.clogged_handles 必须留档，实得 ${JSON.stringify(wf.evidence.clogged_handles)}`);
    /* candidates 也必须为空 —— 516 个模拟里没有一个候选宏是对的 */
    assert.equal((wf.candidates || []).length, 0,
        `candidates 必须为空，实得 ${JSON.stringify(wf.candidates)}`);
});

test("★ 反例：世界还在动的时候一律不报（满载是常态，不是故障）", () => {
    /* L9 时代的快照 —— 那个世界还在产出（`produced_total` 非空），
     * 而它的 ejector 也大多是堵的。两者必须分得开。 */
    const liveRun = "r-20261110143303-686b";
    const { obs, items, production } = loadRun(liveRun);
    const produced = production.result && production.result.produced_total !== undefined
        ? production.result.produced_total : production.produced_total;
    assert.ok(Object.keys(produced || {}).length > 0,
        "前提：这个快照必须还在产出");

    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        `世界还在产出时不许报 WORLD_FROZEN，实得 ${ds.map(d => d.code).join(",")}`);
});

test("★ 反例：没有 production 数据时不许猜", () => {
    const { obs, items } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, null, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        "读不到产出窗口 ⇒ 不判定（与语义层其它地方同一条纪律）");
});

test("★ 反例：hint 里不许推荐任何动作（它是警报，不是处方）", () => {
    /* 2026-11-23 红队 B1 推翻了「开处方」这件事本身。
     *
     * 它在 516 个零产出快照上把「照这条 hint 做」逐个模拟：
     *
     *     0/516 让「到 hub 的带子」变多
     *   486/516 让它变少（中位 -3）
     *     30 个 cleanup 全是「reach 不变、死带子减少」
     *     没有一个样本出现 delivered / stored_goal 上升
     *
     * 因为真实死锁链是：painter 的 color 槽空 ⇒ stacker 的 lower 没料 ⇒
     * **path8（upper 那一路）淤 259 件**。path8 是**淤积的那条**，不是堵住的那条。
     * 删它 = 拆受害者。真正能解开的是给 painter 的 color 槽接料，
     * 而那正是 `MACHINE_STARVED` 指的地方。
     *
     * 所以这条诊断现在的定位是「世界已经停转」的**警报**，
     * 它必须**明确把处方让出去**，而不是自己开一个。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");

    const usable = wf.hint.slice(0, 180);
    /* 不许把 `remove_run` / `trash_unused` / `connect` 当解法推荐 ——
     * 这 516 个模拟里没有一个让世界变好。 */
    assert.ok(!/`remove_run`\s*它的/.test(usable),
        `前 180 字符里不许再把 remove_run 当解法，实得：${usable}`);
    /* 必须说清「这是结果，不是成因」 */
    assert.ok(/结果|成因/.test(usable),
        `必须说清它是结果不是成因，实得：${usable}`);
    /* 必须把处方让给别的诊断 */
    assert.ok(/先去修|别的线索|上面那些/.test(usable),
        `必须把处方让出去，实得：${usable}`);
});


test("★ 回归：堵塞路径终结于 hub 入口时，不许被 dropInlets 过滤掉", () => {
    /* 这个 bug 极隐蔽：`diagnose()` 的 `dropInlets` 按 `subject.uid` 过滤 ——
     * 凡是主语落在 hub 入口带子上的诊断，一律当作「入口相关」删掉（那个过滤本身是对的）。
     *
     * 而第一版 `WORLD_FROZEN` 的 subject 取的是**路径末端**，那条带子的下游正好是
     * `H1.primary`（hub 入口）⇒ 整条诊断在合并阶段被吞掉，一条都到不了 prompt，
     * 而它的内容恰恰是「137 件货堵在入口进不去」—— 最该被看见的那条。
     *
     * 修法：subject 指向**路径起点**（矿机那一端，拥堵的源头），而不取末端。
     *
     * 这份快照（r-20261116090537-d70e）是 47 个漏报样本之一，正好踩中。 */
    const { obs, items, production } = loadRun("r-20261116090537-d70e");
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, `堵塞路径终结于 hub 入口时也不许被过滤，实得 ${ds.map(d => d.code).join(",")}`);
    /* subject 必须是真实带子，而且是**路径起点**那一端，不是 hub 入口 */
    assert.ok(wf.subject && typeof wf.subject.handle === "string" && /^B\d+$/.test(wf.subject.handle),
        `subject 必须是带子句柄，实得 ${JSON.stringify(wf.subject)}`);
    /* 句柄不施工（见上一条测试），但位置要留档 */
    assert.ok(wf.evidence.clogged_handles.length >= 1,
        "evidence.clogged_handles 不能为空 —— 报警要说得清是哪条");
});

test("★ 句柄必须指向源头端，不能指向末端（预演闸门只放行源头）", () => {
    /* 2026-11-23 三臂真调 LLM 实验的核心结论（`VERIFY-WORLD-FROZEN-2026-11-23.md`）。
     *
     * 旧实现取 `cells.slice(-6)`（末 6 格）。模型 11/12 一字不差照抄了，
     * 但 `buildTxPlan` 的预演闸门对两端**不对称**：
     *
     *   删末端 B85..B90 → 死带子 390→549（+159）⇒ PLAN_REJECTED
     *   删中段 30 格    → 390→450             ⇒ PLAN_REJECTED
     *   删 B522（第一格）→ **1 op，放行**
     *
     * 真调 LLM（n=12）：指末端落地 0/12，指源头落地 12/12（p<0.0001）。
     * 同一份 obs、同一个模型、同一套宏，**只换了一个句柄**。
     *
     * 所以这条测试钉的不是「句柄格式对不对」，而是「方向对不对」。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");

    /* 拿这条路径的起点与终点句柄做比对 */
    const tbl = buildHandles(obs.result || obs, items.result || items);
    const worstPath = (items.result || items).paths[wf.evidence.worst.path];
    const headUid = () => {
        const idx = new Map((obs.result || obs).entities.map(e => [e.x + "," + e.y, e]));
        for (const c of worstPath.cells) {
            const rec = idx.get(c[0] + "," + c[1]);
            if (rec && (rec.type === "belt" || rec.type === "underground_belt")) {
                const h = tbl.byUid.get(rec.uid);
                if (h) return h;
            }
        }
        return null;
    };
    const headHandle = headUid();
    assert.ok(headHandle, "前提：路径起点必须能拿到句柄");
    assert.ok(wf.evidence.clogged_handles.includes(headHandle),
        `存档位置必须包含路径**起点** ${headHandle}，实得 ${JSON.stringify(wf.evidence.clogged_handles)}`);

    /* 终点句柄不能出现在列表里（那是预演必拒的一端） */
    const tailCells = worstPath.cells.slice(-6);
    const tailHandles = [];
    {
        const idx = new Map((obs.result || obs).entities.map(e => [e.x + "," + e.y, e]));
        for (const c of tailCells) {
            const rec = idx.get(c[0] + "," + c[1]);
            if (rec && (rec.type === "belt" || rec.type === "underground_belt")) {
                const h = tbl.byUid.get(rec.uid);
                if (h && !tailHandles.includes(h)) tailHandles.push(h);
            }
        }
    }
    const overlap = wf.evidence.clogged_handles.filter(h => tailHandles.includes(h));
    assert.equal(overlap.length, 0,
        `存档位置也不许指向末端（那是预演必拒的一端），重叠：${JSON.stringify(overlap)}`);
});

test("★ 反例：载入预热期（第一轮 + 片全空）不许报", () => {
    /* 2026-11-23 红队 §1.3 抓到的误报源。
     *
     * `ProductionAnalytics` **不写进存档** —— `savegame_serializer.js` 的 dump 里
     * 没有它，`core.js:127` 每次 `new ProductionAnalytics(root)` 造一个全新的，
     * 构造函数里塞满 `statisticsGraphSlices=100` 个**空片**。
     *
     * 所以 `load_save` 之后的头 10 秒 `produced_total` 必然是 `{}`，
     * 与世界的死活无关。实测 567 个快照里 41 个的 `run_start → observe` < 2 秒。
     *
     * 红队用空窗口当替身把 50 个**活世界**跑了一遍：**50/50 全部误报**，
     * 报出来是「整图零产出，最堵的一条 66 件满载」—— 而那个世界每分钟交 61 件。
     *
     * 判据：第一轮（`report === null`）且片全空 ⇒ 可能是预热，不判。
     * 第二轮及以后的空窗口才是真零产出（那份死世界实测 6 片全空、
     * `run_start → observe` 14.5 秒，早过了预热）。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        `第一轮 + 片全空 ⇒ 不许报（可能是载入预热），实得 ${ds.map(d => d.code).join(",")}`);

    /* 对照：同一份快照，第二轮就要报 */
    const ds2 = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    assert.ok(ds2.some(d => d.code === "WORLD_FROZEN"),
        "第二轮同样的空窗口必须报 —— 那份世界实测早过了预热期");
});

test("★ 反例：两轮间隔 < 10 秒时不许报（窗口可能还没轮转）", () => {
    /* 2026-11-23 红队复测抓到的漏修。第一版用「第几轮」当门槛（`report === null`），
     * 实测**只修了一半**：
     *
     *   2203 个 round-2..n 的 observe 间隔：min 0.1s  **p10 7.1s**  median 16.6s
     *   **25% 的轮次间隔不到一个统计片（10 秒）**
     *
     * 而 `ProductionAnalytics.update()` 只在
     * `root.time.now() - lastAnalyticsSlice > 10` 时轮转一片（`production_analytics.js:129`）。
     * 间隔 < 10 秒 ⇒ 窗口里可能全是旧片、当前片刚被清空 ⇒ `produced_total` 依然 `{}`。
     *
     * 复测（50 个健康世界喂空窗口 + `report` 非空）：
     * **50/50 仍然被误报**，而它们每分钟交 266–291 件成品。
     *
     * 判据必须是「这一轮距上一轮过了多少**游戏秒**」，不是「第几轮」。
     */
    const { obs, items, production } = loadRun(DEAD_RUN);

    /* 间隔 7.1 秒（红队的 p10 实测值）⇒ 不许报，即使已经是第二轮 */
    const dsThin = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 7.1 });
    assert.ok(!dsThin.some(d => d.code === "WORLD_FROZEN"),
        `间隔 7.1s < 10s ⇒ 窗口可能没轮转，不许报，实得 ${dsThin.map(d => d.code).join(",")}`);

    /* 间隔 0.1 秒（红队的 min 实测值）⇒ 更不许报 */
    const dsHair = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 0.1 });
    assert.ok(!dsHair.some(d => d.code === "WORLD_FROZEN"),
        "间隔 0.1s ⇒ 不许报");

    /* 对照：40 游戏秒（> 10s）⇒ 必须报 */
    const dsOld = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    assert.ok(dsOld.some(d => d.code === "WORLD_FROZEN"),
        "间隔 40s ≥ 10s ⇒ 窗口够老，必须报");

    /* 对照：拿不到间隔（首轮）⇒ 不判 */
    const dsNoTick = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: null });
    assert.ok(!dsNoTick.some(d => d.code === "WORLD_FROZEN"),
        "拿不到 tick 间隔 ⇒ 观测不全 ⇒ 不判");
});

test("★ 排序：它是警报，必须排在可行动的成因类诊断**之后**", () => {
    /* 2026-11-23 二次修正。第一版登记 rank 4，后来提到 1（为了压过
     * `MACHINE_STARVED`）。**那个理由被红队 B1 推翻了。**
     *
     * 真实死锁链：painter 的 color 槽空 ⇒ stacker 的 lower 没料 ⇒
     * **path8（upper 那一路）淤 259 件**。path8 是淤积的那条，不是堵住的那条。
     * `MACHINE_STARVED` 指的 `C3.color` 才是成因。
     *
     * 而且它的 hint 现在明说「先去修上面那些」——排第一会让那句话变成无稽之谈。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null, { recipe: null, tickSincePrev: 40 });
    const iFrozen = ds.findIndex(d => d.code === "WORLD_FROZEN");
    const iStarved = ds.findIndex(d => d.code === "MACHINE_STARVED");
    assert.ok(iFrozen >= 0, "前提：WORLD_FROZEN 必须存在");
    assert.ok(iStarved >= 0, "前提：MACHINE_STARVED 必须存在");
    assert.ok(iStarved < iFrozen,
        `指示成因的 MACHINE_STARVED 必须排在警报之前（实得 starved=${iStarved} frozen=${iFrozen}）`);
    /* hint 里那句「先去修上面那些」要求它前面确实有东西 */
    assert.ok(iFrozen > 0, "它前面必须有别的诊断，否则「上面那些」指代不到任何东西");
});
