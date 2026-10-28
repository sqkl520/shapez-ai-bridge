/**
 * prompt.mjs — LLM 输入的唯一渲染器（阶段 2 契约 v2 §Q3.4 / PHASE2-CONTRACT §Q3）。
 *
 * 这个文件只做一件事：把「句柄表 + 诊断 + 候选宏」渲染成两段字符串（system / user）。
 * **它不读世界、不发 RPC、不算坐标、不生成候选宏** —— 那分别是 handles.mjs / diagnose.mjs /
 * retrieve.mjs 的职责。依赖方向是 `handles → prompt → llm`（契约 §Q7.2），单向。
 *
 * ## 为什么 S1 必须字节稳定
 *
 * `system` 是 Anthropic prompt cache 的前缀。只要它随世界变化一个字节，整次调用的缓存就失效，
 * 而且更糟：它会让「prompt 里出现了什么」变得不可审计。所以：
 *   · S1 是**模块级常量**（`SYSTEM_PROMPT`），只在代码变更时改变；
 *   · S1 里出现的宏名派生自 `MACRO_NAMES`（运行时数据是**代码常量**，不是世界状态）；
 *   · `buildPrompt()` 从不把 goal / obs / handle / 诊断拼进 system。
 * 判据（prompt.test.mjs）：同一输入渲染两次 system 全等；换一张存档（L4 vs L5）system 仍全等。
 *
 * ## 为什么 prompt 里不可能出现坐标
 *
 * 三层保证，缺一不可：
 *   1. **不打印几何字段**：本文件只读句柄表里的 `handle / type / desc`，`x/y/r/uid/code`
 *      一个都不读（句柄表里就算有也读不到，因为 normalizeHandles 不搬运它们）。
 *   2. **不打印 uid**：契约 §Q3.2 明确「prompt 里绝不出现 x/y/r/code/uid」。uid 是给机器用的。
 *      附带的好处：一串 `[10143, 10144]` 会被坐标正则命中（`0143, 1014`），不打印就没有这个隐患。
 *   3. **兜底脱敏**：所有自由文本（宏卡片 summary、handle.desc、诊断的 expected/observed）
 *      出闸前过 `sanitize()`。命中即替换成 `<coord>` / `<uid>` 并分别计数
 *      （`blocks.redactions` / `blocks.redacted_uids`）—— 不静默、可审计。
 *      上游（handles.mjs）若把坐标写进 desc，这里不会把违规漏进 prompt，也不会假装没发生。
 *
 * 坐标正则只有一个定义（`coordRegex()`），测试与实现共用它 —— 两份正则就是两份真值。
 *
 * ## 预算与截断（契约 §Q3.4 硬规矩）
 *
 *   · 超预算时**只**从尾部砍 S3 的带子列表，砍到 0 为止；
 *   · goal / hub / 机器表 / diagnosis / S1 **永不截断**（宁可直接抛错，也不静默丢目标）；
 *   · 总字符数 > LLM_IN_CHARS_MAX（12000）→ 抛 `code:"PROMPT_OVER_BUDGET"`。
 *
 * 零依赖。import 的只有 `contract.mjs` 的只读常量（MACRO_NAMES / MACRO_SPECS）
 * 与 `constants.mjs` 的 `BUDGET`（**上限的唯一位置**，契约 §Q6.1）。
 */

import { MACRO_NAMES, MACRO_SPECS } from "../macros/contract.mjs";
import { BUDGET } from "./constants.mjs";

/* ══════════════════════════ 0. 常量 ══════════════════════════ */

/**
 * prompt 层的硬规矩。
 *
 * ★ 三个上限**引用** `BUDGET` 而不是重写字面量 ★
 *   契约 §Q6.1 把 `BUDGET` 定为唯一位置；抄一份数字进来就是两份真值，
 *   而这个仓库已经因为「两份真值」出过至少 3 次事故。这里的断言（`matchBudget()`）
 *   让「有人改了 BUDGET 却忘了这里」在**加载时**就炸，而不是在预算算错时才发现。
 */
export const PROMPT_RULES = Object.freeze({
    /** 字符→token 的估算比（契约 §Q3.4：中文/代码混合 ≈3.5 字符/token，不引 tokenizer） */
    CHARS_PER_TOKEN: 3.5,
    /** 输入预算 2.8k tok（S1..S6 合计） */
    PROMPT_TOKENS_MAX: 2800,
    /** 硬上限：超过即抛 PROMPT_OVER_BUDGET（= BUDGET.LLM_IN_CHARS_MAX） */
    LLM_IN_CHARS_MAX: BUDGET.LLM_IN_CHARS_MAX,
    /** 输出上限（parseLlmPlan 用同一条） */
    LLM_OUT_CHARS_MAX: BUDGET.LLM_OUT_CHARS_MAX,
    /** 单轮调用数上限（含 build_line 在内的任何名字，白名单只有 6 个） */
    CALLS_MAX: 6,
    /** S3 最多列多少条带子（= BUDGET.PROMPT_STATE_BELTS_MAX） */
    STATE_BELTS_MAX: BUDGET.PROMPT_STATE_BELTS_MAX,
    /** S3 机器表上限（不是契约硬数，是 900 tok 预算的工程上限） */
    MACHINES_MAX: 20,
    /** `say` 的字符上限（LLM_NARRATION，V2 §4 裁决保留） */
    SAY_MAX: 280,
});

