/**
 * prompt_belt_visibility.test.mjs — 钉住「诊断点名的带子必须真的出现在 BELTS 段里」。
 *
 * ## 这个文件守的 bug（2026-11-01 实机实测）
 *
 * 半成品世界（`.tmpverify/final-half/probe-obs.json`，现固化为
 * `test/fixtures/saves/half-L4-obs.json`）上，模型看到的 prompt 是：
 *
 *     ## DIAGNOSIS (3)
 *     3. DEAD_END [L2/blocker]: B34 (belt); ... handles B34
 *
 *     ## BELTS (12 of 34; 2 referenced by diagnosis)
 *     B31 belt ...
 *     （没有 B34）
 *
 * `B34` 明明在句柄表里，诊断也点名了它，但被 `pickBeltsForGoal` 挤出了 12 个名额；
 * 而表头仍然声称「2 referenced by diagnosis」。
 *
 * 两处都是硬伤，各配一条测试：
 *   · **A/B/C**：诊断点名的带子有保底名额（不是"看运气"）
 *   · **D**    ：表头的数字必须等于**实际渲染出来**的点名条数（表头不许撒谎）
 *   · **E**    ：保底不能把目标走廊挤光 —— 这是 2026-10-30 的历史回归，别修新的引旧的
 *
 * ## 为什么 E 是核心而不是陪衬
 *
 * `pickBeltsForGoal` 在 L4 上**恰好填满 12 条**，正解三条 `B69`(序 1) / `B81`(序 2) /
 * `B82`(序 9)。保底每多吃一个名额，byGoal 就少一个 —— 保底 3 条时 `B82` 掉出，
 * `B81/B82` 这对并排段被拆散（`replace_run` 的 `$bbox_of` 会覆盖到没见过的格子）。
 * 也就是说：**A 修好了、E 坏了，等于把 3/3 改成 2/3，比原 bug 更糟**。
 * 所以两条必须同时绿，且 E 用真实的 L4 存档，不用内联小世界。
 *
 * ## 反例才算数
 *
 * 每条正例都配一个"去掉修复就变红"的对照：
 *   · A 的对照：同一份夹具、**不**给诊断 ⇒ 不能断言 B34 出现（证明是诊断保底在起作用，
 *     不是 B34 恰好排进了前 12）
 *   · C 的对照：点名 20 条 ⇒ **不能**全进（证明保底不是"无脑全塞"）
 *   · E 的对照：把 reserve 手工放大到 3（本地复算同一套名额分配）⇒ B82 必须掉出，
 *     证明 E 不是恒真的
 *
 * 用法：node --test src/agent/loop/prompt_belt_visibility.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt, PROMPT_RULES } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const loadJson = name => JSON.parse(fs.readFileSync(path.join(SAVES, name), "utf8"));

/* ═══════════════════════════ 夹具 ═══════════════════════════
 *
 * `half-L4-obs.json` = 实机半成品世界（42 实体 / 34 条带子），B34 是断头带子，
 * 几何来自真实存档而不是手搓 —— 手搓一个小世界会让 `pickBeltsForGoal` 的
 * 分量/汇聚判据走不到真实分支，测试就会变成"只测我写的那条 if"。
 */
const HALF = loadJson("half-L4-obs.json");
const HALF_OBS = HALF.obs;
const HALF_ITEMS = HALF.items || null;
const HALF_TABLE = buildHandles(HALF_OBS, HALF_ITEMS);

const L4_OBS = loadJson("L4-obs.json").result;
const L4_TABLE = buildHandles(L4_OBS, null);

const CAP = PROMPT_RULES.STATE_BELTS_MAX;
const RESERVE = PROMPT_RULES.STATE_BELTS_DIAG_RESERVE;

const beltHandles = tbl => [...tbl.byHandle.values()]
    .filter(e => e.type === "belt" || e.type === "underground_belt")
    .map(e => e.handle);

/** 只渲染 BELTS 段（`s3_belts` 就是这一段，含表头）。 */
const beltsSection = opts => buildPrompt(opts).blocks.s3_belts;

/** 段落正文里出现的带子句柄（按行首 `B<n> ` 认，不是 `includes` —— 后者会被 `B3` 命中 `B34`）。 */
const beltLines = section => section.split("\n")
    .map(l => (l.match(/^(B\d+) /) || [])[1])
    .filter(Boolean);

