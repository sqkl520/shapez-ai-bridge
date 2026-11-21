#!/usr/bin/env node
/**
 * exp-chain-hint.mjs —— A/B/C 实验：把 `MACHINE_STARVED` 的 hint 改成「完整因果链」，
 * 模型会不会更可能修对地方？
 *
 * ═════════════════════════ 要检验的假设 ═════════════════════════
 *
 * 现状（语义层 `semantic.mjs` 里的原文）：
 *
 *   「2 台机器只吃到一半的料，它们永远不会产出。最典型的是 painter#13552：
 *     1/2 路有料。多输入机器（stacker 要两路、painter 要形状+色）少一路就一件不出，
 *     而它不出货，上游所有带子会一路堵死 —— 那才是「一件都交付不了」的根源。
 *     修法：把缺的那一路接上（connect），源头没有就 insert_machine 补一台。
 *     ⚠️ 先修最下游那一台：它通了，上游的堵塞会自己解开。」
 *
 * 问题：它讲的是**机制**（多输入机器少一路就不出货），不是**这一张图的链条**。
 * 模型读完之后知道「缺料会冻住工厂」，却不知道「谁冻住了谁」，
 * 于是去修 `HUB_INLET_THIN`（排第 1）和 `MINER_UNWIRED`（排第 7）这些症状。
 *
 * H1：把 hint 换成**指名道姓的完整因果链**（painter → stacker → hub → 上游堵塞
 *     → ejector 全卡），模型会更可能选中**根部**（painter 的 color 槽）。
 *
 * H2（H1 的加强版）：再加一句**明确点名坐标**「先修 painter#13552 的 (-4,15)」，
 *     收益是否还会继续上升？还是要不要那一步都无所谓 ——
 *     那决定「模型缺的是因果理解，还是缺一个可指名的落点」。
 *
 * ═════════════════════════ 三组设计 ═════════════════════════
 *
 *   A 现状 hint
 *   B 完整因果链（换成链条叙述，仍不点坐标）
 *   C 完整因果链 + 点名 (-4,15)
 *
 * **唯一变量就是那一段文字。** 这一条在本仓库有血的教训
 * （`when-line-no-effect`：两次独立实验采用率都不动，因为变量没隔开），
 * 所以脚本里做了**三重等价性控制**，跑之前先自检、不等价就拒绝开跑：
 *
 *   ① 同一份 obs / items / production（同一个 run 的同一时刻快照）
 *   ② `diagnose()` 只调一次，三个臂共用同一批诊断对象，只替换那一条的 `hint`
 *   ③ **渲染后的 prompt 必须逐行相同，只有 MACHINE_STARVED 那一行除外**
 *
 * 第 ③ 条是这次新发现的坑，值得记下来：
 *
 *   1. `renderDiagnoses` 会把 hint 先 `trim()` 再 `clip(180)`。A 的原文 217 字符，
 *      渲染出来是 180；B/C 更短，会**整段**渲染出来。
 *   2. 更糟的是**预算连带**：hint 短了 37 字符，`renderBelts` 的截断循环就少砍一条带子
 *      （B 组 BELTS 显示 7 条，A/C 只有 6 条；后面的 PRODUCTION / BUDGET 段整体挪位）。
 *      也就是说 B 组真正被改的不只是 hint，还有它看见的带子列表 —— 混杂。
 *
 *   修法：把 B/C 补到与 A **渲染后**等长的 180 字符。填充必须插在**内部**
 *   （末尾空格会被 trim 掉），用 U+3000 全角空格（不携带语义、不被 sanitize 改写）。
 *   补齐后三个 prompt 的 `user.length` 完全相同，`diff` 只剩那一行。
 *
 * ═════════════════════════ 判定 ═════════════════════════
 *
 * 沿用 `exp-force-one.mjs` 的**严格版**，并按本实验的假设收紧：
 *
 *   hit =  ① 有一个 `connect`/`insert_machine` 调用的 `why`/args 指向**根部**
 *               （painter C3 的 color 槽：`why` 提到 painter，或 args 的 `to` 解析到 C3）
 *          ② 并且说出了「缺料」这件事（缺一路 / 1/2 / starved / 只来一路 / 一半…）
 *
 * ①②都必须满足 —— 只提 painter 不算（这台世界上到处都是 painter），
 * 只说「缺料」也不算（那可以指任何一台）。
 *
 * ═════════════════════════ 用法 ═════════════════════════
 *
 *   ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... \
 *     node tools/exp-chain-hint.mjs --n 10
 *
 *   --n 每臂样本数（默认 10）  --out 结果目录  --obs 换一份 obs  --dry 只渲染不调 LLM
 *
 * 只读：本脚本**不**连游戏、**不**发 tx/act/step/save，只读 `research/ai-plan/runs/` 的落盘快照。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const N = Number(argVal("--n") || 10);
const DRY = argv.includes("--dry");
const outDir = path.resolve(REPO, argVal("--out") || "research/ai-plan/experiments/chain-hint");

/* Windows 上绝对路径必须转成 file:// URL，否则 ESM loader 报 ERR_UNSUPPORTED_ESM_URL_SCHEME。 */
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { buildPrompt } = await imp("src/agent/loop/prompt.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");
const { diagnose, candidatesFor } = await imp("src/agent/loop.mjs");
const { AnthropicClient } = await imp("src/agent/loop/llm.mjs");

