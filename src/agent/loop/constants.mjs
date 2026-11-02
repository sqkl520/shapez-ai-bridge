/**
 * loop/constants.mjs — 阶段 2 loop 的**常量真值**：预算、诊断码闭集、模式、检索表。
 *
 * 唯一依据：`research/ai-plan/PHASE2-CONTRACT-V2.md`（v2 补丁优先于 v1）。
 * 本文件零依赖（只读 import 宏名表），无 IO，无副作用。
 *
 * ## 为什么这个文件单独存在
 *
 * v1 契约里 `DIAG_CODES` 写成了**裸标识符**块（`OBS_TRUNCATED, OBS_STALE, ...`），
 * 运行即 `ReferenceError`（红队复现：`.tmpverify/rt-phase2-57.mjs`）。而且它声明的码
 * 与正文实际使用的码**不是同一个集合**，导致「验收判据 4（reason ∈ DIAG_CODES）」
 * 按字面永远不通过。v2 §2.5 的裁决是：**写成合法对象字面量，一个码一条说明**。
 *
 * 本文件把下面三件事钉死为同一份真值：
 *   1. 诊断码闭集（`DIAG_CODES`）—— loop / diagnose / transcript / 验收脚本共用；
 *   2. 预算（`BUDGET`）—— v2 §4 把 ROUNDS_MAX 从 6 降到 3；
 *   3. 检索表（`RETRIEVAL_TABLE`）—— 诊断码 → 候选宏（v2 §7：retrieve 第一版是静态表）。
 *
 * 闭集纪律（v2 §2.5）：`Object.freeze` + 测试断言 `defineProperty` 新增键会失败。
 * 新增一个码 = 一次有意识的改动（同时改测试里的计数），不是往数组里塞一个字符串。
 *
 * @version 2
 */
import { MACRO_NAMES } from "../macros/contract.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 诊断码闭集
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 诊断码 → 人读说明。**key 是码，value 是非空说明字符串**。
 *
 * 每一条都对应一个**机器可判定的触发条件**（见 V2 §2 与 verify_runtime 的真实字段）。
 * 说明文字里刻意写清「在哪一层、由谁触发」，因为本项目已经因为「码有名字、判据没字段」
 * 出过整轮假绿（`produced_delta` / `uidDiff` / `tx.results[].mismatch` 三处）。
 *
 * ⚠️ 已知的「可声明但当前不可判定」的码（v2 §2 修正后仍然是概念码，不许拿它当真判据）：
 *   · `PRODUCED_NOT_DELIVERED` / `NO_PRODUCTION` / `WRONG_SHAPE_PRODUCED` ——
 *     checkBehavior 的 evidence 只有 `produced_window_*`（窗口求和），没有独立 produced；
 *     触发必须由 loop 用 evidence 字段自行组合，不能解析 reason 文案。
 *   · `PRODUCTION_UNTRUSTED` —— mod 不给「当前片是否完整」，只能按 slices 数判。
 *   · `RV_UNSTABLE` —— `rv_settle` 这一确定性修复动作**当前不存在**（v2 未落地）。
 *   · `GAME_COERCED` —— tx 层拿不到 mismatch（v2 §2.3），只能由 L1 的 wrong_rv/wrong_code 触发。
 * 这些限制写在这里而不是藏进实现，是为了下一个改 loop 的人不必重新发现一遍。
 */
