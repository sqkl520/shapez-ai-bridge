#!/usr/bin/env node
/**
 * tools/replay-plan.mjs —— 把某个 run 里模型提过的计划**原样**重新过一遍 `buildTxPlan`。
 *
 * ═════════════════════════ 为什么需要它 ═════════════════════════
 *
 * `exp-chain-hint.mjs` 的判据是「计划里有没有 `to={ref:C3,port:color}`」——
 * 它测的是**选择**。但真机上 10/10 选中根因也可能一件都落地不了：
 * 宏会 `occupied`、端口会被占、路径会撞。
 *
 * 实测（2026-11-21 `r-20261121100232-d10f`）：两轮 LLM 各给了 1-2 个调用，
 * **全部**在 `buildTxPlan` 里被 `connect:occupied` 拒掉，
 * 而实验报告写的是「F6 组 9/10 命中根因」。两者并不矛盾 —— 它们量的不是同一件事，
 * 但只有后者决定世界有没有变。本工具补上这一环。
 *
 * `connect.mjs` 等宏**零游戏写操作**：它们只读 `ctx.entities` 并规划。
 * 所以整条 `buildTxPlan` 可以在离线快照上跑，得到的拒绝原因与真机逐字相同。
 *
 * ═════════════════════════ 用法 ═════════════════════════
 *
 *   node tools/replay-plan.mjs --run r-20261121100232-d10f          # 重放该 run 的每一轮
 *   node tools/replay-plan.mjs --run <id> --json                    # 只输出 JSON
 *   node tools/replay-plan.mjs --run <id> --exp <expdir>            # 顺带重放实验某组的计划
 *
 * 只读：不连游戏、不发 tx/act/step/save。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const { buildTxPlan, readTranscript } = await imp("src/agent/loop.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");

const runId = argVal("--run");
const expDir = argVal("--exp");
if (!runId && !expDir) { console.error("需要 --run r-xxxx 和/或 --exp <实验目录>"); process.exit(2); }

const JSON_OUT = argv.includes("--json");

/**
 * 对一个计划跑 `buildTxPlan`，返回「能不能落地」。
 *
 * `partial: true` —— 真机 `PARTIAL_APPLY` 默认开启，语义是「失败的跳过、成功的提交」。
 * 这里也用 partial，否则第一个失败就整单拒绝，会低估落地率、高估问题。
 * 但**报告里两种情况都要看**：partial 下「一个都没成」仍然是零。
 */
function replay(plan, obs, items, handles) {
    /* 计划里的 `$path_of` / `$uids` 等算子由 `buildTxPlan` 内部的
       `resolveRefs` 解析 —— 它要的是**原始** llmPlan（`{calls:[...]}`），
       不是解析后的。所以原样传进去。 */
    const r = buildTxPlan(plan, obs, items, handles, { partial: true });
    const ok = r && r.ok === true;
    /* ⚠️ 成功时 ops 在 `r.txPlan.ops`，不在 `r.ops`。
     *
     * 第一版读 `r.ops`（undefined）⇒ 每个成功样本都显示 `✅ 落地 0 ops`，
     * 看上去像「一条 op 都没产生却报告成功」。实际上 op 全在 txPlan 里。
     *
     * 这个工具自己就是用来判「能不能落地」的，读错字段等于把**所有**结论
     * 反过来 —— 幸好我用真机那两个计划交叉核对过（重放出的拒绝码与真机
     * 逐字一致），才没有把「10/10 落不了地」当成结论发出去。
     * 与 `never-write-code-against-imagined-schema` 同族，这是第二次。 */
    const ops = ok && r.txPlan && Array.isArray(r.txPlan.ops) ? r.txPlan.ops : [];
    const applied = ok ? ops.length : 0;
    /* ⚠️ 返回形状有两套：成功是 `{ok:true, ops:[…]}`，失败是
       `{ok:false, code, diagnosis:{code,layer,observed,evidence}}` ——
       不是 `{rejected:{…}}`。第一版按 `rejected` 读，于是每个失败样本都被报成
       `null (null)`，看上去像「工具没跑通」而不是「计划被拒」。
       这类「照臆想的 schema 写代码」在本仓库记过一次（`never-write-code-against-imagined-schema`）。 */
    const dg = (r && r.diagnosis) || null;
    /* partial 下「跳过」的原因藏在 evidence.skipped 里 —— 那才是逐条调用的真拒绝码，
       而 `code` 只是兜底结论（NO_REVERSIBLE_CALL）。 */
    const skipped = (dg && dg.evidence && Array.isArray(dg.evidence.skipped)) ? dg.evidence.skipped : [];
    return {
        ok,
        rejected: ok ? null : (r && r.code) || (dg && dg.code) || null,
        stage: ok ? null : (r && r.stage) || (dg && dg.layer) || null,
        observed: ok ? null : (dg && dg.observed) || null,
        macroCodes: skipped.map(x => `${x.macro}:${x.code || x.reason}`),
        calls: Array.isArray(plan && plan.calls) ? plan.calls.length : 0,
        ops: applied,
        plan: r,
    };
}