/* 加载时自检：PROMPT_RULES 的上限必须就是 BUDGET 的那几个值。
   有人改 BUDGET 忘了这里（或反过来）时**立刻**炸 —— 预算类错误最怕"跑起来才发现算错"。
   键名不同（STATE_BELTS_MAX ↔ PROMPT_STATE_BELTS_MAX）所以显式列出来，
   不靠「同一套命名」这种假定 —— 那正是两份真值最常见的开裂处。 */
const BUDGET_MIRROR = Object.freeze({
    LLM_IN_CHARS_MAX: "LLM_IN_CHARS_MAX",
    LLM_OUT_CHARS_MAX: "LLM_OUT_CHARS_MAX",
    STATE_BELTS_MAX: "PROMPT_STATE_BELTS_MAX",
});
for (const [mine, theirs] of Object.entries(BUDGET_MIRROR)) {
    if (PROMPT_RULES[mine] !== BUDGET[theirs]) {
        throw new Error(`prompt.mjs: PROMPT_RULES.${mine}=${PROMPT_RULES[mine]} ≠ BUDGET.${theirs}=${BUDGET[theirs]}`
            + " —— BUDGET 是唯一真值（PHASE2-CONTRACT §Q6.1）");
    }
}

/** 宏白名单：直接派生自契约，不抄第二份。 */
export const MACRO_WHITELIST = MACRO_NAMES;

/* ══════════════════════════ 1. 坐标正则（唯一定义） ══════════════════════════ */

/**
 * 契约 §Q3.4 / §Q2.3 V4 的那条正则，原样：成对的 `x, y` 才算坐标。
 * 注意它**不**命中：goal 形状串（`RuRu----`）、计数（`12 件`）、tick 秒数、`1..5000`、
 * 单个负数（`-13` 没有逗号）。这是设计的口径 —— 单个数字不是坐标。
 */
const COORD_SRC = String.raw`\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?`;

/** 每次返回**新**的 g 正则：共享一个带 lastIndex 的实例是这类 bug 的经典来源。 */
export function coordRegex() {
    return new RegExp(COORD_SRC, "g");
}

/** 文本里是否含坐标形态（只读检查，供测试与上游自检用）。 */
export function hasCoords(text) {
    return coordRegex().test(String(text));
}

/**
 * uid 形态：`uid=10143` / `uid:10143` / `uid 10143`。
 * 契约 §Q3.2 的禁令是「x/y/r/code/**uid** 都不出现」，所以自由文本里的 uid 也要摘掉。
 * 不摘的后果不只是泄身份：一串数字挨在一起迟早会被坐标正则误判成 `x, y`。
 */
const UID_SRC = String.raw`\buids?\b\s*[=:]?\s*\d+`;

/**
 * 出闸前的唯一消毒函数。两类替换分别计数（`coords` / `uids`），供 blocks 审计。
 * 它不是"防御性编程"：上游 handles.mjs 若把坐标写进 desc，这里必须挡住**并留痕**，
 * 否则违规会静默进入 prompt，而我们在事后无法知道它发生过。
 */
function sanitize(value) {
    const s = String(value);
    let coords = 0, uids = 0;
    let text = s.replace(coordRegex(), () => { coords++; return "<coord>"; });
    text = text.replace(new RegExp(UID_SRC, "gi"), () => { uids++; return "<uid>"; });
    return { text, coords, uids };
}

/* ══════════════════════════ 2. S1：system（字节稳定） ══════════════════════════ */

/**
 * S1 的角色 + 规则。**模块级常量**，不含任何世界数据。
 *
 * 内容口径（契约 §Q3.4 S1 的 6 项，逐项都在下面）：
 *   ① 角色  ② 输出 JSON 格式  ③ 禁坐标  ④ 禁 build_line（白名单只有 6 个）
 *   ⑤ ≤6 个调用  ⑥ "只输出 JSON"
 *
 * 另外两条是实测催生的（不是设计洁癖）：
 *   · 「不要返回空 calls」——空计划是 Q8-01 的假成功入口，与其让它到 parse 层才被拒，
 *     不如在 system 里就说清楚；
 *   · 「不要发明参数名」——红队 §遗漏 3 实测：`from` 写成 `source` 会得到 unknown_field，
 *     而 unknown_field 在上游默认映射里 candidates=[]，一次就 halt。prompt 里点名
 *     「参数名必须逐字来自卡片」是这条的一次性成本最低的修法。
 */
