#!/usr/bin/env node
/**
 * tools/delivery-ledger.mjs —— **送达账本**：一个字段/一段话，到底有没有进到
 * 渲染后的 prompt 里？
 *
 * ## 这个工具存在的唯一理由
 *
 * 本仓库最高频的缺陷形态是 `computed-but-never-delivered`：值算出来了、写进
 * transcript 了、测试也绿了，但它**从没出现在模型眼前**。历史上已经复发过
 * 至少五次（`tx.diff.modified` / `macro warnings` / `site_handles` /
 * `feed_sources` / `hint` 截断）。
 *
 * 「代码改了 + 测试绿了」不能证明送达。唯一能证明的是：**把真实那一轮的参数
 * 重新喂给 `buildPrompt`，然后在渲染后的 `user` 里找到它**（带字符偏移）。
 *
 * ## 用法
 *
 *   node tools/delivery-ledger.mjs --run r-20261123235846-de15
 *   node tools/delivery-ledger.mjs --run r-20261123235846-de15 --rebuild --dump .tmp-x/
 *   node tools/delivery-ledger.mjs --run r-20261123235846-de15 --probe 'chain_belt_uids'
 *
 * 默认对 run 里**每一个有 propose 记录的轮次**各重建一次，输出：
 *
 *   field / section                       in_diag  in_prompt  offset  rendered_snippet
 *
 * 以及重建对齐度（`rebuild` 与 transcript 里 `propose.data.prompt_chars` 的差）。
 *
 * ## 重建为什么必须逐项对齐
 *
 * `buildPrompt` 有 16 个入参，其中 `priorAttempts` / `recipe` / `items` /
 * `production` / `itemsOnBelts` / `obsoleteLines` / `runLog` / `lastNetEffect`
 * 任何一项漏传或传错形状，渲染出来的就是**另一份文档**，`belts_shown`、
 * `CAPACITY` 是否出现、`HUB stored` 是否被挤掉全都会变。
 * 所以下面的 `rebuildPrompt()` 逐项对应 `loop.mjs` 的调用点
 * （`loop.mjs` 里 `buildPrompt({...})` 实参附近），并在结果里报告差多少。
 *
 * ## 已知的重建误差（必须读懂这一段）
 *
 * transcript **不保存**逐轮的完整 `obs/items/production` —— 只存摘要
 * （entity_count / paths / world_hash / recipe.ok）。所以重建只能拿
 * `<run>/obs-last.json`（run 结束时的那一份）去近似**最后一轮**。
 *
 *   · 对**最后一轮**、且该 run 在最后一轮之后没有再 apply/bump 世界，重建≈真机；
 *   · 对更早的轮次，世界已经变过，重建是**近似**，只能用长度差来判断对齐。
 *
 * 对齐判据（与任务书一致）：重建总长与真实 `prompt_chars` 之差 ≤3%，
 * 且差值能被逐段解释。工具会把差值和参与渲染的段落在表尾列出来。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

/* ══════════════════════════ 0. CLI ══════════════════════════ */

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(k);

const runId = argVal("--run");
if (!runId) {
    console.error("用法：node tools/delivery-ledger.mjs --run <run-id> [--rebuild] [--dump <dir>] [--probe <substr>...]");
    console.error("      run-id 形如 r-20261123235846-de15");
    process.exit(2);
}

const SEARCH_ROOTS = [
    path.join(REPO, "research/ai-plan/runs"),
    path.join(REPO, ".tmpverify/wire-ops-test"),
    path.join(REPO, ".tmpverify/live-partial/runs"),
    path.join(REPO, "runs"),
];

function findRunDir(id) {
    for (const root of SEARCH_ROOTS) {
        const p = path.join(root, id);
        if (fs.existsSync(path.join(p, "transcript.jsonl"))) return p;
    }
    // 允许传完整路径
    if (fs.existsSync(path.join(id, "transcript.jsonl"))) return path.resolve(id);
    return null;
}

