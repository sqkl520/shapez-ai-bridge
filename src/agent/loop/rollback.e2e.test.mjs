/**
 * `rollback.e2e.test.mjs` —— 撤销的**端到端**行为（在 loop 里真的跑）。
 *
 * `rollback.test.mjs` 测的是判据（纯函数）；这个文件测的是**接线**：
 * loop 有没有在 tx 前存检查点、有没有在判定后真的调 restore、
 * 撤销之后世界与记账是否正确。
 *
 * ## 钉住的三个具体回归
 *
 * 1. **检查点必须在 tx 之前存**（名字是 `r<轮号>`）—— 存晚了就等于存了个坏世界。
 * 2. **撤销成功后 `healthBefore` 必须重置**。第一次实现只改了 `healthNow`，
 *    结果下一轮把「撤销」本身算成一次 `constructive`（实测 `177→179(+2) 带子 +2`），
 *    时间线上看起来像「模型又加了两条带子」—— 那是假的，世界只是被我们还原了。
 * 3. **撤销后必须重新 observe 再诊断**，不能带着「坏世界」的诊断继续用它做决策。
 *
 * 运行：`node --test src/agent/loop/rollback.e2e.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "../fake_game.mjs";
import { runLoop, readTranscript } from "../loop.mjs";
import { LLMClient } from "./llm.mjs";
import { buildHandles } from "./handles.mjs";
import { indexOf, flowReachable } from "./topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rb-e2e-"));

class Scripted extends LLMClient {
    constructor(texts) { super(); this.texts = texts; this.n = 0; this.bundles = []; }
    async propose(bundle) {
        this.bundles.push(bundle);
        const t = this.texts[Math.min(this.n, this.texts.length - 1)];
        this.n++;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

const l4 = () => FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });

/**
 * 找两条**能到 hub** 的相邻带子的句柄对 —— 删它们一定让可达率下降（regressive）。
 * 用句柄而不是坐标：`assertNoHumanCoords` 会拒字面坐标。
 */
function liveBeltHandlePairs(g, want = 2) {
    const idx = indexOf(g.obs);
    const reach = flowReachable(g.obs, idx);
    const t = buildHandles(g.obs, null);
    const byCell = new Map(g.obs.entities.map(e => [`${e.x},${e.y}`, e]));
    const pairs = [];
    for (const a of g.obs.entities) {
        if (a.type !== "belt" || !reach.has(a.uid)) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const b = byCell.get(`${a.x + dx},${a.y + dy}`);
            if (!b || b.type !== "belt" || !reach.has(b.uid)) continue;
            const ha = t.byUid.get(a.uid), hb = t.byUid.get(b.uid);
            if (ha && hb) pairs.push([ha, hb]);
            if (pairs.length >= want) return pairs;
        }
    }
    return pairs;
}

const removePair = (h1, h2) => ({
    macro: "remove_run",
    args: { uids: { $uids: [h1, h2] } },
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 检查点
 * ══════════════════════════════════════════════════════════════════════════ */

test("E1 每轮 tx 前存一个检查点，名字是 r<轮号>", async () => {
    const g = l4();
    const [[a, b]] = liveBeltHandlePairs(g, 1);
    const dir = tmpDir();
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([{ say: "remove", calls: [removePair(a, b)] }]),
        goal: "RuRu----", mode: "mock", runDir: dir,
        budget: { ROUNDS_MAX: 2, LLM_CALLS_MAX: 4, TX_MAX: 2, WALL_MS_MAX: 120000 },
    });
    assert.ok(res.checkpoints.includes("r1"), `实得 ${JSON.stringify(res.checkpoints)}`);
    const list = g.checkpointList();
    assert.ok(list.items.some(i => i.name === "r1"));
});

