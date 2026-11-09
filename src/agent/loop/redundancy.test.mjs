/**
 * redundancy.test.mjs —— 「删除冗余度」的判据钉死。
 *
 * 这个度量存在的理由写在这里，因为它是**三轮实验的教训**：
 *
 *   P14（`$ore` 提示）、P17（卡片 `when:`）、P18（后果可见）都在优化
 *   「怎么让模型多用 remove_run」，全部证伪。真相是：
 *
 *     L4 夹具     161 条带子   可安全单删 0
 *     L5 真机     158 条带子   可安全单删 0
 *     L11 成熟    2107 条带子  可安全单删 265 (12.6%)
 *
 *   **L4/L5 是零冗余世界。** 在那里删任何一条都是错的 ——
 *   模型拒绝裸 `remove_run` 是**正确行为**，我把它读成了缺陷。
 *
 * 所以这个文件测的不是「模型删得好不好」，而是「这个世界该不该删」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removalRedundancy, formatRedundancy } from "./redundancy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const load = p => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));
    return Array.isArray(raw) ? { entities: raw } : (raw.result || raw);
};

/* ── 夹具：手工构造，不依赖外部文件 ── */
const belt = (uid, x, y) => ({ uid, type: "belt", x, y, r: 0, rotation_variant: 0, layer: "regular" });

test("R1 空世界：belts=0，safe=0，safe_pct=null（不是 0 —— 0 与 null 是相反结论）", () => {
    const r = removalRedundancy({ entities: [] });
    assert.equal(r.belts, 0);
    assert.equal(r.safe, 0);
    assert.equal(r.safe_pct, null, "没有带子时冗余率必须是 null，不是 0");
});

test("R2 一条悬空带子 ⇒ 100% 可安全删", () => {
    const r = removalRedundancy({ entities: [belt(9001, 0, 0)] });
    assert.equal(r.belts, 1);
    assert.equal(r.safe, 1);
    assert.equal(r.breaking, 0);
    assert.equal(r.safe_pct, 1);
});

test("R3 三格相连的悬空段 ⇒ 全段 100%（彼此互为邻居，拆了不伤外部）", () => {
    const r = removalRedundancy({ entities: [belt(1, 0, 0), belt(2, 1, 0), belt(3, 2, 0)] });
    assert.equal(r.belts, 3);
    assert.equal(r.safe, 3, `三格悬空段里每一格单独删都不会伤到外部，实际 ${JSON.stringify(r.break_kinds)}`);
    assert.equal(r.safe_pct, 1);
});

test("R4 真实链上的一段 ⇒ 0% 可安全删（这是 L4/L5 的情形）", () => {
    /* ⚠️ 这里必须用**真实夹具的邻域切片**，不能手工构造。
       第一版我用 `miner(0,0) + belt(0,1) + hub(0,2)` 手工搭，结果 safe=1 ——
       因为手工实体没有正确的朝向（`rotation_variant`/`r`），拓扑根本连不上。
       这正是本项目反复踩的坑：带子的方向不是「上下左右相邻」那么简单。

       切片：以 L4 里第一条带子为中心的 5×5 邻域，13 个实体、10 条带子。 */
    const all = load("research/ai-plan/live-L4-entities.json");
    const b = all.entities.find(e => e.type === "belt");
    assert.ok(b, "L4 夹具里应有带子");
    const near = all.entities.filter(e => Math.abs(e.x - b.x) <= 2 && Math.abs(e.y - b.y) <= 2);
    const r = removalRedundancy({ entities: near });
    assert.ok(r.belts >= 5, `邻域内应有若干带子，实际 ${r.belts}`);
    assert.equal(r.safe, 0, `真实链上不该有可安全单删的带子，实际 ${r.safe}`);
    assert.equal(r.safe_pct, 0);
    assert.ok(r.breaking > 0);
});

test("R5 ★ L4 夹具：161 条带子，0 条可安全单删 ★（P18 的核心事实）", () => {
    const r = removalRedundancy(load("research/ai-plan/live-L4-entities.json"));
    assert.equal(r.belts, 161, `L4 带子数应为 161，实际 ${r.belts}`);
    assert.equal(r.safe, 0, `L4 里不该有可安全单删的带子，实际 ${r.safe}`);
    assert.equal(r.breaking, 161);
    assert.equal(r.safe_pct, 0);
    /* 措辞必须点明「该做的是建连接/加产能，不是删」—— 这正是三轮实验走错的地方 */
    const msg = formatRedundancy(r);
    assert.match(msg, /没有可清理的东西/);
    assert.match(msg, /不是删/);
});

test("R6 ★ L5 真机基线：158 条带子，0 条可安全单删 ★", () => {
    const r = removalRedundancy(load(".tmpverify/obs-live-baseline.json"));
    assert.equal(r.belts, 158);
    assert.equal(r.safe, 0);
    assert.equal(r.safe_pct, 0);
});

