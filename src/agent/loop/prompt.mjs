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
    insert_machine: () => {
        try {
            const names = Object.keys(SUPPORTED_BUILDINGS);
            /* ★ `$ore` 必须在这里说，不能只放在 `whenToUse` ★
             *
             * 2026-11-12 第 9 关实测：模型想给 mixer 接红颜料，而矿不是实体、
             * 句柄表里没有它。`$ore` 是**唯一**能给矿机指定矿位的写法，
             * 但它只写在 `insert_machine.whenToUse[1]` 里 ——
             * 而 `when:` 行只在预算宽裕时才渲染（见 renderCard 的 useFor）。
             *
             * `LEGAL_VALUES` 是**无条件**渲染的，所以把它挪到这里。
             * 实测代价：prompt 里 `$ore` 从「一次都不出现」变成每次都出现，
             * 而模型 8 轮里一次都没用过它 —— 不是没想到，是根本没看到。 */
            return `machine ∈ {${names.join(" | ")}}   (note the spelling: "rotater", not "rotator")`
                + `; at 也可写 {"$ore":"<矿种>"} 让宏挑一格矿 —— 形状矿用前缀（"Cu"/"Ru"），`
                + ` 颜料矿用颜色名（"red"/"blue"）。只是选格，facing 仍要给`;
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
        const v = lv();
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
     *    本来正常的矿机。 */
    const posByUid = new Map();
    if (oreAt) {
        for (const e of (obs && obs.entities) || []) {
            if (e && Number.isInteger(e.uid) && Number.isInteger(e.x) && Number.isInteger(e.y)) {
                posByUid.set(e.uid, e);
            }
        }
    }
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
         * ## 为什么**不**标「在采什么」
         *
         * 第一版对有矿的也写 `[mining RuRuRuRu]`。代价立刻显形：
         * L4 冷启动夹具有 8 台矿机，8 条标注把 prompt 从 4400 涨到 5098，
         * **把 CAPACITY 段整个挤掉了**（`capacity_unavailable: dropped-for-budget`）。
         * 而 CAPACITY 是实测 p≈5e-7 的信息源（见 `AB-PROMPT-RESULT.md`），
         * 优先级远高于「这台矿机在采什么」。
         *
         * 信息价值也不对等：
         *   · 「在采 Ru」是**正常状态**，模型不需要被提醒；
         *   · 「没矿」是**故障状态**，而且它会让下游整条线永远零产出 —— 必须说。
         *
         * 所以只标异常的一侧。正常的一台都不加，省下的字符全留给 CAPACITY。
         * 「整体有哪些矿、目标矿在哪」由下面那行 `target ore …` 统一交代。 */
        if (e.type === "miner" && oreAt) {
            const ent = posByUid.get(e.uid);
            if (ent && !oreAt.get(`${ent.x},${ent.y}`)) {
                line += "  [⚠ NO ORE under this miner — it will never produce anything]";
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
    /* 调用方可以强制紧凑（预算降级时用）：见 buildPrompt 里那段降级逻辑。 */
    const resCompact = opts.resourceCompact === true || shown.length > 6;
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

    /* 目标颜色 = 形状串里第一个两字母色号（`Cu`/`Ru`/`Rb`…）。
     * 用「首字母大写 + 小写」这个形状本身，而不是抄一张色表 ——
     * 色表会随游戏版本变，而形状串的写法是稳定的。 */
    const m = /^([A-Z][a-z])/.exec(String(goalShape || ""));
    if (!m) return null;
    const color = m[1];

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

    /* 目标矿：`Cu` → kind 形如 `CuCuCuCu` */
    const targetKinds = [...byKind.keys()].filter(k => String(k).startsWith(color));
    const present = [...byKind.keys()];

    if (targetKinds.length) {
        /* ⚠️ **不渲染坐标**：prompt 有一条硬契约「坐标 0 命中」
         *    （`prompt.test.mjs` 的「同一份渲染里坐标正则 0 命中」）。
         *    第一版写了 `(nearest 20,5; bbox …)`，直接把那条测试打红。
         *    模型本来也不许用坐标下指令（只能用句柄），给了坐标只会诱发幻觉。
         *    给「有没有 / 多少格 / 远近档位」就够它判断该不该往那个方向找。
         *
         * 紧凑模式只给最主要的那个矿种（格数最多的），丢掉远近档位。
         * 用在 MACHINES 段已经吃掉大部分预算的场合 —— 那里「有铜」这个事实
         * 本身就是关键，具体几格、多远是次要的。 */
        if (compactForm) {
            const top = targetKinds
                .map(k => [k, byKind.get(k)])
                .sort((a, b) => b[1].count - a[1].count)[0];
            return `⇒ target ore ${color} IS on the map: ${top[0]}×${top[1].count}`;
        }
        const parts = targetKinds.map(k => {
            const e = byKind.get(k);
            return `${k}×${e.count} (${withinBand(e.nearestD)})`;
        });
        return `⇒ target ore ${color} IS on the map: ${parts.join("; ")}`;
    }

    /* 没有目标矿：把地图上实际有的列出来 —— 这就是「为什么你在造别的东西」的答案 */
    const have = present.slice(0, 4).join(", ");
    if (compactForm) {
        return `⇒ target ore ${color} is NOT in the scanned area (found: ${have || "none"})`;
    }
    return `⇒ target ore ${color} is NOT in the scanned area (resources found: ${have || "none"})`
        + ` — no miner can ever produce ${color} here; check for a ${color} patch or a different route`;
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
    return {
        inCharsMax: pick("in_chars_max", "LLM_IN_CHARS_MAX", "inCharsMax") || PROMPT_RULES.LLM_IN_CHARS_MAX,
        tokensMax: pick("prompt_tokens_max", "PROMPT_TOKENS_MAX", "promptTokensMax") || PROMPT_RULES.PROMPT_TOKENS_MAX,
        includeWhen,
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
     * 那是"哪种办法更快吃满供给"的**策略**答案。但 loop 的执行面只有 6 个宏，
     * 里面**没有**任何宏能买升级 —— 于是 prompt 会输出
     * `act: buy processors T2 ⇒ 0.75/s`，而模型照着写 `{"macro":"upgrade"}`
     * 会被 `LLM_UNKNOWN_MACRO` 拒掉。
     *
     * **教模型做一个不存在的动作，比不提更坏**：它浪费一轮、消耗预算，
     * 而且会被记成"模型答错了"，掩盖真正的原因（宏缺失）。
     *
     * 判据不看 `MACRO_NAMES` 里有没有 `upgrade` 这个字符串 —— 那是猜"买了升级之后
     * 会叫什么名字"。判据是**有没有宏的产物能实现一次升级**：升级不增删实体，
     * 所以任何只产出 place/delete 类 op 的宏都不可能做到它。
     * 等 `upgrade` 宏真的接进 loop 的执行面，这里再加一个显式的白名单条目。
     */
    const canBuyUpgrade = false;   // ← 加 `upgrade` 宏并接进 `MACRO_FNS` + `doApply` 后改这里
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
            const short = up.affordable ? "ready now" : `needs ${fmtShort(up.missing)}`;
            roads.push(`${up.line} T${up.tier} (×${up.multiplierFrom}→×${up.multiplierTo}) ⇒ ${fmt(up.capacityAfter)}/s — ${short}`);
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

    visible.forEach((d, i) => {
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
            const h = clip(sanitize(d.hint).text.trim(), 180);
            if (h) line += `; hint: ${h}`;
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
            if (code === "ambiguous_port" && Array.isArray(f.candidates) && f.candidates.length) {
                const opts = f.candidates
                    .filter(c => c && typeof c.role === "string" && Number.isInteger(c.index))
                    .slice(0, 4)
                    .map(c => `{role:"${c.role}", index:${c.index}}`);
                if (opts.length) {
                    lines.push(`  · ${mac} → ${code}${obsTxt ? `: ${obsTxt}` : ""}`);
                    lines.push(`    ↳ use one of: ${opts.join(" | ")}`);
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
export function buildPrompt({ goal, obs, handles, diagnoses, candidates, lastRound, lastNetEffect = null, priorAttempts = null, goalChanged = null, obsoleteLines = null, budget, production = null, recipe: injectedRecipe = null, runLog = null, stickyGoal = null } = {}) {
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
    const s2 = renderCards(candidates, { includeWhen: whenLinesOn });
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
    const recipeUnavailable = s3Recipe === null
        ? (r && typeof r.reason === "string" && r.reason ? r.reason : (r && r.ok === true ? "empty recipe" : "unavailable"))
        : null;
    const s3Hub = renderHub(tbl);
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
    const s6 = INSTRUCTION;

    const selection = pickBelts(tbl, diagList, goalShape, obs);
    /* 配方紧跟在 GOAL 之后：它是「这个目标怎么造」的一部分，不是独立信息 */
    const goalAndRecipe = s3Recipe ? [s3Goal, s3Recipe].join("\n\n") : s3Goal;

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
                if (compactRes !== s3Machines) {
                    const savedC = s3Machines.length - compactRes.length;
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
                    const saved = s3Machines.length - withoutRes.length;
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
                    const savedHint = s3Machines.length - noHint.length;
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
                    const text = renderCapacity(capacityInfo.capacity, capacityInfo.options, { room, form });
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
    const chars = s1.length + user.length;
    if (chars > limits.inCharsMax) {
        throw new PromptOverBudget(
            `prompt is ${chars} chars > LLM_IN_CHARS_MAX ${limits.inCharsMax}; `
            + "only the S3 belt list may be trimmed, so this is a hard failure (goal/diagnosis must not be truncated)",
            {
                chars, limit: limits.inCharsMax,
                sections: { s1: s1.length, s2: s2.length, s3_goal: s3Goal.length, s3_hub: s3Hub.length,
                    s3_machines: s3Machines.length, s3_belts: s3Belts.length, s3_production: s3Production.length,
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
        s3_production: s3Production, s3_budget: s3Budget,
        /* 配方段（可能为 null —— solver 不可用）。单独暴露，便于测试与排查 */
        s3_recipe: s3Recipe,
        recipe_unavailable: recipeUnavailable,
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