const SYSTEM_PROMPT = [
    "You are the action selector of an automated repair loop for the game shapez.io.",
    "Each turn you receive a goal, a state described by TAGGED HANDLES (H1, C1, B7, T2, L1, M3),",
    "a list of diagnoses, and cards for a few candidate macro actions.",
    "You choose WHICH MACROS to call. The loop resolves handles, computes all geometry, writes",
    "the world, and verifies the result. You never compute or see positions.",
    "",
    "OUTPUT FORMAT (exactly one JSON object, nothing else):",
    '{"say":"one short sentence","calls":[{"macro":"<name>","args":{...},"why":"short reason"}]}',
    "",
    "RULES",
    "1. Output RAW JSON only: no markdown fence, no prose before/after, no comments, no trailing commas.",
    "2. calls must be an array with 1 to 6 entries. An empty calls array is rejected as a failed plan.",
    `3. The ONLY allowed macro names are: ${MACRO_NAMES.join(", ")}.`,
    "   Never emit build_line, paste_blueprint, or any other name: they are not part of this loop.",
    "4. NEVER output coordinates, positions, rotations, rotation variants, angles, or uids.",
    "   No x/y numbers. No arrays of two or four numbers. Refer to existing things ONLY by handle.",
    "5. Point at existing things with reference operators:",
    '     {"$ref":"B7"}                  one handle -> that entity',
    '     {"$ref":"B7","asCell":true}    one handle -> the cell it occupies',
    '     {"$uids":["B7","B8"]}          a set of handles -> the belts they name',
    '     {"$bbox_of":["B7","B8"]}       a set of handles -> the box covering them',
    "   Any other $-operator (offset, expand, arithmetic) is rejected. Handles must come from THIS prompt.",
    "6. Argument names must be copied verbatim from the macro card. Unknown or misspelled arguments",
    "   (e.g. source instead of from) are rejected and waste a round.",
    "7. A multi-CELL machine is addressed by ONE cell (use asCell) or by the handle of an existing",
    "   entity; the macro derives the footprint and the rotation. Never try to derive them yourself.",
    "8. Do not invent handles. If a thing you need has no handle, say so in `say` and pick a macro",
    "   that works with what IS listed.",
    "9. Prefer the smallest set of calls that can plausibly fix the top diagnosis. Explanations",
    "   belong in `say`/`why` and must not contain numbers that look like positions.",
].join("\n");

/* ══════════════════════════ 3. S2：宏卡片 ══════════════════════════ */

/**
 * 每张卡片带**一个句柄版调用例**。硬约束：例子里只有句柄与枚举，没有数字坐标。
 *
 * 为什么不从 MACRO_SPECS 自动生成例子：`params[].description` 里有 `[x,y]` 这类形态说明，
 * 自动拼出来既长又容易带进坐标语义，而「一个正确的调用长什么样」恰恰是最该人工钉住的一条。
 * 卡片其余部分（summary / params / whenNotToUse）全部来自 MACRO_SPECS —— 不抄第二份。
 */
const MACRO_EXAMPLES = Object.freeze({
    connect: { macro: "connect", args: { from: { $ref: "B7" }, to: { $ref: "C1", port: "left" } } },
    insert_machine: { macro: "insert_machine", args: { at: { $ref: "B7", asCell: true }, facing: "top", machine: "cutter" } },
    remove_run: { macro: "remove_run", args: { uids: { $uids: ["B7", "B8", "B9"] } } },
    extend_line: { macro: "extend_line", args: { from: { $ref: "B7" }, len: 4, dir: "right" } },
    replace_run: {
        macro: "replace_run",
        args: { region: { $bbox_of: ["B7", "B8", "B9"] }, building: [{ kind: "cutter" }, { kind: "trash", port: "left" }] },
    },
    trash_unused: { macro: "trash_unused", args: { outlet: { $ref: "C1", port: "left" }, opts: { confirm_waste: true } } },
});

/** 卡片的参数表：丢掉 `opts.dry_run`（loop 不让 LLM 决定 dry-run），最多 6 条。 */
function renderParams(spec) {
    const ps = spec.params
        .filter(p => p.name !== "opts.dry_run")
        .slice(0, 6)
        .map(p => `${p.name}:${p.type}${p.required ? "" : "?"}`);
    return ps.join(", ");
}

function renderCard(name) {
    const spec = MACRO_SPECS[name];
    const ex = MACRO_EXAMPLES[name];
    const notUse = (spec.whenNotToUse && spec.whenNotToUse[0]) || "";
    return [
        `### ${name}`,
        sanitize(spec.summary).text.trim(),
        `params: ${sanitize(renderParams(spec)).text}`,
        `not when: ${clip(sanitize(notUse).text.trim(), 170)}`,
        `example: ${JSON.stringify(ex)}`,
    ].join("\n");
}

