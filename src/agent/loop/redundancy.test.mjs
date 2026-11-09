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
    /* 这条是 R5/R6 的对照组：同样是这个度量，在成熟世界里标准就该不一样。
       如果这条也报 0%，说明度量坏了（永远报 0），R5/R6 就没有信息量。
       ⚠️ 夹具在 `.tmpverify/`（本地实验产物，不进仓）。缺了它这条跳过 ——
       skip 而不是 fail：R5/R6 仍然钉着核心结论，不该因为少一份对照组就红。 */
    const f = path.join(REPO, ".tmpverify/obs-before.json");
    if (!fs.existsSync(f)) {
        assert.ok(true, "对照组夹具不在本地（.tmpverify 未保留），跳过 —— R5/R6 不受影响");
        return;
    }
    const r = removalRedundancy(load(".tmpverify/obs-before.json"));
    assert.ok(r.belts > 2000, `L11 带子数应 >2000，实际 ${r.belts}`);
    assert.ok(r.safe > 200, `L11 应有 >200 条可安全单删，实际 ${r.safe}`);
    assert.ok(r.safe_pct > 0.1 && r.safe_pct < 0.5,
        `L11 冗余率应在 10%~50%，实际 ${r.safe_pct}`);
    assert.match(formatRedundancy(r), /可安全单删/);
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
