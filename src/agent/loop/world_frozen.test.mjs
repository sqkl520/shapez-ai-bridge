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

/* ══════════════════════════════════════════════════════════════════════════
 * 截断（`truncatedPaths === true`）：`paths[]` 只有前 40 条，但 `belts[]` 是全量的
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 缺陷（`REDTEAM-WORLD-FROZEN-2026-11-23.md` §5.2）
 *
 * `out.paths = paths.slice(0, 40)` —— 而 `WORLD_FROZEN` 的 `clogged` 扫描跟着
 * `itemsDoc.paths` 走，于是**第 40 条之后的路径完全看不见**。
 * 它们的货量却仍被算进 `itemsDoc.belts`（那个数组只按 region 过滤，不按路径截断）。
 *
 * 复现（`.findings/FIX-TRUNCATED-PATHS-2026-11-24.md`，516 个触发快照）：
 *
 *   截断且触发的快照            17
 *   报出来的 `worst` 低于被切部分  **10**
 *   最严重的一例（r-20261113084958-4e86）：
 *     报「最堵的一条 31 件 / 19 格」
 *     实际第 49 号路径上有 **166 件**，被切掉的部分合计 ≥277 件
 *
 * `observed` 里那句「最堵的一条」因此在 10/17 的快照上是**错的**，
 * 而且错向最糟的一边（**低估**）。
 *
 * ## 修法与它的边界
 *
 * 语义层**不假装看得见**：截断时把话说成「可见最堵」，并报出「另有 K 条未返回、
 * 至少还有 N 件货」。`N` 由 `belts[].path` 聚合而来 —— 口径已核对：
 * 566 个快照、16828 条路径上，`belts[].path` 的行数与游戏自己的
 * `paths[i].itemsOnPath` **零失配**（脚本见上面那份 findings）。
 *
 * ⚠️ 它是**下界**：`belts` 受 region 过滤，可能数不满。文案与 evidence
 * 都必须说「至少」，测试也钉住这一点。
 *
 * 为什么不在 mod 里按货量排序后再截断（那会让模型永远看到最堵的）：
 * 那需要重新 patch 游戏，而当时 `mod_connected: false`，无法真机验证；
 * 而且改了顺序就**破坏了 `belts[].path` ↔ `paths[]` 下标对齐**
 * （那个对齐在 523/523 个快照上是成立的，gates.mjs 的流向判据依赖它）。
 */

/** §5.2 里那一例：pathCount 50、只返回 40 条、被切部分藏着 166 件。 */
const TRUNCATED_RUN = "r-20261113084958-4e86";

test("★ 截断时：observed 不许把可见范围内的最堵说成全局最堵", () => {
    const { obs, items, production } = loadRun(TRUNCATED_RUN);
    const it = items.result || items;
    assert.equal(it.truncatedPaths, true, "前提：这份夹具必须是截断的");
    assert.ok(it.pathCount > it.paths.length, "前提：pathCount 必须大于返回条数");

    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");

    /* ① 不许出现「最堵的一条」这种全局断言 —— 那是 10/17 快照上错掉的那句话 */
    assert.ok(!/最堵的一条/.test(wf.observed),
        `截断时不许说「最堵的一条」，实得：${wf.observed}`);
    /* ② 必须说的是「可见」 */
    assert.ok(/可见/.test(wf.observed), `必须标明这是可见范围，实得：${wf.observed}`);
    /* ③ 必须把「还有多少没看见」说出来 */
    assert.ok(/未返回|没被返回/.test(wf.observed),
        `必须说明有路径没返回，实得：${wf.observed}`);
    assert.ok(/至少/.test(wf.observed),
        `货量是下界，必须写「至少」，实得：${wf.observed}`);
});