const runDir = findRunDir(runId);
if (!runDir) {
    console.error(`✗ 找不到 run：${runId}（在 ${SEARCH_ROOTS.map(r => path.relative(REPO, r)).join(", ")} 下都没有）`);
    process.exit(2);
}

/* ══════════════════════════ 1. 读 run ══════════════════════════ */

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
const readTranscriptLines = () => fs.readFileSync(path.join(runDir, "transcript.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l, i) => {
        try { return JSON.parse(l); } catch (e) { throw new Error(`transcript 第 ${i + 1} 行不是合法 JSON：${e.message}`); }
    });

const recs = readTranscriptLines();
const runStart = recs.find(r => r.kind === "run_start");
const runEnd = recs.find(r => r.kind === "run_end");
const GOAL = (runStart && runStart.data && runStart.data.goal) || null;
const PROPOSE = recs.filter(r => r.kind === "propose");

if (!GOAL) { console.error("✗ transcript 里没有 run_start.goal，无法重建"); process.exit(2); }

/* ══════════════════════════ 2. 懒加载 buildPrompt 侧 ══════════════════════════ */

const { buildPrompt } = await imp("src/agent/loop/prompt.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");
const { candidatesFor } = await imp("src/agent/loop.mjs");
const { findObsoleteLines, findStoredObsolete } = await imp("src/agent/loop/obsolete.mjs");
const { recipeForCached } = await imp("src/agent/loop/recipe.mjs");
const { loadMemory, attemptsForGoal, worldKeyOf } = await imp("src/agent/loop/memory.mjs");

const loadMaybe = (f) => { try { return readJson(f); } catch { return null; } };
const obsLast = loadMaybe("obs-last.json");
const itemsLast = loadMaybe("items-last.json");
const prodLast = loadMaybe("production-last.json");

const itemsOnBeltsOf = (it) => {
    let n = 0;
    for (const p of (it && Array.isArray(it.paths) ? it.paths : [])) n += Number(p && p.itemsOnPath) || 0;
    return n;
};

/* 预算：`loop.mjs` 传的是这两条硬上限（见 buildPrompt 调用点注释），不是 BUDGET 常量。 */
const LOOP_BUDGET = { in_chars_max: 24000, prompt_tokens_max: 5300 };

/* ══════════════════════════ 3. 重建一轮 ══════════════════════════ */

/**
 * 逐项对齐 `loop.mjs` 的 `buildPrompt({...})` 实参。
 *
 * 数据来源全部是 transcript + 落盘快照：
 *   goal                run_start.data.goal
 *   obs/items/production  `<run>/obs-last.json` 等（**只有最后一份**，见文件头）
 *   handles             buildHandles(obs, items)
 *   diagnoses           diagnose 记录（该轮的那一条）
 *   candidates          propose.data.candidates（该轮真实候选）
 *   lastRound           上一轮的 plan / repair_decide（见 reconstructLastRound）
 *   recipe              observe.data.recipe 的摘要 → recipeForCached 重算或退化
 *   priorAttempts       跨 run 记忆 + worldKey（worldInfo 不在 transcript 里，
 *                       用 attempts.json 的 worlds 反查 seed）
 *   obsoleteLines       findObsoleteLines + findStoredObsolete
 *   runLog              前几轮的 propose.plan
 *   lastNetEffect       run_end.data.net_effects 里对应上一轮的那条
 */