/* ══════════════════════════ 1. 三组 hint ══════════════════════════ */

const HINT_A =
    "**2 台机器只吃到一半的料，它们永远不会产出。**"
    + "最典型的是 painter#13552：1/2 路有料。"
    + "多输入机器（stacker 要两路、painter 要形状+色）**少一路就一件不出**，"
    + "而它不出货，上游所有带子会一路堵死 —— 那才是「一件都交付不了」的根源。"
    + "修法：把缺的那一路接上（`connect`），源头没有就 `insert_machine` 补一台。"
    + "⚠️ 先修**最下游**那一台：它通了，上游的堵塞会自己解开。";

const HINT_B =
    "**整座工厂已经冻死。** painter#13552 缺一路色料 → stacker#14684 只有一路进料、"
    + "从不吐货 → 通往 hub 的那条通路永远是空的 → 上游 259 件货把 165 格带塞满 → "
    + "19 个 ejector 全部卡死。修这一条链的**根部**：先给 painter#13552 的 color 槽接上料。";

const HINT_C =
    "**整座工厂已经冻死。** painter#13552（句柄 C3）缺一路色料 → stacker#14684 只有一路进料、"
    + "从不吐货 → 通往 hub 的通路永远空 → 上游 259 件货塞满 165 格带 → 19 ejector 全卡死。"
    + "修**根部**：先修 painter#13552 的 (-4,15) 那个空格，给它的 color 槽接上料。";

/**
 * 把 hint 补到与 A **渲染后**等长的 180 字符。
 *
 * `renderDiagnoses` 是 `clip(sanitize(hint).trim(), 180)`：
 *   · A 原文 217 → 渲染 180（被截断，末尾是 `…`）
 *   · B/C 原文 <180 → 整段渲染
 * 于是 B/C 会**少占**字符，`renderBelts` 的截断循环就少砍一条带子 ——
 * 三组的 BELTS 段因此不同，变量没隔开。
 *
 * 填充用 U+3000，并且插在**最后一个字符之前** —— 末尾的空格会被 `.trim()` 吃掉。
 *
 * @param {string} s
 * @param {number} n 目标长度（渲染后可见的字符数）
 */
function padToRendered(s, n) {
    const chars = [...s];
    if (chars.length >= n) return s;
    const filler = "　".repeat(n - chars.length);
    chars.splice(chars.length - 1, 0, filler);          // 插在最后一句的句号前
    return chars.join("");
}

const RENDERED_HINT_CAP = 180;

