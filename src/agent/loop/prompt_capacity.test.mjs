/**
 * prompt_capacity.test.mjs — CAPACITY 段的验收（TDD，**零 rpc**）。
 *
 * ## 这个文件为什么存在
 *
 * 用户的反馈原话：「建的很丑陋也没有调理的绕远路，**明明有可以快捷提高产能的方法却没有用**」。
 *
 * 实测的产能真相（L4 存档，`belt:1 miner:1 processors:0`，3 台矿机、1 台 cutter）：
 *
 *   带子      3.0 items/s      = 2 × 1.5
 *   矿机      0.60 items/s/台  = 0.4 × 1.5
 *   3 台合计  1.80 items/s
 *   单台 cutter 消费/产出 0.50 items/s = 2 × processors(1) × 1/4
 *   利用率    28%  ⇒ **72% 的矿机产出堵在那一台 cutter 前面**
 *
 * 而在加这一段之前，prompt 里关于产能的全部信息只有 MACHINES 段的一串句柄与
 * PRODUCTION 段的历史速率 —— 没有任何一句说「你现在卡在哪、加什么最划算」。
 * 模型能从 MACHINES 数出「1 台 cutter」，却没有任何依据判断这个 1 是够的还是不够的。
 *
 * ## 覆盖
 *
 *   A. 正例（L4 真实数据）⇒ 渲染出「利用率 28%」「瓶颈 cutter」
 *   B. 正例（产能平衡）⇒ 说「不是瓶颈」，不硬报问题
 *   C. 反例（没有 production / 没有升级数据 / 没有 resources / 空世界）⇒ 优雅降级
 *   D. 预算（这是最难的一条）：加这一段之后 **`belts_shown` 不许比现在更差**
 *   E. 无循环依赖 + 数值与源码规则一致（`assess` 的准确性本身）
 *
 * 运行：`node --test src/agent/loop/prompt_capacity.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt, renderCapacity, PROMPT_RULES } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";
import { capacityFor, capacityOf, obsForAssess } from "../assess.mjs";
import { RATES, UPGRADE_MULTIPLIERS, UPGRADES, verifyRules } from "../rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SAVES = path.join(REPO, "test/fixtures/saves");
const load = name => JSON.parse(fs.readFileSync(path.join(SAVES, name), "utf8")).result;

/** L4 冷启动夹具（8 台矿机、1 台 cutter、`belt:1 miner:0`）。 */
const L4 = load("L4-obs.json");
/** **实机**跑出来的 L4 快照（3 台矿机、1 台 cutter、`belt:1 miner:1`）——
 *  「1.80 / 0.50 / 28%」这三个数就是它算出来的。 */
const L4_LIVE = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-live-miner1-obs.json"), "utf8"));
/** L5（`Cu----Cu`）—— 没有 resources，用来测「数据不可信时不乱说」。 */
const L5 = load("L5-obs.json");

const tableOf = obs => buildHandles(obs, null);

const promptFor = (obs, over = {}) => buildPrompt({
    goal: obs.goal.requirement.shape,
    obs,
    handles: tableOf(obs),
    diagnoses: [],
    candidates: ["replace_run", "connect", "trash_unused"],
    lastRound: null,
    budget: { rounds_left: 3, llm_calls_left: 4, tx_left: 3 },
    ...over,
});

/* ═══════════════════ A. 正例：L4 真实数据 ═══════════════════ */
test("A1 真实 L4 数据（miner:1，3 矿机 / 1 cutter）⇒ 供给 1.8、处理 0.5、利用率 28%", () => {
    const { capacity } = capacityFor(L4_LIVE);
    assert.equal(capacity.confidence, "ok");
    assert.equal(capacity.supplyPerSec, 1.8, "3 × 0.6");
    assert.equal(capacity.process.capacityPerSec, 0.5, "1 × 0.5");
    assert.equal(Math.round(capacity.utilization * 100), 28);
});

test("A2 同一份数据 ⇒ 瓶颈是 cutter，且说清「72% 堵在这里」", () => {
    const { capacity } = capacityFor(L4_LIVE);
    assert.equal(capacity.bottleneck, "process");
    assert.equal(capacity.bottleneckMachine, "cutter");
    assert.match(capacity.bottleneckDetail, /72%/);
});

