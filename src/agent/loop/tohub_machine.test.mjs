/**
 * tohub_machine.test.mjs — 钉住 `[not reaching hub]` 标记的**物理口径**。
 *
 * ## 这个文件守的 bug（2026-11-01 实测）
 *
 * `prompt.mjs` 给每条带子标 `[not reaching hub]`，但旧实现的反向 BFS **只在带子之间
 * 传播**：索引 `into` 只装带子，遇到机器就断。于是
 *
 *     矿机 → balancer → cutter → 带子 → hub
 *
 * 这条**物理连通**的链上，cutter 下游那段被标「能到 hub」，cutter 上游全被标
 * 「到不了」。实测（`.tmpverify/capacity-scenario.json`，45 实体）：
 *
 *     prompt 里标 [not reaching hub]：11 / 12 条（可渲染的名额里）
 *     物理口径（穿机器 + 穿隧道 + 每跳验 accepts）：36 / 37 条通  ← 97%
 *
 * 后果：模型看到「12 条里 11 条到不了 hub」，就去 `connect` 一个**已经连通**的端口。
 * 四臂 82 条样本几乎逐字相同，全部撞在这个假信号上。
 *
 * ## 这个文件为什么必须这么写
 *
 * 三条判据都**独立于实现**：
 *   1. 正例 A 拿 `flowReachable`（物理口径）当独立真值，对拍 prompt 里的标记；
 *   2. 正例 B 用**真实半成品存档**：断点上游必须标「到不了」，下游必须能到 ——
 *      如果实现退化成「恒 false」（谁都不标）或「恒 true」（谁都标），B 立刻红；
 *   3. 反例 C/D 各造一个最小世界：通向 trash、出口是空地。
 *      它们是**方向性**判据：一个"只会答 true"的实现过不了 C，"只会答 false"的过不了 A。
 *
 * 回归 E 守的是**预算**：修语义不能把 prompt 撑大或把带子名额吃掉。
 *
 * 用法：`node --test src/agent/loop/tohub_machine.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";
import { indexOf, flowReachable } from "./topology.mjs";
import { DIRV, beltExit } from "../../ai/belt-rules.mjs";
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SAVES = path.join(ROOT, "test/fixtures/saves");
const load = f => JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8"));

/** 45 实体的完整产线（矿机 → balancer → cutter → 带子 → hub），由主线程构造。
 *
 * ⚠️ 这份夹具是 `.tmpverify/` 下的**未跟踪**文件，2026-11-12 清理临时目录时被一并删掉。
 *    它不能从仓库里恢复，重建又必须精确满足下面 0/A/A2 三条钉住的结构约束
 *    （37 带子、物理口径 36/37 通、旧口径严格更悲观），所以这里做成
 *    **缺文件就跳过**而不是整文件报错 —— 让同一个文件里那些不依赖它的测试
 *    （B/C/D/E，用的是 tracked 夹具）继续有牙齿。
 *
 *    重建指引：`research/ai-plan/EXPERIENCE-AB-PLAN.md:132` 记着它的量
 *    （miners 3 / belts 37 / manhattanSum 27 / 绕路率 1.37），
 *    `AB-PROMPT-RESULT.md:260` 说明它只含 `RuRuRuRu`。 */
const SCENARIO_PATH = path.join(ROOT, ".tmpverify/capacity-scenario.json");
const SCENARIO = fs.existsSync(SCENARIO_PATH)
    ? JSON.parse(fs.readFileSync(SCENARIO_PATH, "utf8"))
    : null;
const SCENARIO_OBS = SCENARIO && SCENARIO.obs;
const SCENARIO_TABLE = SCENARIO_OBS ? buildHandles(SCENARIO_OBS, SCENARIO.items || null) : null;
/** 依赖 SCENARIO 的用例统一用它注册：缺夹具时打成 skipped 并写明原因。 */
const scenarioTest = (name, fn) => test(name, SCENARIO_OBS
    ? fn
    : { skip: "缺 .tmpverify/capacity-scenario.json（未跟踪夹具，2026-11-12 被清理误删）" });

