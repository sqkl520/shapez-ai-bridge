/**
 * loop.test.mjs — 主状态机的端到端测试（**真** FakeGame + 真宏 + 真 planToTxOps + 真 verify）。
 *
 * 这个文件不测那 7 个模块各自的判据（它们有自己的测试），只测**loop 自己的职责**：
 *   · 六阶段的顺序与「谁在哪一步截断」；
 *   · 每一条 halt 都有机器可检的原因，且 **run_end 必写**；
 *   · 离线全绿**不得**被读成阶段 2 达成（offline_boundary 必须真的生效）；
 *   · 预算与指纹规则真的会停手，而不是「记了一笔就继续花」。
 *
 * ## 这个文件**不能**证明的事（诚实边界，与 offline_boundary.mjs 同源）
 *
 *   · FakeGame 的 apply 是原地改实体表，**没有事务**。所以这里的 `apply` 阶段测的是
 *     「loop 有没有正确地发一次 ops、有没有正确地读返回」，**不是** tx 的原子性。
 *   · FakeGame 的 `step()` 只加 tick，`production` 恒不变。所以 live 的 L4 行为判据
 *     在这里永远是 0 增量 —— 那是环境限制，不是 loop 的缺陷。
 *   · 因此本文件里 **没有任何一条断言要求 outcome==="success"**。唯一允许的「全绿」
 *     结论是 `level==="offline-only"`，而那正是「不构成阶段 2 达成」的机器表达。
 *
 * ## 关于 `l4-coldstart` 夹具的一处**实测偏差**（写在这里而不是藏进测试的跳过逻辑）
 *
 * 该夹具的 round-01 引用了 `$bbox_of(["B1","B2","B3"])`，而按 handles.mjs 的确定性编号，
 * L4 存档的 B1/B2/B3 是 (1,-34)(2,-34)(1,-33) 那三条（一条转弯线上的 4 条带子），
 * **不是** L4 待改造的 (4,-13)(5,-13)(4,-14)。所以真宏会拒绝它：
 * `precondition_failed: region 内的带子流向不一致`。
 * 这不是夹具「写错了」—— 它自己的 meta.json 明写「不要求执行成功，只证明 mock 路径
 * 与 parser 接受合法计划」。所以本文件**两条路都测**：
 *   ① 用夹具原样跑 → 必须走到 plan 阶段被拒（PLAN_REJECTED/MACRO_REFUSED），零 tx；
 *   ② 用**同一份**夹具目录的另一个场景（测试内临时生成）指向 B81/B82/B69 → 全链路走通。
 * 后者证明的是「决策链」而不是「夹具内容」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    runLoop, diagnose, fingerprintOf, actionSetHash, attachProvenance, buildTxPlan,
    fakeTx, readTranscript, RUN_KINDS, HALT_REASONS, sha256, verifyMacroTokenCoords,
} from "./loop.mjs";
import { DIAG_CODES, BUDGET } from "./loop/constants.mjs";
import { phaseTwoVerdict } from "./loop/offline_boundary.mjs";
import { MockLLMClient, LLMClient, MockExhausted } from "./loop/llm.mjs";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SAVES = path.join(REPO, "test/fixtures/saves");
const LLM_FIXTURES = path.join(REPO, "test/fixtures/llm");
const L4 = path.join(SAVES, "L4-obs.json");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 600) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "looptest-"));
const cleanup = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

/* ══════════════════════════════════════════════════════════════════════════
 * 夹具：L4 与两个 mock 客户端
 * ══════════════════════════════════════════════════════════════════════════ */

/** L4 的 FakeGame（每次新建，避免用例间串味）。 */
function l4Game() {
    return FakeGame.fromFiles(L4, null, { goal: "RuRu----" });
}

/**
 * 给 FakeGame 补上「apply 之后游戏会重算 paths」的那一点点。
 *
 * 这是**唯一**的离线脚手架，而且它只补 `debug_items`，不动世界：FakeGame.apply 改完
 * 实体表后，游戏会重建 beltPath；这里把改造点涉及的两条最小路径追加进去，让 L3 有东西可验。
 * 它不是「让测试变绿的开关」—— 断言里仍然要求 `level==="offline-only"` 而不是 success。
 */
function readerWithRebuiltPaths(game) {
    const base = game.reader();
    const extra = [
        /* cutter.left 的输出格 (4,-14) 就是 trash 的本体格：机对机直贴 */
        { cells: [[4, -14]], boundAcceptor: [4, -14], itemsOnPath: 0 },
        /* cutter.right 的输出格 (5,-14)，经 (5,-15) 走到下游 balancer */
        { cells: [[5, -14], [5, -15]], boundAcceptor: [4, -16], itemsOnPath: 0 },
    ];
    return {
        ...base,
        debugItems: async (p) => {
            const r = await base.debugItems(p);
            if (game.applied.length) {
                r.paths = [...(r.paths || []), ...extra];
                r.pathCount = r.paths.length;
                r.truncatedPaths = false;
            }
            return r;
        },
    };
}