/**
 * S2。`candidates` 的每一项可以是宏名字符串，或 `{macro, why}`（retrieve.mjs 的形态）。
 * 未知宏名**直接抛**，不静默丢弃：静默丢弃会让「检索表写错了」变成「模型就是没被提示」。
 */
function renderCards(candidates) {
    const names = [];
    for (const c of candidates || []) {
        const n = typeof c === "string" ? c : (c && c.macro);
        if (!MACRO_NAMES.includes(n)) {
            throw new TypeError(`buildPrompt: candidate macro "${n}" is not in MACRO_NAMES (${MACRO_NAMES.join(",")})`);
        }
        if (!names.includes(n)) names.push(n);
    }
    if (!names.length) {
        return "## CANDIDATE MACROS\n(none retrieved — choose only from the whitelist in SYSTEM; do not invent macro names)";
    }
    return [`## CANDIDATE MACROS (${names.length})`, ...names.map(renderCard)].join("\n\n");
}

/* ══════════════════════════ 4. 句柄表适配 ══════════════════════════ */

/**
 * 句柄表的**容忍式适配器**。handles.mjs 由并行的另一个 agent 实现，它的 `byHandle` 值可能是
 * 实体对象、uid 数字、或 `{handle, uid, type, desc}` 摘要。这里三种都吃：
 *
 *   {byHandle: Map|Object, hubHandle, goalHandle, version}   契约 §Q3.2 的形态
 *   [{handle, type, ...}, ...]                                数组形态
 *
 * **只搬运 handle / type / variant / desc 四个字段** —— x/y/r/uid/code 在这一步就被丢掉，
 * 后面的渲染代码根本拿不到它们。这是「prompt 不含坐标」的第一层保证（不是靠自觉）。
 */
function normalizeHandles(handles, obs) {
    const obsByUid = new Map();
    for (const e of (obs && obs.entities) || []) {
        if (e && typeof e.uid === "number") obsByUid.set(e.uid, e);
    }
    const byHandle = new Map();
    let hubHandle = null, goalHandle = null, version = null;

    const absorb = (handle, value) => {
        const h = String(handle);
        if (!h || byHandle.has(h)) return;
        let uid = null, obj = null;
        if (typeof value === "number") uid = value;
        else if (typeof value === "string" && /^\d+$/.test(value)) uid = Number(value);
        else if (value && typeof value === "object") {
            obj = value;
            if (typeof value.uid === "number") uid = value.uid;
        }
        const fromObs = uid !== null ? obsByUid.get(uid) : null;
        const type = (obj && (obj.type || obj.kind)) || (fromObs && fromObs.type) || "unknown";
        const variant = (obj && (obj.variant || obj.variantKey)) || (fromObs && fromObs.variant) || null;
        const desc = pickDesc(obj) || pickDesc(fromObs) || null;
        byHandle.set(h, { handle: h, type: String(type), variant, desc });
    };

    if (Array.isArray(handles)) {
        for (const e of handles) if (e && e.handle) absorb(e.handle, e);
    } else if (handles && typeof handles === "object") {
        const bh = handles.byHandle;
        if (bh instanceof Map) for (const [k, v] of bh) absorb(k, v);
        else if (bh && typeof bh === "object") for (const [k, v] of Object.entries(bh)) absorb(k, v);
        /* 兜底：直接把 handles 当 handle→entry 的扁平表（这是最朴素的调用方式） */
        if (!byHandle.size) {
            for (const [k, v] of Object.entries(handles)) {
                if (/^[A-Z]{1,2}\d{1,3}$/.test(k)) absorb(k, v);
            }
        }
        hubHandle = handles.hubHandle || handles.hub || null;
        goalHandle = handles.goalHandle || null;
        version = handles.version || null;
    }

    /* hub 兜底：句柄表没给 hubHandle 时，从 entries 里找 type==="hub" 的那一个。
       这是确定性的，且不涉及坐标。 */
    if (!hubHandle) {
        for (const e of byHandle.values()) if (e.type === "hub") { hubHandle = e.handle; break; }
    }
    return { byHandle, hubHandle, goalHandle, version };
}

function pickDesc(o) {
    if (!o || typeof o !== "object") return null;
    for (const k of ["desc", "description", "summary", "state", "line"]) {
        if (typeof o[k] === "string" && o[k].trim()) return o[k].trim();
    }
    return null;
}

const isBeltType = t => t === "belt" || t === "underground_belt";

/* ══════════════════════════ 5. 小工具 ══════════════════════════ */

function clip(s, n) {
    const str = String(s);
    return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + "…";
}

/** JSON 压缩成一行的短文本（用于 expected/observed 这种小对象）。坐标已被脱敏。 */
function compact(value, max = 140) {
    if (value === undefined || value === null) return "-";
    if (typeof value === "string") return clip(sanitize(value).text, max);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return clip(sanitize(JSON.stringify(value)).text, max);
    } catch {
        return "<unserializable>";
    }
}

