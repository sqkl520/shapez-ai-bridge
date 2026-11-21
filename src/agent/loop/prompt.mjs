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
/* 目标形状的配方（solver 算出来的）—— 模型不该自己猜该用哪些机器。
   第四轮实验：5 次里 4 次误以为要 rotater，而 RuRu---- 只需要 cutter 切一半。 */
import { recipeForCached, renderRecipe } from "./recipe.mjs";
/* 合法 machine 值来自 place.mjs 的 SUPPORTED_BUILDINGS —— 不在 prompt 里手抄第二份。
   实测教训：模型写过 "rotator"（应为 "rotater"），整轮白费；卡片里摆出枚举就不该再犯。 */
import { SUPPORTED_BUILDINGS } from "../macros/place.mjs";
/* 只有 pickBeltsForGoal 用得到它们：判断带子的拓扑必须知道机器的真实占地
   （cutter 是 2×1，hub 是 4×4）与机器的**出口格**（判断"这条线最终流向哪里"）。
   按 1×1 算会把「挨着 cutter 第二格」的带子误判成孤立。 */
import { templateByBuildingVariant, worldSlots } from "../../ai/op-templates.mjs";
/* 出口方向：与 handles.mjs / verify_runtime.mjs 同一套约定（rv0=top / rv1=left / rv2=right，
   再按 r 旋转）。自己写一份 EXIT_BASE 就是第三份真值 —— 这个仓库已因两份真值出过事故。 */
import { DIRV, beltExit } from "../../ai/belt-rules.mjs";
/* 从 hub 反向的**物理**可达（穿机器/隧道、每跳验 accepts）：
   prompt 的 `[not reaching hub]` 标记靠它，不再自己在本文件里写一份 BFS。
   `hubReachable` 是另一个问题（诊断 tier 的「能影响 goal」），不要混用。 */
import { flowReachable } from "./topology.mjs";
/* 产能分析：**复用 `assess.mjs`，不在这里重算**。
   为什么必须复用：供给/处理/利用率的算法要跟 `rules.mjs` 的源码核证值绑在一起，
   在 prompt 层再写一遍同样的除法就是第二份真值 —— 这个仓库已经因两份真值出过事故
   （见 `modelsForOneBelt` / `UPGRADES` 的注释）。
   为什么**不会**循环依赖：`assess.mjs` 只 import `rules.mjs`，而 `rules.mjs` 只 import
   node 内置模块。`prompt.mjs` 单向依赖它们，没有回路（测试里也钉住了这一条）。 */
import { capacityFor } from "../assess.mjs";

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
    /* ★ 输入预算 2.8k → 4k tok ★
     *
     * 2800 是按 **37 条带子的小场景**定的（L4 冷启动夹具）。在真实规模上它不够：
     *
     *   2026-11-10 第 9 关（536 条带子 / 8 条诊断 / 37 台机器）实测：
     *     tokensMax=2800 → targetChars 9800 → 输出 7722 字符，**belts_shown: 0**
     *     tokensMax=4000 → 输出 9164 字符，belts_shown: 12
     *
     * 而那一轮模型要做的正是「把 B205/B206 的朝向往回改」——
     * 带子列表为 0 意味着它看不到那两条带子的任何属性（出口朝向、能否到 hub），
     * 只能从诊断里那句 `belt-not-aimed` 猜。
     *
     * 注意 S1（系统规则）本身就占 4716 字符 ≈ 1348 token：2800 的预算里
     * 光规则就吃掉一半，剩下 1452 token 要装 宏卡片(646) + 目标/配方(190) +
     * 机器表(584) + 诊断(564) + 带子 —— 带子抢不到任何名额是**结构性的**。
     *
     * 4000 是实测最小的、能让带子出现的值。 */
    PROMPT_TOKENS_MAX: 4000,
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
    /* ★ 诊断点名带子的保底名额：2 → 6 ★
     *
     * 2 是为 L4 调的（12 条走廊 + 3 条正解，reserve=3 会把 B82 挤出并排段）。
     * 但那个取舍只在「诊断点名 ≤ 2」时才对得上；诊断一多就不成立：
     *
     *   2026-11-10 第 9 关：8 条诊断点名了 **10 条带子**，
     *   而 reserve=2 ⇒ 只有 2 条能进，实测 `3 of 10 referenced shown`。
     *   模型被要求改 B205/B206 的朝向，而那两条从来没出现过。
     *
     * 6 是「能覆盖多数诊断、又给走廊留 6 个名额」的折中（STATE_BELTS_MAX=12）。
     * 真超过 6 条时仍然按原顺序截断 —— 那时该做的是减少诊断，不是加大名额。 */
    STATE_BELTS_DIAG_RESERVE: 6,
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
 * ⚠️ 不在 S1 里写底层模型名：S1 是模块级常量、**必须逐字节稳定**（契约 §Q3.4），
 *    而模型可以随时更换。写死名字会让 system 的哈希漂移，也让「同一份 prompt
 *    两次可复现」这条验收判据失效。身份由 API 调用方决定，不属于世界数据。
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
    /* ★ 2026-11-02：加上「优先只写一个」—— 这是执行率的**决定因素** ★
     *
     * `buildTxPlan` 是**全有或全无**的（R1：一条宏失败 ⇒ 一条 op 都不生成）。
     * 所以整轮成功率 ≈ 单条成功率的 `calls.length` 次方。
     *
     * 实测（`FIVE-ROUNDS-FINAL.md`，五轮 148 条去重样本）：
     *
     *   calls=1   2/2   (100%)      调用越多，整轮越不可能过
     *   calls=2   2/19  (10.5%)
     *   calls=3   4/45  ( 8.9%)
     *   calls=4   0/48  (  0%)   ← 82 条 4+ 调用，一条都没成
     *   calls=5   0/33  (  0%)
     *
     * `calls ≤3` 8/66 vs `calls ≥4` 0/82，Fisher **p = 0.0012**。
     * 而模型 146/148 次写 2-5 个调用 —— 几乎从不写单调用。
     * 这解释了为什么五轮修单条失败都没能提升整轮成功率。
     *
     * ★ 长度纪律（这次是硬碰硬的）★
     *   第一版写了 4 行，直接把 L4 冷启动夹具（`prompt_capacity.test.mjs` A6）
     *   的 CAPACITY 挤出预算（9775/9800，只剩 25 字符）。压到 2 行才腾出来。
     *   这个夹具的余量本来就是 0 —— 任何新增行都会被它挡住。
     *
     * 措辞纪律：只说「优先一个」，**不说「最多一个」** ——
     * 有些修法确实需要两步（先 remove_run 再 replace_run），硬限会逼模型写错。 */
    "2. calls must be an array with 1 to 6 entries. An empty calls array is rejected as a failed plan.",
    `3. The ONLY allowed macro names are: ${MACRO_NAMES.join(", ")}.`,
    "   Never emit build_line, paste_blueprint, or any other name: they are not part of this loop.",
    "4. NEVER output coordinates, positions, rotations, rotation variants, angles, or uids.",
    "   No x/y numbers. No arrays of two or four numbers. Refer to existing things ONLY by handle.",
    "5. Point at existing things with reference operators:",
    '     {"$ref":"B7"}                  one handle -> that entity',
    '     {"$ref":"B7","asCell":true}    one handle -> the cell it occupies',
    '     {"$uids":["B7","B8"]}          a set of handles -> the belts they name',
    '     {"$bbox_of":["B7","B8"]}       a set of handles -> the smallest box covering them',
    '     {"$path_of":["B7","B8"]}       a set of handles -> EXACTLY the cells of those entities',
    "   Any other $-operator (offset, expand, arithmetic) is rejected. Handles must come from THIS prompt.",
    "6. Argument names must be copied verbatim from the macro card. Unknown or misspelled arguments",
    "   (e.g. source instead of from) are rejected and waste a round.",
    "7. A multi-CELL machine is addressed by ONE cell (use asCell) or by the handle of an existing",
    "   entity; the macro derives the footprint and the rotation. Never try to derive them yourself.",
    "8. Do not invent handles. If a thing you need has no handle, say so in `say` and pick a macro",
    "   that works with what IS listed.",
    "9. Prefer the smallest set of calls that can plausibly fix the top diagnosis. Explanations",
    "   belong in `say`/`why` and must not contain numbers that look like positions.",
    "",
    /* ★ 第 10 条：改造既有带子（2026-10-28 真 LLM 实验的直接产物）★
     *
     * 实测 5 次冷启动，模型**从不**删东西 —— 它一致地选 insert_machine
     * （"在旁边加一台机器"），5/5 次都没想到可以把一段既有带子就地改造成机器。
     * 而正解恰好是 replace_run：删三条带子在原地放 cutter+trash。
     *
     * 原因不是模型笨，是 prompt 里没有任何一句话说"改造既有产线"是允许且常见的。
     * insert_machine 与 replace_run 在候选卡片里并列，模型没有理由优先后者。
     */
    "10. Most real tasks are MODIFICATIONS of an existing factory, not greenfield builds.",
    "    Replacing a run of belts in place with a machine (replace_run) is the normal move;",
    "    inserting a machine NEXT TO the existing run usually leaves the old run dead and is",
    "    rarely what you want. If a diagnosis says a run delivers nothing, prefer converting",
    "    that run over adding a parallel one. remove_run is also legitimate: sometimes the fix",
    "    is to delete belts that lead nowhere.",
    /* ★ 10 的第二段：诊断说「没地方放」时怎么办（规则与诊断的矛盾）★
     *
     * 规则 10 的主调是「优先就地改造」，而诊断可能同时说
     * `(a cutter fits at 0 place(s) on the goal corridor)` —— 一条命令一个禁止。
     * 模型夹在中间时最省事的做法是**再试一次 replace_run**，而同一指纹下的
     * 第 2 次必须换动作（`lastExecutedMacros` 会被剔除出候选）、第 3 次直接 halt
     * （`BUDGET.SAME_FINGERPRINT_MAX = 2`，见 `loop.mjs:countFingerprint`）。
     * 所以「没地方放」的正确出路必须写出来，否则「优先改造」这条主调会把人推进死循环。
     *
     * ★ 措辞纪律：上面 6 行**逐字节保持改前原样**，本段只追加在后面 ★
     *   主调仍是「就地改造是常态」，例外**只由诊断触发**（模型看不到几何，
     *   它没有能力自己判断「没地方放」）。prompt_rules.test.mjs 的 B' 断言
     *   「新规则 10 以旧规则 10 全文为前缀」—— 追加而不是改写，丢字在测试里会红。
     *
     * ★ 长度纪律：S1 每多一个字符都吃掉 S3 的带子名额（总预算 12000 是硬的）★
     *   第一版这段写了 9 句，把 l4-coldstart 第 2 轮的 prompt 顶到 12030
     *   → PROMPT_OVER_BUDGET → `INTERNAL` halt（`loop.test.mjs` §11 立刻红）。
     *   压成 4 句后留出余量。再加句子之前先跑 loop.test.mjs §11 —— 它是这条预算的探针。 */
    "    EXCEPTION - if the diagnosis says the machine \"fits at 0 place(s)\" (no site on that",
    "    corridor), in-place conversion is IMPOSSIBLE: do not repeat replace_run on it.",
    "    Instead remove_run that run and build a fresh one, or fix what blocks it first.",
    "    Repeating it cannot work: the 2nd time you must change the action, the 3rd halts.",
    "",
    /* ★ 第 11 条：`$bbox_of` vs `$path_of`（第三轮真 LLM 实验的直接产物）★
     *
     * 实测：模型把一段链的 7 个句柄交给 `$bbox_of`，得到的矩形顺带框进了它没指名的格子，
     * 宏因此报 occupied / not_a_run / precondition_failed。而它「以为」自己只说那 7 格。
     * 差别只在链拐弯或两条链并行时才出现 —— 直线链上两者相同，所以这不是模型能自己发现的。
     * 写在这里是因为：不给这句话，模型没有理由知道这一层几何陷阱存在。 */
    "11. To change a run of belts in place, use $path_of, NOT $bbox_of:",
    "    $bbox_of returns the smallest RECTANGLE around the handles. When the run bends, or when",
    "    two runs sit side by side, that rectangle also covers cells you did not name - and the",
    "    macro will then refuse the call (occupied / not_a_run) even though your handles were right.",
    "    $path_of returns exactly the cells of the named entities. If those cells do not fill their",
    "    own rectangle (the run bends, or you picked across two separate runs), the call is REJECTED",
    "    and the error tells you which cells are missing.",
    "    On a straight one-wide run the two operators give the same region; that is the only case",
    "    where $bbox_of is equally safe.",
    "",
    /* ★ 12：并排链必须**合并**成一次调用（2026-10-28 第五轮实验的直接产物）★
     *
     * 实测：模型分别对每条链调一次 replace_run，每次 `$path_of` 只给一列
     * ⇒ region 宽 1 格 ⇒ **2×1 的 cutter 根本放不下** ⇒ `occupied`。
     * 而正确做法是把两条链的句柄**放进同一次调用**：`$path_of([...链A..., ...链B...])`
     * ⇒ region `[4,-15,5,-10]`（宽 2）⇒ 成功。
     *
     * 第五轮 #3 三条都对（配方对、链对、机器对），只差这一步。
     * 规则 11 原来写的是 "split it into smaller calls" —— 那句话在这里是**反向误导**，
     * 已改成"并排的链要合并，拐弯的链才拆分"。 */
    "12. A 2-cell-wide machine (cutter, stacker, mixer, balancer) needs a region at least 2 cells wide.",
    "    If your targets form TWO parallel runs that feed the same place, put the handles of BOTH",
    "    runs into ONE call - do not fire one call per run:",
    '      replace_run { region: {"$path_of": [...run A handles..., ...run B handles...]}, ... }',
    "    Splitting a parallel pair into two calls gives each call a 1-wide region, and a 2-wide",
    "    machine cannot fit in it. Only split when the chain BENDS (the cells no longer fill their",
    "    own rectangle) - that is a different situation from two parallel runs.",
    "    If you are unsure how many runs feed the same place, make ONE call with every handle you",
    "    consider relevant; the macro rejects a region that cannot hold the machine instead of",
    "    silently placing it somewhere else.",
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
    remove_machine: { macro: "remove_machine", args: { uids: { $uids: ["M1"] } } },
    extend_line: { macro: "extend_line", args: { from: { $ref: "B7" }, len: 4, dir: "right" } },
    replace_run: {
        macro: "replace_run",
        /* 例子里用 `$path_of` 而不是 `$bbox_of`：链拐弯/并排时前者是唯一能表达的形态
           （`$bbox_of` 会顺带框进没指名的格子，宏随即报 occupied / not_a_run ——
           第三轮实验 5/5 次都栽在这一处，见 SYSTEM_PROMPT rule 11）。
           trash 的 `port` 是 `"right"` 不是 `"left"`：cutter 只有右列是废料
           （`op-templates.mjs` 的 `wasteRoles:["right"]`）。第三轮实验 #5 就是因为这里写了
           left 而 `precondition_failed` —— 示例本身写错，模型照着抄，这一轮就白费了。

           `confirm_waste: true` 也写进示例：第六轮实验 #3 的配方、链、机器全对，
           只因为没写这个字段而 `precondition_failed`。
           它的语义是"我知道 trash 会永久销毁这条还在供货的链" —— 在"把一段活链改造成
           cutter+trash"这个最常见的场景里，**它总是需要的**。示例里缺它，模型就漏。 */
        args: {
            region: { $path_of: ["B7", "B8", "B9"] },
            /* port 从 wasteRoles 派生（见 LEGAL_VALUES）；此处写死 left 是为了示例可读，
               有测试断言它与 op-templates 同向，写反了会红。 */
            building: [{ kind: "cutter" }, { kind: "trash", port: "left", confirm_waste: true }],
        },
    },
    trash_unused: { macro: "trash_unused", args: { outlet: { $ref: "C1", port: "left" }, opts: { confirm_waste: true } } },
});

/**
 * 卡片的参数表：丢掉 `opts.dry_run`（loop 不让 LLM 决定 dry-run），最多 6 条。
 *
 * ## 2026-11-02：`opts.*` 后面要带一句「它是干什么的」
 *
 * 原来只印 `名字:类型?`，于是 `connect` 的卡片长这样：
 *
 *     params: from:Endpoint, to:Endpoint, opts.rebind:boolean?, opts.allow_replace:boolean?
 *
 * —— **两个 boolean 开关，名字看不出区别，也没说解哪个错**。
 *
 * 实测（`EXECUTION-RATE-BOTTLENECK.md`，58 条真实存档样本）：
 *   4 次 `port_already_bound`（`from.port` 已被占，只有 `opts.rebind=true` 能解）
 *   3 次 `target_already_fed`（`to.port` 已被供料，同样只有 `rebind`）
 *   6 次 `occupied`（路径撞带子，只有 `opts.allow_replace` 能解）
 *
 * 而 `contract.mjs:1135-1139` 里这两个参数的 `description` **写得很清楚**
 * （「口上的开关」vs「路上的开关」，各自对应哪个错误码）——
 * 只是 `renderParams` 从来没把它渲染出来。
 *
 * 修法：`opts.*` 的参数在名字后面附上 `description` 的**首句**（到第一个中文句号/分号），
 * 非 `opts.*` 的参数不变（它们的名字已经够清楚，加了只是吃预算）。
 */
function renderParams(spec) {
    /* 只取首句，避免把整段说明塞进卡片（预算很紧，见 PROMPT-BUDGET-DEFECT.md）。
       30 字符够说清「哪个开关管哪件事」，又不至于把 params 行撑到 300+ 字符。 */
    const firstClause = (s) => {
        const t = String(s || "").replace(/\*\*/g, "").trim();
        const m = t.split(/[。；;，,]/)[0];
        return m.length > 30 ? m.slice(0, 28) + "…" : m;
    };
    const ps = spec.params
        .filter(p => p.name !== "opts.dry_run")
        .slice(0, 6)
        .map(p => {
            const base = `${p.name}:${p.type}${p.required ? "" : "?"}`;
            /* 只给 `opts.*` 加说明：它们才是「光看名字猜不出来」的那批 */
            if (!/^opts\./.test(p.name)) return base;
            const d = firstClause(p.description);
            return d ? `${base}  // ${d}` : base;
        });
    return ps.join(", ");
}

/**
 * 每张卡片后面附的「合法值」提示。
 *
 * 为什么要单独一张表（2026-10-28 真 LLM 实验）：
 *   实测 5 次里第 2 次模型写了 `"machine":"rotator"` —— 正确是 `rotater`。
 *   宏正确地拒了（unsupported_building），但那一轮就白费了。
 *   这不是模型笨，是**我们没把合法值告诉它**：`machine` 的类型写的是 `string|{kind,variant}`，
 *   看着像自由文本。把枚举直接摆在卡片里，这类错就没了。
 *
 * 值不在这里手抄 —— 从 `place.mjs` 的 `SUPPORTED_BUILDINGS` 取，避免第二份真值。
 */
const LEGAL_VALUES = Object.freeze({
    insert_machine: (goalShape, optsArg) => {
        try {
            const opts = optsArg || {};
            const names = Object.keys(SUPPORTED_BUILDINGS);
            /* `$ore` 的示例矿种**跟着目标走**，不许写死 `Cu`。
             *
             * 旧版写的是 `形状矿用前缀（"Cu"/"Ru"）` —— 在目标是 Ru 的关卡里，
             * 模型读到 "Cu" 会以为要去连铜矿。这是**唯一**告诉模型
             * 「有一个能指名矿格」的地方（见上面那段注释），写错颜色的代价特别高。
             *
             * ⚠️ 不能从形状串的色号反推形状矿前缀：
             * 色号 `R` 是 red，而形状矿 `Ru` 是钌 —— 两者只是字母撞上了，
             * 语义上完全无关。第一版就是这么推出个 `"Re"`（既不是颜色也不是矿种）。
             *
             * 所以这里只做一件确定的事：如果调用方给了**实际存在的矿种列表**，
             * 从中挑一个形状矿当例子。给不出就退回中性写法，不编造。 */
            let shapeEx = null;
            let pigEx = null;
            const kindsList = Array.isArray(opts.oreKinds) ? opts.oreKinds : [];
            for (const k of kindsList) {
                const ks = String(k);
                /* 形状矿：两字母一段的大写开头串，如 `CuCuCuCu` / `RuRuWuWu` */
                if (!shapeEx && /^(?:[A-Z][a-z])+$/.test(ks)) {
                    shapeEx = ks.slice(0, 2);
                }
                /* 颜料矿：纯小写单词 */
                if (!pigEx && /^[a-z]{3,8}$/.test(ks)) {
                    pigEx = ks;
                }
            }
            const shapeHint = shapeEx ? `"${shapeEx}"` : '"<shape ore prefix>"';
            const pigHint = pigEx ? `"${pigEx}"` : '"red"/"blue"';
            return `machine ∈ {${names.join(" | ")}}   (note the spelling: "rotater", not "rotator")`
                + `; at 也可写 {"$ore":"<矿种>"} 让宏挑一格矿 —— 形状矿用前缀（${shapeHint}），`
                + ` 颜料矿用颜色名（${pigHint}）。只是选格，facing 仍要给`;
        } catch { return null; }
    },
    replace_run: () => {
        try {
            const names = Object.keys(SUPPORTED_BUILDINGS);
            /* ★ trash 的 port 必须是**该机器真的会扔东西**的那一路（2026-10-28 第三轮实验 #5）★
             *
             * 实测：模型给了 `[cutter, trash(port:"left")]`，region 也选对了，宏却回
             * `precondition_failed: cutter 的 "left" 槽不在模板 wasteRoles（right）里`。
             * cutter 的两个输出是 left/right，但**只有 right 是废料**（半切后右列），
             * 所以 trash 只能接 right。这句话不写出来，模型只能二选一猜。
             *
             * 值从 `templateByBuildingVariant` 的 `wasteRoles` 取（不手抄第二份真值）。
             * ⚠️ 这是 warning 级的**唯一**来源：`wasteRoles` 缺失时**不输出**这一行，
             *    而不是硬编码 "right" —— 硬编码就是第二份真值。 */
            const w = wasteRolesOf("cutter");
            const waste = w && w.length ? `   trash after a cutter must use port "${w.join('" or "')}" (that is the waste side; the other output is the kept half)` : "";
            return `building[].kind ∈ {${names.join(" | ")}}   ("belts are not a building here")${waste}`;
        } catch { return null; }
    },
});

/** 一台机器的「注定是废料」的输出槽 role（来自 op-templates 的 `wasteRoles`，缺失返回 null）。 */
function wasteRolesOf(kind) {
    try {
        const tpl = templateByBuildingVariant(kind, "default");
        return tpl && Array.isArray(tpl.wasteRoles) && tpl.wasteRoles.length ? tpl.wasteRoles : null;
    } catch { return null; }
}

function renderCard(name, opts = {}) {
    const spec = MACRO_SPECS[name];
    const ex = MACRO_EXAMPLES[name];
    const notUse = (spec.whenNotToUse && spec.whenNotToUse[0]) || "";
    /* ★ 正向用途：**预算允许时**才渲染 ★
     *
     * 只渲染 `whenNotToUse` 会造成**选择偏差**：一张卡如果全是「不要用」，
     * 模型就没有理由选它。实测（`.tmpverify/ore-ab/`，16 样本）：
     * `replace_run` 被选 10 次 / `remove_run` 4 次 —— 而 `remove_run` 的卡
     * 当时只有三条 whenNotToUse、一条 whenToUse 都没有。
     *
     * ⚠️ 但这行**不能无条件加**。`prompt_capacity.test.mjs` 的 D1 守着
     * 「插入 CAPACITY 不减少 belts_shown」，而 CAPACITY 只有 120 字符余量窗口。
     * 每卡 +58 × 3 卡 = +174 会吃掉那个窗口 ⇒ 带子从 11 掉到 7 ⇒ D1 变红。
     *
     * 那是**真回归**：带子是**操作对象**（模型少了它就无对象可改），
     * 卡片描述是辅助。所以 `when` 让位。
     *
     * 折中：默认**不加**（`opts.includeWhen` 缺省 false），调用方在预算宽裕时
     * 显式打开。这样：
     *   · 默认档的渲染与加这个字段之前**逐字节相同**（D1/D2/B6 全部不受影响）；
     *   · 生产路径（16000/4600）打开它，模型拿得到「该用」这个新信息。
     * 用 `blocks.when_lines_shown` 记录它到底进没进 prompt —— 与 CAPACITY 同口径。 */
    const useFor = (opts.includeWhen === true && spec.whenToUse && spec.whenToUse[0]) || "";
    const lines = [
        `### ${name}`,
        sanitize(spec.summary).text.trim(),
        `params: ${sanitize(renderParams(spec)).text}`,
        ...(useFor ? [`when: ${clip(sanitize(useFor).text.trim(), 110)}`] : []),
        `not when: ${clip(sanitize(notUse).text.trim(), 170)}`,
        `example: ${JSON.stringify(ex)}`,
    ];
    /* 合法值提示（防拼错）：见 LEGAL_VALUES 的注释 */
    const lv = LEGAL_VALUES[name];
    if (lv) {
        /* 把当前目标形状传进去 —— `$ore` 的示例必须用**这个目标真正要的矿**。
           写死 `"Cu"` 会让模型在目标是 Ru 的关卡里以为要去连铜矿。 */
        const v = lv(opts.goalShape || null, opts);
        if (v) lines.push(`legal values: ${v}`);
    }
    /* ★ 条件必填的参数：`?` 会骗人 ★
     *
     * 真机实测（2026-11-03）：模型三轮都写了 `insert_machine` **不带 facing**，
     * 因为 `params:` 行里是 `facing:Face?` —— 那个 `?` 表示 `spec.required === false`。
     * 但 `paramRules.facing.requiredWhen` 说「machine 有输出槽且可旋转 ⇒ 必填」，
     * 结果三轮全被 `ambiguous_site` 拒（`miner 有 1 个输出槽且可旋转 ⇒ facing 必填`）。
     *
     * 也就是说：**prompt 把「条件必填」渲染成了「可选」**，模型照着信了。
     * 这一行把那条规则原话搬上去，成本 ~90 字符，只对真有条件规则的宏出现。
     *
     * 为什么不是改 `?` 的渲染逻辑：`required:false` 对 trash 这类机器**确实**是可选，
     * 把 `facing` 全局标成必填会让 trash 的调用方多写一个无意义的字段。
     * 条件性必须条件着说。 */
    const ruleLines = conditionalParamHint(spec);
    if (ruleLines) lines.push(ruleLines);
    return lines.join("\n");
}

/**
 * 把 `spec.paramRules` 里「条件必填」的那几条渲染成一行。
 *
 * @returns {string|null} 没有任何条件必填规则 ⇒ null（不占预算）
 */
function conditionalParamHint(spec) {
    const rules = spec && spec.paramRules;
    if (!rules || typeof rules !== "object") return null;
    const bits = [];
    for (const [param, r] of Object.entries(rules)) {
        if (!r || typeof r !== "object") continue;
        // 只挑「有时必填」的：requiredWhen 存在 且 该参数在 params 里标的是非必填
        const decl = (spec.params || []).find(p => p.name === param);
        if (!decl || decl.required === true) continue;
        if (typeof r.missingCode !== "string" || !r.missingCode) continue;
        const when = String(r.requiredWhen || "").trim();
        if (!when) continue;
        bits.push(`${param} is REQUIRED when ${sanitize(when).text.trim()} (else ${r.missingCode})`);
    }
    if (!bits.length) return null;
    return `required when: ${bits.join("; ")}`;
}

/**
 * S2。`candidates` 的每一项可以是宏名字符串，或 `{macro, why}`（retrieve.mjs 的形态）。
 * 未知宏名**直接抛**，不静默丢弃：静默丢弃会让「检索表写错了」变成「模型就是没被提示」。
 */
function renderCards(candidates, opts = {}) {
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
    /* ⚠️ 必须包一层箭头函数。直接写 `names.map(renderCard)` 会让 map 把
       `(item, index, array)` 三个参数依次传进 renderCard，于是第二参 `opts`
       收到的是一个**数字**（索引），`opts.includeWhen` 永远是 undefined ——
       `when:` 行会静默消失，而且不报任何错。 */
    return [`## CANDIDATE MACROS (${names.length})`, ...names.map((n) => renderCard(n, opts))].join("\n\n");
}

/* ══════════════════════════ 4. 句柄表适配 ══════════════════════════ */