/* ══════════════════════════ 1b. D 组：交付对照组 ══════════════════════════
 *
 * 跑完首轮（A/B/C 各 10）才发现一个**必须单独隔开**的混杂：
 *
 *   A 的 hint 原文 217 字符，`renderDiagnoses` 只渲染前 180 ——
 *   而被截掉的正是结尾那句「⚠️ 先修**最下游**那一台：它通了，上游的堵塞会自己解开」。
 *   也就是说 A 组从来没有收到过任何「先修哪一台」的指示，
 *   它的问题是**指令没送到**，而不（只）是「叙述不够因果」。
 *
 *   B/C 的差别因此混着两个变量：① 因果链叙述 ② 那句指令终于送进来了。
 *   首轮数据里 B 组 10/10 都点了 painter，而其中 5 次是**第一个**调用 ——
 *   这更像是「终于知道先修哪台」，而不是「读懂了链条」。
 *
 * D 组把这个变量拆出来：**用 A 的叙述和措辞，只把全文压到 180 以内**，
 * 让那句「先修最下游」完整送达。D vs A = 纯「送达」效应；
 * D vs B = 纯「因果链叙述」效应（两者都已经把指令送到）。
 */
const HINT_D =
    "**2 台机器只吃到一半的料，它们永远不会产出。**最典型的是 painter#13552：1/2 路有料。"
    + "少一路就一件不出，上游带子会一路堵死。"
    + "修法：把缺的那一路接上（`connect`），源头没有就 `insert_machine` 补一台。"
    + "⚠️ 先修**最下游**那一台：它通了，上游的堵塞会自己解开。";

/* ══════════════════════════ 1c. E 组：当前仓库基线（不覆盖） ══════════════════════════
 *
 * 本实验跑到一半时，仓库里**另一个改动**落地了（`24ce607` + `1c83dbf`）：
 *   · hint 文案改成了「从 stagger/painter 开始 —— 它在这些缺料机器里最靠**上游**，是这条链的根」
 *   · `MACHINE_STARVED` 登记进了跨层 RANK，从第 6 位升到**第 1 位**
 *
 * 于是 A 组（旧文案、排第 6）不再是「现状」。E 组**完全不覆盖 hint**
 * （直接用 `diagnose()` 给的那份），用来回答：「并发的那个修法是不是已经把问题解决了？」
 *
 * ⚠️ 这也意味着 A/B/C 的首轮数据（`MACHINE_STARVED` 排第 6）与 E 组
 * （排第 1）**不在同一个快照上**，不能直接相比。报告里分开写。
 * 用 `--snapshot-order keep` 可以把诊断顺序钉回首轮那个快照（见下）。
 */
/* ══════════════════════════ 1d. F 组：把 C 里真正起作用的那个变量拆出来 ══════════════════════════
 *
 * C 组想测的是「点名 (-4,15)」，但**坐标根本到不了模型**：
 * `prompt.mjs` 的 `sanitize()` 会把 `(-4,15)` 换成 `<coord>`（契约 §Q3.2 禁坐标）。
 * 实测渲染出来的 C 组 hint 里，那句是「先修 painter#13552 的 <coord> 那个空格」。
 *
 * 而 C 组仍然比 B 组好（首个调用 8/10 vs 5/10）。差别只剩一处没被消掉的：
 * **C 写了「（句柄 C3）」** —— B 只给了 uid `painter#13552`，模型得自己
 * 从 `handles C3,C4` 那一段反推哪台是它；C 直接把句柄递到手上。
 *
 * F 组 = B 的完整因果链 + 「（句柄 C3）」，**不带坐标**。
 * 如果 F ≈ C，那 C 的收益来自句柄而不是坐标 —— 也就是说
 * 「点名坐标」这个设计在**当前消毒规则下无法实现**，真正的杠杆是「点名句柄」。
 */
const HINT_F =
    "**整座工厂已经冻死。** painter#13552（句柄 C3）缺一路色料 → stacker#14684 只有一路进料、"
    + "从不吐货 → 通往 hub 的那条通路永远是空的 → 上游 259 件货把 165 格带塞满 → "
    + "19 个 ejector 全部卡死。修这一条链的**根部**：先给 painter#13552 的 color 槽接上料。";