export const DIAG_CODES = Object.freeze({
    /* ── observation ── */
    OBS_TRUNCATED: "world observation was truncated; no criterion above this is trustworthy",
    OBS_STALE: "a handle/uid referenced a world that is no longer current",
    PATHS_TRUNCATED: "debug_items returned fewer paths than pathCount",
    PRODUCTION_UNAVAILABLE: "production() failed or lacked slice_seconds",
    ITEMS_UNAVAILABLE: "debug_items failed or had no paths[]",

    /* ── llm ── */
    LLM_TRANSPORT: "network/API failure",
    LLM_PARSE: "response was not valid JSON after fence-stripping",
    LLM_EMPTY_PLAN: "calls[] was empty",
    LLM_COORD: "literal coordinate detected in LLM output (V1..V6)",
    LLM_UNKNOWN_MACRO: "macro not in the 6-name whitelist",
    LLM_ARGS: "validateMacroCall rejected the args",
    LLM_LINT: "lintNoBareCoords rejected the args",

    /* ── plan / macro ── */
    MACRO_REFUSED: "a macro returned ok:false",
    MACRO_HALF_DONE: "macro returned ok:true but cells_placed !== cells_planned",
    /* 2026-11-02：`partial` 模式下「一条可撤销的调用都没有」。
     *
     * 为什么单列而不是复用 `MACRO_REFUSED`：
     *   · `MACRO_REFUSED` = 某个宏自己说不行（**模型**该换那个宏）
     *   · `NO_REVERSIBLE_CALL` = 宏可能都成功了，但它们只产机器/垃圾桶，
     *     落盘就撤不回来（**策略**该换一类修法）
     *
     * 两者给模型的 hint 完全不同，混成一个码会让它以为「换个参数」就行。
     * 实测依据：`.tmpverify/redteam-partial/reversible.mjs`（177 条样本）——
     * 「提交全部成功子集」会带来 88 次不可逆写入，其中大头是 `trash_unused`
     * 把 `DEAD_END` 出口封死。 */
    NO_REVERSIBLE_CALL: "partial mode found no call whose output can be undone",
    PLAN_REJECTED: "planToTxOps rejected the merged plan",
    COORD_PROVENANCE: "a coordinate had no valid provenance tag",
    PATH_NOT_RECT: "a $path_of selection does not fill its own bounding box, so the region parameter cannot express it",

    /* ── apply ── */
    TX_ROLLED_BACK: "tx rolled back",
    TX_UNAVAILABLE: "mod has no tx, or it errored before running",
    GAME_COERCED: "the world did not match the plan after landing (L1 wrong_rv/wrong_code)",

    /* ── runtime L0..L4 ── */
    LANDING_MISSING: "L1: planned entity absent",
    LANDING_MISMATCH: "L1: type/uid/rot/rv/code differs",
    DELETE_NOT_REPLAYED: "L1: a declared delete did not happen",
    UNDECLARED_DESTRUCTION: "an entity vanished that was not in destroys[]",
    SLOT_STARVED: "L2: an input slot has no upstream",
    OUTPUT_UNROUTED: "L2: an output slot has no downstream",
    FLOW_UNREACHABLE: "L3: a declared flow does not reach its target",
    FLOW_UNVERIFIED: "L3 was degraded (no flows supplied) — not a pass",

    /* ── 结构层（P-a0，`loop/structural.mjs`） ──
     * 这一组是纯拓扑判据，**不依赖「能不能走到 hub」**；可达性只用于排序（`evidence.tier`）。
     * 旧 `DEAD_END` 把「可达」写进了触发条件，导致它与可达性互斥、恒不触发
     * （`research/ai-plan/tmp/DIAGNOSE-BASELINE.md` §3b 已给出完整证明）。
     *
     * 判据写在说明里，因为「码有名字、判据没字段」这个项目已经出过整轮假绿。 */
    DEAD_END: "L2: a belt/tunnel run's exit cell has no entity at all (pure topology; 'entity present but rejects' is BELT_HANDOFF_REJECTED)",
    BELT_HANDOFF_REJECTED: "L2: a belt/tunnel pushes into an entity that does not accept from that direction",
    CHAIN_UNFED: "L2: a belt run has no effective supply upstream (empty cell, a source that never ejects, or a barren miner)",
    WASTE_NO_SINK: "L3: a declared waste slot's run ends at {trash, empty, rejected} while the world has zero trash buildings",
    RAW_MATERIAL_MISSING: "L4: the recipe needs mine but the world has zero miners",

    /* ── 语义层（P-a，`loop/semantic.mjs`） ──
     * 判据写在说明里（同上：码有名字、判据没字段 = 假绿）。
     * ⚠️ severity 是**两档**不是三档（v2 §2）：`PROCESSOR_REQUIRED` 有两种 scope，
     *    `scope:"stream"` 是 warn（该做的事）、`scope:"factory"` 是 blocker（工厂真的缺机器）。
     *    只看 code 分不出严重性，必须看 `evidence.scope` —— 这是本闭集里唯一一个有这种二义性的码。 */
    PROCESSOR_REQUIRED: "L4: the recipe needs a process step (cut/rotate/stack/paint) that is either absent from the factory (scope:factory, blocker) or present but not on the stream that carries its input shape (scope:stream, warn)",
    WRONG_SHAPE_AT_HUB: "L4: a stream reaching the hub carries a shape that is one rotation away from the goal (in orbit(goal) but not goal); the fix is upstream, not at the inlet",
    DISCARDED_INTERMEDIATE: "L4: a multi-output machine sends a useful half (in orbit(goal) or the recipe closure) into trash/nowhere while the other half is delivered and is not the goal",
    SHAPE_UNKNOWN: "L4: shape propagation stopped (no-resources/tunnel/unknown-op/unverified-rotation/cycle/unknown-color); info only, never a blocker and never fed to the LLM as an action",

    NO_PRODUCTION: "L4: nothing produced",
    WRONG_SHAPE_PRODUCED: "L4: production exists but under a different shape key",
    PRODUCED_NOT_DELIVERED: "L4: produced > 0 but delivered == 0",
    PRODUCTION_UNTRUSTED: "L4: delivered slices unusable (<2 slices or empty)",

    /* ── meta ── */
    NO_DIAGNOSIS: "diagnose() produced nothing — treated as a loop bug",
    /* 2026-11-02：调用方传的 goal 与世界的当前目标不一致。
     * 真机踩过：runner 硬编码 goal='RuRu----'，而世界已经升到 level 5（Cu----Cu）。
     * diagnose() 用 goal 判「有没有在造它」⇒ 传错就返回空 ⇒ 看起来像「世界很健康」。 */
    GOAL_MISMATCH: "the goal passed to runLoop differs from obs.goal.requirement.shape",
    /* 2026-11-03：`{"$ore":"Cu"}` 指的这个矿种在地图上不存在。
     * 真机实测：模型正确诊断出「那台矿机脚下没有矿」，然后想放新矿机，
     * 但它只能靠 `$ore` 指名矿点 —— 若那个颜色真的没有，必须明说，
     * 否则它会一直重试一个物理上不可能的动作。 */
    ORE_NOT_FOUND: "an $ore reference names a mineral that is not on the map",
    NO_PROGRESS: "same fingerprint with the same action",
    NO_PROGRESS_3X: "same fingerprint three times",
    NO_WORLD_CHANGE: "tx succeeded but the world hash did not change",
    NET_REGRESSION: "hardFails grew, or a new code appeared",
    BUDGET_EXHAUSTED: "a budget was exhausted",
    BUDGET_ROUNDS: "round budget exhausted",
    BUDGET_LLM_CALLS: "LLM call budget exhausted",
    BUDGET_TX: "tx budget exhausted",
    BUDGET_TICKS: "tick budget exhausted",
    BUDGET_WALL: "wall-clock budget exhausted",
    MOCK_EXHAUSTED: "MockLLMClient ran out of fixture rounds",
    RV_UNSTABLE: "rv still wrong after one rv_settle",
    INTERNAL: "loop bug — do not retry",
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 预算
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一次 run 的硬上限。全部是**计数**，超了即 halt（不是"再试一次"）。
 *
 * 数值来源逐条对齐 v2 / 既有实现：
 *   · `ROUNDS_MAX = 3`  —— v2 §4：从 6 降到 3。理由不是 F7（那是测量错误），
 *     而是「L4 的正解只需 1 次 replace_run，3 轮是失败重试的余量」。
 *   · `TX_OPS_MAX = 2000` —— mod 的真实上限（`shapez-ai-bridge.js:3258`，v2 §0 修正了行号）。
 *   · `TICKS_MAX = 24000` —— ⚠️ **不是**契约 v1 注释里写的「200 游戏秒 @120Hz」。
 *     游戏默认 60 tick/s（红队 §硬事实表附注），24000 tick ≈ 400 秒；而且 mod 的
 *     `MAX_STEP_TICKS = 20000`，**24000 一次性发不进去**（会得到 2001）。
 *     保留这个数是因为它是 v2 的裁决值；真正发 step 时必须按 ≤20000 分片。
 *     （这条差异记在这里，别让它再被当成「20 秒」。）
 *   · `SAME_FINGERPRINT_MAX = 2` —— v2 §4：三层简化成两层（同 fp 第 2 次必须换动作，第 3 次 halt）。
 *   · `MAX_PATHS = 40` —— mod 的 `paths.slice(0, 40)`（`shapez-ai-bridge.js:1002`）。
 */
export const BUDGET = Object.freeze({
    ROUNDS_MAX: 3,
    LLM_CALLS_MAX: 8,
    TX_MAX: 6,
    TX_OPS_MAX: 2000,        // = shapez-ai-bridge.js:3258
    TICKS_MAX: 24000,        // ⚠️ 见上方说明：≈400s@60tick/s，且需分片 ≤20000
    WALL_MS_MAX: 15 * 60_000,
    SAME_FINGERPRINT_MAX: 2, // v2 §4：同 fp 第 2 次必须换动作；第 3 次 halt
    /* ★ 2026-11-02：部分执行，**默认开** ★
     *
     * `buildTxPlan(..., {partial:true})` 会跳过失败的/不可撤销的调用，
     * 只提交「成功且产物可撤销」的那个子集。
     *
     * ## 为什么开
     *
     * 全有或全无的实测代价（`FIVE-ROUNDS-FINAL.md`，五轮 148 条）：
     *   `calls≥4` 时执行率 **0/82**。一条宏失败，整轮 0 op。
     *
     * 方案 E 的实测（`.tmpverify/redteam-partial/e2e.mjs`，178 条）：
     *   提交 1 (0.6%) → 31 (17.4%)，不可逆 place 1 → 1（没涨）。
     *
     * ## 为什么是「可撤销」而不是「全部成功子集」
     *
     * 红队 `REDTEAM-PARTIAL-APPLY.md` 用实测否掉了后者：
     * 88 次不可逆写入（大头是 `trash_unused` 把 `DEAD_END` 出口封死），
     * 而只有 45% 是真目标动作。方案 E 的目标动作密度是 **100%**（54/54）。
     *
     * ## 判据层已经接上
     *
     * `strictVerdict` 的 `PARTIAL_APPLY` 会让 `achieved` 变 false ——
     * 真机验证过（`PARTIAL-LIVE-VERIFIED.md`）：
     * 部分执行落盘了（42→45 实体），但 `achieved: false`，假绿被挡住。
     *
     * ## 「永远 partial」的风险已排除
     *
     * 真机多轮（`LIVE-MULTIROUND-RESULT.md`）：第 1 轮就是 `partial=false`。
     * 而且 `NO_REVERSIBLE_CALL` 被拒之后，模型**换了修法**
     *（`replace_run` → `connect`）。
     *
     * 想关掉就传 `budget: { PARTIAL_APPLY: false }`。 */
    PARTIAL_APPLY: true,
    LLM_IN_CHARS_MAX: 12000,
    LLM_OUT_CHARS_MAX: 4000,
    PROMPT_STATE_BELTS_MAX: 12,
    MAX_PATHS: 40,           // = mod 的 paths.slice(0, 40)
});

/** 运行模式。`live` 之外的任何模式**都不能**作为阶段 2 达成的证据（v2 §6）。 */
export const MODES = Object.freeze(["live", "mock", "replay"]);

/** transcript / artifacts 的落盘根目录（相对仓库根）。 */
export const RUN_DIR = "research/ai-plan/runs";

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 检索表（v2 §7：retrieve 的第一版就是一张静态表）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 冻结一条候选列表：`[["connect", 8], ...]` → `[{macro, weight}…]`（深冻结）。 */
const cand = list => Object.freeze(list.map(([macro, weight]) => Object.freeze({ macro, weight })));

/**
 * 诊断码 → 候选宏（按 weight 降序，调用方取 top-3）。
 *
 * ## 这张表表达不了什么（必须知道，否则会误以为「权重已实现」）
 *
 * 1. **码内分层**：v1 §4.3 的 `MACRO_REFUSED` / `PLAN_REJECTED` 的候选是按**宏的 error.code
 *    二次分派**的（`occupied→connect/remove_run`、`port_already_bound→connect` …）。
 *    静态表只有一个维度（诊断码），表达不了这层。下面的权重是「该 code 下全部可能宏的并集」，
 *    只用于**排序提示**；真正的分派必须读 `error.code`（loop/verify 里做）。
 * 2. **`LLM_ARGS` 的自重试**：v2 §5.2 要求「结构错误 → candidates=[该宏自身]，允许重试一次」，
 *    这依赖**当轮那条调用**的宏名，静态表同样表达不了 → 这里留空（空 = 不许喂 LLM）。
 * 3. **修复动作不是宏**：`rv_settle`（v1 的确定性修复）在 `MACRO_NAMES` 之外，也不能写成候选。
 *    所以 `GAME_COERCED` / `RV_UNSTABLE` 只给 `replace_run`（重铺），`rv_settle` 由 repair 自己做。
 *
 * 空数组的语义是 v1 §4.3 的原话：**candidates 为空 = 不许喂给 LLM 让它自由发挥**，
 * loop 只能走「确定性修复或 halt」。
 */
export const RETRIEVAL_TABLE = Object.freeze({
    /* ── observation：先重读世界，不是重规划 ── */
    OBS_TRUNCATED: cand([]),
    OBS_STALE: cand([]),
    PATHS_TRUNCATED: cand([]),
    PRODUCTION_UNAVAILABLE: cand([]),
    ITEMS_UNAVAILABLE: cand([]),

    /* ── llm：输出格式问题，重问一次即可（不消耗 round 以外的世界动作） ── */
    LLM_TRANSPORT: cand([]),
    LLM_PARSE: cand([]),
    LLM_EMPTY_PLAN: cand([]),
    LLM_COORD: cand([]),
    LLM_UNKNOWN_MACRO: cand([]),
    LLM_ARGS: cand([]),
    LLM_LINT: cand([]),

    /* ── plan / macro ── */
    /* 并集权重（误差码级 refinement 见文件头第 1 条）：能修「被占/无路/抢口/没落点」的只有这几个 */
    MACRO_REFUSED: cand([
        ["connect", 5],
        ["remove_run", 4],
        ["insert_machine", 4],
        ["trash_unused", 3],
        ["replace_run", 2],
        ["extend_line", 1],
    ]),
    MACRO_HALF_DONE: cand([]),        // INTERNAL：半成是事务/实现 bug，重试只会重复半成
    /* 2026-11-02（partial 模式）：所有调用都只产机器/垃圾桶，落盘撤不回来。
     *
     * 该推的宏：**只产带子的那些**（connect / extend_line / replace_run 的 belt 模式）——
     * 它们能用 `remove_run` 撤销。
     *
     * ⚠️ **故意不推 `insert_machine` / `trash_unused`** ——
     * 推它们等于「再试一次同一条走不通的路」。这正是这个码想避免的。
     * 这也是它和 `MACRO_REFUSED` 的候选表**最重要的区别**：
     * 后者照常推 insert_machine（因为那个宏本身可能没问题，只是参数错了）。 */
    NO_REVERSIBLE_CALL: cand([
        ["connect", 5],
        ["extend_line", 4],
        ["replace_run", 3],
        ["remove_run", 2],
    ]),
    PLAN_REJECTED: cand([
        ["remove_run", 4],
        ["insert_machine", 3],
        ["replace_run", 3],
        ["connect", 2],
    ]),
    COORD_PROVENANCE: cand([]),       // 视为 bug，必须人工
    /* 非连续选区：**不是** bug，也不是模型笨 —— 是它把一条拐弯的链当成一条直线交过来了。
       重试时给它 replace_run 是合理的（它可以拆成小的连续段）；但不能多给它别的宏，
       那会让下一轮换一个宏继续猜。 */
    PATH_NOT_RECT: cand([["replace_run", 5]]),

    /* ── apply ── */
    TX_ROLLED_BACK: cand([]),         // 先重读；按 failures[].code 再分派（表外逻辑）
    TX_UNAVAILABLE: cand([]),         // 硬停：mod 没有事务能力
    GAME_COERCED: cand([["replace_run", 6]]),

    /* ── L1 ── */
    LANDING_MISSING: cand([
        ["insert_machine", 6],
        ["connect", 4],
        ["replace_run", 3],
        ["trash_unused", 2],
    ]),
    LANDING_MISMATCH: cand([
        ["replace_run", 7],           // belt 模式修 rv/code；机器模式重铺
        ["insert_machine", 4],
        ["connect", 3],
    ]),
    DELETE_NOT_REPLAYED: cand([["remove_run", 6]]),
    UNDECLARED_DESTRUCTION: cand([]), // 硬停（v2 §2.4）

    /* ── L2 ── */
    SLOT_STARVED: cand([
        ["connect", 8],
        ["insert_machine", 5],
        ["trash_unused", 3],
    ]),
    OUTPUT_UNROUTED: cand([
        ["trash_unused", 8],
        ["connect", 6],
        ["extend_line", 4],
    ]),

    /* ── L3 ── */
    FLOW_UNREACHABLE: cand([
        ["connect", 9],
        ["remove_run", 4],
        ["insert_machine", 3],
    ]),
    FLOW_UNVERIFIED: cand([]),        // loop 自己的缺陷：先补 flows，不许猜

    /* ── 结构层（P-a0） ──
     * 这些码的判据是纯拓扑的，所以候选宏也可以按「几何上怎么修」来给：
     *   · 断头 / 无处可倒 ⇒ 要么接上、要么丢进 trash；
     *   · 拒收 ⇒ 来向接错了，`replace_run`（重铺那一段）比 `connect` 更常是对的；
     *   · 无源头 ⇒ 缺的是上游，`connect` / `insert_machine`（补矿机或工序机）；
     *   · 0 台矿机 ⇒ 只能先放矿机。 */
    DEAD_END: cand([
        ["trash_unused", 7],
        ["extend_line", 4],
        ["connect", 3],
    ]),
    BELT_HANDOFF_REJECTED: cand([
        ["replace_run", 6],
        ["connect", 5],
        ["trash_unused", 3],
    ]),
    CHAIN_UNFED: cand([
        ["connect", 8],
        ["insert_machine", 6],
        ["extend_line", 4],
    ]),
    WASTE_NO_SINK: cand([
        ["insert_machine", 7],        // insert_machine 的 allowed 表里有 trash（place.mjs:378）
        ["connect", 4],
        ["trash_unused", 4],
    ]),
    RAW_MATERIAL_MISSING: cand([
        ["insert_machine", 9],        // 只有「放一台矿机」能修
        ["connect", 3],
    ]),

    /* ── 语义层（P-a） ──
     * `PROCESSOR_REQUIRED` 的两种 scope 共用一条呢？**不** —— 检索表只有一维（码），
     * 表达不了 evidence.scope；这里给的是并集，权重按最常见的那支护线：
     *   · stream：在那条流上插一台机器（replace_run 最贴合，见 remove.mjs 的扩展路径）；
     *   · factory：先要有一台机器（insert_machine），再接线。
     * `WRONG_SHAPE_AT_HUB` 刻意**不给** connect 高权重：病在上游，接入口只会更糟。
     * `SHAPE_UNKNOWN` 为空 = 不许喂给 LLM（契约 §3 的硬要求）。 */
    PROCESSOR_REQUIRED: cand([
        ["replace_run", 8],
        ["insert_machine", 6],
        ["connect", 3],
    ]),
    WRONG_SHAPE_AT_HUB: cand([
        ["replace_run", 8],
        ["insert_machine", 4],
        ["connect", 1],
    ]),
    DISCARDED_INTERMEDIATE: cand([
        ["replace_run", 7],
        ["connect", 5],
        ["insert_machine", 3],
    ]),
    SHAPE_UNKNOWN: cand([]),

    /* ── L4 ── */
    /* ⚠️ 这三个码的触发判据在 v2 §2.1 之后仍受 evidence 字段限制（见 DIAG_CODES 文件头），
       权重只是 v1 §4.3 的继承值，不代表它们已可判定。 */
    /* ★ `replace_run` 必须在这里（2026-10-29 第二轮验收审计 B-2）★
     *
     * 冷启动第一轮**永远**得到 `NO_PRODUCTION`（还没有任何生产），所以这张表决定了
     * 模型第一轮能看到哪些宏卡片。以前只给 connect/insert_machine/trash_unused ——
     * 而 L4 的正解恰恰是 `replace_run`。于是真 loop 的第一轮**从来不把正解宏摆出来**，
     * 模型只能看到一个名字（system 的 Rule 10 提到过）却没有参数卡片，
     * 等于要求在不知道 args 形状的情况下凭空造调用。
     *
     * 这与「看得见带子」是同一类缺陷，只是从 S3（世界状态）搬到了 S2（候选宏）。
     * 权重给最高：改造既有产线是真实存档里最常见的动作，而冷启动第一轮的
     * 目标几乎总是"把某段不通的链改对"。
     */
    NO_PRODUCTION: cand([
        ["replace_run", 8],
        ["insert_machine", 5],
        ["connect", 4],
        ["remove_run", 3],
        ["trash_unused", 2],
    ]),
    WRONG_SHAPE_PRODUCED: cand([]),   // 先查 goal 键（形状串抄错是最高频原因）
    PRODUCED_NOT_DELIVERED: cand([
        ["connect", 8],
        ["trash_unused", 5],
    ]),
    PRODUCTION_UNTRUSTED: cand([]),   // 重采样，不是重规划
    RV_UNSTABLE: cand([["replace_run", 7]]),

    /* ── meta：一律 halt / 人工 ── */
    NO_DIAGNOSIS: cand([]),
    GOAL_MISMATCH: cand([]),           // 调用方 bug，换宏没用
    /* `$ore` 指名了一个地图上没有的矿种 —— 换宏也没用（物理上没有那种矿）。
     * 真要"换个做法"，只能是别挖那个颜色；那属于目标本身的问题。 */
    ORE_NOT_FOUND: cand([]),
    NO_PROGRESS: cand([]),
    NO_PROGRESS_3X: cand([]),
    NO_WORLD_CHANGE: cand([]),
    NET_REGRESSION: cand([]),
    BUDGET_EXHAUSTED: cand([]),
    BUDGET_ROUNDS: cand([]),
    BUDGET_LLM_CALLS: cand([]),
    BUDGET_TX: cand([]),
    BUDGET_TICKS: cand([]),
    BUDGET_WALL: cand([]),
    MOCK_EXHAUSTED: cand([]),
    INTERNAL: cand([]),
});

/**
 * 检索表自检（纯函数）。测试与 loop 启动时都可以调。
 *
 * @param {object} table 待检表（默认 RETRIEVAL_TABLE）
 * @param {object} codes 码闭集（默认 DIAG_CODES）
 * @param {readonly string[]} macros 宏名闭集（默认 MACRO_NAMES）
 * @returns {{ok:boolean, violations:Array<{path:string, reason:string, value:any}>}}
 */
export function validateRetrievalTable(table = RETRIEVAL_TABLE, codes = DIAG_CODES, macros = MACRO_NAMES) {
    const v = [];
    const names = new Set(macros);
    for (const [code, list] of Object.entries(table)) {
        if (!(code in codes)) {
            v.push({ path: code, reason: "诊断码不在 DIAG_CODES 闭集里", value: code });
            continue;
        }
        if (!Array.isArray(list)) {
            v.push({ path: code, reason: "值必须是 {macro,weight}[] 数组", value: list });
            continue;
        }
        const seen = new Set();
        let last = Infinity;
        for (let i = 0; i < list.length; i++) {
            const at = `${code}[${i}]`;
            const e = list[i];
            if (!e || typeof e !== "object") {
                v.push({ path: at, reason: "候选项必须是 {macro,weight} 对象", value: e });
                continue;
            }
            if (!names.has(e.macro)) {
                v.push({ path: `${at}.macro`, reason: "macro 不在 MACRO_NAMES 里", value: e.macro });
            }
            if (seen.has(e.macro)) {
                v.push({ path: `${at}.macro`, reason: "同一码下宏重复（去重后再登记）", value: e.macro });
            }
            seen.add(e.macro);
            if (!(typeof e.weight === "number" && Number.isFinite(e.weight) && e.weight > 0)) {
                v.push({ path: `${at}.weight`, reason: "weight 必须是 >0 的有限数", value: e.weight });
            }
            /* 降序：检索取 top-3，乱序会让「确定性 tie-break」变得不可读 */
            if (e.weight > last) {
                v.push({ path: `${at}.weight`, reason: "候选未按 weight 降序排列", value: e.weight });
            }
            last = e.weight;
        }
    }
    return { ok: v.length === 0, violations: v };
}