/**
 * 句柄表的**容忍式适配器**。handles.mjs 由并行的另一个 agent 实现，它的 `byHandle` 值可能是
 * 实体对象、uid 数字、或 `{handle, uid, type, desc}` 摘要。这里三种都吃：
 *
 *   {byHandle: Map|Object, hubHandle, goalHandle, version}   契约 §Q3.2 的形态
 *   [{handle, type, ...}, ...]                                数组形态
 *
 * **只搬运 handle / type / variant / uid / desc 五个字段** —— x/y/r/code 在这一步就被丢掉，
 * 后面的渲染代码根本拿不到它们。这是「prompt 不含坐标」的第一层保证（不是靠自觉）。
 *
 * `uid` 是**身份**不是**坐标**：它不进任何渲染（渲染只读 handle/type/desc），只用于
 * `pickBeltsForGoal` 把 obs 的几何（只有 uid 没有句柄）与句柄表对齐。少了它，
 * 几何判据会静默退化成"全部带子都无坐标" —— 那正是 2026-10-29 那个 bug 的成因。
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
        byHandle.set(h, { handle: h, type: String(type), variant, uid, desc });
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
    /* ★ 「没人挖的颜料」提到 GOAL 段（2026-11-16 凌晨，L12 真机）★
     *
     * 那行 `⚠️ NO miner is digging blue` 原来是 `## MACHINES` 段的**最后一行**，
     * 实测 prompt 16071 字符里它排在第 2530 字符之后、又藏在一长串机器清单末尾 ——
     * 模型连着 4 次 run 一次都没提过它，全在修带子和清垃圾桶。
     *
     * 这不是「信息没送到」（它在 prompt 里），是**位置太靠后**。
     * 而它是这一关唯一真正的阻塞：`CbCbCbRb:CwCwCwCw` 需要 cyan 和 white，
     * 两者都要 blue，而 6 台矿机全在挖 red/green。
     *
     * 提到 `## GOAL` 下面紧跟目标条数 —— 模型读目标时一定会读到它。
     * 只放一行、只说缺的那几种，不重复资源清单（那段还在 MACHINES 里）。 */
    const gapLine = renderMinerColorGap(obs, goalShape);
    if (gapLine) lines.push(gapLine);
    return lines.join("\n");
}

/**
 * 「目标需要的颜色里，哪些没有任何一台矿机在挖」—— 一行短句。
 *
 * 与 `renderGoalResource` 的分工：那个回答「地图上有没有这种矿」，
 * 这个回答「**我的矿机有没有在挖它**」。两个问题不同，答案也可以不同：
 * L12 的 blue 有 1794 格，而 6 台矿机一台都没挖 —— 只看前者会以为「有矿就行」。
 *
 * 只对**颜料矿**（纯小写单词）给 `$ore` 建议：形状矿挖出来是形状，
 * 不是颜料，混进 mixer 的 color 槽什么也混不出来。
 *
 * @returns {string|null} 不缺时返回 null（不占预算）
 */