const ARMS = {
    A: { label: "首轮现状 hint（217 字符→被截到 180）", hint: HINT_A },
    B: { label: "完整因果链", hint: padToRendered(HINT_B, RENDERED_HINT_CAP) },
    C: { label: "完整链+点名 (-4,15)〔坐标会被消毒〕", hint: padToRendered(HINT_C, RENDERED_HINT_CAP) },
    D: { label: "现状措辞压到 ≤180（只为把指令送到）", hint: padToRendered(HINT_D, RENDERED_HINT_CAP) },
    E: { label: "当前仓库基线（hint 原样，不覆盖）", hint: null },
    F: { label: "完整链 + 句柄 C3（不带坐标）", hint: padToRendered(HINT_F, RENDERED_HINT_CAP) },
};

/* ══════════════════════════ 2. 固定输入 ══════════════════════════ */

const src = (() => {
    const given = argVal("--obs");
    if (given) return path.resolve(given);
    const runs = path.join(REPO, "research/ai-plan/runs");
    const d = fs.readdirSync(runs).filter(x => x.startsWith("r-")).sort().reverse()
        .find(x => fs.existsSync(path.join(runs, x, "obs-last.json")));
    if (!d) throw new Error("找不到任何含 obs-last.json 的 run");
    return path.join(runs, d, "obs-last.json");
})();

const obs = JSON.parse(fs.readFileSync(src, "utf8"));
const itemsPath = path.join(path.dirname(src), "items-last.json");
const prodPath = path.join(path.dirname(src), "production-last.json");
const items = fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : null;
const production = fs.existsSync(prodPath) ? JSON.parse(fs.readFileSync(prodPath, "utf8")) : null;

const GOAL = (obs && obs.goal && obs.goal.requirement && obs.goal.requirement.shape) || "CbCbCbRb:CwCwCwCw";
const handles = buildHandles(obs, items);

/* ⚠️ `diagnose()` 只调一次：各臂共用同一批对象，
   避免 `semantic.mjs` 在实验期间被改动导致某个臂拿到不同的诊断。

   `--pin-order 6` 还可以把 MACHINE_STARVED **挪回**它在某个历史快照里的位置。
   为什么需要它：本实验跑到一半时仓库里落了另一个改动（`1c83dbf`），
   把这条诊断从第 6 位提到第 1 位。首轮 A/B/C 是在「第 6 位」上跑的，
   后补的 D/E 是「第 1 位」—— 位置本身会影响模型注意力，
   两组数字不能直接相减。钉住顺序后重跑，才是同一快照上的对照。 */
const pinOrder = argVal("--pin-order") ? Number(argVal("--pin-order")) : null;
let diagnoses = diagnose(obs, items, production, null, GOAL, handles, { recipe: null });
if (pinOrder !== null) {
    const at = diagnoses.findIndex(d => d.code === "MACHINE_STARVED");
    if (at >= 0 && at !== pinOrder - 1) {
        const [it] = diagnoses.splice(at, 1);
        diagnoses.splice(pinOrder - 1, 0, it);
        console.log(`[pin-order] MACHINE_STARVED ${at + 1} → ${pinOrder}`);
    }
}

const starved = diagnoses.find(d => d.code === "MACHINE_STARVED");
if (!starved) {
    console.error("❌ 这份 obs 上没有 MACHINE_STARVED —— 三组没有可比性，拒绝开跑。");
    console.error(`   实际诊断：${diagnoses.map(d => d.code).join(", ") || "(空)"}`);
    process.exit(2);
}

const budget = {
    rounds_left: 3, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 600000,
    in_chars_max: 24000, prompt_tokens_max: 4600,
};

/**
 * 用某一组的 hint 渲染 prompt。**只替换 `hint` 一个字段**，其它一切原样。
 * `hint === null`（E 组）表示**不覆盖**，直接用 `diagnose()` 给的那份。
 * @param {string} arm
 */