test("E2 ★ 检查点存的是 tx **之前**的世界（实体数对得上）", async () => {
    /* 如果存晚了（tx 之后），快照里就是被改坏的世界 —— 撤销会把它「恢复」成更坏的样子。 */
    const g = l4();
    const n0 = g.obs.entities.length;
    const [[a, b]] = liveBeltHandlePairs(g, 1);
    await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([{ say: "remove", calls: [removePair(a, b)] }]),
        goal: "RuRu----", mode: "mock", runDir: tmpDir(),
        budget: { ROUNDS_MAX: 2, LLM_CALLS_MAX: 4, TX_MAX: 2, WALL_MS_MAX: 120000 },
    });
    const ck = g._checkpoints && g._checkpoints.get("r1");
    assert.ok(ck, "r1 检查点必须存在");
    assert.equal(ck.entities.length, n0, `检查点该有 ${n0} 个实体（tx 之前），实得 ${ck.entities.length}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 判定接线
 * ══════════════════════════════════════════════════════════════════════════ */

test("E3 离线：判定写进 transcript，但世界不动（dry）", async () => {
    const g = l4();
    const [[a, b], [c, d]] = liveBeltHandlePairs(g, 2);
    const dir = tmpDir();
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "remove 1", calls: [removePair(a, b)] },
            { say: "remove 2", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "mock", runDir: dir,
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3, WALL_MS_MAX: 150000, ROLLBACK: true },
    });
    const rows = readTranscript(res.transcript_path);
    const rb = rows.filter(r => r.kind === "repair_decide" && r.data.phase === "rollback");
    assert.ok(rb.length > 0, "必须有 rollback 判定行");
    /* 离线不许真撤 —— 世界必须保留两轮删除的效果 */
    const live = rb.filter(r => r.data.action === "rolled_back");
    assert.equal(live.length, 0, `离线不该真撤销，实得 ${live.length} 次`);
});

test("E4 live：连续破坏 ⇒ 真撤销并写进 rollbacks", async () => {
    const g = l4();
    const pairs = liveBeltHandlePairs(g, 2);
    assert.equal(pairs.length, 2, "夹具里得有两对相邻活带子");
    const [[a, b], [c, d]] = pairs;
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "remove 1", calls: [removePair(a, b)] },
            { say: "remove 2", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 4, LLM_CALLS_MAX: 6, TX_MAX: 4, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 3, TICKS_MAX: 2400 * 8,
        },
    });
    assert.ok(res.rollbacks.length > 0, "live 下连续破坏必须触发撤销");
    const r = res.rollbacks[0];
    assert.equal(r.decision, "rolling_back");
    assert.equal(r.dry, false, "live 不该是 dry");
    assert.equal(r.verified, true, "恢复必须自证通过");
    assert.equal(r.reverted, true);
});

test("E5 ★ 撤销后世界真的回来了（实体数与可达率都回升）", async () => {
    const g = l4();
    const n0 = g.obs.entities.length;
    const reach0 = flowReachable(g.obs, indexOf(g.obs));
    const live0 = g.obs.entities.filter(e => e.type === "belt" && reach0.has(e.uid)).length;
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;

    await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "remove 1", calls: [removePair(a, b)] },
            { say: "remove 2", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 3, TICKS_MAX: 2400 * 8,
        },
    });

    /* 撤销把第二轮删掉的两条带子放回来了 ⇒ 实体数 = 只删了第一轮的 2 条 */
    assert.equal(g.obs.entities.length, n0 - 2,
        `撤销后应剩 ${n0 - 2} 个实体（第一轮的删除被保留），实得 ${g.obs.entities.length}`);
    const reach1 = flowReachable(g.obs, indexOf(g.obs));
    const live1 = g.obs.entities.filter(e => e.type === "belt" && reach1.has(e.uid)).length;
    assert.equal(live1, live0 - 2, `可达带子应回到 ${live0 - 2}，实得 ${live1}`);
});

test("E6 ★ 撤销后本轮记成 reverted，下一轮判 inert（不把撤销算成建设）", async () => {
    /* 回归：第一次实现只重置 healthNow 没重置 healthBefore，
       下一轮把「撤销」算成 `constructive`（实测 177→179 带子 +2）。 */
    const g = l4();
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "remove 1", calls: [removePair(a, b)] },
            { say: "remove 2", calls: [removePair(c, d)] },
            { say: "remove 2 again", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 4, LLM_CALLS_MAX: 6, TX_MAX: 4, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 3, TICKS_MAX: 2400 * 8,
        },
    });
    const kinds = res.net_effects.map(e => e.kind);
    assert.ok(kinds.includes("reverted"), `必须有 reverted，实得 ${JSON.stringify(kinds)}`);
    const idx = kinds.indexOf("reverted");
    const next = kinds[idx + 1];
    assert.ok(next === undefined || next === "inert",
        `撤销之后的一轮必须判 inert（世界没变），实得 "${next}" —— 若为 constructive 说明 healthBefore 没重置`);
});

test("E7 撤销后重新 observe 再诊断（留下 WORLD_REVERTED 标记）", async () => {
    const g = l4();
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;
    const dir = tmpDir();
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "remove 1", calls: [removePair(a, b)] },
            { say: "remove 2", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: dir,
        budget: {
            ROUNDS_MAX: 4, LLM_CALLS_MAX: 6, TX_MAX: 4, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 3, TICKS_MAX: 2400 * 8,
        },
    });
    const rows = readTranscript(res.transcript_path);
    const reverted = rows.filter(r => r.kind === "diagnose"
        && Array.isArray(r.data.codes) && r.data.codes.includes("WORLD_REVERTED"));
    assert.ok(reverted.length > 0, "撤销后必须有一条 WORLD_REVERTED 诊断");

    const rb = rows.find(r => r.kind === "repair_decide" && r.data.phase === "rollback"
        && r.data.action === "rolled_back");
    assert.ok(rb, "必须有一条 rolled_back 的 repair_decide");

    /* 撤销发生在第 N 轮的**轮首**（判完就 continue，进入第 N+1 轮）。
       所以「同一轮号里不许有 propose」—— propose 属于下一轮，轮号不同。
       ⚠️ 不能写 `round >= rb.round`：那会把**之后**那些正常轮次的 propose 也算进来，
       而它们本来就该有。第一次就是这么写错的。 */
    const proposeSameRound = rows.filter(r => r.kind === "propose" && r.round === rb.round);
    assert.equal(proposeSameRound.length, 0,
        `撤销发生在第 ${rb.round} 轮轮首，那一轮不该再问 LLM（世界刚被回退，旧诊断已失效），实得 ${proposeSameRound.length} 次`);

    /* 而下一轮必须正常提问 —— 撤销是「重来」，不是「停手」。 */
    const proposeNext = rows.filter(r => r.kind === "propose" && r.round === rb.round + 1);
    assert.ok(proposeNext.length > 0, "撤销之后的下一轮必须重新问 LLM");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 不该撤销的情形
 * ══════════════════════════════════════════════════════════════════════════ */

test("E8 只破坏一次 ⇒ transient，世界保留那一次的改动", async () => {
    const g = l4();
    const n0 = g.obs.entities.length;
    const [[a, b]] = liveBeltHandlePairs(g, 1);
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([{ say: "remove once", calls: [removePair(a, b)] }]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 2, LLM_CALLS_MAX: 4, TX_MAX: 2, WALL_MS_MAX: 150000,
            ROLLBACK: true, TICKS_MAX: 2400 * 8,
        },
    });
    assert.equal(res.rollbacks.length, 0, "第一次破坏不该撤销（要给模型自修机会）");
    assert.equal(g.obs.entities.length, n0 - 2, "那一次的删除必须保留");
});

test("E9 budget.ROLLBACK=false ⇒ 一次都不撤", async () => {
    const g = l4();
    const n0 = g.obs.entities.length;
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;
    await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "r1", calls: [removePair(a, b)] },
            { say: "r2", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3, WALL_MS_MAX: 150000,
            ROLLBACK: false, TICKS_MAX: 2400 * 8,
        },
    });
    assert.equal(g.obs.entities.length, n0 - 4, "关了撤销就该保留全部删除");
});

test("E10 撤销次数上限生效（不会无限撤）", async () => {
    const g = l4();
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted([
            { say: "r1", calls: [removePair(a, b)] },
            { say: "r2", calls: [removePair(c, d)] },
            { say: "r3", calls: [removePair(c, d)] },
            { say: "r4", calls: [removePair(c, d)] },
        ]),
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 6, LLM_CALLS_MAX: 8, TX_MAX: 6, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 1, TICKS_MAX: 2400 * 12,
        },
    });
    assert.ok(res.rollbacks.length <= 1, `ROLLBACK_MAX=1，实得 ${res.rollbacks.length} 次`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 撤销之后模型看到什么（这一段决定它会不会重复同一个错误）
 * ══════════════════════════════════════════════════════════════════════════ */

test("E11 ★ 撤销之后 prompt 必须说 reverted，且明说「别去修」", async () => {
    /* 为什么这条重要：撤销那一轮不问 LLM（直接 continue），所以模型第一次
       看到反馈是在**下一轮**。而那一轮算出来的 roundNetEffect 必然是 `inert`
       （我们把 healthBefore 也重置了，世界确实没再变）。
       若照实传 inert，模型会得到「我上一轮什么也没干」—— 而真相是「你干了，被否了」。
       这会直接导致它再做一遍同样的动作（实测过：没有反馈时连续三轮同一套宏）。 */
    const g = l4();
    const pairs = liveBeltHandlePairs(g, 2);
    const [[a, b], [c, d]] = pairs;
    const client = new Scripted([
        { say: "remove 1", calls: [removePair(a, b)] },
        { say: "remove 2", calls: [removePair(c, d)] },
        { say: "next", calls: [removePair(c, d)] },
    ]);
    const res = await runLoop({
        reader: g.reader(), game: g, llmClient: client,
        goal: "RuRu----", mode: "live", runDir: tmpDir(),
        budget: {
            ROUNDS_MAX: 4, LLM_CALLS_MAX: 6, TX_MAX: 4, WALL_MS_MAX: 180000,
            ROLLBACK: true, ROLLBACK_MAX: 3, TICKS_MAX: 2400 * 8,
        },
    });
    assert.ok(res.rollbacks.some(r => r.reverted), "前提：这次 run 必须真的撤销过");

    const withStep = client.bundles.filter(b => /## LAST STEP/.test(b.user));
    assert.ok(withStep.length > 0, "必须至少有一轮带 LAST STEP");
    const segs = withStep.map(b => {
        const i = b.user.indexOf("## LAST STEP");
        const j = b.user.indexOf("## LAST ROUND");
        return b.user.slice(i, j > i ? j : undefined);
    });
    const rev = segs.find(s => /your last change: reverted/.test(s));
    assert.ok(rev, `必须有一轮告诉模型 reverted，实际的 LAST STEP：\n${segs.join("\n---\n")}`);
    assert.match(rev, /Do NOT try to repair/, "必须明说「别去修」—— 否则它会把完好的带子再拆一遍");
    assert.match(rev, /UNDONE/, "标签要说清是「已被撤销」");
    /* 而 inert 的措辞（"did not change at all"）不该出现在 reverted 那段里 */
    assert.ok(!/did not change at all/.test(rev), "reverted 段不该退化成 inert 的措辞");
});
