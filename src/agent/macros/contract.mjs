/**
 * contract.mjs — 宏技能库的 **ABI 契约**（类型 + 校验 + 规格），不含任何实现。
 *
 * 谁读这个文件：
 *   · A3 / A4  按 MACRO_SPECS 实现宏；`validateXxxArgs()` 是它们的**唯一**入参入口
 *   · A2       按 REMOVES_SPEC / RETURN_ENVELOPE 改 gates
 *   · A6       按 ENDPOINT_RULE 生成调用（LLM 层不许自己拼坐标）
 *   · 任何 lint  `lintNoBareCoords()` 机器检查「宏调用里有没有裸坐标参数」
 *
 * 为什么契约要先于实现定死：
 *   这个项目踩过的坑全是**接口层**的 —— `place{r, rotationVariant}` 里两个参数语义重叠，
 *   于是 `r=90` 得到 code=1 直带（AI-CONTROL-STATUS §2）；43 实体方案 13 个朝向全反
 *   （L4-PLAN-A-REVIEW）；`delete{x,y}` 不认 uid，导致 L4 唯一正解「删 3 带」无法表达。
 *   这些都不是算法错，是**接口允许了错误的调用**。Anthropic 的 poka-yoke 原则：
 *   "Change the arguments so that it is harder to make mistakes."（RESEARCH-B §5.1B）
 *
 * 本文件**零依赖**、无副作用、不读写世界、不读 obs。
 * 纯函数：给定 args 只做结构校验与默认值归一，不做任何存在性判断
 * （"这个 uid 在不在世界里"是运行时的事，属于宏实现，不属于契约）。
 *
 * @version 1
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 坐标三分法 —— 本契约最重要的一条（对应 CONTRACT-MACROS.md §2）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个宏参数属于哪一类。**只有这四类，没有第五类。**
 *
 * - `endpoint`  端点：**指名一个已经存在的东西**（实体 + 槽位）。值必须原样来自 `obs`
 *               的 `entities[].uid`（首选）或 `entities[].x/y`（次选）。宏对它不做算术。
 * - `site`      落点：本次要在哪里**新放**一样东西。**每调用至多一个**，且值必须来自
 *               obs 的既有实体格（即在替换它）或上一个宏的返回值。不是"随便挑个空格"。
 * - `choice`    离散选择：不影响位置、只影响"怎么做"的枚举（`dir` / `facing` / `prefer` /
 *               `port`）。是**方位词**不是角度；给角度（0/90/180/270）一律拒绝。
 * - `computed`  算坐标：值依赖几何才能得出的东西 —— 路径格、转角、rv、槽位格、
 *               footprint 展开格、旋转后的 origin、hub 入口格、距离/格数。
 *               **这类参数一律不得出现在公开 ABI 里**，必须由宏内部算。
 *
 * 判据（可机器检查的口径）：**把一个参数改动 1 格，是在改变"要动哪条东西"，
 * 还是在改变"这条东西怎么走"？** 前者是端点/落点，后者是"怎么做"（choice）
 * 或"走哪儿"（computed）。而 computed 的共同点是 —— **它的合法值取决于世界，
 * 不取决于调用方想表达什么**。`len=4` 不取决于世界（4 就是 4），所以它是 choice，
 * 不是 computed；`at=[4,-13]` 取决于世界（那格必须真有带子），所以是 site。
 *
 * 推论：公开 ABI 里**端点最多 2 个**（connect 的 from/to）、**落点最多 1 个**
 * （insert_machine.at），**computed 一个都不许有**。
 * `lintNoBareCoords()` 按这个上界做机器检查。
 *
 * ### `region` 为什么是 endpoint 而不是 computed（v2 裁定）
 *
 * `replace_run.region` 曾靠 lint 里一份 `cellish` 白名单放行（`region` 出现在名单里），
 * 那等于「契约第一原则给自己开了个后门」。v2 的裁定不是删掉它，而是**证明它属于端点类**：
 *
 *   1. 它是**选集**，不是**推导**：值来自「obs 里被选中的那几条带子的 (min/max x, min/max y)」，
 *      调用方是照着实体列表圈一块，宏**从不计算它**（对比 computed：路径格、solveTurn 的 rv、
 *      footprint 展开格，都是宏算完才存在的东西）。
 *   2. 按可机器检查的判据：把 region 挪 1 格，改变的是「**要动哪些东西**」（端点判据），
 *      不是「这条东西怎么走」（computed / choice）。它和 `connect.to={uid}` 同构，
 *      只是被指名的实体是一组而不是一个。
 *   3. 它不是**被算出来的**数字：`len ≤ 到最近障碍的距离` 那种「你必须先数格子」才是 computed；
 *      `region` 不要求调用方做任何算术 —— 「region 面积 === 带子数」这条由**宏**逐格核对，
 *      不等就拒绝并列出反例（调用方不需要数字符）。
 *
 * 因此 lint **不再维护按参数名的白名单**：坐标容器只有「在 `MACRO_SPECS` 里被声明为
 * endpoint/site 且类型含坐标的那几个参数」才放行，名单从规格表**派生**（见 `lintNoBareCoords`）。
 * 新增一个坐标参数而忘了声明 coordClass，lint 会立刻红 —— 白名单式的豁免不再可能。
 */
export const COORD_CLASSES = Object.freeze(["endpoint", "site", "choice", "computed"]);

/**
 * 公开 ABI 里**禁止出现的参数名**。
 *
 * 理由：这些名字在本仓库里已经有歧义历史 —— `r` 是 rotation 角度、`rotationVariant` 是
 * 带子形态位（0 直 / 1 左弯 / 2 右弯），两者语义**正交**却在 `place` 里并列，且
 * `place{r:90}` 在实机上得到过 code=1 直带（游戏按邻居自动定向覆盖了调用方的意图）。
 * 任何让 LLM 填这几个名字的接口，都是在重复那次事故。
 */