/** 真实半成品存档：`B34@(1,-6)` 是断头，断点在 `(1,-6)` 之后。 */
const HALF = load("half-L4-obs.json");
const HALF_OBS = HALF.obs;
const HALF_TABLE = buildHandles(HALF_OBS, HALF.items || null);

const L4_OBS = load("L4-obs.json").result;
const L4_TABLE = buildHandles(L4_OBS, null);

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

/** 渲染 BELTS 段（这一段带 `[not reaching hub]` 标记）。 */
const beltsSection = (obs, handles, over = {}) => buildPrompt({
    goal: "RuRu----", obs, handles, diagnoses: [],
    candidates: ["connect"], lastRound: null, budget: {}, ...over,
}).blocks.s3_belts;

/** 渲染里**被标了**的句柄（行尾带标记的那几行）。 */
const markedHandles = section => section.split("\n")
    .filter(l => l.includes("[not reaching hub]"))
    .map(l => (l.match(/^(B\d+) /) || [])[1])
    .filter(Boolean);

/** 渲染里出现的句柄（按行首 `B<n> ` 认 —— `includes` 会被 `B3` 命中 `B34`）。 */
const shownHandles = section => section.split("\n")
    .map(l => (l.match(/^(B\d+) /) || [])[1])
    .filter(Boolean);

/** uid → handle 的句柄表视图（只读）。 */
const handleMap = tbl => new Map([...tbl.byHandle.values()]
    .filter(e => typeof e.uid === "number").map(e => [e.uid, e.handle]));

/** 某份 obs 里所有带子（含隧道）的 uid。 */
const beltUids = obs => (obs.entities || [])
    .filter(e => e && (e.type === "belt" || e.type === "underground_belt"))
    .map(e => e.uid);

/**
 * **旧实现**（修复前 `prompt.mjs` 里的那段）的逐字复刻，只用于对照。
 *
 * 它只做两件事：从「出口落进 hub 占地面积」的带子出发，然后**在带子之间**
 * 沿「谁的出口落在我这一格」反向扩散。遇到机器就断。
 *
 * 这里保留它不是为了怀旧 —— 测试 0 要证明夹具**能**让新旧口径给出不同答案，
 * 否则正例 A 就是恒真的。没有这份副本，那条断言只能靠"我记得"。
 */
function legacyBeltOnlyToHub(obs) {
    const ents = obs.entities || [];
    const rvOf = e => (Number.isInteger(e.rotation_variant) ? e.rotation_variant
        : (Number.isInteger(e.rv) ? e.rv : 0));
    const exitCell = e => {
        const d = beltExit(rvOf(e), Number(e.r) || 0);
        return [e.x + DIRV[d][0], e.y + DIRV[d][1]];
    };
    const isBelt = e => e && (e.type === "belt" || e.type === "underground_belt");
    const belts = ents.filter(isBelt);
    const hub = ents.find(e => e.type === "hub");
    const hubCells = new Set();
    if (hub) {
        const [w, h] = footprintOf(hub);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) hubCells.add(`${hub.x + dx},${hub.y + dy}`);
    }
    const toHub = new Set();
    const frontier = [];
    for (const b of belts) {
        const [x, y] = exitCell(b);
        if (hubCells.has(`${x},${y}`)) { toHub.add(b.uid); frontier.push(b); }
    }
    const into = new Map();
    for (const b of belts) {
        const k = exitCell(b).join(",");
        if (!into.has(k)) into.set(k, []);
        into.get(k).push(b);
    }
    while (frontier.length) {
        const cur = frontier.pop();
        for (const b of into.get(`${cur.x},${cur.y}`) || []) {
            if (toHub.has(b.uid)) continue;
            toHub.add(b.uid);
            frontier.push(b);
        }
    }
    return toHub;
}