function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ══════════════════════════ 6. S3：goal + state ══════════════════════════ */

/**
 * S3 拆成 5 个子块返回（`blocks.s3_*`），因为硬规矩「超预算只砍带子」需要能被测试逐块验证：
 * 砍之前与砍之后 `s3_goal` 必须逐字节相等。
 */
function renderGoal(goalShape, goal, obs) {
    const req = (obs && obs.goal && obs.goal.requirement) || {};
    const g = (goal && typeof goal === "object") ? goal : {};
    const level = num(g.level) ?? num(obs && obs.goal && obs.goal.level);
    const required = num(g.required) ?? num(req.required);
    const delivered = num(g.delivered) ?? num(req.delivered);
    const progress = num(g.progress) ?? num(req.progress);
    const lines = ["## GOAL", `shape: ${goalShape}`];
    const bits = [];
    if (level !== null) bits.push(`level ${level}`);
    if (required !== null) bits.push(`required ${required}`);
    if (delivered !== null) bits.push(`delivered ${delivered}`);
    if (progress !== null && delivered === null) bits.push(`progress ${progress}`);
    if (bits.length) lines.push(bits.join(" | "));
    return lines.join("\n");
}

/**
 * 渲染一条实体的 desc。
 *
 * `handle.desc` 有**两种真实形态**（两个并行实现约定不同，prompt 必须都吃得下）：
 *   · 摘要式（契约 §Q3.2 的短语）：`belt 上游=无 下游=C1.left 货=0/12 段=path#3`
 *   · 完整式（handles.mjs 现在的 describeEntity）：`B7 belt 上游=B9 下游=C1.left 货=0 段=3`
 *     —— 它自己带了 `<handle> <type>` 前缀。
 * 直接拼会得到 `B7 belt B7 belt 上游=…`：既费预算，又让同一个句柄在**一行里出现两次**，
 * 模型照着抄一句就多了一个幻觉句柄的来源。这里把恰好重复的前缀摘掉，其余原样保留。
 */
function renderDesc(handle, type, desc) {
    if (!desc) return "";
    let d = sanitize(desc).text.trim();
    const pre = `${handle} ${type}`;
    if (d === pre) return "";
    if (d.startsWith(pre + " ")) d = d.slice(pre.length + 1).trim();
    return d ? " " + d : "";
}

function renderHub(tbl) {
    const hub = tbl.hubHandle ? tbl.byHandle.get(String(tbl.hubHandle)) : null;
    if (!hub) return "## HUB\n(no hub handle in this table — do not reference a hub)";
    return `## HUB\n${hub.handle} ${hub.type}${renderDesc(hub.handle, hub.type, hub.desc)}`;
}

/**
 * 诊断里点名过的 handle（按出现顺序去重）。带子列表与机器表共用这一份口径 ——
 * 两份"什么算相关"就是两份真值。
 */
function referencedHandles(diagnoses) {
    const out = [];
    const add = h => { if (h && !out.includes(String(h))) out.push(String(h)); };
    for (const d of diagnoses || []) {
        for (const h of (d && d.evidence && d.evidence.handles) || []) add(h);
        if (d && d.subject && d.subject.handle) add(d.subject.handle);
        if (d && d.slot && d.slot.cell_ref) add(d.slot.cell_ref);
    }
    return out;
}

/**
 * 机器表：诊断点名的机器**排前面**（否则 20 台机器的上限会在真实存档上把真正的
 * subject 挤掉 —— L5 有 21 台机器，截到 20 台时排最后的那台正好可能是 cutter）。
 */
function renderMachines(tbl, diagnoses) {
    const all = [...tbl.byHandle.values()].filter(e => !isBeltType(e.type) && e.type !== "hub");
    const ref = referencedHandles(diagnoses);
    const rank = h => { const i = ref.indexOf(h); return i < 0 ? ref.length : i; };
    const ordered = [...all].sort((a, b) => (rank(a.handle) - rank(b.handle)) || 0);
    const shown = ordered.slice(0, PROMPT_RULES.MACHINES_MAX);
    const lines = [`## MACHINES (${shown.length} of ${all.length})`];
    if (!all.length) lines.push("(none)");
    for (const e of shown) {
        lines.push(`${e.handle} ${e.type}${e.variant && e.variant !== "default" ? `(${e.variant})` : ""}`
            + (e.desc ? renderDesc(e.handle, e.type, e.desc) : ""));
    }
    if (all.length > shown.length) lines.push(`(+${all.length - shown.length} more machines not shown)`);
    return lines.join("\n");
}