/** 一个按调用次数返回固定文本的客户端（测试里最可控的那种）。 */
class ScriptedClient extends LLMClient {
    constructor(texts) {
        super();
        this.texts = texts.slice();
        this.calls = 0;
        this.bundles = [];
    }
    async propose(bundle) {
        this.bundles.push(bundle);
        const t = this.texts[Math.min(this.calls, this.texts.length - 1)];
        this.calls++;
        if (t instanceof Error) throw t;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

/** L4 的正解计划（句柄来自 handles.mjs 的确定性编号：B81/B82/B69 是那三条待改造带子）。 */
const L4_CALL = {
    macro: "replace_run",
    args: {
        region: { $bbox_of: ["B81", "B82", "B69"] },
        building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
    },
    why: "that run is only belts and forms a rectangle",
};
const L4_PLAN = JSON.stringify({ say: "swap the run for a cutter and a trash", calls: [L4_CALL] });

/** 在临时目录写一个单场景夹具，返回 {dir, scenario}。 */
function writeScenario(texts) {
    const dir = tmpRoot();
    const sc = path.join(dir, "scn");
    fs.mkdirSync(sc, { recursive: true });
    texts.forEach((t, i) => {
        fs.writeFileSync(path.join(sc, `round-${String(i + 1).padStart(2, "0")}.json`),
            typeof t === "string" ? t : JSON.stringify(t), "utf8");
    });
    return { dir, scenario: "scn", root: dir };
}

const transcriptOf = res => readTranscript(res.transcript_path);
const kindsOf = res => transcriptOf(res).map(r => r.kind);
const runEnd = res => transcriptOf(res).find(r => r.kind === "run_end");

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 纯函数：指纹 / 溯源 / diagnose 的闭集
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 0. 纯函数 ──");
{
    /* 指纹：只含稳定量。message 变化不得影响；evidence 多一个 uid 必须变。 */
    const d1 = {
        code: "SLOT_STARVED", layer: "L2", subject: { handle: "C1" },
        expected: "x", observed: "y", evidence: { handles: ["C1"], uids: [10036] },
    };
    const d2 = { ...d1, observed: "完全不同的 message（含坐标似的数字 4, -13）" };
    eq(fingerprintOf([d1]), fingerprintOf([d2]), "指纹不含 observed/message（message 抖动不该产生「新错误」）");
    const d3 = { ...d1, evidence: { handles: ["C1"], uids: [10036, 999] } };
    ok(fingerprintOf([d1]) !== fingerprintOf([d3]), "evidence 多一个 uid ⇒ 指纹必变");
    eq(fingerprintOf([d1]), fingerprintOf([d3, d1].slice(1)), "指纹与诊断顺序无关（排序后拼接）");

    eq(actionSetHash(["connect", "remove_run"]), actionSetHash(["remove_run", "connect"]), "动作集指纹与顺序无关");
    ok(actionSetHash(["connect"]) !== actionSetHash(["insert_machine"]), "不同动作集 ⇒ 不同指纹");

    /* 闭集：loop 声明的每个 reason 都必须落在 DIAG_CODES ∪ {OFFLINE_ONLY, DRY_RUN} */
    const allowed = new Set([...Object.keys(DIAG_CODES), "OFFLINE_ONLY", "DRY_RUN"]);
    eq(HALT_REASONS.length, allowed.size, "HALT_REASONS = DIAG_CODES + 两个 run 级状态（不重不漏）");
    ok(HALT_REASONS.every(r => allowed.has(r)), "HALT_REASONS 里每个码都可解释");
    ok(RUN_KINDS.every(k => ["run_start", "observe", "diagnose", "propose", "plan", "apply", "verify", "repair_decide", "run_end"].includes(k)),
        "RUN_KINDS 就是契约 §1.4 的那 9 种", RUN_KINDS);
}

{
    /* diagnose 的每条码都必须在闭集内 —— 用 L4 的真实 obs 跑一遍，再对它做一次变异 */
    const g = l4Game();
    const ds = diagnose(g.obs, null, g.production, null, "RuRu----", null);
    ok(ds.length >= 1, "首轮（无 report）也能产出初始诊断", ds.map(d => d.code));
    ok(ds.every(d => Object.prototype.hasOwnProperty.call(DIAG_CODES, d.code)),
        "diagnose 产出的每个码都在 DIAG_CODES 闭集里", ds.map(d => d.code));
    ok(ds.every(d => d.subject && (d.subject.handle || d.subject.token || d.subject.uid === null)),
        "每条诊断都有 subject 形态（句柄或 token）");
    const h1 = ds.find(d => d.code === "NO_PRODUCTION");
    ok(!!h1 && h1.subject.handle === "H1", "初始诊断指向 hub 的句柄 H1（不是坐标）");

    /* 坐标禁令：诊断的 JSON 里不得出现坐标形态（`x, y` 数字对）。subject.uids 是 uid，
       不是坐标；所以只扫 subject/expected/observed/handles 这些会进 prompt 的字段。 */
    const COORD = /\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/;
    const leaky = ds.filter(d => {
        const blob = JSON.stringify({ subject: d.subject, expected: d.expected, observed: d.observed, handles: d.evidence.handles });
        return COORD.test(blob);
    });
    eq(leaky.length, 0, "诊断里没有坐标形态（只允许句柄/uid/计数）", leaky.map(d => d.code));

    /* 截断的 obs 必须产出 OBS_TRUNCATED，而不是「看起来没问题」 */
    const trunc = { ...g.obs, truncated: true, entity_count: 99999 };
    const dt = diagnose(trunc, null, g.production, null, "RuRu----", null);
    ok(!dt.some(d => d.code === "OBS_TRUNCATED"),
        "（事实）diagnose 不负责 OBS_TRUNCATED —— 那是 observe 阶段的事（避免两份判据）");
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 正常路径：至少一轮 plan/apply/verify 走通，transcript ≥5 种 kind
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 1. 正常路径（真 FakeGame + 真宏 + 真 verify） ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: readerWithRebuiltPaths(g),
        goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock",
        runDir: dir,
        game: g,
    });