function reconstructLastRound(roundNo) {
    const prev = roundNo - 1;
    if (prev < 1) return null;
    const prevPlan = recs.filter(x => x.kind === "plan" && x.round === prev).pop();
    const prevRepairs = recs.filter(x => x.kind === "repair_decide" && x.round === prev);
    const prevProp = recs.filter(x => x.kind === "propose" && x.round === prev).pop();
    const prevVerify = recs.filter(x => x.kind === "verify" && x.round === prev).pop();
    if (!prevPlan) return null;
    if (prevPlan.data && prevPlan.data.ok === true) {
        /* apply 成功路径：success/offline_only 会 break，只有 continue 会留 lastPlanSummary。
           从 verify 记录判断是否 continue。 */
        const ver = prevVerify && prevVerify.data;
        const broke = ver && (ver.achieved === true || ver.level === "offline-only");
        if (broke) return null;
        return {
            round: prev,
            calls: prevPlan.data.calls || [],
            verify: { checks: [], codes: [] },
            decision: "continue",
            macro_warnings: prevPlan.data.warnings || [],
            belt_reorient: (ver && ver.belt_reorient) || null,
        };
    }
    /* plan 被拒路径：settleFailure 写的 lastPlanSummary 带 failures */
    const rej = prevPlan.data.rejected || {};
    const planPhase = prevRepairs.find(r => r.data.phase === "plan");
    const sk = (rej.evidence && Array.isArray(rej.evidence.skipped)) ? rej.evidence.skipped : [];
    const macros = prevPlan.data.calls
        || (prevProp && prevProp.data.plan && Array.isArray(prevProp.data.plan.calls)
            ? prevProp.data.plan.calls.map(c => c.macro) : []);
    return {
        round: prev,
        calls: macros,
        verify: { checks: [], codes: planPhase ? planPhase.data.codes : [rej.code] },
        decision: "plan_rejected",
        failures: macros.map(m => {
            const hit = sk.find(s => s && s.macro === m);
            return {
                macro: m,
                code: (hit && hit.code) || rej.code || "PLAN_REJECTED",
                hint: (hit && hit.hint) || rej.hint || null,
                observed: rej.observed || null,
                candidates: (hit && Array.isArray(hit.candidates)) ? hit.candidates : null,
            };
        }),
    };
}

function reconstructRecipe(roundNo) {
    const obsRec = recs.filter(x => x.kind === "observe" && x.round === roundNo).pop();
    const tag = obsRec && obsRec.data && obsRec.data.recipe;
    if (!tag) return null;
    if (tag.ok === true) {
        try {
            const r = recipeForCached(GOAL, { level: Number.isFinite(tag.level) ? tag.level : undefined });
            return r && r.ok === true ? r : { ok: false, reason: (r && r.reason) || "unavailable", level: tag.level };
        } catch (e) {
            return { ok: false, reason: `rebuild error: ${e && e.message ? e.message : e}` };
        }
    }
    /* 失败也要带形状：`capped` 决定 prompt 里是 "RECIPE UNAVAILABLE — search capped"
       还是普通 unavailable 段，两者长度差 800+ 字符。transcript 只存了 reason 文本，
       所以按 reason 文本推断 capped（那是唯一可靠信号）。 */
    const reason = tag.reason || "unavailable";
    const capped = /capped/i.test(reason);
    return { ok: false, reason, level: tag.level, ...(capped ? { capped: true } : { capped: false }) };
}

function reconstructPriorAttempts() {
    try {
        const memFile = path.join(path.dirname(runDir), "attempts.json");
        const mem = loadMemory(memFile);
        /* worldInfo 只在 loop 里拿得到，transcript 不存。attempts.json 的 `worlds`
           键就是 seed——它必须与本次 run 的世界一致（同一存档）。这里取
           `last_seen` 最新的那个 seed 作为近似，并在报告里说明这一点。 */
        const worlds = (mem && mem.worlds) || {};
        const keys = Object.keys(worlds).filter(k => k.startsWith("seed:"));
        keys.sort((a, b) => String(worlds[b].last_seen || "").localeCompare(String(worlds[a].last_seen || "")));
        const wkey = keys.length ? keys[0] : worldKeyOf(null, obsLast);
        const list = attemptsForGoal(mem, GOAL, { limit: 6, excludeActionSets: [], world: wkey, worldStrict: true });
        return { list, wkey, guessed: true };
    } catch {
        return { list: null, wkey: null, guessed: true };
    }
}