/**
 * 与诊断相关的带子，最多 STATE_BELTS_MAX 条。
 *
 * 选取口径（纯字符串，不碰几何）：
 *   ① 诊断里点名过的 handle（`evidence.handles` / `subject.handle` / `slot.cell_ref`）里属于带子的；
 *   ② 不够 12 条时用句柄表顺序补足（**确定性**；表顺序由 handles.mjs 的 (y,x) 规则钉住）。
 * 补足这一步是必要的：冷启动第一轮常常没有诊断（或诊断只点名机器），而改造对象正是带子。
 * 代价是「没被诊断点名的带子」会按表顺序进入 prompt —— 这一点记在 blocks 里（`belts_padded`）。
 */
function pickBelts(tbl, diagnoses) {
    const wanted = referencedHandles(diagnoses);
    const referenced = wanted.filter(h => {
        const e = tbl.byHandle.get(h);
        return !!e && isBeltType(e.type);
    });
    const all = [...tbl.byHandle.values()].filter(e => isBeltType(e.type));
    const padded = [];
    for (const e of all) {
        if (referenced.length + padded.length >= PROMPT_RULES.STATE_BELTS_MAX) break;
        if (!referenced.includes(e.handle)) padded.push(e.handle);
    }
    const ordered = [...referenced, ...padded].slice(0, PROMPT_RULES.STATE_BELTS_MAX);
    return { ordered, referenced, padded, total: all.length };
}

function renderBelts(tbl, selection, shownCount, omittedByBudget) {
    const shown = selection.ordered.slice(0, shownCount);
    const lines = [`## BELTS (${shown.length} of ${selection.total}; ${selection.referenced.length} referenced by diagnosis)`];
    if (!shown.length) lines.push("(none shown)");
    for (const h of shown) {
        const e = tbl.byHandle.get(h);
        lines.push(`${e.handle} ${e.type}${renderDesc(e.handle, e.type, e.desc)}`);
    }
    const omitted = Math.max(0, selection.ordered.length - shown.length) + Math.max(0, selection.total - selection.ordered.length);
    if (omittedByBudget || omitted) lines.push(`(+${omitted} belts not shown)`);
    return lines.join("\n");
}

function renderProduction(obs) {
    const p = obs && obs.production;
    if (!p || typeof p !== "object") {
        return "## PRODUCTION\nunavailable (obs.production absent) — decide from the diagnosis, do not assume anything is running";
    }
    const lines = ["## PRODUCTION"];
    let n = 0;
    const push = (k, v) => { if (n < 10) { lines.push(`${k}: ${v}`); n++; } };
    if (num(p.window_seconds) !== null) push("window_seconds", p.window_seconds);
    const totals = p.produced_total && typeof p.produced_total === "object" ? Object.entries(p.produced_total) : [];
    for (const [k, v] of totals.slice(0, 4)) push(`produced ${sanitize(k).text}`, v);
    const rates = p.delivered_per_sec && typeof p.delivered_per_sec === "object" ? Object.entries(p.delivered_per_sec) : [];
    for (const [k, v] of rates.slice(0, 4)) push(`rate ${sanitize(k).text}`, v);
    if (n === 0) lines.push(compact(p, 200));
    return lines.join("\n");
}

function resolveLimits(budget) {
    const b = (budget && typeof budget === "object") ? budget : {};
    const pick = (...names) => {
        for (const k of names) if (num(b[k]) !== null && b[k] > 0) return b[k];
        return null;
    };
    return {
        inCharsMax: pick("in_chars_max", "LLM_IN_CHARS_MAX", "inCharsMax") || PROMPT_RULES.LLM_IN_CHARS_MAX,
        tokensMax: pick("prompt_tokens_max", "PROMPT_TOKENS_MAX", "promptTokensMax") || PROMPT_RULES.PROMPT_TOKENS_MAX,
    };
}

function renderBudget(budget) {
    const b = (budget && typeof budget === "object") ? budget : null;
    const keys = ["rounds_left", "llm_calls_left", "tx_left", "ticks_left", "wall_ms_left"];
    const bits = [];
    if (b) for (const k of keys) if (num(b[k]) !== null) bits.push(`${k} ${b[k]}`);
    return "## BUDGET\n" + (bits.length ? bits.join(" | ") : "not provided (assume a single attempt)");
}

/* ══════════════════════════ 7. S4 / S5 / S6 ══════════════════════════ */

/**
 * S4：每条诊断一行，形状是契约里的
 *   `code [layer/severity]: subject; expected ... vs observed ...; handles ...; candidates ...`
 * 硬规矩：**不打印 uid**（§Q3.2），不打印 cell 数字（只打 handle）；诊断条数不截断。
 */
