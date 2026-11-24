/**
 * 被游戏**静默重算方向**的邻居带子，必须可见。
 *
 * ## 这个文件守的是什么
 *
 * 上游 `systems/belt.js:59-64`：
 *
 *     this.root.signals.entityDestroyed.add(this.updateSurroundingBeltPlacement, this);
 *     this.root.signals.entityAdded.add(this.updateSurroundingBeltPlacement, this);
 *
 * `updateSurroundingBeltPlacement`（`systems/belt.js:117-212`）会把落点**周围一圈**
 * 的带子按邻居重算 `rotation` / `rotationVariant`，并覆写 `code`。也就是说：
 * 一次 `place` / `delete` / `insert_machine` 的**真实后果**可能大于它声明的 ops。
 *
 * ## 为什么这是「必须可见」而不是「知道了也没用」
 *
 * 实测事故（`.findings/ROOTCAUSE-COLOR-SLOT-2026-11-23.md`）：
 *
 *   2026-11-15 12:14:35  r-20261115121125-264d r3
 *     macro  insert_machine(trash) @(-3,-8)
 *     tx_plan 只声明 destroys:[15021] + placements:1
 *     apply   回报 diff{added:1, removed:1}
 *     但游戏重算邻居：
 *       belt#14953@(-3,-7) rv 2 → 0   （左→下转角 变 左→右直带）
 *       belt#15019@(-2,-7) r 180 → 90
 *   2026-11-15 12:19:51  produced_total 从 10 个键变成 {}（dt = 5 分钟）
 *
 * 一个「放垃圾桶」的动作，静默地掰断了一条供料主链，然后整座工厂停产。
 * 模型拿到的全部信息是「拆 1 格、放 1 个」—— 它**无从知道**自己顺手改了什么。
 *
 * ## 判据为什么在 loop 侧而不是 mod 侧
 *
 * loop 每轮本来就有 `beforeObs` 与 `afterObs` 两份**同口径**的世界；两份一减
 * 就知道谁被改了。这条路**不改 mod、不需要重新 patch 游戏、可以纯离线验**。
 * mod 侧的 `snapshotWorld` / `diffSnapshots` 也能算，但那要重新装 mod 才能生效。
 *
 * ## 三条不可退让的性质（每条都对应一种「修了等于没修」）
 *
 *   1. **只报「两边都在、但朝向变了」**：新放的（added）与删掉的（removed）归 `diff` 管，
 *      混进来会让这个读数变成 `diff` 的复读机。
 *   2. **不判红**：邻居重算是游戏正常行为，大多数时候算出来与我们要的一致。
 *      判红会让每一次正常放置都失败（`tx.verify` 注释里那条纪律的同一条）。
 *   3. **必须到 prompt**：算出来 ≠ 送到（本仓库最高频缺陷）。所以既验 `verifyRound`
 *      的产出，也验 `renderLastRound` 真的把它渲染成了模型认得出的名字。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reorientedBelts, verifyRound, applyVerdict } from "./verify.mjs";
import { buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";
import FakeGame from "../fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FIX = path.join(REPO, "test/fixtures/saves");
const L4_PATH = path.join(FIX, "L4-obs.json");
const L4 = JSON.parse(fs.readFileSync(L4_PATH, "utf8")).result;

/* ═══════════════════════ 夹具 ═══════════════════════ */

/** 最小的世界：只有带子，坐标/uid/rv 全部显式 —— 断言才不依赖夹具细节。 */
function world(belts) {
    return {
        tick: 0,
        entities: belts.map(b => ({
            uid: b.uid, type: "belt", variant: "default",
            x: b.x, y: b.y, r: b.r, rotation_variant: b.rv,
            code: 1 + b.rv, layer: "regular",
        })),
    };
}

/* ═══════════ 1. 核心：静默改向必须被算出来 ═══════════ */