function renderMinerColorGap(obs, goalShape) {
    const list = obs && Array.isArray(obs.resources) ? obs.resources : null;
    const ents = obs && Array.isArray(obs.entities) ? obs.entities : null;
    if (!list || !list.length || !ents) return null;
    const ents_miners = ents.filter(e => e && e.type === "miner");
    if (!ents_miners.length) return null;

    const COLOR_LETTER_TO_NAME = {
        r: "red", g: "green", b: "blue", y: "yellow", p: "purple", c: "cyan", w: "white",
    };
    /* ★ 只有**小写**字母是颜色（2026-11-16 凌晨）★
     *
     * 形状串的约定：大写 = 下层、小写 = 上层，而**颜色**用色号字母表示。
     * 但 `RuRu----` 里的 `R`/`u` 是**形状矿** `Ru` 的两个字母，不是颜色。
     *
     * 第一版把 `R` 映射成 `red`，于是 L4（目标 `RuRu----`）报出
     * 「NEEDS red but no miner is digging it」—— 而 L4 要的是 **Ru 形状**，
     * 不是红色颜料。8 台矿机里 3 台正好在挖 `RuRuRuRu`，完全够用。
     *
     * ## 正确的解析：形状串的**每一对**是 (形状码, 色码)
     *
     * `shape-ops.mjs:27-46` 的 `parse()` 写得很清楚：
     *
     *   · 每层 8 字符 = 4 个象限 × (形状码 + 色码)
     *   · 形状码 `R`=rect / `C`=circle / `S`=star / `W`=windmill（**大写**）
     *   · 色码   `r`=red / `g`=green / `b`=blue / `y`=yellow /
     *            `p`=purple / `c`=cyan / `w`=white / `u`=uncolored（**小写**）
     *   · `:` 分隔的是**层**（下 → 上）
     *
     * 所以 `CbCbCbRb:CwCwCwCw` 是：下层 3 个「圆形+blue」+ 1 个「矩形+blue」，
     * 上层 4 个「圆形+white」。**需要的颜料只有 blue 和 white** ——
     * 既不需要 cyan，也不需要 red。
     *
     * 之前的「只取小写字母」恰好蒙对了这一次（色码全在偶数位），
     * 但那不是因为它算对了，是因为运气。按对解析才是对的语义：
     * 万一哪天目标是 `RbCbCbCb` 这种以形状码结尾的，逐字符判断就会跑偏。 */
    const letters = new Set();
    for (const layer of String(goalShape || "").split(":")) {
        for (let q = 0; q + 1 < layer.length; q += 2) {
            const colorCode = layer[q + 1];
            if (/[a-z]/.test(colorCode) && colorCode !== "u") letters.add(colorCode);
        }
    }
    if (!letters.size) return null;

    /* 地图上有哪些**颜料**矿 */
    const pigmentOres = new Set();
    for (const r of list) {
        if (!Array.isArray(r) || r.length < 3) continue;
        const k = String(r[2]);
        if (/^[a-z]+$/.test(k)) pigmentOres.add(k);
    }
    /* 矿机在挖哪些颜料 */
    const oreAt = new Map();
    for (const r of list) if (Array.isArray(r) && r.length >= 3) oreAt.set(`${r[0]},${r[1]}`, String(r[2]));
    const dug = new Map();
    for (const m of ents_miners) {
        const k = oreAt.get(`${m.x},${m.y}`);
        if (k) dug.set(k, (dug.get(k) || 0) + 1);
    }
    if (!dug.size) return null;

    /* 需要的颜料里，哪些地图上有、但没人挖 */
    const missing = [];
    for (const L of letters) {
        const word = COLOR_LETTER_TO_NAME[L.toLowerCase()];
        if (!word || !pigmentOres.has(word)) continue;       // 地图上没有这种颜料矿
        if (dug.has(word)) continue;                          // 已经有人在挖
        missing.push(word);
    }
    if (!missing.length) return null;

    const dugText = [...dug].map(([k, n]) => `${k}×${n}`).join(", ") || "(none)";
    return `⇒ ⚠️ NEEDS ${missing.join("/")} but no miner is digging it `
        + `(you have ${ents_miners.length} miner(s) on ${dugText}). `
        + `Fix this FIRST: \`insert_machine {at:{"$ore":"${missing[0]}"}, machine:"miner", facing:<dir>}\`. `
        + `Everything else is downstream of this.`;
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

/**
 * `## HUB` 段：入口占用情况 + **存着哪些形状**。
 *
 * ## 为什么必须给 `stored_shapes`（2026-11-21，代价很大的一条教训）
 *
 * 这份世界里 `hub.stored_shapes['CgScScCg'] = 2071`。
 * 而 `CgScScCg` 正是**上一关（L11）的目标形状**（`levels.js:242`），
 * 1000 件就通关了 —— 那 2071 件是上一关的遗留库存，不是废品。
 *
 * 同一份世界里，模型连续两轮都在修 `painter#13552` 的 color 槽。
 * 我和几个 agent 也花了大半天查那条死锁链。查完才发现：
 * **那条链是 L11 的产线** —— 接绿色它吐出 `CgScScCg`（L11 目标），
 * 接蓝色它吐出 `CbScScCb`（废品）。七种颜色全试过，没有一种能产出 L12 要的
 * `CbCbCbRb:CwCwCwCw`。它的另一路进料是 `ScSc----`（星形半片），
 * 而目标里一个星形都没有。
 *
 * 也就是说：**修通它等于把上一关的线修回去，与这一关完全无关。**
 * 而模型看不到 hub 里存着什么，就永远推不出这件事 —— 它只知道"这台 painter 缺色"。
 *
 * `hub.stored_shapes` 从 obs 里一直都有，只是从来没进过 prompt。
 * 这是 `computed-but-never-delivered` 的第三次重演，代价这次是**一整轮排查方向错误**。
 *
 * ## 口径
 *
 * 只列**件数够多**的（≥ `HUB_STORED_MIN`），按件数降序取前 `HUB_STORED_MAX` 个。
 * 目标形状自己标 `← goal`，其余标 `← not the goal`。
 * 形状串本身**不解释**（不去猜它属于哪一关）—— 模型有 SHAPE CODE CHEAT SHEET，
 * 让它自己对照目标读。这里只负责把事实送到它眼前。
 *
 * 没有 `stored_shapes` 数据时整段不出现（不猜）。
 */
function renderHub(tbl) {
    const hub = tbl.hubHandle ? tbl.byHandle.get(String(tbl.hubHandle)) : null;
    if (!hub) return "## HUB\n(no hub handle in this table — do not reference a hub)";
    return `## HUB\n${hub.handle} ${hub.type}${renderDesc(hub.handle, hub.type, hub.desc)}`;
}

/** 件数低于它就当噪声不列（碎片化的半成品会有很多 1、2 件的小额）。 */
const HUB_STORED_MIN = 50;
const HUB_STORED_MAX = 6;

/**
 * `hub.stored_shapes` 里值得说的那几条。
 *
 * ⚠️ 这里**不做残线判定** —— 判定逻辑在 `obsolete.mjs`，那条路要 `levelChanged` 才开，
 * 而这里只是陈述「云里存着什么」。两件事分开：陈述事实不需要授权，
 * 判定"该拆"需要。混在一起会让 prompt 开始替模型下结论。
 *
 * ## 为什么不能只按件数取前 N
 *
 * 第一版按件数降序取前 6，这份世界的结果是
 * `CrCrCrCr×41662 Cu------×33532 Cu----Cu×27823 RuRuRuRu×14843 …`
 * —— 全是**原料形状**（L4/L5 时代的矿产物，进 hub 是常态，没有信息量），
 * 而真正有用的那条 `CgScScCg×2071`（上一关的目标形状，1000 件就通关）
 * 被挤到了第 8 位，一个字都进不了 prompt。
 *
 * 判据改成「**离目标有多远**」，不是「有多少件」：
 *   ① 目标形状自己（← goal，模型要知道现在存了多少）
 *   ② **看起来像成品**的形状 —— 4 个象限全满、颜色一致的那种
 *      （`CrCrCrCr` / `CgScScCg` / `SbSbSbSb`…）。它们要么是别的关卡的目标，
 *      要么是别的关卡的中间产物。**原料（含 `-`）和小碎片明确排除。**
 *   ③ 剩下仍有余量才按件数补几条原始形状，让模型知道库存规模。
 *
 * 仍然**不解释**形状属于哪一关 —— 模型有 SHAPE CODE CHEAT SHEET，让它自己对照。
 * 这里只负责把最能改变判断的那几条送到它眼前。
 *
 * @returns {string|null} 空/没数据 ⇒ null（整段消失）
 */
function renderHubStored(obs, goalShape, opts = {}) {
    const ss = obs && obs.hub && obs.hub.stored_shapes;
    if (!ss || typeof ss !== "object") return null;
    const goal = typeof goalShape === "string" ? goalShape.trim() : "";
    const goalLower = goal.includes(":") ? goal.split(":")[0] : goal;

    /** 满 4 象限、且每两字符的「形状码+色码」都合法 ⇒ 像一个成品。 */
    const looksFinished = (s) => {
        const body = s.includes(":") ? s.split(":")[0] : s;
        if (body.length !== 8 || body.includes("-")) return false;
        for (let i = 0; i < 8; i += 2) {
            if (!/[RCSW]/.test(body[i])) return false;
            if (!/[rgbypcw]/.test(body[i + 1])) return false;
        }
        return true;
    };
    /** 四个象限**完全一样** ⇒ 这是矿石或单色喷涂的产物，不是"造出来的复合形状"。
     *
     * 判据来自这一关的实测：`CrCrCrCr`(41662) / `CuCuCuCu`(1680) / `ScScScSc`(1680)
     * 全是四格同色同形 —— 它们直接来自矿机，进 hub 是常态，**没有信息量**。
     * 而真正改变判断的 `CgScScCg`(2071) 是 `Cg Sc Sc Cg`（圆绿 + 星青混排），
     * 它只可能是某条产线**加工出来**的，也就意味着"有一条线在造别的东西"。
     *
     * 第一版没有这条判据，short 版挑中的正是 `CrCrCrCr×41662` —— 一个字的有用信息都没有。 */
    const isUniform = (s) => {
        const body = s.includes(":") ? s.split(":")[0] : s;
        if (body.length !== 8) return false;
        const q0 = body.slice(0, 2);
        return body.slice(2, 4) === q0 && body.slice(4, 6) === q0 && body.slice(6, 8) === q0;
    };
    /* 目标本身的两层都要算「成品」，否则 `CwCwCwCw` 会被当成陌生形状再列一遍。 */
    const goalParts = new Set(goal.includes(":") ? goal.split(":") : [goal]);
    void goalLower;

    const finished = [];      // 加工出来的复合形状（最有信息量）
    const uniform = [];       // 四格同色同形（矿石 / 单色喷涂）
    const rest = [];          // 含空格子的中间态
    for (const [k, v] of Object.entries(ss)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < HUB_STORED_MIN) continue;
        const shape = String(k);
        const rec = { shape, n };
        if (shape === goal) { rec.tag = " ← goal"; finished.unshift(rec); continue; }
        if (goalParts.has(shape)) { rec.tag = " ← part of goal"; finished.push(rec); continue; }
        if (!looksFinished(shape)) { rest.push(rec); continue; }
        (isUniform(shape) ? uniform : finished).push(rec);
    }
    const byCount = (a, b) => b.n - a.n;
    finished.sort(byCount); uniform.sort(byCount); rest.sort(byCount);
    if (!finished.length && !uniform.length && !rest.length) return null;

    /* ★ 排序：加工出来的复合形状 > 空白中间态 > 四格同形（矿石）★
     *
     * 矿石排最后不是因为它不重要，而是**它是唯一不携带「这条线在造什么」信息的**
     * —— 矿机直接挖出来就进 hub，任何世界都有。而一条在造 `CgScScCg` 的产线
     * 意味着有一整套 cutter/stacker/rotater 在服务上一关的目标。 */
    const ordered = [...finished, ...rest, ...uniform];

    /* ★ 两档：`short` 只给**最能改变判断的那一条** ★
     *
     * 真机实测（L12，`prompt_tokens_max: 4600`）：不可截断的那几段
     * （S2 候选宏 2841 + S3 5765）已经吃掉 `targetChars` 的绝大部分，
     * 连 CAPACITY 都被丢掉，带子只剩 5 条。full 版（~250 字符）必然装不下。
     *
     * 而这条信息里**真正改变判断的只有一个事实**：「hub 里躺着 2071 件
     * 一个陌生形状」。剩下的库存数字是背景，没有它也能做出正确决定。
     * 所以退化成一条，成本约 60 字符 —— 那是能塞进残量里的量级。 */
    const short = opts.form === "short";
    const shown = short ? ordered.slice(0, 1) : ordered.slice(0, HUB_STORED_MAX + 2);
    if (!shown.length) return null;
    const total = ordered.length;
    const parts = shown.map(r => `${r.shape}×${r.n}${r.tag || ""}`);
    const omitted = total - shown.length;
    /* short 版的引导语也压到最短 —— 它必须在 60 字符量级里说清「这不是废品」。 */
    if (short) {
        return `HUB stored: ${parts.join("  ")}${omitted > 0 ? ` (+${omitted})` : ""}`
            + " — past levels' output; only the goal's own count advances";
    }
    return "stored (past levels stay here; only the goal's own count advances): "
        + parts.join("  ")
        + (omitted > 0 ? `  (+${omitted} more)` : "");
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
function renderMachines(tbl, diagnoses, obs = null, goalShape = null, opts = {}) {
    const all = [...tbl.byHandle.values()].filter(e => !isBeltType(e.type) && e.type !== "hub");
    const ref = referencedHandles(diagnoses);
    const rank = h => { const i = ref.indexOf(h); return i < 0 ? ref.length : i; };
    const ordered = [...all].sort((a, b) => (rank(a.handle) - rank(b.handle)) || 0);
    const shown = ordered.slice(0, Number.isInteger(opts.max) ? opts.max : PROMPT_RULES.MACHINES_MAX);
    const lines = [`## MACHINES (${shown.length} of ${all.length})`];
    /* ★ 图例：desc 里的 `→无` 是**可用性信号** ★
     *
     * 实测（本次会话，`.tmpverify/hintprobe/p0d.mjs`，L4 真实存档）：

     *   desc 显示「→无」的端口 7 个 → **6 个真的能 connect 到 hub**
     *   desc 显示「→有」的端口 17 个 → **0 个能连**（port_already_bound / occupied）
     *
     * 也就是说「端口后面写着"无"」几乎等价于「这个端口是空的、可以用」。
     *
     * **这个信息本来就在 prompt 里，但从来没有解释过这些符号是什么意思。**
     * 模型看到 `输出=top:secondary(→无)` 时，无从知道 `→无` 意味着「这里是空的」，
     * 更不知道「空 = 可连」。
     *
     * 而 `CONNECT-OCCUPIED-DIAGNOSIS.md` 说：7 个唯一 `occupied` 失败里
     * **4 个是端口选错**（选了一个落点被占死的端口）。这条图例直接对准那 4 个。
     *
     * 放在 MACHINES 段头而不是 S1：紧挨着它解释的数据，且 S1 是 prompt cache 的
     * 前缀（改它会让所有缓存失效）。代价只有 1 行。 */
    if (all.length) {
        lines.push("(`(→X)` = TAKEN; `(→无)` = free = USE THIS ONE for connect)");
    }
    if (!all.length) lines.push("(none)");
    /* 矿格表：`obs.resources` 是 [x,y,kind] 三元组。只在有数据时建 ——
       没有它就不知道矿机脚下是什么，也就不能给矿机加标注（绝不猜）。 */
    const oreAt = oreMapOf(obs);
    /* 位置索引：`normalizeHandles` 产出的元素**只有** handle/type/variant/uid/desc，
     * **没有 x/y**（它的职责是「句柄 → 身份」，位置不属于身份）。
     * 而矿机标注要用世界坐标，所以这里按 uid 从 obs 回查一次。
     *
     * ⚠️ 踩过：直接写 `e.x`/`e.y` 会全是 undefined，于是**每一台矿机都被标成「没矿」**
     *    —— 包括脚下明明有钌的那三台。这种"全错"比不标更糟：它会让模型去拆掉
     *    本来正常的矿机。
     *
     * 2026-11-21：不再只在 `oreAt` 存在时才建 —— 「离最近的可接机器多远」
     * 与矿格数据无关，缺了它整条标注就静默消失。 */
    const posByUid = new Map();
    for (const e of (obs && obs.entities) || []) {
        if (e && Number.isInteger(e.uid) && Number.isInteger(e.x) && Number.isInteger(e.y)) {
            posByUid.set(e.uid, e);
        }
    }
    /* 给 `shown` 挂上位置，供 `nearMachineLabel` 用。
     *
     * 为什么不直接改 `normalizeHandles` 让它带上 x/y：那张表的职责是
     * 「句柄 → 身份」，位置不属于身份；把坐标塞进去会让「句柄表里没有坐标」
     * 这条被测试钉住的性质失效（见 handles.mjs 的 bearingOf 注释）。
     * 这里只是给渲染期的一次性视图补一个字段，用 `__` 前缀标明它不是契约的一部分。 */
    if (obs) {
        for (const m of shown) {
            if (m && m.__pos === undefined) m.__pos = posByUid.get(m.uid) || null;
        }
    }
    /* 预算档位：机器多时一律走紧凑式。提到循环前是因为矿机行尾的
       「到最近机器多远」也要跟着降级 —— 8 台矿机 × 一条距离就是 100+ 字符，
       而那正好是把 CAPACITY 挤掉的那个量级（见下面 renderGoalResource 的注释）。 */
    const resCompact = opts.resourceCompact === true || shown.length > 6;
    /* 矿机行尾的「到诊断主语多远」单独一个开关：它比「采什么」贵得多
       （每台 ~11 字符，9 台就是 +200），而「采什么」只要 5 字符且价值明确。
       默认**开**，由 `buildPrompt` 在量完预算后按余量关掉（见那里的 `oreDistance`）。 */
    const oreDistanceOn = opts.oreDistance !== false;
    for (const e of shown) {
        let line = `${e.handle} ${e.type}${e.variant && e.variant !== "default" ? `(${e.variant})` : ""}`
            + (e.desc ? renderDesc(e.handle, e.type, e.desc) : "");
        /* ★ 矿机：**只标出「脚下没有矿」的** ★
         *
         * 实测（2026-11-03 真机）：接在**铜切割机**上的那台矿机 `M1 @(4,-16)`
         * 脚下根本没有矿（7×7 邻域内一格都没有），而 prompt 里它只是平平地写着
         * `M1 miner 输出=top:out(→C2)` —— 模型完全看不出这是一台**永久零产出**的机器。
         * 于是它反复去「修通」那条永远跑不起来的线。
         *
         * ## 为什么第一版**不**标「在采什么」，以及为什么后来改了
         *
         * 第一版对有矿的也写 `[mining RuRuRuRu]`。代价立刻显形：
         * L4 冷启动夹具有 8 台矿机，8 条标注把 prompt 从 4400 涨到 5098，
         * **把 CAPACITY 段整个挤掉了**（`capacity_unavailable: dropped-for-budget`）。
         * 而 CAPACITY 是实测 p≈5e-7 的信息源（见 `AB-PROMPT-RESULT.md`），
         * 优先级远高于「这台矿机在采什么」。
         *
         * 所以当时只标异常的一侧。
         *
         * ## 2026-11-21 改回来（这一次带证据）
         *
         * 离线重放 `tools/replay-plan.mjs` 把实验里采集的 30 个计划原样喂回
         * `buildTxPlan`：**「选中根因」9/10，「真能落地」只有 1/10。**
         *
         * 5/10 死在预演闸门（「可交付带子 -49%~-74%」），而闸门**没有算错** ——
         * 亲手算过 `connect M7→C3.color`：Z 形 70 格，覆盖 288 条正在工作的带子。
         *
         * 根子在选矿机。这份世界里 17 台矿机的分布是：
         *   最近的（`M17`，10 格）踩的是 **Cu 形状矿** —— 给 painter 的 color 槽供不了料；
         *   所有**蓝色**矿机都在 60 格开外；模型挑了 66 格外的 `M7`。
         *
         * 而 prompt 里矿机那行只有 `M7 miner · hub 东北 47 格 输出=right:out(→无)` ——
         * **既没写它在挖什么，也没写它离哪台机器近。** 模型只能瞎挑，
         * 挑完才发现要横穿整个工厂（它看不到，因为那条代价要宏算完才知道）。
         *
         * 「采什么」+「到最近的需要它的机器多远」这两条就是缺的那一环。
         * 预算上只对**显示出来的**矿机加（最多 12 台），且机器多时退化成只报矿种
         * （与 `renderGoalResource` 的 `compact` 同一条降级纪律）。 */
        if (e.type === "miner" && oreAt) {
            const ent = posByUid.get(e.uid);
            if (ent && !oreAt.get(`${ent.x},${ent.y}`)) {
                line += "  [⚠ NO ORE under this miner — it will never produce anything]";
            } else if (ent) {
                const ore = oreAt.get(`${ent.x},${ent.y}`);
                /* 「到诊断主语多远」只在预算宽裕时出现（`oreDistanceOn`）。
                 *
                 * 实测代价：这个真实世界有 9 台矿机，9 条距离标注 = +200 字符
                 * （` · 到C8 52格` ≈ 11 字符 × 9，还有更长的）。
                 * 而在 L4 冷启动夹具（12 条带子名额用满）上，它当场把 prompt 顶过
                 * 实测上限 4520 → 4582，`tohub_machine.test.mjs` 的 E 档打红。
                 *
                 * 那条上限不是「调到通过为止」的产物 —— 它的注释逐笔记着每次上调
                 * 换来了什么（`target ore` 一行 +60、`NO ORE` 标记 +60）。
                 * 距离标注也走同一条纪律：**加新信息不许挤掉既有信息**。
                 *
                 * 但也不能像 `resCompact` 那样按机器数一刀切 —— 真实世界几乎总是
                 * >6 台机器，那样这个功能等于永远不出现。所以判据用**预算余量**：
                 * 调用方在 `buildPrompt` 里量完带子/产能之后才知道还剩多少，
                 * 由它决定要不要开（见下面的 `oreDistance` 选项）。 */
                const near = oreDistanceOn ? nearMachineLabel(ent, shown, e.handle, ref) : "";
                line += ` 采${ore}${near}`;
            }
        }
        lines.push(line);
    }
    if (all.length > shown.length) lines.push(`(+${all.length - shown.length} more machines not shown)`);

    /* ★ 目标原料在地图上的位置 ★
     *
     * 实测（2026-11-03 真机，level 5 / 目标 `Cu----Cu`）：
     *   · 世界里有 4 台矿机，脚下全是**钌**（`resources` 里 18 格 `RuRuRuRu`）；
     *   · 目标要**铜**，铜矿在 53 格外（`[20,5]` 一带）；
     *   · 而 prompt **从头到尾没有一个字**说铜在哪。
     *
     * 于是模型三轮都在修那条钌线的堵塞 —— 它的推理每次都对（"the rotater's
     * output never lands at the hub"），但**物理上不可能产出铜**。
     *
     * 这一段只陈述一个事实：目标颜色有没有矿、在哪、离 hub 多远。
     * 不猜原因、不给修法 —— 那仍然是模型和诊断的事。
     *
     * 只在**有资源数据**时渲染（`obs.resources` 不给就整段消失，
     * 与 CAPACITY/RECIPE 同一条纪律：拿不到数据就不说，绝不猜）。
     *
     * ## 预算：机器多时自动降级成紧凑式
     *
     * L4 冷启动夹具有 8 台矿机，`s3_machines` 就 1716 字符，加一条完整式
     * （~110 字符）会把 prompt 顶到 5009，**把 CAPACITY 整段挤掉**
     * （`capacity_unavailable: dropped-for-budget`）。CAPACITY 是实测 p≈5e-7
     * 的信息源，优先级高于「目标矿有几格、多远」的细节。
     *
     * 所以机器行越多越要省：超过 6 台就给紧凑式（只留「有没有 + 主矿种」）。
     * 判断放在这里而不是调用方，是因为只有这里知道 `shown` 有多长。
     *
     * ⚠️ **这是"缓解"不是"解决"**：L4 夹具上 `target ore` 只有在**没有**它时
     * 才能让 room ≥ 120（测出来是 112 vs 120，差 8 个字符）。也就是说在那种
     * 「机器极多 + 带子名额用满」的极端世界里，这行仍然会把 CAPACITY 顶掉。
     *
     * 但那不是这条信息的问题 —— 是那个夹具本来就贴着上限（基线 5352 字符，
     * CAPACITY 只剩 115 字符余量）。真要彻底解决得让 CAPACITY 先占位、
     * 资源行让位，而那是另一件事（要改 `compose` 的顺序契约，
     * 牵动 `prompt_capacity.test.mjs` 的一整套断言）。这里先做无争议的一半。 */
    /* 调用方可以强制紧凑（预算降级时用）：见 buildPrompt 里那段降级逻辑。
       （定义已提到矿机循环之前，见那里的注释。） */
    if (opts.includeResource !== false) {
        const resLine = renderGoalResource(obs, goalShape, { compact: resCompact });
        if (resLine) {
            lines.push(resLine);
            /* ★ 告诉模型「怎么引用一格矿」 ★
             *
             * 真机实测（2026-11-03）：模型正确诊断出「接在切割机上的矿机脚下没有矿」，
             * 并在 say 里直接说出了缺什么 ——「no ore-patch handle is exposed」。
             * 它想放新矿机到铜矿上，但矿格不是实体、没有句柄，
             * 于是只能猜（r1 猜了别的格子）或写不合法形态（r2 用 `{at:{uid:M1}}` 被拒）。
             *
             * `$ore` 就是补这个洞的。但不写出来模型不知道它存在。
             *
             * ## 为什么它是**可选**的（`opts.includeOreHint`）
             *
             * 这条提示 ~120 字符。L4 冷启动夹具（17 台机器 + 带子名额用满）
             * 在加了它之后从 4460 涨到 4508，又要把 CAPACITY 顶掉。
             * 所以调用方在预算紧张时会把这条也撤掉 —— 但**只撤提示，不撤 `$ore` 能力**
             * （算子照旧可用，只是模型没被告知）。 */
            if (opts.includeOreHint !== false
                && /target ore [A-Z][a-z] IS on the map/.test(resLine)) {
                /* ★ `$ore` 的示例必须与**这批**矿石的颜色一致 ★
                 *
                 * 旧实现写死了 `{"$ore":"Cu"}`。在目标矿是 Ru 的世界里，那句示例
                 * 会让模型以为要去连铜矿 —— 而这一行的上一句刚说「目标矿是 Ru」。
                 *
                 * 更要紧的是：这是**唯一**告诉模型「有一个能指名矿格」的地方。
                 * 实验数据（`.tmpverify/ab-real/`，150 样本）：模型 149/150 提到删除、
                 * 95/150 说「不知道怎么指定位置」，而 `$ore` 出现 **0 次** ——
                 * 因为那批 prompt 里这条提示被预算挤掉了（下面 2388 行那段）。
                 * 补上之后示例至少要对得上。 */
                const kind = (/target ore ([A-Z][a-z]) IS on the map/.exec(resLine) || [])[1];
                if (kind) {
                    lines.push(`(\`{"$ore":"${kind}"}\` anywhere a cell is expected = the nearest ${kind} ore tile — use it as insert_machine.at)`);
                }
            }
        }
    }
    return lines.join("\n");
}

/**
 * `obs.resources` → Map("x,y" → kind)。没有资源数据时返回 null。
 *
 * 单独抽出来是因为「矿机脚下是什么」和「目标矿在哪」两处都要用，
 * 而两者的**缺失语义必须一致**：拿不到就返回 null，让调用方整段跳过，
 * 绝不返回空 Map 假装「哪里都没矿」。
 */
/**
 * 矿机行尾的「挖什么、离要修的那台多远」标注，形如 `采blue · 到C3 66格`。
 *
 * ## 为什么需要它
 *
 * 2026-11-21 离线重放（`tools/replay-plan.mjs`）：30 个实验样本里
 * 「选中根因」9/10，「真能落地」只有 1/10，5/10 死在预演闸门。
 * 查下去发现模型挑了一台 66 格外的蓝色矿机去接 `painter C3` 的 color 槽，
 * 那条路要铺 70 格并覆盖 288 条在跑的带子 —— **闸门拦得对，代价是真的**。
 *
 * 而这份世界里有 17 台矿机：最近的（10 格）踩的是形状矿，供不了色料；
 * 所有蓝色矿机都在 60 格开外。模型在 prompt 里看到的只有
 * `M7 miner · hub 东北 47 格 输出=right:out(→无)` ——
 * **「挖什么」和「离目标多远」两条都没有**，于是只能瞎挑。
 *
 * ## 为什么距离只标到「诊断点名的那几台」，不标到「最近的任意机器」
 *
 * 第一版标「最近的其它机器」，结果在真实世界里 12 台显示机器中有 6 台是矿机、
 * 剩下最近的往往是个 trash 或另一台矿机 —— 那个数字对决策没有用。
 * 模型要回答的是「哪台矿机能便宜地喂到 C3」，所以距离必须是**到 C3 的**。
 *
 * 而 `resCompact`（>6 台机器时开）会在几乎所有真实世界上生效 ——
 * 如果距离跟着它一起降级，这个功能**永远不会出现**，等于没做。
 * 所以距离锚定在诊断主语上：那是模型这一轮唯一被要求动的东西，
 * 每台矿机多 12 个字符，9 台就是 108 —— 与它换掉的那次「70 格大工程」不成比例。
 *
 * 没有诊断主语时才退回「最近的已显示机器」；再没有就不说（绝不猜）。
 *
 * @param {object} minerEnt  obs 里的原始实体（要有 x/y）
 * @param {Array}  shown     MACHINES 段已显示的实体（含 handle/type/__pos）
 * @param {string} selfHandle 自己，用来跳过
 * @param {Array<string>} focus 诊断主语句柄（优先用作锚点）
 * @returns {string} ` · 到C3 66格` 或空串
 */
function nearMachineLabel(minerEnt, shown, selfHandle, focus) {
    /* ★ 没有诊断主语 ⇒ 不标距离 ★
     *
     * 第一版在没有诊断时退回「最近的任意机器」，于是在 L4 冷启动夹具上，
     * 4 台铜矿机全标着 `· 到L1 9格` —— L1 是个 balancer，不是模型这一轮
     * 被要求动的任何东西。那个数字对决策没有价值，还让 prompt 顶过上限制。
     *
     * 模型要回答的问题是「哪台矿机能便宜地喂到**诊断点名的那台**」，
     * 主语不存在时这个问题不成立，就不该占字符。 */
    if (!Array.isArray(focus) || !focus.length) return "";
    if (!minerEnt || !Array.isArray(shown) || !shown.length) return "";
    const dist = p => Math.abs(p.x - minerEnt.x) + Math.abs(p.y - minerEnt.y);
    const usable = shown.filter(m => m && m.handle !== selfHandle && m.type !== "miner" && m.__pos);
    if (!usable.length) return "";
    let best = null;
    for (const m of usable) {
        if (!focus.includes(m.handle)) continue;
        const d = dist(m.__pos);
        if (!best || d < best.d) best = { h: m.handle, d };
    }
    return best ? ` · 到${best.h} ${best.d}格` : "";
}

function oreMapOf(obs) {
    const list = obs && Array.isArray(obs.resources) ? obs.resources : null;
    if (!list || !list.length) return null;
    const m = new Map();
    for (const r of list) {
        if (!Array.isArray(r) || r.length < 3) continue;
        const [x, y, kind] = r;
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        m.set(`${x},${y}`, kind);
    }
    return m.size ? m : null;
}

/**
 * 「目标颜色有没有矿、在哪」—— 一行。
 *
 * @param {object} tbl   normalizeHandles 的产物（要 `obs`）
 * @param {string} goalShape 目标形状串（如 `Cu----Cu`）
 * @returns {string|null} 没有资源数据 / 目标不是纯色形状 ⇒ null（整段不出现）
 */
function renderGoalResource(obs, goalShape, opts = {}) {
    const list = obs && Array.isArray(obs.resources) ? obs.resources : null;
    if (!list || !list.length) return null;
    /* 紧凑模式：只给「有没有」+ 最主要的那个矿种，不带远近档位。
     * 用在 MACHINES 段已经吃掉大部分预算的场合（见 renderMachines 的调法）。 */
    const compactForm = opts.compact === true;

    /* ★ 目标「矿种」怎么取：不要拿形状串的头两个字符当矿名 ★
     *
     * 旧写法是 `/^([A-Z][a-z])/.exec(goalShape)` —— 取 `CbCbCbRb:CwCwCwCw` 的 `Cb`
     * 然后去矿点表里找 `Cb`。但形状串每两格是**颜色对**：
     * `Cb` = 下层 cyan + 上层 blue，`w` 是 white 色号。
     * `Cb` 这种两字母块**永远不是矿种名**，矿种名是 `CuCuCuCu` / `red` / `RuRuWuWu`。
     *
     * 实测 L12：agent 反复说「Cb ore is NOT in the scanned area」，
     * 然后去别处瞎试 —— 它被这句**自己推不出来**的提示误导了。
     *
     * 现在改成从整个形状串里提取**所有**出现过的颜色字母，
     * 逐个报告「这种颜色有没有对应的矿」。这才回答它真正要问的问题：
     * 「做这个形状需要哪些颜料，它们分别在哪」。
     *
     * 单个两字母块（`Cu`）的子形状目标仍然走老路 —— 那种情况下 `Cu` 确实既是
     * 色号也是矿种前缀，两者恰好重合。 */
    const shapeStr = String(goalShape || "");
    /* ★ 形状码与色码必须分开取（2026-11-16）★
     *
     * 每层 8 字符 = 4 象限 × (形状码 + 色码)：
     *   形状码 `R`/`C`/`S`/`W`（大写），色码 `r`/`g`/`b`/…/`w`（小写）。
     *
     * 旧版把**所有**字母都收进 `letters`，于是 `CbCbCbRb:CwCwCwCw` 里的
     * `C`（circle，形状码）被当成了一种「颜色」，`probeColor('C')` 再去矿表里
     * 找到 `RuRuRuCu` 这类**形状矿**并报 `ok:true` —— 可那跟「有没有颜料」无关。
     *
     * 这正是我给 `$ore` 建议时输出 `"$ore":"cyan"` 的根源：
     * cyan 在 `COLOR_LETTER_TO_NAME['c']` 里，而 `C` 被当成了 `c`。
     * 地图上根本没有 cyan 矿（它是 blue+green 合成的）。
     *
     * 现在分两组：
     *   · `letters`     —— **色码**，也就是「需要哪些颜料」。只取 pair 的第二位。
     *   · `shapeCodes`  —— **形状码**，也就意味着「需要哪些形状矿」。
     * 两者用途不同，混在一起报会误导。 */
    const letters = new Set();
    const shapeCodes = new Set();
    /* ★ 判据：**有冒号**才是标准的「每格 形状码+色码」格式 ★
     *
     * `CbCbCbRb:CwCwCwCw` —— 冒号分隔下层/上层，每层 8 字符 = 4 象限 × 2。
     * `Cu----Cu` / `RuRu----` / `Cu` —— 旧式记法，整串就是矿种/形状名。
     *
     * 试过用「长度是否 8」判，不行：`RuRu----` 也是 8 字符、`CbCbCbRb` 也匹配
     * `([RCSW][a-z]){4}`，两种格式在这些特征上**完全重合**。冒号才是唯一可靠的区分。 */
    const layersRaw = shapeStr.split(":");
    const isPairFormat = layersRaw.length >= 2
        && layersRaw.every(l => l.length === 8);
    if (isPairFormat) {
        for (const layer of layersRaw) {
            for (let q = 0; q + 1 < layer.length; q += 2) {
                const sc = layer[q], cc = layer[q + 1];
                if (/[A-Z]/.test(sc)) shapeCodes.add(sc);
                if (/[a-z]/.test(cc) && cc !== "u") letters.add(cc);
            }
        }
    }
    /* 旧式记法：所有字母都收 —— `Cu` 那种形态下形状码与矿种前缀恰好重合。 */
    if (!isPairFormat) {
        for (const ch of shapeStr) if (/[a-zA-Z]/.test(ch)) letters.add(ch);
    }
    const isPlainTwoLetter = /^([A-Z][a-z])-*-*$/.test(shapeStr) || /^([A-Z][a-z])$/.test(shapeStr);
    const color = isPlainTwoLetter ? /^([A-Z][a-z])/.exec(shapeStr)[1] : null;

    /* 按矿种聚合（resources 是 [x,y,kind] 三元组） */
    const byKind = new Map();
    for (const r of list) {
        if (!Array.isArray(r) || r.length < 3) continue;
        const [x, y, kind] = r;
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        const e = byKind.get(kind) || { count: 0, minX: x, maxX: x, minY: y, maxY: y, nearest: null, nearestD: Infinity };
        e.count++;
        if (x < e.minX) e.minX = x;
        if (x > e.maxX) e.maxX = x;
        if (y < e.minY) e.minY = y;
        if (y > e.maxY) e.maxY = y;
        /* 到原点的曼哈顿距离当「远近」的代理：hub 就在原点附近，
         * 用欧氏距离在这里没有额外信息量，反而多一次 sqrt。 */
        const d = Math.abs(x) + Math.abs(y);
        if (d < e.nearestD) { e.nearestD = d; e.nearest = [x, y]; }
        byKind.set(kind, e);
    }

    /* ★ 每种需要的颜色，各自报告「矿在不在」★
     *
     * 旧版只查一个 `color`，而且是 startsWith。两个问题：
     *   · startsWith 找不到复合矿的中间段（`Wu` 在 `RuRuWuWu` 里，但不在开头）
     *   · 目标形状有多种颜色时（L12 要 cyan+blue+white），只报一种等于没说
     *
     * 现在按形状串里出现过的**每个颜色字母**分别查。
     * 颜色字母 → 矿种名：大写字母对应形状矿的两字母前缀（`C`→`Cu`/`Cb`…），
     * 小写字母对应颜料名（`w`→`white`、`b`→`blue`）。
     * 这里不硬编色表，直接拿字母去两个方向都试一遍，命中哪个算哪个。 */
    const COLOR_LETTER_TO_NAME = {
        r: "red", g: "green", b: "blue", y: "yellow", p: "purple", c: "cyan", w: "white",
    };
    /** 某种颜色的矿在不在 —— 返回 {color, kinds[], ok} */
    const probeColor = (letter) => {
        const lower = letter.toLowerCase();
        const word = COLOR_LETTER_TO_NAME[lower] || null;
        const kinds = [];
        for (const [k, e] of byKind) {
            const ks = String(k);
            /* 颜料矿：纯小写单词（red / blue / white …） */
            if (word && ks === word) { kinds.push([ks, e]); continue; }
            /* 形状矿：两字母段里含这个色号（大小写都要对）
               `Cu` 的 `u` 是色号，`RuRuWuWu` 里的 `Wu` 也是。
               这里只按「该字母出现在某个两字母段的对应位置」判，
               不做全串子串匹配 —— `red` 里的 `r` 不该算作 red 形状矿。 */
            for (let i = 0; i + 2 <= ks.length; i += 2) {
                const pair = ks.slice(i, i + 2);
                if (!/^[A-Z][a-z]$/.test(pair)) continue;
                const pairLower = pair[1];
                if (pairLower === lower) { kinds.push([ks, e]); break; }
                const pairUpper = pair[0].toLowerCase();
                if (pairUpper === lower) { kinds.push([ks, e]); break; }
            }
        }
        return { color: letter, kinds, ok: kinds.length > 0 };
    };

    const wanted = [...letters].map(probeColor);
    if (wanted.length) {        /* 每种颜色一行：有就说有几格、在哪一档；没有就明说「没有」。
         *
         * 同色多种矿时**全部列出**（`CuCuCuCu` 和 `CuCu----` 都含铜）——
         * 只报最大的那种会让模型以为「只有这一种矿可采」，
         * 而两种矿的远近和产量可能差很多，选哪个是它的决定。 */
        const lines = wanted.map(w => {
            if (!w.ok) {
                return `⇒ ${w.color}: NO ore produces this color in the scanned area`;
            }
            const sorted = w.kinds.slice().sort((a, b) => b[1].count - a[1].count);
            const best = sorted[0];
            const total = w.kinds.reduce((a, [, e]) => a + e.count, 0);
            if (compactForm) return `⇒ ${w.color}: ${best[0]}×${best[1].count}`;
            const each = sorted
                .map(([k, e]) => `${k}×${e.count} (${withinBand(e.nearestD)})`)
                .join(", ");
            return `⇒ ${w.color}: ${each}`;
        });
        const missing = wanted.filter(w => !w.ok);
        const head = missing.length
            ? `⇒ goal needs colors [${[...letters].join("")}]; ${missing.length} of them have NO ore here`
            : `⇒ goal needs colors [${[...letters].join("")}]; all of them exist as ore`;

        /* ★ 当前矿机在挖什么 —— 与「需要什么」对比（2026-11-15 夜，L12 真机）★
         *
         * 实测：世界有 6 台矿机，全部在挖 red / green；而 `CbCbCbRb:CwCwCwCw`
         * 需要 cyan 和 white，两者都要 blue。**一台挖 blue 的都没有。**
         *
         * 而 prompt 只说了「goal needs colors [CbRw]; all of them exist as ore
         * ⇒ b: blue×1794」—— 它知道需要 blue，也知道有 1794 格 blue，
         * 但**不知道自己的矿机只挖 red/green**。
         *
         * 于是它一直在修带子、接 mixer、清垃圾桶，而缺的那一种颜料
         * 从来没人去挖。这不是它笨：那三个事实分布在 prompt 的不同段里，
         * 从来没有人把它们**并列**说出来（这是本项目最高频的缺陷形态
         * —— 「算出来了但没送到决策者眼前」，只是这次是「送到了但没并排」）。
         *
         * 只报**需要的颜色**里哪些没人挖，不罗列全部矿机 —— 预算和噪音。 */
        const digState = (() => {
            const ents = Array.isArray(obs && obs.entities) ? obs.entities : [];
            const miners = ents.filter(e => e && e.type === "miner");
            if (!miners.length) return null;
            /* 矿机脚下是什么矿种 */
            const dugKinds = new Map();       // kind → 台数
            for (const m of miners) {
                const k = byKind.get ? null : null;
                const key = `${m.x},${m.y}`;
                let hit = null;
                for (const r of list) {
                    if (Array.isArray(r) && r[0] === m.x && r[1] === m.y) { hit = r[2]; break; }
                }
                if (hit) dugKinds.set(hit, (dugKinds.get(hit) || 0) + 1);
            }
            if (!dugKinds.size) return null;
            /* 需要的颜色里，哪些没有任何一台矿机在挖 */
            const notDug = [];
            for (const w of wanted) {
                if (!w.ok) continue;          // 地图上就没有这种矿，不怪矿机
                const lower = w.color.toLowerCase();
                const word = COLOR_LETTER_TO_NAME[lower] || null;
                const dug = [...dugKinds.keys()].some(k => {
                    const ks = String(k);
                    if (word && ks === word) return true;
                    for (let i = 0; i + 2 <= ks.length; i += 2) {
                        const pair = ks.slice(i, i + 2);
                        if (!/^[A-Z][a-z]$/.test(pair)) continue;
                        if (pair[1] === lower || pair[0].toLowerCase() === lower) return true;
                    }
                    return false;
                });
                if (!dug) notDug.push(w.color);
            }
            return { miners: miners.length, dugKinds, notDug };
        })();
        /* ★ 只对**有矿可挖**的颜色给 `$ore` 建议 ★
         *
         * 第一版直接拿 `notDug[0]` 举例，而 L12 的 `notDug` 是 `[C,b,w]` ——
         * `C` 是 cyan，`w` 是 white，**这两种颜色地图上根本没有矿**（要 mixer 合成）。
         * 于是提示写成 `$ore:"cyan"`，把模型指向一个不存在的矿种。
         *
         * ⚠️ 第二版仍然错：`probeColor` 对 `C`/`R`/`w` 都返回 `ok:true`，
         * 因为它们作为**形状矿里的一段**出现了（`RuRuRuCu` 含 `C`，`RuRuWuWu` 含 `w`）。
         * 但形状矿挖出来的是**形状**，不是**颜料** —— 把 `Cu` 混进 mixer 的
         * color 槽什么也混不出来。
         *
         * 所以这里必须区分：`$ore` 能指的「颜料矿」只有**纯小写单词**那几种
         * （`red` / `blue` / `green` / `yellow` / `purple` / `cyan` / `white`）。
         * 形状矿的 `$ore` 值是 `CuCuCuCu` 那种，挖出来是形状 —— 那是另一条产线的事。 */
        const PIGMENT_NAMES = new Set(Object.values(COLOR_LETTER_TO_NAME));
        const diggable = digState
            ? digState.notDug.filter(c => {
                const word = COLOR_LETTER_TO_NAME[c.toLowerCase()] || null;
                return !!word && byKind.has(word);
            })
            : [];
        const digLine = digState && digState.notDug.length
            ? (() => {
                /* ★ 256 → 约 150 字符 ★
                 *
                 * 原文把「17 台矿机分别挖什么」全列了一遍（`red×4, blue×7, green×4, …`，
                 * 100+ 字符）。而 MACHINES 段已经把**每一台矿机**的矿种逐行写出来了
                 * （2026-11-21 加的 `采blue` 标注）—— 这里是纯重复。
                 *
                 * 实测代价：4800 token 档下 `resource_dropped_for_capacity=true`，
                 * 这整行被 CAPACITY 挤掉，而它说的正是「白颜料没有矿、只能靠混合」，
                 * 直接关系到 `CwCwCwCw` 这一层的可行性。压短它比丢掉它划算。 */

                return `⇒ ⚠️ 没有矿机在挖 ${digState.notDug.join("/")}（共 ${digState.miners} 台，见上表）。`
                    + (diggable.length
                        ? ` 用 \`insert_machine {at:{"$ore":"${COLOR_LETTER_TO_NAME[diggable[0].toLowerCase()]}"}, machine:"miner", facing:<dir>}\` 补一台。`
                        /* ⚠️ 不能写死「这两种」—— `notDug` 的数量随世界变化。
                           实测 L12 上只有 `w` 一种，而文案写着「这两种颜色」，
                           是旧用例（`[C,b,w]`）的残留。改为按实际数量取词。 */
                        : ` ${digState.notDug.length === 1 ? "这种颜色" : "这几种颜色"}在地图上**没有颜料矿**`
                            + `（RuRuWuWu 那种是形状矿，挖出来的是形状不是颜料）—— 只能靠 mixer 混，不能挖。`);
            })()
            : null;

        return [head, ...lines, digLine].filter(Boolean).join("\n");
    }

    /* 形状串里没有字母（`----` 这种）：没什么可查 */
    return null;
}

/**
 * 把「到原点的曼哈顿距离」压成档位。
 *
 * 为什么不用数字：prompt 不许出现坐标（见上面 renderGoalResource 的注释），
 * 而「22 格」这种数字与坐标在正则上无法区分，且对模型没有额外决策价值 ——
 * 它只需要知道「就在旁边 / 要走一段 / 很远」。
 */
function withinBand(dist) {
    if (!Number.isFinite(dist)) return "far";
    if (dist <= 8) return "near hub";
    if (dist <= 24) return "a short run from hub";
    return "far from hub";
}

/**
 * 与诊断相关的带子，最多 STATE_BELTS_MAX 条。
 *
 * 选取口径（纯字符串，不碰几何）：
 *   ① 诊断里点名过的 handle（`evidence.handles` / `subject.handle` / `slot.cell_ref`）里属于带子的；
 *   ② 不够 12 条时用句柄表顺序补足（**确定性**；表顺序由 handles.mjs 的 (y,x) 规则钉住）。
 * 补足这一步是必要的：冷启动第一轮常常没有诊断（或诊断只点名机器），而改造对象正是带子。
 * 代价是「没被诊断点名的带子」会按表顺序进入 prompt —— 这一点记在 blocks 里（`belts_padded`）。
 *
 * ⚠️ 验收审计实测的致命问题（2026-10-28）：
 *   L4 冷启动存档有 **163 条带子**，而正解要改的三条排在第 **69 / 81 / 82** 位。
 *   按表顺序取前 12 条 ⇒ **一条正解带子都不在 prompt 里**。
 *   LLM 就算推理完美，也看不到该改什么 —— 这不是模型的问题，是我们没给它看。
 *   ⇒ 补足不能只靠表顺序，必须先做**按目标反查**（见 `pickBeltsForGoal`）。
 */
function pickBelts(tbl, diagnoses, goalShape, obs) {
    const wanted = referencedHandles(diagnoses);
    const referenced = wanted.filter(h => {
        const e = tbl.byHandle.get(h);
        return !!e && isBeltType(e.type);
    });
    const all = [...tbl.byHandle.values()].filter(e => isBeltType(e.type));
    const cap = PROMPT_RULES.STATE_BELTS_MAX;

    /* ③ 目标反查：从「到不了 hub」∪「目标原料线」的那一片里，挑出**离目标原料源头最近、
          并且可以并排改造**的那一段（见 `pickBeltsForGoal` 的三层判据）。 */
    const goalPick = pickBeltsForGoal(tbl, all, goalShape, obs);
    const byGoal = goalPick.handles;

    const chosen = [];
    const push = h => { if (h && !chosen.includes(h) && chosen.length < cap) chosen.push(h); };
    /* 诊断点名的带子走这条：**不受 cap 限制**，但总量封顶 `cap + DIAG_RESERVE`。
       见下方「走廊与诊断不抢名额」那段长注释。 */
    const extraCap = cap + PROMPT_RULES.STATE_BELTS_DIAG_RESERVE;
    const pushExtra = h => { if (h && !chosen.includes(h) && chosen.length < extraCap) chosen.push(h); };

    /* ★ 顺序：目标走廊 > 诊断点名 > 表顺序 ★
     *
     * 2026-10-30 实测的冲突：P-a/P-b 把 8 条诊断接进 prompt 之后，
     * 正解三条的可见性从 **3/3 掉到 1/3** ——
     * 因为 `referenced`（诊断点名）排在 `byGoal`（目标原料走廊）之前，
     * 而诊断的 evidence.handles 里有大量**不在目标走廊上**的带子
     * （例如 BELT_HANDOFF_REJECTED 指向的铜线支路）。
     *
     * 两者都是好信号，但强度不同：
     *   · byGoal = 「这条链运的是目标原料」—— 结构性事实，直接决定改造点
     *   · referenced = 「某条诊断提到了它」—— 可能只是"这里有个无关的死端"
     *
     * 所以走廊优先。诊断点名的带子只要不带出走廊，仍然会被 push 进来（第二顺位）。
     */
    /* ★ 名额分配：走廊保底 (cap - reserve) + 诊断点名保底 reserve ★
     *
     * 老 bug（2026-10-30）：referenced 排在 byGoal 之前 ⇒ 8 条诊断把正解三条 3/3 挤到 1/3。
     * 反向 bug（2026-11-01，本次修的）：byGoal 一次就填满 cap（L4 走廊组正好 12 条）
     *   ⇒ 诊断点名的带子永远排在 cap 之外，出现过 `DEAD_END: B34` 而 BELTS 段里没有 B34、
     *   表头却写「2 referenced by diagnosis」。
     *
     * 取舍规则（referenced + byGoal > cap 时）：
     *   ① 给 referenced 留 reserve = min(referenced.length, STATE_BELTS_DIAG_RESERVE, cap) 个；
     *   ② byGoal 按原顺序吃剩下的 cap - reserve 个（切掉的永远是尾巴 = 最弱的那些分量）；
     *   ③ 还有空位才轮到 referenced 的溢出部分，再是表顺序兜底；
     *   ④ referenced 比 reserve 少时，多出来的名额自动还给走廊。
     *
     * reserve = 2 是**实测值**：L4 走廊组恰好 12 条，正解三条 B69(序1)/B81(序2)/B82(序9)。
     * reserve=3 ⇒ byGoal 只 9 个名额 ⇒ B82 掉出、B81/B82 并排段被拆散（3/3 → 2/3，
     * 正是 2026-10-30 那次回归的形态）。reserve=2 ⇒ 10 个名额 ⇒ B82 仍在。
     * 改这个数之前先跑 prompt_belt_visibility.test.mjs 的回归 E。
     *
     * ── 2026-11-10：reserve 改成**自适应**，且被点名的**不占走廊名额** ──
     *
     * 两个诉求都实测过、都是真的：
     *   · L4：走廊组 12 条刚好填满 cap，正解三条 B69/B81/B82 必须在（回归 E）
     *   · 第 9 关：8 条诊断点名 10 条带子，`reserve=2` ⇒ 只有 `1/10` 可见，
     *     而那一轮要改的 B205/B206 从来没出现过
     *
     * 固定 reserve 不可能同时满足（试过 2 → 第 9 关看不见；试过 6 → L4 正解 2/3）。
     *
     * 根因是**把它们当成在抢同一批名额**，但它们的性质不同：
     *   · 走廊 = 「这条链运的是目标原料」—— 结构性事实，决定改造点
     *   · 诊断点名 = 「这一步就是要改它」—— 更直接
     *
     * 所以：走廊按原规则吃 `cap`，诊断点名的**额外追加**在 cap 之外（去重后）。
     * 上限 = `cap + DIAG_RESERVE`（12 + 6 = 18），防止诊断暴走把预算吃光。
     * 这样两边都不用让步，也不必为每个世界调参。 */
    /* ★ 走廊吃满 cap；诊断点名的**额外追加**在 cap 之外 ★
     *
     * 见上方长注释：两者不该抢同一批名额。`reserve` 保留但只用于**表头统计**，
     * 不再从走廊里扣 —— 走廊的正解（L4 的 B82 在序 9）必须完整保留。 */
    const reserve = Math.min(referenced.length, PROMPT_RULES.STATE_BELTS_DIAG_RESERVE);
    const goalSlots = cap;

    for (const h of byGoal.slice(0, goalSlots)) push(h);   // ① 走廊（吃满 cap）
    for (const h of referenced) pushExtra(h);              // ② 诊断点名（cap 之外追加）
    for (const h of byGoal.slice(goalSlots)) push(h);      // ③ 走廊的尾巴（有空位才进）
    for (const e of all) push(e.handle);                   // ④ 表顺序兜底
    return {
        ordered: chosen, referenced, byGoal, reserve,
        /* `[not reaching hub]` 标记的**唯一**依据：候选池里真的到不了 hub 的那些。
           不能用 `byGoal`（候选池还含"通了但造错形状"的原料线），
           也不能用「候选池 − 可达」以外的任何近似 —— 那样标记会重新对模型说谎。 */
        notReaching: goalPick.notReaching,
        padded: chosen.filter(h => !referenced.includes(h) && !byGoal.includes(h)),
        total: all.length,
    };
}

/**
 * 按目标形状反查「值得让 LLM 看的带子」。
 *
 * ⚠️ 这是本文件被修过三次的地方，每次的判据与**为什么不够**都记在下面 ——
 *    这些不是考古，是防止下一个人（或下一轮的我）再走一遍同样的死路：
 *
 *   **第一次**：按句柄表顺序取前 12 条。L4 冷启动有 163 条带子，正解那三条在第
 *     69/81/82 位 ⇒ 一条都看不到。LLM 无解，不是模型的问题，是我们没给它看。
 *
 *   **第二次**：「链末端（出口格上没有东西）」。实测 L4 目标区是密排带子
 *     （x 2..5 × y -16..-9 几乎全填满），每条都有下游 ⇒ 末端法找不到。
 *
 *   **第三次**：「hub 不可达」+「离 hub 越远越靠前」。**三个错误叠在一起**：
 *     a) `allBelts` 来自 `normalizeHandles()` 的输出，而后者**按设计剥掉了坐标**
 *        （`{handle,type,variant,desc}`，没有 cells/x/y/uid）⇒ `posOf()` 对每条带子都返回
 *        null ⇒ `at` / `exitOf` / `reachHub` 全是空的 ⇒ `stranded` 恒等于**全部**带子，
 *        `connectedComponents` 恒等于**空**（`posOf` 为 null 时直接 `continue`）。
 *        症状是"函数不报错、结果默默退化成表顺序"，这正是这个 bug 最难查的地方。
 *     b) 就算喂的是带坐标的实体，"到不了 hub" 在 L4 上有 105 条，而"离 hub 最远"
 *        选出的是 y=-34 那条 36 格的长链（离目标区 20 多格远）—— 距离与「要不要改造」无关。
 *     c) 再加上"不挨机器优先"：L4 目标区**确实**挨着 `L3` balancer（`B63`/`B64` 都喂它），
 *        判据把它当成"有源头的活线"，正好把正解排除掉。
 *
 *   **第四次（当前）**：几何**只从 `obs.entities` 取**（`obsWorld`），`allBelts` 只用来定
 *     "哪些句柄算带子"。`normalizeHandles` 重新搬运 `uid`（身份，不是坐标，不进渲染），
 *     它是 obs（只有 uid）与句柄表（只有 handle）之间唯一的键。
 *
 *     判据分三层，全部是"从 obs 读出来的事实"，没有阈值：
 *
 *       ① **货到不了 hub**（`toHub`）：沿货流**正向**走，穿过透传/改形状的机器
 *          （balancer / cutter / …：从它们的输出槽继续），遇 hub 到达、遇 trash 或
 *          空地停止。由 `topology#flowReachable` 一次算完全部实体（正向建边 + 从 hub
 *          反向闭包，O(V+E)），**每一跳验 `accepts`**（几何相邻但朝向不对 ≠ 一条路）。
 *
 *          ⚠️ 2026-11-01 修过一次：旧实现只在**带子之间**反向扩散，遇到机器就断，
 *          于是「矿机 → balancer → cutter → 带子 → hub」这条通链上 cutter 上游全被
 *          标成「到不了」。实测 45 实体夹具里 prompt 标 11/12 不可达，物理口径 36/37 可达
 *          —— 模型据此去 connect 一个**已经连通**的端口（四臂 82 条样本同一撞法）。
 *          不要把它退回成「只在带子之间传播」的版本。
 *
 *       ② **目标原料的矿机线**（`rawLine`）：`obs.resources` 里矿种 = 目标原料
 *          （`RuRu----` → `RuRuRuRu`）的矿机，其输出格起沿下游的整条链。
 *          改造点不在这条链上的话，改完也没有目标原料流进来。
 *          `obs.resources` **默认不在 obs 里**（loop 的 observe 没带 `include_resources`），
 *          此时这条判据整体失效（返回空集），退到 ③ —— 不猜"矿机都算"。
 *
 *       ③ **共享下游**（`mySinks` + 并查集分组）：L4 目标区是 `x=4` 与 `x=5` 两条并排向上段，
 *          在 `y=-16` 一起汇进 balancer `L3` 的两个输入（`B63`/`B64` → `L3.primary`）。
 *          "两条以上并排、同向、汇进同一台机器"正是 `replace_run` 能解的形状
 *          （cutter 2×1 正好吃掉两列）。这与「两条毫不相干的平行线」区分得开：后者不共享下游。
 *
 *     输出：**按组整块**给，组内按 (y,x) —— 并排链必须成对出现在 prompt 里，
 *     否则 LLM 拿 `$bbox_of` 算出的 region 会覆盖到它没见过的格子。
 *
 * @param {Map<string,object>} tbl       normalizeHandles 的表（handle → {type, uid, desc}）
 * @param {object[]} allBelts            带子 entry（**可能不含坐标**，只用来定"哪些句柄算带子"）
 * @param {string} goalShape             目标形状串（`RuRu----`）
 * @param {object} obs                   ObsSnapshot（几何**唯一**真值来源）
 * @returns {{handles:string[], notReaching:Set<string>}}
 *   `handles` = 值得让模型看的带子句柄（按"该看程度"降序，长度 ≤ STATE_BELTS_MAX）；
 *   `notReaching` = 其中**真的到不了 hub** 的那些句柄 —— `[not reaching hub]` 标记只用它。
 *   ⚠️ 两者**不是**同一个集合：候选池还包含「目标原料线上、但已经通到 hub」的带子
 *   （它们要改是因为造错了形状，不是因为断了）。合并它们会让标记对模型说谎。
 */
function pickBeltsForGoal(tbl, allBelts, goalShape, obs) {
    const out = [];
    if (!allBelts.length) return { handles: out, notReaching: new Set() };

    /* ── 几何唯一来源：obs.entities（不是参数里的 allBelts）──
       这里有一步**必须**做的映射：obs 实体只有 uid，句柄表只有 handle。
       两边都缺对方的键，所以建 uid ↔ handle 的双向索引；任何一边缺了就跳过，
       绝不"猜"一个句柄出来（猜错的句柄会让 LLM 指到另一条产线上）。 */
    const world = obsWorld(obs, tbl);
    if (!world) return { handles: out, notReaching: new Set() };
    const { belts, exitCell } = world;

    /* ── ① 目标形状 → 相关原料（`RuRu----` → `RuRuRuRu`）──
       只用它给"同分"排序，不决定"谁入选"。 */
    const goalKind = rawKindOf(goalShape);

    /* ── ② hub 反向不可达（= stranded）──
       L4 实测 58 条能到 hub、105 条不能。**这 105 条不能全列** —— 12 个名额里必须挑出
       "最该看的那一小段"。判据只用拓扑 + 几何，不读形状代数（形状代数留给宏）：

         a) **目标原料的矿机线**：矿机挖的矿石如果就是目标原料（L4：`RuRuRuRu`），
            它下游那一段就是"目标原料的源头链"。改造点几乎总在这条链上 —— 否则改完也
            没有目标原料流进来。判定用 `obs.resources`（每一格的矿种）；
            **拿不到 resources 时这条判据整体失效**（不是猜一个默认值），退到 b/c。

         b) **多路汇入同一个下游机器**：L4 的目标区是 `x=4` 与 `x=5` 两条并排向上段，
            它们在 `y=-16` 一起汇进 balancer `L3` 的左右两个输入（`B63`/`B64` 都 →
            `L3.primary`）。**"两条以上并排、同向、汇进同一台机器"** 正是 `replace_run`
            能解的形状：把这段并排带子整体换掉（cutter 2×1 吃掉两列）。
            这与「两条毫不相干的平行线」区分得开：后者不共享下游。

         c) 组内带子总数**小**优先（一次 `replace_run` 的 region 小，宏验得过），
            破平用句柄表顺序（确定性）。

       三个信号都是「从 obs 读出来的事实」，不是启发式阈值。 */
    const byHandle = tbl.byHandle;

    /* (a) 目标原料矿机线：矿种 → 机器 → 输出格上的带子 → 沿下游走完整条链。 */
    const rawLine = new Set();
    for (const m of targetRawMiners(world, goalKind)) {
        for (const c of world.outCellsOf(m)) {
            let cur = world.beltAt(c[0], c[1]);
            for (let step = 0; step < 4096 && cur; step++) {
                if (rawLine.has(cur.uid)) break;
                rawLine.add(cur.uid);
                const ex = exitCell(cur);
                cur = world.beltAt(ex[0], ex[1]);
            }
        }
    }

    /* ★ 2026-11-01：候选池不再只是「到不了 hub」的那批 ★
     *
     * 旧口径是 `belts.filter(b => !b.toHub)`。它当时"能用"，是因为 `toHub` 只在带子之间
     * 传播 ⇒ L4 目标区（M3/M4 → balancer → cutter → … → hub 这条**实际连通**的链）
     * 被整片误标成不可达，正解三条恰好落进池子。**那是借了一个假信号的便利**。
     * `toHub` 修对之后它们正确地变成「可达」，于是被这个过滤器排除 —— 但
     * **它们仍然是该看的带子**：那是目标原料的源头链。
     *
     * 所以池子 = 「到不了 hub」∪「目标原料线」。两条入选理由是不同的信号，不要合并：
     *   · 到不了 hub  ⇒ 断了，要 `connect` / `extend_line`
     *   · 在原料线上  ⇒ 通了，但它造的不是目标形状，要 `replace_run` / `insert_machine`
     * 只保留前一条会让 L4 冷启动看不到正解（实测：三条全掉出 12 个名额）。 */
    const unreachable = belts.filter(b => !b.toHub || rawLine.has(b.uid));
    if (!unreachable.length) return { handles: out, notReaching: new Set() };

    /* 「真的到不了 hub」的那批（`[not reaching hub]` 标记的唯一依据）。
       它与上面的候选池**故意不同**：候选池里的目标原料线是"通的但造错了形状"，
       给它们打上「not reaching hub」就是让标记替模型撒谎 —— 模型会去 connect
       一个已经连通的端口，这正是本次要修的那类 bug 的镜像。 */
    const notReaching = new Set(
        unreachable.filter(b => !b.toHub && b.handle).map(b => b.handle));

    /* ★ 分量/汇聚判据跑在**全部带子**上，不是只跑步道候选池的那几条 ★
     *
     * (b) 的核心是「两条并排段汇进同一台机器」。如果只把候选池喂进来，
     * 并排的另一半只要不在池子里，这条判据就看不见它 —— 实测 L4：`B81` 在原料线上、
     * 并排的 `B82` 不在（它的矿机 M4 的 origin 格是空矿），于是 `B81` 被当成一条
     * 孤立链，`replace_run` 的 `$bbox_of` 会覆盖到模型没见过的 `B82` 那一格。
     * 先在全量上建好分量与分组，再**按组**决定要不要入选：组里只要有成员落在候选池，
     * 整组一起进 —— 这才是「并排段必须成对出现」的正确口径。 */
    const comps = connectedComponents(belts, b => [b.x, b.y], exitCell);

    /* (b) 共享下游：把每条"链尾"（出口格上没有带子的那条）的出口格当作汇聚点，
           统计有多少**不同分量**的链尾落在同一格/同一台机器的不同槽上。 */
    const sinkKeyOf = (b) => {
        const ex = exitCell(b);
        const o = world.owner.get(`${ex[0]},${ex[1]}`);
        return o && o.type !== "belt" && o.type !== "underground_belt" ? `m:${o.uid}` : `c:${ex[0]},${ex[1]}`;
    };

    const cand = new Set(unreachable.map(b => b.uid));
    const scored = comps.map((list, idx) => {
        const onRawLine = list.some(b => rawLine.has(b.uid));
        /* 链尾 = 分量内没有下游的那条 */
        const tails = list.filter(b => {
            const ex = exitCell(b);
            return !list.some(o => o.x === ex[0] && o.y === ex[1]);
        });
        /* 本分量汇入的那些 sink */
        const mySinks = new Set(tails.map(sinkKeyOf));
        const minOrder = Math.min(...list.map(b => byHandleOrder(byHandle, b.handle)));
        /* 这一分量是否**有成员**落在候选池里。没有的整组不入选，但它的存在仍参与
           分组（并排段的另一半可能正是它）。 */
        const inPool = list.some(b => cand.has(b.uid));
        return { list, onRawLine, mySinks, minOrder, size: list.length, idx, inPool };
    });

    /* 共享下游分组：把"汇入同一台机器"的分量归成一个**组**，组内一起入选。
       这是 `replace_run` 的真实形状 —— `$bbox_of` 会跨越并排的两条线（L4：`B69`/`B70`
       都是 (4,-14)/(5,-14)，`B81`/`B82` 都是 (4,-13)/(5,-13)），只给一条等于只给了
       半张图，LLM 拿 bbox 会覆盖到它没见过的格子。所以"两条并排线"必须成对出现。

       ⚠️ 必须用并查集（传递闭包），不能"每个新代表扫一遍还没分组的"：
       若 A 与 B 共享下游、B 与 C 共享下游、A 与 C 不共享，那种写法会把 A 和 C 分到两组。 */
    const parent = scored.map(s => s.idx);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj); };
    for (let i = 0; i < scored.length; i++) {
        for (let j = i + 1; j < scored.length; j++) {
            const a = scored[i], b = scored[j];
            for (const k of a.mySinks) if (b.mySinks.has(k)) { union(a.idx, b.idx); break; }
        }
    }
    for (const s of scored) s.group = find(s.idx);
    /* 组级属性：组里任一分量在原料线上 / 组汇聚了 ≥2 条链 / 组里有成员在候选池 */
    for (const s of scored) {
        const mem = scored.filter(t => t.group === s.group);
        s.groupOnRaw = mem.some(t => t.onRawLine);
        s.groupInPool = mem.some(t => t.inPool);
        s.groupSize = mem.length;
        s.groupBelts = mem.reduce((n, t) => n + t.size, 0);
        s.groupMinOrder = Math.min(...mem.map(t => t.minOrder));
    }

    /* 排序（越小越靠前）：原料线 → 汇聚多条链的组 → 组小 → 句柄表顺序。 */
    scored.sort((a, b) =>
        (Number(b.groupOnRaw) - Number(a.groupOnRaw))
        || (b.groupSize - a.groupSize)
        || (a.groupBelts - b.groupBelts)
        || (a.groupMinOrder - b.groupMinOrder)
        || (a.idx - b.idx));

    /* ── 输出名额：按**组**整块取 ──
       排在最前的组往往有 2~4 条并排链（L4 是 x=4 与 x=5 两条各 7 节的链，同汇进 L3）。
       组内**按 (y,x) 排序**输出，因此同一高度的两列相邻出现（`B63/B64`、`B69/B70`、
       `B81/B82` 依次成对）—— LLM 看到成对的相邻行，才推得出"这两列是一条并排段"，
       `$bbox_of` 的 region 才覆盖得到整段。

       ★ 整组入选，不是「只把候选池那几条拿出来」★
       并排段的另一半可能不在候选池里（L4 的 `B82` 就属于这种情况：它自己在原料线上，
       但分组时曾经被排除在池子外，于是 `B81` 单独出现）。整组一起给，
       `$bbox_of` 才不会包含模型没见过的格子。

       ⚠️ 别用"每轮每组各取一条"的轮转：那会把组分量的头部先各取一条，成员被拆散到
       12 条里的各处，反而更难看出"这是一段连续带子"。 */
    for (const s of scored) {
        if (!s.groupInPool) continue;          // 整组都不在候选池：不占名额
        for (const b of s.list.slice().sort((p, q) => (p.y - q.y) || (p.x - q.x))) {
            if (out.length >= PROMPT_RULES.STATE_BELTS_MAX) return { handles: out, notReaching };
            if (b.handle) out.push(b.handle);
        }
    }
    return { handles: out, notReaching };
}

