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
    /** 诊断点名带子的保底名额（见 pickBelts 的取舍规则；实测值 2，不是随手取的整） */
    STATE_BELTS_DIAG_RESERVE: 2,
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

/** 卡片的参数表：丢掉 `opts.dry_run`（loop 不让 LLM 决定 dry-run），最多 6 条。 */
function renderParams(spec) {
    const ps = spec.params
        .filter(p => p.name !== "opts.dry_run")
        .slice(0, 6)
        .map(p => `${p.name}:${p.type}${p.required ? "" : "?"}`);
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
            return `machine ∈ {${names.join(" | ")}}   (note the spelling: "rotater", not "rotator")`;
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

function renderCard(name) {
    const spec = MACRO_SPECS[name];
    const ex = MACRO_EXAMPLES[name];
    const notUse = (spec.whenNotToUse && spec.whenNotToUse[0]) || "";
    const lines = [
        `### ${name}`,
        sanitize(spec.summary).text.trim(),
        `params: ${sanitize(renderParams(spec)).text}`,
        `not when: ${clip(sanitize(notUse).text.trim(), 170)}`,
        `example: ${JSON.stringify(ex)}`,
    ];
    /* 合法值提示（防拼错）：见 LEGAL_VALUES 的注释 */
    const lv = LEGAL_VALUES[name];
    if (lv) {
        const v = lv();
        if (v) lines.push(`legal values: ${v}`);
    }
    return lines.join("\n");
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
     * 改这个数之前先跑 prompt_belt_visibility.test.mjs 的回归 E。 */
    const reserve = Math.min(referenced.length, PROMPT_RULES.STATE_BELTS_DIAG_RESERVE, cap);
    const goalSlots = Math.max(0, cap - reserve);

    for (const h of byGoal.slice(0, goalSlots)) push(h);   // ① 走廊保底
    for (const h of referenced) push(h);                   // ② 诊断点名保底
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
function renderProduction(production) {
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

    if (form === "short") {
        /* 短版：只留**一条**最该做的动作。优先「现在就买得起」的升级（零占格、全局生效），
           否则才说加机器。 */
        const buyNow = affordable[0];
        if (buyNow) {
            lines.push(`act: buy ${buyNow.line} T${buyNow.tier} ⇒ ${fmt(buyNow.capacityAfter)}/s`);
        } else if (add && add.add > 0) {
            lines.push(`act: add ${add.add} ${add.kind} ⇒ ${fmt(add.capacityAfter)}/s`);
        }
    } else {
        /* 两条路：加机器 / 升升级（都可执行时才写） */
        const roads = [];
        if (add && add.add > 0) {
            roads.push(`add ${add.add} ${add.kind} (${add.from}→${add.to}) ⇒ ${fmt(add.capacityAfter)}/s`
                + (add.enough ? " — fills the line" : ""));
        }
        if (up) {
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
                line += `; ${ev.sites} feasible site(s) on the goal raw corridor`;
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
             * 现在显式说明：「这些格子就是能放机器的地方，直接当 region」。 */
            const hint = code === "PROCESSOR_REQUIRED"
                ? ` (these are cells that can hold the machine — pass them to $path_of as the region)`
                : "";
            line += `; handles ${hs.join(",")}${hint}`;
        }
        if (Array.isArray(ev.stream_handles) && ev.stream_handles.length) {
            line += `; the stream itself runs through ${ev.stream_handles.slice(0, 3).join(",")} (context only, not the region)`;
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
 * @param {object} p.obs            ObsSnapshot（只用 goal / hub；entities 仅用于 uid→实体兜底）。
 *   **不读 `obs.production`** —— 产线数据是独立参数 `p.production`（理由见 renderProduction）。
 * @param {object|null} [p.production] `reader.production()` 的返回（window_seconds /
 *   produced_total / produced_per_sec / delivered_* / …）。缺省 ⇒ PRODUCTION 段如实说 unavailable。
 * @param {object|Array} p.handles  句柄表（见 normalizeHandles 的三种形态）
 * @param {Array} [p.diagnoses]     Diagnosis[]
 * @param {Array} [p.candidates]    宏名 或 {macro, why}；**必须是 MACRO_NAMES 的子集**
 * @param {object} [p.lastRound]    上一轮摘要（见 renderLastRound）
 * @param {object} [p.budget]       {rounds_left, llm_calls_left, tx_left, ticks_left, wall_ms_left,
 *                                   in_chars_max, prompt_tokens_max}
 * @param {object} [p.recipe]       已算好的结构化配方（`recipeForCached` 的返回）。
 *   给了就**直接复用**，不 spawn；没给才现算（走模块内 LRU）。
 * @returns {{system:string, user:string, tokens_estimate:number, blocks:object}}
 * @throws {PromptOverBudget} code=PROMPT_OVER_BUDGET（总字符 > in_chars_max）
 * @throws {TypeError} 缺 goal / obs / 未知候选宏
 */
export function buildPrompt({ goal, obs, handles, diagnoses, candidates, lastRound, budget, production = null, recipe: injectedRecipe = null } = {}) {
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
    const s3Machines = renderMachines(tbl, diagList);
    const s3Production = renderProduction(production);
    const s3Budget = renderBudget(budget);
    const s4 = renderDiagnoses(diagList);
    const s5 = renderLastRound(lastRound);
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

    const fixed = [s2, goalAndRecipe, s3Hub, s3Machines, s3Production, s3Budget, s4, s5, s6]
        .filter(x => x !== null && x !== undefined).join("\n\n");

    /* ── 截断：只动带子列表。目标 = min(token 预算, 字符硬上限) ── */
    const targetChars = Math.min(Math.floor(limits.tokensMax * PROMPT_RULES.CHARS_PER_TOKEN), limits.inCharsMax);
    const compose = (belts, capacity) => [s2, goalAndRecipe, s3Hub, s3Machines, capacity, belts,
        s3Production, s3Budget, s4, s5, s6].filter(x => x !== null && x !== undefined).join("\n\n");

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

    /* ── 余量全部给 CAPACITY（不给带子动刀子） ── */
    let capacityDowngraded = false;
    if (capacityInfo) {
        const room = targetChars - (s1.length + user.length) - 2;   // 2 = 插入段后的空行
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
        capacity_unavailable: capacityUnavailable,
        capacity_bottleneck: capacityNote,
        capacity_downgraded: capacityDowngraded,
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