test("R1 ★ 事故复现：rv 2→0 与 r 180→90 两条必须被找出来（其余不动）", () => {
    /* 用 2026-11-15 那次事故的真实数字。周围放几条**没变**的带子当对照 ——
       不加对照的话「全量返回」也能过，那样这个读数就没有判别力。 */
    const before = world([
        { uid: 14953, x: -3, y: -7, r: 90, rv: 2 },   // 事故：rv 2 → 0
        { uid: 15019, x: -2, y: -7, r: 180, rv: 0 },  // 事故：r 180 → 90（rv 也变 2）
        { uid: 15020, x: -2, y: -6, r: 0, rv: 0 },    // 对照：完全没动
        { uid: 14952, x: -4, y: -7, r: 90, rv: 0 },   // 对照：完全没动
    ]);
    const after = world([
        { uid: 14953, x: -3, y: -7, r: 90, rv: 0 },   // ← 左→下转角 变成 左→右直带
        { uid: 15019, x: -2, y: -7, r: 90, rv: 2 },   // ← 方向翻转
        { uid: 15020, x: -2, y: -6, r: 0, rv: 0 },
        { uid: 14952, x: -4, y: -7, r: 90, rv: 0 },
    ]);

    const r = reorientedBelts(before, after);
    assert.equal(r.count, 2, `必须只报变了的 2 条，实得 ${r.count}：${JSON.stringify(r.items)}`);

    const a = r.items.find(i => i.uid === 14953);
    assert.ok(a, "14953 必须在结果里");
    assert.deepEqual(a.before, { r: 90, rv: 2 }, `14953 改前应是 r90 rv2，实得 ${JSON.stringify(a.before)}`);
    assert.deepEqual(a.after, { r: 90, rv: 0 }, `14953 改后应是 r90 rv0，实得 ${JSON.stringify(a.after)}`);

    const b = r.items.find(i => i.uid === 15019);
    assert.ok(b, "15019 必须在结果里");
    assert.equal(b.before.r, 180, "15019 改前 r=180");
    assert.equal(b.after.r, 90, "15019 改后 r=90");

    /* 对照没变的不许出现 —— 这是「不是全量返回」的唯一证据 */
    assert.ok(!r.items.some(i => i.uid === 15020), "没变的 15020 不该出现");
    assert.ok(!r.items.some(i => i.uid === 14952), "没变的 14952 不该出现");
});

test("R2 入口/出口方位要算出来（模型读得懂的是 in/out，不是 rv 数字）", () => {
    /* rv2 / r90：入口 = rotateLocal(bottom, 90) = left；出口 = rotateLocal(right, 90) = bottom
       rv0 / r90：入口 left；出口 = rotateLocal(top, 90) = right
       即事故原文的「左→下转角 变成 左→右直带」。 */
    const before = world([{ uid: 14953, x: 0, y: 0, r: 90, rv: 2 }]);
    const after = world([{ uid: 14953, x: 0, y: 0, r: 90, rv: 0 }]);
    const it = reorientedBelts(before, after).items[0];
    assert.ok(it, "14953 应当被报出来");
    assert.equal(it.entry.before, "left", `改前入口应是 left，实得 ${it.entry.before}`);
    assert.equal(it.entry.after, "left", `改后入口仍应是 left，实得 ${it.entry.after}`);
    assert.equal(it.exit.before, "bottom", `改前出口应是 bottom，实得 ${it.exit.before}`);
    assert.equal(it.exit.after, "right", `改后出口应是 right，实得 ${it.exit.after}`);
});

test("R3 新放的带子不算「被改向」（added 归 diff 管，不是静默重算）", () => {
    const before = world([{ uid: 1, x: 0, y: 0, r: 0, rv: 0 }]);
    const after = world([
        { uid: 1, x: 0, y: 0, r: 0, rv: 0 },
        { uid: 2, x: 1, y: 0, r: 90, rv: 2 },   // 新建的 —— 不该进 reoriented
    ]);
    const r = reorientedBelts(before, after);
    assert.equal(r.count, 0, `新放的带子不该算改向，实得 ${r.count}：${JSON.stringify(r.items)}`);
});

test("R4 计划声明要删的 uid 即便出现在 after 里也不算静默改向", () => {
    const before = world([{ uid: 7, x: 0, y: 0, r: 0, rv: 0 }]);
    const after = world([{ uid: 7, x: 0, y: 0, r: 90, rv: 2 }]);
    const r = reorientedBelts(before, after, { declaredDestroys: [7] });
    assert.equal(r.count, 0, `声明过要删的不该算「静默」，实得 ${JSON.stringify(r.items)}`);
});

test("R5 非带子实体的朝向变化不进来（机器有 r 但没有 rv 语义）", () => {
    const mk = (r) => ({ tick: 0, entities: [
        { uid: 9, type: "cutter", variant: "default", x: 0, y: 0, r, rotation_variant: 0, code: 9, layer: "regular" },
    ] });
    const r = reorientedBelts(mk(0), mk(90));
    assert.equal(r.count, 0, `机器转向不该进「被重算的带子」这一项，实得 ${JSON.stringify(r.items)}`);
});

test("R6 缺一份 obs 时返回空（不抛、不猜）", () => {
    assert.equal(reorientedBelts(null, world([])).count, 0, "before 缺失 → 空");
    assert.equal(reorientedBelts(world([]), null).count, 0, "after 缺失 → 空");
    assert.equal(reorientedBelts(null, null).count, 0, "两份都缺 → 空");
});