function bundleFor(arm) {
    const ds = ARMS[arm].hint === null
        ? diagnoses
        : diagnoses.map(d => (d === starved ? { ...d, hint: ARMS[arm].hint } : d));
    return buildPrompt({
        goal: GOAL, obs, handles, diagnoses: ds, candidates: candidatesFor(ds),
        lastRound: null, budget, production,
    });
}

/* ══════════════════════════ 3. 等价性自检（不开跑之前） ══════════════════════════ */

/**
 * 三份 prompt 必须**逐行相同**，只有 MACHINE_STARVED 那一行允许不同。
 *
 * 这是本实验最要紧的一道闸。上一版没做它，B 组的 BELTS 段会多一条带子
 * （hint 短了 → 预算松了 → 截断循环少砍一条），于是「B 组更少选症状」
 * 到底是 hint 的功劳还是多看见一条带子的功劳，事后无法分辨。
 *
 * @returns {{ok:boolean, problems:string[], diffs:number[]}}
 */
function checkEquivalence(users, arms) {
    const problems = [];
    const lists = {};
    for (const arm of arms) lists[arm] = users[arm].split("\n");

    const lens = Object.fromEntries(arms.map(a => [a, lists[a].length]));
    if (new Set(Object.values(lens)).size !== 1) {
        problems.push(`行数不同：${arms.map(a => `${a}=${lens[a]}`).join(" ")}（说明有段落被整体挤出/挤出）`);
    }
    const totals = Object.fromEntries(arms.map(a => [a, users[a].length]));
    if (new Set(Object.values(totals)).size !== 1) {
        problems.push(`总字符数不同：${arms.map(a => `${a}=${totals[a]}`).join(" ")}`);
    }

    const diffs = [];
    const n = Math.max(...Object.values(lens));
    for (let i = 0; i < n; i++) {
        const vals = arms.map(a => lists[a][i]);
        if (new Set(vals).size === 1) continue;
        diffs.push(i);
        /* 允许不同的只有「所有臂都含 MACHINE_STARVED」的那一行 */
        const allStarved = vals.every(x => typeof x === "string" && x.includes("MACHINE_STARVED"));
        if (!allStarved) {
            problems.push(`第 ${i} 行在 MACHINE_STARVED 之外的地方不同：`
                + arms.map((a, k) => `\n      ${a}: ${String(vals[k]).slice(0, 100)}`).join(""));
        }
    }
    if (arms.length > 1 && diffs.length !== 1) {
        problems.push(`应当恰好 1 行不同（hint 那行），实际 ${diffs.length} 行：${diffs.slice(0, 12).join(",")}`);
    }
    return { ok: problems.length === 0, problems, diffs };
}

/* `--arms` 可以只跑一部分（例：首轮跑完 A/B/C 后补 D）。 */
const ARM_LIST = (argVal("--arms") || "A,B,C,D").split(",").map(s => s.trim()).filter(Boolean);
for (const a of ARM_LIST) if (!ARMS[a]) throw new Error(`未知臂 ${a}，可选 ${Object.keys(ARMS).join(",")}`);

const bundles = Object.fromEntries(ARM_LIST.map(a => [a, bundleFor(a)]));
const users = Object.fromEntries(ARM_LIST.map(a => [a, bundles[a].user]));
const equiv = checkEquivalence(users, ARM_LIST);

console.log(`输入: ${path.relative(REPO, src)}   goal=${GOAL}`);
console.log(`诊断: ${diagnoses.length} 条 — ${diagnoses.map((d, i) => `${i + 1}.${d.code}`).join(" ")}`);
console.log(`MACHINE_STARVED 在第 ${diagnoses.indexOf(starved) + 1} 位，subject=${starved.subject && starved.subject.handle}`);

console.log("\n──── hint 渲染长度 ────");
for (const arm of ARM_LIST) {
    const raw = ARMS[arm].hint === null
        ? [...(starved.hint || "")].length + " (仓库原样)"
        : [...ARMS[arm].hint].length;
    const rendered = (() => {
        const line = users[arm].split("\n").find(l => l.includes("MACHINE_STARVED")) || "";
        const i = line.indexOf("; hint: ");
        if (i < 0) return 0;
        const rest = line.slice(i + 8);
        const j = rest.indexOf("; candidates ");
        return [...(j < 0 ? rest : rest.slice(0, j)).replace(/　/g, "")].length;
    })();
    console.log(`  ${arm} (${ARMS[arm].label}): 原文 ${raw} → 渲染 ${rendered}`);
}