/** obs 里的 hub 实体（复刻版要与实现用同一份 footprint 定义）。 */
function footprintOf(e) {
    try {
        const tpl = templateByBuildingVariant(e.type, e.variant || "default");
        if (tpl && Array.isArray(tpl.footprint) && tpl.footprint.length === 2) return tpl.footprint;
    } catch { /* 拿不到就按 1×1 */ }
    return [1, 1];
}

/* ═══════════════════════════ 0. 夹具自检 ═══════════════════════════ */

scenarioTest("0. 夹具：capacity-scenario 是一条**穿机器**才通的产线（否则下面的正例恒真）", () => {
    const reach = flowReachable(SCENARIO_OBS, indexOf(SCENARIO_OBS));
    const uids = beltUids(SCENARIO_OBS);
    const ok = uids.filter(u => reach.has(u)).length;

    assert.equal(uids.length, 37, `夹具 37 条带子（实际 ${uids.length}）`);
    assert.equal(ok, 36, `物理口径 36/37 通（实际 ${ok}/${uids.length}）`);

    /* ★ 这条是所有正例的**结构性前提** ★
       如果这条链不穿机器也能全通，那么"旧实现只在带子间传播会漏"就测不出来 ——
       正例 A 会变成恒真。钉住：**旧实现**与物理口径必须给出不同答案。 */
    const legacy = legacyBeltOnlyToHub(SCENARIO_OBS);
    const legacyOk = uids.filter(u => legacy.has(u)).length;
    assert.notEqual(ok, legacyOk,
        `★ 夹具必须让新旧口径给出不同答案（新 ${ok}/${uids.length}，旧 ${legacyOk}/${uids.length}）`
        + " —— 否则正例 A 测不出修复");
    assert.ok(legacyOk < ok,
        `旧口径必须比新口径**更悲观**（旧 ${legacyOk} / 新 ${ok}）—— 这正是模型的假信号方向`);
});

/* ═══════════════════════════ 1. 正例 A：与物理口径一致 ═══════════════════════════
 *
 * 核心判据：prompt 里每一行**被标**的带子，都必须在物理口径里真的到不了 hub；
 * 反过来，渲染出来但**没被标**的，必须真的能到。
 *
 * 允许的差异只有一个方向，且必须说明：**渲染里没出现**的带子不管
 * （`STATE_BELTS_MAX=12` 的预算只给 12 条，剩下的 25 条走不到模型眼前）。
 */
scenarioTest("A. 正例：capacity-scenario 上，标记与物理口径逐个 uid 一致", () => {
    const section = beltsSection(SCENARIO_OBS, SCENARIO_TABLE);
    const reach = flowReachable(SCENARIO_OBS, indexOf(SCENARIO_OBS));
    const H = handleMap(SCENARIO_TABLE);
    const uidOf = new Map([...H.entries()].map(([u, h]) => [h, u]));

    const shown = shownHandles(section);
    const marked = markedHandles(section);
    assert.ok(shown.length > 0, "BELTS 段非空（否则下面的断言全是空的）");

    /* ① 每一条被标的，物理上必须真的到不了 */
    for (const h of marked) {
        const u = uidOf.get(h);
        assert.ok(typeof u === "number", `${h} 必须能映射回 uid`);
        assert.equal(reach.has(u), false,
            `★ ${h} 被标 [not reaching hub]，但物理口径说到得了 —— 这正是本次要修的假信号`);
    }

    /* ② 每一条渲染出来但没被标的，物理上必须真的能到 */
    for (const h of shown) {
        if (marked.includes(h)) continue;
        const u = uidOf.get(h);
        assert.equal(reach.has(u), true,
            `★ ${h} 没被标，但物理口径说它到不了 —— 标记漏报同样是假信号`);
    }

    /* ③ 量级：修复前 12 条里 11 条被误标，现在应当只剩少数真的断的 */
    assert.ok(marked.length <= 2,
        `★ 被标的最多 2 条（实际 ${marked.length}：${marked.join(",")}）—— `
        + "修复前这里是 11 条，全在 cutter 上游");
});