test("R7 句柄表在时用句柄，不在时退 uid（模型认 B149，不认 14953）", () => {
    const before = world([{ uid: 14953, x: -3, y: -7, r: 90, rv: 2 }]);
    const after = world([{ uid: 14953, x: -3, y: -7, r: 90, rv: 0 }]);

    const withH = reorientedBelts(before, after, { handleTable: buildHandles(after, null) });
    const h = withH.items[0];
    assert.ok(h && typeof h.handle === "string" && /^B\d+$/.test(h.handle),
        `句柄表给得出 Bnn，实得 ${h && h.handle}`);

    const without = reorientedBelts(before, after);
    assert.equal(without.items[0].handle, null, "没有句柄表时 handle 必须是 null（不许编）");
    assert.equal(without.items[0].uid, 14953, "uid 仍然在（句子能退到 belt#14953）");
});

/* ═══════════ 2. 必须到达 prompt（算出来 ≠ 送到） ═══════════ */

test("R8 ★ prompt 里出现被改向的带子（句柄 + 入口/出口方位）", () => {
    const handles = buildHandles(L4, null);
    /* 借 L4 里一条真带子当「被改的那条」—— 这样句柄是夹具算出来的真名字 */
    const victim = L4.entities.find(e => e.type === "belt");
    assert.ok(victim, "L4 夹具里应当有带子");
    const beforeObs = { tick: 0, entities: [structuredClone(victim)] };
    const afterObs = { tick: 0, entities: [{ ...structuredClone(victim), r: ((victim.r | 0) + 90) % 360 }] };

    const reo = reorientedBelts(beforeObs, afterObs, { handleTable: handles });
    assert.equal(reo.count, 1, `应当算出 1 条，实得 ${JSON.stringify(reo)}`);

    const p = buildPrompt({
        goal: "RuRu----", obs: L4, handles,
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: {
            round: 1, calls: ["insert_machine"],
            verify: { checks: [], codes: [] },
            decision: "continue",
            belt_reorient: reo,
        },
    });
    const s5 = p.blocks.S5;
    assert.match(s5, /reoriented belts/, `S5 里必须有这一段，实际：${s5}`);
    /* 句柄必须出现 —— 这才是模型能在 S3 里找到它的键 */
    const h = handles.byUid.get(victim.uid);
    assert.ok(h, "句柄表里应当有这条带子");
    assert.ok(s5.includes(h), `prompt 里必须出现句柄 ${h}，实际：${s5}`);
    /* 「你没声明」这句话必须出现 —— 否则模型会以为这是它自己写的 op 的结果 */
    assert.match(s5, /You did not declare these/, "必须说清「你没有声明这些」");
});

test("R9 没有改向时不渲染这一段（不许每轮都出现空段）", () => {
    const handles = buildHandles(L4, null);
    const p = buildPrompt({
        goal: "RuRu----", obs: L4, handles,
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: { round: 1, calls: ["insert_machine"], verify: { checks: [], codes: [] }, belt_reorient: null },
    });
    assert.doesNotMatch(p.blocks.S5, /reoriented belts/, `没有改向就不该出现这一段，实际：${p.blocks.S5}`);
});

test("R10 只渲染前 3 条，其余折成 (+N more)（预算是硬的）", () => {
    const mk = (uid, rv) => ({
        tick: 0, entities: [{ uid, type: "belt", variant: "default", x: uid, y: 0, r: 0, rotation_variant: rv, code: 1 + rv, layer: "regular" }],
    });
    const before = { tick: 0, entities: [0, 1, 2, 3, 4].map(i => mk(100 + i, 0).entities[0]) };
    const after = { tick: 0, entities: [0, 1, 2, 3, 4].map(i => mk(100 + i, 1).entities[0]) };
    const reo = reorientedBelts(before, after);
    assert.equal(reo.count, 5, `应当算出 5 条，实得 ${reo.count}`);

    const p = buildPrompt({
        goal: "RuRu----", obs: L4, handles: buildHandles(L4, null),
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: { round: 1, calls: ["insert_machine"], verify: { checks: [], codes: [] }, belt_reorient: reo },
    });
    const s5 = p.blocks.S5;
    assert.match(s5, /\(\+2 more\)/, `5 条里只列 3 条，其余折成 (+2 more)，实际：${s5}`);
});

test("R11 prompt 里不许出现裸坐标（改向读数走句柄，不走格子）", () => {
    const mk = (r, rv) => ({ tick: 0, entities: [{ uid: 1, type: "belt", variant: "default", x: -3, y: -7, r, rotation_variant: rv, code: 1 + rv, layer: "regular" }] });
    const reo = reorientedBelts(mk(90, 2), mk(90, 0));
    const p = buildPrompt({
        goal: "RuRu----", obs: L4, handles: buildHandles(L4, null),
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: { round: 1, calls: ["insert_machine"], verify: { checks: [], codes: [] }, belt_reorient: reo },
    });
    const s5 = p.blocks.S5;
    assert.doesNotMatch(s5, /-3\s*,\s*-7/, `S5 里不该出现裸坐标，实际：${s5}`);
    assert.doesNotMatch(s5, /\buid\s*[=:]?\s*1\b/i, `S5 里不该出现裸 uid 形态，实际：${s5}`);
});