console.log("\n──── 等价性自检 ────");
if (equiv.ok) {
    console.log(`  ✅ ${ARM_LIST.length} 份 prompt 逐行相同${equiv.diffs.length ? `，只有第 ${equiv.diffs[0]} 行（MACHINE_STARVED 的 hint）不同` : "（单臂，无对照）"}`);
    console.log(`  user 字符数 ${ARM_LIST.join("=")}=${users[ARM_LIST[0]].length}  tokens≈${bundles[ARM_LIST[0]].tokens_estimate}`);
} else {
    console.log("  ❌ 不等价，拒绝开跑：");
    for (const p of equiv.problems) console.log("   · " + p);
    process.exit(3);
}

if (DRY) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const arm of ARM_LIST) {
        fs.writeFileSync(path.join(outDir, `prompt-${arm}.txt`),
            bundles[arm].system + "\n\n########\n\n" + bundles[arm].user, "utf8");
    }
    console.log(`\n--dry：prompt 已写到 ${path.relative(REPO, outDir)}/prompt-{${ARM_LIST.join(",")}}.txt`);
    process.exit(0);
}

/* ══════════════════════════ 4. 调用 LLM ══════════════════════════ */

const client = new AnthropicClient({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.AGENT_MODEL || "virtual/opus",
    maxTokens: 16000,
    timeoutMs: 240000,
});
console.log(`\nmodel=${process.env.AGENT_MODEL || "virtual/opus"}  n=${N}/arm  开始`);

/* ── 判定 ──
 *
 * ⚠️ 首轮（A/B/C 各 10）跑完后发现第一版判据有假阳性通道，改严了。留档：
 *
 *   第一版：`/"C3"/ && /"color"/` 出现在**任意**调用的 args 里就算「指向根部」。
 *   假阳性：`connect {from:{ref:"C3",port:"out"}, to:{ref:"H1"}}` ——
 *   把 painter 的产物送去 hub，那是**修下游**，不是修根部，但 args 里同时有
 *   "C3" 和 "color" 吗？没有。真正的通道是 `from:{ref:"C3"}` + 另一个调用的 color。
 *   实测重判下来：A/B/C 的 M1（args 宽松版）分别是 2/10、10/10、10/10，
 *   而「to 真的是 {ref:C3, port:color}」的严格版也是 2/10、10/10、10/10 ——
 *   **实际没有假阳性**，但那是运气，不是设计。
 *
 * 现在**主判据（primary）用严格版**：某个调用的 `to` 恰好是 `{ref:"C3", port:"color"}`。
 * 不读自然语言，只看它想让**哪台机器的哪个槽**接料 —— 这是最不会被措辞糊弄的指标。
 *
 * 副判据（`whyHit`，任务书写的口径）：某个 why 同时提到 painter/C3 和「缺料」。
 * 它依赖措辞（英文 "starved"/"missing color"、中文「缺料」都算），
 * 所以只作对照 —— 本仓库有过「判据本身有问题」的教训（`when-line-no-effect`）。
 */
const STARVE_RE = /缺料|缺一路|缺色料|缺 ?color|只来一路|只有一路|一半|空着|空格|starved|starving|only one (of|input)|not fed|missing (its )?color|empty color|no color|half|1\s*\/\s*2/i;

/** `to` 是不是 `{ref:"C3", port:"color"}`（不区分 $ref / ref 写法）。 */
function toIsC3Color(args) {
    const to = args && args.to;
    if (!to || typeof to !== "object") return false;
    const ref = to.$ref || to.ref;
    return ref === "C3" && String(to.port || "").toLowerCase() === "color";
}