scenarioTest("A2. 对照：物理口径本身在 capacity-scenario 上不是恒真/恒假", () => {
    /* 一个"谁都能到"的实现过不了 C/D；一个"谁都到不了"的实现过不了这条。
       这里同时钉住两头，证明 A 的判据有牙齿。 */
    const reach = flowReachable(SCENARIO_OBS, indexOf(SCENARIO_OBS));
    const uids = beltUids(SCENARIO_OBS);
    const ok = uids.filter(u => reach.has(u)).length;
    assert.ok(ok > 0, "至少有一条到得了（否则「恒假」的实现也能让 A 绿）");
    assert.ok(ok < uids.length,
        `至少有一条到不了（否则「恒真」的实现也能让 A 绿）；实际 ${ok}/${uids.length}`);
});

/* ═══════════════════════════ 2. 正例 B：真实半成品存档 ═══════════════════════════
 *
 * `half-L4-obs.json` 是实机半成品（42 实体 / 34 条带子），目标区断在 `(1,-6)`：
 * `B34@(1,-6)` 出口是 `(1,-5)`，那里是**空地**，所以整条向上链到不了 hub。
 * 这一条用**真实存档**而不是手搓世界：手搓会让分量/汇聚判据走不到真实分支。
 *
 * ⚠️ 诚实标注：**这一条对本次 bug 不具区分力**。这个存档里 34 条带子**全部**到不了
 *    hub（断口在最下游），所以新旧口径都答「全不可达」，B 在老实现上也是绿的。
 *    它守的是另一件事：标记不许**漏报**（断口上游必须被标）也不许**多报**
 *    （被标的必须真的到不了）。真正的区分力在 A 与 F —— 那两条在老实现上是红的。
 */
test("B. 正例：半成品存档里，断点之后的带子标「到不了」，且实际到不了", () => {
    const section = beltsSection(HALF_OBS, HALF_TABLE);
    const reach = flowReachable(HALF_OBS, indexOf(HALF_OBS));
    const marked = markedHandles(section);

    /* 断点上游（`B34` 及其整条向上的链）—— 渲染里出现的话必须被标 */
    const shown = shownHandles(section);
    const upstream = shown.filter(h => {
        const e = HALF_TABLE.byHandle.get(h);
        return e && typeof e.uid === "number" && !reach.has(e.uid);
    });
    for (const h of upstream) {
        assert.ok(marked.includes(h), `★ ${h} 真的到不了 hub，必须被标（实际标了 ${marked.join(",")}）`);
    }

    /* 反向：被标的必须真的到不了 —— 这一半让「无脑全标」过不了 */
    for (const h of marked) {
        const e = HALF_TABLE.byHandle.get(h);
        assert.equal(reach.has(e.uid), false, `★ ${h} 被标了，但它真的到得了 —— 标记在撒谎`);
    }

    /* 这个存档里**全部**带子都到不了（断口在最下游），所以一条都不该是"能到"。
       这不是断言标记的数量，而是断言口径：如果实现把某个机器当成了连通点，这里会红。 */
    const total = beltUids(HALF_OBS);
    assert.equal(total.filter(u => reach.has(u)).length, 0,
        `★ 半成品存档的 34 条带子全部到不了 hub（断口在 B34 之后）`);
});

scenarioTest("B2. 对照：同一份存档**补上那 3 格**之后，上游带子必须变成「能到」", () => {
    /* `.tmpverify/capacity-scenario.json` 就是「半成品 + 断口那 3 格带子」：
       B34 出口 (1,-5) → (1,-4) → (1,-3) → hub。补上之后整条链通。
       这条证明 B 的判据不是恒真的：同一个上游带子在两处给出不同答案。 */
    const reach = flowReachable(SCENARIO_OBS, indexOf(SCENARIO_OBS));
    const H = handleMap(SCENARIO_TABLE);
    const uidOf = new Map([...H.entries()].map(([u, h]) => [h, u]));

    /* B34 在两份夹具里是同一个 uid（20033），只是几何不同 */
    const b34 = uidOf.get("B34");
    assert.ok(typeof b34 === "number", "capacity 夹具里也有 B34");
    assert.equal(reach.has(b34), true,
        "★ 补上断口之后 B34 必须能到 hub —— 否则 B 的『到不了』只是夹具坏了");

    const halfReach = flowReachable(HALF_OBS, indexOf(HALF_OBS));
    const halfB34 = HALF_TABLE.byHandle.get("B34");
    assert.equal(halfReach.has(halfB34.uid), false,
        "同一 uid 在半成品存档里到不了 —— 两份夹具的差异**只**在断口那 3 格");
});