/** 表头的 `N`（`referenced` 那个数字）。 */
function headerReferenced(section) {
    const h = section.split("\n")[0];
    const m = h.match(/## BELTS \(([^)]*)\)/);
    assert.ok(m, `BELTS 表头形状不认识: ${h}`);
    const r = m[1].match(/(\d+) (?:of (\d+) )?referenced by diagnosis/);
    assert.ok(r, `表头里没有 referenced 字段: ${h}`);
    return { shown: Number(r[1]), total: r[2] === undefined ? Number(r[1]) : Number(r[2]), header: h };
}

/** 造一条「点名了这些带子」的诊断。`subject` 用第一条，`evidence.handles` 给全部。 */
const diagNaming = handles => (handles.length ? [{
    code: "DEAD_END", layer: "L2",
    subject: { handle: handles[0] },
    expected: { reach: true }, observed: { reach: false },
    evidence: { handles },
    candidates: ["connect"],
}] : []);

const halfPrompt = over => ({
    goal: "RuRu----",
    obs: HALF_OBS,
    handles: HALF_TABLE,
    diagnoses: [],
    candidates: ["connect", "trash_unused", "extend_line"],
    lastRound: null,
    budget: {},
    ...over,
});

/* ═══════════════════════════ 0. 夹具自检 ═══════════════════════════
 *
 * 下面每条测试都建立在这个前提上：B34 在句柄表里、是带子、而且**不在** byGoal 选出的
 * 那 12 条里。任何一条不成立，A 就会变成恒真的假绿（"B34 出现了"可能只是因为它
 * 恰好排在前面，跟诊断保底无关）。所以先把它钉死。
 */
test("0. 夹具：B34 在句柄表里、是带子、且**不**在无诊断时的 12 条里", () => {
    const e = HALF_TABLE.byHandle.get("B34");
    assert.ok(e, "B34 必须在句柄表里");
    assert.equal(e.type, "belt", "B34 是 belt");

    const noDiag = beltLines(beltsSection(halfPrompt()));
    assert.equal(noDiag.length, CAP, `无诊断时名额用满 ${CAP} 条（实际 ${noDiag.length}）`);
    assert.ok(!noDiag.includes("B34"),
        "★ B34 不在无诊断的列表里 —— 否则正例 A 是恒真的，测不出保底有没有用");
    /* 顺便钉住：无诊断时表头写 0，且 0 是真的 */
    const h0 = headerReferenced(beltsSection(halfPrompt()));
    assert.equal(h0.shown, 0, "无诊断时表头是 0 referenced");
});

/* ═══════════════════════════ 1. 正例 A：B34 必须出现 ═══════════════════════════
 *
 * 这是 bug 报告里的原样复现：诊断 `DEAD_END [L2/blocker]: B34`。
 */
test("A. 正例：诊断点名 B34 ⇒ BELTS 段里必须有 B34（实机夹具）", () => {
    const section = beltsSection(halfPrompt({ diagnoses: diagNaming(["B34"]) }));
    const lines = beltLines(section);
    assert.ok(lines.includes("B34"),
        `★ B34 必须出现在 BELTS 段里；实际渲染: ${lines.join(",")}`);
    /* 行首匹配而不是 includes —— 后者会被 `B3`/`B34` 之类的子串骗过 */
    assert.match(section, /^B34 belt /m, "B34 是**独立一行**（不是被别的句柄子串带上来的）");
    assert.ok(lines.length <= CAP, `总数仍 ≤ ${CAP}（实际 ${lines.length}）`);
});

test("A2. 正例：B34 出现时，名额从 byGoal 里扣 —— 总数不变、表头不撒谎", () => {
    const noDiag = beltsSection(halfPrompt());
    const withDiag = beltsSection(halfPrompt({ diagnoses: diagNaming(["B34"]) }));
    assert.equal(beltLines(withDiag).length, beltLines(noDiag).length,
        "带子总数不变（保底是**换**名额，不是加名额）");
    const h = headerReferenced(withDiag);
    assert.equal(h.shown, 1, `表头写 1 referenced（实际 ${h.shown}）`);
    assert.equal(h.total, 1, "总点名数也是 1（没有第二个来源）");
});

/* ═══════════════════════════ 2. 正例 B：5 条点名 ⇒ 保底条数出现 ═══════════════════════════ */
test("B. 正例：诊断点名 5 条 ⇒ 至少保底条数出现在渲染里", () => {
    /* 用「不在 byGoal 里」的带子，否则它们靠走廊就能进，测不出保底 */
    const byGoalSet = new Set(beltLines(beltsSection(halfPrompt())));
    const candidates = beltHandles(HALF_TABLE).filter(h => !byGoalSet.has(h) && h !== "B34");
    assert.ok(candidates.length >= 5, `夹具里至少有 5 条不在走廊上的带子（实际 ${candidates.length}）`);
    const named = candidates.slice(0, 5);

    const section = beltsSection(halfPrompt({ diagnoses: diagNaming(named) }));
    const lines = beltLines(section);
    const present = named.filter(h => lines.includes(h));
    const want = Math.min(named.length, RESERVE);
    assert.ok(present.length >= want,
        `★ 至少 ${want} 条（保底）点名带子出现；实际 ${present.length}/${named.length}：${present.join(",")}`);

    /* 而且必须是**前面那几条** —— 保底按 referenced 的顺序取，不是随机挑。
       如果实现改成"取最后 N 条"，模型就会看到一串跟诊断开头无关的带子。 */
    assert.deepEqual(present.slice(0, want), named.slice(0, want),
        "保底按诊断出现顺序取（不是倒序/随机）");

    /* 剩下的名额仍然是走廊的，不是被 5 条点名全吃掉 */
    const fromCorridor = lines.filter(h => byGoalSet.has(h));
    assert.ok(fromCorridor.length >= CAP - RESERVE - 1,
        `★ 走廊仍有名额（实际 ${fromCorridor.length} 条，cap=${CAP} reserve=${RESERVE}）`);
});

/* ═══════════════════════════ 3. 反例 C：20 条点名超过 cap ═══════════════════════════
 *
 * 「有保底」很容易滑成「那就全塞进去」。C 守的是另一头：20 条点名**不能**全进，
 * 但保底那几条必须仍在。两头都钉住，才算把取舍规则写清楚。
 */
test("C. 反例：诊断点名 20 条（> cap）⇒ 不能全塞，但保底那几条必须在", () => {
    const byGoalSet = new Set(beltLines(beltsSection(halfPrompt())));
    const pool = beltHandles(HALF_TABLE).filter(h => !byGoalSet.has(h));
    assert.ok(pool.length >= 20 || beltHandles(HALF_TABLE).length >= 20,
        `夹具带子数够造 20 条点名（实际 ${beltHandles(HALF_TABLE).length}）`);
    /* 一定要凑够 20 条 —— 数量必须超过 cap，否则这条测的是别的东西 */
    const named = beltHandles(HALF_TABLE).filter(h => h !== "B34").slice(0, 20);
    assert.equal(named.length, 20, "点名恰好 20 条");

    const section = beltsSection(halfPrompt({ diagnoses: diagNaming(named) }));
    const lines = beltLines(section);
    const present = named.filter(h => lines.includes(h));

    assert.ok(lines.length <= CAP, `★ 总数仍 ≤ ${CAP}（实际 ${lines.length}）—— 没有因为点名多就突破上限`);
    assert.ok(present.length < named.length,
        `★ 20 条点名不能全进（实际进了 ${present.length}）`);
    /* 保底那几条（referenced 顺序的前 RESERVE 条）必须在 */
    const must = named.slice(0, RESERVE);
    for (const h of must) {
        assert.ok(lines.includes(h), `★ 保底 ${h} 必须在（点名 ${named.length} 条、cap ${CAP}）`);
    }
    /* 表头说实话：写的是"渲染出来几条 / 一共点名几条" */
    const h = headerReferenced(section);
    assert.equal(h.shown, present.length,
        `表头 shown=${h.shown} 必须等于实际渲染的点名条数 ${present.length}`);
    assert.equal(h.total, named.length, `表头 total=${h.total} 必须等于点名总数 ${named.length}`);
    assert.match(section.split("\n")[0], /referenced by diagnosis shown/,
        "被压掉一部分时，表头必须写 `of N ... shown`（不能让模型以为全都在）");
});

/* ═══════════════════════════ 4. 一致性 D：表头 == 实际渲染 ═══════════════════════════
 *
 * 这条是 bug 报告里「表头在撒谎」的直接守门人。
 * 用多组不同规模的诊断扫一遍，任何一组里表头数字与实际不符都算红。
 */
test("D. 一致性：表头 `N referenced` 必须等于渲染里被诊断点名的条数", () => {
    const byGoalSet = new Set(beltLines(beltsSection(halfPrompt())));
    const offCorridor = beltHandles(HALF_TABLE).filter(h => !byGoalSet.has(h));
    const cases = [
        { name: "无诊断", named: [] },
        { name: "1 条", named: offCorridor.slice(0, 1) },
        { name: "2 条", named: offCorridor.slice(0, 2) },
        { name: "3 条", named: offCorridor.slice(0, 3) },
        { name: "5 条", named: offCorridor.slice(0, 5) },
        { name: "8 条", named: offCorridor.slice(0, 8) },
        { name: "20 条", named: beltHandles(HALF_TABLE).filter(h => h !== "B34").slice(0, 20) },
        /* 混合：点名里有机器（H1）—— referenced 只统计带子，表头也不许把 H1 算进去 */
        { name: "含非带子 H1", named: ["H1", ...offCorridor.slice(0, 3)] },
    ];
    assert.ok(offCorridor.length >= 8, `夹具里不在走廊上的带子够用（实际 ${offCorridor.length}）`);

    for (const c of cases) {
        const section = beltsSection(halfPrompt({ diagnoses: diagNaming(c.named) }));
        const lines = beltLines(section);
        const namedBelts = c.named.filter(h => HALF_TABLE.byHandle.get(h)
            && (HALF_TABLE.byHandle.get(h).type === "belt" || HALF_TABLE.byHandle.get(h).type === "underground_belt"));
        const actuallyShown = namedBelts.filter(h => lines.includes(h)).length;
        const h = headerReferenced(section);
        assert.equal(h.shown, actuallyShown,
            `★ [${c.name}] 表头写 ${h.shown} referenced，实际渲染了 ${actuallyShown} 条`
            + `（点名 ${namedBelts.length} 条；渲染 ${lines.join(",")}）`);
        assert.equal(h.total, namedBelts.length,
            `[${c.name}] 表头的总点名数 = 带子口径的点名数 ${namedBelts.length}`);
    }
});

/* ═══════════════════════════ 5. 回归 E：走廊不被保底挤光 ═══════════════════════════
 *
 * 2026-10-30 的历史回归：把 8 条诊断接进来后，L4 正解三条的可见性从 3/3 掉到 1/3。
 * 修 A/B/C 的保底名额**直接吃 byGoal 的名额**，所以这条回归随时可能被复活。
 * 用真实 L4 存档（163 条带子），扫一遍点名数量 0 → 20。
 */
test("E. 回归：L4 目标走廊的正解三条仍然可见（保底不能把它们挤光）", () => {
    const TARGETS = ["B69", "B81", "B82"];      // L4 正解要改的三条（uid 10143/10209/10149）
    const all = beltHandles(L4_TABLE);
    assert.equal(all.length, 163, `L4 夹具 163 条带子（实际 ${all.length}）`);
    /* 点名一定要**避开**正解三条，否则测的是"点名把正解带进来了"，不是走廊保底 */
    const offTarget = all.filter(h => !TARGETS.includes(h));

    const l4Prompt = over => ({
        goal: "RuRu----", obs: L4_OBS, handles: L4_TABLE,
        diagnoses: [], candidates: ["replace_run"], lastRound: null, budget: {},
        ...over,
    });

    const seen = [];
    for (const n of [0, 1, 2, 3, 5, 8, 12, 20]) {
        const named = offTarget.slice(0, n);
        const section = beltsSection(l4Prompt({ diagnoses: diagNaming(named) }));
        const lines = beltLines(section);
        const vis = TARGETS.filter(h => lines.includes(h));
        seen.push({ n, vis });

        assert.equal(vis.length, 3,
            `★ 点名 ${n} 条时正解三条仍全部可见（实际 ${vis.length}/3：${vis.join(",")}）；`
            + `渲染 ${lines.join(",")}`);
        /* 并排的两列必须**成对**出现：replace_run 的 region 是 $bbox_of，
           只给一列会让 bbox 覆盖到它没见过的格子 */
        for (const [a, b] of [["B81", "B82"], ["B69", "B70"]]) {
            assert.ok(lines.includes(a) && lines.includes(b),
                `[n=${n}] 并排两条 ${a}/${b} 同时出现`);
        }
        assert.ok(lines.length <= CAP, `[n=${n}] 总数 ≤ ${CAP}`);
        /* 这一组里点名的带子如果进了，表头必须说实话（D 的抽样版） */
        const h = headerReferenced(section);
        assert.equal(h.shown, named.filter(x => lines.includes(x)).length,
            `[n=${n}] 表头 ${h.shown} == 实际点名渲染数`);
    }
    /* 扫过全部 8 组都 3/3 —— 没有任何一个点名规模能把走廊挤掉 */
    assert.equal(seen.filter(s => s.vis.length === 3).length, seen.length,
        "所有点名规模下走廊都是 3/3");
});

test("E2. 对照：保底若放大到 3，B82 必须掉出 —— 证明 E 不是恒真的", () => {
    /* 复算 `pickBelts` 的名义分配（不改实现，只在测试里模拟 reserve 变化）。
       这条测的是「E 有没有牙齿」：若 reserve=3 也 3/3，说明 E 恒真、测不出回归。 */
    const byGoal = beltLines(beltsSection({
        goal: "RuRu----", obs: L4_OBS, handles: L4_TABLE,
        diagnoses: [], candidates: ["replace_run"], lastRound: null, budget: {},
    }));
    assert.equal(byGoal.length, CAP, `byGoal 恰好填满 ${CAP} 条（这是这个 bug 的结构性前提）`);

    const TARGETS = ["B69", "B81", "B82"];
    const refs = beltHandles(L4_TABLE).filter(h => !TARGETS.includes(h)).slice(0, 3);

    const simulate = reserve => {
        const chosen = [];
        const push = h => { if (h && !chosen.includes(h) && chosen.length < CAP) chosen.push(h); };
        byGoal.slice(0, CAP - reserve).forEach(push);
        refs.forEach(push);
        byGoal.slice(CAP - reserve).forEach(push);
        return chosen;
    };

    const r2 = simulate(RESERVE);
    assert.deepEqual(TARGETS.filter(h => r2.includes(h)), TARGETS,
        `reserve=${RESERVE} 时三条正解都在`);

    const r3 = simulate(3);
    const vis3 = TARGETS.filter(h => r3.includes(h));
    assert.ok(vis3.length < 3,
        `★ 对照：reserve=3 时必须丢掉至少一条正解（实际 ${vis3.length}/3：${vis3.join(",")}）——`
        + "丢了说明 E 有牙齿；没丢说明 E 恒真、需要换更强的口径");
    assert.ok(!r3.includes("B82"),
        `对照：reserve=3 时 B82 掉出（B82 在 byGoal 里排第 9 位，被切在 tail 上）`);
});

/* ═══════════════════════════ 6. 常量自检 ═══════════════════════════
 *
 * reserve 是"对着实测算出来的"，不是一个随便的魔法数。把它和 cap 的关系钉住：
 * 太小等于没保底，太大等于把走廊吃光。
 */
test("6. 常量：0 < reserve < cap/2，且 reserve 小于「走廊刚好填满」时能容忍的切尾长度", () => {
    assert.ok(RESERVE > 0, `reserve 必须 > 0（否则 A/B/C 全部退回老 bug）；实际 ${RESERVE}`);
    assert.ok(RESERVE <= 3, `reserve 不能 > 3（实测 reserve=3 就吃掉 B82）；实际 ${RESERVE}`);
    assert.ok(RESERVE * 2 < CAP, `reserve 必须远小于 cap，走廊才有名额；cap=${CAP} reserve=${RESERVE}`);
    assert.equal(RESERVE, 2, "当前值是实测得到的 2（见 PROMPT_RULES 注释里的 byGoal 顺序）");
});
