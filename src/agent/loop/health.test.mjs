/**
 * health.test.mjs — `loop/health.mjs` 的回归。
 *
 * 这个文件测的不是「函数能跑」，而是**四类判定的边界各判对** —— 因为这几档判定
 * 直接决定 prompt 里给模型看「你上一步是好是坏」，判错会让模型学错东西。
 *
 * 钉死的事实（每条都对应一次实测）：
 *   · 删一条**死**带子 = cleanup（改善），不是 constructive，也不是 inert；
 *   · 删一条**活**带子 = regressive（到 hub 的少了）；
 *   · 加孤立带子 = regressive（死带子变多）；
 *   · 只改朝向 = churn（形态变了但指标没动）—— 这一条只能靠 shape 指纹才分得出来；
 *   · 完全没动 = inert；
 *   · 读不到的字段必须是 null，**不许变成 0**（0 与 null 在 diff 里结论不同）。
 *
 * 运行：`node --test src/agent/loop/health.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    worldHealth, healthDelta, classifyNetEffect, shapeHash,
    formatHealth, formatDelta, formatNetEffect, NET_EFFECT_LABEL,
} from "./health.mjs";
import { indexOf, flowReachable } from "./topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const load = f => JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8")).result;

const L5 = load("L5-obs.json");
const L5_ITEMS = load("L5-items.json");
const clone = o => JSON.parse(JSON.stringify(o));

const base = () => worldHealth({ obs: L5, items: L5_ITEMS });
const withObs = o => worldHealth({ obs: o, items: L5_ITEMS });
const judge = (after) => {
    const b = base();
    const d = healthDelta(b, after);
    return { d, e: classifyNetEffect(b, after, d) };
};

/** 找一条到不了 hub 的带子 / 一条能到的。 */
const reachSet = flowReachable(L5, indexOf(L5));
const DEAD_BELT = L5.entities.find(e => e.type === "belt" && !reachSet.has(e.uid));
const LIVE_BELT = L5.entities.find(e => e.type === "belt" && reachSet.has(e.uid));

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 快照本身
 * ══════════════════════════════════════════════════════════════════════════ */

test("H1 快照：L5 的规模与连通性算得出来", () => {
    const h = base();
    assert.equal(h.level, 5);
    assert.equal(h.goal_shape, "Cu----Cu");
    assert.equal(h.entities, L5.entities.length);
    assert.equal(h.belts, 160);          // 158 belt + 2 underground_belt
    assert.equal(typeof h.belts_reaching_hub, "number");
    assert.equal(h.belts_dead, h.belts - h.belts_reaching_hub);
    assert.ok(h.belts_dead > 0, "L5 确实有到不了 hub 的带子（这就是度量存在的理由）");
});

test("H2 快照：死带子按源头分解，能看出病在哪", () => {
    const h = base();
    assert.ok(h.dead_by_source, "dead_by_source 必须算出来");
    const total = Object.values(h.dead_by_source).reduce((a, b) => a + b, 0);
    assert.equal(total, h.belts_dead, "分解之和必须等于死带子总数");
    assert.ok(h.dead_by_source.miner > 0, "L5 有一批矿机连着死路");
});

test("H3 快照：读不到的量是 null，不是 0", () => {
    /* 只给 obs、不给 items/production：带上货与产量都必须 null。
       把它们写成 0 会让「没读到」与「真的是 0」在 diff 里长得一样 —— 那是假绿。 */
    const h = worldHealth({ obs: L5 });
    assert.equal(h.items_on_belts, null);
    assert.equal(h.produced, null);
    assert.equal(h.produced_goal, null);
});

test("H4 快照：带上货 = 各 path 的 itemsOnPath 之和", () => {
    const h = base();
    const want = L5_ITEMS.paths.reduce((a, p) => a + (Number.isInteger(p.itemsOnPath) ? p.itemsOnPath : 0), 0);
    assert.equal(h.items_on_belts, want);
    assert.ok(h.items_on_belts > 0, "L5 的线上确实有货");
});