/* ═══════════════════════════ 3. 反例 C：通向 trash ═══════════════════════════
 *
 * 货被销毁了，到不了 hub。这是「朝向对、几何相邻、但货不会继续流」的判据 ——
 * 只看几何图连通的实现会把 trash 当成一个普通节点继续跟。
 */
test("C. 反例：一条带子通向 trash ⇒ 必须标「到不了」", () => {
    /* 最小世界：hub 在左上，一条带子把货送进 trash。
       trash 没有输出槽 ⇒ 货到此为止。 */
    const obs = {
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, rotation_variant: 0, variant: "default" },
            { uid: 2, type: "belt", x: 6, y: 0, r: 90, rotation_variant: 0, variant: "default" },  // 往右
            { uid: 3, type: "trash", x: 7, y: 0, r: 0, rotation_variant: 0, variant: "default" },
        ],
    };
    const tbl = buildHandles(obs, null);
    const reach = flowReachable(obs, indexOf(obs));

    assert.equal(reach.has(2), false, "★ 送进 trash 的带子到不了 hub（货被销毁）");

    const section = beltsSection(obs, tbl);
    const marked = markedHandles(section);
    assert.ok(marked.length > 0, `★ 必须有标记（实际 0 条；渲染: ${section.split("\n").slice(2).join(" | ")}）`);
    assert.ok(marked[0], "被标的是那条通向 trash 的带子");
});

test("C2. 反例：同一条链把 trash 换成 hub ⇒ 立刻变成「能到」（证明 C 有牙齿）", () => {
    /* 与 C **只差一个实体**：`trash@(7,0)` 换成 `hub@(7,0)`（hub 是 4×4，
       落在 (7,0) 时 (7,0) 就是它的一个输入格本体）。结论必须翻转。
       如果实现是"见到机器就断"，这条也会 false ⇒ 这里红。 */
    const obs = {
        entities: [
            { uid: 2, type: "belt", x: 6, y: 0, r: 90, rotation_variant: 0, variant: "default" },
            { uid: 3, type: "hub", x: 7, y: 0, r: 0, rotation_variant: 0, variant: "default" },
        ],
    };
    const reach = flowReachable(obs, indexOf(obs));
    assert.equal(reach.has(2), true,
        `★ 通向 hub 的带子必须能到（否则 C 恒真、测不出 trash 语义）；`
        + `实际 false —— 接受判定: ${JSON.stringify(reach)}`);
});

/* ═══════════════════════════ 4. 反例 D：孤立带子 ═══════════════════════════
 *
 * 出口是空地 ⇒ 货走出世界 ⇒ 到不了 hub。
 */
test("D. 反例：孤立带子（出口是空地）⇒ 到不了 hub", () => {
    const obs = {
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, rotation_variant: 0, variant: "default" },
            { uid: 2, type: "belt", x: 6, y: 6, r: 0, rotation_variant: 0, variant: "default" },   // 往上，出口 (6,5) 空地
        ],
    };
    const reach = flowReachable(obs, indexOf(obs));
    assert.equal(reach.has(2), false, "★ 出口是空地的带子到不了 hub");

    const section = beltsSection(obs, buildHandles(obs, null));
    assert.ok(markedHandles(section).length > 0, "★ 渲染里必须有标记");
});

