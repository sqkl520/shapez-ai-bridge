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

test("H10 删一条活带子 = regressive", () => {
    const o = clone(L5);
    o.entities = o.entities.filter(e => e.uid !== LIVE_BELT.uid);
    const { e } = judge(withObs(o));
    assert.equal(e.kind, "regressive", `判定=${e.kind} why=${e.why.join("/")}`);
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

    /* 已知缺口：结构变了就把升级的功劳盖掉。钉住它，防止「以为改了其实是抖动」。 */
    assert.ok(["constructive", "regressive"].includes(e.kind),
        `同轮结构性变化会盖过升级 —— 当前实现应当落在 constructive/regressive，实得 ${e.kind}`);
    assert.ok(!e.why.some(w => /升级/.test(w)),
        `★ 已知缺口：升级的贡献在这条路径上不会被说出来。实得：${e.why.join("/")}`);
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