test("H5 快照：空世界不崩，且可达性是 0 而不是 null", () => {
    const h = worldHealth({ obs: { entities: [] }, items: null });
    assert.equal(h.entities, 0);
    assert.equal(h.belts, 0);
    assert.equal(h.reach_pct, null, "0 条带子时比率无意义 ⇒ null，不是 0");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. shapeHash —— churn 与 inert 的分界线
 * ══════════════════════════════════════════════════════════════════════════ */

test("H6 shapeHash：几何变 ⇒ 变；同内容 ⇒ 同", () => {
    const a = shapeHash(L5);
    const b = shapeHash(clone(L5));
    assert.equal(a, b, "同一份 obs 两次哈希必须相同");

    const moved = clone(L5);
    moved.entities[0].x += 1;
    assert.notEqual(shapeHash(moved), a, "挪一格必须改变哈希");
});

test("H7 shapeHash：**只改朝向**也要变（否则 churn 会被误判成 inert）", () => {
    const a = shapeHash(L5);
    const rotated = clone(L5);
    const b = rotated.entities.find(e => e.type === "belt");
    b.r = (b.r + 90) % 360;
    assert.notEqual(shapeHash(rotated), a);
});

test("H8 shapeHash：不改 uid 集合、只改 rotation_variant 也要变", () => {
    const a = shapeHash(L5);
    const t = clone(L5);
    const b = t.entities.find(e => e.type === "belt");
    b.rotation_variant = (b.rotation_variant + 1) % 3;
    assert.notEqual(shapeHash(t), a);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 六档判定
 * ══════════════════════════════════════════════════════════════════════════ */

test("H9 删一条死带子 = cleanup（改善，不是「什么都没干成」）", () => {
    assert.ok(DEAD_BELT, "夹具里必须有死带子");
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "cleanup", `判定=${e.kind} why=${e.why.join("/")}`);
});

/* ★ H10 的语义在 2026-11-15 夜改过（L12 真机）★
 *
 * 原来断言「删一条活带子 = regressive」。那个断言在 L5 上成立是因为
 * reach 从 133→132 —— 但**只掉了 1 条**。
 *
 * 而真机实测：`remove_run` 在记忆里被记成 regressive **57 次**，
 * 理由全是「到 hub 的带子 154→153」这种掉一条。那个世界有 544 条带子、
 * 384 条是死的（70%）—— 每删一批，误伤一条活线的概率都很高。
 * 把这种误伤判成「你把世界改坏了」，等于告诉 agent **永远别删东西**，
 * 而它必须删（世界被自己的旧线塞满了）。
 *
 * 新语义：占比 ≥2% **或** 绝对下降 ≥2 条才算退化。
 * 误伤一条（0.6%）放过；拆掉主干（实测那次 160→64）照旧判红。
 *
 * `LIVE_BELT` 是随便找的一条能到 hub 的带子 —— 它的下游不会跟着塌
 * （`belts_dead` 27→27，没变），所以它不是主干，掉 1 条确实不该判红。 */
test("H10 删一条末端活带子 = 不算改坏（误伤一条不该叫「把世界改坏了」）", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== LIVE_BELT.uid);
    const { e } = judge(withObs(o));
    assert.notEqual(e.kind, "regressive",
        `掉 1/133 = 0.75%，低于容差，不该判 regressive（why=${e.why.join("/")}）`);
});

test("H10b ★ 对照：拆掉主干（reach 掉 ≥2%）照旧判 regressive", () => {
    const o = clone(L5);
    const reach0 = flowReachable(L5, indexOf(L5));
    const live = L5.entities.filter(e => e.type === "belt" && reach0.has(e.uid));
    /* 删掉 5 条活带子（133 里 5 条 ≈ 3.8%，超过 2% 容差） */
    const kill = new Set(live.slice(0, 5).map(e => e.uid));
    o.entities = o.entities.filter(e => !kill.has(e.uid));
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "regressive",
        `拆掉 5/133 ≈ 3.8% 的主干必须判红（why=${e.why.join("/")}）`);
});

test("H11 加 3 条孤立带子 = regressive（死带子变多）", () => {
    const o = clone(L5);
    let uid = 900001;
    for (let i = 0; i < 3; i++) {
        o.entities.push({ uid: uid++, type: "belt", x: 50 + i, y: 50, r: 0, rotation_variant: 0, code: 1 });
    }
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "regressive", `判定=${e.kind} why=${e.why.join("/")}`);
    assert.ok(e.why.some(w => /死带子/.test(w)), "必须说清是死带子变多");
});