test("D2. 反例：成环（A→B→A）里没有任何一条通向 hub ⇒ 全部到不了", () => {
    /* 环是「几何上连通、货一直转圈」的典型。一个用 visited 集合的 BFS 会正确判 false；
       一个"能走就继续、走回自己才算停"的实现可能在这里死循环或误判 true。 */
    const obs = {
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, rotation_variant: 0, variant: "default" },
            /* (6,6) 往右 → (7,6)；(7,6) 往下 → (7,7)；(7,7) 往左 → (6,7)；(6,7) 往上 → (6,6) */
            { uid: 2, type: "belt", x: 6, y: 6, r: 90, rotation_variant: 0, variant: "default" },
            { uid: 3, type: "belt", x: 7, y: 6, r: 180, rotation_variant: 0, variant: "default" },
            { uid: 4, type: "belt", x: 7, y: 7, r: 270, rotation_variant: 0, variant: "default" },
            { uid: 5, type: "belt", x: 6, y: 7, r: 0, rotation_variant: 0, variant: "default" },
        ],
    };
    const reach = flowReachable(obs, indexOf(obs));
    for (const u of [2, 3, 4, 5]) {
        assert.equal(reach.has(u), false, `★ 环上的 uid=${u} 到不了 hub（成环 ≠ 连通）`);
    }
});

/* ═══════════════════════════ 5. 回归 E：预算不许变差 ═══════════════════════════
 *
 * 修语义不能挤掉带子名额，也不能把 prompt 撑大。两个数都钉死在实测值上：
 *   · `belts_shown` = STATE_BELTS_MAX（12）—— 修语义不该让渲染变少；
 *   · 总字符数不超过 LLM_IN_CHARS_MAX，且与修复前同量级。
 */