function renderDiagnoses(diagnoses) {
    const list = Array.isArray(diagnoses) ? diagnoses : [];
    const lines = [`## DIAGNOSIS (${list.length})`];
    if (!list.length) {
        lines.push("(no diagnosis: this is the first round, fix the goal directly)");
        return lines.join("\n");
    }
    list.forEach((d, i) => {
        const code = (d && d.code) || "UNKNOWN";
        const layer = d && d.layer ? `[${d.layer}${d.severity ? "/" + d.severity : ""}]` : "";
        const subj = d && d.subject
            ? [d.subject.handle, d.subject.type ? `(${d.subject.type})` : ""].filter(Boolean).join(" ")
            : "-";
        const slot = d && d.slot && (d.slot.role || d.slot.index !== undefined)
            ? ` @${d.slot.role || "slot"}${d.slot.index !== undefined ? "[" + d.slot.index + "]" : ""}`
            : (d && d.slot && d.slot.cell_ref ? ` @${d.slot.cell_ref}` : "");
        const exp = compact(d && d.expected, 100);
        const obs = compact(d && d.observed, 120);
        const hs = ((d && d.evidence && d.evidence.handles) || []).slice(0, 6);
        const cands = (d && Array.isArray(d.candidates)) ? d.candidates.slice(0, 3) : [];
        let line = `${i + 1}. ${code}${layer ? " " + layer : ""}: ${subj}${slot}; expected ${exp}; observed ${obs}`;
        if (hs.length) line += `; handles ${hs.join(",")}`;
        if (cands.length) line += `; candidates ${cands.join(",")}`;
        lines.push(sanitize(line).text);
    });
    return lines.join("\n");
}

/**
 * S5：上一轮做了什么 / verify 说了什么。
 *
 * 只带 **宏名 + check 名 + 诊断码**。不带 args（args 里有句柄，会让模型复读上一轮的错误）、
 * 不带坐标（verify 的 evidence 里全是坐标）。
 *
 * 接受两种形态：
 *   {round, calls:[{macro}], verify:{checks:[{name,ok,skipped,degraded}], codes:[]}, decision}
 *   {round, actions:["replace_run"], codes:["SLOT_STARVED"], verdict:"fail"}
 */
function renderLastRound(lastRound) {
    if (!lastRound || typeof lastRound !== "object") {
        return "## LAST ROUND\nnone (this is round 1)";
    }
    const calls = Array.isArray(lastRound.calls) ? lastRound.calls.map(c => (typeof c === "string" ? c : c && c.macro)).filter(Boolean) : [];
    const actions = Array.isArray(lastRound.actions) ? lastRound.actions.map(a => (typeof a === "string" ? a : a && (a.macro || a.action))).filter(Boolean) : [];
    const macros = [...new Set([...calls, ...actions])];
    const checks = (lastRound.verify && Array.isArray(lastRound.verify.checks)) ? lastRound.verify.checks : [];
    const codes = [
        ...(Array.isArray(lastRound.codes) ? lastRound.codes : []),
        ...((lastRound.verify && Array.isArray(lastRound.verify.codes)) ? lastRound.verify.codes : []),
    ];
    const lines = ["## LAST ROUND", `round ${lastRound.round ?? "?"}: calls [${macros.join(", ") || "none"}]`];
    if (checks.length) {
        const parts = checks.slice(0, 8).map(c => {
            const state = c.skipped ? "skipped" : (c.degraded ? "degraded" : (c.ok ? "ok" : "FAIL"));
            return `${c.name} ${state}`;
        });
        lines.push(`verify: ${parts.join("; ")}`);
    }
    if (codes.length) lines.push(`codes: ${[...new Set(codes)].slice(0, 10).join(", ")}`);
    if (lastRound.decision || lastRound.verdict) lines.push(`decision: ${lastRound.decision || lastRound.verdict}`);
    return sanitize(lines.join("\n")).text;
}

const INSTRUCTION = [
    "## YOUR TURN",
    "Output the calls for THIS round as one raw JSON object:",
    '{"say":"...","calls":[{"macro":"...","args":{...},"why":"..."}]}',
    `1 to ${PROMPT_RULES.CALLS_MAX} calls. Handles from this prompt only. No coordinates. JSON only.`,
].join("\n");

/* ══════════════════════════ 8. PromptOverBudget ══════════════════════════ */

export class PromptOverBudget extends Error {
    constructor(message, detail) {
        super(message);
        this.name = "PromptOverBudget";
        this.code = "PROMPT_OVER_BUDGET";
        this.detail = detail;
    }
}

/* ══════════════════════════ 9. 主入口 ══════════════════════════ */

/**
 * 渲染一轮 prompt。
 *
 * @param {object} p
 * @param {string|object} p.goal    形状串（`RuRu----`），或 `{shape, level, required, delivered, progress}`
 * @param {object} p.obs            ObsSnapshot（只用 goal / hub / production；entities 仅用于 uid→实体兜底）
 * @param {object|Array} p.handles  句柄表（见 normalizeHandles 的三种形态）
 * @param {Array} [p.diagnoses]     Diagnosis[]
 * @param {Array} [p.candidates]    宏名 或 {macro, why}；**必须是 MACRO_NAMES 的子集**
 * @param {object} [p.lastRound]    上一轮摘要（见 renderLastRound）
 * @param {object} [p.budget]       {rounds_left, llm_calls_left, tx_left, ticks_left, wall_ms_left,
 *                                   in_chars_max, prompt_tokens_max}
 * @returns {{system:string, user:string, tokens_estimate:number, blocks:object}}
 * @throws {PromptOverBudget} code=PROMPT_OVER_BUDGET（总字符 > in_chars_max）
 * @throws {TypeError} 缺 goal / obs / 未知候选宏
 */