/**
 * 挖**目标原料**的矿机。`goalKind` 是 `RuRuRuRu` 这种原料串。
 *
 * `obs.resources` 是**唯一**的矿种来源（mod 的 `include_resources`）。它**默认不在 obs 里**
 * —— loop 的 observe 调用没带这个参数。所以：
 *   · 拿得到 → 用它精确筛"目标原料矿机"；
 *   · 拿不到 → 返回空数组，**判据整体失效**（不猜"矿机都算"，那会让一条铜线上任取矿机
 *     也排到最前面，比没有判据更糟）。这是有意的 fail-open，且不影响 b/c 两条判据。
 *
 * ⚠️ 判据是「矿机**占地内任一格**的矿种」，不是只看 origin 格。
 *    矿机是 2×2，`obs.resources` 按格给矿种，而 origin 格未必定是该矿：
 *    L4 的 `M4@(5,-8)` origin 格是**空矿**，`RuRuRuRu` 在它的 `(6,-7)` 那格上。
 *    只看 origin ⇒ M4 被漏掉 ⇒ 它的下游链（`B70`…`B82`）进不了候选池，
 *    并排段 `B81/B82` 被拆散（`$bbox_of` 会覆盖到没见过的格子）。
 *    旧实现侥幸能用，是因为当时候选池靠的是另一个（错的）信号，不依赖这条判据。
 */
function targetRawMiners(world, goalKind) {
    if (!goalKind) return [];
    const res = world.resources;
    if (!res || !res.size) return [];
    const hasKind = m => {
        const [w, h] = footprintOf(m);
        for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
                if (res.get(`${m.x + dx},${m.y + dy}`) === goalKind) return true;
            }
        }
        return false;
    };
    return world.machines.filter(m => m.type === "miner" && hasKind(m));
}

/**
 * 把 `obs` 里的带子重新索引成「带几何」的形态，并算出每条带子**能不能到 hub**。
 *
 * 为什么必须从 obs 重建：`normalizeHandles()` 按设计剥掉了 `x/y/r/cells/uid`（那是
 * "prompt 不含坐标"的第一层保证）。几何判据只能用 obs —— 但句柄只能用句柄表。
 * 本函数是这两者唯一的桥，且**两个方向都只读不写**。
 *
 * @returns {null|{belts:object[], hub:object, owner:Map<string,object>,
 *                 exitCell:function, entryCell:function, handleOfUid:function}}
 */
function obsWorld(obs, tbl) {
    const ents = (obs && obs.entities) || [];
    if (!ents.length) return null;

    /* uid → handle：句柄表里每个 entry 都带 uid（handles.mjs 的契约）。
       缺 uid 的 entry 不进索引 —— 宁可少给一条，也不猜。 */
    const handleOfUid = new Map();
    for (const e of tbl.byHandle.values()) {
        if (e && typeof e.uid === "number") handleOfUid.set(e.uid, e.handle);
    }

    const isBelt = e => e && (e.type === "belt" || e.type === "underground_belt");

    /* footprint 展开的占位表：`x,y` → 实体。cutter 2×1 / hub 4×4 必须都覆盖，
       否则「挨着 cutter 第二格」会被判成 air（这正是上一版注释里提到的坑）。 */
    const owner = new Map();
    for (const e of ents) {
        const [w, h] = footprintOf(e);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) owner.set(`${e.x + dx},${e.y + dy}`, e);
    }

    /* 出口/入口格。字段名两种都认：obs 是 `rotation_variant`，旧夹具可能是 `rv`。
       ⚠️ 只认 `rv` 会让所有带子按 rv=0 算方向 ⇒ 拓扑整体错乱且**不报错**。 */
    const rvOf = e => (Number.isInteger(e.rotation_variant) ? e.rotation_variant
        : (Number.isInteger(e.rv) ? e.rv : 0));
    const cellAt = (e, dir) => [e.x + DIRV[dir][0], e.y + DIRV[dir][1]];
    const exitCell = e => cellAt(e, beltExit(rvOf(e), Number(e.r) || 0));

    const hub = ents.find(e => e && e.type === "hub") || null;
    const belts = ents.filter(isBelt);
    /* 每条带子只留拓扑需要的字段 + handle；**不把实体本身带出去**（避免下游误读坐标）。 */
    const view = belts
        .filter(e => handleOfUid.has(e.uid))
        .map(e => ({ uid: e.uid, handle: handleOfUid.get(e.uid), x: e.x, y: e.y, r: Number(e.r) || 0, rv: rvOf(e) }));
    const beltByCell = new Map();
    for (const b of view) beltByCell.set(`${b.x},${b.y}`, b);
    const beltAt = (x, y) => beltByCell.get(`${x},${y}`) || null;

    /* 机器（含矿机）：只留建立"机器 → 出口格"所需的最少字段。 */
    const machines = ents.filter(e => e && !isBelt(e) && e.type !== "hub");

    /* 矿种：obs.resources 是三元组 [x, y, kind] 的数组（mod 的 include_resources）。
       没带就是空表 —— 上层据此让"原料矿机"判据整体失效，而不是猜一个默认值。 */
    const resources = new Map();
    for (const r of (obs && Array.isArray(obs.resources)) ? obs.resources : []) {
        if (Array.isArray(r) && r.length >= 3) resources.set(`${r[0]},${r[1]}`, r[2]);
    }
    const resourceKinds = new Set(resources.values());

    /** 一台机器的**输出格**（世界坐标）：输出槽在本体上的格 + 出口方向前进一步。 */
    const outCellsOf = (m) => {
        const cells = [];
        try {
            const tpl = templateByBuildingVariant(m.type, m.variant || "default");
            if (!tpl) return cells;
            const ws = worldSlots(tpl, Number(m.r) || 0);
            for (const s of ws.outputs) {
                const x = m.x + s.cell[0] + DIRV[s.dir][0];
                const y = m.y + s.cell[1] + DIRV[s.dir][1];
                cells.push([x, y]);
            }
        } catch { /* 模板/旋转不支持：这台机器不贡献原料线，不猜 */ }
        return cells;
    };

    /* ── 到 hub 的可达性：**对全部实体**算一遍，不是只在带子之间传播 ──
     *
     * ★ 这里必须穿过机器 ★
     *   旧实现从「出口落进 hub 占地面积」的带子出发，**只在带子之间**反向扩散
     *   （索引键只建给带子）。于是「矿机 → balancer → cutter → 带子 → hub」这条通链上，
     *   只有 cutter **下游**那段被标可达，cutter **上游**全被标成「到不了」。
     *   实测（`.tmpverify/capacity-scenario.json`，45 实体）：prompt 标 11/12 条
     *   「not reaching hub」，而物理口径是 36/37 通 —— 11 条里有 11 条是假信号。
     *   四臂 82 条样本几乎逐字相同地撞在这个假信号上：模型据此去 `connect` 一个
     *   **已经连通**的端口。
     *
     *   正确的语义是「这条带子上的货，最终能不能进 hub」，沿下游走：
     *     带子 → 沿出口；透传/改形状的机器（balancer/cutter/stacker/painter/mixer）
     *     → 从**它的输出槽**继续；trash / 没输出槽 → 停；hub → 到达；走出世界 → 停。
     *
     * ★ 用 `flowReachable` 而不是两条路径逐条走 ★
     *   那是 `topology.mjs` 里已有的一份实现（正向建边 + 从 hub 反向闭包，O(V+E)），
     *   和这里的 `hubReachable`（诊断 tier 用，语义更宽松）区分得开：这一份每一跳都验
     *   `accepts`，因为「入口朝向对不上」的带子在几何上相邻但货推不进去。
     *   自己再写一份就是第三份真值 —— 这个仓库已经因此出过三次事故。 */
    const toHub = flowReachable(obs);
    for (const b of view) b.toHub = toHub.has(b.uid);

    return {
        belts: view,
        hub,
        owner,
        machines,
        resources,       // Map<"x,y", kind>；obs 没带 resources 时是空 Map（不是 null）
        outCellsOf,
        beltAt,
        exitCell,
    };
}

/** 机器/带子的真实占地（拿不到模板就按 1×1）。 */
function footprintOf(e) {
    try {
        const tpl = templateByBuildingVariant(e.type, e.variant || "default");
        if (tpl && Array.isArray(tpl.footprint) && tpl.footprint.length === 2) return tpl.footprint;
    } catch { /* 拿不到就按 1×1 */ }
    return [1, 1];
}

/** 带子 entry 在句柄表里的序号（用于确定性破平）。 */
function byHandleOrder(byHandle, handle) {
    let i = 0;
    for (const k of byHandle.keys()) { if (k === handle) return i; i++; }
    return 1e9;
}

/** 目标形状串 → 「原料 kind」：`RuRu----` → `RuRuRuRu`；推不出来就返回 null。 */
function rawKindOf(goalShape) {
    if (typeof goalShape !== "string") return null;
    const m = /^([A-Z][a-z])([A-Z][a-z])/.exec(goalShape.trim());
    if (!m || m[1] !== m[2]) return null;
    return `${m[1]}${m[2]}${m[1]}${m[2]}`;
}

/** ("x,y") → 该格主人的 uid（owner 表是 footprint 展开的）。找不到返回 null。 */
function exitOwnerUidAt(owner, x, y) {
    const o = owner.get(`${x},${y}`);
    return o && typeof o.uid === "number" ? o.uid : null;
}

/** 把一组带子按「出口/入口相邻」分成连通分量，返回每分量的带子数组。 */
function connectedComponents(belts, posOf, exitOf) {
    const byCell = new Map();
    for (const e of belts) {
        const c = posOf(e);
        if (c) byCell.set(`${c[0]},${c[1]}`, e);
    }
    const seen = new Set();
    const comps = [];
    for (const start of belts) {
        const sc = posOf(start);
        if (!sc || seen.has(start.uid ?? start.handle)) continue;
        const q = [start];
        seen.add(start.uid ?? start.handle);
        const list = [];
        while (q.length) {
            const cur = q.shift();
            const c = posOf(cur);
            if (!c) continue;
            list.push(cur);
            /* 邻居：出口格上是带子，或某条带子的出口指向我 */
            const ex = exitOf(cur);
            const cand = [];
            if (ex) { const n = byCell.get(`${ex[0]},${ex[1]}`); if (n) cand.push(n); }
            for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
                const n = byCell.get(`${c[0] + dx},${c[1] + dy}`);
                if (n) { const e2 = exitOf(n); if (e2 && e2[0] === c[0] && e2[1] === c[1]) cand.push(n); }
            }
            for (const n of cand) {
                const key = n.uid ?? n.handle;
                if (seen.has(key)) continue;
                seen.add(key);
                q.push(n);
            }
        }
        comps.push(list);
    }
    return comps;
}

function renderBelts(tbl, selection, shownCount, omittedByBudget) {
    const shown = selection.ordered.slice(0, shownCount);
    /* ★ 表头数字必须是**实际渲染出来**的，不是候选池的大小 ★
     *
     * 老版本写 `${selection.referenced.length} referenced by diagnosis` —— 那是
     * 「诊断点名了几条」而不是「这几条里显示了几条」。实测出过
     * `## BELTS (12 of 34; 2 referenced by diagnosis)` 而正文里**一条诊断点名的带子
     * 都没有**（B34 被 byGoal 挤掉了）：表头在对模型撒谎，模型据此以为
     * u8bcau65adu63d0u5230u7684u5e26u5b50u6211u90fdu770bu89c1u4e86，于是去找一个根本不在表里的句柄。
     *
     * 现在按**实际渲染的 shown** 统计点名的条数，并且压掉一部分时给出
     * `of N ... shown` 的下半句 —— 同样说实话。 */
    const shownSet = new Set(shown);
    const refTotal = (selection.referenced || []).length;
    const refShown = (selection.referenced || []).filter(h => shownSet.has(h)).length;
    const refBit = refShown === refTotal
        ? `${refShown} referenced by diagnosis`
        : `${refShown} of ${refTotal} referenced by diagnosis shown`;
    const lines = [`## BELTS (${shown.length} of ${selection.total}; ${refBit})`];
    if (!shown.length) lines.push("(none shown)");

    /* ★ 标出「这条链到不了 hub」（2026-10-29 第十轮的直接产物）★
     *
     * 10 次统计里 **6/10** 的失败是同一个模式：模型盯着 hub 入口那三条
     * （`B135/B136/B137`），因为"hub 没交货 ⇒ 改入口"这个推理很自然。
     * 但那三条其实是**已接通**的；真正要改的是接不上的上游链。
     *
     * 模型分不清这两类，因为 BELTS 段没写这件事。
     * 现在把「候选改造对象」（`byGoal`：到不了 hub、且判定为值得改造的那批）标出来，
     * 并在段落开头给一句判据说明 —— 让它有依据地排除 hub 环。
     *
     * ⚠️ 只标「我们**建议**看的」，不断言「hub 环一定不能改」：
     * 有的关卡正解就是改入口。标的是**信号**，不是禁令。
     */
    const suspect = new Set(selection.notReaching || []);
    if (suspect.size) {
        lines.push("(lines marked `[not reaching hub]` are belt runs whose goods cannot currently reach the hub —");
        lines.push(" followed downstream through machines and tunnels. Lines WITHOUT the mark do reach the hub.)");
    }
    for (const h of shown) {
        const e = tbl.byHandle.get(h);
        const mark = suspect.has(h) ? "  [not reaching hub]" : "";
        lines.push(`${e.handle} ${e.type}${renderDesc(e.handle, e.type, e.desc)}${mark}`);
    }
    const omitted = Math.max(0, selection.ordered.length - shown.length) + Math.max(0, selection.total - selection.ordered.length);
    if (omittedByBudget || omitted) lines.push(`(+${omitted} belts not shown)`);
    return lines.join("\n");
}

/**
 * S3 的 PRODUCTION 段。
 *
 * ## 参数为什么是 `production` 而不是 `obs`（2026-10 实测修的一处硬伤）
 *
 * 旧实现读 `obs.production`，但 `loop.mjs` 传进来的是 `ob.obs` —— 而
 * `observeOnce()` 把 production 读成**与 `ob.obs` 并列的第三个字段**（`ob.production`），
 * 从来没有塞进 `ob.obs`。于是每一轮、每个存档，模型都只看见同一句
 * `unavailable (obs.production absent)`，**永远不知道产线产不产、多快**。
 *
 * 旧测试没抓到，是因为它手工把 production 拼进 obs（`{...L5, production: {...}}`）——
 * 那正是 loop 不做的事：单模块测试自己造了个调用方不提供的形状，于是恒绿。
 *
 * 裁决：production 走**显式参数**，不再从 obs 里摸。理由不是洁癖：
 *   · `obs` 是「游戏返回的原文」，`worldUidSetHash(obs)` / 落盘的 `obs-last.json` 都按这个
 *     语义用它；往里塞私货会让「同一份世界」在两处不再是同一个对象；
 *   · 读显式参数时，「调用方忘了传」会以**可见的 unavailable** 暴露出来；
 *     而读 `obs.production` 时，忘了传与真的没数据长得一模一样 —— 这个 bug 就是这么活了两周的。
 *
 * @param {object|null} production `reader.production()` 的返回（形态见 mod 的
 *   `observeProduction`：window_seconds / produced_total / produced_per_sec /
 *   delivered_* / stored_delta / *_slices），或 null（没读到）。
 */