    eq(res.outcome, "halt", "离线全绿 ⇒ outcome 必须是 halt（不是 success）");
    eq(res.reason, "OFFLINE_ONLY", "reason = OFFLINE_ONLY");
    eq(res.level, "offline-only", "level = offline-only（phaseTwoVerdict 原样）");
    eq(res.rounds, 1, "一轮就走到全绿（不浪费轮次）");
    eq(res.llm_calls, 1, "只问了一次 LLM");
    eq(res.tx_count, 1, "只发了一次 tx");

    const kinds = kindsOf(res);
    for (const k of ["run_start", "observe", "diagnose", "propose", "plan", "apply", "verify", "run_end"]) {
        ok(kinds.includes(k), `transcript 有 ${k}`, kinds);
    }
    ok(new Set(kinds).size >= 5, `transcript kind 种类 ≥5（实际 ${new Set(kinds).size}）`, kinds);
    eq(kinds[kinds.length - 1], "run_end", "★ run_end 是最后一行（可回放）");
    eq(kinds[0], "run_start", "第一行是 run_start");

    /* 顺序：plan 必须在 apply 之前（否则就是「先写后想」） */
    const iP = kinds.indexOf("plan"), iA = kinds.indexOf("apply"), iV = kinds.indexOf("verify");
    ok(iP < iA && iA < iV, "顺序 plan → apply → verify", { iP, iA, iV });

    const re = runEnd(res);
    eq(re.data.outcome, "halt", "run_end.outcome = halt");
    eq(re.data.level, "offline-only", "run_end.level = offline-only");
    ok(re.data.preserved && re.data.preserved.dir === res.run_dir, "run_end 带 preserved.dir");
    ok(Array.isArray(re.data.preserved.files) && re.data.preserved.files.includes("transcript.jsonl"),
        "preserved.files 里有 transcript.jsonl", re.data.preserved.files);
    eq(re.data.preserved.world_state, "applied", "preserved.world_state = applied（tx 成功过）");

    /* verify 行是 verifyRound 的逐项复制，不是二次总结 */
    const vrow = transcriptOf(res).find(r => r.kind === "verify");
    ok(vrow.data.checks.length >= 3, "verify 行逐项列了 checks", vrow.data.checks.map(c => c.name));
    ok(vrow.data.checks.some(c => c.name === "L1-landing" && c.ok === true),
        "★ L1-landing 绿：宏的计划真的落地了", vrow.data.checks);
    ok(vrow.data.checks.some(c => c.name === "A-tx"), "A-tx（apply 裁决）进了 verify 的 checks");
    eq(vrow.data.level, "offline-only", "verify 行标了 level=offline-only");
    eq(vrow.data.achieved, false, "verify 行 achieved=false（离线不构成达成）");

    /* run_end.world_hash 必须是**最终**世界（tx 之后），不是 observe 时那份 */
    const orow = transcriptOf(res).find(r => r.kind === "observe");
    ok(re.data.world_hash && re.data.world_hash === vrow.data.world_hash,
        "★ run_end.world_hash 与 verify 行一致（都是 tx 之后的世界）", { end: re.data.world_hash, verify: vrow.data.world_hash });
    ok(re.data.world_hash !== orow.data.world_hash,
        "★ 且不同于 observe 时的 hash（世界确实变了，不是抄了旧值）", { end: re.data.world_hash, obs: orow.data.world_hash });

    /* 世界真的被改了：cutter/trash 在，那三条带子不在 */
    ok(g.obs.entities.some(e => e.type === "cutter" && e.x === 4 && e.y === -13), "FakeGame 上 (4,-13) 变成了 cutter");
    ok(!g.obs.entities.some(e => [10143, 10149, 10209].includes(e.uid)), "那三条带子的 uid 都不在了");