export function buildPrompt({ goal, obs, handles, diagnoses, candidates, lastRound, budget } = {}) {
    if (!obs || typeof obs !== "object") throw new TypeError("buildPrompt: obs is required");
    const goalShape = typeof goal === "string"
        ? goal
        : (goal && typeof goal === "object" ? (goal.shape || goal.goal) : null);
    if (!goalShape || typeof goalShape !== "string") {
        throw new TypeError("buildPrompt: goal shape is required (string, or {shape})");
    }

    const tbl = normalizeHandles(handles, obs);
    const limits = resolveLimits(budget);
    const diagList = Array.isArray(diagnoses) ? diagnoses : [];

    /* ── 不参与截断的块：先渲染一次，之后逐字节复用 ── */
    const s1 = SYSTEM_PROMPT;
    const s2 = renderCards(candidates);
    const s3Goal = renderGoal(goalShape, goal, obs);
    const s3Hub = renderHub(tbl);
    const s3Machines = renderMachines(tbl, diagList);
    const s3Production = renderProduction(obs);
    const s3Budget = renderBudget(budget);
    const s4 = renderDiagnoses(diagList);
    const s5 = renderLastRound(lastRound);
    const s6 = INSTRUCTION;

    const selection = pickBelts(tbl, diagList);
    const fixed = [s2, s3Goal, s3Hub, s3Machines, s3Production, s3Budget, s4, s5, s6].join("\n\n");

    /* ── 截断：只动带子列表。目标 = min(token 预算, 字符硬上限) ── */
    const targetChars = Math.min(Math.floor(limits.tokensMax * PROMPT_RULES.CHARS_PER_TOKEN), limits.inCharsMax);
    let shown = selection.ordered.length;
    let s3Belts = renderBelts(tbl, selection, shown, false);
    let user = [s2, s3Goal, s3Hub, s3Machines, s3Belts, s3Production, s3Budget, s4, s5, s6].join("\n\n");
    let trimmed = 0;
    while (s1.length + user.length > targetChars && shown > 0) {
        shown -= 1;
        trimmed += 1;
        s3Belts = renderBelts(tbl, selection, shown, true);
        user = [s2, s3Goal, s3Hub, s3Machines, s3Belts, s3Production, s3Budget, s4, s5, s6].join("\n\n");
    }

    /* ── 硬上限：不静默截断任何东西，直接抛 ── */
    const chars = s1.length + user.length;
    if (chars > limits.inCharsMax) {
        throw new PromptOverBudget(
            `prompt is ${chars} chars > LLM_IN_CHARS_MAX ${limits.inCharsMax}; `
            + "only the S3 belt list may be trimmed, so this is a hard failure (goal/diagnosis must not be truncated)",
            {
                chars, limit: limits.inCharsMax,
                sections: { s1: s1.length, s2: s2.length, s3_goal: s3Goal.length, s3_hub: s3Hub.length,
                    s3_machines: s3Machines.length, s3_belts: s3Belts.length, s3_production: s3Production.length,
                    s3_budget: s3Budget.length, s4: s4.length, s5: s5.length, s6: s6.length },
                diagnoses: diagList.length,
                belts: selection.total,
            },
        );
    }

    const s3 = [s3Goal, s3Hub, s3Machines, s3Belts, s3Production, s3Budget].join("\n\n");
    const blocks = {
        S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6,
        s3_goal: s3Goal, s3_hub: s3Hub, s3_machines: s3Machines, s3_belts: s3Belts,
        s3_production: s3Production, s3_budget: s3Budget,
        chars,
        tokens_estimate: Math.round(chars / PROMPT_RULES.CHARS_PER_TOKEN),
        trimmed_belts: trimmed,
        belts_shown: shown,
        belts_total: selection.total,
        belts_referenced: selection.referenced.length,
        belts_padded: selection.padded.length,
        over_token_budget: chars > Math.floor(limits.tokensMax * PROMPT_RULES.CHARS_PER_TOKEN),
        redactions: countMarks([s2, s3, s4, s5, s6].join("\n"), "coord"),
        redacted_uids: countMarks([s2, s3, s4, s5, s6].join("\n"), "uid"),
        candidates: Array.isArray(candidates) ? candidates.length : 0,
    };

    return {
        system: s1,
        user,
        tokens_estimate: blocks.tokens_estimate,
        blocks,
    };
}

function countMarks(text, kind) {
    const m = String(text).match(new RegExp(`<${kind}>`, "g"));
    return m ? m.length : 0;
}