function renderProduction(production, goalShape = null) {
    const p = production;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
        return "## PRODUCTION\nunavailable (production not read) — decide from the diagnosis, do not assume anything is running";
    }
    const lines = ["## PRODUCTION"];
    let n = 0;
    const push = (k, v) => { if (n < 10) { lines.push(`${k}: ${v}`); n++; } };
    if (num(p.window_seconds) !== null) push("window_seconds", p.window_seconds);
    const totals = p.produced_total && typeof p.produced_total === "object" ? Object.entries(p.produced_total) : [];
    for (const [k, v] of totals.slice(0, 4)) push(`produced ${sanitize(k).text}`, v);
    const rates = p.delivered_per_sec && typeof p.delivered_per_sec === "object" ? Object.entries(p.delivered_per_sec) : [];
    for (const [k, v] of rates.slice(0, 4)) push(`rate ${sanitize(k).text}`, v);
    if (n === 0) {
        /* 一个字段都认不出来。两种情况必须分开说，否则模型会把「没读到」读成「产出 0」：
         *   · `{}`（或只有空表）—— 读到了响应，但里面什么都没有；
         *   · 其它形态 —— 协议变了吗？原样贴 200 字，让下一个人有东西可查。 */
        const json = compact(p, 200);
        lines.push(json === "{}"
            ? "no data (production returned an empty object) — throughput is UNKNOWN, not zero; check the diagnosis"
            : json);
    }

    /* ★ 把「产的不是目标」这句直接说出来 ★
     *
     * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）：
     *
     *   ## GOAL      shape: Cu----Cu
     *   ## PRODUCTION  produced RuRuRuRu: 105 / rate RuRuRuRu: 1.767
     *
     * 两段挨着，但**没有一句话说它们矛盾**。模型得自己把两个形状串做颜色+形状
     * 对比才能发现「整条线在造别的颜色」。它没发现 —— 三轮都在修钌传送带的堵塞，
     * 而一条铜都没产（post-run `production` 里 `CuCuCuCu`/`----CuCu` 全是 0）。
     *
     * 这一步只做**陈述**，不做推理：目标形状不是当前产物的成员时，
     * 直接把两边都摆出来并点名。不猜原因、不给修法 —— 那是模型和诊断的事。
     *
     * 只在**确有产出**时才说（totals 非空）。没产出时 「produced 空」本身
     * 已经说明问题，再补一句「产的不是目标」只是噪音。
     */
    const goal = typeof goalShape === "string" ? goalShape.trim() : "";
    if (goal && totals.length) {
        const producedNames = totals.map(([k]) => String(k));
        if (!producedNames.includes(goal)) {
            lines.push(
                `⇒ WARNING: nothing above IS the goal shape (${sanitize(goal).text}). `
                + `The line is making ${producedNames.slice(0, 3).map(s => sanitize(s).text).join(", ")}, `
                + `which is a DIFFERENT shape — fixing a jam on it will not produce the goal. `
                + `Check the RECIPE above and whether a miner is on the right color.`
            );
        }
    }
    return lines.join("\n");
}

function resolveLimits(budget) {
    const b = (budget && typeof budget === "object") ? budget : {};
    const pick = (...names) => {
        for (const k of names) if (num(b[k]) !== null && b[k] > 0) return b[k];
        return null;
    };
    /* `include_when`：**显式**开关，缺省 null = 按预算推断（见 buildPrompt 里 whenLinesOn）。
     *
     * 存在的唯一理由是 A/B 实验：`when:` 行原本只能由 `tokensMax >= 4000` 触发，
     * 于是「有 when:」与「预算更大（带子更多、CAPACITY 出现）」永远是同一个变量。
     * 那样测出来的任何差异都归因不了。有了它就能**同一预算**下只翻这一行。
     *
     * 它不进 prompt、不进 blocks 的语义 —— `blocks.when_lines_shown` 报告的仍是
     * **实际有没有渲染**，不是这个开关的值。两者不一致时（比如预算 2800 却
     * 显式打开）以实际渲染为准，因为那才是模型看到的东西。 */
    const includeWhen = (typeof b.include_when === "boolean") ? b.include_when : null;
    /* `forceOneCall`：**实验开关**，默认 false。
     *
     * 打开后 `s6` 用 `INSTRUCTION_SINGLE`（「这一轮只能做一个动作」），
     * 用于检验「强制单动作会不会让模型更看重成因诊断」。
     * 它不改变任何常态行为 —— 关闭时与改动前逐字节相同。 */
    const forceOneCall = b.forceOneCall === true;
    return {
        inCharsMax: pick("in_chars_max", "LLM_IN_CHARS_MAX", "inCharsMax") || PROMPT_RULES.LLM_IN_CHARS_MAX,
        tokensMax: pick("prompt_tokens_max", "PROMPT_TOKENS_MAX", "promptTokensMax") || PROMPT_RULES.PROMPT_TOKENS_MAX,
        includeWhen,
        forceOneCall,
    };
}

function renderBudget(budget) {
    const b = (budget && typeof budget === "object") ? budget : null;
    const keys = ["rounds_left", "llm_calls_left", "tx_left", "ticks_left", "wall_ms_left"];
    const bits = [];
    if (b) for (const k of keys) if (num(b[k]) !== null) bits.push(`${k} ${b[k]}`);
    return "## BUDGET\n" + (bits.length ? bits.join(" | ") : "not provided (assume a single attempt)");
}

/* ══════════════════════════ 6b. CAPACITY（产能瓶颈） ══════════════════════════ */

/**
 * S3 的 CAPACITY 段：**现在瓶颈在哪，加机器和升级哪个划算**。
 *
 * ## 为什么需要它（这是本段的唯一理由）
 *
 * 用户的反馈原话：「建的很丑陋也没有调理的绕远路，**明明有可以快捷提高产能的方法却没有用**」。
 *
 * 实测的 L4 存档（`belt:1 miner:1 processors:0`、3 台矿机、1 台 cutter）：
 *
 *   供给 3 × 0.60 = 1.80/s     处理 1 × 0.50 = 0.50/s     ⇒ **利用率 28%**
 *
 * 72% 的矿机产出堵在那一台 cutter 前面。而在加这一段之前，prompt 里
 * 关于"产能"的全部信息只有 MACHINES 段的一串句柄 + PRODUCTION 段的历史速率 ——
 * **没有任何一句说「你现在卡在哪、加什么最划算」**。模型能从 MACHINES 数出
 * `1 台 cutter`，但它没有依据判断这个 1 是够的还是不够的。
 *
 * ## 设计取向（三条，都是被预算逼出来的）
 *
 * 1. **只在有话说时才出现**。没有产线、数据不可信、或者供给与处理已经平衡（≥90%）
 *    并且没有可负担的升级 ⇒ 返回 `null`，整段消失。原因：prompt 在
 *    `tokensMax=2800` 下实测只有 ~500–750 字符余量（L4 4 条诊断时 9484/9800），
 *    一段常驻的空白说明会把它推进截断区。
 * 2. **短**。目标 ≤ 6 行 / ~420 字符。用 `##` 段头 + 竖线分隔，不写完整句子。
 * 3. **数字全部来自 `assess.mjs`，本函数不重算**。重算就是第二份真值。
 *
 * ## 预算保护（这是本段最容易出事的地方）
 *
 * 它**不是**可截断段 —— 截断契约只允许砍 BELTS。所以两种形态都由调用方**显式挑**：
 *
 *   · `form:"full"`  完整 3–5 行（指标 + 瓶颈 + 两条路）；
 *   · `form:"short"` 只留 2 行（指标 + 瓶颈 + 一句可执行动作）。
 *
 * **不在这里偷偷按 room 裁行**（一版这么写过，结果是「渲染器自己降级了，调用方
 * 却以为给的是 full」—— `capacity_downgraded` 永远不置位，测试也拿不到真实形态）。
 * `room` 仍然接受，但只用来做**整体取舍**：放不下就返回 null，让调用方去试下一档。
 *
 * @param {object|null} capacity `assess().capacity`（`capacityOf` 的点）
 * @param {object|null} options  `assess().options`（`capacityOptions` 的点）
 * @param {object} [opts]        `{room?:number, form?:"full"|"short"}`
 * @returns {string|null} 片段（不含前后的空行），或 null = 不渲染 / 放不下
 */
export function renderCapacity(capacity, options = null, opts = {}) {
    const cap = capacity;
    if (!cap || typeof cap !== "object") return null;
    /* 数据不可信时不渲染 —— 「不知道」比「猜一个」好。理由写在 capacityOf 的 confidence 注释里。 */
    if (cap.confidence !== "ok") return null;

    const supply = num(cap.supplyPerSec);
    /* ⚠️ 必须走 `num()`：`cap.process && num(...)` 在 `cap.process` 缺失时得到 **undefined**，
       而下面写的是 `processCap === null` —— undefined 会漏过这道闸，渲染出
       `supply 1/s | processing ?/s` 这种自相矛盾的段（测试 C5 抓到的真 bug）。 */
    const processCap = num(cap.process && cap.process.capacityPerSec);
    const util = num(cap.utilization);
    const bottleneck = cap.bottleneck;

    /* ── 什么时候**不**说 ──
     *  · 没有产线（supply=0 且 process=null）⇒ 无可评估
     *  · 处理能力缺（null）：那是「没有加工机器」这个**真问题**，
     *    交给 DIAGNOSIS 的 PROCESSOR_REQUIRED，不在这里重复占预算。 */
    if (processCap === null) return null;
    if (!(supply > 0) && processCap === 0) return null;

    /* ★ 先问「有货在流吗」，再谈吞吐 ★
     *
     * 2026-11-20，L12 真机：CAPACITY 段理直气壮地说
     *
     *     supply 12.8/s | processing 0.25/s | 2% utilized
     *     bottleneck: stacker — 98% of supply is stuck here
     *     · add 51 stacker (1→52) ⇒ 13/s — fills the line
     *
     * 而同一轮的 `delivered_total` 是 `{}`、`produced_total` 是 `{}` ——
     * **一件都没产出、一件都没交货**。在那种状态下，「98% 的供给堵在 stacker」
     * 的分子和分母都是虚构的：没有一个 items/s 真的发生过。
     *
     * 这是整份 prompt 里**最有说服力**的一段（有数字、有对比、有可执行动作、
     * 还有「fills the line」的承诺），而它把模型引向了「再铺 51 台 stacker」。
     *
     * 所以降级顺序是：**先确认有货在流，再谈瓶颈**。
     *   · 产出与交付都空 ⇒ 吞吐数字毫无意义，整段改成「先让货动起来」
     *   · 有产出但零交付 ⇒ 堵在**交付端**，加加工机器不解决问题
     * 两种都要把可执行的下一步写清楚，而不是留一个漂亮的百分比。 */
    const prod = (opts && opts.production && typeof opts.production === "object") ? opts.production : null;
    if (prod) {
        const sumOf = o => (o && typeof o === "object" && !Array.isArray(o))
            ? Object.values(o).reduce((s, v) => s + (num(v) || 0), 0) : 0;
        const produced = sumOf(prod.produced_total);
        const delivered = sumOf(prod.delivered_total);
        /* ★ `items_on_belts` 是第三个证据，不能只看 production ★
         *
         * 2026-11-20 真 LLM 实测抓到我这句写错了。L12 上 `produced_total` 与
         * `delivered_total` 都是 `{}`，于是这里输出「no goods are moving at all」——
         * 而同一时刻 `items-last.json` 里**有 376 件货在带上跑**
         * （blue×210、ScSc----×139、CuCuCuCu×12…）。
         *
         * 所以那句话是**假的**。准确的事实是：「货在动，但没有一件到 hub」。
         * 这两件事对模型的指令完全不同 ——
         *   · 真的没动 ⇒ 去修第一段路（现在是空的）
         *   · 动了但不交货 ⇒ 去修**最后一段**
         * 把第二种说成第一种，会让模型去重建一段本来好好的线。 */
        const onBelts = num(opts && opts.itemsOnBelts);
        if (produced === 0 && delivered === 0) {
            const iso = num(cap.miners && cap.miners.isolated);
            const flowing = onBelts !== null && onBelts > 0;
            const head = flowing
                ? `## CAPACITY\n${onBelts} items ARE riding the belts, but ZERO produced and ZERO delivered — `
                    + "goods circulate without ever reaching the hub. Repair the LAST segment; "
                    + "do not rebuild the whole line and do not add machines for throughput"
                : "## CAPACITY\nnothing produced, nothing delivered and no items on the belts — "
                    + "this line is not running at all. Do NOT add machines for throughput; "
                    + "first make one complete path carry items";
            return head + (iso > 0 ? ` (${iso} miner(s) have no processor connected)` : "") + ".";
        }
        if (produced > 0 && delivered === 0) {
            return "## CAPACITY\n"
                + `goods ARE being produced (${fmt(produced)} items in the window) but ZERO reach the hub — `
                + "the blockage is at the DELIVERY end, not in processing. "
                + "Do not add processing machines; trace the output path and make it end at a hub inlet.";
        }
    }

    const room = num(opts.room);
    const form = opts.form === "short" ? "short" : "full";

    /* ── 平衡时不硬报问题（测试「正例 B」）──
     * utilization ≥ 0.9 且没有能立刻买的升级 ⇒ 说一句「不是瓶颈」就够，
     * 一行，不再展开两条路。 */
    const affordable = (options && Array.isArray(options.doNow))
        ? options.doNow.filter(a => a && a.action === "buy-upgrade") : [];
    const balanced = util !== null && util >= 0.9;
    if (balanced && !affordable.length) {
        return "## CAPACITY\n"
            + `balanced: supply ${fmt(supply)}/s vs processing ${fmt(processCap)}/s`
            + `${upper(util)} — no capacity bottleneck. Do not add machines for throughput.`;
    }

    const lines = ["## CAPACITY"];
    const parts = [];
    parts.push(`supply ${fmt(supply)}/s`);
    parts.push(`processing ${fmt(processCap)}/s`);
    if (util !== null) parts.push(`${upper(util)} utilized`);
    lines.push(parts.join(" | "));

    if (bottleneck === "process" && cap.bottleneckMachine) {
        const pct = util !== null ? Math.round((1 - util) * 100) : null;
        lines.push(`bottleneck: ${cap.bottleneckMachine}`
            + (pct !== null ? ` — ${pct}% of supply is stuck here` : ""));
    } else if (bottleneck === "supply") {
        lines.push("bottleneck: miners (processing has spare capacity)");
    }

    const add = options && options.addMachines;
    const up = options && options.upgrade;

    /* ── 「买升级」这条路：**只有真能做的时候才提** ──
     *
     * `capacityFor` 会把 `buy-upgrade` 放进 `doNow`（`assess.mjs:520-527`），
     * 那是"哪种办法更快吃满供给"的**策略**答案。
     *
     * ⚠️ 这里曾经写死 `false`，注释说「loop 的执行面没有宏能买升级 ——
     * 教模型做一个不存在的动作，比不提更坏」。那个判断当时是对的，
     * 现在反过来了：`upgrade` 宏已经接进 `MACRO_NAMES` / `MACRO_FNS` /
     * loop 的 plan 阶段（它不走 tx，走 `reader.upgrade`）。
     *
     * **继续写死 false 的代价比当初更大**：实测 level 9 那一刻 `miner` 与 `painting`
     * 两档升级当场就买得起（hub 里存着 RuRuRuRu×15583 / RbRb----×7219），
     * 白送的 ×1.5 采矿速率与涂装解锁，而 prompt 一个字都没提 ——
     * 模型只能继续铺带子。这正是「AI 不会用更高级的方法提高效率」那条抱怨的成因。
     *
     * 判据不是「白名单里有没有这个字符串」（那是在猜名字），而是
     * **有没有宏的实现能真的买一次**：`MACRO_NAMES` 与 `MACRO_FNS` 在加载时
     * 已经断言过同集合，所以只要 `upgrade` 在 `MACRO_NAMES` 里且这里没写死，
     * 那条建议就是可执行的。 */
    const canBuyUpgrade = MACRO_NAMES.includes("upgrade");
    const buyNow = canBuyUpgrade ? affordable[0] : null;

    if (form === "short") {
        /* 短版：只留**一条**最该做的动作。优先「现在就买得起」的升级（零占格、全局生效），
           否则才说加机器。 */
        if (buyNow) {
            lines.push(`act: buy ${buyNow.line} T${buyNow.tier} ⇒ ${fmt(buyNow.capacityAfter)}/s`);
        } else if (add && add.add > 0) {
            lines.push(`act: add ${add.add} ${add.kind} ⇒ ${fmt(add.capacityAfter)}/s`);
        }
    } else {
        /* 两条路：加机器 / 升升级（**都可执行时才写** —— 见上面 canBuyUpgrade 的理由） */
        const roads = [];
        if (add && add.add > 0) {
            roads.push(`add ${add.add} ${add.kind} (${add.from}→${add.to}) ⇒ ${fmt(add.capacityAfter)}/s`
                + (add.enough ? " — fills the line" : ""));
        }
        if (up && canBuyUpgrade) {
            /* ★ `needs` 那半句要带上「必须专门造」，不能只报缺多少 ★
             *
             * ⚠️ 先纠正一句我说错了的话。我原来在这里写的是
             * 「`upgrade` 是这游戏里**唯一**能让已有产线变快的动作」。**那是错的。**
             *
             * 翻 `bundle.js` 核实过：**单位机器速率**确实只有四条升级线能改
             * （`belt` / `miner` / `processors` / `painting`；搜 speedMultiplier /
             * miningSpeed / processingSpeed / boost 都没有第二种机制）。但玩家提高
             * **产出**从来不靠这个。真正的途径至少有五条：
             *
             *   ① 升级倍率（×1 到 ×8）        ← 只有这一条是宏能做到的
             *   ② **并联**：同一工序复制 N 条平行线   ← L12 上这才是唯一有效的
             *   ③ 消除瓶颈（最慢那道工序）
             *   ④ 减少工序（先染色再切割能省 4 倍上色器 —— `LAYOUT_RULES.paintBeforeCut`）
             *   ⑤ 缩短路径（地图无限大，远矿会拖长整条线）
             *
             * 把①说成「唯一」，等于告诉模型「想提效就去买倍率」。而 L12 实测：
             * 处理能力 0.25/s、供给 8/s，买 processors T1 只把它提到 0.375/s ——
             * 杯水车薪，并联才是答案。更麻烦的是 processors T1 要 500 个 `SuSuSuSu`
             * （星矿在世界坐标 85,-23，距 hub 87 格），库存只有 2 个 ——
             * **这条路对这台世界其实是走不通的。**
             *
             * 所以下面这句话的定位收窄了：它不是「提效的唯一办法」，
             * 而是「**一个零占格但需要专门备料的选项**」。并列的 `add` 那条才是主线。
             *
             * ── 下面保留的是原判据中仍然成立的部分 ──
             *
             * 556 个 run 的真实 prompt 里 `upgrade` **一次都没出现** —— 三条入口全关：
             * 系统提示只有宏名没语法；卡片挂在 `UPGRADE_AVAILABLE` 诊断下
             * （判据是「已经买得起」，556 run 触发 0 次）；这一行要求 affordable。
             *
             * 光补「缺 498 个 SuSuSuSu」不够：模型会以为那是**顺带攒**得到的。
             * 而实际需求量是 300-600，单关最多产出 30-170 —— 差一个数量级，
             * 必须专门开一条线。这句话 `assess()` 里早就写好了（`nextActions` 的
             * `build-upgrade-line`），但 loop 从来没调用过 `assess()`，一个字都没送出来。
             *
             * ⚠️ 长度纪律：CAPACITY 有 260 字符上限（测试 D4），因为它与带子列表
             * 抢同一份预算。单独加一行会顶到 454/336，两次打红 —— 所以并进这一行。 */
            const short = up.affordable
                ? "ready now"
                : `needs ${fmtShort(up.missing)} by a dedicated line`;
            /* ⚠️ 必须带 `buy` 这个动词，不能只写参数。
             *
             * `short` 版写的是 `act: buy belt T2 ⇒ …`，而 full 版原来写
             * `belt T2 (×1.5→×2) ⇒ 0.9/s — ready now` —— **两个版本对同一件事
             * 用了两种说法**，而模型看到的可能是任一个（取决于预算）。
             *
             * 更实际的理由：这一行要和 `add N cutter` 并列出现，模型要在
             * 「买」和「造」之间做选择。只给名词短语会让它读成「现状描述」
             * 而不是「一个可以执行的动作」。 */
            roads.push(`buy ${up.line} T${up.tier} (×${up.multiplierFrom}→×${up.multiplierTo}) ⇒ ${fmt(up.capacityAfter)}/s — ${short}`);
        }
        if (roads.length) {
            lines.push("options:");
            for (const r of roads.slice(0, 2)) lines.push(`  · ${r}`);
        }
    }

    const out = lines.join("\n");
    if (room !== null && out.length > room) return null;
    return out;
}

/** 数字格式化：3 位小数对 prompt 是浪费，2 位够；整数不带小数点。 */
function fmt(n) {
    if (!Number.isFinite(n)) return "?";
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, "");
}

/** `0.278` → `28%`；null → 空串（调用方决定要不要省略）。 */
function upper(u) {
    if (u === null || !Number.isFinite(u)) return "";
    return `${Math.round(u * 100)}%`;
}

/** 升级缺口：`SuSuSuSu×500, RuRu----×600` → 超长就折叠成 `3 shapes, 500+600`。 */
function fmtShort(missing) {
    const list = Array.isArray(missing) ? missing : [];
    if (!list.length) return "nothing";
    const one = list.map(m => `${sanitize(m.shape).text}×${m.short}`).join(", ");
    if (one.length <= 46) return one;
    return `${list.length} shapes (${list.map(m => m.short).join("+")})`;
}


/* ══════════════════════════ 7. S4 / S5 / S6 ══════════════════════════ */

/**
 * S4：每条诊断一行，形状是契约里的
 *   `code [layer/severity]: subject; expected ... vs observed ...; handles ...; candidates ...`
 * 硬规矩：**不打印 uid**（§Q3.2），不打印 cell 数字（只打 handle）；诊断条数不截断。
 *
 * ## P-b 的三处渲染修正（都是「模型读不懂」的实测反馈，不是排版洁癖）
 *
 * 1. **`PROCESSOR_REQUIRED` 的 scope 必须说出来**。
 *    这一个码有两种 severity：`scope:"stream"` 是 warn（机器在、只是不在那条流上 = **该做的事**），
 *    `scope:"factory"` 是 blocker（机器根本没有 = **真的坏**）。只打 `[L4/warn]` 时模型分不出
 *    「该加机器」和「该挪机器」；把 `scope=stream op=cut machine=cutter need 1 have 1`
 *    跟在码后面，它才知道要做的是 `replace_run` 而不是 `insert_machine`。
 * 2. **`SHAPE_UNKNOWN` 是 info，不占显眼位置**。它按原因各占一行（隧道 / 无矿图 / 未知 op），
 *    在 L5 这种没有矿图的存档上会把真正可行动的诊断顶下去。折叠成**一行汇总**（含条数与原因），
 *    并且 `candidates` 为空（契约 §3：不许当行动依据）。
 * 3. **超上限要明说**。合并后总量被压到 ≤8（v2 §6）。每码被压掉的条数记在
 *    `evidence.suppressed`，总量被压掉的记在 `evidence.suppressed_total`（两者分开，
 *    混记会让 prompt 说错话）。不打印它们 = 模型以为「诊断就这些」，而它其实看不见一半。
 */