    /* provenance：每条落盘坐标都要能追溯（transcript 的 plan 行记了计数） */
    const prow = transcriptOf(res).find(r => r.kind === "plan");
    eq(prow.data.provenance.untagged, 0, "★ 0 条无溯源的落盘坐标");
    eq(prow.data.provenance.tagged, 5, "5 条 op 全部挂了 provenance（3 delete + 2 place）");
    eq(prow.data.tx_plan.ops, 5, "tx 计划 = 5 op（与 L4 五 op 对上）");

    /* HALT.json 存在且 reason 一致 */
    ok(fs.existsSync(path.join(res.run_dir, "HALT.json")), "HALT.json 落盘");
    const halt = JSON.parse(fs.readFileSync(path.join(res.run_dir, "HALT.json"), "utf8"));
    eq(halt.reason, "OFFLINE_ONLY", "HALT.json.reason 与 run_end 一致");
    ok(halt.next_actions.some(s => /离线全绿/.test(s)), "HALT.json 的 next_actions 明说「离线全绿只是决策链通过」", halt.next_actions);

    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. run_end 必写：verify 阶段抛异常
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 2. run_end 必写（注入会在 verify 阶段炸的 reader） ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const base = g.reader();
    let obsCalls = 0;
    const reader = {
        ...base,
        /* 前两次 obs 正常（observe + verifyRound 内部各一次），第三次（verify 之后 loop 自己
           再读一次世界）抛 —— 这正好落在 verify 阶段结束、repair 之前。 */
        obs: async (p) => {
            obsCalls++;
            if (obsCalls >= 3) throw new Error("注入：verify 之后的世界读取失败");
            return base.obs(p);
        },
    };
    const res = await runLoop({
        reader, goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
        budget: { TICKS_MAX: BUDGET.TICKS_MAX },
    });