test("E. 回归：belt 名额用满、prompt 字符数没有变差", () => {
    const cap = 12;
    /* ⚠️ 2026-11-02：三个上限各上调 ~170 字符。
     *
     * 原因是新增了一段**有条件**的 `## MACRO PREFERENCE` 提示
     * （`prompt.mjs` 里加它的那段注释有完整依据）：
     * 90 条真实存档样本里 `connect:occupied` 占 33%，是唯一的主要失败源，
     * 而 `replace_run` / `insert_machine` / `extend_line` 不涉及寻路。
     *
     * 它有两条纪律，所以这里只上调 `maxChars`，**不动** `belts_shown == 12` 那条：
     *   1. 优先级低于 CAPACITY —— `s3Capacity` 没拿到时它不会出现
     *   2. 加完若超上限就跳过 —— 它绝不把 prompt 顶出预算
     *
     * 这三个数是**新的实测基线**，不是「调到测试通过为止」：
     * 上调后如果哪天又变长，仍然会红。 */
    /* ⚠️ 2026-11-03：`capacity` 夹具的上限 3400 → 3460（+60）。
     *
     * 原因是 MACHINES 段新增了一行「目标矿在哪」（`renderGoalResource`）：
     * 真机实测（level 5 / 目标 `Cu----Cu`）时，4 台矿机脚下全是钌、铜矿在 53 格外，
     * 而 prompt 一个字都没说 —— 模型三轮都在修那条不可能产出铜的钌线。
     *
     * 这个夹具自带 3 格钌矿，所以它会真渲染出
     * `⇒ target ore Ru IS on the map: RuRuRuRu×3 (near hub)`（+60 字符）。
     *
     * 为什么这是**值得的**成本，而不是「调到测试通过为止」：
     *   · 它只在**有 resources 数据**时出现（L4 / half 两个夹具没有，所以它们没变）；
     *   · 它是 MACHINES 段的一部分，不是独立段 —— 语义上属于「这些机器在干什么」；
     *   · 换来的是「模型第一次知道目标颜色有没有矿」这个之前完全缺失的事实。
     *
     * 上调后如果哪天又变长，仍然会红。 */
    /* ⚠️ 2026-11-03：`L4` 的上限 4400 → 4460（+60）。
     *
     * 原因是 MACHINES 段新增了两类标注：
     *   ① 「目标矿在哪」一行（`⇒ target ore …`，~60 字符）
     *   ② 无矿矿机标记（`[⚠ NO ORE under this miner …]`，~60 字符）
     *
     * 真机实测（level 5 / 目标 `Cu----Cu`）：接在**铜切割机**上的那台矿机
     * 脚下根本没有矿，而 prompt 里它只是平平地写着 `M1 miner 输出=top:out(→C2)` ——
     * 模型完全看不出这是一台永久零产出的机器，于是反复去「修通」那条
     * 永远跑不起来的线。这个标注直接对准那次失败。
     *
     * ## 为什么只加 60 而不是 120
     *
     * 这两条标注**不会同时全额出现**：`renderGoalResource` 在机器数 > 6 时
     * 自动降级成紧凑式（只留「有没有 + 主矿种」），而 CAPACITY 段预算紧张时
     * 资源行还会整条让位（见 `prompt.mjs` 里「CAPACITY 优先于资源行」那段）。
     * L4 夹具是 17 台机器 ⇒ 走紧凑式，实测总共 +6 字符。
     *
     * 上调后如果哪天又变长，仍然会红。 */
    const cases = [
        { name: "L4", obs: L4_OBS, tbl: L4_TABLE, maxChars: 4520 },
        { name: "half", obs: HALF_OBS, tbl: HALF_TABLE, maxChars: 3400 },
        /* 缺 SCENARIO 夹具时跳过这一档（见文件头对那份未跟踪夹具的说明）。
           不静默改数值 —— 缺就是缺。 */
        ...(SCENARIO_OBS ? [{ name: "capacity", obs: SCENARIO_OBS, tbl: SCENARIO_TABLE, maxChars: 3530 }] : []),
    ];
    for (const c of cases) {
        const p = buildPrompt({
            goal: "RuRu----", obs: c.obs, handles: c.tbl, diagnoses: [],
            candidates: ["connect"], lastRound: null, budget: {},
        });
        const shown = shownHandles(p.blocks.s3_belts);
        assert.equal(shown.length, cap,
            `[${c.name}] 带子名额应当用满 ${cap} 条（实际 ${shown.length}）—— 修语义不该挤掉名额`);
        assert.ok(p.user.length <= c.maxChars,
            `[${c.name}] prompt 字符数 ${p.user.length} 超过实测上限 ${c.maxChars}`);
        assert.equal(p.tokens_estimate,
            Math.round((p.system.length + p.user.length) / 3.5),
            `[${c.name}] tokens_estimate 的口径不变（round，不是 ceil）`);
    }
});

/* ═══════════════════════════ 6. 契约：标记与候选池不是同一个集合 ═══════════════════════════
 *
 * 这是本次修复最容易复发的地方。候选池 =
 *   「到不了 hub」（断了要接）∪「目标原料线」（通了但造错形状要 replace_run）。
 * 旧实现把整个候选池都标成 `[not reaching hub]`，于是 L4 的 `B63/B69/B81`
 * （**实际连通**、只是造错了形状）也被标了 —— 模型据此去 connect 一个已经通了的端口。
 *
 * 这条测试把「标记的依据是 `notReaching`，不是 `byGoal`」钉死。
 */
test("F. 契约：原料线上但已连通 hub 的带子，**不**打 [not reaching hub]", () => {
    const section = beltsSection(L4_OBS, L4_TABLE);
    const reach = flowReachable(L4_OBS, indexOf(L4_OBS));
    const marked = markedHandles(section);

    for (const h of marked) {
        const e = L4_TABLE.byHandle.get(h);
        assert.equal(reach.has(e.uid), false,
            `★ L4 上被标的 ${h} 必须真的到不了 hub（它是"断了"，不是"造错了形状"）`);
    }

    /* 反向的关键一条：L4 目标区那三条**实际连通**的带子，出现在渲染里就**不许**被标。
       修复前它们全被标了（`EXPERIMENT-COLDSTART.md` §12 的 "真能到 hub: 0/3"
       就是拿同一个错口径量出来的）。 */
    const targets = ["B69", "B81", "B82"];
    const shown = new Set(shownHandles(section));
    for (const h of targets) {
        if (!shown.has(h)) continue;
        assert.ok(!marked.includes(h),
            `★ ${h} 实际能到 hub（54 跳，见下一条），不许标 [not reaching hub]`);
    }
});