function fmt(r) {
    if (r.ok) return `✅ 落地 ${r.ops} ops / ${r.calls} call(s)${r.ops === 0 ? "  ⚠️ 零 op —— 这个「成功」是空的" : ""}`;
    const codes = r.macroCodes.length ? ` [${r.macroCodes.join(" ")}]` : "";
    return `❌ ${r.rejected}${codes}: ${String(r.observed || "").slice(0, 140)}`;
}

/* ══════════════ 1. 重放一个 run ══════════════ */
function replayRun(dir) {
    const obs = JSON.parse(fs.readFileSync(path.join(dir, "obs-last.json"), "utf8"));
    const items = JSON.parse(fs.readFileSync(path.join(dir, "items-last.json"), "utf8"));
    const handles = buildHandles(obs, items);
    const records = readTranscript(path.join(dir, "transcript.jsonl"));
    const out = [];
    for (const rec of records) {
        if (rec.kind !== "propose") continue;
        const plan = rec.data && rec.data.plan;
        if (!plan || !Array.isArray(plan.calls)) continue;
        const r = replay(plan, obs, items, handles);
        out.push({ where: `round ${rec.round} llm_call ${rec.data.llm_call}`, ...r });
        if (!JSON_OUT) {
            console.log(`[${path.basename(dir)} round ${rec.round} call ${rec.data.llm_call}] ${fmt(r)}`);
            if (plan.say) console.log(`    say: ${String(plan.say).slice(0, 120)}`);
            for (const c of plan.calls) {
                console.log(`    · ${c.macro} ${JSON.stringify(c.args || {}).slice(0, 140)}`);
            }
        }
    }
    return out;
}

/* ══════════════ 2. 重放一个实验目录 ══════════════ */
function replayExp(dir, obsPath) {
    const obs = JSON.parse(fs.readFileSync(obsPath, "utf8"));
    const itemsPath = path.join(path.dirname(obsPath), "items-last.json");
    const items = fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : null;
    const handles = buildHandles(obs, items);
    const out = [];
    for (const f of fs.readdirSync(dir).filter(x => /-\d+\.json$/.test(x)).sort()) {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (!rec.calls || !rec.calls.length) continue;
        const r = replay({ calls: rec.calls }, obs, items, handles);
        out.push({ where: f, hit: rec.classify ? rec.classify.hit : null, ...r });
        if (!JSON_OUT) console.log(`[${path.basename(dir)}/${f}] hit=${rec.classify ? rec.classify.hit : "?"}  ${fmt(r)}`);
    }
    return out;
}

/* ══════════════ 3. 主 ══════════════ */
const results = { run: [], exp: [] };

if (runId) {
    const dir = path.join(REPO, "research/ai-plan/runs", runId);
    if (!fs.existsSync(dir)) { console.error("没有这个 run: " + dir); process.exit(2); }
    if (!JSON_OUT) console.log(`══════ 重放 ${runId} ══════`);
    results.run = replayRun(dir);
}

const expDir2 = expDir;
if (expDir2) {
    const d = path.resolve(REPO, expDir2);
    const obsArg = argVal("--obs");
    const obsPath = obsArg
        ? path.resolve(REPO, obsArg)
        : path.join(REPO, "research/ai-plan/runs", runId, "obs-last.json");
    if (!JSON_OUT) console.log(`\n══════ 重放实验 ${expDir2} （obs=${path.relative(REPO, obsPath)}）══════`);
    results.exp = replayExp(d, obsPath);
}

/* ══════════════ 4. 汇总 ══════════════ */
function tally(list) {
    const n = list.length;
    const ok = list.filter(x => x.ok).length;
    const byCode = {};
    for (const x of list) {
        if (x.ok) continue;
        /* 按**宏级**拒绝码统计（occupied / port_already_bound …），
           而不是兜底的 NO_REVERSIBLE_CALL —— 后者对每条失败都一样，没有信息量。 */
        const ks = (x.macroCodes && x.macroCodes.length) ? x.macroCodes : [x.rejected];
        for (const k of ks) byCode[k] = (byCode[k] || 0) + 1;
    }
    return { n, ok, rate: n ? ok / n : 0, byCode };
}

const all = [...results.run, ...results.exp];
const t = tally(all);
if (JSON_OUT) {
    console.log(JSON.stringify({ results, tally: t }, null, 1));
} else {
    console.log(`\n══════ 汇总 ══════`);
    if (results.run.length) { const x = tally(results.run); console.log(`真机   ${x.ok}/${x.n} 落地  拒绝: ${JSON.stringify(x.byCode)}`); }
    if (results.exp.length) {
        const x = tally(results.exp);
        console.log(`实验   ${x.ok}/${x.n} 落地  拒绝: ${JSON.stringify(x.byCode)}`);
        const hitN = results.exp.filter(r => r.hit === true).length;
        const hitOk = results.exp.filter(r => r.hit === true && r.ok).length;
        console.log(`  其中「命中根因」的 ${hitN} 个样本里，只有 ${hitOk} 个能真落地`);
    }
    if (results.run.length && results.exp.length) console.log(`合计   ${t.ok}/${t.n} 落地`);
}

process.exit(t.n && t.ok === 0 && results.run.length ? 4 : 0);