test("H12 挪一台机器 = 可能 regressive，且理由里带具体数字", () => {
    /* 这条是「旧体系完全看不见的破坏」的代表：挪一台 cutter 不改实体数、
       不改带子数，但会**切断一整条链**。旧口径（只看 goal_delta）对它零反应。 */
    const o = clone(L5);
    const cutter = o.entities.find(e => e.type === "cutter");
    cutter.x += 10;
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "regressive");
    assert.ok(e.why.some(w => /到 hub 的带子 \d+→\d+/.test(w)), `理由要带数字，实际：${e.why.join("/")}`);
});

test("H13 只改一条带子的朝向 = churn（不是 inert）", () => {
    const o = clone(L5);
    const b = o.entities.find(e => e.type === "belt");
    b.r = (b.r + 90) % 360;
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "churn", `判定=${e.kind} why=${e.why.join("/")}`);
    assert.ok(e.why.some(w => /形态/.test(w)));
});

test("H14 世界完全没动 = inert", () => {
    const { e } = judge(withObs(clone(L5)));
    assert.equal(e.kind, "inert");
});

test("H15 交货涨 = positive（优先级高于一切）", () => {
    const o = clone(L5);
    o.goal.requirement.delivered = 12;
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "positive");
});

test("H16 positive 优先于 regressive —— 同时发生也要判 positive", () => {
    /* 「net 交货了但拆坏了线」在真实迭代里很常见（模型为了交货硬接一条路）。
       判 positive 是对的：本轮的**意图与结果**都是交货。坏消息由 delta 自己带着走，
       不会被吞掉（timeline 里两行都写）。 */
    const o = clone(L5);
    o.goal.requirement.delivered = 12;
    o.entities = o.entities.filter(e => e.uid !== LIVE_BELT.uid);
    const { e, d } = judge(withObs(o));
    assert.equal(e.kind, "positive");
    assert.ok(d.some(x => x.metric === "belts_reaching_hub" && x.delta < 0), "破坏仍必须出现在 delta 里");
});

test("H17 hub 累计存量涨也算 positive（跨关时 delivered 会归零）", () => {
    /* 关键：**两边都要有数**。基准若是 null（存量读不到），`null → 5` 是「不可比」而不是
       「涨了 5」—— 按本仓库一贯的纪律不能据此判 positive。所以这里构造两份都有账本的世界。 */
    const before = clone(L5);
    before.hub = { ...(before.hub || {}), stored_shapes: { "Cu----Cu": 40 } };
    const after = clone(L5);
    after.hub = { ...(after.hub || {}), stored_shapes: { "Cu----Cu": 45 } };
    const b = worldHealth({ obs: before, items: L5_ITEMS });
    const a = worldHealth({ obs: after, items: L5_ITEMS });
    assert.equal(b.stored_goal, 40);
    const d = healthDelta(b, a);
    const e = classifyNetEffect(b, a, d);
    assert.equal(e.kind, "positive", `判定=${e.kind} why=${e.why.join("/")}`);
});