function renderDiagnoses(diagnoses) {
    const list = Array.isArray(diagnoses) ? diagnoses : [];
    const lines = [`## DIAGNOSIS (${list.length})`];
    if (!list.length) {
        lines.push("(no diagnosis: this is the first round, fix the goal directly)");
        return lines.join("\n");
    }

    /* ── 1. info 级 SHAPE_UNKNOWN 折叠成一行（放在最后，不参与编号） ── */
    const visible = [];
    const unknowns = [];
    for (const d of list) {
        if (d && d.code === "SHAPE_UNKNOWN") unknowns.push(d);
        else visible.push(d);
    }

    /* 已渲染过的 hint 原文（用于去重，见下面 `hint:` 那段注释） */
    const seenHints = new Set();
    visible.forEach((d, i) => {        const code = (d && d.code) || "UNKNOWN";
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
        /* ★ PROCESSOR_REQUIRED 必须把 scope/op/machine/need/have 说出来（否则两档 severity 读不出来） */
        const ev = (d && d.evidence) || {};
        if (code === "PROCESSOR_REQUIRED") {
            const bits = [];
            if (ev.scope) bits.push(`scope=${ev.scope}`);
            if (ev.op) bits.push(`op=${ev.op}`);
            if (ev.machine) bits.push(`machine=${ev.machine}`);
            if (num(ev.need) !== null) bits.push(`need=${ev.need}`);
            if (num(ev.have) !== null) bits.push(`have=${ev.have}`);
            if (bits.length) line += `; ${bits.join(" ")}`;
            /* scope 决定「该做什么」：stream=把机器挪到这条流上；factory=先有机器 */
            if (ev.scope === "stream") line += " (the machine exists; put it ON the stream named above)";
            else if (ev.scope === "factory") line += " (the factory does not own this machine yet)";
            if (num(ev.sites) !== null && ev.sites > 0) {
                line += `; ${ev.sites} feasible site(s)`;
            }
            /* ★ 落点必须真的送到模型眼前 ★
             *
             * `site_cells` / `site_handles` 算了很久，但**从来没被渲染过** ——
             * 这两个词在 prompt.mjs 里一次都不出现。于是诊断说「有 15 个可行落点」，
             * 模型一个都拿不到，只能继续 `$path_of(["B434"])` 猜，然后
             * `PATH_NOT_RECT` / `occupied` 连撞三轮。
             *
             * 只给**句柄**不给坐标：prompt 里不出现坐标是本文件的硬约束（见文件头），
             * `sanitize()` 会把数字对打成 `<coord>`。而句柄正是 `insert_machine` 的
             * `at:{$ref,asCell:true}` 直接接受的东西，也正是模型该用的形态。 */
            if (Array.isArray(ev.site_handles) && ev.site_handles.length) {
                line += `; a ${ev.machine} can go on: ${ev.site_handles.slice(0, 4).join(",")}`
                    + ` (at:{$ref:"<handle>",asCell:true}; facing follows the belt flow)`;
            }
            if (num(ev.free_sites) !== null && ev.free_sites === 0) {
                line += "; NO empty site — clear space first (remove_run / trash_unused)";
            }
        }
        /* ★ MACHINE_STARVED 的「从哪接」—— 从「指出缺口」到「可施工」的关键 ★
         *
         * `evidence.feed_sources` 是 semantic 层算出的「最近、且输出口空闲的 3 台机器」。
         * 只算距离，**不判断矿种对不对** —— 那该由模型结合 `## MACHINES` 的
         * `采green` 标注自己决定。
         *
         * 不给这一段时，模型只知道「C3 的 color 槽空」，然后从 17 台机器里瞎挑；
         * 实测挑中的是 66 格外的 M7（路线横穿主干道，闸门拒）。
         * 而同一份世界上 `C8`（mixer）只要 16 格/拆 2 条就能接上。
         *
         * ⚠️ 这段必须放在 `PROCESSOR_REQUIRED` 的 `if` **外面** ——
         * 第一版插在里面，`code === "MACHINE_STARVED"` 永远为假，静默不生效。 */
        if (code === "MACHINE_STARVED" && Array.isArray(ev.feed_sources) && ev.feed_sources.length) {
            /* `disconnect` 是 `connect` 自己算出的「覆盖这条路径会让多少下游断供」。
             *
             * 实测它是**唯一**能预测「能否过预演闸门」的量（L12 到 C3.color）：
             *   M13 0 / M15 0 → 落地；M14 3 / M16 3 / M7 3 / M9 3 / M11 1 → 全拒
             * 距离不准（M11 只 120 格却被拒），「拆几条」也不准（M11 只拆 1 条）。
             *
             * 所以必须把它印出来：模型看到 `会切断 3 处` 就知道别选，
             * 看到 `不会切断` 就知道这条路是安全的。 */
            /* ★ 缺的是哪种颜色 —— 必须说出来 ★
             *
             * 真机 `r-20261121190439-6190`：诊断推荐了**绿矿**，模型照接，
             * tx 成功、货真的流了、hub 真入库 9 件 —— 产出的是 `CgScScCg`
             * （上一关 L11 的目标），而这一关要 `CbCbCbRb:CwCwCwCw`。
             *
             * 原文案里「white」「color」「green」这些词出现 **0 次** ——
             * 模型没有任何依据知道该拉什么颜色。
             *
             * 现在把三件事摊开：目标要哪几种、地图上有哪几种、哪几种只能靠合成。
             * 最后那句是关键：**白颜料没有矿，拉任何一条矿线都是在造错的东西**。 */
            const fc = ev.feed_color;
            if (fc && Array.isArray(fc.want) && fc.want.length) {
                line += `; this slot needs a PIGMENT — the goal needs ${fc.want.join("+")}`;
                if (Array.isArray(fc.on_map) && fc.on_map.length) {
                    line += `; ore on this map: ${fc.on_map.join("/")}`;
                }
                if (Array.isArray(fc.must_mix) && fc.must_mix.length) {
                    line += `. ⚠️ ${fc.must_mix.join("/")} has NO ore — it can only come from a mixer cascade,`
                        + ` so a miner of any other colour feeds the WRONG colour`;
                } else if (fc.want.length) {
                    line += "";
                }
            }
            line += `; nearest sources with a free output: `
                + ev.feed_sources.map(s => {
                    const cost = typeof s.disconnect === "number"
                        ? (s.disconnect === 0 ? ", 安全" : `, 会切断${s.disconnect}处`)
                        : "";
                    const mix = s.mustMix ? ", 造缺失色" : "";
                    return `${s.handle}(${s.type}, ${s.d}格${cost}${mix})`;
                }).join(", ");
        }
        /* WRONG_SHAPE_AT_HUB：病在上游，不在入口（v2 §4 的那句必须出现） */
        if (code === "WRONG_SHAPE_AT_HUB") {
            line += "; the fix is upstream: a missing process step on the line that FEEDS the hub, not at the inlet";
        }
        if (hs.length) {
            /* ★ 说清 handles 是什么 ★
             *
             * 2026-10-30（第十四轮实测）：`PROCESSOR_REQUIRED` 的 handles 是**可行落点**，
             * 而模型没有理由知道这点 —— 它把 handles 和"流上的带子"混用，
             * 一次塞 6 个进 `$path_of` 得到 PATH_NOT_RECT。
             *
             * ⚠️ 这里原来写的是「pass them to $path_of as the region」——
             * 那句话把模型引向 `replace_run`，而那些落点**在流上是散开的**，
             * `$path_of` 算不出矩形 ⇒ 第 9 关实测三连败（PATH_NOT_RECT / 太窄 / 接不到来料）。
             * 而同一批句柄在 `insert_machine {at:{$ref,asCell:true}}` 下**全部成功**。
             * 现在改成指向真正会成功的那个形态。 */
            const hint = code === "PROCESSOR_REQUIRED"
                ? ` (these are cells that can hold the machine — pass one to insert_machine as at:{$ref:"<handle>",asCell:true})`
                : "";
            line += `; handles ${hs.join(",")}${hint}`;
        }
        if (Array.isArray(ev.stream_handles) && ev.stream_handles.length) {
            line += `; the stream itself runs through ${ev.stream_handles.slice(0, 3).join(",")} (context only, not the region)`;
        }
        /* ★ `hub_inlets` 必须渲染 —— 否则整条诊断无法执行 ★
         *
         * `dropInlets`（loop.mjs:812）会把 hub 入口带的句柄从 `evidence.handles`
         * 里摘掉，因为 `pickBelts` 按 `evidence.handles` 决定谁进 BELTS 段，
         * 留着就等于把入口顶上去。那个设计对**旧**诊断是对的。
         *
         * 但 `HUB_FED_BY_COLOR` 的整个 payload 就是那几条入口带 —— 句柄被摘走、
         * `hub_inlets` 又没人渲染，模型于是收到一句无法执行的话：
         * 「4 条入口带在送颜料」却不给它任何名字。
         *
         * 实测（8 个 run / 40 轮）：这条诊断 40/40 出现在 DIAGNOSIS 第 1 行，
         * 但 94 次调用**没有一次**提到那 4 条带（B452/B454/B455/B575）——
         * 它只能去够最近的可指名目标 B106，于是继续空转。
         *
         * 现在把名字明确排出来，并说明它们是可操作的入口带。 */
        if (Array.isArray(ev.hub_inlets) && ev.hub_inlets.length) {
            line += `; the hub-inlet belts are ${ev.hub_inlets.slice(0, 6).join(",")} `
                + `(these are real belt handles — you can pass them to replace_run / connect)`;
        }
        /* ★ 把 `hint` 交给模型 ★
         *
         * ## 为什么这条比前面所有修复都值钱
         *
         * `MACRO_REFUSED` 诊断里带着 `hint`（`loop.mjs:1232` 的 `hint: e.hint || null`），
         * 而那个 hint 是宏**已经算出的解法**。以 `connect:occupied` 为例
         * （`connect.mjs:987-993`）：
         *
         *   「有 N 条走法只需要覆盖既有带子（最少 M 格）就能通 —— 传 opts.allow_replace=true 即可」
         *
         * —— 宏枚举了几千条走法，发现它们**只差一个开关**。这句话到了诊断里，
         * 却从来没到过 prompt。
         *
         * 实测（`CONNECT-OCCUPIED-DIAGNOSIS.md`，7 个唯一失败调用）：
         *   · 4/7 是端口落点被占死（与路径无关，换端口即可）
         *   · 3/7 只差 `allow_replace:true`，宏已枚举出 89~1045 条合法折线
         *   · **0/7 需要更好的布线**
         *
         * 也就是说 `connect.mjs:966` 那句「要绕开需要阶段 3 的布线」是**写死的兜底文案**，
         * 在这批样本上一次都不成立。真正的问题是这句话没被换掉、也没被送出去。
         *
         * ## 措辞纪律
         *
         * hint 是宏写的，**不含坐标**（`connect.mjs` 的 hint 只出现格数、开关名、句柄）。
         * 但它是**自由文本**，所以仍然过 `sanitize`，与其它段同一套清洗 ——
         * 不能因为「我们自己写的」就跳过。
         *
         * 截 180 字符：`connect` 的 hint 有两句（第一句给解法、第二句说自交走法救不了），
         * 180 够覆盖第一句 + 半句补充。整段超过预算时宁可截断也不整条丢 ——
         * **解法的一部分 > 一点没有**。 */
        if (typeof d.hint === "string" && d.hint.trim()) {
            /* ★ 不同诊断的 hint 需要不同额度 ★
             *
             * 默认 180 是给 `connect` 那种「一句解法 + 半句补充」写的。
             * 但有些诊断的解法**必须包含操作语法**，截到 180 就只剩前半句的「为什么」，
             * 后半句「怎么写」被吃掉 —— 模型看懂病因却动不了手。
             *
             * 实测（r-20261118210356-3d48）：`HUB_FED_BY_COLOR` 的 hint 里，
             * 「这几条入口带互不相邻，删除要给 remove_run 传 allow_scattered:true」
             * 落在 180 之后，从未到达。模型于是提出一个必然被
             * `run_not_contiguous` 拒掉的 remove_run。
             *
             * 给这类「解法含语法」的诊断 400：它排在 DIAGNOSIS 第一行，
             * 而且整个 prompt 仍有 24000 的硬预算兜底。 */
            const CAP_WIDE = 400;
            const wide = d.code === "HUB_FED_BY_COLOR" || d.code === "HUB_INLET_THIN";
            const h = clip(sanitize(d.hint).text.trim(), wide ? CAP_WIDE : 180);
            /* ★ 同一条 hint 只渲染一次（2026-11-15 夜，L12 真机）★
             *
             * 实测：8 条诊断里三条 `BELT_HANDOFF_REJECTED` 的 hint 是 226/225/225 字符，
             * 内容几乎相同（同一个宏的同一套解释，只在句柄或格数上差一两个字符）。
             * 三条加起来占掉 676 字符 —— 而 prompt 正是被这个量级的浪费撑到
             * `PROMPT_OVER_BUDGET` 硬失败的（16372 > 16000，整个 run outcome:INTERNAL）。
             *
             * 重复的措辞不带来信息：模型读到第二条时已经知道该怎么办了。
             *
             * ## 为什么用**前缀指纹**而不是全等比较
             *
             * 第一版写成 `seenHints.has(h)`（全等），实测**一条都没去掉** ——
             * 那三条 hint 是 226/225/225，差一两个字符，全等比较必然失手。
             *
             * 改成取前 60 字符作指纹：同一段解释的开头必然相同，而
             * 真正不同的 hint（`ambiguous_port` 的「use one of」、
             * `port_already_bound` 的「传 opts.rebind」）开头就分道扬镳了。
             * 60 这个长度是「够长到不误判、够短到能抓住句柄差异」的折中。 */
            const fp = h ? h.slice(0, 60) : "";
            if (h && seenHints.has(fp)) {
                line += `; hint: (same as above)`;
            } else {
                if (h) seenHints.add(fp);
                if (h) line += `; hint: ${h}`;
            }
        }
        if (cands.length) line += `; candidates ${cands.join(",")}`;
        /* 超上限被压掉的条数：必须说出来，否则模型以为「诊断就这些」 */
        if (num(ev.suppressed) !== null && ev.suppressed > 0) {
            line += `; (+${ev.suppressed} more of this code not shown)`;
        }
        lines.push(sanitize(line).text);
    });

    /* ── 2. SHAPE_UNKNOWN 的汇总行（一行，不占编号） ── */
    if (unknowns.length) {
        let total = 0;
        const reasons = [];
        for (const d of unknowns) {
            const ev = d.evidence || {};
            total += num(ev.count) !== null ? ev.count : 1;
            const r = typeof ev.reason === "string" ? ev.reason : "unknown";
            if (!reasons.includes(r)) reasons.push(r);
        }
        lines.push(`- (info) SHAPE_UNKNOWN ×${unknowns.length} group(s) / ${total} entity(s): `
            + `shape propagation could not be computed (${reasons.join(", ")}). `
            + "This is NOT an action item — do not try to fix it; work from the diagnoses above.");
    }

    /* ── 3. 总量截断的兜底提示（`evidence.suppressed_total` 由 `diagnose` 的合并上限写入） ── */
    const sumTotal = list.reduce((s, d) => s + (num(d && d.evidence && d.evidence.suppressed_total) || 0), 0);
    if (sumTotal > 0) {
        lines.push(`- (${sumTotal} more diagnoses not shown: the list is capped at 8 total, 3 per code)`);
    }
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
    /* ★ 2026-11-02：把上一轮**为什么失败**说出来 ★
     *
     * 原来 `LAST ROUND` 只说「round 2: calls [connect]; codes: MACRO_REFUSED」。
     * 模型知道上一轮用了 connect、失败了，但**不知道失败的原因和修法** ——
     * 于是它只能猜（实测：它常常重写一个几乎一样的计划）。
     *
     * `lastRound.failures` 由 `loop.mjs` 在 `settleFailure` 时填，每条形如
     * `{ macro, code, hint }`。`hint` 是宏**已经算出的解法**
     * （见 `MACRO_REFUSED` 的 `hint: e.hint`）。
     *
     * 这与「把 hint 渲染进 DIAGNOSIS」是两条不同的通路：
     *   · DIAGNOSIS 的 hint 说明**这一轮的世界诊断**该怎么修
     *   · LAST ROUND 的失败说明**上一轮那个计划**为什么不行
     * 模型两者都需要：前者告诉它做什么，后者告诉它别再做什么。
     *
     * 截 2 条 × 每条 100 字符：预算紧，而且第 3 条之后的信息量急剧下降。 */
    const fails = Array.isArray(lastRound.failures) ? lastRound.failures : [];
    if (fails.length) {
        lines.push("previous failures:");
        for (const f of fails.slice(0, 2)) {
            const mac = f && f.macro ? String(f.macro) : "?";
            const code = f && f.code ? String(f.code) : "?";
            /* `unverified` = 那个调用**根本没被检验**（前面某个调用先失败了）。
             *
             * 这个区分很重要：`unverified` 的宏**不必换**（它可能本来是对的），
             * 而带真错误码的那个**必须换**。
             *
             * 上一版把所有宏都挂上同一个 hint，会让模型以为整批都坏了 ⇒ 整批重写。
             * 红队（`REDTEAM-PARTIAL-APPLY.md` §Q4.1）指出这是真 bug。 */
            if (code === "unverified") {
                lines.push(`  · ${mac} → not reached (an earlier call failed first)`);
                continue;
            }
            /* ★ `observed` 是**这一步的代价数字**，必须出现 ★
             *
             * 预演闸门（`stage:"simulate"`）的全部信息量在这里：
             * 「到 hub 的带子 254 → 232（-22），死带子 282 → 311」。
             * 只给 `code` + `hint` 的话模型知道"被拒了"，但不知道**有多糟** ——
             * 于是下一轮换个写法接着试（第 9 关实测）。
             *
             * 与 code 放**同一行**：`<macro> → <code>: <observed>`。
             * 拆成两行会让「哪个宏、什么码」这条最基本信息离开首行，
             * 而下游测试与模型都按首行找它。 */
            const obsTxt = f && f.observed ? clip(sanitize(String(f.observed)).text.trim(), 110) : "";
            const hint = f && f.hint ? clip(sanitize(String(f.hint)).text.trim(), 100) : "";
            /* ★ `ambiguous_port` 的答案在 `candidates` 里，必须rendered ★
             *
             * 真机（第 9 关 r-20261112151848-86fe）：模型连 2 轮写
             * `to:{ref:"C7", port:"color"}`，而 mixer 两个 color 槽的 role
             * **都叫 color** ⇒ `ambiguous_port`。宏其实已经把 `{role,index,cell}`
             * 算好了放进 `candidates`，但上一版只渲染 code + hint，
             * 于是模型只看到「ambiguous_port」六个字，**只能猜**。
             *
             * 只对 `ambiguous_port` 渲染：其它错误的 candidates 往往是
             * 「可以连的端口表」这种长列表，预算撑不住，而且不是必需的答案。 */
            /* ★ 候选清单不只对 `ambiguous_port` 有意义（2026-11-15 夜，L12 真机）★
             *
             * 原来只有 `code === "ambiguous_port"` 才渲染 `↳ use one of:`。
             * 而 `bad_type`（角色名写错，如把 `primary` 写成 `right`）**也带 candidates**
             * —— 宏把可选角色算出来了，只是没进 prompt。
             *
             * 实测：模型连着 4 轮写 `port:"right"` / `port:"left"`，每次撞 `bad_type`，
             * 每次的 candidates 里都明明白白列着 `primary` / `color` / `shape`，
             * 而它一次都没看到 —— 因为渲染条件是写死的 `ambiguous_port`。
             *
             * 现在 `bad_type` 也走这条路径。其它错误码的 candidates 往往是
             * 「能连的端口表」这种长列表，预算撑不住，仍然不渲染。 */
            const candCode = code === "ambiguous_port" || code === "bad_type";
            if (candCode && Array.isArray(f.candidates) && f.candidates.length) {
                const opts = f.candidates
                    .filter(c => c && typeof c.role === "string" && Number.isInteger(c.index))
                    .slice(0, 4)
                    .map(c => `{role:"${c.role}", index:${c.index}}`);
                if (opts.length) {
                    lines.push(`  · ${mac} → ${code}${obsTxt ? `: ${obsTxt}` : ""}`);
                    lines.push(`    ↳ use one of: ${opts.join(" | ")}`);
                    /* ★ 「用其中**一个**」这句话必须说出来（2026-11-15 夜，L12 真机）★
                     *
                     * 上面那行候选清单从 2026-11-12 就在渲染了，但真机实测：
                     * agent 连着三轮在同一台 mixer 上写 `port:"color"`，每次都被
                     * `ambiguous_port` 拒掉，每次都能看到候选，**每次都没用**。
                     *
                     * 原因不是信息没到，是那行长得像「可选值列表」——
                     * 模型读成「color 是合法值」而不是「有**两个**都叫 color，
                     * 你必须用下标指名是哪一个」。缺的是**为什么**，不是**是什么**。
                     *
                     * 一行成本，把「歧义」这件事说穿。 */
                    /* 这句只对 `ambiguous_port` 成立 —— `bad_type` 的情况是
                       「角色名根本不存在」，不是「两个同名」。 */
                    if (code === "ambiguous_port" && opts.length > 1) {
                        lines.push(`    ↳ These ${opts.length} ports share the SAME role name — `
                            + `writing port:"${f.candidates[0].role}" is ambiguous and will be rejected again. `
                            + `Pass the whole object, e.g. port:${opts[0]}.`);
                    }
                    /* ⚠️ 走这条路径时也要把 hint 放出来 ——
                       `continue` 会跳过下面那行 hint 渲染，于是
                       `bad_type` 的「角色只有 primary / color / shape」这句
                       就又丢了。candidates 解决「有哪些」，hint 解决「为什么」。 */
                    if (hint) lines.push(`    ↳ ${hint}`);
                    continue;
                }
            }
            lines.push(`  · ${mac} → ${code}${obsTxt ? `: ${obsTxt}` : ""}${!obsTxt && hint ? `: ${hint}` : ""}`);
            if (obsTxt && hint) lines.push(`    ↳ ${hint}`);
        }
        if (fails.length > 2) lines.push(`  (+${fails.length - 2} more)`);
    }
    /* ★ 上一轮那些宏**算出来的后果**（P17 §6.1）★
     *
     * 宏的 `warnings` 一直有：`would-disconnect` / `removal-is-clean` /
     * `starved-items-unknown` / `rv-drift` … 但这些**从来没进过 prompt**
     * （只写进 transcript 的 `plan` 事件，见 loop.mjs 的 `tr.w.write("plan", …)`）。
     *
     * 后果很直接：模型执行 remove_run 之后，下一轮只知道「我删了 3 格」，
     * 不知道「删得干不干净」。它没有任何依据判断上一步是成功还是闯祸。
     * 这正是 P17 查出来它不敢拆的原因 —— 缺的不是理由，是**后果的确定感**。
     *
     * 只渲染带 `detail` 的那几条（宏都写了），每条截 150 字符，
     * 最多 3 条：预算是硬的，而 `stranded-items-unknown` 这类「不知道」的噪音
     * 价值低于 `removal-is-clean` 这类「我知道」的结论。
     * `stranded-items-unknown` 显式排除 —— 它说的是在途物品数拿不到，
     * 与「这一刀安不安全」无关，每轮都出现只会淹没真正的结论。 */
    const mw = Array.isArray(lastRound.macro_warnings) ? lastRound.macro_warnings : [];
    const USEFUL = mw.filter(w => w && w.code && w.code !== "stranded-items-unknown");
    if (USEFUL.length) {
        lines.push("consequences of last round's calls:");
        for (const w of USEFUL.slice(0, 3)) {
            const mac = w.macro ? `${w.macro}: ` : "";
            const det = w.detail ? clip(sanitize(String(w.detail)).text.trim(), 150) : "";
            lines.push(`  · ${mac}${w.code}${det ? ` — ${det}` : ""}`);
        }
        if (USEFUL.length > 3) lines.push(`  (+${USEFUL.length - 3} more)`);
    }
    if (lastRound.decision || lastRound.verdict) lines.push(`decision: ${lastRound.decision || lastRound.verdict}`);
    return sanitize(lines.join("\n")).text;
}

/**
 * `## LAST STEP` —— 上一轮 tx 对**世界健康度**的净影响（机器算的，不是模型自评）。
 *
 * ## 为什么需要它（与 `## LAST ROUND` 的区别）
 *
 * `LAST ROUND` 说「上一轮调了什么、verify 红在哪」。**它不含「世界因此变好还是变坏」**。
 * 实测的后果（2026-11-03，用户贴图那次）：模型连续几轮把死带子从一处挪到另一处，
 * 每轮 verify 都红（因为目标没交货），每轮都不知道自己刚刚让局面更糟了 ——
 * 到 hub 的带子从 71 掉到 60 多，它一次都没被告知。
 *
 * 这一段的每个字都来自 `health.mjs` 的 `classifyNetEffect()`：
 *
 *   positive      目标交付涨了
 *   cleanup       死带子变少 / 到 hub 的变多 / 带上的货变多（改善，但没交货）
 *   constructive  只加东西，目标没动
 *   regressive    **它把世界改坏了**
 *   churn         世界形态变了，但所有健康指标都没动（等价替换）
 *   inert         世界完全没变
 *
 * 只写判定与**具体数字**，不给修法 —— 修法是模型的事，也是诊断的职责。
 * 没有 `lastNetEffect`（首轮）时整段不出现，不占预算。
 *
 * @param {object|null} e `{kind, why:[], delta:[]}`
 * @returns {string|null} 无内容时返回 null（调用方据此整段省略）
 */
function renderLastStep(e) {
    if (!e || typeof e !== "object" || typeof e.kind !== "string") return null;
    const LABEL = {
        positive: "GOOD — the goal advanced",
        cleanup: "GOOD — the world got cleaner (but nothing delivered yet)",
        constructive: "NEUTRAL — you added things, the goal did not move",
        /* ★ 与 `constructive` 的区别（2026-11-15 夜，L12 真机）★
         *
         * `constructive` 至少「顺带改善」了点东西（死带子少了 / 到 hub 的多了）。
         * 这一档什么改善都没有：规模涨了，但**带上的货一件没多** ——
         * 新加的东西没有接进任何活着的货流里，世界根本没动。
         *
         * 实测：`production()` 恒为空，而 agent 连续七八轮加带子/加机器，
         * 每轮判 constructive。世界 435→467 实体、带子 382→411，产出始终 0。
         * 判据一路给绿灯，它就一直在往死掉的世界里堆料。
         *
         * 所以这一档必须说清「你加的东西是死的」，而不只是「目标没动」。 */
        stalled_growth: "WASTE — you added things, but the world did not move at all "
            + "(no goods started flowing, nothing produced). What you added is not connected to any live flow",
        regressive: "BAD — this made the world WORSE",
        churn: "WASTE — the world changed but nothing measurable improved",
        inert: "WASTE — the world did not change at all",
        /* ★ 撤销档（2026-11-03）★
         *
         * 这一档出现时，世界**已经被系统还原了** —— 与 `regressive` 是完全不同的指令：
         *
         *   regressive：「你把它改坏了，**你**得修」
         *   reverted  ：「你把它改坏了，**我**已经替你撤了，换一个动作」
         *
         * 混为一谈会让模型以为还要去补救一个已经不存在的破坏
         * （它很可能会去「修」那条其实完好无损的带子）。 */
        reverted: "UNDONE — your last change was rolled back automatically",
    };
    const label = LABEL[e.kind];
    if (!label) return null;
    const lines = ["## LAST STEP", `your last change: ${e.kind} — ${label}`];
    for (const w of (Array.isArray(e.why) ? e.why : []).slice(0, 3)) {
        const s = typeof w === "string" ? w.replace(/\s+/g, " ").trim() : "";
        if (s) lines.push(`  · ${clip(s, 110)}`);
    }
    if (e.kind === "regressive") {
        lines.push("⇒ Repeating a change of this kind will keep making it worse. "
            + "Pick a different target or a different macro — the diagnosis below is not the whole story.");
    } else if (e.kind === "stalled_growth") {
        /* 与 churn/inert 分开：那两档是「没做什么」，这一档是「做了，但做的东西是死的」。
           指令完全不同 —— 它不需要「换个动作」，它需要「先让已有的东西通起来」。 */
        lines.push("⇒ You DID add things, but the world state did not move: goods did not start flowing, "
            + "nothing was produced. That means what you added is not connected to a live flow. "
            + "Before adding anything else, find a path that already carries goods and extend/repair THAT — "
            + "or fix the one belt that breaks the handoff. Adding more disconnected belts will keep scoring zero.");
    } else if (e.kind === "churn" || e.kind === "inert") {
        lines.push("⇒ Nothing improved last round. Repeating the same shape of action will waste another round.");
    } else if (e.kind === "reverted") {
        /* 必须明确说「世界已经回到原样」—— 否则模型会去修一个不存在的洞。 */
        lines.push("⇒ The world is back to how it was BEFORE that change. Do NOT try to repair it — "
            + "nothing is broken. The action you picked was judged harmful; choose a different one.");
    }
    return sanitize(lines.join("\n")).text;
}

/**
 * `## PRIOR ATTEMPTS` —— 这个目标下**以前试过什么**（跨 run 记忆）。
 *
 * ## 为什么需要它
 *
 * 实测：8 次 run 里 6 次 `goal_delta = 0`、实体数不变；同一批宏在同一个诊断指纹下
 * 被反复重试。模型没有跨 run 记忆 —— 每次 run 都是白纸。
 *
 * ## 为什么按 goal 分组（这一条最容易被忽略，也最致命）
 *
 * level 5 的目标是 `Cu----Cu`，那条线的经验对 level 6 的 `Cu------` **是误导**。
 * 用户贴图那次正是这个成因：世界升到 level 6，旧的 level-5 产线没拆，
 * 变成 41% 到不了 hub 的死带子。若记忆也不分组，模型会拿旧关卡的成功经验重演一遍。
 * 分组在 `attemptsForGoal` 里做（`mem.goals[goalShape]`），这里拿到的已经是本目标的。
 *
 * ## 只陈述事实，不给死禁令
 *
 * 每条只写「哪个宏 → 世界变成什么样」。**不能写「所以别用 X」**：
 * 记忆里只有宏名、没有当时的目标/句柄，同一个 `remove_run` 在 A 处被撤销、
 * 在 B 处可能正是正确动作。写成全局禁令会堵死正确施工，
 * 还会逼模型编造「这次为什么不一样」的理由。
 *
 * 所以最后一句只提醒「被撤销过的动作值得先想清楚」，不禁止重复。
 *
 * @param {Array|null} attempts `attemptsForGoal` 的返回
 * @returns {string|null} 无内容时 null（整段不出现，不占预算）
 */
function renderPriorAttempts(attempts) {
    if (!Array.isArray(attempts) || !attempts.length) return null;
    const LABEL = {
        reverted: "ROLLED BACK automatically — judged harmful",
        regressive: "made the world worse",
        positive: "delivered (goal advanced)",
        cleanup: "cleaned up (fewer dead belts)",
        inert: "changed nothing",
    };
    const lines = ["## PRIOR ATTEMPTS", "your own past attempts on THIS goal, most informative first:"];
    for (const a of attempts.slice(0, 6)) {
        const kind = String(a && a.kind || "");
        const label = LABEL[kind];
        if (!label) continue;
        const macros = Array.isArray(a.macros) ? a.macros.filter(Boolean) : [];
        if (!macros.length) continue;
        const ctx = a.ctx && typeof a.ctx === "object" ? a.ctx : null;
        const bits = [];
        if (ctx && Number.isFinite(ctx.belts_reaching_hub) && Number.isFinite(ctx.entities)) {
            bits.push(`on a ${ctx.entities}-entity world with ${ctx.belts_reaching_hub} belts reaching the hub`);
        }
        const why = Array.isArray(a.why) && a.why.length ? ` — ${clip(sanitize(String(a.why[0])).text, 95)}` : "";
        /* ★ 别让「最硬的历史结论」看起来像「最近一次也是这样」★
         *
         * `mergeMemory` 保留的是**最硬**的 kind（例如一次 `reverted` 会一直压着
         * 后来的 `inert`），否则一次「碰巧没变化」就能把机器判定过的负例洗掉。
         * 但如果只显示最硬的，模型会以为这个动作**每次**都被撤销 ——
         * 而它可能已经换了局势、最近一次其实是 inert。
         *
         * 所以带 `n` / `last_kind` 时补一句「见过几次、最近一次是什么」。
         * 这样既守住负例，又不会让旧结论永久冒充现状。 */
        const n = Number.isFinite(a.n) ? a.n : 1;
        const recent = (n > 1 && typeof a.last_kind === "string" && a.last_kind !== kind)
            ? ` [seen ${n}×; most recent: ${LABEL[a.last_kind] || a.last_kind}]`
            : (n > 1 ? ` [seen ${n}×]` : "");
        lines.push(`  · ${macros.join(" + ")} → ${label}${why}${bits.length ? ` (${bits[0]})` : ""}${recent}`);
    }
    /* 一条记录也渲染。
     *
     * 曾经在这里放过「少于 2 条不出现」的预算门槛，实测直接把功能废掉了：
     * 第一次 run 结束后记忆里**往往正好只有一条**，第二次 run 就完全没有历史 ——
     * 而「第一次 run → 第二次 run」恰恰是最需要记忆的时刻
     * （8 次 run 里 6 次 goal_delta=0，都是在这个阶段反复重试）。
     * 一段最多 6 行、约 400 字符，比让模型重复一次已知失败便宜得多。 */
    if (lines.length <= 2) return null;   // 没有任何可渲染的条目

    lines.push("⇒ These are facts about past worlds, not rules for this one. "
        + "A macro that hurt once may be right here — but an attempt that was ROLLED BACK "
        + "was judged harmful by the system, so check the current diagnosis before repeating it.");
    return sanitize(lines.join("\n")).text;
}

/**
 * `## THIS RUN` —— 本次 run 里我自己的决策轨迹。
 *
 * ## 为什么需要（第 9 关实测的策略漂移）
 *
 * 第 9 关的 `MIXER_UNFED` 明确写着「红矿在 44 格外，这不是接一根线，
 * 是一条要单独规划的长支线」。模型第 4 轮的 `say` 原文：
 *
 *   place the existing mixer concept on the blue stream at B194 so the mix step
 *   sits in-line, **rather than building a far-off color branch first**
 *
 * 它**知道**那个选项，主动选择先做别的。然后下一轮完全忘了 —— 又试 connect、
 * 又放 mixer，三轮下来一步没往支线走。
 *
 * 根因不是「信息没送到」（诊断写得很清楚），而是**跨轮没有目标坚持**：
 * 每轮都是新 prompt，`## LAST ROUND` 只带上一轮，不带「我前几轮决定过什么」。
 *
 * ## 与 `## PRIOR ATTEMPTS` 的分工
 *
 *   · PRIOR ATTEMPTS = **跨 run** 的统计结论（「这个宏在这个目标上历来没用」）
 *   · THIS RUN       = **本次 run** 的意图轨迹（「我第 4 轮说要先放 mixer」）
 *
 * 两者都要有：前者防重蹈覆辙，后者防半途而废。
 *
 * ## 预算
 *
 * 只列最近 4 轮、每轮一句话（`say` 截 90 字符）。再多就是噪音 ——
 * 模型真正需要的是「我刚才在干什么」，不是完整日志。
 *
 * @param {Array|null} log `st.runLog`，每项 `{round, say, calls, outcome}`
 * @returns {string|null} 无内容时 null
 */