test("★ 截断时：被切部分的货量必须真的算出来（那一例是 166 件）", () => {
    const { obs, items, production } = loadRun(TRUNCATED_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");
    const ev = wf.evidence;

    /* 这几条是**从数据里数出来的**，不是占位符：
     * path 49 上有 166 件，被切掉的部分合计 ≥277 件。 */
    assert.equal(ev.paths_shown, 40, "可见 40 条");
    assert.equal(ev.paths_total, 50, "世界共 50 条");
    assert.equal(ev.paths_truncated, true, "必须标记截断");
    assert.equal(ev.hidden_worst_items_at_least, 166, "被切部分最重的一条 ≥166 件");
    assert.equal(ev.hidden_worst_path, 49, "那条是 path 49");
    assert.equal(ev.hidden_items_at_least, 277, "被切部分合计 ≥277 件");
    assert.ok(ev.hidden_worst_items_at_least > ev.worst.items,
        "这一例正是「被切掉的比报出来的更重」—— 修之前报的是 31 件");
    /* 可见范围内的 worst 仍然要报（它本身没错，只是不能说成全局） */
    assert.equal(ev.worst.scope, "visible", "截断时 worst 的作用域必须是 visible");
    /* observed 里必须出现那个 166 —— 否则模型看不到「漏了多少」 */
    assert.ok(wf.observed.includes("166"),
        `observed 必须带上被切部分的最重值，实得：${wf.observed}`);
});

test("★ 截断时：observed 必须在 120 字符内（否则警告本身会被渲染端切掉）", () => {
    /* `prompt.mjs:renderDiagnoses` 对 observed 做 `compact(…, 120)`。
     * 第一版文案 126 字符 —— 渲染后变成「… —— 真正的「最堵」可…」，
     * **警告本身被截掉了**，等于没改。
     *
     * 这是 `hint-truncated-before-arrival` 的同一形态：算出来 ≠ 送达。
     * 所以这里直接钉住长度，而不是只钉住「字符串里有这个词」。 */
    const { obs, items, production } = loadRun(TRUNCATED_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");
    assert.ok(wf.observed.length <= 120,
        `observed 必须 ≤120 字符（渲染端硬预算），实得 ${wf.observed.length}：${wf.observed}`);
    /* 关键的三个数字都必须在 120 字符之内出现 */
    for (const must of ["40", "50", "166"]) {
        assert.ok(wf.observed.indexOf(must) < 120, `「${must}」必须落在前 120 字符里：${wf.observed}`);
    }
});

test("★ 非截断时：文案与作用域都不变（不许把截断逻辑漏进正常路径）", () => {
    /* 反向保护：`pathsTruncated` 为 false 时，一切必须与修改前逐字一致 ——
     * 那 500 个非截断快照上的文案是被红队逐字核过的。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const it = items.result || items;
    assert.equal(it.truncatedPaths, false, "前提：这份夹具不是截断的");
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");
    assert.ok(/最堵的一条/.test(wf.observed),
        `非截断时必须保留原来的「最堵的一条」，实得：${wf.observed}`);
    assert.ok(!/未返回/.test(wf.observed), `非截断时不许出现截断警告，实得：${wf.observed}`);
    assert.equal(wf.evidence.worst.scope, "all", "非截断时作用域是 all");
    assert.equal(wf.evidence.paths_truncated, false, "非截断时标记必须是 false");
    assert.equal(wf.evidence.hidden_items_at_least, 0, "非截断时没有「被切部分」");
});

test("★ 截断时：hint 的处方仍在 180 字符内（截断警告不许挤掉「先去修上面那些」）", () => {
    /* `renderDiagnoses` 对普通诊断的 hint 做 `clip(…, 180)`。
     * 前 180 字符必须留给 `REDTEAM B1` 用 516 个样本换来的定位 ——
     * 「这是结果，不是成因 / 先去修上面那些」。
     * 把截断警告插在中间会把它挤出去 = 用一条警告换掉一条处方。 */
    const { obs, items, production } = loadRun(TRUNCATED_RUN);
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");
    const head = wf.hint.slice(0, 180);
    assert.ok(/先去修|别的线索|上面那些/.test(head),
        `前 180 字符必须仍然把处方让出去，实得：${head}`);
    /* 截断警告也要送达（可以落在 180 之后，但必须在 hint 里） */
    assert.ok(/只返回了|未返回/.test(wf.hint), `hint 里必须带截断警告，实得：${wf.hint}`);
});

test("★ 截断 + 被切部分无货时：不许编造「藏着更重的路径」", () => {
    /* 反例保护。r-20261115225425-cc9b：pathCount 41、返回 40，
     * 被切掉的那 1 条上**没有货**。
     * 这种情况下文案必须说「其中无货」，而不能跟着喊「至少还有 N 件」。 */
    const { obs, items, production } = loadRun("r-20261115225425-cc9b");
    const it = items.result || items;
    assert.equal(it.truncatedPaths, true, "前提：这份夹具必须是截断的");
    const ds = diagnose(obs, items, production, SECOND_ROUND, GOAL, null,
        { recipe: null, tickSincePrev: 40 });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：它必须报出来");
    assert.equal(wf.evidence.hidden_items_at_least, 0, "被切部分确实无货");
    assert.ok(/无货/.test(wf.observed), `必须说「其中无货」，实得：${wf.observed}`);
    assert.ok(!/至少 [1-9]/.test(wf.observed), `没有货就不许说「至少 N 件」，实得：${wf.observed}`);
    /* 但仍然要标记截断 —— 几何未知这件事本身不该被隐去 */
    assert.equal(wf.evidence.paths_truncated, true, "仍然要标记截断");
    assert.ok(/未知/.test(wf.observed), `几何未知必须说出来，实得：${wf.observed}`);
});