function classify(plan) {
    const calls = Array.isArray(plan && plan.calls) ? plan.calls : [];
    const blob = calls.map(c => JSON.stringify(c || {})).join(" ");

    /* ① 主判据：to 精确落在根部的 color 槽上 */
    const rootIdx = calls.findIndex(c => toIsC3Color(c && c.args));
    const rootSelected = rootIdx >= 0;

    /* ② 副判据（任务书口径）：why 里点名机器 + 说出缺料 */
    const whyHit = calls.some(c => {
        const w = String(c && c.why || "");
        return /painter|\bC3\b/i.test(w) && STARVE_RE.test(w);
    });

    /* ③ 来源是否合法：C3.color 只能由「输出口空闲」的东西供料。
     *    从 MACHINES 段可知空闲输出的是 9 台矿机；C8.out 已被 B96 占用、
     *    C10.out / B96 / B698 都已被占用 —— 拿它们当 from 会被 `port_already_bound` 拒。 */
    const FREE_SRC = /^(M7|M8|M9|M11|M13|M14|M15|M16|M17|B697|B698)$/;
    const rootCall = rootSelected ? calls[rootIdx] : null;
    const rootFrom = rootCall && rootCall.args && rootCall.args.from
        ? (rootCall.args.from.$ref || rootCall.args.from.ref || null) : null;
    const rootFromFree = !!(rootFrom && FREE_SRC.test(rootFrom));

    /* 副指标：有没有被症状带走 */
    const touchedHubInlet = /\bB599\b|\bH1\b/.test(blob);
    const touchedUnwiredMiner = /"M(7|8|9|11|13|14|15|16|17)"/.test(blob);
    const touchedHandoff = /\bB692\b|\bB699\b/.test(blob);

    return {
        callCount: calls.length,
        macros: calls.map(c => c && c.macro),
        rootSelected,
        rootPosition: rootIdx >= 0 ? rootIdx + 1 : null,   // 1 = 第一个调用（会真的执行）
        rootExecutableFirst: rootIdx === 0,
        rootFrom,
        rootFromFree,
        whyHit,
        hit: rootSelected,          // 主判据
        touchedHubInlet, touchedUnwiredMiner, touchedHandoff,
    };
}

function parsePlan(text) {
    if (!text) return { plan: null, parseErr: "empty response" };
    try {
        const m = String(text).match(/\{[\s\S]*\}/);
        return { plan: JSON.parse(m ? m[0] : text), parseErr: null };
    } catch (e) {
        return { plan: null, parseErr: e.message };
    }
}

fs.mkdirSync(outDir, { recursive: true });
const results = Object.fromEntries(ARM_LIST.map(a => [a, []]));

/* 各臂**交替**跑（A B C D A B C D …）而不是同组连跑：
   若网关/模型在实验期间漂移（降级、限流、换后端），交替能把它摊到各组，
   连跑会把漂移整块算到某一组头上。 */
for (let round = 1; round <= N; round++) {
    for (const arm of ARM_LIST) {
        const t0 = Date.now();
        let text = null, err = null;
        try {
            const out = await client.propose(bundles[arm]);
            text = out && out.text;
        } catch (e) {
            err = e && e.message ? e.message : String(e);
        }
        const { plan, parseErr } = parsePlan(text);
        const cls = plan ? classify(plan) : null;
        const rec = {
            arm, round, ms: Date.now() - t0, err, parseErr,
            say: plan && plan.say || null,
            calls: plan && plan.calls || null,
            classify: cls,
            raw: DRY ? null : text,
        };
        results[arm].push(rec);
        const tag = cls ? `${cls.callCount} call(s) ${cls.macros.join("+")}` : `(失败: ${err || parseErr})`;
        const mark = cls && cls.hit
            ? `  ← 接向根部 C3.color${cls.rootExecutableFirst ? "（第一个调用）" : `（第 ${cls.rootPosition} 个）`}${cls.rootFromFree ? " 来源合法" : ""}`
            : "";
        console.log(`[${arm} ${round}/${N}] ${tag}${mark}`);
        fs.writeFileSync(
            path.join(outDir, `${arm}-${String(round).padStart(2, "0")}.json`),
            JSON.stringify(rec, null, 1),
        );
    }
}