function renderRunLog(log) {
    if (!Array.isArray(log) || !log.length) return null;
    const OUTCOME = {
        planned: "planned",
        positive: "delivered",
        cleanup: "cleaned up",
        constructive: "added stuff, no delivery",
        /* 与 `constructive` 的区别：那是「加了东西没交货」，这是「加了东西世界根本没动」——
           后者是更强的否定（这条线压根没接进任何活货流）。 */
        stalled_growth: "added dead belts — nothing started flowing",
        reactive: "made it worse",
        regressive: "made it worse",
        inert: "changed nothing",
        churn: "sideways move",
        failed: "did not apply",
    };
    const recent = log.slice(-4);
    const lines = ["## THIS RUN", "what you decided earlier in THIS run (most recent last):"];
    for (const r of recent) {
        const round = Number.isFinite(r && r.round) ? r.round : "?";
        const out = OUTCOME[String(r && r.outcome)] || String((r && r.outcome) || "");
        /* ★ 优先渲染 `detail`（落了什么），没有才退回宏名 ★
         *
         * 只写宏名等于告诉模型「你用过 insert_machine」，而它需要的是
         * 「你刚把一台 miner 放在 blue ore 上」—— 前者不能指导下一步，
         * 后者能（「去接它」）。见 summarizeCalls 的注释。 */
        const detail = Array.isArray(r && r.detail) && r.detail.length
            ? r.detail.join(" + ")
            : (Array.isArray(r.calls) && r.calls.length ? r.calls.join("+") : "(no calls)");
        const say = r && typeof r.say === "string" && r.say.trim()
            ? ` — "${clip(sanitize(r.say).text.trim(), 90)}"`
            : "";
        lines.push(`  · r${round} ${clip(sanitize(detail).text, 110)} → ${out}${say}`);
    }
    lines.push(
        "⇒ Stay on one plan until it is DONE or proven impossible. If an earlier round named"
        + " something it deliberately postponed (\"rather than ... first\"), either do it now"
        + " or say plainly why you are abandoning it. Do not silently restart the same step.",
        "⇒ Anything you already PLACED is still there — connect it or continue from it."
        + " Re-placing the same thing usually just collides with what you built.",
    );
    return sanitize(lines.join("\n")).text;
}

/**
 * `## STICKY GOAL` —— 一件需要跨多轮才能做成的事，别被眼前的红点挤掉。
 *
 * ## 为什么单独一段（第 9 关的「修症状」循环）
 *
 * `MIXER_UNFED` 一出现就说清「红矿 44 格外，这是要规划的长支线」。
 * 但每轮 observe 都重算一堆诊断，结构层那些 `BELT_HANDOFF_REJECTED` /
 * `CHAIN_UNFED` 是眼前看得见的红点 —— 模型连续 8 轮都在修它们、`tx=5`，
 * **一次都没往红矿那个方向走**。
 *
 * 诊断是「每轮重新拍的快照」，没有「哪件事一直没做成」的概念。
 * loop 侧已经把连续 ≥2 轮的成因类诊断置顶（`st.stickyGoal`），
 * 这一段负责把「它是长期目标」这件事明确说出来 ——
 * 光置顶不够，模型仍会按「先修最红的」这条本能行事。
 *
 * @param {object|null} g `{code, since, rounds}`
 * @returns {string|null} 无内容时 null
 */
function renderStickyGoal(g) {
    if (!g || typeof g !== "object" || !g.code) return null;
    const rounds = Number.isFinite(g.rounds) ? g.rounds : 1;
    return sanitize([
        "## STICKY GOAL",
        `\`${g.code}\` has been present for ${rounds} rounds and is the CAUSE, not a symptom.`,
        "It is listed first in DIAGNOSIS for that reason — the structural red spots below it",
        "(handoff rejections, dead ends) are downstream of it: fixing them will not make",
        "this goal produce anything.",
        "⇒ Spend this round on the sticky goal. If it cannot be finished in one round, do the",
        "  next concrete step toward it (place what it needs, or lay one segment) and say in",
        "  `say` which step you are on. Do not go back to patching the red spots.",
    ].join("\n")).text;
}

/**
 * `## GOAL CHANGED` —— 世界在本次 run 中途升级了。
 *
 * ## 为什么单独一段，而不是只靠 DIAGNOSIS
 *
 * 换关时诊断列表已经很长（实测 7 条以上），`GOAL_CHANGED` 排在里面会被淹没。
 * 但它改变的是**整件事的前提**：要造的东西换了，之前所有判断的对象都变了。
 * 这种级别的信息必须出现在诊断列表**之前**。
 *
 * ## 为什么还要提「残线」
 *
 * 换关之后最典型的失败不是「不会造新形状」，而是「**继续在旧线上修**」。
 * 实测：level 5 → 6 之后，模型连着几轮在修那条造着 `Cu----Cu` 的线，
 * 而它一件都进不了 hub。这一段把「那条线现在是什么」直接点名。
 *
 * @param {object|null} g `{from, to, level_from, level_to}`
 * @param {Array|null} obsolete `findObsoleteLines` 的结果
 * @returns {string|null} 无内容时 null
 */
function renderGoalChanged(g, obsolete) {
    if (!g || typeof g !== "object" || !g.to) return null;
    const from = typeof g.from === "string" ? g.from : "?";
    const to = String(g.to);
    const lines = ["## GOAL CHANGED", `the world levelled up during this run: ${from} → ${to}`];
    const lf = Number.isFinite(g.level_from) ? g.level_from : null;
    const lt = Number.isFinite(g.level_to) ? g.level_to : null;
    if (lf !== null || lt !== null) lines.push(`level ${lf ?? "?"} → ${lt ?? "?"}`);
    lines.push(`⇒ Everything the old goal needed is now suspect. The recipe above has been recomputed for ${to}.`);
    if (Array.isArray(obsolete) && obsolete.length) {
        for (const o of obsolete.slice(0, 2)) {
            /* 两种证据源：窗口量（`produced`，线还活着）与累计账本（`stored`，线已停）。
               后者在窗口归零之后仍然在 —— 而「线已经停了」恰恰是最常见的终局。 */
            if (Number.isFinite(o.stored) && !Number.isFinite(o.produced)) {
                lines.push(`  · the hub still holds ${o.stored} × ${o.shape}, which is not part of `
                    + `the recipe for ${to} — that came from the old goal`);
                continue;
            }
            const pct = Math.round((o.share || 0) * 100);
            lines.push(`  · ${o.shape} ×${o.produced} (${pct}% of output, ${o.delivered} delivered) `
                + `is a leftover line from the old goal`);
        }
        lines.push("⇒ Do NOT keep patching those lines. Remove them, or reroute them toward the new goal.");
    }
    return sanitize(lines.join("\n")).text;
}

/**
 * `## LEFTOVER LINES` —— 世界里还占着地方、但已经没用的旧产线。
 *
 * ## 为什么不并进 `GOAL CHANGED`（真机实测的漏报）
 *
 * 原来残线清单是 `renderGoalChanged(goalChanged, obsoleteLines)` 的**第二参数**。
 * 那个函数第一行就是 `if (!g || !g.to) return null;` —— 于是残线只有在
 * **本次 run 内部观察到换关**时才会被渲染。
 *
 * 2026-11-10 第 9 关实测：run 一开始就是第 9 关，`goalChanged` 是 null，
 * 整段从来没出现过。而那一刻 `hub.stored_shapes` 里躺着
 *
 *     Cu----Cu 27823   Cu------ 28926   ------Cu 229   RuRu---- 781
 *
 * 也就是前六关的全部产线还在原地占着地、继续挖继续切继续往 hub 塞废料。
 * 模型能看到的只有「没有产线在造 CpCpCpCp」，它于是去**新建** —— 在已经
 * 挤满旧线的世界里再挤一条。用户看到的就是那张图：一堆并排的、谁也用不上的长带子。
 *
 * 判据本身（`findStoredObsolete`）是对的，缺的是**渲染时机**。换关只是一个
 * 方便的时刻，不是残线存在的必要条件 —— 存档里本来就有旧线同样要拆。
 *
 * ## 为什么只列账本证据、不列窗口证据
 *
 * 窗口证据（"这条线还在产 X"）在 `GOAL CHANGED` 段里已经有了，而且它天然
 * 只出现在换关那一刻。这里要补的是**另一类**：线早就停了，但占地还在。
 * 两者同时渲染会在换关那一轮重复同一句话。
 *
 * @param {Array|null} obsolete `residual`（窗口 + 账本合并后的清单）
 * @param {string} goalShape
 * @returns {string|null} 无内容时 null
 */
function renderLeftoverLines(obsolete, goalShape) {
    if (!Array.isArray(obsolete) || !obsolete.length) return null;
    const stored = obsolete.filter(o => Number.isFinite(o.stored) && !Number.isFinite(o.produced));
    if (!stored.length) return null;
    const lines = [
        "## LEFTOVER LINES",
        `the hub still holds shapes that no step of the ${goalShape} recipe produces:`,
    ];
    for (const o of stored.slice(0, 3)) {
        lines.push(`  · ${o.shape} ×${o.stored}`);
    }
    lines.push(
        "Those lines are still on the map, still mining and still cutting, and everything they make"
        + " either clogs a belt or gets thrown away. They also occupy the space a new line needs.",
        "⇒ Prefer removing or converting them over building another parallel run."
        + " `remove_run` and `replace_run` work on them; a new `connect` next to them makes the clutter worse.",
    );
    return sanitize(lines.join("\n")).text;
}

const INSTRUCTION = [    "## YOUR TURN",
    "Output the calls for THIS round as one raw JSON object:",
    '{"say":"...","calls":[{"macro":"...","args":{...},"why":"..."}]}',
    `1 to ${PROMPT_RULES.CALLS_MAX} calls. Handles from this prompt only. No coordinates. JSON only.`,
].join("\n");

/**
 * 「上一轮因为多调用被整单拒掉」时的收窄版指令。
 *
 * ★ 为什么要单独一版 ★
 *
 * `NO_REVERSIBLE_CALL` 的 hint 在说「下一次只提交一个调用」，而固定的
 * `INSTRUCTION` 在说「1 到 6 calls」—— 两句话直接打架，模型当然听最后那句。
 *
 * 实测（r-20261118171858-d768）：连续三轮都提 `connect,connect`，每轮都被拒，
 * 每轮都收到「只做一个」的 hint，每轮都继续提两个。它不是在忽视 hint，
 * 是 prompt 里同时存在两条互相矛盾的指令，而显眼的那条是「1 到 6」。
 *
 * 收窄只在**真的发生过**这种情况时生效（由调用方判断），不改变常态行为。 */
const INSTRUCTION_ONE = [    "## YOUR TURN",
    "Output the calls for THIS round as one raw JSON object:",
    '{"say":"...","calls":[{"macro":"...","args":{...},"why":"..."}]}',
    "**Exactly 1 call this round.** Your previous plan was rejected because it had multiple calls and "
        + "one of them failed — the survivors could not be undone, so the whole plan was thrown away. "
        + "Do the single most-important call now; the next round can do the next one.",
    "Handles from this prompt only. No coordinates. JSON only.",
].join("\n");

/**
 * 实验用：「这一轮只能做一个动作」。
 *
 * 与 `INSTRUCTION_ONE` 的区别：那一版是为「上一轮因多调用被拒」写的，
 * 文案里提到 rejection；这一版是**主动施加的约束**，不提拒绝。
 *
 * 只由 `budget.forceOneCall === true` 触发，默认永不出现。
 *
 * ## 要检验的假设
 *
 * 真机 `r-20261121072433-521e`：`MACHINE_STARVED`（成因，排第 5）在诊断列表里，
 * 模型选了 `MINER_UNWIRED`（症状，排第 6）和 `HUB_INLET_THIN`（排第 1）——
 * 一轮抛 3 个局部小修，没有一个是「先修最下游那台机器，让上游自己解开」。
 *
 * 假设：**只能做一个动作时，模型被迫权衡「哪个最值得做」**，
 * 而不是靠「多抛几个总有一个能中」。
 *
 * ## 反面风险（要靠数据检验，不能靠推理排除）
 *
 * `INSTRUCTION` 上方的注释记着：有些修法确实需要两步（先 `remove_run`
 * 再 `replace_run`），硬限会逼模型写错。这是这个实验最可能的失败模式。
 */