export const FORBIDDEN_ARG_KEYS = Object.freeze([
    "x", "y", "r", "rv", "rot", "rotation", "rotationVariant", "rotation_variant", "originalRotation",
]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 基础类型
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {[number, number]} Cell 世界格 [x, y]（y 向下为正；与游戏一致） */
/** @typedef {"top"|"right"|"bottom"|"left"} Face 世界方位。top=0°,right=90°,bottom=180°,left=270° */
/** @typedef {number} Uid 实体稳定 uid（obs 的 entities[].uid） */

/**
 * @typedef {object} Endpoint
 * @property {Uid}    [uid]   首选：直接指名实体（obs 给的值）
 * @property {Cell}   [cell]  次选：实体 origin 格（obs 给的值）。**不是目的地，是引用**
 * @property {string} [port]  槽位选择；缺省 "auto"。见 PORT_RESOLUTION
 *
 * `uid` 与 `cell` **二选一**，都给且不一致 → 2001 同族错误（不猜）。
 * 两者都不指代一个**已存在的实体**时，运行期报 `endpoint_not_found`。
 */

/**
 * @typedef {object} BoundingBox 闭区间包围盒 [x0,y0,x1,y1]，四边都含
 * @property {number} 0
 * @property {number} 1
 * @property {number} 2
 * @property {number} 3
 */

/** @typedef {[number,number,number,number]} BBox */

/** 槽位选择：
 *  - `"auto"`（缺省）：仅当该端点上候选槽位**恰好 1 个**时合法；
 *    目标端点是 hub 时例外 —— hub 有 16 个入口，`auto` 走入口分配并回报 `chosen_port`。
 *  - 角色名 `"out" | "left" | "right" | "primary" | "lower" | "upper" | "quad0..3"`：
 *    该角色在此实体上必须**唯一**，否则 `ambiguous_port` 并列出候选。
 *  - `{role:string, index:number}`：角色重复时按 index 消歧（如 hub 的 16 个 primary）。
 *  - `{entry:0..15}`：只对 hub 合法。索引顺序 = `op-templates.hubEntriesWorld()` 的输出顺序
 *    （顶排 4 → 底排 4 → 左列 4 → 右列 4）。**这是索引，不是坐标** —— 把"选哪个口"
 *    降成 0..15 的离散选择，正是 pin assignment 该在宏里做的事。
 */
export const PORT_FORMS = Object.freeze(["auto", "role", "{role,index}", "{entry}"]);

/** 宏级错误码。闭集 —— 调用方（LLM / loop）按 code 分支，不按 message 分支。 */
export const ERROR_CODES = Object.freeze({
    unknown_field: "参数里有未定义的键（含被禁的裸坐标键）",
    missing_field: "必填参数缺失",
    bad_type: "参数类型/取值不合法",
    bad_arity: "坐标类参数超过本契约允许的上界（见 COORD_CLASSES）",
    endpoint_not_found: "端点 uid/cell 在当前世界不存在（obs 过期或已被别人删掉）",
    endpoint_not_a_port: "端点存在，但不是能连的端口（没有对应的 ejector/acceptor）",
    ambiguous_port: "端口选择不唯一，必须显式给 port",
    ambiguous_site: "落点能对应多个合法摆法（或反解出的端口不唯一），必须显式消歧",
    port_already_bound: "源端口已经有接收方；再连一条会让旧的饿死",
    target_already_fed: "目标端口已经有供料方",
    /* 2026-11-02 新增。实测（`.tmpverify/ab-density/b7.mjs`，六轮 178 个计划）：
       142 次 `occupied` 里 64 次（45%）是「to 的接收槽长在 from 自己身上」——
       模型的意图（接远处的带子）没错，但那条带的输入端就在源机器占地内。
       原来它会走到 `fits` 才报 `occupied`，错误信息说的是「机器不可覆盖」，
       **没说清真正的问题**。单列一个码，模型才知道该换目标而不是换开关。 */
    to_port_on_source: "目标的接收槽长在源实体自己身上（货会绕回同一台机器）",
    no_path: "在现有障碍下找不到合法路径（不是参数错，是几何不可行）",
    occupied: "目标格被不可替换的建筑占着",
    blocked_by_machine: "footprint 覆盖到机器（宏只替换带子，绝不删机器）",
    not_a_run: "选择里含非带子实体（本宏只处理带子）",
    /* ── remove_machine 的三个专属码（2026-11-03） ──
     *
     * 加这个宏的直接原因：真机实测发现**没有任何宏能移除一台挡路的机器**。
     * 接在铜切割机上的矿机脚下没有矿（永久零产出）且占着 cutter 的输入口，
     * 而 insert_machine 报 blocked_by_machine、connect 的路径被 trash/rotater 挡死。
     *
     * 三个码各自对应一种「不该删」的理由，分开而不是合并成 precondition_failed：
     *   · immutable        —— hub 永不可删（删了这一局就终结）
     *   · not_a_machine    —— 那是带子，应该走 remove_run
     *   · would_starve     —— 它正在给下游供料，删了会饿死别人 */
    immutable: "目标是 hub —— 永不可删",
    not_a_machine: "选集里含带子（本宏只处理机器，带子请用 remove_run）",
    would_starve: "要删的机器正在给下游供料，删了会饿死它们（需 opts.allow_unwired=true）",
    run_not_contiguous: "给的带子不连成一段（通常是选集错了）",
    unsupported_building: "该 building 在本宏的 v1 支持矩阵之外",
    out_of_scope: "超出 v1 范围（多层 / 隧道 / wire / 旋转机器的某一面）",
    tx_unavailable: "mod 未提供事务能力，原子执行不可保证 → 拒绝执行而不是半做",
    precondition_failed: "前置条件不满足（详见 error.detail）",
    partial_apply: "只做成了一部分 —— 事务层失职，必须立刻回滚并上报",
    verification_failed: "落地后读回与计划不一致（first_mismatch 给出第一处）",
    internal: "宏实现内部错误（不该出现；出现即为 bug）",
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1b. warnings 的闭集与分级（v2）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 警告级别。**三档，且每一档都有确定的调用方动作** —— 这是本节的唯一目的：
 * `ok:true` + 非空 warnings 必须是**可判定**的，不能像 v1 那样把
 * `kept-belts`（看一眼就行）与 `rotation_not_live_verified`（根本没实机验证）
 * 混在同一个数组里让 LLM 自己猜。
 *
 * | severity  | 调用方动作 |
 * |-----------|-----------|
 * | `info`    | 可以不读。宏已经按最合理的解释办了（例如 hub 入口是宏自己选的、rv-drift 本就是这个宏的用途）。 |
 * | `warn`    | **必须读**，并且**必须把 detail 里的对象纳入执行计划**（进 tx 的 destroys，或执行后读回自证）。不阻断，但不处理就是漏做了计划的一部分。 |
 * | `error`   | 宏认为「这一单不该算成功」。调用方**必须按 `ok:false` 处理**（停手 / 回滚 / 重规划）。 |
 *             出现 `error` 级警告说明**实现与契约不一致**（契约要求它直接拒绝），
 *             必须在报告里点名，不许当作普通警告消费。 |
 *
 * 判定口径（`worstSeverity`）：一条 `error` 就压过一切；其次 `warn`；没有警告 = `null`。
 */
export const WARNING_SEVERITIES = Object.freeze(["info", "warn", "error"]);

/** severity 的排序权重（仅供 worstSeverity 用） */
const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, error: 2 });

/**
 * warnings[].code 的**闭集**。新增警告必须先在这里登记（含级别与处置），
 * 否则 `validateMacroResult` 判红 —— 与 ERROR_CODES 同一纪律。
 *
 * `canonical:false` 的条目是**实现里已经存在的非规范拼写**（横线/下划线/单复数不统一）。
 * 它们被收进闭集是为了让现有实现仍合法，但**新代码不得使用**；
 * 看到它们时应按 `aliasOf` 指向的规范码理解。合并动作留给实现方（本文件不改实现）。
 */
export const WARNING_CODES = Object.freeze({
    /* ── 「覆盖既有带子」：同一件事，实现里有三种拼写（见下方 alias 条目） ──
     *
     * ★ uid 从哪读，一律以 `changed.removed_uids` 为准（v3 裁定，三宏同形）★
     *
     * 契约口径（实现方必须遵守，见 ROUTING-CONTRACT-DECISION.md）：
     *   · **唯一规范通道**：`changed.removed_uids: Uid[]`（信封字段，见 RETURN_ENVELOPE）。
     *     三个宏在「本单会替换销毁既有带子」时都必须把它填满，且**按格序确定**。
     *   · 本 warning 的 `detail` **只描述人读语义**，不得作为机器读取 uid 的来源；
     *     实现**可以**在 warning 同级附带 `replaced_belt_uids` / `replaced_cells` 作冗余
     *     （便于日志与红队对账），但下游**只许**消费 `changed.removed_uids`。
     *   · 历史单数/下划线别名条目仍在闭集里（实现尚未统一），按 aliasOf 读。
     */
    "replacing-belts": {
        severity: "warn", macro: "connect / insert_machine / trash_unused / replace_run",
        what: "本单会销毁既有带子（allow_replace / replace_belts / replace_belt / replace_run 打开时）",
        action: "把 **`changed.removed_uids`** 里的每个 uid 纳入 tx 的 destroys（这是唯一规范通道，"
            + "不要解析 detail 的格数，也不要读各宏的历史字段名）。可选冗余：同等 warning 上可带 "
            + "`replaced_belt_uids:Uid[]` 与 `replaced_cells:Cell[]`（同序、与 removed_uids 一致）。"
            + "不处理 = 覆盖没有回滚。",
    },
    replacing_belts: {
        severity: "warn", macro: "insert_machine",
        canonical: false, aliasOf: "replacing-belts", deprecated: true,
        what: "（历史拼写）insert_machine 目前实际发出的码：footprint 内有既有带子被替换销毁",
        action: "按 replacing-belts 理解；uid 读 `changed.removed_uids`（该宏另有顶层 `removed_uids` 同值冗余，"
            + "历史字段名，新代码不得依赖）。规范名是 replacing-belts（横线），新代码不得使用本拼写（合并留给实现方）。",
    },
    "replacing-belt": {
        severity: "warn", macro: "trash_unused",
        canonical: false, aliasOf: "replacing-belts", deprecated: true,
        what: "（历史拼写）trash_unused 目前实际发出的码（单数）：opts.replace_belt=true 时喷口格带子被销毁",
        action: "按 replacing-belts 理解；uid 读 `changed.removed_uids`（该宏另有顶层 `replaced_belt_uid:Uid|null`，"
            + "只能有一个值，多格场景会漏）。规范名是 replacing-belts，新代码不得使用本拼写（合并留给实现方）。",
    },

    /* ── connect ── */
    "hub-entry-chosen": {
        severity: "info", macro: "connect",
        what: "to 指向 hub 且没给 entry：宏按「拐角数→格数」自己选了一个入口",
        action: "不需要处理；不想要就显式给 to.port={entry:N}。",
    },
    both_rebind_and_allow_replace: {
        severity: "warn", macro: "connect",
        what: "opts.rebind 与 opts.allow_replace 同时为 true —— 抢口 + 剪旧线，最危险的一次调用",
        action: "确认你就是**整段重铺**（旧口要抢、旧路要剪）；只解其中一个错误码时，"
            + "把另一个关掉再调 —— 它们各自对应 port_already_bound / occupied，不能互相顶替。"
            + "本条不携带 uid：被覆盖的带子读 `changed.removed_uids`（规范通道），"
            + "被抢的旧接收方 uid 读 `error.detail.boundTo` 或重规划，两者不是一件事。",
    },

    /* ── insert_machine ── */
    facing_ignored: {
        severity: "info", macro: "insert_machine",
        what: "机器没有输出槽且不可旋转（trash），facing 无意义被忽略",
        action: "不需要处理。真要接垃圾桶请用 trash_unused（它会检查 outlet 是否真没去处）。",
    },
    input_not_fed: {
        severity: "warn", macro: "insert_machine",
        what: "某个输入槽的带格是空的 —— 没有上游供料，机器放下也不会工作",
        action: "先用 connect 接上游，或换落点；不处理就是放了一台不转的机器。",
    },
    input_belt_wrong_direction: {
        severity: "warn", macro: "insert_machine",
        what: "输入槽的带格上有东西但接不上（方向反了 / 被别的机器占着）",
        action: "执行方必须修（改向或换落点），否则机器不收货。",
    },
    output_not_connected: {
        severity: "warn", macro: "insert_machine",
        what: "某个输出槽的带格是空的 —— 产物没有去处，机器会因出口堵塞停转",
        action: "执行后用 connect/extend_line/trash_unused 接下游；不处理就是放了一台会堵的机器。",
    },
    output_belt_wrong_direction: {
        severity: "warn", macro: "insert_machine",
        what: "输出槽的带格上的带子不从机器接货",
        action: "执行方必须修，否则机器出口堵死。",
    },
    orphaned_upstream: {
        severity: "warn", macro: "insert_machine",
        what: "被替换的带子有上游正朝它喷，而本机在该方向没有输入槽 ⇒ 旧线会堵",
        action: "换落点，或连带改上游（connect/remove_run）。不处理 = 机器能转但旧线剪断。",
    },
    orphaned_downstream: {
        severity: "warn", macro: "insert_machine",
        what: "被替换带子的下游原本从它接货，而本机在该方向没有输出槽 ⇒ 下游断供",
        action: "同上：换落点或连带改下游。",
    },
    starves_downstream: {
        severity: "warn", macro: "remove_machine",
        what: "显式传了 opts.allow_unwired=true，拆掉了正在给下游供料的机器 ⇒ 那些下游会断供",
        action: "这是调用方**明确承认**的后果（默认会被 would_starve 拒掉）。接好替代供料后本警告自然消失。",
    },
    rotation_not_live_verified: {
        severity: "warn", macro: "insert_machine / extend_line",
        what: "r≠0 的槽位公式只有 observed 级凭据（CAPABILITY_ASSUMPTIONS.rotated_machine_slots），且与旧结论冲突",
        action: "落地后**必须**用 obs/debug_items 读回槽位邻接并逐条比对 wiring；任一 mismatch 即回滚并报 verification_failed。",
    },
    wiring_mismatch: {
        severity: "warn", macro: "insert_machine",
        what: "有槽位的 status=mismatch —— 机器放下去了，但某些口物理上接不上（见 wiring[]）",
        action: "可以执行（机器确实放得下），但**执行前必须修**（改向/换落点/连带改线）；"
            + "不修就是放了一台部分死口的机器。执行后仍 mismatch ⇒ 按 verification_failed 回滚。",
        note: "与 replace_run 的对比（v2 裁定，取代旧的「任一 mismatch 即 ok=false」invariant）："
            + "insert_machine 的落点可能「现在没接、下一步再接」（典型：先放机器再 trash_unused），"
            + "所以它只警告；replace_run 是**定点改造一整段线**，改造完就该是通的，"
            + "所以它对 orphaned-output 直接 precondition_failed。两者不是同一个语义，不要互相抄。",
    },
    world_unknown_entities: {
        severity: "info", macro: "insert_machine",
        what: "footprint 邻接的建筑不在 op-templates，其占地按 1×1 保守假设",
        action: "通常不需要处理；落点检查可能因此漏判，风险自负。",
    },
    terminal_orphaned: {
        severity: "warn", macro: "extend_line",
        what: "延长后的末端指向的格没有接收方 —— 死端",
        action: "要接到具体目标请改用 connect；不处理 = 一条断头带（货会堵在末端）。",
    },

    /* ── remove_run ── */
    "would-disconnect": {
        severity: "warn", macro: "remove_run",
        what: "删除会让若干既有链接断开（orphaned_outputs / starved_belts / starved_machines）",
        action: "**报告不拒绝**。执行后必须立刻用 insert_machine / trash_unused 补上断点，不许停在中间态。",
    },
    "stranded-items-unknown": {
        severity: "info", macro: "remove_run",
        what: "宏零写操作、不读 debug_items，被删带子上的在途物品数无法离线确定（stranded_items=null）",
        action: "不需要处理；要在计划里写死这个数，执行前自己读一次 debug_items。",
    },

    /* ── replace_run ── */
    "rv-drift": {
        severity: "info", macro: "replace_run",
        what: "现有 (r,rv) 与邻居反解不符 —— 这正是 building=\"belt\" 路径的用途",
        action: "不需要处理；执行 tx 后逐格读回 code（1+rv），不等即 verification_failed。",
    },
    "variant-unverified": {
        severity: "warn", macro: "replace_run",
        what: "该机器变体的槽位映射未实机验证（op-templates.verifiedOnLive=false）",
        action: "执行后必须用 debug_items 读回 boundAcceptor 自证，不等即失败。",
    },
    "kept-belts": {
        severity: "warn", macro: "replace_run",
        what: "region 内有带子没被任何新建筑占到，原样保留",
        action: "**执行前逐条确认它们确实该留下**（它们是新机器的下游/上游时才对）；"
            + "这是有意的保留，不是漏删 —— 但也可能是 region 圈太大。",
    },
    "internal-trash-offset": {
        severity: "error", macro: "replace_run",
        what: "trash 落点与输出槽喷口不一致（trash 偏一格就完全收不到货）",
        action: "按 ok:false 处理并上报 —— 这是宏的 bug，不是调用错。",
    },
    "cut-upstream-feeds": {
        severity: "warn", macro: "replace_run",
        what: "既有带子的出口指向本次改造的格，而那一格现在是新机器的**机身**（没有朝它的输入槽）"
            + "—— 货被机身吃掉，是真断线（E2E §3.5 实测：10148@(5,-12)→(5,-13)，cutter 2×1 的第二格）",
        action: "执行前必须承认这条断线：要么把 region/机器朝向挪到让那一侧成为输入槽，"
            + "要么把这些带子一起纳入改造。"
            + "级别是 warn 而不是 error：L4 的正解本身就必然剪断 10148（2×1 机器的第二格就是机身），"
            + "把它判成 error 等于禁止唯一正解 —— 与 remove_run 的 would-disconnect 同一口径：**报告，不阻止**。",
    },
    "consumed-by-machine": {
        severity: "info", macro: "replace_run",
        what: "既有带子的出口正好落在新机器的输入槽槽格上 —— 货被机器接力吃进去，是**合法**的",
        action: "不需要处理。这条 warning 的作用是把「接力」与上面那条「被机身吃掉」在日志里分开。",
    },
    "trash-cuts-chain": {
        severity: "warn", macro: "replace_run",
        what: "confirm_waste=true 已签字：trash 会永久销毁一条**仍在供货**的链"
            + "（喷口格上的带子还有下游；detail 列出被剪的 uid→下游）",
        action: "这是目标形状要求的销毁（E2E §4 V9 的形态）。把被剪断的 uid 与在途物品纳入 plan 的 destroys；"
            + "不签字时宏会直接拒绝（precondition_failed），所以出现本条 = 你确实签过字。"
            + "签了字不等于可以不留痕。",
    },

    /* ── trash_unused 目前发的 "replacing-belt" 与顶部 alias 同一条（见 WARNING_CODES 开头） ── */
});

/**
 * warnings[] 里**不该出现**的码：它们只在 `plan.sideEffects[]` 里出现
 * （remove.mjs 的 `pick.plan.sideEffects` / replace_run 的 extras.sideEffects）。
 * 收在这里是为了让「实现里出现的 code」都能被机器归类，而不是让测试对它们视而不见。
 */
export const SIDE_EFFECT_CODES = Object.freeze({
    "kept-belt-starved": { what: "region 内保留的带子执行后没有上游（会空转）" },
    "kept-belt-dead-end": { what: "region 内保留的带子执行后没有下游（会堵）" },
    "starved-belt": { what: "与删除格相邻的既有带子执行后失去上游" },
});

/** 该 code 是否是规范拼写（false = 实现里的历史写法，只许读不许写） */
export function isCanonicalWarningCode(code) {
    const e = WARNING_CODES[code];
    return !!(e && e.canonical !== false);
}

/** @param {Array<{code:string,severity?:string}>} warnings */
export function worstSeverity(warnings) {
    let worst = null;
    for (const w of warnings || []) {
        const declared = (WARNING_CODES[w.code] || {}).severity;
        const s = w.severity || declared;
        if (!s) continue;
        if (worst === null || SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
    }
    return worst;
}

/**
 * 「ok:true 且最高级别是 X」时调用方该做什么 —— 单一入口，LLM 只读这一段。
 * @returns {{severity:string|null, ok:boolean, action:string}}
 */
export function warningVerdict(warnings) {
    const s = worstSeverity(warnings);
    if (s === "error") {
        return {
            severity: s, ok: false,
            action: "按 ok:false 处理：停手 / 回滚 / 重规划。error 级警告表示实现与契约不一致（契约要求直接拒绝）。",
        };
    }
    if (s === "warn") {
        return {
            severity: s, ok: true,
            action: "可以执行，但必须把每条 warn 的 detail 对象纳入计划（进 tx destroys、或执行后读回自证），否则这一单是半成品。",
        };
    }
    if (s === "info") {
        return { severity: s, ok: true, action: "可以执行，警告可忽略。" };
    }
    return { severity: null, ok: true, action: "没有警告，按计划执行。" };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 校验工具（纯函数）
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {{code:string, field:string|null, message:string, hint?:string, candidates?:any[]}} MacroError */
/** @typedef {{ok:true, error:null, value:any} | {ok:false, error:MacroError, value:null}} Validation */

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = v => typeof v === "number" && Number.isInteger(v);
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isFace = v => v === "top" || v === "right" || v === "bottom" || v === "left";
const isCell = v => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
const isBBox = v => Array.isArray(v) && v.length === 4 && v.every(isInt)
    && v[0] <= v[2] && v[1] <= v[3];

/** @returns {Validation} */
const ok = value => ({ ok: true, error: null, value });
/** @returns {Validation} */
const fail = (code, field, message, hint) => ({
    ok: false,
    error: { code, field, message, ...(hint ? { hint } : {}) },
    value: null,
});

/**
 * 统一收口：未知字段一律报错（不静默忽略）。
 * 与 mod 的 `validateAction()` 同一条纪律（PROTOCOL §5「未知字段/未知 op 一律 2001」）。
 */
function rejectUnknownKeys(args, allowed, macro) {
    for (const k of Object.keys(args)) {
        if (k === "op" || k === "macro") continue;
        if (!allowed.includes(k)) {
            if (FORBIDDEN_ARG_KEYS.includes(k)) {
                return fail("unknown_field", k,
                    `${macro} 不接受裸坐标参数 '${k}'`,
                    `坐标必须由宏内部计算。端点请用 uid（来自 obs.entities[].uid）；`
                    + `点位的选择只能通过端点/落点参数表达。见 CONTRACT-MACROS.md §2`);
            }
            return fail("unknown_field", k,
                `${macro} 不认识参数 '${k}'`,
                `允许的参数：${allowed.join(", ")}`);
        }
    }
    return null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2b. 计划态实体引用（PendingRef）—— 让宏在**没有落盘**时也能串接
 *
 * 问题：宏是纯规划器，`insert_machine` 的产物没有 uid（uid 由 tx 分配）。
 * 于是 `insert_machine → trash_unused` 这条链在计划态断掉：`uid:null` 喂不进
 * `outlet.uid`（contract 要求 uid>=0）。验收实测就是这么断的（E2E §2）。
 *
 * 解法：让会放东西的宏额外返回一个**自描述**的 `pending` 引用 —— 它带着
 * footprint 与每个槽位的世界格/面。下游宏**不需要世界里有它**就能按几何解析
 * （trash_unused 只需要知道「哪个槽、喷口哪一格」）。要把它折进世界（例如让
 * remove_run 按 cell 删掉它、或让 connect 看到它占地），用 `applyToWorld()`。
 *
 * 为什么不是「合成 uid」：负数 uid 会在 intent.removes[].expect 里变成假身份。
 * pending 是**显式的计划态**，跨过 applyToWorld 才获得 uid。
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {object} PendingRef 计划态实体（尚未落盘） */
export const PENDING_REF_SPEC = Object.freeze({
    pending: "true —— 标识这是计划态实体引用，不是 uid/cell/hub",
    token: "string —— 稳定标识（宏名@origin），applyToWorld 后按它找回合成 uid",
    macro: "string —— 产生它的宏",
    kind: "string —— 建筑/带子类型（cutter/trash/belt…）",
    variant: "string",
    rotation: "0|90|180|270",
    origin: "[x,y] —— 机器 origin / 带子格",
    cells: "[[x,y]…] —— footprint 的世界格（确定序：先 y 再 x）",
    ports: "{in:[{role,index,cell,dir}], out:[…]} —— 槽位的世界格与面",
    uid: "null | int —— 只有 applyToWorld 之后才有值（负数是合成 uid，不是游戏 uid）",
});

/** 结构判定（不判存在性）。下游宏用它决定走哪条解析路径。 */
export function isPendingRef(v) {
    return isObj(v)
        && v.pending === true
        && typeof v.token === "string" && v.token.length > 0
        && typeof v.kind === "string"
        && isCell(v.origin)
        && Array.isArray(v.cells) && v.cells.length > 0 && v.cells.every(isCell)
        && isObj(v.ports) && Array.isArray(v.ports.in) && Array.isArray(v.ports.out);
}

/**
 * 端点校验（结构层）：uid / cell / hub / pending 四选一。
 * **不判断存在性** —— 那是运行时（宏实现）的事。
 */
function validateEndpoint(v, field) {
    /* 直接传上一个宏的 `pending`（整个对象，不是 {pending:…}）也算端点 ——
       这是「宏能组合」最自然的写法：
           const a = insert_machine(...);  trash_unused({ outlet: a.pending })
       要求调用方再包一层 {pending: …} 是纯粹的形式税，而且两条写法都必须认，
       否则同一个值在两种拼法下行为不同。 */
    if (isPendingRef(v)) {
        if (v.port !== undefined) {
            const p = validatePort(v.port, `${field}.port`);
            if (!p.ok) return p;
        }
        return ok({ pending: v, ...(v.port !== undefined ? { port: v.port } : { port: "auto" }) });
    }
    if (!isObj(v)) {
        return fail("bad_type", field,
            `${field} 必须是 {uid} / {cell:[x,y]} / {hub:{...}} / {pending:PendingRef} 形式的端点对象`,
            "端点指名一个**已存在**的实体（或上一个宏返回的 pending）。obs.entities[] 里能直接拿 uid。");
    }
    /* ⚠️ uid === null 必须当成「没给」：PendingRef 的 uid 在计划态恒为 null
       （uid 由 tx 分配）。把它算成「给了 uid」会让 pending 端点永远 bad_type ——
       这正是「宏不能组合」的第二种形态。 */
    const hasUid = v.uid !== undefined && v.uid !== null;
    const hasCell = v.cell !== undefined;
    const hasHub = v.hub !== undefined;
    const hasPending = v.pending !== undefined;
    const n = [hasUid, hasCell, hasHub, hasPending].filter(Boolean).length;
    if (n !== 1) {
        return fail("bad_type", field,
            `${field} 必须在 uid / cell / hub / pending 中**恰好给一个**（现在给了 ${n} 个）`,
            "同时给多个时宏无法判断你想要哪个 —— 与 place 的 rv/orig 别名冲突同一类错误。");
    }
    const port = v.port;
    if (port !== undefined) {
        const p = validatePort(port, `${field}.port`);
        if (!p.ok) return p;
    }
    for (const k of Object.keys(v)) {
        if (!["uid", "cell", "hub", "pending", "port"].includes(k)) {
            return fail("unknown_field", `${field}.${k}`, `${field} 不认识键 '${k}'`);
        }
    }
    if (hasPending && !isPendingRef(v.pending)) {
        return fail("bad_type", `${field}.pending`,
            `${field}.pending 不是合法的计划态引用`,
            "直接把上一个宏返回值里的 `.pending` 传进来，不要自己拼字段（它带 footprint 与槽位世界格）。");
    }
    if (hasUid && !isInt(v.uid)) {
        return fail("bad_type", `${field}.uid`, `${field}.uid 必须是整数（obs 的 uid）`, `实得 ${JSON.stringify(v.uid)}`);
    }
    if (hasUid && v.uid < 0) {
        return fail("bad_type", `${field}.uid`, `${field}.uid 必须 >= 0`, `实得 ${v.uid}`);
    }
    if (hasCell && !isCell(v.cell)) {
        return fail("bad_type", `${field}.cell`,
            `${field}.cell 必须是 [x,y] 整数对`,
            "cell 是**对既有实体 origin 的引用**，不是你可以随意填的目的地。");
    }
    const hubRef = hasHub ? v.hub : null;
    if (hasHub) {
        const h = v.hub;
        if (!isObj(h) || Object.keys(h).some(k => !["uid", "cell", "entry"].includes(k))) {
            return fail("bad_type", `${field}.hub`, `${field}.hub 只允许 {uid?} / {cell?} / {entry?:0..15}`);
        }
        if (h.entry !== undefined && !(isInt(h.entry) && h.entry >= 0 && h.entry <= 15)) {
            return fail("bad_type", `${field}.hub.entry`, `hub.entry 必须是 0..15 的整数`,
                "索引顺序 = op-templates.hubEntriesWorld() 输出顺序（顶4 底4 左4 右4）");
        }
    }
    return ok({
        ...(hasUid ? { uid: v.uid } : {}),
        ...(hasCell ? { cell: [v.cell[0], v.cell[1]] } : {}),
        ...(hasHub ? { hub: { ...hubRef } } : {}),
        ...(hasPending ? { pending: v.pending } : {}),
        ...(port !== undefined ? { port } : { port: "auto" }),
    });
}

function validatePort(port, field) {
    if (port === "auto") return ok("auto");
    if (typeof port === "string") {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(port)) {
            return fail("bad_type", field, `${field} 角色名必须是小写标识符`, `实得 ${JSON.stringify(port)}`);
        }
        return ok(port);
    }
    if (isObj(port)) {
        const keys = Object.keys(port);
        if (keys.length === 1 && keys[0] === "entry") {
            if (!(isInt(port.entry) && port.entry >= 0 && port.entry <= 15)) {
                return fail("bad_type", `${field}.entry`, `${field}.entry 必须是 0..15 的整数`);
            }
            return ok({ entry: port.entry });
        }
        if (keys.every(k => k === "role" || k === "index")) {
            if (typeof port.role !== "string" || !isInt(port.index) || port.index < 0) {
                return fail("bad_type", field, `${field} 的 {role,index} 需要 role:string + index:>=0 整数`);
            }
            return ok({ role: port.role, index: port.index });
        }
        return fail("bad_type", field, `${field} 只允许 {role,index} 或 {entry}`);
    }
    return fail("bad_type", field, `${field} 必须是 "auto" | 角色名 | {role,index} | {entry}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 六个宏的入参校验
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * connect(from, to, opts?)
 *
 * 从 from 的某个 ejector 连一条带到 to 的某个 acceptor。路径、转角、每格 (rotation, rv)、
 * 以及失败时的 rip-up，全部在内部完成 —— 调用方一个坐标都不给。
 *
 * @param {{from:Endpoint, to:Endpoint, opts?:object}} args
 * @returns {Validation} value = 归一后的 {from, to, opts}
 */
export function validateConnectArgs(args) {
    const A = "connect";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["from", "to", "opts"], A);
    if (unk) return unk;
    if (args.from === undefined) return fail("missing_field", "from", `${A} 缺 from`);
    if (args.to === undefined) return fail("missing_field", "to", `${A} 缺 to`);

    const from = validateEndpoint(args.from, "from");
    if (!from.ok) return from;
    const to = validateEndpoint(args.to, "to");
    if (!to.ok) return to;

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    const allowed = ["rebind", "allow_replace", "max_cells", "prefer", "dry_run"];
    for (const k of Object.keys(opts)) {
        if (!allowed.includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }
    if (opts.rebind !== undefined && typeof opts.rebind !== "boolean") {
        return fail("bad_type", "opts.rebind", "rebind 必须是布尔");
    }
    if (opts.allow_replace !== undefined && typeof opts.allow_replace !== "boolean") {
        return fail("bad_type", "opts.allow_replace", "allow_replace 必须是布尔");
    }
    if (opts.dry_run !== undefined && typeof opts.dry_run !== "boolean") {
        return fail("bad_type", "opts.dry_run", "dry_run 必须是布尔");
    }
    if (opts.max_cells !== undefined && !(isInt(opts.max_cells) && opts.max_cells >= 1 && opts.max_cells <= 5000)) {
        return fail("bad_type", "opts.max_cells", "max_cells 必须是 1..5000 的整数",
            "默认 2000。超过这个量级说明不是「连一条线」，是该用 build_line。");
    }
    if (opts.prefer !== undefined && !["shortest", "fewest_turns", "reuse_existing"].includes(opts.prefer)) {
        return fail("bad_type", "opts.prefer",
            `prefer 必须是 shortest | fewest_turns | reuse_existing`, `实得 ${JSON.stringify(opts.prefer)}`);
    }

    /* 同一个端点的同一个端口不能自己连自己 */
    const same = (a, b) => (a.uid !== undefined && b.uid !== undefined && a.uid === b.uid)
        || (a.cell !== undefined && b.cell !== undefined && a.cell[0] === b.cell[0] && a.cell[1] === b.cell[1]);
    if (same(from.value, to.value) && from.value.port === to.value.port) {
        return fail("precondition_failed", "to",
            "from 与 to 是同一个实体的同一个端口",
            "自连没有物理意义。若想让货绕回来，源和宿必须是不同实体。");
    }

    return ok({
        from: from.value,
        to: to.value,
        opts: {
            rebind: opts.rebind === true,
            allow_replace: opts.allow_replace === true,
            max_cells: opts.max_cells === undefined ? 2000 : opts.max_cells,
            prefer: opts.prefer === undefined ? "fewest_turns" : opts.prefer,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * insert_machine(at, facing, machine, opts?)
 *
 * 在 at 放一台机器，朝向 facing。footprint、rotation、旋转后的 origin、槽位世界格全部内部算。
 *
 * `at` 的确切语义（**v2 定死：一种形状，一种算术**）：
 *   游戏里 `place{x,y,r}` 的 x/y 就是 `origin`，而 `getTileSpaceBounds()` 在 r=180/270 时让
 *   **可见 bbox** 向负方向长，origin 本身**不动**。所以「机器站上去的任意一格」在 r≠0 时
 *   可能对应 1~2 个 origin。v1 曾把两种意图拆成两种形状（`[x,y]` = origin / `{cell}` = 任意格），
 *   结果**默认形状恰好是错的那个**：obs 给的是 x/y，LLM 会天然填 `[x,y]`，而真实意图
 *   （「在这条带上插一台」）对应的是 `{cell}`。v2 的裁定：
 *     · **推荐且唯一有名字的形态是 `at:{cell:[x,y]}`** —— 「机器要占的其中一格」，
 *       那颗格通常是 obs 里那条带子的格。宏按 footprint 反解 origin：
 *       唯一解 → 采用；多解但**只有一解让这一格成为机器的输入槽槽格** → 采用并回报 `site.chosen_by`；
 *       仍多解 → `ambiguous_site` 并列出候选（不猜）。
 *     · `[x,y]` 裸数组**仍然接受**（向后兼容，且它是 obs `entities[].x/y` 的字面值），
 *       语义 = 「这就是 origin」，宏不做算术。两者**不做同一个算术**，所以归一化结果里
 *       必须带 `kind` 区分（`"any-cell"` / `"origin"`），实现按 kind 分支，不许自己嗅形状。
 *     · 万一你只想「换掉 obs 里那台机器」，用 `origin` 形态最省事（无需反解）；
 *       想「在这条带上插一台」，用 `{cell}` —— 这是两者的**唯一选择口径**。
 *
 * `facing` 的定义（最容易被误用，故写死）：
 *   **机器 primary output 喷射的**世界方向。不是 `place.r`、不是输入来向、不是 rv。
 *   rotation 由 `rotate(模板.primaryOutputDir, r) === facing` 反解。
 *   例：cutter 的 primary output 在局部是 top，所以 facing="top" ⇒ r=0；
 *       painter(default) 的 primary output 在局部是 right，所以 facing="right" ⇒ r=0。
 *   两者 r 都是 0 但世界流向不同 —— 这正是"facing 不是 r"的证明。
 *
 * `facing` 的必填性（v2 统一成**一处**判据，schema / 文档 / 运行期三处一致）：
 *   `required` 取决于**机器**，不取决于这个参数本身 —— 所以 params 里写 `required:false`，
 *   必填性由下面这条规则在运行期判定，并且 `MACRO_SPECS.insert_machine.paramRules` 里
 *   用同一句话机器可读地重复一遍（契约测试会核对三处文本一致）：
 *   **「有输出槽且可旋转」的机器 facing 必填（缺失 → ambiguous_site）；其余（trash 这类
 *   无输出 + 不可旋转，或几何四向等价）可省略，省略后宏取 r=0 并回报 `facing_ignored`。**
 *
 * @param {{at:Cell|{cell:Cell,part?:"any"}, facing?:Face, machine:string|{kind:string,variant?:string}, opts?:object}} args
 * @returns {Validation}
 */
export function validateInsertMachineArgs(args) {
    const A = "insert_machine";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["at", "facing", "machine", "opts"], A);
    if (unk) return unk;

    if (args.at === undefined) return fail("missing_field", "at", `${A} 缺 at`);
    let at = null;
    if (isCell(args.at)) {
        at = { kind: "origin", cell: [args.at[0], args.at[1]] };
    } else if (isObj(args.at)) {
        for (const k of Object.keys(args.at)) {
            if (!["cell", "part"].includes(k)) {
                return fail("unknown_field", `at.${k}`, `${A}.at 不认识键 '${k}'`);
            }
        }
        if (!isCell(args.at.cell)) {
            return fail("bad_type", "at.cell", `${A}.at.cell 必须是 [x,y] 整数对`);
        }
        if (args.at.part !== undefined && args.at.part !== "any") {
            return fail("bad_type", "at.part", `${A}.at.part 只接受 "any"`,
                "v1 只支持「机器要占的其中任意一格」这一种反解。");
        }
        at = { kind: "any-cell", cell: [args.at.cell[0], args.at.cell[1]] };
    } else {
        return fail("bad_type", "at",
            `${A}.at 必须是 [x,y]（= 机器 origin）或 {cell:[x,y]}（机器要占的任意一格）`,
            "两种形态语义不同，不能用同一形状表达：前者宏不做算术，后者要反解 origin（可能多解）。");
    }

    if (args.machine === undefined) return fail("missing_field", "machine", `${A} 缺 machine`);
    let kind = null, variant = "default";
    if (typeof args.machine === "string") {
        kind = args.machine;
    } else if (isObj(args.machine)) {
        for (const k of Object.keys(args.machine)) {
            if (!["kind", "variant"].includes(k)) {
                return fail("unknown_field", `machine.${k}`, `${A}.machine 不认识 '${k}'`);
            }
        }
        kind = args.machine.kind;
        variant = args.machine.variant === undefined ? "default" : args.machine.variant;
        if (typeof variant !== "string") return fail("bad_type", "machine.variant", "machine.variant 必须是字符串");
    } else {
        return fail("bad_type", "machine", `${A}.machine 必须是字符串或 {kind,variant}`);
    }
    if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(kind)) {
        return fail("bad_type", "machine", `${A}.machine(kind) 必须是小写建筑标识（如 "cutter"）`, `实得 ${JSON.stringify(kind)}`);
    }

    if (args.facing !== undefined && !isFace(args.facing)) {
        return fail("bad_type", "facing",
            `${A}.facing 必须是 top|right|bottom|left`,
            "facing = primary output 的世界喷射方向。**不是角度、不是 r、不是 rotationVariant。**"
            + "不要把 0/90/180/270 填进来。");
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["replace_belts", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.replace_belts !== undefined && typeof opts.replace_belts !== "boolean") {
        return fail("bad_type", "opts.replace_belts", "replace_belts 必须是布尔",
            "缺省 true：insert 的本义就是「就地插进一段带子」，带子让位给机器；"
            + "机器（不可替换建筑）永远会被 blocked_by_machine 挡住，与这个开关无关。");
    }

    return ok({
        at,
        facing: args.facing === undefined ? null : args.facing,
        machine: { kind, variant },
        opts: {
            replace_belts: opts.replace_belts !== false,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * remove_run(uids | cells, opts?)
 *
 * 删掉一段带子。**uid 优先**：cells 只是拿不到 uid 时的次选，且必须是 obs 里真实存在的
 * 带子格；任何一格解析到机器就整单拒绝（不"尽量删"）。
 *
 * @param {{uids?:Uid[], cells?:Cell[], opts?:object}} args
 * @returns {Validation}
 */
export function validateRemoveRunArgs(args) {
    const A = "remove_run";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["uids", "cells", "opts"], A);
    if (unk) return unk;

    const hasUids = args.uids !== undefined;
    const hasCells = args.cells !== undefined;
    if (hasUids === hasCells) {
        return fail(hasUids ? "bad_type" : "missing_field", hasUids ? "cells" : "uids",
            `${A} 必须在 uids 与 cells 中**恰好给一个**`,
            "uid 稳定且精确（obs.entities[].uid）；cells 会随世界变化而漂移。优先 uid。");
    }

    let uids = null, cells = null;
    if (hasUids) {
        if (!Array.isArray(args.uids) || args.uids.length === 0) {
            return fail("bad_type", "uids", `${A}.uids 必须是非空数组`);
        }
        if (!args.uids.every(u => isInt(u) && u >= 0)) {
            return fail("bad_type", "uids", `${A}.uids 必须全是 >=0 的整数 uid`);
        }
        const seen = new Set();
        for (const u of args.uids) {
            if (seen.has(u)) {
                return fail("bad_type", "uids", `${A}.uids 有重复 uid ${u}`,
                    "重复通常是拼接选集时的 bug；去重后再调用。");
            }
            seen.add(u);
        }
        uids = [...args.uids];
    } else {
        if (!Array.isArray(args.cells) || args.cells.length === 0) {
            return fail("bad_type", "cells", `${A}.cells 必须是非空数组`);
        }
        if (!args.cells.every(isCell)) {
            return fail("bad_type", "cells", `${A}.cells 必须全是 [x,y] 整数对`);
        }
        const seen = new Set();
        for (const c of args.cells) {
            const k = `${c[0]},${c[1]}`;
            if (seen.has(k)) return fail("bad_type", "cells", `${A}.cells 有重复格 ${k}`);
            seen.add(k);
        }
        cells = args.cells.map(c => [c[0], c[1]]);
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["allow_scattered", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.allow_scattered !== undefined && typeof opts.allow_scattered !== "boolean") {
        return fail("bad_type", "opts.allow_scattered", "allow_scattered 必须是布尔");
    }

    return ok({
        ...(uids ? { uids } : { cells }),
        opts: {
            allow_scattered: opts.allow_scattered === true,
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * extend_line(from, len, dir?)
 *
 * 从 `from`（一段带子的**末端**，或一台机器的输出口）沿 dir 再接 len 格。
 * 首格位置由 from 的出口算，调用方不给坐标。
 *
 * @param {{from:Endpoint, len:number, dir?:Face, opts?:object}} args
 * @returns {Validation}
 */
export function validateExtendLineArgs(args) {
    const A = "extend_line";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["from", "len", "dir", "opts"], A);
    if (unk) return unk;

    if (args.from === undefined) return fail("missing_field", "from", `${A} 缺 from`);
    const from = validateEndpoint(args.from, "from");
    if (!from.ok) return from;

    if (args.len === undefined) return fail("missing_field", "len", `${A} 缺 len`);
    if (!(isInt(args.len) && args.len >= 1 && args.len <= 500)) {
        return fail("bad_type", "len", `${A}.len 必须是 1..500 的整数`, `实得 ${JSON.stringify(args.len)}`);
    }
    if (args.dir !== undefined && !isFace(args.dir)) {
        return fail("bad_type", "dir",
            `${A}.dir 必须是 top|right|bottom|left`,
            "dir 是**世界方向**。不给则沿用 from 当前出口方向（直行）。");
    }
    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["dry_run"].includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }

    return ok({
        from: from.value,
        len: args.len,
        dir: args.dir === undefined ? null : args.dir,
        opts: { dry_run: opts.dry_run === true },
    });
}

/**
 * replace_run(region, building, opts?)
 *
 * 把 #region 内的带子**原位换成另一种建筑**。
 *
 * `building` 三种形态（**这是唯一真值**，实现与文档都以此为准）：
 *   · `"belt"`                      → 原位换带，逐格保持 entry/exit 拓扑（用途：修复被游戏重算坏的 rv）。
 *                                     region 内**每格都必须是带子**；有空格 → precondition_failed。
 *   · `"cutter"` / `{kind,variant?}` → 换 1 台机器。region 内**可以有空格**（它只是框一块地），
 *                                     但不许有机器/hub；机器按 footprint 展开，被覆盖的带子删掉，
 *                                     没被覆盖的**原样保留**并在 warnings 里报 `kept-belts`。
 *   · `[...]`                       → 机器数组，给「1 台主动机器 + 它的垃圾桶」用（L4 就是这个形态）。
 *                                     数组里**恰好 1 台主动机器**（有输出槽的），其余只能是 trash；
 *                                     每台 trash **必须**点名 port（宏绝不猜哪一路是废料）。
 *
 * 两条路径的差异是**有意设计**，写死在这里而不是靠测试反推：
 *   带路径要求「每格都是带子」（它要复用每格 rv）；机器路径要求「是带子或空格、不是机器」
 *   （它要能圈一块含空地的断口）。两者都拒绝机器 —— 那是误删 42 实体那次事故的形态。
 *
 * @param {{region:BBox, building:string|{kind:string,variant?:string,port?:string,confirm_waste?:boolean}|Array, opts?:object}} args
 * @returns {Validation}
 */
export function validateReplaceRunArgs(args) {
    const A = "replace_run";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["region", "building", "opts"], A);
    if (unk) return unk;

    if (args.region === undefined) return fail("missing_field", "region", `${A} 缺 region`);
    if (!isBBox(args.region)) {
        return fail("bad_type", "region",
            `${A}.region 必须是闭区间包围盒 [x0,y0,x1,y1]，且 x0<=x1, y0<=y1`,
            "region 指名的是 obs 里**已被选中的那几条带子**（取它们的 min/max 坐标），"
            + "不是让你算出来的落点。宏会逐格核对（带子路径要求每格都是带、机器路径不许有机器）。");
    }
    if (args.building === undefined) return fail("missing_field", "building", `${A} 缺 building`);

    /* 三种形态归一成统一的 specs 数组；`beltOnly` 标记走契约原义的带路径 */
    const rawList = Array.isArray(args.building) ? args.building : [args.building];
    if (rawList.length === 0) {
        return fail("bad_type", "building", `${A}.building 不能是空数组`,
            '给一台机器（"cutter"）或一列建筑（["cutter", {kind:"trash", port:"left"}]）。');
    }
    const specs = [];
    for (let i = 0; i < rawList.length; i++) {
        const at = rawList.length > 1 ? `building[${i}]` : "building";
        const x = rawList[i];
        if (typeof x === "string") {
            if (!/^[a-z][a-z0-9_]{0,31}$/.test(x)) {
                return fail("bad_type", at, `${at} 必须是小写建筑标识`, `实得 ${JSON.stringify(x)}`);
            }
            /* 数组里不允许再出现 "belt"：那会和字符串形态的语义（逐格反解 rv）混起来。 */
            if (rawList.length > 1 && x === "belt") {
                return fail("bad_type", at,
                    `${A}.building 数组里不能再出现 "belt"`,
                    '带子形态必须整个参数就是 "belt"（它走逐格 rv 反解）；'
                    + "机器数组只列机器与 trash。");
            }
            /* 结构上就能判死的两种建筑（不依赖存档），字符串形态也要在这里拦住 —— 否则
               `building:"underground_belt"` 会绕过下面对象分支的检查，变成「契约说拒、校验器放过」。 */
            if (x === "underground_belt") {
                return fail("unsupported_building", at,
                    "隧道需要 sender/receiver 成对建模，v1 范围外",
                    "明确报错而不是静默降级 —— 逐格替换隧道会得到一半的隧道。");
            }
            if (x === "hub") {
                return fail("unsupported_building", at,
                    "hub 不能被 replace_run 放置",
                    "hub 是固定目标（16 入口），不参与改造；要接线用 connect 到 hub。");
            }
            specs.push({ kind: x, variant: "default" });
            continue;
        }
        if (!isObj(x)) {
            return fail("bad_type", at,
                `${at} 必须是字符串或 {kind, variant?, port?, confirm_waste?}`,
                '例如 "cutter" 或 {kind:"trash", port:"left", confirm_waste:true}。');
        }
        for (const k of Object.keys(x)) {
            if (!["kind", "variant", "port", "confirm_waste"].includes(k)) {
                return fail("unknown_field", `${at}.${k}`, `${at} 不认识键 '${k}'`,
                    "允许：kind, variant, port, confirm_waste。坐标一律不给 —— 落点由 region 与建筑几何内部解。");
            }
        }
        if (typeof x.kind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(x.kind)) {
            return fail("bad_type", `${at}.kind`, `${at}.kind 必须是小写建筑标识`,
                `例如 "cutter"、"trash"；实得 ${JSON.stringify(x.kind)}。`);
        }
        if (x.variant !== undefined && typeof x.variant !== "string") {
            return fail("bad_type", `${at}.variant`, `${at}.variant 必须是字符串`, "缺省 default。");
        }
        if (x.port !== undefined && (typeof x.port !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(x.port))) {
            return fail("bad_type", `${at}.port`, `${at}.port 必须是槽位角色名（如 "left"）`,
                "它是 choice 不是坐标；{role,index} 形态在 replace_run 里不支持（trash 的输出槽角色唯一）。");
        }
        if (x.confirm_waste !== undefined && typeof x.confirm_waste !== "boolean") {
            return fail("bad_type", `${at}.confirm_waste`, `${at}.confirm_waste 必须是布尔`);
        }
        /* 这两个是**结构上就能判死**的（不依赖存档）：隧道要 sender/receiver 成对，hub 是固定目标。
           放在校验器里而不是只留给运行期，是为了让「契约声明」与「最先拒绝的地方」是同一处。 */
        if (x.kind === "underground_belt") {
            return fail("unsupported_building", `${at}.kind`,
                "隧道需要 sender/receiver 成对建模，v1 范围外",
                "选择明确报错而不是静默降级 —— 逐格替换隧道会得到一半的隧道。");
        }
        if (x.kind === "hub") {
            return fail("unsupported_building", `${at}.kind`,
                "hub 不能被 replace_run 放置",
                "hub 是固定目标（16 入口），不参与改造；要接线用 connect 到 hub。");
        }
        specs.push({
            kind: x.kind,
            variant: x.variant === undefined ? "default" : x.variant,
            ...(x.port !== undefined ? { port: x.port } : {}),
            confirm_waste: x.confirm_waste === true,
        });
    }
    const beltOnly = specs.length === 1 && specs[0].kind === "belt";

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["dry_run"].includes(k)) return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
    }
    if (opts.dry_run !== undefined && typeof opts.dry_run !== "boolean") {
        return fail("bad_type", "opts.dry_run", "opts.dry_run 必须是布尔");
    }
    return ok({
        region: [args.region[0], args.region[1], args.region[2], args.region[3]],
        /* `building` 一律归一成**数组**（单一形状，调用方不必再判类型）；
           `mode` 是唯一的路径开关，实现按它分支，不再自己嗅 building 的形状。
           带路径的数组恒为 `[{kind:"belt",variant:"default"}]`。 */
        building: specs,
        mode: beltOnly ? "belt" : "machines",
        opts: {
            dry_run: opts.dry_run === true,
        },
    });
}

/**
 * trash_unused(outlet, opts?)
 *
 * 给一个**没有去处**的输出槽接垃圾桶：在 outlet 的喷射方向落一格 trash（1×1，四边全收）。
 *
 * 为什么不能"顺手"在任何输出上接垃圾桶：切割机两个输出一个是要的、一个是废料，
 * 选错边就把产品销毁了。所以本宏的 `port` 语义被收紧：
 *   · `"auto"` 只在该实体**恰好有 1 个** ejector 槽时合法（运行期判定）；
 *   · 多输出机器（cutter/cutter-quad）必须点名 `left`/`right`/`quad0..3`，否则 `ambiguous_port`；
 *   · 该槽**当前必须没有接收方**，有就拒绝 —— 绝不抢别人的供料。
 * 另外 `opts.confirm_waste`：当该槽不在模板 `wasteRoles` 里时，必须显式承认"这一路确实是废料"。
 * 这是一层额外的 poka-yoke —— 接口逼调用方为"销毁"这个后果签字。
 *
 * @param {{outlet:Endpoint, opts?:object}} args
 * @returns {Validation}
 */
export function validateTrashUnusedArgs(args) {
    const A = "trash_unused";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["outlet", "opts"], A);
    if (unk) return unk;

    if (args.outlet === undefined) return fail("missing_field", "outlet", `${A} 缺 outlet`);
    const outlet = validateEndpoint(args.outlet, "outlet");
    if (!outlet.ok) return outlet;

    /* 只堵一种情况：hub 的 {entry} 是**入口**索引，不是输出槽。 */
    if (isObj(outlet.value.hub) && outlet.value.hub.entry !== undefined) {
        return fail("bad_type", "outlet.hub.entry",
            `${A} 不接受 hub 的 entry 索引 —— 它是**入口**，不是输出槽`,
            "trash 接的是**源**（ejector）。给 hub 装垃圾说明方向搞反了："
            + "hub 只收不产，它没有 ejector。");
    }

    const opts = args.opts === undefined ? {} : args.opts;
    if (!isObj(opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
    for (const k of Object.keys(opts)) {
        if (!["confirm_waste", "replace_belt", "dry_run"].includes(k)) {
            return fail("unknown_field", `opts.${k}`, `${A}.opts 不认识 '${k}'`);
        }
    }
    if (opts.confirm_waste !== undefined && typeof opts.confirm_waste !== "boolean") {
        return fail("bad_type", "opts.confirm_waste", "confirm_waste 必须是布尔");
    }
    if (opts.replace_belt !== undefined && typeof opts.replace_belt !== "boolean") {
        return fail("bad_type", "opts.replace_belt", "replace_belt 必须是布尔");
    }

    return ok({
        outlet: outlet.value,
        opts: {
            confirm_waste: opts.confirm_waste === true,
            replace_belt: opts.replace_belt === true,
            dry_run: opts.dry_run === true,
        },
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 宏注册表（规格）
 * ══════════════════════════════════════════════════════════════════════════ */

/** @typedef {{name:string, type:string, required:boolean, coordClass?:string, description:string}} ParamSpec */

/**
 * @typedef {object} MacroSpec
 * @property {string} name
 * @property {string} summary        一句话
 * @property {ParamSpec[]} params
 * @property {string[]} preconditions  违反即失败的条件（运行期必查）
 * @property {string[]} whenNotToUse   poka-yoke：接口自己劝退的用法
 * @property {string} returns
 * @property {string[]} lowerOps      内部会调的**低层 op**（mod 层）
 * @property {string[]} sideEffects   会改什么、不会改什么
 * @property {string[]} invariants    实现必须维持的不变量（A3/A4 的单测判据）
 */

/** @type {Readonly<Record<string, MacroSpec>>} */
export const MACRO_SPECS = Object.freeze({
    connect: {
        name: "connect",
        summary: "从 from 的 ejector 连一条带到 to 的 acceptor；路径/转角/rv 全在内部算。",
        params: [
            { name: "from", type: "Endpoint", required: true, coordClass: "endpoint", description: "源端口。uid 来自 obs；port 缺省 auto（该实体只有一个输出槽时合法）。" },
            { name: "to", type: "Endpoint", required: true, coordClass: "endpoint", description: "宿端口。必须指向**已存在**的实体；要到空地请先放宿、或改用 build_line。" },
            { name: "opts.rebind", type: "boolean", required: false, description: "**口上**的开关：from.port 已被别的接收方占着时，是否允许改接（会让旧那条断流）。默认 false。" },
            { name: "opts.allow_replace", type: "boolean", required: false, description: "**路上**的开关：是否允许覆盖路径上的既有带子（只覆盖带子，永不覆盖机器）。默认 false。" },
            { name: "opts.max_cells", type: "int 1..5000", required: false, description: "路径格数上限，默认 2000。超了说明不是「连一条线」。" },
            { name: "opts.prefer", type: "shortest|fewest_turns|reuse_existing", required: false, description: "路径偏好，默认 fewest_turns（拐角有代价）。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写，返回计划。" },
        ],
        /**
         * rebind（口上）与 allow_replace（路上）**不是同一个开关**，各自对应一个错误码：
         *   port_already_bound / target_already_fed → 只有 rebind 能解
         *   occupied（路径上的带子）              → 只有 allow_replace 能解
         * 两者都开 = 一次调用同时抢口 + 剪旧线，是最危险的组合，只在「整段重铺」时才对。
         * 契约不合并它们（合并会让「只想覆盖路径一格」变成「顺带抢口」）；
         * 但**同时为 true 时实现必须发 `both_rebind_and_allow_replace` 警告**（warn 级），
         * 逼调用方确认这不是「顺手都开上」。
         */
        optsRelation: {
            independent: ["opts.rebind", "opts.allow_replace"],
            bothTrueWarning: "both_rebind_and_allow_replace",
        },
        preconditions: [
            /* 前 4 条是**调用方能检查、能补救**的：违反时的错误码都能靠改参数解开。 */
            "from 与 to 都能在**当前 obs** 里解析到唯一实体（uid 优先；cell 必须是该实体 origin）。",
            "from 解析出的端口是 ejector；to 解析出的端口是 acceptor。",
            "from.port 当前**没有** bound acceptor（已有则需 opts.rebind=true，否则 port_already_bound）。",
            "to.port 当前**没有**供料方（否则 target_already_fed）。",
            "路径经过的格：空 → 可用；belt → 仅 allow_replace=true 时可覆盖并计 cost；机器/hub → occupied（整单失败）。",
            "路径格数 ≤ opts.max_cells。",
            /* ★ 这条是 v3 新增的实现义务。它把「覆盖了谁」从人读摘要变成可机器消费的数据。 */
            "【实现自证】allow_replace=true 且选中路径**确实压过** N≥1 格既有带子时，"
                + "`changed.removed_uids` 必须给出这 N 个 uid（按 `cells[]` 的路径格序，去重、与 obs 的 uid 一致）；"
                + "同时 `cells_planned` **仍只算新铺的格数**，不因覆盖而翻倍。"
                + "压过 0 格时 `changed.removed_uids` 必须是 `[]`，且**不得**发 `replacing-belts` 警告。"
                + "覆盖只针对 belt / underground_belt —— 机器与 hub 永不进这个列表（它们让路就等于删机器）。",
            /* 下面 3 条是**实现自证**，调用方既预知不了也补救不了 —— 单独标出来，不与上面同权并列。
               （v1 把它们混在同一个数组里，等于把「你必须先 obs」与「mod 有没有 tx」说成同一优先级。） */
            "【实现自证，调用方无需预判】路径首格 = from 出口格，末格 = to 入口格的前一格；"
                + "两端方向必须与既有实体的朝向一致（宏不得为接线而改动机器朝向）。违反 → no_path。",
            "【实现自证】mod 支持 tx（事务）——否则 tx_unavailable（不是参数错，重试无意义）。",
            "【实现自证】v1 不支持隧道穿越；需要跨线时返回 no_path 并在 error.detail 里给出被挡的走廊，而不是偷偷用隧道。",
        ],
        whenNotToUse: [
            "宿不存在时不要用：connect 不接受「连到某个空格」。先把宿（机器/垃圾桶/hub）放好。",
            "要新建一整条产线（矿机→工序→hub）时不要用：那是 build_line（`src/agent/macros/build_line.mjs`），会一次规划矿位与工序。",
            "想把一条带的侧面「接进」另一条直线带时不要用：带子只接收同向货流（BELT-TOPOLOGY-RULES 规则 1），"
                + "侧向汇入必须让下游带子转向，那需要改既有拓扑 —— connect 会以 no_path / occupied 拒绝，而不是硬接。",
            "源端口已经有接收方时不要用（除非你**就是要**抢过来并接受旧支路断流，此时显式 rebind=true）。",
            /* v1 曾写「两台机器紧贴时用 insert_machine 后直接验证 boundAcceptor」—— 那是 gate 的事，
               不是这个宏的动作。改成「本宏对这种情况本来就不该被调用」。 */
            "两台机器紧贴、槽位本来就对齐（0 格连接）时不要用：那是**不需要铺带**的情形，"
                + "调用 connect 只会得到 0 格路径；连接是否存在由 gate（G6b boundAcceptor）判定，不是 connect 的动作。",
        ],
        returns: "MacroResult（cells_planned = 计划铺的带格数；cells_placed = 读回一致的格数；first_mismatch = 第一处 code/rotation/rv 与计划不符）"
            + " + {cells:[{x,y,building,rotation,rotationVariant,code,inDir,outDir,entry,exit}], pathLen, choice, strategy, alternatives}。"
            + "**allow_replace=true 且确实覆盖了既有带子时，`changed.removed_uids` 必须列出被覆盖的每一个 uid（按路径格序）**"
            + " —— 这是规范通道（见 REPLACED_DESTROYS_FIELD）；`replacing-belts` 的 detail 里的格数只是人读摘要，不可当数据源。",
        lowerOps: ["obs", "debug_items", "place（逐格，按 rv 自证）", "paste_blueprint（带 rv 的精确拐角）", "delete{uid}（A1 交付；覆盖旧带时）", "tx（A1 交付）"],
        sideEffects: ["新增带子实体", "allow_replace=true 时销毁路径上的旧带子（必须回滚可还原）", "不动机器、不动 hub"],
        invariants: [
            "连接完成后，from 出口的 boundAcceptor 是路径首格；路径末格的 boundAcceptor 是 to 的槽位。",
            "每一格的 (rotation, rv) 必须由 solveTurn(entry,exit) 反解并**读回自证**；不允许依赖游戏的邻居自动定向。",
            "cells_planned === cells_placed 或 ok=false（tx 下不存在半成）。",
        ],
    },

    insert_machine: {
        name: "insert_machine",
        summary: "放一台 machine 并朝向 facing；footprint/origin/槽位由宏算，调用方只指一格。",
        params: [
            { name: "at", type: "{cell:[x,y],part?:\"any\"} | [x,y]", required: true, coordClass: "site", description: "**默认用 `{cell:[x,y]}`**：机器要占的其中一格（通常是 obs 里那条带子的格），宏反解 origin；多解时若只有一解让这格成为机器的输入槽槽格则采用（`site.chosen_by=\"input-slot\"`），仍多解即 ambiguous_site。`[x,y]` 裸数组 = 直接给 origin（obs 的 entities[].x/y），向后兼容、宏不做算术。选择口径只有一句：**「在这条带上插一台」用 {cell}；「就是 obs 里那台机器/那个坐标」用 [x,y]。** 两者走不同算术，归一化后 at.kind ∈ any-cell|origin。" },
            { name: "facing", type: "Face", required: false, coordClass: "choice", description: "primary output 的世界喷射方向。**必填性取决于机器**（不是这个参数）：有输出槽且可旋转的机器必填（缺失 → ambiguous_site）；无输出槽/不可旋转（trash）或四向等价的机器可省略（省略后 r=0，并回 facing_ignored 警告）。" },
            { name: "machine", type: "string|{kind,variant}", required: true, description: "建筑标识，如 \"cutter\"；变体如 {kind:\"painter\",variant:\"mirrored\"}。" },
            { name: "opts.replace_belts", type: "boolean", required: false, description: "footprint 内的带子是否让位（默认 true）。机器永远不会被让位。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写。" },
        ],
        /** 机器可读的 facing 规则 —— schema / description / precondition 三处必须说同一句话（契约测试逐一核对） */
        paramRules: {
            facing: {
                requiredWhen: "machine 有输出槽且可旋转（ROTATABLE !== false）",
                optionalWhen: "machine 无输出槽（trash）或几何四向等价；省略后 rotation=0",
                missingCode: "ambiguous_site",
                ignoredWarning: "facing_ignored",
            },
            at: {
                recommendedForm: "{cell:[x,y]}",
                forms: { "any-cell": "反解 origin（唯一解 / 唯一输入槽解 → 采用；仍多解 → ambiguous_site）", origin: "直接采用，不做算术" },
                disambiguation: "多解时优先取「让 at.cell 成为机器输入槽槽格」的那个 origin；采用依据进返回值 site.chosen_by（unique | input-slot），不进 warnings。",
            },
        },
        preconditions: [
            "at 的格必须是 obs 里真实存在的格（带子 / 空 / 上一宏返回值）；宏不接受「凭空算出来的格」。",
            "`{cell}` 形态下，按 machine+facing 的 footprint 反解 origin：命中恰好 1 个 → 采用；"
                + "命中 >1 时，若只有一解让 `at.cell` 成为机器的**输入槽槽格**则采用（依据写入返回值 `site.chosen_by=\"input-slot\"`）；"
                + "仍有多解 → ambiguous_site 并列出候选（不猜）。",
            "`facing` 缺失且机器在 4 向上几何不同（有输出槽且可旋转：cutter/painter/mixer/stacker/rotater/miner）→ ambiguous_site。"
                + "只有无输出槽/不可旋转（trash）或几何四向等价时才允许省略，省略后 rotation=0 并回 facing_ignored。",
            "机器 footprint（按 facing 解出的 rotation 展开、按 getTileSpaceBounds 的 origin 语义）内，**每一格**必须是：空 / 带子（且 replace_belts=true）。",
            "footprint 覆盖到任何机器或 hub → blocked_by_machine（整单失败，绝不删机器）。",
            "机器必须在该存档已解锁（查 op-templates 的 unlockLevel）；未解锁 → precondition_failed。",
            "若 footprint 内有带子被替换，它们必须能被 serialize 快照（tx）；否则 tx_unavailable。",
        ],
        whenNotToUse: [
            "周围没有带子/机器可接时不要用：孤立的机器不产不耗，只是占格。要新建整条线用 build_line（`src/agent/macros/build_line.mjs`）。",
            "机器是 4 边全收、方向无意义的建筑（trash）时不要用：用 trash_unused，它会检查 outlet 是否真的没去处。",
            "想「换一台机器」时不要用：insert_machine 不搬机器（uid 会变）。删旧再放新是有代价的动作，必须走显式计划（removes[] + tx）。",
            "想调整既有机器朝向时不要用：那是删除+重放，会丢运行期状态；朝向错误应该由 connect 的 no_path 或 G7/G8 报出来，不该靠重放掩盖。",
            "想放一台「占多格但你要规划它周围所有线」的机器时不要用：本宏只保证机器本身与它**已被带子覆盖**的旧拓扑兼容；周围接线用 connect。",
        ],
        returns: "MacroResult + {origin:[x,y], rotation:0|90|180|270, cells:[{x,y}], removed_uids:[], wiring:[{kind,role,slot,cell,dir,status,why?}], site:{mode,candidates,chosen_by,why?}, pending:PendingRef}；wiring.status ∈ ok|nothing|mismatch。**没有游戏 uid**：uid 由 tx 在执行后分配，计划态 added_uids 恒空。要给这台机器接下游，把返回值里的 `pending` 原样传给下游宏的端点（见 PENDING_REF_SPEC）；落盘之后才改用 obs 的真 uid。"
            + " footprint 内有既有带子被替换时，**`changed.removed_uids` 是规范通道**（顶层 `removed_uids` 是同值历史别名，只许读不许新依赖）。",
        lowerOps: ["obs", "op-templates（槽位/footprint/ROTATABLE 真值）", "delete{uid}（A1 交付）", "place", "tx（A1 交付）"],
        sideEffects: ["新增 1 台机器", "替换 footprint 内的带子（销毁其 uid，必须可回滚还原）", "不新建带子、不接线"],
        invariants: [
            "origin 由 `{cell}` 形态反解，或由 `[x,y]` 形态直接采用；**两种形态不得混用**（一个走算术、一个不走）。",
            "机器槽位的世界格 = origin + rotate(localCell)（origin 位移规则见 CAPABILITY_ASSUMPTIONS.rotated_machine_slots），不得由调用方给。",
            "落地后读回 code 必须等于 op-templates 给出的 code；不等即 verification_failed。",
            "facing 反解出 r≠0 时，落地后必须用 debug_items/obs 读回**实际**槽位邻接并写进 wiring。",
            /* v1 曾写「任一 status=mismatch 即 ok=false」，与实现（ok:true + warnings）打脸。
               v2 的裁定：计划态只能警告；执行后的 mismatch 才判 ok=false。 */
            "该槽位的邻接状态**必须逐条进 wiring**（ok|nothing|mismatch）；mismatch 必须同时出现在 warnings 里"
                + "（`output_*_wrong_direction` / `wiring_mismatch`），不许静默接受「大概能用」。",
            "mismatch **不阻断计划**（落点可能「先放机器、下一步再接」）；但执行后读回仍 mismatch ⇒ verification_failed 并回滚。",
        ],
    },

    remove_run: {
        name: "remove_run",
        summary: "删掉一段带子（uids 指名的集合）；整段原子删除。",
        params: [
            { name: "uids", type: "Uid[]", required: false, coordClass: "endpoint", description: "要删的带子 uid（来自 obs）。**这是唯一推荐通道**；与 cells **恰好二选一**（都给 → bad_type，都不给 → missing_field）。" },
            { name: "cells", type: "Cell[]", required: false, coordClass: "endpoint", deprecated: true, description: "**已弃用，勿用**：拿不到 uid 时的历史通道。obs 永远给 uid，这条通道只多一个选错的机会，还把坐标重新放进公开 ABI。保留它是为了不破坏既有调用方；新调用必须用 uids。" },
            { name: "opts.allow_scattered", type: "boolean", required: false, description: "允许删不连通的多段。默认 false（不连通通常是选集错）。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        /** 两个端点参数是**恰好二选一**，不是「都可省」。机器可读，供 A6 的 schema 生成器与契约测试共用。 */
        exactlyOneOf: [["uids", "cells"]],
        preconditions: [
            "每个 uid（或弃用的 cell）都解析到一个**带子**（belt / underground_belt）。任何一格解析到机器/hub → not_a_run，整单拒绝。",
            "选集在 4-邻接下连通（除非 allow_scattered=true）。",
            "每一条带子都能被 serialize 快照（tx）；否则 tx_unavailable —— 不可恢复的删除一律不做。",
            "删除后必须报告 affected：哪些既有机器输出因此变成无去处（orphaned_outputs），哪些带上的物品被丢弃（stranded_items）。这两项**不阻止**执行，但必须如实出现。",
        ],
        whenNotToUse: [
            "目的是给机器让位时不要单独用：insert_machine 自己会处理 footprint 内带子并保持原子性；拆成两步会在中间态留下「机器没放、带子已删」的断线。"
                + "（例外：**定点改造**整段线时 replace_run 一次做完，比 remove_run + insert_machine 两步更安全。）",
            "要清一大片区域时不要用：用 bulk_delete（带 dry_run 看 items 清单），remove_run 只用于**指名**的一段。",
            "不确定某格是什么时不要用：先 obs；cell 解析到机器会被整单拒绝，这是设计（宁可失败，不可误删）。",
        ],
        returns: "MacroResult + {removed_uids, removed_cells, stranded_items:int|null, orphaned_outputs:[{uid,port,cell,dir}]}；stranded_items 在离线计划态恒为 null（见 warnings 的 stranded-items-unknown）。",
        lowerOps: ["obs", "debug_items（settled 判断）", "delete{uid}（A1 交付）", "tx（A1 交付）"],
        sideEffects: ["销毁带子实体", "带上的在途物品消失（如实报告，不算失败）"],
        invariants: [
            "删除集合与声明集合**逐 uid 相等**（G-delete-replay 的判据）。",
            "tx 失败时零删除（不存在「删了一半」）。",
        ],
    },

    remove_machine: {
        name: "remove_machine",
        summary: "删掉一台机器（按 uid）；hub 永不可删。用于移除挡路的废机器。",
        params: [
            { name: "uids", type: "Uid[]", required: true, coordClass: "endpoint", description: "要删的机器 uid（来自 obs）。只接受机器：带子请用 remove_run，hub 永不可删。" },
            { name: "opts.allow_unwired", type: "boolean", required: false, description: "这台机器正在给下游供料时，是否仍允许拆。默认 false（会报 would_starve 并点名会饿死谁）。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        preconditions: [
            "每个 uid 都解析到一台**机器**（miner/cutter/rotater/stacker/mixer/painter/balancer/trash）。带子 → not_a_machine；hub → immutable。整单拒绝，不「尽量删」。",
            "若某台正在给下游供料，且没传 opts.allow_unwired=true → would_starve（点名会饿死谁）。",
            "每台机器都能被 serialize 快照（tx）；否则 tx_unavailable —— 不可恢复的删除一律不做。",
        ],
        whenNotToUse: [
            "要删带子时用 remove_run：本宏只动机器，带上混着机器会整单拒绝。",
            "想让机器换位置时不要「先删再放」两步：中间态会留下断线。若只是换落点，直接 insert_machine（它会处理 footprint 内的带子）。",
            "不确定那台机器在干什么时不要删：先看 obs 的 MACHINES 段与「它正喂着谁」；默认的 would_starve 就是为此设的。",
        ],
        returns: "MacroResult + {removed:[{uid,type,cell,origin}]}；失败时 removed 为空数组（不是字段缺失）。",
        lowerOps: ["obs", "delete{uid}", "tx"],
        sideEffects: ["销毁机器实体", "它的下游可能断供（如实报告）"],
        invariants: [
            "删除集合与声明集合**逐 uid 相等**。",
            "tx 失败时零删除（不存在「删了一半」）。",
            "hub 永远不会出现在 removed 里。",
        ],
    },

    extend_line: {
        name: "extend_line",
        summary: "从一段带子的末端（或机器输出口）沿 dir 再接 len 格，首格由 from 的出口算。",
        params: [
            { name: "from", type: "Endpoint", required: true, coordClass: "endpoint", description: "既有带子的末端，或机器输出口。" },
            { name: "len", type: "int 1..500", required: true, coordClass: "choice", description: "要新增的格数（不含 from 自身）。**不需要先数障碍**：填一个你可能需要的长度即可，宏会用 occupied + firstConflict 指出第一处被挡格 —— 那就是「到障碍还有多远」的查询结果。" },
            { name: "dir", type: "Face", required: false, coordClass: "choice", description: "世界方向；缺省沿用 from 当前出口（直行）。给不同方向 = 一个 90° 转弯。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只算不写。" },
        ],
        preconditions: [
            "from 解析到唯一实体；若是带子，它必须是**末端**（出口方向的下游没有 acceptor，即 boundAcceptor===null）。",
            "from 若是机器，必须是输出槽且该槽当前无接收方。",
            "dir 与 from 当前出口夹角 ∈ {0°, 90°}；180° 掉头 → precondition_failed（带子做不到同格掉头）。",
            "路径上 len 格必须全空（allow_replace 不在本宏提供 —— 需要覆盖就用 connect 或 replace_run）。",
            /* v1 的「len ≤ 与最近障碍的距离」被删掉：那要求调用方先数格子，是 computed 的活。
               同一件事由宏在规划后自查并回报 occupied + firstConflict 完成，调用方不需要那个数字。 */
            "若 len 太长撞上障碍：整单失败 `occupied`，`firstConflict` 给出被挡的第一格 —— **调用方据此缩短 len 重调，不需要自己算距离**。",
        ],
        whenNotToUse: [
            "目标是一个具体的东西时不要用：extend_line 只保证「延长了」，不保证「接上了」。要接到某处请用 connect。",
            "需要拐两个弯时不要用：一次只允许一个 90° 转向；多段请分多次调用 —— **闭环是**："
                + "第 N 次返回 `terminal:{cell, exit, uid?}`，第 N+1 次的 `from` 直接给这个 terminal 的端点"
                + "（`{cell}` 形态，或执行 tx 后 obs 拿 uid），`dir` 换成第二个弯的方向。",
            "为绕过障碍时不要用：那是布线，用 connect。",
        ],
        returns: "MacroResult + {added_uids, cells, terminal:{cell, exit}, terminal_orphaned:boolean}；`terminal` 就是下一次 extend_line 的 `from`（宏间串联的唯一稳定通道）。",
        lowerOps: ["obs", "debug_items（末端 boundAcceptor 判定）", "place / place_path", "tx（A1 交付，用于失败回滚）"],
        sideEffects: ["新增带子实体", "不改既有实体"],
        invariants: [
            "首格 = from 的出口格 + dir 单位向量；末格出口 = dir。",
            "每格 (rotation, rv) 由 solveTurn 反解并读回自证。",
            "terminal_orphaned=true 时必须出现在返回值里（warning `terminal_orphaned`）—— 不许静默留下死端。",
        ],
    },

    replace_run: {
        name: "replace_run",
        summary: "把 region 内的带子原位换成另一种建筑。building=\"belt\" 保持每格拓扑（修 rv）；building 为机器/机器数组时展开 footprint，删掉被覆盖的带、保留没被覆盖的。",
        params: [
            { name: "region", type: "BBox", required: true, coordClass: "endpoint", description: "闭区间包围盒 [x0,y0,x1,y1]，取 obs 里**已被选中那几条带子**的 min/max 坐标。它不是算出来的落点（见 COORD_CLASSES 的 v2 裁定）。校验按模式不同：belt 模式要求每格都是带子；机器模式允许空格、不许机器。" },
            { name: "building", type: "string|{kind,variant}|Array", required: true, description: "目标建筑。\"belt\" = 原位换带（修 rv）；机器名或 [{kind,variant,port?,confirm_waste?}] = 展开 footprint 换机器；数组里**恰好 1 台主动机器** + 若干 trash，trash **必须点名 port**。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。（本宏零写操作：返回值的 dry_run 恒 true，这个开关只进 requested_dry_run。）" },
        ],
        preconditions: [
            "region 内不允许有任何机器/hub（按 footprint 判，不按 origin 判）；碰到 → not_a_run，列出前 5 个反例。"
                + "这是误删 42 实体那次事故的形态，任何模式都不放宽。",
            "**belt 模式**（building === \"belt\"）：region 内**每一格**都是带子；有空格 → precondition_failed 并列出空格。",
            "**机器模式**（building 为机器/数组）：region 内可以是带子或空格，但**至少要有一格带子**（否则「替换」无对象 → 用 insert_machine）。",
            "region 的边界必须与实体格对齐（「框选偏了」最常见的形态）：宏逐格核对并列出反例，不让调用方自己数字。",
            "机器模式：数组里**恰好 1 台主动机器**（有输出槽）；只给 trash → precondition_failed；多台主动机器 → out_of_scope（拆成多次）。",
            "机器模式：每台 trash 必须点名 `port`（missing_field），且该 role 必须是主动机器的输出槽（否则 bad_type/ambiguous_port 并列出候选）。"
                + "`confirm_waste:true` 是**一次签字覆盖两层后果**：① 这一侧是废料；② 即使该 role ∈ 模板 wasteRoles、"
                + "即使喷口格上的带子还有下游（接 trash 会把一条活链永久剪断），也确认要销毁。"
                + "所以它**不可省**，缺了 → precondition_failed（列出会剪的 uid→下游）。",
            "机器模式：主动机器的朝向由 region 内带子的**流向**反解；流向不一致 → precondition_failed；反解出 r≠0 → out_of_scope（v1 只放 r=0）。",
            "目标 building 必须在支持矩阵内：未知建筑 / hub / underground_belt → unsupported_building（不静默降级）。",
            "替换会销毁旧 uid 并产生新 uid —— 必须有 tx 与快照，否则 tx_unavailable。",
        ],
        whenNotToUse: [
            "想删除带子时不要用：remove_run（belt 模式的 replace 不减少实体数，用错会留下一条「换了个 uid 的同样的带子」）。",
            "只想放一台机器、不需要处理它周边带子时，用 insert_machine 更直接（replace_run 会连带删除被 footprint 覆盖的带，并检查留下的带是否还连着）。",
            "想铺隧道时不要用：v1 明确不支持（sender/receiver 成对），会报 unsupported_building。",
            "region 框不准时不要用：先 bulk_delete dry_run 看 items，或用 remove_run(uids) 精确指名。",
        ],
        returns: "MacroResult + belt 模式 {mode:\"belt\", replaced_uids, removed_uids, added_uids, mismatched:[{cell,field,requested,actual}]}；机器模式 {mode:\"machines\", removed, placed, kept, summary:{removed,placed,kept}, flow, building}"
            + "；两种模式的 **`changed.removed_uids` 都是规范通道**（顶层 `removed_uids` / `replaced_uids` 是同值历史别名）。",
        lowerOps: ["obs", "belt-rules（solveTurn）", "op-templates（footprint/槽位）", "delete{uid}", "place", "tx（A1 交付）"],
        sideEffects: ["belt 模式：销毁并重建 region 内每个带子（uid 全变）", "机器模式：销毁被 footprint 覆盖的带、放机器（trash 按点名槽位）", "不改 region 外的任何实体"],
        invariants: [
            "belt 模式：替换后每格的 entry/exit 与替换前逐格相等（用 belt-rules 双跑对拍）。",
            "机器模式：**删除集合 === 「被新建筑 footprint 覆盖的 region 内带子」**，保留集合 === 其余带子，且保留的每一格都进 warnings 的 `kept-belts`。",
            "region 外的实体 uid 集合逐字节不变。",
        ],
    },

    trash_unused: {
        name: "trash_unused",
        summary: "给一个没有去处的输出槽（必须显式指定 port）接垃圾桶。outlet 可以是机器输出槽，也可以是一段带子的末端。",
        params: [
            { name: "outlet", type: "Endpoint", required: true, coordClass: "endpoint", description: "源端口：机器输出槽（{uid,port?}）**或一段带子的末端**（{uid}，垃圾桶落在它 exit 方向的下一格）**或上一个宏返回的 pending**（{pending,port?} —— 计划态，未落盘即可挂垃圾桶，见 PENDING_REF_SPEC）。多输出机器（cutter 2 / cutter-quad 4）必须点名 left|right|quad0..3。" },
            { name: "opts.confirm_waste", type: "boolean", required: false, description: "当该端口不属于模板声明的 wasteRoles 时，必须显式确认「这一路确实是废料」。默认 false → 拒绝。这是**签字**，不是判断：宏查不出目标形状，只能要求调用方为销毁负责。" },
            { name: "opts.replace_belt", type: "boolean", required: false, description: "喷射方向的下一格若是带子，是否允许让位。默认 false。" },
            { name: "opts.dry_run", type: "boolean", required: false, description: "只报告不执行。" },
        ],
        preconditions: [
            "outlet 解析到唯一实体：机器（有 ejector 槽）或**带子**（取其 exit 面）。带子已接到下游 → port_already_bound（绝不抢）。",
            "机器 outlet 解析到**唯一** ejector 槽：port=\"auto\" 仅在该实体恰好 1 个 ejector 时合法，否则 ambiguous_port 并列出候选 role。",
            "该槽当前 boundAcceptor === null（已经有接收方 → port_already_bound，绝不抢）。",
            "喷射方向的下一格必须空，或是 opts.replace_belt=true 且为带子；机器/ hub → occupied；隧道 → out_of_scope。",
            "**喷口格上的带子若还有下游（活链），即使 role ∈ wasteRoles 也必须 confirm_waste=true**；"
                + "否则 precondition_failed。理由：这不是「给死路接垃圾桶」，而是把一条还在供货的链永久剪断 —— "
                + "E2E §4 V9 实测旧实现只发一条 kept-belts 就通过，属静默数据损失。",
            "该槽的 role ∈ 模板 wasteRoles 时可直接执行；否则必须 confirm_waste=true。"
                + "⚠️ wasteRoles 是**半切场景**的约定（'----CuCu' 要的是左列，右列才是废料），"
                + "不是「这一侧永远没用」—— L4 的 RuRu---- 恰好要右列、丢左列。"
                + "所以：目标形状决定哪一侧是废料，宏查不出目标，只能要求调用方签字。"
                + "**这是有意保留的人工判断**（不是偷懒）：宏的输入里没有 goal。要把它机器化，"
                + "必须先把「目标形状」变成 outlet 的一个参数（如 opts.keeps:\"left\"|\"right\"），"
                + "而那会改 ABI —— 不在 v2 的范围，登记在此。",
        ],
        whenNotToUse: [
            "输出要接 hub 或下游工序时不要用：那是 connect。",
            "只是想暂时缓冲/合流时不要用：trash 是**永久销毁**，用 balancer。",
            "端口已经接了东西时不要用：先把那条拆掉（remove_run）并想清楚为什么它会空转。",
        ],
        returns: "MacroResult + {trashCell, outletPort:{kind:eject|belt-exit|pending-eject,...}, replaced_belt_uid?, trash:{…}, pending:{…}}"
            + "（pending = 计划态 trash 引用，可继续喂给下游宏）"
            + "；opts.replace_belt=true 顶掉喷口格带子时，**`changed.removed_uids` 是规范通道**"
            + "（顶层 `replaced_belt_uid` 是**单数**历史别名，上限 1，只许读不许新依赖）。",
        lowerOps: ["obs", "debug_items（boundAcceptor）", "op-templates（wasteRoles / slot 表）", "place", "delete{uid}（replace_belt 时）", "tx（A1 交付）"],
        sideEffects: ["新增 1 台 trash", "replace_belt=true 时销毁 1 格带子", "之后该槽的产物被永久销毁"],
        invariants: [
            "只在该槽**当前无接收方**时执行（执行前再查一次，避免 obs 过期）。",
            "trash 必须正好落在喷口格；偏一格就完全收不到货（4 边全收，但不同格就是不同实体）。带子 outlet 的喷口格 = 带子格 + exit 单位向量。",
        ],
    },
});

/** 宏名列表（稳定顺序，供 LLM 层与文档共用） */
export const MACRO_NAMES = Object.freeze(Object.keys(MACRO_SPECS));

/* ══════════════════════════════════════════════════════════════════════════
 * 4b. 能力矩阵 —— 把「哪些结论是实机的、哪些是假设」钉在契约里
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 宏实现依赖的、**尚未在实机闭环**的前提。任何一条被推翻，宏的某个分支必须改，
 * 而不是「实现里悄悄绕一下」。
 *
 * 为什么要单列：这个项目最大的成本不是写错代码，是**把假设当结论用**——
 * `WHY-NO-CUTTER-INSERT.md` 的「旋转机器不可用」曾让 L4 的正确解法被判死；
 * 而 `world-full.json`（2805 实体实机 dump）里 r≠0 的加工机器到处都是。
 * 结论不写进契约，下一个 agent 会再踩一遍。
 *
 * `status` 语义（三档，不许含糊）：
 *   · "live-verified"  实机跑通、产物/连接逐项对拍过
 *   · "observed"       实机**存在**（存档里有真实例、拓扑自洽），但没在产线上单独跟踪
 *   · "assumed"        纯推断 / 只在单测里成立
 */
export const CAPABILITY_ASSUMPTIONS = Object.freeze({
    rotated_machine_slots: {
        claim: "r≠0 的加工机器（cutter/painter/mixer/rotater）的槽位 = 局部槽位按 rotation 旋转，"
            + "世界格 = origin + rotate(localCell)，origin 不因 rotation 位移。",
        status: "observed",
        evidence: "facts/live/world-full.json（2805 实体）。按上式复算：16 台 r≠0 的 cutter 里 15 台输入口"
            + "正对一条 feeding belt；44 台 r≠0 的 painter 输入口 73/88 命中；23 台 r≠0 的 mixer 输出口 23/23 有接收方。"
            + "反证：换成「绕 bbox 中心旋转」的换算只剩 6/16 的 cutter 命中。",
        contradicts: "`research/ai-plan/WHY-NO-CUTTER-INSERT.md` 的结论「r≠0 的加工机器在 1.5.6 上不收货」——"
            + "该结论来自一次受控实验（r=180 的 cutter 无产出），与本 dump 冲突。"
            + "两者至少要重跑一次才能定论；**在定论之前 insert_machine 遇到 r≠0 必须如实返回 "
            + "`verification_failed` 而不是假设成功**。",
        affectsMacros: ["insert_machine"],
        action: "A3/A4 实现时：facing 反解出 r≠0 就先照上式算，但**落地后必须读回槽位/连接自证**；"
            + "自证失败即 verification_failed，不许降级成「大概能用」。A9 用受控实验裁定上面那条冲突。",
    },

    machine_place_sets_rv: {
        claim: "`place{building,x,y,r}` 能可靠产生指定 (rotation, rotationVariant) 的带子。",
        status: "assumed",
        evidence: "BELT-TOPOLOGY-RULES 规则 2 实测：`place` 的 rv 由游戏按邻居猜，"
            + "且拐角只在放置那一刻算一次；`place{r:90}` 曾得到 code=1 直带（AI-CONTROL-STATUS §2）。",
        contradicts: "mod 的 `placeOne` 在没给 rv 时调用 `computeOptimalDirectionAndRotationVariantAtTile`。",
        affectsMacros: ["connect", "extend_line", "replace_run", "insert_machine"],
        action: "**connect / extend_line 的拐角不得依赖 place 猜**：必须用 `paste_blueprint` 携带显式 "
            + "code=1+rv（emit 路径，已实机验证 immutable 粘贴不改 rv），或 place 后读回 code 自证并重试。"
            + "这是 macro 实现里最容易写错、也最容易「看起来绿」的一处。",
    },

    hub_16_entries: {
        claim: "hub 的 16 个入口 = op-templates.hubEntriesWorld() 的表；带子末格在入口外一格、朝向 hub。",
        status: "observed",
        evidence: "上游 hub.js:73-91 + 四份实机数据同源（见 op-templates 注释）。"
            + "但「带子直接插进 hub 槽位」本身在 GEOMETRY 表1 里仍是 ⬜（未实机单测）。",
        contradicts: "无直接反证；L3 的 CuCuCuCu 端到端曾 met=true（12 实体、delivered 0→1），"
            + "说明至少底排入口可用。",
        affectsMacros: ["connect"],
        action: "connect 到 hub 时，opts 里 `port:{entry:n}` 必须按这张表解释；"
            + "实现要按「距离排序 + 逐个试 + 整段回滚」的既有做法（place.mjs:2470 已验证），不要另写分配器。",
    },

    trash_accepts_four_sides: {
        claim: "trash 四边全收（1×1，r 恒 0），任意方向喷来的货都能吃。",
        status: "live-verified",
        evidence: "op-templates AUX（trash.js:74-92）+ M1b/M2a/M3 实机产物比对；"
            + "L4-PLAN-A0 的 (4,-14) trash 布局亦依赖此。",
        contradicts: "无。但注意：**方向无关 ≠ 位置无关** —— 偏一格就完全收不到。",
        affectsMacros: ["trash_unused"],
        action: "trash_unused 的落点必须精确等于 outlet 的喷口格（outlet 槽位格 + 该槽 dir 的单位向量）。",
    },
});

/** @returns {boolean} 该能力是否已实机闭环（"assumed" 一律 false） */
export function isLiveVerified(capability) {
    const c = CAPABILITY_ASSUMPTIONS[capability];
    return !!(c && c.status === "live-verified");
}

/** 拿某宏的全部未闭环前提（A6 的 loop 在 proposal 阶段用来降置信度） */
export function openAssumptionsFor(macroName) {
    return Object.entries(CAPABILITY_ASSUMPTIONS)
        .filter(([, c]) => c.affectsMacros.includes(macroName) && c.status !== "live-verified")
        .map(([k, c]) => ({ key: k, status: c.status, claim: c.claim }));
}

/** @returns {MacroSpec|null} */
export function getMacroSpec(name) {
    return MACRO_SPECS[name] || null;
}

/** 各宏的入参校验器（实现方必须经由这里，不允许自己解构 args）。 */
/**
 * `remove_machine` 的校验器。
 *
 * 形状比 remove_run 简单得多：只有 uids（必填）+ opts。
 * **不提供 cells 通道** —— 机器是 2×1/1×1，一个坐标可能落在 footprint 的
 * 非 origin 格上，「这一格指的是哪台机器」就有了歧义。uid 没有这个问题。
 *
 * 注意这里**不判**「是不是机器」「是不是 hub」—— 那需要世界快照（obs），
 * 属于宏的前置条件（`removeMachine` 里用 ctx.entities 判）。
 * 校验器只管参数形状，这样纯函数、可离线测。
 *
 * @param {object} args
 * @returns {{ok:true, value:{uids:number[], opts:object}} | {ok:false, error:object}}
 */
export function validateRemoveMachineArgs(args) {
    const A = "remove_machine";
    if (!isObj(args)) return fail("bad_type", null, `${A} 的入参必须是对象`);
    const unk = rejectUnknownKeys(args, ["uids", "opts"], A);
    if (unk) return unk;

    if (args.uids === undefined) {
        return fail("missing_field", "uids", `${A} 需要 uids`,
            "uid 来自 obs.entities[].uid。hub 的 uid 不可删。");
    }
    if (!Array.isArray(args.uids) || args.uids.length === 0) {
        return fail("bad_type", "uids", `${A}.uids 必须是非空数组`);
    }
    if (!args.uids.every(u => isInt(u) && u > 0)) {
        return fail("bad_type", "uids", `${A}.uids 必须全是正整数 uid`,
            "uid 来自 obs；不要用坐标（机器 footprint 会让坐标有歧义）。");
    }
    // 去重：同一台机器写两次是调用方 bug，静默去重会掩盖它
    if (new Set(args.uids).size !== args.uids.length) {
        return fail("bad_type", "uids", `${A}.uids 里有重复 uid`,
            "重复通常是拼接选集时的 bug；去重后再写。");
    }

    let opts = {};
    if (args.opts !== undefined) {
        if (!isObj(args.opts)) return fail("bad_type", "opts", `${A}.opts 必须是对象`);
        const ounk = rejectUnknownKeys(args.opts, ["allow_unwired", "dry_run"], `${A}.opts`);
        if (ounk) return ounk;
        if (args.opts.allow_unwired !== undefined && typeof args.opts.allow_unwired !== "boolean") {
            return fail("bad_type", "opts.allow_unwired", `${A}.opts.allow_unwired 必须是 boolean`);
        }
        if (args.opts.dry_run !== undefined && typeof args.opts.dry_run !== "boolean") {
            return fail("bad_type", "opts.dry_run", `${A}.opts.dry_run 必须是 boolean`);
        }
        opts = { ...args.opts };
    }

    return { ok: true, value: { uids: [...args.uids], opts } };
}

export const MACRO_VALIDATORS = Object.freeze({
    connect: validateConnectArgs,
    insert_machine: validateInsertMachineArgs,
    remove_run: validateRemoveRunArgs,
    remove_machine: validateRemoveMachineArgs,
    extend_line: validateExtendLineArgs,
    replace_run: validateReplaceRunArgs,
    trash_unused: validateTrashUnusedArgs,
});

/**
 * 统一入口：按宏名校验。`{op: "connect", ...}` 或 `{macro: "connect", ...}` 都认。
 * @param {string} name
 * @param {object} args
 * @returns {Validation}
 */
export function validateMacroCall(name, args) {
    const v = MACRO_VALIDATORS[name];
    if (!v) {
        return fail("bad_type", "op", `未知宏 "${name}"`, `可用宏：${MACRO_NAMES.join(", ")}`);
    }
    return v(args);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 统一返回信封
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 每个宏**只有一个**返回形状。DIRECTION-FINAL 阶段 1 钉死了
 * `{ok, cells_planned, cells_placed, first_mismatch}` 四个字段，这里把其余补全。
 *
 * 语义要点（实现方必须遵守，否则调用方无法分诊）：
 *   · `cells_planned` = 计划**写**的世界格数（新增 + 替换/删除），不是实体数。
 *   · `cells_placed`  = 读回与计划**一致**的格数。tx 下它只能等于 planned，否则 ok 必须为 false。
 *   · `first_mismatch`= 第一处不一致（按路径/格顺序的**确定序**，不是随机序），
 *                      比的是读回的 code / rotation / rotation_variant，不是"有没有东西"。
 *                      只比存在性会让「放歪了的带子」通过 —— 正是 P7 F1/F2 记录的静默事故。
 *   · `error`         = 只在 ok=false 时非 null。
 *   · `warnings`      = ok=true 时**可以**非空；每一项的 code ∈ `WARNING_CODES`（闭集），
 *                       severity ∈ `WARNING_SEVERITIES`（未写时取表里的声明）。
 *                       **调用方唯一需要的判据是 `warningVerdict(warnings)`**：
 *                       `info` → 忽略；`warn` → 可执行但必须按 detail 补齐计划；
 *                       `error` → 按 ok:false 处理。`ok:true` + `error` 级警告是**实现 bug**，
 *                       `validateMacroResult()` 会直接判红（不能让调用方去读一个会撒谎的 ok）。
 */
export const RETURN_ENVELOPE = Object.freeze({
    required: ["ok", "cells_planned", "cells_placed", "first_mismatch"],
    fields: {
        ok: "boolean — 宏的整体成败（tx 下等价于「全部做成」）",
        macro: "string — 宏名",
        cells_planned: "int — 计划写入的格数",
        cells_placed: "int — 读回一致的格数",
        first_mismatch: "null | {cell, field, requested, actual}",
        changed: "{added_uids:Uid[], removed_uids:Uid[]}（**计划态**，added_uids 恒空：uid 由 tx 分配）"
            + "；`removed_uids` 是**「本单会销毁哪些既有实体」的唯一规范通道**（v3）",
        warnings: "Array<{code ∈ WARNING_CODES, severity?: info|warn|error, cell?, detail, hint?}>",
        error: "null | MacroError（code ∈ ERROR_CODES）",
        tick: "number — 结束时游戏时钟（便于对账）",
        dry_run: "boolean — **本次是否只算未写**（宏零写 ⇒ 恒 true；它不是「调用方有没有要求 dry-run」）",
        requested_dry_run: "boolean? — 调用方传来的 opts.dry_run。与 dry_run 是两件事：把后者写成 false 会被读成「已经落盘了」",
        pending: "PendingRef? — 计划态实体引用（见 PENDING_REF_SPEC）。放东西的宏用它当**下游宏的端点**，绕开「uid 由 tx 分配」的断链",
    },
});

/** @typedef {{ok:boolean, macro:string, cells_planned:number, cells_placed:number,
 *   first_mismatch:null|{cell:Cell, field:string, requested:any, actual:any},
 *   changed:{added_uids:Uid[], removed_uids:Uid[]},
 *   warnings:Array<object>, error:null|MacroError, tick?:number, dry_run?:boolean}} MacroResult */

/* ══════════════════════════════════════════════════════════════════════════
 * 5b. 「替换式销毁」的唯一规范通道 —— `changed.removed_uids`（v3）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## 为什么要立这一条
 *
 * 2026-11-01 实测（`.tmpverify/p1-probe*.mjs`，夹具 `.tmpverify/final-half/probe-obs.json`）：
 * 三个宏都会「覆盖/替换既有带子」，但**报 uid 的拼写互不相同**，其中一个根本不给 uid：
 *
 * | 宏 | 实际给了什么 | 有 uid 吗 |
 * |---|---|---|
 * | `connect(allow_replace)` | 只在 `warnings[].detail` 里写「1 格」 | **没有** |
 * | `insert_machine(replace_belts)` | `changed.removed_uids` + 顶层 `removed_uids`（同值） | 有 |
 * | `trash_unused(replace_belt)` | `changed.removed_uids` + 顶层 `replaced_belt_uid:Uid\|null` | 有 |
 * | `replace_run`（belt / machines） | `changed.removed_uids` + 顶层 `removed_uids` | 有 |
 *
 * 下游 `planToTxOps` 的 R3 因此被迫支持五条读取路径（`changed.removed_uids` /
 * `removed_uids` / `removes[].uid` / `replaced_belt_uid` / `replaced_uids`），
 * 还要为 `connect` **从 `cells[] ∩ obs` 反推**一遍并打 `DESTROYS_DERIVED`。
 * 反推是危险的：它让「宏漏报」与「宏报对了」在 tx 里长得一样。
 *
 * ## 裁定（v3，三宏同形）
 *
 * **`changed.removed_uids: Uid[]` 是唯一规范通道。**
 *
 * 语义三条，缺一即违约：
 *   1. **完整**：本单会从世界里消失的**每一个**既有实体 uid 都在里面，不许只报第一处、
 *      不许只报 subscribe 到的那个。`connect` 覆盖 N 格就必须有 N 个 uid。
 *   2. **存在**：每个 uid 必须来自**本次 ctx 的 obs**（`entities[].uid`）。不许是
 *      「即将由 tx 分配的 uid」，也不许是从 `pending` 推出来的合成值。
 *   3. **条件**：只在「本单确实会销毁既有实体」时非空。替换动作**不发生时**必须是 `[]`，
 *      **不许省略字段、不许写 `null`**（信封要求它是数组；缺了 = 调用方无法区分
 *      「没销毁」与「忘了报」）。
 *
 * 附加（可机器检查，见 `validateReplacedDestroys`）：
 *   · 必须去重、无重复 uid；顺序必须**确定**（推荐按格序 `(y,x)`，与 `cells[]` 同序）。
 *   · 若是「替换式销毁」（本单在同一个格子上又 place 了新东西），每个被删 uid 的
 *     `(x,y)` 必须落在本宏 `cells[]` / `footprint` 覆盖的格里 —— 这是判「删的和放的是
 *     不是同一件事」的机器化判据。实测四个宏全部满足（见 p1-probe-invariant.mjs）。
 *
 * ## 历史字段怎么办
 *
 * **保留、不删、不作为规范通道**。它们仍会出现在返回值里（实现未改），
 * 下游若已经读它们，行为不变；但**新代码只许读 `changed.removed_uids`**。
 * 别名对照见 `REPLACED_DESTROYS_LEGACY_FIELDS`。
 */
export const REPLACED_DESTROYS_FIELD = "changed.removed_uids";

/**
 * 实现里仍然存在、**只许读不许新写**的历史 uid 字段。值是它在返回值里的路径，
 * 用于 (a) 迁移期对账（新规范字段必须与它们一致），(b) 红队写「别名漂移」断言。
 *
 * 注意 `replaced_belt_uid` 是**单数**：`trash_unused` 的噴口格只有一格，
 * 所以结构上只能表达 1 个 —— 这正是它不能当规范通道的原因（多格场景会漏）。
 */
export const REPLACED_DESTROYS_LEGACY_FIELDS = Object.freeze({
    connect: Object.freeze([]),                          // 历史：一个都没有，只能解析 detail 的格数
    insert_machine: Object.freeze(["removed_uids"]),
    trash_unused: Object.freeze(["replaced_belt_uid"]),  // 单数，上限 1
    replace_run: Object.freeze(["removed_uids", "replaced_uids"]),
    remove_run: Object.freeze(["removed_uids"]),         // 纯删除，不属于「替换」，列出仅为字段表完整
    extend_line: Object.freeze([]),                      // 本宏不提供覆盖（契约 preconditions）
});

/**
 * 校验「替换式销毁」的规范通道。**纯函数，不查世界**（世界一致性由调用方拿 obs 判）。
 *
 * 给 P2/P3 的实现自证、P6 的集成测试、以及 `planToTxOps` 的迁移期对账共用。
 *
 * @param {any} r 宏返回值
 * @param {{macro?:string, allowEmpty?:boolean}} [opt]
 *   `allowEmpty` 缺省 true：销毁集合为空是合法的（大多数调用都不销毁任何东西）。
 *   传 false 表示「这一单必须销毁点什么」（例如刚发了 replacing-belts 警告）——
 *   那时空数组即为违约。
 * @returns {Validation} value = 归一后的 uid 数组（去重前原序的副本）
 */
export function validateReplacedDestroys(r, opt = {}) {
    const allowEmpty = opt.allowEmpty !== false;
    if (!isObj(r)) return fail("bad_type", null, "宏返回值必须是对象");

    /* ── ① 字段必须在，且是数组（不许 undefined / null） ── */
    if (!isObj(r.changed)) {
        return fail("bad_type", "changed",
            "宏返回值缺 `changed` 对象（或它不是对象）",
            "信封要求 changed:{added_uids:Uid[], removed_uids:Uid[]}；没销毁任何东西也要给空数组。");
    }
    if (!("removed_uids" in r.changed)) {
        return fail("missing_field", REPLACED_DESTROYS_FIELD,
            `宏返回值缺 ${REPLACED_DESTROYS_FIELD}`,
            "没销毁任何东西也必须给 []。省略字段会让调用方无法区分「没销毁」与「忘了报」。");
    }
    const arr = r.changed.removed_uids;
    if (!Array.isArray(arr)) {
        return fail("bad_type", REPLACED_DESTROYS_FIELD,
            `${REPLACED_DESTROYS_FIELD} 必须是数组`, `实得 ${JSON.stringify(arr)}`);
    }

    /* ── ② 每个元素是合法 uid（>=0 整数），不许占位/合成值 ── */
    for (let i = 0; i < arr.length; i++) {
        if (!isInt(arr[i]) || arr[i] < 0) {
            return fail("bad_type", `${REPLACED_DESTROYS_FIELD}[${i}]`,
                `${REPLACED_DESTROYS_FIELD}[${i}] 必须是 >=0 整数 uid`,
                `实得 ${JSON.stringify(arr[i])}。计划态没有 uid ⇒ 该实体不该出现在这里（uid 由 tx 分配）。`);
        }
    }

    /* ── ③ 不许重复 ── */
    const seen = new Set();
    for (const u of arr) {
        if (seen.has(u)) {
            return fail("bad_type", REPLACED_DESTROYS_FIELD,
                `${REPLACED_DESTROYS_FIELD} 有重复 uid ${u}`,
                "重复会让 tx 生成两条 delete op，第二条必然失败并拖垮整个事务。");
        }
        seen.add(u);
    }

    /* ── ④ 「必须销毁点什么」时不许空 ── */
    if (!allowEmpty && arr.length === 0) {
        return fail("precondition_failed", REPLACED_DESTROYS_FIELD,
            `${REPLACED_DESTROYS_FIELD} 为空，但这一单声明了要替换既有实体`,
            "发了 replacing-belts / replacing_belts / replacing-belt 警告就必须给出对应 uid。");
    }

    /* ── ⑤ 历史字段若同时存在，必须与本字段一致（迁移期对账；缺省不算错） ── */
    const macro = opt.macro || r.macro;
    const legacy = macro ? REPLACED_DESTROYS_LEGACY_FIELDS[macro] : undefined;
    for (const path of legacy || []) {
        const v = path === "removed_uids" ? r.removed_uids
            : path === "replaced_uids" ? r.replaced_uids
                : path === "replaced_belt_uid" ? r.replaced_belt_uid
                    : undefined;
        if (v === undefined || v === null) continue;
        const drift = diffUidLists(v, arr);
        if (drift) {
            return fail("precondition_failed", `${macro}.${path}`,
                `历史字段 ${path}=${JSON.stringify(v)} 与规范通道 ${REPLACED_DESTROYS_FIELD}=${JSON.stringify(arr)} 不一致`,
                "迁移期两者必须同值。不一致说明实现里有两处各算了一遍 —— 合并成一处再报。");
        }
    }

    /* ── ⑥ warning 上的冗余 uid 列表（可选）若存在，也必须一致 ──
     *
     * 允许实现把 `replaced_belt_uids` 挂在 `replacing-*` 警告上（日志/红队对账用）。
     * 但它**不是**规范通道；这里强制它与 changed.removed_uids 同集合，
     * 于是「两份列表各自漂移」在机器上是不可能的 —— 要么一致，要么这条宏自己判红。
     */
    for (let i = 0; i < (Array.isArray(r.warnings) ? r.warnings.length : 0); i++) {
        const w = r.warnings[i];
        if (!isObj(w) || !Array.isArray(w.replaced_belt_uids)) continue;
        const drift = diffUidLists(w.replaced_belt_uids, arr);
        if (drift) {
            return fail("precondition_failed", `warnings[${i}].replaced_belt_uids`,
                `warnings[${i}].replaced_belt_uids=${JSON.stringify(w.replaced_belt_uids)} 与 `
                + `${REPLACED_DESTROYS_FIELD}=${JSON.stringify(arr)} 不一致`,
                "warning 上的 uid 列表只是冗余展示，必须与规范通道同集合。");
        }
        if (Array.isArray(w.replaced_cells) && w.replaced_cells.length !== w.replaced_belt_uids.length) {
            return fail("precondition_failed", `warnings[${i}].replaced_cells`,
                `warnings[${i}] 的 replaced_cells(${w.replaced_cells.length}) 与 `
                + `replaced_belt_uids(${w.replaced_belt_uids.length}) 长度不等`,
                "两者必须同序、同长：第 k 个 uid 对应第 k 个格。");
        }
    }

    return ok(arr.slice());
}

/** 两个 uid 列表是否表示同一集合（不管顺序与重复写法）。返回 null = 一致，否则给一句人读差异。 */
function diffUidLists(a, b) {
    const norm = v => [...new Set((Array.isArray(v) ? v : [v]).map(Number))].sort((x, y) => x - y);
    const x = norm(a), y = norm(b);
    if (x.length === y.length && x.every((u, i) => u === y[i])) return null;
    return `只有左边：${x.filter(u => !y.includes(u)).join(",") || "-"}；`
        + `只有右边：${y.filter(u => !x.includes(u)).join(",") || "-"}`;
}

/**
 * 「这条 warning 声称有替换，规范通道就必须非空」的联动判据。
 * 纯函数；供宏自证与 P6 集成测试直接调用，避免两端各写一遍匹配逻辑。
 *
 * @param {any} r 宏返回值
 * @returns {Validation} value = { claimed:bool, uids:Uid[] }
 */
export function checkReplacingWarningMatchesDestroys(r) {
    if (!isObj(r)) return fail("bad_type", null, "宏返回值必须是对象");
    const claimed = Array.isArray(r.warnings) && r.warnings.some(w => isObj(w) && (
        w.code === "replacing-belts" || w.code === "replacing_belts" || w.code === "replacing-belt"));
    const chk = validateReplacedDestroys(r, { macro: r.macro, allowEmpty: !claimed });
    if (!chk.ok) return chk;
    return ok({ claimed, uids: chk.value });
}

/**
 * 返回信封的结构校验（供宏的单测 / A6 的 loop 用）。
 * @param {any} r
 * @returns {Validation}
 */
export function validateMacroResult(r) {
    if (!isObj(r)) return fail("bad_type", null, "宏返回值必须是对象");
    for (const k of RETURN_ENVELOPE.required) {
        if (!(k in r)) return fail("missing_field", k, `宏返回值缺字段 ${k}`);
    }
    if (typeof r.ok !== "boolean") return fail("bad_type", "ok", "ok 必须是布尔");
    if (!isInt(r.cells_planned) || r.cells_planned < 0) return fail("bad_type", "cells_planned", "cells_planned 必须是 >=0 整数");
    if (!isInt(r.cells_placed) || r.cells_placed < 0) return fail("bad_type", "cells_placed", "cells_placed 必须是 >=0 整数");
    const fm = r.first_mismatch;
    if (fm !== null) {
        if (!isObj(fm) || !isCell(fm.cell) || typeof fm.field !== "string") {
            return fail("bad_type", "first_mismatch", "first_mismatch 必须是 null 或 {cell:[x,y], field:string, requested, actual}");
        }
    }
    if (r.ok && fm !== null) {
        return fail("precondition_failed", "first_mismatch",
            "ok=true 但 first_mismatch 非 null —— 自相矛盾",
            "要么整体成功（mismatch 必为 null），要么失败并给出第一处；不允许「成功了但有错位」。");
    }
    if (!r.ok && r.error === null) {
        return fail("precondition_failed", "error", "ok=false 时 error 必须非 null",
            "失败必须结构化（DIRECTION-FINAL 阶段 2 判据 4：不许静默）。");
    }
    if (r.error !== null && r.error !== undefined) {
        if (!isObj(r.error) || typeof r.error.code !== "string") {
            return fail("bad_type", "error", "error 必须是 {code,...}");
        }
        if (!(r.error.code in ERROR_CODES)) {
            return fail("bad_type", "error.code", `error.code "${r.error.code}" 不在闭集里`, `闭集：${Object.keys(ERROR_CODES).join(", ")}`);
        }
    }
    if (r.ok && r.cells_placed !== r.cells_planned) {
        return fail("precondition_failed", "cells_placed",
            `ok=true 但 cells_placed(${r.cells_placed}) !== cells_planned(${r.cells_planned})`,
            "原子执行下二者必须相等；不等说明有半成，必须 ok=false。");
    }

    /* ── warnings：闭集 + 级别（v2）。这一条把「ok:true 的语义」钉死 ── */
    if (r.warnings !== undefined) {
        if (!Array.isArray(r.warnings)) {
            return fail("bad_type", "warnings", "warnings 必须是数组", "没有警告就给 []，不要省略成 undefined。");
        }
        for (let i = 0; i < r.warnings.length; i++) {
            const w = r.warnings[i];
            const at = `warnings[${i}]`;
            if (!isObj(w) || typeof w.code !== "string") {
                return fail("bad_type", at, `${at} 必须是 {code, detail, ...}`);
            }
            const decl = WARNING_CODES[w.code];
            if (!decl) {
                return fail("bad_type", `${at}.code`,
                    `warnings[${i}].code "${w.code}" 不在闭集里`,
                    `闭集：${Object.keys(WARNING_CODES).join(", ")}。`
                    + "新增警告必须先登记到 WARNING_CODES（含 severity 与调用方动作），否则调用方无法分诊。");
            }
            if (w.severity !== undefined && !WARNING_SEVERITIES.includes(w.severity)) {
                return fail("bad_type", `${at}.severity`,
                    `${at}.severity 必须是 ${WARNING_SEVERITIES.join("|")}`, `实得 ${JSON.stringify(w.severity)}`);
            }
            if (w.severity !== undefined && w.severity !== decl.severity) {
                return fail("precondition_failed", `${at}.severity`,
                    `${at}.severity="${w.severity}" 与契约登记（${w.code} → ${decl.severity}）不符`,
                    "级别由契约统一裁决，实现不得就地升降级；要改级别先改 WARNING_CODES。");
            }
            if (r.ok && decl.severity === "error") {
                return fail("precondition_failed", at,
                    `ok=true 但 warnings 里有 error 级警告 "${w.code}" —— 自相矛盾`,
                    "error 级警告的契约语义是「这一单不该算成功」：实现必须直接返回 ok:false，"
                    + "而不是用 ok:true 让调用方自己去读警告。");
            }
        }
    }
    return ok(r);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5c. 下游消费约定：`planToTxOps` 的 R3 该怎么读销毁
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 给 `planToTxOps`（P3）与 P6 的机器可读约定。**不是实现**，是判据表。
 *
 * 现状（2026-11-01 实测，`src/agent/loop/planToTxOps.mjs`）：
 *   · `selfReportedDestroys()` 读了**五条**路径，其中三条是历史别名；
 *   · 另有 `connectDestroysFromObs()` 为 `connect` 从 `cells[] ∩ obs` **反推**销毁，
 *     并打 `DESTROYS_DERIVED`。
 *
 * v3 之后的目标状态：
 *   · R3 **只**读 `changed.removed_uids`（一条路径）。别名读取可以留作迁移期兜底，
 *     但必须**记一条迁移警告**，不许静默吞掉 —— 否则「实现还在用旧字段」永远暴露不出来。
 *   · `connectDestroysFromObs` 的**反推必须降级为交叉校验**，不能继续当数据源：
 *     反推 = 用 obs 猜「宏大概会删谁」，与「宏自报删谁」拼起来会让
 *     「宏漏报」看起来和「宏报对了」完全一样，而前者正是要抓的缺陷形态。
 *     正确用法：`derived === changed.removed_uids` 才通过；不等即判红（宏与 obs 不同步）。
 *   · 反推**不得**再引入新 uid：即使它算出更多 uid，也不许把它们塞进 destroys。
 *     （R6 会因此拒绝计划 —— 这正是想要的行为：宁可拒绝，不静默多删。）
 */
export const DESTROYS_CONSUMPTION_SPEC = Object.freeze({
    /** R3 唯一该读的路径 */
    canonical: REPLACED_DESTROYS_FIELD,
    /** 迁移期允许继续读的路径，读到时必须发 `DESTROYS_LEGACY_FIELD` 警告（见下表） */
    legacyReadable: Object.freeze([
        "removed_uids",          // insert_machine / replace_run / remove_run
        "replaced_belt_uid",     // trash_unused（单数）
        "replaced_uids",         // replace_run
        "removes[].uid",         // remove_run 的 intent 形态
        "removed[].uid",         // remove_run 的明细形态
    ]),
    /** `connect` 专用：反推只许用于对账，不许当数据源 */
    connectDerivation: Object.freeze({
        role: "cross-check-only",
        rule: "derived_uids（cells[] ∩ obs 的带子）必须与 changed.removed_uids 集合相等；不等 ⇒ 判红",
        forbiddenSource: "把 derived 里「多出来」的 uid 塞进 destroys（那是静默多删）",
    }),
    /** 迁移期的告警码。**注意命名空间**：它是 `planToTxOps` 侧发出的警告，
     *  与 `DESTROYS_DERIVED` / `FLOW_UNVERIFIED` / `DESTROYS_UNNAMED_CHECK_SKIPPED` 同一批，
     *  **不属于** `WARNING_CODES`（那是宏返回值的闭集，`validateMacroResult` 才校验它）。
     *  切莫为了「让它合法」而往 WARNING_CODES 里塞 —— 那会让宏实现以为可以发这个码。 */
    legacyWarningCode: "DESTROYS_LEGACY_FIELD",
    legacyWarningNamespace: "planToTxOps",
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. intent schema 扩展：removes[]
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `removes[]` 的一项。
 *
 * 用 uid 而不是坐标，理由有三条（都来自实机事故）：
 *   1. `delete{x,y}` 在 181 实体存档上误删过一次 42 个实体（PROTOCOL §5）—— 坐标错一格就牵连邻里。
 *   2. uid 在存档往返后保持稳定（PROTOCOL §4），是唯一的精确身份。
 *   3. rollback 的恢复原语 `restoreEntity(payload)` 的载荷里带的就是 uid；
 *      坐标无法恢复被删实体的 uid，会让 G-rollback-restore 的「uid 集合逐字节相等」不可达（A1 `3306ade`）。
 *
 * `expect` **必填**：它是「写 intent 时的 obs 快照」与「执行时的世界」之间的一致性校验。
 * 没有它，一个过期的 intent 会删掉新长出来的、同坐标的别的东西。
 *
 * @typedef {object} RemoveItem
 * @property {Uid} uid
 * @property {{type:string, x:number, y:number, r?:0|90|180|270}} expect 必填；执行前逐字段核对
 * @property {string} [reason] 人读的理由（进日志与诊断，不参与判定）
 * @property {boolean} [optional] true = 不存在时跳过而不判红（用于幂等重跑）；缺省 false
 */

/** removes[] 的规格（文档与 A2 的 gate 共用同一份真值） */
export const REMOVES_SPEC = Object.freeze({
    /** intent 里可选的顶层字段 */
    field: "removes",
    item: {
        uid: "int >= 0（obs.entities[].uid）",
        expect: "{type:string, x:int, y:int, r?:0|90|180|270} —— 必填",
        reason: "string（可选，人读）",
        optional: "boolean（可选，缺省 false）",
    },
    /** 允许删除的建筑种类。hub 永远不可删（getIsRemovable=false）。 */
    deletableTypes: Object.freeze(["belt", "underground_belt", "balancer", "cutter", "rotater", "stacker", "mixer", "painter", "trash"]),
    /** 执行顺序：removes 必须**先于** paste。理由：粘贴的 footprint 可能是刚被删掉的格子；
     *  反过来做，dry_run 会把「我要腾的位置」报成 blocked，计划永远无法通过 G3。 */
    order: Object.freeze(["preflight", "tx.begin", "removes", "paste", "tx.commit", "verify"]),
    /** 与 G3 的关系：dry_run.destroys 必须是 removes 的子集。
     *  未声明的销毁 → 红（这是「销毁必须在计划里声明且可恢复」的机器化表达）。
     *  ⚠️ 已知局限（A2 必须在 gate 里写明，不许假装没有）：G3 的 dry_run 发生在
     *  `tx.begin` **之前**，而 removes 在 tx 内执行。两者之间世界仍可能变化
     *  （别的 agent / 游戏主循环 / 玩家）。所以 dry_run 的结论是「当时成立」，
     *  执行时的真值由 `G-delete-replay` 用消除后的 obs 复核，不靠这份预检。 */
    g3Rule: "dryRun.destroys[].uid ⊆ removes[].uid，否则 G3 红",
    /** 与 G4 的关系（两条都要）： */
    g4Rule: "vanished_uids ⊆ removes[].uid；added_entities === entities.length",
    /** G-delete-replay（DIRECTION-FINAL 阶段 0 新增的第二道闸）：
     *  **声明的删除必须逐 uid 真的发生**，不是"至少没多删"。
     *  判据取**相等**而不是子集：声明了却还在 = 静默 no-op（计划说删了、实际没删，
     *  下游 G6b 会拿一条其实还堵着的线去判"连通"，是假绿的新入口）。
     *  `optional:true` 的项允许缺席（幂等重跑），因此比较的是
     *  `vanished_uids === removes.filter(!optional).map(uid)`。 */
    gDeleteReplayRule: "vanished_uids === removes.filter(r => !r.optional).map(r => r.uid)（集合相等，非子集）",
    /** 回滚：删本 plan 新增 + 用快照恢复本 plan 删除。判据是 uid 集合逐字节相等。 */
    rollbackRule: "回滚后 uid 集合 === 执行前 uid 集合（逐字节）",
});

/**
 * 校验 intent.removes（结构层，不查世界）。
 *
 * @param {any} intent
 * @returns {Validation} value = 归一后的 removes 数组（缺省 []）
 */
export function validateIntentRemoves(intent) {
    if (!isObj(intent)) return fail("bad_type", null, "intent 必须是对象");
    const raw = intent.removes;
    if (raw === undefined) return ok([]);
    if (!Array.isArray(raw)) {
        return fail("bad_type", "removes", "intent.removes 必须是数组", "每项 {uid, expect:{type,x,y}, reason?}");
    }
    const seen = new Set();
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const it = raw[i];
        const at = `removes[${i}]`;
        if (!isObj(it)) return fail("bad_type", at, `${at} 必须是对象`);
        for (const k of Object.keys(it)) {
            if (!["uid", "expect", "reason", "optional"].includes(k)) {
                return fail("unknown_field", `${at}.${k}`, `${at} 不认识键 '${k}'`,
                    "敲错字段名会让校验静默失效（例如写成 'uuid'），所以未知键一律拒绝。");
            }
        }
        if (!isInt(it.uid) || it.uid < 0) {
            return fail("bad_type", `${at}.uid`, `${at}.uid 必须是 >=0 的整数`);
        }
        if (seen.has(it.uid)) {
            return fail("bad_type", `${at}.uid`, `${at}.uid ${it.uid} 重复`,
                "同一条被删两次说明选集有 bug；去重后再写。");
        }
        seen.add(it.uid);
        if (it.expect === undefined) {
            return fail("missing_field", `${at}.expect`, `${at} 缺 expect`,
                "expect 是与 obs 快照的一致性凭据。没有它，过期 intent 会删掉同坐标的新东西。");
        }
        const e = it.expect;
        if (!isObj(e)) return fail("bad_type", `${at}.expect`, `${at}.expect 必须是对象`);
        for (const k of Object.keys(e)) {
            if (!["type", "x", "y", "r"].includes(k)) {
                return fail("unknown_field", `${at}.expect.${k}`, `${at}.expect 不认识键 '${k}'`);
            }
        }
        if (typeof e.type !== "string" || !e.type) {
            return fail("bad_type", `${at}.expect.type`, `${at}.expect.type 必须是非空字符串（obs 的 type）`);
        }
        if (!isInt(e.x) || !isInt(e.y)) {
            return fail("bad_type", `${at}.expect`, `${at}.expect.x/y 必须是整数`);
        }
        if (e.r !== undefined && ![0, 90, 180, 270].includes(e.r)) {
            return fail("bad_type", `${at}.expect.r`, `${at}.expect.r 必须是 0|90|180|270`);
        }
        if (it.reason !== undefined && typeof it.reason !== "string") {
            return fail("bad_type", `${at}.reason`, `${at}.reason 必须是字符串`);
        }
        if (it.optional !== undefined && typeof it.optional !== "boolean") {
            return fail("bad_type", `${at}.optional`, `${at}.optional 必须是布尔`);
        }
        const del = realDeletableCheck(it.expect.type, at);
        if (del) return del;
        out.push({
            uid: it.uid,
            expect: { type: e.type, x: e.x, y: e.y, ...(e.r !== undefined ? { r: e.r } : {}) },
            ...(it.reason !== undefined ? { reason: it.reason } : {}),
            optional: it.optional === true,
        });
    }
    return ok(out);
}

function realDeletableCheck(type, at) {
    if (type === "hub") {
        return fail("precondition_failed", `${at}.expect.type`,
            "hub 不可删除（getIsRemovable=false）",
            "不可能有合法的 removes 项指向 hub；这条通常是 uid 抄错了。");
    }
    return null;
}

/**
 * removes 的**存在性/一致性**校验（需要 obs）。A2 的 `G-remove-preflight` 调它。
 *
 * @param {Array} removes  来自 validateIntentRemoves().value
 * @param {Array<{uid:number,type:string,x:number,y:number,r:number}>} entities  obs.entities
 * @returns {Validation} value = {ok:RemoveItem[], missing:RemoveItem[], mismatched:[...]}
 */
export function checkRemovesAgainstObs(removes, entities) {
    if (!Array.isArray(removes)) return fail("bad_type", "removes", "removes 必须是数组");
    if (!Array.isArray(entities)) return fail("bad_type", "entities", "entities 必须是 obs.entities 数组");
    const byUid = new Map(entities.map(e => [e.uid, e]));
    const good = [], missing = [], mismatched = [];
    for (const r of removes) {
        const e = byUid.get(r.uid);
        if (!e) {
            if (r.optional) continue;
            missing.push(r);
            continue;
        }
        const diffs = [];
        if (e.type !== r.expect.type) diffs.push({ field: "type", requested: r.expect.type, actual: e.type });
        if (e.x !== r.expect.x) diffs.push({ field: "x", requested: r.expect.x, actual: e.x });
        if (e.y !== r.expect.y) diffs.push({ field: "y", requested: r.expect.y, actual: e.y });
        if (r.expect.r !== undefined && e.r !== r.expect.r) diffs.push({ field: "r", requested: r.expect.r, actual: e.r });
        if (diffs.length) mismatched.push({ uid: r.uid, diffs });
        else good.push(r);
    }
    if (missing.length || mismatched.length) {
        return {
            ok: false,
            error: {
                code: "precondition_failed",
                field: "removes",
                message: `${missing.length} 个 uid 不存在，${mismatched.length} 个与 expect 不符 —— intent 已过期`,
                hint: "重新 obs 后重写 removes。uid 对但不符通常意味着世界已经变了（别的东西占了同一 uid？不可能——那就是抄错了）。",
                ...(missing.length ? { candidates: missing.slice(0, 5).map(m => m.uid) } : {}),
            },
            value: { ok: good, missing, mismatched },
        };
    }
    return ok({ ok: good, missing, removedOptional: [], mismatched: [] });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. lint：公开 ABI 里不许出现裸坐标
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 机器检查一次宏调用是否违反坐标三分法（DIRECTION-FINAL 阶段 1 判据 2 的落地）。
 *
 * 规则（可执行，不靠人看）：
 *   1. 参数键不得命中 FORBIDDEN_ARG_KEYS。
 *   2. coordClass ∈ {endpoint, site} 的参数最多 2 个，其中 site 最多 1 个。
 *   3. 坐标容器（值为 cell / cells / bbox / `{cell}` 的参数）**必须**在 `MACRO_SPECS` 里
 *      被声明为 endpoint 或 site；名单从规格表**派生**，不再有手写白名单。
 *      任何数组型参数若其元素是 [int,int]，而对应参数没有这个 coordClass，一律判红。
 *
 * v2 改法（硬伤 2）：删掉 `cellish = {cell, cells, region, at}` 这份手写豁免表。
 * 它的问题不是"放行 region"本身，而是"按**参数名**放行" —— 换个名字再写进表里就绕过去了，
 * 且表里没有的坐标参数会被误伤（例如未来某个宏用 `target:{cell}`）。
 * 现在的口径是「按**声明**放行」：`MACRO_SPECS[n].params[]` 里写了 coordClass 才放行，
 * 于是「新增坐标参数」与「登记它属于哪一类」变成同一个动作，不可能只做一个。
 *
 * @param {string} name 宏名
 * @param {object} args
 * @returns {{ok:boolean, violations:string[], specEndpointCount:number, specSiteCount:number, coordParams:string[]}}
 */
export function lintNoBareCoords(name, args) {
    const v = [];
    const spec = MACRO_SPECS[name];
    if (!spec) return { ok: false, violations: [`未知宏 ${name}`], specEndpointCount: 0, specSiteCount: 0, coordParams: [] };
    const a = args || {};
    for (const k of Object.keys(a)) {
        if (FORBIDDEN_ARG_KEYS.includes(k)) {
            v.push(`参数 '${k}' 是裸坐标/裸旋转，公开 ABI 禁止（见 FORBIDDEN_ARG_KEYS）`);
        }
    }
    let endpoints = 0, sites = 0;
    for (const p of spec.params) {
        if (p.coordClass === "endpoint") endpoints++;
        if (p.coordClass === "site") sites++;
    }
    const argEndpointCount = spec.params.filter(p => p.coordClass === "endpoint" && a[p.name.split(".")[0]] !== undefined).length;
    const argSiteCount = spec.params.filter(p => p.coordClass === "site" && a[p.name] !== undefined).length;
    if (argEndpointCount > 2) v.push(`端点参数 ${argEndpointCount} 个，上界 2`);
    if (argSiteCount > 1) v.push(`落点参数 ${argSiteCount} 个，上界 1`);

    /* 坐标容器的放行名单 = 规格表里被声明为 endpoint/site 的参数（按顶层键名） */
    const declared = new Set(
        spec.params
            .filter(p => p.coordClass === "endpoint" || p.coordClass === "site")
            .map(p => p.name.split(".")[0]),
    );
    for (const [k, val] of Object.entries(a)) {
        if (declared.has(k)) continue;
        if (isCoordContainer(val)) {
            v.push(`参数 '${k}' 是坐标容器，但没有在 MACRO_SPECS.${name}.params 里声明 coordClass `
                + "(endpoint 或 site) —— 坐标参数必须登记属于哪一类");
        }
    }
    return {
        ok: v.length === 0, violations: v,
        specEndpointCount: endpoints, specSiteCount: sites,
        coordParams: [...declared],
    };
}

/** 值是否是坐标容器：[x,y] / [[x,y]…] / [x0,y0,x1,y1] / {cell} / {cells} / {region} 内嵌的坐标 */
function isCoordContainer(val) {
    if (isCell(val) || isBBox(val)) return true;
    if (Array.isArray(val) && val.length && val.every(c => isCell(c))) return true;
    if (isObj(val)) {
        for (const key of ["cell", "region"]) if (val[key] !== undefined && (isCell(val[key]) || isBBox(val[key]))) return true;
        if (Array.isArray(val.cells) && val.cells.length && val.cells.every(isCell)) return true;
    }
    return false;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 自测（node src/agent/macros/contract.mjs 直接跑）
 * ══════════════════════════════════════════════════════════════════════════ */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/macros/contract.mjs");
if (isMain) {
    let bad = 0;
    const t = (name, cond) => {
        if (cond) console.log("✓ " + name);
        else { console.log("✗ " + name); bad++; }
    };
    const V = (f, args) => f(args);

    t("connect 正常", V(validateConnectArgs, { from: { uid: 10001, port: "out" }, to: { uid: 10002, port: "primary" } }).ok);
    t("connect 裸坐标被拒", !V(validateConnectArgs, { from: { x: 1, y: 2 }, to: { uid: 3 } }).ok);
    t("connect 顶层 x 被点名", (() => {
        const r = V(validateConnectArgs, { from: { uid: 1 }, to: { uid: 2 }, x: 5 });
        return !r.ok && r.error.code === "unknown_field" && r.error.field === "x";
    })());
    t("connect 自连被拒", !V(validateConnectArgs, { from: { uid: 1, port: "out" }, to: { uid: 1, port: "out" } }).ok);
    t("connect uid+cell 同时给被拒", !V(validateConnectArgs, { from: { uid: 1, cell: [0, 0] }, to: { uid: 2 } }).ok);
    t("connect port entry 越界被拒", !V(validateConnectArgs, { from: { uid: 1 }, to: { hub: { entry: 16 } } }).ok);

    t("insert_machine 正常", V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter" }).ok);
    t("insert_machine 角度当 facing 被拒", !V(validateInsertMachineArgs, { at: [4, -13], facing: 0, machine: "cutter" }).ok);
    t("insert_machine 带 r 被拒", !V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter", r: 0 }).ok);
    t("insert_machine 变体对象", (() => {
        const r = V(validateInsertMachineArgs, { at: [0, 0], facing: "right", machine: { kind: "painter", variant: "mirrored" } });
        return r.ok && r.value.machine.variant === "mirrored";
    })());

    t("remove_run uids 正常", V(validateRemoveRunArgs, { uids: [10209, 10149] }).ok);
    t("remove_run uids+cells 互斥", !V(validateRemoveRunArgs, { uids: [1], cells: [[0, 0]] }).ok);
    t("remove_run 重复 uid 被拒", !V(validateRemoveRunArgs, { uids: [1, 1] }).ok);
    t("remove_run 空数组被拒", !V(validateRemoveRunArgs, { uids: [] }).ok);

    t("extend_line 正常", V(validateExtendLineArgs, { from: { uid: 5 }, len: 4, dir: "top" }).ok);
    t("extend_line len=0 被拒", !V(validateExtendLineArgs, { from: { uid: 5 }, len: 0 }).ok);
    t("extend_line dir 非法被拒", !V(validateExtendLineArgs, { from: { uid: 5 }, len: 2, dir: 90 }).ok);

    t("replace_run 正常", V(validateReplaceRunArgs, { region: [3, -14, 5, -12], building: "belt" }).ok);
    t("replace_run 机器形态（L4 的 cutter+trash）通过校验器", (() => {
        const r = V(validateReplaceRunArgs, {
            region: [4, -14, 5, -13],
            building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
        });
        return r.ok && r.value.mode === "machines" && r.value.building.length === 2
            && r.value.building[1].kind === "trash" && r.value.building[1].port === "left";
    })());
    t("replace_run 单机器字符串也通过", (() => {
        const r = V(validateReplaceRunArgs, { region: [0, 0, 1, 0], building: "cutter" });
        return r.ok && r.value.mode === "machines" && r.value.building[0].kind === "cutter";
    })());
    t("replace_run 数组里混 belt 被拒", (() => {
        const r = V(validateReplaceRunArgs, { region: [0, 0, 1, 0], building: ["belt", "cutter"] });
        return !r.ok && r.error.code === "bad_type";
    })());
    t("replace_run 空数组被拒", !V(validateReplaceRunArgs, { region: [0, 0, 1, 0], building: [] }).ok);
    t("replace_run 隧道明确拒绝", (() => {
        const r = V(validateReplaceRunArgs, { region: [0, 0, 1, 1], building: "underground_belt" });
        return !r.ok && r.error.code === "unsupported_building";
    })());
    t("replace_run 反序 bbox 被拒", !V(validateReplaceRunArgs, { region: [5, 5, 1, 1], building: "belt" }).ok);

    t("trash_unused 的 hub entry 被拒（方向搞反）", (() => {
        const r = V(validateTrashUnusedArgs, { outlet: { hub: { entry: 3 } } });
        return !r.ok && r.error.code === "bad_type";
    })());
    t("trash_unused 单输出 auto 合法（运行期再判唯一性）",
        V(validateTrashUnusedArgs, { outlet: { uid: 10001 } }).ok);
    t("trash_unused 正常", V(validateTrashUnusedArgs, { outlet: { uid: 9, port: "left" } }).ok);

    t("removes 缺 expect 被拒", !validateIntentRemoves({ removes: [{ uid: 1 }] }).ok);
    t("removes 正常", validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }], goal: "g", anchor: [0, 0], entities: [] }).ok);
    t("removes 重复 uid 被拒", !validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "belt", x: 0, y: 0 } }, { uid: 1, expect: { type: "belt", x: 1, y: 0 } }] }).ok);
    t("removes 指向 hub 被拒", !validateIntentRemoves({ removes: [{ uid: 1, expect: { type: "hub", x: 0, y: 0 } }] }).ok);

    t("checkRemoves 命中", checkRemovesAgainstObs(
        [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }],
        [{ uid: 1, type: "belt", x: 4, y: -13, r: 0 }]).ok);
    t("checkRemoves 不符被抓", (() => {
        const r = checkRemovesAgainstObs(
            [{ uid: 1, expect: { type: "belt", x: 4, y: -13 } }],
            [{ uid: 1, type: "belt", x: 5, y: -13, r: 0 }]);
        return !r.ok && r.value.mismatched.length === 1;
    })());
    t("checkRemoves 缺失被抓", !checkRemovesAgainstObs([{ uid: 7, expect: { type: "belt", x: 0, y: 0 } }], []).ok);

    t("表单校验：ok 但 mismatch 非 null 自相矛盾", !validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 3,
        first_mismatch: { cell: [0, 0], field: "code", requested: 1, actual: 3 },
        changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null,
    }).ok);
    t("表单校验：ok 但半成被拒", !validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 2,
        first_mismatch: null, changed: { added_uids: [], removed_uids: [] }, warnings: [], error: null,
    }).ok);
    t("表单校验：合法", validateMacroResult({
        ok: true, macro: "connect", cells_planned: 3, cells_placed: 3,
        first_mismatch: null, changed: { added_uids: [1], removed_uids: [] }, warnings: [], error: null,
    }).ok);

    t("lint：connect 带 x/y 报红", !lintNoBareCoords("connect", { from: { uid: 1 }, to: { uid: 2 }, x: 3 }).ok);
    t("lint：合法调用为绿", lintNoBareCoords("connect", { from: { uid: 1 }, to: { uid: 2 } }).ok);
    t("lint：remove_run 的 cells 是契约点名，放行", lintNoBareCoords("remove_run", { cells: [[0, 0]] }).ok);
    t("宏名齐全", MACRO_NAMES.length === 7);
    t("insert_machine `{cell}` 形态归一", (() => {
        const r = V(validateInsertMachineArgs, { at: { cell: [4, -13] }, facing: "top", machine: "cutter" });
        return r.ok && r.value.at.kind === "any-cell" && r.value.at.cell[0] === 4;
    })());
    t("insert_machine origin 形态与 cell 形态不混", (() => {
        const r = V(validateInsertMachineArgs, { at: [4, -13], facing: "top", machine: "cutter" });
        return r.ok && r.value.at.kind === "origin";
    })());
    t("每个宏都有 preconditions / whenNotToUse / returns / lowerOps", MACRO_NAMES.every(n => {
        const s = MACRO_SPECS[n];
        return s.preconditions.length > 0 && s.whenNotToUse.length > 0
            && typeof s.returns === "string" && s.returns.length > 0
            && Array.isArray(s.lowerOps) && s.lowerOps.length > 0;
    }));
    t("每个宏都没有 computed 类公开参数（坐标全在宏里）", MACRO_NAMES.every(n =>
        MACRO_SPECS[n].params.every(p => p.coordClass !== "computed")));
    t("空参数/未知宏给出可读错误", (() => {
        const r = validateMacroCall("nope", {});
        return !r.ok && /可用宏/.test(r.error.hint || "");
    })());
    t("capability: 旋转机器槽位尚未实机闭环", !isLiveVerified("rotated_machine_slots"));
    t("capability: insert_machine 被这条假设覆盖", openAssumptionsFor("insert_machine").some(a => a.key === "rotated_machine_slots"));
    t("capability: remove_run 无未闭环前提", openAssumptionsFor("remove_run").length === 0);

    console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条失败`);
    if (bad) process.exitCode = 1;
}