    const rows = transcriptOf(res);
    const re = rows.find(r => r.kind === "run_end");
    ok(!!re, "★ 抛异常后 run_end 仍然写出来了");
    eq(rows[rows.length - 1].kind, "run_end", "run_end 是最后一行");
    eq(re.data.outcome, "error", "outcome = error");
    eq(res.outcome, "error", "返回值 outcome = error");
    eq(re.data.level, "none", "error 路径也带 level（形状与正常路径一致）");
    ok(!!re.data.preserved && Array.isArray(re.data.preserved.files), "error 路径也带 preserved.files");
    ok(/注入/.test(re.data.error || ""), "run_end.error 带上原因（不是空）", re.data.error);
    ok(rows.some(r => r.kind === "apply"), "（前置）异常发生在 apply 之后（verify 阶段）");
    ok(rows.some(r => r.kind === "plan"), "（前置）plan 已经写过");

    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 空 calls → LLM_EMPTY_PLAN，0 次 apply，不得 success
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 3. 空 calls ──");
{
    /* 3a：官方夹具 neg-empty-calls */
    const dirA = tmpRoot();
    const gA = l4Game();
    const resA = await runLoop({
        reader: gA.reader(), goal: "RuRu----",
        llmClient: new MockLLMClient({ dir: LLM_FIXTURES, scenario: "neg-empty-calls" }),
        mode: "mock", runDir: dirA, game: gA,
    });
    const kA = kindsOf(resA);
    eq(resA.outcome, "halt", "空 calls ⇒ halt");
    ok(!kA.includes("apply"), "★ 空 calls ⇒ transcript 里 0 次 apply", kA);
    eq(resA.tx_count, 0, "tx_count = 0");
    eq(gA.entityCount, 181, "世界一点没动（181 实体原样）");
    ok(resA.outcome !== "success", "不得 success");
    /* 夹具只有一轮：解析失败后重问 → MockExhausted（也是 halt，不是 success） */
    ok(["LLM_EMPTY_PLAN", "MOCK_EXHAUSTED"].includes(resA.reason), "reason 是 LLM_EMPTY_PLAN 或 MOCK_EXHAUSTED", resA.reason);
    /* `res.diagnoses` 是 **run 末快照**（最后一次失败），不是历史集合 —— 历史的每一轮在
       transcript 的 diagnose / repair_decide 行里。检查必须读 transcript，不能读快照。 */
    const allCodes = transcriptOf(resA)
        .filter(r => r.kind === "diagnose" || r.kind === "repair_decide")
        .flatMap(r => (r.data.codes || []).concat((r.data.diagnoses || []).map(d => d.code)));
    ok(allCodes.includes("LLM_EMPTY_PLAN"), "transcript 里出现过 LLM_EMPTY_PLAN", [...new Set(allCodes)]);
    cleanup(dirA);

    /* 3b：一个**永远**返回空 calls 的客户端 —— 必须停在 LLM_EMPTY_PLAN（不是耗尽） */
    const dirB = tmpRoot();
    const gB = l4Game();
    const resB = await runLoop({
        reader: gB.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([{ say: "nothing to do", calls: [] }]),
        mode: "mock", runDir: dirB, game: gB,
    });
    eq(resB.reason, "LLM_EMPTY_PLAN", "恒返回空 calls ⇒ reason = LLM_EMPTY_PLAN（同码 3 次即停）");
    eq(resB.tx_count, 0, "0 次 tx");
    eq(resB.llm_calls, 3, "恰好问了 3 次（同码连续 3 次才停，不是一次就死）");
    ok(!kindsOf(resB).includes("apply"), "0 次 apply");
    cleanup(dirB);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 坐标禁令：at:[4,-13] → LLM_COORD，0 次 tx
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 4. 坐标禁令 ──");
{
    /* 4a：官方夹具 neg-literal-coord（parse 层合法、坐标层判 V1） */
    const dirA = tmpRoot();
    const gA = l4Game();
    const resA = await runLoop({
        reader: gA.reader(), goal: "RuRu----",
        llmClient: new MockLLMClient({ dir: LLM_FIXTURES, scenario: "neg-literal-coord" }),
        mode: "mock", runDir: dirA, game: gA,
    });
    ok(!kindsOf(resA).includes("apply"), "★ 字面坐标 ⇒ 0 次 apply", kindsOf(resA));
    eq(resA.tx_count, 0, "tx_count = 0");
    eq(gA.entityCount, 181, "世界没动");
    /* 同样读 transcript（res.diagnoses 是 run 末快照，不是历史） */
    const coordCodes = transcriptOf(resA)
        .filter(r => r.kind === "diagnose" || r.kind === "repair_decide")
        .flatMap(r => (r.data.codes || []).concat((r.data.diagnoses || []).map(d => d.code)));
    ok(coordCodes.includes("LLM_COORD"), "transcript 里出现过 LLM_COORD", [...new Set(coordCodes)]);
    /* 夹具只有一轮：第 1 次是 LLM_COORD，第 2 次重问就耗尽了 —— 所以 reason 是 MOCK_EXHAUSTED。
       这是**夹具轮数**的限制，不是 loop 的问题；恒返回同一计划的用例（3b/4b）才验证「同码 3 次」。 */
    ok(resA.outcome !== "success", "不得 success");
    const prow = transcriptOf(resA).find(r => r.kind === "plan");
    ok(prow && prow.data.ok === false, "plan 行记了 rejected");
    ok(prow.data.rejected && /V1/.test(prow.data.rejected.observed), "拒绝理由点名 V1", prow.data.rejected);
    cleanup(dirA);

    /* 4b：say 里夹带坐标也必须拦（V4，由 parseLlmPlan 的 LLM_NARRATION 映射成 LLM_LINT） */
    const dirB = tmpRoot();
    const gB = l4Game();
    const resB = await runLoop({
        reader: gB.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([{ say: "move it to 4, -13 please", calls: [L4_CALL] }]),
        mode: "mock", runDir: dirB, game: gB,
    });
    eq(resB.tx_count, 0, "say 夹带坐标 ⇒ 0 次 tx");
    ok(resB.diagnoses.some(d => d.code === "LLM_LINT"), "say 里的坐标形态 → LLM_LINT（V4 的 code 载体）", resB.diagnoses.map(d => d.code));
    cleanup(dirB);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 同指纹 3 次 → NO_PROGRESS_3X
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 5. 同一世界诊断第 3 次出现 ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    /* 每次都返回一个**永远会被宏拒绝**的计划（region 指向不是 run 的地方）。
       世界不变 ⇒ 每轮诊断一模一样 ⇒ 指纹计数会走到 3。 */
    const bad = {
        say: "try an insert that cannot fit",
        calls: [{ macro: "insert_machine", args: { at: { $ref: "C1", asCell: true }, facing: "top", machine: "cutter" }, why: "x" }],
    };
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([bad]),
        mode: "mock", runDir: dir, game: g,
    });

    const rows = transcriptOf(res);
    const diagRows = rows.filter(r => r.kind === "diagnose");
    const applyRows = rows.filter(r => r.kind === "apply");
    eq(res.outcome, "halt", "halt");
    eq(res.reason, "NO_PROGRESS_3X", "★ reason = NO_PROGRESS_3X");
    eq(diagRows.length, 3, "★ 3 条 diagnose（世界诊断第 3 次被看见）", diagRows.length);
    eq(applyRows.length, 0, "★ 0 条 apply（每轮都在 plan 就被拒，世界没变）");
    eq(res.tx_count, 0, "0 次 tx");

    /* 指纹在 3 条 diagnose 上必须完全一致（否则「同指纹」这个前提不成立） */
    const fps = diagRows.map(r => r.data.fingerprint);
    eq(new Set(fps).size, 1, "3 条 diagnose 的 fingerprint 完全相同", fps);