const INSTRUCTION_SINGLE = ["## YOUR TURN",
    "Output the calls for THIS round as one raw JSON object:",
    '{"say":"...","calls":[{"macro":"...","args":{...},"why":"..."}]}',
    "**Exactly 1 call this round.** You cannot batch several small fixes together — "
        + "choose the ONE action that most advances the goal, and say in `why` why it beats the alternatives.",
    "Handles from this prompt only. No coordinates. JSON only.",
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
 * @param {object} p.obs            ObsSnapshot（只用 goal / hub；entities 仅用于 uid→实体兜底）。
 *   **不读 `obs.production`** —— 产线数据是独立参数 `p.production`（理由见 renderProduction）。
 * @param {object|null} [p.production] `reader.production()` 的返回（window_seconds /
 *   produced_total / produced_per_sec / delivered_* / …）。缺省 ⇒ PRODUCTION 段如实说 unavailable。
 * @param {object|Array} p.handles  句柄表（见 normalizeHandles 的三种形态）
 * @param {Array} [p.diagnoses]     Diagnosis[]
 * @param {Array} [p.candidates]    宏名 或 {macro, why}；**必须是 MACRO_NAMES 的子集**
 * @param {object} [p.lastRound]    上一轮摘要（见 renderLastRound）
 * @param {object} [p.lastNetEffect] 上一轮 tx 的净效果（见 renderLastStep）。
 *   缺省（首轮）⇒ `## LAST STEP` 整段不出现。
 * @param {object} [p.budget]       {rounds_left, llm_calls_left, tx_left, ticks_left, wall_ms_left,
 *                                   in_chars_max, prompt_tokens_max}
 * @param {object} [p.recipe]       已算好的结构化配方（`recipeForCached` 的返回）。
 *   给了就**直接复用**，不 spawn；没给才现算（走模块内 LRU）。
 * @returns {{system:string, user:string, tokens_estimate:number, blocks:object}}
 * @throws {PromptOverBudget} code=PROMPT_OVER_BUDGET（总字符 > in_chars_max）
 * @throws {TypeError} 缺 goal / obs / 未知候选宏
 */
export function buildPrompt({ goal, obs, handles, diagnoses, candidates, lastRound, lastNetEffect = null, priorAttempts = null, goalChanged = null, obsoleteLines = null, budget, production = null, itemsOnBelts = null, recipe: injectedRecipe = null, runLog = null, stickyGoal = null } = {}) {
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
    /* `includeWhen`：**真的宽裕**时才渲染卡片的 `when:` 行（见 renderCard 的注释）。
       显式给了 `budget.include_when` 就听它的（只用于 A/B）；否则按预算推断。
     *
     * ★ 阈值从「>= 4000」改成「>= 5000」★
     *
     * 4000 是旧的 `PROMPT_TOKENS_MAX`（2800）之上的「宽裕」线。2026-11-10 把默认值
     * 抬到 4000 之后，**默认就等于「宽裕」** —— 于是截断测试压低预算时
     * `when:` 行随之消失，`S2` 逐字节变了，而截断的契约是「只动带子列表」。
     *
     * 实测（prompt.test.mjs「截断后宏卡片逐字节相同」当场打红）：
     *   full:  tokensMax 4000 → when: 行**在**  → S2 带 when
     *   tight: 压低后      → when: 行**没了** → S2 不带 when
     *
     * 这不是测试过期，是真缺陷：截断路径改变了它承诺不碰的东西。
     * 把「宽裕」抬到 5000（明显高于默认 4000）之后，默认两端都在同一侧，
     * 而真正的宽裕预算（4600 生产值也低于 5000 —— 见下方说明）仍然走显式开关。
     *
     * 注意：生产路径 `loop.mjs` 传 `prompt_tokens_max: 4600`，低于 5000 ⇒
     * `when:` 行在生产上默认**不**出现。这与 A/B 的结论一致（when: 行对选择无影响，
     * 见 `when-line-no-effect`），少占预算反而是好事。 */
    const whenLinesOn = limits.includeWhen === null
        ? (limits.tokensMax >= 5000)
        : limits.includeWhen;
    const oreKinds = Array.isArray(obs && obs.resources)
        ? [...new Set((obs.resources || []).map(r => (Array.isArray(r) && r.length >= 3) ? r[2] : null).filter(k => typeof k === "string"))]
        : [];
    const s2 = renderCards(candidates, { includeWhen: whenLinesOn, goalShape, oreKinds });
    const s3Goal = renderGoal(goalShape, goal, obs);
    /* ★ 配方（S3 的一部分）：告诉模型这个形状该怎么造 ★
     *
     * 第四轮真 LLM 实验：5 次里 4 次坚持要 rotater，而 `RuRu----` 只需要 cutter 切一半。
     * 模型在**形状代数**上瞎猜，而正确配方仓库里早就算得出来（proto/solver.mjs）。
     * 这一段把 solver 的结论原样端上去 —— 不重算、不翻译错了。
     *
     * solver 不可用时**跳过**（返回 null），并在 blocks 里留 `recipe_unavailable` 原因，
     * 绝不因为一段附加信息让整个 prompt 崩掉。
     *
     * ★ P-b：配方由 loop 每 run 预计算一次后注入（`p.recipe`）★
     *   给了就直接用 —— 每轮 spawn 一次 solver 是 200–260ms 的白花，而且 loop 与 prompt
     *   各 spawn 一次时，solver 不可解的场景可能得到两份不同的「不可用」理由。
     *   没给才现算，且**走 `recipeForCached`**（模块内 LRU，同一目标只 spawn 一次）。
     *   失败也照样只影响这一段（`recipe_unavailable` 留痕），不抛。 */
    let r;
    if (injectedRecipe && typeof injectedRecipe === "object") {
        r = injectedRecipe;
    } else {
        const lvl = (goal && typeof goal === "object" && Number.isFinite(goal.level))
            ? goal.level
            : ((obs && obs.goal && Number.isFinite(obs.goal.level)) ? obs.goal.level : undefined);
        try {
            r = recipeForCached(goalShape, lvl === undefined ? {} : { level: lvl });
        } catch (e) {
            r = { ok: false, reason: `recipe error: ${e && e.message ? e.message : e}` };
        }
    }
    const s3Recipe = renderRecipe(r, { maxSteps: 8 });
    /* ★ 配方拿不到时，把「为什么」原样带出去 ★
     *
     * 旧版这里只写 `unavailable`，模型看不出是「真的做不出」还是「求解器算不动」。
     * 这两种情况的处置完全相反：
     *   · 真不可解   → 换目标 / 检查是不是漏了解锁的机器
     *   · 搜索被截断 → 形状可能仍然可做，自己推或者加预算重跑
     * 实测 L12 `CbCbCbRb:CwCwCwCw`：求解器 200 万状态仍 capped，
     * 但那个形状用普通 stacker 分两次叠就能出来。
     * 把「穷举不动」说成「不可解」会直接误导 agent 放弃。 */
    const recipeUnavailable = s3Recipe === null
        ? (r && typeof r.reason === "string" && r.reason ? r.reason : (r && r.ok === true ? "empty recipe" : "unavailable"))
        : null;
    const recipeCapped = !!(r && r.capped === true);
    const recipeHint = (r && r.capped === true && typeof r.hint === "string") ? r.hint : null;
    const recipeStats = (r && r.capped === true && r.stats) ? r.stats : null;
    const s3Hub = renderHub(tbl);
    /* ★ HUB 存量独立一段，**带子定完之后**才拼进去 ★
     *
     * 第一版把 `stored` 塞进 `## HUB` 里，它是 `compose` 的固定项 ——
     * 于是这 100+ 字符直接参与「先定带子」的截断循环，
     * 把 `belts_shown` 从 12 挤到 11（`prompt_capacity.test.mjs` D1 当场打红）。
     *
     * 而带子的优先级在本仓库是钉死的：它是模型**唯一能就地改造**的东西。
     * 所以这段走 CAPACITY 那条路 —— 带子和产能都定完之后，用剩余空间塞。
     * 塞不下就不出现（并留 `hub_stored_dropped` 痕迹），绝不抢带子的名额。 */
    let s3HubStored = null;
    let hubStoredDropped = null;
    let s3Machines = renderMachines(tbl, diagList, obs, goalShape);
    const s3Production = renderProduction(production, goalShape);
    const s3Budget = renderBudget(budget);
    const s4 = renderDiagnoses(diagList);
    const s5 = renderLastRound(lastRound);
    /* `## LAST STEP` 排在 LAST ROUND **之前**：先回答「你上一步让世界变好还是变坏」，
       再给「上一轮的细节」。顺序反过来模型会先读细节、后读结论，
       而那正是旧版只有 LAST ROUND 时的失败模式（它知道调了什么，不知道效果）。 */
    const sLastStep = renderLastStep(lastNetEffect);
    /* `## PRIOR ATTEMPTS` 排在 LAST STEP 之后、LAST ROUND 之前：
     * 先给「这一步/上一步」的即时反馈，再给「以前试过什么」的历史。
     * 反过来（历史在前）会让模型以为历史比眼前的世界更重要 —— 而世界是新的。 */
    const sPrior = renderPriorAttempts(priorAttempts);
    /* `## THIS RUN` 紧挨着 PRIOR ATTEMPTS：先看「我以前在别的 run 里试过什么」，
       再看「这次 run 我自己打算干什么」—— 前者是统计，后者是意图，后者更即时。
       放在 LAST ROUND 之后、PRIOR 之前。 */
    const sRunLog = renderRunLog(runLog);
    /* `## STICKY GOAL` 紧跟在诊断之后靠前的位置 —— 它说的是「这一轮该往哪走」。 */
    const sSticky = renderStickyGoal(stickyGoal);
    /* 换关通告排在 PRIOR ATTEMPTS **之前**：它改变的是整件事的前提，比历史更重要。 */
    const sGoalChanged = renderGoalChanged(goalChanged, obsoleteLines);
    /* 残线单独一段，**不再依赖 goalChanged**（见 renderLeftoverLines 的注释：
       把两者绑在一起，导致「本次 run 没换关」时残线整段不可见）。 */
    const sLeftover = renderLeftoverLines(obsoleteLines, goalShape);
    /* ★ 上一轮因「多调用 + 有失败」被整单拒 ⇒ 收窄成「只提 1 个」★
     *
     * 判据用 lastRound 里的失败/拒因，不看诊断 —— 因为这是**上一轮那套计划**的
     * 性质，不是这一轮世界的性质。
     *
     * ⚠️ codes 有两个位置：顶层 `codes` 与 `verify.codes`。`settleFailure` 在
     * plan 阶段被拒时把码写在 `verify.codes` 里（见 loop.mjs:2884 的
     * `verify: { checks: [], codes: [...] }`），顶层没有。
     * 第一版只读顶层，于是收窄**从来没触发过** —— 实测三个 run 都是
     * `rejected.code === "NO_REVERSIBLE_CALL"`，而 prompt 里仍然是「1 to 6 calls」。
     * 两处都读。 */
    const lastCodes = [
        ...(Array.isArray(lastRound && lastRound.codes) ? lastRound.codes : []),
        ...(lastRound && lastRound.verify && Array.isArray(lastRound.verify.codes) ? lastRound.verify.codes : []),
    ];
    const lastFailedMulti = lastCodes.includes("NO_REVERSIBLE_CALL")
        || lastCodes.includes("PARTIAL_APPLY");
    /* ★ 实验开关：无条件强制「一轮一个」（2026-11-21）★
     *
     * `budget.forceOneCall === true` 时无视 `lastFailedMulti`，直接用收窄版指令。
     * 默认 false，不改变任何既有行为。
     *
     * **为什么值得测**：真机 `r-20261121072433-521e` 上，`MACHINE_STARVED`
     * （成因，排第 5）就在诊断列表里，模型却选了 `MINER_UNWIRED`（症状，排第 6）
     * 和 `HUB_INLET_THIN`（排第 1）—— 一轮抛 3 个局部小修。
     *
     * 假设：**一次只能做一个动作时，模型被迫权衡「哪个最值得做」**，
     * 而不是靠「多抛几个总有一个能中」。
     *
     * 现有 `INSTRUCTION_ONE` 的文字是为「上一轮被拒」写的（提到 rejection），
     * 直接复用会给出错误的上下文。所以实验模式用独立文案。 */
    const forceOne = limits.forceOneCall === true;
    const s6 = forceOne ? INSTRUCTION_SINGLE
        : (lastFailedMulti ? INSTRUCTION_ONE : INSTRUCTION);

    const selection = pickBelts(tbl, diagList, goalShape, obs);
    /* 配方紧跟在 GOAL 之后：它是「这个目标怎么造」的一部分，不是独立信息 */
    let goalAndRecipe = s3Recipe ? [s3Goal, s3Recipe].join("\n\n") : s3Goal;

    /* ★ 配方拿不到时必须在正文里说清楚「为什么」★
     *
     * 只在 blocks 里留一个 `recipe_unavailable` 字段等于没告诉模型 —— 那是给测试看的。
     * 模型看不到配方会默认「这关做不出来」，而实际往往是求解器穷举不动。
     * 实测 L12：200 万状态仍 capped，但形状本身用普通 stacker 分两次叠就能做。
     * 这里把「搜索被截断」和「真的不可解」分开写进正文，让模型的下一步动作不同。 */
    if (recipeUnavailable) {
        /* 形状编码的解码表 —— 模型自己推配方时的**基础词汇**。
         *
         * 形状串每两格一个块：`Cb` = 下层 cyan + 上层 blue。
         * 大写字母是第二层颜色、小写是第一层（game/colors.js 的 enumColorToShortcode）。
         *
         * L12 实测：agent 在 say 里写「Cb ore」，把**颜色组合**当成了矿种名。
         * 它没有解码表，只能猜 —— 而颜色配方（cyan = blue+green，white = blue+green+red）
         * 决定了这一关到底需要哪几种颜料矿、要不要 mixer 级联。
         * 这些是规则不是答案，给出来不会替它做决策，只会让它少猜两轮。 */
        const colorRules = [
            "## SHAPE CODE CHEAT SHEET (read the goal shape yourself)",
            "A shape string is pairs of characters. In each pair the UPPERCASE letter is the",
            "*SHAPE* and the lowercase letter is the *COLOUR* — they are two different alphabets,",
            "not a case distinction on one.",
            "  shape codes : R=rect  C=circle  S=star  W=windmill",
            "  color codes : r=red g=green b=blue y=yellow p=purple c=cyan w=white",
            "  a dash (-) = empty.",
            "So `CbCbCbRb` means: four cells — three of them circle+blue (`Cb`) and one",
            "rect+blue (`Rb`). It is NOT 'cyan lower layer'. `CwCwCwCw` is four circle+white.",
            "A goal with a colon (`A:B`) is TWO stacked layers — `A` is the lower shape,",
            "`B` is the upper shape; it needs a stacker pass at the end.",
            "",
            "Pigment mixing (a mixer takes two pigments and outputs their union):",
            "  yellow = red+green   purple = red+blue   cyan = blue+green",
            "  white  = blue+green+red  ⇒ white needs a CASCADE: mix two, then mix the result",
            "  with the third. One mixer is not enough.",
            "Painted cells are produced by a painter: it takes a shape and one pigment.",
            "",
            "## BUILD ORDER FOR A COMPOUND SHAPE",
            "A goal that needs several pigments and a final stack cannot be done in one call.",
            "Do it in this order, and spend a whole round on each step — do NOT try to",
            "finish the shape this round:",
            "  1. raw supply — a miner on each ore you need, belt each to where you will work.",
            "     If an ore is far away, build the line toward it; that alone is a good round.",
            "  2. pigment cascade — mixers bottom-up (e.g. blue+green first, then +red for white).",
            "     Wire a mixer only once BOTH its inputs have a source; otherwise it just stalls.",
            "  3. half-shapes — cutter splits a shape into two halves; keep the half the goal wants",
            "     and send the other to a trash. A cutter with an unconnected output will stall.",
            "  4. painting — painter takes one shape + one pigment. One painter = one pigment.",
            "  5. stacking — stacker combines a lower and an upper input into one two-layer cell.",
            "     A `A:B` goal needs this as the LAST step before the hub.",
            "Each of those is a legitimate round's work. Progress is cumulative: a round that",
            "only lays 40 belts toward a far ore is a GOOD round, not a wasted one.",
            "",
            "## THERE IS NO \"BUILD THE WHOLE LINE\" MACRO FOR THIS GOAL",
            "`build_line` refuses multi-layer targets outright (`out-of-scope:multilayer`)",
            "and refuses any world that already has buildings. Do not look for a shortcut.",
            "The line gets built one piece at a time: insert_machine to place each machine,",
            "connect to wire each hop, replace_run to fix a direction. That is the intended",
            "path, not a workaround — expect it to take many rounds.",
            "",
            "⇒ Use this to work out which raw ores and which machines the goal needs,",
            "even when the recipe solver could not finish.",
        ].join("\n");

        const why = recipeCapped
            ? [
                "## RECIPE UNAVAILABLE — search capped, NOT proven impossible",
                `the shape solver hit its state limit${recipeStats
                    ? ` (expanded ${recipeStats.expanded}, generated ${recipeStats.generated}, `
                      + `stack pairs ${recipeStats.stackPairs})`
                    : ""} before finding a plan.`,
                "This does NOT mean the shape cannot be built — it means the exhaustive search",
                "ran out of budget. Many shapes that defeat the solver are trivial for a human",
                "layout: e.g. a 4-wide target is often two ordinary stacker passes, each combining",
                "two 2-wide halves you can cut and paint with the machines you already have.",
                recipeHint ? `Suggestion: ${recipeHint}` : null,
                "⇒ Work it out yourself from the machines in MACHINES, or fall back to whatever",
                "partial progress the diagnoses point at. Do NOT report the goal as impossible.",
                "",
                colorRules,
            ].filter(Boolean).join("\n")
            : [
                "## RECIPE UNAVAILABLE",
                `reason: ${recipeUnavailable}`,
                "",
                colorRules,
            ].join("\n");
        goalAndRecipe = [s3Goal, why].join("\n\n");
    }

    /* ★ CAPACITY（产能瓶颈）★
     *
     * 位置：紧跟在 MACHINES 之后、BELTS 之前。理由 ——
     *   · 它讲的是「这些机器够不够」，MACHINES 正好是它的论据；
     *   · BELTS 是**唯一**可截断段，放在它后面意味着「预算紧时先砍带子，不砍产能诊断」。
     *
     * 数据来自 `capacityFor(obs)`（assess.mjs），**本文件不重算任何速率**。
     * 这里只负责「有没有地方放」：先算出其余各段的实际长度，把剩余字符交给
     * `renderCapacity` 的 `room`，让它自己决定给 full 还是 2 行版。
     * 不可信 / 无可说时 `capacityFor` 或 `renderCapacity` 返回 null，整段消失。 */
    let s3Capacity = null;
    let capacityUnavailable = null;
    let capacityNote = null;
    let capacityInfo = null;
    /* 「宏选择优先级」提示是否真的进了 prompt —— 记在 blocks 里，
       这样测试和调试能区分「余量不够没加」和「加了但没用」。 */
    let macroPrefShown = false;
    try {
        capacityInfo = capacityFor(obs);
        const { capacity } = capacityInfo;
        if (capacity && capacity.confidence && capacity.confidence !== "ok") {
            capacityUnavailable = `confidence=${capacity.confidence}`;
            capacityInfo = null;                       // 数据不可信：下面一律按「没有 capacities」处理
        }
    } catch (e) {
        /* 产能分析是**附加信息**：它算炸了不许让整轮 prompt 崩掉（与 recipe 段同一条纪律），
           但必须留痕 —— 静默跳过等于让这个功能悄悄消失。 */
        capacityInfo = null;
        capacityUnavailable = `capacity error: ${e && e.message ? e.message : e}`;
    }

    /* `sLastStep` 无内容（首轮）时由 filter 天然去掉，不占任何字符。 */
    const fixed = [s2, sGoalChanged, sLeftover, goalAndRecipe, s3Hub, s3Machines, s3Production, s3Budget, s4, sLastStep, sSticky, sRunLog, sPrior, s5, s6]
        .filter(x => x !== null && x !== undefined).join("\n\n");

    /* ── 截断：只动带子列表。目标 = min(token 预算, 字符硬上限) ── */
    const targetChars = Math.min(Math.floor(limits.tokensMax * PROMPT_RULES.CHARS_PER_TOKEN), limits.inCharsMax);

    /* ★ 机器表与带子表**都**是「预算紧时可以让位」的，但带子优先 ★
     *
     * 两者性质不同：
     *   · 带子是模型**唯一能就地改造**的东西 —— 它要知道每条的出口朝向、能不能到 hub
     *   · 机器表只是上下文（"世界上有哪些机器"），少列几台不影响判断
     *
     * 2026-11-10 第 9 关实测：536 条带子、8 条诊断、20 台机器的世界里
     * S1(4716)+S2(2262)+S3(3238)+S4(1973) = 12189 > 12000 ⇒ **带子永远是 0 条**，
     * 连诊断点名的 10 条都是 `0 of 10 referenced shown`。而那一轮模型要做的
     * 正是「把 B205/B206 的朝向往回改」—— 它看不到那两条带子的任何属性。
     *
     * 所以 `compose` 收两个可变量（机器表、带子表），下面按**档位**退让：
     * 机器表 20 → 12 → 6 → 0，每档都重跑截断循环，取第一个能让带子 > 0 的档。
     * 「带子优先」因此是**结构性成立**的，不是调出来的。 */
    const composeWith = (machines, belts, capacity) => [s2, sGoalChanged, sLeftover, goalAndRecipe, s3Hub, machines, capacity, belts,
        s3Production, s3Budget, s4, sLastStep, sSticky, sRunLog, sPrior, s5, s6].filter(x => x !== null && x !== undefined).join("\n\n");
    const compose = (belts, capacity) => composeWith(s3Machines, belts, capacity);

    /* ★ 顺序：**先定带子，再花余量** ★
     *
     * 一版错误做法是「先把带子按新预算截一遍，再塞 CAPACITY」—— 那样 CAPACITY
     * 会去抢带子的名额，`belts_shown` 比加这一段之前更差。而带子是**可改造对象**，
     * 少了它模型连该改哪条都看不见；产能数字再多也补不回来。
     *
     * 现在的顺序：
     *   ① 用**不含 CAPACITY** 的 prompt 跑原来的截断循环 ⇒ `shown` 与加这段之前**逐字节相同**；
     *   ② 量出还剩多少字符（`room`），把这个额度交给 `renderCapacity`；
     *   ③ 如果 full 版塞不下，试 2 行短版；还塞不下就不出现（并记 `capacity_unavailable`）。
     *
     * 这样「预算 D：belts_shown 不许变差」是**结构性成立**的，不是靠调参凑出来的。 */
    let shown = selection.ordered.length;
    let s3Belts = renderBelts(tbl, selection, shown, false);
    let user = compose(s3Belts, null);
    let trimmed = 0;
    while (s1.length + user.length > targetChars && shown > 0) {
        shown -= 1;
        trimmed += 1;
        s3Belts = renderBelts(tbl, selection, shown, true);
        /* ★ 这里曾经写成 `s3Goal` —— 一旦触发截断，**配方就永久丢失** ★
         *
         * 红队实测：字面的 13 条诊断下，截断会把 RECIPE 段整个换掉，
         * 模型再也看不到"这个形状该怎么造"，而那正是第五轮实验唯一起作用的信号。
         *
         * 截断的契约是「只动带子列表」，配方不属于可截断的东西 —— 必须用 goalAndRecipe。 */
        user = compose(s3Belts, null);
    }

    /* ★ 仍然超预算 ⇒ 逐档压缩机器表（2026-11-15 夜，L12 真机）★
     *
     * 原来只在 `shown === 0`（带子被砍光）时才压缩机器表。那段逻辑的教训
     * 是对的（「带子是唯一能就地改造的东西，机器表只是上下文」），
     * 但触发条件太窄：
     *
     * 实测 L12：世界膨胀到 559 实体 / 55 台机器 / 499 条带子，带子列表
     * 还有 16 格可显示，可总量仍然 17919 > 16000 —— 于是
     * `PROMPT_OVER_BUDGET` 直接抛，整个 run 硬失败（`outcome:INTERNAL`），
     * 而这一轮开头的清理动作是有效的（死带子 312→309）。
     *
     * 也就是说：**世界一膨胀，agent 就彻底停摆**。这比「少显示几台机器」糟得多。
     *
     * 所以改成：只要超预算就依次压缩机器表（12 → 6 → 整段去掉），
     * 每档都重跑截断循环保住带子。带子优先的结构不变 ——
     * 只有在「压缩机器表能换来更多带子」时才值得降，所以仍以 `sh >= shown` 为准。
     *
     * 注意 `shown > 0` 也允许进这一档：真正决定要不要降的是「压了机器表之后
     * 还能不能装下」，由下面的循环自己判断。 */
    if (s1.length + user.length > targetChars) {
        const MACHINE_STEPS = [12, 6, 0];
        for (const cap of MACHINE_STEPS) {
            const alt = cap === 0 ? null : renderMachines(tbl, diagList, obs, goalShape, { max: cap });
            let sh = selection.ordered.length;
            let bl = renderBelts(tbl, selection, sh, false);
            let u = composeWith(alt, bl, null);
            let tr = 0;
            while (s1.length + u.length > targetChars && sh > 0) {
                sh -= 1; tr += 1;
                bl = renderBelts(tbl, selection, sh, true);
                u = composeWith(alt, bl, null);
            }
            if (s1.length + u.length <= targetChars) {
                shown = sh; trimmed = tr; s3Belts = bl; s3Machines = alt; user = u;
                break;                                   // 装下了就停
            }
            /* 装不下也记下这一档：至少让机器表小一点，比硬抛错强 */
            if (!alt || alt.length < (s3Machines ? s3Machines.length : Infinity)) {
                shown = sh; trimmed = tr; s3Belts = bl; s3Machines = alt; user = u;
            }
        }
    }

    /* ★ 带子被砍到 0 ⇒ 先砍**机器表**，再重试 ★
     *
     * 2026-11-10 第 9 关实测：536 条带子、8 条诊断、37 台机器时，
     * S1(4716) + S2(2262) + S3(3238) + S4(1973) = 12189 > 12000 ——
     * **带子列表永远是 0 条**，包括诊断点名的 10 条（`0 of 10 referenced shown`）。
     *
     * 而模型这一轮要做的正是「把 B205/B206 的朝向往回改」。它看不到那两条带子的
     * 任何属性（出口朝哪、能不能到 hub），只能照诊断里那句「belt-not-aimed」猜。
     *
     * 砍的顺序有依据：带子是**唯一能就地改造**的东西，机器表只是上下文。
     * 一个 `MACHINES (12 of 37)` 仍然告诉模型「世界上有哪些机器」，
     * 而 `BELTS (0 of 536)` 什么也没告诉它。
     *
     * 逐档退让：先减到 12 台，再减到 6 台，再整段去掉。每档都重跑同一套截断循环，
     * 所以「带子优先」是**结构性成立**的，不是靠调参凑出来的。 */
    if (shown === 0 && selection.ordered.length > 0) {
        const MACHINE_STEPS = [12, 6, 0];
        for (const cap of MACHINE_STEPS) {
            const alt = cap === 0 ? null : renderMachines(tbl, diagList, obs, goalShape, { max: cap });
            let sh = selection.ordered.length;
            let bl = renderBelts(tbl, selection, sh, false);
            let u = composeWith(alt, bl, null);
            let tr = 0;
            while (s1.length + u.length > targetChars && sh > 0) {
                sh -= 1; tr += 1;
                bl = renderBelts(tbl, selection, sh, true);
                u = composeWith(alt, bl, null);
            }
            if (sh > shown) {
                shown = sh; trimmed = tr; s3Belts = bl; s3Machines = alt; user = u;
                if (sh >= Math.min(selection.ordered.length, 4)) break;   // 够了就别再砍机器
            }
        }
    }

    /* ── 余量全部给 CAPACITY（不给带子动刀子） ── */
    let capacityDowngraded = false;
    let resourceDroppedForCapacity = false;
    let oreHintDroppedForCapacity = false;
    let resourceCompactForCapacity = false;
    if (capacityInfo) {
        /* ★ CAPACITY 优先于「目标矿在哪」那行 ★
         *
         * 实测（L4 冷启动夹具，8 台矿机 + 12 条带子名额用满）：
         *   不带资源行时 room = 120，CAPACITY 刚好塞得进；
         *   带上资源行后 room = 112 < 120，CAPACITY **整段消失**。
         *
         * 差 8 个字符就丢掉一段 p≈5e-7 的信息源，这是错的优先级。
         * 所以：先按现状算 room；不够就**把资源行撤掉再算一次**。
         *
         * 为什么不是相反（让 CAPACITY 让位）：CAPACITY 是实测有效的信号，
         * 资源行是这一轮新加的、还没验证过效果。预算紧时保旧的、撤新的 ——
         * 「加一段新信息永远不许让已有信息变少」这条纪律在这里同样适用。 */
        let room = targetChars - (s1.length + user.length) - 2;
        if (room < 120) {
            /* 退一步，按价值从低到高撤。
             *
             * ## 2026-11-04 调整：`$ore` 提示**不再**是最先撤的
             *
             * 原顺序是「先撤 `$ore` 提示（教学），再撤资源行（事实）」。
             * 那个判断被实验数据推翻了（`.tmpverify/ab-real/`，150 个真实样本）：
             *
             *   · 149/150 的 thinking 里提到删除；
             *   · **95/150（63%）明确说「不知道怎么指定位置」**
             *     （原文如 `But we can't compute positions`、`we don't know where ore is`）；
             *   · `$ore` 在这些 trace 里出现 **0 次** —— 因为那批 prompt 用的是
             *     ~12000 字符预算，这条提示被下面这段逻辑挤掉了。
             *
             * 也就是说：「教学」在**模型根本不知道有这个算子**时不是可牺牲项，
             * 它是唯一的行动路径。资源行说「矿在图上」，提示说「怎么指它」——
             * 缺了后者，前者只是一句废话。
             *
             * 新顺序：
             *   ① 先撤**资源行的距离/数量细节**（保留「有没有」这个事实）；
             *   ② 还不够才撤整条资源行（连带提示一起没了，但那时真的没预算了）。
             *
             * 实测这条改动让「有矿但不知道怎么指」的场景不再退化成死局。 */
            if (room < 120) {
                /* ① 先试**只撤距离/数量细节**，保住「有矿 + 怎么指」这两句核心。
                 *
                 * `compact` 模式只留主矿种与「IS on the map」这个事实，
                 * 去掉「×N」「a short run from hub」这些描述性部分。
                 * 那两句是模型真正要用的：知道有矿、知道怎么指它。 */
                const compactRes = renderMachines(tbl, diagList, obs, goalShape, { resourceCompact: true });
                /* `s3Machines` 可能是 `null` —— 上面「带子优先」那段在 `MACHINE_STEPS`
                   退到 0 时会把它整个撤掉（`cap === 0 ? null : …`）。那个分支以前几乎
                   走不到（世界里的诊断很少多到需要把 MACHINES 段清空），
                   所以 `.length` 的裸取一直没炸。加了 `DEAD_LINES`/`ORPHAN_MACHINES`
                   之后诊断变多，这条路径被真的走到了，`TypeError: Cannot read
                   properties of null (reading 'length')` 直接把整个 prompt 构建打挂。
                   撤掉的状态本身就是「没有这段」，再撤一次是无操作 —— 按空串比。 */
                if (compactRes !== s3Machines) {
                    const savedC = (s3Machines || "").length - compactRes.length;
                    if (savedC > 0 && room + savedC >= 120) {
                        s3Machines = compactRes;
                        user = compose(s3Belts, null);
                        room = targetChars - (s1.length + user.length) - 2;
                        resourceCompactForCapacity = true;
                    }
                }
            }
            if (room < 120) {
                const withoutRes = renderMachines(tbl, diagList, obs, goalShape, { includeResource: false });
                if (withoutRes !== s3Machines) {
                    const saved = (s3Machines || "").length - withoutRes.length;
                    if (room + saved >= 120) {
                        s3Machines = withoutRes;
                        user = compose(s3Belts, null);
                        room = targetChars - (s1.length + user.length) - 2;
                        resourceDroppedForCapacity = true;
                    }
                }
            }
            /* 到这里已经连资源行都撤了（提示自然也没了）。只有一种情况还需要撤提示：
               资源行撤完仍然不够 —— 那说明预算真的紧到极限，只能连「矿在哪」一起放弃。 */
            if (room < 120) {
                const noHint = renderMachines(tbl, diagList, obs, goalShape, { includeOreHint: false });
                if (noHint !== s3Machines) {
                    const savedHint = (s3Machines || "").length - noHint.length;
                    if (room + savedHint >= 120) {
                        s3Machines = noHint;
                        user = compose(s3Belts, null);
                        room = targetChars - (s1.length + user.length) - 2;
                        oreHintDroppedForCapacity = true;
                    }
                }
            }
        }
        try {
            if (room >= 120) {
                /* 先试 full，塞不下再退 short，还塞不下就不出现 —— 每一级都**显式**挑。 */
                for (const form of ["full", "short"]) {
                    const text = renderCapacity(capacityInfo.capacity, capacityInfo.options, { room, form, production, itemsOnBelts });
                    if (text) {
                        s3Capacity = text;
                        capacityDowngraded = form === "short";
                        capacityNote = capacityInfo.capacity.bottleneck;
                        break;
                    }
                }
                if (s3Capacity) user = compose(s3Belts, s3Capacity);
                else { capacityUnavailable = "dropped-for-budget"; capacityNote = null; }
            } else {
                capacityUnavailable = "dropped-for-budget";
            }
            if (!s3Capacity && !capacityUnavailable) capacityUnavailable = "nothing-to-say";
        } catch (e) {
            s3Capacity = null;
            capacityUnavailable = `capacity error: ${e && e.message ? e.message : e}`;
            user = compose(s3Belts, null);
        }
    }

    /* ── HUB 存量：带子与 CAPACITY 都定完之后，用剩下的空间塞 ──
     *
     * 优先级排在 CAPACITY **之后**：CAPACITY 是实测 p≈5e-7 的信息源，
     * 而 hub 存量是「这几条线在造什么」的背景事实 —— 它极大（能一次性
     * 排除整条 L11 遗留产线），但不是每轮都改变决策。
     *
     * 所以：塞得下就出现，塞不下就整段消失并留 `hub_stored_dropped` 痕迹。
     * **绝不让它抢带子或 CAPACITY 的名额** —— 这条是本轮踩出来的：
     * 第一版把它写进 `## HUB`（`compose` 的固定项），`belts_shown` 12 → 11。 */
    {
        /* 两档尝试：full 塞不下就退 short（只给最能改变判断的那一条），
           还塞不下才整段消失并留痕迹。与 CAPACITY 的降级纪律一致。 */
        let placed = false;
        for (const form of ["full", "short"]) {
            const text = renderHubStored(obs, goalShape, { form });
            if (!text) { hubStoredDropped = "nothing-to-say"; break; }
            if (s1.length + user.length + 2 + text.length <= targetChars) {
                user = user + "\n\n" + text;
                s3HubStored = text;
                placed = true;
                break;
            }
        }
        if (!placed && !hubStoredDropped) hubStoredDropped = "dropped-for-budget";
    }

    /* ── 余量富余时补一条「宏选择优先级」提示 ──
     *
     * ## 为什么**不能**直接写进 S1
     *
     * 实测（本次会话）：S1 里加 1 行（152 字符）会让 L4 冷启动夹具
     * （`prompt_capacity.test.mjs` 的 A6）从 `cap YES / 余量 115` 变成 `cap NO`。
     * 那个夹具已经贴着 9800 的上限，S1 每多一个字符都是从带子/CAPACITY 名额里抢。
     *
     * 而这条提示的**价值低于 CAPACITY**（CAPACITY 是实测 p≈5e-7 的信息源，
     * 见 `AB-PROMPT-RESULT.md`；这条只是选择顺序的建议）。所以它必须排在 CAPACITY 之后。
     *
     * ## 依据
     *
     * `THREE-FIXES-NET-EFFECT.md`（90 条真实存档样本、三轮修复后）：
     * `connect:occupied` 从 6 涨到 11，是唯一的主要失败源（33%）。
     * 接口类错误已被 3 个修复清零（bad_type 4→0、endpoint_not_a_port 5→0），
     * 剩下的 `occupied` 是**寻路撞机器**（`connect.mjs:966`：「要绕开需要阶段 3 的布线」），
     * 而 `replace_run` / `insert_machine` / `extend_line` 只需一格或一个方向，不涉及寻路。
     *
     * ## 顺序纪律
     *
     * 优先级：**CAPACITY > 这条 > 多显示一条带子**。
     * 所以只在 `s3Capacity` 已经拿到、且加完仍不超上限时才加 —— 它绝不抢 CAPACITY 的名额。
     */
    /* ★ 2026-11-04：这段从「偏好指令」缩成一句，把预算让给卡片的 `when:` 行 ★
     *
     * 原文三句：①② 是**定向偏向**（"Prefer replace_run / insert_machine / extend_line
     * over connect"、"connect ... often fails occupied"），③ 是有效的调用形状提醒。
     *
     * ①② 有两个问题：
     *   · 它们是偏好，不是信息。选哪个宏该由场景决定。
     *     实测（`.tmpverify/ore-ab/`，16 样本）：`replace_run` 10 次 / `connect` 6 次 /
     *     `remove_run` 4 次 —— 分布被这类句子压得很偏。
     *   · ② 已经被本轮的自动放宽推翻（撞到既有带子时 connect 不再硬失败，
     *     它会升级 allow_replace 并把切断后果报回来）。
     *
     * ③ 保留：它讲的是**调用形状**（整单全有或全无），对所有宏一视同仁。
     * 而「哪个宏能干什么」已经写在每张卡的 `when:` 行里 —— 那里说比这里说更准，
     * 也不会重复。净效果：这段从 270 字符缩到约 200，让出的空间给了五张卡的 `when:`。 */
    const MACRO_PREF_HINT = "## CALL SHAPE\n"
        + "The whole plan is rejected if ANY call fails — so N calls = N chances to fail.\n"
        + "Prefer one call that solves the top blocker over several speculative ones.";
    if (s3Capacity && s1.length + user.length + MACRO_PREF_HINT.length + 2 <= limits.inCharsMax) {
        user = user + "\n\n" + MACRO_PREF_HINT;
        macroPrefShown = true;
    }

    /* ── 硬上限：不静默截断任何东西，直接抛 ── */
    let chars = s1.length + user.length;
    /* ★ 最后一道保险：只超一点点时，把带子列表再压几条（2026-11-15 夜，L12 真机）★
     *
     * 降级链的目标是 `targetChars`（默认 11500 = tokensMax×2.5），
     * 而硬上限是 `inCharsMax`（16000）。中间 4500 字符的差额本来是留给
     * S4/S5 这些后面才拼进去的段的 —— 世界一膨胀，那点差额被吃光，
     * 于是降级链「达标」了、硬上限却仍然超。
     *
     * 实测：16114 vs 16000，差 **114 字符**。为一个零头让整个 run
     * `outcome:INTERNAL`（这一轮开头的清理是有效的：死带子 322→316），
     * 代价明显不成比例。
     *
     * 所以：超硬上限时继续砍带子（带子优先原则不变 —— 它本来就是
     * 唯一可截断的东西），砍到 0 还不够才抛。 */
    while (chars > limits.inCharsMax && shown > 0) {
        shown -= 1;
        trimmed += 1;
        s3Belts = renderBelts(tbl, selection, shown, true);
        user = compose(s3Belts, s3Capacity || null);
        chars = s1.length + user.length;
    }
    /* ★ 带子砍光了还超 ⇒ 再压机器表（2026-11-15 夜，L12 真机）★
     *
     * 真机实测：世界膨胀到 524 实体 / 59 台机器 / 485 条带子时，
     * 即使带子列表砍到 0，总量仍然 16128 > 16000 —— 因为**机器表**本身
     * 就占了 2000+ 字符（55 台机器逐行渲染）。
     *
     * 上面那轮「压缩机器表」的降级链用的是 `targetChars`(11500) 作判据，
     * 而硬上限是 16000 —— 中间 4500 的差额被后面才拼进去的 S4/S5 吃掉，
     * 于是降级链认为「达标了」，硬上限却仍然超。
     *
     * 这里补最后一道：仍然超就继续压机器表，直到装下或压到没有为止。
     *
     * ⚠️ 条件里**不能**写 `&& s3Machines`：上面那轮降级链可能已经把机器表
     * 压成 `null`（整段去掉）了，而这时仍然超 —— 那种情况下这个兜底会被
     * 整个跳过，于是 `PROMPT_OVER_BUDGET` 照抛（真机 16494 就是这么来的）。
     * 压成 null 之后没得再压，但至少要**试过**才能确定该抛。 */
    if (chars > limits.inCharsMax) {
        for (const cap of [6, 3, 0]) {
            const alt = cap === 0 ? null : renderMachines(tbl, diagList, obs, goalShape, { max: cap });
            const u2 = composeWith(alt, s3Belts, s3Capacity || null);
            s3Machines = alt; user = u2; chars = s1.length + u2.length;
            if (chars <= limits.inCharsMax) break;
        }
    }
    if (chars > limits.inCharsMax) {
        throw new PromptOverBudget(
            `prompt is ${chars} chars > LLM_IN_CHARS_MAX ${limits.inCharsMax}; `
            + "only the S3 belt list may be trimmed, so this is a hard failure (goal/diagnosis must not be truncated)",
            {
                chars, limit: limits.inCharsMax,
                sections: { s1: s1.length, s2: s2.length, s3_goal: s3Goal.length, s3_hub: s3Hub.length,
                    s3_machines: (s3Machines || "").length, s3_belts: s3Belts.length, s3_production: s3Production.length,
                    s3_recipe: (s3Recipe || "").length, s3_capacity: (s3Capacity || "").length,
                    s3_budget: s3Budget.length, s4: s4.length, s5: s5.length, s6: s6.length },
                diagnoses: diagList.length,
                belts: selection.total,
            },
        );
    }

    const s3 = [goalAndRecipe, s3Hub, s3Machines, s3Capacity, s3Belts, s3Production, s3Budget]
        .filter(x => x !== null && x !== undefined).join("\n\n");
    const blocks = {
        S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6,
        s3_goal: s3Goal, s3_hub: s3Hub, s3_machines: s3Machines, s3_belts: s3Belts,
        /* hub 存量行：`null` = 这段没出现；**为什么没出现**记在 `hub_stored_dropped`
           （「没数据」/「没有值得说的形状」/「预算不够被丢掉」是三种不同情况，
           合并成一个 null 会让排查时分不清「功能没触发」和「功能坏了」）。 */
        s3_hub_stored: s3HubStored,
        hub_stored_dropped: hubStoredDropped,
        s3_production: s3Production, s3_budget: s3Budget,
        /* 配方段（可能为 null —— solver 不可用）。单独暴露，便于测试与排查 */
        s3_recipe: s3Recipe,
        recipe_unavailable: recipeUnavailable,
        /* 求解器是「搜索被截断」还是「真的不可解」—— 两者对模型的意义完全不同，
           混成一个字段会让事后排查（和测试）分不清「这关做不出来」与「求解器算不动」。 */
        recipe_capped: recipeCapped,
        recipe_stats: recipeStats,
        /* CAPACITY：`null` 表示「这段没出现」。**为什么没出现**记在 `capacity_unavailable` ——
         * 「数据不可信」/「没什么可说」/「预算不够被丢掉」是三种完全不同的情况，
         * 混成一个 null 会让事后排查（和测试）分不清「功能没触发」和「功能坏了」。 */
        s3_capacity: s3Capacity,
        resource_dropped_for_capacity: resourceDroppedForCapacity,
        ore_hint_dropped_for_capacity: oreHintDroppedForCapacity,
        resource_compact_for_capacity: resourceCompactForCapacity,
        capacity_unavailable: capacityUnavailable,
        capacity_bottleneck: capacityNote,
        capacity_downgraded: capacityDowngraded,
        /* 「宏选择优先级」提示有没有进去（余量不够时它会被跳过，
           优先级低于 CAPACITY —— 理由见加它的那段注释）。 */
        macro_pref_shown: macroPrefShown,
        chars,
        tokens_estimate: Math.round(chars / PROMPT_RULES.CHARS_PER_TOKEN),
        trimmed_belts: trimmed,
        belts_shown: shown,
        belts_total: selection.total,
        /* `belts_referenced` = 诊断点名了几条带子（**候选池**口径，不随截断变化）。
         * `belts_referenced_shown` = 这些条里**真被渲染出来**的几条 —— 表头写的就是它。
         * 两者分开是因为老 bug 正是把前者的数字贴到了后者的位置（表头撒谎）。 */
        belts_referenced: selection.referenced.length,
        belts_referenced_shown: selection.referenced.filter(h => selection.ordered.slice(0, shown).includes(h)).length,
        belts_diag_reserve: selection.reserve,
        belts_padded: selection.padded.length,
        over_token_budget: chars > Math.floor(limits.tokensMax * PROMPT_RULES.CHARS_PER_TOKEN),
        redactions: countMarks([s2, sGoalChanged, s3, s4, sLastStep, sSticky, sRunLog, sPrior, s5, s6].join("\n"), "coord"),
        redacted_uids: countMarks([s2, s3, s4, sLastStep, sSticky, sRunLog, sPrior, s5, s6].join("\n"), "uid"),
        /* 净效果段是否真的进了 prompt —— 与 `capacityUnavailable` 同理：
           让测试与调试能区分「首轮本来就没有」和「加了但被砍掉」。 */
        last_step_shown: sLastStep !== null,
        /* 跨 run 记忆段是否真的进了 prompt；测试/调试据此区分「没有记忆」
           与「有记忆但被砍掉」。 */
        prior_attempts_shown: sPrior !== null,
        /* 本次 run 的决策轨迹是否进了 prompt。与 `prior_attempts_shown` 分开记：
           前者是跨 run 的统计，后者是本次 run 的意图，两者独立失效。 */
        this_run_shown: sRunLog !== null,
        this_run_rounds: Array.isArray(runLog) ? Math.min(runLog.length, 4) : 0,
        /* 粘性目标是否注入。与 THIS RUN 分开记：
           一个讲「我打算干什么」，一个讲「这件事还没做成」。 */
        sticky_goal_shown: sSticky !== null,
        sticky_goal_code: stickyGoal && stickyGoal.code ? stickyGoal.code : null,
        goal_changed_shown: sGoalChanged !== null,
        /* 残线段是否真的进了 prompt。与 `goal_changed_shown` 分开记：
           两者曾共用一个渲染入口，于是「没换关」被误读成「没有残线」。 */
        leftover_lines_shown: sLeftover !== null,
        /* 卡片的 `when:` 行是否进了 prompt —— 与 CAPACITY 同口径：
           让测试能区分「预算不够没加」与「加了但没用」。 */
        when_lines_shown: whenLinesOn,
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