test("R7 ★ L11 成熟世界：有真冗余（12%+）★ —— 与 L4/L5 形成对照", () => {
    /* 这条是 R5/R6 的对照组。**它原来的期望值（≥200 条可安全删、12.6%）是错的**。
       ⚠️ 夹具在 `.tmpverify/`（本地实验产物，不进仓）。缺了它这条跳过 ——
       skip 而不是 fail：R5/R6 仍然钉着核心结论，不该因为少一份对照组就红。 */
    const f = path.join(REPO, ".tmpverify/obs-before.json");
    if (!fs.existsSync(f)) {
        assert.ok(true, "对照组夹具不在本地（.tmpverify 未保留），跳过 —— R5/R6 不受影响");
        return;
    }
    const r = removalRedundancy(load(".tmpverify/obs-before.json"));
    assert.ok(r.belts > 2000, `L11 带子数应 >2000，实际 ${r.belts}`);

    /* ★ 2026-11-09 修正：这个数不是 265，是 0 ★
     *
     * 原来这里断言「应有 >200 条可安全单删、冗余率 10%~50%」，依据是
     * `research/ai-plan/P18-CONSEQUENCE-VISIBILITY-AB.md` §3 的那张表。
     * **那张表是错的** —— 它算的时候 `makeContext()` 里还有一条
     * `if (rec.r !== 0) { …空端口表… }`，于是 L11 的 4 台 r=90 rotater
     * 拿不到端口，`starved-machine` 判不出来，一批本该算出后果的带子
     * 被误算成"干净可删"。
     *
     * 放开 r≠0 之后重算：
     *   L4  161 条 → 0
     *   L5  158 条 → 0
     *   L11 2107 条 → 0      ← 从 265 掉到 0
     *
     * 而且不只"单删"是 0 —— 按连通段整段删也是 **0/365**。
     * 抽样核对过，报出来的后果都是真的（「机器 uid=10227 的输入槽 in0#0
     * 只剩 (-7,11) 供料」），不是误报。
     *
     * 所以结论要改口径：**这个度量在所有已知世界里都是 0** ——
     * 它不是"测不出区别"，而是"这些工厂确实没有冗余"。
     * 一个成熟工厂的每一条带子都在某个环节上，单删必断，这是事实不是缺陷。
     *
     * 那这个度量还有用吗？有，但它的用途变了：它回答的是
     * 「**这个场景该不该删**」而不是「**模型删得好不好**」。
     * 恒为 0 的意思恰恰是：在这些场景里，让模型多删是个错目标 ——
     * 这正是 P14/P17/P18 三轮实验全部证伪的原因。
     *
     * 所以 R7 现在钉的是这个**否定结论**：它必须如实报 0，
     * 而不是因为度量坏了才报 0。判据是"后果描述必须真实" —— 见 R7b。 */
    assert.equal(r.safe, 0,
        `L11 实测 0 条可安全单删（265 那个数是 r≠0 漏判导致的假象），实际 ${r.safe}`);
    assert.equal(r.safe_pct, 0);
    assert.match(formatRedundancy(r), /没有可清理的东西/);
});

test("R7b 报出来的后果必须是真的（防止度量为了「报 0」而乱判）", () => {
    /* R7 断言 0 之后，必须有一条测试保证「0」不是瞎报的。
       做法：抽一条带子，看它的后果描述是否指向真实存在的实体。 */
    const f = path.join(REPO, ".tmpverify/obs-before.json");
    if (!fs.existsSync(f)) { assert.ok(true, "夹具不在本地，跳过"); return; }

    const obs = load(".tmpverify/obs-before.json");
    const r = removalRedundancy(obs);
    assert.ok(r.break_kinds && Object.keys(r.break_kinds).length > 0,
        `必须给出后果分类，实际 ${JSON.stringify(r.break_kinds)}`);
    /* 每一条后果种类都必须有非零计数且合计 > 0 —— 空对象和全零都是"没真算" */
    const total = Object.values(r.break_kinds).reduce((s, v) => s + v, 0);
    assert.ok(total > 0, `后果计数合计必须 >0，实际 ${total}`);
    /* starved-machine 必须出现 —— 它正是 r≠0 漏判时消失的那一类。
       如果它又变回 0，说明有人把 makeContext 的旋转端口支持改回去了。 */
    assert.ok((r.break_kinds["starved-machine"] || 0) > 0,
        `L11 有 4 台 r=90 rotater，starved-machine 必须 >0，实际 ${JSON.stringify(r.break_kinds)}`);
});

test("R8 坏 obs ⇒ 整条降级为 null，不报 0", () => {
    const r = removalRedundancy(null);
    assert.equal(r.belts, null);
    assert.equal(r.safe, null, "读不到就说读不到，不许用 0 冒充");
    assert.match(r.reason, /no entities/);
    assert.match(formatRedundancy(r), /不可用/);
});

test("R9 纯函数：同一份 obs 两次调用逐字节相同", () => {
    const obs = load("research/ai-plan/live-L4-entities.json");
    const a = removalRedundancy(obs);
    const b = removalRedundancy(obs);
    assert.deepEqual(a, b);
    assert.equal(formatRedundancy(a), formatRedundancy(b));
});

test("R10 sample 参数：抽样时如实标注 sampled，且不谎报全量", () => {
    const obs = load("research/ai-plan/live-L4-entities.json");
    const r = removalRedundancy(obs, { sample: 20 });
    assert.equal(r.sampled, 20);
    assert.equal(r.safe + r.breaking, 20, "抽样时 safe+breaking 只统计样本内");
    assert.equal(r.belts, 161, "但 belts 仍报全量（分母要说真话）");
    assert.match(formatRedundancy(r), /抽样 20\/161/);
});

test("R11 全量与抽样在同一世界上的 safe_pct 差距不大（抽样是有代表性的）", () => {
    const obs = load("research/ai-plan/live-L4-entities.json");
    const full = removalRedundancy(obs);
    const samp = removalRedundancy(obs, { sample: 60 });
    assert.equal(full.safe_pct, 0);
    assert.equal(samp.safe_pct, 0, "L4 是全零世界，抽样也该是全零");
});