test("A3 渲染出的 CAPACITY 段能回答「瓶颈在哪」", () => {
    const p = promptFor(L4_LIVE);
    const cap = p.blocks.s3_capacity;
    assert.ok(cap, `CAPACITY 段必须出现（unavailable=${p.blocks.capacity_unavailable}）`);
    assert.match(cap, /^## CAPACITY/m);
    assert.match(cap, /supply 1\.8\/s/);
    assert.match(cap, /processing 0\.5\/s/);
    assert.match(cap, /28% utilized/);
    assert.match(cap, /bottleneck: cutter/);
    assert.match(cap, /72% of supply is stuck here/);
});

test("A4 渲染出的 CAPACITY 段能比较「加机器 vs 升级」—— 但**只提做得到的**", () => {
    const p = promptFor(L4_LIVE);
    const cap = p.blocks.s3_capacity;
    assert.match(cap, /options:/, "必须给出可选项");
    assert.match(cap, /add 3 cutter \(1→4\)/, "加到吃满供给要 3 台");

    /* ★ 2026-11-13：这条断言**改回正面** —— `upgrade` 宏已经接进执行面了 ★
     *
     * 上一版断言的是反面（「接入前不得提议买升级」），理由完全正确：
     * 那时 loop 的执行面只有 7 个宏，没有任何一个能买升级，模型照着 prompt
     * 写 `{"macro":"upgrade"}` 会被 `LLM_UNKNOWN_MACRO` 拒掉 ——
     * 教模型做一个不存在的动作，比不提更坏。
     *
     * 现在 `upgrade` 在 `MACRO_NAMES` / `MACRO_FNS` / loop 的 plan 阶段都在了
     * （它不走 tx，走 `reader.upgrade` 的顶层 RPC），所以那条建议变成**可执行**的。
     *
     * 而「不提」的代价在这一刻比当初更大：level 9 实机上 `miner` 与 `painting`
     * 两档当场买得起（hub 里 RuRuRuRu×15583 / RbRb----×7219），
     * 白送的 ×1.5 采矿速率与涂装解锁，prompt 一个字都没说。 */
    assert.match(cap, /processors T\d/, "upgrade 宏已接入 ⇒ 必须提议买升级（零占格、全图生效）");
    assert.match(cap, /buy /i, "必须出现可执行的 buy 动作");

    /* 但**数据**仍然要算对 —— 这条与上面独立，接宏不该改变策略计算本身。 */
    const { options } = capacityFor(L4_LIVE);
    assert.ok(options.upgrade, "capacityFor 仍应算出升级这条路");
    assert.equal(options.upgrade.capacityAfter, 0.75, "升完 processors T1 是 0.5×1.5=0.75");
});

test("A5 「machinesToSaturate」与供给自洽（不是一个拍出来的数）", () => {
    const { capacity, options } = capacityFor(L4_LIVE);
    assert.equal(options.machinesToSaturate, 4, "ceil(1.8 / 0.5) = 4 台 cutter 才吃满");
    assert.equal(options.addMachines.enough, true, "4 台 × 0.5 = 2.0 ≥ 1.8");
    assert.ok(options.addMachines.capacityAfter >= capacity.supplyPerSec);
});

test("A6 L4 冷启动夹具（miner:0，8 矿机）也说得出瓶颈（说明不依赖某一档升级）", () => {
    /* ★ 2026-11-20 改：供给从 2.8 变成 1.6 —— 不是回归，是修掉了一个虚高 ★
     *
     * 这个夹具的 8 台矿机分在两个互不相连的分量里：
     *
     *   comp 0  4 台  (-9,4)(-8,5)(-10,4)(-7,5)  ＋ cutter ＋ hub   ← 有机器接
     *   comp 1  4 台  (2,-8)(3,-8)(4,-8)(5,-8)   ＋ 100 条带子      ← **没有任何加工机器**
     *
     * comp 1 那 4 台的产出物理上永远进不了任何工序，而旧实现把 8 台全算进供给
     * （7 × 0.4 = 2.8）。修完只算能接住的：一个在矿上、且与 cutter 连通 ⇒ 1.6。
     *
     * 这条测试的价值正在于它**带着**这个真实缺陷：L4 冷启动的世界里就有一半矿机
     * 是接不上任何东西的，而 prompt 从来没有说过这件事。 */
    const { capacity } = capacityFor(L4);
    assert.equal(capacity.confidence, "ok");
    assert.equal(capacity.miners.count, 8);
    assert.equal(capacity.miners.isolated, 4, "4 台矿机在任何加工机器的连通分量之外");
    assert.equal(capacity.supplyPerSec, 1.6, "4 台压在矿上 **且** 有机器接住 × 0.4");
    assert.equal(capacity.bottleneckMachine, "cutter");
    const p = promptFor(L4);
    assert.match(p.blocks.s3_capacity, /bottleneck: cutter/);
});

/* ═══════════════════ A7-A9：供给不许把孤岛矿机算进来 ═══════════════════ */

/**
 * 这三条的由来（2026-11-20）：
 *
 * 用户在 556 个 run 之后问「AI 能不能自主做出更高效率的机器」。
 * 查下来 `supply` 是 `矿机台数 × 速率`，唯一判据是「脚下有没有矿」——
 * **从不检查这台矿机的产出有没有任何机器能接住**。
 *
 * L12 真机实测：16 台矿机里 6 台在任何含加工机器的连通分量之外，
 * 却全部按全速率计入 `supply 12.8/s`，于是 CAPACITY 建议「再加 51 台 stacker」。
 */
test("A7 孤岛矿机（有矿、但分量里没有加工机器）不计入供给", () => {
    /* 左边一组：矿机 → 带子 → cutter → 带子 → hub（连通，算供给）
       右边一组：矿机 → 一条长带子，尽头什么都没有（孤岛，不算） */
    const entities = [
        { type: "hub", x: 0, y: 0 },
        { type: "miner", x: 0, y: 4 }, { type: "belt", x: 0, y: 3 },
        { type: "cutter", x: 0, y: 2 }, { type: "belt", x: 0, y: 1 },
        /* 孤岛：远离左边，完全不相邻 */
        { type: "miner", x: 20, y: 4 }, { type: "belt", x: 20, y: 3 },
        { type: "belt", x: 20, y: 2 }, { type: "belt", x: 20, y: 1 },
    ];
    const oreCells = [{ x: 0, y: 4, kind: "RuRuRuRu" }, { x: 20, y: 4, kind: "RuRuRuRu" }];
    const cap = capacityOf({ upgrades: { belt: 0, miner: 0, processors: 0, painting: 0 }, entities, oreCells });
    assert.equal(cap.miners.count, 2, "两台矿机都在世界里");
    assert.equal(cap.miners.isolated, 1, "右边那台是孤岛");
    assert.equal(cap.miners.active, 1, "只有左边那台算供给");
    assert.equal(cap.supplyPerSec, 0.4, "1 × 0.4，不是 2 × 0.4");
});

test("A8 同一格叠了 cutter 与带子时，仍要认出这个分量里有加工机器", () => {
    /* 回归：第一版用 `byCell`（cell → 一个实体，后者覆盖前者）判「分量里有机器」，
       于是同格叠放时加工机器会不可见，整组矿机被判成孤岛、供给归零。
       B1 夹具里正好有这种格子，当场打红。 */
    const entities = [
        { type: "miner", x: 0, y: 4 }, { type: "belt", x: 0, y: 3 },
        { type: "belt", x: 0, y: 2 }, { type: "cutter", x: 0, y: 2 },   // 同格
        { type: "belt", x: 0, y: 1 },
    ];
    const cap = capacityOf({ upgrades: {}, entities, oreCells: [{ x: 0, y: 4, kind: "RuRuRuRu" }] });
    assert.equal(cap.miners.isolated, 0, "同格叠放不许让加工机器消失");
    assert.equal(cap.supplyPerSec, 0.4);
});

test("A9 没有矿图时不能因为连不上就判成 0 产能（缺数据 ≠ 没产能）", () => {
    const entities = [
        { type: "miner", x: 0, y: 4 }, { type: "belt", x: 0, y: 3 },
        { type: "cutter", x: 0, y: 2 }, { type: "belt", x: 0, y: 1 },
    ];
    const cap = capacityOf({ upgrades: {}, entities, oreCells: [] });
    assert.equal(cap.confidence, "low", "没有矿图 ⇒ 本来就不可信");
    assert.equal(cap.supplyPerSec, 0.4, "连得上就算（0.4），不许因缺矿图判 0");
});

/* ═══════════════════ B. 正例：产能平衡 ⇒ 不许硬报问题 ═══════════════════ */

test("B1 供给≈处理（15 台矿机 × 0.4 = 6/s vs 12 台 cutter × 0.5 = 6/s）⇒ 说「不是瓶颈」", () => {
    /* 造一个**平衡**的世界。几何要让 BFS 真能走通：矿机 y=10 → 带子 y=9 → 每个 cutter 的
       下方格 y=8 → 带子 y=7，再用 x=0 的一列把各条连接起来。 */
    const entities = [{ type: "hub", x: 0, y: 0 }];
    for (let i = 0; i < 15; i++) entities.push({ type: "miner", x: i, y: 10 });
    for (let i = 0; i < 15; i++) entities.push({ type: "belt", x: i, y: 9 });
    for (let i = 0; i < 16; i++) entities.push({ type: "belt", x: i, y: 8 });
    /* cutter 独占 (x,7) 与 (x+1,7)；用 y=7 的带子把它们的空隙连起来 —— 直接整行铺带子 */
    for (let i = 0; i < 12; i++) entities.push({ type: "cutter", x: i * 2, y: 7 });
    for (let i = 0; i < 24; i++) entities.push({ type: "belt", x: i, y: 7 });
    for (let y = 6; y >= 1; y--) entities.push({ type: "belt", x: 24, y });
    for (let x = 23; x >= 0; x--) entities.push({ type: "belt", x, y: 6 });
    const oreCells = [];
    for (let i = 0; i < 15; i++) oreCells.push({ x: i, y: 10, kind: "RuRuRuRu" });

    const cap = capacityOf({ upgrades: { belt: 0, miner: 0, processors: 0, painting: 0 }, entities, oreCells });
    assert.equal(cap.confidence, "ok");
    assert.equal(cap.supplyPerSec, 6, "15 × 0.4");
    assert.equal(cap.process.capacityPerSec, 6, "12 × 0.5 —— 这就是「平衡」");
    assert.equal(cap.bottleneck, "supply", "两边相等时判为 supply（没有东西堵）");
    assert.equal(cap.utilization, 1, "处理能力 = 供给 ⇒ 1.0");

    const text = renderCapacity(cap, null, {});
    assert.ok(text, "平衡时也要有一句话");
    assert.match(text, /balanced|no capacity bottleneck/, `不许硬报瓶颈：${text}`);
    assert.doesNotMatch(text, /stuck here/);
});

test("B2 平衡 + 有能立刻买的升级 ⇒ 仍然给可选项（白送的产能不能说没事）", () => {
    const cap = capacityOf({
        upgrades: { belt: 0, miner: 0, processors: 0, painting: 0 },
        entities: [{ type: "hub", x: 0, y: 0 },
            { type: "miner", x: 0, y: 4 }, { type: "belt", x: 0, y: 3 },
            { type: "cutter", x: 0, y: 2 }, { type: "belt", x: 0, y: 1 }],
        oreCells: [{ x: 0, y: 4, kind: "RuRuRuRu" }],
    });
    /* 供给 0.4、处理 0.5 ⇒ 矿是瓶颈；把"能买的升级"塞进 options */
    const options = { addMachines: { kind: "miner", from: 1, to: 2, add: 1, capacityAfter: 0.8, enough: true },
        upgrade: { line: "miner", tier: 1, multiplierFrom: 1, multiplierTo: 1.5, capacityAfter: 0.6, affordable: true, missing: [] },
        doNow: [{ action: "buy-upgrade", line: "miner", tier: 1, capacityAfter: 0.6 }] };
    const text = renderCapacity(cap, options, {});
    assert.ok(text);
    assert.match(text, /miner T1|add 1 miner/, "有可选项就要说出来");
});

test("B3 供给为 0（矿机全闲置）⇒ 不报「处理能力堵住」", () => {
    const cap = capacityOf({
        upgrades: {},
        entities: [{ type: "cutter", x: 0, y: 0 }, { type: "belt", x: 0, y: 1 }],
        oreCells: [],
    });
    /* 没有矿机 ⇒ BFS 没种子 ⇒ cutter 不在产线上 ⇒ process=null ⇒ 什么都不说 */
    assert.equal(cap.supplyPerSec, 0);
    assert.equal(renderCapacity(cap, null, {}), null);
});

/* ══════════ B4-B6：交付闸 —— 没货在流时不许谈吞吐 ══════════ */

/**
 * 这三条的由来（2026-11-20，L12 真机）：
 *
 *   ## CAPACITY
 *   supply 12.8/s | processing 0.25/s | 2% utilized
 *   bottleneck: stacker — 98% of supply is stuck here
 *   · add 51 stacker (1→52) ⇒ 13/s — fills the line
 *
 * 而同一轮 `produced_total` 与 `delivered_total` 都是 `{}`。**一件都没产出、
 * 一件都没交货。** 那段话的分子和分母都是虚构的，而它是整份 prompt 里
 * 最有说服力的一段（有数字、有对比、有可执行动作、还承诺 fills the line）。
 *
 * 模型照着它去铺 stacker —— 556 个 run 的 timeline 里 `stacker` 出现 199 次。
 */

const CAP_FOR_GATE = {
    confidence: "ok", supplyPerSec: 12.8,
    miners: { count: 16, active: 16, idle: 0, isolated: 6 },
    process: { capacityPerSec: 0.25, machines: [{ kind: "stacker", count: 1, productPerSec: 0.25, ratePerSec: 0.25 }] },
    bottleneck: "process", bottleneckMachine: "stacker", utilization: 0.02,
};

test("B4 零产出 + 零交付 ⇒ 不许报利用率/瓶颈，改说「产线根本没在跑」", () => {
    const seg = renderCapacity(CAP_FOR_GATE, { doNow: [{ action: "add-machines", kind: "stacker", from: 1, to: 52, add: 51 }] },
        { production: { produced_total: {}, delivered_total: {} } });
    assert.ok(seg, "仍然要有一段（沉默比说错更糟）");
    assert.match(seg, /no goods are moving/);
    assert.doesNotMatch(seg, /98% of supply/, "不许再说「98% 堵住」——那 98% 从未发生");
    assert.doesNotMatch(seg, /utilized/);
    assert.doesNotMatch(seg, /add 51 stacker/, "不许再建议加机器");
    assert.match(seg, /Do NOT add machines/, "必须明确劝阻加机器");
    assert.match(seg, /6 miner/, "要点名有几台矿机没有机器接住（可执行的线索）");
});

test("B5 有产出但零交付 ⇒ 指明堵在交付端，而不是处理端", () => {
    const seg = renderCapacity(CAP_FOR_GATE, null,
        { production: { produced_total: { CuCuCuCu: 40 }, delivered_total: {} } });
    assert.ok(seg);
    assert.match(seg, /ZERO reach the hub/);
    assert.match(seg, /DELIVERY end/);
    assert.doesNotMatch(seg, /add 51 stacker/, "加加工机器解决不了交付问题");
    assert.doesNotMatch(seg, /stuck here/);
});

test("B6 有产出且有交付 ⇒ 照常报吞吐（闸不能把正常工作也挡掉）", () => {
    const seg = renderCapacity(CAP_FOR_GATE, null,
        { production: { produced_total: { CuCuCuCu: 40 }, delivered_total: { CuCuCuCu: 12 } } });
    assert.ok(seg);
    assert.match(seg, /supply 12\.8\/s/, "正常状态仍要给出数字");
    assert.match(seg, /bottleneck: stacker/);
});

test("B7 没给 production（老调用方 / 离线测试）⇒ 闸不生效，行为与以前一致", () => {
    const seg = renderCapacity(CAP_FOR_GATE, null, {});
    assert.match(seg, /supply 12\.8\/s/);
    assert.match(seg, /bottleneck: stacker/);
});

/* ═══════════════════ C. 反例：优雅降级 ═══════════════════ */

test("C1 没有 resources（算不出谁压在矿上）⇒ confidence=low，且整段不出现", () => {
    const { capacity } = capacityFor(L5);
    assert.equal(capacity.confidence, "low", "没有矿图 ⇒ 供给数不可信");
    const p = promptFor(L5);
    assert.equal(p.blocks.s3_capacity, null, "不可信时宁可不出现");
    assert.equal(p.blocks.capacity_unavailable, "confidence=low", "但必须留痕，不许静默");
});

test("C2 没有 goal.upgrade_levels ⇒ 不崩，且仍能算（倍率按 0 档）", () => {
    const raw = { ...L4_LIVE, goal: { ...L4_LIVE.goal, upgrade_levels: undefined } };
    const { capacity } = capacityFor(raw);
    assert.equal(capacity.levels.miner, 0);
    assert.equal(capacity.supplyPerSec, 1.2, "3 × 0.4（miner 未升级）");
});

test("C3 完全没有 obs / obs 是垃圾 ⇒ capacityFor 不抛", () => {
    for (const junk of [null, undefined, {}, "x", 42, [], { entities: "no" }]) {
        assert.doesNotThrow(() => capacityFor(junk), `capacityFor(${JSON.stringify(junk)}) 不许抛`);
    }
});

test("C4 没有产线（空世界）⇒ 不渲染，且 buildPrompt 照常出 prompt", () => {
    const empty = {
        goal: { level: 1, requirement: { shape: "CuCuCuCu", required: 10, delivered: 0 }, upgrade_levels: {} },
        hub: { stored_shapes: {} }, entities: [], resources: [],
    };
    const p = promptFor(empty);
    assert.equal(p.blocks.s3_capacity, null);
    assert.ok(p.user.length > 0, "prompt 本身仍然要出来");
    assert.ok(p.blocks.s3_machines);
});

test("C5 `renderCapacity(null)` / 缺字段 ⇒ 返回 null，不抛", () => {
    for (const x of [null, undefined, {}, { confidence: "ok" }, { confidence: "ok", supplyPerSec: 1 }]) {
        assert.doesNotThrow(() => renderCapacity(x, null, {}));
    }
    assert.equal(renderCapacity(null, null, {}), null);
    assert.equal(renderCapacity({ confidence: "ok" }, null, {}), null, "没有 process 就不说");
});

test("C6 处理能力为 0 的退化形态（有 cutter 但速率算不出来）不许当除数炸掉", () => {
    const cap = {
        confidence: "ok", supplyPerSec: 1, bottleneck: "process", bottleneckMachine: "cutter",
        process: { capacityPerSec: 0, machines: [{ kind: "cutter", count: 1, productPerSec: 0, ratePerSec: 0 }] },
        utilization: 0,
    };
    assert.doesNotThrow(() => renderCapacity(cap, null, {}));
});

/* ═══════════════════ D. 预算：belts_shown 不许比现在更差 ═══════════════════ */

/**
 * D 的判据来自本包的任务书：「加了这一段后，默认预算下 `belts_shown` 不能比现在更差」。
 *
 * 「现在」= 同一份输入、**不含 CAPACITY** 的渲染。为了在测试里真的拿到它，这里构造一份
 * 「关掉 CAPACITY」的等价输入（`capacity` 数据不可信 ⇒ `renderCapacity` 返回 null ⇒
 * 插入段消失），然后断言两边 `belts_shown` 逐项相等。
 *
 * 这不是同义反复：它证明的是「插入 CAPACITY 这个动作本身不消耗带子名额」——
 * 而这正是「先定带子、再花余量」那个顺序在起作用的**唯一**可观测后果。
 * 如果哪天有人把顺序改回去（先按新预算截带子、再塞 CAPACITY），这一条会立刻红。
 */
test("D1 插入 CAPACITY 不减少 belts_shown（4 组预算 × 5 组诊断量）", () => {
    const mkDiags = n => [
        { code: "NO_PRODUCTION", layer: "L4", severity: "blocker", subject: { handle: "H1" }, expected: { delivered: 70 }, observed: { delivered: 0 }, evidence: { handles: ["B7", "B8"] }, candidates: ["replace_run"] },
        { code: "PROCESSOR_REQUIRED", layer: "L4", severity: "warn", subject: { handle: "C1" }, slot: { role: "left", index: 0 }, expected: { op: "cut" }, observed: {}, evidence: { handles: ["B69", "B70"] }, candidates: ["connect"] },
        { code: "DEAD_END", layer: "L1", severity: "warn", subject: { handle: "B34" }, expected: {}, observed: {}, evidence: { handles: ["B34", "B35"] }, candidates: ["connect"] },
        { code: "SLOT_STARVED", layer: "L2", severity: "warn", subject: { handle: "C1" }, expected: { fed: true }, observed: { fed: false }, evidence: { handles: ["B81", "B82"] }, candidates: ["connect"] },
        { code: "FLOW_UNVERIFIED", layer: "L3", severity: "warn", subject: { handle: "B12" }, expected: {}, observed: {}, evidence: { handles: ["B12"] }, candidates: ["replace_run"] },
    ].slice(0, n);

    /* 「不含 CAPACITY」的等价物：同样的 obs，但抹掉 resources ⇒ confidence=low ⇒ 渲染器返回 null。
       ⚠️ 这只在**有 resources 才置 ok** 的前提下成立，见 capacityOf 的注释。 */
    const withoutCapacity = { ...L4_LIVE, resources: [] };

    let cases = 0;
    for (const tok of [2800, 3000, 3400, 4000]) {
        for (const n of [0, 1, 3, 5]) {
            const over = {
                diagnoses: mkDiags(n),
                budget: { rounds_left: 2, llm_calls_left: 3, tx_left: 2, prompt_tokens_max: tok },
                production: { window_seconds: 60, produced_total: { RuRuRuRu: 120 }, delivered_per_sec: { "RuRu----": 0.05 } },
            };
            const withCap = buildPrompt({ goal: L4_LIVE.goal.requirement.shape, obs: L4_LIVE, handles: tableOf(L4_LIVE), candidates: ["replace_run", "connect", "trash_unused"], lastRound: null, ...over });
            const noCap = buildPrompt({ goal: L4_LIVE.goal.requirement.shape, obs: withoutCapacity, handles: tableOf(L4_LIVE), candidates: ["replace_run", "connect", "trash_unused"], lastRound: null, ...over });
            cases++;
            assert.equal(withCap.blocks.belts_shown, noCap.blocks.belts_shown,
                `tok=${tok} n=${n}: belts_shown ${noCap.blocks.belts_shown} → ${withCap.blocks.belts_shown}（不许变差）`);
            assert.equal(noCap.blocks.s3_capacity, null, "对照组确实没有 CAPACITY（否则这条测试是空的）");
        }
    }
    assert.ok(cases >= 16);
});

test("D2 默认预算下 L4 仍然 12 条带子全在（与加这段之前一致）", () => {
    const p = promptFor(L4_LIVE);
    assert.equal(p.blocks.belts_shown, PROMPT_RULES.STATE_BELTS_MAX, `实际 ${p.blocks.belts_shown}`);
    assert.equal(p.blocks.trimmed_belts, 0, "默认预算下一条都不该被砍");
});

test("D3 预算余量不够时先退短版，再退「不出现」，且两种情况都可观测", () => {
    const { capacity, options } = capacityFor(L4_LIVE);
    const full = renderCapacity(capacity, options, {});
    const short = renderCapacity(capacity, options, { form: "short" });
    assert.ok(full && short);
    assert.ok(short.length < full.length, `短版必须更短（${short.length} vs ${full.length}）`);
    assert.match(short, /^## CAPACITY/m);
    assert.match(short, /act: /, "短版要留一条可执行动作");
    /* 额度小于短版 ⇒ 明确返回 null（不返回被偷偷截断的半截） */
    assert.equal(renderCapacity(capacity, options, { form: "short", room: short.length - 1 }), null);
    /* 额度够短版 ⇒ 原样返回（而不是被再裁一刀） */
    assert.equal(renderCapacity(capacity, options, { form: "short", room: short.length }), short);
    /* 额度连短版都放不下 full ⇒ full 版返回 null（调用方据此退到 short） */
    assert.equal(renderCapacity(capacity, options, { form: "full", room: short.length }), null);
    assert.equal(renderCapacity(capacity, options, { form: "full", room: full.length }), full);
});

test("D4 CAPACITY 段本身很短（≤ 260 字符，full 版）", () => {
    const { capacity, options } = capacityFor(L4_LIVE);
    const full = renderCapacity(capacity, options, {});
    assert.ok(full.length <= 260, `full 版 ${full.length} 字符，超过 260 就该压`);
});

test("D5 预算紧到装不下时，prompt 仍然能出来（不抛 PROMPT_OVER_BUDGET）", () => {
    /* 12 条诊断 + 很紧的 token 预算：CAPACITY 应该让位，而不是把整轮顶爆。 */
    const diags = Array.from({ length: 12 }, (_, i) => ({
        code: "SHAEE_UNKNOWN", layer: "L0", severity: "info",
        subject: { handle: "H1" }, expected: {}, observed: {},
        evidence: { handles: [`B${i + 1}`] }, candidates: [],
    }));
    assert.doesNotThrow(() => buildPrompt({
        goal: L4_LIVE.goal.requirement.shape, obs: L4_LIVE, handles: tableOf(L4_LIVE),
        diagnoses: diags, candidates: ["replace_run", "connect", "trash_unused"],
        lastRound: null, budget: { rounds_left: 1, llm_calls_left: 1, tx_left: 1, prompt_tokens_max: 2900 },
    }));
});

/* ═══════════════════ E. 依赖与数值一致性 ═══════════════════ */

test("E1 没有循环依赖：assess.mjs / rules.mjs 都不 import prompt.mjs", () => {
    const assessSrc = fs.readFileSync(path.join(REPO, "src/agent/assess.mjs"), "utf8");
    const rulesSrc = fs.readFileSync(path.join(REPO, "src/agent/rules.mjs"), "utf8");
    for (const [name, src] of [["assess.mjs", assessSrc], ["rules.mjs", rulesSrc]]) {
        const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map(m => m[1]);
        assert.ok(!imports.some(i => /prompt/.test(i)), `${name} 不许 import prompt（实际：${imports.join(", ")}）`);
    }
});

test("E2 CAPACITY 的速率与 rules.mjs 的源码核证值一致（不是本文件另算一份）", () => {
    const { capacity } = capacityFor(L4_LIVE);
    const lv = capacity.levels;
    const minerMul = UPGRADE_MULTIPLIERS[lv.miner];
    const procMul = UPGRADE_MULTIPLIERS[lv.processors];
    assert.equal(capacity.miners.ratePerSec, +(RATES.minerPerSec * minerMul).toFixed(3));
    const cutter = capacity.process.machines.find(m => m.kind === "cutter");
    assert.equal(cutter.ratePerSec, +(RATES.machinePerSec.cutter * procMul).toFixed(3), "cutter 吃 processors 线");
});

test("E3 升级需求表与源码一致（含 carry-over —— 这是本包修掉的真实 bug）", () => {
    const r = verifyRules();
    assert.equal(r.ok, true, `与游戏源码不符：${JSON.stringify(r.mismatches)}`);
    /* 逐条钉住最容易漏的那一档：processors T2 **必须**带 SuSuSuSu×1200。
       旧表只有 RuRu----×600 ⇒ 会把「一个 Su 都没有」的存档判成买得起。 */
    const p2 = UPGRADES.processors.find(t => t.tier === 2);
    assert.deepEqual(
        p2.required.map(x => [x.shape, x.amount]),
        [["SuSuSuSu", 1200], ["RuRu----", 600]],
    );
});

test("E4 旧表会漏判的存档：只有 RuRu---- 够、没有 SuSuSuSu ⇒ processors T2 不许 affordable", () => {    /* 几何要让 cutter 在产线上，并且供给 > 处理（否则瓶颈在矿上，就没有「升级选项」可比）。
       4 台矿机 0.4 = 1.6/s 供给 vs 1 台 cutter 0.75/s（processors L1）⇒ 瓶颈是 cutter。 */
    const raw = {
        goal: {
            level: 4,
            requirement: { shape: "RuRu----", required: 70, delivered: 0 },
            upgrade_levels: { belt: 0, miner: 0, processors: 1, painting: 0 },
        },
        hub: { stored_shapes: { "RuRu----": 5000 } },
        entities: [
            { type: "miner", x: 0, y: 0 }, { type: "miner", x: 1, y: 0 },
            { type: "miner", x: 2, y: 0 }, { type: "miner", x: 3, y: 0 },
            { type: "belt", x: 0, y: 1 }, { type: "belt", x: 1, y: 1 },
            { type: "belt", x: 2, y: 1 }, { type: "belt", x: 3, y: 1 },
            { type: "cutter", x: 0, y: 2 }, { type: "belt", x: 0, y: 3 },
        ],
        resources: [
            [0, 0, "RuRuRuRu"], [1, 0, "RuRuRuRu"], [2, 0, "RuRuRuRu"], [3, 0, "RuRuRuRu"],
        ],
    };
    const { options, capacity } = capacityFor(raw);
    assert.equal(capacity.bottleneckMachine, "cutter", "1.6/s 供给 vs 0.75/s 处理");
    assert.ok(options, "应该能给出选项");
    assert.equal(options.upgrade.line, "processors", "cutter 吃的是 processors 线，不是 painting");
    /* processors 当前 L1 ⇒ 下一档是 T2 = SuSuSuSu×1200 + RuRu----×600（含 carry-over）。
       库存里只有 RuRu---- ⇒ 必须判成买不起，且缺口点名 SuSuSuSu。 */
    assert.equal(options.upgrade.tier, 2);
    assert.equal(options.upgrade.affordable, false, "SuSuSuSu 一个都没有 ⇒ 买不起");
    assert.ok(options.upgrade.missing.some(m => m.shape === "SuSuSuSu"),
        "缺口里必须点名 SuSuSuSu —— 旧表会把它漏掉");
});

/* ═══════════════════ F. 接线：loop 真的把 CAPACITY 送到 prompt 里 ═══════════════════ */

/**
 * F 为什么必须存在：`PRODUCTION` 段曾经判据正确、单测全绿，但在 loop 里**从没被喂到**
 * （`observeOnce()` 把 production 读成 `ob.production`，而 prompt 读 `obs.production`）——
 * 于是真实运行中每一轮都渲染 `unavailable`，两周没人发现。单模块测试自己造了个
 * 真实调用方不提供的形状，所以恒绿。
 *
 * CAPACITY 走的是 `buildPrompt({obs})`，而 `obs` 是 `observeOnce()` 的**第一个**字段，
 * 接线风险比 production 小 —— 但「小」不等于零：`obsForAssess()` 一旦改了字段名
 * （`resources` → `ore`、`upgrade_levels` → `upgrades`），产线数据就会静默变空，
 * 而 `confidence` 会如实降级为 `low`、整段消失，**看起来像"这段本来就不显示"**。
 * 这一条用真实 loop 跑一次，钉住「真的会出现」。
 */
test("F1 接线：runLoop 走一遍，模型收到的 prompt 里真有 CAPACITY 段", async () => {
    const { runLoop } = await import("../loop.mjs");
    const { default: FakeGame } = await import("../fake_game.mjs");
    const os = await import("node:os");
    const REPO_DIR = path.resolve(HERE, "../../..");
    const FIX = path.join(REPO_DIR, "test/fixtures/saves");
    const g = FakeGame.fromFiles(
        path.join(FIX, "L4-live-miner1-obs.json"),
        path.join(FIX, "L5-items.json"),
        { goal: "RuRu----" },
    );

    const seen = [];
    const llmClient = {
        async propose(bundle) {
            seen.push(bundle);
            return { text: JSON.stringify({ say: "nothing to do", calls: [] }), usage: null, raw: null };
        },
    };

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "capwire-"));
    try {
        await runLoop({
            reader: g.reader(), goal: "RuRu----", llmClient, mode: "mock", runDir, game: g,
            budget: { LLM_CALLS_MAX: 1, ROUNDS_MAX: 1 },
        });
    } finally {
        try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    assert.equal(seen.length, 1, "应当恰好问了一次 LLM");
    const seg = seen[0].blocks.s3_capacity;
    assert.ok(seg, `loop 必须把 CAPACITY 送到 prompt 里（unavailable=${seen[0].blocks.capacity_unavailable}）`);
    assert.match(seg, /## CAPACITY/);
    /* 这一条测的是**接线**，不是某一句措辞。
     *
     * 2026-11-20 起 CAPACITY 多了一道「先确认有货在流」的闸：夹具里
     * `produced_total` / `delivered_total` 都是空 ⇒ 渲染的是
     * 「no goods are moving at all …」，而不是 `bottleneck: cutter`。
     * 那不是接线的退化 —— 恰恰是**新判据在起作用**。
     *
     * 所以这里只钉「段出现了、而且真的来自这份 obs」，具体措辞由 A3/A6 负责。
     * 仍然要求它提到 cutter 或明确说产线没跑 —— 不许出现一段与这份世界无关的文字。 */
    assert.match(seg, /bottleneck: cutter|no goods are moving/, `实际：${JSON.stringify(seg)}`);
    assert.match(seen[0].user, /## CAPACITY/, "user 里也要有（不只是 blocks）");
    /* 与「另一个 bug」对照：矿机是 3 台、供给 1.8，这数字必须来自真实 obs，不是常量。
       走交付闸时这段数字不会渲染，所以只在非降级形态下要求。 */
    if (!/no goods are moving/.test(seg)) assert.match(seg, /supply 1\.8\/s/);
});