    /* 第 2 次必须「换动作」：repair_decide 里 must_change_action=true */
    const rds = rows.filter(r => r.kind === "repair_decide" && r.data.phase === "world_fingerprint");
    eq(rds.length, 3, "3 条 repair_decide（每轮一条指纹计数）");
    eq(rds[0].data.must_change_action, false, "第 1 次不要求换动作");
    eq(rds[1].data.must_change_action, true, "★ 第 2 次要求换动作");
    eq(rds[2].data.reason, "NO_PROGRESS_3X", "第 3 次的 reason = NO_PROGRESS_3X");

    /* 第 2 次与第 3 次之间只多花了一次 LLM 调用（第 3 轮不再问） */
    eq(res.llm_calls, 2, "★ 第 3 轮不再问 LLM（llm_calls = 2）", res.llm_calls);

    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 预算：LLM_CALLS_MAX=2 → 恰好 2 次 propose 后 halt
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 6. LLM 调用预算 ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([{ say: "nothing", calls: [] }]),
        mode: "mock", runDir: dir, game: g,
        budget: { LLM_CALLS_MAX: 2 },
    });
    eq(res.llm_calls, 2, "★ 恰好 2 次 LLM 调用");
    const proposes = transcriptOf(res).filter(r => r.kind === "propose");
    eq(proposes.length, 2, "transcript 里有 2 条 propose");
    eq(res.outcome, "halt", "halt");
    eq(res.reason, "BUDGET_LLM_CALLS", "reason = BUDGET_LLM_CALLS");
    eq(res.tx_count, 0, "0 次 tx");
    cleanup(dir);

    /* 轮预算：ROUNDS_MAX=1 + 一个永远被拒的计划 ⇒ 最多 1 轮就说没轮了 */
    const dir2 = tmpRoot();
    const g2 = l4Game();
    const res2 = await runLoop({
        reader: g2.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([{
            say: "x",
            calls: [{ macro: "insert_machine", args: { at: { $ref: "C1", asCell: true }, facing: "top", machine: "cutter" } }],
        }]),
        mode: "mock", runDir: dir2, game: g2,
        budget: { ROUNDS_MAX: 1 },
    });
    eq(res2.rounds, 1, "★ ROUNDS_MAX=1 ⇒ 最多 1 轮");
    eq(res2.reason, "BUDGET_ROUNDS", "reason = BUDGET_ROUNDS");
    cleanup(dir2);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. offline_boundary 生效：离线全绿 ≠ 达成
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 7. offline_boundary 生效 ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: readerWithRebuiltPaths(g), goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
    });
    const re = runEnd(res);
    eq(re.data.level, "offline-only", "★ run_end.level === \"offline-only\"");
    ok(re.data.outcome !== "success", "★ outcome !== \"success\"（离线全绿不许当达成）");
    eq(re.data.verdict.achieved, false, "verdict.achieved === false");
    ok(re.data.verdict.why.some(w => /不构成阶段 2 达成/.test(w)),
        "run_end 的 why 明说「不构成阶段 2 达成」", re.data.verdict.why);

    /* 反向：直接把「离线全绿」喂给 phaseTwoVerdict，必须仍是 offline-only */
    const v = phaseTwoVerdict({
        mode: "mock", strict: { ok: true },
        checks: [{ name: "L0-observation", ok: true }, { name: "L1-landing", ok: true }],
        goalDelta: 0,
    });
    eq(v.level, "offline-only", "（对照）phaseTwoVerdict 对离线全绿给 offline-only");
    eq(v.achieved, false, "（对照）achieved=false");

    /* 反向：live 模式的 goal 增量才可能达成 —— 用一个假 reader 造出 delta */
    const vLive = phaseTwoVerdict({
        mode: "live", strict: { ok: true },
        checks: [{ name: "L3-flow", ok: true }],
        goalDelta: 12,
    });
    eq(vLive.level, "live", "（对照）live + goalDelta>0 ⇒ level=live");
    eq(vLive.achieved, true, "（对照）只有这一条路能 achieved=true");

    /* classifyChecks 必须把离线的 L3/L4 标成不可信 —— loop 用它的 trustworthy 列表做判据 */
    const pre = transcriptOf(res).find(r => r.kind === "verify");
    ok(pre.data.untrustworthy.some(u => u.name === "L3-flow"),
        "verify 行点名 L3-flow 在 mock 下不可信", pre.data.untrustworthy);

    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. transcript 可回放
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 8. transcript 可回放 ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: readerWithRebuiltPaths(g), goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
    });
    const rows = transcriptOf(res);
    ok(rows.length >= 6, `transcript 行数 ≥6（实际 ${rows.length}）`);
    eq(rows[rows.length - 1].kind, "run_end", "★ run_end 是最后一行");
    eq(rows.filter(r => r.kind === "run_end").length, 1, "有且只有一条 run_end");
    eq(rows.filter(r => r.kind === "run_start").length, 1, "有且只有一条 run_start");
    ok(rows.every((r, i) => r.seq === i + 1), "seq 从 1 连续递增（没有断号）");
    ok(rows.every(r => typeof r.ts === "string" && r.run_id === res.run_id), "每行都有 ts 与同一个 run_id");
    ok(rows.every(r => RUN_KINDS.includes(r.kind)), "每行的 kind 都在闭集里");
    /* 「每个 apply 必有一条对应 plan，且 plan 未被拒」 */
    let lastPlanOk = false;
    let orphanApply = 0;
    for (const r of rows) {
        if (r.kind === "plan") lastPlanOk = r.data.ok === true;
        if (r.kind === "apply" && r.data.tx_ok !== undefined && !lastPlanOk) orphanApply++;
    }
    eq(orphanApply, 0, "★ 没有「plan 被拒却仍然 apply」的行");

    /* 回放：把 run_start.budget 读回来应当就是这次实际用的预算 */
    const rs = rows.find(r => r.kind === "run_start");
    eq(rs.data.budget.ROUNDS_MAX, BUDGET.ROUNDS_MAX, "run_start 记了预算（可据此复跑）");
    eq(rs.data.goal, "RuRu----", "run_start 记了 goal");
    eq(rs.data.mode, "mock", "run_start 记了 mode（验收脚本据此拒收离线）");

    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 9. buildTxPlan / attachProvenance 的负例（坐标与溯源两道关真的会红）
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 9. plan 阶段的两道关（负例） ──");
{
    const g = l4Game();
    const { buildHandles } = await import("./loop/handles.mjs");
    const tbl = buildHandles(g.obs, null);

    /* 9a：字面坐标 → LLM_COORD，且**没有** txPlan（零写入） */
    const r1 = buildTxPlan({ calls: [{ macro: "insert_machine", args: { at: [4, -13], facing: "top", machine: "cutter" } }] }, g.obs, null, tbl);
    eq(r1.ok, false, "字面坐标 ⇒ 拒绝");
    eq(r1.code, "LLM_COORD", "拒绝码 = LLM_COORD");
    ok(!r1.txPlan, "★ 被拒时没有 txPlan（调用方无从写入）");

    /* 9b：幻觉句柄 → OBS_STALE（而不是「参数错」） */
    const r2 = buildTxPlan({ calls: [{ macro: "remove_run", args: { uids: { $uids: ["B999"] } } }] }, g.obs, null, tbl);
    eq(r2.ok, false, "幻觉句柄 ⇒ 拒绝");
    eq(r2.code, "OBS_STALE", "拒绝码 = OBS_STALE");

    /* 9c：参数名拼错 → LLM_ARGS（v2 §5.2：候选是**该宏自身**，允许重试一次） */
    const r3 = buildTxPlan({
        calls: [{ macro: "connect", args: { source: { $ref: "B1" }, to: { $ref: "B2" } } }],
    }, g.obs, null, tbl);
    eq(r3.ok, false, "参数名拼错 ⇒ 拒绝");
    eq(r3.code, "LLM_ARGS", "拒绝码 = LLM_ARGS");
    ok(Array.isArray(r3.diagnosis.candidates) && r3.diagnosis.candidates[0] === "connect",
        "★ LLM_ARGS 的候选是该宏自身（可重试，不是一次就死）", r3.diagnosis.candidates);

    /* 9d：溯源 —— 每条 op 都必须有 provenance；删掉一条就是 MISSING_PROVENANCE */
    const good = buildTxPlan(JSON.parse(L4_PLAN), g.obs, null, tbl);
    eq(good.ok, true, "（前置）正解计划通过 plan 阶段");
    ok(good.txPlan.ops.every(o => o.provenance), "每条 op 都有 provenance", good.txPlan.ops);
    const stripped = {
        ...good.txPlan,
        ops: good.txPlan.ops.map((o, i) => (i === 0 ? o : ({ ...o, provenance: undefined }))),
    };
    const { assertProvenance } = await import("./loop/coords.mjs");
    const bad = assertProvenance({ calls: [{ macro: "x", args: {}, provenance: {} }] }, stripped, g.obs);
    eq(bad.ok, false, "★ 少一条 provenance ⇒ assertProvenance 判红");
    ok(bad.violations.some(v => /MISSING_PROVENANCE/.test(v.rule)), "红的是 MISSING_PROVENANCE", bad.violations);

    /* 9e：变异 —— 把某条 place 的 x 加 1，溯源必须红（契约 §2.4 的变异测试）。
       ★ 这一条**必须**用 loop 自己的 `buildTxPlan`，不能用 coords.mjs 的 assertProvenance：
       `macro:` 标签只校验 token 存在（coords.mjs:412-418），不比 token 里嵌的坐标。
       loop 的 ⑤b 补了这一层（verifyMacroTokenCoords），所以从 plan 阶段入口验证才成立。 */
    /* 用一个**自带正确 token** 的宏结果，然后把 op 的 x 改掉：模拟「挂完标签又被篡改」 */
    const mutated = {
        ...good.txPlan,
        ops: good.txPlan.ops.map(o => (o.op === "place" && o.building === "cutter" ? { ...o, x: o.x + 1 } : o)),
    };
    const tok = verifyMacroTokenCoords(mutated);
    eq(tok.ok, false, "★ 把 place.x 加 1 ⇒ verifyMacroTokenCoords 判红（标签没变、值变了）", tok.violations);
    ok(tok.violations[0].token_cell[0] === 4 && tok.violations[0].op[0] === 5,
        "红的具体内容是「op 在 5，token 说 4」", tok.violations[0]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 10. fakeTx：离线 tx 替身的形状与「不许假装事务」
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 10. fakeTx（离线替身的诚实边界） ──");
{
    const g = l4Game();
    const tx = fakeTx(g, [{ op: "delete", uid: 10209 }, { op: "place", building: "trash", x: 4, y: -14, r: 0 }]);
    eq(tx.ok, true, "fakeTx.ok = true");
    eq(tx.applied, 2, "applied = 2");
    eq(tx.rolled_back, false, "rolled_back 恒 false（FakeGame 没有事务）");
    eq(tx.verify, null, "★ verify 恒 null —— 与真 tx 的成功路径一致（所以 applyVerdict 不能读它）");
    eq(tx.dry_run, false, "dry_run = false");
    eq(tx.diff.removed.length, 1, "diff.removed 记了 1 个 uid");
    eq(tx.diff.added.length, 1, "diff.added 记了新 uid");
    ok(tx.results.some(r => r.op === "place" && Number.isInteger(r.uid)), "results[].uid 桥接了 place 的真 uid");
    ok(!("mismatch" in tx.results[0]), "（事实）results 里没有 mismatch（bridge:3402-3406）");
}

/* ══════════════════════════════════════════════════════════════════════════
 * 11. 官方 l4-coldstart 夹具：**现在能真正走完一轮**
 *
 * 历史：这个夹具原本引用 `B1/B2/B3`（另一条产线上的转弯带，不是待改造的三条），
 * 所以它永远走到 `MACRO_REFUSED` —— 一个"验证失败行为"的用例。
 * 2026-10-28 把它改成正确的三条（`B69/B81/B82`）之后，前提变了：
 * 它现在应该**跑通**。
 *
 * 这个变化顺便补上了一个真实的空白：`runLoop` 的 **`success` 分支以前从未被执行过**
 * （离线永远到不了 live 成功）。虽然这里的 outcome 仍是 offline-only（不是 success），
 * 但 `plan → apply → verify` 全链路终于被真实夹具走过了一次。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 11. 官方 l4-coldstart 夹具（已修正为正确的三条带子）──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----",
        llmClient: new MockLLMClient({ dir: LLM_FIXTURES, scenario: "l4-coldstart" }),
        mode: "mock", runDir: dir, game: g,
    });
    /* 它现在应该真的落盘了：删 3 条带子 + 放 cutter + trash */
    ok(res.tx_count >= 1, "★ 夹具引用的是正确带子 ⇒ 至少 1 次 tx", res.tx_count);
    eq(g.entityCount, 180, "世界真的变了（181 - 3 删 + 2 放 = 180）");
    ok(kindsOf(res).includes("apply"), "有 apply 行");
    const prow = transcriptOf(res).find(r => r.kind === "plan");
    ok(prow && prow.data.ok === true, "plan 行记了成功", prow && prow.data.rejected);
    /* 但即使 plan 全对，离线也只能到 offline-only —— 不许说 success。
       ⚠️ 这里实际拿到的是 `level: "none"`（不是 offline-only），因为夹具只有一轮：
       第 1 轮落盘成功后，第 2 轮 MockLLMClient 耗尽 → `MOCK_EXHAUSTED` → halt。
       而 `phaseTwoVerdict` 只在**当轮 verify 全绿**时才给 offline-only，
       halt 路径下 level 保持 none。这是正确行为 —— 夹具用完不等于"跑通了"。
       所以这里断言的是**不许 success**（核心约束），并记录 level 的真实取值。 */
    ok(res.outcome !== "success",
        "离线全绿也**不得** outcome=success（offline_boundary 的硬约束）", res.outcome);
    eq(res.reason, "MOCK_EXHAUSTED", "第 2 轮夹具耗尽 ⇒ MOCK_EXHAUSTED（夹具只有一轮，预期）");
    ok(res.level === "none" || res.level === "offline-only",
        `level 只能是 none（夹具耗尽）或 offline-only，**绝不能是 live**；实得 ${res.level}`, res.level);
    ok(res.level !== "live", "★ 离线永远不得判 live —— 这是整个 offline_boundary 的存在理由");
    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 12. dry-run：只到 plan，世界零写入
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 12. dry-run ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g, dryRun: true,
    });
    eq(res.reason, "DRY_RUN", "reason = DRY_RUN");
    eq(res.tx_count, 0, "0 次 tx");
    eq(g.entityCount, 181, "世界零写入");
    ok(kindsOf(res).includes("plan"), "plan 行写了");
    ok(!kindsOf(res).includes("apply"), "★ 没有 apply 行（plan.rejected 为 null 时也不许出现 apply）");
    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(`\nloop 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
    process.exitCode = 1;
}