test("H17b 存量从 null 变成数**不许**判 positive（不可比就是不可比）", () => {
    const after = clone(L5);
    after.hub = { ...(after.hub || {}), stored_shapes: { "Cu----Cu": 5 } };
    const { e } = judge(withObs(after));
    assert.notEqual(e.kind, "positive", "没有基准就说「涨了」是假绿");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3b. 升级：唯一不体现在拓扑上的正向变化
 *
 * 这一组是**真机暴露出来的**，不是推演出来的。
 * 2026-11-13 r-20261113180132-31ba：模型买了 painting T1，实机上 hub 的
 * painting 从 L0 变成 L1、库存扣了 RbRb----×600，而 `classifyNetEffect`
 * 判的是 `inert` ——「世界没有任何变化」。
 *
 * 原因：升级**不产生任何 op**，所有拓扑指标一个都不动，而那次支出是真实的、
 * 不可逆的。判成 inert 会让排查方向整个反过来。
 * ══════════════════════════════════════════════════════════════════════════ */

test("H17c 买了升级 ⇒ positive（不是 inert），且 why 说清是升级而不是交付涨了", () => {
    const before = clone(L5);
    before.goal = { ...(before.goal || {}), upgrade_levels: { belt: 1, miner: 1, processors: 0, painting: 0 } };
    const after = clone(L5);
    after.goal = { ...(after.goal || {}), upgrade_levels: { belt: 1, miner: 1, processors: 0, painting: 1 } };

    const b = worldHealth({ obs: before, items: L5_ITEMS });
    const a = worldHealth({ obs: after, items: L5_ITEMS });
    assert.ok(b.upgrade_levels && b.upgrade_levels.painting === 0, "健康快照里必须有升级档位");
    const e = classifyNetEffect(b, a, healthDelta(b, a));
    assert.equal(e.kind, "positive", `判定=${e.kind} why=${e.why.join("/")}`);
    assert.ok(e.why.some(w => /升级/.test(w)), `why 必须说清是升级：${e.why.join("/")}`);
    assert.ok(e.why.some(w => /painting L0→L1/.test(w)), `why 要点名具体涨了哪条链：${e.why.join("/")}`);
});

test("H17d 升级档位没动 ⇒ 该 inert 还是 inert（这条不能误伤）", () => {
    /* 加 H17c 的风险是「只要有 upgrade_levels 字段就判 positive」——
       那会让什么都没做的轮次全都变绿。这里钉住反面。 */
    const before = clone(L5);
    before.goal = { ...(before.goal || {}), upgrade_levels: { belt: 1, painting: 1 } };
    const after = clone(L5);
    after.goal = { ...(after.goal || {}), upgrade_levels: { belt: 1, painting: 1 } };
    const b = worldHealth({ obs: before, items: L5_ITEMS });
    const a = worldHealth({ obs: after, items: L5_ITEMS });
    const e = classifyNetEffect(b, a, healthDelta(b, a));
    assert.equal(e.kind, "inert", `档位没变就不该判 positive，实得 ${e.kind} why=${e.why.join("/")}`);
});

test("H17f 时间线上升级要印成 `miner 1→2`，不许是 [object Object]", () => {
    /* 真机日志（r-20261113180536-5070）原来印的是
     *   `upgrade_levels [object Object]→[object Object]`
     * —— 而那一刻 miner 真的从 L1 买到了 L2。一次不可逆的库存支出，
     * 人读日志时完全看不出来。
     *
     * 根因：`upgrade_levels` 是对象，`num()` 对它返回 null ⇒ 掉进
     * 「不可比」分支 ⇒ 两边都被字符串化成 `[object Object]`。
     * 现在对象型指标走逐键 diff，展开成可读串。 */
    const before = { upgrade_levels: { belt: 1, miner: 1, processors: 0, painting: 0 }, entities: 148, shape: "a" };
    const after = { upgrade_levels: { belt: 1, miner: 2, processors: 0, painting: 1 }, entities: 155, shape: "b" };
    const line = formatDelta(healthDelta(before, after));
    assert.ok(!/object Object/.test(line), `不许出现 [object Object]：${line}`);
    assert.match(line, /miner 1→2/, `要点名涨了哪条链：${line}`);
    assert.match(line, /painting 0→1/, `两条链都涨了就要都列：${line}`);
    assert.match(line, /entities 148→155/, `别的项不许被这个改动弄丢：${line}`);
});

test("H17e 只升级、拓扑没动 ⇒ positive 且 why 只说升级", () => {
    /* ⚠️ 2026-11-13 红队指出：这条测试原来的标题是
     *   「升级与拓扑同时改善 ⇒ 仍然只说升级」
     * 但夹具里 `before`/`after` 的 entities 完全相同 —— **拓扑根本没改善**。
     * 也就是说它实际测的是「只升级」，而标题描述的行为从未被测过。
     *
     * 标题改成它真正测的东西。而「升级与拓扑同轮」那个真实行为，
     * 由 H17g 用实测数据钉住（红队的结论是：那种情况落到 regressive /
     * constructive，升级分支根本进不去 —— 这本身就是设计上的一个缺口）。 */
    const before = clone(L5);
    before.goal = { ...(before.goal || {}), upgrade_levels: { painting: 0 } };
    const after = clone(L5);
    after.goal = { ...(after.goal || {}), upgrade_levels: { painting: 1 } };
    const b = worldHealth({ obs: before, items: L5_ITEMS });
    const a = worldHealth({ obs: after, items: L5_ITEMS });
    const e = classifyNetEffect(b, a, healthDelta(b, a));
    assert.equal(e.kind, "positive", `实得 ${e.kind}`);
    assert.ok(e.why.some(w => /升级/.test(w)), `why 应点名升级：${e.why.join("/")}`);
});

test("H17g 升级与拓扑**同时**发生时，判定是什么（红队实测的行为）", () => {
    /* 红队实测（2026-11-13）：
     *   upgrade + 1 条带子（同轮）  ⇒ regressive  | 死带子 27→28
     *   upgrade + 一台孤立机器       ⇒ constructive
     *   只升级                        ⇒ positive
     *
     * 原因：`classifyNetEffect` 里升级分支排在 regressive / constructive
     * **之后**。而升级总是和其他 op 同批发生（loop 先执行 upgrade 再走 tx），
     * 所以真实的升级轮次几乎从不会落到升级分支。
     *
     * 这条测试**不判对错**，只是把这个行为钉住 —— 它是个已知缺口，
     * 在补「升级是主动决策，应与副作用分开记账」之前，至少不许悄悄变化。 */
    const before = clone(L5);
    before.goal = { ...(before.goal || {}), upgrade_levels: { painting: 0 } };
    const b = worldHealth({ obs: before, items: L5_ITEMS });

    const after = clone(L5);
    after.goal = { ...(after.goal || {}), upgrade_levels: { painting: 1 } };
    /* 同一轮还多了台孤立机器 —— 这是 "constructive" 的触发条件 */
    const nextUid = Math.max(...after.entities.map(e => e.uid || 0)) + 1;
    after.entities.push({
        uid: nextUid, type: "cutter", x: 90, y: 90, r: 0,
        variant: "default", rotation_variant: 0, code: 12, layer: "regular",
    });
    const a = worldHealth({ obs: after, items: L5_ITEMS });
    const e = classifyNetEffect(b, a, healthDelta(b, a));

    /* ★ 这条测试原本钉的是一个**已知缺口**：「结构变了就把升级的功劳盖掉」★
     *
     * 2026-11-15 夜补上了。加 `stalled_growth` 档位时，这个缺口从「不好看」
     * 变成了「会主动误导」：那种情况下模型会看到「你加了东西但世界没动」，
     * 而它其实买了一次升级（真实的进展，只是不体现在拓扑上）。
     *
     * 判「好」的判据必须比判「没进展」的判据先跑。所以升级判定提到了 `grewN` 之前。
     * 现在同轮「买升级 + 加机器」判 `positive`，且 `why` 里会说清是升级。 */
    assert.equal(e.kind, "positive",
        `同轮买升级 + 加机器 ⇒ 判 positive（升级是真实进展），实得 ${e.kind}`);
    assert.ok(e.why.some(w => /升级/.test(w)),
        `★ why 必须说清功劳来自升级，不能让人以为目标交付涨了。实得：${e.why.join("/")}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. delta 的形状与浮点
 * ══════════════════════════════════════════════════════════════════════════ */

test("H18 delta 只报真的变了的项", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const d = healthDelta(base(), withObs(o));
    assert.ok(d.length > 0);
    for (const row of d) assert.notEqual(row.before, row.after, `${row.metric} 没变却被报出来`);
    assert.ok(!d.some(x => x.metric === "level"), "level 没变就不该出现");
});

test("H19 delta 的浮点不带尾巴（比率要收敛）", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const d = healthDelta(base(), withObs(o));
    const pct = d.find(x => x.metric === "reach_pct");
    assert.ok(pct, "reach_pct 应该变了");
    /* 0.0050000000000000044 这类尾巴必须在 delta 里被抹平 */
    assert.equal(String(pct.delta).length <= 8, true, `delta=${pct.delta} 尾巴太长`);
});

test("H20 delta 方向：sign 按 GOOD_UP / GOOD_DOWN 判", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const d = healthDelta(base(), withObs(o));
    const dead = d.find(x => x.metric === "belts_dead");
    assert.equal(dead.dir, "down", "死带子确实是 down");
    assert.equal(dead.sign, "+", "死带子变少是好事 ⇒ +");
});

test("H21 一边为 null ⇒ delta 为 null 但仍报出来（不静默）", () => {
    const b = worldHealth({ obs: L5 });                       // items 为 null
    const a = worldHealth({ obs: clone(L5), items: L5_ITEMS }); // 有 items
    const d = healthDelta(b, a);
    const it = d.find(x => x.metric === "items_on_belts");
    assert.ok(it, "从 null 变成数也要报 —— 观测面刚恢复是一个事实");
    assert.equal(it.delta, null);
    assert.equal(it.sign, null);
});

test("H22 没有 before/after 时不崩，返回空", () => {
    assert.deepEqual(healthDelta(null, null), []);
    assert.deepEqual(healthDelta(base(), null), []);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 人读格式
 * ══════════════════════════════════════════════════════════════════════════ */

test("H23 formatHealth 一行内含目标/规模/连通性/货", () => {
    const s = formatHealth(base());
    assert.match(s, /L5/);
    assert.match(s, /Cu----Cu 0\/170/);
    assert.match(s, /实体 181/);
    assert.match(s, /到hub \d+\/160/);
    assert.match(s, /带上货 \d+/);
});

test("H24 formatDelta 默认只列有方向的项，all=true 才全列", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const d = healthDelta(base(), withObs(o));
    const lean = formatDelta(d);
    const full = formatDelta(d, { all: true });
    assert.ok(full.length >= lean.length);
    assert.match(lean, /▲ belts_dead/);
});

test("H25 formatNetEffect 用中文标签，且带上理由", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== DEAD_BELT.uid);
    const { e } = judge(withObs(o));
    const s = formatNetEffect(e);
    assert.match(s, /^净效果: cleanup/);
    assert.match(s, /清理/);
});

test("H26 六档标签齐全（新增档位必须同时补标签，否则 timeline 会印出裸 kind）", () => {
    for (const k of ["positive", "cleanup", "constructive", "regressive", "churn", "inert"]) {
        assert.ok(NET_EFFECT_LABEL[k], `缺标签：${k}`);
    }
});

test("H27 格式是稳定的：同一份快照两次格式化逐字节相同（timeline 要能 diff）", () => {
    assert.equal(formatHealth(base()), formatHealth(base()));
    assert.equal(shapeHash(L5), shapeHash(L5));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 施工中间态 vs 真破坏（2026-11-15，L12 真机）
 *
 * `connect` 的特征是**带子 +N、死带子 +N**：新铺的每一格在源头和下游都接上
 * 之前，按定义就是死带子。旧口径只看 `dead.delta > 0` 就判 regressive，于是
 * 一次正确的 connect 被记成「改坏了」，跨 run 记忆里 `connect` 被标成
 * 「rolled back, judged harmful」（n=7），模型读成「别用 connect」——
 * 而它是**唯一**能往 mixer 喂料的宏（实测 R3 就靠它推进）。
 * ══════════════════════════════════════════════════════════════════════════ */

test("H28 ★ 新铺的线有一部分已接上（死带子增量 < 带子增量）⇒ 不是 regressive", () => {
    /* ★ 为什么不拿真实世界造这个夹具 ★
     *
     * 试过：在 L5 里找一格能接上活线的位置。**找不到** —— L5 的 25 条死带子
     * 全都接不上（那正是「死」的意思），而既有活线周围没有可延伸的空格。
     * 硬凑出来的场景一律是 `dead.delta === belts.delta`（全孤立），
     * 那样 `if` 分支根本进不去，测试会**空转通过** —— 假绿比不写更糟。
     *
     * 所以这里直接造两份**最小快照**：它们只含 `classifyNetEffect` 需要的
     * 那几个指标字段。这不是绕过测试，是把被测函数的契约写清楚 ——
     * `classifyNetEffect(before, after, delta)` 只吃快照，不读世界。 */
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        ...o,
    });
    const before = snap({});
    /* 带子 100→104（+4），死带子 20→22（+2）：
       新增 4 条里有 2 条已接上、2 条还在等下游 —— 施工中间态。
       到 hub 的带子没减少（80→80），所以没有任何「原有的线被拆坏」的证据。 */
    const after = snap({ belts: 104, entities: 124, belts_dead: 22, belts_reaching_hub: 80 });
    const d = healthDelta(before, after);
    const deadD = (d.find(x => x.metric === "belts_dead") || {}).delta;
    const beltsD = (d.find(x => x.metric === "belts") || {}).delta;
    assert.equal(beltsD, 4, "前置：带子 +4");
    assert.equal(deadD, 2, "前置：死带子 +2（严格小于带子增量）");
    const e = classifyNetEffect(before, after, d);
    assert.notEqual(e.kind, "regressive",
        `部分新带子已接上 ⇒ 施工中间态（why=${e.why.join("/")}）`);
});

test("H28b ★ 对照组：带子没涨、死带子涨 ⇒ 仍是 regressive（原有的线被拆坏了）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        ...o,
    });
    const before = snap({});
    const after = snap({ belts_dead: 23 });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "regressive",
        `带子总数没变而死带子涨 ⇒ 是既有线被拆坏（why=${e.why.join("/")}）`);
    assert.ok(e.why.some(w => /死带子/.test(w)), "必须说清是死带子变多");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 「加了东西但世界没动」必须是独立一档（2026-11-15 夜，L12 真机）
 *
 * `production()` 的 `produced_total` 恒为空（拉长窗口、加切片、重启游戏重载
 * 存档之后仍然空），而 agent 连续七八轮都在加带子/加机器，每轮判 constructive。
 * 世界从 435 涨到 467 实体、带子 382→411，产出始终 0 ——
 * 它在往一个死掉的世界里堆料，而判据一路给绿灯。
 * ══════════════════════════════════════════════════════════════════════════ */

test("H29 ★ 加了东西但带上的货没增加 ⇒ stalled_growth（不是 constructive）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    /* 加了 3 条带子，但货量一点没动、连通性也没改善 —— 新带子是死的 */
    const before = snap({});
    const after = snap({ belts: 103, entities: 123, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "stalled_growth",
        `加了东西但世界没动 ⇒ 不能算进展（why=${e.why.join("/")}）`);
    assert.ok(e.why.some(w => /完全没动|没有增加/.test(w)),
        `理由必须说清「世界没动」，不能只说「结构变了」。实得：${e.why.join("/")}`);
});

test("H29b ★ 对照：加了东西且货量涨了 ⇒ 仍是 constructive（不是 stalled_growth）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    const before = snap({});
    const after = snap({ belts: 103, entities: 123, items_on_belts: 61, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "constructive",
        `货量涨了说明新线接进了活货流 ⇒ 是施工中，不该判 stalled_growth（why=${e.why.join("/")}）`);
});

test("H29c ★ 对照：加了东西且死带子减少 ⇒ 不算 stalled_growth（有改善）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    const before = snap({});
    /* 带子涨、死带子降 —— 新线有一部分接上了，还顺手清了旧的 */
    const after = snap({ belts: 103, entities: 123, belts_dead: 17, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.notEqual(e.kind, "stalled_growth",
        `死带子减少是真改善，不能判 stalled_growth（why=${e.why.join("/")}）`);
});

test("H11b ★ 全部新带子都孤立（死带子增量 === 带子增量）⇒ 仍是 regressive", () => {
    /* 这条与 H11 同向，但把边界条件写成显式断言：
       判据是 dead.delta < belts.delta（**严格小于**），不是 <=。
       全孤立时必须照旧判红 —— 那是「铺了一堆没人要的带子」，不是施工中。 */
    const o = clone(L5);
    let uid = 920001;
    for (let i = 0; i < 3; i++) {
        o.entities.push({ uid: uid++, type: "belt", x: 60 + i, y: 60, r: 0, rotation_variant: 0, code: 1 });
    }
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "regressive", `全孤立的新带子不该被当成施工中（why=${e.why.join("/")}）`);
    assert.ok(e.why.some(w => /死带子/.test(w)), "必须说清是死带子变多");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 铺了一条死线：总货量微涨，但带货路径数没涨（2026-11-15 夜，L12 真机）
 *
 * `items_on_belts` 是个粗指标 —— 铺新线时那几格上会带几个存货，总货量
 * 于是微涨，`stalled_growth` 判不出来。但路径数从 35 涨到 37、
 * 带货的还是那 13 条，这就是**又铺了一条死的**。
 *
 * 实测 L12：545 条带子 / 37 条路径，只有 13 条带货运货（35%）。
 * ══════════════════════════════════════════════════════════════════════════ */

test("H30 ★ 总货量微涨但带货路径数没涨 ⇒ 仍是 stalled_growth", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        paths_with_items: 13, paths_total: 35,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    const before = snap({});
    /* 带子 +3、货 +2（新线上有几个存货），但带货路径数没变（还是 13 条） */
    const after = snap({
        belts: 103, entities: 123, items_on_belts: 52,
        paths_with_items: 13, paths_total: 37, shape: "b",
    });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "stalled_growth",
        `总货量涨了 2 但带货路径数没涨 ⇒ 又是条死线（why=${e.why.join("/")}）`);
});

test("H30b ★ 对照：带货路径数涨了 ⇒ 是 constructive（新线真的接了货）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        paths_with_items: 13, paths_total: 35,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    const before = snap({});
    /* 带货路径 13 → 15：新线真的接进了活货流 */
    const after = snap({
        belts: 103, entities: 123, items_on_belts: 61,
        paths_with_items: 15, paths_total: 37, shape: "b",
    });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "constructive",
        `带货路径数涨了 ⇒ 新线接了货，不该判 stalled_growth（why=${e.why.join("/")}）`);
});

test("H30c ★ 拿不到 paths 指标时退回只看货量（不能因缺字段就判停滞）", () => {
    const snap = (o) => ({
        belts: 100, machines: 10, entities: 120,
        belts_reaching_hub: 80, belts_dead: 20,
        items_on_belts: 50, reach_pct: 0.8,
        paths_with_items: null, paths_total: null,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 },
        shape: "a",
        ...o,
    });
    const before = snap({});
    const after = snap({ belts: 103, entities: 123, items_on_belts: 61, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.notEqual(e.kind, "stalled_growth",
        `货量涨了、paths 字段缺席 ⇒ 不该判停滞（why=${e.why.join("/")}）`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 死带子涨几条不该判 regressive（2026-11-15 夜，L12 真机）
 *
 * 实测：一次 `connect` 铺了 39 条带子，死带子从 211 涨到 215 —— 只涨 4 条
 * （39 条里 35 条已经接上了）。可判据据此给出 regressive，跨 run 记忆
 * 于是把 `connect` 记成「judged harmful」×22，agent 最后在 prompt 里
 * 写下「Abandoning connect/replace_run (both regressed)」——
 * **主动放弃了唯一能建线的两个宏**。
 * ══════════════════════════════════════════════════════════════════════════ */

test("H31 ★ 死带子涨 4/211（1.9%）不算改坏 —— 那是长线施工的正常中间态", () => {
    const snap = (o) => ({
        belts: 400, machines: 10, entities: 420,
        belts_reaching_hub: 206, belts_dead: 211,
        items_on_belts: 50, reach_pct: 0.8,
        paths_with_items: 10, paths_total: 20,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 }, shape: "a",
        ...o,
    });
    const before = snap({});
    /* 铺 39 条新线，35 条已接上、4 条还死着 */
    const after = snap({ belts: 439, entities: 459, belts_dead: 215, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.notEqual(e.kind, "regressive",
        `涨 4/211 = 1.9%，低于 5% 容差，不该判 regressive（why=${e.why.join("/")}）`);
});

test("H31b ★ 对照：死带子涨 59/133（44%）照旧判 regressive", () => {
    const snap = (o) => ({
        belts: 200, machines: 10, entities: 220,
        belts_reaching_hub: 133, belts_dead: 133,
        items_on_belts: 50, reach_pct: 0.8,
        paths_with_items: 10, paths_total: 20,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 }, shape: "a",
        ...o,
      });
    const before = snap({});
    const after = snap({ belts: 260, entities: 280, belts_dead: 192, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "regressive",
        `涨 59/133 = 44%，必须判红（why=${e.why.join("/")}）`);
    assert.ok(e.why.some(w => /死带子/.test(w)), "理由必须说清是死带子变多");
});

test("H31c ★ 对照：绝对涨 10 条即使占比低也判红", () => {
    const snap = (o) => ({
        belts: 900, machines: 10, entities: 920,
        belts_reaching_hub: 500, belts_dead: 400,
        items_on_belts: 50, reach_pct: 0.55,
        paths_with_items: 10, paths_total: 20,
        delivered: 0, stored_goal: 0, level: 12, required: 1000, progress: 0,
        upgrade_levels: { belt: 0 }, shape: "a",
        ...o,
    });
    const before = snap({});
    /* 涨 10/400 = 2.5%（低于 5%），但绝对涨 10 条 —— 绝对阈值兜底 */
    const after = snap({ belts: 910, entities: 930, belts_dead: 410, shape: "b" });
    const d = healthDelta(before, after);
    const e = classifyNetEffect(before, after, d);
    assert.equal(e.kind, "regressive",
        `占比只有 2.5% 但绝对涨 10 条，双阈值里绝对那条该兜住（why=${e.why.join("/")}）`);
});