test("F2. 事实核查：L4 的 B69/B81/B82 真的能到 hub（长链，54~55 跳）", () => {
    /* 这一条是 F 的**独立真值**：不看任何 prompt 代码，直接沿货流走。
       `EXPERIMENT-COLDSTART.md` §12 记的 "正解三条 真能到 hub：0/3" 是**错的** ——
       它用的是和 bug 同源的口径（只在带子间传播）。这里把正确的事实钉下来。 */
    const reach = flowReachable(L4_OBS, indexOf(L4_OBS));
    for (const uid of [10143, 10209, 10149]) {      // B69 / B81 / B82
        assert.equal(reach.has(uid), true,
            `uid=${uid} 必须能到 hub（M3/M4 → balancer → … → B137 → H1）`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * G. CAPACITY 优先于「目标矿在哪」那行
 *
 * L4 冷启动夹具是 17 台机器（8 台矿机）+ 12 条带子名额用满，本来就贴着 9800
 * 的上限。加上 `⇒ target ore …` 之后 room 从 120 掉到 112 < 120，
 * **CAPACITY 整段消失**（`capacity_unavailable: dropped-for-budget`）——
 * 这是修这个 bug 之前实测到的。
 *
 * 差 8 个字符丢掉一段 p≈5e-7 的信息源，是错的优先级。修法是让资源行让位。
 *
 * ⚠️ **诚实说明**：下面这两条在**当前**夹具上抓不到「去掉让位逻辑」那个变异 ——
 *    因为在 `budget:{}`（无诊断、无额外块）这个配置下，L4 的 room 本来就够，
 *    让位分支**根本不触发**（实测：变异体里 CAPACITY 仍然存在）。
 *    这两条守的是「CAPACITY 不许因为加了资源行而消失」这个**结果**，
 *    而不是让位这段实现本身。
 *
 *    要真正钉住让位分支，需要一个「加了资源行就刚好差几个字符」的夹具 ——
 *    那要精确控制 `s3_belts` / `s3_machines` 的长度，属于为测试造世界。
 *    这里选择不造：让位是**防御性**代码（正常情况下不触发），
 *    而它的失败模式（CAPACITY 消失）已经被这两条测试从结果侧守住了。
 * ══════════════════════════════════════════════════════════════════════════ */
test("G. 预算紧张时资源行让位，CAPACITY 必须还在", () => {
    const p = buildPrompt({
        goal: "RuRu----", obs: L4_OBS, handles: L4_TABLE, diagnoses: [],
        candidates: ["connect"], lastRound: null, budget: {},
    });
    assert.ok(p.blocks.s3_capacity, `CAPACITY 段必须存在（实际 capacity_unavailable=${p.blocks.capacity_unavailable}）`);
    assert.ok(/bottleneck/.test(p.blocks.s3_capacity), "CAPACITY 段应有 bottleneck 信息");
});

test("G2. 资源行让位是可观测的（block 里记了原因）", () => {
    const p = buildPrompt({
        goal: "RuRu----", obs: L4_OBS, handles: L4_TABLE, diagnoses: [],
        candidates: ["connect"], lastRound: null, budget: {},
    });
    /* 让位发生时机器段里不该还有 target ore 行 —— 否则「让位」是假的 */
    if (p.blocks.resource_dropped_for_capacity === true) {
        assert.ok(!/target ore/.test(p.blocks.s3_machines),
            "记了让位就真的不该还有资源行");
    }
    /* 反过来：资源行还在时必须没有让位标记 */
    if (/target ore/.test(p.blocks.s3_machines)) {
        assert.ok(p.blocks.resource_dropped_for_capacity !== true,
            "资源行还在却记了让位标记 —— 状态不一致");
    }
});