function reconstructObsolete() {
    if (!prodLast) return null;
    try {
        const w = findObsoleteLines(prodLast, GOAL, { recipe: null });
        const s = findStoredObsolete({ obs: obsLast, goal: GOAL, recipe: null });
        const out = [...w];
        const seen = new Set(out.map(r => r.shape));
        for (const x of s) if (!seen.has(x.shape)) { out.push(x); seen.add(x.shape); }
        return out;
    } catch { return null; }
}

function reconstructRunLog(roundNo) {
    const log = [];
    for (let r = 1; r < roundNo; r++) {
        const p = recs.filter(x => x.kind === "propose" && x.round === r).pop();
        const pl = recs.filter(x => x.kind === "plan" && x.round === r).pop();
        const repair = recs.filter(x => x.kind === "repair_decide" && x.round === r && x.data.phase === "plan").pop();
        if (!p || !p.data.plan) continue;
        const calls = (p.data.plan.calls || []).map(c => c.macro);
        const outcome = pl && pl.data.ok === true
            ? "planned"
            : (repair ? "failed" : "planned");
        log.push({
            round: r,
            say: typeof p.data.plan.say === "string" ? p.data.plan.say : "",
            calls,
            detail: calls,   /* 真机的 detail 由 summarizeCalls 生成；这里退成宏名（长度略短） */
            outcome,
        });
    }
    return log;
}

function reconstructLastNetEffect(roundNo) {
    const prev = roundNo - 1;
    if (prev < 1) return null;
    const ne = (runEnd && Array.isArray(runEnd.data.net_effects)) ? runEnd.data.net_effects : [];
    const hit = [...ne].reverse().find(x => x.round === prev);
    if (!hit) return null;
    return { kind: hit.kind, why: Array.isArray(hit.why) ? hit.why : [], delta: [] };
}

/**
 * 重建某一轮的 prompt。返回 `{ bundle, meta }`，meta 记录每个实参的来源与近似程度。
 */
function rebuildPrompt(roundNo) {
    const diagRec = recs.filter(x => x.kind === "diagnose" && x.round === roundNo).pop();
    const propRec = recs.filter(x => x.kind === "propose" && x.round === roundNo).pop();
    if (!diagRec || !propRec) return null;
    if (!obsLast) return { bundle: null, meta: { error: "没有 obs-last.json（run 可能 toDisplay 没落盘）" } };

    const diagnoses = diagRec.data.diagnoses || [];
    const candidates = propRec.data.candidates || candidatesFor(diagnoses);
    const handles = buildHandles(obsLast, itemsLast);
    const prior = reconstructPriorAttempts();

    const budget0 = (runStart.data && runStart.data.budget) || {};
    const bundle = buildPrompt({
        goal: GOAL, obs: obsLast, handles, diagnoses, candidates,
        production: prodLast,
        itemsOnBelts: itemsOnBeltsOf(itemsLast),
        items: itemsLast,
        lastRound: reconstructLastRound(roundNo),
        lastNetEffect: reconstructLastNetEffect(roundNo),
        priorAttempts: prior.list,
        goalChanged: null,                 /* transcript 只在 GOAL_CHANGED 那一轮有；这里不猜 */
        obsoleteLines: reconstructObsolete(),
        recipe: reconstructRecipe(roundNo),
        runLog: reconstructRunLog(roundNo),
        stickyGoal: null,                  /* 粘性状态不在 transcript 里 */
        budget: {
            rounds_left: Math.max(0, (budget0.ROUNDS_MAX ?? 3) - (roundNo - 1)),
            llm_calls_left: Math.max(0, (budget0.LLM_CALLS_MAX ?? 8) - (roundNo - 1)),
            tx_left: Math.max(0, (budget0.TX_MAX ?? 6) - (roundNo - 1)),
            ticks_left: budget0.TICKS_MAX ?? 24000,
            wall_ms_left: budget0.WALL_MS_MAX ?? 900000,
            ...LOOP_BUDGET,
            forceOneCall: false,
        },
    });
    return {
        bundle,
        meta: {
            round: roundNo,
            prompt_chars_actual: propRec.data.prompt_chars ?? null,
            rebuilt_chars: bundle.system.length + bundle.user.length,
            prior_world_key: prior.wkey,
            prior_count: prior.list ? prior.list.length : null,
            approximations: [
                "obs/items/production 用的是 run 末快照（transcript 不存逐轮快照）",
                "priorAttempts 的 world key 用 attempts.json 里最新的 seed 近似（worldInfo 不在 transcript）",
                "runLog.detail 退成宏名（真机是 summarizeCalls 的一句话）",
                "goalChanged / stickyGoal 不在 transcript，按 null 处理",
            ],
        },
    };
}

