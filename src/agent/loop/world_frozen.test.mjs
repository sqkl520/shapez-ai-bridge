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

test("★ 死世界上必须触发，且数字要与实测对得上", () => {
    const { obs, items, production } = loadRun(DEAD_RUN);
    /* 前提：这个世界确实是死的（否则这条测试就变成在测别的东西） */
    const produced = production.result && production.result.produced_total !== undefined
        ? production.result.produced_total : production.produced_total;
    assert.equal(Object.keys(produced || {}).length, 0,
        "前提：该快照的 produced_total 必须为空");

    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
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

test("★ 必须带能落地的句柄（否则等于没诊断）", () => {
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");
    assert.ok(Array.isArray(wf.handles) && wf.handles.length >= 1,
        `句柄不能为空，实得 ${JSON.stringify(wf.handles)}`);
    /* 句柄必须是真实存在的带子（照着 prompt 写进 connect/remove_run 能被认出来） */
    for (const h of wf.handles) {
        assert.match(h, /^B\d+$/, `句柄格式应是 B<数字>，实得 ${h}`);
    }
    /* hint 里必须出现「先通开」这一类语义，否则模型会继续去接缺料口 */
    assert.ok(/通开|吃掉|拆掉|改道/.test(wf.hint),
        `hint 必须指向"疏通"而不是"连接"，实得：${wf.hint.slice(0, 120)}`);
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

    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        `世界还在产出时不许报 WORLD_FROZEN，实得 ${ds.map(d => d.code).join(",")}`);
});

test("★ 反例：没有 production 数据时不许猜", () => {
    const { obs, items } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, null, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        "读不到产出窗口 ⇒ 不判定（与语义层其它地方同一条纪律）");
});

test("★ 反例：hint 里不许推荐过不了闸门的动作", () => {
    /* 第一版写的是「用 `trash_unused` 吃掉堆积的货」。**那是空头支票**：
     * `trash_unused` 对「出口已经有下游」的带子一律拒绝
     * （`remove.mjs` 的 `port_already_bound`，注释写着「绝不抢既有货流」），
     * 而这里最堵的那条带子末端正好接着 stacker —— 模型照做必然被拒一轮。
     *
     * 本项目已有同族教训（`feed-sources-need-two-filters`）：错误的指路比不给贵得多。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");
    assert.ok(wf.evidence.worst.no_acceptor === false,
        "前提：这份快照的堵点末端**接了**机器（这才让 trash_unused 非法）");

    /* hint 的可用部分（前 180 字符，prompt 的 clip 上限）必须不含被禁动作 */
    const usable = wf.hint.slice(0, 180);
    assert.ok(!/`trash_unused` 吃掉|用 `trash_unused`/.test(usable),
        `前 180 字符里不许把 trash_unused 当解法推荐，实得：${usable}`);
    /* 必须点名一个真能落地的动作 */
    assert.ok(/remove_run|connect/.test(usable),
        `前 180 字符里必须给 remove_run 或 connect，实得：${usable}`);
    /* candidates 的第一名也必须是能落地的 */
    assert.ok(["remove_run", "connect"].includes(wf.candidates[0]),
        `候选第一名必须是 remove_run 或 connect，实得 ${wf.candidates[0]}`);
});

test("★ 回归：堵塞路径终结于 hub 入口时，不许被 dropInlets 过滤掉", () => {
    /* 这个 bug 极隐蔽：`diagnose()` 的 `dropInlets` 按 `subject.uid` 过滤 ——
     * 凡是主语落在 hub 入口带子上的诊断，一律当作「入口相关」删掉（那个过滤本身是对的）。
     *
     * 而第一版 `WORLD_FROZEN` 的 subject 取的是**路径末端**，那条带子的下游正好是
     * `H1.primary`（hub 入口）⇒ 整条诊断在合并阶段被吞掉，一条都到不了 prompt，
     * 而它的内容恰恰是「137 件货堵在入口进不去」—— 最该被看见的那条。
     *
     * 修法：subject 指向**路径起点**（矿机那一端，拥堵的源头），句柄仍给末端。
     *
     * 这份快照（r-20261116090537-d70e）是 47 个漏报样本之一，正好踩中。 */
    const { obs, items, production } = loadRun("r-20261116090537-d70e");
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, `堵塞路径终结于 hub 入口时也不许被过滤，实得 ${ds.map(d => d.code).join(",")}`);
    /* subject 必须是真实带子，而且是**路径起点**那一端，不是 hub 入口 */
    assert.ok(wf.subject && typeof wf.subject.handle === "string" && /^B\d+$/.test(wf.subject.handle),
        `subject 必须是带子句柄，实得 ${JSON.stringify(wf.subject)}`);
    /* 句柄仍然要指向末端（模型在那一端动手） */
    assert.ok(wf.handles.length >= 1, "句柄不能为空");
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
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
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
    assert.ok(wf.handles.includes(headHandle),
        `句柄必须包含路径**起点** ${headHandle}，实得 ${JSON.stringify(wf.handles)}`);

    /* 终点句柄不能出现在列表里（那正是被闸门拒的那一端） */
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
    const overlap = wf.handles.filter(h => tailHandles.includes(h));
    assert.equal(overlap.length, 0,
        `句柄不许指向末端（那是预演必拒的一端），重叠：${JSON.stringify(overlap)}`);
});

test("★ 排序：WORLD_FROZEN 必须排在 NO_PRODUCTION 之前", () => {
    /* 两条都描述零产出，但动作方向相反：
     *   WORLD_FROZEN  → 通开
     *   NO_PRODUCTION → 新建
     * 在满载世界里让模型看到「去新建」是灾难。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const iFrozen = ds.findIndex(d => d.code === "WORLD_FROZEN");
    const iNoProd = ds.findIndex(d => d.code === "NO_PRODUCTION");
    assert.ok(iFrozen >= 0, "前提：WORLD_FROZEN 必须存在");
    assert.ok(iNoProd >= 0, "前提：NO_PRODUCTION 必须存在");
    assert.ok(iFrozen < iNoProd,
        `WORLD_FROZEN 必须排在 NO_PRODUCTION 之前（实得 ${iFrozen} vs ${iNoProd}）`);
});