/* ══════════════════════════ 5. 汇总 ══════════════════════════ */

console.log("\n════════ 汇总 ════════");
const summary = {};
for (const arm of ARM_LIST) {
    const all = results[arm];
    const ok = all.filter(r => r.classify);
    const n = ok.length;
    const hit = ok.filter(r => r.classify.hit).length;                       // 主：to = C3.color
    const first = ok.filter(r => r.classify.rootExecutableFirst).length;     // 且是第一个调用
    const why = ok.filter(r => r.classify.whyHit).length;                    // 副：why 口径
    const freeSrc = ok.filter(r => r.classify.rootSelected && r.classify.rootFromFree).length;
    const avgCalls = n ? ok.reduce((s, r) => s + r.classify.callCount, 0) / n : 0;
    summary[arm] = {
        n, valid: n, hit, first, why, freeSrc, avgCalls,
        symHub: ok.filter(r => r.classify.touchedHubInlet).length,
        symMiner: ok.filter(r => r.classify.touchedUnwiredMiner).length,
        symHandoff: ok.filter(r => r.classify.touchedHandoff).length,
    };
    console.log(`${arm} (${ARMS[arm].label})`);
    console.log(`   有效样本 ${n}/${all.length}`);
    console.log(`   主判据 to=C3.color        ${hit}/${n}`);
    console.log(`     其中是**第一个**调用    ${first}/${n}`);
    console.log(`     来源口空闲（能真执行）  ${freeSrc}/${n}`);
    console.log(`   副判据 why 提机器+缺料    ${why}/${n}`);
    console.log(`   平均宏数 ${avgCalls.toFixed(2)}`);
    console.log(`   顺带碰了症状：HUB_INLET ${summary[arm].symHub}  MINER_UNWIRED ${summary[arm].symMiner}  BELT_HANDOFF ${summary[arm].symHandoff}`);
}

/* Fisher 精确检验（单尾）：P(X ≤ a)，即「先验假设是 A 更差」。
   手写以免引依赖；用 0/10 vs 5/10 → 0.0163 校验过。 */
function logFact(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
function fisherOneTailed(aHit, aN, bHit, bN) {
    const K = aHit + bHit, n = aN + bN;
    const pHyper = (k) => Math.exp(logFact(K) + logFact(n - K) + logFact(aN) + logFact(bN)
        - logFact(n) - logFact(k) - logFact(K - k) - logFact(aN - k) - logFact(bN - K + k));
    let p = 0;
    for (let k = 0; k <= Math.min(aHit, K); k++) p += pHyper(k);
    return p;
}
console.log("\n──── Fisher 单尾 ────");
const pairs = [];
for (let i = 0; i < ARM_LIST.length; i++)
    for (let j = i + 1; j < ARM_LIST.length; j++) pairs.push([ARM_LIST[i], ARM_LIST[j]]);
for (const key of ["hit", "first", "why"]) {
    console.log(`  [${key}]`);
    for (const [x, y] of pairs) {
        const p = fisherOneTailed(summary[x][key], summary[x].valid, summary[y][key], summary[y].valid);
        const star = p < 0.05 ? " *" : p < 0.10 ? " (趋势)" : "";
        console.log(`    ${x} ${summary[x][key]}/${summary[x].valid} vs ${y} ${summary[y][key]}/${summary[y].valid}   p=${p.toFixed(3)}${star}`);
    }
}

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
    at: new Date().toISOString(), input: path.relative(REPO, src), goal: GOAL, n: N,
    arms: ARM_LIST,
    starvedIndex: diagnoses.indexOf(starved) + 1,
    hintChars: Object.fromEntries(ARM_LIST.map(a => [
        a, ARMS[a].hint === null ? "[仓库原样]" : [...ARMS[a].hint].length,
    ])),
    userChars: Object.fromEntries(ARM_LIST.map(a => [a, users[a].length])),
    equivalence: equiv, summary,
}, null, 1), "utf8");
console.log(`\n结果目录: ${path.relative(REPO, outDir)}`);