/* ══════════════════════════ 4. 账本：字段 → 在哪 ══════════════════════════ */

/**
 * 每一项 = 一个「被修的东西」。三列：
 *   in_diag   —— 它在这一轮的 `diagnose` 记录里出现吗（结构化字段名 / 值）
 *   in_prompt —— 它在渲染后的 `user` / `system` 里出现吗（子串命中，**带偏移**）
 *   why_not   —— 没出现时，判定根因
 *
 * 探测用「子串」而不是「字段名」：模型看到的是渲染文本，字段名 `chain_belt_uids`
 * 永远不会出现。所以每项给 **probes**（渲染后可能出现的几种写法），命中任一即算送达。
 */
function buildLedger(roundNo, bundle, diagnoseData) {
    const diagText = JSON.stringify(diagnoseData || {});
    const user = bundle ? bundle.user : "";
    const system = bundle ? bundle.system : "";
    const whole = system + "\n" + user;

    const findIn = (text, probes) => {
        for (const p of probes) {
            const at = text.indexOf(p);
            if (at >= 0) return { at, probe: p };
        }
        return null;
    };

    const items = [
        {
            key: "1. reorientedBelts / LAST ROUND 'reoriented belts:'",
            in_diag_probes: ["belt_reorient", "reoriented"],
            in_prompt_probes: ["reoriented belts"],
            note: "渲染条件 lastRound != null && belt_reorient.count > 0",
            extra: () => {
                const c = recs.filter(x => x.kind === "verify").map(x => x.data && x.data.belt_reorient).filter(Boolean);
                const withCount = c.filter(b => Number(b.count) > 0).length;
                return `verify 记录里有 belt_reorient：${c.length} 条，其中 count>0：${withCount}`;
            },
        },
        {
            key: "2. slotRoleAt -> {role,index} literal",
            in_diag_probes: ["{role:", "role\":\""],
            in_prompt_probes: ["{role:\"", ".{role:"],
            note: "重名槽位渲染成 {role:\"x\", index:N}；单槽仍是裸 role",
        },
        {
            key: "3. health after-only (net_effect 判词)",
            in_diag_probes: ["net_effect"],
            in_prompt_probes: ["## LAST STEP", "your last change:"],
            note: "模型只看得到 ## LAST STEP（kind+why），net_effect 的原始 delta 不进 prompt",
        },
        {
            key: "4. NO_DIRECTION + items_on_belts (timeline)",
            in_diag_probes: ["items_on_belts"],
            in_prompt_probes: ["items_on_belts", "## TIMELINE"],
            note: "timeline.log 是给人读的，本来就不进 prompt —— 这条不要求送达",
            expectNotDelivered: true,
        },
        {
            key: "5. obsTickLastSeen / tickSincePrev",
            in_diag_probes: ["tickSincePrev", "tick_since_prev"],
            in_prompt_probes: ["tickSincePrev", "tick_since_prev", "window age"],
            note: "机制字段；只有在某个诊断的判据/文案里被读到时才算活着",
        },
        {
            key: "6. WORLD_FROZEN truncated-paths accounting",
            in_diag_probes: ["WORLD_FROZEN", "truncatedPaths"],
            in_prompt_probes: ["WORLD_FROZEN", "globally most blocked"],
            note: "WORLD_FROZEN 已删；这条应整体消失",
            expectAbsent: true,
        },
        {
            key: "7a. CHAIN_UNFED chain_belt_uids",
            in_diag_probes: ["chain_belt_uids"],
            in_prompt_probes: ["chain belt", "belt uids", "chain_belt_uids"],
            note: "若是死字段：只在 diag evidence 里、没有任何渲染器读它",
        },
        {
            key: "7b. CHAIN_UNFED live_chain_ends",
            in_diag_probes: ["live_chain_ends"],
            in_prompt_probes: ["唯一供料", "unique feed", "live_chain_ends"],
            note: "hint 里点了名（「末端是 X（唯一供料）」）才算送达",
        },
        {
            key: "7c. CHAIN_UNFED hint",
            in_diag_probes: ["CHAIN_UNFED"],
            in_prompt_probes: ["别拆这条链", "病根是这台矿机"],
            note: "渲染进 DIAGNOSIS 行尾（截 180 字符）",
        },
        {
            key: "8. ## CAPACITY zero-production short fallback",
            in_diag_probes: ["NO_PRODUCTION"],
            in_prompt_probes: ["repair the LAST segment", "first make one path carry items",
                "items ride the belts but ZERO produced"],
            note: "room<200 且 zero-production 时的极短保底",
        },
        {
            key: "8b. remove_run CARD (candidates -> ### remove_run)",
            in_diag_probes: ["remove_run"],
            /* ⚠️ 不能用裸 `remove_run` 当探针：SYSTEM 的规则 3 里有一行
             * `The ONLY allowed macro names are: connect, …, remove_run, …` ——
             * 那是**白名单**，不是卡片。裸探针会 100% 假阳性。
             * 卡片头是 `### remove_run`（见 renderCard）。 */
            in_prompt_probes: ["### remove_run"],
            note: "CARD 列表来自 RETRIEVAL_TABLE（不看 d.candidates）；DIAGNOSIS 行另有自己的 candidates",
        },
    ];

    return items.map(it => {
        const d = findIn(diagText, it.in_diag_probes);
        const p = findIn(whole, it.in_prompt_probes);
        let snippet = "";
        if (p) {
            const s = Math.max(0, p.at - 30);
            snippet = whole.slice(s, p.at + 90).replace(/\n/g, "⏎");
        }
        return {
            key: it.key,
            in_diag: d ? `✓ @${d.at}` : "—",
            in_prompt: p ? "✓" : "✗",
            offset: p ? p.at : "—",
            snippet,
            note: it.note,
            extra: it.extra ? it.extra() : null,
            expectNotDelivered: it.expectNotDelivered === true,
            expectAbsent: it.expectAbsent === true,
        };
    });
}