/* ═══════════ 3. 端到端：verifyRound 必须把它带出来（不是只有纯函数能算） ═══════════ */

test("R12 ★ verifyRound 的返回里有 reoriented，且 checks 里有一条 ok:true 的读数", async () => {
    const g = FakeGame.fromFiles(L4_PATH, null, { goal: "RuRu----" });
    const beforeObs = structuredClone(g.obs);

    /* 借 L4 里一条真带子，把它扭 90° —— 模拟「游戏重算邻居」的净效果。
       这里**不**改 uid/type，只改 r：那正是 updateSurroundingBeltPlacement 干的。 */
    const victim = g.obs.entities.find(e => e.type === "belt" && Number.isInteger(e.uid));
    assert.ok(victim, "L4 夹具里应当有带子");
    const wantBefore = { r: victim.r, rv: victim.rotation_variant };
    victim.r = ((victim.r | 0) + 90) % 360;
    victim.rotation_variant = ((victim.rotation_variant | 0) + 1) % 3;
    victim.code = undefined;

    /* 一个「成功 tx、但只声明删了一条别的带子」的真实形态。
       关键：victim **不在** destroys 里 —— 所以它只能靠 obs 差集浮出来。 */
    const tx = {
        ok: true, op: "tx", applied: 1, requested: 1,
        rolled_back: false, dry_run: false, aborted: false, failures: [],
        diff: { added: [], removed: [99999], modified: [] },
        net: null, verify: null, rollback: null, results: [],
    };
    const round = await verifyRound({
        reader: g.reader(),
        txPlan: { placements: [], removes: [], destroys: [99999], ops: [{ op: "delete", uid: 99999 }], flows: [] },
        uidMap: {},
        beforeObs,
        mode: "mock",
        goalShape: "RuRu----",
        flows: [],
        tx,
        behavior: false,
        handles: buildHandles(beforeObs, null),
    });

    /* ① 纯函数层算出 1 条 */
    assert.ok(round.reoriented, "verifyRound 必须返回 reoriented（不能只在别处算）");
    assert.equal(round.reoriented.count, 1, `应当算出 1 条被改向，实得 ${JSON.stringify(round.reoriented)}`);
    assert.equal(round.reoriented.items[0].uid, victim.uid, "被改向的应当是那条带子");
    assert.deepEqual(round.reoriented.items[0].before, wantBefore, "改前的 r/rv 必须对");

    /* ② 它必须也进 evidence（transcript 与 prompt 都从这里取） */
    assert.ok(round.evidence.reoriented, "evidence 里也要有一份（verify-last.json 的读数）");

    /* ③ check 存在、**ok:true**（是读数不是批评 —— 判红会让每次正常放置都失败） */
    const chk = round.checks.find(c => c.name === "V-belt-reorient");
    assert.ok(chk, "必须有 V-belt-reorient 这条 check");
    assert.equal(chk.ok, true, "邻居重算本身是正常行为 —— 这条不许判红");
    assert.equal(chk.evidence.reoriented, 1, "check 的 evidence 要报条数");

    /* ④ 不改变 apply 裁决（它不影响「tx 是否干净落盘」） */
    const av = applyVerdict(tx, { requestedOps: 1 });
    assert.equal(av.ok, true, "邻居重算不该让 applyVerdict 变红");
});

test("R13 没有邻居重算时 verifyRound 的 reoriented 是 0（不是缺失）", async () => {
    const g = FakeGame.fromFiles(L4_PATH, null, { goal: "RuRu----" });
    const beforeObs = structuredClone(g.obs);
    /* 什么都不动 —— after 与 before 逐字节相同 */
    const tx = {
        ok: true, op: "tx", applied: 0, requested: 0,
        rolled_back: false, dry_run: false, aborted: false, failures: [],
        diff: { added: [], removed: [], modified: [] },
        net: null, verify: null, rollback: null, results: [],
    };
    const round = await verifyRound({
        reader: g.reader(),
        txPlan: { placements: [], removes: [], destroys: [], ops: [], flows: [] },
        uidMap: {}, beforeObs, mode: "mock", goalShape: "RuRu----", flows: [], tx, behavior: false,
    });
    assert.equal(round.reoriented.count, 0, "没变就该是 0");
    assert.equal(round.reoriented.items.length, 0, "items 也该是空");
    const chk = round.checks.find(c => c.name === "V-belt-reorient");
    assert.ok(chk, "check 仍然要在（「0 条」和「没算」必须长得不一样）");
    assert.equal(chk.evidence.reoriented, 0, "evidence 报 0");
});