/* ══════════════════════════ 5. 主流程 ══════════════════════════ */

const rounds = PROPOSE.map(p => p.round);
const dumpDir = argVal("--dump");
if (dumpDir) fs.mkdirSync(path.resolve(REPO, dumpDir), { recursive: true });

console.log(`run   ${runId}`);
console.log(`dir   ${path.relative(REPO, runDir)}`);
console.log(`goal  ${GOAL}  mode=${(runStart.data && runStart.data.mode) || "?"}  outcome=${runEnd ? runEnd.data.outcome : "?"}`);
console.log(`rounds with propose: ${rounds.join(", ")}`);

let worst = 0;
for (const roundNo of rounds) {
    const built = rebuildPrompt(roundNo);
    if (!built) { console.log(`\n— round ${roundNo}: 无法重建（缺 diagnose/propose）`); continue; }
    if (!built.bundle) { console.log(`\n— round ${roundNo}: ${built.meta.error}`); continue; }
    const { bundle, meta } = built;
    const actual = meta.prompt_chars_actual;
    const diff = actual === null ? null : meta.rebuilt_chars - actual;
    const pct = actual ? (100 * diff / actual) : null;
    if (pct !== null) worst = Math.max(worst, Math.abs(pct));

    console.log(`\n════════ round ${roundNo} ════════`);
    console.log(`rebuild ${bundle.system.length} + ${bundle.user.length} = ${meta.rebuilt_chars}`
        + `   actual ${actual}   diff ${diff > 0 ? "+" : ""}${diff}${pct !== null ? ` (${pct.toFixed(2)}%)` : ""}`
        + `   tokens≈${bundle.tokens_estimate}`);

    const b = bundle.blocks;
    console.log(`blocks: belts ${b.belts_shown}/${b.belts_total} · CAPACITY ${b.s3_capacity ? (b.capacity_downgraded ? "short" : "full") : `none(${b.capacity_unavailable || "?"})`}`
        + ` · HUBstored ${b.s3_hub_stored ? "yes" : `no(${b.hub_stored_dropped || "?"})`}`
        + ` · PRIOR ${b.prior_shown ? "yes" : "no"} · THIS RUN ${b.this_run_shown ? "yes" : "no"}`
        + ` · LASTSTEP ${b.last_step_shown ? "yes" : "no"} · trimmed ${b.trimmed_belts}`);

    /* 段偏移表 —— 「在不在 prompt 里」的字符偏移必须能对上段头 */
    const sectionMap = (user) => {
        const lines = user.split("\n");
        let pos = 0; const out = [];
        for (const l of lines) { if (/^## /.test(l)) out.push({ at: pos, head: l }); pos += l.length + 1; }
        return out;
    };
    if (has("--sections")) {
        let prev = null;
        for (const s of sectionMap(bundle.user)) {
            const size = prev === null ? s.at : s.at - prev.at;
            console.log(`   ${String(s.at).padStart(6)} ${String(size).padStart(5)}  ${s.head}`);
            prev = s.at;
        }
    }

    const diagRec = recs.filter(x => x.kind === "diagnose" && x.round === roundNo).pop();
    const ledger = buildLedger(roundNo, bundle, diagRec && diagRec.data);
    console.log("");
    printTable(ledger);

    if (dumpDir) {
        const out = path.resolve(REPO, dumpDir, `${runId}-R${roundNo}.txt`);
        fs.writeFileSync(out, bundle.system + "\n\n#####USER#####\n\n" + bundle.user, "utf8");
        console.log(`  dumped → ${path.relative(REPO, out)}`);
    }
}

/* 额外探针：`--probe <substr>` 可以在整份重建文本里找一个任意子串 */
if (argVal("--probe")) {
    const needle = argVal("--probe");
    console.log(`\n── probe "${needle}" ──`);
    for (const roundNo of rounds) {
        const built = rebuildPrompt(roundNo);
        if (!built || !built.bundle) continue;
        const whole = built.bundle.system + "\n" + built.bundle.user;
        const at = whole.indexOf(needle);
        console.log(`  round ${roundNo}: ${at >= 0 ? `✓ @${at}` : "✗"}`);
    }
}

console.log(`\n重建可信度：最大偏差 ${worst.toFixed(2)}%（≤3% 视为对齐；逐段解释见报告）`);

/* ══════════════════════════ 6. 表格渲染 ══════════════════════════ */

function printTable(rows) {
    const cols = [
        ["field / section", 54],
        ["in_diag", 9],
        ["in_prompt", 10],
        ["offset", 7],
        ["rendered_snippet", 0],
    ];
    const pad = (s, n) => (n > 0 ? String(s).padEnd(n) : String(s));
    console.log(cols.map(([h, n]) => pad(h, n)).join(" "));
    console.log(cols.map(([, n]) => "─".repeat(n > 0 ? n : 1)).join(" "));
    for (const r of rows) {
        const flag = r.expectAbsent ? "" : (r.in_prompt === "✓" ? "" : (r.expectNotDelivered ? "  (不需要)" : "  ← 未送达"));
        console.log([pad(r.key, 54), pad(r.in_diag, 9), pad(r.in_prompt, 10), pad(String(r.offset), 7),
            r.snippet ? `"${r.snippet}"` : (r.extra || r.note)].join(" ") + flag);
    }
}
